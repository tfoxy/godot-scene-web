// HarfBuzz's Slug (GPU glyph) encoder, compiled to wasm — outlines in, one texel blob per glyph out.
//
// WHAT THIS IS. `hb-atlas` and `hb-run` bake PIXELS: they rasterize once, at one size and one
// rotation, and thereafter blit. This bakes the OUTLINE instead. `hb_gpu_draw_encode` turns a
// glyph's curves into a banded, quantized RGBA16I texel stream, and a fragment shader evaluates
// exact coverage from it at whatever size, rotation and sub-pixel phase the frame asks for. There
// is no atlas resolution to pick, no phase grid, and no rotation baked into anything — which is
// the whole reason it is worth measuring against arms whose VRAM grows 12x with a phone's device
// pixel ratio.
//
// IT SHAPES NOW, AND THAT IS WHY `heapBytes` GOT SMALLER BY GETTING BIGGER. This module used to
// export no `hb_shape`: the perf-harness shaped with npm `harfbuzzjs` and this binary only read
// outlines, so an `hb-gpu` arm beside a `harfbuzz` shaper held the same face bytes in TWO wasm
// heaps — 4.19 MiB across the pair on the phone, every face resident twice. `hb-gpu.symbols` now
// names the shaper (the engine was always compiled; only the symbol list kept `--gc-sections` from
// throwing it away), which costs +190 KB of binary once and saves a whole second HarfBuzz and a
// second copy of every face at runtime. `heapBytes` is still published so the caller can count
// what is left, and a caller that shapes here should be counting ONE module, not two.
//
// THE SHADER TEXT COMES OUT OF THE WASM. `hb_gpu_shader_source` / `hb_gpu_draw_shader_source`
// return the GLSL that reads the blob format this same binary writes, so the two cannot drift.
// None of HarfBuzz's GLSL is copied into this repo.
//
// THE ONE EXCEPTION, STATED PLAINLY: HarfBuzz supplies the two shader LIBRARY halves, not an entry
// point. There is no `main()` in either, because HarfBuzz cannot know what a consumer's attributes
// are called or what its fragment writes to. So a ~30-line `main()` per stage is unavoidably ours,
// and it lives in `./webgl.ts` beside the attribute layout it names. Upstream's own
// `util/gpu/demo-{vertex,fragment}.glsl` is exactly the same thing for its GLFW demo. Ours is
// written against `hb-gpu-vertex.glsl`'s documented `hb_gpu_dilate` contract and
// `hb-gpu-draw-fragment.glsl`'s `hb_gpu_draw`, not copied from the demo.
//
// LOADED WITH `{ wasmBinary }`, never by URL. `dist/hb-gpu.mjs` is emscripten ES6 glue that would
// otherwise `fetch` its sibling `.wasm` relative to `import.meta.url` — which is wrong under every
// bundler this repo drives a page with, and silently so.

/**
 * Every way this package can decline, as a stable string.
 *
 * A REASON CHANNEL EXISTS BECAUSE THE FUNCTIONS RETURN `null`. Construct-or-null is the repo's
 * idiom (`createCanvasStage`) and the right one for a shipped renderer — a consumer that cannot
 * have the GPU glyph path falls back to its DOM one. But a component that declined silently
 * reports as a CHEAP one, in a perf table literally so, so every `null` is paired with one of
 * these plus a sentence naming the failure mode.
 *
 * String union rather than an enum so a report can carry it verbatim and a `switch` over it is
 * exhaustively checked.
 */
export type HbGpuFailureReason =
  /** `_malloc` returned 0. The heap could not grow; the write would have gone to the null page. */
  | "out-of-memory"
  /** Zero-length face bytes — usually a detached ArrayBuffer that was transferred elsewhere. */
  | "empty-face"
  /** HarfBuzz would not take the bytes as a face, or the face's `upem` is unusable. */
  | "face-rejected"
  /** `hb_gpu_draw_create_or_fail` returned null. */
  | "encoder-unavailable"
  /** A `upem` that would make every glyph scale `Infinity` or `NaN`. */
  | "degenerate-upem"
  /**
   * A `contrast.gamma` that is not a finite positive number. Not fatal — the exponent falls back
   * to 1 and the renderer builds.
   *
   * Refused rather than passed through because `pow (cov, gamma)` with a NaN or an infinity is a
   * NaN alpha, and a NaN alpha through a premultiplied MIX blend is an undefined framebuffer over
   * the glyph's whole quad on some drivers and a black box on others. Neither reads as "somebody
   * typed a bad number into a renderer option".
   */
  | "degenerate-contrast"
  /** The WebGL2 context was lost, or was already lost when handed over. */
  | "context-lost"
  /** `gl.create*` returned null. */
  | "gl-object"
  | "shader-compile"
  | "program-link"
  /** `MAX_TEXTURE_SIZE` is too small for an atlas at all. */
  | "texture-size"
  /** `MAX_TEXTURE_SIZE` forced a narrower or shorter atlas than asked for. Not fatal. */
  | "atlas-clamped"
  /** A blob whose length is not a whole number of texels. */
  | "blob-malformed"
  /**
   * `hb_feature_from_string` would not parse one of the feature strings handed to `shape`.
   *
   * Its own failure mode is the reason this is a refusal and not a warning: HarfBuzz zeroes the
   * struct and returns false, and a zeroed `hb_feature_t` is tag 0 with value 0 over the whole
   * run — which shapes, and shapes WITHOUT the feature the caller asked for. A typo in `"-liga"`
   * would otherwise be a ligature quietly still applied.
   */
  | "feature-malformed"
  /** One glyph larger than the entire atlas. */
  | "blob-too-large"
  /** A face handle that this renderer never issued. */
  | "face-unregistered"
  /** A context restore that could not put every resident glyph back. Not fatal. */
  | "rebuild-incomplete";

/** A refusal, with the reason machine-readable and the sentence written for a human. */
export interface HbGpuFailure {
  reason: HbGpuFailureReason;
  /** Always prefixed `hb-gpu: `, and always says what the failure LOOKS like, not just its name. */
  message: string;
}

export interface HbGpuOptions {
  /** Where a refusal goes. See {@link HbGpuFailureReason}. */
  onError?(failure: HbGpuFailure): void;
}

/** Values of `hb_gpu_shader_stage_t`. */
export const HB_GPU_SHADER_STAGE_VERTEX = 0;
export const HB_GPU_SHADER_STAGE_FRAGMENT = 1;

/** `HB_GPU_SHADER_LANG_GLSL`. WebGL2 is the only backend this package has a pipeline for. */
export const HB_GPU_SHADER_LANG_GLSL = 1;

/** `HB_MEMORY_MODE_READONLY`: the blob points at our allocation and never writes to it. */
const HB_MEMORY_MODE_READONLY = 1;

/** Bytes per encoded texel: RGBA16I, and the unit the atlas allocator counts in. */
export const HB_GPU_TEXEL_BYTES = 8;

/**
 * A glyph's ink box, in FONT UNITS at the font's scale, y-UP — HarfBuzz's convention, unaltered.
 *
 * `height` IS NEGATIVE and `yBearing` is the ink's TOP. Restated here because it is the single most
 * common way to get a glyph quad upside down, and because `hb_gpu_draw_encode` floors/ceils these
 * to whole font units, so the box is always at least the ink and never less.
 */
export interface HbGpuGlyphExtents {
  xBearing: number;
  yBearing: number;
  width: number;
  height: number;
}

/** One encoded glyph: the texel stream to upload, and the box to draw it in. */
export interface EncodedGlyph {
  /** RGBA16I texels, little-endian, exactly as `hb_gpu_draw_encode` produced them. */
  texels: Uint8Array;
  extents: HbGpuGlyphExtents;
}

/**
 * `hb_direction_t`, as the four names rather than the four integers.
 *
 * A STRING UNION AND NOT A NUMBER, because `hb_buffer_set_direction` has no error channel: hand it
 * anything outside 4..7 and the buffer's direction is INVALID, `guess_segment_properties` then
 * fills in whatever it likes, and the run comes out laid the wrong way with nothing said. The
 * mapping is an ABI constant, kept here the way `HB_MEMORY_MODE_READONLY` is.
 */
export type HbGpuDirection = "ltr" | "rtl" | "ttb" | "btt";

/** `hb_direction_t`: HB_DIRECTION_LTR is 4 and the rest follow. */
const HB_DIRECTION: Record<HbGpuDirection, number> = {
  ltr: 4,
  rtl: 5,
  ttb: 6,
  btt: 7,
};

/**
 * What a caller can tell the shaper about a run.
 *
 * EVERY FIELD IS OPTIONAL AND THE DEFAULT IS `hb_buffer_guess_segment_properties`, which infers
 * script from the code points and direction from the script. That is the right default and a poor
 * guarantee: it cannot know that a Latin quotation inside an Arabic paragraph is still RTL, and it
 * has no opinion at all about language. Anything set here is set BEFORE the guess, and the guess
 * only fills what is still unset — so an explicit value always wins.
 */
export interface HbGpuShapeOptions {
  /** Overrides the direction the script implies. */
  direction?: HbGpuDirection;
  /** An ISO 15924 tag — `"Hans"`, `"Latn"`, `"Arab"`. Case is canonicalised by HarfBuzz. */
  script?: string;
  /**
   * A BCP 47 tag — `"zh-Hans"`, `"en"`, `"tr"`.
   *
   * Left unset it stays unset: this build has `HB_NO_SETLOCALE`, so there is no ambient locale to
   * fall back to and the font's `dflt` language system is used. Set it when the face has a
   * language-specific feature the run needs (Turkish dotless i, Serbian Cyrillic italics).
   */
  language?: string;
  /**
   * OpenType features in `hb-shape`'s own syntax: `"kern"`, `"-liga"`, `"ss01"`, `"aalt[3:5]=2"`.
   *
   * Parsed by `hb_feature_from_string`, and a string it refuses fails the whole call with
   * `"feature-malformed"` rather than being dropped — see that reason.
   */
  features?: readonly string[];
}

/**
 * One glyph of a shaped run, in the font's own units, y-UP — HarfBuzz's output, unconverted.
 *
 * See {@link HbGpuFont.shape} for the pen arithmetic these five numbers go into; getting the
 * offset/advance split or the y sign wrong produces text that looks plausible and is mis-spaced.
 */
export interface HbGpuShapedGlyph {
  /** Glyph id in this face. The same id `encode` takes. */
  glyphId: number;
  /**
   * Where this glyph came from in `text`, as a UTF-16 code-unit index — i.e. an index you can
   * hand straight to `String.prototype.slice`, because the text goes in through
   * `hb_buffer_add_utf16` and a JS string already is UTF-16.
   *
   * Not one per glyph and not monotonic in general: several glyphs share a cluster when one
   * character became many, and many characters share one when a ligature ate them.
   */
  cluster: number;
  /** How far the pen moves AFTER this glyph. */
  xAdvance: number;
  yAdvance: number;
  /** Added to the pen for THIS glyph only, and never accumulated. */
  xOffset: number;
  yOffset: number;
}

export interface HbGpuFont {
  /** Units per em of the face — the scale outlines and extents are expressed in. */
  readonly upem: number;
  /** Glyph id for a code point, or 0 (`.notdef`) when the face has no cmap entry. */
  glyphFor(codepoint: number): number;
  /**
   * Shape a run: text in, positioned glyph ids out.
   *
   * UNITS ARE THE FONT'S OWN AND NOT PIXELS, which is the sentence to read twice. `createFont`
   * calls `hb_font_set_scale(font, upem, upem)` — see there for why — so every number that comes
   * back is in font units at that scale, y is UP, and nothing has been converted. Same contract as
   * {@link HbGpuGlyphExtents}, for the same reason: this package cannot know the caller's pixel
   * size, and a half-applied convention is worse than none.
   *
   * THE PEN ARITHMETIC, WHICH IS THE PART THAT GOES SUBTLY WRONG. With `toPx = fontSizePx / upem`,
   * a horizontal run is laid out:
   *
   * ```ts
   * let pen = 0;
   * for (const glyph of run) {
   *   const xPx = (pen + glyph.xOffset) * toPx; // offset positions THIS glyph...
   *   const yPx = -glyph.yOffset * toPx; //         ...and y flips, because canvases are y-DOWN
   *   pen += glyph.xAdvance; //                     ...and only the advance moves the pen
   * }
   * ```
   *
   * The offset does not accumulate and the advance is applied AFTER the glyph. That is
   * byte-for-byte what `perf-harness/src/scenarios/text-hb.ts` runs over npm `harfbuzzjs`'s
   * output, whose pen positions are in turn proven identical to the independently written
   * `hb-atlas` arm's — so matching it is what makes a run shaped here land exactly where every
   * other arm in that round puts it. `test/shape.test.ts` asserts the two agree, glyph for glyph.
   *
   * `[]` FOR EMPTY TEXT AND `null` FOR A FAILURE, which are different answers to different
   * questions. An empty run is legal; a run that could not be shaped is not, and it would
   * otherwise render as a page with some of its text quietly missing.
   *
   * An array of objects rather than a flat typed array: shaping is a startup cost in every
   * consumer here (each run is shaped once and baked), each field is read exactly once on the way
   * into a pen position, and a per-glyph object is field-for-field what npm `harfbuzzjs` hands
   * back — which is what makes the cross-check, and any port off it, a direct comparison rather
   * than a re-derivation.
   */
  shape(text: string, options?: HbGpuShapeOptions): HbGpuShapedGlyph[] | null;
  /**
   * Encode one glyph. `null` when the encoder failed; a zero-length `texels` when the glyph has no
   * ink (a space), which is a different thing and must not be uploaded.
   */
  encode(glyphId: number): EncodedGlyph | null;
  destroy(): void;
}

export interface HbGpu {
  /**
   * Bytes of wasm heap this module currently holds.
   *
   * `HEAPU8.byteLength` rather than an instrumented allocator: it reports what the heap has
   * actually grown to, font copy and encoder scratch included, which is the number a consumer
   * weighs against the arm's other costs.
   *
   * IT IS A CEILING, NOT A HIGH-WATER MARK, AND `build.sh` HAD TO BE CHANGED TO MAKE IT USEFUL.
   * A wasm heap is only ever as small as its initial reservation, so this reads whatever
   * `-sINITIAL_MEMORY` asked for until something exceeds it. At emscripten's default it read
   * 16.19 MiB for an 826 KB face — about 8x the truth. The build asks for 2 MiB, re-measured when
   * shaping landed: both S9 fixture faces, 2080 shaped runs and 340 encoded outlines high-water at
   * 1.125 MiB and never reach the reservation. See `build.sh` for the whole ladder.
   *
   * AND IT IS NOW ONE NUMBER RATHER THAN TWO. A caller that shapes here has no second wasm heap to
   * add to it; the arrangement this replaces held every face in both.
   */
  readonly heapBytes: number;
  /**
   * HarfBuzz's own GLSL for one stage: the shared library half plus the draw-renderer half,
   * concatenated in the order `demo-shader.cc` uses. No `main()` — see this file's header.
   */
  shaderLibrary(stage: number): string;
  /**
   * Copy a face into the wasm heap and open an encoder over it, or `null`.
   *
   * `null` RATHER THAN A THROW, and the throw it replaces leaked: the old code allocated the face
   * copy, created a blob, a face and a font, and then threw when the encoder came back null —
   * losing all four for the life of the module. Every failure path below unwinds in the reverse
   * order `destroy` uses. The reason reaches {@link HbGpuOptions.onError}.
   */
  createFont(bytes: Uint8Array): HbGpuFont | null;
  destroy(): void;
}

/**
 * The subset of emscripten's module object this package uses.
 *
 * Hand-written rather than generated: `-sEXPORTED_FUNCTIONS=@hb-gpu.symbols` already fixes the
 * list, and a type that restates it is a second place the two can disagree — loudly, at the call
 * site, which is where a missing export should be noticed.
 */
export interface HbGpuWasmExports {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  /** The view `hb_buffer_add_utf16`'s text is written through. See `build.sh`. */
  HEAPU16: Uint16Array;
  UTF8ToString(pointer: number): string;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _hb_blob_create(
    data: number,
    length: number,
    mode: number,
    userData: number,
    destroy: number,
  ): number;
  _hb_blob_get_data(blob: number, lengthOut: number): number;
  _hb_blob_get_length(blob: number): number;
  _hb_blob_destroy(blob: number): void;
  _hb_face_create(blob: number, index: number): number;
  _hb_face_destroy(face: number): void;
  _hb_face_get_upem(face: number): number;
  _hb_font_create(face: number): number;
  _hb_font_destroy(font: number): void;
  _hb_font_set_scale(font: number, xScale: number, yScale: number): void;
  _hb_font_get_nominal_glyph(
    font: number,
    codepoint: number,
    glyphOut: number,
  ): number;
  _hb_shape(
    font: number,
    buffer: number,
    features: number,
    featureCount: number,
  ): void;
  _hb_buffer_create(): number;
  _hb_buffer_destroy(buffer: number): void;
  _hb_buffer_allocation_successful(buffer: number): number;
  _hb_buffer_clear_contents(buffer: number): void;
  _hb_buffer_add_utf16(
    buffer: number,
    text: number,
    textLength: number,
    itemOffset: number,
    itemLength: number,
  ): void;
  _hb_buffer_guess_segment_properties(buffer: number): void;
  _hb_buffer_set_direction(buffer: number, direction: number): void;
  _hb_buffer_set_script(buffer: number, script: number): void;
  _hb_buffer_set_language(buffer: number, language: number): void;
  _hb_language_from_string(text: number, length: number): number;
  _hb_script_from_string(text: number, length: number): number;
  _hb_feature_from_string(
    text: number,
    length: number,
    featureOut: number,
  ): number;
  _hb_buffer_get_length(buffer: number): number;
  _hb_buffer_get_glyph_infos(buffer: number, lengthOut: number): number;
  _hb_buffer_get_glyph_positions(buffer: number, lengthOut: number): number;
  _hb_gpu_draw_create_or_fail(): number;
  _hb_gpu_draw_destroy(draw: number): void;
  _hb_gpu_draw_set_scale(draw: number, xScale: number, yScale: number): void;
  _hb_gpu_draw_glyph_or_fail(draw: number, font: number, glyph: number): number;
  _hb_gpu_draw_encode(draw: number, extentsOut: number): number;
  _hb_gpu_draw_clear(draw: number): void;
  _hb_gpu_draw_reset(draw: number): void;
  _hb_gpu_draw_recycle_blob(draw: number, blob: number): void;
  _hb_gpu_shader_source(stage: number, lang: number): number;
  _hb_gpu_draw_shader_source(stage: number, lang: number): number;
}

/** The default export of `dist/hb-gpu.mjs`, under `-sMODULARIZE=1 -sEXPORT_ES6=1`. */
export type HbGpuModuleFactory = (options: {
  wasmBinary: ArrayBuffer | Uint8Array;
}) => Promise<HbGpuWasmExports>;

/** `sizeof (hb_glyph_extents_t)`: four `hb_position_t`, which is `int32_t`. */
const EXTENTS_BYTES = 16;

/**
 * `sizeof (hb_glyph_info_t)` and `sizeof (hb_glyph_position_t)` on wasm32. Both 20, and the fact
 * that they are EQUAL is a coincidence of layout, not a rule — they are named separately so that a
 * future HarfBuzz that grows one of them cannot silently shift the other's reads.
 *
 * `hb_glyph_info_t`  = codepoint, mask, cluster, var1, var2   (5 x uint32)
 * `hb_glyph_position_t` = x_advance, y_advance, x_offset, y_offset, var (5 x int32)
 */
const GLYPH_INFO_BYTES = 20;
const GLYPH_POSITION_BYTES = 20;

/** `sizeof (hb_feature_t)`: tag, value, start, end. */
const FEATURE_BYTES = 16;

/** UTF-8 for the tag and feature strings. ASCII in practice; this is the correct encoder anyway. */
const utf8 = new TextEncoder();

/**
 * Instantiate the module.
 *
 * The FACTORY is a parameter rather than an import, and deliberately: `dist/hb-gpu.mjs` is a build
 * output of `build.sh` (docker, emscripten, minutes) that `dist/` gitignores, so a static import
 * here would make this package fail to typecheck on a fresh checkout and fail to build in CI. The
 * caller imports the glue — it is the caller that knows whether the build has been run.
 */
export async function createHbGpu(
  factory: HbGpuModuleFactory,
  wasmBinary: ArrayBuffer | Uint8Array,
  options: HbGpuOptions = {},
): Promise<HbGpu> {
  const wasm = await factory({ wasmBinary });
  const fonts = new Set<HbGpuFont>();
  const fail = (reason: HbGpuFailureReason, message: string): null => {
    options.onError?.({ reason, message: `hb-gpu: ${message}` });
    return null;
  };

  return {
    get heapBytes() {
      return wasm.HEAPU8.byteLength;
    },

    shaderLibrary(stage) {
      const shared = wasm._hb_gpu_shader_source(stage, HB_GPU_SHADER_LANG_GLSL);
      const draw = wasm._hb_gpu_draw_shader_source(
        stage,
        HB_GPU_SHADER_LANG_GLSL,
      );
      // Both halves, shared first, exactly as `util/gpu/demo-shader.cc` orders them: the draw half
      // calls `_hb_gpu_slug` out of the shared one, and GLSL has no forward declarations for it.
      // A null pointer is a stage with no source (the vertex draw half is empty), not an error.
      return (
        (shared ? wasm.UTF8ToString(shared) : "") +
        (draw ? wasm.UTF8ToString(draw) : "")
      );
    },

    createFont(bytes) {
      // A DETACHED BUFFER READS AS ZERO BYTES, WHICH IS THE COMMON WAY TO GET HERE. Handing the
      // same ArrayBuffer to two wasm modules and letting one transfer it leaves the other with an
      // empty face — which HarfBuzz accepts, encodes to nothing, and renders as a blank page.
      if (bytes.byteLength === 0) {
        return fail(
          "empty-face",
          "createFont was given zero face bytes — a transferred or detached ArrayBuffer looks exactly like this, and the face would encode every glyph to nothing",
        );
      }
      // COPIED INTO THE WASM HEAP AND KEPT THERE. `HB_MEMORY_MODE_READONLY` means HarfBuzz reads
      // our allocation in place rather than duplicating it, so this is ONE copy of the face inside
      // the module — which is what `heapBytes` should be reporting — but it also means the
      // allocation has to outlive the face, so it is freed in `destroy` and nowhere else.
      const dataPointer = wasm._malloc(bytes.byteLength);
      // 0 IS emscripten's OOM, AND IT IS NOT AN EXCEPTION. `_malloc` returning 0 was unchecked, so
      // `HEAPU8.set(bytes, 0)` wrote the whole face over address 0 — the null page, where
      // emscripten keeps nothing but where every null pointer in the module points. That corrupts
      // the heap silently and the first symptom is somewhere else entirely.
      if (!dataPointer) {
        return fail(
          "out-of-memory",
          `_malloc(${bytes.byteLength}) returned 0 — the wasm heap could not grow, and writing the face at address 0 would have corrupted the null page`,
        );
      }
      wasm.HEAPU8.set(bytes, dataPointer);

      // Everything from here unwinds through `unwind`, in the reverse order `destroy` uses. The
      // version this replaces threw at the encoder check and leaked the face copy plus the blob,
      // the face and the font with it — once per corrupt face, for the life of the module.
      let blob = 0;
      let face = 0;
      let font = 0;
      let draw = 0;
      let scratch = 0;
      let buffer = 0;
      const unwind = (reason: HbGpuFailureReason, message: string): null => {
        if (buffer) wasm._hb_buffer_destroy(buffer);
        if (draw) wasm._hb_gpu_draw_destroy(draw);
        if (scratch) wasm._free(scratch);
        if (font) wasm._hb_font_destroy(font);
        if (face) wasm._hb_face_destroy(face);
        if (blob) wasm._hb_blob_destroy(blob);
        // LAST, for the reason `destroy` gives: the blob was created READONLY over this pointer.
        wasm._free(dataPointer);
        return fail(reason, message);
      };

      blob = wasm._hb_blob_create(
        dataPointer,
        bytes.byteLength,
        HB_MEMORY_MODE_READONLY,
        0,
        0,
      );
      // `hb_blob_create` never returns null — it returns the immortal EMPTY blob when it will not
      // take the allocation — so the length round trip is the only way to tell the two apart.
      if (!blob || wasm._hb_blob_get_length(blob) !== bytes.byteLength) {
        return unwind(
          "face-rejected",
          `hb_blob_create returned a ${blob ? wasm._hb_blob_get_length(blob) : 0}-byte blob for ${bytes.byteLength} bytes of face — HarfBuzz would not take the allocation`,
        );
      }
      face = wasm._hb_face_create(blob, 0);
      if (!face) {
        return unwind("face-rejected", "hb_face_create returned null");
      }
      const upem = wasm._hb_face_get_upem(face);
      // THE `Infinity` THIS EXISTS TO PREVENT is one layer up: `webgl.ts` scales every glyph by
      // `pixelsPerEm / upem`, so a upem of 0 makes every instance record NaN and the draw a silent
      // no-op — a blank page with no error anywhere.
      //
      // HONEST ABOUT WHAT THIS CANNOT DO: HarfBuzz substitutes 1000 for a face with no readable
      // `head` table (`head::get_upem` returns 1000 for anything below 16), so a upem in range does
      // NOT prove the bytes are a font. It proves only that the arithmetic downstream is finite,
      // which is the specific failure this rejects. A truly corrupt face is caught per glyph, by
      // `encode` returning null.
      if (!Number.isInteger(upem) || upem <= 0 || upem > 16384) {
        return unwind(
          "face-rejected",
          `the face reports upem ${upem} — every glyph scaled by that is Infinity or NaN, which draws nothing and reports no error`,
        );
      }
      font = wasm._hb_font_create(face);
      if (!font) {
        return unwind("face-rejected", "hb_font_create returned null");
      }
      // FONT UNITS, not pixels. HarfBuzz scales outline coordinates by `scale / upem` in integer
      // arithmetic, so asking for a pixel size here would round every curve control point to a
      // whole pixel inside the encoder. It also matters more here than it does for a rasterizer:
      // the blob quantizes to 4 units per step over a +/-8192 range, so a 1000-unit em lands in the
      // middle of the format's precision while a 14-unit one would collapse to nothing.
      // `hb-gpu.h` says as much in its coordinate-system note.
      wasm._hb_font_set_scale(font, upem, upem);

      draw = wasm._hb_gpu_draw_create_or_fail();
      if (!draw) {
        return unwind(
          "encoder-unavailable",
          "hb_gpu_draw_create_or_fail returned null — this face has no encoder, and every glyph of it would be missing from the frame",
        );
      }
      // Redundant with `hb_gpu_draw_glyph_or_fail`, which sets the scale from the font on every
      // call, and set anyway: the scale is written into every blob's header (`buf[1].b/.a`) and
      // the fragment shader divides by it to get ppem. An encoder used for a non-glyph outline —
      // which the public API explicitly supports — would otherwise emit a header saying scale 0.
      wasm._hb_gpu_draw_set_scale(draw, upem, upem);

      scratch = wasm._malloc(EXTENTS_BYTES);
      // Same null-page hazard as the face copy, and a nastier one: `glyphFor` and `encode` both
      // read `HEAP32[scratch >> 2]`, so a scratch of 0 would return whatever sits at address 0 as
      // a glyph id and as an extents box.
      if (!scratch) {
        return unwind(
          "out-of-memory",
          `_malloc(${EXTENTS_BYTES}) for the extents scratch returned 0 — reading glyph ids out of address 0 would hand back whatever the null page holds`,
        );
      }

      // ONE SHAPING BUFFER PER FONT, CREATED HERE AND REUSED. A buffer is where HarfBuzz keeps the
      // run's code points, its glyph array and its positions, and those arrays are what make
      // shaping allocate at all — so creating one per `shape` call would hand the allocator a
      // fresh growth curve on every run. It is cleared, not recreated, between runs.
      buffer = wasm._hb_buffer_create();
      // `hb_buffer_create` NEVER RETURNS NULL — it hands back the immortal EMPTY buffer, the same
      // trap `hb_blob_create` sets above. The empty buffer is the one object whose `successful`
      // flag is false out of the box, so this is the only way to tell it apart, and shaping into
      // it silently produces zero glyphs for every run forever.
      if (!buffer || !wasm._hb_buffer_allocation_successful(buffer)) {
        return unwind(
          "out-of-memory",
          "hb_buffer_create handed back the immortal empty buffer — the heap could not allocate one, and every run shaped into it would come back with no glyphs at all",
        );
      }
      let alive = true;

      const self: HbGpuFont = {
        upem,

        glyphFor(codepoint) {
          const ok = wasm._hb_font_get_nominal_glyph(font, codepoint, scratch);
          // Re-read `HEAP32` through the module every time, never through a cached local. Under
          // `ALLOW_MEMORY_GROWTH` emscripten's `updateMemoryViews` REPLACES the typed arrays on
          // growth — except when the engine gave it a resizable `ArrayBuffer`, in which case it
          // returns early and the old views keep working. So a cached view is correct on some
          // engines and a detached zero-length array on others, which is worse than being simply
          // wrong: it would pass here and fail on a phone.
          return ok ? wasm.HEAP32[scratch >> 2] >>> 0 : 0;
        },

        shape(text, options = {}) {
          // CLEARED FIRST, NOT LAST, and `clear_contents` rather than `reset`: it drops the
          // previous run's glyphs AND puts the segment properties back to invalid, so a run that
          // asked for `direction: "rtl"` cannot leak its direction into the next one.
          wasm._hb_buffer_clear_contents(buffer);
          // Nothing to shape and nothing to allocate. `[]` and not `null`, because an empty run is
          // an answer and only a failure is a refusal.
          if (text.length === 0) return [];

          // ONE `_malloc` FOR THE WHOLE CALL — one null check, one `_free` on every path out,
          // which is the shape the rest of this file already uses. Laid out:
          //
          //   [0, textBytes)                       the run, as UTF-16 code units
          //   [featuresAt, +16 * n)                hb_feature_t[]
          //   [stringsAt, ...)                     script tag, language tag, feature strings
          //
          // THE TEXT IS AT OFFSET 0 AND HAS TO BE. `hb_buffer_add_utf16` reads a `const uint16_t
          // *`, and the base pointer is the only part of the block `_malloc` guarantees is even.
          const featureStrings = options.features ?? [];
          const textBytes = text.length * 2;
          // `hb_feature_t` is four uint32s and wants 4-byte alignment; `textBytes` is even, not
          // necessarily a multiple of four.
          const featuresAt = (textBytes + 3) & ~3;
          const strings: { bytes: Uint8Array; at: number }[] = [];
          let end = featuresAt + featureStrings.length * FEATURE_BYTES;
          const place = (value: string): { at: number; length: number } => {
            const bytes = utf8.encode(value);
            strings.push({ bytes, at: end });
            const placed = { at: end, length: bytes.length };
            end += bytes.length;
            return placed;
          };
          const script = options.script ? place(options.script) : null;
          const language = options.language ? place(options.language) : null;
          const features = featureStrings.map(place);

          const block = wasm._malloc(end);
          // Same null-page hazard as the face copy: at 0, `HEAPU16.set` would write the run over
          // the null page and `hb_buffer_add_utf16` would read whatever is there as text.
          if (!block) {
            return fail(
              "out-of-memory",
              `_malloc(${end}) for a ${text.length}-code-unit run returned 0 — the wasm heap could not grow, and shaping out of address 0 would read the null page as text`,
            );
          }

          // `charCodeAt` and not a code-point iteration: `hb_buffer_add_utf16` wants the raw code
          // units, surrogate pairs included, which is exactly what a JS string already holds.
          const units = new Uint16Array(text.length);
          for (let i = 0; i < text.length; i += 1)
            units[i] = text.charCodeAt(i);
          wasm.HEAPU16.set(units, block >> 1);
          for (const string of strings) {
            wasm.HEAPU8.set(string.bytes, block + string.at);
          }

          for (let i = 0; i < features.length; i += 1) {
            const at = block + featuresAt + i * FEATURE_BYTES;
            if (
              !wasm._hb_feature_from_string(
                block + features[i].at,
                features[i].length,
                at,
              )
            ) {
              wasm._free(block);
              // REFUSED, NOT SKIPPED. HarfBuzz zeroes the struct and returns false, and a zeroed
              // `hb_feature_t` is a tag of 0 applied over the whole run — so shaping on would
              // produce a run laid out WITHOUT the feature that was asked for, and say nothing.
              return fail(
                "feature-malformed",
                `hb_feature_from_string refused "${featureStrings[i]}" — shaping on would silently lay the run out without the feature, so the run is refused instead`,
              );
            }
          }

          wasm._hb_buffer_add_utf16(buffer, block, text.length, 0, text.length);
          // Explicit properties BEFORE the guess, because `guess_segment_properties` only fills in
          // what is still invalid — so anything set here wins and the heuristic covers the rest.
          if (options.direction) {
            wasm._hb_buffer_set_direction(
              buffer,
              HB_DIRECTION[options.direction],
            );
          }
          if (script) {
            wasm._hb_buffer_set_script(
              buffer,
              wasm._hb_script_from_string(block + script.at, script.length),
            );
          }
          if (language) {
            wasm._hb_buffer_set_language(
              buffer,
              wasm._hb_language_from_string(
                block + language.at,
                language.length,
              ),
            );
          }
          wasm._hb_buffer_guess_segment_properties(buffer);

          wasm._hb_shape(
            font,
            buffer,
            features.length ? block + featuresAt : 0,
            features.length,
          );
          // FREED HERE AND NOT LATER. The buffer copied the code points in, and the features were
          // read during `hb_shape`; the glyph arrays below live in the buffer, not in this block.
          wasm._free(block);

          // The SILENT failure this catches: an allocation that failed anywhere inside
          // `add_utf16` or `hb_shape` leaves the buffer un-`successful` and EMPTY, which is
          // indistinguishable from "this run had no glyphs" at the call site.
          if (!wasm._hb_buffer_allocation_successful(buffer)) {
            return fail(
              "out-of-memory",
              `shaping a ${text.length}-code-unit run exhausted the wasm heap — the buffer came back empty, which is indistinguishable from a run with no glyphs and would render as missing text`,
            );
          }

          const count = wasm._hb_buffer_get_length(buffer);
          const infos = wasm._hb_buffer_get_glyph_infos(buffer, 0);
          const positions = wasm._hb_buffer_get_glyph_positions(buffer, 0);
          // CACHED ONLY HERE, AND ONLY BECAUSE NOTHING BELOW ALLOCATES. `glyphFor` re-reads
          // `wasm.HEAP32` on every access for the reason stated there — growth replaces the view
          // on some engines and not others. Everything that could grow the heap has already
          // happened by this line, and the loop only reads, so one lookup is safe here and a
          // per-glyph property read on a few hundred glyphs is not free.
          const heap = wasm.HEAP32;
          const run: HbGpuShapedGlyph[] = [];
          for (let i = 0; i < count; i += 1) {
            const info = (infos + i * GLYPH_INFO_BYTES) >> 2;
            const position = (positions + i * GLYPH_POSITION_BYTES) >> 2;
            run.push({
              // `>>> 0`: both are `uint32_t` in C and `HEAP32` is signed.
              glyphId: heap[info] >>> 0,
              cluster: heap[info + 2] >>> 0,
              // `hb_position_t` IS signed, so these are read as-is — a negative x_offset is how a
              // mark gets placed to the left of the glyph it hangs off.
              xAdvance: heap[position],
              yAdvance: heap[position + 1],
              xOffset: heap[position + 2],
              yOffset: heap[position + 3],
            });
          }
          return run;
        },

        encode(glyphId) {
          // Clear first. `hb_gpu_draw_encode` auto-clears on the way out, but a FAILED
          // `glyph_or_fail` leaves partial curves behind, and the next glyph would then encode
          // itself plus somebody else's strokes — which renders as a plausible glyph with a stray
          // mark, the hardest kind of error to trace.
          wasm._hb_gpu_draw_clear(draw);
          if (!wasm._hb_gpu_draw_glyph_or_fail(draw, font, glyphId)) {
            return null;
          }
          const blobPointer = wasm._hb_gpu_draw_encode(draw, scratch);
          if (!blobPointer) {
            return null;
          }
          const extents: HbGpuGlyphExtents = {
            xBearing: wasm.HEAP32[scratch >> 2],
            yBearing: wasm.HEAP32[(scratch >> 2) + 1],
            width: wasm.HEAP32[(scratch >> 2) + 2],
            height: wasm.HEAP32[(scratch >> 2) + 3],
          };
          const length = wasm._hb_blob_get_length(blobPointer);
          const data = wasm._hb_blob_get_data(blobPointer, 0);
          // `.slice`, not `.subarray`: the bytes are recycled on the very next line, and a view
          // onto a recycled allocation is a texel stream that changes under the caller.
          const texels = wasm.HEAPU8.slice(data, data + length);
          // RECYCLED, not destroyed. The encoder keeps one blob's allocation for reuse, so a run
          // of a few hundred Han glyphs makes a few hundred encodes out of one buffer.
          wasm._hb_gpu_draw_recycle_blob(draw, blobPointer);
          return { texels, extents };
        },

        destroy() {
          if (!alive) return;
          alive = false;
          fonts.delete(self);
          wasm._hb_buffer_destroy(buffer);
          wasm._hb_gpu_draw_destroy(draw);
          wasm._free(scratch);
          wasm._hb_font_destroy(font);
          wasm._hb_face_destroy(face);
          wasm._hb_blob_destroy(blob);
          // LAST. The blob was created READONLY over this pointer, so freeing it before the blob
          // is destroyed hands HarfBuzz a dangling face for the length of one more statement.
          wasm._free(dataPointer);
        },
      };
      fonts.add(self);
      return self;
    },

    destroy() {
      for (const font of [...fonts]) font.destroy();
    },
  };
}

/**
 * Total and per-glyph encoded bytes for a set of glyphs.
 *
 * THE PREDICTION UNDER TEST, made directly measurable. `docs/text-rendering.md` records it as
 * "~5.4 KB per Han glyph against ~1.4 KB for a 38x38 R8 atlas cell", and that comparison decides
 * the VRAM half of whether this arm is worth shipping — so it should be one call, on the real
 * fixture face, rather than something reconstructed from a frame counter.
 *
 * DISTINCT glyph ids, because that is what the atlas pays for too: a Han run draws 12 glyphs and an
 * atlas stores as many outlines as the pool has distinct members.
 */
export function measureBlobBytes(
  font: HbGpuFont,
  glyphIds: Iterable<number>,
): {
  glyphs: number;
  totalBytes: number;
  bytesPerGlyph: number;
  minBytes: number;
  maxBytes: number;
} {
  let glyphs = 0;
  let totalBytes = 0;
  let minBytes = Number.POSITIVE_INFINITY;
  let maxBytes = 0;
  for (const id of new Set(glyphIds)) {
    const encoded = font.encode(id);
    if (!encoded || encoded.texels.length === 0) continue;
    glyphs += 1;
    totalBytes += encoded.texels.length;
    minBytes = Math.min(minBytes, encoded.texels.length);
    maxBytes = Math.max(maxBytes, encoded.texels.length);
  }
  // MIN AND MAX, not just the mean, because the spread is the interesting part: measured on the
  // fixture's Han pool the mean is 4.26 KiB and the range is 376 B to 9568 B, a factor of 25. A
  // single average would suggest an atlas can be sized by multiplying it by a glyph count.
  return {
    glyphs,
    totalBytes,
    bytesPerGlyph: glyphs > 0 ? totalBytes / glyphs : 0,
    minBytes: glyphs > 0 ? minBytes : 0,
    maxBytes,
  };
}
