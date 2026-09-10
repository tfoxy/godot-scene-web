// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  atlasRegions,
  encodeAtlasPng,
  mulberry32,
  renderAtlasPixels,
} from "../src/fixtures/atlas";

// Small page + few regions: the real fixture is 4096x4096 and takes seconds, but determinism is a
// property of the generator, not of the size.
const SMALL = { pageSize: 128, regionCount: 16, seed: 1337 } as const;

describe("atlas fixture determinism", () => {
  it("produces byte-identical pixels for the same seed", () => {
    const first = renderAtlasPixels(SMALL);
    const second = renderAtlasPixels(SMALL);
    expect(first.data.equals(second.data)).toBe(true);
  });

  it("produces byte-identical PNGs for the same seed", async () => {
    // The PNG must be reproducible too, because it is cached on disk and never committed: a
    // developer regenerating it must get exactly what the numbers were measured against.
    const [first, second] = await Promise.all([
      encodeAtlasPng(renderAtlasPixels(SMALL)),
      encodeAtlasPng(renderAtlasPixels(SMALL)),
    ]);
    expect(first.equals(second)).toBe(true);
  });

  it("produces different pixels for a different seed", () => {
    const a = renderAtlasPixels(SMALL);
    const b = renderAtlasPixels({ ...SMALL, seed: 1338 });
    expect(a.data.equals(b.data)).toBe(false);
  });

  it("lays regions out inside the page without overlapping cells", () => {
    const regions = atlasRegions(SMALL);
    expect(regions).toHaveLength(SMALL.regionCount);
    for (const region of regions) {
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.y).toBeGreaterThanOrEqual(0);
      expect(region.x + region.width).toBeLessThanOrEqual(SMALL.pageSize);
      expect(region.y + region.height).toBeLessThanOrEqual(SMALL.pageSize);
      expect(region.width).toBeGreaterThan(0);
      expect(region.height).toBeGreaterThan(0);
    }
  });

  it("keeps every region's centre opaque", () => {
    // The screenshot presence guard samples each sprite's CENTRE. A hollow shape (a ring) would make
    // a correct render look like a blank page, so the generator always draws a solid core.
    const { data, pageSize, regions } = renderAtlasPixels(SMALL);
    for (const region of regions) {
      const cx = region.x + Math.floor(region.width / 2);
      const cy = region.y + Math.floor(region.height / 2);
      const alpha = data[(cy * pageSize + cx) * 4 + 3];
      expect(alpha).toBe(255);
    }
  });

  it("varies the content so the page is not trivially compressible", async () => {
    // A flat-colour page would decode far faster than a real atlas and would understate the very
    // cost this harness exists to measure.
    const pixels = renderAtlasPixels(SMALL);
    const png = await encodeAtlasPng(pixels);
    const rawBytes = SMALL.pageSize * SMALL.pageSize * 4;
    expect(png.byteLength / rawBytes).toBeGreaterThan(0.05);
  });
});

describe("mulberry32", () => {
  it("is a pure function of its seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const first = Array.from({ length: 8 }, () => a());
    const second = Array.from({ length: 8 }, () => b());
    expect(first).toEqual(second);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe("atlas fixture variants", () => {
  it("lays regions out edge to edge when the inset jitter is off", () => {
    // This is the ONLY mechanism behind `scaleDiversity=shared`: uniform region rects mean every
    // fixed-size sprite resolves to one background-size, i.e. one scaled decode of the page.
    const jittered = atlasRegions(SMALL);
    const uniform = atlasRegions({ ...SMALL, regionInset: false });
    const uniformSizes = new Set(uniform.map((r) => `${r.width}x${r.height}`));
    const jitteredSizes = new Set(
      jittered.map((r) => `${r.width}x${r.height}`),
    );
    expect(uniformSizes.size).toBe(1);
    expect(jitteredSizes.size).toBeGreaterThan(1);
    expect(uniform[0]).toEqual({ x: 0, y: 0, width: 32, height: 32 });
  });

  it("renders a non-square page with the right stride", () => {
    const pixels = renderAtlasPixels({
      ...SMALL,
      pageSize: 128,
      pageHeight: 64,
    });
    expect(pixels.pageHeight).toBe(64);
    expect(pixels.data.byteLength).toBe(128 * 64 * 4);
    for (const region of pixels.regions) {
      expect(region.y + region.height).toBeLessThanOrEqual(64);
      expect(region.x + region.width).toBeLessThanOrEqual(128);
    }
  });

  it("makes every pixel of an opaque-base page non-transparent", () => {
    // S3's nine-patch sheet and S4's background are sampled by the presence guard at arbitrary
    // points; a transparent gutter under a sample point would report a correct render as blank.
    const pixels = renderAtlasPixels({
      seed: 7,
      pageSize: 96,
      pageHeight: 48,
      regionCount: 6,
      opaqueBase: true,
    });
    let opaque = 0;
    for (let i = 3; i < pixels.data.byteLength; i += 4) {
      if (pixels.data[i] === 255) {
        opaque++;
      }
    }
    expect(opaque).toBe(96 * 48);
  });

  it("keeps the opaque base deterministic", () => {
    const options = {
      seed: 7,
      pageSize: 64,
      pageHeight: 32,
      regionCount: 4,
      opaqueBase: true,
    };
    expect(
      renderAtlasPixels(options).data.equals(renderAtlasPixels(options).data),
    ).toBe(true);
  });
});
