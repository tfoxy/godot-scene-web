// mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/web/pace-model/pacing.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { drawMetrics, pacingMetrics } from "./metrics";
import { DrawHistory, PresentationPacer } from "./pacing";

test("history uses only five completed seconds, including seconds with zero draws", () => {
  const history = new DrawHistory(0);
  for (let t = 0; t < 5000; t += 50) history.draw(t);
  assert.equal(history.max(), null);
  history.advance(5000);
  assert.equal(history.max(), 20);
  history.advance(10000);
  assert.equal(history.max(), 0);
});

test("age follows the newest consumed capture and steadiness counts only draw intervals", () => {
  const metrics = drawMetrics(
    [10, 20, 30, 40, 70],
    [1, 0, 1, 1, 1],
    [5, null, 20, 30, 50],
  );
  assert.deepEqual(metrics.content_age_ms, { mean: 11.25, p50: 10, p95: 20 });
  assert.deepEqual(metrics.steadiness.draw_interval_ms, [20, 10, 30]);
  assert.equal(metrics.steadiness.median_ms, 20);
  assert.ok(
    Math.abs(metrics.steadiness.stddev_ms! - Math.sqrt(200 / 3)) < 1e-9,
  );
  assert.equal(metrics.steadiness.stutter_share, 0); // Strictly greater than 1.5x.
  const stutter = drawMetrics([10, 20, 30, 70], [1, 1, 1, 1], [0, 0, 0, 0]);
  assert.equal(stutter.steadiness.stutter_share, 1 / 3);
  assert.equal(drawMetrics([], [], []).content_age_ms.mean, null);
  // The rAF timestamp can precede a capture delivered before callback entry.
  assert.equal(drawMetrics([10], [1], [15]).content_age_ms.mean, -5);
  assert.equal(drawMetrics([0], [1], [0]).steadiness.stddev_ms, null);
});

test("initial slots cover the display grid and missed slots are skipped rather than drawn late", () => {
  const pacer = new PresentationPacer(0, 0, 10);
  assert.equal(pacer.callback(0), true);
  assert.equal(pacer.callback(5), false); // One claim per interval.
  assert.equal(pacer.callback(35), true); // Slot 30, never catch up slots 10/20.
  assert.deepEqual(pacer.series.missedSlotMs, [10, 20]);
  assert.deepEqual(pacer.series.takenSlotMs, [0, 30]);
  assert.deepEqual(pacer.futureSlots(35, 60), [40, 50, 60]);
});

test("five completed seconds choose the largest sustainable display pattern", () => {
  for (const [drawEvery, expected] of [
    [1, "3/4"],
    [2, "1/3"],
  ] as const) {
    const pacer = new PresentationPacer(0, 0, 1000 / 60);
    for (let grid = 0; grid <= 300; grid++) {
      const ts = (grid * 1000) / 60;
      const slot = pacer.callback(ts);
      if (grid < 300 && grid % drawEvery === 0 && slot) pacer.draw(ts);
    }
    assert.equal(pacer.series.pattern.at(-1), expected);
    assert.deepEqual(pacer.series.reason, ["initial", "sustainable"]);
  }
});

function callbacks(
  pacer: PresentationPacer,
  from: number,
  until: number,
  skip: (t: number) => boolean = () => false,
) {
  for (let t = from; t <= until; t += 10)
    if (!skip(t) && pacer.callback(t)) pacer.draw(t);
}

function fitted() {
  const pacer = new PresentationPacer(0, 0, 10);
  callbacks(pacer, 0, 5000);
  assert.equal(pacer.series.pattern.at(-1), "3/4");
  return pacer;
}

test("display-rate callbacks do not re-fit or up-step before the five-second probe", () => {
  const pacer = fitted();
  callbacks(pacer, 5010, 9990);
  assert.deepEqual(pacer.series.reason, ["initial", "sustainable"]);
  callbacks(pacer, 10000, 10000);
  assert.deepEqual(pacer.series.pattern, ["1/1", "3/4", "1/1"]);
  assert.equal(pacer.series.reason.at(-1), "probe");
});

test("down-steps require a two-second hold and at least five percent missed slots", () => {
  const pacer = fitted();
  callbacks(pacer, 5010, 6990, (t) => t >= 6800);
  assert.equal(pacer.series.pattern.length, 2);
  callbacks(pacer, 7000, 8990, (t) => t >= 8800);
  assert.deepEqual(pacer.series.patternMs, [0, 5000, 7000]);
  callbacks(pacer, 9000, 9000);
  assert.deepEqual(pacer.series.pattern, ["1/1", "3/4", "2/3", "1/2"]);
  assert.deepEqual(pacer.series.patternMs, [0, 5000, 7000, 9000]);
});

test("two misses alone do not down-step and old misses expire from the window", () => {
  const pacer = fitted();
  callbacks(pacer, 5010, 9990, (t) => t === 5100 || t === 5120);
  assert.deepEqual(pacer.series.reason, ["initial", "sustainable"]);
  callbacks(pacer, 10000, 10000);
  assert.equal(pacer.series.reason.at(-1), "probe");
});

test("the down-step threshold is five percent of pattern slots, not callbacks", () => {
  for (const [misses, expected] of [
    [7, "3/4"],
    [8, "2/3"],
  ] as const) {
    const pacer = fitted();
    // There are 150 presentation slots in the 200 display intervals [5000,7000).
    const skip = new Set(pacer.futureSlots(6790, 6990).slice(0, misses));
    assert.equal(skip.size, misses);
    callbacks(pacer, 5010, 7000, (t) => skip.has(t));
    assert.equal(pacer.series.pattern.at(-1), expected);
  }
});

test("a clean one-second probe needs a further two seconds of confirmation", () => {
  const pacer = fitted();
  callbacks(pacer, 5010, 10990);
  assert.equal(pacer.series.probes[0].outcome, "pending");
  callbacks(pacer, 11000, 12990);
  assert.equal(pacer.series.probes[0].confirmMs, 11000);
  assert.equal(pacer.series.probes[0].outcome, "pending");
  callbacks(pacer, 13000, 20000);
  assert.equal(pacer.series.probes[0].outcome, "kept");
  assert.equal(pacer.series.probes[0].endMs, 13000);
  assert.deepEqual(pacer.series.pattern, ["1/1", "3/4", "1/1"]);
});

test("a probe missing exactly two percent reverts after one second and doubles its wait", () => {
  const pacer = fitted();
  callbacks(pacer, 5010, 11000, (t) => t === 10010 || t === 10020);
  assert.equal(pacer.series.probes[0].outcome, "reverted");
  assert.equal(pacer.series.probes[0].probeMissedShare, 0.02);
  assert.equal(pacer.series.pattern.at(-1), "3/4");
  assert.equal(pacer.series.patternMs.at(-1), 11000);
  callbacks(pacer, 11010, 20990);
  assert.equal(pacer.series.probes.length, 1);
  callbacks(pacer, 21000, 21000);
  assert.equal(pacer.series.probes.length, 2);
  assert.equal(pacer.series.probes[1].probeEveryMs, 10000);
});

test("confirmation rejects misses from its own two seconds even after a clean probe", () => {
  const pacer = fitted();
  callbacks(pacer, 5010, 13000, (t) =>
    [11010, 11020, 11030, 11040].includes(t),
  );
  const probe = pacer.series.probes[0];
  assert.equal(probe.probeMissedShare, 0);
  assert.equal(probe.confirmMissedShare, 0.02);
  assert.equal(probe.outcome, "reverted");
  assert.equal(probe.endMs, 13000);
  assert.equal(pacer.series.pattern.at(-1), "3/4");
});

test("failed probes back off to forty seconds and successful probes reset the wait", () => {
  const pacer = fitted();
  let from = 5010;
  for (const [start, wait] of [
    [10000, 5000],
    [21000, 10000],
    [42000, 20000],
    [83000, 40000],
  ] as const) {
    callbacks(
      pacer,
      from,
      start + 1000,
      (t) => t === start + 10 || t === start + 20,
    );
    assert.equal(pacer.series.probes.at(-1)!.probeEveryMs, wait);
    assert.equal(pacer.series.probes.at(-1)!.outcome, "reverted");
    from = start + 1010;
  }
  callbacks(pacer, from, 127000);
  assert.equal(pacer.series.probes.at(-1)!.probeEveryMs, 40000);
  assert.equal(pacer.series.probes.at(-1)!.outcome, "kept");
  // Down-step from the now-kept 1/1; the next probe resets to five seconds.
  callbacks(pacer, 127010, 127990, (t) => t >= 127800);
  callbacks(pacer, 128000, 133000);
  assert.equal(pacer.series.probes.at(-1)!.probeEveryMs, 5000);
  assert.equal(pacer.series.probes.at(-1)!.startMs, 133000);
});

test("probe slots are visible to the want planner on the unchanged display grid", () => {
  const pacer = fitted();
  callbacks(pacer, 5010, 9990);
  assert.deepEqual(pacer.futureSlots(10000, 10040), [10010, 10020, 10040]);
  pacer.callback(10000);
  assert.deepEqual(
    pacer.futureSlots(10000, 10040),
    [10010, 10020, 10030, 10040],
  );
});

test("a successful up-step resets a previously backed-off probe interval", () => {
  const pacer = new PresentationPacer(0, 0, 10);
  // Fifty draws/s at startup selects 1/3; subsequent callbacks arrive at display rate.
  for (let t = 0; t <= 5000; t += 10)
    if (pacer.callback(t) && t % 20 === 0) pacer.draw(t);
  assert.equal(pacer.series.pattern.at(-1), "1/3");
  callbacks(pacer, 5010, 11000, (t) => t >= 10100 && t < 10200);
  assert.equal(pacer.series.probes[0].outcome, "reverted");
  callbacks(pacer, 11010, 23990);
  assert.equal(pacer.series.probes[1].startMs, 21000);
  assert.equal(pacer.series.probes[1].probeEveryMs, 10000);
  callbacks(pacer, 24000, 26000);
  assert.equal(pacer.series.probes[1].outcome, "kept");
  assert.equal(pacer.series.probes[2].startMs, 26000);
  assert.equal(pacer.series.probes[2].probeEveryMs, 5000);
});

test("pacing metrics weight repeated patterns by elapsed time and count pending probes", () => {
  const pacer = fitted();
  callbacks(pacer, 5010, 11000, (t) => t === 10010 || t === 10020);
  const metrics = pacingMetrics(pacer.series, 0, 12000);
  assert.equal(metrics.pattern_changes, 3);
  assert.deepEqual(metrics.pattern_histogram, {
    "1/1": { duration_ms: 6000, share: 0.5 },
    "3/4": { duration_ms: 6000, share: 0.5 },
  });
  assert.equal(metrics.probes_kept, 0);
  assert.equal(metrics.probes_reverted, 1);
  assert.equal(metrics.probes_pending, 0);
  assert.equal(metrics.slots_missed, 2);
  assert.equal(metrics.slots_total, 976);
  assert.equal(metrics.missed_slot_share, 2 / 976);
  callbacks(pacer, 11010, 21000);
  assert.equal(pacingMetrics(pacer.series, 0, 21010).probes_pending, 1);
  assert.equal(
    pacingMetrics(new PresentationPacer(0, 0, 10).series, 0, 0)
      .missed_slot_share,
    null,
  );
});

test("no pattern is silently selected above the sustainable rate", () => {
  const pacer = new PresentationPacer(0, 0, 1000 / 60);
  for (let grid = 0; grid < 300; grid++) {
    const ts = (grid * 1000) / 60;
    if (pacer.callback(ts) && grid % 3 === 0) pacer.draw(ts);
  }
  assert.throws(
    () => pacer.callback(5000),
    /below the minimum presentation pattern/,
  );
});

test("fully elapsed trailing slots are counted without fabricating callbacks", () => {
  const pacer = new PresentationPacer(0, 0, 10);
  pacer.callback(0);
  pacer.finish(35);
  assert.deepEqual(pacer.series.missedSlotMs, [10, 20]);
  assert.deepEqual(pacer.series.takenSlotMs, [0]);
  pacer.finish(35);
  assert.deepEqual(pacer.series.missedSlotMs, [10, 20]);
});
