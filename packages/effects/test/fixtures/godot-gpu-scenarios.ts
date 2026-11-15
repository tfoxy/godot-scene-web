// Representative GodotGpuEmitter runs for the bit-exactness test: every emission shape, flag and
// curve the port samples, both coordinate spaces, fixed and frame-delta stepping, pre-process,
// restarts, process requests and a mid-run material and setter change. Each scenario is a script
// of per-frame steps over a minimal emitter interface, so the same script drives any build of the
// emitter.

import type {
  GodotCurveTexture,
  GodotGpuEmitterConfig,
  GodotProcessMaterial,
} from "../../src/particles";

/** The emitter surface a scenario drives. */
export interface ScenarioEmitter {
  configure(config: GodotGpuEmitterConfig): void;
  setEmitting(on: boolean): void;
  restart(): void;
  requestProcess(time: number): void;
  update(frameDelta: number, time?: number): void;
  pack(out: Float32Array): number;
  activeCount(): number;
  readonly isInactive: boolean;
  readonly config: GodotGpuEmitterConfig;
}

export interface Scenario {
  name: string;
  frames: number;
  config: GodotGpuEmitterConfig;
  /** Called before frame `f`'s update; returns the frame's delta and optional shader time. */
  frame(e: ScenarioEmitter, f: number): { dt: number; time?: number };
}

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** A 1-row curve texture of `width` texels, RGBA from `fn(u)`. */
function curve(
  width: number,
  fn: (u: number) => readonly number[],
): GodotCurveTexture {
  const data = new Float32Array(width * 4);
  for (let i = 0; i < width; i++) data.set(fn(i / (width - 1)), i * 4);
  return { width, height: 1, data };
}

const ramp = curve(32, (u) => [1, 1 - u * 0.5, 0.2 + u * 0.6, 1 - u]);
const falling = curve(64, (u) => {
  const v = 1 - 0.75 * u;
  return [v, v, v, 1];
});
const bump = curve(16, (u) => {
  const v = Math.sin(u * Math.PI);
  return [v, v * 0.5, 0, 1];
});

function base(over: Partial<GodotGpuEmitterConfig>): GodotGpuEmitterConfig {
  return {
    emitting: true,
    amount: 24,
    amountRatio: 1,
    lifetime: 1.2,
    oneShot: false,
    preProcessTime: 0,
    explosiveness: 0,
    randomness: 0,
    speedScale: 1,
    fixedFps: 0,
    interpolate: true,
    fractionalDelta: true,
    localCoords: true,
    drawOrder: "index",
    interpToEnd: 0,
    emissionTransform: IDENT,
    emitterVelocity: [0, 0, 0],
    seed: 1004,
    material: {
      emissionShape: "point",
      flags: ["disable_z"],
      uniforms: {},
      curves: {},
    },
    ...over,
  };
}

/** A 2D game's ambient emitter: sphere, colour ramp, scale and alpha curves, global coordinates
 * under a moving node, frame-delta stepping with jitter. */
const ambient: GodotProcessMaterial = {
  emissionShape: "sphere",
  flags: ["disable_z"],
  uniforms: {
    direction: [0, -1, 0],
    spread: 45,
    flatness: 0,
    initial_linear_velocity_min: 10,
    initial_linear_velocity_max: 40,
    scale_min: 0.5,
    scale_max: 2,
    gravity: [0, -15, 0],
    color_value: [1, 0.8, 0.6, 1],
    hue_variation_min: -0.1,
    hue_variation_max: 0.1,
    lifetime_randomness: 0.3,
    damping_min: 2,
    damping_max: 6,
    emission_sphere_radius: 30,
    emission_shape_scale: [1, 0.5, 1],
    emission_shape_offset: [4, -2, 0],
    angle_min: 0,
    initial_angle_min: -30,
    initial_angle_max: 30,
    angular_velocity_min: -90,
    angular_velocity_max: 90,
    anim_speed_min: 0.5,
    anim_speed_max: 1,
    anim_offset_min: 0,
    anim_offset_max: 0.5,
    inherit_emitter_velocity_ratio: 0.5,
  },
  curves: { color_ramp: ramp, scale_curve: falling, alpha_curve: bump },
};

/** Turbulence, orbit, radial/tangent acceleration and their textures, fixed 30 fps, pre-process. */
const swirl: GodotProcessMaterial = {
  emissionShape: "box",
  flags: ["disable_z", "damping_as_friction"],
  turbulence: true,
  uniforms: {
    direction: [1, 0, 0],
    spread: 180,
    initial_linear_velocity_min: 5,
    initial_linear_velocity_max: 25,
    orbit_velocity_min: 0.2,
    orbit_velocity_max: 0.6,
    radial_velocity_min: -10,
    radial_velocity_max: 15,
    linear_accel_min: -5,
    linear_accel_max: 5,
    radial_accel_min: 3,
    radial_accel_max: 9,
    tangent_accel_min: -12,
    tangent_accel_max: 4,
    damping_min: 0.5,
    damping_max: 1,
    gravity: [0, 0, 0],
    emission_box_extents: [60, 20, 0],
    velocity_pivot: [5, 5, 0],
    turbulence_noise_strength: 2,
    turbulence_noise_scale: 4,
    turbulence_noise_speed: [0.1, 0.2, 0],
    turbulence_noise_speed_random: 0.3,
    turbulence_influence_min: 0.05,
    turbulence_influence_max: 0.3,
    turbulence_initial_displacement_min: -3,
    turbulence_initial_displacement_max: 3,
    scale_min: 1,
    scale_max: 1,
    color_value: [0.4, 0.7, 1, 0.8],
  },
  curves: {
    orbit_velocity_curve: bump,
    radial_velocity_curve: falling,
    linear_accel_texture: bump,
    radial_accel_texture: falling,
    tangent_accel_texture: bump,
    damping_texture: falling,
    turbulence_influence_over_life: bump,
    angle_texture: falling,
    angular_velocity_texture: bump,
  },
};

/** 3D (no disable_z): a ring, rotate_y, velocity limit, directional velocity, scale over
 * velocity, every display curve. */
const ring3d: GodotProcessMaterial = {
  emissionShape: "ring",
  flags: ["rotate_y"],
  uniforms: {
    direction: [0.3, 1, 0.2],
    spread: 25,
    flatness: 0.4,
    initial_linear_velocity_min: 20,
    initial_linear_velocity_max: 50,
    directional_velocity_min: 2,
    directional_velocity_max: 8,
    directional_velocity_global: 1,
    radial_velocity_min: 1,
    radial_velocity_max: 3,
    tangent_accel_min: 1,
    tangent_accel_max: 2,
    radial_accel_min: -1,
    radial_accel_max: 1,
    gravity: [0, -9.8, 0],
    emission_ring_radius: 40,
    emission_ring_inner_radius: 10,
    emission_ring_height: 8,
    emission_ring_cone_angle: 70,
    emission_ring_axis: [0, 0.6, 0.8],
    scale_min: 0.8,
    scale_max: 1.4,
    scale_over_velocity_min: 0,
    scale_over_velocity_max: 40,
    hue_variation_min: 0,
    hue_variation_max: 0.3,
    color_value: [1, 1, 1, 1],
    angular_velocity_min: 30,
    angular_velocity_max: 60,
  },
  curves: {
    velocity_limit_curve: curve(8, (u) => [30 - u * 20, 0, 0, 1]),
    directional_velocity_curve: curve(8, (u) => [u, 1 - u, 0.5, 1]),
    scale_over_velocity_curve: curve(8, (u) => [1 + u, 1, 1 - u * 0.5, 1]),
    hue_rot_curve: bump,
    animation_offset_curve: falling,
    animation_speed_curve: bump,
    emission_curve: bump,
    color_initial_ramp: ramp,
  },
};

/** align_y_to_velocity on a sphere surface, one-shot explosive bursts, restarts, process requests,
 * amount ratio, interp_to_end, lifetime draw order. */
const burst: GodotProcessMaterial = {
  emissionShape: "sphere_surface",
  flags: ["disable_z", "align_y_to_velocity"],
  uniforms: {
    direction: [0, 1, 0],
    spread: 180,
    initial_linear_velocity_min: 50,
    initial_linear_velocity_max: 120,
    gravity: [0, 98, 0],
    emission_sphere_radius: 12,
    scale_min: 2,
    scale_max: 3,
    damping_min: 10,
    damping_max: 30,
    color_value: [1, 0.5, 0.25, 1],
    radial_velocity_min: 0,
    radial_velocity_max: 0,
  },
  curves: { color_ramp: ramp },
};

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "ambient-global-moving",
    frames: 150,
    config: base({
      amount: 40,
      lifetime: 1.6,
      randomness: 0.5,
      localCoords: false,
      drawOrder: "lifetime",
      emissionTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 200, 120, 0],
      emitterVelocity: [3, -1, 0],
      material: ambient,
    }),
    frame(e, f) {
      if (f % 7 === 0) {
        const x = 200 + Math.sin(f / 10) * 40;
        const c = Math.cos(f / 50);
        const s = Math.sin(f / 50);
        e.configure({
          ...e.config,
          emissionTransform: [c, -s, 0, s, c, 0, 0, 0, 1, x, 120, 0],
        });
      }
      return { dt: f % 5 === 0 ? 1 / 30 : 1 / 60 + (f % 3) * 0.0011 };
    },
  },
  {
    name: "swirl-turbulence-fixed30-preprocess",
    frames: 90,
    config: base({
      amount: 20,
      lifetime: 2,
      fixedFps: 30,
      preProcessTime: 0.5,
      explosiveness: 0.3,
      randomness: 1,
      drawOrder: "lifetime",
      material: swirl,
      seed: 77,
    }),
    frame(e, f) {
      if (f === 45) e.configure({ ...e.config, speedScale: 1.7 });
      return { dt: 1 / 60, time: 12.5 + f / 60 };
    },
  },
  {
    name: "ring3d-curves-local",
    frames: 100,
    config: base({
      amount: 30,
      lifetime: 1,
      interpolate: false,
      fractionalDelta: false,
      material: ring3d,
      seed: 31337,
      drawOrder: "reverse_lifetime",
    }),
    frame(e, f) {
      if (f === 60)
        e.configure({
          ...e.config,
          material: {
            ...ring3d,
            uniforms: { ...ring3d.uniforms, emission_ring_radius: 25 },
          },
        });
      return { dt: 1 / 60 };
    },
  },
  {
    name: "burst-oneshot-restart-request",
    frames: 160,
    config: base({
      emitting: false,
      amount: 16,
      lifetime: 0.6,
      oneShot: true,
      explosiveness: 1,
      amountRatio: 0.6,
      fixedFps: 60,
      drawOrder: "lifetime",
      material: burst,
      seed: 5,
    }),
    frame(e, f) {
      if (f === 3 || f === 90) {
        e.restart();
        e.setEmitting(true);
      }
      if (f === 40) e.requestProcess(0.2);
      if (f === 100) e.configure({ ...e.config, interpToEnd: 0.5 });
      if (f === 130) e.configure({ ...e.config, amount: 9 });
      if (f === 135) {
        e.restart();
        e.setEmitting(true);
      }
      return { dt: f % 11 === 0 ? 0.15 : 1 / 60 };
    },
  },
];

/** FNV-1a over the bits of every frame's packed instances and active count. */
export function runScenarioDigest(
  s: Scenario,
  make: (c: GodotGpuEmitterConfig) => ScenarioEmitter,
): string {
  const e = make(s.config);
  let h = 0x811c9dc5;
  const mixWord = (w: number) => {
    for (let k = 0; k < 4; k++) {
      h ^= (w >>> (8 * k)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  let out = new Float32Array(0);
  for (let f = 0; f < s.frames; f++) {
    const { dt, time } = s.frame(e, f);
    if (time === undefined) e.update(dt);
    else e.update(dt, time);
    const floats = e.config.amount * 16;
    if (out.length !== floats) out = new Float32Array(floats);
    e.pack(out);
    const bits = new Uint32Array(out.buffer, out.byteOffset, out.length);
    for (let i = 0; i < bits.length; i++) mixWord(bits[i]);
    mixWord(e.activeCount());
    mixWord(e.isInactive ? 1 : 0);
  }
  return h.toString(16).padStart(8, "0");
}
