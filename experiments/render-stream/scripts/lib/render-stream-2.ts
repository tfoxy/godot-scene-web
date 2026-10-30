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
// G55w) are implemented IN THIS SAME FILE behind an explicit `version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13` parameter
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
  expectedMeshBufferBytes,
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
// render-stream-8.md "Resource tables": the texture, mesh, shader and material tables accept
// "adopted" beside "created" at /8 (items and canvases have accepted it since /0).
export type TableOrigin = "created" | "adopted";
/** render-stream-8.md "Resource tables": where an adopted texture or mesh's content came from. */
export type AdoptedContent = "current" | "creation";
/** render-stream-8.md "Session": the late-join adoption declaration (null when off). */
export interface AdoptionDeclaration {
  mode: "arm";
  frame: number;
}
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
  | "snap-2d"
  // new at /11 (PM1, render-stream-11.md "As built (PM1)", 7)
  | "unknown-multimesh"
  | "unsupported-multimesh"
  // new at /12 (PM5, render-stream-12.md "The command")
  | "unknown-particles"
  | "unsupported-particles";
/** canvas-texture-headless (G2d): a texture draw naming RID() on a headless host, whose dummy
 * storage never allocates a canvas texture (protocol/canvas-texture-headless.md).
 * unknown-mesh/skinned-geometry: new at /4 (render-stream-4.md "Command"). */
export type UnsupportedCmdReason =
  | "unsupported-op"
  | "unknown-texture"
  | "canvas-texture-headless"
  | "unknown-mesh"
  | "skinned-geometry"
  // new at /11 (PM1, 7): an add_multimesh naming a RID the mirror never saw created.
  | "unknown-multimesh"
  // new at /12 (PM5, render-stream-12.md "The command"): an add_particles naming an unknown RID.
  | "unknown-particles";
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
  | "retain-superseded"
  // new at /8 (gate8-design.md Q2-Q5; render-stream-8.md "Sabotage kinds")
  | "adopt-skip-state"
  | "adopt-no-redraw"
  | "adopt-skip-layers"
  | "perturb-decode"
  | "size-before-adopt"
  | "adopt-raw-shader-code"
  | "adopt-skip-params"
  // new at /11 (W11b; render-stream-11.md "Sabotage kinds")
  | "cv-churn"
  | "stale-dynamic"
  | "keep-carried"
  // new at /11 (PM1, render-stream-11.md "As built (PM1)", 11)
  | "perturb-instance"
  | "stale-buffer"
  // new at /12 (PM5, render-stream-12.md "Sabotages")
  | "perturb-seed"
  | "drop-restart";
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
  | "canvas-texture-channel"
  /** new at /9 (render-stream-9.md "Texture reasons"). */
  | "delivery-pending";

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
  | "payload-unavailable"
  /** new at /8 (render-stream-8.md "Resource tables"): an adopted shader whose code could not be
   * recovered (gate8-design.md Q5). */
  | "shader-adopt-include";
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

/** new at /12 (PM5, render-stream-12.md "The `particle_process_material` builtin"):
 * `ParticleProcessMaterial::MaterialKey` spelled out, keys in this order; `particle_flags` and
 * `textures` list the set bits in enum order. */
export interface BuiltinParticleProcessMaterial {
  kind: "particle_process_material";
  emission_shape: EmissionShape;
  particle_flags: ParticleFlag[];
  textures: ProcessParameter[];
  color_ramp: boolean;
  color_initial_ramp: boolean;
  alpha_curve: boolean;
  emission_curve: boolean;
  velocity_limit_curve: boolean;
  orbit_velocity_curve_xyz: boolean;
  emission_color_texture: boolean;
  sub_emitter: SubEmitterMode;
  attractor: boolean;
  collision: CollisionMode;
  collision_scale: boolean;
  turbulence: boolean;
  // Absent: lets code written for BuiltinCanvasItemMaterial read these as undefined.
  blend_mode?: undefined;
  light_mode?: undefined;
  particles_animation?: undefined;
}
export type EmissionShape =
  | "point"
  | "sphere"
  | "sphere_surface"
  | "box"
  | "points"
  | "directed_points"
  | "ring";
export type ParticleFlag =
  | "align_y_to_velocity"
  | "rotate_y"
  | "disable_z"
  | "damping_as_friction";
export type ProcessParameter =
  | "initial_linear_velocity"
  | "angular_velocity"
  | "orbit_velocity"
  | "linear_accel"
  | "radial_accel"
  | "tangential_accel"
  | "damping"
  | "angle"
  | "scale"
  | "hue_variation"
  | "anim_speed"
  | "anim_offset"
  | "turb_influence_over_life"
  | "turb_vel_influence"
  | "turb_init_displacement"
  | "radial_velocity"
  | "directional_velocity"
  | "scale_over_velocity";
export type SubEmitterMode =
  | "disabled"
  | "constant"
  | "at_end"
  | "at_collision"
  | "at_start";
export type CollisionMode = "disabled" | "rigid" | "hide_on_contact";
/** A shader entry's `builtin` (the second kind is /12's). */
export type ShaderBuiltin =
  | BuiltinCanvasItemMaterial
  | BuiltinParticleProcessMaterial;

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
  origin: TableOrigin;
  status: ShaderStatus;
  reason: ShaderReason | null;
  version: number;
  mode: ShaderMode | null;
  source: ShaderSource | null;
  hash: string | null;
  payload_bytes: number;
  builtin: ShaderBuiltin | null;
  uses: ShaderUse[];
  default_textures: DefaultTextureRef[];
}

export interface TransactionMaterial {
  id: number;
  origin: TableOrigin;
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
  /** new at /8 (render-stream-8.md "Session"): the host's declared texture-decode policy. */
  decode?: "off" | "engine";
  /** new at /9 (render-stream-9.md "Session"): the host's declared texture-delivery mode. */
  texture_delivery?: TextureDeliveryDeclaration;
}

/** render-stream-9.md "Session": `resources.texture_delivery`. */
export interface TextureDeliveryDeclaration {
  mode: "rgba" | "passthrough" | "basis-uastc" | "basis-etc1s";
  /** The params_id prefix of the Basis encoder (e.g. "basisu-1.60"), null when there is none. */
  encoder: string | null;
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
  /** render-stream-8.md "Session": always present at /8 (null = adoption off), right after
   * `unknown_item_policy`/`sabotage`; absent below /8. */
  adoption?: AdoptionDeclaration | null;
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
/** new at /11 (PM1, render-stream-11.md "As built (PM1)", 7): no floats, so no "f". */
export interface CommandAddMultimesh {
  op: "add_multimesh";
  multimesh: number;
  tex: number | null;
}
/** new at /12 (PM5, render-stream-12.md "The command"): no floats, so no "f". */
export interface CommandAddParticles {
  op: "add_particles";
  particles: number;
  tex: number | null;
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
  | CommandAddMultimesh
  | CommandAddParticles
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
  /** new at /10 (render-stream-10.md "Item"): present only when decoded at version 10, in this
   * order, after instance_params. "f" is the running offset into backbuffer_f32. */
  canvas_group?: TransactionCanvasGroup | null;
  copy_to_backbuffer?: { f: number } | null;
  /** UIT (render-stream-11.md "As built (UIT)"): /11 only, present only when true. */
  use_identity_transform?: true;
  content_version: number;
  commands: Command[] | null;
}

/** render-stream-10.md "Item": canvas_group on the wire; its floats (clear_margin, fit_margin)
 * are at f in backbuffer_f32. */
export interface TransactionCanvasGroup {
  mode: CanvasGroupMode;
  fit_empty: boolean;
  blur_mipmaps: boolean;
  f: number;
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
  origin: TableOrigin;
  /** new at /8: non-null exactly when origin is "adopted"; present only in a /8 stream. */
  adopted_content?: AdoptedContent | null;
  kind: TextureKind;
  status: TextureStatus;
  reason: TextureReason | null;
  version: number;
  hash: string | null;
  format: string | null;
  /** new at /8: the format a host decode started from; non-null exactly for a host decode. */
  source_format?: string | null;
  width: number;
  height: number;
  mipmaps: boolean;
  payload_bytes: number;
  /** new at /9 (render-stream-9.md "Texture entries"): the alternative payloads, sorted by
   * encoding, at most one each; present only in a /9 stream. */
  variants?: TextureVariant[];
  canvas: CanvasTextureMeta | null;
}

/** render-stream-9.md "Texture entries": one alternative payload of an ok image texture. */
export interface TextureVariant {
  encoding: "block" | "uastc" | "etc1s";
  hash: string;
  payload_bytes: number;
  format: string | null;
  params: string | null;
}

/** render-stream-4.md "Mesh table": one mesh-table entry. `f` is null exactly for "freed". */
export interface TransactionMeshSurface {
  /** render-stream-11.md "Mesh entry": null at runtime on a dynamic mesh's surface (its bytes
   * travel in the transaction's mesh_u8 block); never null below /11. Typed `string` so the
   * /4-/10 checkers keep compiling unchanged; /11 code goes through `surfaceIsDynamic()`. */
  hash: string;
  payload_bytes: number;
  primitive: Primitive;
  format: number;
  vertex_count: number;
  index_count: number;
}
export interface TransactionMesh {
  id: number;
  origin: TableOrigin;
  /** new at /8: non-null exactly when origin is "adopted"; present only in a /8 stream. */
  adopted_content?: AdoptedContent | null;
  status: MeshStatus;
  reason: MeshReason | null;
  version: number;
  f: number | null;
  /** new at /11 (render-stream-11.md "Mesh entry"): present only in a /11 stream. The offset in
   * mesh_u8 of a dynamic mesh's surface bodies, null for a static mesh (and on a dynamic patch
   * entry that keeps the bodies the receiver holds). */
  u8?: number | null;
  surfaces: TransactionMeshSurface[];
}

/** render-stream-11.md "Mesh entry": a surface is dynamic when its hash is null (only at /11). */
export function surfaceIsDynamic(s: { hash: string | null }): boolean {
  return s.hash === null;
}

export type MultimeshStatus = "ok" | "unsupported" | "freed";
export type MultimeshReason =
  | "multimesh-3d"
  | "multimesh-indirect"
  | "multimesh-interpolated"
  | "unknown-mesh"
  | "payload-too-large";
export type MultimeshFormat = "2d" | "3d";

/** new at /11 (PM1, render-stream-11.md "As built (PM1)", 2): one multimesh table entry. Its
 * six custom-AABB floats are at `aabb_f` in mm_f32 (null only when freed), and, when `buffer_f`
 * is non-null, its `instances x stride` buffer floats (stride 8 + 4*colors + 4*custom) at
 * `buffer_f`; a null `buffer_f` keeps the floats the receiver holds. */
export interface TransactionMultimesh {
  id: number;
  origin: TableOrigin;
  status: MultimeshStatus;
  reason: MultimeshReason | null;
  version: number;
  mesh: number | null;
  format: MultimeshFormat;
  colors: boolean;
  custom: boolean;
  instances: number;
  visible: number;
  aabb_f: number | null;
  buffer_f: number | null;
}

/** PM1 rule 4: floats per instance of a multimesh's TRANSFORM_2D buffer. */
export function multimeshStride(m: { colors: boolean; custom: boolean }): number {
  return 8 + (m.colors ? 4 : 0) + (m.custom ? 4 : 0);
}

export type ParticlesStatus = "ok" | "unsupported" | "freed";
/** render-stream-12.md "Particles table": the reasons, in priority order. */
export type ParticlesReason =
  | "particles-3d"
  | "unknown-material"
  | "unknown-mesh"
  | "unknown-particles";
export type ParticlesMode = "2d" | "3d";
export type ParticlesDrawOrder =
  | "index"
  | "lifetime"
  | "reverse_lifetime"
  | "view_depth";
export type ParticlesTransformAlign =
  | "disabled"
  | "z_billboard"
  | "y_to_velocity"
  | "z_billboard_y_to_velocity";

/** new at /12 (PM5, render-stream-12.md "Particles table"): one emitter entry, keys in this
 * order. Its `particlesFloatCount(trail_poses)` floats are at `f` in pt_f32 (null only when
 * freed; see PARTICLES_FLOAT_LAYOUT). */
export interface TransactionParticles {
  id: number;
  /** "adopted" for an emitter that existed before arm (PM7, render-stream-12.md "As built (PM7)"). */
  origin: "created" | "adopted";
  status: ParticlesStatus;
  reason: ParticlesReason | null;
  version: number;
  mode: ParticlesMode;
  emitting: boolean;
  amount: number;
  one_shot: boolean;
  fixed_fps: number;
  interpolate: boolean;
  fractional_delta: boolean;
  local: boolean;
  draw_order: ParticlesDrawOrder;
  transform_align: ParticlesTransformAlign;
  trails: boolean;
  trail_poses: number;
  seed: number;
  restarts: number;
  emits: number;
  process_requests: number;
  process_material: number | null;
  draw_passes: Array<number | null>;
  subemitter: number | null;
  f: number | null;
}

/** new at /12 (PM5, render-stream-12.md "The emit list"): one accepted `particles_emit` call.
 * Its PARTICLE_EMIT_FLOAT_COUNT floats (transform 12, velocity 3, colour 4, custom 4) are at
 * `f` in pt_f32, after every entry's. */
export interface TransactionParticleEmit {
  particles: number;
  restarts: number;
  flags: number;
  f: number;
}

/** render-stream-12.md "Particles table": an entry's floats before its trail bind poses. */
export const PARTICLES_BASE_FLOAT_COUNT = 31;
/** render-stream-12.md "Particles table": floats per trail bind pose (a Transform3D). */
export const PARTICLES_TRAIL_POSE_FLOATS = 12;
/** render-stream-12.md "The emit list": floats per emit. */
export const PARTICLE_EMIT_FLOAT_COUNT = 23;
/** render-stream-12.md "Particles table": the float layout of an entry, `[name, offset,
 * length]` (the trail bind poses follow at PARTICLES_BASE_FLOAT_COUNT, 12 each). A Transform3D
 * is `basis.rows[0..2]` (xyz each), then `origin`. */
export const PARTICLES_FLOAT_LAYOUT: ReadonlyArray<
  readonly [keyof ResolvedParticlesFloats, number, number]
> = [
  ["amount_ratio", 0, 1],
  ["lifetime", 1, 1],
  ["pre_process_time", 2, 1],
  ["explosiveness", 3, 1],
  ["randomness", 4, 1],
  ["speed_scale", 5, 1],
  ["collision_base_size", 6, 1],
  ["trail_length", 7, 1],
  ["interp_to_end", 8, 1],
  ["request_process_time", 9, 1],
  ["custom_aabb", 10, 6],
  ["emission_transform", 16, 12],
  ["emitter_velocity", 28, 3],
];
/** render-stream-12.md "Particles table": floats an entry with `trail_poses` poses carries,
 * 31 + 12 x trail_poses. */
export function particlesFloatCount(trailPoses: number): number {
  return PARTICLES_BASE_FLOAT_COUNT + PARTICLES_TRAIL_POSE_FLOATS * trailPoses;
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
  /** P3-TM (render-stream-10.md "Shader time"): /10 only, right after `materials`, present
   * exactly when the resolved state holds an ok shader that uses `time`: the host's shader time
   * is param_f64's float at `f` (the last one). */
  shader_time?: { f: number };
  /** new at /11 (PM1, render-stream-11.md "As built (PM1)", 1): present only when non-empty,
   * right after `materials` (then `removed_multimeshes`, then `shader_time`). */
  multimeshes?: TransactionMultimesh[];
  /** new at /11 (PM1, 1): a patch's removed multimesh ids, present only when non-empty. */
  removed_multimeshes?: number[];
  /** new at /12 (PM5, render-stream-12.md "Particles table"): present only when non-empty,
   * right after `removed_multimeshes` (or `multimeshes`, or `materials`), then
   * `removed_particles` and `particle_emits`, then `shader_time`. */
  particles?: TransactionParticles[];
  /** new at /12: a patch's removed particles ids, present only when non-empty. */
  removed_particles?: number[];
  /** new at /12 (render-stream-12.md "The emit list"): present only when non-empty. */
  particle_emits?: TransactionParticleEmit[];
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
  /** new at /13 (W13a, render-stream-13.md "As built (W13a)"): on every transaction, right
   * before `blocks`: the XXH64 of the reconstructed mesh_f32 || mesh_u8 || mm_f32, 16 lowercase
   * hex digits. */
  predict_check?: string;
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

/** TAG1 (client-extensions-design.md §2.4): a viewer's `item_meta` hello request, and (the same
 * shape) the grant a `full` item_meta record carries. */
export interface ItemMetaRequest {
  /** A subset of class, script, scene, path, in that order. */
  fields: string[];
  /** At most 31 group names (bit i of a row's groups mask is groups[i]). */
  groups: string[];
  /** At most 8 meta keys. */
  meta_keys: string[];
}

/** TAG1: the /13 `item_meta` record (a JSON meta, no blocks). A `full` (grant set, strings_from 0)
 * replaces the receiver's table; a `delta` (grant null) appends strings and upserts rows. A row is
 * `[id]` (an item with no node) or `[id, col...]`: per granted field a string index or null, the
 * groups bitmask when groups are granted, then per meta key a string index or null. */
export interface ItemMetaRecordMeta {
  type: "item_meta";
  form: "full" | "delta";
  grant: ItemMetaRequest | null;
  strings_from: number;
  strings: string[];
  items: Array<Array<number | null>>;
  blocks: BlockDescriptor[];
}

/** TAG1: the identity table as of the newest accepted transaction (`RecordingValidator.itemMeta`).
 * A row is the columns after the id (wire order), or null for an item with no node. */
export interface ItemMetaTable {
  grant: ItemMetaRequest | null;
  strings: string[];
  rows: Map<number, Array<number | null> | null>;
}

export type Rs2Meta =
  | SessionMeta
  | TransactionMeta
  | ResourceMeta
  | EndMeta
  | ItemMetaRecordMeta;

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
// render-stream-8.md: the GRS8 magic, selected by `version: 8` (golden-8/; opt-in, never the
// default: G8w keeps the capture's file sinks and every receiver on /6 and /7).
export const MAGIC_V8: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x38, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// render-stream-9.md: the GRS9 magic, selected by `version: 9` (golden-9/; opt-in, never the
// default: G8k9 keeps the capture's file sinks and every receiver on /6 and /7).
export const MAGIC_V9: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x39, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// render-stream-10.md: the GRSA magic (byte 3 is the version as one uppercase hex digit from /10
// on), selected by `version: 10` (golden-10/; opt-in, never the default).
export const MAGIC_V10: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x41, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// render-stream-11.md "File layout": the GRSB magic (byte 3 'B' is 11), selected by `version: 11`
// (golden-11/; opt-in, never the default).
export const MAGIC_V11: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x42, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// render-stream-12.md "File layout": the GRSC magic (byte 3 'C' is 12), selected by `version: 12`
// (golden-12/; opt-in, never the default).
export const MAGIC_V12: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x43, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// render-stream-13.md "As built (W13a)": the GRSD magic (byte 3 'D' is 13), selected by
// `version: 13` (golden-13/; opt-in, never the default).
export const MAGIC_V13: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x44, 0x0d, 0x0a, 0x1a, 0x0a,
]);
/** G7l: the wire version of a live stream's bytes: 7 when they start with GRS7 (a /7 receiver's
 * received.rs7, or a /7 connection's host tap), 8 when they start with GRS8 (G8w), 9 for GRS9
 * (G8k9), 10 for GRSA (CG1), 11 for GRSB (W11a), 12 for GRSC (PM5), 13 for GRSD (W13d), else 6 -- so every other
 * magic still meets the /6 decoder's own refusal, exactly as before. */
export function wireVersionOf(
  data: Uint8Array | undefined,
): 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 {
  if (!data || data.length < MAGIC_V7.length) return 6;
  const startsWith = (magic: Uint8Array) => {
    for (let i = 0; i < magic.length; i++)
      if (data[i] !== magic[i]) return false;
    return true;
  };
  if (startsWith(MAGIC_V7)) return 7;
  if (startsWith(MAGIC_V8)) return 8;
  if (startsWith(MAGIC_V9)) return 9;
  if (startsWith(MAGIC_V10)) return 10;
  if (startsWith(MAGIC_V11)) return 11;
  if (startsWith(MAGIC_V12)) return 12;
  // W13d: every receiver accepts /13 now (GSW W13c, native and web W13d).
  if (startsWith(MAGIC_V13)) return 13;
  return 6;
}
/** render-stream-9.md "KTX2 payload": the 12-byte KTX2 file identifier (KTX 2.0 section 2.1). */
export const KTX2_IDENTIFIER: Uint8Array = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
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
// render-stream-8.md "Session": "decode" (the declared host texture-decode policy) after "auth".
const RESOURCES_KEYS_V8 = [...RESOURCES_KEYS_V4, "decode"];
// render-stream-9.md "Session": "texture_delivery" after "decode" (the end of the resources object).
const RESOURCES_KEYS_V9 = [...RESOURCES_KEYS_V8, "texture_delivery"];
// render-stream-11.md "Session record": "mesh_dynamic" after "texture_delivery" (last).
const RESOURCES_KEYS_V11 = [...RESOURCES_KEYS_V9, "mesh_dynamic"];
const MESH_DYNAMIC_KEYS = ["mode", "frames", "max_bytes"];
/** render-stream-11.md "Session record": the capture's dynamic-mesh classification policy. */
export const MESH_DYNAMIC_MODES = ["auto", "off", "all"] as const;
export interface MeshDynamicPolicy {
  mode: (typeof MESH_DYNAMIC_MODES)[number];
  frames: number;
  max_bytes: number;
}
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
  // new at /8 (gate8-design.md Q2-Q5): legal in a /8 session only (checkSessionSchema).
  "adopt-skip-state",
  "adopt-no-redraw",
  "adopt-skip-layers",
  "perturb-decode",
  "size-before-adopt",
  "adopt-raw-shader-code",
  "adopt-skip-params",
  // new at /11 (W11b, render-stream-11.md "Sabotage kinds"): legal in a /11 session only.
  "cv-churn",
  "stale-dynamic",
  "keep-carried",
  // new at /11 (PM1, render-stream-11.md "As built (PM1)", 11): legal in a /11 session only.
  "perturb-instance",
  "stale-buffer",
  // new at /12 (PM5, render-stream-12.md "Sabotages"): legal in a /12 session only.
  "perturb-seed",
  "drop-restart",
] as const;
const SABOTAGE_KINDS_V12_ONLY: readonly string[] = [
  "perturb-seed",
  "drop-restart",
];
const SABOTAGE_KINDS_V11_ONLY: readonly string[] = [
  "cv-churn",
  "stale-dynamic",
  "keep-carried",
  "perturb-instance",
  "stale-buffer",
];
const SABOTAGE_KINDS_V8_ONLY: readonly string[] = [
  "adopt-skip-state",
  "adopt-no-redraw",
  "adopt-skip-layers",
  "perturb-decode",
  "size-before-adopt",
  "adopt-raw-shader-code",
  "adopt-skip-params",
];

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
// render-stream-8.md "Session": the late-join adoption declaration, at /8 only.
const ADOPTION_KEY = "adoption";
const ADOPTION_KEYS = ["mode", "frame"];
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
// render-stream-10.md "Item": canvas_group and copy_to_backbuffer, right after instance_params
// and before content_version.
const ITEM_KEYS_V10 = keysWith(
  keysWith(ITEM_KEYS_V5, "instance_params", "canvas_group"),
  "canvas_group",
  "copy_to_backbuffer",
);
// UIT (render-stream-11.md "As built (UIT)"): an item that made
// canvas_item_set_use_identity_transform(true) carries "use_identity_transform": true right after
// copy_to_backbuffer; the key is absent when false.
const ITEM_KEYS_V11_IDENTITY = keysWith(
  ITEM_KEYS_V10,
  "copy_to_backbuffer",
  "use_identity_transform",
);
const CANVAS_GROUP_KEYS = ["mode", "fit_empty", "blur_mipmaps", "f"];
const COPY_TO_BACKBUFFER_KEYS = ["f"];
/** render-stream-10.md "Item": RenderingServer's CanvasGroupMode 1, 2, 3 (0, disabled, is null). */
export const CANVAS_GROUP_MODES = [
  "clip_only",
  "clip_and_draw",
  "transparent",
] as const;
export type CanvasGroupMode = (typeof CANVAS_GROUP_MODES)[number];
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
// render-stream-8.md "Resource tables": adopted_content right after origin, source_format right
// after format (texture), adopted_content right after origin (mesh).
const TEXTURE_KEYS_V8 = [
  "id",
  "origin",
  "adopted_content",
  "kind",
  "status",
  "reason",
  "version",
  "hash",
  "format",
  "source_format",
  "width",
  "height",
  "mipmaps",
  "payload_bytes",
  "canvas",
];
// render-stream-9.md "Texture entries": "variants" right after "payload_bytes".
const TEXTURE_KEYS_V9 = [
  ...TEXTURE_KEYS_V8.slice(0, TEXTURE_KEYS_V8.indexOf("payload_bytes") + 1),
  "variants",
  "canvas",
];
const VARIANT_KEYS = ["encoding", "hash", "payload_bytes", "format", "params"];
const VARIANT_ENCODINGS = ["block", "uastc", "etc1s"] as const;
const TEXTURE_DELIVERY_KEYS = ["mode", "encoder"];
// texture-delivery-design.md D1: the variants each mode offers beside `decoded`.
const DELIVERY_MODE_ENCODINGS: Record<string, readonly string[]> = {
  rgba: [],
  passthrough: ["block"],
  "basis-uastc": ["block", "uastc"],
  "basis-etc1s": ["etc1s"],
};
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
const MESH_KEYS_V8 = [
  "id",
  "origin",
  "adopted_content",
  "status",
  "reason",
  "version",
  "f",
  "surfaces",
];
// render-stream-11.md "Mesh entry": "u8" right after "f".
const MESH_KEYS_V11 = keysWith(MESH_KEYS_V8, "f", "u8");
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
// new at /12 (PM5, render-stream-12.md "The `particle_process_material` builtin"): keys in this
// order, and the enum spellings in enum order.
const PROCESS_BUILTIN_KEYS = [
  "kind",
  "emission_shape",
  "particle_flags",
  "textures",
  "color_ramp",
  "color_initial_ramp",
  "alpha_curve",
  "emission_curve",
  "velocity_limit_curve",
  "orbit_velocity_curve_xyz",
  "emission_color_texture",
  "sub_emitter",
  "attractor",
  "collision",
  "collision_scale",
  "turbulence",
];
const EMISSION_SHAPES = [
  "point",
  "sphere",
  "sphere_surface",
  "box",
  "points",
  "directed_points",
  "ring",
] as const;
const PARTICLE_FLAGS = [
  "align_y_to_velocity",
  "rotate_y",
  "disable_z",
  "damping_as_friction",
] as const;
const PROCESS_PARAMETERS = [
  "initial_linear_velocity",
  "angular_velocity",
  "orbit_velocity",
  "linear_accel",
  "radial_accel",
  "tangential_accel",
  "damping",
  "angle",
  "scale",
  "hue_variation",
  "anim_speed",
  "anim_offset",
  "turb_influence_over_life",
  "turb_vel_influence",
  "turb_init_displacement",
  "radial_velocity",
  "directional_velocity",
  "scale_over_velocity",
] as const;
const SUB_EMITTER_MODES = [
  "disabled",
  "constant",
  "at_end",
  "at_collision",
  "at_start",
] as const;
const COLLISION_MODES = ["disabled", "rigid", "hide_on_contact"] as const;
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
// render-stream-10.md "Transaction blocks": seven blocks; backbuffer_f32 is type "f32".
const TRANSACTION_BLOCK_NAMES_V10 = [
  ...TRANSACTION_BLOCK_NAMES_V5,
  "backbuffer_f32",
];
const TRANSACTION_BLOCK_TYPES_V10: Array<"f32" | "i32" | "f64"> = [
  ...TRANSACTION_BLOCK_TYPES_V5,
  "f32",
];
// render-stream-11.md "Transaction blocks": nine blocks; mesh_u8 (type "u8", the one legal place
// for a u8 block outside a resource record) and mm_f32 (type "f32", empty until PM1).
const TRANSACTION_BLOCK_NAMES_V11 = [
  ...TRANSACTION_BLOCK_NAMES_V10,
  "mesh_u8",
  "mm_f32",
];
const TRANSACTION_BLOCK_TYPES_V11: Array<"f32" | "i32" | "f64" | "u8"> = [
  ...TRANSACTION_BLOCK_TYPES_V10,
  "u8",
  "f32",
];
// render-stream-12.md "Transaction keys and blocks": /11's nine, then pt_f32 (type "f32") only
// when it holds at least one float.
const TRANSACTION_BLOCK_NAMES_V12 = [...TRANSACTION_BLOCK_NAMES_V11, "pt_f32"];
const TRANSACTION_BLOCK_TYPES_V12: Array<"f32" | "i32" | "f64" | "u8"> = [
  ...TRANSACTION_BLOCK_TYPES_V11,
  "f32",
];
/** render-stream-12.md: the index of the optional tenth transaction block, pt_f32. */
export const PT_F32_BLOCK = 9;

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
// render-stream-9.md "Texture reasons": legal at /9 only.
const TEXTURE_REASONS_V9 = [...TEXTURE_REASONS, "delivery-pending"] as const;
const UNSUPPORTED_CMD_REASONS = [
  "unsupported-op",
  "unknown-texture",
  "canvas-texture-headless",
  "unknown-mesh",
  "skinned-geometry",
] as const;
// new at /11 (PM1, render-stream-11.md "As built (PM1)", 7).
const UNSUPPORTED_CMD_REASONS_V11 = [
  ...UNSUPPORTED_CMD_REASONS,
  "unknown-multimesh",
] as const;
// new at /12 (PM5, render-stream-12.md "The command").
const UNSUPPORTED_CMD_REASONS_V12 = [
  ...UNSUPPORTED_CMD_REASONS_V11,
  "unknown-particles",
] as const;
const ADD_MULTIMESH_KEYS = ["op", "multimesh", "tex"];
const ADD_PARTICLES_KEYS = ["op", "particles", "tex"];
// PM5, render-stream-12.md "Particles table": the entry, keys in this order.
const PARTICLES_KEYS = [
  "id",
  "origin",
  "status",
  "reason",
  "version",
  "mode",
  "emitting",
  "amount",
  "one_shot",
  "fixed_fps",
  "interpolate",
  "fractional_delta",
  "local",
  "draw_order",
  "transform_align",
  "trails",
  "trail_poses",
  "seed",
  "restarts",
  "emits",
  "process_requests",
  "process_material",
  "draw_passes",
  "subemitter",
  "f",
];
const PARTICLES_STATUSES = ["ok", "unsupported", "freed"] as const;
const PARTICLES_REASONS = [
  "particles-3d",
  "unknown-material",
  "unknown-mesh",
  "unknown-particles",
] as const;
const PARTICLES_DRAW_ORDERS = [
  "index",
  "lifetime",
  "reverse_lifetime",
  "view_depth",
] as const;
const PARTICLES_TRANSFORM_ALIGNS = [
  "disabled",
  "z_billboard",
  "y_to_velocity",
  "z_billboard_y_to_velocity",
] as const;
const PARTICLE_EMIT_KEYS = ["particles", "restarts", "flags", "f"];
// PM1, render-stream-11.md "As built (PM1)", 2: the multimesh entry, keys in this order.
const MULTIMESH_KEYS = [
  "id",
  "origin",
  "status",
  "reason",
  "version",
  "mesh",
  "format",
  "colors",
  "custom",
  "instances",
  "visible",
  "aabb_f",
  "buffer_f",
];
const MULTIMESH_STATUSES = ["ok", "unsupported", "freed"] as const;
const MULTIMESH_REASONS = [
  "multimesh-3d",
  "multimesh-indirect",
  "multimesh-interpolated",
  "unknown-mesh",
  "payload-too-large",
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
// new at /11 (PM1, render-stream-11.md "As built (PM1)", 7): the two multimesh item reasons.
const ITEM_UNSUPPORTED_REASONS_V11 = [
  ...ITEM_UNSUPPORTED_REASONS_V5,
  "unknown-multimesh",
  "unsupported-multimesh",
] as const;
// new at /12 (PM5, render-stream-12.md "The command"): the two particles item reasons.
const ITEM_UNSUPPORTED_REASONS_V12 = [
  ...ITEM_UNSUPPORTED_REASONS_V11,
  "unknown-particles",
  "unsupported-particles",
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
  // render-stream-8.md "Resource tables": an adopted shader whose code could not be recovered
  // (gate8-design.md Q5); legal at /8 on an adopted entry only.
  "shader-adopt-include",
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
// render-stream-8.md "Session": resources.decode, the host's declared texture-decode policy.
const TEXTURE_DECODES = ["off", "engine"] as const;
// render-stream-8.md "Resource tables": the adopted_content values.
const ADOPTED_CONTENTS = ["current", "creation"] as const;
// render-stream-2.md "Texture payload": every Image.Format name, in enum order. A texture entry's
// source_format must be one of these.
const IMAGE_FORMAT_NAMES: readonly string[] = [
  "L8",
  "LA8",
  "R8",
  "RG8",
  "RGB8",
  "RGBA8",
  "RGBA4444",
  "RGB565",
  "RF",
  "RGF",
  "RGBF",
  "RGBAF",
  "RH",
  "RGH",
  "RGBH",
  "RGBAH",
  "RGBE9995",
  "DXT1",
  "DXT3",
  "DXT5",
  "RGTC_R",
  "RGTC_RG",
  "BPTC_RGBA",
  "BPTC_RGBF",
  "BPTC_RGBFU",
  "ETC",
  "ETC2_R11",
  "ETC2_R11S",
  "ETC2_RG11",
  "ETC2_RG11S",
  "ETC2_RGB8",
  "ETC2_RGBA8",
  "ETC2_RGB8A1",
  "ETC2_RA_AS_RG",
  "DXT5_RA_AS_RG",
  "ASTC_4x4",
  "ASTC_4x4_HDR",
  "ASTC_8x8",
  "ASTC_8x8_HDR",
];

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
// render-stream-8.md "Texture payload" (D9): the float formats, legal at /8 only, with Godot's
// pixel sizes (RF 4, RGF 8, RGBF 12, RGBAF 16, RH 2, RGH 4, RGBH 6, RGBAH 8).
const FLOAT_PIXEL_SIZES: Record<string, number> = {
  RF: 4,
  RGF: 8,
  RGBF: 12,
  RGBAF: 16,
  RH: 2,
  RGH: 4,
  RGBH: 6,
  RGBAH: 8,
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
  types?: ReadonlyArray<"f32" | "i32" | "f64" | "u8">,
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
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: resources ${detail}`,
  ];
  const isV4OrLater =
    version === 4 ||
    version === 5 ||
    version === 6 ||
    version === 7 ||
    version === 8 ||
    version === 9 ||
    version === 10 ||
    version === 11 ||
    version === 12 ||
    version === 13;
  const keys =
    version >= 11
      ? RESOURCES_KEYS_V11
      : version >= 9
        ? RESOURCES_KEYS_V9
        : version === 8
          ? RESOURCES_KEYS_V8
          : isV4OrLater
            ? RESOURCES_KEYS_V4
            : RESOURCES_KEYS;
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
  if (version >= 8 && !isOneOf(resources.decode, TEXTURE_DECODES)) {
    return err('"decode" must be "off" or "engine"');
  }
  if (version >= 9) {
    // render-stream-9.md "Session": texture_delivery is {"mode":<D1 mode>,"encoder":null|<prefix>}.
    const delivery = resources.texture_delivery;
    if (
      !isPlainObject(delivery) ||
      !hasExactKeys(delivery, TEXTURE_DELIVERY_KEYS)
    ) {
      return err('"texture_delivery" has the wrong keys');
    }
    if (
      typeof delivery.mode !== "string" ||
      !(delivery.mode in DELIVERY_MODE_ENCODINGS)
    ) {
      return err(
        '"texture_delivery.mode" must be "rgba", "passthrough", "basis-uastc" or "basis-etc1s"',
      );
    }
    if (
      !(
        delivery.encoder === null ||
        (typeof delivery.encoder === "string" &&
          /^[a-z0-9][a-z0-9._-]*$/.test(delivery.encoder))
      )
    ) {
      return err(
        '"texture_delivery.encoder" is neither null nor a params_id prefix',
      );
    }
  }
  if (version >= 11) {
    // render-stream-11.md "Session record" (self-coded, like adoption-entry): exactly the three
    // keys, one of the three modes, frames 1..60 and max_bytes >= 0.
    const policy = resources.mesh_dynamic;
    const policyErr = (detail: string) => [
      `mesh-dynamic-policy: record at offset ${offset}: resources.mesh_dynamic ${detail}`,
    ];
    if (!isPlainObject(policy) || !hasExactKeys(policy, MESH_DYNAMIC_KEYS))
      return policyErr("has the wrong keys");
    if (!isOneOf(policy.mode, MESH_DYNAMIC_MODES))
      return policyErr('"mode" must be "auto", "off" or "all"');
    if (!isInt(policy.frames) || policy.frames < 1 || policy.frames > 60)
      return policyErr('"frames" is not an integer in 1..60');
    if (!isInt(policy.max_bytes) || policy.max_bytes < 0)
      return policyErr('"max_bytes" is not a non-negative integer');
  }
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
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: ${detail}`,
  ];
  // render-stream-11.md "Session record": /11's one new session key (resources.mesh_dynamic) is
  // checked by checkResourcesSchema; here only the protocol string changes. /12 adds no session
  // key either (render-stream-12.md "Session record": only the protocol and the features).
  // render-stream-13.md "As built (W13a)": /13 is /12 plus the predicted blocks (isV12 means
  // "V12 or later").
  const isV13 = version === 13;
  const isV12 = version === 12 || isV13;
  // isV11 means "V11 or later".
  const isV11 = version === 11 || isV12;
  // isV10 means "V10 or later".
  const isV10 = version === 10 || isV11;
  // isV9 means "V9 or later": /10 is /9 plus exactly render-stream-10.md's list (no new
  // session key; only the protocol string and the features list change).
  const isV9 = version === 9 || isV10;
  // isV8 means "V8 or later": /9 is /8 plus exactly render-stream-9.md's list.
  const isV8 = version === 8 || isV9;
  // isV7 means "V7 or later": /8 is /7 plus exactly render-stream-8.md's list, so it keeps the
  // publication credit_window.
  const isV7 = version === 7 || isV8;
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
  // render-stream-8.md "Session": "adoption" is always present at /8, right after
  // "unknown_item_policy" (or after "sabotage" when the policy key is absent).
  let expectedKeys: string[] = skipDeclared
    ? keysWith(sessionKeys, "sabotage", UNKNOWN_ITEM_POLICY_KEY)
    : [...sessionKeys];
  if (isV8) {
    expectedKeys = keysWith(
      expectedKeys,
      skipDeclared ? UNKNOWN_ITEM_POLICY_KEY : "sabotage",
      ADOPTION_KEY,
    );
  }
  if (!hasExactKeys(meta, expectedKeys))
    return err("session has the wrong top-level keys or order");
  if (skipDeclared && meta.unknown_item_policy !== "skip")
    return err('"unknown_item_policy" must be "skip" when present');
  const expectedProtocol = isV13
    ? "render-stream/13"
    : isV12
    ? "render-stream/12"
    : isV11
      ? "render-stream/11"
      : isV10
      ? "render-stream/10"
      : isV9
        ? "render-stream/9"
        : isV8
          ? "render-stream/8"
          : isV7
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
    if (!isV8 && SABOTAGE_KINDS_V8_ONLY.includes(sabotage.kind)) {
      return err(`"sabotage.kind" "${sabotage.kind}" is legal only at /8`);
    }
    if (!isV11 && SABOTAGE_KINDS_V11_ONLY.includes(sabotage.kind)) {
      return err(`"sabotage.kind" "${sabotage.kind}" is legal only at /11`);
    }
    if (!isV12 && SABOTAGE_KINDS_V12_ONLY.includes(sabotage.kind)) {
      return err(`"sabotage.kind" "${sabotage.kind}" is legal only at /12`);
    }
  }

  if (isV8) {
    // render-stream-8.md "Session": adoption is null (off) or {"mode":"arm","frame":<int >= 1>}.
    const adoption = meta[ADOPTION_KEY];
    if (adoption !== null) {
      if (
        !isPlainObject(adoption) ||
        !hasExactKeys(adoption, ADOPTION_KEYS) ||
        adoption.mode !== "arm" ||
        !isInt(adoption.frame)
      ) {
        return [
          `adoption-entry: record at offset ${offset}: "adoption" is neither null nor {"mode":"arm","frame":<integer>}`,
        ];
      }
      if (adoption.frame < 1) {
        return [
          `adoption-entry: record at offset ${offset}: adoption.frame is ${adoption.frame}, not >= 1`,
        ];
      }
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

// render-stream-8.md "Resource tables": the origin check shared by the four resource tables. At
// <8 only "created" is legal; at /8 "adopted" too (D1).
function checkTableOrigin(origin: unknown, version: number): string | null {
  if (version >= 8) {
    return origin === "created" || origin === "adopted"
      ? null
      : '"origin" must be "created" or "adopted"';
  }
  return origin === "created" ? null : '"origin" must be "created"';
}

// render-stream-8.md "Resource tables": adopted_content is non-null exactly when origin is
// "adopted" (texture and mesh entries, /8 only).
function checkAdoptedContent(
  e: Record<string, unknown>,
  offset: number,
  what: string,
): string[] {
  if (
    !(
      e.adopted_content === null || isOneOf(e.adopted_content, ADOPTED_CONTENTS)
    )
  ) {
    return [
      `meta-schema: record at offset ${offset}: a ${what} entry's "adopted_content" is neither null nor "current"/"creation"`,
    ];
  }
  if ((e.origin === "adopted") !== (e.adopted_content !== null)) {
    return [
      `adoption-entry: record at offset ${offset}: a ${what} entry's "adopted_content" must be non-null exactly when "origin" is "adopted"`,
    ];
  }
  return [];
}

function checkTextureEntrySchema(
  t: unknown,
  offset: number,
  version: number,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: a textures[] entry ${detail}`,
  ];
  if (
    !isPlainObject(t) ||
    !hasExactKeys(
      t,
      version >= 9
        ? TEXTURE_KEYS_V9
        : version >= 8
          ? TEXTURE_KEYS_V8
          : TEXTURE_KEYS,
    )
  ) {
    return err("has the wrong keys");
  }
  if (!isInt(t.id) || t.id < 1) return err('"id" is not an integer >= 1');
  const originError = checkTableOrigin(t.origin, version);
  if (originError !== null) return err(originError);
  if (version >= 8) {
    const contentError = checkAdoptedContent(t, offset, "textures[]");
    if (contentError.length > 0) return contentError;
    if (
      !(
        t.source_format === null ||
        (typeof t.source_format === "string" &&
          IMAGE_FORMAT_NAMES.includes(t.source_format))
      )
    ) {
      return err('"source_format" is neither null nor an Image format name');
    }
  }
  if (!isOneOf(t.kind, TEXTURE_KINDS)) return err("has an invalid kind");
  if (!isOneOf(t.status, TEXTURE_STATUSES)) return err("has an invalid status");
  if (
    !(
      t.reason === null ||
      isOneOf(t.reason, version >= 9 ? TEXTURE_REASONS_V9 : TEXTURE_REASONS)
    )
  ) {
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
  if (version >= 9) {
    // render-stream-9.md "Texture entries": variants is an array of five-key objects; the
    // cross-entry rules (order, one per encoding, which entries may carry any) are delivery-entry.
    if (!Array.isArray(t.variants)) return err('"variants" is not an array');
    for (const v of t.variants) {
      if (!isPlainObject(v) || !hasExactKeys(v, VARIANT_KEYS)) {
        return err('has a "variants" entry with the wrong keys');
      }
      if (!isOneOf(v.encoding, VARIANT_ENCODINGS)) {
        return err('has a variant with an invalid "encoding"');
      }
      if (!isLowerHex(v.hash, 64)) {
        return err('has a variant "hash" that is not 64 lowercase hex digits');
      }
      if (!isInt(v.payload_bytes) || v.payload_bytes < 0) {
        return err(
          'has a variant "payload_bytes" that is not a non-negative integer',
        );
      }
      if (!(v.format === null || typeof v.format === "string")) {
        return err('has a variant "format" that is neither null nor a string');
      }
      if (!(v.params === null || typeof v.params === "string")) {
        return err('has a variant "params" that is neither null nor a string');
      }
    }
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
function checkMeshSurfaceSchema(
  s: unknown,
  offset: number,
  version: number,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: a meshes[].surfaces[] entry ${detail}`,
  ];
  if (!isPlainObject(s) || !hasExactKeys(s, MESH_SURFACE_KEYS)) {
    return err("has the wrong keys");
  }
  // render-stream-11.md "Mesh entry": a dynamic surface's hash is null (mesh-dynamic checks the
  // coupling).
  if (!(version >= 11 && s.hash === null) && !isLowerHex(s.hash, 64))
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

function checkMeshEntrySchema(
  m: unknown,
  offset: number,
  version: number,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: a meshes[] entry ${detail}`,
  ];
  if (
    !isPlainObject(m) ||
    !hasExactKeys(
      m,
      version >= 11 ? MESH_KEYS_V11 : version >= 8 ? MESH_KEYS_V8 : MESH_KEYS,
    )
  ) {
    return err("has the wrong keys");
  }
  if (!isInt(m.id) || m.id < 1) return err('"id" is not an integer >= 1');
  const originError = checkTableOrigin(m.origin, version);
  if (originError !== null) return err(originError);
  if (version >= 8) {
    const contentError = checkAdoptedContent(m, offset, "meshes[]");
    if (contentError.length > 0) return contentError;
  }
  if (!isOneOf(m.status, MESH_STATUSES)) return err("has an invalid status");
  if (!(m.reason === null || isOneOf(m.reason, MESH_REASONS))) {
    return err('"reason" is neither null nor a valid mesh reason');
  }
  if (!isInt(m.version) || m.version < 1)
    return err('"version" is not an integer >= 1');
  if (!(m.f === null || (isInt(m.f) && m.f >= 0))) {
    return err('"f" is neither null nor a non-negative integer');
  }
  if (version >= 11 && !(m.u8 === null || (isInt(m.u8) && m.u8 >= 0))) {
    return err('"u8" is neither null nor a non-negative integer');
  }
  if (!Array.isArray(m.surfaces)) return err('"surfaces" is not an array');
  for (const s of m.surfaces) {
    const surfaceErr = checkMeshSurfaceSchema(s, offset, version);
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

/** render-stream-12.md "The `particle_process_material` builtin" (builtin-entry): exactly
 * PROCESS_BUILTIN_KEYS in order, these spellings, and each list strictly increasing in enum
 * order. Returns what is wrong, or null. */
function checkProcessBuiltin(b: Record<string, unknown>): string | null {
  if (!hasExactKeys(b, PROCESS_BUILTIN_KEYS))
    return "has the wrong keys or key order";
  if (!isOneOf(b.emission_shape, EMISSION_SHAPES))
    return '"emission_shape" is not a valid emission shape';
  const strictlyIncreasing = (
    value: unknown,
    spellings: readonly string[],
  ): boolean => {
    if (!Array.isArray(value)) return false;
    let last = -1;
    for (const x of value) {
      const i = typeof x === "string" ? spellings.indexOf(x) : -1;
      if (i <= last) return false;
      last = i;
    }
    return true;
  };
  if (!strictlyIncreasing(b.particle_flags, PARTICLE_FLAGS))
    return '"particle_flags" is not a strictly increasing list of particle flags';
  if (!strictlyIncreasing(b.textures, PROCESS_PARAMETERS))
    return '"textures" is not a strictly increasing list of process parameters';
  for (const key of [
    "color_ramp",
    "color_initial_ramp",
    "alpha_curve",
    "emission_curve",
    "velocity_limit_curve",
    "orbit_velocity_curve_xyz",
    "emission_color_texture",
    "attractor",
    "collision_scale",
    "turbulence",
  ])
    if (typeof b[key] !== "boolean") return `"${key}" is not a boolean`;
  if (!isOneOf(b.sub_emitter, SUB_EMITTER_MODES))
    return '"sub_emitter" is not a valid sub-emitter mode';
  if (!isOneOf(b.collision, COLLISION_MODES))
    return '"collision" is not a valid collision mode';
  return null;
}

function checkShaderEntrySchema(
  s: unknown,
  offset: number,
  version: number,
): string[] {
  const err = (detail: string) => [
    `shader-entry: record at offset ${offset}: a shaders[] entry ${detail}`,
  ];
  if (!isPlainObject(s) || !hasExactKeys(s, SHADER_KEYS)) {
    return err("has the wrong keys");
  }
  if (!isInt(s.id) || s.id < 1) return err('"id" is not an integer >= 1');
  {
    const originError = checkTableOrigin(s.origin, version);
    if (originError !== null) return err(originError);
  }
  if (!isOneOf(s.status, SHADER_STATUSES)) return err("has an invalid status");
  if (!(s.reason === null || isOneOf(s.reason, SHADER_REASONS))) {
    return err('"reason" is neither null nor a valid shader reason');
  }
  if ((s.status === "ok") !== (s.reason === null)) {
    return err('"reason" must be null exactly for status "ok"');
  }
  if (
    s.reason === "shader-adopt-include" &&
    (version < 8 || s.origin !== "adopted" || s.hash !== null)
  ) {
    return err(
      '"reason" "shader-adopt-include" needs render-stream/8, origin "adopted" and no code',
    );
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
  if (
    isPlainObject(builtin) &&
    builtin.kind === "particle_process_material"
  ) {
    // render-stream-12.md "The `particle_process_material` builtin": the kind is /12's only
    // (below, meta-schema), self-coded builtin-entry, and only on a "particles"-mode shader.
    if (version < 12)
      return [
        `meta-schema: record at offset ${offset}: a shaders[] entry's builtin kind "particle_process_material" needs render-stream/12`,
      ];
    const builtinError = checkProcessBuiltin(builtin);
    if (builtinError !== null)
      return [
        `builtin-entry: record at offset ${offset}: shader ${String(s.id)}'s "particle_process_material" builtin ${builtinError}`,
      ];
    if (s.mode !== "particles")
      return [
        `builtin-entry: record at offset ${offset}: shader ${String(s.id)} carries a "particle_process_material" builtin, but its mode is ${JSON.stringify(s.mode)}, not "particles"`,
      ];
  } else if (builtin !== null) {
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

function checkMaterialEntrySchema(
  m: unknown,
  offset: number,
  version: number,
): string[] {
  const err = (detail: string) => [
    `material-entry: record at offset ${offset}: a materials[] entry ${detail}`,
  ];
  if (!isPlainObject(m) || !hasExactKeys(m, MATERIAL_KEYS)) {
    return err("has the wrong keys");
  }
  if (!isInt(m.id) || m.id < 1) return err('"id" is not an integer >= 1');
  {
    const originError = checkTableOrigin(m.origin, version);
    if (originError !== null) return err(originError);
  }
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

/** render-stream-12.md "Particles table": one particles[] entry's key set, order and value
 * types (meta-schema); the shape rules are the validator's particles-entry. Returns what is
 * wrong, or null. */
function checkParticlesEntrySchema(p: unknown): string | null {
  if (!isPlainObject(p) || !hasExactKeys(p, PARTICLES_KEYS))
    return "has the wrong keys";
  const nonNegInt = (x: unknown) => isInt(x) && (x as number) >= 0;
  const optId = (x: unknown) => x === null || (isInt(x) && (x as number) >= 1);
  if (!isInt(p.id) || p.id < 1) return '"id" is not an integer >= 1';
  // PM7 (render-stream-12.md "As built (PM7)"): an emitter that existed before arm is "adopted".
  if (p.origin !== "created" && p.origin !== "adopted")
    return '"origin" must be "created" or "adopted"';
  if (!isOneOf(p.status, PARTICLES_STATUSES)) return "has an invalid status";
  if (!(p.reason === null || isOneOf(p.reason, PARTICLES_REASONS)))
    return '"reason" is neither null nor a valid particles reason';
  if (!isInt(p.version) || p.version < 1)
    return '"version" is not an integer >= 1';
  if (!isOneOf(p.mode, ["2d", "3d"] as const))
    return '"mode" must be "2d" or "3d"';
  for (const key of [
    "emitting",
    "one_shot",
    "interpolate",
    "fractional_delta",
    "local",
    "trails",
  ])
    if (typeof p[key] !== "boolean") return `"${key}" is not a boolean`;
  for (const key of [
    "amount",
    "fixed_fps",
    "trail_poses",
    "restarts",
    "emits",
    "process_requests",
  ])
    if (!nonNegInt(p[key])) return `"${key}" is not an integer >= 0`;
  if (!isOneOf(p.draw_order, PARTICLES_DRAW_ORDERS))
    return '"draw_order" is not a valid draw order';
  if (!isOneOf(p.transform_align, PARTICLES_TRANSFORM_ALIGNS))
    return '"transform_align" is not a valid transform alignment';
  if (!nonNegInt(p.seed) || (p.seed as number) > 0xffffffff)
    return '"seed" is not an integer in 0..4294967295';
  if (!optId(p.process_material))
    return '"process_material" is neither null nor an integer >= 1';
  if (!Array.isArray(p.draw_passes) || !p.draw_passes.every(optId))
    return '"draw_passes" is not an array of null or integers >= 1';
  if (!optId(p.subemitter))
    return '"subemitter" is neither null nor an integer >= 1';
  if (!(p.f === null || nonNegInt(p.f)))
    return '"f" is neither null nor a non-negative integer';
  return null;
}

function checkTransactionSchema(
  meta: Record<string, unknown>,
  offset: number,
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: ${detail}`,
  ];
  // isV6 means "V6 or later" (render-stream-7.md: transactions are byte-identical to /6).
  const isV6 =
    version === 6 ||
    version === 7 ||
    version === 8 ||
    version === 9 ||
    version === 10 ||
    version === 11 ||
    version === 12 ||
    version === 13;
  // render-stream-12.md: the particles table, the emit list, add_particles and the optional
  // tenth block pt_f32.
  // render-stream-13.md "As built (W13a)": /13 is /12 plus the predicted blocks (isV12 means
  // "V12 or later").
  const isV13 = version === 13;
  const isV12 = version === 12 || isV13;
  // render-stream-11.md: dynamic mesh surfaces (mesh entry key u8, a null surface hash), the
  // eighth and ninth blocks mesh_u8 (u8) and mm_f32, and a patch's null "unsupported" (isV11
  // means "V11 or later").
  const isV11 = version === 11 || isV12;
  // render-stream-10.md "Item"/"Transaction blocks": the two back-buffer item keys and the
  // seventh block, backbuffer_f32 (isV10 means "V10 or later").
  const isV10 = version === 10 || isV11;
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
  // P3-TM (render-stream-10.md "Shader time"): /10's optional shader_time, right after materials.
  const hasShaderTime = isV10 && "shader_time" in meta;
  let expectedKeys: readonly string[] = hasUnknownItems
    ? keysWith(transactionKeys, "unsupported", UNKNOWN_ITEMS_KEY)
    : transactionKeys;
  // PM1 (render-stream-11.md "As built (PM1)", 1): /11's optional multimeshes and
  // removed_multimeshes, right after materials and before shader_time, each only when non-empty.
  const hasMultimeshes = isV11 && "multimeshes" in meta;
  const hasRemovedMultimeshes = isV11 && "removed_multimeshes" in meta;
  if (hasShaderTime)
    expectedKeys = keysWith(expectedKeys, "materials", "shader_time");
  if (hasRemovedMultimeshes)
    expectedKeys = keysWith(expectedKeys, "materials", "removed_multimeshes");
  if (hasMultimeshes)
    expectedKeys = keysWith(expectedKeys, "materials", "multimeshes");
  // PM5 (render-stream-12.md "Transaction keys and blocks"): /12's optional particles,
  // removed_particles and particle_emits, right after removed_multimeshes (or multimeshes, or
  // materials) and before shader_time, each only when non-empty.
  const hasParticles = isV12 && "particles" in meta;
  const hasRemovedParticles = isV12 && "removed_particles" in meta;
  const hasParticleEmits = isV12 && "particle_emits" in meta;
  {
    const anchor = hasRemovedMultimeshes
      ? "removed_multimeshes"
      : hasMultimeshes
        ? "multimeshes"
        : "materials";
    if (hasParticleEmits)
      expectedKeys = keysWith(expectedKeys, anchor, "particle_emits");
    if (hasRemovedParticles)
      expectedKeys = keysWith(expectedKeys, anchor, "removed_particles");
    if (hasParticles) expectedKeys = keysWith(expectedKeys, anchor, "particles");
  }
  // W13a (render-stream-13.md "As built (W13a)"): predict_check on every /13 transaction, right
  // before "blocks".
  if (isV13) {
    const at = expectedKeys.indexOf("blocks");
    expectedKeys = [
      ...expectedKeys.slice(0, at),
      "predict_check",
      ...expectedKeys.slice(at),
    ];
  }
  if (!hasExactKeys(meta, expectedKeys))
    return err("transaction has the wrong top-level keys or order");
  if (isV13 && !isLowerHex(meta.predict_check, 16))
    return err('"predict_check" is not 16 lowercase hex digits');
  if (hasParticles) {
    if (!Array.isArray(meta.particles) || meta.particles.length === 0)
      return err(
        '"particles" must be a non-empty array when present (an empty table is the absent key)',
      );
    for (const p of meta.particles) {
      const particlesError = checkParticlesEntrySchema(p);
      if (particlesError !== null)
        return err(`a particles[] entry ${particlesError}`);
    }
  }
  if (hasRemovedParticles) {
    if (
      !isIntArray(meta.removed_particles) ||
      meta.removed_particles.length === 0
    )
      return err(
        '"removed_particles" must be a non-empty array of integers when present',
      );
  }
  if (hasParticleEmits) {
    if (!Array.isArray(meta.particle_emits) || meta.particle_emits.length === 0)
      return err(
        '"particle_emits" must be a non-empty array when present (an empty list is the absent key)',
      );
    for (const e of meta.particle_emits) {
      if (
        !isPlainObject(e) ||
        !hasExactKeys(e, PARTICLE_EMIT_KEYS) ||
        !isInt(e.particles) ||
        e.particles < 1 ||
        !isInt(e.restarts) ||
        e.restarts < 0 ||
        !isInt(e.flags) ||
        e.flags < 0 ||
        e.flags > 31 ||
        !isInt(e.f) ||
        e.f < 0
      )
        return err(
          "a particle_emits[] element has the wrong keys or an invalid field",
        );
    }
  }
  if (hasMultimeshes) {
    if (!Array.isArray(meta.multimeshes) || meta.multimeshes.length === 0)
      return err('"multimeshes" must be a non-empty array when present');
    for (const m of meta.multimeshes) {
      if (
        !isPlainObject(m) ||
        !hasExactKeys(m, MULTIMESH_KEYS) ||
        !isInt(m.id) ||
        m.id < 1 ||
        !isOneOf(m.origin, ["created", "adopted"] as const) ||
        !isOneOf(m.status, MULTIMESH_STATUSES) ||
        !(m.reason === null || isOneOf(m.reason, MULTIMESH_REASONS)) ||
        !isInt(m.version) ||
        m.version < 1 ||
        !(m.mesh === null || (isInt(m.mesh) && m.mesh >= 1)) ||
        !isOneOf(m.format, ["2d", "3d"] as const) ||
        typeof m.colors !== "boolean" ||
        typeof m.custom !== "boolean" ||
        !isInt(m.instances) ||
        m.instances < 0 ||
        !isInt(m.visible) ||
        m.visible < -1 ||
        !(m.aabb_f === null || (isInt(m.aabb_f) && m.aabb_f >= 0)) ||
        !(m.buffer_f === null || (isInt(m.buffer_f) && m.buffer_f >= 0))
      )
        return err("a multimeshes[] entry is malformed");
    }
  }
  if (hasRemovedMultimeshes) {
    if (
      !isIntArray(meta.removed_multimeshes) ||
      meta.removed_multimeshes.length === 0
    )
      return err(
        '"removed_multimeshes" must be a non-empty array of integers when present',
      );
  }
  if (hasShaderTime) {
    const t = meta.shader_time;
    if (
      !isPlainObject(t) ||
      !hasExactKeys(t, ["f"]) ||
      !isInt(t.f) ||
      (t.f as number) < 0
    )
      return err('"shader_time" must be {f}, an integer >= 0');
  }
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

  // render-stream-11.md "Patched unsupported" (WB): null in a patch means "as the base"; a full
  // transaction always carries the list.
  const unsupportedNull =
    isV11 && meta.unsupported === null && meta.encoding === "patch";
  if (!unsupportedNull && !Array.isArray(meta.unsupported))
    return err(
      isV11 && meta.unsupported === null
        ? '"unsupported" is null in a full transaction (legal in a patch only)'
        : '"unsupported" is not an array',
    );
  for (const u of unsupportedNull ? [] : (meta.unsupported as unknown[])) {
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
        : isV12
          ? ITEM_UNSUPPORTED_REASONS_V12
          : isV11
            ? ITEM_UNSUPPORTED_REASONS_V11
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
    // UIT (render-stream-11.md "As built (UIT)"): /11's optional use_identity_transform, right
    // after copy_to_backbuffer, present only when true (one spelling per state).
    const hasIdentity =
      isV11 && isPlainObject(it) && "use_identity_transform" in it;
    if (hasIdentity && it.use_identity_transform !== true) {
      return err('an items[] entry has an invalid "use_identity_transform" (only true is written)');
    }
    if (
      !isPlainObject(it) ||
      !hasExactKeys(
        it,
        hasIdentity
          ? ITEM_KEYS_V11_IDENTITY
          : isV10
            ? ITEM_KEYS_V10
            : isV5
              ? ITEM_KEYS_V5
              : ITEM_KEYS,
      ) ||
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
    if (isV10) {
      // render-stream-10.md "Transaction blocks": null or an object of exactly its keys, a mode
      // among the three spellings, boolean flags and a non-negative integer f.
      const cg = it.canvas_group;
      if (
        !(
          cg === null ||
          (isPlainObject(cg) &&
            hasExactKeys(cg, CANVAS_GROUP_KEYS) &&
            isOneOf(cg.mode, CANVAS_GROUP_MODES) &&
            typeof cg.fit_empty === "boolean" &&
            typeof cg.blur_mipmaps === "boolean" &&
            isInt(cg.f) &&
            cg.f >= 0)
        )
      ) {
        return err('an items[] entry has an invalid "canvas_group"');
      }
      const copy = it.copy_to_backbuffer;
      if (
        !(
          copy === null ||
          (isPlainObject(copy) &&
            hasExactKeys(copy, COPY_TO_BACKBUFFER_KEYS) &&
            isInt(copy.f) &&
            copy.f >= 0)
        )
      ) {
        return err('an items[] entry has an invalid "copy_to_backbuffer"');
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
        } else if (cmd.op === "add_multimesh" && isV11) {
          // PM1 (render-stream-11.md "As built (PM1)", 7); below /11 an unknown op.
          if (
            !hasExactKeys(cmd, ADD_MULTIMESH_KEYS) ||
            !isInt(cmd.multimesh) ||
            cmd.multimesh < 1 ||
            !(cmd.tex === null || (isInt(cmd.tex) && cmd.tex >= 1))
          ) {
            return err('a commands[] "add_multimesh" entry is malformed');
          }
        } else if (cmd.op === "add_particles" && isV12) {
          // PM5 (render-stream-12.md "The command"); below /12 an unknown op.
          if (
            !hasExactKeys(cmd, ADD_PARTICLES_KEYS) ||
            !isInt(cmd.particles) ||
            cmd.particles < 1 ||
            !(cmd.tex === null || (isInt(cmd.tex) && cmd.tex >= 1))
          ) {
            return err('a commands[] "add_particles" entry is malformed');
          }
        } else if (cmd.op === "unsupported") {
          if (
            !hasExactKeys(cmd, UNSUPPORTED_CMD_KEYS) ||
            typeof cmd.name !== "string" ||
            !isOneOf(
              cmd.reason,
              isV12
                ? UNSUPPORTED_CMD_REASONS_V12
                : isV11
                  ? UNSUPPORTED_CMD_REASONS_V11
                  : UNSUPPORTED_CMD_REASONS,
            )
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
    const texErr = checkTextureEntrySchema(t, offset, version);
    if (texErr.length > 0) return texErr;
  }

  if (isV4) {
    if (!Array.isArray(meta.meshes)) return err('"meshes" is not an array');
    for (const m of meta.meshes) {
      const meshErr = checkMeshEntrySchema(m, offset, version);
      if (meshErr.length > 0) return meshErr;
    }
  }

  if (isV5) {
    if (!Array.isArray(meta.shaders)) return err('"shaders" is not an array');
    for (const s of meta.shaders) {
      const shaderErr = checkShaderEntrySchema(s, offset, version);
      if (shaderErr.length > 0) return shaderErr;
    }
    if (!Array.isArray(meta.materials))
      return err('"materials" is not an array');
    for (const m of meta.materials) {
      const materialErr = checkMaterialEntrySchema(m, offset, version);
      if (materialErr.length > 0) return materialErr;
    }
  }

  const blocksError = checkBlocksField(meta.blocks, offset);
  if (blocksError !== null) return [blocksError];
  // render-stream-12.md: pt_f32 is the optional tenth block (its presence and count are
  // pt-offset's, checked by the validator).
  const withPtF32 =
    isV12 && (meta.blocks as BlockDescriptor[]).length === 10;
  const nameError = withPtF32
    ? checkFixedBlockNames(
        meta.blocks as BlockDescriptor[],
        TRANSACTION_BLOCK_NAMES_V12,
        offset,
        TRANSACTION_BLOCK_TYPES_V12,
      )
    : isV11
    ? checkFixedBlockNames(
        meta.blocks as BlockDescriptor[],
        TRANSACTION_BLOCK_NAMES_V11,
        offset,
        TRANSACTION_BLOCK_TYPES_V11,
      )
    : isV10
      ? checkFixedBlockNames(
          meta.blocks as BlockDescriptor[],
          TRANSACTION_BLOCK_NAMES_V10,
          offset,
          TRANSACTION_BLOCK_TYPES_V10,
        )
      : isV5
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

// --------------------------------------------------------------------------------------- item_meta (TAG1)
//
// client-extensions-design.md §2.4; rs-core's item_meta.rs is the same code, rule for rule, and
// protocol/golden-13/make_golden.py (`item_meta_check`) the reference.

const ITEM_META_KEYS = [
  "type",
  "form",
  "grant",
  "strings_from",
  "strings",
  "items",
  "blocks",
];
const ITEM_META_GRANT_KEYS = ["fields", "groups", "meta_keys"];
export const ITEM_META_FIELDS = ["class", "script", "scene", "path"] as const;
/** The canonical meta's first bytes (`type` is the first key): the validator judges the ask and
 * an orphan from them before the record's own schema. */
const ITEM_META_PREFIX = new TextEncoder().encode('{"type":"item_meta",');

/** The hello / grant list rules: null when `r` is valid, else what is wrong. */
export function itemMetaRequestProblem(r: ItemMetaRequest): string | null {
  let last = -1;
  for (const f of r.fields) {
    const i = (ITEM_META_FIELDS as readonly string[]).indexOf(f);
    if (i <= last)
      return '"fields" is not a subset of class, script, scene, path in that order without duplicates';
    last = i;
  }
  if (r.groups.length > 31) return '"groups" holds more than 31 names';
  if (r.meta_keys.length > 8) return '"meta_keys" holds more than 8 names';
  for (const list of [r.groups, r.meta_keys]) {
    const ok =
      list.every(
        (s) =>
          s.length >= 1 &&
          s.length <= 64 &&
          [...s].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7e),
      ) && new Set(list).size === list.length;
    if (!ok)
      return "a group or meta key is not 1-64 printable ASCII bytes, or repeats";
  }
  if (r.fields.length + r.groups.length + r.meta_keys.length === 0)
    return '"fields", "groups" and "meta_keys" are all empty';
  return null;
}

function itemMetaColumns(g: ItemMetaRequest): number {
  return g.fields.length + (g.groups.length > 0 ? 1 : 0) + g.meta_keys.length;
}

/** Row shape against a grant (`item-meta-schema` detail, or null). */
function itemMetaRowsProblem(
  items: ReadonlyArray<ReadonlyArray<number | null>>,
  g: ItemMetaRequest,
): string | null {
  const n = itemMetaColumns(g);
  const gc = g.groups.length > 0 ? g.fields.length : -1;
  for (const row of items) {
    if (row.length === 1) continue;
    if (row.length - 1 !== n)
      return `item ${row[0]}'s row has ${row.length - 1} columns, the grant ${n}`;
    if (gc >= 0) {
      const m = row[1 + gc];
      if (m === null || m >= 2 ** g.groups.length)
        return `item ${row[0]}'s groups column is not a bitmask below 2^${g.groups.length}`;
    }
  }
  return null;
}

/** Every string column below `size` (`item-meta-string` detail, or null). */
function itemMetaIndicesProblem(
  items: ReadonlyArray<ReadonlyArray<number | null>>,
  g: ItemMetaRequest,
  size: number,
): string | null {
  const gc = g.groups.length > 0 ? g.fields.length : -1;
  for (const row of items) {
    for (let k = 0; k < row.length - 1; k++) {
      if (k === gc) continue;
      const i = row[1 + k];
      if (i !== null && i >= size)
        return `item ${row[0]}'s column ${k} names string ${i}, the table holds ${size}`;
    }
  }
  return null;
}

/** Whether grant `g` is within request `r`: fields a subset, groups and meta_keys each empty or
 * equal to the request's. */
function itemMetaWithin(g: ItemMetaRequest, r: ItemMetaRequest): boolean {
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  return (
    g.fields.every((f) => r.fields.includes(f)) &&
    (g.groups.length === 0 || same(g.groups, r.groups)) &&
    (g.meta_keys.length === 0 || same(g.meta_keys, r.meta_keys))
  );
}

/** decodeRecord's item_meta checks (/13 only): the shape (`item-meta-schema`) and, for a full
 * (whose grant is in the record), its rows against the grant, strings_from 0 and every string
 * index in range (`item-meta-string`). A delta's rows are read against the stream's grant by the
 * validator. */
function checkItemMetaSchema(
  meta: Record<string, unknown>,
  offset: number,
): string[] {
  const err = (code: string, detail: string) => [
    `${code}: record at offset ${offset}: ${detail}`,
  ];
  const schema = (detail: string) => err("item-meta-schema", detail);
  if (!hasExactKeys(meta, ITEM_META_KEYS))
    return schema("item_meta has the wrong top-level keys or order");
  if (meta.form !== "full" && meta.form !== "delta")
    return schema('"form" is not "full" or "delta"');
  const full = meta.form === "full";
  let grant: ItemMetaRequest | null = null;
  if (full) {
    const g = meta.grant;
    if (!isPlainObject(g) || !hasExactKeys(g, ITEM_META_GRANT_KEYS))
      return schema(
        '"grant" is not an object with fields, groups, meta_keys in that order',
      );
    for (const k of ITEM_META_GRANT_KEYS) {
      if (!Array.isArray(g[k])) return schema(`grant.${k} is not an array`);
      if (!isStringArray(g[k])) return schema(`grant.${k} holds a non-string`);
    }
    grant = g as unknown as ItemMetaRequest;
    const problem = itemMetaRequestProblem(grant);
    if (problem !== null) return schema(`grant: ${problem}`);
  } else if (meta.grant !== null) {
    return schema('a delta\'s "grant" is not null');
  }
  if (!isInt(meta.strings_from) || meta.strings_from < 0)
    return schema('"strings_from" is not a non-negative integer');
  if (!Array.isArray(meta.strings)) return schema('"strings" is not an array');
  if (!isStringArray(meta.strings))
    return schema('"strings" holds a non-string');
  if (!Array.isArray(meta.items)) return schema('"items" is not an array');
  let prev = 0;
  for (const row of meta.items as unknown[]) {
    if (!Array.isArray(row) || row.length === 0)
      return schema("an items[] row is not a non-empty array");
    const id = row[0];
    if (!isInt(id) || id < 1 || id > 0xffffffff)
      return schema("an items[] row's id is not an integer in 1..2^32");
    if (id <= prev)
      return schema(`items[] ids are not strictly increasing at ${id}`);
    prev = id;
    for (let k = 1; k < row.length; k++) {
      const c = row[k];
      if (c !== null && !(isInt(c) && c >= 0))
        return schema(
          `item ${id}'s row holds a column that is neither null nor a non-negative integer`,
        );
    }
  }
  if (!Array.isArray(meta.blocks) || meta.blocks.length !== 0)
    return schema('"blocks" must be an empty array for an item_meta record');
  if (grant !== null) {
    const items = meta.items as Array<Array<number | null>>;
    const rows = itemMetaRowsProblem(items, grant);
    if (rows !== null) return schema(rows);
    if (meta.strings_from !== 0)
      return err(
        "item-meta-string",
        `a full's strings_from is ${meta.strings_from}, not 0`,
      );
    const indices = itemMetaIndicesProblem(
      items,
      grant,
      (meta.strings as string[]).length,
    );
    if (indices !== null) return err("item-meta-string", indices);
  }
  return [];
}

/** TAG1: a row in `rs-core-check --item-meta-dump`'s form against `table`'s grant and strings:
 * null for an item with no node, else {<field>: string|null.., "groups": mask, "meta":
 * {<key>: string|null}} (groups and meta only when granted). */
export function itemMetaRowJson(
  table: ItemMetaTable,
  row: ReadonlyArray<number | null> | null,
): Record<string, unknown> | null {
  const g = table.grant;
  if (row === null || g === null) return null;
  const s = (k: number) => {
    const i = row[k];
    return i === null || i === undefined ? null : (table.strings[i] ?? null);
  };
  const out: Record<string, unknown> = {};
  g.fields.forEach((f, k) => {
    out[f] = s(k);
  });
  let k = g.fields.length;
  if (g.groups.length > 0) out.groups = row[k++] ?? null;
  if (g.meta_keys.length > 0) {
    const m: Record<string, string | null> = {};
    g.meta_keys.forEach((key, j) => {
      m[key] = s(k + j);
    });
    out.meta = m;
  }
  return out;
}

function checkMetaSchema(
  meta: unknown,
  offset: number,
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13,
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
  if (meta.type === "item_meta" && version === 13)
    return checkItemMetaSchema(meta, offset);
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
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 = 6,
): {
  records: RawRecord[];
  errors: string[];
} {
  const expectedMagic =
    version === 13
      ? MAGIC_V13
      : version === 12
      ? MAGIC_V12
      : version === 11
      ? MAGIC_V11
      : version === 10
        ? MAGIC_V10
        : version === 9
          ? MAGIC_V9
          : version === 8
            ? MAGIC_V8
            : version === 7
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
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 = 6,
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
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13,
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
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 = 6,
): {
  schema:
    | "render-stream-2-decoded/1"
    | "render-stream-3-decoded/1"
    | "render-stream-4-decoded/1"
    | "render-stream-5-decoded/1"
    | "render-stream-6-decoded/1"
    | "render-stream-7-decoded/1"
    | "render-stream-8-decoded/1"
    | "render-stream-9-decoded/1"
    | "render-stream-10-decoded/1"
    | "render-stream-11-decoded/1"
    | "render-stream-12-decoded/1"
    | "render-stream-13-decoded/1";
  magic: string;
  records: DecodedRecord[];
} {
  const split = splitRecords(data, version);
  if (split.errors.length > 0) throw new Error(split.errors[0]);
  // render-stream-13.md "Forms and transcode": /13's decoded form is /12's over the reconstructed
  // blocks, each record's sha256 still the /13 record's own.
  const plain = version === 13 ? rs13PlainRecords(split.records) : split.records;
  const records: DecodedRecord[] = [];
  for (let r = 0; r < split.records.length; r++) {
    const raw = split.records[r];
    const decoded = decodeRecord(plain[r], version);
    if (decoded.errors.length > 0 || decoded.record === undefined) {
      throw new Error(
        decoded.errors[0] ??
          `decodeRecord produced no record at offset ${raw.offset}`,
      );
    }
    records.push(
      plain[r] === raw
        ? decoded.record
        : { ...decoded.record, sha256: hashBytes(raw.bytes) },
    );
  }
  const magic =
    version === 13
      ? MAGIC_V13
      : version === 12
      ? MAGIC_V12
      : version === 11
      ? MAGIC_V11
      : version === 10
        ? MAGIC_V10
        : version === 9
          ? MAGIC_V9
          : version === 8
            ? MAGIC_V8
            : version === 7
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
      version === 13
        ? "render-stream-13-decoded/1"
        : version === 12
        ? "render-stream-12-decoded/1"
        : version === 11
        ? "render-stream-11-decoded/1"
        : version === 10
          ? "render-stream-10-decoded/1"
          : version === 9
            ? "render-stream-9-decoded/1"
            : version === 8
              ? "render-stream-8-decoded/1"
              : version === 7
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

// --------------------------------------------------------------------------------------- render-stream/13 prediction
//
// W13a (render-stream-13.md "As built (W13a)": the wire). /13 is /12 plus the GRSD magic, the
// transaction key `predict_check` and three predicted blocks: mesh_u8, mesh_f32 and mm_f32 carry
// residuals against the stream's two previous transactions. The reference codec is
// protocol/golden-13/make_golden.py (`to13`, `to12`, `code_blocks`, `History`, `advance`); every
// function below mirrors the one of the same name there, byte for byte. Decoding un-predicts the
// three blocks before any /12 rule runs, so the decoded form, the resolved form and every /12
// validator rule see /12's blocks.

const XXH_M64 = (1n << 64n) - 1n;
const XXH_P1 = 0x9e3779b185ebca87n;
const XXH_P2 = 0xc2b2ae3d27d4eb4fn;
const XXH_P3 = 0x165667b19e3779f9n;
const XXH_P4 = 0x85ebca77c2b2ae63n;
const XXH_P5 = 0x27d4eb2f165667c5n;

function xxhRotl(x: bigint, r: bigint): bigint {
  return ((x << r) | (x >> (64n - r))) & XXH_M64;
}

function xxhRound(acc: bigint, lane: bigint): bigint {
  acc = (acc + lane * XXH_P2) & XXH_M64;
  return (xxhRotl(acc, 31n) * XXH_P1) & XXH_M64;
}

function xxhMerge(acc: bigint, val: bigint): bigint {
  acc ^= xxhRound(0n, val);
  return (acc * XXH_P1 + XXH_P4) & XXH_M64;
}

/** XXH64 (xxHash 64-bit) of `data` with `seed` (render-stream-13.md: seed 0). */
export function xxh64(data: Uint8Array, seed = 0n): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = data.length;
  let p = 0;
  let h: bigint;
  if (n >= 32) {
    let v1 = (seed + XXH_P1 + XXH_P2) & XXH_M64;
    let v2 = (seed + XXH_P2) & XXH_M64;
    let v3 = seed & XXH_M64;
    let v4 = (seed - XXH_P1) & XXH_M64;
    while (p + 32 <= n) {
      v1 = xxhRound(v1, view.getBigUint64(p, true));
      v2 = xxhRound(v2, view.getBigUint64(p + 8, true));
      v3 = xxhRound(v3, view.getBigUint64(p + 16, true));
      v4 = xxhRound(v4, view.getBigUint64(p + 24, true));
      p += 32;
    }
    h =
      (xxhRotl(v1, 1n) +
        xxhRotl(v2, 7n) +
        xxhRotl(v3, 12n) +
        xxhRotl(v4, 18n)) &
      XXH_M64;
    h = xxhMerge(h, v1);
    h = xxhMerge(h, v2);
    h = xxhMerge(h, v3);
    h = xxhMerge(h, v4);
  } else {
    h = (seed + XXH_P5) & XXH_M64;
  }
  h = (h + BigInt(n)) & XXH_M64;
  while (p + 8 <= n) {
    h ^= xxhRound(0n, view.getBigUint64(p, true));
    h = (xxhRotl(h, 27n) * XXH_P1 + XXH_P4) & XXH_M64;
    p += 8;
  }
  if (p + 4 <= n) {
    h ^= (BigInt(view.getUint32(p, true)) * XXH_P1) & XXH_M64;
    h = (xxhRotl(h, 23n) * XXH_P2 + XXH_P3) & XXH_M64;
    p += 4;
  }
  while (p < n) {
    h ^= (BigInt(data[p]) * XXH_P5) & XXH_M64;
    h = (xxhRotl(h, 11n) * XXH_P1) & XXH_M64;
    p += 1;
  }
  h ^= h >> 33n;
  h = (h * XXH_P2) & XXH_M64;
  h ^= h >> 29n;
  h = (h * XXH_P3) & XXH_M64;
  h ^= h >> 32n;
  return h;
}

/** xxh64(data) as 16 lowercase hex digits (big-endian, `format!("{:016x}")`). */
export function xxh64Hex(data: Uint8Array): string {
  return xxh64(data).toString(16).padStart(16, "0");
}

// --- word arithmetic (render-stream-13.md "Units and the predictor") ---------------------------

function rs13Ordered(u: number): number {
  return u < 0x80000000 ? (u ^ 0x80000000) >>> 0 : ~u >>> 0;
}

function rs13Unordered(o: number): number {
  return o >= 0x80000000 ? (o ^ 0x80000000) >>> 0 : ~o >>> 0;
}

/** zz(d) on d mod 2^32 read as a signed 32-bit integer (`d` any exact integer). */
function rs13Zz(d: number): number {
  const s = d | 0;
  return ((s << 1) ^ (s >> 31)) >>> 0;
}

function rs13Unzz(u: number): number {
  return ((u >>> 1) ^ -(u & 1)) >>> 0;
}

function rs13Word(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function rs13PutWord(b: Uint8Array, i: number, w: number): void {
  b[i] = w & 0xff;
  b[i + 1] = (w >>> 8) & 0xff;
  b[i + 2] = (w >>> 16) & 0xff;
  b[i + 3] = (w >>> 24) & 0xff;
}

/** Residual words of one float unit: raw (no base), first order, or second order. */
function rs13PredictWords(
  cur: Uint8Array,
  base: Uint8Array | null,
  prev: Uint8Array | null,
): Uint8Array {
  if (base === null) return cur;
  const out = new Uint8Array(cur.length);
  for (let i = 0; i + 4 <= cur.length; i += 4) {
    const x = rs13Ordered(rs13Word(cur, i));
    const y = rs13Ordered(rs13Word(base, i));
    const r =
      prev === null
        ? rs13Zz(x - y)
        : rs13Zz(x - 2 * y + rs13Ordered(rs13Word(prev, i)));
    rs13PutWord(out, i, r);
  }
  return out;
}

function rs13UnpredictWords(
  res: Uint8Array,
  base: Uint8Array | null,
  prev: Uint8Array | null,
): Uint8Array {
  if (base === null) return res;
  const out = new Uint8Array(res.length);
  for (let i = 0; i + 4 <= res.length; i += 4) {
    const r = rs13Unzz(rs13Word(res, i));
    const y = rs13Ordered(rs13Word(base, i));
    const o =
      prev === null ? r + y : r + 2 * y - rs13Ordered(rs13Word(prev, i));
    rs13PutWord(out, i, rs13Unordered(o >>> 0));
  }
  return out;
}

function rs13XorBytes(a: Uint8Array, b: Uint8Array | null): Uint8Array {
  if (b === null) return a;
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** Byte-plane transpose of a word stream: byte j of word k goes to j * n + k. */
function rs13Transpose4(b: Uint8Array): Uint8Array {
  const n = b.length >>> 2;
  const out = new Uint8Array(4 * n);
  for (let k = 0; k < n; k++)
    for (let j = 0; j < 4; j++) out[j * n + k] = b[4 * k + j];
  return out;
}

function rs13Untranspose4(b: Uint8Array): Uint8Array {
  const n = b.length >>> 2;
  const out = new Uint8Array(4 * n);
  for (let k = 0; k < n; k++)
    for (let j = 0; j < 4; j++) out[4 * k + j] = b[j * n + k];
  return out;
}

function rs13Concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// --- body partition (render-stream-4.md "Mesh payload") ----------------------------------------

/** The reference codec reads metas with Python semantics: an integer (a bool counts as 0/1),
 * else the lookup "fails" (KeyError/TypeError there, null here). */
function rs13Int(v: unknown): number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  return null;
}

/** Python truthiness of a JSON value. */
function rs13Truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return Boolean(v);
}

const RS13_SHAPE_KEYS = ["primitive", "format", "vertex_count", "index_count"];

/** [geometry, positions, colours, UVs, skin, indices] byte sizes of a surface body, plus the
 * vertex count and the per-vertex colour and UV sizes; null when a field is not an integer. */
function rs13BodyParts(
  s: unknown,
): { n: number; col: number; uv: number; sizes: number[] } | null {
  if (!isPlainObject(s)) return null;
  const n = rs13Int(s.vertex_count);
  const fmt = rs13Int(s.format);
  const ic = rs13Int(s.index_count);
  if (n === null || fmt === null || ic === null) return null;
  const bit = (b: number) => Math.floor(fmt / 2 ** b) % 2 === 1;
  const col = bit(3) ? 4 : 0;
  const uv = bit(4) ? 8 : 0;
  const skin = bit(10) && bit(11) ? n * (bit(27) ? 32 : 16) : 0;
  const idx = ic === 0 ? 0 : ic * (n <= 65536 ? 2 : 4);
  return { n, col, uv, sizes: [40, 8 * n, col * n, uv * n, skin, idx] };
}

function rs13SplitBody(
  body: Uint8Array,
  parts: { n: number; col: number; uv: number; sizes: number[] },
): Uint8Array[] {
  const { n, col, uv, sizes } = parts;
  let p = 0;
  const g = body.subarray(p, p + sizes[0]);
  p += sizes[0];
  const ps = body.subarray(p, p + sizes[1]);
  p += sizes[1];
  const stride = col + uv;
  const cs = new Uint8Array(col * n);
  const us = new Uint8Array(uv * n);
  for (let k = 0; k < n; k++) {
    cs.set(body.subarray(p + k * stride, p + k * stride + col), k * col);
    us.set(body.subarray(p + k * stride + col, p + (k + 1) * stride), k * uv);
  }
  p += stride * n;
  const sk = body.subarray(p, p + sizes[4]);
  p += sizes[4];
  const ix = body.subarray(p, p + sizes[5]);
  return [g, ps, cs, us, sk, ix];
}

function rs13JoinBody(
  parts: Uint8Array[],
  shape: { n: number; col: number; uv: number },
): Uint8Array {
  const { n, col, uv } = shape;
  const [g, ps, cs, us, sk, ix] = parts;
  const attr = new Uint8Array((col + uv) * n);
  for (let k = 0; k < n; k++) {
    attr.set(cs.subarray(k * col, (k + 1) * col), k * (col + uv));
    attr.set(us.subarray(k * uv, (k + 1) * uv), k * (col + uv) + col);
  }
  return rs13Concat([g, ps, attr, sk, ix]);
}

/** geometry, positions, UVs are word streams; colours, skin, indices bytes. */
const RS13_WORD_STREAMS = [true, true, false, true, false, false];

function rs13MmStride(e: Record<string, unknown>): number {
  return (
    8 + 4 * (rs13Truthy(e.colors) ? 1 : 0) + 4 * (rs13Truthy(e.custom) ? 1 : 0)
  );
}

// --- history (render-stream-13.md "History") -----------------------------------------------------

interface Rs13Bodies {
  /** The shape (per surface primitive, format, vertex_count, index_count) as a comparable key. */
  shape: string;
  bodies: Uint8Array[];
}

interface Rs13Buffer {
  instances: number;
  stride: number;
  bytes: Uint8Array;
}

/** R(T): the prediction state after a transaction. */
interface Rs13State {
  body: Map<unknown, Rs13Bodies>;
  aabb: Map<unknown, Uint8Array>;
  mm: Map<unknown, Rs13Buffer>;
}

function rs13EmptyState(): Rs13State {
  return { body: new Map(), aabb: new Map(), mm: new Map() };
}

function rs13CopyState(r: Rs13State): Rs13State {
  return { body: new Map(r.body), aabb: new Map(r.aabb), mm: new Map(r.mm) };
}

/** The meta's list under `key` (absent: empty); null when present but not an array. */
function rs13List(
  meta: Record<string, unknown>,
  key: string,
): unknown[] | null {
  if (!(key in meta)) return [];
  const v = meta[key];
  return Array.isArray(v) ? v : null;
}

function rs13IsDynamic(e: Record<string, unknown>): boolean {
  return (
    e.status === "ok" &&
    Array.isArray(e.surfaces) &&
    e.surfaces.length > 0 &&
    e.surfaces.every(
      (s) => isPlainObject(s) && (s.hash === null || s.hash === undefined),
    )
  );
}

interface Rs13U8Surface {
  surface: Record<string, unknown>;
  parts: { n: number; col: number; uv: number; sizes: number[] };
  offset: number;
  bytes: number;
}

interface Rs13U8Entry {
  id: unknown;
  shape: string;
  surfaces: Rs13U8Surface[];
}

/** The carried bodies of mesh_u8, or null when its /12 offset rule fails (pass-through). */
function rs13U8Layout(
  meta: Record<string, unknown>,
  u8Len: number,
): Rs13U8Entry[] | null {
  const meshes = rs13List(meta, "meshes");
  if (meshes === null) return null;
  const out: Rs13U8Entry[] = [];
  let run = 0;
  for (const e of meshes) {
    if (!isPlainObject(e)) return null;
    if (e.u8 === null || e.u8 === undefined) continue;
    if (rs13Int(e.u8) !== run) return null;
    if (!Array.isArray(e.surfaces)) return null;
    const surfaces: Rs13U8Surface[] = [];
    const shape: unknown[] = [];
    for (const s of e.surfaces) {
      if (!isPlainObject(s) || !("payload_bytes" in s)) return null;
      const n = rs13Int(s.payload_bytes);
      const parts = rs13BodyParts(s);
      if (n === null || parts === null) return null;
      let len = 0;
      for (const size of parts.sizes) len += size;
      if (len !== n) return null;
      surfaces.push({ surface: s, parts, offset: run, bytes: n });
      run += n;
    }
    for (const s of e.surfaces as Record<string, unknown>[]) {
      for (const k of RS13_SHAPE_KEYS) if (!(k in s)) return null;
      shape.push(RS13_SHAPE_KEYS.map((k) => s[k]));
    }
    if (!("id" in e)) return null;
    out.push({ id: e.id, shape: JSON.stringify(shape), surfaces });
  }
  return run === u8Len ? out : null;
}

/** [mesh id, float offset] of the AABB units, or null when mesh_f32's offset rule fails. */
function rs13F32Layout(
  meta: Record<string, unknown>,
  nFloats: number,
): Array<[unknown, number]> | null {
  const meshes = rs13List(meta, "meshes");
  if (meshes === null) return null;
  const out: Array<[unknown, number]> = [];
  let run = 0;
  for (const e of meshes) {
    if (!isPlainObject(e)) return null;
    if (e.f === null || e.f === undefined) continue;
    if (rs13Int(e.f) !== run) return null;
    if (!("id" in e)) return null;
    out.push([e.id, run]);
    run += 6;
  }
  return run === nFloats ? out : null;
}

/** [multimesh id, instances, stride, float offset] of the buffer units, or null when mm_f32's
 * offset rule fails. */
function rs13MmLayout(
  meta: Record<string, unknown>,
  nFloats: number,
): Array<[unknown, number, number, number]> | null {
  const multimeshes = rs13List(meta, "multimeshes");
  if (multimeshes === null) return null;
  const out: Array<[unknown, number, number, number]> = [];
  let run = 0;
  for (const e of multimeshes) {
    if (!isPlainObject(e)) return null;
    if (e.aabb_f !== null && e.aabb_f !== undefined) {
      if (rs13Int(e.aabb_f) !== run) return null;
      run += 6;
    }
    if (e.buffer_f !== null && e.buffer_f !== undefined) {
      if (rs13Int(e.buffer_f) !== run) return null;
      if (!("colors" in e) || !("custom" in e) || !("id" in e)) return null;
      const stride = rs13MmStride(e);
      const instances = rs13Int(e.instances);
      if (instances === null) return null;
      out.push([e.id, instances, stride, run]);
      run += instances * stride;
    }
  }
  return run === nFloats ? out : null;
}

const RS13_EMPTY = new Uint8Array(0);

/** R(T) from R(T-1) (empty for a full) and T's /12 blocks. */
function rs13Advance(
  prior: Rs13State,
  meta: Record<string, unknown>,
  full: boolean,
  blocks12: Map<string, Uint8Array>,
): Rs13State {
  const r = full ? rs13EmptyState() : rs13CopyState(prior);
  const u8 = blocks12.get("mesh_u8") ?? RS13_EMPTY;
  const layout = rs13U8Layout(meta, u8.length);
  const bodies = new Map<unknown, Rs13Bodies>();
  if (layout !== null) {
    for (const entry of layout)
      bodies.set(entry.id, {
        shape: entry.shape,
        bodies: entry.surfaces.map((s) =>
          u8.slice(s.offset, s.offset + s.bytes),
        ),
      });
  }
  const mf = blocks12.get("mesh_f32") ?? RS13_EMPTY;
  for (const e of rs13List(meta, "meshes") ?? []) {
    if (!isPlainObject(e)) continue;
    const mid = e.id;
    if (rs13IsDynamic(e)) {
      if (e.u8 !== null && e.u8 !== undefined) {
        const b = bodies.get(mid);
        if (b !== undefined) r.body.set(mid, b);
        else r.body.delete(mid);
      }
    } else {
      r.body.delete(mid);
    }
    const f = rs13Int(e.f);
    if (
      e.f !== null &&
      e.f !== undefined &&
      f !== null &&
      f >= 0 &&
      4 * f + 24 <= mf.length
    )
      r.aabb.set(mid, mf.slice(4 * f, 4 * f + 24));
    else r.aabb.delete(mid);
  }
  for (const mid of rs13List(meta, "removed_meshes") ?? []) {
    r.body.delete(mid);
    r.aabb.delete(mid);
  }
  const mm = blocks12.get("mm_f32") ?? RS13_EMPTY;
  for (const e of rs13List(meta, "multimeshes") ?? []) {
    if (!isPlainObject(e)) continue;
    const mmid = e.id;
    if (e.status !== "ok") {
      r.mm.delete(mmid);
    } else if (e.buffer_f !== null && e.buffer_f !== undefined) {
      const stride = rs13MmStride(e);
      const bufferF = rs13Int(e.buffer_f);
      const instances = rs13Int(e.instances);
      if (bufferF === null || instances === null) {
        r.mm.delete(mmid);
        continue;
      }
      const o = 4 * bufferF;
      const n = 4 * instances * stride;
      if (o >= 0 && n >= 0 && o + n <= mm.length)
        r.mm.set(mmid, { instances, stride, bytes: mm.slice(o, o + n) });
      else r.mm.delete(mmid);
    }
  }
  for (const mmid of rs13List(meta, "removed_multimeshes") ?? [])
    r.mm.delete(mmid);
  return r;
}

/** One end's prediction history: H1 = R(T-1), H2 = R(T-2), reset by a full. */
class Rs13History {
  h1: Rs13State = rs13EmptyState();
  h2: Rs13State = rs13EmptyState();

  /** (H1, H2) to predict T from. stale (encoder sabotage predict-stale): predict from H2 as if it
   * were H1, first order. noReset (decoder sabotage no-predict-reset): a full predicts like a
   * patch. */
  refs(
    meta: Record<string, unknown>,
    opts: { stale?: boolean; noReset?: boolean } = {},
  ): [Rs13State, Rs13State] {
    if (meta.encoding === "full" && !opts.noReset)
      return [rs13EmptyState(), rs13EmptyState()];
    if (opts.stale) return [this.h2, rs13EmptyState()];
    return [this.h1, this.h2];
  }

  accept(
    meta: Record<string, unknown>,
    blocks12: Map<string, Uint8Array>,
    opts: { noReset?: boolean } = {},
  ): void {
    const full = meta.encoding === "full" && !opts.noReset;
    const next = rs13Advance(
      full ? rs13EmptyState() : this.h1,
      meta,
      full,
      blocks12,
    );
    this.h2 = full ? rs13EmptyState() : this.h1;
    this.h1 = next;
  }
}

/** One predicted unit of a transaction (golden-13 index.json "predict_trace"). */
export interface Rs13TraceUnit {
  block: "mesh_u8" | "mesh_f32" | "mm_f32";
  id: unknown;
  /** 0 raw, 1 first order, 2 second order. */
  order: 0 | 1 | 2;
}

function rs13Order(base: unknown, prev: unknown): 0 | 1 | 2 {
  return base === null ? 0 : prev === null ? 1 : 2;
}

function rs13BodyRefs(
  h1: Rs13State,
  h2: Rs13State,
  mid: unknown,
  shape: string,
): [Uint8Array[] | null, Uint8Array[] | null] {
  const b = h1.body.get(mid);
  if (b === undefined || b.shape !== shape) return [null, null];
  const p = h2.body.get(mid);
  if (p === undefined || p.shape !== shape) return [b.bodies, null];
  return [b.bodies, p.bodies];
}

function rs13AabbRefs(
  h1: Rs13State,
  h2: Rs13State,
  mid: unknown,
): [Uint8Array | null, Uint8Array | null] {
  const b = h1.aabb.get(mid);
  if (b === undefined) return [null, null];
  return [b, h2.aabb.get(mid) ?? null];
}

function rs13MmRefs(
  h1: Rs13State,
  h2: Rs13State,
  mmid: unknown,
  instances: number,
  stride: number,
): [Uint8Array | null, Uint8Array | null] {
  const b = h1.mm.get(mmid);
  if (b === undefined || b.instances !== instances || b.stride !== stride)
    return [null, null];
  const p = h2.mm.get(mmid);
  if (p === undefined || p.instances !== instances || p.stride !== stride)
    return [b.bytes, null];
  return [b.bytes, p.bytes];
}

/** Predict (/12 -> /13) or un-predict (/13 -> /12) the three blocks of one transaction. */
function rs13CodeBlocks(
  meta: Record<string, unknown>,
  blocks: Map<string, Uint8Array>,
  h1: Rs13State,
  h2: Rs13State,
  inverse: boolean,
  trace?: Rs13TraceUnit[],
): Map<string, Uint8Array> {
  const out = new Map(blocks);
  // mesh_u8
  const u8 = blocks.get("mesh_u8");
  const layout = u8 !== undefined ? rs13U8Layout(meta, u8.length) : null;
  if (u8 !== undefined && layout !== null) {
    const surfaces: Array<{
      id: unknown;
      shape: string;
      k: number;
      s: Rs13U8Surface;
    }> = [];
    for (const entry of layout)
      for (let k = 0; k < entry.surfaces.length; k++)
        surfaces.push({
          id: entry.id,
          shape: entry.shape,
          k,
          s: entry.surfaces[k],
        });
    if (!inverse) {
      const streams: Uint8Array[][] = [[], [], [], [], [], []];
      for (const { id, shape, k, s } of surfaces) {
        const [base, prev] = rs13BodyRefs(h1, h2, id, shape);
        const cur = rs13SplitBody(
          u8.subarray(s.offset, s.offset + s.bytes),
          s.parts,
        );
        const bp = base !== null ? rs13SplitBody(base[k], s.parts) : null;
        const pp = prev !== null ? rs13SplitBody(prev[k], s.parts) : null;
        for (let i = 0; i < 6; i++) {
          const b = bp ? bp[i] : null;
          streams[i].push(
            RS13_WORD_STREAMS[i]
              ? rs13PredictWords(cur[i], b, pp ? pp[i] : null)
              : rs13XorBytes(cur[i], b),
          );
        }
        if (trace && k === 0)
          trace.push({ block: "mesh_u8", id, order: rs13Order(base, prev) });
      }
      out.set(
        "mesh_u8",
        rs13Concat(
          streams.map((st, i) =>
            RS13_WORD_STREAMS[i]
              ? rs13Transpose4(rs13Concat(st))
              : rs13Concat(st),
          ),
        ),
      );
    } else {
      const streams: Uint8Array[] = [];
      let p = 0;
      for (let i = 0; i < 6; i++) {
        let total = 0;
        for (const { s } of surfaces) total += s.parts.sizes[i];
        const chunk = u8.subarray(p, p + total);
        p += total;
        streams.push(RS13_WORD_STREAMS[i] ? rs13Untranspose4(chunk) : chunk);
      }
      const at = [0, 0, 0, 0, 0, 0];
      const bodies: Uint8Array[] = [];
      for (const { id, shape, k, s } of surfaces) {
        const [base, prev] = rs13BodyRefs(h1, h2, id, shape);
        const bp = base !== null ? rs13SplitBody(base[k], s.parts) : null;
        const pp = prev !== null ? rs13SplitBody(prev[k], s.parts) : null;
        const parts: Uint8Array[] = [];
        for (let i = 0; i < 6; i++) {
          const size = s.parts.sizes[i];
          const d = streams[i].subarray(at[i], at[i] + size);
          at[i] += size;
          const b = bp ? bp[i] : null;
          parts.push(
            RS13_WORD_STREAMS[i]
              ? rs13UnpredictWords(d, b, pp ? pp[i] : null)
              : rs13XorBytes(d, b),
          );
        }
        bodies.push(rs13JoinBody(parts, s.parts));
        if (trace && k === 0)
          trace.push({ block: "mesh_u8", id, order: rs13Order(base, prev) });
      }
      out.set("mesh_u8", rs13Concat(bodies));
    }
  }
  // mesh_f32
  const mf = blocks.get("mesh_f32");
  const fl = mf !== undefined ? rs13F32Layout(meta, mf.length >>> 2) : null;
  if (mf !== undefined && fl !== null) {
    const buf = inverse ? rs13Untranspose4(mf) : mf.slice();
    for (const [mid, off] of fl) {
      const [base, prev] = rs13AabbRefs(h1, h2, mid);
      const seg = buf.slice(4 * off, 4 * off + 24);
      buf.set(
        inverse
          ? rs13UnpredictWords(seg, base, prev)
          : rs13PredictWords(seg, base, prev),
        4 * off,
      );
      if (trace)
        trace.push({
          block: "mesh_f32",
          id: mid,
          order: rs13Order(base, prev),
        });
    }
    out.set("mesh_f32", inverse ? buf : rs13Transpose4(buf));
  }
  // mm_f32
  const mm = blocks.get("mm_f32");
  const ml = mm !== undefined ? rs13MmLayout(meta, mm.length >>> 2) : null;
  if (mm !== undefined && ml !== null) {
    const buf = inverse ? rs13Untranspose4(mm) : mm.slice();
    for (const [mmid, instances, stride, off] of ml) {
      const [base, prev] = rs13MmRefs(h1, h2, mmid, instances, stride);
      const n = 4 * instances * stride;
      const seg = buf.slice(4 * off, 4 * off + n);
      buf.set(
        inverse
          ? rs13UnpredictWords(seg, base, prev)
          : rs13PredictWords(seg, base, prev),
        4 * off,
      );
      if (trace)
        trace.push({ block: "mm_f32", id: mmid, order: rs13Order(base, prev) });
    }
    out.set("mm_f32", inverse ? buf : rs13Transpose4(buf));
  }
  return out;
}

/** predict_check: XXH64 of /12's mesh_f32 || mesh_u8 || mm_f32, 16 lowercase hex digits. */
function rs13CheckHex(blocks12: Map<string, Uint8Array>): string {
  return xxh64Hex(
    rs13Concat([
      blocks12.get("mesh_f32") ?? RS13_EMPTY,
      blocks12.get("mesh_u8") ?? RS13_EMPTY,
      blocks12.get("mm_f32") ?? RS13_EMPTY,
    ]),
  );
}

// --- records ---------------------------------------------------------------------------------------

interface Rs13ParsedRecord {
  metaBytes: Uint8Array;
  /** Each block's payload, in record order, and its byte position in the record. */
  blocks: Array<{ bytes: Uint8Array; pos: number }>;
}

/** (meta bytes, blocks) of one framed record (render-stream-0.md); throws on a framing error. */
function rs13ParseRecord(rec: Uint8Array): Rs13ParsedRecord {
  const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const metaLen = view.getUint32(4, true);
  const metaBytes = rec.subarray(8, 8 + metaLen);
  let p = 8 + metaLen;
  const count = view.getUint32(p, true);
  p += 4;
  const blocks: Array<{ bytes: Uint8Array; pos: number }> = [];
  for (let i = 0; i < count; i++) {
    const n = view.getUint32(p, true);
    p += 4;
    blocks.push({ bytes: rec.subarray(p, p + n), pos: p });
    p += n;
  }
  if (p !== rec.length) throw new Error("record-length: record framing");
  return { metaBytes, blocks };
}

function rs13MakeRecord(
  metaBytes: Uint8Array,
  blocks: readonly Uint8Array[],
): Uint8Array {
  let n = 4 + metaBytes.length + 4;
  for (const b of blocks) n += 4 + b.length;
  const out = new Uint8Array(4 + n);
  const view = new DataView(out.buffer);
  view.setUint32(0, n, true);
  view.setUint32(4, metaBytes.length, true);
  out.set(metaBytes, 8);
  let p = 8 + metaBytes.length;
  view.setUint32(p, blocks.length, true);
  p += 4;
  for (const b of blocks) {
    view.setUint32(p, b.length, true);
    out.set(b, p + 4);
    p += 4 + b.length;
  }
  return out;
}

function rs13Binary(bytes: Uint8Array): string {
  return latin1.decode(bytes);
}

function rs13Unbinary(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

const RS13_BLOCKS_MARK = ',"blocks":[';
const RS13_CHECK_KEY = ',"predict_check":"';

function rs13WithCheck(metaBytes: Uint8Array, hex16: string): Uint8Array {
  const m = rs13Binary(metaBytes);
  const i = m.lastIndexOf(RS13_BLOCKS_MARK);
  if (i < 0)
    throw new Error('meta-schema: a transaction meta without "blocks"');
  return rs13Unbinary(
    `${m.slice(0, i)}${RS13_CHECK_KEY}${hex16}"${m.slice(i)}`,
  );
}

function rs13WithoutCheck(metaBytes: Uint8Array): [Uint8Array, string | null] {
  const m = rs13Binary(metaBytes);
  const i = m.lastIndexOf(RS13_BLOCKS_MARK);
  const j = i - RS13_CHECK_KEY.length - 17;
  if (
    i < 0 ||
    j < 0 ||
    m.slice(j, j + RS13_CHECK_KEY.length) !== RS13_CHECK_KEY ||
    m[i - 1] !== '"'
  )
    return [metaBytes, null];
  return [
    rs13Unbinary(m.slice(0, j) + m.slice(i)),
    m.slice(j + RS13_CHECK_KEY.length, i - 1),
  ];
}

function rs13SwapProtocol(
  metaBytes: Uint8Array,
  from: string,
  to: string,
): Uint8Array {
  const m = rs13Binary(metaBytes);
  const a = `"protocol":"${from}"`;
  const at = m.indexOf(a);
  if (at < 0)
    throw new Error(`meta-schema: the session's protocol is not "${from}"`);
  return rs13Unbinary(
    `${m.slice(0, at)}"protocol":"${to}"${m.slice(at + a.length)}`,
  );
}

/** The end record over transcoded records: stats.bytes_total moves by the size change, and
 * stats.max_record_bytes becomes the output's own maximum when the input's was its own. */
function rs13FixEnd(
  metaBytes: Uint8Array,
  out: readonly Uint8Array[],
  seen: readonly Uint8Array[],
): Uint8Array {
  const meta = JSON.parse(rs13Binary(metaBytes)) as Record<string, unknown>;
  const stats = meta.stats;
  if (
    isPlainObject(stats) &&
    rs13Int(stats.bytes_total) !== null &&
    typeof stats.bytes_total === "number"
  ) {
    let sumOut = 0;
    let sumIn = 0;
    let maxOut = 0;
    let maxIn = 0;
    for (const r of out) {
      sumOut += r.length;
      maxOut = Math.max(maxOut, r.length);
    }
    for (const r of seen) {
      sumIn += r.length;
      maxIn = Math.max(maxIn, r.length);
    }
    stats.bytes_total = stats.bytes_total + sumOut - sumIn;
    const mx = stats.max_record_bytes;
    if (
      typeof mx === "number" &&
      Number.isInteger(mx) &&
      out.length > 0 &&
      seen.length > 0 &&
      mx === maxIn
    )
      stats.max_record_bytes = maxOut;
  }
  return rs13Unbinary(JSON.stringify(meta));
}

function rs13NamedBlocks(
  meta: Record<string, unknown>,
  blocks: ReadonlyArray<{ bytes: Uint8Array }>,
): Map<string, Uint8Array> {
  const named = new Map<string, Uint8Array>();
  const descriptors = Array.isArray(meta.blocks) ? meta.blocks : [];
  for (let i = 0; i < Math.min(descriptors.length, blocks.length); i++) {
    const d = descriptors[i];
    if (isPlainObject(d) && typeof d.name === "string")
      named.set(d.name, blocks[i].bytes);
  }
  return named;
}

function rs13RebuildBlocks(
  meta: Record<string, unknown>,
  blocks: ReadonlyArray<{ bytes: Uint8Array }>,
  named: Map<string, Uint8Array>,
): Uint8Array[] {
  const descriptors = Array.isArray(meta.blocks) ? meta.blocks : [];
  return blocks.map((b, i) => {
    const d = descriptors[i];
    return isPlainObject(d) && typeof d.name === "string"
      ? (named.get(d.name) ?? b.bytes)
      : b.bytes;
  });
}

function rs13FileRecords(data: Uint8Array, magic: Uint8Array): Uint8Array[] {
  if (
    data.length < magic.length ||
    !bytesEqual(data.subarray(0, magic.length), magic)
  )
    throw new Error(
      `bad-magic: expected ${toHex(magic)}, got ${toHex(data.subarray(0, Math.min(magic.length, data.length)))}`,
    );
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Uint8Array[] = [];
  let p = magic.length;
  while (p < data.length) {
    if (p + 4 > data.length) throw new Error(`truncated: at ${p}`);
    const n = view.getUint32(p, true);
    if (p + 4 + n > data.length) throw new Error(`truncated: at ${p}`);
    out.push(data.subarray(p, p + 4 + n));
    p += 4 + n;
  }
  return out;
}

export interface EncodeRs13Options {
  /** render-stream-13.md "Sabotages" predict-stale: every patch predicts from H2 as if it were
   * H1, first order. */
  stale?: boolean;
  /** When given, receives each transaction's predicted units in order (golden-13 index.json
   * "predict_trace"). */
  trace?: Array<{ seq: unknown; units: Rs13TraceUnit[] }>;
}

/** render-stream-13.md "Forms and transcode": a /12 file transcoded to /13 (the encoder; golden-13
 * make_golden.py `to13`). Throws on a malformed input (bad magic, framing, meta JSON). */
export function encodeRs13(
  data12: Uint8Array,
  opts: EncodeRs13Options = {},
): Uint8Array {
  const hist = new Rs13History();
  const out: Uint8Array[] = [];
  const seen: Uint8Array[] = [];
  for (const rec of rs13FileRecords(data12, MAGIC_V12)) {
    const { metaBytes, blocks } = rs13ParseRecord(rec);
    const meta = JSON.parse(rs13Binary(metaBytes)) as Record<string, unknown>;
    if (meta.type === "session") {
      out.push(
        rs13MakeRecord(
          rs13SwapProtocol(metaBytes, "render-stream/12", "render-stream/13"),
          blocks.map((b) => b.bytes),
        ),
      );
    } else if (meta.type === "transaction") {
      const named = rs13NamedBlocks(meta, blocks);
      const [h1, h2] = hist.refs(meta, { stale: opts.stale });
      const units: Rs13TraceUnit[] | undefined = opts.trace ? [] : undefined;
      const coded = rs13CodeBlocks(meta, named, h1, h2, false, units);
      if (opts.trace && units) opts.trace.push({ seq: meta.seq, units });
      out.push(
        rs13MakeRecord(
          rs13WithCheck(metaBytes, rs13CheckHex(named)),
          rs13RebuildBlocks(meta, blocks, coded),
        ),
      );
      hist.accept(meta, named);
    } else if (meta.type === "end") {
      out.push(
        rs13MakeRecord(
          rs13FixEnd(metaBytes, out, seen),
          blocks.map((b) => b.bytes),
        ),
      );
    } else {
      out.push(rec);
    }
    seen.push(rec);
  }
  return rs13Concat([MAGIC_V13, ...out]);
}

export interface DecodeRs13Options {
  /** render-stream-13.md "Sabotages" no-predict-reset: a full does not reset the history. */
  noPredictReset?: boolean;
}

/** render-stream-13.md "Forms and transcode": a /13 file transcoded to /12 (golden-13
 * make_golden.py `to12`). Throws `meta-schema: ...` on a missing or malformed predict_check and
 * `predict-check: ... seq N ...` on a reconstruction mismatch; checks no /12 rule. */
export function decodeRs13(
  data13: Uint8Array,
  opts: DecodeRs13Options = {},
): Uint8Array {
  const hist = new Rs13History();
  const noReset = opts.noPredictReset === true;
  const out: Uint8Array[] = [];
  const seen: Uint8Array[] = [];
  for (const rec of rs13FileRecords(data13, MAGIC_V13)) {
    const { metaBytes, blocks } = rs13ParseRecord(rec);
    const meta = JSON.parse(rs13Binary(metaBytes)) as Record<string, unknown>;
    if (meta.type === "session") {
      out.push(
        rs13MakeRecord(
          rs13SwapProtocol(metaBytes, "render-stream/13", "render-stream/12"),
          blocks.map((b) => b.bytes),
        ),
      );
    } else if (meta.type === "transaction") {
      const [plain, check] = rs13WithoutCheck(metaBytes);
      if (check === null || !/^[0-9a-f]*$/.test(check))
        throw new Error(`meta-schema: seq ${String(meta.seq)}: predict_check`);
      const named = rs13NamedBlocks(meta, blocks);
      const [h1, h2] = hist.refs(meta, { noReset });
      const decoded = rs13CodeBlocks(meta, named, h1, h2, true);
      if (rs13CheckHex(decoded) !== check)
        throw new Error(`predict-check: seq ${String(meta.seq)}`);
      out.push(rs13MakeRecord(plain, rs13RebuildBlocks(meta, blocks, decoded)));
      hist.accept(meta, decoded, { noReset });
    } else if (meta.type === "item_meta") {
      // TAG1: /12 has no item_meta record; dropped (the end record's stats follow).
    } else if (meta.type === "end") {
      out.push(
        rs13MakeRecord(
          rs13FixEnd(metaBytes, out, seen),
          blocks.map((b) => b.bytes),
        ),
      );
    } else {
      out.push(rec);
    }
    seen.push(rec);
  }
  return rs13Concat([MAGIC_V12, ...out]);
}

/** A /13 decoder's un-prediction state over one stream (a file, or one live connection): feed
 * every transaction record in stream order, after decodeRecord() accepted its framing and meta. */
export interface Rs13Unpredictor {
  /** The record with its three predicted blocks replaced by /12's (same offset and length; the
   * meta, predict_check included, unchanged), or the `predict-check` error. Advances the history
   * when the check holds. */
  transaction(
    raw: RawRecord,
    meta: TransactionMeta,
  ): { raw: RawRecord } | { error: string };
}

export function createRs13Unpredictor(
  opts: DecodeRs13Options = {},
): Rs13Unpredictor {
  const hist = new Rs13History();
  const noReset = opts.noPredictReset === true;
  return {
    transaction(raw, meta) {
      const m = meta as unknown as Record<string, unknown>;
      const { blocks } = rs13ParseRecord(raw.bytes);
      const named = rs13NamedBlocks(m, blocks);
      const [h1, h2] = hist.refs(m, { noReset });
      const decoded = rs13CodeBlocks(m, named, h1, h2, true);
      const check = rs13CheckHex(decoded);
      if (check !== meta.predict_check)
        return {
          error: `predict-check: record at offset ${raw.offset}: seq ${meta.seq}: the reconstructed blocks hash to ${check}, predict_check is ${String(meta.predict_check)}`,
        };
      hist.accept(m, decoded, { noReset });
      const bytes = raw.bytes.slice();
      const descriptors = meta.blocks;
      for (let i = 0; i < blocks.length; i++) {
        const plain = decoded.get(descriptors[i]?.name);
        if (plain !== undefined && plain !== blocks[i].bytes)
          bytes.set(plain, blocks[i].pos);
      }
      return {
        raw: { offset: raw.offset, byte_length: raw.byte_length, bytes },
      };
    },
  };
}

/** Every record of a /13 recording with its transactions' blocks un-predicted (the /12 blocks in
 * the /13 framing); throws the first decode, meta or predict-check error. */
function rs13PlainRecords(records: RawRecord[]): RawRecord[] {
  const unpredictor = createRs13Unpredictor();
  return records.map((raw) => {
    const decoded = decodeRecord(raw, 13, { recordDigest: "deferred" });
    if (decoded.errors.length > 0 || decoded.record === undefined)
      throw new Error(
        decoded.errors[0] ??
          `decodeRecord produced no record at offset ${raw.offset}`,
      );
    if (decoded.record.meta.type !== "transaction") return raw;
    const result = unpredictor.transaction(raw, decoded.record.meta);
    if ("error" in result) throw new Error(result.error);
    return result.raw;
  });
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
export function decodeTexturePayload(
  bytes: Uint8Array,
  version: number = 6,
): DecodedTexturePayload {
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
    version,
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
  version: number = 6,
): number {
  const pixelSize = pixelSizeOf(format, version);
  if (pixelSize === undefined) {
    if (version >= 9 && format in BLOCK_FORMATS) {
      return blockDataBytes(format, width, height, mipmaps);
    }
    throw new Error(`expectedDataBytes: "${format}" is not a permitted format`);
  }
  return pixelSize * mipChainTexelCount(width, height, mipmaps);
}

// The pixel size of a payload format, or undefined when none is computed: the six permitted
// uncompressed formats at every version, the eight float formats at /8 and later only
// (render-stream-8.md "Texture payload"; below /8 they stay unsized, exactly as before).
function pixelSizeOf(format: string, version: number): number | undefined {
  return (
    PIXEL_SIZES[format] ??
    (version >= 8 ? FLOAT_PIXEL_SIZES[format] : undefined)
  );
}

function expectedDataBytesOrNull(
  format: string,
  width: number,
  height: number,
  mipmaps: boolean,
  version: number = 6,
): number | null {
  const pixelSize = pixelSizeOf(format, version);
  if (pixelSize === undefined) {
    if (version >= 9 && format in BLOCK_FORMATS) {
      return blockDataBytes(format, width, height, mipmaps);
    }
    return null;
  }
  return pixelSize * mipChainTexelCount(width, height, mipmaps);
}

// render-stream-9.md "Texture payload": the block formats legal as a `block` variant, with
// Godot's block edge and pixel right-shift (core/io/image.cpp get_format_block_size / _rshift, the
// pixel size of every block format being 1), so one level is
// ceil(w/block) * block * ceil(h/block) * block >> shift bytes. The swizzled *_RA_AS_RG formats and
// the HDR formats are not offered.
export const BLOCK_FORMATS: Readonly<
  Record<string, { block: number; shift: number }>
> = {
  DXT1: { block: 4, shift: 1 },
  DXT3: { block: 4, shift: 0 },
  DXT5: { block: 4, shift: 0 },
  RGTC_R: { block: 4, shift: 1 },
  RGTC_RG: { block: 4, shift: 0 },
  BPTC_RGBA: { block: 4, shift: 0 },
  ETC: { block: 4, shift: 1 },
  ETC2_R11: { block: 4, shift: 1 },
  ETC2_R11S: { block: 4, shift: 1 },
  ETC2_RG11: { block: 4, shift: 0 },
  ETC2_RG11S: { block: 4, shift: 0 },
  ETC2_RGB8: { block: 4, shift: 1 },
  ETC2_RGBA8: { block: 4, shift: 0 },
  ETC2_RGB8A1: { block: 4, shift: 1 },
  ASTC_4x4: { block: 4, shift: 0 },
  ASTC_8x8: { block: 8, shift: 2 },
};

function blockDataBytes(
  format: string,
  width: number,
  height: number,
  mipmaps: boolean,
): number {
  const { block, shift } = BLOCK_FORMATS[format];
  let w = width;
  let h = height;
  let total = 0;
  for (;;) {
    const bw = w % block !== 0 ? w + (block - (w % block)) : w;
    const bh = h % block !== 0 ? h + (block - (h % block)) : h;
    total += Math.floor((bw * bh) / 2 ** shift);
    if (!mipmaps || (w === 1 && h === 1)) break;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  return total;
}

// ----------------------------------------------------------------- KTX2 payloads (render-stream-9.md)

export interface DecodedKtx2Payload {
  width: number;
  height: number;
  levels: number;
  /** The DFD colour model: UASTC (166) or ETC1S (163). */
  model: "uastc" | "etc1s";
  /** 1 = BasisLZ, 2 = Zstandard. */
  supercompression: 1 | 2;
}

export function isKtx2Payload(bytes: Uint8Array): boolean {
  return (
    bytes.length >= KTX2_IDENTIFIER.length &&
    bytesEqual(bytes.subarray(0, KTX2_IDENTIFIER.length), KTX2_IDENTIFIER)
  );
}

// render-stream-9.md "KTX2 payload" (D13): the header, level index and DFD of one 2D image, one
// face, no layers, vkFormat UNDEFINED, ETC1S + BasisLZ or UASTC LDR 4x4 + Zstandard, linear
// transfer. Throws "ktx2-header: <detail>" on anything else. The entry-dependent half (pixel size,
// levels, which of the two encodings) is checkKtx2Shape().
export function decodeKtx2Payload(bytes: Uint8Array): DecodedKtx2Payload {
  const fail = (detail: string): never => {
    throw new Error(`ktx2-header: ${detail}`);
  };
  if (!isKtx2Payload(bytes))
    fail("the first 12 bytes are not the KTX2 identifier");
  if (bytes.length < 80) fail("the file ends inside the header or index");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number) => view.getUint32(o, true);
  const u64 = (o: number) => Number(view.getBigUint64(o, true));
  const vkFormat = u32(12);
  const typeSize = u32(16);
  const width = u32(20);
  const height = u32(24);
  const depth = u32(28);
  const layers = u32(32);
  const faces = u32(36);
  const levels = u32(40);
  const supercompression = u32(44);
  if (vkFormat !== 0) fail(`vkFormat is ${vkFormat}, not 0 (UNDEFINED)`);
  if (typeSize !== 1) fail(`typeSize is ${typeSize}, not 1`);
  if (width < 1 || height < 1) fail("pixelWidth or pixelHeight is 0");
  if (depth !== 0) fail(`pixelDepth is ${depth}, not 0 (a 2D image)`);
  if (layers !== 0) fail(`layerCount is ${layers}, not 0 (not an array)`);
  if (faces !== 1) fail(`faceCount is ${faces}, not 1 (not a cube)`);
  if (levels < 1 || levels > 32) fail(`levelCount is ${levels}, not 1..32`);
  if (supercompression !== 1 && supercompression !== 2) {
    fail(
      `supercompressionScheme is ${supercompression}, not 1 (BasisLZ) or 2 (Zstandard)`,
    );
  }
  const levelIndexEnd = 80 + 24 * levels;
  if (levelIndexEnd > bytes.length)
    fail("the level index runs past the end of the file");
  const dfdOffset = u32(48);
  const dfdLength = u32(52);
  const kvdOffset = u32(56);
  const kvdLength = u32(60);
  const sgdOffset = u64(64);
  const sgdLength = u64(72);
  if (dfdOffset < levelIndexEnd || dfdOffset + dfdLength > bytes.length) {
    fail("the data format descriptor lies outside the file");
  }
  if (kvdLength !== 0 && kvdOffset + kvdLength > bytes.length) {
    fail("the key/value data lies outside the file");
  }
  if (supercompression === 1) {
    if (sgdLength < 1 || sgdOffset + sgdLength > bytes.length) {
      fail("BasisLZ needs global data inside the file");
    }
  } else if (sgdLength !== 0) {
    fail("Zstandard supercompression has no global data");
  }
  // DFD: u32 totalSize, then one basic descriptor block (KDF 1.3) of at least 24 bytes.
  if (dfdLength < 28 || u32(dfdOffset) !== dfdLength) {
    fail("the DFD total size disagrees with dfdByteLength");
  }
  const word0 = u32(dfdOffset + 4); // vendorId (low 17 bits) | descriptorType (high 15)
  const word1 = u32(dfdOffset + 8); // versionNumber (low 16) | descriptorBlockSize (high 16)
  if (word0 !== 0) fail("the DFD descriptor is not a Khronos basic block");
  if ((word1 & 0xffff) !== 2) fail("the DFD version number is not 2 (KDF 1.3)");
  if (word1 >>> 16 !== dfdLength - 4) {
    fail("the DFD descriptor block size disagrees with its length");
  }
  const model = bytes[dfdOffset + 12];
  const transfer = bytes[dfdOffset + 14];
  if (model !== 163 && model !== 166) {
    fail(`the DFD colour model is ${model}, not ETC1S (163) or UASTC (166)`);
  }
  if (transfer !== 1) {
    fail(`the DFD transfer function is ${transfer}, not 1 (linear)`);
  }
  const dims = bytes.subarray(dfdOffset + 16, dfdOffset + 20);
  if (dims[0] !== 3 || dims[1] !== 3 || dims[2] !== 0 || dims[3] !== 0) {
    fail("the DFD texel block is not 4x4x1");
  }
  if ((model === 163) !== (supercompression === 1)) {
    fail(
      "the colour model and the supercompression scheme disagree (ETC1S is BasisLZ, UASTC is Zstandard)",
    );
  }
  for (let l = 0; l < levels; l++) {
    const offset = u64(80 + 24 * l);
    const length = u64(80 + 24 * l + 8);
    const uncompressed = u64(80 + 24 * l + 16);
    if (length < 1 || offset + length > bytes.length) {
      fail(`level ${l} lies outside the file`);
    }
    if (supercompression === 2) {
      const w = Math.max(1, width >> l);
      const h = Math.max(1, height >> l);
      const expected = Math.ceil(w / 4) * Math.ceil(h / 4) * 16;
      if (uncompressed !== expected) {
        fail(
          `level ${l} uncompressedByteLength is ${uncompressed}, expected ${expected}`,
        );
      }
    }
  }
  return {
    width,
    height,
    levels,
    model: model === 166 ? "uastc" : "etc1s",
    supercompression: supercompression as 1 | 2,
  };
}

// The entry-dependent half of the KTX2 rules (render-stream-9.md "KTX2 payload"): pixel size and
// level count equal the entry's, and the file's codec is the variant's encoding. Returns
// "ktx2-shape: <detail>" or null.
export function checkKtx2Shape(
  decoded: DecodedKtx2Payload,
  encoding: string,
  width: number,
  height: number,
  mipmaps: boolean,
): string | null {
  if (decoded.model !== encoding) {
    return `ktx2-shape: the file is ${decoded.model}, the variant's encoding is ${encoding}`;
  }
  if (decoded.width !== width || decoded.height !== height) {
    return `ktx2-shape: the file is ${decoded.width}x${decoded.height}, the entry is ${width}x${height}`;
  }
  const levels = mipmaps ? mipChainDimsCount(width, height) : 1;
  if (decoded.levels !== levels) {
    return `ktx2-shape: the file has ${decoded.levels} levels, the entry's mip chain has ${levels}`;
  }
  return null;
}

function mipChainDimsCount(width: number, height: number): number {
  let n = 1;
  let w = width;
  let h = height;
  while (w > 1 || h > 1) {
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
    n++;
  }
  return n;
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
    | "add_multimesh"
    | "add_particles"
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
  // --- new at /11 (PM1, render-stream-11.md "As built (PM1)", 10): add_multimesh's id ----------
  multimesh?: number;
  // --- new at /12 (PM5, render-stream-12.md "Resolved form"): add_particles' id ----------------
  particles?: number;
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
  /** new at /10 (render-stream-10.md "Decoded and resolved forms"): present only when resolved
   * at version 10, floats inline in the setter's argument order. */
  canvas_group?: ResolvedCanvasGroup | null;
  copy_to_backbuffer?: { rect: [number, number, number, number] } | null;
  /** UIT (render-stream-11.md "As built (UIT)"): present (true) only when the item set it. */
  use_identity_transform?: true;
  content_version: number;
  xform: [number, number, number, number, number, number];
  modulate: [number, number, number, number];
  self_modulate: [number, number, number, number];
  custom_rect_rect: [number, number, number, number];
  commands: ResolvedCommand[];
}

/** render-stream-10.md "Decoded and resolved forms": a resolved canvas_group. */
export interface ResolvedCanvasGroup {
  mode: CanvasGroupMode;
  clear_margin: number;
  fit_empty: boolean;
  fit_margin: number;
  blur_mipmaps: boolean;
}

export type ResolvedTexture = TransactionTexture;

/** render-stream-4.md "Decoded and resolved forms": a mesh table entry with "f" replaced by its
 * lifted custom AABB. */
export interface ResolvedMesh {
  id: number;
  origin: TableOrigin;
  /** new at /8 (render-stream-8.md "Decoded and resolved forms"): right after origin. */
  adopted_content?: AdoptedContent | null;
  status: MeshStatus;
  reason: MeshReason | null;
  version: number;
  custom_aabb: [number, number, number, number, number, number];
  surfaces: ResolvedMeshSurface[];
}

/** render-stream-11.md "Resolution and resolved form": at /11 a resolved surface carries
 * `body_sha256` right after `hash` (the SHA-256 of a dynamic surface's current body, null on a
 * static one). Below /11 the key is absent and the surface is the wire's. */
export interface ResolvedMeshSurface extends TransactionMeshSurface {
  body_sha256?: string | null;
}

/** new at /5: a shader-table entry, unchanged in shape from the wire's (no floats to lift). */
export type ResolvedShader = TransactionShader;

/** new at /5: a material-table entry with its params resolved to {"name","type","value"}. */
export interface ResolvedMaterial {
  id: number;
  origin: TableOrigin;
  status: MaterialStatus;
  reason: MaterialReason | null;
  version: number;
  shader: number | null;
  params: ResolvedParam[];
}

/** new at /11 (PM1, render-stream-11.md "As built (PM1)", 10): a resolved multimesh entry.
 * `custom_aabb` is the six floats (null when freed); `buffer_sha256` is the SHA-256 of the
 * current buffer's little-endian f32 bytes (null unless ok; an ok entry with 0 instances hashes
 * the empty string). The floats themselves are not kept: `transactionMultimeshes()` reads them
 * out of a decoded transaction. */
export interface ResolvedMultimesh {
  id: number;
  origin: TableOrigin;
  status: MultimeshStatus;
  reason: MultimeshReason | null;
  version: number;
  mesh: number | null;
  format: MultimeshFormat;
  colors: boolean;
  custom: boolean;
  instances: number;
  visible: number;
  custom_aabb: [number, number, number, number, number, number] | null;
  buffer_sha256: string | null;
}

/** new at /12 (PM5, render-stream-12.md "Resolved form"): a resolved particles entry's floats,
 * by name (PARTICLES_FLOAT_LAYOUT; the trail bind poses as a list of 12-float lists). */
export interface ResolvedParticlesFloats {
  amount_ratio: number;
  lifetime: number;
  pre_process_time: number;
  explosiveness: number;
  randomness: number;
  speed_scale: number;
  collision_base_size: number;
  trail_length: number;
  interp_to_end: number;
  request_process_time: number;
  custom_aabb: number[];
  emission_transform: number[];
  emitter_velocity: number[];
  trail_poses: number[][];
}

/** new at /12 (PM5, render-stream-12.md "Resolved form"): the entry's JSON fields (without `f`)
 * plus its floats by name (null when freed). An entry a patch does not list keeps its floats. */
export interface ResolvedParticles {
  id: number;
  /** "adopted" for an emitter that existed before arm (PM7). */
  origin: "created" | "adopted";
  status: ParticlesStatus;
  reason: ParticlesReason | null;
  version: number;
  mode: ParticlesMode;
  emitting: boolean;
  amount: number;
  one_shot: boolean;
  fixed_fps: number;
  interpolate: boolean;
  fractional_delta: boolean;
  local: boolean;
  draw_order: ParticlesDrawOrder;
  transform_align: ParticlesTransformAlign;
  trails: boolean;
  trail_poses: number;
  seed: number;
  restarts: number;
  emits: number;
  process_requests: number;
  process_material: number | null;
  draw_passes: Array<number | null>;
  subemitter: number | null;
  floats: ResolvedParticlesFloats | null;
}

export interface ResolvedState {
  canvases: Map<number, ResolvedCanvas>;
  items: Map<number, ResolvedItem>;
  textures: Map<number, ResolvedTexture>;
  meshes: Map<number, ResolvedMesh>;
  shaders: Map<number, ResolvedShader>;
  materials: Map<number, ResolvedMaterial>;
  /** new at /11 (PM1): empty below /11 and in a /11 stream that holds no multimesh. */
  multimeshes: Map<number, ResolvedMultimesh>;
  /** new at /12 (PM5): empty below /12 and in a /12 stream that holds no emitter. */
  particles: Map<number, ResolvedParticles>;
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
    multimeshes: new Map(),
    particles: new Map(),
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
  if (cmd.op === "add_multimesh") {
    return { op: "add_multimesh", multimesh: cmd.multimesh, tex: cmd.tex };
  }
  if (cmd.op === "add_particles") {
    return { op: "add_particles", particles: cmd.particles, tex: cmd.tex };
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
  backbufferF32: number[] = [],
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
  // new at /10 (render-stream-10.md "Decoded and resolved forms"): canvas_group and
  // copy_to_backbuffer, right after instance_params, their floats lifted inline.
  const backbufferFields =
    it.canvas_group !== undefined
      ? {
          canvas_group:
            it.canvas_group === null
              ? null
              : {
                  mode: it.canvas_group.mode,
                  clear_margin: backbufferF32[it.canvas_group.f],
                  fit_empty: it.canvas_group.fit_empty,
                  fit_margin: backbufferF32[it.canvas_group.f + 1],
                  blur_mipmaps: it.canvas_group.blur_mipmaps,
                },
          copy_to_backbuffer:
            it.copy_to_backbuffer === null ||
            it.copy_to_backbuffer === undefined
              ? null
              : {
                  rect: backbufferF32.slice(
                    it.copy_to_backbuffer.f,
                    it.copy_to_backbuffer.f + 4,
                  ) as [number, number, number, number],
                },
        }
      : {};
  return {
    ...base,
    ...materialFields,
    ...backbufferFields,
    ...(it.use_identity_transform === true
      ? { use_identity_transform: true as const }
      : {}),
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
function liftMesh(
  m: TransactionMesh,
  meshF32: number[],
  meshU8?: Uint8Array,
  previous?: ResolvedMesh,
): ResolvedMesh {
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
    ...(m.adopted_content !== undefined
      ? { adopted_content: m.adopted_content }
      : {}),
    status: m.status,
    reason: m.reason,
    version: m.version,
    custom_aabb,
    surfaces:
      m.u8 === undefined ? m.surfaces : liftSurfacesV11(m, meshU8, previous),
  };
}

/** render-stream-11.md "Resolution and resolved form": a non-null u8 replaces every body of the
 * mesh (each surface's body is payload_bytes long, in surface order, from u8); a null one keeps
 * the previous entry's (same surface index). Static surfaces get body_sha256 null. A body the
 * caller has no bytes for (no `meshU8`, or a slice past its end) also resolves to null. */
function liftSurfacesV11(
  m: TransactionMesh,
  meshU8: Uint8Array | undefined,
  previous: ResolvedMesh | undefined,
): ResolvedMeshSurface[] {
  let pos = m.u8 ?? 0;
  return m.surfaces.map((s, i) => {
    let body: string | null = null;
    if (surfaceIsDynamic(s)) {
      if (m.u8 !== null && m.u8 !== undefined) {
        if (meshU8 !== undefined && pos + s.payload_bytes <= meshU8.length)
          body = hashBytes(meshU8.subarray(pos, pos + s.payload_bytes));
        pos += s.payload_bytes;
      } else {
        body = previous?.surfaces[i]?.body_sha256 ?? null;
      }
    }
    return {
      hash: s.hash,
      body_sha256: body,
      payload_bytes: s.payload_bytes,
      primitive: s.primitive,
      format: s.format,
      vertex_count: s.vertex_count,
      index_count: s.index_count,
    };
  });
}

/** PM1 (render-stream-11.md "As built (PM1)", 10): the SHA-256 of a multimesh buffer's
 * little-endian f32 bytes, the resolved form's `buffer_sha256` (the empty buffer hashes the
 * empty string). Takes the floats as numbers (each written as its nearest float32). */
export function multimeshBufferSha256(floats: readonly number[]): string {
  const bytes = new Uint8Array(floats.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < floats.length; i++)
    view.setFloat32(i * 4, floats[i], true);
  return hashBytes(bytes);
}

/** PM1 (render-stream-11.md "As built (PM1)", 10): lifts one multimesh entry. The custom AABB
 * comes from mm_f32 at aabb_f (null when freed). A non-null buffer_f hashes the entry's
 * `instances x stride` floats there (from `mmF32Bytes`, the raw block, when given, else from the
 * decoded floats); a null one keeps the previous entry's digest. */
function liftMultimesh(
  m: TransactionMultimesh,
  mmF32: number[],
  mmF32Bytes: Uint8Array | undefined,
  previous: ResolvedMultimesh | undefined,
): ResolvedMultimesh {
  const custom_aabb =
    m.aabb_f === null
      ? null
      : (mmF32.slice(m.aabb_f, m.aabb_f + 6) as [
          number,
          number,
          number,
          number,
          number,
          number,
        ]);
  let buffer_sha256: string | null = null;
  if (m.status === "ok") {
    if (m.buffer_f !== null) {
      const n = m.instances * multimeshStride(m);
      buffer_sha256 =
        mmF32Bytes !== undefined && (m.buffer_f + n) * 4 <= mmF32Bytes.length
          ? hashBytes(mmF32Bytes.subarray(m.buffer_f * 4, (m.buffer_f + n) * 4))
          : multimeshBufferSha256(mmF32.slice(m.buffer_f, m.buffer_f + n));
    } else {
      buffer_sha256 = previous?.buffer_sha256 ?? null;
    }
  }
  return {
    id: m.id,
    origin: m.origin,
    status: m.status,
    reason: m.reason,
    version: m.version,
    mesh: m.mesh,
    format: m.format,
    colors: m.colors,
    custom: m.custom,
    instances: m.instances,
    visible: m.visible,
    custom_aabb,
    buffer_sha256,
  };
}

/** One multimesh entry of a decoded /11 transaction with its floats: `custom_aabb` (null when
 * freed) and `buffer` (the instances x stride floats, or null when buffer_f is null). */
export interface TransactionMultimeshFloats {
  entry: TransactionMultimesh;
  custom_aabb: number[] | null;
  buffer: number[] | null;
}

/** PM1: a decoded /11 transaction's multimesh entries (in entry order) with the floats each one
 * claims in mm_f32 (block 8). `blocks` is the decoded form's blocks, where mm_f32 is a plain
 * float array. Empty when the transaction carries no "multimeshes" key. */
export function transactionMultimeshes(
  meta: TransactionMeta,
  blocks: DecodedBlock[],
): TransactionMultimeshFloats[] {
  const mmF32 = (Array.isArray(blocks[8]) ? blocks[8] : []) as number[];
  return (meta.multimeshes ?? []).map((entry) => ({
    entry,
    custom_aabb:
      entry.aabb_f === null ? null : mmF32.slice(entry.aabb_f, entry.aabb_f + 6),
    buffer:
      entry.buffer_f === null
        ? null
        : mmF32.slice(
            entry.buffer_f,
            entry.buffer_f + entry.instances * multimeshStride(entry),
          ),
  }));
}

/** PM5 (render-stream-12.md "Resolved form"): an entry's floats by name, from its
 * `particlesFloatCount(trail_poses)` floats in wire order. */
export function particlesFloatsByName(
  floats: readonly number[],
): ResolvedParticlesFloats {
  const out: Record<string, number | number[] | number[][]> = {};
  for (const [name, at, n] of PARTICLES_FLOAT_LAYOUT)
    out[name] = n === 1 ? floats[at] : floats.slice(at, at + n);
  const poses: number[][] = [];
  for (
    let at = PARTICLES_BASE_FLOAT_COUNT;
    at + PARTICLES_TRAIL_POSE_FLOATS <= floats.length;
    at += PARTICLES_TRAIL_POSE_FLOATS
  )
    poses.push(floats.slice(at, at + PARTICLES_TRAIL_POSE_FLOATS));
  out.trail_poses = poses;
  return out as unknown as ResolvedParticlesFloats;
}

/** PM5: the inverse of particlesFloatsByName, the entry's floats in wire order. */
export function particlesFloatsInWireOrder(
  floats: ResolvedParticlesFloats,
): number[] {
  const out: number[] = [];
  for (const [name] of PARTICLES_FLOAT_LAYOUT) {
    const v = floats[name];
    if (typeof v === "number") out.push(v);
    else out.push(...(v as number[]));
  }
  for (const pose of floats.trail_poses) out.push(...pose);
  return out;
}

/** PM5 (render-stream-12.md "Resolved form"): lifts one particles entry. Its floats come from
 * pt_f32 at `f`; a freed entry's are null; an `f` null on a non-freed entry (which particles-entry
 * refuses) keeps the previous entry's. */
function liftParticles(
  p: TransactionParticles,
  ptF32: readonly number[],
  previous: ResolvedParticles | undefined,
): ResolvedParticles {
  const { f, ...fields } = p;
  const floats =
    p.status === "freed"
      ? null
      : f !== null
        ? particlesFloatsByName(
            ptF32.slice(f, f + particlesFloatCount(p.trail_poses)),
          )
        : (previous?.floats ?? null);
  return { ...fields, draw_passes: [...p.draw_passes], floats };
}

/** One particles entry of a decoded /12 transaction with its floats in wire order (null when
 * `f` is null, i.e. freed). */
export interface TransactionParticlesFloats {
  entry: TransactionParticles;
  floats: number[] | null;
}

/** PM5: a decoded /12 transaction's particles entries (in entry order) with the floats each one
 * claims in pt_f32 (block 9, PT_F32_BLOCK). `blocks` is the decoded form's blocks. Empty when the
 * transaction carries no "particles" key. */
export function transactionParticles(
  meta: TransactionMeta,
  blocks: DecodedBlock[],
): TransactionParticlesFloats[] {
  const ptF32 = (
    Array.isArray(blocks[PT_F32_BLOCK]) ? blocks[PT_F32_BLOCK] : []
  ) as number[];
  return (meta.particles ?? []).map((entry) => ({
    entry,
    floats:
      entry.f === null
        ? null
        : ptF32.slice(entry.f, entry.f + particlesFloatCount(entry.trail_poses)),
  }));
}

/** One element of a /12 transaction's emit list with its 23 floats split by meaning. */
export interface TransactionParticleEmitFloats {
  emit: TransactionParticleEmit;
  /** The emit transform, a Transform3D (basis.rows[0..2] xyz each, then origin). */
  transform: number[];
  velocity: number[];
  color: number[];
  custom: number[];
}

/** PM5 (render-stream-12.md "The emit list"): a decoded /12 transaction's particle_emits, in
 * list order (the order a receiver applies them), with their floats from pt_f32. Empty when the
 * transaction carries no "particle_emits" key. */
export function transactionParticleEmits(
  meta: TransactionMeta,
  blocks: DecodedBlock[],
): TransactionParticleEmitFloats[] {
  const ptF32 = (
    Array.isArray(blocks[PT_F32_BLOCK]) ? blocks[PT_F32_BLOCK] : []
  ) as number[];
  return (meta.particle_emits ?? []).map((emit) => {
    const f = ptF32.slice(emit.f, emit.f + PARTICLE_EMIT_FLOAT_COUNT);
    return {
      emit,
      transform: f.slice(0, 12),
      velocity: f.slice(12, 15),
      color: f.slice(15, 19),
      custom: f.slice(19, 23),
    };
  });
}

/** The raw bytes of block `index` of a record that already passed decodeRecord()'s framing
 * checks (decodeRecord() replaces a u8 block with {u8_bytes, sha256}). */
export function rawRecordBlock(raw: RawRecord, index: number): Uint8Array {
  const view = new DataView(
    raw.bytes.buffer,
    raw.bytes.byteOffset,
    raw.bytes.byteLength,
  );
  let pos = 8 + view.getUint32(4, true);
  const count = view.getUint32(pos, true);
  pos += 4;
  for (let i = 0; i < count; i++) {
    const len = view.getUint32(pos, true);
    pos += 4;
    if (i === index) return raw.bytes.subarray(pos, pos + len);
    pos += len;
  }
  return new Uint8Array(0);
}

export function applyTransaction(
  base: ResolvedState,
  meta: TransactionMeta,
  blocks: number[][],
  /** /11 only: the transaction's raw mesh_u8 block (rawRecordBlock(raw, 7)), for body_sha256. */
  meshU8?: Uint8Array,
  /** /11 only: the transaction's raw mm_f32 block (rawRecordBlock(raw, 8)), for buffer_sha256;
   * without it the digest is computed from the decoded floats (blocks[8]). */
  mmF32Bytes?: Uint8Array,
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
  const multimeshes =
    meta.encoding === "full"
      ? new Map<number, ResolvedMultimesh>()
      : new Map(base.multimeshes);
  const particles =
    meta.encoding === "full"
      ? new Map<number, ResolvedParticles>()
      : new Map(base.particles);
  if (meta.encoding === "patch") {
    for (const id of meta.removed_particles ?? []) particles.delete(id);
    for (const id of meta.removed_multimeshes ?? []) multimeshes.delete(id);
    for (const id of meta.removed_canvases) canvases.delete(id);
    for (const id of meta.removed_items) items.delete(id);
    for (const id of meta.removed_textures) textures.delete(id);
    if (isV4) for (const id of meta.removed_meshes ?? []) meshes.delete(id);
    if (isV5) {
      for (const id of meta.removed_shaders ?? []) shaders.delete(id);
      for (const id of meta.removed_materials ?? []) materials.delete(id);
    }
  }
  const [itemF32, canvasF32, cmdF32, cmdI32, meshF32, paramF64, backbufferF32] =
    blocks;
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
      backbufferF32 ?? [],
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
      meshes.set(
        m.id,
        liftMesh(m, meshF32 ?? [], meshU8, base.meshes.get(m.id)),
      );
    }
  }
  if (isV5) {
    for (const s of meta.shaders ?? []) {
      shaders.set(s.id, liftShader(s));
    }
  }
  for (const m of meta.multimeshes ?? []) {
    multimeshes.set(
      m.id,
      liftMultimesh(
        m,
        (blocks[8] ?? []) as number[],
        mmF32Bytes,
        base.multimeshes.get(m.id),
      ),
    );
  }
  for (const p of meta.particles ?? []) {
    particles.set(
      p.id,
      liftParticles(
        p,
        (blocks[PT_F32_BLOCK] ?? []) as number[],
        base.particles.get(p.id),
      ),
    );
  }
  return {
    canvases,
    items,
    textures,
    meshes,
    shaders,
    materials,
    multimeshes,
    particles,
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

export function sortedResolvedParticles(
  state: ResolvedState,
): ResolvedParticles[] {
  return [...state.particles.values()].sort((a, b) => a.id - b.id);
}

export function sortedResolvedMultimeshes(
  state: ResolvedState,
): ResolvedMultimesh[] {
  return [...state.multimeshes.values()].sort((a, b) => a.id - b.id);
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

function variantsOnlyGrew(
  previous: TextureVariant[],
  current: TextureVariant[],
): boolean {
  return previous.every((p) =>
    current.some((c) => c.encoding === p.encoding && statesEqual(p, c)),
  );
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
  // render-stream-9.md (texture-delivery-design.md D6): at an equal version `variants` may grow --
  // every earlier variant stays identical and more may appear -- and nothing else changes.
  if (
    previous.status !== "freed" &&
    current.status !== "freed" &&
    statesEqual(
      { ...previous, variants: undefined },
      { ...current, variants: undefined },
    ) &&
    variantsOnlyGrew(previous.variants ?? [], current.variants ?? [])
  ) {
    return false;
  }
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

// render-stream-8.md "Resource tables" ("adoption-entry", "decode-entry"): the /8 rules that cross
// the session and the resolved tables. An "adopted" origin on any canvas, item, texture, mesh,
// shader or material needs a session that declares `adoption`; a texture's `source_format` is
// non-null only on an ok image whose payload format differs from it, in a session whose
// `resources.decode` is "engine".
function checkAdoptionInvariants(
  state: ResolvedState,
  adoptionDeclared: boolean,
  decodeEngine: boolean,
  offset: number,
): string[] {
  if (!adoptionDeclared) {
    const tables: Array<[string, Iterable<{ id: number; origin: string }>]> = [
      ["canvas", state.canvases.values()],
      ["item", state.items.values()],
      ["texture", state.textures.values()],
      ["mesh", state.meshes.values()],
      ["shader", state.shaders.values()],
      ["material", state.materials.values()],
      ["particles", state.particles.values()],
    ];
    for (const [what, entries] of tables) {
      for (const e of entries) {
        if (e.origin === "adopted") {
          return [
            `adoption-entry: record at offset ${offset}: ${what} ${e.id} has origin "adopted", but the session declares no adoption`,
          ];
        }
      }
    }
  }
  for (const t of state.textures.values()) {
    if (t.source_format === undefined || t.source_format === null) continue;
    if (t.kind !== "image" || t.status !== "ok") {
      return [
        `decode-entry: record at offset ${offset}: texture ${t.id}: source_format needs an "ok" image entry`,
      ];
    }
    if (t.source_format === t.format) {
      return [
        `decode-entry: record at offset ${offset}: texture ${t.id}: source_format equals the payload format ${t.format}`,
      ];
    }
    if (!decodeEngine) {
      return [
        `decode-entry: record at offset ${offset}: texture ${t.id} declares source_format ${t.source_format}, but the session's resources.decode is not "engine"`,
      ];
    }
  }
  return [];
}

// render-stream-9.md "Texture entries" (`delivery-entry`): the rules on `variants` and on what a
// block format may be. Variants sit only on an ok image; they are sorted by encoding with at most
// one each; every one is an encoding the session's mode offers; a `block` variant carries a block
// format and null params; a Basis variant carries null format and params that start with the
// session's encoder; no variant repeats the base payload's hash; and a block format is never the
// base payload of an ok entry (it is legal only as a variant).
function checkDeliveryInvariants(
  state: ResolvedState,
  declaration: TextureDeliveryDeclaration,
  offset: number,
): string[] {
  const offered = DELIVERY_MODE_ENCODINGS[declaration.mode] ?? [];
  for (const t of state.textures.values()) {
    const err = (detail: string) => [
      `delivery-entry: record at offset ${offset}: texture ${t.id}: ${detail}`,
    ];
    const variants = t.variants ?? [];
    const okImage = t.kind === "image" && t.status === "ok";
    if (okImage && t.format !== null && t.format in BLOCK_FORMATS) {
      return err(
        `the base payload format ${t.format} is a block format (legal only as a variant)`,
      );
    }
    if (variants.length > 0 && !okImage) {
      return err('only an "ok" image entry carries variants');
    }
    let previous = -1;
    const hashes = new Set<string>(t.hash === null ? [] : [t.hash]);
    for (const v of variants) {
      const order = VARIANT_ENCODINGS.indexOf(v.encoding);
      if (order <= previous) {
        return err(
          `variants are not sorted by encoding with at most one each (${v.encoding})`,
        );
      }
      previous = order;
      if (!offered.includes(v.encoding)) {
        return err(
          `a ${v.encoding} variant, but the session's mode "${declaration.mode}" does not offer it`,
        );
      }
      if (v.payload_bytes < 1)
        return err(`a ${v.encoding} variant has payload_bytes 0`);
      if (hashes.has(v.hash)) {
        return err(`a ${v.encoding} variant repeats a hash of the same entry`);
      }
      hashes.add(v.hash);
      if (v.encoding === "block") {
        if (v.format === null || !(v.format in BLOCK_FORMATS)) {
          return err(
            `a block variant's format ${v.format} is not a block format`,
          );
        }
        if (v.params !== null) return err("a block variant has params");
      } else {
        if (v.format !== null)
          return err(`a ${v.encoding} variant has a format`);
        if (declaration.encoder === null) {
          return err(
            `a ${v.encoding} variant, but the session declares no encoder`,
          );
        }
        if (
          v.params === null ||
          !v.params.startsWith(`${declaration.encoder}/`)
        ) {
          return err(
            `a ${v.encoding} variant's params do not start with the declared encoder ${declaration.encoder}`,
          );
        }
      }
    }
  }
  return [];
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
    // PM1 rule 7: add_multimesh's tex follows the same rule (absent below /11).
    "add_multimesh",
    // render-stream-12.md "The command": add_particles' tex likewise (absent below /12).
    "add_particles",
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
    add_multimesh: "canvas_item_add_multimesh",
    add_particles: "canvas_item_add_particles",
  };
  const actualUnsupportedOps = new Map<string, UnsupportedReason>();
  const actualUnsupportedTexture = new Set<string>();
  const actualUnsupportedMesh = new Set<string>();
  // PM1 rule 7: unsupported-multimesh, one per (item, "canvas_item_add_multimesh") pair whose
  // add_multimesh names an unsupported multimesh (as unsupported-mesh for add_mesh).
  const actualUnsupportedMultimesh = new Set<string>();
  // render-stream-12.md "The command": unsupported-particles, one per (item,
  // "canvas_item_add_particles") pair whose add_particles names an unsupported emitter (a freed
  // tombstone adds none).
  const actualUnsupportedParticles = new Set<string>();
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
            command.reason === "skinned-geometry" ||
            command.reason === "unknown-multimesh" ||
            command.reason === "unknown-particles"
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
      if (command.op === "add_multimesh" && command.multimesh !== undefined) {
        const target = state.multimeshes.get(command.multimesh);
        if (target !== undefined && target.status === "unsupported") {
          actualUnsupportedMultimesh.add(
            `${item.id}:canvas_item_add_multimesh`,
          );
        }
      }
      if (command.op === "add_particles" && command.particles !== undefined) {
        const target = state.particles.get(command.particles);
        if (target !== undefined && target.status === "unsupported") {
          actualUnsupportedParticles.add(
            `${item.id}:canvas_item_add_particles`,
          );
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
  const declaredUnsupportedMultimesh = new Set<string>();
  const declaredUnsupportedParticles = new Set<string>();
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
      entry.reason === "skinned-geometry" ||
      entry.reason === "unknown-multimesh" ||
      entry.reason === "unknown-particles"
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
    } else if (entry.reason === "unsupported-multimesh") {
      const pair = `${entry.item}:${entry.op}`;
      if (!actualUnsupportedMultimesh.has(pair)) {
        return [
          `unsupported-mismatch: ${where}: unsupported-multimesh entry (${entry.item}, ${entry.op}) does not correspond to an add_multimesh naming an unsupported multimesh`,
        ];
      }
      declaredUnsupportedMultimesh.add(pair);
    } else if (entry.reason === "unsupported-particles") {
      const pair = `${entry.item}:${entry.op}`;
      if (!actualUnsupportedParticles.has(pair)) {
        return [
          `unsupported-mismatch: ${where}: unsupported-particles entry (${entry.item}, ${entry.op}) does not correspond to an add_particles naming an unsupported emitter`,
        ];
      }
      declaredUnsupportedParticles.add(pair);
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
  for (const pair of actualUnsupportedMultimesh) {
    if (!declaredUnsupportedMultimesh.has(pair)) {
      return [
        `unsupported-mismatch: ${where}: add_multimesh command (${pair.replace(":", ", ")}) names an unsupported multimesh, with no unsupported-multimesh entry`,
      ];
    }
  }
  for (const pair of actualUnsupportedParticles) {
    if (!declaredUnsupportedParticles.has(pair)) {
      return [
        `unsupported-mismatch: ${where}: add_particles command (${pair.replace(":", ", ")}) names an unsupported emitter, with no unsupported-particles entry`,
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
  /** render-stream-11.md decision 9 (`inline-fetch-zero`): null when a GET of `hash` is legal
   * now, else the `inline-fetch-zero` error. Always null below /11. See checkInlineFetch(). */
  checkInlineFetch(hash: string): string | null;
  /** TAG1: the item_meta identity table as of the newest accepted transaction (empty, grant
   * null, for a stream without item_meta records). */
  itemMeta?(): ItemMetaTable;
  /** TAG1: the accepted item_meta record awaiting its transaction, if any. */
  itemMetaPending?(): ItemMetaRecordMeta | null;
}

/**
 * render-stream-11.md "As built (W11a)" decision 9: the `inline-fetch-zero` predicate, the same
 * question every /11 receiver asks before an HTTP GET (rs-core's `Validator::check_fetch`). A GET
 * of `hash` is refused when, over the validator's accepted records, `hash` is a non-variant name
 * of the newest accepted state (an ok image texture's hash, an ok mesh's static surface, an ok
 * payload shader) whose entry has `payload_bytes <= inline_max_bytes`, or is in the carried set C
 * with a record of `bytes <= inline_max_bytes`. A variant hash not in C may always be fetched
 * (render-stream-9.md: a variant is never required inline). Returns null when the GET is legal.
 */
export function checkInlineFetch(
  validator: RecordingValidator,
  hash: string,
): string | null {
  return validator.checkInlineFetch(hash);
}

/** createRecordingValidator's options: DecodeRecordOptions plus a validator sabotage. */
export interface RecordingValidatorOptions extends DecodeRecordOptions {
  /**
   * render-stream-11.md decision 10, /11 only: "early-prune" prunes C to the BASE state's names
   * when a transaction arrives, before resolving and checking it. That drops the records the
   * transaction brings, so golden-11's inline.rs11 fails resource-missing at seq 1.
   */
  sabotage?: "early-prune";
  /**
   * render-stream-13.md "Sabotages", /13 only: no-predict-reset -- a full does not reset the
   * prediction history (it is un-predicted against H1 and H2 like a patch), so predict.rs13 fails
   * predict-check at seq 7 and patch.rs13 at seq 16.
   */
  noPredictReset?: boolean;
  /**
   * TAG1 (client-extensions-design.md §2.4, /13 only): the viewer's item_meta ask. Absent
   * (undefined: a recording) accepts and validates item_meta records; null (a live viewer whose
   * hello had no item_meta key) refuses them (`item-meta-unexpected`); a request checks each
   * grant against it (`item-meta-schema`).
   */
  itemMeta?: ItemMetaRequest | null;
}

/** render-stream-11.md "Definitions": names(S), every payload hash the resolved state names --
 * each ok image texture's hash and its variants' hashes, each static surface of an ok mesh, and
 * each ok shader whose source is "payload". Dynamic surfaces (hash null) are not names. */
export function resolvedStateNames(state: ResolvedState): Set<string> {
  const names = new Set<string>();
  for (const t of state.textures.values()) {
    if (t.kind !== "image" || t.status !== "ok" || t.hash === null) continue;
    names.add(t.hash);
    for (const v of t.variants ?? []) names.add(v.hash);
  }
  for (const m of state.meshes.values()) {
    if (m.status !== "ok") continue;
    for (const surface of m.surfaces)
      if (!surfaceIsDynamic(surface)) names.add(surface.hash);
  }
  for (const sh of state.shaders.values()) {
    if (sh.status === "ok" && sh.source === "payload" && sh.hash !== null)
      names.add(sh.hash);
  }
  return names;
}

/** The payload_bytes of `hash` as a non-variant name of `state` (decision 9), or undefined. */
function nonVariantNameBytes(
  state: ResolvedState,
  hash: string,
): number | undefined {
  for (const t of state.textures.values())
    if (t.kind === "image" && t.status === "ok" && t.hash === hash)
      return t.payload_bytes;
  for (const m of state.meshes.values()) {
    if (m.status !== "ok") continue;
    for (const surface of m.surfaces)
      if (surface.hash === hash) return surface.payload_bytes;
  }
  for (const sh of state.shaders.values())
    if (sh.status === "ok" && sh.source === "payload" && sh.hash === hash)
      return sh.payload_bytes;
  return undefined;
}

/** render-stream-11.md decision 7: JSON values equal, numbers by bit pattern (Object.is: -0 is not
 * 0; every float here was read from an f32 block, so equal doubles are equal float32 bits). */
function jsonBitEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") return Object.is(a, b);
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++)
      if (!jsonBitEqual(a[i], bb[i])) return false;
    return true;
  }
  const ka = Object.keys(a).filter(
    (k) => (a as Record<string, unknown>)[k] !== undefined,
  );
  const kb = Object.keys(b).filter(
    (k) => (b as Record<string, unknown>)[k] !== undefined,
  );
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (
      !jsonBitEqual(
        (a as Record<string, unknown>)[ka[i]],
        (b as Record<string, unknown>)[kb[i]],
      )
    )
      return false;
  }
  return true;
}

/** render-stream-11.md "Dynamic mesh surfaces": a dynamic surface's body length from its shape,
 * render-stream-4.md's payload-size buffer rules plus the 40 geometry bytes. */
export function meshBodyBytes(surface: {
  format: number;
  vertex_count: number;
  index_count: number;
}): number {
  const e = expectedMeshBufferBytes(
    surface.format,
    surface.vertex_count,
    surface.index_count,
  );
  return 40 + e.vertex_bytes + e.attribute_bytes + e.skin_bytes + e.index_bytes;
}

/**
 * render-stream-11.md "Dynamic mesh surfaces", in decision 4's order over one /11 transaction's
 * mesh entries: mesh-dynamic (each entry), then mesh-u8-offset (over the entries, and the
 * mesh_u8 block's count), then payload-size (each dynamic surface's body length from its shape).
 * `base` is the state the transaction applies to (the u8-null rule reads its entry).
 */
function checkDynamicMeshes(
  meta: TransactionMeta,
  base: ResolvedState,
  offset: number,
): string[] {
  const meshes = meta.meshes ?? [];
  const dynErr = (id: number, detail: string) => [
    `mesh-dynamic: record at offset ${offset}: mesh ${id}: ${detail}`,
  ];
  for (const m of meshes) {
    const u8 = m.u8 ?? null;
    if (m.status !== "ok") {
      if (u8 !== null)
        return dynErr(m.id, `an "${m.status}" entry has u8 ${u8}, not null`);
      continue;
    }
    const dynamicCount = m.surfaces.filter(surfaceIsDynamic).length;
    if (dynamicCount !== 0 && dynamicCount !== m.surfaces.length)
      return dynErr(
        m.id,
        "its surfaces are neither all static nor all dynamic",
      );
    if (dynamicCount === 0) {
      if (u8 !== null)
        return dynErr(
          m.id,
          `u8 ${u8} on a static mesh (non-null only on a dynamic ok mesh with at least one surface)`,
        );
      continue;
    }
    if (u8 !== null) continue;
    // u8 null on a dynamic mesh: legal only in a patch whose resolved entry was already dynamic,
    // with the same surface count and the same four shape fields on every surface.
    const previous = base.meshes.get(m.id);
    const keeps =
      meta.encoding === "patch" &&
      previous !== undefined &&
      previous.status === "ok" &&
      previous.surfaces.length === m.surfaces.length &&
      previous.surfaces.every(
        (p, k) => surfaceIsDynamic(p) && sameSurfaceShape(p, m.surfaces[k]),
      );
    if (!keeps)
      return dynErr(
        m.id,
        meta.encoding === "full"
          ? "u8 is null in a full transaction"
          : "u8 is null but the base entry is not dynamic with the same surface shapes",
      );
  }
  let running = 0;
  for (const m of meshes) {
    if (m.u8 === null || m.u8 === undefined) continue;
    if (m.u8 !== running)
      return [
        `mesh-u8-offset: record at offset ${offset}: mesh ${m.id} u8=${m.u8}, expected ${running}`,
      ];
    for (const surface of m.surfaces) running += surface.payload_bytes;
  }
  const declared = meta.blocks.find((b) => b.name === "mesh_u8")?.count;
  if (declared !== running)
    return [
      `mesh-u8-offset: record at offset ${offset}: block "mesh_u8" declares count ${declared}, expected ${running}`,
    ];
  for (const m of meshes) {
    if (m.status !== "ok") continue;
    for (let k = 0; k < m.surfaces.length; k++) {
      const surface = m.surfaces[k];
      if (!surfaceIsDynamic(surface)) continue;
      const expected = meshBodyBytes(surface);
      if (surface.payload_bytes !== expected)
        return [
          `payload-size: record at offset ${offset}: mesh ${m.id} surface ${k}'s body is ${surface.payload_bytes} bytes, its shape (${surface.primitive} format ${surface.format} vertex_count ${surface.vertex_count} index_count ${surface.index_count}) needs ${expected}`,
        ];
    }
  }
  return [];
}

/**
 * PM1 (render-stream-11.md "As built (PM1)", 2-6), in rule 5's order over one /11 transaction:
 * multimesh-entry (each entry's shape, then the buffer_f rule), multimesh-version (against the
 * last entry seen for the id in this stream), mm-offset (every non-null offset is the running
 * float count, and mm_f32's count is the total; a float no entry claims included), then
 * multimesh-ref (every add_multimesh of the resolved items names a resolved multimesh, and every
 * resolved multimesh's non-null mesh names a resolved mesh). `base` is the state the transaction
 * applies to. The float half of multimesh-version (an equal version over a changed AABB or
 * buffer) is checked after the transaction resolves, by multimeshVersionRegressed().
 */
function checkMultimeshes(
  meta: TransactionMeta,
  base: ResolvedState,
  lastSeen: Map<number, ResolvedMultimesh>,
  mmFloatCount: number,
  offset: number,
): string[] {
  const mms = meta.multimeshes ?? [];
  const entryErr = (id: number, detail: string) => [
    `multimesh-entry: record at offset ${offset}: multimesh ${id}: ${detail}`,
  ];
  for (const m of mms) {
    if (m.status === "ok") {
      if (m.reason !== null) return entryErr(m.id, '"ok" needs reason null');
      if (m.format !== "2d") return entryErr(m.id, '"ok" needs format "2d"');
      if (m.aabb_f === null) return entryErr(m.id, '"ok" needs a non-null aabb_f');
      if (m.visible > m.instances)
        return entryErr(
          m.id,
          `visible ${m.visible} exceeds instances ${m.instances}`,
        );
    } else if (m.status === "unsupported") {
      if (m.reason === null)
        return entryErr(m.id, '"unsupported" needs a non-null reason');
      if (m.aabb_f === null)
        return entryErr(m.id, '"unsupported" needs a non-null aabb_f');
      if (m.buffer_f !== null)
        return entryErr(m.id, `"unsupported" carries buffer_f ${m.buffer_f}`);
    } else if (
      m.reason !== null ||
      m.mesh !== null ||
      m.format !== "2d" ||
      m.colors ||
      m.custom ||
      m.instances !== 0 ||
      m.visible !== -1 ||
      m.aabb_f !== null ||
      m.buffer_f !== null
    ) {
      return entryErr(
        m.id,
        'a "freed" entry needs reason/mesh/aabb_f/buffer_f null, format "2d", colors/custom false, instances 0 and visible -1',
      );
    }
  }
  for (const m of mms) {
    if (m.status !== "ok" || m.buffer_f !== null) continue;
    // buffer_f null on an ok entry: legal only in a patch over an ok base entry of the same shape.
    const previous = meta.encoding === "patch" ? base.multimeshes.get(m.id) : undefined;
    const why =
      meta.encoding === "full"
        ? "buffer_f is null in a full transaction"
        : previous === undefined
          ? "buffer_f is null on an entry new to the table"
          : previous.status !== "ok"
            ? `buffer_f is null but the base entry is "${previous.status}"`
            : previous.instances !== m.instances ||
                previous.format !== m.format ||
                previous.colors !== m.colors ||
                previous.custom !== m.custom
              ? "buffer_f is null but instances/format/colors/custom differ from the base entry"
              : null;
    if (why !== null) return entryErr(m.id, why);
  }
  for (const m of mms) {
    const previous = lastSeen.get(m.id);
    if (previous === undefined) continue;
    const fieldsMoved =
      previous.origin !== m.origin ||
      previous.status !== m.status ||
      previous.reason !== m.reason ||
      previous.mesh !== m.mesh ||
      previous.format !== m.format ||
      previous.colors !== m.colors ||
      previous.custom !== m.custom ||
      previous.instances !== m.instances ||
      previous.visible !== m.visible;
    if (m.version < previous.version || (m.version === previous.version && fieldsMoved))
      return [
        `multimesh-version: record at offset ${offset}: multimesh ${m.id}'s version ${m.version} is inconsistent with its earlier entry (version ${previous.version})`,
      ];
  }
  let running = 0;
  for (const m of mms) {
    if (m.aabb_f !== null) {
      if (m.aabb_f !== running)
        return [
          `mm-offset: record at offset ${offset}: multimesh ${m.id} aabb_f=${m.aabb_f}, expected ${running}`,
        ];
      running += 6;
    }
    if (m.buffer_f !== null) {
      if (m.buffer_f !== running)
        return [
          `mm-offset: record at offset ${offset}: multimesh ${m.id} buffer_f=${m.buffer_f}, expected ${running}`,
        ];
      running += m.instances * multimeshStride(m);
    }
  }
  const declared = meta.blocks.find((b) => b.name === "mm_f32")?.count;
  if (declared !== running || mmFloatCount !== running)
    return [
      `mm-offset: record at offset ${offset}: block "mm_f32" declares count ${declared}, expected ${running}${running === 0 ? " (no multimesh entry claims any float)" : ""}`,
    ];
  // multimesh-ref, over the resolved tables (base minus removals plus entries, for a patch).
  const full = meta.encoding === "full";
  const mmIds = new Set<number>(full ? [] : base.multimeshes.keys());
  for (const id of meta.removed_multimeshes ?? []) mmIds.delete(id);
  const meshIds = new Set<number>(full ? [] : base.meshes.keys());
  for (const id of meta.removed_meshes ?? []) meshIds.delete(id);
  for (const m of meta.meshes ?? []) meshIds.add(m.id);
  const resolvedMesh = new Map<number, number | null>();
  if (!full)
    for (const [id, m] of base.multimeshes) resolvedMesh.set(id, m.mesh);
  for (const id of meta.removed_multimeshes ?? []) resolvedMesh.delete(id);
  for (const m of mms) {
    mmIds.add(m.id);
    resolvedMesh.set(m.id, m.mesh);
  }
  const refErr = (detail: string) => [
    `multimesh-ref: record at offset ${offset}: ${detail}`,
  ];
  const checkCommands = (
    itemId: number,
    commands: ReadonlyArray<{ op: string; multimesh?: number }>,
  ): string[] => {
    for (const c of commands)
      if (c.op === "add_multimesh" && c.multimesh !== undefined && !mmIds.has(c.multimesh))
        return refErr(
          `item ${itemId}'s add_multimesh names multimesh ${c.multimesh}, which has no entry`,
        );
    return [];
  };
  const inPatch = new Set<number>();
  for (const it of meta.items) {
    inPatch.add(it.id);
    const commands =
      it.commands ?? (full ? [] : (base.items.get(it.id)?.commands ?? []));
    const e = checkCommands(it.id, commands);
    if (e.length > 0) return e;
  }
  if (!full) {
    const removedItems = new Set(meta.removed_items);
    for (const [id, it] of base.items) {
      if (inPatch.has(id) || removedItems.has(id)) continue;
      const e = checkCommands(id, it.commands);
      if (e.length > 0) return e;
    }
  }
  for (const [id, mesh] of [...resolvedMesh].sort((a, b) => a[0] - b[0]))
    if (mesh !== null && !meshIds.has(mesh))
      return refErr(`multimesh ${id}'s mesh ${mesh} has no mesh entry`);
  return [];
}

/** PM1 (multimesh-version): within one stream an id's version never decreases, and at an equal
 * version the resolved entry (custom AABB and buffer digest included) is unchanged. */
function multimeshVersionRegressed(
  previous: ResolvedMultimesh | undefined,
  current: ResolvedMultimesh,
): boolean {
  if (previous === undefined) return false;
  if (current.version !== previous.version)
    return current.version < previous.version;
  return !statesEqual(previous, current);
}

/** PM5 (particles-version's JSON half): the entry's JSON fields other than `id` and `f`. */
const PARTICLES_VERSIONED_KEYS = PARTICLES_KEYS.filter(
  (k) => k !== "id" && k !== "f",
);

/**
 * PM5 (render-stream-12.md "Validators: rule changes"), the pre-resolve half over one /12
 * transaction, in the contract's order: per particles entry particles-entry (the shape rules),
 * then particles-version's JSON half (against the entry the last transaction carrying the id
 * resolved to), then particle-emits (each emit names an `ok` or `unsupported` entry of the
 * resolved table with `restarts` at most the entry's, and per emitter at most `emits` - the
 * base's `emits` are listed), then pt-offset (entries' non-null `f` in entry order, then the
 * emits', each the running float count; pt_f32 present exactly when the total is non-zero, with
 * that count). `base` is the state the transaction applies to.
 */
function checkParticlesPreResolve(
  meta: TransactionMeta,
  base: ResolvedState,
  lastSeen: Map<number, ResolvedParticles>,
  ptFloatCount: number,
  offset: number,
): string[] {
  const entries = meta.particles ?? [];
  const entryErr = (id: number, detail: string) => [
    `particles-entry: record at offset ${offset}: particles ${id}: ${detail}`,
  ];
  for (const p of entries) {
    if (p.status === "ok") {
      if (p.reason !== null) return entryErr(p.id, '"ok" needs reason null');
      if (p.mode !== "2d") return entryErr(p.id, '"ok" needs mode "2d"');
      if (p.f === null) return entryErr(p.id, '"ok" needs a non-null f');
    } else if (p.status === "unsupported") {
      if (p.reason === null)
        return entryErr(p.id, '"unsupported" needs a non-null reason');
      if (p.f === null)
        return entryErr(p.id, '"unsupported" needs a non-null f');
    } else if (
      p.reason !== null ||
      p.f !== null ||
      p.process_material !== null ||
      p.draw_passes.length !== 0 ||
      p.subemitter !== null
    ) {
      return entryErr(
        p.id,
        'a "freed" entry needs reason/f/process_material/subemitter null and draw_passes []',
      );
    }
    if (p.trail_poses > 0 && !p.trails)
      return entryErr(p.id, `trail_poses ${p.trail_poses} needs trails true`);
  }
  for (const p of entries) {
    const previous = lastSeen.get(p.id);
    if (previous === undefined) continue;
    const fieldsMoved = PARTICLES_VERSIONED_KEYS.some(
      (k) =>
        !jsonBitEqual(
          (previous as unknown as Record<string, unknown>)[k],
          (p as unknown as Record<string, unknown>)[k],
        ),
    );
    if (
      p.version < previous.version ||
      (p.version === previous.version && fieldsMoved)
    )
      return [
        `particles-version: record at offset ${offset}: particles ${p.id}'s version ${p.version} ${p.version < previous.version ? "decreased" : "did not move, but the entry changed"} (earlier entry: version ${previous.version})`,
      ];
  }
  const full = meta.encoding === "full";
  const emits = meta.particle_emits ?? [];
  if (emits.length > 0) {
    const emitErr = (detail: string) => [
      `particle-emits: record at offset ${offset}: ${detail}`,
    ];
    const listed = new Map(entries.map((p) => [p.id, p] as const));
    const removed = new Set(meta.removed_particles ?? []);
    const counts = new Map<number, number>();
    for (const e of emits) {
      const target =
        listed.get(e.particles) ??
        (full || removed.has(e.particles)
          ? undefined
          : base.particles.get(e.particles));
      if (target === undefined || target.status === "freed")
        return emitErr(
          `an emit names particles ${e.particles}, which is not an "ok" or "unsupported" entry`,
        );
      if (e.restarts > target.restarts)
        return emitErr(
          `an emit on particles ${e.particles} has restarts ${e.restarts}, over the entry's ${target.restarts}`,
        );
      const baseEmits = full ? 0 : (base.particles.get(e.particles)?.emits ?? 0);
      const n = (counts.get(e.particles) ?? 0) + 1;
      counts.set(e.particles, n);
      if (n > target.emits - baseEmits)
        return emitErr(
          `particles ${e.particles} lists ${n} emits, over its emits ${target.emits} - the base's ${baseEmits}`,
        );
    }
  }
  const offsetErr = (detail: string) => [
    `pt-offset: record at offset ${offset}: ${detail}`,
  ];
  let running = 0;
  for (const p of entries) {
    if (p.f === null) continue;
    if (p.f !== running)
      return offsetErr(`particles ${p.id} f=${p.f}, expected ${running}`);
    running += particlesFloatCount(p.trail_poses);
  }
  for (let i = 0; i < emits.length; i++) {
    if (emits[i].f !== running)
      return offsetErr(
        `particle_emits[${i}] f=${emits[i].f}, expected ${running}`,
      );
    running += PARTICLE_EMIT_FLOAT_COUNT;
  }
  const block = meta.blocks[PT_F32_BLOCK];
  if (block === undefined) {
    if (running > 0)
      return offsetErr(
        `the particles claim ${running} floats, but there is no "pt_f32" block`,
      );
    return [];
  }
  if (block.count === 0)
    return offsetErr(
      'block "pt_f32" is empty (an empty block is the absent block)',
    );
  if (block.count !== running || ptFloatCount !== running)
    return offsetErr(
      `block "pt_f32" declares count ${block.count}, the particles claim ${running}`,
    );
  return [];
}

/**
 * PM5, the resolved half: particles-version's float half (at an unmoved version every float is
 * the earlier entry's, by bit pattern), then particles-ref (every add_particles of the resolved
 * items names a resolved particles entry of any status; every resolved entry's non-null
 * process_material names a resolved material, each non-null draw pass a resolved mesh, a
 * non-null subemitter a resolved particles entry).
 */
function checkParticlesResolved(
  meta: TransactionMeta,
  state: ResolvedState,
  lastSeen: Map<number, ResolvedParticles>,
  offset: number,
): string[] {
  for (const p of meta.particles ?? []) {
    const previous = lastSeen.get(p.id);
    const current = state.particles.get(p.id);
    if (previous === undefined || current === undefined) continue;
    if (
      current.version === previous.version &&
      !jsonBitEqual(previous.floats, current.floats)
    )
      return [
        `particles-version: record at offset ${offset}: particles ${p.id}'s floats changed, but its version ${current.version} did not move`,
      ];
  }
  const refErr = (detail: string) => [
    `particles-ref: record at offset ${offset}: ${detail}`,
  ];
  // The lowest item id with a dangling add_particles (one unsorted pass over the items).
  let badItem: number | null = null;
  let badParticles = 0;
  for (const item of state.items.values()) {
    if (badItem !== null && item.id > badItem) continue;
    for (const c of item.commands)
      if (
        c.op === "add_particles" &&
        c.particles !== undefined &&
        !state.particles.has(c.particles)
      ) {
        badItem = item.id;
        badParticles = c.particles;
        break;
      }
  }
  if (badItem !== null)
    return refErr(
      `item ${badItem}'s add_particles names particles ${badParticles}, which has no entry`,
    );
  for (const p of sortedResolvedParticles(state)) {
    if (p.process_material !== null && !state.materials.has(p.process_material))
      return refErr(
        `particles ${p.id} names process material ${p.process_material}, which has no entry`,
      );
    for (const mesh of p.draw_passes)
      if (mesh !== null && !state.meshes.has(mesh))
        return refErr(
          `particles ${p.id} names draw pass mesh ${mesh}, which has no entry`,
        );
    if (p.subemitter !== null && !state.particles.has(p.subemitter))
      return refErr(
        `particles ${p.id} names subemitter particles ${p.subemitter}, which has no entry`,
      );
  }
  return [];
}

/** render-stream-11.md "Mesh entry" (mesh-dynamic): the four shape fields of two surfaces agree. */
function sameSurfaceShape(
  a: TransactionMeshSurface,
  b: TransactionMeshSurface,
): boolean {
  return (
    a.primitive === b.primitive &&
    a.format === b.format &&
    a.vertex_count === b.vertex_count &&
    a.index_count === b.index_count
  );
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
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 = 6,
  options?: RecordingValidatorOptions,
): RecordingValidator {
  const recordDigest = options?.recordDigest ?? "inline";
  const rejected = (errors: string[]): RecordingValidator => ({
    errors,
    accept: () => errors,
    finish: () => errors,
    digestPending: () => [],
    digest: (i: number) => hashBytes(records[i].bytes),
    checkInlineFetch: () => null,
  });
  // render-stream-11.md: the carried-set rules (C is pruned after every transaction,
  // resource-unnamed), dynamic mesh surfaces, the empty mm_f32 block, content-version-stable and
  // a patch's null "unsupported".
  // render-stream-12.md: the particles rules (isV11 means "V11 or later").
  // render-stream-13.md "As built (W13a)": /13 is /12 plus the predicted blocks (isV12 means
  // "V12 or later").
  const isV13 = version === 13;
  const isV12 = version === 12 || isV13;
  const isV11 = version === 11 || isV12;
  const earlyPrune = isV11 && options?.sabotage === "early-prune";
  // W13a (render-stream-13.md "Decoding and check order"): a /13 transaction's blocks are
  // un-predicted, and predict-check holds, before any /12 rule sees them.
  const unpredictor = isV13
    ? createRs13Unpredictor({ noPredictReset: options?.noPredictReset })
    : null;
  // isV6 means "V6 or later" (render-stream-7.md: transactions/items/commands/invariants are
  // byte-identical to /6).
  const isV10 = version === 10 || isV11;
  const isV9 = version === 9 || isV10;
  const isV8 = version === 8 || isV9;
  const isV7 = version === 7 || isV8;
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
  // Below /11: every hash ever carried in this stream. At /11: the carried set C
  // (render-stream-11.md "Resource retention"), pruned to names(S) after every transaction.
  const carriedHashes = new Set<string>();
  // /11: each carried hash's record bytes (checkInlineFetch), and the hashes added since the
  // previous transaction (resource-unnamed).
  const carriedBytes = new Map<string, number>();
  const addedSinceTransaction: string[] = [];
  // /11: the resolved "unsupported" list a patch's null stands for (the base's).
  let resolvedUnsupported: TransactionMeta["unsupported"] = [];
  const lastSeenTexture = new Map<number, TransactionTexture>();
  const lastSeenMesh = new Map<number, ResolvedMesh>();
  // Resource payload shapes seen so far in THIS call, used to check resource-payload once a
  // texture/mesh entry naming the hash is known. Local to this call: validateRecording() may run
  // repeatedly (e.g. once per golden vector) and must not leak state between calls.
  const resourcePayloadShapes = new Map<string, DecodedTexturePayload>();
  const resourcePayloadLengths = new Map<string, number>();
  const ktx2Shapes = new Map<string, DecodedKtx2Payload>();
  const ktx2Lengths = new Map<string, number>();
  const meshPayloadShapes = new Map<string, DecodedMeshPayload>();
  const meshPayloadLengths = new Map<string, number>();
  const shaderPayloadShapes = new Map<string, DecodedShaderPayload>();
  const shaderPayloadLengths = new Map<string, number>();
  const lastSeenShader = new Map<number, ResolvedShader>();
  const lastSeenMaterial = new Map<number, ResolvedMaterial>();
  const lastSeenMultimesh = new Map<number, ResolvedMultimesh>();
  // PM1 rule 8: add_multimesh is legal only in a session whose features.ops lists it.
  const multimeshOp =
    isV11 && sessionMeta.features.ops.includes("add_multimesh");
  // render-stream-12.md "Session record": the particles keys, particle_emits, pt_f32 and
  // add_particles are legal only in a session whose features.ops lists add_particles.
  const particlesOp =
    isV12 && sessionMeta.features.ops.includes("add_particles");
  // PM5 (particles-version): each particles entry's resolved entry the last time a transaction
  // carried it.
  const lastSeenParticles = new Map<number, ResolvedParticles>();
  let endSeen = false;
  // TAG1 (client-extensions-design.md §2.4): the item_meta table and the record awaiting its
  // transaction. Untouched (one null check per transaction) by a stream without item_meta records.
  const itemMetaAsk = options?.itemMeta;
  const imTable: ItemMetaTable = { grant: null, strings: [], rows: new Map() };
  let imPending: ItemMetaRecordMeta | null = null;
  const imOrphan = (offset: number, what: string): string[] | undefined =>
    imPending !== null
      ? [
          `item-meta-orphan: record at offset ${offset}: ${what} follows an item_meta record, not a transaction`,
        ]
      : undefined;
  // D31/G7o1: the whole-record digest, off the frame path in "deferred" mode.
  const digests = new Map<number, string>();
  const pendingDigest = new Set<number>();

  const accept = (i: number): string[] | undefined => {
    const timer = validatorPhaseTimer;
    const decodeT0 = timer ? timer.now() : 0;
    // TAG1 rules 1 and 2, from the canonical meta's prefix, before the record's own schema.
    if (isV13) {
      const b = records[i].bytes;
      const n = ITEM_META_PREFIX.length;
      if (
        b.length >= 8 + n &&
        new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4, true) >=
          n &&
        ITEM_META_PREFIX.every((x, k) => b[8 + k] === x)
      ) {
        const offset = records[i].offset;
        if (itemMetaAsk === null)
          return [
            `item-meta-unexpected: record at offset ${offset}: an item_meta record on a stream whose viewer did not ask for one`,
          ];
        if (imPending !== null)
          return [
            `item-meta-orphan: record at offset ${offset}: an item_meta record follows an item_meta record, not a transaction`,
          ];
      }
    }
    let decoded = decodeRecord(records[i], version, { recordDigest });
    if (decoded.errors.length > 0 || decoded.record === undefined) {
      if (timer) timer.decode_us += timer.now() - decodeT0;
      return [decoded.errors[0]];
    }
    // TAG1: the transaction's form against the record before it, or a missing full record.
    if (
      decoded.record.meta.type === "transaction" &&
      (imPending !== null || imTable.grant !== null)
    ) {
      const tm = decoded.record.meta;
      const full = tm.encoding === "full";
      const at = `record at offset ${records[i].offset}, transaction seq ${tm.seq}`;
      if (imPending !== null && (imPending.form === "full") !== full) {
        if (timer) timer.decode_us += timer.now() - decodeT0;
        return [
          `item-meta-form: ${at}: a ${imPending.form} item_meta record precedes a ${full ? "full" : "patch"} transaction`,
        ];
      }
      if (imPending === null && full) {
        if (timer) timer.decode_us += timer.now() - decodeT0;
        return [
          `item-meta-missing: ${at}: a full transaction on a granted stream without a full item_meta record before it`,
        ];
      }
    }
    // The record the /12 rules read: /13's with its predicted blocks reconstructed.
    let raw = records[i];
    if (unpredictor !== null && decoded.record.meta.type === "transaction") {
      const result = unpredictor.transaction(raw, decoded.record.meta);
      if ("error" in result) {
        if (timer) timer.decode_us += timer.now() - decodeT0;
        return [result.error];
      }
      raw = result.raw;
      const plain = decodeRecord(raw, version, { recordDigest: "deferred" });
      if (plain.errors.length > 0 || plain.record === undefined) {
        if (timer) timer.decode_us += timer.now() - decodeT0;
        return [plain.errors[0]];
      }
      decoded = {
        record: { ...plain.record, sha256: decoded.record.sha256 },
        errors: [],
      };
    }
    if (timer) timer.decode_us += timer.now() - decodeT0;
    if (decoded.record === undefined) return [decoded.errors[0]];
    if (recordDigest === "deferred") pendingDigest.add(i);
    else digests.set(i, decoded.record.sha256);
    const meta = decoded.record.meta;
    const offset = records[i].offset;

    if (meta.type === "session")
      return [`duplicate-session: a second session record at offset ${offset}`];

    if (meta.type === "item_meta") {
      // TAG1 rules 3-5 (the record's own schema held in decodeRecord); it then waits for its
      // transaction.
      const err = (code: string, d: string) => [
        `${code}: record at offset ${offset}: ${d}`,
      ];
      if (
        itemMetaAsk !== undefined &&
        itemMetaAsk !== null &&
        meta.grant !== null &&
        !itemMetaWithin(meta.grant, itemMetaAsk)
      )
        return err(
          "item-meta-schema",
          `the grant ${JSON.stringify(meta.grant)} is not within the request ${JSON.stringify(itemMetaAsk)}`,
        );
      if (meta.form === "delta") {
        const g = imTable.grant;
        if (g === null)
          return err(
            "item-meta-form",
            "a delta item_meta record before any full one granted",
          );
        const rows = itemMetaRowsProblem(meta.items, g);
        if (rows !== null) return err("item-meta-schema", rows);
        const size = imTable.strings.length;
        if (meta.strings_from !== size)
          return err(
            "item-meta-string",
            `a delta's strings_from is ${meta.strings_from}, the table holds ${size} strings`,
          );
        const indices = itemMetaIndicesProblem(
          meta.items,
          g,
          size + meta.strings.length,
        );
        if (indices !== null) return err("item-meta-string", indices);
      }
      imPending = meta;
      bytesTotal += decoded.record.byte_length;
      maxRecordBytes = Math.max(maxRecordBytes, decoded.record.byte_length);
      return undefined;
    }

    if (meta.type === "resource") {
      const orphan = imOrphan(offset, "a resource record");
      if (orphan) return orphan;
      if (carriedHashes.has(meta.hash)) {
        return [
          isV11
            ? `resource-duplicate: record at offset ${offset}: hash ${meta.hash} is still in the carried set`
            : `resource-duplicate: record at offset ${offset}: hash ${meta.hash} already carried earlier in this stream`,
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
      const isKtx2 = isV9 && isKtx2Payload(rawPayload);
      if (isKtx2) {
        // render-stream-9.md "KTX2 payload": header, level index and DFD (ktx2-header); the
        // entry-dependent half runs once a variant names the hash (ktx2-shape).
        let decodedKtx2: DecodedKtx2Payload;
        try {
          decodedKtx2 = decodeKtx2Payload(rawPayload);
        } catch (e) {
          return [`${(e as Error).message} (record at offset ${offset})`];
        }
        const actualHash = block.sha256;
        if (actualHash !== meta.hash) {
          return [
            `resource-hash: record at offset ${offset}: payload sha256 ${actualHash} disagrees with declared hash ${meta.hash}`,
          ];
        }
        ktx2Shapes.set(meta.hash, decodedKtx2);
        ktx2Lengths.set(meta.hash, block.u8_bytes);
      } else if (isShaderPayload) {
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
          decodedPayload = decodeTexturePayload(rawPayload, version);
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
      if (isV11) {
        carriedBytes.set(meta.hash, meta.bytes);
        addedSinceTransaction.push(meta.hash);
      }
      resourceRecordCount += 1;
      resourceByteTotal += meta.bytes;
      bytesTotal += decoded.record.byte_length;
      maxRecordBytes = Math.max(maxRecordBytes, decoded.record.byte_length);
      return undefined;
    }

    if (meta.type === "transaction") {
      if (earlyPrune) {
        // Sabotage early-prune (render-stream-11.md decision 10): prune against the BASE state
        // before this transaction is resolved or checked.
        const baseNames = resolvedStateNames(state);
        for (const h of carriedHashes)
          if (!baseNames.has(h)) carriedHashes.delete(h);
      }
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
        ...(isV11
          ? [
              ...checkIdOrdering("multimeshes", meta.multimeshes ?? [], offset),
              ...checkIdListAscendingNoDup(
                "removed_multimeshes",
                meta.removed_multimeshes ?? [],
                offset,
              ),
            ]
          : []),
        ...(isV12
          ? [
              ...checkIdOrdering("particles", meta.particles ?? [], offset),
              ...checkIdListAscendingNoDup(
                "removed_particles",
                meta.removed_particles ?? [],
                offset,
              ),
            ]
          : []),
      ];
      if (idOrderErrors.length > 0) return idOrderErrors;
      // PM1 rule 8: an add_multimesh in a session whose features.ops lacks it.
      if (isV11 && !multimeshOp) {
        for (const it of meta.items)
          for (const c of it.commands ?? [])
            if (c.op === "add_multimesh")
              return [
                `meta-schema: record at offset ${offset}: item ${it.id} carries add_multimesh, which the session's features.ops does not list`,
              ];
      }
      // render-stream-12.md "Session record": a particles key, particle_emits, a pt_f32 block or
      // an add_particles command in a session whose features.ops lacks add_particles.
      if (isV12 && !particlesOp) {
        const what =
          meta.particles !== undefined
            ? 'a "particles" key'
            : meta.removed_particles !== undefined
              ? 'a "removed_particles" key'
              : meta.particle_emits !== undefined
                ? 'a "particle_emits" key'
                : meta.blocks.length > PT_F32_BLOCK
                  ? 'a "pt_f32" block'
                  : meta.items.some((it) =>
                        (it.commands ?? []).some(
                          (c) => c.op === "add_particles",
                        ),
                      )
                    ? "an add_particles command"
                    : null;
        if (what !== null)
          return [
            `meta-schema: record at offset ${offset}: ${what} in a session whose features.ops lacks "add_particles"`,
          ];
      }

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
          // "unsupported", "add_clip_ignore", (/11) "add_multimesh" and (/12) "add_particles"
          // carry no floats and no "f" key at all.
          if (
            command.op === "unsupported" ||
            command.op === "add_clip_ignore" ||
            command.op === "add_multimesh" ||
            command.op === "add_particles"
          )
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
      if (isV11) {
        const meshErrors = checkDynamicMeshes(meta, state, offset);
        if (meshErrors.length > 0) return meshErrors;
        // PM1 (render-stream-11.md "As built (PM1)", 5): the multimesh rules, after the mesh
        // rules; mm-offset generalises W11a's empty-table case (decision 3).
        const mmErrors = checkMultimeshes(
          meta,
          state,
          lastSeenMultimesh,
          ((decoded.record.blocks as number[][])[8] ?? []).length,
          offset,
        );
        if (mmErrors.length > 0) return mmErrors;
      }
      if (isV12) {
        // PM5 (render-stream-12.md "Validators: rule changes"): particles-entry, the JSON half
        // of particles-version, particle-emits and pt-offset, after /11's multimesh rules.
        const ptErrors = checkParticlesPreResolve(
          meta,
          state,
          lastSeenParticles,
          ((decoded.record.blocks as number[][])[PT_F32_BLOCK] ?? []).length,
          offset,
        );
        if (ptErrors.length > 0) return ptErrors;
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
        // P3-TM: the host's shader time is the last float.
        if (meta.shader_time !== undefined) {
          if (meta.shader_time.f !== runningParamOffset)
            return [
              `shader-time: record at offset ${offset}: shader_time f=${meta.shader_time.f}, expected ${runningParamOffset}`,
            ];
          runningParamOffset += 1;
        }
        totalParamFloats = runningParamOffset;
      }
      // backbuffer-offset (render-stream-10.md "Transaction blocks"): a running offset into
      // backbuffer_f32 over items in entry order, canvas_group (2 floats) before
      // copy_to_backbuffer (4 floats) within an item; the block's length is the final count.
      if (isV10) {
        let runningBackbufferOffset = 0;
        for (const it of meta.items) {
          for (const [key, value, width] of [
            ["canvas_group", it.canvas_group, 2],
            ["copy_to_backbuffer", it.copy_to_backbuffer, 4],
          ] as const) {
            if (value === null || value === undefined) continue;
            if (value.f !== runningBackbufferOffset) {
              return [
                `backbuffer-offset: record at offset ${offset}: item ${it.id} ${key} f=${value.f}, expected ${runningBackbufferOffset}`,
              ];
            }
            runningBackbufferOffset += width;
          }
        }
        const declared = meta.blocks.find(
          (b) => b.name === "backbuffer_f32",
        )?.count;
        const decodedLength = (decoded.record.blocks as number[][])[6]?.length;
        if (
          declared !== runningBackbufferOffset ||
          decodedLength !== runningBackbufferOffset
        ) {
          return [
            `backbuffer-offset: record at offset ${offset}: block "backbuffer_f32" declares count ${declared}, expected ${runningBackbufferOffset}`,
          ];
        }
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
        isV11 ? rawRecordBlock(raw, 7) : undefined,
        isV11 ? rawRecordBlock(raw, 8) : undefined,
      );
      if (timer) timer.resolve_us += timer.now() - resolveT0;
      if (isV12) {
        // PM5: resolved, the float half of particles-version, then particles-ref.
        const ptErrors = checkParticlesResolved(
          meta,
          nextState,
          lastSeenParticles,
          offset,
        );
        if (ptErrors.length > 0) return ptErrors;
        for (const p of meta.particles ?? []) {
          const resolvedPt = nextState.particles.get(p.id);
          if (resolvedPt !== undefined) lastSeenParticles.set(p.id, resolvedPt);
        }
      }
      // render-stream-11.md "Patched unsupported": a patch's null stands for the base's list.
      const unsupportedNow =
        meta.unsupported === null ? resolvedUnsupported : meta.unsupported;
      const resolvedErrors = checkResolvedInvariants(
        meta.unsupported === null
          ? { ...meta, unsupported: unsupportedNow }
          : meta,
        nextState,
        offset,
        isV6,
        snapDeclared,
      );
      if (resolvedErrors.length > 0) return resolvedErrors;
      if (isV11 && meta.encoding === "patch") {
        // content-version-stable (render-stream-11.md "Stable content_version", decision 7): a
        // patch entry whose commands equal the base item's resolved commands keeps its version.
        for (const it of meta.items) {
          if (it.commands === null) continue;
          const before = state.items.get(it.id);
          if (
            before === undefined ||
            before.content_version === it.content_version
          )
            continue;
          const after = nextState.items.get(it.id);
          if (
            after !== undefined &&
            jsonBitEqual(after.commands, before.commands)
          ) {
            return [
              `content-version-stable: record at offset ${offset}: item ${it.id}'s content_version moved ${before.content_version} -> ${it.content_version} but its commands equal the base's`,
            ];
          }
        }
      }
      if (isV10) {
        // P3-TM (render-stream-10.md "Shader time"): present exactly when the state reads TIME.
        let reads = false;
        for (const sh of nextState.shaders.values())
          if (sh.status === "ok" && sh.uses.includes("time")) reads = true;
        if (reads !== (meta.shader_time !== undefined))
          return [
            `shader-time: record at offset ${offset}: "shader_time" must be present exactly when the state holds an ok shader that uses time (it reads: ${reads})`,
          ];
      }
      if (isV9) {
        const deliveryErrors = checkDeliveryInvariants(
          nextState,
          sessionMeta.resources.texture_delivery as TextureDeliveryDeclaration,
          offset,
        );
        if (deliveryErrors.length > 0) return deliveryErrors;
      }
      if (isV8) {
        const adoptionErrors = checkAdoptionInvariants(
          nextState,
          sessionMeta.adoption !== null && sessionMeta.adoption !== undefined,
          sessionMeta.resources.decode === "engine",
          offset,
        );
        if (adoptionErrors.length > 0) return adoptionErrors;
      }

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
      for (const m of meta.multimeshes ?? []) {
        const resolvedMm = nextState.multimeshes.get(m.id);
        if (resolvedMm === undefined) continue;
        if (multimeshVersionRegressed(lastSeenMultimesh.get(m.id), resolvedMm)) {
          return [
            `multimesh-version: record at offset ${offset}: multimesh ${m.id}'s version/content is inconsistent with its earlier entry`,
          ];
        }
        lastSeenMultimesh.set(m.id, resolvedMm);
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
        // render-stream-9.md: a variant's payload, when this stream carries it, has the entry's
        // shape. Variants are never required to arrive as resource records.
        for (const v of t.variants ?? []) {
          if (!carriedHashes.has(v.hash)) continue;
          if (v.encoding === "block") {
            const blockShape = resourcePayloadShapes.get(v.hash);
            if (
              blockShape === undefined ||
              blockShape.format !== v.format ||
              blockShape.width !== t.width ||
              blockShape.height !== t.height ||
              blockShape.mipmaps !== t.mipmaps ||
              (resourcePayloadLengths.get(v.hash) ?? -1) !== v.payload_bytes
            ) {
              return [
                `resource-payload: record at offset ${offset}: the resource for block variant ${v.hash} of texture ${t.id} is not a ${v.format} ${t.width}x${t.height} GRT1 payload of ${v.payload_bytes} bytes`,
              ];
            }
          } else {
            const ktx2 = ktx2Shapes.get(v.hash);
            if (ktx2 === undefined) {
              return [
                `resource-payload: record at offset ${offset}: the resource for ${v.encoding} variant ${v.hash} of texture ${t.id} is not a KTX2 file`,
              ];
            }
            const shapeError = checkKtx2Shape(
              ktx2,
              v.encoding,
              t.width,
              t.height,
              t.mipmaps,
            );
            if (shapeError !== null) {
              return [
                `${shapeError} (record at offset ${offset}, texture ${t.id})`,
              ];
            }
            if ((ktx2Lengths.get(v.hash) ?? -1) !== v.payload_bytes) {
              return [
                `ktx2-shape: record at offset ${offset}: texture ${t.id}'s ${v.encoding} variant declares ${v.payload_bytes} bytes, the file has ${ktx2Lengths.get(v.hash)}`,
              ];
            }
          }
        }
      }
      if (isV4) {
        for (const m of sortedResolvedMeshes(nextState)) {
          if (m.status !== "ok") continue;
          for (const s of m.surfaces) {
            // render-stream-11.md: a dynamic surface's bytes travel in mesh_u8, never as a record.
            if (isV11 && surfaceIsDynamic(s)) continue;
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

      // resource-unnamed (render-stream-11.md "Rules", decision 6): every record accepted since the
      // previous transaction names a hash this state names.
      const names = isV11 ? resolvedStateNames(nextState) : null;
      if (names !== null) {
        for (const h of addedSinceTransaction) {
          if (!names.has(h)) {
            return [
              `resource-unnamed: record at offset ${offset}: the resource record for hash ${h} precedes a transaction whose state does not name it`,
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

      // TAG1 item-meta-id: every pending row names an item of the target state.
      if (imPending !== null) {
        const missing = imPending.items.find(
          (row) => !nextState.items.has(row[0] as number),
        );
        if (missing !== undefined)
          return [
            `item-meta-id: record at offset ${offset}, transaction seq ${meta.seq}: the item_meta record before it has a row for item ${missing[0]}, which its target state does not hold`,
          ];
        if (imPending.form === "full") {
          imTable.grant = imPending.grant;
          imTable.strings = [...imPending.strings];
          imTable.rows.clear();
        } else {
          imTable.strings.push(...imPending.strings);
        }
        for (const row of imPending.items)
          imTable.rows.set(row[0] as number, row.length === 1 ? null : row.slice(1));
        imPending = null;
      }
      if (imTable.rows.size > 0 && meta.encoding !== "full")
        for (const id of meta.removed_items) imTable.rows.delete(id);
      state = nextState;
      if (names !== null) {
        // The prune: C <- C ∩ names(S), after S's own checks.
        for (const h of carriedHashes) {
          if (!names.has(h)) {
            carriedHashes.delete(h);
            carriedBytes.delete(h);
          }
        }
        addedSinceTransaction.length = 0;
        resolvedUnsupported = unsupportedNow;
      }
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
    const orphan = imOrphan(offset, "the end record");
    if (orphan) return orphan;
    if (isV11 && addedSinceTransaction.length > 0) {
      return [
        `resource-unnamed: end record at offset ${offset}: ${addedSinceTransaction.length} resource record(s) follow the last transaction (first: hash ${addedSinceTransaction[0]})`,
      ];
    }
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
    itemMeta: () => imTable,
    itemMetaPending: () => imPending,
    checkInlineFetch: (hash: string): string | null => {
      if (!isV11) return null;
      const nameBytes = nonVariantNameBytes(state, hash);
      if (nameBytes !== undefined && nameBytes <= inlineMaxBytes) {
        return `inline-fetch-zero: hash ${hash} is a name of the newest accepted state with payload_bytes ${nameBytes} <= inline_max_bytes ${inlineMaxBytes}`;
      }
      const recordBytes = carriedBytes.get(hash);
      if (
        carriedHashes.has(hash) &&
        recordBytes !== undefined &&
        recordBytes <= inlineMaxBytes
      ) {
        return `inline-fetch-zero: hash ${hash} is in the carried set (a ${recordBytes}-byte record, <= inline_max_bytes ${inlineMaxBytes})`;
      }
      return null;
    },
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
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 = 6,
  options?: RecordingValidatorOptions,
): string[] {
  const split = splitRecords(data, version);
  if (split.errors.length > 0) return [split.errors[0]];
  const validator = createRecordingValidator(split.records, version, options);
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
          (meta.removed_materials?.length ?? 0) > 0)) ||
      (meta.removed_multimeshes?.length ?? 0) > 0 ||
      (meta.removed_particles?.length ?? 0) > 0
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

  // PM1 rule 9: removed_multimeshes are ids of the base table, never also in multimeshes.
  const removedMultimeshSet = new Set<number>();
  for (const id of meta.removed_multimeshes ?? []) {
    if (removedMultimeshSet.has(id)) {
      return [
        `patch-removed: record at offset ${offset}: multimesh ${id} is removed twice`,
      ];
    }
    removedMultimeshSet.add(id);
    if (!baseState.multimeshes.has(id)) {
      return [
        `patch-removed: record at offset ${offset}: removed multimesh ${id} is absent from the base`,
      ];
    }
  }
  for (const m of meta.multimeshes ?? []) {
    if (removedMultimeshSet.has(m.id)) {
      return [
        `patch-removed: record at offset ${offset}: multimesh ${m.id} is both removed and present`,
      ];
    }
  }
  // render-stream-12.md "Particles table": removed_particles are ids of the base table, never
  // also in particles.
  const removedParticlesSet = new Set<number>();
  for (const id of meta.removed_particles ?? []) {
    removedParticlesSet.add(id);
    if (!baseState.particles.has(id)) {
      return [
        `patch-removed: record at offset ${offset}: removed particles ${id} is absent from the base`,
      ];
    }
  }
  for (const p of meta.particles ?? []) {
    if (removedParticlesSet.has(p.id)) {
      return [
        `patch-removed: record at offset ${offset}: particles ${p.id} is both removed and present`,
      ];
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
    /** P3-TM: /10's host shader time, present only when the state reads TIME. */
    shader_time?: number;
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
    /** new at /11 (PM1, 10): present only when the multimesh table is non-empty. */
    multimeshes?: ResolvedMultimesh[];
    /** new at /12 (PM5, "Resolved form"): present only when the particles table is non-empty,
     * right after "multimeshes". */
    particles?: ResolvedParticles[];
  };
}

export interface ResolvedResource {
  hash: string;
  bytes: number;
  record_index: number;
  /** new at /11 (golden-11 index.json "inline_resources"): the seq of the transaction the record
   * precedes, since a hash may be carried more than once (render-stream-11.md decision 2). */
  before_seq?: number;
}

export interface ResolvedRecording {
  schema:
    | "render-stream-2-resolved/1"
    | "render-stream-3-resolved/1"
    | "render-stream-4-resolved/1"
    | "render-stream-5-resolved/1"
    | "render-stream-6-resolved/1"
    | "render-stream-7-resolved/1"
    | "render-stream-8-resolved/1"
    | "render-stream-9-resolved/1"
    | "render-stream-10-resolved/1"
    | "render-stream-11-resolved/1"
    | "render-stream-12-resolved/1"
    | "render-stream-13-resolved/1";
  session_id: string;
  stream_id: string;
  transactions: ResolvedTransaction[];
  resources: ResolvedResource[];
}

export function resolveRecording(
  data: Uint8Array,
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 = 6,
): ResolvedRecording {
  const decoded = decodeRecording(data, version);
  const sessionRecord = decoded.records[0];
  if (sessionRecord.meta.type !== "session")
    throw new Error("missing-session: the first record is not a session");
  const sessionMeta = sessionRecord.meta;
  const isV11 = version === 11 || version === 12 || version === 13;
  // /11 reads each transaction's raw mesh_u8 block (body_sha256), which the decoded form drops;
  // /13 its reconstructed /12 block.
  const raws = isV11 ? splitRecords(data, version).records : [];
  const plainRaws = version === 13 ? rs13PlainRecords(raws) : raws;

  let state = emptyResolvedState();
  const transactions: ResolvedTransaction[] = [];
  const resources: ResolvedResource[] = [];
  const pendingResources: ResolvedResource[] = [];
  const lastItems = new Map<number, ResolvedItem>();
  let unsupported: TransactionMeta["unsupported"] = [];
  for (let i = 1; i < decoded.records.length; i++) {
    const record = decoded.records[i];
    const meta = record.meta;
    if (meta.type === "resource") {
      const entry = { hash: meta.hash, bytes: meta.bytes, record_index: i };
      resources.push(entry);
      if (isV11) pendingResources.push(entry);
      continue;
    }
    if (meta.type !== "transaction") continue;
    for (const entry of pendingResources.splice(0)) entry.before_seq = meta.seq;
    state = applyTransaction(
      state,
      meta,
      record.blocks as number[][],
      isV11 ? rawRecordBlock(plainRaws[i], 7) : undefined,
      isV11 ? rawRecordBlock(plainRaws[i], 8) : undefined,
    );
    // render-stream-11.md "Patched unsupported": a patch's null resolves to the base's list.
    if (meta.unsupported !== null) unsupported = meta.unsupported;
    transactions.push({
      seq: meta.seq,
      frame: meta.frame,
      encoding: meta.encoding,
      state: {
        status: meta.status,
        failures: meta.failures,
        unsupported,
        ...(meta.unknown_items !== undefined
          ? { unknown_items: meta.unknown_items }
          : {}),
        ...(meta.shader_time !== undefined
          ? {
              shader_time: (record.blocks as number[][])[5][meta.shader_time.f],
            }
          : {}),
        default_texture_filter: meta.default_texture_filter,
        default_texture_repeat: meta.default_texture_repeat,
        canvases: sortedResolvedCanvases(state),
        items: internItems(sortedResolvedItems(state), lastItems),
        textures: sortedResolvedTextures(state),
        ...(version >= 4 ? { meshes: sortedResolvedMeshes(state) } : {}),
        ...(version >= 5
          ? {
              shaders: sortedResolvedShaders(state),
              materials: sortedResolvedMaterials(state),
            }
          : {}),
        ...(state.multimeshes.size > 0
          ? { multimeshes: sortedResolvedMultimeshes(state) }
          : {}),
        ...(state.particles.size > 0
          ? { particles: sortedResolvedParticles(state) }
          : {}),
      },
    });
  }
  return {
    schema:
      version === 13
        ? "render-stream-13-resolved/1"
        : version === 12
        ? "render-stream-12-resolved/1"
        : version === 11
        ? "render-stream-11-resolved/1"
        : version === 10
          ? "render-stream-10-resolved/1"
          : version === 9
            ? "render-stream-9-resolved/1"
            : version === 8
              ? "render-stream-8-resolved/1"
              : version === 7
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
