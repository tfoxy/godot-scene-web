// The +-1 level tolerance of gate 6's wide (aspect expand) comparisons, in ONE place. A wider
// target's raster is not bit-stable (the projection divides by the target width), so a wide shot's
// base columns may differ from the 16:9 shot by one level per channel (Q7's delta1): glyph edges on
// NVIDIA, interpolated colours too on llvmpipe. Two checks tolerate it and used to carry the same
// pixel loop and no bound on how many pixels it excuses:
//   - lib/gate6b-wide-checks.ts `wide-reference-extends-native` (native references), and
//   - lib/gate7-g6-checks.ts `wideCompositionCheck` (a browser's wide legs).
// Both now count tolerated pixels with `pm1Level` and judge them with `widePm1Problems`, which
// bounds the FRACTION of tolerated pixels (of compared pixels) and requires every expected shot
// to have been compared.
//
// Calibration (2026-11-04), measured on passing evidence of the NVIDIA native source:
//   artifacts/render-stream/source-cache/5e488685226cdd6d896bac1438ca6d4a/gate6--all
//   (also /tmp/frz-hook-smoke/native-rust-gate6/run, identical): wide/reference-2340x1080 vs
//   hd/reference-native, 15 shots, left 1920 columns = 31 104 000 px compared, 12 px at +-1 (3.9e-7);
//   reference-2520x1080, 15 px (4.8e-7); 0 px beyond 1. `wide-composition@gsw` on the earlier GSW
//   run (scratchpad pres-a-chk7.log): 12 / 15 / 0 px over 15 shots at 2340x1080 / 2520x1080 /
//   1170x540 (about 3e-7 of the 37.9M px each wide leg compares).
// The bound is 1e-4: about 200x the worst measured fraction, still ~100x tighter than "any number".
// UNCALIBRATED for llvmpipe/lavapipe (the remote runners), where interpolated mesh colours also move
// by one level: no passing llvmpipe wide evidence existed on disk to measure. If a remote run trips
// this on a correct build, measure its counts and raise the constant with that run's provenance.

/** The most +-1 pixels allowed, as a fraction of the compared pixels. */
export const WIDE_PM1_MAX_FRACTION = 1e-4;

/** True when the max channel delta `d` is exactly one level: the tolerated, counted difference. */
export function pm1Level(d: number): boolean {
  return d === 1;
}

export interface WidePm1Tally {
  /** Shots actually compared. */
  shots: number;
  /** Shots the leg is expected to compare (every one, or the leg fails). */
  expectedShots: number;
  /** Pixels compared across those shots. */
  compared: number;
  /** Pixels that differ by exactly one level (text regions plus elsewhere). */
  pm1: number;
}

/** Problems with one leg's tally: a partial or empty comparison, or too many +-1 pixels. */
export function widePm1Problems(
  label: string,
  t: WidePm1Tally,
  maxFraction = WIDE_PM1_MAX_FRACTION,
): string[] {
  const problems: string[] = [];
  if (t.expectedShots <= 0 || t.shots === 0 || t.compared === 0) {
    problems.push(
      `${label}: no shot compared (${t.shots} of ${t.expectedShots} shots, ${t.compared} px)`,
    );
    return problems;
  }
  if (t.shots !== t.expectedShots)
    problems.push(`${label}: ${t.shots} of ${t.expectedShots} shots compared`);
  const fraction = t.pm1 / t.compared;
  if (fraction > maxFraction) {
    problems.push(
      `${label}: ${t.pm1} of ${t.compared} px differ by one level (${fraction.toExponential(2)} > ${maxFraction.toExponential(0)})`,
    );
  }
  return problems;
}
