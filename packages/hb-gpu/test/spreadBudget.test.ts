// How the dilation's tap budget is DIVIDED, checked without a GPU.
//
// WHAT THIS GUARDS, AND WHY IT IS WORTH A FILE. `HB_GPU_SPREAD_MAX_TAPS` is a perf number: the
// fragment shader's spread loop takes exactly one tap per iteration, so the compile-time bound IS
// the worst-case cost of a dilated fragment (plus `hb_gpu_draw`'s own centre tap — 65 in total), and
// every frame-rate table this package appears in is a function of it. The per-ring split underneath
// it is a QUALITY decision that spends that budget. The two are independent right up until somebody
// gives the outer ring "a few more steps" by raising a cap, at which point the sum quietly exceeds
// the ceiling and the loop starts truncating the outermost ring — the exact ring the dilated
// boundary is drawn by. That failure produces a slightly ragged outline and no error at all.
//
// SO THE CLAIM IS THE SUM, not any one cap: whatever the split, a fragment can spend at most
// `HB_GPU_SPREAD_MAX_TAPS` taps, and the flat bound is therefore never the thing that ends a ring.
//
// THE ARITHMETIC IS MIRRORED HERE RATHER THAN IMPORTED, deliberately. There is no TypeScript copy of
// it to import — it lives in GLSL, inside a template literal, and runs on a GPU. A restatement in
// another language is the only kind of check available short of compiling the shader, and it is a
// real one: it is written from the same rule the shader's comment states (split in proportion to
// ring radius, round half up, floor of 6 steps) rather than transliterated from the GLSL, so the two
// agree only if the rule does.
//
// AND THEN THE LITERAL IS READ BACK OUT OF THE SHADER TEXT. `FRAGMENT_MAIN` is a template string
// with exactly one interpolation in it; if that interpolation were dropped, or the constant declared
// twice with two different values, every number in this file would still be right about a shader
// nobody is running. `packages/hb-gpu/test/glyphPixelXvfb.test.ts` compiles the real thing, and it
// is gated on a display and a discrete GPU. This file runs everywhere.

import { describe, expect, it } from "vitest";
import { FRAGMENT_MAIN, HB_GPU_SPREAD_MAX_TAPS } from "../src/webgl";

/** `HB_GPU_SPREAD_MAX_RINGS`, restated for the same reason the caps are. */
const MAX_RINGS = 4;

/** The shader's floor on steps per ring: a hexagon is the coarsest ring that surrounds its centre. */
const MIN_STEPS = 6;

/**
 * The shader's per-ring cap, in the rule its comment states rather than in its syntax.
 *
 * Ring `ring` of `rings` gets a share of the budget proportional to its RADIUS — which, the radii
 * being equally spaced, is proportional to `ring` — so the shares are `k / (1 + 2 + ... + rings)`.
 *
 * BOTH DIVISIONS ARE INTEGER DIVISIONS AND BOTH ARE REPRODUCED, which is why this is not
 * `Math.round`. The shader's `+ denom / 2` is itself an int divide, so at an odd `denom` it adds
 * `(denom - 1) / 2` rather than half. On today's four ring counts that happens to land on the same
 * answers `Math.round` would give — checked — but the agreement is a coincidence of these operands
 * and not a property of the rule, and a mirror that relies on a coincidence stops mirroring the
 * first time somebody changes the budget.
 */
function capFor(ring: number, rings: number): number {
  const denom = (rings * (rings + 1)) / 2;
  return Math.floor(
    (HB_GPU_SPREAD_MAX_TAPS * ring + Math.floor(denom / 2)) / denom,
  );
}

/** What the shader would run at this radius: `clamp(ceil(TAU * r * t), 6, max(cap, 6))` per ring. */
function stepsFor(radiusPx: number): number[] {
  const rings = Math.min(MAX_RINGS, Math.max(1, Math.ceil(radiusPx * 1.5)));
  const steps: number[] = [];
  for (let ring = 1; ring <= rings; ring += 1) {
    const t = ring / rings;
    const want = Math.ceil(2 * Math.PI * radiusPx * t);
    steps.push(
      Math.min(
        Math.max(want, MIN_STEPS),
        Math.max(capFor(ring, rings), MIN_STEPS),
      ),
    );
  }
  return steps;
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

describe("hb-gpu spread tap budget", () => {
  it("splits the whole budget across the rings and never more", () => {
    // THE CEILING CLAIM, AT EVERY RING COUNT THE SHADER CAN CHOOSE. `rings` is
    // `clamp(ceil(radiusPx * 1.5), 1, 4)`, so these four are the whole domain.
    for (let rings = 1; rings <= MAX_RINGS; rings += 1) {
      const caps: number[] = [];
      for (let ring = 1; ring <= rings; ring += 1) {
        caps.push(Math.max(capFor(ring, rings), MIN_STEPS));
      }
      console.log(
        `hb-gpu tap budget: ${rings} ring(s) -> ${caps.join("/")} = ${sum(caps)} of ${HB_GPU_SPREAD_MAX_TAPS}`,
      );
      expect(
        sum(caps),
        `at ${rings} rings the per-ring caps sum to ${sum(caps)} against a flat loop bound of ${HB_GPU_SPREAD_MAX_TAPS} — the loop would run out of iterations inside the OUTERMOST ring, which is the one the dilated boundary is drawn by, and nothing else in this package would say so`,
      ).toBeLessThanOrEqual(HB_GPU_SPREAD_MAX_TAPS);
      // AND EVERY CAP IS A CAP ON SOMETHING. A zero or negative share would make
      // `clamp(x, 6, max(cap, 6))` silently collapse to the floor of 6 for that ring.
      for (const cap of caps) expect(cap).toBeGreaterThanOrEqual(MIN_STEPS);
    }
  });

  it("gives the innermost of four rings exactly the six-step floor", () => {
    // THE SPLIT'S OWN SANITY CHECK, and the reason the floor and the cap can coexist without one
    // silently overriding the other at the shipping ring count. 64 * 1 / 10 rounds to 6, which IS
    // the floor — so at four rings the arithmetic and the floor agree exactly, and a change to
    // either that made them disagree would be spending budget the outer rings need on a ring whose
    // taps are 1.18 px of arc apart at radius 12.
    expect(capFor(1, 4)).toBe(MIN_STEPS);
    expect([1, 2, 3, 4].map((ring) => capFor(ring, 4))).toEqual([
      6, 13, 19, 26,
    ]);
  });

  it("spends at most the budget at any radius, and gives the outer ring the most of it", () => {
    // THE SAME CLAIM THROUGH THE FUNCTION THE SHADER ACTUALLY EVALUATES, including the `ceil` that
    // keeps a small radius cheap. The radii span the fixtures and the consumer: 3 px is the
    // low-ppem spread case, 4 the "L", 12 the thin/dot-radial-wide case, 17.4 the phone at
    // `outlinePx` 10 and DPR 3.49.
    for (const radiusPx of [0.5, 1, 2, 3, 4, 6, 10.5, 12, 17.4, 64]) {
      const steps = stepsFor(radiusPx);
      console.log(
        `hb-gpu tap budget: r ${radiusPx} px -> ${steps.join("/")} = ${sum(steps)} taps + 1 centre`,
      );
      expect(
        sum(steps),
        `a fragment at radius ${radiusPx} would take ${sum(steps)} taps, past the ${HB_GPU_SPREAD_MAX_TAPS} the flat loop bound allows`,
      ).toBeLessThanOrEqual(HB_GPU_SPREAD_MAX_TAPS);
      // MONOTONE OUTWARD, which is the whole point of the split: no ring may be sampled more
      // finely than one further out, because arc length grows with radius and the outer ring is
      // the one the boundary follows.
      for (let i = 1; i < steps.length; i += 1) {
        expect(
          steps[i],
          `at radius ${radiusPx} ring ${i + 1} runs ${steps[i]} steps against ring ${i}'s ${steps[i - 1]} — an inner ring is being sampled more finely than the one that draws the boundary`,
        ).toBeGreaterThanOrEqual(steps[i - 1]);
      }
    }
  });

  it("declares that budget in the GLSL the renderer compiles", () => {
    // THE INTERPOLATION REACHED THE SHADER. One `${...}` in a several-hundred-line template
    // literal, and a shader that declared its own 16 or 64 instead would compile, run, and be
    // measured by a suite that skips itself on most checkouts.
    expect(FRAGMENT_MAIN).toContain(
      `const int HB_GPU_SPREAD_MAX_TAPS = ${HB_GPU_SPREAD_MAX_TAPS};`,
    );
    // AND THE LOOP IS BOUNDED BY THE CONSTANT RATHER THAN BY A LITERAL, which is the thing that
    // makes the sum above a claim about the shader at all.
    expect(FRAGMENT_MAIN).toContain(
      "for (int i = 0; i < HB_GPU_SPREAD_MAX_TAPS; i++)",
    );

    // AND THE MIRROR IS CHECKED AGAINST THE ORIGINAL, which is what stops this file from being a
    // test of itself. `capFor` above is a restatement in another language of three lines of GLSL;
    // asserting on those three lines verbatim closes the loop in the other direction, so that
    // widening a ring's share in the shader alone fails HERE rather than in a phone screenshot.
    // It is a strict string match on purpose: a formula this file's arithmetic depends on is
    // exactly the kind of thing that gets "simplified" and silently rebalanced.
    expect(FRAGMENT_MAIN).toContain("int denom = rings * (rings + 1) / 2;");
    expect(FRAGMENT_MAIN).toContain(
      "int cap = (HB_GPU_SPREAD_MAX_TAPS * ring + denom / 2) / denom;",
    );
    expect(FRAGMENT_MAIN).toContain(
      `steps = clamp (int (ceil (HB_GPU_SPREAD_TAU * radiusPx * t)), ${MIN_STEPS}, max (cap, ${MIN_STEPS}));`,
    );
    expect(FRAGMENT_MAIN).toContain(
      `const int HB_GPU_SPREAD_MAX_RINGS = ${MAX_RINGS};`,
    );
    // ONE TAP PER ITERATION, over the loop's own text. `hb_gpu_spread_tap` is the only call in
    // there that costs a coverage evaluation, and the identity "the loop bound IS the tap budget"
    // is out by a factor if a second one is ever added beside it.
    const from = FRAGMENT_MAIN.indexOf(
      "for (int i = 0; i < HB_GPU_SPREAD_MAX_TAPS; i++)",
    );
    const to = FRAGMENT_MAIN.indexOf("bool fillPass", from);
    expect(from, "the spread loop is not in the shader at all").toBeGreaterThan(
      0,
    );
    expect(
      to,
      "the contrast block no longer follows the spread loop, so this slice is not the loop",
    ).toBeGreaterThan(from);
    const body = FRAGMENT_MAIN.slice(from, to);
    const taps = body.split("hb_gpu_spread_tap (").length - 1;
    expect(
      taps,
      `the spread loop calls hb_gpu_spread_tap ${taps} times per iteration — HB_GPU_SPREAD_MAX_TAPS then bounds iterations rather than taps, and every cost figure derived from it is out by that factor`,
    ).toBe(1);
  });
});
