import {
  asNumber,
  asResourceRef,
  asString,
  type GodotNode,
  type GodotResourceRefValue,
  type GodotVariant,
} from "@godot-scene-web/core";
import {
  type ColorMatrix,
  colorMatrixIsIdentity,
  safeClassSegment,
} from "./css-values";
import { createStringLru } from "./lru";
import { imageResource, normalizeResource } from "./resources";
import type { GodotHtmlRenderOptions, GodotResolvedResource } from "./types";
import type {
  CurvePoint,
  GradientStop,
  TextureBakeSpec,
} from "./webgl/bake-texture";

export function assignMaterialAttributes(
  attributes: Record<string, string>,
  style: Record<string, string>,
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
  nodePath?: string,
): void {
  const materialRef = asResourceRef(props.material);
  if (!materialRef) {
    return;
  }
  const material = normalizeResource(
    options.resolveResource?.(materialRef, source),
  );
  const type = resourceType(material);
  if (!type) {
    return;
  }
  const materialProperties = effectiveShaderMaterialProperties(
    material?.document?.properties ?? {},
    props,
  );
  attributes["data-godot-material-type"] = type;
  if (material?.path) {
    attributes["data-godot-material-path"] = material.path;
  }

  const blendMode = asNumber(material?.document?.properties.blend_mode);
  if (blendMode !== undefined) {
    attributes["data-godot-material-blend-mode"] = String(blendMode);
    attributes["data-godot-material-blend-mode-name"] =
      canvasItemBlendModeName(blendMode);
    // CanvasItemMaterial BLEND_MODE_ADD -> CSS additive compositing. Placed on
    // the node's OUTER element, not the self-layer: the outer element carries
    // the node's transform/opacity/z-index, and a transform there would create
    // a stacking context that isolates a self-layer blend against an empty
    // backdrop — while a transform on the blended element itself does not
    // block its own blending. Divergence from the engine: in Godot the
    // material affects only the item's own drawing, whereas mix-blend-mode
    // also composites the node's CHILDREN additively; additive nodes are in
    // practice leaf paint nodes (glow NinePatchRects/Sprites), so this is
    // acceptable. Other blend modes (subtract/multiply/...) have no faithful
    // CSS equivalent and stay inert data attributes.
    if (type === "CanvasItemMaterial" && blendMode === 1) {
      style["mix-blend-mode"] = "plus-lighter";
    }
  }

  const shaderRef = asResourceRef(material?.document?.properties.shader);
  if (shaderRef) {
    attributes["data-godot-shader-ref"] =
      `${shaderRef.type}:${shaderRef.id ?? shaderRef.path}`;
    const { path, uid } = resolveShaderIdentity(
      material,
      shaderRef,
      source,
      options,
    );
    if (path) {
      attributes["data-godot-shader-path"] = path;
    }
    if (uid) {
      attributes["data-godot-shader-uid"] = uid;
    }
    // Live WebGL runtime opt-in: flag ShaderMaterial nodes and emit the runtime's
    // inputs (shader params + node modulate). The runtime fetches `path`/`uid`
    // source, transpiles, and — on success — replaces this node's CSS/SVG paint
    // with a canvas; unresolved or unsupported shaders keep their fallback.
    if (
      options.enableWebglShaders &&
      (path || uid) &&
      isWebglShaderEnabled(options, nodePath, path, uid)
    ) {
      attributes["data-godot-shader-webgl"] = "1";
      const params = shaderParams(materialProperties);
      attributes["data-godot-shader-params"] = JSON.stringify(params);
      const paramKinds = shaderParamKinds(materialProperties);
      if (paramKinds) {
        attributes["data-godot-shader-param-kinds"] =
          JSON.stringify(paramKinds);
      }
      attributes["data-godot-shader-modulate"] =
        combinedModulate(props).join(",");
      // Procedural sampler inputs (e.g. a noise field + gradient ramp): serialize a
      // pixel-free bake spec per `shader_parameter/<sampler>` SubResource so the
      // live runtime (the only place with a canvas) can realize the pixels.
      const samplers = samplerBakeSpecs(material, source, options);
      if (samplers) {
        attributes["data-godot-shader-samplers"] = JSON.stringify(samplers);
      }
      const samplerUrls = samplerImageUrls(material, source, options);
      if (samplerUrls) {
        attributes["data-godot-shader-sampler-urls"] =
          JSON.stringify(samplerUrls);
      }
    }
  }

  for (const [name, value] of Object.entries(materialProperties)) {
    if (!name.startsWith("shader_parameter/")) {
      continue;
    }
    attributes[
      `data-godot-shader-param-${safeClassSegment(name.slice("shader_parameter/".length))}`
    ] = godotValueLabel(value);
  }
}

/**
 * The exact linear RGB color transform produced by a node's `ShaderMaterial`,
 * or `undefined` when there is no material, the shader is not a recognized color
 * transform, or the transform is the identity (so a `v = 1.0` no-op stays
 * untouched). The consumer names which shaders are a standard HSV color adjust via
 * `hsvAdjustShaderIds`; other shaders are left as inert diagnostics, matching
 * `assignMaterialAttributes`.
 *
 * An HSV-adjust `fragment()` is linear (every step is a matrix/scalar multiply
 * with no offset), so the whole effect is one 3×3 matrix. We recover it by probing
 * the three RGB basis vectors through a literal port of that color math
 * (`applyHsv`) from the node's `h`/`s`/`v` `shader_parameter` values — this
 * sidesteps GLSL's mixed row/column conventions and Godot's column-major `mat3`.
 */
export function materialColorMatrix(
  attributes: Record<string, string>,
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): ColorMatrix | undefined {
  const materialRef = asResourceRef(props.material);
  if (!materialRef) {
    return undefined;
  }
  const material = normalizeResource(
    options.resolveResource?.(materialRef, source),
  );
  if (!material) {
    return undefined;
  }
  const shaderRef = asResourceRef(material.document?.properties.shader);
  if (!shaderRef) {
    return undefined;
  }
  const { path: shaderPath, uid: shaderUid } = resolveShaderIdentity(
    material,
    shaderRef,
    source,
    options,
  );
  if (
    !shaderIdListMatches(
      options.hsvAdjustShaderIds ?? [],
      shaderPath,
      shaderUid,
    )
  ) {
    attributes["data-godot-shader-tint"] = shaderPath
      ? `unhandled:${shaderPath}`
      : "unhandled";
    return undefined;
  }
  const params = effectiveShaderMaterialProperties(
    material.document?.properties ?? {},
    props,
  );
  const h = asNumber(params["shader_parameter/h"]) ?? 1;
  const s = asNumber(params["shader_parameter/s"]) ?? 1;
  const v = asNumber(params["shader_parameter/v"]) ?? 1;
  const matrix = hsvColorMatrix(h, s, v);
  if (colorMatrixIsIdentity(matrix)) {
    return undefined;
  }
  attributes["data-godot-shader-tint"] = "hsv";
  return matrix;
}

// Bake specs (numbers only — no pixels) for each `shader_parameter/<name>` that is
// a procedural texture SubResource (NoiseTexture2D / GradientTexture1D). The live
// runtime realizes these to RGBA via `webgl/bake-texture`. Nested SubResources
// (a NoiseTexture2D's `noise`, a GradientTexture1D's `gradient`) are resolved from
// the material document's own sub-resource table (an inline ShaderMaterial carries
// the full scene table), falling back to `resolveResource`.
function samplerBakeSpecs(
  material: GodotResolvedResource | undefined,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): Record<string, TextureBakeSpec> | undefined {
  const properties = material?.document?.properties ?? {};
  const subResources = material?.document?.subResources ?? [];
  const resolveSub = (
    ref: GodotResourceRefValue,
  ):
    | { type?: string; properties: Record<string, GodotVariant> }
    | undefined => {
    const local = subResources.find((entry) => entry.id === ref.id);
    if (local) return { type: local.type, properties: local.properties ?? {} };
    const resolved = normalizeResource(options.resolveResource?.(ref, source));
    if (resolved?.document) {
      return {
        type: resourceType(resolved),
        properties: resolved.document.properties ?? {},
      };
    }
    return undefined;
  };

  const out: Record<string, TextureBakeSpec> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (!name.startsWith("shader_parameter/")) continue;
    const ref = asResourceRef(value);
    if (ref?.type !== "SubResource") continue;
    const spec = bakeSpecFromResource(resolveSub(ref), resolveSub);
    if (spec) out[name.slice("shader_parameter/".length)] = spec;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function samplerImageUrls(
  material: GodotResolvedResource | undefined,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): Record<string, string> | undefined {
  const properties = material?.document?.properties ?? {};
  const extResources = material?.document?.extResources ?? [];
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (!name.startsWith("shader_parameter/")) continue;
    const ref = asResourceRef(value);
    if (!ref) continue;
    // An ExtResource id in a material's shader_parameters indexes the material
    // document's own ext-resource table, not the scene's — so attach its path
    // before resolving (mirrors resolveShaderIdentity). Without this, a sampler
    // bound to an external texture (e.g. an affliction's card-shape mask) fails
    // to resolve against the node's scene and is dropped, leaving it unbound.
    const ext = ref.id
      ? extResources.find((entry) => entry.id === ref.id)
      : undefined;
    const pathRef = ext?.path ? { ...ref, path: ext.path } : ref;
    const image = imageResource(
      normalizeResource(options.resolveResource?.(pathRef, source)),
      options,
      source,
    );
    if (image.url) {
      out[name.slice("shader_parameter/".length)] = image.url;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function bakeSpecFromResource(
  sub: { type?: string; properties: Record<string, GodotVariant> } | undefined,
  resolveSub: (
    ref: GodotResourceRefValue,
  ) => { type?: string; properties: Record<string, GodotVariant> } | undefined,
): TextureBakeSpec | undefined {
  if (!sub) return undefined;
  if (sub.type === "GradientTexture1D") {
    const gradientRef = asResourceRef(sub.properties.gradient);
    const gradient = gradientRef ? resolveSub(gradientRef) : undefined;
    const stops = gradientStops(gradient?.properties ?? {});
    if (stops.length === 0) return undefined;
    return {
      kind: "gradient",
      width: asNumber(sub.properties.width) ?? 256,
      stops,
    };
  }
  if (sub.type === "NoiseTexture2D") {
    const noiseRef = asResourceRef(sub.properties.noise);
    const np = (noiseRef ? resolveSub(noiseRef) : undefined)?.properties ?? {};
    return {
      kind: "noise",
      width: asNumber(sub.properties.width) ?? 512,
      height: asNumber(sub.properties.height) ?? 512,
      seamless: sub.properties.seamless === true,
      // Godot FastNoiseLite enums/defaults (TYPE_PERLIN=3, FRACTAL_FBM=1).
      noiseType: asNumber(np.noise_type) ?? 3,
      frequency: asNumber(np.frequency) ?? 0.01,
      fractalType: asNumber(np.fractal_type) ?? 1,
      octaves: asNumber(np.fractal_octaves) ?? 5,
      lacunarity: asNumber(np.fractal_lacunarity) ?? 2,
      gain: asNumber(np.fractal_gain) ?? 0.5,
      seed: asNumber(np.seed) ?? 0,
    };
  }
  if (sub.type === "CurveTexture") {
    const curveRef = asResourceRef(sub.properties.curve);
    const curve = curveRef ? resolveSub(curveRef) : undefined;
    return {
      kind: "curve",
      width: asNumber(sub.properties.width) ?? 256,
      channels: [curvePoints(curve?.properties ?? {})],
    };
  }
  if (sub.type === "CurveXYZTexture") {
    const channels = ["curve_x", "curve_y", "curve_z"].map((name) => {
      const curveRef = asResourceRef(sub.properties[name]);
      const curve = curveRef ? resolveSub(curveRef) : undefined;
      return curvePoints(curve?.properties ?? {});
    });
    return {
      kind: "curve",
      width: asNumber(sub.properties.width) ?? 256,
      channels,
    };
  }
  return undefined;
}

export function curvePoints(
  properties: Record<string, GodotVariant>,
): CurvePoint[] {
  const items = variantItems(properties._data);
  const points: CurvePoint[] = [];
  for (const item of items) {
    const point = vector2Point(item);
    if (point) points.push(point);
  }
  return points;
}

function variantItems(value: GodotVariant): unknown[] {
  if (Array.isArray(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    "args" in value &&
    Array.isArray((value as { args?: unknown[] }).args)
  ) {
    return (value as { args: unknown[] }).args;
  }
  return [];
}

function vector2Point(value: unknown): CurvePoint | undefined {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    "args" in value &&
    (value as { type?: unknown }).type === "Vector2" &&
    Array.isArray((value as { args?: unknown[] }).args)
  ) {
    const args = (value as { args: unknown[] }).args;
    const x = asNumber(args[0] as GodotVariant);
    const y = asNumber(args[1] as GodotVariant);
    if (x !== undefined && y !== undefined) return { x, y };
  }
  return undefined;
}

function gradientStops(
  properties: Record<string, GodotVariant>,
): GradientStop[] {
  const offsets = packedArgs(properties.offsets);
  const colors = packedArgs(properties.colors);
  const stops: GradientStop[] = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const c = i * 4;
    stops.push({
      offset: offsets[i],
      color: [
        colors[c] ?? 0,
        colors[c + 1] ?? 0,
        colors[c + 2] ?? 0,
        colors[c + 3] ?? 1,
      ],
    });
  }
  return stops;
}

// The numeric components of a PackedFloat32Array / PackedColorArray variant
// (`{ type, args }`).
function packedArgs(value: GodotVariant): number[] {
  if (
    value &&
    typeof value === "object" &&
    "args" in value &&
    Array.isArray((value as { args?: unknown[] }).args)
  ) {
    return (value as { args: unknown[] }).args.filter(
      (x): x is number => typeof x === "number",
    );
  }
  return [];
}

// The node modulate·self_modulate as RGBA floats (0..1) — the shader `MODULATE`
// the WebGL runtime feeds in (Godot applies this to a canvas_item's COLOR).
function combinedModulate(
  props: Record<string, GodotVariant>,
): [number, number, number, number] {
  const out: [number, number, number, number] = [1, 1, 1, 1];
  for (const value of [props.modulate, props.self_modulate]) {
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "Color" &&
      Array.isArray((value as { args?: unknown[] }).args)
    ) {
      const args = (value as { args: number[] }).args;
      out[0] *= args[0] ?? 1;
      out[1] *= args[1] ?? 1;
      out[2] *= args[2] ?? 1;
      out[3] *= args[3] ?? 1;
    }
  }
  return out;
}

// `shader_parameter/*` values keyed by the EXACT uniform name (number for scalars,
// component array for vectors) for the WebGL runtime.
function shaderParams(
  properties: Record<string, GodotVariant>,
): Record<string, number | number[]> {
  const out: Record<string, number | number[]> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (!name.startsWith("shader_parameter/")) {
      continue;
    }
    const key = name.slice("shader_parameter/".length);
    const scalar = asNumber(value);
    if (scalar !== undefined) {
      out[key] = scalar;
      continue;
    }
    // A `uniform bool` param (e.g. an InvertNoiseMask toggle) is authored as a JSON
    // boolean; serialize it as 0/1 so the runtime's `uniform1i` upload sees it —
    // dropping it silently flipped such toggles to `false` on the GPU.
    if (typeof value === "boolean") {
      out[key] = value ? 1 : 0;
      continue;
    }
    if (
      value &&
      typeof value === "object" &&
      "args" in value &&
      Array.isArray((value as { args?: unknown[] }).args)
    ) {
      const args = (value as { args: unknown[] }).args.filter(
        (x): x is number => typeof x === "number",
      );
      if (args.length > 0) {
        out[key] = args;
      }
    }
  }
  return out;
}

function effectiveShaderMaterialProperties(
  materialProperties: Record<string, GodotVariant>,
  props: Record<string, GodotVariant>,
): Record<string, GodotVariant> {
  let merged: Record<string, GodotVariant> | undefined;
  for (const [name, value] of Object.entries(props)) {
    if (!name.startsWith("shader_parameter/")) {
      continue;
    }
    merged ??= { ...materialProperties };
    const materialValue = materialProperties[name];
    if (
      Array.isArray(value) &&
      materialValue &&
      typeof materialValue === "object" &&
      "type" in materialValue &&
      typeof (materialValue as { type?: unknown }).type === "string"
    ) {
      merged[name] = {
        ...(materialValue as Record<string, unknown>),
        args: value,
      } as GodotVariant;
    } else {
      merged[name] = value;
    }
  }
  return merged ?? materialProperties;
}

function shaderParamKinds(
  properties: Record<string, GodotVariant>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (!name.startsWith("shader_parameter/")) {
      continue;
    }
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      typeof (value as { type?: unknown }).type === "string"
    ) {
      out[name.slice("shader_parameter/".length)] = (
        value as { type: string }
      ).type;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Whether a node carries a `ShaderMaterial` with a resolvable shader (path/uid).
 */
export function isShaderMaterialNode(
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): boolean {
  const materialRef = asResourceRef(props.material);
  if (!materialRef) {
    return false;
  }
  const material = normalizeResource(
    options.resolveResource?.(materialRef, source),
  );
  if (resourceType(material) !== "ShaderMaterial") {
    return false;
  }
  const shaderRef = asResourceRef(material?.document?.properties.shader);
  if (!shaderRef) {
    return false;
  }
  const { path, uid } = resolveShaderIdentity(
    material,
    shaderRef,
    source,
    options,
  );
  return Boolean(path || uid);
}

/**
 * Whether a node's `ShaderMaterial` is opted into the WebGL runtime. This is
 * generic renderer metadata: node path, shader path, or shader uid. No project or
 * shader name is recognized implicitly.
 */
export function isWebglShaderMaterialNode(
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
  nodePath?: string,
): boolean {
  if (!options.enableWebglShaders) {
    return false;
  }
  const materialRef = asResourceRef(props.material);
  if (!materialRef) {
    return false;
  }
  const material = normalizeResource(
    options.resolveResource?.(materialRef, source),
  );
  if (resourceType(material) !== "ShaderMaterial") {
    return false;
  }
  const shaderRef = asResourceRef(material?.document?.properties.shader);
  if (!shaderRef) {
    return false;
  }
  const { path, uid } = resolveShaderIdentity(
    material,
    shaderRef,
    source,
    options,
  );
  return (
    Boolean(path || uid) && isWebglShaderEnabled(options, nodePath, path, uid)
  );
}

function isWebglShaderEnabled(
  options: GodotHtmlRenderOptions,
  nodePath?: string,
  shaderPath?: string,
  shaderUid?: string,
): boolean {
  // An HSV-adjust shader is the sanctioned NON-WebGL color primitive: gsw bakes it to a static
  // `feColorMatrix` tint (`materialColorMatrix`), far cheaper than a per-node WebGL canvas and how both
  // render paths handle it. So a shader designated HSV-adjust is NEVER run on WebGL — even under a
  // `webglShaderIds: ["*"]` wildcard or a per-node opt-in. This is what makes "run every shader" safe: a
  // consumer can pass `["*"]` without HSV nodes getting a double paint (WebGL canvas + feColorMatrix tint).
  if (shaderIdListMatches(options.hsvAdjustShaderIds ?? [], shaderPath, shaderUid)) {
    return false;
  }
  if (nodePath) {
    if (options.shaderLoadingFallbacksByPath?.[nodePath]) return true;
    if (options.webglShaderNodesByPath?.[nodePath]) return true;
  }
  return shaderIdListMatches(
    options.webglShaderIds ?? [],
    shaderPath,
    shaderUid,
  );
}

// Whether a shader-id list (`webglShaderIds` / `hsvAdjustShaderIds` / …) selects a
// node's shader. An entry matches by exact resource path or uid, by `"*"` (every
// shader), or — when it ends in `/*` — by directory prefix on the path (e.g.
// `res://shaders/my_family/*` selects a whole shader family without enumerating
// every file).
export function shaderIdListMatches(
  ids: readonly string[],
  shaderPath?: string,
  shaderUid?: string,
): boolean {
  if (ids.includes("*")) return true;
  return ids.some((id) => {
    if (id.endsWith("/*")) {
      const prefix = id.slice(0, -1); // keep the trailing slash so it's a directory match
      return Boolean(shaderPath?.startsWith(prefix));
    }
    return id === shaderPath || id === shaderUid;
  });
}

// Whether a node's static (non-WebGL) shader paint should be suppressed (the raw
// texture beneath an activated WebGL canvas must not show through). Fully consumer-
// driven: by rendered node path (`hiddenRawShaderFallbacksByPath`) or by shader
// identity (`hiddenRawShaderFallbackShaderIds`, for a whole shader family).
export function isHiddenRawShaderFallbackMaterial(
  props: Record<string, GodotVariant>,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
  nodePath?: string,
): boolean {
  if (!options.enableWebglShaders) {
    return false;
  }
  if (nodePath && options.hiddenRawShaderFallbacksByPath?.[nodePath] === true) {
    return true;
  }
  const ids = options.hiddenRawShaderFallbackShaderIds ?? [];
  if (ids.length === 0) {
    return false;
  }
  const materialRef = asResourceRef(props.material);
  if (!materialRef) {
    return false;
  }
  const material = normalizeResource(
    options.resolveResource?.(materialRef, source),
  );
  if (resourceType(material) !== "ShaderMaterial") {
    return false;
  }
  const shaderRef = asResourceRef(material?.document?.properties.shader);
  if (!shaderRef) {
    return false;
  }
  const { path, uid } = resolveShaderIdentity(
    material,
    shaderRef,
    source,
    options,
  );
  return shaderIdListMatches(ids, path, uid);
}

/**
 * The shader's `res://` path and uid. The live presentation glue resolves a
 * `Shader` ExtResource to `undefined` (shaders are not bundled assets), so the
 * authoritative source is the material document's ext-resource table. A
 * path-first ref (a runtime producer emits `{type:"ExtResource", path}` with no
 * table) carries its own identity. Only then fall back to `resolveResource`
 * (used by unit tests / hosts that surface a path).
 */
function resolveShaderIdentity(
  material: GodotResolvedResource | undefined,
  shaderRef: GodotResourceRefValue,
  source: GodotNode,
  options: GodotHtmlRenderOptions,
): { path: string | undefined; uid: string | undefined } {
  const ext = material?.document?.extResources?.find(
    (entry) => entry.id === shaderRef.id,
  );
  const path =
    ext?.path ??
    shaderRef.path ??
    (
      material?.shader ??
      normalizeResource(options.resolveResource?.(shaderRef, source))
    )?.path;
  return { path, uid: ext?.uid };
}

// Memo for `hsvColorMatrix` (module-scoped LRU, like `webgl/runtime`'s staticFrameCache).
// WHY: the matrix is a 3× basis probe through `applyHsv` — 9 mat3 multiplies plus 9 `denoise`
// rounds — and it is recomputed for EVERY hsv-adjust node on EVERY render, from a tiny set of
// distinct (h,s,v) triples (phone traces put ~28% of a play-a-card burst inside this math).
// Keyed on the EXACT inputs (no quantization) so a hit is byte-identical to a fresh compute;
// the returned `ColorMatrix` has `readonly` rows, so sharing one instance is safe.
const HSV_COLOR_MATRIX_CACHE_LIMIT = 64;
const hsvColorMatrixCache = createStringLru<ColorMatrix>(
  HSV_COLOR_MATRIX_CACHE_LIMIT,
);

// Exact, round-trippable key part. `String` collapses -0 to "0", so spell it out: -0 and 0
// are different inputs (they propagate to differently-signed zeros in the output rows).
function hsvKeyPart(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/** TEST-ONLY: clear the HSV color-matrix memo so a test starts from an empty cache. */
export function __resetHsvColorMatrixCacheForTest(): void {
  hsvColorMatrixCache.clear();
}

/**
 * The 3×3 matrix realizing a standard HSV color adjust. Recovered by probing the
 * RGB basis vectors through `applyHsv`; the constant column is `0` because the
 * transform is linear (black maps to black). Memoized (see the LRU above) — pure,
 * so a hit is indistinguishable from a fresh compute.
 */
export function hsvColorMatrix(h: number, s: number, v: number): ColorMatrix {
  const key = `${hsvKeyPart(h)}|${hsvKeyPart(s)}|${hsvKeyPart(v)}`;
  const hit = hsvColorMatrixCache.get(key);
  if (hit) {
    return hit;
  }
  const c0 = applyHsv([1, 0, 0], h, s, v);
  const c1 = applyHsv([0, 1, 0], h, s, v);
  const c2 = applyHsv([0, 0, 1], h, s, v);
  const matrix: ColorMatrix = {
    rows: [
      [denoise(c0[0]), denoise(c1[0]), denoise(c2[0])],
      [denoise(c0[1]), denoise(c1[1]), denoise(c2[1])],
      [denoise(c0[2]), denoise(c1[2]), denoise(c2[2])],
    ],
  };
  hsvColorMatrixCache.set(key, matrix);
  return matrix;
}

// Erase the ~1e-16 float noise the YIQ round-trip leaves behind (it is far
// finer than any meaningful per-channel difference) so identity/diagonal cases
// land on exact values — e.g. v=0.9 stays 0.9, not 0.8999999999999999, which
// otherwise straddles the 0.9*255=229.5 byte-rounding boundary.
function denoise(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

type Vec3 = [number, number, number];
// A `mat3` in GLSL's column-major form: `mat3(col0, col1, col2)`.
type Mat3 = [Vec3, Vec3, Vec3];

// The standard RGB→YIQ basis the HSV-adjust shader uses, and its inverse. Both are
// CONSTANTS: the inverse used to be recomputed (a full cofactor/determinant pass) on every
// `applyHsv` call — i.e. three times per `hsvColorMatrix`, per node, per render.
const RGB_TO_YIQ: Mat3 = [
  [0.2989, 0.5959, 0.2115],
  [0.587, -0.2774, -0.5229],
  [0.114, -0.3216, 0.3114],
];
const YIQ_TO_RGB: Mat3 = mat3Inverse(RGB_TO_YIQ);

/**
 * A statement-by-statement port of the standard HSV-adjust `fragment()` color math
 * for a single input RGB (modulate excluded — it is composed separately as the outer
 * diagonal in `textures.ts`). Kept literal so the basis-probe matrix is exact
 * regardless of GLSL convention.
 */
export function applyHsv(rgb: Vec3, h: number, s: number, v: number): Vec3 {
  let col: Vec3 = [rgb[0], rgb[1], rgb[2]];

  // col.rgb = RGB_to_YIQ * col.rgb
  col = mat3MulVec(RGB_TO_YIQ, col);

  // hue = mix(0, TAU, 1.0 - h)
  const hue = (1.0 - h) * 6.283185;
  const sinHue = Math.sin(hue);
  const cosHue = Math.cos(hue);
  const hueShift: Mat3 = [
    [1.0, 0, 0],
    [0, cosHue, -sinHue],
    [0, sinHue, cosHue],
  ];
  // col.rgb *= hue_shift  (GLSL row-vector × matrix)
  col = vecMulMat3(col, hueShift);

  const satShift: Mat3 = [
    [1.0, 0, 0],
    [0, s, 0],
    [0, 0, s],
  ];
  // col.rgb = sat_shift * col.rgb
  col = mat3MulVec(satShift, col);

  // col.rgb = mix(vec3(0), col.rgb, v)
  col = [col[0] * v, col[1] * v, col[2] * v];

  // col.rgb = inverse(RGB_to_YIQ) * col.rgb
  col = mat3MulVec(YIQ_TO_RGB, col);

  return col;
}

// `m * v`: column-major `m`, so `m[k]` is column k. result = Σ_k v[k] · m[k].
function mat3MulVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
    m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
    m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
  ];
}

// `v * m` (GLSL row-vector × matrix): result[j] = dot(v, m[j]) (column j).
function vecMulMat3(v: Vec3, m: Mat3): Vec3 {
  return [
    v[0] * m[0][0] + v[1] * m[0][1] + v[2] * m[0][2],
    v[0] * m[1][0] + v[1] * m[1][1] + v[2] * m[1][2],
    v[0] * m[2][0] + v[1] * m[2][1] + v[2] * m[2][2],
  ];
}

// Inverse of a column-major `mat3`, returned in the same column-major form.
function mat3Inverse(m: Mat3): Mat3 {
  // Element accessor in row/col terms: a(row, col) = m[col][row].
  const a = (row: number, col: number): number => m[col][row];
  const c00 = a(1, 1) * a(2, 2) - a(1, 2) * a(2, 1);
  const c01 = a(1, 2) * a(2, 0) - a(1, 0) * a(2, 2);
  const c02 = a(1, 0) * a(2, 1) - a(1, 1) * a(2, 0);
  const det = a(0, 0) * c00 + a(0, 1) * c01 + a(0, 2) * c02;
  const invDet = det !== 0 ? 1 / det : 0;
  // inv(row, col) = cofactor(col, row) / det.
  const inv = (row: number, col: number): number => {
    const r0 = (col + 1) % 3;
    const r1 = (col + 2) % 3;
    const c0 = (row + 1) % 3;
    const c1 = (row + 2) % 3;
    return (a(r0, c0) * a(r1, c1) - a(r0, c1) * a(r1, c0)) * invDet;
  };
  // Pack back into column-major columns.
  return [
    [inv(0, 0), inv(1, 0), inv(2, 0)],
    [inv(0, 1), inv(1, 1), inv(2, 1)],
    [inv(0, 2), inv(1, 2), inv(2, 2)],
  ];
}

function canvasItemBlendModeName(blendMode: number): string {
  switch (blendMode) {
    case 0:
      return "mix";
    case 1:
      return "add";
    case 2:
      return "subtract";
    case 3:
      return "multiply";
    case 4:
      return "premultiplied-alpha";
    case 5:
      return "disabled";
    default:
      return "unknown";
  }
}

function resourceType(
  resource: GodotResolvedResource | undefined,
): string | undefined {
  return (
    resource?.type ?? asString(resource?.document?.header?.attributes.type)
  );
}

function godotValueLabel(value: GodotVariant): string {
  if (value === null) {
    return "null";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(godotValueLabel).join(", ")}]`;
  }
  if (typeof value === "object" && "type" in value) {
    const record = value as Record<string, unknown>;
    if (
      (record.type === "ExtResource" || record.type === "SubResource") &&
      (typeof record.id === "string" || typeof record.path === "string")
    ) {
      return `${record.type}(${record.id ?? record.path})`;
    }
    // Every other variant is the uniform `{ type, args }` shape (Vector/Color/
    // Rect/StringName/NodePath and arbitrary constructors).
    if (typeof record.type === "string" && Array.isArray(record.args)) {
      return `${record.type}(${(record.args as GodotVariant[]).map(godotValueLabel).join(", ")})`;
    }
  }
  return JSON.stringify(value);
}
