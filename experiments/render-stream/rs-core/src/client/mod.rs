//! Pure client protocol messages shared by native and browser adapters. No transport or clock.
//! Web descriptor resolution will inherit this strict URL subset when it adopts the shared resolver.
use serde_json::{json, Value};
mod endpoint;
pub use endpoint::ResolveError;

// Godot's JSON parser uses doubles even for integer literals. Keep integer fields normalized
// at this shared boundary, while refusing fractional, negative and out-of-range values.
fn json_integer(value: &Value, max: u64) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return (n <= max).then_some(n);
    }
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0. && *n <= max as f64 && n.fract() == 0.)
        .map(|n| n as u64)
}

// Keep the map insertion loop shared instead of expanding it for every message field.
#[inline(never)]
fn object(fields: Vec<(&str, Value)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

pub struct HelloParams {
    pub facts: Value,
}

impl HelloParams {
    #[cold]
    pub fn encode(&self) -> Result<String, String> {
        let f = &self.facts;
        let version = json_integer(&f["protocol"], 19).unwrap_or(0);
        if !(16..=19).contains(&version) {
            return Err("render-stream client: protocol must be in 16..19".into());
        }
        let max = if version >= 18 { 8 } else { 2 };
        let window = json_integer(&f["creditWindow"], max).unwrap_or(0);
        if window < 1 || window > max {
            return Err(format!(
                "render-stream client: creditWindow must be in 1..{max}"
            ));
        }
        if f["clientTweens"] == true && version < 17 {
            return Err("render-stream client: clientTweens needs protocol 17 or later".into());
        }
        let gpu = f["gpuFormats"].as_str().unwrap_or("none");
        let mut out = object(vec![
            ("type", "hello".into()),
            ("protocol", format!("render-stream/{version}").into()),
            (
                "receiver",
                f.get("receiver")
                    .cloned()
                    .unwrap_or("gsw-render-stream-client".into()),
            ),
            (
                "receiver_kind",
                f.get("receiverKind")
                    .cloned()
                    .unwrap_or("gsw-canvas".into()),
            ),
            (
                "credit_stage",
                f.get("creditStage").cloned().unwrap_or("submitted".into()),
            ),
            ("credit_window", window.into()),
            (
                "inbound_buffer_bytes",
                f.get("inboundBufferBytes")
                    .cloned()
                    .unwrap_or(16777216.into()),
            ),
            ("token", f["token"].clone()),
            (
                "manifest_sha256",
                f.get("manifestSha256").cloned().unwrap_or(Value::Null),
            ),
            ("presentation_backing_w", f["backing"][0].clone()),
            ("presentation_backing_h", f["backing"][1].clone()),
            ("presentation_css_w", f["css"][0].clone()),
            ("presentation_css_h", f["css"][1].clone()),
            ("dpr_milli", f["dprMilli"].clone()),
            (
                "texture_encodings",
                if gpu != "" && gpu != "none" {
                    "block,decoded"
                } else {
                    "decoded"
                }
                .into(),
            ),
            ("gpu_formats", gpu.into()),
        ]);
        let coding = f["liveCoding"].as_str().unwrap_or("zstd-base,zstd");
        if !coding.is_empty() {
            out["live_coding"] = coding.into();
        }
        if let Some(m) = f.get("itemMeta").filter(|v| !v.is_null()) {
            out["item_meta"] = object(vec![
                ("fields", m["fields"].clone()),
                ("groups", m["groups"].clone()),
                ("meta_keys", m["meta_keys"].clone()),
            ]);
        }
        if f["clientTweens"] == true {
            out["client_tweens"] = true.into();
        }
        Ok(out.to_string())
    }
}

#[cold]
pub fn subprotocol(version: u64) -> Result<String, String> {
    if !(16..=19).contains(&version) {
        return Err("render-stream client: protocol must be in 16..19".into());
    }
    Ok(format!("render-stream.{version}"))
}

/// Descriptor validation distinguishes schema failures from strict URL refusal codes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EndpointError {
    Schema(String),
    Resolution {
        field: &'static str,
        code: ResolveError,
    },
}

impl std::fmt::Display for EndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Schema(why) => write!(f, "render-stream endpoint: {why}"),
            Self::Resolution { field, code } => {
                write!(f, "render-stream endpoint: {field}: {}", code.code())
            }
        }
    }
}
impl std::error::Error for EndpointError {}

#[cold]
fn endpoint_error(why: &str) -> EndpointError {
    EndpointError::Schema(why.into())
}
#[cold]
fn resolution_error(field: &'static str) -> impl FnOnce(ResolveError) -> EndpointError {
    move |code| EndpointError::Resolution { field, code }
}
#[cold]
fn hex64(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// Validate descriptor fields and resolve the strict, machine-generated URL subset.
#[cold]
pub fn resolve_descriptor(value: &Value, origin: &str) -> Result<Value, EndpointError> {
    let fail = endpoint_error;
    let e = value.as_object().ok_or_else(|| fail("not an object"))?;
    for k in e.keys() {
        if ![
            "url",
            "resourceBase",
            "token",
            "protocol",
            "presentation",
            "webTransport",
        ]
        .contains(&k.as_str())
        {
            return Err(fail(&format!("unknown key {}", json!(k))));
        }
    }
    let url = e
        .get("url")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| fail("url must be a non-empty string"))?;
    let resource = e
        .get("resourceBase")
        .and_then(Value::as_str)
        .ok_or_else(|| fail("resourceBase must be a string"))?;
    if resource.ends_with('/') {
        return Err(fail("resourceBase must not end with a slash"));
    }
    if !e.get("token").is_some_and(|v| v.is_null() || hex64(v)) {
        return Err(fail("token must be 64 lowercase hex or null"));
    }
    let version = json_integer(&value["protocol"], 19).unwrap_or(0);
    if !(11..=19).contains(&version) {
        return Err(fail(&format!(
            "protocol must be 11, 12, 13, 14, 15, 16, 17, 18 or 19 (got {})",
            e.get("protocol")
                .map_or("undefined".into(), Value::to_string)
        )));
    }
    if let Some(p) = e.get("presentation") {
        if !p.as_array().is_some_and(|a| {
            a.len() == 2
                && a.iter()
                    .all(|n| json_integer(n, 16384).is_some_and(|n| n > 0))
        }) {
            return Err(fail(
                "presentation must be [width, height], integers in 1..16384",
            ));
        }
    }
    if let Some(w) = e.get("webTransport") {
        let wo = w
            .as_object()
            .ok_or_else(|| fail("webTransport must be an object"))?;
        for k in wo.keys() {
            if !["url", "certificateHashes"].contains(&k.as_str()) {
                return Err(fail(&format!("unknown webTransport key {}", json!(k))));
            }
        }
        let u = wo
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| fail("webTransport.url must be a string"))?;
        if !u
            .get(..8)
            .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
        {
            return Err(fail(
                "webTransport.url must be an absolute https URL with a host",
            ));
        }
        endpoint::web_transport(u).map_err(resolution_error("webTransport.url"))?;
        if let Some(h) = wo.get("certificateHashes") {
            if !h
                .as_array()
                .is_some_and(|h| (1..=4).contains(&h.len()) && h.iter().all(hex64))
            {
                return Err(fail("webTransport.certificateHashes must be 1..4 SHA-256 digests, 64 lowercase hex each"));
            }
        }
    }
    let base = endpoint::origin(origin).map_err(resolution_error("origin"))?;
    let ws = endpoint::socket(url, &base).map_err(resolution_error("url"))?;
    let http = endpoint::resource(resource, &base).map_err(resolution_error("resourceBase"))?;
    let mut out = object(vec![
        ("url", ws.into()),
        ("resourceBase", http.into()),
        ("token", value["token"].clone()),
        ("protocol", version.into()),
    ]);
    if let Some(p) = e.get("presentation") {
        out["presentation"] = json!([
            json_integer(&p[0], 16384).unwrap(),
            json_integer(&p[1], 16384).unwrap()
        ]);
    }
    if let Some(w) = e.get("webTransport") {
        out["webTransport"] = w.clone();
    }
    Ok(out)
}

#[cold]
pub fn parse_host_error(text: &str) -> Value {
    if let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(text.as_bytes()) {
        if m.len() == 3
            && m.get("type") == Some(&json!("error"))
            && m.get("reason").is_some_and(Value::is_string)
            && m.get("detail").is_some_and(Value::is_string)
        {
            return object(vec![
                ("ok", true.into()),
                ("reason", m["reason"].clone()),
                ("detail", m["detail"].clone()),
            ]);
        }
    }
    object(vec![
        ("ok", false.into()),
        ("reason", "".into()),
        ("detail", text.into()),
    ])
}

// JSON.stringify's number spelling (including -0 and positive scientific exponents).
fn js_number(v: &Value) -> String {
    let mut number = crate::json::NumBuf::new();
    number.js(v.as_f64().unwrap_or(f64::NAN));
    String::from_utf8(number.as_bytes().to_vec()).unwrap()
}

pub fn encode_ack(v: &Value) -> Result<String, String> {
    let stage = v["stage"].as_str().unwrap_or("");
    if !["received", "applied", "submitted"].contains(&stage) {
        return Err("render-stream client: invalid ack stage".into());
    }
    let id = v["stream_id"]
        .as_str()
        .ok_or("render-stream client: invalid stream_id")?;
    Ok(format!(
        "{{\"type\":\"ack\",\"stream_id\":{},\"seq\":{},\"stage\":{},\"t_us\":{}}}",
        json!(id),
        js_number(&v["seq"]),
        json!(stage),
        js_number(&v["t_us"])
    ))
}

/// The host-fed HIT1 table; null/non-Control/IGNORE rows never stop GUI picking.
pub fn hit_filter(table: &crate::item_meta::ItemMetaTable, id: u32) -> Option<u8> {
    if !table
        .grant
        .as_ref()?
        .fields
        .iter()
        .any(|f| f == "mouse_filter")
        || !table.rows.contains_key(&id)
    {
        return None;
    }
    Some(match table.mouse_filter(id).map(|v| v & 3) {
        Some(0 | 1) => crate::apply::overrides::HIT_INPUT,
        _ => crate::apply::overrides::HIT_IGNORE,
    })
}

/// JSON boundary common to the C ABI and wasm exports. Errors contain no descriptor/token values.
pub fn call(operation: &str, input: &str) -> Result<String, String> {
    if operation == "parse_host_error" {
        return Ok(parse_host_error(input).to_string());
    }
    let v: Value = serde_json::from_slice(input.as_bytes())
        .map_err(|_| "render-stream client: invalid JSON".to_owned())?;
    match operation {
        "client_hello" => HelloParams { facts: v }.encode(),
        "subprotocol" => subprotocol(v.as_u64().unwrap_or(0)),
        "resolve_descriptor" => {
            resolve_descriptor(&v["descriptor"], v["origin"].as_str().unwrap_or(""))
                .map(|v| v.to_string())
                .map_err(|e| e.to_string())
        }
        "encode_ack" => encode_ack(&v),
        _ => Err("render-stream client: unknown operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_descriptor_errors_are_typed() {
        for (url, code) in [
            ("/rs?q=1", ResolveError::Query),
            ("/rs#x", ResolveError::Fragment),
            ("/a/../rs", ResolveError::DotSegment),
            ("/a%20b", ResolveError::PercentEscape),
            ("ws://user:secret@h/rs", ResolveError::Userinfo),
            ("ws://hé/rs", ResolveError::NonAsciiHost),
            ("http://h/rs", ResolveError::UnsupportedScheme),
            ("//h/rs", ResolveError::ProtocolRelative),
        ] {
            let value = json!({"url":url,"resourceBase":"","token":null,"protocol":19});
            assert_eq!(
                resolve_descriptor(&value, "https://h"),
                Err(EndpointError::Resolution { field: "url", code })
            );
        }
    }

    #[test]
    fn shared_client_vectors() {
        let vectors: Value = serde_json::from_str(include_str!("vectors.json")).unwrap();
        for v in vectors.as_array().unwrap() {
            let input = v["input"].as_str().unwrap();
            let result = call(v["op"].as_str().unwrap(), input);
            if let Some(error) = v.get("error") {
                assert_eq!(
                    result.unwrap_err(),
                    error.as_str().unwrap(),
                    "{}",
                    v["name"]
                );
            } else {
                assert_eq!(
                    result.unwrap(),
                    v["output"].as_str().unwrap(),
                    "{}",
                    v["name"]
                );
            }
        }
    }
}
