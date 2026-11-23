import assert from "node:assert/strict";
import { test } from "node:test";
import { pacingTrial } from "./pacing-trial";

test("balanced trial splits draw timestamps at fallback within the measured window", () => {
  assert.deepEqual(
    pacingTrial(
      "balanced",
      [99, 100, 600, 1100, 1600, 2100, 2101],
      100,
      2100,
      1100,
    ),
    {
      trial: { draws: 2, window_s: 1, draws_per_s: 2 },
      after_fallback: { draws: 3, window_s: 1, draws_per_s: 3 },
    },
  );
});

test("balanced without fallback keeps the whole window as trial", () => {
  for (const fallback of [null, 3000]) {
    assert.deepEqual(
      pacingTrial("balanced", [100, 2100], 100, 2100, fallback),
      {
        trial: { draws: 2, window_s: 2, draws_per_s: 1 },
        after_fallback: null,
      },
    );
  }
});

test("fallback before the window clips the trial to zero and keeps reconnect gaps", () => {
  assert.deepEqual(pacingTrial("balanced", [250, 1000], 100, 2100, 50), {
    trial: { draws: 0, window_s: 0, draws_per_s: null },
    after_fallback: { draws: 2, window_s: 2, draws_per_s: 1 },
  });
  assert.deepEqual(pacingTrial("balanced", [], 100, 2100, 100), {
    trial: { draws: 0, window_s: 0, draws_per_s: null },
    after_fallback: { draws: 0, window_s: 2, draws_per_s: 0 },
  });
});

test("fallback at the end or a zero-length window has no after rate", () => {
  assert.deepEqual(pacingTrial("balanced", [100], 0, 100, 100), {
    trial: { draws: 0, window_s: 0.1, draws_per_s: 0 },
    after_fallback: { draws: 1, window_s: 0, draws_per_s: null },
  });
  assert.deepEqual(pacingTrial("balanced", [], 100, 100, null), {
    trial: { draws: 0, window_s: 0, draws_per_s: null },
    after_fallback: null,
  });
});

test("fidelity and explicit-window runs do not report a balanced trial", () => {
  for (const preset of ["fidelity", undefined] as const) {
    assert.deepEqual(pacingTrial(preset, [100], 0, 1000, null), {
      trial: null,
      after_fallback: null,
    });
  }
});
