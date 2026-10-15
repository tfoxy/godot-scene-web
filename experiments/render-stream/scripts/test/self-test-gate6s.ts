// Self-test for gate 6 group g6s (lib/gate6s-checks.ts), driven from self-test-gate6.ts's main:
// every pure evaluator with a passing and a failing case, on fabricated timelines (never a real
// Godot run).
//
//  1. relativeSeries, maxInWindowThird, medianInWindowEnd and slopePerMinute: the windowing math
//     Q7e's thresholds are built from, on synthetic point series.
//  2. residencyMetrics / checkResidencyBounded: a flat series is bounded; one that grows in the
//     last third is not; an honest leg's check fails on any growth, a sabotage's check fails only
//     when exactly its named metric grew (and fails differently when the wrong metric grew, or
//     when an unexpected second metric also grew); a series that plateaus before the window even
//     starts (the real shape both G6s sabotages produce) is still caught, via the budget-derived
//     bound half of the check, not the first-third-vs-last-third growth half.
//  3. checkCacheBudgetRespected: within budget and evicting passes; over budget fails; a run that
//     never evicted (budget never exercised) fails; the no-evict sabotage passes only when it
//     truly never evicted and fails if it did; soak-inline (no fallback source for a recurring
//     hash) passes only when it never evicted either, for the opposite reason.
//  4. checkRssBounded: flat RSS passes; a rise past the host/receiver deltas or slopes fails;
//     falls back to the engines' own self-reported rss_bytes when no /proc samples exist.
//  5. checkCarriedGrowthBounded: a flat carried_size passes; growth at TEXA's own rate (the
//     expected baseline under render-stream-2.md's resource-duplicate rule) passes; runaway
//     growth fails.

import {
  checkCacheBudgetRespected,
  checkCarriedGrowthBounded,
  checkResidencyBounded,
  checkRssBounded,
  G6S_CACHE_BUDGET_BYTES,
  G6S_MEMORY_BUDGET_BYTES,
  G6S_THIRD_S,
  G6S_WINDOW_END_S,
  G6S_WINDOW_START_S,
  type G6sLeg,
  type G6sLegEvidence,
  type HostTimelineLine,
  maxInWindowThird,
  medianInWindowEnd,
  type ProcSample,
  type ReceiverTimelineLine,
  relativeSeries,
  slopePerMinute,
} from "../lib/gate6s-checks";

export interface SelfTestHooks {
  assert: (name: string, ok: boolean, detail?: string) => void;
  passes: (name: string, problems: string[]) => void;
  fails: (name: string, problems: string[], needle?: string) => void;
}

const HONEST: G6sLeg = { leg: "soak-scene", failsMetric: null, inline: false };
const NO_EVICT: G6sLeg = {
  leg: "sabotage-soak-no-evict",
  failsMetric: "receiver memory-cache entries",
  inline: false,
};
const RETAIN: G6sLeg = {
  leg: "sabotage-soak-retain-superseded",
  failsMetric: "host retained payloads",
  inline: false,
};
const INLINE: G6sLeg = { leg: "soak-inline", failsMetric: null, inline: true };

/** One host timeline line at `tSeconds` (arm-relative), everything else flat unless given. */
function hostLine(
  tSeconds: number,
  overrides: Partial<HostTimelineLine> = {},
): HostTimelineLine {
  return {
    t_us: tSeconds * 1e6,
    frame: Math.round(tSeconds * 60),
    rss_bytes: 80_000_000,
    mirror_items: 50,
    mirror_textures: 8,
    mirror_meshes: 1,
    mirror_materials: 2,
    host_retained: 10,
    host_retained_bytes: 500_000,
    connections: [
      {
        connection: 1,
        sent: Math.round(tSeconds * 60),
        credits: Math.round(tSeconds * 60),
        coalesced: 0,
        ticks_credit_blocked: 0,
        max_pending_age_us: 0,
        bytes_sent: 0,
        carried_size: 0,
      },
    ],
    ...overrides,
  };
}

function receiverLine(
  tSeconds: number,
  overrides: Partial<ReceiverTimelineLine> = {},
): ReceiverTimelineLine {
  return {
    t_us: tSeconds * 1e6,
    rss_bytes: 40_000_000,
    texture_mem_bytes: 1_000_000,
    buffer_mem_bytes: 100_000,
    video_mem_bytes: 2_000_000,
    cache_entries_disk: 0,
    cache_bytes_disk: 0,
    cache_entries_memory: 10,
    cache_bytes_memory: 160_000,
    live_rids: { items: 50, textures: 8, meshes: 1, shaders: 1, materials: 2 },
    pipeline_compilations: null,
    ...overrides,
  };
}

/** 320 seconds of samples covering Q7e's whole [60, 360] window (and margin either side), at
 * 1 Hz, for a field that is `flat` or linearly `growing` only from the window's own first third
 * on (so an honest series' first third is never itself already elevated). */
function series<T>(
  make: (t: number, v: number) => T,
  shape: "flat" | "growing",
  flatValue: number,
  growthPerSecond: number,
): T[] {
  const out: T[] = [];
  for (let t = 0; t <= G6S_WINDOW_END_S + 20; t++) {
    const v =
      shape === "flat"
        ? flatValue
        : flatValue +
          Math.max(0, t - G6S_WINDOW_START_S) * growthPerSecond;
    out.push(make(t, v));
  }
  return out;
}

function evidenceFor(
  leg: G6sLeg,
  opts: {
    hostMetric?: "mirror_items" | "host_retained";
    hostShape?: "flat" | "growing";
    memShape?: "flat" | "growing";
    diskShape?: "flat" | "growing";
    rssHostShape?: "flat" | "growing";
    rssRecvShape?: "flat" | "growing";
    carriedShape?: "flat" | "normal" | "runaway";
    evictionsMemory?: number;
    evictionsDisk?: number;
  } = {},
): G6sLegEvidence {
  const hostMetric = opts.hostMetric ?? "mirror_items";
  const hostTimeline = series<HostTimelineLine>(
    (t, v) =>
      hostLine(t, {
        [hostMetric]: Math.round(v),
        rss_bytes: 80_000_000,
        connections: [
          {
            connection: 1,
            sent: Math.round(t * 60),
            credits: Math.round(t * 60),
            coalesced: 0,
            ticks_credit_blocked: 0,
            max_pending_age_us: 0,
            bytes_sent: 0,
            carried_size: 0, // overwritten below unless opts.carriedShape is "flat"
          },
        ],
      }),
    opts.hostShape ?? "flat",
    50,
    opts.hostShape === "growing" ? 1 : 0,
  );
  // "normal": 2/s (120/min), TEXA's own rate under `animate` -- the expected, passing baseline,
  // not a failure (render-stream-2.md's resource-duplicate rule means `carried` never shrinks).
  // "runaway": 10x that, as if every frame wrongly minted a new entry instead of a bounded,
  // repeating set (MS/SM/CM/PB) that stops contributing once each hash has been seen once.
  const carriedPerSecond =
    opts.carriedShape === "runaway" ? 20 : opts.carriedShape === "normal" ? 2 : 0;
  if (carriedPerSecond > 0) {
    for (const line of hostTimeline) {
      const t = line.t_us / 1e6;
      line.connections[0].carried_size = Math.round(
        Math.max(0, t - G6S_WINDOW_START_S) * carriedPerSecond,
      );
    }
  }
  const receiverTimeline = series<ReceiverTimelineLine>(
    (t, _v) =>
      receiverLine(t, {
        cache_bytes_memory:
          opts.memShape === "growing"
            ? 100_000 + Math.max(0, t - G6S_WINDOW_START_S) * 500
            : 100_000,
        cache_bytes_disk:
          opts.diskShape === "growing"
            ? 100_000 + Math.max(0, t - G6S_WINDOW_START_S) * 500
            : 100_000,
      }),
    "flat",
    0,
    0,
  );
  const hostProc: ProcSample[] = series<ProcSample>(
    (t, v) => ({
      tsMs: t * 1000,
      status: {
        pid: 1,
        vmRssBytes: Math.round(v),
        vmHwmBytes: Math.round(v),
        vmSizeBytes: Math.round(v) * 2,
        threads: 4,
      },
      threadCpu: [],
    }),
    opts.rssHostShape ?? "flat",
    80_000_000,
    opts.rssHostShape === "growing" ? (5 * 1024 * 1024) / 300 : 0,
  );
  const receiverProc: ProcSample[] = series<ProcSample>(
    (t, v) => ({
      tsMs: t * 1000,
      status: {
        pid: 2,
        vmRssBytes: Math.round(v),
        vmHwmBytes: Math.round(v),
        vmSizeBytes: Math.round(v) * 2,
        threads: 8,
      },
      threadCpu: [],
    }),
    opts.rssRecvShape ?? "flat",
    40_000_000,
    opts.rssRecvShape === "growing" ? (20 * 1024 * 1024) / 300 : 0,
  );
  return {
    leg: leg.leg,
    hostTimeline,
    hostProc,
    receiverPerf: { schema: "render-stream-receiver-perf/1", timeline: receiverTimeline },
    receiverProc,
    applied: {
      shots: [],
      resources_summary: {
        evictions_memory: opts.evictionsMemory ?? 1,
        evictions_disk: opts.evictionsDisk ?? 1,
        refetch_after_evict: 0,
      },
    },
    hostExitCode: 0,
    receiverExitCode: 0,
  };
}

export function selfTestG6s(hooks: SelfTestHooks): void {
  const { assert, fails } = hooks;

  // 1. Windowing math.
  {
    const raw = [
      { t: 1000, v: 1 },
      { t: 1010, v: 2 },
      { t: 1020, v: 3 },
    ];
    const rel = relativeSeries(raw);
    assert(
      "relativeSeries zeroes the first sample's time",
      rel[0].t === 0 && rel[1].t === 10 && rel[2].t === 20,
      JSON.stringify(rel),
    );
    const points = [
      { t: 65, v: 10 },
      { t: 90, v: 20 },
      { t: 300, v: 5 },
      { t: 350, v: 50 },
    ];
    assert(
      "maxInWindowThird first picks the window's first third",
      maxInWindowThird(points, "first") === 20,
    );
    assert(
      "maxInWindowThird last picks the window's last third",
      maxInWindowThird(points, "last") === 50,
    );
    const medianPoints = [
      { t: 60, v: 1 },
      { t: 70, v: 3 },
      { t: 80, v: 2 },
    ];
    assert(
      "medianInWindowEnd start",
      medianInWindowEnd(medianPoints, 30, "start") === 2,
    );
    const flatSlope = Array.from({ length: 10 }, (_, i) => ({
      t: 60 + i * 30,
      v: 100,
    }));
    assert(
      "slopePerMinute is 0 for a flat series",
      slopePerMinute(flatSlope) === 0,
    );
    const risingSlope = Array.from({ length: 11 }, (_, i) => ({
      t: 60 + i * 30,
      v: i * 1024 * 1024,
    }));
    const slope = slopePerMinute(risingSlope);
    assert(
      "slopePerMinute is positive for a rising series",
      slope !== null && slope > 0,
      String(slope),
    );
  }

  // 2. residencyMetrics / checkResidencyBounded.
  {
    const flat = evidenceFor(HONEST, { hostShape: "flat" });
    assert(
      "checkResidencyBounded passes when every metric is flat",
      checkResidencyBounded(HONEST, flat).passed,
    );

    // Real G6s evidence (2026-10-11): an honest soak-scene run's host_retained ticked from a
    // first-third max of 10 to a last-third max of 11 -- one transient pin during an ordinary
    // retire/re-add, not a leak -- and a zero-slack "last third > first third" comparison flagged
    // it anyway. G6S_RESIDENCY_GROWTH_SLACK exists to absorb exactly this.
    const transientBlip = evidenceFor(HONEST, { hostShape: "flat" });
    for (const line of transientBlip.hostTimeline) {
      const t = line.t_us / 1e6;
      if (t >= G6S_WINDOW_END_S - G6S_THIRD_S) line.host_retained = 11;
    }
    assert(
      "checkResidencyBounded tolerates a transient +1 blip (not a leak) via the growth slack",
      checkResidencyBounded(HONEST, transientBlip).passed,
      checkResidencyBounded(HONEST, transientBlip).detail,
    );

    const growingItems = evidenceFor(HONEST, {
      hostMetric: "mirror_items",
      hostShape: "growing",
    });
    const grown = checkResidencyBounded(HONEST, growingItems);
    assert(
      "checkResidencyBounded fails an honest leg whose mirror items grew",
      !grown.passed && grown.detail.includes("mirror items"),
      grown.detail,
    );
    // NO_EVICT's named metric is the receiver's memory-cache entry count, not anything host-side,
    // so this case leaves the host flat and grows only that receiver series. Once a metric has a
    // budget-derived bound (this one does), that bound is the only signal checked -- entries
    // climbing with bytes still flat is ordinary eviction noise (measured on a real honest run:
    // entries swung 113->120 within budget), so this must push `cache_bytes_memory` over budget,
    // not just `cache_entries_memory`, to actually trip the check the way a real no-evict leg does.
    const noEvictGrown = evidenceFor(NO_EVICT, { hostShape: "flat" });
    for (const line of noEvictGrown.receiverPerf?.timeline ?? []) {
      const t = line.t_us / 1e6;
      line.cache_entries_memory = Math.round(10 + Math.max(0, t - G6S_WINDOW_START_S) * 1);
      line.cache_bytes_memory =
        G6S_MEMORY_BUDGET_BYTES + 1 + Math.max(0, t - G6S_WINDOW_START_S) * 1000;
    }
    const noEvictCheck = checkResidencyBounded(NO_EVICT, noEvictGrown);
    assert(
      "checkResidencyBounded passes the no-evict sabotage when exactly its metric grew",
      noEvictCheck.passed,
      noEvictCheck.detail,
    );
    const noEvictWrong = evidenceFor(NO_EVICT, { hostShape: "flat" }); // nothing grew at all
    fails(
      "checkResidencyBounded on no-evict when nothing grew",
      checkResidencyBounded(NO_EVICT, noEvictWrong).passed
        ? []
        : ["expected"],
      "expected",
    );
    const retainGrown = evidenceFor(RETAIN, {
      hostMetric: "host_retained",
      hostShape: "growing",
    });
    assert(
      "checkResidencyBounded passes retain-superseded when host retained grew",
      checkResidencyBounded(RETAIN, retainGrown).passed,
      checkResidencyBounded(RETAIN, retainGrown).detail,
    );
    const retainAlsoItems = evidenceFor(RETAIN, {
      hostMetric: "host_retained",
      hostShape: "growing",
    });
    for (const line of retainAlsoItems.hostTimeline) {
      const t = line.t_us / 1e6;
      line.mirror_items = Math.round(50 + Math.max(0, t - G6S_WINDOW_START_S));
    }
    const retainCheck = checkResidencyBounded(RETAIN, retainAlsoItems);
    fails(
      "checkResidencyBounded on retain-superseded when a second metric also grew",
      retainCheck.passed ? [] : [retainCheck.detail],
      "unexpectedly",
    );

    // Real G6s evidence (2026-10-11): both sabotages' extra residency is already fully present by
    // the window's own first sample (the burst that produces it is fixture setup, steps 0-10,
    // finishing around game-time 15s -- well before the measured window starts at 60s) and stays
    // perfectly flat afterward, so first-third-max-vs-last-third-max alone never sees it. These
    // cases reproduce that shape and prove the budget-derived-bound half catches it anyway.
    const retainFlatElevated = evidenceFor(RETAIN, { hostShape: "flat" });
    for (const line of retainFlatElevated.hostTimeline) line.host_retained = 139;
    const retainFlatCheck = checkResidencyBounded(RETAIN, retainFlatElevated);
    assert(
      "checkResidencyBounded catches retain-superseded's plateau via the budget-derived bound",
      retainFlatCheck.passed,
      retainFlatCheck.detail,
    );
    const noEvictFlatElevated = evidenceFor(NO_EVICT, { hostShape: "flat" });
    for (const line of noEvictFlatElevated.receiverPerf?.timeline ?? [])
      line.cache_bytes_memory = 2_000_000; // past the 1 MiB budget plus one payload
    const noEvictFlatCheck = checkResidencyBounded(NO_EVICT, noEvictFlatElevated);
    assert(
      "checkResidencyBounded catches no-evict's plateau via the budget-derived bound",
      noEvictFlatCheck.passed,
      noEvictFlatCheck.detail,
    );
    const honestFlatElevated = evidenceFor(HONEST, { hostShape: "flat" });
    for (const line of honestFlatElevated.hostTimeline) line.host_retained = 139;
    const honestFlatCheck = checkResidencyBounded(HONEST, honestFlatElevated);
    fails(
      "checkResidencyBounded fails an honest leg whose host-retained plateau exceeds the bound",
      honestFlatCheck.passed ? [] : [honestFlatCheck.detail],
      "host retained payloads",
    );
  }

  // 3. checkCacheBudgetRespected.
  {
    const ok = evidenceFor(HONEST, { memShape: "flat", diskShape: "flat" });
    assert(
      "checkCacheBudgetRespected passes within budget with evictions",
      checkCacheBudgetRespected(HONEST, ok).passed,
      checkCacheBudgetRespected(HONEST, ok).detail,
    );
    const neverEvicted = evidenceFor(HONEST, { evictionsMemory: 0 });
    fails(
      "checkCacheBudgetRespected fails when the budget was never exercised",
      checkCacheBudgetRespected(HONEST, neverEvicted).passed ? [] : ["never exercised"],
      "never exercised",
    );
    const overBudget = evidenceFor(HONEST, {});
    for (const line of overBudget.receiverPerf?.timeline ?? [])
      line.cache_bytes_memory = G6S_MEMORY_BUDGET_BYTES * 3;
    fails(
      "checkCacheBudgetRespected fails when memory bytes exceed the budget",
      checkCacheBudgetRespected(HONEST, overBudget).passed ? [] : ["exceeded"],
      "exceeded",
    );
    const overDisk = evidenceFor(HONEST, {});
    for (const line of overDisk.receiverPerf?.timeline ?? [])
      line.cache_bytes_disk = G6S_CACHE_BUDGET_BYTES * 3;
    fails(
      "checkCacheBudgetRespected fails when disk bytes exceed the budget",
      checkCacheBudgetRespected(HONEST, overDisk).passed ? [] : ["exceeded"],
      "exceeded",
    );
    const noEvictOk = evidenceFor(NO_EVICT, { evictionsMemory: 0 });
    assert(
      "checkCacheBudgetRespected passes no-evict when it truly never evicted",
      checkCacheBudgetRespected(NO_EVICT, noEvictOk).passed,
      checkCacheBudgetRespected(NO_EVICT, noEvictOk).detail,
    );
    const noEvictBroken = evidenceFor(NO_EVICT, { evictionsMemory: 3 });
    fails(
      "checkCacheBudgetRespected fails no-evict if it evicted anyway",
      checkCacheBudgetRespected(NO_EVICT, noEvictBroken).passed ? [] : ["should be 0"],
      "should be 0",
    );
    const inlineOk = evidenceFor(INLINE, { evictionsMemory: 0, evictionsDisk: 0 });
    assert(
      "checkCacheBudgetRespected passes soak-inline when it never evicted",
      checkCacheBudgetRespected(INLINE, inlineOk).passed,
      checkCacheBudgetRespected(INLINE, inlineOk).detail,
    );
    const inlineBroken = evidenceFor(INLINE, { evictionsMemory: 2 });
    fails(
      "checkCacheBudgetRespected fails soak-inline if it evicted (no fallback source)",
      checkCacheBudgetRespected(INLINE, inlineBroken).passed ? [] : ["unrecoverable"],
      "unrecoverable",
    );
  }

  // 4. checkRssBounded.
  {
    const flat = evidenceFor(HONEST, {});
    assert(
      "checkRssBounded passes flat host and receiver RSS",
      checkRssBounded(HONEST, flat).passed,
      checkRssBounded(HONEST, flat).detail,
    );
    const hostRising = evidenceFor(HONEST, { rssHostShape: "growing" });
    fails(
      "checkRssBounded fails when host RSS rises past budget",
      checkRssBounded(HONEST, hostRising).passed ? [] : ["host RSS"],
      "host RSS",
    );
    const recvRising = evidenceFor(HONEST, { rssRecvShape: "growing" });
    fails(
      "checkRssBounded fails when receiver RSS rises past budget",
      checkRssBounded(HONEST, recvRising).passed ? [] : ["receiver RSS"],
      "receiver RSS",
    );
    const noProc = evidenceFor(HONEST, {});
    noProc.hostProc = [];
    noProc.receiverProc = [];
    assert(
      "checkRssBounded falls back to the engines' own rss_bytes with no /proc samples",
      checkRssBounded(HONEST, noProc).passed,
      checkRssBounded(HONEST, noProc).detail,
    );
  }

  // 5. checkCarriedGrowthBounded.
  {
    const flat = evidenceFor(HONEST, { carriedShape: "flat" });
    assert(
      "checkCarriedGrowthBounded passes a flat carried_size",
      checkCarriedGrowthBounded(flat).passed,
      checkCarriedGrowthBounded(flat).detail,
    );
    const normal = evidenceFor(HONEST, { carriedShape: "normal" });
    assert(
      "checkCarriedGrowthBounded passes growth at TEXA's own rate (~120/min)",
      checkCarriedGrowthBounded(normal).passed,
      checkCarriedGrowthBounded(normal).detail,
    );
    const runaway = evidenceFor(HONEST, { carriedShape: "runaway" });
    fails(
      "checkCarriedGrowthBounded fails runaway growth",
      checkCarriedGrowthBounded(runaway).passed ? [] : ["more than"],
      "more than",
    );
  }
}
