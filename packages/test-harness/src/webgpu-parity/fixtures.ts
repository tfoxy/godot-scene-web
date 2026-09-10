// The fixture matrix for the WebGL↔WebGPU image-parity harness: one entry per FEATURE of the
// shipped effects pipeline, each a plain value that describes a node the browser entry can mount.
//
// WHAT A FIXTURE IS. Not a scene, not a `.tscn`, not a screenshot — a spec. A particle fixture is
// the exact `data-godot-particle-specs` JSON blob a node carries (core's `particles/state.ts`
// `parseParticleConfig` fills every field a partial blob omits from Godot's defaults, so a
// hand-authored partial IS a supported input); a shader fixture is a Godot `canvas_item` source
// plus the attributes that decide how it is bound. Both sides of the comparison are handed the
// SAME fixture, so anything that differs between the two images is the renderer.
//
// WHY EVERYTHING HERE IS PURE AND DETERMINISTIC. The comparison is between two renders of "the same
// frame", and a frame is only the same if every input is. The simulation is already deterministic
// (seeded LCG in core's `particles/simulate.ts`, no `Math.random`/`Date.now` anywhere under
// core's `src/particles/`) and the harness freezes it (`staticParticles` warms once from the seed;
// `staticShaders` + `staticShaderTime` pins TIME). This file closes the last hole — the TEXTURES.
// They are generated from seeded/analytic pixel functions and encoded by `./png`'s dependency-free
// encoder into `data:` URLs, so a fixture's texture is a constant of the repository rather than a
// file on disk, a network fetch, or whatever a browser's PNG decoder felt like doing.
//
// NODE + BROWSER SAFE: no `sharp`, no `Buffer`, no DOM, no imports beyond a type and the encoder.

import type { ParticleSpecConfig } from "@godot-scene-web/html/runtime";
import { pngDataUrl } from "./png";

/** Every fixture's node box, in CSS px. Modest on purpose: the canvas is this plus the runtime's
 *  own sprite/emission pad on every side, and a parity failure is easier to read at 96 px than at
 *  1024 (and far quicker to diff over ten fixtures). */
export const FIXTURE_CELL_PX = 96;

/**
 * The two budgets every fixture is held to, and the calibration behind them.
 *
 * ============================= CALIBRATION, AND WHAT IT FOUND =============================
 *
 * Every number below is backed by a MEASUREMENT recorded beside it, taken on this box, WebGL vs
 * WebGPU, both backends on the same real adapter (`chromium headless --use-angle=vulkan`,
 * nvidia/turing), each fixture on its own page. The suite is bit-for-bit reproducible across runs,
 * so these are constants, not samples.
 *
 * TWO METRICS, BECAUSE ONE OF THEM CANNOT SEE THE THING THAT WAS WRONG. Each fixture carries a
 * pixelmatch RATIO budget and a PER-CHANNEL byte budget, and `compareRgbaBuffers` demands both.
 * Pixelmatch answers "would a human notice this?": it converts to YIQ, weights the channels
 * perceptually, BLENDS semi-transparent pixels onto white by their own alpha, and compares against
 * `35215 · threshold²`. Blending by alpha before comparing is exactly how a missing or extra factor
 * of alpha hides, and squaring the threshold makes the cutoff coarse (0.12 ⇒ maxDelta ≈ 507)
 * precisely where partial coverage lives. The per-channel metric (`image-diff.ts`'s `channelDelta`)
 * makes no perceptual claim at all — `max |A − B|` over every byte, alpha included — so it cannot be
 * tuned into agreeing.
 *
 * WHY THAT SECOND METRIC EXISTS. This file used to say "there is no longer a known, tolerated
 * difference between the two backends", on the strength of every fixture reading 0.0000. It was
 * wrong, and the ratio could not have told anyone: at the same 0.0000 the two backends were
 * disagreeing by up to SIXTY-FOUR bytes on a channel. Measured then — flipbook 64, untextured-mix
 * 63, lut-recolor 62, textured 58, erode 58, mask 56, polar-uv 48, alpha-from-red 39,
 * modulate-tint 23, untextured-additive 3, the three live shaders 1 — with every one of them
 * reported as ZERO differing pixels.
 *
 * WHAT THE DIFFERENCE WAS. The WebGL shared canvas declared `premultipliedAlpha: false` while the
 * particle MIX fragment wrote PREMULTIPLIED content into it (`blendFuncSeparate(SRC_ALPHA, …)` over
 * a cleared buffer is itself a premultiplying operation), so the blit into each node's 2D canvas
 * converted "straight" to premultiplied and multiplied by alpha a SECOND time — MIX particles
 * landed at `(c·a², a)`. WebGPU, which has no straight-alpha canvas mode to get wrong, was right.
 * The shader and additive paths were right too, each by compensating for the same false declaration
 * in a different way: the shader path emitted straight colour, and the additive resolve pre-divided
 * by exactly the coverage the blit re-applied. One canvas, three contracts.
 *
 * `webgl/shared-gl.ts` now declares `premultipliedAlpha: true` and all three paths write `(rgb·a,
 * a)`, which is the WebGPU contract stated in GLSL. The per-channel readings fell to: polar-uv 4,
 * untextured-mix 3, untextured-additive 3, modulate-tint 2, textured 2, flipbook/lut-recolor/mask/
 * erode/alpha-from-red 1, and all four shader fixtures to a genuine ZERO.
 *
 * WHAT REMAINS, AND WHY IT IS NOT AN ALPHA DIFFERENCE. The residual 1–4 bytes are on PARTICLE
 * fixtures only, and they are what two different shader compilers do to the same arithmetic: the GL
 * particle fragment runs at `precision mediump float` against WGSL's f32, and its `atan`/`length`
 * are ANGLE's rather than Dawn's. `polar-uv` is the worst for exactly that reason — it feeds an
 * `atan2` result back in as a texture coordinate on a BANDED sheet, so a last-bit UV difference
 * picks a visibly different texel. The shader fixtures, which run at `highp` and share no such
 * remap, are byte-identical. An alpha-contract error is 5–50x larger than any of this and lands on
 * every partial-coverage pixel at once, which is what these budgets are shaped to catch.
 *
 * WHAT THAT MEANS FOR ANYONE READING A FAILURE HERE. The budgets below are calibrated allowances,
 * not floors, and nothing is being tolerated that is not named above. Widening one is not a fix —
 * start by asking which side changed.
 * ==========================================================================================
 */
export const PARITY_PIXELMATCH_THRESHOLD = 0.12;

/** Every particle fixture. Observed 0.0000 on all ten, stable over consecutive suite runs
 *  (previous worst, before the separate-alpha fix: `polar-uv` 0.0815, `alpha-from-red` 0.0540,
 *  `lut-recolor` 0.0305, `mask` 0.0273, `textured` 0.0207, `modulate-tint` 0.0203,
 *  `untextured-mix` 0.0185, `erode` 0.0115, `flipbook` 0.0095).
 *
 *  Held at the SHADER tier's floor rather than at zero, and for the same reason: these fixtures
 *  rasterize instanced geometry, and the zero above is measured on ONE adapter (this box's, through
 *  ANGLE-Vulkan and Dawn). A different rasterizer is entitled to disagree on a sprite's edge samples
 *  without anything being wrong, and 0.002 of a 96x96 cell is about 18 px — an edge, not a picture.
 *  Anything a feature could actually change is orders of magnitude above it. */
export const PARTICLE_MAX_DIFF_RATIO = 0.002;

/** Additive (accumulate+resolve). Observed: 0.0000 — exact. Kept off zero because the pass rounds
 *  through an 8-bit accumulator twice, so a one-step difference in accumulate doubles in resolve. */
export const ADDITIVE_MAX_DIFF_RATIO = 0.01;

/** Shaders. Observed: 0.0000 on all four. */
export const SHADER_MAX_DIFF_RATIO = 0.002;

/**
 * PARTICLES, per channel: 4 — the WORST reading across the ten, taken as the budget rather than
 * doubled.
 *
 * Per fixture: polar-uv 4, untextured-mix 3, modulate-tint 2, textured 2,
 * flipbook/lut-recolor/mask/erode/alpha-from-red 1. Not a rounding floor and not a tolerance for
 * anything structural — see the calibration block for why two shader compilers disagree by a byte
 * or four on this particular arithmetic, and why the shader fixtures do not. It sits AT the
 * measurement because the suite is bit-reproducible here, so a fifth byte is a real change and
 * should be read as one; the failure it exists to catch (an alpha contract stated two ways) was 63.
 */
export const PARTICLE_MAX_CHANNEL_DELTA = 4;

/** Additive (accumulate+resolve), per channel: the particle tier. Measured 3, and UNMOVED by the
 *  alpha-contract flip — the same 3 at the same pixel and channel before and after, which is how
 *  the flip's "additive pixels must not change" invariant was checked against an unchanging
 *  reference. It is the pass with the most rounding in it: an 8-bit accumulator, then a resolve. */
export const ADDITIVE_MAX_CHANNEL_DELTA = 4;

/**
 * SHADERS, per channel: ZERO, and genuinely so — all four fixtures are BYTE-IDENTICAL between the
 * backends, `differingPixels` included, not merely under a floor.
 *
 * They read 1 until the WebGL emitter started returning `vec4(COLOR.rgb * COLOR.a, COLOR.a)` like
 * the WGSL one. That last byte was the quantization the old path spent: straight colour rounded to
 * bytes in the drawing buffer, then multiplied by alpha and rounded AGAIN by the blit. Doing the
 * multiply in the fragment spends one rounding instead of two, and the two backends land on the
 * same byte every time.
 */
export const SHADER_MAX_CHANNEL_DELTA = 0;

/** Fixed TIME (seconds) every shader fixture renders at — `staticShaderTime`. Chosen off a
 *  round number so the wave is mid-swing rather than at an extreme its shape hides in. */
export const FIXTURE_SHADER_TIME = 1.75;

export interface ParticleParityFixture {
  kind: "particles";
  name: string;
  cellPx: number;
  /** The `data-godot-particle-specs` payload. Partial by design (see the module note). */
  spec: Partial<ParticleSpecConfig>;
  /** Texture-ish URLs this fixture needs decoded before its frame means anything. */
  images: string[];
  maxDiffRatio: number;
  /** The per-channel byte allowance (see the calibration block above). */
  maxChannelDelta: number;
}

export interface ShaderParityFixture {
  kind: "shader";
  name: string;
  cellPx: number;
  /** Godot `canvas_item` source, handed to the runtime through `resolveShaderSource`. */
  source: string;
  /** `data-godot-shader-params` (JSON object of uniform values). */
  params: Record<string, number | number[]>;
  /** `data-godot-shader-modulate` — "r,g,b,a", on the NODE. Omitted = no attribute. */
  modulate?: string;
  /** `data-godot-shader-uv-window` — "u0,v0,du,dv", on the SELF-LAYER. Omitted = full bleed. */
  uvWindow?: string;
  maxDiffRatio: number;
  /** The per-channel byte allowance (see the calibration block above). */
  maxChannelDelta: number;
  /**
   * This shader is one WGSL cannot express, so under a WebGPU runtime its BINDING must fall back to
   * WebGL by itself while the runtime as a whole stays on WebGPU. The suite then asserts the whole
   * per-binding contract — `webgpuBindingFallbacks === 1`, no readback hook for this node, and an
   * image EXACTLY equal to the reference (it is the same WebGL renderer on both sides).
   */
  expectBindingFallback?: boolean;
}

export type ParityFixture = ParticleParityFixture | ShaderParityFixture;

// ---------------------------------------------------------------------------------------------
// Deterministic fixture textures
// ---------------------------------------------------------------------------------------------

/** Park-Miller MINSTD, the same shape of generator the particle sim uses — so a "noisy" fixture
 *  texture is noise in the picture and a constant in the repository. */
function lcg(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) {
    state += 2147483646;
  }
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** Build a `size × size` RGBA buffer from a per-pixel function of the pixel's centre in [0,1]. */
function rgbaImage(
  size: number,
  paint: (
    u: number,
    v: number,
    rand: () => number,
    x: number,
    y: number,
  ) => [number, number, number, number],
): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const rand = lcg(20260820);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(
        (x + 0.5) / size,
        (y + 0.5) / size,
        rand,
        x,
        y,
      );
      const at = (y * size + x) * 4;
      data[at] = clampByte(r);
      data[at + 1] = clampByte(g);
      data[at + 2] = clampByte(b);
      data[at + 3] = clampByte(a);
    }
  }
  return data;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

const SPRITE_PX = 32;
const FLIPBOOK_PX = 64;

/** A soft, coloured dot with a real alpha channel — the ordinary textured-particle case. */
export const SPRITE_TEXTURE_URL = pngDataUrl(
  SPRITE_PX,
  SPRITE_PX,
  rgbaImage(SPRITE_PX, (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.min(1, Math.hypot(dx, dy) * 2);
    const falloff = 1 - r * r;
    return [
      255 * (0.35 + 0.65 * u),
      255 * (0.4 + 0.5 * (1 - v)),
      255 * (0.3 + 0.5 * r),
      255 * Math.max(0, falloff),
    ];
  }),
);

/** `smoothstep`, for building fixture textures whose shapes have SOFT edges. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * A 2×2 flipbook sheet, four visibly DIFFERENT cells.
 *
 * They must differ: with `hframes`/`vframes` > 1 the renderer crops UV to one cell per particle
 * (chosen from the per-particle anim offset), so a sheet of four identical cells would render
 * exactly like a sheet of one and the fixture would prove nothing about the flipbook path.
 *
 * Every shape is edged with a `smoothstep` ramp rather than a binary alpha. A hard edge is a run of
 * pixels that flips fully on/off across one texel, and it is exactly where two different
 * rasterizers (WP-8b compares SwiftShader GL against SwiftShader Vulkan) disagree — a binary-alpha
 * sheet would spend the whole cross-backend tolerance budget on cell outlines.
 */
export const FLIPBOOK_TEXTURE_URL = pngDataUrl(
  FLIPBOOK_PX,
  FLIPBOOK_PX,
  rgbaImage(FLIPBOOK_PX, (u, v) => {
    const cellX = u < 0.5 ? 0 : 1;
    const cellY = v < 0.5 ? 0 : 1;
    // Position within this cell, in [0,1].
    const cu = u * 2 - cellX;
    const cv = v * 2 - cellY;
    const dx = cu - 0.5;
    const dy = cv - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    if (cellX === 0 && cellY === 0) {
      // Filled disc.
      return [255, 90, 70, 255 * (1 - smoothstep(0.7, 0.9, r))];
    }
    if (cellX === 1 && cellY === 0) {
      // Ring.
      const ring = smoothstep(0.4, 0.6, r) * (1 - smoothstep(0.75, 0.95, r));
      return [90, 220, 130, 255 * ring];
    }
    if (cellX === 0 && cellY === 1) {
      // Square block, inset so the cell edge is visible in the diff.
      const box =
        smoothstep(0.15, 0.28, cu) *
        (1 - smoothstep(0.72, 0.85, cu)) *
        smoothstep(0.15, 0.28, cv) *
        (1 - smoothstep(0.72, 0.85, cv));
      return [110, 150, 255, 255 * box];
    }
    // Diagonal wedge — asymmetric, so a flipped cell would be obvious.
    return [255, 220, 90, 255 * (1 - smoothstep(0.9, 1.1, cu + cv))];
  }),
);

/**
 * The LUT's source sheet: red sweeps the FULL 0..1 range across the sprite, coverage comes from a
 * soft radial alpha.
 *
 * Two things this gets right that the opaque `RED_SHEET` would not. The red ramp spans the whole
 * texture, so the LUT is exercised over its entire domain rather than the narrow band a radial red
 * happens to cover. And the alpha falloff keeps the particle a SPRITE: sampled with coverage from
 * `tex.a`, an opaque sheet draws hard-edged squares, and a fixture whose picture is twelve
 * axis-aligned rectangles measures rectangle edges more than it measures the LUT.
 */
export const LUT_SHEET_TEXTURE_URL = pngDataUrl(
  SPRITE_PX,
  SPRITE_PX,
  rgbaImage(SPRITE_PX, (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.min(1, Math.hypot(dx, dy) * 2);
    return [255 * u, 0, 0, 255 * (1 - smoothstep(0.35, 1, r))];
  }),
);

/**
 * A RED-CHANNEL sheet: fully opaque, colour carried only in red.
 *
 * This is the shape half of the real VFX corpus ships (grayscale PNGs with no alpha), and it is
 * what `alphaFromRed` and `colorLut` exist for — a consumer reading coverage from `tex.a` draws an
 * opaque SQUARE here, which is exactly the failure those flags prevent. Used by both fixtures.
 */
export const RED_SHEET_TEXTURE_URL = pngDataUrl(
  SPRITE_PX,
  SPRITE_PX,
  rgbaImage(SPRITE_PX, (u, v, rand) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.min(1, Math.hypot(dx, dy) * 2);
    // Soft core plus a little seeded grain, so the LUT has a real spread of indices to map.
    const red = Math.max(0, 1 - r) * (0.85 + 0.15 * rand());
    return [255 * red, 0, 0, 255];
  }),
);

/** The quad-shaped coverage mask (`maskUrl`): its RED multiplies coverage, sampled on the sprite's
 *  own UV rather than the flipbook cell. Diagonal + grain, so a mis-sampled mask is unmistakable. */
export const MASK_TEXTURE_URL = pngDataUrl(
  SPRITE_PX,
  SPRITE_PX,
  rgbaImage(SPRITE_PX, (u, v, rand) => {
    const band = 0.5 + 0.5 * Math.sin((u + v) * Math.PI * 3);
    const red = Math.max(0, Math.min(1, band * (0.8 + 0.2 * rand())));
    return [255 * red, 0, 0, 255];
  }),
);

/**
 * Horizontal bands — the sheet the polar-UV remap is FOR.
 *
 * Godot's `polar_coordinates(UV, vec2(0.5), 1, 1)` maps angle→u and radius→v, so a sheet of
 * horizontal bands becomes concentric RINGS after the remap and stays bands without it. That makes
 * `uvPolar` visible in the image instead of a flag nobody can see.
 */
export const BANDS_TEXTURE_URL = pngDataUrl(
  SPRITE_PX,
  SPRITE_PX,
  rgbaImage(SPRITE_PX, (_u, v) => {
    const band = 0.5 + 0.5 * Math.sin(v * Math.PI * 6);
    return [255 * (0.4 + 0.6 * band), 255 * 0.5, 255 * (1 - band), 255 * band];
  }),
);

// ---------------------------------------------------------------------------------------------
// Particle specs
// ---------------------------------------------------------------------------------------------

/** One particle's lifetime, in seconds, and the preprocess that precedes the frozen frame. */
const LIFETIME_S = 4;
/** `preprocess > 0` makes `warmStaticParticles` run `preprocessParticles` (core's `simulate.ts`), so the
 *  frozen frame is a full, steady-state cloud rather than a just-started puff. Half a lifetime is
 *  enough for every slot to have emitted at an evenly-spread phase. */
const PREPROCESS_S = LIFETIME_S / 2;

/**
 * The spec every particle fixture starts from — a point-emitted, gravity-free, evenly-phased spray
 * centred in its cell.
 *
 * THE TRAVEL BUDGET. `initialVelocityMax` is set so a particle covers about a quarter of the cell
 * over its whole life. A spray that reaches the canvas edge would be CLIPPED, and a clipped edge is
 * a hard-edged run of pixels that any rasterizer difference lands on — it would turn a tolerance
 * calibrated for soft edges into a coin flip.
 *
 * `explosiveness: 0, randomness: 0` spread births evenly across the cycle, so the frozen frame
 * always contains particles at every age (young ones at the centre, old ones at the rim) — which is
 * what makes ONE frame exercise the over-life ramps.
 */
function baseSpec(): Partial<ParticleSpecConfig> {
  return {
    kind: "CPUParticles2D",
    amount: 24,
    amountRatio: 1,
    lifetime: LIFETIME_S,
    lifetimeRandomness: 0,
    oneShot: false,
    emitting: true,
    explosiveness: 0,
    randomness: 0,
    preprocess: PREPROCESS_S,
    speedScale: 1,
    fixedFps: 30,
    localCoords: false,
    drawOrder: 0,
    seed: 20260820,
    emissionShape: 0,
    emissionOffset: [0, 0],
    emissionScale: [1, 1],
    emissionSphereRadius: 0,
    emissionRingRadius: 0,
    emissionRingInnerRadius: 0,
    emissionBoxExtents: [0, 0],
    direction: [0, -1],
    spread: 180,
    initialVelocityMin: FIXTURE_CELL_PX / 8 / LIFETIME_S,
    initialVelocityMax: FIXTURE_CELL_PX / 4 / LIFETIME_S,
    gravity: [0, 0],
    angleMin: 0,
    angleMax: 0,
    angularVelocityMin: 0,
    angularVelocityMax: 0,
    scaleMin: 1,
    scaleMax: 1,
    baseColor: [1, 0.82, 0.45, 1],
    // The emitter sits at the cell centre; the canvas is anchored on the node box and grown by the
    // runtime's own pad law on every side.
    originX: FIXTURE_CELL_PX / 2,
    originY: FIXTURE_CELL_PX / 2,
    textureUrl: null,
    textureWidth: 0,
    textureHeight: 0,
    hframes: 1,
    vframes: 1,
    animLoop: true,
    animSpeedMin: 0,
    animSpeedMax: 0,
    animOffsetMin: 0,
    animOffsetMax: 0,
    blendMode: 0,
  };
}

/** Over-life colour ramp + alpha/scale curves — the per-particle sample chain in `updateDisplay`. */
function overLifeRamps(): Partial<ParticleSpecConfig> {
  return {
    colorRamp: [
      { offset: 0, color: [1, 0.9, 0.5, 1] },
      { offset: 0.5, color: [1, 0.45, 0.2, 1] },
      { offset: 1, color: [0.3, 0.2, 0.7, 1] },
    ],
    alphaCurve: [
      { x: 0, y: 1 },
      { x: 0.6, y: 0.8 },
      { x: 1, y: 0.2 },
    ],
    scaleCurve: [
      { x: 0, y: 1 },
      { x: 1, y: 0.4 },
    ],
  };
}

/** A textured spec: the sprite dimensions must be STATED, since the canvas-pad law reads them from
 *  the spec (the decoded image only corrects them later, re-padding the canvas). */
function texturedSpec(
  url: string,
  width: number,
  height: number,
): Partial<ParticleSpecConfig> {
  return {
    ...baseSpec(),
    textureUrl: url,
    textureWidth: width,
    textureHeight: height,
    // Sprites are bigger than the 16 px procedural dot, so fewer, larger particles keep the cell
    // legible instead of a solid wash in which no feature can be told from another.
    amount: 12,
    scaleMin: 0.6,
    scaleMax: 0.6,
  };
}

// ---------------------------------------------------------------------------------------------
// Shader sources
// ---------------------------------------------------------------------------------------------

/**
 * The S7 wave shader, COPIED from `packages/perf-harness/src/scenarios/effects-runtime.ts`
 * (`EFFECTS_SHADER_SOURCE`) rather than imported.
 *
 * WHY A COPY. `@godot-scene-web/perf-harness` is a devDependency of nothing here, and importing a
 * perf SCENARIO into a correctness test would couple this suite's fixtures to a file whose whole
 * purpose is to be re-tuned for measurement (its `systems`/`amount`/`blend` defaults move with the
 * phone). The parity of these two strings is not load-bearing — what matters is that this suite
 * renders the same source on both sides — so a copy with an attribution is the honest shape.
 * It reads TIME, which is what `staticShaderTime` pins.
 */
export const WAVE_SHADER_SOURCE = `shader_type canvas_item;

void fragment() {
    vec2 p = UV - vec2(0.5);
    float r = length(p) * 2.0;
    float wave = 0.5 + 0.5 * sin(r * 12.0 - TIME * 2.5);
    vec3 tint = vec3(0.45 + 0.4 * wave, 0.30 + 0.25 * wave, 0.85 - 0.3 * wave);
    COLOR = vec4(tint, clamp(1.0 - 0.5 * r, 0.35, 1.0));
}
`;

/**
 * A shader that multiplies by the MODULATE built-in explicitly.
 *
 * The wave shader above cannot serve this fixture: it ASSIGNS COLOR outright, and the transpiler's
 * auto-modulate rule (`webgl/transpile.ts`) only injects `COLOR *= MODULATE` for shaders that leave
 * the node modulate in COLOR — so `data-godot-shader-modulate` would change nothing and the
 * fixture would quietly be a duplicate of `shader-wave`. Naming MODULATE makes the uniform real.
 */
export const MODULATE_SHADER_SOURCE = `shader_type canvas_item;

void fragment() {
    vec2 p = UV - vec2(0.5);
    float r = length(p) * 2.0;
    float wave = 0.5 + 0.5 * sin(r * 9.0 - TIME * 1.5);
    vec4 base = vec4(0.10 + 0.85 * wave, 0.45, 0.20 + 0.5 * wave, clamp(1.0 - 0.6 * r, 0.2, 1.0));
    COLOR = base * MODULATE;
}
`;

/**
 * A shader carrying a `hint_screen_texture` sampler — the per-binding WebGL fallback, made visible.
 *
 * WHY THE SAMPLER IS DECLARED AND NEVER SAMPLED. The declaration alone is what the WGSL emitter
 * refuses (`transpile-wgsl.ts`'s `rejectScreenCapture` keys on `parsed.screenTextureNames`, not on
 * use), so this shader takes the exact production path a real distortion shader takes: WGSL says no
 * → `UnsupportedWgslShaderError` → that BINDING is built on WebGL while its runtime stays WebGPU.
 *
 * And because it never samples the thing, the picture is a pure function of UV and the pinned TIME.
 * A shader that actually read SCREEN_TEXTURE would drag the runtime's screen CAPTURE into a pixel
 * comparison — approximate and throttled to 0.3 s by design, so two pages could easily capture at
 * different moments and differ for a reason that is not the renderer. (Verified: on the GLSL side
 * this source reports `usesScreenTexture === false`, so no capture is performed at all.)
 */
export const SCREEN_TEXTURE_SHADER_SOURCE = `shader_type canvas_item;
uniform sampler2D SCREEN_TEXTURE : hint_screen_texture, repeat_disable, filter_nearest;

void fragment() {
    vec2 p = UV - vec2(0.5);
    float r = length(p) * 2.0;
    float wave = 0.5 + 0.5 * sin(r * 10.0 - TIME * 2.0);
    COLOR = vec4(0.2 + 0.7 * wave, 0.5, 0.9 - 0.4 * wave, clamp(1.0 - 0.5 * r, 0.25, 1.0));
}
`;

// ---------------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------------

export const PARITY_FIXTURES: ParityFixture[] = [
  {
    kind: "particles",
    name: "untextured-mix",
    cellPx: FIXTURE_CELL_PX,
    // The procedural dot plus the whole over-life chain: the baseline every other particle fixture
    // is a single-feature step away from.
    spec: { ...baseSpec(), ...overLifeRamps() },
    images: [],
    maxDiffRatio: PARTICLE_MAX_DIFF_RATIO,
    maxChannelDelta: PARTICLE_MAX_CHANNEL_DELTA,
  },
  {
    kind: "particles",
    name: "untextured-additive",
    cellPx: FIXTURE_CELL_PX,
    // `blendMode: 1` is not a blend-state change but a whole second PASS in `render-webgl.ts`
    // (accumulate into an offscreen RGBA8 target, then resolve) — the one path the S7 probe refused.
    spec: { ...baseSpec(), ...overLifeRamps(), blendMode: 1 },
    images: [],
    maxDiffRatio: ADDITIVE_MAX_DIFF_RATIO,
    maxChannelDelta: ADDITIVE_MAX_CHANNEL_DELTA,
  },
  {
    kind: "particles",
    name: "textured",
    cellPx: FIXTURE_CELL_PX,
    spec: {
      ...texturedSpec(SPRITE_TEXTURE_URL, SPRITE_PX, SPRITE_PX),
      ...overLifeRamps(),
    },
    images: [SPRITE_TEXTURE_URL],
    maxDiffRatio: PARTICLE_MAX_DIFF_RATIO,
    maxChannelDelta: PARTICLE_MAX_CHANNEL_DELTA,
  },
  {
    kind: "particles",
    name: "flipbook",
    cellPx: FIXTURE_CELL_PX,
    spec: {
      ...texturedSpec(FLIPBOOK_TEXTURE_URL, FLIPBOOK_PX, FLIPBOOK_PX),
      hframes: 2,
      vframes: 2,
      // A per-particle anim OFFSET spread over the whole sheet, with speed 0: every particle sits on
      // its own cell and stays there, so the frozen frame shows all four cells at once and the
      // picture does not depend on when the frame was taken.
      animOffsetMin: 0,
      animOffsetMax: 1,
      animSpeedMin: 0,
      animSpeedMax: 0,
    },
    images: [FLIPBOOK_TEXTURE_URL],
    maxDiffRatio: PARTICLE_MAX_DIFF_RATIO,
    maxChannelDelta: PARTICLE_MAX_CHANNEL_DELTA,
  },
  {
    kind: "particles",
    name: "lut-recolor",
    cellPx: FIXTURE_CELL_PX,
    spec: {
      ...texturedSpec(LUT_SHEET_TEXTURE_URL, SPRITE_PX, SPRITE_PX),
      // RGB comes from the LUT, indexed by the SOURCE texture's red; alpha stays the source's.
      // A white base colour keeps the LUT's own colours readable in the diff.
      baseColor: [1, 1, 1, 1],
      colorLut: [
        { offset: 0, color: [0.05, 0.1, 0.4, 1] },
        { offset: 0.5, color: [0.9, 0.2, 0.5, 1] },
        { offset: 1, color: [1, 0.95, 0.6, 1] },
      ],
      colorLutInterpolation: 0,
    },
    images: [LUT_SHEET_TEXTURE_URL],
    maxDiffRatio: PARTICLE_MAX_DIFF_RATIO,
    maxChannelDelta: PARTICLE_MAX_CHANNEL_DELTA,
  },
  {
    kind: "particles",
    name: "mask",
    cellPx: FIXTURE_CELL_PX,
    spec: {
      ...texturedSpec(SPRITE_TEXTURE_URL, SPRITE_PX, SPRITE_PX),
      maskUrl: MASK_TEXTURE_URL,
    },
    // BOTH images gate this frame: until the mask decodes its placeholder reads red 0 and the
    // system is invisible, so a capture taken too early would be a blank canvas that happened to
    // match another blank canvas.
    images: [SPRITE_TEXTURE_URL, MASK_TEXTURE_URL],
    maxDiffRatio: PARTICLE_MAX_DIFF_RATIO,
    maxChannelDelta: PARTICLE_MAX_CHANNEL_DELTA,
  },
  {
    kind: "particles",
    name: "polar-uv",
    cellPx: FIXTURE_CELL_PX,
    spec: {
      ...texturedSpec(BANDS_TEXTURE_URL, SPRITE_PX, SPRITE_PX),
      uvPolar: true,
      // Larger sprites: the remap's rings need pixels to be rings in.
      scaleMin: 1.2,
      scaleMax: 1.2,
      amount: 8,
    },
    images: [BANDS_TEXTURE_URL],
    // The banded sheet is partial alpha almost everywhere and the sprites are the largest here, so
    // this fixture carries the most of the alpha-blend difference documented above.
    maxDiffRatio: PARTICLE_MAX_DIFF_RATIO,
    maxChannelDelta: PARTICLE_MAX_CHANNEL_DELTA,
  },
  {
    kind: "particles",
    name: "erode",
    cellPx: FIXTURE_CELL_PX,
    spec: {
      ...texturedSpec(SPRITE_TEXTURE_URL, SPRITE_PX, SPRITE_PX),
      // `coverage = smoothstep(threshold, threshold + softness, coverage)` — chosen to bite into
      // the sprite's soft falloff (which spans the full 0..1) rather than clip it away entirely.
      alphaErode: { threshold: 0.3, softness: 0.35 },
    },
    images: [SPRITE_TEXTURE_URL],
    maxDiffRatio: PARTICLE_MAX_DIFF_RATIO,
    maxChannelDelta: PARTICLE_MAX_CHANNEL_DELTA,
  },
  {
    kind: "particles",
    name: "alpha-from-red",
    cellPx: FIXTURE_CELL_PX,
    spec: {
      // The red sheet is opaque everywhere: WITHOUT this flag the fixture renders solid squares.
      // That is the point — the flag is the difference between a sprite and a square.
      ...texturedSpec(RED_SHEET_TEXTURE_URL, SPRITE_PX, SPRITE_PX),
      alphaFromRed: true,
    },
    images: [RED_SHEET_TEXTURE_URL],
    // Coverage comes from a soft red ramp, so nearly every painted pixel is partial alpha — the
    // same alpha-blend difference as `polar-uv`, for the same reason.
    maxDiffRatio: PARTICLE_MAX_DIFF_RATIO,
    maxChannelDelta: PARTICLE_MAX_CHANNEL_DELTA,
  },
  {
    kind: "particles",
    name: "modulate-tint",
    cellPx: FIXTURE_CELL_PX,
    // A particle spec has NO `modulate` field — Godot's node modulate reaches the particle path as
    // the per-particle tint (`baseColor`, multiplied into the sprite by `v_color`), and the
    // MODULATE built-in belongs to the shader runtime (see `shader-modulate` below). This fixture
    // is the tint multiply over a texture: a saturated, non-white base colour with an initial-ramp
    // on top, which is where a premultiply mistake in a WebGPU backend would show first.
    spec: {
      ...texturedSpec(SPRITE_TEXTURE_URL, SPRITE_PX, SPRITE_PX),
      baseColor: [0.25, 0.9, 0.55, 0.8],
      colorInitialRamp: [
        { offset: 0, color: [1, 0.3, 0.3, 1] },
        { offset: 1, color: [0.3, 0.4, 1, 1] },
      ],
    },
    images: [SPRITE_TEXTURE_URL],
    maxDiffRatio: PARTICLE_MAX_DIFF_RATIO,
    maxChannelDelta: PARTICLE_MAX_CHANNEL_DELTA,
  },
  {
    kind: "shader",
    name: "shader-wave",
    cellPx: FIXTURE_CELL_PX,
    source: WAVE_SHADER_SOURCE,
    params: {},
    maxDiffRatio: SHADER_MAX_DIFF_RATIO,
    maxChannelDelta: SHADER_MAX_CHANNEL_DELTA,
  },
  {
    kind: "shader",
    name: "shader-uv-window",
    cellPx: FIXTURE_CELL_PX,
    source: WAVE_SHADER_SOURCE,
    params: {},
    // A sub-rect window: the canvas covers only part of the node and the shader's UV is remapped to
    // the window, so an off-by-one in the window maths moves the whole picture rather than a pixel.
    uvWindow: "0.25,0.125,0.5,0.625",
    maxDiffRatio: SHADER_MAX_DIFF_RATIO,
    maxChannelDelta: SHADER_MAX_CHANNEL_DELTA,
  },
  {
    kind: "shader",
    name: "shader-modulate",
    cellPx: FIXTURE_CELL_PX,
    source: MODULATE_SHADER_SOURCE,
    params: {},
    modulate: "0.55,0.85,1,0.7",
    maxDiffRatio: SHADER_MAX_DIFF_RATIO,
    maxChannelDelta: SHADER_MAX_CHANNEL_DELTA,
  },
  {
    kind: "shader",
    name: "shader-screen-texture-fallback",
    cellPx: FIXTURE_CELL_PX,
    source: SCREEN_TEXTURE_SHADER_SOURCE,
    params: {},
    expectBindingFallback: true,
    // EXACT. Both sides render this binding on WebGL — that is the whole claim — so a single
    // differing pixel would mean the fallback did not happen the way the stats say it did.
    maxDiffRatio: 0,
    // EXACT on both metrics, for the same reason.
    maxChannelDelta: 0,
  },
];

/** Fixture lookup by name — the browser entry is handed a fixture, but a test that wants to name
 *  one (a focused re-run, an artifact path) should not have to scan the array itself. */
export function parityFixture(name: string): ParityFixture {
  const found = PARITY_FIXTURES.find((fixture) => fixture.name === name);
  if (!found) {
    throw new Error(`Unknown parity fixture: ${name}`);
  }
  return found;
}
