// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GodotGpuEmitterConfig } from "../src/particles";
import {
  burstConfig,
  clockState,
  fullEmitter,
  packedBytes,
  skipEmitter,
} from "./fixtures/godot-gpu-skip";

const cases: { name: string; config: GodotGpuEmitterConfig }[] = [];
// Cover the restart timing cross-product; distribute the other dimensions across it.
for (const lifetimeRandomness of [0, 0.5]) {
  for (const explosiveness of [0, 0.7]) {
    for (const randomness of [0, 0.3]) {
      for (const fixedFps of [0, 30, 60]) {
        const i = cases.length;
        const config = burstConfig({
          amount: [1, 40, 200][i % 3],
          preProcessTime: [0.4, 2, 400][Math.floor(i / 3) % 3],
          fixedFps,
          explosiveness,
          randomness,
          oneShot: i % 4 === 0,
          fractionalDelta: i % 5 !== 0,
          localCoords: i % 2 === 0,
          amountRatio: i % 4 === 1 ? 0.4 : 1,
          interpToEnd: i % 5 === 0 ? 0.1 : 0,
        });
        config.material = {
          ...config.material,
          // Exercise TIME without making every long baseline run a noise benchmark.
          turbulence: config.preProcessTime < 400,
          uniforms: {
            ...config.material.uniforms,
            lifetime_randomness: lifetimeRandomness,
            turbulence_influence_min: 0.2,
            turbulence_influence_max: 0.8,
            turbulence_initial_displacement_min: 1,
            turbulence_initial_displacement_max: 3,
            turbulence_noise_speed: [1, 2, 0],
          },
        };
        cases.push({
          name: `life-random=${lifetimeRandomness} explosive=${explosiveness} random=${randomness} fps=${fixedFps} amount=${config.amount} pre=${config.preProcessTime} one-shot=${config.oneShot}`,
          config,
        });
      }
    }
  }
}
for (const [amount, seed] of [
  [40, 77],
  [40, 191],
  [200, 99],
]) {
  cases.push({
    name: `lobby-shaped amount=${amount} seed=${seed}`,
    config: burstConfig({ amount, seed }),
  });
}

describe("Godot GPU burst skip-ahead equivalence", () => {
  it("yields eligible long bursts and shades only the final lives", () => {
    const e = skipEmitter(burstConfig());
    const shade = vi.spyOn(e as unknown as { shade(): void }, "shade");
    const yieldNow = vi.fn(() => true);
    e.update(0.0173, 17, yieldNow);
    expect(e.settling).toBe(true);
    expect(yieldNow).toHaveBeenCalled();
    e.advance();
    expect(e.settling).toBe(false);
    // Repeated subtraction reaches 12,000 passes here; keep the original loop's rounding.
    expect(e.stats.steps).toBe(12000);
    expect(shade.mock.calls.length).toBeLessThan(40 * 62);
  });

  it("exposes the exact planned remaining shader work and yields within a pass", () => {
    const e = skipEmitter(burstConfig({ preProcessTime: 0.2 }));
    const shade = vi.spyOn(e as unknown as { shade(): void }, "shade");
    e.update(0, 17, () => true);
    expect(e.stats.burstParticlePassesRemaining).toBeNull();
    while (e.stats.burstParticlePassesRemaining === null) e.advance(() => true);
    const planned = e.stats.burstParticlePassesRemaining;
    expect(planned).toBeGreaterThan(0);
    expect(shade).not.toHaveBeenCalled();
    let previous = planned;
    let count = 0;
    while (e.settling) {
      const before = shade.mock.calls.length;
      e.advance(() => true);
      // Includes calls that only advance the clock: never more than one shader invocation.
      expect(shade.mock.calls.length - before).toBeLessThanOrEqual(1);
      count += shade.mock.calls.length - before;
      if (e.settling) {
        expect(e.stats.burstParticlePassesRemaining).toBeLessThanOrEqual(
          previous,
        );
        previous = e.stats.burstParticlePassesRemaining as number;
      }
    }
    // The frame's ordinary step follows the burst; it is not included in the work plan.
    expect(count).toBe(planned);
    expect(e.stats.burstParticlePassesRemaining).toBe(0);
  });

  it("a refused burst still spreads and replays queued work", () => {
    // A pass longer than a life can skip entire phase cycles: outside the classifier's proof.
    const c = burstConfig({ lifetime: 0.02, preProcessTime: 0.4 });
    const spread = skipEmitter(c);
    const full = fullEmitter(c);
    spread.update(0.0173, 17, () => true);
    full.update(0.0173, 17);
    expect(spread.settling).toBe(true);
    for (const e of [spread, full]) {
      e.setEmitting(false);
      e.restart();
      e.update(0.0191, 18);
      e.advance();
    }
    expect(spread.settling).toBe(false);
    expect(packedBytes(spread)).toEqual(packedBytes(full));
    expect(clockState(spread)).toEqual(clockState(full));
  });

  it("bounds always-yield replay behind a refused burst and preserves call order", () => {
    const c = burstConfig({ lifetime: 0.02, fixedFps: 0, preProcessTime: 40 });
    const spread = skipEmitter(c);
    const full = fullEmitter(c);
    spread.update(0.0173, 17, () => true);
    full.update(0.0173, 17);
    for (let frame = 0; frame < 500; frame++) {
      for (const e of [spread, full]) {
        if (frame === 100) e.setEmitting(false);
        if (frame === 110) e.setEmitting(true);
        if (frame === 200) e.configure({ ...c, speedScale: 0.7 });
        if (frame === 300) e.restart();
        if (frame === 400) e.requestProcess(0.1);
        e.update(0.0137, 18 + frame * 0.0137, () => true);
      }
    }
    const yieldNow = vi.fn(() => true);
    let calls = 0;
    while (spread.settling) {
      const before = spread.stats.steps;
      spread.advance(yieldNow);
      // The final preprocess pass may also execute its ordinary frame step.
      expect(spread.stats.steps - before).toBeLessThanOrEqual(2);
      expect(++calls).toBeLessThan(5000);
    }
    full.advance();
    expect(yieldNow).toHaveBeenCalled();
    expect(calls).toBeGreaterThan(500);
    expect(packedBytes(spread)).toEqual(packedBytes(full));
    expect(clockState(spread)).toEqual(clockState(full));
    expect(Reflect.get(spread, "particles")).toEqual(
      Reflect.get(full, "particles"),
    );
    for (let frame = 0; frame < 120; frame++) {
      spread.update(0.0171);
      full.update(0.0171);
    }
    expect(packedBytes(spread)).toEqual(packedBytes(full));
    expect(clockState(spread)).toEqual(clockState(full));
  });

  it("keeps exact restart boundaries near a whole-life pass and collapsed emission slots", () => {
    for (const amount of [0, 1, 40]) {
      for (const lifeInPasses of [1.01, 2.01, 29.99]) {
        for (const explosiveness of [0, 0.7, 1 - Number.EPSILON, 1]) {
          const c = burstConfig({
            amount,
            lifetime: lifeInPasses / 30,
            preProcessTime: 0.4,
            randomness: 1,
            explosiveness,
          });
          const full = fullEmitter(c);
          const skip = skipEmitter(c);
          for (const e of [full, skip]) {
            e.update(0.0173, 7);
            e.requestProcess(0.7);
            e.update(0.0191, 8);
          }
          expect(clockState(skip)).toEqual(clockState(full));
          expect(packedBytes(skip)).toEqual(packedBytes(full));
          expect(Reflect.get(skip, "particles")).toEqual(
            Reflect.get(full, "particles"),
          );
        }
      }
    }
  });

  for (const seed of [77, 191]) {
    cases.push({
      name: `whole-burst life=400 pre=400 amount=40 seed=${seed}`,
      config: burstConfig({
        lifetime: 400,
        preProcessTime: 400,
        fixedFps: 0,
        seed,
      }),
    });
  }

  for (const [caseIndex, { name, config }] of cases.entries()) {
    it(name, () => {
      const full = fullEmitter(config);
      const skip = skipEmitter(config);
      let checks = 0;
      let random = 73;
      const yields = [1, 7, 40, 0][caseIndex % 4];
      const yieldNow = () => {
        checks++;
        if (yields) return checks % yields === 0;
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        return random % 23 === 0;
      };
      const finish = () => {
        while (skip.settling) skip.advance(yieldNow);
      };
      const equal = () => {
        expect(packedBytes(skip)).toEqual(packedBytes(full));
        expect(clockState(skip)).toEqual(clockState(full));
        // Includes inactive particles' retained arrays and the spawn cache, beyond the pack.
        expect(Reflect.get(skip, "particles")).toEqual(
          Reflect.get(full, "particles"),
        );
        expect(skip.activeCount()).toBe(full.activeCount());
        expect(skip.isInactive).toBe(full.isInactive);
      };
      full.update(0.0173, 17.125);
      skip.update(0.0173, 17.125, yieldNow);
      finish();
      equal();
      for (let frame = 0; frame < 120; frame++) {
        const delta = [0.0137, 0.0191, 1 / 59][frame % 3];
        full.update(delta);
        skip.update(delta);
        if (frame === 119) equal();
      }
      // A requested burst starts with live particle state, rather than a clear buffer.
      full.setEmitting(true);
      skip.setEmitting(true);
      full.requestProcess(config.preProcessTime);
      skip.requestProcess(config.preProcessTime);
      full.update(0.0217, 24.75);
      skip.update(0.0217, 24.75, yieldNow);
      finish();
      equal();
      for (let frame = 0; frame < 120; frame++) {
        full.update(0.0163);
        skip.update(0.0163);
      }
      equal();
    }, 30000); // Functional full-reference simulation, not a timing budget.
  }

  it("replays emission changes, restart, requests and fractional frames during a burst", () => {
    const c = burstConfig({ preProcessTime: 4, randomness: 0.3 });
    const full = fullEmitter(c);
    const skip = skipEmitter(c);
    full.update(0.0173, 5);
    skip.update(0.0173, 5, () => true);
    for (const e of [full, skip]) {
      e.setEmitting(false);
      e.update(0.0197, 5.0197, () => true);
      e.restart();
      e.setEmitting(true);
      e.requestProcess(3);
      e.configure({ ...c, speedScale: 0.7 });
      e.update(0.0131, 5.0328, () => true);
      let resumes = 0;
      while (e.settling) {
        e.advance(() => true);
        expect(++resumes).toBeLessThan(30000);
      }
    }
    expect(skip.settling).toBe(false);
    expect(packedBytes(skip)).toEqual(packedBytes(full));
    expect(clockState(skip)).toEqual(clockState(full));
    for (let i = 0; i < 120; i++) {
      full.update(0.0171);
      skip.update(0.0171);
    }
    expect(packedBytes(skip)).toEqual(packedBytes(full));
    expect(clockState(skip)).toEqual(clockState(full));
  });
});
