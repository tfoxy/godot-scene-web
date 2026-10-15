// Gate 6 group g6c (protocol/gate6-design.md "G6c", Q7b, Q7d): publication rates (15, 30, 60,
// uncapped), rate mismatch, two receivers on one host, an injected receiver delay kept apart from
// a GPU-limited receiver, and a constrained transport, on render-stream/6, plus one validated
// single-repeat render-stream-report/1 per leg (the plumbing G6p reuses for its five repeats).
//
// Every rate is measured over Q6c's window, game time [6 s, 26 s] of the `rate` timeline: from
// step 1's applied host frame (game time 6 s, steps.jsonl) for 20 s of the host's steady clock,
// with the host frame -> clock mapping read from evidence/perf-timeline.jsonl (one line per second
// since arm). Host-side counts (frames, sends, acks per stage, credit-blocked ticks, bytes) are the
// cumulative counters of the first and last timeline lines inside the window, so a rate is an
// exact count over an exact interval of about 19 s. The receiver frame rate counts frames drawn
// (perf.json timeline `frames`, D9's frame_post_draw count) over the same window moved onto the
// receiver's clock by the median of (received_us - host time of the transaction's frame).
// Presented is `unavailable` (D9). Pixel judgements follow G6l's rule (never a nominal frame): the
// receiver's final shot names its transaction's host frame, which must be at or after step 11's
// applied frame, and the reference is the fixture rendered with the host's own step-11 leftovers
// (`freeze` in steps.jsonl, RS_FIXTURE_FREEZE_STATE), whole frame, budget 0.
//
// Pure over an evidence directory written by run-gate6.sh's run_g6c (lib/gate6c-legs.sh), or over
// values read from one, so scripts/test/self-test-gate6c.ts drives the evaluators with synthetic
// values. Nothing here launches a process except `git rev-parse` for the report's run block.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { buildReport } from "../report-gate6";
import {
  decodePngRgba,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import { readExitCode } from "./gate0-checks";
import { QUEUED_SLACK_BYTES } from "./gate1-live-checks";
import { check } from "./gate5-checks";
import type { Gate6Check } from "./gate6a-checks";
import { probeGamescopeVersion } from "./provenance";
import { decodeRecord, splitRecords } from "./render-stream-2";
import {
  RATE_NAMES,
  type RateName,
  type ReportDist,
  type ReportRate,
  type ReportRepeat,
  type ReportScenario,
  validate,
} from "./render-stream-report";

// ---------------------------------------------------------------------------------------------
// Legs (lib/gate6c-legs.sh, mirrored)
// ---------------------------------------------------------------------------------------------

export const G6C_DIR = "rates";
export const G6C_WINDOW_S = 20;
/** Q7d: receiver frame rate at --max-fps 60 */
export const G6C_RECV60_RANGE: readonly [number, number] = [57, 61];
export const G6C_SABOTAGE_LEG = "sabotage-constrained-ignore-credit";
/** Q7d: the sabotage must fail exactly these. */
export const G6C_SABOTAGE_FAILS: readonly string[] = [
  "pending-bounded",
  "queue-bounded",
];

export type G6cKind =
  | "baseline"
  | "rate"
  | "uncapped-host60"
  | "uncapped"
  | "mismatch-60-recv30"
  | "mismatch-15-recv60"
  | "dual"
  | "recv-delay"
  | "gpu-heavy"
  | "constrained"
  | "sabotage";

export interface G6cLeg {
  leg: string;
  kind: G6cKind;
  fixture: "gate6-scene" | "gate6-hd";
  variant: "animate" | "gpu-heavy";
  target_fps: number | null;
  host_max_fps: number;
  /** one per receiver directory, in order (dual: receiver-a, receiver-b) */
  receivers: { dir: string; max_fps: number }[];
  transport: "loopback" | "constrained";
  connections: number;
  hook_log: "on" | "off";
  /** where payloads travel: fetched over HTTP, or every one inline (the sabotage) */
  delivery: "http" | "inline";
  expected_class: string;
}

const scene = (
  leg: string,
  kind: G6cKind,
  target: number | null,
  hostFps: number,
  recvFps: number | null,
  extra: Partial<G6cLeg> = {},
): G6cLeg => ({
  leg,
  kind,
  fixture: "gate6-scene",
  variant: "animate",
  target_fps: target,
  host_max_fps: hostFps,
  receivers: recvFps === null ? [] : [{ dir: "receiver", max_fps: recvFps }],
  transport: "loopback",
  connections: recvFps === null ? 0 : 1,
  hook_log: "off",
  delivery: "http",
  expected_class: "success",
  ...extra,
});

export const G6C_LEGS: readonly G6cLeg[] = [
  scene("rate-baseline", "baseline", null, 60, null),
  scene("rate-15", "rate", 15, 60, 60),
  scene("rate-30", "rate", 30, 60, 60),
  scene("rate-60", "rate", 60, 60, 60),
  scene("rate-uncapped-host60", "uncapped-host60", null, 60, 60),
  scene("rate-uncapped", "uncapped", null, 0, 0),
  scene("mismatch-60-recv30", "mismatch-60-recv30", 60, 60, 30),
  scene("mismatch-15-recv60", "mismatch-15-recv60", 15, 60, 60),
  scene("dual-60-15", "dual", null, 60, null, {
    receivers: [
      { dir: "receiver-a", max_fps: 60 },
      { dir: "receiver-b", max_fps: 15 },
    ],
    connections: 2,
  }),
  scene("recv-delay", "recv-delay", 60, 60, 60),
  scene("constrained", "constrained", 60, 60, 60, {
    transport: "constrained",
  }),
  scene(G6C_SABOTAGE_LEG, "sabotage", 60, 60, 60, {
    transport: "constrained",
    hook_log: "on",
    delivery: "inline",
    expected_class: "delivery-violation",
  }),
  {
    leg: "gpu-heavy",
    kind: "gpu-heavy",
    fixture: "gate6-hd",
    variant: "gpu-heavy",
    target_fps: 60,
    host_max_fps: 60,
    receivers: [{ dir: "receiver", max_fps: 60 }],
    transport: "loopback",
    connections: 1,
    hook_log: "off",
    delivery: "http",
    expected_class: "success",
  },
];

// ---------------------------------------------------------------------------------------------
// Evidence shapes
// ---------------------------------------------------------------------------------------------

export interface PerfHist {
  count?: number;
  sum?: number;
  min?: number;
  max?: number;
  mean?: number;
  buckets?: [number, number][];
}

export interface HostPerf {
  histograms?: Record<string, PerfHist | Record<string, PerfHist>>;
  unavailable_stages?: { stage: string; reason: string }[];
  cpu?: { main_thread_us?: number | null; io_thread_us?: number | null };
}

export interface TimelineConn {
  connection: number;
  sent: number;
  credits: number;
  coalesced: number;
  ticks_credit_blocked: number;
  max_pending_age_us: number;
  bytes_sent: number;
  acks?: [number, number, number];
  max_in_flight?: number;
  max_queued_bytes?: number;
  credit_rtt_count?: number;
  credit_rtt_sum_us?: number;
  credit_rtt_frames_sum?: number;
}

export interface TimelineLine {
  t_us: number;
  frame: number;
  rss_bytes?: number;
  connections: TimelineConn[];
}

export interface RttSummary {
  count?: number;
  min?: number;
  median?: number;
  p95?: number;
  max?: number;
}

export interface SummaryConn {
  connection?: number;
  stream_id?: string | null;
  sent?: number;
  coalesced?: number;
  max_pending?: number;
  pending_episodes?: number;
  max_pending_age_us?: number;
  sent_without_credit?: number;
  max_in_flight?: number;
  max_queued_bytes?: number;
  max_message_sent?: number;
  bytes_sent?: number;
  resource_bytes?: number;
  http_gets?: number;
  http_bytes?: number;
  ticks_credit_blocked?: number;
  credit_rtt_us?: RttSummary;
}

export interface LiveSummary {
  connections?: SummaryConn[];
  publication?: { mode?: string; target_fps?: number | null };
  resources?: {
    retained_max?: number;
    retained_bytes_max?: number;
    pinned?: number;
  };
}

export interface StepEntry {
  step: number;
  applied_frame: number;
  settle_frame: number;
  freeze?: unknown[];
}

export interface RecvTimelineLine {
  t_us: number;
  frames?: number;
  rss_bytes?: number;
  texture_mem_bytes?: number;
  /** G6s: live RIDs per kind (null before the session) */
  live_rids?: Record<string, number> | null;
  video_mem_bytes?: number;
}

export interface RecvPerf {
  histograms?: Record<string, PerfHist>;
  render_time?: Record<string, { status?: string; value?: number | null }>;
  rendering_method?: string;
  adapter?: { vendor?: string; name?: string; api_version?: string };
  timeline?: RecvTimelineLine[];
}

export interface RecvShot {
  stream?: number;
  seq?: number;
  frame?: number;
  final?: boolean;
  path?: string;
}

export interface RecvApplied {
  status?: string;
  failure?: unknown;
  unsupported?: unknown[];
  streams?: { stream_id?: string | null }[];
  transactions?:
    | {
        stream?: number;
        seq: number;
        frame: number;
        received_us?: number;
        applied_us?: number;
        submitted_us?: number;
      }[]
    | null;
  shots?: RecvShot[];
  cache?: { entries_after?: number; bytes_after?: number };
  resources_summary?: Record<string, number>;
}

export interface ProcSampleLine {
  tsMs: number;
  status: { vmRssBytes: number; vmHwmBytes: number };
  threadCpu: { tid: number; comm: string; cpuSeconds: number }[];
}

export interface ReceiverEvidence {
  dir: string;
  max_fps: number;
  exit: number | null;
  applied: RecvApplied | undefined;
  perf: RecvPerf | undefined;
  samples: ProcSampleLine[];
  record_bytes: number[];
}

export interface G6cLegEvidence {
  def: G6cLeg;
  dir: string;
  present: boolean;
  host_exit: number | null;
  steps: StepEntry[];
  timeline: TimelineLine[];
  perf: HostPerf | undefined;
  summary: LiveSummary | undefined;
  samples: ProcSampleLine[];
  receivers: ReceiverEvidence[];
  proxy: Record<string, unknown> | undefined;
  reference_shot: string;
}

function parseJsonl<T>(text: string | undefined): T[] {
  const out: T[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a line cut by a kill is not evidence
    }
  }
  return out;
}

/** Each transaction record's byte length in a received live stream (render-stream/6). */
export function transactionRecordBytes(data: Uint8Array): number[] {
  const { records } = splitRecords(data, 6);
  const out: number[] = [];
  for (const raw of records) {
    const decoded = decodeRecord(raw, 6);
    if (decoded.record?.meta.type === "transaction") out.push(raw.byte_length);
  }
  return out;
}

export async function loadG6cLeg(
  ratesDir: string,
  def: G6cLeg,
): Promise<G6cLegEvidence> {
  const dir = join(ratesDir, def.leg);
  const host = join(dir, "host");
  const receivers: ReceiverEvidence[] = [];
  for (const r of def.receivers) {
    const rdir = join(dir, r.dir);
    let recordBytes: number[] = [];
    try {
      recordBytes = transactionRecordBytes(
        new Uint8Array(await readFile(join(rdir, "received.rs2"))),
      );
    } catch {
      recordBytes = [];
    }
    receivers.push({
      dir: rdir,
      max_fps: r.max_fps,
      exit: await readExitCode(rdir),
      applied: await readJson<RecvApplied>(join(rdir, "applied.json")),
      perf: await readJson<RecvPerf>(join(rdir, "perf.json")),
      samples: parseJsonl<ProcSampleLine>(
        await readTextOrUndefined(join(rdir, "proc-samples.jsonl")),
      ),
      record_bytes: recordBytes,
    });
  }
  const stepsText = await readTextOrUndefined(join(host, "steps.jsonl"));
  return {
    def,
    dir,
    present: stepsText !== undefined,
    host_exit: await readExitCode(host),
    steps: parseJsonl<StepEntry>(stepsText),
    timeline: parseJsonl<TimelineLine>(
      await readTextOrUndefined(join(host, "evidence", "perf-timeline.jsonl")),
    ),
    perf: await readJson<HostPerf>(join(host, "evidence", "perf.json")),
    summary: await readJson<LiveSummary>(
      join(host, "evidence", "live-summary.json"),
    ),
    samples: parseJsonl<ProcSampleLine>(
      await readTextOrUndefined(join(host, "proc-samples.jsonl")),
    ),
    receivers,
    proxy: await readJson<Record<string, unknown>>(
      join(dir, "proxy", "stats.json"),
    ),
    reference_shot: join(dir, "reference", "shots", "step-11.png"),
  };
}

// ---------------------------------------------------------------------------------------------
// Histograms (render-stream-capture-perf/1 and render-stream-receiver-perf/1: 16 sub-buckets per
// octave, each bucket named by its lower bound)
// ---------------------------------------------------------------------------------------------

/** The width of the log-linear bucket whose lower bound is `lower` (at least 1). */
export function bucketWidth(lower: number): number {
  if (lower <= 1) return 1;
  const octave = Math.floor(Math.log2(lower));
  return Math.max(1, 2 ** octave / 16);
}

/** The p-th percentile (0..100) of a histogram, interpolated linearly inside its bucket and
 * clamped to the exact min and max; null when empty. */
export function histPercentile(
  h: PerfHist | undefined,
  p: number,
): number | null {
  const buckets = h?.buckets ?? [];
  const total = buckets.reduce((n, [, c]) => n + c, 0);
  if (total === 0) return null;
  const rank = (p / 100) * total;
  let seen = 0;
  for (const [lower, count] of buckets) {
    if (seen + count >= rank) {
      const within = count === 0 ? 0 : (rank - seen) / count;
      const value = lower + within * bucketWidth(lower);
      const lo = h?.min ?? Number.NEGATIVE_INFINITY;
      const hi = h?.max ?? Number.POSITIVE_INFINITY;
      return Math.min(hi, Math.max(lo, value));
    }
    seen += count;
  }
  return h?.max ?? null;
}

function hostHist(
  perf: HostPerf | undefined,
  path: string,
): PerfHist | undefined {
  let cur: unknown = perf?.histograms;
  for (const seg of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur as PerfHist | undefined;
}

// ---------------------------------------------------------------------------------------------
// The window and the rates
// ---------------------------------------------------------------------------------------------

/** Linear interpolation of y at x over points sorted by x (clamped to the ends). */
export function interpolate(
  points: readonly [number, number][],
  x: number,
): number | null {
  if (points.length === 0) return null;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return x1 === x0 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

export interface HostWindow {
  /** step 1's applied frame (game time 6 s) and its host time */
  start_frame: number;
  start_t_us: number;
  end_t_us: number;
  /** the timeline lines whose counters bound the measured interval */
  first: TimelineLine;
  last: TimelineLine;
  seconds: number;
}

/** Q6c's measured window on the host clock (null, with why, when the evidence cannot place it). */
export function hostWindow(
  steps: readonly StepEntry[],
  timeline: readonly TimelineLine[],
  windowS = G6C_WINDOW_S,
): HostWindow | string {
  const step1 = steps.find((s) => s.step === 1);
  if (!step1) return "steps.jsonl has no step 1";
  const points = timeline.map((l): [number, number] => [l.frame, l.t_us]);
  const startT = interpolate(points, step1.applied_frame);
  if (startT === null) return "perf-timeline.jsonl is empty";
  const endT = startT + windowS * 1e6;
  const inside = timeline.filter((l) => l.t_us >= startT && l.t_us <= endT);
  if (inside.length < 2)
    return `only ${inside.length} perf-timeline line(s) inside the window`;
  const first = inside[0];
  const last = inside[inside.length - 1];
  if (last.t_us - first.t_us < 0.8 * windowS * 1e6)
    return `the timeline covers only ${((last.t_us - first.t_us) / 1e6).toFixed(1)} s of the window`;
  return {
    start_frame: step1.applied_frame,
    start_t_us: startT,
    end_t_us: endT,
    first,
    last,
    seconds: (last.t_us - first.t_us) / 1e6,
  };
}

export interface ConnRates {
  connection: number;
  published: number;
  received: number | null;
  applied: number | null;
  submitted: number | null;
  credits: number;
  sent: number;
  acks: [number, number, number] | null;
  ticks_credit_blocked: number;
  bytes_per_s: number;
  /** the window's mean credit round trip, in microseconds and in host frame callbacks */
  credit_rtt_mean_us: number | null;
  credit_rtt_mean_frames: number | null;
}

/** Per connection: counts and rates between the window's first and last timeline lines. A
 * connection absent from the first line (connected inside the window) is skipped. */
export function connectionRates(w: HostWindow): ConnRates[] {
  const out: ConnRates[] = [];
  for (const end of w.last.connections) {
    const start = w.first.connections.find(
      (c) => c.connection === end.connection,
    );
    if (!start) continue;
    const acks: [number, number, number] | null =
      start.acks && end.acks
        ? [
            end.acks[0] - start.acks[0],
            end.acks[1] - start.acks[1],
            end.acks[2] - start.acks[2],
          ]
        : null;
    const rttCount =
      (end.credit_rtt_count ?? 0) - (start.credit_rtt_count ?? 0);
    const hasRtt =
      end.credit_rtt_count !== undefined &&
      start.credit_rtt_count !== undefined &&
      rttCount > 0;
    out.push({
      connection: end.connection,
      credit_rtt_mean_us: hasRtt
        ? ((end.credit_rtt_sum_us ?? 0) - (start.credit_rtt_sum_us ?? 0)) /
          rttCount
        : null,
      credit_rtt_mean_frames: hasRtt
        ? ((end.credit_rtt_frames_sum ?? 0) -
            (start.credit_rtt_frames_sum ?? 0)) /
          rttCount
        : null,
      sent: end.sent - start.sent,
      published: (end.sent - start.sent) / w.seconds,
      received: acks ? acks[0] / w.seconds : null,
      applied: acks ? acks[1] / w.seconds : null,
      submitted: acks ? acks[2] / w.seconds : null,
      credits: end.credits - start.credits,
      acks,
      ticks_credit_blocked:
        end.ticks_credit_blocked - start.ticks_credit_blocked,
      bytes_per_s: (end.bytes_sent - start.bytes_sent) / w.seconds,
    });
  }
  return out;
}

export function hostFrameRate(w: HostWindow): number {
  return (w.last.frame - w.first.frame) / w.seconds;
}

/** The receiver's clock minus the host's (µs): the median over its transactions of received_us
 * minus the host time of the transaction's frame. */
export function receiverClockOffset(
  applied: RecvApplied | undefined,
  timeline: readonly TimelineLine[],
): number | null {
  const points = timeline.map((l): [number, number] => [l.frame, l.t_us]);
  const offsets: number[] = [];
  for (const t of applied?.transactions ?? []) {
    if (typeof t.received_us !== "number") continue;
    const host = interpolate(points, t.frame);
    if (host !== null) offsets.push(t.received_us - host);
  }
  if (offsets.length === 0) return null;
  offsets.sort((a, b) => a - b);
  return offsets[Math.floor(offsets.length / 2)];
}

/** Frames drawn per second over the host window moved onto the receiver's clock. */
export function receiverFrameRate(
  r: ReceiverEvidence,
  w: HostWindow,
  timeline: readonly TimelineLine[],
): number | null {
  const offset = receiverClockOffset(r.applied, timeline);
  const lines = (r.perf?.timeline ?? []).filter(
    (l) => typeof l.frames === "number",
  );
  if (offset === null || lines.length < 2) return null;
  const points = lines.map((l): [number, number] => [l.t_us, l.frames ?? 0]);
  const t0 = w.start_t_us + offset;
  const t1 = w.end_t_us + offset;
  if (t0 < points[0][0] || t1 > points[points.length - 1][0]) return null;
  const f0 = interpolate(points, t0);
  const f1 = interpolate(points, t1);
  if (f0 === null || f1 === null) return null;
  return (f1 - f0) / ((t1 - t0) / 1e6);
}

/** The receiver's live stream id, matched against live-summary.json's connections. */
export function connectionOf(
  r: ReceiverEvidence,
  summary: LiveSummary | undefined,
): SummaryConn | undefined {
  const id = r.applied?.streams?.[0]?.stream_id;
  if (!id) return undefined;
  return summary?.connections?.find((c) => c.stream_id === id);
}

// ---------------------------------------------------------------------------------------------
// Derived per-leg measurements
// ---------------------------------------------------------------------------------------------

export interface ReceiverMeasure {
  dir: string;
  max_fps: number;
  connection: number | null;
  receiver_frame: number | null;
  frame_interval_p50_us: number | null;
  gpu_render_p50_us: number | null;
  cpu_render_p50_us: number | null;
  hold_p50_us: number | null;
  /** the receiver's read-to-submitted-ack time: the phase-free part of the credit RTT */
  hold_p95_us: number | null;
}

export interface G6cMeasure {
  leg: string;
  window: HostWindow | null;
  window_problem: string | null;
  host_frame: number | null;
  conns: ConnRates[];
  receivers: ReceiverMeasure[];
  frame_interval_p95_us: number | null;
  callback_p50_us: number | null;
  snapshot_count: number | null;
  callback_count: number | null;
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function measureLeg(ev: G6cLegEvidence): G6cMeasure {
  const w = hostWindow(ev.steps, ev.timeline);
  const window = typeof w === "string" ? null : w;
  const receivers: ReceiverMeasure[] = ev.receivers.map((r) => {
    const conn = connectionOf(r, ev.summary);
    const holds = (r.applied?.transactions ?? [])
      .filter(
        (t) =>
          typeof t.submitted_us === "number" &&
          typeof t.received_us === "number",
      )
      .map((t) => (t.submitted_us ?? 0) - (t.received_us ?? 0));
    return {
      dir: basename(r.dir),
      max_fps: r.max_fps,
      connection: conn?.connection ?? null,
      receiver_frame: window ? receiverFrameRate(r, window, ev.timeline) : null,
      frame_interval_p50_us: histPercentile(
        r.perf?.histograms?.frame_interval_us,
        50,
      ),
      gpu_render_p50_us: histPercentile(r.perf?.histograms?.gpu_render_us, 50),
      cpu_render_p50_us: histPercentile(r.perf?.histograms?.cpu_render_us, 50),
      hold_p50_us: median(holds),
      hold_p95_us: quantile(holds, 0.95),
    };
  });
  return {
    leg: ev.def.leg,
    window,
    window_problem: typeof w === "string" ? w : null,
    host_frame: window ? hostFrameRate(window) : null,
    conns: window ? connectionRates(window) : [],
    receivers,
    frame_interval_p95_us: histPercentile(
      hostHist(ev.perf, "frame_interval_us"),
      95,
    ),
    callback_p50_us: histPercentile(hostHist(ev.perf, "frame_callback_us"), 50),
    snapshot_count: hostHist(ev.perf, "snapshot_us")?.count ?? null,
    callback_count: hostHist(ev.perf, "frame_callback_us")?.count ?? null,
  };
}

/** The connection a receiver of the leg spoke on (its rates), or the only one. */
export function connRatesOf(
  m: G6cMeasure,
  receiverIndex = 0,
): ConnRates | undefined {
  const id = m.receivers[receiverIndex]?.connection;
  if (id !== null && id !== undefined)
    return m.conns.find((c) => c.connection === id);
  return m.conns.length === 1 ? m.conns[0] : undefined;
}

/** The credit capacity of a connection over the window (gate6-design.md "As built (G6c)" 2): a
 * host that sends only at frame callbacks, with one transaction in flight, can publish at most
 * one transaction per credit round trip counted in its own callbacks, so host frames per second
 * over the window's mean credit RTT in host frames. A prompt host (it sends at the callback that
 * consumes the credit) publishes exactly this; a host that sat on credits publishes less. */
export function creditCapacity(
  m: G6cMeasure,
  c: ConnRates | undefined,
): number | null {
  if (!c || m.host_frame === null || !c.credit_rtt_mean_frames) return null;
  return m.host_frame / c.credit_rtt_mean_frames;
}

/** min(nominal, credit capacity): what a prompt host can publish (null capacity: nominal). */
function promptBound(nominal: number, capacity: number | null): number {
  return capacity === null ? nominal : Math.min(nominal, capacity);
}

const within = (v: number, lo: number, hi: number): boolean =>
  v >= lo && v <= hi;
const fmt = (v: number | null | undefined, d = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "?" : v.toFixed(d);

// ---------------------------------------------------------------------------------------------
// Evaluators (pure): each returns its problems ([] passes)
// ---------------------------------------------------------------------------------------------

function windowProblems(m: G6cMeasure): string[] {
  return m.window ? [] : [`no measured window: ${m.window_problem}`];
}

/** rate-15/-30/-60 and mismatch-15-recv60 (Q7d, as built): published within [0.95 x min(target,
 * credit capacity), 1.02 x target] -- never above the target, and below it only by what the
 * credit round trip explains; applied within 2 % of published; submitted = applied +- 1; the
 * receiver at [57, 61] frames per second. */
export function evaluateRateAchieved(
  m: G6cMeasure,
  target: number,
  opts: { appliedChecks: boolean },
): string[] {
  const p = windowProblems(m);
  const c = connRatesOf(m);
  if (!c) return [...p, "no connection was streaming through the window"];
  const capacity = creditCapacity(m, c);
  const lo = 0.95 * promptBound(target, capacity);
  if (!within(c.published, lo, 1.02 * target))
    p.push(
      `published ${fmt(c.published)}/s outside [${fmt(lo)}, ${fmt(1.02 * target)}] (0.95 x min(target ${target}, credit capacity ${fmt(capacity)}/s))`,
    );
  if (opts.appliedChecks) {
    if (!c.acks) p.push("the host timeline carries no ack counts");
    else {
      const [, applied, submitted] = c.acks;
      if (Math.abs(applied - c.sent) > 0.02 * c.sent)
        p.push(`applied ${applied} not within 2 % of published ${c.sent}`);
      if (Math.abs(submitted - applied) > 1)
        p.push(`submitted ${submitted} != applied ${applied} +- 1`);
    }
  }
  const rf = m.receivers[0]?.receiver_frame ?? null;
  if (rf === null) p.push("receiver frame rate unmeasured");
  else if (!within(rf, G6C_RECV60_RANGE[0], G6C_RECV60_RANGE[1]))
    p.push(
      `receiver frame rate ${fmt(rf)}/s outside [${G6C_RECV60_RANGE[0]}, ${G6C_RECV60_RANGE[1]}]`,
    );
  return p;
}

/** rate-uncapped-host60 (as built): published >= 0.95 x min(host frame rate, credit capacity). */
export function evaluatePublishedVsHost(m: G6cMeasure): string[] {
  const p = windowProblems(m);
  const c = connRatesOf(m);
  if (!c || m.host_frame === null) return [...p, "no streaming connection"];
  const capacity = creditCapacity(m, c);
  if (capacity === null) p.push("no credit round trip inside the window");
  const bound = promptBound(m.host_frame, capacity);
  if (c.published < 0.95 * bound)
    p.push(
      `published ${fmt(c.published)}/s < 0.95 x min(host frame rate ${fmt(m.host_frame)}/s, credit capacity ${fmt(capacity)}/s)`,
    );
  return p;
}

export interface LimitedBy {
  limited_by: "host-frame" | "credit" | "transport" | null;
  published: number | null;
  host_frame: number | null;
  credit_capacity: number | null;
  credit_rtt_mean_us: number | null;
  credit_rtt_mean_frames: number | null;
  receiver_hold_p50_us: number | null;
  /** the part of the credit RTT the constrained link adds (0 on loopback; linkRttUs) */
  link_rtt_us: number;
  /** link_rtt_us / credit_rtt_mean_us */
  link_share: number | null;
}

/** What bounds publication: `host-frame` when published reaches 0.95 of the host frame rate;
 * otherwise, when it reaches 0.95 of the credit capacity, `transport` when the part of the
 * credit RTT the link adds (`linkRttUs`, 0 on loopback) is at least half the window's mean credit
 * RTT, else `credit` (the receiver's frame wait and hold);
 * null when neither explains it (a host sitting on credits). */
export function limitedBy(
  m: G6cMeasure,
  receiverIndex = 0,
  linkRttUs = 0,
): LimitedBy {
  const c = connRatesOf(m, receiverIndex);
  const capacity = creditCapacity(m, c);
  const rtt = c?.credit_rtt_mean_us ?? null;
  const hold = m.receivers[receiverIndex]?.hold_p50_us ?? null;
  const share = rtt !== null && rtt > 0 ? linkRttUs / rtt : null;
  let limited: LimitedBy["limited_by"] = null;
  if (c && m.host_frame !== null) {
    if (c.published >= 0.95 * m.host_frame) limited = "host-frame";
    else if (capacity !== null && c.published >= 0.95 * capacity)
      limited = share !== null && share > 0.5 ? "transport" : "credit";
  }
  return {
    limited_by: limited,
    published: c?.published ?? null,
    host_frame: m.host_frame,
    credit_capacity: capacity,
    credit_rtt_mean_us: rtt,
    credit_rtt_mean_frames: c?.credit_rtt_mean_frames ?? null,
    receiver_hold_p50_us: hold,
    link_rtt_us: linkRttUs,
    link_share: share,
  };
}

export function evaluateLimitedBy(m: G6cMeasure, l: LimitedBy): string[] {
  const p = windowProblems(m);
  if (l.published === null || l.host_frame === null)
    return [...p, "no streaming connection"];
  const bound = promptBound(l.host_frame, l.credit_capacity);
  if (l.published < 0.95 * bound)
    p.push(
      `published ${fmt(l.published)}/s < 0.95 x min(host ${fmt(l.host_frame)}, credit capacity ${fmt(l.credit_capacity)})`,
    );
  if (l.limited_by === null) p.push("no limit explains the published rate");
  return p;
}

/** mismatch-60-recv30 (Q7d, as built): the slower receiver sets the pace -- published at least
 * 0.95 x min(60, credit capacity) and at most 1.05 x the receiver frame rate (one per receiver
 * frame) -- and ticks were credit-blocked inside the window. */
export function evaluateMismatch60Recv30(m: G6cMeasure): string[] {
  const p = windowProblems(m);
  const c = connRatesOf(m);
  const rf = m.receivers[0]?.receiver_frame ?? null;
  if (!c || rf === null)
    return [...p, "no connection or no receiver frame rate"];
  const capacity = creditCapacity(m, c);
  const lo = 0.95 * promptBound(60, capacity);
  if (!within(c.published, lo, 1.05 * rf))
    p.push(
      `published ${fmt(c.published)}/s outside [0.95 x min(60, credit capacity ${fmt(capacity)}/s), 1.05 x receiver frame rate ${fmt(rf)}/s]`,
    );
  if (c.ticks_credit_blocked <= 0)
    p.push("no tick was credit-blocked inside the window");
  return p;
}

/** host-unperturbed (Q7d): frame-interval p95 within 5 % and frame rate within 2 % of baseline. */
export function evaluateHostUnperturbed(
  m: G6cMeasure,
  base: G6cMeasure | undefined,
): string[] {
  const p = windowProblems(m);
  if (!base || base.host_frame === null || base.frame_interval_p95_us === null)
    return [...p, "rate-baseline has no measurement"];
  if (m.host_frame === null || m.frame_interval_p95_us === null)
    return [...p, "no host measurement"];
  const p95 = m.frame_interval_p95_us / base.frame_interval_p95_us - 1;
  const rate = m.host_frame / base.host_frame - 1;
  if (Math.abs(p95) > 0.05)
    p.push(
      `frame-interval p95 ${fmt(m.frame_interval_p95_us, 0)} us vs baseline ${fmt(base.frame_interval_p95_us, 0)} us (${fmt(100 * p95, 1)} %)`,
    );
  if (Math.abs(rate) > 0.02)
    p.push(
      `host frame rate ${fmt(m.host_frame)}/s vs baseline ${fmt(base.host_frame)}/s (${fmt(100 * rate, 1)} %)`,
    );
  return p;
}

/** dual-60-15 (Q7d `dual-independent`, as built): the host serves each receiver promptly
 * whatever the other does (each published >= 0.95 x min(nominal, its own credit capacity); A's
 * nominal is 60, B's its host frame rate) and never faster than its receiver draws (B <= 1.05 x
 * its frame rate); A's receiver hold p95 (its read to its submitted ack, the phase-free part of
 * the credit RTT) is within 10 % of rate-uncapped-host60's; one snapshot copy per host frame. */
export function evaluateDual(
  m: G6cMeasure,
  referenceHoldP95Us: number | null,
): string[] {
  const p = windowProblems(m);
  const a = connRatesOf(m, 0);
  const b = connRatesOf(m, 1);
  if (!a || !b || m.host_frame === null)
    return [...p, "two streaming connections were not both found"];
  const capA = creditCapacity(m, a);
  if (a.published < 0.95 * promptBound(60, capA))
    p.push(
      `A published ${fmt(a.published)}/s < 0.95 x min(60, its credit capacity ${fmt(capA)}/s)`,
    );
  const holdA = m.receivers[0]?.hold_p95_us ?? null;
  if (holdA === null || referenceHoldP95Us === null)
    p.push("A's or rate-uncapped-host60's receiver hold p95 is missing");
  else if (Math.abs(holdA / referenceHoldP95Us - 1) > 0.1)
    p.push(
      `A's receiver hold p95 ${fmt(holdA, 0)} us vs rate-uncapped-host60's ${fmt(referenceHoldP95Us, 0)} us (${fmt(100 * (holdA / referenceHoldP95Us - 1), 1)} %)`,
    );
  const capB = creditCapacity(m, b);
  const bf = m.receivers[1]?.receiver_frame ?? null;
  if (b.published < 0.95 * promptBound(m.host_frame, capB))
    p.push(
      `B published ${fmt(b.published)}/s < 0.95 x min(host, its credit capacity ${fmt(capB)}/s)`,
    );
  if (bf === null) p.push("B's receiver frame rate unmeasured");
  else if (b.published > 1.05 * bf)
    p.push(
      `B published ${fmt(b.published)}/s above 1.05 x its frame rate ${fmt(bf)}/s`,
    );
  if (m.snapshot_count === null || m.callback_count === null)
    p.push("perf.json lacks snapshot or callback counts");
  else if (m.snapshot_count > m.callback_count)
    p.push(
      `${m.snapshot_count} snapshot copies over ${m.callback_count} frame callbacks (more than one per frame)`,
    );
  return p;
}

export type SeparationClass = "gpu-limited" | "injected-delay" | "neither";

/** Q7d `separation`: GPU-bound when the GPU time is at least 0.8 of the frame interval; an
 * injected delay when the frame interval is at least 40 ms while the GPU needs at most 5 ms. */
export function separationClass(
  frameP50Us: number | null,
  gpuP50Us: number | null,
): SeparationClass {
  if (frameP50Us === null || gpuP50Us === null) return "neither";
  if (gpuP50Us >= 0.8 * frameP50Us) return "gpu-limited";
  if (frameP50Us >= 40_000 && gpuP50Us <= 5_000) return "injected-delay";
  return "neither";
}

export function evaluateSeparation(
  m: G6cMeasure,
  expected: SeparationClass,
): string[] {
  const r = m.receivers[0];
  if (!r) return ["no receiver"];
  const got = separationClass(r.frame_interval_p50_us, r.gpu_render_p50_us);
  return got === expected
    ? []
    : [
        `classified ${got}, expected ${expected} (frame interval p50 ${fmt(r.frame_interval_p50_us, 0)} us, GPU p50 ${fmt(r.gpu_render_p50_us, 0)} us, CPU render p50 ${fmt(r.cpu_render_p50_us, 0)} us)`,
      ];
}

/** constrained: credit RTT p50 >= 60 ms (2 x 30 ms of one-way delay). */
export function evaluateCreditRtt(conn: SummaryConn | undefined): string[] {
  const median = conn?.credit_rtt_us?.median;
  if (median === undefined) return ["live-summary.json has no credit RTT"];
  return median >= 60_000 ? [] : [`credit RTT p50 ${median} us < 60000 us`];
}

/** Q7c `pending-bounded`: one pending target, one in flight, one transaction queued (+ control). */
export function evaluatePendingBounded(
  conn: SummaryConn | undefined,
): string[] {
  if (!conn) return ["no connection summary"];
  const p: string[] = [];
  if ((conn.max_pending ?? 0) > 1) p.push(`max_pending ${conn.max_pending}`);
  if ((conn.max_in_flight ?? 0) > 1)
    p.push(`max_in_flight ${conn.max_in_flight}`);
  const limit = (conn.max_message_sent ?? 0) + QUEUED_SLACK_BYTES;
  if ((conn.max_queued_bytes ?? 0) > limit)
    p.push(
      `max_queued_bytes ${conn.max_queued_bytes} > one transaction (${conn.max_message_sent}) + ${QUEUED_SLACK_BYTES}`,
    );
  return p;
}

/** Q7d `queue-bounded`: the host's queue never holds more than its largest message + 64 KiB. */
export function evaluateQueueBounded(conn: SummaryConn | undefined): string[] {
  if (!conn) return ["no connection summary"];
  const limit = (conn.max_message_sent ?? 0) + 65_536;
  return (conn.max_queued_bytes ?? 0) <= limit
    ? []
    : [
        `max_queued_bytes ${conn.max_queued_bytes} > largest message ${conn.max_message_sent} + 65536`,
      ];
}

/** The class of a g6c leg: success, delivery-violation (sends without credit or several in
 * flight), replay-failure or unsupported (any receiver), host-failure. */
export function legClass(ev: G6cLegEvidence): {
  cls: string;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!ev.present) return { cls: "not-run", reasons: ["the leg did not run"] };
  if (ev.host_exit !== 0) reasons.push(`host exit ${ev.host_exit}`);
  for (const r of ev.receivers) {
    if (r.applied?.status !== "ok")
      return {
        cls: "replay-failure",
        reasons: [
          `${basename(r.dir)}: ${r.applied?.status ?? "no applied.json"} ${JSON.stringify(r.applied?.failure ?? null)}`,
        ],
      };
    if ((r.applied?.unsupported ?? []).length > 0)
      return {
        cls: "unsupported",
        reasons: [
          `${basename(r.dir)}: ${JSON.stringify(r.applied?.unsupported)}`,
        ],
      };
    if (r.exit !== 0) reasons.push(`${basename(r.dir)} exit ${r.exit}`);
  }
  for (const c of ev.summary?.connections ?? []) {
    if ((c.sent_without_credit ?? 0) > 0 || (c.max_in_flight ?? 0) > 1)
      return {
        cls: "delivery-violation",
        reasons: [
          ...reasons,
          `connection ${c.connection}: ${c.sent_without_credit} sends without credit, up to ${c.max_in_flight} in flight`,
        ],
      };
  }
  if (reasons.length > 0) return { cls: "host-failure", reasons };
  return { cls: "success", reasons };
}

// ---------------------------------------------------------------------------------------------
// final-latest-state
// ---------------------------------------------------------------------------------------------

export async function finalLatestState(
  ev: G6cLegEvidence,
): Promise<{ problems: string[]; detail: string[] }> {
  const problems: string[] = [];
  const detail: string[] = [];
  const step11 = ev.steps.find((s) => s.step === 11);
  if (!step11) problems.push("the host logged no step 11");
  const ref = await decodePngRgba(ev.reference_shot);
  if (!ref) problems.push(`no reference ${ev.reference_shot}`);
  for (const r of ev.receivers) {
    const name = basename(r.dir);
    const shot = (r.applied?.shots ?? []).find((s) => s.final === true);
    if (!shot?.path) {
      problems.push(`${name}: no final shot`);
      continue;
    }
    if (step11 && (shot.frame ?? -1) < step11.applied_frame)
      problems.push(
        `${name}: the final shot is of frame ${shot.frame}, before step 11 at ${step11.applied_frame}`,
      );
    const got = await decodePngRgba(shot.path);
    if (!got || !ref) {
      problems.push(`${name}: the final shot could not be decoded`);
      continue;
    }
    if (got.width !== ref.width || got.height !== ref.height) {
      problems.push(
        `${name}: ${got.width}x${got.height} vs reference ${ref.width}x${ref.height}`,
      );
      continue;
    }
    let differ = 0;
    for (let i = 0; i < got.data.length; i += 4)
      if (
        got.data[i] !== ref.data[i] ||
        got.data[i + 1] !== ref.data[i + 1] ||
        got.data[i + 2] !== ref.data[i + 2] ||
        got.data[i + 3] !== ref.data[i + 3]
      )
        differ++;
    detail.push(
      `${name} seq ${shot.seq} frame ${shot.frame} (step 11 at ${step11?.applied_frame ?? "?"}): ${differ} px differ`,
    );
    if (differ > 0)
      problems.push(
        `${name}: ${differ} px differ from the reference's step 11`,
      );
  }
  return { problems, detail };
}

// ---------------------------------------------------------------------------------------------
// render-stream-report/1, one repeat per leg (Q7f; "validated, not aggregated")
// ---------------------------------------------------------------------------------------------

const HOST_STAGE_MAP: [string, string][] = [
  ["host_frame_interval_us", "frame_interval_us"],
  ["host_callback_us", "frame_callback_us"],
  ["snapshot_us", "snapshot_us"],
  ["diff_us", "diff_us"],
  ["encode_us", "encode_us"],
  ["enqueue_us", "enqueue_us"],
  ["texture_copy_us", "texture_copy_us"],
  ["texture_hash_us", "texture_hash_us"],
  ["mesh_copy_us", "mesh_copy_us"],
  ["mesh_hash_us", "mesh_hash_us"],
  ["shader_copy_us", "shader_copy_us"],
  ["param_decode_us", "param_decode_us"],
  ["http_serve_us", "http_serve_us"],
];

function dist(
  h: PerfHist | undefined,
  unit: string,
  source: string,
  opts: { scale?: number; unavailable?: string; notApplicable?: string } = {},
): ReportDist {
  const scale = opts.scale ?? 1;
  const empty = (status: ReportDist["status"]): ReportDist => ({
    status,
    unit,
    count: 0,
    min: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    max: 0,
    mean: 0,
    source: null,
  });
  if (opts.unavailable) return empty("unavailable");
  if (!h?.count)
    return empty(opts.notApplicable ? "not-applicable" : "unavailable");
  const pct = (p: number): number => (histPercentile(h, p) ?? 0) * scale;
  return {
    status: "measured",
    unit,
    count: h.count,
    min: (h.min ?? 0) * scale,
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    max: (h.max ?? 0) * scale,
    mean: (h.mean ?? 0) * scale,
    source,
  };
}

function exactDist(values: number[], unit: string, source: string): ReportDist {
  if (values.length === 0)
    return {
      status: "not-applicable",
      unit,
      count: 0,
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      mean: 0,
      source: null,
    };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
  return {
    status: "measured",
    unit,
    count: s.length,
    min: s[0],
    p50: q(50),
    p95: q(95),
    p99: q(99),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    source,
  };
}

function rate(
  value: number | null,
  source: string,
  notApplicable?: string,
): ReportRate {
  if (notApplicable)
    return {
      value: null,
      unit: "1/s",
      status: "not-applicable",
      source: null,
      reason: notApplicable,
    };
  if (value === null)
    return {
      value: null,
      unit: "1/s",
      status: "unavailable",
      source: null,
      reason: "not measurable from this leg's evidence",
    };
  return { value, unit: "1/s", status: "measured", source, reason: null };
}

/** Least-squares slope of (minutes, bytes). */
function slopePerMin(points: [number, number][]): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const mx = points.reduce((a, [x]) => a + x, 0) / n;
  const my = points.reduce((a, [, y]) => a + y, 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function memoryOf(all: ProcSampleLine[]): {
  start: number;
  end: number;
  slope: number;
  hwm: number;
} {
  // A sample taken while the process exits reads VmRSS 0 (a zombie): not a measurement.
  const samples = all.filter((s) => s.status.vmRssBytes > 0);
  if (samples.length === 0) return { start: 0, end: 0, slope: 0, hwm: 0 };
  const t0 = samples[0].tsMs;
  return {
    start: samples[0].status.vmRssBytes,
    end: samples[samples.length - 1].status.vmRssBytes,
    slope: slopePerMin(
      samples.map((s): [number, number] => [
        (s.tsMs - t0) / 60_000,
        s.status.vmRssBytes,
      ]),
    ),
    hwm: Math.max(...samples.map((s) => s.status.vmHwmBytes)),
  };
}

function cpuOf(samples: ProcSampleLine[], thread?: string): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  return last.threadCpu
    .filter((t) => thread === undefined || t.comm === thread)
    .reduce((a, t) => a + t.cpuSeconds, 0);
}

/** One render-stream-report/1 repeat from a leg's evidence. `unavailable` lists the plain-number
 * fields the schema requires that this leg cannot measure: they carry 0 and are named here, never
 * passed off as a measurement (a documented extension of the repeat, ignored by validate). */
export function repeatOf(
  ev: G6cLegEvidence,
  m: G6cMeasure,
): ReportRepeat & { unavailable: string[] } {
  const rel = (p: string) => p.slice(ev.dir.length + 1);
  const hostTimeline = "host/evidence/perf-timeline.jsonl";
  const hostPerf = "host/evidence/perf.json";
  const unavailable: string[] = [];
  const conn = connRatesOf(m);
  const r0 = ev.receivers[0];
  const noRecv =
    ev.receivers.length === 0 ? "armed-idle: no subscriber" : undefined;
  const recvPerfPath = r0 ? `${rel(r0.dir)}/perf.json` : "";
  const rates = {} as Record<RateName, ReportRate>;
  rates.requested =
    ev.def.target_fps === null
      ? rate(null, "", "uncapped: GRC_PUBLISH_FPS unset")
      : rate(ev.def.target_fps, "host/env.txt GRC_PUBLISH_FPS");
  rates.host_frame = rate(m.host_frame, hostTimeline);
  rates.published = rate(conn?.published ?? null, hostTimeline, noRecv);
  rates.received = rate(conn?.received ?? null, hostTimeline, noRecv);
  rates.applied = rate(conn?.applied ?? null, hostTimeline, noRecv);
  rates.submitted = rate(conn?.submitted ?? null, hostTimeline, noRecv);
  rates.receiver_frame = rate(
    m.receivers[0]?.receiver_frame ?? null,
    recvPerfPath,
    noRecv,
  );
  rates.presented = {
    value: null,
    unit: "1/s",
    status: "unavailable",
    source: null,
    reason:
      "Godot exposes no presentation feedback and gamescope's statistics are not wired (D9)",
  };
  for (const name of RATE_NAMES) if (!rates[name]) throw new Error(name);

  const unavailableStages = new Set(
    (ev.perf?.unavailable_stages ?? []).map((u) => u.stage),
  );
  const stages = {} as Record<string, unknown>;
  for (const [out, src] of HOST_STAGE_MAP)
    stages[out] = dist(hostHist(ev.perf, src), "us", hostPerf, {
      unavailable: unavailableStages.has(src) ? "not wired" : undefined,
    });
  stages.credit_rtt_us = {
    applied: dist(hostHist(ev.perf, "credit_rtt_us.applied"), "us", hostPerf, {
      notApplicable: "credit stage submitted",
    }),
    submitted: dist(
      hostHist(ev.perf, "credit_rtt_us.submitted"),
      "us",
      hostPerf,
      { notApplicable: noRecv ?? "" },
    ),
  };
  stages.staleness_us = {
    submitted: dist(
      hostHist(ev.perf, "staleness_us.submitted"),
      "us",
      hostPerf,
      { notApplicable: noRecv ?? "" },
    ),
  };
  const rh = r0?.perf?.histograms;
  stages.recv_decode_us = dist(rh?.decode_us, "us", recvPerfPath, {
    notApplicable: noRecv,
  });
  stages.recv_apply_us = dist(rh?.apply_us, "us", recvPerfPath, {
    notApplicable: noRecv,
  });
  stages.recv_upload_us = dist(undefined, "us", "", {
    unavailable: "combined with apply_us in the receiver",
  });
  stages.recv_fetch_us = dist(rh?.fetch_us, "us", recvPerfPath, {
    notApplicable: noRecv ?? "no fetch",
  });
  stages.recv_frame_interval_us = dist(
    rh?.frame_interval_us,
    "us",
    recvPerfPath,
    { notApplicable: noRecv },
  );
  stages.recv_gpu_render_ms = dist(rh?.gpu_render_us, "ms", recvPerfPath, {
    scale: 1 / 1000,
    notApplicable: noRecv,
  });

  const summaryConn =
    r0 !== undefined ? connectionOf(r0, ev.summary) : undefined;
  const hostMem = memoryOf(ev.samples);
  const recvMem = memoryOf(r0?.samples ?? []);
  if (!r0)
    unavailable.push(
      "cpu.receiver_process_s",
      "memory.recv_rss_start",
      "memory.recv_rss_end",
      "memory.recv_rss_slope_bytes_per_min",
      "memory.recv_vmhwm",
    );
  unavailable.push(
    "resources.host_pins_max",
    "resources.recv_pipeline_compilations",
  );
  const recvTimeline = r0?.perf?.timeline ?? [];
  const resourcesSummary = r0?.applied?.resources_summary ?? {};
  const evictions =
    (resourcesSummary.evictions_memory ?? 0) +
    (resourcesSummary.evictions_disk ?? 0);
  if (resourcesSummary.evictions_memory === undefined)
    unavailable.push("resources.recv_evictions");
  return {
    run_dir: ev.dir,
    window_s: m.window?.seconds ?? 0,
    rates,
    stages: stages as unknown as ReportRepeat["stages"],
    cpu: {
      host_main_thread_s: (ev.perf?.cpu?.main_thread_us ?? 0) / 1e6,
      host_io_thread_s: cpuOf(ev.samples, "rs-ws-io"),
      host_process_s: cpuOf(ev.samples),
      receiver_process_s: cpuOf(r0?.samples ?? []),
    },
    queues: {
      max_in_flight: summaryConn?.max_in_flight ?? 0,
      max_pending: summaryConn?.max_pending ?? 0,
      pending_episodes: summaryConn?.pending_episodes ?? 0,
      max_pending_age_us: summaryConn?.max_pending_age_us ?? 0,
      coalesced: summaryConn?.coalesced ?? 0,
      ticks_credit_blocked: summaryConn?.ticks_credit_blocked ?? 0,
      max_queued_bytes: summaryConn?.max_queued_bytes ?? 0,
    },
    bytes: {
      transaction: exactDist(
        r0?.record_bytes ?? [],
        "bytes",
        r0 ? `${rel(r0.dir)}/received.rs2` : "",
      ),
      wire_bytes_per_s: conn?.bytes_per_s ?? 0,
      resource_bytes: summaryConn?.resource_bytes ?? 0,
      http_bytes: summaryConn?.http_bytes ?? 0,
      fetches: summaryConn?.http_gets ?? 0,
    },
    resources: {
      host_retained_max: ev.summary?.resources?.retained_max ?? 0,
      host_retained_bytes_max: ev.summary?.resources?.retained_bytes_max ?? 0,
      host_pins_max: 0,
      recv_cache_entries_max: r0?.applied?.cache?.entries_after ?? 0,
      recv_cache_bytes_max: r0?.applied?.cache?.bytes_after ?? 0,
      recv_evictions: evictions,
      recv_rids_max: Math.max(
        0,
        ...recvTimeline.map((l) =>
          Object.values(l.live_rids ?? {}).reduce((a, b) => a + b, 0),
        ),
      ),
      recv_texture_mem_max: Math.max(
        0,
        ...recvTimeline.map((l) => l.texture_mem_bytes ?? 0),
      ),
      recv_video_mem_max: Math.max(
        0,
        ...recvTimeline.map((l) => l.video_mem_bytes ?? 0),
      ),
      recv_pipeline_compilations: 0,
    },
    memory: {
      host_rss_start: hostMem.start,
      host_rss_end: hostMem.end,
      host_rss_slope_bytes_per_min: hostMem.slope,
      host_vmhwm: hostMem.hwm,
      recv_rss_start: recvMem.start,
      recv_rss_end: recvMem.end,
      recv_rss_slope_bytes_per_min: recvMem.slope,
      recv_vmhwm: recvMem.hwm,
    },
    unavailable,
  };
}

export interface ProvenanceInput {
  engine_sha256?: string;
  library_sha256?: string;
  calibration?: string;
  receiver_project_sha256?: string;
  gamescope_sizes?: [number, number][];
}

/** `gamescope --version` reduced to its version number (the raw line carries ANSI colour codes
 * and a log prefix). */
function gamescopeVersion(): string {
  const raw = probeGamescopeVersion();
  return raw?.match(/gamescope version (\S+)/)?.[1] ?? raw ?? "unknown";
}

function gitInfo(): { commit: string; dirty: boolean } {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  });
  return {
    commit: head.status === 0 ? head.stdout.trim() : "unknown",
    dirty: status.status === 0 ? status.stdout.trim() !== "" : true,
  };
}

/** Writes <leg>/report-set/ (report-gate6.ts build's layout, one repeat) and
 * <leg>/render-stream-report.json; returns validate()'s problems. */
export async function writeLegReport(
  ratesDir: string,
  ev: G6cLegEvidence,
  m: G6cMeasure,
  input: ProvenanceInput | undefined,
): Promise<{ path: string; problems: string[] }> {
  const set = join(ev.dir, "report-set");
  const scenarioDir = join(set, "scenarios", ev.def.leg);
  await mkdir(join(scenarioDir, "repeat-1"), { recursive: true });
  const calibration = input?.calibration
    ? await readJson<{
        engine?: { version_string?: string };
        slots?: Record<string, number>;
        calibrator?: { version?: string };
      }>(input.calibration)
    : undefined;
  const r0 = ev.receivers.find((r) => r.perf?.adapter?.name) ?? ev.receivers[0];
  await writeFile(
    join(set, "run.json"),
    JSON.stringify({
      id: `${basename(join(ratesDir, ".."))}/${ev.def.leg}`,
      started_utc: new Date().toISOString(),
      runner: "run-gate6.sh --legs g6c",
      args: ["--legs", "g6c"],
      git: gitInfo(),
    }),
  );
  await writeFile(
    join(set, "provenance.json"),
    JSON.stringify({
      engine: {
        version_string:
          calibration?.engine?.version_string ?? "Godot Engine v4.5.1.stable",
        sha256: input?.engine_sha256 ?? "unknown",
        template: "linux_release",
      },
      capture: {
        library_sha256: input?.library_sha256 ?? "unknown",
        calibrator_version: Number(calibration?.calibrator?.version ?? 0),
        hooks_planned: Object.keys(calibration?.slots ?? {}).length,
      },
      receiver: {
        project_sha256: input?.receiver_project_sha256 ?? "unknown",
        rendering_method: r0?.perf?.rendering_method ?? "gl_compatibility",
        adapter: {
          vendor: r0?.perf?.adapter?.vendor ?? "",
          name: r0?.perf?.adapter?.name ?? "",
          api_version: r0?.perf?.adapter?.api_version ?? "",
        },
      },
      protocol: "render-stream/6",
      display: {
        compositor: "gamescope",
        version: gamescopeVersion(),
        sizes: input?.gamescope_sizes ?? [],
      },
      timing: {
        host_clock: "steady_clock",
        receiver_clock: "Time.get_ticks_usec",
        rates_clock: "host",
        screenshots: "outside-measured-window",
        hook_log: ev.def.hook_log,
      },
    }),
  );
  const hd = ev.def.fixture === "gate6-hd";
  const meta: Omit<ReportScenario, "repeats" | "aggregate"> = {
    id: ev.def.leg,
    fixture: ev.def.fixture,
    variant: ev.def.variant,
    arm: ev.def.kind === "baseline" ? "armed-idle" : "streaming",
    resolution: {
      logical: hd ? [1920, 1080] : [640, 360],
      presentation: hd ? [1920, 1080] : [640, 360],
    },
    profile: {
      rendering_method: "gl_compatibility",
      msaa_2d: 0,
      hdr_2d: false,
      stretch: hd
        ? { mode: "canvas_items", aspect: "keep", scale_mode: "fractional" }
        : { mode: "disabled", aspect: "ignore", scale_mode: "fractional" },
      font_oversampling: 1,
    },
    config: {
      target_fps: ev.def.target_fps,
      host_max_fps: ev.def.host_max_fps,
      receiver_max_fps: ev.def.receivers[0]?.max_fps ?? 0,
      credit_stage: "submitted",
      transport: ev.def.transport,
      cache: "cold",
      delivery: ev.def.delivery,
      connections: ev.def.connections,
      time: "realtime",
    },
    warmup: null,
  };
  await writeFile(join(scenarioDir, "meta.json"), JSON.stringify(meta));
  await writeFile(
    join(scenarioDir, "repeat-1", "repeat.json"),
    JSON.stringify(repeatOf(ev, m)),
  );
  const path = join(ev.dir, "render-stream-report.json");
  let problems: string[];
  try {
    const report = await buildReport(set, { repeats: 1 });
    problems = validate(report, { repeats: 1 });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    problems = [`build failed: ${String(error)}`];
  }
  return { path, problems };
}

// ---------------------------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------------------------

export interface G6cLegEntry {
  group: "g6c";
  expected_class: string;
  result_class: string | null;
  pixel_verdict?: string;
  expected_pixel_verdict?: string;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface G6cRateRow {
  requested: number | null;
  host_frame: number | null;
  published: (number | null)[];
  received: (number | null)[];
  applied: (number | null)[];
  submitted: (number | null)[];
  receiver_frame: (number | null)[];
  presented: "unavailable";
  window_s: number | null;
  host_frame_interval_p95_us: number | null;
  host_callback_p50_us: number | null;
  credit_rtt_us: (RttSummary | null)[];
  coalesced: (number | null)[];
  max_pending_age_us: (number | null)[];
  ticks_credit_blocked: (number | null)[];
  max_queued_bytes: (number | null)[];
  wire_bytes_per_s: (number | null)[];
  receiver_frame_interval_p50_us: (number | null)[];
  receiver_gpu_render_p50_us: (number | null)[];
  receiver_cpu_render_p50_us: (number | null)[];
  /** per receiver: the window's mean credit RTT in host frames and the credit capacity it gives
   * (host frames per second / that), the receiver's read-to-submitted p95, and what bounds it */
  credit_rtt_mean_frames: (number | null)[];
  credit_capacity: (number | null)[];
  receiver_hold_p95_us: (number | null)[];
  limited_by_per_receiver: (LimitedBy["limited_by"] | null)[];
  limited_by?: LimitedBy;
  separation?: SeparationClass;
  gpu_heavy_iterations?: number | null;
  proxy?: Record<string, unknown>;
  /** per receiver: the final shot's seq, frame and differing pixels */
  final_state?: string[];
}

export interface G6cResult {
  checks: Gate6Check[];
  legs: Record<string, G6cLegEntry>;
  rates: Record<string, G6cRateRow>;
}

/** The part of a constrained leg's mean credit RTT the link adds (gate6-design.md "As built
 * (G6c)" 5): its window mean minus rate-60's (the same target and receiver on loopback), so the
 * fetches the receiver makes over the link count as transport too; 0 on loopback. Without
 * rate-60, the throttle proxy's measured one-way latencies summed. */
export function linkRttUs(
  ev: G6cLegEvidence,
  m: G6cMeasure,
  loopback: G6cMeasure | undefined,
): number {
  if (ev.def.transport !== "constrained") return 0;
  const rtt = connRatesOf(m)?.credit_rtt_mean_us ?? null;
  const ref = loopback
    ? (connRatesOf(loopback)?.credit_rtt_mean_us ?? null)
    : null;
  if (rtt !== null && ref !== null) return Math.max(0, rtt - ref);
  const mean = (dir: unknown): number => {
    const lat = (dir as { latency_ms?: { mean_ms?: number } } | undefined)
      ?.latency_ms?.mean_ms;
    return typeof lat === "number" ? lat * 1000 : 0;
  };
  return mean(ev.proxy?.client_to_server) + mean(ev.proxy?.server_to_client);
}

function rateRow(
  ev: G6cLegEvidence,
  m: G6cMeasure,
  linkRtt: number,
): G6cRateRow {
  const per = <T>(f: (i: number) => T): T[] => ev.receivers.map((_, i) => f(i));
  const summaryOf = (i: number) => connectionOf(ev.receivers[i], ev.summary);
  return {
    requested: ev.def.target_fps,
    host_frame: m.host_frame,
    published: per((i) => connRatesOf(m, i)?.published ?? null),
    received: per((i) => connRatesOf(m, i)?.received ?? null),
    applied: per((i) => connRatesOf(m, i)?.applied ?? null),
    submitted: per((i) => connRatesOf(m, i)?.submitted ?? null),
    receiver_frame: per((i) => m.receivers[i]?.receiver_frame ?? null),
    presented: "unavailable",
    window_s: m.window?.seconds ?? null,
    host_frame_interval_p95_us: m.frame_interval_p95_us,
    host_callback_p50_us: m.callback_p50_us,
    credit_rtt_us: per((i) => summaryOf(i)?.credit_rtt_us ?? null),
    coalesced: per((i) => summaryOf(i)?.coalesced ?? null),
    max_pending_age_us: per((i) => summaryOf(i)?.max_pending_age_us ?? null),
    ticks_credit_blocked: per(
      (i) => connRatesOf(m, i)?.ticks_credit_blocked ?? null,
    ),
    max_queued_bytes: per((i) => summaryOf(i)?.max_queued_bytes ?? null),
    wire_bytes_per_s: per((i) => connRatesOf(m, i)?.bytes_per_s ?? null),
    receiver_frame_interval_p50_us: per(
      (i) => m.receivers[i]?.frame_interval_p50_us ?? null,
    ),
    receiver_gpu_render_p50_us: per(
      (i) => m.receivers[i]?.gpu_render_p50_us ?? null,
    ),
    receiver_cpu_render_p50_us: per(
      (i) => m.receivers[i]?.cpu_render_p50_us ?? null,
    ),
    credit_rtt_mean_frames: per(
      (i) => connRatesOf(m, i)?.credit_rtt_mean_frames ?? null,
    ),
    credit_capacity: per((i) => creditCapacity(m, connRatesOf(m, i))),
    receiver_hold_p95_us: per((i) => m.receivers[i]?.hold_p95_us ?? null),
    limited_by_per_receiver: per((i) => limitedBy(m, i, linkRtt).limited_by),
  };
}

export async function runGate6c(out: string): Promise<G6cResult> {
  const ratesDir = join(out, G6C_DIR);
  const checks: Gate6Check[] = [];
  const legs: Record<string, G6cLegEntry> = {};
  const rates: Record<string, G6cRateRow> = {};
  const legsRun = (
    (await readTextOrUndefined(join(ratesDir, "legs-run.txt"))) ?? ""
  )
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const input = await readJson<ProvenanceInput>(
    join(ratesDir, "provenance-input.json"),
  );
  const evs = new Map<string, G6cLegEvidence>();
  const ms = new Map<string, G6cMeasure>();
  for (const def of G6C_LEGS) {
    const ev = await loadG6cLeg(ratesDir, def);
    evs.set(def.leg, ev);
    ms.set(def.leg, measureLeg(ev));
  }
  const base = ms.get("rate-baseline");

  const uncappedHost60HoldP95 =
    ms.get("rate-uncapped-host60")?.receivers[0]?.hold_p95_us ?? null;
  const reportProblems: string[] = [];
  const reportPaths: string[] = [];

  for (const def of G6C_LEGS) {
    const ev = evs.get(def.leg) as G6cLegEvidence;
    const m = ms.get(def.leg) as G6cMeasure;
    const L = def.leg;
    const ran = legsRun.includes(L);
    const evidence = [ev.dir];
    if (!ran) {
      checks.push({
        id: `leg-${L}`,
        criterion: `g6c leg ${L} ran`,
        passed: false,
        status: "not-run",
        detail: "G6C_LEGS did not include it",
        evidence: [],
      });
      continue;
    }
    const linkRtt = linkRttUs(ev, m, ms.get("rate-60"));
    rates[L] = rateRow(ev, m, linkRtt);
    const cls = legClass(ev);
    const summary0 = ev.receivers[0]
      ? connectionOf(ev.receivers[0], ev.summary)
      : ev.summary?.connections?.[0];
    // The leg's own checks: id -> problems (Q7d's table for its kind).
    const own: [string, string, string[]][] = [];
    switch (def.kind) {
      case "baseline": {
        const p = windowProblems(m);
        if (!m.frame_interval_p95_us || !m.callback_p50_us)
          p.push("perf.json lacks frame_interval_us or frame_callback_us");
        own.push([
          "baseline-recorded",
          "rate-baseline records host frame interval and callback time (the host-unperturbed reference)",
          p,
        ]);
        break;
      }
      case "rate":
        own.push([
          "rate-achieved",
          `published in [0.95 x min(${def.target_fps}, credit capacity), 1.02 x ${def.target_fps}]; applied within 2 % of published; submitted = applied +- 1; receiver frame rate in [57, 61]`,
          evaluateRateAchieved(m, def.target_fps ?? 0, { appliedChecks: true }),
        ]);
        break;
      case "uncapped-host60":
        own.push([
          "published-vs-host",
          "uncapped at --max-fps 60: published >= 0.95 x min(host frame rate, credit capacity) (Q7d's 0.95 x host frame rate, as built: a credit RTT longer than one host frame halves it, gate6-design.md As built (G6c))",
          evaluatePublishedVsHost(m),
        ]);
        break;
      case "uncapped": {
        const l = limitedBy(m, 0, linkRtt);
        rates[L].limited_by = l;
        own.push([
          "limited-by",
          "uncapped at --max-fps 0: limited_by reported with its evidence; published >= 0.95 x min(host frame rate, credit capacity)",
          evaluateLimitedBy(m, l),
        ]);
        break;
      }
      case "mismatch-60-recv30":
        own.push([
          "rate-mismatch",
          "target 60, receiver 30: published in [0.95 x min(60, credit capacity), 1.05 x receiver frame rate]; ticks_credit_blocked > 0",
          evaluateMismatch60Recv30(m),
        ]);
        own.push([
          "host-unperturbed",
          "host frame-interval p95 within 5 % and frame rate within 2 % of rate-baseline",
          evaluateHostUnperturbed(m, base),
        ]);
        break;
      case "mismatch-15-recv60":
        own.push([
          "rate-achieved",
          "target 15, receiver 60: published in [0.95 x min(15, credit capacity), 1.02 x 15]; receiver frame rate in [57, 61]",
          evaluateRateAchieved(m, 15, { appliedChecks: false }),
        ]);
        break;
      case "dual":
        own.push([
          "dual-independent",
          "each receiver served promptly (published >= 0.95 x min(nominal, its credit capacity)), B never above its frame rate; A's receiver hold p95 within 10 % of rate-uncapped-host60's; one snapshot copy per host frame",
          evaluateDual(m, uncappedHost60HoldP95),
        ]);
        break;
      case "recv-delay":
        rates[L].separation = separationClass(
          m.receivers[0]?.frame_interval_p50_us ?? null,
          m.receivers[0]?.gpu_render_p50_us ?? null,
        );
        own.push([
          "separation",
          "--frame-delay 40: receiver frame interval p50 >= 40 ms and GPU render p50 <= 5 ms -> injected-delay",
          evaluateSeparation(m, "injected-delay"),
        ]);
        break;
      case "gpu-heavy": {
        rates[L].separation = separationClass(
          m.receivers[0]?.frame_interval_p50_us ?? null,
          m.receivers[0]?.gpu_render_p50_us ?? null,
        );
        const cal = await readJson<{ chosen_iterations?: number }>(
          join(ratesDir, "gpu-heavy-calibration", "calibration.json"),
        );
        rates[L].gpu_heavy_iterations = cal?.chosen_iterations ?? null;
        own.push([
          "separation",
          "gpu-heavy at 1920x1080: GPU render p50 >= 0.8 x frame interval p50 -> gpu-limited",
          evaluateSeparation(m, "gpu-limited"),
        ]);
        break;
      }
      case "constrained":
      case "sabotage":
        rates[L].proxy = ev.proxy;
        own.push([
          "credit-rtt",
          "constrained: credit RTT p50 >= 60 ms",
          evaluateCreditRtt(summary0),
        ]);
        own.push([
          "pending-bounded",
          "max_pending <= 1, max_in_flight <= 1, queued bytes <= one transaction + control frames",
          evaluatePendingBounded(summary0),
        ]);
        own.push([
          "queue-bounded",
          "host max_queued_bytes <= largest message + 64 KiB",
          evaluateQueueBounded(summary0),
        ]);
        own.push([
          "host-unperturbed",
          "host frame-interval p95 within 5 % and frame rate within 2 % of rate-baseline",
          evaluateHostUnperturbed(m, base),
        ]);
        break;
    }
    if (def.receivers.length > 0) {
      const f = await finalLatestState(ev);
      own.push([
        "final-latest-state",
        "the receiver's final shot (after step 11's freeze) equals the reference's step 11 with the host's leftovers, whole frame, budget 0",
        [...f.problems, ...(f.problems.length > 0 ? f.detail : [])],
      ]);
      rates[L].final_state = f.detail;
    }

    if (def.kind === "sabotage") {
      const failing = own
        .filter(([, , p]) => p.length > 0)
        .map(([id]) => id)
        .sort();
      const problems: string[] = [];
      if (cls.cls !== def.expected_class)
        problems.push(`class ${cls.cls}, expected ${def.expected_class}`);
      if (JSON.stringify(failing) !== JSON.stringify([...G6C_SABOTAGE_FAILS]))
        problems.push(
          `failing ${failing.join(", ") || "nothing"}, expected exactly ${G6C_SABOTAGE_FAILS.join(", ")}`,
        );
      checks.push(
        check(
          `leg-class-${L}`,
          `${L}: ${def.expected_class}, failing exactly ${G6C_SABOTAGE_FAILS.join(" and ")}`,
          problems,
          `${cls.cls}; ${own.map(([id, , p]) => `${id} ${p.length > 0 ? `FAIL (${p.join("; ")})` : "pass"}`).join("; ")}`,
          evidence,
        ),
      );
    } else {
      checks.push(
        check(
          `leg-class-${L}`,
          `${L}: ${def.expected_class}`,
          cls.cls === def.expected_class
            ? []
            : [`class ${cls.cls}: ${cls.reasons.join("; ")}`],
          cls.cls,
          evidence,
        ),
      );
      for (const [id, criterion, problems] of own)
        checks.push(
          check(
            `${id}-${L}`,
            `${L}: ${criterion}`,
            problems,
            describe(id, ev, m, rates[L]),
            evidence,
          ),
        );
    }
    legs[L] = {
      group: "g6c",
      expected_class: def.expected_class,
      result_class: cls.cls,
      reasons: cls.reasons,
      exit_code: ev.host_exit,
      artifacts: [ev.dir],
    };
    const report = await writeLegReport(ratesDir, ev, m, input);
    reportPaths.push(report.path);
    for (const p of report.problems) reportProblems.push(`${L}: ${p}`);
  }
  checks.push(
    check(
      "g6c-reports-valid",
      "every g6c leg's measurements validate as a single-repeat render-stream-report/1 (G6p reuses the plumbing)",
      reportProblems,
      `${reportPaths.length} reports valid`,
      reportPaths,
    ),
  );
  return { checks, legs, rates };
}

function describe(
  id: string,
  ev: G6cLegEvidence,
  m: G6cMeasure,
  row: G6cRateRow,
): string {
  const c = connRatesOf(m);
  const r = m.receivers[0];
  const base = `host ${fmt(m.host_frame)}/s, published ${row.published.map((v) => fmt(v)).join("/")}/s, receiver frame ${row.receiver_frame.map((v) => fmt(v)).join("/")}/s over ${fmt(m.window?.seconds, 1)} s`;
  switch (id) {
    case "rate-achieved":
      return `${base}; applied ${c?.acks?.[1] ?? "?"} submitted ${c?.acks?.[2] ?? "?"} of ${c?.sent ?? "?"} sent`;
    case "limited-by":
      return `${base}; limited_by ${row.limited_by?.limited_by} (credit capacity ${fmt(row.limited_by?.credit_capacity)}/s, RTT mean ${fmt(row.limited_by?.credit_rtt_mean_us, 0)} us, receiver hold p50 ${fmt(row.limited_by?.receiver_hold_p50_us, 0)} us, link RTT ${fmt(row.limited_by?.link_rtt_us, 0)} us)`;
    case "rate-mismatch":
      return `${base}; ${c?.ticks_credit_blocked ?? "?"} credit-blocked ticks, coalesced ${row.coalesced[0] ?? "?"}, oldest pending ${row.max_pending_age_us[0] ?? "?"} us`;
    case "separation":
      return `${row.separation}: receiver frame interval p50 ${fmt(r?.frame_interval_p50_us, 0)} us, GPU render p50 ${fmt(r?.gpu_render_p50_us, 0)} us, CPU render p50 ${fmt(r?.cpu_render_p50_us, 0)} us${row.gpu_heavy_iterations ? `, iterations ${row.gpu_heavy_iterations}` : ""}`;
    case "host-unperturbed":
      return `frame-interval p95 ${fmt(m.frame_interval_p95_us, 0)} us, host ${fmt(m.host_frame)}/s`;
    case "credit-rtt":
    case "pending-bounded":
    case "queue-bounded": {
      const s = ev.receivers[0]
        ? connectionOf(ev.receivers[0], ev.summary)
        : undefined;
      return `credit RTT p50 ${s?.credit_rtt_us?.median ?? "?"} us p95 ${s?.credit_rtt_us?.p95 ?? "?"} us; max_pending ${s?.max_pending}, max_in_flight ${s?.max_in_flight}, max_queued_bytes ${s?.max_queued_bytes} (largest message ${s?.max_message_sent})`;
    }
    default:
      return base;
  }
}
