// @vitest-environment node
//
// The `hb-gpu` arm's pure half: WHERE it puts a glyph, and which params it refuses.
//
// PLACEMENT IS THE ACCEPTANCE CRITERION FOR THIS ARM, and it is checkable without a browser. Every
// arm in this round anchors the alphabetic baseline `baselinePx` below the run box's top and
// rotates about the run box's centre; the fidelity probe's alignment guard is what proves it, and
// `docs/text-rendering.md` records four separate rounds in which a fraction of a pixel of
// disagreement WAS the finding. `hb-gpu` reaches that placement by a different route from every
// other arm — it cannot rotate its quads on the CPU (the shader's half-pixel dilation has to see
// the same matrix), so the rotation lives in one shared model matrix and the per-run pivot is
// folded into the object-space position instead.
//
// That fold is exactly the kind of arithmetic that is plausible and wrong. So the test below
// reconstructs the model matrix and multiplies it through, and holds the result against the SAME
// expression `drawGlyphCells` uses for `hb-atlas` — to floating-point equality. If these two ever
// disagree, the probe would report it as a property of Slug rather than as a bug here.

import { describe, expect, it } from "vitest";
import {
  hbGpuObjectOrigin,
  textGpuUnsupportedParam,
  textOutlineParamRefusal,
} from "../src/scenarios/text-gpu";
// From the arm's own module, exactly as `text-gpu.ts` imports it: the point of the first test is
// that ONE definition of `glyphLocal` serves both arms, so a copy here would prove nothing.
import { glyphLocal, type RunLayout } from "../src/scenarios/text-hb";

/** S9's own geometry at the defaults: 14 px, 10 degrees, the measured Noto Sans SC baseline. */
const LAYOUT: RunLayout = {
  width: 12 * 14,
  height: 14 * 1.35,
  baselinePx: 16,
  dpr: 1,
  radians: (10 * Math.PI) / 180,
  bakeRotation: true,
};

/**
 * Where `hb-atlas` puts a glyph's origin, in device px — lifted verbatim from `drawGlyphCells`.
 *
 * Copied rather than imported because `drawGlyphCells` needs a live `AtlasRenderer` and a baked
 * atlas to be called at all. Two lines, and they are the two lines under test.
 */
function atlasScreenOrigin(
  penPx: number,
  layout: RunLayout,
  centreX: number,
  centreY: number,
): { x: number; y: number } {
  const cos = Math.cos(layout.radians);
  const sin = Math.sin(layout.radians);
  const local = glyphLocal(penPx, layout);
  return {
    x: (centreX + local.x * cos - local.y * sin) * layout.dpr,
    y: (centreY + local.x * sin + local.y * cos) * layout.dpr,
  };
}

/**
 * The frame's model matrix applied to an object-space point.
 *
 * `[xx, xy, yx, yy, tx, ty]`, the repo's `Transform2D` order, so `x' = xx*x + yx*y + tx` — the same
 * convention `rotatedQuad` and the hb-gpu package's own pixel test use. `createHbGpuText` sets
 * `[cos, sin, -sin, cos, 0, 0]`.
 */
function applyModel(
  point: { x: number; y: number },
  radians: number,
): { x: number; y: number } {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: cos * point.x - sin * point.y,
    y: sin * point.x + cos * point.y,
  };
}

describe("hb-gpu placement", () => {
  it("lands every glyph exactly where hb-atlas lands it, once the model is applied", () => {
    // Several pen positions across a run, several run centres across the stage, and both device
    // pixel ratios the round is measured at. A sign error in the pivot fold survives one sample and
    // not a grid.
    for (const dpr of [1, 2, 3.4876]) {
      for (const centre of [
        { x: 160, y: 80 },
        { x: 0, y: 0 },
        { x: 1103.5, y: 726.25 },
      ]) {
        for (const penPx of [0, 14, 77.5, 167]) {
          const layout = { ...LAYOUT, dpr };
          const screen = applyModel(
            hbGpuObjectOrigin(penPx, layout, centre.x, centre.y),
            layout.radians,
          );
          const expected = atlasScreenOrigin(penPx, layout, centre.x, centre.y);
          expect(screen.x).toBeCloseTo(expected.x, 9);
          expect(screen.y).toBeCloseTo(expected.y, 9);
        }
      }
    }
  });

  it("rotates each run about its OWN centre, not about the stage origin", () => {
    // The one property the fold exists to preserve, stated directly: the pen position whose
    // `glyphLocal.x` is zero sits on the run box's vertical centre line, so pushing it through the
    // model must leave the x of the run centre untouched however far from the origin that centre
    // is. A model that rotated about (0, 0) would swing it across the stage.
    const layout = LAYOUT;
    const centre = { x: 900, y: 600 };
    const centrePen = layout.width / 2;
    expect(glyphLocal(centrePen, layout).x).toBe(0);
    const screen = applyModel(
      hbGpuObjectOrigin(centrePen, layout, centre.x, centre.y),
      layout.radians,
    );
    // Only the baseline offset moves it off the box centre, and it moves it by the rotation of a
    // purely vertical local vector — never by anything proportional to `centre`.
    const localY = glyphLocal(centrePen, layout).y;
    expect(screen.x).toBeCloseTo(
      centre.x - localY * Math.sin(layout.radians),
      9,
    );
    expect(screen.y).toBeCloseTo(
      centre.y + localY * Math.cos(layout.radians),
      9,
    );
  });

  it("puts the baseline the same distance below the box top as every other arm", () => {
    // At rotation 0 the arithmetic is readable by eye, which is the point of checking it here: the
    // glyph origin sits `baselinePx` below the run box's top edge, in device px.
    const layout: RunLayout = { ...LAYOUT, radians: 0, dpr: 2 };
    const at = hbGpuObjectOrigin(0, layout, 100, 50);
    expect(at.x).toBeCloseTo((100 - layout.width / 2) * 2, 9);
    expect(at.y).toBeCloseTo(
      (50 - layout.height / 2 + layout.baselinePx) * 2,
      9,
    );
  });
});

describe("hb-gpu param refusal", () => {
  const params = (over: Record<string, unknown> = {}) => ({
    phases: 4,
    bakeRotation: true,
    bakeShaper: "harfbuzz",
    ...over,
  });

  it("accepts the defaults, because a default is not a request", () => {
    // `resolveParams` materialises every default into the page URL, so the arm cannot tell "the
    // operator asked for 4 phases" from "nobody mentioned phases". Refusing the default would make
    // the arm unrunnable; refusing a NON-default is the case worth refusing.
    expect(textGpuUnsupportedParam(params())).toBeNull();
    // The query-string round trip turns booleans into strings — S9 has already paid for that trap
    // once — so the string form of the default must be accepted too.
    expect(
      textGpuUnsupportedParam(params({ bakeRotation: "true" })),
    ).toBeNull();
  });

  it("refuses each of the three baked-arm isolations, and says where to sweep it instead", () => {
    for (const over of [
      { phases: 1 },
      { phases: 9 },
      { bakeRotation: false },
      { bakeRotation: "false" },
      { bakeShaper: "fillText" },
    ]) {
      const message = textGpuUnsupportedParam(params(over));
      expect(
        message,
        `${JSON.stringify(over)} was silently accepted`,
      ).toBeTruthy();
      // REFUSED, not ignored: a report recording `phases: 4` beside an arm that has no phases is a
      // measurement of something that did not happen.
      expect(message).toContain("REFUSED");
      expect(message).toMatch(/hb-atlas|hb-run/);
    }
  });

  it("explains WHY rather than only that", () => {
    expect(textGpuUnsupportedParam(params({ phases: 9 }))).toContain(
      "no phase grid",
    );
    expect(textGpuUnsupportedParam(params({ bakeRotation: false }))).toContain(
      "bakes no pixels",
    );
    expect(
      textGpuUnsupportedParam(params({ bakeShaper: "fillText" })),
    ).toContain("by GLYPH ID");
  });
});

describe("outline param refusal", () => {
  // Every arm S9 can be swept on. `hb-gpu` is the only one with an outline; the other four would
  // have to be given one (a second baked atlas per radius, or `strokeText`) before the param could
  // mean anything beside them.
  const OTHERS = ["dom", "canvas2d", "hb-atlas", "hb-run"] as const;

  it("accepts the 0 default everywhere, because a default is not a request", () => {
    // `resolveParams` materialises `outlinePx=0` into the page URL of EVERY run, so the four arms
    // below always see the key. Refusing its presence would make them unrunnable; the case worth
    // refusing is a non-zero value, which can only have been asked for.
    for (const mechanism of [...OTHERS, "hb-gpu"]) {
      expect(textOutlineParamRefusal(mechanism, {})).toBeNull();
      expect(textOutlineParamRefusal(mechanism, { outlinePx: 0 })).toBeNull();
      // The query-string round trip hands every param over as a string. S9 has already paid for
      // that trap once with `bakeRotation=false`.
      expect(textOutlineParamRefusal(mechanism, { outlinePx: "0" })).toBeNull();
    }
  });

  it("accepts a real width on hb-gpu, in both the number and the string form", () => {
    for (const outlinePx of [1, 2, 6, 10, "6", 0.5]) {
      expect(
        textOutlineParamRefusal("hb-gpu", { outlinePx }),
        `hb-gpu refused outlinePx=${outlinePx}, which is the arm that has an outline`,
      ).toBeNull();
    }
  });

  it("refuses a non-zero width on every arm that has no outline, and says where to sweep it", () => {
    for (const mechanism of OTHERS) {
      const message = textOutlineParamRefusal(mechanism, { outlinePx: 6 });
      expect(
        message,
        `${mechanism} silently accepted an outline it does not draw`,
      ).toBeTruthy();
      // REFUSED, not ignored — the same rule `textGpuUnsupportedParam` applies in the other
      // direction. A row recording `outlinePx: 6` beside an arm that drew plain fill describes
      // something that did not happen.
      expect(message).toContain("REFUSED");
      expect(message).toContain("hb-gpu");
      expect(message).toContain(mechanism);
    }
  });

  it("explains WHY each arm has no outline rather than only that it has none", () => {
    expect(textOutlineParamRefusal("hb-atlas", { outlinePx: 6 })).toContain(
      "second baked atlas",
    );
    expect(textOutlineParamRefusal("canvas2d", { outlinePx: 6 })).toContain(
      "strokeText",
    );
  });

  it("refuses a negative or non-finite width on hb-gpu ITSELF, because setSpread would clamp it", () => {
    // `HbGpuRenderer.setSpread` clamps a negative or NaN radius to 0 and reports nothing — it is a
    // per-run hot-path setter with no error channel. That is right for a shipping renderer and
    // wrong for a measurement arm: the run would draw the plain fill and file its row under a
    // stroke width of -4, which is a blank-page-scores-well failure with a number attached.
    for (const outlinePx of [
      -4,
      -0.5,
      "abc",
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const message = textOutlineParamRefusal("hb-gpu", { outlinePx });
      expect(
        message,
        `hb-gpu accepted outlinePx=${String(outlinePx)}, which setSpread would clamp to a plain fill`,
      ).toBeTruthy();
      expect(message).toContain("clamps");
    }
    // And on the other arms too, where it is the same lie for the same reason.
    expect(textOutlineParamRefusal("dom", { outlinePx: -4 })).toContain(
      "not a stroke width",
    );
  });
});
