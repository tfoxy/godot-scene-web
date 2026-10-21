// Self-test for gate 6 group g6c (lib/gate6c-checks.ts), driven from self-test-gate6.ts's main:
// every pure evaluator with a passing and a failing case, on synthetic values.
//
//  1. histPercentile (in-bucket interpolation, clamped to min/max) and bucketWidth.
//  2. hostWindow and connectionRates over a fabricated 60 fps perf-timeline.jsonl; a window the
//     timeline does not cover is refused.
//  3. receiverFrameRate: the host window moved onto the receiver's clock by the transactions'
//     median offset.
//  4. evaluateRateAchieved, evaluatePublishedVsHost, evaluateMismatch60Recv30,
//     evaluateHostUnperturbed, evaluateDual and limitedBy/evaluateLimitedBy, each against the
//     window's credit capacity (a phase-locked 60/60 leg at 30 passes; a host that sat on
//     credits, or published above its target, fails).
//  5. separationClass (gpu-limited, injected-delay, neither) and evaluateSeparation.
//  6. evaluateCreditRtt, evaluatePendingBounded, evaluateQueueBounded and legClass (a sabotage that
//     sent without credit is delivery-violation, a failed receiver replay-failure).

import {
  bucketWidth,
  type ConnRates,
  connectionRates,
  evaluateCreditRtt,
  evaluateDual,
  evaluateHostUnperturbed,
  evaluateLimitedBy,
  evaluateMismatch60Recv30,
  evaluatePendingBounded,
  evaluatePublishedVsHost,
  evaluateQueueBounded,
  evaluateRateAchieved,
  evaluateSeparation,
  G6C_LEGS,
  type G6cLegEvidence,
  type G6cMeasure,
  histPercentile,
  hostWindow,
  legClass,
  limitedBy,
  type ReceiverEvidence,
  receiverFrameRate,
  type StepEntry,
  separationClass,
  type TimelineLine,
} from "../lib/gate6c-checks";
import type { SelfTestHooks } from "./self-test-gate6l";

/** A 60 fps host timeline from second 0 to `seconds`, one connection publishing `pubPerS`. */
function timeline(
  seconds: number,
  pubPerS: number,
  opts: { blocked?: number; rttFrames?: number; rttUs?: number } = {},
): TimelineLine[] {
  const out: TimelineLine[] = [];
  for (let s = 0; s <= seconds; s++) {
    const sent = Math.round(s * pubPerS);
    out.push({
      t_us: 1_000_000_000 + s * 1_000_000,
      frame: 1 + s * 60,
      connections: [
        {
          connection: 1,
          sent,
          credits: sent,
          coalesced: 0,
          ticks_credit_blocked: (opts.blocked ?? 0) * s,
          max_pending_age_us: 0,
          bytes_sent: sent * 20_000,
          acks: [sent, sent, sent],
          max_in_flight: 1,
          max_queued_bytes: 20_000,
          credit_rtt_count: sent,
          credit_rtt_sum_us: sent * (opts.rttUs ?? 14_000),
          credit_rtt_frames_sum: sent * (opts.rttFrames ?? 1),
        },
      ],
    });
  }
  return out;
}

const steps: StepEntry[] = [
  { step: 0, applied_frame: 1, settle_frame: 8 },
  { step: 1, applied_frame: 361, settle_frame: 368 },
  { step: 11, applied_frame: 1681, settle_frame: 1688 },
];

function receiver(
  fps: number,
  seconds: number,
  offsetUs: number,
  hostTimeline: TimelineLine[],
): ReceiverEvidence {
  return {
    dir: "/x/receiver",
    max_fps: fps,
    exit: 0,
    applied: {
      status: "ok",
      unsupported: [],
      streams: [{ stream_id: "s1" }],
      transactions: hostTimeline.map((l, i) => ({
        seq: i + 1,
        frame: l.frame,
        received_us: l.t_us + offsetUs + 3000,
        applied_us: l.t_us + offsetUs + 5000,
        submitted_us: l.t_us + offsetUs + 9000,
      })),
    },
    perf: {
      histograms: {},
      timeline: Array.from({ length: seconds + 1 }, (_, s) => ({
        t_us: 1_000_000_000 + offsetUs + s * 1_000_000,
        frames: s * fps,
      })),
    },
    samples: [],
    record_bytes: [],
  };
}

function measure(
  tl: TimelineLine[],
  recvFps: number[],
  extra: Partial<G6cMeasure> = {},
): G6cMeasure {
  const w = hostWindow(steps, tl);
  const window = typeof w === "string" ? null : w;
  return {
    leg: "x",
    window,
    window_problem: typeof w === "string" ? w : null,
    host_frame: window
      ? (window.last.frame - window.first.frame) / window.seconds
      : null,
    conns: window ? connectionRates(window) : [],
    receivers: recvFps.map((f, i) => ({
      dir: `receiver-${i}`,
      max_fps: 60,
      connection: 1 + i,
      receiver_frame: f,
      frame_interval_p50_us: 16_667,
      gpu_render_p50_us: 400,
      cpu_render_p50_us: 350,
      hold_p50_us: 9000,
      hold_p95_us: 20_000,
    })),
    frame_interval_p95_us: 16_900,
    callback_p50_us: 300,
    snapshot_count: 1800,
    callback_count: 1800,
    ...extra,
  };
}

export function selfTestGate6c(h: SelfTestHooks): void {
  const { assert, passes, fails } = h;

  // 1. Histograms.
  {
    assert(
      "g6c bucketWidth: 16384 has 1024-wide buckets",
      bucketWidth(16384) === 1024,
    );
    const hist = {
      count: 4,
      min: 16500,
      max: 17500,
      buckets: [
        [16384, 2],
        [17408, 2],
      ] as [number, number][],
    };
    const p50 = histPercentile(hist, 50) ?? 0;
    assert(
      "g6c histPercentile: p50 at the first bucket's top",
      Math.abs(p50 - 17408) < 1e-6,
      String(p50),
    );
    assert(
      "g6c histPercentile: p100 clamped to the exact max",
      histPercentile(hist, 100) === 17500,
    );
    assert(
      "g6c histPercentile: p0 clamped to the exact min",
      histPercentile(hist, 0) === 16500,
    );
    assert(
      "g6c histPercentile: an empty histogram is null",
      histPercentile({ buckets: [] }, 50) === null,
    );
  }

  // 2. The window and the host rates.
  const tl60 = timeline(32, 60);
  {
    const w = hostWindow(steps, tl60);
    assert(
      "g6c hostWindow: placed from step 1 (frame 361 = 6 s)",
      typeof w !== "string" &&
        w.first.t_us === 1_006_000_000 &&
        w.last.t_us === 1_026_000_000,
      JSON.stringify(w).slice(0, 200),
    );
    const rates = typeof w === "string" ? [] : connectionRates(w);
    assert(
      "g6c connectionRates: 60 published, 60 applied",
      rates.length === 1 &&
        Math.abs(rates[0].published - 60) < 1e-9 &&
        Math.abs((rates[0].applied ?? 0) - 60) < 1e-9,
    );
    const short = hostWindow(steps, timeline(10, 60));
    assert(
      "g6c hostWindow: a timeline that ends inside the window is refused",
      typeof short === "string",
      String(short),
    );
    assert(
      "g6c hostWindow: no step 1 is refused",
      typeof hostWindow([], tl60) === "string",
    );
  }

  // 3. The receiver frame rate on its own clock.
  {
    const w = hostWindow(steps, tl60);
    const r = receiver(60, 40, -999_000_000, tl60);
    const rate = typeof w === "string" ? null : receiverFrameRate(r, w, tl60);
    assert(
      "g6c receiverFrameRate: 60 frames per second on the moved window",
      rate !== null && Math.abs(rate - 60) < 0.01,
      String(rate),
    );
    const r30 = receiver(30, 40, 5_000_000, tl60);
    const rate30 =
      typeof w === "string" ? null : receiverFrameRate(r30, w, tl60);
    assert(
      "g6c receiverFrameRate: 30 at 30",
      rate30 !== null && Math.abs(rate30 - 30) < 0.01,
      String(rate30),
    );
  }

  // 4. Rates (as built: the lower bound is 0.95 x min(nominal, credit capacity)).
  {
    passes(
      "g6c evaluateRateAchieved at 60 (one-frame credit RTT)",
      evaluateRateAchieved(measure(tl60, [60]), 60, { appliedChecks: true }),
    );
    passes(
      "g6c evaluateRateAchieved at 60 phase-locked (two-frame RTT: capacity 30, published 30)",
      evaluateRateAchieved(
        measure(timeline(32, 30, { rttFrames: 2 }), [60]),
        60,
        {
          appliedChecks: true,
        },
      ),
    );
    fails(
      "g6c evaluateRateAchieved: 55 published at 60 with a one-frame RTT (a host sitting on credits)",
      evaluateRateAchieved(measure(timeline(32, 55), [60]), 60, {
        appliedChecks: true,
      }),
      "published",
    );
    fails(
      "g6c evaluateRateAchieved: 64 published at 60 (a burst)",
      evaluateRateAchieved(measure(timeline(32, 64), [60]), 60, {
        appliedChecks: true,
      }),
      "published",
    );
    fails(
      "g6c evaluateRateAchieved: receiver at 50",
      evaluateRateAchieved(measure(tl60, [50]), 60, { appliedChecks: true }),
      "receiver frame",
    );
    const lagging = timeline(32, 30, { rttFrames: 2 });
    for (const l of lagging) {
      const c = l.connections[0];
      if (c.acks)
        c.acks = [c.sent, Math.round(c.sent * 0.9), Math.round(c.sent * 0.9)];
    }
    fails(
      "g6c evaluateRateAchieved: applied 10 % short",
      evaluateRateAchieved(measure(lagging, [60]), 30, { appliedChecks: true }),
      "applied",
    );
    passes(
      "g6c evaluatePublishedVsHost at 60/60",
      evaluatePublishedVsHost(measure(tl60, [60])),
    );
    passes(
      "g6c evaluatePublishedVsHost at 60/60 phase-locked at 30",
      evaluatePublishedVsHost(
        measure(timeline(32, 30, { rttFrames: 2 }), [60]),
      ),
    );
    fails(
      "g6c evaluatePublishedVsHost: 50 published with a one-frame RTT",
      evaluatePublishedVsHost(measure(timeline(32, 50), [60])),
      "published",
    );
    passes(
      "g6c evaluateMismatch60Recv30",
      evaluateMismatch60Recv30(
        measure(timeline(32, 30, { blocked: 30, rttFrames: 2 }), [30]),
      ),
    );
    fails(
      "g6c evaluateMismatch60Recv30: no blocked tick",
      evaluateMismatch60Recv30(
        measure(timeline(32, 30, { rttFrames: 2 }), [30]),
      ),
      "credit-blocked",
    );
    fails(
      "g6c evaluateMismatch60Recv30: published 45 at a 30 fps receiver",
      evaluateMismatch60Recv30(
        measure(timeline(32, 45, { blocked: 1, rttFrames: 1 }), [30]),
      ),
      "published",
    );
    fails(
      "g6c evaluateMismatch60Recv30: 20 published while credit allowed 30",
      evaluateMismatch60Recv30(
        measure(timeline(32, 20, { blocked: 1, rttFrames: 2 }), [30]),
      ),
      "published",
    );
    const base = measure(tl60, []);
    passes(
      "g6c evaluateHostUnperturbed (same as baseline)",
      evaluateHostUnperturbed(measure(tl60, [60]), base),
    );
    fails(
      "g6c evaluateHostUnperturbed: p95 7 % worse",
      evaluateHostUnperturbed(
        measure(tl60, [60], { frame_interval_p95_us: 18_100 }),
        base,
      ),
      "p95",
    );
    fails(
      "g6c evaluateHostUnperturbed: no baseline",
      evaluateHostUnperturbed(measure(tl60, [60]), undefined),
      "baseline",
    );

    // dual: two connections, A at 60 (one-frame RTT) and B at 15 (four-frame RTT).
    const dual = timeline(32, 60);
    for (const [s, l] of dual.entries())
      l.connections.push({
        ...l.connections[0],
        connection: 2,
        sent: s * 15,
        credits: s * 15,
        acks: [s * 15, s * 15, s * 15],
        credit_rtt_count: s * 15,
        credit_rtt_sum_us: s * 15 * 60_000,
        credit_rtt_frames_sum: s * 15 * 4,
      });
    const dm = measure(dual, [60, 15]);
    passes("g6c evaluateDual", evaluateDual(dm, 20_000));
    fails(
      "g6c evaluateDual: A's receiver hold p95 20 % above the single-receiver leg's",
      evaluateDual(dm, 16_000),
      "hold",
    );
    fails(
      "g6c evaluateDual: two snapshots per frame",
      evaluateDual({ ...dm, snapshot_count: 3600 }, 20_000),
      "snapshot",
    );
    fails(
      "g6c evaluateDual: B published above its frame rate",
      evaluateDual(measure(dual, [60, 10]), 20_000),
      "B published",
    );
    const slowA = timeline(32, 40);
    for (const [s, l] of slowA.entries())
      l.connections.push({
        ...dual[s].connections[1],
      });
    fails(
      "g6c evaluateDual: A at 40 with a one-frame RTT (the host sat on A's credits)",
      evaluateDual(measure(slowA, [60, 15]), 20_000),
      "A published",
    );

    // limited_by: a host at 1000 fps whose credits take 4 host frames (250 per second).
    const fast: TimelineLine[] = timeline(32, 250, {
      rttFrames: 4,
      rttUs: 4000,
    }).map((l, s) => ({ ...l, frame: 1 + s * 1000 }));
    const steps1000 = [{ step: 1, applied_frame: 6001, settle_frame: 6008 }];
    const w = hostWindow(steps1000, fast);
    const fm: G6cMeasure = {
      ...measure(fast, [900]),
      window: typeof w === "string" ? null : w,
      host_frame: 1000,
      conns: typeof w === "string" ? [] : connectionRates(w),
    };
    const credit = limitedBy(fm);
    assert(
      "g6c limitedBy: credit-bound when published ~ credit capacity and the receiver holds most of the RTT",
      credit.limited_by === "credit" &&
        Math.abs((credit.credit_capacity ?? 0) - 250) < 1e-9,
      JSON.stringify(credit),
    );
    passes("g6c evaluateLimitedBy (credit)", evaluateLimitedBy(fm, credit));
    const transport = limitedBy(fm, 0, 3000);
    assert(
      "g6c limitedBy: transport when the link's own round trip is most of the credit RTT",
      transport.limited_by === "transport",
      JSON.stringify(transport),
    );
    const host = limitedBy({ ...fm, host_frame: 250 });
    assert(
      "g6c limitedBy: host-frame when published ~ host frame rate",
      host.limited_by === "host-frame",
    );
    const lazy: TimelineLine[] = timeline(32, 150, {
      rttFrames: 4,
      rttUs: 4000,
    }).map((l, s) => ({ ...l, frame: 1 + s * 1000 }));
    const wl = hostWindow(steps1000, lazy);
    const lm: G6cMeasure = {
      ...fm,
      window: typeof wl === "string" ? null : wl,
      conns: typeof wl === "string" ? [] : connectionRates(wl),
    };
    fails(
      "g6c evaluateLimitedBy: 150 published while credit allowed 250",
      evaluateLimitedBy(lm, limitedBy(lm)),
      "published",
    );
  }

  // 5. Separation.
  {
    assert(
      "g6c separationClass: GPU 38 ms of a 40 ms frame is gpu-limited",
      separationClass(40_000, 38_000) === "gpu-limited",
    );
    assert(
      "g6c separationClass: 49 ms frames with a 0.4 ms GPU are injected-delay",
      separationClass(49_000, 400) === "injected-delay",
    );
    assert(
      "g6c separationClass: 16.7 ms frames with a 0.4 ms GPU are neither",
      separationClass(16_700, 400) === "neither",
    );
    const m = measure(tl60, [60]);
    const delayed = {
      ...m,
      receivers: [
        {
          ...m.receivers[0],
          frame_interval_p50_us: 49_000,
          gpu_render_p50_us: 400,
        },
      ],
    };
    passes(
      "g6c evaluateSeparation injected-delay",
      evaluateSeparation(delayed, "injected-delay"),
    );
    fails(
      "g6c evaluateSeparation: an injected delay is not gpu-limited",
      evaluateSeparation(delayed, "gpu-limited"),
      "injected-delay",
    );
  }

  // 6. Transport and classes.
  {
    passes(
      "g6c evaluateCreditRtt at 157 ms",
      evaluateCreditRtt({ credit_rtt_us: { median: 157_000 } }),
    );
    fails(
      "g6c evaluateCreditRtt at 12 ms",
      evaluateCreditRtt({ credit_rtt_us: { median: 12_000 } }),
      "60000",
    );
    const honest = {
      max_pending: 1,
      max_in_flight: 1,
      max_queued_bytes: 94_802,
      max_message_sent: 94_792,
    };
    passes("g6c evaluatePendingBounded", evaluatePendingBounded(honest));
    passes("g6c evaluateQueueBounded", evaluateQueueBounded(honest));
    const flooded = {
      max_pending: 1,
      max_in_flight: 300,
      max_queued_bytes: 5_000_000,
      max_message_sent: 94_792,
    };
    fails(
      "g6c evaluatePendingBounded: 300 in flight",
      evaluatePendingBounded(flooded),
      "max_in_flight",
    );
    fails(
      "g6c evaluateQueueBounded: 5 MB queued",
      evaluateQueueBounded(flooded),
      "65536",
    );
    fails(
      "g6c evaluatePendingBounded: a 40 KiB queue over one message",
      evaluatePendingBounded({ ...honest, max_queued_bytes: 94_792 + 40_960 }),
      "max_queued_bytes",
    );
    // G7q: generalized to the connection's granted credit window w.
    const window2 = {
      ...honest,
      credit_window: 2,
      max_in_flight: 2,
      max_queued_bytes: 2 * 94_792,
    };
    passes(
      "g7q evaluatePendingBounded: window 2, two in flight, two queued",
      evaluatePendingBounded(window2),
    );
    passes(
      "g7q evaluateQueueBounded: window 2, two largest messages queued",
      evaluateQueueBounded(window2),
    );
    fails(
      "g7q evaluatePendingBounded: window 2, a third in flight",
      evaluatePendingBounded({ ...window2, max_in_flight: 3 }),
      "window 2",
    );
    fails(
      "g7q evaluatePendingBounded: window 1, two in flight",
      evaluatePendingBounded({ ...window2, credit_window: 1 }),
      "max_in_flight 2",
    );
    fails(
      "g7q evaluateQueueBounded: window 2, the overrun's queue",
      evaluateQueueBounded({ ...window2, max_queued_bytes: 594_924 }),
      "2 x largest",
    );

    const def = G6C_LEGS.find((l) => l.kind === "sabotage");
    const ev = (over: Partial<G6cLegEvidence>): G6cLegEvidence => ({
      def: def ?? G6C_LEGS[0],
      dir: "/x",
      present: true,
      host_exit: 0,
      steps,
      timeline: [],
      perf: undefined,
      summary: {
        connections: [
          { connection: 1, sent_without_credit: 0, max_in_flight: 1 },
        ],
      },
      samples: [],
      receivers: [receiver(60, 1, 0, [])],
      proxy: undefined,
      reference_shot: "/x/ref.png",
      ...over,
    });
    assert("g6c legClass: success", legClass(ev({})).cls === "success");
    assert(
      "g6c legClass: sends without credit are delivery-violation",
      legClass(
        ev({
          summary: {
            connections: [
              { connection: 1, sent_without_credit: 40, max_in_flight: 30 },
            ],
          },
        }),
      ).cls === "delivery-violation",
    );
    const failed = receiver(60, 1, 0, []);
    failed.applied = {
      ...failed.applied,
      status: "replay-failure",
      failure: { reason: "resource-unavailable" },
    };
    assert(
      "g6c legClass: a failed receiver is replay-failure",
      legClass(ev({ receivers: [failed] })).cls === "replay-failure",
    );
    assert(
      "g6c legClass: a leg that did not run",
      legClass(ev({ present: false })).cls === "not-run",
    );
    const c: ConnRates | undefined = undefined;
    assert(
      "g6c G6C_LEGS: thirteen legs, one sabotage",
      G6C_LEGS.length === 13 &&
        G6C_LEGS.filter((l) => l.kind === "sabotage").length === 1 &&
        c === undefined,
    );
  }
}
