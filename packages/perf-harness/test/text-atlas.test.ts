// @vitest-environment node
//
// The baked arms' arithmetic, provable without a GPU.
//
// EVERY FAILURE THIS FILE GUARDS AGAINST LOOKS FINE IN A SCREENSHOT. A packer that overlaps two
// cells puts a stray stroke beside an unrelated character; one that runs off a page draws a glyph
// that is simply absent; a phase bucket that picks the wrong variant moves every glyph by half a
// pixel, which is exactly the crawl `hb-atlas` exists to remove and exactly what the fidelity
// probe's `alignmentPx` would then report as a failed row. None of it throws, and S9's presence
// guard samples only the beacon — the first and smallest cell packed, and therefore the one most
// likely to survive a packer bug intact.

import { describe, expect, it } from "vitest";
import {
  ATLAS_PADDING,
  atlasPageSideFor,
  type Bounds,
  cellGeometryFor,
  packShelves,
  phaseGridFor,
  phaseIndexAt,
  phaseOffsetAt,
  rotateBounds,
  type ShelfCell,
} from "../src/scenarios/text-atlas";
import { faceIdOf, glyphKey } from "../src/scenarios/text-hb";

function cells(count: number, width: number, height: number): ShelfCell[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `c${i}`,
    width,
    height,
  }));
}

function overlaps(
  a: { page: number; x: number; y: number; width: number; height: number },
  b: { page: number; x: number; y: number; width: number; height: number },
): boolean {
  if (a.page !== b.page) return false;
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

describe("packShelves", () => {
  it("places every cell exactly once, inside its page, without overlapping", () => {
    // Mixed heights so the height-sorted shelves actually have to work.
    const input = [
      ...cells(40, 17, 17),
      ...cells(15, 31, 9).map((c) => ({ ...c, key: `w${c.key}` })),
      ...cells(9, 8, 44).map((c) => ({ ...c, key: `t${c.key}` })),
    ];
    const packed = packShelves(input, 256, 256);

    expect(packed.placements).toHaveLength(input.length);
    expect(new Set(packed.placements.map((p) => p.key)).size).toBe(
      input.length,
    );
    for (const placement of packed.placements) {
      expect(placement.x).toBeGreaterThanOrEqual(0);
      expect(placement.y).toBeGreaterThanOrEqual(0);
      expect(placement.x + placement.width).toBeLessThanOrEqual(256);
      expect(placement.y + placement.height).toBeLessThanOrEqual(256);
    }
    for (let i = 0; i < packed.placements.length; i += 1) {
      for (let j = i + 1; j < packed.placements.length; j += 1) {
        expect(overlaps(packed.placements[i], packed.placements[j])).toBe(
          false,
        );
      }
    }
  });

  it("spills onto more pages rather than dropping cells", () => {
    // 64x64 cells on a 128x128 page: two per shelf, two shelves once the gutters are paid for.
    const packed = packShelves(cells(20, 64, 64), 128, 128);
    expect(packed.placements).toHaveLength(20);
    expect(packed.pages).toBeGreaterThan(1);
    expect(Math.max(...packed.placements.map((p) => p.page))).toBe(
      packed.pages - 1,
    );
  });

  it("refuses a cell too big for a page, naming it", () => {
    expect(() =>
      packShelves([{ key: "huge", width: 300, height: 12 }], 256, 256),
    ).toThrow(/"huge"/);
  });

  it("allocates each page only as tall as its shelves reached", () => {
    // Nine 20x20 cells on a 256-wide page: one shelf, so the page needs ~22 rows and not 256.
    const packed = packShelves(cells(9, 20, 20), 256, 256);
    expect(packed.pages).toBe(1);
    expect(packed.pageHeights[0]).toBe(ATLAS_PADDING + 20 + ATLAS_PADDING);
    // Occupancy is measured against what was ALLOCATED, so trimming has to show up here — this is
    // the number that decides whether `atlasBytes` describes glyphs or padding.
    expect(packed.occupancy).toBeGreaterThan(0.6);
  });

  it("is reproducible: the same cells in a different order pack identically", () => {
    const input = [
      ...cells(12, 13, 21),
      ...cells(12, 21, 13).map((c) => ({ ...c, key: `b${c.key}` })),
    ];
    const forward = packShelves(input, 128, 128);
    const backward = packShelves([...input].reverse(), 128, 128);
    expect(backward.placements).toEqual(forward.placements);
  });

  it("packs nothing into no pages", () => {
    const packed = packShelves([], 256, 256);
    expect(packed).toMatchObject({ pages: 0, occupancy: 0 });
    expect(packed.pageHeights).toEqual([]);
  });
});

describe("glyph keys across two faces", () => {
  it("never lets two faces collide on one key", () => {
    // The failure this prevents is the worst kind in this round: Roboto's gid 97 and Noto Sans SC's
    // gid 97 are unrelated outlines, and an unqualified key would put one of them where the other
    // belongs. The result is perfectly crisp, perfectly aligned, WRONG text — every metric here
    // stays green and only a human looking at the still would notice.
    expect(glyphKey("han", "g97")).not.toBe(glyphKey("latin", "g97"));
    expect(faceIdOf(glyphKey("han", "g97"))).toBe("han");
    expect(faceIdOf(glyphKey("latin", "g97"))).toBe("latin");
  });

  it("survives a `fillText` key that is itself a separator or a hash", () => {
    // The `fillText` shaper keys by CHARACTER, and the Latin charset contains both `/` and `#`.
    // `faceIdOf` splits on the FIRST separator, and `bakeAtlas` reads the phase back with
    // `lastIndexOf("#")`, so both remain unambiguous — but only because of which end each looks at.
    expect(faceIdOf(glyphKey("latin", "/"))).toBe("latin");
    expect(faceIdOf(glyphKey("latin", "#"))).toBe("latin");
    const key = `${glyphKey("latin", "#")}#3`;
    expect(key.slice(0, key.lastIndexOf("#"))).toBe(glyphKey("latin", "#"));
    expect(key.slice(key.lastIndexOf("#") + 1)).toBe("3");
  });

  it("packs two faces' cells side by side without either dropping out", () => {
    // The packer is keyed by string and knows nothing about faces, which is the point — but it also
    // SORTS by key on ties, so two faces sharing a key would silently pack one cell where two were
    // asked for and one glyph would be missing everywhere it appeared.
    const cells: ShelfCell[] = ["han", "latin"].flatMap((face) =>
      Array.from({ length: 8 }, (_, i) => ({
        key: glyphKey(face, `g${i}`),
        width: 12,
        height: 14,
      })),
    );
    const packed = packShelves(cells, 256, 256);
    expect(packed.placements).toHaveLength(16);
    expect(new Set(packed.placements.map((p) => p.key)).size).toBe(16);
  });
});

describe("sub-pixel phases", () => {
  it("reads `phases` as a square grid, rounding to the nearest real one", () => {
    expect(phaseGridFor(1)).toBe(1);
    expect(phaseGridFor(4)).toBe(2);
    expect(phaseGridFor(9)).toBe(3);
    expect(phaseGridFor(16)).toBe(4);
    // 8 is not a square. Rounding UP to 3x3 is the deliberate choice: rounding down would silently
    // halve the positional accuracy someone asked to increase.
    expect(phaseGridFor(8)).toBe(3);
    expect(phaseGridFor(0)).toBe(1);
  });

  it("never picks a bucket more than half a bucket away from the real fraction", () => {
    // The load-bearing claim of the whole arm: the pre-baked offset stands in for the true
    // sub-pixel position, so the error it introduces IS the arm's positional error. At the default
    // 2x2 that must stay at a quarter of a pixel.
    for (const grid of [1, 2, 3, 4]) {
      let worst = 0;
      for (let i = 0; i <= 200; i += 1) {
        const fx = i / 200;
        const fy = ((i * 7) % 200) / 200;
        const offset = phaseOffsetAt(phaseIndexAt(fx, fy, grid), grid);
        worst = Math.max(
          worst,
          Math.abs(offset.x - fx),
          Math.abs(offset.y - fy),
        );
      }
      expect(worst).toBeLessThanOrEqual(0.5 / grid + 1e-9);
    }
  });

  it("clamps a fraction of exactly 1 into the last bucket", () => {
    // `originX - Math.floor(originX)` is in `[0, 1)` mathematically, but a float that rounds up to
    // exactly 1.0 would index one past the end of the phase array and blank the glyph.
    expect(phaseIndexAt(1, 1, 3)).toBe(8);
    expect(phaseIndexAt(-0.2, -0.2, 3)).toBe(0);
  });

  it("addresses the grid row-major, so a bucket is (x, y) and not (y, x)", () => {
    // Swapping the axes here would leave every test above passing and shift every glyph diagonally.
    expect(phaseIndexAt(0.9, 0.1, 3)).toBe(2);
    expect(phaseOffsetAt(2, 3).x).toBeCloseTo(5 / 6);
    expect(phaseOffsetAt(2, 3).y).toBeCloseTo(1 / 6);
  });
});

describe("rotateBounds", () => {
  it("turns a quarter turn into a swapped box", () => {
    const box: Bounds = { minX: 1, minY: 2, maxX: 5, maxY: 4 };
    const turned = rotateBounds(box, Math.PI / 2);
    expect(turned.minX).toBeCloseTo(-4);
    expect(turned.maxX).toBeCloseTo(-2);
    expect(turned.minY).toBeCloseTo(1);
    expect(turned.maxY).toBeCloseTo(5);
  });

  it("grows the box at 10 degrees — which is what the atlas has to pay for", () => {
    const box: Bounds = { minX: -6, minY: -10, maxX: 6, maxY: 2 };
    const turned = rotateBounds(box, (10 * Math.PI) / 180);
    expect(turned.maxX - turned.minX).toBeGreaterThan(box.maxX - box.minX);
    expect(turned.maxY - turned.minY).toBeGreaterThan(box.maxY - box.minY);
  });
});

describe("cellGeometryFor", () => {
  it("contains the ink, the phase offset and the antialiasing slack", () => {
    const ink: Bounds = { minX: -0.4, minY: -9.7, maxX: 11.3, maxY: 2.2 };
    const cell = cellGeometryFor(ink);
    // A glyph drawn at the worst-case phase (just under +1 px in both axes) still has to land
    // wholly inside the cell, or a stem gets clipped and it reads as a font bug.
    expect(cell.offsetX).toBeLessThanOrEqual(Math.floor(ink.minX));
    expect(cell.offsetY).toBeLessThanOrEqual(Math.floor(ink.minY));
    expect(cell.offsetX + cell.width).toBeGreaterThanOrEqual(ink.maxX + 1);
    expect(cell.offsetY + cell.height).toBeGreaterThanOrEqual(ink.maxY + 1);
    expect(Number.isInteger(cell.offsetX)).toBe(true);
    expect(Number.isInteger(cell.offsetY)).toBe(true);
  });

  it("gives a blank glyph one texel rather than a null case", () => {
    expect(cellGeometryFor({ minX: 0, minY: 0, maxX: 0, maxY: 0 })).toEqual({
      width: 1,
      height: 1,
      offsetX: 0,
      offsetY: 0,
    });
    expect(
      cellGeometryFor({
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      }).width,
    ).toBe(1);
  });

  it("round-trips a fractional device position back to within half a phase bucket", () => {
    // The composition the draw loop performs, in one place: snap the origin, choose a bucket from
    // the fraction, put the cell at `floor(origin) + cellOffset`, and the glyph's baked anchor
    // lands back at `floor(origin) + bucketOffset`. If any of the three roundings disagreed, every
    // glyph would sit a fraction of a pixel off and `alignmentPx` would flag the arm.
    const grid = 2;
    const cell = cellGeometryFor({
      minX: -0.4,
      minY: -9.7,
      maxX: 11.3,
      maxY: 2.2,
    });
    for (const origin of [10.0, 10.13, 41.5, 41.87, 199.999]) {
      const whole = Math.floor(origin);
      const bucket = phaseIndexAt(origin - whole, origin - whole, grid);
      const drawnAt =
        whole + cell.offsetX + (-cell.offsetX + phaseOffsetAt(bucket, grid).x);
      expect(Math.abs(drawnAt - origin)).toBeLessThanOrEqual(0.5 / grid + 1e-9);
    }
  });
});

describe("atlasPageSideFor", () => {
  it("grows in powers of two and stops at the ceiling", () => {
    expect(atlasPageSideFor(1, 2048)).toBe(256);
    expect(atlasPageSideFor(256 * 256, 2048)).toBe(512);
    expect(atlasPageSideFor(4096 * 4096, 2048)).toBe(2048);
    expect(atlasPageSideFor(1, 128)).toBe(128);
  });

  it("is monotonic, so more glyphs never ask for a smaller page", () => {
    let previous = 0;
    for (const area of [1, 1e3, 1e4, 1e5, 1e6, 1e7]) {
      const side = atlasPageSideFor(area, 2048);
      expect(side).toBeGreaterThanOrEqual(previous);
      previous = side;
    }
  });

  // The `hb-run` failure mode: one cell is a WHOLE baked run, so a tiny total area can still carry
  // a cell longer than the page that area asks for. Measured on the fidelity probe at fontSize 16 —
  // a 265x65 Latin pangram cell against an area-derived 256 page, which `packShelves` refused.
  it("grows to hold the largest single cell, whatever the total area says", () => {
    expect(atlasPageSideFor(265 * 65, 2048)).toBe(256);
    expect(atlasPageSideFor(265 * 65, 2048, undefined, 265)).toBe(512);
    // The long side is the one that decides it, on either axis.
    expect(atlasPageSideFor(1, 2048, undefined, 300)).toBe(512);
    expect(atlasPageSideFor(1, 2048, undefined, 100)).toBe(256);
  });

  // A page it hands back must be one `packShelves` accepts, or the fix is arithmetic that moved the
  // failure rather than removed it. 254 fits a 256 page only if the gutter is counted on ONE edge;
  // the packer counts it on both.
  it("leaves room for the gutter on both edges", () => {
    for (const side of [253, 254, 255, 256, 510, 511, 512]) {
      const page = atlasPageSideFor(1, 2048, undefined, side);
      expect(() =>
        packShelves([{ key: "widest", width: side, height: 4 }], page, page),
      ).not.toThrow();
      expect(() =>
        packShelves([{ key: "tallest", width: 4, height: side }], page, page),
      ).not.toThrow();
    }
  });

  // The ceiling still wins: a cell too big for `maxSide` is the packer's refusal to make, and it
  // names the cell. Silently returning something larger than the caller's ceiling would put a page
  // past `MAX_TEXTURE_SIZE` on the phone, where the ceiling is 4096 rather than this box's 32768.
  it("does not exceed maxSide for an over-large cell", () => {
    expect(atlasPageSideFor(1, 512, undefined, 4000)).toBe(512);
  });
});
