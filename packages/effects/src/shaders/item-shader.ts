// Godot `canvas_item` ShaderMaterial code -> an ITEM-SPACE GLSL ES 3.00 module.
//
// `transpileGodotShader` (godot-shader.ts) emits a whole program for a fullscreen effect quad: it
// samples the node texture itself, multiplies the node MODULATE in, and owns `main()`. An item-space
// program is different: it runs inside a CanvasItem renderer's own draw of an item's quads and
// meshes, so the renderer owns `main()` and hands the user code what Godot's `canvas.glsl` hands
// `fragment()` (drivers/gles3/shaders/canvas.glsl, Godot 4.5.1):
//
//   vec4 color = color_interp;          // vertex colour × the item's composed modulate
//   color *= texture(color_texture, uv); // the item's own texture (a white texel for a rect)
//   #CODE : FRAGMENT                     // COLOR is `color`, UV is `uv`, TEXTURE `color_texture`
//   color *= canvas_modulation;          // unless render_mode unshaded (light_only: no lights,
//                                        // so nothing is drawn)
//
// So this emitter does NOT seed COLOR, does not apply a modulate rule and does not own `main()`.
// It returns a module: the user uniforms and samplers, the helpers, and
//
//   void godot_item_fragment(inout vec4 COLOR, in vec2 UV) { <fragment() body> }
//
// which a renderer's fragment stage calls between its own texture multiply and its canvas
// modulate, with `uniform sampler2D TEXTURE;` declared by the renderer (ITEM_SHADER_PRELUDE_NAMES).
// Its input is the code a Godot RenderingServer receives (the scene layer's preprocessor output:
// whitespace runs collapsed, `#include` expanded between `@@>path` / `@@<path` marker lines), or
// plain `.gdshader` text.
//
// The subset is deliberately the one a renderer can execute EXACTLY: COLOR, UV, TEXTURE,
// TEXTURE_PIXEL_SIZE, AT_LIGHT_PASS, PI/TAU/E, user uniforms (bool, int, float, vec/ivec 2-4, and
// arrays of them), sampler2D uniforms with filter/repeat/default-white hints, `instance uniform`s,
// helper functions and constants, `render_mode` blend_*/unshaded/light_only, the screen: SCREEN_UV,
// SCREEN_PIXEL_SIZE and `hint_screen_texture` samplers (see `screenTexture` below), and a
// `vertex()` with varyings (see `vertexGlsl` below). Anything else throws `UnsupportedShaderError`
// with a message naming it, which a renderer reports as a typed refusal and draws the item without
// its material. `light()` is dropped: Godot runs it only per light, and an item-space renderer has
// none.
//
// `vertex()` (P3-VX). Godot's canvas.glsl vertex stage (drivers/gles3/shaders/canvas.glsl:131-285),
// with the GLES3 compiler's renames (drivers/gles3/storage/material_storage.cpp:1150-1220):
//
//   vertex = <command-local position>; uv = <its UV>;
//   color  = <vertex colour> * <the item's composed modulate>   // folded in BEFORE vertex()
//   #ifdef USE_WORLD_VERTEX_COORDS  vertex = (model_matrix * vec4(vertex, 0, 1)).xy;
//   { #CODE : VERTEX }               // VERTEX vertex, UV uv, COLOR color, POINT_SIZE point_size,
//                                    // MODEL_MATRIX model_matrix, CANVAS_MATRIX canvas_transform,
//                                    // SCREEN_MATRIX screen_transform, AT_LIGHT_PASS false
//   #if !SKIP_TRANSFORM_USED && !USE_WORLD_VERTEX_COORDS  vertex = (model_matrix * …).xy;
//   color_interp = color; vertex = (canvas_transform * …).xy; gl_Position = screen_transform * …;
//
// The vertex module declares the same uniforms and samplers, the varyings `out` (their
// interpolation and precision qualifiers kept), the constants and only the helpers the vertex code
// reaches, and `void godot_item_vertex(inout vec2 VERTEX, inout vec2 UV, inout vec4 COLOR,
// inout float POINT_SIZE, in mat4 MODEL_MATRIX, in mat4 CANVAS_MATRIX, in mat4 SCREEN_MATRIX)`;
// the renderer owns the stage's `main()` and does everything around the call. INSTANCE_CUSTOM is
// the renderer's `GSW_INSTANCE_CUSTOM` when it defines one (an instanced multimesh draw), else
// `vec4(0.0)`, which is what canvas.glsl has for every draw that is not an instanced multimesh.
// INSTANCE_ID is `gl_InstanceID` (vertex() only, as Godot): an instanced multimesh draw's instance
// index, 0 for every draw GSW issues non-instanced (a mesh, a polygon, a rect run). GLES3 numbers a
// batch of rects by position in the batch (rasterizer_canvas_gles3.cpp:1318), which GSW's merged
// index ranges do not model: a shader keyed on INSTANCE_ID over rects is the one divergence.
// `skip_vertex_transform` needs the vertex stage even without a `vertex()` (GLES3 then never applies
// the model matrix); `world_vertex_coords` without one changes nothing.

import {
  hasToken,
  matchBrace,
  parseShader,
  promoteIntLiterals,
  sanitizeReservedIdentifiers,
  stripComments,
  UnsupportedShaderError,
} from "./godot-shader";

/** The names an item-space module expects its renderer to declare or call. */
export const ITEM_SHADER_PRELUDE_NAMES = {
  /** `uniform sampler2D TEXTURE;`: the item's own texture, straight (not premultiplied). */
  texture: "TEXTURE",
  /** Declared BY THE MODULE when the code reads the screen (`uniform sampler2D SCREEN_TEXTURE;`):
   *  the renderer binds its back-buffer copy here (`screenTexture`), never a user texture. */
  screenTexture: "SCREEN_TEXTURE",
  /** Declared BY THE MODULE when the code uses SCREEN_UV or SCREEN_PIXEL_SIZE
   *  (`uniform vec2 SCREEN_PIXEL_SIZE;`): the renderer sets 1 / its render target's size, and
   *  `SCREEN_UV` is `gl_FragCoord.xy * SCREEN_PIXEL_SIZE`, as Godot's canvas.glsl:679 -- so the
   *  target must be stored the way Godot stores it (row 0 at the bottom, y-up). */
  screenPixelSize: "SCREEN_PIXEL_SIZE",
  /** Declared BY THE MODULE (either stage) when the code reads TIME (`uniform float TIME;`): the
   *  renderer sets the host's shader time, Godot's `RasterizerGLES3::time_total` (the scaled frame
   *  steps summed, wrapped at `rendering/limits/time/time_rollover_secs`,
   *  rasterizer_gles3.cpp:97-107), converted to float as GLES3 uploads it. */
  time: "TIME",
  /** The module's entry point: `void godot_item_fragment(inout vec4 COLOR, in vec2 UV)`. */
  entry: "godot_item_fragment",
  /** The vertex module's entry point (`vertexGlsl`): `void godot_item_vertex(inout vec2 VERTEX,
   *  inout vec2 UV, inout vec4 COLOR, inout float POINT_SIZE, in mat4 MODEL_MATRIX,
   *  in mat4 CANVAS_MATRIX, in mat4 SCREEN_MATRIX)`. The renderer's vertex stage declares
   *  `uniform sampler2D TEXTURE;` too (TEXTURE_PIXEL_SIZE reads its size). */
  vertexEntry: "godot_item_vertex",
  /** Defined by the vertex module under `render_mode skip_vertex_transform`: the renderer does
   *  not apply the model matrix after the call. */
  skipVertexTransform: "GSW_SKIP_VERTEX_TRANSFORM",
  /** Defined by the vertex module under `render_mode world_vertex_coords`: the renderer applies
   *  the model matrix before the call, and not after it. */
  worldVertexCoords: "GSW_WORLD_VERTEX_COORDS",
  /** Defined BY THE RENDERER before the vertex module, when it draws instances (Godot's
   *  multimesh): `INSTANCE_CUSTOM` is this expression, the draw's per-instance custom data
   *  (`#define GSW_INSTANCE_CUSTOM a_instance_custom`). Left undefined, `INSTANCE_CUSTOM` is
   *  `vec4(0.0)`, which is what canvas.glsl has for every draw that is not an instanced multimesh. */
  instanceCustom: "GSW_INSTANCE_CUSTOM",
} as const;

export type ItemShaderBlend =
  | "mix"
  | "add"
  | "sub"
  | "mul"
  | "premul_alpha"
  | "disabled";
export type ItemShaderLightMode = "normal" | "unshaded" | "light_only";

/** The GLSL types a uniform value can take, by component storage. */
export type ItemUniformType =
  | "bool"
  | "int"
  | "ivec2"
  | "ivec3"
  | "ivec4"
  | "float"
  | "vec2"
  | "vec3"
  | "vec4";

export interface ItemShaderUniform {
  name: string;
  type: ItemUniformType;
  /** Element count for `name[N]`, absent for a non-array. */
  arrayLength?: number;
  /** `instance uniform`: the value comes from the item, not from the material. */
  instance: boolean;
  /** Components per element, 1 to 4. */
  components: number;
  /** Whether the GL values are integers (bool, int, ivec) rather than floats. */
  integer: boolean;
  /** The value when nothing sets the parameter, flattened (components × max(1, arrayLength)):
   *  the declared default, else Godot's unset value ((0,0,0,1) for a `source_color` vec4, zero
   *  otherwise; drivers/gles3/storage/material_storage.cpp:768-794). */
  unset: number[];
}

export interface ItemShaderSampler {
  name: string;
  /** `filter_nearest` / `filter_linear`; null when no filter hint is given (Godot 4.5's
   *  canvas default is linear: `filter_from_uniform_canvas`, material_storage.cpp:707-715). */
  filter: "nearest" | "linear" | null;
  /** `repeat_enable` / `repeat_disable`; null when no hint is given (the canvas default is
   *  disabled: `repeat_from_uniform_canvas`, material_storage.cpp:691-695). */
  repeat: boolean | null;
  /** The texture GLES3 binds when the material sets none (material_storage.cpp:928-953):
   *  `hint_default_black` black (0,0,0,1), `hint_default_transparent` (0,0,0,0), `hint_normal` and
   *  `hint_roughness_normal` the normal (0.5,0.5,1,1) as RGBA8 (127,127,255,255),
   *  `hint_anisotropy` (1,0.5,1,1), anything else white. Each is a 4x4 single-colour texture
   *  (texture_storage.cpp:66-155), so any filter or wrap samples its one colour. */
  default: ItemSamplerDefault;
}

export type ItemSamplerDefault =
  | "white"
  | "black"
  | "transparent"
  | "normal"
  | "anisotropy";

export interface TranspiledItemShader {
  /** The module (see the file note). Not a complete shader: a renderer wraps it. */
  glsl: string;
  uniforms: ItemShaderUniform[];
  samplers: ItemShaderSampler[];
  /** The code samples the screen (`hint_screen_texture`): the renderer binds a copy of its render
   *  target to `SCREEN_TEXTURE` taken where Godot's GLES3 canvas renderer takes one (before the
   *  first such item of each canvas, rasterizer_canvas_gles3.cpp:426-533). `mipmaps`: a screen
   *  sampler that is read has a `filter_*_mipmap*` hint, so that copy needs Godot's blurred mip
   *  chain (`uses_screen_texture_mipmaps`, shader_compiler.cpp:929-933). Null otherwise.
   *  GLES3 ignores the screen sampler's other hints (the back buffer is always sampled linear,
   *  linear-mipmap, clamped), and so does this result. */
  screenTexture: { names: string[]; mipmaps: boolean } | null;
  /** The code uses SCREEN_UV or SCREEN_PIXEL_SIZE (the module declares SCREEN_PIXEL_SIZE). */
  screenPixelSize: boolean;
  /** The code (either stage) reads TIME: the module declares `uniform float TIME;`, which the
   *  renderer sets to the host's shader time (see `ITEM_SHADER_PRELUDE_NAMES.time`). */
  time: boolean;
  blend: ItemShaderBlend;
  lightMode: ItemShaderLightMode;
  /** P3-VX: the program needs its own vertex stage (a `vertex()`, or `skip_vertex_transform`):
   *  `vertexGlsl` is its module (see the file note). False: the renderer's plain vertex stage. */
  vertexStage: boolean;
  /** The vertex module, or null when `vertexStage` is false. Not part of the metadata a renderer
   *  serializes: it is GLSL, like `glsl`. */
  vertexGlsl: string | null;
  /** `render_mode skip_vertex_transform` / `world_vertex_coords` (also `#define`d in
   *  `vertexGlsl`). */
  skipVertexTransform: boolean;
  worldVertexCoords: boolean;
  /** The user varyings as declared (`flat`/`smooth` and precision kept), in declaration order. */
  varyings: ItemShaderVarying[];
}

export interface ItemShaderVarying {
  name: string;
  /** GLSL type (`vec4`, `int`, …). */
  type: string;
  /** `flat`, `smooth` or null (smooth). */
  interpolation: "flat" | "smooth" | null;
  /** `name[N]`'s N, absent for a non-array. */
  arrayLength?: number;
  /** Assigned in the vertex stage, so interpolated into `fragment()`; false: a fragment-stage
   *  global (Godot passes those on to `light()` only, which an item-space renderer never runs). */
  fromVertex: boolean;
}

const COMPONENTS: Record<ItemUniformType, number> = {
  bool: 1,
  int: 1,
  ivec2: 2,
  ivec3: 3,
  ivec4: 4,
  float: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
};

/** Fragment built-ins outside the item-space subset (each would need state no item draw has). The
 *  vertex-only built-ins are here too: Godot refuses them in `fragment()` and helpers alike. */
const ITEM_UNSUPPORTED_BUILTINS = [
  "VERTEX",
  "SHADOW_VERTEX",
  "LIGHT_VERTEX",
  "FRAGCOORD",
  "NORMAL",
  "NORMAL_MAP",
  "NORMAL_MAP_DEPTH",
  "NORMAL_TEXTURE",
  "SPECULAR_SHININESS",
  "SPECULAR_SHININESS_TEXTURE",
  "SCREEN_TEXTURE",
  "REGION_RECT",
  "POINT_COORD",
  "POINT_SIZE",
  "INSTANCE_CUSTOM",
  "INSTANCE_ID",
  "VERTEX_ID",
  "MODEL_MATRIX",
  "CANVAS_MATRIX",
  "SCREEN_MATRIX",
  "CUSTOM0",
  "CUSTOM1",
  "texture_sdf",
  "texture_sdf_normal",
  "sdf_to_screen_uv",
  "screen_uv_to_sdf",
];

/** Names `vertex()` (and the helpers it reaches) may not use, each with why. The rest of Godot
 *  4.5.1's canvas_item vertex built-ins (shader_types.cpp:266-280) are admitted. */
const VERTEX_REFUSED: Record<string, string> = {
  VERTEX_ID:
    "VERTEX_ID is GLES3's per-batch vertex index, which an item-space draw does not reproduce",
  CUSTOM0:
    "CUSTOM0 needs a mesh's custom attribute arrays, which are not carried",
  CUSTOM1:
    "CUSTOM1 needs a mesh's custom attribute arrays, which are not carried",
  TEXTURE: "TEXTURE is not a vertex() built-in",
  SCREEN_UV: "SCREEN_UV is not a vertex() built-in",
  SCREEN_PIXEL_SIZE: "SCREEN_PIXEL_SIZE is not a vertex() built-in",
  FRAGCOORD: "FRAGCOORD is not a vertex() built-in",
  NORMAL: "NORMAL is not a vertex() built-in",
  NORMAL_MAP: "NORMAL_MAP is not a vertex() built-in",
  NORMAL_MAP_DEPTH: "NORMAL_MAP_DEPTH is not a vertex() built-in",
  REGION_RECT: "REGION_RECT is not a vertex() built-in",
  POINT_COORD: "POINT_COORD is not a vertex() built-in",
  texture_sdf: "texture_sdf is not available in vertex()",
  texture_sdf_normal: "texture_sdf_normal is not available in vertex()",
  sdf_to_screen_uv: "sdf_to_screen_uv is not available in vertex()",
  screen_uv_to_sdf: "screen_uv_to_sdf is not available in vertex()",
};

/** The renderer's own vertex-stage names (`a_`, `u_`, `v_`, `gsw_`): a user varying so named is
 *  renamed `gsw_vary_<name>` so the two never collide. */
const RENDERER_NAME = /^(a_|u_|v_|gsw_)/;

const ALLOWED_SAMPLER_HINTS =
  /^(filter_nearest|filter_linear|repeat_enable|repeat_disable|hint_default_white|hint_default_black|hint_default_transparent|hint_normal|hint_roughness_normal|hint_anisotropy)$/;

/** GLES3's unset-sampler texture for a `sampler2D`'s hints (material_storage.cpp:928-953). */
function samplerDefault(hints: readonly string[]): ItemSamplerDefault {
  if (hints.includes("hint_default_black")) return "black";
  if (hints.includes("hint_default_transparent")) return "transparent";
  if (hints.includes("hint_anisotropy")) return "anisotropy";
  if (hints.includes("hint_normal") || hints.includes("hint_roughness_normal"))
    return "normal";
  return "white";
}
/** A screen sampler's hints: GLES3 ignores all but the mipmap filters (see `screenTexture`). */
const SCREEN_SAMPLER_HINTS =
  /^(hint_screen_texture|filter_(nearest|linear)(_mipmap(_anisotropic)?)?|repeat_enable|repeat_disable)$/;
const ALLOWED_UNIFORM_HINTS =
  /^(source_color|hint_range\b.*|instance_index\b.*)$/;

/** Remove the preprocessor's `@@>path` / `@@<path` include marker lines (Godot's server code). */
export function stripIncludeMarkers(code: string): string {
  return code.replace(/^@@[<>][^\n]*\n?/gm, "");
}

/** Remove `void <name>() { … }` (top level). */
function dropFunction(src: string, name: string): string {
  const head = new RegExp(`void\\s+${name}\\s*\\(\\s*\\)\\s*\\{`).exec(src);
  if (!head) return src;
  const open = head.index + head[0].length - 1;
  const end = matchBrace(src, open);
  return src.slice(0, head.index) + src.slice(end + 1);
}

function parseRenderModes(src: string): {
  blend: ItemShaderBlend;
  lightMode: ItemShaderLightMode;
  skipVertexTransform: boolean;
  worldVertexCoords: boolean;
} {
  let blend: ItemShaderBlend = "mix";
  let lightMode: ItemShaderLightMode = "normal";
  let skipVertexTransform = false;
  let worldVertexCoords = false;
  for (const match of src.matchAll(/render_mode\s+([^;]+);/g)) {
    for (const raw of match[1].split(",")) {
      const mode = raw.trim();
      if (mode.startsWith("blend_")) {
        const b = mode.slice("blend_".length);
        if (
          b === "mix" ||
          b === "add" ||
          b === "sub" ||
          b === "mul" ||
          b === "premul_alpha" ||
          b === "disabled"
        ) {
          blend = b;
          continue;
        }
      } else if (mode === "unshaded") {
        lightMode = "unshaded";
        continue;
      } else if (mode === "light_only") {
        lightMode = "light_only";
        continue;
      } else if (mode === "skip_vertex_transform") {
        skipVertexTransform = true;
        continue;
      } else if (mode === "world_vertex_coords") {
        worldVertexCoords = true;
        continue;
      }
      throw new UnsupportedShaderError(`unsupported render_mode "${mode}"`);
    }
  }
  return { blend, lightMode, skipVertexTransform, worldVertexCoords };
}

const VARYING_DECL =
  /^varying\s+(?:(flat|smooth)\s+)?(?:(lowp|mediump|highp)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[\s*(\d+)\s*\])?$/;

/** Every `varying …;` declaration, or throw for one this subset does not read. */
function parseItemVaryings(
  src: string,
): (Omit<ItemShaderVarying, "fromVertex"> & { precision: string | null })[] {
  const out: (Omit<ItemShaderVarying, "fromVertex"> & {
    precision: string | null;
  })[] = [];
  for (const m of src.matchAll(/\bvarying\b[^;]*;/g)) {
    const text = m[0].slice(0, -1).replace(/\s+/g, " ").trim();
    const d = VARYING_DECL.exec(text);
    if (!d) {
      throw new UnsupportedShaderError(
        `varying declaration "${text}" is not supported (one name per declaration)`,
      );
    }
    if (/^(sampler|mat)/.test(d[3]) || d[3] === "struct") {
      throw new UnsupportedShaderError(
        `varying "${d[4]}": type ${d[3]} is not supported`,
      );
    }
    out.push({
      name: d[4],
      type: d[3],
      interpolation: (d[1] as "flat" | "smooth" | undefined) ?? null,
      precision: d[2] ?? null,
      ...(d[5] !== undefined ? { arrayLength: Number(d[5]) } : {}),
    });
  }
  return out;
}

/** Top-level pieces of the helper text: functions (named) and everything else (constants,
 *  structs), in order. */
function splitTopLevel(src: string): { text: string; fn: string | null }[] {
  const out: { text: string; fn: string | null }[] = [];
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ";") {
      const text = src.slice(start, i + 1).trim();
      if (text) out.push({ text, fn: null });
      start = i + 1;
      i++;
      continue;
    }
    if (c === "{") {
      const head = src.slice(start, i);
      const close = matchBrace(src, i);
      if (/^\s*struct\b/.test(head)) {
        // `struct S { … };` ends at its `;`.
        i = close + 1;
        continue;
      }
      const name = /([A-Za-z_][A-Za-z0-9_]*)\s*\([^()]*\)\s*$/.exec(head);
      out.push({
        text: src.slice(start, close + 1).trim(),
        fn: name?.[1] ?? "",
      });
      start = close + 1;
      i = close + 1;
      continue;
    }
    i++;
  }
  const rest = src.slice(start).trim();
  if (rest) out.push({ text: rest, fn: null });
  return out;
}

/** The helper text the vertex stage needs: every non-function piece, and the functions `body`
 *  calls, transitively (Godot emits per stage only the functions that stage reaches). */
function vertexHelpers(helpers: string, body: string): string {
  const pieces = splitTopLevel(helpers);
  const used = new Set<string>();
  let frontier = body;
  for (;;) {
    const before = used.size;
    for (const p of pieces)
      if (p.fn && !used.has(p.fn) && hasToken(frontier, p.fn)) used.add(p.fn);
    if (used.size === before) break;
    frontier = `${body}\n${pieces
      .filter((p) => p.fn !== null && used.has(p.fn))
      .map((p) => p.text)
      .join("\n")}`;
  }
  return pieces
    .filter((p) => p.fn === null || used.has(p.fn))
    .map((p) => p.text)
    .join("\n");
}

/** Whole-identifier replace that leaves member accesses (`x.name`) alone. */
function renameIdentifier(src: string, from: string, to: string): string {
  return src.replace(new RegExp(`(?<![\\w.])${from}(?![\\w])`, "g"), to);
}

/** A default literal flattened to `components` numbers, or throw. */
function expandDefault(
  raw: string,
  type: ItemUniformType,
  name: string,
): number[] {
  const n = COMPONENTS[type];
  const scalar = (text: string): number => {
    const t = text.trim();
    if (t === "true") return 1;
    if (t === "false") return 0;
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) {
      throw new UnsupportedShaderError(
        `uniform "${name}": default "${raw}" is not a literal`,
      );
    }
    return Number.parseFloat(t);
  };
  const ctor = /^([a-z0-9]+)\s*\(([^()]*)\)$/.exec(raw.trim());
  if (ctor) {
    if (ctor[1] !== type) {
      throw new UnsupportedShaderError(
        `uniform "${name}": default "${raw}" is not a ${type} constructor`,
      );
    }
    const args = ctor[2].split(",").map(scalar);
    if (args.length === 1) return new Array<number>(n).fill(args[0]);
    if (args.length !== n) {
      throw new UnsupportedShaderError(
        `uniform "${name}": default "${raw}" has ${args.length} components, not ${n}`,
      );
    }
    return args;
  }
  if (n !== 1) {
    throw new UnsupportedShaderError(
      `uniform "${name}": default "${raw}" is not a ${type} constructor`,
    );
  }
  return [scalar(raw)];
}

/** Godot's value for a parameter nothing set (material_storage.cpp:768-794). */
function unsetValue(
  type: ItemUniformType,
  arrayLength: number | undefined,
  hints: string[],
  declaredDefault: number[] | null,
): number[] {
  const count = Math.max(1, arrayLength ?? 1);
  let element: number[];
  if (declaredDefault) {
    element = declaredDefault;
  } else if (
    (type === "vec3" || type === "vec4") &&
    hints.includes("source_color")
  ) {
    element = type === "vec4" ? [0, 0, 0, 1] : [0, 0, 0];
  } else {
    element = new Array<number>(COMPONENTS[type]).fill(0);
  }
  // A default is a single element; an array has none (refused above) and is zeros.
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(...element);
  return out;
}

/** Transpile a `canvas_item` shader to an item-space module. Throws `UnsupportedShaderError`. */
export function transpileGodotItemShader(code: string): TranspiledItemShader {
  const cleaned = sanitizeReservedIdentifiers(
    stripComments(stripIncludeMarkers(code)),
  );
  if (/^\s*#/m.test(cleaned)) {
    throw new UnsupportedShaderError(
      "preprocessor directives are not supported (pass the preprocessed code)",
    );
  }
  // light() runs per light only; an item-space renderer has none, so it never runs.
  let withoutLight = dropFunction(cleaned, "light");
  // Varyings: a name the renderer's stages use for themselves is renamed throughout.
  const declaredVaryings = parseItemVaryings(withoutLight);
  for (const v of declaredVaryings) {
    if (!RENDERER_NAME.test(v.name)) continue;
    const to = `gsw_vary_${v.name}`;
    withoutLight = renameIdentifier(withoutLight, v.name, to);
    v.name = to;
  }
  // Godot runs a missing fragment() as an empty one (COLOR stays the texture × colour).
  if (!/void\s+fragment\s*\(\s*\)\s*\{/.test(withoutLight))
    withoutLight = `${withoutLight}\nvoid fragment() {}\n`;
  const parsed = parseShader(withoutLight);
  const modes = parseRenderModes(withoutLight);
  // GLES3 skips the model matrix under skip_vertex_transform whether or not there is a vertex().
  const vertexStage = parsed.vertexBody !== null || modes.skipVertexTransform;
  const vertexBody = parsed.vertexBody ?? "";
  const vertexHelperText = vertexStage
    ? vertexHelpers(parsed.helpers, vertexBody)
    : "";
  const vertexLogic = `${vertexHelperText}\n${vertexBody}`;
  if (vertexStage) {
    for (const [name, why] of Object.entries(VERTEX_REFUSED))
      if (hasToken(vertexLogic, name))
        throw new UnsupportedShaderError(`vertex(): ${why}`);
    for (const name of parsed.screenTextureNames)
      if (hasToken(vertexLogic, name))
        throw new UnsupportedShaderError(
          `vertex(): the screen texture "${name}" is not readable in vertex()`,
        );
  }
  const varyings: ItemShaderVarying[] = declaredVaryings.map((v) => ({
    name: v.name,
    type: v.type,
    interpolation: v.interpolation,
    ...(v.arrayLength !== undefined ? { arrayLength: v.arrayLength } : {}),
    fromVertex: vertexStage && hasToken(vertexLogic, v.name),
  }));
  const logic = `${parsed.helpers}\n${parsed.fragmentBody}`;
  for (const builtin of ITEM_UNSUPPORTED_BUILTINS) {
    // SCREEN_TEXTURE is a Godot 3 built-in (refused); a `hint_screen_texture` sampler may be
    // named so (Godot 4), and is handled below.
    if (
      builtin === "SCREEN_TEXTURE" &&
      parsed.screenTextureNames.includes(builtin)
    )
      continue;
    if (hasToken(logic, builtin)) {
      throw new UnsupportedShaderError(`unsupported built-in "${builtin}"`);
    }
  }
  if (/\b(uint|uvec[234]|bvec[234])\b/.test(`${logic}\n${vertexLogic}`)) {
    throw new UnsupportedShaderError(
      "unsigned and boolean-vector types are not supported",
    );
  }
  const { blend, lightMode, skipVertexTransform, worldVertexCoords } = modes;

  const declOf = (name: string) =>
    parsed.declarations.get(name) ?? {
      qualifier: null,
      hints: [],
      defaultText: null,
    };
  const uniforms: ItemShaderUniform[] = [];
  for (const u of parsed.uniforms) {
    const d = declOf(u.name);
    if (d.qualifier === "global") {
      throw new UnsupportedShaderError(
        `global uniform "${u.name}" is not supported`,
      );
    }
    if (/^mat/.test(u.type)) {
      // A matrix parameter arrives as a Transform2D/Basis/Projection whose std140 layout this
      // subset does not port (material_storage.cpp:263-349).
      throw new UnsupportedShaderError(
        `uniform "${u.name}": matrix uniforms are not supported`,
      );
    }
    if (!(u.type in COMPONENTS)) {
      throw new UnsupportedShaderError(
        `uniform "${u.name}": type ${u.type} is not supported`,
      );
    }
    const type = u.type as ItemUniformType;
    for (const hint of d.hints) {
      if (!ALLOWED_UNIFORM_HINTS.test(hint)) {
        throw new UnsupportedShaderError(
          `uniform "${u.name}": hint "${hint}" is not supported`,
        );
      }
    }
    if (d.defaultText !== null && u.arrayLength !== undefined) {
      throw new UnsupportedShaderError(
        `uniform "${u.name}": array defaults are not supported`,
      );
    }
    const def =
      d.defaultText === null
        ? null
        : expandDefault(d.defaultText, type, u.name);
    uniforms.push({
      name: u.name,
      type,
      ...(u.arrayLength !== undefined ? { arrayLength: u.arrayLength } : {}),
      instance: d.qualifier === "instance",
      components: COMPONENTS[type],
      integer: type === "bool" || type === "int" || type.startsWith("ivec"),
      unset: unsetValue(type, u.arrayLength, d.hints, def),
    });
  }
  const samplers: ItemShaderSampler[] = [];
  for (const s of parsed.samplers) {
    const d = declOf(s.name);
    if (d.qualifier !== null) {
      throw new UnsupportedShaderError(
        `${d.qualifier} sampler "${s.name}" is not supported`,
      );
    }
    for (const hint of d.hints) {
      if (!ALLOWED_SAMPLER_HINTS.test(hint)) {
        throw new UnsupportedShaderError(
          `sampler "${s.name}": hint "${hint}" is not supported`,
        );
      }
    }
    if (/^\s*\[/.test(declarationTail(withoutLight, s.name))) {
      throw new UnsupportedShaderError(
        `sampler "${s.name}": sampler arrays are not supported`,
      );
    }
    samplers.push({
      name: s.name,
      filter: d.hints.includes("filter_nearest")
        ? "nearest"
        : d.hints.includes("filter_linear")
          ? "linear"
          : null,
      repeat: d.hints.includes("repeat_enable")
        ? true
        : d.hints.includes("repeat_disable")
          ? false
          : null,
      default: samplerDefault(d.hints),
    });
  }

  // Screen samplers: Godot binds its back buffer to every `hint_screen_texture` sampler
  // (shader_compiler.cpp:929-933, `color_buffer`); the module aliases each to one SCREEN_TEXTURE.
  let screenTexture: TranspiledItemShader["screenTexture"] = null;
  if (parsed.screenTextureNames.length > 0) {
    let mipmaps = false;
    for (const name of parsed.screenTextureNames) {
      const d = declOf(name);
      if (d.qualifier !== null) {
        throw new UnsupportedShaderError(
          `${d.qualifier} sampler "${name}" is not supported`,
        );
      }
      if (/^\s*\[/.test(declarationTail(withoutLight, name))) {
        throw new UnsupportedShaderError(
          `sampler "${name}": sampler arrays are not supported`,
        );
      }
      for (const hint of d.hints) {
        if (!SCREEN_SAMPLER_HINTS.test(hint)) {
          throw new UnsupportedShaderError(
            `sampler "${name}": hint "${hint}" is not supported`,
          );
        }
      }
      if (
        hasToken(logic, name) &&
        d.hints.some((h) => /^filter_(nearest|linear)_mipmap/.test(h))
      )
        mipmaps = true;
    }
    screenTexture = { names: [...parsed.screenTextureNames], mipmaps };
  }
  const usesScreenUv = hasToken(logic, "SCREEN_UV");
  const screenPixelSize = usesScreenUv || hasToken(logic, "SCREEN_PIXEL_SIZE");
  const fragmentTime = hasToken(logic, "TIME");
  const vertexTime = vertexStage && hasToken(vertexLogic, "TIME");
  const timeDecl = `uniform float ${ITEM_SHADER_PRELUDE_NAMES.time};`;

  // Integer contexts: int and ivec names (uniforms, locals, parameters) keep their literal
  // operands int (`phase % 6`, `5 - p`); every other bare integer literal is a float in Godot.
  const intNames = new Set(parsed.intIdentifiers);
  for (const m of withoutLight.matchAll(
    /\b(?:const\s+)?(?:ivec[234]|int)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    intNames.add(m[1]);
  }
  for (const u of uniforms)
    if (u.integer && u.type !== "bool") intNames.add(u.name);
  const promote = (text: string) =>
    promoteIntLiterals(text, intNames, { arithmetic: true });

  // Declarations both stages share: the constants a stage's text uses, the user uniforms and
  // samplers (GLSL ES links a uniform both stages declare as one).
  const constants = (text: string): string[] => {
    const out: string[] = [];
    if (hasToken(text, "PI"))
      out.push("const float PI = 3.1415926535897932384626433833;");
    if (hasToken(text, "TAU"))
      out.push("const float TAU = 6.2831853071795864769252867666;");
    if (hasToken(text, "E"))
      out.push("const float E = 2.7182818284590452353602874714;");
    return out;
  };
  const userDecls: string[] = [];
  for (const u of uniforms) {
    userDecls.push(
      `uniform ${u.type} ${u.name}${u.arrayLength !== undefined ? `[${u.arrayLength}]` : ""};`,
    );
  }
  for (const s of samplers) userDecls.push(`uniform sampler2D ${s.name};`);
  // Godot's TEXTURE_PIXEL_SIZE is 1 / the bound texture's size, 1x1 for the default white
  // (rasterizer_canvas_gles3.cpp:2378-2400); the renderer's TEXTURE is the draw's texture.
  const builtinDefines = (text: string): string[] => {
    const out: string[] = [];
    if (hasToken(text, "TEXTURE_PIXEL_SIZE"))
      out.push(
        `#define TEXTURE_PIXEL_SIZE (vec2(1.0) / vec2(textureSize(${ITEM_SHADER_PRELUDE_NAMES.texture}, 0)))`,
      );
    if (hasToken(text, "AT_LIGHT_PASS"))
      out.push("#define AT_LIGHT_PASS false");
    // GLES3 renames it to gl_InstanceID (material_storage.cpp:1248): the index within the draw
    // call's instances. Only the vertex module reaches this (the fragment refuses the name).
    if (hasToken(text, "INSTANCE_ID"))
      out.push("#define INSTANCE_ID gl_InstanceID");
    if (hasToken(text, "INSTANCE_CUSTOM")) {
      const custom = ITEM_SHADER_PRELUDE_NAMES.instanceCustom;
      out.push(
        `#ifdef ${custom}`,
        `#define INSTANCE_CUSTOM ${custom}`,
        "#else",
        "#define INSTANCE_CUSTOM vec4(0.0)",
        "#endif",
      );
    }
    return out;
  };
  const varyingDecl = (v: ItemShaderVarying, storage: "in" | "out" | null) => {
    const precision =
      declaredVaryings.find((d) => d.name === v.name)?.precision ?? null;
    return `${storage !== null && v.interpolation ? `${v.interpolation} ` : ""}${storage !== null ? `${storage} ` : ""}${precision ? `${precision} ` : ""}${v.type} ${v.name}${v.arrayLength !== undefined ? `[${v.arrayLength}]` : ""};`;
  };

  const decls: string[] = [...constants(logic), ...userDecls];
  if (screenTexture) {
    const screen = ITEM_SHADER_PRELUDE_NAMES.screenTexture;
    decls.push(`uniform sampler2D ${screen};`);
    for (const name of screenTexture.names)
      if (name !== screen) decls.push(`#define ${name} ${screen}`);
  }
  if (screenPixelSize)
    decls.push(`uniform vec2 ${ITEM_SHADER_PRELUDE_NAMES.screenPixelSize};`);
  if (fragmentTime) decls.push(timeDecl);
  if (usesScreenUv)
    decls.push(
      `#define SCREEN_UV (gl_FragCoord.xy * ${ITEM_SHADER_PRELUDE_NAMES.screenPixelSize})`,
    );
  decls.push(...builtinDefines(logic));
  for (const v of varyings)
    decls.push(varyingDecl(v, v.fromVertex ? "in" : null));
  const indentBody = (text: string) =>
    text
      .split("\n")
      .map((line) => (line.trim() ? `  ${line.trim()}` : ""))
      .filter((line) => line !== "")
      .join("\n");
  const helpers = promote(parsed.helpers).trim();
  const body = indentBody(promote(parsed.fragmentBody));
  const glsl = `${decls.join("\n")}
${helpers ? `${helpers}\n` : ""}void ${ITEM_SHADER_PRELUDE_NAMES.entry}(inout vec4 COLOR, in vec2 UV) {
${body}
}
`;

  let vertexGlsl: string | null = null;
  if (vertexStage) {
    const vdecls: string[] = [];
    if (skipVertexTransform)
      vdecls.push(`#define ${ITEM_SHADER_PRELUDE_NAMES.skipVertexTransform}`);
    if (worldVertexCoords)
      vdecls.push(`#define ${ITEM_SHADER_PRELUDE_NAMES.worldVertexCoords}`);
    vdecls.push(
      ...constants(vertexLogic),
      ...userDecls,
      ...builtinDefines(vertexLogic),
    );
    if (vertexTime) vdecls.push(timeDecl);
    for (const v of varyings)
      if (v.fromVertex) vdecls.push(varyingDecl(v, "out"));
    const vhelpers = promote(vertexHelperText).trim();
    vertexGlsl = `${vdecls.join("\n")}
${vhelpers ? `${vhelpers}\n` : ""}void ${ITEM_SHADER_PRELUDE_NAMES.vertexEntry}(inout vec2 VERTEX, inout vec2 UV, inout vec4 COLOR, inout float POINT_SIZE, in mat4 MODEL_MATRIX, in mat4 CANVAS_MATRIX, in mat4 SCREEN_MATRIX) {
${indentBody(promote(vertexBody))}
}
`;
  }
  return {
    glsl,
    uniforms,
    samplers,
    screenTexture,
    screenPixelSize,
    time: fragmentTime || vertexTime,
    blend,
    lightMode,
    vertexStage,
    vertexGlsl,
    skipVertexTransform,
    worldVertexCoords,
    varyings,
  };
}

/** The text after `<name>` in its uniform declaration, up to the `;`. */
function declarationTail(src: string, name: string): string {
  const m = new RegExp(`uniform\\s+[A-Za-z0-9_]+\\s+${name}\\b([^;]*);`).exec(
    src,
  );
  return m ? m[1] : "";
}
