// The glyph pass this package ships: `GlyphPass` over `@godot-scene-web/hb-gpu`.
//
// NOT ON THE MAIN BARREL, AND THAT IS THE FIRST THING TO KNOW ABOUT THIS FILE. It is reached
// through the `./glyphs` subpath (`@godot-scene-web/canvas/glyphs`) for two reasons that both cost
// something real: the main barrel's export list is mirrored by hand-maintained ambient `.d.ts`
// files in `../sts2-couch-coop` and `../spirectl` (see `AGENTS.md`), so every name on it is work
// downstream every time it moves; and a scene with no text should not pull a glyph renderer, its
// wasm and a multi-MiB atlas into the bundle to draw rectangles.
//
// WHAT THIS FILE OWNS: THE ATLAS IDENTITY THE DRAW LIST'S SLOT IDS REFER TO. `GlyphsView.slots` is
// a run of INTEGERS, not atlas offsets, because an atlas evicts and a retained draw list outlives
// its evictions — recording an offset is how you get a different glyph's outline drawn at the right
// size, in the right place, perfectly antialiased. The indirection has to be resolved by whoever
// owns the atlas, which is this file: it hands out dense ids from `slotFor`, and at draw time turns
// each one back into a live `GlyphSlot` through `HbGpuRenderer.resolve`, re-encoding and
// re-uploading ONLY on a miss.
//
// SHAPING IS OPTIONAL HERE, AND WHEN IT HAPPENS IT HAPPENS IN THE SAME MODULE. The contract is a
// glyph id and a pen position, so a caller that already has them from anywhere can fill a
// `GlyphsView` itself. But {@link HbGpuGlyphPass.fillRun} shapes a string through the SAME
// `HbGpuFont` this pass encodes outlines from, which is what lets a page hold one HarfBuzz instead
// of adding npm `harfbuzzjs` as a second build with the same faces in a second heap — measured at
// 4.50 MiB against 2.00 for the perf harness's own arm (`docs/text-rendering.md`). It also removes
// a class of mismatch rather than making it unlikely: one `hb_font_t` cannot disagree with itself
// about what gid 97 means.
//
// FILL AND OUTLINE, AND THE OUTLINE IS THE CALLER'S SECOND RUN. `GlyphsView.spreadPx` grows every
// glyph of a run outward before filling it, so an outlined label is the same glyphs and pens
// recorded TWICE — outline colour with a spread, then fill colour without, in that order. This pass
// does not synthesise the pair: the kind carries one colour, and a command that quietly expanded to
// two draws would hide the ordering, which is the half a caller has to get right. What the pass
// does own is that the dilation happens INSIDE one fragment shader (`HbGpuRenderer.setSpread`)
// rather than as N offset copies of the run, which is the only way a TRANSLUCENT outline
// composites once instead of N times.
//
// THE FIDELITY CAVEAT SHIPS WITH THE API, because it is measured and it is a constraint rather
// than a bug: HarfBuzz's coverage shader takes a five-tap MSAA branch below ppem 16
// (`src/hb-gpu-fragment.glsl:321`, `if (ppem < 16.0)`). Graded against an 8x-downsampled
// reference, this path's distortion is 0.196 on Han at ppem 14 — BLURRIER than the shipped DOM
// path's 0.132 — and 0.017 at ppem 49 (a phone rendering 14 px at DPR 3.5). So: use it when
// `pixelsPerEm * the scale in run.m * devicePixelRatio >= 16`, and below that a baked atlas or the
// DOM path is crisper. THE MIDDLE FACTOR IS NOT DECORATION: a caller that scales a label through
// its model matrix — which is where scale belongs, next to the rotation — is drawing at a ppem its
// `pixelsPerEm` never mentions, and the shader gates on what it actually gets.
// See {@link PPEM_FIDELITY_FLOOR} and `docs/text-rendering.md`.
//
// AND THE OTHER FIDELITY KNOB IS THE CONTRAST CURVE, WHICH IS NOT THE SAME QUESTION. The floor
// above is about a size this path should not be asked to draw; {@link HbGpuGlyphPassOptions.contrast}
// is about how it draws every size it does take. hb-gpu ships stem darkening ON, which is right
// against the DOM text path and wrong against Godot — the A1 crossover sweep puts this path BEHIND
// canvas2d at ppem 16 with the curve and ahead of every arm at every swept size without it. A
// consumer mirroring a Godot scene passes `HB_GPU_CONTRAST_NONE`; omitting the option keeps the
// shipped default, and therefore keeps every existing picture.

import type {
  EncodedGlyph,
  HbGpu,
  HbGpuFailure,
  HbGpuFont,
  HbGpuShapeOptions,
} from "@godot-scene-web/hb-gpu";
import {
  createHbGpuRenderer,
  type GlyphSlot,
  type HbGpuContrast,
  type HbGpuFace,
  type HbGpuRenderer,
} from "@godot-scene-web/hb-gpu/webgl";
import type { GlyphsView } from "./draw-list";
import type { GlyphPass } from "./glyph-pass";
import { type CachedShapeData, GlyphShapeCache } from "./glyph-shape-cache";
import type { StageProjection } from "./present";

/**
 * Below this ppem the outline path is measurably blurrier than the alternatives.
 *
 * `ppem` here is `GlyphsView.pixelsPerEm` times the scale in `GlyphsView.m` times the device-pixel
 * ratio — the size in DEVICE pixels, which is the only size the shader can see, and it sees all
 * three factors (it derives ppem from `fwidth`). The number is HarfBuzz's own branch point, not a
 * threshold chosen here: `hb_gpu_draw` switches to a five-tap MSAA approximation under it.
 */
export const PPEM_FIDELITY_FLOOR = 16;

/**
 * The id `slotFor` returns for a glyph with no ink, or one the atlas declined.
 *
 * Write it into `GlyphsView.slots` and the pass skips the glyph. It is a distinct value ON PURPOSE:
 * a caller that wrote a real-looking id for a space would get a degenerate quad reading texel 0,
 * which is some other glyph's header.
 */
export const GLYPH_SLOT_NONE = -1;

/**
 * A face registered with the pass: the handle `slotFor` takes.
 *
 * It pairs the ENCODER (`HbGpuFont`, which turns a glyph id into an outline blob) with the atlas
 * FACE handle that namespaces that glyph id, because the two must not drift: glyph 42 of Noto Sans
 * SC and glyph 42 of Roboto are unrelated outlines, and an atlas that cannot tell them apart
 * renders fluent, crisp, wrong text.
 */
export interface GlyphFace {
  readonly font: HbGpuFont;
  readonly face: HbGpuFace;
  /** Units per em. The scale `GlyphsView.pixelsPerEm` is measured against. */
  readonly upem: number;
  readonly label: string;
}

export interface HbGpuGlyphPassStats {
  /** Distinct `(face, glyph)` pairs that have ever been given an id. */
  slots: number;
  /** Runs drawn. */
  runs: number;
  /** Glyphs the renderer reported drawing, summed over runs. */
  glyphs: number;
  /** Glyphs skipped because their slot id was {@link GLYPH_SLOT_NONE} — spaces, mostly. */
  inkless: number;
  /**
   * Glyphs whose slot id resolved to nothing and had to be encoded and uploaded again.
   *
   * THE COUNTER THAT SAYS THE ATLAS IS TOO SMALL. Non-zero once, on a cold list, is the mechanism
   * working. Non-zero every frame means the working set does not fit and every frame is paying an
   * encode — raise `atlasTexels`.
   */
  reuploads: number;
  /**
   * Glyphs the pass could not draw at all: an id it never issued, an encode that failed, or a
   * re-upload the atlas refused. A hole in a word, so it is counted rather than left to a
   * screenshot.
   */
  dropped: number;
  /** Runs whose device ppem was under {@link PPEM_FIDELITY_FLOOR}. See this file's header. */
  runsBelowPpemFloor: number;
  /** Additive shaping-cache counters. */
  shapeHits: number;
  shapeMisses: number;
  shapeEntries: number;
  shapeGlyphs: number;
  shapeEvicted: number;
}

export interface HbGpuGlyphPassOptions {
  /**
   * The context to draw in — the SAME one the executor was given.
   *
   * It must be `premultipliedAlpha: true`, which is what `createCanvasStage` asks for; hb-gpu's
   * fragment writes premultiplied coverage and a straight-alpha canvas composites it twice,
   * silently, as a merely darker picture.
   */
  gl: WebGL2RenderingContext;
  /** An instantiated hb-gpu module. The pass reads HarfBuzz's own GLSL and its encoders out of it. */
  module: HbGpu;
  /**
   * The scene's coordinate extent — `CanvasStage.designWidth`, the space a `GlyphsView` lives in.
   *
   * Only a starting value: `drawRun` takes both sizes from the frame's `StageProjection`, which is
   * the one authority on where design space lands.
   */
  designWidth: number;
  designHeight: number;
  /** The achieved drawing buffer. Defaults to the design pair, i.e. a device-pixel ratio of 1. */
  framebufferWidth?: number;
  framebufferHeight?: number;
  /** Atlas capacity in texels; see `HbGpuRendererOptions.atlasTexels`. */
  atlasTexels?: number;
  /**
   * The contrast curve hb-gpu applies to the coverage it computed. Omit for the renderer's own
   * default, `HB_GPU_CONTRAST_DEFAULT` — stem darkening ON.
   *
   * OMITTING IT IS EXACTLY THE PICTURE THIS PASS DREW BEFORE THE OPTION EXISTED. It is not
   * defaulted here: `undefined` is forwarded as `undefined` and `createHbGpuRenderer` decides, so
   * every existing consumer and every committed pixel golden is byte-identical to before.
   *
   * WHY A GODOT-PARITY CONSUMER PASSES `HB_GPU_CONTRAST_NONE`, AND IT IS MEASURED RATHER THAN
   * PREFERRED. Stem darkening is not a tie-breaker inside this path's quality — it IS the quality
   * crossover against the other text arms. Distortion against an 8x area-coverage reference, swept
   * over ppem 16-52 by `packages/perf-harness/probes/text-crossover.ts`
   * (`pnpm -w run text:crossover -- --hb-contrast default|none`):
   *
   *     ppem 16    default 0.1091    none 0.0258     canvas2d 0.0925
   *     ppem 24    default 0.0537    none 0.0138
   *
   * So the shipped curve LOSES to a plain `ctx.fillText` at 16 and costs this path ~4x its own
   * achievable distortion at 24, while with the curve off hb-gpu wins at every ppem swept, with
   * the tightest edges of any arm. AND GODOT APPLIES NO CURVE OF ITS OWN — its grayscale and MSDF
   * glyph interiors come out byte-uniform — so a consumer whose acceptance test is "does this look
   * like the engine we are mirroring" is holding its text up against a rasterizer that never
   * darkened a stem, and the correction reads as a weight mismatch rather than as contrast.
   *
   * THE DEFAULT STAYS ON, because the case it was measured for is real and is a different case:
   * against the DOM text path, uncorrected coverage is washed out (`HbGpuContrast`'s own doc — DOM
   * puts 66% more pixels in the deep-dark end of one fixed crop). Text that is not standing next
   * to Godot's own output still wants it.
   *
   * IT MOVES EDGES, NOT INK, WHICHEVER WAY YOU SET IT. `hb_gpu_stem_darken` is gated on partial
   * coverage (`cov > 0 && cov < 1`), so a glyph INTERIOR is byte-identical either way and only the
   * ramp at the boundary narrows or widens. The library also ramps the correction off by ppem 48,
   * so display-sized text barely moves and small UI text moves most.
   *
   * IT REACHES THE FILL PASS ONLY, and that is the renderer's rule rather than this pass's: a run
   * drawn with a non-zero `GlyphsView.spreadPx` emits raw coverage whatever this says. An outlined
   * label is therefore already half-uncorrected today — see `HbGpuContrast.stemDarkening`.
   */
  contrast?: HbGpuContrast;
  /** Opt-in expanded hb-gpu records used only by adjacent-run batching. */
  batchAdjacentRuns?: boolean;
  /** Every refusal, from this file and from the renderer under it. */
  onError?(failure: HbGpuFailure): void;
  /**
   * Warn on the console the first time a run is drawn below {@link PPEM_FIDELITY_FLOOR}. Default
   * on.
   *
   * ONCE, not per run: a page of small text would otherwise emit a line per label per frame, and a
   * warning nobody can read is a warning nobody reads. {@link HbGpuGlyphPassStats.runsBelowPpemFloor}
   * keeps the full tally. It is a `console.warn` rather than an `onError` because it is not a
   * refusal — the text IS drawn, and only a measurement says another path would draw it better.
   */
  warnBelowPpemFloor?: boolean;
  /** Maximum cached shaped runs. Zero disables memoisation. Defaults to 512. */
  shapeCacheEntries?: number;
  /** Maximum glyphs retained by shaped-run memoisation. Defaults to entries × 64. */
  shapeCacheGlyphs?: number;
}

export interface HbGpuGlyphPass extends GlyphPass {
  /** The renderer underneath. Exposed for its `atlas` / `blobs` stats. */
  readonly renderer: HbGpuRenderer;
  readonly stats: HbGpuGlyphPassStats;
  /**
   * Register a face from its bytes, or `null` if hb-gpu will not take them.
   *
   * THE SAME BYTES THE SHAPER WAS GIVEN. Glyph ids come out of one HarfBuzz and outlines out of
   * another; two different files make gid 97 two different outlines, and the result is crisp,
   * fluent, wrong text that no counter downstream can see.
   */
  registerFace(bytes: Uint8Array, label?: string): GlyphFace | null;
  /**
   * The stable slot id for one glyph of one face — what a caller writes into `GlyphsView.slots`.
   *
   * Uploads the outline on first use and is a map lookup after that. The id is dense, permanent
   * and survives eviction: it names an entry in THIS pass's table, not a place in the atlas.
   *
   * {@link GLYPH_SLOT_NONE} for a glyph with no ink and for one the atlas refused.
   */
  slotFor(face: GlyphFace, glyphId: number): number;
  /** Glyph id for a code point in `face`, or 0 (`.notdef`). A convenience over `HbGpuFont`. */
  glyphFor(face: GlyphFace, codepoint: number): number;
  /**
   * Shape `text` and fill `run` with the result: slots, pen positions and count. `false` if the
   * shaper refused, leaving `run` untouched.
   *
   * ONE HARFBUZZ, WHICH IS THE WHOLE POINT OF HAVING THIS AT ALL. hb-gpu's wasm exports the
   * OpenType shaper as well as the Slug encoder, so a consumer that calls this loads one HarfBuzz
   * and holds each face once. Shaping elsewhere — npm `harfbuzzjs`, most likely — means a second
   * build, a second heap and the same font bytes resident twice, which measured 4.19 MiB across
   * the pair on a phone (`docs/text-rendering.md`). It is also the configuration in which glyph
   * ids and outlines can come from two DIFFERENT files, and gid 97 meaning two different things is
   * crisp, fluent, wrong text that no counter downstream can see.
   *
   * THE PEN ARITHMETIC LIVES HERE FOR THE SAME REASON IT IS EASY TO GET WRONG. HarfBuzz reports
   * advances and offsets in FONT units, y-UP; `GlyphsView.positions` are design units, y-DOWN,
   * measured from the run's origin. So each is scaled by `run.pixelsPerEm / face.upem` and y is
   * negated, an offset positions its own glyph only, and the advance accumulates after it. Getting
   * the scale or the y sign wrong produces text that looks entirely plausible and is subtly
   * mis-spaced — which is why there is one implementation rather than one per caller.
   *
   * `run.pixelsPerEm` must be set BEFORE the call. Exactly three fields are written — `slots`,
   * `positions` and `glyphCount` — and `run.slots` / `run.positions` are replaced by larger buffers
   * if the run does not fit. Inkless glyphs (a space) are skipped rather than given a slot, so
   * `run.glyphCount` can be smaller than the shaped length.
   *
   * `m`, the colour and `spreadPx` are LEFT ALONE, which is what makes an outlined label one shape
   * and two pushes: shape once, then `pushGlyphs` with the outline colour and a spread, then again
   * with the fill colour and `spreadPx = 0`. Both runs then carry pen positions that came from a
   * single shaping pass and cannot drift apart.
   */
  fillRun(
    run: GlyphsView,
    face: GlyphFace,
    text: string,
    options?: HbGpuShapeOptions,
  ): boolean;
  /** Drop shaped-run memoisation without disturbing faces or atlas residency. */
  clearShapeCache(): void;
  /** Re-state both sizes after the stage resized. See `HbGpuRenderer.setViewport`. */
  setViewport(
    designWidth: number,
    designHeight: number,
    framebufferWidth?: number,
    framebufferHeight?: number,
  ): void;
  /** Forward of `HbGpuRenderer.notifyContextLost` — wire it to the stage's `onContextLost`. */
  notifyContextLost(): void;
  /** Forward of `HbGpuRenderer.rebuild` — wire it to the stage's `onContextRestored`. */
  rebuild(): boolean;
  /** Delete the renderer's GL objects. Does NOT touch the context or the registered fonts. */
  dispose(): void;
}

/** One entry of the pass's slot table: everything needed to put the glyph back after an eviction. */
interface SlotEntry {
  face: GlyphFace;
  glyphId: number;
}

/**
 * Build a glyph pass over a borrowed context, or `null` when the renderer will not build.
 *
 * `null` rather than a throw, following `createCanvasStage` and `createHbGpuRenderer`: a consumer
 * that cannot have the GPU glyph path falls back to its DOM one, and only it knows whether that is
 * acceptable. Pass `onError` to be told why — a pass that declined silently reports as a page with
 * no words on it.
 */
export function createHbGpuGlyphPass(
  options: HbGpuGlyphPassOptions,
): HbGpuGlyphPass | null {
  const report = (failure: HbGpuFailure): void => options.onError?.(failure);
  const rendererOptions = {
    gl: options.gl,
    designWidth: options.designWidth,
    designHeight: options.designHeight,
    framebufferWidth: options.framebufferWidth,
    framebufferHeight: options.framebufferHeight,
    atlasTexels: options.atlasTexels,
    // FORWARDED, NEVER DEFAULTED HERE. `undefined` has to reach `createHbGpuRenderer` as
    // `undefined` so the renderer's own `HB_GPU_CONTRAST_DEFAULT` is the one default in the chain;
    // writing `options.contrast ?? HB_GPU_CONTRAST_DEFAULT` would pin a copy of it that a change
    // on the hb-gpu side could no longer move. See {@link HbGpuGlyphPassOptions.contrast}.
    contrast: options.contrast,
    perInstanceRunState: options.batchAdjacentRuns === true,
    onError: report,
  } as Parameters<typeof createHbGpuRenderer>[1] & {
    perInstanceRunState?: boolean;
  };
  const renderer = createHbGpuRenderer(options.module, rendererOptions);
  if (!renderer) return null;
  // Aliased non-nullable, because TypeScript drops a narrowing across a hoisted function
  // declaration even when the binding is `const` — the same note `hb-gpu`'s own `webgl.ts` carries
  // about its stage.
  const live: HbGpuRenderer = renderer;
  const batchAdjacentRuns = options.batchAdjacentRuns === true;

  // DENSE IDS INTO A TABLE THIS FILE OWNS, not the atlas's offsets. An id is permanent: the entry
  // it names is never removed, only the glyph's atlas residency comes and goes.
  const entries: SlotEntry[] = [];
  const idByFace: Map<number, number>[] = [];
  const faces: GlyphFace[] = [];

  const stats: HbGpuGlyphPassStats = {
    slots: 0,
    runs: 0,
    glyphs: 0,
    inkless: 0,
    reuploads: 0,
    dropped: 0,
    runsBelowPpemFloor: 0,
    shapeHits: 0,
    shapeMisses: 0,
    shapeEntries: 0,
    shapeGlyphs: 0,
    shapeEvicted: 0,
  };
  const shapeCacheEntries = Math.max(0, options.shapeCacheEntries ?? 512);
  const shapeCache = new GlyphShapeCache(
    shapeCacheEntries,
    Math.max(0, options.shapeCacheGlyphs ?? shapeCacheEntries * 64),
    stats,
  );
  let warnedBelowPpemFloor = false;
  // `drawRuns` borrows the existing per-run preparation verbatim, but brackets the whole adjacent
  // sequence with one hb-gpu begin/end. State setters are captured per glyph by hb-gpu, so colour,
  // affine model and spread remain run-local inside the single instanced draw.
  let adjacentBatchOpen = false;

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
   * The slot table, as a plain function rather than only a method.
   *
   * `fillRun` needs it too, and reaching it through `this` would break the moment a caller
   * destructured the pass — a shape the rest of this package supports everywhere else. `live` and
   * not `renderer` because TypeScript will not carry the null narrowing above into a function
   * declaration, which could in principle be called before it.
   */
  function slotIdFor(face: GlyphFace, glyphId: number): number {
    let byGlyph = idByFace[face.face.id];
    if (!byGlyph) {
      byGlyph = new Map();
      idByFace[face.face.id] = byGlyph;
    }
    const cached = byGlyph.get(glyphId);
    if (cached !== undefined) return cached;
    const entry: SlotEntry = { face, glyphId };
    const glyph = encode(entry);
    if (!glyph) return GLYPH_SLOT_NONE;
    // A blank glyph — a space — encodes to a zero-length blob. A legitimate result and NOT an
    // allocation, so it gets no id at all: see {@link GLYPH_SLOT_NONE}.
    if (glyph.texels.length === 0) return GLYPH_SLOT_NONE;
    if (!live.upload(face.face, glyphId, glyph)) return GLYPH_SLOT_NONE;
    const id = entries.length;
    entries.push(entry);
    byGlyph.set(glyphId, id);
    stats.slots = entries.length;
    return id;
  }

  /** Encode one glyph, or say why not. A zero-length blob means "no ink", not "failed". */
  function encode(entry: SlotEntry): EncodedGlyph | null {
    const glyph = entry.face.font.encode(entry.glyphId);
    if (!glyph) {
      report({
        reason: "encoder-unavailable",
        message: `hb-gpu: hb_gpu_draw_encode refused glyph ${entry.glyphId} of face "${entry.face.label}" — the run will be drawn with a hole in it`,
      });
      return null;
    }
    return glyph;
  }

  const pass: HbGpuGlyphPass = {
    renderer,
    stats,

    registerFace(bytes, label) {
      const name = label ?? `face${faces.length}`;
      const font = options.module.createFont(bytes);
      // `createHbGpu`'s own `onError` has already said why, in more detail than this layer knows.
      if (!font) return null;
      const face = renderer.registerFace(font, name);
      if (!face) {
        // The font is this file's now — nothing else has a reference — so a refused registration
        // has to free it or the wasm heap keeps a whole face copy for the life of the module.
        font.destroy();
        return null;
      }
      const registered: GlyphFace = {
        font,
        face,
        upem: face.upem,
        label: name,
      };
      faces.push(registered);
      idByFace[face.id] = new Map();
      return registered;
    },

    glyphFor(face, codepoint) {
      return face.font.glyphFor(codepoint);
    },

    fillRun(run, face, text, shapeOptions) {
      const key = shapeCache.key(text, shapeOptions);
      let cached: CachedShapeData | null =
        key === null ? null : shapeCache.get(face.face.id, key);
      if (!cached) {
        shapeCache.miss();
        const shaped = face.font.shape(text, shapeOptions);
        // `null` is a refusal and `[]` is an empty run — a distinction hb-gpu is careful about.
        if (!shaped) return false;
        const slots = new Int32Array(shaped.length);
        const pen = new Int32Array(shaped.length * 2);
        let penX = 0;
        let penY = 0;
        let count = 0;
        for (const glyph of shaped) {
          const slot = slotIdFor(face, glyph.glyphId);
          if (slot !== GLYPH_SLOT_NONE) {
            slots[count] = slot;
            pen[count * 2] = penX + glyph.xOffset;
            pen[count * 2 + 1] = penY + glyph.yOffset;
            count += 1;
          }
          // Advance every glyph, including an inkless space.
          penX += glyph.xAdvance;
          penY += glyph.yAdvance;
        }
        cached = {
          count,
          slots: slots.slice(0, count),
          pen: pen.slice(0, count * 2),
          advanceX: penX,
          advanceY: penY,
        };
        if (key !== null) shapeCache.put(face.face.id, key, cached);
      }

      if (run.slots.length < cached.count)
        run.slots = new Int32Array(cached.count);
      if (run.positions.length < cached.count * 2)
        run.positions = new Float32Array(cached.count * 2);
      // The cache is font-unit data; scaling it here is the exact same expression as a cold shape.
      const scale = run.pixelsPerEm / face.upem;
      for (let i = 0; i < cached.count; i += 1) {
        run.slots[i] = cached.slots[i]!;
        run.positions[i * 2] = cached.pen[i * 2]! * scale;
        run.positions[i * 2 + 1] = -cached.pen[i * 2 + 1]! * scale;
      }
      run.glyphCount = cached.count;
      return true;
    },

    slotFor: slotIdFor,

    clearShapeCache() {
      shapeCache.clear();
    },

    drawRun(run: GlyphsView, projection: StageProjection) {
      // THE PROJECTION IS THE FRAME'S, NOT THIS PASS'S. The executor's `StageProjection` is the one
      // authority on where design space lands, so both halves are taken from it rather than from
      // whatever this pass was constructed with — a stage that resized between construction and
      // this frame would otherwise draw its text at the old scale, and only its text.
      //
      // Keep the exact design extent alongside the matrix. Recovering it from the
      // float32 clip scale introduces rounding and couples the adapter to its formula.
      const runDesignWidth = projection.designWidth;
      const runDesignHeight = projection.designHeight;
      if (
        runDesignWidth !== designWidth ||
        runDesignHeight !== designHeight ||
        projection.framebufferWidth !== framebufferWidth ||
        projection.framebufferHeight !== framebufferHeight
      ) {
        designWidth = runDesignWidth;
        designHeight = runDesignHeight;
        framebufferWidth = projection.framebufferWidth;
        framebufferHeight = projection.framebufferHeight;
        renderer.setViewport(
          designWidth,
          designHeight,
          framebufferWidth,
          framebufferHeight,
        );
      }

      // THE CPU'S COPY OF A NUMBER THE SHADER COMPUTES FOR ITSELF, AND IT HAS TO AGREE WITH IT.
      // `hb_gpu_draw` takes its five-tap branch on the ppem it derives from the fragment's own
      // `fwidth`, so it already sees the full chain: design ppem, the model matrix the caller
      // pushed, and the design->device scale. The number here exists only for GATING AND
      // REPORTING — `stats.runsBelowPpemFloor` and the warning — and a gate that disagrees with
      // the shader it is gating on is worse than no gate: it reports a comfortable size for text
      // the shader is approximating, so the counter reads zero and the warning never fires.
      //
      // THE CALLER OWES THE MODEL MATRIX, AND THE SCALE IS READ BACK OUT OF IT. `run.m` is where a
      // caller's own zoom, fit or hover scale lives (`GlyphsView.m`'s doc says rotation belongs
      // there and never in the pen positions, and a scale rides the same matrix), so the axis
      // lengths of its two basis vectors are the run's real magnification. Their MEAN is the
      // reduction: it is the rule a consumer's own raster-scale picks for a non-uniform matrix, it
      // is exactly 1 for the pure rotation this used to assume, and it is the right kind of wrong
      // for an anisotropic one — a gate, not a rasterisation parameter.
      //
      // `run.pixelsPerEm` ITSELF IS NOT TOUCHED. hb-gpu's push uses it as the run's geometric
      // scale as well as its size, so folding the matrix into it would apply the matrix twice.
      const axis =
        (Math.hypot(run.m[0], run.m[1]) + Math.hypot(run.m[2], run.m[3])) / 2;
      const ppem = run.pixelsPerEm * axis * (framebufferWidth / designWidth);
      if (ppem < PPEM_FIDELITY_FLOOR) {
        stats.runsBelowPpemFloor += 1;
        if (options.warnBelowPpemFloor !== false && !warnedBelowPpemFloor) {
          warnedBelowPpemFloor = true;
          console.warn(
            `[gsw canvas] glyph run drawn at ${ppem.toFixed(1)} device ppem (pixelsPerEm ${run.pixelsPerEm} x model scale ${axis.toFixed(3)} x ${(framebufferWidth / designWidth).toFixed(3)} device ratio), under the ${PPEM_FIDELITY_FLOOR} this path wants: HarfBuzz's coverage shader falls back to a five-tap approximation below it, measured blurrier than the DOM text path (0.196 vs 0.132 distortion on Han at ppem 14). A baked atlas or DOM text is crisper at this size. Reported once; see stats.runsBelowPpemFloor for the tally.`,
          );
        }
      }

      // ONE `begin`/`end` PER RUN, AND THAT IS THE DRAW CALL. hb-gpu carries the colour and the
      // model matrix as uniforms, so runs cannot merge — see `GlyphPass.drawRun`. Advancing the
      // renderer's frame counter per run also makes its in-use eviction guard per-run, which is
      // correct here rather than merely permissive: `end` has already ISSUED the previous run's
      // draw before the next one uploads anything, and GL orders a `texSubImage2D` behind the draws
      // that read the texture before it.
      if (!adjacentBatchOpen) renderer.begin();
      renderer.setModel(run.m);
      // PER RUN, UNCONDITIONALLY, INCLUDING THE 0. hb-gpu's spread is sticky like its colour and
      // its model — `begin` does not clear it — so a run recorded without a spread after one
      // recorded with one would otherwise inherit it and draw fat. Passing `run.spreadPx` every
      // time makes the draw list, not the call order, the thing that decides.
      renderer.setSpread(run.spreadPx);
      // STRAIGHT rgba out of a PREMULTIPLIED view. `GlyphsView` stores `rgb` already multiplied by
      // `a` (its own doc says so) and hb-gpu's fragment multiplies exactly once, so handing it the
      // premultiplied triple would apply alpha twice — silently, as text that is merely darker,
      // which is the same failure `./executor-webgl`'s alpha note names for every other stage.
      const inverse = run.a > 0 ? 1 / run.a : 0;
      renderer.setColor(
        run.r * inverse,
        run.g * inverse,
        run.b * inverse,
        run.a,
      );

      const count = run.glyphCount;
      for (let i = 0; i < count; i += 1) {
        const id = run.slots[i];
        if (id === GLYPH_SLOT_NONE) {
          stats.inkless += 1;
          continue;
        }
        const entry = entries[id];
        if (!entry) {
          // An id this pass never issued: a list built against a different pass, or a caller
          // writing raw numbers into `slots`. A hole in a word rather than a crash, and counted.
          stats.dropped += 1;
          continue;
        }
        // THE WHOLE REASON THE IR STORES IDS. `resolve` is a map lookup that answers `null` for a
        // glyph the ring has evicted since the list was recorded; the alternative — caching the
        // `GlyphSlot` here — draws a DIFFERENT glyph's outline at the right size, in the right
        // place, perfectly antialiased, which nothing downstream can see. A miss is not an error,
        // it is re-encoded and re-uploaded, and only the counter notices.
        let slot: GlyphSlot | null = renderer.resolve(
          entry.face.face,
          entry.glyphId,
        );
        if (!slot) {
          const glyph = encode(entry);
          if (!glyph || glyph.texels.length === 0) {
            stats.dropped += 1;
            continue;
          }
          slot = renderer.upload(entry.face.face, entry.glyphId, glyph);
          stats.reuploads += 1;
          if (!slot) {
            stats.dropped += 1;
            continue;
          }
        }
        renderer.push(
          slot,
          run.positions[i * 2],
          run.positions[i * 2 + 1],
          run.pixelsPerEm,
        );
      }

      const frame = adjacentBatchOpen
        ? { instances: 0, drawCalls: 0 }
        : renderer.end();
      stats.runs += 1;
      stats.glyphs += frame.instances;
      return { glyphs: frame.instances, drawCalls: frame.drawCalls };
    },

    drawRuns(runs, projection) {
      if (runs.length === 0) return { glyphs: 0, drawCalls: 0 };
      // The executor guarantees adjacency. Keeping the traversal here rather than teaching its
      // storage about an array makes the ordinary `drawRun` call byte-for-byte the fallback.
      renderer.begin();
      adjacentBatchOpen = true;
      let completed = false;
      try {
        for (const run of runs) pass.drawRun(run, projection);
        completed = true;
      } finally {
        adjacentBatchOpen = false;
        // A failed re-upload must not leave half a batch for a future caller to submit. There is
        // deliberately no `end()` on this path: it would make an exception present partial text.
        if (!completed) renderer.begin();
      }
      const frame = renderer.end();
      stats.glyphs += frame.instances;
      return { glyphs: frame.instances, drawCalls: frame.drawCalls };
    },

    canBatchRuns(runs) {
      if (!batchAdjacentRuns) return false;
      // A single instanced draw cannot allow a later upload to replace an earlier glyph. Only
      // admit a known, fully resident working set; individual drawRun calls retain the existing
      // submit-before-possible-eviction behaviour on a miss.
      for (const run of runs) {
        for (let i = 0; i < run.glyphCount; i += 1) {
          const id = run.slots[i];
          if (id === GLYPH_SLOT_NONE) continue;
          const entry = entries[id];
          if (!entry || !renderer.resolve(entry.face.face, entry.glyphId))
            return false;
        }
      }
      return true;
    },

    setViewport(width, height, bufferWidth, bufferHeight) {
      designWidth = Math.max(1, width);
      designHeight = Math.max(1, height);
      framebufferWidth = Math.max(1, bufferWidth ?? width);
      framebufferHeight = Math.max(1, bufferHeight ?? height);
      renderer.setViewport(
        designWidth,
        designHeight,
        framebufferWidth,
        framebufferHeight,
      );
    },

    notifyContextLost() {
      renderer.notifyContextLost();
    },

    rebuild() {
      return renderer.rebuild();
    },

    dispose() {
      shapeCache.clear();
      renderer.dispose();
    },
  };
  // Never expose the grouped entry point on the compact renderer: its 40-byte records intentionally
  // retain model/colour/spread as uniforms, so a direct grouped call would apply the final run's
  // state to preceding glyphs. The executor sees no `drawRuns` and takes its established path.
  if (!batchAdjacentRuns) {
    delete pass.drawRuns;
    delete pass.canBatchRuns;
  }
  return pass;
}
