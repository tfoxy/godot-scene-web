// Writing one shader binding's uniform values into the single `var<uniform>` struct that
// `./transpile-wgsl` laid out.
//
// WHY THIS IS ITS OWN FILE, AND PURE. On WebGL every uniform is addressed BY NAME through a
// `WebGLUniformLocation`, and a wrong type is a warning the driver prints. On WebGPU the struct is
// one opaque block of bytes: an offset that is four bytes out, or an `array<vec3f>` packed tightly
// instead of at its 16-byte stride, produces a shader that runs perfectly and draws the wrong
// picture — silently, with nothing to log. So the packing is a plain function over plain numbers,
// testable against hand-computed offsets without a device (`test/webgpu-shader-uniforms.test.ts`),
// rather than a few lines buried in a render path that only a GPU can execute.
//
// THE TWO RULES THAT ARE NOT OBVIOUS:
//   * a Godot `bool` uniform is stored as `f32` (WGSL `bool` is not host-shareable), so the writer
//     has to consult `godotType` — an `f32` member may really be a 1/0 flag — and an `int` uniform
//     is a genuine `i32`, which must be written through an Int32Array view, not as a float that
//     happens to hold an integer.
//   * a uniform-address-space array has an element stride rounded up to 16 bytes, so an
//     `array<vec3f, N>` is written every FOUR floats with a padding lane between elements. Packing
//     it tightly is the classic "the first element is right and the rest are garbage" bug.
//
// Everything here is numbers and typed arrays — no `GPU*` global is referenced — so it imports
// cleanly into node (the parity harness bundles it) and needs no device to test.

import type {
  WgslBuiltinOffsets,
  WgslUniformField,
} from "@godot-scene-web/effects/shaders";

/** A shader parameter's value as the runtime parsed it out of `data-godot-shader-params`: a scalar,
 *  a vector/array flattened into one number list, or absent (the declared default is used). Kept
 *  structurally identical to the shader runtime's `ShaderParamValue` so the two cannot drift. */
export type PackedParamValue = number | number[];

/** The layout half of a `TranspiledWgslShader` — everything `packShaderUniforms` needs and nothing
 *  else, so a test can hand-build one. */
export interface ShaderUniformLayout {
  /** Size of the whole struct in bytes (already rounded up to its alignment). */
  uniformStructSizeBytes: number;
  builtinOffsets: WgslBuiltinOffsets;
  uniforms: WgslUniformField[];
}

/** The values one render supplies. The built-ins mirror the WebGL backend's uniform writes one for
 *  one (see `renderNodeGl`), so the two renderers are fed the SAME numbers; the optional ones are
 *  written only when the shader declared them, which is exactly when the offset exists. */
export interface ShaderUniformValues {
  /** `_godot_uv_fit` — the fraction of the canvas the fitted texture covers. */
  uvFit: readonly [number, number];
  /** `_godot_uv_window` — the node-local sub-rect this canvas covers, [u0,v0,du,dv]. */
  uvWindow: readonly number[];
  /** `TIME`, seconds. */
  time?: number;
  /** `TEXTURE_PIXEL_SIZE` — 1/texture width, 1/texture height. */
  texturePixelSize?: readonly [number, number];
  /** `MODULATE` — the node's colour multiply, RGBA. */
  modulate?: readonly number[];
  /** `SCREEN_UV`'s node origin and size within the scene-root viewport. */
  screenOrigin?: readonly [number, number];
  screenSize?: readonly [number, number];
  /** User `shader_parameter/<name>` values, by GODOT name (`WgslUniformField.name`). */
  params?: Record<string, PackedParamValue | undefined>;
  /** Godot's own type name per parameter (`PackedColorArray`, …) — the one case where the wire
   *  format needs re-interpreting; see `PACKED_COLOR_ARRAY` below. */
  paramKinds?: Record<string, string>;
}

/** A `PackedColorArray` arrives as RGBA quads even when the uniform is `vec3[]` — the same
 *  correction the WebGL path makes in `normalizeVec3ArrayUniformValues`. */
const PACKED_COLOR_ARRAY = "PackedColorArray";

/** Uniform-address-space arrays are strided to 16 bytes (4 floats) per element. */
const ARRAY_STRIDE_FLOATS = 4;

/** How many scalar components each WGSL member type holds. */
const COMPONENTS: Record<string, number> = {
  f32: 1,
  i32: 1,
  u32: 1,
  vec2f: 2,
  vec2i: 2,
  vec3f: 3,
  vec3i: 3,
  vec4f: 4,
  vec4i: 4,
};

/** WGSL types written as signed INTEGERS rather than floats (an `int` uniform, and the `ivecN`s). */
const INTEGER_TYPES = new Set(["i32", "vec2i", "vec3i", "vec4i"]);

/** The staging buffer for one binding: the same bytes seen as floats and as i32s, because one
 *  uniform struct legitimately holds both. `bytes` is what a `writeBuffer` uploads. */
export interface UniformStaging {
  bytes: ArrayBuffer;
  floats: Float32Array;
  ints: Int32Array;
}

/** Allocate a staging block big enough for `sizeBytes` (rounded up to a whole float). */
export function createUniformStaging(sizeBytes: number): UniformStaging {
  const size = Math.max(4, Math.ceil(sizeBytes / 4) * 4);
  const bytes = new ArrayBuffer(size);
  return {
    bytes,
    floats: new Float32Array(bytes),
    ints: new Int32Array(bytes),
  };
}

/**
 * Write `values` into `staging` at the byte offsets `layout` declares, and return it.
 *
 * ZEROED FIRST, deliberately: a uniform whose value disappeared between frames (a param attribute
 * dropped, a `MODULATE` that stopped applying) must read as 0, not as whatever the previous frame
 * left in that lane. The struct is small (tens of bytes) and this happens once per binding per
 * frame, so the clear is not worth optimising away for the class of bug it removes.
 */
export function packShaderUniforms(
  layout: ShaderUniformLayout,
  values: ShaderUniformValues,
  staging: UniformStaging = createUniformStaging(layout.uniformStructSizeBytes),
): UniformStaging {
  staging.floats.fill(0);

  const { builtinOffsets } = layout;
  writeFloats(staging, builtinOffsets.uvFit, values.uvFit, 2);
  writeFloats(staging, builtinOffsets.uvWindow, values.uvWindow, 4);
  if (builtinOffsets.time !== undefined) {
    staging.floats[builtinOffsets.time / 4] = values.time ?? 0;
  }
  writeFloats(
    staging,
    builtinOffsets.texturePixelSize,
    values.texturePixelSize,
    2,
  );
  writeFloats(staging, builtinOffsets.modulate, values.modulate, 4);
  writeFloats(staging, builtinOffsets.screenOrigin, values.screenOrigin, 2);
  writeFloats(staging, builtinOffsets.screenSize, values.screenSize, 2);

  const params = values.params ?? {};
  for (const field of layout.uniforms) {
    // The declared default, exactly as the WebGL path falls back to `uniform.default` when the node
    // carries no value for a parameter.
    const raw = params[field.name] ?? field.default;
    writeUniformField(staging, field, raw, values.paramKinds?.[field.name]);
  }
  return staging;
}

function writeUniformField(
  staging: UniformStaging,
  field: WgslUniformField,
  raw: PackedParamValue | undefined,
  paramKind: string | undefined,
): void {
  const components = COMPONENTS[field.type];
  // `mat2x2f`/`mat3x3f`/`mat4x4f` have no scalar component count here: no Godot uniform of matrix
  // type reaches a shader parameter attribute (they are computed in-shader), and inventing a
  // column-padded write for a case that cannot occur would be untested code in a silent-failure
  // position. The lane stays zeroed.
  if (components === undefined) return;
  const target = INTEGER_TYPES.has(field.type) ? staging.ints : staging.floats;
  const base = field.offsetBytes / 4;

  if (field.arrayLength === undefined) {
    if (components === 1) {
      target[base] = scalarOf(raw, field.godotType);
      return;
    }
    const list = Array.isArray(raw) ? raw : [];
    for (let i = 0; i < components; i++) target[base + i] = list[i] ?? 0;
    return;
  }

  // ARRAY: element `i` starts at `base + i * 4` floats, whatever its component count — the uniform
  // address space rounds every array element stride up to 16 bytes, so a `vec3f[]` leaves one
  // padding lane per element and an `f32[]`/`vec2f[]` would need three (which is why
  // `wgslStructLayout` refuses those outright rather than letting a writer guess).
  const list = normalizeArrayValues(raw, field, paramKind);
  for (let element = 0; element < field.arrayLength; element++) {
    const slot = base + element * ARRAY_STRIDE_FLOATS;
    for (let i = 0; i < components; i++) {
      target[slot + i] = list[element * components + i] ?? 0;
    }
  }
}

// A scalar lane. `bool` is stored as an f32 flag (1/0) and `int` as a rounded i32 — both of which the
// caller can only know from `godotType`, since both arrive here as plain JS numbers.
function scalarOf(
  raw: PackedParamValue | undefined,
  godotType: string,
): number {
  const value =
    typeof raw === "number" ? raw : Array.isArray(raw) ? (raw[0] ?? 0) : 0;
  if (godotType === "bool") return value ? 1 : 0;
  if (godotType === "int") return Math.round(value);
  return value;
}

// The flat component list for an array uniform, with the one wire-format correction the GL path also
// makes: Godot serialises a `PackedColorArray` as RGBA quads, so a `vec3[]` fed from one arrives with
// an alpha component per element that has to be dropped (`normalizeVec3ArrayUniformValues`).
function normalizeArrayValues(
  raw: PackedParamValue | undefined,
  field: WgslUniformField,
  paramKind: string | undefined,
): number[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "number" ? [raw] : [];
  if (
    field.type === "vec3f" &&
    paramKind === PACKED_COLOR_ARRAY &&
    list.length % 4 === 0
  ) {
    const out: number[] = [];
    for (let i = 0; i < list.length; i += 4) {
      out.push(list[i] ?? 0, list[i + 1] ?? 0, list[i + 2] ?? 0);
    }
    return out;
  }
  return list;
}

function writeFloats(
  staging: UniformStaging,
  offsetBytes: number | undefined,
  values: readonly number[] | undefined,
  count: number,
): void {
  if (offsetBytes === undefined) return;
  const base = offsetBytes / 4;
  for (let i = 0; i < count; i++) staging.floats[base + i] = values?.[i] ?? 0;
}
