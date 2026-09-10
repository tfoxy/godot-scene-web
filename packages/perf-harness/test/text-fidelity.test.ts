// @vitest-environment node
//
// The alignment guard's own arithmetic, on synthetic images with a KNOWN answer.
//
// This is the metric every per-pixel column in the fidelity table is licensed by, and it has been
// wrong twice. The first implementation compared ink CENTROIDS, which move when an arm is displaced
// but ALSO when its ink is merely redistributed — it read 0.40 px for `canvas2d` and 0.54 px for
// `hb-run`, two arms that are actually within 0.03 px. The second refined the correlation peak with
// a parabola through its integer neighbours, which peak-locks onto whole and half pixels and was
// 0.135 px wrong at the quarters, against a 0.25 px tolerance. Both failure modes are tests here.
//
// The CHANNEL those columns are read on is pinned here too. `lumaOf` takes GREEN, because `dom` is
// the only arm Chrome draws with LCD subpixel antialiasing and averaging the three channels of a
// subpixel-AA still is a ~1 px horizontal blur that the table then charges to the mechanism. That
// is a one-word edit to undo, so it gets a test that fails on the undo.

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  acutanceOf,
  registrationPx,
} from "../../../scripts/test-support/text-image-metrics";
import {
  alignmentPx,
  cropBand,
  lumaOf,
  probeLayout,
  subtractBackground,
} from "../probes/text-fidelity";

interface Image {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Strokes on a grid, area-sampled at a sub-pixel offset — a stand-in for a text run with the three
 * properties that matter here.
 *
 * HARD EDGES, so the correlation peak is narrow, as it is for 12 px CJK, and nothing periodic that
 * could give the search a second peak to lock onto.
 *
 * AREA SAMPLED rather than point sampled, because the offsets under test are fractional: a
 * point-sampled edge jumps a whole pixel at a time and leaves no sub-pixel signal in the image to
 * find.
 *
 * ALL INK WELL INSIDE THE CORRELATION WINDOW (which excludes an 8 px border). Normalized
 * correlation divides by the norm of the SHIFTED reference window, so ink crossing the window's
 * edge changes the normalizer with the shift and biases the peak — measured at 0.42 px on a
 * fixture whose bars touched the border. The probe's own stills satisfy this by construction: the
 * run is inset 20 px in a box padded by 40.
 */
function strokes(width: number, height: number, dx: number, dy: number): Image {
  const bars: [number, number, number, number][] = [
    [18, 16, 2, 18],
    [22, 16, 3, 7],
    [27, 21, 8, 2],
    [33, 17, 2, 15],
    [37, 26, 9, 3],
    [42, 16, 2, 12],
    [19, 38, 16, 2],
    [28, 34, 2, 12],
    [39, 36, 3, 9],
    [44, 30, 2, 14],
  ];

  const covered = (lo: number, hi: number, at: number): number =>
    Math.max(0, Math.min(hi, at + 1) - Math.max(lo, at));
  const data = new Uint8Array(width * height);
  for (const [bx, by, bw, bh] of bars) {
    const x0 = bx + dx;
    const y0 = by + dy;
    for (let y = 0; y < height; y += 1) {
      const cy = covered(y0, y0 + bh, y);
      if (cy <= 0) continue;
      for (let x = 0; x < width; x += 1) {
        const cx = covered(x0, x0 + bw, x);
        if (cx <= 0) continue;
        const at = y * width + x;
        data[at] = Math.min(255, data[at] + Math.round(255 * cx * cy));
      }
    }
  }
  return { data, width, height };
}

/** Ink centroid — the metric this guard deliberately does NOT use. */
function centroid(image: Image): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let sum = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const v = image.data[y * image.width + x];
      sx += x * v;
      sy += y * v;
      sum += v;
    }
  }
  return { x: sx / sum, y: sy / sum };
}

/** A separable 3-tap blur — symmetric, so it cannot move anything. */
function blur(image: Image): Image {
  const pass = (src: Uint8Array, stride: number, limit: number): Uint8Array => {
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i += 1) {
      const at = Math.floor(i / stride) % limit;
      const back = at > 0 ? src[i - stride] : src[i];
      const forward = at < limit - 1 ? src[i + stride] : src[i];
      out[i] = Math.round(0.25 * back + 0.5 * src[i] + 0.25 * forward);
    }
    return out;
  };
  const horizontal = pass(image.data, 1, image.width);
  return {
    data: pass(horizontal, image.width, image.height),
    width: image.width,
    height: image.height,
  };
}

const SIZE = 64;

describe("registrationPx", () => {
  it("reads zero when the two images are the same", () => {
    const image = strokes(SIZE, SIZE, 0, 0);
    const found = registrationPx(image, image);
    expect(found.distance).toBeLessThan(0.01);
  });

  it("recovers a whole-pixel shift exactly, in both axes and both signs", () => {
    const reference = strokes(SIZE, SIZE, 0, 0);
    for (const [dx, dy] of [
      [2, 0],
      [-3, 0],
      [0, 2],
      [0, -1],
      [-2, 3],
    ]) {
      const arm = strokes(SIZE, SIZE, dx, dy);
      const found = registrationPx(arm, reference);
      expect(found.dx).toBeCloseTo(dx, 1);
      expect(found.dy).toBeCloseTo(dy, 1);
      expect(found.distance).toBeCloseTo(Math.hypot(dx, dy), 1);
    }
  });

  it("resolves a sub-pixel shift at all", () => {
    // Integer-only registration would report 0.00 for a 0.4 px offset, and 0.4 px is the scale of
    // every bug this guard has caught. Rounding to the nearest whole pixel would make it blind to
    // exactly the failures it exists for.
    const reference = strokes(SIZE, SIZE, 0, 0);
    for (const dx of [0.5, -0.75, 1.4]) {
      const found = registrationPx(strokes(SIZE, SIZE, dx, 0), reference);
      expect(found.dx).toBeCloseTo(dx, 1);
    }
  });

  it("does not peak-lock onto whole and half pixels", () => {
    // The quarters are where a parabola through the peak's integer neighbours fails: it was exact
    // at 0, 0.5, 1.0 and 1.5 and 0.135 px wrong at 0.25 and 0.75, which is over half the tolerance
    // this metric is read against. A test that only checked halves would have passed that version.
    const reference = strokes(SIZE, SIZE, 0, 0);
    for (const dx of [0.25, 0.75, -0.25, 1.25]) {
      expect(
        registrationPx(strokes(SIZE, SIZE, dx, 0), reference).dx,
      ).toBeCloseTo(dx, 1);
    }
  });

  it("says WHICH axis, not just how far", () => {
    // "2.35 px" is an alarm; "2.35 px, all of it vertical" is a diagnosis, and it is what pointed
    // at a baseline convention rather than at a pen-position bug.
    const found = registrationPx(
      strokes(SIZE, SIZE, 0, 2),
      strokes(SIZE, SIZE, 0, 0),
    );
    expect(Math.abs(found.dx)).toBeLessThan(0.1);
    expect(found.dy).toBeCloseTo(2, 1);
  });

  it("is not fooled by ink REDISTRIBUTION — the confound that killed the centroid version", () => {
    // The real difference between an arm and the 8x reference is not a shift: it is that the two
    // lay down slightly different amounts of ink in different places (different advance rounding,
    // different stem darkening, and for `hb-run` a bilinear resample). Modelled here as one half of
    // the frame inking 30% lighter — nothing MOVES, but the centroid does, which is exactly how the
    // centroid version came to report 0.40 px for `canvas2d` and 0.54 px for `hb-run`.
    const reference = strokes(SIZE, SIZE, 0, 0);
    const heavier: Image = {
      data: Uint8Array.from(reference.data, (v, i) =>
        Math.round(v * (i % SIZE > SIZE / 2 ? 0.7 : 1)),
      ),
      width: SIZE,
      height: SIZE,
    };
    // The confound is real on this fixture, not hypothetical — asserted so the test fails if the
    // fixture ever stops exercising the thing it was built to exercise.
    expect(centroid(reference).x - centroid(heavier).x).toBeGreaterThan(0.3);
    expect(registrationPx(heavier, reference).distance).toBeLessThan(0.05);
  });

  it("is only mildly biased by blur, and biased at all only downstream of `distortion`", () => {
    // The one known bias: normalized correlation slightly prefers the smoothing that fractional
    // sampling introduces, so an arm blurrier than the reference reads a small spurious offset.
    // Measured on real stills at ~0.65 x distortion. Pinned here at the mild end so a change that
    // made the estimator much more blur-sensitive fails, rather than quietly widening the class of
    // arms that get flagged for being soft instead of for being misplaced.
    const reference = strokes(SIZE, SIZE, 0, 0);
    expect(registrationPx(blur(reference), reference).distance).toBeLessThan(
      0.4,
    );
  });

  it("still finds a real shift underneath the blur", () => {
    const reference = strokes(SIZE, SIZE, 0, 0);
    expect(
      registrationPx(blur(strokes(SIZE, SIZE, 1.5, 0)), reference).dx,
    ).toBeCloseTo(1.5, 1);
  });
});

describe("alignmentPx", () => {
  it("averages the registration distance over the sweep", () => {
    const references = [0, 1, 2].map(() => strokes(SIZE, SIZE, 0, 0));
    const arms = [1, 2, 3].map((dx) => strokes(SIZE, SIZE, dx, 0));
    expect(alignmentPx(arms, references)).toBeCloseTo(2, 1);
  });

  it("is NaN, never 0, when there is nothing to compare", () => {
    // Absent means NOT MEASURED, never zero — a 0 here would read as "perfectly aligned".
    expect(alignmentPx([], [])).toBeNaN();
  });
});

describe("probeLayout", () => {
  const layout = probeLayout({
    script: "both",
    chars: 12,
    fontSize: 14,
    rotationDeg: 10,
  });

  it("stacks a Han run above a Latin one, both inside the box", () => {
    expect(layout.runs.map((run) => run.kind)).toEqual(["han", "latin"]);
    for (const run of layout.runs) {
      expect(run.left).toBeGreaterThanOrEqual(0);
      expect(run.top).toBeGreaterThanOrEqual(0);
      expect(run.left + run.width).toBeLessThanOrEqual(layout.box.width);
      expect(run.top + run.height).toBeLessThanOrEqual(layout.box.height);
    }
    // Two faces, never one: a Latin run set in the Han family would render as `.notdef` boxes and
    // still produce a perfectly plausible acutance.
    expect(new Set(layout.runs.map((run) => run.fontFamily)).size).toBe(2);
  });

  it("gives each run a band that contains its rotated box and touches no other", () => {
    const radians = (10 * Math.PI) / 180;
    layout.runs.forEach((run, index) => {
      const band = layout.bands[index];
      const centreY = run.top + run.height / 2;
      const aabb =
        run.width * Math.abs(Math.sin(radians)) +
        run.height * Math.abs(Math.cos(radians));
      expect(band.kind).toBe(run.kind);
      expect(band.y0).toBeLessThanOrEqual(centreY - aabb / 2);
      expect(band.y1).toBeGreaterThanOrEqual(centreY + aabb / 2);
    });
    // Disjoint. Overlapping bands would fold some of each script's edges into the other's
    // acutance, and neither number would then describe anything.
    expect(layout.bands[1].y0).toBeGreaterThanOrEqual(layout.bands[0].y1);
    expect(layout.bands[0].y0).toBeGreaterThan(0);
    expect(layout.bands[1].y1).toBeLessThan(layout.box.height);
  });

  it("leaves every band wide enough for the registration window", () => {
    // `registrationPx` excludes an 8 px border on every side and searches +/-6 px. A band thinner
    // than ~20 rows would leave it correlating almost nothing and reporting a confident 0.
    for (const band of layout.bands) {
      expect(band.y1 - band.y0).toBeGreaterThan(32);
    }
  });

  it("drops to one run and one band for a single script", () => {
    for (const script of ["han", "latin"] as const) {
      const single = probeLayout({
        script,
        chars: 12,
        fontSize: 14,
        rotationDeg: 10,
      });
      expect(single.runs).toHaveLength(1);
      expect(single.bands).toHaveLength(1);
      expect(single.bands[0].kind).toBe(script);
      expect(single.box.height).toBeLessThan(layout.box.height);
    }
  });
});

describe("cropBand", () => {
  it("returns exactly the band's rows, as a standalone image", () => {
    const image = { data: new Uint8Array(10 * 8), width: 10, height: 8 };
    for (let i = 0; i < image.data.length; i += 1) image.data[i] = i;
    const cropped = cropBand(image, { y0: 2, y1: 5 });
    expect(cropped.width).toBe(10);
    expect(cropped.height).toBe(3);
    expect(cropped.data[0]).toBe(20);
    expect(cropped.data.length).toBe(30);
  });

  it("clamps to the image rather than reading past it", () => {
    // A band computed from the layout and an image captured at a different size would otherwise
    // hand `acutanceOf` a short buffer, and every pixel past the end reads as 0 — i.e. as ink-free,
    // which is the one thing this round must never silently report.
    const image = { data: new Uint8Array(4 * 4), width: 4, height: 4 };
    expect(cropBand(image, { y0: -5, y1: 99 })).toMatchObject({
      width: 4,
      height: 4,
    });
    expect(cropBand(image, { y0: 3, y1: 1 }).height).toBe(0);
  });

  it("measures a band and not the whole image", () => {
    // The point of the whole apparatus: ink outside the band must not reach the number. Two
    // identical bands with DIFFERENT neighbours have to register as aligned.
    const a = strokes(SIZE, SIZE, 0, 0);
    const b = strokes(SIZE, SIZE, 0, 0);
    for (let i = 0; i < SIZE * 12; i += 1) b.data[i] = 255;
    const band = { y0: 14, y1: SIZE };
    expect(
      registrationPx(cropBand(a, band), cropBand(b, band)).distance,
    ).toBeCloseTo(0, 6);
  });
});

/** One row of RGBA pixels as a PNG. Alpha is 255 throughout, exactly as in every real still. */
async function pngOf(
  pixels: readonly (readonly [number, number, number])[],
): Promise<Buffer> {
  const raw = Buffer.alloc(pixels.length * 4);
  pixels.forEach(([r, g, b], index) => {
    raw[index * 4] = r;
    raw[index * 4 + 1] = g;
    raw[index * 4 + 2] = b;
    raw[index * 4 + 3] = 255;
  });
  return sharp(raw, { raw: { width: pixels.length, height: 1, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * What `lumaOf` did before: sharp's three-channel luma, same background subtraction after it.
 *
 * The rival is computed rather than tabulated because `greyscale()` is NOT the flat mean and not
 * Rec.601 either — libvips takes Rec.709 luminance in LINEAR light and re-encodes it to sRGB, so
 * rgb(75,157,218) reads 150 where the flat mean is 150.0 and Rec.601 is 139.4. Hardcoding a formula
 * would pin this repo's arithmetic to a guess about someone else's.
 */
async function lumaViaGreyscale(png: Buffer): Promise<Uint8Array> {
  const data = await sharp(png).greyscale().raw().toBuffer();
  return subtractBackground(new Uint8Array(data)).data;
}

const BLACK = [0, 0, 0] as const;

/**
 * LCD-subpixel-AA fringes, and every reading of one that `lumaOf` could plausibly return.
 *
 * rgba(75,157,218) is lifted from `dom-0.png`, where 2980 pixels spread their channels by more than
 * 8. Its flat mean happens to land on `greyscale`'s answer exactly, which is why it cannot be the
 * only case: rgb(30,35,255) is the same shape — a monotone R<G<B ramp — pushed until green,
 * greyscale, the flat mean and Rec.601 are four unmistakably different numbers, so an assertion that
 * green is the answer cannot be satisfied by coincidence.
 *
 * `greyscale` is MEASURED, from the sharp 0.34.5 / libvips 8.17.3 this repo pins.
 */
const FRINGES = [
  {
    rgb: [75, 157, 218],
    green: 157,
    greyscale: 150,
    flatMean: 150,
    rec601: 139,
  },
  { rgb: [30, 35, 255], green: 35, greyscale: 83, flatMean: 107, rec601: 59 },
] as const;

describe("lumaOf", () => {
  it("reads the GREEN channel of a fringed pixel, not an average of the three", async () => {
    // Six black pixels of ten, so the median background floor is 0 and each reading below is the
    // raw channel value rather than a channel value minus a floor.
    const png = await pngOf([
      ...FRINGES.map((fringe) => fringe.rgb),
      [128, 128, 128],
      [200, 200, 200],
      ...Array.from({ length: 6 }, () => BLACK),
    ]);
    const { data, width, height, backgroundFloor } = await lumaOf(png);

    expect(backgroundFloor).toBe(0);
    // One band, not green-and-alpha interleaved: every consumer indexes this buffer as `y * w + x`,
    // and a two-band buffer would read as a half-width image full of 255s rather than fail.
    expect(data.length).toBe(width * height);

    FRINGES.forEach((fringe, index) => {
      expect(data[index]).toBe(fringe.green);
      expect(data[index]).not.toBe(fringe.greyscale);
      expect(data[index]).not.toBe(fringe.flatMean);
      expect(data[index]).not.toBe(fringe.rec601);
    });
    // Neutral pixels are the same number under either reading — that is the next test's subject,
    // and it is asserted here so this fixture is known to isolate the fringes.
    expect(data[FRINGES.length]).toBe(128);
    expect(data[FRINGES.length + 1]).toBe(200);
  });

  it("is bit-identical to the old luma on greyscale coverage — the seven arms that are not `dom`", async () => {
    // Every coverage value a greyscale rasterizer can emit, all 256 of them. `canvas2d`, `hb-atlas`,
    // `hb-run`, `reference` and the three `godot-*` arms emit nothing else, so this is the whole
    // claim that switching channels moves no number that was already published.
    const png = await pngOf(
      Array.from({ length: 256 }, (_, value) => [value, value, value] as const),
    );
    const green = await lumaOf(png);
    expect([...green.data]).toEqual([...(await lumaViaGreyscale(png))]);
  });

  it("does not blur the one arm that has subpixel antialiasing", async () => {
    // The defect itself, at the smallest scale that shows it: a one-pixel white stem, drawn the way
    // LCD subpixel AA draws one. The stem's edges fall on SUBPIXELS, so the pixel to its left keeps
    // only its blue subpixel and the pixel to its right only its red one. Green sees a 1 px stem
    // with nothing beside it; a three-channel luma smears those fringes back in and sees a 3 px one,
    // which is a ~1 px horizontal box blur that no rasterizer applied. `acutance` is the column that
    // pays for it, and it pays only on `dom`, because `dom` is the only arm with fringes to average.
    const stem = await pngOf([
      BLACK,
      BLACK,
      [0, 0, 255],
      [255, 255, 255],
      [255, 0, 0],
      BLACK,
      BLACK,
      BLACK,
      BLACK,
    ]);
    const green = await lumaOf(stem);
    const luma = await lumaViaGreyscale(stem);

    const sharpness = (data: Uint8Array) =>
      acutanceOf(data, green.width, green.height).acutance;
    // Not "greater by some epsilon": the whole stem is 255 wide-of-nothing under green, so its
    // acutance is the ideal 2.0, and the luma reading is dragged well below it by ink that only the
    // averaging put there.
    expect(sharpness(green.data)).toBeCloseTo(2, 5);
    expect(sharpness(luma)).toBeLessThan(1.5);
  });
});
