//! `rs-gsw-wasm`: the GSW browser receiver's one wasm module (gate7-design.md Q14a, Q14c, D30):
//! `render-stream-core` (decode, validation, resolve, D7's applier) and the renderer's
//! `canvas-items` executor, behind the per-transaction boundary of Q14c.
//!
//! 1. **Bytes in.** File mode: the whole recording enters wasm memory once (`alloc_recording`, a
//!    view write by the caller, `load`), outside every timer.
//! 2. **`accept(i)`** decodes, validates and resolves record `i` and computes the payloads its
//!    transaction needs (`needed_count`/`needed_ptr`, 32 bytes each). The caller copies each payload
//!    once into wasm (`alloc_payload`) and `provide` verifies its SHA-256 before use.
//! 3. **`apply()`** takes the accepted transaction to the retained state and the packed list's dirty
//!    ranges.
//! 4. **`draw()`** runs the texture ops, the dirty uploads, the GL draws and the blit.
//! 5. **Out**: a fixed `#[repr(C)]` block of u32 ([`Stats`]) the caller reads through a
//!    `Uint32Array` view of `stats_ptr()`, re-derived whenever memory grew.
//!
//! Off the frame path: `digest()` (the deferred record digest, D31), `evidence_json()` and `shot()`.
//! Nothing decoded crosses the boundary: no meta, no command objects, no draw list, no JSON per
//! frame.

use godot_scene_web_rust_prototype::canvas_items::{
    CanvasItemsExecutor, ContextState, ExecError, ExecOptions, ExecStats, FenceState, Sabotage,
};
use gsw_canvas_draw_list::Format;
use gsw_canvas_draw_list::{Binding, UniformValue};
use render_stream_core::apply::geom::{self, Xform};
use render_stream_core::apply::material_residency::MaterialCounts;
use render_stream_core::apply::payloads::{PayloadStage, PayloadStore};
use render_stream_core::apply::programs::{ProgramEntry, ProgramInfo};
use render_stream_core::apply::residency::TextureAccount;
use render_stream_core::apply::retention::Retention;
use render_stream_core::apply::{Applier, ApplySabotage, BindingKey, Viewport};
use render_stream_core::canon;
use render_stream_core::state::VariantEncoding;
use render_stream_core::meta::Stretch;
use render_stream_core::prof;
use render_stream_core::state::{Hash, Id, ShaderSource};
use render_stream_core::validate::{Accepted, DigestPolicy, Options, Validator};
use render_stream_core::wire::{self, RecordSpan};
use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

// W11t: the /11 live coding (rs-core `coding`) for the browser receivers.
mod live_coding;
pub use live_coding::{coding_bench, LiveCoding};

pub const ACCEPT_TRANSACTION: i32 = 0;
pub const ACCEPT_RESOURCE: i32 = 1;
pub const ACCEPT_END: i32 = 2;
pub const ACCEPT_NEEDS_PAYLOADS: i32 = 3;
/// W13c: `live_accept` dropped a /13 patch that arrived while a `predict-check` resync awaits its
/// full transaction (render-stream-13.md "As built (W13c)"): no apply, no ack.
pub const ACCEPT_HELD: i32 = 4;

/// W13c: a transaction message's `seq` and whether it is full, read from its meta's canonical
/// prefix (`{"type":"transaction","seq":N,"frame":N,"encoding":"…"`, every version's key order).
/// `None` for any other record (or one too short to say).
fn peek_transaction(record: &[u8]) -> Option<(u64, bool)> {
    let frame = wire::frame(record, 0).ok()?;
    let rest = frame
        .meta
        .strip_prefix(b"{\"type\":\"transaction\",\"seq\":")?;
    let digits = rest.iter().take_while(|c| c.is_ascii_digit()).count();
    let seq = std::str::from_utf8(&rest[..digits]).ok()?.parse().ok()?;
    let rest = rest[digits..].strip_prefix(b",\"frame\":")?;
    let digits = rest.iter().take_while(|c| c.is_ascii_digit()).count();
    let rest = rest[digits..].strip_prefix(b",\"encoding\":\"")?;
    Some((seq, rest.starts_with(b"full\"")))
}

/// The stats block (`web/bench/bench-rs.ts` `STAT_FIELDS`, same order).
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct Stats {
    pub status: u32,
    pub seq: u32,
    pub frame: u32,
    pub needed: u32,
    pub structural: u32,
    pub relowered: u32,
    pub rows_written: u32,
    pub lowered_draws: u32,
    pub assembly_skips: u32,
    pub emitted_draws: u32,
    pub expected_calls: u32,
    pub executed_calls: u32,
    pub merged_draws: u32,
    pub texture_uploads: u32,
    pub texture_upload_bytes: u32,
    pub item_bytes: u32,
    pub vertex_bytes: u32,
    pub index_bytes: u32,
    pub parity_violations: u32,
    pub accepted_records: u32,
    pub digests_pending: u32,
    pub vertices: u32,
    pub indices: u32,
    pub draws: u32,
    /// G7l: the accepted transaction's encoding (0 full, 1 patch).
    pub encoding: u32,
    /// G7l: the connection (stream) the accepted record arrived on, 1 in file mode.
    pub stream: u32,
}

#[derive(Clone, Default)]
struct Opts {
    digest_inline: bool,
    skip_payload_hash: bool,
    digest_skip: bool,
    format_rgba8: bool,
    exec: ExecOptions,
    apply: ApplySabotage,
    /// Native `ignore-presentation`: the session's stretch is not adopted (identity transform at
    /// the presentation size).
    ignore_presentation: bool,
    /// G7k (D29 amendment, Q10 soak), live mode only: `RS_RECEIVER_MEMORY_BUDGET_BYTES`, the
    /// store's own payload bytes (GL texture bytes are counted separately, by the live client).
    /// `None` is unlimited, matching the native receiver's unbudgeted default.
    memory_budget_bytes: Option<u64>,
    /// Sabotage `no-evict`: the budget above is parsed (so it is still reported) but
    /// [`PayloadStore::evict_unreferenced`] is simply never called.
    no_evict: bool,
    /// G8kp (texture-delivery-design.md D3, Q3): `RS_RECEIVER_TEXTURE_ENCODINGS` (default
    /// `block,decoded`) and `RS_RECEIVER_GPU_FORMAT_MASK` (families left out of `gpu_formats`).
    texture_encodings: Option<String>,
    gpu_format_mask: Vec<String>,
    /// Sabotage `ignore-format-mask`: the receiver states the masked `gpu_formats` but picks
    /// variants as if nothing were masked (`delivery-select` must catch it).
    ignore_format_mask: bool,
    /// P3-VX sabotage `vertex-flat-varyings`: every shader's varyings made `flat` before the
    /// transpiler sees the code (`pending_code`), as the native receiver does before
    /// `shader_set_code`.
    vertex_flat_varyings: bool,
    /// G8kp: `RS_RECEIVER_PROTOCOL=9` (live): offer render-stream.9 and accept a /9 session; CG1:
    /// 10 the same for render-stream.10 (W11c: 11, PM5: 12, likewise). 0 when the options carry no
    /// `live_protocol` (7 or 8).
    live_protocol: u8,
    /// G8kb (texture-delivery-design.md Q6 "GSW"): the shell runs the KTX2 transcoder worker, so
    /// the default `texture_encodings` lists `uastc` (`block,uastc,decoded`).
    transcoder: bool,
    /// G8kb (D6): `RS_RECEIVER_VARIANT_POLICY=keep|upgrade`; None is this receiver's default
    /// (upgrade where the context has neither bptc nor s3tc, the phone class, else keep).
    variant_policy: Option<bool>,
    /// W11c (G7kh's rule on the wasm side): `RS_RECEIVER_LOG=summary` keeps no per-transaction
    /// evidence (no applied.json rows, mesh rows or parameter log), only running totals, so a
    /// long live run's wasm heap is bounded by the state.
    summary_log: bool,
    /// W11c receiver sabotages (render-stream-11.md, the W11c row): `ignore-released` (the store
    /// never drops a hash that left H), `evict-carried` (a carried record is dropped on arrival,
    /// so the next apply needs a hash still in C: `inline-fetch-zero` at the fetcher),
    /// `stale-dynamic-rx` (a dynamic body is ignored when its surface's shape holds) and `no-prune`
    /// (the validator keeps C lifelong: a returning hash is `resource-duplicate`).
    ignore_released: bool,
    evict_carried: bool,
    stale_dynamic_rx: bool,
    no_prune: bool,
    /// GRH `rebuild-reupload`: `live_rebuild` leaves the fresh applier's residency empty.
    rebuild_reupload: bool,
    /// PM6a's receiver sabotage `ignore-particle-emits` on GSW: every wire emit is dropped
    /// (counted `emits_dropped`) instead of consumed.
    ignore_particle_emits: bool,
    /// PFB's receiver sabotage `gl-particle-colors`: the emitters read the wire's colours, as
    /// GSW did before PFB, whatever the host's rendering method.
    gl_particle_colors: bool,
    /// PSE's receiver sabotage `shared-process-key` (GSW-only): every material on a process shader
    /// takes the shader's builtin key (the first material's), as GSW did before PSE, even when
    /// the shader switches the key's fields by uniforms.
    shared_process_key: bool,
    /// W13c: the /13 decoder sabotage `no-predict-reset` (render-stream-13.md "As built (W13a)",
    /// "Sabotages"): a full does not reset the prediction history, so the first full after units
    /// exist fails `predict-check` (rs-core `Options::no_predict_reset`).
    no_predict_reset: bool,
}

/// G8kb: every `uastc` variant hash of the state's textures (the KTX2 payloads).
fn uastc_hashes(st: &render_stream_core::state::ResolvedState) -> HashSet<Hash> {
    st.textures
        .values()
        .flat_map(|t| t.variants.iter())
        .filter(|v| v.encoding == VariantEncoding::Uastc)
        .map(|v| v.hash)
        .collect()
}

/// A flat string value `"key":"value"` of the caller-written options object (no escapes).
fn find_str(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let start = json.find(&needle)? + needle.len();
    let rest = &json[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// `RS_RECEIVER_SABOTAGE` values the TypeScript shell, not this module, acts on, or that have no
/// effect on a file-mode GSW receiver (gate7-design.md Q5; each is typed in the leg's evidence).
/// G7k: `no-evict` moved out of this list (parsed below, into `Opts.no_evict`); `leak-gl-textures`
/// stays here, since it leaks real GL objects by wrapping the canvas's WebGL2 context in
/// `live.ts`, not by changing anything this module uploads or deletes.
const SHELL_SABOTAGES: &[&str] = &[
    "css-opacity",
    "ack-on-receipt",
    // G7u: acks `submitted` from onmessage while the page is suspended (live.ts).
    "ack-while-hidden",
    "ack-while-hidden",
    "leak-gl-textures",
    "ignore-cache",
    "wrong-http-token",
    // G7o2: the page corrupts a fetched payload byte / provides in the frame (bench-rs.ts).
    "corrupt-payload",
    "verify-in-frame",
];

/// A bare `"key":123` (or `"key":123,`/`"key":123}`) numeric field, in the ad hoc scan
/// `parse_options` already uses for this flat, caller-written JSON object. `None` when the key is
/// absent or its value is not a non-negative integer.
fn find_number(json: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\":");
    let start = json.find(&needle)? + needle.len();
    let rest = &json[start..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    rest[..end].parse().ok()
}

fn parse_options(json: &str) -> Result<Opts, String> {
    // A flat, caller-written object: {"digest":"inline"|"deferred","sabotage":[...],"format":...}.
    let mut o = Opts {
        digest_inline: json.contains("\"digest\":\"inline\""),
        ..Opts::default()
    };
    // G7t: draw the target in Godot's orientation and screen transform, so pixel-centre ties
    // break as the engine's (gate 4's hex box, gate 6's LineEdit).
    o.exec.godot_orientation = true;
    o.format_rgba8 = json.contains("\"format\":\"rgba8\"");
    // G7k (Q10 soak), live mode only; a file-mode caller never sends this key.
    o.memory_budget_bytes = find_number(json, "memory_budget_bytes");
    // G8kp: the delivery preference, checked against render-stream-9.md's grammar and names.
    o.texture_encodings = find_str(json, "texture_encodings").filter(|t| !t.is_empty());
    if let Some(enc) = &o.texture_encodings {
        render_stream_core::delivery::DeliveryPrefs::parse(enc, "none")
            .map_err(|e| format!("RS_RECEIVER_TEXTURE_ENCODINGS: {e}"))?;
    }
    if let Some(mask) = find_str(json, "gpu_format_mask").filter(|t| !t.is_empty()) {
        render_stream_core::delivery::DeliveryPrefs::parse("decoded", &mask)
            .map_err(|e| format!("RS_RECEIVER_GPU_FORMAT_MASK: {e}"))?;
        o.gpu_format_mask = mask.split(',').map(str::to_string).collect();
    }
    o.summary_log = json.contains("\"log\":\"summary\"");
    o.live_protocol = if json.contains("\"live_protocol\":13") {
        13
    } else if json.contains("\"live_protocol\":12") {
        12
    } else if json.contains("\"live_protocol\":11") {
        11
    } else if json.contains("\"live_protocol\":10") {
        10
    } else if json.contains("\"live_protocol\":9") {
        9
    } else {
        0
    };
    o.transcoder = json.contains("\"transcoder\":true");
    o.variant_policy = match find_str(json, "variant_policy").as_deref() {
        None | Some("") => None,
        Some("keep") => Some(false),
        Some("upgrade") => Some(true),
        Some(other) => {
            return Err(format!(
                "RS_RECEIVER_VARIANT_POLICY: {other:?} (expected keep or upgrade)"
            ))
        }
    };
    if let Some(start) = json.find("\"sabotage\":[") {
        let rest = &json[start + 12..];
        let end = rest.find(']').unwrap_or(rest.len());
        for name in rest[..end]
            .split(',')
            .map(|s| s.trim().trim_matches('"'))
            .filter(|s| !s.is_empty())
        {
            match name {
                "skip-payload-hash" => o.skip_payload_hash = true,
                "digest-skip" => o.digest_skip = true,
                "ignore-clip" => o.apply.ignore_clip = true,
                "clip-before-clear" => o.apply.clip_before_clear = true,
                "reupload" => o.apply.reupload = true,
                "stale-texture" => o.apply.stale_texture = true,
                "ignore-material" => o.apply.ignore_material = true,
                "ignore-canvas-modulate" => o.apply.ignore_canvas_modulate = true,
                "ignore-canvas-stacking" => o.apply.ignore_canvas_stacking = true,
                "ignore-z" => o.apply.ignore_z = true,
                "stale-param" => o.apply.stale_param = true,
                "blend-swap" => o.apply.blend_swap = true,
                "screen-copy-per-reader" => o.apply.screen_copy_per_reader = true,
                "shader-time-frozen" => o.apply.shader_time_frozen = true,
                "drop-canvas-group" => o.apply.drop_canvas_group = true,
                "full-backbuffer-copy" => o.apply.full_backbuffer_copy = true,
                "drop-msdf" => o.apply.lower.drop_msdf = true,
                "ignore-set-transform" => o.apply.lower.ignore_set_transform = true,
                "ignore-clip-ignore" => o.apply.lower.ignore_clip_ignore = true,
                "ignore-nine-patch-axis" => o.apply.lower.ignore_nine_patch_axis = true,
                "polygon-winding" => o.apply.lower.polygon_winding = true,
                "msdf-px-range" => o.apply.lower.msdf_px_range = true,
                // PM3: every add_multimesh skipped and counted, as GSW drew before PM3.
                "undrawn-multimesh" => o.apply.lower.undrawn_multimesh = true,
                // PM6b: PM6a's names. `undrawn-particles` is the pre-PM6 executor (every
                // add_particles counted particles-undrawn); `ignore-particle-emits` drops emits.
                "undrawn-particles" => o.apply.lower.undrawn_particles = true,
                "ignore-particle-emits" => o.ignore_particle_emits = true,
                // PFB: the emitters read the wire's colours whatever the host's rendering method.
                "gl-particle-colors" => o.gl_particle_colors = true,
                // PSE, GSW-only: every material on a process shader keyed by the shader's builtin.
                "shared-process-key" => o.shared_process_key = true,
                // PM3, GSW-only: a particles_animation CanvasItemMaterial drawn as its builtin.
                "no-flipbook" => o.apply.no_flipbook = true,
                // UIT: every /11 use_identity_transform ignored, as every receiver drew before UIT.
                "ignore-identity-transform" => o.apply.ignore_identity_transform = true,
                "no-evict" => o.no_evict = true,
                "drop-mesh-surface" => o.apply.mesh.drop_surface = true,
                "stale-mesh" => o.apply.mesh.stale = true,
                "ignore-presentation" => o.ignore_presentation = true,
                "ignore-format-mask" => o.ignore_format_mask = true,
                "vertex-flat-varyings" => o.vertex_flat_varyings = true,
                "ignore-released" => o.ignore_released = true,
                "evict-carried" => o.evict_carried = true,
                "stale-dynamic-rx" => o.stale_dynamic_rx = true,
                "no-prune" => o.no_prune = true,
                // W13c: a /13 full un-predicted against the history (no reset).
                "no-predict-reset" => o.no_predict_reset = true,
                // GRH: a coding resync's fresh applier does not inherit the resident textures, so
                // its full transaction uploads every texture again (the pre-GRH behaviour).
                "rebuild-reupload" => o.rebuild_reupload = true,
                // GLJ: every texture upload copied into the draw list's byte arena (pre-GLJ), so
                // a viewer's first apply holds a second copy of the whole texture set at once.
                "arena-upload" => o.apply.arena_upload = true,
                shell if SHELL_SABOTAGES.contains(&shell) => {}
                other => {
                    if let Some(s) = Sabotage::parse(other)? {
                        o.exec.sabotage = Some(s);
                    }
                }
            }
        }
    }
    Ok(o)
}

/// G8kp: the delivery preference a receiver states (`delivery_json`).
#[derive(Default)]
struct DeliveryReport {
    texture_encodings: String,
    gpu_formats: String,
    gpu_formats_detected: String,
    gpu_format_mask: String,
    /// G8kb (D6): `keep` or `upgrade`, and whether the receiver's default chose it.
    variant_policy: &'static str,
    variant_policy_default: bool,
}

#[derive(Default)]
struct Totals {
    transactions: u64,
    structural: u64,
    relowered: u64,
    relowered_in_place: u64,
    draw_calls: u64,
    parity_violations: u64,
    texture_uploads: u64,
    provided: u64,
    provided_bytes: u64,
    restores: u64,
    /// G7k: `PayloadStore` entries [`PayloadStore::evict_unreferenced`] has freed, summed over
    /// every transaction applied (live mode, a budget set, `no-evict` not sabotaging it).
    residency_evictions: u64,
}

/// W11c: the /11 store and dynamic-mesh evidence (`evidence_json`'s `w11`), over every applied
/// transaction of the session.
#[derive(Default)]
struct W11Totals {
    /// The most store entries held after an apply, and the most beyond |names(S_n)| + |C| (the
    /// display's lag; `store-bounded` wants it within the credit window's in-flight states).
    store_max_entries: u64,
    store_max_excess: i64,
    /// Full log only: dynamic surfaces checked after an apply, and those whose held body's
    /// SHA-256 differed from the resolved state's `body_sha256` (`dynamic-applied`).
    dynamic_checked: u64,
    dynamic_mismatched: u64,
    first_mismatch_seq: Option<i64>,
    /// Named dynamic meshes left undrawn (a body never ingested), summed over applies.
    dynamic_undrawn: u64,
}

/// G7o2 `payload-verified-before-use`: how each payload a transaction used reached the store.
#[derive(Default)]
struct VerifyCounts {
    /// Staged by `stage_payload` (SHA-256 matched, decoded) / refused there.
    staged: u64,
    refused: u64,
    /// Provided from the stage (verified when it arrived, off the frame path).
    provided_staged: u64,
    /// Provided by `provide` (verified inside the frame, the pre-G7o2 path).
    provided_in_frame: u64,
    /// Provided without a SHA-256 check (the `skip-payload-hash` sabotage only).
    unverified_used: u64,
}

/// Q14d "Goldens" under the wasm build: `rs-core-check goldens`'s very function, run in this module
/// (Node or a browser). `read(path)` returns a golden file's bytes (`golden-6/full.rs6`, …) or
/// undefined; `only` 0 runs golden-2 to golden-6, else that one directory. Returns one JSON object
/// per check, one per line.
#[wasm_bindgen]
pub fn run_goldens(read: &js_sys::Function, only: u32, skip_payload_hash: bool) -> String {
    use render_stream_core::goldens::{run_all, GoldenOptions};
    let reader = |path: &str| -> Option<Vec<u8>> {
        let v = read.call1(&JsValue::NULL, &JsValue::from_str(path)).ok()?;
        if v.is_undefined() || v.is_null() {
            return None;
        }
        Some(js_sys::Uint8Array::new(&v).to_vec())
    };
    let opts = GoldenOptions {
        verify_payload_hashes: !skip_payload_hash,
        ..GoldenOptions::default()
    };
    let only = if only == 0 { None } else { Some(only as u8) };
    let esc = |s: &str| {
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    };
    run_all(&reader, only, opts)
        .iter()
        .map(|c| {
            format!(
                "{{\"name\":\"{}\",\"ok\":{},\"detail\":\"{}\"}}",
                esc(&c.name),
                c.ok,
                esc(&c.detail)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

/// Diagnostics (never on the frame path): accept every record of `data` in this module, timing
/// each `Validator::accept` with `performance.now()` (µs per record, session excluded), with no GL,
/// so the wasm core can be timed in Node or a page without the renderer.
#[wasm_bindgen]
pub fn core_bench(data: &[u8], digest_inline: bool) -> Result<Vec<f64>, JsValue> {
    let err = |e: wire::Error| JsValue::from_str(&e.to_string());
    let version = wire::version_of_magic(data).ok_or_else(|| JsValue::from_str("bad-magic"))?;
    let spans = wire::split_records(data, version).map_err(err)?;
    let opts = Options {
        version,
        digest: if digest_inline {
            DigestPolicy::Inline
        } else {
            DigestPolicy::Deferred
        },
        verify_payload_hashes: true,
        early_prune: false,
        no_predict_reset: false,
    };
    let mut v = Validator::new(spans[0].bytes(data), spans[0].offset, opts).map_err(err)?;
    let mut out = Vec::with_capacity(spans.len());
    for span in &spans[1..] {
        let t = performance_now();
        v.accept(span.bytes(data), span.offset).map_err(err)?;
        out.push((performance_now() - t) * 1000.0);
    }
    Ok(out)
}

fn performance_now_us() -> f64 {
    performance_now() * 1000.0
}

/// G7o2 diagnostics: turn the core's phase timers (`render_stream_core::prof`) on or off, on
/// `performance.now()`. Off (the default) they cost one thread-local read per mark.
#[wasm_bindgen]
pub fn prof_enable(on: bool) {
    prof::set_clock(on.then_some(performance_now_us as fn() -> f64));
}

/// G7o2: the phase times (µs, `prof_names()` order) accumulated since the last call, zeroed.
#[wasm_bindgen]
pub fn prof_take() -> Vec<f64> {
    prof::take().to_vec()
}

#[wasm_bindgen]
pub fn prof_names() -> String {
    prof::NAMES.join(",")
}

/// G7o2 diagnostics (never on the frame path): `rs-core-check profile` in this module, with no GL:
/// `repeats` replays of `data` (`read(hash_hex)` returns a payload's bytes, or undefined), one
/// JSON line per transaction with each timer's minimum over the replays.
#[wasm_bindgen]
pub fn core_profile(
    data: &[u8],
    read: &js_sys::Function,
    inline_digest: bool,
    repeats: u32,
) -> Result<String, JsValue> {
    let was = prof::enabled();
    prof_enable(true);
    let mut cache: std::collections::HashMap<Hash, Option<Vec<u8>>> = Default::default();
    let mut get = |h: &Hash| -> Option<Vec<u8>> {
        cache
            .entry(*h)
            .or_insert_with(|| {
                let v = read
                    .call1(&JsValue::NULL, &JsValue::from_str(&h.to_hex()))
                    .ok()?;
                if v.is_undefined() || v.is_null() {
                    return None;
                }
                Some(js_sys::Uint8Array::new(&v).to_vec())
            })
            .clone()
    };
    let mut runs = Vec::new();
    for _ in 0..repeats.max(1) {
        match prof::replay(data, inline_digest, &mut get) {
            Ok(r) => runs.push(r),
            Err(e) => {
                prof_enable(was);
                return Err(JsValue::from_str(&e.to_string()));
            }
        }
    }
    prof_enable(was);
    Ok(prof::min_over(runs)
        .iter()
        .map(|r| r.to_json().to_string())
        .collect::<Vec<_>>()
        .join("\n"))
}

#[wasm_bindgen]
pub struct GswRs {
    canvas: web_sys::HtmlCanvasElement,
    opts: Opts,
    data: Vec<u8>,
    version: u8,
    spans: Vec<RecordSpan>,
    validator: Option<Validator>,
    applier: Option<Applier>,
    executor: Option<CanvasItemsExecutor>,
    /// G8kp: what this receiver states and selects with (`delivery_json`), set at `start`.
    delivery: DeliveryReport,
    payloads: PayloadStore,
    /// W11c: the /11 retention rule over `payloads` (H = names(S_d) ∪ C ∪ names(S_n)).
    retention: Retention,
    w11: W11Totals,
    /// W11c: a summary log's running dispose counters (`created`, `freed_by_apply`) per stream,
    /// in place of the per-transaction evidence it does not keep.
    summary_dispose: (u32, u64, u64),
    /// G7o2: payloads verified and decoded when they arrived, not yet provided.
    stage: PayloadStage,
    verify: VerifyCounts,
    /// G8kb: KTX2 payloads `stage_ktx2` verified (hash and shape) and handed to the shell's
    /// transcoder worker: (width, height, mipmaps, KTX2 bytes, hash-checked). Only these may be
    /// staged by `stage_transcoded`.
    ktx2_verified: HashMap<Hash, (u32, u32, bool, usize, bool)>,
    needed: Vec<Hash>,
    needed_bytes: Vec<u8>,
    provide_cursor: usize,
    payload_buf: Vec<u8>,
    first_tx: bool,
    /// Record index of each accepted record, session first (the validator's digest order).
    accepted: Vec<usize>,
    digested: usize,
    stats: Stats,
    last_exec: ExecStats,
    totals: Totals,
    /// G8g: the float payload formats (render-stream/8, D9) this receiver took as RGBA8 through
    /// rs-core's `texture_rgba8` quantization (GSW samples no float texture): the
    /// `float-texture-quantized` caveat of its evidence (render-stream-8.md "As built (G8f)").
    quantized_float: std::collections::BTreeSet<String>,
    shot_buf: Vec<u8>,
    error: String,
    /// Kind per needed hash (0 texture GRT1, 1 mesh GRM1, 2 shader GRP1), parallel to `needed`.
    needed_kinds: Vec<u8>,
    /// The accepted-record index of the last accepted transaction (its digest slot).
    last_tx_record: usize,
    /// applied.json evidence, accumulated per applied transaction and serialized off the frame
    /// path (`applied_json_parts`).
    evidence: Vec<TxEvidence>,
    unsupported_out: Vec<UnsupportedOut>,
    prev_unsupported: HashSet<(Box<str>, Option<Id>, &'static str)>,
    /// Receiver-typed reasons already reported (each once, at its first transaction).
    typed_seen: HashSet<&'static str>,
    /// G7s: the custom shaders the accepted transaction names that have no program yet.
    pending: Vec<(Id, Hash, ShaderSource)>,
    /// The next executor program id (one per transpiled shader code hash).
    next_program: u32,
    /// `shader-param-parity` evidence: every binding's values whenever they changed.
    param_log: Vec<ParamLogEntry>,
    /// G7l live mode: the wasm-owned receive buffer one WebSocket message is copied into (Q14c
    /// step 1), the bytes this connection has received so far (a record's offset in the
    /// connection's `received.rs7`), and the last accepted record's digest.
    rx: Vec<u8>,
    rx_offset: usize,
    live: bool,
    /// W13c: a /13 transaction failed `predict-check` on this connection; until its full
    /// transaction arrives every patch is dropped unaccepted (`ACCEPT_HELD`): it is predicted from
    /// the failed transaction, which this receiver's history never took.
    predict_await_full: bool,
    /// W13c: `predict-check` failures and the patches dropped while awaiting their fulls.
    predict_failures: u32,
    predict_dropped: u32,
    stream_index: u32,
    last_digest: [u8; 32],
    /// The session viewport, kept so a resync can rebuild the applier (`live_rebuild`).
    viewport: Option<Viewport>,
    /// G7g: the window `set_window` named (else the session's presentation size).
    window: Option<[u32; 2]>,
    /// G7g: the adopted presentation (`presentation_json`).
    presentation: Presentation,
    /// G7u: whether the last `draw` re-sent everything to a restored context.
    last_restore_draw: bool,
    /// GLJ: the texture bytes the last `draw` uploaded from the draw list's byte arena (copied
    /// there by `apply`) and from shared payloads (no copy), for `last_upload_bytes_json`.
    last_upload_bytes: (u64, u64),
}

/// G7g: the session's presentation as this receiver adopted it (receiver.gd
/// `_adopt_presentation`, protocol/gate6-design.md Q5).
#[derive(Clone, Debug, Default, PartialEq)]
struct Presentation {
    window: [u32; 2],
    /// The render target (the canvas backing store): the window, as natively.
    target: [u32; 2],
    oversampling: f64,
    stretch_applied: bool,
    /// The session declares a presentation size (/6 and later): the check runs.
    declares: bool,
    /// Receiver-typed session entries: `presentation-mismatch` (the window is not the session's
    /// presentation size), `oversampling-mismatch` (the stretch's scale is not the declared
    /// `font_oversampling`).
    typed: Vec<&'static str>,
}

/// Godot 4.5.1's `canvas_items` stretch of a `logical` content size into a `window`
/// (`Window::_update_viewport_size`, scene/main/window.cpp:1190-1307): the aspect rule picks the
/// viewport (`size_2d_override`) and screen sizes, both floored; `integer` scales by a whole
/// factor; the margin centres the screen rect. The canvas receives
/// `translate(margin) * scale(screen / viewport)` (Viewport's stretch transform, attached at the
/// margin), and the root's oversampling is the smaller scale.
fn canvas_items_stretch(stretch: &Stretch, logical: [i64; 2], window: [u32; 2]) -> (Xform, f64) {
    let (vw, vh) = (window[0] as f32, window[1] as f32);
    let (dw, dh) = (logical[0] as f32, logical[1] as f32);
    let viewport_aspect = dw / dh;
    let video_aspect = vw / vh;
    let approx = (viewport_aspect - video_aspect).abs()
        <= 0.00001_f32.max(viewport_aspect.abs().max(video_aspect.abs()) * 0.00001);
    let (mut viewport, mut screen);
    if stretch.aspect == "ignore" || approx {
        viewport = (dw, dh);
        screen = (vw, vh);
    } else if viewport_aspect < video_aspect {
        if stretch.aspect == "keep_height" || stretch.aspect == "expand" {
            viewport = (dh * video_aspect, dh);
            screen = (vw, vh);
        } else {
            viewport = (dw, dh);
            screen = (vh * viewport_aspect, vh);
        }
    } else if stretch.aspect == "keep_width" || stretch.aspect == "expand" {
        viewport = (dw, dw / video_aspect);
        screen = (vw, vh);
    } else {
        viewport = (dw, dh);
        screen = (vw, vw / viewport_aspect);
    }
    screen = (screen.0.floor(), screen.1.floor());
    viewport = (viewport.0.floor(), viewport.1.floor());
    if stretch.scale_mode == "integer" {
        let f = ((screen.0 / viewport.0).floor())
            .min((screen.1 / viewport.1).floor())
            .max(1.0);
        screen = (viewport.0 * f, viewport.1 * f);
    }
    let mut margin = (0.0_f32, 0.0_f32);
    if screen.0 < vw {
        margin.0 = ((vw - screen.0) / 2.0).round();
    }
    if screen.1 < vh {
        margin.1 = ((vh - screen.1) / 2.0).round();
    }
    let (sx, sy) = (screen.0 / viewport.0, screen.1 / viewport.1);
    ([sx, 0.0, 0.0, sy, margin.0, margin.1], sx.min(sy) as f64)
}

/// One binding's values as of transaction `seq` (they hold until its next entry).
struct ParamLogEntry {
    seq: i64,
    slot: u32,
    key: Option<BindingKey>,
    binding: Binding,
}

/// The receiver-typed `unsupported` reason of a GSW shortcut (gate7-design.md Q5, Q7, D22), or
/// `None` for one the wire already types (an unsupported op, texture, mesh or material, a tie) or
/// whose pixels Q7 already classes `undecided` (`slice-mipmaps-level0`: a mipmapped texture drawn
/// minified samples level 0; G7a measured max delta 1 against gate 2's reference, inside its mask;
/// `slice-hairline-as-quads`: GL lines and points as 1-px quads, which G7t measured inside gate
/// 5b's thin-line band with every decided pixel exact, so `gsw-hairline` is not typed).
pub fn typed_reason(shortcut: &str) -> Option<&'static str> {
    Some(match shortcut {
        "slice-shader-builtin" => "gsw-shader-builtin",
        "slice-aa-feather-omitted" => "gsw-aa-feather",
        "slice-ninepatch-tile-as-stretch" => "gsw-nine-patch-tile",
        "slice-mesh-primitive-skipped" => "gsw-mesh-primitive",
        "texture-not-resident-skipped" => "gsw-texture-not-resident",
        _ => return None,
    })
}

/// One applied transaction's applied.json facts (the TypeScript shell adds the fetch fields).
struct TxEvidence {
    /// G7l: the connection it arrived on (1 in file mode; 2 after a reconnect).
    stream: u32,
    seq: i64,
    frame: i64,
    encoding: &'static str,
    record: usize,
    created: u32,
    freed: u32,
    commands_replayed: u32,
    msdf_commands: u32,
    mesh_commands: u32,
    canvases_created: u32,
    canvas_attach: u32,
    canvas_stacking_sets: u32,
    tex: TextureAccount,
    /// The native receiver's /5 shader and material counters (G7s).
    mat: MaterialCounts,
    /// The transaction's `mesh_uploads` rows (G7t: native mesh residency).
    meshes: Vec<render_stream_core::apply::meshes::MeshUpload>,
    /// W11c, /11 full log: SHA-256 over every dynamic surface of the applied state, ascending by
    /// mesh id then surface, of (id u32 LE, surface u32 LE, the held body's SHA-256, or 32 zero bytes): what this
    /// receiver draws dynamic meshes from, comparable with the TypeScript resolved state's
    /// `body_sha256`s (`gsw-dynamic-applied`).
    dynamic_sha256: Option<Hash>,
}

/// One applied transaction's (created, freed) objects in the native receiver's RID terms
/// (`dispose_json`).
fn tx_dispose_counts(e: &TxEvidence) -> (u64, u64) {
    (
        u64::from(e.created)
            + u64::from(e.tex.created)
            + u64::from(e.mat.shaders_created)
            + u64::from(e.mat.materials_created)
            + e.meshes.iter().filter(|m| m.op == "create").count() as u64,
        u64::from(e.freed)
            + u64::from(e.tex.freed)
            + u64::from(e.mat.shaders_freed)
            + u64::from(e.mat.materials_freed)
            + e.meshes.iter().filter(|m| m.op == "free").count() as u64,
    )
}

/// An `unsupported[]` entry: emitted when its (op, item, reason) was not in the previous applied
/// transaction's set (`receiver.gd` `_note_applied`).
struct UnsupportedOut {
    seq: i64,
    item: Option<Id>,
    name: Box<str>,
    reason: &'static str,
    /// A shader refusal's shader id and (receiver-typed ones) why.
    shader: Option<Id>,
    detail: Option<Box<str>>,
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn fail(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[wasm_bindgen]
impl GswRs {
    #[wasm_bindgen(constructor)]
    pub fn new(canvas: web_sys::HtmlCanvasElement, options: &str) -> Result<GswRs, JsValue> {
        let opts = parse_options(options).map_err(|e| JsValue::from_str(&e))?;
        Ok(GswRs {
            canvas,
            opts,
            data: Vec::new(),
            version: 6,
            spans: Vec::new(),
            validator: None,
            applier: None,
            executor: None,
            delivery: DeliveryReport::default(),
            payloads: PayloadStore::default(),
            retention: Retention::default(),
            w11: W11Totals::default(),
            summary_dispose: (0, 0, 0),
            stage: PayloadStage::default(),
            verify: VerifyCounts::default(),
            ktx2_verified: HashMap::new(),
            needed: Vec::new(),
            needed_bytes: Vec::new(),
            provide_cursor: 0,
            payload_buf: Vec::new(),
            first_tx: true,
            accepted: Vec::new(),
            digested: 0,
            stats: Stats::default(),
            last_exec: ExecStats::default(),
            totals: Totals::default(),
            quantized_float: std::collections::BTreeSet::new(),
            shot_buf: Vec::new(),
            error: String::new(),
            needed_kinds: Vec::new(),
            last_tx_record: 0,
            evidence: Vec::new(),
            unsupported_out: Vec::new(),
            prev_unsupported: HashSet::new(),
            typed_seen: HashSet::new(),
            pending: Vec::new(),
            next_program: 1,
            param_log: Vec::new(),
            rx: Vec::new(),
            rx_offset: 0,
            live: false,
            predict_await_full: false,
            predict_failures: 0,
            predict_dropped: 0,
            stream_index: 1,
            last_digest: [0; 32],
            viewport: None,
            window: None,
            presentation: Presentation::default(),
            last_restore_draw: false,
            last_upload_bytes: (0, 0),
        })
    }

    /// G7g: the window this receiver presents into (receiver.gd's root window: the native leg's
    /// `--resolution`), set before `start`. Unset, the window is the session's presentation size.
    pub fn set_window(&mut self, width: u32, height: u32) {
        self.window = Some([width.max(1), height.max(1)]);
    }

    /// G7g: how the session's presentation was adopted (receiver.gd `_adopt_presentation`):
    /// `{"window":[w,h],"target":[w,h],"oversampling":x,"stretch_applied":b,
    /// "presentation_check":"ok"|"mismatch","typed":[reason...]}`; empty before `start`.
    pub fn presentation_json(&self) -> String {
        let p = &self.presentation;
        if p.target == [0, 0] {
            return String::new();
        }
        let typed: Vec<String> = p.typed.iter().map(|r| format!("\"{r}\"")).collect();
        format!(
            "{{\"window\":[{},{}],\"target\":[{},{}],\"oversampling\":{},\"stretch_applied\":{},\"presentation_check\":{},\"typed\":[{}]}}",
            p.window[0],
            p.window[1],
            p.target[0],
            p.target[1],
            p.oversampling,
            p.stretch_applied,
            if !p.declares {
                "null"
            } else if p.typed.is_empty() {
                "\"ok\""
            } else {
                "\"mismatch\""
            },
            typed.join(",")
        )
    }

    // ------------------------------------------------------------------ G7s: shader programs

    /// After `accept` (and every `provide`): the custom shaders the transaction's named materials
    /// name that have no program yet (`Applier::pending_shaders`). Each must be answered with
    /// `define_program` or `refuse_program` before `apply`. Returns their count.
    pub fn pending_shaders(&mut self) -> u32 {
        self.pending = match (self.validator.as_ref(), self.applier.as_ref()) {
            (Some(v), Some(a)) => a.pending_shaders(v.state()),
            _ => Vec::new(),
        };
        self.pending.len() as u32
    }

    pub fn pending_hash(&self, i: u32) -> String {
        self.pending
            .get(i as usize)
            .map(|p| p.1.to_hex())
            .unwrap_or_default()
    }

    pub fn pending_shader_id(&self, i: u32) -> i64 {
        self.pending
            .get(i as usize)
            .map(|p| i64::from(p.0))
            .unwrap_or(-1)
    }

    /// Whether pending shader `i`'s code is `withheld` (it comes from the operator's library).
    pub fn pending_withheld(&self, i: u32) -> bool {
        self.pending
            .get(i as usize)
            .is_some_and(|p| p.2 == ShaderSource::Withheld)
    }

    /// Pending shader `i`'s code, once it is held (a payload's, or a library's after
    /// `provide_library`): crosses the boundary once per shader code hash (Q14c).
    pub fn pending_code(&self, i: u32) -> Option<String> {
        let (_, hash, _) = self.pending.get(i as usize)?;
        let code = self.payloads.shaders.get(hash)?;
        Some(if self.opts.vertex_flat_varyings {
            render_stream_core::apply::programs::flat_varyings(code)
        } else {
            code.clone()
        })
    }

    /// A `withheld` shader's GRP1 from the operator's library, written by the caller at
    /// `alloc_payload`: verified against pending shader `i`'s hash (its name in the library) and
    /// decoded, as `RsResourceCache.library_code()` does. A library read is never a fetch.
    pub fn provide_library(&mut self, i: u32, len: usize) -> i32 {
        let Some((_, hash, _)) = self.pending.get(i as usize).copied() else {
            self.error = format!("provide_library: no pending shader {i}");
            return -1;
        };
        match self
            .payloads
            .provide(&self.payload_buf[..len], &hash, self.version, true)
        {
            Ok(()) => 0,
            Err(e) => {
                self.error = fail(e);
                -1
            }
        }
    }

    /// Pending shader `i` transpiled: compile `glsl` (the effects transpiler's item-space module)
    /// in the executor and register it with its metadata (the transpiler's result without
    /// `glsl` and `vertexGlsl`, JSON). `vertex_glsl` is the transpiler's `vertexGlsl` (P3-VX), or
    /// empty for a program on the plain vertex stage. Returns 0 when registered, 1 when GL refused
    /// it (registered as the typed refusal `gsw-shader-transpile` with the compile log), -1 on a
    /// usage error.
    pub fn define_program(&mut self, i: u32, glsl: &str, meta: &str, vertex_glsl: &str) -> i32 {
        let Some((_, hash, _)) = self.pending.get(i as usize).copied() else {
            self.error = format!("define_program: no pending shader {i}");
            return -1;
        };
        let (Some(a), Some(x)) = (self.applier.as_mut(), self.executor.as_mut()) else {
            self.error = "define_program before start".into();
            return -1;
        };
        let id = self.next_program;
        let info = match ProgramInfo::from_meta_json(id, meta) {
            Ok(info) => info,
            Err(e) => {
                self.error = e;
                return -1;
            }
        };
        let vertex = (!vertex_glsl.is_empty()).then_some(vertex_glsl);
        match x.define_program_with_vertex(id, glsl, vertex) {
            Ok(()) => {
                self.next_program += 1;
                a.set_program(hash, ProgramEntry::Ready(info));
                0
            }
            Err(log) => {
                a.set_program(
                    hash,
                    ProgramEntry::Refused {
                        reason: "gsw-shader-transpile",
                        detail: format!("compile: {log}").into(),
                    },
                );
                1
            }
        }
    }

    /// Pending shader `i` is not drawn with its code: `reason` `gsw-shader-transpile` (the
    /// transpiler refused it; `detail` is its message) or `shader-withheld` (no library code).
    pub fn refuse_program(&mut self, i: u32, reason: &str, detail: &str) -> i32 {
        let Some((_, hash, _)) = self.pending.get(i as usize).copied() else {
            self.error = format!("refuse_program: no pending shader {i}");
            return -1;
        };
        let reason: &'static str = match reason {
            "gsw-shader-transpile" => "gsw-shader-transpile",
            "shader-withheld" => "shader-withheld",
            other => {
                self.error = format!("refuse_program: unknown reason {other:?}");
                return -1;
            }
        };
        let Some(a) = self.applier.as_mut() else {
            self.error = "refuse_program before start".into();
            return -1;
        };
        a.set_program(
            hash,
            ProgramEntry::Refused {
                reason,
                detail: detail.into(),
            },
        );
        0
    }

    /// Step 1, file mode: reserve `len` bytes for the recording; the caller writes them through a
    /// view of the returned pointer.
    pub fn alloc_recording(&mut self, len: usize) -> *mut u8 {
        self.data = vec![0; len];
        self.data.as_mut_ptr()
    }

    /// Frame the loaded recording: the record count, or -1 (see `error`).
    pub fn load(&mut self, len: usize) -> i32 {
        self.data.truncate(len);
        let Some(version) = wire::version_of_magic(&self.data) else {
            self.error = "bad-magic: not a render-stream/2..11 recording".into();
            return -1;
        };
        self.version = version;
        match wire::split_records(&self.data, version) {
            Ok(spans) => {
                self.spans = spans;
                self.spans.len() as i32
            }
            Err(e) => {
                self.error = fail(e);
                -1
            }
        }
    }

    /// Drop the session (state, payloads, list) and keep the GL context: a new repeat.
    pub fn reset(&mut self) -> i32 {
        self.validator = None;
        self.applier = None;
        self.payloads.clear();
        self.retention.clear();
        self.w11 = W11Totals::default();
        self.summary_dispose = (0, 0, 0);
        self.stage.clear();
        self.verify = VerifyCounts::default();
        self.needed.clear();
        self.accepted.clear();
        self.digested = 0;
        self.first_tx = true;
        self.totals = Totals::default();
        self.stats = Stats::default();
        self.evidence.clear();
        self.unsupported_out.clear();
        self.prev_unsupported.clear();
        self.typed_seen.clear();
        self.pending.clear();
        self.param_log.clear();
        0
    }

    /// Accept the session record and size the target (and canvas) from its viewport.
    pub fn start(&mut self) -> i32 {
        match self.start_inner() {
            Ok(()) => 0,
            Err(e) => {
                self.error = e;
                -1
            }
        }
    }

    fn start_inner(&mut self) -> Result<(), String> {
        let span = *self.spans.first().ok_or("missing-session: no records")?;
        let opts = Options {
            version: self.version,
            // Live mode digests inline: a message is not kept after `live_accept`, and D31's
            // deferred digest needs the bytes, which only file mode holds.
            digest: if self.opts.digest_inline || self.live {
                DigestPolicy::Inline
            } else {
                DigestPolicy::Deferred
            },
            verify_payload_hashes: !self.opts.skip_payload_hash,
            early_prune: false,
            no_predict_reset: self.opts.no_predict_reset,
        };
        let mut v = Validator::new(span.bytes(&self.data), span.offset, opts).map_err(fail)?;
        v.set_no_prune(self.opts.no_prune);
        let s = v.session();
        let vp = &s.viewport;
        let size = vp.presentation_size.unwrap_or(vp.logical_size);
        let pres = [size[0].max(1) as u32, size[1].max(1) as u32];
        // G7g (receiver.gd `_adopt_presentation`): the receiver draws into its window. In the
        // session's own presentation it adopts the host's final transform bit for bit; in another
        // window (the presentation hazard) it computes the engine's canvas_items stretch for that
        // window; `ignore-presentation` keeps stretch disabled whatever the session says.
        let window = self.window.unwrap_or(pres);
        let canvas_items = vp.stretch.mode == "canvas_items" && !self.opts.ignore_presentation;
        let (global, oversampling) = if !canvas_items {
            (geom::IDENTITY, 1.0)
        } else if window == pres {
            let o = canvas_items_stretch(&vp.stretch, vp.logical_size, window).1;
            if size == vp.logical_size {
                (geom::IDENTITY, o)
            } else {
                (s.host_final_xform, o)
            }
        } else {
            canvas_items_stretch(&vp.stretch, vp.logical_size, window)
        };
        let mut typed = Vec::new();
        // receiver.gd checks only a session that declares its presentation (/6 and later).
        let declares = vp.presentation_size.is_some();
        if declares && window != pres {
            typed.push("presentation-mismatch");
        }
        // Compared as float32, the wire's own precision (receiver.gd).
        if declares
            && vp
                .font_oversampling
            .is_some_and(|declared| declared as f32 != oversampling as f32)
        {
            typed.push("oversampling-mismatch");
        }
        self.presentation = Presentation {
            window,
            target: window,
            oversampling,
            stretch_applied: canvas_items,
            declares,
            typed,
        };
        let viewport = Viewport {
            width: window[0],
            height: window[1],
            clear: s.clear_color,
            global_xform: global,
            cull_mask: vp.canvas_cull_mask as u32,
            format: if self.opts.format_rgba8 {
                Format::Rgba8
            } else {
                Format::Rgb10A2
            },
        };
        self.canvas.set_width(viewport.width);
        self.canvas.set_height(viewport.height);
        if self.executor.is_none() {
            self.executor = Some(CanvasItemsExecutor::new(
                self.canvas.clone(),
                self.opts.exec,
            )?);
        }
        let mut applier = Applier::new(viewport);
        applier.sabotage = self.opts.apply;
        // PM3: GLES3 stores multimesh colours and custom data as half floats.
        applier.half_instances = s.engine.rendering_method == "gl_compatibility";
        // G8kp (texture-delivery-design.md D3, Q3): gpu_formats from this context's extensions,
        // minus the mask; the selection uses the stated list unless `ignore-format-mask`.
        let detected = self
            .executor
            .as_ref()
            .map(|e| e.gpu_families())
            .unwrap_or_default();
        let list = |fams: &[&str]| {
            if fams.is_empty() {
                "none".to_string()
            } else {
                fams.join(",")
            }
        };
        let stated: Vec<&str> = detected
            .iter()
            .copied()
            .filter(|f| !self.opts.gpu_format_mask.iter().any(|m| m == f))
            .collect();
        // G8kb: with the transcoder worker the default lists uastc (D3: after block, before
        // decoded); without it GSW never states an encoding it cannot transcode (Q3).
        let encodings = self.opts.texture_encodings.clone().unwrap_or_else(|| {
            if self.opts.transcoder {
                "block,uastc,decoded".to_string()
            } else {
                "block,decoded".to_string()
            }
        });
        let selection = if self.opts.ignore_format_mask {
            list(&detected)
        } else {
            list(&stated)
        };
        applier.delivery =
            render_stream_core::delivery::DeliveryPrefs::parse(&encodings, &selection)?;
        // G8kb (D6): `upgrade` is the phone default (texture-delivery-design.md D6): a context
        // with neither BC family holds `decoded` at 4 B/px until a uastc variant appears, and
        // upgrading to its ASTC/ETC2 transcode trades one refetch for a quarter of the GPU memory.
        // Desktop contexts keep (a block variant, or the decoded copy, is already resident).
        let phone_class = !stated.iter().any(|f| *f == "bptc" || *f == "s3tc");
        applier.delivery.upgrade = self.opts.variant_policy.unwrap_or(phone_class);
        // G8kwh: WebGL's BC alignment rule. A BC `block` variant of a texture whose level 0 is not
        // 4-aligned is never chosen; GSW's transcoder applies the rule to its own target (G8kb's
        // webglFamilies), so such a texture's uastc variant stays.
        applier.delivery.bc_aligned_only = true;
        applier.delivery.transcoder_aligns = true;
        applier.stream_version = self.version;
        self.delivery = DeliveryReport {
            texture_encodings: encodings,
            gpu_formats: list(&stated),
            gpu_formats_detected: list(&detected),
            gpu_format_mask: self.opts.gpu_format_mask.join(","),
            variant_policy: if applier.delivery.upgrade { "upgrade" } else { "keep" },
            variant_policy_default: self.opts.variant_policy.is_none(),
        };
        self.applier = Some(applier);
        self.viewport = Some(viewport);
        self.stats.stream = self.stream_index;
        self.validator = Some(v);
        self.accepted.push(0);
        self.stats.accepted_records = 1;
        Ok(())
    }

    /// Step 2: decode, validate and resolve record `index`. Returns `ACCEPT_*`, or -1 (`error`).
    pub fn accept(&mut self, index: usize) -> i32 {
        let Some(span) = self.spans.get(index).copied() else {
            self.error = format!("no record {index}");
            return -1;
        };
        self.accept_bytes(
            false,
            span.offset,
            span.offset + span.byte_length,
            span.offset,
            index,
        )
    }

    /// Decode, validate and resolve one record held in `rx` (`live`) or `data` at `[a, b)`;
    /// `offset` is its place in the stream (messages only), `index` its record index.
    fn accept_bytes(&mut self, live: bool, a: usize, b: usize, offset: usize, index: usize) -> i32 {
        let Some(v) = self.validator.as_mut() else {
            self.error = "accept before start".into();
            return -1;
        };
        let bytes = if live {
            &self.rx[a..b]
        } else {
            &self.data[a..b]
        };
        let accepted = match v.accept(bytes, offset) {
            Ok(a) => a,
            Err(e) => {
                self.error = fail(e);
                return -1;
            }
        };
        if let Some(Some(d)) = v.record_digests().last() {
            self.last_digest = d.0;
        }
        self.accepted.push(index);
        self.stats.accepted_records = self.accepted.len() as u32;
        match accepted {
            Accepted::Resource { hash } => {
                // Inline delivery: the validator verified the payload against its hash. W11c's
                // `evict-carried` sabotage drops it on arrival (it is still in C).
                if let Some(bytes) = v.inline_payload(&hash).filter(|_| !self.opts.evict_carried) {
                    if let Err(e) = self.payloads.provide(bytes, &hash, self.version, false) {
                        self.error = fail(e);
                        return -1;
                    }
                    self.note_quantized(&hash);
                }
                ACCEPT_RESOURCE
            }
            Accepted::End => ACCEPT_END,
            Accepted::Transaction => {
                self.last_tx_record = self.accepted.len() - 1;
                let st = v.state();
                self.stats.seq = st.seq as u32;
                self.stats.frame = st.frame as u32;
                self.stats.encoding = u32::from(st.encoding.as_str() != "full");
                let Some(a) = self.applier.as_mut() else {
                    self.error = "accept before start".into();
                    return -1;
                };
                if self.version >= 11 {
                    // W11c: the transaction's dynamic bodies replace their surfaces' geometry in
                    // place (by mesh id, no store entry and no hash), while the record is in hand.
                    // W13c: at /13 the validator's block ranges index the reconstructed /12
                    // record (`record_view`), not the predicted one it was given.
                    let rec = v.record_view(bytes);
                    let t = prof::start();
                    let ingested = if self.opts.stale_dynamic_rx {
                        // Sabotage: a body whose surface already holds one of the same shape is
                        // ignored (the surface keeps drawing its first pose).
                        let held = &self.payloads.dynamic;
                        let keep: Vec<_> = v
                            .dynamic_bodies()
                            .iter()
                            .filter(|b| {
                                let old = held
                                    .get(b.mesh)
                                    .and_then(|m| m.surfaces.get(b.surface as usize))
                                    .and_then(|g| g.as_ref());
                                let new = st
                                    .meshes
                                    .get(&b.mesh)
                                    .and_then(|m| m.surfaces.get(b.surface as usize));
                                !matches!((old, new), (Some(g), Some(n))
                                    if g.layout.vertex_count as i64 == n.vertex_count
                                        && g.layout.index_count as i64 == n.index_count
                                        && g.layout.format == n.format)
                            })
                            .copied()
                            .collect();
                        self.payloads.dynamic.ingest(st, &keep, rec)
                    } else {
                        self.payloads.dynamic.ingest(st, v.dynamic_bodies(), rec)
                    };
                    // PM6b: the transaction's emits. gl_compatibility's particles_emit is a no-op
                    // (render-stream-12.md "As built (PM6a)" rule 10), so GSW's simulation consumes
                    // them as one: counted, not simulated.
                    let emits = v.particle_emits().len() as u64;
                    if self.opts.ignore_particle_emits {
                        self.payloads.particles.emits_dropped += emits;
                    } else {
                        self.payloads.particles.emits_total += emits;
                    }
                    // PM3: the transaction's multimesh buffers, by multimesh id, likewise.
                    if !self.payloads.multimeshes.is_empty() || !v.multimesh_buffers().is_empty() {
                        self.payloads
                            .multimeshes
                            .ingest(st, v.multimesh_buffers(), rec);
                    }
                    prof::add(prof::PAYLOAD_DECODE, t);
                    if let Err(e) = ingested {
                        self.error = fail(e);
                        return -1;
                    }
                    // W11c: hashes that left C ∪ names(S_n) leave the store now, unless the
                    // displayed state still draws from them (then after the apply).
                    if !self.opts.ignore_released {
                        self.retention.note(v);
                        let shown = &*a;
                        self.retention
                            .sweep(v, &mut self.payloads, || shown.referenced_payload_hashes());
                    }
                }
                a.prepare(st, v.delta());
                self.compute_needed()
            }
        }
    }

    /// The accepted transaction's needed set (after `Applier::prepare`): `ACCEPT_TRANSACTION`
    /// when nothing is missing, else `ACCEPT_NEEDS_PAYLOADS` with `needed_*` filled.
    fn compute_needed(&mut self) -> i32 {
        let (Some(v), Some(a)) = (self.validator.as_ref(), self.applier.as_ref()) else {
            self.error = "accept before start".into();
            return -1;
        };
        let t = prof::start();
        let st = v.state();
        a.needed(st, v.delta(), &self.payloads, &mut self.needed);
        self.provide_cursor = 0;
        self.stats.needed = self.needed.len() as u32;
        if self.needed.is_empty() {
            prof::add(prof::NEEDED, t);
            return ACCEPT_TRANSACTION;
        }
        self.needed_bytes.clear();
        self.needed_kinds.clear();
        let mesh: HashSet<Hash> = st
            .meshes
            .values()
            .flat_map(|m| m.surfaces.iter().filter_map(|s| s.hash))
            .collect();
        let shader: HashSet<Hash> = st.shaders.values().filter_map(|s| s.hash).collect();
        let ktx2 = uastc_hashes(st);
        for h in &self.needed {
            self.needed_bytes.extend_from_slice(&h.0);
            self.needed_kinds.push(if shader.contains(h) {
                2
            } else if mesh.contains(h) {
                1
            } else if ktx2.contains(h) {
                3
            } else {
                0
            });
        }
        prof::add(prof::NEEDED, t);
        ACCEPT_NEEDS_PAYLOADS
    }

    // ------------------------------------------------------------------------ G7l: live mode

    /// Live step 1 (Q14c): room for one WebSocket message of `len` bytes, which the caller copies
    /// in once through a view of the returned pointer (taken after this call: it may grow memory).
    pub fn rx(&mut self, len: usize) -> *mut u8 {
        if self.rx.len() < len {
            self.rx.resize(len, 0);
        }
        self.rx.as_mut_ptr()
    }

    /// A connection's first message, `len` bytes in `rx`: the magic of `version` (7, or G8g's 8:
    /// render-stream/8's live transport is /7's with /8's tables) followed by exactly the session
    /// record (render-stream-2.md "Live transport"). Starts the session as `start` does.
    /// 0, or -1 (`error`: `bad-magic`, `truncated`, `live-framing`, or the session's own codes).
    pub fn live_session(&mut self, len: usize, version: u8) -> i32 {
        self.live = true;
        // G8kp: a receiver that offered render-stream.9 (RS_RECEIVER_PROTOCOL=9, `live_protocol`
        // in the options) speaks /9 only, CG1: one that offered render-stream.10 /10 only; G8g: 7
        // or 8 otherwise (the page passes the version it offered).
        // W11c: one that offered render-stream.11 /11 only.
        // PM5: one that offered render-stream.12 /12 only.
        let ok = match self.opts.live_protocol {
            0 => version == 7 || version == 8,
            p => version == p,
        };
        if !ok {
            self.error = format!(
                "live-version: render-stream/{version} (options live_protocol {}) has no live transport here",
                if self.opts.live_protocol == 0 { 7 } else { self.opts.live_protocol }
            );
            return -1;
        }
        let msg = &self.rx[..len];
        if wire::version_of_magic(msg) != Some(version) {
            self.error = format!(
                "bad-magic: expected {}, got {}",
                wire::hex(&wire::magic(version)),
                wire::hex(&msg[..len.min(wire::MAGIC_LEN)])
            );
            return -1;
        }
        let spans = match wire::split_records(msg, version) {
            Ok(s) => s,
            Err(e) => {
                self.error = fail(e);
                return -1;
            }
        };
        if spans.len() != 1 {
            self.error = format!(
                "live-framing: the first message holds {} records, expected exactly the session",
                spans.len()
            );
            return -1;
        }
        self.data = msg.to_vec();
        self.spans = spans;
        self.version = version;
        self.rx_offset = len;
        self.start()
    }

    /// Every later message, `len` bytes in `rx`: exactly one record, accepted as `accept` does
    /// (resource, transaction or end). Returns `ACCEPT_*`, or -1 (`error`; `live-framing` when the
    /// message is not exactly one record, after the record itself was accepted, as natively).
    pub fn live_accept(&mut self, len: usize) -> i32 {
        let offset = self.rx_offset;
        if len < 4 {
            self.error = format!(
                "truncated: record_len prefix at offset {offset} runs past the end of the input"
            );
            return -1;
        }
        let byte_length = 4 + wire::le_u32(&self.rx, 0) as usize;
        if byte_length > len {
            self.error = format!(
                "truncated: record at offset {offset} declares {byte_length} bytes but only {len} remain"
            );
            return -1;
        }
        // W13c: while a `predict-check` resync awaits its full transaction, patches are dropped.
        if self.predict_await_full {
            match peek_transaction(&self.rx[..byte_length]) {
                Some((_, false)) => {
                    self.predict_dropped += 1;
                    return ACCEPT_HELD;
                }
                Some((_, true)) => self.predict_await_full = false,
                None => {}
            }
        }
        let index = self.accepted.len();
        let code = self.accept_bytes(true, 0, byte_length, offset, index);
        if code < 0 {
            // W13c (render-stream-13.md "Decoding and check order"): a /13 transaction whose
            // reconstructed blocks miss `predict_check` applied nothing; the caller resyncs it with
            // reason `coding`, and the patches before the full are dropped here.
            if self.version >= 13 && self.error.starts_with("predict-check") {
                self.predict_await_full = true;
                self.predict_failures += 1;
            }
            return code;
        }
        self.rx_offset += len;
        if byte_length != len {
            self.error = format!(
                "live-framing: a message of {len} bytes holds a {byte_length}-byte record; every message after the first is exactly one record"
            );
            return -1;
        }
        code
    }

    /// The last accepted record's SHA-256 (live mode digests inline): 32 bytes.
    pub fn last_digest_ptr(&self) -> *const u8 {
        self.last_digest.as_ptr()
    }

    /// GTS (rs-core `Validator::transport_skip`, render-stream-11.md "As built (W11d)" 1): the
    /// live coding skipped transactions (a `coding` resync, W11t), so the next one is the full
    /// transaction the resync forces, at a later seq than the last accepted + 1. The validator
    /// then accepts the seq jump and prunes C to names(S) after that full.
    pub fn transport_skip(&mut self) {
        if let Some(v) = self.validator.as_mut() {
            v.transport_skip();
        }
    }

    /// A resync (`RS_RECEIVER_RESYNC`) skipped transactions the applier never saw, and the
    /// applier is delta-driven, so the full transaction that ends it is applied by a fresh
    /// applier that walks the whole resolved state, as the native receiver's reconcile does.
    /// Payloads stay (content-addressed). Returns `ACCEPT_TRANSACTION` or `ACCEPT_NEEDS_PAYLOADS`.
    pub fn live_rebuild(&mut self) -> i32 {
        let (Some(v), Some(viewport)) = (self.validator.as_ref(), self.viewport) else {
            self.error = "live_rebuild before start".into();
            return -1;
        };
        let mut applier = Applier::new(viewport);
        applier.sabotage = self.opts.apply;
        applier.half_instances = v.session().engine.rendering_method == "gl_compatibility";
        // GRH: the executor still holds the GPU textures; the fresh applier reconciles against
        // them instead of uploading all of them again. The old applier's other state goes first.
        if let Some(old) = self.applier.take() {
            if !self.opts.rebuild_reupload {
                applier.inherit_residency(old);
            }
        }
        applier.prepare(v.state(), v.delta());
        self.applier = Some(applier);
        self.compute_needed()
    }

    /// RS_RECEIVER_RECONNECT's dispose evidence (off the frame path), in the native receiver's
    /// RID terms with the applier's retained objects as the RIDs (items, non-root canvases,
    /// resident textures, meshes, shaders and materials): `{"created":..,"freed_by_apply":..,
    /// "owned":..}` over this connection, `created` and `freed_by_apply` summed from its applied
    /// transactions' counters and `owned` counted from the applier's own tables.
    pub fn dispose_json(&self) -> String {
        let (mut created, mut freed) = (0u64, 0u64);
        for e in self
            .evidence
            .iter()
            .filter(|e| e.stream == self.stream_index)
        {
            let (c, f) = tx_dispose_counts(e);
            created += c;
            freed += f;
        }
        if self.summary_dispose.0 == self.stream_index {
            created += self.summary_dispose.1;
            freed += self.summary_dispose.2;
        }
        let owned = self
            .applier
            .as_ref()
            .map(|a| a.retained())
            .unwrap_or_default();
        format!(
            "{{\"created\":{created},\"freed_by_apply\":{freed},\"owned\":{},\"items\":{},\"canvases\":{},\"textures\":{},\"meshes\":{},\"shaders\":{},\"materials\":{}}}",
            owned.iter().sum::<usize>(),
            owned[0],
            owned[1],
            owned[2],
            owned[3],
            owned[4],
            owned[5]
        )
    }

    /// RS_RECEIVER_RECONNECT: drop the connection's session (validator, applier, needed set) and
    /// keep the GL context, the evidence and, with `keep_payloads`
    /// (RS_RECEIVER_RECONNECT_MEMORY=keep), the verified payloads. The next message is a fresh
    /// session on stream `stream_index + 1`.
    pub fn live_reset(&mut self, keep_payloads: bool) -> i32 {
        self.validator = None;
        self.applier = None;
        if !keep_payloads {
            self.payloads.clear();
        }
        // W11c: dynamic geometry is keyed by the old session's mesh ids, and the retention queue
        // by its states: neither survives a new session (its first full carries every body).
        self.payloads.dynamic.clear();
        self.retention.clear();
        self.stage.clear();
        self.needed.clear();
        self.provide_cursor = 0;
        self.accepted.clear();
        self.digested = 0;
        self.first_tx = true;
        self.prev_unsupported.clear();
        self.pending.clear();
        self.spans.clear();
        self.data.clear();
        self.rx_offset = 0;
        self.predict_await_full = false;
        self.stream_index += 1;
        self.stats = Stats {
            stream: self.stream_index,
            ..Stats::default()
        };
        0
    }

    /// The payload hashes held in memory, sorted hex, comma-separated (`live.reconnect`'s
    /// `memory_hashes`).
    pub fn memory_hashes(&self) -> String {
        let mut out: Vec<String> = self
            .payloads
            .textures
            .keys()
            .chain(self.payloads.meshes.keys())
            .chain(self.payloads.shaders.keys())
            .map(|h| h.to_hex())
            .collect();
        out.sort();
        out.join(",")
    }

    pub fn needed_count(&self) -> u32 {
        self.needed.len() as u32
    }

    pub fn needed_ptr(&self) -> *const u8 {
        self.needed_bytes.as_ptr()
    }

    /// One byte per needed hash: 0 a texture (GRT1, `.grt`), 1 a mesh surface (GRM1, `.grm`),
    /// 2 shader code (GRP1, `.grp`); the store's file extension.
    pub fn needed_kinds_ptr(&self) -> *const u8 {
        self.needed_kinds.as_ptr()
    }

    /// Reserve room for the next needed payload; the caller writes it through a view.
    pub fn alloc_payload(&mut self, len: usize) -> *mut u8 {
        if self.payload_buf.len() < len {
            self.payload_buf.resize(len, 0);
        }
        self.payload_buf.as_mut_ptr()
    }

    /// Verify (SHA-256 against the next needed hash) and ingest the payload just written.
    pub fn provide(&mut self, len: usize) -> i32 {
        let Some(hash) = self.needed.get(self.provide_cursor).copied() else {
            self.error = "provide: nothing is needed".into();
            return -1;
        };
        let bytes = &self.payload_buf[..len];
        match self
            .payloads
            .provide(bytes, &hash, self.version, !self.opts.skip_payload_hash)
        {
            Ok(()) => {
                self.note_quantized(&hash);
                self.provide_cursor += 1;
                self.totals.provided += 1;
                self.totals.provided_bytes += len as u64;
                self.verify.provided_in_frame += 1;
                if self.opts.skip_payload_hash {
                    self.verify.unverified_used += 1;
                }
                0
            }
            Err(e) => {
                self.error = fail(e);
                -1
            }
        }
    }

    /// G7o2: verify (SHA-256 against `hash_hex`, the needed hash the payload was fetched for) and
    /// decode the payload just written through `alloc_payload`, when it arrives (a fetch
    /// completion, between frames) rather than inside the frame that applies it. A mismatch is
    /// refused here (`resource-hash`, nothing staged), so the transaction can never use it.
    pub fn stage_payload(&mut self, len: usize, hash_hex: &str) -> i32 {
        let Some(hash) = Hash::from_hex(hash_hex) else {
            self.error = format!("resource-unavailable: {hash_hex:?} is not a sha256 hex name");
            return -1;
        };
        let bytes = &self.payload_buf[..len];
        match self
            .stage
            .stage(bytes, &hash, self.version, !self.opts.skip_payload_hash)
        {
            Ok(()) => {
                self.verify.staged += 1;
                0
            }
            Err(e) => {
                self.verify.refused += 1;
                self.error = fail(e);
                -1
            }
        }
    }

    /// Whether `hash_hex` is staged (verified, not yet provided).
    pub fn is_staged(&self, hash_hex: &str) -> bool {
        Hash::from_hex(hash_hex).is_some_and(|h| self.stage.has(&h))
    }

    /// G8kb: whether `hash_hex` names a KTX2 payload (a `uastc` variant of a texture of the
    /// accepted state): the shell transcodes it (`stage_ktx2`, the worker, `stage_transcoded`)
    /// instead of staging it with `stage_payload`.
    pub fn is_ktx2(&self, hash_hex: &str) -> bool {
        let (Some(h), Some(v)) = (Hash::from_hex(hash_hex), self.validator.as_ref()) else {
            return false;
        };
        uastc_hashes(v.state()).contains(&h)
    }

    /// G8kb (texture-delivery-design.md Q6 "GSW"): step 1 of a KTX2 payload's arrival. Verify the
    /// bytes just written through `alloc_payload` (SHA-256 against `hash_hex`, then rs-core's KTX2
    /// header and shape checks against the entry listing it) before the shell posts them to its
    /// transcoder worker; nothing is staged yet. A mismatch is refused here (`resource-hash`), as
    /// `stage_payload` refuses one, so a perturbed KTX2 is never transcoded.
    pub fn stage_ktx2(&mut self, len: usize, hash_hex: &str) -> i32 {
        let Some(hash) = Hash::from_hex(hash_hex) else {
            self.error = format!("resource-unavailable: {hash_hex:?} is not a sha256 hex name");
            return -1;
        };
        let shape = self.validator.as_ref().and_then(|v| {
            v.state().textures.values().find_map(|t| {
                t.variants
                    .iter()
                    .any(|x| x.hash == hash && x.encoding == VariantEncoding::Uastc)
                    .then_some((t.width, t.height, t.mipmaps))
            })
        });
        let Some((w, h, mips)) = shape else {
            self.verify.refused += 1;
            self.error = format!(
                "resource-payload: {hash_hex} is not a uastc variant of the accepted state"
            );
            return -1;
        };
        let verify = !self.opts.skip_payload_hash;
        match render_stream_core::apply::payloads::verify_ktx2(
            &self.payload_buf[..len],
            &hash,
            verify,
            w,
            h,
            mips,
        ) {
            Ok(()) => {
                self.ktx2_verified
                    .insert(hash, (w as u32, h as u32, mips, len, verify));
                0
            }
            Err(e) => {
                self.verify.refused += 1;
                self.error = fail(e);
                -1
            }
        }
    }

    /// G8kb: step 3 of a KTX2 payload's arrival. Stage the worker's transcode of `hash_hex` (every
    /// level, level 0 first, just written through `alloc_payload`) as `format`, an Image.Format
    /// name (a block format this context uploads, or `RGBA8`). Only a KTX2 `stage_ktx2` verified
    /// may be staged; `provide_staged` then moves it to the store like any staged payload.
    pub fn stage_transcoded(&mut self, len: usize, hash_hex: &str, format: &str) -> i32 {
        let Some(hash) = Hash::from_hex(hash_hex) else {
            self.error = format!("resource-unavailable: {hash_hex:?} is not a sha256 hex name");
            return -1;
        };
        let Some((w, h, mips, ktx2_len, verified)) = self.ktx2_verified.remove(&hash) else {
            self.error = format!(
                "resource-unverified: KTX2 {hash_hex} was transcoded without being verified"
            );
            return -1;
        };
        match render_stream_core::apply::payloads::texture_transcoded(
            format,
            w,
            h,
            mips,
            &self.payload_buf[..len],
        ) {
            Ok(px) => {
                self.stage.put(
                    hash,
                    render_stream_core::apply::payloads::Decoded::Texture(px),
                    ktx2_len,
                    verified,
                );
                self.verify.staged += 1;
                0
            }
            Err(e) => {
                self.error = format!("delivery-transcode-failed: {e}");
                -1
            }
        }
    }

    /// G8kb (texture-delivery-design.md Q3 "Transcode or upload failure"): the transcode of KTX2
    /// `hash_hex` failed (`delivery-transcode-failed`). The variant is refused for the session, so
    /// D3 falls through to the entry's next choice (at worst `decoded`, always servable), and the
    /// needed set is recomputed for the transaction being fetched: the shell re-reads it and
    /// fetches what is neither held nor staged. Returns `accept`'s code (`ACCEPT_TRANSACTION`
    /// when nothing more is needed), or -1 before a session.
    pub fn transcode_failed(&mut self, hash_hex: &str) -> i32 {
        let Some(hash) = Hash::from_hex(hash_hex) else {
            self.error = format!("resource-unavailable: {hash_hex:?} is not a sha256 hex name");
            return -1;
        };
        self.ktx2_verified.remove(&hash);
        let Some(a) = self.applier.as_mut() else {
            self.error = "transcode_failed before start".into();
            return -1;
        };
        a.delivery.refuse(hash);
        self.compute_needed()
    }

    /// G7o2: provide the next needed payload from the stage (verified when it arrived). Fails when
    /// it was never staged, i.e. never verified: the caller must not apply.
    pub fn provide_staged(&mut self) -> i32 {
        let Some(hash) = self.needed.get(self.provide_cursor).copied() else {
            self.error = "provide: nothing is needed".into();
            return -1;
        };
        let Some(s) = self.stage.take(&hash) else {
            self.error = format!(
                "resource-unverified: payload {} was not verified before use",
                hash.to_hex()
            );
            return -1;
        };
        self.payloads.insert(hash, s.decoded);
        self.note_quantized(&hash);
        self.provide_cursor += 1;
        self.totals.provided += 1;
        self.totals.provided_bytes += s.bytes as u64;
        self.verify.provided_staged += 1;
        if !s.verified {
            self.verify.unverified_used += 1;
        }
        0
    }

    /// G7k (Q10 soak): residency, one JSON object. `entries`/`bytes` are the `PayloadStore`'s own
    /// cache held now, and `evictions` are what it has freed so far this connection
    /// (`budget_bytes` is `null` when no `RS_RECEIVER_MEMORY_BUDGET_BYTES` was set, so a caller
    /// can tell "no budget" from "budget respected with headroom"). `resident_textures`/
    /// `resident_meshes` are [`Applier::retained`]'s GPU-object counts -- 0 before a session
    /// starts, so this is safe to call at any time, not only after a context restore.
    pub fn residency_json(&self) -> String {
        let owned = self
            .applier
            .as_ref()
            .map(|a| a.retained())
            .unwrap_or_default();
        let (gl_bytes, pinned_bytes) = self.pinned_and_gl_bytes();
        format!(
            "{{\"entries\":{},\"bytes\":{},\"gl_texture_bytes\":{},\"pinned_bytes\":{},\"evictions\":{},\"budget_bytes\":{},\"resident_items\":{},\"resident_textures\":{},\"resident_meshes\":{},\"resident_shaders\":{},\"resident_materials\":{}{}}}",
            self.payloads.len(),
            self.payloads.total_bytes(),
            gl_bytes,
            pinned_bytes,
            self.totals.residency_evictions,
            match self.opts.memory_budget_bytes {
                Some(b) => b.to_string(),
                None => "null".to_string(),
            },
            owned[0],
            owned[2],
            owned[3],
            owned[4],
            owned[5],
            self.retention_keys(),
        )
    }

    /// W11c: residency_json's /11 keys (empty below /11, so /8-/10 samples are unchanged):
    /// the dynamic bodies held, the retention rule's drops and queue, and |names(S_n)| and |C|
    /// (`store-bounded`: entries <= |names| + window).
    fn retention_keys(&self) -> String {
        if self.version < 11 {
            return String::new();
        }
        let d = &self.payloads.dynamic;
        let (names, carried) = self
            .validator
            .as_ref()
            .map(|v| (v.names_len(), v.carried_len()))
            .unwrap_or_default();
        format!(
            ",\"dynamic_meshes\":{},\"dynamic_surfaces\":{},\"dynamic_bytes\":{},\"dynamic_bodies_total\":{},\"released_total\":{},\"release_pending\":{},\"names\":{},\"carried\":{}",
            d.len(),
            d.surfaces(),
            d.bytes(),
            d.bodies_total,
            self.retention.released_total,
            self.retention.pending_len(),
            names,
            carried
        )
    }

    /// W11c (render-stream-11.md decision 9, `inline-fetch-zero`): may the fetcher GET `hash_hex`
    /// over HTTP now? "" when it may (always below /11), else the validator's refusal
    /// (`inline-fetch-zero: ...`), which the fetcher reports as a receiver failure.
    pub fn check_fetch(&self, hash_hex: &str) -> String {
        let (Some(v), Some(h)) = (self.validator.as_ref(), Hash::from_hex(hash_hex)) else {
            return String::new();
        };
        match v.check_fetch(&h) {
            Ok(()) => String::new(),
            Err(e) => fail(e),
        }
    }

    /// G7k: (GL texture bytes, pinned bytes). GL texture bytes are the resident textures' level-0
    /// RGBA8 (what the page holds as texture objects, each resident texture once). Pinned bytes
    /// are the store's referenced entries -- the floor [`PayloadStore::evict_unreferenced`]
    /// cannot go below.
    fn pinned_and_gl_bytes(&self) -> (u64, u64) {
        let Some(a) = self.applier.as_ref() else {
            return (0, 0);
        };
        let gl: std::collections::HashSet<_> = a.resident_texture_hashes().collect();
        let gl_bytes = self.payloads.bytes_of(&gl);
        let pinned = self.payloads.bytes_of(&a.referenced_payload_hashes());
        (gl_bytes, pinned)
    }

    /// G7o2 `payload-verified-before-use` counts, one JSON object.
    pub fn payload_verify_json(&self) -> String {
        let v = &self.verify;
        format!(
            "{{\"staged\":{},\"refused\":{},\"provided_staged\":{},\"provided_in_frame\":{},\"unverified_used\":{},\"still_staged\":{}}}",
            v.staged,
            v.refused,
            v.provided_staged,
            v.provided_in_frame,
            v.unverified_used,
            self.stage.len()
        )
    }

    /// Step 3: the accepted transaction to the packed list.
    pub fn apply(&mut self) -> i32 {
        if self.provide_cursor < self.needed.len() {
            self.error = format!(
                "apply: {} needed payload(s) not provided",
                self.needed.len() - self.provide_cursor
            );
            return -1;
        }
        let (Some(v), Some(a)) = (self.validator.as_ref(), self.applier.as_mut()) else {
            self.error = "apply before start".into();
            return -1;
        };
        let st = a.apply(v.state(), v.delta(), &self.payloads).clone();
        // W11c: the display moved to S_n, so what only the old display held leaves now.
        if !self.opts.ignore_released {
            let shown = &*a;
            self.retention
                .sweep(v, &mut self.payloads, || shown.referenced_payload_hashes());
        }
        let mut dynamic_sha = None;
        if self.version >= 11 {
            let w = &mut self.w11;
            let entries = self.payloads.len() as u64;
            w.store_max_entries = w.store_max_entries.max(entries);
            w.store_max_excess = w
                .store_max_excess
                .max(entries as i64 - (v.names_len() + v.carried_len()) as i64);
            w.dynamic_undrawn += a.meshes.dynamic_undrawn;
            if !self.opts.summary_log {
                let st = v.state();
                let mut ids: Vec<Id> = st
                    .meshes
                    .iter()
                    .filter(|(_, m)| m.is_dynamic())
                    .map(|(id, _)| *id)
                    .collect();
                ids.sort_unstable();
                let mut digest = Vec::new();
                for id in ids {
                    let m = &st.meshes[&id];
                    let held = self.payloads.dynamic.get(id);
                    for (k, s) in m.surfaces.iter().enumerate() {
                        let got = held
                            .and_then(|d| d.surfaces.get(k))
                            .and_then(|g| g.as_ref())
                            .map(render_stream_core::apply::dynamic::body_sha256);
                        w.dynamic_checked += 1;
                        if got != s.body_sha256 {
                            w.dynamic_mismatched += 1;
                            w.first_mismatch_seq.get_or_insert(st.seq);
                        }
                        digest.extend_from_slice(&id.to_le_bytes());
                        digest.extend_from_slice(&(k as u32).to_le_bytes());
                        digest.extend_from_slice(&got.map_or([0u8; 32], |h| h.0));
                    }
                }
                dynamic_sha = Some(wire::sha256(&digest));
            }
        }
        // G7k (Q10 soak): live mode, a budget set, `no-evict` not sabotaging it. Evicting after
        // `apply` (not before) means this transaction's own newly-resident hashes are always in
        // `referenced_payload_hashes` and so can never be the entries evicted to make room for
        // them (G6s's native rule: never evict the needed set).
        if self.live && !self.opts.no_evict {
            if let Some(budget) = self.opts.memory_budget_bytes {
                // D29 amendment: the budget counts the store's payload bytes plus the GL textures
                // the resident textures hold; only the store's unreferenced entries can go.
                let referenced = a.referenced_payload_hashes();
                let gl: std::collections::HashSet<_> = a.resident_texture_hashes().collect();
                let store_budget = budget.saturating_sub(self.payloads.bytes_of(&gl));
                let evicted = self.payloads.evict_unreferenced(&referenced, store_budget);
                self.totals.residency_evictions += evicted as u64;
            }
        }
        let t = prof::start();
        // applied.json evidence (no serialization here: `applied_json_parts` does it later).
        let state = v.state();
        let tx = TxEvidence {
            stream: self.stream_index,
            seq: state.seq,
            frame: state.frame,
            encoding: state.encoding.as_str(),
            record: self.last_tx_record,
            created: st.created,
            freed: st.freed,
            commands_replayed: st.commands_replayed,
            msdf_commands: st.msdf_commands,
            mesh_commands: st.mesh_commands,
            canvases_created: st.canvases_created,
            canvas_attach: st.canvas_attach,
            canvas_stacking_sets: st.canvas_stacking_sets,
            tex: std::mem::take(&mut a.account),
            mat: a.material_counts,
            meshes: std::mem::take(&mut a.meshes.uploads),
            dynamic_sha256: dynamic_sha,
        };
        if self.opts.summary_log {
            // W11c: a summary log keeps only what `dispose_json` sums.
            let (created, freed) = tx_dispose_counts(&tx);
            if self.summary_dispose.0 != self.stream_index {
                self.summary_dispose = (self.stream_index, 0, 0);
            }
            self.summary_dispose.1 += created;
            self.summary_dispose.2 += freed;
        } else {
            self.evidence.push(tx);
        }
        let mut now = HashSet::with_capacity(state.unsupported.len());
        for u in &state.unsupported {
            let key = (u.op.clone(), u.item, u.reason);
            if !self.prev_unsupported.contains(&key) && !now.contains(&key) {
                self.unsupported_out.push(UnsupportedOut {
                    seq: state.seq,
                    item: u.item,
                    name: u.op.clone(),
                    reason: u.reason,
                    shader: None,
                    detail: None,
                });
            }
            now.insert(key);
        }
        self.prev_unsupported = now;
        // G7s: shaders drawn without their code, once per (shader, hash), in the native
        // receiver's shape (`shader_set_code` / `shader-withheld`, plus `gsw-shader-transpile`).
        for r in a.shader_refusals.drain(..) {
            self.unsupported_out.push(UnsupportedOut {
                seq: state.seq,
                item: None,
                name: "shader_set_code".into(),
                reason: r.reason,
                shader: Some(r.shader),
                detail: (r.reason != "shader-withheld").then_some(r.detail),
            });
        }
        for &slot in a.bindings_changed.iter().filter(|_| !self.opts.summary_log) {
            self.param_log.push(ParamLogEntry {
                seq: state.seq,
                slot,
                key: a.binding_key(slot),
                binding: a.list.bindings[slot as usize].clone(),
            });
        }
        // Receiver-typed refusals: a shortcut that fired for the first time this transaction.
        for (k, n) in &a.shortcut_totals {
            if *n == 0 {
                continue;
            }
            if let Some(reason) = typed_reason(k) {
                if self.typed_seen.insert(reason) {
                    self.unsupported_out.push(UnsupportedOut {
                        seq: state.seq,
                        item: None,
                        name: (*k).into(),
                        reason,
                        shader: None,
                        detail: None,
                    });
                }
            }
        }
        self.first_tx = false;
        self.totals.transactions += 1;
        self.totals.structural += u64::from(st.structural);
        self.totals.relowered += u64::from(st.relowered);
        self.totals.relowered_in_place += u64::from(st.relowered_in_place);
        self.stats.structural = u32::from(st.structural);
        self.stats.relowered = st.relowered;
        self.stats.rows_written = st.rows_written;
        self.stats.lowered_draws = st.lowered_draws;
        self.stats.assembly_skips = st.assembly_skips;
        self.stats.emitted_draws = st.emitted_draws;
        self.stats.expected_calls = st.expected_calls;
        self.stats.vertices = st.vertex_count;
        self.stats.indices = st.index_count;
        self.stats.draws = st.emitted_draws;
        prof::add(prof::ADAPTER, t);
        0
    }

    /// Step 4: texture ops, dirty uploads, draws, blit.
    pub fn draw(&mut self) -> i32 {
        let (Some(a), Some(x)) = (self.applier.as_mut(), self.executor.as_mut()) else {
            self.error = "draw before start".into();
            return -1;
        };
        let t = prof::start();
        self.last_upload_bytes = a.list.queued_texture_bytes();
        let mut result = x.execute(&a.list);
        // A restored context (D14, D29): every GL object is new, so the list goes again with
        // `dirty.all` and every resident texture re-queued from the payload store. A list that
        // already carried `dirty.all` executes on the new objects (`restored == 1`) without its
        // textures, so it is re-sent too.
        if matches!(result, Err(ExecError::NeedsFullUpload))
            || matches!(&result, Ok(es) if es.restored == 1)
            || x.context_state() == ContextState::Restored
        {
            a.context_restored(&self.payloads);
            let (arena, shared) = a.list.queued_texture_bytes();
            self.last_upload_bytes.0 += arena;
            self.last_upload_bytes.1 += shared;
            self.totals.restores += 1;
            self.last_restore_draw = true;
            result = x.execute(&a.list);
        } else {
            self.last_restore_draw = false;
        }
        match result {
            Ok(es) => {
                a.list.consumed();
                self.last_exec = es;
                self.stats.executed_calls = es.draw_calls;
                self.stats.merged_draws = es.draws_merged;
                self.stats.texture_uploads = es.texture_uploads;
                self.stats.texture_upload_bytes = es.texture_upload_bytes;
                self.stats.item_bytes = es.item_bytes;
                self.stats.vertex_bytes = es.vertex_bytes;
                self.stats.index_bytes = es.index_bytes;
                self.totals.draw_calls += u64::from(es.draw_calls);
                self.totals.texture_uploads += u64::from(es.texture_uploads);
                // draw-count-parity: executed calls = lowered draws - typed skips - merges.
                if es.draw_calls != self.stats.expected_calls {
                    self.stats.parity_violations += 1;
                    self.totals.parity_violations += 1;
                }
                prof::add(prof::EXECUTE, t);
                0
            }
            Err(e) => {
                self.error = format!("execute: {e:?}");
                -1
            }
        }
    }

    /// GLJ: `{"arena":A,"shared":S}`, the texture bytes the last `draw` took from the draw list's
    /// byte arena (a copy `apply` made) and from the payload store's own bytes (shared, no copy).
    pub fn last_upload_bytes_json(&self) -> String {
        let (arena, shared) = self.last_upload_bytes;
        format!("{{\"arena\":{arena},\"shared\":{shared}}}")
    }

    /// G7u (D14, D29): the resident textures' payload hashes the store no longer holds, sorted
    /// hex, comma-separated: a context restore refetches each (`stage_payload` as it arrives,
    /// then `restore_take`) before the restore `draw`, which re-uploads only what the store holds.
    pub fn restore_missing(&self) -> String {
        self.applier
            .as_ref()
            .map(|a| {
                a.restore_missing(&self.payloads)
                    .iter()
                    .map(|h| h.to_hex())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default()
    }

    /// G7u: a refetched payload (verified when it arrived, `stage_payload`) into the store, for a
    /// context restore. 0, or -1 when it was never staged (`error`).
    pub fn restore_take(&mut self, hash_hex: &str) -> i32 {
        let Some(hash) = Hash::from_hex(hash_hex) else {
            self.error = format!("resource-unavailable: {hash_hex:?} is not a sha256 hex name");
            return -1;
        };
        let Some(s) = self.stage.take(&hash) else {
            self.error =
                format!("resource-unverified: payload {hash_hex} was not verified before use");
            return -1;
        };
        self.payloads.insert(hash, s.decoded);
        self.note_quantized(&hash);
        self.totals.provided += 1;
        self.totals.provided_bytes += s.bytes as u64;
        0
    }

    /// G7u `live.context_loss` facts, one JSON object: what is resident (the applier's textures
    /// and meshes) and what the last `draw` sent (`restore_draw` true when it re-sent everything
    /// to a restored context: its texture uploads, and the vertex and index bytes that carry every
    /// mesh's geometry, since meshes are lowered into the list's shared buffers).
    pub fn restore_json(&self) -> String {
        let owned = self
            .applier
            .as_ref()
            .map(|a| a.retained())
            .unwrap_or_default();
        let es = &self.last_exec;
        format!(
            "{{\"restore_draw\":{},\"restores\":{},\"resident_textures\":{},\"resident_meshes\":{},\"texture_uploads\":{},\"vertex_bytes\":{},\"index_bytes\":{},\"draw_calls\":{}}}",
            self.last_restore_draw,
            self.totals.restores,
            owned[2],
            owned[3],
            es.texture_uploads,
            es.vertex_bytes,
            es.index_bytes,
            es.draw_calls
        )
    }

    /// PM6b: the emitters this receiver simulates and what changed since the last call (JSON,
    /// `render_stream_core::apply::particles::describe`), or an empty string when nothing did. Call after the
    /// transactions are accepted and before `apply`.
    pub fn particles_sync(&mut self) -> String {
        let Some(v) = self.validator.as_ref() else {
            return String::new();
        };
        let st = v.state();
        self.payloads.particles.retain(st);
        if st.particles.is_empty() && self.payloads.particles.is_empty() {
            return String::new();
        }
        // PFB: a RendererRD host's process shader read its colour uniforms linearized.
        let linear = !self.opts.gl_particle_colors
            && render_stream_core::apply::particles::host_linearizes_particle_colors(
                &v.session().engine.rendering_method,
            );
        render_stream_core::apply::particles::describe(
            st,
            &mut self.payloads,
            linear,
            self.opts.shared_process_key,
        )
    }

    /// PM6b: the host's shader time for the newest accepted state (the process material reads
    /// `TIME`, so a /12 stream with an emitter carries it), or NaN without one.
    pub fn shader_time(&self) -> f64 {
        self.validator
            .as_ref()
            .and_then(|v| v.state().shader_time)
            .unwrap_or(f64::NAN)
    }

    /// PM6b: emitter `id`'s simulated instances (16 floats each), for the next `apply`.
    pub fn particles_set(&mut self, id: u32, data: &[f32]) {
        self.payloads.particles.set(id, data);
    }

    pub fn stats_ptr(&self) -> *const Stats {
        &self.stats
    }

    /// D31: digest every accepted record that has none yet (the deferred policy; with inline there
    /// is nothing to do). Returns how many were digested. Sabotage `digest-skip` leaves the newest
    /// one undigested, which `record-digest-complete` must catch.
    pub fn digest(&mut self) -> u32 {
        let Some(v) = self.validator.as_mut() else {
            return 0;
        };
        let mut n = 0;
        let len = v.record_digests().len();
        let stop = if self.opts.digest_skip {
            len.saturating_sub(1)
        } else {
            len
        };
        for k in self.digested.min(stop)..stop {
            if v.record_digests()[k].is_none() {
                let span = self.spans[self.accepted[k]];
                v.set_record_digest(k, wire::record_sha256(span.bytes(&self.data)));
                n += 1;
            }
        }
        self.digested = self.digested.max(stop);
        self.stats.digests_pending =
            v.record_digests().iter().filter(|d| d.is_none()).count() as u32;
        n
    }

    /// The last frame's fence: 1 complete, 0 pending, -1 none outstanding.
    pub fn poll_fence(&mut self) -> i32 {
        match self.executor.as_mut().map(|x| x.poll_fence()) {
            Some(FenceState::Complete { .. }) => 1,
            Some(FenceState::Pending { .. }) => 0,
            _ => -1,
        }
    }

    pub fn target_width(&self) -> u32 {
        self.applier
            .as_ref()
            .map(|a| a.viewport().width)
            .unwrap_or(0)
    }

    pub fn target_height(&self) -> u32 {
        self.applier
            .as_ref()
            .map(|a| a.viewport().height)
            .unwrap_or(0)
    }

    /// The shot: the target read back (RGBA/UNSIGNED_BYTE, rows top-down); a pointer to
    /// `4·w·h` bytes, or null.
    pub fn shot(&mut self) -> *const u8 {
        let (w, h) = (self.target_width() as usize, self.target_height() as usize);
        self.shot_buf.resize(4 * w * h, 0);
        match self
            .executor
            .as_mut()
            .map(|x| x.read_target(&mut self.shot_buf))
        {
            Some(Ok(())) => self.shot_buf.as_ptr(),
            Some(Err(e)) => {
                self.error = format!("shot: {e:?}");
                std::ptr::null()
            }
            None => std::ptr::null(),
        }
    }

    pub fn error(&self) -> String {
        self.error.clone()
    }

    /// The session record's meta, as the wire carries it (the shell reads the viewport, stream and
    /// resources blocks from it once, at start).
    /// G8kp (texture-delivery-design.md D3, Q3): `{texture_encodings, gpu_formats,
    /// gpu_formats_detected, gpu_format_mask}` as this receiver states them (after `start`).
    pub fn delivery_json(&self) -> String {
        let d = &self.delivery;
        format!(
            "{{\"texture_encodings\":{},\"gpu_formats\":{},\"gpu_formats_detected\":{},\"gpu_format_mask\":{},\"variant_policy\":{},\"variant_policy_default\":{},\"bc_aligned_only\":true,\"transcoder_aligns\":true}}",
            json_str(&d.texture_encodings),
            json_str(&d.gpu_formats),
            json_str(&d.gpu_formats_detected),
            json_str(&d.gpu_format_mask),
            json_str(d.variant_policy),
            d.variant_policy_default
        )
    }

    pub fn session_meta(&self) -> String {
        let Some(span) = self.spans.first() else {
            return String::new();
        };
        wire::frame(span.bytes(&self.data), span.offset)
            .map(|f| String::from_utf8_lossy(f.meta).into_owned())
            .unwrap_or_default()
    }

    /// The current resolved state as the native receiver dumps it (`state/seq-<n>.json`, Godot's
    /// float spelling): evidence, called only for the seqs `RS_RECEIVER_STATE_SEQS` names.
    pub fn state_dump(&self) -> String {
        let Some(v) = self.validator.as_ref() else {
            return String::new();
        };
        let mut out = Vec::with_capacity(8192);
        canon::write_state_godot(&mut out, v.state());
        out.push(b'\n');
        String::from_utf8(out).unwrap_or_default()
    }

    /// The canonical resolved state (`self-test-rs-core.ts`'s form) of the current transaction.
    pub fn state_canonical(&self) -> String {
        self.validator
            .as_ref()
            .map(|v| canon::transaction_json(v.state()))
            .unwrap_or_default()
    }

    /// applied.json's receiver-side parts (off the frame path, after `digest()`): every applied
    /// transaction (`seq`, `frame`, `encoding`, `record_sha256`, `created`, `freed`, the command
    /// counts and the texture accounting of `resources`), `uploads[]` and `unsupported[]`, in the
    /// native receiver's shapes. The shell adds its own fields (fetches, timings, frames).
    pub fn applied_json_parts(&self) -> String {
        let digests = self.validator.as_ref().map(|v| v.record_digests());
        let mut out = String::from("{\"transactions\":[");
        for (i, e) in self.evidence.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            let sha = digests
                .and_then(|d| d.get(e.record).copied().flatten())
                .map(|h| format!("\"{}\"", h.to_hex()))
                .unwrap_or_else(|| "null".into());
            out.push_str(&format!(
                "{{\"stream\":{},\"seq\":{},\"frame\":{},\"encoding\":\"{}\",\"record_sha256\":{},\"created\":{},\"freed\":{},\"commands_replayed\":{},\"msdf_commands\":{},\"mesh_commands\":{},\"resources\":{{\"created\":{},\"updated\":{},\"replaced\":{},\"freed\":{},\"upload_bytes\":{},\"canvases_created\":{},\"canvas_attach\":{},\"canvas_stacking_sets\":{},\"shaders_created\":{},\"shader_code_sets\":{},\"materials_created\":{},\"param_sets\":{},\"instance_param_sets\":{},\"meshes_created\":{},\"meshes_rebuilt\":{},\"surface_updates\":{},\"mesh_upload_bytes\":{}}}}}",
                e.stream,
                e.seq,
                e.frame,
                e.encoding,
                sha,
                e.created,
                e.freed,
                e.commands_replayed,
                e.msdf_commands,
                e.mesh_commands,
                e.tex.created,
                e.tex.updated,
                e.tex.replaced,
                e.tex.freed,
                e.tex.upload_bytes,
                e.canvases_created,
                e.canvas_attach,
                e.canvas_stacking_sets,
                e.mat.shaders_created,
                e.mat.shader_code_sets,
                e.mat.materials_created,
                e.mat.param_sets,
                e.mat.instance_param_sets,
                e.meshes.iter().filter(|m| m.op == "create").count(),
                e.meshes.iter().filter(|m| m.op == "rebuild").count(),
                e.meshes.iter().filter(|m| m.op == "update").count(),
                e.meshes.iter().map(|m| m.bytes).sum::<u64>()
            ));
            if let Some(d) = e.dynamic_sha256 {
                // W11c: /11 only (None below), so /8-/10 parts are unchanged.
                out.pop();
                out.push_str(&format!(",\"dynamic_sha256\":\"{}\"}}", d.to_hex()));
            }
        }
        out.push_str("],\"uploads\":[");
        let mut first = true;
        for e in &self.evidence {
            for u in &e.tex.uploads {
                if !first {
                    out.push(',');
                }
                first = false;
                // G8kp: `encoding` (D3's choice) only from /9, so older reports are unchanged.
                out.push_str(&format!(
                    "{{\"id\":{},\"hash\":{},\"op\":\"{}\",\"data_bytes\":{},\"stream\":{},\"seq\":{}{}}}",
                    u.id,
                    u.hash
                        .map(|h| format!("\"{}\"", h.to_hex()))
                        .unwrap_or_else(|| "null".into()),
                    u.op,
                    u.data_bytes,
                    e.stream,
                    e.seq,
                    u.encoding
                        .map(|enc| format!(",\"encoding\":\"{enc}\""))
                        .unwrap_or_default()
                ));
            }
        }
        out.push_str("],\"mesh_uploads\":[");
        let mut first = true;
        for e in &self.evidence {
            for m in &e.meshes {
                if !first {
                    out.push(',');
                }
                first = false;
                let surfaces: Vec<String> = m.surfaces.iter().map(|k| k.to_string()).collect();
                let buffers: Vec<String> = m.buffers.iter().map(|b| format!("\"{b}\"")).collect();
                out.push_str(&format!(
                    "{{\"id\":{},\"op\":\"{}\",\"surfaces\":[{}],\"buffers\":[{}],\"bytes\":{},\"stream\":{},\"seq\":{}}}",
                    m.id,
                    m.op,
                    surfaces.join(","),
                    buffers.join(","),
                    m.bytes,
                    e.stream,
                    e.seq
                ));
            }
        }
        out.push_str("],\"unsupported\":[");
        for (i, u) in self.unsupported_out.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "{{\"seq\":{},\"item\":{},\"name\":{},\"reason\":{}",
                u.seq,
                u.item
                    .map(|i| i.to_string())
                    .unwrap_or_else(|| "null".into()),
                json_str(&u.name),
                json_str(u.reason)
            ));
            if let Some(s) = u.shader {
                out.push_str(&format!(",\"shader\":{s}"));
            }
            if let Some(d) = &u.detail {
                out.push_str(&format!(",\"detail\":{}", json_str(d)));
            }
            out.push('}');
        }
        // G8g: the receiver-side caveat of a quantized float texture (render-stream-8.md "As built
        // (G8f)"; no wire change), with the float formats it was taken for.
        let q: Vec<String> = self.quantized_float.iter().map(|f| format!("\"{f}\"")).collect();
        out.push(']');
        // PM6b: applied.json `w11.particles`, the native receiver's keys where GSW has them (the
        // shell adds what its simulation counts: emitters made, restarts, seed sets).
        if let (true, Some(a)) = (self.version >= 12, self.applier.as_ref()) {
            let p = &self.payloads.particles;
            let total = |k: &str| a.shortcut_totals.get(k).copied().unwrap_or(0);
            let undrawn = total("particles-undrawn");
            let skipped = total("particles-unavailable-skipped");
            if p.sets_total + a.particles_commands + undrawn + skipped + p.emits_total + p.emits_dropped > 0 {
                out.push_str(&format!(
                    ",\"w11_particles\":{{\"particles_commands\":{},\"skipped_particles_commands\":{},\"particles_commands_undrawn\":{},\"emits\":{},\"emits_dropped\":{},\"buffer_sets\":{},\"buffers_held\":{},\"buffers_dropped\":{}}}",
                    a.particles_commands,
                    skipped,
                    undrawn,
                    p.emits_total,
                    p.emits_dropped,
                    p.sets_total,
                    p.created_total,
                    p.freed_total
                ));
            }
        }
        // PM3: applied.json `w11.multimesh`, the native receiver's keys where GSW has them.
        if let (true, Some(a)) = (self.version >= 11, self.applier.as_ref()) {
            let m = &self.payloads.multimeshes;
            let total = |k: &str| a.shortcut_totals.get(k).copied().unwrap_or(0);
            let undrawn = total("multimesh-undrawn");
            let skipped = total("multimesh-unavailable-skipped");
            if m.buffers_total + a.multimesh_commands + undrawn + skipped > 0 {
                out.push_str(&format!(
                    ",\"w11_multimesh\":{{\"multimeshes_created\":{},\"multimeshes_freed\":{},\"buffer_sets\":{},\"buffer_bytes\":{},\"multimesh_commands\":{},\"skipped_multimesh_commands\":{},\"undrawn\":{},\"instances_written\":{}}}",
                    m.created_total,
                    m.freed_total,
                    m.buffers_total,
                    m.bytes_total,
                    a.multimesh_commands,
                    skipped,
                    undrawn,
                    a.instances_written
                ));
            }
        }
        out.push_str(&format!(",\"float_quantized\":[{}]", q.join(",")));
        out.push_str(if q.is_empty() {
            ",\"caveats\":[]}"
        } else {
            ",\"caveats\":[\"float-texture-quantized\"]}"
        });
        out
    }

    /// `shader-param-parity` evidence (off the frame path): every item-space binding's values each
    /// time they changed, `{seq, slot, material, canvas, item, program, post_modulate, uniforms:
    /// {name: [..]}, samplers: {name: texture}}`, one JSON object per line.
    pub fn shader_params_jsonl(&self) -> String {
        let mut out = String::new();
        // The f32 GL value, written exactly (as its f64 widening).
        let num = |x: f32| {
            if x.is_finite() {
                format!("{}", f64::from(x))
            } else {
                "null".to_string()
            }
        };
        for e in &self.param_log {
            let (material, canvas, item) = match e.key {
                Some(k) => (
                    k.material.to_string(),
                    k.canvas.to_string(),
                    k.item.map(|i| i.to_string()).unwrap_or("null".into()),
                ),
                None => ("null".into(), "null".into(), "null".into()),
            };
            let uniforms: Vec<String> = e
                .binding
                .uniforms
                .iter()
                .map(|u| {
                    let values: Vec<String> = match &u.value {
                        UniformValue::Float(v) => v.iter().map(|x| num(*x)).collect(),
                        UniformValue::Int(v) => v.iter().map(|x| x.to_string()).collect(),
                    };
                    format!("{}:[{}]", json_str(&u.name), values.join(","))
                })
                .collect();
            let samplers: Vec<String> = e
                .binding
                .samplers
                .iter()
                .map(|s| format!("{}:{}", json_str(&s.name), s.texture))
                .collect();
            let pm: Vec<String> = e.binding.post_modulate.iter().map(|x| num(*x)).collect();
            out.push_str(&format!(
                "{{\"seq\":{},\"slot\":{},\"material\":{material},\"canvas\":{canvas},\"item\":{item},\"program\":{},\"post_modulate\":[{}],\"uniforms\":{{{}}},\"samplers\":{{{}}}}}\n",
                e.seq,
                e.slot,
                e.binding.program,
                pm.join(","),
                uniforms.join(","),
                samplers.join(",")
            ));
        }
        out
    }

    /// G8g: records `hash`'s payload format when it is a float one (quantized to RGBA8 on decode).
    fn note_quantized(&mut self, hash: &Hash) {
        if let Some(t) = self.payloads.textures.get(hash) {
            if matches!(
                t.format.as_str(),
                "RF" | "RGF" | "RGBF" | "RGBAF" | "RH" | "RGH" | "RGBH" | "RGBAH"
            ) {
                self.quantized_float.insert(t.format.clone());
            }
        }
    }

    /// The run's evidence (off the frame path): totals, the typed shortcuts, the wire's unsupported
    /// set, the digests, the last frame's executor counters.
    pub fn evidence_json(&self) -> String {
        let mut out = String::from("{");
        let t = &self.totals;
        out.push_str(&format!(
            "\"transactions\":{},\"structural\":{},\"relowered\":{},\"relowered_in_place\":{},\"draw_calls\":{},\"parity_violations\":{},\"texture_uploads\":{},\"provided\":{},\"provided_bytes\":{},\"restores\":{}",
            t.transactions,
            t.structural,
            t.relowered,
            t.relowered_in_place,
            t.draw_calls,
            t.parity_violations,
            t.texture_uploads,
            t.provided,
            t.provided_bytes,
            t.restores
        ));
        out.push_str(",\"shortcuts\":{");
        if let Some(a) = &self.applier {
            let parts: Vec<String> = a
                .shortcut_totals
                .iter()
                .map(|(k, v)| format!("\"{k}\":{v}"))
                .collect();
            out.push_str(&parts.join(","));
        }
        out.push('}');
        if let Some(v) = &self.validator {
            let st = v.state();
            let unsupported: Vec<String> = st
                .unsupported
                .iter()
                .map(|u| {
                    format!(
                        "{{\"op\":\"{}\",\"item\":{},\"reason\":\"{}\"}}",
                        u.op,
                        u.item.map(|i| i.to_string()).unwrap_or("null".into()),
                        u.reason
                    )
                })
                .collect();
            out.push_str(&format!(",\"unsupported\":[{}]", unsupported.join(",")));
            let digests = v.record_digests();
            out.push_str(&format!(
                ",\"records_accepted\":{},\"records_digested\":{}",
                digests.len(),
                digests.iter().filter(|d| d.is_some()).count()
            ));
            if let Some(Some(last)) = digests.last() {
                out.push_str(&format!(",\"last_record_sha256\":\"{}\"", last.to_hex()));
            }
        }
        out.push_str(&format!(",\"last_exec\":{}", self.last_exec.to_json()));
        if self.version >= 11 {
            let w = &self.w11;
            let d = &self.payloads.dynamic;
            out.push_str(&format!(
                ",\"w11\":{{\"store_max_entries\":{},\"store_max_excess\":{},\"store_entries\":{},\"released_total\":{},\"release_pending\":{},\"dynamic_meshes\":{},\"dynamic_bytes\":{},\"dynamic_bodies_total\":{},\"dynamic_body_bytes_total\":{},\"dynamic_checked\":{},\"dynamic_mismatched\":{},\"first_mismatch_seq\":{},\"dynamic_undrawn\":{}}}",
                w.store_max_entries,
                w.store_max_excess,
                self.payloads.len(),
                self.retention.released_total,
                self.retention.pending_len(),
                d.len(),
                d.bytes(),
                d.bodies_total,
                d.body_bytes_total,
                w.dynamic_checked,
                w.dynamic_mismatched,
                w.first_mismatch_seq.map_or("null".to_string(), |s| s.to_string()),
                w.dynamic_undrawn
            ));
        }
        if self.version >= 13 {
            // W13c: the /13 accept path's evidence (render-stream-13.md "As built (W13c)").
            let units = self
                .validator
                .as_ref()
                .map(|v| {
                    let (b, a, m) = v.prediction_history().h1().counts();
                    b + a + m
                })
                .unwrap_or(0);
            out.push_str(&format!(
                ",\"w13\":{{\"predict_failures\":{},\"predict_dropped\":{},\"no_predict_reset\":{},\"history_units\":{}}}",
                self.predict_failures, self.predict_dropped, self.opts.no_predict_reset, units
            ));
        }
        out.push('}');
        out
    }
}
