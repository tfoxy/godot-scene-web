//! Minimal repro: Chrome on Android stops sending on a long-lived WebTransport bidirectional stream.
//! See README.md. One session, one client-opened bidirectional stream, a lockstep on it:
//!
//! - the server sends a binary message (`--size` bytes) every `--interval-ms` while fewer than
//!   `--window` messages are unanswered;
//! - the page answers each message with short text messages; the one with `"stage":"applied"`
//!   answers it.
//!
//! Every message, both directions, is framed `u8 kind (0 binary, 1 text) | u32le length | bytes`.
//! Any further bidirectional stream the page opens is a probe: the server prints the page's text
//! and answers `probe-ok`, which shows the session still carries new streams.
//!
//! Usage: chromium-wt-send-wedge --lan <host LAN IP> [--wt-port 4433] [--http-port 8080]
//!        [--size 2000] [--interval-ms 16] [--window 2] [--stall-s 5] [--hold-s 30]
//!        [--seconds 120] [--trace FILE]
//! Exit 0 when `--seconds` passed without a stall, 1 on a stall, 2 on a setup error.

mod trace;

use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use wtransport::endpoint::IncomingSession;
use wtransport::quinn::TransportConfig;
use wtransport::tls::Sha256DigestFmt;
use wtransport::{Connection, Endpoint, Identity, RecvStream, SendStream, ServerConfig, VarInt};

const PAGE: &str = include_str!("../page.html");

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}
fn num(name: &str, default: u64) -> u64 {
    arg(name).map(|v| v.parse().unwrap_or_else(|_| panic!("{name} {v}: not a number"))).unwrap_or(default)
}

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
fn t() -> f64 {
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}
macro_rules! say {
    ($($a:tt)*) => {{ println!("{:8.3} {}", t(), format!($($a)*)); }};
}

/// Answers received on the lockstep stream.
#[derive(Default)]
struct Answers {
    texts: AtomicU64,
    applied: AtomicU64,
    bytes: AtomicU64,
    last: Mutex<Option<(f64, String)>>,
}

/// Reads one framed message, or None at FIN.
async fn read_frame(r: &mut RecvStream, buf: &mut Vec<u8>) -> Result<Option<(u8, Vec<u8>)>, String> {
    let mut chunk = [0u8; 4096];
    loop {
        if buf.len() >= 5 {
            let len = u32::from_le_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;
            if len > 1 << 20 {
                return Err(format!("frame length {len}"));
            }
            if buf.len() >= 5 + len {
                let kind = buf[0];
                let body = buf[5..5 + len].to_vec();
                buf.drain(..5 + len);
                return Ok(Some((kind, body)));
            }
        }
        match r.read(&mut chunk).await.map_err(|e| e.to_string())? {
            Some(n) => buf.extend_from_slice(&chunk[..n]),
            None if buf.is_empty() => return Ok(None),
            None => return Err("FIN inside a frame".into()),
        }
    }
}

fn frame(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(5 + body.len());
    f.push(kind);
    f.extend_from_slice(&(body.len() as u32).to_le_bytes());
    f.extend_from_slice(body);
    f
}

fn quic(conn: &Connection) -> String {
    let s = conn.quic_connection().stats();
    format!(
        "rtt={}ms lost_pkts={} udp_rx={} udp_tx={} rx_frames[stream={} ack={} ping={} stream_data_blocked={} data_blocked={}] tx_frames[stream={} ping={} max_stream_data={}]",
        s.path.rtt.as_millis(),
        s.path.lost_packets,
        s.udp_rx.datagrams,
        s.udp_tx.datagrams,
        s.frame_rx.stream,
        s.frame_rx.acks,
        s.frame_rx.ping,
        s.frame_rx.stream_data_blocked,
        s.frame_rx.data_blocked,
        s.frame_tx.stream,
        s.frame_tx.ping,
        s.frame_tx.max_stream_data,
    )
}

/// Every bidirectional stream after the first: print the page's text, answer `probe-ok`.
async fn probes(conn: Connection) {
    loop {
        let Ok((mut send, mut recv)) = conn.accept_bi().await else { return };
        tokio::spawn(async move {
            let id = recv.id();
            let mut buf = Vec::new();
            let mut texts = Vec::new();
            loop {
                match read_frame(&mut recv, &mut buf).await {
                    Ok(Some((_, body))) => texts.push(String::from_utf8_lossy(&body).into_owned()),
                    Ok(None) => break,
                    Err(e) => {
                        say!("PROBE {id:?}: {e}");
                        return;
                    }
                }
            }
            let ok = send.write_all(&frame(1, b"probe-ok")).await.is_ok() && send.finish().await.is_ok();
            say!("PROBE new stream {id:?} read to FIN, answered probe-ok ({}): {}", if ok { "sent" } else { "send failed" }, texts.join(" | "));
        });
    }
}

async fn lockstep_reader(mut recv: RecvStream, answers: Arc<Answers>) {
    let mut buf = Vec::new();
    loop {
        match read_frame(&mut recv, &mut buf).await {
            Ok(Some((kind, body))) => {
                answers.bytes.fetch_add(5 + body.len() as u64, Ordering::AcqRel);
                if kind != 1 {
                    continue;
                }
                let text = String::from_utf8_lossy(&body).into_owned();
                answers.texts.fetch_add(1, Ordering::AcqRel);
                if text.contains("\"stage\":\"applied\"") {
                    answers.applied.fetch_add(1, Ordering::AcqRel);
                }
                *answers.last.lock().unwrap() = Some((t(), text));
            }
            Ok(None) => {
                say!("lockstep stream: FIN from the page");
                return;
            }
            Err(e) => {
                say!("lockstep stream: read ended: {e}");
                return;
            }
        }
    }
}

async fn session(incoming: IncomingSession, opt: Opt) -> i32 {
    let req = match incoming.await {
        Ok(r) => r,
        Err(e) => {
            say!("session request failed: {e}");
            return 2;
        }
    };
    say!("session request {} from origin {:?}", req.path(), req.origin());
    let conn = match req.accept().await {
        Ok(c) => c,
        Err(e) => {
            say!("accept failed: {e}");
            return 2;
        }
    };
    say!("session accepted, remote {}", conn.remote_address());
    let (mut send, mut recv): (SendStream, RecvStream) = match conn.accept_bi().await {
        Ok(s) => s,
        Err(e) => {
            say!("no stream: {e}");
            return 2;
        }
    };
    let mut buf = Vec::new();
    match read_frame(&mut recv, &mut buf).await {
        Ok(Some((_, hello))) => say!("lockstep stream {:?} opened, hello {}", recv.id(), String::from_utf8_lossy(&hello)),
        other => {
            say!("no hello: {other:?}");
            return 2;
        }
    }
    tokio::spawn(probes(conn.clone()));
    let answers = Arc::new(Answers::default());
    tokio::spawn(lockstep_reader(recv, answers.clone()));

    let started = Instant::now();
    let mut sent = 0u64;
    let mut next_send = Instant::now();
    let mut next_progress = started + Duration::from_secs(1);
    let mut last_answer = (Instant::now(), 0u64);
    let mut stalled_at: Option<Instant> = None;
    loop {
        let applied = answers.applied.load(Ordering::Acquire);
        let now = Instant::now();
        if applied != last_answer.1 {
            if let Some(at) = stalled_at.take() {
                say!("answers resumed after {:.1} s", at.elapsed().as_secs_f64());
            }
            last_answer = (now, applied);
        }
        if stalled_at.is_none() && sent < applied + opt.window && now >= next_send {
            let mut m = vec![0u8; opt.size];
            m[..4].copy_from_slice(&(sent as u32).to_le_bytes());
            for (i, b) in m[4..].iter_mut().enumerate() {
                *b = (i as u8).wrapping_mul(31).wrapping_add(sent as u8);
            }
            if send.write_all(&frame(0, &m)).await.is_err() {
                say!("send failed: the session ended");
                return 2;
            }
            sent += 1;
            next_send = (next_send + opt.interval).max(now);
        }
        if stalled_at.is_none() && sent > applied && last_answer.0.elapsed() >= opt.stall {
            stalled_at = Some(now);
            let last = answers.last.lock().unwrap().clone();
            say!(
                "STALL: no answer for {} s while {} of {sent} messages are unanswered. Answers so far: {applied} \
                 (texts {}, {} bytes). Last text at t={:.3}: {}",
                opt.stall.as_secs(),
                sent - applied,
                answers.texts.load(Ordering::Acquire),
                answers.bytes.load(Ordering::Acquire),
                last.as_ref().map(|l| l.0).unwrap_or(0.0),
                last.map(|l| l.1).unwrap_or_default(),
            );
            say!("STALL quic: {}", quic(&conn));
        }
        if now >= next_progress {
            next_progress += Duration::from_secs(1);
            say!(
                "{} sent={sent} answered={applied} texts={} {}",
                if stalled_at.is_some() { "stalled" } else { "progress" },
                answers.texts.load(Ordering::Acquire),
                quic(&conn)
            );
        }
        if let Some(at) = stalled_at {
            if at.elapsed() >= opt.hold {
                say!("RESULT stall: {applied}/{sent} answered; the last answer came {:.1} s into the lockstep", (last_answer.0 - started).as_secs_f64());
                conn.close(VarInt::from_u32(0), b"stall");
                return 1;
            }
        } else if started.elapsed() >= opt.seconds {
            say!("RESULT no stall: {applied}/{sent} answered in {} s", opt.seconds.as_secs());
            conn.close(VarInt::from_u32(0), b"done");
            return 0;
        }
        tokio::time::sleep(Duration::from_micros(500)).await;
    }
}

#[derive(Clone)]
struct Opt {
    size: usize,
    interval: Duration,
    window: u64,
    stall: Duration,
    hold: Duration,
    seconds: Duration,
}

fn serve_page(port: u16, page: String) {
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap_or_else(|e| {
        eprintln!("cannot bind 127.0.0.1:{port}: {e}");
        std::process::exit(2)
    });
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let mut req = [0u8; 2048];
            let n = s.read(&mut req).unwrap_or(0);
            let line = String::from_utf8_lossy(&req[..n]).lines().next().unwrap_or("").to_string();
            let (status, body) = if line.starts_with("GET / ") || line.starts_with("GET /?") {
                ("200 OK", page.as_str())
            } else {
                ("404 Not Found", "")
            };
            let _ = write!(
                s,
                "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncache-control: no-store\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
}

#[tokio::main]
async fn main() {
    t();
    let Some(lan) = arg("--lan") else {
        eprintln!("usage: chromium-wt-send-wedge --lan <this host's LAN IP> [options], see README.md");
        std::process::exit(2);
    };
    let lan: IpAddr = lan.parse().expect("--lan: an IP address");
    let wt_port = num("--wt-port", 4433) as u16;
    let http_port = num("--http-port", 8080) as u16;
    let opt = Opt {
        size: num("--size", 2000).max(4) as usize,
        interval: Duration::from_millis(num("--interval-ms", 16)),
        window: num("--window", 2),
        stall: Duration::from_secs(num("--stall-s", 5)),
        hold: Duration::from_secs(num("--hold-s", 30)),
        seconds: Duration::from_secs(num("--seconds", 120)),
    };
    if let Some(path) = arg("--trace") {
        trace::Trace::install(&path);
    }

    // Self-signed ECDSA P-256, valid 14 days: what serverCertificateHashes accepts.
    let identity = Identity::self_signed(["localhost".to_string(), lan.to_string()]).expect("certificate");
    let hash = identity.certificate_chain().as_slice()[0].hash().fmt(Sha256DigestFmt::DottedHex).replace(':', "");
    let mut transport = TransportConfig::default();
    transport
        .max_idle_timeout(Some(Duration::from_secs(30).try_into().unwrap()))
        .keep_alive_interval(Some(Duration::from_secs(5)));
    let config = ServerConfig::builder()
        .with_bind_address(SocketAddr::new(lan, wt_port))
        .with_custom_transport(identity, transport)
        .build();
    let endpoint = Endpoint::server(config).unwrap_or_else(|e| {
        eprintln!("cannot bind {lan}:{wt_port}/udp: {e}");
        std::process::exit(2)
    });
    let url = format!("https://{lan}:{wt_port}/wedge");
    serve_page(http_port, PAGE.replace("__WT_URL__", &url).replace("__CERT_SHA256__", &hash));
    say!("WebTransport {url}, certificate sha-256 {hash}");
    say!("page http://127.0.0.1:{http_port}/ (on the phone: adb reverse tcp:{http_port} tcp:{http_port}, then open http://localhost:{http_port}/)");
    say!(
        "lockstep: {} B every {} ms, window {}, stall after {} s without an answer",
        opt.size,
        opt.interval.as_millis(),
        opt.window,
        opt.stall.as_secs()
    );

    let incoming = endpoint.accept().await;
    let code = session(incoming, opt).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    trace::flush();
    std::process::exit(code);
}
