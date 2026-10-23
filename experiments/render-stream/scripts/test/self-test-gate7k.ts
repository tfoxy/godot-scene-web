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
//  6. (G7kr) rssRendererBudget's per-GET allowance, and asKnownShortfall: the web export's
//     `rss-bounded-renderer` is report-only, never a pass, with its measured slope and an owner.

import type { G6sLegEvidence } from "../lib/gate6s-checks";
import {
  asKnownShortfall,
  checkEndVsSixtySecondValue,
  checkGrowthBounded,
  checkStartupComplete,
  checkStartupWarmFetches,
  failureSetProblems,
  G7K_SABOTAGE_SETS,
  gswBudgetAdjusted,
  rssRendererBudget,
  type TimingsJson,
  WEB_RENDERER_RSS_SHORTFALL,
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

// 6 (G7kr): the page renderer's budget carries a per-GET allowance
const hb = rssRendererBudget(16475, 385);
// the honest GSW soak measured +48.5..50.1 MB and 10.8..10.9 MB/min with 16,475 GETs
expect("rss budget: honest GSW growth fits", 50.1e6 < hb.growthBytes && 10.9e6 < hb.slopePerMinBytes, JSON.stringify(hb));
expect("rss budget: honest GSW slope is within 2x of the budget", hb.slopePerMinBytes < 2 * 10.9e6, JSON.stringify(hb));
const nb = rssRendererBudget(130, 385);
expect("rss budget: few GETs keep about Q10's base", nb.growthBytes < 17.5 * MIB && nb.slopePerMinBytes < 2.2 * MIB, JSON.stringify(nb));
expect("rss budget: no count keeps Q10's base", rssRendererBudget(null, 0).growthBytes === 16 * MIB);
const leak = (rate: number) => series((t) => 180 * MIB + (t * rate * MIB) / 60);
expect("rss: honest-GSW-shaped growth passes with its GET budget", checkGrowthBounded("a", "x", leak(10.9 / 1.048576), hb.growthBytes, hb.slopePerMinBytes).passed);
expect("rss: the same growth with 130 GETs fails (a leak with no GET to blame)", !checkGrowthBounded("a", "x", leak(10.9 / 1.048576), nb.growthBytes, nb.slopePerMinBytes).passed);
expect("rss: 2x the honest rate fails with the GET budget", !checkGrowthBounded("a", "x", leak(2 * 10.9 / 1.048576), hb.growthBytes, hb.slopePerMinBytes).passed);

// 6b (G7kr decision b): the web row is a known shortfall whatever the bound says
const webLike = series((t) => 400 * MIB + (t * 8 * MIB) / 60);
for (const [name, pts] of [["a leak", webLike], ["flat", series(() => 400 * MIB)]] as const) {
  const k = asKnownShortfall(checkGrowthBounded("w", "x", pts, 16 * MIB, 2 * MIB), pts, WEB_RENDERER_RSS_SHORTFALL);
  expect(`shortfall (${name}): never a pass, never gating`, !k.passed && !k.gating && k.status === "known-shortfall", JSON.stringify(k));
  expect(`shortfall (${name}): owner and cause in the row`, k.owner === "G7kw2" && /owner G7kw2/.test(k.detail) && /PartitionAlloc/.test(k.detail), k.detail);
}
const ks = asKnownShortfall(checkGrowthBounded("w", "x", webLike, 16 * MIB, 2 * MIB), webLike, WEB_RENDERER_RSS_SHORTFALL);
expect("shortfall: carries the measured slope", Math.abs((ks.measured.slope_bytes_per_min ?? 0) - 8 * MIB) < 0.01 * MIB && /outside the gating bound/.test(ks.detail), JSON.stringify(ks.measured));
const ku = asKnownShortfall(checkGrowthBounded("w", "x", [], 16 * MIB, 2 * MIB), [], WEB_RENDERER_RSS_SHORTFALL);
expect("shortfall: no samples stays unavailable inside, never a pass", !ku.passed && ku.measured.slope_bytes_per_min === null && /unavailable/.test(ku.detail));
expect("sets: web no-evict allows nothing (a known shortfall is in no failure set)", G7K_SABOTAGE_SETS["sabotage-soak-no-evict"].allowed.web.length === 0);

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
