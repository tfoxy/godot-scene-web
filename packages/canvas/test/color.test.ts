import { applyColorMatrixToPixels } from "@godot-scene-web/html";
import { describe, expect, it } from "vitest";
import {
  applyColorMatrix01,
  clamp01,
  colorMatricesEqual,
  createRgba,
  IDENTITY_COLOR_MATRIX,
  isIdentityColorMatrix,
  modulatePremultiplied,
  premultiply,
  shadeQuadPixel,
  unpremultiply,
} from "../src/color";

/** Godot's HSV material at hue +0.25 produces a matrix of roughly this shape:
 *  channels swapped and mixed, rows that do not sum to 1, one negative term. */
const HSV_ISH = [0.3, 0.9, -0.2, -0.1, 0.4, 0.7, 0.8, -0.3, 0.5];

describe("clamp01", () => {
  it("clamps, and treats NaN as zero", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe("premultiply / unpremultiply", () => {
  it("round-trips a colour with non-zero alpha", () => {
    const premultiplied = premultiply(0.8, 0.5, 0.25, 0.5, createRgba());
    expect(premultiplied.r).toBeCloseTo(0.4, 10);
    expect(premultiplied.a).toBe(0.5);
    const straight = unpremultiply(premultiplied, createRgba());
    expect(straight.r).toBeCloseTo(0.8, 6);
    expect(straight.g).toBeCloseTo(0.5, 6);
    expect(straight.b).toBeCloseTo(0.25, 6);
    expect(straight.a).toBe(0.5);
  });

  it("collapses a fully transparent colour to black rather than dividing by zero", () => {
    const straight = unpremultiply({ r: 0, g: 0, b: 0, a: 0 }, createRgba());
    expect(straight).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe("modulatePremultiplied", () => {
  it("composes two premultiplied colours componentwise", () => {
    // A half-alpha white texel under a half-alpha red tint: the result must carry
    // alpha 0.25 and colour already scaled by it.
    const texel = premultiply(1, 1, 1, 0.5, createRgba());
    const tint = premultiply(1, 0, 0, 0.5, createRgba());
    const out = modulatePremultiplied(texel, tint, createRgba());
    expect(out.a).toBeCloseTo(0.25, 10);
    expect(out.r).toBeCloseTo(0.25, 10);
    expect(out.g).toBe(0);
    // Un-premultiplying returns pure red at 25% coverage, i.e. the tint's hue
    // survived and only the coverage compounded.
    const straight = unpremultiply(out, createRgba());
    expect(straight.r).toBeCloseTo(1, 6);
  });
});

describe("applyColorMatrix01", () => {
  // THE CROSS-CHECK THE BRIEF ASKS FOR. `html`'s `applyColorMatrixToPixels` is
  // the CPU bake the DOM renderer uses for exactly this transform; if the two
  // disagree, the canvas renderer and the renderer it replaces tint differently
  // and every screenshot comparison between them is noise.
  it("agrees with html's applyColorMatrixToPixels over the byte domain", () => {
    const samples: [number, number, number][] = [
      [0, 0, 0],
      [255, 255, 255],
      [255, 0, 0],
      [0, 128, 64],
      [17, 200, 233],
      [90, 90, 90],
      [250, 5, 128],
    ];
    const bytes = new Uint8ClampedArray(samples.length * 4);
    samples.forEach(([r, g, b], index) => {
      bytes[index * 4] = r;
      bytes[index * 4 + 1] = g;
      bytes[index * 4 + 2] = b;
      bytes[index * 4 + 3] = 255;
    });
    applyColorMatrixToPixels(bytes, HSV_ISH);

    const out = createRgba();
    samples.forEach(([r, g, b], index) => {
      applyColorMatrix01(
        { r: r / 255, g: g / 255, b: b / 255, a: 1 },
        HSV_ISH,
        0,
        out,
      );
      // Within half a byte: the CPU path quantises to 8 bits (and clamps, which
      // this matrix's negative terms make it do), the float path does not. The
      // epsilon is for the samples that land EXACTLY on a tie, where the two
      // paths' last bits differ by ~1e-13 before rounding.
      const halfByte = 0.5 + 1e-9;
      expect(Math.abs(out.r * 255 - bytes[index * 4])).toBeLessThanOrEqual(
        halfByte,
      );
      expect(Math.abs(out.g * 255 - bytes[index * 4 + 1])).toBeLessThanOrEqual(
        halfByte,
      );
      expect(Math.abs(out.b * 255 - bytes[index * 4 + 2])).toBeLessThanOrEqual(
        halfByte,
      );
    });
  });

  it("leaves alpha alone and clamps out-of-gamut results", () => {
    const out = applyColorMatrix01(
      { r: 1, g: 1, b: 1, a: 0.3 },
      [2, 2, 2, -1, -1, -1, 1, 0, 0],
      0,
      createRgba(),
    );
    expect(out.r).toBe(1);
    expect(out.g).toBe(0);
    expect(out.b).toBe(1);
    expect(out.a).toBe(0.3);
  });

  it("reads a matrix from an offset into a shared arena", () => {
    const arena = [...IDENTITY_COLOR_MATRIX, ...HSV_ISH];
    const identity = applyColorMatrix01(
      { r: 0.2, g: 0.4, b: 0.6, a: 1 },
      arena,
      0,
      createRgba(),
    );
    expect(identity.r).toBeCloseTo(0.2, 10);
    const transformed = applyColorMatrix01(
      { r: 0.2, g: 0.4, b: 0.6, a: 1 },
      arena,
      9,
      createRgba(),
    );
    expect(transformed.r).toBeCloseTo(0.3 * 0.2 + 0.9 * 0.4 - 0.2 * 0.6, 6);
  });
});

describe("shadeQuadPixel", () => {
  it("with no matrix is just the premultiplied product", () => {
    const texel = premultiply(1, 0.5, 0, 0.5, createRgba());
    const tint = premultiply(1, 1, 1, 0.5, createRgba());
    const out = shadeQuadPixel(texel, null, 0, tint, createRgba());
    expect(out.a).toBeCloseTo(0.25, 10);
    expect(out.r).toBeCloseTo(0.25, 10);
    expect(out.g).toBeCloseTo(0.125, 10);
  });

  it("applies the matrix to STRAIGHT colour, not to the premultiplied channels", () => {
    // The whole point of the un-premultiply in the shader. A half-alpha pure-red
    // texel under a matrix that maps red -> green must come out pure GREEN at the
    // same coverage. Applied to the premultiplied channels instead, the same
    // matrix would produce a HALF-strength green (0.25 rather than 0.5).
    const texel = premultiply(1, 0, 0, 0.5, createRgba());
    const swapRedToGreen = [0, 0, 0, 1, 0, 0, 0, 0, 0];
    const tint = premultiply(1, 1, 1, 1, createRgba());
    const out = shadeQuadPixel(texel, swapRedToGreen, 0, tint, createRgba());
    expect(out.a).toBeCloseTo(0.5, 10);
    expect(out.r).toBe(0);
    expect(out.g).toBeCloseTo(0.5, 10);
    expect(unpremultiply(out, createRgba()).g).toBeCloseTo(1, 6);
  });

  it("keeps a fully transparent texel transparent", () => {
    const out = shadeQuadPixel(
      { r: 0, g: 0, b: 0, a: 0 },
      HSV_ISH,
      0,
      premultiply(1, 1, 1, 1, createRgba()),
      createRgba(),
    );
    expect(out).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe("matrix table helpers", () => {
  it("recognises the identity", () => {
    expect(isIdentityColorMatrix(IDENTITY_COLOR_MATRIX)).toBe(true);
    expect(isIdentityColorMatrix(HSV_ISH)).toBe(false);
    expect(
      isIdentityColorMatrix([...HSV_ISH, ...IDENTITY_COLOR_MATRIX], 9),
    ).toBe(true);
  });

  it("compares matrices at arbitrary offsets", () => {
    // Float32Array on BOTH sides, which is the real case: the batcher's table and
    // a draw-list's `colorMatrix` view are both f32, and the comparison is exact
    // — a f64 `0.3` and its f32 round-trip are genuinely different numbers, so
    // deduping across the two storage widths is not something to rely on.
    const hsv = new Float32Array(HSV_ISH);
    const arena = new Float32Array([...hsv, ...IDENTITY_COLOR_MATRIX]);
    expect(colorMatricesEqual(arena, 0, hsv, 0)).toBe(true);
    expect(colorMatricesEqual(arena, 9, hsv, 0)).toBe(false);
    expect(colorMatricesEqual(arena, 9, IDENTITY_COLOR_MATRIX, 0)).toBe(true);
  });
});
