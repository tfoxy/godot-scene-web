//! The golden-vector suite (`scripts/test/self-test-rs2.ts`'s `runSuite`), as a library function
//! over a file-reading callback so a native CLI and a wasm build in Node run the very same checks.
//!
//! Per golden directory (`protocol/golden-N/`, driven by its `index.json`):
//! * every valid recording decodes to its `*.decoded.json` (deep equality, key order free, numbers
//!   exact), every record's SHA-256 reproduces, and it validates clean;
//! * every valid recording resolves to `resolved.json` (`statesEqual`: key order significant,
//!   numbers compared after rounding to float32; `session_id`, `stream_id` and per-transaction
//!   `encoding` excepted, memory rs1-resolved-json-excepted-fields) and its resources list is
//!   `inline_resources` for `inline.*`, `[]` otherwise;
//! * `corrupt` and `invalid` vectors fail with exactly their code as the first error;
//! * `payload_invalid` vectors throw their code (GRP1 at /5, GRM1 at /4, GRT1 otherwise);
//! * `payloads`, `mesh_payloads`, `shader_payloads` hash to their names and decode to their shapes;
//! * the independent `*_leg` recordings decode, validate and resolve to their own files.
//!
//! [`run_all`] adds `self-test-rs2.ts`'s cross-version `bad-magic` checks.

use crate::canon;
use crate::payload;
use crate::validate::{validate_recording, Accepted, DigestPolicy, Options, Validator};
use crate::wire::{self, Error};
use serde_json::{json, Value as J};

/// Reads a file by a path relative to the protocol directory (`golden-6/full.rs6`).
pub type ReadFn<'a> = &'a dyn Fn(&str) -> Option<Vec<u8>>;

#[derive(Clone, Debug)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Clone, Copy, Debug)]
pub struct GoldenOptions {
    /// `false` is the `skip-payload-hash` sabotage: payload hashes go unverified, so golden-2's
    /// `invalid/resource-hash` vector must then fail its check (Q14d).
    pub verify_payload_hashes: bool,
}

impl Default for GoldenOptions {
    fn default() -> Self {
        GoldenOptions {
            verify_payload_hashes: true,
        }
    }
}

struct Suite<'a> {
    label: String,
    dir: String,
    version: u8,
    read: ReadFn<'a>,
    opts: GoldenOptions,
    checks: Vec<Check>,
}

/// `statesEqual`: JSON.stringify(froundDeep(a)) === JSON.stringify(froundDeep(b)).
pub fn states_equal(a: &J, b: &J) -> bool {
    fn num_text_null(x: f64) -> bool {
        !(x as f32).is_finite()
    }
    match (a, b) {
        (J::Number(x), J::Number(y)) => {
            let (x, y) = (
                x.as_f64().unwrap_or(f64::NAN),
                y.as_f64().unwrap_or(f64::NAN),
            );
            let (p, q) = (x as f32, y as f32);
            p == q || (!p.is_finite() && !q.is_finite())
        }
        (J::Number(x), J::Null) | (J::Null, J::Number(x)) => {
            num_text_null(x.as_f64().unwrap_or(f64::NAN))
        }
        (J::Array(x), J::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| states_equal(p, q))
        }
        (J::Object(x), J::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y.iter())
                    .all(|((k1, v1), (k2, v2))| k1 == k2 && states_equal(v1, v2))
        }
        _ => a == b,
    }
}

/// `isDeepStrictEqual` over JSON: key order free, numbers exact.
pub fn deep_equal(a: &J, b: &J) -> bool {
    match (a, b) {
        (J::Number(x), J::Number(y)) => x.as_f64() == y.as_f64(),
        (J::Array(x), J::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| deep_equal(p, q))
        }
        (J::Object(x), J::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| deep_equal(v, w)))
        }
        _ => a == b,
    }
}

/// Resolves a whole recording through the validator: `{schema, transactions: [{seq, frame,
/// state}]}` (the excepted fields stripped) and the resource list.
pub fn resolve_recording(data: &[u8], version: u8, opts: GoldenOptions) -> Result<(J, J), Error> {
    let records = wire::split_records(data, version)?;
    let first = records
        .first()
        .ok_or_else(|| Error::new("missing-session", "the recording has no records"))?;
    let mut v = Validator::new(
        first.bytes(data),
        first.offset,
        Options {
            version,
            digest: DigestPolicy::Deferred,
            verify_payload_hashes: opts.verify_payload_hashes,
        },
    )?;
    let mut transactions = Vec::new();
    let mut resources = Vec::new();
    let mut buf = Vec::new();
    for (i, r) in records.iter().enumerate().skip(1) {
        match v.accept(r.bytes(data), r.offset)? {
            Accepted::Transaction => {
                let st = v.state();
                buf.clear();
                canon::write_state(&mut buf, st);
                let state: J =
                    serde_json::from_slice(&buf).map_err(|e| Error::new("canon", e.to_string()))?;
                transactions.push(json!({"seq": st.seq, "frame": st.frame, "state": state}));
            }
            Accepted::Resource { hash } => {
                let bytes = v.inline_payload(&hash).map(|p| p.len()).unwrap_or(0);
                resources.push(json!({"hash": hash.to_hex(), "bytes": bytes, "record_index": i}));
            }
            Accepted::End => {}
        }
    }
    Ok((
        json!({"schema": format!("render-stream-{version}-resolved/1"), "transactions": transactions}),
        J::Array(resources),
    ))
}

impl Suite<'_> {
    fn ok(&mut self, ok: bool, name: impl Into<String>, detail: impl Into<String>) {
        self.checks.push(Check {
            name: format!("{}: {}", self.label, name.into()),
            ok,
            detail: detail.into(),
        });
    }

    fn bytes(&self, rel: &str) -> Option<Vec<u8>> {
        (self.read)(&format!("{}/{}", self.dir, rel))
    }

    fn json(&self, rel: &str) -> Option<J> {
        serde_json::from_slice(&self.bytes(rel)?).ok()
    }

    fn opts(&self) -> Options {
        Options {
            version: self.version,
            digest: DigestPolicy::Deferred,
            verify_payload_hashes: self.opts.verify_payload_hashes,
        }
    }

    fn expect_code(&mut self, file: &str, code: &str, what: &str) {
        let Some(data) = self.bytes(file) else {
            self.ok(
                false,
                format!("{what}({file}) is rejected with \"{code}\""),
                "file missing",
            );
            return;
        };
        let got = validate_recording(&data, self.opts());
        let ok = matches!(&got, Err(e) if e.code == code);
        let detail = match got {
            Ok(()) => "accepted".to_string(),
            Err(e) => e.to_string(),
        };
        self.ok(
            ok,
            format!("{what}({file}) is rejected with exactly one error starting with \"{code}: \""),
            detail,
        );
    }

    fn decoded_check(&mut self, file: &str, decoded: &str) -> Option<Vec<u8>> {
        let Some(data) = self.bytes(file) else {
            self.ok(false, format!("{file} is readable"), "file missing");
            return None;
        };
        match (
            canon::decoded_recording(&data, self.version),
            self.json(decoded),
        ) {
            (Ok(got), Some(expected)) => {
                self.ok(
                    deep_equal(&got, &expected),
                    format!("decodeRecording({file}) deep-equals {decoded}"),
                    "",
                );
                if let Some(records) = expected.get("records").and_then(|r| r.as_array()) {
                    for rec in records {
                        let offset =
                            rec.get("offset").and_then(|o| o.as_u64()).unwrap_or(0) as usize;
                        let want = rec.get("sha256").and_then(|s| s.as_str()).unwrap_or("");
                        let got = if offset + 4 <= data.len() {
                            let len = 4 + wire::le_u32(&data, offset) as usize;
                            data.get(offset..offset + len)
                                .map(|r| wire::record_sha256(r).to_hex())
                        } else {
                            None
                        };
                        self.ok(
                            got.as_deref() == Some(want),
                            format!("recordSha256() reproduces the sha256 of the {file} record at offset {offset}"),
                            "",
                        );
                    }
                }
            }
            (Err(e), _) => self.ok(
                false,
                format!("decodeRecording({file}) did not throw"),
                e.to_string(),
            ),
            (_, None) => self.ok(false, format!("{decoded} is readable JSON"), ""),
        }
        Some(data)
    }

    fn run(&mut self, index: &J) {
        let arr = |k: &str| {
            index
                .get(k)
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
        };
        let s = |v: &J, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();

        let valid = arr("valid");
        for entry in &valid {
            let (file, decoded) = (s(entry, "file"), s(entry, "decoded"));
            if let Some(data) = self.decoded_check(&file, &decoded) {
                let got = validate_recording(&data, self.opts());
                self.ok(
                    got.is_ok(),
                    format!("validateRecording({file}) is []"),
                    got.err().map(|e| e.to_string()).unwrap_or_default(),
                );
            }
        }
        let expected_resolved = self.json(&s(index, "resolved"));
        for entry in &valid {
            let file = s(entry, "file");
            let Some(data) = self.bytes(&file) else {
                continue;
            };
            match resolve_recording(&data, self.version, self.opts) {
                Ok((resolved, resources)) => {
                    let ok = expected_resolved
                        .as_ref()
                        .is_some_and(|e| states_equal(&resolved, e));
                    self.ok(
                        ok,
                        format!(
                            "resolveRecording({file}) deep-equals {} (excepted fields aside)",
                            s(index, "resolved")
                        ),
                        "",
                    );
                    let inline = file.starts_with("inline.");
                    let expected = if inline {
                        J::Array(arr("inline_resources"))
                    } else {
                        J::Array(vec![])
                    };
                    self.ok(
                        states_equal(&resources, &expected),
                        format!(
                            "resolveRecording({file}).resources is {}",
                            if inline {
                                "index.json's inline_resources"
                            } else {
                                "[]"
                            }
                        ),
                        "",
                    );
                }
                Err(e) => self.ok(
                    false,
                    format!("resolveRecording({file}) did not throw"),
                    e.to_string(),
                ),
            }
        }
        for entry in arr("corrupt") {
            self.expect_code(&s(&entry, "file"), &s(&entry, "code"), "validateRecording");
        }
        for entry in arr("invalid") {
            self.expect_code(&s(&entry, "file"), &s(&entry, "code"), "validateRecording");
        }
        for entry in arr("payload_invalid") {
            let (file, code) = (s(&entry, "file"), s(&entry, "code"));
            let Some(bytes) = self.bytes(&file) else {
                self.ok(false, format!("{file} is readable"), "");
                continue;
            };
            let got = match self.version {
                5 => payload::decode_shader(&bytes).err(),
                4 => payload::decode_mesh(&bytes).err(),
                _ => payload::decode_texture_v(&bytes, self.version).err(),
            };
            self.ok(
                got.as_ref().is_some_and(|e| e.code == code),
                format!("decodePayload({file}) throws \"{code}: ...\""),
                got.map(|e| e.to_string())
                    .unwrap_or_else(|| "decoded".into()),
            );
        }
        for entry in arr("payloads") {
            let file = s(&entry, "file");
            let Some(bytes) = self.bytes(&file) else {
                self.ok(false, format!("{file} is readable"), "");
                continue;
            };
            self.ok(
                wire::sha256(&bytes).to_hex() == s(&entry, "hash"),
                format!("payloadSha256({file}) equals its listed hash"),
                "",
            );
            match payload::decode_texture_v(&bytes, self.version) {
                Ok(t) => {
                    let shape = t.format == s(&entry, "format")
                        && Some(t.width) == entry.get("width").and_then(|v| v.as_i64())
                        && Some(t.height) == entry.get("height").and_then(|v| v.as_i64())
                        && Some(t.mipmaps) == entry.get("mipmaps").and_then(|v| v.as_bool());
                    self.ok(
                        shape,
                        format!("decodeTexturePayload({file}) decodes to its listed shape"),
                        "",
                    );
                    let expected = payload::expected_data_bytes_v(
                        &s(&entry, "format"),
                        entry.get("width").and_then(|v| v.as_u64()).unwrap_or(0),
                        entry.get("height").and_then(|v| v.as_u64()).unwrap_or(0),
                        entry
                            .get("mipmaps")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                        self.version,
                    );
                    self.ok(
                        expected == Some(t.data.len() as u128),
                        format!("expectedDataBytes() agrees with {file}'s actual data length"),
                        "",
                    );
                }
                Err(e) => self.ok(
                    false,
                    format!("decodeTexturePayload({file}) decodes to its listed shape"),
                    e.to_string(),
                ),
            }
            self.ok(
                Some(bytes.len() as u64) == entry.get("bytes").and_then(|v| v.as_u64()),
                format!("{file}'s total byte length equals index.json's listed \"bytes\""),
                "",
            );
        }
        for entry in arr("mesh_payloads") {
            let file = s(&entry, "file");
            let Some(bytes) = self.bytes(&file) else {
                self.ok(false, format!("{file} is readable"), "");
                continue;
            };
            self.ok(
                wire::sha256(&bytes).to_hex() == s(&entry, "hash"),
                format!("meshPayloadSha256({file}) equals its listed hash"),
                "",
            );
            match payload::decode_mesh(&bytes) {
                Ok(m) => {
                    let shape = m.primitive.as_str() == s(&entry, "primitive")
                        && Some(m.format) == entry.get("format").and_then(|v| v.as_i64())
                        && Some(m.vertex_count)
                            == entry.get("vertex_count").and_then(|v| v.as_i64())
                        && Some(m.index_count) == entry.get("index_count").and_then(|v| v.as_i64());
                    self.ok(
                        shape,
                        format!("decodeMeshPayload({file}) decodes to its listed shape"),
                        "",
                    );
                }
                Err(e) => self.ok(
                    false,
                    format!("decodeMeshPayload({file}) decodes to its listed shape"),
                    e.to_string(),
                ),
            }
            self.ok(
                Some(bytes.len() as u64) == entry.get("bytes").and_then(|v| v.as_u64()),
                format!("{file}'s total byte length equals index.json's listed \"bytes\""),
                "",
            );
        }
        for entry in arr("shader_payloads") {
            let file = s(&entry, "file");
            let Some(bytes) = self.bytes(&file) else {
                self.ok(false, format!("{file} is readable"), "");
                continue;
            };
            self.ok(
                wire::sha256(&bytes).to_hex() == s(&entry, "hash"),
                format!("shaderPayloadSha256({file}) equals its listed hash"),
                "",
            );
            match payload::decode_shader(&bytes) {
                Ok(p) => self.ok(
                    p.code.len() as i64 == p.code_bytes,
                    format!("decodeShaderPayload({file}) decodes a code string whose UTF-8 length equals code_bytes"),
                    "",
                ),
                Err(e) => self.ok(false, format!("decodeShaderPayload({file}) decodes"), e.to_string()),
            }
            self.ok(
                Some(bytes.len() as u64) == entry.get("bytes").and_then(|v| v.as_u64()),
                format!("{file}'s total byte length equals index.json's listed \"bytes\""),
                "",
            );
        }
        // golden-7's window2 leg (render-stream-7.md "As built (G7w)"): three transactions of an
        // unchanging scene, each of whose resolved `state` equals resolved-rate.json's sole one.
        if let Some(leg) = index.get("window2_leg").cloned() {
            let (file, decoded, resolved_file) =
                (s(&leg, "file"), s(&leg, "decoded"), s(&leg, "resolved"));
            if let Some(data) = self.decoded_check(&file, &decoded) {
                let got = validate_recording(&data, self.opts());
                self.ok(
                    got.is_ok(),
                    format!("validateRecording({file}) is []"),
                    got.err().map(|e| e.to_string()).unwrap_or_default(),
                );
                let want = self
                    .json(&resolved_file)
                    .and_then(|e| e.pointer("/transactions/0/state").cloned());
                match resolve_recording(&data, self.version, self.opts) {
                    Ok((resolved, _)) => {
                        let txs = resolved
                            .get("transactions")
                            .and_then(|t| t.as_array())
                            .cloned()
                            .unwrap_or_default();
                        let ok = !txs.is_empty()
                            && want.as_ref().is_some_and(|w| {
                                txs.iter()
                                    .all(|t| t.get("state").is_some_and(|st| states_equal(st, w)))
                            });
                        self.ok(
                            ok,
                            format!("every transaction of resolveRecording({file}) has {resolved_file}'s state ({} transactions)", txs.len()),
                            "",
                        );
                    }
                    Err(e) => self.ok(
                        false,
                        format!("resolveRecording({file}) did not throw"),
                        e.to_string(),
                    ),
                }
            }
        }
        for key in [
            "params_leg",
            "presentation_leg",
            "snap_leg",
            "rate_leg",
            "off_leg",
        ] {
            let Some(leg) = index.get(key).cloned() else {
                continue;
            };
            let (file, decoded, resolved_file) =
                (s(&leg, "file"), s(&leg, "decoded"), s(&leg, "resolved"));
            let Some(data) = self.decoded_check(&file, &decoded) else {
                continue;
            };
            let got = validate_recording(&data, self.opts());
            self.ok(
                got.is_ok(),
                format!("validateRecording({file}) is []"),
                got.err().map(|e| e.to_string()).unwrap_or_default(),
            );
            let expected = self.json(&resolved_file);
            match resolve_recording(&data, self.version, self.opts) {
                Ok((resolved, _)) => self.ok(
                    expected.as_ref().is_some_and(|e| states_equal(&resolved, e)),
                    format!("resolveRecording({file}) deep-equals {resolved_file} (excepted fields aside)"),
                    "",
                ),
                Err(e) => self.ok(false, format!("resolveRecording({file}) did not throw"), e.to_string()),
            }
        }
    }
}

/// Runs one golden directory (`golden-<version>`), reading `golden-<version>/...` through `read`.
pub fn run_golden(version: u8, read: ReadFn, opts: GoldenOptions) -> Vec<Check> {
    let dir = format!("golden-{version}");
    let mut suite = Suite {
        label: dir.clone(),
        dir: dir.clone(),
        version,
        read,
        opts,
        checks: Vec::new(),
    };
    match suite.json("index.json") {
        Some(index) => suite.run(&index),
        None => suite.ok(false, "index.json is readable", ""),
    }
    suite.checks
}

/// golden-2 to golden-8 (or one of them), plus the cross-version `bad-magic` checks.
pub fn run_all(read: ReadFn, only: Option<u8>, opts: GoldenOptions) -> Vec<Check> {
    let mut checks = Vec::new();
    for v in 2..=8u8 {
        if only.is_none_or(|o| o == v) {
            checks.extend(run_golden(v, read, opts));
        }
    }
    // A /N decode refuses the neighbouring versions' magic.
    for (file_v, as_v) in [
        (3u8, 2u8),
        (2, 3),
        (4, 3),
        (3, 4),
        (5, 4),
        (4, 5),
        (6, 5),
        (5, 6),
        (6, 7),
        (8, 7),
    ] {
        if only.is_some_and(|o| o != file_v && o != as_v) {
            continue;
        }
        let path = format!("golden-{file_v}/full.rs{file_v}");
        let got = read(&path).map(|d| validate_recording(&d, Options::new(as_v)));
        let ok = matches!(&got, Some(Err(e)) if e.code == "bad-magic");
        checks.push(Check {
            name: format!("cross-version: golden-{file_v}/full.rs{file_v} decoded as version {as_v} is rejected with bad-magic"),
            ok,
            detail: match got {
                None => "file missing".into(),
                Some(Ok(())) => "accepted".into(),
                Some(Err(e)) => e.to_string(),
            },
        });
    }
    checks
}
