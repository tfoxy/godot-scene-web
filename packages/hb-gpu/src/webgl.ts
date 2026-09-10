// The pipeline hb-gpu does not ship: a WebGL2 program, an RGBA16I atlas and a bump allocator.
//
// HarfBuzz gives you an encoder and two halves of a shader. It does not give you a renderer —
// `util/gpu/demo-atlas.cc` and `util/gpu/demo-renderer-gl.cc` are a GLFW demo, 344 lines between
// them, and they are the reference this file is ported from rather than the mechanism it is.
//
// THE THREE THINGS THIS FILE OWNS, AND WHY EACH IS NOT UPSTREAM'S:
//
//   1. A 2-D ATLAS BECAUSE WEBGL2 HAS NO TEXTURE BUFFERS. The blob format is a flat 1-D stream of
//      RGBA16I texels and the natural binding is `isamplerBuffer`, which WebGL2 does not have at
//      all. `HB_GPU_ATLAS_2D` exists for exactly this: the stream is wrapped into a wide
//      `TEXTURE_2D` and the shader unwraps it with `offset % width, offset / width`. Which is why
//      `hb_gpu_atlas_width` is a uniform and not a constant, and why the upload goes row by row.
//   2. AN ALLOCATOR WITH EVICTION. `demo_atlas_alloc` calls `die ("Ran out of atlas memory")`.
//      That is a demo. A Han pool is thousands of outlines against a fixed texture, so the cursor
//      wraps and overwrites, and the only question is what it is allowed to overwrite.
//   3. INSTANCED QUADS. Upstream emits six vertices per glyph with `position`, `texcoord`,
//      `normal`, `emPerPos` AND the atlas offset replicated into every one of them — 192 bytes a
//      glyph. Here the four corner signs are a static 4-vertex buffer (the corner sign IS the
//      outward normal, which is what makes that substitution exact, not a shortcut) and everything
//      per-glyph is one 40-byte instance record with `a_glyphLoc` at divisor 1.
//
// IT BORROWS A CONTEXT; IT DOES NOT OWN ONE. This file used to call `createCanvasStage` out of
// `@godot-scene-web/canvas`, which made `hb-gpu` depend on `canvas`. That edge points the wrong
// way: `canvas` is where a glyph path belongs, so `canvas` has to be able to depend on THIS. The
// package therefore has zero workspace dependencies and takes a `WebGL2RenderingContext` it did
// not create, on a canvas it never sizes, next to draws it did not issue.
//
// Everything that follows from that is stated where it bites: {@link HbGpuRenderer.end} does not
// set the viewport and does not clear (a clear inside a glyph pass erases whatever the embedder's
// executor already drew) and documents exactly which GL state it leaves dirty;
// {@link HbGpuRendererOptions.framebufferWidth} is the embedder's ACHIEVED drawing-buffer size, not
// a size this file requests; and context loss is an explicit lifecycle
// ({@link HbGpuRenderer.notifyContextLost} / {@link HbGpuRenderer.rebuild}) rather than a canvas
// event listener, because the canvas belongs to somebody else.
//
// DESIGN SIZE AND FRAMEBUFFER SIZE ARE TWO NUMBERS, NOT ONE. They were one while this file owned
// its canvas, because it sized that canvas in device pixels and design space WAS device pixels. On
// a borrowed stage they differ by the device-pixel ratio, and they feed two different things: the
// design pair builds the design->clip projection, and the framebuffer pair is `u_viewport`, which
// is what `hb_gpu_dilate` measures half a SCREEN pixel against.
//
// THE DAMAGE IS ASYMMETRIC, AND IT WAS MEASURED RATHER THAN REASONED — the reasoning was wrong.
// Over-dilation is INVISIBLE: `hb_gpu_dilate` moves `position` and `texcoord` along the same
// affine map, so `fwidth (renderCoord)` — where `hb_gpu_draw` gets its ppem — does not move with
// it, and the extra fragments a too-large quad covers evaluate to coverage 0. Feeding the design
// size on a 2x-DPR stage therefore changes nothing on screen; it was measured at zero differing
// bytes on ANGLE/NVIDIA. UNDER-dilation is what bites: when the drawing buffer is SMALLER than
// design space the quad is too tight and the antialiased rim is clipped off, which at a ratio of
// 1/4 measures RMS 1.79 against a correct render. `packages/test-harness/test/canvasGlyphPixelXvfb.test.ts`
// pins both directions and documents the calibration. Neither reads as a size error, which is why
// the two are separate parameters here.
//
// PREMULTIPLIED OUT, ALWAYS. The fragment writes `vec4 (rgb * a * cov, a * cov)`, so the borrowed
// context MUST have been created with `premultipliedAlpha: true` — which is what
// `packages/canvas/src/present.ts` asks for, and the reason to borrow that stage's context rather
// than open a second one. Getting this wrong is SILENT — the picture is merely darker — and
// `packages/test-harness/test/canvasPixelXvfb.test.ts` is where that contract is pinned for the
// rest of the repo.

import {
  type EncodedGlyph,
  HB_GPU_SHADER_STAGE_FRAGMENT,
  HB_GPU_SHADER_STAGE_VERTEX,
  HB_GPU_TEXEL_BYTES,
  type HbGpu,
  type HbGpuFailure,
  type HbGpuFailureReason,
  type HbGpuFont,
} from "./index";

/**
 * Upstream's `ATLAS_TEX_WIDTH`, and the width this renderer PREFERS rather than the one it gets.
 *
 * Wide and short keeps the unwrap arithmetic in `int` range. WebGL2 only guarantees
 * `MAX_TEXTURE_SIZE >= 2048`, so a device can refuse 4096 — read {@link HbGpuRenderer.atlasWidth}
 * for the width an instance actually built, and never assume this constant describes it. The
 * shader is handed the achieved width as `hb_gpu_atlas_width`, so any width is legal.
 */
export const ATLAS_WIDTH = 4096;

/**
 * Below this the renderer refuses rather than clamps.
 *
 * A 5 KB Han blob is ~675 texels: at 1024 wide the upload is at most a couple of `texSubImage2D`
 * calls, and narrower rows turn one glyph into dozens of them. A device reporting below WebGL2's
 * own guaranteed 2048 is broken or emulated, and is not one this renderer can be measured on.
 */
const MIN_ATLAS_WIDTH = 1024;

const LEGACY_INSTANCE_FLOATS = 10;
const BATCHED_INSTANCE_FLOATS = 21;

/**
 * The GLSL preamble every stage gets, and the one line in it that is load-bearing.
 *
 * `#define HB_GPU_ATLAS_2D` selects `uniform highp isampler2D hb_gpu_atlas` plus the
 * `hb_gpu_atlas_width` unwrap over the `isamplerBuffer` path. It is defined HERE, in the shader,
 * and not by the wasm build: the C macro of the same name only reaches `util/gpu/demo-atlas.cc`,
 * which this package does not compile, so the `-DHB_GPU_ATLAS_2D` on the em++ line does not select
 * anything. The `#ifdef` that matters lives inside the GLSL the module hands back.
 *
 * `highp int` is not decoration either: atlas offsets are absolute texel indices into a stream that
 * runs to hundreds of thousands, and `mediump int` is only guaranteed 16 bits. Worse, a precision
 * that disagrees across the two stages fails to LINK with no diagnostic on some drivers, so this
 * string is shared by both on purpose.
 */
const GLSL_PREAMBLE =
  "#version 300 es\nprecision highp float;\nprecision highp int;\n#define HB_GPU_ATLAS_2D\n";

/**
 * OUR macro, and the reason it is not HarfBuzz's `HB_GPU_NO_MSAA`, which is the whole safety
 * argument for {@link HbGpuRendererOptions.spreadTapMsaa}.
 *
 * `HB_GPU_NO_MSAA` is defined by the vendored library and guards `_hb_gpu_slug` — the FILL. Reusing
 * it to switch the dilation's taps would switch the fill's five-sample average off at the same time,
 * silently, and the fill is the one thing this trade is not allowed to touch. A separate name makes
 * that structural rather than a thing to remember: `hb_gpu_draw` reaches `_hb_gpu_slug` inside the
 * library's own source, which this define cannot reach into.
 */
const SPREAD_TAP_NO_MSAA_DEFINE = "#define HB_GPU_SPREAD_TAP_NO_MSAA\n";

/**
 * THE DILATION'S WHOLE TAP BUDGET, as one number, and the reason it is one number.
 *
 * It bounds the flat loop in {@link FRAGMENT_MAIN} — one tap per iteration — so the compile-time
 * ceiling IS the worst-case tap count: 64 unrolled sites, plus `hb_gpu_draw`'s own centre tap, is 65
 * evaluations for the most expensive fragment there is. That was also the ceiling of the nested
 * `4 rings x 16 steps` loops this replaced, so the redistribution below is free at the top end.
 *
 * WHY THE SHAPE CHANGED RATHER THAN THE NUMBER. The nested form clamped EVERY ring to the same 16
 * steps, so past `radius * t > 2.5 px` all four rings ran 16 taps — and the outermost one, which is
 * the only ring that decides where the dilated boundary lands, was then the SPARSEST: at radius 12
 * its taps sit 4.71 px of arc apart, while ring 1 spends the same 16 on a circle a quarter the size
 * and puts them 1.18 px apart. Giving
 * the outer ring more steps in that shape would have meant raising the per-ring cap, and 4 x 28 is
 * 112 unrolled sites for a budget most fragments never spend. A flat loop makes "how many taps may a
 * fragment cost" and "how are they arranged" two independent decisions, and only the first one is a
 * perf number.
 *
 * INTERPOLATED INTO THE GLSL rather than restated there, so `spreadBudget.test.ts` can assert on the
 * arithmetic that divides it between rings and on the ceiling reaching the shader, from one source.
 */
export const HB_GPU_SPREAD_MAX_TAPS = 64;

/**
 * OUR entry point for the vertex stage. Roughly 30 lines, and unavoidably ours.
 *
 * HarfBuzz ships `hb_gpu_dilate` and no `main`, because it cannot know what a consumer's
 * attributes are called. Upstream writes the same wrapper for its demo in
 * `util/gpu/demo-vertex.glsl`; this one is written against `hb-gpu-vertex.glsl`'s documented
 * contract rather than copied from it, and it differs where the pipeline does — a corner is
 * interpolated out of an instance record here, where upstream reads four expanded vertices.
 *
 * `jac` IS THE INVERSE OF THE EM-TO-OBJECT LINEAR PART, and the y term is negative because em
 * space is y-up and this renderer's object space is y-down device pixels. HarfBuzz's header spells
 * out the case: em-to-object `[[s, 0], [0, -s]]` gives `jac = (1/s, 0, 0, -1/s)`, and `1/s` is
 * exactly `a_emPerPos`. Drop the sign and the dilation pushes the texcoord the wrong way in y,
 * which shows up as a half-pixel of missing ink along horizontal edges only.
 *
 * IT ALSO GROWS THE QUAD BY {@link HbGpuRenderer.setSpread}, AND WITHOUT THAT THERE IS NO OUTLINE
 * AT ALL. `a_position` / `a_texcoord` are the glyph's INK box: the fragment stage's dilation is a
 * max of coverage taps up to `spread` away, so ink that is `spread` OUTSIDE the box has to have a
 * fragment to be found from. Left out, every tap that would have reached ink is simply never
 * rasterised and the whole feature fails as "the outline did not appear" — silently, with a
 * perfectly correct-looking fill. Measured by deleting these two lines: the dilated ink box then
 * grows 0-1 px instead of 4, while the superset and interior checks stay green.
 *
 * THE EXPANSION GOES THROUGH `jac`, not through a hand-written sign pattern, and that is worth the
 * one extra line. `a_normal` IS the object-space outward normal at this corner (the file header
 * says why), so `a_normal * a_spreadPx` is the object-space displacement; `jac` is by definition
 * the map from an object displacement to the em displacement that matches it, which is exactly
 * what `hb_gpu_dilate` uses it for two lines below. Spelling the em half out separately would be a
 * second chance to get the y flip backwards, and a backwards y flip here reads as an outline that
 * is present but shifted — not as an error.
 */
const BATCHED_VERTEX_MAIN = `
uniform mat4 u_viewProjection;
uniform vec2 u_viewport;

/* Per-vertex: the corner sign, which IS the outward normal at that corner. */
in vec2 a_normal;

/* Per-instance, divisor 1. */
in vec4 a_position;   /* object-space box: (x at cx=0, y at cy=0, x at cx=1, y at cy=1) */
in vec4 a_texcoord;   /* em-space ink box: (minX, minY, maxX, maxY) */
in float a_emPerPos;  /* em units per object unit, i.e. upem / pixelsPerEm */
in uint a_glyphLoc;   /* first texel of this glyph's blob in the atlas */
in vec2 a_model0;
in vec2 a_model1;
in vec2 a_model2;
in vec4 a_color;
in float a_spreadPx;

out vec2 v_texcoord;
flat out uint v_glyphLoc;
/* The spread in EM units for THIS instance. Flat, and a varying rather than a second uniform,
 * because the object-to-em factor is a_emPerPos and that is per-instance: one uniform in em units
 * could not mean the same number of pixels for two glyphs pushed at different pixelsPerEm. */
flat out float v_spreadEm;
flat out float v_spreadPx;
flat out vec4 v_color;

void main ()
{
  /* (-1, +1) -> (0, 0) and (+1, -1) -> (1, 1): the y term is flipped because a corner's outward
   * normal points UP in object space exactly when it is the box's minimum em coordinate. */
  vec2 corner = vec2 (a_normal.x, -a_normal.y) * 0.5 + 0.5;

  vec2 pos = mix (a_position.xy, a_position.zw, corner);
  vec2 tex = mix (a_texcoord.xy, a_texcoord.zw, corner);

  vec4 jac = vec4 (a_emPerPos, 0.0, 0.0, -a_emPerPos);
  mat4 model = mat4 (
    vec4 (a_model0, 0.0, 0.0),
    vec4 (a_model1, 0.0, 0.0),
    vec4 (0.0, 0.0, 1.0, 0.0),
    vec4 (a_model2, 0.0, 1.0));
  mat4 mvp = u_viewProjection * model;
  float spreadPx = a_spreadPx;
  vec4 color = a_color;

  /* At spread 0 both of these add 0.0, which is the identity for every finite value — the fill
   * path really is byte-for-byte what it was before the outline path existed. */
  vec2 spreadPos = a_normal * spreadPx;
  pos += spreadPos;
  tex += vec2 (dot (spreadPos, jac.xy), dot (spreadPos, jac.zw));

  hb_gpu_dilate (pos, tex, a_normal, jac, mvp, u_viewport);

  gl_Position = mvp * vec4 (pos, 0.0, 1.0);
  v_texcoord = tex;
  v_glyphLoc = a_glyphLoc;
  v_spreadEm = spreadPx * a_emPerPos;
  v_spreadPx = spreadPx;
  v_color = color;
}
`;

const VERTEX_MAIN = `
uniform mat4 u_matViewProjection;
uniform vec2 u_viewport;
uniform float u_spreadPx;  /* OBJECT units, pre-model. 0 disables the whole path. */

/* Per-vertex: the corner sign, which IS the outward normal at that corner. */
in vec2 a_normal;

/* Per-instance, divisor 1. */
in vec4 a_position;   /* object-space box: (x at cx=0, y at cy=0, x at cx=1, y at cy=1) */
in vec4 a_texcoord;   /* em-space ink box: (minX, minY, maxX, maxY) */
in float a_emPerPos;  /* em units per object unit, i.e. upem / pixelsPerEm */
in uint a_glyphLoc;   /* first texel of this glyph's blob in the atlas */

out vec2 v_texcoord;
flat out uint v_glyphLoc;
/* The spread in EM units for THIS instance. Flat, and a varying rather than a second uniform,
 * because the object-to-em factor is a_emPerPos and that is per-instance: one uniform in em units
 * could not mean the same number of pixels for two glyphs pushed at different pixelsPerEm. */
flat out float v_spreadEm;

void main ()
{
  /* (-1, +1) -> (0, 0) and (+1, -1) -> (1, 1): the y term is flipped because a corner's outward
   * normal points UP in object space exactly when it is the box's minimum em coordinate. */
  vec2 corner = vec2 (a_normal.x, -a_normal.y) * 0.5 + 0.5;

  vec2 pos = mix (a_position.xy, a_position.zw, corner);
  vec2 tex = mix (a_texcoord.xy, a_texcoord.zw, corner);

  vec4 jac = vec4 (a_emPerPos, 0.0, 0.0, -a_emPerPos);

  /* At spread 0 both of these add 0.0, which is the identity for every finite value — the fill
   * path really is byte-for-byte what it was before the outline path existed. */
  vec2 spreadPos = a_normal * u_spreadPx;
  pos += spreadPos;
  tex += vec2 (dot (spreadPos, jac.xy), dot (spreadPos, jac.zw));

  hb_gpu_dilate (pos, tex, a_normal, jac, u_matViewProjection, u_viewport);

  gl_Position = u_matViewProjection * vec4 (pos, 0.0, 1.0);
  v_texcoord = tex;
  v_glyphLoc = a_glyphLoc;
  v_spreadEm = u_spreadPx * a_emPerPos;
}
`;

/**
 * OUR entry point for the fragment stage. Same ownership note as {@link VERTEX_MAIN}.
 *
 * STEM DARKENING AND GAMMA ARE HERE AND ON BY DEFAULT, and the thing that is now a MEASUREMENT
 * decision is switching them OFF — see {@link HbGpuRendererOptions.contrast} and
 * {@link HB_GPU_CONTRAST_NONE}. Both are contrast corrections that move coverage AWAY from correct
 * area coverage, which is exactly what a fidelity arm grades against (`docs/text-rendering.md`: the
 * reference is an 8x render box-downsampled, "a ceiling, not a mechanism"), so a HARNESS that left
 * them on would be scoring its own contrast curve. A shipping consumer is not a harness: raw
 * coverage puts a sub-pixel stem at mid-grey where a browser puts it near the ink colour, which is
 * measurably why DOM text out-reads this path at small sizes.
 *
 * The block below is `util/gpu/demo-fragment.glsl`'s, with two differences that are ours:
 * `brightness` comes off per-instance `v_color.rgb` directly (which is STRAIGHT, so upstream's divide by the
 * premultiplied alpha is already done) and the ppem is HarfBuzz's own `hb_gpu_ppem` rather than
 * `1.0 / max (fwidth (v_texcoord).xy)` — this file's render coordinates are FONT UNITS, so the
 * reciprocal of their derivative is pixels per font unit and would put the `smoothstep (8, 48)`
 * ramp a factor of `upem` off. `hb_gpu_ppem` folds the glyph's own scale in and is what
 * `hb_gpu_spread_tap` above already agrees with.
 *
 * THE OUTLINE IS A MAX OF COVERAGE TAPS, BECAUSE THERE IS NO DISTANCE FIELD TO OFFSET. HarfBuzz's
 * entire public GLSL surface is `hb_gpu_draw` (coverage), `hb_gpu_ppem` and `hb_gpu_stem_darken` —
 * there is no signed distance anywhere in the format, so "dilate by r" cannot be a threshold shift
 * and has to be "is any point within r of this one inside the glyph", sampled. See
 * {@link HbGpuRenderer.setSpread} for what that costs and where it differs from a real stroke.
 *
 * EXPORTED SO THE TAP BUDGET CAN BE ASSERTED WITHOUT A GPU. `spreadBudget.test.ts` reads the
 * interpolated {@link HB_GPU_SPREAD_MAX_TAPS} back out of this text; a compiled shader is the one
 * place the constant has to be right, and the pixel suite that compiles it is gated on a display.
 */
const BATCHED_FRAGMENT_MAIN = `
uniform float u_gamma;       /* exponent on the final coverage; 1.0 is off */
uniform float u_stemDarken;  /* > 0 runs hb_gpu_stem_darken; 0 is off */

in vec2 v_texcoord;
flat in uint v_glyphLoc;
flat in float v_spreadEm;
flat in float v_spreadPx;
flat in vec4 v_color;

out vec4 fragColor;

const float HB_GPU_SPREAD_TAU = 6.2831853;
/* Hard ceilings so the loop is bounded at compile time. One tap per iteration, so
 * HB_GPU_SPREAD_MAX_TAPS + the centre tap is the worst case, and it is only reached by a fragment
 * that is neither solid ink nor near any. See the TS constant of the same name. */
const int HB_GPU_SPREAD_MAX_RINGS = 4;
const int HB_GPU_SPREAD_MAX_TAPS = ${HB_GPU_SPREAD_MAX_TAPS};
/* "Already saturated": no tap can raise this, so stop. Not 1.0, because the coverage estimator
 * lands a hair under it on a deep-interior fragment and an exact test would never fire. */
const float HB_GPU_SPREAD_SOLID = 0.999;

/*
 * WHERE A TAP STOPS MEANING "how much ink is at this offset" AND STARTS MEANING "is this fragment
 * inside the dilated silhouette". The knee of a smoothstep, and the whole of the fix below.
 *
 * NO BACKTICKS ANYWHERE IN THIS COMMENT, and that is not a style note: this whole string is a JS
 * template literal, so one backtick ends the shader mid-sentence and the package fails to PARSE.
 *
 * THE BUG IT REMOVES. A dilated shape is the union of a disk of radius r swept along the outline:
 * a BINARY shape, whose only partial coverage is at its own boundary. A max of raw coverage taps
 * cannot produce that, because a max cannot exceed the largest coverage near the fragment — and at
 * ppem 14 a Han stroke is thinner than a pixel, so its coverage PEAKS at 0.42 and the whole
 * silhouette came out a translucent mottle at 0.62 of the ideal's ink.
 *
 * THE RANGE IS 0 TO 0.5, AND "A TAP ABOVE HALF COVERAGE IS INSIDE" IS THE RULE THAT FAILS. That is
 * the obvious reading and it makes this case measurably WORSE, which is why the knee is a swept
 * number rather than an argued one. Half of a PIXEL is not half of a sub-pixel STROKE: at ppem 14
 * the fixture's peak coverage is 0.42, so a knee centred on 0.5 sits above anything the glyph can
 * reach and ERASES the outline. What 0.5 is the right value for is the top of the range — a pixel
 * centred exactly ON the outline reads 0.5, so "as covered as a pixel on the boundary" is the point
 * at which a tap is fully inside, and everything below it ramps.
 *
 * SWEPT ON THE RTX 2060 THROUGH ANGLE, both fixtures, against 8x grown references. Low-ppem is
 * 中 at 14 px per em rotated 10 degrees, spread 3 (SHALLOW COVERAGE); thin is a full stop at 96 px
 * per em, spread 12 (SPARSE COVERING — no 64-tap set tiles a disk of that radius; the sweep was run
 * when those taps were four rings of 16, and the rim column moved again when they were resplit).
 *
 *   knee          low rim rms   low ink ratio   low interior short   thin rim rms   thin ink ratio
 *   none            77.89           0.622            38.5%              80.90           0.965
 *   0.35 - 0.65    128.57           0.574            (worse still)     102.52           0.966
 *   0.25 - 0.75    112.35           0.604             ---               99.72           0.965
 *   0.20 - 0.50     76.87           0.870             ---               94.27           0.974
 *   0.15 - 0.45     73.85           0.968             ---               90.15           0.978
 *   0.10 - 0.40     84.75           1.037             ---               85.82           0.985
 *   0.05 - 0.45     79.40           1.011             4.1%              82.16           0.986
 *   0.05 - 0.50     72.64           0.968             7.4%              82.81           0.983
 *   0.00 - 0.45     83.29           1.026             3.3%              78.86           0.990
 *   0.00 - 0.55     69.73           0.947             9.3%              79.96           0.984
 *   0.00 - 0.50     75.66           0.988             6.1%              79.10           0.987   <-
 *
 * The two upper rows are the "roughly half" hypothesis and both are worse than shipping nothing.
 * 0 - 0.5 is the only row that improves EVERY column at once, and it is also the one with a
 * sentence behind it rather than a fit.
 *
 * WHAT IT COSTS AT LARGE PPEM. A well-resolved glyph's tap coverage IS the area, so a tap sitting
 * exactly on the outline reads 0.5 — and 0.5 is also the ideal answer at the dilated boundary,
 * where this maps it to 1. So the boundary moves outward by a fraction of a pixel: measured, the
 * 96 px per em ink box grows 5 px on one side for a spread of 4 instead of 4. Real, inside the
 * fixtures' SPREAD_TOLERANCE_PX, and the price of an interior that is no longer translucent.
 *
 * PER TAP RATHER THAN ON THE MAX, AND NOT FOR THE REASON IT LOOKS LIKE. smoothstep is MONOTONE, so
 * it commutes with max and the two placements give the same silhouette — measured, not reasoned:
 * moving it after the loop reads ink ratio 0.989 against 0.988 and the same rim RMS to two decimal
 * places. What the placement actually buys is the two things a monotone identity does not cover.
 * First, the FILL IS THE FLOOR: cov enters the loop as hb_gpu_draw's own coverage and is never
 * sharpened, so a dilated run stays a strict SUPERSET of the same run at spread 0 — sharpening the
 * max would put the fill through the knee too, and smoothstep(0, 0.5, x) is BELOW x for x under
 * ~0.08, so a faint fill pixel would come back dimmer than it was drawn. Second, the early-out
 * below tests cov INSIDE the loop, and only a per-tap value can raise it early.
 *
 * IT DOES NOT MAKE THE EARLY-OUT FIRE AT 14 px, WHICH THE ROUND EXPECTED IT TO. A tap saturates to
 * exactly 1 only once its raw coverage reaches HB_GPU_SPREAD_INSIDE_HIGH, and at ppem 14 the
 * fixture's peak raw coverage is 0.42, which sharpens to 0.931 — still under
 * HB_GPU_SPREAD_SOLID. So a fragment at that size still walks the whole tap set, and the frame-cost
 * side effect that was predicted here IS NOT THERE. Above ppem 16 taps reached 1 before this change
 * as well, so nothing moved there either. Lowering HB_GPU_SPREAD_SOLID would collect it, and is
 * deliberately not done here: it is a cost decision with its own pixels to grade, on a rung where
 * the tap budget is a device ceiling.
 */
const float HB_GPU_SPREAD_INSIDE_LOW = 0.0;
const float HB_GPU_SPREAD_INSIDE_HIGH = 0.5;

/*
 * One coverage tap, WITH NO DERIVATIVE IN IT — which is the whole reason this exists.
 *
 * It is _hb_gpu_slug (hb-gpu-fragment.glsl, 14.4.0) with ppem lifted into a parameter. The
 * library's own _hb_gpu_slug advertises itself as callable "from non-uniform control flow", and
 * for GLSL it is not: it calls hb_gpu_ppem, which calls fwidth. The disk below has a per-fragment
 * early-out, so every tap after that point IS non-uniform control flow, and a fwidth there is
 * undefined by GLSL ES 3.00.
 *
 * MIRRORED RATHER THAN AVOIDED so an outline tap and a fill fragment agree. Lifting ppem is exact
 * rather than an approximation: it is fwidth(v_texcoord) and the glyph's own scale, and fwidth of an
 * interpolated varying is constant across an affine quad, so its value at a tap equals its value at
 * the centre.
 *
 * THE MSAA HALF IS SWITCHABLE AND THE DEFAULT IS OFF — see
 * {@link HbGpuRendererOptions.spreadTapMsaa}, which carries the measurement. Note the macro is
 * HB_GPU_SPREAD_TAP_NO_MSAA and NOT the library's HB_GPU_NO_MSAA: that one guards _hb_gpu_slug,
 * i.e. the FILL, which this trade must not touch.
 *
 * The vendored wasm is digest-pinned (vendor/VENDOR.md, test/vendor.test.ts), so the source this
 * mirrors cannot move without a deliberate vendor bump.
 */
float hb_gpu_spread_tap (vec2 rc, vec2 pixelsPerEm, float ppem, uint glyphLoc_)
{
  float c = _hb_gpu_slug_single (rc, pixelsPerEm, glyphLoc_);
#ifndef HB_GPU_SPREAD_TAP_NO_MSAA
  if (ppem < 16.0)
  {
    vec2 emsPerPixel = 1.0 / pixelsPerEm;
    vec2 d = emsPerPixel * (1.0 / 3.0);
    float msaa = 0.25 *
      (_hb_gpu_slug_single (rc + vec2 (-d.x, -d.y), pixelsPerEm, glyphLoc_) +
       _hb_gpu_slug_single (rc + vec2 ( d.x, -d.y), pixelsPerEm, glyphLoc_) +
       _hb_gpu_slug_single (rc + vec2 (-d.x,  d.y), pixelsPerEm, glyphLoc_) +
       _hb_gpu_slug_single (rc + vec2 ( d.x,  d.y), pixelsPerEm, glyphLoc_));
    c = mix (c, msaa, smoothstep (16.0, 8.0, ppem));
  }
#endif
  return c;
}

void main ()
{
  float cov = hb_gpu_draw (v_texcoord, v_glyphLoc);

  /* PER-PRIMITIVE CONTROL FLOW: the two derivative-taking calls inside see flat run state, so all
   * fragments of one glyph primitive take the same branch. v_spreadPx and v_spreadEm are flat
   * (constant over a primitive, which is what a derivative
   * quad belongs to), so it is uniform by construction rather than by luck. v_spreadEm is also a
   * genuine guard: a NaN or zero a_emPerPos fails it and takes the single-tap path. */
  if (v_spreadPx > 0.0 && v_spreadEm > 0.0)
  {
    vec2 pixelsPerEm = 1.0 / fwidth (v_texcoord);
    float ppem = hb_gpu_ppem (v_texcoord, v_glyphLoc);
    /* The spread in DEVICE pixels — fwidth is a screen-space derivative, so this already carries
     * the model scale and the device-pixel ratio. It only ever picks tap counts; the tap OFFSETS
     * are in em units and are exact. */
    float radiusPx = v_spreadEm * max (pixelsPerEm.x, pixelsPerEm.y);

    /* CONCENTRIC RINGS, NOT ONE, and that is not a refinement. A dilated fragment is covered iff
     * SOME offset within the disk lands on ink; taps on a single ring of radius r can all overshoot
     * a feature narrower than 2r, which punches holes through the outline exactly where a glyph is
     * thin — a comma, a hairline serif, a full stop. Ring spacing is held near 2/3 px, so the RADIAL
     * half of the covering is sub-pixel out to the clamp at HB_GPU_SPREAD_MAX_RINGS.
     *
     * THE RADII STAY EQUALLY SPACED, which is worth saying because equal AREA is the obvious
     * alternative and it is worse here. Pushing the rings outward concentrates them where the taps
     * are already densest, and combined with the budget split below it both doubles the outward bias
     * of the whole tap set and halves the radial margin the small-feature case relies on — the one
     * where a full stop smaller than the tap radius has to be found by an INNER ring. */
    int rings = clamp (int (ceil (radiusPx * 1.5)), 1, HB_GPU_SPREAD_MAX_RINGS);
    /* 1 + 2 + ... + rings, the denominator of the budget split below. */
    int denom = rings * (rings + 1) / 2;

    /* ONE FLAT LOOP OVER THE WHOLE BUDGET, AND THE OUTER RING GETS MOST OF IT.
     *
     * Every ring used to be capped at the same number of steps, which sounds neutral and is not: a
     * ring's taps are spread over a circumference proportional to its radius, so an equal share puts
     * the WIDEST arc gaps on the outermost ring — the only one that decides where the dilated
     * boundary lands. At radius 12 that was 4.71 px of arc between the taps that draw the edge,
     * against 1.18 px on ring 1, and the boundary followed the tap count: measured against a Godot
     * 4.5.1 golden, 0.3099 px of wobble at exactly 16 cycles per revolution where the engine has
     * 0.0164.
     *
     * So the budget is split in proportion to ring RADIUS, i.e. to circumference: ring k of rings
     * may spend (MAX_TAPS * k + denom/2) / denom taps, which at four rings is 6 / 13 / 19 / 26 and
     * sums to exactly MAX_TAPS. It sums to exactly MAX_TAPS at one, two and three rings as well
     * (64; 21 + 43; 11 + 21 + 32), so the flat bound is never the thing that truncates a ring — it
     * is a hedge against a driver that insists on unrolling, not a second policy. At radius 12 the
     * outer arc is then 2.90 px rather than 4.71.
     *
     * The lower clamp of 6 steps is what keeps a SMALL radius honest, and it is the reason the cap
     * enters as max (cap, 6) rather than as cap: ring 1's share at four rings is exactly 6, and a
     * hexagon is the coarsest ring that still surrounds its centre.
     *
     * ONE TAP PER ITERATION, so HB_GPU_SPREAD_MAX_TAPS is simultaneously the loop bound and the
     * fragment's worst-case cost — the two used to be 4 x 16 and 65 and had to be reasoned about
     * separately. Dynamic bounds and breaks are legal ESSL 3.00; the GLSL ES 1.00 Appendix A
     * restriction that forced the nested constant shape does not apply to version 300 es. */
    int ring = 0;
    int step = 0;
    int steps = 0;
    float ringEm = 0.0;
    float phase = 0.0;
    for (int i = 0; i < HB_GPU_SPREAD_MAX_TAPS; i++)
    {
      /* THE INTERIOR EARLY-OUT: a fragment already covered by its own centre tap is trivially
       * within r of ink, and interior fragments are most of a glyph. */
      if (cov >= HB_GPU_SPREAD_SOLID) break;
      if (step >= steps)
      {
        ring += 1;
        /* The other exit: the rings this radius actually asked for are done. */
        if (ring > rings) break;
        float t = float (ring) / float (rings);
        ringEm = v_spreadEm * t;
        int cap = (HB_GPU_SPREAD_MAX_TAPS * ring + denom / 2) / denom;
        steps = clamp (int (ceil (HB_GPU_SPREAD_TAU * radiusPx * t)), 6, max (cap, 6));
        /* THE GOLDEN ANGLE, so no two rings put their taps on the same radii — which would leave
         * wedge-shaped gaps between the rings rather than a covering. A fixed fraction of a step
         * would do that for one pair of ring counts and line up for another; 137.5 degrees per ring
         * is the rotation with no small-integer commensurability with any of them. */
        phase = 2.39996 * float (ring);
        step = 0;
      }
      float angle = phase + HB_GPU_SPREAD_TAU * float (step) / float (steps);
      vec2 at = v_texcoord + ringEm * vec2 (cos (angle), sin (angle));
      /* MAX, NOT A SUM, AND THE MAX IS WHY THIS IS IN THE SHADER. The alternative a caller could
       * build without it — draw the run N times at N offsets — composites N times, so a
       * translucent outline is N overlapping translucent copies and reads far darker than one
       * stroke. One fragment, one coverage, one blend.
       *
       * SHARPENED BEFORE THE MAX, not after: the max is over a set of INSIDE tests, and the union
       * of disks it approximates is a binary shape. Sharpening the max instead would sharpen a
       * number that had already been flattened to the peak coverage nearby, which is the value
       * that is wrong. See HB_GPU_SPREAD_INSIDE_LOW. */
      cov = max (cov, smoothstep (HB_GPU_SPREAD_INSIDE_LOW,
                                  HB_GPU_SPREAD_INSIDE_HIGH,
                                  hb_gpu_spread_tap (at, pixelsPerEm, ppem, v_glyphLoc)));
      step += 1;
    }
  }

  /* CONTRAST, ON THE FINAL COVERAGE — and STEM DARKENING ONLY WHEN THE DILATION DID NOT RUN.
   *
   * An outline's rim is NOT a coverage ramp with the same problem the fill's has, which is what
   * this block assumed when it shipped. Stem darkening exists because a sub-pixel STEM lands at
   * mid-grey under linear coverage where a browser puts it near the ink colour; the fix is an
   * exponent that pushes the middle of the ramp toward the foreground. A dilated fragment's
   * coverage is not that number. The taps above are an INSIDE test (HB_GPU_SPREAD_INSIDE_LOW
   * sharpens each one before the max), so the dilated boundary is already very nearly binary — and
   * the engine this mirrors applies no curve at all to its outline: Godot strokes the glyph and
   * hands the result to FreeType's plain grayscale raster. Measured against that golden, the curve
   * took a 14 px outline's rim from 0.662 px to 1.965 px of equivalent ramp, three times the width,
   * where Godot's own is 0.851. That is a halo — fattening for dark ink, thinning for light — and
   * it is the one thing in this shader that made an outline softer than the engine's.
   *
   * THE GATE IS THE DILATION BRANCH'S OWN CONDITION, CHARACTER FOR CHARACTER, so the two cannot
   * disagree about which fragments dilated. A bare v_spreadPx > 0.0 would also strip the
   * correction from a DEGENERATE run — one whose a_emPerPos is zero or NaN, which fails
   * v_spreadEm > 0.0 and takes the single-tap path. Such a fragment is a fill in every way that
   * reaches the framebuffer, and it should keep a fill's darkening rather than lose it to a uniform
   * that ended up doing nothing.
   *
   * GAMMA IS NOT GATED. It is an explicit consumer knob, defaults to 1 (skipped entirely below),
   * and is polarity- and size-blind by construction; a consumer that deliberately sets one is
   * asking for a transfer curve on the text, and putting the fill and the outline of the same run
   * on different curves would be a stranger thing than either choice.
   *
   * THE PPEM IS FETCHED IN UNIFORM CONTROL FLOW AND THE COVERAGE TEST IS NOT ALLOWED TO CONTAIN IT.
   * hb_gpu_ppem calls fwidth, which GLSL ES 3.00 leaves undefined once the 2x2 derivative quad can
   * disagree about whether to run it — and "0.0 < cov < 1.0" is precisely a per-fragment condition.
   * u_stemDarken is uniform while v_spreadPx and v_spreadEm are flat, which is the same
   * argument the dilation branch above makes for its own hb_gpu_ppem call; darken is that branch's
   * predicate negated, so a quad coherent enough to run the dilation is exactly as coherent about
   * skipping the darkening. Upstream's demo puts its fwidth inside the coverage test; that is a
   * desktop-GLSL liberty this cannot take.
   */
  bool fillPass = !(v_spreadPx > 0.0 && v_spreadEm > 0.0);
  bool darken = u_stemDarken > 0.0 && fillPass;

  float darkenPpem = 0.0;
  if (darken)
    darkenPpem = hb_gpu_ppem (v_texcoord, v_glyphLoc);

  /* EDGE ONLY, which is upstream's guard and is not merely an optimisation here. Both corrections
   * fix 0 and 1, so the interior and the background cannot move whatever the exponents are — but
   * pow (0.0, y) is UNDEFINED for y <= 0 in GLSL ES 3.00, and u_gamma is a number a consumer chose.
   * Skipping cov == 0.0 is what makes a hostile gamma a picture that is wrong rather than a NaN
   * alpha over the whole quad. No derivative is taken inside, so a non-uniform branch is legal. */
  if (cov > 0.0 && cov < 1.0)
  {
    float adj = cov;
    if (darken)
    {
      /* v_color is STRAIGHT, so this IS upstream's dot (c.rgb, 1/3) / c.a with the divide already
       * done. A flat 1/3 rather than a Rec.709 luma on purpose: hb_gpu_stem_darken's exponent
       * curve is calibrated against HarfBuzz's own definition of "brightness", and weighting the
       * channels differently would silently retune somebody else's constants. */
      adj = hb_gpu_stem_darken (adj, dot (v_color.rgb, vec3 (1.0 / 3.0)), darkenPpem);
    }
    if (u_gamma != 1.0)
      adj = pow (adj, u_gamma);
    cov = adj;
  }

  float a = v_color.a * cov;
  fragColor = vec4 (v_color.rgb * a, a);
}
`;

export const FRAGMENT_MAIN = `
uniform vec4 u_color;   /* STRAIGHT rgba; premultiplied exactly once, below */
uniform float u_spreadPx;
uniform float u_gamma;       /* exponent on the final coverage; 1.0 is off */
uniform float u_stemDarken;  /* > 0 runs hb_gpu_stem_darken; 0 is off */

in vec2 v_texcoord;
flat in uint v_glyphLoc;
flat in float v_spreadEm;

out vec4 fragColor;

const float HB_GPU_SPREAD_TAU = 6.2831853;
/* Hard ceilings so the loop is bounded at compile time. One tap per iteration, so
 * HB_GPU_SPREAD_MAX_TAPS + the centre tap is the worst case, and it is only reached by a fragment
 * that is neither solid ink nor near any. See the TS constant of the same name. */
const int HB_GPU_SPREAD_MAX_RINGS = 4;
const int HB_GPU_SPREAD_MAX_TAPS = ${HB_GPU_SPREAD_MAX_TAPS};
/* "Already saturated": no tap can raise this, so stop. Not 1.0, because the coverage estimator
 * lands a hair under it on a deep-interior fragment and an exact test would never fire. */
const float HB_GPU_SPREAD_SOLID = 0.999;

/*
 * WHERE A TAP STOPS MEANING "how much ink is at this offset" AND STARTS MEANING "is this fragment
 * inside the dilated silhouette". The knee of a smoothstep, and the whole of the fix below.
 *
 * NO BACKTICKS ANYWHERE IN THIS COMMENT, and that is not a style note: this whole string is a JS
 * template literal, so one backtick ends the shader mid-sentence and the package fails to PARSE.
 *
 * THE BUG IT REMOVES. A dilated shape is the union of a disk of radius r swept along the outline:
 * a BINARY shape, whose only partial coverage is at its own boundary. A max of raw coverage taps
 * cannot produce that, because a max cannot exceed the largest coverage near the fragment — and at
 * ppem 14 a Han stroke is thinner than a pixel, so its coverage PEAKS at 0.42 and the whole
 * silhouette came out a translucent mottle at 0.62 of the ideal's ink.
 *
 * THE RANGE IS 0 TO 0.5, AND "A TAP ABOVE HALF COVERAGE IS INSIDE" IS THE RULE THAT FAILS. That is
 * the obvious reading and it makes this case measurably WORSE, which is why the knee is a swept
 * number rather than an argued one. Half of a PIXEL is not half of a sub-pixel STROKE: at ppem 14
 * the fixture's peak coverage is 0.42, so a knee centred on 0.5 sits above anything the glyph can
 * reach and ERASES the outline. What 0.5 is the right value for is the top of the range — a pixel
 * centred exactly ON the outline reads 0.5, so "as covered as a pixel on the boundary" is the point
 * at which a tap is fully inside, and everything below it ramps.
 *
 * SWEPT ON THE RTX 2060 THROUGH ANGLE, both fixtures, against 8x grown references. Low-ppem is
 * 中 at 14 px per em rotated 10 degrees, spread 3 (SHALLOW COVERAGE); thin is a full stop at 96 px
 * per em, spread 12 (SPARSE COVERING — no 64-tap set tiles a disk of that radius; the sweep was run
 * when those taps were four rings of 16, and the rim column moved again when they were resplit).
 *
 *   knee          low rim rms   low ink ratio   low interior short   thin rim rms   thin ink ratio
 *   none            77.89           0.622            38.5%              80.90           0.965
 *   0.35 - 0.65    128.57           0.574            (worse still)     102.52           0.966
 *   0.25 - 0.75    112.35           0.604             ---               99.72           0.965
 *   0.20 - 0.50     76.87           0.870             ---               94.27           0.974
 *   0.15 - 0.45     73.85           0.968             ---               90.15           0.978
 *   0.10 - 0.40     84.75           1.037             ---               85.82           0.985
 *   0.05 - 0.45     79.40           1.011             4.1%              82.16           0.986
 *   0.05 - 0.50     72.64           0.968             7.4%              82.81           0.983
 *   0.00 - 0.45     83.29           1.026             3.3%              78.86           0.990
 *   0.00 - 0.55     69.73           0.947             9.3%              79.96           0.984
 *   0.00 - 0.50     75.66           0.988             6.1%              79.10           0.987   <-
 *
 * The two upper rows are the "roughly half" hypothesis and both are worse than shipping nothing.
 * 0 - 0.5 is the only row that improves EVERY column at once, and it is also the one with a
 * sentence behind it rather than a fit.
 *
 * WHAT IT COSTS AT LARGE PPEM. A well-resolved glyph's tap coverage IS the area, so a tap sitting
 * exactly on the outline reads 0.5 — and 0.5 is also the ideal answer at the dilated boundary,
 * where this maps it to 1. So the boundary moves outward by a fraction of a pixel: measured, the
 * 96 px per em ink box grows 5 px on one side for a spread of 4 instead of 4. Real, inside the
 * fixtures' SPREAD_TOLERANCE_PX, and the price of an interior that is no longer translucent.
 *
 * PER TAP RATHER THAN ON THE MAX, AND NOT FOR THE REASON IT LOOKS LIKE. smoothstep is MONOTONE, so
 * it commutes with max and the two placements give the same silhouette — measured, not reasoned:
 * moving it after the loop reads ink ratio 0.989 against 0.988 and the same rim RMS to two decimal
 * places. What the placement actually buys is the two things a monotone identity does not cover.
 * First, the FILL IS THE FLOOR: cov enters the loop as hb_gpu_draw's own coverage and is never
 * sharpened, so a dilated run stays a strict SUPERSET of the same run at spread 0 — sharpening the
 * max would put the fill through the knee too, and smoothstep(0, 0.5, x) is BELOW x for x under
 * ~0.08, so a faint fill pixel would come back dimmer than it was drawn. Second, the early-out
 * below tests cov INSIDE the loop, and only a per-tap value can raise it early.
 *
 * IT DOES NOT MAKE THE EARLY-OUT FIRE AT 14 px, WHICH THE ROUND EXPECTED IT TO. A tap saturates to
 * exactly 1 only once its raw coverage reaches HB_GPU_SPREAD_INSIDE_HIGH, and at ppem 14 the
 * fixture's peak raw coverage is 0.42, which sharpens to 0.931 — still under
 * HB_GPU_SPREAD_SOLID. So a fragment at that size still walks the whole tap set, and the frame-cost
 * side effect that was predicted here IS NOT THERE. Above ppem 16 taps reached 1 before this change
 * as well, so nothing moved there either. Lowering HB_GPU_SPREAD_SOLID would collect it, and is
 * deliberately not done here: it is a cost decision with its own pixels to grade, on a rung where
 * the tap budget is a device ceiling.
 */
const float HB_GPU_SPREAD_INSIDE_LOW = 0.0;
const float HB_GPU_SPREAD_INSIDE_HIGH = 0.5;

/*
 * One coverage tap, WITH NO DERIVATIVE IN IT — which is the whole reason this exists.
 *
 * It is _hb_gpu_slug (hb-gpu-fragment.glsl, 14.4.0) with ppem lifted into a parameter. The
 * library's own _hb_gpu_slug advertises itself as callable "from non-uniform control flow", and
 * for GLSL it is not: it calls hb_gpu_ppem, which calls fwidth. The disk below has a per-fragment
 * early-out, so every tap after that point IS non-uniform control flow, and a fwidth there is
 * undefined by GLSL ES 3.00.
 *
 * MIRRORED RATHER THAN AVOIDED so an outline tap and a fill fragment agree. Lifting ppem is exact
 * rather than an approximation: it is fwidth(v_texcoord) and the glyph's own scale, and fwidth of an
 * interpolated varying is constant across an affine quad, so its value at a tap equals its value at
 * the centre.
 *
 * THE MSAA HALF IS SWITCHABLE AND THE DEFAULT IS OFF — see
 * {@link HbGpuRendererOptions.spreadTapMsaa}, which carries the measurement. Note the macro is
 * HB_GPU_SPREAD_TAP_NO_MSAA and NOT the library's HB_GPU_NO_MSAA: that one guards _hb_gpu_slug,
 * i.e. the FILL, which this trade must not touch.
 *
 * The vendored wasm is digest-pinned (vendor/VENDOR.md, test/vendor.test.ts), so the source this
 * mirrors cannot move without a deliberate vendor bump.
 */
float hb_gpu_spread_tap (vec2 rc, vec2 pixelsPerEm, float ppem, uint glyphLoc_)
{
  float c = _hb_gpu_slug_single (rc, pixelsPerEm, glyphLoc_);
#ifndef HB_GPU_SPREAD_TAP_NO_MSAA
  if (ppem < 16.0)
  {
    vec2 emsPerPixel = 1.0 / pixelsPerEm;
    vec2 d = emsPerPixel * (1.0 / 3.0);
    float msaa = 0.25 *
      (_hb_gpu_slug_single (rc + vec2 (-d.x, -d.y), pixelsPerEm, glyphLoc_) +
       _hb_gpu_slug_single (rc + vec2 ( d.x, -d.y), pixelsPerEm, glyphLoc_) +
       _hb_gpu_slug_single (rc + vec2 (-d.x,  d.y), pixelsPerEm, glyphLoc_) +
       _hb_gpu_slug_single (rc + vec2 ( d.x,  d.y), pixelsPerEm, glyphLoc_));
    c = mix (c, msaa, smoothstep (16.0, 8.0, ppem));
  }
#endif
  return c;
}

void main ()
{
  float cov = hb_gpu_draw (v_texcoord, v_glyphLoc);

  /* UNIFORM CONTROL FLOW, AND IT HAS TO BE: the two derivative-taking calls inside are legal only
   * because every fragment of a 2x2 derivative quad takes this branch together. u_spreadPx is a
   * real uniform and v_spreadEm is flat (constant over a primitive, which is what a derivative
   * quad belongs to), so it is uniform by construction rather than by luck. v_spreadEm is also a
   * genuine guard: a NaN or zero a_emPerPos fails it and takes the single-tap path. */
  if (u_spreadPx > 0.0 && v_spreadEm > 0.0)
  {
    vec2 pixelsPerEm = 1.0 / fwidth (v_texcoord);
    float ppem = hb_gpu_ppem (v_texcoord, v_glyphLoc);
    /* The spread in DEVICE pixels — fwidth is a screen-space derivative, so this already carries
     * the model scale and the device-pixel ratio. It only ever picks tap counts; the tap OFFSETS
     * are in em units and are exact. */
    float radiusPx = v_spreadEm * max (pixelsPerEm.x, pixelsPerEm.y);

    /* CONCENTRIC RINGS, NOT ONE, and that is not a refinement. A dilated fragment is covered iff
     * SOME offset within the disk lands on ink; taps on a single ring of radius r can all overshoot
     * a feature narrower than 2r, which punches holes through the outline exactly where a glyph is
     * thin — a comma, a hairline serif, a full stop. Ring spacing is held near 2/3 px, so the RADIAL
     * half of the covering is sub-pixel out to the clamp at HB_GPU_SPREAD_MAX_RINGS.
     *
     * THE RADII STAY EQUALLY SPACED, which is worth saying because equal AREA is the obvious
     * alternative and it is worse here. Pushing the rings outward concentrates them where the taps
     * are already densest, and combined with the budget split below it both doubles the outward bias
     * of the whole tap set and halves the radial margin the small-feature case relies on — the one
     * where a full stop smaller than the tap radius has to be found by an INNER ring. */
    int rings = clamp (int (ceil (radiusPx * 1.5)), 1, HB_GPU_SPREAD_MAX_RINGS);
    /* 1 + 2 + ... + rings, the denominator of the budget split below. */
    int denom = rings * (rings + 1) / 2;

    /* ONE FLAT LOOP OVER THE WHOLE BUDGET, AND THE OUTER RING GETS MOST OF IT.
     *
     * Every ring used to be capped at the same number of steps, which sounds neutral and is not: a
     * ring's taps are spread over a circumference proportional to its radius, so an equal share puts
     * the WIDEST arc gaps on the outermost ring — the only one that decides where the dilated
     * boundary lands. At radius 12 that was 4.71 px of arc between the taps that draw the edge,
     * against 1.18 px on ring 1, and the boundary followed the tap count: measured against a Godot
     * 4.5.1 golden, 0.3099 px of wobble at exactly 16 cycles per revolution where the engine has
     * 0.0164.
     *
     * So the budget is split in proportion to ring RADIUS, i.e. to circumference: ring k of rings
     * may spend (MAX_TAPS * k + denom/2) / denom taps, which at four rings is 6 / 13 / 19 / 26 and
     * sums to exactly MAX_TAPS. It sums to exactly MAX_TAPS at one, two and three rings as well
     * (64; 21 + 43; 11 + 21 + 32), so the flat bound is never the thing that truncates a ring — it
     * is a hedge against a driver that insists on unrolling, not a second policy. At radius 12 the
     * outer arc is then 2.90 px rather than 4.71.
     *
     * The lower clamp of 6 steps is what keeps a SMALL radius honest, and it is the reason the cap
     * enters as max (cap, 6) rather than as cap: ring 1's share at four rings is exactly 6, and a
     * hexagon is the coarsest ring that still surrounds its centre.
     *
     * ONE TAP PER ITERATION, so HB_GPU_SPREAD_MAX_TAPS is simultaneously the loop bound and the
     * fragment's worst-case cost — the two used to be 4 x 16 and 65 and had to be reasoned about
     * separately. Dynamic bounds and breaks are legal ESSL 3.00; the GLSL ES 1.00 Appendix A
     * restriction that forced the nested constant shape does not apply to version 300 es. */
    int ring = 0;
    int step = 0;
    int steps = 0;
    float ringEm = 0.0;
    float phase = 0.0;
    for (int i = 0; i < HB_GPU_SPREAD_MAX_TAPS; i++)
    {
      /* THE INTERIOR EARLY-OUT: a fragment already covered by its own centre tap is trivially
       * within r of ink, and interior fragments are most of a glyph. */
      if (cov >= HB_GPU_SPREAD_SOLID) break;
      if (step >= steps)
      {
        ring += 1;
        /* The other exit: the rings this radius actually asked for are done. */
        if (ring > rings) break;
        float t = float (ring) / float (rings);
        ringEm = v_spreadEm * t;
        int cap = (HB_GPU_SPREAD_MAX_TAPS * ring + denom / 2) / denom;
        steps = clamp (int (ceil (HB_GPU_SPREAD_TAU * radiusPx * t)), 6, max (cap, 6));
        /* THE GOLDEN ANGLE, so no two rings put their taps on the same radii — which would leave
         * wedge-shaped gaps between the rings rather than a covering. A fixed fraction of a step
         * would do that for one pair of ring counts and line up for another; 137.5 degrees per ring
         * is the rotation with no small-integer commensurability with any of them. */
        phase = 2.39996 * float (ring);
        step = 0;
      }
      float angle = phase + HB_GPU_SPREAD_TAU * float (step) / float (steps);
      vec2 at = v_texcoord + ringEm * vec2 (cos (angle), sin (angle));
      /* MAX, NOT A SUM, AND THE MAX IS WHY THIS IS IN THE SHADER. The alternative a caller could
       * build without it — draw the run N times at N offsets — composites N times, so a
       * translucent outline is N overlapping translucent copies and reads far darker than one
       * stroke. One fragment, one coverage, one blend.
       *
       * SHARPENED BEFORE THE MAX, not after: the max is over a set of INSIDE tests, and the union
       * of disks it approximates is a binary shape. Sharpening the max instead would sharpen a
       * number that had already been flattened to the peak coverage nearby, which is the value
       * that is wrong. See HB_GPU_SPREAD_INSIDE_LOW. */
      cov = max (cov, smoothstep (HB_GPU_SPREAD_INSIDE_LOW,
                                  HB_GPU_SPREAD_INSIDE_HIGH,
                                  hb_gpu_spread_tap (at, pixelsPerEm, ppem, v_glyphLoc)));
      step += 1;
    }
  }

  /* CONTRAST, ON THE FINAL COVERAGE — and STEM DARKENING ONLY WHEN THE DILATION DID NOT RUN.
   *
   * An outline's rim is NOT a coverage ramp with the same problem the fill's has, which is what
   * this block assumed when it shipped. Stem darkening exists because a sub-pixel STEM lands at
   * mid-grey under linear coverage where a browser puts it near the ink colour; the fix is an
   * exponent that pushes the middle of the ramp toward the foreground. A dilated fragment's
   * coverage is not that number. The taps above are an INSIDE test (HB_GPU_SPREAD_INSIDE_LOW
   * sharpens each one before the max), so the dilated boundary is already very nearly binary — and
   * the engine this mirrors applies no curve at all to its outline: Godot strokes the glyph and
   * hands the result to FreeType's plain grayscale raster. Measured against that golden, the curve
   * took a 14 px outline's rim from 0.662 px to 1.965 px of equivalent ramp, three times the width,
   * where Godot's own is 0.851. That is a halo — fattening for dark ink, thinning for light — and
   * it is the one thing in this shader that made an outline softer than the engine's.
   *
   * THE GATE IS THE DILATION BRANCH'S OWN CONDITION, CHARACTER FOR CHARACTER, so the two cannot
   * disagree about which fragments dilated. A bare u_spreadPx > 0.0 would also strip the
   * correction from a DEGENERATE run — one whose a_emPerPos is zero or NaN, which fails
   * v_spreadEm > 0.0 and takes the single-tap path. Such a fragment is a fill in every way that
   * reaches the framebuffer, and it should keep a fill's darkening rather than lose it to a uniform
   * that ended up doing nothing.
   *
   * GAMMA IS NOT GATED. It is an explicit consumer knob, defaults to 1 (skipped entirely below),
   * and is polarity- and size-blind by construction; a consumer that deliberately sets one is
   * asking for a transfer curve on the text, and putting the fill and the outline of the same run
   * on different curves would be a stranger thing than either choice.
   *
   * THE PPEM IS FETCHED IN UNIFORM CONTROL FLOW AND THE COVERAGE TEST IS NOT ALLOWED TO CONTAIN IT.
   * hb_gpu_ppem calls fwidth, which GLSL ES 3.00 leaves undefined once the 2x2 derivative quad can
   * disagree about whether to run it — and "0.0 < cov < 1.0" is precisely a per-fragment condition.
   * u_stemDarken and u_spreadPx are real uniforms and v_spreadEm is flat, which is the same
   * argument the dilation branch above makes for its own hb_gpu_ppem call; darken is that branch's
   * predicate negated, so a quad coherent enough to run the dilation is exactly as coherent about
   * skipping the darkening. Upstream's demo puts its fwidth inside the coverage test; that is a
   * desktop-GLSL liberty this cannot take.
   */
  bool fillPass = !(u_spreadPx > 0.0 && v_spreadEm > 0.0);
  bool darken = u_stemDarken > 0.0 && fillPass;

  float darkenPpem = 0.0;
  if (darken)
    darkenPpem = hb_gpu_ppem (v_texcoord, v_glyphLoc);

  /* EDGE ONLY, which is upstream's guard and is not merely an optimisation here. Both corrections
   * fix 0 and 1, so the interior and the background cannot move whatever the exponents are — but
   * pow (0.0, y) is UNDEFINED for y <= 0 in GLSL ES 3.00, and u_gamma is a number a consumer chose.
   * Skipping cov == 0.0 is what makes a hostile gamma a picture that is wrong rather than a NaN
   * alpha over the whole quad. No derivative is taken inside, so a non-uniform branch is legal. */
  if (cov > 0.0 && cov < 1.0)
  {
    float adj = cov;
    if (darken)
    {
      /* u_color is STRAIGHT, so this IS upstream's dot (c.rgb, 1/3) / c.a with the divide already
       * done. A flat 1/3 rather than a Rec.709 luma on purpose: hb_gpu_stem_darken's exponent
       * curve is calibrated against HarfBuzz's own definition of "brightness", and weighting the
       * channels differently would silently retune somebody else's constants. */
      adj = hb_gpu_stem_darken (adj, dot (u_color.rgb, vec3 (1.0 / 3.0)), darkenPpem);
    }
    if (u_gamma != 1.0)
      adj = pow (adj, u_gamma);
    cov = adj;
  }

  float a = u_color.a * cov;
  fragColor = vec4 (u_color.rgb * a, a);
}
`;

/**
 * A face registered with the renderer: the namespace every one of its glyph keys carries.
 *
 * THE ATLAS KEY IS `(face, glyph)` AND NOT `glyph`, AND THAT IS THE WHOLE POINT OF THIS TYPE.
 * Glyph 42 of Noto Sans SC and glyph 42 of Roboto are unrelated outlines; an atlas keyed on the
 * glyph id alone hands the second one the first one's texels and renders fluent, crisp, WRONG
 * text — the one failure mode nothing downstream measures. That namespacing used to live in the
 * perf-harness's key strings, one layer above a renderer that could not tell two faces apart.
 *
 * Registering also fixes the `upem`, so {@link HbGpuRenderer.upload} no longer takes one and a
 * glyph cannot be uploaded under one face's scale and drawn at another's.
 */
export interface HbGpuFace {
  /** Dense index assigned at registration. Namespaces every key of this face. */
  readonly id: number;
  /** Whatever the embedder called it. Appears in failure messages, nowhere else. */
  readonly label: string;
  /** Units per em, taken from the registered font and never from a caller's argument. */
  readonly upem: number;
}

/** Where one encoded glyph landed, and the box to draw it in. */
export interface GlyphSlot {
  /**
   * Numeric identity of the resident glyph. Optional so structural slots made by older callers
   * remain accepted by the cold compatibility path in {@link HbGpuRenderer.push}.
   */
  faceId?: number;
  glyphId?: number;
  /**
   * The allocator key — `<face id>/<glyph id>`, so a draw can find its allocation without a
   * reverse lookup. Internal shape: read it for debugging, never construct one.
   */
  key: string;
  /**
   * Which ALLOCATION this slot describes, stamped by the allocator and never reused.
   *
   * THE ANSWER TO THE WORST BUG THIS PACKAGE HAD. The ring evicts, so a slot handed out an hour
   * ago can name texels that some other glyph now owns. `push` used to draw it anyway, at the
   * right size, in the right place, perfectly antialiased — a different glyph's outline, invisible
   * to every check downstream. `push` now compares this against the live allocation and skips on a
   * mismatch (see {@link AtlasStats.staleSkips}); a plain key comparison could not, because the
   * key of a re-uploaded glyph is the same key.
   */
  generation: number;
  /** Atlas texel index of the blob's first texel — the shader's `glyphLoc`. */
  loc: number;
  /** Units per em of the face these coordinates are in. */
  upem: number;
  /** Em-space ink box, y-UP, as `hb_gpu_draw_encode` reported it. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Texels this blob occupies. */
  texels: number;
}

export interface AtlasStats {
  /**
   * What the live allocations actually occupy: texels x 8.
   *
   * The honest "how much glyph data is resident" number, and the one to compare against a baked
   * atlas's occupied bytes.
   */
  liveBytes: number;
  /**
   * `width x height x 8` — the whole texture.
   *
   * THE NUMBER THAT SITS NEXT TO `hb-atlas`'s 1.45 MiB. A driver allocates the texture, not the
   * used part of it, so this is what is actually held whatever the occupancy says. Reported
   * separately from `liveBytes` because quoting only the smaller one is how a renderer appears to
   * cost less than it does.
   */
  reservationBytes: number;
  /** Live allocations, and the texels they hold. */
  entries: number;
  liveTexels: number;
  capacityTexels: number;
  /** Allocations overwritten by a wrapped cursor since creation. */
  evictions: number;
  /** Faces registered. Keys are namespaced by these — see {@link HbGpuFace}. */
  faces: number;
  /**
   * Glyphs `push` declined to draw because their slot no longer matches a live allocation.
   *
   * NON-ZERO IS A REAL FINDING, not noise: it means the embedder is holding slots across an
   * eviction (its atlas is too small for its working set, or it caches slots it should re-`upload`)
   * and the frame is short of glyphs. Counted rather than thrown because `push` is the hot loop.
   */
  staleSkips: number;
}

export interface BlobStats {
  /** Distinct glyphs uploaded. */
  glyphs: number;
  /** Sum of every uploaded blob's length, in bytes. */
  totalBytes: number;
  /**
   * THE PREDICTION UNDER TEST. `docs/text-rendering.md` records "~5.4 KB per Han glyph against
   * ~1.4 KB for a 38x38 R8 atlas cell". This is the left-hand side of it, self-counted.
   */
  bytesPerGlyph: number;
}

/**
 * The contrast correction the fragment stage applies to the coverage it computed.
 *
 * THE TWO FIELDS REACH DIFFERENT PASSES, which is the one thing to read before setting either:
 * `gamma` is applied to every draw, `stemDarkening` only to an undilated one. The reason is under
 * {@link HbGpuContrast.stemDarkening}.
 *
 * WHY IT EXISTS, AND WHY THE DEFAULT IS ON. Raw analytic coverage is the AREA of the pixel the
 * outline covers, and compositing it linearly is not what a browser does: measured on one fixed
 * crop of the word "Breakthrough" at 1600x900 / DPR 1.25, the hb-gpu path and the DOM path agree on
 * peak darkness (51 vs 50), on mean luminance (120.5 vs 121.0) and on total ink (2736 vs 2744) —
 * and DOM still puts **66% more pixels** in the deep-dark end (1285 below luma 80 against 775).
 * That gap is entirely in the middle of the ramp: a sub-pixel stem lands mid-grey here and near the
 * ink colour there, which reads as washed out at exactly the sizes a UI uses. Every shipping
 * consumer wants the correction; the exception is a harness.
 *
 * BOTH FIELDS ARE REQUIRED rather than optional, which is deliberate. A half-specified
 * `{ gamma: 1.2 }` would silently inherit a stem-darkening default the author never considered, and
 * this is a knob whose whole purpose is that somebody thought about it. Use
 * {@link HB_GPU_CONTRAST_DEFAULT} / {@link HB_GPU_CONTRAST_NONE} rather than writing the pair out.
 */
export interface HbGpuContrast {
  /**
   * Exponent applied to the coverage. `1` is the identity and is the default.
   *
   * BELOW 1 IS DARKER (a coverage of 0.5 moves toward 1), above 1 lighter. It is polarity-BLIND —
   * unlike `stemDarkening`, which reads the foreground — so a value that helps dark-on-light text
   * hurts light-on-dark by the same amount. HarfBuzz's own demo flips it by theme
   * (`demo-view.cc`: `dark_mode ? 1/2.2 : 2.2`) for that reason, and a renderer here draws both
   * polarities in one frame and cannot. Hence 1: the size- and polarity-aware half of the
   * correction is `stemDarkening`, and this is the manual override next to it.
   *
   * Non-finite or non-positive values are refused and reported (`"degenerate-contrast"`), because
   * `pow` with such an exponent is a NaN alpha over the whole quad rather than a wrong picture.
   */
  gamma: number;
  /**
   * Run `hb_gpu_stem_darken` on the coverage OF A FILL. Default `true`.
   *
   * IT IS THE SIZE-AWARE AND POLARITY-AWARE HALF. The library's exponent is
   * `mix (pow (2, brightness - 0.5), 1, smoothstep (8, 48, ppem))`, so it fattens dark text
   * (brightness 0 -> exponent 0.707), thins light text (brightness 1 -> 1.414) and RAMPS ITSELF OFF
   * by ppem 48, where a stem is wide enough that no pixel of it is partially covered anyway. The
   * brightness comes from the per-instance colour and the ppem from `hb_gpu_ppem`, so it costs no
   * per-frame decision.
   *
   * IT DOES NOT APPLY TO A DILATED RUN, whatever this flag says: a draw with a non-zero
   * {@link HbGpuRenderer.setSpread} emits raw coverage. The correction exists because a sub-pixel
   * STEM sits at mid-grey under linear coverage where a browser puts it near the ink colour, and a
   * dilated fragment's coverage is not that number — the taps are an inside test, so the boundary
   * is nearly binary before any curve touches it. More decisively, Godot's outline is a plain
   * FreeType raster with no curve of its own, so an exponent on a dilated rim reads as a HALO
   * against it: fattening for dark ink, thinning for light. Measured against the committed Godot
   * golden, it took a 14 px outline's rim from 0.662 to 1.965 px of equivalent ramp where Godot's
   * is 0.851 (`packages/hb-gpu/test/goldens/godot-outline-metrics.json`, `docs/text-rendering.md`).
   *
   * THE EDGE THAT LEAVES: a consumer drawing a spread run as the ONLY ink — an outline with no fill
   * composited over it — now gets uncorrected coverage for that text and no way to ask for
   * otherwise. That is the intended picture for a stroke and the wrong one for a glyph body, so a
   * caller in that position should draw the fill it is standing in for. `gamma` is NOT gated and
   * remains available for a deliberate transfer curve over both passes.
   */
  stemDarkening: boolean;
}

/** Stem darkening on, gamma neutral. What a renderer built without a `contrast` option gets. */
export const HB_GPU_CONTRAST_DEFAULT: HbGpuContrast = Object.freeze({
  gamma: 1,
  stemDarkening: true,
});

/**
 * No contrast curve at all: the fragment writes the coverage it computed.
 *
 * FOR MEASUREMENT ARMS, and they should say so where they pass it. A fidelity probe that grades an
 * arm against an 8x area-coverage reference is grading the RASTERIZER, and an arm carrying a
 * contrast curve scores the curve instead — `docs/text-rendering.md`'s distortion figures (0.196
 * Han at ppem 14, 0.017 at ppem 49) only mean what they say against raw coverage.
 */
export const HB_GPU_CONTRAST_NONE: HbGpuContrast = Object.freeze({
  gamma: 1,
  stemDarkening: false,
});

export interface HbGpuRendererOptions {
  /**
   * The context to draw in. NOT created here and never destroyed here.
   *
   * It must have been created with `premultipliedAlpha: true` — see this file's header. Nothing
   * can check that from inside (`getContextAttributes` reports what was ASKED for, and the failure
   * is a picture that is merely darker), so it is stated rather than validated.
   */
  gl: WebGL2RenderingContext;
  /**
   * The extent of OBJECT SPACE — the units {@link HbGpuRenderer.push} takes, y measured DOWN.
   *
   * This pair builds the design->clip projection and nothing else. On a standalone canvas it is
   * the device-pixel size and equals the framebuffer pair below; on a DPR-scaled stage it is the
   * scene's own coordinate extent (`packages/canvas/src/present.ts`'s `designWidth`), and the two
   * pairs differ by the ratio.
   */
  designWidth: number;
  designHeight: number;
  /**
   * The ACHIEVED drawing-buffer size, in DEVICE pixels. Defaults to the design pair.
   *
   * NOT THE SAME NUMBER AS THE DESIGN PAIR, and the default is only correct for a stage whose
   * device-pixel ratio is 1. This pair is `u_viewport`, which is what `hb_gpu_dilate` measures half
   * a SCREEN pixel against — see this file's header for what feeding it design units does.
   *
   * PASS `gl.drawingBufferWidth`, not the size you asked the canvas for. Setting `canvas.width`
   * only REQUESTS an allocation and an implementation may hand back less, and a viewport that is
   * wrong by a few pixels is a dilation that is wrong by a fraction of one — a rim of clipped
   * antialiasing around every glyph rather than anything that looks like a size error.
   */
  framebufferWidth?: number;
  framebufferHeight?: number;
  /**
   * Atlas capacity in TEXELS. Rounded up to a whole number of {@link HbGpuRenderer.atlasWidth}-wide
   * rows.
   *
   * Default 256 rows = 1 Mi texels = 8 MiB, which holds ~1500 Han outlines at the ~5.4 KB the
   * prediction expects. Sized in texels rather than bytes because that is the unit the shader
   * indexes in and the unit the allocator wraps in.
   */
  atlasTexels?: number;
  /**
   * Give each DILATION TAP the same five-sample average `_hb_gpu_slug` gives a fill below ppem 16.
   *
   * **Default `false`, and that default is a measured trade rather than an oversight.**
   *
   * WHAT IT COSTS TO LEAVE ON. `hb_gpu_spread_tap` mirrors `_hb_gpu_slug`, so below ppem 16 one ring
   * tap becomes FIVE `_hb_gpu_slug_single` evaluations — and a dilated fragment takes up to 65 taps.
   * Measured on S9's `text-render` scenario (RTX 2060, 1280x800 at DPR 1, 40 outlined runs at 14 px,
   * `outlinePx` 6): **12.27 Hz with it on, 70.47 Hz with it off**, 5.74x, and 8.05x at `outlinePx`
   * 10. The font-size ladder isolates it — the same 3 px radius and the same tap set (47 steps when
   * that was measured, 50 under the budget split that replaced the per-ring clamp) reads 17.44 Hz at
   * `fontSize` 18 and 74.76 at 20, because 20 is where the ppem the shader computes crosses 16 and
   * the branch stops firing. It is one branch, not the tap count: capping the rings and steps at
   * 3x12 bought only 1.5x, and 2x8 bought 2.3x by punching holes through thin features.
   *
   * WHY IT IS DEFENSIBLE TO LEAVE OFF, which is a claim about pixels and is pinned by
   * `test/glyphPixelXvfb.test.ts`'s low-ppem pair. The outline is a solid silhouette that a fill is
   * then drawn on top of, so the only thing the taps decide is its OUTER rim; a max over ~47 taps is
   * itself a smoothing operator; and the rim of a thick outline is the least legible place in a
   * glyph. Measured at 14 px, rotated 10 degrees, spread 3, both programs on one GPU in one frame:
   * the two differ on **267 pixels, RMS 33.4 levels of 255, worst 85** — and the one WITHOUT the
   * MSAA is the one closer to an 8x dilated reference (rim RMS 77.9 against 85.1, ink 36102 against
   * 30192 where the ideal grown shape is 58081). The extra smoothing was deepening a shortfall, not
   * repairing one: `max` over coverage cannot exceed the peak coverage near a fragment, and at
   * ppem 14 a Han glyph's strokes never reach 1, so the outline is a translucent mottle at ~60% of
   * the ideal either way. That is the honest shape of this trade — not "5.74x for a slightly
   * coarser rim" but "5.74x for a differently-wrong outline at a size where the outline is already
   * wrong". Above ppem 16 it is free in both directions: the blend weight is
   * `smoothstep (16, 8, ppem)`, which is exactly 0 there, so NO pixel of text at or above ppem 16
   * can change — measured, by widening the gate to `ppem < 200` and reading a byte-identical frame.
   *
   * WHAT IT DOES NOT TOUCH, structurally. The FILL's coverage is `hb_gpu_draw` -> `_hb_gpu_slug`
   * inside the vendored library, guarded by the library's own `HB_GPU_NO_MSAA`. This flag defines
   * `HB_GPU_SPREAD_TAP_NO_MSAA`, a different name that only this file's function reads, so no
   * setting of it can reach the fill. `spread 0` never calls the tap at all.
   *
   * Set `true` for very small outlined text where the rim matters more than the frame budget.
   */
  spreadTapMsaa?: boolean;
  /**
   * The contrast curve applied to the FINAL coverage. Defaults to {@link HB_GPU_CONTRAST_DEFAULT},
   * which has stem darkening ON.
   *
   * PASS {@link HB_GPU_CONTRAST_NONE} IF YOU ARE MEASURING FIDELITY, and only then. See
   * {@link HbGpuContrast} for the whole argument.
   */
  contrast?: HbGpuContrast;
  /**
   * Store model/colour/spread beside every glyph so adjacent runs may share one draw. Off by
   * default: the established renderer keeps its 40-byte record and uniform state unchanged.
   */
  perInstanceRunState?: boolean;
  /**
   * Where a refusal goes.
   *
   * `createHbGpuRenderer` returns `null` rather than throwing, following `createCanvasStage`, so a
   * consumer can fall back to a DOM text path. But a renderer that declined silently reports as a
   * cheap one — in a perf arm literally so — so every `null` and every declined upload also comes
   * through here with a reason a human can act on.
   */
  onError?(failure: HbGpuFailure): void;
}

export interface HbGpuRenderer {
  /** The borrowed context. Owned by the embedder; `dispose` does not touch it. */
  readonly gl: WebGL2RenderingContext;
  /**
   * The atlas width this instance actually built — NOT necessarily {@link ATLAS_WIDTH}.
   *
   * WebGL2 guarantees only 2048, so a device can force a narrower texture. The shader gets this as
   * `hb_gpu_atlas_width` and the row-wrap arithmetic uses it, so a non-4096 width is correct and
   * merely costs more `texSubImage2D` calls per blob.
   */
  readonly atlasWidth: number;
  /**
   * True between {@link notifyContextLost} and a successful {@link rebuild}.
   *
   * While it is true every method here is a no-op that touches no GL: `upload` returns `null`,
   * `push` skips, `end` reports a zero frame. Nothing polls `gl.isContextLost()` — that is a query
   * in the hot path for an event the embedder already receives — so a consumer that does not wire
   * `webglcontextlost` through to {@link notifyContextLost} will draw into dead objects forever,
   * which is permanently blank text with no signal. That wiring is not optional.
   */
  readonly contextLost: boolean;
  /**
   * Register a face, taking its `upem`, and get the namespace its glyph keys carry.
   *
   * THE FONT IS RETAINED, and that is the memory decision this package makes. A context loss
   * destroys the atlas texture, so {@link rebuild} has to be able to put the same texels back at
   * the same offsets — and the two ways to do that are to keep a copy of every uploaded blob or to
   * keep the encoder that produced them. This keeps the ENCODER: the embedder already holds the
   * `HbGpuFont` (it cannot encode without one), so the retained reference costs zero additional
   * bytes, where retaining blobs would hold a second resident copy of the glyph data forever —
   * 1.3 MB on S9's 300-glyph Han pool — to make a once-in-a-session event faster. The cost is paid
   * on restore instead: `rebuild` re-runs `hb_gpu_draw_encode` for every resident glyph (~180 ms
   * for that same pool).
   *
   * Consequence, stated because it is a lifetime rule and not a preference: the font must outlive
   * the renderer, or a rebuild silently drops that face's glyphs.
   *
   * `null` when the font's `upem` is not usable — see {@link HbGpuFailureReason} `"degenerate-upem"`.
   */
  registerFace(font: HbGpuFont, label?: string): HbGpuFace | null;
  /**
   * Upload one encoded glyph of `face`, or return the slot it already has.
   *
   * `null` for a glyph with no ink — a space encodes to a zero-length blob, which is a legitimate
   * result and must not become a zero-texel allocation — and also for a blob this renderer
   * declines (malformed, or larger than the whole atlas), which is reported through `onError`.
   *
   * THROWS in exactly one case; see {@link HbGpuRendererOptions.atlasTexels} and the in-use guard
   * inside `allocate`.
   */
  upload(
    face: HbGpuFace,
    glyphId: number,
    glyph: EncodedGlyph,
  ): GlyphSlot | null;
  /**
   * The live slot for a glyph that is already resident, or `null` when it is not.
   *
   * THE CHEAP HALF OF {@link HbGpuRenderer.upload}, AND THE REASON AN EMBEDDER CAN KEEP HANDLES
   * INSTEAD OF SLOTS. A retained draw list records a glyph as an id and has to turn it back into a
   * `GlyphSlot` every frame; the only way to do that used to be `upload`, which needs an
   * {@link EncodedGlyph} — and encoding a Han working set costs ~180 ms, so a per-frame encode is
   * not a path anybody can take. This is a map lookup and a touch.
   *
   * `null` means "never uploaded, or evicted", and those are the same answer for a caller: encode
   * and `upload` again. It is NOT an error and nothing is reported — a ring allocator evicting is
   * the mechanism working.
   *
   * The returned slot is built by the same expression `upload` uses, so a resolved slot and a
   * freshly uploaded one cannot differ; in particular it carries the CURRENT
   * {@link GlyphSlot.generation}, which is what makes it safe to `push`.
   */
  resolve(face: HbGpuFace, glyphId: number): GlyphSlot | null;
  /** Start a frame. */
  begin(): void;
  /**
   * Queue one glyph, its em ORIGIN (the pen position, on the baseline) at object-space `(x, y)`,
   * at `pixelsPerEm` object units per em.
   *
   * Object space is device pixels and y measures DOWN, matching every other renderer in the repo.
   * Rotation is not here on purpose: it belongs in {@link setModel}, so that one matrix rotates the
   * quad AND is seen by `hb_gpu_dilate`, which computes its half-pixel dilation in SCREEN space
   * through that same matrix. A quad rotated on the CPU behind the shader's back would be dilated
   * along the wrong axes.
   *
   * A slot whose allocation has been evicted is SKIPPED and counted — see {@link GlyphSlot.generation}.
   */
  push(slot: GlyphSlot, x: number, y: number, pixelsPerEm: number): void;
  /** Object-space 2x3 (`[xx, xy, yx, yy, tx, ty]`), applied before the projection. */
  setModel(model: ArrayLike<number>): void;
  /** STRAIGHT rgba in 0..1. The fragment premultiplies it, once. */
  setColor(r: number, g: number, b: number, a: number): void;
  /**
   * Grow every glyph of the next frame outward by `px` OBJECT units. `0` (the default) is the
   * plain fill.
   *
   * WHAT AN OUTLINED LABEL IS: this run in the outline colour at `spread`, then the SAME run in the
   * fill colour at spread 0, in that order. A centred `ctx.strokeText` of width `W` reaches `W / 2`
   * outward, so a caller matching one passes `W / 2`; the arithmetic is the caller's, because only
   * the caller knows whether its stroke is centred, inner or outer.
   *
   * A DILATION FILLS THE INTERIOR AND A CENTRED STROKE DOES NOT, AND THAT DIFFERENCE IS REAL. This
   * paints the whole glyph plus a band of `spread` around it, where a stroke paints only a band
   * straddling the contour. Under an OPAQUE fill the two are pixel-identical, because the fill
   * covers every pixel they disagree about. Under a TRANSLUCENT fill they are not: the outline
   * colour shows through the glyph's middle here and would not through a stroke. That is the honest
   * limit of a coverage-max dilation and there is no distance field to do better with — see
   * {@link FRAGMENT_MAIN}.
   *
   * OBJECT UNITS, BEFORE {@link HbGpuRenderer.setModel}, matching every other length `push` takes.
   * A model that scales scales the outline with the text, which is what a caller rotating a label
   * wants.
   *
   * IT PERSISTS, exactly like {@link HbGpuRenderer.setModel} and {@link HbGpuRenderer.setColor} —
   * `begin` does not reset it. The failure that buys is worth stating: a caller that sets a spread
   * for one run and does not clear it draws every LATER run fat, which looks like a font-weight bug
   * rather than a missing call. Per-run callers should set it per run, which is what
   * `packages/canvas`'s glyph pass does.
   *
   * A NON-ZERO SPREAD ALSO TURNS STEM DARKENING OFF for that run, whatever
   * {@link HbGpuContrast.stemDarkening} says — Godot's outline carries no contrast curve, and one
   * on a dilated rim reads as a halo. The reason is under that field; the pair "outline then fill"
   * above is unaffected, because the fill run is the one that keeps the correction.
   *
   * COST. Bounded, but not free: a fragment that is neither solid ink nor near any evaluates up to
   * 65 coverage taps (and five times that below ppem 16), and the quad it does so over grows by
   * `spread` on every side. Beyond roughly 4 device pixels of radius the tap ceiling is reached —
   * {@link HB_GPU_SPREAD_MAX_TAPS} — and the dilated rim starts to scallop: measured against a Godot
   * 4.5.1 golden at radius 12, the 50% contour wobbles 0.17 px where the engine's wobbles 0.11. The
   * cost does not grow past that point; only the scallop does. Negative and non-finite values are
   * clamped to 0 rather than reported: this is a per-run hot-path setter with no error channel.
   */
  setSpread(px: number): void;
  /**
   * Re-state both sizes after the embedder resized its stage or its drawing buffer.
   *
   * Does NOT call `gl.viewport` — this renderer never touches it. It updates the design->clip
   * projection (from the DESIGN pair) and the `u_viewport` the dilation is measured in (from the
   * FRAMEBUFFER pair), both of which must describe the viewport the embedder will have set by the
   * time `end` runs. The framebuffer pair defaults to the design pair, which is right only at a
   * device-pixel ratio of 1 — see {@link HbGpuRendererOptions.framebufferWidth}.
   */
  setViewport(
    designWidth: number,
    designHeight: number,
    framebufferWidth?: number,
    framebufferHeight?: number,
  ): void;
  /**
   * Submit. Returns what the frame cost.
   *
   * WHAT THIS DOES NOT DO, because the context is borrowed: it does not set `gl.viewport` and it
   * does not clear. Both were here while this file owned a stage, and both are actively wrong in a
   * shared context — a clear inside a glyph pass erases everything the embedder's executor already
   * drew, and a viewport call silently overrides a scissored or letterboxed pass.
   *
   * WHAT IT LEAVES DIRTY, exhaustively, so an embedder's restore code can be written against it.
   * On a frame that drew anything (`instances > 0`):
   *
   *   - `BLEND` is ENABLED, `blendEquation` is `FUNC_ADD`, `blendFunc` is
   *     `(ONE, ONE_MINUS_SRC_ALPHA)` — premultiplied MIX. Note `blendFunc`/`blendEquation`, not
   *     the `*Separate` forms, so both the RGB and the alpha halves are set.
   *   - The current program is this renderer's.
   *   - `ARRAY_BUFFER` is bound to the instance buffer.
   *   - `ACTIVE_TEXTURE` is `TEXTURE0` and `TEXTURE_BINDING_2D` on unit 0 is the atlas.
   *   - `VERTEX_ARRAY_BINDING` is null (unbound, not restored to whatever was bound before —
   *     WebGL2 has no cheap way to read it back).
   *   - Uniforms of this renderer's program only — `u_viewProjection`, `u_viewport`, `u_gamma`,
   *     `u_stemDarken`, `hb_gpu_atlas` and `hb_gpu_atlas_width`. Per-run model, colour and spread
   *     are captured into each instance record; their setters still persist until replaced and
   *     `begin` deliberately does not reset them (see {@link HbGpuRenderer.setSpread}).
   *
   * Untouched: viewport, scissor box and `SCISSOR_TEST`, clear colour, depth/stencil state,
   * framebuffer bindings, the three unpack flags — `UNPACK_ALIGNMENT`, `UNPACK_FLIP_Y_WEBGL` and
   * `UNPACK_PREMULTIPLY_ALPHA_WEBGL`, all saved and restored around every upload — and every
   * texture unit but 0.
   *
   * On an empty frame it returns immediately and leaves ALL of the above untouched too, which is
   * why an embedder must restore unconditionally rather than only when `instances > 0`.
   */
  end(): { instances: number; drawCalls: number };
  /**
   * The context is gone: drop every GL handle WITHOUT calling into GL to free it.
   *
   * Call this from `webglcontextlost` (`packages/canvas/src/present.ts` offers exactly that hook,
   * and `preventDefault` on that event is what makes a restore possible at all). The allocation
   * table survives — offsets, faces and glyph ids — because {@link rebuild} puts the same texels
   * back at the same offsets, which is what keeps every {@link GlyphSlot} the embedder is holding
   * valid across the loss.
   */
  notifyContextLost(): void;
  /**
   * The context is back: recreate the program, the buffers, the VAO and the texture, then re-encode
   * and re-upload every resident glyph at the offset it already had.
   *
   * SAME OFFSETS, DELIBERATELY. Repacking would be simpler and would invalidate every slot the
   * embedder holds — which the generation guard would then turn into a silently empty frame rather
   * than garbage, but empty is still wrong. Re-materialising the atlas byte for byte means a
   * restore needs no cooperation from the caller beyond this one call.
   *
   * Returns `false` (and reports) if the GL objects could not be rebuilt. A face whose font has
   * been destroyed, or a glyph that no longer encodes to the same length, loses its allocation:
   * those slots then fail the generation check and are skipped rather than drawn wrong.
   */
  rebuild(): boolean;
  readonly atlas: AtlasStats;
  readonly blobs: BlobStats;
  /** Delete this renderer's GL objects. Does NOT touch the context or the canvas. */
  dispose(): void;
}

interface Allocation {
  key: string;
  /** Which face and glyph this is, so `rebuild` can encode it again. */
  faceId: number;
  glyphId: number;
  offset: number;
  texels: number;
  /** Stamped once, never reused. The other half of {@link GlyphSlot.generation}. */
  generation: number;
  /** This allocation still owns its atlas range. */
  live: boolean;
  /** Renderer identity; prevents structurally copied slots crossing renderers. */
  rid: number;
  /** The immutable owned slot returned on hot paths. */
  slot: GlyphSlot;
  /** Monotonic touch counter — the LRU order. */
  usedAt: number;
  /** Frame index this was last drawn in; the in-use guard reads it. */
  usedFrame: number;
  /**
   * The face's units per em and the glyph's em ink box, KEPT HERE rather than re-read.
   *
   * These six numbers used to be taken off the {@link EncodedGlyph} at every call, which meant the
   * only way to obtain a slot was to hold — or re-run — the encoder. {@link HbGpuRenderer.resolve}
   * exists precisely so a caller does not have to, and it can only exist if the allocation knows
   * its own box. They are six floats per resident glyph against a blob that averages 5.4 KB.
   */
  upem: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface RegisteredFace extends HbGpuFace {
  font: HbGpuFont;
}

/** A build step's refusal: the machine-readable half and the sentence for a human. */
interface BuildFailure {
  reason: HbGpuFailureReason;
  message: string;
}

/** A compiled shader, or the reason there is not one. Never a throw — see `createHbGpuRenderer`. */
function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): { shader: WebGLShader } | BuildFailure {
  const stage = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
  const shader = gl.createShader(type);
  // `gl-object`, not `shader-compile`: nothing was compiled. `createShader` returning null means
  // the context is gone or out of resources, which is a different thing for a caller to react to
  // than GLSL that will not build.
  if (!shader) {
    return {
      reason: "gl-object",
      message: `gl.createShader(${stage}) returned null — the context is lost or out of resources`,
    };
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || "(no log)";
    gl.deleteShader(shader);
    return {
      reason: "shader-compile",
      message: `${stage} shader failed to compile — ${log}`,
    };
  }
  return { shader };
}

/**
 * A WebGL2 renderer for hb-gpu blobs, in a context somebody else owns.
 *
 * `null`, NOT A THROW, for every construction failure — the idiom `createCanvasStage` already sets
 * in this repo, and the difference between a measurement arm and a shipped renderer. A consumer
 * that cannot have this one falls back to its DOM text path; a consumer that WANTS to be loud
 * passes `onError` and is told the reason, because a silently skipped renderer reports as a cheap
 * one.
 *
 * DESIGN SPACE IS DEVICE PIXELS, and not by preference: `u_viewport` is the framebuffer size and
 * `hb_gpu_dilate` uses it with the projection to work out how far half a screen pixel is in object
 * units. Any scale in the projection would make the dilation and the quad disagree, and a dilation
 * that is wrong by a fraction is a rim of clipped antialiasing around every glyph.
 */
let rendererIdentity = 0;
/** Non-enumerable provenance survives a direct slot hand-off but deliberately not `{ ...slot }`. */
const SLOT_OWNER = Symbol("hb-gpu-slot-owner");

export function createHbGpuRenderer(
  module: HbGpu,
  options: HbGpuRendererOptions,
): HbGpuRenderer | null {
  const rid = ++rendererIdentity;
  const gl = options.gl;
  const report = (reason: HbGpuFailureReason, message: string): void => {
    options.onError?.({ reason, message: `hb-gpu: ${message}` });
  };
  const refuse = (reason: HbGpuFailureReason, message: string): null => {
    report(reason, message);
    return null;
  };

  if (gl.isContextLost()) {
    return refuse(
      "context-lost",
      "the context handed to createHbGpuRenderer is already lost — every object built now would be dead on arrival",
    );
  }

  // -----------------------------------------------------------------------------------------------
  // Capability probe
  // -----------------------------------------------------------------------------------------------

  // `ATLAS_WIDTH` used to be a bare 4096 with no check at all. WebGL2 guarantees only 2048, so on a
  // conforming-but-modest device `texImage2D` would fail with INVALID_VALUE and the atlas would
  // sample as zero — a page with no text on it, and no error anybody sees.
  const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
  if (maxTextureSize < MIN_ATLAS_WIDTH) {
    return refuse(
      "texture-size",
      `MAX_TEXTURE_SIZE is ${maxTextureSize}, below the ${MIN_ATLAS_WIDTH} this renderer needs (WebGL2 itself guarantees 2048) — the atlas cannot be built`,
    );
  }
  const atlasWidth = Math.min(ATLAS_WIDTH, maxTextureSize);
  if (atlasWidth !== ATLAS_WIDTH) {
    report(
      "atlas-clamped",
      `MAX_TEXTURE_SIZE is ${maxTextureSize}, so the atlas is ${atlasWidth} texels wide instead of ${ATLAS_WIDTH} — correct (the width is a uniform) but each blob now spans more rows and costs more texSubImage2D calls`,
    );
  }

  // Read once, here, because `rebuild` recompiles the fragment stage after a context loss and a
  // restored program that quietly disagreed with the lost one about its own tap set would be a
  // rendering change with no call site.
  const spreadTapMsaa = options.spreadTapMsaa ?? false;

  // THE CONTRAST CURVE, RESOLVED ONCE AND SANITISED ONCE. Read here for `spreadTapMsaa`'s reason
  // and one more: `end` states these every frame, so a NaN gamma checked at the call site instead
  // would be a NaN written 60 times a second with nothing to report against.
  const contrast = options.contrast ?? HB_GPU_CONTRAST_DEFAULT;
  const perInstanceRunState = options.perInstanceRunState === true;
  const instanceFloatsPerRecord = perInstanceRunState
    ? BATCHED_INSTANCE_FLOATS
    : LEGACY_INSTANCE_FLOATS;
  const instanceBytes = instanceFloatsPerRecord * 4;
  let contrastGamma = contrast.gamma;
  if (!Number.isFinite(contrastGamma) || contrastGamma <= 0) {
    report(
      "degenerate-contrast",
      `contrast.gamma is ${String(contrast.gamma)}, which \`pow\` cannot take as an exponent — using 1 (no gamma). Stem darkening is unaffected and is ${contrast.stemDarkening ? "on" : "off"}.`,
    );
    contrastGamma = 1;
  }
  const contrastStemDarken = contrast.stemDarkening ? 1 : 0;

  const requestedTexels = Math.max(1, options.atlasTexels ?? atlasWidth * 256);
  const requestedRows = Math.max(1, Math.ceil(requestedTexels / atlasWidth));
  const atlasHeight = Math.min(requestedRows, maxTextureSize);
  if (atlasHeight !== requestedRows) {
    report(
      "atlas-clamped",
      `${requestedTexels} texels needs ${requestedRows} rows but MAX_TEXTURE_SIZE caps the texture at ${maxTextureSize} — the atlas holds ${atlasHeight * atlasWidth} texels, and a working set larger than that will thrash the ring`,
    );
  }
  const capacityTexels = atlasHeight * atlasWidth;

  // -----------------------------------------------------------------------------------------------
  // GL objects — every one of them rebuildable, because a context loss destroys all of them at once
  // -----------------------------------------------------------------------------------------------

  let program: WebGLProgram | null = null;
  let uViewProjection: WebGLUniformLocation | null = null;
  let uMatViewProjection: WebGLUniformLocation | null = null;
  let uColor: WebGLUniformLocation | null = null;
  let uSpreadPx: WebGLUniformLocation | null = null;
  let uViewport: WebGLUniformLocation | null = null;
  let uGamma: WebGLUniformLocation | null = null;
  let uStemDarken: WebGLUniformLocation | null = null;
  let uAtlas: WebGLUniformLocation | null = null;
  let uAtlasWidth: WebGLUniformLocation | null = null;
  let aNormal = -1;
  let aPosition = -1;
  let aTexcoord = -1;
  let aEmPerPos = -1;
  let aGlyphLoc = -1;
  let aModel0 = -1;
  let aModel1 = -1;
  let aModel2 = -1;
  let aColor = -1;
  let aSpreadPx = -1;
  let atlasTexture: WebGLTexture | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let cornerBuffer: WebGLBuffer | null = null;
  let instanceBuffer: WebGLBuffer | null = null;

  // The instance staging arrays outlive a context loss: they are plain memory, and re-growing them
  // on restore would be work for nothing.
  let instanceCapacity = 256;
  let instanceData = new ArrayBuffer(instanceCapacity * instanceBytes);
  let instanceFloats = new Float32Array(instanceData);
  let instanceUints = new Uint32Array(instanceData);

  function buildProgram(): BuildFailure | null {
    const vertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      GLSL_PREAMBLE +
        module.shaderLibrary(HB_GPU_SHADER_STAGE_VERTEX) +
        (perInstanceRunState ? BATCHED_VERTEX_MAIN : VERTEX_MAIN),
    );
    if ("message" in vertex) return vertex;
    const fragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      // The selected complete source follows the selected instance layout. Both retain the shared
      // precision preamble, so their varying precisions link identically.
      GLSL_PREAMBLE +
        (spreadTapMsaa ? "" : SPREAD_TAP_NO_MSAA_DEFINE) +
        module.shaderLibrary(HB_GPU_SHADER_STAGE_FRAGMENT) +
        (perInstanceRunState ? BATCHED_FRAGMENT_MAIN : FRAGMENT_MAIN),
    );
    if ("message" in fragment) {
      gl.deleteShader(vertex.shader);
      return fragment;
    }
    const created = gl.createProgram();
    if (!created) {
      gl.deleteShader(vertex.shader);
      gl.deleteShader(fragment.shader);
      return {
        reason: "gl-object",
        message: "gl.createProgram returned null (context lost?)",
      };
    }
    gl.attachShader(created, vertex.shader);
    gl.attachShader(created, fragment.shader);
    gl.linkProgram(created);
    gl.deleteShader(vertex.shader);
    gl.deleteShader(fragment.shader);
    if (!gl.getProgramParameter(created, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(created) || "(no log)";
      gl.deleteProgram(created);
      // The classic silent one: a `highp int` in one stage and a `mediump int` in the other links
      // with an empty log on some drivers. Both stages share `GLSL_PREAMBLE` so that cannot happen
      // here, and the log is quoted anyway because the next cause will not be that.
      return {
        reason: "program-link",
        message: `program failed to link — ${log}`,
      };
    }
    program = created;

    if (perInstanceRunState) {
      uViewProjection = gl.getUniformLocation(created, "u_viewProjection");
    } else {
      uMatViewProjection = gl.getUniformLocation(created, "u_matViewProjection");
    }
    uViewport = gl.getUniformLocation(created, "u_viewport");
    if (!perInstanceRunState) {
      uColor = gl.getUniformLocation(created, "u_color");
      uSpreadPx = gl.getUniformLocation(created, "u_spreadPx");
    }
    // A contrast uniform that no live code path reads is legally optimised away. Attributes are
    // different: absence means the linked shader does not match this file's instance format.
    // A driver is entitled to drop `u_gamma` from the
    // program when the option resolved to 1, because nothing then reads it.
    uGamma = gl.getUniformLocation(created, "u_gamma");
    uStemDarken = gl.getUniformLocation(created, "u_stemDarken");
    uAtlas = gl.getUniformLocation(created, "hb_gpu_atlas");
    uAtlasWidth = gl.getUniformLocation(created, "hb_gpu_atlas_width");

    aNormal = gl.getAttribLocation(created, "a_normal");
    aPosition = gl.getAttribLocation(created, "a_position");
    aTexcoord = gl.getAttribLocation(created, "a_texcoord");
    aEmPerPos = gl.getAttribLocation(created, "a_emPerPos");
    aGlyphLoc = gl.getAttribLocation(created, "a_glyphLoc");
    if (perInstanceRunState) {
      aModel0 = gl.getAttribLocation(created, "a_model0");
      aModel1 = gl.getAttribLocation(created, "a_model1");
      aModel2 = gl.getAttribLocation(created, "a_model2");
      aColor = gl.getAttribLocation(created, "a_color");
      aSpreadPx = gl.getAttribLocation(created, "a_spreadPx");
    }
    // -1 means the linker dropped the attribute, and `enableVertexAttribArray(-1)` is an
    // INVALID_VALUE that leaves a program which draws nothing. All five are read by `main`, so this
    // can only mean the shader library that came out of the wasm is not the one this file expects.
    const missing = (
      [
        ["a_normal", aNormal],
        ["a_position", aPosition],
        ["a_texcoord", aTexcoord],
        ["a_emPerPos", aEmPerPos],
        ["a_glyphLoc", aGlyphLoc],
        ...(perInstanceRunState
          ? [["a_model0", aModel0], ["a_model1", aModel1], ["a_model2", aModel2], ["a_color", aColor], ["a_spreadPx", aSpreadPx]] as const
          : []),
      ] as const
    )
      .filter(([, location]) => location < 0)
      .map(([name]) => name);
    if (missing.length > 0) {
      return {
        reason: "program-link",
        message: `the linked program has no location for ${missing.join(", ")} — the shader library does not match this file's main()`,
      };
    }
    // These are constants of this program, not of a draw. Uniform values belong to the linked
    // program even while a borrowed context switches to another program between glyph runs.
    gl.useProgram(created);
    gl.uniform1i(uAtlas, 0);
    gl.uniform1i(uAtlasWidth, atlasWidth);
    gl.uniform1f(uGamma, contrastGamma);
    gl.uniform1f(uStemDarken, contrastStemDarken);
    return null;
  }

  function buildAtlasTexture(): BuildFailure | null {
    const created = gl.createTexture();
    if (!created) {
      return {
        reason: "gl-object",
        message: "gl.createTexture returned null (context lost?)",
      };
    }
    atlasTexture = created;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, created);
    // `RGBA16I` is not filterable at all — an integer texture with anything but NEAREST is an
    // incomplete texture and samples as zero, which renders as a page with no text on it.
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16I,
      atlasWidth,
      atlasHeight,
      0,
      gl.RGBA_INTEGER,
      gl.SHORT,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // No mip levels exist, so the wrap modes are the only other way to make the texture incomplete.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return null;
  }

  function bindInstanceAttributes(): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 4, gl.FLOAT, false, instanceBytes, 0);
    gl.vertexAttribDivisor(aPosition, 1);
    gl.enableVertexAttribArray(aTexcoord);
    gl.vertexAttribPointer(aTexcoord, 4, gl.FLOAT, false, instanceBytes, 16);
    gl.vertexAttribDivisor(aTexcoord, 1);
    gl.enableVertexAttribArray(aEmPerPos);
    gl.vertexAttribPointer(aEmPerPos, 1, gl.FLOAT, false, instanceBytes, 32);
    gl.vertexAttribDivisor(aEmPerPos, 1);
    // `vertexAttribIPointer`, not `vertexAttribPointer`: `a_glyphLoc` is a `uint` in GLSL and a
    // float path would round every offset above 2^24 and, worse, convert the ones below it.
    gl.enableVertexAttribArray(aGlyphLoc);
    gl.vertexAttribIPointer(aGlyphLoc, 1, gl.UNSIGNED_INT, instanceBytes, 36);
    gl.vertexAttribDivisor(aGlyphLoc, 1);
    if (!perInstanceRunState) return;
    gl.enableVertexAttribArray(aModel0);
    gl.vertexAttribPointer(aModel0, 2, gl.FLOAT, false, instanceBytes, 40);
    gl.vertexAttribDivisor(aModel0, 1);
    gl.enableVertexAttribArray(aModel1);
    gl.vertexAttribPointer(aModel1, 2, gl.FLOAT, false, instanceBytes, 48);
    gl.vertexAttribDivisor(aModel1, 1);
    gl.enableVertexAttribArray(aModel2);
    gl.vertexAttribPointer(aModel2, 2, gl.FLOAT, false, instanceBytes, 56);
    gl.vertexAttribDivisor(aModel2, 1);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, instanceBytes, 64);
    gl.vertexAttribDivisor(aColor, 1);
    gl.enableVertexAttribArray(aSpreadPx);
    gl.vertexAttribPointer(aSpreadPx, 1, gl.FLOAT, false, instanceBytes, 80);
    gl.vertexAttribDivisor(aSpreadPx, 1);
  }

  function buildGeometry(): BuildFailure | null {
    const createdVao = gl.createVertexArray();
    const createdCorner = gl.createBuffer();
    const createdInstance = gl.createBuffer();
    if (!createdVao || !createdCorner || !createdInstance) {
      return {
        reason: "gl-object",
        message:
          "gl.createVertexArray/createBuffer returned null (context lost?)",
      };
    }
    vao = createdVao;
    cornerBuffer = createdCorner;
    instanceBuffer = createdInstance;

    gl.bindVertexArray(createdVao);
    // The four corner signs, in TRIANGLE_STRIP order: (cx, cy) = (0,0), (0,1), (1,0), (1,1). This is
    // exactly upstream's `nx = cx ? 1 : -1, ny = cy ? -1 : 1`, and exactly its two triangles
    // (v0,v1,v2) and (v1,v2,v3) — a strip is those two triangles and no index buffer.
    gl.bindBuffer(gl.ARRAY_BUFFER, createdCorner);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, 1, -1, -1, 1, 1, 1, -1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aNormal, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, createdInstance);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData.byteLength, gl.DYNAMIC_DRAW);
    bindInstanceAttributes();
    gl.bindVertexArray(null);
    return null;
  }

  function buildGlObjects(): BuildFailure | null {
    return buildProgram() ?? buildAtlasTexture() ?? buildGeometry();
  }

  /** Forget every handle WITHOUT calling GL. What a lost context leaves behind. */
  function dropGlObjects(): void {
    program = null;
    atlasTexture = null;
    vao = null;
    cornerBuffer = null;
    instanceBuffer = null;
  }

  function deleteGlObjects(): void {
    if (vao) gl.deleteVertexArray(vao);
    if (cornerBuffer) gl.deleteBuffer(cornerBuffer);
    if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
    if (atlasTexture) gl.deleteTexture(atlasTexture);
    if (program) gl.deleteProgram(program);
    dropGlObjects();
  }

  const initialFailure = buildGlObjects();
  if (initialFailure) {
    deleteGlObjects();
    return refuse(initialFailure.reason, initialFailure.message);
  }

  // -----------------------------------------------------------------------------------------------
  // Allocator
  // -----------------------------------------------------------------------------------------------

  const faces: RegisteredFace[] = [];
  /** Compatibility/debug lookup only; hot resolve/push use the numeric face maps below. */
  const allocations = new Map<string, Allocation>();
  const byFace: Map<number, Allocation>[] = [];
  /** Identity proof for slots this renderer minted; structural legacy slots have no entry here. */
  const ownedSlots = new WeakMap<GlyphSlot, Allocation>();
  /** Live allocations, always sorted by atlas offset. */
  const order: Allocation[] = [];
  let cursor = 0;
  let touchCounter = 0;
  /** Monotonic touch stamp. One counter, one place it advances. */
  const touch = (): number => {
    touchCounter += 1;
    return touchCounter;
  };
  /** Monotonic allocation stamp. Never reused, never reset — see {@link GlyphSlot.generation}. */
  let generationCounter = 0;
  let evictions = 0;
  let staleSkips = 0;
  let liveTexels = 0;
  let frameIndex = 0;
  let blobGlyphs = 0;
  let blobBytes = 0;
  let contextLost = false;

  // TWO PAIRS, AND THE SECOND DEFAULTS TO THE FIRST — see this file's header for what conflating
  // them costs. `?? designWidth` rather than `?? 0` because a standalone canvas genuinely has one
  // size, and making the caller repeat it would be the kind of ceremony people copy wrong.
  let designWidth = Math.max(1, options.designWidth);
  let designHeight = Math.max(1, options.designHeight);
  let framebufferWidth = Math.max(
    1,
    options.framebufferWidth ?? options.designWidth,
  );
  let framebufferHeight = Math.max(
    1,
    options.framebufferHeight ?? options.designHeight,
  );

  /**
   * Place `texels` texels and return the offset, evicting whatever the cursor lands on.
   *
   * A BUMP RING, NOT `die ("Ran out of atlas memory")`. Allocations are laid down in touch order,
   * so sweeping the cursor forward overwrites the OLDEST region first — which is LRU for the
   * workload this exists for, a glyph pool larger than the atlas where every resident glyph is
   * touched at most once a frame. It is only an approximation once a key is re-uploaded, and the
   * approximation is not what makes this safe.
   *
   * WHAT MAKES IT SAFE IS THE IN-USE GUARD, AND THAT GUARD STAYS A THROW. Everything else in this
   * file degrades to `null` plus an `onError`, because a shipped renderer must let its consumer
   * fall back. This one does not, and the judgement is deliberate:
   *
   *   - It is not a runtime condition. It says the atlas cannot hold ONE FRAME's working set, which
   *     is a sizing decision the embedder made before any frame ran. `atlas.capacityTexels` and
   *     `atlas.liveTexels` are published precisely so it can be made correctly.
   *   - Neither repair is honest. Evicting the victim draws a DIFFERENT glyph's outline in its
   *     place, at the right size, in the right position, perfectly antialiased — unreadable text
   *     that looks like working text. Declining the new glyph instead leaves the frame short, every
   *     frame, forever, reported only as a counter nobody reads.
   *   - It is not the hot loop. `push` never throws; this is the cache-miss path.
   */
  function removeAllocation(entry: Allocation): void {
    if (!entry.live) return;
    entry.live = false;
    allocations.delete(entry.key);
    byFace[entry.faceId]?.delete(entry.glyphId);
    const index = order.indexOf(entry);
    if (index >= 0) order.splice(index, 1);
    liveTexels -= entry.texels;
  }

  function allocate(key: string, texels: number): number {
    if (cursor + texels > capacityTexels) cursor = 0;
    const start = cursor;
    const end = cursor + texels;

    // `order` is offset-sorted, so the slice which can overlap is found without allocating and
    // sorting the whole atlas on every miss. The ring can wrap, but `start..end` itself cannot.
    let first = 0;
    let last = order.length;
    while (first < last) {
      const middle = (first + last) >>> 1;
      if (order[middle]!.offset + order[middle]!.texels <= start)
        first = middle + 1;
      else last = middle;
    }
    let after = first;
    while (after < order.length && order[after]!.offset < end) after += 1;
    // Check before mutating. A same-frame victim is a sizing error, and partial eviction before
    // throwing would make the renderer's resident-table invariants lie.
    for (let i = first; i < after; i += 1) {
      const victim = order[i]!;
      if (victim.usedFrame === frameIndex) {
        throw new Error(
          `hb-gpu: the atlas (${capacityTexels} texels) cannot hold one frame's glyphs — placing "${key}" would overwrite "${victim.key}", already drawn this frame`,
        );
      }
    }
    for (let i = first; i < after; i += 1) {
      const victim = order[i]!;
      victim.live = false;
      allocations.delete(victim.key);
      byFace[victim.faceId]?.delete(victim.glyphId);
      liveTexels -= victim.texels;
      evictions += 1;
    }
    if (after > first) order.splice(first, after - first);

    cursor = end;
    return start;
  }

  /**
   * Upload one blob's texels, row by row.
   *
   * ROW BY ROW BECAUSE THE STREAM IS 1-D AND THE TEXTURE IS NOT. A blob is a run of texels at some
   * absolute offset; that run generally starts mid-row and spans several. `texSubImage2D` can only
   * write rectangles, so each row-fragment is its own call — which is upstream's loop, and the
   * single most delicate arithmetic in this file. Off by one row and the glyph's band headers read
   * as curve data.
   */
  function uploadTexels(offset: number, texels: Uint8Array): void {
    // `Int16Array` over the SAME bytes, not a conversion: `gl.SHORT` means the driver reads these
    // 8-byte texels verbatim, and the encoder already wrote them little-endian, which is the only
    // byte order WebAssembly and WebGL both have. Building an Int16Array element by element here
    // would be a byte-swap waiting to be introduced.
    // `Int16Array` cannot start on an odd byte and throws a `RangeError` from inside the
    // constructor if asked to. `encode` hands back a `.slice()`, whose `byteOffset` is 0, so this
    // never fires on the package's own path — but a caller pooling blobs into one buffer could land
    // one on an odd offset, and a bare RangeError here says nothing about why.
    const shorts =
      texels.byteOffset % 2 === 0
        ? new Int16Array(
            texels.buffer,
            texels.byteOffset,
            texels.byteLength / 2,
          )
        : new Int16Array(texels.slice().buffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    // 8-byte texels make every row start 8-byte aligned, so 4 is safe. SAVED AND RESTORED because
    // `UNPACK_ALIGNMENT` is CONTEXT state, not texture state, and this renderer no longer owns the
    // context: `packages/canvas/src/textures.ts` sets it to 1 for its tightly packed RGBA uploads
    // and would have inherited this 4 on its next respec, which reads rows at the wrong stride and
    // skews every texture uploaded after the first glyph.
    const previousAlignment = Number(gl.getParameter(gl.UNPACK_ALIGNMENT)) || 4;
    if (previousAlignment !== 4) gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    // THE OTHER TWO UNPACK FLAGS, AND THIS PAIR CRASHES RATHER THAN ERRORS. Both are context state
    // like the alignment, but they are not merely wrong for this upload — they are ILLEGAL for it.
    // WebGL2 defines `UNPACK_FLIP_Y_WEBGL` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL` only for the
    // `texSubImage2D` overloads taking an ImageData / image / canvas / video / ImageBitmap, and
    // requires `INVALID_OPERATION` when either is true for an `ArrayBufferView` source, which is
    // the overload below.
    //
    // `packages/canvas/src/textures.ts:230` sets premultiply TRUE for its colour uploads and leaves
    // it set, exactly as it is entitled to — so any embedder that has uploaded one texture before
    // the first glyph hands this function an illegal call. On ANGLE/Vulkan the observed result is
    // not the specified error: the renderer process EXITS, with no GL error, no exception and
    // nothing on the console. That is how it was found — downstream, as a hard crash the moment a
    // glyph atlas took its first upload beside a normal texture cache.
    //
    // Restored rather than left false for the same reason the alignment is: the next embedder
    // upload after a glyph would otherwise silently stop premultiplying and composite at a².
    const previousFlipY = Boolean(gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL));
    const previousPremultiply = Boolean(
      gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL),
    );
    if (previousFlipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (previousPremultiply) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    let remaining = texels.byteLength / HB_GPU_TEXEL_BYTES;
    let source = 0;
    let destination = offset;
    while (remaining > 0) {
      const x = destination % atlasWidth;
      const y = Math.floor(destination / atlasWidth);
      const run = Math.min(atlasWidth - x, remaining);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        x,
        y,
        run,
        1,
        gl.RGBA_INTEGER,
        gl.SHORT,
        shorts,
        // The 4 shorts per texel are what turns a texel offset into an element offset. WebGL2's
        // `srcOffset` counts ELEMENTS of the typed array, not bytes and not texels.
        source * 4,
      );
      source += run;
      destination += run;
      remaining -= run;
    }
    if (previousAlignment !== 4) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
    }
    if (previousFlipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (previousPremultiply) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Frame state
  // -----------------------------------------------------------------------------------------------

  let instanceCount = 0;
  const model = new Float32Array([1, 0, 0, 1, 0, 0]);
  const color = new Float32Array([1, 1, 1, 1]);
  /** Object units, and 0 is the fill path. See {@link HbGpuRenderer.setSpread}. */
  let spreadPx = 0;
  const mvp = new Float32Array(16);
  let mvpDirty = true;
  let colorDirty = true;
  let spreadDirty = true;
  let viewportDirty = true;
  /**
   * Design -> clip as `(scaleX, scaleY, translateX, translateY)`, byte-identical to
   * `createCanvasStage`'s `toClip`.
   *
   * `scaleY` is NEGATIVE because design space measures y DOWNWARDS and clip space upwards. Computed
   * here rather than read off a stage because this renderer no longer has one — and restated in the
   * same four numbers, in the same order, so the two cannot silently diverge.
   *
   * THE DESIGN PAIR, NOT THE FRAMEBUFFER PAIR. The framebuffer pair is `u_viewport` and only that.
   */
  const toClip = new Float32Array(4);

  function refreshProjection(): void {
    toClip[0] = 2 / designWidth;
    toClip[1] = -2 / designHeight;
    toClip[2] = -1;
    toClip[3] = 1;
  }
  refreshProjection();

  /**
   * Design-to-clip as the column-major `mat4` GLSL wants. The batched program receives only this
   * projection; the established renderer keeps its complete model-view-projection uniform.
   *
   * ONE matrix, and it has to be this one. `hb_gpu_dilate` is handed the same `m` and works out
   * how far half a screen pixel is by pushing the vertex AND its normal through it, so any part of
   * the transform applied elsewhere — a quad rotated on the CPU, a viewport scale — is a transform
   * the dilation cannot see.
   */
  function refreshMatrix(): void {
    const sx = toClip[0];
    const sy = toClip[1];
    mvp.fill(0);
    mvp[0] = perInstanceRunState ? sx : sx * model[0];
    mvp[1] = perInstanceRunState ? 0 : sy * model[1];
    mvp[4] = perInstanceRunState ? 0 : sx * model[2];
    mvp[5] = perInstanceRunState ? sy : sy * model[3];
    mvp[10] = 1;
    mvp[12] = perInstanceRunState ? toClip[2] : sx * model[4] + toClip[2];
    mvp[13] = perInstanceRunState ? toClip[3] : sy * model[5] + toClip[3];
    mvp[15] = 1;
  }

  function growInstances(): void {
    instanceCapacity *= 2;
    const next = new ArrayBuffer(instanceCapacity * instanceBytes);
    new Uint8Array(next).set(new Uint8Array(instanceData));
    instanceData = next;
    instanceFloats = new Float32Array(instanceData);
    instanceUints = new Uint32Array(instanceData);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData.byteLength, gl.DYNAMIC_DRAW);
    // The VAO's pointers reference the buffer by NAME, but re-specifying storage is the safe moment
    // to restate them; a bound VAO with a stale size is one of WebGL's quieter failure modes.
    bindInstanceAttributes();
    gl.bindVertexArray(null);
  }

  /**
   * The slot an allocation describes. ONE expression, and that is the point of it.
   *
   * A fresh slot, a slot for a glyph that was already resident and a slot handed back by
   * {@link HbGpuRenderer.resolve} all come from here, so they cannot disagree about the ink box,
   * the generation or the offset. It reads the ALLOCATION only — it takes no `EncodedGlyph` —
   * which is what lets `resolve` exist without an encoder.
   */
  function slotFor(entry: Allocation): GlyphSlot {
    return entry.slot;
  }

  return {
    gl,
    atlasWidth,

    get contextLost() {
      return contextLost;
    },

    registerFace(font, label) {
      const upem = font.upem;
      // The division that made this check necessary is `pixelsPerEm / slot.upem` in `push`: a upem
      // of 0 makes it Infinity, every instance record becomes NaN, and the draw is a silent no-op
      // with no error anywhere. `packages/hb-gpu/src/index.ts` rejects a degenerate face at
      // creation; this is the second gate, at the layer that does the dividing.
      if (!Number.isInteger(upem) || upem <= 0) {
        return refuse(
          "degenerate-upem",
          `face "${label ?? faces.length}" reports upem ${upem} — every glyph scaled by it would be NaN and draw nothing`,
        );
      }
      const face: RegisteredFace = {
        id: faces.length,
        label: label ?? `face${faces.length}`,
        upem,
        font,
      };
      faces.push(face);
      byFace.push(new Map());
      return face;
    },

    upload(face, glyphId, glyph) {
      if (contextLost) {
        report(
          "context-lost",
          `upload of glyph ${glyphId} ignored while the context is lost — call rebuild() from webglcontextrestored`,
        );
        return null;
      }
      const registered = faces[face.id];
      if (!registered || registered !== face) {
        return refuse(
          "face-unregistered",
          `face "${face.label}" (id ${face.id}) was not registered with this renderer — its keys would collide with whatever face holds that id`,
        );
      }
      const key = `${face.id}/${glyphId}`;
      const existing = byFace[face.id]?.get(glyphId);
      if (existing) {
        existing.usedAt = touch();
        return slotFor(existing);
      }
      // A blank glyph (a space) encodes to the empty-blob singleton. Zero texels is not an
      // allocation and drawing it would be a degenerate quad reading texel 0 — which is some other
      // glyph's header.
      if (glyph.texels.length === 0) return null;
      if (glyph.texels.length % HB_GPU_TEXEL_BYTES !== 0) {
        return refuse(
          "blob-malformed",
          `blob for "${key}" is ${glyph.texels.length} bytes, not a whole number of ${HB_GPU_TEXEL_BYTES}-byte texels — it would be uploaded a texel short and read as curve data`,
        );
      }

      const texels = glyph.texels.length / HB_GPU_TEXEL_BYTES;
      if (texels > capacityTexels) {
        // Data-dependent, unlike the in-use guard: one pathological outline in a font nobody chose.
        // A live app has to survive it with a hole in one run, so this declines rather than throws.
        return refuse(
          "blob-too-large",
          `glyph "${key}" needs ${texels} texels but the whole atlas is ${capacityTexels} — raise atlasTexels; this glyph will not be drawn`,
        );
      }
      const offset = allocate(key, texels);
      uploadTexels(offset, glyph.texels);
      generationCounter += 1;
      const entry = {
        key,
        faceId: face.id,
        glyphId,
        offset,
        texels,
        generation: generationCounter,
        live: true,
        rid,
        usedAt: touch(),
        usedFrame: -1,
        upem: face.upem,
        // HarfBuzz extents are y-UP with a NEGATIVE height: `yBearing` is the ink's TOP and
        // `yBearing + height` its bottom, so flipping into a min/max box swaps which is which.
        // Read ONCE, here, where the `EncodedGlyph` is in hand — everything downstream, `resolve`
        // included, reads it back off the allocation.
        minX: glyph.extents.xBearing,
        minY: glyph.extents.yBearing + glyph.extents.height,
        maxX: glyph.extents.xBearing + glyph.extents.width,
        maxY: glyph.extents.yBearing,
      } as Omit<Allocation, "slot">;
      const slot: GlyphSlot = {
        faceId: face.id,
        glyphId,
        key,
        generation: entry.generation,
        loc: entry.offset,
        upem: entry.upem,
        minX: entry.minX,
        minY: entry.minY,
        maxX: entry.maxX,
        maxY: entry.maxY,
        texels: entry.texels,
      };
      Object.defineProperty(slot, SLOT_OWNER, { value: rid });
      const owned: Allocation = { ...entry, slot };
      ownedSlots.set(slot, owned);
      allocations.set(key, owned);
      byFace[face.id]!.set(glyphId, owned);
      let insertion = 0;
      while (insertion < order.length && order[insertion]!.offset < offset)
        insertion += 1;
      order.splice(insertion, 0, owned);
      liveTexels += texels;
      blobGlyphs += 1;
      blobBytes += glyph.texels.length;

      return slotFor(owned);
    },

    resolve(face, glyphId) {
      // A lost context still HAS its allocation table — `notifyContextLost` keeps it so `rebuild`
      // can put the same texels back at the same offsets — but nothing may be drawn until the
      // rebuild, and handing out a slot that `push` would silently discard is worse than a miss.
      if (contextLost) return null;
      const registered = faces[face.id];
      if (!registered || registered !== face) {
        // Reported, unlike a plain miss: a foreign face handle is a bug in the embedder, and the
        // symptom without this is a run that silently draws nothing at all.
        return refuse(
          "face-unregistered",
          `face "${face.label}" (id ${face.id}) was not registered with this renderer — resolve() cannot answer for it, and every glyph of the run would be missing`,
        );
      }
      const entry = byFace[face.id]?.get(glyphId);
      if (!entry) return null;
      // Touched, exactly as the already-resident path of `upload` touches: a caller that resolves
      // its whole run before pushing any of it must not look idle to the ring.
      entry.usedAt = touch();
      return slotFor(entry);
    },

    begin() {
      frameIndex += 1;
      instanceCount = 0;
    },

    push(slot, x, y, pixelsPerEm) {
      if (contextLost) return;
      // Slots we minted take the numeric fast path and can prove renderer ownership without
      // parsing a key. A structural legacy slot has no identity metadata, so preserve source
      // compatibility with one cold key lookup.
      const owned = ownedSlots.get(slot);
      const owner = (slot as GlyphSlot & { [SLOT_OWNER]?: number })[SLOT_OWNER];
      const entry = owned
        ? owned
        : owner !== undefined && owner !== rid
          ? undefined
          : slot.faceId !== undefined && slot.glyphId !== undefined
            ? byFace[slot.faceId]?.get(slot.glyphId)
            : allocations.get(slot.key);
      // THE EVICTION GUARD, AND IT IS THREE COMPARISONS FOR A REASON. A missing entry is the plain
      // case. A LIVE entry under the same key is the nasty one: the glyph was evicted and later
      // re-uploaded somewhere else, so the key still resolves and `slot.loc` still points at a
      // plausible offset — which is now some other glyph's blob. `generation` is what distinguishes
      // "this allocation" from "an allocation that once had this name"; `offset` is a second, free
      // check that costs nothing and would catch a slot copied between renderers.
      if (
        !entry ||
        entry.rid !== rid ||
        !entry.live ||
        entry.generation !== slot.generation ||
        entry.offset !== slot.loc
      ) {
        staleSkips += 1;
        return;
      }
      if (instanceCount >= instanceCapacity) growInstances();
      entry.usedFrame = frameIndex;
      entry.usedAt = touch();

      // Font units to object units. An em coordinate `e` lands at `x + scale * e` in x and
      // `y - scale * e` in y; the minus is the em-space y-UP to object-space y-DOWN flip, and it
      // is why the object box's `y0` — taken at the em box's MINIMUM y — is the LARGER value.
      const scale = pixelsPerEm / slot.upem;
      const base = instanceCount * instanceFloatsPerRecord;
      instanceFloats[base] = x + scale * slot.minX;
      instanceFloats[base + 1] = y - scale * slot.minY;
      instanceFloats[base + 2] = x + scale * slot.maxX;
      instanceFloats[base + 3] = y - scale * slot.maxY;
      instanceFloats[base + 4] = slot.minX;
      instanceFloats[base + 5] = slot.minY;
      instanceFloats[base + 6] = slot.maxX;
      instanceFloats[base + 7] = slot.maxY;
      // `a_emPerPos` is the INVERSE of the scale: em units per object unit, which for a 1000-unit
      // em at 14 px is ~71. `jac` is built from it in the vertex wrapper.
      instanceFloats[base + 8] = 1 / scale;
      instanceUints[base + 9] = slot.loc >>> 0;
      if (perInstanceRunState) {
        for (let i = 0; i < 6; i += 1) instanceFloats[base + 10 + i] = model[i]!;
        instanceFloats[base + 16] = color[0];
        instanceFloats[base + 17] = color[1];
        instanceFloats[base + 18] = color[2];
        instanceFloats[base + 19] = color[3];
        instanceFloats[base + 20] = spreadPx;
      }
      instanceCount += 1;
    },

    setModel(next) {
      for (let i = 0; i < 6; i += 1) {
        if (!perInstanceRunState && model[i] !== next[i]) mvpDirty = true;
        model[i] = next[i];
      }
    },

    setColor(r, g, b, a) {
      if (!perInstanceRunState) {
        colorDirty ||= color[0] !== r || color[1] !== g || color[2] !== b || color[3] !== a;
      }
      color[0] = r;
      color[1] = g;
      color[2] = b;
      color[3] = a;
    },

    setSpread(px) {
      // Clamped rather than reported. A negative spread would shrink the quad below the ink box and
      // clip the glyph's own antialiased rim, and a NaN would make `v_spreadPx > 0.0` false in the
      // fragment but `pos += a_normal * NaN` a degenerate quad in the vertex — a run that vanishes.
      const next = Number.isFinite(px) && px > 0 ? px : 0;
      if (!perInstanceRunState && spreadPx !== next) spreadDirty = true;
      spreadPx = next;
    },

    setViewport(width, height, bufferWidth, bufferHeight) {
      const nextDesignWidth = Math.max(1, width);
      const nextDesignHeight = Math.max(1, height);
      const nextFramebufferWidth = Math.max(1, bufferWidth ?? width);
      const nextFramebufferHeight = Math.max(1, bufferHeight ?? height);
      if (
        designWidth !== nextDesignWidth ||
        designHeight !== nextDesignHeight
      ) {
        designWidth = nextDesignWidth;
        designHeight = nextDesignHeight;
        refreshProjection();
        mvpDirty = true;
      }
      if (
        framebufferWidth !== nextFramebufferWidth ||
        framebufferHeight !== nextFramebufferHeight
      ) {
        framebufferWidth = nextFramebufferWidth;
        framebufferHeight = nextFramebufferHeight;
        viewportDirty = true;
      }
    },

    end() {
      if (contextLost || instanceCount === 0) {
        return { instances: 0, drawCalls: 0 };
      }
      if (!program || !vao || !instanceBuffer || !atlasTexture) {
        return { instances: 0, drawCalls: 0 };
      }

      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        instanceFloats,
        0,
        instanceCount * instanceFloatsPerRecord,
      );

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
      if (mvpDirty) {
        refreshMatrix();
        gl.uniformMatrix4fv(
          perInstanceRunState ? uViewProjection : uMatViewProjection,
          false,
          mvp,
        );
        mvpDirty = false;
      }
      if (!perInstanceRunState && colorDirty) {
        gl.uniform4fv(uColor, color);
        colorDirty = false;
      }
      if (!perInstanceRunState && spreadDirty) {
        gl.uniform1f(uSpreadPx, spreadPx);
        spreadDirty = false;
      }
      // THE FRAMEBUFFER PAIR. `hb_gpu_dilate` divides by this to turn half a screen pixel into
      // object units; the design pair is already inside `mvp` and passing it here as well would
      // double-count the device-pixel ratio.
      if (viewportDirty) {
        gl.uniform2f(uViewport, framebufferWidth, framebufferHeight);
        viewportDirty = false;
      }

      // Premultiplied MIX, the package's blend: `src + dst * (1 - src.a)`.
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
      gl.bindVertexArray(null);
      return { instances: instanceCount, drawCalls: 1 };
    },

    notifyContextLost() {
      contextLost = true;
      instanceCount = 0;
      // NO `gl.delete*` HERE. Every one of those handles is already invalid; calling into GL with
      // them is at best ignored and at worst an INVALID_OPERATION the embedder's own error check
      // will report as its bug.
      dropGlObjects();
    },

    rebuild() {
      const failure = buildGlObjects();
      if (failure) {
        deleteGlObjects();
        report(
          failure.reason,
          `rebuild after context loss failed — ${failure.message}`,
        );
        return false;
      }
      // A rebuilt program has only the constants stated by buildProgram; all per-run state must
      // be installed on the first draw after restoration.
      mvpDirty = true;
      colorDirty = true;
      spreadDirty = true;
      viewportDirty = true;
      // In OFFSET order, not touch order: the uploads then walk the texture forwards, which is the
      // one access pattern a driver can coalesce. Correctness does not depend on it — every
      // allocation goes back exactly where it was.
      const resident = [...order];
      const dropped: string[] = [];
      for (const entry of resident) {
        const face = faces[entry.faceId];
        const glyph = face ? face.font.encode(entry.glyphId) : null;
        if (
          !glyph ||
          glyph.texels.length !== entry.texels * HB_GPU_TEXEL_BYTES
        ) {
          // The font was destroyed, or the encoder no longer produces the same blob. Dropping the
          // allocation is what makes the slots the embedder holds fail the generation check and be
          // SKIPPED — the alternative is texels of the wrong length at a fixed offset, which is
          // another glyph's outline drawn in this one's place.
          removeAllocation(entry);
          dropped.push(entry.key);
          continue;
        }
        uploadTexels(entry.offset, glyph.texels);
      }
      contextLost = false;
      if (dropped.length > 0) {
        report(
          "rebuild-incomplete",
          `${dropped.length} of ${resident.length} resident glyphs could not be re-encoded after a context loss (${dropped.slice(0, 8).join(", ")}${dropped.length > 8 ? ", …" : ""}) — their faces' fonts must outlive the renderer; those glyphs will be skipped until re-uploaded`,
        );
      }
      return true;
    },

    get atlas(): AtlasStats {
      return {
        liveBytes: liveTexels * HB_GPU_TEXEL_BYTES,
        reservationBytes: atlasWidth * atlasHeight * HB_GPU_TEXEL_BYTES,
        entries: allocations.size,
        liveTexels,
        capacityTexels,
        evictions,
        faces: faces.length,
        staleSkips,
      };
    },

    get blobs(): BlobStats {
      return {
        glyphs: blobGlyphs,
        totalBytes: blobBytes,
        bytesPerGlyph: blobGlyphs > 0 ? blobBytes / blobGlyphs : 0,
      };
    },

    dispose() {
      // The context, the canvas and the registered fonts all belong to the embedder. This deletes
      // what this file created and nothing else.
      if (!contextLost) deleteGlObjects();
      else dropGlObjects();
      faces.length = 0;
      allocations.clear();
      byFace.length = 0;
      order.length = 0;
    },
  };
}
