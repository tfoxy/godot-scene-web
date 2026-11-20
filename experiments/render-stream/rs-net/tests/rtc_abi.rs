#![cfg(feature = "rtc")]
//! Only the browser uses str0m directly. Every server interaction crosses the C table.
use render_stream_net::abi::*;
use std::collections::VecDeque;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::net::SocketAddr;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU8, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use str0m::channel::{ChannelConfig, ChannelData, ChannelId};
use str0m::crypto::{dtls::DtlsCert, Fingerprint};
use str0m::ice::{StunMessage, TransId};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceCreds, Input, Output, Rtc, RtcConfig};

fn api() -> &'static GrcRtcV1 {
    unsafe { &*render_stream_net::rtc::grc_net_rtc_v1() }
}
fn addr(last: u8) -> GrcRtcAddr {
    GrcRtcAddr {
        family: 4,
        _r: 0,
        port: 45000 + last as u16,
        addr: [192, 0, 2, last, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    }
}
fn socket(last: u8) -> SocketAddr {
    format!("192.0.2.{last}:{}", 45000 + last as u16)
        .parse()
        .unwrap()
}
fn identity() -> (Vec<u8>, Vec<u8>) {
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let cert = rcgen::CertificateParams::default()
        .self_signed(&key)
        .unwrap();
    (cert.der().to_vec(), key.serialize_der())
}
fn request(ufrag: &str, password: &str) -> Vec<u8> {
    let username = format!("{ufrag}:browserUfrag");
    let request =
        StunMessage::binding_request(&username, TransId::new(), true, 1, 2130706431, true);
    let mut bytes = vec![0; 1024];
    let provider = str0m_rust_crypto::default_provider();
    let len = request
        .to_bytes(Some(password.as_bytes()), &mut bytes, |key, parts| {
            provider.sha1_hmac_provider.sha1_hmac(key, parts)
        })
        .unwrap();
    bytes.truncate(len);
    bytes
}
#[derive(Default)]
struct Observed {
    tx: VecDeque<(GrcRtcAddr, Vec<u8>)>,
    peers: Vec<(u32, c_int, GrcRtcAddr)>,
    open: Vec<(u32, u32, String)>,
    messages: Vec<(u32, u32, bool, Vec<u8>)>,
    low: Vec<(u32, u32)>,
    closed: Vec<(u32, u32)>,
    errors: Vec<String>,
    logs: Vec<(c_int, serde_json::Value)>,
}
#[derive(Default)]
struct Host {
    handle: AtomicPtr<c_void>,
    observed: Mutex<Observed>,
    callbacks: AtomicUsize,
    destroyed: AtomicBool,
    late: AtomicUsize,
    // 1 echo from dc_message, 2 destroy from dc_message, 3 destroy from transmit.
    mode: AtomicU8,
    destroyed_on: Mutex<Option<std::thread::ThreadId>>,
}
impl Host {
    fn note(&self) {
        self.callbacks.fetch_add(1, SeqCst);
        if self.destroyed.load(SeqCst) {
            self.late.fetch_add(1, SeqCst);
        }
    }
    unsafe fn destroy(&self) {
        let handle = self.handle.swap(ptr::null_mut(), SeqCst);
        if !handle.is_null() {
            (api().destroy)(handle);
        }
        *self.destroyed_on.lock().unwrap() = Some(std::thread::current().id());
        self.destroyed.store(true, SeqCst);
    }
    fn callbacks_table(&self) -> GrcRtcCallbacksV1 {
        GrcRtcCallbacksV1 {
            abi: 1,
            user: (self as *const Self).cast_mut().cast(),
            transmit: Some(transmit),
            peer: Some(peer),
            dc_open: Some(open),
            dc_message: Some(message),
            dc_low: Some(low),
            dc_closed: Some(closed),
            log: Some(log),
        }
    }
}
unsafe extern "C" fn transmit(
    user: *mut c_void,
    dst: *const GrcRtcAddr,
    data: *const u8,
    len: usize,
) {
    let host = &*user.cast::<Host>();
    host.note();
    host.observed
        .lock()
        .unwrap()
        .tx
        .push_back((*dst, std::slice::from_raw_parts(data, len).to_vec()));
    if host.mode.load(SeqCst) == 3 {
        host.destroy();
    }
}
unsafe extern "C" fn peer(user: *mut c_void, peer: u32, state: c_int, remote: *const GrcRtcAddr) {
    let host = &*user.cast::<Host>();
    host.note();
    host.observed
        .lock()
        .unwrap()
        .peers
        .push((peer, state, *remote));
}
unsafe extern "C" fn open(user: *mut c_void, peer: u32, dc: u32, label: *const c_char, len: usize) {
    let host = &*user.cast::<Host>();
    host.note();
    let label = String::from_utf8_lossy(std::slice::from_raw_parts(label.cast(), len)).into_owned();
    host.observed.lock().unwrap().open.push((peer, dc, label));
}
unsafe extern "C" fn message(
    user: *mut c_void,
    peer: u32,
    dc: u32,
    binary: c_int,
    bytes: *const u8,
    len: usize,
) {
    let host = &*user.cast::<Host>();
    host.note();
    host.observed.lock().unwrap().messages.push((
        peer,
        dc,
        binary != 0,
        std::slice::from_raw_parts(bytes, len).to_vec(),
    ));
    match host.mode.load(SeqCst) {
        1 => {
            let result = (api().send)(host.handle.load(SeqCst), peer, dc, binary, bytes, len);
            if result != 0 {
                host.observed
                    .lock()
                    .unwrap()
                    .errors
                    .push(format!("reentrant send: {result}"));
            }
        }
        2 => host.destroy(),
        _ => {}
    }
}
unsafe extern "C" fn low(user: *mut c_void, peer: u32, dc: u32) {
    let host = &*user.cast::<Host>();
    host.note();
    host.observed.lock().unwrap().low.push((peer, dc));
}
unsafe extern "C" fn closed(user: *mut c_void, peer: u32, dc: u32) {
    let host = &*user.cast::<Host>();
    host.note();
    host.observed.lock().unwrap().closed.push((peer, dc));
}
unsafe extern "C" fn log(user: *mut c_void, level: c_int, message: *const c_char, len: usize) {
    let host = &*user.cast::<Host>();
    host.note();
    let value = serde_json::from_slice(std::slice::from_raw_parts(message.cast(), len));
    if let Ok(value) = value {
        host.observed.lock().unwrap().logs.push((level, value));
    }
    if level == 0 {
        host.observed.lock().unwrap().errors.push(
            String::from_utf8_lossy(std::slice::from_raw_parts(message.cast(), len)).into_owned(),
        );
    }
}
struct Pair {
    host: Box<Host>,
    browser: Rtc,
    messages: Vec<ChannelData>,
    opened: Vec<ChannelId>,
    browser_closed: Vec<ChannelId>,
}
impl Pair {
    fn new() -> Self {
        Self::configured(1, 0, 32768, 0)
    }
    fn configured(
        max_peers: u32,
        recv_max_message: u32,
        dc_low_threshold: u32,
        sctp_send_budget: u32,
    ) -> Self {
        let (cert, key) = identity();
        let fingerprint = ring::digest::digest(&ring::digest::SHA256, &cert)
            .as_ref()
            .to_vec();
        // Intentionally independent of certificate-derived credentials: the host owns them.
        let ufrag = CString::new("hostUfrag").unwrap();
        let pwd = CString::new("hostPasswordForTheAbiTest").unwrap();
        let config = GrcRtcConfigV1 {
            cert_der: cert.as_ptr(),
            cert_len: cert.len(),
            key_pkcs8: key.as_ptr(),
            key_len: key.len(),
            ice_ufrag: ufrag.as_ptr(),
            ice_pwd: pwd.as_ptr(),
            local_candidate: addr(1),
            max_peers,
            recv_max_message,
            dc_low_threshold,
            sctp_send_budget,
        };
        let host = Box::<Host>::default();
        let callbacks = host.callbacks_table();
        let mut handle = ptr::null_mut();
        let mut err = [0 as c_char; 256];
        assert_eq!(
            unsafe {
                (api().create)(
                    &config,
                    &callbacks,
                    &mut handle,
                    err.as_mut_ptr(),
                    err.len(),
                )
            },
            0,
            "{}",
            unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy()
        );
        assert!(!handle.is_null());
        host.handle.store(handle, SeqCst);
        // The server must have copied all temporary config and callback storage.
        let (cert, key) = identity();
        let mut browser = RtcConfig::new()
            .set_crypto_provider(Arc::new(str0m_rust_crypto::default_provider()))
            .set_dtls_cert(DtlsCert {
                certificate: cert,
                private_key: key,
            })
            .build(Instant::now());
        browser.add_local_candidate(Candidate::host(socket(2), "udp").unwrap());
        browser.add_remote_candidate(Candidate::host(socket(1), "udp").unwrap());
        let mut direct = browser.direct_api();
        direct.set_ice_controlling(true);
        direct.set_remote_ice_credentials(IceCreds {
            ufrag: ufrag.to_str().unwrap().into(),
            pass: pwd.to_str().unwrap().into(),
        });
        direct.set_remote_fingerprint(Fingerprint {
            hash_func: "sha-256".into(),
            bytes: fingerprint,
        });
        direct.start_dtls(true).unwrap();
        direct.start_sctp(true);
        Self {
            host,
            browser,
            messages: vec![],
            opened: vec![],
            browser_closed: vec![],
        }
    }
    fn input(&self, source: u8, bytes: &[u8]) {
        assert_eq!(
            unsafe {
                (api().input)(
                    self.host.handle.load(SeqCst),
                    &addr(source),
                    &addr(1),
                    bytes.as_ptr(),
                    bytes.len(),
                )
            },
            0
        );
    }
    fn tick(&mut self) {
        self.browser
            .handle_input(Input::Timeout(Instant::now()))
            .unwrap();
        for _ in 0..1000 {
            if self.host.destroyed.load(SeqCst) {
                return;
            }
            let mut progressed = false;
            loop {
                match self.browser.poll_output().unwrap() {
                    Output::Transmit(tx) => {
                        self.input(2, &tx.contents);
                        progressed = true;
                    }
                    Output::Event(Event::ChannelOpen(id, _)) => self.opened.push(id),
                    Output::Event(Event::ChannelClose(id)) => self.browser_closed.push(id),
                    Output::Event(Event::ChannelData(data)) => self.messages.push(data),
                    Output::Event(_) => {}
                    Output::Timeout(_) => break,
                }
                if self.host.destroyed.load(SeqCst) {
                    return;
                }
            }
            // str0m must drain its DTLS receive queue between datagrams.
            let tx = self.host.observed.lock().unwrap().tx.pop_front();
            if let Some((dst, bytes)) = tx {
                assert_eq!(dst, addr(2));
                self.browser
                    .handle_input(Input::Receive(
                        Instant::now(),
                        Receive::new(Protocol::Udp, socket(1), socket(2), &bytes).unwrap(),
                    ))
                    .unwrap();
                progressed = true;
            }
            if !progressed {
                break;
            }
        }
    }
    fn until(&mut self, condition: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition(self) && Instant::now() < deadline {
            self.tick();
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(condition(self), "ABI condition timed out");
        let observed = self.host.observed.lock().unwrap();
        assert!(observed.errors.is_empty(), "{:?}", observed.errors);
    }
    fn open(&mut self, label: &str) -> (ChannelId, u32, u32) {
        let browser_id = self
            .browser
            .direct_api()
            .create_data_channel(ChannelConfig {
                label: label.into(),
                ..Default::default()
            });
        self.until(|p| {
            p.opened.contains(&browser_id)
                && p.host
                    .observed
                    .lock()
                    .unwrap()
                    .open
                    .iter()
                    .any(|(_, _, l)| l == label)
        });
        let (peer, dc, _) = self
            .host
            .observed
            .lock()
            .unwrap()
            .open
            .iter()
            .find(|(_, _, l)| l == label)
            .unwrap()
            .clone();
        (browser_id, peer, dc)
    }
    fn server_send(&self, peer: u32, dc: u32, binary: bool, bytes: &[u8]) -> c_int {
        unsafe {
            (api().send)(
                self.host.handle.load(SeqCst),
                peer,
                dc,
                binary as c_int,
                bytes.as_ptr(),
                bytes.len(),
            )
        }
    }
    fn no_late_callbacks(&self) {
        let count = self.host.callbacks.load(SeqCst);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(self.host.callbacks.load(SeqCst), count);
        assert_eq!(self.host.late.load(SeqCst), 0);
    }
}
impl Drop for Pair {
    fn drop(&mut self) {
        unsafe {
            self.host.destroy();
        }
    }
}

#[test]
fn abi_auth_messages_backpressure_reentrancy_and_close() {
    let mut p = Pair::new();
    // With one capacity slot, a subsequent valid browser connection proves these
    // packets did not allocate a peer. A different source prevents reusing a slot.
    for bytes in [
        request("wrongUfrag", "hostPasswordForTheAbiTest"),
        request("hostUfrag", "wrongPassword"),
        vec![22; 64],
    ] {
        p.input(3, &bytes);
    }
    assert_eq!(p.host.callbacks.load(SeqCst), 0);
    let (browser_id, peer, dc) = p.open("couch-tunnel/1");
    assert_eq!(
        p.host.observed.lock().unwrap().peers,
        vec![(peer, 1, addr(2))]
    );
    for (binary, bytes) in [
        (true, vec![0, 255, 128, 42]),
        (false, "hello 🦀".as_bytes().to_vec()),
    ] {
        assert!(p
            .browser
            .channel(browser_id)
            .unwrap()
            .write(binary, &bytes)
            .unwrap());
        p.until(|p| !p.host.observed.lock().unwrap().messages.is_empty());
        assert_eq!(
            p.host.observed.lock().unwrap().messages.remove(0),
            (peer, dc, binary, bytes.clone())
        );
        assert_eq!(p.server_send(peer, dc, binary, &bytes), 0);
        p.until(|p| !p.messages.is_empty());
        let message = p.messages.remove(0);
        assert_eq!(
            (message.id, message.binary, message.data),
            (browser_id, binary, bytes)
        );
    }
    p.host.mode.store(1, SeqCst);
    assert!(p
        .browser
        .channel(browser_id)
        .unwrap()
        .write(true, b"reentrant")
        .unwrap());
    p.until(|p| !p.messages.is_empty());
    assert_eq!(p.messages.remove(0).data, b"reentrant");
    p.host.mode.store(0, SeqCst);
    assert_eq!(p.server_send(peer, dc, true, &vec![0; 65537]), -3);
    assert_eq!(p.server_send(peer, dc, false, &[255]), -1);
    assert_eq!(p.server_send(peer, dc + 100, true, b"x"), -2);
    p.host.observed.lock().unwrap().low.clear();
    let chunk = vec![42; 16384];
    let mut accepted = 0;
    loop {
        match p.server_send(peer, dc, true, &chunk) {
            0 => accepted += 1,
            1 => break,
            code => panic!("unexpected send code {code}"),
        }
        assert!(accepted <= 16, "association budget was not enforced");
    }
    assert!(accepted > 0);
    assert!(unsafe { (api().buffered)(p.host.handle.load(SeqCst), peer, dc) } > 32768);
    p.until(|p| {
        p.messages.len() == accepted && p.host.observed.lock().unwrap().low.contains(&(peer, dc))
    });
    assert_eq!(
        unsafe { (api().buffered)(p.host.handle.load(SeqCst), peer, dc) },
        0
    );
    assert!(p.messages.drain(..).all(|m| m.binary && m.data == chunk));
    // Labels are application policy, and IDs remain opaque.
    let (_, _, other_dc) = p.open("other-label");
    unsafe {
        (api().close_dc)(p.host.handle.load(SeqCst), peer, dc);
    }
    p.until(|p| p.browser_closed.contains(&browser_id));
    assert_eq!(
        p.host
            .observed
            .lock()
            .unwrap()
            .closed
            .iter()
            .filter(|x| **x == (peer, dc))
            .count(),
        1
    );
    assert_eq!(p.server_send(peer, dc, true, b"closed"), -2);
    unsafe {
        (api().close_peer)(p.host.handle.load(SeqCst), peer);
    }
    assert!(p
        .host
        .observed
        .lock()
        .unwrap()
        .closed
        .contains(&(peer, other_dc)));
    assert_eq!(
        p.host.observed.lock().unwrap().peers.last(),
        Some(&(peer, 0, addr(2)))
    );
}

#[test]
fn abi_input_requires_dst_to_equal_local_candidate() {
    let p = Pair::new();
    let request = request("hostUfrag", "hostPasswordForTheAbiTest");
    let mut mapped = GrcRtcAddr {
        family: 6,
        _r: 0,
        port: addr(1).port,
        addr: [0; 16],
    };
    mapped.addr[10] = 0xff;
    mapped.addr[11] = 0xff;
    mapped.addr[12..].copy_from_slice(&addr(1).addr[..4]);
    let mut other_port = addr(1);
    other_port.port += 1;
    for dst in [addr(9), other_port, mapped] {
        let rc = unsafe {
            (api().input)(
                p.host.handle.load(SeqCst),
                &addr(2),
                &dst,
                request.as_ptr(),
                request.len(),
            )
        };
        assert_eq!(rc, 0);
    }
    // Dropped silently: no peer, no STUN answer, no callback of any kind.
    assert_eq!(p.host.callbacks.load(SeqCst), 0);
    assert!(p.host.observed.lock().unwrap().tx.is_empty());
}

#[test]
fn abi_destroy_with_traffic_in_flight_suppresses_callbacks() {
    let mut p = Pair::new();
    let (_, peer, dc) = p.open("couch-tunnel/1");
    assert_eq!(p.server_send(peer, dc, true, &vec![1; 65536]), 0);
    assert!(!p.host.observed.lock().unwrap().tx.is_empty());
    unsafe {
        p.host.destroy();
    }
    p.no_late_callbacks();
}

#[test]
fn abi_destroy_inside_message_callback_is_reentrant() {
    let mut p = Pair::new();
    let (browser_id, _, _) = p.open("couch-tunnel/1");
    p.host.mode.store(2, SeqCst);
    assert!(p
        .browser
        .channel(browser_id)
        .unwrap()
        .write(false, b"destroy now")
        .unwrap());
    p.until(|p| p.host.destroyed.load(SeqCst));
    p.no_late_callbacks();
}

#[test]
fn abi_destroy_inside_timer_callback_does_not_join_itself() {
    let mut p = Pair::new();
    let (_, peer, dc) = p.open("couch-tunnel/1");
    assert_eq!(p.server_send(peer, dc, true, &vec![1; 65536]), 0);
    // No further host entries or browser ACKs: a timer retransmission invokes transmit.
    p.host.mode.store(3, SeqCst);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !p.host.destroyed.load(SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(p.host.destroyed.load(SeqCst), "no timer retransmission");
    assert_ne!(
        *p.host.destroyed_on.lock().unwrap(),
        Some(std::thread::current().id())
    );
    p.no_late_callbacks();
}

#[test]
fn abi_null_handles_and_invalid_create_are_harmless() {
    unsafe {
        assert_eq!(
            (api().input)(ptr::null_mut(), &addr(2), &addr(1), ptr::null(), 0),
            -1
        );
        assert_eq!((api().send)(ptr::null_mut(), 1, 1, 1, ptr::null(), 0), -1);
        assert_eq!((api().buffered)(ptr::null_mut(), 1, 1), 0);
        (api().close_dc)(ptr::null_mut(), 1, 1);
        (api().close_peer)(ptr::null_mut(), 1);
        (api().destroy)(ptr::null_mut());
        let mut handle = ptr::dangling_mut();
        let mut err = [0 as c_char; 128];
        assert_eq!(
            (api().create)(
                ptr::null(),
                ptr::null(),
                &mut handle,
                err.as_mut_ptr(),
                err.len()
            ),
            -1
        );
        assert!(handle.is_null());
        assert!(!CStr::from_ptr(err.as_ptr()).to_bytes().is_empty());
    }
}

#[test]
fn abi_empty_send_is_rejected_without_stalling_the_stream() {
    let mut p = Pair::new();
    let (_, peer, dc) = p.open("couch-tunnel/1");
    assert_eq!(p.server_send(peer, dc, true, &[]), -1);
    assert_eq!(p.server_send(peer, dc, false, &[]), -1);
    assert_eq!(p.server_send(peer, dc, true, b"after empty"), 0);
    p.until(|p| !p.messages.is_empty());
    assert_eq!(p.messages.remove(0).data, b"after empty");
}

#[test]
fn abi_logs_milestones_with_monotonic_timestamps() {
    let mut p = Pair::new();
    p.open("couch-tunnel/1");
    let observed = p.host.observed.lock().unwrap();
    let mut previous = 0;
    for (level, log) in &observed.logs {
        assert!((0..=2).contains(level));
        let timestamp = log["tMs"].as_u64().unwrap();
        assert!(timestamp >= previous);
        previous = timestamp;
    }
    for event in [
        "first-stun",
        "ice-connected",
        "dtls-connected",
        "sctp-up",
        "dc-open",
    ] {
        assert!(
            observed.logs.iter().any(|(_, log)| log["event"] == event),
            "missing {event}: {:?}",
            observed.logs
        );
    }
}

#[test]
fn abi_configured_budget_and_low_threshold() {
    let mut p = Pair::configured(1, 0, 0, 32768);
    let (_, peer, dc) = p.open("budget");
    // Drain DCEP accounting first.
    p.until(|p| unsafe { (api().buffered)(p.host.handle.load(SeqCst), peer, dc) } == 0);
    p.host.observed.lock().unwrap().low.clear();
    assert_eq!(p.server_send(peer, dc, true, &vec![1; 30000]), 0);
    assert_eq!(p.server_send(peer, dc, true, &vec![1; 3000]), 1);
    p.until(|p| p.host.observed.lock().unwrap().low.contains(&(peer, dc)));
    assert_eq!(
        unsafe { (api().buffered)(p.host.handle.load(SeqCst), peer, dc) },
        0
    );
}

#[test]
fn abi_peer_capacity_is_reclaimed_on_close() {
    let mut p = Pair::new();
    p.input(3, &request("hostUfrag", "hostPasswordForTheAbiTest"));
    let tx_count = p.host.observed.lock().unwrap().tx.len();
    p.input(4, &request("hostUfrag", "hostPasswordForTheAbiTest"));
    assert_eq!(p.host.observed.lock().unwrap().tx.len(), tx_count);
    unsafe {
        (api().close_peer)(p.host.handle.load(SeqCst), 1);
    }
    assert_eq!(p.host.observed.lock().unwrap().peers, vec![(1, 0, addr(3))]);
    // Discard datagrams intended for the first authenticated source.
    p.host.observed.lock().unwrap().tx.clear();
    let (_, peer, _) = p.open("reclaimed");
    assert_eq!(peer, 2);
}

#[test]
fn abi_receive_limit_does_not_deliver_oversize_messages() {
    let mut p = Pair::configured(1, 128, 0, 0);
    let (browser_id, _, _) = p.open("receive-limit");
    assert!(p
        .browser
        .channel(browser_id)
        .unwrap()
        .write(true, &[1; 128])
        .unwrap());
    p.until(|p| p.host.observed.lock().unwrap().messages.len() == 1);
    assert!(p
        .browser
        .channel(browser_id)
        .unwrap()
        .write(true, &[1; 129])
        .unwrap());
    // Pump the association through delivery and acknowledgements; oversized SCTP
    // messages must never become a host callback (the transport may close it).
    for _ in 0..100 {
        p.tick();
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(p.host.observed.lock().unwrap().messages.len(), 1);
}
