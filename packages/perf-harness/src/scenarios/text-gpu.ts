// The `hb-gpu` arm's machinery: shape once, encode the OUTLINE once, then evaluate coverage per
// fragment, at whatever size and rotation the frame asks for.
//
// WHAT MAKES THIS ARM DIFFERENT FROM THE OTHER TWO BAKED ONES. `hb-atlas` and `hb-run` bake PIXELS:
// they rasterize at one size, at one rotation, at N sub-pixel phases, and thereafter blit. This
// bakes the CURVES. HarfBuzz's Slug encoder turns each glyph's outline into a banded, quantized
// RGBA16I texel stream and a fragment shader evaluates exact coverage from it — so there is no
// atlas resolution to pick, no phase grid, and no rotation baked into anything. That is the claim,
// and it is why `bakeRotation`, `phases` and `bakeShaper` are REFUSED here rather than accepted and
// ignored: see {@link textGpuUnsupportedParam}.
//
// IT SHAPES IN THIS MODULE NOW, WHICH IS WHY THE ARM HOLDS ONE HARFBUZZ. `hb-gpu.symbols` exports
// `hb_shape`, so the scenario arm runs `HbGpuFont.shape` through {@link shapeRunWithHbGpu} instead
// of npm `harfbuzzjs`: one wasm module, one copy of each face, and {@link
// HbGpuTextStats.wasmHeapBytes} is the whole of this arm's wasm rather than half of it. The
// arrangement this replaces shaped with harfbuzzjs and used this module only to read outlines, so
// every face was resident in two heaps at once.
//
// AND THAT TURNED A STRUCTURAL INVARIANT INTO A CHECKED ONE — read this before touching either
// shaper. `hb-atlas` / `hb-run` still shape with `createHarfBuzzShaper`, so the pen positions this
// arm draws at are no longer identical to theirs BY CONSTRUCTION (a shared object), only by
// AGREEMENT between two independently compiled HarfBuzz builds. The alignment guard can be read as
// a statement about the renderer exactly as far as that agreement holds, so it is asserted rather
// than assumed: `test/text-shaper-agreement.test.ts` shapes S9's own Han and Latin run strings, at
// S9's font size, through `createHarfBuzzShaper` and through `shapeRunWithHbGpu`, and requires the
// resulting `ShapedGlyph[]` — key and `penPx` — to be equal. `packages/hb-gpu/test/shape.test.ts`
// grades the two shapers underneath that, glyph id for glyph id and position for position.
//
// THE FIDELITY PROBE'S hb-gpu ARM STILL SHAPES WITH harfbuzzjs (`probes/text-fidelity-hb.ts`), so
// inside the probe the guard remains structural — the arm it grades and the arms it grades it
// against are fed pen positions from one shaper. That is only sound while the same agreement holds,
// which is the other reason the test above exists and why it covers the probe's run strings too.
//
// THE PLACEMENT ARITHMETIC IS `glyphLocal`, IMPORTED, NOT RE-DERIVED. Every arm in this round
// anchors the alphabetic baseline exactly `baselinePx` below the run box's top edge and rotates
// about the run box's centre. A second expression for that here — even a correct one — is a second
// thing to keep correct, and `docs/text-rendering.md` records four separate rounds in which a
// fraction of a pixel of disagreement was the entire finding.
//
// ONE MODEL MATRIX PER FRAME, AND THE RUNS ARE PRE-ROTATED INTO IT. `hb_gpu_dilate` computes its
// half-pixel dilation in SCREEN space through the same matrix the quad is transformed by, so a quad
// rotated on the CPU behind the shader's back would be dilated along the wrong axes — the package
// says so at `HbGpuRenderer.push`. But every run rotates about its OWN centre, and one matrix cannot
// hold 40 different pivots. The resolution is in {@link HbGpuTextArm.push}: the rotation is shared
// (it is one angle for the whole scenario), so only the TRANSLATION differs per run, and a
// translation can be carried in the object-space position instead of the matrix.
//
// AN OUTLINED LABEL IS TWO PASSES OVER THE SAME RUNS, AND THE SECOND WALK IS NOT WASTE. When
// `outlinePx` is non-zero the frame runs the outline pass (`setSpread(outlinePx / 2)`, outline
// colour) and then the fill pass (spread 0, fill colour), in that order — which is exactly the
// shape `packages/canvas`'s glyph pass produces for a consumer's outlined label: the same glyphs
// and the same pens recorded TWICE in the draw list, once with a spread and once without. The
// instance buffer of the first pass is still resident and could be redrawn with two uniforms
// changed, which would be cheaper and would measure something the consumer does not do. The pen
// walk is repeated on purpose so the arm is charged the CPU half of an outline as well as the GPU
// half. See {@link HbGpuTextArm.passes}.
//
// THE GLUE IS LOADED BY URL, NEVER IMPORTED. `packages/hb-gpu/vendor/hb-gpu.mjs` is emscripten
// output — committed rather than built on demand (`vendor/VENDOR.md`), but still not something to
// pull into a bundle: it is a 227 KB wasm's loader with its own `import.meta.url` fetch path.
// esbuild resolves `import()` statically even when it cannot bundle it, so a literal specifier here
// would make the perf-harness page bundle — ONE bundle, shared by all nine scenarios — fail to
// build for everybody. The specifier is therefore a variable, the harness serves the file, and the
// node side refuses to sweep this arm at all when the build is absent (`src/hb-gpu-build.ts`).

import { type CanvasStage, createCanvasStage } from "@godot-scene-web/canvas";
import {
  createHbGpu,
  type EncodedGlyph,
  type HbGpu,
  type HbGpuFailure,
  type HbGpuFont,
} from "@godot-scene-web/hb-gpu";
import {
  createHbGpuRenderer,
  type GlyphSlot,
  HB_GPU_CONTRAST_NONE,
  type HbGpuContrast,
  type HbGpuFace,
  type HbGpuRenderer,
} from "@godot-scene-web/hb-gpu/webgl";
import {
  faceIdOf,
  glyphKey,
  glyphLocal,
  harfbuzzGlyphIdOf,
  type RunLayout,
  type ShapedGlyph,
} from "./text-hb";
import type { ParamValue } from "./types";

/**
 * Where the harness serves hb-gpu's build outputs.
 *
 * TWO FILES, AND BOTH ARE SERVED RATHER THAN BUNDLED. The `.wasm` is fetched as an `ArrayBuffer`
 * and handed to `createHbGpu` as `{ wasmBinary }`, so the emscripten glue never resolves it
 * relative to `import.meta.url` — which after bundling would be the perf bundle's own URL, and
 * silently wrong. The `.mjs` is dynamically imported from this same origin; see the module header
 * for why it cannot be a static specifier.
 */
export const HB_GPU_GLUE_URL = "/hb-gpu.mjs";
export const HB_GPU_WASM_URL = "/hb-gpu.wasm";

/** What {@link loadHbGpuModule} needs, so a test or a probe can serve them somewhere else. */
export interface HbGpuAssetUrls {
  glue: string;
  wasm: string;
}

const DEFAULT_ASSET_URLS: HbGpuAssetUrls = {
  glue: HB_GPU_GLUE_URL,
  wasm: HB_GPU_WASM_URL,
};

/**
 * Instantiate the hb-gpu wasm module from the harness's own origin.
 *
 * The 404 is named rather than left to emscripten. Without this check a missing build reaches the
 * glue as an HTML error page, which fails inside `WebAssembly.instantiate` with a magic-number
 * complaint that says nothing about `build.sh`.
 */
export async function loadHbGpuModule(
  urls: HbGpuAssetUrls = DEFAULT_ASSET_URLS,
): Promise<HbGpu> {
  const response = await fetch(urls.wasm);
  if (!response.ok) {
    throw new Error(
      `text-gpu: ${urls.wasm} responded ${response.status} — hb-gpu's wasm has not been built or is not being served; run \`bash packages/hb-gpu/build.sh\``,
    );
  }
  const wasmBinary = await response.arrayBuffer();
  // A VARIABLE specifier, on purpose: esbuild resolves a literal one at build time and would fail
  // the whole page bundle on a checkout that has never run `build.sh`. See the module header.
  const glueUrl = urls.glue;
  const glue = (await import(/* @vite-ignore */ glueUrl)) as {
    default: Parameters<typeof createHbGpu>[0];
  };
  // `onError` RE-RAISES, and that is the one place in this repo where it should. `createHbGpu`
  // hands back `null` from `createFont` so a shipping consumer can fall back to a DOM text path;
  // this is a measurement arm, and a face it silently declined would render a blank page — which
  // scores perfectly on frame time, on VRAM and on draw calls. Every hb-gpu refusal reaching here
  // means the arm cannot be run, so it becomes a failed sweep rather than a flattering row.
  return createHbGpu(glue.default, wasmBinary, {
    onError: (failure) => {
      throw new Error(
        `text-gpu: hb-gpu refused (${failure.reason}) — ${failure.message}`,
      );
    },
  });
}

/**
 * The params this arm has no meaning for, refused rather than silently absorbed.
 *
 * `bakeRotation`, `phases` and `bakeShaper` are the three isolations `hb-atlas` / `hb-run` are swept
 * over, and NONE of them exists here: there is no bake to rotate, no phase grid to size, and the
 * shaper is not a choice at all — this arm shapes in its own wasm ({@link shapeRunWithHbGpu}) and
 * needs glyph ids to encode outlines from, which a `fillText` shaper's character keys do not carry.
 * Accepting them would put `phases: 4` in the report next to an arm that has no phases, which is a
 * measurement of something that did not happen.
 *
 * DEFAULTS ARE NOT REFUSED, and cannot be: `resolveParams` materialises every default into the page
 * URL, so the arm cannot tell "the operator asked for 4 phases" from "nobody mentioned phases".
 * What it CAN tell is that a non-default value was asked for, and that is exactly the case worth
 * refusing. Modelled on `webgpuUnsupportedParam`, thrown from `ready()` for the same reason.
 */
export function textGpuUnsupportedParam(
  params: Record<string, ParamValue>,
): string | null {
  const refuse = (param: string, why: string): string =>
    `text-render: \`--param ${param}\` has no meaning on the hb-gpu arm and is REFUSED rather than ignored — ${why}. Sweep it on \`--mechanism hb-atlas\` or \`--mechanism hb-run\`, which is where it isolates something.`;
  if (Number(params.phases) !== 4) {
    return refuse(
      `phases=${String(params.phases)}`,
      "hb-gpu has no phase grid: coverage is evaluated per fragment at the position the frame asks for, so there is no pre-baked sub-pixel variant to pick between",
    );
  }
  if (
    params.bakeRotation === false ||
    String(params.bakeRotation) === "false"
  ) {
    return refuse(
      "bakeRotation=false",
      "hb-gpu bakes no pixels at all, so there is no rotation in them to leave out; the rotation is in the model matrix on every frame and the encoded outline is the same either way",
    );
  }
  if (String(params.bakeShaper ?? "harfbuzz") !== "harfbuzz") {
    return refuse(
      `bakeShaper=${String(params.bakeShaper)}`,
      "hb-gpu shapes in its own wasm and encodes outlines by GLYPH ID, and the fillText shaper's keys are characters with no glyph id behind them",
    );
  }
  return null;
}

/**
 * `--param outlinePx`, refused on every arm that has no outline — and on any value that is not one.
 *
 * THE MIRROR IMAGE OF {@link textGpuUnsupportedParam}, and it is here rather than in `text-render`
 * for the reason that one is: there should be ONE statement of which params this arm does and does
 * not answer for, so a reader checking whether a report describes what ran has one place to look.
 * The two are the same rule applied in both directions — a param recorded beside an arm that has no
 * such thing is a measurement of something that did not happen, whether the arm is `hb-gpu` or not.
 *
 * THE DEFAULT IS NOT REFUSED, AND CANNOT BE: `resolveParams` materialises every default into the
 * page URL, so `dom` cannot tell "the operator asked for no outline" from "nobody mentioned an
 * outline". `0` is the former in both cases and is the only accepted value off this arm.
 *
 * IT ALSO REFUSES A NEGATIVE OR NON-FINITE RADIUS ON `hb-gpu` ITSELF. `HbGpuRenderer.setSpread`
 * CLAMPS those to 0 rather than reporting them — it is a per-run hot-path setter with no error
 * channel — so an `outlinePx=-4` run would draw the plain fill and file its report under a stroke
 * width of -4. The clamp is right there and wrong here; a measurement arm says so instead.
 */
export function textOutlineParamRefusal(
  mechanism: string,
  params: Record<string, ParamValue>,
): string | null {
  const raw = params.outlinePx ?? 0;
  const outlinePx = Number(raw);
  if (!Number.isFinite(outlinePx) || outlinePx < 0) {
    return `text-render: \`--param outlinePx=${String(raw)}\` is not a stroke width — it must be a finite number of design px, 0 or more. \`HbGpuRenderer.setSpread\` clamps a negative or non-finite radius to 0 and reports nothing, so this would have measured the plain fill and filed the row under an outline.`;
  }
  if (outlinePx === 0 || mechanism === "hb-gpu") return null;
  return `text-render: \`--param outlinePx=${String(raw)}\` has no meaning on the ${mechanism} arm and is REFUSED rather than ignored — the outline in this scenario is hb-gpu's coverage-max dilation (\`HbGpuRenderer.setSpread\`) and no other arm here has one: \`hb-atlas\`/\`hb-run\` would need a second baked atlas per radius, and \`dom\`/\`canvas2d\` would need \`-webkit-text-stroke\`/\`strokeText\`, none of which this scenario builds. A report recording \`outlinePx=${outlinePx}\` beside an arm that drew plain fill is a measurement of something that did not happen. Sweep it on \`--mechanism hb-gpu\`, which is the arm that has it.`;
}

/**
 * Shape one run through hb-gpu's OWN HarfBuzz, into the key space and the pen units every arm of
 * this round places glyphs in.
 *
 * WHY THE ARITHMETIC IS RESTATED HERE AND NOT IMPORTED. There is no shaper object to reuse:
 * `createHarfBuzzShaper` owns a `harfbuzzjs` font and this owns an `HbGpuFont`, and the four lines
 * below are the whole of what they have in common. They are copied deliberately and held equal by
 * `test/text-shaper-agreement.test.ts` — `penPx = (pen + xOffset) * fontSizePx / upem`, with the
 * offset positioning THIS glyph only and the advance moving the pen AFTER it. `docs/text-rendering.md`
 * records four rounds in which half a step of that was the entire finding, and `HbGpuFont.shape`'s
 * own doc comment writes it out for the same reason.
 *
 * THE KEY IS `<face>/g<gid>`, from `glyphKey`, because everything downstream — the encoder's
 * `harfbuzzGlyphIdOf`, the atlas, the fidelity probe — reads that one format, and because a face
 * prefix is what stops Roboto's gid 97 from being drawn as Noto Sans SC's.
 *
 * `null` BACK FROM `shape` THROWS. This is a measurement arm: a run it could not shape would draw
 * shorter than it should and report as a cheap, crisp one. An EMPTY run is a different answer and a
 * legal one, and comes back as `[]`.
 */
export function shapeRunWithHbGpu(
  fonts: ReadonlyMap<string, HbGpuFont>,
  faceId: string,
  text: string,
  fontSizePx: number,
): ShapedGlyph[] {
  const font = fontFor(fonts, faceId);
  const run = font.shape(text);
  if (!run) {
    throw new Error(
      `text-gpu: hb-gpu could not shape the "${faceId}" run ${JSON.stringify(text)} — an arm that carried on would draw a run with characters missing from it and report as a cheap, crisp one`,
    );
  }
  // Font units to CSS px. `createFont` scales the font to its own upem, so everything `shape`
  // returns is in font units — see `HbGpuFont.shape`.
  const toPx = fontSizePx / font.upem;
  const glyphs: ShapedGlyph[] = [];
  let pen = 0;
  for (const glyph of run) {
    glyphs.push({
      key: glyphKey(faceId, `g${glyph.glyphId}`),
      penPx: (pen + glyph.xOffset) * toPx,
    });
    pen += glyph.xAdvance;
  }
  return glyphs;
}

/**
 * Where one glyph's em origin goes in OBJECT space, in device px — the position `push` is handed.
 *
 * THE PIVOT, WITHOUT A SECOND MATRIX, and the single expression the alignment guard is really
 * grading. Every run rotates about its own centre, so the SCREEN position wanted is `R·local + C`,
 * exactly as `drawGlyphCells` computes it. The model matrix already applies `R` (and must, so that
 * `hb_gpu_dilate` sees the same transform the quad does), and one matrix cannot hold 40 different
 * pivots — but the angle is shared, so only the translation differs per run, and a translation can
 * be carried in the position instead.
 *
 * Pushing at `local + R⁻¹C` gives `R·(local + R⁻¹C) = R·local + C`. The run's centre maps to
 * itself, which IS rotation about that centre.
 *
 * PURE AND EXPORTED so `test/text-gpu.test.ts` can multiply the result by the model matrix and hold
 * it against `hb-atlas`'s own origin arithmetic, to floating-point equality, with no browser and no
 * GPU. A placement bug found there is a failing assertion; the same bug found later is a fidelity
 * number that looks like a property of Slug.
 *
 * `glyphLocal` is IMPORTED, never re-derived — see the module header.
 */
export function hbGpuObjectOrigin(
  penPx: number,
  layout: RunLayout,
  centreX: number,
  centreY: number,
): { x: number; y: number } {
  const cos = Math.cos(layout.radians);
  const sin = Math.sin(layout.radians);
  // Rotation commutes with a uniform scale, so device px before or after the rotation is the same
  // number; `glyphLocal` works in CSS px from the run box centre, so the scale is applied here.
  const centreDeviceX = centreX * layout.dpr;
  const centreDeviceY = centreY * layout.dpr;
  const local = glyphLocal(penPx, layout);
  return {
    x: cos * centreDeviceX + sin * centreDeviceY + local.x * layout.dpr,
    y: -sin * centreDeviceX + cos * centreDeviceY + local.y * layout.dpr,
  };
}

/** What this arm cost, in the units the S9 table reports. */
export interface HbGpuTextStats {
  /** Distinct glyphs encoded and resident. */
  glyphs: number;
  /** Sum of every encoded blob, in bytes — the Slug format's own size for this workload. */
  blobBytes: number;
  /** Smallest and largest single blob. The SPREAD is the interesting part; a mean hides a 25x. */
  blobMinBytes: number;
  blobMaxBytes: number;
  /**
   * Live texels x 8 — what the resident glyph data actually occupies.
   *
   * The number to compare against a baked atlas's OCCUPIED bytes, and NOT the one to put beside
   * `hb-atlas`'s 1.45 MiB. See {@link reservationBytes}.
   */
  atlasBytes: number;
  /**
   * `4096 x rows x 8` — the whole texture, which is what the driver allocates.
   *
   * THIS is the number that sits beside `hb-atlas`'s `atlasBytes`, because `hb-atlas`'s figure is
   * also a whole-texture allocation (its pages are only as tall as the shelves reached). Reported
   * as a separate key from {@link atlasBytes} rather than instead of it, because quoting only the
   * smaller of the two is exactly how a renderer appears to cost less than it does.
   */
  reservationBytes: number;
  /** Live texels over capacity — the bridge between the two byte figures above. */
  occupancy: number;
  /**
   * ms spent in `hb_gpu_draw_encode`, and NOTHING ELSE.
   *
   * SPLIT FROM {@link programMs} BECAUSE THE COMBINED NUMBER LIED. With the shader link folded in,
   * this counter went UP (182.8 -> 226.4 ms) when the encode work was HALVED — because what
   * dominated it was the driver blocking on a program link, not the encoder. `hb-atlas`'s `bakeMs`
   * is rasterisation only and excludes its own link, so this is the figure the two arms can be
   * compared on.
   */
  encodeMs: number;
  /** ms to compile and link HarfBuzz's Slug GLSL and allocate the texture. Driver-bound. */
  programMs: number;
  /** ms to upload every blob into the texture, row by row. */
  uploadMs: number;
  /**
   * Bytes of wasm heap this arm holds — ONE module's, because there is only one.
   *
   * Nothing is added to this by the caller any more. The arm shapes and encodes in the same
   * HarfBuzz ({@link shapeRunWithHbGpu}), so each face is resident once; the arrangement this
   * replaces summed hb-gpu's heap with npm `harfbuzzjs`'s and counted every face twice.
   */
  wasmHeapBytes: number;
}

/**
 * One drawing pass over the frame's runs.
 *
 * `"outline"` is the dilated copy in the outline colour and goes down FIRST; `"fill"` is the
 * spread-0 copy in the fill colour and covers it. Reversing them paints the outline over the glyph
 * and reads as a bolder, muddier font rather than as an error.
 */
export type HbGpuTextPass = "outline" | "fill";

/**
 * S9's outline colour, STRAIGHT rgba — and it is deliberately neither black nor the fill's white.
 *
 * THE PRESENCE GUARD IS WHY. The harness's page background is `#101014` and `nonEmptyRatio` counts
 * pixels that differ from it, so a black outline on this page would cost every one of its taps and
 * move that ratio by almost nothing: an outline pass that silently drew nothing would look the same
 * in the guard as one that worked. In this colour the ratio rises with `outlinePx`, which makes
 * "the second pass reached the screen" a number in the report rather than an assumption. The fill
 * is opaque and drawn second, so the sampled ink centres stay white and `sampleHits` is untouched.
 *
 * The taps are colour-blind — the shader does the same work whatever `u_color` holds — so this
 * choice buys the evidence and costs nothing that is being measured.
 *
 * IT IS THE DEFAULT OF {@link HbGpuTextOptions.outlineColor} RATHER THAN THE ONLY VALUE, since the
 * A1 crossover probe. That probe draws the PRODUCT's own palette (light ink over a black outline
 * over a dark card) because the defect it grades is stated in bytes at those colours — and the
 * argument above is an argument about S9's page, not a property of the arm. Omitting the option
 * leaves S9 byte-identical.
 */
const OUTLINE_COLOR: readonly [number, number, number, number] = [
  1, 0.35, 0.1, 1,
];

/** {@link HbGpuTextOptions.fillColor}'s default: opaque white, S9's fill since the arm existed. */
const FILL_COLOR: readonly [number, number, number, number] = [1, 1, 1, 1];

export interface HbGpuTextArm {
  readonly renderer: HbGpuRenderer;
  /**
   * The arm's own canvas, so a caller that empties its stage between frames can re-attach it.
   *
   * Mirrors `AtlasRenderer.canvas` and exists for the same reason: the fidelity probe clears the
   * stage between offsets, and creating a fresh WebGL2 context each time would exhaust the
   * browser's ~16-context limit halfway through an eight-offset sweep.
   */
  readonly canvas: HTMLCanvasElement;
  readonly stats: HbGpuTextStats;
  /**
   * The passes this frame is made of, in the order they must be drawn.
   *
   * `["fill"]` with no outline, `["outline", "fill"]` with one. Published as a list rather than as
   * a boolean so the caller's loop IS the order — a caller cannot draw the fill first, and a caller
   * that forgets the outline entirely is not expressible.
   */
  readonly passes: readonly HbGpuTextPass[];
  /**
   * The dilation radius the outline pass sets, in OBJECT units — which in this arm are device px.
   *
   * `outlinePx / 2 * dpr`. 0 when there is no outline pass, and the two are consistent by
   * construction: {@link passes} is derived from this number.
   */
  readonly spreadPx: number;
  /**
   * Start one pass. `"fill"` is the default so the fill-only callers (the fidelity probe) are
   * unchanged.
   *
   * Sets the pass's spread and colour, both of which hb-gpu carries as sticky uniforms — see
   * `HbGpuRenderer.setSpread`. Stated unconditionally on every pass, including the fill's 0, so it
   * is the pass and not the call order that decides how fat the glyphs come out.
   */
  begin(pass?: HbGpuTextPass): void;
  /**
   * Queue one run's glyphs, its un-rotated box centred at `centreX`/`centreY` in CSS px.
   *
   * The same signature as `drawGlyphCells`, and for the same reason: the two arms are called from
   * the same loop in S9 and from the same loop in the fidelity probe, so a caller cannot give one
   * of them a different centre than the other.
   */
  push(
    glyphs: readonly ShapedGlyph[],
    centreX: number,
    centreY: number,
    layout: RunLayout,
  ): void;
  /**
   * Submit this pass.
   *
   * `inkless` is the glyphs this PASS declined to draw because they have no ink — spaces. It is
   * returned rather than left implicit because it is the whole of the gap between `glyphsPerFrame`
   * and `quadsPerFrame`, and an unexplained gap of 140 in the table reads as 140 DROPPED glyphs.
   * `hb-atlas` emits a (degenerate) quad for these; this arm does not, which is strictly less work
   * and is why the two arms' `quadsPerFrame` are not the same number for the same scene. With two
   * passes both sides of that gap double, which is why `passesPerFrame` is in the table beside it.
   *
   * ONLY THE FIRST PASS CLEARS. A clear before the fill pass would erase the outline that had just
   * been drawn and leave exactly the un-outlined picture — while every counter still reported two
   * passes and the full tap cost. The picture would be wrong and the numbers would be right, which
   * is the failure mode with no symptom.
   */
  end(): { instances: number; drawCalls: number; inkless: number };
  dispose(): void;
}

export interface HbGpuTextOptions {
  container: HTMLElement;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  /** CSS px per em — the run's font size. */
  fontSize: number;
  /** Rotation for EVERY run of the frame. One matrix, one angle: see {@link HbGpuTextArm.push}. */
  radians: number;
  /**
   * The consumer's `strokeText` lineWidth, in DESIGN px. `0` (the default) is fill only, and is
   * byte-for-byte the frame this arm was measured with before an outline existed.
   *
   * THE RADIUS IS HALF IT, AND THE HALVING IS THE CALLER'S. A centred stroke of width `W` reaches
   * `W / 2` outward, and `HbGpuRenderer.setSpread` takes the reach rather than the width precisely
   * because only the caller knows whether its stroke is centred, inner or outer — this one is
   * matching a centred `ctx.strokeText`, which is what the downstream consumer draws.
   *
   * AND IT IS SCALED BY THE DEVICE-PIXEL RATIO, because this arm's object space IS device pixels.
   * A 6 design-px stroke on a dpr 3.49 phone really does cover 21 device px, and the shader picks
   * its tap count from the DEVICE radius — so a design-px spread passed through unscaled would
   * under-report the phone's cost by the ratio itself, which is the whole quantity in question.
   */
  outlinePx?: number;
  /**
   * The contrast curve the renderer applies to final coverage. Defaults to
   * {@link HB_GPU_CONTRAST_NONE} — which is what this file hardcoded before the option existed, so
   * omitting it leaves S9 and the fidelity probe byte-identical.
   *
   * THE LEVER EXISTS BECAUSE THE SHIPPED CONSUMER IS ON THE OTHER SETTING. `createHbGpuRenderer`
   * defaults to {@link HB_GPU_CONTRAST_DEFAULT}, i.e. stem darkening ON, and every product that
   * mounts `packages/canvas`'s glyph pass gets that. This arm asked for NONE so that a distortion
   * measured against an 8x area-coverage reference is a statement about the RASTERIZER (see the
   * block at the `contrast:` call site below), and that is still the right default here. But it
   * means a crossover sweep that only ever measured NONE would not be measuring the picture the
   * user is looking at: stem darkening moves partially covered fragments, which is exactly where
   * an interior-uniformity or edge-width reading lives. The A1 probe therefore sweeps BOTH and
   * reports which one each table was taken at.
   */
  contrast?: HbGpuContrast;
  /**
   * The fill pass's colour, STRAIGHT rgba. Defaults to opaque white — S9's fill.
   *
   * A measurement arm's colour is not cosmetic: `interiorUniformity` is a statement in BYTES about
   * a specific fill, and a probe grading the product's `#ffedc8` over black has to draw that fill
   * rather than white and rescale afterwards. Straight, not premultiplied — the shader multiplies.
   */
  fillColor?: readonly [number, number, number, number];
  /**
   * The outline pass's colour, STRAIGHT rgba. Defaults to {@link OUTLINE_COLOR}, S9's own.
   *
   * Unread when there is no outline pass, exactly as `outlinePx: 0` implies.
   */
  outlineColor?: readonly [number, number, number, number];
  /** The wasm module: the renderer reads HarfBuzz's own GLSL out of it, and its heap is a cost. */
  module: HbGpu;
  /** hb-gpu fonts by face id, matching the face ids the shaper's keys carry. */
  fonts: ReadonlyMap<string, HbGpuFont>;
  /** Every glyph key the frame can draw, so the atlas is sized for the whole working set at once. */
  keys: Iterable<string>;
}

/**
 * Encode every distinct glyph, size a texture that exactly holds them, upload, and hand back a
 * renderer that draws runs in the same place every other arm does.
 *
 * THE ATLAS IS SIZED FROM THE ENCODED TOTAL, not from a default. `createHbGpuRenderer`'s own
 * default is 256 rows = 8 MiB, which is ~6x this workload — and an arm whose VRAM figure is mostly
 * a constant somebody picked is not reporting the mechanism's cost. Everything is encoded before
 * the texture exists precisely so the reservation can be the smallest one that fits, which makes
 * {@link HbGpuTextStats.reservationBytes} a property of Slug and this pool rather than of this file.
 *
 * That also makes the ring allocator's eviction path unreachable here, which is the point: the
 * whole working set is known before the texture exists, so no frame can ever ask for a glyph that
 * was evicted. `packages/hb-gpu/test` is where eviction is exercised.
 */
export function createHbGpuText(options: HbGpuTextOptions): HbGpuTextArm {
  const { container, cssWidth, cssHeight, dpr, fonts } = options;
  const startedAt = performance.now();

  // ENCODED ONCE, AND THE STATISTICS COME OFF THE BLOBS THAT ARE ACTUALLY UPLOADED.
  //
  // The obvious shape — `measureBlobBytes` to size the texture, then encode again to fill it — puts
  // every outline through `hb_gpu_draw_encode` TWICE. Reporting an arm's startup cost as double what
  // it is misrepresents it just as surely as halving it would.
  //
  // Holding the blobs instead costs one copy of the encoded set (1.3 MB on this workload, freed as
  // soon as the uploads are done) and buys a property the two-pass version only appeared to have:
  // `blobBytes` is definitionally the bytes that went into the texture, so `blobBytes ===
  // atlasBytes` is a structural identity rather than a coincidence that happened to hold. That
  // identity is worth having — it is the check that would catch an upload silently dropping a glyph.
  const encoded = new Map<
    string,
    EncodedGlyph & { faceId: string; glyphId: number }
  >();
  let blobBytes = 0;
  let blobMinBytes = Number.POSITIVE_INFINITY;
  let blobMaxBytes = 0;
  for (const key of options.keys) {
    if (encoded.has(key)) continue;
    const gid = harfbuzzGlyphIdOf(key);
    if (gid === null) {
      throw new Error(
        `text-gpu: glyph key "${key}" carries no HarfBuzz glyph id — the hb-gpu arm encodes outlines by gid and cannot draw this run`,
      );
    }
    const faceId = faceIdOf(key);
    const font = fontFor(fonts, faceId);
    const glyph = font.encode(gid);
    if (!glyph) {
      throw new Error(
        `text-gpu: hb_gpu_draw_encode failed for glyph "${key}" — an arm that skipped it would draw a run with a hole in it and report as cheap`,
      );
    }
    // THE FACE TRAVELS WITH THE GLYPH ID NOW, and the `upem` no longer does. Namespacing moved one
    // layer down in Phase 1A: `HbGpuRenderer.registerFace` owns it, so `upload` is handed a face
    // handle plus a raw gid and the renderer builds the key. What used to be enforced by this
    // file's key format — that Noto Sans SC's gid 97 and Roboto's gid 97 are different outlines —
    // is now enforced by the thing that owns the atlas, where every consumer gets it.
    encoded.set(key, { ...glyph, faceId, glyphId: gid });
    // A zero-length blob is a glyph with no ink (a space) — a legitimate result, and NOT something
    // to count as an encoded glyph or reserve texels for.
    if (glyph.texels.length === 0) continue;
    blobBytes += glyph.texels.length;
    blobMinBytes = Math.min(blobMinBytes, glyph.texels.length);
    blobMaxBytes = Math.max(blobMaxBytes, glyph.texels.length);
  }
  if (blobBytes === 0) {
    throw new Error(
      "text-gpu: the encoder produced no inked glyph for any of this scenario's runs — a blank page is the one result that scores well on every other column",
    );
  }
  // OUTLINE ENCODING ONLY — no GL of any kind has happened yet. This is the number that stands
  // beside `hb-atlas`'s `bakeMs`, because that one is rasterisation only.
  const encodeMs = performance.now() - startedAt;

  // Exactly the texels the measured blobs need. The bump allocator lays allocations down end to
  // end with no per-glyph padding, so this is a tight fit rather than an estimate — and a tight fit
  // is what makes the reported reservation honest. Handed in TEXELS and rounded up to whole rows by
  // the renderer, which is the only thing that knows how wide its atlas came out: 4096 is a
  // preference, not a guarantee (WebGL2 promises only 2048), and rounding to 4096 here would
  // over-reserve on a device that clamped.
  const atlasTexels = blobBytes / 8;

  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  // CSS size is the stage; the backing store is device pixels, so design space IS device pixels —
  // which `hb_gpu_dilate` requires, because it is handed the framebuffer size as `u_viewport`.
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  container.appendChild(canvas);

  // THE STAGE IS THIS FILE'S NOW, and it has to be. `@godot-scene-web/hb-gpu` borrows a context and
  // never opens one — the dependency runs `canvas -> hb-gpu`, so hb-gpu cannot import
  // `createCanvasStage`. Creating it HERE rather than calling `getContext` by hand is what keeps
  // this arm comparable with the baked ones: `STAGE_CONTEXT_ATTRIBUTES` is one declaration of
  // `premultipliedAlpha: true` / `antialias: false` / `preserveDrawingBuffer: false`, and hb-gpu's
  // fragment writes premultiplied coverage that a straight-alpha canvas would composite twice —
  // silently, as a merely darker picture.
  const deviceWidth = Math.round(cssWidth * dpr);
  const deviceHeight = Math.round(cssHeight * dpr);
  let renderer: HbGpuRenderer | null = null;
  const createdStage = createCanvasStage({
    canvas,
    designWidth: deviceWidth,
    designHeight: deviceHeight,
    // The lifecycle hb-gpu no longer owns. Without this pair a lost context leaves the renderer
    // drawing into dead objects forever: permanently blank text, no signal, no rebuild.
    onContextLost: () => renderer?.notifyContextLost(),
    onContextRestored: () => {
      renderer?.rebuild();
    },
  });
  if (!createdStage) {
    throw new Error(
      "text-gpu: no WebGL2 context for the hb-gpu arm — a silently skipped arm reports as a cheap one",
    );
  }
  // Aliased to a non-nullable const because the arm's `end`/`dispose` close over it, and a
  // narrowing that has to survive into a closure is one TypeScript will not always carry.
  const stage: CanvasStage = createdStage;
  stage.setStageSize(deviceWidth, deviceHeight);

  // THE PROGRAM IS TIMED SEPARATELY, and finding out why is what made this split necessary.
  // Folding it into `encodeMs` produced a counter that went UP (182.8 -> 226.4 ms) when the encode
  // work was HALVED, because what dominates it is not encoding at all: `createHbGpuRenderer`
  // compiles and links HarfBuzz's Slug GLSL, and reading a link status blocks on the driver.
  // `hb-atlas`'s `bakeMs` excludes its own program link for the same reason, so a comparison
  // between the two is only meaningful once this is out of `encodeMs`.
  const programStartedAt = performance.now();
  // COLLECTED AND THEN THROWN, because this is a measurement arm. `createHbGpuRenderer` returns
  // `null` so a shipping consumer can fall back to a DOM path; an arm that fell back would report
  // a number for a mechanism that never ran, so here the reasons become the message of a throw.
  const failures: HbGpuFailure[] = [];
  renderer = createHbGpuRenderer(options.module, {
    gl: stage.gl,
    // DESIGN SPACE IS DEVICE PIXELS IN THIS ARM, on purpose: the stage above was created with
    // `designWidth: deviceWidth`, so the two pairs below are the same numbers and the frame is the
    // one this arm won the round with. They are passed separately anyway, because they are two
    // different things the moment a consumer scales its stage by a device-pixel ratio — the design
    // pair builds the projection, the framebuffer pair is `u_viewport`.
    designWidth: deviceWidth,
    designHeight: deviceHeight,
    // THE ACHIEVED buffer, not the requested one: setting `canvas.width` only asks, and
    // `u_viewport` is what the half-pixel dilation is measured against.
    framebufferWidth: stage.projection().framebufferWidth,
    framebufferHeight: stage.projection().framebufferHeight,
    atlasTexels,
    // OFF, EXPLICITLY, AND THIS ARM IS THE EXCEPTION RATHER THAN THE RULE. `createHbGpuRenderer`
    // ships stem darkening ON because every shipping consumer wants legible text; a fidelity probe
    // is not a consumer. `probes/text-fidelity.ts` grades this arm against an 8x area-coverage
    // reference and reports `distortion = |1 - acutance/reference|` — the documented 0.196 (Han,
    // ppem 14) and 0.017 (ppem 49) in `docs/text-rendering.md` are statements about what evaluating
    // Slug coverage costs in sharpness, and they only mean that against RAW coverage. An arm
    // carrying a contrast curve would be scoring the curve: stem darkening moves the ink and the
    // gradient sum together, so it lands in the acutance ratio directly and would read as the
    // rasterizer having got better or worse when nothing about the rasterizer changed.
    //
    // The frame-cost columns want it off too, for a smaller reason: the correction is one `pow` on
    // partially covered fragments, and a cost table that quietly included it could not be compared
    // with the rows already recorded.
    //
    // IT IS A DEFAULTED OPTION NOW, NOT A CONSTANT — see {@link HbGpuTextOptions.contrast}. The
    // argument above is why the DEFAULT is still NONE and why S9 and the fidelity probe must not
    // pass anything else. The A1 crossover probe passes `HB_GPU_CONTRAST_DEFAULT` on a second run
    // precisely because the shipped consumer gets that, and a sweep of only this setting would be
    // grading a frame no user sees.
    contrast: options.contrast ?? HB_GPU_CONTRAST_NONE,
    onError: (failure) => failures.push(failure),
  });
  if (!renderer) {
    throw new Error(
      `text-gpu: the hb-gpu renderer refused to construct — ${failures.map((f) => `${f.reason}: ${f.message}`).join("; ") || "(no reason reported)"}`,
    );
  }
  const gpuRenderer = renderer;
  const programMs = performance.now() - programStartedAt;

  const uploadStartedAt = performance.now();
  const slots = new Map<string, GlyphSlot | null>();
  // ONE REGISTRATION PER FACE, and the handle is what makes a key unambiguous — see the note on
  // `encoded` above.
  const faceHandles = new Map<string, HbGpuFace>();
  const faceHandleFor = (faceId: string): HbGpuFace => {
    const cached = faceHandles.get(faceId);
    if (cached) return cached;
    const handle = gpuRenderer.registerFace(fontFor(fonts, faceId), faceId);
    if (!handle) {
      throw new Error(
        `text-gpu: the hb-gpu renderer refused face "${faceId}" — ${failures.map((f) => f.message).join("; ") || "(no reason reported)"}`,
      );
    }
    faceHandles.set(faceId, handle);
    return handle;
  };
  for (const [key, glyph] of encoded) {
    // `null` back from `upload` for an inkless glyph: a legitimate result, and NOT an allocation.
    // Recorded so the draw loop skips it without asking the encoder again.
    slots.set(
      key,
      gpuRenderer.upload(faceHandleFor(glyph.faceId), glyph.glyphId, glyph),
    );
  }
  // The encoded set has served its purpose; the texels live in VRAM from here on. Dropped rather
  // than retained so the arm is not charged for a second resident copy of its own glyph data in
  // every memory reading the harness takes after this point.
  const glyphs = [...encoded.values()].filter(
    (glyph) => glyph.texels.length > 0,
  ).length;
  encoded.clear();
  const uploadMs = performance.now() - uploadStartedAt;

  const atlas = gpuRenderer.atlas;
  // THE CROSS-CHECK the single-pass encode makes possible: every byte encoded is a byte resident.
  // A mismatch means `upload` dropped a glyph — which draws a run with a hole in it and reports as
  // a cheap arm, so it is caught here rather than looked at in a screenshot.
  if (atlas.liveBytes !== blobBytes) {
    throw new Error(
      `text-gpu: encoded ${blobBytes} B of glyph data but the atlas holds ${atlas.liveBytes} B — an upload was dropped or evicted, and the runs that need it would draw with holes`,
    );
  }
  const stats: HbGpuTextStats = {
    glyphs,
    blobBytes,
    blobMinBytes,
    blobMaxBytes,
    atlasBytes: atlas.liveBytes,
    reservationBytes: atlas.reservationBytes,
    occupancy:
      atlas.capacityTexels > 0 ? atlas.liveTexels / atlas.capacityTexels : 0,
    encodeMs,
    programMs,
    uploadMs,
    // Read AFTER the fonts were created and every glyph encoded, so it reports the heap the module
    // really grew to — face copies and encoder scratch included — rather than its initial
    // reservation. `build.sh` asks for 2 MiB precisely so this number is a measurement.
    wasmHeapBytes: options.module.heapBytes,
  };

  const cos = Math.cos(options.radians);
  const sin = Math.sin(options.radians);
  const pixelsPerEm = options.fontSize * dpr;
  // The frame's ONE model: a rotation about object-space (0, 0), in the repo's `Transform2D` order
  // (`[xx, xy, yx, yy, tx, ty]`, so `x' = cos*x - sin*y`). Identical to the rotation
  // `drawGlyphCells` applies by hand, and to `modelFor` in the package's own pixel test.
  gpuRenderer.setModel([cos, sin, -sin, cos, 0, 0]);
  const fillColor = options.fillColor ?? FILL_COLOR;
  const outlineColor = options.outlineColor ?? OUTLINE_COLOR;
  gpuRenderer.setColor(...fillColor);

  // DESIGN PX IN, DEVICE PX OUT — see {@link HbGpuTextOptions.outlinePx} for why the ratio belongs
  // here. Negative and non-finite values never reach this line: `textOutlineParamRefusal` rejects
  // them at mount rather than letting `setSpread`'s silent clamp turn them into a plain fill.
  const outlinePx = options.outlinePx ?? 0;
  const spreadPx = outlinePx > 0 ? (outlinePx / 2) * dpr : 0;
  const passes: readonly HbGpuTextPass[] =
    spreadPx > 0 ? ["outline", "fill"] : ["fill"];

  let inklessThisFrame = 0;
  let currentPass: HbGpuTextPass = passes[0];

  return {
    renderer: gpuRenderer,
    canvas,
    stats,
    passes,
    spreadPx,

    begin(pass = "fill") {
      currentPass = pass;
      inklessThisFrame = 0;
      // BOTH STATED EVERY PASS, INCLUDING THE FILL'S 0 AND ITS OWN COLOUR. hb-gpu's spread and colour are
      // sticky — `begin` on the renderer does not clear them — so a fill pass that only set its
      // colour would inherit the outline's spread and draw the whole scene fat, which reads as a
      // font-weight bug rather than as a missing call. `packages/canvas`'s glyph pass states its
      // spread per run for exactly this reason.
      if (pass === "outline") {
        gpuRenderer.setSpread(spreadPx);
        gpuRenderer.setColor(...outlineColor);
      } else {
        gpuRenderer.setSpread(0);
        gpuRenderer.setColor(...fillColor);
      }
      gpuRenderer.begin();
    },

    push(glyphList, centreX, centreY, layout) {
      // ONE ROTATION PER FRAME, and it is checked. The model matrix is set once, so a run asking to
      // be drawn at a different angle would be drawn at the frame's angle instead — same glyphs,
      // same place, silently wrong orientation, which no counter in the table would notice.
      if (Math.abs(layout.radians - options.radians) > 1e-9) {
        throw new Error(
          `text-gpu: this frame's model rotates by ${options.radians} rad but a run asked for ${layout.radians} — hb-gpu draws every run through ONE matrix so that \`hb_gpu_dilate\` sees the same transform the quad does`,
        );
      }
      for (const glyph of glyphList) {
        const slot = slots.get(glyph.key);
        // No ink — a space. A zero-length blob is not an allocation, and drawing it would be a
        // degenerate quad reading texel 0, which is some other glyph's header.
        if (!slot) {
          inklessThisFrame += 1;
          continue;
        }
        const at = hbGpuObjectOrigin(glyph.penPx, layout, centreX, centreY);
        gpuRenderer.push(slot, at.x, at.y, pixelsPerEm);
      }
    },

    end() {
      // THE VIEWPORT AND THE CLEAR ARE THIS FILE'S NOW. Both used to be the first two statements of
      // `HbGpuRenderer.end`, and both are wrong in a context the renderer does not own — a clear
      // inside a glyph pass erases whatever the embedder already drew. They are done here, in this
      // order, immediately before the pass, so the frame is byte-identical to the one this arm won
      // the round with: viewport over the whole drawing buffer, then a transparent clear, then the
      // draw. `HbGpuRenderer.end` documents exactly what it leaves dirty in return.
      stage.applyViewport();
      // THE CLEAR IS THE FRAME'S, NOT THE PASS'S — see {@link HbGpuTextArm.end}. At `outlinePx=0`
      // there is one pass and it is the first, so this is the same single clear as before.
      if (currentPass === passes[0]) {
        stage.gl.clearColor(0, 0, 0, 0);
        stage.gl.clear(stage.gl.COLOR_BUFFER_BIT);
      }
      return { ...gpuRenderer.end(), inkless: inklessThisFrame };
    },

    dispose() {
      gpuRenderer.dispose();
      // The renderer deletes its own GL objects and nothing else — the context, the canvas and the
      // context-loss listeners were never its to free.
      stage.dispose();
      canvas.remove();
    },
  };
}

function fontFor(
  fonts: ReadonlyMap<string, HbGpuFont>,
  faceId: string,
): HbGpuFont {
  const font = fonts.get(faceId);
  if (!font) {
    throw new Error(
      `text-gpu: no hb-gpu font for face "${faceId}" (have: ${[...fonts.keys()].join(", ")}) — its glyphs would silently not be drawn, which reads as a cheap, crisp arm`,
    );
  }
  return font;
}

/**
 * One `HbGpuFont` per face — the arm's shaper AND its encoder, from one copy of each face.
 *
 * ONE FONT OBJECT DOES BOTH JOBS NOW, which is what removed a whole class of mismatch rather than
 * merely making it unlikely. The glyph ids come from `shape` and the outlines from `encode` on the
 * SAME `hb_font_t` over the SAME bytes, so gid 97 cannot mean one outline to the shaper and another
 * to the encoder. Under the arrangement this replaces the ids came out of npm `harfbuzzjs` reading
 * one copy of the face and the outlines out of HarfBuzz 14.4.0 inside this wasm reading another,
 * and handing those two different files would have rendered fluent, crisp, WRONG text.
 *
 * The face-qualified keys are still load-bearing for the other half of that failure — Roboto's gid
 * 97 and Noto Sans SC's gid 97 are unrelated outlines in one atlas. See `GLYPH_KEY_SEPARATOR`.
 */
export function createHbGpuFonts(
  module: HbGpu,
  bytesByFace: ReadonlyMap<string, ArrayBuffer>,
): Map<string, HbGpuFont> {
  const fonts = new Map<string, HbGpuFont>();
  for (const [faceId, bytes] of bytesByFace) {
    // `createFont` is construct-or-null since Phase 1B; `loadHbGpuModule`'s `onError` normally
    // turns a refusal into a throw carrying the reason, so reaching this line means a refusal with
    // no reason at all — still a face that cannot be drawn, still louder than a blank page.
    const font = module.createFont(new Uint8Array(bytes));
    if (!font) {
      throw new Error(
        `text-gpu: hb-gpu declined face "${faceId}" (${bytes.byteLength} B) — its glyphs would silently not be drawn, which reads as a cheap, crisp arm`,
      );
    }
    fonts.set(faceId, font);
  }
  return fonts;
}
