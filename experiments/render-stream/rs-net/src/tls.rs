//! wss on the built-in `ws` carrier: a sans-IO rustls server
//! session behind `grc_net_tls_v1` (capture/src/grc_net_module.h, struct grc_net_tls_table_v1).
//!
//! The capture's `rs_ws` I/O thread owns the socket. It feeds the ciphertext it read
//! ([`TlsSession::feed`]), reads the plaintext that yields ([`TlsSession::read`]), writes the
//! plaintext it wants sent ([`TlsSession::write`]) and takes the ciphertext to put on the socket
//! ([`TlsSession::take`]). Nothing here touches a socket, a thread or a clock, so no call can
//! block: each one is memory-speed, except the handshake's one ECDHE and one signature, which are
//! CPU-bound and bounded (well under a millisecond for an ECDSA P-256 key).
//!
//! The configuration is the consumer's PEM pair (GRC_LIVE_TLS_CERT / GRC_LIVE_TLS_KEY, D11). TLS
//! 1.3 only, with the `ring` provider; ALPN offers `http/1.1` alone, because the port speaks
//! HTTP/1.1 and WebSocket over it. Every browser and Node release this toolkit targets speaks TLS
//! 1.3, and leaving TLS 1.2 out keeps its state machine out of the game process.

use std::io::{self, Read, Write};
use std::sync::Arc;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::{ServerConfig, ServerConnection};

use crate::cert::hex;

/// The session has not finished its handshake.
pub const GRC_TLS_HANDSHAKING: u32 = 1;
/// Ciphertext is waiting for [`TlsSession::take`].
pub const GRC_TLS_WANTS_WRITE: u32 = 2;
/// The peer sent close_notify; once `read` returns 0 no more plaintext will come.
pub const GRC_TLS_PEER_CLOSED: u32 = 4;
/// A fatal error (a bad record, a failed handshake, a panic). `error` says why; `take` may still
/// yield the alert to send before the connection is dropped.
pub const GRC_TLS_FAILED: u32 = 8;

/// The parsed pair, shared by every session made from it.
pub struct TlsConfig {
    pub config: Arc<ServerConfig>,
    /// The leaf certificate's SHA-256, 64 lowercase hex (evidence/live-carriers.json).
    pub sha256: String,
}

impl TlsConfig {
    /// Loads the consumer's PEM pair. Every failure is `tls-config-invalid: ...` (Q3): a file that
    /// cannot be read, holds no certificate or no key, or a key that is not the certificate's.
    pub fn from_pem_files(cert_path: &str, key_path: &str) -> Result<TlsConfig, String> {
        let invalid = |what: String| format!("tls-config-invalid: {what}");
        let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert_path)
            .map_err(|e| invalid(format!("{cert_path}: {e}")))?
            .collect::<Result<_, _>>()
            .map_err(|e| invalid(format!("{cert_path}: {e}")))?;
        if chain.is_empty() {
            return Err(invalid(format!("{cert_path} holds no certificate")));
        }
        let key = PrivateKeyDer::from_pem_file(key_path).map_err(|e| invalid(format!("{key_path}: {e}")))?;
        let sha256 = hex(ring::digest::digest(&ring::digest::SHA256, chain[0].as_ref()).as_ref());
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut config = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|e| invalid(format!("protocol versions: {e}")))?
            .with_no_client_auth()
            // Checks that the key is the leaf certificate's (InconsistentKeys::KeyMismatch).
            .with_single_cert(chain, key)
            .map_err(|e| invalid(format!("{cert_path} / {key_path}: {e}")))?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(TlsConfig { config: Arc::new(config), sha256 })
    }
}

/// One connection's TLS state. Single-threaded: the capture drives it from its I/O thread only.
pub struct TlsSession {
    conn: Option<ServerConnection>,
    error: String,
    failed: bool,
    peer_closed: bool,
}

impl TlsSession {
    pub fn new(config: &TlsConfig) -> Result<TlsSession, String> {
        let mut conn = ServerConnection::new(config.config.clone()).map_err(|e| format!("tls-session: {e}"))?;
        // The capture keeps its own queue (rs_ws's send buffer, bounded by max_queued_bytes) and
        // hands plaintext over only as fast as the socket drains, so rustls's own send limit
        // would only refuse bytes the caller already accounted for.
        conn.set_buffer_limit(None);
        Ok(TlsSession { conn: Some(conn), error: String::new(), failed: false, peer_closed: false })
    }

    pub fn fail(&mut self, why: &str) {
        if !self.failed {
            self.failed = true;
            self.error = why.to_string();
        }
    }

    /// Consumes ciphertext; returns how much was consumed (possibly less than `data.len()` when
    /// rustls holds as much unread plaintext as it buffers: `read` it, then feed the rest), or
    /// -1 once the session has failed. A failure queues the alert for `take`.
    pub fn feed(&mut self, data: &[u8]) -> i64 {
        if self.failed {
            return -1;
        }
        let Some(conn) = self.conn.as_mut() else { return -1 };
        let mut consumed = 0usize;
        while consumed < data.len() {
            let mut rest = &data[consumed..];
            match conn.read_tls(&mut rest) {
                Ok(0) => break,
                Ok(n) => consumed += n,
                // "received plaintext buffer full" (or a full deframer): the caller reads first.
                Err(_) => break,
            }
            match conn.process_new_packets() {
                Ok(state) => {
                    if state.peer_has_closed() {
                        self.peer_closed = true;
                    }
                }
                Err(e) => {
                    self.fail(&format!("tls: {e}"));
                    return if consumed > 0 { consumed as i64 } else { -1 };
                }
            }
        }
        consumed as i64
    }

    /// Moves up to `out.len()` plaintext bytes out; 0 when there is none right now (see
    /// GRC_TLS_PEER_CLOSED for the end), -1 on a failed session.
    pub fn read(&mut self, out: &mut [u8]) -> i64 {
        if self.failed {
            return -1;
        }
        let Some(conn) = self.conn.as_mut() else { return -1 };
        match conn.reader().read(out) {
            Ok(n) => {
                if n == 0 && !out.is_empty() {
                    self.peer_closed = true;
                }
                n as i64
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => 0,
            Err(e) => {
                self.fail(&format!("tls read: {e}"));
                -1
            }
        }
    }

    /// Queues plaintext for encryption (before the handshake completes it waits inside rustls).
    /// Accepts all of it, or -1 on a failed session.
    pub fn write(&mut self, data: &[u8]) -> i64 {
        if self.failed {
            return -1;
        }
        let Some(conn) = self.conn.as_mut() else { return -1 };
        match conn.writer().write_all(data) {
            Ok(()) => data.len() as i64,
            Err(e) => {
                self.fail(&format!("tls write: {e}"));
                -1
            }
        }
    }

    /// Moves up to `out.len()` ciphertext bytes out; 0 when there is none. Works on a failed
    /// session too, so the alert reaches the peer.
    pub fn take(&mut self, out: &mut [u8]) -> i64 {
        let Some(conn) = self.conn.as_mut() else { return 0 };
        let mut written = 0usize;
        while written < out.len() && conn.wants_write() {
            let mut window = &mut out[written..];
            match conn.write_tls(&mut window) {
                Ok(0) => break,
                Ok(n) => written += n,
                Err(_) => break,
            }
        }
        written as i64
    }

    pub fn state(&self) -> u32 {
        let mut s = 0;
        if let Some(conn) = self.conn.as_ref() {
            if conn.is_handshaking() {
                s |= GRC_TLS_HANDSHAKING;
            }
            if conn.wants_write() {
                s |= GRC_TLS_WANTS_WRITE;
            }
        }
        if self.peer_closed {
            s |= GRC_TLS_PEER_CLOSED;
        }
        if self.failed {
            s |= GRC_TLS_FAILED;
        }
        s
    }

    pub fn error(&self) -> &str {
        &self.error
    }

    /// Queues close_notify (take it with `take`); nothing more can be written after it.
    pub fn close_notify(&mut self) {
        if let Some(conn) = self.conn.as_mut() {
            conn.send_close_notify();
        }
    }

    /// The ALPN protocol agreed, if any (tests).
    pub fn alpn(&self) -> Option<Vec<u8>> {
        self.conn.as_ref().and_then(|c| c.alpn_protocol().map(|p| p.to_vec()))
    }
}
