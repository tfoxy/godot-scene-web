import {
  ITEM_SHADER_PRELUDE_NAMES,
  stripIncludeMarkers,
  transpileGodotItemShader,
  transpileGodotShader,
  UnsupportedShaderError,
} from "@godot-scene-web/effects/shaders";
import { describe, expect, it } from "vitest";

// What a Godot 4.5.1 RenderingServer receives for a `.gdshader` (the scene layer's preprocessor:
// every run of spaces/tabs is one space, an `#include` becomes `@@>path`, the include's output and
// `@@<path`). The synthetic shaders are a render-stream fixture's (gate 5.5 and 6); they are
// written out here so this package test needs nothing outside the package.
const server = (text: string) => text.replace(/[ \t]+/g, " ");

const TINT = server(`shader_type canvas_item;

@@>res://inc/common.gdshaderinc
vec4 grid(vec4 c) {
	return vec4(c.rgb, 1.0);
}

@@<res://inc/common.gdshaderinc

uniform vec4 tint = vec4(1.0);
uniform float gain = 1.0;

void fragment() {
	COLOR = grid(tint * gain);
}
`);

const PHASE = server(`shader_type canvas_item;

uniform int phase;

void fragment() {
	int p = phase % 6;
	COLOR = vec4(float(p) * 0.2, float(5 - p) * 0.2, 0.4, 1.0);
}
`);

const PHASE_TINT = server(`shader_type canvas_item;

uniform int phase;
uniform vec4 tint;

void fragment() {
	COLOR = vec4(tint.rgb * (float(phase % 6) * 0.2), 1.0);
}
`);

const TYPES = server(`shader_type canvas_item;

uniform bool on;
uniform int k;
uniform float f;
uniform vec2 v2;
uniform vec3 v3;
uniform ivec2 iv;
uniform float lv[4];

void fragment() {
	COLOR = on ? vec4(v2.x, v3.y, lv[k], 1.0) : vec4(f, float(iv.y) * 0.2, 0.0, 1.0);
}
`);

const INST = server(`shader_type canvas_item;

instance uniform vec4 inst_color = vec4(1.0);

void fragment() {
	COLOR = vec4(inst_color.rgb, 1.0);
}
`);

const PAL = server(`shader_type canvas_item;

uniform sampler2D pal : filter_nearest;
uniform vec4 mul = vec4(1.0);

void fragment() {
	COLOR = texture(pal, UV) * mul;
}
`);

const BURN = server(`shader_type canvas_item;

uniform int iterations;

void fragment() {
	float acc = 0.0;
	vec2 p = UV;
	for (int i = 0; i < iterations; i++) {
		acc += fract(sin(dot(p, vec2(12.9898, 78.233)) + float(i)) * 43758.5453);
		p += vec2(0.001 * acc, 0.0);
	}
	COLOR = vec4(0.0, 0.0, 0.0, step(1e9, acc));
}
`);

const SH_A = server(`shader_type canvas_item;

void fragment() {
	COLOR = vec4(0.2, 0.8, 0.4, 1.0);
}
`);

describe("transpileGodotItemShader (item-space module)", () => {
  it("strips the preprocessor's include markers and keeps the included code", () => {
    expect(stripIncludeMarkers(TINT)).not.toContain("@@");
    const t = transpileGodotItemShader(TINT);
    expect(t.glsl).not.toContain("@@");
    expect(t.glsl).toContain("vec4 grid(vec4 c)");
    expect(t.glsl).toContain(
      `void ${ITEM_SHADER_PRELUDE_NAMES.entry}(inout vec4 COLOR, in vec2 UV) {`,
    );
    expect(t.glsl).toContain("COLOR = grid(tint * gain);");
    expect(t.uniforms).toEqual([
      {
        name: "tint",
        type: "vec4",
        instance: false,
        components: 4,
        integer: false,
        unset: [1, 1, 1, 1],
      },
      {
        name: "gain",
        type: "float",
        instance: false,
        components: 1,
        integer: false,
        unset: [1],
      },
    ]);
    expect(t.blend).toBe("mix");
    expect(t.lightMode).toBe("normal");
  });

  it("does not seed COLOR, multiply a modulate or own main()", () => {
    const t = transpileGodotItemShader(SH_A);
    expect(t.glsl).not.toMatch(/\bmain\s*\(/);
    expect(t.glsl).not.toContain("MODULATE");
    expect(t.glsl).not.toContain("texture(TEXTURE");
    expect(t.glsl).toContain("COLOR = vec4(0.2, 0.8, 0.4, 1.0);");
  });

  it("keeps int literals int where Godot does (int arithmetic) and floats elsewhere", () => {
    const phase = transpileGodotItemShader(PHASE).glsl;
    expect(phase).toContain("int p = phase % 6;");
    expect(phase).toContain("float(5 - p) * 0.2");
    const pt = transpileGodotItemShader(PHASE_TINT).glsl;
    expect(pt).toContain("float(phase % 6) * 0.2");
    const types = transpileGodotItemShader(TYPES);
    expect(types.glsl).toContain("lv[k]");
    expect(types.glsl).toContain("float(iv.y) * 0.2");
    expect(types.uniforms.map((u) => [u.name, u.type, u.unset])).toEqual([
      ["on", "bool", [0]],
      ["k", "int", [0]],
      ["f", "float", [0]],
      ["v2", "vec2", [0, 0]],
      ["v3", "vec3", [0, 0, 0]],
      ["iv", "ivec2", [0, 0]],
      ["lv", "float", [0, 0, 0, 0]],
    ]);
    expect(types.uniforms.find((u) => u.name === "lv")?.arrayLength).toBe(4);
    const burn = transpileGodotItemShader(BURN).glsl;
    expect(burn).toContain("for (int i = 0; i < iterations; i++)");
    expect(burn).toContain("step(1e9, acc)");
  });

  it("declares instance uniforms like any other, flagged instance", () => {
    const t = transpileGodotItemShader(INST);
    expect(t.glsl).toContain("uniform vec4 inst_color;");
    expect(t.glsl).not.toContain("instance");
    expect(t.uniforms[0]).toMatchObject({
      name: "inst_color",
      instance: true,
      unset: [1, 1, 1, 1],
    });
  });

  it("honours sampler filter and repeat hints", () => {
    const t = transpileGodotItemShader(PAL);
    expect(t.samplers).toEqual([
      { name: "pal", filter: "nearest", repeat: null, default: "white" },
    ]);
    expect(t.glsl).toContain("uniform sampler2D pal;");
    const r = transpileGodotItemShader(
      "shader_type canvas_item;\nuniform sampler2D n : filter_linear, repeat_enable;\nvoid fragment() { COLOR = texture(n, UV); }\n",
    );
    expect(r.samplers).toEqual([
      { name: "n", filter: "linear", repeat: true, default: "white" },
    ]);
  });

  it("reads render modes", () => {
    const t = transpileGodotItemShader(
      "shader_type canvas_item;\nrender_mode blend_sub, unshaded;\nvoid fragment() { COLOR.rgb *= 0.5; }\n",
    );
    expect(t.blend).toBe("sub");
    expect(t.lightMode).toBe("unshaded");
  });

  it("drops light(), which runs only per light", () => {
    const t = transpileGodotItemShader(
      "shader_type canvas_item;\nvoid fragment() { COLOR.a = 1.0; }\nvoid light() { LIGHT = vec4(1.0); }\n",
    );
    expect(t.glsl).not.toContain("LIGHT");
  });

  it("reads the screen through one SCREEN_TEXTURE and gl_FragCoord-based SCREEN_UV", () => {
    const t = transpileGodotItemShader(
      "shader_type canvas_item;\nuniform float lod = 5.0;\nuniform sampler2D screen_tex : hint_screen_texture, filter_linear_mipmap;\nvoid fragment() { COLOR = texture(screen_tex, SCREEN_UV, lod); }",
    );
    expect(t.screenTexture).toEqual({ names: ["screen_tex"], mipmaps: true });
    expect(t.screenPixelSize).toBe(true);
    expect(t.samplers).toEqual([]);
    expect(t.glsl).toContain("uniform sampler2D SCREEN_TEXTURE;");
    expect(t.glsl).toContain("#define screen_tex SCREEN_TEXTURE");
    expect(t.glsl).toContain("uniform vec2 SCREEN_PIXEL_SIZE;");
    expect(t.glsl).toContain(
      "#define SCREEN_UV (gl_FragCoord.xy * SCREEN_PIXEL_SIZE)",
    );
    // Named SCREEN_TEXTURE itself, nearest (GLES3 ignores the filter, so no mipmaps): no alias.
    const n = transpileGodotItemShader(
      "shader_type canvas_item;\nuniform sampler2D SCREEN_TEXTURE : hint_screen_texture, filter_nearest;\nvoid fragment() { COLOR = texture(SCREEN_TEXTURE, SCREEN_UV); }",
    );
    expect(n.screenTexture).toEqual({
      names: ["SCREEN_TEXTURE"],
      mipmaps: false,
    });
    expect(n.glsl).not.toContain("#define SCREEN_TEXTURE");
    // A mipmap filter on a screen sampler the code never reads asks for no mip chain.
    const unused = transpileGodotItemShader(
      "shader_type canvas_item;\nuniform sampler2D s : hint_screen_texture, filter_linear_mipmap;\nvoid fragment() { COLOR = vec4(SCREEN_PIXEL_SIZE, 0.0, 1.0); }",
    );
    expect(unused.screenTexture).toEqual({ names: ["s"], mipmaps: false });
    expect(unused.glsl).not.toContain("#define SCREEN_UV");
    const plain = transpileGodotItemShader(
      "shader_type canvas_item;\nvoid fragment() { COLOR.a = 1.0; }",
    );
    expect(plain.screenTexture).toBeNull();
    expect(plain.screenPixelSize).toBe(false);
  });

  it("refuses what an item draw cannot execute exactly, naming it", () => {
    const refused: [string, RegExp][] = [
      [
        "shader_type canvas_item;\nuniform sampler2D screen_tex : hint_screen_texture, hint_default_black;\nvoid fragment() { COLOR = texture(screen_tex, SCREEN_UV); }",
        /hint_default_black/,
      ],
      [
        "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(0.4, 0.2, 0.8 - 0.0 * step(0.0, texture_sdf(vec2(0.0))), 1.0); }",
        /texture_sdf/,
      ],
      [
        "shader_type canvas_item;\nglobal uniform vec4 g_tint;\nvoid fragment() { COLOR = vec4(g_tint.rgb, 1.0); }",
        /global uniform/,
      ],
      [
        "shader_type spatial;\nvoid fragment() { ALBEDO = vec3(1.0, 0.0, 0.0); }",
        /shader_type/,
      ],
      [
        "shader_type canvas_item;\nvoid fragment() { COLOR.rg = VERTEX; }",
        /VERTEX/,
      ],
      [
        "shader_type canvas_item;\nvoid fragment() { COLOR.a = POINT_SIZE; }",
        /POINT_SIZE/,
      ],
      [
        "shader_type canvas_item;\nuniform sampler2D n : hint_roughness_r;\nvoid fragment() { COLOR = texture(n, UV); }",
        /hint_roughness_r/,
      ],
      [
        "shader_type canvas_item;\nuniform float f = 0.5 * 2.0;\nvoid fragment() { COLOR.a = f; }",
        /not a literal/,
      ],
      [
        "shader_type canvas_item;\nrender_mode blend_mix, skip_everything;\nvoid fragment() {}",
        /render_mode/,
      ],
      [
        "shader_type canvas_item;\nuniform mat2 m;\nvoid fragment() { COLOR.rg = m * COLOR.rg; }",
        /matrix uniforms/,
      ],
    ];
    for (const [src, why] of refused) {
      expect(() => transpileGodotItemShader(src)).toThrow(
        UnsupportedShaderError,
      );
      expect(() => transpileGodotItemShader(src)).toThrow(why);
    }
  });
});

// P3-VX: vertex() and varyings. The STS2 settings gear's shape (COLOR copied into a varying that
// the fragment multiplies back in), written out synthetically.
const HSV_GEAR = server(`shader_type canvas_item;
uniform float v = 1;
varying vec4 modulate_color;
void vertex() {
	modulate_color = COLOR;
}
void fragment() {
	vec4 col = texture(TEXTURE, UV);
	col.rgb = mix(vec3(0,0,0), col.rgb, v);
	COLOR = col;
	COLOR *= modulate_color;
}
`);

const DISPLACE = server(`shader_type canvas_item;
const float SHEAR = 0.25;
uniform vec2 offset = vec2(4.0, 0.0);
uniform sampler2D lut : filter_nearest;
varying flat int corner;
varying smooth highp vec2 local;
varying float weights[2];
vec2 shear(vec2 p) { return vec2(p.x + p.y * SHEAR, p.y); }
vec2 helper_outer(vec2 p) { return shear(p) + offset; }
float frag_only(vec2 p) { return fwidth(p.x); }
void vertex() {
	VERTEX = helper_outer(VERTEX) + vec2(1.0 / TEXTURE_PIXEL_SIZE.x, 0.0) * 0.0;
	UV = UV * 2 - 0.5;
	corner = int(VERTEX.x > 10.0) + 2 * int(VERTEX.y > 10.0) + int(UV.x) % 3;
	local = (MODEL_MATRIX * vec4(VERTEX, 0.0, 1.0)).xy + (CANVAS_MATRIX * SCREEN_MATRIX)[3].xy * 0.0;
	weights[0] = INSTANCE_CUSTOM.x;
	weights[1] = AT_LIGHT_PASS ? 1.0 : 0.0;
	POINT_SIZE = 2.0;
}
void fragment() {
	COLOR = texture(lut, vec2(float(corner) / 4.0, frag_only(local) + weights[0]));
}
`);

describe("transpileGodotItemShader vertex() (P3-VX)", () => {
  it("emits a vertex module beside the fragment module, the varying out there and in here", () => {
    const t = transpileGodotItemShader(HSV_GEAR);
    expect(t.vertexStage).toBe(true);
    expect(t.skipVertexTransform).toBe(false);
    expect(t.worldVertexCoords).toBe(false);
    expect(t.varyings).toEqual([
      {
        name: "modulate_color",
        type: "vec4",
        interpolation: null,
        fromVertex: true,
      },
    ]);
    const v = t.vertexGlsl ?? "";
    expect(v).toContain("uniform float v;");
    expect(v).toContain("out vec4 modulate_color;");
    expect(v).toContain(
      `void ${ITEM_SHADER_PRELUDE_NAMES.vertexEntry}(inout vec2 VERTEX, inout vec2 UV, inout vec4 COLOR, inout float POINT_SIZE, in mat4 MODEL_MATRIX, in mat4 CANVAS_MATRIX, in mat4 SCREEN_MATRIX) {`,
    );
    expect(v).toContain("modulate_color = COLOR;");
    expect(v).not.toContain("texture(TEXTURE");
    expect(t.glsl).toContain("in vec4 modulate_color;");
    expect(t.glsl).toContain("COLOR *= modulate_color;");
    expect(t.glsl).not.toContain("out vec4 modulate_color");
  });

  it("keeps interpolation and precision qualifiers and arrays, and emits only the helpers vertex() reaches", () => {
    const t = transpileGodotItemShader(DISPLACE);
    const v = t.vertexGlsl ?? "";
    expect(v).toContain("flat out int corner;");
    expect(v).toContain("smooth out highp vec2 local;");
    expect(v).toContain("out float weights[2];");
    expect(t.glsl).toContain("flat in int corner;");
    expect(t.glsl).toContain("smooth in highp vec2 local;");
    expect(t.glsl).toContain("in float weights[2];");
    // Transitively reached helpers and every constant, but not the fragment-only helper (fwidth
    // does not compile in a vertex shader).
    expect(v).toContain("vec2 shear(vec2 p)");
    expect(v).toContain("vec2 helper_outer(vec2 p)");
    expect(v).toContain("const float SHEAR = 0.25;");
    expect(v).not.toContain("frag_only");
    expect(t.glsl).toContain("float frag_only(vec2 p)");
    // Samplers are declared in both stages (one GL uniform).
    expect(v).toContain("uniform sampler2D lut;");
    // Built-ins as canvas.glsl has them for a non-instanced draw.
    expect(v).toContain(
      "#define TEXTURE_PIXEL_SIZE (vec2(1.0) / vec2(textureSize(TEXTURE, 0)))",
    );
    expect(v).toContain("#define AT_LIGHT_PASS false");
    expect(v).toContain(
      "#ifdef GSW_INSTANCE_CUSTOM\n#define INSTANCE_CUSTOM GSW_INSTANCE_CUSTOM\n#else\n#define INSTANCE_CUSTOM vec4(0.0)\n#endif",
    );
    // Int literals become float in float arithmetic, as in fragment(), and stay int beside an
    // int constructor call.
    expect(v).toContain("UV = UV * 2.0 - 0.5;");
    expect(v).toContain(
      "corner = int(VERTEX.x > 10.0) + 2 * int(VERTEX.y > 10.0) + int(UV.x) % 3;",
    );
  });

  it("needs a vertex stage for skip_vertex_transform even without vertex(), not for world_vertex_coords", () => {
    const skip = transpileGodotItemShader(
      "shader_type canvas_item;\nrender_mode skip_vertex_transform;\nvoid fragment() {}",
    );
    expect(skip.vertexStage).toBe(true);
    expect(skip.skipVertexTransform).toBe(true);
    expect(skip.vertexGlsl).toContain(
      `#define ${ITEM_SHADER_PRELUDE_NAMES.skipVertexTransform}`,
    );
    const world = transpileGodotItemShader(
      "shader_type canvas_item;\nrender_mode world_vertex_coords;\nvoid fragment() {}",
    );
    expect(world.vertexStage).toBe(false);
    expect(world.vertexGlsl).toBeNull();
    expect(world.worldVertexCoords).toBe(true);
    const worldVertex = transpileGodotItemShader(
      "shader_type canvas_item;\nrender_mode world_vertex_coords;\nvoid vertex() { VERTEX.x += 1.0; }",
    );
    expect(worldVertex.vertexGlsl).toContain(
      `#define ${ITEM_SHADER_PRELUDE_NAMES.worldVertexCoords}`,
    );
  });

  it("admits a shader without fragment() and keeps a plain one on the plain vertex stage", () => {
    const t = transpileGodotItemShader(
      "shader_type canvas_item;\nvoid vertex() { UV *= 0.5; }",
    );
    expect(t.vertexStage).toBe(true);
    expect(t.glsl).toContain(
      `void ${ITEM_SHADER_PRELUDE_NAMES.entry}(inout vec4 COLOR, in vec2 UV) {\n\n}`,
    );
    const plain = transpileGodotItemShader(TINT);
    expect(plain.vertexStage).toBe(false);
    expect(plain.vertexGlsl).toBeNull();
    expect(plain.varyings).toEqual([]);
  });

  it("renames a varying that would collide with the renderer's own stage names", () => {
    const t = transpileGodotItemShader(
      "shader_type canvas_item;\nvarying vec4 v_color;\nvoid vertex() { v_color = COLOR; }\nvoid fragment() { COLOR = v_color; }",
    );
    expect(t.varyings[0].name).toBe("gsw_vary_v_color");
    expect(t.vertexGlsl).toContain("out vec4 gsw_vary_v_color;");
    expect(t.vertexGlsl).toContain("gsw_vary_v_color = COLOR;");
    expect(t.glsl).toContain("COLOR = gsw_vary_v_color;");
  });

  it("declares a varying vertex() never writes as a fragment global", () => {
    const t = transpileGodotItemShader(
      "shader_type canvas_item;\nvarying vec4 tint;\nvoid fragment() { tint = vec4(0.5); COLOR *= tint; }",
    );
    expect(t.vertexStage).toBe(false);
    expect(t.varyings[0].fromVertex).toBe(false);
    expect(t.glsl).toMatch(/^vec4 tint;$/m);
  });

  it("admits TIME in either stage as a renderer-set uniform (P3-TM)", () => {
    const frag = transpileGodotItemShader(
      "shader_type canvas_item;\nvoid fragment() { COLOR.rgb *= 0.5 + 0.5 * sin(TIME * 2.0); }",
    );
    expect(frag.time).toBe(true);
    expect(frag.glsl).toContain("uniform float TIME;");
    expect(frag.vertexGlsl).toBeNull();
    const helper = transpileGodotItemShader(
      "shader_type canvas_item;\nfloat h() { return TIME; }\nvoid vertex() { VERTEX.x += h(); }\nvoid fragment() { COLOR.a = 1.0; }",
    );
    expect(helper.time).toBe(true);
    expect(helper.vertexGlsl).toContain("uniform float TIME;");
    // The fragment module carries every helper, so it declares TIME too.
    expect(helper.glsl).toContain("uniform float TIME;");
    const plain = transpileGodotItemShader(
      "shader_type canvas_item;\nvoid fragment() { COLOR.a = 1.0; }",
    );
    expect(plain.time).toBe(false);
    expect(plain.glsl).not.toContain("TIME");
  });

  it("names GLES3's unset-sampler default per hint (P3-TM)", () => {
    const t = transpileGodotItemShader(
      [
        "shader_type canvas_item;",
        "uniform sampler2D w;",
        "uniform sampler2D w2 : hint_default_white, filter_nearest;",
        "uniform sampler2D b : hint_default_black;",
        "uniform sampler2D t : hint_default_transparent, repeat_enable;",
        "uniform sampler2D n : hint_normal;",
        "uniform sampler2D rn : hint_roughness_normal;",
        "uniform sampler2D a : hint_anisotropy;",
        "void fragment() { COLOR = texture(w, UV) * texture(w2, UV) + texture(b, UV) + texture(t, UV) + texture(n, UV) + texture(rn, UV) + texture(a, UV); }",
      ].join("\n"),
    );
    expect(t.samplers.map((s) => [s.name, s.default])).toEqual([
      ["w", "white"],
      ["w2", "white"],
      ["b", "black"],
      ["t", "transparent"],
      ["n", "normal"],
      ["rn", "normal"],
      ["a", "anisotropy"],
    ]);
  });

  it("admits TEXTURE_PIXEL_SIZE and AT_LIGHT_PASS in fragment()", () => {
    const t = transpileGodotItemShader(
      "shader_type canvas_item;\nvoid fragment() { if (!AT_LIGHT_PASS) COLOR = texture(TEXTURE, UV + TEXTURE_PIXEL_SIZE); }",
    );
    expect(t.glsl).toContain("#define TEXTURE_PIXEL_SIZE");
    expect(t.glsl).toContain("#define AT_LIGHT_PASS false");
  });

  it("refuses what vertex() cannot execute exactly, naming it", () => {
    const refused: [string, RegExp][] = [
      ["void vertex() { VERTEX.x += float(VERTEX_ID); }", /VERTEX_ID/],
      ["void vertex() { VERTEX.x += float(INSTANCE_ID); }", /INSTANCE_ID/],
      ["void vertex() { COLOR = CUSTOM0; }", /CUSTOM0/],
      ["void vertex() { COLOR = texture(TEXTURE, UV); }", /TEXTURE/],
      [
        "uniform sampler2D s : hint_screen_texture;\nvoid vertex() { COLOR = textureLod(s, UV, 0.0); }\nvoid fragment() { COLOR = texture(s, SCREEN_UV); }",
        /screen texture "s"/,
      ],
      ["varying mat2 m;\nvoid vertex() { m = mat2(1.0); }", /type mat2/],
      ["varying vec2 a, b;\nvoid vertex() { a = UV; }", /one name/],
      [
        "varying uvec2 u;\nvoid vertex() { u = uvec2(1); }",
        /unsigned and boolean-vector/,
      ],
    ];
    for (const [body, why] of refused) {
      const src = `shader_type canvas_item;\n${body}`;
      expect(() => transpileGodotItemShader(src)).toThrow(
        UnsupportedShaderError,
      );
      expect(() => transpileGodotItemShader(src)).toThrow(why);
    }
  });
});

describe("shared parser additions", () => {
  it("the fullscreen emitter refuses instance and global uniforms instead of emitting junk", () => {
    expect(() => transpileGodotShader(INST)).toThrow(/instance uniform/);
    expect(() =>
      transpileGodotShader(
        "shader_type canvas_item;\nglobal uniform vec4 g;\nvoid fragment() { COLOR = g; }",
      ),
    ).toThrow(/global uniform/);
  });

  it("the fullscreen emitter's output for an existing shader is unchanged by the hint parse", () => {
    const t = transpileGodotShader(PAL);
    expect(t.samplers).toEqual([{ name: "pal", repeat: false }]);
    expect(t.fragmentGlsl).toContain("uniform sampler2D pal;");
  });
});
