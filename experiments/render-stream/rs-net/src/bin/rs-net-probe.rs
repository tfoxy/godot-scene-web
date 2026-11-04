//! rs-net-probe: a render-stream-wt/1 client (carrier-design.md Q4) for the interop leg
//! (scripts/test/self-test-wt-interop.ts) and by hand.
//!
//! It opens a session to `--url` (the full `https://.../render-stream?protocol=render-stream.<N>`)
//! pinning `--cert-sha256`, opens the live stream, sends `--hello` as its first text message, and
//! reads live messages until the session ends, checking the framing strictly. Every binary
//! message is appended to `<out>/received.rs2` (the bytes a tap holds, D13); `<out>/probe.json`
//! records the messages, the texts, the close and any `--fetch` resource GETs.
//!
//! Usage:
//!   rs-net-probe --url URL --cert-sha256 HEX --out DIR [--hello JSON] [--origin ORIGIN]
//!                [--token HEX] [--fetch PATH]... [--gzip] [--close-after-ms N]
//! Exit: 0 when the session opened and ended without a framing error, 3 when it never opened,
//! 4 on a framing error.

use std::io::Write;
use std::time::{Duration, Instant};

use wtransport::endpoint::ConnectOptions;
use wtransport::tls::Sha256Digest;
use wtransport::{ClientConfig, Endpoint};

struct Args {
    url: String,
    cert: String,
    out: std::path::PathBuf,
    hello: Option<String>,
    origin: Option<String>,
    token: String,
    fetch: Vec<String>,
    gzip: bool,
    close_after_ms: Option<u64>,
}

fn parse() -> Result<Args, String> {
    let mut a = Args {
        url: String::new(),
        cert: String::new(),
        out: ".".into(),
        hello: None,
        origin: None,
        token: String::new(),
        fetch: vec![],
        gzip: false,
        close_after_ms: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut v = || it.next().ok_or_else(|| format!("{k} needs a value"));
        match k.as_str() {
            "--url" => a.url = v()?,
            "--cert-sha256" => a.cert = v()?,
            "--out" => a.out = v()?.into(),
            "--hello" => a.hello = Some(v()?),
            "--origin" => a.origin = Some(v()?),
            "--token" => a.token = v()?,
            "--fetch" => a.fetch.push(v()?),
            "--gzip" => a.gzip = true,
            "--close-after-ms" => a.close_after_ms = Some(v()?.parse().map_err(|_| "bad --close-after-ms")?),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if a.url.is_empty() || a.cert.len() != 64 {
        return Err("--url and a 64-hex --cert-sha256 are required".into());
    }
    Ok(a)
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let a = match parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("rs-net-probe: {e}");
            std::process::exit(2);
        }
    };
    std::fs::create_dir_all(&a.out).expect("out dir");
    let mut digest = [0u8; 32];
    for (i, d) in digest.iter_mut().enumerate() {
        *d = u8::from_str_radix(&a.cert[2 * i..2 * i + 2], 16).expect("hex");
    }
    let config = ClientConfig::builder()
        .with_bind_default()
        .with_server_certificate_hashes([Sha256Digest::new(digest)])
        .build();
    let ep = Endpoint::client(config).expect("client endpoint");
    let mut opts = ConnectOptions::builder(&a.url);
    if let Some(o) = &a.origin {
        opts = opts.add_header("origin", o);
    }
    let t0 = Instant::now();
    let conn = match ep.connect(opts.build()).await {
        Ok(c) => c,
        Err(e) => {
            println!("PROBE_CONNECT_FAILED {e}");
            std::process::exit(3);
        }
    };
    let connect_ms = t0.elapsed().as_secs_f64() * 1e3;
    println!("PROBE_OPEN {connect_ms:.2}ms");
    let (mut send, mut recv) = conn.open_bi().await.expect("open_bi").await.expect("live stream");
    let mut first = vec![0x00u8];
    if let Some(h) = &a.hello {
        first.push(1);
        first.extend_from_slice(&(h.len() as u32).to_le_bytes());
        first.extend_from_slice(h.as_bytes());
    }
    send.write_all(&first).await.expect("hello");

    let mut rs2 = std::fs::File::create(a.out.join("received.rs2")).expect("received.rs2");
    let mut texts: Vec<String> = vec![];
    let mut sizes: Vec<usize> = vec![];
    let mut first_message_ms: Option<f64> = None;
    let mut framing_error: Option<String> = None;
    let mut resources: Vec<String> = vec![];
    let mut fetched = a.fetch.is_empty();
    let mut buf: Vec<u8> = vec![];
    let mut chunk = vec![0u8; 1 << 16];
    let close_at = a.close_after_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    loop {
        let read = match close_at {
            Some(t) => match tokio::time::timeout_at(t.into(), recv.read(&mut chunk)).await {
                Ok(r) => r,
                Err(_) => {
                    conn.close_session(1000, b"probe done");
                    break;
                }
            },
            None => recv.read(&mut chunk).await,
        };
        match read {
            Ok(Some(n)) => buf.extend_from_slice(&chunk[..n]),
            Ok(None) | Err(_) => break,
        }
        let mut at = 0;
        while buf.len() - at >= 5 {
            let kind = buf[at];
            let len = u32::from_le_bytes(buf[at + 1..at + 5].try_into().unwrap()) as usize;
            if kind > 1 {
                framing_error = Some(format!("unknown kind {kind} after {} messages", sizes.len()));
                break;
            }
            if buf.len() - at < 5 + len {
                break;
            }
            let body = &buf[at + 5..at + 5 + len];
            if kind == 0 {
                rs2.write_all(body).expect("write");
            } else {
                match std::str::from_utf8(body) {
                    Ok(t) => texts.push(t.to_string()),
                    Err(_) => framing_error = Some("text message is not UTF-8".into()),
                }
            }
            first_message_ms.get_or_insert(t0.elapsed().as_secs_f64() * 1e3);
            sizes.push(len);
            at += 5 + len;
        }
        if framing_error.is_some() {
            break;
        }
        buf.drain(..at);
        if !fetched && !sizes.is_empty() {
            fetched = true;
            for p in &a.fetch {
                let r = fetch(&conn, p, &a.token, a.gzip).await;
                resources.push(r);
            }
        }
    }
    if framing_error.is_none() && !buf.is_empty() {
        framing_error = Some(format!("{} bytes of a partial message at the end", buf.len()));
    }
    let close = match tokio::time::timeout(Duration::from_secs(5), conn.session_closed()).await {
        Ok(Some((code, reason))) => {
            format!("{{\"code\":{code},\"reason\":{}}}", json_str(&String::from_utf8_lossy(&reason)))
        }
        _ => "null".to_string(),
    };
    let summary = format!(
        "{{\"schema\":\"rs-net-probe/1\",\"url\":{},\"connect_ms\":{connect_ms:.3},\"first_message_ms\":{},\"messages\":{},\"binary_bytes\":{},\"sizes\":[{}],\"texts\":[{}],\"close\":{close},\"framing_error\":{},\"resources\":[{}]}}\n",
        json_str(&a.url),
        first_message_ms.map(|v| format!("{v:.3}")).unwrap_or_else(|| "null".into()),
        sizes.len(),
        sizes.iter().sum::<usize>(),
        sizes.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(","),
        texts.iter().map(|t| json_str(t)).collect::<Vec<_>>().join(","),
        framing_error.as_deref().map(json_str).unwrap_or_else(|| "null".into()),
        resources.join(","),
    );
    std::fs::write(a.out.join("probe.json"), &summary).expect("probe.json");
    print!("{summary}");
    std::process::exit(if framing_error.is_some() { 4 } else { 0 });
}

async fn fetch(conn: &wtransport::Connection, path: &str, token: &str, gzip: bool) -> String {
    let result = async {
        let (mut s, mut r) = conn.open_bi().await.map_err(|e| e.to_string())?.await.map_err(|e| e.to_string())?;
        let mut req = vec![0x01, u8::from(gzip)];
        req.extend_from_slice(&(path.len() as u16).to_le_bytes());
        req.extend_from_slice(path.as_bytes());
        req.push(token.len() as u8);
        req.extend_from_slice(token.as_bytes());
        s.write_all(&req).await.map_err(|e| e.to_string())?;
        s.finish().await.map_err(|e| e.to_string())?;
        let mut res = vec![];
        let mut chunk = vec![0u8; 1 << 16];
        while let Some(n) = r.read(&mut chunk).await.map_err(|e| e.to_string())? {
            res.extend_from_slice(&chunk[..n]);
        }
        if res.len() < 7 {
            return Err("truncated response".to_string());
        }
        let len = u32::from_le_bytes(res[3..7].try_into().unwrap()) as usize;
        if res.len() != 7 + len {
            return Err(format!("body of {} bytes, header says {len}", res.len() - 7));
        }
        Ok((u16::from_le_bytes([res[0], res[1]]), res[2], len))
    }
    .await;
    match result {
        Ok((status, coding, len)) => format!(
            "{{\"path\":{},\"status\":{status},\"coding\":{coding},\"bytes\":{len}}}",
            json_str(path)
        ),
        Err(e) => format!("{{\"path\":{},\"error\":{}}}", json_str(path), json_str(&e)),
    }
}
