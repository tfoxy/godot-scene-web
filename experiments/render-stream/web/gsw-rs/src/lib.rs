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
use render_stream_core::apply::geom;
use render_stream_core::apply::material_residency::MaterialCounts;
use render_stream_core::apply::payloads::PayloadStore;
use render_stream_core::apply::programs::{ProgramEntry, ProgramInfo};
use render_stream_core::apply::residency::TextureAccount;
use render_stream_core::apply::{Applier, ApplySabotage, BindingKey, Viewport};
use render_stream_core::canon;
use render_stream_core::state::{Hash, Id, ShaderSource};
use render_stream_core::validate::{Accepted, DigestPolicy, Options, Validator};
use render_stream_core::wire::{self, RecordSpan};
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

pub const ACCEPT_TRANSACTION: i32 = 0;
pub const ACCEPT_RESOURCE: i32 = 1;
pub const ACCEPT_END: i32 = 2;
pub const ACCEPT_NEEDS_PAYLOADS: i32 = 3;

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

#[derive(Clone, Copy, Default)]
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
}

/// `RS_RECEIVER_SABOTAGE` values the TypeScript shell, not this module, acts on, or that have no
/// effect on a file-mode GSW receiver (gate7-design.md Q5; each is typed in the leg's evidence).
const SHELL_SABOTAGES: &[&str] = &[
    "css-opacity",
    "ack-on-receipt",
    "ack-while-hidden",
    "leak-gl-textures",
    "no-evict",
    "ignore-cache",
    "wrong-http-token",
];

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
                "drop-msdf" => o.apply.lower.drop_msdf = true,
                "ignore-set-transform" => o.apply.lower.ignore_set_transform = true,
                "ignore-clip-ignore" => o.apply.lower.ignore_clip_ignore = true,
                "ignore-nine-patch-axis" => o.apply.lower.ignore_nine_patch_axis = true,
                "polygon-winding" => o.apply.lower.polygon_winding = true,
                "drop-mesh-surface" => o.apply.mesh.drop_surface = true,
                "stale-mesh" => o.apply.mesh.stale = true,
                "ignore-presentation" => o.ignore_presentation = true,
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
    payloads: PayloadStore,
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
    stream_index: u32,
    last_digest: [u8; 32],
    /// The session viewport, kept so a resync can rebuild the applier (`live_rebuild`).
    viewport: Option<Viewport>,
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
        "slice-msdf-skipped" => "gsw-msdf",
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
    tex: TextureAccount,
    /// The native receiver's /5 shader and material counters (G7s).
    mat: MaterialCounts,
    /// The transaction's `mesh_uploads` rows (G7t: native mesh residency).
    meshes: Vec<render_stream_core::apply::meshes::MeshUpload>,
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
            payloads: PayloadStore::default(),
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
            stream_index: 1,
            last_digest: [0; 32],
            viewport: None,
        })
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
        self.payloads.shaders.get(hash).cloned()
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
    /// `glsl`, JSON). Returns 0 when registered, 1 when GL refused it (registered as the typed
    /// refusal `gsw-shader-transpile` with the compile log), -1 on a usage error.
    pub fn define_program(&mut self, i: u32, glsl: &str, meta: &str) -> i32 {
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
        match x.define_program(id, glsl) {
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
            self.error = "bad-magic: not a render-stream/2..7 recording".into();
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
        };
        let v = Validator::new(span.bytes(&self.data), span.offset, opts).map_err(fail)?;
        let s = v.session();
        let vp = &s.viewport;
        let size = vp.presentation_size.unwrap_or(vp.logical_size);
        let global = if size == vp.logical_size || self.opts.ignore_presentation {
            geom::IDENTITY
        } else {
            s.host_final_xform
        };
        let viewport = Viewport {
            width: size[0].max(1) as u32,
            height: size[1].max(1) as u32,
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
                // Inline delivery: the validator verified the payload against its hash.
                if let Some(bytes) = v.inline_payload(&hash) {
                    if let Err(e) = self.payloads.provide(bytes, &hash, self.version, false) {
                        self.error = fail(e);
                        return -1;
                    }
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
        let st = v.state();
        a.needed(st, v.delta(), &self.payloads, &mut self.needed);
        self.provide_cursor = 0;
        self.stats.needed = self.needed.len() as u32;
        if self.needed.is_empty() {
            return ACCEPT_TRANSACTION;
        }
        self.needed_bytes.clear();
        self.needed_kinds.clear();
        let mesh: HashSet<Hash> = st
            .meshes
            .values()
            .flat_map(|m| m.surfaces.iter().map(|s| s.hash))
            .collect();
        let shader: HashSet<Hash> = st.shaders.values().filter_map(|s| s.hash).collect();
        for h in &self.needed {
            self.needed_bytes.extend_from_slice(&h.0);
            self.needed_kinds.push(if shader.contains(h) {
                2
            } else if mesh.contains(h) {
                1
            } else {
                0
            });
        }
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

    /// A connection's first message, `len` bytes in `rx`: the /7 magic followed by exactly the
    /// session record (render-stream-2.md "Live transport"). Starts the session as `start` does.
    /// 0, or -1 (`error`: `bad-magic`, `truncated`, `live-framing`, or the session's own codes).
    pub fn live_session(&mut self, len: usize) -> i32 {
        self.live = true;
        let msg = &self.rx[..len];
        if wire::version_of_magic(msg) != Some(7) {
            self.error = format!(
                "bad-magic: expected {}, got {}",
                wire::hex(&wire::magic(7)),
                wire::hex(&msg[..len.min(wire::MAGIC_LEN)])
            );
            return -1;
        }
        let spans = match wire::split_records(msg, 7) {
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
        self.version = 7;
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
        let index = self.accepted.len();
        let code = self.accept_bytes(true, 0, byte_length, offset, index);
        if code < 0 {
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
            created += u64::from(e.created)
                + u64::from(e.tex.created)
                + u64::from(e.mat.shaders_created)
                + u64::from(e.mat.materials_created)
                + e.meshes.iter().filter(|m| m.op == "create").count() as u64;
            freed += u64::from(e.freed)
                + u64::from(e.tex.freed)
                + u64::from(e.mat.shaders_freed)
                + u64::from(e.mat.materials_freed)
                + e.meshes.iter().filter(|m| m.op == "free").count() as u64;
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
                self.provide_cursor += 1;
                self.totals.provided += 1;
                self.totals.provided_bytes += len as u64;
                0
            }
            Err(e) => {
                self.error = fail(e);
                -1
            }
        }
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
        // applied.json evidence (no serialization here: `applied_json_parts` does it later).
        let state = v.state();
        self.evidence.push(TxEvidence {
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
            tex: std::mem::take(&mut a.account),
            mat: a.material_counts,
            meshes: std::mem::take(&mut a.meshes.uploads),
        });
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
        for &slot in &a.bindings_changed {
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
        0
    }

    /// Step 4: texture ops, dirty uploads, draws, blit.
    pub fn draw(&mut self) -> i32 {
        let (Some(a), Some(x)) = (self.applier.as_mut(), self.executor.as_mut()) else {
            self.error = "draw before start".into();
            return -1;
        };
        let mut result = x.execute(&a.list);
        if matches!(result, Err(ExecError::NeedsFullUpload))
            || x.context_state() == ContextState::Restored
        {
            a.context_restored(&self.payloads);
            self.totals.restores += 1;
            result = x.execute(&a.list);
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
                0
            }
            Err(e) => {
                self.error = format!("execute: {e:?}");
                -1
            }
        }
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
                "{{\"stream\":{},\"seq\":{},\"frame\":{},\"encoding\":\"{}\",\"record_sha256\":{},\"created\":{},\"freed\":{},\"commands_replayed\":{},\"msdf_commands\":{},\"mesh_commands\":{},\"resources\":{{\"created\":{},\"updated\":{},\"replaced\":{},\"freed\":{},\"upload_bytes\":{},\"canvases_created\":{},\"shaders_created\":{},\"shader_code_sets\":{},\"materials_created\":{},\"param_sets\":{},\"instance_param_sets\":{},\"meshes_created\":{},\"meshes_rebuilt\":{},\"surface_updates\":{},\"mesh_upload_bytes\":{}}}}}",
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
        }
        out.push_str("],\"uploads\":[");
        let mut first = true;
        for e in &self.evidence {
            for u in &e.tex.uploads {
                if !first {
                    out.push(',');
                }
                first = false;
                out.push_str(&format!(
                    "{{\"id\":{},\"hash\":{},\"op\":\"{}\",\"data_bytes\":{},\"stream\":{},\"seq\":{}}}",
                    u.id,
                    u.hash
                        .map(|h| format!("\"{}\"", h.to_hex()))
                        .unwrap_or_else(|| "null".into()),
                    u.op,
                    u.data_bytes,
                    e.stream,
                    e.seq
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
        out.push_str("]}");
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
        out.push('}');
        out
    }
}
