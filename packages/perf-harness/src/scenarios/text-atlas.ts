// The arithmetic behind a baked glyph atlas — shelf packing, sub-pixel phase buckets and rotated
// bounding boxes — with no browser in it.
//
// SPLIT OUT SO IT CAN BE TESTED WITHOUT A GPU. Everything here is a decision that changes what is
// on screen (which page a glyph lands on, which of N pre-rendered offsets is chosen, how big a cell
// has to be to hold a rotated glyph) and every one of those failures looks the same from the
// outside: text that is subtly in the wrong place, or missing. A packer bug that drops the last
// glyph of a page passes S9's presence guard, because the guard samples the BEACON — the first
// glyph of the run — and the beacon is packed first. So these are node tests, not screenshots.

/**
 * Transparent gutter around every cell, in device px.
 *
 * `hb-atlas` draws its cells at exact 1:1 with integer device-pixel corners, where bilinear
 * filtering lands precisely on texel centres and could not reach a neighbour even with no gutter.
 * `hb-run` is the arm that needs it: it draws its baked runs at FRACTIONAL positions, so every
 * sample is a blend of four texels and a cell touching its neighbour would drag that neighbour's
 * ink across the seam. One px is enough because a bilinear tap reaches at most half a texel past
 * the edge.
 */
export const ATLAS_PADDING = 1;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ShelfCell {
  key: string;
  width: number;
  height: number;
}

export interface ShelfPlacement extends ShelfCell {
  /** Index of the atlas page this cell was placed on. */
  page: number;
  /** Top-left of the cell's PIXELS on that page, gutter excluded. */
  x: number;
  y: number;
}

export interface ShelfPacking {
  placements: ShelfPlacement[];
  pages: number;
  pageWidth: number;
  /** The height the packer was allowed to fill — the ceiling, not what was allocated. */
  pageHeight: number;
  /**
   * The height each page is actually ALLOCATED at: its last shelf's bottom plus a gutter, not
   * `pageHeight`.
   *
   * A page is sized by the power-of-two rule so that page COUNTS stay comparable between
   * environments whose device pixel ratios differ by 3.5x, and that rule routinely picks a square
   * twice as tall as the shelves need — 1024x1024 for 1060 glyph variants that fill 300 rows, which
   * is 4.2 MB of VRAM reported for 1.2 MB of atlas. Since every page is its own texture and every
   * source rect is in page pixels, trimming the unused rows costs nothing and stops `atlasBytes`
   * from being three quarters an artefact of a rounding rule.
   */
  pageHeights: number[];
  /** Cell area as a fraction of ALLOCATED page area — how much of the VRAM is glyph. */
  occupancy: number;
}

/**
 * Pack `cells` onto as many `pageWidth` x `pageHeight` pages as it takes, tallest first.
 *
 * A shelf packer rather than anything cleverer: cells here are glyphs at ONE size, so their heights
 * cluster tightly, and height-sorted shelves waste almost nothing on that input while staying
 * O(n log n) and reproducible. A general rectangle packer would buy a few percent of occupancy for
 * a much harder-to-verify placement — and occupancy is reported, so the claim is checkable rather
 * than assumed.
 *
 * THROWS when a single cell cannot fit a page, naming it. The alternative — dropping it — produces
 * one invisible glyph in a wall of text, which no automated check in this repo would catch: S9's
 * presence guard samples the beacon, and the beacon is the first and smallest cell packed.
 */
export function packShelves(
  cells: readonly ShelfCell[],
  pageWidth: number,
  pageHeight: number,
  padding: number = ATLAS_PADDING,
): ShelfPacking {
  const usableW = pageWidth - padding;
  const usableH = pageHeight - padding;
  // Sorted on a COPY, and by key when heights tie: the caller's order is meaningful (glyph order in
  // a run) and a packing that depended on the iteration order of a Map would not be reproducible
  // between a node test and a browser.
  const sorted = [...cells].sort(
    (a, b) =>
      b.height - a.height || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const placements: ShelfPlacement[] = [];
  let page = 0;
  let shelfY = padding;
  let shelfH = 0;
  let penX = padding;
  let usedArea = 0;

  for (const cell of sorted) {
    if (cell.width > usableW - padding || cell.height > usableH - padding) {
      throw new Error(
        `text atlas: cell "${cell.key}" is ${cell.width}x${cell.height} device px, which does not fit a ${pageWidth}x${pageHeight} page with ${padding} px gutters. Raise the page size or lower fontSize/dpr — silently dropping it would leave one blank glyph that no presence guard samples.`,
      );
    }
    if (penX + cell.width > usableW) {
      // Next shelf.
      shelfY += shelfH + padding;
      penX = padding;
      shelfH = 0;
    }
    if (shelfY + cell.height > usableH) {
      // Next page.
      page += 1;
      shelfY = padding;
      penX = padding;
      shelfH = 0;
    }
    placements.push({ ...cell, page, x: penX, y: shelfY });
    penX += cell.width + padding;
    shelfH = Math.max(shelfH, cell.height);
    usedArea += cell.width * cell.height;
  }

  const pages = placements.length === 0 ? 0 : page + 1;
  const pageHeights = new Array<number>(pages).fill(0);
  for (const placement of placements) {
    pageHeights[placement.page] = Math.max(
      pageHeights[placement.page],
      placement.y + placement.height + padding,
    );
  }
  const allocated = pageHeights.reduce((sum, h) => sum + h * pageWidth, 0);
  return {
    placements,
    pages,
    pageWidth,
    pageHeight,
    pageHeights,
    occupancy: allocated === 0 ? 0 : usedArea / allocated,
  };
}

/**
 * Side of the square sub-pixel grid `phases` asks for.
 *
 * `phases` is the TOTAL number of pre-rendered offsets per glyph, so 4 is a 2x2 grid and 9 a 3x3 —
 * the shape a translating run needs, because a run rotated 10 degrees moves in BOTH axes and a
 * one-dimensional phase ladder would quantize only one of them. Rounded rather than floored so a
 * request for 8 lands on 9 (a real 3x3) instead of 4; the effective count is published as
 * `atlasPhases` so the table never has to trust the request.
 */
export function phaseGridFor(phases: number): number {
  return Math.max(1, Math.round(Math.sqrt(Math.max(1, phases))));
}

/** Which pre-rendered offset a glyph landing at sub-pixel `(fx, fy)` should sample. */
export function phaseIndexAt(fx: number, fy: number, grid: number): number {
  const cx = Math.min(grid - 1, Math.max(0, Math.floor(fx * grid)));
  const cy = Math.min(grid - 1, Math.max(0, Math.floor(fy * grid)));
  return cy * grid + cx;
}

/**
 * The sub-pixel offset bucket `index` was BAKED at — the centre of the bucket, not its edge.
 *
 * Centre because the bucket covers `[i/grid, (i+1)/grid)` and the worst case is what matters: a
 * bucket baked at its left edge is up to `1/grid` px wrong, one baked at its centre at most
 * `0.5/grid`. At the default 2x2 that is the difference between a quarter-pixel and a half-pixel
 * of positional error, and half a pixel at 12 px is visible as the crawl this round exists to kill.
 */
export function phaseOffsetAt(
  index: number,
  grid: number,
): { x: number; y: number } {
  const cx = index % grid;
  const cy = Math.floor(index / grid);
  return { x: (cx + 0.5) / grid, y: (cy + 0.5) / grid };
}

/** The axis-aligned box that contains `bounds` rotated `radians` about the origin. */
export function rotateBounds(bounds: Bounds, radians: number): Bounds {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ]) {
    xs.push(x * cos - y * sin);
    ys.push(x * sin + y * cos);
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export interface CellGeometry {
  /** Cell size in device px, integral. */
  width: number;
  height: number;
  /** Device-px vector from the glyph's ORIGIN to the cell's top-left corner. Integral, negative-ish. */
  offsetX: number;
  offsetY: number;
}

/**
 * The cell that holds a glyph whose device-space ink occupies `bounds` relative to its origin.
 *
 * Grown by one px in every direction beyond the outward rounding, because the bake draws the glyph
 * at a sub-pixel offset of up to 1 px inside the cell (see {@link phaseOffsetAt}) and because a
 * rasterizer's antialiasing bleeds a fraction of a pixel past the mathematical outline. A cell that
 * is one px too small does not fail — it CLIPS a stem, which reads as a font bug.
 *
 * The offsets are integral so a draw can snap the destination quad to whole device pixels, which is
 * the entire reason the phases exist: an integral destination plus a pre-offset bitmap is a 1:1
 * texel-to-pixel blit, while a fractional destination is a bilinear resample and no amount of
 * atlas resolution recovers from it.
 */
export function cellGeometryFor(bounds: Bounds, slack = 1): CellGeometry {
  if (
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.minY) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.maxY) ||
    bounds.maxX <= bounds.minX ||
    bounds.maxY <= bounds.minY
  ) {
    // A blank glyph (a space, or `.notdef` in a subset face). One texel, so the packer, the counters
    // and the draw loop all stay uniform instead of growing a null case each.
    return { width: 1, height: 1, offsetX: 0, offsetY: 0 };
  }
  const offsetX = Math.floor(bounds.minX) - slack;
  const offsetY = Math.floor(bounds.minY) - slack;
  return {
    width: Math.ceil(bounds.maxX) + slack + 1 - offsetX,
    height: Math.ceil(bounds.maxY) + slack + 1 - offsetY,
    offsetX,
    offsetY,
  };
}

/**
 * Atlas page side to use for `cells` worth of pixels: the smallest power of two from 256 up whose
 * area covers the demand with room for shelf waste, AND which the largest single cell fits inside,
 * clamped to `maxSide`.
 *
 * Powers of two are not required by WebGL2 for `CLAMP_TO_EDGE` + `LINEAR`, and this is not
 * cargo cult: it keeps the page count comparable between environments whose device pixel ratios
 * differ by 3.5x, so `atlasPages` reads as "how much atlas did this workload need" rather than as
 * an artefact of a rounding rule that moved.
 *
 * `largestCellSide` IS LOAD-BEARING AND WAS NOT ALWAYS HERE. Total area alone can choose a page that
 * no single cell fits in, because area says nothing about the longest side: measured on the fidelity
 * probe at fontSize 16, `hb-run`'s baked Latin pangram is one 265x65 cell whose area-derived page
 * came out 256, and `packShelves` refused the whole bake. The refusal was correct and the page size
 * was not — 512 was available under the same ceiling. This is a `hb-run` failure mode by
 * construction (it bakes a WHOLE RUN into one cell, so its cells grow with the text) and it gets
 * worse with the device pixel ratio, which is exactly the direction a phone run moves. Cells are
 * sorted by height for shelving, so nothing else in the packer would have caught it.
 */
export function atlasPageSideFor(
  totalCellArea: number,
  maxSide: number,
  slackFactor = 1.35,
  largestCellSide = 0,
): number {
  const target = Math.sqrt(Math.max(1, totalCellArea) * slackFactor);
  // `packShelves` places at `padding` and rejects anything wider than `pageSide - 2 * padding`, so
  // the gutter is counted on BOTH edges here. One padding short and this would hand back a page the
  // packer still refuses, which is the same bug with more arithmetic in front of it.
  const mustHold = largestCellSide + 2 * ATLAS_PADDING;
  let side = 256;
  while (side < Math.max(target, mustHold) && side < maxSide) side *= 2;
  return Math.min(side, maxSide);
}
