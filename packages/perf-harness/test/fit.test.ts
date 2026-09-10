// @vitest-environment node
//
// The viewport fit: the arithmetic that decides what raster scale every device number is measured
// at, and the scenario stage boxes that arithmetic is applied to.
//
// Everything asserted here is something that could be silently WRONG while still producing a
// perfectly plausible report: a fit that quietly returns 1 (so the phone is measured at a scale it
// never uses), a stage box that does not actually contain the content it claims to (so the stage's
// clip eats a row of sprites and the presence guard blames the renderer), a mapping that puts the
// sample points somewhere the screenshot does not have them.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CI_VIEWPORT,
  describeFit,
  fitStage,
  gridShapeFor,
  identityFit,
  mapStagePoint,
  orientationOf,
  pointsOutsideStage,
  resolveViewportPolicy,
  sameGeometry,
} from "../src/fit";
import {
  ancestorRescale,
  atlasSprites,
  largeImageCoexistence,
  ninePatchAtlas,
  patchGridShape,
  resolveParams,
  SCENARIOS,
  type Scenario,
  type ScenarioContext,
  type StageLayout,
  spriteGridShape,
  textRender,
} from "../src/scenarios";

/** The moto g86 5G's real viewport, the phone this round is measured on. */
const PHONE_PORTRAIT = { width: 412, height: 883 };
const PHONE_LANDSCAPE = { width: 883, height: 412 };
const DESKTOP = { width: 1280, height: 800 };
const FITTED_PORTRAIT: StageLayout = { viewport: PHONE_PORTRAIT, fit: true };
const UNFITTED_DESKTOP: StageLayout = { viewport: DESKTOP, fit: false };

function contextFor(
  scenario: Scenario,
  overrides: Record<string, string | number> = {},
  layout: StageLayout = { viewport: PHONE_PORTRAIT, fit: true },
): ScenarioContext {
  const params = resolveParams(scenario, overrides);
  return {
    root: {} as HTMLElement,
    params,
    layout,
    stage: scenario.stageSize(params, layout),
    fixture: {
      pageUrl: "/fixture/atlas.png",
      pageSize: { width: 4096, height: 4096 },
      regions: Array.from({ length: 100 }, (_, index) => ({
        x: (index % 10) * 380,
        y: Math.floor(index / 10) * 380,
        width: 360,
        height: 360,
      })),
      background: {
        url: "/fixture/background.png",
        width: 2520,
        height: 1080,
      },
    },
    mark: () => {},
  };
}

describe("orientationOf", () => {
  it("names the three cases", () => {
    expect(orientationOf(PHONE_PORTRAIT)).toBe("portrait");
    expect(orientationOf(PHONE_LANDSCAPE)).toBe("landscape");
    expect(orientationOf({ width: 500, height: 500 })).toBe("square");
  });
});

describe("fitStage", () => {
  const stage = { width: 1064, height: 544 };

  it("fits a wide stage into a PORTRAIT phone by its width", () => {
    const fit = fitStage(stage, PHONE_PORTRAIT);
    // 412/1064 = 0.3872… is the binding constraint; the height has room to spare.
    expect(fit.scale).toBeCloseTo(412 / 1064, 10);
    expect(fit.fitted.width).toBeCloseTo(412, 6);
    expect(fit.fitted.height).toBeLessThan(PHONE_PORTRAIT.height);
    expect(fit.orientation).toBe("portrait");
    expect(fit.fits).toBe(true);
  });

  it("fits the SAME stage into a landscape phone by its height", () => {
    const fit = fitStage(stage, PHONE_LANDSCAPE);
    // 412/544 = 0.757… now binds: the same content, a different raster scale. Which is exactly why
    // the scale has to be reported and why two orientations are not comparable.
    expect(fit.scale).toBeCloseTo(412 / 544, 10);
    expect(fit.fitted.height).toBeCloseTo(412, 6);
    expect(fit.fitted.width).toBeLessThan(PHONE_LANDSCAPE.width);
    expect(fit.orientation).toBe("landscape");
  });

  it("centres the fitted stage — the client's letterbox, not a top-left pin", () => {
    const fit = fitStage(stage, PHONE_PORTRAIT);
    expect(fit.offset.x).toBeCloseTo(
      (PHONE_PORTRAIT.width - fit.fitted.width) / 2,
      6,
    );
    expect(fit.offset.y).toBeCloseTo(
      (PHONE_PORTRAIT.height - fit.fitted.height) / 2,
      6,
    );
    // Bars top and bottom on a portrait phone, none at the sides.
    expect(fit.offset.x).toBeCloseTo(0, 6);
    expect(fit.offset.y).toBeGreaterThan(100);
  });

  it("scales UP on a viewport bigger than the stage, like the client's game surface", () => {
    const fit = fitStage(stage, DESKTOP);
    expect(fit.scale).toBeGreaterThan(1);
    expect(fit.scale).toBeCloseTo(Math.min(1280 / 1064, 800 / 544), 10);
  });

  it("honours a maxScale cap for callers that must not exceed the authored raster scale", () => {
    expect(fitStage(stage, DESKTOP, { maxScale: 1 }).scale).toBe(1);
  });

  it("never returns a fitted box larger than the viewport", () => {
    for (const viewport of [
      PHONE_PORTRAIT,
      PHONE_LANDSCAPE,
      DESKTOP,
      { width: 320, height: 480 },
      { width: 2560, height: 1440 },
    ]) {
      const fit = fitStage(stage, viewport);
      expect(fit.fitted.width).toBeLessThanOrEqual(viewport.width + 1e-9);
      expect(fit.fitted.height).toBeLessThanOrEqual(viewport.height + 1e-9);
      expect(fit.fits).toBe(true);
    }
  });

  it("reports a degenerate viewport as NOT fitting instead of inventing a scale", () => {
    const fit = fitStage(stage, { width: 0, height: 0 });
    expect(fit.fits).toBe(false);
    expect(Number.isFinite(fit.scale)).toBe(true);
  });

  it("identityFit is the unfitted run: the stage IS the viewport at scale 1", () => {
    const fit = identityFit(DESKTOP);
    expect(fit.scale).toBe(1);
    expect(fit.stage).toEqual(DESKTOP);
    expect(fit.offset).toEqual({ x: 0, y: 0 });
  });
});

describe("mapStagePoint", () => {
  it("maps stage coordinates into the viewport through offset + scale", () => {
    const fit = fitStage(
      { width: 1000, height: 500 },
      { width: 500, height: 500 },
    );
    expect(fit.scale).toBe(0.5);
    // Centre of the stage lands at the centre of the viewport.
    expect(mapStagePoint({ x: 500, y: 250 }, fit)).toEqual({ x: 250, y: 250 });
    // Stage origin lands at the letterbox offset.
    expect(mapStagePoint({ x: 0, y: 0 }, fit)).toEqual({ x: 0, y: 125 });
  });

  it("is the identity for an unfitted run", () => {
    const fit = identityFit(DESKTOP);
    expect(mapStagePoint({ x: 640, y: 400 }, fit)).toEqual({ x: 640, y: 400 });
  });
});

describe("pointsOutsideStage", () => {
  it("catches content a scenario placed outside the box it declared", () => {
    const stage = { width: 100, height: 100 };
    expect(pointsOutsideStage([{ x: 50, y: 50 }], stage)).toEqual([]);
    expect(pointsOutsideStage([{ x: 101, y: 50 }], stage)).toHaveLength(1);
    expect(pointsOutsideStage([{ x: 50, y: -1 }], stage)).toHaveLength(1);
  });
});

describe("sameGeometry", () => {
  const stage = { width: 1064, height: 544 };

  it("accepts the same measurement twice", () => {
    expect(
      sameGeometry(
        fitStage(stage, PHONE_PORTRAIT),
        fitStage(stage, PHONE_PORTRAIT),
      ),
    ).toBe(true);
  });

  it("rejects a phone that ROTATED mid-run — a different raster scale is a different experiment", () => {
    expect(
      sameGeometry(
        fitStage(stage, PHONE_PORTRAIT),
        fitStage(stage, PHONE_LANDSCAPE),
      ),
    ).toBe(false);
  });
});

describe("describeFit", () => {
  it("says the viewport, the orientation and the scale in one line", () => {
    const line = describeFit(
      fitStage({ width: 1064, height: 544 }, PHONE_PORTRAIT),
      true,
    );
    expect(line).toContain("412x883");
    expect(line).toContain("portrait");
    expect(line).toContain("1064x544");
  });

  it("says outright when nothing was fitted", () => {
    expect(describeFit(identityFit(DESKTOP), false)).toContain("no fit");
  });
});

/**
 * Parameters a scenario needs on a PHONE-sized viewport, where its defaults are a desktop workload.
 *
 * Only S9 has one, and the reason is structural rather than incidental: it is the only scenario
 * that pins its stage to the viewport (so the glyph raster scale stays the device pixel ratio),
 * which means an over-subscribed viewport cannot be absorbed by a smaller fit scale. It REFUSES at
 * mount instead — `textLayoutFits` — so asserting its geometry at a configuration it would refuse
 * asserts nothing about any run that can exist. 6 cells is what a 412x883 portrait phone holds at
 * the default 14 px with both scripts stacked; the docs' phone invocation passes the same number.
 */
const PHONE_OVERRIDES: Record<string, Record<string, string | number>> = {
  "text-render": { labels: 6 },
};

function phoneOverridesFor(
  scenario: Scenario,
): Record<string, string | number> {
  return PHONE_OVERRIDES[scenario.name] ?? {};
}

describe("scenario stage boxes", () => {
  it("every registered scenario declares one", () => {
    for (const scenario of Object.values(SCENARIOS)) {
      const size = scenario.stageSize(
        resolveParams(scenario, {}),
        FITTED_PORTRAIT,
      );
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    }
  });

  // THE contract test. A stage that does not contain the scenario's own sample points would be
  // clipped by the stage's overflow, and the presence guard would report a rendering failure for a
  // geometry mistake — indistinguishable, from the table, from the blank page it exists to catch.
  it("contains every sample point the scenario can report", () => {
    const cases: {
      scenario: Scenario;
      overrides: Record<string, string | number>;
    }[] = [
      { scenario: atlasSprites, overrides: {} },
      { scenario: atlasSprites, overrides: { mounted: 7 } },
      { scenario: atlasSprites, overrides: { mounted: 120 } },
      { scenario: ancestorRescale, overrides: {} },
      { scenario: ancestorRescale, overrides: { focusScale: 1.5 } },
      { scenario: ninePatchAtlas, overrides: {} },
      { scenario: ninePatchAtlas, overrides: { nodeSizing: "uniform" } },
      { scenario: largeImageCoexistence, overrides: {} },
      { scenario: largeImageCoexistence, overrides: { churn: 40 } },
      // Configurations S9 would ACCEPT on this viewport — see `PHONE_OVERRIDES`. A refused one
      // overlaps its cells by construction, so its sample points leaving the stage is the refusal
      // working, not a geometry bug.
      { scenario: textRender, overrides: { labels: 6 } },
      { scenario: textRender, overrides: { labels: 3 } },
      { scenario: textRender, overrides: { labels: 12, script: "han" } },
      { scenario: textRender, overrides: { labels: 2, rotationDeg: 45 } },
    ];
    for (const { scenario, overrides } of cases) {
      const ctx = contextFor(scenario, overrides);
      const stage = scenario.stageSize(ctx.params, ctx.layout);
      // At rest. S2/S3 additionally report points multiplied by the CURRENT animation scale, which
      // is why their stage boxes are sized for the peak — asserted below.
      expect(
        pointsOutsideStage(scenario.samplePoints(ctx), stage),
        `${scenario.name} ${JSON.stringify(overrides)}`,
      ).toEqual([]);
    }
  });

  it("S2/S3 size their stage for the PEAK of the focus animation, not the resting scale", () => {
    // The screenshot is taken wherever the measured window happened to end — frequently mid-focus.
    // A stage sized for the resting scale would clip the focused frame.
    for (const scenario of [ancestorRescale, ninePatchAtlas]) {
      const params = resolveParams(scenario, {});
      const peak = Number(params.focusScale);
      expect(peak).toBeGreaterThan(1);
      const atPeak = scenario.stageSize(params, FITTED_PORTRAIT);
      const atRest = scenario.stageSize(
        { ...params, focusScale: 1 },
        FITTED_PORTRAIT,
      );
      expect(atPeak.width).toBeGreaterThan(atRest.width);
      expect(atPeak.height).toBeGreaterThan(atRest.height);
      // And the peak-scaled sample points still fit.
      const ctx = contextFor(scenario, {});
      const scaled = scenario
        .samplePoints(ctx)
        .map((point) => ({ x: point.x * peak, y: point.y * peak }));
      expect(pointsOutsideStage(scaled, atPeak)).toEqual([]);
    }
  });

  it("S1's stage is the padded sprite grid, and it grows with `mounted`", () => {
    // Unfitted: the authored 10-column grid, so 10 sprites are one row and 50 are five.
    const small = atlasSprites.stageSize(
      resolveParams(atlasSprites, { mounted: 10 }),
      UNFITTED_DESKTOP,
    );
    const large = atlasSprites.stageSize(
      resolveParams(atlasSprites, { mounted: 50 }),
      UNFITTED_DESKTOP,
    );
    // 10 sprites = one row; 50 = five rows. Same width, five times the rows.
    expect(small.width).toBe(large.width);
    expect(large.height).toBeGreaterThan(small.height);
  });

  it("S4's stage covers the churn strip and the bare-background sample rows, not just the grid", () => {
    const params = resolveParams(largeImageCoexistence, {});
    const stage = largeImageCoexistence.stageSize(params, UNFITTED_DESKTOP);
    const grid = atlasSprites.stageSize(params, UNFITTED_DESKTOP);
    expect(stage.width).toBeGreaterThan(grid.width);
    expect(stage.height).toBeGreaterThan(grid.height);
  });

  // The user-reported failure, as a test: a portrait phone must show ALL of it.
  it("every scenario fits a PORTRAIT phone with every sample point inside the viewport", () => {
    for (const scenario of Object.values(SCENARIOS)) {
      const ctx = contextFor(scenario, phoneOverridesFor(scenario));
      const fit = fitStage(
        scenario.stageSize(ctx.params, ctx.layout),
        PHONE_PORTRAIT,
      );
      const mapped = scenario
        .samplePoints(ctx)
        .map((point) => mapStagePoint(point, fit));
      for (const point of mapped) {
        expect(point.x, scenario.name).toBeGreaterThanOrEqual(0);
        expect(point.y, scenario.name).toBeGreaterThanOrEqual(0);
        expect(point.x, scenario.name).toBeLessThanOrEqual(
          PHONE_PORTRAIT.width,
        );
        expect(point.y, scenario.name).toBeLessThanOrEqual(
          PHONE_PORTRAIT.height,
        );
      }
    }
  });

  it("and a LANDSCAPE phone, at a different scale", () => {
    for (const scenario of Object.values(SCENARIOS)) {
      const ctx = contextFor(scenario, phoneOverridesFor(scenario));
      const stage = scenario.stageSize(ctx.params, ctx.layout);
      const portrait = fitStage(stage, PHONE_PORTRAIT);
      const landscape = fitStage(stage, PHONE_LANDSCAPE);
      expect(landscape.scale).not.toBeCloseTo(portrait.scale, 3);
      for (const point of scenario
        .samplePoints(ctx)
        .map((p) => mapStagePoint(p, landscape))) {
        expect(point.x, scenario.name).toBeGreaterThanOrEqual(0);
        expect(point.y, scenario.name).toBeGreaterThanOrEqual(0);
        expect(point.x, scenario.name).toBeLessThanOrEqual(
          PHONE_LANDSCAPE.width,
        );
        expect(point.y, scenario.name).toBeLessThanOrEqual(
          PHONE_LANDSCAPE.height,
        );
      }
    }
  });

  it("the OLD behaviour is what fails: unfitted, a portrait phone loses most of S1's grid", () => {
    // Regression pin for the whole workstream. Without the fit, the sprite grid is laid out at its
    // authored size in a 412 px viewport and most sample points are off screen — which is why the
    // device runner used to force-emulate 1280x800 instead.
    const ctx = contextFor(atlasSprites, {}, UNFITTED_DESKTOP);
    const points = atlasSprites.samplePoints(ctx);
    const offScreen = points.filter((point) => point.x > PHONE_PORTRAIT.width);
    expect(offScreen.length).toBeGreaterThan(points.length / 2);
  });
});

describe("resolveViewportPolicy", () => {
  // The one asymmetry in the whole workstream, pinned: desktop stays reproducible, the phone stops
  // being lied to about its own size.
  it("ci: fixed 1280x800, EMULATED, stage used 1:1", () => {
    expect(resolveViewportPolicy({ kind: "ci" })).toEqual({
      viewport: DEFAULT_CI_VIEWPORT,
      emulate: true,
      fit: false,
    });
  });

  it("device: the phone's OWN viewport (no emulation), stage fitted into it", () => {
    const policy = resolveViewportPolicy({ kind: "device" });
    expect(policy.emulate).toBe(false);
    expect(policy.fit).toBe(true);
  });

  it("an explicit --viewport re-enables emulation on a device run", () => {
    const policy = resolveViewportPolicy({
      kind: "device",
      viewport: { width: 800, height: 600 },
    });
    expect(policy.emulate).toBe(true);
    expect(policy.viewport).toEqual({ width: 800, height: 600 });
    // …and the fit still applies, so the scenario fits the forced viewport too.
    expect(policy.fit).toBe(true);
  });

  it("--fit opts a desktop run in; --no-fit opts a device run out", () => {
    expect(resolveViewportPolicy({ kind: "ci", fit: true }).fit).toBe(true);
    expect(resolveViewportPolicy({ kind: "device", fit: false }).fit).toBe(
      false,
    );
  });
});

describe("sameGeometry: what actually makes two repeats comparable", () => {
  const stage = { width: 1064, height: 544 };

  it("tolerates Android's collapsing URL bar when the scale did not move", () => {
    // The phone reports a shorter viewport on a later repeat because the toolbar hid. The fit is
    // width-bound here, so the raster scale is identical and the repeat is still the same
    // experiment — only the letterbox bars moved.
    const before = fitStage(stage, { width: 412, height: 883 });
    const after = fitStage(stage, { width: 412, height: 800 });
    expect(after.scale).toBeCloseTo(before.scale, 10);
    expect(sameGeometry(before, after)).toBe(true);
  });

  it("still rejects a genuine change of raster scale", () => {
    expect(
      sameGeometry(
        fitStage(stage, { width: 412, height: 883 }),
        fitStage(stage, { width: 380, height: 883 }),
      ),
    ).toBe(false);
  });
});

describe("gridShapeFor: the grid follows the viewport's aspect", () => {
  it("a portrait viewport gets a portrait grid of the SAME cells", () => {
    const shape = gridShapeFor(
      50,
      1,
      PHONE_PORTRAIT.width / PHONE_PORTRAIT.height,
    );
    expect(shape.columns).toBe(5);
    expect(shape.rows).toBe(10);
    // The count is an input, never a result.
    expect(shape.columns * shape.rows).toBeGreaterThanOrEqual(50);
  });

  it("a landscape viewport gets a landscape grid", () => {
    const shape = gridShapeFor(
      50,
      1,
      PHONE_LANDSCAPE.width / PHONE_LANDSCAPE.height,
    );
    expect(shape.columns).toBeGreaterThan(shape.rows);
  });

  it("is continuous in the aspect rather than two hardcoded cases", () => {
    // Sweeping the aspect from tall to wide must never make the grid narrower.
    let previous = 0;
    for (const aspect of [0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5]) {
      const { columns } = gridShapeFor(50, 1, aspect);
      expect(columns).toBeGreaterThanOrEqual(previous);
      previous = columns;
    }
  });

  it("a square viewport gets a square-ish grid", () => {
    const { columns, rows } = gridShapeFor(49, 1, 1);
    expect(columns).toBe(7);
    expect(rows).toBe(7);
  });

  it("respects a NON-square cell aspect (S3's 258x126 nine-patch cells)", () => {
    // With cells twice as wide as they are tall, a square viewport wants FEWER columns than rows.
    const { columns, rows } = gridShapeFor(20, 258 / 126, 1);
    expect(columns).toBeLessThan(rows);
  });

  it("never returns zero columns, whatever it is asked", () => {
    for (const [count, cell, viewport] of [
      [1, 1, 1],
      [50, 1, 0.01],
      [50, 1, 100],
      [0, 1, 1],
      [50, 0, 1],
    ] as const) {
      const shape = gridShapeFor(count, cell, viewport);
      expect(shape.columns).toBeGreaterThanOrEqual(1);
      expect(shape.rows).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("scenario grids adapt without changing the workload", () => {
  it("S1 keeps the authored 10x5 when the run is NOT fitted (desktop stays comparable)", () => {
    const params = resolveParams(atlasSprites, {});
    expect(spriteGridShape(params, UNFITTED_DESKTOP)).toEqual({
      columns: 10,
      rows: 5,
    });
    expect(atlasSprites.stageSize(params, UNFITTED_DESKTOP)).toEqual({
      width: 1064,
      height: 544,
    });
  });

  it("S1 turns portrait on a portrait phone, with the same 50 sprites", () => {
    const params = resolveParams(atlasSprites, {});
    const shape = spriteGridShape(params, FITTED_PORTRAIT);
    expect(shape).toEqual({ columns: 5, rows: 10 });
    const stage = atlasSprites.stageSize(params, FITTED_PORTRAIT);
    expect(stage.height).toBeGreaterThan(stage.width);
    // Same sprite count: every one of them still has a sample point.
    expect(contextFor(atlasSprites, {}, FITTED_PORTRAIT).params.mounted).toBe(
      50,
    );
    expect(
      atlasSprites.samplePoints(contextFor(atlasSprites, {}, FITTED_PORTRAIT)),
    ).toHaveLength(50);
  });

  it("and that portrait grid FILLS the phone instead of banding across it", () => {
    const params = resolveParams(atlasSprites, {});
    const landscapeStage = atlasSprites.stageSize(params, UNFITTED_DESKTOP);
    const portraitStage = atlasSprites.stageSize(params, FITTED_PORTRAIT);
    const before = fitStage(landscapeStage, PHONE_PORTRAIT);
    const after = fitStage(portraitStage, PHONE_PORTRAIT);
    // The user's complaint, quantified: the landscape grid covers a fifth of the screen.
    const coverage = (fit: { fitted: { width: number; height: number } }) =>
      (fit.fitted.width * fit.fitted.height) /
      (PHONE_PORTRAIT.width * PHONE_PORTRAIT.height);
    expect(coverage(before)).toBeLessThan(0.3);
    expect(coverage(after)).toBeGreaterThan(0.9);
    // …and the sprites are rastered nearly twice as large, which is the point.
    expect(after.scale).toBeGreaterThan(before.scale * 1.8);
  });

  it("S3's nine-patch grid adapts too, and stays 4 wide unfitted", () => {
    const params = resolveParams(ninePatchAtlas, {});
    expect(patchGridShape(params, UNFITTED_DESKTOP)).toEqual({
      columns: 4,
      rows: 5,
    });
    const portrait = patchGridShape(params, FITTED_PORTRAIT);
    expect(portrait.columns).toBeLessThan(4);
    expect(portrait.rows).toBeGreaterThan(5);
    // Same 20 nodes.
    expect(
      ninePatchAtlas.samplePoints(
        contextFor(ninePatchAtlas, {}, FITTED_PORTRAIT),
      ),
    ).toHaveLength(20);
  });

  it("every scenario reports the grid it used", () => {
    for (const scenario of Object.values(SCENARIOS)) {
      const params = resolveParams(scenario, {});
      const shape = scenario.gridShape?.(params, FITTED_PORTRAIT);
      expect(shape, scenario.name).toBeDefined();
      expect(shape?.columns, scenario.name).toBeGreaterThanOrEqual(1);
    }
  });
});
