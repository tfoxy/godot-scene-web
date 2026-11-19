// J1: a burst (the preprocess after a clear, a process request) spread over `update` calls by a
// yield predicate ends in exactly the state the same calls make without one: every call made while
// the emitter settles is queued and replayed in order. Compared on the packed instances, bit for bit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GODOT_GPU_INSTANCE_FLOATS,
  GodotGpuEmitter,
  type GodotGpuEmitterConfig,
} from "../src/particles";

function config(
  over: Partial<GodotGpuEmitterConfig> = {},
): GodotGpuEmitterConfig {
  return {
    emitting: true,
    amount: 9,
    amountRatio: 1,
    lifetime: 2,
    oneShot: false,
    preProcessTime: 3,
    explosiveness: 0,
    randomness: 0.4,
    speedScale: 1,
    fixedFps: 0,
    interpolate: true,
    fractionalDelta: true,
    localCoords: false,
    drawOrder: "index",
    interpToEnd: 0,
    emissionTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 40, 30, 0],
    emitterVelocity: [0, 0, 0],
    seed: 77,
    material: {
      emissionShape: "point",
      flags: ["disable_z"],
      uniforms: {
        direction: [1, 0, 0],
        spread: 45,
        initial_linear_velocity_min: 20,
        initial_linear_velocity_max: 50,
        scale_min: 2,
        scale_max: 4,
        gravity: [0, 15, 0],
        color_value: [1, 0.5, 0.25, 1],
        damping_min: 1,
        damping_max: 3,
      },
      curves: {},
    },
    ...over,
  };
}

function packed(e: GodotGpuEmitter): Float32Array {
  const out = new Float32Array(e.config.amount * GODOT_GPU_INSTANCE_FLOATS);
  e.pack(out);
  return out;
}

/** A yield predicate that answers true after every `n` checks (a pass runs between checks). */
function every(n: number): () => boolean {
  let k = 0;
  return () => ++k % n === 0;
}

type Call = (e: GodotGpuEmitter, yieldNow?: () => boolean) => void;

/** The calls a client makes over frames: steps by the host's time, setters between them. */
function script(): Call[] {
  const calls: Call[] = [];
  let t = 10;
  const step = (dt: number): Call => {
    t += dt;
    const at = t;
    return (e, y) => e.update(dt, at, y);
  };
  for (let i = 0; i < 6; i++) calls.push(step(1 / 60));
  calls.push((e) => e.configure({ ...e.config, speedScale: 1.5 }));
  calls.push(step(1 / 30));
  calls.push((e) => e.requestProcess(1.2));
  calls.push(step(1 / 60));
  calls.push((e) => e.setEmitting(false));
  for (let i = 0; i < 4; i++) calls.push(step(1 / 60));
  calls.push((e) => e.restart());
  calls.push((e) => e.setEmitting(true));
  for (let i = 0; i < 12; i++) calls.push(step(1 / 60));
  return calls;
}

describe("Godot GPU particles: bursts spread over updates (J1)", () => {
  // Keep the full path's queue/replay contract covered even for otherwise eligible configs.
  beforeEach(() => {
    vi.spyOn(
      GodotGpuEmitter.prototype as unknown as { trySkipBurst(): boolean },
      "trySkipBurst",
    ).mockReturnValue(false);
  });
  afterEach(() => vi.restoreAllMocks());

  it("ends bit-identical to the unspread run, whatever the slice", () => {
    for (const fixedFps of [0, 30]) {
      for (const n of [1, 2, 7, 40]) {
        const spread = new GodotGpuEmitter(config({ fixedFps }));
        const plain = new GodotGpuEmitter(config({ fixedFps }));
        const y = every(n);
        let settled = 0;
        for (const c of script()) {
          c(spread, y);
          c(plain);
          if (spread.settling) settled++;
        }
        expect(settled, `slice ${n}: no burst was spread`).toBeGreaterThan(0);
        // A burst still settling at the end finishes with one more (unbounded) step, given to both.
        spread.update(1 / 60, undefined);
        plain.update(1 / 60, undefined);
        expect(spread.settling).toBe(false);
        expect(Array.from(packed(spread))).toEqual(Array.from(packed(plain)));
        expect(spread.stats).toEqual(plain.stats);
      }
    }
  });

  it("is settling from the preprocess's first yield until its last pass, then draws as unspread", () => {
    const spread = new GodotGpuEmitter(config());
    const plain = new GodotGpuEmitter(config());
    spread.update(1 / 60, 1, () => true);
    expect(spread.settling).toBe(true);
    // 3 s at 30 passes/s is 91 passes; one pass per update while the predicate says yield.
    let updates = 1;
    while (spread.settling && updates < 120) {
      spread.update(1 / 60, 1 + updates / 60, () => true);
      updates++;
    }
    // Bounded replay can consume one queued update per yield. Stop adding frames so it drains.
    let advances = 0;
    while (spread.settling) {
      spread.advance(() => true);
      expect(++advances).toBeLessThan(1000);
    }
    expect(updates).toBeGreaterThan(80);
    for (let i = 0; i < updates; i++) plain.update(1 / 60, 1 + i / 60);
    expect(Array.from(packed(spread))).toEqual(Array.from(packed(plain)));
  });

  it("advances with no further update (an idle host) to the state of the unspread run", () => {
    const spread = new GodotGpuEmitter(config());
    const plain = new GodotGpuEmitter(config());
    spread.update(1 / 60, 1, () => true);
    plain.update(1 / 60, 1);
    expect(spread.settling).toBe(true);
    let advances = 0;
    while (spread.settling && advances < 1000) {
      spread.advance(every(5));
      advances++;
    }
    expect(advances).toBeGreaterThan(10);
    expect(Array.from(packed(spread))).toEqual(Array.from(packed(plain)));
    expect(spread.stats).toEqual(plain.stats);
    // Not settling: advance does nothing.
    spread.advance(() => true);
    expect(Array.from(packed(spread))).toEqual(Array.from(packed(plain)));
  });

  it("without a predicate the burst runs in the call, as before", () => {
    const e = new GodotGpuEmitter(config());
    e.update(1 / 60, 1);
    expect(e.settling).toBe(false);
    expect(e.stats.steps).toBe(92); // 91 preprocess passes and the frame's own
  });
});
