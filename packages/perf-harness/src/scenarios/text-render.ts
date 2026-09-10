// Scenario S9: `text-render` — crisp small rotated text, and what each way of drawing it costs.
//
// THE QUESTION. 14 px text, rotated 10 degrees, translating every frame, inside a mobile frame
// budget. gsw draws text exactly one way today — DOM/CSS — and the `canvas` package has no text
// command at all, so before anything is built this scenario prices the alternatives against the
// shipped path on the same glyphs, the same font files and the same motion.
//
// TWO SCRIPTS, STACKED, IN EVERY CELL. A Han run in Noto Sans SC and an ASCII pangram in Roboto,
// because they are different problems and the app renders both: Han is full-width, unkerned and
// unligatured over thousands of outlines, while Latin is proportional, kerned, and an alphabet of
// ~95 glyphs. That difference is the whole point of the `bakeShaper` isolation — for Han a naive
// per-codepoint layout is byte-identical to a shaped one, so HarfBuzz bought nothing; Latin is
// where shaping has something to do. `--param script=han|latin` measures either alone.
//
// THE MECHANISM IS A PARAMETER, never a forked copy of the scenario: cell geometry, glyph strings,
// rotation, motion and sample points are identical across arms, so any difference in the numbers
// is the mechanism and nothing else.
//
// WHY THE STAGE IS THE VIEWPORT. `stageSize` returns `layout.viewport`, so `fitStage` resolves to
// scale exactly 1 on every environment and `env.geometry.fitScale` reads 1 everywhere. Every other
// scenario can afford a fractional fit; this one cannot. A `transform: scale(0.387)` above the
// stage — which is what a fitted phone run applies — changes the raster scale every glyph is
// rasterized at, and glyph raster scale IS the thing under measurement. A fitted text run would
// compare five mechanisms at a scale none of them will ever ship at. The grid shape still follows
// the viewport (portrait phones get a portrait grid); only the cell COUNT is fixed.
//
// WHY THE PRESENCE BEACON IS A GLYPH. See `BEACON_CODEPOINT` in `scripts/ensure-cjk-font.ts`: the
// first character of every run is U+25A0 BLACK SQUARE, a solid ~0.8 em rectangle that reaches the
// screen through the same cmap, shaping, rasterisation and blit as the Han around it. A plain
// coloured rect drawn beside the text would keep the guard green while every glyph silently failed
// to rasterize — a blank-page pass wearing a full-page costume.
//
// WHY THERE IS NO CHURN STRIP. Every other scenario mounts unrelated DOM that repaints each frame,
// because an arm that parks produces no `ActivateLayerTree` and the analyzer rejects the trace.
// Here the workload itself moves every label every frame on every arm, so activations are
// guaranteed by the thing being measured rather than by scaffolding beside it.

import {
  godotSceneBaseCss,
  mountHtmlScene,
  renderSceneToHtmlModel,
  SELF_LAYER_CLASS,
} from "@godot-scene-web/html";
import { resolveGodotSceneTree } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { type GridShape, gridShapeFor } from "../fit";
import {
  createHbGpuFonts,
  createHbGpuText,
  type HbGpuTextArm,
  loadHbGpuModule,
  shapeRunWithHbGpu,
  textGpuUnsupportedParam,
  textOutlineParamRefusal,
} from "./text-gpu";
import {
  type AtlasRenderer,
  type BakedAtlas,
  bakeAtlas,
  createAtlasRenderer,
  createCanvasShaper,
  createHarfBuzzShaper,
  createShaperSet,
  drawGlyphCells,
  drawRunCell,
  glyphLocal,
  type RunLayout,
  releaseAtlasPages,
  type ShapedGlyph,
  type ShaperSet,
  type TextShaper,
} from "./text-hb";
import type {
  ParamValue,
  Scenario,
  ScenarioContext,
  StageLayout,
} from "./types";

/**
 * The arms, in the order the comparison table reads best: the shipped path, the default browser
 * answer, then the candidates.
 *
 * Arms are added here only once they are IMPLEMENTED. A `ready()` throw aborts the whole run (S7's
 * trap), so listing an unbuilt mechanism would turn every default invocation into a failed run
 * rather than a partial table.
 *
 * `hb-gpu` IS LISTED BUT MAY NOT BE SWEPT. It is implemented, and its wasm is a docker + emscripten
 * build output that `dist/` gitignores — so on a checkout that has not run `packages/hb-gpu/build.sh`
 * it cannot be measured. That is handled node-side, before a browser is launched
 * (`src/hb-gpu-build.ts`), precisely so this list does not have to lie about whether the arm exists:
 * the run drops it from the sweep and reports it as NOT MEASURED with the command that produces it.
 * It is never rendered as a zero.
 */
export const TEXT_MECHANISMS = [
  "dom",
  "canvas2d",
  "hb-atlas",
  "hb-run",
  "hb-gpu",
] as const;

/** The `hb-` BAKED arms, which share a shaper, a baker and a WebGL2 stage. Not `hb-gpu`. */
function isHbMechanism(mechanism: string): boolean {
  return mechanism === "hb-atlas" || mechanism === "hb-run";
}

/**
 * Atlas page side ceiling, in device px.
 *
 * 2048 rather than the context's `MAX_TEXTURE_SIZE`, and deliberately not a query: the page size
 * decides `atlasPages`, and a limit that changed with the GPU would make that counter incomparable
 * between the SwiftShader rung (16384), the RTX rung (32768) and the phone (4096) — three different
 * page counts for identical work. 2048 is inside every one of them, and `packShelves` simply adds
 * pages when a workload needs more.
 */
const MAX_ATLAS_PAGE_SIDE = 2048;

/** Which scripts a cell draws. `both` is the default and is what the app really renders. */
export const TEXT_SCRIPTS = ["both", "han", "latin"] as const;
export type TextScript = (typeof TEXT_SCRIPTS)[number];

/** The two faces a run can be set in. One face per kind, everywhere, on every arm. */
export type TextRunKind = "han" | "latin";

/** The subset fixture's family name — the basename of the file `/fixture/font.ttf` serves. */
export const BENCH_FONT_FAMILY = "NotoSansSC-bench";

/** The Latin fixture's family — the basename of `/fixture/latin.ttf`. See `ensure-latin-font.ts`. */
export const LATIN_BENCH_FONT_FAMILY = "Roboto-bench";

/** Where the scenario's `.tscn` claims each font lives, so `fontResource` derives the families. */
const BENCH_FONT_RES_PATH =
  "res://fixtures/assets/fonts/noto-sans-sc/NotoSansSC-bench.ttf";
const LATIN_FONT_RES_PATH =
  "res://fixtures/assets/fonts/roboto/Roboto-bench.ttf";

const FONT_URL = "/fixture/font.ttf";
const LATIN_FONT_URL = "/fixture/latin.ttf";

/**
 * The `[ext_resource]` id each face is authored under, fixed rather than assigned in order.
 *
 * `resolveResource` is handed only `{ type: "ExtResource", id }` — the parser does not expand the
 * ref into its path — so the id IS how a run's face is identified on the way back out. Fixed ids
 * mean `script=latin` resolves the same way as `script=both`, instead of Latin quietly becoming
 * "the first resource" and being handed the Han URL.
 */
const FONT_RESOURCE_IDS: Record<TextRunKind, string> = { han: "1", latin: "2" };

/** Everything that differs between the two faces, in one table. */
const FACES: Record<
  TextRunKind,
  { family: string; url: string; resPath: string }
> = {
  han: {
    family: BENCH_FONT_FAMILY,
    url: FONT_URL,
    resPath: BENCH_FONT_RES_PATH,
  },
  latin: {
    family: LATIN_BENCH_FONT_FAMILY,
    url: LATIN_FONT_URL,
    resPath: LATIN_FONT_RES_PATH,
  },
};

/** U+25A0, mirrored from `scripts/ensure-cjk-font.ts` — browser-safe modules take no node imports. */
const BEACON = "■";
const HAN_POOL_START = 0x4e00;
const HAN_POOL_SIZE = 3000;

/**
 * The Latin run's text: a pangram, so the alphabet the atlas has to hold is the whole alphabet.
 *
 * Deliberately a real sentence rather than a spread of the pool the way the Han runs are built.
 * Latin's whole difference from Han is that its glyphs INTERACT — kerning pairs, and a shaper that
 * has something to do — and a pseudo-random character soup would have neither.
 */
export const LATIN_PANGRAM = "Sphinx of black quartz, judge my vow";

/**
 * Advance width of `latinRunString(i)` in ems, at the fixture's own metrics.
 *
 * Pinned here rather than measured at runtime because the CELL SIZE is decided before any font is
 * loaded — `textCellSize` is what `mount()` refuses an over-subscribed viewport with, and it is a
 * pure function a node test can check without a browser. `test/text-render.test.ts` shapes every
 * index against the real subset fixture and fails if this number drifts.
 *
 * The same for every index: Roboto's digits are tabular, so the two-digit prefix is a constant
 * width and all 20 runs are exactly as wide as each other.
 */
export const LATIN_RUN_EM_WIDTH = 18.40087890625;

/**
 * Advance width of {@link LATIN_PANGRAM} alone, in ems — the fidelity probe's Latin run.
 *
 * The probe draws ONE run per script, so it needs neither the beacon (nothing samples it there) nor
 * the index (nothing would collide), and a narrower box means fewer pixels in an 8x reference that
 * is already 3.6x the area it was before this round.
 */
export const LATIN_PANGRAM_EM_WIDTH = 16.4248046875;

/**
 * The string Latin run `index` draws: the beacon, a zero-padded index, then the pangram.
 *
 * THE INDEX IS NOT DECORATION. `hb-run` keys its baked whole-run textures by the run's TEXT, so 20
 * identical pangrams would collapse into ONE texture and one bake — flattering that arm enormously
 * against the Han runs, which are all different. The prefix makes every run distinct while keeping
 * them the same width and the same small glyph set.
 *
 * Two digits, wrapping at 100: every viewport this scenario fits refuses far fewer labels than that
 * (the widest is 32 for `script=latin` on a desktop), so the wrap is unreachable — and it keeps
 * {@link LATIN_RUN_EM_WIDTH} a single constant instead of a function of the index's digit count.
 */
export function latinRunString(index: number): string {
  const wrapped = ((Math.trunc(index) % 100) + 100) % 100;
  return `${BEACON}${String(wrapped).padStart(2, "0")} ${LATIN_PANGRAM}`;
}

/**
 * The beacon's INK box per face, in ems: x from the pen origin, y from the alphabetic baseline and
 * positive UP. Measured off the two subset fixtures with HarfBuzz.
 *
 * The presence guard samples a 5x5 DEVICE px box, which is ±0.57 CSS px at a phone's pixel ratio —
 * far too tight to aim at a glyph's advance box and hope. Aiming at the ink's centre instead is
 * exact on both faces, and it matters more for Latin than for Han: U+25A0's advance is 0.604 em in
 * Roboto against 1 em in Noto Sans SC, so a point placed at "half an em in" would land outside the
 * Latin beacon entirely.
 */
const BEACON_INK: Record<
  TextRunKind,
  { x0: number; x1: number; yTop: number; yBottom: number }
> = {
  han: { x0: 0.1, x1: 0.9, yTop: 0.78, yBottom: -0.02 },
  latin: {
    x0: 0.07177734375,
    x1: 0.53173828125,
    yTop: 0.46044921875,
    yBottom: 0,
  },
};

/** Line box height as a multiple of the font size, for cell sizing. Matches Godot's ~1.35 for Han. */
const LINE_HEIGHT_RATIO = 1.35;

/**
 * Gap between the two runs' ROTATED boxes inside a cell, in px.
 *
 * Small on purpose. The runs must not overlap — overlapping ink would make the fidelity bands
 * measure each other — but every px here is px the cell has to be taller, and cell height is what
 * decides how many labels a phone viewport holds.
 */
export const RUN_GAP = 6;

/** Breathing room around a cell's rotated, translating run, in px. */
const CELL_PAD = 6;

/**
 * Sub-pixel step per frame, in px along the run's baseline.
 *
 * Deliberately irrational-ish (the golden ratio's fractional part) so that consecutive frames never
 * land on the same sub-pixel phase and the sequence does not repeat inside a measured window. An
 * integer step would let a glyph atlas hit the identical phase every frame — which is the single
 * easiest way to accidentally measure a cache hit and report it as rendering cost.
 */
const STEP_PX_PER_FRAME = 0.6180339887;

export function textParamsSpec(): Scenario["params"] {
  return {
    mechanism: {
      default: TEXT_MECHANISMS[0],
      values: [...TEXT_MECHANISMS],
      describe: "how a run of text reaches the screen",
    },
    script: {
      default: "both",
      values: [...TEXT_SCRIPTS],
      describe:
        "which runs each cell draws: Han in Noto Sans SC, ASCII in Roboto, or both stacked",
    },
    labels: {
      default: 20,
      describe: "cells mounted; `script=both` puts TWO runs in each",
    },
    chars: {
      default: 12,
      describe:
        "characters in the HAN run, including its leading presence beacon",
    },
    glyphs: {
      default: 1000,
      describe:
        "size of the distinct-glyph pool the Han runs draw from (drives atlas VRAM)",
    },
    fontSize: { default: 14, describe: "CSS px" },
    rotationDeg: { default: 10, describe: "rotation applied to every run" },
    // The three baked-arm isolations. All three are REFUSED on `hb-gpu`, which bakes no pixels and
    // therefore has no rotation, no phase grid and no rasterizer choice to isolate — see
    // `textGpuUnsupportedParam`. Refused rather than ignored, because a report recording
    // `phases: 4` beside an arm that has no phases describes something that did not happen.
    phases: {
      default: 4,
      describe:
        "hb-atlas: pre-baked sub-pixel offsets per glyph, as a square grid (4 = 2x2). REFUSED on hb-gpu",
    },
    bakeRotation: {
      default: true,
      describe:
        "hb-atlas/hb-run: bake the rotation into the pixels (false = the conventional upright atlas, rotated by the draw). REFUSED on hb-gpu",
    },
    bakeShaper: {
      default: "harfbuzz",
      values: ["harfbuzz", "fillText"],
      describe:
        "hb-atlas/hb-run: who shapes and rasterizes the baked glyphs — isolates baking from shaping. REFUSED on hb-gpu",
    },
    // The isolation that runs the other way: the only arm here with an outline is `hb-gpu`, so this
    // one is REFUSED on all four of the others — see `textOutlineParamRefusal`. The default is 0,
    // so every reading taken before the outline path existed still describes what this arm draws.
    outlinePx: {
      default: 0,
      describe:
        "hb-gpu: outline width in design px (the consumer's strokeText lineWidth); the dilation radius is HALF it. 0 = fill only. REFUSED on every other arm",
    },
  };
}

/** Han character `index` of the pool, wrapping. Mirrors `hanAt` in `scripts/ensure-cjk-font.ts`. */
export function hanAt(index: number): string {
  const offset = ((index % HAN_POOL_SIZE) + HAN_POOL_SIZE) % HAN_POOL_SIZE;
  return String.fromCodePoint(HAN_POOL_START + offset);
}

/**
 * The string run `index` draws: the beacon, then `chars - 1` Han spread over the first `glyphs` of
 * the pool.
 *
 * The characters do not spell anything, and are not meant to. What the measurement needs from them
 * is Han stroke complexity and a controlled number of DISTINCT glyphs — `glyphs` is the knob that
 * decides how much of an atlas an arm has to hold — and a deterministic spread supplies both while
 * staying a pure function of two integers, so a test can reproduce any run without a browser.
 */
export function textRunString(
  index: number,
  chars: number,
  glyphs: number,
): string {
  const pool = Math.max(1, Math.min(glyphs, HAN_POOL_SIZE));
  const body: string[] = [];
  for (let i = 1; i < Math.max(1, chars); i += 1) {
    // A large odd stride keeps consecutive characters far apart in the pool, so one run touches a
    // wide spread of glyph complexities instead of a contiguous (and visually repetitive) block.
    body.push(hanAt((index * 131 + i * 977) % pool));
  }
  return BEACON + body.join("");
}

export interface TextCellBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The un-rotated text box: `chars` full-width glyphs by one line. Han advances exactly 1 em. */
export function runBox(
  chars: number,
  fontSize: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, chars) * fontSize,
    height: fontSize * LINE_HEIGHT_RATIO,
  };
}

/**
 * The un-rotated Latin text box.
 *
 * The SAME line height as the Han box, which is not an approximation: Roboto's own line box is
 * 1.172 em, comfortably inside 1.35, and a shared box height is what lets one `baseline` rule
 * (alphabetic baseline at `fontSize` below the box top) hold for both faces — Roboto's descender is
 * 0.244 em, so it fits the 0.35 em left below the baseline with room to spare.
 */
export function latinRunBox(fontSize: number): {
  width: number;
  height: number;
} {
  return {
    width: LATIN_RUN_EM_WIDTH * fontSize,
    height: fontSize * LINE_HEIGHT_RATIO,
  };
}

/** Which run kinds `script` puts in a cell, top to bottom. */
export function scriptKinds(script: string): TextRunKind[] {
  if (script === "han") return ["han"];
  if (script === "latin") return ["latin"];
  return ["han", "latin"];
}

/**
 * How far a run travels from its rest position, in px along its baseline.
 *
 * Half an em, and deliberately small. What the translation is FOR is defeating per-position caching
 * and exposing sample-phase shimmer, and both of those are decided by the sub-pixel remainder, not
 * by the distance covered — a few pixels of travel exercises every phase a rasterizer has. Travel
 * is also the term that dominates cell size (at two ems it was 48 of a 205 px cell's width and 48
 * of its 101 px height), and cell size is what decides whether the default workload fits a phone
 * viewport at scale 1. See `textLayoutFits`.
 */
export function translationAmplitude(fontSize: number): number {
  return fontSize * 0.5;
}

/** One run's un-rotated box, its rotated bounding box, and where it sits inside its cell. */
export interface TextRunGeometry {
  kind: TextRunKind;
  /** The un-rotated run box, CSS px. */
  width: number;
  height: number;
  /** Axis-aligned box the rotated run occupies, CSS px. */
  aabbWidth: number;
  aabbHeight: number;
  /** Run-box centre offset from the CELL centre, CSS px. Zero for a single-run cell. */
  offsetY: number;
}

/**
 * Every run of one cell, stacked, with the geometry the cell is sized from.
 *
 * Index-independent on purpose: a Han run is `chars` ems wide whatever it says, and every Latin run
 * is exactly {@link LATIN_RUN_EM_WIDTH} wide because Roboto's digits are tabular. So the cell size
 * is a pure function of the parameters — which is what lets `mount()` refuse an over-subscribed
 * viewport before a single glyph is rasterized.
 *
 * The runs are stacked by their ROTATED boxes rather than their upright ones: at 10 degrees a 258 px
 * Latin run is 63 px tall, not 19, and stacking by the upright height would overlap the two runs'
 * ink — which would make the fidelity probe's two bands measure each other.
 */
export function textRunGeometry(
  params: Record<string, ParamValue>,
): TextRunGeometry[] {
  const fontSize = Number(params.fontSize) || 14;
  const chars = Number(params.chars) || 12;
  const radians = ((Number(params.rotationDeg) || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const kinds = scriptKinds(String(params.script ?? "both"));

  const boxes = kinds.map((kind) => {
    const box =
      kind === "han" ? runBox(chars, fontSize) : latinRunBox(fontSize);
    return {
      kind,
      width: box.width,
      height: box.height,
      aabbWidth: box.width * cos + box.height * sin,
      aabbHeight: box.width * sin + box.height * cos,
    };
  });
  const stackHeight =
    boxes.reduce((sum, box) => sum + box.aabbHeight, 0) +
    RUN_GAP * (boxes.length - 1);

  let top = -stackHeight / 2;
  return boxes.map((box) => {
    const offsetY = top + box.aabbHeight / 2;
    top += box.aabbHeight + RUN_GAP;
    return { ...box, offsetY };
  });
}

/**
 * The cell a run lives in: the stacked rotated bounding boxes, plus the travel, plus padding.
 *
 * Pure, and sized for the PEAK of the motion rather than its rest position — the screenshot the
 * presence guard reads is taken wherever the window happened to end, so a cell sized for rest would
 * let a run leave its cell and the sample point land on empty background.
 */
export function textCellSize(params: Record<string, ParamValue>): {
  width: number;
  height: number;
} {
  const fontSize = Number(params.fontSize) || 14;
  const runs = textRunGeometry(params);
  const amplitude = translationAmplitude(fontSize);
  const stackHeight =
    runs.reduce((sum, run) => sum + run.aabbHeight, 0) +
    RUN_GAP * (runs.length - 1);
  return {
    width:
      Math.max(...runs.map((run) => run.aabbWidth)) +
      amplitude * 2 +
      CELL_PAD * 2,
    height: stackHeight + amplitude * 2 + CELL_PAD * 2,
  };
}

export function textGridShape(
  params: Record<string, ParamValue>,
  layout: StageLayout,
): GridShape {
  const cell = textCellSize(params);
  const viewport = layout.viewport;
  const viewportAspect =
    viewport.height > 0 ? viewport.width / viewport.height : 1;
  return gridShapeFor(
    Math.max(1, Number(params.labels) || 1),
    cell.width / cell.height,
    viewportAspect,
  );
}

/**
 * The stage IS the viewport, so the fit is the identity and the glyph raster scale is exactly the
 * device pixel ratio on every environment. See the module header.
 */
export function textStageSize(
  _params: Record<string, ParamValue>,
  layout: StageLayout,
): { width: number; height: number } {
  return { width: layout.viewport.width, height: layout.viewport.height };
}

/**
 * Does the requested workload fit the viewport at scale 1?
 *
 * The tension this answers: every other scenario GROWS its stage to hold its content and lets the
 * fit shrink it back down, but this one pins the stage to the viewport so the glyph raster scale
 * stays exactly the device pixel ratio (see the module header). With the stage fixed, asking for
 * more runs than the screen holds cannot be absorbed by a smaller fit scale — the runs simply
 * overlap, and overlapping runs measure overdraw and DOM stacking on top of the text cost while
 * still passing the presence guard, because a neighbour's glyphs are ink too.
 *
 * So over-subscription is REFUSED at mount rather than rendered. A pure function so a test can
 * prove the defaults fit both the 1280x800 desktop and the 412x883 phone without a browser.
 */
export function textLayoutFits(
  params: Record<string, ParamValue>,
  layout: StageLayout,
): {
  fits: boolean;
  required: { width: number; height: number };
  cell: { width: number; height: number };
  capacity: number;
} {
  const required = textCellSize(params);
  const grid = textGridShape(params, layout);
  const stage = textStageSize(params, layout);
  const cell = {
    width: stage.width / grid.columns,
    height: stage.height / grid.rows,
  };
  const capacity =
    Math.floor(stage.width / required.width) *
    Math.floor(stage.height / required.height);
  return {
    fits: cell.width >= required.width && cell.height >= required.height,
    required,
    cell,
    capacity,
  };
}

/** Cell boxes in stage coordinates, laid out on the grid the viewport implies. */
export function textCellBoxes(
  params: Record<string, ParamValue>,
  layout: StageLayout,
): TextCellBox[] {
  const labels = Math.max(1, Number(params.labels) || 1);
  const grid = textGridShape(params, layout);
  const stage = textStageSize(params, layout);
  const cellWidth = stage.width / grid.columns;
  const cellHeight = stage.height / grid.rows;
  const boxes: TextCellBox[] = [];
  for (let index = 0; index < labels; index += 1) {
    const column = index % grid.columns;
    const row = Math.floor(index / grid.columns);
    boxes.push({
      left: column * cellWidth,
      top: row * cellHeight,
      width: cellWidth,
      height: cellHeight,
    });
  }
  return boxes;
}

/** One run, placed: its text, its box, and where that box's centre sits AT REST on the stage. */
export interface TextPlacedRun extends TextRunGeometry {
  /** Which cell it belongs to — and therefore which translation it follows. */
  cellIndex: number;
  text: string;
  /** Run box centre at rest, in stage px. */
  centreX: number;
  centreY: number;
}

/**
 * Every run the scenario mounts, in draw order: cell by cell, Han above Latin.
 *
 * ONE SOURCE OF TRUTH for the whole round. The DOM arm's authored scene, the canvas arms' draw
 * loops, the baked arms' bake items, the Godot manifest and the presence sample points are all
 * built from this list, so an arm cannot draw its text somewhere the others do not — which is the
 * premise the entire comparison rests on and which nothing in the metrics table would catch.
 */
export function textPlacedRuns(
  params: Record<string, ParamValue>,
  layout: StageLayout,
): TextPlacedRun[] {
  const chars = Number(params.chars) || 12;
  const glyphs = Number(params.glyphs) || 1000;
  const geometry = textRunGeometry(params);
  const placed: TextPlacedRun[] = [];
  textCellBoxes(params, layout).forEach((cell, cellIndex) => {
    for (const run of geometry) {
      placed.push({
        ...run,
        cellIndex,
        text:
          run.kind === "han"
            ? textRunString(cellIndex, chars, glyphs)
            : latinRunString(cellIndex),
        centreX: cell.left + cell.width / 2,
        centreY: cell.top + cell.height / 2 + run.offsetY,
      });
    }
  });
  return placed;
}

/**
 * Where each run's beacon INK CENTRE is, in stage coordinates — one point per run, so
 * `script=both` proves BOTH runs rendered rather than only the top one.
 *
 * TWO THINGS ARE DELIBERATE HERE, and both were needed the moment a second face arrived.
 *
 * The point is the beacon's ink centre, not "half an em in". U+25A0's advance is 1 em in Noto Sans
 * SC but 0.604 em in Roboto, so the old rule would have aimed the Latin sample outside its own
 * beacon. See {@link BEACON_INK}.
 *
 * The point FOLLOWS THE MOTION. The guard samples a 5x5 device px box — ±0.57 CSS px at a phone's
 * pixel ratio — while a run travels ±0.5 em, so a rest-position sample sits up to half an em away
 * from the ink it is aiming at. At the desktop's pixel ratio the box is wide enough to have hidden
 * this; at a phone's it is not, and Han would have failed too. `samplePoints()` is called after the
 * measured window closes and before the screenshot, with nothing stepping in between, so the frame
 * the guard is about is knowable — pass it and the sample is exact instead of lucky.
 */
export function textSamplePoints(
  params: Record<string, ParamValue>,
  layout: StageLayout,
  options: {
    /** The last frame drawn. Omitted means rest, which is what a pure geometry test wants. */
    frame?: number;
    /**
     * Measured px from a run box's top edge to its alphabetic baseline, per face. Defaults to
     * `fontSize`, the documented rule the fidelity probe imposes; S9 measures it off the shipped
     * DOM instead, because there each face's CSS line box decides it.
     */
    baselines?: Partial<Record<TextRunKind, number>>;
  } = {},
): { x: number; y: number }[] {
  const fontSize = Number(params.fontSize) || 14;
  const radians = ((Number(params.rotationDeg) || 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return textPlacedRuns(params, layout).map((run) => {
    const ink = BEACON_INK[run.kind];
    const baseline = options.baselines?.[run.kind] ?? fontSize;
    // Beacon ink centre in run-local coordinates, from the run box's own centre. `y` is measured
    // DOWN from the box centre, while the ink box is measured UP from the baseline.
    const localX = ((ink.x0 + ink.x1) / 2) * fontSize - run.width / 2;
    const localY =
      baseline - run.height / 2 - ((ink.yTop + ink.yBottom) / 2) * fontSize;
    const offset =
      options.frame === undefined
        ? { x: 0, y: 0 }
        : translationAt(run.cellIndex, options.frame, fontSize, radians);
    return {
      x: run.centreX + offset.x + localX * cos - localY * sin,
      y: run.centreY + offset.y + localX * sin + localY * cos,
    };
  });
}

/**
 * Where run `index` is offset to on frame `frame`, in px.
 *
 * A triangle wave along the run's own baseline direction, per-run phase-shifted, driven off the
 * FRAME INDEX rather than wall-clock time. Frame-driven motion means every arm advances the scene
 * by exactly the same amount per frame, so a slower arm renders the same work more slowly instead
 * of skipping ahead — which is what makes per-frame costs comparable at all.
 */
export function translationAt(
  index: number,
  frame: number,
  fontSize: number,
  radians: number,
): { x: number; y: number } {
  const amplitude = translationAmplitude(fontSize);
  const span = amplitude * 2;
  const phase = (frame * STEP_PX_PER_FRAME + index * 7.3) % (span * 2);
  const along = (phase < span ? phase : span * 2 - phase) - amplitude;
  return { x: along * Math.cos(radians), y: along * Math.sin(radians) };
}

/**
 * The scene, as real Godot text — the `dom` arm's whole point.
 *
 * Authored rather than hand-built as DOM so the shipped chain (parser -> scene graph -> Control
 * layout -> HTML model -> mount) is what produces the elements under measurement. A hand-written
 * copy of the CSS `text.ts` emits could not drift when the real one does.
 */
export function textSceneText(
  runs: readonly TextPlacedRun[],
  params: Record<string, ParamValue>,
  stage: { width: number; height: number },
): string {
  const fontSize = Number(params.fontSize) || 14;
  const rotation = Number(params.rotationDeg) || 0;
  // Only the faces actually drawn. An unused `[ext_resource]` would make the shipped model emit an
  // `@font-face` for a file the run never asks for, and `script=han` would then be charged for
  // downloading and installing Roboto.
  const kinds = [...new Set(runs.map((run) => run.kind))];
  const lines: string[] = [
    `[gd_scene load_steps=${kinds.length + 1} format=3]`,
    "",
    ...kinds.map(
      (kind) =>
        `[ext_resource type="FontFile" path="${FACES[kind].resPath}" id="${FONT_RESOURCE_IDS[kind]}"]`,
    ),
    "",
    '[node name="Root" type="Control"]',
    `offset_right = ${stage.width}.0`,
    `offset_bottom = ${stage.height}.0`,
  ];
  runs.forEach((run, index) => {
    // The Label box is the RUN box, centred on the run's own placed centre: Godot rotates a Control
    // about `pivot_offset`, whose rotation-only default the html package maps to `transform-origin:
    // 50% 50%`, so a run-sized box rotates about the run's own centre on every arm.
    const left = run.centreX - run.width / 2;
    const top = run.centreY - run.height / 2;
    lines.push(
      "",
      `[node name="Run${index}" type="Label" parent="."]`,
      `offset_left = ${left.toFixed(3)}`,
      `offset_top = ${top.toFixed(3)}`,
      `offset_right = ${(left + run.width).toFixed(3)}`,
      `offset_bottom = ${(top + run.height).toFixed(3)}`,
      `rotation_degrees = ${rotation}`,
      `theme_override_font_sizes/font_size = ${fontSize}`,
      `theme_override_fonts/font = ExtResource("${FONT_RESOURCE_IDS[run.kind]}")`,
      `text = "${run.text}"`,
    );
  });
  return `${lines.join("\n")}\n`;
}

interface DomNode {
  element: HTMLElement;
  /** The transform the shipped model authored — the rotation this arm must not overwrite. */
  shippedTransform: string;
}

/** Everything the `hb-atlas` / `hb-run` arms build once in `prepare` and only read per frame. */
interface HbArm {
  renderer: AtlasRenderer;
  atlas: BakedAtlas;
  /** Positioned glyphs per PLACED RUN. `hb-run` keeps them to bake with; it draws one quad. */
  shaped: ShapedGlyph[][];
  /** The atlas key each run's whole-run cell was baked under (`hb-run` only). */
  runKeys: string[];
  bakeRotation: boolean;
  shaperName: string;
  distinctFaces: number;
  shapeMs: number;
  wasmHeapBytes: number;
  quadsLastFrame: number;
  batchesLastFrame: number;
}

/**
 * Everything the `hb-gpu` arm builds once in `prepare` and only reads per frame.
 *
 * Separate from {@link HbArm} rather than a variant of it, because they share almost nothing: there
 * is no `BakedAtlas`, no phase grid and no `AtlasRenderer` here, and since this arm started shaping
 * in hb-gpu's own wasm they do not even share a shaper. What they DO share is `ShapedGlyph` and
 * `glyphLocal` from `text-hb.ts` — the placement arithmetic — plus an agreement between two
 * HarfBuzz builds about the numbers fed into it, which is now asserted by
 * `test/text-shaper-agreement.test.ts` instead of guaranteed by a shared object.
 */
interface HbGpuArm {
  arm: HbGpuTextArm;
  /** Kept so `teardown` can free the face copies inside the wasm heap. */
  destroyFonts(): void;
  /**
   * Positioned glyphs per PLACED RUN, shaped by hb-gpu's own HarfBuzz.
   *
   * Same key space and same `penPx` arithmetic as `hb-atlas`'s — see {@link mountHbGpu} for what
   * makes that a checked claim rather than a structural one.
   */
  shaped: ShapedGlyph[][];
  distinctFaces: number;
  shapeMs: number;
  /**
   * ONE WASM MODULE'S HEAP, because this arm now has only one.
   *
   * `wasmHeapBytes` is documented on the baked arms as summed across FACES (`script=both` with
   * `bakeShaper=harfbuzz` carries two harfbuzzjs heaps). This arm used to be summed across MODULES
   * as well — it shaped with npm `harfbuzzjs` and encoded outlines with hb-gpu's own HarfBuzz, so
   * both faces were resident twice — and that is exactly the cost the swap to `HbGpuFont.shape`
   * removed. What is left is hb-gpu's heap, holding one copy of each face for both jobs.
   */
  wasmHeapBytes: number;
  quadsLastFrame: number;
  drawCallsLastFrame: number;
  /** Glyphs with no ink this frame — spaces. See {@link HbGpuTextArm.end}. */
  inklessLastFrame: number;
}

interface State {
  container: HTMLElement;
  style?: HTMLStyleElement;
  mechanism: string;
  script: string;
  fontSize: number;
  radians: number;
  chars: number;
  glyphs: number;
  cells: number;
  /** Every run of every cell, in draw order. The one list every arm works from. */
  runs: TextPlacedRun[];
  /** Which faces the run list uses, in a fixed order. */
  kinds: TextRunKind[];
  phases: number;
  bakeRotation: boolean;
  bakeShaper: string;
  /**
   * The outline width in DESIGN px, as the operator asked for it — `hb-gpu` only, 0 elsewhere.
   *
   * Kept in the operator's units rather than as the halved, dpr-scaled radius so the report can
   * publish both: the width is the number the consumer's corpus is measured in and the radius is
   * the number the shader picks its tap count from, and quoting one as the other is a factor of
   * `2 / dpr`. The conversion lives in `createHbGpuText`.
   */
  outlinePx: number;
  stage: { width: number; height: number };
  devicePixelRatio: number;
  fontLoadMs: number;
  /**
   * Run-box top to alphabetic baseline, measured off the shipped DOM, PER FACE.
   *
   * Per face because it is a property of the face's CSS line box, not of the scenario: Noto Sans SC
   * and Roboto disagree about ascent, descent and half-leading, so one number would put one of the
   * two runs a couple of px away from where the DOM arm draws it — the exact defect
   * `measureShippedBaselinePx` was written to kill in the first place.
   */
  baselinePx: Record<TextRunKind, number>;
  prepared?: Promise<void>;
  // `dom`
  domNodes: DomNode[];
  // `canvas2d`
  canvas?: HTMLCanvasElement;
  ctx?: CanvasRenderingContext2D;
  fillTextCalls: number;
  framesDrawn: number;
  // `hb-atlas` / `hb-run`
  hb?: HbArm;
  // `hb-gpu`
  gpu?: HbGpuArm;
}

/** The last frame that reached the screen — what `samplePoints` has to aim at. */
function lastDrawnFrame(state: State): number {
  return state.framesDrawn > 0 ? state.framesDrawn - 1 : 0;
}

// Keyed on the scenario root rather than module-scoped: every scenario in the repo shares ONE
// bundle, so a module-level `let state` would leak across `--serve` navigations.
const states = new WeakMap<HTMLElement, State>();

function stateOf(ctx: ScenarioContext, who: string): State {
  const state = states.get(ctx.root);
  if (!state) {
    throw new Error(`text-render: ${who}() before mount()`);
  }
  return state;
}

export const textRender: Scenario = {
  name: "text-render",
  fontFixture: true,
  // No image is ever painted here: every pixel comes from the font stack, which emits no cc
  // decode events. Declaring it is what lets `decode.count: 0` be read as a true zero instead of
  // tripping the validator's drifted-matcher alarm.
  paintsImages: false,
  params: textParamsSpec(),

  mount(ctx) {
    const mechanism = String(ctx.params.mechanism);
    const script = String(ctx.params.script ?? "both");
    const fontSize = Number(ctx.params.fontSize) || 14;
    const chars = Number(ctx.params.chars) || 12;
    const glyphs = Number(ctx.params.glyphs) || 1000;
    const radians = ((Number(ctx.params.rotationDeg) || 0) * Math.PI) / 180;

    // BEFORE ANY FONT IS FETCHED. `hb-gpu` has no bake, so the three baked-arm isolations mean
    // nothing on it; accepting them silently would put a measurement of something that did not
    // happen into the report. Thrown here rather than from `ready()` — the earliest hook that can
    // see the params — so a refused run costs nothing.
    const refusal =
      mechanism === "hb-gpu" ? textGpuUnsupportedParam(ctx.params) : null;
    if (refusal) {
      throw new Error(refusal);
    }
    // And the same rule pointed the other way: `outlinePx` is hb-gpu's alone, because it is the
    // only arm here that HAS an outline. Checked on every mechanism, not just the other four,
    // because it also rejects a negative or non-finite width that `setSpread` would silently clamp
    // to a plain fill and file under a stroke.
    const outlineRefusal = textOutlineParamRefusal(mechanism, ctx.params);
    if (outlineRefusal) {
      throw new Error(outlineRefusal);
    }

    const fit = textLayoutFits(ctx.params, ctx.layout);
    if (!fit.fits) {
      throw new Error(
        `text-render: ${ctx.params.labels} \`script=${script}\` cells at ${fontSize}px need ${fit.required.width.toFixed(1)}x${fit.required.height.toFixed(1)} px each, but this ${ctx.layout.viewport.width}x${ctx.layout.viewport.height} viewport only gives ${fit.cell.width.toFixed(1)}x${fit.cell.height.toFixed(1)}. The stage is pinned to the viewport so the glyph raster scale stays the device pixel ratio, so this cannot be absorbed by a smaller fit. The largest \`labels\` this viewport holds at these parameters is ${fit.capacity}${script === "both" ? ", or use `--param script=han` for a shorter cell" : ""}.`,
      );
    }
    const runs = textPlacedRuns(ctx.params, ctx.layout);

    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.inset = "0";
    ctx.root.appendChild(container);

    const state: State = {
      container,
      mechanism,
      script,
      fontSize,
      radians,
      chars,
      glyphs,
      cells: Math.max(1, Number(ctx.params.labels) || 1),
      runs,
      kinds: scriptKinds(script),
      phases: Math.max(1, Number(ctx.params.phases) || 1),
      // Belt and braces against the query-string round trip: `readParams` now coerces "false" to a
      // boolean, but a scenario that only worked because of that would break the moment it was
      // driven from anywhere else. See `readParams` for what this cost the first time.
      bakeRotation:
        ctx.params.bakeRotation !== false &&
        String(ctx.params.bakeRotation) !== "false",
      bakeShaper: String(ctx.params.bakeShaper ?? "harfbuzz"),
      // Refused above unless it is 0 or this is `hb-gpu`, so this is either the operator's width or
      // the default — never a value an arm would have to ignore.
      outlinePx: Number(ctx.params.outlinePx ?? 0),
      stage: { width: ctx.stage.width, height: ctx.stage.height },
      devicePixelRatio: window.devicePixelRatio || 1,
      fontLoadMs: 0,
      baselinePx: { han: fontSize, latin: fontSize },
      domNodes: [],
      fillTextCalls: 0,
      framesDrawn: 0,
    };
    states.set(ctx.root, state);
    state.prepared = prepare(ctx, state);
  },

  async ready(ctx) {
    const state = stateOf(ctx, "ready");
    await state.prepared;
  },

  step(ctx, frame) {
    const state = stateOf(ctx, "step");
    if (state.mechanism === "dom") {
      stepDom(state, frame);
    } else if (state.mechanism === "hb-atlas") {
      drawHbAtlas(state, frame);
    } else if (state.mechanism === "hb-run") {
      drawHbRun(state, frame);
    } else if (state.mechanism === "hb-gpu") {
      drawHbGpu(state, frame);
    } else {
      drawCanvas2d(state, frame);
    }
    state.framesDrawn += 1;
  },

  teardown(ctx) {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    // Before the container goes: the renderer owns a WebGL2 context, and a page that mounts several
    // scenarios in a row (`--serve`) would walk into the browser's ~16-live-context limit if each
    // one were left to garbage collection.
    state.hb?.renderer.dispose();
    // The same for hb-gpu, plus its faces: those are `malloc`d copies inside the wasm heap that
    // HarfBuzz holds READONLY views onto, so they are freed explicitly rather than collected.
    state.gpu?.arm.dispose();
    state.gpu?.destroyFonts();
    state.style?.remove();
    state.container.remove();
    states.delete(ctx.root);
  },

  metrics(ctx) {
    const state = stateOf(ctx, "metrics");
    const counters: Record<string, number> = {
      // What the arm was actually asked to put on screen. An arm that quietly drew fewer runs than
      // it mounted would otherwise look cheap rather than wrong. `runsDrawn` is TWICE `cells` at
      // the default, and the gap between the two is the whole of what `script=both` added.
      cellsDrawn: state.cells,
      runsDrawn: state.runs.length,
      glyphsPerFrame: state.runs.reduce(
        (sum, run) => sum + [...run.text].length,
        0,
      ),
      distinctGlyphs: distinctGlyphCount(state.runs),
      distinctFaces: state.kinds.length,
      framesDrawn: state.framesDrawn,
      fontLoadMs: Math.round(state.fontLoadMs * 1000) / 1000,
      // Published on EVERY arm, not just the one that consumes it: identical values here are the
      // evidence that the arms draw in the same place, which is the premise the whole comparison
      // rests on and which nothing else in the table would catch if it broke. Per face, because
      // the two faces' CSS line boxes put their baselines in different places.
      baselinePx: Math.round(state.baselinePx.han * 1000) / 1000,
      baselineLatinPx: Math.round(state.baselinePx.latin * 1000) / 1000,
    };
    if (state.mechanism === "dom") {
      counters.domNodes = state.domNodes.length;
    }
    if (state.mechanism === "canvas2d") {
      // `fillText` is this arm's whole cost model: one shaping + rasterisation pass per run per
      // frame, with no cache the scenario controls. Counting it makes "did it really redraw every
      // frame" a measured fact rather than an assumption about Skia's glyph cache.
      counters.fillTextCalls = state.fillTextCalls;
    }
    const hb = state.hb;
    if (hb) {
      // The whole cost model of a baked arm, split into the part paid once and the part paid every
      // frame. `shapeMs` + `bakeMs` is startup; `quadsPerFrame` and `glDrawCalls` are the steady
      // state, and the gap between them is the claim these arms are making.
      counters.atlasPages = hb.atlas.pages.length;
      counters.atlasBytes = hb.renderer.atlasBytes;
      counters.atlasPageSide = hb.atlas.pageSide;
      counters.atlasOccupancy = Math.round(hb.atlas.occupancy * 1000) / 1000;
      // Baked variants actually rasterized — glyphs times phases, or one per run. NOT the same as
      // `distinctGlyphs`, and the ratio between them is what `phases` costs.
      counters.rasterizedGlyphs = hb.atlas.cellCount;
      counters.atlasPhases = hb.atlas.phases;
      counters.shapeMs = Math.round(hb.shapeMs * 1000) / 1000;
      counters.bakeMs = Math.round(hb.atlas.bakeMs * 1000) / 1000;
      // Zero for `bakeShaper=fillText`, which is the point: it makes "this arm carries a wasm heap"
      // a number in the table rather than something a reader has to know about the arm.
      counters.wasmHeapBytes = hb.wasmHeapBytes;
      counters.quadsPerFrame = hb.quadsLastFrame;
      counters.glDrawCalls = hb.batchesLastFrame;
    }
    const gpu = state.gpu;
    if (gpu) {
      // THE SAME SHAPE AS THE BAKED ARMS WHERE THE CONCEPT EXISTS, AND ABSENT WHERE IT DOES NOT.
      // `atlasPhases`, `atlasPageSide` and `rasterizedGlyphs` carry no key here — there is no phase
      // grid, no square page and nothing rasterized ahead of time — and absent means NOT MEASURED,
      // which is the honest thing for a column an arm has no answer for. A zero would read as an
      // answer.
      counters.shapeMs = Math.round(gpu.shapeMs * 1000) / 1000;
      // The counterpart of `bakeMs`: outlines ENCODED rather than pixels rasterized, and like
      // `bakeMs` it excludes the program link, so the two are comparable. `programMs` and
      // `uploadMs` are reported beside it rather than folded in — a combined counter went UP when
      // the encode work was halved, because the driver's link dominated it.
      counters.encodeMs = Math.round(gpu.arm.stats.encodeMs * 1000) / 1000;
      counters.programMs = Math.round(gpu.arm.stats.programMs * 1000) / 1000;
      counters.uploadMs = Math.round(gpu.arm.stats.uploadMs * 1000) / 1000;
      counters.quadsPerFrame = gpu.quadsLastFrame;
      counters.glDrawCalls = gpu.drawCallsLastFrame;
      // ACCOUNTS FOR THE GAP BETWEEN `glyphsPerFrame` AND `quadsPerFrame`, which is otherwise the
      // most alarming pair of numbers in this arm's row: at the defaults they read 1040 and 900,
      // and a reader has no way to tell "140 spaces carry no ink" from "140 glyphs went missing".
      // `hb-atlas` emits a degenerate quad for a space; this arm declines to, which is strictly
      // less work — so the two arms' quad counts are not the same number for the same scene, and
      // this is the counter that says why.
      counters.inklessGlyphsPerFrame = gpu.inklessLastFrame;
      counters.wasmHeapBytes = gpu.wasmHeapBytes;

      // THE OUTLINE, AND WHY BOTH NUMBERS ARE HERE RATHER THAN ONE.
      //
      // `passesPerFrame` is what turns the three counters above back into per-pass figures: with an
      // outline every one of them doubles, so the identity the `inklessGlyphsPerFrame` note states
      // becomes `glyphsPerFrame x passesPerFrame - quadsPerFrame = inklessGlyphsPerFrame`. Without
      // it, an outlined row reads as an arm that suddenly emits twice the quads for one scene.
      //
      // `outlineSpreadPx` is the DEVICE-px dilation radius — `outlinePx / 2 x dpr` — and it is the
      // one the cost is a function of, because the shader picks its ring and step counts from the
      // radius in device pixels. The design-px width the operator asked for is in `params`, and the
      // two differ by `2 / dpr`: a `--param outlinePx=6` run reads 3 here on the desktop and 10.46
      // on a dpr 3.4876 phone. Quoting the width as the radius would understate the phone by 3.5x.
      counters.passesPerFrame = gpu.arm.passes.length;
      counters.outlineSpreadPx = Math.round(gpu.arm.spreadPx * 1000) / 1000;

      // TWO VRAM NUMBERS, AND THEY MUST NOT BE CONFUSED.
      //
      // `atlasBytes` is the LIVE glyph data: resident texels x 8. `atlasReservationBytes` is the
      // whole 4096-wide texture the driver actually allocated. `hb-atlas`'s `atlasBytes` is the
      // second kind of number (its pages are only as tall as the shelves reached), so THE
      // RESERVATION is the figure that belongs beside its 1.45 MiB — not the live bytes, which are
      // smaller and describe a different thing. `atlasOccupancy` is published as the bridge between
      // them, in the same key `hb-atlas` reports its own occupancy under.
      counters.atlasBytes = gpu.arm.stats.atlasBytes;
      counters.atlasReservationBytes = gpu.arm.stats.reservationBytes;
      counters.atlasOccupancy =
        Math.round(gpu.arm.stats.occupancy * 1000) / 1000;
      // One texture, always: the blob stream is 1-D and is wrapped into a single 4096-wide page.
      counters.atlasPages = 1;

      // The Slug format's own size for this pool, and its SPREAD. The min/max are reported beside
      // the total because a mean alone would suggest an atlas can be sized by multiplying it by a
      // glyph count — measured on the fixture's Han pool the range is a factor of 25.
      counters.blobBytes = gpu.arm.stats.blobBytes;
      counters.blobGlyphs = gpu.arm.stats.glyphs;
      counters.blobMinBytes = gpu.arm.stats.blobMinBytes;
      counters.blobMaxBytes = gpu.arm.stats.blobMaxBytes;
    }
    return counters;
  },

  samplePoints(ctx) {
    // The frame and the MEASURED baselines, not the defaults: the guard aims at a 5x5 device px
    // box on a run that has travelled, in a face whose baseline only the browser knows.
    //
    // Falls back to the pure rest geometry when nothing is mounted, rather than throwing. The
    // runner always mounts first; the callers that do not are geometry tests asking "where would
    // this scenario put its points", and for them the documented rule is the right answer.
    const state = states.get(ctx.root);
    return textSamplePoints(
      ctx.params,
      ctx.layout,
      state
        ? { frame: lastDrawnFrame(state), baselines: state.baselinePx }
        : {},
    );
  },

  stageSize(params, layout) {
    return textStageSize(params, layout);
  },

  gridShape(params, layout) {
    return textGridShape(params, layout);
  },
};

/**
 * Distinct glyphs across every run — the atlas-VRAM axis, counted PER FACE.
 *
 * Qualified by kind because two faces share a key space in nothing but appearance: U+25A0 is a
 * glyph in both fixtures and they are different outlines, so counting bare characters would report
 * one atlas cell where two are baked. That is the same collision {@link GLYPH_KEY_SEPARATOR}
 * exists to prevent, restated as a counter.
 */
export function distinctGlyphCount(
  runs: readonly { kind: string; text: string }[],
): number {
  const seen = new Set<string>();
  for (const run of runs) {
    for (const char of run.text) {
      seen.add(`${run.kind}:${char}`);
    }
  }
  return seen.size;
}

/**
 * Everything awaited before the measured window opens: fetch and install every face this run
 * needs, then build the arm's scene.
 *
 * THE FACES ARE VERIFIED, NOT ASSUMED. If a fixture fails to install, every arm silently falls back
 * to a system face — different outlines, different metrics, different rasterizer — and the whole
 * comparison quietly measures a font that was never the subject. `document.fonts.check` is cheap
 * and turns that into a thrown `ready()` naming the cause.
 *
 * Only the faces the `script` really draws are fetched, so `script=han` is not charged for
 * downloading and installing Roboto.
 */
async function prepare(ctx: ScenarioContext, state: State): Promise<void> {
  const startedAt = performance.now();
  const bytes: Partial<Record<TextRunKind, ArrayBuffer>> = {};
  for (const kind of state.kinds) {
    const { family, url } = FACES[kind];
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `text-render: ${url} responded ${response.status} — the runner did not serve the ${kind} font fixture (is \`fontFixture\` still declared on the scenario?)`,
      );
    }
    const loaded = await response.arrayBuffer();
    bytes[kind] = loaded;
    const face = new FontFace(family, loaded, {
      style: "normal",
      weight: "400",
    });
    await face.load();
    document.fonts.add(face);
    await document.fonts.ready;
    const probe = `${state.fontSize}px "${family}"`;
    if (!document.fonts.check(probe)) {
      throw new Error(
        `text-render: the browser will not use ${probe} after installing ${loaded.byteLength} bytes from ${url} — every arm would have measured a system fallback face instead of the fixture`,
      );
    }
  }
  state.fontLoadMs = performance.now() - startedAt;

  // Measured for EVERY arm, though only the canvas and baked arms consume it: the dom arm
  // publishing the same numbers is what makes "the arms share an anchor" a fact in the metrics
  // table rather than a claim in a comment. Must come after the fonts are installed — a fallback
  // face has a different ascent, and this would then anchor the other arms to a face nothing
  // renders with.
  state.baselinePx = measureShippedBaselinePx(ctx, state);

  if (state.mechanism === "dom") {
    mountDom(ctx, state);
  } else if (state.mechanism === "hb-gpu") {
    await mountHbGpu(state, {
      han: bytes.han?.slice(0),
      latin: bytes.latin?.slice(0),
    });
  } else if (isHbMechanism(state.mechanism)) {
    // COPIES of the font bytes. `new FontFace(family, buffer)` is specified to copy rather than
    // transfer, but the whole arm silently bakes a blank atlas if that ever stops being true on
    // some engine, and a megabyte once at startup is not worth the class of bug.
    await mountHb(state, {
      han: bytes.han?.slice(0),
      latin: bytes.latin?.slice(0),
    });
  } else {
    mountCanvas2d(state);
  }

  // Zeroed at the END of `ready()`, so every counter describes the MEASURED WINDOW and not the
  // mount that preceded it. `mountCanvas2d` draws one frame to have something on screen before the
  // window opens, and leaving that frame in the totals would report 26 frames where 25 were timed.
  state.fillTextCalls = 0;
  state.framesDrawn = 0;
}

// ---------------------------------------------------------------------------------------------
// `dom` — the shipped path
// ---------------------------------------------------------------------------------------------

/**
 * The shipped HTML model for `runs` — the exact path `mountDom` measures.
 *
 * Factored out so the baseline probe cannot drift from the arm it is describing: a probe that
 * built the model slightly differently would report where a DIFFERENT DOM puts its baseline.
 */
function shippedModel(
  ctx: ScenarioContext,
  state: State,
  runs: readonly TextPlacedRun[],
): ReturnType<typeof renderSceneToHtmlModel> {
  const scene = parseGodotTextScene(
    textSceneText(runs, ctx.params, state.stage),
  );
  return renderSceneToHtmlModel(
    // The viewport MUST be passed. `resolveGodotSceneTree` defaults to 1280x720, and a 1280x800
    // run silently lost its bottom row to the stage's clip — which surfaced as a presence-guard
    // failure blaming the renderer for a layout default. The guard below is the permanent version
    // of that lesson.
    resolveGodotSceneTree(deriveSceneGraph(scene), {
      viewport: {
        x: 0,
        y: 0,
        width: state.stage.width,
        height: state.stage.height,
      },
    }),
    {
      // The scene's only resources are the fonts, one per face. Returning the served URL lets the
      // shipped `fontResource` derive the family from the basename and emit the `@font-face`
      // itself, which is the code path a consuming app really uses.
      //
      // SWITCHED ON THE ID, because that is all the ref carries: the parser hands
      // `{ type: "ExtResource", id }` through without expanding it to a path, so a resolver that
      // returned one fixed font would render the Latin run in the Han face — same geometry, same
      // alignment, wrong glyphs, and nothing in the metrics table would say so.
      resolveResource: (ref) => {
        const kind: TextRunKind =
          ref.id === FONT_RESOURCE_IDS.latin ? "latin" : "han";
        return { path: FACES[kind].resPath, url: FACES[kind].url };
      },
    },
  );
}

/**
 * Px from a run box's top edge to the alphabetic baseline, PER FACE, AS THE SHIPPED PATH LAYS IT
 * OUT.
 *
 * The `canvas2d` arm used `textBaseline: "top"`, which pins the em top, while the `dom` arm gets a
 * CSS line box, which pins `half-leading + ascent`. Two conventions, so the two arms drew the same
 * runs a couple of px apart — and an A/B whose whole premise is "same glyphs, same coordinates,
 * only the mechanism differs" was quietly comparing two pictures.
 *
 * MEASURED, NOT DERIVED, AND ONCE PER FACE. The Han fixture's own tables disagree by 45% (hhea
 * 1160/-288 against OS/2 typo 880/-120 at 1000 upem, USE_TYPO_METRICS unset) and predict
 * half-leadings of opposite sign, so any arithmetic here would be a guess at which one Chrome
 * picked — and Roboto's answer is a different number again. A zero-height inline-block with
 * `vertical-align: baseline` sits exactly ON the line box's baseline; its top is the answer,
 * whichever table won, for whichever face the Label is set in.
 *
 * Two details that would silently return the wrong number:
 *   * the self-layer is `display: flex`, so a strut appended to it becomes a sibling FLEX ITEM
 *     rather than part of the text's line box. The text is therefore re-wrapped in an explicit
 *     span — which is what the anonymous flex item around it already is — and the strut goes
 *     inside that. This happens on a throwaway off-screen replica, never on the mounted arm.
 *   * `getBoundingClientRect` reports the TRANSFORMED box, so the 10 degree rotation comes off
 *     first. Measuring the rotated element would return a rotated number.
 */
function measureShippedBaselinePx(
  ctx: ScenarioContext,
  state: State,
): Record<TextRunKind, number> {
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.left = "-10000px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  state.container.appendChild(probe);
  const style = document.createElement("style");
  const baselines: Record<TextRunKind, number> = {
    han: state.fontSize,
    latin: state.fontSize,
  };
  try {
    // The FIRST CELL's runs, which is one Label per face, in the same order `state.kinds` lists
    // them — so each measured Label is matched to its face by position rather than by guess.
    const firstCell = state.runs.filter((run) => run.cellIndex === 0);
    const model = shippedModel(ctx, state, firstCell);
    style.textContent = `${godotSceneBaseCss}\n${model.css}`;
    document.head.appendChild(style);
    mountHtmlScene(probe, model);
    const nodes = [
      ...probe.querySelectorAll<HTMLElement>(
        ".godot-scene-node.godot-type-Label",
      ),
    ];
    if (nodes.length !== firstCell.length) {
      throw new Error(
        `text-render: the shipped model produced ${nodes.length} Labels for ${firstCell.length} runs, so at least one face has no baseline to match`,
      );
    }
    nodes.forEach((node, index) => {
      const layer = node.querySelector<HTMLElement>(
        `:scope > .${SELF_LAYER_CLASS}`,
      );
      if (!layer) {
        throw new Error(
          "text-render: the shipped model produced no Label self-layer, so the other arms have no baseline to match",
        );
      }
      node.style.transform = "none";
      const line = document.createElement("span");
      line.textContent = layer.textContent;
      const strut = document.createElement("span");
      strut.style.display = "inline-block";
      strut.style.width = "0";
      strut.style.height = "0";
      strut.style.verticalAlign = "baseline";
      line.appendChild(strut);
      layer.replaceChildren(line);
      const baseline =
        strut.getBoundingClientRect().top - node.getBoundingClientRect().top;
      if (!Number.isFinite(baseline)) {
        throw new Error(
          "text-render: could not measure the shipped baseline; the other arms would draw somewhere else",
        );
      }
      baselines[firstCell[index].kind] = baseline;
    });
    return baselines;
  } finally {
    style.remove();
    probe.remove();
  }
}

function mountDom(ctx: ScenarioContext, state: State): void {
  const model = shippedModel(ctx, state, state.runs);
  const style = document.createElement("style");
  style.textContent = `${godotSceneBaseCss}\n${model.css}`;
  document.head.appendChild(style);
  state.style = style;

  const stage = mountHtmlScene(state.container, model);
  // The stage must be able to HOLD the scenario's box. It clips its overflow, so a stage even a
  // few px short quietly removes the last row of runs — which reads as a rendering failure in the
  // presence guard and as a suspiciously cheap arm in the table.
  const stageBox = stage.getBoundingClientRect();
  if (
    stageBox.width + 0.5 < state.stage.width ||
    stageBox.height + 0.5 < state.stage.height
  ) {
    throw new Error(
      `text-render: the shipped model produced a ${stageBox.width}x${stageBox.height} stage for a ${state.stage.width}x${state.stage.height} scenario box — runs outside it would be clipped away`,
    );
  }
  // The class, not `[data-godot-type]`: that attribute lands on the self-layer as well as the node
  // element, and `transform` lives on the node element (the self-layer carries the text).
  const elements = [
    ...stage.querySelectorAll<HTMLElement>(
      ".godot-scene-node.godot-type-Label",
    ),
  ];
  if (elements.length !== state.runs.length) {
    throw new Error(
      `text-render: the shipped pipeline produced ${elements.length} Label elements for ${state.runs.length} runs — the arm is not measuring what it claims`,
    );
  }
  for (const element of elements) {
    const shippedTransform = element.style.transform;
    if (!shippedTransform.includes("rotate")) {
      throw new Error(
        `text-render: the shipped model emitted transform "${shippedTransform}" with no rotation — the dom arm would measure unrotated text`,
      );
    }
    state.domNodes.push({ element, shippedTransform });
  }
}

function stepDom(state: State, frame: number): void {
  state.domNodes.forEach((node, index) => {
    // Keyed on the CELL, so both runs of a cell move together. Two runs drifting independently
    // would still be a valid workload, but it would stop the two fidelity bands from describing
    // the same moving object.
    const offset = translationAt(
      state.runs[index].cellIndex,
      frame,
      state.fontSize,
      state.radians,
    );
    // The shipped rotation is PREPENDED to, never replaced: `translate` then `rotate` keeps the
    // rotation about the element's own `transform-origin` and only moves the result, which is the
    // same composition the canvas arms apply.
    node.element.style.transform = `translate(${offset.x}px, ${offset.y}px) ${node.shippedTransform}`;
  });
}

// ---------------------------------------------------------------------------------------------
// `canvas2d` — the default browser answer
// ---------------------------------------------------------------------------------------------

function mountCanvas2d(state: State): void {
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = `${state.stage.width}px`;
  canvas.style.height = `${state.stage.height}px`;
  canvas.width = Math.round(state.stage.width * state.devicePixelRatio);
  canvas.height = Math.round(state.stage.height * state.devicePixelRatio);
  state.container.appendChild(canvas);

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) {
    throw new Error("text-render: no 2d context for the canvas2d arm");
  }
  state.canvas = canvas;
  state.ctx = ctx;
  drawCanvas2d(state, 0);
}

function drawCanvas2d(state: State, frame: number): void {
  const ctx = state.ctx;
  if (!ctx) {
    return;
  }
  const dpr = state.devicePixelRatio;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, state.stage.width, state.stage.height);
  // The SHIPPED arm's anchor, measured off the shipped DOM at mount — see
  // `measureShippedBaselinePx`. `"top"` here used to pin the em top while the dom arm pinned
  // `half-leading + ascent`, so the two arms drew the same run a couple of px apart.
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  for (const run of state.runs) {
    const centre = runCentre(state, run, frame);
    ctx.save();
    // Rotate about the run box's centre, matching the `transform-origin: 50% 50%` the shipped
    // model puts on a rotation-only Control.
    ctx.translate(centre.x, centre.y);
    ctx.rotate(state.radians);
    // Per run: the two faces are two `ctx.font` strings, and the baseline each was measured at is
    // a property of its own face's line box.
    ctx.font = `${state.fontSize}px "${FACES[run.kind].family}"`;
    ctx.fillText(
      run.text,
      -run.width / 2,
      -run.height / 2 + state.baselinePx[run.kind],
    );
    ctx.restore();
    state.fillTextCalls += 1;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ---------------------------------------------------------------------------------------------
// `hb-atlas` / `hb-run` — shape once, rasterize once, then only blit
// ---------------------------------------------------------------------------------------------

/**
 * The geometry ONE run is baked and drawn against.
 *
 * Per run rather than per scenario now that a cell holds two: the two faces have different box
 * widths and different measured baselines, and `glyphLocal` — the single expression the bake, the
 * draw and the fidelity probe all share — is written in terms of both.
 */
function hbLayout(state: State, run: TextPlacedRun): RunLayout {
  return {
    width: run.width,
    height: run.height,
    baselinePx: state.baselinePx[run.kind],
    dpr: state.devicePixelRatio,
    radians: state.radians,
    bakeRotation: state.bakeRotation,
  };
}

async function mountHb(
  state: State,
  fontBytes: Partial<Record<TextRunKind, ArrayBuffer>>,
): Promise<void> {
  // One shaper per FACE, behind one key space. See `createShaperSet`: with two faces in one atlas,
  // an unqualified glyph key would let Roboto's gid 97 render as Noto Sans SC's.
  const shapers: TextShaper[] = [];
  for (const kind of state.kinds) {
    if (state.bakeShaper === "fillText") {
      shapers.push(
        createCanvasShaper(state.fontSize, FACES[kind].family, kind),
      );
      continue;
    }
    const bytes = fontBytes[kind];
    if (!bytes) {
      throw new Error(
        `text-render: no ${kind} font bytes for the HarfBuzz shaper — its run would silently not be drawn`,
      );
    }
    shapers.push(await createHarfBuzzShaper(bytes, state.fontSize, kind));
  }
  const shaper = createShaperSet(shapers);

  const shapeStartedAt = performance.now();
  const shaped = state.runs.map((run) => shaper.shape(run.kind, run.text));
  const shapeMs = performance.now() - shapeStartedAt;

  const runKeys: string[] = [];
  const items =
    state.mechanism === "hb-run"
      ? bakeItemsForRuns(state, shaper, shaped, runKeys)
      : bakeItemsForGlyphs(shaper, shaped);

  const atlas = bakeAtlas(items, {
    dpr: state.devicePixelRatio,
    // Zero means "the draw call rotates the quad" — the conventional upright atlas, kept as a
    // parameter rather than a separate arm so the two share every other line of this file.
    radians: state.bakeRotation ? state.radians : 0,
    // `hb-run` translates a whole baked run to a FRACTIONAL position, and an upright atlas is drawn
    // through a rotated quad; neither lands on whole device pixels, so neither may carry a baked
    // sub-pixel offset. Only the rotation-baked glyph atlas snaps.
    snapped: state.bakeRotation && state.mechanism !== "hb-run",
    phases: state.phases,
    maxPageSide: MAX_ATLAS_PAGE_SIDE,
  });

  const renderer = createAtlasRenderer({
    container: state.container,
    cssWidth: state.stage.width,
    cssHeight: state.stage.height,
    dpr: state.devicePixelRatio,
    pages: atlas.pages,
  });
  releaseAtlasPages(atlas.pages);

  state.hb = {
    renderer,
    atlas,
    shaped,
    runKeys,
    bakeRotation: state.bakeRotation,
    shaperName: shapers[0]?.name ?? state.bakeShaper,
    distinctFaces: shapers.length,
    shapeMs,
    // Read AFTER shaping and baking, so it reports the heap the arm really grew to rather than the
    // 1 MiB an untouched module starts at. SUMMED across faces: `script=both` carries two wasm
    // heaps, and the memory table should say so rather than report one of them.
    wasmHeapBytes: shaper.heapBytes(),
    quadsLastFrame: 0,
    batchesLastFrame: 0,
  };

  // One frame before the window opens, so the first measured frame is a steady-state frame and not
  // the one that faults in every texture. `mountCanvas2d` does the same for the same reason.
  if (state.mechanism === "hb-run") {
    drawHbRun(state, 0);
  } else {
    drawHbAtlas(state, 0);
  }
}

/** One bake item per DISTINCT glyph across every run and every face — `hb-atlas`'s working set. */
function bakeItemsForGlyphs(
  shaper: ShaperSet,
  shaped: readonly ShapedGlyph[][],
) {
  const keys = new Set<string>();
  for (const glyphs of shaped) {
    for (const glyph of glyphs) keys.add(glyph.key);
  }
  return [...keys].map((key) => ({
    key,
    bounds: shaper.boundsOf(key),
    draw: (ctx: CanvasRenderingContext2D) => shaper.draw(ctx, key),
  }));
}

/**
 * One bake item per distinct RUN STRING, anchored at the run box's centre.
 *
 * Keyed by the text rather than by the run index so two runs that happen to say the same thing
 * share one texture. That is not a micro-optimisation — it is what stops the arm from reporting a
 * VRAM figure that depends on how the fixture happened to generate its strings.
 */
function bakeItemsForRuns(
  state: State,
  shaper: ShaperSet,
  shaped: readonly ShapedGlyph[][],
  runKeys: string[],
) {
  const items = new Map<
    string,
    {
      key: string;
      bounds: { minX: number; minY: number; maxX: number; maxY: number };
      draw(ctx: CanvasRenderingContext2D): void;
    }
  >();
  state.runs.forEach((run, index) => {
    // The FACE is part of the key as well as the text: the two runs of a cell are different
    // strings today, but nothing about this arm should depend on that staying true.
    const key = `run:${run.kind}:${run.text}`;
    runKeys[index] = key;
    if (items.has(key)) return;
    const layout = hbLayout(state, run);
    const glyphs = shaped[index];
    const bounds = {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    };
    for (const glyph of glyphs) {
      const local = glyphLocal(glyph.penPx, layout);
      const ink = shaper.boundsOf(glyph.key);
      bounds.minX = Math.min(bounds.minX, local.x + ink.minX);
      bounds.maxX = Math.max(bounds.maxX, local.x + ink.maxX);
      bounds.minY = Math.min(bounds.minY, local.y + ink.minY);
      bounds.maxY = Math.max(bounds.maxY, local.y + ink.maxY);
    }
    items.set(key, {
      key,
      bounds,
      draw(ctx) {
        for (const glyph of glyphs) {
          const local = glyphLocal(glyph.penPx, layout);
          ctx.save();
          ctx.translate(local.x, local.y);
          shaper.draw(ctx, glyph.key);
          ctx.restore();
        }
      },
    });
  });
  return [...items.values()];
}

/** A run's box centre on `frame`, in CSS px — the point every arm rotates about. */
function runCentre(
  state: State,
  run: TextPlacedRun,
  frame: number,
): { x: number; y: number } {
  const offset = translationAt(
    run.cellIndex,
    frame,
    state.fontSize,
    state.radians,
  );
  return { x: run.centreX + offset.x, y: run.centreY + offset.y };
}

function drawHbAtlas(state: State, frame: number): void {
  const hb = state.hb;
  if (!hb) return;
  hb.renderer.begin();
  state.runs.forEach((run, index) => {
    const centre = runCentre(state, run, frame);
    // The placement arithmetic lives in `text-hb` and is called from here AND from the fidelity
    // probe, so the arm the probe grades for alignment is the arm the table times.
    drawGlyphCells(
      hb.renderer,
      hb.atlas,
      hb.shaped[index],
      centre.x,
      centre.y,
      hbLayout(state, run),
    );
  });
  const stats = hb.renderer.end();
  hb.quadsLastFrame = stats.quads;
  hb.batchesLastFrame = stats.batches;
}

function drawHbRun(state: State, frame: number): void {
  const hb = state.hb;
  if (!hb) return;
  hb.renderer.begin();
  state.runs.forEach((run, index) => {
    const centre = runCentre(state, run, frame);
    const cell = hb.atlas.cells.get(hb.runKeys[index])?.[0];
    if (cell)
      drawRunCell(hb.renderer, cell, centre.x, centre.y, hbLayout(state, run));
  });
  const stats = hb.renderer.end();
  hb.quadsLastFrame = stats.quads;
  hb.batchesLastFrame = stats.batches;
}

// ---------------------------------------------------------------------------------------------
// `hb-gpu` — shape once, encode the OUTLINE once, evaluate coverage per fragment
// ---------------------------------------------------------------------------------------------

/**
 * Build the hb-gpu arm: ONE HarfBuzz that shapes the runs AND encodes their outlines, and one
 * texture holding the encoded curves.
 *
 * ONE MODULE, ONE COPY OF EACH FACE, AND NO harfbuzzjs ON THIS ARM AT ALL. `hb-gpu.symbols` exports
 * `hb_shape`, so the runs are shaped by `HbGpuFont.shape` through `shapeRunWithHbGpu`.
 * `createHarfBuzzShaper` — the only `import("harfbuzzjs")` in this bundle, and a DYNAMIC one — is
 * never called on this path, so npm `harfbuzzjs` is not instantiated: no second wasm module, no
 * second copy of either face, and `wasmHeapBytes` below is hb-gpu's heap alone rather than a sum of
 * two. The arrangement this replaces shaped with harfbuzzjs and used hb-gpu only to read outlines.
 *
 * THE PEN POSITIONS ARE STILL `hb-atlas`'S — AS A CHECKED FACT, NOT A STRUCTURAL ONE. The baked arms
 * shape with harfbuzzjs, so the two arms no longer share a shaper object, and the fidelity probe's
 * alignment guard only says something about the RENDERER while the two shapers agree glyph for
 * glyph. `test/text-shaper-agreement.test.ts` asserts exactly that on these runs' own strings at
 * this font size — same `<face>/g<gid>` keys, same `penPx` — and `packages/hb-gpu/test/shape.test.ts`
 * grades the two HarfBuzz builds against each other underneath it.
 *
 * THE MODULE IS LOADED BEFORE ANYTHING IS SHAPED, because the shaper IS the module now. `shapeMs`
 * therefore times hb-gpu's shaper, which is the number that belongs beside the baked arms' own.
 */
async function mountHbGpu(
  state: State,
  fontBytes: Partial<Record<TextRunKind, ArrayBuffer>>,
): Promise<void> {
  const bytesByFace = new Map<string, ArrayBuffer>();
  for (const kind of state.kinds) {
    const bytes = fontBytes[kind];
    if (!bytes) {
      throw new Error(
        `text-render: no ${kind} font bytes for the hb-gpu arm — its run would silently not be drawn`,
      );
    }
    // NO DEFENSIVE COPY HERE ANY MORE. `prepare` already hands this arm its own `slice(0)` of each
    // face and hb-gpu copies what it is given into its heap, so nothing else holds these buffers.
    // The extra copy that used to be taken existed because harfbuzzjs held the originals, and two
    // modules must never share one detachable buffer.
    bytesByFace.set(kind, bytes);
  }

  const module = await loadHbGpuModule();
  const fonts = createHbGpuFonts(module, bytesByFace);

  const shapeStartedAt = performance.now();
  const shaped = state.runs.map((run) =>
    shapeRunWithHbGpu(fonts, run.kind, run.text, state.fontSize),
  );
  const shapeMs = performance.now() - shapeStartedAt;

  const arm = createHbGpuText({
    container: state.container,
    cssWidth: state.stage.width,
    cssHeight: state.stage.height,
    dpr: state.devicePixelRatio,
    fontSize: state.fontSize,
    radians: state.radians,
    outlinePx: state.outlinePx,
    module,
    fonts,
    // Every distinct glyph of every run, so the texture is sized for the whole working set at once
    // and no frame can ask for a glyph the ring allocator has evicted.
    keys: new Set(shaped.flatMap((glyphs) => glyphs.map((g) => g.key))),
  });

  state.gpu = {
    arm,
    destroyFonts: () => module.destroy(),
    shaped,
    distinctFaces: fonts.size,
    shapeMs,
    // ONE MODULE'S HEAP, and nothing is added to it — see `HbGpuArm.wasmHeapBytes`. `createHbGpuText`
    // reads it after every outline is encoded, and the runs were shaped in the same module before
    // that, so it describes the heap the arm really grew to doing both jobs.
    wasmHeapBytes: arm.stats.wasmHeapBytes,
    quadsLastFrame: 0,
    drawCallsLastFrame: 0,
    inklessLastFrame: 0,
  };

  // One frame before the window opens, so the first measured frame is steady-state and not the one
  // that links the program and faults in the texture. The baked arms do the same.
  drawHbGpu(state, 0);
}

/**
 * This arm's per-frame work in full: a pen walk, one instance record per glyph, one draw call —
 * ONCE PER PASS.
 *
 * No snapping, no phase lookup and no per-frame rasterisation — the rotation is in the model matrix
 * and the coverage is evaluated in the fragment shader at whatever sub-pixel position the frame
 * asks for. That is the entire claim, and `quadsPerFrame` / `glDrawCalls` are what it costs.
 *
 * AT `outlinePx=0` THERE IS ONE PASS AND THIS LOOP RUNS ONCE, which is the frame every committed
 * reading of this arm was taken on. With an outline it runs twice — outline, then fill — and the
 * SECOND WALK IS DELIBERATE. `arm.passes` could have been served by redrawing the first pass's
 * instance buffer with two uniforms changed, which is cheaper and is not what a consumer does: an
 * outlined label reaches `packages/canvas`'s glyph pass as the same glyphs and pens recorded twice
 * in the draw list, so the CPU pen walk is paid twice there and is paid twice here.
 *
 * THE THREE COUNTERS ARE SUMMED OVER PASSES, not overwritten by the last one. A fill pass that
 * clobbered the outline pass's numbers would report an outlined frame as costing exactly what an
 * un-outlined one costs, which is the flattering direction.
 */
function drawHbGpu(state: State, frame: number): void {
  const gpu = state.gpu;
  if (!gpu) return;
  let quads = 0;
  let drawCalls = 0;
  let inkless = 0;
  for (const pass of gpu.arm.passes) {
    gpu.arm.begin(pass);
    state.runs.forEach((run, index) => {
      const centre = runCentre(state, run, frame);
      // `hbLayout` and therefore `glyphLocal`: the same placement the baked arms use, from the same
      // measured per-face baseline. `bakeRotation` is part of that struct and is not read here —
      // there is no bake — and it cannot be anything but the default, because a non-default value
      // is refused at mount. Both passes are handed the SAME centre and the same layout, which is
      // what makes the fill land exactly inside the band the outline drew.
      gpu.arm.push(gpu.shaped[index], centre.x, centre.y, hbLayout(state, run));
    });
    const stats = gpu.arm.end();
    quads += stats.instances;
    drawCalls += stats.drawCalls;
    inkless += stats.inkless;
  }
  gpu.quadsLastFrame = quads;
  gpu.drawCallsLastFrame = drawCalls;
  gpu.inklessLastFrame = inkless;
}
