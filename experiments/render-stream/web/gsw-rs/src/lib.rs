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
use render_stream_core::apply::geom;
use render_stream_core::apply::payloads::{needed, PayloadStore};
use render_stream_core::apply::{Applier, Viewport};
use render_stream_core::state::Hash;
use render_stream_core::validate::{Accepted, DigestPolicy, Options, Validator};
use render_stream_core::wire::{self, RecordSpan};
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
}

#[derive(Clone, Copy, Default)]
struct Opts {
    digest_inline: bool,
    skip_payload_hash: bool,
    digest_skip: bool,
    format_rgba8: bool,
    exec: ExecOptions,
}

fn parse_options(json: &str) -> Result<Opts, String> {
    // A flat, caller-written object: {"digest":"inline"|"deferred","sabotage":[...],"format":...}.
    let mut o = Opts {
        digest_inline: json.contains("\"digest\":\"inline\""),
        ..Opts::default()
    };
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
        })
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
            self.error = "bad-magic: not a render-stream/2..6 recording".into();
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
            digest: if self.opts.digest_inline {
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
        let global = if size == vp.logical_size {
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
        self.applier = Some(Applier::new(viewport));
        self.validator = Some(v);
        self.accepted.push(0);
        self.stats.accepted_records = 1;
        Ok(())
    }

    /// Step 2: decode, validate and resolve record `index`. Returns `ACCEPT_*`, or -1 (`error`).
    pub fn accept(&mut self, index: usize) -> i32 {
        let Some(v) = self.validator.as_mut() else {
            self.error = "accept before start".into();
            return -1;
        };
        let Some(span) = self.spans.get(index).copied() else {
            self.error = format!("no record {index}");
            return -1;
        };
        let accepted = match v.accept(span.bytes(&self.data), span.offset) {
            Ok(a) => a,
            Err(e) => {
                self.error = fail(e);
                return -1;
            }
        };
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
                let st = v.state();
                self.stats.seq = st.seq as u32;
                self.stats.frame = st.frame as u32;
                needed(
                    st,
                    v.delta(),
                    self.first_tx,
                    &self.payloads,
                    &mut self.needed,
                );
                self.provide_cursor = 0;
                self.stats.needed = self.needed.len() as u32;
                if self.needed.is_empty() {
                    ACCEPT_TRANSACTION
                } else {
                    self.needed_bytes.clear();
                    for h in &self.needed {
                        self.needed_bytes.extend_from_slice(&h.0);
                    }
                    ACCEPT_NEEDS_PAYLOADS
                }
            }
        }
    }

    pub fn needed_count(&self) -> u32 {
        self.needed.len() as u32
    }

    pub fn needed_ptr(&self) -> *const u8 {
        self.needed_bytes.as_ptr()
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
        let st = a.apply(v.state(), v.delta(), &self.payloads);
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
