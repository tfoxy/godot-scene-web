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
      { name: "pal", filter: "nearest", repeat: null },
    ]);
    expect(t.glsl).toContain("uniform sampler2D pal;");
    const r = transpileGodotItemShader(
      "shader_type canvas_item;\nuniform sampler2D n : filter_linear, repeat_enable;\nvoid fragment() { COLOR = texture(n, UV); }\n",
    );
    expect(r.samplers).toEqual([{ name: "n", filter: "linear", repeat: true }]);
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
        "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(0.2, 0.4, 0.6 - 0.0 * step(0.0, TIME), 1.0); }",
        /TIME/,
      ],
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
        "shader_type canvas_item;\nvoid vertex() { VERTEX += vec2(1.0); }\nvoid fragment() {}",
        /vertex\(\)/,
      ],
      [
        "shader_type canvas_item;\nvoid fragment() { COLOR = texture(TEXTURE, UV + TEXTURE_PIXEL_SIZE); }",
        /TEXTURE_PIXEL_SIZE/,
      ],
      [
        "shader_type canvas_item;\nuniform sampler2D n : hint_default_black;\nvoid fragment() { COLOR = texture(n, UV); }",
        /hint_default_black/,
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
