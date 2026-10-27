// GSW receiver perf (gate7-design.md Q5 "Evidence", Q12, D13, G7a): per drawn frame, the Q14c
// timers (`decode_us` = accept, `provide_us`, `apply_us`, `draw_us`, `total_us` one wall timer
// over all of them, the boundary included) and, after the frame, `evidence_hash_us` (D31's
// deferred record digest) and `payload_verify_us` (G7o2: the needed payloads' SHA-256 and decode
// in their fetch completion, between frames). GPU completion is a fence polled on later frames (`gpu_complete_ms`,
// measured, report-only); presentation is `unavailable` (D13). Written as
// `render-stream-receiver-perf/1`'s shape plus the browser keys when RS_RECEIVER_PERF_OUT is set,
// and `perf-timeline.jsonl` (one line per drawn frame) beside it.

export interface FrameSample {
  seq: number;
  frame: number;
  t_ms: number;
  decode_us: number;
  provide_us: number;
  /** G7s: transpiling and compiling the custom shaders this transaction named first (once per
   * code hash), library reads included */
  program_us: number;
  apply_us: number;
  draw_us: number;
  total_us: number;
  evidence_hash_us: number;
  /** G7o2: verifying and decoding this transaction's payloads as they arrived (`stage_payload`),
   * outside total_us */
  payload_verify_us: number;
  structural: number;
  /** items whose content was lowered again (their commands changed) */
  relowered: number;
  /** item rows the applier rewrote */
  rows_written: number;
  executed_calls: number;
  texture_upload_bytes: number;
  item_bytes: number;
  vertex_bytes: number;
  /** G7l live (Q9 `credit-from-paced-loop`): the connection, the rAF callback that applied and
   * drew this transaction (its index and timestamp), and when its acks were sent (ms,
   * performance.now(); `submitted_ack_ms` null when no submitted ack was sent from this callback). */
  stream?: number;
  raf?: number;
  raf_ts_ms?: number;
  applied_ack_ms?: number;
  submitted_ack_ms?: number | null;
  submitted_from?: "raf" | "onmessage" | null;
}

function hist(values: number[]): Record<string, number> {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) =>
    s.length === 0
      ? 0
      : s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  const sum = s.reduce((n, v) => n + v, 0);
  return {
    count: s.length,
    sum: Math.round(sum),
    min: s.length ? s[0] : 0,
    max: s.length ? s[s.length - 1] : 0,
    mean: s.length ? sum / s.length : 0,
    p50: q(0.5),
    p95: q(0.95),
  };
}

/** G7o2: lib.rs `payload_verify_json` (`payload-verified-before-use`). */
export interface PayloadVerify {
  staged: number;
  refused: number;
  provided_staged: number;
  provided_in_frame: number;
  unverified_used: number;
  still_staged: number;
}

export class Perf {
  readonly samples: FrameSample[] = [];
  readonly rafIntervals: number[] = [];
  readonly gpuComplete: number[] = [];
  readonly fetchUs: number[] = [];
  /** D13: the next rAF timestamp after each submitted ack, minus the ack's time (µs). */
  readonly rafAfterSubmitUs: number[] = [];
  /** G7r: once a second, the paced loop's cumulative callbacks (`frames`) and drawn frames.
   * G7k adds the residency snapshot that second (null fields: not yet started / not sampled),
   * in the native receiver's own perf.json shape (gate6s-checks.ts `ReceiverTimelineLine`) so
   * its residencyMetrics/checkResidencyBounded/checkCacheBudgetRespected run on a GSW leg
   * unchanged: `cache_entries_disk`/`cache_bytes_disk` are always 0 (GSW has no disk tier), and
   * `live_rids` is `GswRs::residency_json()`'s `resident_*` fields in that shape. */
  readonly timelineLines: {
    t_us: number;
    frames: number;
    drawn: number;
    cache_entries_memory: number | null;
    cache_bytes_memory: number | null;
    cache_entries_disk: number;
    cache_bytes_disk: number;
    /** G7k (D29 amendment): `cache_bytes_memory` is the store's payload bytes in wasm memory plus
     * the resident textures' GL bytes (`gl_texture_bytes`, also reported alone); the floor is
     * what a budget can never go below (referenced store bytes plus the GL bytes). */
    gl_texture_bytes: number | null;
    memory_floor_bytes: number | null;
    /** `memory.buffer.byteLength` of the GSW wasm (never shrinks), beside the JS heap the
     * browser-side sampler reads. */
    wasm_heap_bytes: number | null;
    live_rids: {
      items: number;
      textures: number;
      meshes: number;
      shaders: number;
      materials: number;
    } | null;
    /** Sabotage `leak-gl-textures` only (gate7-design.md Q10, not part of the native shape):
     * real WebGL textures leaked on a throwaway context, never drawn with (gl-leak.ts). 0
     * otherwise, never null, so a soak checker can add it to `live_rids.textures` for one "GL
     * textures" number that is flat honestly and grows under the sabotage. */
    leaked_gl_textures: number;
    /** W11c: at /11, `GswRs::residency_json()`'s retention keys (dynamic bodies held, |names|,
     * |C|, entries the rule released); absent below /11. */
    w11?: Record<string, number>;
  }[] = [];
  private lastSubmitMs = -1;
  private nextTimelineMs = -1;
  /** G7s: item-space programs defined, shaders refused, library reads. */
  readonly programs = { defined: 0, refused: 0, library_reads: 0 };
  /** G7o2: set before the evidence is written. */
  payloadVerify: PayloadVerify | null = null;
  /** G7k (Q10 soak): the `PayloadStore`'s cumulative eviction count and configured budget at
   * the last sample (live mode only; null when no residency sample was ever taken). Set by the
   * caller from `GswRs::residency_json()` beside each `sampleTimeline` call, not computed here. */
  residencyEvictions: number | null = null;
  residencyBudgetBytes: number | null = null;
  private lastRaf = -1;

  raf(ts: number): void {
    if (this.lastRaf >= 0) this.rafIntervals.push((ts - this.lastRaf) * 1000);
    this.lastRaf = ts;
  }

  submitted(atMs: number): void {
    this.lastSubmitMs = atMs;
  }

  rafAfterSubmit(ts: number): void {
    if (this.lastSubmitMs < 0) return;
    this.rafAfterSubmitUs.push(Math.max(0, (ts - this.lastSubmitMs) * 1000));
    this.lastSubmitMs = -1;
  }

  /** `residency`, when given, is called only on the once-a-second tick (never every rAF), since
   * it reads across the wasm boundary (`GswRs::residency_json`) and the leaked-texture count. */
  sampleTimeline(
    frames: number,
    drawn: number,
    residency?: () => {
      cache_entries_memory: number;
      cache_bytes_memory: number;
      gl_texture_bytes: number;
      memory_floor_bytes: number;
      wasm_heap_bytes: number | null;
      resident_items: number;
      resident_textures: number;
      resident_meshes: number;
      resident_shaders: number;
      resident_materials: number;
      leaked_gl_textures: number;
      w11?: Record<string, number>;
    },
  ): void {
    const now = performance.now();
    if (this.nextTimelineMs >= 0 && now < this.nextTimelineMs) return;
    // Anchored at the old deadline, so the lines stay a second apart however late a callback is.
    this.nextTimelineMs =
      this.nextTimelineMs < 0 ? now + 1000 : this.nextTimelineMs + 1000;
    if (this.nextTimelineMs < now) this.nextTimelineMs = now + 1000;
    const r = residency?.() ?? null;
    this.timelineLines.push({
      t_us: Math.round(now * 1000),
      frames,
      drawn,
      cache_entries_memory: r?.cache_entries_memory ?? null,
      cache_bytes_memory: r?.cache_bytes_memory ?? null,
      cache_entries_disk: 0,
      cache_bytes_disk: 0,
      gl_texture_bytes: r?.gl_texture_bytes ?? null,
      memory_floor_bytes: r?.memory_floor_bytes ?? null,
      wasm_heap_bytes: r?.wasm_heap_bytes ?? null,
      live_rids: r
        ? {
            items: r.resident_items,
            textures: r.resident_textures,
            meshes: r.resident_meshes,
            shaders: r.resident_shaders,
            materials: r.resident_materials,
          }
        : null,
      leaked_gl_textures: r?.leaked_gl_textures ?? 0,
      ...(r?.w11 ? { w11: r.w11 } : {}),
    });
  }

  report(extra: Record<string, unknown>): Record<string, unknown> {
    const pick = (k: keyof FrameSample) =>
      this.samples.map((s) => s[k] as number);
    return {
      schema: "render-stream-receiver-perf/1",
      receiver: "gsw-canvas",
      histograms: {
        decode_us: hist(pick("decode_us")),
        provide_us: hist(pick("provide_us")),
        program_us: hist(pick("program_us")),
        apply_us: hist(pick("apply_us")),
        draw_us: hist(pick("draw_us")),
        total_us: hist(pick("total_us")),
        evidence_hash_us: hist(pick("evidence_hash_us")),
        payload_verify_us: hist(pick("payload_verify_us")),
        fetch_us: hist(this.fetchUs),
        frame_interval_us: hist(this.rafIntervals),
        gpu_complete_us: hist(this.gpuComplete.map((ms) => ms * 1000)),
        raf_after_submit_us: hist(this.rafAfterSubmitUs),
      },
      unavailable_stages: [
        {
          stage: "presented",
          reason:
            "no web API reports when a canvas frame was presented (gate7-design.md D13)",
        },
        {
          stage: "gpu_render_us",
          reason:
            "EXT_disjoint_timer_query_webgl2 is not used; gpu_complete_us is a fence polled on later frames",
        },
      ],
      render_time: {
        cpu_render_ms: { status: "unavailable", value: null },
        gpu_render_ms: { status: "unavailable", value: null },
      },
      counts: { drawn_frames: this.samples.length, programs: this.programs },
      payload_verify: this.payloadVerify,
      residency: {
        evictions: this.residencyEvictions,
        budget_bytes: this.residencyBudgetBytes,
      },
      timeline: this.timelineLines,
      ...extra,
    };
  }

  timeline(): string {
    return `${this.samples.map((s) => JSON.stringify(s)).join("\n")}\n`;
  }
}
