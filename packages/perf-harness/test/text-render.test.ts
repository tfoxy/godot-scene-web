// @vitest-environment node
//
// S9's pure half: the geometry, the strings and the authored scene, all provable without a browser.
//
// Everything asserted here is something that could be silently WRONG while still producing a
// plausible table: a stage that is not exactly the viewport (so the fit quietly rescales every
// glyph), a run whose beacon leaves the stage under motion (so the presence guard blames the
// renderer for a geometry mistake), a `glyphs` parameter that does not actually change how many
// distinct glyphs are drawn (so the atlas-VRAM axis measures nothing), an authored scene whose
// Labels carry no rotation (so the whole round measures upright text), or — since the round grew a
// second script — two runs whose boxes overlap, or a Latin run set in the Han face.

import { resolveGodotSceneTree } from "@godot-scene-web/layout";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";
import { describe, expect, it } from "vitest";
import { pointsOutsideStage } from "../src/fit";
import {
  distinctGlyphCount,
  LATIN_PANGRAM,
  latinRunString,
  mechanismsOf,
  resolveParams,
  type StageLayout,
  textCellBoxes,
  textCellSize,
  textGridShape,
  textLayoutFits,
  textPlacedRuns,
  textRender,
  textRunGeometry,
  textRunString,
  textSamplePoints,
  textSceneText,
  textStageSize,
  translationAmplitude,
  translationAt,
} from "../src/scenarios";

/** The two viewports this round is measured at. */
const PHONE: StageLayout = { viewport: { width: 412, height: 883 }, fit: true };
const DESKTOP: StageLayout = {
  viewport: { width: 1280, height: 800 },
  fit: false,
};

const BEACON = "■";

describe("text-render arms", () => {
  it("declares only mechanisms that are implemented", () => {
    // A `ready()` throw aborts the WHOLE run, so an unbuilt arm listed here would turn every
    // default invocation into a failed run rather than a partial table. `hb-gpu` IS implemented —
    // what it can be missing is a docker + emscripten build output, and that is handled node-side
    // by `unavailableMechanisms` before a browser is ever launched. See `hb-gpu-build.test.ts`.
    expect(mechanismsOf(textRender)).toEqual([
      "dom",
      "canvas2d",
      "hb-atlas",
      "hb-run",
      "hb-gpu",
    ]);
  });

  it("gives the baked arms their isolation knobs", () => {
    // `bakeRotation` and `bakeShaper` are what turn one arm into a controlled experiment:
    // `bakeRotation=false` is the conventional upright atlas, and `bakeShaper=fillText` removes
    // HarfBuzz while keeping the baking, which is the only way to tell "baking helps" apart from
    // "shaping helps". Declared defaults, so `--param` is checked against them rather than typoed
    // into silence.
    expect(textRender.params.bakeRotation.default).toBe(true);
    expect(textRender.params.bakeShaper.values).toEqual([
      "harfbuzz",
      "fillText",
    ]);
    expect(textRender.params.phases.default).toBe(4);
  });

  it("defaults to 14 px, both scripts, 20 cells", () => {
    // The three numbers every table in docs/text-rendering.md is keyed to. A silent change to any
    // of them would make two runs incomparable while both looked entirely normal.
    expect(textRender.params.fontSize.default).toBe(14);
    expect(textRender.params.script.default).toBe("both");
    expect(textRender.params.script.values).toEqual(["both", "han", "latin"]);
    expect(textRender.params.labels.default).toBe(20);
  });
});

describe("text-render geometry", () => {
  it("makes the stage EXACTLY the viewport, so the fit is the identity", () => {
    // The load-bearing claim of the whole scenario: `fitScale` must read 1 on every environment,
    // because a fractional stage scale changes the raster scale that is under measurement.
    for (const layout of [PHONE, DESKTOP]) {
      const stage = textStageSize(resolveParams(textRender, {}), layout);
      expect(stage).toEqual(layout.viewport);
    }
  });

  it("stacks the two runs without overlapping their ROTATED boxes", () => {
    // Overlapping ink would put some of the Latin run inside the Han fidelity band and vice versa,
    // which silently corrupts both bands' acutance — a number that would still look plausible.
    const runs = textRunGeometry(resolveParams(textRender, {}));
    expect(runs.map((run) => run.kind)).toEqual(["han", "latin"]);
    const [han, latin] = runs;
    const hanBottom = han.offsetY + han.aabbHeight / 2;
    const latinTop = latin.offsetY - latin.aabbHeight / 2;
    expect(latinTop).toBeGreaterThan(hanBottom);
    // Centred as a stack, so a cell's content is not lopsided.
    expect(
      han.offsetY - han.aabbHeight / 2 + (latin.offsetY + latin.aabbHeight / 2),
    ).toBeCloseTo(0, 6);
  });

  it("fits 20 `both` cells on the desktop and refuses 24", () => {
    // The default is sized for 1280x800 exactly: 4x5 cells of 320x160 against a 283x143 requirement.
    const fits = (labels: number) =>
      textLayoutFits(resolveParams(textRender, { labels }), DESKTOP).fits;
    expect(fits(20)).toBe(true);
    expect(fits(24)).toBe(false);
    expect(textGridShape(resolveParams(textRender, {}), DESKTOP)).toEqual({
      columns: 4,
      rows: 5,
    });
  });

  it("fits 6 `both` cells on the phone and refuses 8", () => {
    // A 283 px cell only goes into a 412 px portrait viewport once, so the phone runs 1x6. This is
    // why the phone invocation in the docs passes `--param labels=6`.
    const fits = (labels: number) =>
      textLayoutFits(resolveParams(textRender, { labels }), PHONE).fits;
    expect(fits(6)).toBe(true);
    expect(fits(8)).toBe(false);
  });

  it("lets `script=han` keep 20 cells on the phone — the comparable workload", () => {
    // Half the cell height, so the phone can run the same LABEL count as the desktop for the Han
    // half of the workload. Without this there would be no phone number comparable to anything.
    const params = resolveParams(textRender, { script: "han", labels: 20 });
    expect(textLayoutFits(params, PHONE).fits).toBe(true);
    expect(textLayoutFits(params, DESKTOP).fits).toBe(true);
  });

  it("names the largest `labels` that fits when it refuses", () => {
    // The refusal is what a phone run hits first, so it has to say what to do about it rather than
    // only that something is wrong.
    const fit = textLayoutFits(
      resolveParams(textRender, { labels: 40 }),
      PHONE,
    );
    expect(fit.fits).toBe(false);
    expect(fit.capacity).toBe(6);
  });

  it("keeps every beacon inside the stage across the WHOLE motion", () => {
    // The screenshot is taken wherever the measured window happened to end, so a sample point that
    // only fits at rest would fail the guard for a geometry mistake on most repeats.
    for (const [layout, labels] of [
      [DESKTOP, 20],
      [PHONE, 6],
    ] as const) {
      const params = resolveParams(textRender, { labels });
      const stage = textStageSize(params, layout);
      for (let frame = 0; frame < 240; frame += 1) {
        expect(
          pointsOutsideStage(
            textSamplePoints(params, layout, { frame }),
            stage,
          ),
          `frame ${frame}`,
        ).toEqual([]);
      }
    }
  });

  it("aims each sample point at its own beacon's ink, following the motion", () => {
    // The guard samples a 5x5 DEVICE px box, which is ±0.57 CSS px on a phone — far tighter than
    // the ±0.5 em a run travels. A rest-position sample would miss, and it would miss for Han as
    // well as for Latin. So the point is the beacon INK CENTRE at the LAST DRAWN FRAME, and this
    // pins that it really tracks: the offset between two frames must equal the run's translation.
    const params = resolveParams(textRender, {});
    const fontSize = Number(params.fontSize);
    const radians = (Number(params.rotationDeg) * Math.PI) / 180;
    const rest = textSamplePoints(params, DESKTOP);
    const moved = textSamplePoints(params, DESKTOP, { frame: 37 });
    const runs = textPlacedRuns(params, DESKTOP);
    expect(moved).toHaveLength(rest.length);
    moved.forEach((point, index) => {
      const offset = translationAt(
        runs[index].cellIndex,
        37,
        fontSize,
        radians,
      );
      expect(point.x - rest[index].x).toBeCloseTo(offset.x, 6);
      expect(point.y - rest[index].y).toBeCloseTo(offset.y, 6);
    });
  });

  it("samples BOTH runs of every cell — 40 points at the default", () => {
    // 20/20 would pass with the Latin run entirely missing. 40/40 cannot.
    const params = resolveParams(textRender, {});
    expect(textSamplePoints(params, DESKTOP)).toHaveLength(40);
    expect(
      textSamplePoints(resolveParams(textRender, { script: "han" }), DESKTOP),
    ).toHaveLength(20);
  });

  it("never travels further than the declared amplitude", () => {
    const amplitude = translationAmplitude(14);
    for (let frame = 0; frame < 1000; frame += 1) {
      const offset = translationAt(3, frame, 14, Math.PI / 18);
      expect(Math.hypot(offset.x, offset.y)).toBeLessThanOrEqual(
        amplitude + 1e-9,
      );
    }
  });

  it("moves by a sub-pixel amount every frame, never repeating a phase", () => {
    // An integer step would let a glyph atlas hit the identical sub-pixel phase every frame, which
    // measures a cache hit and reports it as rendering cost.
    const phases = new Set<number>();
    for (let frame = 0; frame < 500; frame += 1) {
      const offset = translationAt(0, frame, 14, 0);
      phases.add(Math.round((offset.x - Math.floor(offset.x)) * 1e6));
    }
    expect(phases.size).toBeGreaterThan(400);
  });

  it("lays out exactly `labels` cells on a grid whose shape follows the viewport", () => {
    const params = resolveParams(textRender, { labels: 6 });
    for (const layout of [PHONE, DESKTOP]) {
      const grid = textGridShape(params, layout);
      expect(textCellBoxes(params, layout)).toHaveLength(6);
      expect(grid.columns * grid.rows).toBeGreaterThanOrEqual(6);
    }
    // The SHAPE follows the screen; the COUNT never does.
    expect(textGridShape(params, PHONE)).not.toEqual(
      textGridShape(params, DESKTOP),
    );
  });

  it("sizes a cell for the rotated runs plus their travel", () => {
    const upright = textCellSize({
      labels: 20,
      chars: 12,
      fontSize: 14,
      rotationDeg: 0,
      script: "han",
    });
    const rotated = textCellSize({
      labels: 20,
      chars: 12,
      fontSize: 14,
      rotationDeg: 10,
      script: "han",
    });
    // The box must grow vertically to hold the tilted run: a 168 px run at 10 degrees reaches
    // 29 px down on its own, against an 18.9 px line box upright.
    expect(rotated.height).toBeGreaterThan(upright.height * 1.5);
    // Width barely moves, and NOT downwards: the cosine takes 2.6 px off the run's own length while
    // the tilted line box adds 3.3 px back. Worth pinning, because "rotation makes it narrower" is
    // the intuitive-but-wrong reading, and a cell sized on it would clip.
    expect(rotated.width).toBeGreaterThan(upright.width);
    expect(rotated.width).toBeLessThan(upright.width * 1.02);
    // And `both` is taller than `han` by the Latin run plus the gap, never wider by less.
    const both = textCellSize({
      labels: 20,
      chars: 12,
      fontSize: 14,
      rotationDeg: 10,
      script: "both",
    });
    expect(both.height).toBeGreaterThan(rotated.height * 1.8);
    expect(both.width).toBeGreaterThan(rotated.width);
  });
});

describe("text-render strings", () => {
  it("leads every run with the presence beacon", () => {
    // The guard's whole validity rests on this: the beacon is a GLYPH, so it cannot render while
    // the glyph path is broken. It has to hold for the Latin run too, in a face where U+25A0 is a
    // different outline with a different advance.
    for (let index = 0; index < 32; index += 1) {
      expect(textRunString(index, 12, 1000).startsWith(BEACON)).toBe(true);
      expect(latinRunString(index).startsWith(BEACON)).toBe(true);
    }
  });

  it("is deterministic and `chars` long", () => {
    expect(textRunString(7, 12, 1000)).toBe(textRunString(7, 12, 1000));
    expect([...textRunString(7, 12, 1000)]).toHaveLength(12);
  });

  it("draws only Han from the pool after the beacon", () => {
    for (const char of [...textRunString(11, 20, 3000)].slice(1)) {
      const cp = char.codePointAt(0) as number;
      expect(cp).toBeGreaterThanOrEqual(0x4e00);
      expect(cp).toBeLessThan(0x4e00 + 3000);
    }
  });

  it("gives every Latin run a DISTINCT string of the same length", () => {
    // `hb-run` keys its baked whole-run textures by the run's text. Repeating one pangram would
    // collapse 20 textures into 1 and flatter that arm enormously — and its VRAM number would then
    // be a property of the fixture rather than of the mechanism. Same length so every run is the
    // same width (Roboto's digits are tabular), which is what `LATIN_RUN_EM_WIDTH` assumes.
    const runs = Array.from({ length: 40 }, (_, i) => latinRunString(i));
    expect(new Set(runs).size).toBe(40);
    expect(new Set(runs.map((run) => run.length)).size).toBe(1);
    for (const run of runs) {
      expect(run).toContain(LATIN_PANGRAM);
      // ASCII after the beacon, and nothing else: that is exactly the charset the Roboto fixture is
      // subset to, so anything outside it would reach the screen as `.notdef`.
      for (const char of [...run].slice(1)) {
        const cp = char.codePointAt(0) as number;
        expect(cp).toBeGreaterThanOrEqual(0x20);
        expect(cp).toBeLessThanOrEqual(0x7e);
      }
    }
  });

  it("counts distinct glyphs PER FACE", () => {
    // U+25A0 is in both fixtures and they are different outlines, so it is two atlas cells. A count
    // over bare characters would report one, and the atlas-VRAM axis would be off by a face.
    expect(
      distinctGlyphCount([
        { kind: "han", text: BEACON },
        { kind: "latin", text: BEACON },
      ]),
    ).toBe(2);
    // And `glyphs` still really bounds the Han pool — the axis the atlas comparison rests on.
    const runsFor = (glyphs: number) =>
      Array.from({ length: 20 }, (_, index) => ({
        kind: "han",
        text: textRunString(index, 12, glyphs),
      }));
    const narrow = distinctGlyphCount(runsFor(8));
    const wide = distinctGlyphCount(runsFor(2000));
    expect(narrow).toBeLessThanOrEqual(8 + 1); // + the beacon
    expect(wide).toBeGreaterThan(narrow * 10);
  });
});

describe("text-render authored scene", () => {
  const params = resolveParams(textRender, {});
  const runs = textPlacedRuns(params, DESKTOP);
  const scene = textSceneText(runs, params, textStageSize(params, DESKTOP));

  it("parses through the shipped chain into one rotated Label per RUN", () => {
    const tree = resolveGodotSceneTree(
      deriveSceneGraph(parseGodotTextScene(scene)),
    );
    const labels = tree.nodes.filter((node) => node.type === "Label");
    expect(labels).toHaveLength(40);
    labels.forEach((label, index) => {
      // Not decoration: an unrotated Label would make the dom arm measure the easy case, and the
      // table would read as "DOM is fine" for a workload nobody asked about.
      expect(label.properties.rotation_degrees).toBe(
        Number(params.rotationDeg),
      );
      expect(label.properties["theme_override_font_sizes/font_size"]).toBe(14);
      expect(label.properties.text).toBe(runs[index].text);
      // And the laid-out rect is the run box the scenario asked for, so `samplePoints` and the DOM
      // agree about where each beacon is.
      expect(label.rect.width).toBeCloseTo(runs[index].width, 3);
    });
  });

  it("binds a DIFFERENT fixture font to each script", () => {
    // One resource for both would render the pangram in Noto Sans SC: same geometry, same
    // alignment, wrong glyphs, and no column in the table would say so.
    expect(scene).toContain("NotoSansSC-bench.ttf");
    expect(scene).toContain("Roboto-bench.ttf");
    expect(scene).toContain("[gd_scene load_steps=3 format=3]");
    expect(scene).toContain('theme_override_fonts/font = ExtResource("1")');
    expect(scene).toContain('theme_override_fonts/font = ExtResource("2")');
    const hanRun = scene.slice(scene.indexOf('name="Run0"'));
    expect(hanRun.slice(0, hanRun.indexOf('name="Run1"'))).toContain(
      'ExtResource("1")',
    );
  });

  it("emits only the faces the script actually draws", () => {
    // `script=han` must not make the shipped model install Roboto: an `@font-face` for a file the
    // run never asks for is a download charged to an arm that does not use it.
    const hanParams = resolveParams(textRender, { script: "han" });
    const hanOnly = textSceneText(
      textPlacedRuns(hanParams, DESKTOP),
      hanParams,
      textStageSize(hanParams, DESKTOP),
    );
    expect(hanOnly).toContain("NotoSansSC-bench.ttf");
    expect(hanOnly).not.toContain("Roboto-bench.ttf");
    expect(hanOnly).toContain("[gd_scene load_steps=2 format=3]");
  });
});
