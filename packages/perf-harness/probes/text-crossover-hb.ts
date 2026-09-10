// The A1 crossover probe's `hb-gpu` arm (arm a), bundled by esbuild and served at `/hb.js`.
//
// IT DRIVES THE SHIPPED `createHbGpuText` AND REIMPLEMENTS NOTHING. The pen walk, the dilation
// radius (`outlinePx / 2 * dpr`), the pass ORDER (`outline` then `fill`) and the one-clear-per-frame
// rule all come from `src/scenarios/text-gpu.ts`; the shaping comes from `createHarfBuzzShaper` in
// `src/scenarios/text-hb.ts`, which is what `hb-atlas`/`hb-run` shape with. A probe with its own
// copy of any of that would be free to agree with itself while the shipped arm drifted half a
// pixel — and half a pixel is the entire subject of metric (ii).
//
// ONE ARM PER CELL, AND ONE ACCUMULATOR CANVAS FOR THE FRAME. That shape is forced, not chosen:
// `createHbGpuText` fixes `fontSize` (it becomes `pixelsPerEm` on every `push`) and `outlinePx`
// (it becomes `spreadPx` and therefore `passes`) at construction, and this sweep's 28 cells are 7
// sizes x 4 radii. Twenty-eight simultaneous WebGL2 contexts is past Chrome's ~16-context limit, at
// which point it silently loses the OLDEST — i.e. blanks the cells drawn first, which is the
// harness's number-one failure mode wearing a hat. So each cell gets a cell-sized context, is
// copied into one 2D accumulator, and is then disposed AND explicitly lost, keeping the live count
// at one.
//
// THE COPY IS `drawImage`, WHICH IS NOT THE BROKEN READBACK. What is broken on the headed rung is
// `getImageData` / `putImageData` on an accelerated 2D canvas (it returns alpha 0), and nothing
// here calls either: `drawImage(webglCanvas, x, y)` is a canvas-to-canvas GPU copy, done in the
// same task as the draw so the drawing buffer has not been presented and cleared yet
// (`preserveDrawingBuffer: false`). The bytes still leave this page through a compositor
// screenshot of the accumulator, exactly like every other arm's. The one thing it costs is a
// premultiplied source-over composite in 8 bits — which is what the compositor would have done to
// a stacked transparent canvas anyway — and the run's determinism check is what says it is
// repeatable.
//
// THE SPREAD IS VERIFIED, NOT ASSUMED. `outlinePx` is HALVED inside the arm, so the driver asks for
// `2 * spreadPx` and this module asserts the arm came back with the case's own `spreadPx`. An arm
// that silently halved twice would draw a thinner outline than the column it is filed under, and
// every edge width in that column would be a measurement of the wrong radius.

import type { HbGpu, HbGpuFont } from "@godot-scene-web/hb-gpu";
import {
  HB_GPU_CONTRAST_DEFAULT,
  HB_GPU_CONTRAST_NONE,
  type HbGpuContrast,
} from "@godot-scene-web/hb-gpu/webgl";
import {
  createHbGpuFonts,
  createHbGpuText,
  loadHbGpuModule,
} from "../src/scenarios/text-gpu";
import {
  createHarfBuzzShaper,
  type RunLayout,
  type ShapedGlyph,
  type TextShaper,
} from "../src/scenarios/text-hb";

/** The face id every glyph key in this probe is namespaced under. One face, stated once. */
const FACE_ID = "probe";

/** The fields of the driver's spec this module reads. Mirrors `CrossoverSpec` in text-crossover.ts. */
interface HbSpec {
  text: string;
  frame: { width: number; height: number };
  cell: { width: number; height: number };
  colors: {
    background: [number, number, number];
    outline: [number, number, number];
    fill: [number, number, number];
    drawOutline: boolean;
    drawFill: boolean;
  };
  cells: {
    name: string;
    pixelsPerEm: number;
    spreadPx: number;
    cellX: number;
    cellY: number;
    penX: number;
    penY: number;
  }[];
  contrast: "none" | "default";
}

export interface HbCellReport {
  name: string;
  /** What the case asked for. */
  requestedSpreadPx: number;
  /** What `createHbGpuText` came back with, after its own halving of `outlinePx`. */
  armSpreadPx: number;
  passes: string[];
  instances: number;
  drawCalls: number;
  inkless: number;
  glyphs: number;
}

export interface HbRenderReport {
  cells: HbCellReport[];
  contrast: string;
  /** Live WebGL2 contexts held at any one moment. 1 by construction; published so it is checkable. */
  peakContexts: number;
}

/** Straight rgba, 0..1, from the case matrix's 0..255 triple. The shader multiplies coverage by it. */
function colorOf(rgb: readonly [number, number, number]) {
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1] as const;
}

/**
 * hb-gpu's wasm and the face, created ONCE for the whole run.
 *
 * `HbGpuFont` encodes outlines in FONT UNITS — the size arrives per `push` as `pixelsPerEm` — so a
 * single font serves all seven sizes, and re-creating it per cell would put seven copies of the
 * face in the wasm heap for no measurement.
 */
let shared: { module: HbGpu; fonts: Map<string, HbGpuFont> } | null = null;

/** One HarfBuzz shaper per ppem — `createHarfBuzzShaper` bakes the pixel size into its advances. */
const shapers = new Map<number, TextShaper>();
const shapedRuns = new Map<string, ShapedGlyph[]>();

async function shaperFor(
  pixelsPerEm: number,
  fontBytes: ArrayBuffer,
): Promise<TextShaper> {
  const cached = shapers.get(pixelsPerEm);
  if (cached) return cached;
  // A COPY PER CONSUMER. `createHarfBuzzShaper` and `module.createFont` each take the bytes into
  // their own wasm heap, and a detachable buffer must never be shared between two of them.
  const shaper = await createHarfBuzzShaper(
    fontBytes.slice(0),
    pixelsPerEm,
    FACE_ID,
  );
  shapers.set(pixelsPerEm, shaper);
  return shaper;
}

export async function render(options: {
  accumulator: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  offstage: HTMLElement;
  spec: HbSpec;
  fontBytes: ArrayBuffer;
}): Promise<HbRenderReport> {
  const { ctx, offstage, spec, fontBytes } = options;
  if (!spec.colors.drawFill) {
    throw new Error(
      "text-crossover-hb: a variant with no fill pass is not expressible — `createHbGpuText` derives its pass list from `outlinePx` and always ends with the fill, and skipping it would leave the frame's single clear on a pass that never ran",
    );
  }
  if (!shared) {
    const module = await loadHbGpuModule();
    const fonts = createHbGpuFonts(
      module,
      new Map([[FACE_ID, fontBytes.slice(0)]]),
    );
    shared = { module, fonts };
  }
  const { module, fonts } = shared;

  const contrast: HbGpuContrast =
    spec.contrast === "default"
      ? HB_GPU_CONTRAST_DEFAULT
      : HB_GPU_CONTRAST_NONE;
  const fillColor = colorOf(spec.colors.fill);
  const outlineColor = colorOf(spec.colors.outline);

  const cells: HbCellReport[] = [];
  let peakContexts = 0;

  for (const entry of spec.cells) {
    const shaper = await shaperFor(entry.pixelsPerEm, fontBytes);
    const runKey = `${entry.pixelsPerEm}`;
    let glyphs = shapedRuns.get(runKey);
    if (!glyphs) {
      glyphs = shaper.shape(spec.text);
      shapedRuns.set(runKey, glyphs);
    }
    if (glyphs.length === 0) {
      throw new Error(
        `text-crossover-hb: the shaper produced no glyphs for ${JSON.stringify(spec.text)} at ppem ${entry.pixelsPerEm} — an empty cell scores perfectly on every metric this probe reports`,
      );
    }

    // NO OUTLINE PASS WHEN THE VARIANT HAS NO OUTLINE, and it is expressed as `outlinePx: 0` rather
    // than by skipping a pass. `HbGpuTextArm.end` clears only on `passes[0]`, so an arm built with
    // two passes whose outline pass was skipped would run its fill without ever clearing — the
    // previous cell's pixels, in a frame whose counters all look right.
    const outlinePx =
      spec.colors.drawOutline && entry.spreadPx > 0 ? 2 * entry.spreadPx : 0;

    const arm = createHbGpuText({
      container: offstage,
      cssWidth: spec.cell.width,
      cssHeight: spec.cell.height,
      // DPR 1 — the driver pins `deviceScaleFactor: 1`, so device px, CSS px and the case matrix's
      // px are one unit and `pixelsPerEm` IS the case's ppem.
      dpr: 1,
      fontSize: entry.pixelsPerEm,
      radians: 0,
      outlinePx,
      contrast,
      fillColor,
      outlineColor,
      module,
      fonts,
      keys: new Set(glyphs.map((glyph) => glyph.key)),
    });
    peakContexts = Math.max(peakContexts, 1);

    // THE HALVING IS THE ARM'S, SO THE ARM IS ASKED WHAT IT DID. See this file's header.
    if (outlinePx > 0 && Math.abs(arm.spreadPx - entry.spreadPx) > 1e-9) {
      arm.dispose();
      throw new Error(
        `text-crossover-hb: case ${entry.name} asked for a dilation radius of ${entry.spreadPx} px (outlinePx ${outlinePx}) and \`createHbGpuText\` came back with spreadPx ${arm.spreadPx} — every edge width in this column would be a measurement of a radius the report does not name`,
      );
    }

    // The un-rotated run box IS the cell, and the baseline is the cell-local pen y. `glyphLocal`
    // (inside `createHbGpuText`) puts a glyph at `centre + (penPx - width/2, baselinePx - height/2)`,
    // so these two centres land the em origin of the first glyph exactly on the case's `penX`/`penY`.
    const layout: RunLayout = {
      width: spec.cell.width,
      height: spec.cell.height,
      baselinePx: entry.penY - entry.cellY,
      dpr: 1,
      radians: 0,
      // Unread by this arm — there is no bake — and set to the struct's own default rather than
      // left out, because `RunLayout` is shared with arms for which it decides everything.
      bakeRotation: true,
    };
    const centreX = entry.penX - entry.cellX + spec.cell.width / 2;
    const centreY = spec.cell.height / 2;

    let totals = { instances: 0, drawCalls: 0, inkless: 0 };
    for (const pass of arm.passes) {
      arm.begin(pass);
      arm.push(glyphs, centreX, centreY, layout);
      const result = arm.end();
      totals = {
        instances: totals.instances + result.instances,
        drawCalls: totals.drawCalls + result.drawCalls,
        inkless: result.inkless,
      };
    }

    // SAME TASK AS THE DRAW. The drawing buffer is presented and cleared at the end of the task, so
    // this copy has to happen before any `await` — which is why nothing is awaited between `end()`
    // and here.
    ctx.drawImage(arm.canvas, entry.cellX, entry.cellY);

    cells.push({
      name: entry.name,
      requestedSpreadPx: entry.spreadPx,
      armSpreadPx: arm.spreadPx,
      passes: [...arm.passes],
      instances: totals.instances,
      drawCalls: totals.drawCalls,
      inkless: totals.inkless,
      glyphs: arm.stats.glyphs,
    });

    const canvas = arm.canvas;
    arm.dispose();
    // EXPLICITLY LOST, not merely dropped. `CanvasStage.dispose` only detaches the context-loss
    // listeners and `canvas.remove()` only detaches the element; the context itself lives until GC,
    // and 28 of those in one task is exactly the pile-up that makes Chrome evict the oldest. The
    // pixels are already in the accumulator by this line, so losing it costs nothing.
    const gl = canvas.getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }

  return {
    cells,
    contrast: spec.contrast,
    peakContexts,
  };
}
