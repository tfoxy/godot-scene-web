// @vitest-environment node
//
// The WebGPU shader uniform PACKER (`src/webgpu/pack-uniforms.ts`) against hand-computed byte
// offsets.
//
// WHY THIS SUITE IS WORTH ITS LENGTH. On WebGL a uniform is addressed by NAME and a wrong type is a
// driver warning. On WebGPU the whole uniform block is opaque bytes: an offset four bytes out, or an
// `array<vec3f>` packed tightly instead of at its mandated 16-byte stride, yields a shader that runs
// perfectly and draws the wrong picture, with nothing logged anywhere. There is no GPU in this file
// — the packer is pure, and every expected offset below is derived by hand from WGSL's uniform
// address-space rules and then confirmed against what `transpileGodotShaderWgsl` really computed, so
// a drift in either direction fails here rather than in a pixel nobody diffs.
//
// The rules being pinned, in the order they bite:
//   * members keep DECLARATION order and each lands on the next multiple of its alignment
//     (vec2f→8, vec3f/vec4f→16), with the struct rounded up to 16;
//   * built-ins come FIRST, in the emitter's fixed order: uv_window, uv_fit, then time,
//     texture_pixel_size, screen_origin/screen_size and modulate — each present only if the shader
//     reads it, which is exactly when its offset exists;
//   * a Godot `bool` is stored as an `f32` 1/0 flag (WGSL bool is not host-shareable) and an `int`
//     as a real `i32`, so the writer must consult `godotType` rather than the WGSL type alone;
//   * an array element stride is 16 bytes whatever the element is, so `array<vec3f, N>` leaves one
//     padding lane per element.

import {
  createUniformStaging,
  packShaderUniforms,
  type ShaderUniformLayout,
} from "@godot-scene-web/canvas-effects/webgpu";
import { transpileGodotShaderWgsl } from "@godot-scene-web/effects/shaders";
import { describe, expect, it } from "vitest";

// A TIME shader with one float and one bool — the smallest layout that still exercises the
// bool-stored-as-f32 rule.
const SIMPLE = `shader_type canvas_item;
uniform float amount = 0.5;
uniform bool enabled = true;
void fragment() {
  COLOR = vec4(amount * TIME);
  if (enabled) { COLOR.a = 1.0; }
}`;

// SCRY-SHAPED: the constructs that make `scry_reveal` the hard corpus case — a `vec3[]` (the one
// that needs the padding lane), a `vec4[]`, an `int` uniform and a trailing float.
const SCRY = `shader_type canvas_item;
uniform vec3 colors[4] : source_color;
uniform vec4 circleData[2];
uniform int circles = 3;
uniform float uvMargin = 0.25;
void fragment() {
  vec3 c = colors[1] * uvMargin;
  vec4 d = circleData[0];
  COLOR = vec4(c + d.rgb, float(circles) * 0.1 + TIME * 0.0);
}`;

// A MODULATE + TEXTURE_PIXEL_SIZE shader: the two built-ins whose placement moves every user offset
// after them.
const MODULATED = `shader_type canvas_item;
uniform vec2 offset = vec2(0.0);
void fragment() {
  COLOR = texture(TEXTURE, UV + offset) * MODULATE;
  COLOR.rgb *= TEXTURE_PIXEL_SIZE.x;
}`;

/** Float lane index for a byte offset — every offset in these layouts is 4-aligned by construction. */
const lane = (bytes: number): number => bytes / 4;

describe("packShaderUniforms — a simple float + bool layout", () => {
  const shader = transpileGodotShaderWgsl(SIMPLE);

  it("lays the struct out exactly where the WGSL rules put it", () => {
    // uv_window vec4f @0 (16 B) | uv_fit vec2f @16 (8 B) | time f32 @24 (4 B)
    // | amount f32 @28 | enabled f32 @32 -> 36 bytes, rounded up to the struct's 16-byte alignment.
    expect(shader.builtinOffsets).toEqual({ uvWindow: 0, uvFit: 16, time: 24 });
    expect(shader.uniforms).toEqual([
      expect.objectContaining({
        name: "amount",
        type: "f32",
        godotType: "float",
        offsetBytes: 28,
      }),
      // BOOL STORED AS f32 — the fact a writer can only learn from `godotType`.
      expect.objectContaining({
        name: "enabled",
        type: "f32",
        godotType: "bool",
        offsetBytes: 32,
      }),
    ]);
    expect(shader.uniformStructSizeBytes).toBe(48);
    // No MODULATE, no TEXTURE_PIXEL_SIZE, no SCREEN_UV: this shader reads none of them, so they have
    // no member and no offset, and the packer must write nothing for them.
    expect(shader.builtinOffsets.modulate).toBeUndefined();
    expect(shader.builtinOffsets.texturePixelSize).toBeUndefined();
  });

  it("writes the built-ins and both parameters into their lanes", () => {
    const staging = packShaderUniforms(shader, {
      uvFit: [0.5, 0.25],
      // Binary fractions throughout: these land in a Float32Array, and 0.1 does not survive the
      // round trip exactly — a difference about IEEE-754, not about the packer.
      uvWindow: [0.125, 0.25, 0.5, 0.75],
      time: 7.5,
      // Supplied but not declared by this shader: silently ignored, because there is no offset to
      // write it to. A packer that guessed one would corrupt a user uniform.
      modulate: [9, 9, 9, 9],
      params: { amount: 0.75, enabled: 1 },
    });
    const f = staging.floats;
    expect([...f.subarray(0, 4)]).toEqual([0.125, 0.25, 0.5, 0.75]);
    expect([...f.subarray(lane(16), lane(16) + 2)]).toEqual([0.5, 0.25]);
    expect(f[lane(24)]).toBe(7.5);
    expect(f[lane(28)]).toBe(0.75);
    expect(f[lane(32)]).toBe(1);
    expect(staging.bytes.byteLength).toBe(48);
  });

  it("stores a bool as 1/0 whatever truthy shape it arrives in, and falls back to the declared default", () => {
    const on = packShaderUniforms(shader, {
      uvFit: [1, 1],
      uvWindow: [0, 0, 1, 1],
      params: { enabled: 1 },
    });
    expect(on.floats[lane(32)]).toBe(1);
    const off = packShaderUniforms(shader, {
      uvFit: [1, 1],
      uvWindow: [0, 0, 1, 1],
      params: { enabled: 0 },
    });
    expect(off.floats[lane(32)]).toBe(0);
    // No value at all -> the DEFAULT the shader declared (`= 0.5` / `= true`), exactly as the WebGL
    // path's `raw ?? uniform.default`.
    const defaults = packShaderUniforms(shader, {
      uvFit: [1, 1],
      uvWindow: [0, 0, 1, 1],
    });
    expect(defaults.floats[lane(28)]).toBe(0.5);
    expect(defaults.floats[lane(32)]).toBe(1);
  });

  it("ZEROES the block first, so a value that disappears reads as 0 rather than as last frame's", () => {
    const staging = createUniformStaging(shader.uniformStructSizeBytes);
    packShaderUniforms(
      shader,
      {
        uvFit: [1, 1],
        uvWindow: [0, 0, 1, 1],
        time: 3,
        params: { amount: 4 },
      },
      staging,
    );
    expect(staging.floats[lane(28)]).toBe(4);
    // Same staging block, no `amount` and no `time` this time: both must clear (the declared default
    // for amount, 0 for the built-in), not linger.
    packShaderUniforms(
      shader,
      { uvFit: [1, 1], uvWindow: [0, 0, 1, 1] },
      staging,
    );
    expect(staging.floats[lane(28)]).toBe(0.5);
    expect(staging.floats[lane(24)]).toBe(0);
  });
});

describe("packShaderUniforms — a scry-shaped array layout", () => {
  const shader = transpileGodotShaderWgsl(SCRY);

  it("places the arrays at a 16-byte-strided offset and the scalars after them", () => {
    // uv_window @0 (16) | uv_fit @16 (8) | time @24 (4) -> 28, then:
    //   colors  array<vec3f,4> aligns to 16 -> @32, size 4 * 16 (STRIDE, not 12) = 64 -> 96
    //   circleData array<vec4f,2>          -> @96, size 2 * 16 = 32              -> 128
    //   circles i32 @128 | uvMargin f32 @132 -> 136, rounded up to 144.
    expect(
      shader.uniforms.map((u) => [u.name, u.offsetBytes, u.sizeBytes]),
    ).toEqual([
      ["colors", 32, 64],
      ["circleData", 96, 32],
      ["circles", 128, 4],
      ["uvMargin", 132, 4],
    ]);
    expect(shader.uniformStructSizeBytes).toBe(144);
  });

  it("writes an array<vec3f> at STRIDE 16 — one padding lane per element", () => {
    const staging = packShaderUniforms(shader, {
      uvFit: [1, 1],
      uvWindow: [0, 0, 1, 1],
      time: 2,
      params: {
        // Four RGB triples, tightly packed on the wire as Godot serialises them.
        colors: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      },
    });
    const f = staging.floats;
    const base = lane(32);
    // Element i occupies lanes [base + 4i, base + 4i + 2]; lane base + 4i + 3 is PADDING and stays 0.
    // Packing these 12 floats contiguously — the bug this test exists for — would put 4 at lane
    // base+3 and shift every later element into the previous one's padding.
    expect([...f.subarray(base, base + 16)]).toEqual([
      1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0,
    ]);
  });

  it("writes an array<vec4f> contiguously (its natural stride is already 16) and an int as a real i32", () => {
    const staging = packShaderUniforms(shader, {
      uvFit: [1, 1],
      uvWindow: [0, 0, 1, 1],
      params: {
        circleData: [1, 2, 3, 4, 5, 6, 7, 8],
        circles: 6.4,
        uvMargin: 0.125,
      },
    });
    expect([...staging.floats.subarray(lane(96), lane(96) + 8)]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    // An `int` uniform is an i32 member: written through the INT view (and rounded), so reading the
    // same lane as a float gives a denormal — which is precisely why the two views exist.
    expect(staging.ints[lane(128)]).toBe(6);
    expect(staging.floats[lane(132)]).toBe(0.125);
  });

  it("drops the alpha lane of a PackedColorArray feeding a vec3[] uniform", () => {
    // Godot serialises a `PackedColorArray` as RGBA quads even when the uniform is `vec3[]` — the
    // same correction `normalizeVec3ArrayUniformValues` makes on the WebGL path. Without it every
    // colour after the first is shifted by one component.
    const staging = packShaderUniforms(shader, {
      uvFit: [1, 1],
      uvWindow: [0, 0, 1, 1],
      params: { colors: [1, 2, 3, 0.5, 4, 5, 6, 0.5] },
      paramKinds: { colors: "PackedColorArray" },
    });
    const base = lane(32);
    expect([...staging.floats.subarray(base, base + 8)]).toEqual([
      1, 2, 3, 0, 4, 5, 6, 0,
    ]);
  });

  it("pads a short array and truncates an over-long one instead of writing past the member", () => {
    const staging = packShaderUniforms(shader, {
      uvFit: [1, 1],
      uvWindow: [0, 0, 1, 1],
      // Two triples for a four-element array, and five vec4s for a two-element one.
      params: {
        colors: [1, 2, 3, 4, 5, 6],
        circleData: [
          1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5,
        ],
      },
    });
    const colors = lane(32);
    expect([...staging.floats.subarray(colors + 8, colors + 16)]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    // The third vec4 would have landed at byte 128 — on top of `circles`. It must not.
    expect(staging.ints[lane(128)]).toBe(3); // the declared default, untouched
  });
});

describe("packShaderUniforms — MODULATE and TEXTURE_PIXEL_SIZE placement", () => {
  const shader = transpileGodotShaderWgsl(MODULATED);

  it("puts the two built-ins ahead of the user uniform and writes all three", () => {
    // uv_window @0 (16) | uv_fit @16 (8) | texture_pixel_size vec2f @24 (8)
    // | modulate vec4f aligns to 16 -> @32 (16) | offset vec2f @48 -> 56, rounded up to 64.
    expect(shader.builtinOffsets).toEqual({
      uvWindow: 0,
      uvFit: 16,
      texturePixelSize: 24,
      modulate: 32,
    });
    expect(shader.uniformStructSizeBytes).toBe(64);

    const staging = packShaderUniforms(shader, {
      uvFit: [0.75, 0.5],
      uvWindow: [0, 0, 1, 1],
      texturePixelSize: [1 / 64, 1 / 32],
      modulate: [1, 0.5, 0.25, 1],
      params: { offset: [0.03125, 0.0625] },
    });
    const f = staging.floats;
    expect([...f.subarray(lane(24), lane(24) + 2)]).toEqual([1 / 64, 1 / 32]);
    expect([...f.subarray(lane(32), lane(32) + 4)]).toEqual([1, 0.5, 0.25, 1]);
    expect([...f.subarray(lane(48), lane(48) + 2)]).toEqual([0.03125, 0.0625]);
  });
});

describe("packShaderUniforms — a hand-built layout needs no transpiler at all", () => {
  it("honours the offsets it is given, whoever computed them", () => {
    // The packer's contract is with the LAYOUT, not with the transpiler: hand a struct that puts a
    // vec4 parameter at 48 and it writes at 48. This is what makes the offsets above assertable
    // rather than tautological.
    const layout: ShaderUniformLayout = {
      uniformStructSizeBytes: 64,
      builtinOffsets: { uvWindow: 0, uvFit: 16, time: 24, modulate: 32 },
      uniforms: [
        {
          name: "tint",
          type: "vec4f",
          godotType: "vec4",
          offsetBytes: 48,
          sizeBytes: 16,
        },
      ],
    };
    const staging = packShaderUniforms(layout, {
      uvFit: [1, 1],
      uvWindow: [0, 0, 1, 1],
      time: 1.5,
      modulate: [1, 1, 1, 0.5],
      params: { tint: [0.125, 0.25, 0.5, 0.75] },
    });
    expect(staging.floats[lane(24)]).toBe(1.5);
    expect([...staging.floats.subarray(lane(32), lane(32) + 4)]).toEqual([
      1, 1, 1, 0.5,
    ]);
    expect([...staging.floats.subarray(lane(48), lane(48) + 4)]).toEqual([
      0.125, 0.25, 0.5, 0.75,
    ]);
  });
});
