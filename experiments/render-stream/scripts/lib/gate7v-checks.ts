// Gate 7 group g7-dev, live (G7v; protocol/gate7/g7v.md, gate7-design.md Q13c, Q13d, D25 to D28):
// the phone acceptance legs. run-gate7.sh --live --legs g7-dev runs run-gate6.sh --legs g6c once
// per browser kind and credit window with G6C_LEGS naming only `dev-` legs (lib/gate6c-legs.sh
// "G7v") into <out>/gate6/<arm>-<kind>-w<w>/, <arm> `ctl` (desktop) or `dev-<id>` (a phone). This
// file judges every such run with Q13d's decided checks and writes the acceptance statement.
//
// The measured window. Each repeat measures 20 s after 6 s, as G6c does, but anchored at the
// receiver's connection rather than the fixture's step 1, so a receiver that connects late (the
// web export needs ~10 s on the g31) is measured over the same span of its own stream:
//   - host clock: the first perf-timeline line that carries the receiver's connection, + 6 s, for
//     20 s (a soak: + 60 s, for G7V_SOAK_S); published and applied come from G6c's per-connection
//     counters over it (connectionRates);
//   - receiver clock: the same window moved by G6c's receiverClockOffset (its received_us against
//     the host time of each transaction's frame). New frames: GSW's drawing callbacks
//     (perf-timeline.jsonl `raf_ts_ms`, one line per drawn frame); the web export's main-loop
//     iterations that submitted a transaction (applied.json `submitted_process_frame`,
//     `submitted_us`). multi_apply_ticks: drawing callbacks / iterations that applied more than one
//     seq (Q13c `phase-alias`);
//   - page clock (dev-probe.json, browser-probes/dev-probe.js): from the first WebSocket message
//     + 6 s, for 20 s. T_p is the median rAF interval there; main-thread work per drawn frame is
//     the drawing callback's duration plus the `message` handlers since the previous callback
//     (GSW: its drawing callbacks, matched by rAF timestamp; the web export: every callback, one
//     Godot iteration each at --max-fps 0); the watchdog's hidden time and rAF gaps.
//
// What is not measured here, and is named `unavailable`, never passed: the trace's
// `contentUpdateHz`, activation gaps and `CrRendererMain` `tdur` (no repeat is traced in G7v; the
// probe's page-script busy fraction is reported beside the clause instead), and GPU time per drawn
// frame (no receiver reads EXT_disjoint_timer_query_webgl2; the g31 does not expose it, G7d).
//
// Pure over the run directories (no process launched); scripts/test/self-test-gate7v.ts drives
// the measures with synthetic evidence.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import {
  connectionRates,
  type ConnRates,
  finalShotPath,
  type HostWindow,
  interpolate,
  type LiveSummary,
  parseJsonl,
  type RecvApplied,
  receiverClockOffset,
  type StepEntry,
  type TimelineLine,
} from "./gate6c-checks";
import { type Gate7Check, mk } from "./gate7-adapters";
import { pacedLoopProblems } from "./gate7-live";
import { classifyShot } from "./gate7b-adapters";

export const DEV_WINDOW_START_S = 6;
export const DEV_WINDOW_S = 20;
export const SOAK_WARMUP_S = 60;
export const DEV_RATE_MIN = 57.0;
export const HOST_FRAME_MS = 1000 / 60;
/** Q13d dev-cadence: no interval above 50 ms (3H); intervals > 34 ms at most 0.5 % of drawn. */
export const CADENCE_MAX_MS = 50;
export const CADENCE_LONG_MS = 34;
export const CADENCE_LONG_FRACTION = 0.005;
/** Q13b watchdog: a rAF gap above this the receiver did not cause invalidates a repeat. */
export const WATCHDOG_GAP_MS = 250;
/** dev-presence on a device: the final readback against the desktop reference, beyond Q7's band
 * on at most this fraction of pixels (a Mali rasterizes edges its own way; parity is desktop's). */
export const DEVICE_PRESENCE_OTHER_FRACTION = 0.01;
/** G7r's phase classes (Q9): mean credit RTT in host frames. */
export const GOOD_MAX_FRAMES = 1.1;
export const BAD_MIN_FRAMES = 1.9;

export type DevKind = "web" | "gsw";

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

export interface DevLegJson {
  leg: string;
  base: string;
  run: number;
  workload: "pace" | "scene" | "hd";
  time_offset_s: number;
  soak: boolean;
  soak_s: number;
  receiver_max_fps: number;
  env: "desktop" | "device";
  receiver_words: string;
}

export interface DevProbe {
  schema?: string;
  error?: string;
  fit_applied?: boolean;
  raf?: number[];
  ws?: number[];
  mem?: number[];
  fits?: unknown[];
  first_ws_ms?: number;
  hidden_ms?: number;
}

export interface GswSample {
  seq: number;
  raf?: number;
  raf_ts_ms?: number;
  total_us: number;
  t_ms: number;
}

export interface DevLegEvidence {
  dir: string;
  leg: DevLegJson;
  steps: StepEntry[];
  timeline: TimelineLine[];
  summary: LiveSummary | undefined;
  applied: (RecvApplied & Record<string, unknown>) | undefined;
  perf: Record<string, unknown> | undefined;
  samples: GswSample[];
  probe: DevProbe | undefined;
  device: Record<string, unknown> | undefined;
  provenance: Record<string, unknown> | undefined;
  refused: string | null;
  timings: Record<string, unknown> | undefined;
  exitCode: string | null;
}

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};
const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

export function loadDevLeg(legDir: string): DevLegEvidence | undefined {
  const leg = readJson<DevLegJson>(join(legDir, "dev-leg.json"));
  if (!leg) return undefined;
  const r = join(legDir, "receiver");
  return {
    dir: legDir,
    leg,
    steps: parseJsonl<StepEntry>(readText(join(legDir, "host", "steps.jsonl"))),
    timeline: parseJsonl<TimelineLine>(
      readText(join(legDir, "host", "evidence", "perf-timeline.jsonl")),
    ),
    summary: readJson<LiveSummary>(
      join(legDir, "host", "evidence", "live-summary.json"),
    ),
    applied: readJson(join(r, "applied.json")),
    perf: readJson(join(r, "perf.json")),
    samples: parseJsonl<GswSample>(readText(join(r, "perf-timeline.jsonl"))),
    probe: readJson<DevProbe>(join(r, "dev-probe.json")),
    device: readJson(join(r, "device.json")),
    provenance: readJson(join(r, "provenance.json")),
    refused: readText(join(r, "harness-refused.txt"))?.trim() ?? null,
    timings: readJson(join(r, "timings.json")),
    exitCode: readText(join(r, "exit-code.txt"))?.trim() ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------------------------

export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

/** The receiver's connection: its stream id in the host's live summary, else the only one. */
function connectionId(ev: DevLegEvidence): number | null {
  const id = (ev.applied as { streams?: { stream_id?: string }[] } | undefined)
    ?.streams?.[0]?.stream_id;
  const conns = ev.summary?.connections ?? [];
  const c = id ? conns.find((x) => x.stream_id === id) : undefined;
  if (c && typeof c.connection === "number") return c.connection;
  return conns.length === 1 ? (conns[0].connection ?? null) : null;
}

/** The measured window on the host clock (header), or why it cannot be placed. */
export function devHostWindow(
  timeline: readonly TimelineLine[],
  connection: number | null,
  startS: number,
  lengthS: number,
): HostWindow | string {
  if (connection === null) return "no receiver connection in live-summary.json";
  const first = timeline.find((l) =>
    l.connections.some((c) => c.connection === connection),
  );
  if (!first) return `connection ${connection} never appears in perf-timeline.jsonl`;
  const startT = first.t_us + startS * 1e6;
  const endT = startT + lengthS * 1e6;
  const inside = timeline.filter((l) => l.t_us >= startT && l.t_us <= endT);
  if (inside.length < 2)
    return `only ${inside.length} perf-timeline line(s) inside the window`;
  const a = inside[0];
  const b = inside[inside.length - 1];
  if (b.t_us - a.t_us < 0.8 * lengthS * 1e6)
    return `the host timeline covers only ${((b.t_us - a.t_us) / 1e6).toFixed(1)} s of the ${lengthS}-s window (the stream ended early?)`;
  return {
    start_frame: a.frame,
    start_t_us: startT,
    end_t_us: endT,
    first: a,
    last: b,
    seconds: (b.t_us - a.t_us) / 1e6,
  };
}

/** New frames on the receiver clock (ms) with how many seqs each applied, in time order. */
export function newFrames(
  kind: DevKind,
  ev: DevLegEvidence,
): { t_ms: number; seqs: number }[] {
  const tx = (ev.applied?.transactions ?? []) as Array<Record<string, unknown>>;
  if (kind === "gsw") {
    const folded = new Map<number, number>();
    for (const t of tx)
      if (typeof t.coalesced_into === "number")
        folded.set(t.coalesced_into, (folded.get(t.coalesced_into) ?? 0) + 1);
    return ev.samples
      .filter((s) => typeof s.raf_ts_ms === "number")
      .map((s) => ({ t_ms: s.raf_ts_ms as number, seqs: 1 + (folded.get(s.seq) ?? 0) }))
      .sort((a, b) => a.t_ms - b.t_ms);
  }
  const byFrame = new Map<number, { t_us: number; seqs: number }>();
  for (const t of tx) {
    const pf = t.submitted_process_frame;
    const su = t.submitted_us;
    if (typeof pf !== "number" || typeof su !== "number") continue;
    const e = byFrame.get(pf);
    if (e) {
      e.seqs++;
      e.t_us = Math.max(e.t_us, su);
    } else byFrame.set(pf, { t_us: su, seqs: 1 });
  }
  return [...byFrame.values()]
    .map((e) => ({ t_ms: e.t_us / 1000, seqs: e.seqs }))
    .sort((a, b) => a.t_ms - b.t_ms);
}

export interface DevRepeat {
  leg: string;
  run: number;
  window_problem: string | null;
  window_s: number | null;
  published: number | null;
  applied: number | null;
  sent: number | null;
  applied_count: number | null;
  drawn: number | null;
  credit_rtt_mean_frames: number | null;
  credit_window: number;
  phase_class: "good" | "bad" | "between" | null;
  hold_p50_us: number | null;
  hold_p95_us: number | null;
  tp_ms: number | null;
  raf_count: number;
  new_frame_interval_ms: {
    p50: number | null;
    p95: number | null;
    max: number | null;
    over_34: number;
    hist_ms: Record<string, number>;
  };
  multi_apply_ticks: number;
  main_thread_ms: { p50: number | null; p95: number | null; p99: number | null; count: number };
  /** the page script's busy share of the window (rAF callbacks plus message handlers) */
  page_busy_fraction: number | null;
  gsw_total_p95_ms: number | null;
  gpu_complete_p95_ms: number | null;
  hidden_ms: number | null;
  max_raf_gap_ms: number | null;
  unexplained_gap_ms: number | null;
  thermal_before: string | null;
  thermal_after: string | null;
  battery_before: number | null;
  battery_after: number | null;
  derated: boolean | null;
  first_submitted_ms: number | null;
  probe_problem: string | null;
}

function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

const condOf = (c: unknown): { thermal: string | null; battery: number | null } => {
  const o = (c ?? {}) as Record<string, unknown>;
  const thermal =
    typeof o.thermalStatus === "string"
      ? o.thermalStatus
      : typeof o.thermal_status === "string"
        ? (o.thermal_status as string)
        : null;
  const battery =
    typeof o.batteryPct === "number"
      ? o.batteryPct
      : typeof o.battery_pct === "number"
        ? (o.battery_pct as number)
        : null;
  return { thermal, battery };
};

export function measureDevRepeat(
  kind: DevKind,
  ev: DevLegEvidence,
  windowStartS = DEV_WINDOW_START_S,
  windowS = DEV_WINDOW_S,
): DevRepeat {
  const conn = connectionId(ev);
  const w = devHostWindow(ev.timeline, conn, windowStartS, windowS);
  const hw = typeof w === "string" ? null : w;
  let rates: ConnRates | undefined;
  if (hw) rates = connectionRates(hw).find((c) => c.connection === conn);
  // Receiver clock window.
  const offset = receiverClockOffset(ev.applied, ev.timeline);
  const frames = newFrames(kind, ev);
  let inWin: { t_ms: number; seqs: number }[] = [];
  if (hw && offset !== null) {
    const t0 = (hw.start_t_us + offset) / 1000;
    const t1 = (hw.end_t_us + offset) / 1000;
    inWin = frames.filter((f) => f.t_ms >= t0 && f.t_ms <= t1);
  }
  const intervals: number[] = [];
  for (let i = 1; i < inWin.length; i++)
    intervals.push(inWin[i].t_ms - inWin[i - 1].t_ms);
  const hist: Record<string, number> = {};
  for (const iv of intervals) {
    const bin = `${Math.floor(iv / 2) * 2}`;
    hist[bin] = (hist[bin] ?? 0) + 1;
  }
  const drawn =
    hw && offset !== null && inWin.length > 1
      ? (inWin.length - 1) / ((inWin[inWin.length - 1].t_ms - inWin[0].t_ms) / 1000)
      : null;
  // Holds (G6c's: received to submitted).
  const holds = ((ev.applied?.transactions ?? []) as Array<Record<string, unknown>>)
    .filter((t) => typeof t.submitted_us === "number" && typeof t.received_us === "number")
    .map((t) => (t.submitted_us as number) - (t.received_us as number));
  // Page clock: the probe.
  const probe = ev.probe;
  let probeProblem: string | null = null;
  let tp: number | null = null;
  let mainThread: number[] = [];
  let busy: number | null = null;
  let maxGap: number | null = null;
  let unexplained: number | null = null;
  let rafCount = 0;
  if (!probe || probe.error || !Array.isArray(probe.raf)) {
    probeProblem = probe?.error ?? "no dev-probe.json";
  } else if ((probe.first_ws_ms ?? -1) < 0) {
    probeProblem = "the probe saw no WebSocket message";
  } else {
    const p0 = (probe.first_ws_ms as number) + windowStartS * 1000;
    const p1 = p0 + windowS * 1000;
    const raf: { ts: number; start: number; dur: number }[] = [];
    for (let i = 0; i + 2 < probe.raf.length; i += 3)
      raf.push({ ts: probe.raf[i], start: probe.raf[i + 1], dur: probe.raf[i + 2] });
    const ws: { start: number; dur: number }[] = [];
    for (let i = 0; i + 1 < (probe.ws ?? []).length; i += 2)
      ws.push({ start: (probe.ws as number[])[i], dur: (probe.ws as number[])[i + 1] });
    const inside = raf.filter((r) => r.start >= p0 && r.start <= p1);
    rafCount = inside.length;
    const ints: number[] = [];
    let gapMax = 0;
    let gapUnexplained = 0;
    for (let i = 1; i < inside.length; i++) {
      const gap = inside[i].ts - inside[i - 1].ts;
      ints.push(gap);
      if (gap > gapMax) gapMax = gap;
      // A gap the receiver caused: its own previous callback took most of it.
      if (inside[i - 1].dur < gap / 2 && gap > gapUnexplained) gapUnexplained = gap;
    }
    tp = median(ints);
    maxGap = inside.length > 1 ? gapMax : null;
    unexplained = inside.length > 1 ? gapUnexplained : null;
    // Main-thread work per drawn frame.
    const drawing =
      kind === "gsw"
        ? new Set(ev.samples.map((s) => s.raf_ts_ms).filter((t) => typeof t === "number"))
        : null;
    let wi = 0;
    let wsSince = 0;
    let busySum = 0;
    for (const w of ws) if (w.start >= p0 && w.start <= p1) busySum += w.dur;
    for (const r of raf) {
      while (wi < ws.length && ws[wi].start < r.start) {
        wsSince += ws[wi].dur;
        wi++;
      }
      if (r.start >= p0 && r.start <= p1) {
        busySum += r.dur;
        if (!drawing || drawing.has(r.ts)) mainThread.push(r.dur + wsSince);
      }
      wsSince = 0;
    }
    busy = busySum / (windowS * 1000);
    if (rafCount < 10) probeProblem = `only ${rafCount} rAF callbacks inside the probe window`;
  }
  mainThread = mainThread.filter((v) => Number.isFinite(v));
  // GSW's own timers, in the receiver window.
  let gswTotal: number | null = null;
  if (kind === "gsw" && hw && offset !== null) {
    const t0 = (hw.start_t_us + offset) / 1000;
    const t1 = (hw.end_t_us + offset) / 1000;
    const tot = ev.samples
      .filter((s) => typeof s.raf_ts_ms === "number" && (s.raf_ts_ms as number) >= t0 && (s.raf_ts_ms as number) <= t1)
      .map((s) => s.total_us / 1000);
    gswTotal = quantile(tot, 0.95);
  }
  const hists = (ev.perf?.histograms ?? {}) as Record<string, { p95?: number; count?: number }>;
  const gpuComplete =
    kind === "gsw" && (hists.gpu_complete_us?.count ?? 0) > 0
      ? (hists.gpu_complete_us?.p95 ?? 0) / 1000
      : null;
  const before = condOf(ev.device?.conditions_before);
  const after = condOf(ev.device?.conditions_after);
  const samples = (ev.device?.samples ?? null) as { device?: { derated?: boolean } } | null;
  const marks = (ev.timings?.marks ?? []) as { name: string; t: number }[];
  const firstSubmitted = marks.find((m) => m.name === "rs-first-submitted")?.t ?? null;
  const rtt = rates?.credit_rtt_mean_frames ?? null;
  return {
    leg: ev.leg.leg,
    run: ev.leg.run,
    window_problem: typeof w === "string" ? w : null,
    window_s: hw?.seconds ?? null,
    published: rates?.published ?? null,
    applied: rates?.applied ?? null,
    sent: rates?.sent ?? null,
    applied_count: rates?.acks ? rates.acks[1] : null,
    drawn,
    credit_rtt_mean_frames: rtt,
    credit_window: rates?.credit_window ?? 1,
    phase_class:
      rtt === null ? null : rtt <= GOOD_MAX_FRAMES ? "good" : rtt >= BAD_MIN_FRAMES ? "bad" : "between",
    hold_p50_us: median(holds),
    hold_p95_us: quantile(holds, 0.95),
    tp_ms: tp,
    raf_count: rafCount,
    new_frame_interval_ms: {
      p50: median(intervals),
      p95: quantile(intervals, 0.95),
      max: intervals.length ? Math.max(...intervals) : null,
      over_34: intervals.filter((v) => v > CADENCE_LONG_MS).length,
      hist_ms: hist,
    },
    multi_apply_ticks: inWin.filter((f) => f.seqs > 1).length,
    main_thread_ms: {
      p50: median(mainThread),
      p95: quantile(mainThread, 0.95),
      p99: quantile(mainThread, 0.99),
      count: mainThread.length,
    },
    page_busy_fraction: busy,
    gsw_total_p95_ms: gswTotal,
    gpu_complete_p95_ms: gpuComplete,
    hidden_ms: probe?.hidden_ms ?? null,
    max_raf_gap_ms: maxGap,
    unexplained_gap_ms: unexplained,
    thermal_before: before.thermal,
    thermal_after: after.thermal,
    battery_before: before.battery,
    battery_after: after.battery,
    derated: samples?.device?.derated ?? null,
    first_submitted_ms: firstSubmitted,
    probe_problem: probeProblem,
  };
}

// ---------------------------------------------------------------------------------------------
// Decided checks (pure; [] passes)
// ---------------------------------------------------------------------------------------------

const f2 = (v: number | null | undefined, d = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "?" : v.toFixed(d);

/** k: panel ticks one 60 Hz host frame needs (Q13d): 1 at 60 Hz, 2 at 90 and 120 Hz. */
export function ticksPerHostFrame(tpMs: number): number {
  return tpMs > 13 ? 1 : 2;
}

export function devRateProblems(m: DevRepeat): string[] {
  const p: string[] = [];
  if (m.window_problem) return [`r${m.run}: ${m.window_problem}`];
  if (m.drawn === null || m.drawn < DEV_RATE_MIN)
    p.push(`r${m.run}: drawn ${f2(m.drawn)}/s < ${DEV_RATE_MIN}`);
  if (m.published === null || m.published < DEV_RATE_MIN)
    p.push(`r${m.run}: published ${f2(m.published)}/s < ${DEV_RATE_MIN}`);
  if (m.sent === null || m.applied_count === null)
    p.push(`r${m.run}: no applied ack count`);
  else if (Math.abs(m.applied_count - m.sent) > 0.01 * m.sent)
    p.push(`r${m.run}: applied ${m.applied_count} not published ${m.sent} +- 1 %`);
  return p;
}

export function devCadenceProblems(m: DevRepeat): string[] {
  if (m.window_problem) return [`r${m.run}: ${m.window_problem}`];
  if (m.tp_ms === null) return [`r${m.run}: T_p unmeasured (${m.probe_problem ?? "?"})`];
  const k = ticksPerHostFrame(m.tp_ms);
  const p: string[] = [];
  const iv = m.new_frame_interval_ms;
  const bound = k * m.tp_ms + 1;
  if (iv.p95 === null || iv.p95 > bound)
    p.push(`r${m.run}: new-frame interval p95 ${f2(iv.p95)} ms > ${k}*T_p+1 = ${f2(bound)} ms`);
  if (iv.max === null || iv.max > CADENCE_MAX_MS)
    p.push(`r${m.run}: new-frame interval max ${f2(iv.max)} ms > ${CADENCE_MAX_MS}`);
  const drawnCount = Object.values(iv.hist_ms).reduce((a, b) => a + b, 0) + 1;
  if (iv.over_34 > CADENCE_LONG_FRACTION * drawnCount)
    p.push(`r${m.run}: ${iv.over_34} intervals > ${CADENCE_LONG_MS} ms (> 0.5 % of ${drawnCount})`);
  return p;
}

export function devMainThreadProblems(m: DevRepeat): string[] {
  if (m.tp_ms === null) return [`r${m.run}: T_p unmeasured (${m.probe_problem ?? "?"})`];
  const p: string[] = [];
  const mt = m.main_thread_ms;
  if (mt.count === 0) return [`r${m.run}: no drawn frame in the probe window`];
  if ((mt.p95 ?? Infinity) > 0.5 * m.tp_ms)
    p.push(`r${m.run}: main thread p95 ${f2(mt.p95)} ms > 0.5*T_p = ${f2(0.5 * m.tp_ms)}`);
  if ((mt.p99 ?? Infinity) > m.tp_ms)
    p.push(`r${m.run}: main thread p99 ${f2(mt.p99)} ms > T_p = ${f2(m.tp_ms)}`);
  if (m.page_busy_fraction !== null && m.page_busy_fraction > 0.5)
    p.push(`r${m.run}: page script busy ${f2(100 * m.page_busy_fraction, 1)} % of wall > 50 %`);
  return p;
}

export function devGpuProblems(kind: DevKind, m: DevRepeat): string[] {
  if (kind !== "gsw") return [];
  if (m.tp_ms === null) return [`r${m.run}: T_p unmeasured`];
  if (m.gpu_complete_p95_ms === null) return [`r${m.run}: no gpu_complete samples`];
  return m.gpu_complete_p95_ms > 2 * m.tp_ms
    ? [`r${m.run}: gpu_complete p95 ${f2(m.gpu_complete_p95_ms)} ms > 2*T_p = ${f2(2 * m.tp_ms)}`]
    : [];
}

export function devUnthrottledProblems(m: DevRepeat, device: boolean): string[] {
  const p: string[] = [];
  if (m.hidden_ms === null) p.push(`r${m.run}: no hidden-time record`);
  else if (m.hidden_ms > 0) p.push(`r${m.run}: hidden ${f2(m.hidden_ms, 0)} ms`);
  if (m.unexplained_gap_ms !== null && m.unexplained_gap_ms > WATCHDOG_GAP_MS)
    p.push(`r${m.run}: a ${f2(m.unexplained_gap_ms, 0)}-ms rAF gap the receiver did not cause`);
  if (device) {
    for (const [when, t] of [
      ["before", m.thermal_before],
      ["after", m.thermal_after],
    ] as const)
      if (t !== "none") p.push(`r${m.run}: thermal ${when} ${t ?? "unread"}`);
  }
  return p;
}

/** dev-presence: pace's square at its final position (presence: four quadrants in order;
 * freshness: within 2 px of the host's last x); scene and hd: the final readback against the
 * rendered reference of the host's step-11 freeze (desktop: Q7's band; device: at most 1 % of
 * pixels beyond it). */
export async function devPresenceProblems(
  ev: DevLegEvidence,
  device: boolean,
): Promise<{ problems: string[]; detail: string }> {
  const name = `r${ev.leg.run}`;
  const shot = ((ev.applied as { shots?: { final?: boolean; path?: string }[] } | undefined)
    ?.shots ?? []).find((s) => s.final === true);
  if (!shot?.path) return { problems: [`${name}: no final shot`], detail: "" };
  const got = await decodePngRgba(finalShotPath(join(ev.dir, "receiver"), shot.path));
  if (!got) return { problems: [`${name}: the final shot is unreadable`], detail: "" };
  if (ev.leg.workload === "pace") {
    const fin = (ev.steps as unknown as Record<string, unknown>[]).find((s) => s.final === true);
    if (!fin) return { problems: [`${name}: the pace host logged no final position`], detail: "" };
    const y = Number(fin.y) + 8;
    const px = (x: number, yy: number) => {
      const i = (yy * got.width + x) * 4;
      return [got.data[i], got.data[i + 1], got.data[i + 2]];
    };
    const isRed = (c: number[]) => c[0] > 200 && c[1] < 60 && c[2] < 60;
    const isGreen = (c: number[]) => c[1] > 200 && c[0] < 60 && c[2] < 60;
    // The square's left edge: the first red pixel on the row through its top quadrants.
    let left = -1;
    for (let x = 0; x < got.width; x++)
      if (isRed(px(x, y))) {
        left = x;
        break;
      }
    if (left < 0) return { problems: [`${name}: no square on row ${y}`], detail: "" };
    const p: string[] = [];
    if (!isGreen(px(left + 24, y))) p.push(`${name}: the square's top-right quadrant is not green`);
    const blue = px(left + 8, y + 16);
    if (!(blue[2] > 200 && blue[0] < 60)) p.push(`${name}: the bottom-left quadrant is not blue`);
    const dx = Math.abs(left - Number(fin.x));
    if (dx > 2) p.push(`${name}: the square is at x ${left}, the host's last x ${fin.x} (${dx} px)`);
    return { problems: p, detail: `${name}: square at x ${left} (host's last ${fin.x})` };
  }
  const refPath = join(ev.dir, "reference", "shots", "step-11.png");
  const ref = existsSync(refPath) ? await decodePngRgba(refPath) : undefined;
  if (!ref) return { problems: [`${name}: no reference (reference/shots/step-11.png)`], detail: "" };
  if (ref.width !== got.width || ref.height !== got.height)
    return {
      problems: [`${name}: ${got.width}x${got.height} vs reference ${ref.width}x${ref.height}`],
      detail: "",
    };
  const c = classifyShot(ref.data, got.data);
  const allowed = device ? Math.floor(DEVICE_PRESENCE_OTHER_FRACTION * c.pixels) : 0;
  return {
    problems:
      c.other > allowed
        ? [`${name}: ${c.other} px beyond Q7's band (allowed ${allowed}; max delta ${c.other_max_delta})`]
        : [],
    detail: `${name}: ${c.identical} identical, ${c.readback} readback, ${c.delta1} delta1, ${c.other} other of ${c.pixels}`,
  };
}

export function presentationTypedProblems(ev: DevLegEvidence): {
  problems: string[];
  detail: string;
} {
  const v = (ev.applied as { viewport?: Record<string, unknown> } | undefined)?.viewport;
  const conns = (ev.summary?.connections ?? []) as unknown as Record<string, unknown>[];
  const hello = conns[0];
  const p: string[] = [];
  const check = v?.presentation_check;
  if (check !== "ok" && check !== "mismatch")
    p.push(`r${ev.leg.run}: presentation_check ${JSON.stringify(check)} (not typed ok/mismatch)`);
  if (typeof hello?.dpr_milli !== "number" || typeof hello?.presentation_css_w !== "number")
    p.push(`r${ev.leg.run}: the host recorded no hello dpr_milli / CSS size`);
  return {
    problems: p,
    detail: `r${ev.leg.run}: check ${String(check)}, backing ${hello?.presentation_backing_w}x${hello?.presentation_backing_h}, CSS ${hello?.presentation_css_w}x${hello?.presentation_css_h}, dpr_milli ${hello?.dpr_milli}`,
  };
}

// ---------------------------------------------------------------------------------------------
// One run (kind x window x arm)
// ---------------------------------------------------------------------------------------------

export interface DevLegRow {
  base: string;
  workload: string;
  required: boolean;
  report_only: boolean;
  repeats: DevRepeat[];
  checks: Gate7Check[];
  presence_detail: string[];
}

export interface DevRunResult {
  group: "g7-dev";
  kind: DevKind;
  live: true;
  arm: string;
  device: string | null;
  window: number;
  run_dir: string;
  passed: boolean;
  checks: Gate7Check[];
  legs: DevLegRow[];
}

const SABOTAGE_FAILS: Record<string, readonly string[]> = {
  "sabotage-ack-on-receipt-scene": ["credit-from-paced-loop"],
  "sabotage-draw-repeat-8-pace": ["dev-gpu-headroom", "dev-rate"],
  "sabotage-draw-repeat-8-scene": ["dev-gpu-headroom", "dev-rate"],
  "sabotage-draw-repeat-8-hd": ["dev-gpu-headroom", "dev-rate"],
};

const isSoak = (base: string) => base.startsWith("soak-") || base.startsWith("sabotage-soak-");
const isStartup = (base: string) => base.startsWith("startup-");

/** The decided soak clauses (Q13d dev-soak) over one soak repeat. */
export function soakClauses(
  kind: DevKind,
  ev: DevLegEvidence,
  device: boolean,
): { clause: string; problems: string[]; detail: string }[] {
  const out: { clause: string; problems: string[]; detail: string }[] = [];
  const soakS = ev.leg.soak_s;
  const first = measureDevRepeat(kind, ev, SOAK_WARMUP_S, 60);
  const last = measureDevRepeat(kind, ev, SOAK_WARMUP_S + soakS - 60, 60);
  out.push({
    clause: "rate-last-60s",
    problems:
      last.drawn === null || last.drawn < DEV_RATE_MIN
        ? [`drawn over the last 60 s ${f2(last.drawn)}/s < ${DEV_RATE_MIN}${last.window_problem ? ` (${last.window_problem})` : ""}`]
        : [],
    detail: `drawn first/last 60 s ${f2(first.drawn)}/${f2(last.drawn)}/s`,
  });
  const mf = first.main_thread_ms.p95;
  const ml = last.main_thread_ms.p95;
  out.push({
    clause: "main-thread-drift",
    problems:
      mf === null || ml === null
        ? ["main-thread p95 unmeasured"]
        : ml > 1.1 * mf
          ? [`main-thread p95 last 60 s ${f2(ml)} ms > 1.1 x first ${f2(mf)}`]
          : [],
    detail: `main-thread p95 first/last ${f2(mf)}/${f2(ml)} ms`,
  });
  const samples = (ev.device?.samples ?? null) as {
    device?: {
      conditions?: { t_ms: number; thermalStatusCode?: number; thermalStatus?: string }[];
      meminfo?: { t_ms: number; samples: { pid: number; process: string | null; pss_kb: number | null }[] }[];
      gpu_memory?: { t_ms: number; bytes: number | null }[];
      derated?: boolean;
    };
    js_heap?: { t_ms: number; used_bytes: number | null }[];
  } | null;
  if (!device) {
    out.push({
      clause: "device-samplers",
      problems: [],
      detail: "desktop control arm: thermal, PSS and gfxinfo are device-only (unavailable)",
    });
    return out;
  }
  const d = samples?.device;
  const cond = d?.conditions ?? [];
  const hot = cond.filter((c) => (c.thermalStatusCode ?? (c.thermalStatus === "none" ? 0 : 1)) !== 0);
  out.push({
    clause: "thermal",
    problems: cond.length === 0 ? ["no condition samples"] : hot.length > 0 ? [`${hot.length} sample(s) with thermal status above none`] : [],
    detail: `${cond.length} samples, derated ${d?.derated ?? "?"}`,
  });
  // PSS per process name: renderer / gpu (first and last 30 s medians, slope, peak).
  const mem = d?.meminfo ?? [];
  const endT = mem.length ? mem[mem.length - 1].t_ms : 0;
  const byProc = new Map<string, [number, number][]>();
  for (const m of mem)
    for (const s of m.samples)
      if (s.pss_kb !== null) {
        const key = s.process ?? `pid ${s.pid}`;
        const arr = byProc.get(key) ?? [];
        arr.push([m.t_ms, s.pss_kb * 1024]);
        byProc.set(key, arr);
      }
  const pssProblems: string[] = [];
  const pssDetail: string[] = [];
  for (const [proc, pts] of byProc) {
    if (/browser/.test(proc) && !/sandboxed|privileged|gpu/i.test(proc)) continue;
    const firstMed = median(pts.filter(([t]) => t <= (pts[0]?.[0] ?? 0) + 30_000).map(([, v]) => v));
    const lastMed = median(pts.filter(([t]) => t >= endT - 30_000).map(([, v]) => v));
    const peak = Math.max(...pts.map(([, v]) => v));
    const n = pts.length;
    const mt = pts.reduce((a, [t]) => a + t, 0) / n;
    const mv = pts.reduce((a, [, v]) => a + v, 0) / n;
    const slope =
      pts.reduce((a, [t, v]) => a + (t - mt) * (v - mv), 0) /
      Math.max(1, pts.reduce((a, [t]) => a + (t - mt) ** 2, 0)); // bytes per ms
    const slopeMiBMin = (slope * 60_000) / 2 ** 20;
    const growMiB = firstMed !== null && lastMed !== null ? (lastMed - firstMed) / 2 ** 20 : null;
    pssDetail.push(`${proc}: +${f2(growMiB, 1)} MiB, ${f2(slopeMiBMin, 2)} MiB/min, peak ${f2(peak / 2 ** 20, 0)} MiB`);
    if (growMiB === null || growMiB > 16) pssProblems.push(`${proc}: PSS grew ${f2(growMiB, 1)} MiB > 16`);
    if (slopeMiBMin > 2) pssProblems.push(`${proc}: PSS slope ${f2(slopeMiBMin, 2)} MiB/min > 2`);
    if (/sandboxed|renderer/.test(proc) && peak > 512 * 2 ** 20)
      pssProblems.push(`${proc}: renderer PSS peak ${f2(peak / 2 ** 20, 0)} MiB > 512`);
  }
  out.push({
    clause: "pss",
    problems: byProc.size === 0 ? ["no PSS samples"] : pssProblems,
    detail: pssDetail.join("; "),
  });
  // gfxinfo GPU memory: end vs its value at 60 s (+8 MiB).
  const gm = (d?.gpu_memory ?? []).filter((g) => g.bytes !== null) as { t_ms: number; bytes: number }[];
  const at60 = gm.find((g) => g.t_ms >= 60_000) ?? gm[0];
  const gEnd = gm[gm.length - 1];
  out.push({
    clause: "gpu-memory",
    problems:
      !at60 || !gEnd
        ? ["no gfxinfo GPU memory samples"]
        : gEnd.bytes > at60.bytes + 8 * 2 ** 20
          ? [`gfxinfo GPU memory ${f2(gEnd.bytes / 2 ** 20, 1)} MiB at the end > ${f2(at60.bytes / 2 ** 20, 1)} at 60 s + 8 MiB`]
          : [],
    detail: at60 && gEnd ? `gfxinfo GPU memory ${f2(at60.bytes / 2 ** 20, 1)} -> ${f2(gEnd.bytes / 2 ** 20, 1)} MiB` : "",
  });
  if (kind === "gsw") {
    const js = (samples?.js_heap ?? []).filter((x) => x.used_bytes !== null) as { t_ms: number; used_bytes: number }[];
    const j0 = js.find((x) => x.t_ms >= 60_000) ?? js[0];
    const j1 = js[js.length - 1];
    const minutes = j0 && j1 ? (j1.t_ms - j0.t_ms) / 60_000 : 0;
    const grow = j0 && j1 ? (j1.used_bytes - j0.used_bytes) / 2 ** 20 : null;
    out.push({
      clause: "js-heap",
      problems:
        grow === null
          ? ["no JS heap samples"]
          : grow > 4 || (minutes > 0 && grow / minutes > 0.5)
            ? [`JS heap grew ${f2(grow, 2)} MiB (${f2(minutes > 0 ? grow / minutes : 0, 2)} MiB/min)`]
            : [],
      detail: grow === null ? "" : `JS heap +${f2(grow, 2)} MiB over ${f2(minutes, 1)} min`,
    });
  } else {
    const memArr = ev.probe?.mem ?? [];
    const wasm: [number, number][] = [];
    for (let i = 0; i + 2 < memArr.length; i += 3)
      if (memArr[i + 2] > 0) wasm.push([memArr[i], memArr[i + 2]]);
    const base = (ev.probe?.first_ws_ms ?? 0) + 60_000;
    const w60 = wasm.find(([t]) => t >= base) ?? wasm[0];
    const wEnd = wasm[wasm.length - 1];
    out.push({
      clause: "wasm-heap",
      problems:
        !w60 || !wEnd
          ? ["no wasm heap samples"]
          : wEnd[1] > w60[1] + 16 * 2 ** 20
            ? [`wasm heap ${f2(wEnd[1] / 2 ** 20, 1)} MiB > ${f2(w60[1] / 2 ** 20, 1)} at 60 s + 16`]
            : [],
      detail: w60 && wEnd ? `wasm heap ${f2(w60[1] / 2 ** 20, 1)} -> ${f2(wEnd[1] / 2 ** 20, 1)} MiB` : "",
    });
  }
  return out;
}

export async function checkDevRun(
  runDir: string,
  kind: DevKind,
  window: number,
  arm: string,
  device: string | null,
  requiredWorkloads: readonly string[],
): Promise<DevRunResult> {
  const g6c = join(runDir, "rates");
  const legDirs = existsSync(g6c)
    ? readdirSync(g6c).filter((d) => d.startsWith("dev-") && existsSync(join(g6c, d, "dev-leg.json")))
    : [];
  const evs = legDirs
    .map((d) => loadDevLeg(join(g6c, d)))
    .filter((e): e is DevLegEvidence => e !== undefined);
  const bases = [...new Set(evs.map((e) => e.leg.base))];
  const isDevice = device !== null;
  const legs: DevLegRow[] = [];
  const runChecks: Gate7Check[] = [];
  for (const base of bases) {
    const all = evs.filter((e) => e.leg.base === base).sort((a, b) => a.leg.run - b.leg.run);
    // r0 is the discarded warmup (a soak or sabotage leg has one run, r1).
    const judged = all.filter((e) => e.leg.run >= 1);
    const workload = all[0].leg.workload;
    const sabotage = base.startsWith("sabotage-");
    const reportOnly =
      base.startsWith("maxfps60-") || (!requiredWorkloads.includes(workload) && !isStartup(base));
    const required = !reportOnly && !sabotage;
    const repeats = judged.map((e) => measureDevRepeat(kind, e));
    const checks: Gate7Check[] = [];
    const id = (c: string) => `${c}@${kind}-w${window}:${base}`;
    const gating = !reportOnly && !sabotage;
    const provenance: string[] = [];
    for (const e of judged) {
      if (e.refused) provenance.push(`r${e.leg.run}: harness-refused ${e.refused}`);
      else if (isDevice && (e.provenance as { ok?: boolean } | undefined)?.ok !== true)
        provenance.push(`r${e.leg.run}: device-provenance not ok`);
      if (e.exitCode !== "0") provenance.push(`r${e.leg.run}: receiver exit ${e.exitCode}`);
    }
    checks.push(
      mk(id(isDevice ? "device-provenance" : "receiver-ran"), "every repeat ran (device: device-provenance held)", provenance, `${judged.length} repeat(s) ran`, gating),
    );
    const presence: string[] = [];
    const presenceDetail: string[] = [];
    if (isStartup(base)) {
      const ms = repeats.map((r) => r.first_submitted_ms).filter((v): v is number => v !== null);
      const med = median(ms);
      const max = ms.length ? Math.max(...ms) : null;
      const warm = base === "startup-warm";
      checks.push(
        mk(
          id("dev-startup"),
          warm ? "warm: navigation -> first submitted median <= 3 s and max <= 5 s over five repeats" : "cold: reported (D15's marks)",
          !warm
            ? []
            : ms.length < judged.length
              ? [`${judged.length - ms.length} repeat(s) without rs-first-submitted`]
              : [
                  ...((med ?? Infinity) > 3000 ? [`median ${f2(med, 0)} ms > 3000`] : []),
                  ...((max ?? Infinity) > 5000 ? [`max ${f2(max, 0)} ms > 5000`] : []),
                ],
          `navigation -> first submitted median ${f2(med, 0)} ms, max ${f2(max, 0)} ms (${ms.map((v) => v.toFixed(0)).join(", ")})`,
          warm,
        ),
      );
      legs.push({ base, workload, required: warm, report_only: !warm, repeats, checks, presence_detail: [] });
      continue;
    }
    if (isSoak(base)) {
      const e = judged[0];
      if (!e) continue;
      const clauses = soakClauses(kind, e, isDevice);
      const failing = clauses.filter((c) => c.problems.length > 0).map((c) => c.clause);
      if (base.startsWith("sabotage-soak-leak-gl-textures")) {
        const want = isDevice ? ["gpu-memory"] : [];
        const exact = JSON.stringify(failing) === JSON.stringify(want);
        checks.push(
          mk(id("sabotage-fails-exactly"), "leak-gl-textures fails exactly dev-soak's GPU-memory clause", exact ? [] : [`failed ${JSON.stringify(failing)}, want ${JSON.stringify(want)}`], `failed exactly ${JSON.stringify(failing)}`, isDevice),
        );
      } else {
        checks.push(
          mk(id("dev-soak"), "Q13d dev-soak's decided clauses", clauses.flatMap((c) => c.problems.map((p) => `${c.clause}: ${p}`)), clauses.map((c) => `${c.clause}: ${c.detail}`).join("; "), gating),
        );
      }
      legs.push({ base, workload, required, report_only: reportOnly, repeats, checks, presence_detail: clauses.map((c) => `${c.clause}: ${c.detail}`) });
      continue;
    }
    for (const e of judged) {
      const pr = await devPresenceProblems(e, isDevice);
      presence.push(...pr.problems);
      presenceDetail.push(pr.detail);
    }
    const tpLabel = repeats.map((r) => f2(r.tp_ms)).join("/");
    const rate = repeats.flatMap(devRateProblems);
    const cadence = repeats.flatMap(devCadenceProblems);
    const fail: Record<string, string[]> = {
      "dev-rate": judged.length < 1 ? ["no repeat"] : rate,
      "dev-cadence": cadence,
      "dev-main-thread": repeats.flatMap(devMainThreadProblems),
      "dev-gpu": repeats.flatMap((m) => devGpuProblems(kind, m)),
      "dev-unthrottled": repeats.flatMap((m) => devUnthrottledProblems(m, isDevice)),
      "dev-presence": presence,
      "dev-presentation-typed": judged.flatMap((e) => presentationTypedProblems(e).problems),
      "credit-from-paced-loop": judged.flatMap((e) => pacedLoopProblems(`r${e.leg.run}`, e.applied)),
    };
    if (base.startsWith("gpu-headroom-") || base.startsWith("sabotage-draw-repeat-"))
      fail["dev-gpu-headroom"] = [...rate, ...cadence];
    const crit: Record<string, string> = {
      "dev-rate": "drawn >= 57/s, published >= 57/s, applied = published +- 1 %, every repeat",
      "dev-cadence": "new-frame interval p95 <= k*T_p + 1 ms, max <= 50 ms, > 34 ms on <= 0.5 % (trace contentUpdateHz: unavailable, not traced)",
      "dev-main-thread": "main-thread work per drawn frame p95 <= 0.5*T_p, p99 <= T_p; page-script busy <= 50 % (CrRendererMain tdur: unavailable, not traced)",
      "dev-gpu": "gsw gpu_complete p95 <= 2*T_p (GPU time per drawn frame: unavailable, no timer query)",
      "dev-unthrottled": "Q13b watchdog: no hidden time, no rAF gap > 250 ms the receiver did not cause; thermal none before and after (device)",
      "dev-presence": "the final readback holds the workload's presence and freshness markers",
      "dev-presentation-typed": "the presentation check is typed (ok/mismatch) and the hello's CSS size and dpr_milli recorded (Q13a: mismatch expected on a phone, never a failure)",
      "credit-from-paced-loop": "Q9: every submitted ack from the paced loop",
      "dev-gpu-headroom": "with RS_RECEIVER_DRAW_REPEAT, dev-rate and dev-cadence still pass",
    };
    const ok: Record<string, string> = {
      "dev-rate": repeats.map((r) => `r${r.run} pub ${f2(r.published)} drawn ${f2(r.drawn)}`).join("; "),
      "dev-cadence": repeats.map((r) => `r${r.run} p95 ${f2(r.new_frame_interval_ms.p95)} max ${f2(r.new_frame_interval_ms.max)} (T_p ${f2(r.tp_ms)})`).join("; "),
      "dev-main-thread": repeats.map((r) => `r${r.run} p95 ${f2(r.main_thread_ms.p95)} p99 ${f2(r.main_thread_ms.p99)}`).join("; "),
      "dev-gpu": kind === "gsw" ? repeats.map((r) => `r${r.run} gpu_complete p95 ${f2(r.gpu_complete_p95_ms)}`).join("; ") : "web: GPU time unavailable (no timer query read)",
      "dev-unthrottled": `hidden 0, max rAF gap ${repeats.map((r) => f2(r.max_raf_gap_ms, 0)).join("/")} ms`,
      "dev-presence": presenceDetail.join("; "),
      "dev-presentation-typed": judged.map((e) => presentationTypedProblems(e).detail).join("; "),
      "credit-from-paced-loop": "every submitted ack from the paced loop",
      "dev-gpu-headroom": `T_p ${tpLabel}`,
    };
    for (const [c, problems] of Object.entries(fail))
      checks.push(mk(id(c), crit[c] ?? c, problems, ok[c] ?? "", gating && c !== "credit-from-paced-loop" ? true : gating));
    if (sabotage) {
      const want = SABOTAGE_FAILS[base] ?? [];
      const failing = Object.entries(fail)
        .filter(([, p]) => p.length > 0)
        .map(([c]) => c)
        .sort();
      const missing = want.filter((c) => !failing.includes(c));
      // g7v.md: ack-on-receipt fails EXACTLY credit-from-paced-loop; draw-repeat-8 must fail
      // dev-gpu-headroom and dev-rate (whatever else a GPU-bound receiver also misses).
      const exact = base === "sabotage-ack-on-receipt-scene";
      const extra = exact ? failing.filter((c) => !want.includes(c)) : [];
      checks.push(
        mk(
          id(exact ? "sabotage-fails-exactly" : "sabotage-fails"),
          `${base} fails ${exact ? "exactly " : ""}${JSON.stringify(want)}`,
          [...(missing.length ? [`did not fail ${missing.join(", ")}`] : []), ...(extra.length ? [`also failed ${extra.join(", ")}`] : [])],
          `failed ${JSON.stringify(failing)}`,
          true,
        ),
      );
    }
    legs.push({ base, workload, required, report_only: reportOnly, repeats, checks, presence_detail: presenceDetail });
  }
  if (legs.length === 0) runChecks.push(mk(`g7-dev-ran@${kind}-w${window}`, "the run holds dev legs", ["no dev-* leg with dev-leg.json"], "", true));
  const checks = [...runChecks, ...legs.flatMap((l) => l.checks)];
  // Desktop control arms are report-only (Q13d): their checks never gate.
  if (!isDevice) for (const c of checks) c.gating = false;
  return {
    group: "g7-dev",
    kind,
    live: true,
    arm,
    device,
    window,
    run_dir: runDir,
    passed: checks.every((c) => c.passed || !c.gating),
    checks,
    legs,
  };
}

/** The acceptance statement per receiver (Q13d "Acceptance"): met at window 1, met at window 2
 * only, or not met, with the failing checks; the stretch workloads beside it. */
export function acceptance(
  results: readonly DevRunResult[],
  requiredWorkloads: readonly string[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const kind of ["gsw", "web"] as const) {
    const runs = results.filter((r) => r.kind === kind);
    if (runs.length === 0) continue;
    const startup = runs.flatMap((r) => r.legs).filter((l) => l.base === "startup-warm");
    const soak = runs.flatMap((r) => r.legs).filter((l) => l.base.startsWith("soak-"));
    const headroom = runs.flatMap((r) => r.legs).filter((l) => l.base.startsWith("gpu-headroom-"));
    const perWindow: Record<string, unknown> = {};
    let metAt: number | null = null;
    for (const w of [1, 2]) {
      const run = runs.find((r) => r.window === w);
      if (!run) continue;
      const failing: string[] = [];
      for (const wl of requiredWorkloads) {
        const leg = run.legs.find((l) => l.base === wl);
        if (!leg) {
          failing.push(`${wl}: not run`);
          continue;
        }
        for (const c of leg.checks)
          if (!c.passed && c.id.split("@")[0] !== "credit-from-paced-loop") failing.push(c.id);
          else if (!c.passed) failing.push(c.id);
        if (kind === "gsw") {
          const h = headroom.find((l) => l.base === `gpu-headroom-${wl}`);
          if (!h) failing.push(`dev-gpu-headroom:${wl}: not run`);
          else for (const c of h.checks) if (!c.passed && c.id.startsWith("dev-gpu-headroom")) failing.push(c.id);
        }
      }
      for (const l of [...startup, ...soak])
        for (const c of l.checks) if (!c.passed && c.gating) failing.push(c.id);
      if (startup.length === 0) failing.push("dev-startup: not run");
      if (soak.length === 0) failing.push("dev-soak: not run");
      perWindow[`w${w}`] = { met: failing.length === 0, failing };
      if (failing.length === 0 && metAt === null) metAt = w;
    }
    const stretch: Record<string, unknown> = {};
    for (const run of runs)
      for (const l of run.legs)
        if (!requiredWorkloads.includes(l.workload) && !l.base.startsWith("maxfps") && !l.base.startsWith("startup") && !l.base.startsWith("sabotage"))
          stretch[`${l.base}@w${run.window}`] = l.checks.filter((c) => !c.passed).map((c) => c.id);
    out.push({
      kind,
      statement: metAt === 1 ? "met at window 1" : metAt === 2 ? "met at window 2 only (opt-in, F1)" : "not met",
      windows: perWindow,
      stretch_failing: stretch,
    });
  }
  return out;
}

/** The report's device rows (Q12 "Device rows"), one per repeat, in /2's stage names. */
export function deviceRows(results: readonly DevRunResult[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const r of results)
    for (const l of r.legs)
      for (const m of l.repeats)
        rows.push({
          provenance_env: { kind: r.device ? "device" : "desktop", device_id: r.device, panel: { raf_interval_p50_us: m.tp_ms === null ? null : Math.round(m.tp_ms * 1000), mode_hz: m.tp_ms ? Math.round(1000 / m.tp_ms) : null, mode_source: "raf" } },
          receiver_kind: r.kind === "gsw" ? "gsw-canvas" : "web-export",
          credit_window: r.window,
          leg: `${r.arm}:${l.base}`,
          run: m.run,
          stages: {
            published_hz: m.published,
            applied_hz: m.applied,
            drawn_hz: m.drawn,
            recv_main_thread_us: { p50: m.main_thread_ms.p50 === null ? null : m.main_thread_ms.p50 * 1000, p95: m.main_thread_ms.p95 === null ? null : m.main_thread_ms.p95 * 1000, p99: m.main_thread_ms.p99 === null ? null : m.main_thread_ms.p99 * 1000 },
            recv_gpu_time_us: "unavailable",
            recv_gpu_complete_us: m.gpu_complete_p95_ms === null ? null : { p95: m.gpu_complete_p95_ms * 1000 },
            recv_new_frame_interval_us: { p50: m.new_frame_interval_ms.p50 === null ? null : m.new_frame_interval_ms.p50 * 1000, p95: m.new_frame_interval_ms.p95 === null ? null : m.new_frame_interval_ms.p95 * 1000, max: m.new_frame_interval_ms.max === null ? null : m.new_frame_interval_ms.max * 1000, hist_ms: m.new_frame_interval_ms.hist_ms },
            recv_credit_rtt_host_frames: m.credit_rtt_mean_frames,
            recv_multi_apply_ticks: m.multi_apply_ticks,
            recv_hold_us: { p50: m.hold_p50_us, p95: m.hold_p95_us },
            content_update_hz: "unavailable",
            activation_gap_ms: "unavailable",
          },
          phase_class: r.window === 1 ? m.phase_class : null,
          device: { thermal_before: m.thermal_before, thermal_after: m.thermal_after, battery_before: m.battery_before, battery_after: m.battery_after, derated: m.derated, hidden_ms: m.hidden_ms, max_raf_gap_ms: m.max_raf_gap_ms },
          startup: m.first_submitted_ms === null ? null : { first_submitted_ms: m.first_submitted_ms },
        });
  return rows;
}

export async function writeDevSummary(
  out: string,
  results: readonly DevRunResult[],
  requiredWorkloads: readonly string[],
): Promise<void> {
  await writeFile(
    join(out, "g7v-summary.json"),
    `${JSON.stringify(
      {
        schema: "render-stream-gate7-dev-summary/1",
        acceptance: acceptance(results.filter((r) => r.device !== null), requiredWorkloads),
        control_acceptance: acceptance(results.filter((r) => r.device === null), requiredWorkloads),
        device_rows: deviceRows(results),
      },
      null,
      2,
    )}\n`,
  );
}

/** Unused helper kept for the self-test: interpolate a host time at a frame. */
export const hostTimeAt = (timeline: readonly TimelineLine[], frame: number) =>
  interpolate(
    timeline.map((l): [number, number] => [l.frame, l.t_us]),
    frame,
  );
