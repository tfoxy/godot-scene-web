#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for G7k's pure evaluators (lib/gate7k-checks.ts), driven with synthetic values only:
//
//  1. checkGrowthBounded: a flat series passes; a series growing past the budget and one past the
//     slope fail naming each; too few samples is `unavailable` (failing), never a pass.
//  2. checkEndVsSixtySecondValue: end within budget passes, beyond fails, a shrinking series passes.
//  3. gswBudgetAdjusted: the overshoot of the unevictable floor is removed, an unbounded store is not.
//  4. failureSetProblems: exact sets pass; a missing and an extra failure each fail.
//  5. checkStartupComplete / checkStartupWarmFetches: ordering, missing marks, cache refetches
//     (evidence PUTs are not bundle loads).

import type { G6sLegEvidence } from "../lib/gate6s-checks";
import {
  checkEndVsSixtySecondValue,
  checkGrowthBounded,
  checkStartupComplete,
  checkStartupWarmFetches,
  failureSetProblems,
  G7K_SABOTAGE_SETS,
  gswBudgetAdjusted,
  type TimingsJson,
} from "../lib/gate7k-checks";

let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}

const MIB = 1 << 20;
const series = (f: (t: number) => number) =>
  Array.from({ length: 371 }, (_, t) => ({ t, v: f(t) }));

// 1
expect("growth: flat passes", checkGrowthBounded("a", "x", series(() => 5 * MIB), 4 * MIB, MIB).passed);
const grow = checkGrowthBounded("a", "x", series((t) => 5 * MIB + t * 0.1 * MIB), 4 * MIB, 0.5 * MIB);
expect("growth: growth and slope both named", !grow.passed && /growth/.test(grow.detail) && /slope/.test(grow.detail), grow.detail);
const few = checkGrowthBounded("a", "x", [{ t: 1, v: 1 }], 1, 1);
expect("growth: one sample is unavailable, failing", !few.passed && few.detail.startsWith("unavailable"), few.detail);

// 2
expect("end: within budget", checkEndVsSixtySecondValue("a", "x", series((t) => (t > 60 ? 10 * MIB : 9 * MIB)), 16 * MIB).passed);
expect("end: beyond budget", !checkEndVsSixtySecondValue("a", "x", series((t) => (t > 60 ? 80 * MIB : 9 * MIB)), 16 * MIB).passed);
expect("end: shrinking passes", checkEndVsSixtySecondValue("a", "x", series((t) => 30 * MIB - t * 1000), 8 * MIB).passed);

// 3
const evOf = (bytes: number, floor: number): G6sLegEvidence =>
  ({
    leg: "x",
    hostTimeline: [],
    hostProc: [],
    receiverProc: [],
    applied: undefined,
    hostExitCode: null,
    receiverExitCode: null,
    receiverPerf: {
      schema: "x",
      timeline: [{ t_us: 1, cache_bytes_memory: bytes, memory_floor_bytes: floor }],
    },
  }) as unknown as G6sLegEvidence;
const adj = (e: G6sLegEvidence) => e.receiverPerf?.timeline[0].cache_bytes_memory;
expect("budget: floor overshoot removed", adj(gswBudgetAdjusted(evOf(1_066_260, 1_066_260), MIB)) === MIB, String(adj(gswBudgetAdjusted(evOf(1_066_260, 1_066_260), MIB))));
expect("budget: unbounded store stays over", (adj(gswBudgetAdjusted(evOf(9 * MIB, 1_066_260), MIB)) ?? 0) > MIB + 16512);

// 4
const ne = G7K_SABOTAGE_SETS["sabotage-soak-no-evict"];
expect("sets: exact", failureSetProblems(ne.required.gsw, ne.required.gsw, ne.allowed.gsw).length === 0);
expect("sets: allowed consequence", failureSetProblems([...ne.required.gsw, "js-heap-bounded"], ne.required.gsw, ne.allowed.gsw).length === 0);
expect("sets: missing", failureSetProblems(["wasm-heap-bounded"], ne.required.gsw, ne.allowed.gsw).some((p) => /did not/.test(p)));
expect("sets: extra", failureSetProblems([...ne.required.gsw, "soak-pixels"], ne.required.gsw, ne.allowed.gsw).some((p) => /also failed: soak-pixels/.test(p)));

// 5
const timings = (marks: [string, number][], resources: TimingsJson["resources"] = []): TimingsJson => ({
  schema: "x", wall_ms: 1, exit: 0, error: null,
  marks: marks.map(([name, t]) => ({ name, t })), resources,
});
const web = ["rs-engine-init-end", "rs-socket-open", "rs-session-decoded", "rs-first-applied", "rs-first-submitted"];
const ok = timings(web.map((n, i) => [n, 10 + i] as [string, number]));
expect("startup: complete", checkStartupComplete("a", "web", "l", ok).passed);
expect("startup: missing mark", !checkStartupComplete("a", "web", "l", timings(web.slice(1).map((n, i) => [n, i] as [string, number]))).passed);
expect("startup: out of order", !checkStartupComplete("a", "web", "l", timings(web.map((n, i) => [n, 100 - i] as [string, number]))).passed);
const res = (name: string, transfer: number) => ({ name, start: 0, end: 1, transfer, decoded: 1 });
expect("warm: all cached", checkStartupWarmFetches("a", "l", timings([], [res("http://h/web-bundle/receiver.wasm", 0), res("http://h/resources/sha256/a", 0)])).passed);
expect("warm: evidence PUT is not a bundle load", checkStartupWarmFetches("a", "l", timings([], [res("http://h/evidence/n/applied.json", 5000)])).passed);
expect("warm: bundle refetch fails", !checkStartupWarmFetches("a", "l", timings([], [res("http://h/web-bundle/receiver.wasm", 1000)])).passed);
expect("warm: payload refetch fails", !checkStartupWarmFetches("a", "l", timings([], [res("http://h/resources/sha256/a", 100)])).passed);

if (failures > 0) {
  console.log(`self-test-gate7k: ${failures} failure(s)`);
  process.exit(1);
}
console.log("self-test-gate7k: all passed");
