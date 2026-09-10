// The real game-shader corpus, as data — the input to the WGSL compile-validation block in
// `test/webgpuParityBrowser.test.ts`.
//
// WHAT THIS IS FOR. `packages/html/test/webgpu-transpile-wgsl.test.ts` proves the emitter ACCEPTS
// each of these and that individual translation rules fired. It cannot prove the result is valid
// WGSL: that is a question only a WGSL front-end can answer, and the interesting cases are exactly
// the ones no regex reaches — scry_reveal's `fwidth` called inside a uniform-bounded loop has to
// pass WGSL's uniformity analysis, which is a whole-program dataflow property. So these sources are
// transpiled in node and the resulting modules are compiled in a real browser.
//
// WHY THE SOURCES ARE COPIED. They are module-private `const`s in `packages/html/test/
// webgpu-transpile-wgsl.test.ts`, which itself copied them verbatim from `test/webgl-transpile.
// test.ts` for the reason its header gives: "Copying rather than exporting keeps each suite readable
// on its own." Importing that file here is not an option anyway — the consts are not exported, and a
// value import would execute its `describe`s inside this suite. Nothing is load-bearing about the
// three copies staying byte-identical: what this suite needs is a set of REAL game shaders, and
// what the html suite owns is the emitter's contract for them.
//
// NODE + BROWSER SAFE: strings and nothing else. No imports, no DOM, no `fs`.

/** One corpus entry. `needsIncludes` marks a source carrying `#include` directives that must be
 *  expanded (with `CORPUS_INCLUDES`) before it can be transpiled. */
export interface CorpusShader {
  name: string;
  source: string;
  needsIncludes?: boolean;
}

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

/** The three `.gdshaderinc` bodies the affliction shaders `#include`. */
export const CORPUS_INCLUDES: Record<string, string> = {
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

/**
 * Every corpus shader the WGSL tier supports, i.e. every one that must reach a GPU.
 *
 * The SCREEN_TEXTURE members of the corpus are deliberately absent: the emitter REFUSES them
 * (`UnsupportedWgslShaderError` → the runtime's per-binding WebGL fallback), so there is no module
 * to compile. That contract is not skipped, it is checked where it is visible — the
 * `shader-screen-texture-fallback` parity fixture renders one and proves the binding fell back and
 * still painted the WebGL picture exactly.
 */
export const WGSL_CORPUS: CorpusShader[] = [
  { name: "card_ripple", source: CARD_RIPPLE },
  { name: "hsv", source: HSV },
  { name: "power", source: POWER },
  { name: "doom_bar", source: DOOM_BAR },
  { name: "normal_map_point", source: NORMAL_MAP_POINT },
  { name: "scry_reveal", source: SCRY_REVEAL },
  { name: "stepped-bool", source: STEPPED_BOOL },
  {
    name: "affliction_galvanized",
    source: AFFLICTION_GALVANIZED,
    needsIncludes: true,
  },
  {
    name: "affliction_bound",
    source: AFFLICTION_BOUND_MAIN,
    needsIncludes: true,
  },
  {
    name: "affliction_entangled",
    source: AFFLICTION_ENTANGLED_MAIN,
  },
];
