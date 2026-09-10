// The geometry both halves of the pixel test need, and nothing else in it.
//
// A VALUE import from the node side, and allowed to be — the same arrangement
// `packages/test-harness/src/canvas-pixel/fx-source.ts` has with its own suite. `browser-entry.ts`
// writes to `window` at module scope and pulls in the emscripten glue, so importing it from vitest
// would run the page half inside the node process. The cases and the model matrix have to be
// IDENTICAL on both sides — the reference is graded on sub-pixel registration against the arm — so
// they live in one file that neither side owns.

/** One case's geometry. */
export interface GlyphCase {
  /** Code point to draw. */
  text: string;
  /** Drawing-buffer size, device px, square. */
  size: number;
  /** Object units (device px) per em. */
  pixelsPerEm: number;
  /** Pen origin — on the baseline, at the glyph's origin — in device px. */
  originX: number;
  originY: number;
  /** Rotation in degrees, about the drawing buffer's centre. Positive is clockwise on screen. */
  degrees: number;
}

/**
 * WHOLE-PIXEL ORIGINS, and not by accident.
 *
 * `docs/text-rendering.md` records a whole round in which every arm read 0.51 px out because
 * stacking two runs put their rest positions on half-pixels. A rest position on a fraction is a
 * fraction that every estimator downstream has to model exactly; a rest position on a whole pixel
 * is one that both sides get right or neither does. Sub-pixel behaviour is a sweep's job, not a
 * fixture's.
 */
export const GLYPH_CASES: Record<string, GlyphCase> = {
  // 14 px is the round's size and, crucially, is INSIDE `_hb_gpu_slug`'s `ppem < 16` branch, where
  // the shader runs `_hb_gpu_slug_single` five times (one centre tap plus four MSAA taps). That
  // branch is the one `docs/text-rendering.md` names as this arm's per-fragment cost, so a pixel
  // guard that never entered it would be testing the cheaper half of the shader.
  upright14: {
    text: "中",
    size: 96,
    pixelsPerEm: 14,
    originX: 41,
    originY: 54,
    degrees: 0,
  },
  // 28 px is OUTSIDE the branch: single-tap analytic coverage, and enough ink for the correlation
  // estimator to be well conditioned. The two sizes together say the upload is right in both
  // shader paths rather than only in the one that averages five taps and might hide an error.
  upright28: {
    text: "中",
    size: 96,
    pixelsPerEm: 28,
    originX: 36,
    originY: 60,
    degrees: 0,
  },
  // The round's actual geometry. Rotation goes through `u_matViewProjection`, so this is also the
  // only case in which `hb_gpu_dilate` is asked for half a pixel along an axis that is neither of
  // the glyph's own.
  rotated28: {
    text: "中",
    size: 96,
    pixelsPerEm: 28,
    originX: 36,
    originY: 60,
    degrees: 10,
  },
};

/**
 * The geometry the SPREAD probe draws, and why it is an "L" rather than the Han the rest uses.
 *
 * THE OUTLINE'S FAILURE MODE IS A SMEAR, NOT A DISPLACEMENT, and only a glyph with a large EMPTY
 * region inside its own ink box can see it. `_hb_gpu_decode_glyph` CLAMPS its band index, so a
 * fragment beyond the glyph's extent still decodes a real band; the whole dilation rests on that
 * clamped band answering coverage 0 there rather than smearing the edge band outwards. Against 中,
 * whose strokes reach every side of its box, "the box filled in" and "the glyph dilated" look
 * nearly the same. An "L" has a corner that is empty for two thirds of its box width and height,
 * and it stays empty under any honest dilation.
 *
 * The face is subset to ASCII + U+25A0 + 3000 Han (`scripts/ensure-cjk-font.ts`), so an ASCII "L"
 * is really there.
 *
 * SIZE: this face's Latin is narrow — an "L" is about 160 inked pixels at 56 px per em — and the
 * assertions over it are counts, so the case is drawn at 96 px per em in a 128 px buffer instead.
 * That is a sample of several hundred pixels per mask rather than a few dozen, and still leaves
 * room for the spread on every side, which matters because the assertions cover the whole frame.
 */
export const SPREAD_CASE: GlyphCase = {
  text: "L",
  size: 128,
  pixelsPerEm: 96,
  originX: 34,
  originY: 108,
  degrees: 0,
};

/**
 * Object-space spread for the probe, in device px, and the number the budgets below were read at.
 *
 * Big enough that a missing vertex expansion is unmissable (an outline this wide clipped to the ink
 * box loses most of itself) and small enough to stay inside the fragment shader's sub-pixel tap
 * regime — see `HbGpuRenderer.setSpread` on what happens past ~4 device px.
 */
export const SPREAD_PX = 4;

/**
 * A SECOND spread fixture, and the only one that can see a single-ring tap set.
 *
 * MEASURED, NOT ASSUMED: replacing the shader's concentric rings with one ring at the full radius
 * leaves the "L" case above entirely green. Its stem is nine device pixels wide and sixty-seven
 * tall, so a ring of radius 4 centred anywhere near it always crosses it — the ring's whole failure
 * mode needs a feature SMALLER than the ring's diameter in BOTH axes, and an "L" has none.
 *
 * A FULL STOP AT A SPREAD LARGER THAN ITSELF IS THAT FEATURE. Its dot is about ten device pixels
 * across at 96 px per em; at a spread of 12 a fragment just outside the dot is 1-11 px from ink, so
 * a tap ring at radius 12 clears it completely and reports nothing, while every inner ring finds
 * it. The honest dilation covers that fragment and a one-ring dilation punches an annular hole
 * around the dot — which reads as a slightly odd-looking outline, not as an error.
 *
 * 12 px is deliberately past the ~4 px the shader keeps sub-pixel taps to, because the property
 * under test is coverage, not rim smoothness. The rings are 3 px apart there and the dot is wider
 * than that, so a correct implementation still covers it exactly.
 */
export const SPREAD_THIN_CASE: GlyphCase = {
  text: ".",
  size: 128,
  pixelsPerEm: 96,
  originX: 54,
  originY: 76,
  degrees: 0,
};

/** The spread the thin-feature case is drawn at. Larger than the dot, which is the point. */
export const SPREAD_THIN_PX = 12;

/**
 * A THIRD spread fixture, and the only one that enters `_hb_gpu_slug`'s `ppem < 16` branch.
 *
 * WHY IT HAD TO EXIST. Both cases above draw at 96 px per em, so neither takes that branch — and
 * `hb_gpu_spread_tap` mirrors it, which means every ring tap below ppem 16 is FIVE
 * `_hb_gpu_slug_single` evaluations instead of one. Measured: disabling the branch inside the tap
 * left all thirteen assertions in `glyphPixelXvfb.test.ts` byte-identical (ink 314860, thin 0/600
 * reachable pixels short, darkest 255) while taking S9's `hb-gpu` arm from 12.27 to 70.47 Hz. The
 * suite was blind to a 5.7x change in the shader it exists to guard. `upright14` covers the same
 * branch on the FILL path; nothing covered it on the OUTLINE path.
 *
 * THE GEOMETRY IS S9's, NOT A CONVENIENT ONE: 中 at 14 px per em, rotated 10 degrees, dilated by 3 —
 * which is the consumer's modal `outlinePx` of 6 halved. Rotation is load-bearing twice over. It is
 * what the arm actually draws, and it is what puts ink on edges that are neither horizontal nor
 * vertical: MSAA changes a coverage ESTIMATE, and on an axis-aligned edge the estimate and the
 * analytic answer very nearly agree, so an upright case would under-report the difference it exists
 * to measure. It also lowers the ppem the shader computes — `fwidth` is `|dFdx| + |dFdy|`, so a 10
 * degree rotation costs about a factor of `cos + sin` — which pushes this case further inside the
 * branch (where `smoothstep(16, 8, ppem)` weights the five-tap average more heavily) rather than
 * balancing on its edge.
 *
 * SIZE 128 because it shares one canvas and one renderer with the two cases above, exactly as the
 * thin case does. A 14 px glyph grown by 3 is a ~20 px blob in a 128 px frame, so a whole-frame RMS
 * would be dominated by empty background — this file's own header says a COMPLETELY destroyed 14 px
 * glyph reads 6.74 against a mostly blank reference. The assertion is therefore restricted to the
 * reference's RIM, which is where a coverage estimator can differ at all.
 */
export const SPREAD_LOWPPEM_CASE: GlyphCase = {
  text: "中",
  size: 128,
  pixelsPerEm: 14,
  originX: 57,
  originY: 70,
  degrees: 10,
};

/** The spread the low-ppem case is drawn at: S9's modal `outlinePx` of 6, halved. */
export const SPREAD_LOWPPEM_PX = 3;

/**
 * The geometry the CONTRAST probe draws: a Latin "B" at 20 px per em, twenty-five times.
 *
 * IT IS THE CONSUMER'S CASE, NOT A CONVENIENT ONE. The measurement that opened this round was a
 * fixed crop of the word "Breakthrough" at 1600x900 and DPR 1.25, where 16 CSS px of body text is
 * exactly **20 device px per em**. `smoothstep (8, 48, ppem)` still weights the correction at ~78%
 * of full strength there, and 20 px is where the gap being closed was measured — a fixture at some
 * other size would be a different claim wearing this one's numbers.
 *
 * LATIN, NOT THE HAN THE REST OF THIS FILE USES, and it was measured before it was chosen. The
 * assertions are about the TOP of the coverage ramp, and 中 does not have one at these sizes: at 14
 * px per em its peak coverage over 2000 partially covered pixels is **106 of 255**, so a Han
 * fixture would be asserting about a distribution that never reaches the region under test. That is
 * a real finding about the mechanism and it is why `upright14` exists; it just makes 中 the wrong
 * glyph here. A "B" at 20 px per em has stems near two device pixels wide, so it has both a genuine
 * saturated core and a genuine ramp: measured, 1750 ramp pixels peaking at 223.
 *
 * TWENTY-FIVE OF THEM BECAUSE THE ASSERTIONS ARE COUNTS. `hb_gpu_stem_darken` is the identity at
 * coverage 0 and 1, so the only pixels it can move are the ramp — about seventy per glyph. A claim
 * of the form "the deep end gained N%" over seventy pixels is a claim about a handful of them.
 *
 * UPRIGHT, unlike the low-ppem spread case: rotation lowers the ppem the shader computes and would
 * make the exact exponent a function of the fixture's angle for no gain. The polarity and the size
 * ramp are what is under test, not a rim.
 *
 * The pitch clears the glyph: a "B" at 20 px per em is ~13 px wide and ~14 tall, and 22 px of pitch
 * keeps every cell's antialiased rim to itself, so a per-pixel comparison is never between two
 * glyphs.
 */
export const CONTRAST_CASE: GlyphCase = {
  text: "B",
  size: 128,
  pixelsPerEm: 20,
  // The first pen. The rest of the grid steps from here — see {@link contrastPens}.
  originX: 6,
  originY: 20,
  degrees: 0,
};

/**
 * The spread the contrast probe's OUTLINE frames are drawn at: S9's modal `outlinePx` of 6, halved,
 * exactly as {@link SPREAD_LOWPPEM_PX} is.
 *
 * IT IS THE SAME NUMBER AS `SPREAD_LOWPPEM_PX` AND IT IS STATED SEPARATELY ON PURPOSE. That one is
 * the radius of a rotated 中 at 14 px per em; this one is the radius of an upright "B" at 20. They
 * agree because both come from the consumer's `outlinePx` 6 and Godot's `outline_size / 4`, not
 * because one is the other — and a future case that needed a different radius here should not have
 * to move a constant the MSAA fixture reads.
 *
 * WHY THE CONTRAST PROBE NEEDED ONE AT ALL. Every frame this probe captured used to be drawn at
 * spread 0, so the shipped contrast curve had NO fixture on a dilated frame — the gap that let a
 * correction calibrated for a fill's coverage ramp ship on an outline's rim, where Godot has no
 * curve at all. `CONTRAST_CASE`'s pitch (22 px, for a ~13x14 px glyph) still clears a 3 px dilation
 * on every side with a pixel to spare, so the outline frames stay one glyph per cell.
 */
export const CONTRAST_OUTLINE_PX = 3;

/** Cells per side and the pitch between them, in device px. */
const CONTRAST_GRID = 5;
const CONTRAST_PITCH = 22;

/**
 * The pen positions the contrast probe draws {@link CONTRAST_CASE} at, on the baseline.
 *
 * A function rather than a constant so both halves compute the same list from the same two numbers
 * — the node side reports the glyph count, the page side draws them, and a literal array copied
 * into either one is a list that can drift.
 */
export function contrastPens(): [number, number][] {
  const pens: [number, number][] = [];
  for (let row = 0; row < CONTRAST_GRID; row += 1) {
    for (let column = 0; column < CONTRAST_GRID; column += 1) {
      pens.push([
        CONTRAST_CASE.originX + column * CONTRAST_PITCH,
        CONTRAST_CASE.originY + row * CONTRAST_PITCH,
      ]);
    }
  }
  return pens;
}

/**
 * One case of the GODOT REFERENCE GOLDEN: a single glyph, dilated by a known radius, drawn once by
 * Godot and once by this package so the two can be put in one table.
 *
 * `GlyphCase` is not reused because this shape carries the two numbers that only exist when there
 * is an engine on the other side — the Godot `outline_size` that produces `spreadPx`, and whether
 * the feature is round enough for the radial metric — and because every case here is upright by
 * construction (see {@link GODOT_OUTLINE_CASES}).
 */
export interface GodotOutlineCase {
  /** Stable key. Appears in the golden JSON, the GDScript manifest and the test's log lines. */
  name: string;
  /** The single character drawn. */
  text: string;
  /** Cell side, device px, square. Both engines render this case into a box of this size. */
  size: number;
  /**
   * Device px per em.
   *
   * GODOT'S `font_size` IS THIS NUMBER, and only because oversampling is pinned to 1. Godot 4.5
   * multiplies a font size by the viewport's oversampling before rasterising, so at the default
   * (which follows the content scale) `font_size` and device ppem are different numbers that
   * happen to agree on a 1:1 window. `outline_ref.gd` calls `set_oversampling_override(1.0)` and
   * passes `oversampling` 1.0 to every draw call, and records both back in the golden.
   */
  pixelsPerEm: number;
  /** Pen origin inside the cell, on the baseline. WHOLE PIXELS — see {@link GLYPH_CASES}. */
  originX: number;
  originY: number;
  /** The dilation radius in device px: `setSpread` on our side, `outline_size / 4` on Godot's. */
  spreadPx: number;
  /**
   * Godot's `draw_char_outline` size argument.
   *
   * FOUR TIMES THE RADIUS, which is settled rather than fitted: Godot's stroker takes
   * `outline_size / 4` as its radius, so an `outline_size` of 12 grows the glyph by 3 device px.
   * It is stated as its own field rather than derived at the call site so the golden records the
   * number Godot was actually given, which is the one a reader reproducing this needs.
   */
  outlineSize: number;
  /**
   * Ask for the radial metrics (reach, scallop, 16-cycle amplitude) as well as the gradient one.
   *
   * TRUE ONLY FOR THE ROUND, ISOLATED CASES. The radial form casts rays from the coverage centroid
   * and takes the OUTERMOST crossing, which on a 中 or a "B" leaves through whichever stroke the
   * ray happens to meet — `r50Stdev` would then be measuring the glyph's silhouette rather than
   * its rim. The three dots are the cases where "how far does the dilation reach, and how round is
   * it" is a question with an answer.
   */
  radial: boolean;
}

/**
 * The six cases the Godot golden is built from, and where their sizes come from.
 *
 * MEASURED ON THE LIVE PRODUCT, not chosen. `window.__mirrorCanvasStats()` on the deployed game at
 * `:13337` (`?stage=canvas&textCanvas=plain`, DPR 1) reports the glyph pass drawing 3870 glyphs
 * with 567 of 1314 runs under the ppem-16 fidelity floor, and `packages/canvas`'s own once-per-page
 * warning names the sizes exactly: runs at **12.8 and 15.0 device ppem** on a 1280 px stage whose
 * fit scale the client logs as 0.534. That makes the scene's two modal label sizes 24 and 28 DESIGN
 * px, and device ppem is `designPx * fitScale * DPR`:
 *
 *   1280 px window, DPR 1   fit 0.534   -> 12.8 and 15.0   (han-desktop, at 14, sits between them)
 *   1920 px window, DPR 1   fit 0.80    -> 19.2 and 22.5   (latin-desktop, at 20)
 *   the phone, DPR 3.49     fit*DPR 1.75 -> 43 and 49      (han-phone, at 49)
 *
 * That last product is the same 1.75 that turns the consumer's modal `outlinePx` of 6 into the
 * ~10.5 device px radius `han-phone` carries, so the two halves of the phone row are one
 * measurement rather than two guesses.
 *
 * UPRIGHT, EVERY ONE, unlike `SPREAD_LOWPPEM_CASE`. Rotation is load-bearing there because MSAA
 * changes a coverage estimate and an axis-aligned edge under-reports it. Here the arms are two
 * different ENGINES, and a rotation would add Godot's own transform-snapping settings
 * (`snap_2d_transforms_to_pixel`) to the list of things a disagreement could mean.
 *
 * THE THREE DOTS ARE THE ONLY CASES THAT CAN ANSWER "HOW ROUND IS THE DILATION". `dot-radial` at
 * radius 4 is inside what the shader's tap set tiles; `dot-radial-wide` at radius 12 is the
 * sparse-covering regime `SPREAD_THIN_CASE` records as an open defect, and it is the one whose
 * 16-cycle amplitude Stage 2 has to move. `dot-radial-live-max` at radius 14 is the LIVE WORST CASE
 * and it is the one a two-pass decision is made on — see its own comment.
 *
 * PENS PUT EACH GLYPH IN THE MIDDLE OF ITS OWN CELL, at whole pixels, computed once from the face's
 * real extents (upem 1000; 中 spans x 0.105-0.890 em and y -0.068-0.831 em, "B" x 0.110-0.582 and y
 * 0-0.726, "." x 0.075-0.156 and y -0.013-0.075). The worst case, `han-phone`, reaches 34.7 to 96.8
 * px inside a 128 px cell — over 30 px of background on every side, which the radial metric needs
 * because its rays run to the cell's corner.
 */
export const GODOT_OUTLINE_CASES: readonly GodotOutlineCase[] = [
  {
    name: "han-desktop",
    text: "中",
    size: 128,
    pixelsPerEm: 14,
    originX: 57,
    originY: 69,
    spreadPx: 3,
    outlineSize: 12,
    radial: false,
  },
  {
    name: "han-phone",
    text: "中",
    size: 128,
    pixelsPerEm: 49,
    originX: 40,
    originY: 83,
    spreadPx: 10.5,
    outlineSize: 42,
    radial: false,
  },
  {
    name: "latin-desktop",
    text: "B",
    size: 128,
    pixelsPerEm: 20,
    originX: 57,
    originY: 71,
    spreadPx: 3,
    outlineSize: 12,
    radial: false,
  },
  {
    name: "dot-radial",
    text: ".",
    size: 128,
    pixelsPerEm: 49,
    originX: 58,
    originY: 66,
    spreadPx: 4,
    outlineSize: 16,
    radial: true,
  },
  {
    name: "dot-radial-wide",
    text: ".",
    size: 128,
    pixelsPerEm: 96,
    originX: 53,
    originY: 67,
    spreadPx: 12,
    outlineSize: 48,
    radial: true,
  },
  /**
   * THE LIVE WORST CASE, AND IT SITS OUTSIDE EVERY OTHER ROW OF THIS GOLDEN.
   *
   * MEASURED ON THE RUNNING GAME, not extrapolated. Its outline strokes are three CSS widths —
   * `outlinePx` **6, 7.5 and 8** — and the phone renders them at DPR 3.4876, so the DEVICE radii the
   * dilation is actually asked for are **10.5, 13.1 and 14.0 px**. `han-phone` covers the first of
   * those and `dot-radial-wide` at 12 sits between the first and the second; NOTHING covered the
   * third. A tap set is judged by the arc between its outermost taps, which grows with the radius,
   * so grading the redistribution at 12 and shipping it at 14 is grading the easier end of the
   * range. This case is the hard end: 14.0 device px, the largest radius the product asks for.
   *
   * AND IT IS THE ROW A TWO-PASS DECISION TURNS ON. "Is the redistributed single-pass tap set good
   * enough at live radii, or does the product need a second dilation pass" is a question about the
   * scallop at the radius the phone draws — not about the one this file happened to fixture first.
   *
   * GEOMETRY IS `dot-radial-wide`'s, AND DELIBERATELY SO: same glyph, same ppem, same cell, same
   * pen, and only `spreadPx` moves. That makes the pair a controlled comparison in the radius alone
   * rather than two fixtures whose difference could be the ppem or the phase. The pen comes from the
   * face extents exactly as the paragraph above computes them: "." spans x 0.075-0.156 em and y
   * -0.013-0.075, so at ppem 96 it is 7.78 x 8.45 px — a dot radius of ~3.89 — and centring it in a
   * 128 px cell puts the pen at (52.91, 66.98), i.e. (53, 67) at whole pixels.
   *
   * THE CELL STILL CLEARS THE DILATION WITH ROOM TO SPARE, which the radial metric requires because
   * its rays run to the cell's corner. Reach is `3.89 + 14 = 17.9 px` on the wide axis and 18.2 on
   * the tall one, against a centre at ~64: over 45 px of background on all four sides.
   */
  {
    name: "dot-radial-live-max",
    text: ".",
    size: 128,
    pixelsPerEm: 96,
    originX: 53,
    originY: 67,
    spreadPx: 14,
    outlineSize: 56,
    radial: true,
  },
];

/**
 * The rotation, as the object-space 2x3 `[xx, xy, yx, yy, tx, ty]` that `setModel` takes:
 * `x' = xx*x + yx*y + tx`, `y' = xy*x + yy*y + ty`. Same order as the repo's `Transform2D`.
 *
 * ABOUT THE BUFFER'S CENTRE, not the glyph's, and computed here rather than on each side: the node
 * reference applies the identical expression, so any disagreement about the pivot would show up as
 * a displacement — and `registrationPx` would then report a broken pipeline instead of the
 * arithmetic difference it actually is.
 */
export function modelFor(item: GlyphCase): number[] {
  const radians = (item.degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const c = item.size / 2;
  return [
    cos,
    sin,
    -sin,
    cos,
    c - (cos * c - sin * c),
    c - (sin * c + cos * c),
  ];
}
