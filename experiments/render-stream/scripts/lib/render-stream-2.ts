// render-stream/2 wire decoder, validator and resolver: pure over Uint8Array, no file or network
// I/O. render-stream/2 is render-stream/1 plus textures.
//
// The wire format (record framing, the new u8 block type, canonical JSON key order, float32 LE
// blocks, the render-stream-texture/1 payload format) is specified in
// ../../protocol/render-stream-2.md, which extends render-stream-1.md and, through it,
// render-stream-0.md. This must agree with it byte for byte, and with the C++ encoder/diff
// (../../capture/src/rs2_codec.cpp, rs2_diff.cpp) and the shared Rust core (../../rs-core). The
// golden vectors in ../../protocol/golden-2/ are shared by all three. (Until G7gd a GDScript
// decoder, receiver/rs2_decoder.gd, was the third reader; this one is the independent oracle.)
//
// Structure mirrors render-stream-1.ts: splitRecords()/decodeRecord()/decodeRecording() extended
// for the new "resource" record type and the u8 block (which decodes to
// {"u8_bytes","sha256"} rather than an array of numbers -- render-stream-2.md "Decoded and
// resolved forms"). validateRecording() resolves every transaction against a running state
// (canvases, items AND textures now) to check cross-record invariants, including the new
// texture-entry/texture-ref/texture-version/resource-* codes. resolveRecording() reuses the same
// merge engine and additionally returns the stream's resource records in order.
//
// This file holds no texture-payload ENCODER: render-stream-texture/1 payloads are built
// elsewhere (the capture's rs_texture_payload, G2a). decodeTexturePayload()/payloadSha256()/
// expectedDataBytes() below are the read side, needed to validate `resource` records and
// `payloads/*.grt` golden vectors.
//
// render-stream/3 (../../protocol/render-stream-3.md, G4e1), render-stream/4
// (../../protocol/render-stream-4.md, G5w) and render-stream/5 (../../protocol/render-stream-5.md,
// G55w) are implemented IN THIS SAME FILE behind an explicit `version: 2 | 3 | 4 | 5 | 6 | 7` parameter
// on every exported entry point (splitRecords/decodeRecording/validateRecording/
// resolveRecording), rather than forked render-stream-3.ts/-4.ts/-5.ts modules -- /3 is /2 plus
// one draw command (add_msdf_texture_rect_region) and one sabotage kind (perturb-glyph), /4 is /3
// plus eleven new commands, a mesh table and the cmd_i32 block, and /5 is /4 plus a shader table,
// a material table, canvas modulate, item material/use_parent_material/instance_params and the
// param_f64 (f64) block -- too small a delta each (gate4-design.md G4e1: "Renaming files is not
// part of this contract") to justify duplicating this module. `version` selects the expected
// magic (GRS2..GRS6) and the decoded/resolved schema strings. Since G6b the capture, the receiver
// and every gate checker speak /6 (/5 from G55d to G6b, /4 from G5d to G55d, /3 from G4e2 to
// G5d), so the parameter defaults to 6; /2 to /5 decoding remain only for golden-2/ to golden-5/
// (self-test-rs2.ts passes 2..6 explicitly per golden directory). Every new command, sabotage kind, the mesh table and the shader/material
// tables are always representable regardless of `version` -- an older stream simply never
// contains them in practice, since the capture never emits them below its own version.
//
// The mesh payload format (render-stream-mesh/1, GRM1) and the shader payload format
// (render-stream-shader/1, GRP1) each have their own module (render-stream-mesh.ts,
// render-stream-shader.ts), parallel to how render-stream-texture/1 (GRT1) decode lives in THIS
// file (decodeTexturePayload() below) rather than a separate one -- G5w's contract (carried
// forward by G55w) calls for a new file per NEW payload format, to keep the payload-format growth
// out of this already-large module.

import {
  type DecodedMeshPayload,
  decodeMeshPayload,
  GRM1_MAGIC,
} from "./render-stream-mesh";
import {
  type DecodedShaderPayload,
  decodeShaderPayload,
  GRP1_MAGIC,
} from "./render-stream-shader";
import { type HashFn, sha256Hex } from "./sha256";

// --------------------------------------------------------------------------------------- wire types

export type Origin = "created" | "root-query" | "adopted";
export type CanvasRole = "root" | null;
export type ParentKind = "canvas" | "item";
export type TransactionStatus = "ok" | "capture-failure";
export type FailureReason =
  | "root-query-failed"
  | "pre-existing-object"
  | "mirror-capacity"
  | "root-size-enforce-failed";
export type UnsupportedReason =
  | "unsupported-op"
  | "unsupported-state"
  | "non-root-viewport"
  | "extra-canvas"
  | "draw-index-tie"
  | "degenerate-host-size"
  | "unknown-texture"
  | "unsupported-texture"
  | "canvas-texture-headless"
  | "unknown-mesh"
  | "skinned-geometry"
  | "unsupported-mesh"
  | "unsupported-material"
  | "unknown-material"
  | "param-type"
  | "canvas-light"
  | "canvas-stacking-tie"
  | "canvas-repeat"
  | "canvas-follow-viewport"
  | "global-canvas-transform"
  | "snap-2d";
/** canvas-texture-headless (G2d): a texture draw naming RID() on a headless host, whose dummy
 * storage never allocates a canvas texture (protocol/canvas-texture-headless.md).
 * unknown-mesh/skinned-geometry: new at /4 (render-stream-4.md "Command"). */
export type UnsupportedCmdReason =
  | "unsupported-op"
  | "unknown-texture"
  | "canvas-texture-headless"
  | "unknown-mesh"
  | "skinned-geometry";
export type SabotageKind =
  | "freeze-frame"
  | "omit-update"
  | "perturb-transform"
  | "omit-op"
  | "patch-drop-item"
  | "drop-message"
  | "ignore-credit"
  | "stale-coalesce"
  | "stale-texture"
  | "wrong-hash"
  | "spurious-texture-update"
  | "drop-resource"
  | "unpin"
  | "perturb-glyph"
  | "perturb-vertex"
  | "perturb-shader"
  | "retain-superseded";
export type EndReason = "shutdown" | "disarm";
export type Transport = "file" | "websocket";
export type Encoding = "full" | "patch";
export type StretchMode = "disabled" | "canvas_items" | "viewport";
export type StretchAspect =
  | "ignore"
  | "keep"
  | "keep_width"
  | "keep_height"
  | "expand";
export type ScaleMode = "fractional" | "integer";
export type RootSizePolicy = "observe" | "enforce-min-size" | "presentation";
export type HostSizeStatus =
  | "match"
  | "degenerate-visible"
  | "degenerate-window";
// --- new at /6 (render-stream-6.md "Publication") ----------------------------------------------
export type PublicationMode = "every-frame" | "rate";

export type Filter =
  | "default"
  | "nearest"
  | "linear"
  | "nearest_mipmaps"
  | "linear_mipmaps"
  | "nearest_mipmaps_anisotropic"
  | "linear_mipmaps_anisotropic";
export type Repeat = "default" | "disabled" | "enabled" | "mirror";
export type Delivery = "out-of-band" | "inline" | "mixed";
export type Fetch = "http" | "directory" | "none";
export type Auth = "none" | "bearer";
export type TextureKind = "image" | "placeholder" | "canvas";
export type TextureStatus = "ok" | "unsupported" | "freed";
export type TextureReason =
  | "unsupported-format"
  | "payload-too-large"
  | "payload-unavailable"
  | "update-shape-mismatch"
  | "layered-update"
  | "unknown-texture"
  | "canvas-texture-channel";

/** render-stream-4.md "Command": add_nine_patch's per-axis stretch mode. */
export type AxisStretchMode = "stretch" | "tile" | "tile_fit";
/** render-stream-4.md "Mesh payload": the five RenderingServer 2D primitive types. */
export type Primitive =
  | "points"
  | "lines"
  | "line_strip"
  | "triangles"
  | "triangle_strip";
export type MeshStatus = "ok" | "unsupported" | "freed";
export type MeshReason =
  | "mesh-format"
  | "mesh-blend-shapes"
  | "payload-too-large";

// --- new at /5 (render-stream-5.md "Shader table"/"Material table", gate5_5-design.md D8) -----

/** The Variant type names a material or instance-shader param may carry on the wire, plus the
 * numeric packed array types. As built (G55w): these wire spellings (snake_case, matching the
 * engine's own type names) are this codec's own decision -- see render-stream-5.md "As built". */
export type VariantType =
  | "nil"
  | "bool"
  | "int"
  | "float"
  | "vector2"
  | "vector2i"
  | "rect2"
  | "rect2i"
  | "vector3"
  | "vector3i"
  | "transform2d"
  | "vector4"
  | "vector4i"
  | "plane"
  | "quaternion"
  | "aabb"
  | "basis"
  | "transform3d"
  | "projection"
  | "color"
  | "rid"
  | "packed_int32_array"
  | "packed_int64_array"
  | "packed_float32_array"
  | "packed_float64_array"
  | "packed_vector2_array"
  | "packed_vector3_array"
  | "packed_vector4_array"
  | "packed_color_array";
export type ShaderMode =
  | "canvas_item"
  | "spatial"
  | "particles"
  | "sky"
  | "fog";
export type ShaderStatus = "ok" | "unsupported";
export type ShaderReason =
  | "shader-mode"
  | "shader-screen-texture"
  | "shader-sdf"
  | "shader-time"
  | "shader-global-uniform"
  | "shader-excluded"
  | "payload-too-large"
  | "payload-unavailable";
export type ShaderUse =
  | "global_uniform"
  | "instance_uniform"
  | "light"
  | "screen_texture"
  | "sdf"
  | "time";
export type ShaderSource = "payload" | "withheld";
export type BlendMode =
  | "mix"
  | "add"
  | "sub"
  | "mul"
  | "premul_alpha"
  | "disabled";
export type LightMode = "normal" | "unshaded" | "light_only";
export type MaterialStatus = "ok" | "unsupported";
export type MaterialReason =
  | "unknown-shader"
  | "unknown-texture"
  | "param-type"
  | "param-range";
export type ShaderPolicy = "source" | "params" | "exclude";

export interface BuiltinCanvasItemMaterial {
  kind: "canvas_item_material";
  blend_mode: BlendMode;
  light_mode: LightMode;
  particles_animation: boolean;
}

export interface DefaultTextureRef {
  name: string;
  index: number;
  tex: number;
}

/** <param> on the wire (render-stream-5.md "Material table"). "f" is a running offset into
 * param_f64 over materials in table order, then items in item order. */
export interface TransactionParam {
  name: string;
  type: VariantType;
  n: number;
  tex: number | null;
  f: number;
}

export interface TransactionShader {
  id: number;
  origin: "created";
  status: ShaderStatus;
  reason: ShaderReason | null;
  version: number;
  mode: ShaderMode | null;
  source: ShaderSource | null;
  hash: string | null;
  payload_bytes: number;
  builtin: BuiltinCanvasItemMaterial | null;
  uses: ShaderUse[];
  default_textures: DefaultTextureRef[];
}

export interface TransactionMaterial {
  id: number;
  origin: "created";
  status: MaterialStatus;
  reason: MaterialReason | null;
  version: number;
  shader: number | null;
  params: TransactionParam[];
}

export interface BlockDescriptor {
  name: string;
  /** "i32" is new at /4 (render-stream-4.md "Block type i32"): legal only as a transaction's
   * fourth block, "cmd_i32". "f64" is new at /5 (render-stream-5.md "Block type f64"): legal
   * only as a transaction's sixth block, "param_f64". */
  type: "f32" | "u8" | "i32" | "f64";
  count: number;
}

export interface ResourcesMeta {
  hash: "sha256";
  /** V2/V3: a single payload-schema string. V4/V5 (render-stream-4.md "Resources";
   * render-stream-5.md "Session"): "payload" becomes "payloads", a sorted array of schema
   * strings (mesh, shader and texture share one resource policy at /5). */
  payload?: string;
  payloads?: string[];
  delivery: Delivery;
  inline_max_bytes: number;
  max_payload_bytes: number;
  permitted_formats: string[];
  fetch: Fetch;
  http_path: string | null;
  auth: Auth;
}

/** render-stream-5.md "Session": a new "materials" session key, right after "resources". */
export interface MaterialsMeta {
  shader_policy: ShaderPolicy;
}

export interface SessionMeta {
  type: "session";
  protocol: string;
  session_id: string;
  stream: {
    stream_id: string;
    connection: number | null;
    transport: Transport;
    encoding: Encoding;
  };
  engine: {
    version_string: string;
    sha256: string;
    display_server: string;
    rendering_driver: string;
    rendering_method: string;
  };
  capture: {
    calibrator_version: number;
    hooks_planned: string[];
    hooks_omitted: string[];
  };
  viewport: {
    canvas_cull_mask: number;
    root_canvas: number;
    logical_size: [number, number];
    stretch: {
      mode: StretchMode;
      aspect: StretchAspect;
      scale_mode: ScaleMode;
    };
    stretch_applied_by: "receiver";
    root_size_policy: RootSizePolicy;
    /** new at /6 (render-stream-6.md "Viewport"): present only when decoded at version 6, right
     * after root_size_policy. Equals logical_size unless root_size_policy is "presentation". */
    presentation_size?: [number, number];
    host_size_status: HostSizeStatus;
    host_window_size: [number, number];
    /** new at /6: Viewport.get_oversampling(), a float32 widened to a JSON number -- the only
     * JSON-embedded float this wire carries (render-stream-6.md "As built"). */
    font_oversampling?: number;
    /** new at /6 (gate6-design.md D17): the root's snap-to-pixel project settings. */
    snap_2d?: { transforms: boolean; vertices: boolean };
  };
  resources: ResourcesMeta;
  /** new at /5 (render-stream-5.md "Session"): present only when decoded at version 5. */
  materials?: MaterialsMeta;
  features: {
    ops: string[];
    item_state: string[];
    /** new at /5: present only when decoded at version 5, right after item_state. */
    canvas_state?: string[];
    resources: string[];
    /** G2d: resource kinds the host refuses, sorted by resource (a headless host:
     * canvas_texture, canvas-texture-headless). */
    unsupported_resources: Array<{ resource: string; reason: string }>;
    observed_unsupported_ops: string[];
    unobserved: string[];
    publication: string;
  };
  /** new at /6 (render-stream-6.md "Publication"): a new TOP-LEVEL session key, right after
   * `features` -- distinct from features.publication above. Present only when decoded at
   * version 6 or later. `credit_window` is new at /7 (render-stream-7.md "Session"), present only
   * when decoded at version 7. */
  publication?: {
    mode: PublicationMode;
    target_fps: number | null;
    credit_window?: number;
  };
  sabotage: { kind: SabotageKind; frame: number; op: string | null } | null;
  /** protocol/unknown-item-skip.md: present (always "skip") only in a session that opted into
   * skipping unknown canvas/item RIDs, right after `sabotage`, at /4 and /5. Absent = strict. */
  unknown_item_policy?: "skip";
  blocks: BlockDescriptor[];
}

/** protocol/unknown-item-skip.md "Transaction": what a skip session's transaction left out. */
export interface UnknownItemsMeta {
  /** unknown canvas/item RIDs named since arming and not yet freed */
  unknown_rids: number;
  /** known items withheld because their parent chain reaches an unknown RID */
  withheld_items: number;
  /** the commands those withheld items hold */
  withheld_commands: number;
  /** hook calls that named an unknown RID since arming (cumulative) */
  unknown_calls: number;
}

/** protocol/unknown-item-skip.md "Classification": a transaction whose state is missing
 * something (an unknown RID still live, or a withheld item) is `partial-unknown-items`, never
 * plain success. A strict transaction (no account) never is. */
export function isPartialUnknownItems(meta: {
  unknown_items?: UnknownItemsMeta;
}): boolean {
  const u = meta.unknown_items;
  return u !== undefined && u.unknown_rids + u.withheld_items > 0;
}

export interface CommandAddRect {
  op: "add_rect";
  aa: boolean;
  f: number;
}
export interface CommandAddTextureRect {
  op: "add_texture_rect";
  tex: number | null;
  tile: boolean;
  transpose: boolean;
  f: number;
}
export interface CommandAddTextureRectRegion {
  op: "add_texture_rect_region";
  tex: number | null;
  transpose: boolean;
  clip_uv: boolean;
  f: number;
}
/** render-stream-3.md "Command" (new at /3): tex/rect/src/modulate as add_texture_rect_region,
 * plus the engine's int outline_size, px_range and size/msdf_size scale. */
export interface CommandAddMsdfTextureRectRegion {
  op: "add_msdf_texture_rect_region";
  tex: number | null;
  outline: number;
  f: number;
}
export interface CommandUnsupported {
  op: "unsupported";
  name: string;
  reason: UnsupportedCmdReason;
}
// --- new at /4 (render-stream-4.md "Command") ------------------------------------------------
export interface CommandAddLine {
  op: "add_line";
  aa: boolean;
  f: number;
}
export interface CommandAddPolyline {
  op: "add_polyline";
  aa: boolean;
  n: number;
  colors: number;
  f: number;
}
export interface CommandAddMultiline {
  op: "add_multiline";
  aa: boolean;
  n: number;
  colors: number;
  f: number;
}
export interface CommandAddCircle {
  op: "add_circle";
  aa: boolean;
  f: number;
}
export interface CommandAddPrimitive {
  op: "add_primitive";
  tex: number | null;
  n: number;
  colors: number;
  uvs: number;
  f: number;
}
export interface CommandAddPolygon {
  op: "add_polygon";
  tex: number | null;
  n: number;
  colors: number;
  uvs: number;
  f: number;
}
export interface CommandAddTriangleArray {
  op: "add_triangle_array";
  tex: number | null;
  n: number;
  colors: number;
  uvs: number;
  indices: number;
  count: number;
  i: number;
  f: number;
}
export interface CommandAddNinePatch {
  op: "add_nine_patch";
  tex: number | null;
  x_axis: AxisStretchMode;
  y_axis: AxisStretchMode;
  draw_center: boolean;
  f: number;
}
export interface CommandAddMesh {
  op: "add_mesh";
  mesh: number;
  tex: number | null;
  f: number;
}
export interface CommandAddSetTransform {
  op: "add_set_transform";
  f: number;
}
export interface CommandAddClipIgnore {
  op: "add_clip_ignore";
  ignore: boolean;
}
export type Command =
  | CommandAddRect
  | CommandAddTextureRect
  | CommandAddTextureRectRegion
  | CommandAddMsdfTextureRectRegion
  | CommandAddLine
  | CommandAddPolyline
  | CommandAddMultiline
  | CommandAddCircle
  | CommandAddPrimitive
  | CommandAddPolygon
  | CommandAddTriangleArray
  | CommandAddNinePatch
  | CommandAddMesh
  | CommandAddSetTransform
  | CommandAddClipIgnore
  | CommandUnsupported;

export interface TransactionItem {
  id: number;
  origin: Origin;
  parent: { kind: ParentKind; id: number } | null;
  children: number[];
  visible: boolean;
  draw_index: number;
  z_index: number;
  z_relative: boolean;
  behind: boolean;
  clip: boolean;
  custom_rect: boolean;
  visibility_layer: number;
  texture_filter: Filter;
  texture_repeat: Repeat;
  /** new at /5 (render-stream-5.md "Item"): present only when decoded at version 5, in this
   * order, before content_version. */
  material?: number | null;
  use_parent_material?: boolean;
  instance_params?: TransactionParam[];
  content_version: number;
  commands: Command[] | null;
}

export interface TransactionCanvas {
  id: number;
  origin: Origin;
  role: CanvasRole;
  attached: boolean;
  /** new at /6 (render-stream-6.md "Canvas"): present only when decoded at version 6, right
   * after attached and before items. */
  layer?: number;
  sublayer?: number;
  items: number[];
}

export interface CanvasTextureMeta {
  diffuse: number | null;
  filter: Filter;
  repeat: Repeat;
}

export interface TransactionTexture {
  id: number;
  origin: "created";
  kind: TextureKind;
  status: TextureStatus;
  reason: TextureReason | null;
  version: number;
  hash: string | null;
  format: string | null;
  width: number;
  height: number;
  mipmaps: boolean;
  payload_bytes: number;
  canvas: CanvasTextureMeta | null;
}

/** render-stream-4.md "Mesh table": one mesh-table entry. `f` is null exactly for "freed". */
export interface TransactionMeshSurface {
  hash: string;
  payload_bytes: number;
  primitive: Primitive;
  format: number;
  vertex_count: number;
  index_count: number;
}
export interface TransactionMesh {
  id: number;
  origin: "created";
  status: MeshStatus;
  reason: MeshReason | null;
  version: number;
  f: number | null;
  surfaces: TransactionMeshSurface[];
}

export interface TransactionMeta {
  type: "transaction";
  seq: number;
  frame: number;
  encoding: Encoding;
  base_seq: number | null;
  status: TransactionStatus;
  failures: Array<{ reason: FailureReason; detail: string }>;
  unsupported: Array<{
    op: string;
    item: number | null;
    reason: UnsupportedReason;
  }>;
  /** protocol/unknown-item-skip.md: present exactly when the session declares
   * `unknown_item_policy: "skip"` (/4 and /5), right after `unsupported`. */
  unknown_items?: UnknownItemsMeta;
  default_texture_filter: Filter;
  default_texture_repeat: Repeat;
  removed_canvases: number[];
  removed_items: number[];
  removed_textures: number[];
  /** new at /4 (render-stream-4.md "Mesh table"): present only when decoded at version 4. */
  removed_meshes?: number[];
  /** new at /5: present only when decoded at version 5. */
  removed_shaders?: number[];
  removed_materials?: number[];
  canvases: TransactionCanvas[];
  items: TransactionItem[];
  textures: TransactionTexture[];
  /** new at /4: present only when decoded at version 4. */
  meshes?: TransactionMesh[];
  /** new at /5: present only when decoded at version 5. */
  shaders?: TransactionShader[];
  materials?: TransactionMaterial[];
  blocks: BlockDescriptor[];
}

export interface ResourceMeta {
  type: "resource";
  hash: string;
  bytes: number;
  blocks: BlockDescriptor[];
}

export interface EndMeta {
  type: "end";
  transactions: number;
  reason: EndReason;
  stats: {
    bytes_total: number;
    encode_ns_total: number;
    snapshot_ns_total: number;
    diff_ns_total: number;
    max_record_bytes: number;
    full_transactions: number;
    patch_transactions: number;
    resource_records: number;
    resource_bytes: number;
  };
  blocks: BlockDescriptor[];
}

export type Rs2Meta = SessionMeta | TransactionMeta | ResourceMeta | EndMeta;

// --------------------------------------------------------------------------------------- constants

export const MAGIC: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x32, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// render-stream-3.md: the GRS3 magic, selected by `version: 3` on splitRecords()/
// decodeRecording()/validateRecording()/resolveRecording(); the default since G4e2. MAGIC (GRS2)
// is selected by `version: 2` (golden-2/ only).
export const MAGIC_V3: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x33, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// render-stream-4.md: the GRS4 magic, selected by `version: 4` (golden-4/ only since G55d).
export const MAGIC_V4: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x34, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// render-stream-5.md: the GRS5 magic, selected by `version: 5` (golden-5/ only since G6b).
export const MAGIC_V5: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x35, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// render-stream-6.md: the GRS6 magic, selected by `version: 6` -- the default since G6b.
export const MAGIC_V6: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x36, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// render-stream-7.md: the GRS7 magic, selected by `version: 7` (golden-7/ only; /7 is a
// live-transport-only delta -- G7n keeps the capture and receiver speaking /6 by default).
export const MAGIC_V7: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x37, 0x0d, 0x0a, 0x1a, 0x0a,
]);
/** G7l: the wire version of a live stream's bytes: 7 when they start with GRS7 (a /7 receiver's
 * received.rs7, or a /7 connection's host tap), else 6 -- so every other magic still meets the
 * /6 decoder's own refusal, exactly as before. */
export function wireVersionOf(data: Uint8Array | undefined): 6 | 7 {
  if (!data || data.length < MAGIC_V7.length) return 6;
  for (let i = 0; i < MAGIC_V7.length; i++)
    if (data[i] !== MAGIC_V7[i]) return 6;
  return 7;
}
export const GRT1_MAGIC: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x54, 0x31, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const SESSION_KEYS = [
  "type",
  "protocol",
  "session_id",
  "stream",
  "engine",
  "capture",
  "viewport",
  "resources",
  "features",
  "sabotage",
  "blocks",
];
// render-stream-5.md "Session": a new "materials" key, right after "resources".
const SESSION_KEYS_V5 = [
  "type",
  "protocol",
  "session_id",
  "stream",
  "engine",
  "capture",
  "viewport",
  "resources",
  "materials",
  "features",
  "sabotage",
  "blocks",
];
// render-stream-6.md "Session": a new "publication" key, right after "features".
const SESSION_KEYS_V6 = [
  "type",
  "protocol",
  "session_id",
  "stream",
  "engine",
  "capture",
  "viewport",
  "resources",
  "materials",
  "features",
  "publication",
  "sabotage",
  "blocks",
];
const STREAM_KEYS = ["stream_id", "connection", "transport", "encoding"];
const ENGINE_KEYS = [
  "version_string",
  "sha256",
  "display_server",
  "rendering_driver",
  "rendering_method",
];
const CAPTURE_KEYS = ["calibrator_version", "hooks_planned", "hooks_omitted"];
const VIEWPORT_KEYS = [
  "canvas_cull_mask",
  "root_canvas",
  "logical_size",
  "stretch",
  "stretch_applied_by",
  "root_size_policy",
  "host_size_status",
  "host_window_size",
];
// render-stream-6.md "Viewport": presentation_size (right after root_size_policy, before
// host_size_status) plus font_oversampling/snap_2d (after host_window_size).
const VIEWPORT_KEYS_V6 = [
  "canvas_cull_mask",
  "root_canvas",
  "logical_size",
  "stretch",
  "stretch_applied_by",
  "root_size_policy",
  "presentation_size",
  "host_size_status",
  "host_window_size",
  "font_oversampling",
  "snap_2d",
];
const STRETCH_KEYS = ["mode", "aspect", "scale_mode"];
const SNAP_2D_KEYS = ["transforms", "vertices"];
// render-stream-6.md "Publication" (a new top-level session key, distinct from
// features.publication).
const PUBLICATION_KEYS = ["mode", "target_fps"];
// render-stream-7.md "Session": publication gains "credit_window", right after "target_fps"
// (gate7-design.md D2/D4).
const PUBLICATION_KEYS_V7 = ["mode", "target_fps", "credit_window"];
const RESOURCES_KEYS = [
  "hash",
  "payload",
  "delivery",
  "inline_max_bytes",
  "max_payload_bytes",
  "permitted_formats",
  "fetch",
  "http_path",
  "auth",
];
// render-stream-4.md "Resources": "payload" (a string) becomes "payloads" (a sorted array) at /4;
// unchanged in shape at /5 (just one more schema string in the array).
const RESOURCES_KEYS_V4 = [
  "hash",
  "payloads",
  "delivery",
  "inline_max_bytes",
  "max_payload_bytes",
  "permitted_formats",
  "fetch",
  "http_path",
  "auth",
];
const FEATURES_KEYS = [
  "ops",
  "item_state",
  "resources",
  "unsupported_resources",
  "observed_unsupported_ops",
  "unobserved",
  "publication",
];
// render-stream-5.md "Session": a new "canvas_state" key, right after "item_state".
const FEATURES_KEYS_V5 = [
  "ops",
  "item_state",
  "canvas_state",
  "resources",
  "unsupported_resources",
  "observed_unsupported_ops",
  "unobserved",
  "publication",
];
const MATERIALS_KEYS = ["shader_policy"];
const SABOTAGE_KEYS = ["kind", "frame", "op"];
const SABOTAGE_KINDS = [
  "freeze-frame",
  "omit-update",
  "perturb-transform",
  "omit-op",
  "patch-drop-item",
  "drop-message",
  "ignore-credit",
  "stale-coalesce",
  "stale-texture",
  "wrong-hash",
  "spurious-texture-update",
  "drop-resource",
  "unpin",
  "perturb-glyph",
  "perturb-vertex",
  "perturb-shader",
  "retain-superseded",
] as const;

const TRANSACTION_KEYS = [
  "type",
  "seq",
  "frame",
  "encoding",
  "base_seq",
  "status",
  "failures",
  "unsupported",
  "default_texture_filter",
  "default_texture_repeat",
  "removed_canvases",
  "removed_items",
  "removed_textures",
  "canvases",
  "items",
  "textures",
  "blocks",
];
// render-stream-4.md "Mesh table": removed_meshes after removed_textures, meshes after textures.
const TRANSACTION_KEYS_V4 = [
  "type",
  "seq",
  "frame",
  "encoding",
  "base_seq",
  "status",
  "failures",
  "unsupported",
  "default_texture_filter",
  "default_texture_repeat",
  "removed_canvases",
  "removed_items",
  "removed_textures",
  "removed_meshes",
  "canvases",
  "items",
  "textures",
  "meshes",
  "blocks",
];
// render-stream-5.md "Shader table"/"Material table": removed_shaders/removed_materials after
// removed_meshes, shaders/materials after meshes.
const TRANSACTION_KEYS_V5 = [
  "type",
  "seq",
  "frame",
  "encoding",
  "base_seq",
  "status",
  "failures",
  "unsupported",
  "default_texture_filter",
  "default_texture_repeat",
  "removed_canvases",
  "removed_items",
  "removed_textures",
  "removed_meshes",
  "removed_shaders",
  "removed_materials",
  "canvases",
  "items",
  "textures",
  "meshes",
  "shaders",
  "materials",
  "blocks",
];
const FAILURE_KEYS = ["reason", "detail"];
// protocol/unknown-item-skip.md: the session key (after "sabotage") and the transaction key
// (after "unsupported") a skip session adds, at /4 and /5 only.
const UNKNOWN_ITEM_POLICY_KEY = "unknown_item_policy";
const UNKNOWN_ITEMS_KEY = "unknown_items";
const UNKNOWN_ITEMS_KEYS = [
  "unknown_rids",
  "withheld_items",
  "withheld_commands",
  "unknown_calls",
];

/** `keys` with `key` inserted right after `after`. */
function keysWith(
  keys: readonly string[],
  after: string,
  key: string,
): string[] {
  const out = [...keys];
  out.splice(out.indexOf(after) + 1, 0, key);
  return out;
}
const UNSUPPORTED_KEYS = ["op", "item", "reason"];
const CANVAS_KEYS = ["id", "origin", "role", "attached", "items"];
// render-stream-6.md "Canvas": layer/sublayer, right after attached and before items.
const CANVAS_KEYS_V6 = [
  "id",
  "origin",
  "role",
  "attached",
  "layer",
  "sublayer",
  "items",
];
const ITEM_KEYS = [
  "id",
  "origin",
  "parent",
  "children",
  "visible",
  "draw_index",
  "z_index",
  "z_relative",
  "behind",
  "clip",
  "custom_rect",
  "visibility_layer",
  "texture_filter",
  "texture_repeat",
  "content_version",
  "commands",
];
// render-stream-5.md "Item": material, use_parent_material, instance_params -- in that order,
// before content_version.
const ITEM_KEYS_V5 = [
  "id",
  "origin",
  "parent",
  "children",
  "visible",
  "draw_index",
  "z_index",
  "z_relative",
  "behind",
  "clip",
  "custom_rect",
  "visibility_layer",
  "texture_filter",
  "texture_repeat",
  "material",
  "use_parent_material",
  "instance_params",
  "content_version",
  "commands",
];
const PARENT_KEYS = ["kind", "id"];
const ADD_RECT_KEYS = ["op", "aa", "f"];
const ADD_TEXTURE_RECT_KEYS = ["op", "tex", "tile", "transpose", "f"];
const ADD_TEXTURE_RECT_REGION_KEYS = ["op", "tex", "transpose", "clip_uv", "f"];
// render-stream-3.md "Command" (new at /3).
const ADD_MSDF_TEXTURE_RECT_REGION_KEYS = ["op", "tex", "outline", "f"];
const UNSUPPORTED_CMD_KEYS = ["op", "name", "reason"];
// render-stream-4.md "Command" (new at /4): key order is "op", the extra meta keys in the order
// the spec lists them, then "f" last (or, for add_clip_ignore, "ignore" last with no "f").
const ADD_LINE_KEYS = ["op", "aa", "f"];
const ADD_POLYLINE_KEYS = ["op", "aa", "n", "colors", "f"];
const ADD_CIRCLE_KEYS = ["op", "aa", "f"];
const ADD_PRIMITIVE_KEYS = ["op", "tex", "n", "colors", "uvs", "f"];
const ADD_TRIANGLE_ARRAY_KEYS = [
  "op",
  "tex",
  "n",
  "colors",
  "uvs",
  "indices",
  "count",
  "i",
  "f",
];
const ADD_NINE_PATCH_KEYS = [
  "op",
  "tex",
  "x_axis",
  "y_axis",
  "draw_center",
  "f",
];
const ADD_MESH_KEYS = ["op", "mesh", "tex", "f"];
const ADD_SET_TRANSFORM_KEYS = ["op", "f"];
const ADD_CLIP_IGNORE_KEYS = ["op", "ignore"];
const TEXTURE_KEYS = [
  "id",
  "origin",
  "kind",
  "status",
  "reason",
  "version",
  "hash",
  "format",
  "width",
  "height",
  "mipmaps",
  "payload_bytes",
  "canvas",
];
const CANVAS_TEXTURE_KEYS = ["diffuse", "filter", "repeat"];
// render-stream-4.md "Mesh table" (new at /4).
const MESH_KEYS = [
  "id",
  "origin",
  "status",
  "reason",
  "version",
  "f",
  "surfaces",
];
const MESH_SURFACE_KEYS = [
  "hash",
  "payload_bytes",
  "primitive",
  "format",
  "vertex_count",
  "index_count",
];

// render-stream-5.md "Shader table"/"Material table" (new at /5).
const SHADER_KEYS = [
  "id",
  "origin",
  "status",
  "reason",
  "version",
  "mode",
  "source",
  "hash",
  "payload_bytes",
  "builtin",
  "uses",
  "default_textures",
];
const BUILTIN_KEYS = [
  "kind",
  "blend_mode",
  "light_mode",
  "particles_animation",
];
const DEFAULT_TEXTURE_KEYS = ["name", "index", "tex"];
const MATERIAL_KEYS = [
  "id",
  "origin",
  "status",
  "reason",
  "version",
  "shader",
  "params",
];
const PARAM_KEYS = ["name", "type", "n", "tex", "f"];

const RESOURCE_KEYS = ["type", "hash", "bytes", "blocks"];

const END_KEYS = ["type", "transactions", "reason", "stats", "blocks"];
const STATS_KEYS = [
  "bytes_total",
  "encode_ns_total",
  "snapshot_ns_total",
  "diff_ns_total",
  "max_record_bytes",
  "full_transactions",
  "patch_transactions",
  "resource_records",
  "resource_bytes",
];

const BLOCK_KEYS = ["name", "type", "count"];

const SESSION_BLOCK_NAMES = [
  "clear_color",
  "root_canvas_xform",
  "host_visible_rect",
  "host_final_xform",
  "content_scale_factor",
];
const SESSION_BLOCK_COUNTS = [4, 6, 4, 6, 1];
const TRANSACTION_BLOCK_NAMES = ["item_f32", "canvas_f32", "cmd_f32"];
// render-stream-4.md "Transaction blocks": five blocks; cmd_i32 is type "i32", the rest "f32".
const TRANSACTION_BLOCK_NAMES_V4 = [
  "item_f32",
  "canvas_f32",
  "cmd_f32",
  "cmd_i32",
  "mesh_f32",
];
const TRANSACTION_BLOCK_TYPES_V4: Array<"f32" | "i32"> = [
  "f32",
  "f32",
  "f32",
  "i32",
  "f32",
];
// render-stream-5.md "Transaction blocks": six blocks; param_f64 is type "f64", the rest as /4.
const TRANSACTION_BLOCK_NAMES_V5 = [
  "item_f32",
  "canvas_f32",
  "cmd_f32",
  "cmd_i32",
  "mesh_f32",
  "param_f64",
];
const TRANSACTION_BLOCK_TYPES_V5: Array<"f32" | "i32" | "f64"> = [
  "f32",
  "f32",
  "f32",
  "i32",
  "f32",
  "f64",
];

const FILTERS = [
  "default",
  "nearest",
  "linear",
  "nearest_mipmaps",
  "linear_mipmaps",
  "nearest_mipmaps_anisotropic",
  "linear_mipmaps_anisotropic",
] as const;
const REPEATS = ["default", "disabled", "enabled", "mirror"] as const;
const DELIVERIES = ["out-of-band", "inline", "mixed"] as const;
const FETCHES = ["http", "directory", "none"] as const;
const AUTHS = ["none", "bearer"] as const;
const TEXTURE_KINDS = ["image", "placeholder", "canvas"] as const;
const TEXTURE_STATUSES = ["ok", "unsupported", "freed"] as const;
const TEXTURE_REASONS = [
  "unsupported-format",
  "payload-too-large",
  "payload-unavailable",
  "update-shape-mismatch",
  "layered-update",
  "unknown-texture",
  "canvas-texture-channel",
] as const;
const UNSUPPORTED_CMD_REASONS = [
  "unsupported-op",
  "unknown-texture",
  "canvas-texture-headless",
  "unknown-mesh",
  "skinned-geometry",
] as const;
const UNSUPPORTED_RESOURCE_KEYS = ["resource", "reason"];
const UNSUPPORTED_RESOURCE_REASONS = ["canvas-texture-headless"] as const;
const SESSION_UNSUPPORTED_REASONS = [
  "non-root-viewport",
  "extra-canvas",
  "degenerate-host-size",
] as const;
const ITEM_UNSUPPORTED_REASONS = [
  "unsupported-op",
  "unsupported-state",
  "draw-index-tie",
  "unknown-texture",
  "unsupported-texture",
  "canvas-texture-headless",
  "unknown-mesh",
  "skinned-geometry",
  "unsupported-mesh",
] as const;
// render-stream-5.md "Decoders accept 'unsupported-state' for canvas_item_attach_skeleton only at
// /5": canvas_item_set_material's unsupported-state no longer occurs (superseded by item-level
// material state), so /5 decoders reject it -- gate5_5-design.md Q4: "/5 decoders reject it."
const ITEM_UNSUPPORTED_REASONS_V5 = [
  "unsupported-op",
  "unsupported-state",
  "draw-index-tie",
  "unknown-texture",
  "unsupported-texture",
  "canvas-texture-headless",
  "unknown-mesh",
  "skinned-geometry",
  "unsupported-mesh",
  "unsupported-material",
  "unknown-material",
  "param-type",
] as const;
// new at /5: the session-level ("item": null) canvas-light entry (gate5_5-design.md D10, D16).
const SESSION_UNSUPPORTED_REASONS_V5 = [
  "non-root-viewport",
  "extra-canvas",
  "degenerate-host-size",
  "canvas-light",
] as const;
// new at /6 (render-stream-6.md "Session-level unsupported reasons"): five new session-level
// entries. "extra-canvas" stays schema-legal (so a malformed vector naming it still gets the
// specific unsupported-mismatch code, not a generic one) but is rejected semantically below --
// it never legitimately occurs at /6 (render-stream-6.md "As built").
const SESSION_UNSUPPORTED_REASONS_V6 = [
  "non-root-viewport",
  "extra-canvas",
  "degenerate-host-size",
  "canvas-light",
  "canvas-stacking-tie",
  "canvas-repeat",
  "canvas-follow-viewport",
  "global-canvas-transform",
  "snap-2d",
] as const;
const AXIS_STRETCH_MODES = ["stretch", "tile", "tile_fit"] as const;
const PRIMITIVES = [
  "points",
  "lines",
  "line_strip",
  "triangles",
  "triangle_strip",
] as const;
const MESH_STATUSES = ["ok", "unsupported", "freed"] as const;
const MESH_REASONS = [
  "mesh-format",
  "mesh-blend-shapes",
  "payload-too-large",
] as const;

// --- new at /5 (render-stream-5.md "Shader table"/"Material table") ---------------------------

const VARIANT_TYPES = [
  "nil",
  "bool",
  "int",
  "float",
  "vector2",
  "vector2i",
  "rect2",
  "rect2i",
  "vector3",
  "vector3i",
  "transform2d",
  "vector4",
  "vector4i",
  "plane",
  "quaternion",
  "aabb",
  "basis",
  "transform3d",
  "projection",
  "color",
  "rid",
  "packed_int32_array",
  "packed_int64_array",
  "packed_float32_array",
  "packed_float64_array",
  "packed_vector2_array",
  "packed_vector3_array",
  "packed_vector4_array",
  "packed_color_array",
] as const;
// gate5_5-design.md D8: float64 components per element of a Variant type (0 for nil/rid).
const VARIANT_COMPONENTS: Record<string, number> = {
  nil: 0,
  bool: 1,
  int: 1,
  float: 1,
  vector2: 2,
  vector2i: 2,
  rect2: 4,
  rect2i: 4,
  vector3: 3,
  vector3i: 3,
  transform2d: 6,
  vector4: 4,
  vector4i: 4,
  plane: 4,
  quaternion: 4,
  aabb: 6,
  basis: 9,
  transform3d: 12,
  projection: 16,
  color: 4,
  rid: 0,
  packed_int32_array: 1,
  packed_int64_array: 1,
  packed_float32_array: 1,
  packed_float64_array: 1,
  packed_vector2_array: 2,
  packed_vector3_array: 3,
  packed_vector4_array: 4,
  packed_color_array: 4,
};
const SHADER_MODES = [
  "canvas_item",
  "spatial",
  "particles",
  "sky",
  "fog",
] as const;
const SHADER_STATUSES = ["ok", "unsupported"] as const;
const SHADER_REASONS = [
  "shader-mode",
  "shader-screen-texture",
  "shader-sdf",
  "shader-time",
  "shader-global-uniform",
  "shader-excluded",
  "payload-too-large",
  "payload-unavailable",
] as const;
const SHADER_USES = [
  "global_uniform",
  "instance_uniform",
  "light",
  "screen_texture",
  "sdf",
  "time",
] as const;
const SHADER_SOURCES = ["payload", "withheld"] as const;
const BLEND_MODES = [
  "mix",
  "add",
  "sub",
  "mul",
  "premul_alpha",
  "disabled",
] as const;
const LIGHT_MODES = ["normal", "unshaded", "light_only"] as const;
const MATERIAL_STATUSES = ["ok", "unsupported"] as const;
const MATERIAL_REASONS = [
  "unknown-shader",
  "unknown-texture",
  "param-type",
  "param-range",
] as const;
const SHADER_POLICIES = ["source", "params", "exclude"] as const;

// render-stream-2.md "Texture payload": pixel size (bytes/texel) of the permitted uncompressed
// formats. Only these ever have an expected size computed.
const PIXEL_SIZES: Record<string, number> = {
  L8: 1,
  LA8: 2,
  R8: 1,
  RG8: 2,
  RGB8: 3,
  RGBA8: 4,
};

// --------------------------------------------------------------------------------------- small helpers

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// gate7-design.md G7j/Q5: an injected hash rather than a hard `node:crypto` import, so this
// module (and its two payload-format siblings) can be bundled for a browser. Defaults to the pure
// `sha256Hex` -- what a browser gets -- and Node callers may inject a `node:crypto`-backed
// function instead; `scripts/test/self-test-browser-decoder.ts` verifies the two give
// byte-identical results on every golden payload and resolves every golden recording identically
// either way.
let hashImpl: HashFn = sha256Hex;

export function setHashImpl(fn: HashFn): void {
  hashImpl = fn;
}

function hashBytes(bytes: Uint8Array): string {
  return hashImpl(bytes);
}

// GRT4b: printable ASCII decodes to the same code points under every single-byte decoder, so the
// bytes are checked first and then decoded at once (the string was built a byte at a time).
const latin1 = new TextDecoder("latin1");

function bytesToAscii(bytes: Uint8Array): string | null {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x20 || b > 0x7e) return null;
  }
  return latin1.decode(bytes);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** features.unsupported_resources (G2d): {resource, reason} objects, sorted strictly ascending by
 * resource (byte order), each reason a known one. */
function isUnsupportedResources(
  value: unknown,
): value is Array<{ resource: string; reason: string }> {
  if (!Array.isArray(value)) return false;
  let last: string | null = null;
  for (const entry of value) {
    if (
      !isPlainObject(entry) ||
      !hasExactKeys(entry, UNSUPPORTED_RESOURCE_KEYS) ||
      typeof entry.resource !== "string" ||
      !isOneOf(entry.reason, UNSUPPORTED_RESOURCE_REASONS)
    )
      return false;
    if (last !== null && !(last < entry.resource)) return false;
    last = entry.resource;
  }
  return true;
}

function isIntArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => isInt(v));
}

function isOneOf<T extends string>(
  value: unknown,
  options: readonly T[],
): value is T {
  return (
    typeof value === "string" && (options as readonly string[]).includes(value)
  );
}

function hasExactKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(obj);
  if (actual.length !== keys.length) return false;
  for (let i = 0; i < keys.length; i++) if (actual[i] !== keys[i]) return false;
  return true;
}

function isLowerHex(value: unknown, length: number): value is string {
  if (typeof value !== "string" || value.length !== length) return false;
  return /^[0-9a-f]+$/.test(value);
}

function checkBlocksField(value: unknown, offset: number): string | null {
  if (!Array.isArray(value)) {
    return `meta-schema: record at offset ${offset}: "blocks" is not an array`;
  }
  for (const entry of value) {
    if (!isPlainObject(entry) || !hasExactKeys(entry, BLOCK_KEYS)) {
      return `meta-schema: record at offset ${offset}: a blocks[] entry has the wrong keys`;
    }
    if (
      typeof entry.name !== "string" ||
      (entry.type !== "f32" &&
        entry.type !== "u8" &&
        entry.type !== "i32" &&
        entry.type !== "f64") ||
      !isInt(entry.count) ||
      entry.count < 0
    ) {
      return `meta-schema: record at offset ${offset}: a blocks[] entry has an invalid field`;
    }
  }
  return null;
}

// A record type's blocks are a fixed, ordered set of names, always type "f32" for session/
// transaction/end (render-stream-2.md "Record framing: the u8 block type": "A u8 block appears
// only as the single payload block of a resource record. Anywhere else it is meta-schema").
function checkFixedBlockNames(
  blocks: BlockDescriptor[],
  names: readonly string[],
  offset: number,
  types?: ReadonlyArray<"f32" | "i32" | "f64">,
): string | null {
  if (blocks.length !== names.length) {
    return `meta-schema: record at offset ${offset}: expected ${names.length} blocks (${names.join(", ")}), got ${blocks.length}`;
  }
  for (let i = 0; i < names.length; i++) {
    if (blocks[i].name !== names[i]) {
      return `meta-schema: record at offset ${offset}: block ${i} is named "${blocks[i].name}", expected "${names[i]}"`;
    }
    // render-stream-4.md "Block type i32": a transaction's "cmd_i32" block is the one legal place
    // for type "i32"; every other fixed block (here, every one when `types` is omitted) is "f32".
    const expectedType = types ? types[i] : "f32";
    if (blocks[i].type !== expectedType) {
      return `meta-schema: record at offset ${offset}: block "${blocks[i].name}" has type "${blocks[i].type}", expected "${expectedType}"`;
    }
  }
  return null;
}

function intPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isInt(value[0]) &&
    isInt(value[1])
  );
}

// --------------------------------------------------------------------------------------- schema checks

function checkResourcesSchema(
  resources: unknown,
  offset: number,
  version: 2 | 3 | 4 | 5 | 6 | 7,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: resources ${detail}`,
  ];
  const isV4OrLater =
    version === 4 || version === 5 || version === 6 || version === 7;
  const keys = isV4OrLater ? RESOURCES_KEYS_V4 : RESOURCES_KEYS;
  if (!isPlainObject(resources) || !hasExactKeys(resources, keys)) {
    return err("has the wrong keys");
  }
  if (resources.hash !== "sha256") return err('"hash" must be "sha256"');
  if (isV4OrLater) {
    // render-stream-4.md "Resources": "payloads" is a sorted array of schema strings (mesh and
    // texture share one resource policy; /5 adds shader to that set).
    if (!isStringArray(resources.payloads)) {
      return err('"payloads" is not an array of strings');
    }
    const sortedPayloads = [...resources.payloads].sort();
    if (JSON.stringify(resources.payloads) !== JSON.stringify(sortedPayloads)) {
      return err('"payloads" is not sorted ascending');
    }
  } else if (typeof resources.payload !== "string") {
    return err('"payload" is not a string');
  }
  if (!isOneOf(resources.delivery, DELIVERIES))
    return err("has an invalid delivery");
  if (!isInt(resources.inline_max_bytes) || resources.inline_max_bytes < 0) {
    return err('"inline_max_bytes" is not a non-negative integer');
  }
  if (!isInt(resources.max_payload_bytes) || resources.max_payload_bytes < 1) {
    return err('"max_payload_bytes" is not an integer >= 1');
  }
  if (!isStringArray(resources.permitted_formats)) {
    return err('"permitted_formats" is not an array of strings');
  }
  if (!isOneOf(resources.fetch, FETCHES)) return err("has an invalid fetch");
  if (
    !(resources.http_path === null || typeof resources.http_path === "string")
  ) {
    return err('"http_path" is neither null nor a string');
  }
  if ((resources.fetch === "http") !== (resources.http_path !== null)) {
    return err('"http_path" must be non-null exactly for fetch "http"');
  }
  if (!isOneOf(resources.auth, AUTHS)) return err("has an invalid auth");
  const expectedDelivery: Delivery =
    resources.inline_max_bytes === 0
      ? "out-of-band"
      : resources.inline_max_bytes >= resources.max_payload_bytes
        ? "inline"
        : "mixed";
  if (resources.delivery !== expectedDelivery) {
    return err(
      `"delivery" is "${resources.delivery}", expected "${expectedDelivery}" from inline_max_bytes/max_payload_bytes`,
    );
  }
  if ((resources.delivery === "inline") !== (resources.fetch === "none")) {
    return err('"fetch" must be "none" exactly when delivery is "inline"');
  }
  return [];
}

function checkSessionSchema(
  meta: Record<string, unknown>,
  offset: number,
  version: 2 | 3 | 4 | 5 | 6 | 7,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: ${detail}`,
  ];
  const isV7 = version === 7;
  // isV6 means "V6 or later": /7 is a delta on /6 that keeps everything /6 added (presentation
  // stretch declarations, the top-level publication key, canvas layer/sublayer) unless
  // render-stream-7.md says otherwise.
  const isV6 = isV7 || version === 6;
  // isV5 means "V5 or later": /6 is a delta on /5 that keeps everything /5 added unless
  // render-stream-6.md says otherwise.
  const isV5 = isV6 || version === 5;
  // protocol/unknown-item-skip.md "Session": an optional key, legal only at /4 and later.
  const skipDeclared = version >= 4 && UNKNOWN_ITEM_POLICY_KEY in meta;
  // /7 adds no new top-level session key (only publication's own shape changes), so SESSION_KEYS_V6
  // covers /6 and /7 alike.
  const sessionKeys = isV6
    ? SESSION_KEYS_V6
    : isV5
      ? SESSION_KEYS_V5
      : SESSION_KEYS;
  if (
    !hasExactKeys(
      meta,
      skipDeclared
        ? keysWith(sessionKeys, "sabotage", UNKNOWN_ITEM_POLICY_KEY)
        : sessionKeys,
    )
  )
    return err("session has the wrong top-level keys or order");
  if (skipDeclared && meta.unknown_item_policy !== "skip")
    return err('"unknown_item_policy" must be "skip" when present');
  const expectedProtocol = isV7
    ? "render-stream/7"
    : isV6
      ? "render-stream/6"
      : isV5
        ? "render-stream/5"
        : version === 4
          ? "render-stream/4"
          : version === 3
            ? "render-stream/3"
            : "render-stream/2";
  if (meta.protocol !== expectedProtocol)
    return err(`unknown protocol ${JSON.stringify(meta.protocol)}`);
  if (typeof meta.session_id !== "string")
    return err('"session_id" is not a string');

  const stream = meta.stream;
  if (
    !isPlainObject(stream) ||
    !hasExactKeys(stream, STREAM_KEYS) ||
    typeof stream.stream_id !== "string" ||
    !(
      stream.connection === null ||
      (isInt(stream.connection) && stream.connection >= 1)
    ) ||
    !isOneOf(stream.transport, ["file", "websocket"] as const) ||
    !isOneOf(stream.encoding, ["full", "patch"] as const)
  ) {
    return err('"stream" has the wrong keys or an invalid field');
  }

  const engine = meta.engine;
  if (
    !isPlainObject(engine) ||
    !hasExactKeys(engine, ENGINE_KEYS) ||
    typeof engine.version_string !== "string" ||
    typeof engine.sha256 !== "string" ||
    typeof engine.display_server !== "string" ||
    typeof engine.rendering_driver !== "string" ||
    typeof engine.rendering_method !== "string"
  ) {
    return err('"engine" has the wrong keys or a non-string field');
  }

  const capture = meta.capture;
  if (
    !isPlainObject(capture) ||
    !hasExactKeys(capture, CAPTURE_KEYS) ||
    !isInt(capture.calibrator_version) ||
    !isStringArray(capture.hooks_planned) ||
    !isStringArray(capture.hooks_omitted)
  ) {
    return err('"capture" has the wrong keys or an invalid field');
  }

  const viewport = meta.viewport;
  if (
    !isPlainObject(viewport) ||
    !hasExactKeys(viewport, isV6 ? VIEWPORT_KEYS_V6 : VIEWPORT_KEYS)
  ) {
    return err('"viewport" has the wrong keys');
  }
  if (
    !isInt(viewport.canvas_cull_mask) ||
    !isInt(viewport.root_canvas) ||
    !intPair(viewport.logical_size) ||
    !intPair(viewport.host_window_size) ||
    !isOneOf(viewport.stretch_applied_by, ["receiver"] as const) ||
    !isOneOf(
      viewport.root_size_policy,
      isV6
        ? (["observe", "enforce-min-size", "presentation"] as const)
        : (["observe", "enforce-min-size"] as const),
    ) ||
    !isOneOf(viewport.host_size_status, [
      "match",
      "degenerate-visible",
      "degenerate-window",
    ] as const)
  ) {
    return err('"viewport" has an invalid field');
  }
  if (isV6) {
    // render-stream-6.md "Viewport": presentation_size, font_oversampling, snap_2d.
    if (!intPair(viewport.presentation_size)) {
      return err('"viewport.presentation_size" is not a pair of integers');
    }
    if (
      typeof viewport.font_oversampling !== "number" ||
      !(viewport.font_oversampling > 0)
    ) {
      return [
        `viewport-entry: record at offset ${offset}: "font_oversampling" is not a positive number`,
      ];
    }
    const snap2d = viewport.snap_2d;
    if (
      !isPlainObject(snap2d) ||
      !hasExactKeys(snap2d, SNAP_2D_KEYS) ||
      typeof snap2d.transforms !== "boolean" ||
      typeof snap2d.vertices !== "boolean"
    ) {
      return err('"viewport.snap_2d" has the wrong keys or an invalid field');
    }
  }
  const stretch = viewport.stretch;
  if (
    !isPlainObject(stretch) ||
    !hasExactKeys(stretch, STRETCH_KEYS) ||
    !isOneOf(stretch.mode, ["disabled", "canvas_items", "viewport"] as const) ||
    !isOneOf(stretch.aspect, [
      "ignore",
      "keep",
      "keep_width",
      "keep_height",
      "expand",
    ] as const) ||
    !isOneOf(stretch.scale_mode, ["fractional", "integer"] as const)
  ) {
    return err('"viewport.stretch" has the wrong keys or an invalid field');
  }
  if (isV6) {
    // render-stream-6.md "Viewport": presentation_size must equal logical_size unless the policy
    // is "presentation", and even then must still equal it under stretch "disabled" (a
    // presentation that differs from the logical size under disabled stretch would change
    // layout -- refused at capture time as root-size-invalid, never observed on the wire).
    const presentationSize = viewport.presentation_size as [number, number];
    const logicalSize = viewport.logical_size as [number, number];
    const samePair = (a: [number, number], b: [number, number]) =>
      a[0] === b[0] && a[1] === b[1];
    if (viewport.root_size_policy !== "presentation") {
      if (!samePair(presentationSize, logicalSize)) {
        return [
          `viewport-entry: record at offset ${offset}: "presentation_size" differs from "logical_size" without root_size_policy "presentation"`,
        ];
      }
    } else if (
      (stretch as { mode: StretchMode }).mode === "disabled" &&
      !samePair(presentationSize, logicalSize)
    ) {
      return [
        `viewport-entry: record at offset ${offset}: "presentation_size" differs from "logical_size" under stretch "disabled"`,
      ];
    }
  }

  const resourcesErr = checkResourcesSchema(meta.resources, offset, version);
  if (resourcesErr.length > 0) return resourcesErr;

  if (isV5) {
    // render-stream-5.md "Session": a new "materials" key, right after "resources".
    const materials = meta.materials;
    if (
      !isPlainObject(materials) ||
      !hasExactKeys(materials, MATERIALS_KEYS) ||
      !isOneOf(materials.shader_policy, SHADER_POLICIES)
    ) {
      return err('"materials" has the wrong keys or an invalid field');
    }
  }

  const features = meta.features;
  if (
    !isPlainObject(features) ||
    !hasExactKeys(features, isV5 ? FEATURES_KEYS_V5 : FEATURES_KEYS) ||
    !isStringArray(features.ops) ||
    !isStringArray(features.item_state) ||
    (isV5 && !isStringArray(features.canvas_state)) ||
    !isStringArray(features.resources) ||
    !isUnsupportedResources(features.unsupported_resources) ||
    !isStringArray(features.observed_unsupported_ops) ||
    !isStringArray(features.unobserved) ||
    typeof features.publication !== "string"
  ) {
    return err('"features" has the wrong keys or an invalid field');
  }

  if (isV6) {
    // render-stream-6.md "Publication": a new top-level session key, distinct from
    // features.publication above. render-stream-7.md adds "credit_window", checked only at /7.
    const publication = meta.publication;
    if (
      !isPlainObject(publication) ||
      !hasExactKeys(
        publication,
        isV7 ? PUBLICATION_KEYS_V7 : PUBLICATION_KEYS,
      ) ||
      !isOneOf(publication.mode, ["every-frame", "rate"] as const) ||
      !(
        publication.target_fps === null ||
        (isInt(publication.target_fps) && publication.target_fps >= 1)
      ) ||
      (isV7 && !isInt(publication.credit_window))
    ) {
      return err('"publication" has the wrong keys or an invalid field');
    }
    if (
      (publication.mode === "every-frame") !==
      (publication.target_fps === null)
    ) {
      return [
        `publication-entry: record at offset ${offset}: "every-frame" must carry target_fps null, and "rate" must carry a non-null target_fps`,
      ];
    }
    if (
      publication.mode === "rate" &&
      (publication.target_fps as number) > 240
    ) {
      return [
        `publication-entry: record at offset ${offset}: "rate"'s target_fps must be in 1..240`,
      ];
    }
    if (
      publication.mode === "rate" &&
      (meta.stream as { transport?: string }).transport === "file"
    ) {
      return [
        `publication-entry: record at offset ${offset}: a "file" stream must not declare publication "rate"`,
      ];
    }
    if (isV7) {
      // render-stream-7.md "Session": credit_window is 1..2, and a "file" stream is always 1
      // (gate7-design.md D2/D4).
      const creditWindow = publication.credit_window as number;
      if (creditWindow < 1 || creditWindow > 2) {
        return [
          `publication-entry: record at offset ${offset}: publication.credit_window is ${creditWindow}, out of range 1..2`,
        ];
      }
      if (
        (meta.stream as { transport?: string }).transport === "file" &&
        creditWindow !== 1
      ) {
        return [
          `publication-entry: record at offset ${offset}: stream.transport is "file" but publication.credit_window is ${creditWindow}, not 1`,
        ];
      }
    }
  }

  const sabotage = meta.sabotage;
  if (sabotage !== null) {
    if (
      !isPlainObject(sabotage) ||
      !hasExactKeys(sabotage, SABOTAGE_KEYS) ||
      !isOneOf(sabotage.kind, SABOTAGE_KINDS) ||
      !isInt(sabotage.frame) ||
      sabotage.frame < 1 ||
      !(sabotage.op === null || typeof sabotage.op === "string")
    ) {
      return err('"sabotage" is neither null nor a valid sabotage object');
    }
    if ((sabotage.kind === "omit-op") !== (sabotage.op !== null)) {
      return err('"sabotage.op" must be non-null exactly for kind "omit-op"');
    }
  }

  const blocksError = checkBlocksField(meta.blocks, offset);
  if (blocksError !== null) return [blocksError];
  const sessionBlocks = meta.blocks as BlockDescriptor[];
  const nameError = checkFixedBlockNames(
    sessionBlocks,
    SESSION_BLOCK_NAMES,
    offset,
  );
  if (nameError !== null) return [nameError];
  for (let i = 0; i < SESSION_BLOCK_COUNTS.length; i++) {
    if (sessionBlocks[i].count !== SESSION_BLOCK_COUNTS[i]) {
      return err(
        `session block "${sessionBlocks[i].name}" has count ${sessionBlocks[i].count}, expected ${SESSION_BLOCK_COUNTS[i]}`,
      );
    }
  }
  return [];
}

function checkTextureEntrySchema(t: unknown, offset: number): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: a textures[] entry ${detail}`,
  ];
  if (!isPlainObject(t) || !hasExactKeys(t, TEXTURE_KEYS)) {
    return err("has the wrong keys");
  }
  if (!isInt(t.id) || t.id < 1) return err('"id" is not an integer >= 1');
  if (t.origin !== "created") return err('"origin" must be "created"');
  if (!isOneOf(t.kind, TEXTURE_KINDS)) return err("has an invalid kind");
  if (!isOneOf(t.status, TEXTURE_STATUSES)) return err("has an invalid status");
  if (!(t.reason === null || isOneOf(t.reason, TEXTURE_REASONS))) {
    return err('"reason" is neither null nor a valid texture reason');
  }
  if (!isInt(t.version) || t.version < 1)
    return err('"version" is not an integer >= 1');
  if (!(t.hash === null || isLowerHex(t.hash, 64))) {
    return err('"hash" is neither null nor 64 lowercase hex digits');
  }
  if (!(t.format === null || typeof t.format === "string")) {
    return err('"format" is neither null nor a string');
  }
  if (!isInt(t.width) || t.width < 0)
    return err('"width" is not a non-negative integer');
  if (!isInt(t.height) || t.height < 0)
    return err('"height" is not a non-negative integer');
  if (typeof t.mipmaps !== "boolean") return err('"mipmaps" is not a boolean');
  if (!isInt(t.payload_bytes) || t.payload_bytes < 0) {
    return err('"payload_bytes" is not a non-negative integer');
  }
  const canvas = t.canvas;
  if (canvas !== null) {
    if (!isPlainObject(canvas) || !hasExactKeys(canvas, CANVAS_TEXTURE_KEYS)) {
      return err('"canvas" has the wrong keys');
    }
    if (
      !(
        canvas.diffuse === null ||
        (isInt(canvas.diffuse) && canvas.diffuse >= 1)
      )
    ) {
      return err('"canvas.diffuse" is neither null nor an integer >= 1');
    }
    if (!isOneOf(canvas.filter, FILTERS))
      return err('"canvas.filter" is invalid');
    if (!isOneOf(canvas.repeat, REPEATS))
      return err('"canvas.repeat" is invalid');
  }
  return [];
}

// render-stream-4.md "Mesh table" (new at /4): the wire shape of one mesh entry, mirroring
// checkTextureEntrySchema's structural checks. `mesh-entry`'s status/reason/f/surfaces coupling
// is checked later, once the running mesh_f32 offset is known (checkResolvedInvariants).
function checkMeshSurfaceSchema(s: unknown, offset: number): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: a meshes[].surfaces[] entry ${detail}`,
  ];
  if (!isPlainObject(s) || !hasExactKeys(s, MESH_SURFACE_KEYS)) {
    return err("has the wrong keys");
  }
  if (!isLowerHex(s.hash, 64))
    return err('"hash" is not 64 lowercase hex digits');
  if (!isInt(s.payload_bytes) || s.payload_bytes < 1) {
    return err('"payload_bytes" is not an integer >= 1');
  }
  if (!isOneOf(s.primitive, PRIMITIVES)) return err("has an invalid primitive");
  if (!isInt(s.format)) return err('"format" is not an integer');
  if (!isInt(s.vertex_count) || s.vertex_count < 0) {
    return err('"vertex_count" is not a non-negative integer');
  }
  if (!isInt(s.index_count) || s.index_count < 0) {
    return err('"index_count" is not a non-negative integer');
  }
  return [];
}

function checkMeshEntrySchema(m: unknown, offset: number): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: a meshes[] entry ${detail}`,
  ];
  if (!isPlainObject(m) || !hasExactKeys(m, MESH_KEYS)) {
    return err("has the wrong keys");
  }
  if (!isInt(m.id) || m.id < 1) return err('"id" is not an integer >= 1');
  if (m.origin !== "created") return err('"origin" must be "created"');
  if (!isOneOf(m.status, MESH_STATUSES)) return err("has an invalid status");
  if (!(m.reason === null || isOneOf(m.reason, MESH_REASONS))) {
    return err('"reason" is neither null nor a valid mesh reason');
  }
  if (!isInt(m.version) || m.version < 1)
    return err('"version" is not an integer >= 1');
  if (!(m.f === null || (isInt(m.f) && m.f >= 0))) {
    return err('"f" is neither null nor a non-negative integer');
  }
  if (!Array.isArray(m.surfaces)) return err('"surfaces" is not an array');
  for (const s of m.surfaces) {
    const surfaceErr = checkMeshSurfaceSchema(s, offset);
    if (surfaceErr.length > 0) return surfaceErr;
  }
  return [];
}

// render-stream-5.md "Material table" (new at /5): the wire shape of one <param> object.
// "param-entry"'s type/n/tex coupling (tex non-null iff type "rid") is checked here; "param-
// offset" (the running "f" sequence) needs the whole material/item context and is checked later
// (checkResolvedInvariants).
function checkParamEntrySchema(
  p: unknown,
  offset: number,
  where: string,
): string[] {
  const err = (detail: string) => [
    `param-entry: record at offset ${offset}: a ${where} param ${detail}`,
  ];
  if (!isPlainObject(p) || !hasExactKeys(p, PARAM_KEYS)) {
    return err("has the wrong keys");
  }
  if (typeof p.name !== "string") return err('"name" is not a string');
  if (!isOneOf(p.type, VARIANT_TYPES)) return err("has an invalid type");
  if (!isInt(p.n) || p.n < 1) return err('"n" is not an integer >= 1');
  if (!(p.tex === null || (isInt(p.tex) && p.tex >= 1))) {
    return err('"tex" is neither null nor an integer >= 1');
  }
  if ((p.type === "rid") !== (p.tex !== null)) {
    return err('"tex" must be non-null exactly for type "rid"');
  }
  if (!isInt(p.f) || p.f < 0) return err('"f" is not a non-negative integer');
  return [];
}

function checkShaderEntrySchema(s: unknown, offset: number): string[] {
  const err = (detail: string) => [
    `shader-entry: record at offset ${offset}: a shaders[] entry ${detail}`,
  ];
  if (!isPlainObject(s) || !hasExactKeys(s, SHADER_KEYS)) {
    return err("has the wrong keys");
  }
  if (!isInt(s.id) || s.id < 1) return err('"id" is not an integer >= 1');
  if (s.origin !== "created") return err('"origin" must be "created"');
  if (!isOneOf(s.status, SHADER_STATUSES)) return err("has an invalid status");
  if (!(s.reason === null || isOneOf(s.reason, SHADER_REASONS))) {
    return err('"reason" is neither null nor a valid shader reason');
  }
  if ((s.status === "ok") !== (s.reason === null)) {
    return err('"reason" must be null exactly for status "ok"');
  }
  if (!isInt(s.version) || s.version < 1) {
    return err('"version" is not an integer >= 1');
  }
  if (!(s.mode === null || isOneOf(s.mode, SHADER_MODES))) {
    return err('"mode" is neither null nor a valid shader mode');
  }
  if (!(s.source === null || isOneOf(s.source, SHADER_SOURCES))) {
    return err('"source" is neither null nor a valid shader source');
  }
  if ((s.mode === null) !== (s.source === null)) {
    return err('"mode" and "source" must be null together (no code yet)');
  }
  if (!(s.hash === null || isLowerHex(s.hash, 64))) {
    return err('"hash" is neither null nor 64 lowercase hex digits');
  }
  if (!isInt(s.payload_bytes) || s.payload_bytes < 0) {
    return err('"payload_bytes" is not a non-negative integer');
  }
  const builtin = s.builtin;
  if (builtin !== null) {
    if (
      !isPlainObject(builtin) ||
      !hasExactKeys(builtin, BUILTIN_KEYS) ||
      builtin.kind !== "canvas_item_material" ||
      !isOneOf(builtin.blend_mode, BLEND_MODES) ||
      !isOneOf(builtin.light_mode, LIGHT_MODES) ||
      typeof builtin.particles_animation !== "boolean"
    ) {
      return err('"builtin" has the wrong keys or an invalid field');
    }
  }
  if (
    !Array.isArray(s.uses) ||
    !s.uses.every((u: unknown) => isOneOf(u, SHADER_USES))
  ) {
    return err('"uses" is not an array of valid shader uses');
  }
  const sortedUses = [...s.uses].sort();
  if (JSON.stringify(s.uses) !== JSON.stringify(sortedUses)) {
    return err('"uses" is not sorted ascending');
  }
  if (!Array.isArray(s.default_textures)) {
    return err('"default_textures" is not an array');
  }
  let lastKey: [string, number] | null = null;
  for (const d of s.default_textures) {
    if (
      !isPlainObject(d) ||
      !hasExactKeys(d, DEFAULT_TEXTURE_KEYS) ||
      typeof d.name !== "string" ||
      !isInt(d.index) ||
      d.index < 0 ||
      !isInt(d.tex) ||
      d.tex < 1
    ) {
      return err(
        'a "default_textures" entry has the wrong keys or an invalid field',
      );
    }
    const key: [string, number] = [d.name, d.index];
    if (
      lastKey !== null &&
      !(lastKey[0] < key[0] || (lastKey[0] === key[0] && lastKey[1] < key[1]))
    ) {
      return err(
        '"default_textures" is not sorted strictly ascending by (name, index)',
      );
    }
    lastKey = key;
  }
  return [];
}

function checkMaterialEntrySchema(m: unknown, offset: number): string[] {
  const err = (detail: string) => [
    `material-entry: record at offset ${offset}: a materials[] entry ${detail}`,
  ];
  if (!isPlainObject(m) || !hasExactKeys(m, MATERIAL_KEYS)) {
    return err("has the wrong keys");
  }
  if (!isInt(m.id) || m.id < 1) return err('"id" is not an integer >= 1');
  if (m.origin !== "created") return err('"origin" must be "created"');
  if (!isOneOf(m.status, MATERIAL_STATUSES))
    return err("has an invalid status");
  if (!(m.reason === null || isOneOf(m.reason, MATERIAL_REASONS))) {
    return err('"reason" is neither null nor a valid material reason');
  }
  if ((m.status === "ok") !== (m.reason === null)) {
    return err('"reason" must be null exactly for status "ok"');
  }
  if (!isInt(m.version) || m.version < 1) {
    return err('"version" is not an integer >= 1');
  }
  if (!(m.shader === null || (isInt(m.shader) && m.shader >= 1))) {
    return err('"shader" is neither null nor an integer >= 1');
  }
  if (!Array.isArray(m.params)) return err('"params" is not an array');
  let lastName: string | null = null;
  for (const p of m.params) {
    const paramErr = checkParamEntrySchema(p, offset, "materials[]");
    if (paramErr.length > 0) return paramErr;
    const name = (p as { name: string }).name;
    if (lastName !== null && !(lastName < name)) {
      return err('"params" is not sorted strictly ascending by name');
    }
    lastName = name;
  }
  return [];
}

function checkTransactionSchema(
  meta: Record<string, unknown>,
  offset: number,
  version: 2 | 3 | 4 | 5 | 6 | 7,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: ${detail}`,
  ];
  // isV6 means "V6 or later" (render-stream-7.md: transactions are byte-identical to /6).
  const isV6 = version === 6 || version === 7;
  // isV5 means "V5 or later" (render-stream-6.md: transactions are byte-identical to /5).
  const isV5 = isV6 || version === 5;
  const isV4 = isV5 || version === 4;
  const transactionKeys = isV5
    ? TRANSACTION_KEYS_V5
    : isV4
      ? TRANSACTION_KEYS_V4
      : TRANSACTION_KEYS;
  // protocol/unknown-item-skip.md "Transaction": legal only at /4 and later; whether it must be
  // present is the session's call (validateRecording checks the coupling).
  const hasUnknownItems = isV4 && UNKNOWN_ITEMS_KEY in meta;
  if (
    !hasExactKeys(
      meta,
      hasUnknownItems
        ? keysWith(transactionKeys, "unsupported", UNKNOWN_ITEMS_KEY)
        : transactionKeys,
    )
  )
    return err("transaction has the wrong top-level keys or order");
  if (hasUnknownItems) {
    const u = meta.unknown_items;
    if (
      !isPlainObject(u) ||
      !hasExactKeys(u, UNKNOWN_ITEMS_KEYS) ||
      !UNKNOWN_ITEMS_KEYS.every((k) => isInt(u[k]) && (u[k] as number) >= 0)
    ) {
      return err(
        '"unknown_items" must be {unknown_rids, withheld_items, withheld_commands, unknown_calls}, each an integer >= 0',
      );
    }
  }
  if (!isInt(meta.seq) || meta.seq < 1)
    return err('"seq" is not an integer >= 1');
  if (!isInt(meta.frame) || meta.frame < 1)
    return err('"frame" is not an integer >= 1');
  if (!isOneOf(meta.encoding, ["full", "patch"] as const))
    return err(`unknown encoding ${JSON.stringify(meta.encoding)}`);
  if (
    !(meta.base_seq === null || (isInt(meta.base_seq) && meta.base_seq >= 1))
  ) {
    return err('"base_seq" is neither null nor an integer >= 1');
  }
  if (meta.status !== "ok" && meta.status !== "capture-failure")
    return err(`unknown status ${JSON.stringify(meta.status)}`);

  if (!Array.isArray(meta.failures)) return err('"failures" is not an array');
  for (const f of meta.failures) {
    if (
      !isPlainObject(f) ||
      !hasExactKeys(f, FAILURE_KEYS) ||
      !isOneOf(f.reason, [
        "root-query-failed",
        "pre-existing-object",
        "mirror-capacity",
        "root-size-enforce-failed",
      ] as const) ||
      typeof f.detail !== "string"
    ) {
      return err("a failures[] entry is malformed");
    }
  }

  if (!Array.isArray(meta.unsupported))
    return err('"unsupported" is not an array');
  for (const u of meta.unsupported) {
    if (
      !isPlainObject(u) ||
      !hasExactKeys(u, UNSUPPORTED_KEYS) ||
      typeof u.op !== "string" ||
      !(u.item === null || isInt(u.item))
    ) {
      return err("an unsupported[] entry is malformed");
    }
    const allowedReasons = isV6
      ? u.item === null
        ? SESSION_UNSUPPORTED_REASONS_V6
        : ITEM_UNSUPPORTED_REASONS_V5
      : isV5
        ? u.item === null
          ? SESSION_UNSUPPORTED_REASONS_V5
          : ITEM_UNSUPPORTED_REASONS_V5
        : u.item === null
          ? SESSION_UNSUPPORTED_REASONS
          : ITEM_UNSUPPORTED_REASONS;
    if (!isOneOf(u.reason, allowedReasons)) {
      return err("an unsupported[] entry is malformed");
    }
  }

  if (
    !isOneOf(meta.default_texture_filter, FILTERS) ||
    meta.default_texture_filter === "default"
  ) {
    return err('"default_texture_filter" is invalid or "default"');
  }
  if (
    !isOneOf(meta.default_texture_repeat, REPEATS) ||
    meta.default_texture_repeat === "default"
  ) {
    return err('"default_texture_repeat" is invalid or "default"');
  }

  if (!isIntArray(meta.removed_canvases))
    return err('"removed_canvases" is not an array of integers');
  if (!isIntArray(meta.removed_items))
    return err('"removed_items" is not an array of integers');
  if (!isIntArray(meta.removed_textures))
    return err('"removed_textures" is not an array of integers');
  if (isV4 && !isIntArray(meta.removed_meshes))
    return err('"removed_meshes" is not an array of integers');
  if (
    isV5 &&
    (!isIntArray(meta.removed_shaders) || !isIntArray(meta.removed_materials))
  ) {
    return err(
      '"removed_shaders"/"removed_materials" is not an array of integers',
    );
  }

  if (!Array.isArray(meta.canvases)) return err('"canvases" is not an array');
  for (const c of meta.canvases) {
    if (
      !isPlainObject(c) ||
      !hasExactKeys(c, isV6 ? CANVAS_KEYS_V6 : CANVAS_KEYS) ||
      !isInt(c.id) ||
      !isOneOf(c.origin, ["created", "root-query", "adopted"] as const) ||
      !(c.role === "root" || c.role === null) ||
      typeof c.attached !== "boolean" ||
      !isIntArray(c.items)
    ) {
      return err("a canvases[] entry is malformed");
    }
    if (isV6 && (!isInt(c.layer) || !isInt(c.sublayer))) {
      return [
        `canvas-entry: record at offset ${offset}: canvas ${String(c.id)}'s "layer"/"sublayer" must both be integers`,
      ];
    }
  }

  if (!Array.isArray(meta.items)) return err('"items" is not an array');
  for (const it of meta.items) {
    if (
      !isPlainObject(it) ||
      !hasExactKeys(it, isV5 ? ITEM_KEYS_V5 : ITEM_KEYS) ||
      !isInt(it.id) ||
      !isOneOf(it.origin, ["created", "root-query", "adopted"] as const) ||
      typeof it.visible !== "boolean" ||
      !isInt(it.draw_index) ||
      !isInt(it.z_index) ||
      typeof it.z_relative !== "boolean" ||
      typeof it.behind !== "boolean" ||
      typeof it.clip !== "boolean" ||
      typeof it.custom_rect !== "boolean" ||
      !isInt(it.visibility_layer) ||
      !isOneOf(it.texture_filter, FILTERS) ||
      !isOneOf(it.texture_repeat, REPEATS) ||
      !isInt(it.content_version) ||
      !isIntArray(it.children) ||
      !(it.commands === null || Array.isArray(it.commands))
    ) {
      return err("an items[] entry is malformed");
    }
    if (isV5) {
      if (
        !(it.material === null || (isInt(it.material) && it.material >= 1)) ||
        typeof it.use_parent_material !== "boolean" ||
        !Array.isArray(it.instance_params)
      ) {
        return err(
          'an items[] entry has an invalid "material"/"use_parent_material"/"instance_params"',
        );
      }
      let lastParamName: string | null = null;
      for (const p of it.instance_params) {
        const paramErr = checkParamEntrySchema(
          p,
          offset,
          "items[].instance_params",
        );
        if (paramErr.length > 0) return paramErr;
        const name = (p as { name: string }).name;
        if (lastParamName !== null && !(lastParamName < name)) {
          return err(
            'an items[] entry\'s "instance_params" is not sorted strictly ascending by name',
          );
        }
        lastParamName = name;
      }
    }
    const parent = it.parent;
    if (
      parent !== null &&
      (!isPlainObject(parent) ||
        !hasExactKeys(parent, PARENT_KEYS) ||
        (parent.kind !== "canvas" && parent.kind !== "item") ||
        !isInt(parent.id))
    ) {
      return err('an items[] entry has an invalid "parent"');
    }
    if (it.commands !== null) {
      for (const cmd of it.commands as unknown[]) {
        if (!isPlainObject(cmd))
          return err("a commands[] entry is not an object");
        if (cmd.op === "add_rect") {
          if (
            !hasExactKeys(cmd, ADD_RECT_KEYS) ||
            typeof cmd.aa !== "boolean" ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err('a commands[] "add_rect" entry is malformed');
          }
        } else if (cmd.op === "add_texture_rect") {
          if (
            !hasExactKeys(cmd, ADD_TEXTURE_RECT_KEYS) ||
            !(cmd.tex === null || (isInt(cmd.tex) && cmd.tex >= 1)) ||
            typeof cmd.tile !== "boolean" ||
            typeof cmd.transpose !== "boolean" ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err('a commands[] "add_texture_rect" entry is malformed');
          }
        } else if (cmd.op === "add_texture_rect_region") {
          if (
            !hasExactKeys(cmd, ADD_TEXTURE_RECT_REGION_KEYS) ||
            !(cmd.tex === null || (isInt(cmd.tex) && cmd.tex >= 1)) ||
            typeof cmd.transpose !== "boolean" ||
            typeof cmd.clip_uv !== "boolean" ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err(
              'a commands[] "add_texture_rect_region" entry is malformed',
            );
          }
        } else if (cmd.op === "add_msdf_texture_rect_region") {
          if (
            !hasExactKeys(cmd, ADD_MSDF_TEXTURE_RECT_REGION_KEYS) ||
            !(cmd.tex === null || (isInt(cmd.tex) && cmd.tex >= 1)) ||
            !isInt(cmd.outline) ||
            cmd.outline < 0 ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err(
              'a commands[] "add_msdf_texture_rect_region" entry is malformed',
            );
          }
        } else if (cmd.op === "add_line") {
          if (
            !hasExactKeys(cmd, ADD_LINE_KEYS) ||
            typeof cmd.aa !== "boolean" ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err('a commands[] "add_line" entry is malformed');
          }
        } else if (cmd.op === "add_polyline" || cmd.op === "add_multiline") {
          if (
            !hasExactKeys(cmd, ADD_POLYLINE_KEYS) ||
            typeof cmd.aa !== "boolean" ||
            !isInt(cmd.n) ||
            cmd.n < 0 ||
            !isInt(cmd.colors) ||
            cmd.colors < 0 ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err(`a commands[] "${cmd.op}" entry is malformed`);
          }
        } else if (cmd.op === "add_circle") {
          if (
            !hasExactKeys(cmd, ADD_CIRCLE_KEYS) ||
            typeof cmd.aa !== "boolean" ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err('a commands[] "add_circle" entry is malformed');
          }
        } else if (cmd.op === "add_primitive" || cmd.op === "add_polygon") {
          if (
            !hasExactKeys(cmd, ADD_PRIMITIVE_KEYS) ||
            !(cmd.tex === null || (isInt(cmd.tex) && cmd.tex >= 1)) ||
            !isInt(cmd.n) ||
            cmd.n < 0 ||
            !isInt(cmd.colors) ||
            cmd.colors < 0 ||
            !isInt(cmd.uvs) ||
            cmd.uvs < 0 ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err(`a commands[] "${cmd.op}" entry is malformed`);
          }
        } else if (cmd.op === "add_triangle_array") {
          if (
            !hasExactKeys(cmd, ADD_TRIANGLE_ARRAY_KEYS) ||
            !(cmd.tex === null || (isInt(cmd.tex) && cmd.tex >= 1)) ||
            !isInt(cmd.n) ||
            cmd.n < 0 ||
            !isInt(cmd.colors) ||
            cmd.colors < 0 ||
            !isInt(cmd.uvs) ||
            cmd.uvs < 0 ||
            !isInt(cmd.indices) ||
            cmd.indices < 0 ||
            !isInt(cmd.count) ||
            !isInt(cmd.i) ||
            cmd.i < 0 ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err('a commands[] "add_triangle_array" entry is malformed');
          }
        } else if (cmd.op === "add_nine_patch") {
          if (
            !hasExactKeys(cmd, ADD_NINE_PATCH_KEYS) ||
            !(cmd.tex === null || (isInt(cmd.tex) && cmd.tex >= 1)) ||
            !isOneOf(cmd.x_axis, AXIS_STRETCH_MODES) ||
            !isOneOf(cmd.y_axis, AXIS_STRETCH_MODES) ||
            typeof cmd.draw_center !== "boolean" ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err('a commands[] "add_nine_patch" entry is malformed');
          }
        } else if (cmd.op === "add_mesh") {
          if (
            !hasExactKeys(cmd, ADD_MESH_KEYS) ||
            !isInt(cmd.mesh) ||
            cmd.mesh < 1 ||
            !(cmd.tex === null || (isInt(cmd.tex) && cmd.tex >= 1)) ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err('a commands[] "add_mesh" entry is malformed');
          }
        } else if (cmd.op === "add_set_transform") {
          if (
            !hasExactKeys(cmd, ADD_SET_TRANSFORM_KEYS) ||
            !isInt(cmd.f) ||
            cmd.f < 0
          ) {
            return err('a commands[] "add_set_transform" entry is malformed');
          }
        } else if (cmd.op === "add_clip_ignore") {
          if (
            !hasExactKeys(cmd, ADD_CLIP_IGNORE_KEYS) ||
            typeof cmd.ignore !== "boolean"
          ) {
            return err('a commands[] "add_clip_ignore" entry is malformed');
          }
        } else if (cmd.op === "unsupported") {
          if (
            !hasExactKeys(cmd, UNSUPPORTED_CMD_KEYS) ||
            typeof cmd.name !== "string" ||
            !isOneOf(cmd.reason, UNSUPPORTED_CMD_REASONS)
          ) {
            return err('a commands[] "unsupported" entry is malformed');
          }
        } else {
          return err(
            `a commands[] entry has an unknown op ${JSON.stringify(cmd.op)}`,
          );
        }
      }
    }
  }

  if (!Array.isArray(meta.textures)) return err('"textures" is not an array');
  for (const t of meta.textures) {
    const texErr = checkTextureEntrySchema(t, offset);
    if (texErr.length > 0) return texErr;
  }

  if (isV4) {
    if (!Array.isArray(meta.meshes)) return err('"meshes" is not an array');
    for (const m of meta.meshes) {
      const meshErr = checkMeshEntrySchema(m, offset);
      if (meshErr.length > 0) return meshErr;
    }
  }

  if (isV5) {
    if (!Array.isArray(meta.shaders)) return err('"shaders" is not an array');
    for (const s of meta.shaders) {
      const shaderErr = checkShaderEntrySchema(s, offset);
      if (shaderErr.length > 0) return shaderErr;
    }
    if (!Array.isArray(meta.materials))
      return err('"materials" is not an array');
    for (const m of meta.materials) {
      const materialErr = checkMaterialEntrySchema(m, offset);
      if (materialErr.length > 0) return materialErr;
    }
  }

  const blocksError = checkBlocksField(meta.blocks, offset);
  if (blocksError !== null) return [blocksError];
  const nameError = isV5
    ? checkFixedBlockNames(
        meta.blocks as BlockDescriptor[],
        TRANSACTION_BLOCK_NAMES_V5,
        offset,
        TRANSACTION_BLOCK_TYPES_V5,
      )
    : isV4
      ? checkFixedBlockNames(
          meta.blocks as BlockDescriptor[],
          TRANSACTION_BLOCK_NAMES_V4,
          offset,
          TRANSACTION_BLOCK_TYPES_V4,
        )
      : checkFixedBlockNames(
          meta.blocks as BlockDescriptor[],
          TRANSACTION_BLOCK_NAMES,
          offset,
        );
  if (nameError !== null) return [nameError];
  return [];
}

function checkResourceSchema(
  meta: Record<string, unknown>,
  offset: number,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: ${detail}`,
  ];
  if (!hasExactKeys(meta, RESOURCE_KEYS))
    return err("resource has the wrong top-level keys or order");
  if (!isLowerHex(meta.hash, 64))
    return err('"hash" is not 64 lowercase hex digits');
  if (!isInt(meta.bytes) || meta.bytes < 1)
    return err('"bytes" is not an integer >= 1');
  const blocksError = checkBlocksField(meta.blocks, offset);
  if (blocksError !== null) return [blocksError];
  const blocks = meta.blocks as BlockDescriptor[];
  if (
    blocks.length !== 1 ||
    blocks[0].name !== "payload" ||
    blocks[0].type !== "u8"
  ) {
    return err('"blocks" must be exactly one u8 block named "payload"');
  }
  if (blocks[0].count !== meta.bytes) {
    return err('the payload block\'s count disagrees with "bytes"');
  }
  return [];
}

function checkEndSchema(
  meta: Record<string, unknown>,
  offset: number,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: ${detail}`,
  ];
  if (!hasExactKeys(meta, END_KEYS))
    return err("end has the wrong top-level keys or order");
  if (!isInt(meta.transactions) || meta.transactions < 0)
    return err('"transactions" is not a non-negative integer');
  if (meta.reason !== "shutdown" && meta.reason !== "disarm")
    return err(`unknown reason ${JSON.stringify(meta.reason)}`);

  const stats = meta.stats;
  if (
    !isPlainObject(stats) ||
    !hasExactKeys(stats, STATS_KEYS) ||
    !isInt(stats.bytes_total) ||
    !isInt(stats.encode_ns_total) ||
    !isInt(stats.snapshot_ns_total) ||
    !isInt(stats.diff_ns_total) ||
    !isInt(stats.max_record_bytes) ||
    !isInt(stats.full_transactions) ||
    !isInt(stats.patch_transactions) ||
    !isInt(stats.resource_records) ||
    !isInt(stats.resource_bytes)
  ) {
    return err('"stats" has the wrong keys or a non-integer field');
  }

  if (!Array.isArray(meta.blocks) || meta.blocks.length !== 0)
    return err('"blocks" must be an empty array for an end record');
  return [];
}

function checkMetaSchema(
  meta: unknown,
  offset: number,
  version: 2 | 3 | 4 | 5 | 6 | 7,
): string[] {
  if (!isPlainObject(meta))
    return [
      `meta-schema: record at offset ${offset}: meta is not a JSON object`,
    ];
  if (meta.type === "session") return checkSessionSchema(meta, offset, version);
  if (meta.type === "transaction")
    return checkTransactionSchema(meta, offset, version);
  if (meta.type === "resource") return checkResourceSchema(meta, offset);
  if (meta.type === "end") return checkEndSchema(meta, offset);
  return [
    `meta-schema: record at offset ${offset}: unknown "type" ${JSON.stringify(meta.type)}`,
  ];
}

// --------------------------------------------------------------------------------------- splitRecords

export interface RawRecord {
  offset: number;
  byte_length: number;
  bytes: Uint8Array;
}

export function splitRecords(
  data: Uint8Array,
  version: 2 | 3 | 4 | 5 | 6 | 7 = 6,
): {
  records: RawRecord[];
  errors: string[];
} {
  const expectedMagic =
    version === 7
      ? MAGIC_V7
      : version === 6
        ? MAGIC_V6
        : version === 5
          ? MAGIC_V5
          : version === 4
            ? MAGIC_V4
            : version === 3
              ? MAGIC_V3
              : MAGIC;
  if (
    data.length < expectedMagic.length ||
    !bytesEqual(data.subarray(0, expectedMagic.length), expectedMagic)
  ) {
    const got = toHex(
      data.subarray(0, Math.min(expectedMagic.length, data.length)),
    );
    return {
      records: [],
      errors: [`bad-magic: expected ${toHex(expectedMagic)}, got ${got}`],
    };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records: RawRecord[] = [];
  let pos = expectedMagic.length;
  while (pos < data.length) {
    if (pos + 4 > data.length) {
      return {
        records,
        errors: [
          `truncated: record_len prefix at offset ${pos} runs past the end of the input`,
        ],
      };
    }
    const recordLen = view.getUint32(pos, true);
    const byteLength = 4 + recordLen;
    if (pos + byteLength > data.length) {
      return {
        records,
        errors: [
          `truncated: record at offset ${pos} declares ${byteLength} bytes but only ${data.length - pos} remain`,
        ],
      };
    }
    records.push({
      offset: pos,
      byte_length: byteLength,
      bytes: data.subarray(pos, pos + byteLength),
    });
    pos += byteLength;
  }
  return { records, errors: [] };
}

// --------------------------------------------------------------------------------------- decodeRecord

export type DecodedBlock = number[] | { u8_bytes: number; sha256: string };

export interface DecodedRecord {
  offset: number;
  byte_length: number;
  /** "" when `opts.recordDigest` is "deferred" and nothing has computed it yet (D31). */
  sha256: string;
  meta: Rs2Meta;
  blocks: DecodedBlock[];
}

/**
 * gate7-design.md D31/G7o1: the whole-record SHA-256 (`DecodedRecord.sha256`) is evidence only --
 * nothing compares it at receive time. "inline" (the default, byte-identical to before G7o1)
 * computes it eagerly, here. "deferred" skips that hash and leaves `sha256` as ""; the caller
 * (`createRecordingValidator`'s `digest()`) computes it later, off the frame path. Resource
 * payload hashes (the block loop above) are unaffected either way -- they are still verified
 * before use.
 */
export interface DecodeRecordOptions {
  recordDigest?: "inline" | "deferred";
}

type DecodeRecordResult = { record?: DecodedRecord; errors: string[] };

/** GRT4b: inside `withRecordMemo(data, fn)`, decodeRecord() decodes each record of `data` once
 * and hands every later caller the same result. A checker reads one recording through
 * validateRecording, resolveRecording and its own decode loop, each of which decoded (and
 * hashed) every record again; nothing mutates a decoded record. Off by default (the browser
 * decoder never enables it); dropped when `fn` returns, so it holds nothing past the scope. */
let recordMemo: {
  buffer: ArrayBufferLike;
  uses: number;
  decoded: Map<string, { result: DecodeRecordResult; left: number }>;
} | null = null;

/** `uses`: how many times the scope reads each record (the first decode included); a record read
 * that often is dropped from the memo, so a caller that reads record by record holds one. */
export function withRecordMemo<T>(
  data: Uint8Array,
  fn: () => T,
  uses = Number.POSITIVE_INFINITY,
): T {
  if (recordMemo) return fn();
  recordMemo = { buffer: data.buffer, uses, decoded: new Map() };
  try {
    return fn();
  } finally {
    recordMemo = null;
  }
}

export function decodeRecord(
  raw: RawRecord,
  version: 2 | 3 | 4 | 5 | 6 | 7 = 6,
  opts?: DecodeRecordOptions,
): DecodeRecordResult {
  const memo = recordMemo;
  if (!memo || raw.bytes.buffer !== memo.buffer)
    return decodeRecordOnce(raw, version, opts);
  const key = `${raw.offset}:${raw.byte_length}:${raw.bytes.byteOffset}:${raw.bytes.byteLength}:${version}:${opts?.recordDigest ?? "inline"}`;
  const hit = memo.decoded.get(key);
  if (!hit) {
    const result = decodeRecordOnce(raw, version, opts);
    if (memo.uses > 1) memo.decoded.set(key, { result, left: memo.uses - 1 });
    return result;
  }
  if (--hit.left <= 0) memo.decoded.delete(key);
  return hit.result;
}

function decodeRecordOnce(
  raw: RawRecord,
  version: 2 | 3 | 4 | 5 | 6 | 7,
  opts?: DecodeRecordOptions,
): DecodeRecordResult {
  const view = new DataView(
    raw.bytes.buffer,
    raw.bytes.byteOffset,
    raw.bytes.byteLength,
  );
  if (raw.bytes.length < 8) {
    return {
      errors: [
        `truncated: record at offset ${raw.offset} is shorter than its framing header`,
      ],
    };
  }
  const recordLen = view.getUint32(0, true);
  const metaLen = view.getUint32(4, true);
  let pos = 8;
  if (pos + metaLen > raw.bytes.length) {
    return {
      errors: [
        `truncated: meta at offset ${raw.offset + pos} runs past the end of the record`,
      ],
    };
  }
  const metaBytes = raw.bytes.subarray(pos, pos + metaLen);
  pos += metaLen;

  const metaText = bytesToAscii(metaBytes);
  if (metaText === null) {
    return {
      errors: [
        `meta-json: record at offset ${raw.offset}: meta contains a non-printable-ASCII byte`,
      ],
    };
  }
  let meta: unknown;
  try {
    meta = JSON.parse(metaText);
  } catch (e) {
    return {
      errors: [
        `meta-json: record at offset ${raw.offset}: ${(e as Error).message}`,
      ],
    };
  }

  const schemaErrors = checkMetaSchema(meta, raw.offset, version);
  if (schemaErrors.length > 0) return { errors: schemaErrors };
  if (JSON.stringify(meta) !== metaText) {
    return {
      errors: [
        `meta-noncanonical: record at offset ${raw.offset}: meta is not canonical JSON`,
      ],
    };
  }

  if (pos + 4 > raw.bytes.length) {
    return {
      errors: [
        `truncated: block_count at offset ${raw.offset + pos} runs past the end of the record`,
      ],
    };
  }
  const blockCount = view.getUint32(pos, true);
  pos += 4;
  const metaBlocks = (meta as { blocks: BlockDescriptor[] }).blocks;
  if (blockCount !== metaBlocks.length) {
    return {
      errors: [
        `record-length: record at offset ${raw.offset}: block_count ${blockCount} != meta.blocks.length ${metaBlocks.length}`,
      ],
    };
  }

  const blocks: DecodedBlock[] = [];
  for (let i = 0; i < blockCount; i++) {
    if (pos + 4 > raw.bytes.length) {
      return {
        errors: [
          `truncated: block ${i} length prefix at offset ${raw.offset + pos} runs past the end of the record`,
        ],
      };
    }
    const blockLen = view.getUint32(pos, true);
    pos += 4;
    const descriptor = metaBlocks[i];
    const expectedLen =
      descriptor.type === "f32" || descriptor.type === "i32"
        ? 4 * descriptor.count
        : descriptor.type === "f64"
          ? 8 * descriptor.count
          : descriptor.count;
    if (blockLen !== expectedLen) {
      return {
        errors: [
          `block-length: record at offset ${raw.offset} block "${descriptor.name}" declares count ${descriptor.count} (${expectedLen} bytes) but carries ${blockLen} bytes`,
        ],
      };
    }
    if (pos + blockLen > raw.bytes.length) {
      return {
        errors: [
          `truncated: block ${i} payload at offset ${raw.offset + pos} runs past the end of the record`,
        ],
      };
    }
    if (descriptor.type === "f32") {
      // GRT4b: sized once and filled, not grown by push (a third of the time).
      const floats = new Array<number>(descriptor.count);
      for (let f = 0; f < descriptor.count; f++)
        floats[f] = view.getFloat32(pos + f * 4, true);
      blocks.push(floats);
    } else if (descriptor.type === "i32") {
      // render-stream-4.md "Block type i32": little-endian two's-complement 32-bit integers.
      const ints = new Array<number>(descriptor.count);
      for (let f = 0; f < descriptor.count; f++)
        ints[f] = view.getInt32(pos + f * 4, true);
      blocks.push(ints);
    } else if (descriptor.type === "f64") {
      // render-stream-5.md "Block type f64": little-endian IEEE 754 binary64.
      const doubles = new Array<number>(descriptor.count);
      for (let f = 0; f < descriptor.count; f++)
        doubles[f] = view.getFloat64(pos + f * 8, true);
      blocks.push(doubles);
    } else {
      const payload = raw.bytes.subarray(pos, pos + blockLen);
      blocks.push({ u8_bytes: blockLen, sha256: hashBytes(payload) });
    }
    pos += blockLen;
  }

  if (pos !== raw.bytes.length || 4 + recordLen !== raw.byte_length) {
    return {
      errors: [
        `record-length: record at offset ${raw.offset}: decoded ${pos} bytes but the record is ${raw.bytes.length} bytes`,
      ],
    };
  }

  return {
    record: {
      offset: raw.offset,
      byte_length: raw.byte_length,
      sha256: opts?.recordDigest === "deferred" ? "" : hashBytes(raw.bytes),
      meta: meta as Rs2Meta,
      blocks,
    },
    errors: [],
  };
}

// --------------------------------------------------------------------------------------- decodeRecording

export function decodeRecording(
  data: Uint8Array,
  version: 2 | 3 | 4 | 5 | 6 | 7 = 6,
): {
  schema:
    | "render-stream-2-decoded/1"
    | "render-stream-3-decoded/1"
    | "render-stream-4-decoded/1"
    | "render-stream-5-decoded/1"
    | "render-stream-6-decoded/1"
    | "render-stream-7-decoded/1";
  magic: string;
  records: DecodedRecord[];
} {
  const split = splitRecords(data, version);
  if (split.errors.length > 0) throw new Error(split.errors[0]);
  const records: DecodedRecord[] = [];
  for (const raw of split.records) {
    const decoded = decodeRecord(raw, version);
    if (decoded.errors.length > 0 || decoded.record === undefined) {
      throw new Error(
        decoded.errors[0] ??
          `decodeRecord produced no record at offset ${raw.offset}`,
      );
    }
    records.push(decoded.record);
  }
  const magic =
    version === 7
      ? MAGIC_V7
      : version === 6
        ? MAGIC_V6
        : version === 5
          ? MAGIC_V5
          : version === 4
            ? MAGIC_V4
            : version === 3
              ? MAGIC_V3
              : MAGIC;
  return {
    schema:
      version === 7
        ? "render-stream-7-decoded/1"
        : version === 6
          ? "render-stream-6-decoded/1"
          : version === 5
            ? "render-stream-5-decoded/1"
            : version === 4
              ? "render-stream-4-decoded/1"
              : version === 3
                ? "render-stream-3-decoded/1"
                : "render-stream-2-decoded/1",
    magic: toHex(magic),
    records,
  };
}

// --------------------------------------------------------------------------------------- texture payload

export interface DecodedTexturePayload {
  format: string;
  width: number;
  height: number;
  mipmaps: boolean;
  data: Uint8Array;
}

// render-stream-2.md "Texture payload": GRT1 magic, u32 meta_len, canonical JSON meta, u32
// data_len (== meta.data_bytes), raw data. Throws "<code>: <detail>" on any decode failure
// (payload-magic, payload-meta, payload-length, payload-size).
export function decodeTexturePayload(bytes: Uint8Array): DecodedTexturePayload {
  if (bytes.length < 16 || !bytesEqual(bytes.subarray(0, 8), GRT1_MAGIC)) {
    throw new Error("payload-magic: the first 8 bytes are not the GRT1 magic");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(8, true);
  if (12 + metaLen + 4 > bytes.length) {
    throw new Error(
      "payload-length: meta_len runs past the end of the payload",
    );
  }
  const metaBytes = bytes.subarray(12, 12 + metaLen);
  const metaText = bytesToAscii(metaBytes);
  if (metaText === null) {
    throw new Error("payload-meta: meta contains a non-printable-ASCII byte");
  }
  let meta: unknown;
  try {
    meta = JSON.parse(metaText);
  } catch {
    throw new Error("payload-meta: meta is not valid JSON");
  }
  if (
    !isPlainObject(meta) ||
    !hasExactKeys(meta, [
      "type",
      "format",
      "width",
      "height",
      "mipmaps",
      "data_bytes",
    ]) ||
    meta.type !== "texture-2d" ||
    typeof meta.format !== "string" ||
    !isInt(meta.width) ||
    meta.width < 1 ||
    !isInt(meta.height) ||
    meta.height < 1 ||
    typeof meta.mipmaps !== "boolean" ||
    !isInt(meta.data_bytes) ||
    meta.data_bytes < 0
  ) {
    throw new Error(
      "payload-meta: meta has the wrong keys or an invalid field",
    );
  }
  if (JSON.stringify(meta) !== metaText) {
    throw new Error("payload-meta: meta is not canonical JSON");
  }
  const dataLenOffset = 12 + metaLen;
  const dataLen = view.getUint32(dataLenOffset, true);
  if (dataLen !== meta.data_bytes) {
    throw new Error("payload-length: data_len disagrees with meta.data_bytes");
  }
  const dataOffset = dataLenOffset + 4;
  if (dataOffset + dataLen !== bytes.length) {
    throw new Error("payload-length: the trailing bytes do not equal data_len");
  }
  const expected = expectedDataBytesOrNull(
    meta.format,
    meta.width,
    meta.height,
    meta.mipmaps,
  );
  if (expected !== null && expected !== dataLen) {
    throw new Error(
      `payload-size: data_bytes is ${dataLen}, expected ${expected} for ${meta.format} ${meta.width}x${meta.height} mipmaps=${meta.mipmaps}`,
    );
  }
  return {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    mipmaps: meta.mipmaps,
    data: bytes.subarray(dataOffset, dataOffset + dataLen),
  };
}

export function payloadSha256(bytes: Uint8Array): string {
  return hashBytes(bytes);
}

// Extracts a "resource" record's single u8 block's raw bytes directly from the raw record bytes
// (decodeRecord()'s own decoded form replaces a u8 block with {u8_bytes, sha256}, discarding the
// bytes -- render-stream-2.md "Decoded and resolved forms"). Assumes `raw` already passed
// decodeRecord()'s schema checks (exactly one u8 block named "payload").
function rawResourcePayload(raw: RawRecord): Uint8Array {
  const view = new DataView(
    raw.bytes.buffer,
    raw.bytes.byteOffset,
    raw.bytes.byteLength,
  );
  const metaLen = view.getUint32(4, true);
  let pos = 8 + metaLen;
  pos += 4; // block_count (always 1 for a resource record)
  pos += 4; // this block's length prefix
  return raw.bytes.subarray(pos, raw.bytes.length);
}

function mipChainTexelCount(
  width: number,
  height: number,
  mipmaps: boolean,
): number {
  let w = width;
  let h = height;
  let total = w * h;
  if (mipmaps) {
    while (w > 1 || h > 1) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      total += w * h;
    }
  }
  return total;
}

// render-stream-2.md "Texture payload": the expected data_bytes for a permitted format's shape,
// or null when `format` is not one of the six permitted uncompressed formats (no expected size
// is computed for any other Image.Format name).
export function expectedDataBytes(
  format: string,
  width: number,
  height: number,
  mipmaps: boolean,
): number {
  const pixelSize = PIXEL_SIZES[format];
  if (pixelSize === undefined) {
    throw new Error(`expectedDataBytes: "${format}" is not a permitted format`);
  }
  return pixelSize * mipChainTexelCount(width, height, mipmaps);
}

function expectedDataBytesOrNull(
  format: string,
  width: number,
  height: number,
  mipmaps: boolean,
): number | null {
  const pixelSize = PIXEL_SIZES[format];
  if (pixelSize === undefined) return null;
  return pixelSize * mipChainTexelCount(width, height, mipmaps);
}

// --------------------------------------------------------------------------------------- resolution engine

export interface ResolvedCommand {
  op:
    | "add_rect"
    | "add_texture_rect"
    | "add_texture_rect_region"
    | "add_msdf_texture_rect_region"
    | "add_line"
    | "add_polyline"
    | "add_multiline"
    | "add_circle"
    | "add_primitive"
    | "add_polygon"
    | "add_triangle_array"
    | "add_nine_patch"
    | "add_mesh"
    | "add_set_transform"
    | "add_clip_ignore"
    | "unsupported";
  aa?: boolean;
  tex?: number | null;
  tile?: boolean;
  transpose?: boolean;
  clip_uv?: boolean;
  outline?: number;
  rect?: [number, number, number, number];
  src?: [number, number, number, number];
  color?: [number, number, number, number];
  modulate?: [number, number, number, number];
  px_range?: number;
  scale?: number;
  name?: string;
  reason?: UnsupportedCmdReason;
  // --- new at /4 (render-stream-4.md "Decoded and resolved forms") ----------------------------
  from?: [number, number];
  to?: [number, number];
  colour?: [number, number, number, number];
  width?: number;
  points?: Array<[number, number]>;
  colors?: Array<[number, number, number, number]>;
  uvs?: Array<[number, number]>;
  position?: [number, number];
  radius?: number;
  count?: number;
  indices?: number[];
  source?: [number, number, number, number];
  margins?: [number, number, number, number];
  x_axis?: AxisStretchMode;
  y_axis?: AxisStretchMode;
  draw_center?: boolean;
  mesh?: number;
  transform?: [number, number, number, number, number, number];
  ignore?: boolean;
}

export interface ResolvedCanvas {
  id: number;
  origin: Origin;
  role: CanvasRole;
  attached: boolean;
  /** new at /6 (render-stream-6.md "Decoded and resolved forms"): present only when resolved at
   * version 6, right after attached and before items. */
  layer?: number;
  sublayer?: number;
  items: number[];
  xform: [number, number, number, number, number, number];
  /** new at /5 (render-stream-5.md "Canvas"): present only when resolved at version 5. */
  modulate?: [number, number, number, number];
}

/** render-stream-5.md "Decoded and resolved forms": a <param> resolves to {"name","type",
 * "value"}, with "value" a number (n=1, non-rid, non-nil), an array of numbers (a flat packed
 * scalar array), an array of arrays (a packed vector/color array, grouped by component count),
 * {"tex": <id>} (rid) or null (nil). */
export interface ResolvedParam {
  name: string;
  type: VariantType;
  value: number | number[] | number[][] | { tex: number } | null;
}

export interface ResolvedItem {
  id: number;
  origin: Origin;
  parent: { kind: ParentKind; id: number } | null;
  children: number[];
  visible: boolean;
  draw_index: number;
  z_index: number;
  z_relative: boolean;
  behind: boolean;
  clip: boolean;
  custom_rect: boolean;
  visibility_layer: number;
  texture_filter: Filter;
  texture_repeat: Repeat;
  /** new at /5 (render-stream-5.md "Item"): present only when resolved at version 5. */
  material?: number | null;
  use_parent_material?: boolean;
  instance_params?: ResolvedParam[];
  content_version: number;
  xform: [number, number, number, number, number, number];
  modulate: [number, number, number, number];
  self_modulate: [number, number, number, number];
  custom_rect_rect: [number, number, number, number];
  commands: ResolvedCommand[];
}

export type ResolvedTexture = TransactionTexture;

/** render-stream-4.md "Decoded and resolved forms": a mesh table entry with "f" replaced by its
 * lifted custom AABB. */
export interface ResolvedMesh {
  id: number;
  origin: "created";
  status: MeshStatus;
  reason: MeshReason | null;
  version: number;
  custom_aabb: [number, number, number, number, number, number];
  surfaces: TransactionMeshSurface[];
}

/** new at /5: a shader-table entry, unchanged in shape from the wire's (no floats to lift). */
export type ResolvedShader = TransactionShader;

/** new at /5: a material-table entry with its params resolved to {"name","type","value"}. */
export interface ResolvedMaterial {
  id: number;
  origin: "created";
  status: MaterialStatus;
  reason: MaterialReason | null;
  version: number;
  shader: number | null;
  params: ResolvedParam[];
}

export interface ResolvedState {
  canvases: Map<number, ResolvedCanvas>;
  items: Map<number, ResolvedItem>;
  textures: Map<number, ResolvedTexture>;
  meshes: Map<number, ResolvedMesh>;
  shaders: Map<number, ResolvedShader>;
  materials: Map<number, ResolvedMaterial>;
  default_texture_filter: Filter;
  default_texture_repeat: Repeat;
}

export function emptyResolvedState(): ResolvedState {
  return {
    canvases: new Map(),
    items: new Map(),
    textures: new Map(),
    meshes: new Map(),
    shaders: new Map(),
    materials: new Map(),
    default_texture_filter: "nearest",
    default_texture_repeat: "disabled",
  };
}

// render-stream-5.md "Decoded and resolved forms": lifts one <param> from the wire's {name,type,
// n,tex,f} into {name,type,value}, reading its floats out of paramF64 starting at `f`.
function liftParam(p: TransactionParam, paramF64: number[]): ResolvedParam {
  const components = VARIANT_COMPONENTS[p.type] ?? 0;
  let value: ResolvedParam["value"];
  if (p.type === "nil") {
    value = null;
  } else if (p.type === "rid") {
    value = { tex: p.tex as number };
  } else if (p.type.startsWith("packed_")) {
    const flat = paramF64.slice(p.f, p.f + p.n * components);
    value =
      components === 1
        ? flat
        : Array.from({ length: p.n }, (_, i) =>
            flat.slice(i * components, i * components + components),
          );
  } else {
    const flat = paramF64.slice(p.f, p.f + components);
    value = components === 1 ? flat[0] : flat;
  }
  return { name: p.name, type: p.type, value };
}

function liftShader(s: TransactionShader): ResolvedShader {
  return s;
}

function liftMaterial(
  m: TransactionMaterial,
  paramF64: number[],
): ResolvedMaterial {
  return {
    id: m.id,
    origin: m.origin,
    status: m.status,
    reason: m.reason,
    version: m.version,
    shader: m.shader,
    params: m.params.map((p) => liftParam(p, paramF64)),
  };
}

// `floats` is the canvas's full slice of canvas_f32: 6 floats (xform only) before /5, 10 at /5
// (xform 6, modulate 4 -- render-stream-5.md "Canvas").
function liftCanvas(c: TransactionCanvas, floats: number[]): ResolvedCanvas {
  const xform = floats.slice(0, 6) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // render-stream-6.md "Decoded and resolved forms": layer/sublayer are plain integers carried
  // straight from the wire's own TransactionCanvas (never block floats), spliced in right after
  // attached and before items to match the wire's key order exactly (statesEqual() is
  // JSON.stringify-based).
  const layerFields =
    c.layer !== undefined ? { layer: c.layer, sublayer: c.sublayer } : {};
  const out: ResolvedCanvas = {
    id: c.id,
    origin: c.origin,
    role: c.role,
    attached: c.attached,
    ...layerFields,
    items: c.items,
    xform,
  };
  if (floats.length >= 10) {
    out.modulate = floats.slice(6, 10) as [number, number, number, number];
  }
  return out;
}

function liftCommand(
  cmd: Command,
  cmdF32: number[],
  cmdI32: number[],
): ResolvedCommand {
  if (cmd.op === "add_rect") {
    const rect = cmdF32.slice(cmd.f, cmd.f + 4) as [
      number,
      number,
      number,
      number,
    ];
    const color = cmdF32.slice(cmd.f + 4, cmd.f + 8) as [
      number,
      number,
      number,
      number,
    ];
    return { op: "add_rect", aa: cmd.aa, rect, color };
  }
  if (cmd.op === "add_texture_rect") {
    const rect = cmdF32.slice(cmd.f, cmd.f + 4) as [
      number,
      number,
      number,
      number,
    ];
    const modulate = cmdF32.slice(cmd.f + 4, cmd.f + 8) as [
      number,
      number,
      number,
      number,
    ];
    return {
      op: "add_texture_rect",
      tex: cmd.tex,
      tile: cmd.tile,
      transpose: cmd.transpose,
      rect,
      modulate,
    };
  }
  if (cmd.op === "add_texture_rect_region") {
    const rect = cmdF32.slice(cmd.f, cmd.f + 4) as [
      number,
      number,
      number,
      number,
    ];
    const src = cmdF32.slice(cmd.f + 4, cmd.f + 8) as [
      number,
      number,
      number,
      number,
    ];
    const modulate = cmdF32.slice(cmd.f + 8, cmd.f + 12) as [
      number,
      number,
      number,
      number,
    ];
    return {
      op: "add_texture_rect_region",
      tex: cmd.tex,
      transpose: cmd.transpose,
      clip_uv: cmd.clip_uv,
      rect,
      src,
      modulate,
    };
  }
  if (cmd.op === "add_msdf_texture_rect_region") {
    // render-stream-3.md "Command": 14 floats (rect 4, src 4, modulate 4, px_range, scale).
    const rect = cmdF32.slice(cmd.f, cmd.f + 4) as [
      number,
      number,
      number,
      number,
    ];
    const src = cmdF32.slice(cmd.f + 4, cmd.f + 8) as [
      number,
      number,
      number,
      number,
    ];
    const modulate = cmdF32.slice(cmd.f + 8, cmd.f + 12) as [
      number,
      number,
      number,
      number,
    ];
    const pxRange = cmdF32[cmd.f + 12];
    const scale = cmdF32[cmd.f + 13];
    return {
      op: "add_msdf_texture_rect_region",
      tex: cmd.tex,
      outline: cmd.outline,
      rect,
      src,
      modulate,
      px_range: pxRange,
      scale,
    };
  }
  if (cmd.op === "add_line") {
    const from = cmdF32.slice(cmd.f, cmd.f + 2) as [number, number];
    const to = cmdF32.slice(cmd.f + 2, cmd.f + 4) as [number, number];
    const colour = cmdF32.slice(cmd.f + 4, cmd.f + 8) as [
      number,
      number,
      number,
      number,
    ];
    const width = cmdF32[cmd.f + 8];
    return { op: "add_line", aa: cmd.aa, from, to, colour, width };
  }
  if (cmd.op === "add_polyline" || cmd.op === "add_multiline") {
    const width = cmdF32[cmd.f];
    const points: Array<[number, number]> = [];
    let p = cmd.f + 1;
    for (let i = 0; i < cmd.n; i++, p += 2) {
      points.push(cmdF32.slice(p, p + 2) as [number, number]);
    }
    const colors: Array<[number, number, number, number]> = [];
    for (let i = 0; i < cmd.colors; i++, p += 4) {
      colors.push(cmdF32.slice(p, p + 4) as [number, number, number, number]);
    }
    return { op: cmd.op, aa: cmd.aa, width, points, colors };
  }
  if (cmd.op === "add_circle") {
    const position = cmdF32.slice(cmd.f, cmd.f + 2) as [number, number];
    const radius = cmdF32[cmd.f + 2];
    const colour = cmdF32.slice(cmd.f + 3, cmd.f + 7) as [
      number,
      number,
      number,
      number,
    ];
    return { op: "add_circle", aa: cmd.aa, position, radius, colour };
  }
  if (cmd.op === "add_primitive" || cmd.op === "add_polygon") {
    const points: Array<[number, number]> = [];
    let p = cmd.f;
    for (let i = 0; i < cmd.n; i++, p += 2) {
      points.push(cmdF32.slice(p, p + 2) as [number, number]);
    }
    const colors: Array<[number, number, number, number]> = [];
    for (let i = 0; i < cmd.colors; i++, p += 4) {
      colors.push(cmdF32.slice(p, p + 4) as [number, number, number, number]);
    }
    const uvs: Array<[number, number]> = [];
    for (let i = 0; i < cmd.uvs; i++, p += 2) {
      uvs.push(cmdF32.slice(p, p + 2) as [number, number]);
    }
    return { op: cmd.op, tex: cmd.tex, points, colors, uvs };
  }
  if (cmd.op === "add_triangle_array") {
    const points: Array<[number, number]> = [];
    let p = cmd.f;
    for (let i = 0; i < cmd.n; i++, p += 2) {
      points.push(cmdF32.slice(p, p + 2) as [number, number]);
    }
    const colors: Array<[number, number, number, number]> = [];
    for (let i = 0; i < cmd.colors; i++, p += 4) {
      colors.push(cmdF32.slice(p, p + 4) as [number, number, number, number]);
    }
    const uvs: Array<[number, number]> = [];
    for (let i = 0; i < cmd.uvs; i++, p += 2) {
      uvs.push(cmdF32.slice(p, p + 2) as [number, number]);
    }
    const indices = cmdI32.slice(cmd.i, cmd.i + cmd.indices);
    return {
      op: "add_triangle_array",
      tex: cmd.tex,
      count: cmd.count,
      points,
      colors,
      uvs,
      indices,
    };
  }
  if (cmd.op === "add_nine_patch") {
    const rect = cmdF32.slice(cmd.f, cmd.f + 4) as [
      number,
      number,
      number,
      number,
    ];
    const source = cmdF32.slice(cmd.f + 4, cmd.f + 8) as [
      number,
      number,
      number,
      number,
    ];
    const margins = cmdF32.slice(cmd.f + 8, cmd.f + 12) as [
      number,
      number,
      number,
      number,
    ];
    const modulate = cmdF32.slice(cmd.f + 12, cmd.f + 16) as [
      number,
      number,
      number,
      number,
    ];
    return {
      op: "add_nine_patch",
      tex: cmd.tex,
      rect,
      source,
      margins,
      x_axis: cmd.x_axis,
      y_axis: cmd.y_axis,
      draw_center: cmd.draw_center,
      modulate,
    };
  }
  if (cmd.op === "add_mesh") {
    const transform = cmdF32.slice(cmd.f, cmd.f + 6) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const modulate = cmdF32.slice(cmd.f + 6, cmd.f + 10) as [
      number,
      number,
      number,
      number,
    ];
    return {
      op: "add_mesh",
      mesh: cmd.mesh,
      tex: cmd.tex,
      transform,
      modulate,
    };
  }
  if (cmd.op === "add_set_transform") {
    const transform = cmdF32.slice(cmd.f, cmd.f + 6) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    return { op: "add_set_transform", transform };
  }
  if (cmd.op === "add_clip_ignore") {
    return { op: "add_clip_ignore", ignore: cmd.ignore };
  }
  return { op: "unsupported", name: cmd.name, reason: cmd.reason };
}

function commandFloatCount(cmd: Command): number {
  if (cmd.op === "add_rect" || cmd.op === "add_texture_rect") return 8;
  if (cmd.op === "add_texture_rect_region") return 12;
  if (cmd.op === "add_msdf_texture_rect_region") return 14;
  if (cmd.op === "add_line") return 9;
  if (cmd.op === "add_polyline" || cmd.op === "add_multiline") {
    return 1 + 2 * cmd.n + 4 * cmd.colors;
  }
  if (cmd.op === "add_circle") return 7;
  if (cmd.op === "add_primitive" || cmd.op === "add_polygon") {
    return 2 * cmd.n + 4 * cmd.colors + 2 * cmd.uvs;
  }
  if (cmd.op === "add_triangle_array")
    return 2 * cmd.n + 4 * cmd.colors + 2 * cmd.uvs;
  if (cmd.op === "add_nine_patch") return 16;
  if (cmd.op === "add_mesh") return 10;
  if (cmd.op === "add_set_transform") return 6;
  return 0;
}

function liftItem(
  it: TransactionItem,
  itemF32: number[],
  cmdF32: number[],
  cmdI32: number[],
  paramF64: number[],
): ResolvedItem {
  const base = {
    id: it.id,
    origin: it.origin,
    parent: it.parent,
    children: it.children,
    visible: it.visible,
    draw_index: it.draw_index,
    z_index: it.z_index,
    z_relative: it.z_relative,
    behind: it.behind,
    clip: it.clip,
    custom_rect: it.custom_rect,
    visibility_layer: it.visibility_layer,
    texture_filter: it.texture_filter,
    texture_repeat: it.texture_repeat,
  };
  // new at /5 (render-stream-5.md "Item"): material, use_parent_material, instance_params --
  // right after texture_repeat and before content_version, matching the wire's own key order
  // (render-stream-2-resolved/1's statesEqual() comparison is JSON.stringify-based, so key
  // ORDER, not just content, must match protocol/golden-5/make_golden.py's resolved_state()).
  // Spread in, rather than assigned after object construction, so JS's own key-insertion-order
  // rule places them correctly even though this function builds the object in one literal.
  const materialFields =
    it.material !== undefined
      ? {
          material: it.material,
          use_parent_material: it.use_parent_material,
          instance_params: (it.instance_params ?? []).map((p) =>
            liftParam(p, paramF64),
          ),
        }
      : {};
  return {
    ...base,
    ...materialFields,
    content_version: it.content_version,
    xform: itemF32.slice(0, 6) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ],
    modulate: itemF32.slice(6, 10) as [number, number, number, number],
    self_modulate: itemF32.slice(10, 14) as [number, number, number, number],
    custom_rect_rect: itemF32.slice(14, 18) as [number, number, number, number],
    commands:
      it.commands === null
        ? []
        : it.commands.map((c) => liftCommand(c, cmdF32, cmdI32)),
  };
}

// Applies one decoded transaction to `base`, per render-stream-2.md "Full and patch transactions":
// textures are treated like items (full table on a full transaction, upsert+remove on a patch),
// but every texture entry is complete on the wire (no null-commands-style partial form).
function liftMesh(m: TransactionMesh, meshF32: number[]): ResolvedMesh {
  const custom_aabb: [number, number, number, number, number, number] =
    m.f === null
      ? [0, 0, 0, 0, 0, 0]
      : (meshF32.slice(m.f, m.f + 6) as [
          number,
          number,
          number,
          number,
          number,
          number,
        ]);
  return {
    id: m.id,
    origin: m.origin,
    status: m.status,
    reason: m.reason,
    version: m.version,
    custom_aabb,
    surfaces: m.surfaces,
  };
}

export function applyTransaction(
  base: ResolvedState,
  meta: TransactionMeta,
  blocks: number[][],
): ResolvedState {
  const canvases =
    meta.encoding === "full"
      ? new Map<number, ResolvedCanvas>()
      : new Map(base.canvases);
  const items =
    meta.encoding === "full"
      ? new Map<number, ResolvedItem>()
      : new Map(base.items);
  const textures =
    meta.encoding === "full"
      ? new Map<number, ResolvedTexture>()
      : new Map(base.textures);
  const isV4 = meta.meshes !== undefined;
  const isV5 = meta.shaders !== undefined;
  const meshes =
    meta.encoding === "full"
      ? new Map<number, ResolvedMesh>()
      : new Map(base.meshes);
  const shaders =
    meta.encoding === "full"
      ? new Map<number, ResolvedShader>()
      : new Map(base.shaders);
  const materials =
    meta.encoding === "full"
      ? new Map<number, ResolvedMaterial>()
      : new Map(base.materials);
  if (meta.encoding === "patch") {
    for (const id of meta.removed_canvases) canvases.delete(id);
    for (const id of meta.removed_items) items.delete(id);
    for (const id of meta.removed_textures) textures.delete(id);
    if (isV4) for (const id of meta.removed_meshes ?? []) meshes.delete(id);
    if (isV5) {
      for (const id of meta.removed_shaders ?? []) shaders.delete(id);
      for (const id of meta.removed_materials ?? []) materials.delete(id);
    }
  }
  const [itemF32, canvasF32, cmdF32, cmdI32, meshF32, paramF64] = blocks;
  const canvasStride = isV5 ? 10 : 6;
  for (let i = 0; i < meta.canvases.length; i++) {
    const c = meta.canvases[i];
    canvases.set(
      c.id,
      liftCanvas(
        c,
        canvasF32.slice(i * canvasStride, i * canvasStride + canvasStride),
      ),
    );
  }
  // render-stream-5.md "Material table" (D8 "param-offset"): materials claim their param_f64
  // offsets before any item's instance_params, so lift them first.
  if (isV5) {
    for (const m of meta.materials ?? []) {
      materials.set(m.id, liftMaterial(m, paramF64 ?? []));
    }
  }
  for (let i = 0; i < meta.items.length; i++) {
    const raw = meta.items[i];
    const lifted = liftItem(
      raw,
      itemF32.slice(i * 18, i * 18 + 18),
      cmdF32,
      isV4 ? (cmdI32 ?? []) : [],
      isV5 ? (paramF64 ?? []) : [],
    );
    if (raw.commands === null) {
      const prev = base.items.get(raw.id);
      lifted.commands = prev ? prev.commands : [];
    }
    items.set(raw.id, lifted);
  }
  for (const t of meta.textures) {
    textures.set(t.id, t);
  }
  if (isV4) {
    for (const m of meta.meshes ?? []) {
      meshes.set(m.id, liftMesh(m, meshF32 ?? []));
    }
  }
  if (isV5) {
    for (const s of meta.shaders ?? []) {
      shaders.set(s.id, liftShader(s));
    }
  }
  return {
    canvases,
    items,
    textures,
    meshes,
    shaders,
    materials,
    default_texture_filter: meta.default_texture_filter,
    default_texture_repeat: meta.default_texture_repeat,
  };
}

export function sortedResolvedCanvases(state: ResolvedState): ResolvedCanvas[] {
  return [...state.canvases.values()].sort((a, b) => a.id - b.id);
}

export function sortedResolvedItems(state: ResolvedState): ResolvedItem[] {
  return [...state.items.values()].sort((a, b) => a.id - b.id);
}

export function sortedResolvedMeshes(state: ResolvedState): ResolvedMesh[] {
  return [...state.meshes.values()].sort((a, b) => a.id - b.id);
}

export function sortedResolvedShaders(state: ResolvedState): ResolvedShader[] {
  return [...state.shaders.values()].sort((a, b) => a.id - b.id);
}

export function sortedResolvedMaterials(
  state: ResolvedState,
): ResolvedMaterial[] {
  return [...state.materials.values()].sort((a, b) => a.id - b.id);
}

export function sortedResolvedTextures(
  state: ResolvedState,
): ResolvedTexture[] {
  return [...state.textures.values()].sort((a, b) => a.id - b.id);
}

// --------------------------------------------------------------------------------------- invariants

function checkIdOrdering(
  label: string,
  list: Array<{ id: number }>,
  offset: number,
): string[] {
  for (let i = 1; i < list.length; i++) {
    if (list[i].id === list[i - 1].id) {
      return [
        `duplicate-id: record at offset ${offset}: ${label} id ${list[i].id} repeats`,
      ];
    }
    if (list[i].id < list[i - 1].id) {
      return [
        `meta-schema: record at offset ${offset}: ${label} are not sorted by id ascending`,
      ];
    }
  }
  return [];
}

function checkIdListAscendingNoDup(
  label: string,
  ids: number[],
  offset: number,
): string[] {
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] <= ids[i - 1]) {
      return [
        `meta-schema: record at offset ${offset}: ${label} is not strictly ascending`,
      ];
    }
  }
  return [];
}

function textureEntryFieldErrors(
  t: TransactionTexture,
  offset: number,
): string[] {
  const err = (detail: string) => [
    `texture-entry: record at offset ${offset}: texture ${t.id}: ${detail}`,
  ];
  if (t.status === "freed") {
    if (
      t.hash !== null ||
      t.format !== null ||
      t.width !== 0 ||
      t.height !== 0 ||
      t.mipmaps !== false ||
      t.payload_bytes !== 0 ||
      t.canvas !== null ||
      t.reason !== null
    ) {
      return err(
        'a "freed" entry must have hash/format/canvas/reason null and width/height/payload_bytes 0, mipmaps false',
      );
    }
    return [];
  }
  if (t.kind === "image") {
    if (t.canvas !== null) return err('kind "image" must have canvas null');
    if (t.status === "ok") {
      if (
        t.hash === null ||
        t.format === null ||
        t.width < 1 ||
        t.height < 1 ||
        t.payload_bytes < 1 ||
        t.reason !== null
      ) {
        return err(
          'kind "image" status "ok" needs a hex hash, a format, width/height >= 1, payload_bytes >= 1 and reason null',
        );
      }
    } else {
      // unsupported
      if (t.hash !== null || t.payload_bytes !== 0 || t.reason === null) {
        return err(
          'kind "image" status "unsupported" needs hash null, payload_bytes 0 and a non-null reason',
        );
      }
    }
    return [];
  }
  if (t.kind === "placeholder") {
    if (
      t.hash !== null ||
      t.format !== null ||
      t.width !== 0 ||
      t.height !== 0 ||
      t.mipmaps !== false ||
      t.payload_bytes !== 0 ||
      t.canvas !== null
    ) {
      return err(
        'kind "placeholder" must have hash/format/canvas null and width/height/payload_bytes 0, mipmaps false',
      );
    }
    if (t.status === "ok" && t.reason !== null)
      return err('kind "placeholder" status "ok" must have reason null');
    if (t.status === "unsupported" && t.reason === null) {
      return err(
        'kind "placeholder" status "unsupported" must have a non-null reason',
      );
    }
    return [];
  }
  // kind === "canvas"
  if (
    t.hash !== null ||
    t.format !== null ||
    t.width !== 0 ||
    t.height !== 0 ||
    t.mipmaps !== false ||
    t.payload_bytes !== 0 ||
    t.canvas === null
  ) {
    return err(
      'kind "canvas" must have hash/format null, width/height/payload_bytes 0, mipmaps false, and a non-null canvas',
    );
  }
  if (t.status === "ok" && t.reason !== null)
    return err('kind "canvas" status "ok" must have reason null');
  if (t.status === "unsupported" && t.reason === null) {
    return err(
      'kind "canvas" status "unsupported" must have a non-null reason',
    );
  }
  return [];
}

// render-stream-2.md "Texture invariants (resolved state)" texture-version: "within one stream,
// an id's version never decreases; at an equal version the entry is identical except for a
// change to status: 'freed' and the nulls that implies".
function textureVersionRegressed(
  previous: TransactionTexture | undefined,
  current: TransactionTexture,
): boolean {
  if (previous === undefined) return false;
  if (current.version < previous.version) return true;
  if (current.version > previous.version) return false;
  if (statesEqual(previous, current)) return false;
  // Equal version, not identical: only a transition INTO "freed" from a non-freed status is
  // allowed, with the nulled freed shape.
  if (previous.status === "freed" || current.status !== "freed") return true;
  return false;
}

// render-stream-4.md "Mesh table" ("mesh-entry"): the same shape rule textureEntryFieldErrors()
// checks, mirrored for a mesh entry's status/reason/surfaces coupling. "f"/custom_aabb are
// checked separately (mesh-offset, over the running mesh_f32 offset) since they need the whole
// transaction's mesh list, not just one entry.
function meshEntryFieldErrors(m: ResolvedMesh, offset: number): string[] {
  const err = (detail: string) => [
    `mesh-entry: record at offset ${offset}: mesh ${m.id}: ${detail}`,
  ];
  if (m.status === "freed") {
    if (m.reason !== null || m.surfaces.length > 0) {
      return err('a "freed" entry must have reason null and surfaces []');
    }
    return [];
  }
  if (m.status === "unsupported") {
    if (m.reason === null || m.surfaces.length > 0) {
      return err(
        'an "unsupported" entry needs a non-null reason and surfaces []',
      );
    }
    return [];
  }
  // "ok"
  if (m.reason !== null) {
    return err('an "ok" entry must have reason null');
  }
  return [];
}

// render-stream-4.md "Mesh table" ("mesh-version"): the texture-version rule, mirrored for
// meshes -- within one stream, an id's version never decreases; at an equal version the entry is
// identical except for a transition into "freed".
// Compares the RESOLVED (lifted) mesh, not the raw wire TransactionMesh: "f" is a running offset
// into that transaction's own mesh_f32 block, so it legitimately differs between two
// transactions whose mesh2 content is byte-identical whenever some other mesh earlier in the
// table gains or loses its own "f" span (e.g. a sibling mesh is freed). Comparing custom_aabb's
// actual lifted values instead avoids flagging that as a content change.
function meshVersionRegressed(
  previous: ResolvedMesh | undefined,
  current: ResolvedMesh,
): boolean {
  if (previous === undefined) return false;
  if (current.version < previous.version) return true;
  if (current.version > previous.version) return false;
  if (statesEqual(previous, current)) return false;
  if (previous.status === "freed" || current.status !== "freed") return true;
  return false;
}

// render-stream-5.md "Shader table"/"Material table" ("shader-entry"/"material-entry"): status
// "ok" has reason null, "unsupported" has a non-null reason. checkShaderEntrySchema()/
// checkMaterialEntrySchema() already enforce this at the raw-wire level; these mirror it over the
// RESOLVED entry for symmetry with meshEntryFieldErrors(), though with the coupling already
// schema-enforced there is nothing further to find here except for completeness.
function shaderEntryFieldErrors(s: ResolvedShader, offset: number): string[] {
  const err = (detail: string) => [
    `shader-entry: record at offset ${offset}: shader ${s.id}: ${detail}`,
  ];
  if ((s.status === "ok") !== (s.reason === null)) {
    return err('"reason" must be null exactly for status "ok"');
  }
  return [];
}

function materialEntryFieldErrors(
  m: ResolvedMaterial,
  offset: number,
): string[] {
  const err = (detail: string) => [
    `material-entry: record at offset ${offset}: material ${m.id}: ${detail}`,
  ];
  if ((m.status === "ok") !== (m.reason === null)) {
    return err('"reason" must be null exactly for status "ok"');
  }
  return [];
}

// render-stream-5.md ("shader-version"/"material-version"): the texture-version rule, mirrored
// for shaders and materials -- within one stream, an id's version never decreases; at an equal
// version the entry is identical.
function shaderVersionRegressed(
  previous: ResolvedShader | undefined,
  current: ResolvedShader,
): boolean {
  if (previous === undefined) return false;
  if (current.version < previous.version) return true;
  if (current.version > previous.version) return false;
  return !statesEqual(previous, current);
}

function materialVersionRegressed(
  previous: ResolvedMaterial | undefined,
  current: ResolvedMaterial,
): boolean {
  if (previous === undefined) return false;
  if (current.version < previous.version) return true;
  if (current.version > previous.version) return false;
  return !statesEqual(previous, current);
}

function checkResolvedInvariants(
  meta: TransactionMeta,
  state: ResolvedState,
  offset: number,
  isV6 = false,
  snapDeclared = false,
): string[] {
  const where = `transaction seq ${meta.seq}`;
  const isV5 = meta.shaders !== undefined;
  const canvases = sortedResolvedCanvases(state);
  const items = sortedResolvedItems(state);
  const textures = sortedResolvedTextures(state);
  const meshes = sortedResolvedMeshes(state);
  const shaders = sortedResolvedShaders(state);
  const materials = sortedResolvedMaterials(state);
  const canvasIds = new Set(canvases.map((c) => c.id));
  // render-stream-6.md "Session-level unsupported reasons": canvas-stacking-tie is derived
  // whenever two ATTACHED canvases in this transaction's resolved table share (layer, sublayer)
  // -- the renderer would otherwise order them by canvas RID, which no receiver can reproduce.
  const stackingGroups = new Map<string, number>();
  if (isV6) {
    for (const c of canvases) {
      if (!c.attached) continue;
      const key = `${c.layer ?? 0}:${c.sublayer ?? 0}`;
      stackingGroups.set(key, (stackingGroups.get(key) ?? 0) + 1);
    }
  }
  const actualStackingTie = [...stackingGroups.values()].some((n) => n >= 2);
  const itemIds = new Set(items.map((i) => i.id));
  const textureIds = new Set(textures.map((t) => t.id));
  const textureById = new Map(textures.map((t) => [t.id, t] as const));
  const meshIds = new Set(meshes.map((m) => m.id));
  const shaderIds = new Set(shaders.map((s) => s.id));
  const materialIds = new Set(materials.map((m) => m.id));
  const materialById = new Map(materials.map((m) => [m.id, m] as const));

  for (const t of textures) {
    const fieldErrors = textureEntryFieldErrors(t, offset);
    if (fieldErrors.length > 0) return fieldErrors;
  }
  for (const m of meshes) {
    const fieldErrors = meshEntryFieldErrors(m, offset);
    if (fieldErrors.length > 0) return fieldErrors;
  }
  for (const s of shaders) {
    const fieldErrors = shaderEntryFieldErrors(s, offset);
    if (fieldErrors.length > 0) return fieldErrors;
  }
  for (const m of materials) {
    const fieldErrors = materialEntryFieldErrors(m, offset);
    if (fieldErrors.length > 0) return fieldErrors;
  }
  if (isV5) {
    // shader-ref: every material's non-null "shader" must name an entry in the resolved shader
    // table.
    for (const m of materials) {
      if (m.shader !== null && !shaderIds.has(m.shader)) {
        return [
          `shader-ref: ${where}: material ${m.id} names shader ${m.shader}, which has no entry`,
        ];
      }
    }
    // material-ref: every item's non-null "material" must name an entry in the resolved material
    // table.
    for (const item of items) {
      if (
        item.material !== undefined &&
        item.material !== null &&
        !materialIds.has(item.material)
      ) {
        return [
          `material-ref: ${where}: item ${item.id} names material ${item.material}, which has no entry`,
        ];
      }
    }
    // canvas-offset itself (canvas_f32 must carry 10 floats per canvas) is checked earlier, in
    // validateRecording(), alongside cmd-offset/mesh-offset/param-offset -- by the time
    // checkResolvedInvariants() runs, every resolved canvas is already known to carry a
    // `modulate` (liftCanvas() only omits it when its input slice is under 10 floats long, which
    // that earlier check already catches and reports first).
  }

  const roots = canvases.filter((c) => c.role === "root");
  if (roots.length !== 1 || roots[0].id !== 1) {
    return [
      `root-canvas: ${where}: expected exactly one canvas with role "root" and id 1`,
    ];
  }

  const claimedChildrenOf = new Map<string, number[]>();
  for (const item of items) {
    if (item.parent === null) continue;
    const key = `${item.parent.kind}:${item.parent.id}`;
    const exists =
      item.parent.kind === "canvas"
        ? canvasIds.has(item.parent.id)
        : itemIds.has(item.parent.id);
    if (!exists) {
      return [
        `dangling-parent: ${where}: item ${item.id} names parent ${key}, which does not exist`,
      ];
    }
    const list = claimedChildrenOf.get(key) ?? [];
    list.push(item.id);
    claimedChildrenOf.set(key, list);
  }
  const sameSet = (declared: number[], claimed: Set<number>): boolean =>
    declared.length === new Set(declared).size &&
    declared.length === claimed.size &&
    declared.every((id) => claimed.has(id));
  for (const canvas of canvases) {
    const claimed = new Set(claimedChildrenOf.get(`canvas:${canvas.id}`) ?? []);
    if (!sameSet(canvas.items, claimed)) {
      return [
        `child-list-mismatch: ${where}: canvas ${canvas.id}'s items[] disagrees with items' parent fields`,
      ];
    }
  }
  for (const item of items) {
    const claimed = new Set(claimedChildrenOf.get(`item:${item.id}`) ?? []);
    if (!sameSet(item.children, claimed)) {
      return [
        `child-list-mismatch: ${where}: item ${item.id}'s children[] disagrees with items' parent fields`,
      ];
    }
  }

  const byId = new Map(items.map((i) => [i.id, i] as const));
  for (const start of items) {
    const visited = new Set<number>([start.id]);
    let current: ResolvedItem = start;
    for (let steps = 0; steps <= items.length; steps++) {
      const parent = current.parent;
      if (parent === null || parent.kind === "canvas") break;
      const next = byId.get(parent.id);
      if (next === undefined) break;
      if (visited.has(next.id)) {
        return [
          `parent-cycle: ${where}: following parent links revisits item ${next.id}`,
        ];
      }
      visited.add(next.id);
      current = next;
    }
  }

  // texture-ref: every command's non-null tex, and every canvas texture's non-null diffuse, must
  // name an entry that exists in the resolved table; a diffuse must name an image or placeholder.
  // render-stream-4.md "Command": every new /4 op that carries a "tex" field follows the same
  // rule as the existing texture-rect ops.
  const TEX_BEARING_OPS = new Set([
    "add_texture_rect",
    "add_texture_rect_region",
    "add_msdf_texture_rect_region",
    "add_primitive",
    "add_polygon",
    "add_triangle_array",
    "add_nine_patch",
    "add_mesh",
  ]);
  for (const item of items) {
    for (const command of item.commands) {
      if (
        TEX_BEARING_OPS.has(command.op) &&
        command.tex !== null &&
        command.tex !== undefined
      ) {
        if (!textureIds.has(command.tex)) {
          return [
            `texture-ref: ${where}: item ${item.id}'s ${command.op} names texture ${command.tex}, which has no entry`,
          ];
        }
      }
    }
  }
  for (const t of textures) {
    if (t.canvas !== null && t.canvas.diffuse !== null) {
      const diffuse = textureById.get(t.canvas.diffuse);
      if (diffuse === undefined) {
        return [
          `texture-ref: ${where}: canvas texture ${t.id}'s diffuse names texture ${t.canvas.diffuse}, which has no entry`,
        ];
      }
      if (diffuse.kind !== "image" && diffuse.kind !== "placeholder") {
        return [
          `texture-ref: ${where}: canvas texture ${t.id}'s diffuse names texture ${diffuse.id}, whose kind is "${diffuse.kind}" (must be image or placeholder)`,
        ];
      }
    }
  }

  // mesh-ref (render-stream-4.md "Mesh table"): every add_mesh command's "mesh" id must name an
  // entry present in the resolved mesh table (any status -- a "freed" tombstone counts, since
  // something still names it).
  for (const item of items) {
    for (const command of item.commands) {
      if (command.op === "add_mesh" && command.mesh !== undefined) {
        if (!meshIds.has(command.mesh)) {
          return [
            `mesh-ref: ${where}: item ${item.id}'s add_mesh names mesh ${command.mesh}, which has no entry`,
          ];
        }
      }
    }
  }

  // Invariant 9: draw-index ties, over every container.
  const expectedTieItems = new Set<number>();
  const groupTies = (containerIds: number[]) => {
    const byDrawIndex = new Map<number, number[]>();
    for (const id of containerIds) {
      const it = byId.get(id);
      if (it === undefined) continue;
      const list = byDrawIndex.get(it.draw_index) ?? [];
      list.push(id);
      byDrawIndex.set(it.draw_index, list);
    }
    for (const group of byDrawIndex.values()) {
      const drawing = group.filter((id) => {
        const it = byId.get(id);
        return (
          it !== undefined && (it.commands.length > 0 || it.children.length > 0)
        );
      });
      if (drawing.length >= 2) {
        expectedTieItems.add(Math.min(...drawing));
      }
    }
  };
  for (const canvas of canvases) groupTies(canvas.items);
  for (const item of items) groupTies(item.children);

  // Expected derived unsupported[] entries: unsupported-op / unknown-texture / unknown-mesh /
  // skinned-geometry (one per distinct (item, op) pair with a matching command-level
  // `unsupported` entry), unsupported-texture (one per distinct (item, op) pair whose
  // tex-bearing command names an unsupported texture entry) and unsupported-mesh (one per
  // distinct (item, "canvas_item_add_mesh") pair whose add_mesh names an unsupported mesh).
  const RS_METHOD_FOR_OP: Record<string, string> = {
    add_texture_rect: "canvas_item_add_texture_rect",
    add_texture_rect_region: "canvas_item_add_texture_rect_region",
    add_msdf_texture_rect_region: "canvas_item_add_msdf_texture_rect_region",
    add_primitive: "canvas_item_add_primitive",
    add_polygon: "canvas_item_add_polygon",
    add_triangle_array: "canvas_item_add_triangle_array",
    add_nine_patch: "canvas_item_add_nine_patch",
    add_mesh: "canvas_item_add_mesh",
  };
  const actualUnsupportedOps = new Map<string, UnsupportedReason>();
  const actualUnsupportedTexture = new Set<string>();
  const actualUnsupportedMesh = new Set<string>();
  // new at /5 (render-stream-5.md "Derived item-level entries"): unsupported-material is the
  // only one of the three new derived reasons that is independently reconstructable from the
  // resolved state (an item's effective material -- D9's use_parent_material walk, below; G55w
  // checked the item's own "material" only, G55d made it the effective one -- is unsupported, names an
  // unsupported shader, or names a texture parameter or default texture whose entry is
  // unsupported). unknown-material and the instance param-type entry both describe a value the
  // wire could not represent at all (an unknown RID, an unsupported-typed parameter), so there is
  // no independent "actual" signal to cross-check them against; those two are checked forward-
  // only (the referenced item exists, and -- for unknown-material -- its resolved "material" is
  // null) below, in the per-entry loop.
  const actualUnsupportedMaterial = new Set<string>();
  // G55d (gate5_5-design.md D9, Q4 "Derived item-level entries"): the EFFECTIVE material, as the
  // engine's _update_dirty_item walks it (renderer_canvas_cull.cpp:2514-2525): an item with
  // use_parent_material takes its item parent's material, continuing up while that parent also
  // has use_parent_material; a top-level item (parent a canvas or none) keeps its own.
  const effectiveMaterial = (item: (typeof items)[number]): number | null => {
    let material = item.material ?? null;
    if (!item.use_parent_material) return material;
    let parent = item.parent;
    const seen = new Set<number>([item.id]);
    while (parent !== null && parent.kind === "item" && !seen.has(parent.id)) {
      seen.add(parent.id);
      const p = byId.get(parent.id);
      if (p === undefined) break;
      material = p.material ?? null;
      if (!p.use_parent_material) break;
      parent = p.parent;
    }
    return material;
  };
  if (isV5) {
    for (const item of items) {
      const effective = effectiveMaterial(item);
      if (effective === null) continue;
      const mat = materialById.get(effective);
      if (mat === undefined) continue;
      let unsupported = mat.status === "unsupported";
      if (!unsupported && mat.shader !== null) {
        const shaderEntry = state.shaders.get(mat.shader);
        if (shaderEntry !== undefined) {
          if (shaderEntry.status === "unsupported") unsupported = true;
          for (const d of shaderEntry.default_textures) {
            if (textureById.get(d.tex)?.status === "unsupported")
              unsupported = true;
          }
        }
      }
      for (const p of mat.params) {
        if (
          p.type === "rid" &&
          p.value !== null &&
          typeof p.value === "object" &&
          "tex" in p.value &&
          textureById.get(p.value.tex)?.status === "unsupported"
        ) {
          unsupported = true;
        }
      }
      if (unsupported) {
        actualUnsupportedMaterial.add(`${item.id}:canvas_item_set_material`);
      }
    }
  }
  for (const item of items) {
    const seenOps = new Set<string>();
    for (const command of item.commands) {
      if (command.op === "unsupported" && command.name !== undefined) {
        if (!seenOps.has(command.name)) {
          seenOps.add(command.name);
          const reason: UnsupportedReason =
            command.reason === "unknown-texture" ||
            command.reason === "canvas-texture-headless" ||
            command.reason === "unknown-mesh" ||
            command.reason === "skinned-geometry"
              ? command.reason
              : "unsupported-op";
          actualUnsupportedOps.set(`${item.id}:${command.name}`, reason);
        }
      }
      if (
        TEX_BEARING_OPS.has(command.op) &&
        command.tex !== null &&
        command.tex !== undefined
      ) {
        const target = textureById.get(command.tex);
        const unsupportedViaDiffuse =
          target !== undefined &&
          target.kind === "canvas" &&
          target.canvas !== null &&
          target.canvas.diffuse !== null &&
          textureById.get(target.canvas.diffuse)?.status === "unsupported";
        if (
          (target !== undefined && target.status === "unsupported") ||
          unsupportedViaDiffuse
        ) {
          // The derived entry's `op` is the RenderingServer method name, not the wire command's
          // own op (render-stream-2.md "Item-level unsupported entries").
          const rsMethod = RS_METHOD_FOR_OP[command.op];
          actualUnsupportedTexture.add(`${item.id}:${rsMethod}`);
        }
      }
      if (command.op === "add_mesh" && command.mesh !== undefined) {
        const target = state.meshes.get(command.mesh);
        if (target !== undefined && target.status === "unsupported") {
          actualUnsupportedMesh.add(`${item.id}:canvas_item_add_mesh`);
        }
      }
    }
  }

  let lastItem = -1;
  let lastOp = "";
  let itemLevelStarted = false;
  const declaredUnsupportedOps = new Set<string>();
  const declaredTieItems = new Set<number>();
  const declaredUnsupportedTexture = new Set<string>();
  const declaredUnsupportedMesh = new Set<string>();
  const declaredUnsupportedMaterial = new Set<string>();
  let declaredStackingTie = false;
  let declaredSnap2d = false;
  for (const entry of meta.unsupported) {
    if (entry.item === null) {
      if (itemLevelStarted) {
        return [
          `unsupported-mismatch: ${where}: session-level entry ${entry.op} follows an item-level entry`,
        ];
      }
      // new at /5: the sticky canvas-light entry (gate5_5-design.md D10) has no independent
      // "actual" signal to cross-check against -- forward-only (well-formedness) is all this
      // validator can do.
      if (
        entry.reason === "canvas-light" &&
        entry.op !== "canvas_light_attach_to_canvas"
      ) {
        return [
          `unsupported-mismatch: ${where}: canvas-light entry names op ${entry.op}, expected canvas_light_attach_to_canvas`,
        ];
      }
      // render-stream-6.md "Session-level unsupported reasons": extra-canvas never legitimately
      // occurs at /6 (a canvas attached to the root viewport is supported) -- /6 decoders reject
      // it outright, exactly as /5 rejects unsupported-state naming canvas_item_set_material.
      if (isV6 && entry.reason === "extra-canvas") {
        return [
          `unsupported-mismatch: ${where}: extra-canvas entry (op ${entry.op}) is never valid at /6 (a canvas attached to the root viewport is supported)`,
        ];
      }
      if (entry.reason === "canvas-stacking-tie") {
        if (entry.op !== "viewport_set_canvas_stacking") {
          return [
            `unsupported-mismatch: ${where}: canvas-stacking-tie entry names op ${entry.op}, expected viewport_set_canvas_stacking`,
          ];
        }
        if (!actualStackingTie) {
          return [
            `unsupported-mismatch: ${where}: canvas-stacking-tie entry does not correspond to two attached canvases sharing (layer, sublayer)`,
          ];
        }
        declaredStackingTie = true;
      } else if (entry.reason === "canvas-repeat") {
        // Sticky, like canvas-light: no independent "actual" signal (the mirroring/repeat vector
        // never reaches the wire).
        if (
          entry.op !== "canvas_set_item_mirroring" &&
          entry.op !== "canvas_set_item_repeat"
        ) {
          return [
            `unsupported-mismatch: ${where}: canvas-repeat entry names op ${entry.op}, expected canvas_set_item_mirroring or canvas_set_item_repeat`,
          ];
        }
      } else if (entry.reason === "canvas-follow-viewport") {
        // Sticky, like canvas-light: no independent "actual" signal (the parent RID never
        // reaches the wire).
        if (entry.op !== "canvas_set_parent") {
          return [
            `unsupported-mismatch: ${where}: canvas-follow-viewport entry names op ${entry.op}, expected canvas_set_parent`,
          ];
        }
      } else if (entry.reason === "global-canvas-transform") {
        // NOT sticky, but still forward-only: the live global canvas transform itself is never
        // wire-visible, only the session's one arm-time host_final_xform snapshot.
        if (entry.op !== "viewport_set_global_canvas_transform") {
          return [
            `unsupported-mismatch: ${where}: global-canvas-transform entry names op ${entry.op}, expected viewport_set_global_canvas_transform`,
          ];
        }
      } else if (entry.reason === "snap-2d") {
        if (
          entry.op !== "viewport_set_snap_2d_transforms_to_pixel" &&
          entry.op !== "viewport_set_snap_2d_vertices_to_pixel"
        ) {
          return [
            `unsupported-mismatch: ${where}: snap-2d entry names op ${entry.op}, expected a viewport_set_snap_2d_*_to_pixel setter`,
          ];
        }
        if (!snapDeclared) {
          return [
            `unsupported-mismatch: ${where}: snap-2d entry present while the session declares no snap_2d flag`,
          ];
        }
        declaredSnap2d = true;
      }
      continue;
    }
    itemLevelStarted = true;
    if (!itemIds.has(entry.item)) {
      return [
        `dangling-parent: ${where}: unsupported entry names item ${entry.item}, which does not exist`,
      ];
    }
    if (
      entry.item < lastItem ||
      (entry.item === lastItem && entry.op <= lastOp)
    ) {
      return [
        `unsupported-mismatch: ${where}: unsupported entry (${entry.item}, ${entry.op}) is out of order or repeated`,
      ];
    }
    lastItem = entry.item;
    lastOp = entry.op;
    if (
      entry.reason === "unsupported-op" ||
      entry.reason === "unknown-texture" ||
      entry.reason === "canvas-texture-headless" ||
      entry.reason === "unknown-mesh" ||
      entry.reason === "skinned-geometry"
    ) {
      const pair = `${entry.item}:${entry.op}`;
      const expected = actualUnsupportedOps.get(pair);
      if (expected === undefined || expected !== entry.reason) {
        return [
          `unsupported-mismatch: ${where}: ${entry.reason} entry (${entry.item}, ${entry.op}) has no matching command`,
        ];
      }
      declaredUnsupportedOps.add(pair);
    } else if (entry.reason === "draw-index-tie") {
      if (entry.op !== "canvas_item_set_draw_index") {
        return [
          `unsupported-mismatch: ${where}: draw-index-tie entry for item ${entry.item} names op ${entry.op}, expected canvas_item_set_draw_index`,
        ];
      }
      if (!expectedTieItems.has(entry.item)) {
        return [
          `unsupported-mismatch: ${where}: draw-index-tie entry for item ${entry.item} does not correspond to an actual tie`,
        ];
      }
      declaredTieItems.add(entry.item);
    } else if (entry.reason === "unsupported-state") {
      // unsupported-state covers canvas_item_set_material (/2-/4) and, new at /4, calibrator-7's
      // canvas_item_attach_skeleton (render-stream-4.md "Decoders accept 'unsupported-state'
      // for canvas_item_attach_skeleton as well as canvas_item_set_material"). render-stream-5.md
      // "Derived item-level entries": /4's unsupported-state for canvas_item_set_material no
      // longer occurs at /5 (superseded by item-level material state), and /5 decoders reject it.
      if (isV5 && entry.op === "canvas_item_set_material") {
        return [
          `unsupported-mismatch: ${where}: unsupported-state entry for item ${entry.item} names canvas_item_set_material, which /5 decoders reject (superseded by unsupported-material/unknown-material)`,
        ];
      }
      if (
        entry.op !== "canvas_item_set_material" &&
        entry.op !== "canvas_item_attach_skeleton"
      ) {
        return [
          `unsupported-mismatch: ${where}: unsupported-state entry for item ${entry.item} names ${entry.op}, expected canvas_item_set_material or canvas_item_attach_skeleton`,
        ];
      }
    } else if (entry.reason === "unsupported-texture") {
      const pair = `${entry.item}:${entry.op}`;
      if (!actualUnsupportedTexture.has(pair)) {
        return [
          `unsupported-mismatch: ${where}: unsupported-texture entry (${entry.item}, ${entry.op}) does not correspond to a command naming an unsupported texture`,
        ];
      }
      declaredUnsupportedTexture.add(pair);
    } else if (entry.reason === "unsupported-mesh") {
      const pair = `${entry.item}:${entry.op}`;
      if (!actualUnsupportedMesh.has(pair)) {
        return [
          `unsupported-mismatch: ${where}: unsupported-mesh entry (${entry.item}, ${entry.op}) does not correspond to an add_mesh naming an unsupported mesh`,
        ];
      }
      declaredUnsupportedMesh.add(pair);
    } else if (entry.reason === "unsupported-material") {
      if (entry.op !== "canvas_item_set_material") {
        return [
          `unsupported-mismatch: ${where}: unsupported-material entry for item ${entry.item} names ${entry.op}, expected canvas_item_set_material`,
        ];
      }
      const pair = `${entry.item}:${entry.op}`;
      if (!actualUnsupportedMaterial.has(pair)) {
        return [
          `unsupported-mismatch: ${where}: unsupported-material entry (${entry.item}, ${entry.op}) does not correspond to an item whose effective material is unsupported`,
        ];
      }
      declaredUnsupportedMaterial.add(pair);
    } else if (entry.reason === "unknown-material") {
      // No independent "actual" signal exists for this reason (see the comment above
      // actualUnsupportedMaterial): forward-only. The referenced item's resolved "material"
      // must be null, matching Q3b's "an unknown non-null RID -> material: null".
      if (entry.op !== "canvas_item_set_material") {
        return [
          `unsupported-mismatch: ${where}: unknown-material entry for item ${entry.item} names ${entry.op}, expected canvas_item_set_material`,
        ];
      }
      const item = byId.get(entry.item);
      if (
        item !== undefined &&
        item.material !== undefined &&
        item.material !== null
      ) {
        return [
          `unsupported-mismatch: ${where}: unknown-material entry for item ${entry.item}, whose resolved material is non-null`,
        ];
      }
    } else if (entry.reason === "param-type") {
      // Likewise forward-only: an instance parameter of an unsupported type is never carried in
      // instance_params at all.
      if (entry.op !== "canvas_item_set_instance_shader_parameter") {
        return [
          `unsupported-mismatch: ${where}: param-type entry for item ${entry.item} names ${entry.op}, expected canvas_item_set_instance_shader_parameter`,
        ];
      }
    }
  }
  for (const [pair, reason] of actualUnsupportedOps) {
    if (!declaredUnsupportedOps.has(pair)) {
      return [
        `unsupported-mismatch: ${where}: ${reason} command (${pair.replace(":", ", ")}) has no matching unsupported[] entry`,
      ];
    }
  }
  for (const id of expectedTieItems) {
    if (!declaredTieItems.has(id)) {
      return [
        `unsupported-mismatch: ${where}: items tie on draw_index under item/canvas with smallest id ${id}, but no draw-index-tie entry is declared`,
      ];
    }
  }
  for (const pair of actualUnsupportedTexture) {
    if (!declaredUnsupportedTexture.has(pair)) {
      return [
        `unsupported-mismatch: ${where}: tex-bearing command (${pair.replace(":", ", ")}) names an unsupported texture, with no unsupported-texture entry`,
      ];
    }
  }
  for (const pair of actualUnsupportedMesh) {
    if (!declaredUnsupportedMesh.has(pair)) {
      return [
        `unsupported-mismatch: ${where}: add_mesh command (${pair.replace(":", ", ")}) names an unsupported mesh, with no unsupported-mesh entry`,
      ];
    }
  }
  for (const pair of actualUnsupportedMaterial) {
    if (!declaredUnsupportedMaterial.has(pair)) {
      return [
        `unsupported-mismatch: ${where}: item (${pair.replace(":", ", ")})'s effective material is unsupported, with no unsupported-material entry`,
      ];
    }
  }
  if (actualStackingTie && !declaredStackingTie) {
    return [
      `unsupported-mismatch: ${where}: two attached canvases share (layer, sublayer), but no canvas-stacking-tie entry is declared`,
    ];
  }
  if (snapDeclared && !declaredSnap2d) {
    return [
      `unsupported-mismatch: ${where}: the session declares a snap_2d flag, but this transaction has no snap-2d entry`,
    ];
  }

  return [];
}

// --------------------------------------------------------------------------------------- validateRecording

/**
 * The incremental form of `validateRecording` (G7d, gate7-design.md Q13e: a receiver validates one
 * record per message, so the bench times validation per transaction). `records[0]` must be the
 * session record; `accept(i)` validates record `i` against everything accepted before it and
 * returns its first error, or undefined. Call it for i = 1, 2, ... in order, never twice for one
 * index; `records` may grow between calls (a live caller appends each message's record). `finish()`
 * is the end-of-stream verdict. `errors` is set when the session record itself is invalid, and then
 * both methods return it. `validateRecording` is exactly this over a whole file.
 *
 * D31/G7o1: `digestPending()` lists accepted record indices with no whole-record SHA-256 yet
 * ("inline" mode: always `[]`, the digest is already known from `accept`'s own decode). `digest(i)`
 * returns record `i`'s digest, computing and caching it first if needed (both modes; cheap in
 * "inline", the deferred hash in "deferred"). Call `digest` for every accepted index, then
 * `checkRecordDigestComplete` (below), before writing evidence.
 */
export interface RecordingValidator {
  errors: string[] | null;
  accept(index: number): string[] | undefined;
  finish(): string[];
  digestPending(): number[];
  digest(index: number): string;
}

/**
 * D31 "record-digest-complete": every record a `RecordingValidator` accepted must have a digest
 * before evidence is written. Returns `[]` when that holds, else one `record-digest-complete`
 * error naming the still-pending indices. The sabotage `digest-skip` (never calling `digest()` for
 * one accepted record) must fail exactly this check.
 */
export function checkRecordDigestComplete(
  validator: RecordingValidator,
): string[] {
  const pending = validator.digestPending();
  return pending.length === 0
    ? []
    : [
        `record-digest-complete: ${pending.length} accepted record(s) have no digest yet (indices ${pending.join(", ")})`,
      ];
}

/**
 * G7d bench seam (gate7-design.md Q13e): when set, `RecordingValidator.accept` adds the time it
 * spends in `decodeRecord` (framing a record's meta and blocks, hashing included) to `decode_us`
 * and in `applyTransaction` (patch resolution) to `resolve_us`, read from `now()` (microseconds).
 * Null by default: then each phase costs one null check. The bench's validate time is accept's
 * total minus both.
 */
export interface ValidatorPhaseTimer {
  now(): number;
  decode_us: number;
  resolve_us: number;
}

let validatorPhaseTimer: ValidatorPhaseTimer | null = null;

export function setValidatorPhaseTimer(
  timer: ValidatorPhaseTimer | null,
): void {
  validatorPhaseTimer = timer;
}

export function createRecordingValidator(
  records: RawRecord[],
  version: 2 | 3 | 4 | 5 | 6 | 7 = 6,
  options?: DecodeRecordOptions,
): RecordingValidator {
  const recordDigest = options?.recordDigest ?? "inline";
  const rejected = (errors: string[]): RecordingValidator => ({
    errors,
    accept: () => errors,
    finish: () => errors,
    digestPending: () => [],
    digest: (i: number) => hashBytes(records[i].bytes),
  });
  // isV6 means "V6 or later" (render-stream-7.md: transactions/items/commands/invariants are
  // byte-identical to /6).
  const isV7 = version === 7;
  const isV6 = isV7 || version === 6;
  // isV5 means "V5 or later" (render-stream-6.md: transactions/items/commands are byte-identical
  // to /5).
  const isV5 = isV6 || version === 5;
  const isV4 = isV5 || version === 4;
  if (records.length === 0)
    return rejected(["missing-session: the recording has no records"]);

  const first = decodeRecord(records[0], version);
  if (first.errors.length > 0 || first.record === undefined)
    return rejected([first.errors[0]]);
  const sessionMeta = first.record.meta;
  if (sessionMeta.type !== "session")
    return rejected([
      `missing-session: the first record has type "${sessionMeta.type}"`,
    ]);
  if (sessionMeta.viewport.root_canvas !== 1) {
    return rejected([
      `root-canvas: session.viewport.root_canvas is ${sessionMeta.viewport.root_canvas}, not 1`,
    ]);
  }
  const inlineMaxBytes = sessionMeta.resources.inline_max_bytes;
  // render-stream-6.md "Viewport"/gate6-design.md Q3a: host_size_status must be consistent with
  // host_window_size, presentation_size and the host_visible_rect session block ("match" iff
  // host_window_size == presentation_size and the visible rect's size equals logical_size;
  // "degenerate-visible" iff the visible size differs from logical_size; "degenerate-window"
  // otherwise). Needs the decoded host_visible_rect block (session blocks: clear_color[0],
  // root_canvas_xform[1], host_visible_rect[2], host_final_xform[3], content_scale_factor[4]),
  // so this can only be checked here, once the session record is fully decoded.
  if (isV6) {
    const hostVisibleRect = first.record.blocks[2] as number[];
    const visibleSize: [number, number] = [
      hostVisibleRect[2],
      hostVisibleRect[3],
    ];
    const logicalSize = sessionMeta.viewport.logical_size;
    const presentationSize =
      sessionMeta.viewport.presentation_size ??
      sessionMeta.viewport.logical_size;
    const hostWindowSize = sessionMeta.viewport.host_window_size;
    const samePair = (a: [number, number], b: [number, number]) =>
      a[0] === b[0] && a[1] === b[1];
    const expectedStatus =
      samePair(hostWindowSize, presentationSize) &&
      samePair(visibleSize, logicalSize)
        ? "match"
        : !samePair(visibleSize, logicalSize)
          ? "degenerate-visible"
          : "degenerate-window";
    if (sessionMeta.viewport.host_size_status !== expectedStatus) {
      return rejected([
        `viewport-entry: session.viewport.host_size_status is "${sessionMeta.viewport.host_size_status}", expected "${expectedStatus}" from host_window_size/presentation_size/host_visible_rect`,
      ]);
    }
  }
  // render-stream-6.md "Session-level unsupported reasons": snap-2d is a session-level constant
  // (D17's setters are unhooked, so only the arm-time value is ever known), checked against every
  // transaction of the stream.
  const snapDeclared =
    isV6 &&
    (sessionMeta.viewport.snap_2d?.transforms === true ||
      sessionMeta.viewport.snap_2d?.vertices === true);

  let bytesTotal = MAGIC.length + first.record.byte_length;
  let maxRecordBytes = first.record.byte_length;
  let transactionCount = 0;
  let fullCount = 0;
  let patchCount = 0;
  let resourceRecordCount = 0;
  let resourceByteTotal = 0;
  let prevSeq = 0;
  let prevFrame = -Infinity;
  let state = emptyResolvedState();
  const maxIdSeen = {
    canvas: 0,
    item: 0,
    texture: 0,
    mesh: 0,
    shader: 0,
    material: 0,
  };
  const carriedHashes = new Set<string>();
  const lastSeenTexture = new Map<number, TransactionTexture>();
  const lastSeenMesh = new Map<number, ResolvedMesh>();
  // Resource payload shapes seen so far in THIS call, used to check resource-payload once a
  // texture/mesh entry naming the hash is known. Local to this call: validateRecording() may run
  // repeatedly (e.g. once per golden vector) and must not leak state between calls.
  const resourcePayloadShapes = new Map<string, DecodedTexturePayload>();
  const resourcePayloadLengths = new Map<string, number>();
  const meshPayloadShapes = new Map<string, DecodedMeshPayload>();
  const meshPayloadLengths = new Map<string, number>();
  const shaderPayloadShapes = new Map<string, DecodedShaderPayload>();
  const shaderPayloadLengths = new Map<string, number>();
  const lastSeenShader = new Map<number, ResolvedShader>();
  const lastSeenMaterial = new Map<number, ResolvedMaterial>();
  let endSeen = false;
  // D31/G7o1: the whole-record digest, off the frame path in "deferred" mode.
  const digests = new Map<number, string>();
  const pendingDigest = new Set<number>();

  const accept = (i: number): string[] | undefined => {
    const timer = validatorPhaseTimer;
    const decodeT0 = timer ? timer.now() : 0;
    const decoded = decodeRecord(records[i], version, { recordDigest });
    if (timer) timer.decode_us += timer.now() - decodeT0;
    if (decoded.errors.length > 0 || decoded.record === undefined)
      return [decoded.errors[0]];
    if (recordDigest === "deferred") pendingDigest.add(i);
    else digests.set(i, decoded.record.sha256);
    const meta = decoded.record.meta;
    const offset = records[i].offset;

    if (meta.type === "session")
      return [`duplicate-session: a second session record at offset ${offset}`];

    if (meta.type === "resource") {
      if (carriedHashes.has(meta.hash)) {
        return [
          `resource-duplicate: record at offset ${offset}: hash ${meta.hash} already carried earlier in this stream`,
        ];
      }
      const block = decoded.record.blocks[0];
      if (!block || typeof block !== "object" || !("u8_bytes" in block)) {
        return [
          `meta-schema: record at offset ${offset}: resource payload block did not decode as u8`,
        ];
      }
      const rawPayload = rawResourcePayload(records[i]);
      // render-stream-4.md "Resources": mesh (GRM1), shader (GRP1, new at /5) and texture (GRT1)
      // payloads share one hash namespace and one resource record shape; tell them apart by
      // their own 8-byte magic.
      const isMeshPayload =
        isV4 && bytesEqual(rawPayload.subarray(0, 8), GRM1_MAGIC);
      const isShaderPayload =
        isV5 && bytesEqual(rawPayload.subarray(0, 8), GRP1_MAGIC);
      if (isShaderPayload) {
        let decodedShader: DecodedShaderPayload;
        try {
          decodedShader = decodeShaderPayload(rawPayload);
        } catch (e) {
          return [(e as Error).message];
        }
        const actualHash = block.sha256;
        if (actualHash !== meta.hash) {
          return [
            `resource-hash: record at offset ${offset}: payload sha256 ${actualHash} disagrees with declared hash ${meta.hash}`,
          ];
        }
        shaderPayloadShapes.set(meta.hash, decodedShader);
        shaderPayloadLengths.set(meta.hash, block.u8_bytes);
      } else if (isMeshPayload) {
        let decodedMesh: DecodedMeshPayload;
        try {
          decodedMesh = decodeMeshPayload(rawPayload);
        } catch (e) {
          return [(e as Error).message];
        }
        const actualHash = block.sha256;
        if (actualHash !== meta.hash) {
          return [
            `resource-hash: record at offset ${offset}: payload sha256 ${actualHash} disagrees with declared hash ${meta.hash}`,
          ];
        }
        meshPayloadShapes.set(meta.hash, decodedMesh);
        meshPayloadLengths.set(meta.hash, block.u8_bytes);
      } else {
        let decodedPayload: DecodedTexturePayload;
        try {
          decodedPayload = decodeTexturePayload(rawPayload);
        } catch (e) {
          return [(e as Error).message];
        }
        const actualHash = block.sha256;
        if (actualHash !== meta.hash) {
          return [
            `resource-hash: record at offset ${offset}: payload sha256 ${actualHash} disagrees with declared hash ${meta.hash}`,
          ];
        }
        // resource-payload is checked once every texture entry naming this hash is known:
        // deferred to the per-transaction texture pass below, via a stored decoded shape.
        resourcePayloadShapes.set(meta.hash, decodedPayload);
        // payload_bytes is the whole payload's length (render-stream-2.md "Texture"), not its
        // data.
        resourcePayloadLengths.set(meta.hash, block.u8_bytes);
      }
      carriedHashes.add(meta.hash);
      resourceRecordCount += 1;
      resourceByteTotal += meta.bytes;
      bytesTotal += decoded.record.byte_length;
      maxRecordBytes = Math.max(maxRecordBytes, decoded.record.byte_length);
      return undefined;
    }

    if (meta.type === "transaction") {
      // protocol/unknown-item-skip.md: the account is in every transaction of a skip session and
      // in no other.
      const skipSession = sessionMeta.unknown_item_policy === "skip";
      if ((meta.unknown_items !== undefined) !== skipSession) {
        return [
          `meta-schema: record at offset ${offset}: "unknown_items" must be present exactly when the session declares unknown_item_policy "skip"`,
        ];
      }
      const idOrderErrors = [
        ...checkIdOrdering("canvases", meta.canvases, offset),
        ...checkIdOrdering("items", meta.items, offset),
        ...checkIdOrdering("textures", meta.textures, offset),
        ...checkIdListAscendingNoDup(
          "removed_canvases",
          meta.removed_canvases,
          offset,
        ),
        ...checkIdListAscendingNoDup(
          "removed_items",
          meta.removed_items,
          offset,
        ),
        ...checkIdListAscendingNoDup(
          "removed_textures",
          meta.removed_textures,
          offset,
        ),
        ...(isV4
          ? [
              ...checkIdOrdering("meshes", meta.meshes ?? [], offset),
              ...checkIdListAscendingNoDup(
                "removed_meshes",
                meta.removed_meshes ?? [],
                offset,
              ),
            ]
          : []),
        ...(isV5
          ? [
              ...checkIdOrdering("shaders", meta.shaders ?? [], offset),
              ...checkIdOrdering("materials", meta.materials ?? [], offset),
              ...checkIdListAscendingNoDup(
                "removed_shaders",
                meta.removed_shaders ?? [],
                offset,
              ),
              ...checkIdListAscendingNoDup(
                "removed_materials",
                meta.removed_materials ?? [],
                offset,
              ),
            ]
          : []),
      ];
      if (idOrderErrors.length > 0) return idOrderErrors;

      if (meta.seq !== prevSeq + 1) {
        return [
          `seq-gap: record at offset ${offset}: seq ${meta.seq}, expected ${prevSeq + 1}`,
        ];
      }

      const patchErrors = checkPatchRules(
        meta,
        offset,
        transactionCount === 0,
        prevSeq,
        sessionMeta.stream.encoding,
        state,
        isV4,
        isV5,
      );
      if (patchErrors.length > 0) return patchErrors;
      if (meta.frame <= prevFrame) {
        return [
          `frame-order: record at offset ${offset}: frame ${meta.frame} does not increase from ${prevFrame}`,
        ];
      }

      // cmd-offset / cmd-int-offset / mesh-offset / block-count: against this record's OWN lists.
      let runningOffset = 0;
      let runningIntOffset = 0;
      let totalCmdFloats = 0;
      let totalCmdInts = 0;
      for (const item of meta.items) {
        if (item.commands === null) continue;
        for (const command of item.commands) {
          // "unsupported" and "add_clip_ignore" carry no floats and no "f" key at all.
          if (command.op === "unsupported" || command.op === "add_clip_ignore")
            continue;
          const floatCount = commandFloatCount(command);
          if (command.f !== runningOffset) {
            return [
              `cmd-offset: record at offset ${offset}: ${command.op} f=${command.f}, expected ${runningOffset}`,
            ];
          }
          runningOffset += floatCount;
          totalCmdFloats += floatCount;
          if (command.op === "add_triangle_array") {
            if (command.i !== runningIntOffset) {
              return [
                `cmd-int-offset: record at offset ${offset}: ${command.op} i=${command.i}, expected ${runningIntOffset}`,
              ];
            }
            runningIntOffset += command.indices;
            totalCmdInts += command.indices;
          }
        }
      }
      let totalMeshFloats = 0;
      if (isV4) {
        let runningMeshOffset = 0;
        for (const m of meta.meshes ?? []) {
          if (m.f === null) continue;
          if (m.f !== runningMeshOffset) {
            return [
              `mesh-offset: record at offset ${offset}: mesh ${m.id} f=${m.f}, expected ${runningMeshOffset}`,
            ];
          }
          runningMeshOffset += 6;
          totalMeshFloats += 6;
        }
      }
      // param-offset (render-stream-5.md "Material table", gate5_5-design.md D8): a running
      // offset into param_f64 over materials IN TABLE ORDER FIRST, then items' instance_params
      // in item order -- mirroring cmd-offset/mesh-offset, but spanning two different arrays.
      let totalParamFloats = 0;
      if (isV5) {
        let runningParamOffset = 0;
        const checkParam = (
          p: TransactionParam,
          where: string,
        ): string[] | null => {
          if (p.f !== runningParamOffset) {
            return [
              `param-offset: record at offset ${offset}: ${where} param "${p.name}" f=${p.f}, expected ${runningParamOffset}`,
            ];
          }
          runningParamOffset += p.n * (VARIANT_COMPONENTS[p.type] ?? 0);
          return null;
        };
        for (const m of meta.materials ?? []) {
          for (const p of m.params) {
            const err = checkParam(p, `material ${m.id}`);
            if (err !== null) return err;
          }
        }
        for (const it of meta.items) {
          for (const p of it.instance_params ?? []) {
            const err = checkParam(p, `item ${it.id} instance`);
            if (err !== null) return err;
          }
        }
        totalParamFloats = runningParamOffset;
      }
      const canvasStride = isV5 ? 10 : 6;
      const blockByName = new Map(
        meta.blocks.map((b) => [b.name, b.count] as const),
      );
      // canvas-offset (render-stream-5.md "Canvas"): canvas_f32's own expected length gets its
      // own named code at /5 (10 floats per canvas: xform 6, modulate 4), checked ahead of the
      // generic block-count sweep below -- mirroring how cmd-offset/mesh-offset are distinct
      // named codes from the generic block-count check for the blocks that carry a per-entry
      // offset. Pre-/5, a canvas_f32 mismatch is still reported generically as block-count.
      const expectedCanvasFloats = canvasStride * meta.canvases.length;
      const actualCanvasFloats = blockByName.get("canvas_f32");
      if (actualCanvasFloats !== expectedCanvasFloats) {
        return isV5
          ? [
              `canvas-offset: record at offset ${offset}: block "canvas_f32" declares count ${actualCanvasFloats}, expected ${expectedCanvasFloats} (10 floats per canvas: xform 6, modulate 4)`,
            ]
          : [
              `block-count: record at offset ${offset}: block "canvas_f32" declares count ${actualCanvasFloats}, expected ${expectedCanvasFloats}`,
            ];
      }
      const expectedBlocks: Array<[string, number]> = [
        ["item_f32", 18 * meta.items.length],
        ["cmd_f32", totalCmdFloats],
        ...(isV4
          ? ([
              ["cmd_i32", totalCmdInts],
              ["mesh_f32", totalMeshFloats],
            ] as Array<[string, number]>)
          : []),
        ...(isV5
          ? ([["param_f64", totalParamFloats]] as Array<[string, number]>)
          : []),
      ];
      for (const [name, count] of expectedBlocks) {
        if (blockByName.get(name) !== count) {
          return [
            `block-count: record at offset ${offset}: block "${name}" declares count ${blockByName.get(name)}, expected ${count}`,
          ];
        }
      }

      const expectedStatus =
        meta.failures.length === 0 ? "ok" : "capture-failure";
      if (meta.status !== expectedStatus) {
        return [
          `meta-schema: record at offset ${offset}: status "${meta.status}" disagrees with failures.length ${meta.failures.length}`,
        ];
      }

      const [itemF32, canvasF32, , cmdI32, meshF32, paramF64] = decoded.record
        .blocks as number[][];
      if (
        itemF32.length !== 18 * meta.items.length ||
        canvasF32.length !== canvasStride * meta.canvases.length ||
        (isV4 &&
          ((cmdI32?.length ?? 0) !== totalCmdInts ||
            (meshF32?.length ?? 0) !== totalMeshFloats)) ||
        (isV5 && (paramF64?.length ?? 0) !== totalParamFloats)
      ) {
        return [
          `block-count: record at offset ${offset}: decoded block lengths disagree with items/canvases/commands/meshes/materials counts`,
        ];
      }
      const resolveT0 = timer ? timer.now() : 0;
      const nextState = applyTransaction(
        state,
        meta,
        decoded.record.blocks as number[][],
      );
      if (timer) timer.resolve_us += timer.now() - resolveT0;
      const resolvedErrors = checkResolvedInvariants(
        meta,
        nextState,
        offset,
        isV6,
        snapDeclared,
      );
      if (resolvedErrors.length > 0) return resolvedErrors;

      // texture-version / mesh-version, across the whole stream so far.
      for (const t of meta.textures) {
        const previous = lastSeenTexture.get(t.id);
        if (textureVersionRegressed(previous, t)) {
          return [
            `texture-version: record at offset ${offset}: texture ${t.id}'s version/content is inconsistent with its earlier entry`,
          ];
        }
        lastSeenTexture.set(t.id, t);
      }
      if (isV4) {
        for (const m of meta.meshes ?? []) {
          // Compare the RESOLVED mesh (lifted custom_aabb), not the raw wire entry: "f" is a
          // position-dependent offset into mesh_f32, not content (see meshVersionRegressed()).
          const resolvedMesh = nextState.meshes.get(m.id);
          if (resolvedMesh === undefined) continue;
          const previous = lastSeenMesh.get(m.id);
          if (meshVersionRegressed(previous, resolvedMesh)) {
            return [
              `mesh-version: record at offset ${offset}: mesh ${m.id}'s version/content is inconsistent with its earlier entry`,
            ];
          }
          lastSeenMesh.set(m.id, resolvedMesh);
        }
      }
      if (isV5) {
        for (const s of meta.shaders ?? []) {
          const resolvedShader = nextState.shaders.get(s.id);
          if (resolvedShader === undefined) continue;
          const previous = lastSeenShader.get(s.id);
          if (shaderVersionRegressed(previous, resolvedShader)) {
            return [
              `shader-version: record at offset ${offset}: shader ${s.id}'s version/content is inconsistent with its earlier entry`,
            ];
          }
          lastSeenShader.set(s.id, resolvedShader);
        }
        for (const m of meta.materials ?? []) {
          const resolvedMaterial = nextState.materials.get(m.id);
          if (resolvedMaterial === undefined) continue;
          const previous = lastSeenMaterial.get(m.id);
          if (materialVersionRegressed(previous, resolvedMaterial)) {
            return [
              `material-version: record at offset ${offset}: material ${m.id}'s version/content is inconsistent with its earlier entry`,
            ];
          }
          lastSeenMaterial.set(m.id, resolvedMaterial);
        }
      }

      // resource-missing / resource-payload, over the RESOLVED table (every ok image entry, and,
      // at /4, every ok mesh surface).
      for (const t of sortedResolvedTextures(nextState)) {
        if (t.kind !== "image" || t.status !== "ok" || t.hash === null)
          continue;
        if (t.payload_bytes > inlineMaxBytes) continue;
        if (!carriedHashes.has(t.hash)) {
          return [
            `resource-missing: record at offset ${offset}: texture ${t.id}'s hash ${t.hash} (payload_bytes ${t.payload_bytes} <= inline_max_bytes ${inlineMaxBytes}) never arrived as a resource record`,
          ];
        }
        const shape = resourcePayloadShapes.get(t.hash);
        if (
          shape !== undefined &&
          (shape.format !== t.format ||
            shape.width !== t.width ||
            shape.height !== t.height ||
            shape.mipmaps !== t.mipmaps ||
            (resourcePayloadLengths.get(t.hash) ?? -1) !== t.payload_bytes)
        ) {
          return [
            `resource-payload: record at offset ${offset}: the resource for hash ${t.hash} decodes as ${shape.format} ${shape.width}x${shape.height}, texture ${t.id} declares ${t.format} ${t.width}x${t.height}`,
          ];
        }
      }
      if (isV4) {
        for (const m of sortedResolvedMeshes(nextState)) {
          if (m.status !== "ok") continue;
          for (const s of m.surfaces) {
            if (s.payload_bytes > inlineMaxBytes) continue;
            if (!carriedHashes.has(s.hash)) {
              return [
                `resource-missing: record at offset ${offset}: mesh ${m.id}'s surface hash ${s.hash} (payload_bytes ${s.payload_bytes} <= inline_max_bytes ${inlineMaxBytes}) never arrived as a resource record`,
              ];
            }
            const shape = meshPayloadShapes.get(s.hash);
            if (
              shape !== undefined &&
              (shape.primitive !== s.primitive ||
                shape.format !== s.format ||
                shape.vertex_count !== s.vertex_count ||
                shape.index_count !== s.index_count ||
                (meshPayloadLengths.get(s.hash) ?? -1) !== s.payload_bytes)
            ) {
              return [
                `resource-payload: record at offset ${offset}: the resource for hash ${s.hash} decodes as ${shape.primitive} vertex_count ${shape.vertex_count}, mesh ${m.id} declares ${s.primitive} vertex_count ${s.vertex_count}`,
              ];
            }
          }
        }
      }
      if (isV5) {
        // shader source "withheld" (gate5_5-design.md D4) never has a resource record -- the
        // policy deliberately keeps the code byte off the wire, the store and HTTP.
        for (const s of sortedResolvedShaders(nextState)) {
          if (s.status !== "ok" || s.hash === null || s.source !== "payload")
            continue;
          if (s.payload_bytes > inlineMaxBytes) continue;
          if (!carriedHashes.has(s.hash)) {
            return [
              `resource-missing: record at offset ${offset}: shader ${s.id}'s hash ${s.hash} (payload_bytes ${s.payload_bytes} <= inline_max_bytes ${inlineMaxBytes}) never arrived as a resource record`,
            ];
          }
          const shape = shaderPayloadShapes.get(s.hash);
          if (
            shape !== undefined &&
            (shaderPayloadLengths.get(s.hash) ?? -1) !== s.payload_bytes
          ) {
            return [
              `resource-payload: record at offset ${offset}: the resource for hash ${s.hash} is ${shaderPayloadLengths.get(s.hash)} bytes, shader ${s.id} declares payload_bytes ${s.payload_bytes}`,
            ];
          }
        }
      }

      // id-reused: resolved ids this transaction vs. the previous one.
      const currentCanvasIds = new Set(nextState.canvases.keys());
      const currentItemIds = new Set(nextState.items.keys());
      const currentTextureIds = new Set(nextState.textures.keys());
      const currentMeshIds = new Set(nextState.meshes.keys());
      const currentShaderIds = new Set(nextState.shaders.keys());
      const currentMaterialIds = new Set(nextState.materials.keys());
      const previousCanvasIds = new Set(state.canvases.keys());
      const previousItemIds = new Set(state.items.keys());
      const previousTextureIds = new Set(state.textures.keys());
      const previousMeshIds = new Set(state.meshes.keys());
      const previousShaderIds = new Set(state.shaders.keys());
      const previousMaterialIds = new Set(state.materials.keys());
      for (const [kind, currentIds, previousIds] of [
        ["canvas", currentCanvasIds, previousCanvasIds] as const,
        ["item", currentItemIds, previousItemIds] as const,
        ["texture", currentTextureIds, previousTextureIds] as const,
        ["mesh", currentMeshIds, previousMeshIds] as const,
        ["shader", currentShaderIds, previousShaderIds] as const,
        ["material", currentMaterialIds, previousMaterialIds] as const,
      ]) {
        if (kind === "mesh" && !isV4) continue;
        if ((kind === "shader" || kind === "material") && !isV5) continue;
        for (const id of currentIds) {
          if (!previousIds.has(id) && id <= maxIdSeen[kind]) {
            return [
              `id-reused: record at offset ${offset}: ${kind} id ${id} reappears after not being in the previous transaction`,
            ];
          }
        }
        for (const id of currentIds)
          maxIdSeen[kind] = Math.max(maxIdSeen[kind], id);
      }

      state = nextState;
      prevSeq = meta.seq;
      prevFrame = meta.frame;
      transactionCount += 1;
      if (meta.encoding === "full") fullCount += 1;
      else patchCount += 1;
      bytesTotal += decoded.record.byte_length;
      maxRecordBytes = Math.max(maxRecordBytes, decoded.record.byte_length);
      return undefined;
    }

    // meta.type === "end"
    if (meta.transactions !== transactionCount) {
      return [
        `end-count-mismatch: end record says ${meta.transactions} transactions, but ${transactionCount} were seen`,
      ];
    }
    if (
      meta.stats.bytes_total !== bytesTotal ||
      meta.stats.max_record_bytes !== maxRecordBytes ||
      meta.stats.full_transactions !== fullCount ||
      meta.stats.patch_transactions !== patchCount ||
      meta.stats.resource_records !== resourceRecordCount ||
      meta.stats.resource_bytes !== resourceByteTotal ||
      meta.stats.full_transactions + meta.stats.patch_transactions !==
        meta.transactions
    ) {
      return [
        `end-stats-mismatch: end record stats disagree with the recording`,
      ];
    }
    if (i !== records.length - 1) {
      return [
        `trailing-bytes: data follows the end record at offset ${offset}`,
      ];
    }
    endSeen = true;
    return undefined;
  };

  return {
    errors: null,
    accept,
    finish: () =>
      endSeen
        ? []
        : ["recording-incomplete: the recording ends without an end record"],
    digestPending: () => Array.from(pendingDigest).sort((a, b) => a - b),
    digest: (i: number): string => {
      let d = digests.get(i);
      if (d === undefined) {
        d = hashBytes(records[i].bytes);
        digests.set(i, d);
      }
      pendingDigest.delete(i);
      return d;
    },
  };
}

/** Whole-file validation: `createRecordingValidator` over every record of `data`, in order. */
export function validateRecording(
  data: Uint8Array,
  version: 2 | 3 | 4 | 5 | 6 | 7 = 6,
): string[] {
  const split = splitRecords(data, version);
  if (split.errors.length > 0) return [split.errors[0]];
  const validator = createRecordingValidator(split.records, version);
  if (validator.errors) return validator.errors;
  for (let i = 1; i < split.records.length; i++) {
    const errors = validator.accept(i);
    if (errors) return errors;
  }
  return validator.finish();
}

function checkPatchRules(
  meta: TransactionMeta,
  offset: number,
  isFirstTransaction: boolean,
  prevSeq: number,
  sessionEncoding: Encoding,
  baseState: ResolvedState,
  isV4: boolean,
  isV5: boolean,
): string[] {
  if (meta.encoding === "full") {
    if (
      meta.base_seq !== null ||
      meta.removed_canvases.length > 0 ||
      meta.removed_items.length > 0 ||
      meta.removed_textures.length > 0 ||
      (isV4 && (meta.removed_meshes?.length ?? 0) > 0) ||
      (isV5 &&
        ((meta.removed_shaders?.length ?? 0) > 0 ||
          (meta.removed_materials?.length ?? 0) > 0))
    ) {
      return [
        `patch-encoding: record at offset ${offset}: a full transaction carries a non-null base_seq or a non-empty removed list`,
      ];
    }
    return [];
  }
  if (sessionEncoding === "full") {
    return [
      `patch-encoding: record at offset ${offset}: a patch transaction in a stream whose session says encoding "full"`,
    ];
  }
  if (isFirstTransaction) {
    return [
      `patch-base: record at offset ${offset}: the stream's first transaction is a patch`,
    ];
  }
  if (meta.base_seq !== prevSeq) {
    return [
      `patch-base: record at offset ${offset}: base_seq ${meta.base_seq} is not the previous transaction's seq ${prevSeq}`,
    ];
  }

  const removedCanvasSet = new Set<number>();
  for (const id of meta.removed_canvases) {
    if (removedCanvasSet.has(id)) {
      return [
        `patch-removed: record at offset ${offset}: canvas ${id} is removed twice`,
      ];
    }
    removedCanvasSet.add(id);
    if (!baseState.canvases.has(id)) {
      return [
        `patch-removed: record at offset ${offset}: removed canvas ${id} is absent from the base`,
      ];
    }
  }
  const removedItemSet = new Set<number>();
  for (const id of meta.removed_items) {
    if (removedItemSet.has(id)) {
      return [
        `patch-removed: record at offset ${offset}: item ${id} is removed twice`,
      ];
    }
    removedItemSet.add(id);
    if (!baseState.items.has(id)) {
      return [
        `patch-removed: record at offset ${offset}: removed item ${id} is absent from the base`,
      ];
    }
  }
  const removedTextureSet = new Set<number>();
  for (const id of meta.removed_textures) {
    if (removedTextureSet.has(id)) {
      return [
        `patch-removed: record at offset ${offset}: texture ${id} is removed twice`,
      ];
    }
    removedTextureSet.add(id);
    if (!baseState.textures.has(id)) {
      return [
        `patch-removed: record at offset ${offset}: removed texture ${id} is absent from the base`,
      ];
    }
  }
  for (const c of meta.canvases) {
    if (removedCanvasSet.has(c.id)) {
      return [
        `patch-removed: record at offset ${offset}: canvas ${c.id} is both removed and present`,
      ];
    }
  }
  for (const it of meta.items) {
    if (removedItemSet.has(it.id)) {
      return [
        `patch-removed: record at offset ${offset}: item ${it.id} is both removed and present`,
      ];
    }
  }
  for (const t of meta.textures) {
    if (removedTextureSet.has(t.id)) {
      return [
        `patch-removed: record at offset ${offset}: texture ${t.id} is both removed and present`,
      ];
    }
  }
  if (isV4) {
    const removedMeshSet = new Set<number>();
    for (const id of meta.removed_meshes ?? []) {
      if (removedMeshSet.has(id)) {
        return [
          `patch-removed: record at offset ${offset}: mesh ${id} is removed twice`,
        ];
      }
      removedMeshSet.add(id);
      if (!baseState.meshes.has(id)) {
        return [
          `patch-removed: record at offset ${offset}: removed mesh ${id} is absent from the base`,
        ];
      }
    }
    for (const m of meta.meshes ?? []) {
      if (removedMeshSet.has(m.id)) {
        return [
          `patch-removed: record at offset ${offset}: mesh ${m.id} is both removed and present`,
        ];
      }
    }
  }
  if (isV5) {
    const removedShaderSet = new Set<number>();
    for (const id of meta.removed_shaders ?? []) {
      if (removedShaderSet.has(id)) {
        return [
          `patch-removed: record at offset ${offset}: shader ${id} is removed twice`,
        ];
      }
      removedShaderSet.add(id);
      if (!baseState.shaders.has(id)) {
        return [
          `patch-removed: record at offset ${offset}: removed shader ${id} is absent from the base`,
        ];
      }
    }
    for (const s of meta.shaders ?? []) {
      if (removedShaderSet.has(s.id)) {
        return [
          `patch-removed: record at offset ${offset}: shader ${s.id} is both removed and present`,
        ];
      }
    }
    const removedMaterialSet = new Set<number>();
    for (const id of meta.removed_materials ?? []) {
      if (removedMaterialSet.has(id)) {
        return [
          `patch-removed: record at offset ${offset}: material ${id} is removed twice`,
        ];
      }
      removedMaterialSet.add(id);
      if (!baseState.materials.has(id)) {
        return [
          `patch-removed: record at offset ${offset}: removed material ${id} is absent from the base`,
        ];
      }
    }
    for (const m of meta.materials ?? []) {
      if (removedMaterialSet.has(m.id)) {
        return [
          `patch-removed: record at offset ${offset}: material ${m.id} is both removed and present`,
        ];
      }
    }
  }

  for (const it of meta.items) {
    const base = baseState.items.get(it.id);
    if (it.commands === null) {
      if (base === undefined) {
        return [
          `patch-commands: record at offset ${offset}: item ${it.id} is new but carries commands:null`,
        ];
      }
      if (base.content_version !== it.content_version) {
        return [
          `patch-commands: record at offset ${offset}: item ${it.id}'s content_version changed but it carries commands:null`,
        ];
      }
    }
  }
  return [];
}

// --------------------------------------------------------------------------------------- resolveRecording

export interface ResolvedTransaction {
  seq: number;
  frame: number;
  encoding: Encoding;
  state: {
    status: TransactionStatus;
    failures: TransactionMeta["failures"];
    unsupported: TransactionMeta["unsupported"];
    /** protocol/unknown-item-skip.md: present only in a skip session. */
    unknown_items?: UnknownItemsMeta;
    default_texture_filter: Filter;
    default_texture_repeat: Repeat;
    canvases: ResolvedCanvas[];
    items: ResolvedItem[];
    textures: ResolvedTexture[];
    /** new at /4: present only when resolved at version 4. */
    meshes?: ResolvedMesh[];
    /** new at /5: present only when resolved at version 5. */
    shaders?: ResolvedShader[];
    materials?: ResolvedMaterial[];
  };
}

export interface ResolvedResource {
  hash: string;
  bytes: number;
  record_index: number;
}

export interface ResolvedRecording {
  schema:
    | "render-stream-2-resolved/1"
    | "render-stream-3-resolved/1"
    | "render-stream-4-resolved/1"
    | "render-stream-5-resolved/1"
    | "render-stream-6-resolved/1"
    | "render-stream-7-resolved/1";
  session_id: string;
  stream_id: string;
  transactions: ResolvedTransaction[];
  resources: ResolvedResource[];
}

export function resolveRecording(
  data: Uint8Array,
  version: 2 | 3 | 4 | 5 | 6 | 7 = 6,
): ResolvedRecording {
  const decoded = decodeRecording(data, version);
  const sessionRecord = decoded.records[0];
  if (sessionRecord.meta.type !== "session")
    throw new Error("missing-session: the first record is not a session");
  const sessionMeta = sessionRecord.meta;

  let state = emptyResolvedState();
  const transactions: ResolvedTransaction[] = [];
  const resources: ResolvedResource[] = [];
  const lastItems = new Map<number, ResolvedItem>();
  for (let i = 1; i < decoded.records.length; i++) {
    const record = decoded.records[i];
    const meta = record.meta;
    if (meta.type === "resource") {
      resources.push({ hash: meta.hash, bytes: meta.bytes, record_index: i });
      continue;
    }
    if (meta.type !== "transaction") continue;
    state = applyTransaction(state, meta, record.blocks as number[][]);
    transactions.push({
      seq: meta.seq,
      frame: meta.frame,
      encoding: meta.encoding,
      state: {
        status: meta.status,
        failures: meta.failures,
        unsupported: meta.unsupported,
        ...(meta.unknown_items !== undefined
          ? { unknown_items: meta.unknown_items }
          : {}),
        default_texture_filter: meta.default_texture_filter,
        default_texture_repeat: meta.default_texture_repeat,
        canvases: sortedResolvedCanvases(state),
        items: internItems(sortedResolvedItems(state), lastItems),
        textures: sortedResolvedTextures(state),
        ...(version === 4 || version === 5 || version === 6 || version === 7
          ? { meshes: sortedResolvedMeshes(state) }
          : {}),
        ...(version === 5 || version === 6 || version === 7
          ? {
              shaders: sortedResolvedShaders(state),
              materials: sortedResolvedMaterials(state),
            }
          : {}),
      },
    });
  }
  return {
    schema:
      version === 7
        ? "render-stream-7-resolved/1"
        : version === 6
          ? "render-stream-6-resolved/1"
          : version === 5
            ? "render-stream-5-resolved/1"
            : version === 4
              ? "render-stream-4-resolved/1"
              : version === 3
                ? "render-stream-3-resolved/1"
                : "render-stream-2-resolved/1",
    session_id: sessionMeta.session_id,
    stream_id: sessionMeta.stream.stream_id,
    transactions,
    resources,
  };
}

// --------------------------------------------------------------------------------------- statesEqual

function froundDeep(value: unknown): unknown {
  if (typeof value === "number") return Math.fround(value);
  if (Array.isArray(value)) return value.map(froundDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = froundDeep(v);
    return out;
  }
  return value;
}

export function statesEqual(a: unknown, b: unknown): boolean {
  // GRT4b: the same answer as the string comparison below, from one walk over both values that
  // stops at the first difference; anything the walk does not model (a bigint) falls back to it.
  try {
    return froundJsonEqual(a, b);
  } catch (e) {
    if (e !== FROUND_FALLBACK) throw e;
    return JSON.stringify(froundDeep(a)) === JSON.stringify(froundDeep(b));
  }
}

const FROUND_FALLBACK = new Error(
  "froundJsonEqual: fall back to JSON.stringify",
);

/** The JSON text of froundDeep(v) when v is a leaf, null when v is an object or array (walked),
 * undefined when JSON.stringify leaves it out (undefined, a function, a symbol). */
function froundLeaf(v: unknown): string | null | undefined {
  switch (typeof v) {
    case "number": {
      const f = Math.fround(v);
      return Number.isFinite(f) ? String(f) : "null";
    }
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "bigint":
      throw FROUND_FALLBACK;
    default:
      return v === null ? "null" : null;
  }
}

/** JSON.stringify(froundDeep(a)) === JSON.stringify(froundDeep(b)). froundDeep rebuilds every
 * non-array object as a plain one from Object.entries (so no toJSON survives), keeps an array's
 * holes (written null), and rounds every number to float32 (-0 is written 0). */
function froundJsonEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    const fa = Math.fround(a);
    const fb = Math.fround(b);
    if (!Number.isFinite(fa) || !Number.isFinite(fb))
      return !Number.isFinite(fa) && !Number.isFinite(fb);
    return fa === fb;
  }
  if (typeof a === "string" && typeof b === "string") return a === b;
  const ta = froundLeaf(a);
  const tb = froundLeaf(b);
  if (ta !== null || tb !== null) return ta === tb;
  const aa = Array.isArray(a);
  if (aa !== Array.isArray(b)) return false;
  if (aa) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      // A hole and an omitted value are both written null inside an array.
      const ea = froundLeaf(x[i]) === undefined ? null : x[i];
      const eb = froundLeaf(y[i]) === undefined ? null : y[i];
      if (!froundJsonEqual(ea, eb)) return false;
    }
    return true;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  const kb = Object.keys(rb);
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < ka.length && froundLeaf(ra[ka[i]]) === undefined) i++;
    while (j < kb.length && froundLeaf(rb[kb[j]]) === undefined) j++;
    if (i === ka.length || j === kb.length)
      return i === ka.length && j === kb.length;
    if (ka[i] !== kb[j] || !froundJsonEqual(ra[ka[i]], rb[kb[j]])) return false;
    i++;
    j++;
  }
}

/** GRT4b: `a` and `b` are the same value all the way down: the same prototypes, own keys in the
 * same order, and leaves equal under Object.is. One can stand in for the other wherever nothing
 * mutates or compares identities. */
export function sameValueDeep(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)
  )
    return false;
  if (Array.isArray(a)) {
    const y = b as unknown[];
    if (a.length !== y.length) return false;
    for (let i = 0; i < a.length; i++) {
      const p = a[i];
      const q = y[i];
      if (typeof p === "number" && typeof q === "number") {
        if (!Object.is(p, q)) return false;
        continue;
      }
      // A hole reads undefined; only then can the two differ by `in`.
      if ((p === undefined || q === undefined) && i in a !== i in y)
        return false;
      if (!sameValueDeep(p, q)) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++)
    if (
      ka[i] !== kb[i] ||
      !sameValueDeep(
        (a as Record<string, unknown>)[ka[i]],
        (b as Record<string, unknown>)[kb[i]],
      )
    )
      return false;
  return true;
}

/** GRT4b: a transaction's sorted items, each replaced by the previous transaction's item of the
 * same id when that one is the same value (sameValueDeep). A full-encoding recording lifts every
 * item again at every transaction; ~90% of them are unchanged (a live gate 6 host's 104 MB
 * recording held 397 MiB of per-transaction items), and a patch recording already shares them. */
export function internItems(
  items: ResolvedItem[],
  prev: Map<number, ResolvedItem>,
): ResolvedItem[] {
  for (let i = 0; i < items.length; i++) {
    const p = prev.get(items[i].id);
    if (p && p !== items[i] && sameValueDeep(p, items[i])) items[i] = p;
  }
  prev.clear();
  for (const item of items) prev.set(item.id, item);
  return items;
}

// --------------------------------------------------------------------------------------- recordSha256

export function recordSha256(data: Uint8Array, offset: number): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const recordLen = view.getUint32(offset, true);
  return hashBytes(data.subarray(offset, offset + 4 + recordLen));
}
