// @vitest-environment node
//
// The A1 crossover's four metrics, on synthetic planes whose answer is known BY CONSTRUCTION.
//
// WHY THESE AND NOT A GOLDEN FRAME. Every number `probes/text-crossover.ts` publishes is a claim
// about bytes, and the failure mode a fidelity sweep has that a timing sweep does not is that a
// WRONG metric produces a plausible table rather than an obviously broken one: a blank cell has a
// perfectly uniform interior, a zero edge width and no bytes that differ from Godot. A golden frame
// would pin the metrics AND the renderer together, so a renderer change would look like a metric
// regression and vice versa. These fixtures have closed-form answers, so a failure here is always a
// bug in the arithmetic.
//
// THE FIXTURES ARE AT DELIBERATELY AWKWARD SUB-PIXEL PHASES. `gradientRampWidth`'s own doc records
// a 19 % reading difference between a disk centred on a pixel corner and one at a generic phase —
// the numerator is a COUNT of pixels, so a fixture whose symmetry lines up with the lattice samples
// one phase ten times instead of ten phases once. {@link stripePlane} sweeps twenty phases on
// purpose, which is what makes its expected 10-90 width exactly 0.8 px rather than approximately.

import { describe, expect, it } from "vitest";
import { PRODUCT_FILL } from "../probes/text-crossover-cases";
import {
  buildInteriorMask,
  cellPresence,
  channelPlane,
  cropRgba,
  distortionVsReference,
  edgeProfile,
  interiorUniformity,
  type Plane,
  perChannelByteDiff,
  type RgbaImage,
  registerInteger,
} from "../probes/text-crossover-metrics";

/** An RGBA image filled with one triple, opaque. */
function solid(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

const ones = (n: number): Uint8Array => new Uint8Array(n).fill(1);

describe("interiorUniformity — metric (i)", () => {
  it("scores a byte-uniform interior at exactly 1.0, with an empty histogram", () => {
    const image = solid(8, 8, PRODUCT_FILL);
    const result = interiorUniformity(image, ones(64), PRODUCT_FILL, 1);
    expect(result.interiorPixels).toBe(64);
    expect(result.exactPixels).toBe(64);
    expect(result.exactRatio).toBe(1);
    expect(result.histogram.max).toEqual([0, 0, 0]);
    expect(result.histogram.mean).toEqual([0, 0, 0]);
    expect(result.histogram.channels).toEqual([{}, {}, {}]);
    expect(result.distinctTriples).toEqual([
      { rgb: [...PRODUCT_FILL], count: 64 },
    ]);
    expect(result.erosionRadius).toBe(1);
  });

  it("puts ONE count at delta 1 when a single pixel is one byte low", () => {
    const image = solid(8, 8, PRODUCT_FILL);
    // Green, one byte below the fill, on exactly one interior pixel. This is the signature of a
    // colour-pipeline rounding error, and it is the one the histogram has to separate from a
    // coverage shortfall (which lands at several bytes, in proportion to each channel's value).
    image.data[5 * 4 + 1] = PRODUCT_FILL[1] - 1;

    const result = interiorUniformity(image, ones(64), PRODUCT_FILL, 1);
    expect(result.interiorPixels).toBe(64);
    expect(result.exactPixels).toBe(63);
    expect(result.exactRatio).toBeCloseTo(63 / 64, 12);
    expect(result.histogram.channels[1]).toEqual({ 1: 1 });
    // The other two channels saw no deviation at all — a per-channel histogram, not a luma one.
    expect(result.histogram.channels[0]).toEqual({});
    expect(result.histogram.channels[2]).toEqual({});
    expect(result.histogram.max).toEqual([0, 1, 0]);
    expect(result.histogram.mean[1]).toBeCloseTo(1 / 64, 12);
    expect(result.distinctTriples).toEqual([
      { rgb: [...PRODUCT_FILL], count: 63 },
      {
        rgb: [PRODUCT_FILL[0], PRODUCT_FILL[1] - 1, PRODUCT_FILL[2]],
        count: 1,
      },
    ]);
  });

  it("returns exactRatio null — NOT 0 — when the mask is empty", () => {
    // THE WHOLE POINT OF THE NULL. At small ppem a stem is thinner than the erosion and there is no
    // interior to be uniform over. Reporting 0 % would say the arm's interior is entirely wrong;
    // reporting 100 % would say it is perfect. Both are claims about pixels nobody looked at.
    const image = solid(8, 8, PRODUCT_FILL);
    const result = interiorUniformity(
      image,
      new Uint8Array(64),
      PRODUCT_FILL,
      1,
    );
    expect(result.interiorPixels).toBe(0);
    expect(result.exactPixels).toBe(0);
    expect(result.exactRatio).toBeNull();
    expect(result.exactRatio).not.toBe(0);
    expect(result.exactRatio).not.toBe(1);
  });
});

describe("buildInteriorMask", () => {
  /** A 5x5 solid square inside a 9x9 plane, clear of the borders. */
  function squarePlane(): Plane {
    const data = new Uint8Array(81);
    for (let y = 2; y <= 6; y += 1) {
      for (let x = 2; x <= 6; x += 1) data[y * 9 + x] = 255;
    }
    return { data, width: 9, height: 9 };
  }

  it("erodes by whole pixels: 5x5 -> 3x3 -> 1x1 -> empty", () => {
    expect(buildInteriorMask(squarePlane(), { erosionRadius: 0 }).pixels).toBe(
      25,
    );
    expect(buildInteriorMask(squarePlane(), { erosionRadius: 1 }).pixels).toBe(
      9,
    );
    expect(buildInteriorMask(squarePlane(), { erosionRadius: 2 }).pixels).toBe(
      1,
    );
    // Empty is a RESULT, and the caller must report the cell as NOT MEASURED.
    expect(buildInteriorMask(squarePlane(), { erosionRadius: 3 }).pixels).toBe(
      0,
    );
  });

  it("reports the radius it used, so a percentage can never be quoted without one", () => {
    expect(
      buildInteriorMask(squarePlane(), { erosionRadius: 2 }),
    ).toMatchObject({ erosionRadius: 2 });
  });

  it("takes only pixels at or above solidLevel", () => {
    const plane = squarePlane();
    plane.data[4 * 9 + 4] = 253; // one byte below the default 254
    expect(buildInteriorMask(plane, { erosionRadius: 0 }).pixels).toBe(24);
  });
});

describe("edgeProfile — metric (iii)", () => {
  /**
   * Twenty exact-area straight edges at twenty evenly spread sub-pixel phases, in one plane.
   *
   * WHY TWENTY AND NOT ONE. `gradientRampWidth`'s numerator counts pixels whose coverage lies in
   * (0.1, 0.9), so a SINGLE axis-aligned edge contributes either exactly one such pixel per row or
   * exactly none, depending on where the edge falls inside its pixel — the reading is 1.25 px at
   * four phases out of five and 0 at the other one, and no single phase is right. Sweeping the
   * phases uniformly is what makes the expectation exact: 16 of 20 edges land in the band, the
   * gradient sum is exactly 1.0 per edge per row whatever the phase, so the quotient is exactly
   * 0.8, `rampWidthPx` is exactly 1.0 and the 10-90 width is exactly 0.8 px — the closed-form
   * answer for an edge carrying `clamp(s + 0.5, 0, 1)` coverage.
   *
   * Ten 8 px bars with 8 px gaps, so every edge has at least three saturated neighbours on each
   * side and no two edges share a 3x3 Sobel window.
   */
  function stripePlane(): Plane {
    const width = 172;
    const height = 20;
    const phase = (j: number): number => j / 20 + 0.025;
    const bars = Array.from({ length: 10 }, (_, k) => ({
      rise: 6 + 16 * k + phase(2 * k),
      fall: 14 + 16 * k + phase(2 * k + 1),
    }));
    const data = new Uint8Array(width * height);
    for (let x = 0; x < width; x += 1) {
      // Exact area coverage of the bar set over the pixel's own square.
      let coverage = 0;
      for (const bar of bars) {
        coverage += Math.max(
          0,
          Math.min(bar.fall, x + 1) - Math.max(bar.rise, x),
        );
      }
      const byte = Math.round(255 * coverage);
      for (let y = 0; y < height; y += 1) data[y * width + x] = byte;
    }
    return { data, width, height };
  }

  it("reads an exact-area straight edge as a 10-90 width of 0.8 px", () => {
    const result = edgeProfile(stripePlane());
    // 16 in-band pixels and 20 units of gradient per interior row, over 18 interior rows.
    expect(result.rampPixels).toBe(16 * 18);
    expect(result.gradientSum).toBeCloseTo(20 * 18, 6);
    expect(result.width1090Px).toBeCloseTo(0.8, 9);
    // The equivalent FULL 0->1 ramp, which is the form the committed Godot golden holds.
    expect(result.fullRampPx).toBeCloseTo(1.0, 9);
  });

  it("returns null rather than 0 on a plane with no boundary at all", () => {
    const flat: Plane = {
      data: new Uint8Array(40 * 40).fill(255),
      width: 40,
      height: 40,
    };
    expect(edgeProfile(flat).width1090Px).toBeNull();
    expect(edgeProfile(flat).fullRampPx).toBeNull();
  });
});

describe("registerInteger — metric (ii)'s alignment", () => {
  /** A deterministic 16x16 block of distinct values, placed at `(x, y)` in a 40x40 plane. */
  function blockPlane(x: number, y: number): Plane {
    const width = 40;
    const height = 40;
    const data = new Uint8Array(width * height);
    let seed = 0x1234_5678;
    for (let by = 0; by < 16; by += 1) {
      for (let bx = 0; bx < 16; bx += 1) {
        seed = (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fff_ffff;
        data[(y + by) * width + (x + bx)] = 1 + (seed % 254);
      }
    }
    return { data, width, height };
  }

  it("recovers a known integer shift exactly, with a zero residual score", () => {
    const a = blockPlane(12, 12);
    const b = blockPlane(14, 13);
    const result = registerInteger(a, b);
    // `a[y][x]` matches `b[y + dy][x + dx]`, so the block having moved right 2 and down 1 is
    // exactly `dx = 2, dy = 1`.
    expect(result.dx).toBe(2);
    expect(result.dy).toBe(1);
    expect(result.score).toBe(0);
    expect(result.clamped).toBe(false);
    expect(result.searchRadius).toBe(3);
  });

  it("flags a winner sitting on the edge of the search window as clamped", () => {
    const a = blockPlane(4, 12);
    const b = blockPlane(12, 12);
    // The true shift is 8 px, outside a radius-3 window: the answer is not trustworthy and says so
    // rather than reporting the best of a bad set as if it were an alignment.
    expect(registerInteger(a, b, 3).clamped).toBe(true);
  });

  it("applies ONE alignment to all three channels", () => {
    const width = 40;
    const height = 40;
    const make = (offset: number, tint: number): RgbaImage => {
      const data = new Uint8Array(width * height * 4);
      for (let y = 10; y < 26; y += 1) {
        for (let x = 10; x < 26; x += 1) {
          const i = ((y + 0) * width + x + offset) * 4;
          data[i] = 200;
          data[i + 1] = 150;
          data[i + 2] = 100 + tint;
          data[i + 3] = 255;
        }
      }
      return { data, width, height };
    };
    const diff = perChannelByteDiff(make(0, 0), make(2, 7));
    expect(diff.registration.dx).toBe(2);
    expect(diff.registration.dy).toBe(0);
    // Registration is computed on GREEN and then applied to all three, so the blue tint shows up as
    // a flat 7-byte difference rather than being best-fit away on its own axis.
    expect(diff.max).toEqual([0, 0, 7]);
    expect(diff.mean[0]).toBe(0);
    expect(diff.mean[1]).toBe(0);
  });
});

describe("distortionVsReference — metric (iv)", () => {
  function ramp(width: number, height: number, edgeAt: number): Plane {
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const coverage = Math.max(0, Math.min(1, x + 1 - edgeAt));
        data[y * width + x] = Math.round(255 * coverage);
      }
    }
    return { data, width, height };
  }

  it("scores an arm against itself at exactly 0", () => {
    const plane = ramp(40, 40, 17.3);
    const result = distortionVsReference(plane, plane);
    expect(result.distortion).toBe(0);
    expect(result.acutance).toBe(result.referenceAcutance);
    expect(result.ink).toBe(result.referenceInk);
  });

  it("is a DISTANCE: a blurrier arm and a sharper one are both non-zero", () => {
    const reference = ramp(40, 40, 17.3);
    const blurry: Plane = {
      data: new Uint8Array(reference.data),
      width: 40,
      height: 40,
    };
    // Smear the edge over three pixels: same ink, lower gradient per unit ink.
    for (let y = 0; y < 40; y += 1) {
      for (let x = 15; x < 20; x += 1) {
        blurry.data[y * 40 + x] = Math.round(255 * ((x - 14) / 6));
      }
    }
    expect(distortionVsReference(blurry, reference).distortion).toBeGreaterThan(
      0,
    );
    expect(distortionVsReference(reference, blurry).distortion).toBeGreaterThan(
      0,
    );
  });
});

describe("cellPresence — the guard", () => {
  it("fails a cell that is indistinguishable from its own background", () => {
    const background = [0x24, 0x1a, 0x10] as const;
    const blank = solid(64, 64, background);
    const result = cellPresence(blank, background);
    expect(result.inkPixels).toBe(0);
    expect(result.nonEmptyRatio).toBe(0);
    expect(result.ok).toBe(false);
  });

  it("passes a cell with ink and reports how much", () => {
    const background = [0, 0, 0] as const;
    const image = solid(64, 64, background);
    for (let i = 0; i < 20; i += 1) image.data[i * 4 + 1] = 255;
    const result = cellPresence(image, background);
    expect(result.inkPixels).toBe(20);
    expect(result.ok).toBe(true);
    expect(result.nonEmptyRatio).toBeCloseTo(20 / 4096, 12);
  });

  it("still fails just under the minimum, so the threshold is a threshold", () => {
    const background = [0, 0, 0] as const;
    const image = solid(64, 64, background);
    for (let i = 0; i < 15; i += 1) image.data[i * 4 + 1] = 255;
    expect(cellPresence(image, background).ok).toBe(false);
  });
});

describe("cropRgba and channelPlane", () => {
  it("refuses an out-of-frame crop rather than silently clamping it to black", () => {
    const image = solid(16, 16, [1, 2, 3]);
    expect(() => cropRgba(image, 8, 8, 16, 16)).toThrow(
      /outside a 16x16 frame/,
    );
    expect(() => cropRgba(image, -1, 0, 4, 4)).toThrow();
    expect(() => cropRgba(image, 0, 0, 0, 4)).toThrow();
  });

  it("crops the rows a cell rectangle names", () => {
    const image = solid(8, 8, [0, 0, 0]);
    image.data[(3 * 8 + 5) * 4 + 1] = 99;
    const cell = cropRgba(image, 4, 2, 4, 4);
    expect(cell.width).toBe(4);
    expect(cell.height).toBe(4);
    expect(channelPlane(cell).data[1 * 4 + 1]).toBe(99);
  });

  it("defaults to GREEN, which is the documented channel", () => {
    const image = solid(4, 4, [10, 20, 30]);
    expect([...channelPlane(image).data]).toEqual(new Array(16).fill(20));
    expect([...channelPlane(image, 0).data]).toEqual(new Array(16).fill(10));
    expect([...channelPlane(image, 2).data]).toEqual(new Array(16).fill(30));
  });
});
