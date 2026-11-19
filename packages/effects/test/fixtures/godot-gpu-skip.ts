import {
  GODOT_GPU_INSTANCE_FLOATS,
  GodotGpuEmitter,
  type GodotGpuEmitterConfig,
} from "../../src/particles";

export function burstConfig(
  over: Partial<GodotGpuEmitterConfig> = {},
): GodotGpuEmitterConfig {
  return {
    emitting: true,
    amount: 40,
    amountRatio: 1,
    lifetime: 2,
    oneShot: false,
    preProcessTime: 400,
    explosiveness: 0,
    randomness: 0,
    speedScale: 1.3,
    fixedFps: 30,
    interpolate: true,
    fractionalDelta: true,
    localCoords: false,
    drawOrder: "lifetime",
    interpToEnd: 0,
    emissionTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 40, 30, 0],
    emitterVelocity: [2, 3, 0],
    seed: 77,
    material: {
      emissionShape: "box",
      flags: ["disable_z"],
      uniforms: {
        emission_box_extents: [151, 151, 0],
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

/** Reference entry point: a test-only override keeps the original full simulation available. */
export function fullEmitter(c: GodotGpuEmitterConfig): GodotGpuEmitter {
  const emitter = new GodotGpuEmitter(c);
  Reflect.set(emitter, "trySkipBurst", () => false);
  return emitter;
}

export function skipEmitter(c: GodotGpuEmitterConfig): GodotGpuEmitter {
  return new GodotGpuEmitter(c);
}

export function packedBytes(e: GodotGpuEmitter): Uint8Array {
  const out = new Float32Array(e.config.amount * GODOT_GPU_INSTANCE_FLOATS);
  e.pack(out);
  return new Uint8Array(out.buffer);
}

export function clockState(e: GodotGpuEmitter): unknown {
  const state = e as unknown as Record<string, unknown>;
  return Object.fromEntries(
    [
      "phase",
      "cycle",
      "clear",
      "inactive",
      "inactiveTime",
      "frameRemainder",
      "restartRequest",
      "requestTime",
      "time",
      "emitting",
      "stats",
    ].map((key) => [key, state[key]]),
  );
}
