// THE CASE MATRIX FOR THE A1 TEXT-QUALITY CROSSOVER, and the one place it is written down.
//
// The question: at what size does each of our text arms stop being similar-or-better than the
// engine the consumer is mirroring? The evidence that opened it is a byte reading rather than an
// impression — the game draws "End Turn 1" with a byte-UNIFORM interior (#ffedc8 everywhere inside
// the glyph body) and the hb-gpu arm's interior is mottled (#feecc7 / #f8e7c4 / #f6e6c2 mixed) at
// ppem ~52, i.e. even LARGE text fails per-pixel. So the sweep runs to 52 rather than stopping
// where a blur argument would.
//
// PURE DATA AND PURE FUNCTIONS. No node, no DOM, no font bytes. Four consumers read this module and
// none of them may re-derive a cell rectangle or a pen position of its own:
//
//   * `text-crossover.ts`         — the node driver, browser arms a/b/c
//   * `text-crossover-hb.ts`      — the bundled browser module for the hb-gpu arm
//   * `scripts/godot-text-crossover.ts` — writes the GDScript manifest for arm d
//   * `text-crossover-metrics.ts` — crops a cell out of a frame to measure it
//
// A second copy of `cellRect` in the Godot half would be free to drift half a pixel from the
// browser half, and half a pixel is the entire subject of metric (ii). The GDScript is handed
// absolute cell rectangles in its manifest and derives nothing.
//
// ONE GRID PER (arm, variant), NOT ONE FRAME PER CASE. Every case of a variant is drawn into one
// frame on a fixed grid, so arm d costs three Godot launches instead of eighty-four, and a
// cell-to-cell byte diff is a crop at the same rectangle on both sides.

/** Device pixels per em. DPR is pinned to 1 by the driver, so this is also the CSS font size. */
export const CROSSOVER_PPEM = [16, 20, 24, 28, 32, 48, 52] as const;

/**
 * Dilation radius in device px, per column.
 *
 * `0` IS A MEASURED CASE, NOT A CONTROL THAT WAS LEFT OUT. Signature (2) under test is "the fill's
 * interior coverage is below 1.0 and the dark outline drawn UNDER it shows through", and the only
 * thing that separates it from "the fill's interior coverage is below 1.0 full stop" is the same
 * fill with nothing beneath it.
 *
 * 3, 4.5 and 6 are the product's own radii. Godot's stroker takes `outline_size / 4`, so each has
 * to be a quarter-integer or the engine cannot be asked for it — see {@link outlineSizeFor}.
 */
export const CROSSOVER_SPREAD_PX = [0, 3, 4.5, 6] as const;

/** Godot's `draw_char_outline` size argument for a radius: four times it. Integral by construction. */
export function outlineSizeFor(spreadPx: number): number {
  return Math.round(spreadPx * 4);
}

/**
 * The string every case draws.
 *
 * THE PRODUCT'S OWN LABEL, because the reported defect is on this word at this size and a synthetic
 * "B" would not carry the curve joins the mottle was seen on. It is ten glyphs with two round
 * bowls, three stems and a digit, which is enough shape variety for an interior mask to survive
 * erosion at ppem 16 and still be a real glyph body rather than one fat stroke.
 */
export const CROSSOVER_TEXT = "End Turn 1";

/**
 * The three colour schemes each case is rendered in, and why one is not enough.
 *
 * `product` is the picture the user is looking at: light ink, black outline, dark card behind it.
 * It is the ONLY variant on which interior uniformity (metric i) and the byte diff against Godot
 * (metric ii) mean anything, because both are statements about bytes at the product's own colours.
 *
 * `fillMono` and `outlineMono` are white-on-black, which makes the decoded byte the COVERAGE with
 * no background to subtract — the same convention `packages/hb-gpu/test/goldens/`'s committed Godot
 * golden already uses, so an edge width measured here is comparable to one measured there. Edge
 * profiles (metric iii) are measured on these and never on `product`: a 10%->90% transition needs a
 * plane with one edge in it, and `product` has two edges a few pixels apart at every glyph boundary
 * (background->outline, then outline->fill). Measuring "the fill edge" on that plane would report
 * the distance between two different boundaries.
 *
 * `outlineMono` DRAWS THE FILL TOO, both white. Godot's `draw_char_outline` strokes both borders and
 * leaves a ring; the fill is what closes it into the dilated silhouette that `setSpread` produces on
 * our side. Same reason `godot/project/scripts/outline_ref.gd` states.
 */
export type CrossoverVariant = "product" | "fillMono" | "outlineMono";

export const CROSSOVER_VARIANTS: readonly CrossoverVariant[] = [
  "product",
  "fillMono",
  "outlineMono",
];

export interface VariantColors {
  /** Opaque, and the frame's clear colour. */
  background: [number, number, number];
  /** The dilated pass, drawn FIRST and therefore underneath. */
  outline: [number, number, number];
  /** The undilated pass, drawn second. */
  fill: [number, number, number];
  /** Whether the outline pass is drawn at all in this variant. */
  drawOutline: boolean;
  /** Whether the fill pass is drawn at all in this variant. */
  drawFill: boolean;
}

/** The product's fill. The byte triple the game's interior holds everywhere and ours does not. */
export const PRODUCT_FILL: [number, number, number] = [0xff, 0xed, 0xc8];

/**
 * The product's outline, and pure black on purpose.
 *
 * The defect under test is a light fill blending with a DARK underlay, and black maximises that
 * signal: at fill coverage `c` an interior pixel reads `round(c * fill)` exactly, so the shortfall
 * in bytes converts straight back to a coverage without a second unknown in the arithmetic. A
 * mid-tone outline would leave "how far below 1.0 is the coverage" and "what is under it"
 * unidentifiable from one byte.
 */
export const PRODUCT_OUTLINE: [number, number, number] = [0x00, 0x00, 0x00];

/**
 * The card behind the text: a dark brown, and NOT equal to the outline.
 *
 * If the background were also black the outline's own boundary would be invisible in `product` and
 * the presence guard could not tell an outline that was drawn from one that was skipped.
 */
export const PRODUCT_BACKGROUND: [number, number, number] = [0x24, 0x1a, 0x10];

export function colorsFor(variant: CrossoverVariant): VariantColors {
  switch (variant) {
    case "product":
      return {
        background: PRODUCT_BACKGROUND,
        outline: PRODUCT_OUTLINE,
        fill: PRODUCT_FILL,
        drawOutline: true,
        drawFill: true,
      };
    case "fillMono":
      return {
        background: [0, 0, 0],
        outline: [0, 0, 0],
        fill: [255, 255, 255],
        drawOutline: false,
        drawFill: true,
      };
    case "outlineMono":
      return {
        background: [0, 0, 0],
        outline: [255, 255, 255],
        fill: [255, 255, 255],
        drawOutline: true,
        drawFill: true,
      };
  }
}

/** Cell side, device px. Fixed so the grid arithmetic is the same integer on both engines. */
export const CELL_WIDTH = 320;
export const CELL_HEIGHT = 160;

/**
 * The pen, inside its cell, on the baseline. WHOLE PIXELS.
 *
 * A fractional pen would put every arm on a different sub-pixel phase of the same glyph and metric
 * (ii) would be reading that phase rather than the rasteriser. The x leaves room for a 6 px
 * dilation at the left bearing; the y leaves the descender of the widest case inside the cell.
 */
export const PEN_X = 16;
export const PEN_Y = 104;

export interface CrossoverCase {
  /** Stable key. Appears in the report, the manifest and every log line. */
  name: string;
  pixelsPerEm: number;
  spreadPx: number;
  /** Godot's argument, `4 * spreadPx`. Stated rather than derived at the call site. */
  outlineSize: number;
  /** Grid position, device px, top-left of the cell in the frame. */
  cellX: number;
  cellY: number;
  /** Absolute pen position in the frame: `cell + PEN_*`. */
  penX: number;
  penY: number;
}

/** Column per spread, row per ppem — so a column reads as a size sweep at one outline radius. */
export const CROSSOVER_CASES: readonly CrossoverCase[] = CROSSOVER_PPEM.flatMap(
  (ppem, row) =>
    CROSSOVER_SPREAD_PX.map((spreadPx, col) => {
      const cellX = col * CELL_WIDTH;
      const cellY = row * CELL_HEIGHT;
      return {
        name: `ppem${ppem}-spread${String(spreadPx).replace(".", "p")}`,
        pixelsPerEm: ppem,
        spreadPx,
        outlineSize: outlineSizeFor(spreadPx),
        cellX,
        cellY,
        penX: cellX + PEN_X,
        penY: cellY + PEN_Y,
      };
    }),
);

export const GRID_COLUMNS = CROSSOVER_SPREAD_PX.length;
export const GRID_ROWS = CROSSOVER_PPEM.length;
export const FRAME_WIDTH = GRID_COLUMNS * CELL_WIDTH;
export const FRAME_HEIGHT = GRID_ROWS * CELL_HEIGHT;

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The cell a case owns, in frame coordinates. The ONE definition; nobody re-derives it. */
export function cellRect(entry: CrossoverCase): CellRect {
  return {
    x: entry.cellX,
    y: entry.cellY,
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
  };
}

export function caseByName(name: string): CrossoverCase | undefined {
  return CROSSOVER_CASES.find((entry) => entry.name === name);
}

/**
 * The calibration patch, and the reason every coverage byte below is trustworthy.
 *
 * White at alpha `a` over black decodes to `round(255 a)` if and only if the frame never went
 * through a linear->sRGB conversion on its way to a PNG. If it did, 0.5 would come back as ~188
 * instead of 128, every number in this sweep would be off by a transfer curve, and nothing else in
 * the pipeline would notice. `outline_ref.gd` already carries this and it is repeated here because
 * a SECOND engine (the browser) is being asked the same question — and because signature (1) under
 * test is exactly an off-by-one-per-channel colour-pipeline error, which a patch that reads 127
 * instead of 128 would localise in one line.
 */
export const CALIBRATION_ALPHAS = [0.25, 0.5, 0.75] as const;

/** Byte slack on the patch. 1 covers `round(127.5)`; nothing else here is near a boundary. */
export const CALIBRATION_TOLERANCE = 1;

/** Where the patch is drawn, in a band under the grid that no cell reaches. */
export const CALIBRATION_HEIGHT = 40;
export const CALIBRATION_WIDTH = 64;
export const CALIBRATION_TOP = FRAME_HEIGHT;
/** The frame is the grid plus the calibration band. */
export const CANVAS_HEIGHT = FRAME_HEIGHT + CALIBRATION_HEIGHT;

export interface CalibrationSwatch {
  x: number;
  width: number;
  alpha: number;
}

export const CALIBRATION_SWATCHES: readonly CalibrationSwatch[] =
  CALIBRATION_ALPHAS.map((alpha, index) => ({
    x: index * CALIBRATION_WIDTH,
    width: CALIBRATION_WIDTH,
    alpha,
  }));
