// Godot GPU particles on the CPU, with Godot's own RNG: a port of what Godot 4.5's
// gl_compatibility renderer does with one `GPUParticles2D` emitter whose process material is a
// `ParticleProcessMaterial`.
//
//   - the emitter's clock, cycles, restarts, pre-process, fixed-fps stepping and inactivity
//     (drivers/gles3/storage/particles_storage.cpp `update_particles`, `_particles_process`);
//   - the per-particle restart test (drivers/gles3/shaders/particles.glsl `main`);
//   - the material's `start()` and `process()` exactly as `ParticleProcessMaterial::_update_shader`
//     generates them (scene/resources/particle_process_material.cpp), in the same random-draw
//     order: `alt_seed = hash(NUMBER + 1 + RANDOM_SEED)` then `rand_from_seed` per parameter, so a
//     particle's spawn values are the host GPU's own (to float precision);
//   - the instance copy (drivers/gles3/shaders/particles_copy.glsl): inactive particles collapse,
//     `interpolate` adds `velocity * frame_remainder`, global coordinates come back through the
//     inverse emission transform, `lifetime` draw order rotates at the newest particle.
//
// This is the "Godot-RNG mode" of this package's particles (the CPUParticles2D-shaped
// `simulateParticles` keeps its own LCG and its "visually plausible" bar): the simulation is the
// engine's, but its pixels are still declared approximate, because the host's GPU evaluates the
// same formulas in its own float precision (turbulence's curl noise, a hash of `fract`s, most of
// all). Not modelled (each reported by `godotGpuApproximateFeatures`, so a caller can type them):
// attractors and collision, sub-emitters and `particles_emit` (gl_compatibility ignores both:
// particles_storage.cpp:370-378), trails (the same renderer draws none), the
// `points`/`directed_points` emission textures, and `view_depth` / `reverse_lifetime` sorting
// (drawn in index / reversed lifetime order).
//
// Pure, DOM-free and GL-free: a caller steps it with the host's frame delta and packs the result
// into a 2D multimesh-layout instance buffer (`packGodotGpuInstances`). The per-particle pass
// runs every frame for every emitter, so it allocates nothing and reads the material through
// fields resolved once per configuration; it is bit-identical to the shader as written (same
// float64 operations, same operand order), which `test/particles-godot-gpu-digest.test.ts` pins.

/** A sampled curve or gradient texture: `width` x `height` texels of RGBA floats, row-major. */
export interface GodotCurveTexture {
  width: number;
  height: number;
  /** RGBA per texel (`4 * width * height` values), as stored (not clamped). */
  data: Float32Array | readonly number[];
}

/** The `ParticleProcessMaterial` as its generated shader sees it. */
export interface GodotProcessMaterial {
  /** `MaterialKey.emission_shape` (render-stream-12.md's builtin spelling). */
  emissionShape:
    | "point"
    | "sphere"
    | "sphere_surface"
    | "box"
    | "points"
    | "directed_points"
    | "ring";
  /** `particle_flags` set: `align_y_to_velocity`, `rotate_y`, `disable_z`, `damping_as_friction`. */
  flags: readonly string[];
  /** Turbulence on (the key's `turbulence`): the generated curl noise at the shader's `TIME`. */
  turbulence?: boolean;
  /** Uniform values by the generated shader's uniform name (scalars or vectors). */
  uniforms: Readonly<Record<string, number | readonly number[]>>;
  /** Sampler uniforms by name (`scale_curve`, `color_ramp`, ...): only the ones the key compiles
   * in should be listed; a listed sampler is sampled, an absent one is the shader's no-texture
   * path. */
  curves: Readonly<Record<string, GodotCurveTexture>>;
}

/** The emitter's RenderingServer state (`particles_set_*`). */
export interface GodotGpuEmitterConfig {
  /** `particles_set_emitting` at creation (later changes go through `setEmitting`). */
  emitting: boolean;
  amount: number;
  amountRatio: number;
  lifetime: number;
  oneShot: boolean;
  preProcessTime: number;
  explosiveness: number;
  randomness: number;
  speedScale: number;
  /** 0: one process step per frame of the frame's delta. */
  fixedFps: number;
  interpolate: boolean;
  fractionalDelta: boolean;
  localCoords: boolean;
  drawOrder: "index" | "lifetime" | "reverse_lifetime" | "view_depth";
  interpToEnd: number;
  /** `Transform3D` in memory order: `basis.rows[0..2]` (xyz each), then the origin. */
  emissionTransform: readonly number[];
  emitterVelocity: readonly number[];
  seed: number;
  material: GodotProcessMaterial;
}

/** One particle's process-buffer state (particles.glsl's attributes). */
interface GpuParticle {
  active: boolean;
  /** `cycle << PARTICLE_FRAME_SHIFT` as stored in the flags (the high 16 bits). */
  cycle: number;
  /** TRANSFORM columns: x, y, z axes and origin (3 each). */
  xform: Float64Array;
  velocity: Float64Array;
  color: Float64Array;
  custom: Float64Array;
  /** The spawn values the shader re-derives each pass (`INIT_*`), cached for `initHash`. */
  init: Float64Array;
  /** The seed hash `init` was drawn from (-1: none). */
  initHash: number;
  /** The emitter's material epoch `init` was drawn under. */
  initEpoch: number;
}

// The generated shader's own `float pi = 3.14159;` (not Math.PI: the angles are Godot's).
// biome-ignore lint/suspicious/noApproximativeNumericConstant: the engine's constant, verbatim
const PI_SHADER = 3.14159;
const FRAME_MASK = 0xffff;

// ------------------------------------------------------------------- the generated random helpers

/** The generated shader's `hash(uint)`. */
export function godotParticleHash(x: number): number {
  let v = x >>> 0;
  v = Math.imul((v >>> 16) ^ v, 73244475) >>> 0;
  v = Math.imul((v >>> 16) ^ v, 73244475) >>> 0;
  return ((v >>> 16) ^ v) >>> 0;
}

/** The generated shader's `rand_from_seed(inout uint)`: advances `seed.v`, returns [0, 1]. */
export function godotRandFromSeed(seed: { v: number }): number {
  let s = seed.v | 0;
  if (s === 0) s = 305420679;
  const k = Math.trunc(s / 127773);
  s = 16807 * (s - k * 127773) - 2836 * k;
  if (s < 0) s += 2147483647;
  seed.v = s >>> 0;
  return (seed.v % 65536) / 65535;
}

function randM1P1(seed: { v: number }): number {
  return godotRandFromSeed(seed) * 2 - 1;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ------------------------------------------------------------------------- turbulence's noise
// The generated `grad`, `noise`, `noise_3x` and `curl_3d` (particle_process_material.cpp), in
// float32 where the hash lives (`fract` of a product by 2365.95 is where precision shows). Scalar
// arguments and module scratch keep the 18 `noise` calls per sample allocation-free; every
// expression keeps the generated code's operand order.

const f32 = Math.fround;

function fract(x: number): number {
  return f32(x - Math.floor(x));
}

const GRAD_Q = new Float64Array(4);
const GRAD = new Float64Array(4);

/** `grad(p)` into `GRAD`. */
function grad(p0: number, p1: number, p2: number, p3: number): void {
  const q = GRAD_Q;
  q[0] = fract(
    f32(p0 * 0.143081 + p1 * 0.001724 + p2 * 0.280166 + p3 * 0.262771),
  );
  q[1] = fract(
    f32(p0 * 0.645401 + p1 * -0.047791 + p2 * -0.146698 + p3 * 0.595016),
  );
  q[2] = fract(
    f32(p0 * -0.499665 + p1 * -0.095734 + p2 * 0.425674 + p3 * -0.207367),
  );
  q[3] = fract(
    f32(p0 * -0.013596 + p1 * -0.848588 + p2 * 0.423736 + p3 * 0.17044),
  );
  for (let i = 0; i < 4; i++)
    GRAD[i] = fract(f32(f32(q[i] * q[(i + 1) & 3]) * 2365.952041)) * 2 - 1;
}

const NOISE_R = new Float64Array(16);

function noise4(c0: number, c1: number, c2: number, c3: number): number {
  const s = c0 * -0.1666667 + c1 * -0.1666667 + c2 * -0.1666667 + c3 * -0.5;
  const k0 = c0 + s;
  const k1 = c1 + s;
  const k2 = c2 + s;
  const k3 = (c0 + c1 + c2 + c3) * 0.5;
  const b0 = Math.floor(k0);
  const b1 = Math.floor(k1);
  const b2 = Math.floor(k2);
  const b3 = Math.floor(k3);
  const d0 = k0 - b0;
  const d1 = k1 - b1;
  const d2 = k2 - b2;
  const d3 = k3 - b3;
  const r = NOISE_R;
  const g = GRAD;
  // Corner k is (k & 1, k >> 1 & 1, k >> 2 & 1, k >> 3 & 1): r is indexed x + 2y + 4z + 8w.
  for (let k = 0; k < 16; k++) {
    const x = k & 1;
    const y = (k >> 1) & 1;
    const z = (k >> 2) & 1;
    const w = (k >> 3) & 1;
    grad(b0 + x, b1 + y, b2 + z, b3 + w);
    r[k] =
      (d0 - x) * g[0] + (d1 - y) * g[1] + (d2 - z) * g[2] + (d3 - w) * g[3];
  }
  const f0 = d0 * d0 * d0 * (10 + d0 * (-15 + d0 * 6));
  const f1 = d1 * d1 * d1 * (10 + d1 * (-15 + d1 * 6));
  const f2 = d2 * d2 * d2 * (10 + d2 * (-15 + d2 * 6));
  const f3 = d3 * d3 * d3 * (10 + d3 * (-15 + d3 * 6));
  // Mix over w, then z, then y, then x.
  const w0 = mix(r[0], r[8], f3);
  const w1 = mix(r[1], r[9], f3);
  const w2 = mix(r[2], r[10], f3);
  const w3 = mix(r[3], r[11], f3);
  const w4 = mix(r[4], r[12], f3);
  const w5 = mix(r[5], r[13], f3);
  const w6 = mix(r[6], r[14], f3);
  const w7 = mix(r[7], r[15], f3);
  const z0 = mix(w0, w4, f2);
  const z1 = mix(w1, w5, f2);
  const z2 = mix(w2, w6, f2);
  const z3 = mix(w3, w7, f2);
  return mix(mix(z0, z2, f1), mix(z1, z3, f1), f0);
}

const NOISE3X_OFFSET = 1.7320508 * 2048.333333;

/** `noise_3x(p)` into `out[at..at + 2]`. */
function noise3x(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  out: Float64Array,
  at: number,
): void {
  out[at] = noise4(p0, p1, p2, p3);
  out[at + 1] = noise4(p0, p1, p2, p3 + NOISE3X_OFFSET);
  out[at + 2] = noise4(p0, p1, p2, p3 - NOISE3X_OFFSET);
}

/** The six `noise_3x` samples of `curl_3d`: x0, x1, y0, y1, z0, z1 (3 each). */
const CURL = new Float64Array(18);

function curl3d(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  c: number,
  out: Float64Array,
): void {
  const e = 0.001 + c;
  const n = CURL;
  noise3x(p0 + -1 * e, p1, p2, p3, n, 0);
  noise3x(p0 + 1 * e, p1, p2, p3, n, 3);
  noise3x(p0, p1 + -1 * e, p2, p3, n, 6);
  noise3x(p0, p1 + 1 * e, p2, p3, n, 9);
  noise3x(p0, p1, p2 + -1 * e, p3, n, 12);
  noise3x(p0, p1, p2 + 1 * e, p3, n, 15);
  const x = n[9 + 2] - n[6 + 2] - (n[15 + 1] - n[12 + 1]);
  const y = n[15] - n[12] - (n[3 + 2] - n[0 + 2]);
  const z = n[3 + 1] - n[0 + 1] - (n[9] - n[6]);
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
}

// ------------------------------------------------------------------------------- the sampler

/** `texture(sampler, uv)` with linear filtering and clamp-to-edge (`repeat_disable`). */
function sampleCurve(
  t: GodotCurveTexture,
  u: number,
  v: number,
  out: Float64Array,
): void {
  const w = Math.max(1, t.width);
  const h = Math.max(1, t.height);
  const fx = Math.min(Math.max(u * w - 0.5, 0), w - 1);
  const fy = Math.min(Math.max(v * h - 0.5, 0), h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const d = t.data;
  for (let c = 0; c < 4; c++) {
    const a = d[(y0 * w + x0) * 4 + c] ?? 0;
    const b = d[(y0 * w + x1) * 4 + c] ?? 0;
    const e = d[(y1 * w + x0) * 4 + c] ?? 0;
    const f = d[(y1 * w + x1) * 4 + c] ?? 0;
    out[c] = mix(mix(a, b, ax), mix(e, f, ax), ay);
  }
}

const TEX = new Float64Array(4);

/** `texture(sampler, vec2(t))`, channel `c`. */
function tex(s: GodotCurveTexture, t: number, c = 0): number {
  sampleCurve(s, t, t, TEX);
  return TEX[c];
}

// ------------------------------------------------------------------------------- the material

type Vec3 = readonly [number, number, number];

/**
 * The material's uniforms, samplers and uniform-only derived values, resolved once per
 * configuration (`GodotGpuEmitter.configure` builds a new one when the material object changes):
 * the per-particle shader reads fields, never names. A material is therefore read as immutable;
 * change one by passing a new object.
 */
class Material {
  readonly shape: GodotProcessMaterial["emissionShape"];
  readonly turbulence: boolean;
  readonly disableZ: boolean;
  readonly alignY: boolean;
  readonly rotateY: boolean;
  readonly friction: boolean;

  // Display.
  readonly scaleMin: number;
  readonly scaleMax: number;
  readonly hueMin: number;
  readonly hueMax: number;
  readonly animSpeedMin: number;
  readonly animSpeedMax: number;
  readonly animOffsetMin: number;
  readonly animOffsetMax: number;
  readonly lifetimeRandomness: number;
  readonly colorValue: readonly [number, number, number, number];
  // Dynamics.
  readonly angleMin: number;
  readonly angleMax: number;
  readonly angularVelocityMin: number;
  readonly angularVelocityMax: number;
  readonly linearVelocityMin: number;
  readonly linearVelocityMax: number;
  readonly directionalVelocityMin: number;
  readonly directionalVelocityMax: number;
  readonly radialVelocityMin: number;
  readonly radialVelocityMax: number;
  readonly orbitVelocityMin: number;
  readonly orbitVelocityMax: number;
  readonly turbInfluenceMin: number;
  readonly turbInfluenceMax: number;
  // Physical.
  readonly linearAccelMin: number;
  readonly linearAccelMax: number;
  readonly radialAccelMin: number;
  readonly radialAccelMax: number;
  readonly tangentAccelMin: number;
  readonly tangentAccelMax: number;
  readonly dampingMin: number;
  readonly dampingMax: number;
  // Emission shape.
  readonly sphereRadius: number;
  readonly boxExtents: Vec3;
  readonly shapeScale: Vec3;
  readonly shapeOffset: Vec3;
  readonly ringRadius: number;
  readonly ringInner: number;
  readonly ringHeight: number;
  readonly ringTop: number;
  readonly ringSkew: number;
  readonly ringAxis: Vec3;
  readonly ringOrtho: Vec3;
  // Direction and spread.
  readonly spread: number;
  readonly flatness: number;
  /** `disable_z`'s base angle of `direction`. */
  readonly directionAngle: number;
  /** The 3D spread's frame around `direction`: normal, binormal, `cross(binormal, normal)`. */
  readonly spreadN: Vec3;
  readonly spreadBi: Vec3;
  readonly spreadNm: Vec3;
  // Process.
  readonly inheritVelocityRatio: number;
  readonly velocityPivot: Vec3;
  readonly directionalVelocityGlobal: boolean;
  readonly gravity: Vec3;
  readonly gravityLength: number;
  readonly scaleOverVelocityRange: number;
  readonly turbDisplacementMin: number;
  readonly turbDisplacementMax: number;
  // Turbulence's `get_noise_direction`.
  readonly noiseScale: number;
  readonly noiseSpeed: Vec3;
  readonly noiseSpeedRandom: number;
  readonly noiseContrast: number;
  readonly noiseGain: number;

  // Samplers (undefined: the shader's no-texture path).
  readonly colorInitialRamp: GodotCurveTexture | undefined;
  readonly scaleCurve: GodotCurveTexture | undefined;
  readonly hueRotCurve: GodotCurveTexture | undefined;
  readonly animationOffsetCurve: GodotCurveTexture | undefined;
  readonly animationSpeedCurve: GodotCurveTexture | undefined;
  readonly colorRamp: GodotCurveTexture | undefined;
  readonly alphaCurve: GodotCurveTexture | undefined;
  readonly emissionCurve: GodotCurveTexture | undefined;
  readonly orbitVelocityCurve: GodotCurveTexture | undefined;
  readonly radialVelocityCurve: GodotCurveTexture | undefined;
  readonly directionalVelocityCurve: GodotCurveTexture | undefined;
  readonly linearAccelTexture: GodotCurveTexture | undefined;
  readonly radialAccelTexture: GodotCurveTexture | undefined;
  readonly tangentAccelTexture: GodotCurveTexture | undefined;
  readonly dampingTexture: GodotCurveTexture | undefined;
  readonly turbInfluenceOverLife: GodotCurveTexture | undefined;
  readonly velocityLimitCurve: GodotCurveTexture | undefined;
  readonly angleTexture: GodotCurveTexture | undefined;
  readonly angularVelocityTexture: GodotCurveTexture | undefined;
  readonly scaleOverVelocityCurve: GodotCurveTexture | undefined;

  constructor(m: GodotProcessMaterial) {
    const u = m.uniforms;
    const f = (name: string, fallback = 0): number => {
      const v = u[name];
      if (typeof v === "number") return v;
      if (Array.isArray(v) && typeof v[0] === "number") return v[0];
      return fallback;
    };
    const v3 = (name: string, fallback: Vec3): Vec3 => {
      const v = u[name];
      if (Array.isArray(v) && v.length >= 3) return [v[0], v[1], v[2]];
      return fallback;
    };
    const curve = (name: string): GodotCurveTexture | undefined =>
      m.curves[name] || undefined;
    this.shape = m.emissionShape;
    this.turbulence = m.turbulence === true;
    this.disableZ = m.flags.includes("disable_z");
    this.alignY = m.flags.includes("align_y_to_velocity");
    this.rotateY = m.flags.includes("rotate_y");
    this.friction = m.flags.includes("damping_as_friction");

    this.scaleMin = f("scale_min", 1);
    this.scaleMax = f("scale_max", 1);
    this.hueMin = f("hue_variation_min");
    this.hueMax = f("hue_variation_max");
    this.animSpeedMin = f("anim_speed_min");
    this.animSpeedMax = f("anim_speed_max");
    this.animOffsetMin = f("anim_offset_min");
    this.animOffsetMax = f("anim_offset_max");
    this.lifetimeRandomness = f("lifetime_randomness");
    const cv = u.color_value;
    this.colorValue =
      Array.isArray(cv) && cv.length >= 4
        ? [cv[0], cv[1], cv[2], cv[3]]
        : [1, 1, 1, 1];

    this.angleMin = f("initial_angle_min");
    this.angleMax = f("initial_angle_max");
    this.angularVelocityMin = f("angular_velocity_min");
    this.angularVelocityMax = f("angular_velocity_max");
    this.linearVelocityMin = f("initial_linear_velocity_min");
    this.linearVelocityMax = f("initial_linear_velocity_max");
    this.directionalVelocityMin = f("directional_velocity_min");
    this.directionalVelocityMax = f("directional_velocity_max");
    this.radialVelocityMin = f("radial_velocity_min");
    this.radialVelocityMax = f("radial_velocity_max");
    this.orbitVelocityMin = f("orbit_velocity_min");
    this.orbitVelocityMax = f("orbit_velocity_max");
    this.turbInfluenceMin = f("turbulence_influence_min");
    this.turbInfluenceMax = f("turbulence_influence_max");

    this.linearAccelMin = f("linear_accel_min");
    this.linearAccelMax = f("linear_accel_max");
    this.radialAccelMin = f("radial_accel_min");
    this.radialAccelMax = f("radial_accel_max");
    this.tangentAccelMin = f("tangent_accel_min");
    this.tangentAccelMax = f("tangent_accel_max");
    this.dampingMin = f("damping_min");
    this.dampingMax = f("damping_max");

    this.sphereRadius = f("emission_sphere_radius");
    this.boxExtents = v3("emission_box_extents", [1, 1, 1]);
    this.shapeScale = v3("emission_shape_scale", [1, 1, 1]);
    this.shapeOffset = v3("emission_shape_offset", [0, 0, 0]);
    // The ring's uniform-only terms of `calculate_initial_position`.
    const radius = Math.max(0.001, f("emission_ring_radius"));
    const height = f("emission_ring_height");
    const cone = f("emission_ring_cone_angle", 90);
    const top = Math.max(
      radius - Math.tan(((90 - cone) * Math.PI) / 180) * height,
      0,
    );
    this.ringRadius = radius;
    this.ringInner = f("emission_ring_inner_radius");
    this.ringHeight = height;
    this.ringTop = top;
    this.ringSkew = Math.max(
      Math.min(radius, top) / Math.max(radius, top),
      0.5,
    );
    const ax = v3("emission_ring_axis", [0, 0, 1]);
    const al = Math.hypot(ax[0], ax[1], ax[2]);
    const axis: Vec3 =
      al === 0 ? [0, 0, 1] : [ax[0] / al, ax[1] / al, ax[2] / al];
    const ortho: Vec3 =
      Math.abs(axis[0]) === 1 && axis[1] === 0 && axis[2] === 0
        ? [-axis[2], 0, axis[0]]
        : [0, axis[2], -axis[1]];
    const ol = Math.hypot(ortho[0], ortho[1], ortho[2]) || 1;
    this.ringAxis = axis;
    this.ringOrtho = [ortho[0] / ol, ortho[1] / ol, ortho[2] / ol];

    this.spread = f("spread");
    this.flatness = f("flatness");
    const dir = v3("direction", [1, 0, 0]);
    this.directionAngle =
      dir[0] !== 0
        ? Math.atan2(dir[1], dir[0])
        : Math.sign(dir[1]) * (PI_SHADER / 2);
    const dl = Math.hypot(dir[0], dir[1], dir[2]);
    const n: Vec3 =
      dl > 0 ? [dir[0] / dl, dir[1] / dl, dir[2] / dl] : [0, 0, 1];
    let bi: Vec3 = [n[2], 0, -n[0]]; // cross((0,1,0), n)
    let bl = Math.hypot(bi[0], bi[1], bi[2]);
    if (bl < 0.0001) {
      bi = [0, 0, 1];
      bl = 1;
    }
    bi = [bi[0] / bl, bi[1] / bl, bi[2] / bl];
    this.spreadN = n;
    this.spreadBi = bi;
    this.spreadNm = [
      bi[1] * n[2] - bi[2] * n[1],
      bi[2] * n[0] - bi[0] * n[2],
      bi[0] * n[1] - bi[1] * n[0],
    ];

    this.inheritVelocityRatio = f("inherit_emitter_velocity_ratio");
    this.velocityPivot = v3("velocity_pivot", [0, 0, 0]);
    this.directionalVelocityGlobal = f("directional_velocity_global") !== 0;
    const g = v3("gravity", [0, -9.8, 0]);
    this.gravity = g;
    this.gravityLength = Math.hypot(g[0], g[1], g[2]);
    this.scaleOverVelocityRange =
      f("scale_over_velocity_max", 5) - f("scale_over_velocity_min", 0);
    this.turbDisplacementMin = f("turbulence_initial_displacement_min");
    this.turbDisplacementMax = f("turbulence_initial_displacement_max");

    const strength = f("turbulence_noise_strength", 1);
    this.noiseScale = f("turbulence_noise_scale", 9);
    this.noiseSpeed = v3("turbulence_noise_speed", [0, 0, 0]);
    this.noiseSpeedRandom = f("turbulence_noise_speed_random", 0.2);
    this.noiseContrast = Math.max(strength - 1, 0) * 70;
    this.noiseGain = mix(0.9, 1, strength - 9);

    this.colorInitialRamp = curve("color_initial_ramp");
    this.scaleCurve = curve("scale_curve");
    this.hueRotCurve = curve("hue_rot_curve");
    this.animationOffsetCurve = curve("animation_offset_curve");
    this.animationSpeedCurve = curve("animation_speed_curve");
    this.colorRamp = curve("color_ramp");
    this.alphaCurve = curve("alpha_curve");
    this.emissionCurve = curve("emission_curve");
    this.orbitVelocityCurve = curve("orbit_velocity_curve");
    this.radialVelocityCurve = curve("radial_velocity_curve");
    this.directionalVelocityCurve = curve("directional_velocity_curve");
    this.linearAccelTexture = curve("linear_accel_texture");
    this.radialAccelTexture = curve("radial_accel_texture");
    this.tangentAccelTexture = curve("tangent_accel_texture");
    this.dampingTexture = curve("damping_texture");
    this.turbInfluenceOverLife = curve("turbulence_influence_over_life");
    this.velocityLimitCurve = curve("velocity_limit_curve");
    this.angleTexture = curve("angle_texture");
    this.angularVelocityTexture = curve("angular_velocity_texture");
    this.scaleOverVelocityCurve = curve("scale_over_velocity_curve");
  }

  /** The generated `get_noise_direction` at the shader's `TIME`. */
  noiseDirection(
    p0: number,
    p1: number,
    p2: number,
    time: number,
    out: Float64Array,
  ): void {
    const scale = this.noiseScale;
    const speed = this.noiseSpeed;
    curl3d(
      p0 * scale + time * speed[0],
      p1 * scale + time * speed[1],
      p2 * scale + time * speed[2],
      time * this.noiseSpeedRandom,
      this.noiseContrast,
      out,
    );
    const k = this.noiseGain;
    out[0] *= k;
    out[1] *= k;
    out[2] *= k;
  }
}

interface Display {
  scale: Float64Array;
  hue: number;
  animSpeed: number;
  animOffset: number;
  lifetime: number;
  color: Float64Array;
}

interface Dynamics {
  angle: number;
  angularVelocity: number;
  initialVelocity: number;
  directionalVelocity: number;
  radialVelocity: number;
  orbitVelocity: number;
  turbInfluence: number;
}

interface Physical {
  linear: number;
  radial: number;
  tangent: number;
  damping: number;
}

const RAMP = new Float64Array(4);

function initialDisplay(m: Material, seed: { v: number }, out: Display): void {
  const s = mix(m.scaleMin, m.scaleMax, godotRandFromSeed(seed));
  const sc = Math.sign(s) * Math.max(Math.abs(s), 0.001);
  out.scale[0] = sc;
  out.scale[1] = sc;
  out.scale[2] = sc;
  out.hue = PI_SHADER * 2 * mix(m.hueMin, m.hueMax, godotRandFromSeed(seed));
  out.animSpeed = mix(m.animSpeedMin, m.animSpeedMax, godotRandFromSeed(seed));
  out.animOffset = mix(
    m.animOffsetMin,
    m.animOffsetMax,
    godotRandFromSeed(seed),
  );
  out.lifetime = 1 - m.lifetimeRandomness * godotRandFromSeed(seed);
  const c = m.colorValue;
  out.color[0] = c[0];
  out.color[1] = c[1];
  out.color[2] = c[2];
  out.color[3] = c[3];
  if (m.colorInitialRamp) {
    const t = godotRandFromSeed(seed);
    sampleCurve(m.colorInitialRamp, t, t, RAMP);
    for (let i = 0; i < 4; i++) out.color[i] *= RAMP[i];
  }
  if (m.shape === "points" || m.shape === "directed_points") {
    godotRandFromSeed(seed); // emission_texture_position
  }
}

function initialDynamics(
  m: Material,
  seed: { v: number },
  out: Dynamics,
): void {
  out.angle = mix(m.angleMin, m.angleMax, godotRandFromSeed(seed));
  out.angularVelocity = mix(
    m.angularVelocityMin,
    m.angularVelocityMax,
    godotRandFromSeed(seed),
  );
  out.initialVelocity = mix(
    m.linearVelocityMin,
    m.linearVelocityMax,
    godotRandFromSeed(seed),
  );
  out.directionalVelocity = mix(
    m.directionalVelocityMin,
    m.directionalVelocityMax,
    godotRandFromSeed(seed),
  );
  out.radialVelocity = mix(
    m.radialVelocityMin,
    m.radialVelocityMax,
    godotRandFromSeed(seed),
  );
  out.orbitVelocity = mix(
    m.orbitVelocityMin,
    m.orbitVelocityMax,
    godotRandFromSeed(seed),
  );
  out.turbInfluence = m.turbulence
    ? mix(m.turbInfluenceMin, m.turbInfluenceMax, godotRandFromSeed(seed))
    : 0;
}

function initialPhysical(
  m: Material,
  seed: { v: number },
  out: Physical,
): void {
  out.linear = mix(m.linearAccelMin, m.linearAccelMax, godotRandFromSeed(seed));
  out.radial = mix(m.radialAccelMin, m.radialAccelMax, godotRandFromSeed(seed));
  out.tangent = mix(
    m.tangentAccelMin,
    m.tangentAccelMax,
    godotRandFromSeed(seed),
  );
  out.damping = mix(m.dampingMin, m.dampingMax, godotRandFromSeed(seed));
}

// `rotate_hue`'s matrix for the last angle: emitters without hue variation (or with one hue per
// emitter) rotate every particle by the same angle, and the same angle builds the same matrix.
let hueAngle = 0;
let hueValid = false;
const HUE = new Float64Array(9);

/** The generated `rotate_hue` (its matrices are column-major, as written). */
function rotateHue(c: Float64Array, angle: number): void {
  const k = HUE;
  if (!hueValid || !Object.is(angle, hueAngle)) {
    const hc = Math.cos(angle);
    const hs = Math.sin(angle);
    k[0] = 0.299 + 0.701 * hc + 0.168 * hs;
    k[1] = 0.587 + -0.587 * hc + 0.33 * hs;
    k[2] = 0.114 + -0.114 * hc + -0.497 * hs;
    k[3] = 0.299 + -0.299 * hc + -0.328 * hs;
    k[4] = 0.587 + 0.413 * hc + 0.035 * hs;
    k[5] = 0.114 + -0.114 * hc + 0.292 * hs;
    k[6] = 0.299 + -0.3 * hc + 1.25 * hs;
    k[7] = 0.587 + -0.588 * hc + -1.05 * hs;
    k[8] = 0.114 + 0.886 * hc + -0.203 * hs;
    hueAngle = angle;
    hueValid = true;
  }
  const r = c[0];
  const g = c[1];
  const b = c[2];
  c[0] = k[0] * r + k[3] * g + k[6] * b;
  c[1] = k[1] * r + k[4] * g + k[7] * b;
  c[2] = k[2] * r + k[5] * g + k[8] * b;
}

const DISPLAY_TEX = new Float64Array(4);

/** The generated `process_display_param`. */
function processDisplay(m: Material, p: Display, t: number): void {
  const s = DISPLAY_TEX;
  if (m.scaleCurve) {
    sampleCurve(m.scaleCurve, t, t, s);
    p.scale[0] *= s[0];
    p.scale[1] *= s[1];
    p.scale[2] *= s[2];
  }
  if (m.hueRotCurve) p.hue *= tex(m.hueRotCurve, t);
  if (m.animationOffsetCurve) p.animOffset += tex(m.animationOffsetCurve, t);
  if (m.animationSpeedCurve) p.animSpeed *= tex(m.animationSpeedCurve, t);
  if (m.colorRamp) {
    sampleCurve(m.colorRamp, t, t, s);
    for (let i = 0; i < 4; i++) p.color[i] *= s[i];
  }
  if (m.alphaCurve) p.color[3] *= tex(m.alphaCurve, t);
  rotateHue(p.color, p.hue);
  if (m.emissionCurve) {
    const e = 1 + tex(m.emissionCurve, t);
    p.color[0] *= e;
    p.color[1] *= e;
    p.color[2] *= e;
  }
}

/** The generated `calculate_initial_position`. */
function initialPosition(
  m: Material,
  seed: { v: number },
  out: Float64Array,
): void {
  let x = 0;
  let y = 0;
  let z = 0;
  const shape = m.shape;
  if (shape === "sphere") {
    const r0 = m.sphereRadius;
    const s = godotRandFromSeed(seed) * 2 - 1;
    const t = godotRandFromSeed(seed) * 2 * PI_SHADER;
    const p = godotRandFromSeed(seed);
    const radius = r0 * Math.sqrt(1 - s * s);
    x = radius * Math.cos(t) * p;
    y = radius * Math.sin(t) * p;
    z = r0 * s * p;
  } else if (shape === "sphere_surface") {
    const r0 = m.sphereRadius;
    const s = godotRandFromSeed(seed) * 2 - 1;
    const t = godotRandFromSeed(seed) * 2 * PI_SHADER;
    const radius = r0 * Math.sqrt(1 - s * s);
    x = radius * Math.cos(t);
    y = radius * Math.sin(t);
    z = r0 * s;
  } else if (shape === "box") {
    const e = m.boxExtents;
    x = (godotRandFromSeed(seed) * 2 - 1) * e[0];
    y = (godotRandFromSeed(seed) * 2 - 1) * e[1];
    z = (godotRandFromSeed(seed) * 2 - 1) * e[2];
  } else if (shape === "ring") {
    const radius = m.ringRadius;
    const inner = m.ringInner;
    const height = m.ringHeight;
    const top = m.ringTop;
    let yPos = godotRandFromSeed(seed);
    const skew = m.ringSkew;
    yPos = radius < top ? yPos ** skew : 1 - yPos ** skew;
    const angle = godotRandFromSeed(seed) * 2 * PI_SHADER;
    let rr = Math.sqrt(
      godotRandFromSeed(seed) * (radius * radius - inner * inner) +
        inner * inner,
    );
    rr = mix(rr, rr * (top / radius), yPos);
    const a0 = m.ringAxis[0];
    const a1 = m.ringAxis[1];
    const a2 = m.ringAxis[2];
    const t0 = m.ringOrtho[0];
    const t1 = m.ringOrtho[1];
    const t2 = m.ringOrtho[2];
    const s = Math.sin(angle);
    const c = Math.cos(angle);
    const oc = 1 - c;
    // mat3(columns) * ortho
    const o0 =
      (c + a0 * a0 * oc) * t0 +
      (a0 * a1 * oc + s * a2) * t1 +
      (a2 * a0 * oc - a1 * s) * t2;
    const o1 =
      (a0 * a1 * oc - a2 * s) * t0 +
      (c + a1 * a1 * oc) * t1 +
      (a2 * a1 * oc + a0 * s) * t2;
    const o2 =
      (a0 * a2 * oc + a1 * s) * t0 +
      (a1 * a2 * oc - a0 * s) * t1 +
      (c + a2 * a2 * oc) * t2;
    const ol = Math.hypot(o0, o1, o2) || 1;
    const h = yPos * height - height / 2;
    x = (o0 / ol) * rr + h * a0;
    y = (o1 / ol) * rr + h * a1;
    z = (o2 / ol) * rr + h * a2;
  }
  // point, and points / directed_points (no emission texture here): the origin.
  const scale = m.shapeScale;
  const offset = m.shapeOffset;
  out[0] = x * scale[0] + offset[0];
  out[1] = y * scale[1] + offset[1];
  out[2] = z * scale[2] + offset[2];
}

/** The generated `get_random_direction_from_spread`. */
function spreadDirection(
  m: Material,
  seed: { v: number },
  spreadDeg: number,
  out: Float64Array,
): void {
  const spread = spreadDeg * (PI_SHADER / 180);
  if (m.disableZ) {
    let a = randM1P1(seed) * spread;
    a += m.directionAngle;
    out[0] = Math.cos(a);
    out[1] = Math.sin(a);
    out[2] = 0;
    return;
  }
  const a1 = randM1P1(seed) * spread;
  const a2 = randM1P1(seed) * spread * (1 - m.flatness);
  const xz0 = Math.sin(a1);
  const xz2 = Math.cos(a1);
  const yz1 = Math.sin(a2);
  let yz2 = Math.cos(a2);
  yz2 = yz2 / Math.max(0.0001, Math.sqrt(Math.abs(yz2)));
  const sd0 = xz0 * yz2;
  const sd1 = yz1;
  const sd2 = xz2 * yz2;
  const bi = m.spreadBi;
  const nm = m.spreadNm;
  const n = m.spreadN;
  const r0 = bi[0] * sd0 + nm[0] * sd1 + n[0] * sd2;
  const r1 = bi[1] * sd0 + nm[1] * sd1 + n[1] * sd2;
  const r2 = bi[2] * sd0 + nm[2] * sd1 + n[2] * sd2;
  const rl = Math.hypot(r0, r1, r2) || 1;
  out[0] = r0 / rl;
  out[1] = r1 / rl;
  out[2] = r2 / rl;
}

// ------------------------------------------------------------------------------- the emitter

/** `Transform3D` (memory order) applied to a point (w = 1) or a vector (w = 0). */
function xf(
  t: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  w: number,
  out: Float64Array,
): void {
  out[0] = t[0] * x + t[1] * y + t[2] * z + t[9] * w;
  out[1] = t[3] * x + t[4] * y + t[5] * z + t[10] * w;
  out[2] = t[6] * x + t[7] * y + t[8] * z + t[11] * w;
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** `affine_inverse` of a `Transform3D` (memory order) into `out`. */
function affineInverse(t: readonly number[], out: Float64Array): void {
  const a = t[0];
  const b = t[1];
  const c = t[2];
  const d = t[3];
  const e = t[4];
  const f = t[5];
  const g = t[6];
  const h = t[7];
  const i = t[8];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (det === 0) {
    out.set(IDENTITY);
    return;
  }
  out[0] = (e * i - f * h) / det;
  out[1] = (c * h - b * i) / det;
  out[2] = (b * f - c * e) / det;
  out[3] = (f * g - d * i) / det;
  out[4] = (a * i - c * g) / det;
  out[5] = (c * d - a * f) / det;
  out[6] = (d * h - e * g) / det;
  out[7] = (b * g - a * h) / det;
  out[8] = (a * e - b * d) / det;
  const o0 = t[9];
  const o1 = t[10];
  const o2 = t[11];
  out[9] = -(out[0] * o0 + out[1] * o1 + out[2] * o2);
  out[10] = -(out[3] * o0 + out[4] * o1 + out[5] * o2);
  out[11] = -(out[6] * o0 + out[7] * o1 + out[8] * o2);
}

/** Evidence of what one emitter did (counters since it was made). */
export interface GodotGpuStats {
  /** `_particles_process` calls (fixed steps, pre-process and request steps included). */
  steps: number;
  restarts: number;
  processRequests: number;
}

/** Features the material or emitter uses that this port does not model (see the file header). */
export function godotGpuApproximateFeatures(
  c: GodotGpuEmitterConfig,
): string[] {
  const out: string[] = [];
  const m = c.material;
  if (m.emissionShape === "points" || m.emissionShape === "directed_points")
    out.push("emission-points");
  if (c.drawOrder === "reverse_lifetime" || c.drawOrder === "view_depth")
    out.push(`draw-order-${c.drawOrder.replace("_", "-")}`);
  return out;
}

// The cached spawn values (`GpuParticle.init`): display, dynamics, physical, then the seed after
// their draws.
const INIT_SCALE = 0;
const INIT_HUE = 1;
const INIT_ANIM_SPEED = 2;
const INIT_ANIM_OFFSET = 3;
const INIT_LIFETIME = 4;
const INIT_COLOR = 5; // 4 values
const INIT_ANGLE = 9;
const INIT_ANGULAR_VELOCITY = 10;
const INIT_VELOCITY = 11;
const INIT_DIRECTIONAL_VELOCITY = 12;
const INIT_RADIAL_VELOCITY = 13;
const INIT_ORBIT_VELOCITY = 14;
const INIT_TURB_INFLUENCE = 15;
const INIT_LINEAR = 16;
const INIT_RADIAL = 17;
const INIT_TANGENT = 18;
const INIT_DAMPING = 19;
const INIT_SEED = 20;
const INIT_FLOATS = 21;

/**
 * One emitter, as gl_compatibility's `ParticlesStorage` holds it. Configure with `configure`
 * (the setters), `restart` (`particles_restart`), `requestProcess` (`particles_request_process_time`),
 * then `update(frameDelta)` once per drawn frame and `pack` the instances.
 *
 * The per-particle pass allocates nothing: scratch vectors are the emitter's, the material is
 * resolved once per configuration, and each particle's spawn values (the generated shader
 * re-derives them from its seed on every process pass) are cached by seed hash and material, so a
 * pass draws them once per particle life. The results are bit-identical to evaluating the shader
 * as written.
 *
 * A burst (the `pre_process_time` passes after a clear, a process request's passes) may be spread
 * over several `update` calls: given a `yieldNow` predicate, the burst stops between two passes
 * once it answers true (after at least one pass per call), and the emitter is `settling` until the
 * burst is done. Every call made while settling (`configure`, `setEmitting`, `restart`,
 * `requestProcess`, `update`) is queued and replayed in order once the burst is done, so the
 * emitter ends in exactly the state the same calls make without the predicate. A settling
 * emitter's particles are mid-burst: the caller draws nothing of it (not `pack`).
 */
export class GodotGpuEmitter {
  config: GodotGpuEmitterConfig;
  private mat: Material;
  /** Moves with `mat`: a particle's cached spawn values are valid for one material. */
  private matEpoch = 0;
  private particles: GpuParticle[] = [];
  emitting = false;
  private phase = 0;
  private cycle = 0;
  private clear = true;
  private inactive = true;
  private inactiveTime = 0;
  private frameRemainder = 0;
  private restartRequest = false;
  private requestTime = 0;
  /** The shader's `TIME` (the renderer's total time) during this frame's process steps. */
  private time = 0;
  /** The burst in progress: its stage (`pre_process_time`, or a process request), the passes'
   * time left and step, and the delta of the `update` that started it (its main step follows
   * the preprocess). */
  private burst: {
    stage: "pre" | "request";
    todo: number;
    ft: number;
    frameDelta: number;
  } | null = null;
  /** The calls made while a burst settles, replayed in order once it is done. */
  private queued: (
    | { op: "update"; frameDelta: number; time: number | undefined }
    | { op: "configure"; config: GodotGpuEmitterConfig }
    | { op: "emitting"; on: boolean }
    | { op: "restart" }
    | { op: "request"; time: number }
  )[] = [];
  /** The current `update` call's yield predicate. */
  private yieldNow: (() => boolean) | undefined = undefined;
  readonly stats: GodotGpuStats = { steps: 0, restarts: 0, processRequests: 0 };

  // Per-pass and per-particle scratch.
  private readonly seed = { v: 0 };
  private readonly d: Display = {
    scale: new Float64Array(3),
    hue: 0,
    animSpeed: 0,
    animOffset: 0,
    lifetime: 1,
    color: new Float64Array(4),
  };
  private readonly dy: Dynamics = {
    angle: 0,
    angularVelocity: 0,
    initialVelocity: 0,
    directionalVelocity: 0,
    radialVelocity: 0,
    orbitVelocity: 0,
    turbInfluence: 0,
  };
  private readonly ph: Physical = {
    linear: 0,
    radial: 0,
    tangent: 0,
    damping: 0,
  };
  private readonly v3 = new Float64Array(3);
  private readonly v3b = new Float64Array(3);
  private readonly s4 = new Float64Array(4);
  /** `velocity_pivot` through this pass's emission transform. */
  private readonly pivot = new Float64Array(3);
  private readonly inv = new Float64Array(12);

  constructor(config: GodotGpuEmitterConfig) {
    this.config = config;
    this.mat = new Material(config.material);
    this.emitting = config.emitting;
    this.resize(config.amount);
  }

  /** Apply a new configuration (the setters that changed). `emitting` is set only when the
   * caller's value changed (`setEmitting`), as a RenderingServer setter is. An amount change
   * clears the emitter, as `particles_set_amount` does. A material is read once, when its object
   * changes: pass a new object to change one. */
  configure(config: GodotGpuEmitterConfig): void {
    if (this.burst !== null) {
      this.queued.push({ op: "configure", config });
      return;
    }
    if (config.amount !== this.config.amount) {
      this.resize(config.amount);
      this.phase = 0;
      this.clear = true;
    }
    if (config.material !== this.config.material) {
      this.mat = new Material(config.material);
      this.matEpoch++;
    }
    this.config = config;
  }

  setEmitting(on: boolean): void {
    if (this.burst !== null) {
      this.queued.push({ op: "emitting", on });
      return;
    }
    this.emitting = on;
  }

  /** `particles_restart`. */
  restart(): void {
    if (this.burst !== null) {
      this.queued.push({ op: "restart" });
      return;
    }
    this.restartRequest = true;
    this.stats.restarts++;
  }

  /** `particles_request_process_time`. */
  requestProcess(time: number): void {
    if (this.burst !== null) {
      this.queued.push({ op: "request", time });
      return;
    }
    this.requestTime = time;
    this.stats.processRequests++;
  }

  /** A burst is in progress (see the class note): its particles are not to be drawn. */
  get settling(): boolean {
    return this.burst !== null;
  }

  /** gl_compatibility's `particles_is_inactive`: nothing is drawn. */
  get isInactive(): boolean {
    return !this.emitting && this.inactive;
  }

  private resize(amount: number): void {
    const n = Math.max(0, Math.floor(amount));
    this.particles = [];
    for (let i = 0; i < n; i++)
      this.particles.push({
        active: false,
        cycle: 0,
        xform: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
        velocity: new Float64Array(3),
        color: new Float64Array([1, 1, 1, 1]),
        custom: new Float64Array(4),
        init: new Float64Array(INIT_FLOATS),
        initHash: -1,
        initEpoch: -1,
      });
  }

  /** `update_particles` for this emitter, given the renderer's frame delta (seconds) and its
   * total time (the shader's `TIME`; turbulence reads it), by default advanced by the delta.
   * `yieldNow` (see the class note) may stop a burst between passes; without it a burst runs
   * to its end in this call. */
  update(frameDelta: number, time?: number, yieldNow?: () => boolean): void {
    this.yieldNow = yieldNow;
    if (this.burst !== null) {
      this.queued.push({ op: "update", frameDelta, time });
      this.resumeBurst();
    } else this.runUpdate(frameDelta, time ?? this.time + frameDelta);
    this.replay();
  }

  /** Continue a burst in progress with no new step (no time passed: a frame with no update to
   * give), then replay what was queued once it is done. Nothing happens unless `settling`. */
  advance(yieldNow?: () => boolean): void {
    if (this.burst === null) return;
    this.yieldNow = yieldNow;
    this.resumeBurst();
    this.replay();
  }

  /** The calls made while settling, in order, once the burst is done (one may start another). */
  private replay(): void {
    while (this.burst === null && this.queued.length > 0) {
      const q = this.queued.shift() as (typeof this.queued)[number];
      if (q.op === "update")
        this.runUpdate(q.frameDelta, q.time ?? this.time + q.frameDelta);
      else if (q.op === "configure") this.configure(q.config);
      else if (q.op === "emitting") this.setEmitting(q.on);
      else if (q.op === "restart") this.restart();
      else this.requestProcess(q.time);
    }
    this.yieldNow = undefined;
  }

  private runUpdate(frameDelta: number, time: number): void {
    const c = this.config;
    this.time = time;
    if (this.restartRequest) {
      this.phase = 0;
      this.clear = true;
      this.restartRequest = false;
    }
    if (this.inactive && !this.emitting) return;
    if (this.emitting) {
      if (this.inactive) {
        this.phase = 0;
        this.clear = true;
      }
      this.inactive = false;
      this.inactiveTime = 0;
    } else {
      this.inactiveTime += c.speedScale * frameDelta;
      if (this.inactiveTime > c.lifetime * 1.2) {
        this.inactive = true;
        return;
      }
    }
    const fixed = c.fixedFps > 0 ? c.fixedFps : 0;
    if (this.clear && c.preProcessTime > 0) {
      this.burst = {
        stage: "pre",
        todo: c.preProcessTime,
        ft: 1 / (fixed > 0 ? fixed : 30),
        frameDelta,
      };
      this.resumeBurst();
      return;
    }
    this.mainStep(frameDelta);
  }

  /** The frame's own step after any preprocess, then a requested process burst. */
  private mainStep(frameDelta: number): void {
    const c = this.config;
    const fixed = c.fixedFps > 0 ? c.fixedFps : 0;
    const timeScale = Math.max(c.speedScale, 0);
    if (fixed > 0) {
      const ft = 1 / fixed;
      let delta = frameDelta;
      if (delta > 0.1) delta = 0.1;
      else if (delta <= 0) delta = 0.001;
      let todo = this.frameRemainder + delta * timeScale;
      while (todo >= ft) {
        this.process(ft);
        todo -= ft;
      }
      this.frameRemainder = todo;
    } else {
      this.process(frameDelta * timeScale);
    }
    if (this.requestTime > 0) {
      this.burst = {
        stage: "request",
        todo: this.requestTime,
        ft: 1 / (fixed > 0 ? fixed : 30),
        frameDelta,
      };
      this.resumeBurst();
    }
  }

  /** The burst's passes (`while (todo >= 0)`), until it ends or `yieldNow` stops it (never
   * before this call's first pass). */
  private resumeBurst(): void {
    const b = this.burst as NonNullable<typeof this.burst>;
    let passes = 0;
    while (b.todo >= 0) {
      if (passes > 0 && this.yieldNow?.() === true) return;
      this.process(b.ft);
      b.todo -= b.ft;
      passes++;
    }
    this.burst = null;
    if (b.stage === "pre") this.mainStep(b.frameDelta);
    else this.requestTime = 0;
  }

  /** `_particles_process(delta)`: one pass of the process shader over every particle. */
  private process(delta: number): void {
    const c = this.config;
    this.stats.steps++;
    const lifetime = c.lifetime > 0 ? c.lifetime : 1;
    const newPhase = (this.phase + delta / lifetime) % 1;
    if (this.clear) this.cycle = 0;
    else if (newPhase < this.phase) {
      if (c.oneShot) this.emitting = false;
      this.cycle++;
    }
    const systemPhase = newPhase;
    const prevPhase = this.phase;
    this.phase = newPhase;
    const emission = c.localCoords ? IDENTITY : c.emissionTransform;
    const vp = this.mat.velocityPivot;
    xf(emission, vp[0], vp[1], vp[2], 1, this.pivot);
    const particles = this.particles;
    const total = particles.length;
    for (let index = 0; index < total; index++) {
      this.shade(
        particles[index],
        index,
        total,
        delta,
        systemPhase,
        prevPhase,
        emission,
        lifetime,
      );
    }
    this.clear = false;
  }

  /** The generated shader's `generate_display_param`, `generate_dynamics_param` and
   * `generate_physical_param` from seed `hash` into the scratch `d`, `dy`, `ph` and `seed` (left
   * where those draws leave it): computed once per particle seed and material, then copied. */
  private initial(p: GpuParticle, hash: number): void {
    const seed = this.seed;
    const d = this.d;
    const dy = this.dy;
    const ph = this.ph;
    const k = p.init;
    if (p.initHash === hash && p.initEpoch === this.matEpoch) {
      const sc = k[INIT_SCALE];
      d.scale[0] = sc;
      d.scale[1] = sc;
      d.scale[2] = sc;
      d.hue = k[INIT_HUE];
      d.animSpeed = k[INIT_ANIM_SPEED];
      d.animOffset = k[INIT_ANIM_OFFSET];
      d.lifetime = k[INIT_LIFETIME];
      d.color[0] = k[INIT_COLOR];
      d.color[1] = k[INIT_COLOR + 1];
      d.color[2] = k[INIT_COLOR + 2];
      d.color[3] = k[INIT_COLOR + 3];
      dy.angle = k[INIT_ANGLE];
      dy.angularVelocity = k[INIT_ANGULAR_VELOCITY];
      dy.initialVelocity = k[INIT_VELOCITY];
      dy.directionalVelocity = k[INIT_DIRECTIONAL_VELOCITY];
      dy.radialVelocity = k[INIT_RADIAL_VELOCITY];
      dy.orbitVelocity = k[INIT_ORBIT_VELOCITY];
      dy.turbInfluence = k[INIT_TURB_INFLUENCE];
      ph.linear = k[INIT_LINEAR];
      ph.radial = k[INIT_RADIAL];
      ph.tangent = k[INIT_TANGENT];
      ph.damping = k[INIT_DAMPING];
      seed.v = k[INIT_SEED];
      return;
    }
    const m = this.mat;
    seed.v = hash;
    initialDisplay(m, seed, d);
    initialDynamics(m, seed, dy);
    initialPhysical(m, seed, ph);
    k[INIT_SCALE] = d.scale[0];
    k[INIT_HUE] = d.hue;
    k[INIT_ANIM_SPEED] = d.animSpeed;
    k[INIT_ANIM_OFFSET] = d.animOffset;
    k[INIT_LIFETIME] = d.lifetime;
    k[INIT_COLOR] = d.color[0];
    k[INIT_COLOR + 1] = d.color[1];
    k[INIT_COLOR + 2] = d.color[2];
    k[INIT_COLOR + 3] = d.color[3];
    k[INIT_ANGLE] = dy.angle;
    k[INIT_ANGULAR_VELOCITY] = dy.angularVelocity;
    k[INIT_VELOCITY] = dy.initialVelocity;
    k[INIT_DIRECTIONAL_VELOCITY] = dy.directionalVelocity;
    k[INIT_RADIAL_VELOCITY] = dy.radialVelocity;
    k[INIT_ORBIT_VELOCITY] = dy.orbitVelocity;
    k[INIT_TURB_INFLUENCE] = dy.turbInfluence;
    k[INIT_LINEAR] = ph.linear;
    k[INIT_RADIAL] = ph.radial;
    k[INIT_TANGENT] = ph.tangent;
    k[INIT_DAMPING] = ph.damping;
    k[INIT_SEED] = seed.v;
    p.initHash = hash;
    p.initEpoch = this.matEpoch;
  }

  /** particles.glsl `main` with the material's START and PROCESS for one particle. */
  private shade(
    p: GpuParticle,
    index: number,
    total: number,
    delta: number,
    systemPhase: number,
    prevPhase: number,
    emission: readonly number[],
    lifetime: number,
  ): void {
    const c = this.config;
    const m = this.mat;
    if (this.clear) {
      p.color.fill(1);
      p.custom.fill(0);
      p.velocity.fill(0);
      p.active = false;
      p.cycle = 0;
      p.xform.set(IDENTITY);
    }
    let localDelta = delta;
    let restart = false;
    if (this.emitting) {
      let restartPhase = index / total;
      if (c.randomness > 0) {
        let seed = this.cycle >>> 0;
        if (restartPhase >= systemPhase) seed = (seed - 1) >>> 0;
        seed = Math.imul(seed, total) >>> 0;
        seed = (seed + index) >>> 0;
        const random = (godotParticleHash(seed) % 65536) / 65536;
        restartPhase += (c.randomness * random * 1) / total;
      }
      restartPhase *= 1 - c.explosiveness;
      if (systemPhase > prevPhase) {
        if (restartPhase >= prevPhase && restartPhase < systemPhase) {
          restart = true;
          if (c.fractionalDelta)
            localDelta = (systemPhase - restartPhase) * lifetime;
        }
      } else if (delta > 0) {
        if (restartPhase >= prevPhase) {
          restart = true;
          if (c.fractionalDelta)
            localDelta = (1 - restartPhase + systemPhase) * lifetime;
        } else if (restartPhase < systemPhase) {
          restart = true;
          if (c.fractionalDelta)
            localDelta = (systemPhase - restartPhase) * lifetime;
        }
      }
      if (restart) {
        p.active = true;
        p.cycle = this.cycle & FRAME_MASK;
      }
    }
    if (!p.active) return;
    const number = (Math.imul(p.cycle, total) + index) >>> 0;
    const hash = godotParticleHash((number + 1 + (c.seed >>> 0)) >>> 0);
    const DELTA = localDelta;
    const ev = c.emitterVelocity;
    const v3 = this.v3;
    const v3b = this.v3b;
    const seed = this.seed;
    const d = this.d;
    const dy = this.dy;
    const ph = this.ph;
    const x = p.xform;
    const v = p.velocity;
    if (restart) {
      // START
      this.initial(p, hash);
      processDisplay(m, d, 0);
      if (godotRandFromSeed(seed) > c.amountRatio) p.active = false;
      p.custom.fill(0);
      p.custom[3] = d.lifetime;
      p.custom[0] = dy.angle;
      p.color.set(d.color);
      // RESTART_ROT_SCALE then RESTART_POSITION: TRANSFORM = EMISSION_TRANSFORM * TRANSFORM.
      initialPosition(m, seed, v3);
      if (m.turbulence) {
        const disp = mix(
          m.turbDisplacementMin,
          m.turbDisplacementMax,
          godotRandFromSeed(seed),
        );
        m.noiseDirection(v3[0], v3[1], v3[2], this.time, v3b);
        v3[0] += v3b[0] * disp;
        v3[1] += v3b[1] * disp;
        v3[2] += v3b[2] * disp;
      }
      // basis columns = emission basis columns (E * identity)
      x[0] = emission[0];
      x[1] = emission[3];
      x[2] = emission[6];
      x[3] = emission[1];
      x[4] = emission[4];
      x[5] = emission[7];
      x[6] = emission[2];
      x[7] = emission[5];
      x[8] = emission[8];
      xf(emission, v3[0], v3[1], v3[2], 1, v3b);
      x[9] = v3b[0];
      x[10] = v3b[1];
      x[11] = v3b[2];
      spreadDirection(m, seed, m.spread, v3);
      v3[0] *= dy.initialVelocity;
      v3[1] *= dy.initialVelocity;
      v3[2] *= dy.initialVelocity;
      xf(emission, v3[0], v3[1], v3[2], 0, v3b);
      const inherit = m.inheritVelocityRatio;
      v[0] = v3b[0] + (ev[0] ?? 0) * inherit;
      v[1] = v3b[1] + (ev[1] ?? 0) * inherit;
      v[2] = v3b[2] + (ev[2] ?? 0) * inherit;
      if (m.disableZ) {
        v[2] = 0;
        x[11] = 0;
      }
      if (!p.active) return;
    }
    // PROCESS
    this.initial(p, hash);
    const LIFETIME = lifetime;
    p.custom[1] += DELTA / LIFETIME;
    p.custom[1] = mix(p.custom[1], 1, c.interpToEnd);
    const lp = p.custom[1] / d.lifetime;
    if (p.custom[1] > p.custom[3]) p.active = false;
    const pos0 = x[9];
    const pos1 = x[10];
    const pos2 = x[11];
    const org0 = emission[9];
    const org1 = emission[10];
    const org2 = emission[11];
    let ctrl0 = 0;
    let ctrl1 = 0;
    let ctrl2 = 0;
    // orbit (2D: disable_z, or an orbit curve)
    if (m.disableZ || m.orbitVelocityCurve) {
      if (!(Math.abs(dy.orbitVelocity) < 0.01 || DELTA < 0.001)) {
        if (m.disableZ) {
          let amount = dy.orbitVelocity;
          if (m.orbitVelocityCurve) amount *= tex(m.orbitVelocityCurve, lp, 0);
          if (amount !== 0) {
            const dx = pos0 - org0;
            const dyy = pos1 - org1;
            const ang = amount * PI_SHADER * 2 * DELTA;
            const cs = Math.cos(ang);
            const sn = Math.sin(ang);
            const disp0 = cs * dx + sn * dyy - dx;
            const disp1 = -sn * dx + cs * dyy - dyy;
            xf(emission, disp0 / DELTA, disp1 / DELTA, 0, 0, v3);
            ctrl0 += v3[0];
            ctrl1 += v3[1];
            ctrl2 += v3[2];
          }
        }
        // 3D orbit over a curve: not modelled (a 2D canvas emitter is disable_z).
      }
    }
    // radial velocity
    if (DELTA >= 0.001) {
      const mult = m.radialVelocityCurve
        ? tex(m.radialVelocityCurve, lp, 0)
        : 1;
      const pivot = this.pivot;
      const rel0 = pos0 - pivot[0];
      const rel1 = pos1 - pivot[1];
      const rel2 = pos2 - pivot[2];
      const rl = Math.hypot(rel0, rel1, rel2);
      let rd0: number;
      let rd1: number;
      let rd2: number;
      if (rl > 0.01) {
        rd0 = (rel0 / rl) * mult * dy.radialVelocity;
        rd1 = (rel1 / rl) * mult * dy.radialVelocity;
        rd2 = (rel2 / rl) * mult * dy.radialVelocity;
      } else {
        spreadDirection(m, seed, 360, v3);
        rd0 = v3[0] * dy.radialVelocity;
        rd1 = v3[1] * dy.radialVelocity;
        rd2 = v3[2] * dy.radialVelocity;
      }
      if (mult * dy.radialVelocity < 0) {
        const l = Math.hypot(rd0, rd1, rd2) || 1;
        const k = Math.min(Math.abs(mult * dy.radialVelocity), rl / DELTA);
        rd0 = (rd0 / l) * k;
        rd1 = (rd1 / l) * k;
        rd2 = (rd2 / l) * k;
      }
      ctrl0 += rd0;
      ctrl1 += rd1;
      ctrl2 += rd2;
    }
    if (m.directionalVelocityCurve) {
      const s = this.s4;
      sampleCurve(m.directionalVelocityCurve, lp, lp, s);
      let dv0 = s[0] * dy.directionalVelocity;
      let dv1 = s[1] * dy.directionalVelocity;
      let dv2 = s[2] * dy.directionalVelocity;
      if (m.directionalVelocityGlobal) {
        xf(emission, dv0, dv1, dv2, 0, v3);
        dv0 = v3[0];
        dv1 = v3[1];
        dv2 = v3[2];
      }
      ctrl0 += dv0;
      ctrl1 += dv1;
      ctrl2 += dv2;
    }
    if (m.linearAccelTexture) ph.linear *= tex(m.linearAccelTexture, lp);
    if (m.radialAccelTexture) ph.radial *= tex(m.radialAccelTexture, lp);
    if (m.tangentAccelTexture) ph.tangent *= tex(m.tangentAccelTexture, lp);
    if (m.dampingTexture) ph.damping *= tex(m.dampingTexture, lp);
    {
      const g = m.gravity;
      let f0 = g[0];
      let f1 = g[1];
      let f2 = g[2];
      const vl = Math.hypot(v[0], v[1], v[2]);
      if (vl > 0) {
        f0 += (v[0] / vl) * ph.linear;
        f1 += (v[1] / vl) * ph.linear;
        f2 += (v[2] / vl) * ph.linear;
      }
      const diff0 = pos0 - org0;
      const diff1 = pos1 - org1;
      const diff2 = pos2 - org2;
      const dl = Math.hypot(diff0, diff1, diff2);
      if (dl > 0) {
        f0 += (diff0 / dl) * ph.radial;
        f1 += (diff1 / dl) * ph.radial;
        f2 += (diff2 / dl) * ph.radial;
      }
      if (m.disableZ) {
        const tl = Math.hypot(diff1, diff0);
        if (tl > 0) {
          f0 += (-diff1 / tl) * ph.tangent;
          f1 += (diff0 / tl) * ph.tangent;
        }
        f2 = 0;
      } else if (dl > 0) {
        const gl = m.gravityLength;
        if (gl > 0) {
          const a0 = diff0 / dl;
          const a1 = diff1 / dl;
          const a2 = diff2 / dl;
          const b0 = g[0] / gl;
          const b1 = g[1] / gl;
          const b2 = g[2] / gl;
          const cr0 = a1 * b2 - a2 * b1;
          const cr1 = a2 * b0 - a0 * b2;
          const cr2 = a0 * b1 - a1 * b0;
          const cl = Math.hypot(cr0, cr1, cr2);
          if (cl > 0) {
            f0 += (cr0 / cl) * ph.tangent;
            f1 += (cr1 / cl) * ph.tangent;
            f2 += (cr2 / cl) * ph.tangent;
          }
        }
      }
      v[0] += f0 * DELTA;
      v[1] += f1 * DELTA;
      v[2] += f2 * DELTA;
    }
    if (ph.damping > 0) {
      let s = Math.hypot(v[0], v[1], v[2]);
      if (!m.friction) s -= ph.damping * DELTA;
      else if (s > 0.001) s -= s * s * ph.damping * 0.05 * DELTA;
      if (s < 0) v.fill(0);
      else {
        const l = Math.hypot(v[0], v[1], v[2]);
        if (l > 0) for (let i = 0; i < 3; i++) v[i] = (v[i] / l) * s;
      }
    }
    if (m.turbulence) {
      // Turbulence before limiting (no collision here, so always applied).
      const influence = m.turbInfluenceOverLife
        ? tex(m.turbInfluenceOverLife, lp)
        : 1;
      const nd = v3b;
      m.noiseDirection(x[9], x[10], x[11], this.time, nd);
      const nl = Math.hypot(nd[0], nd[1], nd[2]) || 1;
      const infl =
        Math.min(Math.max(dy.turbInfluence * influence, 0), 1) *
        (DELTA <= 0 ? 0 : 1);
      let mag = Math.hypot(v[0], v[1], v[2]);
      for (let i = 0; i < 3; i++)
        v[i] = mix(v[i], (nd[i] / nl) * mag * (1 + (1 - infl) * 0.2), infl);
      mag = Math.hypot(ctrl0, ctrl1, ctrl2);
      ctrl0 = mix(ctrl0, (nd[0] / nl) * mag * (1 + (1 - infl) * 0.2), infl);
      ctrl1 = mix(ctrl1, (nd[1] / nl) * mag * (1 + (1 - infl) * 0.2), infl);
      ctrl2 = mix(ctrl2, (nd[2] / nl) * mag * (1 + (1 - infl) * 0.2), infl);
    }
    let fv0 = ctrl0 + v[0];
    let fv1 = ctrl1 + v[1];
    let fv2 = ctrl2 + v[2];
    if (m.velocityLimitCurve) {
      const l = Math.hypot(fv0, fv1, fv2);
      if (l > 0.001) {
        const k = Math.min(
          Math.abs(l),
          Math.abs(tex(m.velocityLimitCurve, lp)),
        );
        fv0 = (fv0 / l) * k;
        fv1 = (fv1 / l) * k;
        fv2 = (fv2 / l) * k;
      }
    }
    if (m.disableZ) fv2 = 0;
    x[9] += fv0 * DELTA;
    x[10] += fv1 * DELTA;
    x[11] += fv2 * DELTA;
    processDisplay(m, d, lp);
    let angle = dy.angle;
    if (m.angleTexture) angle *= tex(m.angleTexture, lp);
    angle +=
      p.custom[1] *
      LIFETIME *
      dy.angularVelocity *
      (m.angularVelocityTexture ? tex(m.angularVelocityTexture, lp) : 1);
    p.custom[0] = angle * (PI_SHADER / 180);
    p.color.set(d.color);
    if (m.disableZ) {
      if (m.alignY) {
        const fl = Math.hypot(fv0, fv1, fv2);
        let y0: number;
        let y1: number;
        let y2: number;
        if (fl > 0) {
          y0 = fv0 / fl;
          y1 = fv1 / fl;
          y2 = fv2 / fl;
        } else {
          const l = Math.hypot(x[3], x[4], x[5]) || 1;
          y0 = x[3] / l;
          y1 = x[4] / l;
          y2 = x[5] / l;
        }
        // x = normalize(cross(y, z)), z = (0, 0, 1)
        const z0 = x[6];
        const z1 = x[7];
        const z2 = x[8];
        const cr0 = y1 * z2 - y2 * z1;
        const cr1 = y2 * z0 - y0 * z2;
        const cr2 = y0 * z1 - y1 * z0;
        const cl = Math.hypot(cr0, cr1, cr2) || 1;
        x[0] = cr0 / cl;
        x[1] = cr1 / cl;
        x[2] = cr2 / cl;
        x[3] = y0;
        x[4] = y1;
        x[5] = y2;
        x[6] = 0;
        x[7] = 0;
        x[8] = 1;
      } else {
        const a = p.custom[0];
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        x[0] = ca;
        x[1] = -sa;
        x[2] = 0;
        x[3] = sa;
        x[4] = ca;
        x[5] = 0;
        x[6] = 0;
        x[7] = 0;
        x[8] = 1;
      }
    } else {
      for (let k = 0; k < 3; k++) {
        const l = Math.hypot(x[k * 3], x[k * 3 + 1], x[k * 3 + 2]) || 1;
        x[k * 3] /= l;
        x[k * 3 + 1] /= l;
        x[k * 3 + 2] /= l;
      }
      if (m.rotateY) {
        const a = p.custom[0];
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        x[0] = ca;
        x[1] = 0;
        x[2] = -sa;
        x[3] = 0;
        x[4] = 1;
        x[5] = 0;
        x[6] = sa;
        x[7] = 0;
        x[8] = ca;
      }
    }
    if (m.disableZ) x[11] = 0;
    if (m.scaleOverVelocityCurve) {
      const s = this.s4;
      const l = Math.hypot(fv0, fv1, fv2);
      const range = m.scaleOverVelocityRange;
      const u = l > 0.001 ? Math.min(Math.max(l / range, 0), 1) : 0;
      sampleCurve(m.scaleOverVelocityCurve, u, 0, s);
      d.scale[0] *= s[0];
      d.scale[1] *= s[1];
      d.scale[2] *= s[2];
    }
    for (let k = 0; k < 3; k++) {
      const sc =
        (d.scale[k] < 0 ? -1 : 1) * Math.max(Math.abs(d.scale[k]), 0.001);
      x[k * 3] *= sc;
      x[k * 3 + 1] *= sc;
      x[k * 3 + 2] *= sc;
    }
    p.custom[2] = d.animOffset + lp * d.animSpeed;
    if (p.custom[1] > p.custom[3]) p.active = false;
  }

  /**
   * particles_copy.glsl into `out`, 16 floats per particle in the 2D multimesh layout: transform
   * rows `[X.x, Y.x, Z.x, O.x, X.y, Y.y, Z.y, O.y]`, colour RGBA, custom RGBA. An inactive
   * particle is all zeros (no area). Returns the instance count (the emitter's amount).
   */
  pack(out: Float32Array): number {
    const c = this.config;
    const n = this.particles.length;
    let inv: Float64Array | null = null;
    if (!c.localCoords) {
      inv = this.inv;
      affineInverse(c.emissionTransform, inv);
    }
    const rem = c.interpolate ? this.frameRemainder : 0;
    let split = 0;
    if (
      (c.drawOrder === "lifetime" || c.drawOrder === "reverse_lifetime") &&
      n > 0
    ) {
      split = (Math.min(Math.floor(n * this.phase), n - 1) + 1) % n;
    }
    const col = this.v3;
    for (let k = 0; k < n; k++) {
      let i = k;
      if (c.drawOrder === "lifetime") i = (split + k) % n;
      else if (c.drawOrder === "reverse_lifetime") i = (split + n - 1 - k) % n;
      const p = this.particles[i];
      const o = k * 16;
      if (!p.active) {
        out.fill(0, o, o + 16);
        continue;
      }
      const x = p.xform;
      const v = p.velocity;
      // columns X, Y, Z, O
      const ox = x[9] + v[0] * rem;
      const oy = x[10] + v[1] * rem;
      const oz = x[11] + v[2] * rem;
      if (inv) {
        xf(inv, x[0], x[1], x[2], 0, col);
        out[o] = col[0];
        out[o + 4] = col[1];
        xf(inv, x[3], x[4], x[5], 0, col);
        out[o + 1] = col[0];
        out[o + 5] = col[1];
        xf(inv, x[6], x[7], x[8], 0, col);
        out[o + 2] = col[0];
        out[o + 6] = col[1];
        xf(inv, ox, oy, oz, 1, col);
        out[o + 3] = col[0];
        out[o + 7] = col[1];
      } else {
        out[o] = x[0];
        out[o + 1] = x[3];
        out[o + 2] = x[6];
        out[o + 3] = ox;
        out[o + 4] = x[1];
        out[o + 5] = x[4];
        out[o + 6] = x[7];
        out[o + 7] = oy;
      }
      out[o + 8] = p.color[0];
      out[o + 9] = p.color[1];
      out[o + 10] = p.color[2];
      out[o + 11] = p.color[3];
      out[o + 12] = p.custom[0];
      out[o + 13] = p.custom[1];
      out[o + 14] = p.custom[2];
      out[o + 15] = p.custom[3];
    }
    return n;
  }

  /** Particles active now (evidence and tests). */
  activeCount(): number {
    let n = 0;
    for (const p of this.particles) if (p.active) n++;
    return n;
  }
}

/** Floats per instance `GodotGpuEmitter.pack` writes. */
export const GODOT_GPU_INSTANCE_FLOATS = 16;
