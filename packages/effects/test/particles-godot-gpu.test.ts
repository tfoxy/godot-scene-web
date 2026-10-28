import { describe, expect, it } from "vitest";
import {
  GODOT_GPU_INSTANCE_FLOATS,
  GodotGpuEmitter,
  type GodotGpuEmitterConfig,
  type GodotProcessMaterial,
  godotGpuApproximateFeatures,
  godotParticleHash,
  godotRandFromSeed,
} from "../src/particles";

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function material(
  over: Partial<GodotProcessMaterial> = {},
): GodotProcessMaterial {
  return {
    emissionShape: "point",
    flags: ["disable_z"],
    uniforms: {
      direction: [1, 0, 0],
      spread: 30,
      initial_linear_velocity_min: 30,
      initial_linear_velocity_max: 60,
      scale_min: 3,
      scale_max: 3,
      gravity: [0, 20, 0],
      color_value: [1, 1, 1, 1],
    },
    curves: {},
    ...over,
  };
}

function emitter(
  over: Partial<GodotGpuEmitterConfig> = {},
): GodotGpuEmitterConfig {
  return {
    emitting: false,
    amount: 7,
    amountRatio: 1,
    lifetime: 1,
    oneShot: false,
    preProcessTime: 0,
    explosiveness: 0,
    randomness: 0,
    speedScale: 1,
    fixedFps: 30,
    interpolate: true,
    fractionalDelta: true,
    localCoords: true,
    drawOrder: "lifetime",
    interpToEnd: 0,
    emissionTransform: IDENT,
    emitterVelocity: [0, 0, 0],
    seed: 1004,
    material: material(),
    ...over,
  };
}

function frames(e: GodotGpuEmitter, n: number): void {
  for (let i = 0; i < n; i++) e.update(1 / 60);
}

describe("Godot GPU particles: the generated shader's RNG", () => {
  it("hashes and draws as the generated GLSL does (uint and int32 arithmetic)", () => {
    // Reference values from an independent integer implementation of the generated code.
    expect(godotParticleHash(1)).toBe(824515495);
    expect(godotParticleHash(1002)).toBe(1834024693);
    expect(godotParticleHash(3735928559)).toBe(1398006505);
    const seed = { v: godotParticleHash(1 + 1 + 1004) };
    const got = [
      godotRandFromSeed(seed),
      godotRandFromSeed(seed),
      godotRandFromSeed(seed),
    ];
    expect(got[0]).toBeCloseTo(0.7175860227359426, 12);
    expect(got[1]).toBeCloseTo(0.508567940794995, 12);
    expect(got[2]).toBeCloseTo(0.5892118715190356, 12);
  });
});

describe("GodotGpuEmitter (gl_compatibility's update_particles)", () => {
  it("is deterministic for a seed and differs for another", () => {
    const run = (seed: number) => {
      const e = new GodotGpuEmitter(emitter({ seed, emitting: true }));
      frames(e, 20);
      const out = new Float32Array(7 * GODOT_GPU_INSTANCE_FLOATS);
      e.pack(out);
      return Array.from(out);
    };
    expect(run(1004)).toEqual(run(1004));
    expect(run(1004)).not.toEqual(run(1005));
  });

  it("a one-shot explosive burst lights every particle, then goes dark one lifetime later", () => {
    const e = new GodotGpuEmitter(
      emitter({ oneShot: true, explosiveness: 1, emitting: false }),
    );
    frames(e, 10);
    expect(e.isInactive).toBe(true);
    e.restart();
    e.setEmitting(true);
    frames(e, 2);
    expect(e.activeCount()).toBe(7);
    frames(e, 50);
    expect(e.activeCount()).toBe(7);
    frames(e, 30);
    expect(e.activeCount()).toBe(0);
    // emitting cleared by the one-shot's end; inactive after 1.2 lifetimes more
    frames(e, 90);
    expect(e.isInactive).toBe(true);
  });

  it("a continuous emitter holds its amount in flight, inside its emission shape at birth", () => {
    const e = new GodotGpuEmitter(
      emitter({
        emitting: true,
        amount: 3,
        material: material({
          emissionShape: "box",
          uniforms: {
            ...material().uniforms,
            emission_box_extents: [40, 20, 0],
            initial_linear_velocity_min: 0,
            initial_linear_velocity_max: 0,
            gravity: [0, 0, 0],
          },
        }),
      }),
    );
    frames(e, 90);
    expect(e.activeCount()).toBe(3);
    const out = new Float32Array(3 * GODOT_GPU_INSTANCE_FLOATS);
    e.pack(out);
    for (let i = 0; i < 3; i++) {
      const o = i * GODOT_GPU_INSTANCE_FLOATS;
      expect(Math.abs(out[o + 3])).toBeLessThanOrEqual(40);
      expect(Math.abs(out[o + 7])).toBeLessThanOrEqual(20);
      // scale 3, rotation 0: X = (3, 0), Y = (0, 3)
      expect(out[o]).toBeCloseTo(3, 5);
      expect(out[o + 5]).toBeCloseTo(3, 5);
      // custom.y is the age over the lifetime, custom.w the particle's lifetime ratio
      expect(out[o + 13]).toBeGreaterThan(0);
      expect(out[o + 15]).toBe(1);
    }
  });

  it("global coordinates draw through the inverse of the current emission transform", () => {
    const at = (x: number) => [1, 0, 0, 0, 1, 0, 0, 0, 1, x, 0, 0];
    const cfg = emitter({
      emitting: true,
      amount: 1,
      localCoords: false,
      emissionTransform: at(100),
      material: material({
        uniforms: {
          ...material().uniforms,
          initial_linear_velocity_min: 0,
          initial_linear_velocity_max: 0,
          gravity: [0, 0, 0],
        },
      }),
    });
    const e = new GodotGpuEmitter(cfg);
    frames(e, 2);
    const out = new Float32Array(GODOT_GPU_INSTANCE_FLOATS);
    e.pack(out);
    expect(out[3]).toBeCloseTo(0, 5);
    e.configure({ ...cfg, emissionTransform: at(130) });
    e.pack(out);
    // born at x = 100 in the world; the node moved to 130, so it draws at -30 locally
    expect(out[3]).toBeCloseTo(-30, 5);
  });

  it("samples curve textures: a scale curve shrinks the particle over its life", () => {
    const width = 64;
    const data = new Float32Array(width * 4);
    for (let i = 0; i < width; i++) {
      const v = 1 - (0.75 * i) / (width - 1);
      data.set([v, v, v, 1], i * 4);
    }
    const e = new GodotGpuEmitter(
      emitter({
        emitting: true,
        amount: 1,
        explosiveness: 1,
        material: material({
          curves: { scale_curve: { width, height: 1, data } },
        }),
      }),
    );
    const out = new Float32Array(GODOT_GPU_INSTANCE_FLOATS);
    frames(e, 4);
    e.pack(out);
    const early = Math.hypot(out[0], out[4]);
    frames(e, 50);
    e.pack(out);
    const late = Math.hypot(out[0], out[4]);
    expect(early).toBeGreaterThan(2.8);
    expect(late).toBeLessThan(early * 0.5);
  });

  it("an emitter that is not emitting draws nothing once inactive, and types what it does not model", () => {
    const e = new GodotGpuEmitter(emitter({ emitting: false }));
    frames(e, 3);
    expect(e.isInactive).toBe(true);
    expect(
      godotGpuApproximateFeatures(
        emitter({ material: material({ turbulence: true }) }),
      ),
    ).toEqual([]);
    expect(
      godotGpuApproximateFeatures(emitter({ drawOrder: "view_depth" })),
    ).toEqual(["draw-order-view-depth"]);
  });

  it("turbulence bends the paths through the curl noise, deterministically at a given time", () => {
    const turb = material({
      turbulence: true,
      uniforms: {
        ...material().uniforms,
        turbulence_noise_strength: 2,
        turbulence_noise_scale: 4,
        turbulence_influence_min: 0.1,
        turbulence_influence_max: 0.1,
        turbulence_noise_speed: [0, 0, 0],
        turbulence_noise_speed_random: 0.2,
      },
    });
    const run = (m: GodotProcessMaterial) => {
      const e = new GodotGpuEmitter(
        emitter({ emitting: true, amount: 4, material: m }),
      );
      for (let i = 1; i <= 30; i++) e.update(1 / 60, i / 60);
      const out = new Float32Array(4 * GODOT_GPU_INSTANCE_FLOATS);
      e.pack(out);
      return Array.from(out);
    };
    expect(run(turb)).toEqual(run(turb));
    expect(run(turb)).not.toEqual(run(material()));
    expect(run(turb).every(Number.isFinite)).toBe(true);
  });
});
