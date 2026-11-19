use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use str0m::channel::ChannelConfig;
use str0m::ice::TransId;

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.local/rtc-g0")
            .join(format!(
                "test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn identity() -> Identity {
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let cert = rcgen::CertificateParams::default()
        .self_signed(&key)
        .unwrap();
    Identity::from_der(cert.der().to_vec(), key.serialize_der())
}
fn local() -> SocketAddr {
    "192.0.2.1:45001".parse().unwrap()
}
fn remote() -> SocketAddr {
    "192.0.2.2:45002".parse().unwrap()
}
fn request(ufrag: &str, password: &str) -> Vec<u8> {
    let username = format!("{ufrag}:browserUfrag");
    let message =
        StunMessage::binding_request(&username, TransId::new(), true, 1, 2130706431, true);
    let mut bytes = vec![0; 1024];
    let provider = str0m_rust_crypto::default_provider();
    let len = message
        .to_bytes(Some(password.as_bytes()), &mut bytes, |key, parts| {
            provider.sha1_hmac_provider.sha1_hmac(key, parts)
        })
        .unwrap();
    bytes.truncate(len);
    bytes
}

#[test]
fn credential_vector() {
    let fingerprint = std::array::from_fn(|i| i as u8);
    let creds = credentials(&fingerprint);
    assert_eq!(creds.ufrag, "LifiPYYP");
    assert_eq!(creds.pass, "+LPHUKvgAC73FqV/esyr2EUG");
}

#[test]
fn persistent_certificate_and_corrupt_pair_recovery() {
    let dir = TempDir::new();
    let a = Identity::load_or_create(&dir.0).unwrap();
    let b = Identity::load_or_create(&dir.0).unwrap();
    assert_eq!(a.fingerprint, b.fingerprint);
    assert_eq!(a.cert.private_key, b.cert.private_key);
    assert_eq!(a.fingerprint_url().len(), 43);
    assert_eq!(a.fingerprint_hex().len(), 95);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["cert.der", "key.pkcs8.der"] {
            assert_eq!(
                std::fs::metadata(dir.0.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    std::fs::write(dir.0.join("cert.der"), b"corrupt certificate").unwrap();
    let c = Identity::load_or_create(&dir.0).unwrap();
    assert_ne!(b.fingerprint, c.fingerprint);
    std::fs::write(dir.0.join("key.pkcs8.der"), b"corrupt key").unwrap();
    let d = Identity::load_or_create(&dir.0).unwrap();
    assert_ne!(c.fingerprint, d.fingerprint);
    // A parseable key from a different identity must also be replaced.
    std::fs::write(dir.0.join("key.pkcs8.der"), a.cert.private_key).unwrap();
    let e = Identity::load_or_create(&dir.0).unwrap();
    assert_ne!(d.fingerprint, e.fingerprint);
    std::fs::remove_file(dir.0.join("cert.der")).unwrap();
    assert_ne!(
        e.fingerprint,
        Identity::load_or_create(&dir.0).unwrap().fingerprint
    );
}

#[test]
fn rfc7983_demux() {
    assert_eq!(classify(&[]), DatagramKind::Drop);
    for byte in 0..=255 {
        assert_eq!(
            classify(&[byte]),
            match byte {
                0..=3 => DatagramKind::Stun,
                20..=63 => DatagramKind::Dtls,
                _ => DatagramKind::Drop,
            }
        );
    }
}

#[test]
fn stun_authentication_precedes_peer_allocation() {
    let mut engine = Engine::new(local(), identity()).unwrap();
    let creds = credentials(&engine.identity.fingerprint);
    let now = Instant::now();
    for bytes in [
        request("wrongUfrag", &creds.pass),
        request(&creds.ufrag, "wrongPassword"),
        vec![0; 20],
        vec![22; 64],
    ] {
        engine.receive(now, remote(), &bytes).unwrap();
        assert_eq!(engine.peer_count(), 0, "invalid input allocated a peer");
    }
    let bytes = request(&creds.ufrag, &creds.pass);
    engine.receive(now, remote(), &bytes).unwrap();
    assert_eq!(engine.peer_count(), 1);
    let mut reply = None;
    while let output @ (EngineOutput::Event(_) | EngineOutput::Transmit(_)) = engine.poll_output() {
        if let EngineOutput::Transmit(tx) = output {
            reply = Some(tx);
        }
    }
    let reply = reply.expect("authenticated first request must get a STUN response");
    assert_eq!(reply.source, local());
    let message = StunMessage::parse(&reply.contents).unwrap();
    assert!(message.is_successful_binding_response());
    assert!(message.verify(creds.pass.as_bytes(), |key, parts| engine
        .provider
        .sha1_hmac_provider
        .sha1_hmac(key, parts)));
}

#[test]
fn source_filter_and_peer_cap() {
    let mut engine = Engine::new(local(), identity()).unwrap();
    let creds = credentials(&engine.identity.fingerprint);
    let bytes = request(&creds.ufrag, &creds.pass);
    let now = Instant::now();
    for source in [
        "127.0.0.1:45002",
        "0.0.0.0:45002",
        "224.0.0.1:45002",
        "[::1]:45002",
        "[::]:45002",
        "[ff02::1]:45002",
    ] {
        engine
            .receive(now, source.parse().unwrap(), &bytes)
            .unwrap();
        assert_eq!(engine.peer_count(), 0);
    }
    for port in 45002..45002 + MAX_PEERS as u16 + 1 {
        engine
            .receive(now, SocketAddr::new(remote().ip(), port), &bytes)
            .unwrap();
    }
    assert_eq!(engine.peer_count(), MAX_PEERS);
}

/// Synthetic LAN addresses, no sockets, no SDP, and virtual protocol time.
struct Pair {
    engine: Engine,
    client: Rtc,
    now: Instant,
    messages: Vec<ChannelData>,
    opened: Vec<ChannelId>,
    closed: Vec<ChannelId>,
}
impl Pair {
    fn new() -> Self {
        let host = identity();
        let browser = identity();
        let now = Instant::now();
        let mut client = RtcConfig::new()
            .set_crypto_provider(Arc::new(str0m_rust_crypto::default_provider()))
            .set_dtls_cert(browser.cert)
            .build(now);
        client.add_local_candidate(Candidate::host(remote(), "udp").unwrap());
        client.add_remote_candidate(Candidate::host(local(), "udp").unwrap());
        let mut direct = client.direct_api();
        direct.set_ice_controlling(true);
        direct.set_remote_ice_credentials(credentials(&host.fingerprint));
        direct.set_remote_fingerprint(Fingerprint {
            hash_func: "sha-256".into(),
            bytes: host.fingerprint.to_vec(),
        });
        direct.start_dtls(true).unwrap();
        direct.start_sctp(true);
        Self {
            engine: Engine::new(local(), host).unwrap(),
            client,
            now,
            messages: vec![],
            opened: vec![],
            closed: vec![],
        }
    }
    fn create(&mut self, label: &str) -> ChannelId {
        self.client.direct_api().create_data_channel(ChannelConfig {
            label: label.into(),
            ..Default::default()
        })
    }
    fn send(&mut self, id: ChannelId, binary: bool, bytes: &[u8]) {
        assert!(self
            .client
            .channel(id)
            .expect("channel open")
            .write(binary, bytes)
            .unwrap());
    }
    fn tick(&mut self) {
        self.now += Duration::from_millis(1);
        self.client.handle_input(Input::Timeout(self.now)).unwrap();
        self.engine.timeout(self.now);
        for _ in 0..100 {
            let mut transmitted = false;
            loop {
                match self.client.poll_output().unwrap() {
                    Output::Transmit(tx) => {
                        self.engine
                            .receive(self.now, remote(), &tx.contents)
                            .unwrap();
                        transmitted = true;
                        break;
                    }
                    Output::Event(Event::ChannelOpen(id, _)) => self.opened.push(id),
                    Output::Event(Event::ChannelClose(id)) => self.closed.push(id),
                    Output::Event(Event::ChannelData(data)) => self.messages.push(data),
                    Output::Event(_) => {}
                    Output::Timeout(_) => break,
                }
            }
            loop {
                match self.engine.poll_output() {
                    EngineOutput::Transmit(tx) => {
                        self.client
                            .handle_input(Input::Receive(
                                self.now,
                                Receive::new(Protocol::Udp, local(), remote(), &tx.contents)
                                    .unwrap(),
                            ))
                            .unwrap();
                        transmitted = true;
                        break;
                    }
                    EngineOutput::Event(event) => {
                        assert_ne!(event["event"], "peer-error", "{event}")
                    }
                    EngineOutput::Timeout(_) => break,
                }
            }
            if !transmitted {
                break;
            }
        }
    }
    fn until(&mut self, condition: impl Fn(&Self) -> bool) {
        for _ in 0..20_000 {
            if condition(self) {
                return;
            }
            self.tick();
        }
        panic!("condition not reached within 20 s virtual protocol time; peers={}, opened={:?}, closed={:?}, messages={}", self.engine.peer_count(), self.opened, self.closed, self.messages.len());
    }
    fn open(&mut self) -> ChannelId {
        let id = self.create(LABEL);
        self.until(|p| p.opened.contains(&id));
        id
    }
}

#[test]
fn direct_dtls_sctp_echo_get_stats_close_and_label() {
    let mut p = Pair::new();
    let echo = p.open();
    for (binary, bytes) in [
        (false, b"{not json}".as_slice()),
        (true, &[0, 255, 128, 42]),
    ] {
        p.send(echo, binary, bytes);
        p.until(|p| !p.messages.is_empty());
        let data = p.messages.remove(0);
        assert_eq!((data.binary, data.data), (binary, bytes.to_vec()));
    }
    for chunk in [16_384, 65_536] {
        let id = p.open();
        let n = 1_048_583;
        p.send(
            id,
            false,
            json!({"t":"get","n":n,"c":chunk}).to_string().as_bytes(),
        );
        p.until(|p| p.messages.iter().any(|m| m.id == id && !m.binary));
        let mut body = vec![];
        for message in p.messages.drain(..) {
            assert_eq!(message.id, id);
            if message.binary {
                assert_eq!(message.data.len(), chunk.min(n - body.len()));
                body.extend_from_slice(&message.data);
            } else {
                assert_eq!(
                    serde_json::from_slice::<Value>(&message.data).unwrap(),
                    json!({"t":"end","n":n})
                );
                assert_eq!(body.len(), n);
            }
        }
        assert!(body.iter().enumerate().all(|(i, b)| *b == (i & 255) as u8));
        let peer = &p.engine.peers[&remote()];
        assert!(peer.channels.values().all(|c| c.queued <= MAX_MESSAGE));
        p.client.direct_api().close_data_channel(id);
        p.until(|p| p.closed.contains(&id));
    }
    let rejected = p.create("other-label");
    p.until(|p| p.closed.contains(&rejected));
    p.client.direct_api().close_data_channel(echo);
    p.until(|p| p.closed.contains(&echo));
    let stats = p.open();
    p.send(stats, false, br#"{"t":"stats"}"#);
    p.until(|p| !p.messages.is_empty());
    let message = p.messages.remove(0);
    assert!(!message.binary);
    assert_eq!(
        serde_json::from_slice::<Value>(&message.data).unwrap(),
        json!({"t":"stats","peers":1,"open":1,"openedTotal":4,"closedTotal":3})
    );
}

#[test]
fn concurrent_gets_resume_under_shared_sctp_backpressure() {
    let mut p = Pair::new();
    let ids: Vec<_> = (0..8).map(|_| p.open()).collect();
    for id in &ids {
        p.send(*id, false, br#"{"t":"get","n":262145,"c":65536}"#);
    }
    p.until(|p| p.messages.iter().filter(|m| !m.binary).count() == ids.len());
    assert_eq!(
        p.engine.peers[&remote()].generated_get_bytes,
        262145 * ids.len() as u64,
        "backpressured GETs must not regenerate rejected chunks"
    );
    for id in ids {
        let body: Vec<_> = p
            .messages
            .iter()
            .filter(|m| m.id == id && m.binary)
            .flat_map(|m| m.data.iter().copied())
            .collect();
        assert_eq!(body.len(), 262145);
        assert!(body.iter().enumerate().all(|(i, b)| *b == (i & 255) as u8));
    }
}

#[test]
fn outbound_message_limit_accepts_65536_and_rejects_65537_per_channel() {
    let mut p = Pair::new();
    let echo = p.open();
    p.send(echo, true, &vec![42; 65_536]);
    p.until(|p| !p.messages.is_empty());
    assert_eq!(p.messages.remove(0).data, vec![42; 65_536]);
    // Inject reassembled input: the direct-API test client also has a 64 KiB send limit.
    let peer = p.engine.peers.get_mut(&remote()).unwrap();
    let host_id = *peer.channels.keys().next().unwrap();
    peer.data(
        ChannelData {
            id: host_id,
            binary: true,
            data: vec![0; 65_537],
        },
        1,
    );
    p.until(|p| p.closed.contains(&echo));
    assert_eq!(p.engine.peer_count(), 1);
    let stats = p.open();
    p.send(stats, false, br#"{"t":"stats"}"#);
    p.until(|p| !p.messages.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&p.messages[0].data).unwrap()["open"],
        1
    );
}

#[test]
fn invalid_get_chunk_replies_error_then_closes_only_channel() {
    let mut p = Pair::new();
    for chunk in [0, 65_537] {
        let id = p.open();
        p.send(
            id,
            false,
            json!({"t":"get","n":10,"c":chunk}).to_string().as_bytes(),
        );
        p.until(|p| p.closed.contains(&id));
        let message = p.messages.remove(0);
        assert!(!message.binary);
        assert_eq!(
            serde_json::from_slice::<Value>(&message.data).unwrap()["t"],
            "error"
        );
        assert_eq!(p.engine.peer_count(), 1);
    }
}
