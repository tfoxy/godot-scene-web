// Self-test for gate 6 group g6l (lib/gate6l-checks.ts), driven from self-test-gate6.ts's main:
// every pure evaluator with a passing and a failing case, on synthetic values and the committed
// fixtures/gate6-scene/expected.json.
//
//  1. g6lWindows, liveStepAt and regionsAtFrame: twelve settle windows and forty disjoint motion
//     windows; the step in force and its regions at a live frame (moved at step 10).
//  2. evaluateMotionMonotonic: gaps of 1 and 2 pass; a gap of 3 passes only after the stalled
//     seq, across the reconnect, or when the receiver held the earlier transaction longer than a
//     frame (fetch, shot, frame); a gap of 3 behind a fast receiver and a frame going backwards fail.
//  3. creditToSend: sends at the first callback after the credit pass; a late send and a send
//     before the credit fail.
//  4. windowsWithoutCandidate: a window whose only transaction was shot for an earlier-listed
//     window is legitimately missed; a window with an unshot transaction is not.
//  5. evaluateFetchLatestOnly, evaluateReconnectFetches, evaluateWarmFetches and staleFreshRegions.
//  6. wireSends, compareAt (HU never compared) and gate 5f's connTimelinesAtCallback as g6l uses it.

import type { LiveLogLine } from "../lib/gate1-live-checks";
import type { G2cHost } from "../lib/gate2c-checks";
import { connTimelinesAtCallback } from "../lib/gate5f-checks";
import type { Gate6Expected } from "../lib/gate6-expected";
import type { Frame6 } from "../lib/gate6a-checks";
import {
  type AppliedTx,
  compareAt,
  creditToSend,
  evaluateFetchLatestOnly,
  evaluateMotionMonotonic,
  evaluateReconnectFetches,
  evaluateWarmFetches,
  G6L_FRAME_US,
  G6L_MOTION_LABEL,
  type G6lApplied,
  g6lWindows,
  liveStepAt,
  regionsAtFrame,
  staleFreshRegions,
  windowsWithoutCandidate,
  wireSends,
} from "../lib/gate6l-checks";

export interface SelfTestHooks {
  assert: (name: string, ok: boolean, detail?: string) => void;
  passes: (name: string, problems: string[]) => void;
  fails: (name: string, problems: string[], needle?: string) => void;
}

function frame(w: number, h: number, fill: number[]): Frame6 {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(fill, i * 4);
  return { width: w, height: h, rgba };
}

function tx(
  frames: number[],
  opts: { stream?: number; slow?: number[]; fetched?: number[] } = {},
): AppliedTx[] {
  return frames.map((f, i) => ({
    stream: opts.stream ?? 1,
    seq: i + 1,
    frame: f,
    fetched: opts.fetched?.includes(i + 1) ? 1 : 0,
    receive_to_submit_us: opts.slow?.includes(i + 1)
      ? G6L_FRAME_US + 5000
      : 6000,
  }));
}

function frameLine(f: number, sent?: number, staleFrom?: number): LiveLogLine {
  return {
    frame: f,
    t_us: f * 16667,
    state: "streaming",
    sent:
      sent === undefined
        ? null
        : {
            seq: sent,
            encoding: "patch",
            bytes: 100,
            ...(staleFrom !== undefined ? { stale_from: staleFrom } : {}),
          },
  };
}
function ack(f: number, seq: number): LiveLogLine {
  return {
    frame: f,
    t_us: f * 16667 + 1,
    event: "ack",
    seq,
    stage: "submitted",
    credited: true,
  };
}

export function selfTestG6l(e: Gate6Expected, h: SelfTestHooks): void {
  const { assert, passes, fails } = h;

  // 1. Windows and the timeline.
  {
    const w = g6lWindows();
    const settle = w.filter((x) => x.step < G6L_MOTION_LABEL);
    const motion = w.filter((x) => x.step >= G6L_MOTION_LABEL);
    assert(
      "g6l windows: 12 settle (step k from 307 + 60k), 40 motion of 10 frames in 320..1060",
      settle.length === 12 &&
        settle.every((x) => x.from === 307 + 60 * x.step) &&
        settle[11].to === 1080 &&
        motion.length === 40 &&
        motion[0].from === 320 &&
        motion[39].to <= 1060 &&
        motion.every((x) => x.to - x.from === 9),
      JSON.stringify(w.slice(0, 3)),
    );
    assert(
      "g6l motion windows are pairwise disjoint and labels unique",
      motion.every((x, i) => i === 0 || x.from > motion[i - 1].to) &&
        new Set(w.map((x) => x.step)).size === w.length,
    );
    assert(
      "liveStepAt: 359 -> 0, 360 -> 1, 899 -> 9, 900 -> 10, 1080 -> 11",
      liveStepAt(359) === 0 &&
        liveStepAt(360) === 1 &&
        liveStepAt(899) === 9 &&
        liveStepAt(900) === 10 &&
        liveStepAt(1080) === 11,
    );
    const r9 = regionsAtFrame(e, 899);
    const r10 = regionsAtFrame(e, 900);
    assert(
      "regionsAtFrame: MS moves by (8, 4) at step 10's frame 900",
      r10.MS[0] === r9.MS[0] + 8 && r10.MS[1] === r9.MS[1] + 4,
      `${JSON.stringify(r9.MS)} -> ${JSON.stringify(r10.MS)}`,
    );
  }

  // 2. motion-monotonic.
  {
    const noShots = new Set<string>();
    passes(
      "motion: gaps of 1 and 2",
      evaluateMotionMonotonic(
        tx([320, 321, 323, 324, 326]),
        noShots,
        null,
        320,
        1080,
      ).problems,
    );
    fails(
      "motion: a gap of 3 behind a receiver faster than a frame",
      evaluateMotionMonotonic(tx([320, 321, 324]), noShots, null, 320, 1080)
        .problems,
      "gap 3",
    );
    const slowShot = evaluateMotionMonotonic(
      tx([320, 321, 324], { slow: [2] }),
      new Set(["1:2"]),
      null,
      320,
      1080,
    );
    passes("motion: a gap of 3 after a slow shot", slowShot.problems);
    assert(
      "motion: the slow shot is attributed receiver-shot",
      slowShot.attributed["receiver-shot"] === 1,
    );
    const slowFetch = evaluateMotionMonotonic(
      tx([320, 321, 325], { slow: [2], fetched: [2] }),
      noShots,
      null,
      320,
      1080,
    );
    assert(
      "motion: a gap of 4 after a slow fetch is attributed receiver-fetch",
      slowFetch.problems.length === 0 &&
        slowFetch.attributed["receiver-fetch"] === 1,
    );
    const stall = evaluateMotionMonotonic(
      tx([426, 427, 550]),
      noShots,
      2,
      320,
      1080,
    );
    assert(
      "motion: the stalled seq's 123-frame gap is attributed stall",
      stall.problems.length === 0 && stall.attributed.stall === 1,
    );
    const reconnect = evaluateMotionMonotonic(
      [...tx([606, 607]), ...tx([612, 614], { stream: 2 })],
      noShots,
      null,
      320,
      1080,
    );
    assert(
      "motion: connection 1 -> 2 is attributed reconnect",
      reconnect.problems.length === 0 && reconnect.attributed.reconnect === 1,
    );
    fails(
      "motion: a frame going backwards",
      evaluateMotionMonotonic(tx([320, 322, 321]), noShots, null, 320, 1080)
        .problems,
      "after frame",
    );
  }

  // 3. creditToSend.
  {
    const good = [
      frameLine(41, 1),
      ack(42, 1),
      frameLine(42, 2),
      ack(43, 2),
      frameLine(43, 3),
    ];
    const r = creditToSend(good);
    passes(
      "credit-to-send: each send at the first callback after the credit",
      r.problems,
    );
    assert(
      "credit-to-send: two sends at +0",
      r.delays["0"] === 2,
      JSON.stringify(r.delays),
    );
    fails(
      "credit-to-send: a send one callback after the credit",
      creditToSend([
        frameLine(41, 1),
        ack(42, 1),
        frameLine(42),
        frameLine(43, 2),
      ]).problems,
      "callbacks after",
    );
    fails(
      "credit-to-send: a send before the credit",
      creditToSend([frameLine(41, 1), frameLine(42, 2)]).problems,
      "before seq 1 was credited",
    );
  }

  // 4. windowsWithoutCandidate.
  {
    const windows = [
      { step: 4, from: 547, to: 599 },
      { step: 112, from: 542, to: 551 },
      { step: 113, from: 560, to: 569 },
    ];
    const t = tx([427, 550, 562]);
    const missed = windowsWithoutCandidate(
      t,
      new Map([
        ["1:2", 4],
        ["1:3", 113],
      ]),
      windows,
    );
    assert(
      "missed windows: 112's only transaction was shot for window 4",
      JSON.stringify(missed) === "[112]",
      JSON.stringify(missed),
    );
    const notMissed = windowsWithoutCandidate(
      tx([427, 550, 551, 562]),
      new Map([
        ["1:2", 4],
        ["1:4", 113],
      ]),
      windows,
    );
    assert(
      "missed windows: an unshot transaction in 112 makes it shootable",
      JSON.stringify(notMissed) === "[]",
      JSON.stringify(notMissed),
    );
  }

  // 5. Resources and the stale region set.
  {
    const versions: [number, string][] = [
      [1, "a0"],
      [450, "a17"],
      [480, "a1"],
      [480, "a18"],
      [510, "a19"],
      [540, "a20"],
      [570, "a21"],
    ];
    const rec = { seq: 181, frame: 550 };
    passes(
      "fetch-latest-only: only the version current at the recovery frame, for the recovery seq",
      evaluateFetchLatestOnly(
        versions,
        [{ seq: 181, hash: "a20", source: "http" }],
        427,
        550,
        rec,
      ).problems,
    );
    fails(
      "fetch-latest-only: two in-stall versions fetched",
      evaluateFetchLatestOnly(
        versions,
        [
          { seq: 181, hash: "a19", source: "http" },
          { seq: 181, hash: "a20", source: "http" },
        ],
        427,
        550,
        rec,
      ).problems,
      "expected exactly one",
    );
    fails(
      "fetch-latest-only: a stale version fetched",
      evaluateFetchLatestOnly(
        versions,
        [{ seq: 181, hash: "a18", source: "http" }],
        427,
        550,
        rec,
      ).problems,
      "not the one current",
    );
    fails(
      "fetch-latest-only: no version inside the stall",
      evaluateFetchLatestOnly([[1, "a0"]], [], 427, 550, rec).problems,
      "no TEXA version",
    );

    const applied = (
      over: Partial<NonNullable<NonNullable<G6lApplied["live"]>["reconnect"]>>,
      f2: string[],
      hits2 = 0,
    ): G6lApplied => ({
      fetches: [
        { stream: 1, seq: 1, hash: "h1", source: "http" },
        ...f2.map((h) => ({ stream: 2, seq: 3, hash: h, source: "http" })),
      ],
      transactions: [
        {
          stream: 2,
          seq: 1,
          frame: 612,
          applied_us: 1,
          resources: { fetched: 0, cache_hits: hits2 },
        },
      ],
      live: {
        reconnect: {
          memory: "keep",
          memory_hashes: ["h0", "h1"],
          cache_hashes: ["h1"],
          ...over,
        },
      },
    });
    passes(
      "reconnect fetches: only payloads held nowhere",
      evaluateReconnectFetches(applied({}, ["h9"])).problems,
    );
    fails(
      "reconnect fetches: a payload held in memory fetched again",
      evaluateReconnectFetches(applied({}, ["h0"])).problems,
      "held at the reconnect",
    );
    fails(
      "reconnect fetches: cache-directory hits on connection 2",
      evaluateReconnectFetches(applied({}, [], 2)).problems,
      "memory did not survive",
    );
    fails(
      "reconnect fetches: memory dropped",
      evaluateReconnectFetches(applied({ memory: "drop" }, [])).problems,
      "expected keep",
    );

    const cold = [
      { hash: "t1", source: "http" },
      { hash: "m1", source: "http" },
    ];
    passes(
      "warm fetches: only a payload absent from the cold cache",
      evaluateWarmFetches(
        cold,
        [{ hash: "m2", source: "http", kind: "mesh" }],
        new Set(["s"]),
      ).problems,
    );
    fails(
      "warm fetches: a cached payload fetched again",
      evaluateWarmFetches(
        cold,
        [{ hash: "m1", source: "http", kind: "mesh" }],
        new Set(),
      ).problems,
      "cached it",
    );
    fails(
      "warm fetches: a static payload fetched",
      evaluateWarmFetches(
        cold,
        [{ hash: "s", source: "http", kind: "texture" }],
        new Set(["s"]),
      ).problems,
      "static payload",
    );

    const set = staleFreshRegions(e.steps, [3, 4]);
    assert(
      "stale regions: MS, SM, AN plus steps 3 and 4's fresh regions, HU never",
      ["MS", "SM", "AN", "TR", "RT", "CM", "Marker", "PB"].every((r) =>
        set.includes(r),
      ) &&
        !set.includes("HU") &&
        !set.includes("HB"),
      set.join(","),
    );
  }

  // 6. The wire frame, frame comparison and connection timelines.
  {
    const sends = wireSends([frameLine(549, 180), frameLine(550, 181, 428)]);
    assert(
      "wireSends: a stale-coalesce send carries its snapshot's frame",
      sends.get(180)?.stale_from === null &&
        sends.get(181)?.stale_from === 428 &&
        sends.get(181)?.frame === 550,
    );
    const w = e.viewport[0];
    const hgt = e.viewport[1];
    const a = frame(w, hgt, [10, 20, 30, 255]);
    const b = frame(w, hgt, [10, 20, 30, 255]);
    const ms = regionsAtFrame(e, 400).MS;
    const hu = regionsAtFrame(e, 400).HU;
    b.rgba.set([0, 0, 0, 255], (hu[1] * w + hu[0]) * 4);
    assert(
      "compareAt: a difference inside HU is never compared",
      compareAt(e, a, b, 400).mismatched === 0,
    );
    b.rgba.set([0, 0, 0, 255], (ms[1] * w + ms[0]) * 4);
    const d = compareAt(e, a, b, 400);
    assert(
      "compareAt: one pixel of MS differs",
      d.mismatched === 1 && JSON.stringify(d.regions) === '["MS"]',
      JSON.stringify(d),
    );
    const host = (log: LiveLogLine[]) =>
      ({
        connections: [
          { n: 1, host: { log }, tap: { recording: { transactions: [] } } },
        ],
      }) as unknown as G2cHost;
    const after = connTimelinesAtCallback(
      host([frameLine(1080, 500), { frame: 1080, t_us: 1, event: "close" }]),
    );
    const before = connTimelinesAtCallback(
      host([{ frame: 607, t_us: 1, event: "close" }, frameLine(607)]),
    );
    assert(
      "connTimelinesAtCallback: a close logged after its frame's line counts from the next frame",
      after[0].closed === 1081 && before[0].closed === 607,
      `${after[0].closed} ${before[0].closed}`,
    );
  }
}
