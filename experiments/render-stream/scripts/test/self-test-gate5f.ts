#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for gate 5f's load-dependent judgements (lib/gate5f-checks.ts), on fabricated
// evidence (never a real run). Added with the 2026-10-11 G5f flake fix: under CPU load the 60 Hz
// credit loop phase-locks to every other frame (memory rs-g55d-rs5-switch-facts), and three
// checks had assumed every frame is sent. Each case below has a negative control: the tolerance
// is derived from the wire, so a genuinely wrong receiver or host must still fail.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate5f.ts
//
// 1. staleFromOfSeq / wireStateEqualsFullAtFrame(host, frame, stale_from).
// 2. checkReceiverVsReferenceMesh: a `stale_exact` DF-only shot passes on the stale-coalesce
//    sabotage leg only; one whose wire is not full at stale_from, or on a good leg, fails.
// 3. checkWarmHostNoGetsMesh: cache hits and GETs judged against the warm leg's own wire (a
//    phase-locked subset of DF surfaces, a surface live-mesh never fetched); a fetch of a cached
//    hash, a hit-count mismatch, an unmatched GET and a fetch its wire never named all fail.
// 4. connTimelinesAtCallback + pinsOfMesh: at the quit frame the last send stays a base when the
//    close follows the frame's callback (a pending quit frame), not when it precedes it.
//
// Exits non-zero if any assertion fails.

import type { StallReport } from "../lib/gate1-g1d-checks";
import type { G2bCheck, G2bClassification } from "../lib/gate2b-checks";
import type { G2cHost } from "../lib/gate2c-checks";
import {
  checkReceiverVsReferenceMesh,
  checkWarmHostNoGetsMesh,
  connTimelinesAtCallback,
  type G5fApplied,
  type G5fCheckpoint,
  type G5fEvaluation,
  pinsOfMesh,
  staleFromOfSeq,
  wireStateEqualsFullAtFrame,
} from "../lib/gate5f-checks";

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

function fakeEval(
  host: G2cHost | null,
  applied: G5fApplied | undefined,
  postStallStep: number | null,
  checkpoints: G5fCheckpoint[] = [],
): G5fEvaluation {
  const classification: G2bClassification = {
    result_class: "success",
    reasons: [],
    mismatching_steps: [],
  };
  return {
    e: { leg: "x", host, receiverDir: "/fake", applied, log: "", exit: 0 },
    checkpoints,
    stall: { expected_missed_steps: [] } as unknown as StallReport,
    postStallStep,
    classification,
  };
}

const meshState = (...hashes: string[]) => ({
  textures: [],
  meshes: hashes.map((h, i) => ({
    id: i + 1,
    status: "ok",
    surfaces: [{ hash: h }],
  })),
});
const tx = (frame: number, state: unknown) => ({
  seq: frame,
  frame,
  encoding: "patch",
  state,
});

// -------------------------------------------------------------------------------------------- 1

{
  const host = {
    full: {
      recording: { transactions: [tx(366, { p: 366 }), tx(367, { p: 367 })] },
    },
    connections: [
      {
        host: {
          log: [
            { frame: 365, sent: { seq: 40 } },
            { frame: 367, sent: { seq: 41, stale_from: 366 } },
          ],
        },
        tap: { recording: { transactions: [tx(367, { p: 366 })] } },
      },
    ],
  } as unknown as G2cHost;
  assertEqual(staleFromOfSeq(host, 41), 366, "staleFromOfSeq: a stale send");
  assertEqual(staleFromOfSeq(host, 40), null, "staleFromOfSeq: a newest send");
  assertEqual(
    wireStateEqualsFullAtFrame(host, 367),
    false,
    "wireStateEqualsFullAtFrame: a stale send differs from full at its own frame",
  );
  assertEqual(
    wireStateEqualsFullAtFrame(host, 367, 366),
    true,
    "wireStateEqualsFullAtFrame: a stale send equals full at stale_from",
  );
}

// -------------------------------------------------------------------------------------------- 2

{
  const exact: G5fCheckpoint = {
    step: 0,
    seq: 1,
    frame: 307,
    shot: "",
    reference: "",
    mismatched_pixels: 0,
    regions: {},
    benign: true,
    stale_from: null,
    stale_exact: null,
  };
  const staleCp: G5fCheckpoint = {
    ...exact,
    step: 1,
    seq: 41,
    frame: 367,
    mismatched_pixels: 640,
    regions: { DF: 640 },
    benign: false,
    stale_from: 366,
    stale_exact: true,
  };
  const legs = [
    "live-mesh",
    "live-mesh-warm",
    "live-mesh-stall",
    "sabotage-mesh-stale-coalesce",
  ];
  const evalsWith = (leg: string, cp: G5fCheckpoint) =>
    new Map(
      legs.map((l) => [
        l,
        fakeEval(
          null,
          undefined,
          l === "sabotage-mesh-stale-coalesce" ? 3 : null,
          l === leg ? [exact, cp] : [exact],
        ),
      ]),
    );
  assertCheck(
    checkReceiverVsReferenceMesh(
      evalsWith("sabotage-mesh-stale-coalesce", staleCp),
    ),
    true,
    "checkReceiverVsReferenceMesh: a stale_exact DF-only shot on the sabotage leg passes",
  );
  assertCheck(
    checkReceiverVsReferenceMesh(
      evalsWith("sabotage-mesh-stale-coalesce", {
        ...staleCp,
        stale_exact: false,
      }),
    ),
    false,
    "checkReceiverVsReferenceMesh: a stale shot whose wire is not full at stale_from fails",
  );
  assertCheck(
    checkReceiverVsReferenceMesh(evalsWith("live-mesh", staleCp)),
    false,
    "checkReceiverVsReferenceMesh: a stale_exact shot on a good leg fails",
  );
}

// -------------------------------------------------------------------------------------------- 3

{
  // live-mesh fetched A and B; the warm leg's wire names `named` (H: the engine's hue strip, named
  // ok but never fetched by anyone).
  const live = fakeEval(
    null,
    {
      fetches: [
        { hash: "A", status: 200 },
        { hash: "B", status: 200 },
      ],
    },
    null,
  );
  function warm(
    named: string[],
    fetched: string[],
    gets: number,
    hits: number,
  ): G5fEvaluation {
    const host = {
      hook: {
        lines: Array.from({ length: gets }, (_, i) => ({
          op: "http-get",
          seq: i,
        })),
      },
      serving: { http_gets: gets },
      connections: [
        {
          tap: { recording: { transactions: [tx(300, meshState(...named))] } },
        },
      ],
    } as unknown as G2cHost;
    return fakeEval(
      host,
      {
        fetches: fetched.map((h) => ({ hash: h, status: 200 })),
        resources_summary: {
          distinct_fetched: fetched.length,
          cache_hits: hits,
        },
        cache: { mode: "warm" },
      },
      null,
    );
  }
  const run = (w: G5fEvaluation) =>
    checkWarmHostNoGetsMesh(
      new Map([
        ["live-mesh", live],
        ["live-mesh-warm", w],
      ]),
    );
  assertCheck(
    await run(warm(["A", "B", "H"], [], 0, 2)),
    true,
    "checkWarmHostNoGetsMesh: every cached payload hit, nothing fetched",
  );
  assertCheck(
    await run(warm(["A", "H"], [], 0, 1)),
    true,
    "checkWarmHostNoGetsMesh: a phase-locked wire naming a subset hits only that subset",
  );
  assertCheck(
    await run(warm(["A", "B", "C", "H"], ["C"], 1, 2)),
    true,
    "checkWarmHostNoGetsMesh: a surface live-mesh never fetched is fetched once",
  );
  assertCheck(
    await run(warm(["A", "B", "H"], ["A"], 1, 1)),
    false,
    "checkWarmHostNoGetsMesh: fetching a cached hash fails",
  );
  assertCheck(
    await run(warm(["A", "B", "H"], [], 0, 1)),
    false,
    "checkWarmHostNoGetsMesh: fewer hits than cached payloads the wire named fails",
  );
  assertCheck(
    await run(warm(["A", "B", "H"], [], 1, 2)),
    false,
    "checkWarmHostNoGetsMesh: a GET with no receiver fetch fails",
  );
  assertCheck(
    await run(warm(["A", "B", "H"], ["Z"], 1, 2)),
    false,
    "checkWarmHostNoGetsMesh: a fetch its own wire never named fails",
  );
}

// -------------------------------------------------------------------------------------------- 4

{
  // DF's surface X is current at 850 (sent), Y at 851 (the quit frame, pending: never sent); the
  // host keeps X pinned as the base through 851's callback, then ends and closes.
  function host(closeBeforeCallback: boolean): G2cHost {
    const callback = { frame: 851, state: "streaming", pending: true };
    const close = { frame: 851, event: "close" };
    return {
      hook: {
        lines: [
          { frame: 850, op: "pin", hash: "X", payload_bytes: 1 },
          { frame: 851, op: "pin", hash: "Y", payload_bytes: 1 },
        ],
      },
      full: {
        recording: {
          transactions: [tx(850, meshState("X")), tx(851, meshState("Y"))],
        },
      },
      connections: [
        {
          n: 1,
          host: {
            log: [
              { frame: 850, state: "streaming", sent: { seq: 850 } },
              ...(closeBeforeCallback ? [close, callback] : [callback, close]),
            ],
          },
          tap: { recording: { transactions: [tx(850, meshState("X"))] } },
        },
      ],
    } as unknown as G2cHost;
  }
  assertEqual(
    connTimelinesAtCallback(host(false))[0].closed,
    852,
    "connTimelinesAtCallback: a close after the callback counts from the next frame",
  );
  assertEqual(
    connTimelinesAtCallback(host(true))[0].closed,
    851,
    "connTimelinesAtCallback: a close before the callback counts from its own frame",
  );
  assertEqual(
    pinsOfMesh(host(false)).late,
    [],
    "pinsOfMesh: the last send's surface stays named at a pending quit frame",
  );
  // SWO: closed before the callback, 851 has no viewer (HC1 serves nothing then): it is not
  // compared, and a pin logged there is reported instead.
  assertEqual(
    [
      pinsOfMesh(host(true)).late,
      pinsOfMesh(host(true)).unviewed_frames,
      pinsOfMesh(host(true)).unviewed,
    ],
    [[], 1, ["frame 851: pin Y with no viewer connected"]],
    "pinsOfMesh: a connection closed before the callback leaves a viewerless frame",
  );
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exitCode = 1;
} else {
  console.log("self-test-gate5f: all assertions passed");
}
