import {
  expandGodotShaderIncludes,
  transpileGodotShader,
  transpileGodotShader as transpileGodotShaderCore,
  UnsupportedShaderError,
} from "@godot-scene-web/effects/shaders";
import { describe, expect, it } from "vitest";
import { promoteIntLiterals } from "../src/shaders/godot-shader";

// The real game shaders (verbatim) the transpiler must handle.
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

// The combat HP-bar doom fill: two TIME-scrolled noise samples (SCREEN_UV-anchored)
// through a gradient ramp, with two procedural sampler uniforms.
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

describe("transpileGodotShader — card_ripple", () => {
  const out = transpileGodotShader(CARD_RIPPLE);

  it("captures render_mode, uniforms, and TIME usage", () => {
    expect(out.blend).toBe("add");
    expect(out.usesTime).toBe(true);
    expect(out.uniforms.map((u) => u.name).sort()).toEqual([
      "ease",
      "modulo_width",
      "ripple_speed",
      "width",
    ]);
    expect(out.uniforms.every((u) => u.type === "float")).toBe(true);
  });

  it("emits valid-shaped GLSL: COLOR pre-init, promoted ints, auto-modulate", () => {
    const f = out.fragmentGlsl;
    expect(f).toContain("#version 300 es");
    expect(f).toContain("vec4 COLOR = texture(TEXTURE, UV);");
    // `smoothstep(0, ease, …)` -> the int literal is promoted for GLSL ES.
    expect(f).toContain("smoothstep(0.0, ease, sdf_alpha)");
    // card_ripple never references MODULATE -> engine auto-multiplies at the end.
    expect(f).toContain("COLOR *= MODULATE;");
    // PREMULTIPLIED, matching the shared canvas's declared `premultipliedAlpha: true` (see
    // `webgl/shared-gl.ts`, pinned in `shared-gl.test.ts`) — the shader backend draws with BLEND
    // off, so whatever this line writes IS the canvas. Returning straight COLOR here halos every
    // partially transparent node, with no compile error and nothing visible in a readback.
    // Character-for-character the WGSL emitter's return (`webgpu/transpile-wgsl.ts`).
    expect(f).toContain("fragColor = vec4(COLOR.rgb * COLOR.a, COLOR.a);");
    expect(f).toContain("uniform float TIME;");
    expect(f).toContain("uniform sampler2D TEXTURE;");
  });
});

describe("HTML adapter — shared semantic compiler", () => {
  it("uses the core compiler verbatim for TIME and SCREEN_TEXTURE fixtures", () => {
    const source = `shader_type canvas_item;
uniform sampler2D screen_copy : hint_screen_texture;
void fragment() { COLOR = texture(screen_copy, SCREEN_UV + vec2(TIME)); }`;
    expect(transpileGodotShader).toBe(transpileGodotShaderCore);
    expect(transpileGodotShader(source)).toEqual(
      transpileGodotShaderCore(source),
    );
  });
});

describe("transpileGodotShader — hsv (varying + vertex + manual modulate)", () => {
  const out = transpileGodotShader(HSV);

  it("hoists the vertex varying as a MODULATE-derived local and does NOT auto-multiply", () => {
    const f = out.fragmentGlsl;
    // vertex `modulate_color = COLOR` -> a local seeded from the MODULATE uniform.
    expect(f).toContain("vec4 modulate_color = MODULATE;");
    expect(f).toContain("uniform vec4 MODULATE;");
    // It applies modulate itself (`COLOR *= modulate_color`), so NO auto-multiply
    // line is appended (only the manual one from the body survives). Matched as the
    // EMITTED LINE rather than as "…followed by fragColor": the emitter now writes a
    // comment between the two, and an adjacency regex would have gone quietly vacuous.
    expect(f.includes("  COLOR *= MODULATE;\n")).toBe(false);
    expect(out.usesTime).toBe(false);
    expect(out.blend).toBe("mix");
  });

  it("promotes ints inside the body (mix(0, …)) and keeps vec/mat identifiers", () => {
    expect(out.fragmentGlsl).toContain("mix(0.0, 6.283185, hue)");
    expect(out.fragmentGlsl).toContain("mat3");
    expect(out.fragmentGlsl).toContain("inverse(RGB_to_YIQ)");
  });
});

describe("transpileGodotShader — power (helper fn + TIME)", () => {
  const out = transpileGodotShader(POWER);
  it("keeps the helper function and promotes the bare int arg", () => {
    expect(out.usesTime).toBe(true);
    expect(out.fragmentGlsl).toContain("float when_eq(float x, float y)");
    expect(out.fragmentGlsl).toContain("when_eq(pulse, 1.0)");
    expect(out.fragmentGlsl).toContain("COLOR *= MODULATE;");
  });
});

describe("transpileGodotShader — doom_bar (SCREEN_UV + procedural samplers)", () => {
  const out = transpileGodotShader(DOOM_BAR);

  it("captures TIME + SCREEN_UV usage and both samplers (noise repeats)", () => {
    expect(out.usesTime).toBe(true);
    expect(out.usesScreenUv).toBe(true);
    expect(out.uniforms).toEqual([]); // samplers are not scalar/vector uniforms
    expect(out.samplers).toEqual([
      { name: "noise_tex", repeat: true },
      { name: "gradient_tex", repeat: false },
    ]);
  });

  it("emits SCREEN_UV from the runtime screen rect and declares both samplers", () => {
    const f = out.fragmentGlsl;
    expect(f).toContain("#version 300 es");
    expect(f).toContain("uniform sampler2D noise_tex;");
    expect(f).toContain("uniform sampler2D gradient_tex;");
    expect(f).toContain("uniform vec2 _godot_screen_origin;");
    expect(f).toContain("uniform vec2 _godot_screen_size;");
    expect(f).toContain(
      "vec2 GODOT_UV = _godot_uv_window.xy + vec2(v_uv.x, 1.0 - v_uv.y) * _godot_uv_window.zw;",
    );
    expect(f).toContain(
      "vec2 SCREEN_UV = _godot_screen_origin + GODOT_UV * _godot_screen_size;",
    );
    // The fragment OVERWRITES `COLOR.rgb = gradient`, which discards self_modulate
    // in Godot -> the fill is the gradient ALONE, so NO trailing auto-multiply.
    expect(f).not.toContain("COLOR *= MODULATE;");
    // It overwrites COLOR.rgb and never touches COLOR.a / samples TEXTURE, so the
    // node paints OPAQUE (a crisp solid bar; the texture's soft cap alpha is dropped).
    expect(f).toContain("vec4 COLOR = vec4(texture(TEXTURE, UV).rgb, 1.0);");
    // Int literal inside the gradient lookup is promoted for GLSL ES.
    expect(f).toContain("vec2(final_val,0.0)");
  });
});

describe("transpileGodotShader — normal_map_point (recolor: reads COLOR)", () => {
  // The map-node / relic recolor shader: it READS the sampled COLOR (distance to a key
  // color) and only CONDITIONALLY overwrites COLOR.rgb. It is a texture EFFECT, not a
  // pure fill — so the sprite's texture alpha (its SHAPE) must be preserved. Forcing
  // COLOR.a = 1 (as a pure fill does) painted the sprite's transparent surround as a
  // solid rectangle — the "white rectangle" map-node/relic-icon bug.
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
  const out = transpileGodotShader(NORMAL_MAP_POINT);

  it("keeps the texture alpha (sprite shape) instead of forcing an opaque rectangle", () => {
    const f = out.fragmentGlsl;
    // NOT the opaque-fill init — the texture's alpha is kept so the transparent surround
    // stays transparent (no white rectangle).
    expect(f).toContain("vec4 COLOR = texture(TEXTURE, UV);");
    expect(f).not.toContain(
      "vec4 COLOR = vec4(texture(TEXTURE, UV).rgb, 1.0);",
    );
  });

  it("still auto-applies the node MODULATE (a read-COLOR effect is not a pure fill)", () => {
    expect(out.fragmentGlsl).toContain("COLOR *= MODULATE;");
  });
});

describe("transpileGodotShader — scry_reveal (Crystal Sphere shader)", () => {
  const out = transpileGodotShader(SCRY_REVEAL);

  it("captures array uniforms, int uniforms, samplers, TIME usage, and PI", () => {
    expect(out.usesTime).toBe(true);
    expect(out.samplers).toEqual([
      { name: "noiseTex1", repeat: true },
      { name: "noiseTex2", repeat: true },
    ]);
    expect(out.uniforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "colors",
          type: "vec3",
          arrayLength: 8,
        }),
        expect.objectContaining({
          name: "circleData",
          type: "vec4",
          arrayLength: 8,
        }),
        expect.objectContaining({
          name: "gridFadeParams",
          type: "vec3",
          arrayLength: 121,
        }),
        expect.objectContaining({ name: "circles", type: "int", default: 8 }),
        expect.objectContaining({
          name: "outerCircle",
          type: "int",
          default: -1,
        }),
      ]),
    );
  });

  it("emits GLSL declarations for array uploads and keeps integer loop/index contexts", () => {
    const f = out.fragmentGlsl;
    expect(f).toContain(
      "vec2 GODOT_UV = _godot_uv_window.xy + vec2(v_uv.x, 1.0 - v_uv.y) * _godot_uv_window.zw;",
    );
    expect(f).toContain("vec2 UV = (GODOT_UV - 0.5) / _godot_uv_fit + 0.5;");
    expect(f).toContain("const float PI = 3.141592653589793;");
    expect(f).toContain("uniform vec3 colors[8];");
    expect(f).toContain("uniform vec4 circleData[8];");
    expect(f).toContain("uniform vec3 gridFadeParams[121];");
    expect(f).toContain("for (int x = -1; x <= 1; x++)");
    expect(f).toContain("gridFadeParams[index].z");
    expect(f).toContain("colors[i+1]");
    expect(f).toContain("clamp(timediff / 0.5, 0.0, 1.0)");
    expect(f).toContain("clamp(timediff_n / 0.5, 0.0, 1.0)");
    expect(f).toContain("if (x == 0 && y == 0) continue;");
  });
});

describe("transpileGodotShader — bool uniforms (stepped fire/water shimmer subset)", () => {
  // The VisualShader-generated `vfx_stepped_shader_fire_add.tres` family declares
  // `uniform bool InvertNoiseMask = true;` — the boolean default must survive as 1
  // (`raw ?? default` in the runtime uploads it via uniform1i). Parsing it as
  // parseFloat("true") = NaN used to DROP it, flipping the mask term from
  // (1-b)·b (thin shimmer) to b·b (a full-quad additive wash).
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
  const out = transpileGodotShader(STEPPED_BOOL);

  it("parses bool uniforms with true/false defaults as 1/0", () => {
    expect(out.uniforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "InvertNoiseMask",
          type: "bool",
          default: 1,
        }),
        expect.objectContaining({
          name: "UseOuterColor",
          type: "bool",
          default: 0,
        }),
        expect.objectContaining({ name: "NoDefault", type: "bool" }),
      ]),
    );
    const noDefault = out.uniforms.find((u) => u.name === "NoDefault");
    expect(noDefault?.default).toBeUndefined();
  });

  it("declares the bool uniforms and keeps blend_add", () => {
    expect(out.blend).toBe("add");
    expect(out.fragmentGlsl).toContain("uniform bool InvertNoiseMask;");
    expect(out.fragmentGlsl).toContain("uniform bool UseOuterColor;");
    expect(out.fragmentGlsl).toContain("uniform sampler2D NoiseMask;");
  });
});

describe("transpileGodotShader — card affliction shaders", () => {
  it("expands gdshader includes and handles the common affliction overlay subset", async () => {
    const expanded = await expandGodotShaderIncludes(
      AFFLICTION_GALVANIZED,
      (path) => AFFLICTION_INCLUDES[path],
    );
    const out = transpileGodotShader(expanded);

    expect(expanded).not.toContain("#include");
    expect(out.blend).toBe("add");
    expect(out.usesTime).toBe(true);
    expect(out.samplers).toEqual([{ name: "lut", repeat: false }]);
    expect(out.uniforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "blink_st", type: "vec4" }),
        expect.objectContaining({ name: "blink_smoothstep", type: "vec2" }),
      ]),
    );
    expect(out.fragmentGlsl).toContain("vec4 vertex_color = MODULATE;");
    expect(out.fragmentGlsl).toContain("float erosion_from_factors");
    expect(out.fragmentGlsl).toContain("float inputValue");
    expect(out.fragmentGlsl).not.toContain("float input)");
  });

  it("handles Bound chain and Entangled main overlay shaders", async () => {
    const boundExpanded = await expandGodotShaderIncludes(
      AFFLICTION_BOUND_MAIN,
      (path) => AFFLICTION_INCLUDES[path],
    );
    const bound = transpileGodotShader(boundExpanded);
    expect(bound.blend).toBe("add");
    expect(bound.usesTime).toBe(true);
    expect(bound.uniforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "bright_st", type: "vec4" }),
        expect.objectContaining({ name: "bright_energy", type: "float" }),
      ]),
    );
    expect(bound.fragmentGlsl).toContain("vec4 vertex_color = MODULATE;");
    expect(bound.fragmentGlsl).toContain("tiling_and_offset");
    expect(bound.fragmentGlsl).toContain("main_tex.rrr");

    const entangled = transpileGodotShader(AFFLICTION_ENTANGLED_MAIN);
    expect(entangled.blend).toBe("mix");
    expect(entangled.usesTime).toBe(true);
    expect(entangled.samplers).toEqual([{ name: "vine_lut", repeat: false }]);
    expect(entangled.uniforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "distortion_st", type: "vec4" }),
        expect.objectContaining({
          name: "distortion_intensity",
          type: "float",
        }),
      ]),
    );
    expect(entangled.fragmentGlsl).toContain("vec4 vertex_color = MODULATE;");
    expect(entangled.fragmentGlsl).toContain("main_tex_distorted");
  });
});

describe("transpileGodotShader — SCREEN_TEXTURE (screen-read distortion)", () => {
  // The motivating game shader shape: distort the already-drawn background content by
  // sampling SCREEN_TEXTURE at a noise-offset SCREEN_UV.
  const DISTORT = `
shader_type canvas_item;
uniform sampler2D SCREEN_TEXTURE : hint_screen_texture, repeat_disable, filter_nearest;
uniform sampler2D noise_tex : repeat_enable;
uniform float intensity = 0.01;
void fragment() {
    vec2 offset = (texture(noise_tex, UV + TIME * 0.05).rg - 0.5) * intensity;
    COLOR = texture(SCREEN_TEXTURE, SCREEN_UV + offset);
}
`;
  const out = transpileGodotShader(DISTORT);

  it("transpiles, flags usesScreenTexture, and keeps SCREEN_TEXTURE out of samplers", () => {
    expect(out.usesScreenTexture).toBe(true);
    expect(out.usesScreenPixelSize).toBe(false);
    // The hint_screen_texture uniform is the runtime's screen capture, NOT a user
    // sampler (the runtime would try to resolve it as a shader_parameter URL).
    expect(out.samplers).toEqual([{ name: "noise_tex", repeat: true }]);
    expect(out.uniforms).toEqual([
      expect.objectContaining({ name: "intensity", type: "float" }),
    ]);
  });

  it("declares SCREEN_TEXTURE as a runtime-supplied uniform in the prelude", () => {
    expect(out.fragmentGlsl).toContain("uniform sampler2D SCREEN_TEXTURE;");
    // …exactly once: the shader's own hinted declaration must not duplicate it.
    expect(
      out.fragmentGlsl.split("uniform sampler2D SCREEN_TEXTURE;").length,
    ).toBe(2);
    expect(out.fragmentGlsl).toContain(
      "texture(SCREEN_TEXTURE, SCREEN_UV + offset)",
    );
  });

  it("aliases a hint_screen_texture uniform under a non-conventional name", () => {
    const aliased = transpileGodotShader(`
shader_type canvas_item;
uniform sampler2D screen_tex : hint_screen_texture;
void fragment() { COLOR = texture(screen_tex, SCREEN_UV); }
`);
    expect(aliased.usesScreenTexture).toBe(true);
    expect(aliased.samplers).toEqual([]);
    expect(aliased.fragmentGlsl).toContain("uniform sampler2D SCREEN_TEXTURE;");
    expect(aliased.fragmentGlsl).toContain("#define screen_tex SCREEN_TEXTURE");
  });

  it("declares SCREEN_PIXEL_SIZE when read", () => {
    const px = transpileGodotShader(
      "shader_type canvas_item;\nvoid fragment(){ COLOR.rg = SCREEN_PIXEL_SIZE; }",
    );
    expect(px.usesScreenPixelSize).toBe(true);
    expect(px.usesScreenTexture).toBe(false);
    expect(px.fragmentGlsl).toContain("uniform vec2 SCREEN_PIXEL_SIZE;");
  });
});

describe("transpileGodotShader — unsupported constructs throw", () => {
  it("rejects a non-canvas_item shader", () => {
    expect(() =>
      transpileGodotShader("shader_type spatial;\nvoid fragment(){}"),
    ).toThrow(UnsupportedShaderError);
  });
  it("allows SCREEN_UV on its own (reconstructed from the node rect)", () => {
    expect(() =>
      transpileGodotShader(
        "shader_type canvas_item;\nvoid fragment(){ COLOR.rgb = vec3(SCREEN_UV.x); }",
      ),
    ).not.toThrow();
  });
  it("allows bounded for loops but still rejects while loops", () => {
    expect(() =>
      transpileGodotShader(
        "shader_type canvas_item;\nvoid fragment(){ for(int i=0;i<3;i++){} }",
      ),
    ).not.toThrow();
    expect(() =>
      transpileGodotShader(
        "shader_type canvas_item;\nvoid fragment(){ int i = 0; while(i < 3){ i++; } }",
      ),
    ).toThrow(UnsupportedShaderError);
  });
});

describe("promoteIntLiterals", () => {
  it("promotes bare ints, leaves floats and identifiers", () => {
    expect(promoteIntLiterals("smoothstep(0, ease, x)")).toBe(
      "smoothstep(0.0, ease, x)",
    );
    expect(promoteIntLiterals("vec3(0,0,0)")).toBe("vec3(0.0,0.0,0.0)");
    expect(promoteIntLiterals("mat3 m; pow(uv.x, 3)")).toBe(
      "mat3 m; pow(uv.x, 3.0)",
    );
    expect(promoteIntLiterals("6.283185 + .5 + 1.0")).toBe(
      "6.283185 + .5 + 1.0",
    );
  });
});

// A GODOT TEXT RESOURCE, not a `.gdshader` — the shape a VisualShader is saved as, and the
// shape a caller that does `fetch(path).text()` hands us without knowing the difference.
//
// SYNTHETIC, and small on purpose: the container structure is the whole subject, so a
// two-line shader of our own inside a minimal `[gd_resource]` wrapper tests exactly what a
// 500-line generated body would and can be read in one glance. The escapes are Godot's
// (`\n` between lines, `\"` inside strings), because unescaping them is half the job.
const TRES_WRAPPER = [
  '[gd_resource type="VisualShader" load_steps=2 format=3 uid="uid://synthetic"]',
  "",
  '[sub_resource type="VisualShaderNodeFloatParameter" id="Param_test"]',
  'parameter_name = "tint"',
  "default_value_enabled = true",
  "default_value = 0.5",
  "",
  "[resource]",
  'code = "shader_type canvas_item;\\nuniform float tint;\\nvoid fragment() {\\n\\tCOLOR.rgb *= tint;\\n}\\n"',
  "graph_offset = Vector2(0, 0)",
  "",
].join("\n");

describe("a Godot resource container", () => {
  it("transpiles the shader INSIDE it, rather than the container around it", () => {
    const out = transpileGodotShader(TRES_WRAPPER);
    // The uniform survived the unwrap…
    expect(out.uniforms.map((u) => u.name)).toEqual(["tint"]);
    // …and — the actual bug — not one line of the container reached the emitted GLSL.
    // Before this, the subtractive `helpers` residual carried the whole `.tres` in, so the
    // driver hit `[gd_resource …` as the first line after the declarations.
    expect(out.fragmentGlsl).not.toContain("[gd_resource");
    expect(out.fragmentGlsl).not.toContain("[sub_resource");
    expect(out.fragmentGlsl).not.toContain("[resource]");
    expect(out.fragmentGlsl).toContain("uniform float tint;");
  });

  it("is detected CONSERVATIVELY — a plain shader mentioning the word is untouched", () => {
    const plain =
      "shader_type canvas_item;\n// see [gd_resource] for the wrapper\nvoid fragment() { COLOR.a = 1.0; }";
    expect(() => transpileGodotShader(plain)).not.toThrow();
  });

  it("REFUSES a container with no code property, rather than emitting it", () => {
    const empty =
      '[gd_resource type="VisualShader" format=3]\n\n[resource]\ngraph_offset = Vector2(0, 0)\n';
    expect(() => transpileGodotShader(empty)).toThrow(UnsupportedShaderError);
  });

  it("REFUSES a container whose code property is empty", () => {
    const blank =
      '[gd_resource type="VisualShader" format=3]\n\n[resource]\ncode = ""\n';
    expect(() => transpileGodotShader(blank)).toThrow(UnsupportedShaderError);
  });

  it("still refuses if a container reaches the parser some other way — the invariant behind the unwrap", () => {
    // The unwrap is keyed on a leading `[gd_resource`. This is the same container with that
    // header removed, i.e. a shape the detector deliberately does not claim: the parser then
    // finds shader_type/uniform/fragment inside the escaped string exactly as before, and
    // the residual is the container. It must come back as a NAMED refusal — a caller keeps
    // its CSS fallback — and never as an uncompilable shader.
    const headerless = TRES_WRAPPER.split("\n").slice(2).join("\n");
    expect(() => transpileGodotShader(headerless)).toThrow(
      UnsupportedShaderError,
    );
  });

  it("does not mistake GLSL array syntax for a container", () => {
    // The invariant is keyed on the section headers, not on a bare `[` — which is legal
    // GLSL and appears in any helper that indexes an array.
    const arrays = [
      "shader_type canvas_item;",
      "const float WEIGHTS[3] = float[3](0.25, 0.5, 0.25);",
      "float weigh(int i) { return WEIGHTS[i]; }",
      "void fragment() { COLOR.a *= weigh(1); }",
    ].join("\n");
    expect(() => transpileGodotShader(arrays)).not.toThrow();
  });
});
