//! The `wt` carrier against an in-crate fake host, driven through the module's C ABI exactly as
//! the capture drives it (grc_net_module_v1 -> wt_create -> grc_carrier_v1), with a wtransport
//! client on the other side.

use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use render_stream_net::abi::*;
use render_stream_net::wt::wt_error_to_h3;
use wtransport::endpoint::ConnectOptions;
use wtransport::error::{ConnectingError, StreamReadError};
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Connection, Endpoint, RecvStream, SendStream};

const TOKEN: &str = "abababababababababababababababababababababababababababababababab";
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SP: &str = "render-stream.13";

// ------------------------------------------------------------------------------ fake host

#[derive(Clone, Debug, PartialEq)]
enum Ev {
    Opened { local: u32, sp: String, origin: String },
    Text { local: u32, text: String },
    Closed { local: u32, code: u16, reason: String },
    Rejected { local: u32, why: c_int, detail: String },
    Served { hash: String, status: u16, coding: c_int, identity: u64, wire: u64 },
}

struct Fake {
    config: HashMap<String, CString>,
    token: String,
    origins: Vec<String>,
    cap: usize,
    /// TRK3: the track pool's cap (admit_subprotocol on a track subprotocol).
    track_cap: usize,
    track_slots: Mutex<HashSet<u32>>,
    /// Every admission the carrier asked for: (local, None) is admit(), (local, Some(sp)) is
    /// admit_subprotocol().
    admits: Mutex<Vec<(u32, Option<String>)>>,
    resources: HashMap<String, (Arc<Vec<u8>>, Option<Arc<Vec<u8>>>)>,
    events: Mutex<Vec<Ev>>,
    slots: Mutex<HashSet<u32>>,
    outstanding: AtomicI64,
    logs: Mutex<Vec<String>>,
}

enum Owner {
    Msg(#[allow(dead_code)] Vec<u8>),
    Body(#[allow(dead_code)] Arc<Vec<u8>>),
}

fn fake(h: *mut c_void) -> &'static Fake {
    unsafe { &*(h as *const Fake) }
}
fn s(p: *const c_char, n: usize) -> String {
    if p.is_null() || n == 0 {
        String::new()
    } else {
        String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(p as *const u8, n) }).into_owned()
    }
}

unsafe extern "C" fn h_config(h: *mut c_void, key: *const c_char) -> *const c_char {
    let k = CStr::from_ptr(key).to_string_lossy();
    fake(h).config.get(k.as_ref()).map(|v| v.as_ptr()).unwrap_or(std::ptr::null())
}
unsafe extern "C" fn h_admit(h: *mut c_void, local: u32) -> c_int {
    let f = fake(h);
    f.admits.lock().unwrap().push((local, None));
    let mut slots = f.slots.lock().unwrap();
    if slots.len() >= f.cap {
        return 0;
    }
    slots.insert(local);
    1
}
unsafe extern "C" fn h_admit_subprotocol(h: *mut c_void, local: u32, sp: *const c_char, n: usize) -> c_int {
    let f = fake(h);
    let sp = s(sp, n);
    f.admits.lock().unwrap().push((local, Some(sp.clone())));
    let track = f.config.get("track_subprotocols").is_some_and(|l| l.to_str().unwrap().split(',').any(|x| x == sp));
    let (pool, cap) = if track { (&f.track_slots, f.track_cap) } else { (&f.slots, f.cap) };
    let mut pool = pool.lock().unwrap();
    if pool.len() >= cap {
        return 0;
    }
    pool.insert(local);
    1
}
unsafe extern "C" fn h_opened(h: *mut c_void, local: u32, sp: *const c_char, spn: usize, o: *const c_char, on: usize) {
    fake(h).events.lock().unwrap().push(Ev::Opened { local, sp: s(sp, spn), origin: s(o, on) });
}
unsafe extern "C" fn h_text(h: *mut c_void, local: u32, d: *const c_char, n: usize) {
    fake(h).events.lock().unwrap().push(Ev::Text { local, text: s(d, n) });
}
unsafe extern "C" fn h_closed(h: *mut c_void, local: u32, code: u16, r: *const c_char, n: usize) {
    let f = fake(h);
    f.slots.lock().unwrap().remove(&local);
    f.track_slots.lock().unwrap().remove(&local);
    f.events.lock().unwrap().push(Ev::Closed { local, code, reason: s(r, n) });
}
unsafe extern "C" fn h_rejected(h: *mut c_void, local: u32, why: c_int, d: *const c_char, n: usize) {
    let f = fake(h);
    f.slots.lock().unwrap().remove(&local);
    f.track_slots.lock().unwrap().remove(&local);
    f.events.lock().unwrap().push(Ev::Rejected { local, why, detail: s(d, n) });
}
unsafe extern "C" fn h_served(h: *mut c_void, _local: u32, hash: *const c_char, status: u16, coding: c_int, id: u64, wire: u64) {
    fake(h).events.lock().unwrap().push(Ev::Served { hash: s(hash, 64), status, coding, identity: id, wire });
}
unsafe extern "C" fn h_token_ok(h: *mut c_void, t: *const c_char, n: usize) -> c_int {
    let f = fake(h);
    c_int::from(f.token.is_empty() || s(t, n) == f.token)
}
unsafe extern "C" fn h_origin_ok(h: *mut c_void, o: *const c_char, n: usize) -> c_int {
    let o = s(o, n);
    c_int::from(o.is_empty() || fake(h).origins.contains(&o))
}
unsafe extern "C" fn h_lookup(h: *mut c_void, hash: *const c_char, coding: c_int, out: *mut GrcBuf) -> c_int {
    let f = fake(h);
    let Some((id, gz)) = f.resources.get(&s(hash, 64)) else { return 0 };
    let body = match coding {
        GRC_CODING_IDENTITY => id.clone(),
        GRC_CODING_GZIP => match gz {
            Some(g) => g.clone(),
            None => return 0,
        },
        _ => return 0,
    };
    f.outstanding.fetch_add(1, Ordering::AcqRel);
    *out = GrcBuf { data: body.as_ptr(), len: body.len(), owner: Box::into_raw(Box::new(Owner::Body(body))) as *mut c_void };
    1
}
unsafe extern "C" fn h_release(h: *mut c_void, owner: *mut c_void) {
    fake(h).outstanding.fetch_sub(1, Ordering::AcqRel);
    drop(Box::from_raw(owner as *mut Owner));
}
unsafe extern "C" fn h_log(h: *mut c_void, _level: c_int, m: *const c_char, n: usize) {
    fake(h).logs.lock().unwrap().push(s(m, n));
}

struct Opts {
    token: String,
    origins: Vec<String>,
    cap: usize,
    track_cap: usize,
    /// The `size` the host reports for its struct (None: the real 120 bytes). 112 is a host
    /// older than TRK1.
    host_size: Option<u32>,
    extra: Vec<(&'static str, String)>,
}
impl Default for Opts {
    fn default() -> Self {
        Self { token: String::new(), origins: vec!["http://127.0.0.1:5173".into()],
            cap: 4,
            track_cap: 4,
            host_size: None,
            extra: vec![],
        }
    }
}

struct Harness {
    fake: Box<Fake>,
    host: Box<GrcCarrierHostV1>,
    vt: GrcCarrierV1,
    url: String,
    hash: String,
    evidence: tempdir::Dir,
    stopped: bool,
}

mod tempdir {
    pub struct Dir(pub std::path::PathBuf);
    impl Dir {
        pub fn new() -> Self {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let p = std::env::temp_dir().join(format!(
                "rs-net-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            Dir(p)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn gzip(b: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(b).unwrap();
    e.finish().unwrap()
}

fn body(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
}

impl Harness {
    fn start(o: Opts) -> Harness {
        let evidence = tempdir::Dir::new();
        let mut config: HashMap<String, CString> = HashMap::new();
        let mut set = |k: &str, v: &str| {
            config.insert(k.to_string(), CString::new(v).unwrap());
        };
        set("wt_listen", "127.0.0.1:0");
        set("path", "/render-stream");
        set("subprotocols", "render-stream.13,render-stream.7,render-stream.6");
        set("hello_token_subprotocols", "render-stream.7,render-stream.13");
        set("max_inbound_text", "4096");
        set("evidence_dir", evidence.0.to_str().unwrap());
        for (k, v) in &o.extra {
            set(k, v);
        }
        let mut resources = HashMap::new();
        let a = Arc::new(body(300_000, 7));
        resources.insert(HASH_A.to_string(), (a.clone(), Some(Arc::new(gzip(&a)))));
        resources.insert(HASH_B.to_string(), (Arc::new(body(10, 9)), None));
        let fake = Box::new(Fake {
            config,
            token: o.token,
            origins: o.origins,
            cap: o.cap,
            track_cap: o.track_cap,
            track_slots: Mutex::new(HashSet::new()),
            admits: Mutex::new(vec![]),
            resources,
            events: Mutex::new(vec![]),
            slots: Mutex::new(HashSet::new()),
            outstanding: AtomicI64::new(0),
            logs: Mutex::new(vec![]),
        });
        let host = Box::new(GrcCarrierHostV1 {
            abi_version: GRC_CARRIER_ABI_VERSION,
            size: o.host_size.unwrap_or(std::mem::size_of::<GrcCarrierHostV1>() as u32),
            host: &*fake as *const Fake as *mut c_void,
            config: h_config,
            admit: h_admit,
            opened: h_opened,
            text: h_text,
            closed: h_closed,
            rejected: h_rejected,
            resource_served: h_served,
            token_ok: h_token_ok,
            origin_ok: h_origin_ok,
            lookup: h_lookup,
            release: h_release,
            log: h_log,
            admit_subprotocol: Some(h_admit_subprotocol),
        });
        let module = unsafe { &*render_stream_net::grc_net_module_v1() };
        assert_eq!(module.abi_version, GRC_NET_MODULE_ABI_VERSION);
        assert_eq!(module.carrier_abi_version, GRC_CARRIER_ABI_VERSION);
        let mut vt = std::mem::MaybeUninit::<GrcCarrierV1>::zeroed();
        let mut err = [0 as c_char; 256];
        assert_eq!(unsafe { (module.wt_create)(vt.as_mut_ptr(), err.as_mut_ptr(), err.len()) }, 1);
        let vt = unsafe { vt.assume_init() };
        assert_eq!(unsafe { CStr::from_ptr(vt.name) }.to_str().unwrap(), "wt");
        let ok = unsafe { (vt.start)(vt.self_, &*host, err.as_mut_ptr(), err.len()) };
        assert_eq!(ok, 1, "start: {}", unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy());
        let info = info_of(module, &vt);
        let hash = std::fs::read_to_string(evidence.0.join("live-cert-sha256")).unwrap();
        assert_eq!(hash, format!("{}\n", cstr(&info.cert_sha256)), "live-cert-sha256 is wt_info's hash");
        let url = format!("https://127.0.0.1:{}/render-stream?protocol={SP}", info.port);
        Harness { fake, host, vt, url, hash: hash.trim().to_string(), evidence, stopped: false }
    }

    fn info(&self) -> GrcNetWtInfoV1 {
        info_of(unsafe { &*render_stream_net::grc_net_module_v1() }, &self.vt)
    }

    fn events(&self) -> Vec<Ev> {
        self.fake.events.lock().unwrap().clone()
    }

    fn wait<T>(&self, what: &str, mut f: impl FnMut(&[Ev]) -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(t) = f(&self.events()) {
                return t;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}; events: {:?}", self.events());
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_opened(&self, n: usize) -> u32 {
        self.wait("opened", |e| {
            e.iter()
                .filter_map(|e| match e {
                    Ev::Opened { local, .. } => Some(*local),
                    _ => None,
                })
                .nth(n)
        })
    }

    fn wait_closed(&self, local: u32) -> (u16, String) {
        self.wait("closed", |e| {
            e.iter().find_map(|e| match e {
                Ev::Closed { local: l, code, reason } if *l == local => Some((*code, reason.clone())),
                _ => None,
            })
        })
    }

    fn texts(&self, local: u32) -> Vec<String> {
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                Ev::Text { local: l, text } if l == local => Some(text),
                _ => None,
            })
            .collect()
    }

    fn buf(&self, bytes: Vec<u8>) -> GrcBuf {
        self.fake.outstanding.fetch_add(1, Ordering::AcqRel);
        let (data, len) = (bytes.as_ptr(), bytes.len());
        GrcBuf { data, len, owner: Box::into_raw(Box::new(Owner::Msg(bytes))) as *mut c_void }
    }

    fn send(&self, local: u32, bytes: Vec<u8>) -> bool {
        let b = self.buf(bytes);
        unsafe { (self.vt.send_binary)(self.vt.self_, local, b) == 1 }
    }

    fn send_text(&self, local: u32, text: &str) -> bool {
        let b = self.buf(text.as_bytes().to_vec());
        unsafe { (self.vt.send_text)(self.vt.self_, local, b) == 1 }
    }

    fn close(&self, local: u32, code: u16, reason: &str) {
        unsafe { (self.vt.close)(self.vt.self_, local, code, reason.as_ptr() as *const c_char, reason.len()) }
    }

    fn stop(&mut self) {
        if !self.stopped {
            self.stopped = true;
            unsafe { (self.vt.stop)(self.vt.self_) };
            assert_eq!(self.fake.outstanding.load(Ordering::Acquire), 0, "every host buffer released by stop()");
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            self.stop();
        } else if !self.stopped {
            unsafe { (self.vt.stop)(self.vt.self_) };
        }
        unsafe { (self.vt.destroy)(self.vt.self_) };
        let _ = (&self.host, &self.evidence);
    }
}

fn cstr(a: &[c_char]) -> String {
    unsafe { CStr::from_ptr(a.as_ptr()) }.to_string_lossy().into_owned()
}

fn info_of(module: &GrcNetModuleV1, vt: &GrcCarrierV1) -> GrcNetWtInfoV1 {
    let mut info = GrcNetWtInfoV1::default();
    assert_eq!(unsafe { (module.wt_info)(vt.self_, &mut info) }, 1);
    info
}

// ------------------------------------------------------------------------------ client side

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
}

fn digest(hex: &str) -> Sha256Digest {
    let mut b = [0u8; 32];
    for i in 0..32 {
        b[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    Sha256Digest::new(b)
}

async fn connect_with(url: &str, hash: &str, headers: &[(&str, &str)]) -> Result<Connection, ConnectingError> {
    let config = ClientConfig::builder()
        .with_bind_default()
        .with_server_certificate_hashes([digest(hash)])
        .max_idle_timeout(Some(Duration::from_secs(10)))
        .unwrap()
        .build();
    let ep = Endpoint::client(config).unwrap();
    let mut b = ConnectOptions::builder(url);
    for (k, v) in headers {
        b = b.add_header(*k, *v);
    }
    ep.connect(b.build()).await
}

async fn connect(h: &Harness) -> Connection {
    connect_with(&h.url, &h.hash, &[("origin", "http://127.0.0.1:5173")]).await.expect("connect")
}

fn frame(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut v = vec![kind];
    v.extend_from_slice(&(body.len() as u32).to_le_bytes());
    v.extend_from_slice(body);
    v
}

async fn open_live(c: &Connection) -> (SendStream, RecvStream) {
    let (mut s, r) = c.open_bi().await.unwrap().await.unwrap();
    s.write_all(&[0x00]).await.unwrap();
    (s, r)
}

/// Reads live messages until the stream ends: (messages, framing error).
async fn read_messages(r: &mut RecvStream) -> (Vec<(u8, Vec<u8>)>, Option<String>) {
    match tokio::time::timeout(Duration::from_secs(20), read_messages_inner(r)).await {
        Ok(v) => v,
        Err(_) => panic!("read_messages: no end of the live stream within 20 s"),
    }
}

async fn read_messages_inner(r: &mut RecvStream) -> (Vec<(u8, Vec<u8>)>, Option<String>) {
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; 65536];
    let mut out = Vec::new();
    loop {
        match r.read(&mut chunk).await {
            Ok(Some(n)) => buf.extend_from_slice(&chunk[..n]),
            Ok(None) => break,
            Err(e) => return (out, Some(format!("read: {e}"))),
        }
        let mut at = 0;
        while buf.len() - at >= 5 {
            let kind = buf[at];
            if kind > 1 {
                return (out, Some(format!("unknown kind {kind}")));
            }
            let len = u32::from_le_bytes(buf[at + 1..at + 5].try_into().unwrap()) as usize;
            if buf.len() - at < 5 + len {
                break;
            }
            out.push((kind, buf[at + 5..at + 5 + len].to_vec()));
            at += 5 + len;
        }
        buf.drain(..at);
    }
    if !buf.is_empty() {
        return (out, Some(format!("{} trailing bytes at FIN", buf.len())));
    }
    (out, None)
}

async fn get(c: &Connection, accept: u8, path: &str, token: &str) -> (u16, u8, Vec<u8>) {
    let (mut s, mut r) = c.open_bi().await.unwrap().await.unwrap();
    let mut req = vec![0x01, accept];
    req.extend_from_slice(&(path.len() as u16).to_le_bytes());
    req.extend_from_slice(path.as_bytes());
    req.push(token.len() as u8);
    req.extend_from_slice(token.as_bytes());
    s.write_all(&req).await.unwrap();
    s.finish().await.unwrap();
    let mut res = Vec::new();
    let mut chunk = vec![0u8; 65536];
    while let Some(n) = r.read(&mut chunk).await.unwrap() {
        res.extend_from_slice(&chunk[..n]);
    }
    assert!(res.len() >= 7, "response too short");
    let status = u16::from_le_bytes([res[0], res[1]]);
    let len = u32::from_le_bytes(res[3..7].try_into().unwrap()) as usize;
    assert_eq!(res.len(), 7 + len, "body length is the header's");
    (status, res[2], res[7..].to_vec())
}

fn gunzip(b: &[u8]) -> Vec<u8> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(b).read_to_end(&mut out).unwrap();
    out
}

/// The session's close as the client saw it (CLOSE_WEBTRANSPORT_SESSION), or None.
async fn close_code(c: &Connection) -> Option<(u64, String)> {
    tokio::time::timeout(Duration::from_secs(5), c.session_closed())
        .await
        .ok()
        .flatten()
        .map(|(code, r)| (u64::from(code), String::from_utf8_lossy(&r).into_owned()))
}

// ------------------------------------------------------------------------------ tests

#[test]
fn framing_split_and_coalesced_both_ways_and_drain_before_close() {
    let h = Harness::start(Opts::default());
    let rt = rt();
    let c = rt.block_on(connect(&h));
    let local = h.wait_opened(0);
    assert!(matches!(&h.events()[0], Ev::Opened { sp, origin, .. } if sp == SP && origin == "http://127.0.0.1:5173"));
    // Hub sends before the live stream exists are queued (counted) and flushed in order.
    assert!(h.send(local, b"magic+session".to_vec()));
    assert!(unsafe { (h.vt.queued_bytes)(h.vt.self_, local) } >= 13);
    let (mut s, mut r) = rt.block_on(open_live(&c));
    // Client to host: one message split over three writes, then two coalesced in one write.
    let hello = frame(1, br#"{"type":"hello","token":"x"}"#);
    rt.block_on(async {
        s.write_all(&hello[..3]).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        s.write_all(&hello[3..9]).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        s.write_all(&hello[9..]).await.unwrap();
        let mut two = frame(1, b"{\"type\":\"ack\",\"seq\":1}");
        two.extend(frame(1, "{\"t\":\"\u{e9}\"}".as_bytes()));
        s.write_all(&two).await.unwrap();
    });
    h.wait("three texts", |_| (h.texts(local).len() == 3).then_some(()));
    assert_eq!(
        h.texts(local),
        vec![r#"{"type":"hello","token":"x"}"#, "{\"type\":\"ack\",\"seq\":1}", "{\"t\":\"\u{e9}\"}"]
    );
    // Host to client: sizes around the frame header and the QUIC chunking, a text, then a large
    // final message and an immediate close: the close must not cut the last message (Q4.5).
    let sizes = [0usize, 1, 4, 5, 1199, 70_000, 1 << 20];
    let mut expect: Vec<(u8, Vec<u8>)> = vec![(0, b"magic+session".to_vec())];
    for (i, n) in sizes.iter().enumerate() {
        let b = body(*n, i as u8);
        assert!(h.send(local, b.clone()));
        expect.push((0, b));
    }
    assert!(h.send_text(local, "{\"type\":\"error\"}"));
    expect.push((1, b"{\"type\":\"error\"}".to_vec()));
    let last = body(4 << 20, 99);
    assert!(h.send(local, last.clone()));
    expect.push((0, last));
    h.close(local, 1000, "shutdown");
    assert!(!h.send(local, vec![1]), "a send after close is refused");
    let (got, err) = rt.block_on(read_messages(&mut r));
    assert_eq!(err, None);
    assert_eq!(got.len(), expect.len());
    assert!(got == expect, "every message, byte for byte, in order");
    assert_eq!(rt.block_on(close_code(&c)), Some((1000, "shutdown".to_string())), "CLOSE_WEBTRANSPORT_SESSION(1000)");
    assert_eq!(h.wait_closed(local), (1000, "shutdown".to_string()));
    assert_eq!(unsafe { (h.vt.queued_bytes)(h.vt.self_, local) }, 0);
}

#[test]
fn sabotage_len_off_by_one_fails_the_framing_check() {
    let h = Harness::start(Opts { extra: vec![("net_fault", "len-off-by-one".into())], ..Default::default() });
    let rt = rt();
    let c = rt.block_on(connect(&h));
    let local = h.wait_opened(0);
    let (_s, mut r) = rt.block_on(open_live(&c));
    let sent = vec![body(100, 1), body(200, 2), body(300, 3)];
    for b in &sent {
        assert!(h.send(local, b.clone()));
    }
    h.close(local, 1000, "");
    let (got, err) = rt.block_on(read_messages(&mut r));
    assert!(err.is_some() || got != sent.iter().map(|b| (0u8, b.clone())).collect::<Vec<_>>(), "framing broken");
}

#[test]
fn sabotage_no_drain_close_loses_the_last_message() {
    let h = Harness::start(Opts { extra: vec![("net_fault", "no-drain-close".into())], ..Default::default() });
    let rt = rt();
    let c = rt.block_on(connect(&h));
    let local = h.wait_opened(0);
    let (_s, mut r) = rt.block_on(open_live(&c));
    rt.block_on(async { tokio::time::sleep(Duration::from_millis(100)).await });
    let end = body(8 << 20, 5);
    assert!(h.send(local, end.clone()));
    h.close(local, 1000, "shutdown");
    let (got, _err) = rt.block_on(read_messages(&mut r));
    assert!(!got.iter().any(|(_, b)| *b == end), "the end message is lost without the drain");
    assert_eq!(rt.block_on(close_code(&c)), None, "no session close capsule either");
}

#[test]
fn client_close_maps_to_host_closed() {
    let h = Harness::start(Opts::default());
    let rt = rt();
    // CLOSE_WEBTRANSPORT_SESSION(4001, "bye") from the client.
    let c = rt.block_on(connect(&h));
    let a = h.wait_opened(0);
    let _live = rt.block_on(open_live(&c));
    c.close_session(4001, b"bye");
    assert_eq!(h.wait_closed(a), (4001, "bye".to_string()));
    // Code 0 maps to 1005.
    let c = rt.block_on(connect(&h));
    let b = h.wait_opened(1);
    c.close_session(0, b"");
    assert_eq!(h.wait_closed(b).0, 1005);
    // A QUIC close without the capsule (a transport error) maps to 1006.
    let c = rt.block_on(connect(&h));
    let d = h.wait_opened(2);
    c.close(wtransport::VarInt::from_u32(7), b"gone");
    assert_eq!(h.wait_closed(d).0, 1006);
    // Every slot came back.
    assert!(h.fake.slots.lock().unwrap().is_empty());
}

#[test]
fn inbound_limits_close_like_websocket() {
    let h = Harness::start(Opts::default());
    let rt = rt();
    let cases: [(Vec<u8>, u16); 4] = [
        (frame(1, &vec![b'a'; 4097]), 1009),
        (frame(0, b"binary"), 1003),
        (frame(7, b"?"), 1002),
        (frame(1, &[0xff, 0xfe]), 1007),
    ];
    for (i, (bytes, code)) in cases.iter().enumerate() {
        let c = rt.block_on(connect(&h));
        let local = h.wait_opened(i);
        let (mut s, _r) = rt.block_on(open_live(&c));
        rt.block_on(s.write_all(bytes)).unwrap();
        assert_eq!(h.wait_closed(local).0, *code, "case {i}");
        assert_eq!(rt.block_on(close_code(&c)).map(|c| c.0), Some(u64::from(*code)));
    }
}

#[test]
fn resource_streams_statuses_and_codings() {
    let h = Harness::start(Opts { token: TOKEN.into(), ..Default::default() });
    let rt = rt();
    let c = rt.block_on(connect(&h));
    h.wait_opened(0);
    let pa = format!("/resources/sha256/{HASH_A}");
    let pb = format!("/resources/sha256/{HASH_B}");
    let missing = format!("/resources/sha256/{}", "c".repeat(64));
    let a = body(300_000, 7);
    rt.block_on(async {
        // identity (accept 0)
        let (st, co, b) = get(&c, 0, &pa, TOKEN).await;
        assert_eq!((st, co), (200, 0));
        assert!(b == a);
        // gzip accepted and offered
        let (st, co, b) = get(&c, 1, &pa, TOKEN).await;
        assert_eq!((st, co), (200, 1));
        assert!(b.len() < a.len());
        assert!(gunzip(&b) == a);
        // zstd accepted, not offered -> gzip; gzip accepted, not offered -> identity
        let (st, co, _) = get(&c, 3, &pa, TOKEN).await;
        assert_eq!((st, co), (200, 1));
        let (st, co, b) = get(&c, 1, &pb, TOKEN).await;
        assert_eq!((st, co, b.len()), (200, 0, 10));
        // 404, 401 (wrong and missing token), 400 (bad path, bad token)
        assert_eq!(get(&c, 0, &missing, TOKEN).await.0, 404);
        assert_eq!(get(&c, 0, &pa, &"0".repeat(64)).await.0, 401);
        assert_eq!(get(&c, 0, &pa, "").await.0, 401);
        assert_eq!(get(&c, 0, "/resources/sha256/xyz", TOKEN).await.0, 400);
        assert_eq!(get(&c, 0, &pa, "short").await.0, 400);
        assert_eq!(get(&c, 0, &pa.to_uppercase(), TOKEN).await.0, 400);
        // concurrent GETs on one session
        let gets: Vec<_> = (0..20)
            .map(|_| {
                let (c2, p) = (c.clone(), pa.clone());
                async move { get(&c2, 1, &p, TOKEN).await }
            })
            .collect();
        for r in futures_join(gets).await {
            assert_eq!(r.0, 200);
        }
    });
    let served = h.wait("served", |e| {
        let v: Vec<Ev> = e.iter().filter(|e| matches!(e, Ev::Served { .. })).cloned().collect();
        (v.len() >= 7 + 20).then_some(v)
    });
    assert_eq!(
        served[0],
        Ev::Served { hash: HASH_A.into(), status: 200, coding: 0, identity: 300_000, wire: 300_000 }
    );
    assert!(matches!(&served[1], Ev::Served { status: 200, coding: 1, identity: 300_000, wire, .. } if *wire < 300_000));
    assert!(matches!(&served[4], Ev::Served { status: 404, .. }));
    assert!(matches!(&served[5], Ev::Served { status: 401, identity: 0, wire: 0, .. }));
}

async fn futures_join<F: std::future::Future + Send + 'static>(fs: Vec<F>) -> Vec<F::Output>
where
    F::Output: Send + 'static,
{
    let hs: Vec<_> = fs.into_iter().map(tokio::spawn).collect();
    let mut out = Vec::new();
    for h in hs {
        out.push(h.await.unwrap());
    }
    out
}

#[test]
fn wrong_certificate_hash_is_refused() {
    let h = Harness::start(Opts::default());
    let rt = rt();
    let wrong = "0".repeat(64);
    let r = rt.block_on(connect_with(&h.url, &wrong, &[]));
    assert!(r.is_err(), "the handshake fails on a hash that is not the certificate's");
    assert!(!h.events().iter().any(|e| matches!(e, Ev::Opened { .. })));
}

#[test]
fn connect_checks_origin_path_subprotocol_negotiation() {
    let h = Harness::start(Opts::default());
    let rt = rt();
    let base = h.url.split("/render-stream").next().unwrap().to_string();
    let status = |r: Result<Connection, ConnectingError>| match r {
        Err(ConnectingError::SessionRejectedStatus(s)) => s,
        Ok(_) => 200,
        Err(e) => panic!("unexpected {e}"),
    };
    rt.block_on(async {
        assert_eq!(status(connect_with(&h.url, &h.hash, &[("origin", "https://evil.example")]).await), 403);
        assert_eq!(status(connect_with(&format!("{base}/other?protocol={SP}"), &h.hash, &[]).await), 404);
        assert_eq!(status(connect_with(&format!("{base}/render-stream"), &h.hash, &[]).await), 400);
        // /6's token is an upgrade header: not offered on wt.
        assert_eq!(
            status(connect_with(&format!("{base}/render-stream?protocol=render-stream.6"), &h.hash, &[]).await),
            400
        );
        assert_eq!(
            status(
                connect_with(&h.url, &h.hash, &[("wt-available-protocols", "\"render-stream.7\"")]).await
            ),
            400,
            "negotiation must agree with the query"
        );
        let ok = connect_with(&h.url, &h.hash, &[("wt-available-protocols", "\"render-stream.7\", \"render-stream.13\"")])
            .await;
        assert_eq!(status(ok), 200);
        // No Origin at all is allowed (a non-browser client).
        assert_eq!(status(connect_with(&h.url, &h.hash, &[]).await), 200);
    });
    let ev = h.events();
    assert!(ev.contains(&Ev::Rejected { local: 1, why: GRC_REJECT_ORIGIN, detail: "https://evil.example".into() }));
    assert_eq!(ev.iter().filter(|e| matches!(e, Ev::Opened { .. })).count(), 2);
    assert_eq!(h.info().sessions_refused, 5);
}

#[test]
fn reserved_stream_types_uni_streams_and_datagrams_are_refused() {
    let h = Harness::start(Opts::default());
    let rt = rt();
    let c = rt.block_on(connect(&h));
    let local = h.wait_opened(0);
    let (mut live_s, mut live_r) = rt.block_on(open_live(&c));
    rt.block_on(async {
        for t in [0x02u8, 0x0f, 0x10, 0x80, 0xff] {
            let (mut s, mut r) = c.open_bi().await.unwrap().await.unwrap();
            s.write_all(&[t, 1, 2, 3]).await.unwrap();
            let mut b = [0u8; 8];
            match r.read(&mut b).await {
                Err(StreamReadError::Reset(code)) => {
                    assert_eq!(code.into_inner(), wt_error_to_h3(1), "unknown-stream-type")
                }
                other => panic!("stream type {t:#x}: expected a reset, got {other:?}"),
            }
        }
        let mut u = c.open_uni().await.unwrap().await.unwrap();
        let _ = u.write_all(&[0x02, 9, 9]).await;
        let _ = c.send_datagram(b"audio?");
        tokio::time::sleep(Duration::from_millis(200)).await;
        // The session continues: the live stream still carries both ways.
        live_s.write_all(&frame(1, b"{\"still\":1}")).await.unwrap();
    });
    h.wait("text after refusals", |_| (h.texts(local) == vec!["{\"still\":1}"]).then_some(()));
    assert!(h.send(local, b"ok".to_vec()));
    h.close(local, 1000, "");
    let (got, _) = rt.block_on(read_messages(&mut live_r));
    assert_eq!(got, vec![(0u8, b"ok".to_vec())]);
    let info = h.info();
    assert_eq!(info.streams_refused, 6);
    assert!(info.datagrams_dropped <= 1, "a datagram is dropped and counted (if it arrived)");
}

#[test]
fn second_live_stream_closes_1008() {
    let h = Harness::start(Opts::default());
    let rt = rt();
    let c = rt.block_on(connect(&h));
    let local = h.wait_opened(0);
    let _a = rt.block_on(open_live(&c));
    let _b = rt.block_on(open_live(&c));
    assert_eq!(h.wait_closed(local), (1008, "second-live-stream".to_string()));
}

#[test]
fn admission_cap_is_the_host_total() {
    let h = Harness::start(Opts { cap: 1, ..Default::default() });
    let rt = rt();
    let c = rt.block_on(connect(&h));
    let a = h.wait_opened(0);
    match rt.block_on(connect_with(&h.url, &h.hash, &[])) {
        Err(ConnectingError::SessionRejectedStatus(503)) => {}
        Err(e) => panic!("expected 503, got {e}"),
        Ok(_) => panic!("expected 503, got a session"),
    }
    c.close_session(1000, b"");
    h.wait_closed(a);
    let _again = rt.block_on(connect(&h));
    h.wait_opened(1);
}

#[test]
fn send_queue_cap_closes_1008() {
    let h = Harness::start(Opts { extra: vec![("max_queued_bytes", "1000".into())], ..Default::default() });
    let rt = rt();
    let _c = rt.block_on(connect(&h));
    let local = h.wait_opened(0);
    assert!(h.send(local, vec![0; 900]));
    assert!(!h.send(local, vec![0; 200]), "over the cap");
    assert_eq!(h.wait_closed(local).0, 1008);
    assert_eq!(unsafe { (h.vt.max_queued_bytes)(h.vt.self_, local) }, 0, "unknown once closed");
}

#[test]
fn panic_in_send_is_contained() {
    let h = Harness::start(Opts { extra: vec![("net_fault", "panic-send".into())], ..Default::default() });
    let rt = rt();
    let _c = rt.block_on(connect(&h));
    let local = h.wait_opened(0);
    assert!(!h.send(local, vec![1, 2, 3]), "the panic is caught; the send fails");
    assert_eq!(h.wait_closed(local), (1011, "carrier-fault".to_string()));
    assert_eq!(h.info().faulted, 1);
    assert_eq!(h.fake.outstanding.load(Ordering::Acquire), 0, "the message was still released");
    // The carrier refuses new sessions now.
    assert!(rt.block_on(connect_with(&h.url, &h.hash, &[])).is_err());
}

#[test]
fn panic_in_a_session_task_is_contained() {
    let h = Harness::start(Opts { extra: vec![("net_fault", "panic-session".into())], ..Default::default() });
    let rt = rt();
    // The session opens, then its task panics: the connect may or may not see it open.
    let _c = rt.block_on(connect_with(&h.url, &h.hash, &[]));
    let local = h.wait_opened(0);
    assert_eq!(h.wait_closed(local), (1011, "carrier-fault".to_string()));
    assert_eq!(h.info().faulted, 1);
}

#[test]
fn stop_closes_releases_and_goes_quiet() {
    let mut h = Harness::start(Opts::default());
    let rt = rt();
    let c = rt.block_on(connect(&h));
    let local = h.wait_opened(0);
    // Messages the client never reads a live stream for: still released by stop().
    for _ in 0..10 {
        assert!(h.send(local, vec![7; 1000]));
    }
    h.stop();
    assert_eq!(h.wait_closed(local).0, 1001);
    let n = h.events().len();
    let _ = rt.block_on(async { tokio::time::timeout(Duration::from_secs(2), c.closed()).await });
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(h.events().len(), n, "no callback after stop()");
}

/// The address a LAN client would use: the interface the default route leaves by. A UDP socket
/// "connected" to a documentation address sends nothing and only picks the source address.
fn lan_ipv4() -> Option<std::net::Ipv4Addr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(a) if !a.is_loopback() && !a.is_unspecified() => Some(a),
        _ => None,
    }
}

#[test]
fn lan_listen_needs_expose_lan_and_serves_through_a_lan_address() {
    // with expose=lan, 0.0.0.0 binds, the session works on the
    // loopback address and, when this machine has one, through its LAN address.
    let h = Harness::start(Opts {
        extra: vec![("wt_listen", "0.0.0.0:0".to_string()), ("expose", "lan".to_string())],
        ..Opts::default()
    });
    let info = h.info();
    assert_eq!(cstr(&info.address), "0.0.0.0");
    assert_eq!(cstr(&info.tls), "self-signed", "wt is always encrypted, on the LAN too");
    let rt = rt();
    let mut urls = vec![h.url.clone()];
    match lan_ipv4() {
        Some(ip) => urls.push(format!("https://{ip}:{}/render-stream?protocol={SP}", info.port)),
        None => eprintln!("no non-loopback IPv4 address: the LAN-address connection is skipped"),
    }
    let mut keep = Vec::new();
    for (i, url) in urls.iter().enumerate() {
        let c = rt.block_on(async {
            let c = connect_with(url, &h.hash, &[("origin", "http://127.0.0.1:5173")]).await.expect(url);
            let _ = open_live(&c).await;
            c
        });
        h.wait_opened(i);
        keep.push(c);
    }
}

#[test]
fn self_signed_certificate_is_pinnable_and_written() {
    let h = Harness::start(Opts::default());
    let info = h.info();
    assert_eq!(cstr(&info.tls), "self-signed");
    assert_eq!(cstr(&info.address), "127.0.0.1");
    assert!(info.port > 0);
    assert_eq!(h.hash.len(), 64);
    assert!(h.fake.logs.lock().unwrap().iter().any(|l| l.contains(&h.hash)));
}

#[test]
fn start_refusals_are_typed() {
    for (extra, want) in [
        (vec![("wt_listen", "nonsense".to_string())], "wt-listen-invalid"),
        (vec![("wt_cert", "tls".to_string())], "tls-config-invalid"),
        // CAR2 (D10): a non-loopback listen needs expose=lan, whatever its spelling.
        (vec![("wt_listen", "0.0.0.0:0".to_string())], "non-loopback"),
        (vec![("wt_listen", "[::]:0".to_string())], "non-loopback"),
        (vec![("wt_listen", "192.168.1.5:9".to_string()), ("expose", "loopback".to_string())], "non-loopback"),
        (vec![("wt_listen", "0.0.0.0:0".to_string()), ("expose", "wan".to_string())], "expose-invalid"),
        (vec![("hello_token_subprotocols", "".to_string())], "carrier-config-invalid"),
    ] {
        let fake = Box::new(Fake {
            config: {
                let mut m = HashMap::new();
                m.insert("wt_listen".to_string(), CString::new("127.0.0.1:0").unwrap());
                m.insert("subprotocols".to_string(), CString::new(SP).unwrap());
                m.insert("hello_token_subprotocols".to_string(), CString::new(SP).unwrap());
                for (k, v) in &extra {
                    m.insert(k.to_string(), CString::new(v.as_str()).unwrap());
                }
                m
            },
            token: String::new(),
            origins: vec![],
            cap: 1,
            track_cap: 1,
            track_slots: Mutex::new(HashSet::new()),
            admits: Mutex::new(vec![]),
            resources: HashMap::new(),
            events: Mutex::new(vec![]),
            slots: Mutex::new(HashSet::new()),
            outstanding: AtomicI64::new(0),
            logs: Mutex::new(vec![]),
        });
        let host = GrcCarrierHostV1 {
            abi_version: GRC_CARRIER_ABI_VERSION,
            size: std::mem::size_of::<GrcCarrierHostV1>() as u32,
            host: &*fake as *const Fake as *mut c_void,
            config: h_config,
            admit: h_admit,
            opened: h_opened,
            text: h_text,
            closed: h_closed,
            rejected: h_rejected,
            resource_served: h_served,
            token_ok: h_token_ok,
            origin_ok: h_origin_ok,
            lookup: h_lookup,
            release: h_release,
            log: h_log,
            admit_subprotocol: Some(h_admit_subprotocol),
        };
        let module = unsafe { &*render_stream_net::grc_net_module_v1() };
        let mut vt = std::mem::MaybeUninit::<GrcCarrierV1>::zeroed();
        let mut err = [0 as c_char; 256];
        unsafe { (module.wt_create)(vt.as_mut_ptr(), err.as_mut_ptr(), err.len()) };
        let vt = unsafe { vt.assume_init() };
        assert_eq!(unsafe { (vt.start)(vt.self_, &host, err.as_mut_ptr(), err.len()) }, 0);
        let e = cstr(&err);
        assert!(e.starts_with(want), "{want}: got {e}");
        unsafe { (vt.destroy)(vt.self_) };
    }
}

// ------------------------------------------------------------------------------ impaired path (CAR10)

/// A UDP forwarder between a QUIC client and the carrier that drops, delays and (through the
/// delay jitter) reorders datagrams in both directions, seeded so a run is repeatable. QUIC does
/// not mind a forwarder: the client connects to the proxy's port and pins the certificate hash.
mod impair {
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::net::UdpSocket;

    #[derive(Clone, Copy, Debug)]
    pub struct Profile {
        /// Per-datagram drop probability, per mille.
        pub loss_pm: u32,
        /// Base one-way delay and uniform jitter on top of it, microseconds.
        pub delay_us: u64,
        pub jitter_us: u64,
        pub seed: u64,
    }

    #[derive(Default)]
    pub struct Counts {
        pub forwarded: AtomicU64,
        pub dropped: AtomicU64,
    }

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            // xorshift64*
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }
    }

    /// Starts the forwarder to `server`; returns its client-facing address.
    pub async fn start(server: SocketAddr, p: Profile, counts: Arc<Counts>) -> SocketAddr {
        let front = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let back = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let addr = front.local_addr().unwrap();
        let client: Arc<std::sync::Mutex<Option<SocketAddr>>> = Arc::new(std::sync::Mutex::new(None));
        let pump = |from: Arc<UdpSocket>, to: Arc<UdpSocket>, upstream: bool, seed: u64| {
            let client = client.clone();
            let counts = counts.clone();
            async move {
                let mut rng = Rng(seed | 1);
                let mut buf = vec![0u8; 65536];
                loop {
                    let Ok((n, peer)) = from.recv_from(&mut buf).await else { return };
                    let dest = if upstream {
                        *client.lock().unwrap() = Some(peer);
                        server
                    } else {
                        match *client.lock().unwrap() {
                            Some(c) => c,
                            None => continue,
                        }
                    };
                    if (rng.next() % 1000) < u64::from(p.loss_pm) {
                        counts.dropped.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    counts.forwarded.fetch_add(1, Ordering::Relaxed);
                    let d = p.delay_us + if p.jitter_us > 0 { rng.next() % p.jitter_us } else { 0 };
                    let data = buf[..n].to_vec();
                    let to = to.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_micros(d)).await;
                        let _ = to.send_to(&data, dest).await;
                    });
                }
            }
        };
        tokio::spawn(pump(front.clone(), back.clone(), true, p.seed));
        tokio::spawn(pump(back, front, false, p.seed.rotate_left(17) ^ 0x9e37_79b9));
        addr
    }
}

fn env_u64(k: &str, d: u64) -> u64 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

/// One uplink batch (Q4.3a): a client unidirectional stream `0x10, u32le batch, messages`, FIN.
async fn uplink(c: &Connection, batch: u32, texts: &[&str]) {
    let mut s = c.open_uni().await.unwrap().await.unwrap();
    let mut b = vec![0x10];
    b.extend_from_slice(&batch.to_le_bytes());
    for t in texts {
        b.extend_from_slice(&frame(1, t.as_bytes()));
    }
    s.write_all(&b).await.unwrap();
    s.finish().await.unwrap();
}

struct LoopOpts {
    /// Client-to-host acks on uplink batches (Q4.3a) instead of the live stream.
    uplink: bool,
    /// After this many messages the client's live stream stops sending, its writes still
    /// "succeeding": what Chrome on Android does to a WebTransport stream (CAR10).
    wedge_after: Option<u32>,
    impair: Option<impair::Profile>,
    total: u32,
}

/// The hub's credit loop: the host sends a ~2.4 KB binary message whenever fewer than 2 are
/// unacknowledged (credit window 2); the client answers each with three ~110-byte text acks
/// (received, applied, submitted), as the browser client does. Returns Ok(seconds) when every
/// message was acknowledged, Err(diagnosis) when no ack arrived for 5 s while one was owed.
fn credit_loop(o: LoopOpts) -> Result<f64, String> {
    let h = Harness::start(Opts::default());
    let rt = rt();
    let counts = Arc::new(impair::Counts::default());
    let port = h.info().port as u16;
    let client_sent = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let client_got = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let (cs, cg, hash, c2, prof) = (client_sent.clone(), client_got.clone(), h.hash.clone(), counts.clone(), o.impair);
    let (use_uplink, wedge_after) = (o.uplink, o.wedge_after);
    let client = rt.spawn(async move {
        let target = match prof {
            Some(p) => impair::start(format!("127.0.0.1:{port}").parse().unwrap(), p, c2).await.port(),
            None => port,
        };
        let url = format!("https://127.0.0.1:{target}/render-stream?protocol={SP}");
        let c = connect_with(&url, &hash, &[("origin", "http://127.0.0.1:5173")]).await.expect("connect");
        let (mut s, mut r) = open_live(&c).await;
        s.write_all(&frame(1, b"{\"type\":\"hello\"}")).await.unwrap();
        cs.fetch_add(1, Ordering::AcqRel);
        let mut buf = Vec::new();
        let mut chunk = vec![0u8; 65536];
        let mut batch = 0u32;
        let mut got = 0u32;
        loop {
            match r.read(&mut chunk).await {
                Ok(Some(n)) => buf.extend_from_slice(&chunk[..n]),
                _ => return c,
            }
            let mut at = 0;
            while buf.len() - at >= 5 {
                let len = u32::from_le_bytes(buf[at + 1..at + 5].try_into().unwrap()) as usize;
                if buf.len() - at < 5 + len {
                    break;
                }
                let seq = u32::from_le_bytes(buf[at + 5..at + 9].try_into().unwrap());
                at += 5 + len;
                got += 1;
                cg.fetch_add(1, Ordering::AcqRel);
                let acks: Vec<String> = ["received", "applied", "submitted"]
                    .iter()
                    .map(|stage| {
                        format!(
                            "{{\"type\":\"ack\",\"stream_id\":\"0123456789abcdef0123456789abcdef\",\"seq\":{seq},\"stage\":\"{stage}\",\"t_us\":{}}}",
                            u64::from(seq) * 16_666 + 1_000_000_000
                        )
                    })
                    .collect();
                if use_uplink {
                    let refs: Vec<&str> = acks.iter().map(String::as_str).collect();
                    uplink(&c, batch, &refs).await;
                    batch += 1;
                } else if wedge_after.is_none_or(|w| got <= w) {
                    for a in &acks {
                        s.write_all(&frame(1, a.as_bytes())).await.unwrap();
                    }
                }
                cs.fetch_add(3, Ordering::AcqRel);
            }
            buf.drain(..at);
        }
    });
    let local = h.wait_opened(0);
    let texts = |h: &Harness| {
        h.fake.events.lock().unwrap().iter().filter(|e| matches!(e, Ev::Text { local: l, .. } if *l == local)).count() as u64
    };
    let total = o.total;
    let mut sent = 0u32;
    let mut last_progress = (Instant::now(), 0u64);
    let started = Instant::now();
    let result = loop {
        let got = texts(&h);
        // hello + 3 per message; credit returns with each message's first ack.
        let credited = if got == 0 { 0 } else { ((got - 1) + 2) / 3 } as u32;
        if sent >= total && got == 1 + 3 * u64::from(total) {
            break Ok(started.elapsed().as_secs_f64());
        }
        while sent < total && sent - credited.min(sent) < 2 {
            let mut m = body(2400, (sent % 251) as u8);
            m[..4].copy_from_slice(&sent.to_le_bytes());
            assert!(h.send(local, m));
            sent += 1;
        }
        if got != last_progress.1 {
            last_progress = (Instant::now(), got);
        }
        if last_progress.0.elapsed() >= Duration::from_secs(5) {
            break Err(format!(
                "credit loop stalled: host sent {sent} of {total}, host got {got} texts, client wrote {} texts and \
                 read {} messages; proxy forwarded {} dropped {} ({:?}, {:.1} s in)",
                client_sent.load(Ordering::Acquire),
                client_got.load(Ordering::Acquire),
                counts.forwarded.load(Ordering::Relaxed),
                counts.dropped.load(Ordering::Relaxed),
                o.impair,
                started.elapsed().as_secs_f64()
            ));
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    h.close(local, 1000, "done");
    h.wait_closed(local);
    client.abort();
    result
}

fn wifi_profile() -> impair::Profile {
    impair::Profile {
        loss_pm: env_u64("RS_NET_IMPAIR_LOSS_PM", 30) as u32,
        delay_us: env_u64("RS_NET_IMPAIR_DELAY_US", 2000),
        jitter_us: env_u64("RS_NET_IMPAIR_JITTER_US", 6000),
        seed: env_u64("RS_NET_IMPAIR_SEED", 0x00c0_ffee),
    }
}

/// The live stream alone (old clients) and uplink batches both survive loss and reordering.
#[test]
fn credit_loop_survives_loss_and_reordering() {
    let total = env_u64("RS_NET_IMPAIR_MESSAGES", 600) as u32;
    for uplink in [false, true] {
        let s = credit_loop(LoopOpts { uplink, wedge_after: None, impair: Some(wifi_profile()), total })
            .unwrap_or_else(|e| panic!("uplink={uplink}: {e}"));
        eprintln!("credit loop uplink={uplink}: {total} messages in {s:.1} s over the impaired path");
    }
}

/// CAR10's defect, modelled: once the client's live stream stops sending (Chrome on Android
/// wedges a WebTransport stream; its writes keep resolving), acks on that stream never arrive
/// and the credit loop stalls with the host owed its last acks. This is the sabotage half: it
/// proves the loop detects the stall.
#[test]
fn credit_loop_on_a_wedged_live_stream_stalls() {
    let e = credit_loop(LoopOpts { uplink: false, wedge_after: Some(40), impair: None, total: 200 })
        .expect_err("acks on a wedged live stream must stall the credit loop");
    assert!(e.contains("host sent 42 of 200"), "{e}");
}

/// The fix: acks on uplink batches reach the host whatever the live stream's send side does.
#[test]
fn credit_loop_with_uplink_batches_ignores_a_wedged_live_stream() {
    credit_loop(LoopOpts { uplink: true, wedge_after: Some(40), impair: Some(wifi_profile()), total: 300 }).unwrap();
}

/// Q4.3a: uplink batches wait for the live stream's first text (the hello), are delivered in
/// batch order whatever order they arrive in, and a batch sent twice is delivered once. A batch
/// reset before its FIN is dropped; its re-send is delivered.
#[test]
fn uplink_batches_follow_the_hello_in_order_exactly_once() {
    let h = Harness::start(Opts::default());
    let rt = rt();
    let c = rt.block_on(connect(&h));
    let local = h.wait_opened(0);
    let (mut live, _r) = rt.block_on(open_live(&c));
    rt.block_on(async {
        uplink(&c, 1, &["b1"]).await;
        uplink(&c, 0, &["b0a", "b0b"]).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
    });
    assert!(h.texts(local).is_empty(), "no batch before the hello: {:?}", h.texts(local));
    rt.block_on(async {
        live.write_all(&frame(1, b"hello")).await.unwrap();
        uplink(&c, 0, &["b0a", "b0b"]).await; // a re-send after all
        // A batch reset before its FIN is dropped...
        let mut s = c.open_uni().await.unwrap().await.unwrap();
        let mut b = vec![0x10];
        b.extend_from_slice(&2u32.to_le_bytes());
        b.extend_from_slice(&frame(1, b"b2"));
        s.write_all(&b[..b.len() - 1]).await.unwrap();
        s.reset(wtransport::VarInt::from_u32(0)).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        // ...and its re-send delivered.
        uplink(&c, 2, &["b2"]).await;
    });
    h.wait("all texts", |_| (h.texts(local).len() >= 5).then_some(()));
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(h.texts(local), vec!["hello", "b0a", "b0b", "b1", "b2"]);
    assert_eq!(h.info().streams_refused, 0, "uplink streams are not refused");
}

/// Q4.3a's limits are the live stream's: a binary message closes 1003, a FIN inside a message
/// 1002, a batch over 64 KiB 1009.
#[test]
fn uplink_violations_close_like_the_live_stream() {
    for (what, bytes, want) in [
        ("binary", { let mut b = vec![0x10, 0, 0, 0, 0]; b.extend_from_slice(&frame(0, b"x")); b }, 1003u16),
        ("truncated", { let mut b = vec![0x10, 0, 0, 0, 0]; b.extend_from_slice(&frame(1, b"abc")[..6]); b }, 1002),
        ("too large", {
            let mut b = vec![0x10, 0, 0, 0, 0];
            while b.len() < 70 * 1024 {
                b.extend_from_slice(&frame(1, &[b'a'; 4000]));
            }
            b
        }, 1009),
    ] {
        let h = Harness::start(Opts::default());
        let rt = rt();
        let c = rt.block_on(connect(&h));
        let local = h.wait_opened(0);
        let (mut live, _r) = rt.block_on(open_live(&c));
        rt.block_on(async {
            live.write_all(&frame(1, b"hello")).await.unwrap();
            let mut s = c.open_uni().await.unwrap().await.unwrap();
            let _ = s.write_all(&bytes).await;
            let _ = s.finish().await;
        });
        let (code, _) = h.wait_closed(local);
        assert_eq!(code, want, "{what}");
    }
}

// ------------------------------------------------------------------------------ TRK3: tracks

const TRACK_SP: &str = "render-stream-track.1";

fn track_opts() -> Opts {
    Opts { extra: vec![("track_subprotocols", TRACK_SP.into())], ..Default::default() }
}

fn track_url(h: &Harness) -> String {
    h.url.replace(SP, TRACK_SP)
}

async fn connect_track(h: &Harness) -> Result<Connection, ConnectingError> {
    connect_with(&track_url(h), &h.hash, &[("origin", "http://127.0.0.1:5173")]).await
}

fn status_of(r: Result<Connection, ConnectingError>) -> u16 {
    match r {
        Err(ConnectingError::SessionRejectedStatus(s)) => s,
        Ok(_) => 200,
        Err(e) => panic!("unexpected {e}"),
    }
}

/// The module advertises the tracks capability (grc_net_module.h GRC_NET_FEATURE_TRACKS) at
/// offset 40, inside its reported size.
#[test]
fn module_table_advertises_the_tracks_feature() {
    let module = unsafe { &*render_stream_net::grc_net_module_v1() };
    assert_eq!(module.size as usize, std::mem::size_of::<GrcNetModuleV1>());
    assert_eq!(module.size, 48);
    assert_eq!(module.features & GRC_NET_FEATURE_TRACKS, GRC_NET_FEATURE_TRACKS);
}

/// A track CONNECT is admitted from the track pool by admit_subprotocol, opens with the track
/// subprotocol, and carries texts both ways (live stream and uplink batches) exactly as a view
/// session does; a view session beside it still uses admit(); a resource stream is refused on the
/// track and served on the view.
#[test]
fn track_session_is_admitted_by_subprotocol_and_carries_payloads() {
    let h = Harness::start(track_opts());
    let rt = rt();
    let t = rt.block_on(connect_track(&h)).expect("track connect");
    let local = h.wait_opened(0);
    assert!(matches!(&h.events()[0], Ev::Opened { sp, .. } if sp == TRACK_SP));
    assert_eq!(h.fake.admits.lock().unwrap().clone(), vec![(local, Some(TRACK_SP.to_string()))]);
    assert_eq!(h.fake.track_slots.lock().unwrap().len(), 1, "a track slot");
    assert!(h.fake.slots.lock().unwrap().is_empty(), "no view slot");

    let (mut live, mut r) = rt.block_on(open_live(&t));
    rt.block_on(async {
        live.write_all(&frame(1, br#"{"type":"hello"}"#)).await.unwrap();
        uplink(&t, 0, &["p0", "p1"]).await;
        uplink(&t, 1, &["p2"]).await;
        // Resource streams do not exist on a track session.
        let (mut s, mut rr) = t.open_bi().await.unwrap().await.unwrap();
        let path = format!("/resources/sha256/{HASH_B}");
        let mut req = vec![0x01, 0];
        req.extend_from_slice(&(path.len() as u16).to_le_bytes());
        req.extend_from_slice(path.as_bytes());
        req.push(0);
        s.write_all(&req).await.unwrap();
        let mut b = [0u8; 8];
        match rr.read(&mut b).await {
            Err(StreamReadError::Reset(code)) => assert_eq!(code.into_inner(), wt_error_to_h3(1), "unknown-stream-type"),
            other => panic!("expected a reset, got {other:?}"),
        }
    });
    h.wait("track texts", |_| (h.texts(local).len() == 4).then_some(()));
    assert_eq!(h.texts(local), vec![r#"{"type":"hello"}"#, "p0", "p1", "p2"]);
    assert_eq!(h.info().streams_refused, 1);

    // Host to client: texts keep their order and the close does not cut the last one.
    assert!(h.send_text(local, r#"{"type":"track-ready"}"#));
    assert!(h.send_text(local, "payload"));
    h.close(local, 1000, "done");
    let (got, err) = rt.block_on(read_messages(&mut r));
    assert_eq!(err, None);
    assert_eq!(got, vec![(1u8, br#"{"type":"track-ready"}"#.to_vec()), (1u8, b"payload".to_vec())]);
    assert_eq!(rt.block_on(close_code(&t)), Some((1000, "done".to_string())));
    assert_eq!(h.wait_closed(local), (1000, "done".to_string()));
    assert!(h.fake.track_slots.lock().unwrap().is_empty(), "the slot came back");

    // A view session on the same host: admit(), and its resources are served.
    let v = rt.block_on(connect(&h));
    let view = h.wait_opened(1);
    assert_eq!(h.fake.admits.lock().unwrap().last().cloned(), Some((view, None)), "a view uses admit()");
    let (st, _, body_) = rt.block_on(get(&v, 0, &format!("/resources/sha256/{HASH_B}"), ""));
    assert_eq!((st, body_.len()), (200, 10));
    assert_eq!(h.info().streams_refused, 1, "unchanged by the view's GET");
}

/// A track text that is not UTF-8 closes the session 1007 like a view's (parse_client_frames).
#[test]
fn track_inbound_limits_close_like_a_view() {
    let h = Harness::start(track_opts());
    let rt = rt();
    let cases: [(Vec<u8>, u16); 3] = [(frame(1, &[0xff, 0xfe]), 1007), (frame(0, b"bin"), 1003), (frame(1, &vec![b'a'; 4097]), 1009)];
    for (i, (bytes, code)) in cases.iter().enumerate() {
        let c = rt.block_on(connect_track(&h)).unwrap();
        let local = h.wait_opened(i);
        let (mut s, _r) = rt.block_on(open_live(&c));
        rt.block_on(s.write_all(bytes)).unwrap();
        assert_eq!(h.wait_closed(local).0, *code, "case {i}");
    }
}

/// The track pool is separate from the view pool: a full view pool leaves a track admissible and
/// a full track pool answers 503 with a capacity rejection, as a full view pool does.
#[test]
fn track_pool_is_separate_and_full_means_503() {
    let h = Harness::start(Opts { cap: 1, track_cap: 1, ..track_opts() });
    let rt = rt();
    let _v = rt.block_on(connect(&h));
    h.wait_opened(0);
    assert_eq!(status_of(rt.block_on(connect_with(&h.url, &h.hash, &[]))), 503, "the view pool is full");
    let t = rt.block_on(connect_track(&h)).expect("a track fits beside a full view pool");
    let local = h.wait_opened(1);
    let refused = status_of(rt.block_on(connect_track(&h)));
    assert_eq!(refused, 503, "the track pool is full");
    let ev = h.events();
    assert!(
        ev.iter().any(|e| matches!(e, Ev::Rejected { why, .. } if *why == GRC_REJECT_CAPACITY)),
        "a capacity rejection reached the host: {ev:?}"
    );
    t.close_session(1000, b"");
    h.wait_closed(local);
    let _again = rt.block_on(connect_track(&h)).expect("the slot came back");
    h.wait_opened(2);
}

/// Refusal shapes match ws: with tracks off (no `track_subprotocols`) the track name is as
/// unknown as any other (400, no admission call, nothing rejected to the host); with them on, a
/// WT-Available-Protocols list that omits the name is 400, and a name in neither list is 400.
#[test]
fn track_refusals_match_the_view_shapes() {
    let off = Harness::start(Opts::default());
    let rt = rt();
    assert_eq!(status_of(rt.block_on(connect_track(&off))), 400, "tracks off: the unknown-subprotocol shape");
    assert!(off.fake.admits.lock().unwrap().is_empty(), "no admission was asked for");
    assert!(!off.events().iter().any(|e| matches!(e, Ev::Opened { .. } | Ev::Rejected { .. })));
    assert_eq!(off.info().sessions_refused, 1);
    drop(off);

    let on = Harness::start(track_opts());
    let base = on.url.split("/render-stream").next().unwrap().to_string();
    rt.block_on(async {
        assert_eq!(
            status_of(connect_with(&track_url(&on), &on.hash, &[("wt-available-protocols", "\"render-stream.13\"")]).await),
            400,
            "negotiation must agree with the query"
        );
        assert_eq!(
            status_of(
                connect_with(&format!("{base}/render-stream?protocol=render-stream-track.2"), &on.hash, &[]).await
            ),
            400
        );
        assert_eq!(
            status_of(connect_with(&track_url(&on), &on.hash, &[("origin", "https://evil.example")]).await),
            403,
            "the Origin check applies to tracks"
        );
        assert_eq!(status_of(connect_with(&format!("{base}/other?protocol={TRACK_SP}"), &on.hash, &[]).await), 404);
        let ok = connect_with(&track_url(&on), &on.hash, &[("wt-available-protocols", "\"render-stream-track.1\"")]).await;
        assert_eq!(status_of(ok), 200);
    });
    assert!(on.events().iter().filter(|e| matches!(e, Ev::Opened { .. })).count() == 1);
}

/// A track subprotocol that is also a view subprotocol stays a view (the view list wins), so
/// admission is the view pool's admit().
#[test]
fn a_name_in_both_lists_is_a_view() {
    let h = Harness::start(Opts { extra: vec![("track_subprotocols", format!("{SP},{TRACK_SP}"))], ..Default::default() });
    let rt = rt();
    let _c = rt.block_on(connect(&h));
    let local = h.wait_opened(0);
    assert_eq!(h.fake.admits.lock().unwrap().clone(), vec![(local, None)]);
    let _t = rt.block_on(connect_track(&h)).unwrap();
    let t = h.wait_opened(1);
    assert_eq!(h.fake.admits.lock().unwrap()[1], (t, Some(TRACK_SP.to_string())));
}

/// A host struct older than TRK1 (size 112, no admit_subprotocol) still starts and serves views
/// byte-for-byte as before; it is never offered a track subprotocol, whatever its config says.
#[test]
fn an_old_layout_host_leaves_tracks_off() {
    let h = Harness::start(Opts { host_size: Some(112), ..track_opts() });
    let rt = rt();
    assert_eq!(status_of(rt.block_on(connect_track(&h))), 400);
    assert!(h.fake.admits.lock().unwrap().is_empty());
    let _v = rt.block_on(connect(&h));
    let local = h.wait_opened(0);
    assert_eq!(h.fake.admits.lock().unwrap().clone(), vec![(local, None)]);
}

/// The host struct's `size` must cover at least the CAR1 base (112 bytes).
#[test]
fn a_host_struct_shorter_than_the_base_is_refused() {
    let mut config: HashMap<String, CString> = HashMap::new();
    for (k, v) in [("wt_listen", "127.0.0.1:0"), ("subprotocols", SP), ("hello_token_subprotocols", SP)] {
        config.insert(k.to_string(), CString::new(v).unwrap());
    }
    let fake = Box::new(Fake {
        config,
        token: String::new(),
        origins: vec![],
        cap: 1,
        track_cap: 1,
        track_slots: Mutex::new(HashSet::new()),
        admits: Mutex::new(vec![]),
        resources: HashMap::new(),
        events: Mutex::new(vec![]),
        slots: Mutex::new(HashSet::new()),
        outstanding: AtomicI64::new(0),
        logs: Mutex::new(vec![]),
    });
    let host = GrcCarrierHostV1 {
        abi_version: GRC_CARRIER_ABI_VERSION,
        size: 111,
        host: &*fake as *const Fake as *mut c_void,
        config: h_config,
        admit: h_admit,
        opened: h_opened,
        text: h_text,
        closed: h_closed,
        rejected: h_rejected,
        resource_served: h_served,
        token_ok: h_token_ok,
        origin_ok: h_origin_ok,
        lookup: h_lookup,
        release: h_release,
        log: h_log,
        admit_subprotocol: None,
    };
    let module = unsafe { &*render_stream_net::grc_net_module_v1() };
    let mut vt = std::mem::MaybeUninit::<GrcCarrierV1>::zeroed();
    let mut err = [0 as c_char; 256];
    unsafe { (module.wt_create)(vt.as_mut_ptr(), err.as_mut_ptr(), err.len()) };
    let vt = unsafe { vt.assume_init() };
    assert_eq!(unsafe { (vt.start)(vt.self_, &host, err.as_mut_ptr(), err.len()) }, 0);
    assert!(cstr(&err).starts_with("net-module-abi"), "{}", cstr(&err));
    unsafe { (vt.destroy)(vt.self_) };
}
