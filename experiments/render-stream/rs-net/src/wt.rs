//! The `wt` carrier: render-stream-wt/1 (carrier-design.md Q4) over wtransport.
//!
//! Threads. The hub's hot calls (send, close, queued bytes) run on the capture's main thread and
//! only touch memory: a message goes into its connection's unbounded channel, counted in
//! `queued`. Everything else runs on a private two-thread tokio runtime: one accept loop, and per
//! session a control task (streams, datagrams, the session's end) and a writer task (the live
//! stream, in hub order, then the close). The writer decrements `queued` once a message is in
//! quinn's send buffer, which is what `queued_bytes` counts (grc_carrier.h).
//!
//! Wire (Q4): the session is an extended CONNECT to `<path>?protocol=<subprotocol>`; every stream
//! starts with a type byte (0x00 live, 0x01 resource, anything else is refused); live messages are
//! `u8 kind, u32le length, bytes`; a resource request is answered `u16le status, u8 coding, u32le
//! length, body`. A host close finishes the live stream and waits (1 s) for its acknowledgement
//! before CLOSE_WEBTRANSPORT_SESSION(code, reason), so the last records are never reset away.

use std::collections::{HashMap, VecDeque};
use std::ffi::c_int;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use tokio::runtime::Runtime;
use tokio::sync::{mpsc, oneshot};
use wtransport::endpoint::endpoint_side::Server;
use wtransport::endpoint::IncomingSession;
use wtransport::error::ConnectionError;
use wtransport::quinn::{TransportConfig, VarInt as QVarInt};
use wtransport::{Connection, Endpoint, RecvStream, SendStream, ServerConfig, VarInt};

use crate::abi::*;
use crate::cert;
use crate::host::{Host, HostBuf};

pub const STREAM_LIVE: u8 = 0x00;
pub const STREAM_RESOURCE: u8 = 0x01;
/// CAR10: a client-opened unidirectional stream carrying one batch of client-to-host messages.
pub const STREAM_UPLINK: u8 = 0x10;
pub const KIND_BINARY: u8 = 0;
pub const KIND_TEXT: u8 = 1;
/// Q4.2: the application error code of a refused stream.
pub const ERR_UNKNOWN_STREAM_TYPE: u32 = 0x01;
pub const MAX_PATH: usize = 1024;
pub const MAX_REASON: usize = 123;
pub const RESOURCE_PREFIX: &str = "/resources/sha256/";
/// Q4.1 (*estimates*).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
pub const KEEP_ALIVE: Duration = Duration::from_secs(5);
/// Q4.5: how long a host close waits for the live stream's data to be acknowledged.
pub const DRAIN_WAIT: Duration = Duration::from_secs(1);
/// Q4.4: concurrent bidirectional streams per session: the CONNECT stream, the live stream and
/// 16 resource streams.
pub const MAX_BIDI_STREAMS: u32 = 1 + 1 + 16;
const STOP_WAIT: Duration = Duration::from_millis(1500);
/// CAR10 uplink streams (Q4.3a): concurrent client unidirectional streams, the largest batch,
/// how many batches may wait for a missing earlier one, and how long one stream may stay open.
pub const MAX_UPLINK_STREAMS: u32 = 64;
pub const MAX_UPLINK_BATCH: usize = 64 * 1024;
pub const MAX_UPLINK_PENDING: usize = 256;
pub const UPLINK_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// WebTransport over HTTP/3 maps an application error code `n` into the HTTP/3 error space
/// (draft-ietf-webtrans-http3, "Resetting Data Streams"); a browser reports `n` back.
pub fn wt_error_to_h3(n: u32) -> u64 {
    0x52e4_a40f_a8db + u64::from(n) + u64::from(n) / 0x1e
}

/// GRC_NET_FAULT: test-only sabotages (carrier-design.md CAR3 "Sabotages").
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Fault {
    None,
    /// Every live message's length is written one too long: a client's framing check fails.
    LenOffByOne,
    /// A host close closes the QUIC connection at once, ahead of what is still queued and without
    /// finishing the live stream: the last records (`end`) are lost.
    NoDrainClose,
    /// send_binary panics (D17 containment).
    PanicSend,
    /// A session task panics once the session is open (D17 containment off the main thread).
    PanicSession,
}

impl Fault {
    pub fn parse(s: &str) -> Result<Self, String> {
        Ok(match s {
            "" => Fault::None,
            "len-off-by-one" => Fault::LenOffByOne,
            "no-drain-close" => Fault::NoDrainClose,
            "panic-send" => Fault::PanicSend,
            "panic-session" => Fault::PanicSession,
            other => return Err(format!("GRC_NET_FAULT {other} is not a net-module sabotage")),
        })
    }
}

pub enum CertMode {
    SelfSigned,
    Consumer { cert: String, key: String },
}

pub struct Config {
    pub listen: SocketAddr,
    pub path: String,
    /// What `?protocol=` may name: the host's subprotocols whose token travels in the hello.
    pub subprotocols: Vec<String>,
    /// TRK3 (tracks-design.md Q7): the host's `track_subprotocols`, offered only when the host's
    /// struct carries `admit_subprotocol`. A session on one is a track session: admitted from the
    /// track pool, no resource streams. Empty with tracks off or a host older than TRK1.
    pub track_subprotocols: Vec<String>,
    pub max_inbound_text: usize,
    pub max_queued_bytes: u64,
    pub cert: CertMode,
    pub evidence_dir: Option<PathBuf>,
    pub fault: Fault,
    /// GRC_NET_DEBUG_STATS_MS (diagnostic, CAR10): every so many ms each session logs its
    /// inbound live counters and QUIC statistics through the host log. 0 (default) is off.
    pub debug_stats_ms: u64,
}

fn split_list(s: &str) -> Vec<String> {
    s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

/// `<host>:<port>`, IPv6 in brackets.
pub fn parse_listen(s: &str) -> Option<SocketAddr> {
    if let Ok(a) = s.parse::<SocketAddr>() {
        return Some(a);
    }
    let (host, port) = s.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    (host, port).to_socket_addrs().ok()?.next()
}

impl Config {
    pub fn from_host(host: &Host) -> Result<Self, String> {
        let wt_listen = host
            .config("wt_listen")
            .ok_or_else(|| "wt-listen-invalid: no wt_listen address".to_string())?;
        let listen = parse_listen(&wt_listen)
            .ok_or_else(|| format!("wt-listen-invalid: {wt_listen} is not <host>:<port>"))?;
        // CAR2 (carrier-design.md D10): the same rule as the capture's rs_expose.cpp, held again
        // here so the module never binds a non-loopback address the host did not expose.
        let expose = host.config("expose").unwrap_or_else(|| "loopback".to_string());
        match expose.as_str() {
            "loopback" | "" => {
                if !listen.ip().is_loopback() {
                    return Err("non-loopback".to_string());
                }
            }
            "lan" => {}
            other => return Err(format!("expose-invalid: expose={other} (loopback or lan)")),
        }
        let path = host.config("path").unwrap_or_else(|| "/render-stream".to_string());
        let offered = split_list(&host.config("subprotocols").unwrap_or_default());
        let hello_token = split_list(&host.config("hello_token_subprotocols").unwrap_or_default());
        let subprotocols: Vec<String> = offered.into_iter().filter(|s| hello_token.contains(s)).collect();
        if subprotocols.is_empty() {
            return Err("carrier-config-invalid: no subprotocol whose token travels in the hello".into());
        }
        let track_subprotocols: Vec<String> = if host.has_admit_subprotocol() {
            split_list(&host.config("track_subprotocols").unwrap_or_default())
                .into_iter()
                .filter(|s| !subprotocols.contains(s))
                .collect()
        } else {
            Vec::new()
        };
        let num = |key: &str, default: u64| -> Result<u64, String> {
            match host.config(key) {
                None => Ok(default),
                Some(v) => v.parse::<u64>().map_err(|_| format!("carrier-config-invalid: {key}={v}")),
            }
        };
        let max_inbound_text = num("max_inbound_text", 4096)? as usize;
        let max_queued_bytes = num("max_queued_bytes", 64 << 20)?;
        let cert = match host.config("wt_cert").as_deref().unwrap_or("self") {
            "self" => CertMode::SelfSigned,
            "tls" => match (host.config("tls_cert"), host.config("tls_key")) {
                (Some(cert), Some(key)) => CertMode::Consumer { cert, key },
                _ => return Err("tls-config-invalid: GRC_LIVE_WT_CERT=tls without a certificate pair".into()),
            },
            other => return Err(format!("tls-config-invalid: GRC_LIVE_WT_CERT={other} (self or tls)")),
        };
        let evidence_dir = host.config("evidence_dir").filter(|d| !d.is_empty()).map(PathBuf::from);
        // GRC_NET_FAULT (test-only); the crate's tests set it per carrier through "net_fault".
        let fault = Fault::parse(
            &host.config("net_fault").unwrap_or_else(|| std::env::var("GRC_NET_FAULT").unwrap_or_default()),
        )?;
        let debug_stats_ms = match host.config("debug_stats_ms").or_else(|| std::env::var("GRC_NET_DEBUG_STATS_MS").ok()) {
            None => 0,
            Some(v) if v.is_empty() => 0,
            Some(v) => v.parse::<u64>().map_err(|_| format!("carrier-config-invalid: GRC_NET_DEBUG_STATS_MS={v}"))?,
        };
        Ok(Self { listen, path, subprotocols, track_subprotocols, max_inbound_text, max_queued_bytes, cert, evidence_dir, fault, debug_stats_ms })
    }
}

enum Out {
    Msg { kind: u8, buf: HostBuf, counted: u64 },
    Close,
}

/// One admitted, opened session.
pub struct Conn {
    local: u32,
    /// A track session (TRK3): its subprotocol is one of `track_subprotocols`.
    track: bool,
    connection: Connection,
    tx: mpsc::UnboundedSender<Out>,
    queued: AtomicU64,
    high: AtomicU64,
    /// A close is queued (by the host or the carrier); later sends return 0.
    closing: AtomicBool,
    /// The code and reason of a close this side started.
    local_close: Mutex<Option<(u16, String)>>,
    closed_reported: AtomicBool,
    live_taken: AtomicBool,
    live_tx: Mutex<Option<oneshot::Sender<SendStream>>>,
    /// Client-to-host live stream: bytes read and text messages handed to the host (CAR10).
    in_bytes: AtomicU64,
    in_texts: AtomicU64,
    /// Host-to-client live messages written into quinn's send buffer.
    out_msgs: AtomicU64,
    /// CAR10: the order in which client-to-host texts reach the host (Q4.3a).
    uplink: Mutex<Uplink>,
}

/// Client-to-host delivery order (Q4.3a). The live stream's first text (the hello) goes first;
/// uplink batches follow in batch order, each exactly once. A batch that arrives early waits.
#[derive(Default)]
struct Uplink {
    hello_seen: bool,
    next: u32,
    pending: std::collections::BTreeMap<u32, Vec<Vec<u8>>>,
    streams: u64,
    duplicates: u64,
}

#[derive(Default)]
pub struct Info {
    pub address: String,
    pub port: i32,
    pub tls: String,
    pub cert_sha256: String,
}

pub struct Shared {
    pub host: Arc<Host>,
    pub cfg: Config,
    conns: Mutex<HashMap<u32, Arc<Conn>>>,
    next_local: AtomicU32,
    pub stopping: AtomicBool,
    pub faulted: AtomicBool,
    pub cert_expired: AtomicBool,
    cert_not_after: Option<SystemTime>,
    pub sessions_refused: AtomicU64,
    pub streams_refused: AtomicU64,
    pub datagrams_dropped: AtomicU64,
    rt: tokio::runtime::Handle,
    endpoint: Mutex<Option<Arc<Endpoint<Server>>>>,
    accept_stop: tokio::sync::Notify,
}

/// Truncates at a UTF-8 boundary to at most `max` bytes.
pub fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut n = max;
    while n > 0 && !s.is_char_boundary(n) {
        n -= 1;
    }
    &s[..n]
}

impl Shared {
    fn alloc_local(&self) -> u32 {
        loop {
            let l = self.next_local.fetch_add(1, Ordering::AcqRel) & GRC_CARRIER_LOCAL_MAX;
            if l == 0 {
                continue;
            }
            if !self.conns.lock().unwrap().contains_key(&l) {
                return l;
            }
        }
    }

    fn conn(&self, local: u32) -> Option<Arc<Conn>> {
        self.conns.lock().unwrap().get(&local).cloned()
    }

    fn report_closed(&self, conn: &Conn, code: u16, reason: &str) {
        if conn.closed_reported.swap(true, Ordering::AcqRel) {
            return;
        }
        self.conns.lock().unwrap().remove(&conn.local);
        self.host.closed(conn.local, code, truncate_utf8(reason, MAX_REASON));
    }

    /// Starts a close of `conn` (host or carrier initiated); the writer does the rest in order.
    fn close_conn(&self, conn: &Conn, code: u16, reason: &str) {
        if conn.closing.swap(true, Ordering::AcqRel) {
            return;
        }
        *conn.local_close.lock().unwrap() = Some((code, truncate_utf8(reason, MAX_REASON).to_string()));
        if self.cfg.fault == Fault::NoDrainClose {
            // The sabotage: close the session at once, ahead of everything still queued.
            conn.connection.close(VarInt::from_u32(u32::from(code)), reason.as_bytes());
            return;
        }
        let _ = conn.tx.send(Out::Close);
    }

    // ------------------------------------------------------------------ hot calls (main thread)

    pub fn send(&self, local: u32, kind: u8, buf: HostBuf) -> bool {
        if self.cfg.fault == Fault::PanicSend && kind == KIND_BINARY {
            panic!("GRC_NET_FAULT=panic-send");
        }
        if self.faulted.load(Ordering::Acquire) {
            return false;
        }
        let Some(conn) = self.conn(local) else { return false };
        if conn.closing.load(Ordering::Acquire) {
            return false;
        }
        let counted = buf.len() as u64 + 5;
        let queued = conn.queued.load(Ordering::Acquire);
        if queued + counted > self.cfg.max_queued_bytes {
            drop(buf);
            self.close_conn(&conn, 1008, "send queue over max_queued_bytes");
            return false;
        }
        let now = conn.queued.fetch_add(counted, Ordering::AcqRel) + counted;
        conn.high.fetch_max(now, Ordering::AcqRel);
        if conn.tx.send(Out::Msg { kind, buf, counted }).is_err() {
            conn.queued.fetch_sub(counted, Ordering::AcqRel);
            return false;
        }
        true
    }

    pub fn close(&self, local: u32, code: u16, reason: &str) {
        if let Some(conn) = self.conn(local) {
            self.close_conn(&conn, code, reason);
        }
    }

    pub fn queued_bytes(&self, local: u32) -> u64 {
        self.conn(local).map(|c| c.queued.load(Ordering::Acquire)).unwrap_or(0)
    }

    pub fn max_queued_bytes(&self, local: u32) -> u64 {
        self.conn(local).map(|c| c.high.load(Ordering::Acquire)).unwrap_or(0)
    }

    // ------------------------------------------------------------------ faults (D17)

    /// Stops the carrier after a panic: no new sessions, every open connection reported closed
    /// with 1011 and its QUIC connection closed. Idempotent; any thread.
    pub fn fault(&self, what: &str) {
        if self.faulted.swap(true, Ordering::AcqRel) {
            return;
        }
        self.stopping.store(true, Ordering::Release);
        self.host.log(GRC_LOG_ERROR, &format!("wt: carrier-fault: {what}; the carrier stops"));
        // New sessions are answered 503 (run_session checks `stopping`).
        let conns: Vec<Arc<Conn>> = self.conns.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
        for c in conns {
            c.closing.store(true, Ordering::Release);
            *c.local_close.lock().unwrap_or_else(|e| e.into_inner()) = Some((1011, "carrier-fault".into()));
            self.report_closed(&c, 1011, "carrier-fault");
            c.connection.close(VarInt::from_u32(0), b"carrier-fault");
        }
    }

    pub fn cert_expired_now(&self) -> bool {
        if let Some(t) = self.cert_not_after {
            if SystemTime::now() >= t {
                self.cert_expired.store(true, Ordering::Release);
                return true;
            }
        }
        false
    }

    fn spawn_guarded<F>(self: &Arc<Self>, fut: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let h = self.rt.spawn(fut);
        let me = self.clone();
        self.rt.spawn(async move {
            if let Err(e) = h.await {
                if e.is_panic() {
                    me.fault("a session task panicked");
                }
            }
        });
    }
}

/// A started carrier: the runtime and the state its tasks share.
pub struct Running {
    pub shared: Arc<Shared>,
    rt: Option<Runtime>,
    pub info: Info,
}

impl Running {
    pub fn start(host: Arc<Host>) -> Result<Self, String> {
        let cfg = Config::from_host(&host)?;
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("grc-net-wt")
            .enable_all()
            .build()
            .map_err(|e| format!("carrier-start-failed: runtime: {e}"))?;
        let cert = match &cfg.cert {
            CertMode::SelfSigned => cert::self_signed(cfg.listen.ip())?,
            CertMode::Consumer { cert, key } => rt.block_on(cert::consumer(cert, key))?,
        };
        let mut transport = TransportConfig::default();
        transport
            .max_concurrent_bidi_streams(QVarInt::from_u32(MAX_BIDI_STREAMS))
            .max_concurrent_uni_streams(QVarInt::from_u32(MAX_UPLINK_STREAMS))
            .max_idle_timeout(Some(IDLE_TIMEOUT.try_into().expect("30 s is a valid idle timeout")))
            .keep_alive_interval(Some(KEEP_ALIVE));
        let server_config = ServerConfig::builder()
            .with_bind_address(cfg.listen)
            .with_custom_transport(cert.identity, transport)
            .build();
        let endpoint = rt
            .block_on(async { Endpoint::server(server_config) })
            .map_err(|e| format!("wt-bind-failed: {}: {e}", cfg.listen))?;
        let endpoint = Arc::new(endpoint);
        let bound = endpoint.local_addr().map_err(|e| format!("wt-bind-failed: {e}"))?;
        if let Some(dir) = &cfg.evidence_dir {
            let path = dir.join("live-cert-sha256");
            std::fs::write(&path, format!("{}\n", cert.sha256))
                .map_err(|e| format!("carrier-start-failed: cannot write {}: {e}", path.display()))?;
        }
        let info = Info {
            address: bound.ip().to_string(),
            port: i32::from(bound.port()),
            tls: cert.tls.to_string(),
            cert_sha256: cert.sha256.clone(),
        };
        let shared = Arc::new(Shared {
            host,
            cfg,
            conns: Mutex::new(HashMap::new()),
            next_local: AtomicU32::new(1),
            stopping: AtomicBool::new(false),
            faulted: AtomicBool::new(false),
            cert_expired: AtomicBool::new(false),
            cert_not_after: cert.not_after,
            sessions_refused: AtomicU64::new(0),
            streams_refused: AtomicU64::new(0),
            datagrams_dropped: AtomicU64::new(0),
            rt: rt.handle().clone(),
            endpoint: Mutex::new(Some(endpoint.clone())),
            accept_stop: tokio::sync::Notify::new(),
        });
        shared.host.log(
            GRC_LOG_INFO,
            &format!(
                "wt: listening udp {bound} path {} tls {} cert-sha256 {}",
                shared.cfg.path, info.tls, info.cert_sha256
            ),
        );
        if shared.cfg.fault != Fault::None {
            shared.host.log(GRC_LOG_WARN, &format!("wt: sabotage GRC_NET_FAULT={:?}", shared.cfg.fault));
        }
        let me = shared.clone();
        rt.spawn(accept_loop(me, endpoint));
        Ok(Self { shared, rt: Some(rt), info })
    }

    /// Closes every connection (1001 unless the hub already closed it), waits a bounded time for
    /// the writers to drain, then drops the runtime (and with it every task and host buffer).
    pub fn stop(&mut self) {
        let s = self.shared.clone();
        s.stopping.store(true, Ordering::Release);
        let conns: Vec<Arc<Conn>> = s.conns.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
        for c in &conns {
            s.close_conn(c, 1001, "carrier stopping");
        }
        let deadline = Instant::now() + STOP_WAIT;
        while Instant::now() < deadline && !s.conns.lock().unwrap_or_else(|e| e.into_inner()).is_empty() {
            std::thread::sleep(Duration::from_millis(5));
        }
        s.accept_stop.notify_one();
        if let Some(ep) = s.endpoint.lock().unwrap_or_else(|e| e.into_inner()).take() {
            ep.close(VarInt::from_u32(0), b"stopping");
        }
        if let Some(rt) = self.rt.take() {
            rt.shutdown_timeout(Duration::from_millis(250));
        }
        let rest: Vec<Arc<Conn>> = s.conns.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
        for c in rest {
            s.report_closed(&c, 1006, "carrier stopped");
        }
        s.conns.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(rt) = self.rt.take() {
            rt.shutdown_background();
        }
    }
}

async fn accept_loop(shared: Arc<Shared>, endpoint: Arc<Endpoint<Server>>) {
    loop {
        // wtransport panics in accept() once the endpoint is closed: stop() ends this loop first.
        let incoming = tokio::select! {
            biased;
            () = shared.accept_stop.notified() => return,
            i = endpoint.accept() => i,
        };
        let me = shared.clone();
        shared.spawn_guarded(run_session(me, incoming));
    }
}

/// `?protocol=` from a request path's query.
fn query_protocol(query: &str) -> Option<String> {
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == "protocol" {
            return Some(percent_decode(v));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `WT-Available-Protocols` (an sf-list of sf-strings, F1), or None when absent.
fn available_protocols(headers: &HashMap<String, String>) -> Option<Vec<String>> {
    let v = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("wt-available-protocols"))?.1;
    Some(
        v.split(',')
            .map(|p| p.split(';').next().unwrap_or("").trim().trim_matches('"').to_string())
            .filter(|p| !p.is_empty())
            .collect(),
    )
}

async fn run_session(shared: Arc<Shared>, incoming: IncomingSession) {
    let Ok(req) = incoming.await else { return };
    let refuse = |shared: &Shared| {
        shared.sessions_refused.fetch_add(1, Ordering::AcqRel);
    };
    if shared.stopping.load(Ordering::Acquire) || shared.cert_expired_now() {
        refuse(&shared);
        req.reject_with_status(503).await;
        return;
    }
    // Q4.1 checks, in order: Origin, path, subprotocol, admission.
    let origin = req.origin().map(str::to_owned);
    if let Some(o) = origin.as_deref() {
        if !o.is_empty() && !shared.host.origin_ok(o) {
            refuse(&shared);
            let local = shared.alloc_local();
            shared.host.rejected(local, GRC_REJECT_ORIGIN, o);
            req.forbidden().await;
            return;
        }
    }
    let full = req.path().to_string();
    let (path, query) = full.split_once('?').unwrap_or((full.as_str(), ""));
    if path != shared.cfg.path {
        refuse(&shared);
        req.not_found().await;
        return;
    }
    let protocol = match query_protocol(query) {
        Some(p) if shared.cfg.subprotocols.contains(&p) || shared.cfg.track_subprotocols.contains(&p) => p,
        _ => {
            refuse(&shared);
            req.reject_with_status(400).await;
            return;
        }
    };
    let negotiated = available_protocols(req.headers());
    if let Some(list) = &negotiated {
        if !list.contains(&protocol) {
            refuse(&shared);
            req.reject_with_status(400).await;
            return;
        }
    }
    let local = shared.alloc_local();
    // A view subprotocol is admitted exactly as before TRK3 (admit); a track one from the track
    // pool. The view list wins when a name is in both (Config::from_host removes the overlap).
    let track = shared.cfg.track_subprotocols.contains(&protocol);
    let admitted = if track { shared.host.admit_subprotocol(local, &protocol) } else { shared.host.admit(local) };
    if !admitted {
        refuse(&shared);
        shared.host.rejected(local, GRC_REJECT_CAPACITY, "");
        req.reject_with_status(503).await;
        return;
    }
    let headers: Vec<(String, String)> = match negotiated {
        Some(_) => vec![("wt-protocol".to_string(), format!("\"{protocol}\""))],
        None => Vec::new(),
    };
    let connection = match req.accept_with_headers(headers).await {
        Ok(c) => c,
        Err(_) => {
            // Admitted, never opened: the slot returns with a capacity rejection (no hub event).
            shared.host.rejected(local, GRC_REJECT_CAPACITY, "");
            return;
        }
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let (live_tx, live_rx) = oneshot::channel();
    let conn = Arc::new(Conn {
        local,
        track,
        connection: connection.clone(),
        tx,
        queued: AtomicU64::new(0),
        high: AtomicU64::new(0),
        closing: AtomicBool::new(false),
        local_close: Mutex::new(None),
        closed_reported: AtomicBool::new(false),
        live_taken: AtomicBool::new(false),
        live_tx: Mutex::new(Some(live_tx)),
        in_bytes: AtomicU64::new(0),
        in_texts: AtomicU64::new(0),
        out_msgs: AtomicU64::new(0),
        uplink: Mutex::new(Uplink::default()),
    });
    shared.conns.lock().unwrap().insert(local, conn.clone());
    shared.host.opened(local, &protocol, origin.as_deref().filter(|o| !o.is_empty()));
    if shared.cfg.fault == Fault::PanicSession {
        panic!("GRC_NET_FAULT=panic-session");
    }
    let me = shared.clone();
    let c2 = conn.clone();
    shared.spawn_guarded(writer(me, c2, rx, live_rx));
    if shared.cfg.debug_stats_ms > 0 {
        let (s, c) = (shared.clone(), conn.clone());
        shared.rt.spawn(debug_stats(s, c));
    }
    control(shared, conn, connection).await;
}

/// The session's streams, datagrams and end.
async fn control(shared: Arc<Shared>, conn: Arc<Conn>, connection: Connection) {
    let end: ConnectionError = loop {
        tokio::select! {
            bi = connection.accept_bi() => match bi {
                Ok((send, recv)) => {
                    let (s, c) = (shared.clone(), conn.clone());
                    shared.spawn_guarded(dispatch(s, c, send, recv));
                }
                Err(e) => break e,
            },
            uni = connection.accept_uni() => match uni {
                Ok(recv) => {
                    let (s, c) = (shared.clone(), conn.clone());
                    shared.spawn_guarded(uplink_stream(s, c, recv));
                }
                Err(e) => break e,
            },
            dg = connection.receive_datagram() => match dg {
                Ok(_) => {
                    shared.datagrams_dropped.fetch_add(1, Ordering::AcqRel);
                }
                Err(e) => break e,
            },
        }
    };
    let local_close = conn.local_close.lock().unwrap().clone();
    let (code, reason) = match local_close {
        Some(c) => c,
        None => {
            let session = tokio::time::timeout(Duration::from_secs(2), connection.session_closed()).await.ok().flatten();
            close_info(session, &end)
        }
    };
    conn.closing.store(true, Ordering::Release);
    shared.report_closed(&conn, code, &reason);
}

/// Q4.5: how a session's end that this side did not start is reported: the capsule's code (0 is
/// 1005, a code past u16 is 1002), else 1006 (a transport error or the idle timeout).
pub fn close_info(session: Option<(u32, Box<[u8]>)>, end: &ConnectionError) -> (u16, String) {
    match session {
        Some((code, reason)) => {
            let reason = String::from_utf8_lossy(&reason).into_owned();
            let code = match code {
                0 => 1005,
                c if c <= u32::from(u16::MAX) => c as u16,
                _ => 1002,
            };
            (code, truncate_utf8(&reason, MAX_REASON).to_string())
        }
        None => (1006, truncate_utf8(&end.to_string(), MAX_REASON).to_string()),
    }
}

async fn dispatch(shared: Arc<Shared>, conn: Arc<Conn>, mut send: SendStream, mut recv: RecvStream) {
    let mut t = [0u8; 1];
    if recv.read_exact(&mut t).await.is_err() {
        return;
    }
    match t[0] {
        STREAM_LIVE => {
            if conn.live_taken.swap(true, Ordering::AcqRel) {
                shared.close_conn(&conn, 1008, "second-live-stream");
                return;
            }
            if let Some(tx) = conn.live_tx.lock().unwrap().take() {
                let _ = tx.send(send);
            }
            live_reader(shared, conn, recv).await;
        }
        // TRK3: a track session serves no resources; the type is refused like an unknown one.
        STREAM_RESOURCE if !conn.track => resource(shared, conn, send, recv).await,
        _ => {
            shared.streams_refused.fetch_add(1, Ordering::AcqRel);
            let code = VarInt::try_from_u64(wt_error_to_h3(ERR_UNKNOWN_STREAM_TYPE)).unwrap_or(VarInt::from_u32(0));
            let _ = send.reset(code);
            recv.stop(code);
        }
    }
}

/// Splits `buf` into complete client-to-host messages (Q4.3: text only, within
/// max_inbound_text, valid UTF-8). Returns the bodies' ranges and the bytes consumed, or the close
/// a violation calls for.
fn parse_client_frames(shared: &Shared, buf: &[u8]) -> Result<(Vec<std::ops::Range<usize>>, usize), (u16, &'static str)> {
    let mut out = Vec::new();
    let mut at = 0;
    while buf.len() - at >= 5 {
        let kind = buf[at];
        let len = u32::from_le_bytes([buf[at + 1], buf[at + 2], buf[at + 3], buf[at + 4]]) as usize;
        match kind {
            KIND_TEXT if len > shared.cfg.max_inbound_text => return Err((1009, "text message too large")),
            KIND_TEXT => {}
            KIND_BINARY => return Err((1003, "binary message from the client")),
            _ => return Err((1002, "unknown message kind")),
        }
        if buf.len() - at < 5 + len {
            break;
        }
        if std::str::from_utf8(&buf[at + 5..at + 5 + len]).is_err() {
            return Err((1007, "text message is not UTF-8"));
        }
        out.push(at + 5..at + 5 + len);
        at += 5 + len;
    }
    Ok((out, at))
}

/// Hands texts to the host in Q4.3a's order: called with the live stream's texts (`batch` None)
/// and with each complete uplink batch. Returns false once the connection is closing.
fn deliver(shared: &Shared, conn: &Conn, batch: Option<u32>, texts: Vec<Vec<u8>>) -> bool {
    let mut up = conn.uplink.lock().unwrap();
    if conn.closed_reported.load(Ordering::Acquire) || conn.closing.load(Ordering::Acquire) {
        return false;
    }
    match batch {
        None => {
            for t in &texts {
                shared.host.text(conn.local, t);
                conn.in_texts.fetch_add(1, Ordering::AcqRel);
            }
            if !texts.is_empty() {
                up.hello_seen = true;
            }
        }
        Some(n) => {
            up.streams += 1;
            if n < up.next || up.pending.contains_key(&n) {
                up.duplicates += 1; // a re-sent batch whose first copy arrived after all
                return true;
            }
            if up.pending.len() >= MAX_UPLINK_PENDING {
                drop(up);
                shared.close_conn(conn, 1008, "uplink-reorder-overflow");
                return false;
            }
            up.pending.insert(n, texts);
        }
    }
    if up.hello_seen {
        loop {
            let next = up.next;
            let Some(texts) = up.pending.remove(&next) else { break };
            for t in &texts {
                shared.host.text(conn.local, t);
                conn.in_texts.fetch_add(1, Ordering::AcqRel);
            }
            up.next = next.wrapping_add(1);
        }
    }
    true
}

/// Client-to-host live messages on the live stream (Q4.3).
async fn live_reader(shared: Arc<Shared>, conn: Arc<Conn>, mut recv: RecvStream) {
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        let n = match recv.read(&mut chunk).await {
            Ok(Some(n)) => n,
            Ok(None) | Err(_) => return, // FIN (the client is closing) or the session ended
        };
        conn.in_bytes.fetch_add(n as u64, Ordering::AcqRel);
        buf.extend_from_slice(&chunk[..n]);
        let (bodies, used) = match parse_client_frames(&shared, &buf) {
            Ok(v) => v,
            Err((code, reason)) => {
                shared.close_conn(&conn, code, reason);
                return;
            }
        };
        let texts = bodies.into_iter().map(|r| buf[r].to_vec()).collect();
        if !deliver(&shared, &conn, None, texts) {
            return;
        }
        buf.drain(..used);
    }
}

/// CAR10 (Q4.3a): one client unidirectional stream. Type 0x10 is an uplink batch: `u32le batch`,
/// then messages framed as on the live stream, to FIN. Read whole (at most MAX_UPLINK_BATCH,
/// within UPLINK_READ_TIMEOUT), then delivered in batch order. A stream reset before its FIN is
/// dropped: the client sends the batch again. Any other type is refused as before (Q4.2).
async fn uplink_stream(shared: Arc<Shared>, conn: Arc<Conn>, mut recv: RecvStream) {
    let refuse = |recv: RecvStream| {
        shared.streams_refused.fetch_add(1, Ordering::AcqRel);
        let code = VarInt::try_from_u64(wt_error_to_h3(ERR_UNKNOWN_STREAM_TYPE)).unwrap_or(VarInt::from_u32(0));
        recv.stop(code);
    };
    let read = async {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 16 * 1024];
        loop {
            match recv.read(&mut chunk).await {
                Ok(Some(n)) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.first().is_some_and(|t| *t != STREAM_UPLINK) {
                        return Err(Bad::Type);
                    }
                    if buf.len() > 5 + MAX_UPLINK_BATCH {
                        return Err(Bad::TooLarge);
                    }
                }
                Ok(None) => return Ok(buf),
                Err(_) => return Err(Bad::Gone), // reset, or the session ended
            }
        }
    };
    enum Bad {
        Type,
        TooLarge,
        Gone,
    }
    let buf = match tokio::time::timeout(UPLINK_READ_TIMEOUT, read).await {
        Ok(Ok(b)) => b,
        Ok(Err(Bad::Type)) => return refuse(recv),
        Ok(Err(Bad::TooLarge)) => {
            shared.close_conn(&conn, 1009, "uplink batch too large");
            return;
        }
        _ => return,
    };
    if buf.is_empty() {
        return refuse(recv);
    }
    if buf.len() < 5 {
        shared.close_conn(&conn, 1002, "uplink batch header truncated");
        return;
    }
    conn.in_bytes.fetch_add(buf.len() as u64, Ordering::AcqRel);
    let batch = u32::from_le_bytes([buf[1], buf[2], buf[3], buf[4]]);
    let body = &buf[5..];
    let (bodies, used) = match parse_client_frames(&shared, body) {
        Ok(v) => v,
        Err((code, reason)) => {
            shared.close_conn(&conn, code, reason);
            return;
        }
    };
    if used != body.len() {
        shared.close_conn(&conn, 1002, "uplink batch ends inside a message");
        return;
    }
    let texts = bodies.into_iter().map(|r| body[r].to_vec()).collect();
    deliver(&shared, &conn, Some(batch), texts);
}

/// Host-to-client: the live stream, in the hub's order, then the close.
async fn writer(
    shared: Arc<Shared>,
    conn: Arc<Conn>,
    mut rx: mpsc::UnboundedReceiver<Out>,
    live_rx: oneshot::Receiver<SendStream>,
) {
    let mut pending: VecDeque<Out> = VecDeque::new();
    let mut live_rx = Some(live_rx);
    let mut live: Option<SendStream> = None;
    // Before the client opens the live stream, messages wait here (still counted in `queued`).
    while live.is_none() {
        tokio::select! {
            s = async { live_rx.as_mut().unwrap().await }, if live_rx.is_some() => {
                live_rx = None;
                match s {
                    Ok(s) => live = Some(s),
                    Err(_) => break, // the session ended before a live stream
                }
            }
            m = rx.recv() => match m {
                None => return,
                Some(Out::Close) => {
                    discard(&conn, pending);
                    finish_close(&conn, None).await;
                    return;
                }
                Some(m) => pending.push_back(m),
            },
        }
    }
    let Some(mut stream) = live else {
        discard(&conn, pending);
        return;
    };
    let mut broken = false;
    loop {
        let m = match pending.pop_front() {
            Some(m) => m,
            None => match rx.recv().await {
                Some(m) => m,
                None => return,
            },
        };
        match m {
            Out::Msg { kind, buf, counted } => {
                if !broken {
                    let len = buf.len() as u32 + u32::from(shared.cfg.fault == Fault::LenOffByOne);
                    let mut head = [0u8; 5];
                    head[0] = kind;
                    head[1..5].copy_from_slice(&len.to_le_bytes());
                    if stream.write_all(&head).await.is_err() || stream.write_all(buf.bytes()).await.is_err() {
                        broken = true; // the session is ending; control() reports it
                    } else {
                        conn.out_msgs.fetch_add(1, Ordering::AcqRel);
                    }
                }
                conn.queued.fetch_sub(counted, Ordering::AcqRel);
                drop(buf);
            }
            Out::Close => {
                finish_close(&conn, Some(stream)).await;
                return;
            }
        }
    }
}

/// GRC_NET_DEBUG_STATS_MS: one line per period while the session lives.
async fn debug_stats(shared: Arc<Shared>, conn: Arc<Conn>) {
    let period = Duration::from_millis(shared.cfg.debug_stats_ms);
    while !conn.closed_reported.load(Ordering::Acquire) {
        tokio::time::sleep(period).await;
        let q = conn.connection.quic_connection().stats();
        let (up_streams, up_dups, up_next) = {
            let u = conn.uplink.lock().unwrap();
            (u.streams, u.duplicates, u.next)
        };
        shared.host.log(
            GRC_LOG_INFO,
            &format!(
                "wt: stats conn={} in_bytes={} in_texts={} out_msgs={} queued={} rtt_us={} cwnd={} lost_pkts={} \
                 udp_rx={} udp_tx={} rx_stream={} rx_max_stream_data={} rx_max_data={} rx_stream_data_blocked={} \
                 rx_data_blocked={} tx_max_stream_data={} tx_max_data={} tx_acks={} rx_acks={} tx_stream={} \
                 remote={} rx_path_challenge={} tx_path_challenge={} rx_new_cid={} rx_retire_cid={} rx_ping={} tx_ping={} \
                 uplink_streams={} uplink_duplicates={} uplink_next={}",
                conn.local,
                conn.in_bytes.load(Ordering::Acquire),
                conn.in_texts.load(Ordering::Acquire),
                conn.out_msgs.load(Ordering::Acquire),
                conn.queued.load(Ordering::Acquire),
                q.path.rtt.as_micros(),
                q.path.cwnd,
                q.path.lost_packets,
                q.udp_rx.datagrams,
                q.udp_tx.datagrams,
                q.frame_rx.stream,
                q.frame_rx.max_stream_data,
                q.frame_rx.max_data,
                q.frame_rx.stream_data_blocked,
                q.frame_rx.data_blocked,
                q.frame_tx.max_stream_data,
                q.frame_tx.max_data,
                q.frame_tx.acks,
                q.frame_rx.acks,
                q.frame_tx.stream,
                conn.connection.remote_address(),
                q.frame_rx.path_challenge,
                q.frame_tx.path_challenge,
                q.frame_rx.new_connection_id,
                q.frame_rx.retire_connection_id,
                q.frame_rx.ping,
                q.frame_tx.ping,
                up_streams,
                up_dups,
                up_next,
            ),
        );
    }
}

fn discard(conn: &Conn, pending: VecDeque<Out>) {
    for m in pending {
        if let Out::Msg { counted, .. } = m {
            conn.queued.fetch_sub(counted, Ordering::AcqRel);
        }
    }
}

/// Q4.5: finish the live stream, wait (bounded) for its acknowledgement, then
/// CLOSE_WEBTRANSPORT_SESSION(code, reason); the QUIC connection closes once that is acknowledged.
async fn finish_close(conn: &Conn, live: Option<SendStream>) {
    let (code, reason) = conn.local_close.lock().unwrap().clone().unwrap_or((1000, String::new()));
    if let Some(mut s) = live {
        let _ = tokio::time::timeout(DRAIN_WAIT, s.finish()).await;
    }
    conn.connection.close_session(u32::from(code), reason.as_bytes());
    if tokio::time::timeout(DRAIN_WAIT, conn.connection.closed()).await.is_err() {
        conn.connection.close(VarInt::from_u32(0), reason.as_bytes());
    }
}

// ---------------------------------------------------------------------- resource streams (Q4.4)

pub fn is_hex64(b: &[u8]) -> bool {
    b.len() == 64 && b.iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}

/// A parsed resource request: (accept bits, hash, token).
pub fn parse_resource_request(b: &[u8]) -> Result<(u8, [u8; 64], Vec<u8>), &'static str> {
    if b.len() < 4 {
        return Err("short request");
    }
    let accept = b[0];
    let path_len = u16::from_le_bytes([b[1], b[2]]) as usize;
    if path_len > MAX_PATH || b.len() < 3 + path_len + 1 {
        return Err("bad path length");
    }
    let path = &b[3..3 + path_len];
    let token_len = b[3 + path_len] as usize;
    if token_len != 0 && token_len != 64 {
        return Err("bad token length");
    }
    if b.len() != 3 + path_len + 1 + token_len {
        return Err("bad request length");
    }
    let token = &b[4 + path_len..];
    if token_len == 64 && !is_hex64(token) {
        return Err("token is not 64 lowercase hex");
    }
    let hash = path.strip_prefix(RESOURCE_PREFIX.as_bytes()).ok_or("bad path")?;
    if !is_hex64(hash) {
        return Err("bad path");
    }
    let mut h = [0u8; 64];
    h.copy_from_slice(hash);
    Ok((accept, h, token.to_vec()))
}

async fn resource(shared: Arc<Shared>, conn: Arc<Conn>, mut send: SendStream, mut recv: RecvStream) {
    // The request after the type byte, up to FIN (at most 1 + 2 + 1024 + 1 + 64 bytes).
    const MAX_REQ: usize = 1 + 2 + MAX_PATH + 1 + 64;
    let mut req = Vec::with_capacity(160);
    let mut chunk = [0u8; 2048];
    let mut too_long = false;
    loop {
        match tokio::time::timeout(Duration::from_secs(10), recv.read(&mut chunk)).await {
            Ok(Ok(Some(n))) => {
                req.extend_from_slice(&chunk[..n]);
                if req.len() > MAX_REQ {
                    too_long = true;
                    break;
                }
            }
            Ok(Ok(None)) => break,
            _ => return,
        }
    }
    let local = conn.local;
    let (status, coding, body, identity_len, hash) = if shared.stopping.load(Ordering::Acquire) {
        (503u16, GRC_CODING_IDENTITY, None, 0u64, None)
    } else {
        match if too_long { Err("request too long") } else { parse_resource_request(&req) } {
            Err(_) => (400, GRC_CODING_IDENTITY, None, 0, None),
            Ok((accept, hash, token)) => {
                if !shared.host.token_ok(&token) {
                    (401, GRC_CODING_IDENTITY, None, 0, Some(hash))
                } else {
                    let identity = shared.host.lookup(&hash, GRC_CODING_IDENTITY);
                    match identity {
                        None => (404, GRC_CODING_IDENTITY, None, 0, Some(hash)),
                        Some(id) => {
                            let id_len = id.len() as u64;
                            let coded = if accept & 2 != 0 {
                                shared.host.lookup(&hash, GRC_CODING_ZSTD).map(|b| (GRC_CODING_ZSTD, b))
                            } else {
                                None
                            }
                            .or_else(|| {
                                if accept & 1 != 0 {
                                    shared.host.lookup(&hash, GRC_CODING_GZIP).map(|b| (GRC_CODING_GZIP, b))
                                } else {
                                    None
                                }
                            });
                            match coded {
                                Some((c, b)) => (200, c, Some(b), id_len, Some(hash)),
                                None => (200, GRC_CODING_IDENTITY, Some(id), id_len, Some(hash)),
                            }
                        }
                    }
                }
            }
        }
    };
    let wire = body.as_ref().map(|b| b.len() as u64).unwrap_or(0);
    let mut head = [0u8; 7];
    head[0..2].copy_from_slice(&status.to_le_bytes());
    head[2] = coding as u8;
    head[3..7].copy_from_slice(&(wire as u32).to_le_bytes());
    let ok = send.write_all(&head).await.is_ok()
        && match &body {
            Some(b) => send.write_all(b.bytes()).await.is_ok(),
            None => true,
        };
    drop(body);
    // Reported once written and before the FIN, so a client's sequential GETs are reported in order.
    if let Some(h) = hash {
        shared.host.resource_served(local, &h, status, coding, if status == 200 { identity_len } else { 0 }, wire);
    }
    if ok {
        let _ = tokio::time::timeout(Duration::from_secs(10), send.finish()).await;
    }
}

/// For tests and wt_info: a ready-made c_int coding name.
pub fn coding_name(c: c_int) -> &'static str {
    match c {
        GRC_CODING_GZIP => "gzip",
        GRC_CODING_ZSTD => "zstd",
        _ => "identity",
    }
}
