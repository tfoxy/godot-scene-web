// Pure, DOM-free particle config + state. This is the seam the deterministic
// `simulateParticles` (in `./simulate`) mutates, and the boundary the live runtime
// (`./runtime`) and the unit tests share. No WebGL, no DOM — so the whole simulation
// is testable in plain node / jsdom (which has no GL).

import type { ParticleConfig, ParticleRenderConfig } from "./config";
import {
  linearizeParticleBaseColor,
  normalizeGodotRenderer,
} from "./godot-renderer";
import { normalizeParticleCurve } from "./sampling";

export type { ParticleConfig } from "./config";

// One simulated particle. Spawn-time randoms are stored so per-frame display
// (rotation/scale/color/flipbook) stays consistent; `seed` re-seeds the per-frame
// force RNG each step so each particle's accel/damp/orbit magnitude is fixed-but-
// distinct (mirroring Godot's per-particle force seed).
export interface Particle {
  active: boolean;
  /** Age in seconds. */
  time: number;
  /** This particle's randomized lifetime (seconds). */
  lifetime: number;
  /** Position in node-local pixels. */
  x: number;
  y: number;
  /** Velocity in px/s. */
  vx: number;
  vy: number;
  /** Rotation in radians. */
  rotation: number;
  /** Per-frame force RNG seed (stable per particle). */
  seed: number;
  angleRand: number;
  scaleRand: number;
  hueRand: number;
  animOffsetRand: number;
  /** color_initial_ramp sampled once at spawn (or white). */
  startColor: [number, number, number, number];
  // ---- per-frame display outputs (read by the renderer) ----
  scaleX: number;
  scaleY: number;
  r: number;
  g: number;
  b: number;
  a: number;
  /** Flipbook frame index. */
  frame: number;
}

export interface ParticleSystemState {
  config: ParticleConfig;
  particles: Particle[];
  /** System time within the current cycle, wrapped to [0, lifetime). */
  time: number;
  /** Number of completed lifetime cycles (drives spawn timing + one-shot end). */
  cycle: number;
  /** Live emit flag — starts at `config.emitting`, cleared after a one-shot cycle. */
  emitting: boolean;
  /** Fixed-step remainder accumulator. */
  remainder: number;
  /** Effective particle count after the maxInstances clamp. */
  count: number;
}

function makeParticle(): Particle {
  return {
    active: false,
    time: 0,
    lifetime: 1,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    rotation: 0,
    seed: 0,
    angleRand: 0,
    scaleRand: 0,
    hueRand: 0,
    animOffsetRand: 0,
    startColor: [1, 1, 1, 1],
    scaleX: 1,
    scaleY: 1,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
    frame: 0,
  };
}

const DEFAULT_MAX_INSTANCES = 2048;

export function createParticleState(
  config: ParticleConfig,
  maxInstances = DEFAULT_MAX_INSTANCES,
): ParticleSystemState {
  const count = Math.max(1, Math.min(maxInstances, Math.round(config.amount)));
  const particles: Particle[] = [];
  for (let i = 0; i < count; i += 1) {
    particles.push(makeParticle());
  }
  return {
    config,
    particles,
    time: 0,
    cycle: 0,
    emitting: config.emitting,
    remainder: 0,
    count,
  };
}

/** Whether the system still needs simulating (live particles or still emitting). */
export function particlesAreLive(state: ParticleSystemState): boolean {
  if (state.emitting) return true;
  for (const p of state.particles) {
    if (p.active) return true;
  }
  return false;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function vec2(value: unknown, fallback: [number, number]): [number, number] {
  return Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
    ? [value[0], value[1]]
    : fallback;
}

function rgba(
  value: unknown,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  return Array.isArray(value) && value.length >= 4
    ? [
        num(value[0], fallback[0]),
        num(value[1], fallback[1]),
        num(value[2], fallback[2]),
        num(value[3], fallback[3]),
      ]
    : fallback;
}

// Normalize a (possibly partial / hand-authored) parsed spec into a full config with
// Godot defaults. The build-time serializer writes every field, so this mostly fills
// defensive defaults — but it keeps the runtime robust to missing keys.
export function normalizeParticleConfig(
  raw: Partial<ParticleConfig> | null | undefined,
): ParticleConfig {
  const c = raw ?? {};
  const kind =
    c.kind === "CPUParticles2D" ? "CPUParticles2D" : "GPUParticles2D";
  const godotRenderer = normalizeGodotRenderer(c.godotRenderer);
  const baseColor = rgba(c.baseColor, [1, 1, 1, 1]);
  // A hand-authored blob that omits the flag is read as "this is the process-material
  // colour" for GPU particles (the only thing a `ParticleProcessMaterial` can be) and as
  // "node colour" for CPU ones. `visual-2d.ts` always states it explicitly.
  const baseColorFromProcessMaterial =
    typeof c.baseColorFromProcessMaterial === "boolean"
      ? c.baseColorFromProcessMaterial
      : kind === "GPUParticles2D";
  return {
    kind,
    godotRenderer,
    amount: Math.max(1, Math.round(num(c.amount, 8))),
    amountRatio: clamp01(num(c.amountRatio, 1)),
    lifetime: Math.max(0.01, num(c.lifetime, 1)),
    lifetimeRandomness: clamp01(num(c.lifetimeRandomness, 0)),
    oneShot: bool(c.oneShot, false),
    emitting: bool(c.emitting, true),
    explosiveness: clamp01(num(c.explosiveness, 0)),
    randomness: clamp01(num(c.randomness, 0)),
    preprocess: Math.max(0, num(c.preprocess, 0)),
    speedScale: num(c.speedScale, 1),
    fixedFps: Math.max(0, Math.round(num(c.fixedFps, 0))),
    localCoords: bool(c.localCoords, false),
    drawOrder: Math.round(num(c.drawOrder, 0)),
    seed: Math.round(num(c.seed, 0)),
    emissionShape: Math.round(num(c.emissionShape, 0)),
    emissionOffset: vec2(c.emissionOffset, [0, 0]),
    emissionScale: vec2(c.emissionScale, [1, 1]),
    emissionSphereRadius: num(c.emissionSphereRadius, 0),
    emissionRingRadius: num(c.emissionRingRadius, 0),
    emissionRingInnerRadius: num(c.emissionRingInnerRadius, 0),
    emissionRingHeight: num(c.emissionRingHeight, 0),
    emissionBoxExtents: vec2(c.emissionBoxExtents, [0, 0]),
    direction: vec2(c.direction, [1, 0]),
    spread: num(c.spread, 45),
    initialVelocityMin: num(c.initialVelocityMin, 0),
    initialVelocityMax: num(c.initialVelocityMax, 0),
    angleMin: num(c.angleMin, 0),
    angleMax: num(c.angleMax, 0),
    angularVelocityMin: num(c.angularVelocityMin, 0),
    angularVelocityMax: num(c.angularVelocityMax, 0),
    gravity: vec2(c.gravity, [0, 980]),
    linearAccelMin: num(c.linearAccelMin, 0),
    linearAccelMax: num(c.linearAccelMax, 0),
    radialAccelMin: num(c.radialAccelMin, 0),
    radialAccelMax: num(c.radialAccelMax, 0),
    tangentialAccelMin: num(c.tangentialAccelMin, 0),
    tangentialAccelMax: num(c.tangentialAccelMax, 0),
    dampingMin: num(c.dampingMin, 0),
    dampingMax: num(c.dampingMax, 0),
    dampingAsFriction: bool(c.dampingAsFriction, false),
    orbitVelocityMin: num(c.orbitVelocityMin, 0),
    orbitVelocityMax: num(c.orbitVelocityMax, 0),
    scaleMin: num(c.scaleMin, 1),
    scaleMax: num(c.scaleMax, 1),
    hueVariationMin: num(c.hueVariationMin, 0),
    hueVariationMax: num(c.hueVariationMax, 0),
    alignY: bool(c.alignY, false),
    baseColor,
    baseColorFromProcessMaterial,
    // THE colour-space seam. `baseColor` above stays the raw Godot inspector value; this is
    // it as `godotRenderer` uploads it, RGB through `Color::srgb_to_linear()` on the
    // RendererRD backends and untouched on Compatibility. Derived HERE, once per config,
    // rather than in `updateDisplay` — so it lands BEFORE the ramp multiply (matching
    // Godot's own composition order, see `simulate.ts`), costs nothing per frame, and is
    // inherited identically by both backends, which read the colour from the shared
    // per-instance attribute (`instance-buffer.ts`) rather than a per-backend uniform.
    baseColorRender: linearizeParticleBaseColor(
      baseColor,
      godotRenderer,
      baseColorFromProcessMaterial,
    ),
    hframes: Math.max(1, Math.round(num(c.hframes, 1))),
    vframes: Math.max(1, Math.round(num(c.vframes, 1))),
    frameCount: Math.max(0, Math.round(num(c.frameCount, 0))),
    animLoop: bool(c.animLoop, false),
    animSpeedMin: num(c.animSpeedMin, 0),
    animSpeedMax: num(c.animSpeedMax, 0),
    animOffsetMin: num(c.animOffsetMin, 0),
    animOffsetMax: num(c.animOffsetMax, 0),
    colorRamp: c.colorRamp,
    colorInitialRamp: c.colorInitialRamp,
    scaleCurve: normalizeParticleCurve(c.scaleCurve),
    scaleCurveX: normalizeParticleCurve(c.scaleCurveX),
    scaleCurveY: normalizeParticleCurve(c.scaleCurveY),
    alphaCurve: normalizeParticleCurve(c.alphaCurve),
    hueCurve: normalizeParticleCurve(c.hueCurve),
  };
}

/** Normalize portable renderer inputs without admitting HTML URL or placement fields. */
export function normalizeParticleRenderConfig(
  raw: Partial<ParticleRenderConfig> | null | undefined,
): ParticleRenderConfig {
  const value = raw ?? {};
  const erode = value.alphaErode;
  const alphaErode =
    erode && Number.isFinite(erode.threshold) && Number.isFinite(erode.softness)
      ? { threshold: erode.threshold, softness: Math.max(0, erode.softness) }
      : null;
  return {
    ...normalizeParticleConfig(value),
    textureWidth: Math.max(0, num(value.textureWidth, 0)),
    textureHeight: Math.max(0, num(value.textureHeight, 0)),
    flipbookCropOnly: value.flipbookCropOnly === true,
    blendMode: Math.round(num(value.blendMode, 0)),
    colorLut: value.colorLut,
    colorLutInterpolation: value.colorLutInterpolation,
    alphaFromRed: value.alphaFromRed === true,
    alphaErode,
    uvPolar: value.uvPolar === true,
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// `alphaErode` → a finite {threshold, softness} pair, or null (no erosion). A softness of 0 is a HARD step,
// which is what Godot's smoothstep(x, x, v) degenerates to, so it is kept as authored.
