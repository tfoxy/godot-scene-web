import {
  acutanceOf,
  boxDownsample,
  registrationPx,
  rms,
} from "../../../scripts/test-support/text-image-metrics";
// The text-fidelity probe: what "crisp" is worth as a number, and which arm shimmers.
//
//   xvfb-run -a mise exec -- pnpm -w run text:fidelity -- --headed
//   mise exec -- pnpm -w run text:fidelity                       # headless, SwiftShader
//   mise exec -- pnpm -w run text:fidelity -- --dpr 3.4876        # the phone's raster scale
//
// A PROBE, NOT A SCENARIO. No trace, no frame rate, no `perf-report/1` envelope — the same rule
// the bake probe states. It answers a question the perf table structurally cannot: the table can
// say an arm is cheap, and an arm that renders mush is very cheap indeed.
//
// THE TWO METRICS THAT MATTER, and why they need no cross-arm reference:
//
//   * `acutance` — mean |gradient of the green channel| over the inked box, normalised by total
//     ink. Blur lowers it. It is reported against a `reference` arm (the same run drawn at 8x and
//     box-downsampled here in node) so there is a CEILING to read it against rather than only an
//     ordering between arms.
//   * `shimmer` — the coefficient of variation of total ink across K sub-pixel translations of the
//     SAME text. A rasterizer that re-renders in screen space reads ~0; one that bilinearly samples
//     a fixed atlas breathes as the sampling phase drifts. This is the metric that captures the
//     actual complaint — small rotated CJK that crawls while it moves — and nothing else in this
//     repo measures it.
//
// EVERY METRIC READS ONE CHANNEL, AND THAT CHANNEL IS GREEN — not a luma over all three. `dom` is
// the only arm Chrome draws with LCD subpixel antialiasing, so it is the only arm whose stills are
// coloured, and averaging R, G and B on such a still is a ~1 px horizontal box blur that was being
// charged to the `dom` MECHANISM. Green samples coverage at the pixel centre for every arm on the
// same terms, and is bit-identical to luma on the seven greyscale arms. See {@link lumaOf} for the
// measurements, and for the fix that was rejected.
//
// A per-pixel diff against the reference is computed too, and reported LAST and hedged: two
// rasterizers disagree about hinting and stem darkening long before they disagree about blur, so
// RMS-vs-reference ranks hinting policy, not crispness. The existing parity suite already budgets
// `maxDiffRatio: 0.12` for exactly that reason.
//
// EVERY PIXEL COMES FROM A COMPOSITOR SCREENSHOT. Never a canvas readback: `getImageData` on an
// accelerated 2D canvas returns alpha 0 on the headed-Xvfb rung (docs/perf-harness.md), which would
// silently score every canvas arm as a blank page.
//
// EVERY OFFSET IS KEPT, not just the first: `<arm>-<0..7>.png` beside `<arm>.png`, and the
// reference is re-rendered at each offset as `reference-<0..7>.png`. The numbers below summarise a
// sweep, and a summary of a sweep is exactly the thing a reader cannot check by eye against one
// still. `text:report` builds its flip and diff views out of these files; the paths land in each
// row's `stills`.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ensureCjkFont } from "../../../scripts/ensure-cjk-font";
import { ensureLatinBenchFont } from "../../../scripts/ensure-latin-font";
import { openLocalBrowser } from "../src/browser";
import { renderGodotStills } from "../src/godot-text-bench";
import { HB_GPU_NOT_BUILT, hbGpuIsBuilt } from "../src/hb-gpu-build";
import {
  HB_GPU_GLUE_URL,
  HB_GPU_WASM_URL,
  LATIN_PANGRAM,
  LATIN_PANGRAM_EM_WIDTH,
  RUN_GAP,
  scriptKinds,
  type TextRunKind,
} from "../src/scenarios";
import {
  bundleBrowserModule,
  HARFBUZZ_WASM_PATH,
  readHarfBuzzWasm,
  readHbGpuBuild,
} from "../src/serve";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../..");

/** Sub-pixel offsets the same run is drawn at. Irrational-ish, so no two share a phase. */
const SHIMMER_OFFSETS = [0, 0.618, 1.236, 1.854, 2.472, 3.09, 3.708, 4.326];
const SUPER_SAMPLE = 8;

/**
 * The browser arms, graded in this order.
 *
 * The candidate arms are here rather than measured only by S9 for one reason: a baked atlas is the
 * kind of arm that picks up a half-pixel offset and then reports a flattering `rmsVsReference` for
 * it. `alignmentPx` is the guard, and an arm that is not in this list is not guarded. See the
 * "Every arm anchors the same baseline" section of docs/text-rendering.md.
 *
 * `hb-gpu` IS CONDITIONAL, and it is the only one that is. Its wasm is a docker + emscripten build
 * output under a gitignored `dist/`, so a fresh checkout cannot render it — and the probe SKIPS it
 * with a stated reason rather than emitting a row of zeros, which would read as an arm with no ink
 * and therefore no blur. See {@link armsFor}.
 */
const BROWSER_ARMS = ["dom", "canvas2d", "hb-atlas", "hb-run"] as const;

/** The arms this checkout can actually render, plus whatever it cannot and why. */
async function armsFor(): Promise<{
  arms: string[];
  missing: { what: string; command: string }[];
}> {
  if (await hbGpuIsBuilt()) {
    return { arms: [...BROWSER_ARMS, "hb-gpu"], missing: [] };
  }
  return { arms: [...BROWSER_ARMS], missing: [HB_GPU_NOT_BUILT] };
}

/** One run of the probe's page: a script, a face, and where its un-rotated box sits in the box. */
export interface FidelityRun {
  kind: TextRunKind;
  text: string;
  /** The `@font-face` family this run is set in — the two scripts are two faces. */
  fontFamily: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The rows of the image one run's metrics are computed over.
 *
 * BANDS EXIST BECAUSE ONE ACUTANCE OVER TWO SCRIPTS IS A NUMBER ABOUT NEITHER. Han at 14 px is
 * dense, high-contrast, mostly-horizontal strokes; Latin is open, curved and half the ink. Their
 * mean is not a property any rasterizer has, and it would move whenever the mix moved — so an arm
 * that improved on Latin and regressed on Han would read as unchanged.
 */
export interface FidelityBand {
  kind: TextRunKind;
  /** Row range, in box px, half-open. */
  y0: number;
  y1: number;
}

export interface FidelitySpec {
  runs: FidelityRun[];
  fontSize: number;
  rotationDeg: number;
  box: { width: number; height: number };
  superSample: number;
  dx: number;
  dy: number;
  /**
   * Px from the run box's TOP EDGE to the alphabetic baseline. Every arm anchors here.
   *
   * Not a cosmetic choice — the number that makes the per-pixel columns mean anything. Left to
   * their own conventions the arms drew the same run in three different places: canvas
   * `textBaseline: "top"` pins the em top, a CSS line box puts the baseline at half-leading +
   * ascent, and Godot's Label uses its own ascent. The dom arm landed 2.35 px low, which is a
   * translation, and `rmsVsReference` and the viewer's diff images scored it as a rasterizer
   * difference. See {@link ArmFidelity.alignmentPx}, which exists so this cannot silently return.
   *
   * The value is `fontSize`: one documented rule, checkable by hand, leaving 4.9 px of the 18.9 px
   * box for descenders — enough for both faces (Roboto's is 0.244 em, 3.4 px). It is NOT read from
   * a font table: the Han fixture's own tables disagree by 45% and predict half-leadings of
   * opposite sign, and Roboto's answer is a third number. Each arm is asked where ITS baseline is.
   */
  baseline: number;
  /** `hb-atlas`: pre-baked sub-pixel offsets per glyph, as a square grid. Mirrors S9's `phases`. */
  phases?: number;
  /** `hb-*`: bake the rotation into the pixels. `false` is the conventional upright atlas. */
  bakeRotation?: boolean;
  /** `hb-*`: `harfbuzz` or `fillText` — isolates baking from shaping. Mirrors S9's `bakeShaper`. */
  bakeShaper?: string;
}

export interface ArmFidelity {
  arm: string;
  /** Which run's rows these numbers describe. See {@link FidelityBand}. */
  band: TextRunKind;
  /** Mean |grad green| per unit ink. Higher is crisper; the `reference` arm is the ceiling. */
  acutance: number;
  /**
   * Coefficient of variation of TOTAL INK across the sub-pixel offsets.
   *
   * Reported, but read `edgeShimmer` first. Total coverage is CONSERVED by any rasterizer that
   * computes exact area coverage — translating a shape sub-pixel does not change its area — so a
   * reading of 0 says "coverage is conserved", which is good but is not the question. The crawl
   * this round is about is ink moving BETWEEN pixels, which leaves the total untouched.
   */
  shimmer: number;
  /**
   * Coefficient of variation of ACUTANCE across the sub-pixel offsets: does the glyph's edge
   * structure hold still as it moves?
   *
   * This is the one that sees the crawl. Stems that snap on and off the pixel grid change edge
   * contrast without changing total coverage, so this moves where `shimmer` cannot.
   */
  edgeShimmer: number;
  /** Mean green over the box — how much ink the arm lays down at all. */
  meanInk: number;
  /** RMS green difference from the downsampled reference. Ranks hinting, not blur — see the header. */
  rmsVsReference: number;
  samples: number;
  /**
   * Repo-relative path to every offset's still, in offset order.
   *
   * The stills are what `text:report` builds its flip and diff views out of, so the probe publishes
   * WHERE they are rather than letting a reader reconstruct filenames — the browser arms write into
   * the probe's own out dir and the Godot arms write into the Godot bench's stills dir, and a
   * reader that guessed would silently show the wrong arm's pixels.
   */
  stills?: string[];
  /** Per-offset total ink. Published so a shimmer of exactly 0 can be checked, not just believed. */
  inkSamples?: number[];
  /** Per-offset ink centroid in x. See {@link subpixelTravel}. */
  centroidSamples?: number[];
  /** Per-offset ink centroid in y. The axis the sweep does NOT move along — see {@link alignmentPx}. */
  centroidYSamples?: number[];
  /**
   * Mean px this arm has to be MOVED to land on the reference, per offset, by correlation. See
   * {@link registrationPx}. `rmsVsReference` and the diff images are only about rasterization while
   * this is under {@link ALIGNMENT_TOLERANCE_PX}; above it they are mostly a picture of the offset.
   */
  alignmentPx?: number;
  /**
   * The value of {@link alignmentPx} above which THIS arm is misaligned.
   *
   * Per arm rather than one number for the table, because the allowance includes a correction for
   * the arm's own blur — see {@link alignmentAllowanceFor}. Published so the viewer applies the
   * same threshold the run did instead of recomputing it from a reader-side constant.
   */
  alignmentAllowancePx?: number;
  /**
   * How far the ink centroid actually moved, as a fraction of how far it was ASKED to move.
   *
   * The check that turns a shimmer of 0 from a claim into a fact. Three outcomes, three different
   * meanings, and an ink-only metric cannot tell them apart:
   *   ~1  the arm really translated by the sub-pixel amount, and a flat ink total then means its
   *       antialiasing conserves coverage — the ideal;
   *   ~0  the arm did not move at all, i.e. the offset never reached it (a probe bug, not a result);
   *   in between, in steps — the arm SNAPPED the translation to whole pixels, which is stable but
   *   quantises motion.
   */
  subpixelTravel?: number;
  /** RMS px the centroid strays from the straight-line fit. ~0.29 means whole-pixel snapping. */
  subpixelResidualPx?: number;
}

/** Clear space around the stacked runs, in px. Also what keeps the bands off the image edges. */
const PROBE_MARGIN = 20;

export interface ProbeLayout {
  box: { width: number; height: number };
  runs: FidelityRun[];
  bands: FidelityBand[];
}

/**
 * Where the probe's runs go, and which rows belong to each — pure, so a test can check the bands
 * do not overlap without a browser.
 *
 * Stacked by ROTATED height, exactly as S9 stacks a cell's two runs, with the same
 * {@link RUN_GAP} between them. The band boundaries then fall in that gap, half of it to each side,
 * so every pixel of a run's ink is inside its own band and no pixel is in both. Overlapping bands
 * would make each script's acutance quietly include some of the other's edges.
 */
export function probeLayout(options: {
  script: string;
  chars: number;
  fontSize: number;
  rotationDeg: number;
}): ProbeLayout {
  const { chars, fontSize, rotationDeg } = options;
  const radians = (rotationDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const height = fontSize * 1.35;

  const boxes = scriptKinds(options.script).map((kind) => {
    const width =
      kind === "han" ? chars * fontSize : LATIN_PANGRAM_EM_WIDTH * fontSize;
    const text =
      kind === "han"
        ? // Deterministic, and drawn from the same pool the scenario uses.
          Array.from({ length: chars }, (_, i) =>
            String.fromCodePoint(0x4e00 + ((i * 977) % 3000)),
          ).join("")
        : LATIN_PANGRAM;
    return {
      kind,
      text,
      fontFamily: PROBE_FONT_FAMILIES[kind],
      width,
      height,
      aabbWidth: width * cos + height * sin,
      aabbHeight: width * sin + height * cos,
    };
  });

  const stackHeight =
    boxes.reduce((sum, box) => sum + box.aabbHeight, 0) +
    RUN_GAP * (boxes.length - 1);
  const box = {
    width:
      Math.ceil(Math.max(...boxes.map((b) => b.aabbWidth))) + PROBE_MARGIN * 2,
    height: Math.ceil(stackHeight) + PROBE_MARGIN * 2,
  };

  // EVERY RUN BOX STARTS ON A WHOLE PIXEL. Not cosmetic: the `dom` arm snaps its text origin to
  // whole device pixels (its 0.27 px centroid residual is that snap), so a run parked at a
  // half-pixel rest position picks up a systematic half-pixel offset from the reference — measured
  // at 0.51 px in both bands, which the alignment guard correctly flagged and which has nothing to
  // do with the mechanism. The SWEEP is where sub-pixel phases are exercised; the rest position is
  // not the place to introduce one.
  const runs: FidelityRun[] = [];
  const spans: { top: number; bottom: number }[] = [];
  let cursor = PROBE_MARGIN;
  for (const entry of boxes) {
    const runTop = Math.round(cursor + (entry.aabbHeight - entry.height) / 2);
    const centreY = runTop + entry.height / 2;
    runs.push({
      kind: entry.kind,
      text: entry.text,
      fontFamily: entry.fontFamily,
      left: Math.round(box.width / 2 - entry.width / 2),
      top: runTop,
      width: entry.width,
      height: entry.height,
    });
    spans.push({
      top: centreY - entry.aabbHeight / 2,
      bottom: centreY + entry.aabbHeight / 2,
    });
    cursor += entry.aabbHeight + RUN_GAP;
  }

  // ONE ROUNDED BOUNDARY PER GAP, shared by the bands on either side. Rounding each band's own
  // edges outward instead would make consecutive bands overlap by up to a pixel — a row of Han
  // counted in the Latin acutance and vice versa, which is exactly what banding exists to stop.
  const bands: FidelityBand[] = boxes.map((entry, index) => ({
    kind: entry.kind,
    y0:
      index === 0
        ? Math.max(0, Math.floor(spans[0].top - RUN_GAP / 2))
        : Math.round((spans[index - 1].bottom + spans[index].top) / 2),
    y1:
      index === boxes.length - 1
        ? Math.min(box.height, Math.ceil(spans[index].bottom + RUN_GAP / 2))
        : Math.round((spans[index].bottom + spans[index + 1].top) / 2),
  }));
  return { box, runs, bands };
}

/** The `@font-face` families the probe's page installs, one per script. */
const PROBE_FONT_FAMILIES: Record<TextRunKind, string> = {
  han: "NotoSansSC-probe",
  latin: "Roboto-probe",
};

/** One band's rows as a standalone image, so every metric below works on it unchanged. */
export function cropBand(
  image: { data: Uint8Array; width: number; height: number },
  band: { y0: number; y1: number },
): { data: Uint8Array; width: number; height: number } {
  const y0 = Math.max(0, Math.min(image.height, Math.floor(band.y0)));
  const y1 = Math.max(y0, Math.min(image.height, Math.ceil(band.y1)));
  return {
    data: image.data.subarray(y0 * image.width, y1 * image.width),
    width: image.width,
    height: y1 - y0,
  };
}

/**
 * Ratio of measured centroid travel to requested travel across the offset sweep.
 *
 * Least-squares slope of centroid against requested offset, which is robust to the centroid also
 * being pulled by the box edges.
 */
export function subpixelTravel(centroids: readonly number[]): number {
  return centroidFit(centroids).slope;
}

/**
 * Least-squares fit of measured centroid against requested offset, and the RMS residual around it.
 *
 * THE SLOPE ALONE CANNOT TELL SUB-PIXEL MOTION FROM INTEGER SNAPPING, and reading it as if it
 * could produced a wrong and flattering conclusion. An arm that rounds every translation to a whole
 * pixel still tracks the request ON AVERAGE, so its slope is ~1 — identical to an arm that really
 * moves sub-pixel. What separates them is the RESIDUAL: rounding leaves a sawtooth of up to half a
 * pixel (RMS ~0.29 px for a uniform phase sweep), true sub-pixel motion leaves ~0.
 *
 * This is what turns "the dom arm has zero shimmer" from a compliment into a diagnosis: an arm that
 * snapped cannot shimmer, and it cannot move smoothly either.
 */
export function centroidFit(centroids: readonly number[]): {
  slope: number;
  residualPx: number;
} {
  const n = Math.min(centroids.length, SHIMMER_OFFSETS.length);
  if (n < 2) {
    return { slope: 0, residualPx: 0 };
  }
  const xs = SHIMMER_OFFSETS.slice(0, n);
  const ys = centroids.slice(0, n);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  const intercept = meanY - slope * meanX;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += (ys[i] - (slope * xs[i] + intercept)) ** 2;
  }
  return { slope, residualPx: Math.sqrt(sum / n) };
}

/**
 * Acutance and total ink for one grayscale image.
 *
 * Normalising the gradient sum by the ink sum is what makes the number comparable between arms that
 * lay down different amounts of ink: a heavier rasterizer has more edge pixels AND more interior
 * pixels, and an unnormalised gradient sum would score "bolder" as "crisper".
 */
/**
 * How far an arm may sit from the reference before its per-pixel columns stop meaning anything.
 *
 * Calibrated from both ends, on measurements, not picked:
 *
 *   * THE FLOOR IS THE REGISTRATION NOISE. Re-measured at 14 px on both bands, over the 56 ordered
 *     pairs of independently rendered reference stills: mean |error| 0.056 px and worst 0.106 px in
 *     the Han band, 0.017 / 0.036 in the Latin one. A threshold near that would flag arms that are
 *     provably aligned.
 *   * THE CEILING IS THE BUGS IT EXISTS TO CATCH: the dom arm's CSS half-leading anchor (2.35 px),
 *     Godot's clamped-`size` pivot (4.20 px), the baked atlas's phase-offset-on-an-unsnapped draw
 *     (0.71 px) and a run parked at a half-pixel rest position (0.51 px). All four are well clear.
 *
 * 0.25 px is more than twice the worst noise and a third of the smallest bug found so far. At 14 px
 * it passes the shipped `dom` path at 0.314 px against its own blur allowance of 0.361 — CSS
 * whole-pixel snapping, real but not a defect — and flags `godot-msdf` at 0.634 px in the Han band,
 * whose distortion of 0.030 buys it almost no allowance.
 */
export const ALIGNMENT_TOLERANCE_PX = 0.25;

/**
 * Extra allowance per unit of `distortion`, for arms BLURRIER than the reference.
 *
 * Not a fudge factor — a measured correction for the one bias {@link registrationPx} has. Softening
 * a band of a reference still with a separable gaussian, to known distortions, at 14 px:
 *
 *   Han   0.311 -> 0.212 px (0.68)   0.571 -> 0.431 px (0.76)   0.728 -> 0.580 px (0.80)
 *   Latin 0.228 -> 0.170 px (0.74)   0.440 -> 0.347 px (0.79)   0.622 -> 0.502 px (0.81)
 *
 * The ratio rises with the distortion, so a single slope has to be chosen for the range the arms
 * actually occupy (0.015-0.40). 0.65 is the low end of that, deliberately: this is an ALLOWANCE, and
 * an over-generous one silences the guard on exactly the soft arms it is watching.
 *
 * Without it the guard flags the wrong arms. At a flat 0.25 px it flagged `dom` (0.306) and
 * `godot-default` (0.330), whose distortions of 0.158 and 0.264 account for 0.10 and 0.17 px of
 * that on their own, while the arm that is genuinely displaced — `godot-msdf`, 0.517 px at a
 * distortion of 0.016, so essentially no allowance — sat in the same list. A guard that cries wolf
 * on two arms out of three is a guard that gets ignored.
 *
 * ONLY FOR BLURRIER ARMS. The bias comes from normalized correlation preferring the smoothing that
 * fractional sampling introduces, which only helps an arm that is already soft. `godot-oversample`
 * is SHARPER than the reference (acutance 2.23 against 1.87) and registers at 0.007 px — no
 * allowance is warranted and none is given.
 */
export const ALIGNMENT_BLUR_ALLOWANCE_PER_DISTORTION = 0.65;

/** The distance above which THIS arm is misaligned: the floor, plus its own measured blur bias. */
export function alignmentAllowanceFor(
  acutance: number | undefined,
  referenceAcutance: number | undefined,
): number {
  if (
    typeof acutance !== "number" ||
    typeof referenceAcutance !== "number" ||
    !(referenceAcutance > 0) ||
    // Sharper than the reference, or equal: no smoothing preference to correct for.
    acutance >= referenceAcutance
  ) {
    return ALIGNMENT_TOLERANCE_PX;
  }
  const distortion = 1 - acutance / referenceAcutance;
  return (
    ALIGNMENT_TOLERANCE_PX +
    ALIGNMENT_BLUR_ALLOWANCE_PER_DISTORTION * distortion
  );
}

/** How far the correlation search looks, in px. Bigger than any misalignment yet seen, by 2x. */
/** Mean registration distance over the sweep — each offset against the reference AT THAT OFFSET. */
export function alignmentPx(
  arms: readonly { data: Uint8Array; width: number; height: number }[],
  references: readonly { data: Uint8Array; width: number; height: number }[],
): number {
  const n = Math.min(arms.length, references.length);
  if (n === 0) {
    return Number.NaN;
  }
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += registrationPx(arms[i], references[i]).distance;
  }
  return sum / n;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Write one still and hand back the repo-relative path that goes into the JSON. */
async function writeStill(
  dir: string,
  name: string,
  png: Buffer,
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, png);
  return relative(REPO_ROOT, path);
}

export function coefficientOfVariation(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) {
    return 0;
  }
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Remove the page background before anything is measured.
 *
 * NOT cosmetic. The stage is `#101014`, luma ~16, over a box that is ~77% background — so the
 * background contributed ~240k of a ~311k "ink" total. Every ink-derived number was diluted by
 * that constant: `shimmer` read ~4x smaller than the truth, and `travel` read 0.2 for EVERY arm,
 * including Godot's separate process, which is what exposed it. Uniformity across independent
 * rasterizers is the signature of a measurement artefact, not a shared behaviour.
 *
 * The floor is the image's own MEDIAN luma rather than a hardcoded 16: most of the box really is
 * background, and taking it from the image means an arm that renders on a slightly different
 * backdrop still gets its glyphs measured instead of its backdrop.
 */
export function subtractBackground(luma: Uint8Array): {
  data: Uint8Array;
  floor: number;
} {
  const histogram = new Uint32Array(256);
  for (const value of luma) {
    histogram[value] += 1;
  }
  let seen = 0;
  let floor = 0;
  for (let value = 0; value < 256; value += 1) {
    seen += histogram[value];
    if (seen * 2 >= luma.length) {
      floor = value;
      break;
    }
  }
  const out = new Uint8Array(luma.length);
  for (let i = 0; i < luma.length; i += 1) {
    out[i] = luma[i] > floor ? luma[i] - floor : 0;
  }
  return { data: out, floor };
}

/**
 * The single channel every metric in this file is computed on: GREEN, background already removed.
 *
 * THE NAME IS HISTORICAL, THE CHANNEL IS NOT. `luma` is kept because ~40 locals and call sites read
 * it and renaming them buys nothing, but what this returns is band 1 of the still.
 *
 * ONE ARM CARRIES SUBPIXEL ANTIALIASING AND SEVEN DO NOT. Chrome draws the `dom` arm — the shipped
 * CSS-box path — with LCD subpixel AA, so its stills are genuinely coloured: `dom-0.png` has 2980
 * pixels whose channels spread by more than 8, worst 143, e.g. rgba(75,157,218). Every other arm
 * emits greyscale coverage; `canvas2d-0.png`, `hb-atlas-0.png`, `reference-0.png` and the three
 * `godot-*` stills each have 0 such pixels, worst spread 4. Alpha is a uniform 255 throughout, so
 * this is the rasterizer's own output and not a compositing artefact.
 *
 * AVERAGING R, G AND B ON A SUBPIXEL-AA STILL IS A ~1 PX HORIZONTAL BOX BLUR, because the three
 * channels sample the glyph a third of a pixel apart. `sharp().greyscale()` did exactly that, to
 * the one arm that could feel it, and the blur landed in the column that grades the MECHANISM: at
 * offset 0 it published `dom` at a distortion of 0.155 in the Han band where green reads 0.130, and
 * 0.141 in the Latin band where green reads 0.120. ~0.02 of a ~0.17 reading was the measurement.
 *
 * GREEN SAMPLES COVERAGE AT THE PIXEL CENTRE, which is the same question asked of every arm. For
 * the seven greyscale arms it is BIT-IDENTICAL to `greyscale()` — verified over all 256 neutral
 * values, 0 mismatches — so nothing already published moves except the rows that were wrong.
 *
 * REJECTED: disabling subpixel AA on the probe page (`-webkit-font-smoothing: antialiased`). It
 * would make all eight arms greyscale and the choice of channel moot, and it would grade a `dom`
 * arm that gsw does not ship — measuring the shipped CSS-box path is the entire point of the arm.
 * The mechanism keeps its antialiasing; the METRIC stops averaging across it.
 *
 * `extractChannel` yields one band for RGB and RGBA alike, so the returned buffer is
 * `width * height` and every consumer below indexes it unchanged.
 */
export async function lumaOf(png: Buffer): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
  backgroundFloor: number;
}> {
  const { data, info } = await sharp(png)
    .extractChannel(1)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const stripped = subtractBackground(new Uint8Array(data));
  return {
    data: stripped.data,
    width: info.width,
    height: info.height,
    backgroundFloor: stripped.floor,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const dpr = Number(flag("dpr") ?? 1);
  const headed = argv.includes("--headed");
  const outDir = resolve(
    flag("out") ?? join(REPO_ROOT, "artifacts/perf/probes/text-fidelity"),
  );
  const godotDir = resolve(
    flag("godot-dir") ?? join(REPO_ROOT, "artifacts/perf/godot-text"),
  );
  await mkdir(outDir, { recursive: true });

  const [hanFont, latinFont] = await Promise.all([
    ensureCjkFont(REPO_ROOT),
    ensureLatinBenchFont(REPO_ROOT),
  ]);
  const html = await readFile(join(here, "text-fidelity.html"), "utf8");
  const faceBytes: Record<TextRunKind, Buffer> = {
    han: await readFile(hanFont.path),
    latin: await readFile(latinFont.path),
  };
  // The `hb-` arms' bundle and its wasm. Built here rather than checked in so the arm the probe
  // grades is always the current `src/scenarios/text-hb.ts`, and served at the ROOT because the
  // emscripten glue resolves its payload relative to its own `import.meta.url` — see
  // `HARFBUZZ_WASM_PATH`.
  // Which arms this checkout can render, decided BEFORE the browser opens. An arm that cannot be
  // rendered is left out of the sweep and named below the table with the command that builds it —
  // never rendered as a row of zeros, which for a fidelity probe would be a blank still scoring an
  // acutance of 0 and an alignment of NaN.
  const { arms: browserArms, missing: notMeasured } = await armsFor();

  const hbBundle = await bundleBrowserModule(join(here, "text-fidelity-hb.ts"));
  const harfbuzzWasm = await readHarfBuzzWasm();
  // `null` when `packages/hb-gpu/build.sh` has not been run. Not an error: `armsFor` has already
  // left the arm out of the sweep, so these two routes simply do not exist.
  const hbGpu = await readHbGpuBuild();
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path.startsWith("/font.ttf")) {
      res.writeHead(200, {
        "content-type": "font/ttf",
        "cache-control": "no-store",
      });
      res.end(faceBytes.han);
      return;
    }
    if (path.startsWith("/latin.ttf")) {
      res.writeHead(200, {
        "content-type": "font/ttf",
        "cache-control": "no-store",
      });
      res.end(faceBytes.latin);
      return;
    }
    if (path === "/hb.js") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(hbBundle);
      return;
    }
    if (path === HARFBUZZ_WASM_PATH) {
      res.writeHead(200, {
        "content-type": "application/wasm",
        "cache-control": "no-store",
      });
      res.end(harfbuzzWasm);
      return;
    }
    if (path === HB_GPU_WASM_URL && hbGpu) {
      res.writeHead(200, {
        "content-type": "application/wasm",
        "cache-control": "no-store",
      });
      res.end(hbGpu.wasm);
      return;
    }
    if (path === HB_GPU_GLUE_URL && hbGpu) {
      // `text/javascript`: the page reaches this with a dynamic `import()`, and a module served as
      // anything else is refused on MIME type rather than failing to parse.
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(hbGpu.glue);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const fontSize = Number(flag("font-size") ?? 14);
  const chars = Number(flag("chars") ?? 12);
  const rotationDeg = Number(flag("rotation") ?? 10);
  const script = flag("script") ?? "both";
  // A Han run and a Latin run, stacked, each in a band big enough to hold it rotated plus the
  // shimmer travel. `--script han|latin` measures one of them alone.
  const { box, runs, bands } = probeLayout({
    script,
    chars,
    fontSize,
    rotationDeg,
  });
  const baseSpec: Omit<FidelitySpec, "dx" | "dy"> = {
    runs,
    fontSize,
    rotationDeg,
    box,
    superSample: SUPER_SAMPLE,
    baseline: fontSize,
    // The `hb-` arms' isolations, mirrored from S9's parameters of the same names so a fidelity
    // number and a perf number can describe the same configuration.
    phases: Number(flag("phases") ?? 4),
    bakeRotation: flag("bake-rotation") !== "false",
    bakeShaper: flag("bake-shaper") ?? "harfbuzz",
  };

  const browser = await openLocalBrowser({
    artifactsDir: join(REPO_ROOT, "artifacts/perf"),
    headless: !headed,
    deviceScaleFactor: dpr,
    windowSize: {
      width: Math.max(400, box.width * SUPER_SAMPLE),
      height: Math.max(400, box.height * SUPER_SAMPLE),
    },
  });
  console.log(browser.describe);
  const lease = await browser.targets.acquire({
    width: box.width * SUPER_SAMPLE,
    height: box.height * SUPER_SAMPLE,
  });
  const client = browser.client;
  // NO `{ sessionId }` OPTION HERE, and there used to be one. `CdpClient.send`'s `SendOptions` has
  // only `timeoutMs` and `flat`; a `sessionId` key was an excess property that TypeScript never
  // saw (nothing typechecked `probes/` until `packages/hb-gpu`'s tsconfig started pulling this file
  // in) and that `send` never read. Routing is `client.sessionId`, which `targets.acquire` has
  // already set to this lease's session and restores on `release()` — so dropping the key changes
  // nothing at runtime and stops the code claiming a per-call routing it never had.
  const send = <T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ) => client.send<T>(method, params);

  const results: ArmFidelity[] = [];
  const sheet: { name: string; png: Buffer }[] = [];
  // Declared out here rather than beside the reference block: the Godot arms run AFTER the browser
  // is closed, and they need the same per-offset reference stills to be registered against.
  const referenceLumas: Awaited<ReturnType<typeof lumaOf>>[] = [];
  // The ceiling every arm's blur allowance is measured against — see `alignmentAllowanceFor`. PER
  // BAND: Han and Latin have different correct acutances, so one ceiling would make every Latin
  // distortion a statement about Han.
  const referenceAcutance: Partial<Record<TextRunKind, number>> = {};

  /**
   * One arm's rows: the sweep measured once per band, off the same whole-box stills.
   *
   * The stills stay whole-box on purpose — that is what the viewer shows, and a reader has to be
   * able to see both runs in one image — so the banding happens here, on the luma, rather than by
   * screenshotting each run separately.
   */
  const rowsFor = (
    arm: string,
    lumas: readonly Awaited<ReturnType<typeof lumaOf>>[],
    stills: string[],
    options: { rms: boolean },
  ): ArmFidelity[] =>
    bands.map((band) => {
      const cropped = lumas.map((luma) => cropBand(luma, band));
      const references = referenceLumas.map((luma) => cropBand(luma, band));
      const stats = cropped.map((image) =>
        acutanceOf(image.data, image.width, image.height),
      );
      const acutances = stats.map((s) => s.acutance);
      const inks = stats.map((s) => s.ink);
      const centroids = stats.map((s) => s.centroidX);
      const bandArea = box.width * (band.y1 - band.y0);
      const isReference = arm === "reference";
      return {
        arm,
        band: band.kind,
        acutance: mean(acutances),
        shimmer: coefficientOfVariation(inks),
        edgeShimmer: coefficientOfVariation(acutances),
        meanInk: mean(inks) / bandArea,
        rmsVsReference: isReference
          ? 0
          : options.rms
            ? mean(
                cropped.map((image, index) =>
                  rms(image.data, references[index]?.data ?? new Uint8Array()),
                ),
              )
            : Number.NaN,
        samples: lumas.length,
        stills,
        inkSamples: inks,
        centroidSamples: centroids,
        centroidYSamples: stats.map((s) => s.centroidY),
        // 0 by construction for the reference — it is what alignment is measured AGAINST.
        // Published so the column has a visible zero point instead of a hole to interpret.
        alignmentPx: isReference ? 0 : alignmentPx(cropped, references),
        alignmentAllowancePx: isReference
          ? ALIGNMENT_TOLERANCE_PX
          : alignmentAllowanceFor(
              mean(acutances),
              referenceAcutance[band.kind],
            ),
        subpixelTravel: centroidFit(centroids).slope,
        subpixelResidualPx: centroidFit(centroids).residualPx,
      };
    });

  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: box.width * SUPER_SAMPLE,
      height: box.height * SUPER_SAMPLE,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    await new Promise((r) => setTimeout(r, 300));
    await evaluate(send, `window.__textFidelity.installFonts()`);

    const shoot = async (
      arm: string,
      spec: FidelitySpec,
      clip: { width: number; height: number },
    ): Promise<Buffer> => {
      await evaluate(
        send,
        `window.__textFidelity.render(${JSON.stringify(arm)}, ${JSON.stringify(spec)})`,
      );
      const shot = await send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: clip.width, height: clip.height, scale: 1 },
      });
      return Buffer.from(shot.data, "base64");
    };

    // The reference, at EVERY offset: the same geometry at 8x, box-downsampled in node.
    // Downsampling HERE rather than in the page keeps it out of reach of the broken
    // accelerated-canvas readback.
    //
    // PER OFFSET, not once, for three reasons. The viewer's diff view subtracts an arm from the
    // reference at the SAME offset — against a still reference it would render a picture of the
    // translation rather than of the rasterizer. `rmsVsReference` becomes a mean over the sweep
    // instead of one sample. And the reference row earns the same shimmer and travel columns as
    // every other arm, which is the honest floor to read `canvas2d`'s 0.005 edgeShimmer against;
    // its old 0 was structural (one sample cannot vary) and invited being read as a result.
    const referenceStills: string[] = [];
    for (const [index, offset] of SHIMMER_OFFSETS.entries()) {
      const png = await shoot(
        "reference",
        { ...baseSpec, dx: offset, dy: 0 },
        {
          width: box.width * SUPER_SAMPLE,
          height: box.height * SUPER_SAMPLE,
        },
      );
      const raw = await sharp(png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const down = boxDownsample(
        new Uint8Array(raw.data),
        raw.info.width,
        raw.info.height,
        SUPER_SAMPLE,
      );
      const downPng = await sharp(Buffer.from(down.data), {
        raw: { width: down.width, height: down.height, channels: 4 },
      })
        .png()
        .toBuffer();
      referenceStills.push(
        await writeStill(outDir, `reference-${index}.png`, downPng),
      );
      if (index === 0) {
        await writeFile(join(outDir, "reference.png"), downPng);
        sheet.push({ name: "reference (8x downsampled)", png: downPng });
      }
      referenceLumas.push(await lumaOf(downPng));
    }
    // The per-band ceilings, before any arm is scored against them: `alignmentAllowanceFor` needs
    // its band's reference acutance, and `rowsFor` reads it out of this map.
    for (const row of rowsFor("reference", referenceLumas, referenceStills, {
      rms: true,
    })) {
      referenceAcutance[row.band] = row.acutance;
      results.push(row);
    }

    for (const arm of browserArms) {
      const stills: string[] = [];
      const lumas: Awaited<ReturnType<typeof lumaOf>>[] = [];
      for (const [index, offset] of SHIMMER_OFFSETS.entries()) {
        const png = await shoot(arm, { ...baseSpec, dx: offset, dy: 0 }, box);
        lumas.push(await lumaOf(png));
        stills.push(await writeStill(outDir, `${arm}-${index}.png`, png));
        if (index === 0) {
          await writeFile(join(outDir, `${arm}.png`), png);
          sheet.push({ name: arm, png });
        }
      }
      results.push(...rowsFor(arm, lumas, stills, { rms: true }));
    }
  } finally {
    await lease.release().catch(() => {});
    await browser.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }

  // Godot, driven with the SAME runs at the SAME eight sub-pixel offsets — so its acutance and
  // shimmer describe the same glyphs, in the same faces, at the same coordinates as the browser
  // rows, and its shimmer is measured rather than declared unmeasurable.
  if (!argv.includes("--no-godot")) {
    for (const variant of ["default", "msdf", "oversample"] as const) {
      let stills: string[];
      try {
        stills = await renderGodotStills({
          variant,
          viewport: box,
          runs: baseSpec.runs.map((run) => ({
            kind: run.kind,
            left: run.left,
            top: run.top,
            width: run.width,
            height: run.height,
            text: run.text,
          })),
          // One entry per RUN per frame; the runs move together, exactly as they do in S9.
          offsets: SHIMMER_OFFSETS.map((dx) =>
            baseSpec.runs.map(() => ({ x: dx, y: 0 })),
          ),
          fontSize: baseSpec.fontSize,
          rotationDeg: baseSpec.rotationDeg,
          baseline: baseSpec.baseline,
          outDir: join(godotDir, "stills"),
          stem: `fidelity-${variant}`,
          godotBin: flag("godot") ?? "godot",
        });
      } catch (cause) {
        console.warn(
          `godot-${variant}: skipped (${cause instanceof Error ? cause.message : String(cause)}). Needs a real display — run under xvfb-run.`,
        );
        continue;
      }
      const lumas: Awaited<ReturnType<typeof lumaOf>>[] = [];
      let firstPng: Buffer | undefined;
      for (const still of stills) {
        const png = await readFile(still);
        lumas.push(await lumaOf(png));
        firstPng ??= png;
      }
      if (firstPng) {
        await writeFile(join(outDir, `godot-${variant}.png`), firstPng);
        sheet.push({ name: `godot-${variant}`, png: firstPng });
      }
      // `rms: false` — Godot's rasterizer is a different one, and RMS against a Skia-drawn
      // reference would rank hinting policy, which is exactly the reading the header warns against.
      // Alignment IS still measured: it is a geometry question, which two rasterizers can agree on,
      // and it is the only check on whether the GDScript baseline correction landed where it claims.
      results.push(
        ...rowsFor(
          `godot-${variant}`,
          lumas,
          // Already on disk, written by the Godot bench itself — recorded rather than re-copied.
          stills.map((still) => relative(REPO_ROOT, resolve(still))),
          { rms: false },
        ),
      );
    }
  }

  await writeContactSheet(join(outDir, "contact-sheet.png"), sheet);
  await writeFile(
    join(outDir, "text-fidelity.json"),
    `${JSON.stringify(
      // `offsets` is published so a reader can LABEL the offset axis with the sub-pixel translation
      // each still was drawn at, rather than printing an index and leaving the viewer to assume.
      //
      // `alignmentTolerancePx` travels WITH the data rather than being duplicated in the reader:
      // the viewer is a pure reader, so the threshold it warns against should be the one the run
      // that produced these numbers actually used, not whatever the reader was compiled with.
      {
        dpr,
        headed,
        box,
        offsets: SHIMMER_OFFSETS,
        alignmentTolerancePx: ALIGNMENT_TOLERANCE_PX,
        // Published so the viewer can label its two groups with the rows each one covers, and so a
        // reader can find a band in a whole-box still without recomputing the stack.
        bands,
        spec: baseSpec,
        // Which arms this run could NOT render, and what would fix it. Published rather than only
        // printed, so `text:report` and any other reader can say "absent, here is why" instead of
        // leaving a gap in the arm list that looks like an arm nobody thought to add.
        notMeasured,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n${formatFidelityTable(results)}`);
  // The harness's absence idiom, verbatim: what is missing, then the command that produces it. A
  // skipped arm has no row in either band's table, and this is where a reader learns why.
  for (const entry of notMeasured) {
    console.log(`\nNOT MEASURED: ${entry.what}\n  ${entry.command}`);
  }
  console.log(`\nartifacts: ${outDir}`);
}

/**
 * ONE TABLE PER BAND, never one table with a band column.
 *
 * `distortion` is measured against the band's OWN reference, so a Han number and a Latin number are
 * two different scales that happen to be printed with the same units. Interleaving them in one
 * table invites exactly the comparison the bands exist to prevent.
 */
export function formatFidelityTable(results: readonly ArmFidelity[]): string {
  const label = (s: string, n: number) => s.padEnd(n);
  const lines: string[] = [];
  const bands = [...new Set(results.map((row) => row.band))];
  for (const band of bands) {
    const rows = results.filter((row) => row.band === band);
    const reference = rows.find((r) => r.arm === "reference");
    lines.push(
      `${label(`arm [${band}]`, 20)}${label("acutance", 11)}${label("distortion", 12)}${label("edgeShimmer", 13)}${label("inkShimmer", 12)}${label("travel", 8)}${label("resid px", 9)}${label("align px", 9)}`,
      "-".repeat(94),
    );
    for (const row of rows) {
      const ratio = reference?.acutance
        ? row.acutance / reference.acutance
        : Number.NaN;
      lines.push(
        label(row.arm, 20) +
          label(row.acutance.toFixed(4), 11) +
          label(
            Number.isNaN(ratio) ? "—" : Math.abs(1 - ratio).toFixed(3),
            12,
          ) +
          label(row.edgeShimmer.toFixed(5), 13) +
          label(Number.isNaN(row.shimmer) ? "—" : row.shimmer.toFixed(5), 12) +
          label(
            row.subpixelTravel === undefined
              ? "—"
              : row.subpixelTravel.toFixed(3),
            8,
          ) +
          label(
            row.subpixelResidualPx === undefined
              ? "—"
              : row.subpixelResidualPx.toFixed(3),
            9,
          ) +
          label(
            row.alignmentPx === undefined || Number.isNaN(row.alignmentPx)
              ? "—"
              : row.alignmentPx.toFixed(3),
            9,
          ),
      );
    }
    lines.push("");
  }
  // Loud, above the metric glossary rather than buried under it. A misaligned arm does not produce
  // a WRONG-LOOKING table — it produces a plausible one whose per-pixel columns quietly rank a
  // translation, which is exactly how the dom arm's 2.35 px offset survived a full round.
  const misaligned = results.filter(
    (r) =>
      r.alignmentPx !== undefined &&
      !Number.isNaN(r.alignmentPx) &&
      r.alignmentPx > (r.alignmentAllowancePx ?? ALIGNMENT_TOLERANCE_PX),
  );
  if (misaligned.length > 0) {
    lines.push(
      "",
      `!! MISALIGNED: ${misaligned
        .map(
          (r) =>
            `${r.arm} [${r.band}] ${r.alignmentPx?.toFixed(2)} px (allowed ${(r.alignmentAllowancePx ?? ALIGNMENT_TOLERANCE_PX).toFixed(2)})`,
        )
        .join(", ")}`,
      "!! These arms do not draw in the same place as the reference, so their `rmsVsReference` and",
      "!! their diff images measure the OFFSET, not the rasterizer. The distortion / shimmer /",
      "!! travel columns are translation-invariant and remain readable.",
    );
  }
  lines.push(
    "",
    "One table per BAND — the rows of the image one script's run occupies. Han and Latin have",
    "  different correct acutances, so a distortion in one table cannot be compared with a",
    "  distortion in the other; only each arm's distance from ITS OWN band's reference means",
    "  anything. Read down a column, never across the two tables.",
    "acutance: mean |grad green| per unit ink. `reference` is the SAME geometry drawn at 8x and",
    "  box-downsampled: correct area-coverage antialiasing for this exact run. GREEN, not a luma:",
    "  `dom` is the only arm with LCD subpixel AA, and averaging its three channels is a ~1 px",
    "  horizontal blur charged to the mechanism. Green is bit-identical to luma on the other seven.",
    "distortion = |1 - acutance/ref|, and it is the column to read. Acutance is NOT 'higher is",
    "  better': BELOW the reference is blur, ABOVE it is harder-than-correct edges, i.e. aliasing.",
    "  Both are wrong, in opposite directions, and only the distance from 1.000 says how wrong.",
    "edgeShimmer: CV of ACUTANCE across the 8 translations — does the edge structure hold still as",
    "  the text moves. THIS is the crawl metric.",
    "inkShimmer: CV of TOTAL INK. Near 0 for any exact-area rasterizer whether it crawls or not,",
    "  because translating a shape does not change its area. Reported, but it is the weaker signal.",
    "travel / resid px: slope and RMS residual of measured centroid vs requested offset. READ THEM",
    "  BEFORE THE SHIMMER COLUMNS. Slope alone cannot tell sub-pixel motion from whole-pixel",
    "  SNAPPING — a snapping arm still tracks the request on average. The residual can: ~0.29 px is",
    "  the signature of rounding to whole pixels, ~0 is genuine sub-pixel motion. An arm that snapped",
    "  cannot shimmer, so its 0 is a consequence of the snap, not a property of its rasterizer.",
    "align px: how far this arm must be MOVED to land on the reference, per offset, found by",
    "  correlating the two stills. A LICENCE, not a score: it says whether the per-pixel columns are",
    "  about rasterization at all. Past its allowance they are about the offset instead, and the run",
    "  says so above. NOT a centroid difference — a centroid also moves when ink is REDISTRIBUTED,",
    "  which reads 0.40 px for canvas2d and 0.54 px for hb-run, arms that register under 0.06 px.",
    `  The allowance is ${ALIGNMENT_TOLERANCE_PX} px (the 0.106 px worst-case noise floor, with room) plus ${ALIGNMENT_BLUR_ALLOWANCE_PER_DISTORTION} px per unit of`,
    "  distortion for arms blurrier than the reference, which is this estimator's one measured bias.",
  );
  return lines.join("\n");
}

async function writeContactSheet(
  path: string,
  entries: readonly { name: string; png: Buffer }[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const scale = 4;
  const tiles = await Promise.all(
    entries.map(async ({ png }) => {
      const meta = await sharp(png).metadata();
      return sharp(png)
        .resize({
          width: (meta.width ?? 1) * scale,
          kernel: "nearest",
        })
        .png()
        .toBuffer();
    }),
  );
  const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
  const width = Math.max(...metas.map((m) => m.width ?? 0));
  const gap = 8;
  const height =
    metas.reduce((sum, m) => sum + (m.height ?? 0), 0) +
    gap * (tiles.length - 1);
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 16, g: 16, b: 20, alpha: 1 },
    },
  })
    .composite(
      tiles.map((input, index) => ({
        input,
        left: 0,
        top: metas
          .slice(0, index)
          .reduce((sum, m) => sum + (m.height ?? 0) + gap, 0),
      })),
    )
    .png()
    .toFile(path);
}

async function evaluate(
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  expression: string,
): Promise<void> {
  const result = await send<{
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `page: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
