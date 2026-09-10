// The page half of `glyphPixelXvfb.test.ts`: encode one glyph, upload it, draw it, read it back.
//
// Everything here runs inside a real Chromium with a real GPU. It is deliberately thin — it makes
// no judgement about the pixels it produces, because the reference it is judged against is built
// in node and comparing them is the test's job, not the page's.
//
// `gl.readPixels` ON THE DRAWING BUFFER, in the same task as the draw. The context is
// `preserveDrawingBuffer: false`, so once the frame is composited the buffer is gone and a later
// readback returns nothing. And never `getImageData` on a 2D canvas: on the headed-Xvfb rung an
// accelerated 2D canvas reads back alpha 0 (`text-hb.ts` lines 26-29), which would make a
// perfectly working pipeline look like a blank page.
//
// THE CONTEXT IS OPENED HERE, BY HAND, AND NOT VIA `createCanvasStage`. `@godot-scene-web/hb-gpu`
// has no workspace dependencies — `canvas` depends on IT, not the other way round — so this page
// cannot import the stage without putting the edge back. {@link CONTEXT_ATTRIBUTES} therefore
// restates `present.ts`'s attributes, and `premultipliedAlpha: true` is the one that decides
// whether the "writes PREMULTIPLIED coverage" assertion is measuring the shader or the compositor.

import {
  createHbGpu,
  type HbGpu,
  type HbGpuFailure,
  type HbGpuFont,
  measureBlobBytes,
} from "../src/index";
import {
  createHbGpuRenderer,
  type GlyphSlot,
  HB_GPU_CONTRAST_NONE,
  type HbGpuFace,
  type HbGpuRenderer,
  type HbGpuRendererOptions,
} from "../src/webgl";
import createHbGpuModule from "../vendor/hb-gpu.mjs";
import {
  CONTRAST_CASE,
  CONTRAST_OUTLINE_PX,
  contrastPens,
  GLYPH_CASES,
  GODOT_OUTLINE_CASES,
  modelFor,
  SPREAD_CASE,
  SPREAD_LOWPPEM_CASE,
  SPREAD_LOWPPEM_PX,
  SPREAD_PX,
  SPREAD_THIN_CASE,
  SPREAD_THIN_PX,
} from "./geometry";

/**
 * `STAGE_CONTEXT_ATTRIBUTES` from `packages/canvas/src/present.ts`, restated rather than imported.
 *
 * `premultipliedAlpha: true` is the contract the fragment shader writes against: it emits
 * `vec4(rgb * a * cov, a * cov)`, and a straight-alpha canvas would multiply by alpha a second time
 * — silently, as a merely darker picture. `preserveDrawingBuffer: false` is why the readback has to
 * happen in the same task as the draw. `antialias: false` because there is no geometry to
 * multisample; every edge here is the fragment shader's own coverage.
 */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  stencil: false,
  depth: false,
  antialias: false,
  preserveDrawingBuffer: false,
};

/**
 * WHY EVERY GRADED PROBE IN THIS FILE TURNS THE SHIPPED CONTRAST CURVE OFF.
 *
 * `createHbGpuRenderer` defaults `contrast` to stem darkening ON, because that is what a product
 * wants. Every probe below except {@link contrastProbe} grades a frame against an 8x area-coverage
 * reference rasterised in node — the fill cases against the filled outline, the low-ppem spread
 * against `outline (+) disk(r)` — and a contrast curve is by construction a departure FROM area
 * coverage. Left on, the RMS budgets and the ink ratios in `glyphPixelXvfb.test.ts` would be
 * measuring the curve rather than the upload, the dilation or the tap set, and the recorded
 * outline-study numbers (rim RMS 77.9, ink 36102 against an ideal 58081) would stop being
 * comparable across the changes they exist to bound.
 *
 * So the curve gets its own probe and its own assertions, and everything else is raw coverage.
 * That is the same split `packages/perf-harness/src/scenarios/text-gpu.ts` makes, for the same
 * reason, and it is stated in both places because either one alone would look like an oversight.
 */
const GRADED_AGAINST_COVERAGE = HB_GPU_CONTRAST_NONE;

/** A canvas of exactly `size` device pixels, its context, and the failures hb-gpu reported. */
function openContext(size: number): {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
} {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  document.body.appendChild(canvas);
  const gl = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
  if (!gl) {
    canvas.remove();
    throw new Error("hb-gpu: this browser gave no WebGL2 context");
  }
  return { canvas, gl };
}

export interface GlyphCaseResult {
  width: number;
  height: number;
  /** RGBA bytes, TOP-DOWN, base64. Premultiplied, by the stage's contract. */
  rgbaBase64: string;
  renderer: string;
  glyphId: number;
  upem: number;
  blobBytes: number;
  /** Bytes of the filler allocation that forces a row-spanning upload. */
  padBytes: number;
  /** Absolute texel offset the glyph landed at — deliberately not 0. */
  glyphLoc: number;
  atlasLiveBytes: number;
  atlasReservationBytes: number;
  atlasEntries: number;
  heapBytes: number;
  instances: number;
  drawCalls: number;
}

export interface BlobByteMeasurement {
  glyphs: number;
  totalBytes: number;
  bytesPerGlyph: number;
  minBytes: number;
  maxBytes: number;
}

let module: HbGpu | null = null;
let font: HbGpuFont | null = null;

async function ensureModule(): Promise<{ module: HbGpu; font: HbGpuFont }> {
  if (module && font) return { module, font };
  const [wasmBinary, fontBytes] = await Promise.all([
    fetch("/hb-gpu.wasm").then((r) => r.arrayBuffer()),
    fetch("/font.ttf").then((r) => r.arrayBuffer()),
  ]);
  const failures: HbGpuFailure[] = [];
  module = await createHbGpu(
    createHbGpuModule as unknown as Parameters<typeof createHbGpu>[0],
    wasmBinary,
    { onError: (failure) => failures.push(failure) },
  );
  // Construct-or-null since Phase 1B: a corrupt or detached face comes back as `null` with a named
  // reason instead of a throw. The page turns it back into a throw because there is nothing to
  // degrade TO here — a test that quietly rendered no glyph would pass every ink assertion it has.
  font = module.createFont(new Uint8Array(fontBytes));
  if (!font) {
    throw new Error(
      `hb-gpu: createFont declined the fixture face — ${failures.map((f) => f.message).join("; ") || "(no reason reported)"}`,
    );
  }
  return { module, font };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` on a 36 KB array overflows the argument limit on some
  // engines, and does so as a RangeError from inside the spread rather than anywhere near here.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function run(name: string): Promise<GlyphCaseResult> {
  const item = GLYPH_CASES[name];
  if (!item) throw new Error(`hb-gpu: no case named "${name}"`);
  const { module: mod, font: face } = await ensureModule();

  const { canvas, gl } = openContext(item.size);
  let renderer: HbGpuRenderer | null = null;
  try {
    const failures: HbGpuFailure[] = [];
    renderer = createHbGpuRenderer(mod, {
      gl,
      // This canvas is sized in DEVICE pixels and nothing scales it, so design space IS the
      // drawing buffer and the framebuffer pair defaults to the same numbers. A DPR-scaled stage
      // would have to pass both — see `HbGpuRendererOptions.framebufferWidth`.
      designWidth: gl.drawingBufferWidth,
      designHeight: gl.drawingBufferHeight,
      // One glyph. Small enough that a leak in the allocator shows up as an eviction rather than
      // as an 8 MiB texture nobody notices.
      atlasTexels: 4096 * 2,
      // Graded against an 8x reference — see GRADED_AGAINST_COVERAGE.
      contrast: GRADED_AGAINST_COVERAGE,
      onError: (failure) => failures.push(failure),
    });
    if (!renderer) {
      throw new Error(
        `hb-gpu: the renderer refused to construct — ${failures.map((f) => `${f.reason}: ${f.message}`).join("; ") || "(no reason reported)"}`,
      );
    }
    const atlasWidth = renderer.atlasWidth;
    // ONE FACE, REGISTERED, and every key below is namespaced by it. The pad and the glyph under
    // test differ only by glyph id, which is exactly the ambiguity `registerFace` removes.
    const registered = renderer.registerFace(face, "fixture");
    if (!registered) {
      throw new Error(
        `hb-gpu: registerFace declined the fixture face (upem ${face.upem})`,
      );
    }

    const glyphId = face.glyphFor(item.text.codePointAt(0) ?? 0);
    if (!glyphId) {
      throw new Error(
        `hb-gpu: the fixture face has no glyph for U+${(item.text.codePointAt(0) ?? 0).toString(16)}`,
      );
    }
    const encoded = face.encode(glyphId);
    if (!encoded || encoded.texels.length === 0) {
      throw new Error(`hb-gpu: glyph ${glyphId} encoded to nothing`);
    }
    // THE PAD, AND THE TEST IS BLIND WITHOUT IT. Measured: with the glyph under test as the FIRST
    // allocation, its 333 texels sit at offset 0 and fit inside one 4096-wide row — so
    // `uploadTexels` runs exactly one loop iteration at `x = 0` and `source = 0`. Breaking the row
    // wrap (`x = 0` always) and breaking the `srcOffset` unit (elements vs bytes) then produced
    // BYTE-IDENTICAL frames to the correct code: rms 2.22 either way, on all three cases.
    //
    // Padding the cursor to just short of a row boundary makes the blob span two rows, so the
    // upload is two `texSubImage2D` calls with a non-zero `source` on the second and a non-zero
    // absolute `glyphLoc` on the quad. Those same two faults then destroy the glyph.
    //
    // Zeros, and never drawn — the pad exists to move the cursor, not to render.
    const texelCount = encoded.texels.length / 8;
    const padTexels = atlasWidth - Math.max(1, Math.floor(texelCount / 2));
    // Glyph id 0 is `.notdef` and is never the glyph under test (checked above), so this is a
    // distinct key in the same face rather than a made-up string.
    renderer.upload(registered, 0, {
      texels: new Uint8Array(padTexels * 8),
      extents: { xBearing: 0, yBearing: 0, width: 0, height: 0 },
    });

    const slot = renderer.upload(registered, glyphId, encoded);
    if (!slot) throw new Error(`hb-gpu: glyph ${glyphId} produced no slot`);
    if (
      slot.loc % atlasWidth === 0 ||
      (slot.loc % atlasWidth) + texelCount <= atlasWidth
    ) {
      throw new Error(
        `hb-gpu: the glyph landed at texel ${slot.loc} and does not span a row boundary — the row-wrap and srcOffset arithmetic would go untested`,
      );
    }

    renderer.setModel(modelFor(item));
    renderer.setColor(1, 1, 1, 1);
    renderer.begin();
    renderer.push(slot, item.originX, item.originY, item.pixelsPerEm);
    // THE VIEWPORT AND THE CLEAR ARE THE EMBEDDER'S SINCE PHASE 1A — `HbGpuRenderer.end` sets
    // neither, because a clear inside a glyph pass erases whatever the caller already drew. Here
    // that caller is this page, and it wants a transparent frame with only the glyph in it.
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const frame = renderer.end();

    const raw = new Uint8Array(item.size * item.size * 4);
    gl.readPixels(0, 0, item.size, item.size, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // `readPixels` reads BOTTOM-UP: row 0 of the result is the bottom of the image. Flipping here
    // rather than in the comparison keeps the mirrored-image failure mode out of the test, where
    // it would read as a huge registration error with no clue as to why.
    const flipped = new Uint8Array(raw.length);
    const stride = item.size * 4;
    for (let y = 0; y < item.size; y += 1) {
      flipped.set(
        raw.subarray((item.size - 1 - y) * stride, (item.size - y) * stride),
        y * stride,
      );
    }

    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      width: item.size,
      height: item.size,
      rgbaBase64: toBase64(flipped),
      renderer: debugInfo
        ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
        : "",
      glyphId,
      upem: face.upem,
      blobBytes: encoded.texels.length,
      padBytes: padTexels * 8,
      glyphLoc: slot.loc,
      atlasLiveBytes: renderer.atlas.liveBytes,
      atlasReservationBytes: renderer.atlas.reservationBytes,
      atlasEntries: renderer.atlas.entries,
      heapBytes: mod.heapBytes,
      instances: frame.instances,
      drawCalls: frame.drawCalls,
    };
  } finally {
    renderer?.dispose();
    canvas.remove();
  }
}

/**
 * Encode every distinct Han glyph of a pool and total the bytes.
 *
 * The VRAM half of the prediction, answered with no GL at all — which is also the fallback this
 * package would have shipped had the pipeline not come out correct.
 */
async function blobBytes(
  startCodepoint: number,
  count: number,
): Promise<BlobByteMeasurement> {
  const { font: face } = await ensureModule();
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const glyphId = face.glyphFor(startCodepoint + i);
    if (glyphId) ids.push(glyphId);
  }
  // `measureBlobBytes` from the package's own API, not a second loop here. This number goes into a
  // report next to `hb-atlas`'s 1.45 MiB, and two implementations of "sum the blobs" is two places
  // for the definition of "distinct glyph" to drift.
  return measureBlobBytes(face, ids);
}

export interface EvictionProbeResult {
  /** Glyphs offered to an atlas far too small to hold them all. */
  offered: number;
  entries: number;
  evictions: number;
  liveTexels: number;
  capacityTexels: number;
  /** Where the first glyph sat before it was evicted, and where it sat when re-uploaded. */
  firstOffsetBefore: number;
  firstOffsetAfter: number;
  /** What the in-use guard said when asked to overwrite a glyph already drawn this frame. */
  inUseGuard: string;
  /**
   * Instances that frame actually drew.
   *
   * MUST EQUAL {@link EvictionProbeResult.residentAtStaleFrame}, exactly. The generation guard is
   * the only thing between "this glyph is gone" and "draw a different glyph's outline at the right
   * size in the right place, perfectly antialiased", and nothing downstream — not ink, not
   * registration, not RMS — can tell those two apart. Before the guard it was every held slot.
   */
  staleFrameInstances: number;
  /** Pushes that frame declined. `heldSlots - residentAtStaleFrame`. */
  staleSkips: number;
  /** Slots held across the whole fill and then all pushed in one frame. */
  heldSlots: number;
  /** Allocations still resident when that frame ran — the held slots that are still real. */
  residentAtStaleFrame: number;
}

/**
 * Fill an atlas that cannot hold the working set, then ask it for the first glyph again.
 *
 * THE MECHANISM UPSTREAM DOES NOT HAVE. `demo_atlas_alloc` calls `die ("Ran out of atlas memory")`,
 * which is fine for a demo and is not a policy: a Han pool is thousands of outlines against a fixed
 * texture. This exercises both halves of the replacement — that the cursor wraps and evicts, and
 * that it REFUSES to evict a glyph already drawn in the current frame, because overwriting one of
 * those does not drop a glyph, it draws a different outline in its place at the right size and
 * position, which is unreadable text that looks like working text.
 */
async function evictionProbe(count: number): Promise<EvictionProbeResult> {
  const { module: mod, font: face } = await ensureModule();
  const { canvas, gl } = openContext(32);
  let renderer: HbGpuRenderer | null = null;
  try {
    const failures: HbGpuFailure[] = [];
    renderer = createHbGpuRenderer(mod, {
      gl,
      // This canvas is sized in DEVICE pixels and nothing scales it, so design space IS the
      // drawing buffer and the framebuffer pair defaults to the same numbers. A DPR-scaled stage
      // would have to pass both — see `HbGpuRendererOptions.framebufferWidth`.
      designWidth: gl.drawingBufferWidth,
      designHeight: gl.drawingBufferHeight,
      // One row. A Han glyph is ~330 texels, so this holds roughly a dozen.
      atlasTexels: 4096,
      // This probe compares one glyph's pixels against ANOTHER glyph's, so the curve would cancel
      // — but it is set anyway, so that "graded probes run raw coverage" is a property of the file
      // rather than of which probes somebody remembered.
      contrast: GRADED_AGAINST_COVERAGE,
      onError: (failure) => failures.push(failure),
    });
    if (!renderer) {
      throw new Error(
        `hb-gpu: the renderer refused to construct — ${failures.map((f) => f.message).join("; ") || "(no reason reported)"}`,
      );
    }
    const live = renderer;
    // TWO FACES OVER ONE FONT, and that is the namespacing under test. The guard pass below offers
    // the SAME glyph ids again; before Phase 1B those would have collided with the first pass's
    // keys and found the allocations already resident, which is a guard that never fires.
    const main = live.registerFace(face, "main");
    const guardFace = live.registerFace(face, "guard");
    if (!main || !guardFace) {
      throw new Error("hb-gpu: registerFace declined the fixture face");
    }

    const ids: number[] = [];
    for (let i = 0; ids.length < count; i += 1) {
      const glyphId = face.glyphFor(0x4e00 + i);
      if (glyphId && !ids.includes(glyphId)) ids.push(glyphId);
    }

    let firstOffsetBefore = -1;
    const heldSlots: GlyphSlot[] = [];
    for (const glyphId of ids) {
      const encoded = face.encode(glyphId);
      if (!encoded || encoded.texels.length === 0) continue;
      const slot = live.upload(main, glyphId, encoded);
      if (!slot) continue;
      if (firstOffsetBefore < 0) firstOffsetBefore = slot.loc;
      // HELD ON PURPOSE. These are exactly the stale handles a live app accumulates: a glyph cache
      // that keeps slots between frames while the ring wraps underneath it. The perf harness never
      // has any, because it pre-sizes the atlas to the entire working set — which is the thing a
      // live app cannot do, and the reason this failure survived a whole round undetected.
      heldSlots.push(slot);
    }

    // MOST SLOTS ABOVE ARE NOW STALE: `count` glyphs were offered to a one-row atlas that holds
    // about a dozen. Pushing all of them must draw exactly the ones still resident — `push`
    // compares the slot's generation and offset against the live allocation and skips on a
    // mismatch. Before that guard this frame drew every held slot, each one somebody else's
    // outline at the right size, in the right place, perfectly antialiased.
    const residentAtStaleFrame = live.atlas.entries;
    const staleSkipsBefore = live.atlas.staleSkips;
    live.begin();
    for (const slot of heldSlots) live.push(slot, 16, 16, 14);
    const staleFrame = live.end();
    const staleSkips = live.atlas.staleSkips - staleSkipsBefore;

    // A FRESH, EMPTY FRAME BEFORE ALLOCATING AGAIN. The pushes above marked the surviving
    // allocations as drawn in that frame, and the in-use guard would then refuse the re-upload
    // below for the right reason at the wrong moment.
    live.begin();

    // The first glyph is long gone; re-uploading it must allocate afresh somewhere else rather
    // than hand back a stale offset into space some other glyph now owns.
    const firstEncoded = face.encode(ids[0]);
    const firstSlot = firstEncoded && live.upload(main, ids[0], firstEncoded);
    const after = live.atlas;

    // The guard: draw one glyph this frame, then keep allocating until the ring comes round to it.
    let inUseGuard = "(not triggered)";
    try {
      live.begin();
      if (firstSlot) live.push(firstSlot, 16, 16, 14);
      for (const glyphId of ids) {
        const encoded = face.encode(glyphId);
        if (!encoded || encoded.texels.length === 0) continue;
        live.upload(guardFace, glyphId, encoded);
      }
    } catch (error) {
      inUseGuard = error instanceof Error ? error.message : String(error);
    }

    return {
      offered: ids.length,
      entries: after.entries,
      evictions: after.evictions,
      liveTexels: after.liveTexels,
      capacityTexels: after.capacityTexels,
      firstOffsetBefore,
      firstOffsetAfter: firstSlot ? firstSlot.loc : -1,
      inUseGuard,
      staleFrameInstances: staleFrame.instances,
      staleSkips,
      heldSlots: heldSlots.length,
      residentAtStaleFrame,
    };
  } finally {
    renderer?.dispose();
    canvas.remove();
  }
}

export interface SpreadProbeResult {
  width: number;
  height: number;
  /** The object-space spread every dilated frame below was drawn with. */
  spreadPx: number;
  pixelsPerEm: number;
  glyphId: number;
  /** RGBA bytes per frame, TOP-DOWN, base64. Premultiplied, by the stage's contract. */
  frames: Record<string, string>;
  /** Instances the renderer reported per frame — a run that drew nothing must not read as a pass. */
  instances: Record<string, number>;
  /**
   * The DILATED quad in device px, `[x0, y0, x1, y1]`, top-down: the glyph's object-space ink box
   * grown by {@link SpreadProbeResult.spreadPx} on every side.
   *
   * Published because it is the exact region the "does the clamped band smear" assertion has to
   * cover. Every fragment the dilated draw can possibly touch is inside it, so ink OUTSIDE it would
   * be impossible and ink inside it but far from the glyph is the smear.
   */
  spreadQuad: [number, number, number, number];
  /** Offsets the N-copies emulation used. */
  copies: number;
  /**
   * The thin-feature pair: a full stop at a spread wider than its own dot.
   *
   * SEPARATE FROM THE FRAMES ABOVE because it is a different glyph at a different spread, and the
   * only case that can see a single-ring tap set at all — see {@link SPREAD_THIN_CASE}.
   */
  thin: {
    spreadPx: number;
    glyphId: number;
    /** `fill` and `spread`, same encoding as the main frames. */
    frames: Record<string, string>;
  };
  /**
   * The low-ppem pair: S9's own 14 px, 10-degree geometry at a 3 px spread.
   *
   * SEPARATE AGAIN, and the only frames in this probe that enter `_hb_gpu_slug`'s `ppem < 16`
   * branch — where one ring tap costs five `_hb_gpu_slug_single` evaluations. See
   * {@link SPREAD_LOWPPEM_CASE} for what the suite could not see before it existed. Graded against
   * an 8x DILATED reference in node rather than against the other frames, because the question is
   * how close the rim is to the true grown shape, not whether it changed.
   */
  lowPpem: {
    spreadPx: number;
    pixelsPerEm: number;
    glyphId: number;
    /** `fill` and `spread`, same encoding as the main frames. */
    frames: Record<string, string>;
    /**
     * The SAME two frames from a second renderer built with `spreadTapMsaa: true`.
     *
     * THE WHOLE POINT, AND WHY IT IS A SECOND RENDERER RATHER THAN A SECOND RUN. Two programs on
     * one context, one GPU, one glyph, one sub-pixel phase — so the only difference between
     * `frames` and these is the four extra `_hb_gpu_slug_single` evaluations inside each ring tap.
     * A comparison across two vitest runs, or across two perf runs at different frame counts, could
     * not say that: the runs would differ in translation phase as well, which is the trap the
     * screenshot comparison in `docs/perf-harness.md` had to be reported as qualitative for.
     *
     * It is also how "the branch fires here" becomes an assertion instead of an assumption. These
     * frames MUST differ from `frames` at this ppem and MUST be byte-identical at ppem 96, which is
     * exactly the claim `ppem < 16` makes.
     */
    msaaFrames: Record<string, string>;
    /** The ppem-96 pair from that same second renderer, where the branch must NOT fire. */
    msaaHighPpemFrames: Record<string, string>;
  };
}

/**
 * The frames the outline assertions are read off, all from ONE renderer on ONE canvas.
 *
 * ONE RENDERER ON PURPOSE, and not only to be cheap: the spread is sticky exactly like the colour
 * and the model matrix, so drawing a spread frame and then a plain one through the same instance is
 * the arrangement in which a missing `setSpread(0)` would show up. If this file only ever built a
 * fresh renderer per frame, that whole class of bug would be untestable from here.
 */
async function spreadProbe(): Promise<SpreadProbeResult> {
  const item = SPREAD_CASE;
  const { module: mod, font: face } = await ensureModule();
  const { canvas, gl } = openContext(item.size);
  let renderer: HbGpuRenderer | null = null;
  try {
    const failures: HbGpuFailure[] = [];
    renderer = createHbGpuRenderer(mod, {
      gl,
      designWidth: gl.drawingBufferWidth,
      designHeight: gl.drawingBufferHeight,
      atlasTexels: 4096 * 2,
      // Graded against an 8x DILATED reference — see GRADED_AGAINST_COVERAGE.
      contrast: GRADED_AGAINST_COVERAGE,
      onError: (failure) => failures.push(failure),
    });
    if (!renderer) {
      throw new Error(
        `hb-gpu: the renderer refused to construct — ${failures.map((f) => `${f.reason}: ${f.message}`).join("; ") || "(no reason reported)"}`,
      );
    }
    const live = renderer;
    const registered = live.registerFace(face, "fixture");
    if (!registered) throw new Error("hb-gpu: registerFace declined the face");

    const glyphId = face.glyphFor(item.text.codePointAt(0) ?? 0);
    if (!glyphId) {
      throw new Error(
        `hb-gpu: the fixture face has no glyph for "${item.text}"`,
      );
    }
    const encoded = face.encode(glyphId);
    if (!encoded || encoded.texels.length === 0) {
      throw new Error(`hb-gpu: glyph ${glyphId} encoded to nothing`);
    }
    const slot = live.upload(registered, glyphId, encoded);
    if (!slot) throw new Error(`hb-gpu: glyph ${glyphId} produced no slot`);

    live.setModel(modelFor(item));

    const scale = item.pixelsPerEm / slot.upem;
    const spreadQuad: [number, number, number, number] = [
      item.originX + scale * slot.minX - SPREAD_PX,
      // Object y measures DOWN and the em box is y-UP, so the em MAXIMUM is the visual top.
      item.originY - scale * slot.maxY - SPREAD_PX,
      item.originX + scale * slot.maxX + SPREAD_PX,
      item.originY - scale * slot.minY + SPREAD_PX,
    ];

    const frames: Record<string, string> = {};
    const instances: Record<string, number> = {};

    /** Clear, run `draw`, read the buffer back top-down. One frame, in one task. */
    const capture = (name: string, draw: () => number): void => {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      instances[name] = draw();
      const raw = new Uint8Array(item.size * item.size * 4);
      gl.readPixels(0, 0, item.size, item.size, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      const flipped = new Uint8Array(raw.length);
      const stride = item.size * 4;
      for (let y = 0; y < item.size; y += 1) {
        flipped.set(
          raw.subarray((item.size - 1 - y) * stride, (item.size - y) * stride),
          y * stride,
        );
      }
      frames[name] = toBase64(flipped);
    };

    /** One run of the one glyph, at `spread`, in one colour. Returns instances drawn. */
    const oneRun = (
      spread: number,
      rgba: [number, number, number, number],
      offsets: readonly (readonly [number, number])[] = [[0, 0]],
    ): number => {
      live.setSpread(spread);
      live.setColor(rgba[0], rgba[1], rgba[2], rgba[3]);
      live.begin();
      for (const [dx, dy] of offsets) {
        live.push(slot, item.originX + dx, item.originY + dy, item.pixelsPerEm);
      }
      return live.end().instances;
    };

    // THE CLEAR IS THE EMBEDDER'S — `end` never clears, because a clear inside a glyph pass erases
    // whatever the embedder already drew. Here the embedder is this function.
    capture("fill", () => oneRun(0, [1, 1, 1, 1]));
    capture("spread", () => oneRun(SPREAD_PX, [1, 1, 1, 1]));

    // OUTLINE UNDER FILL, THE WHOLE POINT OF THE FEATURE: the same glyph twice in one frame, red
    // dilated first, then opaque white on top at spread 0. A red pixel anywhere the plain fill is
    // solid would mean the second run did not cover the first.
    capture("overlay", () => {
      const outline = oneRun(SPREAD_PX, [1, 0, 0, 1]);
      return outline + oneRun(0, [1, 1, 1, 1]);
    });

    // TRANSLUCENT, ONE RUN. Half alpha at a spread: every fragment is blended exactly once, so no
    // pixel may exceed half alpha however many taps found ink.
    capture("translucentSpread", () => oneRun(SPREAD_PX, [1, 1, 1, 0.5]));

    // THE EMULATION THIS FEATURE EXISTS TO REPLACE: the same half-alpha run drawn at eight offsets
    // on a circle of radius `SPREAD_PX`, with NO spread. Each copy composites separately, so where
    // they overlap the alpha stacks as 1 - 0.5^n instead of staying at 0.5. Drawn here rather than
    // merely asserted about, so the contrast is a measurement.
    const copies = 8;
    const offsets: [number, number][] = [];
    for (let i = 0; i < copies; i += 1) {
      const angle = (2 * Math.PI * i) / copies;
      offsets.push([SPREAD_PX * Math.cos(angle), SPREAD_PX * Math.sin(angle)]);
    }
    capture("translucentCopies", () => oneRun(0, [1, 1, 1, 0.5], offsets));

    // AND BACK TO A PLAIN FILL THROUGH THE SAME RENDERER, LAST. `setSpread(0)` has to really undo
    // the spread; if it did not, this frame would differ from `fill` and the sticky-uniform note on
    // `setSpread` would be describing a one-way door.
    capture("fillAfterSpread", () => oneRun(0, [1, 1, 1, 1]));

    // THE THIN-FEATURE PAIR, on the same canvas and through the same renderer, LAST so it cannot
    // disturb the frames above. A full stop is a small isolated blob, so a tap ring wider than it
    // clears it entirely — which is the only shape of failure that tells concentric rings apart
    // from one ring. Drawn at the same buffer size, which `SPREAD_THIN_CASE` shares on purpose.
    const thinItem = SPREAD_THIN_CASE;
    if (thinItem.size !== item.size) {
      throw new Error(
        `hb-gpu: the spread cases share one canvas but ask for ${item.size} and ${thinItem.size}`,
      );
    }
    const thinGlyphId = face.glyphFor(thinItem.text.codePointAt(0) ?? 0);
    if (!thinGlyphId) {
      throw new Error(
        `hb-gpu: the fixture face has no glyph for "${thinItem.text}"`,
      );
    }
    const thinEncoded = face.encode(thinGlyphId);
    if (!thinEncoded || thinEncoded.texels.length === 0) {
      throw new Error(`hb-gpu: glyph ${thinGlyphId} encoded to nothing`);
    }
    const thinSlot = live.upload(registered, thinGlyphId, thinEncoded);
    if (!thinSlot) throw new Error("hb-gpu: the full stop produced no slot");
    const thinFrames: Record<string, string> = {};
    const drawThin = (spread: number) => (): number => {
      live.setSpread(spread);
      live.setColor(1, 1, 1, 1);
      live.begin();
      live.push(
        thinSlot,
        thinItem.originX,
        thinItem.originY,
        thinItem.pixelsPerEm,
      );
      return live.end().instances;
    };
    const mainFrameNames = Object.keys(frames);
    capture("thinFill", drawThin(0));
    capture("thinSpread", drawThin(SPREAD_THIN_PX));
    for (const name of Object.keys(frames)) {
      if (mainFrameNames.includes(name)) continue;
      thinFrames[name.replace("thin", "").toLowerCase()] = frames[name];
      delete frames[name];
    }

    // THE LOW-PPEM PAIR, last of all, and the only frames here that enter the `ppem < 16` branch.
    // Same canvas, same renderer; a DIFFERENT model matrix, because this case is rotated 10 degrees
    // and the two above are upright. `setModel` is sticky like the spread, so it is restated inside
    // the draw rather than once outside it — otherwise the case that runs after this one would
    // silently inherit a rotation. Nothing runs after it, which is exactly the assumption that
    // stops being true the moment somebody appends a frame.
    const lowItem = SPREAD_LOWPPEM_CASE;
    if (lowItem.size !== item.size) {
      throw new Error(
        `hb-gpu: the spread cases share one canvas but ask for ${item.size} and ${lowItem.size}`,
      );
    }
    const lowGlyphId = face.glyphFor(lowItem.text.codePointAt(0) ?? 0);
    if (!lowGlyphId) {
      throw new Error(
        `hb-gpu: the fixture face has no glyph for "${lowItem.text}"`,
      );
    }
    const lowEncoded = face.encode(lowGlyphId);
    if (!lowEncoded || lowEncoded.texels.length === 0) {
      throw new Error(`hb-gpu: glyph ${lowGlyphId} encoded to nothing`);
    }
    const lowSlot = live.upload(registered, lowGlyphId, lowEncoded);
    if (!lowSlot)
      throw new Error("hb-gpu: the low-ppem glyph produced no slot");
    const lowFrames: Record<string, string> = {};
    const drawLow = (spread: number) => (): number => {
      live.setModel(modelFor(lowItem));
      live.setSpread(spread);
      live.setColor(1, 1, 1, 1);
      live.begin();
      live.push(lowSlot, lowItem.originX, lowItem.originY, lowItem.pixelsPerEm);
      return live.end().instances;
    };
    const beforeLowNames = Object.keys(frames);
    capture("lowFill", drawLow(0));
    capture("lowSpread", drawLow(SPREAD_LOWPPEM_PX));
    for (const name of Object.keys(frames)) {
      if (beforeLowNames.includes(name)) continue;
      lowFrames[name.replace("low", "").toLowerCase()] = frames[name];
      delete frames[name];
    }

    // THE A/B: a SECOND renderer on the SAME context, differing in exactly one shader define.
    //
    // Its own atlas and its own program, which costs one more upload of one glyph — and buys a
    // comparison in which the GPU, the driver, the glyph, the transform and the sub-pixel phase are
    // all held fixed by construction. Anything that differs between its frames and the ones above
    // came from `spreadTapMsaa`, because nothing else can have.
    const msaaFrames: Record<string, string> = {};
    const msaaHighPpemFrames: Record<string, string> = {};
    const msaaFailures: HbGpuFailure[] = [];
    const msaaRenderer = createHbGpuRenderer(mod, {
      gl,
      designWidth: gl.drawingBufferWidth,
      designHeight: gl.drawingBufferHeight,
      atlasTexels: 4096 * 2,
      spreadTapMsaa: true,
      // MUST MATCH THE RENDERER IT IS COMPARED AGAINST. The whole claim of the A/B is that one
      // `#define` is the only difference between the two programs; a contrast curve on one side
      // would put a second one in and the RMS between them would stop naming the tap set.
      contrast: GRADED_AGAINST_COVERAGE,
      onError: (failure) => msaaFailures.push(failure),
    });
    if (!msaaRenderer) {
      throw new Error(
        `hb-gpu: the spreadTapMsaa renderer refused to construct — ${msaaFailures.map((f) => `${f.reason}: ${f.message}`).join("; ") || "(no reason reported)"}`,
      );
    }
    try {
      const msaaFace = msaaRenderer.registerFace(face, "fixture");
      if (!msaaFace) {
        throw new Error("hb-gpu: the second renderer declined the face");
      }
      const msaaLowSlot = msaaRenderer.upload(msaaFace, lowGlyphId, lowEncoded);
      const msaaHighSlot = msaaRenderer.upload(msaaFace, glyphId, encoded);
      if (!msaaLowSlot || !msaaHighSlot) {
        throw new Error("hb-gpu: the second renderer produced no slot");
      }
      // ONE HELPER FOR BOTH PPEMs, so the high-ppem control really is the same code path with one
      // number changed. If it were written twice, "identical at ppem 96" could be true because the
      // two were written to be.
      const drawOn =
        (
          renderer: HbGpuRenderer,
          drawSlot: GlyphSlot,
          drawItem: typeof item,
          spread: number,
        ) =>
        (): number => {
          renderer.setModel(modelFor(drawItem));
          renderer.setSpread(spread);
          renderer.setColor(1, 1, 1, 1);
          renderer.begin();
          renderer.push(
            drawSlot,
            drawItem.originX,
            drawItem.originY,
            drawItem.pixelsPerEm,
          );
          return renderer.end().instances;
        };
      const beforeMsaaNames = Object.keys(frames);
      capture("msaaLowFill", drawOn(msaaRenderer, msaaLowSlot, lowItem, 0));
      capture(
        "msaaLowSpread",
        drawOn(msaaRenderer, msaaLowSlot, lowItem, SPREAD_LOWPPEM_PX),
      );
      // The CONTROL, at 96 px per em on the "L": above ppem 16 the branch cannot fire, so this pair
      // must match the first renderer's `spread` frame byte for byte. Without it, "the two low-ppem
      // frames differ" would be equally consistent with the define changing something else.
      capture(
        "msaaHighSpread",
        drawOn(msaaRenderer, msaaHighSlot, item, SPREAD_PX),
      );
      for (const name of Object.keys(frames)) {
        if (beforeMsaaNames.includes(name)) continue;
        const key = name.replace("msaaLow", "").replace("msaaHigh", "");
        const target = name.startsWith("msaaHigh")
          ? msaaHighPpemFrames
          : msaaFrames;
        target[key.toLowerCase()] = frames[name];
        delete frames[name];
      }
    } finally {
      msaaRenderer.dispose();
    }

    return {
      width: item.size,
      height: item.size,
      spreadPx: SPREAD_PX,
      pixelsPerEm: item.pixelsPerEm,
      glyphId,
      frames,
      instances,
      spreadQuad,
      copies,
      thin: {
        spreadPx: SPREAD_THIN_PX,
        glyphId: thinGlyphId,
        frames: thinFrames,
      },
      lowPpem: {
        spreadPx: SPREAD_LOWPPEM_PX,
        pixelsPerEm: lowItem.pixelsPerEm,
        glyphId: lowGlyphId,
        frames: lowFrames,
        msaaFrames,
        msaaHighPpemFrames,
      },
    };
  } finally {
    renderer?.dispose();
    canvas.remove();
  }
}

/**
 * The gamma the third renderer is built with, and why it is not a plausible shipping value.
 *
 * 0.6 IS DELIBERATELY BLUNT. This probe is not calibrating a curve, it is proving that `gamma`
 * reaches the shader, that it is polarity-blind and that it is a SEPARATE lever from stem
 * darkening. A value near 1 would produce a difference of a level or two, which is the same size as
 * the framebuffer's own rounding — and an assertion that cannot tell those apart is not an
 * assertion. 0.6 moves a half-covered pixel from 128 to 168.
 */
const CONTRAST_PROBE_GAMMA = 0.6;

export interface ContrastProbeResult {
  width: number;
  height: number;
  /** Device px per em of the LOW pair, where stem darkening is at nearly full strength. */
  lowPixelsPerEm: number;
  /** How many glyphs the low frames carry — the sample size behind every count below. */
  lowGlyphs: number;
  /** Device px per em of the HIGH pair, past `smoothstep (8, 48, ppem)`'s upper knee. */
  highPixelsPerEm: number;
  lowGlyphId: number;
  highGlyphId: number;
  /** The `contrast.gamma` the gamma-only renderer was built with. */
  gamma: number;
  /** The dilation radius the `*Outline*` frames were drawn at — {@link CONTRAST_OUTLINE_PX}. */
  outlinePx: number;
  /**
   * RGBA bytes per frame, TOP-DOWN, base64. Names are `<renderer><case><colour>`:
   *
   *   `plain*`      `HB_GPU_CONTRAST_NONE` — the coverage the shader computed, uncorrected
   *   `shipped*`    the DEFAULT, i.e. what a consumer that passes no `contrast` option gets
   *   `gamma*`      stem darkening OFF and `gamma` below 1, so the two halves can be told apart
   *
   * The case is `Low` (ppem 20, spread 0 — a FILL), `High` (ppem 96, spread 0) or `OutlineLow`
   * (ppem 20 dilated by {@link CONTRAST_OUTLINE_PX} — the same glyphs, the same pens and the same
   * renderers as `Low`, so the ONLY difference between the two is that the dilation ran).
   */
  frames: Record<string, string>;
}

/**
 * THE ONE PROBE THAT RUNS THE SHIPPED CONTRAST CURVE — see {@link GRADED_AGAINST_COVERAGE} for why
 * it is the only one.
 *
 * THREE RENDERERS ON ONE CONTEXT, ONE GPU, ONE GLYPH, ONE SUB-PIXEL PHASE, for the reason the
 * `spreadTapMsaa` A/B above gives: anything that differs between their frames came from the
 * `contrast` option, because nothing else can have.
 *
 * TWO COLOURS PER CASE, AND THAT PAIR IS THE POINT. Coverage does not depend on the foreground —
 * the fragment writes `u_color.a * cov` and the alpha plane read back is `cov` for any opaque
 * colour — so with the correction OFF, black and white must produce byte-identical alpha. Turn it
 * on and they must not, in OPPOSITE directions: `hb_gpu_stem_darken`'s exponent is
 * `pow (2, brightness - 0.5)`, which is 0.707 for black (fatter) and 1.414 for white (thinner).
 * That is the whole claim that the brightness comes off `u_color` and needed no new uniform,
 * stated as two frames rather than as a sentence.
 *
 * TWO SIZES, because the correction is supposed to RAMP ITSELF OFF: `smoothstep (8, 48, ppem)`
 * takes the exponent to exactly 1 at and above ppem 48, so a 96 px/em frame must be indistinguishable
 * from the uncorrected one. Without that half, "the shipped frames differ" would be equally
 * consistent with a correction that fires everywhere and quietly reshapes large text too.
 *
 * The gamma renderer is third and separate because gamma is polarity-BLIND where stem darkening is
 * not: its two colours must stay identical to each other while both move away from `plain`.
 *
 * AND A DILATED PAIR AT THE LOW SIZE, WHICH IS THE FRAME THIS PROBE USED TO BE MISSING. Every
 * capture here was drawn at spread 0, so nothing in this file could see that the correction was
 * also running on an OUTLINE's rim — where Godot applies none, and where the fattening exponent
 * reads as a halo rather than as a crisper stem (`docs/text-rendering.md`, and the Godot-graded
 * table on `GODOT_RAMP_BUDGET_PX`). `${label}OutlineLow{White,Black}` is the same twenty-five
 * glyphs at the same pens through the same renderers, dilated by {@link CONTRAST_OUTLINE_PX}: the
 * one variable between it and `${label}Low{White,Black}` is that the dilation ran.
 */
async function contrastProbe(): Promise<ContrastProbeResult> {
  const lowItem = CONTRAST_CASE;
  const highItem = SPREAD_CASE;
  const lowPens = contrastPens();
  if (lowItem.size !== highItem.size) {
    throw new Error(
      `hb-gpu: the contrast cases share one canvas but ask for ${lowItem.size} and ${highItem.size}`,
    );
  }
  const { module: mod, font: face } = await ensureModule();
  const { canvas, gl } = openContext(lowItem.size);
  const built: HbGpuRenderer[] = [];
  try {
    const make = (
      label: string,
      contrast: HbGpuRendererOptions["contrast"],
    ): HbGpuRenderer => {
      const failures: HbGpuFailure[] = [];
      const created = createHbGpuRenderer(mod, {
        gl,
        designWidth: gl.drawingBufferWidth,
        designHeight: gl.drawingBufferHeight,
        atlasTexels: 4096 * 2,
        contrast,
        onError: (failure) => failures.push(failure),
      });
      if (!created) {
        throw new Error(
          `hb-gpu: the ${label} renderer refused to construct — ${failures.map((f) => `${f.reason}: ${f.message}`).join("; ") || "(no reason reported)"}`,
        );
      }
      // A `degenerate-contrast` here would mean the gamma below never reached the shader and the
      // "gamma moves pixels" assertions were comparing two default renderers.
      if (failures.length > 0) {
        throw new Error(
          `hb-gpu: the ${label} renderer reported ${failures.map((f) => `${f.reason}: ${f.message}`).join("; ")}`,
        );
      }
      built.push(created);
      return created;
    };

    const plain = make("uncorrected", HB_GPU_CONTRAST_NONE);
    // NO `contrast` KEY AT ALL, deliberately: this renderer is the one a consumer gets, so the
    // assertions over its frames are assertions about the DEFAULT and not about a value this file
    // chose. Writing `contrast: HB_GPU_CONTRAST_DEFAULT` here would keep passing after somebody
    // flipped the default the other way.
    const shipped = make("shipped-default", undefined);
    const gamma = make("gamma-only", {
      gamma: CONTRAST_PROBE_GAMMA,
      stemDarkening: false,
    });

    const glyphOf = (item: typeof lowItem): number => {
      const id = face.glyphFor(item.text.codePointAt(0) ?? 0);
      if (!id) {
        throw new Error(
          `hb-gpu: the fixture face has no glyph for "${item.text}"`,
        );
      }
      return id;
    };
    const lowGlyphId = glyphOf(lowItem);
    const highGlyphId = glyphOf(highItem);
    const lowEncoded = face.encode(lowGlyphId);
    const highEncoded = face.encode(highGlyphId);
    if (!lowEncoded || !highEncoded) {
      throw new Error("hb-gpu: a contrast-probe glyph encoded to nothing");
    }

    const frames: Record<string, string> = {};
    const capture = (name: string, draw: () => void): void => {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      draw();
      const raw = new Uint8Array(lowItem.size * lowItem.size * 4);
      gl.readPixels(
        0,
        0,
        lowItem.size,
        lowItem.size,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        raw,
      );
      const flipped = new Uint8Array(raw.length);
      const stride = lowItem.size * 4;
      for (let y = 0; y < lowItem.size; y += 1) {
        flipped.set(
          raw.subarray(
            (lowItem.size - 1 - y) * stride,
            (lowItem.size - y) * stride,
          ),
          y * stride,
        );
      }
      frames[name] = toBase64(flipped);
    };

    // ONE HELPER FOR EVERY FRAME, so "identical at ppem 96" and "different at ppem 14" cannot be
    // true because the two were written differently.
    const drawOn = (
      renderer: HbGpuRenderer,
      slot: GlyphSlot,
      item: typeof lowItem,
      pens: readonly (readonly [number, number])[],
      rgb: number,
      // THE DILATION RADIUS, AND IT IS A PARAMETER RATHER THAN A CONSTANT BECAUSE OF WHAT IT
      // MISSED. Every frame here was drawn at spread 0 until the outline pair below was added, so
      // the shipped contrast curve had no fixture on a dilated frame at all — and the curve WAS
      // running there, tripling the rim of a 14 px outline where Godot applies none. The spread is
      // always restated (it is sticky on the renderer, exactly like the model) so a frame can
      // never inherit the previous capture's radius.
      spreadPx: number,
    ): (() => void) => {
      return () => {
        renderer.setModel(modelFor(item));
        renderer.setSpread(spreadPx);
        renderer.setColor(rgb, rgb, rgb, 1);
        renderer.begin();
        for (const [x, y] of pens) {
          renderer.push(slot, x, y, item.pixelsPerEm);
        }
        const drawn = renderer.end().instances;
        if (drawn !== pens.length) {
          throw new Error(
            `hb-gpu: the contrast probe drew ${drawn} instances, not ${pens.length} — every comparison would be between frames short of glyphs`,
          );
        }
      };
    };
    const highPens: [number, number][] = [[highItem.originX, highItem.originY]];

    for (const [label, renderer] of [
      ["plain", plain],
      ["shipped", shipped],
      ["gamma", gamma],
    ] as const) {
      const registered = renderer.registerFace(face, "fixture");
      if (!registered) {
        throw new Error(`hb-gpu: the ${label} renderer declined the face`);
      }
      const lowSlot = renderer.upload(registered, lowGlyphId, lowEncoded);
      const highSlot = renderer.upload(registered, highGlyphId, highEncoded);
      if (!lowSlot || !highSlot) {
        throw new Error(`hb-gpu: the ${label} renderer produced no slot`);
      }
      capture(
        `${label}LowWhite`,
        drawOn(renderer, lowSlot, lowItem, lowPens, 1, 0),
      );
      capture(
        `${label}LowBlack`,
        drawOn(renderer, lowSlot, lowItem, lowPens, 0, 0),
      );
      capture(
        `${label}HighWhite`,
        drawOn(renderer, highSlot, highItem, highPens, 1, 0),
      );
      capture(
        `${label}HighBlack`,
        drawOn(renderer, highSlot, highItem, highPens, 0, 0),
      );
      // THE DILATED PAIR, AND IT IS THE SAME GLYPHS AT THE SAME PENS THROUGH THE SAME RENDERER as
      // the `Low` pair above — only `setSpread` differs. That is what lets one test say "the curve
      // moves a fill at this ppem and leaves an outline alone" without the two halves being
      // comparisons between different pictures.
      capture(
        `${label}OutlineLowWhite`,
        drawOn(renderer, lowSlot, lowItem, lowPens, 1, CONTRAST_OUTLINE_PX),
      );
      capture(
        `${label}OutlineLowBlack`,
        drawOn(renderer, lowSlot, lowItem, lowPens, 0, CONTRAST_OUTLINE_PX),
      );
    }

    return {
      width: lowItem.size,
      height: lowItem.size,
      lowPixelsPerEm: lowItem.pixelsPerEm,
      lowGlyphs: lowPens.length,
      highPixelsPerEm: highItem.pixelsPerEm,
      lowGlyphId,
      highGlyphId,
      gamma: CONTRAST_PROBE_GAMMA,
      outlinePx: CONTRAST_OUTLINE_PX,
      frames,
    };
  } finally {
    for (const renderer of built) renderer.dispose();
    canvas.remove();
  }
}

export interface GodotOutlineProbeResult {
  width: number;
  height: number;
  /** Frames per case, keyed `<case>.<column>` — see {@link godotOutlineProbe} for the columns. */
  frames: Record<string, string>;
  /** Glyph id per case, so a case that silently drew `.notdef` is visible from the node side. */
  glyphIds: Record<string, number>;
  /** Instances per frame. A case that drew nothing must not read as a pass. */
  instances: Record<string, number>;
}

/**
 * The same six cases the GODOT GOLDEN was rendered from, drawn by this package.
 *
 * ONE CANVAS, TWO RENDERERS, THREE COLUMNS PER CASE, and the columns are the point:
 *
 *   `none`          `HB_GPU_CONTRAST_NONE`, white. THE GRADED FRAME. Godot applies no curve to its
 *                   outline, so this is the only column that is comparable with it at all — the
 *                   same argument {@link GRADED_AGAINST_COVERAGE} makes for every other probe here.
 *   `defaultWhite`  the SHIPPING default (no `contrast` key, exactly as `contrastProbe` does it),
 *                   white. `hb_gpu_stem_darken`'s exponent for brightness 1 is 1.414, so this is
 *                   the correction's THINNING direction.
 *   `defaultBlack`  the shipping default, black. Exponent 0.707: the FATTENING direction, and the
 *                   one that matters. A dark outline is what the consumer draws, and lifting rim
 *                   coverage 0.30 -> 0.43 on a dilated frame is the halo this round is chasing.
 *
 * The alpha plane is the corrected coverage in all three — the fragment writes `u_color.a * cov`
 * and every colour here is opaque — so a black column is readable even though it composites to
 * nothing over a transparent buffer. Capturing black and white through ONE renderer is what makes
 * "the correction is keyed on the foreground" visible rather than assumed.
 *
 * UPRIGHT, so the model is the identity: `GodotOutlineCase` carries no rotation because a rotation
 * would add Godot's own 2D snapping settings to the list of things a disagreement could mean.
 */
async function godotOutlineProbe(): Promise<GodotOutlineProbeResult> {
  const size = GODOT_OUTLINE_CASES[0]?.size ?? 128;
  for (const item of GODOT_OUTLINE_CASES) {
    if (item.size !== size) {
      throw new Error(
        `hb-gpu: the Godot outline cases share one canvas but ask for ${size} and ${item.size}`,
      );
    }
  }
  const { module: mod, font: face } = await ensureModule();
  const { canvas, gl } = openContext(size);
  const built: HbGpuRenderer[] = [];
  try {
    const make = (
      label: string,
      contrast: HbGpuRendererOptions["contrast"],
    ): HbGpuRenderer => {
      const failures: HbGpuFailure[] = [];
      const created = createHbGpuRenderer(mod, {
        gl,
        designWidth: gl.drawingBufferWidth,
        designHeight: gl.drawingBufferHeight,
        // The widest case is a full stop at 96 px per em; one face and a handful of glyphs fit
        // several times over, so nothing here is ever evicted mid-probe.
        atlasTexels: 4096 * 4,
        contrast,
        onError: (failure) => failures.push(failure),
      });
      if (!created) {
        throw new Error(
          `hb-gpu: the ${label} renderer refused to construct — ${failures.map((f) => `${f.reason}: ${f.message}`).join("; ") || "(no reason reported)"}`,
        );
      }
      built.push(created);
      return created;
    };
    const plain = make("uncorrected", GRADED_AGAINST_COVERAGE);
    // NO `contrast` KEY, so these columns are the DEFAULT a consumer gets rather than a value this
    // file chose — `contrastProbe`'s reason, and it applies to a dilated frame just as much.
    const shipped = make("shipped-default", undefined);

    const frames: Record<string, string> = {};
    const instances: Record<string, number> = {};
    const glyphIds: Record<string, number> = {};

    const capture = (name: string, draw: () => number): void => {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      instances[name] = draw();
      const raw = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      const flipped = new Uint8Array(raw.length);
      const stride = size * 4;
      for (let y = 0; y < size; y += 1) {
        flipped.set(
          raw.subarray((size - 1 - y) * stride, (size - y) * stride),
          y * stride,
        );
      }
      frames[name] = toBase64(flipped);
    };

    const registered = new Map<HbGpuRenderer, HbGpuFace>();
    for (const renderer of [plain, shipped]) {
      const handle = renderer.registerFace(face, "fixture");
      if (!handle) throw new Error("hb-gpu: registerFace declined the face");
      registered.set(renderer, handle);
    }

    for (const item of GODOT_OUTLINE_CASES) {
      const glyphId = face.glyphFor(item.text.codePointAt(0) ?? 0);
      if (!glyphId) {
        throw new Error(
          `hb-gpu: the fixture face has no glyph for "${item.text}" (case ${item.name})`,
        );
      }
      const encoded = face.encode(glyphId);
      if (!encoded || encoded.texels.length === 0) {
        throw new Error(
          `hb-gpu: glyph ${glyphId} encoded to nothing (case ${item.name})`,
        );
      }
      glyphIds[item.name] = glyphId;

      const drawOn = (renderer: HbGpuRenderer, rgb: number) => (): number => {
        const handle = registered.get(renderer);
        if (handle === undefined) throw new Error("hb-gpu: no face handle");
        const slot = renderer.upload(handle, glyphId, encoded);
        if (!slot) {
          throw new Error(
            `hb-gpu: glyph ${glyphId} produced no slot (case ${item.name})`,
          );
        }
        // IDENTITY, RESTATED PER DRAW. `setModel` is sticky exactly like the spread, and every
        // case here is upright — but a probe that relied on nothing having set a model earlier
        // would break the moment one is added above it.
        renderer.setModel([1, 0, 0, 1, 0, 0]);
        renderer.setSpread(item.spreadPx);
        renderer.setColor(rgb, rgb, rgb, 1);
        renderer.begin();
        renderer.push(slot, item.originX, item.originY, item.pixelsPerEm);
        return renderer.end().instances;
      };

      capture(`${item.name}.none`, drawOn(plain, 1));
      capture(`${item.name}.defaultWhite`, drawOn(shipped, 1));
      capture(`${item.name}.defaultBlack`, drawOn(shipped, 0));
    }

    return { width: size, height: size, frames, glyphIds, instances };
  } finally {
    for (const renderer of built) renderer.dispose();
    canvas.remove();
  }
}

declare global {
  interface Window {
    __gswHbGpu: {
      run(name: string): Promise<GlyphCaseResult>;
      blobBytes(
        startCodepoint: number,
        count: number,
      ): Promise<BlobByteMeasurement>;
      evictionProbe(count: number): Promise<EvictionProbeResult>;
      spreadProbe(): Promise<SpreadProbeResult>;
      contrastProbe(): Promise<ContrastProbeResult>;
      godotOutlineProbe(): Promise<GodotOutlineProbeResult>;
    };
  }
}

window.__gswHbGpu = {
  run,
  blobBytes,
  evictionProbe,
  spreadProbe,
  contrastProbe,
  godotOutlineProbe,
};
