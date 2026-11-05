//! The sans-IO TLS server session (src/tls.rs) through its C ABI, `grc_net_tls_v1()`, exactly as
//! the capture's `ws` carrier drives it (carrier-design.md D12, CAR4 "Checks"), against a rustls
//! client. The certificates are generated here, at test time (a test CA and a leaf it signs),
//! written to a temporary directory and never committed.

use std::ffi::{c_char, c_void, CStr, CString};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, PKCS_ECDSA_P256_SHA256};
use render_stream_net::abi::*;
use render_stream_net::tls::*;
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, ClientConnection, RootCertStore};

fn b64(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                s.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

fn pem(label: &str, der: &[u8]) -> String {
    let body = b64(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for line in body.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(line).unwrap());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

struct Pki {
    dir: PathBuf,
    ca_der: CertificateDer<'static>,
    leaf_der: Vec<u8>,
}

impl Pki {
    fn path(&self, name: &str) -> String {
        self.dir.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Pki {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// ca.pem, cert.pem (leaf for localhost / 127.0.0.1), key.pem, other-key.pem (not the leaf's),
/// empty.pem, garbage.pem.
fn pki(tag: &str) -> Pki {
    let dir = std::env::temp_dir().join(format!("rs-net-tls-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.distinguished_name.push(DnType::CommonName, "render-stream test CA");
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca_cert = ca_params.self_signed(&ca_key).unwrap();
    let issuer = Issuer::new(ca_params, ca_key);
    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let mut leaf_params = CertificateParams::new(vec!["localhost".to_string(), "127.0.0.1".to_string()]).unwrap();
    leaf_params.distinguished_name.push(DnType::CommonName, "localhost");
    let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();
    let other_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    std::fs::write(dir.join("ca.pem"), pem("CERTIFICATE", ca_cert.der())).unwrap();
    std::fs::write(dir.join("cert.pem"), pem("CERTIFICATE", leaf.der())).unwrap();
    std::fs::write(dir.join("key.pem"), pem("PRIVATE KEY", &leaf_key.serialize_der())).unwrap();
    std::fs::write(dir.join("other-key.pem"), pem("PRIVATE KEY", &other_key.serialize_der())).unwrap();
    std::fs::write(dir.join("empty.pem"), "").unwrap();
    std::fs::write(dir.join("garbage.pem"), "-----BEGIN CERTIFICATE-----\nnot base64!\n-----END CERTIFICATE-----\n").unwrap();
    Pki { dir, ca_der: ca_cert.der().clone(), leaf_der: leaf.der().to_vec() }
}

fn table() -> &'static GrcNetTlsV1 {
    let t = unsafe { &*render_stream_net::grc_net_tls_v1() };
    assert_eq!(t.abi_version, GRC_NET_TLS_ABI_VERSION);
    assert_eq!(t.size as usize, std::mem::size_of::<GrcNetTlsV1>());
    t
}

fn config(t: &GrcNetTlsV1, cert: &str, key: &str) -> Result<*mut c_void, String> {
    let c = CString::new(cert).unwrap();
    let k = CString::new(key).unwrap();
    let mut err = [0 as c_char; 512];
    let p = unsafe { (t.config_create)(c.as_ptr(), k.as_ptr(), err.as_mut_ptr(), err.len()) };
    if p.is_null() {
        Err(unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy().into_owned())
    } else {
        Ok(p)
    }
}

/// A server session driven through the C ABI.
struct Server {
    t: &'static GrcNetTlsV1,
    s: *mut c_void,
}

impl Server {
    fn new(t: &'static GrcNetTlsV1, cfg: *mut c_void) -> Server {
        let mut err = [0 as c_char; 256];
        let s = unsafe { (t.session_create)(cfg, err.as_mut_ptr(), err.len()) };
        assert!(!s.is_null());
        Server { t, s }
    }
    fn feed(&self, data: &[u8]) -> i64 {
        unsafe { (self.t.feed)(self.s, data.as_ptr(), data.len()) }
    }
    fn read_all(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = unsafe { (self.t.read)(self.s, buf.as_mut_ptr(), buf.len()) };
            assert!(n >= 0, "read failed: {}", self.error());
            if n == 0 {
                return out;
            }
            out.extend_from_slice(&buf[..n as usize]);
        }
    }
    fn write(&self, data: &[u8]) -> i64 {
        unsafe { (self.t.write)(self.s, data.as_ptr(), data.len()) }
    }
    fn take_all(&self, cap: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = vec![0u8; cap];
        loop {
            let n = unsafe { (self.t.take)(self.s, buf.as_mut_ptr(), buf.len()) };
            if n <= 0 {
                return out;
            }
            out.extend_from_slice(&buf[..n as usize]);
        }
    }
    fn state(&self) -> u32 {
        unsafe { (self.t.state)(self.s) }
    }
    fn error(&self) -> String {
        let mut err = [0 as c_char; 256];
        unsafe { (self.t.error)(self.s, err.as_mut_ptr(), err.len()) };
        unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy().into_owned()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        unsafe { (self.t.session_destroy)(self.s) };
    }
}

fn client(p: &Pki, alpn: &[&[u8]]) -> ClientConnection {
    let mut roots = RootCertStore::empty();
    roots.add(p.ca_der.clone()).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    cfg.alpn_protocols = alpn.iter().map(|a| a.to_vec()).collect();
    let mut c = ClientConnection::new(Arc::new(cfg), ServerName::try_from("localhost").unwrap()).unwrap();
    c.set_buffer_limit(None);
    c
}

/// Moves bytes between the client and the server session until neither has anything to say.
/// The server's ciphertext is taken through `take_cap`-byte windows and fed `feed_chunk` bytes at
/// a time, so short windows and partial feeds are exercised.
fn pump(c: &mut ClientConnection, s: &Server, feed_chunk: usize, take_cap: usize, got: &mut Vec<u8>) {
    let mut sink = Vec::new();
    pump2(c, s, feed_chunk, take_cap, got, &mut sink);
    assert!(sink.is_empty(), "unexpected plaintext to the client");
}

/// As pump, collecting the client's plaintext into `to_client`.
fn pump2(c: &mut ClientConnection, s: &Server, feed_chunk: usize, take_cap: usize, got: &mut Vec<u8>, to_client: &mut Vec<u8>) {
    for _ in 0..100_000 {
        let mut moved = false;
        let mut to_server = Vec::new();
        while c.wants_write() {
            c.write_tls(&mut to_server).unwrap();
        }
        let mut off = 0;
        while off < to_server.len() {
            let end = (off + feed_chunk).min(to_server.len());
            let n = s.feed(&to_server[off..end]);
            assert!(n >= 0, "feed failed: {}", s.error());
            off += n as usize;
            got.extend(s.read_all());
            moved = true;
        }
        got.extend(s.read_all());
        let from_server = s.take_all(take_cap);
        if !from_server.is_empty() {
            moved = true;
            let mut rd = &from_server[..];
            while !rd.is_empty() {
                match c.read_tls(&mut rd) {
                    Ok(_) => {
                        c.process_new_packets().unwrap();
                    }
                    Err(_) => to_client.extend(client_read(c)),
                }
                to_client.extend(client_read(c));
            }
        }
        if !moved {
            return;
        }
    }
    panic!("pump did not settle");
}

fn client_read(c: &mut ClientConnection) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        match c.reader().read(&mut buf) {
            Ok(0) => return out,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return out,
            Err(e) => panic!("client read: {e}"),
        }
    }
}

fn pattern(n: usize, m: usize) -> Vec<u8> {
    (0..n).map(|i| (i % m) as u8).collect()
}

#[test]
fn layout_and_version() {
    let t = table();
    assert!(!t.module_version.is_null());
    let v = unsafe { CStr::from_ptr(t.module_version) }.to_str().unwrap();
    assert!(v.starts_with("render-stream-net "), "{v}");
}

#[test]
fn handshake_and_both_directions() {
    let p = pki("both");
    let t = table();
    let cfg = config(t, &p.path("cert.pem"), &p.path("key.pem")).unwrap();
    let mut sha = [0 as c_char; 65];
    assert_eq!(unsafe { (t.config_cert_sha256)(cfg, sha.as_mut_ptr(), sha.len()) }, 1);
    let sha = unsafe { CStr::from_ptr(sha.as_ptr()) }.to_str().unwrap().to_string();
    let want = ring::digest::digest(&ring::digest::SHA256, &p.leaf_der);
    assert_eq!(sha, render_stream_net::cert::hex(want.as_ref()));

    let s = Server::new(t, cfg);
    assert_ne!(s.state() & GRC_TLS_HANDSHAKING, 0);
    let mut c = client(&p, &[b"h2", b"http/1.1"]);
    let mut got = Vec::new();
    // The handshake fed one byte at a time, and taken seven bytes at a time.
    pump(&mut c, &s, 1, 7, &mut got);
    assert!(!c.is_handshaking());
    assert_eq!(s.state() & GRC_TLS_HANDSHAKING, 0, "server still handshaking");
    assert_eq!(c.alpn_protocol(), Some(&b"http/1.1"[..]), "ALPN must pick http/1.1");
    assert_eq!(c.protocol_version(), Some(rustls::ProtocolVersion::TLSv1_3));

    // Client -> server: a request head, then 3 MiB (more than rustls buffers as unread plaintext,
    // so feed must return a partial count and resume after a read).
    let head = b"GET /render-stream HTTP/1.1\r\nHost: localhost\r\n\r\n".to_vec();
    c.writer().write_all(&head).unwrap();
    let big = pattern(3 << 20, 251);
    c.writer().write_all(&big).unwrap();
    pump(&mut c, &s, 1 << 20, 1 << 16, &mut got);
    let mut want_in = head.clone();
    want_in.extend_from_slice(&big);
    assert_eq!(got.len(), want_in.len());
    assert!(got == want_in, "plaintext in differs");

    // Server -> client: 8 MiB in uneven writes.
    let out = pattern(8 << 20, 256);
    let mut off = 0;
    let mut step = 1usize;
    while off < out.len() {
        let end = (off + step).min(out.len());
        assert_eq!(s.write(&out[off..end]), (end - off) as i64);
        off = end;
        step = step * 3 + 17;
    }
    assert_ne!(s.state() & GRC_TLS_WANTS_WRITE, 0);
    let mut nothing = Vec::new();
    let mut received = Vec::new();
    pump2(&mut c, &s, 1 << 16, 1 << 16, &mut nothing, &mut received);
    received.extend(client_read(&mut c));
    assert!(nothing.is_empty());
    assert_eq!(received.len(), out.len());
    assert!(received == out, "plaintext out differs");

    // close_notify both ways.
    c.send_close_notify();
    pump(&mut c, &s, 4096, 4096, &mut nothing);
    assert_ne!(s.state() & GRC_TLS_PEER_CLOSED, 0);
    unsafe { (t.close_notify)(s.s) };
    pump(&mut c, &s, 4096, 4096, &mut nothing);
    let st = c.process_new_packets().unwrap();
    assert!(st.peer_has_closed());
    drop(s);
    unsafe { (t.config_destroy)(cfg) };
}

#[test]
fn a_client_without_alpn_still_connects() {
    let p = pki("noalpn");
    let t = table();
    let cfg = config(t, &p.path("cert.pem"), &p.path("key.pem")).unwrap();
    let s = Server::new(t, cfg);
    let mut c = client(&p, &[]);
    let mut got = Vec::new();
    pump(&mut c, &s, 4096, 4096, &mut got);
    assert!(!c.is_handshaking());
    drop(s);
    unsafe { (t.config_destroy)(cfg) };
}

#[test]
fn plaintext_http_fails_the_session_with_an_alert() {
    let p = pki("plain");
    let t = table();
    let cfg = config(t, &p.path("cert.pem"), &p.path("key.pem")).unwrap();
    let s = Server::new(t, cfg);
    let n = s.feed(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    assert!(n <= 0 || s.state() & GRC_TLS_FAILED != 0);
    assert_ne!(s.state() & GRC_TLS_FAILED, 0);
    assert!(!s.error().is_empty());
    // Every later call refuses; the alert can still be taken.
    assert_eq!(s.feed(b"x"), -1);
    assert_eq!(s.write(b"x"), -1);
    let alert = s.take_all(64);
    assert!(!alert.is_empty() && alert[0] == 0x15, "an alert record: {alert:?}");
    drop(s);
    unsafe { (t.config_destroy)(cfg) };
}

#[test]
fn a_bad_pair_is_tls_config_invalid() {
    let p = pki("bad");
    let t = table();
    let cases = [
        ("cert.pem", "other-key.pem"),
        ("cert.pem", "missing.pem"),
        ("missing.pem", "key.pem"),
        ("empty.pem", "key.pem"),
        ("garbage.pem", "key.pem"),
        ("cert.pem", "empty.pem"),
        ("key.pem", "cert.pem"),
    ];
    for (cert, key) in cases {
        let e = config(t, &p.path(cert), &p.path(key)).map(|c| unsafe { (t.config_destroy)(c) });
        let e = e.expect_err(&format!("{cert} / {key} must be refused"));
        assert!(e.starts_with("tls-config-invalid: "), "{cert} / {key}: {e}");
    }
    let e = config(t, &p.path("cert.pem"), &p.path("other-key.pem")).unwrap_err();
    assert!(e.contains("KeyMismatch") || e.to_lowercase().contains("key"), "{e}");
    // Null paths.
    let mut err = [0 as c_char; 128];
    let n = unsafe { (t.config_create)(std::ptr::null(), std::ptr::null(), err.as_mut_ptr(), err.len()) };
    assert!(n.is_null());
}

#[test]
fn null_handles_are_harmless() {
    let t = table();
    unsafe {
        assert_eq!((t.feed)(std::ptr::null_mut(), b"x".as_ptr(), 1), -1);
        assert_eq!((t.take)(std::ptr::null_mut(), std::ptr::null_mut(), 0), 0);
        (t.session_destroy)(std::ptr::null_mut());
        (t.config_destroy)(std::ptr::null_mut());
        let mut err = [0 as c_char; 64];
        assert!((t.session_create)(std::ptr::null(), err.as_mut_ptr(), err.len()).is_null());
    }
}
