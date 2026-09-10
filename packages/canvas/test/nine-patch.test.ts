import { describe, expect, it } from "vitest";
import {
  createNinePatchBands,
  expandNinePatch,
  type NinePatchBand,
  type NinePatchGeometry,
} from "../src/nine-patch";

function patch(overrides: Partial<NinePatchGeometry> = {}): NinePatchGeometry {
  return {
    w: 100,
    h: 60,
    srcX: 200,
    srcY: 300,
    srcW: 40,
    srcH: 30,
    marginLeft: 8,
    marginTop: 6,
    marginRight: 8,
    marginBottom: 6,
    ...overrides,
  };
}

function expand(geometry: NinePatchGeometry): NinePatchBand[] {
  const bands = createNinePatchBands();
  return bands.slice(0, expandNinePatch(geometry, bands)).map((band) => ({
    ...band,
  }));
}

describe("expandNinePatch", () => {
  it("splits a well-formed patch into nine bands that tile the destination", () => {
    const geometry = patch();
    const bands = expand(geometry);
    expect(bands).toHaveLength(9);

    // The destination is covered exactly once: summed band area equals w*h, and
    // the extreme edges are the rect's own.
    const area = bands.reduce((sum, band) => sum + band.dstW * band.dstH, 0);
    expect(area).toBeCloseTo(geometry.w * geometry.h, 10);
    expect(Math.min(...bands.map((b) => b.dstX))).toBe(0);
    expect(Math.min(...bands.map((b) => b.dstY))).toBe(0);
    expect(Math.max(...bands.map((b) => b.dstX + b.dstW))).toBe(geometry.w);
    expect(Math.max(...bands.map((b) => b.dstY + b.dstH))).toBe(geometry.h);

    // …and so is the source REGION, in page coordinates.
    expect(Math.min(...bands.map((b) => b.srcX))).toBe(geometry.srcX);
    expect(Math.min(...bands.map((b) => b.srcY))).toBe(geometry.srcY);
    expect(Math.max(...bands.map((b) => b.srcX + b.srcW))).toBe(
      geometry.srcX + geometry.srcW,
    );
    expect(Math.max(...bands.map((b) => b.srcY + b.srcH))).toBe(
      geometry.srcY + geometry.srcH,
    );
  });

  it("draws the corners at NATIVE size and stretches only the middle", () => {
    const bands = expand(patch());
    const topLeft = bands[0];
    expect(topLeft).toMatchObject({
      dstX: 0,
      dstY: 0,
      dstW: 8,
      dstH: 6,
      srcX: 200,
      srcY: 300,
      srcW: 8,
      srcH: 6,
    });
    const bottomRight = bands[8];
    expect(bottomRight).toMatchObject({
      dstX: 92,
      dstY: 54,
      dstW: 8,
      dstH: 6,
      srcX: 232,
      srcY: 324,
      srcW: 8,
      srcH: 6,
    });
    // The centre: 24x18 of source stretched over 84x48 of destination.
    expect(bands[4]).toMatchObject({
      dstX: 8,
      dstY: 6,
      dstW: 84,
      dstH: 48,
      srcX: 208,
      srcY: 306,
      srcW: 24,
      srcH: 18,
    });
  });

  it("collapses to four corners when the margins meet exactly", () => {
    // Destination is exactly the two margins wide/tall, so there is no middle on
    // either axis. Nothing is dropped from the picture — the corners still tile
    // the rect.
    const bands = expand(patch({ w: 16, h: 12 }));
    expect(bands).toHaveLength(4);
    const area = bands.reduce((sum, band) => sum + band.dstW * band.dstH, 0);
    expect(area).toBe(16 * 12);
  });

  it("lets the LEADING margin win when the margins overlap", () => {
    // 10-wide destination with 8 + 8 of margin. Godot's shader tests
    // `pixel < margin_begin` first, so the left corner keeps its full 8 px and the
    // right corner gets the remaining 2 — it does NOT rescale both to 5.
    const bands = expand(patch({ w: 10, h: 12 }));
    const columns = [...new Set(bands.map((b) => b.dstX))].sort(
      (a, b) => a - b,
    );
    expect(columns).toEqual([0, 8]);
    const left = bands.find((b) => b.dstX === 0);
    const right = bands.find((b) => b.dstX === 8);
    expect(left?.dstW).toBe(8);
    expect(left?.srcW).toBe(8);
    expect(right?.dstW).toBe(2);
    // The trailing band is measured BACK from the region's own right edge.
    expect(right?.srcX).toBe(200 + 40 - 2);
    expect(right?.srcW).toBe(2);
  });

  it("drops the centre when the margins meet inside the SOURCE", () => {
    // 40 px of source with 25 + 25 of margin: there is destination room for a
    // middle band, but no source left to stretch into it. A reversed source range
    // would render as a mirrored smear, so the band is dropped and the corners
    // (truncated against the source) still cover the rect.
    const bands = expand(
      patch({ marginLeft: 25, marginRight: 25, marginTop: 0, marginBottom: 0 }),
    );
    expect(bands.every((band) => band.srcW > 0 && band.srcH > 0)).toBe(true);
    const columns = [...new Set(bands.map((b) => b.dstX))].sort(
      (a, b) => a - b,
    );
    expect(columns).toEqual([0, 75]);
    const area = bands.reduce((sum, band) => sum + band.dstW * band.dstH, 0);
    expect(area).toBe(50 * 60);
  });

  it("is a single quad when every margin is zero", () => {
    const bands = expand(
      patch({
        marginLeft: 0,
        marginTop: 0,
        marginRight: 0,
        marginBottom: 0,
      }),
    );
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({
      dstX: 0,
      dstY: 0,
      dstW: 100,
      dstH: 60,
      srcX: 200,
      srcY: 300,
      srcW: 40,
      srcH: 30,
    });
  });

  it("treats negative margins as zero", () => {
    const bands = expand(
      patch({
        marginLeft: -5,
        marginTop: -5,
        marginRight: -5,
        marginBottom: -5,
      }),
    );
    expect(bands).toHaveLength(1);
    expect(bands[0].dstW).toBe(100);
  });

  it("expands nothing for a patch with no area", () => {
    const bands = createNinePatchBands();
    expect(expandNinePatch(patch({ w: 0 }), bands)).toBe(0);
    expect(expandNinePatch(patch({ h: -3 }), bands)).toBe(0);
    expect(expandNinePatch(patch({ srcW: 0 }), bands)).toBe(0);
    expect(expandNinePatch(patch({ srcH: 0 }), bands)).toBe(0);
  });

  it("reuses the caller's band objects and leaves the tail stale", () => {
    const bands = createNinePatchBands();
    expect(expandNinePatch(patch(), bands)).toBe(9);
    const first = bands[0];
    // No horizontal margins collapses the three columns to one, so the patch is
    // three full-width rows.
    expect(
      expandNinePatch(patch({ marginLeft: 0, marginRight: 0 }), bands),
    ).toBe(3);
    // Same objects, refilled — the whole point of the out-parameter.
    expect(bands[0]).toBe(first);
    expect(bands).toHaveLength(9);
  });
});
