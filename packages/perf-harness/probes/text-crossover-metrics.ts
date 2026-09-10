// THE FOUR METRICS OF THE A1 CROSSOVER, over decoded RGBA frames. Pure functions, no I/O, no
// browser — so `test/text-crossover-metrics.test.ts` can pin every one of them on a synthetic plane
// whose answer is known by construction.
//
// WHAT IS REUSED RATHER THAN REWRITTEN, and why that matters more than the line count:
//
//   * `gradientRampWidth` (packages/hb-gpu/test/outline-metrics.ts) is the edge-width form the
//     COMMITTED Godot golden was measured with (`goldens/godot-outline-metrics.json`). Reusing it
//     means an outline width measured by this sweep is on the same scale as the one already in the
//     repo, instead of being a second opinion nobody can reconcile. `scripts/godot-outline-ref.ts`
//     already reaches into that file from outside the package; this is the same reach.
//   * `acutanceOf` (text-fidelity.ts) is the existing distortion score's numerator. Metric (iv) is
//     defined as "the harness's existing distortion-vs-8x-reference score", so it had better be
//     computed by the harness's existing function.
//
// PIXELMATCH IS NOT USED ANYWHERE HERE, and that is a requirement rather than a preference.
// pixelmatch blends a semi-transparent pixel onto white by its own alpha before comparing, so it
// reports 0 differing pixels while two backends differ by 64 bytes on every channel — the repo has
// been bitten by exactly that. Metric (ii) is a raw per-channel byte difference and nothing else.

import { acutanceOf } from "../../../scripts/test-support/text-image-metrics";
import { gradientRampWidth } from "../../hb-gpu/test/outline-metrics";

export interface Plane {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Crop an RGBA frame. Out-of-frame reads are refused rather than silently clamped to black. */
export function cropRgba(
  image: RgbaImage,
  x: number,
  y: number,
  width: number,
  height: number,
): RgbaImage {
  if (
    x < 0 ||
    y < 0 ||
    x + width > image.width ||
    y + height > image.height ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      `cropRgba: ${width}x${height}+${x}+${y} is outside a ${image.width}x${image.height} frame`,
    );
  }
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * image.width + x) * 4;
    out.set(image.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { data: out, width, height };
}

/**
 * One channel of an RGBA image as a plane.
 *
 * GREEN IS THE DEFAULT AND THE DOCUMENTED CHOICE. `docs/text-rendering.md` ("Every metric reads one
 * channel, and that channel is green"): the `dom` arm is the only one Chrome draws with LCD
 * subpixel antialiasing, so averaging R, G and B on its stills is a ~1 px horizontal box blur
 * applied to the one arm that can feel it — it moved that arm's distortion by a quarter of its own
 * value. Green samples coverage at the pixel centre, which is the same question asked of every arm.
 */
export function channelPlane(image: RgbaImage, channel = 1): Plane {
  const out = new Uint8Array(image.width * image.height);
  for (let i = 0; i < out.length; i += 1) out[i] = image.data[i * 4 + channel];
  return { data: out, width: image.width, height: image.height };
}

/**
 * The interior mask: pixels the case is SUPPOSED to fill solid, eroded so no edge AA gets in.
 *
 * TAKEN FROM A SHARED REFERENCE, NOT FROM THE ARM BEING GRADED. If each arm supplied its own mask
 * from its own render, an arm whose interior collapsed to nothing would be measured over a tiny
 * mask and score perfectly uniform — the self-referential version of the blank-page failure. Every
 * arm of a case is graded over the same pixel set, so a percentage is comparable down the column.
 *
 * `erosionRadius` is in whole pixels and is applied as that many 8-neighbour erosion passes, so a
 * radius of 1 removes every pixel touching a non-solid one. It is reported beside every number this
 * mask produces; a uniformity percentage without its erosion radius is not a measurement.
 *
 * IT CAN COME BACK EMPTY, AND THAT IS A RESULT. At small ppem a stem is thinner than the erosion
 * and there is no interior to be uniform over. The caller must report that cell as NOT MEASURED —
 * never as 0 % and never as 100 %.
 */
export function buildInteriorMask(
  reference: Plane,
  options: { solidLevel?: number; erosionRadius?: number } = {},
): { mask: Uint8Array; pixels: number; erosionRadius: number } {
  const { solidLevel = 254, erosionRadius = 1 } = options;
  const { width, height } = reference;
  let mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = reference.data[i] >= solidLevel ? 1 : 0;
  }
  for (let pass = 0; pass < erosionRadius; pass += 1) {
    const next = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (mask[i] === 0) continue;
        let keep = 1;
        for (let dy = -1; dy <= 1 && keep; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
              keep = 0;
              break;
            }
            if (mask[ny * width + nx] === 0) {
              keep = 0;
              break;
            }
          }
        }
        next[i] = keep;
      }
    }
    mask = next;
  }
  let pixels = 0;
  for (let i = 0; i < mask.length; i += 1) pixels += mask[i];
  return { mask, pixels, erosionRadius };
}

/** Per-channel tally of how far the deviant interior pixels fall below the fill colour. */
export interface DeviationHistogram {
  /** `histogram[c][d]` = pixels whose channel `c` is exactly `d` bytes BELOW the fill. */
  channels: [
    Record<number, number>,
    Record<number, number>,
    Record<number, number>,
  ];
  /** Largest shortfall seen on each channel, bytes. */
  max: [number, number, number];
  /** Mean shortfall over the interior (deviant and exact alike), bytes. */
  mean: [number, number, number];
}

export interface InteriorUniformity {
  interiorPixels: number;
  /** Pixels whose three channels all equal the fill colour exactly. */
  exactPixels: number;
  /** `exactPixels / interiorPixels`, or `null` when there is no interior to measure. */
  exactRatio: number | null;
  histogram: DeviationHistogram;
  erosionRadius: number;
  /** Distinct RGB triples found in the interior, most common first. The mottle, listed. */
  distinctTriples: { rgb: [number, number, number]; count: number }[];
}

/**
 * Metric (i): how much of the interior is EXACTLY the fill colour, and how the rest misses it.
 *
 * The reported defect is stated in bytes — a game interior that is `#ffedc8` everywhere against an
 * arm whose interior mixes `#feecc7`, `#f8e7c4` and `#f6e6c2` — so this metric is stated in bytes
 * too. The histogram is signed as a SHORTFALL (fill minus sample) because both suspected causes
 * darken: a colour-pipeline rounding error lands at exactly 1 on every channel, and a fill whose
 * coverage is below 1.0 over a dark underlay lands at several, in proportion to the channel's own
 * value. Those two are distinguishable in this histogram and in nothing else the harness reports.
 */
export function interiorUniformity(
  image: RgbaImage,
  mask: Uint8Array,
  fill: readonly [number, number, number],
  erosionRadius: number,
  options: { maxTriples?: number } = {},
): InteriorUniformity {
  const { maxTriples = 12 } = options;
  const channels: DeviationHistogram["channels"] = [{}, {}, {}];
  const max: [number, number, number] = [0, 0, 0];
  const sums: [number, number, number] = [0, 0, 0];
  const triples = new Map<string, number>();
  let interiorPixels = 0;
  let exactPixels = 0;

  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 0) continue;
    interiorPixels += 1;
    const r = image.data[i * 4];
    const g = image.data[i * 4 + 1];
    const b = image.data[i * 4 + 2];
    const key = `${r},${g},${b}`;
    triples.set(key, (triples.get(key) ?? 0) + 1);
    const rgb = [r, g, b] as const;
    let exact = true;
    for (let c = 0; c < 3; c += 1) {
      const delta = fill[c] - rgb[c];
      sums[c] += delta;
      if (delta !== 0) {
        exact = false;
        channels[c][delta] = (channels[c][delta] ?? 0) + 1;
        if (delta > max[c]) max[c] = delta;
      }
    }
    if (exact) exactPixels += 1;
  }

  const distinctTriples = [...triples.entries()]
    .map(([key, count]) => ({
      rgb: key.split(",").map(Number) as [number, number, number],
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxTriples);

  return {
    interiorPixels,
    exactPixels,
    exactRatio: interiorPixels > 0 ? exactPixels / interiorPixels : null,
    histogram: {
      channels,
      max,
      mean: [
        interiorPixels > 0 ? sums[0] / interiorPixels : 0,
        interiorPixels > 0 ? sums[1] / interiorPixels : 0,
        interiorPixels > 0 ? sums[2] / interiorPixels : 0,
      ],
    },
    erosionRadius,
    distinctTriples,
  };
}

export interface Registration {
  dx: number;
  dy: number;
  /** Mean absolute green difference at the winning offset, bytes. */
  score: number;
  /** True when the winner sat on the edge of the search window — the offset is not trustworthy. */
  clamped: boolean;
  searchRadius: number;
}

/**
 * Whole-pixel registration of two frames of the same case drawn by two different engines.
 *
 * WHY IT IS NEEDED AT ALL. Metric (ii) compares our bytes against Godot's for the same case, and
 * Godot is a separate process with its own pen conventions. An unregistered diff of two images one
 * pixel apart reports the glyph's own contrast as an error on every edge, which would swamp the
 * one-byte and few-byte signatures the sweep exists to tell apart.
 *
 * WHOLE PIXELS ONLY, deliberately: resampling one side to a sub-pixel offset would apply a bilinear
 * low-pass to it, and "is this arm's interior exactly the fill colour" cannot survive being
 * resampled. So the residual misregistration is left in the number and `clamped` says when the
 * search could not contain it.
 */
export function registerInteger(
  a: Plane,
  b: Plane,
  searchRadius = 3,
): Registration {
  let best = { dx: 0, dy: 0, score: Number.POSITIVE_INFINITY };
  for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
    for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
      let sum = 0;
      let count = 0;
      for (let y = 0; y < a.height; y += 1) {
        const sy = y + dy;
        if (sy < 0 || sy >= b.height) continue;
        for (let x = 0; x < a.width; x += 1) {
          const sx = x + dx;
          if (sx < 0 || sx >= b.width) continue;
          sum += Math.abs(a.data[y * a.width + x] - b.data[sy * b.width + sx]);
          count += 1;
        }
      }
      const score = count > 0 ? sum / count : Number.POSITIVE_INFINITY;
      if (score < best.score) best = { dx, dy, score };
    }
  }
  return {
    ...best,
    clamped:
      Math.abs(best.dx) === searchRadius || Math.abs(best.dy) === searchRadius,
    searchRadius,
  };
}

export interface ChannelDiff {
  max: [number, number, number];
  mean: [number, number, number];
  /** Pixels compared — the overlap after the registration shift. */
  pixels: number;
  registration: Registration;
}

/**
 * Metric (ii): per-channel max and mean absolute byte difference against the Godot render.
 *
 * Registration is computed on green (see {@link channelPlane}) and then APPLIED to all three
 * channels, so the three numbers describe one alignment rather than three independently best-fit
 * ones.
 */
export function perChannelByteDiff(
  ours: RgbaImage,
  godot: RgbaImage,
  options: { searchRadius?: number; mask?: Uint8Array } = {},
): ChannelDiff {
  const registration = registerInteger(
    channelPlane(ours),
    channelPlane(godot),
    options.searchRadius ?? 3,
  );
  const { dx, dy } = registration;
  const max: [number, number, number] = [0, 0, 0];
  const sums: [number, number, number] = [0, 0, 0];
  let pixels = 0;
  for (let y = 0; y < ours.height; y += 1) {
    const sy = y + dy;
    if (sy < 0 || sy >= godot.height) continue;
    for (let x = 0; x < ours.width; x += 1) {
      const sx = x + dx;
      if (sx < 0 || sx >= godot.width) continue;
      const i = y * ours.width + x;
      if (options.mask && options.mask[i] === 0) continue;
      const j = sy * godot.width + sx;
      pixels += 1;
      for (let c = 0; c < 3; c += 1) {
        const delta = Math.abs(ours.data[i * 4 + c] - godot.data[j * 4 + c]);
        sums[c] += delta;
        if (delta > max[c]) max[c] = delta;
      }
    }
  }
  return {
    max,
    mean: [
      pixels > 0 ? sums[0] / pixels : 0,
      pixels > 0 ? sums[1] / pixels : 0,
      pixels > 0 ? sums[2] / pixels : 0,
    ],
    pixels,
    registration,
  };
}

export interface EdgeProfile {
  /** The 10 % -> 90 % transition width, px. What metric (iii) asks for. */
  width1090Px: number | null;
  /**
   * The equivalent FULL 0 -> 1 linear ramp, px — `width1090Px / 0.8`.
   *
   * Reported beside it because this is the form `goldens/godot-outline-metrics.json` already holds,
   * so the two are directly comparable without a reader having to know the 1.25 factor.
   */
  fullRampPx: number | null;
  rampPixels: number;
  gradientSum: number;
}

/**
 * Metric (iii): edge profile width over a COVERAGE plane.
 *
 * The plane must be white-on-black, i.e. one of the `fillMono` / `outlineMono` variants, where the
 * decoded byte IS the coverage. Handing this the `product` variant would measure the distance
 * between two different boundaries — background-to-outline and outline-to-fill sit a few pixels
 * apart at every glyph edge there — and report it as one edge's softness.
 */
export function edgeProfile(coverage: Plane): EdgeProfile {
  const { rampPixels, gradientSum, rampWidthPx } = gradientRampWidth(coverage);
  return {
    width1090Px: rampWidthPx === null ? null : rampWidthPx * 0.8,
    fullRampPx: rampWidthPx,
    rampPixels,
    gradientSum,
  };
}

export interface DistortionScore {
  acutance: number;
  referenceAcutance: number;
  /** `|1 - acutance / reference|`. Below the reference is blur, above it is aliasing. */
  distortion: number;
  ink: number;
  referenceInk: number;
}

/**
 * Metric (iv): the harness's existing distortion-vs-8x-reference score, on this sweep's cells.
 *
 * NOT HIGHER-IS-BETTER on `acutance`: the reference is the same geometry drawn at 8x and
 * box-downsampled, i.e. correct area coverage, so it is a CEILING rather than a mechanism. Only the
 * distance from it says how wrong an arm is, which is why `distortion` is the column to read.
 */
export function distortionVsReference(
  arm: Plane,
  reference: Plane,
): DistortionScore {
  const a = acutanceOf(arm.data, arm.width, arm.height);
  const r = acutanceOf(reference.data, reference.width, reference.height);
  return {
    acutance: a.acutance,
    referenceAcutance: r.acutance,
    distortion: r.acutance > 0 ? Math.abs(1 - a.acutance / r.acutance) : 0,
    ink: a.ink,
    referenceInk: r.ink,
  };
}

/**
 * THE PRESENCE GUARD, per cell.
 *
 * The harness's stated number-one failure mode is measuring a blank page and reporting excellent
 * numbers, and a fidelity sweep is MORE exposed to it than a timing one: an empty cell has a
 * perfectly uniform interior, a zero edge width and no bytes that differ from Godot. Every cell
 * this module grades must pass here first, and a cell that fails is reported as a failure rather
 * than averaged in.
 */
export function cellPresence(
  image: RgbaImage,
  background: readonly [number, number, number],
  options: { minInkPixels?: number } = {},
): { inkPixels: number; nonEmptyRatio: number; ok: boolean } {
  const { minInkPixels = 16 } = options;
  let inkPixels = 0;
  const total = image.width * image.height;
  for (let i = 0; i < total; i += 1) {
    const r = image.data[i * 4];
    const g = image.data[i * 4 + 1];
    const b = image.data[i * 4 + 2];
    if (r !== background[0] || g !== background[1] || b !== background[2]) {
      inkPixels += 1;
    }
  }
  return {
    inkPixels,
    nonEmptyRatio: total > 0 ? inkPixels / total : 0,
    ok: inkPixels >= minInkPixels,
  };
}
