// mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/web/pace-model/probe.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { idleReturnsDisplay } from "./probe";

const series = (hz: number) => ({
  ts: Array.from({ length: hz + 1 }, (_, i) => (i * 1000) / hz),
});

for (const [idleHz, expected] of [
  [60, true],
  [30, false],
  [15, false],
] as const) {
  test(`60 Hz reference ${expected ? "accepts" : "rejects"} ${idleHz} Hz idle`, () => {
    assert.equal(idleReturnsDisplay(series(60), series(idleHz)), expected);
  });
}
