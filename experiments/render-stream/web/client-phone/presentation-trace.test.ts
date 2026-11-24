import assert from "node:assert/strict";
import test from "node:test";
import { presentationTrace } from "./presentation-trace";

test("folded sequences share the actual present time, with separate connection identities", () => {
  const trace = presentationTrace();
  trace.connection();
  trace.observer.onTransaction!({ seq: 1, frame: 10, arrivalMs: 1 });
  trace.observer.onTransaction!({ seq: 2, frame: 11, arrivalMs: 2 });
  trace.observer.onPresent!({ seqs: [1, 2], newestSeq: 2, tMs: 5 });
  trace.observer.onPresent!({ seqs: [], newestSeq: 2, tMs: 6 });
  trace.connection();
  trace.observer.onTransaction!({ seq: 1, frame: 12, arrivalMs: 7 });
  trace.observer.onPresent!({ seqs: [1], newestSeq: 1, tMs: 9 });
  const rows = trace.rows();
  assert.deepEqual(
    rows.map((r) => r.kind === "seq" && [r.connection, r.seq, r.presentMs]),
    [
      [1, 1, 5],
      [1, 2, 5],
      [2, 1, 9],
    ],
  );
  rows.length = 0;
  assert.equal(trace.rows().length, 3);
});

test("records the internal slot outcome, keeping stale separate from missed", () => {
  const trace = presentationTrace();
  for (const [missed, stale] of [
    [false, false],
    [false, true],
    [true, false],
  ])
    trace.observer.onSlot!({ t: 10, k: 2, missed, stale });
  assert.deepEqual(
    trace.rows().map((r) => r.kind === "slot" && [r.fresh, r.stale, r.missed]),
    [
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ],
  );
});
