// Gate 7x bench protocol and pass rule (protocol/gate7-design.md "G7x" "Bench protocol" and "Pass
// rule"). gate7-bench.ts drives the pages; this module plans the interleaved rounds, summarizes the
// Rust arms' raw JSON (web/bench/bench-rs.ts, `render-stream-gate7x-rs-bench/1`) and judges R2-R4.
//
// For each input: one warmup page per arm, then five rounds of (gsw-ts, gsw-rs, gsw-rs-inline), each
// arm on a fresh page load (and each page runs its own in-page warmup pass before the measured one,
// as G7m's pages did, so no arm is judged on a cold JIT). Interleaving gives every arm the same
// thermal and frequency state.

import type { WatchdogSample } from "./browser-harness";
import { watchdogVerdict } from "./browser-harness";

export type Arm7x = "gsw-ts" | "gsw-rs" | "gsw-rs-inline";
export const ARMS_7X: readonly Arm7x[] = ["gsw-ts", "gsw-rs", "gsw-rs-inline"];

/** G7m's recorded TypeScript p95 (results/gate7/g7m.md), under the same (inline) digest policy:
 * R2's thresholds, ms. */
export const R2_THRESHOLDS_MS: Record<string, number> = {
  "scene-full": 12.99,
  "scene-patch": 7.395,
  "hd-patch": 16.79,
  "pace-patch": 2.16,
};

/** R4's required inputs (D25); hd-patch is judged and recorded as the stretch target. */
export const R4_REQUIRED = ["pace-patch", "scene-patch", "scene-full"];

export interface PlannedPage {
  input: string;
  arm: Arm7x;
  /** 0 for the per-arm warmup page, 1..rounds for the measured rounds. */
  round: number;
}

export function planInterleaved(
  inputs: string[],
  arms: readonly Arm7x[],
  rounds: number,
): PlannedPage[] {
  const out: PlannedPage[] = [];
  for (const input of inputs) {
    for (const arm of arms) out.push({ input, arm, round: 0 });
    for (let round = 1; round <= rounds; round++)
      for (const arm of arms) out.push({ input, arm, round });
  }
  return out;
}

export interface Stats {
  count: number;
  mean_us: number;
  p50_us: number;
  p95_us: number;
  max_us: number;
}

export function stats(values: number[]): Stats {
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

interface RsSample {
  kind: string;
  total_us: number;
  decode_us: number;
  provide_us: number;
  apply_us: number;
  draw_us: number;
  evidence_hash_us: number;
  executed_calls: number;
  expected_calls: number;
}

interface RsRepeat {
  repeat: number;
  warmup: boolean;
  error: string | null;
  heap_bytes: number;
  parity_violations: number;
  digest_pending: number;
  raf: { tp_ms: number };
  gpu_complete_ms: { count: number; p50: number; p95: number };
  watchdog: WatchdogSample;
  samples: RsSample[];
}

export interface RsBenchJson {
  schema: "render-stream-gate7x-rs-bench/1";
  arm: "gsw-rs" | "gsw-rs-inline";
  input: { name: string; records: number };
  page: { crossOriginIsolated: boolean; timer_resolution_us: number };
  results: RsRepeat[];
}

/** One page's measured repeat, either arm family, reduced to what the pass rule reads. */
export interface RoundResult {
  input: string;
  arm: Arm7x;
  round: number;
  valid: boolean;
  reasons: string[];
  tp_ms: number | null;
  heap_bytes: number | null;
  phases: Record<string, Stats>;
  /** Raw per-transaction values of the judged phases, for pooling. */
  values: Record<string, number[]>;
  parity_violations: number;
  gpu_complete_ms: { count: number; p50: number; p95: number } | null;
}

const RS_PHASES = [
  "decode_us",
  "provide_us",
  "apply_us",
  "draw_us",
  "total_us",
  "evidence_hash_us",
] as const;

export function summarizeRsPage(
  json: RsBenchJson,
  round: number,
): RoundResult[] {
  const out: RoundResult[] = [];
  for (const r of json.results) {
    if (r.warmup) continue;
    const verdict = watchdogVerdict(r.watchdog);
    const tx = r.samples.filter((s) => s.kind === "transaction");
    const values: Record<string, number[]> = {};
    const phases: Record<string, Stats> = {};
    for (const k of RS_PHASES) {
      values[k] = tx.map((s) => s[k]);
      phases[k] = stats(values[k]);
    }
    const reasons = [...verdict.reasons];
    if (r.error) reasons.push(r.error);
    if (r.parity_violations > 0)
      reasons.push(`draw-count-parity: ${r.parity_violations} frame(s)`);
    out.push({
      input: json.input.name,
      arm: json.arm,
      round,
      valid: verdict.valid && !r.error,
      reasons,
      tp_ms: r.raf.tp_ms,
      heap_bytes: r.heap_bytes,
      phases,
      values,
      parity_violations: r.parity_violations,
      gpu_complete_ms: r.gpu_complete_ms,
    });
  }
  return out;
}

/** The TypeScript page (web/bench/bench.ts): `total_us` is accept() = decode + validate + resolve
 * (payload hashes included; the record digest outside it under G7o1's `deferred`). */
export function summarizeTsPage(
  json: {
    input: { name: string };
    results: Array<{
      warmup: boolean;
      error: string | null;
      raf: { tp_ms: number };
      watchdog: WatchdogSample;
      samples: Array<{
        kind: string;
        total_us: number;
        decode_us: number;
        hash_us: number;
        validate_us: number;
        resolve_us: number;
        evidence_hash_us?: number;
      }>;
    }>;
  },
  round: number,
): RoundResult[] {
  const out: RoundResult[] = [];
  for (const r of json.results) {
    if (r.warmup) continue;
    const verdict = watchdogVerdict(r.watchdog);
    const tx = r.samples.filter((s) => s.kind === "transaction");
    const values: Record<string, number[]> = {
      total_us: tx.map((s) => s.total_us),
      decode_us: tx.map((s) => s.decode_us),
      hash_us: tx.map((s) => s.hash_us),
      validate_us: tx.map((s) => s.validate_us),
      resolve_us: tx.map((s) => s.resolve_us),
      evidence_hash_us: tx.map((s) => s.evidence_hash_us ?? 0),
    };
    const phases: Record<string, Stats> = {};
    for (const [k, v] of Object.entries(values)) phases[k] = stats(v);
    out.push({
      input: json.input.name,
      arm: "gsw-ts",
      round,
      valid: verdict.valid && !r.error,
      reasons: [...verdict.reasons, ...(r.error ? [r.error] : [])],
      tp_ms: r.raf.tp_ms,
      heap_bytes: null,
      phases,
      values,
      parity_violations: 0,
      gpu_complete_ms: null,
    });
  }
  return out;
}

export interface Judgement {
  rule: "R2" | "R3" | "R4";
  input: string;
  pass: boolean;
  required: boolean;
  detail: string;
}

function pooled(results: RoundResult[], key: string): Stats {
  return stats(
    results.filter((r) => r.valid).flatMap((r) => r.values[key] ?? []),
  );
}

/** R2 to R4 (G7x "Pass rule") from the measured rounds of one environment. */
export function judge(results: RoundResult[], rounds: number): Judgement[] {
  const out: Judgement[] = [];
  const inputs = [...new Set(results.map((r) => r.input))];
  for (const input of inputs) {
    const of = (arm: Arm7x) =>
      results
        .filter((r) => r.input === input && r.arm === arm && r.round >= 1)
        .sort((a, b) => a.round - b.round);
    const ts = of("gsw-ts");
    const rs = of("gsw-rs");
    const inl = of("gsw-rs-inline");
    // R2: gsw-rs-inline decode_us p95 below G7m's recorded TypeScript p95.
    const r2 = pooled(inl, "decode_us");
    const line = R2_THRESHOLDS_MS[input];
    if (line !== undefined)
      out.push({
        rule: "R2",
        input,
        required: true,
        pass: r2.count > 0 && r2.p95_us / 1000 < line,
        detail: `gsw-rs-inline decode p95 ${(r2.p95_us / 1000).toFixed(3)} ms vs G7m TS ${line} ms (${inl.filter((r) => r.valid).length} valid rounds)`,
      });
    // R3: gsw-rs decode_us p95 below gsw-ts decode+validate+resolve p95, pooled and in >= 4 of 5
    // paired rounds.
    const rsP = pooled(rs, "decode_us");
    const tsP = pooled(ts, "total_us");
    let pairedWins = 0;
    const pairs: string[] = [];
    for (let k = 1; k <= rounds; k++) {
      const a = rs.find((r) => r.round === k);
      const b = ts.find((r) => r.round === k);
      if (!a?.valid || !b?.valid) {
        pairs.push(`r${k}:invalid`);
        continue;
      }
      const win = a.phases.decode_us.p95_us < b.phases.total_us.p95_us;
      if (win) pairedWins++;
      pairs.push(
        `r${k}:${(a.phases.decode_us.p95_us / 1000).toFixed(3)}<${(b.phases.total_us.p95_us / 1000).toFixed(3)}${win ? "" : "!"}`,
      );
    }
    out.push({
      rule: "R3",
      input,
      required: true,
      pass:
        rsP.count > 0 &&
        tsP.count > 0 &&
        rsP.p95_us < tsP.p95_us &&
        pairedWins >= Math.min(4, rounds),
      detail: `pooled gsw-rs decode p95 ${(rsP.p95_us / 1000).toFixed(3)} ms vs gsw-ts ${(tsP.p95_us / 1000).toFixed(3)} ms; paired ${pairedWins}/${rounds} (${pairs.join(" ")})`,
    });
    // R4: gsw-rs total_us p95 <= 0.5 T_p in EACH round (T_p measured in that round).
    let ok = 0;
    const per: string[] = [];
    for (let k = 1; k <= rounds; k++) {
      const a = rs.find((r) => r.round === k);
      if (!a?.valid || a.tp_ms === null) {
        per.push(`r${k}:invalid`);
        continue;
      }
      const budget = 0.5 * a.tp_ms;
      const p95 = a.phases.total_us.p95_us / 1000;
      if (p95 <= budget) ok++;
      per.push(`r${k}:${p95.toFixed(3)}/${budget.toFixed(3)}`);
    }
    out.push({
      rule: "R4",
      input,
      required: R4_REQUIRED.includes(input),
      pass: ok === rounds,
      detail: `gsw-rs total p95 / 0.5·T_p per round: ${per.join(" ")}${R4_REQUIRED.includes(input) ? "" : " (stretch, D25)"}`,
    });
  }
  return out;
}

export function fmtMs(us: number): string {
  return (us / 1000).toFixed(3);
}

/** The README table rows: per input and arm, p50/p95 of every phase, pooled over valid rounds. */
export function tableRows(results: RoundResult[]): string[] {
  const rows: string[] = [];
  const inputs = [...new Set(results.map((r) => r.input))];
  for (const input of inputs)
    for (const arm of ARMS_7X) {
      const rs = results.filter(
        (r) => r.input === input && r.arm === arm && r.round >= 1,
      );
      if (rs.length === 0) continue;
      const keys =
        arm === "gsw-ts"
          ? [
              "total_us",
              "decode_us",
              "hash_us",
              "validate_us",
              "resolve_us",
              "evidence_hash_us",
            ]
          : [
              "decode_us",
              "provide_us",
              "apply_us",
              "draw_us",
              "total_us",
              "evidence_hash_us",
            ];
      const cells = keys.map((k) => {
        const s = pooled(rs, k);
        return `${k.replace("_us", "")} ${fmtMs(s.p50_us)}/${fmtMs(s.p95_us)}`;
      });
      rows.push(
        `| ${input} | ${arm} | ${rs.filter((r) => r.valid).length}/${rs.length} | ${cells.join(" · ")} |`,
      );
    }
  return rows;
}
