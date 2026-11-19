//! Sans-IO ICE-lite endpoint. Authentication precedes peer allocation; there is no SDP input.

mod identity;
pub use identity::{credentials, Identity};

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use str0m::channel::{ChannelData, ChannelId};
use str0m::crypto::{CryptoProvider, Fingerprint};
use str0m::ice::StunMessage;
use str0m::net::{Protocol, Receive, Transmit};
use str0m::{Candidate, Event, IceConnectionState, IceCreds, Input, Output, Rtc, RtcConfig};

pub const LABEL: &str = "couch-tunnel/1";
pub const MAX_PEERS: usize = 16;
// str0m's direct API supplies no remote max-message-size, so SCTP assumes 64 KiB.
pub const OUTBOUND_MESSAGE_LIMIT: usize = 65_536;
const MAX_MESSAGE: usize = 262_144;

/// The association's send budget: SCTP bytes queued or in flight. It bounds throughput at about
/// budget / RTT, so it is tunable (`RS_RTC_SEND_BUFFER`, bytes) for measurements; the default
/// holds one maximum-size message.
pub fn send_budget() -> usize {
    static BUDGET: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *BUDGET.get_or_init(|| {
        std::env::var("RS_RTC_SEND_BUFFER")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v >= MAX_MESSAGE)
            .unwrap_or(MAX_MESSAGE)
    })
}

// Refill a channel on the half-budget low-water event.
fn low_water() -> usize {
    send_budget() / 2
}

#[derive(Debug, PartialEq, Eq)]
pub enum DatagramKind {
    Stun,
    Dtls,
    Drop,
}

pub fn classify(data: &[u8]) -> DatagramKind {
    match data.first() {
        Some(0..=3) => DatagramKind::Stun,
        Some(20..=63) => DatagramKind::Dtls,
        _ => DatagramKind::Drop,
    }
}

pub fn allowed_ip(ip: IpAddr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast()
}

pub enum EngineOutput {
    Transmit(Transmit),
    Event(Value),
    Timeout(Option<Instant>),
}

pub struct Engine {
    local: SocketAddr,
    identity: Identity,
    provider: Arc<CryptoProvider>,
    peers: HashMap<SocketAddr, Peer>,
    events: VecDeque<Value>,
}

struct Peer {
    rtc: Rtc,
    deadline: Option<Instant>,
    channels: HashMap<ChannelId, Channel>,
    opened: u64,
    closed: u64,
    #[cfg(test)]
    generated_get_bytes: u64,
}

#[derive(Default)]
struct Channel {
    first: bool,
    get: Option<Get>,
    echo: VecDeque<(bool, Vec<u8>)>,
    queued: usize,
    close_after_send: bool,
}

struct Get {
    n: u64,
    sent: u64,
    chunk: usize,
}

impl Engine {
    pub fn new(local: SocketAddr, identity: Identity) -> Result<Self, String> {
        if !allowed_ip(local.ip()) || local.port() == 0 {
            return Err("bind must be a non-loopback, specified unicast ip:port".into());
        }
        Ok(Self {
            local,
            identity,
            provider: Arc::new(str0m_rust_crypto::default_provider()),
            peers: HashMap::new(),
            events: VecDeque::new(),
        })
    }

    pub fn peer_count(&self) -> usize {
        self.peers.len()
    }

    pub fn receive(&mut self, now: Instant, source: SocketAddr, data: &[u8]) -> Result<(), String> {
        if !allowed_ip(source.ip()) || source.port() == 0 || classify(data) == DatagramKind::Drop {
            return Ok(());
        }
        if !self.peers.contains_key(&source) {
            if self.peers.len() == MAX_PEERS || classify(data) != DatagramKind::Stun {
                return Ok(());
            }
            let Some(ufrag) = self.authenticated_ufrag(data) else {
                return Ok(());
            };
            let mut rtc = self.config().build(now);
            rtc.add_local_candidate(Candidate::host(self.local, "udp").map_err(|e| e.to_string())?);
            let mut direct = rtc.direct_api();
            direct.set_ice_controlling(false);
            // ICE-lite never sends checks; this password is never used to authenticate a request.
            direct.set_remote_ice_credentials(IceCreds {
                ufrag,
                pass: "unused-remote-password-22".into(),
            });
            // str0m requires a fingerprint even with verification disabled. The browser pins us.
            direct.set_remote_fingerprint(Fingerprint {
                hash_func: "sha-256".into(),
                bytes: self.identity.fingerprint.to_vec(),
            });
            direct.start_dtls(false).map_err(|e| e.to_string())?;
            direct.start_sctp(false);
            self.peers.insert(
                source,
                Peer {
                    rtc,
                    deadline: None,
                    channels: HashMap::new(),
                    opened: 0,
                    closed: 0,
                    #[cfg(test)]
                    generated_get_bytes: 0,
                },
            );
            self.events
                .push_back(json!({"event":"peer-created", "source":source.to_string()}));
        }
        let Ok(receive) = Receive::new(Protocol::Udp, source, self.local, data) else {
            return Ok(());
        };
        let peer = self.peers.get_mut(&source).unwrap();
        let input = Input::Receive(now, receive);
        if peer.rtc.accepts(&input) {
            if let Err(error) = peer.rtc.handle_input(input) {
                self.events.push_back(json!({"event":"peer-error", "source":source.to_string(), "error":error.to_string()}));
                peer.rtc.disconnect();
            }
        }
        Ok(())
    }

    fn config(&self) -> RtcConfig {
        RtcConfig::new()
            .set_crypto_provider(self.provider.clone())
            .set_dtls_cert(self.identity.cert.clone())
            .set_ice_lite(true)
            .set_local_ice_credentials(credentials(&self.identity.fingerprint))
            .set_fingerprint_verification(false)
            .set_sctp_max_buffered_amount(send_budget())
    }

    fn authenticated_ufrag(&self, data: &[u8]) -> Option<String> {
        let message = StunMessage::parse(data).ok()?;
        if !message.is_binding_request() {
            return None;
        }
        let (ours, browser) = message.split_username()?;
        let creds = credentials(&self.identity.fingerprint);
        if ours != creds.ufrag || browser.is_empty() || browser.contains(':') {
            return None;
        }
        message
            .verify(creds.pass.as_bytes(), |key, parts| {
                self.provider.sha1_hmac_provider.sha1_hmac(key, parts)
            })
            .then(|| browser.to_owned())
    }

    /// Supply only elapsed protocol deadlines. No state polling interval is needed.
    pub fn timeout(&mut self, now: Instant) {
        for (source, peer) in &mut self.peers {
            if peer.deadline.is_some_and(|deadline| deadline <= now) {
                if let Err(error) = peer.rtc.handle_input(Input::Timeout(now)) {
                    self.events.push_back(json!({"event":"peer-error", "source":source.to_string(), "error":error.to_string()}));
                    peer.rtc.disconnect();
                }
                peer.deadline = None;
            }
        }
    }

    /// Drain outputs until Timeout, then wait for that deadline or another datagram.
    pub fn poll_output(&mut self) -> EngineOutput {
        if let Some(event) = self.events.pop_front() {
            return EngineOutput::Event(event);
        }
        let peers = self.peers.len();
        for (source, peer) in &mut self.peers {
            if !peer.rtc.is_alive() {
                continue;
            }
            peer.pump();
            loop {
                match peer.rtc.poll_output() {
                    Ok(Output::Transmit(transmit)) => return EngineOutput::Transmit(transmit),
                    Ok(Output::Timeout(deadline)) => {
                        peer.deadline = Some(deadline);
                        break;
                    }
                    Ok(Output::Event(event)) => {
                        if let Some(event) = peer.event(event, peers) {
                            return EngineOutput::Event(
                                json!({"source":source.to_string(), "detail":event}),
                            );
                        }
                        peer.pump();
                    }
                    Err(error) => {
                        peer.rtc.disconnect();
                        return EngineOutput::Event(
                            json!({"event":"peer-error", "source":source.to_string(), "error":error.to_string()}),
                        );
                    }
                }
            }
        }
        self.peers.retain(|source, peer| {
            if peer.rtc.is_alive() { true } else {
                self.events.push_back(json!({"event":"peer-removed", "source":source.to_string(), "open":peer.channels.len(), "openedTotal":peer.opened, "closedTotal":peer.closed}));
                false
            }
        });
        if let Some(event) = self.events.pop_front() {
            return EngineOutput::Event(event);
        }
        EngineOutput::Timeout(self.peers.values().filter_map(|peer| peer.deadline).min())
    }
}

impl Peer {
    fn event(&mut self, event: Event, peers: usize) -> Option<Value> {
        match event {
            Event::ChannelOpen(id, label) => {
                if label != LABEL {
                    self.rtc.direct_api().close_data_channel(id);
                    return Some(
                        json!({"event":"channel-rejected", "channel":format!("{id:?}"), "label":label}),
                    );
                }
                self.channels.insert(
                    id,
                    Channel {
                        first: true,
                        ..Default::default()
                    },
                );
                self.opened += 1;
                self.rtc
                    .channel(id)
                    .unwrap()
                    .set_buffered_amount_low_threshold(low_water());
                Some(json!({"event":"channel-open", "channel":format!("{id:?}")}))
            }
            Event::ChannelClose(id) => {
                if self.channels.remove(&id).is_some() {
                    self.closed += 1;
                }
                Some(json!({"event":"channel-close", "channel":format!("{id:?}")}))
            }
            Event::ChannelData(data) => self.data(data, peers),
            Event::IceConnectionStateChange(state) => {
                if state == IceConnectionState::Disconnected {
                    self.rtc.disconnect();
                }
                Some(json!({"event":"ice-state", "state":format!("{state:?}")}))
            }
            Event::Connected => Some(json!({"event":"connected"})),
            Event::ChannelBufferedAmountLow(_) => None,
            _ => None,
        }
    }

    fn data(&mut self, data: ChannelData, peers: usize) -> Option<Value> {
        let open = self.channels.len();
        if data.data.len() > OUTBOUND_MESSAGE_LIMIT {
            self.rtc.direct_api().close_data_channel(data.id);
            return Some(
                json!({"event":"channel-rejected", "channel":format!("{:?}", data.id), "reason":"message exceeds outbound limit", "bytes":data.data.len()}),
            );
        }
        let Some(channel) = self.channels.get_mut(&data.id) else {
            return None;
        };
        if channel.first {
            channel.first = false;
            if !data.binary {
                if let Ok(value) = serde_json::from_slice::<Value>(&data.data) {
                    match value.get("t").and_then(Value::as_str) {
                        Some("get") => {
                            if let (Some(n), Some(c)) = (
                                value.get("n").and_then(Value::as_u64),
                                value.get("c").and_then(Value::as_u64),
                            ) {
                                if c > 0 && c <= OUTBOUND_MESSAGE_LIMIT as u64 {
                                    channel.get = Some(Get {
                                        n,
                                        sent: 0,
                                        chunk: c as usize,
                                    });
                                    return None;
                                }
                            }
                            let response = json!({"t":"error", "error":"GET requires unsigned n and chunk c in 1..=65536"}).to_string().into_bytes();
                            channel.queued += response.len();
                            channel.echo.push_back((false, response));
                            channel.close_after_send = true;
                            return Some(
                                json!({"event":"channel-rejected", "channel":format!("{:?}", data.id), "reason":"invalid GET chunk"}),
                            );
                        }
                        Some("stats") => {
                            let response = json!({"t":"stats", "peers":peers, "open":open, "openedTotal":self.opened, "closedTotal":self.closed}).to_string().into_bytes();
                            channel.queued += response.len();
                            channel.echo.push_back((false, response));
                            return None;
                        }
                        _ => {}
                    }
                }
            }
        } else if channel.get.is_some() {
            return None;
        }
        // Close an overloaded echo channel rather than accumulate an unbounded application queue.
        if channel.queued.saturating_add(data.data.len()) > MAX_MESSAGE {
            self.rtc.direct_api().close_data_channel(data.id);
            return None;
        }
        channel.queued += data.data.len();
        channel.echo.push_back((data.binary, data.data));
        None
    }

    fn pump(&mut self) {
        // str0m limits the whole association, while buffered_amount() is per channel.
        // Account for that shared budget before generating a chunk that write() would reject.
        let buffered: usize = self
            .channels
            .keys()
            .map(|id| {
                self.rtc
                    .channel(*id)
                    .map_or(0, |mut channel| channel.buffered_amount())
            })
            .sum();
        let mut available = send_budget().saturating_sub(buffered);
        for (id, state) in &mut self.channels {
            let Some(mut channel) = self.rtc.channel(*id) else {
                continue;
            };
            while let Some((binary, bytes)) = state.echo.front() {
                if bytes.len() > available {
                    break;
                }
                match channel.write(*binary, bytes) {
                    Ok(true) => {
                        available -= bytes.len();
                        state.queued -= bytes.len();
                        state.echo.pop_front();
                    }
                    Ok(false) => break,
                    Err(_) => {
                        self.rtc.disconnect();
                        return;
                    }
                }
            }
            if state.close_after_send && state.echo.is_empty() && channel.buffered_amount() == 0 {
                self.rtc.direct_api().close_data_channel(*id);
                state.close_after_send = false;
                continue;
            }
            let Some(get) = state.get.as_mut() else {
                continue;
            };
            while channel.buffered_amount() <= low_water() {
                if get.sent == get.n {
                    let end = json!({"t":"end", "n":get.n}).to_string();
                    if end.len() <= available
                        && channel.write(false, end.as_bytes()).unwrap_or(false)
                    {
                        available -= end.len();
                        state.get = None;
                    }
                    break;
                }
                let len = (get.n - get.sent).min(get.chunk as u64) as usize;
                if len > available {
                    break;
                }
                #[cfg(test)]
                {
                    self.generated_get_bytes += len as u64;
                }
                let bytes: Vec<u8> = (0..len)
                    .map(|i| (get.sent.wrapping_add(i as u64) & 255) as u8)
                    .collect();
                match channel.write(true, &bytes) {
                    Ok(true) => {
                        available -= len;
                        get.sent += len as u64;
                    }
                    Ok(false) => break,
                    Err(_) => {
                        self.rtc.disconnect();
                        return;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;

// Measurement-only roots keep the engine reachable in a cdylib without defining a production ABI.
#[cfg(feature = "rtc-size-probe")]
#[no_mangle]
pub extern "C" fn grc_net_rtc_size_probe() {
    std::hint::black_box(Engine::new as *const ());
    std::hint::black_box(Engine::receive as *const ());
    std::hint::black_box(Engine::timeout as *const ());
    std::hint::black_box(Engine::poll_output as *const ());
    std::hint::black_box(Identity::load_or_create as *const ());
}
