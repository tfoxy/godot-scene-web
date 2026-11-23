// mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/web/pace-model/host.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { EmulatedHost, type HostClock, type HostOptions } from "./host";

class Clock implements HostClock {
  time = 0;
  sequence = 0;
  jobs = new Map<number, { at: number; cb: () => void }>();
  now = () => this.time;
  setTimeout = (cb: () => void, ms: number) => {
    const id = ++this.sequence;
    this.jobs.set(id, { at: this.time + ms, cb });
    return id;
  };
  clearTimeout = (id: number) => {
    this.jobs.delete(id);
  };
  advance(until: number) {
    for (;;) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      this.time = Math.max(this.time, next[1].at);
      this.jobs.delete(next[0]);
      next[1].cb();
    }
    this.time = until;
  }
}
const options = (
  policy: HostOptions["policy"],
  oneWayMs = 0.5,
): HostOptions => ({
  policy,
  oneWayMs,
  jitterMs: 0,
  applyMs: 1,
});

test("d1 counts in-flight sends and consults historical rather than current state", () => {
  const clock = new Clock();
  const host = new EmulatedHost(options("d1", 24), 0, clock);
  clock.advance(40);
  assert.equal(host.consume(clock.now()), 0);
  assert.equal(host.series.sendMs.length, 2); // Second tick sees pre-send state.
  clock.advance(45);
  assert.equal(host.consume(clock.now()), 1);
  clock.advance(61);
  assert.equal(host.consume(clock.now()), 1);
  clock.advance(90);
  assert.deepEqual(host.series.sent, [1, 1, 0, 0, 0]);
  assert.deepEqual(host.series.decisionUndrawn, [0, 0, 1, 2, 1]);
  clock.advance(101);
  assert.equal(host.series.sent[5], 1); // Consumption is finally visible.
  host.stop();
  assert.equal(clock.jobs.size, 0);
});

test("dN bounds undrawn items at short latency; off sends on every tick", () => {
  for (const policy of ["off", "d1", "d2", "d3"] as const) {
    const clock = new Clock();
    const host = new EmulatedHost(options(policy), 0, clock);
    clock.advance(200);
    const expected = policy === "off" ? 11 : Number(policy[1]);
    assert.equal(host.series.sendMs.length, expected);
    assert.equal(host.consume(clock.now()), expected);
    assert.equal(host.consume(clock.now()), 0);
    clock.advance(250);
    assert.ok(host.series.sendMs.length > expected);
    host.stop();
  }
});

test("late ticks re-target absolute deadlines instead of accumulating drift", () => {
  const clock = new Clock();
  const start = 100;
  clock.time = start;
  const host = new EmulatedHost(options("off"), start, clock);
  const period = host.series.periodMs;
  clock.time = start + period + 7; // Dispatch the first timer seven ms late.
  clock.advance(clock.time);
  assert.equal(host.series.tickMs[0], start + period + 7);
  clock.advance(start + 10 * period + 1);
  assert.equal(host.series.tickMs.length, 10);
  assert.ok(host.series.tickMs[9] >= start + 10 * period);
  assert.ok(host.series.tickMs[9] < start + 10 * period + 1);
  host.stop();
});

test("fractional deadlines avoid a second timeout under browser nesting clamps", () => {
  const clock = new Clock();
  const schedule = clock.setTimeout;
  clock.setTimeout = (cb, ms) => schedule(cb, Math.max(4, Math.floor(ms)));
  const host = new EmulatedHost(options("off"), 0, clock);
  clock.advance(2000);
  assert.ok(host.series.tickMs.length > 100);
  for (const [i, time] of host.series.tickMs.entries()) {
    const late = time - (i + 1) * host.series.periodMs;
    assert.ok(late >= 0 && late < 1, `tick ${i} dispatched ${late}ms late`);
  }
  host.stop();
});

test("seeded jitter records due and actual arrivals and cancels pending work", () => {
  const run = () => {
    const clock = new Clock();
    const host = new EmulatedHost(
      { ...options("off", 24), jitterMs: 40 },
      0,
      clock,
    );
    clock.advance(300);
    assert.ok(host.series.arrivalMs.length > 0);
    for (let i = 0; i < host.series.sendMs.length; i++) {
      const delay = host.series.arrivalDueMs[i] - host.series.sendMs[i];
      assert.ok(delay >= 25 && delay < 65);
    }
    for (let i = 0; i < host.series.arrivalMs.length; i++)
      assert.ok(
        host.series.arrivalMs[i] >=
          host.series.arrivalDueMs[host.series.arrivalSend[i]] &&
          host.series.arrivalMs[i] <
            host.series.arrivalDueMs[host.series.arrivalSend[i]] + 1,
      );
    assert.equal(host.consume(clock.now()), host.series.arrivalMs.length);
    host.stop();
    assert.equal(clock.jobs.size, 0);
    const count = host.series.tickMs.length;
    clock.advance(1000);
    assert.equal(host.series.tickMs.length, count);
    return host.series;
  };
  assert.deepEqual(run(), run());
});

test("early timers cannot deliver arrivals or host ticks before their deadline", () => {
  const clock = new Clock();
  const host = new EmulatedHost(options("off"), 0, clock);
  const first = [...clock.jobs][0];
  clock.jobs.delete(first[0]);
  clock.time = host.series.periodMs - 0.3;
  first[1].cb();
  assert.equal(host.series.tickMs.length, 0);
  clock.advance(20);
  assert.equal(host.series.tickMs.length, 1);
  assert.equal(host.series.arrivalMs.length, 1);
  host.stop();
});

test("invalid policies and latency values are rejected before starting timers", () => {
  for (const value of [
    { ...options("off"), policy: "d4" },
    { ...options("off"), oneWayMs: -1 },
    { ...options("off"), jitterMs: NaN },
    { ...options("off"), applyMs: Infinity },
  ]) {
    const clock = new Clock();
    assert.throws(
      () => new EmulatedHost(value as HostOptions, 0, clock),
      /invalid host options/,
    );
    assert.equal(clock.jobs.size, 0);
  }
});

test("cap uses five completed draw seconds and delayed rate feedback", () => {
  const clock = new Clock();
  const host = new EmulatedHost(
    { ...options("cap", 24), capOffset: 0.05 },
    0,
    clock,
  );
  for (let second = 0; second < 5; second++) {
    for (let n = 0; n < 20; n++) {
      clock.advance(second * 1000 + n * 50 + 1);
      host.observeCallback(clock.now(), clock.now());
      host.recordDraw(clock.now());
    }
  }
  clock.advance(5000);
  host.observeCallback(5000, 5000);
  clock.advance(5100);
  const rates = host.series.decisionRateHz;
  const ticks = host.series.tickMs;
  for (let i = 0; i < ticks.length; i++)
    assert.equal(rates[i], ticks[i] < 5024 ? 60 : 21);
  assert.deepEqual(host.series.rateHz, [60, 21]);
  host.stop();
});

test("cap token bucket keeps the fractional remainder after sending", () => {
  const clock = new Clock();
  const host = new EmulatedHost(
    { ...options("cap"), capOffset: 0.2 },
    0,
    clock,
  );
  for (let second = 0; second < 5; second++) {
    for (let n = 0; n < 20; n++) {
      clock.advance(second * 1000 + n * 50 + 1);
      host.observeCallback(clock.now(), clock.now());
      host.recordDraw(clock.now());
    }
  }
  clock.advance(5000);
  host.observeCallback(5000, 5000);
  clock.advance(10000);
  const sent = host.series.tickMs.filter(
    (t, i) => t >= 5100 && host.series.sent[i],
  );
  assert.ok(sent.length >= 116 && sent.length <= 119, `sent ${sent.length}`);
  assert.ok(host.series.bucketAfter.every((b) => b >= 0 && b <= 1));
  host.stop();
});

test("newest consumed capture survives reordered arrivals and content waits for a draw", () => {
  const clock = new Clock();
  const host = new EmulatedHost(
    { ...options("off", 24), jitterMs: 80 },
    0,
    clock,
  );
  clock.advance(300);
  assert.ok(host.series.arrivalMs.length > 0);
  assert.equal(host.lastConsumedCaptureMs, null);
  const newest = Math.max(
    ...host.series.arrivalSend.map((i) => host.series.sendMs[i]),
  );
  assert.equal(host.consume(clock.now()), host.series.arrivalMs.length);
  assert.equal(host.lastConsumedCaptureMs, newest);
  assert.equal(host.consume(clock.now()), 0);
  host.stop();
});

test("paced wants obey both deadlines and the host serves only arrived wants", () => {
  const clock = new Clock();
  const host = new EmulatedHost(
    { ...options("paced", 24), jitterMs: 2 },
    0,
    clock,
  );
  const slots = [100, 150, 200];
  host.planWants(0, slots, 200);
  host.planWants(0, slots, 200); // Re-planning a slot never duplicates its want.
  const wants = host.series.wants!;
  assert.equal(wants.frame.length, 3);
  for (let i = 0; i < wants.frame.length; i++) {
    const x = wants.frame[i] * host.series.periodMs + wants.fitNoiseMs[i];
    assert.ok(wants.decisionMs[i] + 24 <= x);
    assert.ok(x + 24 + 2 + 1 + 1 <= wants.slotMs[i]);
    assert.ok(x + host.series.periodMs + 24 + 2 + 1 + 1 > wants.slotMs[i]);
  }
  clock.advance(500);
  assert.equal(host.series.sendMs.length, 3);
  assert.equal(wants.arrivalMs.length, 3);
  host.series.sent.forEach((sent, i) => {
    if (sent) assert.ok(wants.frame.includes(i + 1));
  });
  const count = host.series.sendMs.length;
  clock.advance(1000);
  assert.equal(host.series.sendMs.length, count);
  host.stop();
  assert.equal(clock.jobs.size, 0);
});

test("unreachable wants are recorded; fit noise is seeded Gaussian with sigma 1ms", () => {
  const run = () => {
    const clock = new Clock();
    const host = new EmulatedHost(options("paced", 24), 0, clock);
    host.planWants(0, [20], 200);
    assert.deepEqual(host.series.wants!.unplannableSlotMs, [20]);
    host.planWants(
      0,
      Array.from({ length: 2000 }, (_, i) => 100 + i * 50),
      200,
    );
    const noise = host.series.wants!.fitNoiseMs;
    const mean = noise.reduce((a, b) => a + b, 0) / noise.length;
    const sigma = Math.sqrt(
      noise.reduce((a, b) => a + (b - mean) ** 2, 0) / noise.length,
    );
    assert.ok(Math.abs(mean) < 0.05, `mean=${mean}ms`);
    assert.ok(Math.abs(sigma - 1) < 0.05, `sigma=${sigma}ms`);
    host.stop();
    assert.equal(clock.jobs.size, 0);
    return noise;
  };
  assert.deepEqual(run(), run());
});

test("late unserved wants merge into one send at the next host tick", () => {
  const clock = new Clock();
  const host = new EmulatedHost(options("paced", 24), 0, clock);
  host.planWants(0, [100, 150], 200);
  // Delay both viewer-to-host deliveries beyond their requested ticks.
  for (const job of clock.jobs.values()) if (job.at === 24) job.at = 180;
  clock.advance(179);
  assert.equal(host.series.sendMs.length, 0);
  clock.advance(500);
  assert.equal(host.series.sendMs.length, 1);
  assert.ok(host.series.sendMs[0] >= 180);
  assert.deepEqual(host.series.wants!.arrivalMs, [180, 180]);
  assert.equal(
    host.series.sent.reduce((a, b) => a + b, 0),
    1,
  );
  host.stop();
});
