// Gate 6 group g6s (protocol/gate6-design.md "G6s", Q5 "Resource budgets", Q7e "Stability
// (g6s)"): receiver cache budgets and eviction, over a 300-s soak on fixtures/gate6-scene's
// `animate` variant, the `soak` timeline, `realtime` time and `GRC_HOOK_LOG=off` (so nothing here
// reads a per-call hook log; everything comes from the two sides' own 1 Hz perf timelines and the
// runner-side `/proc` sampler, scripts/sample-proc.ts over lib/proc-sampler.ts, matching D9: host
// and receiver memory is read from `/proc`, never an engine counter).
//
// Pure over an evidence directory run-gate6.sh's run_g6s wrote (under <out>/g6s/), so
// self-test-gate6s.ts drives each evaluator with fabricated timelines. Nothing here launches a
// process.
//
// Evidence layout under <out>/g6s/:
//   import/{fixture,receiver}/        editor --import passes
//   reference-step11/shots/step-11.png   a rendered `animate` reference on the SOAK timeline
//                                        itself at --max-fps 60 (not the file timeline, and not
//                                        uncapped: step 11's freeze stops every continuous update
//                                        -- MS, SM, AN, and animate's SC/LB/CD/TEXA -- wherever it
//                                        happened to be on the frame before the freeze fired, and
//                                        that frame depends on both the timeline and the achieved
//                                        frame rate; a file-timeline or uncapped reference froze
//                                        at a different phase and mismatched by thousands of
//                                        pixels, measured)
//   <leg>/host/       a live host (headless, armed, GRC_HOOK_LOG=off, the soak timeline,
//                     `--max-fps 60`); evidence/perf-timeline.jsonl (entry.cpp, 1 Hz: rss_bytes,
//                     mirror_items/textures/meshes/materials, host_retained(_bytes), and per
//                     connection carried_size); proc-samples.jsonl (sample-proc.ts on the host's
//                     pid)
//   <leg>/receiver/   a rendered live receiver (RS_RECEIVER_PERF_OUT set, RS_RECEIVER_LOG=summary,
//                     the tight memory/disk budgets of Q7e, --max-fps 60); applied.json (shots,
//                     resources_summary.{evictions_memory,evictions_disk,refetch_after_evict});
//                     perf.json (render-stream-receiver-perf/1: its `timeline` array, 1 Hz,
//                     cache_entries_memory/cache_bytes_memory and live_rids filled in by G6s);
//                     proc-samples.jsonl (sample-proc.ts on the receiver's pid); shots/seq-<n>.png

import { join } from "node:path";

import {
  decodePngRgba,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import type { Applied3 } from "./gate2b-checks";
import type { G2cApplied } from "./gate2c-checks";
import { parseJsonl } from "./gate2-checks";
import { check } from "./gate5-checks";
import { type Gate6Expected } from "./gate6-expected";
import {
  diffFrames6,
  excludedRegions,
  type Frame6,
  type Gate6Check,
} from "./gate6a-checks";

export const G6S_DIR = "g6s";

export const G6S_MEMORY_BUDGET_BYTES = 1 << 20; // 1 MiB (Q7e: 64 TEXA payloads)
export const G6S_CACHE_BUDGET_BYTES = 4 << 20; // 4 MiB

// One TEXA payload (64x64 RGBA8 = 16384 data bytes, GRT1's small header): the "one payload" slack
// Q5's cache-budget-respected allows past the configured budget.
export const G6S_ONE_PAYLOAD_SLACK_BYTES = 16384 + 128;

// Q7e's measured window and thirds, in seconds since each side's own first sample.
export const G6S_WINDOW_START_S = 60;
export const G6S_WINDOW_END_S = 360;
export const G6S_THIRD_S = (G6S_WINDOW_END_S - G6S_WINDOW_START_S) / 3;

// residency-bounded's growth half ("max over the last third <= max over the first third") is
// exact in Q7e's wording, but these are small live integer counts (host_retained, mirror counts,
// live RIDs) that legitimately tick by 1 for a frame or two during an ordinary resource swap --
// not a leak. Measured on a real honest soak-scene run: host_retained's first-third max was 10,
// its last-third max 11 (one transient pin during a routine retire/re-add), which a zero-slack
// comparison flagged as "grew" on a leg with no sabotage at all. A small additive slack absorbs
// that without weakening detection: every real sabotage signal measured so far (no-evict's
// receiver memory-cache 128 flat vs an honest ~64-120, retain-superseded's host retained 139 flat
// vs an honest ~10) is caught by the budget-derived-bound half regardless, which has no slack.
export const G6S_RESIDENCY_GROWTH_SLACK = 2;

export interface G6sLeg {
  leg: string;
  /** which residency-bounded metric this sabotage must fail, or null for an honest leg */
  failsMetric: string | null;
  inline: boolean;
}

export const G6S_LEGS: readonly G6sLeg[] = [
  { leg: "soak-scene", failsMetric: null, inline: false },
  { leg: "soak-inline", failsMetric: null, inline: true },
  {
    leg: "sabotage-soak-no-evict",
    failsMetric: "receiver memory-cache entries",
    inline: false,
  },
  {
    leg: "sabotage-soak-retain-superseded",
    failsMetric: "host retained payloads",
    inline: false,
  },
];

// ---------------------------------------------------------------------------------------------
// Evidence shapes
// ---------------------------------------------------------------------------------------------

export interface HostConnLine {
  connection: number;
  sent: number;
  credits: number;
  coalesced: number;
  ticks_credit_blocked: number;
  max_pending_age_us: number;
  bytes_sent: number;
  carried_size?: number;
}

export interface HostTimelineLine {
  t_us: number;
  frame: number;
  rss_bytes: number;
  mirror_items?: number;
  mirror_textures?: number;
  mirror_meshes?: number;
  mirror_materials?: number;
  host_retained?: number;
  host_retained_bytes?: number;
  connections: HostConnLine[];
}

export interface ReceiverTimelineLine {
  t_us: number;
  rss_bytes: number;
  texture_mem_bytes: number;
  buffer_mem_bytes: number;
  video_mem_bytes: number;
  cache_entries_disk: number;
  cache_bytes_disk: number;
  cache_entries_memory: number | null;
  cache_bytes_memory: number | null;
  live_rids: {
    items: number;
    textures: number;
    meshes: number;
    shaders: number;
    materials: number;
  } | null;
  pipeline_compilations: number | null;
}

export interface ReceiverPerf {
  schema: string;
  timeline: ReceiverTimelineLine[];
}

export interface ProcSample {
  tsMs: number;
  status: {
    pid: number;
    vmRssBytes: number;
    vmHwmBytes: number;
    vmSizeBytes: number;
    threads: number;
  };
  threadCpu: {
    tid: number;
    comm: string;
    utimeTicks: number;
    stimeTicks: number;
    cpuSeconds: number;
  }[];
}

export type G6sApplied = G2cApplied & { resources_summary?: Applied3["resources_summary"] };

export interface G6sLegEvidence {
  leg: string;
  hostTimeline: HostTimelineLine[];
  hostProc: ProcSample[];
  receiverPerf: ReceiverPerf | undefined;
  receiverProc: ProcSample[];
  applied: G6sApplied | undefined;
  hostExitCode: number | null;
  receiverExitCode: number | null;
}

async function readExitCodeFile(dir: string): Promise<number | null> {
  const text = await readTextOrUndefined(join(dir, "exit-code.txt"));
  if (text === undefined) return null;
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : null;
}

async function loadJsonl<T>(path: string): Promise<T[]> {
  const text = await readTextOrUndefined(path);
  const { lines } = parseJsonl<T>(text, () => null);
  return lines;
}

/** Loads one g6s leg's evidence from `<g6sDir>/<leg>/`. */
export async function loadG6sLeg(
  g6sDir: string,
  leg: string,
): Promise<G6sLegEvidence> {
  const legDir = join(g6sDir, leg);
  const hostDir = join(legDir, "host");
  const receiverDir = join(legDir, "receiver");
  const hostTimeline = await loadJsonl<HostTimelineLine>(
    join(hostDir, "evidence", "perf-timeline.jsonl"),
  );
  const hostProc = await loadJsonl<ProcSample>(
    join(hostDir, "proc-samples.jsonl"),
  );
  const receiverPerf = await readJson<ReceiverPerf>(
    join(receiverDir, "perf.json"),
  );
  const receiverProc = await loadJsonl<ProcSample>(
    join(receiverDir, "proc-samples.jsonl"),
  );
  const applied = await readJson<G6sApplied>(join(receiverDir, "applied.json"));
  return {
    leg,
    hostTimeline,
    hostProc,
    receiverPerf,
    receiverProc,
    applied,
    hostExitCode: await readExitCodeFile(hostDir),
    receiverExitCode: await readExitCodeFile(receiverDir),
  };
}

// ---------------------------------------------------------------------------------------------
// Windowing
// ---------------------------------------------------------------------------------------------

export interface TimePoint {
  t: number; // seconds since this series' own first sample
  v: number;
}

export function relativeSeries(
  points: readonly { t: number; v: number }[],
): TimePoint[] {
  if (points.length === 0) return [];
  const t0 = points[0].t;
  return points.map((p) => ({ t: p.t - t0, v: p.v }));
}

function inRange(points: readonly TimePoint[], from: number, to: number): number[] {
  return points
    .filter((p) => p.t >= from && p.t <= to)
    .map((p) => p.v);
}

export function maxInWindowThird(
  points: readonly TimePoint[],
  third: "first" | "last",
): number | null {
  const from =
    third === "first" ? G6S_WINDOW_START_S : G6S_WINDOW_END_S - G6S_THIRD_S;
  const to = third === "first" ? G6S_WINDOW_START_S + G6S_THIRD_S : G6S_WINDOW_END_S;
  const vs = inRange(points, from, to);
  return vs.length > 0 ? Math.max(...vs) : null;
}

/** Max over the whole measured window [G6S_WINDOW_START_S, G6S_WINDOW_END_S], not just a third.
 * Used for the "every budgeted count <= its budget-derived bound" half of residency-bounded: a
 * sabotage whose extra residency is already fully present by the window's own first third (the
 * burst that fills it happens during fixture setup, before t=60s) shows no first-third-to-last-
 * third growth at all, so that comparison alone cannot see it (measured, G6s real-run evidence:
 * `sabotage-soak-no-evict`'s receiver memory-cache and `sabotage-soak-retain-superseded`'s host
 * retained count both plateau by the window's first sample and stay perfectly flat afterward). */
export function maxInWindow(points: readonly TimePoint[]): number | null {
  const vs = inRange(points, G6S_WINDOW_START_S, G6S_WINDOW_END_S);
  return vs.length > 0 ? Math.max(...vs) : null;
}

export function medianInWindowEnd(
  points: readonly TimePoint[],
  seconds: number,
  end: "start" | "finish",
): number | null {
  const vs =
    end === "start"
      ? inRange(points, G6S_WINDOW_START_S, G6S_WINDOW_START_S + seconds)
      : inRange(points, G6S_WINDOW_END_S - seconds, G6S_WINDOW_END_S);
  if (vs.length === 0) return null;
  const sorted = [...vs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Least-squares slope over the measured window, in value-units per minute. */
export function slopePerMinute(points: readonly TimePoint[]): number | null {
  const window = points.filter(
    (p) => p.t >= G6S_WINDOW_START_S && p.t <= G6S_WINDOW_END_S,
  );
  if (window.length < 2) return null;
  const n = window.length;
  const sumT = window.reduce((s, p) => s + p.t, 0);
  const sumV = window.reduce((s, p) => s + p.v, 0);
  const sumTT = window.reduce((s, p) => s + p.t * p.t, 0);
  const sumTV = window.reduce((s, p) => s + p.t * p.v, 0);
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return null;
  const slopePerSecond = (n * sumTV - sumT * sumV) / denom;
  return slopePerSecond * 60;
}

// ---------------------------------------------------------------------------------------------
// Series extraction
// ---------------------------------------------------------------------------------------------

export function hostSeries(
  ev: G6sLegEvidence,
  pick: (line: HostTimelineLine) => number | undefined,
): TimePoint[] {
  const raw = ev.hostTimeline
    .map((l) => ({ t: l.t_us / 1e6, v: pick(l) }))
    .filter((p): p is { t: number; v: number } => p.v !== undefined);
  return relativeSeries(raw);
}

export function receiverSeries(
  ev: G6sLegEvidence,
  pick: (line: ReceiverTimelineLine) => number | null | undefined,
): TimePoint[] {
  const raw = (ev.receiverPerf?.timeline ?? [])
    .map((l) => ({ t: l.t_us / 1e6, v: pick(l) }))
    .filter((p): p is { t: number; v: number } => p.v !== null && p.v !== undefined);
  return relativeSeries(raw);
}

export function procRssSeries(samples: readonly ProcSample[]): TimePoint[] {
  const raw = samples.map((s) => ({ t: s.tsMs / 1000, v: s.status.vmRssBytes }));
  return relativeSeries(raw);
}

// ---------------------------------------------------------------------------------------------
// residency-bounded
// ---------------------------------------------------------------------------------------------

export interface ResidencyMetric {
  name: string;
  firstThirdMax: number | null;
  lastThirdMax: number | null;
  /** Q7e's other half: "every budgeted count <= its budget-derived bound", null where this
   * metric has no derivable bound (most host mirror/live-RID counts: nothing in Q5 budgets or
   * caps them, so only growth-over-the-window is checkable for those). */
  budgetBound: number | null;
  windowMax: number | null;
  bounded: boolean;
}

/** Sum of the host's hash-backed resource kinds reachable from the live mirror right now
 * (textures + meshes + materials; `mirror_items` is draw-list nodes, not hash-backed content).
 * Q5 defines host retention as "current ∪ bases": with the one connection every g6s leg runs,
 * that structurally bounds `host_retained` to roughly this many (the live set) plus one base's
 * worth of the same order, plus a little slack for in-flight pins -- never to an unbounded
 * historical accumulation of every version ever sent, which is what `retain-superseded` produces. */
function hostCurrentResourcesSeries(ev: G6sLegEvidence): TimePoint[] {
  const raw = ev.hostTimeline.map((l) => ({
    t: l.t_us / 1e6,
    v: (l.mirror_textures ?? 0) + (l.mirror_meshes ?? 0) + (l.mirror_materials ?? 0),
  }));
  return relativeSeries(raw);
}

/** Every counted series Q7e's residency-bounded names, max(first third) vs max(last third), plus
 * the budget-derived bound half for the two metrics Q5 actually budgets or structurally caps.
 * `inlineReceiverCache` skips the receiver memory-cache bound for `soak-inline`, which overrides
 * the Q7e budget to a generous one by design (run-gate6.sh's g6s_leg soak-inline; memory
 * rs-g6s-carried-set-resource-duplicate explains why -- no fallback source for a recurring hash). */
export function residencyMetrics(
  ev: G6sLegEvidence,
  inlineReceiverCache = false,
): ResidencyMetric[] {
  const series: { name: string; points: TimePoint[] }[] = [
    { name: "host mirror items", points: hostSeries(ev, (l) => l.mirror_items) },
    {
      name: "host mirror textures",
      points: hostSeries(ev, (l) => l.mirror_textures),
    },
    { name: "host mirror meshes", points: hostSeries(ev, (l) => l.mirror_meshes) },
    {
      name: "host mirror materials",
      points: hostSeries(ev, (l) => l.mirror_materials),
    },
    {
      name: "host retained payloads",
      points: hostSeries(ev, (l) => l.host_retained),
    },
    {
      name: "receiver memory-cache entries",
      points: receiverSeries(ev, (l) => l.cache_entries_memory),
    },
    {
      name: "receiver live items",
      points: receiverSeries(ev, (l) => l.live_rids?.items),
    },
    {
      name: "receiver live textures",
      points: receiverSeries(ev, (l) => l.live_rids?.textures),
    },
    {
      name: "receiver live meshes",
      points: receiverSeries(ev, (l) => l.live_rids?.meshes),
    },
    {
      name: "receiver live shaders",
      points: receiverSeries(ev, (l) => l.live_rids?.shaders),
    },
    {
      name: "receiver live materials",
      points: receiverSeries(ev, (l) => l.live_rids?.materials),
    },
  ];
  const hostCurrentMax = maxInWindow(hostCurrentResourcesSeries(ev));
  // Structural bound for "current ∪ bases" with one connection: the live set plus roughly one
  // base's worth of the same order, times generous headroom, plus a small additive slack for
  // in-flight pins. Chosen against real G6s evidence: honest host_retained sits at exactly the
  // live set's size (10 == 7 textures + 1 mesh + 2 materials, nothing stale lingers);
  // retain-superseded's accumulates to 139, far past any reasonable multiple of that.
  const hostRetainedBound =
    hostCurrentMax === null ? null : 4 * hostCurrentMax + 16;
  // The receiver side's only Q5-configured budget is bytes, not entries; the entry count has no
  // fixed size-independent cap, so the bound is evaluated against the same leg's own
  // cache_bytes_memory series and reported against the entries metric Q7e names.
  const memBytesMax = maxInWindow(receiverSeries(ev, (l) => l.cache_bytes_memory));
  const memBudgetBound = inlineReceiverCache
    ? null
    : G6S_MEMORY_BUDGET_BYTES + G6S_ONE_PAYLOAD_SLACK_BYTES;
  return series.map(({ name, points }) => {
    const firstThirdMax = maxInWindowThird(points, "first");
    const lastThirdMax = maxInWindowThird(points, "last");
    const windowMax = maxInWindow(points);
    const grew =
      firstThirdMax === null || lastThirdMax === null
        ? false
        : lastThirdMax > firstThirdMax + G6S_RESIDENCY_GROWTH_SLACK;
    let budgetBound: number | null = null;
    let overBudget = false;
    if (name === "host retained payloads" && hostRetainedBound !== null) {
      budgetBound = hostRetainedBound;
      overBudget = windowMax !== null && windowMax > hostRetainedBound;
    } else if (name === "receiver memory-cache entries" && memBudgetBound !== null) {
      // Bound and comparison both in bytes; `windowMax` above is entries, so use the bytes max.
      budgetBound = memBudgetBound;
      overBudget = memBytesMax !== null && memBytesMax > memBudgetBound;
    }
    // Once a metric has a budget-derived bound, that bound is the test -- the growth half is
    // skipped for it, not ANDed in. Measured on a real honest soak-scene run: active LRU eviction
    // near a byte budget makes the receiver's memory-cache ENTRY COUNT oscillate by itself (first-
    // third max 113, last-third max 120, evicting and re-admitting differently sized payloads is
    // ordinary behaviour, not growth) while its BYTES stayed under budget the whole time. A metric
    // with no configured/derived bound (the mirror and live-RID counts) has no such budget-driven
    // noise source, so it keeps the growth check as its only signal.
    const bounded = budgetBound !== null ? !overBudget : !grew;
    return { name, firstThirdMax, lastThirdMax, budgetBound, windowMax, bounded };
  });
}

export function checkResidencyBounded(
  leg: G6sLeg,
  ev: G6sLegEvidence,
): Gate6Check {
  const metrics = residencyMetrics(ev, leg.inline);
  const unbounded = metrics.filter((m) => !m.bounded).map((m) => m.name);
  const problems: string[] = [];
  if (leg.failsMetric === null) {
    for (const name of unbounded)
      problems.push(`${name} grew or exceeded its budget-derived bound`);
  } else {
    if (!unbounded.includes(leg.failsMetric))
      problems.push(
        `expected exactly "${leg.failsMetric}" to grow or exceed its budget-derived bound; it did not (flagged: ${unbounded.join(", ") || "none"})`,
      );
    const others = unbounded.filter((n) => n !== leg.failsMetric);
    if (others.length > 0)
      problems.push(`unexpectedly also flagged: ${others.join(", ")}`);
  }
  const detail = metrics
    .map(
      (m) =>
        `${m.name} ${m.firstThirdMax ?? "?"}->${m.lastThirdMax ?? "?"}` +
        (m.budgetBound !== null
          ? ` (window max ${m.windowMax ?? "?"}, bound ${m.budgetBound})`
          : ""),
    )
    .join("; ");
  return check(
    `g6s-residency-bounded-${leg.leg}`,
    `${leg.leg}: every residency count's last-third max is at most its first-third max, and every budgeted count stays within its budget-derived bound${leg.failsMetric ? ` (except "${leg.failsMetric}")` : ""}`,
    problems,
    detail,
    [
      join(G6S_DIR, leg.leg, "host", "evidence", "perf-timeline.jsonl"),
      join(G6S_DIR, leg.leg, "receiver", "perf.json"),
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// cache-budget-respected
// ---------------------------------------------------------------------------------------------

export function checkCacheBudgetRespected(
  leg: G6sLeg,
  ev: G6sLegEvidence,
): Gate6Check {
  const problems: string[] = [];
  const memBytes = receiverSeries(ev, (l) => l.cache_bytes_memory).map(
    (p) => p.v,
  );
  const diskBytes = receiverSeries(ev, (l) => l.cache_bytes_disk).map(
    (p) => p.v,
  );
  const maxMem = memBytes.length > 0 ? Math.max(...memBytes) : null;
  const maxDisk = diskBytes.length > 0 ? Math.max(...diskBytes) : null;
  const summary = ev.applied?.resources_summary;
  const evictionsMemory = summary?.evictions_memory ?? 0;
  const evictionsDisk = summary?.evictions_disk ?? 0;
  const noEvict = leg.leg === "sabotage-soak-no-evict";
  // soak-inline runs with no cache directory and the receiver's generous default memory budget
  // (run-gate6.sh's g6s_leg soak-inline), by design: it exercises inline delivery and the
  // carried-set growth check (checkCarriedGrowthBounded), never the budgets or eviction. Evicting
  // a hash with no disk or HTTP fallback, and no way for the host to ever resend it (memory
  // g6s-carried-set-resource-duplicate), would be unrecoverable for a recurring one (MS, SM).
  if (leg.inline) {
    if (evictionsMemory > 0 || evictionsDisk > 0)
      problems.push(
        `soak-inline should never evict (no fallback source for a recurring hash): evictions_memory ${evictionsMemory}, evictions_disk ${evictionsDisk}`,
      );
  } else if (!noEvict) {
    if (maxMem !== null && maxMem > G6S_MEMORY_BUDGET_BYTES + G6S_ONE_PAYLOAD_SLACK_BYTES)
      problems.push(
        `memory-cache bytes ${maxMem} exceeded the budget (${G6S_MEMORY_BUDGET_BYTES}) plus one payload`,
      );
    if (
      maxDisk !== null &&
      maxDisk > G6S_CACHE_BUDGET_BYTES + G6S_ONE_PAYLOAD_SLACK_BYTES
    )
      problems.push(
        `disk-cache bytes ${maxDisk} exceeded the budget (${G6S_CACHE_BUDGET_BYTES}) plus one payload`,
      );
    if (evictionsMemory <= 0)
      problems.push("evictions_memory is 0: the budget was never exercised");
  } else if (evictionsMemory > 0) {
    problems.push(
      `no-evict sabotage: evictions_memory should be 0, got ${evictionsMemory}`,
    );
  }
  const detail =
    `max memory bytes ${maxMem ?? "?"}, max disk bytes ${maxDisk ?? "?"}, ` +
    `evictions_memory ${evictionsMemory}, evictions_disk ${evictionsDisk}, ` +
    `refetch_after_evict ${summary?.refetch_after_evict ?? 0} ` +
    "(whether an evicted hash was ever in the needed set at eviction time is proven by " +
    "receiver/tests/applier2_selftest.gd's _test_cache_budgets(), not re-derived from this " +
    "run's evidence: RS_RECEIVER_LOG=summary and GRC_HOOK_LOG=off leave no per-event trail for a " +
    "300-s soak to reconstruct it from externally)";
  return check(
    `g6s-cache-budget-respected-${leg.leg}`,
    `${leg.leg}: ${leg.inline ? "no eviction at all (no fallback source for a recurring hash)" : noEvict ? "memory- and disk-cache bytes stay within budget plus one payload (no-evict: never evicted at all)" : "memory- and disk-cache bytes stay within budget plus one payload; the budget was actually exercised"}`,
    problems,
    detail,
    [join(G6S_DIR, leg.leg, "receiver", "perf.json"), join(G6S_DIR, leg.leg, "receiver", "applied.json")],
  );
}

// ---------------------------------------------------------------------------------------------
// rss-bounded
// ---------------------------------------------------------------------------------------------

const MIB = 1 << 20;

export function checkRssBounded(leg: G6sLeg, ev: G6sLegEvidence): Gate6Check {
  const problems: string[] = [];
  const hostRss =
    ev.hostProc.length > 0
      ? procRssSeries(ev.hostProc)
      : hostSeries(ev, (l) => l.rss_bytes);
  const recvRss =
    ev.receiverProc.length > 0
      ? procRssSeries(ev.receiverProc)
      : receiverSeries(ev, (l) => l.rss_bytes);
  const hostFirst = medianInWindowEnd(hostRss, 30, "start");
  const hostLast = medianInWindowEnd(hostRss, 30, "finish");
  const hostSlope = slopePerMinute(hostRss);
  if (hostFirst !== null && hostLast !== null && hostLast - hostFirst > 4 * MIB)
    problems.push(
      `host RSS median rose ${((hostLast - hostFirst) / MIB).toFixed(2)} MiB (last 30s - first 30s), budget 4 MiB`,
    );
  if (hostSlope !== null && hostSlope > 0.5 * MIB)
    problems.push(
      `host RSS slope ${(hostSlope / MIB).toFixed(3)} MiB/min, budget 0.5 MiB/min`,
    );
  const recvFirst = medianInWindowEnd(recvRss, 30, "start");
  const recvLast = medianInWindowEnd(recvRss, 30, "finish");
  const recvSlope = slopePerMinute(recvRss);
  if (recvFirst !== null && recvLast !== null && recvLast - recvFirst > 16 * MIB)
    problems.push(
      `receiver RSS median rose ${((recvLast - recvFirst) / MIB).toFixed(2)} MiB, budget 16 MiB`,
    );
  if (recvSlope !== null && recvSlope > 2 * MIB)
    problems.push(
      `receiver RSS slope ${(recvSlope / MIB).toFixed(3)} MiB/min, budget 2 MiB/min`,
    );
  const videoMem = receiverSeries(ev, (l) => l.video_mem_bytes);
  const videoAt60 = videoMem.find((p) => p.t >= G6S_WINDOW_START_S)?.v ?? null;
  const videoAtEnd = videoMem.length > 0 ? videoMem[videoMem.length - 1].v : null;
  if (videoAt60 !== null && videoAtEnd !== null && videoAtEnd > videoAt60 + MIB)
    problems.push(
      `receiver VIDEO_MEM_USED rose from ${videoAt60} to ${videoAtEnd} (budget +1 MiB)`,
    );
  const detail =
    `host RSS ${hostFirst ?? "?"}->${hostLast ?? "?"} (slope ${hostSlope?.toFixed(3) ?? "?"} MiB/min), ` +
    `receiver RSS ${recvFirst ?? "?"}->${recvLast ?? "?"} (slope ${recvSlope?.toFixed(3) ?? "?"} MiB/min), ` +
    `receiver video mem ${videoAt60 ?? "?"}->${videoAtEnd ?? "?"}`;
  return check(
    `g6s-rss-bounded-${leg.leg}`,
    `${leg.leg}: host and receiver RSS stay within Q7e's slope and delta budgets over the soak`,
    problems,
    detail,
    [
      join(G6S_DIR, leg.leg, "host", "proc-samples.jsonl"),
      join(G6S_DIR, leg.leg, "receiver", "proc-samples.jsonl"),
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// soak-pixels
// ---------------------------------------------------------------------------------------------

async function loadPng(path: string): Promise<Frame6 | null> {
  const png = await decodePngRgba(path);
  return png ? { width: png.width, height: png.height, rgba: png.data } : null;
}

function shotNameFor(stream: number, seq: number): string {
  return stream === 1 ? `seq-${seq}.png` : `stream-${stream}-seq-${seq}.png`;
}

export async function checkSoakPixels(
  leg: G6sLeg,
  ev: G6sLegEvidence,
  g6sDir: string,
  e: Gate6Expected,
): Promise<Gate6Check> {
  const problems: string[] = [];
  const referencePath = join(g6sDir, "reference-step11", "shots", "step-11.png");
  const reference = await loadPng(referencePath);
  const shots = ev.applied?.shots ?? [];
  // realtime pacing means no frame number is known in advance (unlike g6l's frame-indexed
  // `steps` time): the runner requests many windows late in the run (g6s_windows()) and this
  // picks whichever one actually landed latest, by its own recorded wire frame.
  const last = shots.reduce<(typeof shots)[number] | undefined>((best, s) => {
    if (s.frame === undefined) return best;
    if (best === undefined || (best.frame ?? -1) < s.frame) return s;
    return best;
  }, undefined);
  let final: Frame6 | null = null;
  if (last && last.seq !== undefined) {
    final = await loadPng(
      join(g6sDir, leg.leg, "receiver", "shots", shotNameFor(last.stream ?? 1, last.seq)),
    );
  }
  if (!reference) problems.push(`cannot read ${referencePath}`);
  if (!last) problems.push("applied.json has no shots with a recorded frame");
  if (last && !final) problems.push(`cannot read the final shot (seq ${last?.seq})`);
  let mismatched = 0;
  let maxDelta = 0;
  if (reference && final) {
    const shotExpected = e.shots.find((s) => s.id === "step-11");
    const regions = shotExpected?.regions ?? e.regions;
    const exclude = excludedRegions("animate");
    const diff = diffFrames6(reference, final, regions, exclude);
    mismatched = diff.mismatched;
    maxDelta = diff.max_delta;
    if (mismatched > 0)
      problems.push(
        `${mismatched} pixels differ from the reference (max channel delta ${maxDelta}), regions ${JSON.stringify(diff.regions)}`,
      );
  }
  return check(
    `g6s-soak-pixels-${leg.leg}`,
    `${leg.leg}: the final shot equals the soak-timeline reference's step-11 shot, whole frame outside HU, budget 0`,
    problems,
    `${mismatched} mismatched pixels, max delta ${maxDelta}`,
    [referencePath, join(g6sDir, leg.leg, "receiver", "shots")],
  );
}

// ---------------------------------------------------------------------------------------------
// soak-inline: the hub's per-connection carried-hash set grows only as fast as genuinely novel
// inline content explains, never unboundedly faster.
//
// render-stream-2.md's resource-duplicate rule ("each hash at most once" per stream) is load-
// bearing: a receiver that sees any hash carried twice refuses the replay (confirmed against a
// real soak-inline run -- MS's mesh surface recurs every 90 frames under its sine-wave motion, so
// pruning `carried` to "reachable from the base" and re-sending a returning hash, as an earlier
// draft of this check assumed, broke the first real run with `resource-duplicate`). `carried`
// therefore holds one entry per distinct hash this connection has EVER sent, for its whole life,
// by design -- "bounded" cannot mean "stops growing" for a variant with ever-novel content
// (`animate`'s TEXA, one new hash every 30 frames = 2/s = 120/min). What IS checkable is that the
// growth rate stays near that explainable rate rather than runaway (every frame's MS/SM update
// wrongly minting a "new" entry, say, would run at up to 3600/min).
// ---------------------------------------------------------------------------------------------

// TEXA alone (the only ever-novel inline resource in `animate`) adds about 120/min; this ceiling
// gives it generous headroom (SM/CM/MS/PB are each a bounded, repeating set of hashes, so they
// stop contributing new entries once each has been seen once).
export const G6S_CARRIED_GROWTH_CEILING_PER_MINUTE = 200;

export function checkCarriedGrowthBounded(ev: G6sLegEvidence): Gate6Check {
  const problems: string[] = [];
  const series = hostSeries(ev, (l) => l.connections[0]?.carried_size);
  const slope = slopePerMinute(series);
  if (slope !== null && slope > G6S_CARRIED_GROWTH_CEILING_PER_MINUTE)
    problems.push(
      `carried_size grew at ${slope.toFixed(1)}/min, more than genuinely novel content (TEXA, ~120/min) explains (ceiling ${G6S_CARRIED_GROWTH_CEILING_PER_MINUTE}/min)`,
    );
  return check(
    "g6s-carried-growth-bounded-soak-inline",
    "soak-inline: the hub's per-connection carried-hash set grows only as fast as genuinely novel inline content, never unboundedly faster",
    problems,
    `carried_size growth ${slope?.toFixed(1) ?? "?"}/min (ceiling ${G6S_CARRIED_GROWTH_CEILING_PER_MINUTE}/min)`,
    [join(G6S_DIR, "soak-inline", "host", "evidence", "perf-timeline.jsonl")],
  );
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

export interface G6sLegEntry {
  group: "g6s";
  expected_class: string;
  result_class: string | null;
  pixel_verdict?: string;
  expected_pixel_verdict?: string;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface Gate6sResult {
  checks: Gate6Check[];
  legs: Record<string, G6sLegEntry>;
  stability: Record<string, unknown>;
}

export async function runGate6s(
  out: string,
  e: Gate6Expected,
): Promise<Gate6sResult> {
  const g6sDir = join(out, G6S_DIR);
  const checks: Gate6Check[] = [];
  const legs: Record<string, G6sLegEntry> = {};
  const stability: Record<string, unknown> = {};
  for (const leg of G6S_LEGS) {
    const ev = await loadG6sLeg(g6sDir, leg.leg);
    checks.push(checkResidencyBounded(leg, ev));
    checks.push(checkCacheBudgetRespected(leg, ev));
    checks.push(checkRssBounded(leg, ev));
    checks.push(await checkSoakPixels(leg, ev, g6sDir, e));
    if (leg.inline) checks.push(checkCarriedGrowthBounded(ev));
    legs[leg.leg] = {
      group: "g6s",
      expected_class: leg.failsMetric ? "residency-bounded fails" : "success",
      result_class:
        ev.hostExitCode === 0 && ev.receiverExitCode === 0 ? "success" : "failed",
      reasons: [],
      exit_code: ev.receiverExitCode,
      artifacts: [join(G6S_DIR, leg.leg)],
    };
    stability[leg.leg] = {
      residency: residencyMetrics(ev, leg.inline),
      evictions: ev.applied?.resources_summary,
    };
  }
  return { checks, legs, stability };
}
