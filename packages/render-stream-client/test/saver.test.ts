// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SaverPacer } from "../src/saver";
import { FakeClock } from "./fakes";

function setup(hz = 58.8) {
  const clock = new FakeClock();
  const pacer = new SaverPacer(clock);
  const panel = 1000 / hz;
  let grid = -1;
  function tick(draw = true, skip = 0) {
    grid += 1 + skip;
    clock.t = grid * panel;
    const present = pacer.presents();
    if (present && draw) pacer.draw();
    return present;
  }
  function until(ms: number, draw = true, omit = (_grid: number) => false) {
    while ((grid + 1) * panel <= ms) {
      if (omit(grid + 1)) grid++;
      else tick(draw);
    }
  }
  function fit(capacity = hz) {
    until(550);
    let credit = 0;
    until(5600, true, () => {
      credit += capacity / hz;
      if (credit < 1) return true;
      credit -= Math.floor(credit);
      return false;
    });
  }
  return { clock, pacer, panel, tick, until, fit };
}

describe("saver presentation pacer", () => {
  it.each([
    [41, 2],
    [30.5, 3],
    [58, 2],
  ])("capacity %s selects k=%s with headroom on a 58.8 Hz display", (capacity, k) => {
    const h = setup();
    h.fit(capacity);
    expect(h.pacer.stats().divisor).toBe(k);
    expect(h.pacer.stats().capacityHz).toBeCloseTo(capacity, 0);
    expect(h.pacer.stats().displayHz).toBeCloseTo(58.8, 5);
  });

  it("measures the idle grid before drawing and starts capacity 2 s after the first draw", () => {
    const h = setup(100);
    h.until(1000, false);
    expect(h.pacer.stats().displayHz).toBeCloseTo(100);
    expect(h.pacer.stats().capacityHz).toBeNull();
    h.tick(); // first draw at 1010
    h.until(6000, false);
    expect(h.pacer.stats().capacityHz).toBeNull();
    h.until(6010, false);
    expect(h.pacer.stats()).toMatchObject({ divisor: 2, capacityHz: 100 });
  });

  it("an 800 ms stall creates no misses, is excluded from capacity and restarts its open window", () => {
    const h = setup(100);
    h.until(4000);
    h.tick(true, 79); // 4800, in the open capacity window
    expect(h.pacer.stats().missedSlotShare).toBe(0);
    h.until(7790);
    expect(h.pacer.stats().capacityHz).toBeNull();
    h.until(7800);
    expect(h.pacer.stats().capacityHz).toBe(100);
    h.tick(true, 79);
    expect(h.pacer.stats().missedSlotShare).toBe(0);
  });

  it("counts callbacks rather than content-limited draws, and stale slots separately from misses", () => {
    const h = setup(100);
    h.until(1000);
    h.until(6000, false);
    expect(h.pacer.stats()).toMatchObject({
      divisor: 2,
      capacityHz: 100,
      missedSlotShare: 0,
    });
    expect(h.pacer.stats().staleSlotShare).toBeGreaterThan(0.9);
    h.until(6100, false);
    h.tick(false, 3);
    expect(h.pacer.stats().missedSlotShare).toBeGreaterThan(0);
    const stale = h.pacer.stats().staleSlotShare!;
    h.until(6200);
    expect(h.pacer.stats().staleSlotShare).toBeLessThan(stale);
    h.until(9000);
    expect(h.pacer.stats()).toMatchObject({
      missedSlotShare: 0,
      staleSlotShare: 0,
    });
  });

  it("requires 20% misses in the first 5 s, then down-steps at a sustained 5% over 4 s", () => {
    const h = setup(100);
    h.fit(); // selected at 5500
    h.until(10490, true, (g) => g % 40 === 0); // 5%, below startup threshold
    expect(h.pacer.stats().divisor).toBe(2);
    h.until(10500);
    expect(h.pacer.stats().divisor).toBe(3);
  });

  it("ignores a short burst of isolated misses that a 2 s window would count as 5%", () => {
    const h = setup(100);
    h.fit(); // selected at 5500
    h.until(12000);
    const burst = new Set([1210, 1230, 1250, 1270, 1290]);
    h.until(16000, true, (g) => burst.has(g));
    expect(h.pacer.stats().divisor).toBe(2);
  });

  it("down-steps at exactly 20% after the initial 2 s hold", () => {
    const h = setup(100);
    h.fit();
    h.until(7500, true, (g) => g % 10 === 0);
    expect(h.pacer.stats().divisor).toBe(2);
    h.until(7610, true, (g) => g % 10 === 0);
    expect(h.pacer.stats().divisor).toBe(3);
  });

  it("keeps a clean k-1 probe after 4 s and waits 30 clean seconds before probing", () => {
    const h = setup();
    h.fit(30.5);
    expect(h.pacer.stats().divisor).toBe(3);
    h.until(35000);
    expect(h.pacer.stats().divisor).toBe(3);
    h.until(36000);
    expect(h.pacer.stats().divisor).toBe(2);
    h.until(41000);
    expect(h.pacer.stats().divisor).toBe(2);
  });

  it("reverts a failing probe and doubles its wait, capped at 4 min", () => {
    const h = setup(100);
    h.fit(50); // 100/(.85*50) needs k=3
    expect(h.pacer.stats().divisor).toBe(3);
    let at = 5600;
    for (const wait of [30000, 60000, 120000, 240000, 240000]) {
      h.until(at + wait - 200);
      expect(h.pacer.stats().divisor).toBe(3);
      // Find the first callback of the probe, within one divisor period.
      while (h.pacer.stats().divisor === 3) h.tick();
      const start = h.clock.t;
      expect(h.pacer.stats().divisor).toBe(2);
      h.until(start + 3990, true, (g) => g % 20 === 0);
      expect(h.pacer.stats().divisor).toBe(2);
      h.until(start + 4100, true, (g) => g % 20 === 0);
      expect(h.pacer.stats().divisor).toBe(3);
      at = start + 4000;
    }
  });

  it("rejects a probe missing exactly 2% of its eligible slots", () => {
    const h = setup(100);
    h.fit(50);
    h.until(35000);
    while (h.pacer.stats().divisor === 3) h.tick();
    const start = h.clock.t;
    h.until(start + 3990, true, (g) => g % 100 === 0);
    expect(h.pacer.stats().divisor).toBe(2);
    h.until(start + 4010, true, (g) => g % 100 === 0);
    expect(h.pacer.stats().divisor).toBe(3);
  });

  it("refits interval and anchor under 0.1% drift without false misses", () => {
    const h = setup();
    let t = 0;
    let draws = 0;
    for (let grid = 0; grid < 12000; grid++) {
      t += h.panel * (1 + (0.001 * grid) / 12000);
      h.clock.t = t;
      if (h.pacer.presents()) {
        h.pacer.draw();
        draws++;
      }
      expect(h.pacer.stats().missedSlotShare ?? 0).toBe(0);
    }
    expect(h.pacer.stats().displayHz).toBeCloseTo(58.8 / 1.001, 3);
    expect(h.pacer.stats().divisor).toBe(2);
    expect(draws).toBeGreaterThan(5900);
    expect(draws).toBeLessThan(6300);
  });

  it("reset forgets the grid, first draw, rates, slots and selected divisor", () => {
    const h = setup();
    h.fit();
    h.pacer.reset();
    expect(h.pacer.stats()).toEqual({
      divisor: 1,
      displayHz: null,
      capacityHz: null,
      missedSlotShare: null,
      staleSlotShare: null,
    });
    expect(h.tick()).toBe(false);
    h.until(7000, false);
    expect(h.pacer.stats().displayHz).toBeCloseTo(58.8);
    expect(h.pacer.stats().capacityHz).toBeNull();
    h.tick();
    h.until(11900);
    expect(h.pacer.stats().divisor).toBe(1);
    h.until(12100);
    expect(h.pacer.stats().divisor).toBe(2);
  });
});
