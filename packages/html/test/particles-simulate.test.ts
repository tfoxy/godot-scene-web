import {
  activeParticleCount,
  createParticleState,
  type ParticleSystemState,
  particlesAreLive,
  preprocessParticles,
  simulateParticles,
} from "@godot-scene-web/effects/particles";
import type { ParticleSpecConfig } from "@godot-scene-web/html/runtime";
import { normalizeParticleSpecConfig as normalizeParticleConfig } from "@godot-scene-web/html/runtime";
import { describe, expect, it } from "vitest";

function config(overrides: Partial<ParticleSpecConfig>): ParticleSpecConfig {
  return normalizeParticleConfig({ seed: 12345, fixedFps: 60, ...overrides });
}

function run(state: ParticleSystemState, seconds: number, step = 1 / 60): void {
  const steps = Math.round(seconds / step);
  for (let i = 0; i < steps; i += 1) {
    simulateParticles(state, step);
  }
}

function snapshot(state: ParticleSystemState) {
  return state.particles.map((p) => ({
    active: p.active,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    rotation: p.rotation,
  }));
}

describe("particle simulation", () => {
  it("is deterministic: same seed + dt sequence => identical state", () => {
    const cfg = config({
      amount: 24,
      lifetime: 1,
      initialVelocityMin: 20,
      initialVelocityMax: 120,
      spread: 45,
      gravity: [0, 200],
      emissionShape: 1,
      emissionSphereRadius: 8,
    });
    const a = createParticleState(cfg);
    const b = createParticleState(normalizeParticleConfig(cfg));
    run(a, 1.3);
    run(b, 1.3);
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it("differs with a different seed", () => {
    const base = config({ amount: 24, initialVelocityMax: 100, spread: 60 });
    const a = createParticleState(base);
    const b = createParticleState(
      normalizeParticleConfig({ ...base, seed: 999 }),
    );
    run(a, 0.8);
    run(b, 0.8);
    expect(snapshot(a)).not.toEqual(snapshot(b));
  });

  it("continuous emitter reaches ~amount live particles in steady state", () => {
    const state = createParticleState(
      config({
        amount: 20,
        lifetime: 1,
        explosiveness: 0,
        oneShot: false,
        lifetimeRandomness: 0,
        initialVelocityMin: 0,
        initialVelocityMax: 0,
        gravity: [0, 0],
      }),
    );
    run(state, 2.5); // > lifetime, past warm-up
    const live = activeParticleCount(state);
    expect(live).toBeGreaterThanOrEqual(19);
    expect(live).toBeLessThanOrEqual(20);
    expect(particlesAreLive(state)).toBe(true);
  });

  it("one-shot burst emits `amount` then decays to zero and goes inactive", () => {
    const state = createParticleState(
      config({
        amount: 16,
        lifetime: 0.5,
        explosiveness: 1,
        oneShot: true,
        lifetimeRandomness: 0,
        initialVelocityMin: 0,
        initialVelocityMax: 0,
        gravity: [0, 0],
      }),
    );
    run(state, 1 / 30); // a couple of frames in
    expect(activeParticleCount(state)).toBe(16);
    run(state, 0.7); // well past lifetime
    expect(activeParticleCount(state)).toBe(0);
    expect(particlesAreLive(state)).toBe(false);
  });

  it("births land inside the emission shape (no velocity/gravity)", () => {
    const radius = 17;
    const state = createParticleState(
      config({
        amount: 64,
        lifetime: 5,
        explosiveness: 1,
        oneShot: true,
        initialVelocityMin: 0,
        initialVelocityMax: 0,
        gravity: [0, 0],
        scaleMin: 1,
        scaleMax: 1,
        emissionShape: 1,
        emissionSphereRadius: radius,
        emissionOffset: [3, -4],
      }),
    );
    run(state, 1 / 60); // spawn the burst; v=0 => no movement
    let live = 0;
    for (const p of state.particles) {
      if (!p.active) continue;
      live += 1;
      const dx = p.x - 3;
      const dy = p.y + 4;
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(radius + 1e-6);
    }
    expect(live).toBe(64);
  });

  it("stays within the kinematic travel envelope and never NaNs", () => {
    const radius = 10;
    const vMax = 300;
    const g = 980;
    const lifetime = 1;
    const state = createParticleState(
      config({
        amount: 40,
        lifetime,
        explosiveness: 1,
        oneShot: true,
        spread: 180,
        initialVelocityMin: 50,
        initialVelocityMax: vMax,
        gravity: [0, g],
        emissionShape: 1,
        emissionSphereRadius: radius,
      }),
    );
    const bound = radius + vMax * lifetime + 0.5 * g * lifetime * lifetime + 1;
    for (let i = 0; i < 60; i += 1) {
      simulateParticles(state, 1 / 60);
      for (const p of state.particles) {
        if (!p.active) continue;
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
        expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(bound);
      }
    }
  });

  it("keeps color in [0,1] and follows the ramp ends over life", () => {
    const state = createParticleState(
      config({
        amount: 32,
        lifetime: 1,
        explosiveness: 1,
        oneShot: true,
        lifetimeRandomness: 0,
        initialVelocityMin: 0,
        initialVelocityMax: 0,
        gravity: [0, 0],
        colorRamp: [
          { offset: 0, color: [1, 0, 0, 1] },
          { offset: 1, color: [0, 0, 1, 1] },
        ],
      }),
    );
    run(state, 0.02); // young: near the first (red) stop
    for (const p of state.particles) {
      if (!p.active) continue;
      for (const ch of [p.r, p.g, p.b, p.a]) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
      expect(p.r).toBeGreaterThan(p.b); // red-dominant early
    }
    run(state, 0.93); // old: near the last (blue) stop
    for (const p of state.particles) {
      if (!p.active) continue;
      expect(p.b).toBeGreaterThan(p.r); // blue-dominant late
    }
  });

  it("keeps scale within the curve × random-base range", () => {
    const scaleMin = 0.25;
    const scaleMax = 0.5;
    const state = createParticleState(
      config({
        amount: 32,
        lifetime: 1,
        explosiveness: 1,
        oneShot: true,
        initialVelocityMin: 0,
        initialVelocityMax: 0,
        gravity: [0, 0],
        scaleMin,
        scaleMax,
        // triangle curve peaking at 1.0
        scaleCurve: [
          { x: 0, y: 0 },
          { x: 0.5, y: 1 },
          { x: 1, y: 0 },
        ],
      }),
    );
    for (let i = 0; i < 40; i += 1) {
      simulateParticles(state, 1 / 60);
      for (const p of state.particles) {
        if (!p.active) continue;
        expect(p.scaleX).toBeGreaterThanOrEqual(0);
        expect(p.scaleX).toBeLessThanOrEqual(scaleMax + 1e-6);
        expect(p.scaleX).toBe(p.scaleY);
      }
    }
  });

  it("is frame-rate independent at the fixed-step granularity", () => {
    const cfg = config({
      amount: 20,
      lifetime: 1,
      fixedFps: 60,
      initialVelocityMin: 30,
      initialVelocityMax: 150,
      spread: 90,
      gravity: [0, 300],
      emissionShape: 1,
      emissionSphereRadius: 6,
    });
    const whole = createParticleState(cfg);
    const halves = createParticleState(normalizeParticleConfig(cfg));
    for (let i = 0; i < 30; i += 1) {
      simulateParticles(whole, 1 / 60);
      simulateParticles(halves, 1 / 120);
      simulateParticles(halves, 1 / 120);
    }
    const a = snapshot(whole);
    const b = snapshot(halves);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i].active).toBe(b[i].active);
      if (a[i].active) {
        expect(Math.abs(a[i].x - b[i].x)).toBeLessThan(1e-6);
        expect(Math.abs(a[i].y - b[i].y)).toBeLessThan(1e-6);
      }
    }
  });

  it("does not emit when emitting is false", () => {
    const state = createParticleState(
      config({ amount: 20, emitting: false, oneShot: false }),
    );
    run(state, 1.5);
    expect(activeParticleCount(state)).toBe(0);
    expect(particlesAreLive(state)).toBe(false);
  });
});

describe("preprocess warm-start", () => {
  // The Neow fog: lifetime 10, preprocess 100. The system must appear ALREADY warmed
  // on the first drawn frame — populated with ages spread across the lifetime
  // (drifted positions), not empty and not a synchronized burst. The warm window ends
  // exactly on a cycle boundary (2 x lifetime), so ONE slot may be mid-respawn there —
  // hence the amount-1 lower bound.
  it("warms a long-preprocess ambient to steady state with spread ages", () => {
    const state = createParticleState(
      config({
        amount: 5,
        lifetime: 10,
        preprocess: 100,
        fixedFps: 0,
        gravity: [50, 0],
      }),
    );
    preprocessParticles(state);
    expect(activeParticleCount(state)).toBeGreaterThanOrEqual(4);
    const ages = state.particles.filter((p) => p.active).map((p) => p.time);
    // Ages spread across the cycle (continuous emitter), so the fog is mid-drift.
    const distinct = new Set(ages.map((t) => Math.round(t * 10)));
    expect(distinct.size).toBeGreaterThanOrEqual(4);
    // Gravity has visibly drifted the older particles from the point emitter.
    expect(
      Math.max(...state.particles.map((p) => Math.abs(p.x))),
    ).toBeGreaterThan(100);
  });

  it("drops the sub-step remainder so the first live frame advances normally", () => {
    const state = createParticleState(
      config({ amount: 4, lifetime: 10, preprocess: 100, fixedFps: 0 }),
    );
    preprocessParticles(state);
    // The old path passed the FULL preprocess into one simulate call: maxSteps capped
    // the work at ~33s and left the rest (~66s) in `remainder`, which then
    // fast-forwarded ~1000 sub-steps per tick for the first few live frames.
    expect(state.remainder).toBe(0);
    const before = state.cycle * 10 + state.time;
    simulateParticles(state, 1 / 30);
    const advanced = state.cycle * 10 + state.time - before;
    // One tick advances exactly ONE fixed step (1/30 s).
    expect(advanced).toBeGreaterThan(0);
    expect(advanced).toBeLessThanOrEqual(1 / 30 + 1e-9);
  });

  it("is a no-op when preprocess is zero", () => {
    const state = createParticleState(config({ amount: 4, preprocess: 0 }));
    preprocessParticles(state);
    expect(activeParticleCount(state)).toBe(0);
    expect(state.time).toBe(0);
  });
});

// `simulateParticles` reports the FIXED SUB-STEPS it executed — the unit of work it really did, and
// the denominator the runtime's opt-in profiler divides its sim milliseconds by (see
// `ParticleProfile.simSteps` and `particles-profiling.test.ts`). The point of the number is that it
// is NOT the caller's frame count: the sim runs at `fixed_fps` whatever the display does, so one
// call can execute zero steps or thirty. The function itself stays pure and clock-free.
describe("simulateParticles — executed sub-step count", () => {
  // fixedFps 0 ⇒ the 1/30 default sub-step, i.e. the rate a Godot system runs at unless it pins one.
  const stepped = (over: Partial<ParticleSpecConfig>, dt: number): number =>
    simulateParticles(
      createParticleState(config({ amount: 4, fixedFps: 0, ...over })),
      dt,
    );

  it("runs exactly one step for one sub-step of dt", () => {
    expect(stepped({}, 1 / 30)).toBe(1);
  });

  it("runs a whole second's worth of steps for a one-second dt (the sim rate, not the frame rate)", () => {
    expect(stepped({}, 1)).toBe(30);
  });

  it("runs NO steps for a dt shorter than one sub-step (the 60Hz-display case)", () => {
    // The remainder is banked, not dropped — every other display frame is what pays for a step.
    expect(stepped({}, 1 / 60)).toBe(0);
  });

  it("runs no steps at all under speedScale 0 (a paused system costs nothing to step)", () => {
    expect(stepped({ speedScale: 0 }, 1)).toBe(0);
  });

  it("follows the AUTHORED fixed_fps, not the caller's dt", () => {
    expect(stepped({ fixedFps: 1 }, 1)).toBe(1);
    // 1/4 is exact in binary, so this one is not at the mercy of the remainder's float drift (at
    // fixedFps 60 the same dt buys 59 steps, not 60 — the leftover rides `state.remainder` into the
    // next call rather than being lost).
    expect(stepped({ fixedFps: 4 }, 1)).toBe(4);
  });

  it("is bounded by maxSteps (the tab-switch/warm-up spike guard)", () => {
    expect(stepped({}, 100)).toBe(1000); // default cap
    const state = createParticleState(config({ amount: 4, fixedFps: 0 }));
    expect(simulateParticles(state, 100, 5)).toBe(5);
  });

  it("accumulates across calls: two half-steps buy exactly one step", () => {
    const state = createParticleState(config({ amount: 4, fixedFps: 0 }));
    expect(simulateParticles(state, 1 / 60)).toBe(0);
    expect(simulateParticles(state, 1 / 60)).toBe(1);
  });
});

// Flipbook frame selection. The STS2 shader flipbooks pick a frame from the particle's anim
// OFFSET (a per-particle random: `anim_offset_min/max = 0..1`, anim speed 0), so each particle
// holds ONE random cell of the sheet for its whole life; the curve-driven family instead advances
// the frame over life. Both ride the same offset/speed model — the GRID is what picks the cell.
describe("flipbook frames", () => {
  function frames(over: Partial<ParticleSpecConfig>): number[] {
    const state = createParticleState(
      config({
        amount: 16,
        lifetime: 1,
        emitting: true,
        oneShot: true,
        explosiveness: 1,
        ...over,
      }),
    );
    simulateParticles(state, 0.1);
    return state.particles.filter((p) => p.active).map((p) => p.frame);
  }

  it("holds ONE random cell per particle for a 2x2 sheet with a random anim offset", () => {
    const observed = frames({
      hframes: 2,
      vframes: 2,
      frameCount: 4,
      animOffsetMin: 0,
      animOffsetMax: 1,
      animSpeedMin: 0,
      animSpeedMax: 0,
    });
    expect(observed.length).toBeGreaterThan(0);
    // Every frame is a real cell of the 2x2 grid...
    for (const f of observed) {
      expect(Number.isInteger(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(3);
    }
    // ...and the random offset really spreads them across the sheet. An unmapped 1x1 grid pinned
    // every particle to frame 0 — i.e. drew the WHOLE sheet as one quad (the orange-square bug).
    expect(new Set(observed).size).toBeGreaterThan(1);
  });

  it("stays on frame 0 when the grid is 1x1 (no sheet)", () => {
    const observed = frames({
      hframes: 1,
      vframes: 1,
      animOffsetMin: 0,
      animOffsetMax: 1,
    });
    expect(observed.length).toBeGreaterThan(0);
    expect(new Set(observed)).toEqual(new Set([0]));
  });

  it("advances the frame over life when the flipbook plays (speed 1, looping)", () => {
    const state = createParticleState(
      config({
        amount: 1,
        lifetime: 1,
        emitting: true,
        hframes: 3,
        vframes: 2,
        frameCount: 6,
        animOffsetMin: 0,
        animOffsetMax: 0,
        animSpeedMin: 1,
        animSpeedMax: 1,
        animLoop: true,
      }),
    );
    const seen: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      simulateParticles(state, 1 / 60);
      const p = state.particles[0];
      if (p.active) seen.push(p.frame);
    }
    expect(new Set(seen).size).toBeGreaterThan(2); // really cycles through the sheet
    expect(Math.max(...seen)).toBeLessThanOrEqual(5);
  });

  it("wraps a frame INDEX past the grid back into the sheet's cells", () => {
    // frame_count > cells: Godot's `mod(progress, hframes * vframes)`. A 2x2 grid with 6 authored
    // frames must never emit cell 4/5 (which would sample outside the sheet).
    const observed = frames({
      hframes: 2,
      vframes: 2,
      frameCount: 6,
      animOffsetMin: 0,
      animOffsetMax: 1,
      animSpeedMin: 0,
      animSpeedMax: 0,
    });
    for (const f of observed) expect(f).toBeLessThanOrEqual(3);
  });
});
