// @vitest-environment node
//
// The scenario-side pure functions. Everything asserted here is something a scenario could get
// silently WRONG while still producing a plausible-looking table: a scale curve that never moves, a
// "varied" sizing mode that is secretly uniform, a slice decomposition that does not cover the box,
// sample points that describe geometry the screenshot does not have.

import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import {
  ancestorRescale,
  atlasSprites,
  blobQualityFor,
  blobTypeFor,
  churnCells,
  churnCellsFor,
  counterDelta,
  EFFECTS_LIFETIME_S,
  EFFECTS_MECHANISMS,
  EFFECTS_SEED_BASE,
  effectsCanvasPad,
  effectsGridSize,
  effectsRuntime,
  effectsSamplePoints,
  effectsSlotPx,
  effectsSpec,
  effectsStageSize,
  getScenario,
  largeImageCoexistence,
  mechanismsOf,
  ninePatchAtlas,
  ninePatchSceneText,
  nineSlices,
  particleCounters,
  patchBoxes,
  rescaleKeyframesCss,
  rescaleScaleAt,
  resolveParams,
  SCENARIOS,
  type ScenarioContext,
  STATIC_SURFACE_MECHANISMS,
  SURFACE_PX,
  shaderCounters,
  staticSurfaces,
  surfaceBox,
  surfaceGridSize,
  usesImgElement,
  usesUniformRegions,
  usesWorkerBake,
} from "../src/scenarios";

const SCHEDULE = { periodMs: 1000, rampMs: 300, holdMs: 200, scale: 1.2 };

function contextFor(
  scenario: { params: Record<string, { default: string | number | boolean }> },
  overrides: Record<string, string | number> = {},
): ScenarioContext {
  const params = resolveParams(scenario as never, overrides);
  // Unfitted, like a desktop run: these assertions are about the authored geometry.
  const layout = { viewport: { width: 1280, height: 800 }, fit: false };
  return {
    // No DOM in this environment: every function exercised below reads params/fixture only, and the
    // WeakMap lookups the scenarios do against this object simply miss.
    root: {} as HTMLElement,
    params,
    layout,
    stage:
      (
        scenario as unknown as {
          stageSize?: (p: never, l: never) => { width: number; height: number };
        }
      ).stageSize?.(params as never, layout as never) ?? layout.viewport,
    fixture: {
      pageUrl: "/fixture/atlas.png",
      pageSize: { width: 4096, height: 4096 },
      regions: Array.from({ length: 100 }, (_, i) => ({
        x: (i % 10) * 409,
        y: Math.floor(i / 10) * 409,
        width: 380,
        height: 360,
      })),
    },
    mark: () => {},
  };
}

describe("scenario registry", () => {
  it("registers all nine scenarios and their mechanisms", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([
      "ancestor-rescale",
      "atlas-sprites",
      "effects-runtime",
      "effects-webgpu",
      "effects-webgpu-runtime",
      "large-image-coexistence",
      "nine-patch-atlas",
      "static-surfaces",
      "text-render",
    ]);
    expect(mechanismsOf(atlasSprites)).toEqual([
      "region-blob",
      "page-crop",
      "canvas",
    ]);
    expect(mechanismsOf(ninePatchAtlas)).toEqual([
      "gsw-nine-patch",
      "slice-blob",
      "canvas",
    ]);
    expect(mechanismsOf(staticSurfaces)).toEqual([
      "canvas-2d",
      "canvas-bitmaprenderer",
      "img-webp",
      "img-png",
      "img-worker-webp",
    ]);
  });

  it("rejects a mechanism the scenario does not declare", () => {
    expect(() => resolveParams(atlasSprites, { mechanism: "webgl" })).toThrow(
      /not one of/,
    );
    expect(() => getScenario("nope")).toThrow(/unknown scenario/);
  });

  it("keeps S1's defaults, so its published reference reading still means something", () => {
    const params = resolveParams(atlasSprites, {});
    expect(params).toMatchObject({
      mechanism: "page-crop",
      mounted: 50,
      animated: 10,
      regions: 100,
      atlasPage: 4096,
      scaleDiversity: "per-region",
    });
  });
});

describe("scaleDiversity", () => {
  it("maps `shared` to an atlas generated WITHOUT region jitter", () => {
    // The isolation is a FIXTURE switch: same sprite geometry, different region rects, so the only
    // thing that changes is how many distinct background-sizes exist.
    expect(usesUniformRegions({ scaleDiversity: "shared" })).toBe(true);
    expect(usesUniformRegions({ scaleDiversity: "per-region" })).toBe(false);
    expect(usesUniformRegions({})).toBe(false);
  });
});

describe("rescaleScaleAt", () => {
  it("ramps up, holds, ramps down and rests", () => {
    expect(rescaleScaleAt(0, SCHEDULE)).toBe(1);
    expect(rescaleScaleAt(150, SCHEDULE)).toBeCloseTo(1.1, 6);
    expect(rescaleScaleAt(300, SCHEDULE)).toBe(1.2);
    expect(rescaleScaleAt(400, SCHEDULE)).toBe(1.2);
    expect(rescaleScaleAt(650, SCHEDULE)).toBeCloseTo(1.1, 6);
    expect(rescaleScaleAt(800, SCHEDULE)).toBe(1);
    expect(rescaleScaleAt(950, SCHEDULE)).toBe(1);
  });

  it("repeats every period", () => {
    for (const t of [0, 150, 300, 400, 650, 800, 950]) {
      expect(rescaleScaleAt(t + 3000, SCHEDULE)).toBeCloseTo(
        rescaleScaleAt(t, SCHEDULE),
        9,
      );
    }
  });

  it("actually MOVES across a window of frames", () => {
    // The failure this test exists for: a curve that returns a constant makes the whole scenario
    // measure a static page while every other number in the report still looks reasonable.
    const values = new Set(
      Array.from({ length: 60 }, (_, i) =>
        rescaleScaleAt(i * 16.67, SCHEDULE).toFixed(4),
      ),
    );
    expect(values.size).toBeGreaterThan(20);
  });

  it("degrades safely when the ramp is zero", () => {
    const instant = { periodMs: 100, rampMs: 0, holdMs: 40, scale: 2 };
    expect(rescaleScaleAt(0, instant)).toBe(2);
    expect(rescaleScaleAt(50, instant)).toBe(1);
  });

  it("emits the same curve as keyframes for the compositor control arm", () => {
    const css = rescaleKeyframesCss("x", SCHEDULE);
    expect(css).toContain("@keyframes x");
    expect(css).toContain("scale(1.2)");
    expect(css).toContain("30.0000%");
    expect(css).toContain("50.0000%");
    expect(css).toContain("80.0000%");
  });
});

describe("atlas-sprites sample points", () => {
  it("puts one point at each sprite centre, inside the viewport", () => {
    const ctx = contextFor(atlasSprites);
    const points = atlasSprites.samplePoints(ctx);
    expect(points).toHaveLength(50);
    expect(points[0]).toEqual({ x: 64, y: 64 });
    for (const point of points) {
      expect(point.x).toBeLessThan(1280);
      expect(point.y).toBeLessThan(800);
    }
  });

  it("stays inside the viewport at the peak ancestor scale", () => {
    // S2 multiplies these by the live scale before handing them to the presence guard; a grid that
    // grew off screen at 1.2x would report a correct render as a blank page.
    const points = ancestorRescale.samplePoints(contextFor(ancestorRescale));
    for (const point of points) {
      expect(point.x * 1.2).toBeLessThan(1280);
      expect(point.y * 1.2).toBeLessThan(800);
    }
  });
});

describe("large-image-coexistence sample points", () => {
  it("samples the bare background as well as the sprites", () => {
    // Without the background points a run where the big image failed to load would still pass the
    // presence guard on the sprites alone — and that image is the entire subject of the scenario.
    const ctx = contextFor(largeImageCoexistence);
    const points = largeImageCoexistence.samplePoints(ctx);
    expect(points).toHaveLength(58);
    const belowTheSprites = points.filter((point) => point.y > 560);
    expect(belowTheSprites).toHaveLength(8);
  });

  it("asks the runner for a 2520x1080 background", () => {
    const params = resolveParams(largeImageCoexistence, {});
    expect(largeImageCoexistence.backgroundFixture?.(params)).toEqual({
      width: 2520,
      height: 1080,
    });
    expect(largeImageCoexistence.watchImageUrl).toBe("/fixture/background.png");
  });
});

describe("nine-patch geometry", () => {
  it("gives every node its own size in `varied` and one size in `uniform`", () => {
    const varied = patchBoxes(20, "varied");
    const uniform = patchBoxes(20, "uniform");
    const variedSizes = new Set(varied.map((b) => `${b.width}x${b.height}`));
    const uniformSizes = new Set(uniform.map((b) => `${b.width}x${b.height}`));
    // The isolation only works if `varied` really is varied: one scaling of the sheet per size.
    expect(variedSizes.size).toBeGreaterThan(10);
    expect(uniformSizes.size).toBe(1);
    // Positions are identical either way, so the two modes stay comparable.
    expect(varied.map((b) => `${b.left},${b.top}`)).toEqual(
      uniform.map((b) => `${b.left},${b.top}`),
    );
  });

  it("keeps every node on screen at the peak scale", () => {
    for (const box of patchBoxes(20, "varied")) {
      expect((box.left + box.width) * 1.2).toBeLessThanOrEqual(1280);
      expect((box.top + box.height) * 1.2).toBeLessThanOrEqual(800);
    }
  });

  it("decomposes a box into nine slices that tile it exactly", () => {
    const sheet = { width: 4096, height: 4096 };
    const slices = nineSlices({ width: 200, height: 100 }, 24, sheet);
    expect(slices).toHaveLength(9);
    const area = slices.reduce(
      (sum, slice) => sum + slice.dest.width * slice.dest.height,
      0,
    );
    expect(area).toBe(200 * 100);
    for (const { source } of slices) {
      expect(source.x).toBeGreaterThanOrEqual(0);
      expect(source.y).toBeGreaterThanOrEqual(0);
      expect(source.x + source.width).toBeLessThanOrEqual(sheet.width);
      expect(source.y + source.height).toBeLessThanOrEqual(sheet.height);
    }
    // The centre slice is what makes this scenario expensive: 4048x4048 of source stretched into a
    // 152x52 destination.
    const centre = slices[4];
    expect(centre.source.width).toBe(4048);
    expect(centre.dest.width).toBe(152);
  });

  it("authors a scene the real parser accepts", () => {
    // The `gsw-nine-patch` arm feeds this text to the shipped parser -> layout -> html chain, so a
    // scene the parser rejects would silently become a page with no nine-patches on it.
    const scene = parseGodotTextScene(
      ninePatchSceneText(patchBoxes(20, "varied"), 24, {
        width: 1280,
        height: 800,
      }),
    );
    expect(scene.diagnostics).toEqual([]);
    expect(scene.nodes).toHaveLength(21);
    expect(scene.nodes[1].type).toBe("NinePatchRect");
    // Parser output preserves raw Godot property names, as a name/value list.
    const margins = scene.nodes[1].properties.filter((property) =>
      property.name.startsWith("patch_margin_"),
    );
    expect(margins).toHaveLength(4);
    expect(margins.every((property) => property.value === 24)).toBe(true);
  });

  it("asks the runner for the opaque sheet the presence guard can sample", () => {
    const params = resolveParams(ninePatchAtlas, {});
    expect(ninePatchAtlas.backgroundFixture?.(params)).toEqual({
      width: 4096,
      height: 4096,
    });
  });
});

describe("static-surfaces geometry", () => {
  const PORTRAIT = { viewport: { width: 349, height: 657 }, fit: true };
  const DESKTOP = { viewport: { width: 1280, height: 800 }, fit: false };

  it("puts one sample point at every surface centre", () => {
    const ctx = contextFor(staticSurfaces);
    const points = staticSurfaces.samplePoints(ctx);
    expect(points).toHaveLength(24);
    expect(points[0]).toEqual({
      x: 16 + SURFACE_PX / 2,
      y: 16 + SURFACE_PX / 2,
    });
    const distinct = new Set(points.map((p) => `${p.x},${p.y}`));
    expect(distinct.size).toBe(24);
  });

  it("keeps the authored 8-column grid unfitted and follows the aspect when fitted", () => {
    const params = resolveParams(staticSurfaces, {});
    expect(staticSurfaces.gridShape?.(params, DESKTOP)).toEqual({
      columns: 8,
      rows: 3,
    });
    // Portrait: taller than wide, same 24 cells. The COUNT is a parameter and never a result.
    const portrait = staticSurfaces.gridShape?.(params, PORTRAIT);
    expect(portrait?.columns).toBeLessThan(portrait?.rows ?? 0);
    expect(
      (portrait?.columns ?? 0) * (portrait?.rows ?? 0),
    ).toBeGreaterThanOrEqual(24);
  });

  it("wraps the churn strip inside the surface grid's width", () => {
    // The failure this exists for: a single 24-cell row is ~1250 px wide, which on a portrait phone
    // would set the stage width and drag the fit scale from ~0.61 to ~0.28 — the scenario would be
    // rastered at a third of the scale the device actually uses.
    for (const layout of [DESKTOP, PORTRAIT]) {
      const params = resolveParams(staticSurfaces, {});
      const grid = surfaceGridSize(params, layout);
      const cells = churnCells(params, layout);
      expect(cells).toHaveLength(24);
      for (const cell of cells) {
        expect(cell.left + 44).toBeLessThanOrEqual(grid.width);
        expect(cell.top).toBeGreaterThanOrEqual(grid.height);
      }
      // ...and the strip really does wrap on a portrait stage rather than being one long row.
      const rows = new Set(cells.map((cell) => cell.top));
      expect(rows.size).toBe(layout === PORTRAIT ? 3 : 2);
    }
  });

  it("keeps the fitted portrait stage close to the phone's aspect", () => {
    // The whole reason the strip wraps. Anything much below ~0.5 here means the stage box grew in
    // one axis and the run would be measured at a raster scale the device never uses.
    const params = resolveParams(staticSurfaces, {});
    const stage = staticSurfaces.stageSize(params, PORTRAIT);
    const scale = Math.min(349 / stage.width, 657 / stage.height);
    expect(scale).toBeGreaterThan(0.5);
  });

  it("overlaps neighbours without moving the first cell", () => {
    const plain = surfaceBox(1, 8, false);
    const overlapped = surfaceBox(1, 8, true);
    expect(surfaceBox(0, 8, false)).toEqual(surfaceBox(0, 8, true));
    expect(overlapped.left).toBeLessThan(plain.left);
    // An overlapping grid is strictly smaller, so its stage box must be too.
    const overlapParams = resolveParams(staticSurfaces, { overlap: "true" });
    const plainParams = resolveParams(staticSurfaces, {});
    expect(surfaceGridSize(overlapParams, DESKTOP).width).toBeLessThan(
      surfaceGridSize(plainParams, DESKTOP).width,
    );
  });

  it("routes each mechanism to the element and encoder it claims to use", () => {
    expect(usesImgElement("img-webp")).toBe(true);
    expect(usesImgElement("img-png")).toBe(true);
    expect(usesImgElement("img-worker-webp")).toBe(true);
    expect(usesImgElement("canvas-2d")).toBe(false);
    expect(usesImgElement("canvas-bitmaprenderer")).toBe(false);
    // WebP is the LOSSLESS format here — measured in probes/bake-probe.html, `toBlob("image/webp")`
    // with no quality argument round-trips rgb and alpha at exactly 0 error, in fewer bytes than
    // PNG. Getting this pair backwards would silently make the fast arm the lossy one.
    expect(blobTypeFor("img-webp")).toBe("image/webp");
    expect(blobTypeFor("img-png")).toBe("image/png");
    expect(blobTypeFor("img-worker-webp")).toBe("image/webp");
  });

  it("pins BOTH webp arms to lossless, so the pair differs only in thread", () => {
    // Measured in probes/bake-probe.html: `toBlob(cb, "image/webp")` and
    // `convertToBlob({type:"image/webp"})` have DIFFERENT defaults in Chrome — 41.9 KB/region at rgb
    // error 71 against 185.3 KB at error 0. The inline arm uses one call and the worker arm the
    // other, so without an explicit quality the two would encode different images with different
    // codecs and the gap between them would not be the thread. `toBlob(..., 1)` was measured
    // byte-identical to `convertToBlob`.
    expect(blobQualityFor("img-webp")).toBe(1);
    expect(blobQualityFor("img-worker-webp")).toBe(1);
    // PNG has no quality argument and needs none; passing one would be noise, not rigour.
    expect(blobQualityFor("img-png")).toBeUndefined();
  });

  it("moves the encode off-thread ONLY on the worker arm", () => {
    // The worker arm's whole claim is "same element, same bytes, different thread". If it ever
    // stopped being an <img> arm it would win readyMs for the wrong reason, and if a canvas arm
    // picked up the worker the layer comparison would be measuring two changes at once.
    expect(usesWorkerBake("img-worker-webp")).toBe(true);
    for (const mechanism of [
      "canvas-2d",
      "canvas-bitmaprenderer",
      "img-webp",
      "img-png",
    ]) {
      expect(usesWorkerBake(mechanism)).toBe(false);
    }
    expect(STATIC_SURFACE_MECHANISMS.filter(usesWorkerBake)).toEqual([
      "img-worker-webp",
    ]);
    expect(STATIC_SURFACE_MECHANISMS.filter(usesImgElement)).toEqual([
      "img-webp",
      "img-png",
      "img-worker-webp",
    ]);
  });

  it("defaults to the strictly-static case, with alpha on", () => {
    // `updateEveryMs: 0` is the question the scenario was built for. A non-zero default would
    // quietly measure the update path instead and every published number would mean something else.
    expect(resolveParams(staticSurfaces, {})).toMatchObject({
      mechanism: "canvas-2d",
      surfaces: 24,
      churn: 24,
      alpha: true,
      overlap: false,
      updateEveryMs: 0,
      // Off by default: one frame for every surface changes what `presented.nonEmptyRatio` means,
      // so a shared run is comparable only to another shared run.
      sharedFrames: false,
      // Off by default: a one-at-a-time prepare leaves the main thread idle across every worker
      // round trip, which would make the worker arm slower by construction rather than by measure.
      serialBake: false,
      // FOUR, not one. A single worker was measured and lost to encoding inline on both the probe
      // and this scenario; defaulting to it would publish the degenerate case as the proposal.
      bakeWorkers: 4,
    });
  });

  it("coerces the string booleans a URL round trip produces", () => {
    // serve.ts stringifies every param into the query and the in-page reader only coerces numerics,
    // so `alpha` reaches scenario code as "true"/"false". A bare `=== true` would read every device
    // run as opaque.
    expect(resolveParams(staticSurfaces, { alpha: "false" })).toMatchObject({
      alpha: false,
    });
    expect(resolveParams(staticSurfaces, { overlap: "true" })).toMatchObject({
      overlap: true,
    });
    expect(
      resolveParams(staticSurfaces, {
        sharedFrames: "true",
        serialBake: "true",
      }),
    ).toMatchObject({ sharedFrames: true, serialBake: true });
  });

  it("leaves the stage geometry untouched by the new params", () => {
    // `sharedFrames` changes what each surface SHOWS, never where it is. If it moved the stage box
    // the shared and unshared runs would be rastered at different scales and could not be compared
    // at all — which is the one comparison the param exists for.
    const plain = resolveParams(staticSurfaces, {});
    const shared = resolveParams(staticSurfaces, { sharedFrames: "true" });
    for (const layout of [DESKTOP, PORTRAIT]) {
      expect(staticSurfaces.stageSize(shared, layout)).toEqual(
        staticSurfaces.stageSize(plain, layout),
      );
      expect(staticSurfaces.gridShape?.(shared, layout)).toEqual(
        staticSurfaces.gridShape?.(plain, layout),
      );
    }
  });

  it("rejects a mechanism it does not declare", () => {
    expect(() =>
      resolveParams(staticSurfaces, { mechanism: "img-jpeg" }),
    ).toThrow(/not one of/);
  });
});

describe("effects-runtime: the isolation, proved without a browser", () => {
  const PORTRAIT = { viewport: { width: 412, height: 883 }, fit: true };
  const LANDSCAPE = { viewport: { width: 883, height: 412 }, fit: true };
  const DESKTOP = { viewport: { width: 1280, height: 800 }, fit: false };
  const paramsFor = (overrides: Record<string, string | number> = {}) =>
    resolveParams(effectsRuntime, overrides);

  it("registers the scenario and its four arms, in order", () => {
    expect(getScenario("effects-runtime")).toBe(effectsRuntime);
    expect(mechanismsOf(effectsRuntime)).toEqual(EFFECTS_MECHANISMS);
    expect(EFFECTS_MECHANISMS).toEqual([
      "particles-live",
      "particles-simcap",
      "particles-frozen",
      "shaders-live",
    ]);
    expect(() =>
      resolveParams(effectsRuntime, { mechanism: "particles-slow" }),
    ).toThrow(/not one of/);
  });

  // THE contract test of the whole scenario. `live - simcap` is only the CPU sim if the two arms
  // differ in NOTHING BUT the sim rate: same particle count, same spawn timing, same seeds, same
  // sprite, same blend, same canvas. One field may differ, and this is the assertion that says so.
  it("gives the live and simcap arms byte-identical specs apart from `fixedFps`", () => {
    const live = paramsFor({ mechanism: "particles-live" });
    const simcap = paramsFor({ mechanism: "particles-simcap" });
    for (const index of [0, 1, 5, 11, 37]) {
      const a = { ...effectsSpec(live, index) };
      const b = { ...effectsSpec(simcap, index) };
      expect(a.fixedFps).not.toBe(b.fixedFps);
      a.fixedFps = undefined;
      b.fixedFps = undefined;
      expect(b).toEqual(a);
    }
  });

  it("caps the sim ONLY on the simcap arm", () => {
    for (const mechanism of [
      "particles-live",
      "particles-frozen",
      "shaders-live",
    ]) {
      // 0 is how `normalizeParticleConfig` spells "Godot's default 30 Hz" — the uncapped sim.
      expect(effectsSpec(paramsFor({ mechanism }), 0).fixedFps).toBe(0);
    }
    expect(
      effectsSpec(paramsFor({ mechanism: "particles-simcap" }), 0).fixedFps,
    ).toBe(1);
    expect(
      effectsSpec(paramsFor({ mechanism: "particles-simcap", simCapHz: 3 }), 0)
        .fixedFps,
    ).toBe(3);
  });

  it("never lets `simCapHz` round down to 0, which would silently BE the live arm", () => {
    // `normalizeParticleConfig` rounds `fixedFps`, and 0 there means 30 Hz. A `simCapHz` of 0.4
    // would therefore make the simcap arm the live arm under another name, and the table would read
    // "the sim is free".
    for (const simCapHz of [0, 0.4, -5]) {
      expect(
        effectsSpec(paramsFor({ mechanism: "particles-simcap", simCapHz }), 0)
          .fixedFps,
      ).toBe(1);
    }
  });

  it("seeds every system differently, so N systems are not one sim drawn N times", () => {
    const params = paramsFor();
    const seeds = Array.from(
      { length: 12 },
      (_, i) => effectsSpec(params, i).seed,
    );
    expect(seeds[0]).toBe(EFFECTS_SEED_BASE);
    expect(new Set(seeds).size).toBe(12);
    // The frozen arm's static-frame cache is keyed by the spec: identical seeds would collapse N
    // systems into one warm + one draw + N blits, and the compositing floor would be measured for
    // a single system.
    const frozen = paramsFor({ mechanism: "particles-frozen" });
    expect(new Set(seeds).size).toBe(
      new Set(Array.from({ length: 12 }, (_, i) => effectsSpec(frozen, i).seed))
        .size,
    );
  });

  it("carries the over-life ramps only when asked, and never moves the geometry", () => {
    const ramps = effectsSpec(paramsFor({ overLife: "ramps" }), 0);
    const none = effectsSpec(paramsFor({ overLife: "none" }), 0);
    expect(ramps.colorRamp?.length).toBeGreaterThan(1);
    expect(ramps.alphaCurve?.length).toBeGreaterThan(1);
    expect(ramps.scaleCurve?.length).toBeGreaterThan(1);
    for (const key of [
      "colorRamp",
      "colorInitialRamp",
      "alphaCurve",
      "scaleCurve",
      "scaleCurveX",
      "scaleCurveY",
      "hueCurve",
      "colorLut",
    ] as const) {
      expect(none[key], key).toBeUndefined();
    }
    // The scale curve PEAKS AT 1, so `spriteExtentPad` returns the same pad either way: a
    // non-geometric parameter must not change the canvas pixel count, or the two modes stop being
    // comparable at equal pixels.
    expect(effectsCanvasPad(paramsFor({ overLife: "none" }))).toBe(
      effectsCanvasPad(paramsFor({ overLife: "ramps" })),
    );
    for (const layout of [DESKTOP, PORTRAIT]) {
      expect(effectsStageSize(paramsFor({ overLife: "none" }), layout)).toEqual(
        effectsStageSize(paramsFor({ overLife: "ramps" }), layout),
      );
      expect(effectsStageSize(paramsFor({ blend: 1 }), layout)).toEqual(
        effectsStageSize(paramsFor({ blend: 0 }), layout),
      );
    }
  });

  it("keeps every particle's whole life inside its own cell", () => {
    // A spray that outran its canvas would be CLIPPED, so the arms would stop drawing the same
    // pixels and the draw-pipeline number would be a comparison of two different workloads.
    const params = paramsFor();
    const spec = effectsSpec(params, 0);
    const travel = Number(spec.initialVelocityMax) * EFFECTS_LIFETIME_S;
    expect(travel).toBeLessThanOrEqual(Number(params.cellPx) / 2);
    expect(spec.gravity).toEqual([0, 0]);
    // Symmetric spray about the cell centre, emitted from a POINT there.
    expect(spec.spread).toBe(180);
    expect(spec.emissionShape).toBe(0);
    expect(spec.originX).toBe(Number(params.cellPx) / 2);
    expect(spec.originY).toBe(Number(params.cellPx) / 2);
    // Continuous respawn: a just-born particle always sits at that centre, which is where the
    // presence guard is aimed.
    expect(spec.explosiveness).toBe(0);
    expect(spec.randomness).toBe(0);
    expect(spec.preprocess).toBeGreaterThanOrEqual(EFFECTS_LIFETIME_S);
  });

  it("declares a stage that contains every CANVAS, not just every sample point", () => {
    // Three ways this could be silently wrong: a stage sized for the node boxes (so the runtime's
    // own canvas pad hangs over the clip edge), a stage that forgot the churn strip (so the strip is
    // clipped and the frozen arm stops producing activations), or a shape that only works in one
    // orientation.
    for (const layout of [PORTRAIT, LANDSCAPE, DESKTOP]) {
      for (const overrides of [{}, { systems: 3 }, { systems: 25 }]) {
        const params = paramsFor(overrides);
        const stage = effectsStageSize(params, layout);
        const slot = effectsSlotPx(params);
        const label = `${JSON.stringify(overrides)} ${layout.viewport.width}x${layout.viewport.height}`;
        for (const point of effectsSamplePoints(params, layout)) {
          // The full canvas footprint, centred on the sample point, is inside the stage.
          expect(point.x - slot / 2, label).toBeGreaterThanOrEqual(0);
          expect(point.y - slot / 2, label).toBeGreaterThanOrEqual(0);
          expect(point.x + slot / 2, label).toBeLessThanOrEqual(stage.width);
          expect(point.y + slot / 2, label).toBeLessThanOrEqual(stage.height);
        }
        const cells = churnCellsFor(params, layout);
        const grid = effectsGridSize(params, layout);
        expect(cells.length, label).toBe(Number(params.churn));
        for (const cell of cells) {
          // The strip wraps INSIDE the grid's width (S5's rule: a wider strip would set the stage
          // width and drag the fit scale to a raster the device never uses) and sits below it.
          expect(cell.left + 44, label).toBeLessThanOrEqual(grid.width);
          expect(cell.top, label).toBeGreaterThanOrEqual(grid.height);
          expect(cell.top + 56, label).toBeLessThanOrEqual(stage.height);
        }
        expect(stage.height, label).toBeGreaterThan(grid.height);
      }
    }
  });

  it("turns portrait on a portrait phone with the SAME number of systems", () => {
    const params = paramsFor();
    expect(effectsRuntime.gridShape?.(params, DESKTOP)).toEqual({
      columns: 4,
      rows: 3,
    });
    const portrait = effectsRuntime.gridShape?.(params, PORTRAIT);
    expect(portrait?.columns).toBeLessThan(portrait?.rows ?? 0);
    expect(effectsSamplePoints(params, PORTRAIT)).toHaveLength(12);
    expect(effectsSamplePoints(params, LANDSCAPE)).toHaveLength(12);
    // …and the fitted stage stays close to the phone's own aspect, so the effects are rastered at
    // roughly the scale the device would really use.
    const stage = effectsStageSize(params, PORTRAIT);
    expect(Math.min(412 / stage.width, 883 / stage.height)).toBeGreaterThan(
      0.5,
    );
  });

  it("keeps its defaults, so the published reference reading still means something", () => {
    expect(paramsFor()).toMatchObject({
      mechanism: "particles-live",
      systems: 12,
      amount: 64,
      cellPx: 96,
      simCapHz: 1,
      overLife: "ramps",
      blend: 0,
      fps: 0,
      pacing: "timer",
      renderScale: 1,
      // NOT zero. The frozen arm parks its loop, and a run with no layer activations is rejected by
      // the report validator as "nothing was measured" — the churn strip is what keeps a correct
      // frozen run measurable.
      churn: 8,
    });
    // The canvas pad comes from the RUNTIME's own law (spriteExtentPad + emissionExtentPad over the
    // 16 px procedural dot), not from a constant in the scenario.
    expect(effectsCanvasPad(paramsFor())).toBe(12);
    expect(effectsSlotPx(paramsFor())).toBe(96 + 24);
  });
});

describe("effects-runtime: the counters each arm reports about itself", () => {
  // A `ParticleRuntimeStats`-shaped read-out, with only the fields this scenario reports. The real
  // runtimes need WebGL2, which this environment does not have; what is under test here is the
  // scenario's own key SELECTION and delta arithmetic, which is pure.
  const particleStats = (
    over: Partial<{
      draws: number;
      cacheHits: number;
      boxReads: number;
      profile: Record<string, number> | null;
    }> = {},
  ) =>
    ({
      draws: 0,
      cacheHits: 0,
      boxReads: 0,
      profile: {
        ticks: 0,
        bindings: 0,
        simSteps: 0,
        instances: 0,
        simMs: 0,
        buildMs: 0,
        glMs: 0,
        blitMs: 0,
      },
      ...over,
    }) as never;
  const shaderStats = (
    over: Partial<{
      draws: number;
      cacheHits: number;
      profile: Record<string, number> | null;
    }> = {},
  ) =>
    ({
      draws: 0,
      cacheHits: 0,
      profile: { ticks: 0, bindings: 0, glMs: 0, blitMs: 0 },
      ...over,
    }) as never;

  it("declares the metrics hook at all", () => {
    // Without it the arms' claims — "the frozen loop really parked", "only the sim was capped" —
    // are unfalsifiable from the report: the trace can show the page got cheaper and never say why.
    expect(typeof effectsRuntime.metrics).toBe("function");
  });

  it("reports particle keys on a particle arm and shader keys on the shader arm, never both", () => {
    // An absent key means NOT MEASURED, so an arm must not zero-fill the other runtime's counters: a
    // fabricated `shaderDraws: 0` on a particle arm is indistinguishable from a measured one.
    const particle = Object.keys(particleCounters(particleStats())).sort();
    const shader = Object.keys(shaderCounters(shaderStats())).sort();
    expect(particle).toEqual([
      "blitMs",
      "buildMs",
      "glMs",
      "instances",
      "particleCacheHits",
      "particleDraws",
      "profBindings",
      "profTicks",
      "simMs",
      "simSteps",
    ]);
    expect(shader).toEqual([
      "blitMs",
      "glMs",
      "profBindings",
      "profTicks",
      "shaderCacheHits",
      "shaderDraws",
    ]);
    expect(particle.filter((key) => key.startsWith("shader"))).toEqual([]);
    expect(shader.filter((key) => key.startsWith("particle"))).toEqual([]);
    expect(shader).not.toContain("simSteps");
  });

  it("omits every profile key when the runtime was not profiling, rather than reporting zeros", () => {
    // `stats().profile` is null unless `effectsProfiling` is on, and "nobody measured" must never be
    // published as "measured, cost nothing" — the same rule the runtime applies by returning null.
    const unprofiled = particleCounters(particleStats({ profile: null }));
    expect(Object.keys(unprofiled).sort()).toEqual([
      "particleCacheHits",
      "particleDraws",
    ]);
    expect(
      Object.keys(shaderCounters(shaderStats({ profile: null }))).sort(),
    ).toEqual(["shaderCacheHits", "shaderDraws"]);
    // …but never an EMPTY record: the validator rejects an empty scenario block outright.
    expect(Object.keys(unprofiled).length).toBeGreaterThan(0);
  });

  it("reports the WINDOW's share of counters that accumulate from mount", () => {
    // THE frozen arm's proof, in miniature: 12 draws happened before the window opened and none
    // inside it. A raw counter would report 12 and read as "the parked loop kept drawing".
    const atWindowStart = particleCounters(
      particleStats({ draws: 12, profile: null }),
    );
    const atWindowEnd = particleCounters(
      particleStats({ draws: 12, profile: null }),
    );
    expect(counterDelta(atWindowStart, atWindowEnd)).toEqual({
      particleDraws: 0,
      particleCacheHits: 0,
    });
    // And a live arm's draws show up as exactly what happened during the window.
    expect(
      counterDelta(
        atWindowStart,
        particleCounters(particleStats({ draws: 162, profile: null })),
      ).particleDraws,
    ).toBe(150);
  });

  it("rounds the millisecond buckets and leaves the counts exact", () => {
    const delta = counterDelta(
      {},
      particleCounters(
        particleStats({
          profile: {
            ticks: 150,
            bindings: 1800,
            simSteps: 900,
            instances: 115200,
            simMs: 41.239999,
            buildMs: 12.3456,
            glMs: 8.98765,
            blitMs: 30.00004,
          },
        }),
      ),
    );
    expect(delta.simMs).toBe(41.24);
    expect(delta.buildMs).toBe(12.35);
    expect(delta.glMs).toBe(8.99);
    expect(delta.blitMs).toBe(30);
    // Counts are events, not measurements of time — rounding them would be a lie about precision.
    expect(delta.simSteps).toBe(900);
    expect(delta.instances).toBe(115200);
    for (const value of Object.values(delta)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("drops a key it cannot subtract instead of inventing a number for it", () => {
    // Non-finite and vanished keys are both "not a measurement". The validator would reject the
    // first, and a substituted 0 for either would be a number this scenario made up.
    const delta = counterDelta(
      { particleDraws: 1, gone: 5 },
      { particleDraws: Number.NaN, kept: 7 },
    );
    expect(delta).toEqual({ kept: 7 });
  });
});
