// render-stream/2 wire decoder, validator and resolver: pure over Uint8Array, no file or network
// I/O. render-stream/2 is render-stream/1 plus textures.
//
// The wire format (record framing, the new u8 block type, canonical JSON key order, float32 LE
// blocks, the render-stream-texture/1 payload format) is specified in
// ../../protocol/render-stream-2.md, which extends render-stream-1.md and, through it,
// render-stream-0.md. This must agree with it byte for byte, and with the C++ encoder/diff
// (../../capture/src/rs2_codec.cpp, rs2_diff.cpp) and the GDScript decoder
// (../../receiver/rs2_decoder.gd, rs_texture_payload.gd). The golden vectors in
// ../../protocol/golden-2/ are shared by all three.
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

import { createHash } from "node:crypto";

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
  | "canvas-texture-headless";
/** canvas-texture-headless (G2d): a texture draw naming RID() on a headless host, whose dummy
 * storage never allocates a canvas texture (protocol/canvas-texture-headless.md). */
export type UnsupportedCmdReason =
  | "unsupported-op"
  | "unknown-texture"
  | "canvas-texture-headless";
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
  | "unpin";
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
export type RootSizePolicy = "observe" | "enforce-min-size";
export type HostSizeStatus =
  | "match"
  | "degenerate-visible"
  | "degenerate-window";

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

export interface BlockDescriptor {
  name: string;
  type: "f32" | "u8";
  count: number;
}

export interface ResourcesMeta {
  hash: "sha256";
  payload: string;
  delivery: Delivery;
  inline_max_bytes: number;
  max_payload_bytes: number;
  permitted_formats: string[];
  fetch: Fetch;
  http_path: string | null;
  auth: Auth;
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
    host_size_status: HostSizeStatus;
    host_window_size: [number, number];
  };
  resources: ResourcesMeta;
  features: {
    ops: string[];
    item_state: string[];
    resources: string[];
    /** G2d: resource kinds the host refuses, sorted by resource (a headless host:
     * canvas_texture, canvas-texture-headless). */
    unsupported_resources: Array<{ resource: string; reason: string }>;
    observed_unsupported_ops: string[];
    unobserved: string[];
    publication: string;
  };
  sabotage: { kind: SabotageKind; frame: number; op: string | null } | null;
  blocks: BlockDescriptor[];
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
export interface CommandUnsupported {
  op: "unsupported";
  name: string;
  reason: UnsupportedCmdReason;
}
export type Command =
  | CommandAddRect
  | CommandAddTextureRect
  | CommandAddTextureRectRegion
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
  content_version: number;
  commands: Command[] | null;
}

export interface TransactionCanvas {
  id: number;
  origin: Origin;
  role: CanvasRole;
  attached: boolean;
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
  default_texture_filter: Filter;
  default_texture_repeat: Repeat;
  removed_canvases: number[];
  removed_items: number[];
  removed_textures: number[];
  canvases: TransactionCanvas[];
  items: TransactionItem[];
  textures: TransactionTexture[];
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
const STRETCH_KEYS = ["mode", "aspect", "scale_mode"];
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
const FEATURES_KEYS = [
  "ops",
  "item_state",
  "resources",
  "unsupported_resources",
  "observed_unsupported_ops",
  "unobserved",
  "publication",
];
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
const FAILURE_KEYS = ["reason", "detail"];
const UNSUPPORTED_KEYS = ["op", "item", "reason"];
const CANVAS_KEYS = ["id", "origin", "role", "attached", "items"];
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
const PARENT_KEYS = ["kind", "id"];
const ADD_RECT_KEYS = ["op", "aa", "f"];
const ADD_TEXTURE_RECT_KEYS = ["op", "tex", "tile", "transpose", "f"];
const ADD_TEXTURE_RECT_REGION_KEYS = ["op", "tex", "transpose", "clip_uv", "f"];
const UNSUPPORTED_CMD_KEYS = ["op", "name", "reason"];
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
] as const;

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

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesToAscii(bytes: Uint8Array): string | null {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x20 || b > 0x7e) return null;
    out += String.fromCharCode(b);
  }
  return out;
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
      (entry.type !== "f32" && entry.type !== "u8") ||
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
): string | null {
  if (blocks.length !== names.length) {
    return `meta-schema: record at offset ${offset}: expected ${names.length} blocks (${names.join(", ")}), got ${blocks.length}`;
  }
  for (let i = 0; i < names.length; i++) {
    if (blocks[i].name !== names[i]) {
      return `meta-schema: record at offset ${offset}: block ${i} is named "${blocks[i].name}", expected "${names[i]}"`;
    }
    if (blocks[i].type !== "f32") {
      return `meta-schema: record at offset ${offset}: block "${blocks[i].name}" has type "${blocks[i].type}", expected "f32"`;
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

function checkResourcesSchema(resources: unknown, offset: number): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: resources ${detail}`,
  ];
  if (!isPlainObject(resources) || !hasExactKeys(resources, RESOURCES_KEYS)) {
    return err("has the wrong keys");
  }
  if (resources.hash !== "sha256") return err('"hash" must be "sha256"');
  if (typeof resources.payload !== "string")
    return err('"payload" is not a string');
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
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: ${detail}`,
  ];
  if (!hasExactKeys(meta, SESSION_KEYS))
    return err("session has the wrong top-level keys or order");
  if (meta.protocol !== "render-stream/2")
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
  if (!isPlainObject(viewport) || !hasExactKeys(viewport, VIEWPORT_KEYS)) {
    return err('"viewport" has the wrong keys');
  }
  if (
    !isInt(viewport.canvas_cull_mask) ||
    !isInt(viewport.root_canvas) ||
    !intPair(viewport.logical_size) ||
    !intPair(viewport.host_window_size) ||
    !isOneOf(viewport.stretch_applied_by, ["receiver"] as const) ||
    !isOneOf(viewport.root_size_policy, [
      "observe",
      "enforce-min-size",
    ] as const) ||
    !isOneOf(viewport.host_size_status, [
      "match",
      "degenerate-visible",
      "degenerate-window",
    ] as const)
  ) {
    return err('"viewport" has an invalid field');
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

  const resourcesErr = checkResourcesSchema(meta.resources, offset);
  if (resourcesErr.length > 0) return resourcesErr;

  const features = meta.features;
  if (
    !isPlainObject(features) ||
    !hasExactKeys(features, FEATURES_KEYS) ||
    !isStringArray(features.ops) ||
    !isStringArray(features.item_state) ||
    !isStringArray(features.resources) ||
    !isUnsupportedResources(features.unsupported_resources) ||
    !isStringArray(features.observed_unsupported_ops) ||
    !isStringArray(features.unobserved) ||
    typeof features.publication !== "string"
  ) {
    return err('"features" has the wrong keys or an invalid field');
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

function checkTransactionSchema(
  meta: Record<string, unknown>,
  offset: number,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: ${detail}`,
  ];
  if (!hasExactKeys(meta, TRANSACTION_KEYS))
    return err("transaction has the wrong top-level keys or order");
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
    const allowedReasons =
      u.item === null ? SESSION_UNSUPPORTED_REASONS : ITEM_UNSUPPORTED_REASONS;
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

  if (!Array.isArray(meta.canvases)) return err('"canvases" is not an array');
  for (const c of meta.canvases) {
    if (
      !isPlainObject(c) ||
      !hasExactKeys(c, CANVAS_KEYS) ||
      !isInt(c.id) ||
      !isOneOf(c.origin, ["created", "root-query", "adopted"] as const) ||
      !(c.role === "root" || c.role === null) ||
      typeof c.attached !== "boolean" ||
      !isIntArray(c.items)
    ) {
      return err("a canvases[] entry is malformed");
    }
  }

  if (!Array.isArray(meta.items)) return err('"items" is not an array');
  for (const it of meta.items) {
    if (
      !isPlainObject(it) ||
      !hasExactKeys(it, ITEM_KEYS) ||
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

  const blocksError = checkBlocksField(meta.blocks, offset);
  if (blocksError !== null) return [blocksError];
  const nameError = checkFixedBlockNames(
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

function checkMetaSchema(meta: unknown, offset: number): string[] {
  if (!isPlainObject(meta))
    return [
      `meta-schema: record at offset ${offset}: meta is not a JSON object`,
    ];
  if (meta.type === "session") return checkSessionSchema(meta, offset);
  if (meta.type === "transaction") return checkTransactionSchema(meta, offset);
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

export function splitRecords(data: Uint8Array): {
  records: RawRecord[];
  errors: string[];
} {
  if (
    data.length < MAGIC.length ||
    !bytesEqual(data.subarray(0, MAGIC.length), MAGIC)
  ) {
    const got = toHex(data.subarray(0, Math.min(MAGIC.length, data.length)));
    return {
      records: [],
      errors: [`bad-magic: expected ${toHex(MAGIC)}, got ${got}`],
    };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records: RawRecord[] = [];
  let pos = MAGIC.length;
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
  sha256: string;
  meta: Rs2Meta;
  blocks: DecodedBlock[];
}

export function decodeRecord(raw: RawRecord): {
  record?: DecodedRecord;
  errors: string[];
} {
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

  const schemaErrors = checkMetaSchema(meta, raw.offset);
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
      descriptor.type === "f32" ? 4 * descriptor.count : descriptor.count;
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
      const floats: number[] = [];
      for (let f = 0; f < descriptor.count; f++)
        floats.push(view.getFloat32(pos + f * 4, true));
      blocks.push(floats);
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
      sha256: hashBytes(raw.bytes),
      meta: meta as Rs2Meta,
      blocks,
    },
    errors: [],
  };
}

// --------------------------------------------------------------------------------------- decodeRecording

export function decodeRecording(data: Uint8Array): {
  schema: "render-stream-2-decoded/1";
  magic: string;
  records: DecodedRecord[];
} {
  const split = splitRecords(data);
  if (split.errors.length > 0) throw new Error(split.errors[0]);
  const records: DecodedRecord[] = [];
  for (const raw of split.records) {
    const decoded = decodeRecord(raw);
    if (decoded.errors.length > 0 || decoded.record === undefined) {
      throw new Error(
        decoded.errors[0] ??
          `decodeRecord produced no record at offset ${raw.offset}`,
      );
    }
    records.push(decoded.record);
  }
  return { schema: "render-stream-2-decoded/1", magic: toHex(MAGIC), records };
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
    | "unsupported";
  aa?: boolean;
  tex?: number | null;
  tile?: boolean;
  transpose?: boolean;
  clip_uv?: boolean;
  rect?: [number, number, number, number];
  src?: [number, number, number, number];
  color?: [number, number, number, number];
  modulate?: [number, number, number, number];
  name?: string;
  reason?: UnsupportedCmdReason;
}

export interface ResolvedCanvas {
  id: number;
  origin: Origin;
  role: CanvasRole;
  attached: boolean;
  items: number[];
  xform: [number, number, number, number, number, number];
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
  content_version: number;
  xform: [number, number, number, number, number, number];
  modulate: [number, number, number, number];
  self_modulate: [number, number, number, number];
  custom_rect_rect: [number, number, number, number];
  commands: ResolvedCommand[];
}

export type ResolvedTexture = TransactionTexture;

export interface ResolvedState {
  canvases: Map<number, ResolvedCanvas>;
  items: Map<number, ResolvedItem>;
  textures: Map<number, ResolvedTexture>;
  default_texture_filter: Filter;
  default_texture_repeat: Repeat;
}

export function emptyResolvedState(): ResolvedState {
  return {
    canvases: new Map(),
    items: new Map(),
    textures: new Map(),
    default_texture_filter: "nearest",
    default_texture_repeat: "disabled",
  };
}

function liftCanvas(c: TransactionCanvas, xform: number[]): ResolvedCanvas {
  return {
    id: c.id,
    origin: c.origin,
    role: c.role,
    attached: c.attached,
    items: c.items,
    xform: xform as [number, number, number, number, number, number],
  };
}

function liftCommand(cmd: Command, cmdF32: number[]): ResolvedCommand {
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
  return { op: "unsupported", name: cmd.name, reason: cmd.reason };
}

function commandFloatCount(cmd: Command): number {
  if (cmd.op === "add_rect" || cmd.op === "add_texture_rect") return 8;
  if (cmd.op === "add_texture_rect_region") return 12;
  return 0;
}

function liftItem(
  it: TransactionItem,
  itemF32: number[],
  cmdF32: number[],
): ResolvedItem {
  return {
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
        : it.commands.map((c) => liftCommand(c, cmdF32)),
  };
}

// Applies one decoded transaction to `base`, per render-stream-2.md "Full and patch transactions":
// textures are treated like items (full table on a full transaction, upsert+remove on a patch),
// but every texture entry is complete on the wire (no null-commands-style partial form).
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
  if (meta.encoding === "patch") {
    for (const id of meta.removed_canvases) canvases.delete(id);
    for (const id of meta.removed_items) items.delete(id);
    for (const id of meta.removed_textures) textures.delete(id);
  }
  const [itemF32, canvasF32, cmdF32] = blocks;
  for (let i = 0; i < meta.canvases.length; i++) {
    const c = meta.canvases[i];
    canvases.set(c.id, liftCanvas(c, canvasF32.slice(i * 6, i * 6 + 6)));
  }
  for (let i = 0; i < meta.items.length; i++) {
    const raw = meta.items[i];
    const lifted = liftItem(raw, itemF32.slice(i * 18, i * 18 + 18), cmdF32);
    if (raw.commands === null) {
      const prev = base.items.get(raw.id);
      lifted.commands = prev ? prev.commands : [];
    }
    items.set(raw.id, lifted);
  }
  for (const t of meta.textures) {
    textures.set(t.id, t);
  }
  return {
    canvases,
    items,
    textures,
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

function checkResolvedInvariants(
  meta: TransactionMeta,
  state: ResolvedState,
  offset: number,
): string[] {
  const where = `transaction seq ${meta.seq}`;
  const canvases = sortedResolvedCanvases(state);
  const items = sortedResolvedItems(state);
  const textures = sortedResolvedTextures(state);
  const canvasIds = new Set(canvases.map((c) => c.id));
  const itemIds = new Set(items.map((i) => i.id));
  const textureIds = new Set(textures.map((t) => t.id));
  const textureById = new Map(textures.map((t) => [t.id, t] as const));

  for (const t of textures) {
    const fieldErrors = textureEntryFieldErrors(t, offset);
    if (fieldErrors.length > 0) return fieldErrors;
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
  for (const item of items) {
    for (const command of item.commands) {
      if (
        (command.op === "add_texture_rect" ||
          command.op === "add_texture_rect_region") &&
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

  // Expected derived unsupported[] entries: unsupported-op / unknown-texture (one per distinct
  // (item, op) pair with a matching command-level `unsupported` entry) and unsupported-texture
  // (one per distinct (item, op) pair whose texture-rect command names an unsupported entry).
  const actualUnsupportedOps = new Map<string, UnsupportedReason>();
  const actualUnsupportedTexture = new Set<string>();
  for (const item of items) {
    const seenOps = new Set<string>();
    for (const command of item.commands) {
      if (command.op === "unsupported" && command.name !== undefined) {
        if (!seenOps.has(command.name)) {
          seenOps.add(command.name);
          const reason: UnsupportedReason =
            command.reason === "unknown-texture" ||
            command.reason === "canvas-texture-headless"
              ? command.reason
              : "unsupported-op";
          actualUnsupportedOps.set(`${item.id}:${command.name}`, reason);
        }
      }
      if (
        (command.op === "add_texture_rect" ||
          command.op === "add_texture_rect_region") &&
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
          // The derived entry's `op` is the RenderingServer method name
          // (canvas_item_add_texture_rect[_region]), not the wire command's own op.
          const rsMethod =
            command.op === "add_texture_rect"
              ? "canvas_item_add_texture_rect"
              : "canvas_item_add_texture_rect_region";
          actualUnsupportedTexture.add(`${item.id}:${rsMethod}`);
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
  for (const entry of meta.unsupported) {
    if (entry.item === null) {
      if (itemLevelStarted) {
        return [
          `unsupported-mismatch: ${where}: session-level entry ${entry.op} follows an item-level entry`,
        ];
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
      entry.reason === "canvas-texture-headless"
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
      if (entry.op !== "canvas_item_set_material") {
        return [
          `unsupported-mismatch: ${where}: unsupported-state entry for item ${entry.item} names ${entry.op}, expected canvas_item_set_material`,
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
        `unsupported-mismatch: ${where}: texture-rect command (${pair.replace(":", ", ")}) names an unsupported texture, with no unsupported-texture entry`,
      ];
    }
  }

  return [];
}

// --------------------------------------------------------------------------------------- validateRecording

export function validateRecording(data: Uint8Array): string[] {
  const split = splitRecords(data);
  if (split.errors.length > 0) return [split.errors[0]];
  if (split.records.length === 0)
    return ["missing-session: the recording has no records"];

  const first = decodeRecord(split.records[0]);
  if (first.errors.length > 0 || first.record === undefined)
    return [first.errors[0]];
  const sessionMeta = first.record.meta;
  if (sessionMeta.type !== "session")
    return [`missing-session: the first record has type "${sessionMeta.type}"`];
  if (sessionMeta.viewport.root_canvas !== 1) {
    return [
      `root-canvas: session.viewport.root_canvas is ${sessionMeta.viewport.root_canvas}, not 1`,
    ];
  }
  const inlineMaxBytes = sessionMeta.resources.inline_max_bytes;

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
  const maxIdSeen = { canvas: 0, item: 0, texture: 0 };
  const carriedHashes = new Set<string>();
  const lastSeenTexture = new Map<number, TransactionTexture>();
  // Resource payload shapes seen so far in THIS call, used to check resource-payload once a
  // texture entry naming the hash is known. Local to this call: validateRecording() may run
  // repeatedly (e.g. once per golden vector) and must not leak state between calls.
  const resourcePayloadShapes = new Map<string, DecodedTexturePayload>();
  const resourcePayloadLengths = new Map<string, number>();
  let endSeen = false;

  for (let i = 1; i < split.records.length; i++) {
    const decoded = decodeRecord(split.records[i]);
    if (decoded.errors.length > 0 || decoded.record === undefined)
      return [decoded.errors[0]];
    const meta = decoded.record.meta;
    const offset = split.records[i].offset;

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
      let decodedPayload: DecodedTexturePayload;
      try {
        decodedPayload = decodeTexturePayload(
          rawResourcePayload(split.records[i]),
        );
      } catch (e) {
        return [(e as Error).message];
      }
      const actualHash = block.sha256;
      if (actualHash !== meta.hash) {
        return [
          `resource-hash: record at offset ${offset}: payload sha256 ${actualHash} disagrees with declared hash ${meta.hash}`,
        ];
      }
      carriedHashes.add(meta.hash);
      resourceRecordCount += 1;
      resourceByteTotal += meta.bytes;
      bytesTotal += decoded.record.byte_length;
      maxRecordBytes = Math.max(maxRecordBytes, decoded.record.byte_length);
      // resource-payload is checked once every texture entry naming this hash is known: deferred
      // to the per-transaction texture pass below, via a stored decoded shape.
      resourcePayloadShapes.set(meta.hash, decodedPayload);
      // payload_bytes is the whole payload's length (render-stream-2.md "Texture"), not its data.
      resourcePayloadLengths.set(meta.hash, block.u8_bytes);
      continue;
    }

    if (meta.type === "transaction") {
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
      );
      if (patchErrors.length > 0) return patchErrors;
      if (meta.frame <= prevFrame) {
        return [
          `frame-order: record at offset ${offset}: frame ${meta.frame} does not increase from ${prevFrame}`,
        ];
      }

      // cmd-offset / block-count: against this record's OWN lists.
      let runningOffset = 0;
      let totalCmdFloats = 0;
      for (const item of meta.items) {
        if (item.commands === null) continue;
        for (const command of item.commands) {
          if (command.op === "unsupported") continue;
          const floatCount = commandFloatCount(command);
          if (command.f !== runningOffset) {
            return [
              `cmd-offset: record at offset ${offset}: ${command.op} f=${command.f}, expected ${runningOffset}`,
            ];
          }
          runningOffset += floatCount;
          totalCmdFloats += floatCount;
        }
      }
      const blockByName = new Map(
        meta.blocks.map((b) => [b.name, b.count] as const),
      );
      const expectedBlocks: Array<[string, number]> = [
        ["item_f32", 18 * meta.items.length],
        ["canvas_f32", 6 * meta.canvases.length],
        ["cmd_f32", totalCmdFloats],
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

      const [itemF32, canvasF32] = decoded.record.blocks as number[][];
      if (
        itemF32.length !== 18 * meta.items.length ||
        canvasF32.length !== 6 * meta.canvases.length
      ) {
        return [
          `block-count: record at offset ${offset}: decoded block lengths disagree with items/canvases counts`,
        ];
      }
      const nextState = applyTransaction(
        state,
        meta,
        decoded.record.blocks as number[][],
      );
      const resolvedErrors = checkResolvedInvariants(meta, nextState, offset);
      if (resolvedErrors.length > 0) return resolvedErrors;

      // texture-version, across the whole stream so far.
      for (const t of meta.textures) {
        const previous = lastSeenTexture.get(t.id);
        if (textureVersionRegressed(previous, t)) {
          return [
            `texture-version: record at offset ${offset}: texture ${t.id}'s version/content is inconsistent with its earlier entry`,
          ];
        }
        lastSeenTexture.set(t.id, t);
      }

      // resource-missing / resource-payload, over the RESOLVED table (every ok image entry).
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

      // id-reused: resolved ids this transaction vs. the previous one.
      const currentCanvasIds = new Set(nextState.canvases.keys());
      const currentItemIds = new Set(nextState.items.keys());
      const currentTextureIds = new Set(nextState.textures.keys());
      const previousCanvasIds = new Set(state.canvases.keys());
      const previousItemIds = new Set(state.items.keys());
      const previousTextureIds = new Set(state.textures.keys());
      for (const [kind, currentIds, previousIds] of [
        ["canvas", currentCanvasIds, previousCanvasIds] as const,
        ["item", currentItemIds, previousItemIds] as const,
        ["texture", currentTextureIds, previousTextureIds] as const,
      ]) {
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
      continue;
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
    if (i !== split.records.length - 1) {
      return [
        `trailing-bytes: data follows the end record at offset ${offset}`,
      ];
    }
    endSeen = true;
  }

  if (!endSeen)
    return ["recording-incomplete: the recording ends without an end record"];
  return [];
}

function checkPatchRules(
  meta: TransactionMeta,
  offset: number,
  isFirstTransaction: boolean,
  prevSeq: number,
  sessionEncoding: Encoding,
  baseState: ResolvedState,
): string[] {
  if (meta.encoding === "full") {
    if (
      meta.base_seq !== null ||
      meta.removed_canvases.length > 0 ||
      meta.removed_items.length > 0 ||
      meta.removed_textures.length > 0
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
    default_texture_filter: Filter;
    default_texture_repeat: Repeat;
    canvases: ResolvedCanvas[];
    items: ResolvedItem[];
    textures: ResolvedTexture[];
  };
}

export interface ResolvedResource {
  hash: string;
  bytes: number;
  record_index: number;
}

export interface ResolvedRecording {
  schema: "render-stream-2-resolved/1";
  session_id: string;
  stream_id: string;
  transactions: ResolvedTransaction[];
  resources: ResolvedResource[];
}

export function resolveRecording(data: Uint8Array): ResolvedRecording {
  const decoded = decodeRecording(data);
  const sessionRecord = decoded.records[0];
  if (sessionRecord.meta.type !== "session")
    throw new Error("missing-session: the first record is not a session");
  const sessionMeta = sessionRecord.meta;

  let state = emptyResolvedState();
  const transactions: ResolvedTransaction[] = [];
  const resources: ResolvedResource[] = [];
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
        default_texture_filter: meta.default_texture_filter,
        default_texture_repeat: meta.default_texture_repeat,
        canvases: sortedResolvedCanvases(state),
        items: sortedResolvedItems(state),
        textures: sortedResolvedTextures(state),
      },
    });
  }
  return {
    schema: "render-stream-2-resolved/1",
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
  return JSON.stringify(froundDeep(a)) === JSON.stringify(froundDeep(b));
}

// --------------------------------------------------------------------------------------- recordSha256

export function recordSha256(data: Uint8Array, offset: number): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const recordLen = view.getUint32(offset, true);
  return hashBytes(data.subarray(offset, offset + 4 + recordLen));
}
