import {
  normalizeParticleCurve,
  type ParticleCurvePoint,
  type ParticleGradientStop,
  sampleParticleCurve,
  sampleParticleGradient,
} from "@godot-scene-web/effects/particles";

// Bakes Godot procedural texture resources (the sampler inputs of a ShaderMaterial)
// into raw RGBA pixels the WebGL runtime can upload directly — no canvas/DOM, so it
// runs and is unit-testable in plain node. Two kinds today, matching the procedural
// sampler resources a ShaderMaterial may carry:
//   - GradientTexture1D  (a `Gradient` color ramp)            -> exact.
//   - NoiseTexture2D     (a `FastNoiseLite` field)            -> a compact Perlin/FBM
//     equivalent (Godot's FastNoiseLite uses different permutation tables, so the
//     bytes differ, but the type/frequency/FBM params and look match).
//
// `material.ts` serializes the spec (pixel-free, numbers only) onto the node; the
// runtime calls `bakeTexture` to realize the pixels lazily and caches the result.

export interface GradientStop extends ParticleGradientStop {}

export interface GradientBakeSpec {
  kind: "gradient";
  /** Output width (GradientTexture1D default 256). */
  width: number;
  stops: GradientStop[];
  /**
   * Godot `Gradient.interpolation_mode`: 0/absent = LINEAR (default), 1 = CONSTANT
   * (hold each stop's color until the next — a stepped ramp), 2 = CUBIC (approximated
   * as linear). See `sampleGradient`.
   */
  interpolationMode?: number;
}

/** Godot `Gradient.GradientInterpolationMode.CONSTANT` — hold each stop, no blend. */
export const GRADIENT_INTERPOLATE_CONSTANT = 1;

export interface NoiseBakeSpec {
  kind: "noise";
  /** Output size (NoiseTexture2D default 512×512). */
  width: number;
  height: number;
  /** Godot `seamless` (edge-tiling). Not reproduced; recorded for fidelity. */
  seamless: boolean;
  /** Godot `FastNoiseLite.NoiseType` (3 = Perlin — the only type modelled exactly). */
  noiseType: number;
  /** Per-texel coordinate scale, before fractal octaves. */
  frequency: number;
  /** Godot `FastNoiseLite.FractalType` (0 = none, 1 = FBM, others approximated as FBM). */
  fractalType: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  seed: number;
}

export interface CurvePoint extends ParticleCurvePoint {}

export interface CurveBakeSpec {
  kind: "curve";
  width: number;
  channels: CurvePoint[][];
}

export type TextureBakeSpec = GradientBakeSpec | NoiseBakeSpec | CurveBakeSpec;

export interface BakedPixels {
  width: number;
  height: number;
  /** RGBA8, row-major, top-left origin. */
  data: Uint8ClampedArray;
}

// Godot enum values referenced above (FastNoiseLite).
export const NOISE_TYPE_PERLIN = 3;
export const FRACTAL_NONE = 0;

export function bakeTexture(spec: TextureBakeSpec): BakedPixels {
  if (spec.kind === "gradient") return bakeGradient(spec);
  if (spec.kind === "curve") return bakeCurve(spec);
  return bakeNoise(spec);
}

// ---- gradient --------------------------------------------------------------

export function bakeGradient(spec: GradientBakeSpec): BakedPixels {
  const width = Math.max(1, Math.round(spec.width) || 1);
  const data = new Uint8ClampedArray(width * 4);
  const stops = [...spec.stops].sort((a, b) => a.offset - b.offset);
  for (let x = 0; x < width; x += 1) {
    const t = width === 1 ? 0 : x / (width - 1);
    const [r, g, b, a] = sampleGradient(stops, t, spec.interpolationMode);
    const i = x * 4;
    data[i] = r * 255;
    data[i + 1] = g * 255;
    data[i + 2] = b * 255;
    data[i + 3] = a * 255;
  }
  return { width, height: 1, data };
}

// Godot's default Gradient interpolation is linear between adjacent stops, with the
// endpoints held constant outside the stop range. Exported so the particle runtime
// samples color ramps over particle lifetime with the SAME math the bake path uses.
//
// `interpolationMode` mirrors Godot's `Gradient.interpolation_mode`: 1 (CONSTANT) holds
// each stop's color until the NEXT stop instead of blending — STS2's VFX color LUTs are
// authored that way (a two-stop grey→white step), and blending them turns a hard edge
// into a gradient. Anything else (0 LINEAR, 2 CUBIC) uses the linear path.
export const sampleGradient = sampleParticleGradient;

// ---- curve -----------------------------------------------------------------

export function bakeCurve(spec: CurveBakeSpec): BakedPixels {
  const width = Math.max(1, Math.round(spec.width) || 1);
  const sourceChannels = spec.channels.length > 0 ? spec.channels : [[]];
  const channels = sourceChannels.map(
    (points) => normalizeParticleCurve(points) ?? [],
  );
  const data = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x += 1) {
    const t = width === 1 ? 0 : x / (width - 1);
    const r = channels[0] ? sampleParticleCurve(channels[0], t) : 0;
    const g = channels[1] ? sampleParticleCurve(channels[1], t) : r;
    const b = channels[2] ? sampleParticleCurve(channels[2], t) : r;
    const a = channels[3] ? sampleParticleCurve(channels[3], t) : 1;
    const i = x * 4;
    data[i] = clamp01(r) * 255;
    data[i + 1] = clamp01(g) * 255;
    data[i + 2] = clamp01(b) * 255;
    data[i + 3] = clamp01(a) * 255;
  }
  return { width, height: 1, data };
}

// Exported so the particle runtime samples scale/alpha curves over lifetime with the
// SAME (linear, endpoint-clamped) math the bake path uses.
export function sampleCurve(points: CurvePoint[], t: number): number {
  return sampleParticleCurve(normalizeParticleCurve(points) ?? [], t);
}

// ---- noise -----------------------------------------------------------------

export function bakeNoise(spec: NoiseBakeSpec): BakedPixels {
  const width = Math.max(1, Math.round(spec.width) || 1);
  const height = Math.max(1, Math.round(spec.height) || 1);
  const octaves =
    spec.fractalType === FRACTAL_NONE
      ? 1
      : Math.max(1, Math.round(spec.octaves) || 1);
  const lacunarity = spec.lacunarity || 2;
  const gain = spec.gain || 0.5;
  const frequency = spec.frequency || 0.01;
  const baseSeed = (spec.seed | 0) >>> 0;

  // One permutation table per octave (seed + octave), built once up front — Godot's
  // FastNoiseLite increments the seed per fractal octave to decorrelate them.
  const perms: Uint8Array[] = [];
  for (let o = 0; o < octaves; o += 1) {
    perms.push(makePerm((baseSeed + o) >>> 0));
  }
  // Normalize the FBM sum so it stays ~[-1,1] (mirrors FastNoiseLite's fractal
  // bounding = 1 / Σ gain^o, with weighted_strength left at its default 0).
  let ampSum = 0;
  for (let o = 0, amp = 1; o < octaves; o += 1, amp *= gain) ampSum += amp;
  const bounding = ampSum > 0 ? 1 / ampSum : 1;

  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let amp = 1;
      let freqMul = 1;
      for (let o = 0; o < octaves; o += 1) {
        const sx = x * frequency * freqMul;
        const sy = y * frequency * freqMul;
        sum += perlin2(perms[o], sx, sy) * amp;
        amp *= gain;
        freqMul *= lacunarity;
      }
      // FastNoiseLite returns ~[-1,1]; NoiseTexture2D remaps to [0,1] for the image.
      const v = clamp01(sum * bounding * 0.5 + 0.5);
      const g = v * 255;
      const i = (y * width + x) * 4;
      data[i] = g;
      data[i + 1] = g;
      data[i + 2] = g;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

// Seeded Fisher–Yates shuffle of 0..255, doubled to 512 (classic Perlin permutation).
function makePerm(seed: number): Uint8Array {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) p[i] = i;
  let s = seed >>> 0 || 0x9e3779b9; // xorshift32, avoid the 0 fixed point
  for (let i = 255; i > 0; i -= 1) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    const j = s % (i + 1);
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i += 1) perm[i] = p[i & 255];
  return perm;
}

// Improved-Perlin 2D gradient noise, output ~[-1,1].
function perlin2(perm: Uint8Array, x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);
  const aa = perm[perm[xi] + yi];
  const ab = perm[perm[xi] + yi + 1];
  const ba = perm[perm[xi + 1] + yi];
  const bb = perm[perm[xi + 1] + yi + 1];
  const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
  const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v);
}

// 4 diagonal gradients — the standard 2D Perlin simplification.
function grad2(hash: number, x: number, y: number): number {
  switch (hash & 3) {
    case 0:
      return x + y;
    case 1:
      return -x + y;
    case 2:
      return x - y;
    default:
      return -x - y;
  }
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
