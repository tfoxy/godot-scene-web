// @vitest-environment node
//
// The WGSL the WebGPU particle backend renders with, asserted AS TEXT.
//
// WHY TEXT. jsdom has no WebGPU and node has no GPU, so the only place these shaders can be
// EXECUTED is a real browser (that is the parity harness's job, WP-8). What can be checked here is
// the thing that browser could not tell us anyway: that the port still says what
// core's `particles/render-webgl.ts` `FRAGMENT_SRC` says. Every invariant below is an ORDERING or a
// PAIRING that produces a plausible-looking wrong picture rather than an error — a LUT-indexed
// coverage read, a mask stretched across the flipbook sheet, a premultiplied fragment under a
// src-alpha blend. `FRAGMENT_SRC`'s own coverage tests are written the same way, for the same reason.
//
// The `node` environment is itself an assertion: this module is import-reachable from the node CLIs
// that import `@godot-scene-web/html`, and a module-scope `GPUBufferUsage.VERTEX` (node has no such
// global) would take the whole entry point down at import. It uses the `../src/webgpu/device`
// literals instead, and this file proves it by importing it with no DOM and no WebGPU anywhere.

import { INSTANCE_STRIDE } from "@godot-scene-web/effects";
import { describe, expect, it } from "vitest";
import {
  ADDITIVE_BLEND,
  ADDITIVE_RESOLVE_WGSL,
  INSTANCE_STRIDE_BYTES,
  PARTICLE_FS_ADDITIVE_ENTRY,
  PARTICLE_FS_ENTRY,
  PARTICLE_VERTEX_BUFFERS,
  PARTICLE_VS_ENTRY,
  PARTICLE_WGSL,
  PREMULTIPLIED_BLEND,
  RESOLVE_FS_ENTRY,
  RESOLVE_VS_ENTRY,
} from "../src/particles/render-webgpu";

/** Where `needle` appears in the shader, failing loudly (rather than returning -1 and silently
 *  satisfying an ordering comparison) when it does not appear at all. */
function at(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(index, `WGSL is missing: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

/** The body of `shade()` — the fragment feature set both entry points share. Ordering assertions are
 *  made INSIDE it so a stray occurrence in a comment elsewhere cannot satisfy them. */
function shadeBody(): string {
  const start = at(PARTICLE_WGSL, "fn shade(in: VsOut) -> Shaded {");
  const end = at(PARTICLE_WGSL, `fn ${PARTICLE_FS_ENTRY}(`);
  return PARTICLE_WGSL.slice(start, end);
}

describe("WebGPU particle WGSL — the fragment feature set mirrors FRAGMENT_SRC", () => {
  it("reads coverage PRE-LUT", () => {
    const body = shadeBody();
    // The LUT is a colour lookup INDEXED by the same red channel coverage comes from, so reading
    // coverage after it samples the LUT's own (usually white) output instead of the sheet's shape —
    // an alpha-less grayscale sheet then draws a SQUARE.
    const coverage = at(body, "var coverage = select(tex.a, tex.r,");
    const lut = at(body, "if (params.lut == 1u)");
    expect(coverage).toBeLessThan(lut);
  });

  it("lets the LUT replace RGB ONLY, keeping the source alpha", () => {
    // Godot's VFX family: COLOR = vec4(texture(lut, texture_color.rr).rgb, alpha) * vertex_color.
    expect(shadeBody()).toContain(
      "tex = vec4f(textureSampleLevel(lut_tex, lut_smp, vec2f(tex.r, 0.5), 0.0).rgb, tex.a);",
    );
  });

  it("erodes AFTER the LUT and BEFORE the mask", () => {
    const body = shadeBody();
    const lut = at(body, "if (params.lut == 1u)");
    const erode = at(body, "if (params.erode == 1u)");
    const mask = at(body, "if (params.mask == 1u)");
    expect(lut).toBeLessThan(erode);
    expect(erode).toBeLessThan(mask);
    // Godot erosion_from_factors(vec2(threshold, softness), coverage), constant-curve form.
    expect(body).toContain(
      "coverage = smoothstep(params.erodeFactors.x, params.erodeFactors.x + params.erodeFactors.y, coverage);",
    );
  });

  it("samples the mask over the QUAD, never the flipbook cell", () => {
    const body = shadeBody();
    // Godot's mask sampler reads the sprite's own UV: it shapes the whole quad, and sampling it at
    // the atlas-mapped `uv` would slice one grid cell out of the mask instead.
    expect(body).toContain(
      "coverage = coverage * textureSampleLevel(mask_tex, mask_smp, in.quad, 0.0).r;",
    );
    const maskLine = body.slice(at(body, "if (params.mask == 1u)"));
    expect(maskLine.slice(0, maskLine.indexOf("}"))).not.toContain(", uv,");
  });

  it("re-wraps the polar remap INTO THE SAME flipbook cell", () => {
    const body = shadeBody();
    const polar = body.slice(
      at(body, "if (params.uvPolar == 1u)"),
      at(body, "var tex: vec4f;"),
    );
    // Without `in.cell` the remap would wrap over the whole SHEET, so a flipbook's polar frames would
    // each sample every cell at once.
    expect(polar).toContain("in.cell");
    expect(polar).toContain(
      "uv = (in.cell + vec2f(godot_mod(radius, 1.0), godot_mod(angle, 1.0))) / params.grid;",
    );
    // GLSL `mod` is floor-signed and WGSL `%` is trunc-signed — the polyfill is what keeps a negative
    // angle wrapping the way the GL shader wraps it.
    expect(PARTICLE_WGSL).toContain(
      "fn godot_mod(x: f32, y: f32) -> f32 {\n  return x - y * floor(x / y);\n}",
    );
  });

  it("draws the untextured dot from the quad-local radius", () => {
    const body = shadeBody();
    // Measured across the QUAD, not the atlas-mapped uv: derived from the latter, any grid > 1x1 put
    // the dot's centre at the SHEET's centre.
    expect(body).toContain("let r = length(in.quad - vec2f(0.5)) * 2.0;");
    expect(body).toContain(
      "tex = vec4f(1.0, 1.0, 1.0, 1.0 - smoothstep(0.7, 1.0, r));",
    );
  });

  it("returns PREMULTIPLIED colour AND blends one / one-minus-src-alpha", () => {
    // THE PAIRING, asserted together because each half is silently wrong without the other: a
    // premultiplied fragment under a src-alpha blend double-multiplies, a straight fragment under
    // this blend halos, and neither raises an error. A `GPUCanvasContext` offers no straight-alpha
    // mode at all, so this is the only arrangement that composites like the GL path's canvas.
    const fragment = PARTICLE_WGSL.slice(
      at(PARTICLE_WGSL, `fn ${PARTICLE_FS_ENTRY}(`),
    );
    expect(fragment).toContain("return vec4f(col.rgb * col.a, col.a);");
    expect(PREMULTIPLIED_BLEND.color).toEqual({
      operation: "add",
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
    });
    // The alpha channel gets the SAME pair, so an overlapping particle cannot punch a hole in the
    // canvas's own alpha.
    expect(PREMULTIPLIED_BLEND.alpha).toEqual(PREMULTIPLIED_BLEND.color);
  });
});

describe("WebGPU particle WGSL — additive accumulate + resolve", () => {
  it("emits RAW LIGHT with alpha 0, summed one/one", () => {
    const additive = PARTICLE_WGSL.slice(
      at(PARTICLE_WGSL, `fn ${PARTICLE_FS_ADDITIVE_ENTRY}(`),
    );
    // Godot BLEND_MODE_ADD adds src.rgb * src.a: light = colour x coverage x instance alpha, summed
    // across overlapping particles. Alpha 0 because the accumulator holds LIGHT, not coverage —
    // normalizing per particle instead amplified faint texels and clamped overlaps to white.
    expect(additive).toContain(
      "return vec4f(shaded.col.rgb * shaded.coverage * in.color.a, 0.0);",
    );
    expect(ADDITIVE_BLEND.color).toEqual({
      operation: "add",
      srcFactor: "one",
      dstFactor: "one",
    });
    expect(ADDITIVE_BLEND.alpha).toEqual(ADDITIVE_BLEND.color);
  });

  it("resolves the per-pixel TOTAL through the peak channel", () => {
    // `(light, cov)`, premultiplied — the composite is `light + dst*(1-cov)` with no division, and
    // therefore no `cov > 0` guard to forget. The GL resolve is now the same expression
    // (core's `particles/render-webgl.ts` `RESOLVE_FRAGMENT_SRC`, asserted in `particles-render.test.ts`)
    // because its canvas is declared premultiplied too; it used to divide by `cov` and rely on the
    // blit into the node canvas to multiply it back.
    expect(ADDITIVE_RESOLVE_WGSL).toContain(
      "let cov = max(light.r, max(light.g, light.b));",
    );
    expect(ADDITIVE_RESOLVE_WGSL).toContain("return vec4f(light, cov);");
    expect(ADDITIVE_RESOLVE_WGSL).not.toContain("light / cov");
    // `textureLoad` at integer pixel coords (GL's `texelFetch`), so accumulator texel (x, y) is
    // fragment (x, y) — both spaces are Y-down, so there is no flip to get wrong.
    expect(ADDITIVE_RESOLVE_WGSL).toContain(
      "textureLoad(accum_tex, vec2i(pos.xy), 0)",
    );
  });

  it("declares the entry points the pipelines reference", () => {
    expect(PARTICLE_WGSL).toContain(`fn ${PARTICLE_VS_ENTRY}(`);
    expect(PARTICLE_WGSL).toContain(`fn ${PARTICLE_FS_ENTRY}(`);
    expect(PARTICLE_WGSL).toContain(`fn ${PARTICLE_FS_ADDITIVE_ENTRY}(`);
    expect(ADDITIVE_RESOLVE_WGSL).toContain(`fn ${RESOLVE_VS_ENTRY}(`);
    expect(ADDITIVE_RESOLVE_WGSL).toContain(`fn ${RESOLVE_FS_ENTRY}(`);
    // The resolve is its OWN module: two modules cannot both declare @group(0) @binding(0) for
    // different resources, and the resolve's binding is the accumulator, not the params.
    expect(ADDITIVE_RESOLVE_WGSL).not.toContain("var<uniform> params");
  });
});

describe("WebGPU particle vertex layout — the packed instance record", () => {
  it("declares the shipped stride, and the guard that keeps it that way", () => {
    // THE DRIFT GUARD, evaluated as the module's own load-time check does: the attribute offsets
    // below are hand-written byte positions into the record `InstanceBuffer.push` writes, so a
    // changed `INSTANCE_STRIDE` would not fail to compile — every instance would read a sliding
    // window of the previous one's floats. `render-webgpu.ts` throws at import when this is false.
    expect(INSTANCE_STRIDE * 4).toBe(INSTANCE_STRIDE_BYTES);
    expect(INSTANCE_STRIDE_BYTES).toBe(40);

    const [corners, instances] = PARTICLE_VERTEX_BUFFERS;
    // Slot 0: the static unit quad, stepped per VERTEX.
    expect(corners.arrayStride).toBe(8);
    expect(corners.stepMode).toBe("vertex");
    expect([...corners.attributes]).toEqual([
      { shaderLocation: 0, offset: 0, format: "float32x2" },
    ]);
    // Slot 1: `INSTANCE_ATTRS` from render-webgl.ts, in bytes, stepped per INSTANCE.
    expect(instances.arrayStride).toBe(INSTANCE_STRIDE * 4);
    expect(instances.stepMode).toBe("instance");
    expect([...instances.attributes]).toEqual([
      { shaderLocation: 1, offset: 0, format: "float32x2" }, // center
      { shaderLocation: 2, offset: 8, format: "float32x2" }, // scale
      { shaderLocation: 3, offset: 16, format: "float32" }, // rotation
      { shaderLocation: 4, offset: 20, format: "float32x4" }, // rgba
      { shaderLocation: 5, offset: 36, format: "float32" }, // frame
    ]);
  });

  it("maps device px into clip space with the canvas Y flip", () => {
    const vertex = PARTICLE_WGSL.slice(
      at(PARTICLE_WGSL, `fn ${PARTICLE_VS_ENTRY}(`),
      at(PARTICLE_WGSL, "struct Shaded {"),
    );
    expect(vertex).toContain("var clip = (px / params.viewport) * 2.0 - 1.0;");
    expect(vertex).toContain("clip.y = -clip.y;");
    // The flipbook cell index and the quad-local UV are separate outputs on purpose (see the mask
    // and dot invariants above).
    expect(vertex).toContain(
      "let cell = vec2f(godot_mod(frame, params.grid.x), floor(frame / params.grid.x));",
    );
    expect(vertex).toContain("out.uv = (cell + uv01) / params.grid;");
    expect(vertex).toContain("out.quad = uv01;");
  });
});
