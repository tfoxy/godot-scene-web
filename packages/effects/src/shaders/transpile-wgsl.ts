// Godot Shading Language (`canvas_item` fragment subset) -> WGSL, for the WebGPU
// effects renderer. Sibling of `webgl/transpile.ts`, NOT a replacement: both emitters
// consume the same front-end (`parseShader` -> `rejectUnsupported` -> `analyzeShader`),
// so the MODULATE / opaque-fill / varying-hoist rules — which encode measured Godot
// behavior rather than a preference — cannot drift between the two backends.
//
// WGSL is not "GLSL with different keywords", so this is a real source-to-source pass
// rather than a rename table. The constructs that actually differ, and are handled here:
//
//   * declarations are `var name: T = e` (and zero-initialize without one),
//   * there is no ternary — `c ? a : b` becomes `select(b, a, c)`,
//   * a MULTI-component swizzle is not an assignable place (`COLOR.rgb = e` is illegal),
//   * `texture(s, uv)` is `textureSampleLevel(s, s_smp, uv, 0.0)` and a sampler is a
//     separate binding from its texture,
//   * `mod` is floor-signed in GLSL and `%` is trunc-signed in WGSL,
//   * `inverse()` does not exist,
//   * uniforms live in ONE host-shareable struct with explicit byte offsets, and a
//     WGSL `bool` is not host-shareable at all.
//
// Everything in this file is strings and plain numbers: no `GPU*` global is referenced
// and nothing is imported from `webgpu/device.ts`, so it is safe to import from a node
// CLI (the perf harness and the parity harness both do) and testable without a device.
//
// Constructs this emitter cannot express but WebGL can (SCREEN_TEXTURE and friends,
// float/vec2 uniform arrays, ternaries outside a whole right-hand side, …) throw
// `UnsupportedWgslShaderError`. The runtime catches THAT subclass at binding-compile
// time and puts the one binding on WebGL — a plain `UnsupportedShaderError` from the
// shared front-end keeps its stronger meaning, "no backend can render this".

import {
  analyzeShader,
  type GodotBlendMode,
  hasToken,
  matchBrace,
  type ParsedShader,
  parseShader,
  rejectUnsupported,
  replaceToken,
  type ShaderAnalysis,
  type ShaderSampler,
  sanitizeReservedIdentifiers,
  shaderLogic,
  stripComments,
  UnsupportedShaderError,
  unwrapShaderResource,
} from "./godot-shader";

/** "WGSL can't, WebGL can." Thrown for shapes the GLSL emitter renders happily; the
 *  runtime answers it with a per-binding WebGL fallback, not with the CSS fallback. */
export class UnsupportedWgslShaderError extends UnsupportedShaderError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedWgslShaderError";
  }
}

/** One member of the single uniform struct, with the byte offset a writer needs. */
export interface WgslUniformField {
  /** Uniform name exactly as Godot declared it (matches `shader_parameter/<name>`).
   *  NOT necessarily the emitted WGSL member name — a Godot name that collides with a
   *  WGSL reserved word or with a built-in member is renamed inside the module only. */
  name: string;
  /** WGSL type of the member (`f32`, `i32`, `vec3f`, `vec2i`, `mat3x3f`, …). */
  type: string;
  /** Godot's own spelling (`float`, `bool`, `vec3`, …). A `bool` uniform is stored as
   *  `f32` (WGSL `bool` is not host-shareable), so a writer needs this to know that an
   *  `f32` member is really a 1/0 flag. */
  godotType: string;
  /** Element count for `foo[N]` uniforms. Elements are 16 bytes apart (WGSL uniform
   *  address space rounds array stride up to 16). */
  arrayLength?: number;
  offsetBytes: number;
  sizeBytes: number;
  default?: number | number[];
}

/** Byte offsets of the runtime-supplied built-ins inside the SAME uniform struct.
 *  `uvFit`/`uvWindow` are always present; the rest exist only when the shader reads
 *  the corresponding built-in (`usesTime`, `usesTexturePixelSize`, MODULATE, SCREEN_UV). */
export interface WgslBuiltinOffsets {
  uvFit: number;
  uvWindow: number;
  time?: number;
  texturePixelSize?: number;
  modulate?: number;
  screenOrigin?: number;
  screenSize?: number;
}

/** The transpiler-owned `@group(0)` binding table. User sampler `i` (index into
 *  `samplers`) occupies TWO bindings: `userSamplersBase + 2*i` for the texture and
 *  `userSamplersBase + 2*i + 1` for its sampler. */
export interface WgslBindings {
  uniform: 0;
  texture: 1;
  textureSampler: 2;
  userSamplersBase: 3;
}

export interface TranspiledWgslShader {
  /** ONE module: `vs_main` + `fs_main` + the polyfills and helpers actually used. */
  wgsl: string;
  vertexEntry: "vs_main";
  fragmentEntry: "fs_main";
  /** Size of the single uniform struct, rounded up to 16. */
  uniformStructSizeBytes: number;
  builtinOffsets: WgslBuiltinOffsets;
  /** User scalar/vector uniforms, offsets into the same struct, declaration order. */
  uniforms: WgslUniformField[];
  /** User `sampler2D` uniforms under their GODOT names, in binding order. */
  samplers: ShaderSampler[];
  bindings: WgslBindings;
  blend: GodotBlendMode;
  usesTime: boolean;
  usesTexturePixelSize: boolean;
  usesScreenUv: boolean;
}

const VERTEX_ENTRY = "vs_main";
const FRAGMENT_ENTRY = "fs_main";

const BINDINGS: WgslBindings = {
  uniform: 0,
  texture: 1,
  textureSampler: 2,
  userSamplersBase: 3,
};

// ---- public entry ----------------------------------------------------------

/** Transpile a `.gdshader` source string to one WGSL module plus its uniform layout.
 *  Throws `UnsupportedShaderError` (no backend can) or `UnsupportedWgslShaderError`
 *  (this backend can't — fall the binding back to WebGL). */
export function transpileGodotShaderWgsl(source: string): TranspiledWgslShader {
  // Same unwrap as the GLSL entry, and it has to be here too: both backends take the
  // caller's raw fetch, so a `.tres` reaches whichever one the runtime adopted.
  const cleaned = sanitizeReservedIdentifiers(
    stripComments(unwrapShaderResource(source)),
  );
  const parsed = parseShader(cleaned);

  // ORDERING CONTRACT, mirroring `transpileGodotShader`: guard BEFORE analyzing, so an
  // unsupported built-in is reported as such (and as the PLAIN error class) ahead of any
  // WGSL-specific complaint. A `while` loop must not come back as "WGSL can't" — no
  // backend can, and the runtime's fallback ladder reads the class to decide.
  const logic = shaderLogic(parsed);
  rejectUnsupported(logic, parsed);

  const analysis = analyzeShader(parsed);
  rejectScreenCapture(parsed, analysis);

  // `#define` has no WGSL equivalent. In practice it only reaches here from the
  // screen-texture alias (already rejected above), so a simple token alias is resolved
  // defensively and anything else is named and refused rather than emitted as garbage.
  const defines = extractDefines(parsed);

  const renames = buildRenameMap(parsed, defines);
  const plan = buildUniformPlan(parsed, analysis, renames);

  const globals = (text: string): string =>
    applyGlobals(text, defines, renames, plan);

  const helpersText = globals(parsed.helpers);
  const bodyText = globals(parsed.fragmentBody);
  rejectStrayDirectives(helpersText, bodyText);
  rejectFragmentLocalsInHelpers(parsed.helpers, plan);

  const ctx = createContext(parsed, plan, renames);
  const helpers = translateHelpers(helpersText, ctx);

  const fragmentCtx = childContext(ctx);
  seedFragmentScope(fragmentCtx, analysis);
  const bodyLines = translateBlock(bodyText, fragmentCtx);

  const varyingLines = analysis.varyingHoists.map((hoist) => {
    const name = renameOf(hoist.name, renames);
    const type = localWgslType(hoist.type, `varying "${hoist.name}"`);
    fragmentCtx.scope.set(name, type);
    return `var ${name}: ${type} = ${translateExpr(globals(hoist.expr), fragmentCtx)};`;
  });

  const wgsl = assembleModule({
    parsed,
    analysis,
    plan,
    renames,
    ctx,
    helpers,
    varyingLines,
    bodyLines,
  });

  return {
    wgsl,
    vertexEntry: VERTEX_ENTRY,
    fragmentEntry: FRAGMENT_ENTRY,
    uniformStructSizeBytes: plan.layout.sizeBytes,
    builtinOffsets: plan.builtinOffsets,
    uniforms: plan.uniformFields,
    samplers: parsed.samplers,
    bindings: BINDINGS,
    blend: parsed.blend,
    usesTime: analysis.usesTime,
    usesTexturePixelSize: analysis.usesTexturePixelSize,
    usesScreenUv: analysis.usesScreenUv,
  };
}

// ---- uniform struct layout -------------------------------------------------

export interface WgslStructField {
  name: string;
  /** WGSL type name (`f32`, `i32`, `vec2f`, `vec3f`, `vec4f`, `vec2i`, `mat3x3f`, …). */
  type: string;
  /** Element count when the member is an array. */
  arrayLength?: number;
}

export interface WgslStructMember extends WgslStructField {
  offsetBytes: number;
  sizeBytes: number;
  alignBytes: number;
}

export interface WgslStructLayout {
  members: WgslStructMember[];
  /** Struct size, rounded up to the struct alignment. */
  sizeBytes: number;
  alignBytes: number;
}

const SCALAR_LAYOUT: Record<string, { align: number; size: number }> = {
  f32: { align: 4, size: 4 },
  i32: { align: 4, size: 4 },
  u32: { align: 4, size: 4 },
  vec2f: { align: 8, size: 8 },
  vec2i: { align: 8, size: 8 },
  vec3f: { align: 16, size: 12 },
  vec3i: { align: 16, size: 12 },
  vec4f: { align: 16, size: 16 },
  vec4i: { align: 16, size: 16 },
  mat2x2f: { align: 8, size: 16 },
  mat3x3f: { align: 16, size: 48 },
  mat4x4f: { align: 16, size: 64 },
};

function roundUp(multiple: number, value: number): number {
  return Math.ceil(value / multiple) * multiple;
}

/** Lay out a WGSL `var<uniform>` struct by the uniform address space rules: members keep
 *  DECLARATION ORDER (a reorder would silently move every offset a writer already holds),
 *  each is placed at the next multiple of its alignment, and the struct size is rounded up
 *  to the struct alignment. Arrays get an element stride of `roundUp(align(E), size(E))`,
 *  which the uniform address space additionally requires to be a multiple of 16 — so
 *  `array<vec3f, N>` and `array<vec4f, N>` are natively fine and `array<f32, N>` /
 *  `array<vec2f, N>` are refused (they would need per-element padding on the host side).
 *
 *  These are exactly WGSL's own natural layout rules, applied to the members in the order
 *  the module declares them, which is why the emitted struct carries no explicit padding
 *  members: the compiler computes the same offsets this function records. */
export function wgslStructLayout(
  fields: readonly WgslStructField[],
): WgslStructLayout {
  const members: WgslStructMember[] = [];
  let offset = 0;
  let structAlign = 16; // a uniform struct is always bound on a 16-byte-class boundary
  for (const field of fields) {
    const base = SCALAR_LAYOUT[field.type];
    if (!base) {
      throw new UnsupportedWgslShaderError(
        `uniform type "${field.type}" has no WGSL uniform layout`,
      );
    }
    let align = base.align;
    let size = base.size;
    if (field.arrayLength !== undefined) {
      const stride = roundUp(base.align, base.size);
      if (stride % 16 !== 0) {
        throw new UnsupportedWgslShaderError(
          `uniform array "${field.name}" of ${field.type} needs a 16-byte element stride in the WGSL uniform address space (got ${stride}); array-of-scalar uniforms are deferred`,
        );
      }
      align = Math.max(16, base.align);
      size = stride * field.arrayLength;
    }
    offset = roundUp(align, offset);
    members.push({
      name: field.name,
      type: field.type,
      ...(field.arrayLength !== undefined
        ? { arrayLength: field.arrayLength }
        : {}),
      offsetBytes: offset,
      sizeBytes: size,
      alignBytes: align,
    });
    offset += size;
    structAlign = Math.max(structAlign, align);
  }
  return {
    members,
    sizeBytes: roundUp(structAlign, offset),
    alignBytes: structAlign,
  };
}

// ---- screen capture / preprocessor guards ----------------------------------

function rejectScreenCapture(
  parsed: ParsedShader,
  analysis: ShaderAnalysis,
): void {
  if (parsed.screenTextureNames.length > 0) {
    throw new UnsupportedWgslShaderError(
      `hint_screen_texture sampler "${parsed.screenTextureNames[0]}" is not supported on WebGPU: capturing what was already composited is a runtime architecture question, so this binding falls back to WebGL`,
    );
  }
  if (analysis.usesScreenTexture) {
    throw new UnsupportedWgslShaderError(
      "SCREEN_TEXTURE is not supported on WebGPU: capturing what was already composited is a runtime architecture question, so this binding falls back to WebGL",
    );
  }
  if (analysis.usesScreenPixelSize) {
    throw new UnsupportedWgslShaderError(
      "SCREEN_PIXEL_SIZE is not supported on WebGPU: it sizes the screen capture, which this backend does not produce",
    );
  }
}

/** Simple `#define A B` token aliases, pulled out of the helper text so they can be
 *  substituted (WGSL has no preprocessor). Anything more than a single-token alias is
 *  named and refused. */
function extractDefines(parsed: ParsedShader): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /^[ \t]*#define\s+([A-Za-z_]\w*)\s+([^\n]*)$/gm;
  for (const match of parsed.helpers.matchAll(re)) {
    const value = match[2].trim();
    if (!/^[A-Za-z_]\w*$/.test(value)) {
      throw new UnsupportedWgslShaderError(
        `#define "${match[1]}" is not a simple token alias and WGSL has no preprocessor`,
      );
    }
    out.push([match[1], value]);
  }
  return out;
}

function rejectStrayDirectives(helpers: string, body: string): void {
  for (const text of [helpers, body]) {
    const stray = /^[ \t]*#\s*([a-z_]+)/m.exec(text);
    if (stray) {
      throw new UnsupportedWgslShaderError(
        `preprocessor directive "#${stray[1]}" has no WGSL equivalent`,
      );
    }
  }
}

/** `UV` / `SCREEN_UV` / `COLOR` are fragment-LOCAL in both emitters (the GLSL one declares
 *  them inside `main()` too), so a top-level helper that reads one cannot be given them
 *  without inventing a calling convention. Refuse per-binding rather than emit a module
 *  that names an undeclared identifier. */
function rejectFragmentLocalsInHelpers(
  helpers: string,
  plan: UniformPlan,
): void {
  for (const token of ["UV", "SCREEN_UV", "COLOR", "GODOT_UV"]) {
    if (hasToken(helpers, token)) {
      throw new UnsupportedWgslShaderError(
        `helper function reads the fragment-local built-in "${token}"`,
      );
    }
  }
  for (const name of plan.boolUniformNames) {
    if (hasToken(helpers, name)) {
      throw new UnsupportedWgslShaderError(
        `helper function reads the bool uniform "${name}", which is hoisted as a fragment-local alias (WGSL bool is not host-shareable)`,
      );
    }
  }
}

// ---- identifier renaming ---------------------------------------------------

// WGSL keywords and reserved words (the front-end already renamed GLSL's `input`).
// Renaming is applied to the whole shader text at once — uniform names, sampler names,
// helper names, params and locals together — so a rename can never split an identifier
// from its uses. The suffix is spelled out rather than mangled so a compile error in a
// browser still points at a recognisable name.
// biome-ignore format: one keyword per line would make a 170-line wall of a lookup table.
const WGSL_RESERVED = new Set([
  // keywords
  "alias", "break", "case", "const", "const_assert", "continue", "continuing",
  "default", "diagnostic", "discard", "else", "enable", "false", "fn", "for",
  "if", "let", "loop", "override", "requires", "return", "struct", "switch",
  "true", "var", "while",
  // reserved words
  "NULL", "Self", "abstract", "active", "alignas", "alignof", "as", "asm",
  "asm_fragment", "async", "attribute", "auto", "await", "become",
  "binding_array", "cast", "catch", "class", "co_await", "co_return",
  "co_yield", "coherent", "column_major", "common", "compile",
  "compile_fragment", "concept", "const_cast", "consteval", "constexpr",
  "constinit", "crate", "debugger", "decltype", "delete", "demote",
  "demote_to_helper", "do", "dynamic_cast", "enum", "explicit", "export",
  "extends", "extern", "external", "fallthrough", "filter", "final", "finally",
  "friend", "from", "fxgroup", "get", "goto", "groupshared", "highp", "impl",
  "implements", "import", "inline", "instanceof", "interface", "layout",
  "lowp", "macro", "macro_rules", "match", "mediump", "meta", "mod", "module",
  "move", "mut", "mutable", "namespace", "new", "nil", "noexcept", "noinline",
  "nointerpolation", "non_coherent", "noncoherent", "noperspective", "null",
  "nullptr", "of", "operator", "package", "packoffset", "partition", "pass",
  "patch", "pixelfragment", "precise", "precision", "premerge", "priv",
  "protected", "pub", "public", "readonly", "ref", "regardless", "register",
  "reinterpret_cast", "require", "resource", "restrict", "self", "set",
  "shared", "sizeof", "smooth", "snorm", "static", "static_assert",
  "static_cast", "std", "subroutine", "super", "target", "template", "this",
  "thread_local", "throw", "trait", "try", "type", "typedef", "typeid",
  "typename", "union", "unless", "unorm", "unsafe", "unsized", "use", "using",
  "varying", "virtual", "volatile", "wgsl", "where", "write", "writeonly",
  "yield",
]);

// Names this emitter puts in the module itself. A shader identifier that collides with
// one of them is renamed for the same reason a reserved word is: the collision would
// otherwise be a silently wrong program (a user uniform named `time` would land on the
// built-in TIME member). The uniform-struct MEMBER names are in here too.
const EMITTER_OWNED = new Set([
  "_u",
  "Uniforms",
  "VsOut",
  "raw_uv",
  VERTEX_ENTRY,
  FRAGMENT_ENTRY,
  "godot_mod",
  "godot_mod2",
  "godot_mod3",
  "godot_mod4",
  "godot_inverse3",
  "TEXTURE_smp",
  "GODOT_UV",
  "uv_fit",
  "uv_window",
  "time",
  "texture_pixel_size",
  "modulate",
  "screen_origin",
  "screen_size",
]);

const RENAME_SUFFIX = "_gsw";

type RenameMap = Map<string, string>;

function renameOf(name: string, renames: RenameMap): string {
  return renames.get(name) ?? name;
}

function buildRenameMap(
  parsed: ParsedShader,
  defines: Array<[string, string]>,
): RenameMap {
  const text = `${parsed.helpers}\n${parsed.fragmentBody}`;
  if (/(?<![\w])_swz\d*(?![\w])/.test(text)) {
    throw new UnsupportedWgslShaderError(
      'the identifier prefix "_swz" is reserved for swizzle-assignment temporaries',
    );
  }
  // Only names the shader DECLARES are candidates. Scanning every word instead would
  // "rename" GLSL syntax that happens to be a WGSL keyword too (`if`, `const`, `return`),
  // which is not an identifier collision at all.
  const candidates = new Set<string>();
  const declared =
    /(?<![\w])(?:const\s+)?(?:void|float|int|bool|uint|vec[234]|ivec[234]|bvec[234]|mat[234])\s+([A-Za-z_]\w*)/g;
  for (const match of text.matchAll(declared)) {
    candidates.add(match[1]);
  }
  for (const uniform of parsed.uniforms) candidates.add(uniform.name);
  for (const sampler of parsed.samplers) candidates.add(sampler.name);
  for (const varying of parsed.varyings) candidates.add(varying.name);
  for (const [name] of defines) candidates.delete(name);

  const renames: RenameMap = new Map();
  for (const name of candidates) {
    if (WGSL_RESERVED.has(name) || EMITTER_OWNED.has(name)) {
      renames.set(name, `${name}${RENAME_SUFFIX}`);
    }
  }
  return renames;
}

/** The two whole-text passes every chunk of shader logic goes through before it is
 *  parsed statement by statement: resolve `#define` aliases and reserved-word renames,
 *  then bind every uniform / built-in read to its member of the one uniform struct. */
function applyGlobals(
  text: string,
  defines: Array<[string, string]>,
  renames: RenameMap,
  plan: UniformPlan,
): string {
  let out = text.replace(/^[ \t]*#define\s+[A-Za-z_]\w*\s+[^\n]*$/gm, "");
  for (const [name, value] of defines) {
    out = replaceToken(out, name, value);
  }
  for (const [from, to] of renames) {
    out = replaceToken(out, from, to);
  }
  // User uniforms first, built-ins second: the built-in member names are in
  // EMITTER_OWNED, so a user uniform can never still be spelled `time` here.
  for (const [wgslName, member] of plan.memberByWgslName) {
    if (plan.boolUniformNames.has(wgslName)) {
      // Left alone on purpose: a bool uniform resolves to the `let` alias hoisted at the
      // top of fs_main, because WGSL cannot store a `bool` in a uniform buffer.
      continue;
    }
    if (member.builtin) continue;
    out = replaceToken(out, wgslName, `_u.${wgslName}`);
  }
  if (plan.builtinOffsets.time !== undefined) {
    out = replaceToken(out, "TIME", "_u.time");
  }
  if (plan.builtinOffsets.texturePixelSize !== undefined) {
    out = replaceToken(out, "TEXTURE_PIXEL_SIZE", "_u.texture_pixel_size");
  }
  if (plan.builtinOffsets.modulate !== undefined) {
    out = replaceToken(out, "MODULATE", "_u.modulate");
  }
  return out;
}

// ---- uniform plan ----------------------------------------------------------

interface PlannedMember {
  wgslName: string;
  type: string;
  builtin: boolean;
  arrayLength?: number;
}

interface UniformPlan {
  layout: WgslStructLayout;
  builtinOffsets: WgslBuiltinOffsets;
  uniformFields: WgslUniformField[];
  members: PlannedMember[];
  memberByWgslName: Map<string, PlannedMember>;
  boolUniformNames: Set<string>;
  /** WGSL member name -> its type, for expression typing (`_u.foo`). */
  memberTypes: Map<string, string>;
}

const UNIFORM_WGSL_TYPE: Record<string, string> = {
  float: "f32",
  int: "i32",
  bool: "f32", // WGSL bool is not host-shareable; stored as a 1/0 flag
  vec2: "vec2f",
  vec3: "vec3f",
  vec4: "vec4f",
  ivec2: "vec2i",
  ivec3: "vec3i",
  ivec4: "vec4i",
  mat2: "mat2x2f",
  mat3: "mat3x3f",
  mat4: "mat4x4f",
};

function buildUniformPlan(
  parsed: ParsedShader,
  analysis: ShaderAnalysis,
  renames: RenameMap,
): UniformPlan {
  // Built-ins first, in an order chosen to leave as few alignment holes as the WGSL
  // rules allow (vec4 then vec2 then scalars), then user uniforms in DECLARATION order.
  const members: PlannedMember[] = [
    { wgslName: "uv_window", type: "vec4f", builtin: true },
    { wgslName: "uv_fit", type: "vec2f", builtin: true },
  ];
  if (analysis.usesTime) {
    members.push({ wgslName: "time", type: "f32", builtin: true });
  }
  if (analysis.usesTexturePixelSize) {
    members.push({
      wgslName: "texture_pixel_size",
      type: "vec2f",
      builtin: true,
    });
  }
  if (analysis.usesScreenUv) {
    members.push({ wgslName: "screen_origin", type: "vec2f", builtin: true });
    members.push({ wgslName: "screen_size", type: "vec2f", builtin: true });
  }
  if (analysis.needsModulate) {
    members.push({ wgslName: "modulate", type: "vec4f", builtin: true });
  }

  const boolUniformNames = new Set<string>();
  for (const uniform of parsed.uniforms) {
    const type = UNIFORM_WGSL_TYPE[uniform.type];
    if (!type) {
      throw new UnsupportedWgslShaderError(
        `uniform type "${uniform.type}" has no WGSL uniform equivalent`,
      );
    }
    if (/^bvec[234]$/.test(uniform.type)) {
      throw new UnsupportedWgslShaderError(
        `bool-vector uniform "${uniform.name}" is not host-shareable in WGSL`,
      );
    }
    const wgslName = renameOf(uniform.name, renames);
    if (uniform.type === "bool") {
      if (uniform.arrayLength !== undefined) {
        throw new UnsupportedWgslShaderError(
          `bool array uniform "${uniform.name}" is not supported`,
        );
      }
      boolUniformNames.add(wgslName);
    }
    members.push({
      wgslName,
      type,
      builtin: false,
      ...(uniform.arrayLength !== undefined
        ? { arrayLength: uniform.arrayLength }
        : {}),
    });
  }

  const layout = wgslStructLayout(
    members.map((m) => ({
      name: m.wgslName,
      type: m.type,
      ...(m.arrayLength !== undefined ? { arrayLength: m.arrayLength } : {}),
    })),
  );
  const offsetOf = new Map(
    layout.members.map((m) => [m.name, m.offsetBytes] as const),
  );
  const sizeOf = new Map(
    layout.members.map((m) => [m.name, m.sizeBytes] as const),
  );

  const builtinOffsets: WgslBuiltinOffsets = {
    uvFit: offsetOf.get("uv_fit") ?? 0,
    uvWindow: offsetOf.get("uv_window") ?? 0,
  };
  if (analysis.usesTime) builtinOffsets.time = offsetOf.get("time");
  if (analysis.usesTexturePixelSize) {
    builtinOffsets.texturePixelSize = offsetOf.get("texture_pixel_size");
  }
  if (analysis.usesScreenUv) {
    builtinOffsets.screenOrigin = offsetOf.get("screen_origin");
    builtinOffsets.screenSize = offsetOf.get("screen_size");
  }
  if (analysis.needsModulate) {
    builtinOffsets.modulate = offsetOf.get("modulate");
  }

  const uniformFields: WgslUniformField[] = parsed.uniforms.map((uniform) => {
    const wgslName = renameOf(uniform.name, renames);
    return {
      name: uniform.name,
      type: UNIFORM_WGSL_TYPE[uniform.type],
      godotType: uniform.type,
      ...(uniform.arrayLength !== undefined
        ? { arrayLength: uniform.arrayLength }
        : {}),
      offsetBytes: offsetOf.get(wgslName) ?? 0,
      sizeBytes: sizeOf.get(wgslName) ?? 0,
      ...(uniform.default !== undefined ? { default: uniform.default } : {}),
    };
  });

  const memberByWgslName = new Map(
    members.map((m) => [m.wgslName, m] as const),
  );
  const memberTypes = new Map<string, string>();
  for (const member of members) {
    memberTypes.set(
      `_u.${member.wgslName}`,
      member.arrayLength !== undefined
        ? `array<${member.type},${member.arrayLength}>`
        : member.type,
    );
  }

  return {
    layout,
    builtinOffsets,
    uniformFields,
    members,
    memberByWgslName,
    boolUniformNames,
    memberTypes,
  };
}

// ---- translation context ---------------------------------------------------

interface Ctx {
  /** identifier (or `_u.member`) -> WGSL type, for the narrow inference `mod` and
   *  `inverse` need. Function-local; the module scope is copied in. */
  scope: Map<string, string>;
  fnReturns: Map<string, string>;
  needMod: Set<number>;
  needInverse: { mat3: boolean };
  swizzle: { next: number };
  textures: Set<string>;
  uniformNames: Set<string>;
}

function createContext(
  parsed: ParsedShader,
  plan: UniformPlan,
  renames: RenameMap,
): Ctx {
  const scope = new Map<string, string>(plan.memberTypes);
  for (const name of plan.boolUniformNames) scope.set(name, "bool");
  const textures = new Set<string>(["TEXTURE"]);
  for (const sampler of parsed.samplers) {
    textures.add(renameOf(sampler.name, renames));
  }
  const uniformNames = new Set<string>();
  for (const uniform of parsed.uniforms) {
    uniformNames.add(renameOf(uniform.name, renames));
  }
  // A local (or param) named like a uniform would be silently rewritten to `_u.x` by the
  // whole-text uniform pass and stop being a local. Refuse rather than mis-emit.
  const declared =
    /(?<![\w])(?:const\s+)?(?:float|int|bool|uint|vec[234]|ivec[234]|bvec[234]|mat[234])\s+([A-Za-z_]\w*)/g;
  for (const match of `${parsed.helpers}\n${parsed.fragmentBody}`.matchAll(
    declared,
  )) {
    const name = renameOf(match[1], renames);
    if (uniformNames.has(name)) {
      throw new UnsupportedWgslShaderError(
        `local "${match[1]}" shadows the uniform of the same name`,
      );
    }
  }
  return {
    scope,
    fnReturns: new Map(),
    needMod: new Set<number>(),
    needInverse: { mat3: false },
    swizzle: { next: 0 },
    textures,
    uniformNames,
  };
}

function childContext(ctx: Ctx): Ctx {
  return { ...ctx, scope: new Map(ctx.scope) };
}

function seedFragmentScope(ctx: Ctx, analysis: ShaderAnalysis): void {
  ctx.scope.set("COLOR", "vec4f");
  ctx.scope.set("UV", "vec2f");
  ctx.scope.set("GODOT_UV", "vec2f");
  ctx.scope.set("PI", "f32");
  if (analysis.usesScreenUv) ctx.scope.set("SCREEN_UV", "vec2f");
}

// ---- helpers (top-level consts + functions) --------------------------------

interface TranslatedHelpers {
  consts: string[];
  fns: string[];
}

function translateHelpers(helpers: string, ctx: Ctx): TranslatedHelpers {
  const consts: string[] = [];
  const fns: string[] = [];
  const parsedFns: Array<{
    name: string;
    ret: string;
    params: string;
    body: string;
  }> = [];

  let i = 0;
  while (i < helpers.length) {
    while (i < helpers.length && /\s/.test(helpers[i])) i += 1;
    if (i >= helpers.length) break;
    if (helpers[i] === ";") {
      i += 1;
      continue;
    }
    const rest = helpers.slice(i);
    const constMatch =
      /^const\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*=([\s\S]*?);/.exec(rest);
    if (constMatch) {
      const type = localWgslType(constMatch[1], `const "${constMatch[2]}"`);
      ctx.scope.set(constMatch[2], type);
      consts.push(
        `const ${constMatch[2]}: ${type} = ${translateExpr(constMatch[3], ctx)};`,
      );
      i += constMatch[0].length;
      continue;
    }
    const fnMatch = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(/.exec(rest);
    if (fnMatch) {
      const open = i + fnMatch[0].length - 1;
      const closeParen = matchParen(helpers, open);
      let k = closeParen + 1;
      while (k < helpers.length && /\s/.test(helpers[k])) k += 1;
      if (helpers[k] !== "{") {
        throw new UnsupportedWgslShaderError(
          `helper "${fnMatch[2]}" has no body (forward declarations are not supported)`,
        );
      }
      const closeBrace = matchBrace(helpers, k);
      parsedFns.push({
        ret: fnMatch[1],
        name: fnMatch[2],
        params: helpers.slice(open + 1, closeParen),
        body: helpers.slice(k + 1, closeBrace),
      });
      i = closeBrace + 1;
      continue;
    }
    throw new UnsupportedWgslShaderError(
      `unsupported top-level construct "${rest.slice(0, 40).trim()}"`,
    );
  }

  // Return types first: WGSL module declarations are order-independent, and a helper may
  // call one declared below it.
  for (const fn of parsedFns) {
    if (fn.ret !== "void") {
      ctx.fnReturns.set(fn.name, localWgslType(fn.ret, `helper "${fn.name}"`));
    }
  }
  for (const fn of parsedFns) {
    const fnCtx = childContext(ctx);
    const params = parseParams(fn.params, fn.name, fnCtx);
    const signature =
      fn.ret === "void"
        ? `fn ${fn.name}(${params.join(", ")}) {`
        : `fn ${fn.name}(${params.join(", ")}) -> ${ctx.fnReturns.get(fn.name)} {`;
    fns.push(
      [signature, ...indentLines(translateBlock(fn.body, fnCtx)), "}"].join(
        "\n",
      ),
    );
  }
  return { consts, fns };
}

function parseParams(params: string, fnName: string, ctx: Ctx): string[] {
  const trimmed = params.trim();
  if (!trimmed || trimmed === "void") return [];
  return splitTopLevel(trimmed, ",").map((param) => {
    const match =
      /^(?:(in|out|inout)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)$/.exec(
        param.trim(),
      );
    if (!match) {
      throw new UnsupportedWgslShaderError(
        `helper "${fnName}" has an unsupported parameter "${param.trim()}"`,
      );
    }
    if (match[1] === "out" || match[1] === "inout") {
      throw new UnsupportedWgslShaderError(
        `helper "${fnName}" uses an ${match[1]} parameter; WGSL would need a pointer`,
      );
    }
    const type = localWgslType(match[2], `parameter "${match[3]}"`);
    if (ctx.uniformNames.has(match[3])) {
      throw new UnsupportedWgslShaderError(
        `parameter "${match[3]}" of helper "${fnName}" shadows a uniform`,
      );
    }
    ctx.scope.set(match[3], type);
    return `${match[3]}: ${type}`;
  });
}

// ---- statements ------------------------------------------------------------

const LOCAL_WGSL_TYPE: Record<string, string> = {
  ...UNIFORM_WGSL_TYPE,
  bool: "bool", // a LOCAL bool is a plain WGSL bool; only uniforms need the f32 flag
  bvec2: "vec2<bool>",
  bvec3: "vec3<bool>",
  bvec4: "vec4<bool>",
};

function localWgslType(godotType: string, what: string): string {
  const type = LOCAL_WGSL_TYPE[godotType];
  if (!type) {
    throw new UnsupportedWgslShaderError(
      `${what} has unsupported type "${godotType}"`,
    );
  }
  return type;
}

const DECLARATION =
  /^(const\s+)?(float|int|bool|uint|vec[234]|ivec[234]|bvec[234]|mat[234])\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*(?:=([\s\S]*))?$/;

function translateBlock(src: string, ctx: Ctx): string[] {
  const lines: string[] = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (i >= src.length) break;
    if (src[i] === ";") {
      i += 1;
      continue;
    }
    if (src[i] === "{") {
      const close = matchBrace(src, i);
      lines.push("{");
      lines.push(...indentLines(translateBlock(src.slice(i + 1, close), ctx)));
      lines.push("}");
      i = close + 1;
      continue;
    }
    let depth = 0;
    let stop = -1;
    let stopChar = "";
    for (let j = i; j < src.length; j += 1) {
      const c = src[j];
      if (c === "(" || c === "[") depth += 1;
      else if (c === ")" || c === "]") depth -= 1;
      else if (depth === 0 && (c === ";" || c === "{" || c === "}")) {
        stop = j;
        stopChar = c;
        break;
      }
    }
    if (stop < 0) {
      const tail = src.slice(i).trim();
      if (tail) {
        throw new UnsupportedWgslShaderError(
          `unterminated statement "${tail}"`,
        );
      }
      break;
    }
    if (stopChar === "}") {
      throw new UnsupportedWgslShaderError(
        `unbalanced braces near "${src.slice(i, stop).trim()}"`,
      );
    }
    if (stopChar === "{") {
      const header = src.slice(i, stop).trim();
      const close = matchBrace(src, stop);
      lines.push(...translateControl(header, src.slice(stop + 1, close), ctx));
      i = close + 1;
      while (i < src.length && /\s/.test(src[i])) i += 1;
      if (src[i] === ";") i += 1;
      continue;
    }
    lines.push(...translateStatement(src.slice(i, stop).trim(), ctx));
    i = stop + 1;
  }
  return mergeElse(lines);
}

function translateControl(header: string, inner: string, ctx: Ctx): string[] {
  if (/^while\b/.test(header)) {
    throw new UnsupportedShaderError("while loops are not supported");
  }
  if (/^for\b/.test(header)) {
    const open = header.indexOf("(");
    if (open < 0 || matchParen(header, open) !== header.length - 1) {
      throw new UnsupportedWgslShaderError(
        `unsupported for header "${header}"`,
      );
    }
    const clauses = splitTopLevel(
      header.slice(open + 1, header.length - 1),
      ";",
    );
    if (clauses.length !== 3) {
      throw new UnsupportedWgslShaderError(
        `for loop needs init/condition/increment, got "${header}"`,
      );
    }
    const loop = childContext(ctx);
    const init = oneLine(clauses[0], loop);
    const cond = clauses[1].trim() ? translateExpr(clauses[1], loop) : "";
    const inc = oneLine(clauses[2], loop);
    return [
      `for (${init}; ${cond}; ${inc}) {`,
      ...indentLines(translateBlock(inner, loop)),
      "}",
    ];
  }
  const ifMatch = /^(else\s+if|if)\b/.exec(header);
  if (ifMatch) {
    const open = header.indexOf("(");
    if (open < 0) {
      throw new UnsupportedWgslShaderError(`unsupported if header "${header}"`);
    }
    const close = matchParen(header, open);
    const cond = translateExpr(header.slice(open + 1, close), ctx);
    const keyword = ifMatch[1].startsWith("else") ? "else if" : "if";
    return [
      `${keyword} (${cond}) {`,
      ...indentLines(translateBlock(inner, childContext(ctx))),
      "}",
    ];
  }
  if (/^else$/.test(header)) {
    return [
      "else {",
      ...indentLines(translateBlock(inner, childContext(ctx))),
      "}",
    ];
  }
  throw new UnsupportedWgslShaderError(`unsupported block header "${header}"`);
}

/** A for-clause: one statement, rendered without its terminating `;`. */
function oneLine(clause: string, ctx: Ctx): string {
  const trimmed = clause.trim();
  if (!trimmed) return "";
  const lines = translateStatement(trimmed, ctx);
  if (lines.length !== 1) {
    throw new UnsupportedWgslShaderError(
      `for clause "${trimmed}" does not translate to a single statement`,
    );
  }
  return lines[0].replace(/;$/, "");
}

function translateStatement(stmt: string, ctx: Ctx): string[] {
  if (!stmt) return [];

  // A control statement whose body has no braces. WGSL REQUIRES braces on if/for bodies,
  // so `if (c) continue;` has to grow a block rather than pass through.
  const controlMatch = /^(if|for|while|else\s+if|else)\b/.exec(stmt);
  if (controlMatch) {
    if (controlMatch[1] === "while") {
      throw new UnsupportedShaderError("while loops are not supported");
    }
    if (controlMatch[1] === "else") {
      return translateControl("else", `${stmt.slice(4).trim()};`, ctx);
    }
    const open = stmt.indexOf("(");
    if (open < 0) {
      throw new UnsupportedWgslShaderError(`unsupported statement "${stmt}"`);
    }
    const close = matchParen(stmt, open);
    return translateControl(
      stmt.slice(0, close + 1).trim(),
      `${stmt.slice(close + 1).trim()};`,
      ctx,
    );
  }

  if (stmt === "continue" || stmt === "break" || stmt === "discard") {
    return [`${stmt};`];
  }
  if (/^return\b/.test(stmt)) {
    const value = stmt.slice("return".length).trim();
    return value ? [`return ${translateExpr(value, ctx)};`] : ["return;"];
  }

  const decl = DECLARATION.exec(stmt);
  if (decl) {
    if (decl[4]) {
      throw new UnsupportedWgslShaderError(
        `local array declaration "${decl[3]}" is not supported`,
      );
    }
    const type = localWgslType(decl[2], `local "${decl[3]}"`);
    ctx.scope.set(decl[3], type);
    if (decl[5] === undefined) {
      // WGSL zero-initializes a `var` without an initializer, matching the GLSL default
      // the shipped shaders already rely on (`float lastmask;` read after a loop).
      return [`var ${decl[3]}: ${type};`];
    }
    const keyword = decl[1] ? "let" : "var";
    return [`${keyword} ${decl[3]}: ${type} = ${translateExpr(decl[5], ctx)};`];
  }

  if (/^[A-Za-z_][\w.[\]]*\s*(\+\+|--)$/.test(stmt)) {
    return [`${stmt.replace(/\s+/g, "")};`];
  }
  const prefixInc = /^(\+\+|--)\s*([A-Za-z_][\w.[\]]*)$/.exec(stmt);
  if (prefixInc) {
    // WGSL has no prefix form; as a STATEMENT the two are the same effect.
    return [`${prefixInc[2]}${prefixInc[1]};`];
  }

  const assign = findAssignment(stmt);
  if (assign) return translateAssignment(assign, ctx);

  if (/^[A-Za-z_]\w*\s*\(/.test(stmt)) {
    return [`${translateExpr(stmt, ctx)};`];
  }
  throw new UnsupportedWgslShaderError(`unsupported statement "${stmt}"`);
}

interface Assignment {
  lvalue: string;
  op: string;
  rvalue: string;
}

function findAssignment(stmt: string): Assignment | null {
  let depth = 0;
  for (let i = 0; i < stmt.length; i += 1) {
    const c = stmt[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && c === "=") {
      if (stmt[i + 1] === "=") {
        i += 1;
        continue;
      }
      const prev = stmt[i - 1];
      if (prev === "=" || prev === "!" || prev === "<" || prev === ">")
        continue;
      if (prev === "+" || prev === "-" || prev === "*" || prev === "/") {
        return {
          lvalue: stmt.slice(0, i - 1),
          op: `${prev}=`,
          rvalue: stmt.slice(i + 1),
        };
      }
      return { lvalue: stmt.slice(0, i), op: "=", rvalue: stmt.slice(i + 1) };
    }
  }
  return null;
}

const LVALUE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^\]]*\])*$/;
// biome-ignore format: the rgba/xyzw pairing reads as two rows, not as eight lines.
const COMPONENT: Record<string, string> = {
  x: "x", y: "y", z: "z", w: "w",
  r: "x", g: "y", b: "z", a: "w",
};

function translateAssignment(assign: Assignment, ctx: Ctx): string[] {
  const lvalue = assign.lvalue.trim();
  if (lvalue.startsWith("_u.")) {
    throw new UnsupportedWgslShaderError(
      `assignment to the uniform "${lvalue.slice(3)}"`,
    );
  }
  if (!LVALUE.test(lvalue)) {
    throw new UnsupportedWgslShaderError(
      `unsupported assignment target "${lvalue}"`,
    );
  }
  const rvalue = translateExpr(assign.rvalue, ctx);

  const swizzle = /^(.+)\.([xyzwrgba]{2,4})$/.exec(lvalue);
  if (!swizzle) {
    return [`${lvalue} ${assign.op} ${rvalue};`];
  }
  // A multi-component swizzle is NOT an assignable place in WGSL (only a single component
  // is). Evaluate the right-hand side ONCE into a temp and store per component. The temp
  // goes through the target's own vector constructor so that a scalar right-hand side
  // (legal GLSL: `COLOR.rgb += f`) splats and a vector one is copied unchanged — which
  // avoids having to type-infer the right-hand side at all.
  const base = swizzle[1];
  const comps = [...swizzle[2]];
  const ctor = swizzleConstructor(base, comps.length, ctx);
  const temp = `_swz${ctx.swizzle.next}`;
  ctx.swizzle.next += 1;
  const lines = [`let ${temp} = ${ctor}(${rvalue});`];
  comps.forEach((component, index) => {
    const dst = `${base}.${COMPONENT[component]}`;
    const src = `${temp}.${"xyzw"[index]}`;
    lines.push(
      assign.op === "="
        ? `${dst} = ${src};`
        : `${dst} = ${dst} ${assign.op[0]} ${src};`,
    );
  });
  return lines;
}

function swizzleConstructor(base: string, width: number, ctx: Ctx): string {
  const type = inferType(base, ctx);
  const suffix = type && /^vec[234]i$/.test(type) ? "i" : "f";
  return `vec${width}${suffix}`;
}

// ---- expressions -----------------------------------------------------------

function translateExpr(expr: string, ctx: Ctx): string {
  const trimmed = expr.trim();
  const ternary = splitTernary(trimmed);
  if (ternary) {
    // WGSL has no `?:`. `select(f, t, cond)` evaluates BOTH sides eagerly; every corpus
    // use is a pure read (at worst an out-of-range uniform-array index, which WGSL
    // bounds-clamps rather than faults), so the eager side is unobservable.
    return `select(${translateExpr(ternary.whenFalse, ctx)}, ${translateExpr(
      ternary.whenTrue,
      ctx,
    )}, ${translateExpr(ternary.cond, ctx)})`;
  }
  let out = rewriteTextureCalls(trimmed, ctx);
  out = rewriteIntrinsics(out, ctx);
  out = renameConstructors(out);
  if (out.includes("?")) {
    throw new UnsupportedWgslShaderError(
      `ternary "?:" is only supported as a complete right-hand side, got "${trimmed}"`,
    );
  }
  return out.trim();
}

interface Ternary {
  cond: string;
  whenTrue: string;
  whenFalse: string;
}

function splitTernary(expr: string): Ternary | null {
  let depth = 0;
  let question = -1;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && c === "?") {
      question = i;
      break;
    }
  }
  if (question < 0) return null;
  depth = 0;
  let pending = 0;
  for (let i = question + 1; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && c === "?") pending += 1;
    else if (depth === 0 && c === ":") {
      if (pending > 0) {
        pending -= 1;
        continue;
      }
      return {
        cond: expr.slice(0, question),
        whenTrue: expr.slice(question + 1, i),
        whenFalse: expr.slice(i + 1),
      };
    }
  }
  throw new UnsupportedWgslShaderError(`ternary without a ":" in "${expr}"`);
}

/** `texture(t, uv)` -> `textureSampleLevel(t, t_smp, uv, 0.0)`. Explicit level 0 rather
 *  than `textureSample`: it sidesteps WGSL's non-uniform-control-flow rule for implicit
 *  derivatives (the corpus samples inside `if`/`for`), and the canvas textures this
 *  runtime binds are single-mip, so level 0 IS the only level — visually identical. */
function rewriteTextureCalls(src: string, ctx: Ctx): string {
  return mapCalls(src, "texture", (args, raw) => {
    if (args.length !== 2) {
      throw new UnsupportedWgslShaderError(
        `texture() with ${args.length} arguments is not supported ("${raw}")`,
      );
    }
    const sampler = args[0].trim();
    if (!ctx.textures.has(sampler)) {
      throw new UnsupportedWgslShaderError(
        `texture() on "${sampler}", which is not a declared sampler2D uniform`,
      );
    }
    return `textureSampleLevel(${sampler}, ${sampler}_smp, ${args[1].trim()}, 0.0)`;
  });
}

function rewriteIntrinsics(src: string, ctx: Ctx): string {
  let out = mapCalls(src, "mod", (args, raw) => {
    if (args.length !== 2) {
      throw new UnsupportedWgslShaderError(
        `mod() with ${args.length} arguments`,
      );
    }
    const left = widthOf(args[0], ctx, raw);
    const right = widthOf(args[1], ctx, raw);
    const width = Math.max(left, right);
    ctx.needMod.add(width);
    const fn = width === 1 ? "godot_mod" : `godot_mod${width}`;
    return `${fn}(${broadcast(args[0].trim(), left, width)}, ${broadcast(
      args[1].trim(),
      right,
      width,
    )})`;
  });
  out = mapCalls(out, "atan", (args) =>
    args.length === 2
      ? `atan2(${args[0].trim()}, ${args[1].trim()})`
      : `atan(${args[0].trim()})`,
  );
  out = mapCalls(out, "inverse", (args, raw) => {
    const type = inferType(args[0], ctx);
    if (type !== "mat3x3f") {
      throw new UnsupportedWgslShaderError(
        `inverse() is only supported on a mat3 (got ${type ?? "an untyped expression"} in "${raw}")`,
      );
    }
    ctx.needInverse.mat3 = true;
    return `godot_inverse3(${args[0].trim()})`;
  });
  return out;
}

function broadcast(expr: string, from: number, to: number): string {
  return from === to ? expr : `vec${to}f(${expr})`;
}

function widthOf(expr: string, ctx: Ctx, raw: string): number {
  const type = inferType(expr, ctx);
  const width = type ? typeWidth(type) : null;
  if (width === null) {
    throw new UnsupportedWgslShaderError(
      `cannot infer the component count of "${expr.trim()}" in "${raw}" (WGSL has no function overloading, so mod()'s polyfill is chosen by width)`,
    );
  }
  return width;
}

// `float(` -> `f32(` etc. The lookbehind keeps the pass off identifiers that merely END
// with a type name (`myvec3(`), and the alternatives never match an already-emitted WGSL
// spelling (`vec3f(` has an `f` where the pattern wants `(`).
const CONSTRUCTORS: Record<string, string> = {
  float: "f32",
  int: "i32",
  vec2: "vec2f",
  vec3: "vec3f",
  vec4: "vec4f",
  ivec2: "vec2i",
  ivec3: "vec3i",
  ivec4: "vec4i",
  bvec2: "vec2<bool>",
  bvec3: "vec3<bool>",
  bvec4: "vec4<bool>",
  mat2: "mat2x2f",
  mat3: "mat3x3f",
  mat4: "mat4x4f",
};

function renameConstructors(src: string): string {
  return src.replace(
    /(?<![\w.])(float|int|vec[234]|ivec[234]|bvec[234]|mat[234])(\s*)\(/g,
    (_match, name: string, space: string) => `${CONSTRUCTORS[name]}${space}(`,
  );
}

// ---- narrow type inference -------------------------------------------------
//
// Deliberately NOT a type checker: the only two rules that need a type are `mod` (WGSL
// has no user-function overloading, so the polyfill's component count is part of its
// name) and `inverse` (mat3 only). Everything else is either declared with an explicit
// type or is passed through untouched. `null` means "don't know", and the two callers
// turn that into a named UnsupportedWgslShaderError rather than a guess.

const VECTOR_TYPE = /^vec([234])([fi])$/;

function typeWidth(type: string): number | null {
  if (type === "f32" || type === "i32" || type === "u32" || type === "bool") {
    return 1;
  }
  const match = VECTOR_TYPE.exec(type);
  return match ? Number(match[1]) : null;
}

const SCALAR_RETURN = new Set(["length", "dot", "distance", "determinant"]);
const VEC4_RETURN = new Set(["texture", "textureSampleLevel", "textureLoad"]);
const BOOL_RETURN = new Set(["any", "all"]);

function inferType(expr: string, ctx: Ctx): string | null {
  let e = expr.trim();
  while (e.startsWith("(") && matchParen(e, 0) === e.length - 1) {
    e = e.slice(1, -1).trim();
  }
  if (!e) return null;
  if (hasTopLevelComparison(e)) return "bool";

  const operands = splitOperands(e);
  if (operands.length > 1) {
    let best: string | null = null;
    for (const operand of operands) {
      const type = inferType(operand, ctx);
      if (!type) continue;
      const width = typeWidth(type);
      const bestWidth = best ? typeWidth(best) : null;
      if (best === null || (width ?? 0) > (bestWidth ?? 0)) best = type;
    }
    return best;
  }
  if (/^[-+!~]/.test(e)) return inferType(e.slice(1), ctx);
  if (/^\d/.test(e) || /^\.\d/.test(e)) return "f32";

  const call = /^([A-Za-z_]\w*)\s*\(/.exec(e);
  if (call && matchParen(e, e.indexOf("(")) === e.length - 1) {
    return inferCallType(call[1], e, ctx);
  }

  const swizzle = /^(.+)\.([xyzwrgba]+)$/.exec(e);
  if (swizzle) {
    const baseType = inferType(swizzle[1], ctx);
    const match = baseType ? VECTOR_TYPE.exec(baseType) : null;
    if (match) {
      const width = swizzle[2].length;
      return width === 1 ? scalarOf(match[2]) : `vec${width}${match[2]}`;
    }
  }

  const index = /^(.+)\[[^\]]*\]$/.exec(e);
  if (index) {
    const arrayType = inferType(index[1], ctx);
    const element = arrayType ? /^array<([^,]+),/.exec(arrayType) : null;
    if (element) return element[1];
    if (arrayType === "mat3x3f") return "vec3f";
    if (arrayType === "mat2x2f") return "vec2f";
    if (arrayType === "mat4x4f") return "vec4f";
  }

  return ctx.scope.get(e) ?? null;
}

function scalarOf(suffix: string): string {
  return suffix === "i" ? "i32" : "f32";
}

function inferCallType(name: string, expr: string, ctx: Ctx): string | null {
  const ctor = CONSTRUCTORS[name];
  if (ctor) return ctor;
  if (/^(f32|i32|u32|vec[234][fi]|mat[234]x[234]f)$/.test(name)) return name;
  if (SCALAR_RETURN.has(name)) return "f32";
  if (VEC4_RETURN.has(name)) return "vec4f";
  if (BOOL_RETURN.has(name)) return "bool";
  const helper = ctx.fnReturns.get(name);
  if (helper) return helper;
  // Everything else that survives here (abs, min, mix, smoothstep, clamp, pow, …) is
  // component-wise in both languages: the result is as wide as the widest argument.
  const open = expr.indexOf("(");
  const args = splitTopLevel(expr.slice(open + 1, expr.length - 1), ",");
  let best: string | null = null;
  for (const arg of args) {
    if (!arg.trim()) continue;
    const type = inferType(arg, ctx);
    if (!type) continue;
    const bestWidth = best ? typeWidth(best) : null;
    if (best === null || (typeWidth(type) ?? 0) > (bestWidth ?? 0)) best = type;
  }
  return best;
}

function hasTopLevelComparison(expr: string): boolean {
  let depth = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0) {
      const pair = expr.slice(i, i + 2);
      if (pair === "&&" || pair === "||" || pair === "==" || pair === "!=") {
        return true;
      }
      if (
        (c === "<" || c === ">") &&
        expr[i + 1] !== "<" &&
        expr[i + 1] !== ">"
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Split on top-level `+ - * /`, skipping the unary uses (leading, or right after
 *  another operator or an opening delimiter). Only used to find the WIDEST operand. */
function splitOperands(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && "+-*/%".includes(c)) {
      const before = expr.slice(start, i).trim();
      if (!before) continue;
      if (/[-+*/%<>=!&|,(]$/.test(before)) continue;
      parts.push(before);
      start = i + 1;
    }
  }
  const tail = expr.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

// ---- call rewriting utilities ----------------------------------------------

function mapCalls(
  src: string,
  name: string,
  transform: (args: string[], raw: string) => string,
): string {
  const pattern = new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g");
  let out = "";
  let index = 0;
  for (;;) {
    pattern.lastIndex = index;
    const match = pattern.exec(src);
    if (!match) {
      out += src.slice(index);
      return out;
    }
    const open = match.index + match[0].length - 1;
    const close = matchParen(src, open);
    const raw = src.slice(match.index, close + 1);
    // Arguments first: a nested `mod(mod(...))` must be rewritten inside out.
    const args = splitTopLevel(src.slice(open + 1, close), ",").map((arg) =>
      mapCalls(arg, name, transform),
    );
    out += src.slice(index, match.index);
    out += transform(args, raw);
    index = close + 1;
  }
}

function matchParen(src: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new UnsupportedWgslShaderError(
    `unbalanced parentheses in "${src.slice(openIndex, openIndex + 40)}"`,
  );
}

function splitTopLevel(src: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth === 0 && c === separator) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

function indentLines(lines: string[]): string[] {
  return lines.map((line) => (line ? `  ${line}` : line));
}

function mergeElse(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      previous.trim() === "}" &&
      /^\s*else\b/.test(line)
    ) {
      out[out.length - 1] = `${previous} ${line.trim()}`;
      continue;
    }
    out.push(line);
  }
  return out;
}

// ---- module assembly -------------------------------------------------------

const MOD_POLYFILL_HEADER = `// GLSL's mod() is FLOOR-signed (x - y*floor(x/y)); WGSL's % is TRUNC-signed, so they
// disagree wherever x goes negative — a scrolling UV crossing zero would tear. WGSL has
// no user-defined function overloading, so the component count lives in the name.`;

const INVERSE_POLYFILL = `// WGSL has no inverse(). Cofactor / determinant, column-major like both languages.
fn godot_inverse3(m: mat3x3f) -> mat3x3f {
  let a = m[0];
  let b = m[1];
  let c = m[2];
  let b01 = c.z * b.y - b.z * c.y;
  let b11 = b.z * c.x - c.z * b.x;
  let b21 = c.y * b.x - b.y * c.x;
  let det = a.x * b01 + a.y * b11 + a.z * b21;
  let inv = mat3x3f(
    vec3f(b01, a.z * c.y - c.z * a.y, b.z * a.y - a.z * b.y),
    vec3f(b11, c.z * a.x - a.z * c.x, a.z * b.x - b.z * a.x),
    vec3f(b21, a.y * c.x - c.y * a.x, b.y * a.x - a.y * b.x)
  );
  return inv * (1.0 / det);
}`;

const VS_MAIN = `struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn ${VERTEX_ENTRY}(@builtin(vertex_index) index: u32) -> VsOut {
  // TRIANGLE_STRIP corner order: (-1,-1) (1,-1) (-1,1) (1,1).
  var corners = array<vec2f, 4>(
    vec2f(-1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(-1.0, 1.0),
    vec2f(1.0, 1.0)
  );
  let xy = corners[index];
  var out: VsOut;
  out.pos = vec4f(xy, 0.0, 1.0);
  // Godot's UV is node-local with a TOP-LEFT origin; clip Y is up. The flip lives HERE,
  // in the vertex stage, so the fragment prelude below is the GLSL one MINUS its
  // "1.0 - v_uv.y" — one place to get wrong instead of one per fragment.
  out.uv = vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5);
  return out;
}`;

interface AssembleInput {
  parsed: ParsedShader;
  analysis: ShaderAnalysis;
  plan: UniformPlan;
  renames: RenameMap;
  ctx: Ctx;
  helpers: TranslatedHelpers;
  varyingLines: string[];
  bodyLines: string[];
}

function assembleModule(input: AssembleInput): string {
  const { parsed, analysis, plan, renames, ctx } = input;

  const memberLines = plan.members.map((member) => {
    const type =
      member.arrayLength !== undefined
        ? `array<${member.type}, ${member.arrayLength}>`
        : member.type;
    return `  ${member.wgslName}: ${type},`;
  });
  const structText = [
    "// One uniform struct for everything the fragment reads. Members are laid out by",
    "// WGSL's own uniform address space rules IN DECLARATION ORDER, which is exactly what",
    "// `wgslStructLayout` records — so the byte offsets a writer holds and the offsets the",
    "// compiler computes are the same numbers, with no explicit padding members to drift.",
    "struct Uniforms {",
    ...memberLines,
    "}",
  ].join("\n");

  const bindingLines = [
    `@group(0) @binding(${BINDINGS.uniform}) var<uniform> _u: Uniforms;`,
    `@group(0) @binding(${BINDINGS.texture}) var TEXTURE: texture_2d<f32>;`,
    `@group(0) @binding(${BINDINGS.textureSampler}) var TEXTURE_smp: sampler;`,
  ];
  parsed.samplers.forEach((sampler, i) => {
    const name = renameOf(sampler.name, renames);
    bindingLines.push(
      `@group(0) @binding(${BINDINGS.userSamplersBase + i * 2}) var ${name}: texture_2d<f32>;`,
    );
    bindingLines.push(
      `@group(0) @binding(${BINDINGS.userSamplersBase + i * 2 + 1}) var ${name}_smp: sampler;`,
    );
  });

  const consts: string[] = [];
  if (analysis.usesPi) {
    consts.push("const PI: f32 = 3.141592653589793;");
  }
  consts.push(...input.helpers.consts);

  const polyfills: string[] = [];
  if (ctx.needMod.size > 0) {
    const widths = [...ctx.needMod].sort((a, b) => a - b);
    polyfills.push(
      [
        MOD_POLYFILL_HEADER,
        ...widths.map((width) => {
          const type = width === 1 ? "f32" : `vec${width}f`;
          const fn = width === 1 ? "godot_mod" : `godot_mod${width}`;
          return `fn ${fn}(x: ${type}, y: ${type}) -> ${type} { return x - y * floor(x / y); }`;
        }),
      ].join("\n"),
    );
  }
  if (ctx.needInverse.mat3) polyfills.push(INVERSE_POLYFILL);

  const fragment: string[] = [];
  const bodyTogether = input.bodyLines.join("\n");
  for (const name of plan.boolUniformNames) {
    // WGSL bool is not host-shareable, so the uniform holds a 1/0 f32 and the shader body
    // reads this alias under the Godot name. Only the ones the body actually reads get an
    // alias; a declared-but-unused bool uniform still keeps its struct member (the runtime
    // writes by offset, and dropping the member would move every offset after it).
    if (hasToken(bodyTogether, name)) {
      fragment.push(`let ${name}: bool = (_u.${name} != 0.0);`);
    }
  }
  fragment.push("let raw_uv = in.uv;");
  fragment.push(
    "let GODOT_UV = _u.uv_window.xy + raw_uv * _u.uv_window.zw;",
    "let UV = (GODOT_UV - vec2f(0.5)) / _u.uv_fit + vec2f(0.5);",
  );
  if (analysis.usesScreenUv) {
    fragment.push(
      "let SCREEN_UV = _u.screen_origin + GODOT_UV * _u.screen_size;",
    );
  }
  fragment.push(
    analysis.opaqueColor
      ? "var COLOR: vec4f = vec4f(textureSampleLevel(TEXTURE, TEXTURE_smp, UV, 0.0).rgb, 1.0);"
      : "var COLOR: vec4f = textureSampleLevel(TEXTURE, TEXTURE_smp, UV, 0.0);",
  );
  fragment.push(...input.varyingLines);
  fragment.push(...input.bodyLines);
  if (analysis.autoModulate) {
    fragment.push("COLOR = COLOR * _u.modulate;");
  }
  fragment.push(
    '// PREMULTIPLIED. A GPUCanvasContext offers only alphaMode "opaque" | "premultiplied",',
    "// so this is THE canvas contract: return rgb*a with a, and let the pipeline blend",
    "// one / one-minus-src-alpha on colour AND alpha. Returning straight alpha here halos;",
    "// returning premultiplied under a src-alpha blend double-multiplies. Neither errors.",
    "return vec4f(COLOR.rgb * COLOR.a, COLOR.a);",
  );

  const fsMain = [
    "@fragment",
    `fn ${FRAGMENT_ENTRY}(in: VsOut) -> @location(0) vec4f {`,
    ...indentLines(fragment),
    "}",
  ].join("\n");

  const sections = [
    "// Generated by transpileGodotShaderWgsl (packages/html/src/webgpu/transpile-wgsl.ts).",
    structText,
    bindingLines.join("\n"),
    consts.length > 0 ? consts.join("\n") : "",
    polyfills.join("\n\n"),
    input.helpers.fns.join("\n\n"),
    VS_MAIN,
    fsMain,
  ].filter((section) => section !== "");

  return `${sections.join("\n\n")}\n`;
}
