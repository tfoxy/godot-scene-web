import {
  analyzeShader,
  type ParsedShader,
  parseShader,
  shaderLogic,
  transpileGodotShader,
  UnsupportedShaderError,
} from "@godot-scene-web/effects/shaders";
import { describe, expect, it } from "vitest";
import {
  extractFunction,
  hasToken,
  matchBrace,
  rejectUnsupported,
  replaceToken,
  sanitizeReservedIdentifiers,
  stripComments,
} from "../src/shaders/godot-shader";

// `analyzeShader` is the transpiler front-end's shared seam: the GLSL emitter and the
// WGSL one both consume it, so the MODULATE / opaque-fill rules — which encode measured
// Godot behavior, not preference — are asserted HERE, once, against the parsed facts
// rather than against one emitter's text. `webgl-transpile.test.ts` remains the
// byte-identical guard on the GLSL that comes out the other side.
//
// The corpus shaders in that file are module-private, so these are small stand-ins cut
// to the shape each rule turns on (not copies of the game shaders).

function analyze(source: string) {
  return analyzeShader(parse(source));
}

function parse(source: string): ParsedShader {
  return parseShader(sanitizeReservedIdentifiers(stripComments(source)));
}

// card_ripple's shape: edits COLOR.a only, names neither MODULATE nor a varying.
const ALPHA_EDIT = `
shader_type canvas_item;
render_mode blend_add;
uniform float ease;
void fragment() {
	float sdf = mod(TIME, 1.0);
	COLOR.a = smoothstep(0.0, ease, sdf);
}
`;

// hsv's shape: vertex() carries the node modulate into a varying.
const VERTEX_VARYING = `
shader_type canvas_item;
uniform float h = 1.0;
varying vec4 modulate_color;
void vertex() {
    modulate_color = COLOR;
}
void fragment() {
    vec4 col = texture(TEXTURE, UV);
    col.rgb *= h;
    COLOR = col;
    COLOR *= modulate_color;
}
`;

// doom_bar's shape: a PURE FILL — overwrites COLOR.rgb without ever reading COLOR.
const PURE_FILL = `
shader_type canvas_item;
uniform sampler2D gradient_tex;
void fragment() {
    float v = smoothstep(0.4, 0.6, SCREEN_UV.x + TIME * 0.001);
    COLOR.rgb = texture(gradient_tex, vec2(v, 0.0)).rgb;
}
`;

// normal_map_point's shape: a recolor that READS COLOR before conditionally writing it.
const RECOLOR = `
shader_type canvas_item;
uniform vec3 map_color : source_color;
void fragment() {
    if (distance(COLOR.rgb, vec3(1.0)) < 0.5) {
        COLOR.rgb = map_color;
    }
}
`;

describe("analyzeShader — MODULATE rules", () => {
  it("auto-multiplies when the shader leaves the node modulate in COLOR", () => {
    const a = analyze(ALPHA_EDIT);
    // Godot bakes modulate into COLOR's initial value; editing only alpha keeps it in
    // rgb, so the emitter must append the engine's trailing multiply.
    expect(a.autoModulate).toBe(true);
    expect(a.needsModulate).toBe(true);
  });

  it("does NOT auto-multiply when vertex() already carried the modulate into a varying", () => {
    const a = analyze(VERTEX_VARYING);
    // The shader applies it itself (`COLOR *= modulate_color`) — a second multiply
    // would square the modulate and darken the node.
    expect(a.autoModulate).toBe(false);
    // …but MODULATE is still declared: the hoisted varying is seeded from it.
    expect(a.needsModulate).toBe(true);
  });

  it("does NOT auto-multiply a pure fill (the overwrite discarded the modulate)", () => {
    const a = analyze(PURE_FILL);
    // `COLOR.rgb = gradient` is the gradient ALONE, not gradient·self_modulate.
    expect(a.autoModulate).toBe(false);
    // Nothing references MODULATE at all, so the uniform is not declared either.
    expect(a.needsModulate).toBe(false);
  });

  it("auto-multiplies a recolor: reading COLOR makes the write a partial edit, not a fill", () => {
    const a = analyze(RECOLOR);
    expect(a.autoModulate).toBe(true);
    expect(a.needsModulate).toBe(true);
  });

  it("does NOT auto-multiply when the body names the MODULATE built-in itself", () => {
    const a = analyze(
      "shader_type canvas_item;\nvoid fragment(){ COLOR = texture(TEXTURE, UV) * MODULATE * 0.5; }",
    );
    expect(a.autoModulate).toBe(false);
    expect(a.needsModulate).toBe(true);
  });
});

describe("analyzeShader — opaque COLOR seeding", () => {
  it("seeds opaque for a pure fill that never touches COLOR.a nor samples TEXTURE", () => {
    // The texture is then only an incidental alpha carrier; keeping its soft cap alpha
    // would feather the node's edges instead of painting a crisp solid.
    expect(analyze(PURE_FILL).opaqueColor).toBe(true);
  });

  it("keeps the texture alpha for a recolor (its alpha IS the sprite's shape)", () => {
    // Forcing opaque here painted the sprite's transparent surround as a solid
    // rectangle — the "white rectangle" map-node/relic-icon bug.
    expect(analyze(RECOLOR).opaqueColor).toBe(false);
  });

  it("keeps the texture alpha when the shader writes COLOR.a", () => {
    expect(analyze(ALPHA_EDIT).opaqueColor).toBe(false);
  });

  it("keeps the texture alpha when a fill still samples the node TEXTURE", () => {
    const a = analyze(
      "shader_type canvas_item;\nvoid fragment(){ COLOR = texture(TEXTURE, UV) * MODULATE * 0.5; }",
    );
    expect(a.opaqueColor).toBe(false);
  });
});

describe("analyzeShader — built-in flag detection", () => {
  it("detects the runtime-supplied built-ins a shader reads", () => {
    const a = analyze(`
shader_type canvas_item;
uniform sampler2D screen_tex : hint_screen_texture;
void fragment() {
    vec2 px = TEXTURE_PIXEL_SIZE + SCREEN_PIXEL_SIZE;
    COLOR = texture(screen_tex, SCREEN_UV + px * PI);
}
`);
    expect({
      usesTime: a.usesTime,
      usesTexturePixelSize: a.usesTexturePixelSize,
      usesScreenUv: a.usesScreenUv,
      usesScreenPixelSize: a.usesScreenPixelSize,
      usesPi: a.usesPi,
      // A `hint_screen_texture` sampler IS the SCREEN_TEXTURE built-in under a
      // non-conventional name — the flag must fire on the alias, not just the token.
      usesScreenTexture: a.usesScreenTexture,
    }).toEqual({
      usesTime: false,
      usesTexturePixelSize: true,
      usesScreenUv: true,
      usesScreenPixelSize: true,
      usesPi: true,
      usesScreenTexture: true,
    });
  });

  it("scans helpers and vertex(), not just the fragment body", () => {
    // A helper may be the only place TIME/PI appear; missing that would leave the
    // uniform undeclared and the program failing to compile.
    const a = analyze(`
shader_type canvas_item;
float wave(float x) { return sin(x * PI + TIME); }
void fragment() { COLOR.a *= wave(UV.x); }
`);
    expect(a.usesTime).toBe(true);
    expect(a.usesPi).toBe(true);
    expect(a.logic).toContain("float wave(float x)");
  });

  it("reports no flags for a shader that reads nothing runtime-supplied", () => {
    const a = analyze(
      "shader_type canvas_item;\nvoid fragment(){ COLOR.rgb = vec3(0.5); }",
    );
    expect([
      a.usesTime,
      a.usesTexturePixelSize,
      a.usesScreenUv,
      a.usesScreenTexture,
      a.usesScreenPixelSize,
      a.usesPi,
    ]).toEqual([false, false, false, false, false, false]);
  });
});

describe("analyzeShader — varying hoists", () => {
  it("returns the vertex COLOR substituted by MODULATE, emitter-neutral", () => {
    // type/name/expr stay Godot's spelling: each emitter formats its own declaration
    // syntax around them (GLSL `vec4 x = …;`, WGSL `var x: vec4f = …;`).
    expect(analyze(VERTEX_VARYING).varyingHoists).toEqual([
      { type: "vec4", name: "modulate_color", expr: "MODULATE" },
    ]);
  });

  it("is empty when there is no vertex() to hoist from", () => {
    expect(analyze(PURE_FILL).varyingHoists).toEqual([]);
  });

  it("rejects a vertex() body that is not plain constant varying assignments", () => {
    // Our fullscreen quad only makes a varying constant if it is one expression; a
    // branching vertex() would need real per-vertex evaluation.
    expect(() =>
      analyze(`
shader_type canvas_item;
varying vec4 c;
void vertex() { if (true) { c = COLOR; } }
void fragment() { COLOR *= c; }
`),
    ).toThrow(UnsupportedShaderError);
  });
});

describe("analyzeShader — seam contract", () => {
  it("analyzes without validating; rejectUnsupported is the separate guard", () => {
    // Guarding is a separate call so an emitter can order it FIRST and have an
    // unsupported built-in outrank a varying-hoist complaint.
    const parsed = parse(
      "shader_type canvas_item;\nvoid fragment(){ COLOR.rgb = vec3(FRAGCOORD.x); }",
    );
    expect(() => analyzeShader(parsed)).not.toThrow();
    expect(() => rejectUnsupported(shaderLogic(parsed), parsed)).toThrow(
      UnsupportedShaderError,
    );
  });

  it("scans the same region the guard is given", () => {
    const parsed = parse(VERTEX_VARYING);
    expect(analyzeShader(parsed).logic).toBe(shaderLogic(parsed));
  });

  it("is pure: repeated calls on the same parse agree", () => {
    const parsed = parse(RECOLOR);
    expect(analyzeShader(parsed)).toEqual(analyzeShader(parsed));
  });

  it("is what transpileGodotShader reports and formats", () => {
    // Pins the delegation: the shipped GLSL flags ARE the analysis flags, and the
    // emitted varying local is a pure formatting of the structured hoist.
    for (const source of [ALPHA_EDIT, VERTEX_VARYING, PURE_FILL, RECOLOR]) {
      const a = analyze(source);
      const out = transpileGodotShader(source);
      expect({
        usesTime: out.usesTime,
        usesTexturePixelSize: out.usesTexturePixelSize,
        usesScreenUv: out.usesScreenUv,
        usesScreenTexture: out.usesScreenTexture,
        usesScreenPixelSize: out.usesScreenPixelSize,
      }).toEqual({
        usesTime: a.usesTime,
        usesTexturePixelSize: a.usesTexturePixelSize,
        usesScreenUv: a.usesScreenUv,
        usesScreenTexture: a.usesScreenTexture,
        usesScreenPixelSize: a.usesScreenPixelSize,
      });
      for (const hoist of a.varyingHoists) {
        expect(out.fragmentGlsl).toContain(
          `  ${hoist.type} ${hoist.name} = ${hoist.expr};`,
        );
      }
      expect(out.fragmentGlsl.includes("  COLOR *= MODULATE;\n")).toBe(
        a.autoModulate,
      );
      expect(
        out.fragmentGlsl.includes(
          "vec4 COLOR = vec4(texture(TEXTURE, UV).rgb, 1.0);",
        ),
      ).toBe(a.opaqueColor);
      expect(out.fragmentGlsl.includes("uniform vec4 MODULATE;")).toBe(
        a.needsModulate,
      );
    }
  });
});

describe("exported text utilities", () => {
  it("hasToken matches whole identifiers only", () => {
    // The flag scan is token-based precisely so `TEXTURE_PIXEL_SIZE` is not read as a
    // TEXTURE sample and `LIFETIME` is not read as TIME.
    expect(hasToken("a TIME b", "TIME")).toBe(true);
    expect(hasToken("LIFETIME", "TIME")).toBe(false);
    expect(hasToken("TEXTURE_PIXEL_SIZE", "TEXTURE")).toBe(false);
  });

  it("replaceToken respects the same boundary", () => {
    expect(replaceToken("COLOR * COLOR_KEY", "COLOR", "MODULATE")).toBe(
      "MODULATE * COLOR_KEY",
    );
  });

  it("stripComments removes both comment forms", () => {
    expect(stripComments("a // x\nb")).toBe("a \nb");
    expect(stripComments("a /* x */ b")).toBe("a   b");
  });

  it("sanitizeReservedIdentifiers renames the `input` parameter", () => {
    // Legal in Godot (the affliction erosion include uses it), reserved downstream.
    expect(
      sanitizeReservedIdentifiers("float f(float input){ return input; }"),
    ).toBe("float f(float inputValue){ return inputValue; }");
  });

  it("extractFunction returns the brace-matched body, or null", () => {
    const src = "void fragment() { if (a) { b(); } }";
    expect(extractFunction(src, "fragment")).toBe(" if (a) { b(); } ");
    expect(extractFunction(src, "vertex")).toBeNull();
  });

  it("matchBrace finds the matching close through nesting", () => {
    expect(matchBrace("{ { } }", 0)).toBe(6);
    expect(() => matchBrace("{ { }", 0)).toThrow(UnsupportedShaderError);
  });

  it("parseShader keeps Godot's own property spellings", () => {
    const parsed = parse(PURE_FILL);
    expect(parsed.blend).toBe("mix");
    expect(parsed.samplers).toEqual([{ name: "gradient_tex", repeat: false }]);
    expect(parsed.fragmentBody).toContain("COLOR.rgb =");
  });
});
