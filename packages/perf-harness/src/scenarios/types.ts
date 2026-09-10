// Scenario contract. Browser-safe: no node imports may reach this file or its implementations,
// because the same modules are bundled into the page AND imported by the node CLI (for the declared
// parameter defaults, so there is exactly one source of truth for what a scenario accepts).

export interface AtlasRegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The optional SECOND fixture: one large opaque image, the stand-in for a host-rendered static
 * background. Present only when the scenario declares `backgroundFixture`.
 */
export interface AtlasBackgroundView {
  url: string;
  width: number;
  height: number;
}

export interface AtlasFixtureView {
  pageUrl: string;
  pageSize: { width: number; height: number };
  regions: AtlasRegionRect[];
  background?: AtlasBackgroundView;
}

export type ParamValue = string | number | boolean;

export interface ParamSpec {
  default: ParamValue;
  /** Allowed values for enumerated params (`mechanism`); omitted for free numeric params. */
  values?: ParamValue[];
  describe: string;
}

/**
 * What a scenario is being laid out INTO. Passed to `stageSize` and carried on the context, so a
 * scenario can adapt its own shape to the screen it is on — a landscape grid on a portrait phone
 * fits and then renders tiny in a band across an empty screen, which under-loads the very work being
 * measured.
 */
export interface StageLayout {
  /** The browser's real viewport in CSS px. */
  viewport: { width: number; height: number };
  /**
   * Whether this run FITS the stage into the viewport. `false` means the scenario is laid out
   * directly in the viewport at its authored size — the desktop default, kept byte-identical so the
   * committed baseline stays comparable, and the reason an adaptive shape must be gated on this
   * rather than on the viewport's aspect alone.
   */
  fit: boolean;
}

export interface ScenarioContext {
  root: HTMLElement;
  params: Record<string, ParamValue>;
  fixture: AtlasFixtureView;
  layout: StageLayout;
  /**
   * The box `root` gives the scenario, in CSS px. On a fitted run this is the scenario's own declared
   * stage size (`stageSize`), scaled to the viewport by a transform the scenario never sees; on an
   * unfitted run it is the viewport itself. A scenario that needs its own extent — S3 sizes a Godot
   * Control root from it — must read THIS and never `window.innerWidth`, which on a fitted run is the
   * viewport the stage was shrunk into rather than the space the scenario has.
   */
  stage: { width: number; height: number };
  mark(name: string): void;
}

export interface Scenario {
  name: string;
  params: Record<string, ParamSpec>;
  mount(ctx: ScenarioContext): void;
  ready(ctx: ScenarioContext): Promise<void>;
  step?(ctx: ScenarioContext, t: number): void;
  teardown(ctx: ScenarioContext): void;
  /**
   * Points (CSS px, viewport coordinates) that MUST be non-background in a post-window screenshot.
   * The presence guard turns "the harness measured a blank page" from a great-looking number into a
   * reported failure, so every scenario has to declare where its content is.
   */
  samplePoints(ctx: ScenarioContext): { x: number; y: number }[];
  /**
   * The scenario's DESIGN BOX in CSS px: the smallest box that contains everything it mounts and
   * every point `samplePoints` can return, at any point in its animation.
   *
   * This is what a fitted run scales into the real viewport, so that the same scenario renders whole
   * on a portrait phone, a landscape phone and a desktop window instead of being measured at a
   * force-emulated desktop size the device would never use. A pure function of the parameters (not of
   * the mounted DOM) so the runner can report the geometry, and a test can prove the box actually
   * contains the sample points, without a browser.
   *
   * Required, like `samplePoints`: a scenario that does not say how big it is cannot be fitted, and
   * silently falling back to the viewport would reintroduce the clipped-content failure this whole
   * mechanism exists to remove.
   */
  stageSize(
    params: Record<string, ParamValue>,
    layout: StageLayout,
  ): { width: number; height: number };
  /**
   * The grid shape (columns x rows) this scenario laid its cells out in, for the report. The CELL
   * COUNT never changes with the viewport — only the shape does — and recording the shape is what
   * lets a reader see that a portrait run and a landscape run drew the same work differently rather
   * than having to infer it from a fit scale.
   */
  gridShape?(
    params: Record<string, ParamValue>,
    layout: StageLayout,
  ): { columns: number; rows: number };
  /**
   * Ask the runner to generate and serve the large-background fixture, sized from the scenario's own
   * parameters. Declared as a function rather than a flag so the size stays a parameter (there is
   * exactly one source of truth for what a scenario accepts) instead of a magic param name the
   * runner has to know about.
   */
  backgroundFixture?(params: Record<string, ParamValue>): {
    width: number;
    height: number;
  };
  /**
   * Ask the runner to download, subset and serve the CJK benchmark font at `/fixture/font.ttf`.
   *
   * A flag rather than `backgroundFixture`'s function, because unlike the background there is
   * nothing to parameterise: the fixture is ONE file, sized for the ceiling of the `glyphs`
   * parameter, precisely so that changing `glyphs` never regenerates it and two runs at different
   * glyph counts still measure the same outlines. See `scripts/ensure-cjk-font.ts`.
   */
  fontFixture?: boolean;
  /**
   * Whether this scenario paints IMAGES. Absent means yes.
   *
   * The report validator rejects `decode.count === 0` outright, because for every scenario that
   * mounts an atlas page a zero can only mean cc's decode-cache event names drifted — and calling
   * that "no decode cost" is the worst mistake this harness could make. A text scenario genuinely
   * paints none: glyphs are rasterized by the font stack, which emits no decode events. Declaring
   * it here is what lets the report carry `decode.imagesExpected: false` so a reader (and the
   * validator) can tell a true zero from a broken matcher.
   */
  paintsImages?: boolean;
  /**
   * Substring of an image URL whose PaintImage records the analyzer should attribute separately
   * (`metrics.watchedImage`). Set it when the scenario's claim is about ONE specific image — "the
   * background is not re-painted while unrelated content churns" is unmeasurable from the run-wide
   * totals, because those cannot say WHICH image the cost belonged to.
   */
  watchImageUrl?: string;
  /**
   * The scenario's OWN counters, read ONCE after the measured window closes (`metrics.scenario` in
   * the report).
   *
   * This is for the class of fact a CDP trace cannot attribute per-arm: whether the arm's loop really
   * parked, how many simulation steps it actually took, how many draws it issued. The trace shows the
   * page got cheaper; only the scenario knows WHICH of its own switches made it cheaper, and an arm
   * that claims "the sim is capped while draws keep ticking" has to be able to prove it rather than be
   * believed.
   *
   * FLAT and FINITE. A `Record<string, number>` one level deep — no nesting, no strings, no nulls;
   * the validator rejects anything else, because a counter block is read next to trace numbers and
   * has to be summable and medianable the same way.
   *
   * ABSENT MEANS NOT MEASURED, NEVER ZERO. A scenario that does not implement this carries no block
   * at all, and the table prints `—` rather than `0`. Do not return a key you did not actually count:
   * a fabricated `0` is indistinguishable from a measured one, which is precisely the failure this
   * whole harness is built to refuse.
   *
   * Called on the same context the run used, after the last `step()` and before the presence
   * samples — so a counter reads the state the screenshot is about to capture.
   */
  metrics?(ctx: ScenarioContext): Record<string, number>;
}

export function resolveParams(
  scenario: Scenario,
  overrides: Record<string, ParamValue | undefined>,
): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {};
  for (const [key, spec] of Object.entries(scenario.params)) {
    const override = overrides[key];
    if (override === undefined) {
      params[key] = spec.default;
      continue;
    }
    const coerced =
      typeof spec.default === "number"
        ? Number(override)
        : typeof spec.default === "boolean"
          ? override === true || override === "true"
          : String(override);
    if (typeof coerced === "number" && !Number.isFinite(coerced)) {
      throw new Error(
        `param ${key}: expected a number, got ${String(override)}`,
      );
    }
    if (spec.values && !spec.values.includes(coerced)) {
      throw new Error(
        `param ${key}: ${String(coerced)} is not one of ${spec.values.join(", ")}`,
      );
    }
    params[key] = coerced;
  }
  return params;
}
