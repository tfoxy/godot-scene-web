//! rs-net-lockstep: the hub's credit loop on the `wt` carrier, without a hub (CAR10,
//! carrier-design.md "As built (CAR10)"). A test host for scripts/test/wt-impaired-chromium.ts:
//! it starts the carrier on loopback with a self-signed certificate, waits for one session, then
//! sends a binary live message (`--size` bytes, the first four the u32le sequence number) every
//! `--interval-ms` while fewer than `--window` are unacknowledged. A message is acknowledged by a
//! client text containing `"stage":"applied"` (the client's credit ack, PH3), the same text the
//! browser client sends. Every other text is counted and ignored.
//!
//! stdout: `LOCKSTEP_PORT <udp port>`, `LOCKSTEP_CERT <sha256 hex>`, then one `LOCKSTEP_PROGRESS
//! {json}` per second and one `LOCKSTEP_RESULT {json}` at the end. stderr: the carrier's log
//! (with `--stats-ms`, its per-session QUIC statistics, GRC_NET_DEBUG_STATS_MS).
//! Exit 0 when `--messages` messages were sent and acknowledged, 1 on a stall (no acknowledgement
//! for `--stall-ms` while one is owed), 3 when no session opened within 30 s.
//!
//! Usage: rs-net-lockstep [--messages N] [--size B] [--interval-ms MS] [--window W]
//!                        [--stall-ms MS] [--stats-ms MS] [--listen ADDR:PORT] [--trace FILE]
//! `--listen` other than loopback serves the LAN (expose=lan), for a device leg; the default is
//! 127.0.0.1:0.

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use render_stream_net::abi::*;

mod lockstep_trace;

#[derive(Default)]
struct Fake {
    config: HashMap<String, CString>,
    opened: Mutex<Option<u32>>,
    closed: Mutex<Option<(u16, String)>>,
    texts: AtomicU64,
    credited: AtomicU64,
    outstanding: AtomicU64,
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
unsafe extern "C" fn h_admit(h: *mut c_void, _local: u32) -> c_int {
    c_int::from(fake(h).opened.lock().unwrap().is_none())
}
unsafe extern "C" fn h_opened(h: *mut c_void, local: u32, _sp: *const c_char, _spn: usize, _o: *const c_char, _on: usize) {
    *fake(h).opened.lock().unwrap() = Some(local);
}
unsafe extern "C" fn h_text(h: *mut c_void, _local: u32, d: *const c_char, n: usize) {
    let f = fake(h);
    f.texts.fetch_add(1, Ordering::AcqRel);
    if s(d, n).contains("\"stage\":\"applied\"") {
        f.credited.fetch_add(1, Ordering::AcqRel);
    }
}
unsafe extern "C" fn h_closed(h: *mut c_void, _local: u32, code: u16, r: *const c_char, n: usize) {
    *fake(h).closed.lock().unwrap() = Some((code, s(r, n)));
}
unsafe extern "C" fn h_rejected(_h: *mut c_void, _local: u32, why: c_int, d: *const c_char, n: usize) {
    eprintln!("rs-net-lockstep: rejected {why} {}", s(d, n));
}
unsafe extern "C" fn h_served(_h: *mut c_void, _l: u32, _hash: *const c_char, _st: u16, _c: c_int, _i: u64, _w: u64) {}
unsafe extern "C" fn h_token_ok(_h: *mut c_void, _t: *const c_char, _n: usize) -> c_int {
    1
}
unsafe extern "C" fn h_origin_ok(_h: *mut c_void, _o: *const c_char, _n: usize) -> c_int {
    1 // a loopback test tool: any page origin
}
unsafe extern "C" fn h_lookup(_h: *mut c_void, _hash: *const c_char, _c: c_int, _out: *mut GrcBuf) -> c_int {
    0
}
unsafe extern "C" fn h_release(h: *mut c_void, owner: *mut c_void) {
    fake(h).outstanding.fetch_sub(1, Ordering::AcqRel);
    drop(Box::from_raw(owner as *mut Vec<u8>));
}
unsafe extern "C" fn h_log(_h: *mut c_void, _level: c_int, m: *const c_char, n: usize) {
    eprintln!("{}", s(m, n));
}

fn arg(name: &str, default: u64) -> u64 {
    let a: Vec<String> = std::env::args().collect();
    a.iter()
        .position(|x| x == name)
        .and_then(|i| a.get(i + 1))
        .map(|v| v.parse().unwrap_or_else(|_| panic!("{name} {v} is not a number")))
        .unwrap_or(default)
}

fn main() {
    let total = arg("--messages", 3600);
    let size = arg("--size", 2400).max(4) as usize;
    let interval = Duration::from_millis(arg("--interval-ms", 16));
    let window = arg("--window", 2);
    let stall = Duration::from_millis(arg("--stall-ms", 5000));
    let stats_ms = arg("--stats-ms", 0);
    {
        let a: Vec<String> = std::env::args().collect();
        if let Some(path) = a.iter().position(|x| x == "--trace").and_then(|i| a.get(i + 1)) {
            lockstep_trace::Trace::install(path);
        }
    }
    let listen = {
        let a: Vec<String> = std::env::args().collect();
        a.iter().position(|x| x == "--listen").and_then(|i| a.get(i + 1).cloned()).unwrap_or_else(|| "127.0.0.1:0".into())
    };

    let mut config = HashMap::new();
    for (k, v) in [
        ("wt_listen", listen.clone()),
        ("expose", if listen.starts_with("127.") { "loopback".to_string() } else { "lan".to_string() }),
        ("path", "/render-stream".to_string()),
        ("subprotocols", "render-stream.13".to_string()),
        ("hello_token_subprotocols", "render-stream.13".to_string()),
        ("debug_stats_ms", stats_ms.to_string()),
    ] {
        config.insert(k.to_string(), CString::new(v).unwrap());
    }
    let f: &'static Fake = Box::leak(Box::new(Fake { config, ..Fake::default() }));
    let host: &'static GrcCarrierHostV1 = Box::leak(Box::new(GrcCarrierHostV1 {
        abi_version: GRC_CARRIER_ABI_VERSION,
        size: std::mem::size_of::<GrcCarrierHostV1>() as u32,
        host: f as *const Fake as *mut c_void,
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
        admit_subprotocol: None, // a view-only bench
    }));
    let module = unsafe { &*render_stream_net::grc_net_module_v1() };
    let mut vt = std::mem::MaybeUninit::<GrcCarrierV1>::zeroed();
    let mut err = [0 as c_char; 256];
    assert_eq!(unsafe { (module.wt_create)(vt.as_mut_ptr(), err.as_mut_ptr(), err.len()) }, 1);
    let vt = unsafe { vt.assume_init() };
    if unsafe { (vt.start)(vt.self_, host, err.as_mut_ptr(), err.len()) } != 1 {
        eprintln!("rs-net-lockstep: start: {}", unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy());
        std::process::exit(2);
    }
    let mut info = GrcNetWtInfoV1::default();
    unsafe { (module.wt_info)(vt.self_, &mut info) };
    let cert = unsafe { CStr::from_ptr(info.cert_sha256.as_ptr()) }.to_string_lossy().into_owned();
    println!("LOCKSTEP_PORT {}", info.port);
    println!("LOCKSTEP_CERT {cert}");

    let deadline = Instant::now() + Duration::from_secs(30);
    let local = loop {
        if let Some(l) = *f.opened.lock().unwrap() {
            break l;
        }
        if Instant::now() > deadline {
            println!("LOCKSTEP_RESULT {{\"ok\":false,\"why\":\"no session\"}}");
            std::process::exit(3);
        }
        std::thread::sleep(Duration::from_millis(5));
    };

    let started = Instant::now();
    let mut sent = 0u64;
    let mut next_send = Instant::now();
    let mut next_progress = started + Duration::from_secs(1);
    let mut last_credit = (Instant::now(), 0u64);
    let result = loop {
        let credited = f.credited.load(Ordering::Acquire);
        if credited != last_credit.1 {
            last_credit = (Instant::now(), credited);
        }
        if let Some((code, reason)) = f.closed.lock().unwrap().clone() {
            break (false, format!("closed {code} {reason}"));
        }
        if sent >= total && credited >= total {
            break (true, "done".to_string());
        }
        let now = Instant::now();
        if sent < total && sent < credited + window && now >= next_send {
            let mut m = vec![0u8; size];
            m[..4].copy_from_slice(&(sent as u32).to_le_bytes());
            for (i, b) in m[4..].iter_mut().enumerate() {
                *b = (i as u8).wrapping_mul(31).wrapping_add(sent as u8);
            }
            let mut m = Box::new(m);
            let buf = GrcBuf { data: m.as_mut_ptr(), len: m.len(), owner: Box::into_raw(m) as *mut c_void };
            f.outstanding.fetch_add(1, Ordering::AcqRel);
            if unsafe { (vt.send_binary)(vt.self_, local, buf) } != 1 {
                break (false, "send refused".to_string());
            }
            sent += 1;
            next_send = (next_send + interval).max(now);
        }
        if sent > credited && last_credit.0.elapsed() >= stall {
            break (false, format!("stall: no credit for {} ms", stall.as_millis()));
        }
        if now >= next_progress {
            next_progress += Duration::from_secs(1);
            println!(
                "LOCKSTEP_PROGRESS {{\"t_ms\":{},\"sent\":{sent},\"credited\":{credited},\"texts\":{}}}",
                started.elapsed().as_millis(),
                f.texts.load(Ordering::Acquire)
            );
        }
        std::thread::sleep(Duration::from_micros(500));
    };
    let elapsed = started.elapsed().as_secs_f64();
    let credited = f.credited.load(Ordering::Acquire);
    println!(
        "LOCKSTEP_RESULT {{\"ok\":{},\"why\":\"{}\",\"sent\":{sent},\"credited\":{credited},\"texts\":{},\"seconds\":{elapsed:.3},\"credits_per_s\":{:.2}}}",
        result.0,
        result.1,
        f.texts.load(Ordering::Acquire),
        credited as f64 / elapsed.max(1e-9)
    );
    lockstep_trace::flush();
    let reason = if result.0 { "done" } else { "stall" };
    unsafe { (vt.close)(vt.self_, local, 1000, reason.as_ptr() as *const c_char, reason.len()) };
    std::thread::sleep(Duration::from_millis(300));
    unsafe { (vt.stop)(vt.self_) };
    unsafe { (vt.destroy)(vt.self_) };
    std::process::exit(if result.0 { 0 } else { 1 });
}
