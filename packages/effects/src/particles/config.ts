// The serialized contract between BUILD-TIME (`visual-2d.ts` emits this as the
// `data-godot-particle-specs` JSON blob on an opted-in particle node) and the
// RUNTIME (`particles/state.ts` parses it into a live `ParticleSystemConfig`).
//
// One flat JSON object holds everything the deterministic CPU simulation needs:
// node lifecycle, the ParticleProcessMaterial parameters (or CPUParticles2D node
// equivalents — the build-time reader unifies them), the resolved texture + flipbook
// info, the CanvasItemMaterial blend mode, and the over-life ramps/curves decoded to
// plain stop/point arrays (reusing the `GradientStop`/`CurvePoint` shapes the WebGL
// bake path already defines, so build-time and runtime agree and share samplers).
//
// Every field is written by the serializer; the parser still applies defaults so a
// hand-authored or partial blob stays safe. Values are in Godot units (pixels,
// degrees, seconds) — the simulation does the conversions.

import type { GodotRendererBackend } from "./godot-renderer";
import type { ParticleCurvePoint, ParticleGradientStop } from "./sampling";

/** Renderer-neutral particle simulation contract. */
export interface ParticleConfig {
  kind: "CPUParticles2D" | "GPUParticles2D";

  /**
   * Which Godot backend the browser render is imitating (`GodotHtmlRenderOptions.godotRenderer`,
   * default `"forward_plus"`). Its ONLY effect is `baseColorRender` below — see
   * `./godot-renderer.ts`.
   */
  godotRenderer: GodotRendererBackend;

  // ---- node lifecycle ----
  amount: number;
  amountRatio: number;
  lifetime: number;
  lifetimeRandomness: number;
  oneShot: boolean;
  emitting: boolean;
  explosiveness: number;
  randomness: number;
  preprocess: number;
  speedScale: number;
  /** 0 => use 1/30 fixed step. */
  fixedFps: number;
  localCoords: boolean;
  /** 0 = index, 1 = lifetime, 2 = reverse-lifetime (affects draw order only). */
  drawOrder: number;
  seed: number;

  // ---- emission shape (px) ----
  /** 0 point, 1 sphere(disk), 2 sphere-surface(ring), 3 box, 4 points, 6 ring. */
  emissionShape: number;
  emissionOffset: [number, number];
  emissionScale: [number, number];
  emissionSphereRadius: number;
  emissionRingRadius: number;
  emissionRingInnerRadius: number;
  emissionRingHeight: number;
  emissionBoxExtents: [number, number];

  // ---- direction / velocity ----
  direction: [number, number];
  /** Half-angle, degrees. */
  spread: number;
  initialVelocityMin: number;
  initialVelocityMax: number;
  /** Degrees. */
  angleMin: number;
  angleMax: number;
  /** Degrees / second. */
  angularVelocityMin: number;
  angularVelocityMax: number;

  // ---- forces (px/s^2, px) ----
  gravity: [number, number];
  linearAccelMin: number;
  linearAccelMax: number;
  radialAccelMin: number;
  radialAccelMax: number;
  tangentialAccelMin: number;
  tangentialAccelMax: number;
  dampingMin: number;
  dampingMax: number;
  dampingAsFriction: boolean;
  /** Revolutions / second. */
  orbitVelocityMin: number;
  orbitVelocityMax: number;

  // ---- appearance ----
  scaleMin: number;
  scaleMax: number;
  hueVariationMin: number;
  hueVariationMax: number;
  alignY: boolean;
  /** The system's base colour exactly as Godot serialized it — raw sRGB, never converted. */
  baseColor: [number, number, number, number];
  /**
   * Whether `baseColor` came from `ParticleProcessMaterial.color` rather than from
   * `CPUParticles2D.color` or the node's `modulate`. Gates the `godotRenderer` correction:
   * only the process material rides the UBO path Godot linearizes. Defaults (when a
   * hand-authored blob omits it) to `kind === "GPUParticles2D"`.
   */
  baseColorFromProcessMaterial: boolean;
  /**
   * `baseColor` as `godotRenderer` uploads it to the GPU: RGB through
   * `Color::srgb_to_linear()` on `forward_plus`/`mobile` when
   * `baseColorFromProcessMaterial`, IDENTICAL to `baseColor` otherwise. Alpha is never
   * converted on any backend. This is the field the simulation multiplies (`simulate.ts`);
   * `baseColor` is kept beside it as the authored value.
   *
   * DERIVED: `normalizeParticleConfig` always RECOMPUTES it from `baseColor`,
   * `godotRenderer` and `baseColorFromProcessMaterial`, so the serialized value cannot go
   * stale or lie. Deriving it rather
   * than overwriting `baseColor` in place is what keeps normalization IDEMPOTENT —
   * `normalizeParticleConfig(normalizeParticleConfig(x))` would otherwise apply the curve
   * twice, and several call sites do re-normalize an already-normalized config.
   */
  baseColorRender: [number, number, number, number];

  // ---- texture / flipbook ----
  hframes: number;
  vframes: number;
  // Total flipbook frames when the sheet is not fully packed (a 3x2 grid holding 5 frames).
  // Absent/0 => `hframes * vframes`. The frame INDEX is chosen over this range and then wrapped
  // into the grid's cells, matching Godot's `mod(progress, hframes * vframes)`.
  frameCount?: number;
  animLoop: boolean;
  animSpeedMin: number;
  animSpeedMax: number;
  animOffsetMin: number;
  animOffsetMax: number;

  // ---- over-life ramps / curves (omitted when absent => constant) ----
  colorRamp?: ParticleGradientStop[];
  colorInitialRamp?: ParticleGradientStop[];
  scaleCurve?: ParticleCurvePoint[];
  scaleCurveX?: ParticleCurvePoint[];
  scaleCurveY?: ParticleCurvePoint[];
  alphaCurve?: ParticleCurvePoint[];
  hueCurve?: ParticleCurvePoint[];
}

/** Renderer-facing particle fields that remain portable (no URLs or DOM placement). */
export interface ParticleRenderConfig extends ParticleConfig {
  textureWidth: number;
  textureHeight: number;
  flipbookCropOnly?: boolean;
  blendMode: number;
  colorLut?: ParticleGradientStop[];
  colorLutInterpolation?: number;
  alphaFromRed?: boolean;
  alphaErode?: { threshold: number; softness: number } | null;
  uvPolar?: boolean;
}
