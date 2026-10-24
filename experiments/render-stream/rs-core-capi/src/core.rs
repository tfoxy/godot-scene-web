//! One receiver stream through the core: the session, every record after it, the payloads the
//! applier needs, and the applier itself. `lib.rs` wraps this in the C ABI; the tests and the
//! check CLI drive it directly.
//!
//! Every answer the receiver reads is written as a Variant tree (`vt.rs`) in the exact shape
//! the former GDScript applier (`rs_applier.gd`, removed in G7gd) and `Rs2Decoder` give receiver.gd, so receiver.gd's own logic (failure
//! seqs, evidence, acks) runs unchanged on top of either core.

use crate::ops::OpBuf;
use crate::plan::{Library, Needed, Payloads, Planner, Sabotage};
use crate::vt::{gd, Vt};
use render_stream_core::canon;
use render_stream_core::meta::{self, DecodeBufs, TxMeta};
use render_stream_core::payload::{self, PayloadKind};
use render_stream_core::state::{Hash, ResolvedState};
use render_stream_core::validate::{Accepted, DigestPolicy, Options, Validator};
use render_stream_core::wire::{self, Error};
use std::collections::HashMap;

/// The receiver's file protocol (render-stream/6): the version a `Core` starts at.
pub const VERSION: u8 = 6;

/// The versions a receiver stream may be at (G7xwl): render-stream/6 (files, and native live by
/// default) and render-stream/7 (live-transport-only). A /7 stream's records are /6's byte for
/// byte; only the magic, the protocol string and `publication.credit_window` differ
/// (render-stream-7.md), and rs-core's validator already gates all three on `version`. G8t adds
/// render-stream/8 files (gate 8 recordings, render-stream-8.md): rs-core validates and resolves
/// /8 since G8w, and the apply layer ignores /8's additions (`origin`, `adopted_content`,
/// `source_format`), so a /8 stream applies like a /6 one. G8k9 adds render-stream/9 files the same
/// way (render-stream-9.md): the apply layer ignores `variants` and the delivery declaration, so a
/// /9 stream draws its `decoded` payloads exactly as /8 would. The live hello still offers .6/.7 only.
pub const VERSIONS: [u8; 4] = [6, 7, 8, 9];

pub const KIND_ERROR: i32 = 0;
pub const KIND_RESOURCE: i32 = 1;
pub const KIND_TRANSACTION: i32 = 2;
pub const KIND_END: i32 = 3;
pub const KIND_SESSION: i32 = 4;

#[derive(Default)]
pub struct Core {
    validator: Option<Validator>,
    pub planner: Planner,
    provided: HashMap<Hash, Vec<u8>>,
    /// G7o3 (D31): payloads verified and checked when they arrived (`stage`, the receiver's fetch
    /// completion, inline record or cache read), waiting for the apply that first uses them.
    /// `provide` moves one into `provided` without hashing it again; `unstage` drops one the
    /// receiver's memory cache evicted, so this never outgrows the cache.
    staged: HashMap<Hash, Vec<u8>>,
    /// G7o3: payload counters since the core was made (`payload_counters`).
    pub payloads: PayloadCounters,
    library: HashMap<String, Library>,
    /// The planner's RenderingServer calls from the last begin_session / apply / dispose.
    pub ops: OpBuf,
    /// The last Variant-tree answer.
    pub vt: Vt,
    /// The last text or byte answer (an error, a JSON document, a payload).
    pub text: Vec<u8>,
    session_meta: Vec<u8>,
    last_resource: Option<Hash>,
    /// The current stream's wire version (the last `session()`'s; VERSION before any).
    version: u8,
    /// G7o2 (D31): the next `session()` defers the per-record digest (`record.sha256` is "" in
    /// every answer; the caller fills it after the frame with `record_digest`).
    pub digest_deferred: bool,
}

/// `_frame()`'s two `truncated` checks: the record at `offset` as a slice, its length prefix
/// included.
fn frame_at(data: &[u8], offset: usize) -> Result<&[u8], Error> {
    let size = data.len();
    if offset + 4 > size {
        return Err(Error::new(
            "truncated",
            format!("record length prefix at offset {offset} runs past the end of the input ({size} bytes)"),
        ));
    }
    let record_len = wire::le_u32(data, offset) as usize;
    let end = offset + 4 + record_len;
    if end > size {
        return Err(Error::new(
            "truncated",
            format!("record at offset {offset} declares record_len {record_len}, which runs past the end of the input ({size} bytes)"),
        ));
    }
    Ok(&data[offset..end])
}

/// G7o3: where each payload's verification happened. `in_frame` counts payloads `provide` had
/// to hash inside the frame because nothing was staged for them (the pre-G7o3 path).
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct PayloadCounters {
    pub staged: i64,
    pub refused: i64,
    pub unstaged: i64,
    pub provided_staged: i64,
    pub provided_in_frame: i64,
    pub provided_in_frame_bytes: i64,
}

fn err_text(e: &Error) -> String {
    format!("{}: {}", e.code, e.detail)
}

impl Core {
    pub fn new() -> Core {
        Core {
            planner: Planner::new(),
            version: VERSION,
            ..Core::default()
        }
    }

    pub fn set_sabotage(&mut self, name: &str) {
        self.planner.sab = Sabotage::parse(name);
    }

    pub fn state(&self) -> Option<&ResolvedState> {
        self.validator.as_ref().map(|v| v.state())
    }

    /// The `{record, errors, kind}` Dictionary of a record that failed: `kind` is "" when the
    /// record itself did not decode (receiver.gd then takes the failure seq from the meta, or the
    /// next expected seq), else the record's type; `record.meta` carries an integer `seq` when the
    /// meta has one.
    fn write_failure(&mut self, record: &[u8], offset: usize, e: &Error) {
        let decode_failed = {
            let mut bufs = DecodeBufs::default();
            let mut tx = TxMeta::default();
            meta::decode_record(record, offset, self.version, &mut bufs, &mut tx).is_err()
        };
        let parsed: Option<serde_json::Value> = wire::frame(record, offset)
            .ok()
            .and_then(|f| serde_json::from_slice(f.meta).ok());
        let obj = parsed.as_ref().and_then(|v| v.as_object());
        let kind = if decode_failed {
            String::new()
        } else {
            obj.and_then(|o| o.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string()
        };
        let seq = obj.and_then(|o| o.get("seq")).and_then(|s| {
            s.as_i64()
                .or_else(|| s.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
        });
        let v = &mut self.vt;
        v.clear();
        v.dict(3);
        v.key("record");
        v.dict(1);
        v.key("meta");
        match seq {
            Some(s) => {
                v.dict(1);
                v.key("seq");
                v.int(s);
            }
            None => v.dict(0),
        }
        v.key("errors");
        v.strings(&[&err_text(e)]);
        v.key("kind");
        v.str(&kind);
    }

    /// The session record at `offset` of `data` (a new stream: the validator restarts), of a
    /// render-stream/`version` stream: one of VERSIONS, whose magic the caller has checked
    /// (receiver.gd's `split_records`). Writes
    /// `{record: {offset, byte_length, sha256, meta_json, blocks}, errors, kind}`.
    pub fn session(&mut self, data: &[u8], offset: usize, version: u8) -> i32 {
        self.validator = None;
        if !VERSIONS.contains(&version) {
            let e = Error::new(
                "bad-magic",
                format!("the receiver core speaks render-stream/6, /7 and /8, not /{version}"),
            );
            self.write_failure(&[], offset, &e);
            return KIND_ERROR;
        }
        self.version = version;
        self.provided.clear();
        self.library.clear();
        self.planner.touched.clear();
        let record = match frame_at(data, offset) {
            Ok(r) => r,
            Err(e) => {
                self.write_failure(&[], offset, &e);
                return KIND_ERROR;
            }
        };
        let opts = Options {
            version,
            digest: if self.digest_deferred {
                DigestPolicy::Deferred
            } else {
                DigestPolicy::Inline
            },
            verify_payload_hashes: true,
        };
        let validator = match Validator::new(record, offset, opts) {
            Ok(v) => v,
            Err(e) => {
                self.write_failure(record, offset, &e);
                return KIND_ERROR;
            }
        };
        self.session_meta = wire::frame(record, offset)
            .map(|f| f.meta.to_vec())
            .unwrap_or_default();
        let s = validator.session();
        let digest = validator.record_digests()[0]
            .map(|h| h.to_hex())
            .unwrap_or_default();
        let v = &mut self.vt;
        v.clear();
        v.dict(3);
        v.key("record");
        v.dict(5);
        v.key("offset");
        v.int(offset as i64);
        v.key("byte_length");
        v.int(record.len() as i64);
        v.key("sha256");
        v.str(&digest);
        v.key("meta_json");
        v.str(std::str::from_utf8(&self.session_meta).unwrap_or(""));
        v.key("blocks");
        v.array(5);
        let f32s = |v: &mut Vt, xs: &[f32]| {
            let wide: Vec<f64> = xs.iter().map(|x| *x as f64).collect();
            v.packed_f(gd::PACKED_FLOAT32_ARRAY, wide.len(), &wide);
        };
        f32s(v, &s.clear_color);
        f32s(v, &s.root_canvas_xform);
        f32s(v, &s.host_visible_rect);
        f32s(v, &s.host_final_xform);
        f32s(v, &[s.content_scale_factor]);
        v.key("errors");
        v.strings(&[]);
        v.key("kind");
        v.str("session");
        self.validator = Some(validator);
        KIND_SESSION
    }

    /// G7o2 (D31's deferred digest): the record at `offset` of `data`'s SHA-256 (hex, what an
    /// inline `record.sha256` would have been), into text. Err when there is no record there.
    pub fn record_digest(&mut self, data: &[u8], offset: usize) -> Result<(), String> {
        let record = frame_at(data, offset).map_err(|e| e.to_string())?;
        self.text = wire::record_sha256(record).to_hex().into_bytes();
        Ok(())
    }

    /// RsApplier.begin_session(): the session's RenderingServer calls.
    pub fn begin_session(&mut self) {
        self.ops.clear();
        let v = self.validator.as_ref().expect("a session");
        let s = v.session();
        self.planner.begin_session(
            &mut self.ops,
            self.version,
            s.clear_color,
            s.root_canvas_xform,
            s.viewport.canvas_cull_mask,
        );
    }

    /// One record after the session. Writes RsApplier.accept_record()'s `{record, errors, kind}`:
    /// `record` has offset, byte_length, sha256 and a `meta` with what receiver.gd reads.
    pub fn accept(&mut self, data: &[u8], offset: usize) -> i32 {
        let record = match frame_at(data, offset) {
            Ok(r) => r,
            Err(e) => {
                self.write_failure(&[], offset, &e);
                return KIND_ERROR;
            }
        };
        let result = match self.validator.as_mut() {
            Some(v) => v.accept(record, offset),
            None => Err(Error::new("missing-session", "no session")),
        };
        let accepted = match result {
            Ok(a) => a,
            Err(e) => {
                self.write_failure(record, offset, &e);
                return KIND_ERROR;
            }
        };
        let validator = self.validator.as_ref().unwrap();
        let digest = validator
            .record_digests()
            .last()
            .copied()
            .flatten()
            .map(|h| h.to_hex())
            .unwrap_or_default();
        let kind;
        let v = &mut self.vt;
        v.clear();
        v.dict(3);
        v.key("record");
        v.dict(4);
        v.key("offset");
        v.int(offset as i64);
        v.key("byte_length");
        v.int(record.len() as i64);
        v.key("sha256");
        v.str(&digest);
        v.key("meta");
        match accepted {
            Accepted::Resource { hash } => {
                kind = KIND_RESOURCE;
                self.last_resource = Some(hash);
                v.dict(2);
                v.key("type");
                v.str("resource");
                v.key("hash");
                v.str(&hash.to_hex());
            }
            Accepted::End => {
                kind = KIND_END;
                v.dict(1);
                v.key("type");
                v.str("end");
            }
            Accepted::Transaction => {
                kind = KIND_TRANSACTION;
                self.planner.touched.merge(validator.delta());
                let st = validator.state();
                v.dict(7);
                v.key("type");
                v.str("transaction");
                v.key("seq");
                v.int(st.seq);
                v.key("frame");
                v.int(st.frame);
                v.key("encoding");
                v.str(st.encoding.as_str());
                v.key("status");
                v.str(st.status.as_str());
                v.key("failures");
                v.array(st.failures.len());
                for f in &st.failures {
                    v.dict(2);
                    v.key("reason");
                    v.str(f.reason);
                    v.key("detail");
                    v.str(&f.detail);
                }
                v.key("unsupported");
                v.array(st.unsupported.len());
                for u in &st.unsupported {
                    v.dict(3);
                    v.key("op");
                    v.str(&u.op);
                    v.key("item");
                    v.opt_int(u.item.map(|i| i as i64));
                    v.key("reason");
                    v.str(u.reason);
                }
            }
        }
        v.key("errors");
        v.strings(&[]);
        v.key("kind");
        v.str(match kind {
            KIND_RESOURCE => "resource",
            KIND_END => "end",
            _ => "transaction",
        });
        kind
    }

    /// The last resource record's verified inline payload, into `text`.
    pub fn resource_payload(&mut self) -> bool {
        let (Some(v), Some(h)) = (self.validator.as_ref(), self.last_resource) else {
            return false;
        };
        match v.inline_payload(&h) {
            Some(p) => {
                self.text.clear();
                self.text.extend_from_slice(p);
                true
            }
            None => false,
        }
    }

    pub fn needed_raw(&self) -> Needed {
        match self.validator.as_ref() {
            Some(v) => self.planner.needed(v.state()),
            None => Needed::default(),
        }
    }

    /// RsApplier.needed()'s `{hashes, ids, mesh_hashes, shader_hashes}` plus `library` (the
    /// `withheld` shader hashes whose library code the apply reads).
    pub fn needed(&mut self) {
        let n = self.needed_raw();
        let v = &mut self.vt;
        v.clear();
        v.dict(5);
        v.key("hashes");
        v.array(n.hashes.len());
        for h in &n.hashes {
            v.str(&h.to_hex());
        }
        v.key("ids");
        v.array(n.texture_ids.len());
        for id in &n.texture_ids {
            v.int(*id as i64);
        }
        v.key("mesh_hashes");
        v.array(n.mesh_hashes.len());
        for h in &n.mesh_hashes {
            v.str(&h.to_hex());
        }
        v.key("shader_hashes");
        v.array(n.shader_hashes.len());
        for h in &n.shader_hashes {
            v.str(&h.to_hex());
        }
        v.key("library");
        v.array(n.library.len());
        for h in &n.library {
            v.str(h);
        }
    }

    /// The SHA-256 check against `hash_hex` (`resource-hash-mismatch`) and the decode by magic
    /// (`resource-invalid`): what `stage` and an unstaged `provide` both run. Err is
    /// "<code>: <detail>".
    fn verify(&self, hash_hex: &str, bytes: &[u8]) -> Result<Hash, String> {
        let Some(h) = Hash::from_hex(hash_hex) else {
            return Err(format!(
                "resource-unavailable: {hash_hex:?} is not a sha256 hex name"
            ));
        };
        if wire::sha256(bytes) != h {
            return Err(format!(
                "resource-hash-mismatch: payload {hash_hex} ({} bytes) does not hash to its name",
                bytes.len()
            ));
        }
        let decoded = match payload::payload_kind(bytes, self.version) {
            PayloadKind::Texture => payload::decode_texture_v(bytes, self.version).map(|_| ()),
            PayloadKind::Mesh => payload::decode_mesh(bytes).map(|_| ()),
            PayloadKind::Shader => payload::decode_shader(bytes).map(|_| ()),
            PayloadKind::Ktx2 => payload::decode_ktx2(bytes).map(|_| ()),
        };
        if let Err(e) = decoded {
            return Err(format!(
                "resource-invalid: payload {hash_hex}: {}",
                err_text(&e)
            ));
        }
        Ok(h)
    }

    /// G7o3 (D31): a payload as it arrives, ahead of the transaction that uses it: verified and
    /// decoded now (`verify`), then held until `provide` names it. A refused payload stages
    /// nothing and drops an earlier copy staged under the same name. Err is "<code>: <detail>".
    pub fn stage(&mut self, hash_hex: &str, bytes: &[u8]) -> Result<(), String> {
        match self.verify(hash_hex, bytes) {
            Ok(h) => {
                self.staged.insert(h, bytes.to_vec());
                self.payloads.staged += 1;
                Ok(())
            }
            Err(e) => {
                if let Some(h) = Hash::from_hex(hash_hex) {
                    self.staged.remove(&h);
                }
                self.payloads.refused += 1;
                Err(e)
            }
        }
    }

    /// G7o3: the receiver's memory cache evicted (or cleared) `hash_hex`; its staged copy goes.
    pub fn unstage(&mut self, hash_hex: &str) {
        if let Some(h) = Hash::from_hex(hash_hex) {
            if self.staged.remove(&h).is_some() {
                self.payloads.unstaged += 1;
            }
        }
    }

    pub fn staged_len(&self) -> usize {
        self.staged.len()
    }

    /// A payload for the next apply. A staged one (verified when it arrived) moves into the
    /// apply's set without being hashed again, and `bytes` is not read. Anything else is verified
    /// against its name (`resource-hash-mismatch`) and decoded by its magic (`resource-invalid`)
    /// here, inside the frame, before it is kept. Err is "<code>: <detail>".
    pub fn provide(&mut self, hash_hex: &str, bytes: &[u8]) -> Result<(), String> {
        if let Some(h) = Hash::from_hex(hash_hex) {
            if let Some(staged) = self.staged.remove(&h) {
                self.provided.insert(h, staged);
                self.payloads.provided_staged += 1;
                return Ok(());
            }
        }
        let h = self.verify(hash_hex, bytes)?;
        self.provided.insert(h, bytes.to_vec());
        self.payloads.provided_in_frame += 1;
        self.payloads.provided_in_frame_bytes += bytes.len() as i64;
        Ok(())
    }

    /// RsResourceCache.library_code()'s answer for a `withheld` shader's hash.
    pub fn provide_library(&mut self, hash_hex: &str, ok: bool, code_or_detail: &str) {
        let r = if ok {
            Library::Ok(code_or_detail.to_string())
        } else {
            Library::Missing(code_or_detail.to_string())
        };
        self.library.insert(hash_hex.to_string(), r);
    }

    /// RsApplier.apply_state(): the RenderingServer calls into `ops`, the statistics into `vt`.
    /// The provided payloads and library results are dropped afterwards (the shim has copied what
    /// the calls need). Err is "<code>: <detail>".
    pub fn apply(&mut self) -> Result<(), String> {
        self.ops.clear();
        self.vt.clear();
        let Some(v) = self.validator.as_ref() else {
            return Err("missing-session: apply before a session".into());
        };
        let payloads = Payloads {
            provided: &self.provided,
            library: &self.library,
            version: self.version,
        };
        let r = self
            .planner
            .apply(v.state(), &payloads, &mut self.ops, &mut self.vt);
        self.provided.clear();
        self.library.clear();
        r
    }

    /// RsApplier.dispose(): frees every RID the applier made; returns how many.
    pub fn dispose(&mut self) -> i64 {
        self.ops.clear();
        self.planner.dispose(&mut self.ops)
    }

    /// The resolved state as receiver.gd's state dump carries it: render-stream-2.md's resolved
    /// `state` object (the TypeScript form, which `statesEqual()` compares), without the
    /// skip-session `unknown_items` account the GDScript dump does not carry either.
    pub fn state_json(&mut self) {
        self.text.clear();
        let Some(v) = self.validator.as_ref() else {
            return;
        };
        let st = v.state();
        if st.unknown_items.is_some() {
            let mut copy = st.clone();
            copy.unknown_items = None;
            canon::write_state(&mut self.text, &copy);
        } else {
            canon::write_state(&mut self.text, st);
        }
    }

    /// Counters receiver.gd reads off the applier and the stream.
    pub fn counters(&mut self) {
        let p = &self.planner;
        let (last_seq, transactions) = match self.validator.as_ref() {
            Some(v) => (v.state().seq, v.transactions()),
            None => (0, 0),
        };
        let resident = p.resident();
        let xf = p.root_canvas_xform();
        let v = &mut self.vt;
        v.clear();
        let pc = self.payloads;
        let staged_now = self.staged.len() as i64;
        v.dict(20);
        v.key("rs_calls");
        v.int(p.rs_calls);
        v.key("created_rids");
        v.int(p.created_rids);
        v.key("freed_by_apply");
        v.int(p.freed_by_apply);
        v.key("disposed_frees");
        v.int(p.disposed_frees);
        v.key("owned_rids");
        v.int(p.owned_rids());
        for (k, n) in ["items", "textures", "meshes", "shaders", "materials"]
            .iter()
            .zip(resident)
        {
            v.key(k);
            v.int(n);
        }
        v.key("root_canvas_xform");
        let wide: Vec<f64> = xf.iter().map(|x| *x as f64).collect();
        v.packed_f(gd::PACKED_FLOAT32_ARRAY, wide.len(), &wide);
        v.key("last_seq");
        v.int(last_seq);
        v.key("transactions");
        v.int(transactions);
        // G7o3: where payloads were verified (`stage` on arrival, or `provide` in the frame).
        for (k, n) in [
            ("payloads_staged", pc.staged),
            ("payloads_refused", pc.refused),
            ("payloads_unstaged", pc.unstaged),
            ("payloads_provided_staged", pc.provided_staged),
            ("payloads_provided_in_frame", pc.provided_in_frame),
            ("payloads_provided_in_frame_bytes", pc.provided_in_frame_bytes),
            ("payloads_staged_now", staged_now),
        ] {
            v.key(k);
            v.int(n);
        }
    }
}
