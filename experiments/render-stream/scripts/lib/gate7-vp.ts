// VS5b: the viewport-surface phone-cost sweeps of run-gate7.sh g7-dev (G7V_LEGS=vp-..., header
// "Group landed (G7v)"; the legs are lib/gate6c-legs.sh "VS5b"), summarized for the orchestrator.
// Pure over the run directories (no process launched); gate7-vp-summary.ts is the CLI and
// scripts/test/self-test-gate7-vp.ts drives it with synthetic evidence.
//
// One sweep is <out>/gate6/<ctl|dev-<id>>-gsw-w<w>-vp-<workload>/rates/dev-vp-<workload>/: sweep.json,
// the shared host/, and one directory per arm (A<n>: the client's viewports on, B<n>: off, H: on, on
// a GRC_VIEWPORTS=off host), each a dev leg lib/gate7v-checks.ts loads. Each arm is measured as a
// G7v repeat (measureDevRepeat: the 20-s window 6 s after the arm's own connection, on the host,
// receiver and page clocks) plus the full new-frame interval distribution, the receiver's surface
// counters (applied.json live.gsw.surfaces), the phone's gfxinfo GPU memory and renderer/GPU/browser
// PSS before and after, thermal status and battery before and after, the foreground samples and the
// served build (identity.json).
//
// An arm is VOID, and never quoted, when: the receiver did not exit 0; its window or probe could
// not be placed; on a device, device-provenance did not hold, a foreground sample shows another
// package than the browser (or none was taken), or the harness recorded no Chrome force-stop.
//
// The summary does not decide; it states, per workload: every arm's numbers, the A-vs-A and B-vs-B
// agreement (relative spread |x1 - x2| / mean of the first two arms of each kind), A against B
// (means), the build check (every arm's build_id equal and matching its build.json) and the
// surface check (A arms allocated surfaces, B arms skipped them and allocated none). `admissible`
// is the conjunction of: no void A/B arm, both checks, and A-vs-A and B-vs-B spread within
// AGREEMENT_MAX on drawn fps and on the p50 and p95 new-frame interval. The orchestrator judges.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { receiverClockOffset } from "./gate6c-checks";
import {
  connectionId,
  DEV_WINDOW_S,
  DEV_WINDOW_START_S,
  type DevLegEvidence,
  devHostWindow,
  loadDevLeg,
  measureDevRepeat,
  newFrames,
  quantile,
} from "./gate7v-checks";

export const AGREEMENT_MAX = 0.1;
export const AGREEMENT_METRICS = [
  "drawn_fps",
  "interval_p50_ms",
  "interval_p95_ms",
] as const;
/** Also reported (not gating). */
export const REPORT_METRICS = [
  "drawn_fps",
  "interval_p50_ms",
  "interval_p95_ms",
  "interval_p99_ms",
  "over_34_fraction",
  "main_thread_p50_ms",
  "main_thread_p95_ms",
  "gsw_total_p95_ms",
  "page_busy_fraction",
  "gpu_memory_after_bytes",
  "pss_after_kb",
  "gpu_proc_graphics_after_kb",
  "renderer_graphics_after_kb",
  "surface_bytes",
] as const;
export type VpMetric = (typeof REPORT_METRICS)[number];

export const MEMORY_NOTE =
  "surface_bytes (surface_pixels x 4, allocation accounting) is the memory number. The observed device figures do not resolve a surface: gfxinfo is Chrome's UI, PSS moves by several MB arm to arm, and on the moto g31 unrooted the GPU process's meminfo graphics rows do not change with WebGL allocations (dumpsys gpu --gpumem is unavailable), so their A-minus-B is not surface cost";

export const VP_WORKLOADS = ["draw-active", "draw-idle", "vfx6"] as const;

/** The arm list run-gate7.sh accepts (G7V_VP_ARMS): distinct A<n>/B<n>, at least one of each. */
export function parseArms(csv: string): string[] {
  const arms = csv.split(",").map((a) => a.trim());
  if (arms.some((a) => !/^[AB]\d+$/.test(a)))
    throw new Error(`arms must be A<n>/B<n> (got ${csv})`);
  if (new Set(arms).size !== arms.length)
    throw new Error(`arms must be distinct (got ${csv})`);
  if (
    !arms.some((a) => a.startsWith("A")) ||
    !arms.some((a) => a.startsWith("B"))
  )
    throw new Error(`arms need at least one A and one B (got ${csv})`);
  return arms;
}

/** The order an ABBA sweep is run in: A1,B1,B2,A2 for one cycle, the next cycle continuing the
 * numbering (A3,B3,B4,A4, ...). */
export function abbaArms(cycles: number): string[] {
  const out: string[] = [];
  for (let c = 0; c < cycles; c++)
    out.push(
      `A${2 * c + 1}`,
      `B${2 * c + 1}`,
      `B${2 * c + 2}`,
      `A${2 * c + 2}`,
    );
  return out;
}

export interface FrameDistribution {
  count: number;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  over_17_fraction: number | null;
  over_34_fraction: number | null;
  over_50_fraction: number | null;
  /** 2-ms bins, keyed by the bin's lower edge (as gate7v-checks' hist_ms). */
  hist_ms: Record<string, number>;
}

export function distribution(intervals: readonly number[]): FrameDistribution {
  const n = intervals.length;
  const frac = (ms: number) =>
    n ? intervals.filter((v) => v > ms).length / n : null;
  const hist: Record<string, number> = {};
  for (const iv of intervals) {
    const bin = `${Math.floor(iv / 2) * 2}`;
    hist[bin] = (hist[bin] ?? 0) + 1;
  }
  return {
    count: n,
    p50: quantile(intervals, 0.5),
    p75: quantile(intervals, 0.75),
    p90: quantile(intervals, 0.9),
    p95: quantile(intervals, 0.95),
    p99: quantile(intervals, 0.99),
    max: n ? Math.max(...intervals) : null,
    over_17_fraction: frac(17.5),
    over_34_fraction: frac(34),
    over_50_fraction: frac(50),
    hist_ms: hist,
  };
}

/** The new-frame intervals inside the arm's measured window (receiver clock), as measureDevRepeat
 * places it. */
export function windowIntervals(ev: DevLegEvidence): number[] {
  const w = devHostWindow(
    ev.timeline,
    connectionId(ev),
    DEV_WINDOW_START_S,
    DEV_WINDOW_S,
  );
  if (typeof w === "string") return [];
  const offset = receiverClockOffset(ev.applied, ev.timeline);
  if (offset === null) return [];
  const t0 = (w.start_t_us + offset) / 1000;
  const t1 = (w.end_t_us + offset) / 1000;
  const inWin = newFrames("gsw", ev).filter(
    (f) => f.t_ms >= t0 && f.t_ms <= t1,
  );
  const out: number[] = [];
  for (let i = 1; i < inWin.length; i++)
    out.push(inWin[i].t_ms - inWin[i - 1].t_ms);
  return out;
}

export interface ForegroundSample {
  t_ms: number;
  package: string | null;
  browser: boolean;
  line: string | null;
  format?: string | null;
}

/** VS5b: the graphics rows of one process's `dumpsys meminfo` (lib/device-sampler.ts). */
export interface GraphicsRows {
  graphics_kb: number | null;
  gl_mtrack_kb: number | null;
  egl_mtrack_kb: number | null;
  gfx_dev_kb: number | null;
  lines: string[];
}

type MemRow = {
  pid?: number;
  process: string | null;
  pss_kb: number | null;
  graphics?: GraphicsRows;
};

/** One process's graphics memory: the App Summary's `Graphics:` when present, else the sum of the
 * `GL mtrack`, `EGL mtrack` and `Gfx dev` rows present, else null. */
export function graphicsKb(g: GraphicsRows | undefined): number | null {
  if (!g) return null;
  if (g.graphics_kb !== null) return g.graphics_kb;
  const parts = [g.gl_mtrack_kb, g.egl_mtrack_kb, g.gfx_dev_kb].filter(
    (v): v is number => v !== null,
  );
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

const isGpuProcess = (r: MemRow) => /privileged_process/.test(r.process ?? "");
const isRendererRow = (r: MemRow) => /sandboxed_process/.test(r.process ?? "");

/** The GPU process's graphics memory, and the renderers' (summed: the receiver's renderer and any
 * spare one, which the sample cannot tell apart), with every row seen, in one meminfo sample. */
export function graphicsOf(rows: MemRow[] | undefined): {
  gpu_process_kb: number | null;
  renderers_kb: number | null;
  rows: {
    pid: number | null;
    process: string | null;
    graphics: GraphicsRows | null;
  }[];
} {
  const r = rows ?? [];
  const gpu = r.filter(isGpuProcess).map((x) => graphicsKb(x.graphics));
  const ren = r.filter(isRendererRow).map((x) => graphicsKb(x.graphics));
  const sum = (v: (number | null)[]) =>
    v.length > 0 && v.every((x) => x !== null)
      ? (v as number[]).reduce((a, b) => a + b, 0)
      : null;
  return {
    gpu_process_kb: sum(gpu),
    renderers_kb: sum(ren),
    rows: r.map((x) => ({
      pid: x.pid ?? null,
      process: x.process,
      graphics: x.graphics ?? null,
    })),
  };
}

export interface VpArm {
  arm: string;
  order: number | null;
  kind: "A" | "B" | "H";
  viewports_client: boolean;
  viewports_host: "on" | "off";
  void: boolean;
  void_reasons: string[];
  metrics: Record<VpMetric, number | null>;
  frame_interval_ms: FrameDistribution;
  tp_ms: number | null;
  main_thread_ms: {
    p50: number | null;
    p95: number | null;
    p99: number | null;
  };
  published: number | null;
  applied: number | null;
  credit_rtt_mean_frames: number | null;
  surfaces: Record<string, unknown> | null;
  harness_stop: unknown;
  gpu_memory_bytes: { before: number | null; after: number | null };
  pss_kb: {
    before: number | null;
    after: number | null;
    by_process_after: { process: string | null; pss_kb: number | null }[];
    /** Why a total is null instead of a sum (a process without PSS, the renderer missing from
     * the closing sample, fewer processes than at the start); empty when both are complete. */
    partial: string[];
  };
  /** Graphics memory (dumpsys meminfo rows) of the GPU process and the renderers, before and
   * after (the closing sample is taken with the receiver tab alive). */
  graphics_kb:
    | {
        before: ReturnType<typeof graphicsOf>;
        after: ReturnType<typeof graphicsOf>;
      }
    | "unavailable";
  /** Foreground samples with no resumed-activity line (unknown; not a void). */
  foreground_unknown: number | null;
  thermal: { before: string | null; after: string | null };
  battery: { before: number | null; after: number | null };
  derated: boolean | null;
  foreground: ForegroundSample[] | "unavailable";
  chrome_stop: unknown;
  build: Record<string, unknown> | null;
}

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

interface Samples {
  gpu_memory?: { t_ms: number; bytes: number | null }[];
  meminfo?: {
    t_ms: number;
    samples: MemRow[];
  }[];
  foreground?: ForegroundSample[];
  derated?: boolean;
}

type PssRow = { process: string | null; pss_kb: number | null };

/** Android Chrome's renderers run as `<package>:sandboxed_process<N>`. */
const isRenderer = (r: PssRow) => /sandboxed_process/.test(r.process ?? "");

/** The before/after PSS totals of an arm, each null unless every process of the sample has a
 * PSS (a missing process is never summed away), the closing sample still holds a renderer when
 * the opening one did, and it covers as many processes. */
export function pssTotals(
  before: PssRow[] | undefined,
  after: PssRow[] | undefined,
): { before: number | null; after: number | null; partial: string[] } {
  const partial: string[] = [];
  const total = (rows: PssRow[] | undefined, label: string): number | null => {
    if (!rows || rows.length === 0) {
      partial.push(`${label}: no PSS sample`);
      return null;
    }
    const missing = rows.filter((r) => typeof r.pss_kb !== "number");
    if (missing.length > 0) {
      partial.push(
        `${label}: no PSS for ${missing.map((r) => r.process ?? "?").join(", ")}`,
      );
      return null;
    }
    return rows.reduce((a, r) => a + (r.pss_kb as number), 0);
  };
  const b = total(before, "before");
  let a = total(after, "after");
  if (a !== null && before && after) {
    if (before.some(isRenderer) && !after.some(isRenderer)) {
      partial.push("after: the receiver's renderer is missing");
      a = null;
    } else if (after.length < before.length) {
      partial.push(
        `after: ${after.length} processes against ${before.length} at the start`,
      );
      a = null;
    }
  }
  return { before: b, after: a, partial };
}

/** One arm (header). `device` is whether the sweep ran on a phone. */
export function measureArm(armDir: string, device: boolean): VpArm | undefined {
  const ev = loadDevLeg(armDir);
  if (!ev) return undefined;
  const leg = ev.leg as unknown as Record<string, unknown>;
  const arm = String(leg.arm ?? armDir.split("/").pop());
  const m = measureDevRepeat("gsw", ev);
  const intervals = windowIntervals(ev);
  const dist = distribution(intervals);
  const reasons: string[] = [];
  if (ev.exitCode !== "0")
    reasons.push(`receiver exit ${ev.exitCode ?? "missing"}`);
  if (ev.refused) reasons.push(`harness-refused ${ev.refused}`);
  if (m.window_problem) reasons.push(`window: ${m.window_problem}`);
  if (m.probe_problem) reasons.push(`probe: ${m.probe_problem}`);
  const samples = ((ev.device as { samples?: { device?: Samples } } | undefined)
    ?.samples?.device ?? null) as Samples | null;
  let foreground: VpArm["foreground"] = "unavailable";
  const chromeStop =
    readJson<unknown>(join(armDir, "chrome-stop.json")) ?? null;
  if (device) {
    if ((ev.provenance as { ok?: boolean } | undefined)?.ok !== true)
      reasons.push("device-provenance not ok");
    foreground = samples?.foreground ?? [];
    // Only a parsed package other than the browser voids; no line is unknown, never a void.
    const away = foreground.filter((f) => f.package !== null && !f.browser);
    if (away.length > 0)
      reasons.push(
        `the browser was not in front at ${away.map((f) => `${(f.t_ms / 1000).toFixed(0)} s (${f.package ?? "unknown"})`).join(", ")}`,
      );
    if (chromeStop === null) reasons.push("no Chrome force-stop recorded");
  }
  const live = (ev.applied as { live?: Record<string, unknown> } | undefined)
    ?.live;
  const gsw = (live?.gsw ?? null) as Record<string, unknown> | null;
  const surfaces = (gsw?.surfaces ?? null) as Record<string, unknown> | null;
  const gpu = samples?.gpu_memory ?? [];
  const mem = samples?.meminfo ?? [];
  const memAfter = mem.length > 1 ? mem[mem.length - 1].samples : undefined;
  const pss = pssTotals(mem[0]?.samples, memAfter);
  const gfxBefore = graphicsOf(mem[0]?.samples);
  const gfxAfter = graphicsOf(memAfter);
  const surfacePixels =
    surfaces && typeof surfaces.surface_pixels === "number"
      ? (surfaces.surface_pixels as number)
      : null;
  const pssBefore = pss.before;
  const pssAfter = pss.after;
  const gpuAfter = gpu.length > 1 ? (gpu[gpu.length - 1].bytes ?? null) : null;
  const kind = arm === "H" ? "H" : (arm[0] as "A" | "B");
  return {
    arm,
    order: typeof leg.order === "number" ? leg.order : null,
    kind,
    viewports_client: leg.viewports_client !== false,
    viewports_host: leg.viewports_host === "off" ? "off" : "on",
    void: reasons.length > 0,
    void_reasons: reasons,
    metrics: {
      drawn_fps: m.drawn,
      interval_p50_ms: dist.p50,
      interval_p95_ms: dist.p95,
      interval_p99_ms: dist.p99,
      over_34_fraction: dist.over_34_fraction,
      main_thread_p50_ms: m.main_thread_ms.p50,
      main_thread_p95_ms: m.main_thread_ms.p95,
      gsw_total_p95_ms: m.gsw_total_p95_ms,
      page_busy_fraction: m.page_busy_fraction,
      gpu_memory_after_bytes: gpuAfter,
      pss_after_kb: pssAfter,
      gpu_proc_graphics_after_kb: gfxAfter.gpu_process_kb,
      renderer_graphics_after_kb: gfxAfter.renderers_kb,
      surface_bytes: surfacePixels === null ? null : surfacePixels * 4,
    },
    frame_interval_ms: dist,
    tp_ms: m.tp_ms,
    main_thread_ms: {
      p50: m.main_thread_ms.p50,
      p95: m.main_thread_ms.p95,
      p99: m.main_thread_ms.p99,
    },
    published: m.published,
    applied: m.applied,
    credit_rtt_mean_frames: m.credit_rtt_mean_frames,
    surfaces,
    harness_stop: live?.harness_stop ?? null,
    gpu_memory_bytes: { before: gpu[0]?.bytes ?? null, after: gpuAfter },
    pss_kb: {
      before: pssBefore,
      after: pssAfter,
      by_process_after: (memAfter ?? []).map((x) => ({
        process: x.process,
        pss_kb: x.pss_kb,
      })),
      partial: device ? pss.partial : [],
    },
    graphics_kb: device
      ? { before: gfxBefore, after: gfxAfter }
      : "unavailable",
    foreground_unknown: Array.isArray(foreground)
      ? foreground.filter((f) => f.package === null).length
      : null,
    thermal: { before: m.thermal_before, after: m.thermal_after },
    battery: { before: m.battery_before, after: m.battery_after },
    derated: m.derated,
    foreground,
    chrome_stop: chromeStop,
    build:
      readJson<Record<string, unknown>>(join(armDir, "identity.json")) ?? null,
  };
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export interface Agreement {
  arms: [string, string] | null;
  spread: Record<string, number | null>;
  within: boolean | null;
}

/** Relative spread of the first two non-void arms of one kind on every reported metric. */
export function agreement(arms: readonly VpArm[]): Agreement {
  const ok = arms.filter((a) => !a.void);
  if (ok.length < 2) return { arms: null, spread: {}, within: null };
  const [x, y] = ok;
  const spread: Record<string, number | null> = {};
  for (const k of REPORT_METRICS) {
    const a = x.metrics[k];
    const b = y.metrics[k];
    spread[k] =
      a === null || b === null || a + b === 0
        ? null
        : Math.abs(a - b) / ((a + b) / 2);
  }
  const within = AGREEMENT_METRICS.every(
    (k) => spread[k] !== null && (spread[k] as number) <= AGREEMENT_MAX,
  );
  return { arms: [x.arm, y.arm], spread, within };
}

const mean = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

export interface VpSweepSummary {
  schema: "render-stream-gate7-vp-summary/1";
  run: string;
  dir: string;
  workload: string;
  window: number;
  env: "desktop" | "device";
  device: string | null;
  arms_planned: string[];
  arms: VpArm[];
  void_arms: string[];
  a_vs_a: Agreement;
  b_vs_b: Agreement;
  /** mean over non-void A arms, mean over non-void B arms, B - A and B / A, per metric. */
  a_vs_b: Record<
    string,
    {
      a: number | null;
      b: number | null;
      delta: number | null;
      /** A minus B (the cost viewports add). */
      a_minus_b: number | null;
      ratio: number | null;
    }
  >;
  host_off: VpArm | null;
  /** The memory number: surface_bytes (allocation accounting, surface_pixels x 4). The observed
   * device figures (meminfo graphics rows, gfxinfo, PSS) are in a_vs_b but are not surface cost. */
  memory: {
    surface_bytes: {
      a: number | null;
      b: number | null;
      a_minus_b: number | null;
    };
    note: string;
  };
  /** The sweep wrapper's evidence (<run>.sweep/, lib/gate7-vp-phone.sh vp_sweep_run). */
  wrapper: {
    dir: string;
    phone_lock: unknown;
    chrome_stop_final: unknown;
    events: string[];
  };
  build_check: {
    ok: boolean;
    build_ids: Record<string, string | null>;
    problems: string[];
  };
  surface_check: { ok: boolean; problems: string[] };
  admissible: boolean;
  admissible_reasons: string[];
}

export function summarizeSweep(
  runName: string,
  sweepDir: string,
): VpSweepSummary | undefined {
  const m = /^(ctl|dev-([a-z0-9]+))-gsw-w([12])-vp-([a-z0-9-]+)$/.exec(runName);
  const sweep = readJson<Record<string, unknown>>(join(sweepDir, "sweep.json"));
  if (!m || !sweep) return undefined;
  const device = m[2] ?? null;
  const planned = String(sweep.arms ?? "")
    .split(",")
    .filter(Boolean);
  const names = [...planned, ...(sweep.host_off === true ? ["H"] : [])];
  const arms: VpArm[] = [];
  const missing: string[] = [];
  for (const a of names) {
    const r = measureArm(join(sweepDir, a), device !== null);
    if (r) arms.push(r);
    else missing.push(a);
  }
  const A = arms.filter((a) => a.kind === "A");
  const B = arms.filter((a) => a.kind === "B");
  const H = arms.find((a) => a.kind === "H") ?? null;
  const aVsB: VpSweepSummary["a_vs_b"] = {};
  for (const k of REPORT_METRICS) {
    const a = mean(A.filter((x) => !x.void).map((x) => x.metrics[k]));
    const b = mean(B.filter((x) => !x.void).map((x) => x.metrics[k]));
    aVsB[k] = {
      a,
      b,
      delta: a !== null && b !== null ? b - a : null,
      a_minus_b: a !== null && b !== null ? a - b : null,
      ratio: a !== null && b !== null && a !== 0 ? b / a : null,
    };
  }
  // Build: every arm served the same bytes, matching the bundle's own build.json.
  const buildProblems: string[] = [];
  const ids: Record<string, string | null> = {};
  for (const a of arms) {
    const id = (a.build?.build_id as string | undefined) ?? null;
    ids[a.arm] = id;
    if (id === null) buildProblems.push(`${a.arm}: no identity.json`);
    else if (a.build?.bundle_matches_declared !== true)
      buildProblems.push(
        `${a.arm}: served bundle files do not match its build.json`,
      );
  }
  const distinct = [...new Set(Object.values(ids).filter((x) => x !== null))];
  if (distinct.length > 1)
    buildProblems.push(
      `build ids differ: ${arms.map((a) => `${a.arm} ${ids[a.arm]?.slice(0, 12) ?? "?"}`).join(", ")}`,
    );
  const trees = [
    ...new Set(arms.map((a) => a.build?.rs_core_tree_at_arm ?? null)),
  ];
  if (trees.length > 1)
    buildProblems.push(
      `rs_core_tree changed during the sweep: ${trees.join(", ")}`,
    );
  // Surfaces: A allocated, B skipped and allocated none.
  const surfProblems: string[] = [];
  for (const a of [...A, ...B]) {
    const s = a.surfaces;
    if (!s) {
      surfProblems.push(`${a.arm}: no live.gsw.surfaces`);
      continue;
    }
    if (a.kind === "A" && num(s.surfaces_allocated) <= 0)
      surfProblems.push(
        `${a.arm}: viewports on but surfaces_allocated ${num(s.surfaces_allocated)}`,
      );
    if (
      a.kind === "B" &&
      (num(s.surfaces_skipped) <= 0 || num(s.surfaces_allocated) > 0)
    )
      surfProblems.push(
        `${a.arm}: viewports off but surfaces_skipped ${num(s.surfaces_skipped)}, surfaces_allocated ${num(s.surfaces_allocated)}`,
      );
  }
  const wdir = join(sweepDir, "..", "..", "..", `${runName}.sweep`);
  let events: string[] = [];
  try {
    events = readFileSync(join(wdir, "events.log"), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    events = [];
  }
  const wrapper = {
    dir: wdir,
    phone_lock: readJson<unknown>(join(wdir, "phone-lock.json")) ?? null,
    chrome_stop_final:
      readJson<unknown>(join(wdir, "chrome-stop-final.json")) ?? null,
    events,
  };
  const aa = agreement(A);
  const bb = agreement(B);
  const voids = arms.filter((a) => a.void).map((a) => a.arm);
  const reasons: string[] = [];
  for (const a of missing) reasons.push(`${a}: no arm evidence`);
  for (const a of arms.filter((x) => x.void && x.kind !== "H"))
    reasons.push(`${a.arm} void: ${a.void_reasons.join("; ")}`);
  reasons.push(...buildProblems, ...surfProblems);
  if (device !== null && wrapper.phone_lock === null)
    reasons.push(
      "device sweep without the phone lock evidence (<run>.sweep/phone-lock.json)",
    );
  if (aa.within !== true)
    reasons.push(
      `A-vs-A ${aa.arms ? "spread above" : "needs two non-void A arms within"} ${AGREEMENT_MAX * 100}% on ${AGREEMENT_METRICS.join(", ")}`,
    );
  if (bb.within !== true)
    reasons.push(
      `B-vs-B ${bb.arms ? "spread above" : "needs two non-void B arms within"} ${AGREEMENT_MAX * 100}% on ${AGREEMENT_METRICS.join(", ")}`,
    );
  return {
    schema: "render-stream-gate7-vp-summary/1",
    run: runName,
    dir: sweepDir,
    workload: m[4],
    window: Number(m[3]),
    env: device !== null ? "device" : "desktop",
    device,
    arms_planned: names,
    arms,
    void_arms: voids,
    a_vs_a: aa,
    b_vs_b: bb,
    a_vs_b: aVsB,
    host_off: H,
    memory: {
      surface_bytes: {
        a: aVsB.surface_bytes.a,
        b: aVsB.surface_bytes.b,
        a_minus_b: aVsB.surface_bytes.a_minus_b,
      },
      note: MEMORY_NOTE,
    },
    wrapper,
    build_check: {
      ok: buildProblems.length === 0,
      build_ids: ids,
      problems: buildProblems,
    },
    surface_check: { ok: surfProblems.length === 0, problems: surfProblems },
    admissible: reasons.length === 0,
    admissible_reasons: reasons,
  };
}

/** Every vp sweep under <out>/gate6/. */
export function findSweeps(out: string): { run: string; dir: string }[] {
  const g6 = join(out, "gate6");
  if (!existsSync(g6)) return [];
  const found: { run: string; dir: string }[] = [];
  for (const run of readdirSync(g6).sort()) {
    const m = /^(ctl|dev-[a-z0-9]+)-gsw-w[12]-vp-([a-z0-9-]+)$/.exec(run);
    if (!m) continue;
    const dir = join(g6, run, "rates", `dev-vp-${m[2]}`);
    if (existsSync(join(dir, "sweep.json"))) found.push({ run, dir });
  }
  return found;
}
