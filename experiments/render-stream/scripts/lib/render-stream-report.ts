// render-stream-report/1: the measured-cost report schema (D10, Q7f of
// ../../protocol/gate6-design.md), its validator and its cross-repeat aggregator.
//
// This is new: nothing else in the repository defines it (D10), and it is never the same document
// as perf-report/1 (../../../../docs/perf-report-contract.md), which is a different,
// browser-specific contract this file must not touch. The gate's own pass/fail result stays
// render-stream-gate6-report/1, written by check-gate6.ts (another increment); this module only
// knows the measured-cost envelope.
//
// `validate()` collects every problem it finds and returns them as `"<code>: <detail>"` strings
// (unlike the wire decoders in render-stream-0.ts/render-stream-2.ts, which stop at the first
// flaw because a corrupt byte stream cannot be parsed further -- a JSON report has no such
// constraint, and a caller fixing a fabricated report wants the whole list). `[]` means valid.
//
// `aggregate()` is the single source of truth for the scenario-level `aggregate` block: both
// `report-gate6.ts build` and `validate()` call it, so a report built by this module always
// round-trips, and a report that disagrees with a fresh recomputation (hand-edited, or built by
// something else) is the `aggregate-mismatch` error below.
//
// Two judgment calls the contract leaves open, recorded here rather than silently assumed:
//
// 1. `memory` fields (D9: "host and receiver memory come from /proc, never from engine memory
//    counters") carry no `status`/`source` wrapper, unlike <rate> and <dist>. That absence IS the
//    schema-visible form of the rule: /proc is always readable, so there is no "unavailable"
//    case to encode. `validate()` therefore just requires every `memory` leaf to be a finite
//    number, never a status enum.
// 2. "`recv_gpu_render_ms` is `measured` only for a rendered desktop-GL receiver" (D9, Q1g
//    `is_gles_over_gl()`) has no boolean flag in the committed provenance shape to key off. This
//    reads it from `provenance.receiver`: `rendering_method === "gl_compatibility"` (the existing
//    session-level field name, protocol/render-stream-1.md) AND a non-empty `adapter.name` that
//    does not look like a headless placeholder. A real "is this receiver headless" flag would
//    remove this guesswork; flagged for whichever increment finalizes receiver provenance.

// ------------------------------------------------------------------------------------------- types

export const RENDER_STREAM_REPORT_SCHEMA = "render-stream-report/1";
/** G7p (gate7-design.md Q12): /1 plus the browser and device fields below. `validate()` accepts
 * both; a /2 report is judged by the extra rules in `validateV2`. */
export const RENDER_STREAM_REPORT_2_SCHEMA = "render-stream-report/2";

export type Arm = "unarmed" | "armed-idle" | "streaming";
export type MeasuredStatus = "measured" | "unavailable" | "not-applicable";
export type CacheState = "cold" | "warm";
export type TransportKind = "loopback" | "constrained";
export type TimeMode = "realtime" | "steps";

export interface ReportRun {
  id: string;
  started_utc: string;
  runner: string;
  args: string[];
  git: { commit: string; dirty: boolean };
}

export interface ReportProvenance {
  engine: { version_string: string; sha256: string; template: "linux_release" };
  capture: {
    library_sha256: string;
    calibrator_version: number;
    hooks_planned: number;
  };
  receiver: {
    project_sha256: string;
    rendering_method: string;
    adapter: { vendor: string; name: string; api_version: string };
    /** report/2 (Q12): which receiver this report measures; `browser` and `bundle` are null for
     * the native receiver. */
    kind?: ReceiverKind;
    browser?: {
      product: string;
      version: string;
      revision: string;
      sha256: string;
      args: string[];
      renderer: string;
      extensions_hash: string;
    } | null;
    bundle?: { sha256: string; bytes: number } | null;
  };
  /** report/2: desktop or device (Q12). */
  env?: ReportEnv;
  protocol: string;
  host: {
    cpu_model: string;
    logical_cpus: number;
    ram_bytes: number;
    kernel: string;
    cpu_governor: string | null;
  };
  display: {
    compositor: "gamescope";
    version: string;
    sizes: [number, number][];
  };
  timing: {
    host_clock: "steady_clock";
    receiver_clock: "Time.get_ticks_usec" | "performance.now";
    rates_clock: "host";
    screenshots: "outside-measured-window";
    hook_log: "off" | "on";
  };
}

/** <rate> */
export interface ReportRate {
  value: number | null;
  unit: "1/s";
  status: MeasuredStatus;
  source: string | null;
  reason: string | null;
}

/** <dist> */
export interface ReportDist {
  status: MeasuredStatus;
  unit: string;
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  source: string | null;
}

export type RateName =
  | "requested"
  | "host_frame"
  | "published"
  | "received"
  | "applied"
  | "submitted"
  | "receiver_frame"
  | "presented";

export const RATE_NAMES: readonly RateName[] = [
  "requested",
  "host_frame",
  "published",
  "received",
  "applied",
  "submitted",
  "receiver_frame",
  "presented",
];

export interface ReportRepeat {
  run_dir: string;
  window_s: number;
  rates: Record<RateName, ReportRate>;
  stages: {
    host_frame_interval_us: ReportDist;
    host_callback_us: ReportDist;
    snapshot_us: ReportDist;
    diff_us: ReportDist;
    encode_us: ReportDist;
    enqueue_us: ReportDist;
    texture_copy_us: ReportDist;
    texture_hash_us: ReportDist;
    mesh_copy_us: ReportDist;
    mesh_hash_us: ReportDist;
    shader_copy_us: ReportDist;
    param_decode_us: ReportDist;
    http_serve_us: ReportDist;
    credit_rtt_us: { applied: ReportDist; submitted: ReportDist };
    staleness_us: { submitted: ReportDist };
    recv_decode_us: ReportDist;
    recv_apply_us: ReportDist;
    recv_upload_us: ReportDist;
    recv_fetch_us: ReportDist;
    recv_frame_interval_us: ReportDist;
    recv_gpu_render_ms: ReportDist;
    /** report/2 (Q12) */
    recv_raf_interval_us?: ReportDist;
    recv_raf_after_submit_us?: ReportDist;
    recv_gpu_complete_us?: ReportDist;
    recv_hold_us?: ReportDist;
    recv_preflight_us?: ReportDist;
  };
  /** report/2: one <dist> per D15 mark, or null where no startup leg ran for the repeat. */
  startup?: Record<string, unknown> | null;
  cpu: {
    host_main_thread_s: number;
    host_io_thread_s: number;
    host_process_s: number;
    receiver_process_s: number;
  };
  queues: {
    max_in_flight: number;
    max_pending: number;
    pending_episodes: number;
    max_pending_age_us: number;
    coalesced: number;
    ticks_credit_blocked: number;
    max_queued_bytes: number;
  };
  bytes: {
    transaction: ReportDist;
    wire_bytes_per_s: number;
    resource_bytes: number;
    http_bytes: number;
    fetches: number;
  };
  resources: {
    host_retained_max: number;
    host_retained_bytes_max: number;
    host_pins_max: number;
    recv_cache_entries_max: number;
    recv_cache_bytes_max: number;
    recv_evictions: number;
    recv_rids_max: number;
    recv_texture_mem_max: number;
    recv_video_mem_max: number;
    recv_pipeline_compilations: number;
  };
  memory: {
    host_rss_start: number;
    host_rss_end: number;
    host_rss_slope_bytes_per_min: number;
    host_vmhwm: number;
    recv_rss_start: number;
    recv_rss_end: number;
    recv_rss_slope_bytes_per_min: number;
    recv_vmhwm: number;
  };
}

export interface ReportAggregateEntry {
  median: number;
  min: number;
  max: number;
  cov: number;
}

export type ReportAggregate = Record<string, ReportAggregateEntry>;

export interface ReportScenario {
  id: string;
  fixture: string;
  variant: string;
  arm: Arm;
  resolution: { logical: [number, number]; presentation: [number, number] };
  profile: {
    rendering_method: string;
    msaa_2d: number;
    hdr_2d: boolean;
    stretch: { mode: string; aspect: string; scale_mode: string };
    font_oversampling: number;
  };
  config: {
    target_fps: number | null;
    host_max_fps: number;
    receiver_max_fps: number;
    credit_stage: string;
    transport: TransportKind;
    cache: CacheState | "warm-http";
    delivery: string;
    connections: number;
    time: TimeMode;
    /** report/2 (Q12) */
    receiver_kind?: ReceiverKind;
    credit_window?: 1 | 2;
    late_poll?: boolean;
    fetch_concurrency?: number;
  };
  /** null only in a single-repeat functional report (`validate(…, {repeats: 1})`, G6c) */
  warmup: { run_dir: string; discarded: true } | null;
  repeats: ReportRepeat[];
  /** null only in a single-repeat functional report: one repeat is validated, not aggregated */
  aggregate: ReportAggregate | null;
}

/** D15; the shape `scripts/analyze-deltas.ts` produces. Optional until G6p computes it for real:
 * a report built before then carries `null` and `validate()` accepts that.
 *
 * Deliberately does not fabricate a byte baseline the hook log cannot support: a mesh's
 * `MeshSurfaceCopy` (capture/src/rs_resource_log.h) carries `vertex_count`/`index_count`, never a
 * byte size, so `whole_version_bytes_total` is `null`/`whole_version_bytes_available: false` for
 * resources where no op ever logged a `payload_bytes`, rather than reverse-engineering one from
 * the format bitfield. `savings_bytes` is therefore only ever non-null when both the whole-version
 * and delta totals are available for that kind (true for `texture`, where delta == whole since
 * this engine's hook log has no partial texture update path; `savings_bytes` there is always 0). */
export interface ReportOptimizations {
  schema: "render-stream-deltas/1";
  by_kind: Record<
    string,
    {
      resources: number;
      version_creating_ops: number;
      superseded_versions: number;
      superseded_payload_bytes: number;
      superseded_hash_ns: number;
      superseded_copy_ns: number;
      whole_version_bytes_total: number | null;
      whole_version_bytes_available: boolean;
      delta_bytes_total: number;
      delta_bytes_available: boolean;
      savings_bytes: number | null;
    }
  >;
  param_bytes_per_frame: {
    unit: "bytes" | "elements" | "mixed";
    frames: number;
    total: number;
    mean_per_frame: number;
  };
}

export interface RenderStreamReport {
  schema: "render-stream-report/1" | "render-stream-report/2";
  /** report/2: the phone's rows (Q12 device rows), each with its desktop control row. */
  device_rows?: DeviceRow[];
  /** report/2: rows left out because their build is not the report's (D28), and why. */
  omitted_device_rows?: OmittedDeviceRow[];
  run: ReportRun;
  provenance: ReportProvenance;
  scenarios: ReportScenario[];
  optimizations: ReportOptimizations | null;
}


// ------------------------------------------------------------------------------- report/2 types

export type ReceiverKind = "native" | "web-export" | "gsw-canvas";
export const BROWSER_KINDS: readonly ReceiverKind[] = [
  "web-export",
  "gsw-canvas",
];

/** Q12 `provenance.env`. `device` is perf-report/1's `env.device` block as device.ts produces it
 * (docs/perf-report-contract.md), copied and not generalized (D17). */
export interface ReportEnv {
  kind: "desktop" | "device";
  device_id: "g31" | "g86" | null;
  device: Record<string, unknown> | null;
  panel: {
    raf_interval_p50_us: number;
    mode_hz: number;
    mode_source: string;
  } | null;
}

/** One device repeat (Q12 `repeats[].stages` and `repeats[].device` for a phone; the stage names
 * are Q12's). A repeat that fails Q13b's watchdog carries `invalid` and is never averaged in. */
export interface DeviceRowRepeat {
  run: number;
  stages: Record<string, unknown>;
  phase_class: string | null;
  device: Record<string, unknown>;
  startup: Record<string, unknown> | null;
  invalid?: { reason: string };
}

/** One device row: a phone's repeats of one workload at one window on one receiver, with its
 * desktop control row beside it. `build.bundle_sha256` is `RS_RECEIVER_BUILD_SHA256`, the bundle
 * the legs ran; it must equal the report's `provenance.receiver.bundle.sha256` (D28). */
export interface DeviceRow {
  device_id: "g31" | "g86";
  receiver_kind: "web-export" | "gsw-canvas";
  credit_window: 1 | 2;
  workload: string;
  env: ReportEnv;
  build: { bundle_sha256: string; source: string };
  repeats: DeviceRowRepeat[];
  summary: { valid_repeats: number; invalid_repeats: number; drawn_hz_mean: number | null };
  control: {
    env: ReportEnv;
    repeats: DeviceRowRepeat[];
  } | null;
}

/** A device row left out of the report, and why (D28: never shown as current). */
export interface OmittedDeviceRow {
  device_id: "g31" | "g86";
  receiver_kind: string;
  credit_window: number;
  workload: string;
  build_sha256: string | null;
  reason: string;
}

export function deviceRowSummary(
  repeats: readonly DeviceRowRepeat[],
): DeviceRow["summary"] {
  const valid = repeats.filter((r) => !r.invalid);
  const drawn = valid
    .map((r) => r.stages.drawn_hz)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return {
    valid_repeats: valid.length,
    invalid_repeats: repeats.length - valid.length,
    drawn_hz_mean:
      drawn.length === 0 ? null : drawn.reduce((a, b) => a + b, 0) / drawn.length,
  };
}

// ---------------------------------------------------------------------------------------- helpers

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ------------------------------------------------------------------------------------------ dist/rate

const DIST_PATHS: readonly string[] = [
  "host_frame_interval_us",
  "host_callback_us",
  "snapshot_us",
  "diff_us",
  "encode_us",
  "enqueue_us",
  "texture_copy_us",
  "texture_hash_us",
  "mesh_copy_us",
  "mesh_hash_us",
  "shader_copy_us",
  "param_decode_us",
  "http_serve_us",
  "credit_rtt_us.applied",
  "credit_rtt_us.submitted",
  "staleness_us.submitted",
  "recv_decode_us",
  "recv_apply_us",
  "recv_upload_us",
  "recv_fetch_us",
  "recv_frame_interval_us",
  "recv_gpu_render_ms",
];

function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function validateRate(
  rate: unknown,
  where: string,
  errors: string[],
  requireUnavailable?: boolean,
): ReportRate | undefined {
  if (!isPlainObject(rate)) {
    errors.push(`rate-entry: ${where} is not an object`);
    return undefined;
  }
  const status = rate.status;
  if (
    status !== "measured" &&
    status !== "unavailable" &&
    status !== "not-applicable"
  ) {
    errors.push(`rate-entry: ${where}.status is ${JSON.stringify(status)}`);
  }
  if (rate.unit !== "1/s") {
    errors.push(
      `rate-entry: ${where}.unit is ${JSON.stringify(rate.unit)}, expected "1/s"`,
    );
  }
  if (rate.value !== null && !isFiniteNumber(rate.value)) {
    errors.push(`rate-entry: ${where}.value is ${JSON.stringify(rate.value)}`);
  }
  if (rate.value === null && status === "measured") {
    errors.push(`rate-entry: ${where}.value is null but status is "measured"`);
  }
  if (status === "measured" && !isNonEmptyString(rate.source)) {
    errors.push(`rate-entry: ${where} is "measured" but has no source`);
  }
  if (
    status !== "measured" &&
    rate.reason !== null &&
    !isNonEmptyString(rate.reason)
  ) {
    errors.push(
      `rate-entry: ${where}.reason is ${JSON.stringify(rate.reason)}`,
    );
  }
  if (requireUnavailable && status !== "unavailable") {
    errors.push(
      `rate-entry: ${where}.status is ${JSON.stringify(status)}, must be "unavailable"`,
    );
  }
  if (requireUnavailable && !isNonEmptyString(rate.reason)) {
    errors.push(`rate-entry: ${where} is "unavailable" but carries no reason`);
  }
  return rate as unknown as ReportRate;
}

function validateDist(
  dist: unknown,
  where: string,
  errors: string[],
  mustNotMeasure?: string,
): ReportDist | undefined {
  if (!isPlainObject(dist)) {
    errors.push(`dist-entry: ${where} is not an object`);
    return undefined;
  }
  const status = dist.status;
  if (
    status !== "measured" &&
    status !== "unavailable" &&
    status !== "not-applicable"
  ) {
    errors.push(`dist-entry: ${where}.status is ${JSON.stringify(status)}`);
  }
  for (const key of ["count", "min", "p50", "p95", "p99", "max", "mean"]) {
    if (status === "measured" && !isFiniteNumber(dist[key])) {
      errors.push(
        `dist-entry: ${where}.${key} is ${JSON.stringify(dist[key])} but status is "measured"`,
      );
    }
  }
  if (status === "measured" && !isNonEmptyString(dist.source)) {
    errors.push(`dist-entry: ${where} is "measured" but has no source`);
  }
  if (mustNotMeasure && status === "measured") {
    errors.push(`dist-entry: ${where} is "measured" but ${mustNotMeasure}`);
  }
  return dist as unknown as ReportDist;
}

// ---------------------------------------------------------------------------------------- validate

/** Is this receiver a rendered desktop-GL receiver (D9, Q1g), per the judgment call in the file
 * header? Exported so a caller with a real headless flag can bypass the heuristic. */
export function isRenderedDesktopGlReceiver(
  provenance: ReportProvenance,
): boolean {
  const r = provenance.receiver;
  return (
    r.rendering_method === "gl_compatibility" &&
    isNonEmptyString(r.adapter.name) &&
    !/dummy|headless|none/i.test(r.adapter.name)
  );
}

/** How many repeats each scenario must carry: Q7f's measured protocol (5, one discarded warmup,
 * an aggregate) or G6c's single functional repeat (1, `warmup` and `aggregate` both null: "every
 * g6c leg's measurements are also written as a render-stream-report/1 with one repeat (validated,
 * not aggregated)"). */
export interface ValidateOptions {
  repeats?: 1 | 5;
}

/** Schema plus internal-consistency checks (Q7f "Rules enforced by validate"). Returns every
 * problem found, each `"<code>: <detail>"`; `[]` means the report is valid. */
export function validate(input: unknown, opts: ValidateOptions = {}): string[] {
  const expectedRepeats = opts.repeats ?? 5;
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return ["report-entry: top level is not an object"];
  }
  const v2 = input.schema === RENDER_STREAM_REPORT_2_SCHEMA;
  if (input.schema !== RENDER_STREAM_REPORT_SCHEMA && !v2) {
    errors.push(
      `bad-schema: schema is ${JSON.stringify(input.schema)}, expected ${JSON.stringify(RENDER_STREAM_REPORT_SCHEMA)} or ${JSON.stringify(RENDER_STREAM_REPORT_2_SCHEMA)}`,
    );
  }
  if (!isPlainObject(input.run)) {
    errors.push("run-entry: run is missing or not an object");
  } else {
    const run = input.run;
    if (!isNonEmptyString(run.id)) errors.push("run-entry: run.id is missing");
    if (!isNonEmptyString(run.started_utc))
      errors.push("run-entry: run.started_utc is missing");
    if (!isNonEmptyString(run.runner))
      errors.push("run-entry: run.runner is missing");
    if (!Array.isArray(run.args))
      errors.push("run-entry: run.args is not an array");
    if (
      !isPlainObject(run.git) ||
      !isNonEmptyString(run.git.commit) ||
      typeof run.git.dirty !== "boolean"
    ) {
      errors.push("run-entry: run.git is not {commit, dirty}");
    }
  }

  let provenance: ReportProvenance | undefined;
  if (!isPlainObject(input.provenance)) {
    errors.push("provenance-entry: provenance is missing or not an object");
  } else {
    const p = input.provenance;
    if (
      !isPlainObject(p.engine) ||
      !isNonEmptyString(p.engine.sha256) ||
      p.engine.template !== "linux_release"
    ) {
      errors.push("provenance-entry: provenance.engine is malformed");
    }
    if (
      !isPlainObject(p.capture) ||
      !isNonEmptyString(p.capture.library_sha256) ||
      !isFiniteNumber(p.capture.calibrator_version)
    ) {
      errors.push("provenance-entry: provenance.capture is malformed");
    }
    if (
      !isPlainObject(p.receiver) ||
      !isNonEmptyString(p.receiver.project_sha256) ||
      !isNonEmptyString(p.receiver.rendering_method) ||
      !isPlainObject(p.receiver.adapter)
    ) {
      errors.push("provenance-entry: provenance.receiver is malformed");
    }
    if (!isNonEmptyString(p.protocol))
      errors.push("provenance-entry: provenance.protocol is missing");
    if (
      !isPlainObject(p.host) ||
      !isFiniteNumber(p.host.logical_cpus) ||
      !isFiniteNumber(p.host.ram_bytes)
    ) {
      errors.push("provenance-entry: provenance.host is malformed");
    }
    if (!isPlainObject(p.display) || p.display.compositor !== "gamescope") {
      errors.push("provenance-entry: provenance.display is malformed");
    }
    if (
      !isPlainObject(p.timing) ||
      (p.timing.hook_log !== "off" && p.timing.hook_log !== "on")
    ) {
      errors.push("provenance-entry: provenance.timing is malformed");
    }
    if (errors.every((e) => !e.startsWith("provenance-entry"))) {
      provenance = p as unknown as ReportProvenance;
    }
  }

  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0) {
    errors.push(
      "scenarios-entry: scenarios is missing, not an array, or empty",
    );
    return errors;
  }

  for (const raw of input.scenarios) {
    if (!isPlainObject(raw)) {
      errors.push("scenario-entry: a scenarios[] entry is not an object");
      continue;
    }
    const where = `scenario ${JSON.stringify(raw.id)}`;
    if (!isNonEmptyString(raw.id))
      errors.push(`scenario-entry: ${where}: id is missing`);
    if (
      raw.arm !== "unarmed" &&
      raw.arm !== "armed-idle" &&
      raw.arm !== "streaming"
    ) {
      errors.push(
        `scenario-entry: ${where}: arm is ${JSON.stringify(raw.arm)}`,
      );
    }
    if (expectedRepeats === 1) {
      if (raw.warmup !== null)
        errors.push(
          `scenario-entry: ${where}: a single-repeat report has no warmup (warmup must be null)`,
        );
      if (raw.aggregate !== null)
        errors.push(
          `aggregate-mismatch: ${where}: a single-repeat report is not aggregated (aggregate must be null)`,
        );
    } else if (!isPlainObject(raw.warmup) || raw.warmup.discarded !== true) {
      errors.push(`scenario-entry: ${where}: warmup.discarded must be true`);
    }
    if (!Array.isArray(raw.repeats) || raw.repeats.length !== expectedRepeats) {
      errors.push(
        `repeat-count: ${where}: ${Array.isArray(raw.repeats) ? raw.repeats.length : "none"} repeats, expected exactly ${expectedRepeats}`,
      );
      continue;
    }
    if (v2) validateScenarioV2(raw, where, errors);
    const repeats: ReportRepeat[] = [];
    let repeatOk = true;
    for (let i = 0; i < raw.repeats.length; i++) {
      const r = raw.repeats[i];
      const rWhere = `${where} repeat ${i}`;
      if (!isPlainObject(r)) {
        errors.push(`repeat-entry: ${rWhere} is not an object`);
        repeatOk = false;
        continue;
      }
      if (!isNonEmptyString(r.run_dir))
        errors.push(`repeat-entry: ${rWhere}.run_dir is missing`);
      if (!isFiniteNumber(r.window_s))
        errors.push(`repeat-entry: ${rWhere}.window_s is not a number`);

      if (!isPlainObject(r.rates)) {
        errors.push(`repeat-entry: ${rWhere}.rates is missing`);
        repeatOk = false;
      } else {
        for (const name of RATE_NAMES) {
          validateRate(
            r.rates[name],
            `${rWhere}.rates.${name}`,
            errors,
            name === "presented",
          );
        }
      }

      if (!isPlainObject(r.stages)) {
        errors.push(`repeat-entry: ${rWhere}.stages is missing`);
        repeatOk = false;
      } else {
        for (const path of DIST_PATHS) {
          const mustNotMeasure =
            path === "recv_gpu_render_ms" &&
            provenance &&
            (!isRenderedDesktopGlReceiver(provenance) ||
              (v2 && provenance.receiver.kind !== "native"))
              ? "the receiver is not a rendered desktop-GL receiver (D9)"
              : undefined;
          validateDist(
            getPath(r.stages, path),
            `${rWhere}.stages.${path}`,
            errors,
            mustNotMeasure,
          );
        }
      }

      if (!isPlainObject(r.cpu)) {
        errors.push(`repeat-entry: ${rWhere}.cpu is missing`);
      } else {
        for (const key of [
          "host_main_thread_s",
          "host_io_thread_s",
          "host_process_s",
          "receiver_process_s",
        ]) {
          if (!isFiniteNumber(r.cpu[key]))
            errors.push(`repeat-entry: ${rWhere}.cpu.${key} is not a number`);
        }
      }

      if (!isPlainObject(r.queues)) {
        errors.push(`repeat-entry: ${rWhere}.queues is missing`);
      } else {
        for (const key of [
          "max_in_flight",
          "max_pending",
          "pending_episodes",
          "max_pending_age_us",
          "coalesced",
          "ticks_credit_blocked",
          "max_queued_bytes",
        ]) {
          if (!isFiniteNumber(r.queues[key]))
            errors.push(
              `repeat-entry: ${rWhere}.queues.${key} is not a number`,
            );
        }
      }

      if (!isPlainObject(r.bytes)) {
        errors.push(`repeat-entry: ${rWhere}.bytes is missing`);
      } else {
        validateDist(
          r.bytes.transaction,
          `${rWhere}.bytes.transaction`,
          errors,
        );
        for (const key of [
          "wire_bytes_per_s",
          "resource_bytes",
          "http_bytes",
          "fetches",
        ]) {
          if (!isFiniteNumber(r.bytes[key]))
            errors.push(`repeat-entry: ${rWhere}.bytes.${key} is not a number`);
        }
      }

      if (!isPlainObject(r.resources)) {
        errors.push(`repeat-entry: ${rWhere}.resources is missing`);
      } else {
        for (const key of [
          "host_retained_max",
          "host_retained_bytes_max",
          "host_pins_max",
          "recv_cache_entries_max",
          "recv_cache_bytes_max",
          "recv_evictions",
          "recv_rids_max",
          "recv_texture_mem_max",
          "recv_video_mem_max",
          "recv_pipeline_compilations",
        ]) {
          if (!isFiniteNumber(r.resources[key]))
            errors.push(
              `repeat-entry: ${rWhere}.resources.${key} is not a number`,
            );
        }
      }

      // `memory`: plain finite numbers only, by design (D9, header note 1) -- never a status
      // wrapper, because it always comes from /proc.
      if (!isPlainObject(r.memory)) {
        errors.push(`memory-entry: ${rWhere}.memory is missing`);
      } else {
        for (const key of [
          "host_rss_start",
          "host_rss_end",
          "host_rss_slope_bytes_per_min",
          "host_vmhwm",
          "recv_rss_start",
          "recv_rss_end",
          "recv_rss_slope_bytes_per_min",
          "recv_vmhwm",
        ]) {
          if (!isFiniteNumber(r.memory[key])) {
            errors.push(
              `memory-entry: ${rWhere}.memory.${key} is ${JSON.stringify(r.memory[key])}, must be a finite number`,
            );
          }
        }
      }

      if (v2 && repeatOk) validateRepeatV2(r, rWhere, provenance, errors);
      if (repeatOk) repeats.push(r as unknown as ReportRepeat);
    }

    if (repeats.length === raw.repeats.length && repeats.length === 5) {
      const wantAgg = aggregate(repeats);
      const gotAgg = raw.aggregate;
      if (!isPlainObject(gotAgg)) {
        errors.push(`aggregate-mismatch: ${where}: aggregate is missing`);
      } else if (
        JSON.stringify(sortedAggregate(wantAgg)) !==
        JSON.stringify(sortedAggregate(gotAgg as ReportAggregate))
      ) {
        errors.push(
          `aggregate-mismatch: ${where}: aggregate does not match a fresh recomputation from repeats`,
        );
      }
    }
  }

  if (v2) validateTopV2(input, provenance, errors);

  if (input.optimizations !== null && !isPlainObject(input.optimizations)) {
    errors.push("optimizations-entry: optimizations must be an object or null");
  } else if (
    isPlainObject(input.optimizations) &&
    input.optimizations.schema !== "render-stream-deltas/1"
  ) {
    errors.push(
      `optimizations-entry: optimizations.schema is ${JSON.stringify(input.optimizations.schema)}`,
    );
  }

  return errors;
}

// ------------------------------------------------------------------------------------- validate /2

const STAGE_V2_DISTS: readonly string[] = [
  "recv_raf_interval_us",
  "recv_raf_after_submit_us",
  "recv_gpu_complete_us",
  "recv_hold_us",
  "recv_preflight_us",
];

function validateEnv(env: unknown, where: string, errors: string[]): void {
  if (!isPlainObject(env)) {
    errors.push(`env-entry: ${where} is not an object`);
    return;
  }
  if (env.kind !== "desktop" && env.kind !== "device")
    errors.push(`env-entry: ${where}.kind is ${JSON.stringify(env.kind)}`);
  if (env.kind === "desktop") {
    if (env.device_id !== null)
      errors.push(`env-entry: ${where} is desktop but has a device_id`);
    if (env.device !== null)
      errors.push(`env-entry: ${where} is desktop but has a device block`);
  }
  if (env.kind === "device") {
    if (env.device_id !== "g31" && env.device_id !== "g86")
      errors.push(
        `env-entry: ${where}.device_id is ${JSON.stringify(env.device_id)}, expected g31 or g86`,
      );
    const d = env.device;
    if (!isPlainObject(d)) {
      errors.push(`env-entry: ${where} is a device but env.device is missing`);
    } else {
      for (const key of ["model", "androidRelease", "chrome"])
        if (!isNonEmptyString(d[key]))
          errors.push(`env-entry: ${where}.device.${key} is missing`);
    }
  }
  if (env.panel !== null) {
    const p = env.panel;
    if (
      !isPlainObject(p) ||
      !isFiniteNumber(p.raf_interval_p50_us) ||
      !isFiniteNumber(p.mode_hz) ||
      !isNonEmptyString(p.mode_source)
    )
      errors.push(`env-entry: ${where}.panel is not {raf_interval_p50_us, mode_hz, mode_source} or null`);
  }
}

function validateScenarioV2(
  raw: Record<string, unknown>,
  where: string,
  errors: string[],
): void {
  const c = raw.config;
  if (!isPlainObject(c)) return; // /1 rules report a missing config themselves
  if (
    c.receiver_kind !== "native" &&
    c.receiver_kind !== "web-export" &&
    c.receiver_kind !== "gsw-canvas"
  )
    errors.push(
      `scenario-entry: ${where}: config.receiver_kind is ${JSON.stringify(c.receiver_kind)}`,
    );
  if (c.credit_window !== 1 && c.credit_window !== 2)
    errors.push(`scenario-entry: ${where}: config.credit_window is ${JSON.stringify(c.credit_window)}`);
  if (typeof c.late_poll !== "boolean")
    errors.push(`scenario-entry: ${where}: config.late_poll is not a boolean`);
  if (!isFiniteNumber(c.fetch_concurrency) || c.fetch_concurrency < 1)
    errors.push(`scenario-entry: ${where}: config.fetch_concurrency is not a positive number`);
  if (c.cache !== "cold" && c.cache !== "warm" && c.cache !== "warm-http")
    errors.push(`scenario-entry: ${where}: config.cache is ${JSON.stringify(c.cache)}`);
  if (c.cache === "warm-http" && c.receiver_kind === "native")
    errors.push(`scenario-entry: ${where}: warm-http is a browser cache state`);
}

function validateRepeatV2(
  r: Record<string, unknown>,
  where: string,
  provenance: ReportProvenance | undefined,
  errors: string[],
): void {
  const stages = r.stages as Record<string, unknown>;
  const kind = provenance?.receiver?.kind;
  for (const key of STAGE_V2_DISTS) {
    if (stages[key] === undefined) {
      errors.push(`repeat-entry: ${where}.stages.${key} is missing (report/2)`);
      continue;
    }
    // recv_gpu_complete_us is measured only for gsw-canvas (Q12 rules).
    const mustNot =
      key === "recv_gpu_complete_us" && kind !== undefined && kind !== "gsw-canvas"
        ? `the receiver is ${kind}, and a gpu_complete fence exists only for gsw-canvas`
        : undefined;
    validateDist(stages[key], `${where}.stages.${key}`, errors, mustNot);
  }
  if (r.startup !== null && r.startup !== undefined && !isPlainObject(r.startup))
    errors.push(`repeat-entry: ${where}.startup is not an object or null`);
}

function validateTopV2(
  input: Record<string, unknown>,
  provenance: ReportProvenance | undefined,
  errors: string[],
): void {
  const p = isPlainObject(input.provenance) ? input.provenance : undefined;
  if (!p) return;
  validateEnv(p.env, "provenance.env", errors);
  const r = isPlainObject(p.receiver) ? p.receiver : undefined;
  const kind = r?.kind;
  if (kind !== "native" && kind !== "web-export" && kind !== "gsw-canvas")
    errors.push(
      `provenance-entry: provenance.receiver.kind is ${JSON.stringify(kind)}`,
    );
  if (r && kind === "native") {
    if (r.browser !== null || r.bundle !== null)
      errors.push("provenance-entry: a native receiver has browser: null and bundle: null");
  } else if (r && (kind === "web-export" || kind === "gsw-canvas")) {
    const b = r.browser;
    if (
      !isPlainObject(b) ||
      !isNonEmptyString(b.product) ||
      !isNonEmptyString(b.version) ||
      !isNonEmptyString(b.revision) ||
      !isNonEmptyString(b.sha256) ||
      !Array.isArray(b.args) ||
      !isNonEmptyString(b.renderer) ||
      !isNonEmptyString(b.extensions_hash)
    )
      errors.push("provenance-entry: provenance.receiver.browser is not {product, version, revision, sha256, args, renderer, extensions_hash}");
    const bu = r.bundle;
    if (!isPlainObject(bu) || !isNonEmptyString(bu.sha256) || !isFiniteNumber(bu.bytes))
      errors.push("provenance-entry: provenance.receiver.bundle is not {sha256, bytes}");
  }
  const t = isPlainObject(p.timing) ? p.timing : undefined;
  if (t) {
    const want =
      kind === "web-export" || kind === "gsw-canvas"
        ? "performance.now"
        : "Time.get_ticks_usec";
    if (t.receiver_clock !== want)
      errors.push(
        `provenance-entry: provenance.timing.receiver_clock is ${JSON.stringify(t.receiver_clock)}, expected ${JSON.stringify(want)} for ${String(kind)}`,
      );
  }
  const rows = input.device_rows;
  if (!Array.isArray(rows)) {
    errors.push("device-rows-entry: device_rows is not an array (report/2)");
  } else {
    rows.forEach((row, i) => {
      validateDeviceRow(row, `device_rows[${i}]`, provenance, errors);
    });
  }
  if (!Array.isArray(input.omitted_device_rows)) {
    errors.push("device-rows-entry: omitted_device_rows is not an array (report/2)");
  } else {
    input.omitted_device_rows.forEach((o, i) => {
      if (
        !isPlainObject(o) ||
        !isNonEmptyString(o.device_id) ||
        !isNonEmptyString(o.reason)
      )
        errors.push(`device-rows-entry: omitted_device_rows[${i}] has no device_id and reason`);
    });
  }
}

function validateDeviceRow(
  row: unknown,
  where: string,
  provenance: ReportProvenance | undefined,
  errors: string[],
): void {
  if (!isPlainObject(row)) {
    errors.push(`device-rows-entry: ${where} is not an object`);
    return;
  }
  if (row.device_id !== "g31" && row.device_id !== "g86")
    errors.push(`device-rows-entry: ${where}.device_id is ${JSON.stringify(row.device_id)}`);
  validateEnv(row.env, `${where}.env`, errors);
  if (isPlainObject(row.env)) {
    if (row.env.kind !== "device")
      errors.push(`device-rows-entry: ${where}.env.kind is not "device"`);
    if (row.env.device_id !== row.device_id)
      errors.push(`device-rows-entry: ${where}.env.device_id differs from device_id`);
  }
  if (!isPlainObject(row.build) || !isNonEmptyString(row.build.bundle_sha256))
    errors.push(`device-rows-entry: ${where}.build.bundle_sha256 is missing`);
  else {
    const want = (provenance?.receiver as { bundle?: { sha256?: string } } | undefined)?.bundle?.sha256;
    if (want !== undefined && row.build.bundle_sha256 !== want)
      errors.push(
        `stale-build: ${where} ran bundle ${row.build.bundle_sha256.slice(0, 12)}, the report's is ${want.slice(0, 12)} (D28: an older build's row is omitted and named, not shown as current)`,
      );
  }
  const repeats = row.repeats;
  if (!Array.isArray(repeats) || repeats.length === 0) {
    errors.push(`device-rows-entry: ${where}.repeats is empty`);
    return;
  }
  for (const [i, rep] of repeats.entries()) {
    if (!isPlainObject(rep) || !isPlainObject(rep.stages) || !isPlainObject(rep.device)) {
      errors.push(`device-rows-entry: ${where}.repeats[${i}] has no stages and device`);
      continue;
    }
    if (rep.invalid !== undefined && !(isPlainObject(rep.invalid) && isNonEmptyString(rep.invalid.reason)))
      errors.push(`device-rows-entry: ${where}.repeats[${i}].invalid has no reason`);
    if (rep.stages.presented !== undefined && rep.stages.presented !== "unavailable")
      errors.push(`device-rows-entry: ${where}.repeats[${i}] reports presented (it is unavailable for every receiver, Q12)`);
  }
  const want = deviceRowSummary(repeats as DeviceRowRepeat[]);
  if (JSON.stringify(row.summary) !== JSON.stringify(want))
    errors.push(
      `invalid-averaged: ${where}.summary is ${JSON.stringify(row.summary)}, a recomputation over its valid repeats gives ${JSON.stringify(want)} (an invalid repeat is never averaged in)`,
    );
  if (row.control !== null) {
    if (!isPlainObject(row.control) || !Array.isArray(row.control.repeats) || row.control.repeats.length === 0)
      errors.push(`device-rows-entry: ${where}.control has no repeats`);
    else {
      validateEnv(row.control.env, `${where}.control.env`, errors);
      if (isPlainObject(row.control.env) && row.control.env.kind !== "desktop")
        errors.push(`device-rows-entry: ${where}.control.env.kind is not "desktop"`);
    }
  }
}

function sortedAggregate(
  agg: ReportAggregate,
): [string, ReportAggregateEntry][] {
  return Object.entries(agg).sort(([a], [b]) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------------------- aggregate

interface MetricExtractor {
  path: string;
  extract: (r: ReportRepeat) => number | null;
}

function distExtractor(path: string): MetricExtractor {
  return {
    path: `stages.${path}.p50`,
    extract: (r) => {
      const d = getPath(r.stages as unknown as Record<string, unknown>, path) as
        | ReportDist
        | undefined;
      return d && d.status === "measured" ? d.p50 : null;
    },
  };
}

function rateExtractor(name: RateName): MetricExtractor {
  return {
    path: `rates.${name}.value`,
    extract: (r) => {
      const rate = r.rates[name];
      return rate && rate.status === "measured" ? rate.value : null;
    },
  };
}

function scalarExtractor(
  group: "cpu" | "queues" | "resources" | "memory",
  key: string,
): MetricExtractor {
  return {
    path: `${group}.${key}`,
    extract: (r) => {
      const v = (r[group] as unknown as Record<string, number>)[key];
      return isFiniteNumber(v) ? v : null;
    },
  };
}

const AGGREGATE_METRICS: readonly MetricExtractor[] = [
  ...RATE_NAMES.map(rateExtractor),
  ...DIST_PATHS.map(distExtractor),
  ...STAGE_V2_DISTS.map(distExtractor),
  {
    path: "bytes.transaction.p50",
    extract: (r) =>
      r.bytes.transaction.status === "measured"
        ? r.bytes.transaction.p50
        : null,
  },
  ...(
    ["wire_bytes_per_s", "resource_bytes", "http_bytes", "fetches"] as const
  ).map((k) => ({
    path: `bytes.${k}`,
    extract: (r: ReportRepeat) =>
      isFiniteNumber(r.bytes[k]) ? r.bytes[k] : null,
  })),
  ...(
    [
      "host_main_thread_s",
      "host_io_thread_s",
      "host_process_s",
      "receiver_process_s",
    ] as const
  ).map((k) => scalarExtractor("cpu", k)),
  ...(
    [
      "max_in_flight",
      "max_pending",
      "pending_episodes",
      "max_pending_age_us",
      "coalesced",
      "ticks_credit_blocked",
      "max_queued_bytes",
    ] as const
  ).map((k) => scalarExtractor("queues", k)),
  ...(
    [
      "host_retained_max",
      "host_retained_bytes_max",
      "host_pins_max",
      "recv_cache_entries_max",
      "recv_cache_bytes_max",
      "recv_evictions",
      "recv_rids_max",
      "recv_texture_mem_max",
      "recv_video_mem_max",
      "recv_pipeline_compilations",
    ] as const
  ).map((k) => scalarExtractor("resources", k)),
  ...(
    [
      "host_rss_start",
      "host_rss_end",
      "host_rss_slope_bytes_per_min",
      "host_vmhwm",
      "recv_rss_start",
      "recv_rss_end",
      "recv_rss_slope_bytes_per_min",
      "recv_vmhwm",
    ] as const
  ).map((k) => scalarExtractor("memory", k)),
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Sample standard deviation (n-1) over mean; 0 when the mean is 0. */
function coefficientOfVariation(values: number[]): number {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 0;
  const variance =
    values.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n - 1);
  return Math.sqrt(variance) / Math.abs(mean);
}

/** Recomputes the scenario-level `aggregate` block from exactly 5 repeats. A metric path is
 * present only when every repeat produced a non-null value for it (an `unavailable`/
 * `not-applicable` rate or dist anywhere drops the whole path, rather than aggregating a mix of
 * real numbers and absent ones). Representative per-repeat scalar: `value` for a <rate>, `p50`
 * for a <dist>, the plain number otherwise -- documented in the file header. */
export function aggregate(repeats: ReportRepeat[]): ReportAggregate {
  const out: ReportAggregate = {};
  for (const metric of AGGREGATE_METRICS) {
    const values: number[] = [];
    let allPresent = true;
    for (const r of repeats) {
      const v = metric.extract(r);
      if (v === null) {
        allPresent = false;
        break;
      }
      values.push(v);
    }
    if (!allPresent || values.length === 0) continue;
    out[metric.path] = {
      median: median(values),
      min: Math.min(...values),
      max: Math.max(...values),
      cov: coefficientOfVariation(values),
    };
  }
  return out;
}
