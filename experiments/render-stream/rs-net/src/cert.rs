//! `wt`'s certificate (carrier-design.md Q4.6, D11).
//!
//! `self` (default): an ECDSA P-256 key and a certificate generated at carrier start, valid from
//! one hour before start until 14 days after it minus that hour (14 days in total, the
//! `serverCertificateHashes` limit), with SANs for `localhost`, `127.0.0.1`, `::1` and the bound
//! address. The key lives in memory only. `tls`: the consumer's PEM pair (GRC_LIVE_TLS_CERT/KEY).
//! Either way the leaf certificate's SHA-256 is what a page pins.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::{Duration, SystemTime};

use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType, PKCS_ECDSA_P256_SHA256};
use wtransport::tls::{Certificate, CertificateChain, PrivateKey};
use wtransport::Identity;

pub struct Cert {
    pub identity: Identity,
    /// The leaf DER's SHA-256, 64 lowercase hex.
    pub sha256: String,
    /// "self-signed" or "consumer".
    pub tls: &'static str,
    /// When a self-signed certificate stops being valid (None: the consumer's, not tracked).
    pub not_after: Option<SystemTime>,
}

pub const SELF_SIGNED_VALIDITY: Duration = Duration::from_secs(14 * 24 * 3600);
pub const BACKDATE: Duration = Duration::from_secs(3600);

pub fn hex(bytes: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(D[(b >> 4) as usize] as char);
        s.push(D[(b & 15) as usize] as char);
    }
    s
}

fn leaf_sha256(identity: &Identity) -> String {
    let digest = identity.certificate_chain().as_slice()[0].hash();
    hex(AsRef::<[u8; 32]>::as_ref(&digest))
}

/// A fresh self-signed identity for a carrier bound to `bound`.
pub fn self_signed(bound: IpAddr) -> Result<Cert, String> {
    let now = time::OffsetDateTime::now_utc();
    let backdate = time::Duration::seconds(BACKDATE.as_secs() as i64);
    let validity = time::Duration::seconds(SELF_SIGNED_VALIDITY.as_secs() as i64);
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "render-stream wt");
    params.distinguished_name = dn;
    let mut sans = vec![
        SanType::DnsName("localhost".try_into().map_err(|e| format!("san: {e}"))?),
        SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        SanType::IpAddress(IpAddr::V6(Ipv6Addr::LOCALHOST)),
    ];
    if !bound.is_unspecified() && !bound.is_loopback() {
        sans.push(SanType::IpAddress(bound));
    }
    params.subject_alt_names = sans;
    params.not_before = now - backdate;
    params.not_after = now - backdate + validity;
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|e| format!("key: {e}"))?;
    let cert = params.self_signed(&key).map_err(|e| format!("certificate: {e}"))?;
    let der = cert.der().to_vec();
    let identity = Identity::new(
        CertificateChain::single(Certificate::from_der(der).map_err(|e| format!("certificate: {e}"))?),
        PrivateKey::from_der_pkcs8(key.serialize_der()),
    );
    let sha256 = leaf_sha256(&identity);
    let not_after = SystemTime::now() - BACKDATE + SELF_SIGNED_VALIDITY;
    Ok(Cert { identity, sha256, tls: "self-signed", not_after: Some(not_after) })
}

/// The consumer's PEM pair.
pub async fn consumer(cert: &str, key: &str) -> Result<Cert, String> {
    let identity = Identity::load_pemfiles(cert, key)
        .await
        .map_err(|e| format!("tls-config-invalid: {cert} / {key}: {e}"))?;
    if identity.certificate_chain().as_slice().is_empty() {
        return Err(format!("tls-config-invalid: {cert} holds no certificate"));
    }
    let sha256 = leaf_sha256(&identity);
    Ok(Cert { identity, sha256, tls: "consumer", not_after: None })
}
