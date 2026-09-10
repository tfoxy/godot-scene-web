/**
 * The page half of `test/canvasGlyphPixelXvfb.test.ts`: draw lists that mix QUADS AND GLYPH RUNS
 * through `@godot-scene-web/canvas`'s WebGL2 executor, on a real GPU, read back with `readPixels`.
 *
 * WHY A BROWSER, when `packages/canvas/test/executor-glyphs.test.ts` already covers this seam.
 * That suite runs against `test/fake-gl.ts`, a RECORDING stand-in: it proves how many draws a frame
 * took, in what order the state around them was set, and what was bound — and it is blind to
 * everything that happens after the call returns. Nothing in it proves a single glyph PIXEL reaches
 * the framebuffer, that the run landed between the quads rather than under or over them, that the
 * scissor still clips a pass the executor deliberately does not re-scissor for, or that the blend
 * the pass left behind was really replaced rather than merely re-cached.
 *
 * WHY NOT `packages/hb-gpu/test/glyphPixelXvfb.test.ts`, which already draws glyphs on this GPU.
 * That file drives hb-gpu STANDALONE, on a canvas it owns, with no executor, no batcher, no clip
 * stack and no quads. Every failure below lives in the seam between the two packages and is
 * invisible from either side alone.
 *
 * WHAT IS READ. `gl.readPixels` on the stage's own drawing buffer, which holds PREMULTIPLIED bytes
 * by the package's contract — so the node side's expectations are premultiplied numbers, not what a
 * compositor would show over a page. Rows come back bottom-up and are flipped here, once, so every
 * coordinate on the node side is stated top-down in DEVICE pixels.
 *
 * NEVER `getImageData` ON THIS RUNG. An accelerated 2D canvas reads back blank under headed Xvfb
 * (see `packages/hb-gpu/test/browser-entry.ts`), which would make a working pipeline look like a
 * blank page. And the stage is `preserveDrawingBuffer: false`, so the readback has to happen in the
 * same task as the draw — which is why every case here is synchronous once the module has loaded.
 *
 * NO SHAPING. `HbGpuGlyphPass.glyphFor` maps a code point to a glyph id directly, which is all
 * these cases need: a handful of glyphs at pen positions this file chooses. Bringing npm
 * `harfbuzzjs` into the page would add a second HarfBuzz to prove nothing extra — the seam under
 * test starts at a glyph id.
 */

import {
  BLEND_MIX,
  BLEND_MUL,
  type BlendMode,
  type CanvasExecutor,
  type CanvasStage,
  type CanvasTextureCache,
  createCanvasExecutor,
  createCanvasStage,
  createClipRectView,
  createDrawList,
  createGlyphsView,
  createQuadView,
  createTextureCache,
  type DrawList,
  type ExecutorTexture,
} from "@godot-scene-web/canvas";
import {
  createHbGpuGlyphPass,
  GLYPH_SLOT_NONE,
  type GlyphFace,
  type HbGpuGlyphPass,
} from "@godot-scene-web/canvas/glyphs";
import {
  createHbGpu,
  type HbGpu,
  type HbGpuFailure,
} from "@godot-scene-web/hb-gpu";
import createHbGpuModule from "@godot-scene-web/hb-gpu/vendor/hb-gpu.mjs";

// THE CODE POINTS, AND WHY THEY ALL SIT UNDER U+59B7. The fixture face is subset by
// `scripts/ensure-cjk-font.ts` to ASCII, U+25A0, and `HAN_POOL_START` (U+4E00) plus
// `HAN_POOL_SIZE` (3000) — so U+4E00..U+59B7 and nothing above it. A code point outside that range
// maps to glyph 0, `.notdef`, which draws a tofu box in the right place: working-looking text that
// every ink assertion here would happily measure. `FrameContext.glyphFor` refuses id 0 for exactly
// that reason, so a re-subset that drops one of these fails loudly instead.

/** U+25A0 BLACK SQUARE: a solid rectangle, so "is this pixel ink" has no fuzzy answer. */
export const SOLID_BLOCK = 0x25a0;
/** U+4E4B (zhi): diagonals and a sweeping tail — a glyph that is mostly antialiased EDGE. */
export const CURVY_HAN = 0x4e4b;
/** Four visibly unlike Han outlines, for the eviction case: zhong, li, guo, zhi. */
export const DISTINCT_HAN = [0x4e2d, 0x529b, 0x56fd, 0x4e4b];

/** Where a run's own glyphs are pulled from when a case just needs filler in the atlas. */
const FILLER_HAN_START = 0x5000;

export interface FrameStats {
  width: number;
  height: number;
  /** `drawArraysInstanced` calls the EXECUTOR issued. Excludes the pass's own. */
  batches: number;
  quads: number;
  glyphRuns: number;
  glyphs: number;
  glyphDrawCalls: number;
  glyphRunsDropped: number;
  blendChanges: number;
  scissorChanges: number;
  /** `HbGpuGlyphPassStats`, flattened. `-1` when no pass was installed. */
  passRuns: number;
  passGlyphs: number;
  passReuploads: number;
  passDropped: number;
  passInkless: number;
  passSlots: number;
  passRunsBelowPpemFloor: number;
  /** `HbGpuRenderer.atlas`, flattened. `-1` when no pass was installed. */
  atlasEntries: number;
  atlasEvictions: number;
  atlasStaleSkips: number;
  atlasCapacityTexels: number;
  atlasLiveTexels: number;
  /** Refusals hb-gpu or the pass reported while this frame was built. */
  failures: string[];
}

export interface CaseFrame {
  width: number;
  height: number;
  /** RGBA bytes, TOP-DOWN, base64. Premultiplied, by the stage's contract. */
  rgbaBase64: string;
}

export interface GlyphPixelCaseResult {
  /** One entry per frame the case rendered; a case that needs a control renders both. */
  frames: Record<string, CaseFrame>;
  stats: Record<string, FrameStats>;
  /** The unmasked GL renderer, for the log. */
  renderer: string;
  /** Whatever the case wants to publish about how it was built. */
  notes: Record<string, number>;
}

// ---- module + font, loaded once ---------------------------------------------

let module: HbGpu | null = null;
let fontBytes: Uint8Array | null = null;

async function ensureModule(): Promise<{ module: HbGpu; font: Uint8Array }> {
  if (module && fontBytes) return { module, font: fontBytes };
  const [wasmBinary, font] = await Promise.all([
    fetch("/hb-gpu.wasm").then((r) => r.arrayBuffer()),
    fetch("/font.ttf").then((r) => r.arrayBuffer()),
  ]);
  const failures: HbGpuFailure[] = [];
  module = await createHbGpu(
    createHbGpuModule as unknown as Parameters<typeof createHbGpu>[0],
    wasmBinary,
    { onError: (failure) => failures.push(failure) },
  );
  if (!module) {
    throw new Error(
      `hb-gpu: the module would not instantiate — ${failures.map((f) => f.message).join("; ") || "(no reason reported)"}`,
    );
  }
  fontBytes = new Uint8Array(font);
  return { module, font: fontBytes };
}

// ---- one frame ---------------------------------------------------------------

/** What a case's builder is handed. Everything it needs and nothing that owns a lifetime. */
interface FrameContext {
  list: DrawList<ExecutorTexture | null>;
  /** `null` only in the frame that deliberately installs no pass. */
  pass: HbGpuGlyphPass | null;
  face: GlyphFace | null;
  white: ExecutorTexture;
  /** Glyph id for a code point, THROWING when the fixture face has none. */
  glyphFor(codepoint: number): number;
  /** A stable slot id, THROWING when the atlas refused a glyph that has ink. */
  slotFor(codepoint: number): number;
  notes: Record<string, number>;
}

interface FrameSpec {
  /** The scene's coordinate extent. */
  designWidth: number;
  designHeight: number;
  /** The drawing buffer to ask for. Equal to the design pair means a device-pixel ratio of 1. */
  bufferWidth?: number;
  bufferHeight?: number;
  /** Atlas capacity in texels. Small enough and a run's own glyphs evict each other. */
  atlasTexels?: number;
  /** Install the glyph pass. `false` is the wiring mistake `glyphRunsDropped` exists for. */
  withPass?: boolean;
  build(context: FrameContext): void;
}

let lastRenderer = "";

function rendererString(gl: WebGL2RenderingContext): string {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (!info) return "";
    return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "");
  } catch {
    return "";
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: spreading a 1.2 MB array into `String.fromCharCode` overflows the argument limit, as a
  // RangeError from inside the spread rather than anywhere near here.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Build one stage, run one draw list over it, and read the drawing buffer back.
 *
 * A STAGE PER FRAME. Nothing leaks between frames — not a program, not an atlas, not a cached blend
 * — so a control frame really is an independent rendering of the same thing rather than the same
 * GPU state asked twice.
 */
function renderFrame(
  spec: FrameSpec,
  mod: HbGpu,
  font: Uint8Array,
  notes: Record<string, number>,
): { frame: CaseFrame; stats: FrameStats } {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const stage: CanvasStage | null = createCanvasStage({
    canvas,
    designWidth: spec.designWidth,
    designHeight: spec.designHeight,
  });
  if (!stage) {
    canvas.remove();
    throw new Error("no WebGL2 context for the canvas stage");
  }
  stage.setStageSize(
    spec.bufferWidth ?? spec.designWidth,
    spec.bufferHeight ?? spec.designHeight,
  );
  const gl = stage.gl;
  lastRenderer = lastRenderer || rendererString(gl);

  const failures: HbGpuFailure[] = [];
  let textures: CanvasTextureCache | null = null;
  let pass: HbGpuGlyphPass | null = null;
  let executor: CanvasExecutor | null = null;
  try {
    textures = createTextureCache(gl);
    if (spec.withPass !== false) {
      pass = createHbGpuGlyphPass({
        gl,
        module: mod,
        designWidth: stage.designWidth,
        designHeight: stage.designHeight,
        // THE ACHIEVED BUFFER, not what the stage was asked for. This pair is `u_viewport`, which
        // is what `hb_gpu_dilate` measures half a SCREEN pixel against.
        framebufferWidth: gl.drawingBufferWidth,
        framebufferHeight: gl.drawingBufferHeight,
        atlasTexels: spec.atlasTexels,
        // Silenced: every run here is well over the ppem floor, and a warning nobody expects in a
        // pixel test reads as a failure. `passRunsBelowPpemFloor` still carries the tally.
        warnBelowPpemFloor: false,
        onError: (failure) => failures.push(failure),
      });
      if (!pass) {
        throw new Error(
          `the hb-gpu glyph pass refused to construct — ${failures.map((f) => `${f.reason}: ${f.message}`).join("; ") || "(no reason reported)"}`,
        );
      }
    }
    const face = pass ? pass.registerFace(font, "fixture") : null;
    if (pass && !face) {
      throw new Error("the hb-gpu glyph pass declined the fixture face");
    }

    executor = createCanvasExecutor({
      gl,
      white: textures.white(),
      glyphs: pass ?? undefined,
    });

    const list = createDrawList<ExecutorTexture | null>();
    const livePass = pass;
    const liveFace = face;
    const glyphFor = (codepoint: number): number => {
      if (!livePass || !liveFace) {
        throw new Error("glyphFor: this frame has no glyph pass");
      }
      const id = livePass.glyphFor(liveFace, codepoint);
      // 0 is `.notdef`. Drawing it would be a tofu box in the right place, which reads as working
      // text at a glance and would make every ink assertion below meaningless.
      if (!id) {
        throw new Error(
          `the fixture face has no glyph for U+${codepoint.toString(16).toUpperCase()}`,
        );
      }
      return id;
    };
    const slotFor = (codepoint: number): number => {
      if (!livePass || !liveFace) {
        throw new Error("slotFor: this frame has no glyph pass");
      }
      const slot = livePass.slotFor(liveFace, glyphFor(codepoint));
      if (slot === GLYPH_SLOT_NONE) {
        throw new Error(
          `the atlas issued no slot for U+${codepoint.toString(16).toUpperCase()} — a glyph with ink must get one`,
        );
      }
      return slot;
    };
    const context: FrameContext = {
      list,
      pass,
      face,
      white: textures.white(),
      glyphFor,
      slotFor,
      notes,
    };
    spec.build(context);

    if (!executor.execute(list, stage.projection())) {
      throw new Error("the canvas executor could not build its program");
    }

    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // `readPixels` is bottom-up. Flipping here, once, keeps a mirrored-image failure mode out of
    // the node side, where it would read as a huge registration error with no clue as to why.
    const flipped = new Uint8Array(raw.length);
    const stride = width * 4;
    for (let y = 0; y < height; y += 1) {
      flipped.set(
        raw.subarray((height - 1 - y) * stride, (height - y) * stride),
        y * stride,
      );
    }

    const stats = executor.stats;
    const passStats = pass?.stats ?? null;
    const atlas = pass?.renderer.atlas ?? null;
    return {
      frame: { width, height, rgbaBase64: toBase64(flipped) },
      stats: {
        width,
        height,
        batches: stats.batches,
        quads: stats.quads,
        glyphRuns: stats.glyphRuns,
        glyphs: stats.glyphs,
        glyphDrawCalls: stats.glyphDrawCalls,
        glyphRunsDropped: stats.glyphRunsDropped,
        blendChanges: stats.blendChanges,
        scissorChanges: stats.scissorChanges,
        passRuns: passStats?.runs ?? -1,
        passGlyphs: passStats?.glyphs ?? -1,
        passReuploads: passStats?.reuploads ?? -1,
        passDropped: passStats?.dropped ?? -1,
        passInkless: passStats?.inkless ?? -1,
        passSlots: passStats?.slots ?? -1,
        passRunsBelowPpemFloor: passStats?.runsBelowPpemFloor ?? -1,
        atlasEntries: atlas?.entries ?? -1,
        atlasEvictions: atlas?.evictions ?? -1,
        atlasStaleSkips: atlas?.staleSkips ?? -1,
        atlasCapacityTexels: atlas?.capacityTexels ?? -1,
        atlasLiveTexels: atlas?.liveTexels ?? -1,
        failures: failures.map((f) => `${f.reason}: ${f.message}`),
      },
    };
  } finally {
    executor?.dispose();
    pass?.dispose();
    textures?.dispose();
    stage.dispose();
    canvas.remove();
  }
}

// ---- draw-list helpers -------------------------------------------------------

/** A rectangle in design space, in one PREMULTIPLIED colour, under `blend`. */
function pushRect(
  context: FrameContext,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: readonly [number, number, number, number],
  blend: BlendMode = BLEND_MIX,
): void {
  const quad = createQuadView();
  quad.m.set([1, 0, 0, 1, x, y]);
  quad.w = w;
  quad.h = h;
  quad.srcW = 1;
  quad.srcH = 1;
  [quad.r, quad.g, quad.b, quad.a] = colour;
  quad.blend = blend;
  context.list.pushQuad(quad, context.white);
}

interface RunSpec {
  /** One pen position per code point, in design space, on the baseline. */
  pens: readonly (readonly [number, number])[];
  codepoints: readonly number[];
  /** Design units per em. */
  pixelsPerEm: number;
  /** PREMULTIPLIED colour for the whole run. */
  colour?: readonly [number, number, number, number];
  /** Pre-resolved slot ids, when the case allocated them itself (the eviction case). */
  slots?: readonly number[];
  /** Design units to grow every glyph by before filling. See `GlyphsView.spreadPx`. */
  spreadPx?: number;
}

/** Record one glyph run. */
function pushRun(context: FrameContext, spec: RunSpec): void {
  const count = spec.codepoints.length;
  const run = createGlyphsView(count);
  run.glyphCount = count;
  run.pixelsPerEm = spec.pixelsPerEm;
  run.spreadPx = spec.spreadPx ?? 0;
  const [r, g, b, a] = spec.colour ?? [1, 1, 1, 1];
  run.r = r;
  run.g = g;
  run.b = b;
  run.a = a;
  for (let i = 0; i < count; i += 1) {
    run.slots[i] = spec.slots
      ? spec.slots[i]
      : context.slotFor(spec.codepoints[i]);
    run.positions[i * 2] = spec.pens[i][0];
    run.positions[i * 2 + 1] = spec.pens[i][1];
  }
  context.list.pushGlyphs(run);
}

// ---- the cases ---------------------------------------------------------------

/** The square stage every 1:1 case uses. Design units ARE device pixels here. */
const STAGE = 128;

const RED: [number, number, number, number] = [1, 0, 0, 1];
const GREEN: [number, number, number, number] = [0, 1, 0, 1];
const BLUE: [number, number, number, number] = [0, 0, 1, 1];
const WHITE: [number, number, number, number] = [1, 1, 1, 1];
/** Premultiplied HALF-alpha mid grey: straight (0.5, 0.5, 0.5) at alpha 0.5. */
const HALF_GREY: [number, number, number, number] = [0.25, 0.25, 0.25, 0.5];

/**
 * A solid block glyph big enough to straddle the stage's midline.
 *
 * SLOT 0 EXPLICITLY WHEN THERE IS NO PASS, because a frame with no pass has nothing to issue ids —
 * and the missing-pass case needs the two frames it compares to carry the BYTE-IDENTICAL draw list,
 * so the id cannot be conjured differently on the two sides. 0 is what `slotFor` hands out for the
 * first glyph of a fresh pass, so the lists really are the same.
 */
function blockRun(
  context: FrameContext,
  colour: readonly [number, number, number, number],
): void {
  pushRun(context, {
    codepoints: [SOLID_BLOCK],
    pens: [[20, 104]],
    pixelsPerEm: 96,
    colour,
    slots: context.pass ? undefined : [0],
  });
}

/** The two overlapping quads the interleaving and missing-pass cases share. */
function interleavingQuads(context: FrameContext): {
  before(): void;
  after(): void;
} {
  return {
    before: () => pushRect(context, 0, 0, STAGE, STAGE, RED),
    after: () => pushRect(context, 0, STAGE / 2, STAGE, STAGE / 2, BLUE),
  };
}

const CASES: Record<
  string,
  (mod: HbGpu, font: Uint8Array) => GlyphPixelCaseResult
> = {
  /**
   * QUAD, RUN, QUAD — with all three overlapping, so the pixels say where the run landed.
   *
   * This is the whole premise of a same-context glyph command rather than an overlay canvas: the
   * run has to composite BETWEEN two quads that would otherwise merge into a single batch. Drawn
   * before the first quad, the block is painted over and the top half reads red; drawn after the
   * last, it survives into the bottom half where blue belongs. Both are perfectly plausible
   * pictures, which is why they need pixels rather than a call log.
   */
  interleave(mod, font) {
    const notes: Record<string, number> = {};
    const main = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        build(context) {
          const quads = interleavingQuads(context);
          quads.before();
          blockRun(context, GREEN);
          quads.after();
        },
      },
      mod,
      font,
      notes,
    );
    // The same run alone: the node side takes its fully covered pixels as the ink mask, so the
    // assertions above are stated over exactly the pixels the glyph really claims.
    const glyphOnly = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        build: (context) => blockRun(context, GREEN),
      },
      mod,
      font,
      notes,
    );
    return {
      frames: { main: main.frame, glyphOnly: glyphOnly.frame },
      stats: { main: main.stats, glyphOnly: glyphOnly.stats },
      renderer: lastRenderer,
      notes,
    };
  },

  /**
   * A CLIP RECT CUTS A RUN IN HALF.
   *
   * The executor never restores `SCISSOR_TEST` after the pass, precisely because the pass is
   * forbidden to touch it — so a clipped run needs no cooperation at all. That contract has exactly
   * one observable consequence and this is it. The clip is the TOP half, which also puts the
   * scissor's Y flip under the run: a flip that went the wrong way would clip a rect of exactly the
   * right size in the mirrored half, and read as a layout bug rather than a scissor bug.
   */
  clipped(mod, font) {
    const notes: Record<string, number> = {};
    const main = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        build(context) {
          const clip = createClipRectView();
          clip.x = 0;
          clip.y = 0;
          clip.w = STAGE;
          clip.h = STAGE / 2;
          context.list.pushClipRect(clip);
          blockRun(context, WHITE);
          context.list.popClip();
        },
      },
      mod,
      font,
      notes,
    );
    const unclipped = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        build: (context) => blockRun(context, WHITE),
      },
      mod,
      font,
      notes,
    );
    return {
      frames: { main: main.frame, unclipped: unclipped.frame },
      stats: { main: main.stats, unclipped: unclipped.stats },
      renderer: lastRenderer,
      notes,
    };
  },

  /**
   * A QUAD DRAWN AFTER A RUN COMPOSITES WITH THE EXECUTOR'S BLEND, NOT THE PASS'S.
   *
   * hb-gpu's `end` leaves the NON-separate `blendEquation`/`blendFunc` set to premultiplied MIX,
   * and the executor's `appliedBlend` cache has to be invalidated or the next quad silently keeps
   * it. MUL BOTH SIDES OF THE RUN IS THE ONLY WAY THIS CAN FAIL: with the same blend mode before
   * and after, a stale cache makes `applyBlend` an early return, so GL keeps hb-gpu's factors. Pick
   * MIX for the quads and the leftover is byte-identical to what the executor would have set;
   * change the mode across the run and `applyBlend` fires whatever the cache says.
   *
   * Over an OPAQUE WHITE background, the three outcomes are far apart: MUL gives 0.25*1.0 = 64 at
   * alpha 128, the MIX leftover gives 0.25 + 1.0*0.5 = 191 at alpha 255, and a quad that never drew
   * at all (the VAO left unbound) leaves the background's own 255.
   */
  blendAfterPass(mod, font) {
    const notes: Record<string, number> = {};
    const main = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        build(context) {
          pushRect(context, 0, 0, STAGE, STAGE, WHITE);
          pushRect(context, 8, 8, 48, 32, HALF_GREY, BLEND_MUL);
          // Well below both sample rects: the run is here to dirty the context, not to be measured.
          pushRun(context, {
            codepoints: [SOLID_BLOCK],
            pens: [[40, 120]],
            pixelsPerEm: 48,
            colour: GREEN,
          });
          pushRect(context, 72, 8, 48, 32, HALF_GREY, BLEND_MUL);
        },
      },
      mod,
      font,
      notes,
    );
    return {
      frames: { main: main.frame },
      stats: { main: main.stats },
      renderer: lastRenderer,
      notes,
    };
  },

  /**
   * PREMULTIPLIED COVERAGE SURVIVES THE WHOLE PATH: `vec4(rgb*a, a)` in the buffer.
   *
   * An OPAQUE WHITE run over a cleared (transparent black) buffer, so every partially covered pixel
   * must hold `rgb == a`. A fragment writing STRAIGHT colour would hold 255 in every covered pixel
   * whatever its coverage — correct over black, blown out over anything else, and invisible in a
   * screenshot of a dark page. A curved Han glyph, because a run of axis-aligned blocks at whole
   * pixel positions can have no partially covered pixels at all.
   */
  premultiplied(mod, font) {
    const notes: Record<string, number> = {};
    const main = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        build: (context) =>
          pushRun(context, {
            codepoints: [CURVY_HAN],
            pens: [[16, 104]],
            pixelsPerEm: 96,
            colour: WHITE,
          }),
      },
      mod,
      font,
      notes,
    );
    return {
      frames: { main: main.frame },
      stats: { main: main.stats },
      renderer: lastRenderer,
      notes,
    };
  },

  /**
   * DEVICE-PIXEL RATIO 2: a 320x240 design space in a 640x480 drawing buffer.
   *
   * The two halves of `StageProjection` are different numbers here for the first time, and each one
   * feeds a different thing: `toClip` places the run, and the framebuffer pair is `u_viewport`,
   * which is what `hb_gpu_dilate` measures half a SCREEN pixel against. The control renders the
   * SAME glyphs at the same DEVICE size and position out of a 640x480 design space at ratio 1, so
   * the two frames should be near-identical and every metric on the node side is a comparison
   * rather than a threshold picked from nowhere.
   */
  dprUp(mod, font) {
    const notes: Record<string, number> = { scale: 2 };
    // Three glyphs, so a per-glyph scale or advance error shows up as a spread rather than as one
    // displaced blob the registration search would simply follow.
    const codepoints = DISTINCT_HAN.slice(0, 3);
    const twoX = renderFrame(
      {
        designWidth: 320,
        designHeight: 240,
        bufferWidth: 640,
        bufferHeight: 480,
        build: (context) =>
          pushRun(context, {
            codepoints,
            pens: [
              [60, 140],
              [100, 140],
              [140, 140],
            ],
            pixelsPerEm: 32,
            colour: WHITE,
          }),
      },
      mod,
      font,
      notes,
    );
    const oneX = renderFrame(
      {
        designWidth: 640,
        designHeight: 480,
        build: (context) =>
          pushRun(context, {
            codepoints,
            pens: [
              [120, 280],
              [200, 280],
              [280, 280],
            ],
            pixelsPerEm: 64,
            colour: WHITE,
          }),
      },
      mod,
      font,
      notes,
    );
    return {
      frames: { twoX: twoX.frame, oneX: oneX.frame },
      stats: { twoX: twoX.stats, oneX: oneX.stats },
      renderer: lastRenderer,
      notes,
    };
  },

  /**
   * DEVICE-PIXEL RATIO 1/4: a 1280x960 design space in a 320x240 drawing buffer.
   *
   * THE DIRECTION IN WHICH A WRONG `u_viewport` IS VISIBLE, and the reason this arm exists next to
   * `dprUp`. `hb_gpu_dilate` grows the quad outward so the outline's antialiased rim is not clipped
   * by the quad's own edge, and the fragment computes exact coverage inside it — so dilating TOO
   * FAR only adds fragments whose coverage is zero, and `dprUp` is measurably blind to it. Feed the
   * design size to `u_viewport` when the buffer is SMALLER than design and the dilation comes out
   * too small instead, which clips the rim the shader was told to protect.
   *
   * 1/4 RATHER THAN 1/2 BECAUSE IT WAS MEASURED: at 1/2 the same fault reads RMS 0.70 and 0.24% of
   * the ink, at 1/4 it reads 1.79 and 0.60%. The damage saturates as the dilation goes to zero, so
   * 1/8 would buy almost nothing more. A scene drawn at quarter size is an ordinary thing for a
   * consumer to ask for; see the node side's budget note for the full table.
   *
   * Same control shape as `dprUp`: the identical glyphs at the identical device size out of a 1:1
   * stage. Every ratio here is a power of two on purpose — that is what makes the two arms
   * bit-identical rather than merely close.
   */
  dprDown(mod, font) {
    const notes: Record<string, number> = { scale: 0.25 };
    const codepoints = DISTINCT_HAN.slice(0, 3);
    const quarterX = renderFrame(
      {
        designWidth: 1280,
        designHeight: 960,
        bufferWidth: 320,
        bufferHeight: 240,
        build: (context) =>
          pushRun(context, {
            codepoints,
            pens: [
              [240, 560],
              [400, 560],
              [560, 560],
            ],
            pixelsPerEm: 128,
            colour: WHITE,
          }),
      },
      mod,
      font,
      notes,
    );
    const oneX = renderFrame(
      {
        designWidth: 320,
        designHeight: 240,
        build: (context) =>
          pushRun(context, {
            codepoints,
            pens: [
              [60, 140],
              [100, 140],
              [140, 140],
            ],
            pixelsPerEm: 32,
            colour: WHITE,
          }),
      },
      mod,
      font,
      notes,
    );
    return {
      frames: { quarterX: quarterX.frame, oneX: oneX.frame },
      stats: { quarterX: quarterX.stats, oneX: oneX.stats },
      renderer: lastRenderer,
      notes,
    };
  },

  /**
   * AN EVICTED SLOT IS RE-UPLOADED, ON A REAL DRIVER.
   *
   * `packages/canvas/test/glyph-pass-hbgpu.test.ts` proves the bookkeeping against a fake context:
   * a miss re-encodes and re-uploads instead of handing hb-gpu a dead offset. What it cannot prove
   * is that the texels really go back into the texture and the shader really reads THEM — a
   * `texSubImage2D` at the wrong offset, or a draw ordered ahead of it, would put a DIFFERENT
   * glyph's outline at the right size, in the right place, perfectly antialiased. So this renders
   * the same four glyphs twice, once through an atlas far too small to hold them and once through
   * one that never evicts, and the node side asks for the same picture.
   *
   * THE FILLER IS WHAT MAKES THE EVICTION HAPPEN, and it also keeps the re-uploads safe: the ring
   * refuses to overwrite a glyph already drawn in the current frame, so the resident set at draw
   * time must be at least as large as the run. Filler glyphs are pushed until every run glyph is
   * gone, and `atlasEntries` is published so the node side can check that margin rather than assume
   * it.
   */
  eviction(mod, font) {
    const notes: Record<string, number> = {};
    const pens: [number, number][] = [
      [14, 50],
      [78, 50],
      [14, 114],
      [78, 114],
    ];
    const build = (context: FrameContext): void => {
      pushRun(context, {
        codepoints: DISTINCT_HAN,
        pens,
        pixelsPerEm: 28,
        colour: WHITE,
      });
    };
    const big = renderFrame(
      { designWidth: STAGE, designHeight: STAGE, build },
      mod,
      font,
      notes,
    );
    const small = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        // ONE atlas row. A Han outline is a few hundred texels, so this holds a handful.
        atlasTexels: 4096,
        build(context) {
          const pass = context.pass;
          const face = context.face;
          if (!pass || !face) throw new Error("eviction: no pass installed");
          const slots = DISTINCT_HAN.map((cp) => context.slotFor(cp));
          const glyphIds = DISTINCT_HAN.map((cp) => context.glyphFor(cp));
          let filler = 0;
          const resident = (): number =>
            glyphIds.filter((id) => pass.renderer.resolve(face.face, id))
              .length;
          while (resident() > 0 && filler < 400) {
            const id = pass.glyphFor(face, FILLER_HAN_START + filler);
            filler += 1;
            if (id) pass.slotFor(face, id);
          }
          if (resident() > 0) {
            throw new Error(
              `eviction: ${resident()} of the run's glyphs are still resident after ${filler} filler glyphs — the atlas is not small enough for this case to mean anything`,
            );
          }
          context.notes.fillerGlyphs = filler;
          context.notes.residentBeforeRun = pass.renderer.atlas.entries;
          pushRun(context, {
            codepoints: DISTINCT_HAN,
            pens,
            pixelsPerEm: 28,
            colour: WHITE,
            slots,
          });
        },
      },
      mod,
      font,
      notes,
    );
    return {
      frames: { small: small.frame, big: big.frame },
      stats: { small: small.stats, big: big.stats },
      renderer: lastRenderer,
      notes,
    };
  },

  /**
   * AN OUTLINED LABEL THROUGH THE WHOLE STACK: `GlyphsView.spreadPx` -> draw list -> executor ->
   * pass -> `HbGpuRenderer.setSpread` -> the fragment shader's tap disk.
   *
   * WHAT THIS COVERS THAT `packages/hb-gpu/test/glyphPixelXvfb.test.ts` CANNOT. That file drives
   * the renderer directly and calls `setSpread` itself, so it proves the SHADER dilates. It says
   * nothing about the seam this file owns: the spread is a float in a packed arena, written by
   * `pushGlyphs` and read back by `readGlyphs` at an offset both derive from the same header
   * stride. Write it and never read it — or read it from the slot the alpha channel lives in — and
   * the outline silently does not appear, or the run silently draws at the wrong colour. Both are
   * pictures; neither throws.
   *
   * A SOLID BLOCK (U+25A0) rather than a Han glyph, because the whole assertion is geometric: its
   * ink is a rectangle, so "the ink box grew by the spread on every side" is exact rather than a
   * threshold, and its interior is large enough that the shader's saturation early-out is really
   * the path most fragments take.
   */
  outlined(mod, font) {
    const notes: Record<string, number> = { spreadPx: 6 };
    const block = (
      colour: readonly [number, number, number, number],
      spreadPx: number,
    ) => ({
      codepoints: [SOLID_BLOCK],
      pens: [[32, 96]] as [number, number][],
      pixelsPerEm: 64,
      colour,
      spreadPx,
    });
    const plain = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        build: (context) => pushRun(context, block(WHITE, 0)),
      },
      mod,
      font,
      notes,
    );
    const spread = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        build: (context) => pushRun(context, block(WHITE, notes.spreadPx)),
      },
      mod,
      font,
      notes,
    );
    // OUTLINE UNDER FILL, IN ONE LIST, IN THAT ORDER — two `glyphs` commands, so this also says the
    // executor issues them as two passes in list order rather than merging or reordering them.
    const overlay = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        build(context) {
          pushRun(context, block(RED, notes.spreadPx));
          pushRun(context, block(WHITE, 0));
        },
      },
      mod,
      font,
      notes,
    );
    return {
      frames: {
        plain: plain.frame,
        spread: spread.frame,
        overlay: overlay.frame,
      },
      stats: {
        plain: plain.stats,
        spread: spread.stats,
        overlay: overlay.stats,
      },
      renderer: lastRenderer,
      notes,
    };
  },

  /**
   * A `DRAW_GLYPHS` COMMAND WITH NO PASS INSTALLED DRAWS NOTHING AND DISTURBS NOTHING.
   *
   * The wiring mistake — a consumer that never passed `glyphs` — whose only symptom is a page that
   * renders perfectly except for having no words on it. Three frames say the whole thing: `noPass`
   * must equal `quadsOnly` byte for byte (nothing drawn, nothing disturbed, and no batch broken to
   * accomplish it), and must DIFFER from `withPass` (so the run really would have been visible and
   * the first equality is not vacuous).
   */
  missingPass(mod, font) {
    const notes: Record<string, number> = {};
    const withRun = (context: FrameContext): void => {
      const quads = interleavingQuads(context);
      quads.before();
      blockRun(context, GREEN);
      quads.after();
    };
    const noPass = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        withPass: false,
        build: withRun,
      },
      mod,
      font,
      notes,
    );
    const withPass = renderFrame(
      { designWidth: STAGE, designHeight: STAGE, build: withRun },
      mod,
      font,
      notes,
    );
    const quadsOnly = renderFrame(
      {
        designWidth: STAGE,
        designHeight: STAGE,
        withPass: false,
        build(context) {
          const quads = interleavingQuads(context);
          quads.before();
          quads.after();
        },
      },
      mod,
      font,
      notes,
    );
    return {
      frames: {
        noPass: noPass.frame,
        withPass: withPass.frame,
        quadsOnly: quadsOnly.frame,
      },
      stats: {
        noPass: noPass.stats,
        withPass: withPass.stats,
        quadsOnly: quadsOnly.stats,
      },
      renderer: lastRenderer,
      notes,
    };
  },
};

export function listGlyphPixelCases(): string[] {
  return Object.keys(CASES);
}

export async function runGlyphPixelCase(
  name: string,
): Promise<GlyphPixelCaseResult> {
  const build = CASES[name];
  if (!build) throw new Error(`unknown canvas glyph pixel case "${name}"`);
  const { module: mod, font } = await ensureModule();
  return build(mod, font);
}

declare global {
  interface Window {
    __gswCanvasGlyphPixel: {
      run(name: string): Promise<GlyphPixelCaseResult>;
      cases(): string[];
    };
  }
}

window.__gswCanvasGlyphPixel = {
  run: runGlyphPixelCase,
  cases: listGlyphPixelCases,
};
