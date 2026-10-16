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
// The subset is deliberately the one a renderer can execute EXACTLY: COLOR, UV, TEXTURE, PI/TAU/E,
// user uniforms (bool, int, float, vec/ivec 2-4, and arrays of them), sampler2D uniforms with filter/repeat/default-white hints, `instance uniform`s, helper
// functions and constants, and `render_mode` blend_*/unshaded/light_only. Anything else throws
// `UnsupportedShaderError` with a message naming it, which a renderer reports as a typed refusal
// and draws the item without its material. `light()` is dropped: Godot runs it only per light, and
// an item-space renderer has none.

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
  /** The module's entry point: `void godot_item_fragment(inout vec4 COLOR, in vec2 UV)`. */
  entry: "godot_item_fragment",
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
}

export interface TranspiledItemShader {
  /** The module (see the file note). Not a complete shader: a renderer wraps it. */
  glsl: string;
  uniforms: ItemShaderUniform[];
  samplers: ItemShaderSampler[];
  blend: ItemShaderBlend;
  lightMode: ItemShaderLightMode;
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

/** Fragment built-ins outside the item-space subset (each would need state no item draw has). */
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
  "SCREEN_UV",
  "SCREEN_PIXEL_SIZE",
  "SCREEN_TEXTURE",
  "REGION_RECT",
  "POINT_COORD",
  "AT_LIGHT_PASS",
  "TEXTURE_PIXEL_SIZE",
  "TIME",
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

const ALLOWED_SAMPLER_HINTS =
  /^(filter_nearest|filter_linear|repeat_enable|repeat_disable|hint_default_white)$/;
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
} {
  let blend: ItemShaderBlend = "mix";
  let lightMode: ItemShaderLightMode = "normal";
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
      } else if (
        mode === "skip_vertex_transform" ||
        mode === "world_vertex_coords"
      ) {
        // Vertex-stage modes: without a vertex() (refused below) they change nothing.
        continue;
      }
      throw new UnsupportedShaderError(`unsupported render_mode "${mode}"`);
    }
  }
  return { blend, lightMode };
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
  const withoutLight = dropFunction(cleaned, "light");
  const parsed = parseShader(withoutLight);
  if (parsed.vertexBody !== null) {
    throw new UnsupportedShaderError("vertex() is not supported");
  }
  if (parsed.varyings.length > 0) {
    throw new UnsupportedShaderError("varyings are not supported");
  }
  if (parsed.screenTextureNames.length > 0) {
    throw new UnsupportedShaderError("hint_screen_texture is not supported");
  }
  const logic = `${parsed.helpers}\n${parsed.fragmentBody}`;
  for (const builtin of ITEM_UNSUPPORTED_BUILTINS) {
    if (hasToken(logic, builtin)) {
      throw new UnsupportedShaderError(`unsupported built-in "${builtin}"`);
    }
  }
  if (/\b(uint|uvec[234]|bvec[234])\b/.test(logic)) {
    throw new UnsupportedShaderError(
      "unsigned and boolean-vector types are not supported",
    );
  }
  const { blend, lightMode } = parseRenderModes(withoutLight);

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
    });
  }

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

  const decls: string[] = [];
  if (hasToken(logic, "PI"))
    decls.push("const float PI = 3.1415926535897932384626433833;");
  if (hasToken(logic, "TAU"))
    decls.push("const float TAU = 6.2831853071795864769252867666;");
  if (hasToken(logic, "E"))
    decls.push("const float E = 2.7182818284590452353602874714;");
  for (const u of uniforms) {
    decls.push(
      `uniform ${u.type} ${u.name}${u.arrayLength !== undefined ? `[${u.arrayLength}]` : ""};`,
    );
  }
  for (const s of samplers) decls.push(`uniform sampler2D ${s.name};`);
  const helpers = promote(parsed.helpers).trim();
  const body = promote(parsed.fragmentBody)
    .split("\n")
    .map((line) => (line.trim() ? `  ${line.trim()}` : ""))
    .filter((line) => line !== "")
    .join("\n");
  const glsl = `${decls.join("\n")}
${helpers ? `${helpers}\n` : ""}void ${ITEM_SHADER_PRELUDE_NAMES.entry}(inout vec4 COLOR, in vec2 UV) {
${body}
}
`;
  return { glsl, uniforms, samplers, blend, lightMode };
}

/** The text after `<name>` in its uniform declaration, up to the `;`. */
function declarationTail(src: string, name: string): string {
  const m = new RegExp(`uniform\\s+[A-Za-z0-9_]+\\s+${name}\\b([^;]*);`).exec(
    src,
  );
  return m ? m[1] : "";
}
