// Gate 7 decode/apply microbench: per-phase summaries and Q13e's decision rule (G7d builds and
// runs the desktop arms; G7m runs the phone arms with the same code). Pure functions over the
// arms' raw outputs:
//   - GSW (web/bench/bench.ts `render-stream-gate7-gsw-bench/1`): exact per-record samples of
//     decode / hash / validate / resolve, one record per rAF;
//   - native (receiver.gd file mode, RS_RECEIVER_PERF_OUT `render-stream-receiver-perf/1`): rs_perf's
//     decode_us (accept_record: decode, validation and resolve, combined) and apply_us histograms
//     (16 sub-buckets per octave, so a percentile is good to about 3 %; the mean is exact).

import { type WatchdogSample, watchdogVerdict } from "./browser-harness";

export type Phase =
  | "decode"
  | "hash"
  | "validate"
  | "resolve"
  | "apply"
  | "total";

export interface PhaseStats {
  count: number;
  mean_us: number;
  p50_us: number;
  p95_us: number;
  max_us: number;
}

export interface BenchRepeatSummary {
  repeat: number;
  valid: boolean;
  watchdog_reasons: string[];
  tp_ms: number | null;
  error: string | null;
  phases: Partial<Record<Phase, PhaseStats>>;
}

export interface BenchInputSummary {
  receiver: "gsw" | "native" | "web";
  input: string;
  transactions: number;
  repeats: BenchRepeatSummary[];
  /** Pooled over every valid measured repeat's transactions. */
  phases: Partial<Record<Phase, PhaseStats>>;
  /** `total` p95 = decode + validate + resolve (+ apply for native and web), the decision quantity. */
  total_p95_us: number | null;
  tp_ms: number | null;
  notes: string[];
}

function stats(values: number[]): PhaseStats {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    s.length === 0
      ? 0
      : s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return {
    count: s.length,
    mean_us: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0,
    p50_us: at(0.5),
    p95_us: at(0.95),
    max_us: s.length ? s[s.length - 1] : 0,
  };
}

interface GswSample {
  kind: string;
  total_us: number;
  decode_us: number;
  hash_us: number;
  resolve_us: number;
  validate_us: number;
}

interface GswRepeat {
  repeat: number;
  warmup: boolean;
  error: string | null;
  raf: { tp_ms: number };
  watchdog: WatchdogSample;
  samples: GswSample[];
}

export interface GswBenchJson {
  schema: "render-stream-gate7-gsw-bench/1";
  input: { name: string; records: number };
  page: { crossOriginIsolated: boolean; timer_resolution_us: number };
  results: GswRepeat[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const GSW_PHASES: [Phase, keyof GswSample][] = [
  ["decode", "decode_us"],
  ["hash", "hash_us"],
  ["validate", "validate_us"],
  ["resolve", "resolve_us"],
  ["total", "total_us"],
];

export function summarizeGswBench(json: GswBenchJson): BenchInputSummary {
  const repeats: BenchRepeatSummary[] = [];
  const pooled = new Map<Phase, number[]>();
  const notes: string[] = [];
  if (!json.page.crossOriginIsolated)
    notes.push(
      `page not crossOriginIsolated: performance.now() resolution ${json.page.timer_resolution_us} us`,
    );
  let transactions = 0;
  for (const r of json.results) {
    if (r.warmup) continue;
    const verdict = watchdogVerdict(r.watchdog);
    const tx = r.samples.filter((s) => s.kind === "transaction");
    transactions = Math.max(transactions, tx.length);
    const phases: Partial<Record<Phase, PhaseStats>> = {};
    for (const [phase, key] of GSW_PHASES) {
      const values = tx.map((s) => s[key] as number);
      phases[phase] = stats(values);
      if (verdict.valid && !r.error) {
        const list = pooled.get(phase) ?? [];
        list.push(...values);
        pooled.set(phase, list);
      }
    }
    repeats.push({
      repeat: r.repeat,
      valid: verdict.valid && !r.error,
      watchdog_reasons: verdict.reasons,
      tp_ms: r.raf.tp_ms,
      error: r.error,
      phases,
    });
  }
  const phases: Partial<Record<Phase, PhaseStats>> = {};
  for (const [phase] of GSW_PHASES) {
    const values = pooled.get(phase);
    if (values) phases[phase] = stats(values);
  }
  return {
    receiver: "gsw",
    input: json.input.name,
    transactions,
    repeats,
    phases,
    total_p95_us: phases.total?.p95_us ?? null,
    tp_ms: median(repeats.filter((r) => r.valid).map((r) => r.tp_ms ?? 0)),
    notes,
  };
}

/** rs_perf.gd's Histogram dict. */
export interface PerfHistogram {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  buckets: [number, number][];
}

/** The lower bound of the bucket after the one starting at `lower` (rs_perf's scheme). */
function nextBucketLower(lower: number): number {
  if (lower <= 1) return 2;
  const octave = Math.floor(Math.log2(lower));
  return lower + Math.max(1, Math.floor(2 ** octave / 16));
}

export function mergeHistograms(list: PerfHistogram[]): PerfHistogram {
  const buckets = new Map<number, number>();
  let count = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const h of list) {
    count += h.count;
    sum += h.sum;
    if (h.count > 0) min = Math.min(min, h.min);
    max = Math.max(max, h.max);
    for (const [lower, n] of h.buckets)
      buckets.set(lower, (buckets.get(lower) ?? 0) + n);
  }
  return {
    count,
    sum,
    min: Number.isFinite(min) ? min : 0,
    max,
    mean: count ? sum / count : 0,
    buckets: [...buckets.entries()].sort((a, b) => a[0] - b[0]),
  };
}

/** A percentile from the buckets: the midpoint of the bucket holding it, clamped to [min, max]. */
export function histogramPercentile(h: PerfHistogram, p: number): number {
  if (h.count === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * h.count));
  let seen = 0;
  for (const [lower, n] of h.buckets) {
    seen += n;
    if (seen >= rank) {
      const mid = (lower + nextBucketLower(lower)) / 2;
      return Math.min(h.max, Math.max(h.min, mid));
    }
  }
  return h.max;
}

function histStats(h: PerfHistogram): PhaseStats {
  return {
    count: h.count,
    mean_us: h.mean,
    p50_us: histogramPercentile(h, 0.5),
    p95_us: histogramPercentile(h, 0.95),
    max_us: h.max,
  };
}

export interface NativePerfJson {
  schema: string;
  histograms?: { decode_us?: PerfHistogram; apply_us?: PerfHistogram };
  decode_us?: PerfHistogram;
  apply_us?: PerfHistogram;
}

function nativeHist(
  json: NativePerfJson,
  key: "decode_us" | "apply_us",
): PerfHistogram | null {
  return json.histograms?.[key] ?? json[key] ?? null;
}

/** Native repeats (warmup excluded by the caller): decode (= decode + validate + resolve) and apply. */
export function summarizeNativeBench(
  input: string,
  perRepeat: {
    repeat: number;
    perf: NativePerfJson | null;
    exit: number | null;
  }[],
): BenchInputSummary {
  const repeats: BenchRepeatSummary[] = [];
  const decodes: PerfHistogram[] = [];
  const applies: PerfHistogram[] = [];
  for (const r of perRepeat) {
    const decode = r.perf ? nativeHist(r.perf, "decode_us") : null;
    const apply = r.perf ? nativeHist(r.perf, "apply_us") : null;
    const ok = r.exit === 0 && decode !== null && apply !== null;
    if (ok && decode && apply) {
      decodes.push(decode);
      applies.push(apply);
    }
    repeats.push({
      repeat: r.repeat,
      valid: ok,
      watchdog_reasons: [],
      tp_ms: null,
      error: ok
        ? null
        : `exit ${r.exit}, perf ${r.perf ? "present" : "missing"}`,
      phases:
        ok && decode && apply
          ? { decode: histStats(decode), apply: histStats(apply) }
          : {},
    });
  }
  const decode = mergeHistograms(decodes);
  const apply = mergeHistograms(applies);
  return {
    receiver: "native",
    input,
    transactions: decodes[0]?.count ?? 0,
    repeats,
    phases: decodes.length
      ? { decode: histStats(decode), apply: histStats(apply) }
      : {},
    // Per-transaction sums are not recoverable from two histograms; p95(decode) + p95(apply) bounds
    // p95(decode + apply) from above, which is the conservative side of the decision rule.
    total_p95_us: decodes.length
      ? histogramPercentile(decode, 0.95) + histogramPercentile(apply, 0.95)
      : null,
    tp_ms: null,
    notes: [
      "native decode_us is RsApplier.accept_record (decode, validation and resolve combined, rs_perf.gd); percentiles from 1/16-octave buckets, means exact",
      "total_p95_us = p95(decode) + p95(apply), an upper bound of p95(decode + apply)",
    ],
  };
}

/** Q13e's decision rule for one receiver, input and phone. */
export interface BenchDecision {
  verdict:
    | "pass"
    | "device-decode-over-budget"
    | "early-signal"
    | "unavailable";
  budget_us: number;
  total_p95_us: number | null;
  detail: string;
}

/**
 * Device arm: pass when p95 of the per-transaction decode + validate + resolve (+ apply where the
 * receiver applies) is <= 0.5 T_p at the phone's measured T_p, else `device-decode-over-budget`.
 * Desktop arm: the early signal against D27's lines (GSW: the phone factor 4-5x puts the g31's line
 * at about 1.7 ms; native and web: the 8.3 ms whole-frame budget itself).
 */
export function decide(
  summary: BenchInputSummary,
  env: "desktop" | "device",
  tpMs: number | null,
): BenchDecision {
  const total = summary.total_p95_us;
  if (total === null)
    return {
      verdict: "unavailable",
      budget_us: 0,
      total_p95_us: null,
      detail: "no valid repeat",
    };
  if (env === "device") {
    const tp = tpMs ?? summary.tp_ms;
    const budget = tp === null ? 0 : 0.5 * tp * 1000;
    const pass = tp !== null && total <= budget;
    return {
      verdict: pass ? "pass" : "device-decode-over-budget",
      budget_us: budget,
      total_p95_us: total,
      detail: `p95 ${(total / 1000).toFixed(3)} ms against 0.5 T_p = ${(budget / 1000).toFixed(3)} ms`,
    };
  }
  const line = summary.receiver === "gsw" ? 1700 : 8333;
  return {
    verdict: "early-signal",
    budget_us: line,
    total_p95_us: total,
    detail: `desktop p95 ${(total / 1000).toFixed(3)} ms ${total <= line ? "under" : "OVER"} the ${(line / 1000).toFixed(1)}-ms ${summary.receiver === "gsw" ? "g31 line (8.3 ms / 4-5x, D27)" : "g31 whole-frame budget (D27)"}`,
  };
}
