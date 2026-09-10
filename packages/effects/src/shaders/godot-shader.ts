// Godot Shading Language (`canvas_item` fragment subset) -> WebGL2 GLSL ES 3.00.
//
// This is NOT a full shading-language compiler. Godot's language is GLSL with
// renamed built-ins and looser numeric typing, so most of a `fragment()` body is
// already valid GLSL once we (a) declare the built-ins it reads as same-named
// uniforms/locals, (b) pre-initialize `COLOR = texture(TEXTURE, UV)` and apply the
// `MODULATE` auto-multiply rule, and (c) promote bare integer literals to float
// (GLSL ES is strict where Godot implicitly converts, e.g. `smoothstep(0, ease,…)`).
//
// Constructs outside the supported subset (while loops, unsigned integer locals,
// extra samplers, vertex-position built-ins, non-canvas_item shaders) throw
// `UnsupportedShaderError`, which a renderer reports as a typed unsupported effect.
// A strict single-canvas caller changes renderer mode for the whole stage rather than
// mixing a per-node DOM fallback into an otherwise GPU-owned frame.
// SCREEN_TEXTURE/SCREEN_PIXEL_SIZE transpile, but a renderer must explicitly provide
// a painter-ordered accumulated target before executing them.

export class UnsupportedShaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedShaderError";
  }
}

export type GodotBlendMode = "mix" | "add" | "sub" | "mul" | "premul_alpha";

export interface ShaderUniform {
  /** Uniform name exactly as declared (matches `shader_parameter/<name>`). */
  name: string;
  /** GLSL type: float | int | bool | vec2 | vec3 | vec4 | mat2..4. */
  type: string;
  /** Array length for uniforms declared as `foo[N]`, if any. */
  arrayLength?: number;
  /** Parsed default from `= <literal>` (number, or component array), if any. */
  default?: number | number[];
}

export interface ShaderSampler {
  /** Sampler uniform name (matches `shader_parameter/<name>`). */
  name: string;
  /** `: repeat_enable` hint -> the runtime sets wrap REPEAT (else CLAMP). */
  repeat: boolean;
}

export interface ShaderVarying {
  /** GLSL type as declared (`vec4`, `float`, …) — Godot's spelling, not an emitter's. */
  type: string;
  name: string;
}

export interface TranspiledShader {
  vertexGlsl: string;
  fragmentGlsl: string;
  /** User scalar/vector uniforms (built-ins + samplers excluded), in order. */
  uniforms: ShaderUniform[];
  /** User `sampler2D` uniforms; the runtime binds a texture per entry. */
  samplers: ShaderSampler[];
  blend: GodotBlendMode;
  /** The shader reads `TIME` -> the runtime must drive it from a clock (rAF). */
  usesTime: boolean;
  /** The shader reads `TEXTURE_PIXEL_SIZE` -> runtime supplies 1/textureSize. */
  usesTexturePixelSize: boolean;
  /** The shader reads `SCREEN_UV` -> runtime supplies the node's viewport rect. */
  usesScreenUv: boolean;
  /** The shader samples `SCREEN_TEXTURE` (the built-in token, or a declared
   *  `hint_screen_texture` sampler) -> the runtime must supply a screen capture.
   *  Only renderable when the runtime opts in (`enableScreenTextureCapture`). */
  usesScreenTexture: boolean;
  /** The shader reads `SCREEN_PIXEL_SIZE` -> runtime supplies 1/captureSize. */
  usesScreenPixelSize: boolean;
}

export async function expandGodotShaderIncludes(
  source: string,
  resolveInclude: (
    path: string,
  ) => Promise<string | undefined> | string | undefined,
  seen: Set<string> = new Set(),
  depth = 0,
): Promise<string> {
  if (depth > 16) {
    throw new UnsupportedShaderError("shader include depth exceeded");
  }
  const includePattern = /^[ \t]*#include\s+"([^"]+)"[ \t]*$/gm;
  const chunks: string[] = [];
  let lastIndex = 0;
  for (const match of source.matchAll(includePattern)) {
    const index = match.index ?? 0;
    chunks.push(source.slice(lastIndex, index));
    const includePath = match[1];
    if (seen.has(includePath)) {
      chunks.push(`\n/* skipped recursive include ${includePath} */\n`);
    } else {
      const included = await resolveInclude(includePath);
      if (included === undefined) {
        chunks.push(match[0]);
      } else {
        const nextSeen = new Set(seen);
        nextSeen.add(includePath);
        chunks.push(
          await expandGodotShaderIncludes(
            included,
            resolveInclude,
            nextSeen,
            depth + 1,
          ),
        );
      }
    }
    lastIndex = index + match[0].length;
  }
  chunks.push(source.slice(lastIndex));
  return chunks.join("");
}

// Built-ins we deliberately don't support yet (screen reads, vertex position,
// point sprites, …). Presence of any of these -> UnsupportedShaderError.
const UNSUPPORTED_BUILTINS = [
  "FRAGCOORD",
  "NORMAL",
  "NORMAL_TEXTURE",
  "POINT_COORD",
  "VERTEX",
  "INSTANCE_ID",
  "INSTANCE_CUSTOM",
  "SPECULAR_SHININESS",
  "LIGHT",
  "LIGHT_COLOR",
  "AT_LIGHT_PASS",
  "CUSTOM0",
  "CUSTOM1",
];

const GLSL_SAMPLER_TYPES = new Set(["sampler2D"]);
const SCALAR_OR_VECTOR =
  /^(float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4|ivec2|ivec3|ivec4|bvec2|bvec3|bvec4)$/;

/** The parsing front-end's output: Godot text in, emitter-neutral pieces out. Shared
 *  by the GLSL emitter below and by any sibling emitter (the WGSL one) — parsing a
 *  `.gdshader` twice, once per target language, is how the two would drift apart. */
export interface ParsedShader {
  blend: GodotBlendMode;
  uniforms: ShaderUniform[];
  samplers: ShaderSampler[];
  /** Names of `hint_screen_texture` sampler uniforms (conventionally
   *  `SCREEN_TEXTURE`). Excluded from `samplers` — they bind the runtime's
   *  screen capture, not a user texture. */
  screenTextureNames: string[];
  varyings: ShaderVarying[];
  vertexBody: string | null;
  fragmentBody: string;
  /** Top-level helper functions and consts (everything left after the directives,
   *  uniforms, varyings, `vertex()` and `fragment()` are removed), verbatim. */
  helpers: string;
  /** Identifiers statically declared `int` (uniforms + locals). Bare integer
   *  literals compared against these must NOT be promoted to float. */
  intIdentifiers: Set<string>;
}

/** One vertex-computed varying, hoisted into the fragment as a local because our
 *  fullscreen quad makes it constant. Emitter-neutral: `type`/`name` are Godot's
 *  spelling and `expr` is the vertex RHS with the vertex `COLOR` (the node's combined
 *  modulate·self_modulate) already substituted by `MODULATE`. Each emitter formats
 *  its own declaration syntax around these three fields. */
export interface ShaderVaryingHoist {
  type: string;
  name: string;
  expr: string;
}

/** Everything an emitter must know about a `ParsedShader` beyond its text: which
 *  runtime-supplied built-ins to declare, how the node MODULATE has to be applied,
 *  whether COLOR seeds opaque, and the varyings to hoist. Derived once by
 *  `analyzeShader` so the GLSL and WGSL emitters cannot drift on the MODULATE /
 *  opaque-fill rules, which encode measured Godot behavior rather than a preference. */
export interface ShaderAnalysis {
  /** The concatenated scan region the flags were derived from (helpers + vertex +
   *  fragment). Hand this to `rejectUnsupported` — it must see the same text. */
  logic: string;
  /** Reads `TIME` -> the runtime must drive it from a clock (rAF). */
  usesTime: boolean;
  /** Reads `TEXTURE_PIXEL_SIZE` -> runtime supplies 1/textureSize. */
  usesTexturePixelSize: boolean;
  /** Reads `SCREEN_UV` -> runtime supplies the node's viewport rect. */
  usesScreenUv: boolean;
  /** Samples `SCREEN_TEXTURE` (built-in token or a `hint_screen_texture` sampler). */
  usesScreenTexture: boolean;
  /** Reads `SCREEN_PIXEL_SIZE` -> runtime supplies 1/captureSize. */
  usesScreenPixelSize: boolean;
  /** Reads `PI` -> the emitter must define the constant (Godot has it built in). */
  usesPi: boolean;
  /** A MODULATE uniform must be declared: the body names it, the engine multiply is
   *  synthesized, or a hoisted varying was seeded from it. */
  needsModulate: boolean;
  /** Append the engine's `COLOR *= MODULATE` (see `analyzeShader` for when not to). */
  autoModulate: boolean;
  /** Seed `COLOR.a = 1` instead of the sampled texture alpha (pure-fill shaders). */
  opaqueColor: boolean;
  varyingHoists: ShaderVaryingHoist[];
}

/** Transpile a `.gdshader` source string. Throws `UnsupportedShaderError`. */
export function transpileGodotShader(source: string): TranspiledShader {
  // A `.tres` VisualShader carries its source in an escaped `code` property; unwrap BEFORE
  // stripping comments, which would otherwise eat `//` inside the container's strings.
  const cleaned = sanitizeReservedIdentifiers(
    stripComments(unwrapShaderResource(source)),
  );
  const parsed = parseShader(cleaned);

  // The fragment body + helpers + vertex passthrough, scanned together for
  // built-in usage and unsupported constructs. Guarding BEFORE analyzing keeps an
  // unsupported built-in reported as such, ahead of any varying-hoist complaint.
  const logic = shaderLogic(parsed);
  rejectUnsupported(logic, parsed);

  const analysis = analyzeShader(parsed);
  // Vertex-computed varyings are hoisted as locals in main(); `analyzeShader` already
  // substituted the vertex `COLOR` with MODULATE, so only the GLSL syntax is left.
  const varyingLocals = analysis.varyingHoists.map(
    (v) => `${v.type} ${v.name} = ${v.expr};`,
  );

  const fragmentGlsl = assembleFragment({ parsed, analysis, varyingLocals });

  return {
    vertexGlsl: VERTEX_GLSL,
    fragmentGlsl,
    uniforms: parsed.uniforms,
    samplers: parsed.samplers,
    blend: parsed.blend,
    usesTime: analysis.usesTime,
    usesTexturePixelSize: analysis.usesTexturePixelSize,
    usesScreenUv: analysis.usesScreenUv,
    usesScreenTexture: analysis.usesScreenTexture,
    usesScreenPixelSize: analysis.usesScreenPixelSize,
  };
}

// The fullscreen-quad vertex shader is fixed: a_pos covers clip space [-1,1]; v_uv
// is the raw quad UV. The fragment prelude converts it to Godot's top-left UV.
const VERTEX_GLSL = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

function assembleFragment(input: {
  parsed: ParsedShader;
  analysis: ShaderAnalysis;
  varyingLocals: string[];
}): string {
  const { parsed, analysis } = input;
  const decls: string[] = [
    "uniform sampler2D TEXTURE;",
    // Runtime-supplied UV fit (contain/cover/fill) mirroring TextureRect stretch.
    "uniform vec2 _godot_uv_fit;",
    // Runtime-supplied UV window (origin.xy + size.zw, node-local top-left fractions). Lets the runtime render
    // only a SUB-RECT of the node into a smaller canvas (e.g. clamping an off-screen-overflowing full-screen
    // background to the visible viewport) while the shader still samples the correct portion. Default (0,0,1,1)
    // ⇒ full node, identical to before.
    "uniform vec4 _godot_uv_window;",
    ...(analysis.usesTime ? ["uniform float TIME;"] : []),
    ...(analysis.usesTexturePixelSize
      ? ["uniform vec2 TEXTURE_PIXEL_SIZE;"]
      : []),
    ...(analysis.needsModulate ? ["uniform vec4 MODULATE;"] : []),
    // SCREEN_UV is the node's slice of the viewport: origin + the node-local UV
    // scaled by the node's normalized on-screen size (both runtime-supplied).
    ...(analysis.usesScreenUv
      ? [
          "uniform vec2 _godot_screen_origin;",
          "uniform vec2 _godot_screen_size;",
        ]
      : []),
    // SCREEN_TEXTURE is a runtime-captured composite of the content drawn before the
    // node, in VIEWPORT coordinates (the whole scene-root rect) — so the body's
    // `texture(SCREEN_TEXTURE, SCREEN_UV …)` samples it directly, no body rewriting.
    // A `hint_screen_texture` sampler under a non-conventional name aliases it.
    ...(analysis.usesScreenTexture
      ? [
          "uniform sampler2D SCREEN_TEXTURE;",
          ...parsed.screenTextureNames
            .filter((name) => name !== "SCREEN_TEXTURE")
            .map((name) => `#define ${name} SCREEN_TEXTURE`),
        ]
      : []),
    ...(analysis.usesScreenPixelSize
      ? ["uniform vec2 SCREEN_PIXEL_SIZE;"]
      : []),
    ...(analysis.usesPi ? ["const float PI = 3.141592653589793;"] : []),
  ];
  for (const u of parsed.uniforms) {
    decls.push(
      `uniform ${u.type} ${u.name}${u.arrayLength ? `[${u.arrayLength}]` : ""};`,
    );
  }
  for (const s of parsed.samplers) {
    decls.push(`uniform sampler2D ${s.name};`);
  }
  const helpers = promoteIntLiterals(
    parsed.helpers,
    parsed.intIdentifiers,
  ).trim();
  const body = promoteIntLiterals(parsed.fragmentBody, parsed.intIdentifiers);
  return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
${decls.join("\n")}
${helpers ? `${helpers}\n` : ""}
void main() {
  vec2 GODOT_UV = _godot_uv_window.xy + vec2(v_uv.x, 1.0 - v_uv.y) * _godot_uv_window.zw;
  vec2 UV = (GODOT_UV - 0.5) / _godot_uv_fit + 0.5;
${
  analysis.usesScreenUv
    ? "  vec2 SCREEN_UV = _godot_screen_origin + GODOT_UV * _godot_screen_size;\n"
    : ""
}  vec4 COLOR = ${analysis.opaqueColor ? "vec4(texture(TEXTURE, UV).rgb, 1.0)" : "texture(TEXTURE, UV)"};
${input.varyingLocals.map((l) => `  ${l}`).join("\n")}
${indent(body)}
${analysis.autoModulate ? "  COLOR *= MODULATE;" : ""}
  // PREMULTIPLIED. The shared canvas declares \`premultipliedAlpha: true\` (webgl/shared-gl.ts), so
  // this is THE canvas contract: return rgb*a with a. The shader backend draws with BLEND OFF, so
  // whatever this writes IS the buffer — returning straight COLOR here halos every partially
  // transparent node, and neither the compiler nor a readback of the canvas would say so.
  // Character-for-character the WGSL emitter's return (webgpu/transpile-wgsl.ts), on purpose: one
  // contract, two languages.
  fragColor = vec4(COLOR.rgb * COLOR.a, COLOR.a);
}
`;
}

// ---- analysis --------------------------------------------------------------

/** The text every built-in flag is scanned over. The vertex body and the top-level
 *  helpers count, not just `fragment()`: a helper may read TIME/PI, and a varying
 *  computed in `vertex()` is hoisted into the fragment. `rejectUnsupported` must be
 *  given this same region, or a guard would scan less text than the flags did. */
export function shaderLogic(parsed: ParsedShader): string {
  return `${parsed.helpers}\n${parsed.vertexBody ?? ""}\n${parsed.fragmentBody}`;
}

/** Derive the emitter-neutral facts about a parsed shader (see `ShaderAnalysis`).
 *  Pure, and deliberately NOT a validator: run `rejectUnsupported(analysis.logic,
 *  parsed)` for that, before analyzing, so an unsupported built-in outranks a
 *  varying-hoist complaint. Throws `UnsupportedShaderError` only for a `vertex()`
 *  body that cannot be reduced to constant varying assignments. */
export function analyzeShader(parsed: ParsedShader): ShaderAnalysis {
  const logic = shaderLogic(parsed);

  const usesTime = hasToken(logic, "TIME");
  const usesTexturePixelSize = hasToken(logic, "TEXTURE_PIXEL_SIZE");
  const usesScreenUv = hasToken(logic, "SCREEN_UV");
  // Either the built-in token or any declared `hint_screen_texture` sampler (Godot 4
  // spells the built-in as such a uniform; the conventional name is SCREEN_TEXTURE).
  const usesScreenTexture =
    hasToken(logic, "SCREEN_TEXTURE") ||
    parsed.screenTextureNames.some((name) => hasToken(logic, name));
  const usesScreenPixelSize = hasToken(logic, "SCREEN_PIXEL_SIZE");
  const usesPi = hasToken(logic, "PI");
  const usesModulateBuiltin = hasToken(parsed.fragmentBody, "MODULATE");
  // Godot bakes the node modulate into COLOR's INITIAL value (`texture·MODULATE`)
  // and never re-applies it after `fragment()`. We model that as a trailing
  // `COLOR *= MODULATE` — but ONLY when the shader leaves the modulate in COLOR.
  // It must be skipped when the shader:
  //   - handles modulate itself (the MODULATE built-in, or reads the vertex
  //     `COLOR` = the combined modulate·self_modulate in `vertex()`), or
  //   - fully OVERWRITES `COLOR.rgb` (or the whole `COLOR`) with a plain `=`,
  //     which DISCARDS the modulate (e.g. `COLOR.rgb = gradient`; the fill is the
  //     gradient ALONE, not gradient·self_modulate). Re-multiplying would wrongly
  //     darken it. A `COLOR.a =` / `COLOR.rgb +=` keeps the modulate in rgb, so
  //     those are NOT matched.
  const vertexReadsModulate =
    parsed.vertexBody !== null && hasToken(parsed.vertexBody, "COLOR");
  const overwritesColorRgb = /\bCOLOR(\.rgb)?\s*=(?!=)/.test(
    parsed.fragmentBody,
  );
  // Whether the fragment READS COLOR (the sampled `texture·MODULATE`) rather than only
  // assigning to it. Strip the plain `COLOR(.rgba) =` assignment targets; any COLOR
  // token that survives is a read. A shader that reads COLOR is a texture EFFECT — a
  // conditional recolor / tint that samples the sprite (e.g. `if (distance(COLOR.rgb,
  // key) < t) COLOR.rgb = repl;`) — so its `COLOR.rgb =` is a PARTIAL edit, not a fill.
  // Its texture rgb, its alpha (the sprite's SHAPE), and the node modulate must all be
  // kept, exactly as for a plain texture shader.
  const bodyReadsColor = hasToken(
    parsed.fragmentBody.replace(/\bCOLOR(?:\.[rgba]+)?\s*=(?!=)/g, ""),
    "COLOR",
  );
  // A PURE FILL overwrites COLOR.rgb WITHOUT ever reading it (`COLOR.rgb = gradient`):
  // the texture rgb is discarded, so the modulate is dropped (a trailing multiply would
  // darken the fill) and the node paints opaque (see below). A recolor that reads COLOR
  // is NOT a pure fill, so neither rule applies to it.
  const pureFillOverwrite = overwritesColorRgb && !bodyReadsColor;
  const autoModulate =
    !usesModulateBuiltin && !vertexReadsModulate && !pureFillOverwrite;

  // OPAQUE init: when a shader is a PURE FILL (overwrites COLOR.rgb without reading it)
  // and never touches COLOR.a nor samples the node TEXTURE, the texture is only an
  // incidental alpha carrier — its soft nine-patch-cap alpha would otherwise feather
  // the node's edges. We seed COLOR.a = 1 so the node paints as a crisp solid (e.g. a
  // clean gradient-filled bar segment whose rounded shape comes from the parent clip
  // Mask, not a stretched texture cap that lets the layer behind leak through at the
  // edge). A recolor that READS COLOR keeps the texture alpha — forcing it opaque would
  // paint the sprite's transparent surround as a solid rectangle. Shaders that
  // read/write COLOR.a or sample TEXTURE also keep the texture alpha.
  const usesColorAlpha = /\bCOLOR\.a\b/.test(parsed.fragmentBody);
  const samplesNodeTexture = hasToken(parsed.fragmentBody, "TEXTURE");
  const opaqueColor =
    pureFillOverwrite && !usesColorAlpha && !samplesNodeTexture;

  // Vertex-computed varyings are constant across our fullscreen quad, so they become
  // locals seeded from the MODULATE uniform — which is itself a reason to declare it.
  const varyingHoists = buildVaryingHoists(parsed);

  return {
    logic,
    usesTime,
    usesTexturePixelSize,
    usesScreenUv,
    usesScreenTexture,
    usesScreenPixelSize,
    usesPi,
    needsModulate:
      usesModulateBuiltin || autoModulate || varyingHoists.length > 0,
    autoModulate,
    opaqueColor,
    varyingHoists,
  };
}

function buildVaryingHoists(parsed: ParsedShader): ShaderVaryingHoist[] {
  if (parsed.vertexBody === null || parsed.varyings.length === 0) {
    return [];
  }
  const typeByName = new Map(parsed.varyings.map((v) => [v.name, v.type]));
  const hoists: ShaderVaryingHoist[] = [];
  // Only support a vertex body that is a sequence of `<varying> = <expr>;`
  // assignments whose expr references the vertex COLOR (modulate) / uniforms.
  const statements = parsed.vertexBody
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    const eq = statement.indexOf("=");
    if (eq < 0) {
      throw new UnsupportedShaderError(
        `vertex(): only constant varying assignments are supported, got "${statement}"`,
      );
    }
    const lhs = statement.slice(0, eq).trim();
    const rhs = statement.slice(eq + 1).trim();
    const type = typeByName.get(lhs);
    if (!type) {
      throw new UnsupportedShaderError(
        `vertex(): assignment to non-varying "${lhs}" is not supported`,
      );
    }
    // The vertex COLOR is the node's combined modulate·self_modulate -> MODULATE.
    const expr = replaceToken(promoteIntLiterals(rhs), "COLOR", "MODULATE");
    hoists.push({ type, name: lhs, expr });
  }
  return hoists;
}

// ---- parsing ---------------------------------------------------------------

/** Parse cleaned Godot source (run `stripComments` + `sanitizeReservedIdentifiers`
 *  first) into the emitter-neutral `ParsedShader`. Throws `UnsupportedShaderError`. */
export function parseShader(src: string): ParsedShader {
  const shaderType = /shader_type\s+([a-z_]+)\s*;/.exec(src);
  if (!shaderType) {
    throw new UnsupportedShaderError("missing shader_type declaration");
  }
  if (shaderType[1] !== "canvas_item") {
    throw new UnsupportedShaderError(
      `unsupported shader_type "${shaderType[1]}" (only canvas_item)`,
    );
  }

  const blend = parseBlendMode(src);
  const { uniforms, samplers, screenTextureNames } = parseUniforms(src);
  const varyings = parseVaryings(src);

  const fragment = extractFunction(src, "fragment");
  if (fragment === null) {
    throw new UnsupportedShaderError("missing fragment() function");
  }
  const vertex = extractFunction(src, "vertex");

  // Whatever remains after removing the directives / uniforms / varyings /
  // vertex / fragment is top-level helper functions and consts.
  let helpers = src
    .replace(/shader_type\s+[a-z_]+\s*;/g, "")
    .replace(/render_mode[^;]*;/g, "")
    .replace(/uniform[^;]*;/g, "")
    .replace(/varying[^;]*;/g, "");
  helpers = removeFunction(helpers, "fragment");
  helpers = removeFunction(helpers, "vertex");

  // THE RESIDUAL IS EMITTED VERBATIM, so it has to be shader source and not "whatever was
  // left over". `helpers` is computed by SUBTRACTION — everything the parser recognised,
  // removed — which is exactly the shape that turns an unrecognised input into a silent
  // pass-through: hand this a Godot `.tres` and the leftovers are the container itself,
  // emitted into the GLSL between the declarations and `main()`.
  //
  // `unwrapShaderResource` is the fix and this is the INVARIANT behind it: even if some
  // future container shape slips past that check, it stops here as a named refusal (the
  // caller keeps its CSS/SVG fallback) rather than as an uncompilable shader. Keyed on the
  // SECTION headers rather than on a bare `[`, which is legal GLSL array syntax.
  const stray = RESOURCE_SECTION_RE.exec(helpers);
  if (stray) {
    throw new UnsupportedShaderError(
      `source is a Godot resource container, not shader code (found "${stray[0]}")`,
    );
  }

  return {
    blend,
    uniforms,
    samplers,
    screenTextureNames,
    varyings,
    vertexBody: vertex,
    fragmentBody: fragment,
    helpers: helpers.trim(),
    intIdentifiers: parseIntIdentifiers(src, uniforms),
  };
}

function parseBlendMode(src: string): GodotBlendMode {
  const match = /render_mode\s+([^;]+);/.exec(src);
  if (!match) {
    return "mix";
  }
  const modes = match[1].split(",").map((m) => m.trim());
  for (const mode of modes) {
    if (mode === "blend_add") return "add";
    if (mode === "blend_sub") return "sub";
    if (mode === "blend_mul") return "mul";
    if (mode === "blend_premul_alpha") return "premul_alpha";
    if (mode === "blend_mix") return "mix";
    // Non-blend render_modes (unshaded, etc.) are ignored for canvas_item.
  }
  return "mix";
}

function parseUniforms(src: string): {
  uniforms: ShaderUniform[];
  samplers: ShaderSampler[];
  screenTextureNames: string[];
} {
  const uniforms: ShaderUniform[] = [];
  const samplers: ShaderSampler[] = [];
  const screenTextureNames: string[] = [];
  const re = /uniform\s+([a-zA-Z0-9_]+)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*([^;]*);/g;
  for (const match of src.matchAll(re)) {
    const type = match[1];
    const name = match[2];
    const rest = match[3].trim(); // array length, hints, and/or `= default`
    const arrayLength = parseArrayLength(rest, src);
    if (GLSL_SAMPLER_TYPES.has(type)) {
      // A `hint_screen_texture` sampler is Godot 4's SCREEN_TEXTURE built-in, not a
      // user texture: it must NOT land in `samplers` (the runtime would try to resolve
      // it as a shader_parameter URL) — the runtime binds its screen capture instead.
      if (/\bhint_screen_texture\b/.test(rest)) {
        screenTextureNames.push(name);
        continue;
      }
      // Each user `sampler2D` is bound to its own texture unit by the runtime;
      // its image source (a procedural NoiseTexture2D/GradientTexture1D etc.) is
      // baked from the material's `shader_parameter/<name>`. Honor the
      // `repeat_enable` hint so scrolling samples wrap instead of clamping.
      samplers.push({ name, repeat: /\brepeat_enable\b/.test(rest) });
      continue;
    }
    if (!SCALAR_OR_VECTOR.test(type)) {
      throw new UnsupportedShaderError(`unsupported uniform type "${type}"`);
    }
    uniforms.push({
      type,
      name,
      ...(arrayLength ? { arrayLength } : {}),
      default: parseUniformDefault(rest),
    });
  }
  return { uniforms, samplers, screenTextureNames };
}

function parseArrayLength(rest: string, src: string): number | undefined {
  const match = /^\[\s*([^\]]+)\s*\]/.exec(rest);
  if (!match) {
    return undefined;
  }
  const constants = parseConstInts(src);
  const expr = match[1].replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) =>
    constants.has(name) ? String(constants.get(name)) : "NaN",
  );
  if (!/^[0-9+\-*/ ().NaN]+$/.test(expr)) {
    return undefined;
  }
  try {
    const value = Function(`"use strict"; return (${expr});`)();
    return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  } catch {
    return undefined;
  }
}

function parseConstInts(src: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /\bconst\s+int\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+)\s*;/g;
  for (const match of src.matchAll(re)) {
    out.set(match[1], Number.parseInt(match[2], 10));
  }
  return out;
}

function parseIntIdentifiers(
  src: string,
  uniforms: ShaderUniform[],
): Set<string> {
  const out = new Set(
    uniforms.filter((u) => u.type === "int").map((u) => u.name),
  );
  const re = /\b(?:const\s+)?int\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of src.matchAll(re)) {
    out.add(match[1]);
  }
  return out;
}

function parseUniformDefault(rest: string): number | number[] | undefined {
  const eq = rest.indexOf("=");
  if (eq < 0) {
    return undefined;
  }
  const value = rest.slice(eq + 1).trim();
  const ctor = /^[a-z0-9]*vec[234]\s*\(([^)]*)\)$/.exec(value);
  if (ctor) {
    return ctor[1].split(",").map((c) => scalarLiteral(c.trim()) ?? Number.NaN);
  }
  return scalarLiteral(value);
}

// A numeric OR boolean literal as a number (`true` -> 1, `false` -> 0): a
// `uniform bool ... = true;` default must survive as 1, else the runtime's
// `raw ?? default` fallback uploads 0 and silently flips the toggle.
function scalarLiteral(value: string): number | undefined {
  if (value === "true") {
    return 1;
  }
  if (value === "false") {
    return 0;
  }
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : undefined;
}

function parseVaryings(src: string): ShaderVarying[] {
  const out: ShaderVarying[] = [];
  const re = /varying\s+([a-zA-Z0-9_]+)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/g;
  for (const match of src.matchAll(re)) {
    out.push({ type: match[1], name: match[2] });
  }
  return out;
}

// ---- guards ----------------------------------------------------------------

/** Throw `UnsupportedShaderError` for constructs no emitter supports. Give it
 *  `shaderLogic(parsed)` — the same region the analysis flags are scanned over. */
export function rejectUnsupported(logic: string, parsed: ParsedShader): void {
  for (const builtin of UNSUPPORTED_BUILTINS) {
    if (hasToken(logic, builtin)) {
      throw new UnsupportedShaderError(`unsupported built-in "${builtin}"`);
    }
  }
  // Global int-literal promotion is only safe when there are no genuine integer
  // contexts: reject int/uint locals, loops, and array indexing/declarations.
  if (/\bwhile\b/.test(logic)) {
    throw new UnsupportedShaderError("while loops are not supported");
  }
  if (/\b(uint|uvec[234])\b/.test(logic)) {
    throw new UnsupportedShaderError(
      "unsigned integer variables are not supported",
    );
  }
  // Reject unknown ALL-CAPS built-in-looking tokens that aren't supported and
  // aren't a known mixed-case user identifier (defensive; GLSL compile is the
  // ultimate backstop).
  void parsed;
}

// ---- Godot resource containers ---------------------------------------------
//
// A Godot shader does not always arrive as a `.gdshader`. A VisualShader — the node
// graph editor's output — is saved as a `.tres` TEXT RESOURCE: an INI-ish container of
// `[gd_resource]` / `[sub_resource]` sections, with the generated shader source stored
// as an escaped string in the `[resource]` section's `code` property. A caller that
// fetches a shader by path and hands back `response.text()` therefore hands us the
// CONTAINER, and it is not this module's caller's job to know the difference — Godot
// itself loads either and gets a shader.
//
// UNWRAPPED HERE, ahead of `stripComments`, because comment-stripping a container would
// eat `//` sequences inside its quoted strings. And CONSERVATIVELY: only a source whose
// first non-whitespace is a `[gd_resource` header is treated as one, so a `.gdshader`
// that merely mentions the word in a comment is untouched.

/** The escapes Godot writes into a `.tres` string literal. */
function unescapeResourceString(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_all, esc: string) => {
    if (esc[0] === "u") {
      return String.fromCharCode(Number.parseInt(esc.slice(1), 16));
    }
    switch (esc) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        // `\"` and `\\`, and anything else Godot ever adds: the escaped char itself.
        return esc;
    }
  });
}

/**
 * The shader source inside a Godot text-resource container, or `source` unchanged.
 *
 * Throws {@link UnsupportedShaderError} for a container with no usable `code` property —
 * NEVER returns the container. That refusal is the whole point: before it existed, every
 * parse step happened to succeed against a `.tres` (the `shader_type`, the `uniform`
 * declarations and the `fragment()` body all match INSIDE the escaped `code` string), and
 * then the subtractive `helpers` residual in `parseShader` carried the entire container
 * into the emitted GLSL — declarations, then `[gd_resource type="VisualShader" …` as the
 * first line of what should have been shader code. The driver reported a syntax error at
 * a `[`, which is a long way from "this file is not a shader".
 */
export function unwrapShaderResource(source: string): string {
  if (!/^\s*\[gd_resource\b/.test(source)) {
    return source;
  }
  // Godot writes resource properties at column 0, so the anchor is exact rather than a
  // guess: `code = "…"` with the usual backslash escapes.
  const match = /^code\s*=\s*"((?:[^"\\]|\\[\s\S])*)"/m.exec(source);
  if (!match) {
    throw new UnsupportedShaderError(
      "Godot resource container has no `code` property (not a shader resource)",
    );
  }
  const code = unescapeResourceString(match[1]).trim();
  if (code === "") {
    throw new UnsupportedShaderError(
      "Godot resource container has an empty `code` property",
    );
  }
  return code;
}

/** Sections that can only come from a resource container — never legal shader source. */
const RESOURCE_SECTION_RE =
  /\[(?:gd_resource|sub_resource|ext_resource|resource)\b/;

// ---- text utilities --------------------------------------------------------

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

// `input` is reserved in GLSL ES but a legal Godot identifier (the affliction erosion
// include declares `float input`) — rename it once, here in the source text, so every
// emitter downstream parses and emits a safe name rather than each re-discovering it.
export function sanitizeReservedIdentifiers(src: string): string {
  return replaceToken(src, "input", "inputValue");
}

// Extract the brace-matched body of `void <name>() { ... }` (inner text only),
// or null if absent.
export function extractFunction(src: string, name: string): string | null {
  const head = new RegExp(`void\\s+${name}\\s*\\(\\s*\\)\\s*\\{`).exec(src);
  if (!head) {
    return null;
  }
  const open = head.index + head[0].length - 1; // index of `{`
  const end = matchBrace(src, open);
  return src.slice(open + 1, end);
}

function removeFunction(src: string, name: string): string {
  const head = new RegExp(`void\\s+${name}\\s*\\(\\s*\\)\\s*\\{`).exec(src);
  if (!head) {
    return src;
  }
  const open = head.index + head[0].length - 1;
  const end = matchBrace(src, open);
  return src.slice(0, head.index) + src.slice(end + 1);
}

/** Index of the `}` closing the `{` at `openIndex`. Brace depth only — enough for the
 *  supported subset, which has no braces inside strings (Godot shaders have none). */
export function matchBrace(src: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new UnsupportedShaderError("unbalanced braces");
}

// Promote bare integer literals to float (`0` -> `0.0`), skipping anything that
// is part of an identifier (`vec3`, `mat3`) or already a float (`6.28`, `.5`).
export function promoteIntLiterals(
  src: string,
  intIdentifiers: Iterable<string> = [],
): string {
  const ranges = skipRanges(src);
  const intNames = [...intIdentifiers];
  return src.replace(/(?<![\w.])(\d+)(?![\w.])/g, (match, _digits, offset) => {
    if (ranges.some(([start, end]) => offset >= start && offset < end)) {
      return match;
    }
    if (
      intNames.length > 0 &&
      isIntegerComparisonLiteral(src, offset, intNames)
    ) {
      return match;
    }
    return `${match}.0`;
  });
}

function skipRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const re of [
    /\[[^\]]*\]/g,
    /\bfor\s*\([^)]*\)/g,
    /\b(?:const\s+)?int\s+[^;]+;/g,
  ]) {
    for (const match of src.matchAll(re)) {
      const index = match.index ?? 0;
      ranges.push([index, index + match[0].length]);
    }
  }
  return ranges;
}

function isIntegerComparisonLiteral(
  src: string,
  offset: number,
  tokens: string[],
): boolean {
  let start = offset;
  while (start > 0 && !";{}\n".includes(src[start - 1])) start -= 1;
  let end = offset;
  while (end < src.length && !";{}\n".includes(src[end])) end += 1;
  const statement = src.slice(start, end);
  const localOffset = offset - start;
  const before = statement.slice(0, localOffset);
  const after = statement.slice(
    localOffset + String(src.slice(offset).match(/^\d+/)?.[0] ?? "").length,
  );
  const comparison = "(?:==|!=|<=|>=|<|>)";
  return tokens.some((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      new RegExp(`\\b${escaped}\\b\\s*${comparison}\\s*$`).test(before) ||
      new RegExp(`^\\s*${comparison}\\s*\\b${escaped}\\b`).test(after)
    );
  });
}

/** Whole-identifier match: `TIME` must not fire on `LIFETIME`, `COLOR` not on
 *  `COLOR_KEY`. Every built-in probe in this file goes through it. */
export function hasToken(src: string, token: string): boolean {
  return new RegExp(`(?<![\\w])${escapeRegExp(token)}(?![\\w])`).test(src);
}

/** Whole-identifier replace, same boundary rule as `hasToken`. */
export function replaceToken(
  src: string,
  token: string,
  replacement: string,
): string {
  return src.replace(
    new RegExp(`(?<![\\w])${escapeRegExp(token)}(?![\\w])`, "g"),
    replacement,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `  ${line.trim()}` : ""))
    .join("\n");
}
