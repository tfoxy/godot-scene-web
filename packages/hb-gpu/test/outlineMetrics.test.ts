// Does `outline-metrics.ts` measure what it says it measures? Four synthetic pictures, no GPU.
//
// WHY THIS FILE EXISTS AT ALL. The Godot golden and the gated pixel suite both quote numbers out of
// that module, and neither of them can tell a wrong METRIC from a wrong RENDERER: if `rampWidthPx`
// were blind to blur, a soft outline and a crisp one would both report 1.6 and the golden would say
// the shader was fine. So the metric is graded first, against pictures whose answers are known by
// construction — an exact-area disk IS a 1 px ramp, a disk convolved with a known gaussian IS a
// wider one, a sub-pixel translation changes NOTHING, and a boundary perturbed at exactly 16 lobes
// has exactly that much scallop and no extra softness.
//
// THE FOUR CLAIMS, ONE PER CASE, AND THEY ARE INDEPENDENT:
//
//   1. calibration  an exact-area edge reads 1.0 px, i.e. the units are px of real ramp
//   2. sensitivity  a known blur raises it by the predicted amount — the metric SEES softness
//   3. registration a sub-pixel translation moves every metric by <0.02 px
//   4. selectivity  a scallop moves `r50Stdev` and the 16-cycle amplitude and NOT the ramp width
//
// 2 and 4 are the pair that matters. Stage 1 of this round expects to fix a SOFTNESS defect and
// Stage 2 a SCALLOP defect, and if one number moved for both there would be no way to say which
// fix worked.
//
// EVERY FIXTURE SITS AT A DELIBERATELY IRREGULAR CENTRE. A disk centred on a pixel corner has its
// four-fold symmetry aligned with the lattice, every quadrant sees the same sub-pixel phases, and
// the phase averaging that both forms depend on collapses — the gradient form reads 0.794 there
// against 0.983 one third of a pixel away. That is a 19% reading difference produced by nothing but
// where the fixture was put, and it is why `CENTRE_X`/`CENTRE_Y` are not round numbers.
//
// MEASURE, LOG, THEN ASSERT — this package's rule. Every budget below is the measured value plus a
// stated rule, and the numbers in the comments are what this file printed when they were set.

import { describe, expect, it } from "vitest";
import {
  type CoverageImage,
  displacementVsWidth,
  measureOutline,
  RADIAL_RECONSTRUCTION_1090_PX,
} from "./outline-metrics";

/** Buffer side, px. Big enough to hold the disk plus the widest blur with background to spare. */
const SIZE = 96;

/** The disk's radius, px. */
const RADIUS = 20;

/**
 * The centre, and it is off-lattice on purpose — see the header.
 *
 * Also NOT on a half-pixel: a centre at `x.5` sits on a pixel CENTRE and reintroduces a weaker
 * version of the same symmetry. 0.31 and 0.17 share no small denominator with the grid or with
 * each other.
 */
const CENTRE_X = 48.31;
const CENTRE_Y = 48.17;

/** Supersampling for the boundary pixels — 4096 samples, i.e. quantisation well under a byte. */
const SUBSAMPLES = 64;

/** Lobes and amplitude of the scallop fixture. 16 is `DEFAULT_HARMONIC`; see the module for why it
 *  stayed 16 after the shader's per-ring step cap went away. */
const LOBES = 16;
const LOBE_AMPLITUDE_PX = 0.5;

/** The sub-pixel translation case 3 applies. Coprime with everything about the grid. */
const SHIFT_PX = 0.37;

/** The gaussian case 2 convolves with, px. */
const BLUR_SIGMA_PX = 1;

/**
 * Exact-area coverage of a star-shaped region, as a byte plane.
 *
 * Pixels more than 1.5 px from the boundary are filled or empty outright and only the rim is
 * supersampled — the ramp is one pixel wide, so everything past that is saturated and costing 4096
 * inside-tests for it would be paying for a known answer.
 *
 * `nominalRadius` IS WHAT THAT SHORT-CIRCUIT IS MEASURED FROM, and it has to be the radius being
 * drawn rather than the fixture's own: the grader case rasterises discs at `RADIUS ± 1.5`, and
 * cutting their saturation bands at `RADIUS ± 1.5` truncates exactly the boundary under test. That
 * bug scored a fat arm and a thin arm as perfect, which is the one answer neither can have.
 */
function rasterize(
  radiusAt: (theta: number) => number,
  centreX: number,
  centreY: number,
  nominalRadius: number,
): CoverageImage {
  const data = new Uint8Array(SIZE * SIZE);
  const inside = (x: number, y: number): boolean => {
    const dx = x - centreX;
    const dy = y - centreY;
    return Math.hypot(dx, dy) <= radiusAt(Math.atan2(dy, dx));
  };
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const distance = Math.hypot(x + 0.5 - centreX, y + 0.5 - centreY);
      if (distance < nominalRadius - 1.5) {
        data[y * SIZE + x] = 255;
        continue;
      }
      if (distance > nominalRadius + 1.5) continue;
      let hit = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
        for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
          if (
            inside(x + (sx + 0.5) / SUBSAMPLES, y + (sy + 0.5) / SUBSAMPLES)
          ) {
            hit += 1;
          }
        }
      }
      data[y * SIZE + x] = Math.round((255 * hit) / (SUBSAMPLES * SUBSAMPLES));
    }
  }
  return { data, width: SIZE, height: SIZE };
}

/** A plain disk of `radius` at the fixture centre, unless a centre is given. */
function disk(
  radius: number,
  centreX = CENTRE_X,
  centreY = CENTRE_Y,
): CoverageImage {
  return rasterize(() => radius, centreX, centreY, radius);
}

/** Separable gaussian, truncated at 4 sigma and renormalised, edges clamped. */
function gaussianBlur(image: CoverageImage, sigma: number): CoverageImage {
  const reach = Math.ceil(4 * sigma);
  const kernel: number[] = [];
  let total = 0;
  for (let i = -reach; i <= reach; i += 1) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(weight);
    total += weight;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= total;
  const clamp = (v: number): number => Math.min(SIZE - 1, Math.max(0, v));
  const rows = new Float64Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let acc = 0;
      for (let k = -reach; k <= reach; k += 1) {
        acc += kernel[k + reach] * image.data[y * SIZE + clamp(x + k)];
      }
      rows[y * SIZE + x] = acc;
    }
  }
  const data = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let acc = 0;
      for (let k = -reach; k <= reach; k += 1) {
        acc += kernel[k + reach] * rows[clamp(y + k) * SIZE + x];
      }
      data[y * SIZE + x] = Math.round(Math.min(255, acc));
    }
  }
  return { data, width: SIZE, height: SIZE };
}

/**
 * RESAMPLE the plane by `dx` with bilinear weights — which is NOT how case 3 moves its disk.
 *
 * Kept because the difference is the whole point of case 3's second half. Re-rasterising the shape
 * at a new centre changes only WHERE it is; resampling an existing plane also blurs it, by a 2-tap
 * kernel of variance `t(1-t)`. A metric that reported those two as the same thing would be blind to
 * a real softening, so this is asserted to widen the ramp rather than waved away.
 */
function bilinearResample(image: CoverageImage, dx: number): CoverageImage {
  const data = new Uint8Array(SIZE * SIZE);
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= SIZE || y >= SIZE ? 0 : image.data[y * SIZE + x];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const u = x - dx;
      const x0 = Math.floor(u);
      const fx = u - x0;
      data[y * SIZE + x] = Math.round(
        at(x0, y) * (1 - fx) + at(x0 + 1, y) * fx,
      );
    }
  }
  return { data, width: SIZE, height: SIZE };
}

/** The 10-90 width a gaussian of `sigma` has on its own, px. `2 * 1.2816 * sigma`. */
const GAUSSIAN_1090_PER_SIGMA = 2.5631;

/** Both forms plus the radial block, which every case here wants. */
const measure = (image: CoverageImage) =>
  measureOutline(image, { radial: true });

describe("outline metrics", () => {
  const sharp = disk(RADIUS);
  const sharpMetrics = measure(sharp);

  it("reads 1.0 px of ramp on an edge that carries exact area coverage", () => {
    const radial = sharpMetrics.radial;
    if (!radial) throw new Error("the radial block was not computed");
    console.log(
      `outline metrics sharp disk: ramp ${radial.rampWidthPx?.toFixed(4)} px (raw 10-90 ${radial.rampWidth1090Px?.toFixed(4)}), gradient ${sharpMetrics.gradientRampWidthPx?.toFixed(4)}, r50 ${radial.r50Mean?.toFixed(4)} +- ${radial.r50Stdev?.toFixed(4)}, h${radial.harmonic} ${radial.harmonicAmplitudePx?.toFixed(4)}, ink ${sharpMetrics.ink.toFixed(2)}, rays ${radial.raysMeasured}/${radial.rays}`,
    );

    // NON-VACUITY. A blank plane has no crossings at all and every budget below would be `null`
    // rather than wrong, which vitest would report as a type error three lines later instead of as
    // "the fixture drew nothing".
    expect(
      radial.raysMeasured,
      "not every ray found all three level crossings — the fixture is not a closed shape around its own centroid",
    ).toBe(radial.rays);
    expect(sharpMetrics.peak, "the disk never reaches full coverage").toBe(1);

    // 1. THE UNIT. An exact-area edge is a 1 px ramp by definition, so this is what says the number
    //    is px of real ramp and not px of sampler. Measured 1.0003; the band is +-5%, which is
    //    wide enough for the 0.6% the reading moves between R = 20 and R = 40 and far too narrow to
    //    survive a wrong `RADIAL_RECONSTRUCTION_1090_PX` (dropping it to 0.5 reads 1.22).
    expect(radial.rampWidthPx).toBeGreaterThan(0.95);
    expect(
      radial.rampWidthPx,
      `an exact-area edge reads ${radial.rampWidthPx?.toFixed(4)} px of ramp where it is 1.0 px wide by construction — the reconstruction correction (${RADIAL_RECONSTRUCTION_1090_PX}) is wrong, and every softness number in the Godot golden is then in the wrong units`,
    ).toBeLessThan(1.05);

    // 2. THE OTHER FORM, ON THE SAME PICTURE, ON THE SAME SCALE. This is what lets the golden put a
    //    dot's row (radial) and a Han glyph's row (gradient) in one table. Measured 0.9831; the
    //    band is +-10% because the gradient form's numerator is a pixel COUNT and is ~2% low at the
    //    1 px limit for that reason alone.
    expect(sharpMetrics.gradientRampWidthPx).toBeGreaterThan(0.9);
    expect(
      sharpMetrics.gradientRampWidthPx,
      `the gradient form reads ${sharpMetrics.gradientRampWidthPx?.toFixed(4)} on a picture the radial form reads ${radial.rampWidthPx?.toFixed(4)} on — the two are supposed to share a scale`,
    ).toBeLessThan(1.1);

    // 3. REACH IS EXACT. The 50% contour of an exact-area edge is the geometric edge, and this is
    //    the number every reach budget downstream is denominated in. Measured 19.9938 against 20.
    expect(
      Math.abs((radial.r50Mean ?? 0) - RADIUS),
      `the 50% contour sits at ${radial.r50Mean?.toFixed(4)} px on a disk of radius ${RADIUS}`,
    ).toBeLessThan(0.02);

    // 4. AND A CIRCLE HAS NO SCALLOP. Measured 0.0537 px of stdev and 0.0008 px at 16 cycles —
    //    the floor case 4's numbers are read against.
    expect(
      radial.r50Stdev,
      `a perfect circle's 50% contour wobbles by ${radial.r50Stdev?.toFixed(4)} px`,
    ).toBeLessThan(0.08);
    expect(
      radial.harmonicAmplitudePx,
      `a perfect circle carries ${radial.harmonicAmplitudePx?.toFixed(4)} px at ${radial.harmonic} cycles per revolution`,
    ).toBeLessThan(0.02);
  });

  it("sees a known blur, and by the width the convolution predicts", () => {
    const blurred = measure(gaussianBlur(sharp, BLUR_SIGMA_PX));
    const radial = blurred.radial;
    const sharpRadial = sharpMetrics.radial;
    if (!radial || !sharpRadial) throw new Error("no radial block");

    // THE PREDICTION, FROM THE KERNEL AND NOTHING ELSE. The edge contributes a 10-90 width of 0.8
    // px and the gaussian `2.5631 * sigma`; softenings add in quadrature. This is the whole claim
    // that the metric is measuring the convolution rather than reporting a number that happens to
    // go up.
    const predicted =
      1.25 * Math.hypot(0.8, GAUSSIAN_1090_PER_SIGMA * BLUR_SIGMA_PX);
    console.log(
      `outline metrics blurred (sigma ${BLUR_SIGMA_PX}): ramp ${radial.rampWidthPx?.toFixed(4)} px, predicted ${predicted.toFixed(4)}, gradient ${blurred.gradientRampWidthPx?.toFixed(4)}, r50 ${radial.r50Mean?.toFixed(4)} +- ${radial.r50Stdev?.toFixed(4)}, ink ${blurred.ink.toFixed(2)} vs sharp ${sharpMetrics.ink.toFixed(2)}`,
    );

    // NON-VACUITY: a blur conserves ink, so a fixture that lost half of it is not the picture this
    // case thinks it is.
    expect(Math.abs(blurred.ink / sharpMetrics.ink - 1)).toBeLessThan(0.01);

    // 1. IT MOVED, AND A LONG WAY. Measured 1.0003 -> 3.3481. The gap budget is 2.0, i.e. 85% of
    //    the measured 2.348, so a metric that saw only a fraction of the blur still fails.
    expect(
      (radial.rampWidthPx ?? 0) - (sharpRadial.rampWidthPx ?? 0),
      `a 1 px gaussian moved the ramp width from ${sharpRadial.rampWidthPx?.toFixed(4)} to ${radial.rampWidthPx?.toFixed(4)} — the metric is not seeing softness, which is the one thing it exists to see`,
    ).toBeGreaterThan(2);

    // 2. AND BY THE PREDICTED AMOUNT. Measured 3.3481 against a predicted 3.3563 — 0.25% out. The
    //    budget is 0.15 px, which covers the quadrature model's own crudeness (it is exact for two
    //    gaussians and the edge profile is a box) and would still fail a metric that read the blur
    //    at 4/5 or 6/5 of its real width.
    expect(
      Math.abs((radial.rampWidthPx ?? 0) - predicted),
      `the metric reads ${radial.rampWidthPx?.toFixed(4)} px where convolving a 0.8 px 10-90 edge with a ${BLUR_SIGMA_PX} px gaussian predicts ${predicted.toFixed(4)}`,
    ).toBeLessThan(0.15);

    // 3. THE OTHER FORM AGREES, and that is a real check rather than a restatement: it shares no
    //    arithmetic with the radial one — no rays, no centroid, no reconstruction correction.
    //    Measured 3.3577 against 3.3481.
    expect(
      Math.abs((blurred.gradientRampWidthPx ?? 0) - (radial.rampWidthPx ?? 0)),
      `the two forms disagree by more than 0.2 px on the same blurred picture (${blurred.gradientRampWidthPx?.toFixed(4)} vs ${radial.rampWidthPx?.toFixed(4)})`,
    ).toBeLessThan(0.2);

    // 4. AND SOFTNESS IS NOT REACH. A blur must not move where the 50% contour is — if it did, the
    //    Godot comparison could not tell "ours is softer" from "ours reaches further", which is
    //    exactly the confusion this whole module is built to end. Measured 19.9938 -> 19.9686; the
    //    0.025 px it does move is the curvature of a convex boundary under a symmetric kernel.
    expect(
      Math.abs((radial.r50Mean ?? 0) - (sharpRadial.r50Mean ?? 0)),
      `blurring moved the 50% contour by ${Math.abs((radial.r50Mean ?? 0) - (sharpRadial.r50Mean ?? 0)).toFixed(4)} px — softness is leaking into the reach metric`,
    ).toBeLessThan(0.06);
  });

  it("is registration-free: a sub-pixel translation moves nothing", () => {
    const shifted = measure(disk(RADIUS, CENTRE_X + SHIFT_PX, CENTRE_Y));
    const base = sharpMetrics.radial;
    const moved = shifted.radial;
    if (!base || !moved) throw new Error("no radial block");

    const deltas: [string, number][] = [
      ["rampWidthPx", (moved.rampWidthPx ?? 0) - (base.rampWidthPx ?? 0)],
      ["r50Mean", (moved.r50Mean ?? 0) - (base.r50Mean ?? 0)],
      ["r50Stdev", (moved.r50Stdev ?? 0) - (base.r50Stdev ?? 0)],
      [
        `h${base.harmonic}`,
        (moved.harmonicAmplitudePx ?? 0) - (base.harmonicAmplitudePx ?? 0),
      ],
      [
        "gradientRampWidthPx",
        (shifted.gradientRampWidthPx ?? 0) -
          (sharpMetrics.gradientRampWidthPx ?? 0),
      ],
    ];
    console.log(
      `outline metrics shifted ${SHIFT_PX} px: ${deltas.map(([name, d]) => `${name} ${d >= 0 ? "+" : ""}${d.toFixed(4)}`).join(", ")}`,
    );

    // THE CLAIM, ON EVERY COLUMN AT ONCE. Nothing here is graded against a reference image, so a
    // metric that drifted with sub-pixel phase would put that drift straight into the Godot
    // comparison — where the two sides have no reason to share a phase at all. Measured worst
    // 0.0099 px (the gradient form); the budget is 0.02, which is also the reach budget above.
    for (const [name, delta] of deltas) {
      expect(
        Math.abs(delta),
        `${name} moved ${delta.toFixed(4)} px when the SAME shape was rasterised ${SHIFT_PX} px to the right — the metric depends on where the fixture sits, so no cross-renderer comparison using it means anything`,
      ).toBeLessThan(0.02);
    }

    // AND THE OTHER HALF, WHICH KEEPS SOMEBODY FROM "FIXING" THIS INTO BLINDNESS. Registration-free
    // is not the same as resample-blind: pushing the plane through a bilinear resample really does
    // soften it (a 2-tap kernel of variance 0.37*0.63 = 0.233), and the metric must SAY so.
    // Measured: 1.0003 -> 1.4889, a rise of 0.4886.
    const resampled = measure(bilinearResample(sharp, SHIFT_PX));
    console.log(
      `outline metrics bilinear-resampled ${SHIFT_PX} px: ramp ${resampled.radial?.rampWidthPx?.toFixed(4)} px, gradient ${resampled.gradientRampWidthPx?.toFixed(4)} — a RESAMPLE is a blur and must read as one`,
    );
    expect(
      (resampled.radial?.rampWidthPx ?? 0) - (base.rampWidthPx ?? 0),
      "a bilinear resample softened the plane and the ramp width did not move — the metric has been made blind to blur, not merely indifferent to position",
    ).toBeGreaterThan(0.3);
  });

  it("separates a scallop from a softening: 16 lobes move the wobble, not the width", () => {
    const lobed = measure(
      rasterize(
        (theta) => RADIUS + LOBE_AMPLITUDE_PX * Math.cos(LOBES * theta),
        CENTRE_X,
        CENTRE_Y,
        RADIUS,
      ),
    );
    const radial = lobed.radial;
    const base = sharpMetrics.radial;
    if (!radial || !base) throw new Error("no radial block");

    // THE IDEAL, AND WHY THE MEASURED VALUE IS 8% UNDER IT. A boundary at `R + A·cos(16θ)` has a
    // 50%-contour stdev of `A/sqrt(2)` = 0.3536 and an amplitude of exactly `A` = 0.5. At R = 20
    // that wobble has a wavelength of 7.85 px, which the pixel's own 1 px box filter and the ray
    // sampler's 2 px tent attenuate by `sinc(1/7.85) * sinc²(1/7.85)` = 0.922 — so the honest
    // targets are 0.326 and 0.461, and the metric under-reports a real scallop rather than
    // inventing one.
    const idealStdev = LOBE_AMPLITUDE_PX / Math.SQRT2;
    console.log(
      `outline metrics lobed (${LOBES} x ${LOBE_AMPLITUDE_PX} px): r50 ${radial.r50Mean?.toFixed(4)} +- ${radial.r50Stdev?.toFixed(4)} (ideal ${idealStdev.toFixed(4)}, attenuated ~0.326), h${radial.harmonic} ${radial.harmonicAmplitudePx?.toFixed(4)} (ideal ${LOBE_AMPLITUDE_PX}, attenuated ~0.461), ramp ${radial.rampWidthPx?.toFixed(4)} vs circle ${base.rampWidthPx?.toFixed(4)}, gradient ${lobed.gradientRampWidthPx?.toFixed(4)}`,
    );

    // 1. THE WOBBLE IS THERE AND IS THE RIGHT SIZE. Measured 0.3313 against an attenuated ideal of
    //    0.326. The band is [0.30, 0.40]: below it the metric is losing a real scallop, above it
    //    the metric is manufacturing one, and a circle reads 0.0537.
    expect(radial.r50Stdev).toBeGreaterThan(0.3);
    expect(
      radial.r50Stdev,
      `a boundary perturbed by ${LOBE_AMPLITUDE_PX} px reads ${radial.r50Stdev?.toFixed(4)} px of contour stdev against an ideal ${idealStdev.toFixed(4)}`,
    ).toBeLessThan(0.4);

    // 2. AND IT IS AT THE RIGHT FREQUENCY — the claim `r50Stdev` alone cannot make. Roughness from
    //    noise, from a shallow-coverage mottle or from a driver's estimator raises the stdev too;
    //    only a boundary following a TAP COUNT puts its power at 16 cycles. Measured 0.4619 against
    //    an attenuated ideal of 0.461, versus 0.0008 for the circle — a factor of 577.
    expect(radial.harmonicAmplitudePx).toBeGreaterThan(0.35);
    expect(
      radial.harmonicAmplitudePx,
      `the ${LOBES}-cycle amplitude reads ${radial.harmonicAmplitudePx?.toFixed(4)} px for a ${LOBE_AMPLITUDE_PX} px perturbation`,
    ).toBeLessThan(0.55);
    expect(
      (radial.harmonicAmplitudePx ?? 0) / (base.harmonicAmplitudePx ?? 1),
      "the scalloped fixture and the circle report comparable power at 16 cycles — the angular metric is not frequency-selective, so it cannot attribute a rough boundary to the tap set",
    ).toBeGreaterThan(50);

    // 3. AND THE SOFTNESS DID NOT MOVE. This is the orthogonality Stages 1 and 2 are graded on.
    //    Measured 1.0003 -> 1.0786, a rise of 7.8%, and that 7.8% is PREDICTED rather than
    //    tolerated: a lobed boundary tilts away from the ray it is measured along by
    //    `atan((dr/dθ)/r)` = `atan(8/20)` = 21.8 degrees, and a ramp crossed obliquely is longer by
    //    `1/cos` = 1.077. So the ray geometry accounts for the whole of it and there is no extra
    //    blur to find. The budget is 1.20 — 11% above the measured value and nowhere near the
    //    3.35 a real 1 px softening reads.
    expect(
      radial.rampWidthPx,
      `a pure scallop moved the ramp width to ${radial.rampWidthPx?.toFixed(4)} px from ${base.rampWidthPx?.toFixed(4)} — more than the 1.077 ray-obliquity factor explains, so raggedness is leaking into the softness metric and Stage 1 and Stage 2 could not be told apart`,
    ).toBeLessThan(1.2);
  });

  it("tells a smear, a notch and a blur apart from one another", () => {
    // THE DISPLACEMENT GRADER, on four arms whose defect is known by construction and graded
    // against the same three references `glyphPixelXvfb.test.ts` builds from `dilatedReference`.
    const references = {
      inner: disk(RADIUS - 1).data,
      target: sharp.data,
      outer: disk(RADIUS + 1).data,
    };
    const grade = (arm: CoverageImage) =>
      displacementVsWidth(arm.data, references);

    const truth = grade(sharp);
    const blurred = grade(gaussianBlur(sharp, BLUR_SIGMA_PX));
    const fat = grade(disk(RADIUS + 1.5));
    const thin = grade(disk(RADIUS - 1.5));
    for (const [label, g] of [
      ["truth", truth],
      ["blurred", blurred],
      ["fat +1.5", fat],
      ["thin -1.5", thin],
    ] as const) {
      console.log(
        `outline metrics grader ${label.padEnd(9)}: outside ${g.outsideInk.toFixed(3)} px (${(100 * g.outsideFraction).toFixed(3)}%), inside shortfall ${g.insideShortfall.toFixed(3)} px (${(100 * g.insideFraction).toFixed(3)}%) over ${g.insideCount} core px, band ${g.bandCount} px`,
      );
    }

    // NON-VACUITY: the zones exist at all. An `outer` reference that covered the frame would make
    // every "outside" reading 0 for the wrong reason.
    expect(truth.insideCount).toBeGreaterThan(500);
    expect(truth.outsideCount).toBeGreaterThan(500);
    expect(truth.bandCount).toBeGreaterThan(100);

    // 1. THE TRUTH SCORES EXACT ZEROS. Not "small" — zero, on both columns, because the zones are
    //    cut a whole pixel outside and inside the shape being graded. That is what lets the pixel
    //    suite put a tight budget on these without it becoming a budget on a rasteriser.
    expect(truth.outsideInk).toBe(0);
    expect(truth.insideShortfall).toBe(0);

    // 2. A FAT ARM LIGHTS UP ONLY "OUTSIDE". Measured 9.310 px of ink outside, 0 shortfall inside.
    expect(fat.outsideInk).toBeGreaterThan(5);
    expect(
      fat.insideShortfall,
      "a dilation that reaches too FAR is reported as also missing its core — the two zones are not independent",
    ).toBe(0);

    // 3. A THIN ARM LIGHTS UP ONLY "INSIDE". Measured 9.176 px short, 0 outside.
    expect(thin.insideShortfall).toBeGreaterThan(5);
    expect(
      thin.outsideInk,
      "a dilation that falls SHORT is reported as also smearing outward",
    ).toBe(0);

    // 4. AND A BLUR LIGHTS UP BOTH, which is the reading that distinguishes softness from
    //    displacement without needing a second fixture. Measured 3.365 out and 3.302 in — within
    //    2% of each other, because a symmetric kernel spills symmetrically.
    expect(blurred.outsideInk).toBeGreaterThan(1);
    expect(blurred.insideShortfall).toBeGreaterThan(1);
    expect(
      Math.abs(blurred.outsideInk - blurred.insideShortfall) /
        blurred.outsideInk,
      "a symmetric blur spilled asymmetrically — one of the two zones is measuring something other than the contour it names",
    ).toBeLessThan(0.35);
  });
});
