use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use rcgen::{CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256};
use ring::digest::{digest, SHA256};
use str0m::crypto::dtls::DtlsCert;
use str0m::IceCreds;

/// Persistent P-256 identity; independent of the production WebTransport identity.
#[derive(Clone)]
pub struct Identity {
    pub(crate) cert: DtlsCert,
    pub fingerprint: [u8; 32],
}

/// The fingerprint is raw SHA-256 bytes, not its URL or SDP encoding.
pub fn credentials(fingerprint: &[u8; 32]) -> IceCreds {
    let mut input = b"couch-tunnel/1 ice".to_vec();
    input.extend_from_slice(fingerprint);
    let hash = digest(&SHA256, &input);
    IceCreds {
        ufrag: STANDARD_NO_PAD.encode(&hash.as_ref()[..6]),
        pass: STANDARD_NO_PAD.encode(&hash.as_ref()[6..24]),
    }
}

impl Identity {
    /// Reuse a parseable matching certificate/key pair; regenerate missing or corrupt pairs.
    pub fn load_or_create(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let cert_path = dir.join("cert.der");
        let key_path = dir.join("key.pkcs8.der");
        if let (Ok(certificate), Ok(private_key)) = (fs::read(&cert_path), fs::read(&key_path)) {
            if Self::valid_pair(&certificate, &private_key) {
                return Ok(Self::from_der(certificate, private_key));
            }
        }
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(io::Error::other)?;
        let mut params =
            CertificateParams::new(vec!["couch-tunnel".into()]).map_err(io::Error::other)?;
        params.not_before = time::OffsetDateTime::now_utc() - time::Duration::hours(1);
        params.not_after = params.not_before + time::Duration::days(3653);
        let cert = params.self_signed(&key).map_err(io::Error::other)?;
        let certificate = cert.der().to_vec();
        let private_key = key.serialize_der();
        write_private(&cert_path, &certificate)?;
        write_private(&key_path, &private_key)?;
        Ok(Self::from_der(certificate, private_key))
    }

    fn valid_pair(certificate: &[u8], private_key: &[u8]) -> bool {
        if wtransport::tls::Certificate::from_der(certificate.to_vec()).is_err() {
            return false;
        }
        // Require P-256 PKCS#8, then check that its public key matches the certificate.
        if ring::signature::EcdsaKeyPair::from_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING,
            private_key,
            &ring::rand::SystemRandom::new(),
        )
        .is_err()
        {
            return false;
        }
        rustls::sign::CertifiedKey::from_der(
            vec![certificate.to_vec().into()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(private_key.to_vec()).into(),
            &rustls::crypto::ring::default_provider(),
        )
        .is_ok()
    }

    pub(crate) fn from_der(certificate: Vec<u8>, private_key: Vec<u8>) -> Self {
        let fingerprint = digest(&SHA256, &certificate).as_ref().try_into().unwrap();
        Self {
            cert: DtlsCert {
                certificate,
                private_key,
            },
            fingerprint,
        }
    }

    pub fn fingerprint_url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.fingerprint)
    }

    pub fn fingerprint_hex(&self) -> String {
        self.fingerprint
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":")
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)?;
    file.sync_all()
}
