import { blendFactorsFor } from "@godot-scene-web/canvas-effects/webgl";
import {
  frameGridFor,
  INSTANCE_STRIDE,
  InstanceBuffer,
} from "@godot-scene-web/effects/particles";
import { normalizeParticleSpecConfig as normalizeParticleConfig } from "@godot-scene-web/html/runtime";
import { describe, expect, it } from "vitest";
import {
  FRAGMENT_SRC,
  RESOLVE_FRAGMENT_SRC,
} from "../../canvas-effects/src/particle-webgl";
import { PREMULTIPLIED_BLEND } from "../src/particles/render-webgpu";
import { emissionExtentPad, spriteExtentPad } from "../src/particles/runtime";

describe("particle instance buffer", () => {
  it("packs one record per instance at the documented stride", () => {
    expect(INSTANCE_STRIDE).toBe(10);
    const buf = new InstanceBuffer(4);
    // float32-exact values so the round-trip is bit-stable.
    buf.push(10, 20, 2, 3, 0.5, 0.5, 0.25, 0.75, 1, 7);
    expect(buf.count).toBe(1);
    expect(Array.from(buf.data.subarray(0, INSTANCE_STRIDE))).toEqual([
      10, 20, 2, 3, 0.5, 0.5, 0.25, 0.75, 1, 7,
    ]);
  });

  it("appends sequentially and reset rewinds without clearing capacity", () => {
    const buf = new InstanceBuffer(4);
    buf.push(1, 1, 1, 1, 0, 1, 1, 1, 1, 0);
    buf.push(2, 2, 1, 1, 0, 1, 1, 1, 1, 0);
    expect(buf.count).toBe(2);
    // second record starts at offset STRIDE
    expect(buf.data[INSTANCE_STRIDE]).toBe(2);
    buf.reset();
    expect(buf.count).toBe(0);
  });

  it("grows capacity past the initial size, preserving prior data", () => {
    const buf = new InstanceBuffer(2);
    for (let i = 0; i < 10; i += 1) {
      buf.push(i, 0, 1, 1, 0, 1, 1, 1, 1, 0);
    }
    expect(buf.count).toBe(10);
    expect(buf.data.length).toBeGreaterThanOrEqual(10 * INSTANCE_STRIDE);
    // first record intact after several grows
    expect(buf.data[0]).toBe(0);
    expect(buf.data[9 * INSTANCE_STRIDE]).toBe(9);
  });
});

describe("particle blend factors", () => {
  it("SUMS light for blend mode 1 (add); the resolve pass derives coverage from the total", () => {
    // Additive particles emit raw light (color x alpha) and must accumulate with Godot's
    // ADD semantics inside the offscreen accumulator; the resolve pass then converts the
    // per-pixel TOTAL to straight color + coverage alpha. Source-over accumulation of
    // per-particle-normalized colors clamped every overlap to white (the fog haze wall)
    // and amplified faint texels to full saturation.
    // ONE on the alpha channel too, where Godot's ADD has SRC_ALPHA: this fragment premultiplies
    // itself and writes alpha 0, and the resolve pass reads only RGB out of the accumulator.
    expect(blendFactorsFor(1)).toEqual(["ONE", "ONE", "ONE", "ONE"]);
  });

  it("uses the PREMULTIPLIED mix pair for mode 0 and anything else", () => {
    // ONE on colour, because the fragment already carries `rgb * a` (see the pairing test below);
    // ONE_MINUS_SRC_ALPHA on both channels for the destination. On ALPHA that src factor is also
    // Godot's — its canvas blending is separate and both backends agree (GLES3
    // rasterizer_canvas_gles3.cpp:755-762 transparent-target branch, RD
    // material_storage.cpp:655-663) — so a covered pixel ends at `a`, never near `a^2`.
    const mix = ["ONE", "ONE_MINUS_SRC_ALPHA", "ONE", "ONE_MINUS_SRC_ALPHA"];
    expect(blendFactorsFor(0)).toEqual(mix);
    expect(blendFactorsFor(2)).toEqual(mix);
    // The WebGPU peer's `PREMULTIPLIED_BLEND`, spelled in GL enum names. One contract, two APIs.
    expect(PREMULTIPLIED_BLEND.color).toEqual({
      operation: "add",
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
    });
    expect(PREMULTIPLIED_BLEND.alpha).toEqual(PREMULTIPLIED_BLEND.color);
  });
});

/**
 * THE CANVAS ALPHA CONTRACT, asserted where both halves of it are visible at once.
 *
 * The shared WebGL2 canvas declares `premultipliedAlpha: true` (pinned in `shared-gl.test.ts`),
 * which makes exactly one fragment/blend pairing correct — and BOTH halves are silently wrong on
 * their own. A premultiplied fragment under `SRC_ALPHA` multiplies by alpha twice (the picture goes
 * dark and thin at partial coverage); a straight fragment under `ONE` halos. Neither raises an
 * error, neither shows up in a readback of the drawing buffer, and pixelmatch scored the first one
 * at zero differing pixels for as long as it shipped. So the two are asserted TOGETHER, from the
 * shader SOURCE (jsdom has no GL to run it in — the same technique the coverage tests use).
 */
describe("the particle fragment and its blend state agree on premultiplied alpha", () => {
  it("MIX returns rgb*a and blends ONE / ONE_MINUS_SRC_ALPHA", () => {
    expect(FRAGMENT_SRC).toContain("fragColor = vec4(col.rgb * col.a, col.a);");
    expect(blendFactorsFor(0)).toEqual([
      "ONE",
      "ONE_MINUS_SRC_ALPHA",
      "ONE",
      "ONE_MINUS_SRC_ALPHA",
    ]);
  });

  it("is arithmetically the pair it replaced, over a cleared buffer and over a destination", () => {
    // The equivalence that makes this a RESTATEMENT rather than a behaviour change: for the same
    // fragment colour, `premultiplied src under ONE` and `straight src under SRC_ALPHA` compute
    // the identical destination. Only the DECLARED canvas contract distinguishes them — which is
    // the entire point of choosing this form.
    const blend = (
      srcRgb: number,
      srcA: number,
      dstRgb: number,
      dstA: number,
      premultipliedSource: boolean,
    ) => {
      // `srcRgb` is the STRAIGHT colour either way; the fragment premultiplies it, or the blend
      // factor does. Alpha uses src factor ONE in both forms (Godot's separate-alpha rule).
      const emitted = premultipliedSource ? srcRgb * srcA : srcRgb;
      const srcFactor = premultipliedSource ? 1 : srcA;
      return {
        rgb: emitted * srcFactor + dstRgb * (1 - srcA),
        a: srcA + dstA * (1 - srcA),
      };
    };
    for (const [srcRgb, srcA, dstRgb, dstA] of [
      [0.8, 0.5, 0, 0], // the cleared buffer every draw starts from
      [0.8, 0.5, 0.3, 0.4], // a second particle over the first
      [1, 1, 0.25, 0.75], // fully opaque source
      [0.4, 0, 0.6, 0.9], // fully transparent source
    ]) {
      const premultiplied = blend(srcRgb, srcA, dstRgb, dstA, true);
      const straight = blend(srcRgb, srcA, dstRgb, dstA, false);
      expect(premultiplied.rgb).toBeCloseTo(straight.rgb, 12);
      expect(premultiplied.a).toBeCloseTo(straight.a, 12);
    }
  });

  it("ADDITIVE resolves to (light, cov) with no divide and no cov>0 guard", () => {
    // A premultiplied canvas wants the light itself. The straight-alpha form divided by coverage
    // and relied on the blit into the node canvas to multiply it back — two mistakes cancelling,
    // and a `cov > 0` guard needed only to protect that division.
    expect(RESOLVE_FRAGMENT_SRC).toContain("fragColor = vec4(light, cov);");
    expect(RESOLVE_FRAGMENT_SRC).not.toContain("light / cov");
    expect(RESOLVE_FRAGMENT_SRC).not.toContain("cov > 0.0");
    // The accumulate pass is unchanged: raw light, alpha 0, summed ONE/ONE.
    expect(FRAGMENT_SRC).toContain(
      "fragColor = vec4(col.rgb * tex.a * v_color.a, 0.0);",
    );
    expect(blendFactorsFor(1)).toEqual(["ONE", "ONE", "ONE", "ONE"]);
  });
});

describe("spriteExtentPad (canvas margin so big sprites aren't clipped)", () => {
  // The rare-glow case: a 256px sunburst, base scale 0.8, scale-curve peaking at 3 →
  // half-diagonal ≈ ceil(0.8 × 3 × hypot(256,256) / 2) = 435.
  it("covers max base-scale × scale-curve peak × the sprite diagonal", () => {
    const cfg = normalizeParticleConfig({
      textureWidth: 256,
      textureHeight: 256,
      scaleMin: 0.8,
      scaleMax: 0.8,
      scaleCurve: [
        { x: 0, y: 2 },
        { x: 1, y: 3 },
      ],
    });
    expect(spriteExtentPad(cfg, null)).toBe(435);
  });

  it("is smaller without a growing scale curve (curve peak defaults to 1)", () => {
    const base = {
      textureWidth: 256,
      textureHeight: 256,
      scaleMin: 0.8,
      scaleMax: 0.8,
    };
    const withCurve = normalizeParticleConfig({
      ...base,
      scaleCurve: [
        { x: 0, y: 2 },
        { x: 1, y: 3 },
      ],
    });
    const noCurve = normalizeParticleConfig(base);
    expect(spriteExtentPad(noCurve, null)).toBe(145);
    expect(spriteExtentPad(noCurve, null)).toBeLessThan(
      spriteExtentPad(withCurve, null),
    );
  });

  it("falls back to the default dot and stays tiny for a missing/1px texture", () => {
    const cfg = normalizeParticleConfig({ textureWidth: 1, textureHeight: 1 });
    expect(spriteExtentPad(cfg, null)).toBeLessThanOrEqual(2);
  });

  it("caps the margin so a pathological texture can't allocate an enormous canvas", () => {
    const cfg = normalizeParticleConfig({
      textureWidth: 100000,
      textureHeight: 100000,
    });
    expect(spriteExtentPad(cfg, null)).toBe(1024);
  });
});

describe("emissionExtentPad (canvas margin so spread emission isn't clipped)", () => {
  // The card-sparkles case: box emission with extents (1,1) x shape scale (120,170) →
  // reach = max(1×120, 1×170) = 170, so the tiny star sprite's canvas still contains the
  // full spread.
  it("covers a box emission's extents × shape scale", () => {
    const cfg = normalizeParticleConfig({
      emissionShape: 3,
      emissionBoxExtents: [1, 1],
      emissionScale: [120, 170],
    });
    expect(emissionExtentPad(cfg)).toBe(170);
  });

  it("adds the emission offset to the shape reach", () => {
    const cfg = normalizeParticleConfig({
      emissionShape: 3,
      emissionBoxExtents: [1, 1],
      emissionScale: [120, 170],
      emissionOffset: [200, 0],
    });
    expect(emissionExtentPad(cfg)).toBe(320);
  });

  it("covers a sphere/disk emission radius (scaled)", () => {
    const cfg = normalizeParticleConfig({
      emissionShape: 1,
      emissionSphereRadius: 50,
      emissionScale: [2, 1],
    });
    expect(emissionExtentPad(cfg)).toBe(100);
  });

  it("is zero for point emission (the glow) so its pad stays sprite-driven", () => {
    const cfg = normalizeParticleConfig({ emissionShape: 0 });
    expect(emissionExtentPad(cfg)).toBe(0);
  });

  it("caps the margin so a pathological emission can't allocate an enormous canvas", () => {
    const cfg = normalizeParticleConfig({
      emissionShape: 3,
      emissionBoxExtents: [1, 1],
      emissionScale: [100000, 100000],
    });
    expect(emissionExtentPad(cfg)).toBe(1024);
  });
});

// A SHADER-driven flipbook (the material crops UV itself; the node's own hframes/vframes stay 1)
// leaves Godot drawing the quad at the FULL texture size. `flipbookCropOnly` reproduces that, so a
// consumer mapping such a material crops the sheet WITHOUT also shrinking the sprite.
describe("flipbook sprite sizing", () => {
  it("sizes a CanvasItemMaterial flipbook to ONE CELL (Godot's particles_animation)", () => {
    const cfg = normalizeParticleConfig({
      textureWidth: 256,
      textureHeight: 256,
      hframes: 2,
      vframes: 2,
    });
    // frame = 128x128 => half-diagonal
    expect(spriteExtentPad(cfg)).toBe(Math.ceil(Math.hypot(128, 128) / 2));
  });

  it("keeps the FULL texture size for a crop-only (shader) flipbook", () => {
    const cfg = normalizeParticleConfig({
      textureWidth: 256,
      textureHeight: 256,
      hframes: 2,
      vframes: 2,
      flipbookCropOnly: true,
    });
    expect(spriteExtentPad(cfg)).toBe(Math.ceil(Math.hypot(256, 256) / 2));
  });
});

describe("frame grid for the draw", () => {
  it("passes a textured system's sheet through", () => {
    expect(frameGridFor(true, 2, 2)).toEqual([2, 2]);
  });

  it("collapses to 1x1 for an UNTEXTURED system (a procedural dot has no sheet)", () => {
    // The dot fallback is generated in the fragment shader; cropping it to a cell of a
    // non-existent sheet is meaningless (and used to leave a clipped, off-center sliver).
    expect(frameGridFor(false, 2, 2)).toEqual([1, 1]);
  });

  it("floors a degenerate grid at 1", () => {
    expect(frameGridFor(true, 0, -3)).toEqual([1, 1]);
  });
});
