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
  };
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
    receiver_clock: "Time.get_ticks_usec";
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
  };
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
    cache: CacheState;
    delivery: string;
    connections: number;
    time: TimeMode;
  };
  warmup: { run_dir: string; discarded: true };
  repeats: ReportRepeat[];
  aggregate: ReportAggregate;
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
  schema: "render-stream-report/1";
  run: ReportRun;
  provenance: ReportProvenance;
  scenarios: ReportScenario[];
  optimizations: ReportOptimizations | null;
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

/** Schema plus internal-consistency checks (Q7f "Rules enforced by validate"). Returns every
 * problem found, each `"<code>: <detail>"`; `[]` means the report is valid. */
export function validate(input: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return ["report-entry: top level is not an object"];
  }
  if (input.schema !== RENDER_STREAM_REPORT_SCHEMA) {
    errors.push(
      `bad-schema: schema is ${JSON.stringify(input.schema)}, expected ${JSON.stringify(RENDER_STREAM_REPORT_SCHEMA)}`,
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
    if (!isPlainObject(raw.warmup) || raw.warmup.discarded !== true) {
      errors.push(`scenario-entry: ${where}: warmup.discarded must be true`);
    }
    if (!Array.isArray(raw.repeats) || raw.repeats.length !== 5) {
      errors.push(
        `repeat-count: ${where}: ${Array.isArray(raw.repeats) ? raw.repeats.length : "none"} repeats, expected exactly 5`,
      );
      continue;
    }
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
            !isRenderedDesktopGlReceiver(provenance)
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
