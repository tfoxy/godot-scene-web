//! Host-owned datagram transport and serialized, reentrant callback dispatch.
use super::milestones::SctpTrace;
use super::{allowed_ip, classify, DatagramKind, Identity, OUTBOUND_MESSAGE_LIMIT};
use crate::abi::*;
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_int, c_void, CStr};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::Instant;
use str0m::channel::ChannelId;
use str0m::crypto::{CryptoProvider, Fingerprint};
use str0m::ice::StunMessage;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, IceCreds, Input, Output, Rtc, RtcConfig};

impl GrcRtcAddr {
    fn socket(self) -> Option<SocketAddr> {
        if self._r != 0 || self.port == 0 {
            return None;
        }
        let ip = match self.family {
            4 if self.addr[4..] == [0; 12] => IpAddr::V4(Ipv4Addr::new(
                self.addr[0],
                self.addr[1],
                self.addr[2],
                self.addr[3],
            )),
            6 => IpAddr::V6(Ipv6Addr::from(self.addr)),
            _ => return None,
        };
        Some(SocketAddr::new(ip, self.port))
    }
    fn from_socket(socket: SocketAddr) -> Self {
        let mut addr = [0; 16];
        let family = match socket.ip() {
            IpAddr::V4(ip) => {
                addr[..4].copy_from_slice(&ip.octets());
                4
            }
            IpAddr::V6(ip) => {
                addr = ip.octets();
                6
            }
        };
        Self {
            family,
            _r: 0,
            port: socket.port(),
            addr,
        }
    }
}

struct Options {
    local: SocketAddr,
    identity: Identity,
    creds: IceCreds,
    max_peers: usize,
    recv_max: u32,
    low: usize,
    budget: usize,
}
struct Peer {
    id: u32,
    rtc: Rtc,
    trace: SctpTrace,
    deadline: Option<Instant>,
    channels: HashMap<u32, ChannelId>,
    next_dc: u32,
}
enum Callback {
    Transmit(GrcRtcAddr, Vec<u8>),
    Peer(u32, c_int, GrcRtcAddr),
    Open(u32, u32, String),
    Message(u32, u32, bool, Vec<u8>),
    Low(u32, u32),
    Closed(u32, u32),
    Log(c_int, String),
}
// Pair event metadata and callback while holding the state lock, preserving order.
struct Pending {
    started: Instant,
    queue: VecDeque<Callback>,
}
impl std::ops::Deref for Pending {
    type Target = VecDeque<Callback>;
    fn deref(&self) -> &Self::Target {
        &self.queue
    }
}
impl std::ops::DerefMut for Pending {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.queue
    }
}
impl Pending {
    fn push_back(&mut self, callback: Callback) {
        if let Some(detail) = callback.description() {
            self.queue.push_back(Callback::Log(GRC_LOG_INFO, json!({"tMs":self.started.elapsed().as_millis() as u64,"event":detail["name"],"detail":detail}).to_string()));
        }
        self.queue.push_back(callback);
    }
}
struct State {
    options: Options,
    provider: Arc<CryptoProvider>,
    peers: HashMap<SocketAddr, Peer>,
    next_peer: u32,
    pending: Pending,
    dispatch_thread: Option<ThreadId>,
    stopping: bool,
    started: Instant,
}
// user is opaque: the host promises its callbacks and user storage support calls on
// any host/timer thread until destruction. Only the serialized dispatcher reads it.
struct Callbacks(GrcRtcCallbacksV1);
unsafe impl Send for Callbacks {}
unsafe impl Sync for Callbacks {}
struct Module {
    state: Mutex<State>,
    wake: Condvar,
    callbacks: Callbacks,
    timer: Mutex<Option<JoinHandle<()>>>,
}
impl Module {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn start(options: Options, callbacks: GrcRtcCallbacksV1) -> Result<Arc<Self>, String> {
        let started = Instant::now();
        let module = Arc::new(Self {
            state: Mutex::new(State {
                options,
                provider: Arc::new(str0m_rust_crypto::default_provider()),
                peers: HashMap::new(),
                next_peer: 1,
                pending: Pending {
                    started,
                    queue: VecDeque::new(),
                },
                dispatch_thread: None,
                stopping: false,
                started,
            }),
            wake: Condvar::new(),
            callbacks: Callbacks(callbacks),
            timer: Mutex::new(None),
        });
        let timer_module = module.clone();
        let timer = thread::Builder::new()
            .name("grc-rtc-timer".into())
            .spawn(move || {
                timer_module.timer_loop();
            })
            .map_err(|e| e.to_string())?;
        *module.timer.lock().unwrap() = Some(timer);
        Ok(module)
    }
    fn timer_loop(&self) {
        let mut state = self.lock();
        loop {
            if state.stopping {
                break;
            }
            let deadline = state.peers.values().filter_map(|p| p.deadline).min();
            state = match deadline {
                None => self.wake.wait(state).unwrap_or_else(|e| e.into_inner()),
                Some(deadline) => {
                    let now = Instant::now();
                    if deadline > now {
                        self.wake
                            .wait_timeout(state, deadline - now)
                            .unwrap_or_else(|e| e.into_inner())
                            .0
                    } else {
                        state.timeout(now);
                        state.drain();
                        drop(state);
                        self.dispatch();
                        self.lock()
                    }
                }
            };
        }
    }
    fn call<R>(&self, fallback: R, f: impl FnOnce(&mut State) -> R) -> R {
        let result = {
            let mut state = self.lock();
            if state.stopping {
                return fallback;
            }
            let result = f(&mut state);
            state.drain();
            self.wake.notify_all();
            result
        };
        self.dispatch();
        result
    }
    fn dispatch(&self) {
        let mut state = self.lock();
        if state.dispatch_thread.is_some() || state.stopping {
            return;
        }
        state.dispatch_thread = Some(thread::current().id());
        while !state.stopping {
            let Some(callback) = state.pending.pop_front() else {
                break;
            };
            drop(state);
            // Owned callback payloads survive reentrant calls and destruction.
            unsafe {
                callback.invoke(&self.callbacks.0);
            }
            state = self.lock();
        }
        state.dispatch_thread = None;
        self.wake.notify_all();
    }
    fn stop(&self) {
        let current = thread::current().id();
        {
            let mut state = self.lock();
            state.stopping = true;
            state.pending.clear();
            self.wake.notify_all();
            while state.dispatch_thread.is_some_and(|id| id != current) {
                state = self.wake.wait(state).unwrap_or_else(|e| e.into_inner());
            }
            state.peers.clear();
        }
        if let Some(timer) = self.timer.lock().unwrap_or_else(|e| e.into_inner()).take() {
            if timer.thread().id() != current {
                let _ = timer.join();
            }
        }
    }
}
impl Callback {
    fn description(&self) -> Option<serde_json::Value> {
        Some(match self {
            Self::Peer(peer, state, remote) => {
                json!({"name":"peer", "peer":peer, "state":state, "remote":remote.socket().map(|s| s.to_string())})
            }
            Self::Open(peer, dc, label) => {
                json!({"name":"dc-open", "peer":peer, "dc":dc, "label":label})
            }
            Self::Message(peer, dc, binary, bytes) => {
                json!({"name":"dc-message", "peer":peer, "dc":dc, "binary":binary, "bytes":bytes.len()})
            }
            Self::Low(peer, dc) => json!({"name":"dc-low", "peer":peer, "dc":dc}),
            Self::Closed(peer, dc) => json!({"name":"dc-closed", "peer":peer, "dc":dc}),
            _ => return None,
        })
    }
    unsafe fn invoke(self, cb: &GrcRtcCallbacksV1) {
        let user = cb.user;
        match self {
            Self::Transmit(dst, bytes) => {
                if let Some(f) = cb.transmit {
                    f(user, &dst, bytes.as_ptr(), bytes.len())
                }
            }
            Self::Peer(peer, state, remote) => {
                if let Some(f) = cb.peer {
                    f(user, peer, state, &remote)
                }
            }
            Self::Open(peer, dc, label) => {
                if let Some(f) = cb.dc_open {
                    f(user, peer, dc, label.as_ptr().cast(), label.len())
                }
            }
            Self::Message(peer, dc, binary, bytes) => {
                if let Some(f) = cb.dc_message {
                    f(user, peer, dc, binary as c_int, bytes.as_ptr(), bytes.len())
                }
            }
            Self::Low(peer, dc) => {
                if let Some(f) = cb.dc_low {
                    f(user, peer, dc)
                }
            }
            Self::Closed(peer, dc) => {
                if let Some(f) = cb.dc_closed {
                    f(user, peer, dc)
                }
            }
            Self::Log(level, message) => {
                if let Some(f) = cb.log {
                    f(user, level, message.as_ptr().cast(), message.len())
                }
            }
        }
    }
}
impl State {
    fn timeout(&mut self, now: Instant) {
        for peer in self.peers.values_mut() {
            if peer.deadline.is_some_and(|d| d <= now) {
                peer.deadline = None;
                if let Err(e) = peer.rtc.handle_input(Input::Timeout(now)) {
                    self.pending.push_back(Callback::Log(GRC_LOG_ERROR, json!({"tMs":self.started.elapsed().as_millis() as u64,"event":"protocol-error", "peer":peer.id,"error":e.to_string()}).to_string()));
                    peer.rtc.disconnect();
                }
            }
        }
    }
    fn log(&mut self, level: c_int, event: &str, detail: serde_json::Value) {
        self.pending.push_back(Callback::Log(
            level,
            json!({"tMs":self.started.elapsed().as_millis() as u64,"event":event,"detail":detail})
                .to_string(),
        ));
    }
    fn receive(&mut self, source: SocketAddr, dst: SocketAddr, bytes: &[u8]) -> c_int {
        if dst != self.options.local
            || !allowed_ip(source.ip())
            || classify(bytes) == DatagramKind::Drop
        {
            return 0;
        }
        let now = Instant::now();
        if !self.peers.contains_key(&source) {
            if self.peers.len() >= self.options.max_peers || self.next_peer == 0 {
                return 0;
            }
            let Some(ufrag) = self.authenticate(bytes) else {
                return 0;
            };
            self.log(
                GRC_LOG_INFO,
                "first-stun",
                json!({"remote":source.to_string()}),
            );
            let mut rtc = RtcConfig::new()
                .set_crypto_provider(self.provider.clone())
                .set_dtls_cert(self.options.identity.cert.clone())
                .set_ice_lite(true)
                .set_local_ice_credentials(self.options.creds.clone())
                .set_fingerprint_verification(false)
                .set_sctp_max_buffered_amount(self.options.budget)
                .set_sctp_max_message_size(self.options.recv_max)
                .build(now);
            rtc.add_local_candidate(Candidate::host(self.options.local, "udp").unwrap());
            let mut direct = rtc.direct_api();
            direct.set_ice_controlling(false);
            direct.set_remote_ice_credentials(IceCreds {
                ufrag,
                pass: "unused-remote-password-22".into(),
            });
            direct.set_remote_fingerprint(Fingerprint {
                hash_func: "sha-256".into(),
                bytes: self.options.identity.fingerprint.to_vec(),
            });
            if let Err(e) = direct.start_dtls(false) {
                self.pending.push_back(Callback::Log(GRC_LOG_ERROR, json!({"tMs":self.started.elapsed().as_millis() as u64,"event":"protocol-error", "error":e.to_string()}).to_string()));
                return -4;
            }
            direct.start_sctp(false);
            let id = self.next_peer;
            self.next_peer = self.next_peer.wrapping_add(1);
            self.peers.insert(
                source,
                Peer {
                    id,
                    rtc,
                    trace: SctpTrace::default(),
                    deadline: None,
                    channels: HashMap::new(),
                    next_dc: 1,
                },
            );
        }
        let Ok(receive) = Receive::new(Protocol::Udp, source, dst, bytes) else {
            return 0;
        };
        let peer = self.peers.get_mut(&source).unwrap();
        let input = Input::Receive(now, receive);
        if peer.rtc.accepts(&input) {
            if let Err(e) = peer.rtc.handle_input(input) {
                self.pending.push_back(Callback::Log(GRC_LOG_ERROR, json!({"tMs":self.started.elapsed().as_millis() as u64,"event":"protocol-error", "error":e.to_string()}).to_string()));
                peer.rtc.disconnect();
                return -4;
            }
        }
        0
    }
    fn authenticate(&self, bytes: &[u8]) -> Option<String> {
        let message = StunMessage::parse(bytes).ok()?;
        if !message.is_binding_request() {
            return None;
        }
        let (ours, remote) = message.split_username()?;
        if ours != self.options.creds.ufrag || remote.is_empty() || remote.contains(':') {
            return None;
        }
        message
            .verify(self.options.creds.pass.as_bytes(), |key, parts| {
                self.provider.sha1_hmac_provider.sha1_hmac(key, parts)
            })
            .then(|| remote.to_owned())
    }
    fn drain(&mut self) {
        for (remote, peer) in &mut self.peers {
            while peer.rtc.is_alive() {
                let (output, sctp_up) = peer.trace.observe(|| peer.rtc.poll_output());
                if sctp_up {
                    self.pending.push_back(Callback::Log(GRC_LOG_INFO, json!({"tMs":self.started.elapsed().as_millis() as u64,"event":"sctp-up", "peer":peer.id}).to_string()));
                }
                match output {
                    Ok(Output::Transmit(tx)) => self.pending.push_back(Callback::Transmit(
                        GrcRtcAddr::from_socket(tx.destination),
                        tx.contents.to_vec(),
                    )),
                    Ok(Output::Timeout(deadline)) => {
                        peer.deadline = Some(deadline);
                        break;
                    }
                    Ok(Output::Event(event)) => match event {
                        Event::Connected => {
                            self.pending.push_back(Callback::Log(GRC_LOG_INFO, json!({"tMs":self.started.elapsed().as_millis() as u64,"event":"dtls-connected", "peer":peer.id}).to_string()));
                            self.pending.push_back(Callback::Peer(
                                peer.id,
                                1,
                                GrcRtcAddr::from_socket(*remote),
                            ));
                        }
                        Event::IceConnectionStateChange(ice) => {
                            let level = if ice == IceConnectionState::Disconnected {
                                GRC_LOG_WARN
                            } else {
                                GRC_LOG_INFO
                            };
                            let event = if matches!(
                                ice,
                                IceConnectionState::Connected | IceConnectionState::Completed
                            ) {
                                "ice-connected"
                            } else {
                                "ice-state"
                            };
                            self.pending.push_back(Callback::Log(level, json!({"tMs":self.started.elapsed().as_millis() as u64,"event":event,"peer":peer.id,"state":format!("{ice:?}")}).to_string()));
                            if ice == IceConnectionState::Disconnected {
                                peer.rtc.disconnect();
                            }
                        }
                        Event::ChannelOpen(id, label) => {
                            if peer.next_dc == 0 {
                                peer.rtc.direct_api().close_data_channel(id);
                                continue;
                            }
                            let dc = peer.next_dc;
                            peer.next_dc = peer.next_dc.wrapping_add(1);
                            peer.channels.insert(dc, id);
                            if let Some(mut channel) = peer.rtc.channel(id) {
                                channel.set_buffered_amount_low_threshold(self.options.low);
                            }
                            self.pending.push_back(Callback::Open(peer.id, dc, label));
                        }
                        Event::ChannelClose(id) => {
                            if let Some(dc) = peer.dc(id) {
                                peer.channels.remove(&dc);
                                self.pending.push_back(Callback::Closed(peer.id, dc));
                            }
                        }
                        Event::ChannelData(data) => {
                            if let Some(dc) = peer.dc(data.id) {
                                self.pending.push_back(Callback::Message(
                                    peer.id,
                                    dc,
                                    data.binary,
                                    data.data,
                                ));
                            }
                        }
                        Event::ChannelBufferedAmountLow(id) => {
                            if let Some(dc) = peer.dc(id) {
                                self.pending.push_back(Callback::Low(peer.id, dc));
                            }
                        }
                        _ => {}
                    },
                    Err(e) => {
                        self.pending.push_back(Callback::Log(GRC_LOG_ERROR, json!({"tMs":self.started.elapsed().as_millis() as u64,"event":"protocol-error", "error":e.to_string()}).to_string()));
                        peer.rtc.disconnect();
                    }
                }
            }
        }
        self.peers.retain(|remote, peer| {
            if peer.rtc.is_alive() {
                return true;
            }
            for dc in peer.channels.keys() {
                self.pending.push_back(Callback::Closed(peer.id, *dc));
            }
            self.pending
                .push_back(Callback::Peer(peer.id, 0, GrcRtcAddr::from_socket(*remote)));
            false
        });
    }
    fn peer(&mut self, id: u32) -> Option<&mut Peer> {
        self.peers.values_mut().find(|p| p.id == id)
    }
}
impl Peer {
    fn dc(&self, id: ChannelId) -> Option<u32> {
        self.channels
            .iter()
            .find_map(|(dc, channel)| (*channel == id).then_some(*dc))
    }
}

unsafe fn slice<'a>(data: *const u8, len: usize) -> Option<&'a [u8]> {
    if len > isize::MAX as usize || (len != 0 && data.is_null()) {
        return None;
    }
    Some(if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(data, len)
    })
}
unsafe fn options(config: &GrcRtcConfigV1) -> Result<Options, String> {
    let cert = slice(config.cert_der, config.cert_len).ok_or("invalid certificate buffer")?;
    let key = slice(config.key_pkcs8, config.key_len).ok_or("invalid key buffer")?;
    if !Identity::valid_pair(cert, key) {
        return Err("expected matching P-256 DER certificate and PKCS#8 key".into());
    }
    let string = |ptr: *const c_char| -> Result<String, String> {
        if ptr.is_null() {
            return Err("missing ICE credential".into());
        }
        let value = CStr::from_ptr(ptr)
            .to_str()
            .map_err(|_| "ICE credential must be UTF-8")?;
        if value.is_empty() || value.contains(':') {
            return Err("ICE credential must be nonempty and contain no colon".into());
        }
        Ok(value.to_owned())
    };
    let local = config
        .local_candidate
        .socket()
        .ok_or("invalid local candidate")?;
    if !allowed_ip(local.ip()) {
        return Err("local candidate must be specified non-loopback unicast".into());
    }
    Ok(Options {
        local,
        identity: Identity::from_der(cert.to_vec(), key.to_vec()),
        creds: IceCreds {
            ufrag: string(config.ice_ufrag)?,
            pass: string(config.ice_pwd)?,
        },
        max_peers: if config.max_peers == 0 {
            16
        } else {
            config.max_peers as usize
        },
        recv_max: if config.recv_max_message == 0 {
            262_144
        } else {
            config.recv_max_message
        },
        low: config.dc_low_threshold as usize,
        budget: if config.sctp_send_budget == 0 {
            262_144
        } else {
            config.sctp_send_budget as usize
        },
    })
}
// Each entry owns an Arc while it runs. A callback may consume the opaque handle
// without freeing the module out from under the outer entry or timer dispatcher.
unsafe fn module(handle: *mut c_void) -> Option<Arc<Module>> {
    (handle as *const Arc<Module>).as_ref().cloned()
}
unsafe extern "C" fn create(
    config: *const GrcRtcConfigV1,
    callbacks: *const GrcRtcCallbacksV1,
    out: *mut *mut c_void,
    err: *mut c_char,
    cap: usize,
) -> c_int {
    if out.is_null() {
        write_error(err, cap, "null out");
        return -1;
    }
    *out = std::ptr::null_mut();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let config = config.as_ref().ok_or((-1, "null config".to_owned()))?;
        let callbacks = callbacks
            .as_ref()
            .ok_or((-1, "null callbacks".to_owned()))?;
        if callbacks.abi != GRC_NET_RTC_ABI_VERSION {
            return Err((-1, "unsupported callback ABI".to_owned()));
        }
        let options = options(config).map_err(|message| (-1, message))?;
        Module::start(options, *callbacks).map_err(|message| (-4, message))
    }));
    match result {
        Ok(Ok(module)) => {
            *out = Box::into_raw(Box::new(module)).cast();
            write_error(err, cap, "");
            0
        }
        Ok(Err((code, message))) => {
            write_error(err, cap, &message);
            code
        }
        Err(_) => {
            write_error(err, cap, "RTC create panic");
            -4
        }
    }
}
unsafe extern "C" fn input(
    handle: *mut c_void,
    src: *const GrcRtcAddr,
    dst: *const GrcRtcAddr,
    data: *const u8,
    len: usize,
) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        let (Some(module), Some(src), Some(dst), Some(bytes)) = (
            module(handle),
            src.as_ref().and_then(|a| a.socket()),
            dst.as_ref().and_then(|a| a.socket()),
            slice(data, len),
        ) else {
            return -1;
        };
        module.call(-1, |s| s.receive(src, dst, bytes))
    }))
    .unwrap_or(-4)
}
unsafe extern "C" fn send(
    handle: *mut c_void,
    peer: u32,
    dc: u32,
    binary: c_int,
    data: *const u8,
    len: usize,
) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        let (Some(module), Some(bytes)) = (module(handle), slice(data, len)) else {
            return -1;
        };
        if len == 0 {
            return -1;
        }
        if len > OUTBOUND_MESSAGE_LIMIT {
            return -3;
        }
        if !(0..=1).contains(&binary) || (binary == 0 && std::str::from_utf8(bytes).is_err()) {
            return -1;
        }
        module.call(-1, |s| {
            let Some(peer) = s.peer(peer) else {
                return -2;
            };
            let Some(id) = peer.channels.get(&dc).copied() else {
                return -2;
            };
            let Some(mut channel) = peer.rtc.channel(id) else {
                return -2;
            };
            match channel.write(binary != 0, bytes) {
                Ok(true) => 0,
                Ok(false) => 1,
                Err(_) => -4,
            }
        })
    }))
    .unwrap_or(-4)
}
unsafe extern "C" fn buffered(handle: *mut c_void, peer: u32, dc: u32) -> u64 {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(module) = module(handle) else {
            return 0;
        };
        module.call(0, |s| {
            let Some(peer) = s.peer(peer) else {
                return 0;
            };
            let Some(id) = peer.channels.get(&dc).copied() else {
                return 0;
            };
            peer.rtc
                .channel(id)
                .map_or(0, |mut c| c.buffered_amount() as u64)
        })
    }))
    .unwrap_or(0)
}
unsafe extern "C" fn close_dc(handle: *mut c_void, peer: u32, dc: u32) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let Some(module) = module(handle) else {
            return;
        };
        module.call((), |s| {
            let closed = s.peer(peer).and_then(|peer| {
                let id = peer.channels.remove(&dc)?;
                peer.rtc.direct_api().close_data_channel(id);
                Some(peer.id)
            });
            if let Some(peer) = closed {
                s.pending.push_back(Callback::Closed(peer, dc));
            }
        });
    }));
}
unsafe extern "C" fn close_peer(handle: *mut c_void, peer: u32) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if let Some(module) = module(handle) {
            module.call((), |s| {
                if let Some(peer) = s.peer(peer) {
                    peer.rtc.disconnect();
                }
            });
        }
    }));
}
unsafe extern "C" fn destroy(handle: *mut c_void) {
    if !handle.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let module = Box::from_raw(handle as *mut Arc<Module>);
            module.stop();
        }));
    }
}
static TABLE: GrcRtcV1 = GrcRtcV1 {
    abi: GRC_NET_RTC_ABI_VERSION,
    create,
    input,
    send,
    buffered,
    close_dc,
    close_peer,
    destroy,
};

/// Process-lifetime RTC function table. Only present in builds with the rtc feature.
#[no_mangle]
pub extern "C" fn grc_net_rtc_v1() -> *const GrcRtcV1 {
    &TABLE
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use str0m::crypto::dtls::DtlsCert;
    use str0m::ice::TransId;

    fn state() -> State {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let cert = rcgen::CertificateParams::default()
            .self_signed(&key)
            .unwrap();
        let started = Instant::now();
        State {
            options: Options {
                local: "192.0.2.1:45000".parse().unwrap(),
                identity: Identity::from_der(cert.der().to_vec(), key.serialize_der()),
                creds: IceCreds {
                    ufrag: "host".into(),
                    pass: "password-for-the-host".into(),
                },
                max_peers: 1,
                recv_max: 262144,
                low: 0,
                budget: 262144,
            },
            provider: Arc::new(str0m_rust_crypto::default_provider()),
            peers: HashMap::new(),
            next_peer: 1,
            pending: Pending {
                started,
                queue: VecDeque::new(),
            },
            dispatch_thread: None,
            stopping: false,
            started,
        }
    }
    fn request(state: &State) -> Vec<u8> {
        let request =
            StunMessage::binding_request("host:browser", TransId::new(), true, 1, 2130706431, true);
        let mut bytes = vec![0; 1024];
        let len = request
            .to_bytes(
                Some(state.options.creds.pass.as_bytes()),
                &mut bytes,
                |key, parts| state.provider.sha1_hmac_provider.sha1_hmac(key, parts),
            )
            .unwrap();
        bytes.truncate(len);
        bytes
    }
    #[test]
    fn ice_timeout_removes_peer_and_reclaims_capacity() {
        let mut state = state();
        let remote = "192.0.2.2:45001".parse().unwrap();
        assert_eq!(
            state.receive(remote, state.options.local, &request(&state)),
            0
        );
        state.drain();
        assert_eq!(state.peers.len(), 1);
        let started = Instant::now();
        // Advance protocol time directly; this tests ICE timeout rather than wall time.
        for seconds in 1..=120 {
            for peer in state.peers.values_mut() {
                peer.rtc
                    .handle_input(Input::Timeout(started + Duration::from_secs(seconds)))
                    .unwrap();
            }
            state.drain();
            if state.peers.is_empty() {
                break;
            }
        }
        assert!(state.peers.is_empty(), "ICE-lite peer never expired");
        assert_eq!(
            state
                .pending
                .iter()
                .filter(|cb| matches!(cb, Callback::Peer(1, 0, _)))
                .count(),
            1
        );
        assert!(state
            .pending
            .iter()
            .any(|cb| matches!(cb, Callback::Log(GRC_LOG_WARN, _))));
        assert_eq!(
            state.receive(remote, state.options.local, &request(&state)),
            0
        );
        assert_eq!(state.peers[&remote].id, 2);
    }
    #[test]
    fn address_validation_rejects_forbidden_sources_and_accepts_ipv6() {
        let mut state = state();
        for remote in [
            "127.0.0.1:45001",
            "0.0.0.0:45001",
            "224.0.0.1:45001",
            "[::1]:45001",
            "[::]:45001",
            "[ff02::1]:45001",
            "[::ffff:127.0.0.1]:45001",
            "[::ffff:0.0.0.0]:45001",
            "[::ffff:224.0.0.1]:45001",
        ] {
            assert_eq!(
                state.receive(
                    remote.parse().unwrap(),
                    state.options.local,
                    &request(&state)
                ),
                0
            );
            assert!(state.peers.is_empty());
        }
        let remote: SocketAddr = "[2001:db8::2]:45001".parse().unwrap();
        assert_eq!(GrcRtcAddr::from_socket(remote).socket(), Some(remote));
        let mut invalid = GrcRtcAddr::from_socket(remote);
        invalid._r = 1;
        assert_eq!(invalid.socket(), None);
        state.options.local = "[2001:db8::1]:45000".parse().unwrap();
        assert_eq!(
            state.receive(remote, state.options.local, &request(&state)),
            0
        );
        assert_eq!(state.peers.len(), 1);
    }
    #[test]
    fn zero_options_apply_documented_defaults_and_timer_joins() {
        let state = state();
        let DtlsCert {
            certificate,
            private_key,
        } = state.options.identity.cert;
        let ufrag = std::ffi::CString::new("host").unwrap();
        let pwd = std::ffi::CString::new("password-for-the-host").unwrap();
        let config = GrcRtcConfigV1 {
            cert_der: certificate.as_ptr(),
            cert_len: certificate.len(),
            key_pkcs8: private_key.as_ptr(),
            key_len: private_key.len(),
            ice_ufrag: ufrag.as_ptr(),
            ice_pwd: pwd.as_ptr(),
            local_candidate: GrcRtcAddr::from_socket(state.options.local),
            max_peers: 0,
            recv_max_message: 0,
            dc_low_threshold: 0,
            sctp_send_budget: 0,
        };
        let options = unsafe { options(&config) }.unwrap();
        assert_eq!(
            (
                options.max_peers,
                options.recv_max,
                options.low,
                options.budget
            ),
            (16, 262144, 0, 262144)
        );
        let callbacks = GrcRtcCallbacksV1 {
            abi: 1,
            user: std::ptr::null_mut(),
            transmit: None,
            peer: None,
            dc_open: None,
            dc_message: None,
            dc_low: None,
            dc_closed: None,
            log: None,
        };
        let module = Module::start(options, callbacks).unwrap();
        assert!(module.timer.lock().unwrap().is_some());
        let weak = Arc::downgrade(&module);
        module.stop();
        assert!(module.timer.lock().unwrap().is_none());
        assert!(module.lock().stopping);
        drop(module);
        assert!(weak.upgrade().is_none(), "timer retained module after stop");
    }
}
