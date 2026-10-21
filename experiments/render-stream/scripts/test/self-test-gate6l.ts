// Self-test for gate 6 group g6l (lib/gate6l-checks.ts), driven from self-test-gate6.ts's main:
// every pure evaluator with a passing and a failing case, on synthetic values and the committed
// fixtures/gate6-scene/expected.json.
//
//  1. g6lWindows, liveStepAt and regionsAtFrame: twelve settle windows and forty disjoint motion
//     windows; the step in force and its regions at a live frame (moved at step 10).
//  2. evaluateMotionMonotonic: gaps of 1 and 2 pass; a gap of 3 passes only after the stalled
//     seq, across the reconnect, or when the receiver held the earlier transaction longer than a
//     frame (fetch, shot, frame); a gap of 3 behind a fast receiver and a frame going backwards fail.
//     G7q, credit window 2: the gap is the hold of the transaction whose slot the next send took
//     (w - 1 seqs back), and the stall's gap follows the in-window send after the stalled seq.
//  3. creditToSend: sends at the first callback after the credit pass; a late send and a send
//     before the credit fail. G7q, window 2 (the hello's grant): a send needs the credit of the
//     seq two back, one send per callback; a third in flight and a late send fail.
//  4. windowsWithoutCandidate: a window whose only transaction was shot for an earlier-listed
//     window is legitimately missed; a window with an unshot transaction is not, unless (G7q) that
//     transaction was folded into a later one (`coalesced_into`) and so never drawn alone.
//  5. evaluateFetchLatestOnly, evaluateReconnectFetches, evaluateWarmFetches and staleFreshRegions.
//  6. wireSends, compareAt (HU compared since G6b) and gate 5f's connTimelinesAtCallback as g6l uses it.

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
    // G7mm: holds count in frames where the receiver recorded them.
    const framed = (
      frames: number[],
      pf: Array<[number, number] | null>,
      us: number,
      stream = 1,
    ): AppliedTx[] =>
      frames.map((f, i) => ({
        stream,
        seq: i + 1,
        frame: f,
        fetched: pf[i] ? 1 : 0,
        receive_to_submit_us: us,
        received_process_frame: pf[i]?.[0] ?? 500 + i,
        submitted_process_frame: pf[i]?.[1] ?? 500 + i,
      }));
    const deferred = evaluateMotionMonotonic(
      framed([320, 321, 324], [null, [501, 502], null], 15000),
      noShots,
      null,
      320,
      1080,
    );
    assert(
      "motion: a fetch deferred one frame (15 ms hold, under 16.667) passes by frames",
      deferred.problems.length === 0 &&
        deferred.attributed["receiver-fetch"] === 1 &&
        deferred.hold_basis.frames === 1,
      JSON.stringify(deferred),
    );
    fails(
      "motion: the same 15 ms hold without frame fields still fails (microsecond fallback)",
      evaluateMotionMonotonic(
        tx([320, 321, 324]).map((t, i) => ({
          ...t,
          receive_to_submit_us: i === 1 ? 15000 : 6000,
        })),
        noShots,
        null,
        320,
        1080,
      ).problems,
      "gap 3",
    );
    fails(
      "motion: a gap of 3 behind a transaction received and submitted in one frame, fast in us, fails",
      evaluateMotionMonotonic(
        framed([320, 321, 324], [null, [501, 501], null], 6000),
        noShots,
        null,
        320,
        1080,
      ).problems,
      "0 frames",
    );
    const slowFrame = evaluateMotionMonotonic(
      framed([320, 321, 324], [null, [501, 501], null], 20800),
      noShots,
      null,
      320,
      1080,
    );
    assert(
      "motion: one frame iteration longer than a frame in us (same process frame) is still excused",
      slowFrame.problems.length === 0 &&
        slowFrame.attributed["receiver-fetch"] === 1 &&
        slowFrame.hold_basis.us === 1,
    );
    const twoFrame = evaluateMotionMonotonic(
      framed([320, 321, 325], [null, [501, 503], null], 40000),
      noShots,
      null,
      320,
      1080,
    );
    assert(
      "motion: a real 2-frame fetch hold is excused (receiver-fetch) by frames",
      twoFrame.problems.length === 0 &&
        twoFrame.attributed["receiver-fetch"] === 1 &&
        twoFrame.hold_basis.frames === 1,
    );
    const reconnectFramed = evaluateMotionMonotonic(
      [
        ...framed([606, 607], [null, null], 2000),
        ...framed([612, 613, 616], [null, null, null], 2000, 2),
      ],
      noShots,
      null,
      320,
      1080,
    );
    fails(
      "motion: a reconnect's second stream is judged by frames too (fast 3-gap fails)",
      reconnectFramed.problems,
      "stream 2",
    );
    assert(
      "motion: the reconnect itself is still attributed",
      reconnectFramed.attributed.reconnect === 1,
    );
    fails(
      "motion: a frame going backwards",
      evaluateMotionMonotonic(tx([320, 322, 321]), noShots, null, 320, 1080)
        .problems,
      "after frame",
    );
    // G7q, window 2: seq 3 -> 4 has a gap of 3; seq 2 (the slot seq 4 took) was the slow one.
    const w2 = evaluateMotionMonotonic(
      tx([320, 321, 322, 325], { slow: [2] }),
      new Set(["1:2"]),
      null,
      320,
      1080,
      2,
    );
    assert(
      "motion (window 2): a gap after seq 3 is attributed to seq 2's shot",
      w2.problems.length === 0 && w2.attributed["receiver-shot"] === 1,
      JSON.stringify(w2),
    );
    fails(
      "motion (window 2): the same gap with seq 3 slow and seq 2 fast",
      evaluateMotionMonotonic(
        tx([320, 321, 322, 325], { slow: [3] }),
        noShots,
        null,
        320,
        1080,
        2,
      ).problems,
      "held seq 2",
    );
    const w2stall = evaluateMotionMonotonic(
      tx([426, 427, 428, 549]),
      noShots,
      2,
      320,
      1080,
      2,
    );
    assert(
      "motion (window 2): the gap after the stalled seq's in-window send is attributed stall",
      w2stall.problems.length === 0 && w2stall.attributed.stall === 1,
      JSON.stringify(w2stall),
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
    // G7q, window 2.
    const hello2: LiveLogLine = {
      frame: 40,
      t_us: 40 * 16667,
      event: "hello",
      credit_window_granted: 2,
    };
    const w2 = creditToSend([
      hello2,
      frameLine(41, 1),
      frameLine(42, 2),
      ack(43, 1),
      frameLine(43, 3),
      ack(44, 2),
      frameLine(44, 4),
    ]);
    passes(
      "credit-to-send (window 2): seq 2 at the next callback, then each at its slot's credit",
      w2.problems,
    );
    assert(
      "credit-to-send (window 2): three sends at +0",
      w2.delays["0"] === 3,
      JSON.stringify(w2.delays),
    );
    fails(
      "credit-to-send (window 2): a third in flight",
      creditToSend([
        hello2,
        frameLine(41, 1),
        frameLine(42, 2),
        frameLine(43, 3),
      ]).problems,
      "before seq 1 was credited",
    );
    fails(
      "credit-to-send (window 2): a slot free a callback before the send",
      creditToSend([
        hello2,
        frameLine(41, 1),
        frameLine(42, 2),
        ack(43, 1),
        frameLine(43),
        frameLine(44, 3),
      ]).problems,
      "callbacks after",
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
    // G7q: the recovery (frame 549) folded into the next send (550), shot for window 4: one
    // apply, so window 112 has no candidate left.
    const folded = tx([427, 549, 550, 562]).map((t) =>
      t.seq === 2 ? { ...t, coalesced_into: 3 } : t,
    );
    const foldMissed = windowsWithoutCandidate(
      folded,
      new Map([
        ["1:3", 4],
        ["1:4", 113],
      ]),
      windows,
    );
    assert(
      "missed windows (window 2): a transaction folded into the window-4 shot is no candidate",
      JSON.stringify(foldMissed) === "[112]",
      JSON.stringify(foldMissed),
    );
    const unfolded = windowsWithoutCandidate(
      tx([427, 549, 550, 562]),
      new Map([
        ["1:2", 4],
        ["1:4", 113],
      ]),
      windows,
    );
    assert(
      "missed windows: unfolded, the recovery's successor is window 112's candidate",
      JSON.stringify(unfolded) === "[]",
      JSON.stringify(unfolded),
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
      "stale regions: MS, SM, AN plus steps 3 and 4's fresh regions (HU is not fresh there)",
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
    const dh = compareAt(e, a, b, 400);
    assert(
      "compareAt: a difference inside HU is compared (render-stream/6, G6b)",
      dh.mismatched === 1 && JSON.stringify(dh.regions) === '["HU"]',
      JSON.stringify(dh),
    );
    b.rgba.set([10, 20, 30, 255], (hu[1] * w + hu[0]) * 4);
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
