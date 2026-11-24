//! Descriptor URL subset: ASCII authorities and absolute or host-relative paths only.

/// Stable refusal codes; no untrusted URL (or credentials) appears in an error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolveError {
    Query,
    Fragment,
    DotSegment,
    PercentEscape,
    Userinfo,
    NonAsciiHost,
    UnsupportedScheme,
    ProtocolRelative,
    RelativePath,
    InvalidOrigin,
    InvalidHost,
    InvalidPort,
    InvalidPath,
}

impl ResolveError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Query => "query",
            Self::Fragment => "fragment",
            Self::DotSegment => "dot-segment",
            Self::PercentEscape => "percent-escape",
            Self::Userinfo => "userinfo",
            Self::NonAsciiHost => "non-ascii-host",
            Self::UnsupportedScheme => "unsupported-scheme",
            Self::ProtocolRelative => "protocol-relative",
            Self::RelativePath => "relative-path",
            Self::InvalidOrigin => "invalid-origin",
            Self::InvalidHost => "invalid-host",
            Self::InvalidPort => "invalid-port",
            Self::InvalidPath => "invalid-path",
        }
    }
}

struct Address {
    scheme: String,
    authority: String,
    path: String,
}

impl Address {
    fn base(&self) -> String {
        format!("{}://{}", self.scheme, self.authority)
    }
    fn full(&self) -> String {
        format!("{}{}", self.base(), self.path)
    }
}

#[cold]
fn syntax(input: &str) -> Result<(), ResolveError> {
    if input.contains('?') {
        return Err(ResolveError::Query);
    }
    if input.contains('#') {
        return Err(ResolveError::Fragment);
    }
    if input.contains('%') {
        return Err(ResolveError::PercentEscape);
    }
    if input.starts_with("//") {
        return Err(ResolveError::ProtocolRelative);
    }
    Ok(())
}

#[cold]
fn path(input: &str) -> Result<(), ResolveError> {
    if input.split('/').any(|p| p == "." || p == "..") {
        return Err(ResolveError::DotSegment);
    }
    if !input
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/-._~!$&'()*+,;=:@".contains(&b))
    {
        return Err(ResolveError::InvalidPath);
    }
    Ok(())
}

#[cold]
fn host(input: &str) -> Result<String, ResolveError> {
    if !input.is_ascii() {
        return Err(ResolveError::NonAsciiHost);
    }
    if input.starts_with('[') && input.ends_with(']') {
        return ipv6(&input[1..input.len() - 1]).ok_or(ResolveError::InvalidHost);
    }
    let name = input.strip_suffix('.').unwrap_or(input);
    if name.is_empty()
        || name.len() > 253
        || name.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err(ResolveError::InvalidHost);
    }
    // Refuse WHATWG's abbreviated, octal and hex IPv4 spellings rather than resolving them
    // differently in native and browser clients. Ordinary DNS names are lowercased.
    let last = name.rsplit('.').next().unwrap().to_ascii_lowercase();
    if last.bytes().all(|b| b.is_ascii_digit())
        || last
            .strip_prefix("0x")
            .is_some_and(|s| s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        ipv4(input).ok_or(ResolveError::InvalidHost)?;
        return Ok(input.into());
    }
    Ok(input.to_ascii_lowercase())
}

#[cold]
fn absolute(input: &str, schemes: &[&str]) -> Result<Address, ResolveError> {
    syntax(input)?;
    let (scheme, rest) = input
        .split_once("://")
        .ok_or(ResolveError::UnsupportedScheme)?;
    let scheme = scheme.to_ascii_lowercase();
    if !schemes.contains(&scheme.as_str()) {
        return Err(ResolveError::UnsupportedScheme);
    }
    let (authority, suffix) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
    if authority.contains('@') {
        return Err(ResolveError::Userinfo);
    }
    if !authority.is_ascii() {
        return Err(ResolveError::NonAsciiHost);
    }
    let (hostname, port) = if authority.starts_with('[') {
        let end = authority.find(']').ok_or(ResolveError::InvalidHost)?;
        let suffix = &authority[end + 1..];
        let port = if suffix.is_empty() {
            None
        } else {
            Some(suffix.strip_prefix(':').ok_or(ResolveError::InvalidHost)?)
        };
        (&authority[..=end], port)
    } else {
        authority
            .split_once(':')
            .map_or((authority, None), |(h, p)| (h, Some(p)))
    };
    let mut authority = host(hostname)?;
    if let Some(port) = port {
        if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ResolveError::InvalidPort);
        }
        let port: u16 = port.parse().map_err(|_| ResolveError::InvalidPort)?;
        if port == 0 {
            return Err(ResolveError::InvalidPort);
        }
        let default_port = if scheme == "http" || scheme == "ws" {
            80
        } else {
            443
        };
        if port != default_port {
            authority.push_str(&format!(":{port}"));
        }
    }
    let path_text = format!("/{suffix}");
    path(&path_text)?;
    Ok(Address {
        scheme,
        authority,
        path: path_text,
    })
}

/// An HTTP origin (an optional root slash is harmless), never a page-relative base path.
#[cold]
pub fn origin(input: &str) -> Result<String, ResolveError> {
    let address = absolute(input, &["http", "https"])?;
    if address.path != "/" {
        return Err(ResolveError::InvalidOrigin);
    }
    Ok(address.base())
}

#[cold]
pub fn socket(input: &str, origin: &str) -> Result<String, ResolveError> {
    syntax(input)?;
    if input.starts_with('/') {
        path(input)?;
        let base = origin.replacen("http", "ws", 1);
        return Ok(format!("{base}{input}"));
    }
    if !input.contains(':') {
        path(input)?;
        return Err(ResolveError::RelativePath);
    }
    Ok(absolute(input, &["ws", "wss"])?.full())
}

#[cold]
pub fn resource(input: &str, origin: &str) -> Result<String, ResolveError> {
    syntax(input)?;
    if input.is_empty() {
        return Ok(origin.into());
    }
    if input.starts_with('/') {
        path(input)?;
        return Ok(format!("{origin}{input}"));
    }
    if !input.contains(':') {
        path(input)?;
        return Err(ResolveError::RelativePath);
    }
    Ok(absolute(input, &["http", "https"])?
        .full()
        .trim_end_matches('/')
        .into())
}

#[cold]
pub fn web_transport(input: &str) -> Result<(), ResolveError> {
    absolute(input, &["https"])?;
    Ok(())
}

fn ipv4(input: &str) -> Option<[u8; 4]> {
    let mut octets = [0; 4];
    let mut parts = input.split('.');
    for octet in &mut octets {
        let part = parts.next()?;
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        *octet = part.parse().ok()?;
    }
    parts.next().is_none().then_some(octets)
}

fn ipv6_groups(input: &str, ipv4_tail: bool) -> Option<([u16; 8], usize)> {
    let mut groups = [0; 8];
    let mut len = 0;
    if !input.is_empty() {
        let mut parts = input.split(':').peekable();
        while let Some(part) = parts.next() {
            if part.contains('.') && ipv4_tail && parts.peek().is_none() && len <= 6 {
                let octets = ipv4(part)?;
                groups[len] = u16::from_be_bytes([octets[0], octets[1]]);
                groups[len + 1] = u16::from_be_bytes([octets[2], octets[3]]);
                len += 2;
            } else {
                if len == 8
                    || part.is_empty()
                    || part.len() > 4
                    || !part.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return None;
                }
                groups[len] = u16::from_str_radix(part, 16).ok()?;
                len += 1;
            }
        }
    }
    Some((groups, len))
}

fn ipv6(input: &str) -> Option<String> {
    use std::fmt::Write;
    let groups = if let Some((left, right)) = input.split_once("::") {
        let (mut left, nleft) = ipv6_groups(left, false)?;
        let (right, nright) = ipv6_groups(right, true)?;
        if nleft + nright >= 8 {
            return None;
        }
        left[8 - nright..].copy_from_slice(&right[..nright]);
        left
    } else {
        let (groups, len) = ipv6_groups(input, true)?;
        if len != 8 {
            return None;
        }
        groups
    };
    // URL serialization compresses the first longest run of at least two zero groups, and
    // renders embedded IPv4 tails in hex rather than dotted decimal.
    let (mut best_start, mut best_len, mut i) = (0, 1, 0);
    while i < 8 {
        let start = i;
        while i < 8 && groups[i] == 0 {
            i += 1;
        }
        if i - start > best_len {
            best_start = start;
            best_len = i - start;
        }
        i += 1;
    }
    let mut out = String::from("[");
    i = 0;
    while i < 8 {
        if i == best_start && best_len > 1 {
            out.push_str("::");
            i += best_len;
        } else {
            if i > 0 && !out.ends_with(':') {
                out.push(':');
            }
            write!(&mut out, "{:x}", groups[i]).unwrap();
            i += 1;
        }
    }
    out.push(']');
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv6Addr;

    #[test]
    fn ipv6_matches_standard_parser_and_canonical_zero_runs() {
        for start in 0..8 {
            for len in 1..=8 - start {
                let mut groups = [0xabcd; 8];
                groups[start..start + len].fill(0);
                let full = groups
                    .iter()
                    .map(|n| format!("{n:04X}"))
                    .collect::<Vec<_>>()
                    .join(":");
                let standard: Ipv6Addr = full.parse().unwrap();
                assert_eq!(ipv6(&full), Some(format!("[{standard}]")), "{full}");
                assert_eq!(ipv6(&standard.to_string()), Some(format!("[{standard}]")));
            }
        }
        for input in [
            "",
            ":",
            ":::1",
            "1::2::3",
            "1:2:3",
            "1:2:3:4:5:6:7:8:9",
            "1:2:3:4:5:6::7:8",
            "12345::",
            "0x1::",
            "+1::",
            "::192.0.2.256",
            "::192.000.2.1",
            "192.0.2.1::",
            "::1.2.3.4:5",
        ] {
            assert!(
                input.parse::<Ipv6Addr>().is_err(),
                "bad oracle fixture {input}"
            );
            assert_eq!(ipv6(input), None, "{input}");
        }
        for (input, output) in [
            ("::192.0.2.1", "[::c000:201]"),
            ("::ffff:192.0.2.1", "[::ffff:c000:201]"),
            ("1:2:3:4:5:6:192.0.2.1", "[1:2:3:4:5:6:c000:201]"),
        ] {
            assert!(input.parse::<Ipv6Addr>().is_ok());
            assert_eq!(ipv6(input).as_deref(), Some(output));
        }
    }
}
