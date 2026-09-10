// How a scenario's stage is fitted into whatever viewport the browser actually has.
//
// THE PROBLEM THIS SOLVES. Until this module existed, a device run force-emulated a 1280x800 desktop
// viewport onto the phone (`Emulation.setDeviceMetricsOverride`) because S1's stage is ~1064 CSS px
// wide and a portrait phone's ~412 px viewport would push most sample points off screen. That kept
// the presence guard green, and measured the wrong thing: content rendered at a forced desktop size
// is RASTERED AT A DIFFERENT SCALE than the device would ever use, and raster scale is precisely what
// drives the decode cost this harness exists to measure. A phone baseline taken at a synthetic
// 1280x800 does not describe what the phone does.
//
// THE STRATEGY IS BORROWED, NOT INVENTED. The consuming project's web client fits a fixed-design-size
// game stage into an arbitrary browser viewport, and godot-scene-web's own `observeContentScale`
// (packages/html, the `transform` technique of Godot's `content_scale_aspect: keep`) is the same
// math:
//
//     scale = min(viewportWidth / stageWidth, viewportHeight / stageHeight)
//
// applied as a `transform: scale()` on a stage that keeps its px layout, centred inside a frame that
// clips the letterbox/pillarbox bars. Reusing that rule is the whole point — the harness must measure
// what the client does, so a third fitting strategy would make its numbers describe nothing real.
// What is deliberately NOT borrowed is the consuming project's product specifics (the 1920x1080
// design box, the widescreen "stretch" widening, the view-scale table): a scenario declares its own
// stage size, and this module stays product-neutral.
//
// Browser-safe: no node imports may reach this file. It is bundled into the page (runtime.ts uses it
// to build and measure the stage) AND imported by the node runner (to record the geometry in the
// report), so both sides agree on the arithmetic by construction rather than by comment.

export interface FitSize {
  width: number;
  height: number;
}

export interface FitPoint {
  x: number;
  y: number;
}

/**
 * Which way round the viewport is. Reported rather than derived by the reader, because "the phone was
 * in portrait" is the single most useful fact about a device run whose numbers look nothing like the
 * desktop's.
 */
export type FitOrientation = "portrait" | "landscape" | "square";

export function orientationOf(viewport: FitSize): FitOrientation {
  if (!(viewport.width > 0) || !(viewport.height > 0)) {
    return "square";
  }
  if (viewport.width > viewport.height) {
    return "landscape";
  }
  return viewport.width < viewport.height ? "portrait" : "square";
}

export interface StageFit {
  /** Uniform scale applied to the stage. 1 when the stage is used at its authored size. */
  scale: number;
  /** The design box, in CSS px — what the scenario lays itself out in. */
  stage: FitSize;
  /** The stage as it appears on screen: `stage * scale`, in CSS px. */
  fitted: FitSize;
  /** Top-left of the fitted stage inside the viewport, centred like the client's letterbox. */
  offset: FitPoint;
  viewport: FitSize;
  orientation: FitOrientation;
  /** False only when the viewport is degenerate or `maxScale` forced an oversized stage. */
  fits: boolean;
}

export interface FitOptions {
  /**
   * Cap on the uniform scale. Defaults to UNCAPPED, matching the client: a stage on a viewport larger
   * than its design box is scaled UP, exactly as the game surface is on a desktop monitor. A cap is
   * available for callers that need the stage never to exceed its authored raster scale.
   */
  maxScale?: number;
}

/**
 * Uniform "keep" fit of `stage` into `viewport`, centred.
 *
 * Pure, and unit-tested rather than eyeballed: this one expression decides the raster scale every
 * device number is measured at, and a fit that silently returned 1 would look perfectly plausible in
 * a report while describing an entirely different measurement.
 */
export function fitStage(
  stage: FitSize,
  viewport: FitSize,
  options: FitOptions = {},
): StageFit {
  const maxScale = options.maxScale ?? Number.POSITIVE_INFINITY;
  const usable =
    stage.width > 0 &&
    stage.height > 0 &&
    viewport.width > 0 &&
    viewport.height > 0;
  const raw = usable
    ? Math.min(viewport.width / stage.width, viewport.height / stage.height)
    : 1;
  const scale = Math.min(raw, maxScale);
  const fitted = {
    width: stage.width * scale,
    height: stage.height * scale,
  };
  return {
    scale,
    stage: { width: stage.width, height: stage.height },
    fitted,
    offset: {
      x: (viewport.width - fitted.width) / 2,
      y: (viewport.height - fitted.height) / 2,
    },
    viewport: { width: viewport.width, height: viewport.height },
    orientation: orientationOf(viewport),
    // A half-pixel of subpixel rounding is not an overflow; anything more is.
    fits:
      usable &&
      fitted.width <= viewport.width + 0.5 &&
      fitted.height <= viewport.height + 0.5,
  };
}

/** The identity fit: the stage IS the viewport, at scale 1. What a non-fitted run reports. */
export function identityFit(viewport: FitSize): StageFit {
  return {
    scale: 1,
    stage: { width: viewport.width, height: viewport.height },
    fitted: { width: viewport.width, height: viewport.height },
    offset: { x: 0, y: 0 },
    viewport: { width: viewport.width, height: viewport.height },
    orientation: orientationOf(viewport),
    fits: viewport.width > 0 && viewport.height > 0,
  };
}

/**
 * Stage-space CSS px -> viewport-space CSS px.
 *
 * Every scenario declares its sample points in ITS OWN stage coordinates (unchanged by this round);
 * the presence guard compares them against a screenshot of the VIEWPORT. This is the one conversion
 * between the two, so a fitted run's guard stays exactly as strict as an unfitted one's.
 */
export function mapStagePoint(point: FitPoint, fit: StageFit): FitPoint {
  return {
    x: fit.offset.x + point.x * fit.scale,
    y: fit.offset.y + point.y * fit.scale,
  };
}

/** Points that lie outside the declared stage box — i.e. content the stage's clip would eat. */
export function pointsOutsideStage(
  points: readonly FitPoint[],
  stage: FitSize,
): FitPoint[] {
  return points.filter(
    (point) =>
      point.x < 0 ||
      point.y < 0 ||
      point.x > stage.width ||
      point.y > stage.height,
  );
}

export interface GridShape {
  columns: number;
  rows: number;
}

/**
 * Split `count` cells into the columns x rows grid whose ASPECT best matches the viewport's.
 *
 * A landscape grid squeezed into a portrait phone fits — and then renders tiny, in a band across the
 * middle of an otherwise empty screen. That under-loads the exact rendering work the scenario exists
 * to measure: the fit scale collapses, so every sprite is rastered far smaller than anything the
 * device would really draw. Matching the grid's aspect to the viewport's makes the SAME number of
 * cells fill the screen instead.
 *
 * The cell count is an input and never a result: the shape adapts, the number of things rendered
 * does not. Two environments can only be compared if they mounted the same amount of work.
 *
 * `cellAspect` is one cell's width/height (S1's sprite cells are square; S3's nine-patch cells are
 * 258x126), so the comparison is over the grid's real proportions rather than a cell count. The
 * search is over every legal column count with the LOG of the aspect ratio as the distance, because
 * "twice as wide as it should be" and "half as wide" have to cost the same — a linear difference
 * silently prefers wide grids.
 */
export function gridShapeFor(
  count: number,
  cellAspect: number,
  viewportAspect: number,
): GridShape {
  const cells = Math.max(1, Math.floor(count));
  if (!(cellAspect > 0) || !(viewportAspect > 0)) {
    return { columns: cells, rows: 1 };
  }
  let best: GridShape = { columns: cells, rows: 1 };
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let columns = 1; columns <= cells; columns++) {
    const rows = Math.ceil(cells / columns);
    const aspect = (columns * cellAspect) / rows;
    const distance = Math.abs(Math.log(aspect / viewportAspect));
    // Strictly less-than keeps the FEWEST columns among equally good shapes, so the choice is
    // deterministic instead of depending on iteration order.
    if (distance < bestDistance - 1e-12) {
      bestDistance = distance;
      best = { columns, rows };
    }
  }
  return best;
}

export interface ViewportPolicyInput {
  kind: "ci" | "device";
  /** `--viewport`, or undefined when the caller did not force one. */
  viewport?: FitSize;
  /** `--fit` / `--no-fit`, or undefined for the per-environment default. */
  fit?: boolean;
}

export interface ViewportPolicy {
  /** The viewport to emulate (and the size hint for a created target). */
  viewport: FitSize;
  /** Whether to call `Emulation.setDeviceMetricsOverride` at all. */
  emulate: boolean;
  fit: boolean;
}

/** The default `ci` viewport. The committed desktop baseline was measured at exactly this. */
export const DEFAULT_CI_VIEWPORT: FitSize = { width: 1280, height: 800 };

/**
 * Viewport + fit policy, in one testable place.
 *
 *   ci     — the fixed 1280x800 emulated viewport, stage used 1:1. The desktop numbers are this
 *            round's measured record (`baselines/linux-chrome-148.json`, the S1-S4 tables in
 *            docs/perf-harness.md), and they only stay comparable if the geometry does not move.
 *            `--fit` opts in.
 *   device — the phone's OWN viewport and orientation, with the stage fitted into it. Forcing a
 *            desktop viewport on a phone rasters at a scale the device never uses, and raster scale
 *            is what the decode numbers are about. `--viewport` re-enables emulation.
 */
export function resolveViewportPolicy(
  input: ViewportPolicyInput,
): ViewportPolicy {
  return {
    viewport: input.viewport ?? DEFAULT_CI_VIEWPORT,
    emulate: input.kind !== "device" || input.viewport !== undefined,
    fit: input.fit ?? input.kind === "device",
  };
}

export function roundTo(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** One line for the progress log and the comparison table's header. */
export function describeFit(fit: StageFit, enabled: boolean): string {
  const viewport = `${roundTo(fit.viewport.width, 1)}x${roundTo(fit.viewport.height, 1)}`;
  if (!enabled) {
    return `${viewport} ${fit.orientation}, no fit (stage IS the viewport)`;
  }
  return (
    `${viewport} ${fit.orientation}, stage ${roundTo(fit.stage.width, 1)}x${roundTo(fit.stage.height, 1)}` +
    ` fitted x${roundTo(fit.scale, 4)} -> ${roundTo(fit.fitted.width, 1)}x${roundTo(fit.fitted.height, 1)}`
  );
}

/**
 * Are two runs' geometries the same measurement?
 *
 * Not cosmetic: decode and raster cost scale with the raster scale, so a repeat taken at a different
 * fit scale (a phone rotated mid-run, a browser window resized) is a DIFFERENT experiment and must
 * not be averaged into the same median. The runner locks the first measured repeat's geometry and
 * discards any later one that fails this test.
 */
export function sameGeometry(
  a: StageFit,
  b: StageFit,
  epsilon = 0.001,
): boolean {
  // SCALE and STAGE only, deliberately NOT the viewport. What makes two repeats comparable is the
  // raster scale the content was drawn at; a viewport that changed WITHOUT changing the scale just
  // moved the letterbox bars. That distinction is not academic on Android, where the collapsing URL
  // bar changes `innerHeight` by ~50-100 px between repeats — testing the viewport would discard
  // perfectly comparable repeats for a piece of browser chrome.
  return (
    Math.abs(a.scale - b.scale) <= epsilon &&
    Math.abs(a.stage.width - b.stage.width) <= 1 &&
    Math.abs(a.stage.height - b.stage.height) <= 1
  );
}
