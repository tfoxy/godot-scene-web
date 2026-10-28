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
// into a 2D multimesh-layout instance buffer (`packGodotGpuInstances`).

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
// float32 where the hash lives (`fract` of a product by 2365.95 is where precision shows).

const f32 = Math.fround;

function fract(x: number): number {
  return f32(x - Math.floor(x));
}

function grad(p: readonly number[], out: number[]): void {
  const d = (a: readonly number[]) =>
    f32(p[0] * a[0] + p[1] * a[1] + p[2] * a[2] + p[3] * a[3]);
  const q = [
    fract(d([0.143081, 0.001724, 0.280166, 0.262771])),
    fract(d([0.645401, -0.047791, -0.146698, 0.595016])),
    fract(d([-0.499665, -0.095734, 0.425674, -0.207367])),
    fract(d([-0.013596, -0.848588, 0.423736, 0.17044])),
  ];
  for (let i = 0; i < 4; i++)
    out[i] = fract(f32(f32(q[i] * q[(i + 1) % 4]) * 2365.952041)) * 2 - 1;
}

const CORNERS: readonly (readonly number[])[] = Array.from(
  { length: 16 },
  (_, k) => [k & 1, (k >> 1) & 1, (k >> 2) & 1, (k >> 3) & 1],
);

function noise4(c: readonly number[]): number {
  const s =
    c[0] * -0.1666667 + c[1] * -0.1666667 + c[2] * -0.1666667 + c[3] * -0.5;
  const coord = [
    c[0] + s,
    c[1] + s,
    c[2] + s,
    (c[0] + c[1] + c[2] + c[3]) * 0.5,
  ];
  const base = coord.map(Math.floor);
  const delta = coord.map((v, i) => v - base[i]);
  const r: number[] = [];
  const g = [0, 0, 0, 0];
  for (const k of CORNERS) {
    grad([base[0] + k[0], base[1] + k[1], base[2] + k[2], base[3] + k[3]], g);
    r.push(
      (delta[0] - k[0]) * g[0] +
        (delta[1] - k[1]) * g[1] +
        (delta[2] - k[2]) * g[2] +
        (delta[3] - k[3]) * g[3],
    );
  }
  const fade = delta.map((d) => d * d * d * (10 + d * (-15 + d * 6)));
  // r is indexed x + 2y + 4z + 8w: mix over w, then z, then y, then x.
  const w = r.slice(0, 8).map((v, i) => mix(v, r[i + 8], fade[3]));
  const z = w.slice(0, 4).map((v, i) => mix(v, w[i + 4], fade[2]));
  const y = [mix(z[0], z[2], fade[1]), mix(z[1], z[3], fade[1])];
  return mix(y[0], y[1], fade[0]);
}

function noise3x(p: readonly number[], out: number[]): void {
  const o = 1.7320508 * 2048.333333;
  out[0] = noise4(p);
  out[1] = noise4([p[0], p[1], p[2], p[3] + o]);
  out[2] = noise4([p[0], p[1], p[2], p[3] - o]);
}

function curl3d(p: readonly number[], c: number, out: number[]): void {
  const e = 0.001 + c;
  const at = (i: number, sgn: number) => {
    const q = [p[0], p[1], p[2], p[3]];
    q[i] += sgn * e;
    const r = [0, 0, 0];
    noise3x(q, r);
    return r;
  };
  const x0 = at(0, -1);
  const x1 = at(0, 1);
  const y0 = at(1, -1);
  const y1 = at(1, 1);
  const z0 = at(2, -1);
  const z1 = at(2, 1);
  const x = y1[2] - y0[2] - (z1[1] - z0[1]);
  const y = z1[0] - z0[0] - (x1[2] - x0[2]);
  const z = x1[1] - x0[1] - (y1[0] - y0[0]);
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
  out: number[],
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

// ------------------------------------------------------------------------------- the material

/** The material's uniforms and samplers resolved once per configuration. */
class Material {
  readonly m: GodotProcessMaterial;
  readonly disableZ: boolean;
  readonly alignY: boolean;
  readonly rotateY: boolean;
  readonly friction: boolean;
  private readonly tmp = [0, 0, 0, 0];

  constructor(m: GodotProcessMaterial) {
    this.m = m;
    this.disableZ = m.flags.includes("disable_z");
    this.alignY = m.flags.includes("align_y_to_velocity");
    this.rotateY = m.flags.includes("rotate_y");
    this.friction = m.flags.includes("damping_as_friction");
  }

  f(name: string, fallback = 0): number {
    const v = this.m.uniforms[name];
    if (typeof v === "number") return v;
    if (Array.isArray(v) && typeof v[0] === "number") return v[0];
    return fallback;
  }

  v3(name: string, fallback: readonly number[]): [number, number, number] {
    const v = this.m.uniforms[name];
    if (Array.isArray(v) && v.length >= 3) return [v[0], v[1], v[2]];
    return [fallback[0], fallback[1], fallback[2]];
  }

  v4(
    name: string,
    fallback: readonly number[],
  ): [number, number, number, number] {
    const v = this.m.uniforms[name];
    if (Array.isArray(v) && v.length >= 4) return [v[0], v[1], v[2], v[3]];
    return [fallback[0], fallback[1], fallback[2], fallback[3]];
  }

  /** The generated `get_noise_direction` at the shader's `TIME`. */
  noiseDirection(pos: readonly number[], time: number, out: number[]): void {
    const strength = this.f("turbulence_noise_strength", 1);
    const scale = this.f("turbulence_noise_scale", 9);
    const speed = this.v3("turbulence_noise_speed", [0, 0, 0]);
    const speedRandom = this.f("turbulence_noise_speed_random", 0.2);
    const contrast = Math.max(strength - 1, 0) * 70;
    curl3d(
      [
        pos[0] * scale + time * speed[0],
        pos[1] * scale + time * speed[1],
        pos[2] * scale + time * speed[2],
        time * speedRandom,
      ],
      contrast,
      out,
    );
    const k = mix(0.9, 1, strength - 9);
    out[0] *= k;
    out[1] *= k;
    out[2] *= k;
  }

  has(sampler: string): boolean {
    return this.m.curves[sampler] !== undefined;
  }

  /** `texture(sampler, vec2(t))`, channel `c`; `fallback` when the sampler is not compiled in. */
  tex(sampler: string, t: number, c = 0): number {
    const s = this.m.curves[sampler];
    if (!s) return 1;
    sampleCurve(s, t, t, this.tmp);
    return this.tmp[c];
  }

  tex4(sampler: string, t: number, out: number[]): boolean {
    const s = this.m.curves[sampler];
    if (!s) return false;
    sampleCurve(s, t, t, out);
    return true;
  }
}

interface Display {
  scale: [number, number, number];
  hue: number;
  animSpeed: number;
  animOffset: number;
  lifetime: number;
  color: [number, number, number, number];
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

function initialDisplay(m: Material, seed: { v: number }, out: Display): void {
  const s = mix(
    m.f("scale_min", 1),
    m.f("scale_max", 1),
    godotRandFromSeed(seed),
  );
  const sc = Math.sign(s) * Math.max(Math.abs(s), 0.001);
  out.scale[0] = sc;
  out.scale[1] = sc;
  out.scale[2] = sc;
  out.hue =
    PI_SHADER *
    2 *
    mix(
      m.f("hue_variation_min"),
      m.f("hue_variation_max"),
      godotRandFromSeed(seed),
    );
  out.animSpeed = mix(
    m.f("anim_speed_min"),
    m.f("anim_speed_max"),
    godotRandFromSeed(seed),
  );
  out.animOffset = mix(
    m.f("anim_offset_min"),
    m.f("anim_offset_max"),
    godotRandFromSeed(seed),
  );
  out.lifetime = 1 - m.f("lifetime_randomness") * godotRandFromSeed(seed);
  const c = m.v4("color_value", [1, 1, 1, 1]);
  out.color[0] = c[0];
  out.color[1] = c[1];
  out.color[2] = c[2];
  out.color[3] = c[3];
  if (m.has("color_initial_ramp")) {
    const r = [0, 0, 0, 0];
    m.tex4("color_initial_ramp", godotRandFromSeed(seed), r);
    for (let i = 0; i < 4; i++) out.color[i] *= r[i];
  }
  if (
    m.m.emissionShape === "points" ||
    m.m.emissionShape === "directed_points"
  ) {
    godotRandFromSeed(seed); // emission_texture_position
  }
}

function initialDynamics(
  m: Material,
  seed: { v: number },
  out: Dynamics,
): void {
  out.angle = mix(
    m.f("initial_angle_min"),
    m.f("initial_angle_max"),
    godotRandFromSeed(seed),
  );
  out.angularVelocity = mix(
    m.f("angular_velocity_min"),
    m.f("angular_velocity_max"),
    godotRandFromSeed(seed),
  );
  out.initialVelocity = mix(
    m.f("initial_linear_velocity_min"),
    m.f("initial_linear_velocity_max"),
    godotRandFromSeed(seed),
  );
  out.directionalVelocity = mix(
    m.f("directional_velocity_min"),
    m.f("directional_velocity_max"),
    godotRandFromSeed(seed),
  );
  out.radialVelocity = mix(
    m.f("radial_velocity_min"),
    m.f("radial_velocity_max"),
    godotRandFromSeed(seed),
  );
  out.orbitVelocity = mix(
    m.f("orbit_velocity_min"),
    m.f("orbit_velocity_max"),
    godotRandFromSeed(seed),
  );
  out.turbInfluence = m.m.turbulence
    ? mix(
        m.f("turbulence_influence_min"),
        m.f("turbulence_influence_max"),
        godotRandFromSeed(seed),
      )
    : 0;
}

function initialPhysical(
  m: Material,
  seed: { v: number },
  out: Physical,
): void {
  out.linear = mix(
    m.f("linear_accel_min"),
    m.f("linear_accel_max"),
    godotRandFromSeed(seed),
  );
  out.radial = mix(
    m.f("radial_accel_min"),
    m.f("radial_accel_max"),
    godotRandFromSeed(seed),
  );
  out.tangent = mix(
    m.f("tangent_accel_min"),
    m.f("tangent_accel_max"),
    godotRandFromSeed(seed),
  );
  out.damping = mix(
    m.f("damping_min"),
    m.f("damping_max"),
    godotRandFromSeed(seed),
  );
}

/** The generated `rotate_hue` (its matrices are column-major, as written). */
function rotateHue(c: number[], angle: number): void {
  const hc = Math.cos(angle);
  const hs = Math.sin(angle);
  const col = (a: number[], b: number[], d: number[]) => [
    a[0] + b[0] * hc + d[0] * hs,
    a[1] + b[1] * hc + d[1] * hs,
    a[2] + b[2] * hc + d[2] * hs,
  ];
  const c0 = col(
    [0.299, 0.587, 0.114],
    [0.701, -0.587, -0.114],
    [0.168, 0.33, -0.497],
  );
  const c1 = col(
    [0.299, 0.587, 0.114],
    [-0.299, 0.413, -0.114],
    [-0.328, 0.035, 0.292],
  );
  const c2 = col(
    [0.299, 0.587, 0.114],
    [-0.3, -0.588, 0.886],
    [1.25, -1.05, -0.203],
  );
  const r = c[0];
  const g = c[1];
  const b = c[2];
  c[0] = c0[0] * r + c1[0] * g + c2[0] * b;
  c[1] = c0[1] * r + c1[1] * g + c2[1] * b;
  c[2] = c0[2] * r + c1[2] * g + c2[2] * b;
}

/** The generated `process_display_param`. */
function processDisplay(m: Material, p: Display, t: number): void {
  if (m.has("scale_curve")) {
    const s = [0, 0, 0, 0];
    m.tex4("scale_curve", t, s);
    p.scale[0] *= s[0];
    p.scale[1] *= s[1];
    p.scale[2] *= s[2];
  }
  if (m.has("hue_rot_curve")) p.hue *= m.tex("hue_rot_curve", t);
  if (m.has("animation_offset_curve"))
    p.animOffset += m.tex("animation_offset_curve", t);
  if (m.has("animation_speed_curve"))
    p.animSpeed *= m.tex("animation_speed_curve", t);
  if (m.has("color_ramp")) {
    const r = [0, 0, 0, 0];
    m.tex4("color_ramp", t, r);
    for (let i = 0; i < 4; i++) p.color[i] *= r[i];
  }
  if (m.has("alpha_curve")) p.color[3] *= m.tex("alpha_curve", t);
  rotateHue(p.color, p.hue);
  if (m.has("emission_curve")) {
    const e = 1 + m.tex("emission_curve", t);
    p.color[0] *= e;
    p.color[1] *= e;
    p.color[2] *= e;
  }
}

/** The generated `calculate_initial_position`. */
function initialPosition(
  m: Material,
  seed: { v: number },
  out: number[],
): void {
  let x = 0;
  let y = 0;
  let z = 0;
  const shape = m.m.emissionShape;
  if (shape === "sphere") {
    const r0 = m.f("emission_sphere_radius");
    const s = godotRandFromSeed(seed) * 2 - 1;
    const t = godotRandFromSeed(seed) * 2 * PI_SHADER;
    const p = godotRandFromSeed(seed);
    const radius = r0 * Math.sqrt(1 - s * s);
    x = radius * Math.cos(t) * p;
    y = radius * Math.sin(t) * p;
    z = r0 * s * p;
  } else if (shape === "sphere_surface") {
    const r0 = m.f("emission_sphere_radius");
    const s = godotRandFromSeed(seed) * 2 - 1;
    const t = godotRandFromSeed(seed) * 2 * PI_SHADER;
    const radius = r0 * Math.sqrt(1 - s * s);
    x = radius * Math.cos(t);
    y = radius * Math.sin(t);
    z = r0 * s;
  } else if (shape === "box") {
    const e = m.v3("emission_box_extents", [1, 1, 1]);
    x = (godotRandFromSeed(seed) * 2 - 1) * e[0];
    y = (godotRandFromSeed(seed) * 2 - 1) * e[1];
    z = (godotRandFromSeed(seed) * 2 - 1) * e[2];
  } else if (shape === "ring") {
    const radius = Math.max(0.001, m.f("emission_ring_radius"));
    const inner = m.f("emission_ring_inner_radius");
    const height = m.f("emission_ring_height");
    const cone = m.f("emission_ring_cone_angle", 90);
    const top = Math.max(
      radius - Math.tan(((90 - cone) * Math.PI) / 180) * height,
      0,
    );
    let yPos = godotRandFromSeed(seed);
    const skew = Math.max(Math.min(radius, top) / Math.max(radius, top), 0.5);
    yPos = radius < top ? yPos ** skew : 1 - yPos ** skew;
    const angle = godotRandFromSeed(seed) * 2 * PI_SHADER;
    let rr = Math.sqrt(
      godotRandFromSeed(seed) * (radius * radius - inner * inner) +
        inner * inner,
    );
    rr = mix(rr, rr * (top / radius), yPos);
    let axis = m.v3("emission_ring_axis", [0, 0, 1]);
    const al = Math.hypot(axis[0], axis[1], axis[2]);
    axis = al === 0 ? [0, 0, 1] : [axis[0] / al, axis[1] / al, axis[2] / al];
    let ortho: number[];
    if (Math.abs(axis[0]) === 1 && axis[1] === 0 && axis[2] === 0)
      ortho = [-axis[2], 0, axis[0]];
    else ortho = [0, axis[2], -axis[1]];
    let ol = Math.hypot(ortho[0], ortho[1], ortho[2]) || 1;
    ortho = ortho.map((v) => v / ol);
    const s = Math.sin(angle);
    const c = Math.cos(angle);
    const oc = 1 - c;
    // mat3(columns) * ortho
    const col0 = [
      c + axis[0] * axis[0] * oc,
      axis[0] * axis[1] * oc - axis[2] * s,
      axis[0] * axis[2] * oc + axis[1] * s,
    ];
    const col1 = [
      axis[0] * axis[1] * oc + s * axis[2],
      c + axis[1] * axis[1] * oc,
      axis[1] * axis[2] * oc - axis[0] * s,
    ];
    const col2 = [
      axis[2] * axis[0] * oc - axis[1] * s,
      axis[2] * axis[1] * oc + axis[0] * s,
      c + axis[2] * axis[2] * oc,
    ];
    const o = [0, 1, 2].map(
      (i) => col0[i] * ortho[0] + col1[i] * ortho[1] + col2[i] * ortho[2],
    );
    ol = Math.hypot(o[0], o[1], o[2]) || 1;
    const h = yPos * height - height / 2;
    x = (o[0] / ol) * rr + h * axis[0];
    y = (o[1] / ol) * rr + h * axis[1];
    z = (o[2] / ol) * rr + h * axis[2];
  }
  // point, and points / directed_points (no emission texture here): the origin.
  const scale = m.v3("emission_shape_scale", [1, 1, 1]);
  const offset = m.v3("emission_shape_offset", [0, 0, 0]);
  out[0] = x * scale[0] + offset[0];
  out[1] = y * scale[1] + offset[1];
  out[2] = z * scale[2] + offset[2];
}

/** The generated `get_random_direction_from_spread`. */
function spreadDirection(
  m: Material,
  seed: { v: number },
  spreadDeg: number,
  out: number[],
): void {
  const spread = spreadDeg * (PI_SHADER / 180);
  const dir = m.v3("direction", [1, 0, 0]);
  if (m.disableZ) {
    let a = randM1P1(seed) * spread;
    a +=
      dir[0] !== 0
        ? Math.atan2(dir[1], dir[0])
        : Math.sign(dir[1]) * (PI_SHADER / 2);
    out[0] = Math.cos(a);
    out[1] = Math.sin(a);
    out[2] = 0;
    return;
  }
  const flatness = m.f("flatness");
  const a1 = randM1P1(seed) * spread;
  const a2 = randM1P1(seed) * spread * (1 - flatness);
  const xz = [Math.sin(a1), 0, Math.cos(a1)];
  const yz = [0, Math.sin(a2), Math.cos(a2)];
  yz[2] = yz[2] / Math.max(0.0001, Math.sqrt(Math.abs(yz[2])));
  const sd = [xz[0] * yz[2], yz[1], xz[2] * yz[2]];
  const dl = Math.hypot(dir[0], dir[1], dir[2]);
  const n = dl > 0 ? [dir[0] / dl, dir[1] / dl, dir[2] / dl] : [0, 0, 1];
  let bi = [n[2], 0, -n[0]]; // cross((0,1,0), n)
  let bl = Math.hypot(bi[0], bi[1], bi[2]);
  if (bl < 0.0001) {
    bi = [0, 0, 1];
    bl = 1;
  }
  bi = bi.map((v) => v / bl);
  const nm = [
    bi[1] * n[2] - bi[2] * n[1],
    bi[2] * n[0] - bi[0] * n[2],
    bi[0] * n[1] - bi[1] * n[0],
  ];
  const r = [0, 1, 2].map((i) => bi[i] * sd[0] + nm[i] * sd[1] + n[i] * sd[2]);
  const rl = Math.hypot(r[0], r[1], r[2]) || 1;
  out[0] = r[0] / rl;
  out[1] = r[1] / rl;
  out[2] = r[2] / rl;
}

// ------------------------------------------------------------------------------- the emitter

/** `Transform3D` (memory order) applied to a point (w = 1) or a vector (w = 0). */
function xf(
  t: readonly number[],
  v: readonly number[],
  w: number,
  out: number[],
): void {
  const x = v[0];
  const y = v[1];
  const z = v[2];
  out[0] = t[0] * x + t[1] * y + t[2] * z + t[9] * w;
  out[1] = t[3] * x + t[4] * y + t[5] * z + t[10] * w;
  out[2] = t[6] * x + t[7] * y + t[8] * z + t[11] * w;
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function affineInverse(t: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = t;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (det === 0) return [...IDENTITY];
  const r = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  const o = [t[9], t[10], t[11]];
  return [
    ...r,
    -(r[0] * o[0] + r[1] * o[1] + r[2] * o[2]),
    -(r[3] * o[0] + r[4] * o[1] + r[5] * o[2]),
    -(r[6] * o[0] + r[7] * o[1] + r[8] * o[2]),
  ];
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

/**
 * One emitter, as gl_compatibility's `ParticlesStorage` holds it. Configure with `configure`
 * (the setters), `restart` (`particles_restart`), `requestProcess` (`particles_request_process_time`),
 * then `update(frameDelta)` once per drawn frame and `pack` the instances.
 */
export class GodotGpuEmitter {
  config: GodotGpuEmitterConfig;
  private mat: Material;
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
  readonly stats: GodotGpuStats = { steps: 0, restarts: 0, processRequests: 0 };

  constructor(config: GodotGpuEmitterConfig) {
    this.config = config;
    this.mat = new Material(config.material);
    this.emitting = config.emitting;
    this.resize(config.amount);
  }

  /** Apply a new configuration (the setters that changed). `emitting` is set only when the
   * caller's value changed (`setEmitting`), as a RenderingServer setter is. An amount change
   * clears the emitter, as `particles_set_amount` does. */
  configure(config: GodotGpuEmitterConfig): void {
    if (config.amount !== this.config.amount) {
      this.resize(config.amount);
      this.phase = 0;
      this.clear = true;
    }
    if (config.material !== this.config.material)
      this.mat = new Material(config.material);
    this.config = config;
  }

  setEmitting(on: boolean): void {
    this.emitting = on;
  }

  /** `particles_restart`. */
  restart(): void {
    this.restartRequest = true;
    this.stats.restarts++;
  }

  /** `particles_request_process_time`. */
  requestProcess(time: number): void {
    this.requestTime = time;
    this.stats.processRequests++;
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
      });
  }

  /** `update_particles` for this emitter, given the renderer's frame delta (seconds) and its
   * total time (the shader's `TIME`; turbulence reads it), by default advanced by the delta. */
  update(frameDelta: number, time = this.time + frameDelta): void {
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
      const ft = 1 / (fixed > 0 ? fixed : 30);
      let todo = c.preProcessTime;
      while (todo >= 0) {
        this.process(ft, c.speedScale);
        todo -= ft;
      }
    }
    const timeScale = Math.max(c.speedScale, 0);
    if (fixed > 0) {
      const ft = 1 / fixed;
      let delta = frameDelta;
      if (delta > 0.1) delta = 0.1;
      else if (delta <= 0) delta = 0.001;
      let todo = this.frameRemainder + delta * timeScale;
      while (todo >= ft) {
        this.process(ft, c.speedScale);
        todo -= ft;
      }
      this.frameRemainder = todo;
    } else {
      this.process(frameDelta * timeScale, c.speedScale);
    }
    if (this.requestTime > 0) {
      const ft = 1 / (fixed > 0 ? fixed : 30);
      let todo = this.requestTime;
      while (todo >= 0) {
        this.process(ft, 1);
        todo -= ft;
      }
      this.requestTime = 0;
    }
  }

  /** `_particles_process(delta)`: one pass of the process shader over every particle. */
  private process(delta: number, _speedScale: number): void {
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
    const total = this.particles.length;
    for (let index = 0; index < total; index++) {
      this.shade(
        this.particles[index],
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
    const DELTA = localDelta;
    const ev = c.emitterVelocity;
    const v3 = [0, 0, 0];
    const v3b = [0, 0, 0];
    if (restart) {
      // START
      const seed = {
        v: godotParticleHash((number + 1 + (c.seed >>> 0)) >>> 0),
      };
      const d: Display = {
        scale: [1, 1, 1],
        hue: 0,
        animSpeed: 0,
        animOffset: 0,
        lifetime: 1,
        color: [1, 1, 1, 1],
      };
      initialDisplay(m, seed, d);
      const dy: Dynamics = {
        angle: 0,
        angularVelocity: 0,
        initialVelocity: 0,
        directionalVelocity: 0,
        radialVelocity: 0,
        orbitVelocity: 0,
        turbInfluence: 0,
      };
      initialDynamics(m, seed, dy);
      const ph: Physical = { linear: 0, radial: 0, tangent: 0, damping: 0 };
      initialPhysical(m, seed, ph);
      processDisplay(m, d, 0);
      if (godotRandFromSeed(seed) > c.amountRatio) p.active = false;
      p.custom.fill(0);
      p.custom[3] = d.lifetime;
      p.custom[0] = dy.angle;
      p.color.set(d.color);
      // RESTART_ROT_SCALE then RESTART_POSITION: TRANSFORM = EMISSION_TRANSFORM * TRANSFORM.
      initialPosition(m, seed, v3);
      if (m.m.turbulence) {
        const disp = mix(
          m.f("turbulence_initial_displacement_min"),
          m.f("turbulence_initial_displacement_max"),
          godotRandFromSeed(seed),
        );
        m.noiseDirection(v3, this.time, v3b);
        v3[0] += v3b[0] * disp;
        v3[1] += v3b[1] * disp;
        v3[2] += v3b[2] * disp;
      }
      for (let i = 0; i < 9; i++) p.xform[i] = 0;
      // basis columns = emission basis columns (E * identity)
      p.xform[0] = emission[0];
      p.xform[1] = emission[3];
      p.xform[2] = emission[6];
      p.xform[3] = emission[1];
      p.xform[4] = emission[4];
      p.xform[5] = emission[7];
      p.xform[6] = emission[2];
      p.xform[7] = emission[5];
      p.xform[8] = emission[8];
      xf(emission, v3, 1, v3b);
      p.xform[9] = v3b[0];
      p.xform[10] = v3b[1];
      p.xform[11] = v3b[2];
      spreadDirection(m, seed, m.f("spread"), v3);
      v3[0] *= dy.initialVelocity;
      v3[1] *= dy.initialVelocity;
      v3[2] *= dy.initialVelocity;
      xf(emission, v3, 0, v3b);
      const inherit = m.f("inherit_emitter_velocity_ratio");
      p.velocity[0] = v3b[0] + (ev[0] ?? 0) * inherit;
      p.velocity[1] = v3b[1] + (ev[1] ?? 0) * inherit;
      p.velocity[2] = v3b[2] + (ev[2] ?? 0) * inherit;
      if (m.disableZ) {
        p.velocity[2] = 0;
        p.xform[11] = 0;
      }
      if (!p.active) return;
    }
    // PROCESS
    const seed = { v: godotParticleHash((number + 1 + (c.seed >>> 0)) >>> 0) };
    const d: Display = {
      scale: [1, 1, 1],
      hue: 0,
      animSpeed: 0,
      animOffset: 0,
      lifetime: 1,
      color: [1, 1, 1, 1],
    };
    initialDisplay(m, seed, d);
    const dy: Dynamics = {
      angle: 0,
      angularVelocity: 0,
      initialVelocity: 0,
      directionalVelocity: 0,
      radialVelocity: 0,
      orbitVelocity: 0,
      turbInfluence: 0,
    };
    initialDynamics(m, seed, dy);
    const ph: Physical = { linear: 0, radial: 0, tangent: 0, damping: 0 };
    initialPhysical(m, seed, ph);
    const LIFETIME = lifetime;
    p.custom[1] += DELTA / LIFETIME;
    p.custom[1] = mix(p.custom[1], 1, c.interpToEnd);
    const lp = p.custom[1] / d.lifetime;
    if (p.custom[1] > p.custom[3]) p.active = false;
    const pos = [p.xform[9], p.xform[10], p.xform[11]];
    const org = [emission[9], emission[10], emission[11]];
    const ctrl = [0, 0, 0];
    // orbit (2D: disable_z, or an orbit curve)
    if (m.disableZ || m.has("orbit_velocity_curve")) {
      if (!(Math.abs(dy.orbitVelocity) < 0.01 || DELTA < 0.001)) {
        if (m.disableZ) {
          let amount = dy.orbitVelocity;
          if (m.has("orbit_velocity_curve"))
            amount *= m.tex("orbit_velocity_curve", lp, 0);
          if (amount !== 0) {
            const dx = pos[0] - org[0];
            const dyy = pos[1] - org[1];
            const ang = amount * PI_SHADER * 2 * DELTA;
            const cs = Math.cos(ang);
            const sn = Math.sin(ang);
            const disp = [
              cs * dx + sn * dyy - dx,
              -sn * dx + cs * dyy - dyy,
              0,
            ];
            xf(emission, [disp[0] / DELTA, disp[1] / DELTA, 0], 0, v3);
            ctrl[0] += v3[0];
            ctrl[1] += v3[1];
            ctrl[2] += v3[2];
          }
        }
        // 3D orbit over a curve: not modelled (a 2D canvas emitter is disable_z).
      }
    }
    // radial velocity
    if (DELTA >= 0.001) {
      const mult = m.has("radial_velocity_curve")
        ? m.tex("radial_velocity_curve", lp, 0)
        : 1;
      const pivot = [0, 0, 0];
      xf(emission, m.v3("velocity_pivot", [0, 0, 0]), 1, pivot);
      const rel = [pos[0] - pivot[0], pos[1] - pivot[1], pos[2] - pivot[2]];
      const rl = Math.hypot(rel[0], rel[1], rel[2]);
      let rd: number[];
      if (rl > 0.01) rd = rel.map((v) => (v / rl) * mult * dy.radialVelocity);
      else {
        spreadDirection(m, seed, 360, v3);
        rd = [
          v3[0] * dy.radialVelocity,
          v3[1] * dy.radialVelocity,
          v3[2] * dy.radialVelocity,
        ];
      }
      if (mult * dy.radialVelocity < 0) {
        const l = Math.hypot(rd[0], rd[1], rd[2]) || 1;
        const k = Math.min(Math.abs(mult * dy.radialVelocity), rl / DELTA);
        rd = rd.map((v) => (v / l) * k);
      }
      ctrl[0] += rd[0];
      ctrl[1] += rd[1];
      ctrl[2] += rd[2];
    }
    if (m.has("directional_velocity_curve")) {
      const s = [0, 0, 0, 0];
      m.tex4("directional_velocity_curve", lp, s);
      let dv = [
        s[0] * dy.directionalVelocity,
        s[1] * dy.directionalVelocity,
        s[2] * dy.directionalVelocity,
      ];
      if (m.f("directional_velocity_global") !== 0) {
        xf(emission, dv, 0, v3);
        dv = [v3[0], v3[1], v3[2]];
      }
      ctrl[0] += dv[0];
      ctrl[1] += dv[1];
      ctrl[2] += dv[2];
    }
    if (m.has("linear_accel_texture"))
      ph.linear *= m.tex("linear_accel_texture", lp);
    if (m.has("radial_accel_texture"))
      ph.radial *= m.tex("radial_accel_texture", lp);
    if (m.has("tangent_accel_texture"))
      ph.tangent *= m.tex("tangent_accel_texture", lp);
    if (m.has("damping_texture")) ph.damping *= m.tex("damping_texture", lp);
    {
      const g = m.v3("gravity", [0, -9.8, 0]);
      const f = [g[0], g[1], g[2]];
      const v = p.velocity;
      const vl = Math.hypot(v[0], v[1], v[2]);
      if (vl > 0) for (let i = 0; i < 3; i++) f[i] += (v[i] / vl) * ph.linear;
      const diff = [pos[0] - org[0], pos[1] - org[1], pos[2] - org[2]];
      const dl = Math.hypot(diff[0], diff[1], diff[2]);
      if (dl > 0)
        for (let i = 0; i < 3; i++) f[i] += (diff[i] / dl) * ph.radial;
      if (m.disableZ) {
        const tl = Math.hypot(diff[1], diff[0]);
        if (tl > 0) {
          f[0] += (-diff[1] / tl) * ph.tangent;
          f[1] += (diff[0] / tl) * ph.tangent;
        }
        f[2] = 0;
      } else if (dl > 0) {
        const gl = Math.hypot(g[0], g[1], g[2]);
        if (gl > 0) {
          const a = diff.map((x) => x / dl);
          const b = g.map((x) => x / gl);
          const cr = [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
          ];
          const cl = Math.hypot(cr[0], cr[1], cr[2]);
          if (cl > 0)
            for (let i = 0; i < 3; i++) f[i] += (cr[i] / cl) * ph.tangent;
        }
      }
      for (let i = 0; i < 3; i++) v[i] += f[i] * DELTA;
    }
    if (ph.damping > 0) {
      const v = p.velocity;
      let s = Math.hypot(v[0], v[1], v[2]);
      if (!m.friction) s -= ph.damping * DELTA;
      else if (s > 0.001) s -= s * s * ph.damping * 0.05 * DELTA;
      if (s < 0) v.fill(0);
      else {
        const l = Math.hypot(v[0], v[1], v[2]);
        if (l > 0) for (let i = 0; i < 3; i++) v[i] = (v[i] / l) * s;
      }
    }
    if (m.m.turbulence) {
      // Turbulence before limiting (no collision here, so always applied).
      const influence = m.has("turbulence_influence_over_life")
        ? m.tex("turbulence_influence_over_life", lp)
        : 1;
      const nd = [0, 0, 0];
      m.noiseDirection([p.xform[9], p.xform[10], p.xform[11]], this.time, nd);
      const nl = Math.hypot(nd[0], nd[1], nd[2]) || 1;
      const infl =
        Math.min(Math.max(dy.turbInfluence * influence, 0), 1) *
        (DELTA <= 0 ? 0 : 1);
      const v = p.velocity;
      let mag = Math.hypot(v[0], v[1], v[2]);
      for (let i = 0; i < 3; i++)
        v[i] = mix(v[i], (nd[i] / nl) * mag * (1 + (1 - infl) * 0.2), infl);
      mag = Math.hypot(ctrl[0], ctrl[1], ctrl[2]);
      for (let i = 0; i < 3; i++)
        ctrl[i] = mix(
          ctrl[i],
          (nd[i] / nl) * mag * (1 + (1 - infl) * 0.2),
          infl,
        );
    }
    const fv = [
      ctrl[0] + p.velocity[0],
      ctrl[1] + p.velocity[1],
      ctrl[2] + p.velocity[2],
    ];
    if (m.has("velocity_limit_curve")) {
      const l = Math.hypot(fv[0], fv[1], fv[2]);
      if (l > 0.001) {
        const k = Math.min(
          Math.abs(l),
          Math.abs(m.tex("velocity_limit_curve", lp)),
        );
        for (let i = 0; i < 3; i++) fv[i] = (fv[i] / l) * k;
      }
    }
    if (m.disableZ) fv[2] = 0;
    p.xform[9] += fv[0] * DELTA;
    p.xform[10] += fv[1] * DELTA;
    p.xform[11] += fv[2] * DELTA;
    processDisplay(m, d, lp);
    let angle = dy.angle;
    if (m.has("angle_texture")) angle *= m.tex("angle_texture", lp);
    angle +=
      p.custom[1] *
      LIFETIME *
      dy.angularVelocity *
      (m.has("angular_velocity_texture")
        ? m.tex("angular_velocity_texture", lp)
        : 1);
    p.custom[0] = angle * (PI_SHADER / 180);
    p.color.set(d.color);
    const x = p.xform;
    if (m.disableZ) {
      if (m.alignY) {
        const fl = Math.hypot(fv[0], fv[1], fv[2]);
        let yv: number[];
        if (fl > 0) yv = fv.map((q) => q / fl);
        else {
          const l = Math.hypot(x[3], x[4], x[5]) || 1;
          yv = [x[3] / l, x[4] / l, x[5] / l];
        }
        // x = normalize(cross(y, z)), z = (0, 0, 1)
        const zc = [x[6], x[7], x[8]];
        const cr = [
          yv[1] * zc[2] - yv[2] * zc[1],
          yv[2] * zc[0] - yv[0] * zc[2],
          yv[0] * zc[1] - yv[1] * zc[0],
        ];
        const cl = Math.hypot(cr[0], cr[1], cr[2]) || 1;
        x.set(
          [cr[0] / cl, cr[1] / cl, cr[2] / cl, yv[0], yv[1], yv[2], 0, 0, 1],
          0,
        );
      } else {
        const a = p.custom[0];
        x.set(
          [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1],
          0,
        );
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
        x.set(
          [Math.cos(a), 0, -Math.sin(a), 0, 1, 0, Math.sin(a), 0, Math.cos(a)],
          0,
        );
      }
    }
    if (m.disableZ) x[11] = 0;
    if (m.has("scale_over_velocity_curve")) {
      const s = [0, 0, 0, 0];
      const l = Math.hypot(fv[0], fv[1], fv[2]);
      const range =
        m.f("scale_over_velocity_max", 5) - m.f("scale_over_velocity_min", 0);
      const u = l > 0.001 ? Math.min(Math.max(l / range, 0), 1) : 0;
      const t = m.m.curves.scale_over_velocity_curve;
      sampleCurve(t, u, 0, s);
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
    const inv = c.localCoords ? null : affineInverse(c.emissionTransform);
    const rem = c.interpolate ? this.frameRemainder : 0;
    let split = 0;
    if (
      (c.drawOrder === "lifetime" || c.drawOrder === "reverse_lifetime") &&
      n > 0
    ) {
      split = (Math.min(Math.floor(n * this.phase), n - 1) + 1) % n;
    }
    const col = [0, 0, 0];
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
      // columns X, Y, Z, O
      let cols = [
        [x[0], x[1], x[2]],
        [x[3], x[4], x[5]],
        [x[6], x[7], x[8]],
        [
          x[9] + p.velocity[0] * rem,
          x[10] + p.velocity[1] * rem,
          x[11] + p.velocity[2] * rem,
        ],
      ];
      if (inv) {
        cols = cols.map((v, j) => {
          xf(inv, v, j === 3 ? 1 : 0, col);
          return [col[0], col[1], col[2]];
        });
      }
      out[o] = cols[0][0];
      out[o + 1] = cols[1][0];
      out[o + 2] = cols[2][0];
      out[o + 3] = cols[3][0];
      out[o + 4] = cols[0][1];
      out[o + 5] = cols[1][1];
      out[o + 6] = cols[2][1];
      out[o + 7] = cols[3][1];
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
