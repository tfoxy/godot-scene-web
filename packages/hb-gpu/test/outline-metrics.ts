// How SOFT an outline's rim is, how far it REACHES, and how RAGGED it is — as three separate
// numbers, computed from a coverage plane and nothing else.
//
// WHY THIS FILE HAS NO IMPORTS AT ALL. It is read by two processes that share no runtime: vitest in
// node (`outlineMetrics.test.ts` and `glyphPixelXvfb.test.ts`) and the committed generator
// `scripts/godot-outline-ref.ts`, which decodes Godot's PNGs. If either side computed its own
// version of "how wide is the ramp", the Godot column and the hb-gpu column in the golden would be
// two different measurements printed in one table — which is exactly the failure a reference fixture
// exists to prevent. So the arithmetic lives here, once, and depends on nothing that could differ
// between the two hosts.
//
// WHY NOT `acutanceOf`. The fidelity probe's acutance is `Σ|∇| / Σα` — mean gradient per unit ink.
// On a DILATED DOT that telescopes to perimeter-over-area, so it reads a fat blurry blob and a thin
// crisp one as nearly the same number and moves mostly with the RADIUS. It is a fine control column
// and a useless softness metric; this file's `rampWidthPx` is the one that answers "blurry".
//
// THE THREE FAILURES ARE ORTHOGONAL AND MUST NOT BE AVERAGED:
//
//   rampWidthPx   how many pixels the rim takes to go 0 -> 1.  A halo/blur raises it.
//   r50Mean       where the 50% contour sits.  A dilation that reaches too far raises it.
//   r50Stdev      how much that contour wobbles with angle.  A tap set that has stopped tiling
//                 its own disk raises it, and leaves the other two alone.
//
// A single "RMS against a reference" cannot tell those apart: a rim one pixel too soft, one pixel
// too far out, and one pixel scalloped all score similarly, and the fixes for them are in three
// different places in the shader.

/** A single-channel coverage image. Bytes, 0..255, row-major, top-down. */
export interface CoverageImage {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

/**
 * Rays cast from the coverage centroid for the radial form.
 *
 * 256 is chosen against the ANGULAR metric rather than against the radius: the signature this file
 * exists to catch is a boundary that follows a tap count, and the shader's outer ring runs at most
 * 26 steps. Nyquist on a 26-cycle signal needs 52 rays; 256 leaves more than two octaves of headroom
 * above that, costs a few hundred thousand bilinear samples, and makes the mean of 256 crossings a
 * stable number rather than one that moves with where the rays happen to land. It was chosen when
 * the cap was 16 per ring and is still comfortable at 26.
 */
export const RAY_COUNT = 256;

/**
 * Step along each ray, in px.
 *
 * The crossing itself is found by LINEAR INTERPOLATION between the two samples that bracket it, so
 * this is not the resolution of the answer — it is the scale below which the profile is assumed
 * monotone. An eighth of a pixel is comfortably finer than the ~1 px ramp being measured and
 * comfortably coarser than anything a bilinear reconstruction of a byte plane can resolve.
 */
export const RADIAL_STEP_PX = 0.125;

/**
 * The 10/90 width of a straight edge carrying EXACT AREA COVERAGE is 0.8 px, not 1 px — so both
 * forms below multiply by 1.25 and report the equivalent FULL 0 -> 1 linear ramp.
 *
 * WHERE 0.8 COMES FROM, because it is the whole calibration and it is worth being able to check.
 * For an axis-aligned edge a pixel's coverage is `clamp(s + 0.5, 0, 1)` in the signed distance `s`:
 * exactly linear over one pixel, so alpha 0.1 sits at s = -0.4 and alpha 0.9 at s = +0.4 and the
 * 10-90 width is 0.8. For a 45-degree edge the profile is the S-curve `2t²` on the way up (t being
 * the offset normalised over the square's diagonal 1.414), which puts the same two levels at
 * ±0.3909 — a 10-90 width of 0.782. So the constant is orientation-dependent in the third decimal
 * and 1.25 makes an exact-area edge read 0.98-1.00 whichever way it runs.
 *
 * THE SAME FACTOR APPEARS IN BOTH FORMS FOR THE SAME REASON, which is what puts a Han glyph's
 * gradient reading and a dot's radial reading on ONE scale. Without it the golden would be
 * comparing 0.8-scaled numbers with 1.0-scaled ones and every cross-case sentence about it would be
 * wrong by 25%.
 */
export const RAMP_WIDTH_SCALE = 1.25;

/**
 * What the RADIAL form's 10-90 width reads on an edge that has no softness at all, in px.
 *
 * A 1 px ramp is ONE SAMPLE WIDE, so reading its width back off a sampled plane costs something,
 * and this is that cost measured rather than assumed. Rays are sampled by bilinear reconstruction;
 * between the partial pixel and its saturated neighbour the true profile has a CORNER (coverage
 * clamps at 0 and at 1) and a straight line between two samples rounds that corner off. The 50%
 * crossing is unaffected — it always falls in the linear part, which is why `r50Mean` comes back
 * exact — but the 10% and 90% crossings are pushed apart.
 *
 * DERIVED AND THEN MEASURED, and the two agree. Bilinear reconstruction on a unit grid is a
 * separable TENT of base 2, whose variance is 1/6; read as an equivalent gaussian that is a 10-90
 * width of `2.5631 * sqrt(1/6)` = 1.046 px. Measured, an exact-area disk at a generic sub-pixel
 * phase reads a raw 10-90 width of 1.3202 px at R = 20 and 1.3170 at R = 40, against a true 0.800
 * (axis-aligned) to 0.782 (45 degrees) — a quadrature residue of 1.050 and 1.046. Two radii and a
 * first-principles kernel width landing on the same number is what says this belongs to the
 * SAMPLER rather than to any fixture.
 *
 * SUBTRACTED IN QUADRATURE RATHER THAN AS A SCALE, because it behaves like an independent blur.
 * With 1.05 an exact-area disk reports 1.000 at both radii, and against the gradient form — which
 * shares none of this arithmetic — the corrected width agrees to 0.3% at a real gaussian sigma of
 * 1 px (3.348 vs 3.358) and 0.7% at sigma 2 (6.493 vs 6.541). A constant scale factor would have
 * been right at exactly one point on that range.
 *
 * `outlineMetrics.test.ts` pins it: a drift in this constant fails the analytic-disk case first.
 */
export const RADIAL_RECONSTRUCTION_1090_PX = 1.05;

/** The two levels the ramp is measured between, and the contour `r50` follows. */
const LEVEL_LOW = 0.1;
const LEVEL_MID = 0.5;
const LEVEL_HIGH = 0.9;

/**
 * Cycles per revolution the angular metric reports by default.
 *
 * 16 IS NOT A ROUND NUMBER PICKED FOR TIDINESS: it was `HB_GPU_SPREAD_MAX_STEPS`, the cap `webgl.ts`
 * put on EVERY ring's taps. Past the radius at which that cap bound, the outermost ring's taps were
 * the only thing deciding where the dilated boundary lands, so the boundary acquired exactly this
 * many lobes. Reporting the amplitude AT a tap count separates "the tap set has stopped tiling its
 * disk" from every other way a boundary can be rough — noise, a shallow-coverage mottle, a driver's
 * estimator — none of which is periodic at a tap count.
 *
 * THAT CAP IS GONE AND 16 STAYS THE DEFAULT, which needs saying because the two used to be the same
 * fact. `webgl.ts` now bounds the WHOLE tap set at `HB_GPU_SPREAD_MAX_TAPS` and splits it in
 * proportion to ring radius, so the outermost ring runs up to 26 steps and a residual scallop sits
 * at 26 cycles, not 16. This constant is not chased onto 26 for two reasons: the committed Godot
 * golden was measured at 16 and re-deriving its harmonic column would compare a new number against
 * an old one, and 16 remains the bin that says whether the OLD defect has come back. Callers that
 * want the current signature pass `harmonic` explicitly — `glyphPixelXvfb.test.ts` asserts both, and
 * names 26 as `SPREAD_OUTER_RING_STEPS`.
 */
export const DEFAULT_HARMONIC = 16;

/** What the radial form measured, or `null` fields where a ray found no crossing to measure. */
export interface RadialOutlineMetrics {
  centroidX: number;
  centroidY: number;
  /** Rays cast. */
  rays: number;
  /** Rays on which all three levels had an outermost crossing. Fewer means a partial answer. */
  raysMeasured: number;
  /**
   * The "blurry" number: equivalent full 0 -> 1 linear ramp, px.
   *
   * `RAMP_WIDTH_SCALE * sqrt(mean(r10 - r90)² - RADIAL_RECONSTRUCTION_1090_PX²)`, i.e. the raw
   * 10-90 width with the sampler's own contribution taken back out — see that constant. An
   * exact-area edge reads 1.0 here and the gradient form reads 0.89 on the same picture, which is
   * what puts a dot's row and a Han glyph's row of the golden on one scale.
   */
  rampWidthPx: number | null;
  /**
   * `mean(r10 - r90)` with NOTHING taken out of it, px.
   *
   * Reported beside the corrected number rather than instead of it because the correction is a
   * subtraction, and a reader who wants to check it — or who distrusts it — needs the input. It is
   * also the only one of the two that can be compared against a differently-corrected future
   * version of this file.
   */
  rampWidth1090Px: number | null;
  /** Mean radius of the 50% contour, px from the coverage centroid. The "reach" number. */
  r50Mean: number | null;
  /** Population standard deviation of that radius over the rays. The "scallop" number. */
  r50Stdev: number | null;
  r50Min: number | null;
  r50Max: number | null;
  /** Cycles per revolution {@link RadialOutlineMetrics.harmonicAmplitudePx} was taken at. */
  harmonic: number;
  /**
   * Amplitude of the `r50(theta)` profile's component at {@link RadialOutlineMetrics.harmonic}, px.
   *
   * `null` UNLESS EVERY RAY WAS MEASURED, and deliberately: a DFT over a profile with holes in it is
   * a DFT of whatever was substituted for the holes. Absent means not measured, never zero.
   *
   * IT READS ~8% LOW AT THIS HARMONIC AND THE REASON IS KNOWN. A 16-cycle wobble on a boundary of
   * radius 20 has a wavelength of 7.85 px, and both the pixel's own area filter (a 1 px box) and
   * the ray sampler's bilinear reconstruction (a 2 px tent) attenuate it: `sinc(1/7.85)` = 0.973
   * times `sinc²(1/7.85)` = 0.947, i.e. 0.922. Measured on a synthetic boundary perturbed by
   * exactly 0.5 px at 16 lobes: amplitude 0.457 and `r50Stdev` 0.3262 against the ideal 0.5 and
   * 0.3536 — 0.914 and 0.923 of them. So this is a LOWER BOUND on a real scallop, which is the
   * safe direction for a metric whose job is to say a scallop is present.
   */
  harmonicAmplitudePx: number | null;
}

/** Everything one coverage plane says about an outline. */
export interface OutlineMetrics {
  width: number;
  height: number;
  /** Total coverage, in units of fully covered pixels (alpha summed as 0..1). */
  ink: number;
  /** Pixels carrying any coverage at all. */
  inkPixels: number;
  /** Largest coverage anywhere, 0..1. A rim metric on a plane that never saturates is a trap. */
  peak: number;
  /** `#{alpha in (0.1, 0.9)}` over the interior — the gradient form's numerator. */
  rampPixels: number;
  /** `Σ‖∇alpha‖` over the interior, Sobel, descaled to true units — the denominator. */
  gradientSum: number;
  /** `RAMP_WIDTH_SCALE * rampPixels / gradientSum`, px, or `null` when there is no boundary. */
  gradientRampWidthPx: number | null;
  /** The radial form, or `null` when it was not requested. */
  radial: RadialOutlineMetrics | null;
}

export interface OutlineMetricsOptions {
  /**
   * Cast rays and report {@link OutlineMetrics.radial}.
   *
   * ONLY MEANINGFUL FOR A ROUND, ISOLATED FEATURE — a full stop, or any dot dilated past its own
   * size. The rays start at the coverage centroid, so on a 中 or a "B" the "outermost crossing" of a
   * ray is whichever stroke it happens to leave through, and `r50Stdev` would then be measuring the
   * glyph's SHAPE rather than its rim. Use {@link OutlineMetrics.gradientRampWidthPx} there.
   */
  radial?: boolean;
  /** Cycles per revolution for the angular amplitude. Defaults to {@link DEFAULT_HARMONIC}. */
  harmonic?: number;
  /** Rays. Defaults to {@link RAY_COUNT}. */
  rays?: number;
}

/** Bilinear sample of a coverage plane at continuous pixel coordinates, 0 outside. */
function sampleAt(image: CoverageImage, px: number, py: number): number {
  // Pixel (i, j) has its CENTRE at (i + 0.5, j + 0.5) — the same convention `rasterizeReference`
  // samples its scanlines on. Getting this wrong shifts every radius by half a pixel, which is
  // half the budget this file's reach assertions run on.
  const u = px - 0.5;
  const v = py - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const { data, width, height } = image;
  const at = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return data[y * width + x] / 255;
  };
  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  return (
    a * (1 - fx) * (1 - fy) +
    b * fx * (1 - fy) +
    c * (1 - fx) * fy +
    d * fx * fy
  );
}

/** Coverage-weighted centroid and total ink. */
export function coverageCentroid(image: CoverageImage): {
  x: number;
  y: number;
  ink: number;
} {
  const { data, width, height } = image;
  let ink = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[y * width + x] / 255;
      if (alpha === 0) continue;
      ink += alpha;
      sumX += alpha * (x + 0.5);
      sumY += alpha * (y + 0.5);
    }
  }
  if (ink === 0) return { x: width / 2, y: height / 2, ink: 0 };
  return { x: sumX / ink, y: sumY / ink, ink };
}

/**
 * The OUTERMOST radius at which the profile along one ray crosses `level`, or `null`.
 *
 * OUTERMOST, WALKING INWARD, and that is the entire reason this works on a Godot outline. Godot
 * draws `draw_char_outline` as a stroked RING: coverage along a ray from the centre goes 0 (the
 * hole) up to 1 (the stroke) and back to 0 (outside). Our dilated dot is a FILLED disk: 1 all the
 * way out. Those two shapes have completely different profiles and identical OUTER boundaries, and
 * the outer boundary is the thing a reader calls the outline's edge. Taking the first crossing from
 * the centre instead would compare Godot's inner rim against our outer one and report a metre of
 * disagreement where there is none.
 */
function outermostCrossing(
  image: CoverageImage,
  centreX: number,
  centreY: number,
  cos: number,
  sin: number,
  maxRadius: number,
  level: number,
  step: number,
): number | null {
  const steps = Math.ceil(maxRadius / step);
  // Walk in from beyond the image, where the profile is 0 by construction, to the first sample at
  // or above the level. The crossing is between that sample and the one outside it.
  let previous = 0;
  let previousRadius = (steps + 1) * step;
  for (let i = steps; i >= 0; i -= 1) {
    const radius = i * step;
    const value = sampleAt(
      image,
      centreX + cos * radius,
      centreY + sin * radius,
    );
    if (value >= level) {
      if (value === previous) return radius;
      const t = (value - level) / (value - previous);
      return radius + t * (previousRadius - radius);
    }
    previous = value;
    previousRadius = radius;
  }
  return null;
}

/** The radial form: ramp width, reach and scallop from 256 rays out of the coverage centroid. */
export function radialOutlineMetrics(
  image: CoverageImage,
  options: OutlineMetricsOptions = {},
): RadialOutlineMetrics {
  const rays = options.rays ?? RAY_COUNT;
  const harmonic = options.harmonic ?? DEFAULT_HARMONIC;
  const centroid = coverageCentroid(image);
  // Far enough that every ray starts OUTSIDE the shape whatever the centroid's offset — the whole
  // buffer's corner distance. Samples off the edge read 0, which is what makes "walk inward from
  // nothing" well defined.
  const maxRadius = Math.hypot(
    Math.max(centroid.x, image.width - centroid.x),
    Math.max(centroid.y, image.height - centroid.y),
  );

  const r50: number[] = [];
  const widths: number[] = [];
  let raysMeasured = 0;
  let allMeasured = true;
  for (let i = 0; i < rays; i += 1) {
    const theta = (2 * Math.PI * i) / rays;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const find = (level: number): number | null =>
      outermostCrossing(
        image,
        centroid.x,
        centroid.y,
        cos,
        sin,
        maxRadius,
        level,
        RADIAL_STEP_PX,
      );
    const high = find(LEVEL_HIGH);
    const mid = find(LEVEL_MID);
    const low = find(LEVEL_LOW);
    if (high === null || mid === null || low === null) {
      allMeasured = false;
      r50.push(Number.NaN);
      continue;
    }
    raysMeasured += 1;
    r50.push(mid);
    widths.push(low - high);
  }

  const mean = (values: number[]): number =>
    values.reduce((a, b) => a + b, 0) / values.length;
  const measured = r50.filter((value) => Number.isFinite(value));
  const r50Mean = measured.length > 0 ? mean(measured) : null;
  let r50Stdev: number | null = null;
  if (r50Mean !== null && measured.length > 1) {
    // POPULATION stdev: the 256 rays are the whole profile, not a sample drawn from a larger one.
    const variance = mean(measured.map((v) => (v - r50Mean) ** 2));
    r50Stdev = Math.sqrt(variance);
  }

  // THE DFT COEFFICIENT, AND ONLY WHEN THE PROFILE IS COMPLETE. See `harmonicAmplitudePx`.
  let harmonicAmplitudePx: number | null = null;
  if (allMeasured && r50.length > 2 * harmonic) {
    let cosine = 0;
    let sine = 0;
    for (let i = 0; i < r50.length; i += 1) {
      const theta = (2 * Math.PI * i) / r50.length;
      cosine += r50[i] * Math.cos(harmonic * theta);
      sine += r50[i] * Math.sin(harmonic * theta);
    }
    // 2/N normalisation, so a profile of `R + A·cos(k·theta)` reports exactly `A` px.
    harmonicAmplitudePx = (2 / r50.length) * Math.hypot(cosine, sine);
  }

  const raw1090 = widths.length > 0 ? mean(widths) : null;
  return {
    centroidX: centroid.x,
    centroidY: centroid.y,
    rays,
    raysMeasured,
    rampWidthPx:
      raw1090 === null
        ? null
        : RAMP_WIDTH_SCALE *
          Math.sqrt(
            Math.max(0, raw1090 ** 2 - RADIAL_RECONSTRUCTION_1090_PX ** 2),
          ),
    rampWidth1090Px: raw1090,
    r50Mean,
    r50Stdev,
    r50Min: measured.length > 0 ? Math.min(...measured) : null,
    r50Max: measured.length > 0 ? Math.max(...measured) : null,
    harmonic,
    harmonicAmplitudePx,
  };
}

/**
 * The GENERAL form, for glyphs no ray can be cast through: ramp width from the coarea identity.
 *
 * `Σ‖∇alpha‖` over the plane is, by the coarea formula, the integral of the level sets' perimeters
 * over alpha — which for a boundary whose level sets are all roughly parallel is just the perimeter
 * `P`. `#{alpha in (0.1, 0.9)}` is the AREA of the band between those two level sets, which for a
 * ramp of full width `w` is `P · 0.8w`. Dividing one by the other cancels the perimeter — the thing
 * that makes acutance useless here — and leaves `0.8w`, which {@link RAMP_WIDTH_SCALE} turns into
 * `w`.
 *
 * IT IS INDIFFERENT TO A RING VS A FILLED DISK for the same reason the radial form is: a ring has
 * two boundaries, so both numerator and denominator double and the quotient does not move. That is
 * what lets a Godot `draw_char_outline` frame and an hb-gpu dilated frame be quoted in one row.
 *
 * SOBEL, DESCALED BY 8. The standard 3x3 Sobel of a linear ramp of slope `a` is `8a`, so the raw
 * magnitudes are eight times the gradient and the quotient would read an eighth of the true width.
 * A central difference would avoid the constant and be noisier on a byte plane; the smoothing is
 * worth the division. Verified: on a straight edge `gradientSum` comes back as 198.00 over 198
 * interior rows, and on a disk of R = 40 as 251.9 against a perimeter of 251.3.
 *
 * IT NEEDS A BOUNDARY THAT TURNS, AND A FIXTURE AT A GENERIC SUB-PIXEL PHASE. The numerator is a
 * COUNT of pixels, so on a perfectly straight axis-aligned edge every row contributes either
 * exactly one band pixel or exactly none depending on the phase: a swept phase reads 1.25 eight
 * times and 0 twice and averages to the correct 0.796 while no single phase is right. A curved
 * boundary samples every phase at once and takes that average for free — a disk at a generic phase
 * reads 0.983 at R = 20 and 0.983 at R = 40, against an ideal 1.0.
 *
 * THE TRAP IS A PERFECTLY CENTRED FIXTURE. A disk centred on a pixel CORNER has four-fold symmetry
 * aligned with the lattice, so all four quadrants see the same phases and the averaging collapses:
 * the same R = 20 disk reads 0.794 there instead of 0.983. Every synthetic fixture in
 * `outlineMetrics.test.ts` therefore sits at a deliberately irregular centre, and that is not
 * fussiness — it is a 19% reading difference.
 *
 * Ring-indifference, measured rather than argued: one R = 20 boundary as a filled disk reads 0.983
 * and as a 10 px-thick ring reads 0.987. Agreement with the radial form is 11% at the 1 px
 * resolution limit and 0.3-0.7% once the ramp is 3 px or wider.
 */
export function gradientRampWidth(image: CoverageImage): {
  rampPixels: number;
  gradientSum: number;
  rampWidthPx: number | null;
} {
  const { data, width, height } = image;
  let rampPixels = 0;
  let gradientSum = 0;
  // INTERIOR ONLY, and both statistics over the SAME set: a Sobel needs a full 3x3 neighbourhood,
  // and counting ramp pixels on the border while excluding their gradients would bias the quotient.
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = (dx: number, dy: number): number =>
        data[(y + dy) * width + (x + dx)] / 255;
      const alpha = at(0, 0);
      if (alpha > LEVEL_LOW && alpha < LEVEL_HIGH) rampPixels += 1;
      const gx =
        -at(-1, -1) +
        at(1, -1) -
        2 * at(-1, 0) +
        2 * at(1, 0) -
        at(-1, 1) +
        at(1, 1);
      const gy =
        -at(-1, -1) -
        2 * at(0, -1) -
        at(1, -1) +
        at(-1, 1) +
        2 * at(0, 1) +
        at(1, 1);
      gradientSum += Math.hypot(gx, gy) / 8;
    }
  }
  return {
    rampPixels,
    gradientSum,
    rampWidthPx:
      gradientSum > 0 ? (RAMP_WIDTH_SCALE * rampPixels) / gradientSum : null,
  };
}

/** Both forms over one plane. See {@link OutlineMetricsOptions.radial} on when to ask for rays. */
export function measureOutline(
  image: CoverageImage,
  options: OutlineMetricsOptions = {},
): OutlineMetrics {
  const { data, width, height } = image;
  let ink = 0;
  let inkPixels = 0;
  let peak = 0;
  for (let i = 0; i < width * height; i += 1) {
    const alpha = data[i] / 255;
    if (alpha > 0) inkPixels += 1;
    ink += alpha;
    if (alpha > peak) peak = alpha;
  }
  const gradient = gradientRampWidth(image);
  return {
    width,
    height,
    ink,
    inkPixels,
    peak,
    rampPixels: gradient.rampPixels,
    gradientSum: gradient.gradientSum,
    gradientRampWidthPx: gradient.rampWidthPx,
    radial: options.radial ? radialOutlineMetrics(image, options) : null,
  };
}

/** What {@link displacementVsWidth} answers. All coverage sums are in fully-covered-pixel units. */
export interface DisplacementVsWidth {
  /** Arm coverage sitting where the OUTER reference has none at all. "Too far out." */
  outsideInk: number;
  /** Pixels in that zone — the population `outsideInk` is spread over. */
  outsideCount: number;
  /** Coverage the arm is missing inside the INNER reference's solid core. "Not far enough in." */
  insideShortfall: number;
  /** Pixels in that zone. */
  insideCount: number;
  /** Partially covered pixels of the TARGET reference: the band a rim is allowed to live in. */
  bandCount: number;
  /** Target reference's total ink, the denominator that makes the two numbers comparable. */
  referenceInk: number;
  armInk: number;
  /** `outsideInk / referenceInk`. */
  outsideFraction: number;
  /** `insideShortfall / insideCount`, i.e. mean coverage missing per solid-core pixel. */
  insideFraction: number;
}

/**
 * SMEARED, NOTCHED, OR BLURRED — the three ways a dilated rim can be wrong, told apart.
 *
 * A rim RMS against one reference cannot distinguish them: an outline half a pixel too far out, one
 * half a pixel too far in, and one that is in the right place but twice as soft all put the same
 * amount of error in the same pixels. They need different fixes (the reach is geometry, the
 * softness is the contrast curve and the tap count), so they need different numbers.
 *
 * THE THREE REFERENCES ARE THE MEASURING STICK. Given `outline (+) disk(r-1)`, `(+) disk(r)` and
 * `(+) disk(r+1)` — which is what `dilatedReference` produces for three radii — the zones are:
 *
 *   OUTSIDE   the `r+1` reference is exactly 0. Nothing an honest dilation of radius `r` does can
 *             put ink there: it is a whole pixel beyond a shape already a pixel too fat, so even
 *             the fattest legitimate antialiased rim has died out. Ink here is displacement.
 *   INSIDE    the `r-1` reference is exactly 255. A dilation of radius `r` must be solid there with
 *             a pixel to spare. Coverage missing here is a notch.
 *
 * BOTH ZONES ARE CONSERVATIVE BY ABOUT HALF A PIXEL ON PURPOSE, which is why they are cut at r±1
 * rather than at r±0.5. A correct rim scores 0 on both and only a real defect moves either, so the
 * two numbers can carry tight budgets without being budgets on a driver's coverage estimator. A rim
 * that is merely SOFT — the blur case — lights up both at once, because a wide ramp spills outward
 * and hollows inward from the same displacement of the same contour.
 */
export function displacementVsWidth(
  arm: ArrayLike<number>,
  references: {
    inner: ArrayLike<number>;
    target: ArrayLike<number>;
    outer: ArrayLike<number>;
  },
): DisplacementVsWidth {
  const { inner, target, outer } = references;
  let outsideInk = 0;
  let outsideCount = 0;
  let insideShortfall = 0;
  let insideCount = 0;
  let bandCount = 0;
  let referenceInk = 0;
  let armInk = 0;
  for (let i = 0; i < target.length; i += 1) {
    armInk += arm[i] / 255;
    referenceInk += target[i] / 255;
    if (target[i] > 0 && target[i] < 255) bandCount += 1;
    if (outer[i] === 0) {
      outsideCount += 1;
      outsideInk += arm[i] / 255;
    }
    if (inner[i] === 255) {
      insideCount += 1;
      insideShortfall += (255 - arm[i]) / 255;
    }
  }
  return {
    outsideInk,
    outsideCount,
    insideShortfall,
    insideCount,
    bandCount,
    referenceInk,
    armInk,
    outsideFraction: referenceInk > 0 ? outsideInk / referenceInk : 0,
    insideFraction: insideCount > 0 ? insideShortfall / insideCount : 0,
  };
}
