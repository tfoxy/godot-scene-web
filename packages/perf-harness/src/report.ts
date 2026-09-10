// The shared report envelope. godot-scene-web OWNS this schema; sibling repos (spirectl,
// sts2-couch-coop) emit the SAME JSON shape so their numbers can be put side by side with these.
//
// The coupling is the JSON shape ONLY — no build dependency in either direction. That is why
// `validateReport` is exposed both as a library export and as `perf validate-report <file>`: a
// sibling repo shells out to check its envelope without ever importing this package.

import type {
  CpuMetrics,
  GpuBuckets,
  GpuMetrics,
  ThreadCpu,
  TraceMetrics,
} from "./analyze";
import type { PresenceResult } from "./presence";

export const REPORT_SCHEMA = "perf-report/1";

export type RepoName = "godot-scene-web" | "spirectl" | "sts2-couch-coop";

/**
 * What KIND of thing a report measures. The envelope is shared across repos, but the metrics block
 * is not: only `browser-render` runs have activations, decode, layers or a screenshot. A producer
 * walk has none of those and must not be forced to invent them.
 *
 *   browser-render — a real page measured in a browser over CDP (this package's scenarios)
 *   producer-walk  — spirectl's scene-graph producer walk (capture ms, nodes read, …)
 *   wire-payload   — couch-coop's scene-delta wire volume (bytes/upserts per frame)
 *   asset-render   — couch-coop's host-side asset render cost (e.g. /bg/ render ms per resolution)
 */
export type ReportProfile =
  | "browser-render"
  | "producer-walk"
  | "wire-payload"
  | "asset-render";

export const REPORT_PROFILES: ReportProfile[] = [
  "browser-render",
  "producer-walk",
  "wire-payload",
  "asset-render",
];

/** Conditions sampled around a device run. Sampled twice — before and after — and both reported. */
export interface ReportDeviceConditions {
  batteryPct: number | null;
  batteryTemperatureC: number | null;
  /** `PowerManager.THERMAL_STATUS_*` name: none | light | moderate | severe | … */
  thermalStatus: string | null;
  thermalStatusCode: number | null;
  thermalMaxTempC: number | null;
}

/**
 * `env.device`, required when `kind === "device"`.
 *
 * The contract fields (`model`, `androidRelease`, `chrome`, `batteryPct`, `thermalStatus`) carry the
 * BEFORE reading; `after` carries the same sample taken once the last repeat finished. Both are
 * mandatory in practice for one reason: a thermally throttled phone silently invalidates a baseline,
 * and a baseline that cannot be told apart from a hot-phone run is worse than no baseline at all.
 */
export interface ReportDevice extends ReportDeviceConditions {
  model: string;
  androidRelease: string;
  chrome: string;
  serial?: string;
  manufacturer?: string;
  androidSdk?: string;
  chromePackage?: string | null;
  /** Same sample, taken AFTER the last measured repeat. */
  after?: ReportDeviceConditions | null;
  /** Conditions that may invalidate this run as a baseline. Empty array = nothing to report. */
  warnings?: string[];
  /** How cold each repeat's page really was — Android may refuse fresh browser contexts. */
  isolation?: "browser-context" | "new-tab" | "reused-tab";
  /** The viewport the scenario was measured at, e.g. `412x883@2.625` (or an emulated `1280x800@1`). */
  viewport?: string;
  /** What the phone reports with no emulation, e.g. `412x883@2.625` — context for the above. */
  naturalViewport?: string;
}

/**
 * The GEOMETRY a run was measured at — viewport, orientation, and the fit that put the scenario
 * inside it.
 *
 * Recorded because it is not a cosmetic detail: raster and decode cost scale with the raster scale,
 * so **two runs at different `fitScale` are NOT directly comparable** on `decode.*`, `rasterMs` or
 * `paint.*`. Before this block existed a device run silently force-emulated a desktop viewport, and
 * nothing in the report said the phone had been measured at a size it never uses. Making the
 * geometry explicit is what turns that from an invisible assumption into a checkable field.
 */
export interface ReportGeometry {
  /** The page's own viewport in CSS px, as `window.innerWidth/innerHeight` reported it. */
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  orientation: "portrait" | "landscape" | "square";
  /** Whether the scenario's stage was fitted into the viewport, or used it 1:1. */
  fit: boolean;
  /** The uniform scale applied to the stage. 1 on an unfitted run. */
  fitScale: number;
  /** The scenario's design box in CSS px — the space it laid itself out in. */
  stage: { width: number; height: number };
  /** `stage * fitScale`: how big the scenario actually is on screen, in CSS px. */
  fittedStage: { width: number; height: number };
  /**
   * The grid the scenario arranged its cells in (`"5x10"` = columns x rows), or null for a scenario
   * that has no grid. The cell COUNT is a parameter and never changes with the viewport; only the
   * shape does, so this is what tells a reader that a portrait run drew the same 50 sprites in a
   * different arrangement rather than a different amount of work.
   */
  grid: string | null;
  /**
   * The viewport the run FORCED with `Emulation.setDeviceMetricsOverride`, or `null` when the
   * browser's own viewport was used (the device default).
   */
  emulatedViewport: string | null;
}

/**
 * WHERE a run was measured.
 *
 *   ci     — an automated/local browser run on this box
 *   host   — a real process on a developer or host machine: spirectl's producer walk, couch-coop's
 *            wire and asset-render captures taken from a RUNNING GAME HOST
 *   device — a phone over adb
 *
 * `ci` and `host` are the SAME HARDWARE CLASS, and that is the point of having both: the split that
 * decides comparability is local-box vs phone, while `host` vs `ci` records that the numbers came out
 * of a live process rather than a controlled harness run. `host` exists because the alternative in
 * practice was labelling a capture from a running game "ci", which is simply false — and the sibling
 * repos were doing exactly that to get past this validator.
 */
export type ReportEnvironmentKind = "ci" | "host" | "device";

export const REPORT_ENVIRONMENT_KINDS: ReportEnvironmentKind[] = [
  "ci",
  "host",
  "device",
];

export interface ReportEnvironment {
  kind: ReportEnvironmentKind;
  label: string;
  /**
   * Required (>= 1) for `browser-render` on `ci` and `host` — same hardware class, same rule; `null`
   * on `device`, where throttling the CPU of the slow device you are measuring would measure an
   * emulated phone running on a phone.
   */
  cpuThrottle: number | null;
  device: ReportDevice | null;
  /**
   * Required for `browser-render`: a browser number without the geometry it was measured at cannot
   * be compared with another one. Optional for the sibling profiles, which have no viewport at all.
   */
  geometry?: ReportGeometry;
}

export interface ReportMetrics extends TraceMetrics {
  /** JS-visible: total `blockingDuration` from `long-animation-frame` entries. */
  blockedMs: number;
  longAnimationFrames: number;
  longTaskCount: number;
  /** Mount -> the scenario's `ready()` promise resolving. "Content available", not "presented". */
  readyMs: number;
  /** Compositor layers from the CDP LayerTree snapshot. Comparable within an environment only. */
  layerCount: number;
  presented: {
    nonEmptyRatio: number;
    sampleHits: number;
    sampleCount: number;
    screenshot: string;
  };
  /**
   * OPTIONAL: the scenario's own JS-visible counters (`Scenario.metrics`), flat and finite.
   *
   * The block a trace cannot produce. A CDP trace says the page got cheaper; it cannot say which of
   * an arm's own switches made it cheaper — whether the loop really parked, whether the sim steps
   * were really suppressed while the draws kept ticking. Only the scenario can count that, so an arm
   * whose whole claim is about its own mechanism carries the evidence for it here.
   *
   * ABSENT MEANS NOT MEASURED, NEVER ZERO. A scenario that declares no counters carries no key at
   * all, and the same rule holds per key: a counter only one arm reports stays absent on the others
   * rather than being filled in with a `0` nothing counted.
   */
  scenario?: Record<string, number>;
}

/** A metrics block for a non-browser profile: free-form, but numeric and non-degenerate. */
export type GenericMetrics = Record<string, unknown>;

export interface PerfReport<M = ReportMetrics> {
  schema: typeof REPORT_SCHEMA;
  repo: RepoName;
  profile: ReportProfile;
  scenario: string;
  env: ReportEnvironment;
  params: Record<string, string | number | boolean>;
  repeats: number;
  warmups: number;
  metrics: M;
  runs: M[];
  /** `trace` + `screenshot` are required for `browser-render`; other profiles may report `{}`. */
  artifacts: { trace?: string; screenshot?: string } & Record<
    string,
    string | undefined
  >;
  /** Populated when the presence guard failed on any repeat. A failed run is never averaged in. */
  failures?: string[];
}

/** The browser-profile report this package produces. */
export type BrowserPerfReport = PerfReport<ReportMetrics> & {
  profile: "browser-render";
  artifacts: { trace: string; screenshot: string };
};

export interface ValidationIssue {
  path: string;
  message: string;
}

const REPOS: RepoName[] = ["godot-scene-web", "spirectl", "sts2-couch-coop"];

/**
 * Structural + non-degeneracy validation.
 *
 * The ENVELOPE shell is validated for every profile. The METRICS block is not: only
 * `browser-render` reports have activations, decode, layers and a screenshot, and demanding those of
 * a producer-walk or wire-payload report would reject perfectly good measurements from the sibling
 * repos. Non-browser profiles are still held to the anti-degeneracy rule that motivates this
 * validator at all — every numeric leaf must be finite and at least one must be > 0, because an
 * all-zero envelope is exactly the shape a broken measurement takes.
 */
export function validateReport(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (path: string, message: string) =>
    issues.push({ path, message });

  if (typeof value !== "object" || value === null) {
    return [{ path: "", message: "report must be an object" }];
  }
  const report = value as Record<string, unknown>;

  if (report.schema !== REPORT_SCHEMA) {
    push(
      "schema",
      `expected "${REPORT_SCHEMA}", got ${JSON.stringify(report.schema)}`,
    );
  }
  if (!REPOS.includes(report.repo as RepoName)) {
    push(
      "repo",
      `expected one of ${REPOS.join(" | ")}, got ${JSON.stringify(report.repo)}`,
    );
  }
  const profile = report.profile as ReportProfile;
  if (!REPORT_PROFILES.includes(profile)) {
    push(
      "profile",
      `expected one of ${REPORT_PROFILES.join(" | ")}, got ${JSON.stringify(report.profile)}`,
    );
  }
  const isBrowser = profile === "browser-render";

  if (typeof report.scenario !== "string" || report.scenario.length === 0) {
    push("scenario", "must be a non-empty string");
  }
  if (typeof report.repeats !== "number" || report.repeats < 1) {
    push("repeats", "must be a positive number");
  }
  if (typeof report.warmups !== "number" || report.warmups < 0) {
    push("warmups", "must be a non-negative number");
  }

  const env = report.env as Record<string, unknown> | undefined;
  if (!env || typeof env !== "object") {
    push("env", "missing");
  } else {
    if (!REPORT_ENVIRONMENT_KINDS.includes(env.kind as ReportEnvironmentKind)) {
      push(
        "env.kind",
        `must be one of ${REPORT_ENVIRONMENT_KINDS.map((kind) => `"${kind}"`).join(" | ")} (got ${JSON.stringify(env.kind)})`,
      );
    }
    if (typeof env.label !== "string" || env.label.length === 0) {
      push("env.label", "must be a non-empty string");
    }
    // `host` follows the `ci` rule here deliberately: both are this box, so a browser-render run on
    // either has to say what throttle it applied. Only `device` is exempt.
    if (isBrowser && env.kind !== "device") {
      if (typeof env.cpuThrottle !== "number" || env.cpuThrottle < 1) {
        push("env.cpuThrottle", "must be a number >= 1 for browser-render");
      }
    } else if (
      env.cpuThrottle !== null &&
      env.cpuThrottle !== undefined &&
      (typeof env.cpuThrottle !== "number" || env.cpuThrottle < 1)
    ) {
      push("env.cpuThrottle", "must be null or a number >= 1");
    }
    if (env.kind === "device") {
      const device = env.device as Record<string, unknown> | null | undefined;
      if (!device || typeof device !== "object") {
        push("env.device", 'required when env.kind === "device"');
      } else {
        for (const key of ["model", "androidRelease", "chrome"]) {
          if (typeof device[key] !== "string" || !device[key]) {
            push(`env.device.${key}`, "must be a non-empty string");
          }
        }
        // Battery and thermal are what tell a cold-phone baseline apart from a hot-phone run, so
        // they are typed here rather than left as free-form annotations.
        if (
          device.batteryPct !== null &&
          (typeof device.batteryPct !== "number" ||
            !Number.isFinite(device.batteryPct))
        ) {
          push("env.device.batteryPct", "must be a number or null");
        }
        if (
          device.thermalStatus !== null &&
          typeof device.thermalStatus !== "string"
        ) {
          push("env.device.thermalStatus", "must be a string or null");
        }
      }
    } else if (env.device !== null && env.device !== undefined) {
      // Names the kind that was ACTUALLY reported: saying `"ci"` at a `host` report sends the reader
      // looking for a field they never set.
      push(
        "env.device",
        `must be null when env.kind === ${JSON.stringify(env.kind)} — only a device run has one`,
      );
    }
    issues.push(...validateGeometry(env.geometry, isBrowser));
  }

  if (typeof report.params !== "object" || report.params === null) {
    push("params", "must be an object");
  }
  if (!Array.isArray(report.runs) || report.runs.length === 0) {
    push("runs", "must be a non-empty array of per-repeat metrics");
  }

  const artifacts = report.artifacts as Record<string, unknown> | undefined;
  if (!artifacts || typeof artifacts !== "object") {
    push("artifacts", "must be an object");
  } else if (isBrowser) {
    if (
      typeof artifacts.trace !== "string" ||
      typeof artifacts.screenshot !== "string"
    ) {
      push(
        "artifacts",
        "browser-render must carry string `trace` and `screenshot` paths",
      );
    }
  } else {
    for (const [key, entry] of Object.entries(artifacts)) {
      if (entry !== undefined && typeof entry !== "string") {
        push(`artifacts.${key}`, "must be a string path when present");
      }
    }
  }

  const check = (value: unknown, path: string): ValidationIssue[] => [
    ...(isBrowser
      ? validateBrowserMetrics(value, path)
      : validateGenericMetrics(value, path)),
    // Profile-crossing rules, checked for EVERY profile so the answer lives in the contract once
    // instead of in every scenario.
    ...validateCpuBlock(value, path, isBrowser),
    ...validateGpuBlock(value, path, isBrowser),
    ...validateScenarioBlock(value, path),
  ];
  issues.push(...check(report.metrics, "metrics"));
  if (Array.isArray(report.runs)) {
    report.runs.forEach((run, index) => {
      issues.push(...check(run, `runs[${index}]`));
    });
  }
  return issues;
}

/**
 * `cpu`: REQUIRED for `browser-render`, optional elsewhere but validated when present.
 *
 * Optional for the sibling profiles because they are adding it independently; the shape is fixed here
 * so a producer-walk's `cpu.totalCpuMs` and a browser run's mean the same thing and can be read in one
 * table.
 */
export function validateCpuBlock(
  value: unknown,
  path: string,
  required: boolean,
): ValidationIssue[] {
  const metrics = value as Record<string, unknown> | null;
  if (typeof metrics !== "object" || metrics === null) {
    return [];
  }
  const cpu = metrics.cpu as Record<string, unknown> | undefined;
  if (cpu === undefined) {
    return required
      ? [
          {
            path: `${path}.cpu`,
            message:
              "required for browser-render: without it the browser and GPU processes are unmeasured, which is what the renderer-pid filter used to hide",
          },
        ]
      : [];
  }
  const issues: ValidationIssue[] = [];
  const push = (suffix: string, message: string) =>
    issues.push({ path: `${path}.cpu${suffix}`, message });
  if (typeof cpu !== "object") {
    return [{ path: `${path}.cpu`, message: "must be an object" }];
  }
  if (typeof cpu.windowMs !== "number" || !(cpu.windowMs > 0)) {
    push(".windowMs", "must be a number > 0");
  }
  for (const key of ["totalCpuMs", "totalCoreRatio", "cpuCoverage"]) {
    const raw = cpu[key];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      push(`.${key}`, "must be a finite number >= 0");
    }
  }
  if (typeof cpu.byProcess !== "object" || cpu.byProcess === null) {
    push(".byProcess", "must be an object keyed by process");
  }
  if (!Array.isArray(cpu.byThread)) {
    push(".byThread", "must be an array of per-thread rows");
  } else {
    for (const [index, row] of (
      cpu.byThread as Record<string, unknown>[]
    ).entries()) {
      if (typeof row?.process !== "string" || typeof row?.thread !== "string") {
        push(`.byThread[${index}]`, "must carry string `process` and `thread`");
      }
      for (const key of ["cpuMs", "wallMs", "coreRatio"]) {
        if (typeof row?.[key] !== "number" || !Number.isFinite(row[key])) {
          push(`.byThread[${index}].${key}`, "must be a finite number");
        }
      }
    }
  }
  return issues;
}

/**
 * `gpu`: allowed ONLY on `browser-render`.
 *
 * This is the "a tree walk does not need GPU" rule, expressed once in the contract instead of once
 * per scenario. A producer walk, a wire-payload measurement and a host-side asset render have no
 * compositor, no GPU process and no frames; a `gpu` block on one of them is not a harmless extra
 * field, it is a claim that was never measured.
 */
export function validateGpuBlock(
  value: unknown,
  path: string,
  isBrowser: boolean,
): ValidationIssue[] {
  const metrics = value as Record<string, unknown> | null;
  if (typeof metrics !== "object" || metrics === null) {
    return [];
  }
  const gpu = metrics.gpu as Record<string, unknown> | undefined;
  if (gpu === undefined) {
    return [];
  }
  if (!isBrowser) {
    return [
      {
        path: `${path}.gpu`,
        message:
          "only a browser-render report may carry a `gpu` block — a producer walk / wire payload / asset render has no compositor and no GPU process, so a gpu block there is a claim nothing measured",
      },
    ];
  }
  const issues: ValidationIssue[] = [];
  const push = (suffix: string, message: string) =>
    issues.push({ path: `${path}.gpu${suffix}`, message });
  if (typeof gpu !== "object") {
    return [{ path: `${path}.gpu`, message: "must be an object" }];
  }
  if (typeof gpu.available !== "boolean") {
    push(
      ".available",
      'must be a boolean — `false` means NOT MEASURED (e.g. --no-gpu), never "the GPU did nothing"',
    );
  }
  if (typeof gpu.hardware !== "string" || gpu.hardware.length === 0) {
    push(
      ".hardware",
      "must name the GPU (or `swiftshader` / `unknown`): GPU numbers are comparable within an environment only, so the environment has to be on the record",
    );
  }
  for (const key of ["processCpuMs", "processWallMs"]) {
    const raw = gpu[key];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      push(`.${key}`, "must be a finite number >= 0");
    }
  }
  const buckets = gpu.byBucket as Record<string, unknown> | undefined;
  if (typeof buckets !== "object" || buckets === null) {
    push(".byBucket", "must be an object of bucket totals in ms");
  } else {
    for (const key of GPU_BUCKET_KEYS) {
      const raw = buckets[key];
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
        push(`.byBucket.${key}`, "must be a finite number >= 0");
      }
    }
  }
  if (!Array.isArray(gpu.topUnbucketedOps)) {
    push(
      ".topUnbucketedOps",
      "must be an array (empty is fine) — it is what stops an op hiding behind the taxonomy",
    );
  }
  if (gpu.available === true && gpu.device !== null) {
    const device = gpu.device as Record<string, unknown> | undefined;
    if (typeof device !== "object" || device === null) {
      push(".device", "must be the device supplement object, or null on ci");
    } else {
      if (typeof device.gfxinfo !== "object" || device.gfxinfo === null) {
        push(".device.gfxinfo", "must be an object");
      }
      // WHICH INSTRUMENT produced the byte count is not optional metadata. `dumpsys gfxinfo` reports
      // a whole Android package's HWUI total and `nvidia-smi` one desktop process's VRAM; an
      // unlabelled `gpuMemoryBytes` invites the one comparison this harness forbids.
      if (
        device.source !== null &&
        device.source !== "dumpsys-gfxinfo" &&
        device.source !== "nvidia-smi"
      ) {
        push(
          ".device.source",
          'must be "dumpsys-gfxinfo" or "nvidia-smi" — or null when the block carries only the --memory-dump cross-check',
        );
      }
      if (device.source === null && device.gpuMemoryBytes !== null) {
        push(
          ".device.source",
          "must name the instrument whenever gpuMemoryBytes carries a number: a byte count with no source cannot be read",
        );
      }
    }
  }
  return issues;
}

/**
 * `scenario`: the optional scenario-reported counter block, allowed on EVERY profile.
 *
 * Optional and additive — a `perf-report/1` envelope without it is still valid, which is what lets a
 * sibling repo adopt the seam whenever it has something to count instead of at schema-bump time.
 *
 * The shape is deliberately the narrowest thing that can be medianed and read next to trace numbers:
 * FLAT (one level, no nested objects or arrays) and FINITE (numbers only — no strings, no nulls, no
 * NaN/Infinity). A "not measured" counter is expressed by being ABSENT, so there is never a need for
 * a null or a placeholder; and an EMPTY block is rejected for the same reason a zeroed metrics block
 * is — a scenario that says it counts something and then reports nothing has not measured, it has
 * broken.
 */
export function validateScenarioBlock(
  value: unknown,
  path: string,
): ValidationIssue[] {
  const metrics = value as Record<string, unknown> | null;
  if (typeof metrics !== "object" || metrics === null) {
    return [];
  }
  const scenario = metrics.scenario;
  if (scenario === undefined) {
    return [];
  }
  if (
    typeof scenario !== "object" ||
    scenario === null ||
    Array.isArray(scenario)
  ) {
    return [
      {
        path: `${path}.scenario`,
        message:
          "must be a flat object of scenario counters, or absent — absent is how a scenario says it counted nothing",
      },
    ];
  }
  const entries = Object.entries(scenario as Record<string, unknown>);
  if (entries.length === 0) {
    return [
      {
        path: `${path}.scenario`,
        message:
          "must not be empty: a scenario that reports no counters must OMIT the block, because an empty one cannot be told apart from a read-out that failed",
      },
    ];
  }
  const issues: ValidationIssue[] = [];
  for (const [key, counter] of entries) {
    if (typeof counter !== "number" || !Number.isFinite(counter)) {
      issues.push({
        path: `${path}.scenario.${key}`,
        message:
          "must be a finite number — scenario counters are flat and numeric so they can be medianed and read beside the trace metrics",
      });
    }
  }
  return issues;
}

const ORIENTATIONS = ["portrait", "landscape", "square"];

/**
 * `env.geometry`: required for `browser-render`, optional (but checked when present) elsewhere.
 *
 * Required, because a browser number whose raster scale is unknown cannot be compared with another
 * one — and for the whole first round of this harness a device run silently reported metrics taken
 * at a force-emulated desktop viewport with nothing in the file saying so.
 */
export function validateGeometry(
  value: unknown,
  isBrowser: boolean,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (path: string, message: string) =>
    issues.push({ path: `env.geometry${path}`, message });
  if (value === undefined || value === null) {
    if (isBrowser) {
      push(
        "",
        "required for browser-render: without the viewport, orientation and fit scale a run was measured at, its decode/raster numbers cannot be compared with any other run",
      );
    }
    return issues;
  }
  if (typeof value !== "object") {
    return [{ path: "env.geometry", message: "must be an object" }];
  }
  const geometry = value as Record<string, unknown>;
  for (const key of ["viewport", "stage", "fittedStage"]) {
    const size = geometry[key] as Record<string, unknown> | undefined;
    if (!size || typeof size !== "object") {
      push(`.${key}`, "must be a {width,height} object");
      continue;
    }
    for (const axis of ["width", "height"]) {
      const raw = size[axis];
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
        push(`.${key}.${axis}`, "must be a number > 0");
      }
    }
  }
  if (
    typeof geometry.devicePixelRatio !== "number" ||
    !(geometry.devicePixelRatio > 0)
  ) {
    push(".devicePixelRatio", "must be a number > 0");
  }
  if (!ORIENTATIONS.includes(String(geometry.orientation))) {
    push(".orientation", `must be one of ${ORIENTATIONS.join(" | ")}`);
  }
  if (typeof geometry.fit !== "boolean") {
    push(".fit", "must be a boolean");
  }
  if (typeof geometry.fitScale !== "number" || !(geometry.fitScale > 0)) {
    push(".fitScale", "must be a number > 0 (1 when the stage was not fitted)");
  }
  if (geometry.fit === false && geometry.fitScale !== 1) {
    push(
      ".fitScale",
      `must be exactly 1 when fit is false, got ${String(geometry.fitScale)}`,
    );
  }
  if (
    geometry.grid !== null &&
    !/^\d+x\d+$/.test(String(geometry.grid ?? ""))
  ) {
    push(
      ".grid",
      'must be "<columns>x<rows>", or null for a scenario with no grid',
    );
  }
  if (
    geometry.emulatedViewport !== null &&
    typeof geometry.emulatedViewport !== "string"
  ) {
    push(
      ".emulatedViewport",
      "must be the forced viewport as a string, or null when the browser's own viewport was used",
    );
  }
  return issues;
}

/**
 * Profile-agnostic metrics check: finite numeric leaves (one level of nesting, so `{p50,p95,max}`
 * blocks and per-category maps like `readMsByCategory` are covered), and at least one leaf > 0.
 */
export function validateGenericMetrics(
  value: unknown,
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [{ path, message: "must be an object" }];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return [{ path, message: "must not be empty" }];
  }
  let positiveLeaves = 0;
  let numericLeaves = 0;
  const visit = (leafPath: string, leaf: unknown, depth: number): void => {
    if (typeof leaf === "number") {
      numericLeaves++;
      if (!Number.isFinite(leaf)) {
        issues.push({ path: leafPath, message: "must be a finite number" });
      } else if (leaf > 0) {
        positiveLeaves++;
      }
      return;
    }
    if (leaf && typeof leaf === "object" && !Array.isArray(leaf) && depth < 1) {
      for (const [key, nested] of Object.entries(
        leaf as Record<string, unknown>,
      )) {
        visit(`${leafPath}.${key}`, nested, depth + 1);
      }
    }
  };
  for (const [key, leaf] of entries) {
    visit(`${path}.${key}`, leaf, 0);
  }
  if (numericLeaves === 0) {
    issues.push({ path, message: "carries no numeric metrics" });
  } else if (positiveLeaves === 0) {
    issues.push({
      path,
      message:
        "every numeric metric is zero — that is the shape of a broken measurement, not a fast one",
    });
  }
  return issues;
}

function validateBrowserMetrics(
  value: unknown,
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (suffix: string, message: string) =>
    issues.push({ path: `${path}${suffix}`, message });
  if (typeof value !== "object" || value === null) {
    return [{ path, message: "must be an object" }];
  }
  const metrics = value as Record<string, unknown>;

  const positive = [
    "initialRenderMs",
    "readyMs",
    "contentUpdateHz",
    "windowMs",
  ];
  for (const key of positive) {
    const raw = metrics[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      push(`.${key}`, "must be a finite number");
    } else if (raw <= 0) {
      push(
        `.${key}`,
        `must be > 0 (got ${raw}) — a zero here means nothing was measured`,
      );
    }
  }

  const nonNegative = [
    "blockedMs",
    "rasterMs",
    "renderSurfaces",
    "layerCount",
    "swapRateHz",
    "longTaskCount",
    "longAnimationFrames",
    "mainThreadBusyMs",
    "activationCount",
  ];
  for (const key of nonNegative) {
    const raw = metrics[key];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      push(`.${key}`, "must be a finite number >= 0");
    }
  }

  // The invariant is `ratio === null <=> samples === 0`, enforced in both directions:
  //   * a NUMBER must be a real measurement, strictly > 0 — a severely parked main thread reads as a
  //     small positive ratio (measured: 0.002989, i.e. 0.3% CPU across 585 ms of wall). An exact 0
  //     means the ratio was never computed;
  //   * `null` means no task met the long-task threshold, and is legal ONLY with 0 samples. Any
  //     placeholder number here would be legal, plausible and wrong: a `1` reads as
  //     "fully compute-bound" and did exactly that for the region-blob arm for two rounds.
  const ratio = metrics.mainThreadCpuRatio;
  const samples = metrics.mainThreadCpuSamples;
  const samplesValid =
    typeof samples === "number" && Number.isFinite(samples) && samples >= 0;
  if (!samplesValid) {
    push(".mainThreadCpuSamples", "must be a finite number >= 0");
  }
  if (ratio === null) {
    if (samplesValid && samples !== 0) {
      push(
        ".mainThreadCpuRatio",
        `null means "no task met the long-task threshold", but mainThreadCpuSamples is ${samples} — a null with samples is a dropped measurement`,
      );
    }
  } else if (typeof ratio !== "number" || !(ratio > 0) || ratio > 1.5) {
    push(
      ".mainThreadCpuRatio",
      "must be a ratio in (0, 1.5], or null when mainThreadCpuSamples is 0 — an exact 0 means the ratio was not computed, not that the thread was parked",
    );
  } else if (samplesValid && samples === 0) {
    push(
      ".mainThreadCpuSamples",
      `0 samples cannot back a ratio of ${ratio}; report null instead`,
    );
  }

  for (const key of ["frameCostMs", "activationGapMs"]) {
    const s = metrics[key] as Record<string, unknown> | undefined;
    if (!s || typeof s !== "object") {
      push(`.${key}`, "must be a {p50,p95,max} object");
      continue;
    }
    for (const field of ["p50", "p95", "max"]) {
      if (
        typeof s[field] !== "number" ||
        !Number.isFinite(s[field] as number)
      ) {
        push(`.${key}.${field}`, "must be a finite number");
      }
    }
  }

  const decode = metrics.decode as Record<string, unknown> | undefined;
  if (!decode || typeof decode !== "object") {
    push(".decode", "missing");
  } else {
    for (const field of [
      "count",
      "totalMs",
      "maxMs",
      "distinctImages",
      "redecodeCount",
      "redecodeMs",
      "inRasterCount",
    ]) {
      if (
        typeof decode[field] !== "number" ||
        !Number.isFinite(decode[field] as number)
      ) {
        push(`.decode.${field}`, "must be a finite number");
      }
    }
    // A browser scenario that paints images CANNOT have decoded nothing. Zero decode almost always
    // means the cc decode-cache event names drifted (e.g. the GPU path emits GpuImageDecodeCache::*
    // where the software path emits SoftwareImageDecodeCache::*), and reporting that as "no decode
    // cost" is the single worst mistake this harness could make.
    // `imagesExpected: false` is the ONE way a zero here is legitimate: a scenario that paints no
    // images at all (S9 `text-render` — glyphs are rasterized by the font stack, which emits no
    // decode events). Absent means true, so every report written before the field existed is
    // still held to the original rule.
    if (
      decode.imagesExpected !== undefined &&
      typeof decode.imagesExpected !== "boolean"
    ) {
      push(".decode.imagesExpected", "must be a boolean when present");
    }
    if (decode.count === 0 && decode.imagesExpected !== false) {
      push(
        ".decode.count",
        `no decode events matched (cacheFamily=${JSON.stringify(decode.cacheFamily)}) — treat this as UNMEASURED, not fast; re-run \`perf --dump-trace-names\` on this Chrome and update the decode matcher`,
      );
    }
    // `cacheFamily: "unknown"` alone is NOT an error: a mechanism can legitimately decode outside cc's
    // image-decode cache (`createImageBitmap` does), and the canvas arm measurably does. It only
    // indicts the matcher when nothing was measured at all, which the `count === 0` check covers.
  }

  const presented = metrics.presented as Record<string, unknown> | undefined;
  if (!presented || typeof presented !== "object") {
    push(
      ".presented",
      "missing — a report without a presence check proves nothing",
    );
  } else {
    const hits = presented.sampleHits;
    const count = presented.sampleCount;
    if (typeof hits !== "number" || typeof count !== "number") {
      push(".presented", "sampleHits and sampleCount must be numbers");
    } else if (count === 0) {
      push(
        ".presented.sampleCount",
        "must be > 0: the scenario declared no sample points",
      );
    } else if (hits < count) {
      push(
        ".presented.sampleHits",
        `only ${hits}/${count} expected sprite centres were on screen — this run measured a (partly) blank page`,
      );
    }
    if (
      typeof presented.nonEmptyRatio !== "number" ||
      (presented.nonEmptyRatio as number) <= 0
    ) {
      push(".presented.nonEmptyRatio", "must be > 0");
    }
    if (typeof presented.screenshot !== "string" || !presented.screenshot) {
      push(
        ".presented.screenshot",
        "must be the path to the screenshot that backs this claim",
      );
    }
  }
  return issues;
}

/**
 * Median the `cpu` block across repeats.
 *
 * `byThread` is medianed PER (process, thread) row over the repeats that actually carried it, not
 * taken from one representative repeat: a thread that only appears in three of five runs should
 * report the three readings it has, with `runs` saying so, rather than either vanishing or being
 * averaged against zeros it never measured.
 */
export function medianCpu(runs: CpuMetrics[]): CpuMetrics {
  const pick = (fn: (run: CpuMetrics) => number): number =>
    Number(medianOf(runs.map(fn)).toPrecision(4));

  const processKeys = new Set<string>();
  for (const run of runs) {
    for (const key of Object.keys(run.byProcess)) {
      processKeys.add(key);
    }
  }
  const byProcess: CpuMetrics["byProcess"] = {};
  for (const key of processKeys) {
    const present = runs
      .map((run) => run.byProcess[key])
      .filter((entry) => entry !== undefined);
    byProcess[key] = {
      cpuMs: Number(medianOf(present.map((e) => e.cpuMs)).toPrecision(4)),
      wallMs: Number(medianOf(present.map((e) => e.wallMs)).toPrecision(4)),
      coreRatio: Number(
        medianOf(present.map((e) => e.coreRatio)).toPrecision(4),
      ),
      threads: Math.round(medianOf(present.map((e) => e.threads))),
      processes: Math.round(medianOf(present.map((e) => e.processes))),
    };
  }

  const rowKeys = new Map<string, { process: string; thread: string }>();
  for (const run of runs) {
    for (const row of run.byThread) {
      rowKeys.set(`${row.process} ${row.thread}`, {
        process: row.process,
        thread: row.thread,
      });
    }
  }
  const byThread: ThreadCpu[] = [...rowKeys.entries()]
    .map(([key, identity]) => {
      const present = runs
        .map((run) =>
          run.byThread.find((row) => `${row.process} ${row.thread}` === key),
        )
        .filter((row): row is ThreadCpu => row !== undefined);
      return {
        ...identity,
        cpuMs: Number(medianOf(present.map((r) => r.cpuMs)).toPrecision(4)),
        wallMs: Number(medianOf(present.map((r) => r.wallMs)).toPrecision(4)),
        coreRatio: Number(
          medianOf(present.map((r) => r.coreRatio)).toPrecision(4),
        ),
        instances: Math.round(medianOf(present.map((r) => r.instances))),
      };
    })
    .sort((a, b) => b.cpuMs - a.cpuMs || b.wallMs - a.wallMs);

  return {
    windowMs: pick((r) => r.windowMs),
    totalCpuMs: pick((r) => r.totalCpuMs),
    totalCoreRatio: pick((r) => r.totalCoreRatio),
    cpuCoverage: pick((r) => r.cpuCoverage),
    byProcess,
    byThread,
  };
}

const GPU_BUCKET_KEYS: (keyof GpuBuckets)[] = [
  "uploadDecode",
  "rasterPlayback",
  "skiaPrepare",
  "skiaExecute",
  "presentSwap",
  "clear",
  "schedulerIpc",
  "other",
];

export function medianGpu(runs: GpuMetrics[]): GpuMetrics {
  const pick = (fn: (run: GpuMetrics) => number): number =>
    Number(medianOf(runs.map(fn)).toPrecision(4));
  const representative = runs[Math.floor(runs.length / 2)];
  const byBucket = {} as GpuBuckets;
  for (const key of GPU_BUCKET_KEYS) {
    byBucket[key] = pick((run) => run.byBucket[key]);
  }
  // Op names are per-run text, so `topUnbucketedOps` is medianed per NAME across the runs that saw it
  // — the same rule as byThread. An op that shows up in one repeat out of five is still an op the
  // taxonomy failed to name, and dropping it would be the exact hiding this list exists to prevent.
  const names = new Set(
    runs.flatMap((run) => run.topUnbucketedOps.map((op) => op.name)),
  );
  const topUnbucketedOps = [...names]
    .map((name) => {
      const present = runs
        .map((run) => run.topUnbucketedOps.find((op) => op.name === name))
        .filter((op) => op !== undefined);
      return {
        name,
        selfMs: Number(medianOf(present.map((op) => op.selfMs)).toPrecision(4)),
        count: Math.round(medianOf(present.map((op) => op.count))),
      };
    })
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 10);

  return {
    // `available` and `opDetail` are ANDed, not medianed: if any repeat could not see the GPU, the
    // aggregate must not claim it could.
    available: runs.every((run) => run.available),
    opDetail: runs.every((run) => run.opDetail),
    hardware: representative.hardware,
    hardwareDetail: representative.hardwareDetail,
    processCpuMs: pick((r) => r.processCpuMs),
    processWallMs: pick((r) => r.processWallMs),
    threads: Math.round(medianOf(runs.map((r) => r.threads))),
    byBucket,
    topUnbucketedOps,
    device: medianGpuDevice(runs),
  };
}

function medianGpuDevice(runs: GpuMetrics[]): GpuMetrics["device"] {
  const present = runs
    .map((run) => run.device)
    .filter((device) => device !== null);
  if (present.length === 0) {
    return null;
  }
  // `null` means "this dump did not report the counter"; medianing it against real readings would
  // invent a number. Only the runs that HAVE a value back it, and a counter nothing reported stays
  // null.
  const field = (
    fn: (device: (typeof present)[number]) => number | null,
    // COUNTS AND BYTES ARE NOT ROUNDED TO 4 SIGNIFICANT DIGITS. That rule exists for ratios, where a
    // fixed decimal round annihilates the value; applied to a byte count it turns a measured
    // 20,173,742 into a fake-precise 20,170,000. Integers stay integers.
    integer = false,
  ): number | null => {
    const values = present
      .map(fn)
      .filter((value): value is number => typeof value === "number");
    if (values.length === 0) {
      return null;
    }
    const median = medianOf(values);
    return integer ? Math.round(median) : Number(median.toPrecision(4));
  };
  const memoryDump = (
    block: "after" | "delta",
    key: "glTextures" | "sharedImages" | "skiaGpuResources",
  ): number | null => field((d) => d.memoryDump?.[block][key] ?? null, true);
  return {
    // The INSTRUMENT does not median: every repeat of a run used the same one. Taking the first
    // keeps the label attached to the bytes below it, which is the whole reason the field exists.
    source: present[0].source,
    attribution: present[0].attribution,
    gfxinfo: {
      totalFrames: field((d) => d.gfxinfo.totalFrames, true),
      jankPct: field((d) => d.gfxinfo.jankPct),
      p50Ms: field((d) => d.gfxinfo.p50Ms),
      p95Ms: field((d) => d.gfxinfo.p95Ms),
      p99Ms: field((d) => d.gfxinfo.p99Ms),
      // Failure counters, aggregated by WORST CASE like `decode.inRasterCount` — four clean repeats
      // must not smooth away a fifth that stalled on texture uploads.
      slowBitmapUploads: worst(present.map((d) => d.gfxinfo.slowBitmapUploads)),
      slowIssueDrawCommands: worst(
        present.map((d) => d.gfxinfo.slowIssueDrawCommands),
      ),
    },
    gpuMemoryBytes: field((d) => d.gpuMemoryBytes, true),
    // The DELTA medians like any other reading, negatives included: a repeat that gave memory back
    // measured that, and clamping it at 0 would publish an allocation the driver did not report.
    gpuMemoryDeltaBytes: field((d) => d.gpuMemoryDeltaBytes, true),
    memoryDump: present.some((d) => d.memoryDump !== null)
      ? {
          after: {
            glTextures: memoryDump("after", "glTextures"),
            sharedImages: memoryDump("after", "sharedImages"),
            skiaGpuResources: memoryDump("after", "skiaGpuResources"),
          },
          delta: {
            glTextures: memoryDump("delta", "glTextures"),
            sharedImages: memoryDump("delta", "sharedImages"),
            skiaGpuResources: memoryDump("delta", "skiaGpuResources"),
          },
        }
      : null,
  };
}

function worst(values: (number | null)[]): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length === 0 ? null : Math.max(...numbers);
}

/**
 * Median the optional scenario-counter block PER KEY, over the repeats that carried that key — the
 * same rule as `cpu.byThread`, and for the same reason: a counter a scenario only reports on three of
 * five repeats should report the three readings it has, not vanish and not be averaged against zeros
 * it never counted.
 *
 * Returns `{}` — i.e. NO KEY AT ALL — when no repeat carried a counter, so the medianed metrics never
 * grow an empty `scenario: {}`. Absent has one meaning here (not measured) and it must stay the only
 * way to say it.
 */
function medianScenarioCounters(
  runs: ReportMetrics[],
): Pick<ReportMetrics, "scenario"> {
  const keys = new Set<string>();
  for (const run of runs) {
    for (const key of Object.keys(run.scenario ?? {})) {
      keys.add(key);
    }
  }
  if (keys.size === 0) {
    return {};
  }
  const scenario: Record<string, number> = {};
  for (const key of keys) {
    const present = runs
      .map((run) => run.scenario?.[key])
      .filter((counter): counter is number => typeof counter === "number");
    scenario[key] = roundCounter(medianOf(present));
  }
  return { scenario };
}

/**
 * 4 significant digits like every other median here — but NEVER at the cost of an integer digit.
 *
 * A scenario counter is usually a COUNT, and a plain `toPrecision(4)` would report the median of
 * [12345, 12346] as 12350: the same fake precision the gfxinfo byte-count rule above exists to
 * prevent. Integers pass through untouched; a half-step median keeps its integer part and one
 * decimal, and a small ratio still gets its four digits.
 */
function roundCounter(value: number): number {
  if (Number.isInteger(value)) {
    return value;
  }
  const integerDigits =
    Math.abs(value) >= 1 ? Math.floor(Math.log10(Math.abs(value))) + 1 : 0;
  return Number(value.toPrecision(Math.max(4, integerDigits + 1)));
}

export function medianOf(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Median across repeats, field by field. MEDIANS, not means: one thermally-throttled or
 * GC-interrupted repeat should not move the reported number.
 */
export function medianMetrics(runs: ReportMetrics[]): ReportMetrics {
  if (runs.length === 0) {
    throw new Error("medianMetrics: no runs");
  }
  // SIGNIFICANT DIGITS, not decimal places. A fixed 2-decimal round is fine for milliseconds and
  // counts but annihilates ratios: the page-crop arm's real per-run readings of
  // [0.003, 0.0029, 0.0029, 0.0029, 0.0033] have a median of 0.0029, which `Math.round(x*100)/100`
  // reported as a flat 0 — turning "the main thread is almost entirely PARKED", the single most
  // diagnostic reading this harness produces, into a number indistinguishable from "not measured".
  // toPrecision(4) keeps 0.0029 as 0.0029 while leaving 1547 as 1547 and 16.66666 as 16.67.
  const pick = (fn: (run: ReportMetrics) => number): number =>
    Number(medianOf(runs.map(fn)).toPrecision(4));

  // `mainThreadCpuRatio` is nullable, and a null must neither poison the median nor be silently
  // replaced by a number. Runs that measured nothing are dropped from the ratio; if NO run measured
  // anything the aggregate is null too. The sample count is taken over the runs that actually BACKED
  // the reported ratio, which keeps the `ratio === null <=> samples === 0` invariant true after
  // aggregation — reporting a plausible ratio next to "n=0" would reintroduce exactly the
  // misreadable pairing that nulling this field exists to remove.
  const measured = runs.filter((run) => run.mainThreadCpuRatio !== null);
  const cpuRatio =
    measured.length === 0
      ? null
      : Number(
          medianOf(
            measured.map((run) => run.mainThreadCpuRatio as number),
          ).toPrecision(4),
        );
  const cpuSamples =
    measured.length === 0
      ? 0
      : Number(
          medianOf(measured.map((run) => run.mainThreadCpuSamples)).toPrecision(
            4,
          ),
        );
  const representative = runs[Math.floor(runs.length / 2)];
  return {
    initialRenderMs: pick((r) => r.initialRenderMs),
    readyMs: pick((r) => r.readyMs),
    frameCostMs: {
      p50: pick((r) => r.frameCostMs.p50),
      p95: pick((r) => r.frameCostMs.p95),
      max: pick((r) => r.frameCostMs.max),
    },
    contentUpdateHz: pick((r) => r.contentUpdateHz),
    activationGapMs: {
      p50: pick((r) => r.activationGapMs.p50),
      p95: pick((r) => r.activationGapMs.p95),
      max: pick((r) => r.activationGapMs.max),
      over100msCount: pick((r) => r.activationGapMs.over100msCount),
      count: pick((r) => r.activationGapMs.count),
    },
    swapRateHz: pick((r) => r.swapRateHz),
    blockedMs: pick((r) => r.blockedMs),
    longAnimationFrames: pick((r) => r.longAnimationFrames),
    longTaskCount: pick((r) => r.longTaskCount),
    decode: {
      count: pick((r) => r.decode.count),
      totalMs: pick((r) => r.decode.totalMs),
      maxMs: pick((r) => r.decode.maxMs),
      distinctImages: pick((r) => r.decode.distinctImages),
      redecodeCount: pick((r) => r.decode.redecodeCount),
      redecodeMs: pick((r) => r.decode.redecodeMs),
      // NOT a median: an in-raster decode on ANY repeat is a hard failure and must not be smoothed
      // away by four clean runs.
      inRasterCount: Math.max(...runs.map((r) => r.decode.inRasterCount)),
      inRasterMs: Math.max(...runs.map((r) => r.decode.inRasterMs)),
      codecRuns: pick((r) => r.decode.codecRuns),
      codecMs: pick((r) => r.decode.codecMs),
      imageKey: representative.decode.imageKey,
      cacheFamily: representative.decode.cacheFamily,
      imagesExpected: representative.decode.imagesExpected,
    },
    paint: {
      count: pick((r) => r.paint.count),
      distinctUrls: pick((r) => r.paint.distinctUrls),
      maxSourceMegapixels: pick((r) => r.paint.maxSourceMegapixels),
      maxSourceToPaintedRatio: pick((r) => r.paint.maxSourceToPaintedRatio),
    },
    rasterMs: pick((r) => r.rasterMs),
    renderSurfaces: pick((r) => r.renderSurfaces),
    renderSurfaceReasons: representative.renderSurfaceReasons,
    renderSurfaceListPasses: pick((r) => r.renderSurfaceListPasses),
    mainThreadCpuRatio: cpuRatio,
    mainThreadCpuSamples: cpuSamples,
    mainThreadBusyMs: pick((r) => r.mainThreadBusyMs),
    windowMs: pick((r) => r.windowMs),
    activationCount: pick((r) => r.activationCount),
    cpu: medianCpu(runs.map((r) => r.cpu)),
    gpu: medianGpu(runs.map((r) => r.gpu)),
    layerCount: pick((r) => r.layerCount),
    presented: {
      nonEmptyRatio: pick((r) => r.presented.nonEmptyRatio),
      sampleHits: Math.min(...runs.map((r) => r.presented.sampleHits)),
      sampleCount: representative.presented.sampleCount,
      screenshot: representative.presented.screenshot,
    },
    // Optional block: only scenarios that declare `watchImageUrl` carry it. Aggregated by WORST
    // CASE on the repaint counts, like the other failure signals — four repeats that left the big
    // image alone must not smooth away a fifth that re-painted it every frame.
    ...(representative.watchedImage
      ? {
          watchedImage: {
            url: representative.watchedImage.url,
            paintCount: Math.max(
              ...runs.map((r) => r.watchedImage?.paintCount ?? 0),
            ),
            paintCountInWindow: Math.max(
              ...runs.map((r) => r.watchedImage?.paintCountInWindow ?? 0),
            ),
            distinctPaintedSizes: Math.max(
              ...runs.map((r) => r.watchedImage?.distinctPaintedSizes ?? 0),
            ),
            sourceMegapixels: representative.watchedImage.sourceMegapixels,
          },
        }
      : {}),
    // Optional block: only scenarios that implement `Scenario.metrics` carry it. Medianed per key
    // over the repeats that carried the key, and omitted entirely when no repeat did.
    ...medianScenarioCounters(runs),
  };
}

export function presenceOf(result: PresenceResult): ReportMetrics["presented"] {
  return {
    nonEmptyRatio: result.nonEmptyRatio,
    sampleHits: result.sampleHits,
    sampleCount: result.sampleCount,
    screenshot: result.screenshot,
  };
}
