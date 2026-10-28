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
use crate::mm::MmStore;
use render_stream_core::apply::dynamic::{body_sha256, DynamicMeshes};
use render_stream_core::apply::retention::Retention;
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
/// CG1 adds render-stream/10 (render-stream-10.md): the planner re-issues each item's
/// `canvas_group` and `copy_to_backbuffer` state and the receiver's Godot does the rest. W11a adds
/// render-stream/11 (render-stream-11.md decision 12): rs-core validates the carried set and the
/// dynamic meshes. W11d ("As built (W11d)"): the core ingests each transaction's dynamic bodies
/// at accept (`DynamicMeshes`), the planner draws them by mesh id with region uploads, the
/// retention rule hands every hash that left H back to the receiver's cache (`take_released`),
/// and `check_fetch` is `inline-fetch-zero`; the live hello offers .11 under
/// RS_RECEIVER_PROTOCOL=11. PM5 adds render-stream/12 (render-stream-12.md "Receivers"): rs-core
/// validates and resolves the particles table and the emit list, and the planner counts every
/// `add_particles` as `particles_commands_undrawn` (`particles-undrawn`) until PM6 replays it;
/// the live hello offers .12 under RS_RECEIVER_PROTOCOL=12.
pub const VERSIONS: [u8; 7] = [6, 7, 8, 9, 10, 11, 12];

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
    /// W11d (render-stream-11.md "Receivers"): the newest body of every /11 dynamic mesh surface,
    /// ingested right after each accepted transaction (the record's bytes are the caller's and are
    /// reused by the next message).
    pub dynamic: DynamicMeshes,
    /// PM2 (render-stream-11.md "As built (PM2)"): the newest buffer of every `ok` /11
    /// multimesh, ingested at accept beside the dynamic bodies.
    pub multimeshes: MmStore,
    /// PM6a (render-stream-12.md "As built (PM6a)"): the `particle_emits` of every transaction
    /// accepted since the last apply (copied at accept, with their floats), applied in order.
    pub particle_emits: Vec<render_stream_core::state::ParticleEmit>,
    /// W11d: the retention rule (H = C ∪ names(S_n) ∪ names(S_d)): queued after each accepted
    /// transaction, swept after each accept and each apply.
    retention: Retention,
    /// W11d: the hashes the rule dropped since the last `take_released`, for the receiver's
    /// `RsResourceCache` (the store): their staged copies are already gone.
    released_out: Vec<Hash>,
    /// W11d receiver sabotages (RS_RECEIVER_SABOTAGE, W11c's kinds): `stale-dynamic-rx` (a body
    /// whose surface's shape holds is not ingested), `no-prune` (the validator keeps C lifelong)
    /// and `ignore-released` (the rule hands nothing back: the cache keeps what left H).
    w11_sab: W11Sabotage,
    /// W11d evidence (`dynamic_sha256`): dynamic surfaces checked against the resolved
    /// `body_sha256`, and how many held a different body.
    dynamic_checked: i64,
    dynamic_mismatched: i64,
}

/// W11d: the /11 receiver sabotages the core implements (`evict-carried` is receiver.gd's).
#[derive(Default, Clone, Copy, Debug)]
pub struct W11Sabotage {
    pub stale_dynamic_rx: bool,
    pub no_prune: bool,
    pub ignore_released: bool,
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
        self.w11_sab = W11Sabotage {
            stale_dynamic_rx: name == "stale-dynamic-rx",
            no_prune: name == "no-prune",
            ignore_released: name == "ignore-released",
        };
        // receiver.gd opens the core (and so names the sabotage) after the session record.
        if let Some(v) = self.validator.as_mut() {
            v.set_no_prune(self.w11_sab.no_prune);
        }
    }

    /// G8kp (texture-delivery-design.md D3): the receiver's `texture_encodings` and `gpu_formats`,
    /// as its hello states them; the planner then fetches and uploads D3's choice per texture.
    /// False (error in `text`) for a list render-stream-9.md's grammar or names refuse.
    pub fn set_delivery(&mut self, encodings: &str, gpu_formats: &str) -> bool {
        match render_stream_core::delivery::DeliveryPrefs::parse(encodings, gpu_formats) {
            Ok(mut p) => {
                // G8ku: the D6 policy is not part of the hello; a new preference keeps it.
                p.upgrade = self.planner.delivery.upgrade;
                p.refused = std::mem::take(&mut self.planner.delivery.refused);
                // G8kwh: nor is WebGL's alignment rule.
                p.bc_aligned_only = self.planner.delivery.bc_aligned_only;
                self.planner.delivery = p;
                true
            }
            Err(e) => {
                self.text = e.into_bytes();
                false
            }
        }
    }

    /// G8kf (texture-delivery-design.md Q3): the receiver could not transcode the variant `hash_hex`
    /// (`delivery-transcode-failed`); D3 then chooses the entry's next preference, `decoded` at
    /// last. False for a malformed hash.
    pub fn refuse_variant(&mut self, hash_hex: &str) -> bool {
        match Hash::from_hex(hash_hex) {
            Some(h) => {
                self.planner.delivery.refuse(h);
                true
            }
            None => false,
        }
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
                format!("the receiver core speaks render-stream/6, /7, /8, /9, /10, /11 and /12, not /{version}"),
            );
            self.write_failure(&[], offset, &e);
            return KIND_ERROR;
        }
        self.version = version;
        self.provided.clear();
        self.library.clear();
        self.planner.touched.clear();
        self.dynamic.clear();
        self.multimeshes.clear();
        self.particle_emits.clear();
        self.retention.clear();
        self.released_out.clear();
        self.dynamic_checked = 0;
        self.dynamic_mismatched = 0;
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
            early_prune: false,
        };
        let mut validator = match Validator::new(record, offset, opts) {
            Ok(v) => v,
            Err(e) => {
                self.write_failure(record, offset, &e);
                return KIND_ERROR;
            }
        };
        validator.set_no_prune(self.w11_sab.no_prune);
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
        if matches!(accepted, Accepted::Transaction) && self.version >= 11 {
            if let Err(e) = self.ingest_dynamic(record) {
                self.write_failure(record, offset, &e);
                return KIND_ERROR;
            }
        }
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

    /// W11d: the accepted transaction's dynamic bodies into `dynamic` (before `record` is gone),
    /// then the retention rule's queue and sweep. `stale-dynamic-rx` skips each body whose surface
    /// already holds one of the same shape (so a pose change is ignored, a shape change is not).
    fn ingest_dynamic(&mut self, record: &[u8]) -> Result<(), Error> {
        let v = self
            .validator
            .as_ref()
            .expect("an accepted transaction has a validator");
        let st = v.state();
        if self.w11_sab.stale_dynamic_rx {
            let held = &self.dynamic;
            let bodies: Vec<_> = v
                .dynamic_bodies()
                .iter()
                .filter(|b| {
                    let now = st
                        .meshes
                        .get(&b.mesh)
                        .and_then(|m| m.surfaces.get(b.surface as usize));
                    let had = held
                        .get(b.mesh)
                        .and_then(|m| m.surfaces.get(b.surface as usize))
                        .and_then(|g| g.as_ref());
                    !matches!((now, had), (Some(s), Some(g))
                        if s.primitive == g.layout.primitive
                            && s.format == g.layout.format
                            && s.vertex_count as usize == g.layout.vertex_count
                            && s.index_count as usize == g.layout.index_count)
                })
                .cloned()
                .collect();
            self.dynamic.ingest(st, &bodies, record)?;
        } else {
            self.dynamic.ingest(st, v.dynamic_bodies(), record)?;
        }
        // PM2: the transaction's multimesh buffers, before `record` goes back to the caller.
        self.multimeshes.ingest(st, v.multimesh_buffers(), record);
        // PM6a: the transaction's emits, applied in order by the next apply.
        self.particle_emits
            .extend(v.particle_emits().iter().cloned());
        self.retention.note(v);
        self.sweep();
        Ok(())
    }

    /// W11d: drops every queued hash that left H (`Retention::sweep_with`): its staged copy here,
    /// and it is handed to the receiver (`take_released`), whose cache forgets it.
    fn sweep(&mut self) {
        let Some(v) = self.validator.as_ref() else {
            return;
        };
        let planner = &self.planner;
        let staged = &mut self.staged;
        let out = &mut self.released_out;
        let ignore = self.w11_sab.ignore_released;
        self.retention.sweep_with(
            v,
            || planner.displayed_hashes(),
            |h| {
                if ignore {
                    return false;
                }
                staged.remove(h);
                out.push(*h);
                true
            },
        );
    }

    /// W11d: the hashes the retention rule dropped since the last call (hex, into `vt` as an
    /// Array of Strings), for the receiver's cache to forget.
    pub fn take_released(&mut self) {
        let v = &mut self.vt;
        v.clear();
        let hex: Vec<String> = self.released_out.drain(..).map(|h| h.to_hex()).collect();
        let refs: Vec<&str> = hex.iter().map(|s| s.as_str()).collect();
        v.strings(&refs);
    }

    /// W11d (render-stream-11.md decision 9, `inline-fetch-zero`): may the receiver fetch
    /// `hash_hex` from the origin (HTTP, or the store directory in file mode) now? Err is
    /// "<code>: <detail>". Every fetch is allowed below /11.
    pub fn check_fetch(&self, hash_hex: &str) -> Result<(), String> {
        let (Some(v), Some(h)) = (self.validator.as_ref(), Hash::from_hex(hash_hex)) else {
            return Ok(());
        };
        v.check_fetch(&h).map_err(|e| err_text(&e))
    }

    /// W11d (rs-core `Validator::transport_skip`): the live coding skipped transactions (a
    /// `coding` resync); the next must be the full transaction the resync forces.
    pub fn transport_skip(&mut self) {
        if let Some(v) = self.validator.as_mut() {
            v.transport_skip();
        }
    }

    /// W11d evidence (GSW's `dynamic_sha256`, W11c): into `text`, the hex SHA-256 over every
    /// dynamic mesh the newest accepted state holds, ascending by id, each surface's (id u32 LE,
    /// surface u32 LE, the held body's SHA-256 or 32 zero bytes): equal to the TypeScript
    /// `resolvedDynamicDigest` of the resolved state exactly when every body held is right. Each
    /// surface held against the resolved `body_sha256` also counts into `dynamic_checked` and
    /// `dynamic_mismatched`. Hashes every body: evidence only (a full log).
    pub fn dynamic_sha256(&mut self) {
        self.text.clear();
        let Some(st) = self.validator.as_ref().map(|x| x.state()) else {
            return;
        };
        let mut ids: Vec<_> = st
            .meshes
            .iter()
            .filter(|(_, m)| m.is_dynamic())
            .map(|(id, _)| *id)
            .collect();
        ids.sort_unstable();
        let mut digest = Vec::new();
        for id in ids {
            let m = &st.meshes[&id];
            let held = self.dynamic.get(id);
            for (k, s) in m.surfaces.iter().enumerate() {
                let got = held
                    .and_then(|d| d.surfaces.get(k))
                    .and_then(|g| g.as_ref())
                    .map(body_sha256);
                self.dynamic_checked += 1;
                if got != s.body_sha256 {
                    self.dynamic_mismatched += 1;
                }
                digest.extend_from_slice(&id.to_le_bytes());
                digest.extend_from_slice(&(k as u32).to_le_bytes());
                digest.extend_from_slice(&got.map_or([0u8; 32], |h| h.0));
            }
        }
        self.text = wire::sha256(&digest).to_hex().into_bytes();
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
    /// `withheld` shader hashes whose library code the apply reads) and (G8ku) `ktx2_hashes` (the
    /// `uastc` variants D3 chose: KTX2 payloads, `<hash>.ktx2` in a store or cache).
    pub fn needed(&mut self) {
        let n = self.needed_raw();
        let v = &mut self.vt;
        v.clear();
        v.dict(6);
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
        v.key("ktx2_hashes");
        v.array(n.ktx2_hashes.len());
        for h in &n.ktx2_hashes {
            v.str(&h.to_hex());
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
            dynamic: &self.dynamic,
            multimeshes: &self.multimeshes,
            particle_emits: &self.particle_emits,
            version: self.version,
        };
        let r = self
            .planner
            .apply(v.state(), &payloads, &mut self.ops, &mut self.vt);
        self.particle_emits.clear();
        self.provided.clear();
        self.library.clear();
        // W11d: what the apply stopped drawing may now leave the store.
        if self.version >= 11 {
            self.sweep();
        }
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
        // W11d: the /11 retention and dynamic-geometry counters, at /11 only (the dictionary is
        // unchanged below it).
        let w11: Vec<(&str, i64)> = match self.validator.as_ref() {
            Some(val) if self.version >= 11 => vec![
                ("w11_names", val.names_len() as i64),
                ("w11_carried", val.carried_len() as i64),
                ("w11_dynamic_meshes", self.dynamic.len() as i64),
                ("w11_dynamic_surfaces", self.dynamic.surfaces() as i64),
                ("w11_dynamic_bytes", self.dynamic.bytes() as i64),
                ("w11_bodies_total", self.dynamic.bodies_total as i64),
                ("w11_body_bytes_total", self.dynamic.body_bytes_total as i64),
                ("w11_released_total", self.retention.released_total as i64),
                ("w11_released_pending", self.retention.pending_len() as i64),
                ("w11_dynamic_checked", self.dynamic_checked),
                ("w11_dynamic_mismatched", self.dynamic_mismatched),
            ],
            _ => vec![],
        };
        v.dict(20 + w11.len());
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
        for (k, n) in w11 {
            v.key(k);
            v.int(n);
        }
    }
}
