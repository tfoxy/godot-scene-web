import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize, type Taken } from "./probe-summary";

function records(timestamps: number[], costs: number[]): Taken {
  const empty = () => ({ a: [], b: [], dropped: 0 });
  return {
    frames: { a: timestamps, b: costs, dropped: 0 },
    frameGl: empty(),
    messages: empty(),
    fetches: empty(),
    longTasks: empty(),
  };
}

test("multiple page callbacks count as one display frame and sum its callback cost", () => {
  // Three callbacks at each of the first two frames, then one callback per frame.
  const probe = records(
    [0, 0, 0, 16, 16, 16, 32, 80],
    [1, 2, 3, 2, 3, 4, 4, 8],
  );
  probe.messages = { a: [1024, 2048], b: [2, 4], dropped: 0 };
  const result = summarize(probe, 2);
  assert.equal(result.raf_per_s, 2);
  assert.deepEqual(result.frame_interval_ms, {
    n: 3,
    mean: 26.67,
    p50: 16,
    p95: 48,
    p99: 48,
    max: 48,
  });
  assert.equal(result.frames_over_1_5_tp, 1);
  assert.deepEqual(result.raf_callback_ms, {
    n: 4,
    mean: 6.75,
    p50: 8,
    p95: 9,
    p99: 9,
    max: 9,
  });
  assert.equal(result.raf_callback_busy_ms_per_s, 13.5);
  // Receive cost remains separate from the page's frame callback totals.
  assert.equal(result.messages_per_s, 1);
  assert.equal(result.message_kb_per_s, 1.5);
  assert.equal(result.onmessage_busy_ms_per_s, 3);
});

test("one callback per frame retains its interval and cost distribution", () => {
  const result = summarize(records([10, 30, 50], [1, 4, 7]), 1);
  assert.equal(result.raf_per_s, 3);
  assert.equal(result.frame_interval_ms.n, 2);
  assert.equal(result.frame_interval_ms.p50, 20);
  assert.equal(result.raf_callback_ms.n, 3);
  assert.equal(result.raf_callback_ms.p50, 4);
  assert.equal(result.raf_callback_busy_ms_per_s, 12);
});

test("empty windows and timestamp zero have no invented frame intervals", () => {
  const empty = summarize(records([], []), 1);
  assert.equal(empty.raf_per_s, 0);
  assert.equal(empty.frame_interval_ms.n, 0);
  assert.equal(empty.frame_interval_ms.p50, null);
  assert.equal(empty.raf_callback_ms.n, 0);
  assert.equal(empty.raf_callback_busy_ms_per_s, 0);
  const one = summarize(records([0, 0], [2, 3]), 1);
  assert.equal(one.raf_per_s, 1);
  assert.equal(one.frame_interval_ms.n, 0);
  assert.equal(one.raf_callback_ms.n, 1);
  assert.equal(one.raf_callback_ms.p50, 5);
});
