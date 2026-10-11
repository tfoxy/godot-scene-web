#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 5.5f: the pure evaluators of lib/gate55f-checks.ts, on fabricated evidence
// (never a real run). G5f (lib/gate5f-checks.ts, the structural template this group reuses) had
// none; this one exists so a future generalization of the shared stall/pin/retire machinery has a
// regression net on the GRP1 side too.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate55f.ts
//
// 1. g55fWindows: exact [from,to] per step on the S=300, N=60, LAST_STEP=9, quit=851 timeline.
// 2. stepShots55f: one shot per step, first wins, invalid entries skipped.
// 3. wireStateEqualsFullAtFrame: equal states at the same frame, differing states, no transaction
//    at that frame on either side (null), no frame given (null).
// 4. mismatchingRegionNames: only positive counts, sorted.
// 5. checkShaderFetchesLatestOnly: the recovery transaction equals the host's newest and the
//    receiver's shader-kind fetches name only hashes the newest state actually holds (pass); a
//    stale recovery, and a fetch naming a hash the newest state does not hold (fail).
// 6. checkStaleCoalesce: the post-stall mismatch set equals the fresh table unioned over
//    steps_applied_during (pass); wrong region set, a benign mismatch, state_equals_full true,
//    and a missing stale_from (each fails on its own).
// 7. checkReceiverVsReferenceShader: a benign PH-only mismatch passes, a real mismatch fails, the
//    sabotage leg's own post-stall step is excluded (its job is checkStaleCoalesce's), a window
//    wholly inside the stall (expected_missed_steps) is excluded too.
// 8. checkWarmHostNoGetsShader: zero GETs and matching cache-hit/fetch counts pass; any GET, any
//    fetch, a cache-hit mismatch or a non-benign checkpoint on either leg fails.
//
// Exits non-zero if any assertion fails.

import type { StallReport } from "../lib/gate1-g1d-checks";
import type { G2bCheck, G2bClassification } from "../lib/gate2b-checks";
import type { G2cHost } from "../lib/gate2c-checks";
import type { Gate55ShaderStep } from "../lib/gate55c-checks";
import {
  checkReceiverVsReferenceShader,
  checkShaderFetchesLatestOnly,
  checkStaleCoalesce,
  checkWarmHostNoGetsShader,
  type G55fApplied,
  type G55fCheckpoint,
  type G55fEvaluation,
  type G55fLegEvidence,
  g55fWindows,
  mismatchingRegionNames,
  stepShots55f,
  wireStateEqualsFullAtFrame,
} from "../lib/gate55f-checks";

let failures = 0;
function assert(cond: boolean, message: string): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${message}`);
  }
}
function assertEqual(a: unknown, b: unknown, message: string): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  assert(sa === sb, `${message}: got ${sa}, expected ${sb}`);
}
function assertCheck(c: G2bCheck, passed: boolean, message: string): void {
  assert(
    c.passed === passed,
    `${message}: ${c.id} passed=${c.passed} (${c.detail})`,
  );
}

// -------------------------------------------------------------------------------------------- 1

{
  const w = g55fWindows();
  assertEqual(w.length, 10, "g55fWindows: 10 windows");
  assertEqual(w[0], { step: 0, from: 307, to: 359 }, "g55fWindows: step 0");
  assertEqual(w[1], { step: 1, from: 367, to: 419 }, "g55fWindows: step 1");
  assertEqual(w[2], { step: 2, from: 427, to: 479 }, "g55fWindows: step 2");
  assertEqual(w[3], { step: 3, from: 487, to: 539 }, "g55fWindows: step 3");
  assertEqual(
    w[9],
    { step: 9, from: 847, to: 851 },
    "g55fWindows: last step to quit",
  );
}

// -------------------------------------------------------------------------------------------- 2

{
  const applied: G55fApplied = {
    transactions: [
      { seq: 1, frame: 310 },
      { seq: 2, frame: 420 },
      { seq: 3, frame: 480 },
    ],
    shots: [
      { stream: 1, seq: 1, step: 0 },
      { stream: 1, seq: 1, step: 0 }, // duplicate: first wins
      { stream: 1, seq: 2, step: 1 },
      { step: 2 }, // invalid: no seq
      { stream: 1, seq: 99 }, // invalid: no step
    ],
  };
  const shots = stepShots55f(applied);
  assertEqual(shots.size, 2, "stepShots55f: two valid steps");
  assertEqual(
    shots.get(0),
    { seq: 1, frame: 310 },
    "stepShots55f: step 0 (first wins)",
  );
  assertEqual(shots.get(1), { seq: 2, frame: 420 }, "stepShots55f: step 1");
  assertEqual(
    shots.get(2),
    undefined,
    "stepShots55f: invalid step entry skipped",
  );
}

// -------------------------------------------------------------------------------------------- 3

function fakeHost(
  fullStates: Map<number, unknown>,
  tapStates: Map<number, unknown>,
): G2cHost {
  const toTx = (m: Map<number, unknown>) =>
    [...m.entries()].map(([frame, state]) => ({
      seq: frame,
      frame,
      encoding: "full",
      state,
    }));
  return {
    full: { recording: { transactions: toTx(fullStates) } },
    connections: [{ tap: { recording: { transactions: toTx(tapStates) } } }],
  } as unknown as G2cHost;
}

{
  const equalHost = fakeHost(
    new Map([[100, { a: 1 }]]),
    new Map([[100, { a: 1 }]]),
  );
  assertEqual(
    wireStateEqualsFullAtFrame(equalHost, 100),
    true,
    "wireStateEqualsFullAtFrame: equal states",
  );
  const differentHost = fakeHost(
    new Map([[100, { a: 1 }]]),
    new Map([[100, { a: 2 }]]),
  );
  assertEqual(
    wireStateEqualsFullAtFrame(differentHost, 100),
    false,
    "wireStateEqualsFullAtFrame: differing states",
  );
  assertEqual(
    wireStateEqualsFullAtFrame(equalHost, 999),
    null,
    "wireStateEqualsFullAtFrame: no transaction at that frame",
  );
  assertEqual(
    wireStateEqualsFullAtFrame(equalHost, null),
    null,
    "wireStateEqualsFullAtFrame: no frame given",
  );
}

// -------------------------------------------------------------------------------------------- 4

{
  const cp: G55fCheckpoint = {
    step: 3,
    seq: 1,
    frame: 490,
    shot: "",
    reference: "",
    mismatched_pixels: 5,
    regions: { PH: 3, TI: 2, RM: 0, IN: 0 },
    benign: false,
  };
  assertEqual(
    mismatchingRegionNames(cp),
    ["PH", "TI"],
    "mismatchingRegionNames: only positive counts, sorted",
  );
}

// -------------------------------------------------------------------------------------------- 5

function fakeEval(
  host: G2cHost | null,
  applied: G55fApplied | undefined,
  stall: StallReport | null,
  postStallStep: number | null,
  checkpoints: G55fCheckpoint[] = [],
): G55fEvaluation {
  const e: G55fLegEvidence = {
    leg: "x",
    host,
    receiverDir: "/fake",
    applied,
    log: "",
    exit: 0,
  };
  const classification: G2bClassification = {
    result_class: "success",
    reasons: [],
    mismatching_steps: [],
  };
  return { e, checkpoints, stall, postStallStep, classification };
}

{
  const newestState = {
    shaders: [{ id: 1, hash: "hash-new", status: "ok", source: "payload" }],
  };
  const host = fakeHost(new Map([[489, newestState]]), new Map());
  const passStall: StallReport = {
    recovery: { seq: 7, frame: 489, stale_from: null, state_equals_full: true },
  } as unknown as StallReport;
  const passEvals = new Map([
    [
      "live-shader-stall",
      fakeEval(
        host,
        {
          fetches: [
            { kind: "shader", hash: "hash-new", seq: 7 },
            { kind: "shader", hash: "hash-old", seq: 2 }, // fetched earlier (step 0 bootstrap), not at recovery
          ],
        },
        passStall,
        3,
      ),
    ],
  ]);
  assertCheck(
    checkShaderFetchesLatestOnly(passEvals),
    true,
    "checkShaderFetchesLatestOnly: recovery equals newest, fetch names the newest hash",
  );

  const staleStall: StallReport = {
    recovery: { seq: 7, frame: 489, stale_from: 368, state_equals_full: false },
  } as unknown as StallReport;
  const staleEvals = new Map([
    ["live-shader-stall", fakeEval(host, { fetches: [] }, staleStall, 3)],
  ]);
  assertCheck(
    checkShaderFetchesLatestOnly(staleEvals),
    false,
    "checkShaderFetchesLatestOnly: a stale recovery fails",
  );

  const wrongFetchEvals = new Map([
    [
      "live-shader-stall",
      fakeEval(
        host,
        { fetches: [{ kind: "shader", hash: "hash-wrong", seq: 7 }] },
        passStall,
        3,
      ),
    ],
  ]);
  assertCheck(
    checkShaderFetchesLatestOnly(wrongFetchEvals),
    false,
    "checkShaderFetchesLatestOnly: a fetch naming a hash the newest state does not hold fails",
  );
}

// -------------------------------------------------------------------------------------------- 6

{
  const steps: Pick<Gate55ShaderStep, "step" | "fresh">[] = [
    {
      step: 1,
      fresh: { TI: true, PH: true, Marker: true, IN: false, RM: false },
    },
    {
      step: 2,
      fresh: { IN: true, PH: true, Marker: true, TI: false, RM: false },
    },
    {
      step: 3,
      fresh: { TI: true, RM: true, PH: true, Marker: true, IN: false },
    },
  ];
  const expectedUnion = ["IN", "Marker", "PH", "RM", "TI"]; // steps 2 and 3 unioned, sorted

  const cpMatching: G55fCheckpoint = {
    step: 3,
    seq: 9,
    frame: 490,
    shot: "",
    reference: "",
    mismatched_pixels: 10,
    regions: Object.fromEntries(expectedUnion.map((r) => [r, 1])),
    benign: false,
  };
  const baseStall: StallReport = {
    steps_applied_during: [2, 3],
    recovery: { seq: 9, frame: 490, stale_from: 368, state_equals_full: false },
  } as unknown as StallReport;
  const passEvals = new Map([
    [
      "sabotage-shader-stale-coalesce",
      fakeEval(null, undefined, baseStall, 3, [cpMatching]),
    ],
  ]);
  assertCheck(
    checkStaleCoalesce(passEvals, steps),
    true,
    "checkStaleCoalesce: mismatch set equals the fresh table unioned over steps_applied_during",
  );

  const cpWrongRegions: G55fCheckpoint = { ...cpMatching, regions: { PH: 1 } };
  const wrongRegionEvals = new Map([
    [
      "sabotage-shader-stale-coalesce",
      fakeEval(null, undefined, baseStall, 3, [cpWrongRegions]),
    ],
  ]);
  assertCheck(
    checkStaleCoalesce(wrongRegionEvals, steps),
    false,
    "checkStaleCoalesce: a narrower mismatch set fails",
  );

  const cpBenign: G55fCheckpoint = { ...cpMatching, benign: true };
  const benignEvals = new Map([
    [
      "sabotage-shader-stale-coalesce",
      fakeEval(null, undefined, baseStall, 3, [cpBenign]),
    ],
  ]);
  assertCheck(
    checkStaleCoalesce(benignEvals, steps),
    false,
    "checkStaleCoalesce: a benign mismatch fails (the sabotage must have a real, non-benign effect)",
  );

  const equalFullStall: StallReport = {
    ...baseStall,
    recovery: { ...baseStall.recovery, state_equals_full: true },
  } as unknown as StallReport;
  const equalFullEvals = new Map([
    [
      "sabotage-shader-stale-coalesce",
      fakeEval(null, undefined, equalFullStall, 3, [cpMatching]),
    ],
  ]);
  assertCheck(
    checkStaleCoalesce(equalFullEvals, steps),
    false,
    "checkStaleCoalesce: state_equals_full true fails (the sabotage had no effect on the wire)",
  );

  const noStaleFromStall: StallReport = {
    ...baseStall,
    recovery: { ...baseStall.recovery, stale_from: null },
  } as unknown as StallReport;
  const noStaleFromEvals = new Map([
    [
      "sabotage-shader-stale-coalesce",
      fakeEval(null, undefined, noStaleFromStall, 3, [cpMatching]),
    ],
  ]);
  assertCheck(
    checkStaleCoalesce(noStaleFromEvals, steps),
    false,
    "checkStaleCoalesce: a missing stale_from fails (the sabotage did not trigger)",
  );
}

// -------------------------------------------------------------------------------------------- 7

{
  const G55F_LEG_NAMES = [
    "live-shader",
    "live-shader-warm",
    "live-shader-stall",
    "sabotage-shader-stale-coalesce",
  ];
  const benignCp: G55fCheckpoint = {
    step: 0,
    seq: 1,
    frame: 310,
    shot: "",
    reference: "",
    mismatched_pixels: 2,
    regions: { PH: 2 },
    benign: true,
  };
  const exactCp: G55fCheckpoint = {
    ...benignCp,
    mismatched_pixels: 0,
    regions: {},
    benign: true,
  };
  const allBenignEvals = new Map(
    G55F_LEG_NAMES.map((leg) => [
      leg,
      fakeEval(
        null,
        undefined,
        { expected_missed_steps: [] } as unknown as StallReport,
        null,
        [exactCp, benignCp],
      ),
    ]),
  );
  assertCheck(
    checkReceiverVsReferenceShader(allBenignEvals),
    true,
    "checkReceiverVsReferenceShader: exact and benign-PH-only checkpoints pass",
  );

  const realMismatchCp: G55fCheckpoint = {
    ...benignCp,
    benign: false,
    regions: { TI: 4 },
    mismatched_pixels: 4,
  };
  const failEvals = new Map(allBenignEvals);
  failEvals.set(
    "live-shader",
    fakeEval(
      null,
      undefined,
      { expected_missed_steps: [] } as unknown as StallReport,
      null,
      [realMismatchCp],
    ),
  );
  assertCheck(
    checkReceiverVsReferenceShader(failEvals),
    false,
    "checkReceiverVsReferenceShader: a real mismatch fails",
  );

  // The sabotage leg's own post-stall step is excluded (checkStaleCoalesce's job), so a real
  // mismatch there must NOT fail this check.
  const sabotageWithRealMismatch = new Map(allBenignEvals);
  sabotageWithRealMismatch.set(
    "sabotage-shader-stale-coalesce",
    fakeEval(
      null,
      undefined,
      { expected_missed_steps: [] } as unknown as StallReport,
      3,
      [{ ...realMismatchCp, step: 3 }, exactCp],
    ),
  );
  assertCheck(
    checkReceiverVsReferenceShader(sabotageWithRealMismatch),
    true,
    "checkReceiverVsReferenceShader: the sabotage's own post-stall step is excluded",
  );

  // A window wholly inside the stall (expected_missed_steps) has no shot and must be excluded,
  // even while every OTHER step's checkpoint is present and exact.
  const missedStepEvals = new Map(allBenignEvals);
  missedStepEvals.set(
    "live-shader-stall",
    fakeEval(
      null,
      undefined,
      { expected_missed_steps: [2] } as unknown as StallReport,
      null,
      [
        { ...exactCp, step: 0 },
        { ...exactCp, step: 1 },
        { ...exactCp, step: 2, seq: null, shot: "" },
        { ...exactCp, step: 3 },
      ],
    ),
  );
  assertCheck(
    checkReceiverVsReferenceShader(missedStepEvals),
    true,
    "checkReceiverVsReferenceShader: a window wholly inside the stall is excluded",
  );
}

// -------------------------------------------------------------------------------------------- 8

{
  function warmHost(gets: number, httpGets: number): G2cHost {
    return {
      hook: {
        lines: Array.from({ length: gets }, (_, i) => ({
          op: "http-get",
          seq: i,
        })),
      },
      serving: { http_gets: httpGets },
    } as unknown as G2cHost;
  }
  const liveEval = fakeEval(
    null,
    { resources_summary: { distinct_fetched: 7 } },
    null,
    null,
    [],
  );
  function warmEval(
    host: G2cHost,
    distinctFetched: number,
    cacheHits: number,
    mode: string,
  ) {
    return fakeEval(
      host,
      {
        resources_summary: {
          distinct_fetched: distinctFetched,
          cache_hits: cacheHits,
        },
        cache: { mode },
      },
      null,
      null,
      [],
    );
  }

  const passEvals = new Map([
    ["live-shader", liveEval],
    ["live-shader-warm", warmEval(warmHost(0, 0), 0, 7, "warm")],
  ]);
  assertCheck(
    await checkWarmHostNoGetsShader(passEvals),
    true,
    "checkWarmHostNoGetsShader: zero GETs, cache hits equal live's fetch count",
  );

  const anyGetEvals = new Map([
    ["live-shader", liveEval],
    ["live-shader-warm", warmEval(warmHost(1, 1), 0, 7, "warm")],
  ]);
  assertCheck(
    await checkWarmHostNoGetsShader(anyGetEvals),
    false,
    "checkWarmHostNoGetsShader: any GET fails",
  );

  const fetchedEvals = new Map([
    ["live-shader", liveEval],
    ["live-shader-warm", warmEval(warmHost(0, 0), 2, 7, "warm")],
  ]);
  assertCheck(
    await checkWarmHostNoGetsShader(fetchedEvals),
    false,
    "checkWarmHostNoGetsShader: any receiver fetch fails",
  );

  const mismatchedHitsEvals = new Map([
    ["live-shader", liveEval],
    ["live-shader-warm", warmEval(warmHost(0, 0), 0, 3, "warm")],
  ]);
  assertCheck(
    await checkWarmHostNoGetsShader(mismatchedHitsEvals),
    false,
    "checkWarmHostNoGetsShader: a cache-hit count that does not equal live's fetch count fails",
  );

  const notWarmEvals = new Map([
    ["live-shader", liveEval],
    ["live-shader-warm", warmEval(warmHost(0, 0), 0, 7, "cold")],
  ]);
  assertCheck(
    await checkWarmHostNoGetsShader(notWarmEvals),
    false,
    "checkWarmHostNoGetsShader: a non-warm cache mode fails",
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exitCode = 1;
} else {
  console.log("self-test-gate55f: all assertions passed");
}
