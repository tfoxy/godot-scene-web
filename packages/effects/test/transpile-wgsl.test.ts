// @vitest-environment node
//
// The Godot -> WGSL emitter, proved WITHOUT a GPU.
//
// What can and cannot be proved here, stated up front so the assertions below are read for
// what they are. A WGSL module is only really valid when `createShaderModule` says so, and
// that needs a browser — WP-8's harness runs every shader in this corpus through
// `getCompilationInfo()` for exactly that reason. What IS provable offline, and what every
// test here is about, is the set of things that can be silently wrong while the emitter
// still returns a plausible-looking string:
//
//   * a real game shader stops transpiling at all (the corpus table),
//   * a construct WGSL genuinely cannot express comes back as the WRONG ERROR CLASS, so the
//     runtime picks the wrong fallback (the failure-contract block),
//   * a uniform byte offset moves, which no compiler can catch because both sides compile
//     and the picture is merely wrong (the layout block, hand-computed),
//   * a translation rule silently stops firing — a `?:` left in the output, a `mod` that
//     kept WGSL's trunc-signed `%` semantics, a multi-component swizzle assignment that
//     WGSL will reject (the per-rule snippet block).
//
// The shader sources are copied verbatim from `test/webgl-transpile.test.ts`, where they are
// module-private constants. They are the real game shaders (card_ripple, hsv, power,
// doom_bar, normal_map_point, scry_reveal, the VisualShader bool family, the affliction trio
// with its includes, and the SCREEN_TEXTURE distortion). Copying rather than exporting keeps
// each suite readable on its own; the GLSL suite remains the authority on GLSL output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expandGodotShaderIncludes,
  UnsupportedShaderError,
} from "../src/shaders/godot-shader";
import {
  transpileGodotShaderWgsl,
  UnsupportedWgslShaderError,
  wgslStructLayout,
} from "../src/shaders/transpile-wgsl";

// ---- corpus (verbatim from test/webgl-transpile.test.ts) --------------------

const CARD_RIPPLE = `
shader_type canvas_item;
render_mode blend_add;
uniform float ease;
uniform float modulo_width;
uniform float width;
uniform float ripple_speed;
void fragment() {
	float sdf_alpha = mod(TIME * ripple_speed + COLOR.a, modulo_width);
    float front_ease = smoothstep(0, ease, sdf_alpha);
    float easeAmount = front_ease * modulo_width;
    float brightness = COLOR.a - sdf_alpha + easeAmount;
    COLOR.a = smoothstep(1.0 - width, width+(1.0 - width), brightness);
}
`;

const HSV = `
shader_type canvas_item;
uniform float h: hint_range(0,1) = 1;
uniform float s: hint_range(0,5) = 1;
uniform float v = 1;
varying vec4 modulate_color;
void vertex() {
    modulate_color = COLOR;
}
void fragment() {
    mat3 RGB_to_YIQ = mat3(vec3(0.2989,0.5959,0.2115), vec3(0.5870,-0.2774,-0.5229), vec3(0.1140,-0.3216,0.3114));
    vec4 col = texture(TEXTURE, UV);
    col.rgb = RGB_to_YIQ * col.rgb;
    float hue = 1.0 - h;
    hue = mix(0, 6.283185, hue);
    col.rgb = inverse(RGB_to_YIQ) * col.rgb;
    COLOR = col;
    COLOR *= modulate_color;
}
`;

const POWER = `
shader_type canvas_item;
uniform float pulse;
float when_eq(float x, float y) { return 1.0 - abs(sign(x - y)); }
void fragment() {
	COLOR.rgb += abs(sin(TIME * 3.0)) * 0.2 * when_eq(pulse, 1);
}
`;

const DOOM_BAR = `
shader_type canvas_item;

uniform sampler2D noise_tex : repeat_enable;
uniform sampler2D gradient_tex;

void fragment() {
   	float scrollOffset1 = texture(noise_tex, SCREEN_UV * 0.1 + TIME * 0.0005 + 0.24).r;
	float col1 = texture(noise_tex, SCREEN_UV + TIME * 0.0005 + scrollOffset1).r;

   	float scrollOffset2 = texture(noise_tex, SCREEN_UV * 0.1 + TIME * 0.0005 + 0.24).r;
	float col2 = texture(noise_tex, SCREEN_UV + TIME * -0.0007 + scrollOffset2).r;

    float final_val = col1 * 0.75 + col2 * 0.35;
    final_val = smoothstep(0.4, 0.6, final_val);

    COLOR.rgb = texture(gradient_tex, vec2(final_val,0.0)).rgb;
}
`;

const NORMAL_MAP_POINT = `
shader_type canvas_item;
uniform vec3 initial_color : source_color;
uniform vec3 map_color : source_color;
void fragment() {
    float diff = distance(COLOR.rgb, initial_color.rgb);
    if (diff < 0.5) {
        COLOR.rgb = map_color;
    }
}
`;

const SCRY_REVEAL = `
shader_type canvas_item;

const float borderwidth = 0.05;
const int gridSize = 11;
const float gridSizef = 11.0;

uniform sampler2D noiseTex1 : source_color, filter_linear, repeat_enable;
uniform sampler2D noiseTex2 : source_color, filter_linear, repeat_enable;
uniform vec3 borderColor : source_color;
uniform vec3 colors[8] : source_color;
uniform vec4 circleData[8];
uniform int circles = 8;
uniform int outerCircle = -1;
uniform vec3 gridFadeParams[gridSize * gridSize];
uniform float time;
uniform float uvMargin;

vec2 getGridPos(vec2 uv)
{
  return (((uv * gridSizef - gridSizef * 0.5) * (1.0 + uvMargin * 2.0) - uvMargin) + gridSizef * 0.5);
}

float aaStep(float edge, float gradient)
{
  float halfPix = fwidth(gradient) / 2.0;
  float low = edge - halfPix;
  float hi = edge + halfPix;
  return clamp((gradient - low) / (hi - low), 0.0, 1.0);
}

void fragment() {
  vec4 original_col = texture(TEXTURE, UV);
  vec4 ModularCol = COLOR / original_col;

  vec2 gridposf = getGridPos(UV);
  vec2 gridpos = floor(gridposf);
  bool validIndex = gridpos.x >= 0.0 && gridpos.y >= 0.0 && gridpos.x < gridSizef && gridpos.y < gridSizef;
  int index = int(floor(gridpos.y * gridSizef + gridpos.x));
  float lastTimeChange = validIndex ? gridFadeParams[index].z : 0.0;
  float fromAlpha = validIndex ? gridFadeParams[index].x : 0.0;
  float toAlpha = validIndex ? gridFadeParams[index].y : 0.0;
  float timediff = time - lastTimeChange;
  float alpha = lastTimeChange == 0.0 ? 1.0 : mix(fromAlpha, toAlpha, clamp(timediff / 0.5, 0, 1));
  float border = 0.0;

  for (int x = -1; x <= 1; x++)
  {
    for (int y = -1; y <= 1; y++)
    {
      if (x == 0 && y == 0) continue;
      vec2 gridpos_n = gridpos + vec2(float(x), float(y));
      int index_n = int(floor(gridpos_n.y) * gridSizef + gridpos_n.x);
      bool validIndex_n = gridpos_n.x >= 0.0 && gridpos_n.y >= 0.0 && gridpos_n.x < gridSizef && gridpos_n.y < gridSizef;
      if (!validIndex_n) continue;
      float lastTimeChange_n = gridFadeParams[index_n].z;
      float timediff_n = time - lastTimeChange_n;
      float alpha_n = lastTimeChange_n == 0.0 ? 1.0 : mix(gridFadeParams[index_n].x, gridFadeParams[index_n].y, clamp(timediff_n / 0.5, 0, 1));
      vec2 toBorder = max(max(gridpos_n - gridposf, vec2(0.0)), gridposf - (gridpos_n + vec2(1.0)));
      float borderdist = length(toBorder);
      border = max(border, smoothstep(borderwidth, borderwidth - 0.03, borderdist) * abs(alpha - alpha_n));
    }
  }

  vec2 fromCenter = UV - 0.5;
  float dist = length(fromCenter);
  vec2 polar1 = vec2(dist * 2.0, (atan(fromCenter.y, fromCenter.x) + PI) / (PI * 2.0));
  float noiseSample1 = texture(noiseTex1, (polar1 + vec2(0, TIME * 0.0065))).r;
  noiseSample1 = pow(noiseSample1, 0.8);
  vec2 polar2 = vec2(dist * 0.5, (atan(fromCenter.y, fromCenter.x) + PI) / (PI * 2.0));
  float noiseSample2 = texture(noiseTex2, (polar2 + vec2(0, TIME * 0.0011))).r;
  noiseSample2 = pow(noiseSample2 + 0.4, 1.0);
  float noiseSample = noiseSample1 * noiseSample2 * 2.0;
  vec3 col = colors[0];
  float lastmask;

  for (int i = 0; i < circles; i++)
  {
    vec4 curData = circleData[i];
    float circle = smoothstep(curData.x * 0.5, (curData.x + curData.y) * 0.5, dist);
    float mask = mix(1.0, noiseSample, pow(circle, curData.z)) * (1.0 - circle);
    mask = aaStep(curData.w, mask);
    if (i == outerCircle)
    {
      float halfgrid = (gridSizef - 1.0) * 0.5;
      vec2 normcoord = halfgrid - abs(halfgrid - gridpos);
      mask = (normcoord.x + normcoord.y) < 3.0 || !validIndex ? 0.0 : mask;
    }
    lastmask = mask;
    col = mix(colors[i+1], col, mask);
  }

  if (outerCircle < 0)
  {
    float halfgrid = (gridSizef - 1.0) * 0.5;
    vec2 normcoord = halfgrid - abs(halfgrid - gridpos);
    lastmask = (normcoord.x + normcoord.y) < 3.0 || !validIndex ? 0.0 : 1.0;
  }

  COLOR = vec4(col + borderColor * border, max(alpha, border) * lastmask) * ModularCol;
}
`;

const STEPPED_BOOL = `
shader_type canvas_item;
render_mode blend_add;

uniform bool InvertNoiseMask = true;
uniform bool UseOuterColor = false;
uniform bool NoDefault;
uniform sampler2D NoiseMask : repeat_disable;
uniform vec2 NoiseMaskScale = vec2(1.000000, 1.000000);

void fragment() {
	bool n_out60p0 = InvertNoiseMask;
	vec4 n_out55p0 = texture(NoiseMask, UV * NoiseMaskScale);
	float masked = 1.0 - n_out55p0.b;
	float n_out65p0;
	n_out65p0 = mix(n_out55p0.b, masked, float(n_out60p0));
	COLOR.rgb = vec3(n_out65p0);
	COLOR.a = n_out65p0;
}
`;

const AFFLICTION_GALVANIZED = `
shader_type canvas_item;
render_mode blend_add;

#include "res://shaders/vfx/_util/polar_coordinates.gdshaderinc"
#include "res://shaders/vfx/_util/tiling_and_offset.gdshaderinc"
#include "res://shaders/vfx/_util/erosion_from_factors.gdshaderinc"

uniform vec4 blink_st;
uniform vec2 blink_smoothstep;
uniform sampler2D lut : repeat_disable;
varying vec4 vertex_color;

void vertex() {
  vertex_color = COLOR;
}

void fragment() {
  vec2 blink_uv = tiling_and_offset(UV, blink_st, vec2(0.0));
  vec2 polar_uv = polar_coordinates(UV, vec2(0.5, 0.5), 1.0, 1.0);
  float blink = texture(TEXTURE, vec2(blink_uv.r, 0.0)).b;
  blink = erosion_from_factors(blink_smoothstep, blink);
  vec4 lut_tex = texture(lut, vec2(blink, 0.0));
  COLOR = vec4(lut_tex.rgb * vertex_color.rgb, vertex_color.a * blink);
}
`;

const AFFLICTION_BOUND_MAIN = `
shader_type canvas_item;
render_mode blend_add;

#include "res://shaders/vfx/_util/tiling_and_offset.gdshaderinc"

uniform vec4 bright_st;
uniform float bright_energy;

varying vec4 vertex_color;

void vertex() {
  vertex_color = COLOR;
}

void fragment() {
  vec4 bright_tex = texture(TEXTURE, tiling_and_offset(UV, bright_st, vec2(0.0)));
  vec4 main_tex = texture(TEXTURE, UV);

  float energy_multiplier = mix(1.0, bright_energy, bright_tex.g);

  COLOR = vec4((main_tex.rrr * vertex_color.rgb * energy_multiplier).rgb, main_tex.a * vertex_color.a);
}
`;

const AFFLICTION_ENTANGLED_MAIN = `
shader_type canvas_item;
render_mode blend_mix;

uniform vec4 distortion_st;
uniform float distortion_intensity;

uniform sampler2D vine_lut : repeat_disable;

varying vec4 vertex_color;

void vertex() {
  vertex_color = COLOR;
}

void fragment() {
  vec2 distortion_uv = UV * distortion_st.xy + vec2(distortion_st.z, TIME * distortion_st.w);
  vec4 distortion_tex = texture(TEXTURE, distortion_uv);
  float distortion = distortion_tex.b * distortion_intensity;

  vec4 main_tex = texture(TEXTURE, UV);
  vec4 main_tex_distorted = texture(TEXTURE, UV + vec2(distortion * main_tex.g, 0.0));

  vec4 lut_tex = texture(vine_lut, vec2(main_tex_distorted.r));

  COLOR = vec4(vertex_color.rgb * lut_tex.rgb, vertex_color.a * main_tex_distorted.a);
}
`;

const AFFLICTION_INCLUDES: Record<string, string> = {
  "res://shaders/vfx/_util/polar_coordinates.gdshaderinc": `
vec2 polar_coordinates(vec2 uv, vec2 center, float zoom, float repeat)
{
  vec2 dir = uv - center;
  float radius = length(dir) * 2.0;
  float angle = atan(dir.y, dir.x) * 1.0/(3.1416 * 2.0);
  return mod(vec2(radius * zoom, angle * repeat), 1.0);
}
`,
  "res://shaders/vfx/_util/tiling_and_offset.gdshaderinc": `
vec2 tiling_and_offset(vec2 base_uv, vec4 st, vec2 initial_offset) {
  return ((base_uv * st.xy) + ((st.zw * TIME) + initial_offset));
}
`,
  "res://shaders/vfx/_util/erosion_from_factors.gdshaderinc": `
float erosion_from_factors(vec2 factors, float input)
{
  return smoothstep(factors.x, factors.x + factors.y, input);
}
`,
};

// The SCREEN_TEXTURE distortion shader: transpiles on the GLSL path, must NOT here.
const SCREEN_DISTORT = `
shader_type canvas_item;
uniform sampler2D SCREEN_TEXTURE : hint_screen_texture, repeat_disable, filter_nearest;
uniform sampler2D noise_tex : repeat_enable;
uniform float intensity = 0.01;
void fragment() {
    vec2 offset = (texture(noise_tex, UV + TIME * 0.05).rg - 0.5) * intensity;
    COLOR = texture(SCREEN_TEXTURE, SCREEN_UV + offset);
}
`;

const SCREEN_ALIASED = `
shader_type canvas_item;
uniform sampler2D screen_tex : hint_screen_texture;
void fragment() { COLOR = texture(screen_tex, SCREEN_UV); }
`;

const SCREEN_PIXEL_SIZE_ONLY =
  "shader_type canvas_item;\nvoid fragment(){ COLOR.rg = SCREEN_PIXEL_SIZE; }";

function expand(source: string): Promise<string> {
  return expandGodotShaderIncludes(source, (path) => AFFLICTION_INCLUDES[path]);
}

// ---- corpus coverage -------------------------------------------------------

describe("transpileGodotShaderWgsl — the real game-shader corpus", () => {
  const cases: Array<{
    name: string;
    source: string;
    blend: string;
    usesTime: boolean;
    usesScreenUv: boolean;
  }> = [
    {
      name: "card_ripple",
      source: CARD_RIPPLE,
      blend: "add",
      usesTime: true,
      usesScreenUv: false,
    },
    {
      name: "hsv",
      source: HSV,
      blend: "mix",
      usesTime: false,
      usesScreenUv: false,
    },
    {
      name: "power",
      source: POWER,
      blend: "mix",
      usesTime: true,
      usesScreenUv: false,
    },
    {
      name: "doom_bar",
      source: DOOM_BAR,
      blend: "mix",
      usesTime: true,
      usesScreenUv: true,
    },
    {
      name: "normal_map_point",
      source: NORMAL_MAP_POINT,
      blend: "mix",
      usesTime: false,
      usesScreenUv: false,
    },
    {
      name: "scry_reveal",
      source: SCRY_REVEAL,
      blend: "mix",
      usesTime: true,
      usesScreenUv: false,
    },
    {
      name: "stepped-bool",
      source: STEPPED_BOOL,
      blend: "add",
      usesTime: false,
      usesScreenUv: false,
    },
    {
      name: "affliction entangled",
      source: AFFLICTION_ENTANGLED_MAIN,
      blend: "mix",
      usesTime: true,
      usesScreenUv: false,
    },
  ];

  for (const shader of cases) {
    it(`${shader.name}: emits one module with both entry points`, () => {
      const out = transpileGodotShaderWgsl(shader.source);
      expect(out.vertexEntry).toBe("vs_main");
      expect(out.fragmentEntry).toBe("fs_main");
      expect(out.wgsl).toContain("@vertex\nfn vs_main(");
      expect(out.wgsl).toContain("@fragment\nfn fs_main(");
      expect(out.blend).toBe(shader.blend);
      expect(out.usesTime).toBe(shader.usesTime);
      expect(out.usesScreenUv).toBe(shader.usesScreenUv);
      // Every module ends on the canvas contract, whatever the shader did.
      expect(out.wgsl).toContain("return vec4f(COLOR.rgb * COLOR.a, COLOR.a);");
      // The uniform buffer a pipeline will allocate is always 16-byte-aligned.
      expect(out.uniformStructSizeBytes % 16).toBe(0);
      expect(out.bindings).toEqual({
        uniform: 0,
        texture: 1,
        textureSampler: 2,
        userSamplersBase: 3,
      });
    });
  }

  it("the affliction trio transpiles through its includes", async () => {
    const galvanized = transpileGodotShaderWgsl(
      await expand(AFFLICTION_GALVANIZED),
    );
    expect(galvanized.blend).toBe("add");
    expect(galvanized.usesTime).toBe(true);
    expect(galvanized.samplers).toEqual([{ name: "lut", repeat: false }]);
    // The include's `float input` was renamed by the SHARED front-end, before either
    // emitter saw it — the WGSL side must not have to re-discover that.
    expect(galvanized.wgsl).toContain("inputValue: f32");
    expect(galvanized.wgsl).not.toContain("input: f32");

    const bound = transpileGodotShaderWgsl(await expand(AFFLICTION_BOUND_MAIN));
    expect(bound.blend).toBe("add");
    expect(bound.wgsl).toContain("fn tiling_and_offset(");
    expect(bound.wgsl).toContain("main_tex.rrr");
  });

  it("keeps Godot's own names for uniforms and samplers (the runtime binds by them)", () => {
    const out = transpileGodotShaderWgsl(SCRY_REVEAL);
    expect(out.samplers).toEqual([
      { name: "noiseTex1", repeat: true },
      { name: "noiseTex2", repeat: true },
    ]);
    expect(out.uniforms.map((u) => u.name)).toEqual([
      "borderColor",
      "colors",
      "circleData",
      "circles",
      "outerCircle",
      "gridFadeParams",
      "time",
      "uvMargin",
    ]);
    // …even where the emitted MODULE had to rename one: `time` collides with the
    // built-in TIME member of the same struct.
    expect(out.wgsl).toContain("time_gsw: f32,");
    expect(out.wgsl).toContain("_u.time_gsw - lastTimeChange");
    expect(out.uniforms.find((u) => u.name === "time")?.type).toBe("f32");
  });

  it("pairs each user sampler with its own sampler binding from 3", () => {
    const out = transpileGodotShaderWgsl(DOOM_BAR);
    expect(out.samplers.map((s) => s.name)).toEqual([
      "noise_tex",
      "gradient_tex",
    ]);
    expect(out.wgsl).toContain(
      "@group(0) @binding(3) var noise_tex: texture_2d<f32>;",
    );
    expect(out.wgsl).toContain(
      "@group(0) @binding(4) var noise_tex_smp: sampler;",
    );
    expect(out.wgsl).toContain(
      "@group(0) @binding(5) var gradient_tex: texture_2d<f32>;",
    );
    expect(out.wgsl).toContain(
      "@group(0) @binding(6) var gradient_tex_smp: sampler;",
    );
  });
});

// ---- uniform struct layout -------------------------------------------------

describe("wgslStructLayout", () => {
  it("places a scry-shaped field list at hand-computed offsets", () => {
    const layout = wgslStructLayout([
      { name: "uv_window", type: "vec4f" },
      { name: "uv_fit", type: "vec2f" },
      { name: "time", type: "f32" },
      { name: "modulate", type: "vec4f" },
      { name: "borderColor", type: "vec3f" },
      { name: "colors", type: "vec3f", arrayLength: 8 },
      { name: "circleData", type: "vec4f", arrayLength: 8 },
      { name: "circles", type: "i32" },
      { name: "outerCircle", type: "i32" },
      { name: "gridFadeParams", type: "vec3f", arrayLength: 121 },
      { name: "time_gsw", type: "f32" },
      { name: "uvMargin", type: "f32" },
    ]);
    const at = Object.fromEntries(
      layout.members.map((m) => [m.name, m.offsetBytes]),
    );
    expect(at).toEqual({
      uv_window: 0, //   vec4f  align 16, size 16 -> ends 16
      uv_fit: 16, //     vec2f  align  8, size  8 -> ends 24
      time: 24, //       f32    align  4, size  4 -> ends 28
      modulate: 32, //   vec4f  align 16          -> ends 48
      borderColor: 48, // vec3f align 16, size 12 -> ends 60
      colors: 64, //     8 x stride 16 = 128      -> ends 192
      circleData: 192, // 8 x stride 16 = 128     -> ends 320
      circles: 320, //   i32                      -> ends 324
      outerCircle: 324, // i32                    -> ends 328
      gridFadeParams: 336, // 121 x 16 = 1936     -> ends 2272
      time_gsw: 2272,
      uvMargin: 2276, //                          -> ends 2280
    });
    // vec3f keeps its 12-byte SIZE even though the next member starts 16-aligned.
    expect(
      layout.members.find((m) => m.name === "borderColor")?.sizeBytes,
    ).toBe(12);
    // …but as an ARRAY element it is padded to a 16-byte stride.
    expect(layout.members.find((m) => m.name === "colors")?.sizeBytes).toBe(
      128,
    );
    expect(layout.sizeBytes).toBe(2288); // 2280 rounded up to 16
    expect(layout.sizeBytes % 16).toBe(0);
    expect(layout.alignBytes).toBe(16);
  });

  it("aligns mat3x3f to 16 and gives it 48 bytes (three padded columns)", () => {
    const layout = wgslStructLayout([
      { name: "a", type: "f32" },
      { name: "m", type: "mat3x3f" },
      { name: "b", type: "vec2f" },
    ]);
    expect(
      layout.members.map((m) => [m.name, m.offsetBytes, m.sizeBytes]),
    ).toEqual([
      ["a", 0, 4],
      ["m", 16, 48],
      ["b", 64, 8],
    ]);
    expect(layout.sizeBytes).toBe(80); // 72 rounded up to 16
  });

  it("rounds an all-scalar struct up to 16 bytes", () => {
    const layout = wgslStructLayout([
      { name: "a", type: "f32" },
      { name: "b", type: "i32" },
    ]);
    expect(layout.sizeBytes).toBe(16);
  });

  it("refuses a float array: its 4-byte stride is illegal in a uniform buffer", () => {
    expect(() =>
      wgslStructLayout([{ name: "weights", type: "f32", arrayLength: 4 }]),
    ).toThrow(UnsupportedWgslShaderError);
    expect(() =>
      wgslStructLayout([{ name: "offsets", type: "vec2f", arrayLength: 4 }]),
    ).toThrow(/16-byte element stride/);
  });
});

describe("uniform offsets a writer will use", () => {
  it("records every built-in the shader actually reads, and nothing else", () => {
    const ripple = transpileGodotShaderWgsl(CARD_RIPPLE);
    expect(ripple.builtinOffsets.uvWindow).toBe(0);
    expect(ripple.builtinOffsets.uvFit).toBe(16);
    expect(ripple.builtinOffsets.time).toBe(24);
    expect(ripple.builtinOffsets.modulate).toBe(32);
    expect(ripple.builtinOffsets.screenOrigin).toBeUndefined();
    expect(ripple.builtinOffsets.texturePixelSize).toBeUndefined();

    // SCREEN_UV without a capture IS supported: it is two uniforms, not a texture.
    const doom = transpileGodotShaderWgsl(DOOM_BAR);
    expect(doom.usesScreenUv).toBe(true);
    expect(typeof doom.builtinOffsets.screenOrigin).toBe("number");
    expect(typeof doom.builtinOffsets.screenSize).toBe("number");
    expect(doom.builtinOffsets.screenSize).toBe(
      (doom.builtinOffsets.screenOrigin ?? 0) + 8,
    );
    expect(doom.wgsl).toContain(
      "let SCREEN_UV = _u.screen_origin + GODOT_UV * _u.screen_size;",
    );
    // doom_bar is a pure fill: no MODULATE member is allocated at all.
    expect(doom.builtinOffsets.modulate).toBeUndefined();
  });

  it("stores a bool uniform as f32 and reports its Godot type and default", () => {
    const out = transpileGodotShaderWgsl(STEPPED_BOOL);
    const invert = out.uniforms.find((u) => u.name === "InvertNoiseMask");
    expect(invert).toMatchObject({
      type: "f32",
      godotType: "bool",
      sizeBytes: 4,
      default: 1,
    });
    const noDefault = out.uniforms.find((u) => u.name === "NoDefault");
    expect(noDefault?.default).toBeUndefined();
    // The uniforms are 4 bytes apart, in declaration order, after the built-ins.
    expect(out.uniforms.map((u) => u.offsetBytes)).toEqual([24, 28, 32, 40]);
    expect(out.uniformStructSizeBytes).toBe(48);
  });

  it("reports array uniforms with their element count and padded size", () => {
    const out = transpileGodotShaderWgsl(SCRY_REVEAL);
    expect(out.uniforms.find((u) => u.name === "gridFadeParams")).toMatchObject(
      {
        type: "vec3f",
        godotType: "vec3",
        arrayLength: 121,
        offsetBytes: 336,
        sizeBytes: 121 * 16,
      },
    );
    expect(out.uniformStructSizeBytes).toBe(2288);
  });
});

// ---- one test per translation rule -----------------------------------------

describe("translation rules (each one is load-bearing on its own)", () => {
  const scry = transpileGodotShaderWgsl(SCRY_REVEAL);
  const hsv = transpileGodotShaderWgsl(HSV);
  const ripple = transpileGodotShaderWgsl(CARD_RIPPLE);
  const stepped = transpileGodotShaderWgsl(STEPPED_BOOL);
  const doom = transpileGodotShaderWgsl(DOOM_BAR);
  const power = transpileGodotShaderWgsl(POWER);

  it("rewrites every ternary to select() and leaves no '?' behind", () => {
    // scry has five: three guarded array reads, and two `cond ? 0.0 : x`.
    expect(scry.wgsl).toContain(
      "select(0.0, _u.gridFadeParams[index].z, validIndex)",
    );
    expect(scry.wgsl).toContain(
      "select(mask, 0.0, (normcoord.x + normcoord.y) < 3.0 || !validIndex)",
    );
    expect(scry.wgsl.match(/select\(/g)?.length).toBeGreaterThanOrEqual(5);
    expect(scry.wgsl).not.toContain("?");
  });

  it("samples through textureSampleLevel with the paired sampler, never texture()", () => {
    expect(ripple.wgsl).toContain(
      "textureSampleLevel(TEXTURE, TEXTURE_smp, UV, 0.0)",
    );
    expect(doom.wgsl).toContain(
      "textureSampleLevel(noise_tex, noise_tex_smp, SCREEN_UV * 0.1",
    );
    for (const out of [scry, hsv, ripple, stepped, doom, power]) {
      // A surviving GLSL `texture(` call would be an undeclared function in WGSL.
      expect(out.wgsl).not.toMatch(/(?<![\w.])texture\s*\(/);
    }
  });

  it("emits the floor-signed mod polyfill only where mod() is used", () => {
    expect(ripple.wgsl).toContain("fn godot_mod(x: f32, y: f32) -> f32");
    expect(ripple.wgsl).toContain(
      "godot_mod(_u.time * _u.ripple_speed + COLOR.a, _u.modulo_width)",
    );
    expect(ripple.wgsl).toContain("floor(x / y)");
    // Nobody else in the corpus calls mod, so nobody else carries the polyfill.
    expect(hsv.wgsl).not.toContain("godot_mod");
    expect(scry.wgsl).not.toContain("godot_mod");
  });

  it("picks the mod polyfill by component count and broadcasts the scalar side", async () => {
    // WGSL has no user-function overloading, so `mod(vec2, float)` cannot be one name.
    const galvanized = transpileGodotShaderWgsl(
      await expand(AFFLICTION_GALVANIZED),
    );
    expect(galvanized.wgsl).toContain(
      "fn godot_mod2(x: vec2f, y: vec2f) -> vec2f",
    );
    expect(galvanized.wgsl).toContain(
      "godot_mod2(vec2f(radius * zoom, angle * repeat), vec2f(1.0))",
    );
    expect(galvanized.wgsl).not.toContain("fn godot_mod(");
  });

  it("maps two-argument atan to atan2 and keeps the one-argument form", () => {
    expect(scry.wgsl).toContain("atan2(fromCenter.y, fromCenter.x)");
    expect(scry.wgsl).not.toMatch(/(?<![\w.2])atan\([^)]*,/);
  });

  it("polyfills inverse() on a mat3", () => {
    expect(hsv.wgsl).toContain("fn godot_inverse3(m: mat3x3f) -> mat3x3f");
    expect(hsv.wgsl).toContain("godot_inverse3(RGB_to_YIQ)");
    expect(hsv.wgsl).not.toContain("inverse(RGB_to_YIQ)");
  });

  it("renames casts and constructors to their WGSL spellings", () => {
    expect(hsv.wgsl).toContain(
      "mat3x3f(vec3f(0.2989,0.5959,0.2115), vec3f(0.5870,-0.2774,-0.5229), vec3f(0.1140,-0.3216,0.3114))",
    );
    expect(scry.wgsl).toContain(
      "i32(floor(gridpos.y * gridSizef + gridpos.x))",
    );
    expect(scry.wgsl).toContain("vec2f(f32(x), f32(y))");
    expect(stepped.wgsl).toContain("f32(n_out60p0)");
    // No Godot spelling survives as a call.
    expect(scry.wgsl).not.toMatch(
      /(?<![\w.])(?:vec[234]|mat[234]|float|int)\s*\(/,
    );
  });

  it("turns declarations into typed vars and bare ones into zero-inited vars", () => {
    expect(ripple.wgsl).toContain("var sdf_alpha: f32 = godot_mod(");
    expect(hsv.wgsl).toContain("var RGB_to_YIQ: mat3x3f = ");
    expect(scry.wgsl).toContain("var validIndex: bool = ");
    expect(scry.wgsl).toContain("var col: vec3f = _u.colors[0];");
    // `float lastmask;` — WGSL zero-initializes, matching the GLSL the shader relies on.
    expect(scry.wgsl).toContain("var lastmask: f32;");
    expect(stepped.wgsl).toContain("var n_out65p0: f32;");
  });

  it("lifts top-level consts to module consts and defines PI when read", () => {
    expect(scry.wgsl).toContain("const PI: f32 = 3.141592653589793;");
    expect(scry.wgsl).toContain("const borderwidth: f32 = 0.05;");
    expect(scry.wgsl).toContain("const gridSizef: f32 = 11.0;");
    expect(scry.wgsl).toContain("const gridSize: i32 = 11;");
    // A shader that never says PI does not get the constant.
    expect(ripple.wgsl).not.toContain("const PI:");
  });

  it("rewrites for-loops to WGSL var form and keeps continue/break", () => {
    expect(scry.wgsl).toContain("for (var x: i32 = -1; x <= 1; x++) {");
    expect(scry.wgsl).toContain("for (var i: i32 = 0; i < _u.circles; i++) {");
    // WGSL demands braces even on a single-statement if body.
    expect(scry.wgsl).toContain("if (x == 0 && y == 0) {\n        continue;");
    expect(scry.wgsl).toContain("if (!validIndex_n) {\n        continue;");
  });

  it("expands a multi-component swizzle assignment (illegal in WGSL) per component", () => {
    // `COLOR.rgb = texture(gradient_tex, …).rgb;`
    expect(doom.wgsl).toMatch(
      /let _swz0 = vec3f\(textureSampleLevel\(gradient_tex, gradient_tex_smp, vec2f\(final_val,0\.0\), 0\.0\)\.rgb\);\n\s*COLOR\.x = _swz0\.x;\n\s*COLOR\.y = _swz0\.y;\n\s*COLOR\.z = _swz0\.z;/,
    );
    // `COLOR.rgb += <scalar>` keeps the read-modify-write, and the target's own vector
    // constructor splats the scalar right-hand side.
    expect(power.wgsl).toContain(
      "let _swz0 = vec3f(abs(sin(_u.time * 3.0)) * 0.2 * when_eq(_u.pulse, 1));",
    );
    expect(power.wgsl).toContain("COLOR.x = COLOR.x + _swz0.x;");
    expect(power.wgsl).toContain("COLOR.z = COLOR.z + _swz0.z;");
    // A SINGLE-component assignment is legal WGSL and passes straight through.
    expect(ripple.wgsl).toContain("COLOR.a = smoothstep(");
    expect(stepped.wgsl).toContain("COLOR.a = n_out65p0;");
    // No multi-component swizzle survives on the left of an assignment.
    expect(doom.wgsl).not.toMatch(/\.[xyzwrgba]{2,4}\s*[-+*/]?=[^=]/);
  });

  it("hoists a bool uniform as a fragment-local alias over an f32 flag", () => {
    expect(stepped.wgsl).toContain("InvertNoiseMask: f32,"); // the struct member
    expect(stepped.wgsl).toContain(
      "let InvertNoiseMask: bool = (_u.InvertNoiseMask != 0.0);",
    );
    expect(stepped.wgsl).toContain("var n_out60p0: bool = InvertNoiseMask;");
    // A bool the body never reads keeps its member (offsets!) but gets no alias.
    expect(stepped.wgsl).toContain("UseOuterColor: f32,");
    expect(stepped.wgsl).not.toContain("let UseOuterColor: bool");
  });

  it("emits helper functions as fn signatures, params and return type included", () => {
    expect(scry.wgsl).toContain("fn getGridPos(uv: vec2f) -> vec2f {");
    expect(scry.wgsl).toContain("fn aaStep(edge: f32, gradient: f32) -> f32 {");
    expect(power.wgsl).toContain("fn when_eq(x: f32, y: f32) -> f32 {");
    // A helper may read the uniform struct — it is module scope.
    expect(scry.wgsl).toContain("_u.uvMargin");
    // fwidth exists in WGSL under the same name and is left alone.
    expect(scry.wgsl).toContain("fwidth(gradient)");
  });

  it("builds the fragment prelude in the GLSL emitter's order, flip in the VERTEX", () => {
    expect(ripple.wgsl).toContain(
      "let GODOT_UV = _u.uv_window.xy + raw_uv * _u.uv_window.zw;",
    );
    expect(ripple.wgsl).toContain(
      "let UV = (GODOT_UV - vec2f(0.5)) / _u.uv_fit + vec2f(0.5);",
    );
    // The Y flip is in vs_main, so fs_main never flips.
    expect(ripple.wgsl).toContain(
      "out.uv = vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5);",
    );
    expect(ripple.wgsl).toContain("var COLOR: vec4f = textureSampleLevel(");
    // card_ripple never names MODULATE -> the engine multiply is appended.
    expect(ripple.wgsl).toContain("COLOR = COLOR * _u.modulate;");
  });

  it("carries the shared front-end's opaque-fill and varying-hoist decisions", () => {
    // doom_bar is a pure fill that never touches COLOR.a: seed opaque, no auto-modulate.
    expect(doom.wgsl).toContain(
      "var COLOR: vec4f = vec4f(textureSampleLevel(TEXTURE, TEXTURE_smp, UV, 0.0).rgb, 1.0);",
    );
    expect(doom.wgsl).not.toContain("COLOR = COLOR * _u.modulate;");
    // hsv's vertex varying becomes a MODULATE-seeded local, and it applies modulate itself.
    expect(hsv.wgsl).toContain("var modulate_color: vec4f = _u.modulate;");
    expect(hsv.wgsl).not.toContain("COLOR = COLOR * _u.modulate;");
  });

  it("leaves bare int literals alone — WGSL abstract ints convert on their own", () => {
    // The GLSL emitter must promote `smoothstep(0, ease, …)`; WGSL must NOT, and a
    // promotion would break the genuinely integer contexts next door.
    expect(ripple.wgsl).toContain("smoothstep(0, _u.ease, sdf_alpha)");
    expect(hsv.wgsl).toContain("mix(0, 6.283185, hue)");
    expect(scry.wgsl).toContain("clamp(timediff / 0.5, 0, 1)");
    expect(power.wgsl).toContain("when_eq(_u.pulse, 1)");
  });

  it("emits no preprocessor directive of any kind", () => {
    for (const out of [scry, hsv, ripple, stepped, doom, power]) {
      expect(out.wgsl).not.toContain("#define");
      expect(out.wgsl).not.toContain("#");
    }
  });
});

// ---- failure contract ------------------------------------------------------

describe("failure contract — which error class, and why it matters", () => {
  it("refuses SCREEN_TEXTURE by name, as the WGSL-only class", () => {
    expect(() => transpileGodotShaderWgsl(SCREEN_DISTORT)).toThrow(
      UnsupportedWgslShaderError,
    );
    expect(() => transpileGodotShaderWgsl(SCREEN_DISTORT)).toThrow(
      /hint_screen_texture|SCREEN_TEXTURE/,
    );
  });

  it("refuses a hint_screen_texture sampler under any name", () => {
    let error: unknown;
    try {
      transpileGodotShaderWgsl(SCREEN_ALIASED);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnsupportedWgslShaderError);
    expect((error as Error).message).toContain("hint_screen_texture");
    expect((error as Error).message).toContain("screen_tex");
  });

  it("refuses SCREEN_PIXEL_SIZE by name", () => {
    expect(() => transpileGodotShaderWgsl(SCREEN_PIXEL_SIZE_ONLY)).toThrow(
      /SCREEN_PIXEL_SIZE/,
    );
    expect(() => transpileGodotShaderWgsl(SCREEN_PIXEL_SIZE_ONLY)).toThrow(
      UnsupportedWgslShaderError,
    );
  });

  it("refuses a float array uniform (its stride cannot be 16)", () => {
    const source = `
shader_type canvas_item;
uniform float weights[4];
void fragment() { COLOR.a = weights[0]; }
`;
    let error: unknown;
    try {
      transpileGodotShaderWgsl(source);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnsupportedWgslShaderError);
    expect((error as Error).message).toContain("weights");
  });

  it("refuses a ternary that is not a whole right-hand side", () => {
    const source = `
shader_type canvas_item;
uniform float k;
void fragment() { COLOR.a = mix(0.0, 1.0, k > 0.5 ? 1.0 : 0.0); }
`;
    expect(() => transpileGodotShaderWgsl(source)).toThrow(
      UnsupportedWgslShaderError,
    );
    expect(() => transpileGodotShaderWgsl(source)).toThrow(/ternary/);
  });

  it("a while loop is still the PLAIN error: no backend can render it", () => {
    let error: unknown;
    try {
      transpileGodotShaderWgsl(
        "shader_type canvas_item;\nvoid fragment(){ int i = 0; while(i < 3){ i++; } }",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnsupportedShaderError);
    // The distinction IS the fallback decision: a WGSL-class error puts one binding on
    // WebGL, a plain one puts the node on the CSS render.
    expect(error).not.toBeInstanceOf(UnsupportedWgslShaderError);
  });

  it("an unsupported built-in outranks a WGSL complaint about the same shader", () => {
    // Both problems are present. `rejectUnsupported` runs FIRST, exactly as on the GLSL
    // path, so the answer is the stronger, backend-independent one.
    const source = `
shader_type canvas_item;
uniform sampler2D SCREEN_TEXTURE : hint_screen_texture;
void fragment() { COLOR = texture(SCREEN_TEXTURE, SCREEN_UV) * FRAGCOORD.x; }
`;
    let error: unknown;
    try {
      transpileGodotShaderWgsl(source);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnsupportedShaderError);
    expect(error).not.toBeInstanceOf(UnsupportedWgslShaderError);
    expect((error as Error).message).toContain("FRAGCOORD");
  });

  it("a non-canvas_item shader still fails in the shared front-end", () => {
    expect(() =>
      transpileGodotShaderWgsl("shader_type spatial;\nvoid fragment(){}"),
    ).toThrow(UnsupportedShaderError);
  });
});

// ---- purity ----------------------------------------------------------------

describe("the module is pure strings", () => {
  const sourcePath = fileURLToPath(
    new URL("../src/shaders/transpile-wgsl.ts", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");

  // Both languages spell a line comment `//`. Comments are stripped before these checks
  // because the point is what the module REFERENCES, not what it explains: the premultiply
  // note has to be free to name `GPUCanvasContext` — that name IS the reason for the rule.
  // A line that is a comment, or a TS string literal holding one line of an emitted WGSL
  // comment (`"// PREMULTIPLIED. …"`), counts as a comment either way.
  const withoutComments = (text: string): string =>
    text
      .split("\n")
      .filter((line) => !/^\s*["'`]?\s*\/\//.test(line))
      .join("\n");

  it("imports nothing but the shared front-end", () => {
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["./godot-shader"]);
    expect(withoutComments(source)).not.toContain("webgpu/device");
  });

  it("names no GPU* global (node has the TS types but not the values)", () => {
    // `GPUBufferUsage` / `GPUShaderStage` at module scope would throw the moment a node
    // CLI imported this file. The parity and perf harnesses both do exactly that.
    const uses = withoutComments(source).match(/(?<![\w"])GPU[A-Z]\w*/g) ?? [];
    expect(uses).toEqual([]);
  });

  it("emits WGSL that mentions no host-side API", () => {
    for (const out of [
      transpileGodotShaderWgsl(SCRY_REVEAL),
      transpileGodotShaderWgsl(DOOM_BAR),
    ]) {
      expect(withoutComments(out.wgsl)).not.toMatch(/GPU[A-Z]/);
      expect(withoutComments(out.wgsl)).not.toContain("navigator");
    }
  });
});

// THE SAME CONTAINER FIX, on this backend — because both entries take the caller's raw
// fetch and either one can be the backend the runtime adopted (WebGPU is auto-adopted where
// it is available). A fix in the GLSL entry alone would leave WebGPU pages still compiling
// a `.tres`. Synthetic wrapper, two-line shader, same as the GLSL twin's.
const TRES_WRAPPER_WGSL = [
  '[gd_resource type="VisualShader" load_steps=2 format=3 uid="uid://synthetic"]',
  "",
  '[sub_resource type="VisualShaderNodeFloatParameter" id="Param_test"]',
  'parameter_name = "tint"',
  "",
  "[resource]",
  'code = "shader_type canvas_item;\\nuniform float tint;\\nvoid fragment() {\\n\\tCOLOR.rgb *= tint;\\n}\\n"',
  "",
].join("\n");

describe("a Godot resource container (WGSL)", () => {
  it("transpiles the shader inside it and emits none of the container", () => {
    const out = transpileGodotShaderWgsl(TRES_WRAPPER_WGSL);
    expect(out.wgsl).not.toContain("[gd_resource");
    expect(out.wgsl).not.toContain("[sub_resource");
    expect(out.wgsl).toContain("tint");
  });

  it("refuses a container with no code property", () => {
    const empty =
      '[gd_resource type="VisualShader" format=3]\n\n[resource]\ngraph_offset = Vector2(0, 0)\n';
    expect(() => transpileGodotShaderWgsl(empty)).toThrow(
      UnsupportedShaderError,
    );
  });
});
