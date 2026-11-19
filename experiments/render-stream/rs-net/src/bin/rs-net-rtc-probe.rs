//! UDP driver for the sans-IO ICE-lite probe; stdout is one discovery JSON line.
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Instant;

use render_stream_net::rtc::{credentials, Engine, EngineOutput, Identity};
use serde_json::json;

fn main() {
    if let Err(error) = run() {
        eprintln!("{}", json!({"event":"fatal", "error":error.to_string()}));
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut bind = None;
    let mut cert_dir = None;
    let mut log_events = true;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bind" => {
                bind = Some(
                    args.next()
                        .ok_or("--bind requires ip:port")?
                        .parse::<SocketAddr>()?,
                )
            }
            "--cert-dir" => {
                cert_dir = Some(PathBuf::from(
                    args.next().ok_or("--cert-dir requires a directory")?,
                ))
            }
            "--log-level" => {
                log_events = match args.next().as_deref() {
                    Some("off" | "error") => false,
                    Some("info" | "debug" | "trace") => true,
                    _ => return Err("--log-level requires off|error|info|debug|trace".into()),
                };
            }
            "--help" | "-h" => {
                println!("rs-net-rtc-probe --bind <ip:port> --cert-dir <dir> [--log-level info]");
                return Ok(());
            }
            _ => return Err(format!("unknown argument: {arg}").into()),
        }
    }
    let bind = bind.ok_or("--bind is required")?;
    if !render_stream_net::rtc::allowed_ip(bind.ip()) {
        return Err("--bind requires a non-loopback unicast LAN address".into());
    }
    let identity = Identity::load_or_create(&cert_dir.ok_or("--cert-dir is required")?)?;
    let socket = std::net::UdpSocket::bind(bind)?;
    let local = socket.local_addr()?;
    let mut engine = Engine::new(local, identity.clone())?;
    let creds = credentials(&identity.fingerprint);
    println!(
        "{}",
        json!({"ip":local.ip().to_string(), "port":local.port(), "fp":identity.fingerprint_url(), "fpHex":identity.fingerprint_hex(), "ufrag":creds.ufrag, "pwd":creds.pass, "sendBudget":render_stream_net::rtc::send_budget()})
    );
    io::stdout().flush()?;
    let mut buffer = [0u8; 65536];
    loop {
        let deadline = loop {
            match engine.poll_output() {
                EngineOutput::Transmit(tx) => {
                    socket.send_to(&tx.contents, tx.destination)?;
                }
                EngineOutput::Event(event) => {
                    if log_events {
                        eprintln!("{event}");
                    }
                }
                EngineOutput::Timeout(deadline) => break deadline,
            }
        };
        let now = Instant::now();
        if let Some(deadline) = deadline {
            if deadline <= now {
                engine.timeout(now);
                continue;
            }
            socket.set_read_timeout(Some(deadline - now))?;
        } else {
            socket.set_read_timeout(None)?;
        }
        match socket.recv_from(&mut buffer) {
            Ok((len, source)) => engine.receive(Instant::now(), source, &buffer[..len])?,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                engine.timeout(Instant::now())
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
}
