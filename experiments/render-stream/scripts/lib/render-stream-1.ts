// render-stream/1 wire decoder, validator and resolver: pure over Uint8Array, no file or network
// I/O.
//
// The wire format (record framing, canonical JSON key order, float32 LE blocks) is specified in
// ../../protocol/render-stream-1.md, which extends render-stream-0.md (framing, canonical-JSON
// rules and the record sha256 definition are unchanged -- see ../../protocol/render-stream-0.md
// and render-stream-0.ts). This must agree with it byte for byte, and with the C++ encoder/diff
// (../../capture/src/rs1_codec.cpp, rs1_diff.cpp) and the GDScript decoder
// (../../receiver/rs1_decoder.gd). The golden vectors in ../../protocol/golden-1/ are shared by
// all three.
//
// splitRecords() / decodeRecord() / decodeRecording() mirror render-stream-0.ts, extended for the
// /1 session/transaction/end shapes (stream identity, root geometry, encoding, base_seq,
// removed_*, two new item fields, richer end stats).
//
// validateRecording() additionally resolves every transaction against a running "resolved state"
// (the merge render-stream-1.md "Resolution" describes) so it can check invariants that only make
// sense against the full picture: dangling parents, child-list agreement, parent cycles,
// draw-index ties (invariant 9), and the unsupported[] list, none of which a patch's small entry
// list can be checked against on its own. resolveRecording() reuses the same merge engine to
// produce the "render-stream-1-resolved/1" shape render-stream-1.md "Decoded and resolved forms"
// describes.

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
  | "degenerate-host-size";
export type SabotageKind =
  | "freeze-frame"
  | "omit-update"
  | "perturb-transform"
  | "omit-op"
  | "patch-drop-item"
  | "drop-message"
  | "ignore-credit"
  | "stale-coalesce";
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

export interface BlockDescriptor {
  name: string;
  type: "f32";
  count: number;
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
  features: {
    ops: string[];
    item_state: string[];
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
export interface CommandUnsupported {
  op: "unsupported";
  name: string;
}
export type Command = CommandAddRect | CommandUnsupported;

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
  removed_canvases: number[];
  removed_items: number[];
  canvases: TransactionCanvas[];
  items: TransactionItem[];
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
  };
  blocks: BlockDescriptor[];
}

export type Rs1Meta = SessionMeta | TransactionMeta | EndMeta;

// --------------------------------------------------------------------------------------- constants

export const MAGIC: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x31, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const SESSION_KEYS = [
  "type",
  "protocol",
  "session_id",
  "stream",
  "engine",
  "capture",
  "viewport",
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
const FEATURES_KEYS = [
  "ops",
  "item_state",
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
  "removed_canvases",
  "removed_items",
  "canvases",
  "items",
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
  "content_version",
  "commands",
];
const PARENT_KEYS = ["kind", "id"];
const ADD_RECT_KEYS = ["op", "aa", "f"];
const UNSUPPORTED_CMD_KEYS = ["op", "name"];

const END_KEYS = ["type", "transactions", "reason", "stats", "blocks"];
const STATS_KEYS = [
  "bytes_total",
  "encode_ns_total",
  "snapshot_ns_total",
  "diff_ns_total",
  "max_record_bytes",
  "full_transactions",
  "patch_transactions",
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
      entry.type !== "f32" ||
      !isInt(entry.count) ||
      entry.count < 0
    ) {
      return `meta-schema: record at offset ${offset}: a blocks[] entry has an invalid field`;
    }
  }
  return null;
}

// A record type's blocks are a fixed, ordered set of names (render-stream-1.md "Blocks" /
// "Transaction record"); session blocks also have fixed counts (one float32 value per
// logical field), unlike a transaction's, which scale with items/canvases/commands.
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

function checkSessionSchema(
  meta: Record<string, unknown>,
  offset: number,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: ${detail}`,
  ];
  if (!hasExactKeys(meta, SESSION_KEYS))
    return err("session has the wrong top-level keys or order");
  if (meta.protocol !== "render-stream/1")
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

  const features = meta.features;
  if (
    !isPlainObject(features) ||
    !hasExactKeys(features, FEATURES_KEYS) ||
    !isStringArray(features.ops) ||
    !isStringArray(features.item_state) ||
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
      !(u.item === null || isInt(u.item)) ||
      !isOneOf(u.reason, [
        "unsupported-op",
        "unsupported-state",
        "non-root-viewport",
        "extra-canvas",
        "draw-index-tie",
        "degenerate-host-size",
      ] as const)
    ) {
      return err("an unsupported[] entry is malformed");
    }
  }

  if (!isIntArray(meta.removed_canvases))
    return err('"removed_canvases" is not an array of integers');
  if (!isIntArray(meta.removed_items))
    return err('"removed_items" is not an array of integers');

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
        } else if (cmd.op === "unsupported") {
          if (
            !hasExactKeys(cmd, UNSUPPORTED_CMD_KEYS) ||
            typeof cmd.name !== "string"
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
    !isInt(stats.patch_transactions)
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

export interface DecodedRecord {
  offset: number;
  byte_length: number;
  sha256: string;
  meta: Rs1Meta;
  blocks: number[][];
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

  const blocks: number[][] = [];
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
    const expectedLen = 4 * metaBlocks[i].count;
    if (blockLen !== expectedLen) {
      return {
        errors: [
          `block-length: record at offset ${raw.offset} block "${metaBlocks[i].name}" declares count ${metaBlocks[i].count} (${expectedLen} bytes) but carries ${blockLen} bytes`,
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
    const floats: number[] = [];
    for (let f = 0; f < metaBlocks[i].count; f++)
      floats.push(view.getFloat32(pos + f * 4, true));
    pos += blockLen;
    blocks.push(floats);
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
      meta: meta as Rs1Meta,
      blocks,
    },
    errors: [],
  };
}

// --------------------------------------------------------------------------------------- decodeRecording

export function decodeRecording(data: Uint8Array): {
  schema: "render-stream-1-decoded/1";
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
  return { schema: "render-stream-1-decoded/1", magic: toHex(MAGIC), records };
}

// --------------------------------------------------------------------------------------- resolution engine
//
// Shared by validateRecording() (which also checks every invariant along the way) and
// resolveRecording() (which trusts its input and just produces the merged state).

export interface ResolvedCommand {
  op: "add_rect" | "unsupported";
  aa?: boolean;
  rect?: [number, number, number, number];
  color?: [number, number, number, number];
  name?: string;
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
  content_version: number;
  xform: [number, number, number, number, number, number];
  modulate: [number, number, number, number];
  self_modulate: [number, number, number, number];
  custom_rect_rect: [number, number, number, number];
  commands: ResolvedCommand[];
}

export interface ResolvedState {
  canvases: Map<number, ResolvedCanvas>;
  items: Map<number, ResolvedItem>;
}

export function emptyResolvedState(): ResolvedState {
  return { canvases: new Map(), items: new Map() };
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
  return { op: "unsupported", name: cmd.name };
}

// This item's own fields with floats inlined from `itemF32`. `commands` is [] when the wire
// entry's commands are null -- the caller (applyTransaction) fills them in from the base.
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

// Applies one decoded transaction to `base`, per render-stream-1.md "Resolution". Trusts its
// input (no invariant checks) -- used directly by resolveRecording(), and by validateRecording()
// after its own checks have passed for this record.
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
  if (meta.encoding === "patch") {
    for (const id of meta.removed_canvases) canvases.delete(id);
    for (const id of meta.removed_items) items.delete(id);
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
  return { canvases, items };
}

export function sortedResolvedCanvases(state: ResolvedState): ResolvedCanvas[] {
  return [...state.canvases.values()].sort((a, b) => a.id - b.id);
}

export function sortedResolvedItems(state: ResolvedState): ResolvedItem[] {
  return [...state.items.values()].sort((a, b) => a.id - b.id);
}

// --------------------------------------------------------------------------------------- invariants

// Record-level: ids sorted ascending with no duplicates, in the lists as this record actually
// writes them (full set for a full transaction, the small changed/new set for a patch).
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

// render-stream-1.md "Patch error codes": patch-base, patch-encoding, patch-removed,
// patch-commands. `baseState` is the resolved state before this transaction (used by
// patch-removed/patch-commands); `isFirstTransaction` and `prevSeq`/`sessionEncoding` are used by
// patch-base/patch-encoding.
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
      meta.removed_items.length > 0
    ) {
      return [
        `patch-encoding: record at offset ${offset}: a full transaction carries a non-null base_seq or a non-empty removed list`,
      ];
    }
    return [];
  }
  // encoding === "patch"
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

// Invariants that need the full resolved picture (render-stream-0.md 1-8, extended by invariant
// 9 for draw-index ties). Runs on the state AFTER this transaction has been applied.
function checkResolvedInvariants(
  meta: TransactionMeta,
  state: ResolvedState,
): string[] {
  const where = `transaction seq ${meta.seq}`;
  const canvases = sortedResolvedCanvases(state);
  const items = sortedResolvedItems(state);
  const canvasIds = new Set(canvases.map((c) => c.id));
  const itemIds = new Set(items.map((i) => i.id));

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

  // Parent cycles.
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

  // Invariant 9: draw-index ties, over every container (each canvas's items[], each item's
  // children[]), using the RESOLVED child lists.
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

  // Expected unsupported[]: item-level, sorted (item asc, op asc). unsupported-state entries
  // cannot be cross-checked from the wire (no material field is encoded at /1 either) -- as in
  // render-stream-0.ts, they are only checked for using the right op spelling.
  const actualUnsupportedOps = new Set<string>();
  for (const item of items) {
    const names = new Set<string>();
    for (const command of item.commands) {
      if (command.op === "unsupported" && command.name !== undefined)
        names.add(command.name);
    }
    for (const name of names) actualUnsupportedOps.add(`${item.id}:${name}`);
  }

  let lastItem = -1;
  let lastOp = "";
  let itemLevelStarted = false;
  const declaredUnsupportedOps = new Set<string>();
  const declaredTieItems = new Set<number>();
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
    if (entry.reason === "unsupported-op") {
      const pair = `${entry.item}:${entry.op}`;
      if (!actualUnsupportedOps.has(pair)) {
        return [
          `unsupported-mismatch: ${where}: unsupported-op entry (${entry.item}, ${entry.op}) has no matching command`,
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
    }
  }
  for (const pair of actualUnsupportedOps) {
    if (!declaredUnsupportedOps.has(pair)) {
      return [
        `unsupported-mismatch: ${where}: unsupported command (${pair.replace(":", ", ")}) has no unsupported-op entry`,
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

  let bytesTotal = MAGIC.length + first.record.byte_length;
  let maxRecordBytes = first.record.byte_length;
  let transactionCount = 0;
  let fullCount = 0;
  let patchCount = 0;
  let prevSeq = 0;
  let prevFrame = -Infinity;
  let state = emptyResolvedState();
  const maxIdSeen = { canvas: 0, item: 0 };
  let endSeen = false;

  for (let i = 1; i < split.records.length; i++) {
    const decoded = decodeRecord(split.records[i]);
    if (decoded.errors.length > 0 || decoded.record === undefined)
      return [decoded.errors[0]];
    const meta = decoded.record.meta;
    const offset = split.records[i].offset;

    if (meta.type === "session")
      return [`duplicate-session: a second session record at offset ${offset}`];

    if (meta.type === "transaction") {
      const idOrderErrors = [
        ...checkIdOrdering("canvases", meta.canvases, offset),
        ...checkIdOrdering("items", meta.items, offset),
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
      ];
      if (idOrderErrors.length > 0) return idOrderErrors;

      const patchErrors = checkPatchRules(
        meta,
        offset,
        transactionCount === 0,
        prevSeq,
        sessionMeta.stream.encoding,
        state,
      );
      if (patchErrors.length > 0) return patchErrors;

      if (meta.seq !== prevSeq + 1) {
        return [
          `seq-gap: record at offset ${offset}: seq ${meta.seq}, expected ${prevSeq + 1}`,
        ];
      }
      if (meta.frame <= prevFrame) {
        return [
          `frame-order: record at offset ${offset}: frame ${meta.frame} does not increase from ${prevFrame}`,
        ];
      }

      // cmd-offset / block-count: against this record's OWN lists (not the resolved state).
      let runningOffset = 0;
      let addRectCount = 0;
      for (const item of meta.items) {
        if (item.commands === null) continue;
        for (const command of item.commands) {
          if (command.op === "add_rect") {
            if (command.f !== runningOffset) {
              return [
                `cmd-offset: record at offset ${offset}: add_rect f=${command.f}, expected ${runningOffset}`,
              ];
            }
            runningOffset += 8;
            addRectCount += 1;
          }
        }
      }
      const blockByName = new Map(
        meta.blocks.map((b) => [b.name, b.count] as const),
      );
      const expectedBlocks: Array<[string, number]> = [
        ["item_f32", 18 * meta.items.length],
        ["canvas_f32", 6 * meta.canvases.length],
        ["cmd_f32", 8 * addRectCount],
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

      // Resolve, then run the invariants that need the full picture.
      const [itemF32, canvasF32] = decoded.record.blocks;
      if (
        itemF32.length !== 18 * meta.items.length ||
        canvasF32.length !== 6 * meta.canvases.length
      ) {
        return [
          `block-count: record at offset ${offset}: decoded block lengths disagree with items/canvases counts`,
        ];
      }
      const nextState = applyTransaction(state, meta, decoded.record.blocks);
      const resolvedErrors = checkResolvedInvariants(meta, nextState);
      if (resolvedErrors.length > 0) return resolvedErrors;

      // id-reused: resolved ids this transaction vs. the previous one.
      const currentCanvasIds = new Set(nextState.canvases.keys());
      const currentItemIds = new Set(nextState.items.keys());
      const previousCanvasIds = new Set(state.canvases.keys());
      const previousItemIds = new Set(state.items.keys());
      for (const [kind, currentIds, previousIds] of [
        ["canvas", currentCanvasIds, previousCanvasIds] as const,
        ["item", currentItemIds, previousItemIds] as const,
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

// --------------------------------------------------------------------------------------- resolveRecording

export interface ResolvedTransaction {
  seq: number;
  frame: number;
  encoding: Encoding;
  state: {
    status: TransactionStatus;
    failures: TransactionMeta["failures"];
    unsupported: TransactionMeta["unsupported"];
    canvases: ResolvedCanvas[];
    items: ResolvedItem[];
  };
}

export interface ResolvedRecording {
  schema: "render-stream-1-resolved/1";
  session_id: string;
  stream_id: string;
  transactions: ResolvedTransaction[];
}

// Resolves every transaction of a recording to its full state (render-stream-1.md "Decoded and
// resolved forms"). Throws on the first decode problem, like decodeRecording(). Does not re-run
// validateRecording()'s invariant checks -- callers that need both should call both.
export function resolveRecording(data: Uint8Array): ResolvedRecording {
  const decoded = decodeRecording(data);
  const sessionRecord = decoded.records[0];
  if (sessionRecord.meta.type !== "session")
    throw new Error("missing-session: the first record is not a session");
  const sessionMeta = sessionRecord.meta;

  let state = emptyResolvedState();
  const transactions: ResolvedTransaction[] = [];
  for (let i = 1; i < decoded.records.length; i++) {
    const meta = decoded.records[i].meta;
    if (meta.type !== "transaction") continue;
    state = applyTransaction(state, meta, decoded.records[i].blocks);
    transactions.push({
      seq: meta.seq,
      frame: meta.frame,
      encoding: meta.encoding,
      state: {
        status: meta.status,
        failures: meta.failures,
        unsupported: meta.unsupported,
        canvases: sortedResolvedCanvases(state),
        items: sortedResolvedItems(state),
      },
    });
  }
  return {
    schema: "render-stream-1-resolved/1",
    session_id: sessionMeta.session_id,
    stream_id: sessionMeta.stream.stream_id,
    transactions,
  };
}

// --------------------------------------------------------------------------------------- statesEqual

// render-stream-1.md "Decoded and resolved forms": "comparison is deep equality after rounding
// both sides to float32." Applied generically (every JSON number, rounded with Math.fround):
// our ids/counters are all far below float32's 24-bit exact-integer range, so this is exact for
// them and the intended rounding for genuinely float32-origin fields (coordinates, colours).
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

// Unchanged from render-stream-0.ts: format-agnostic over the record framing.
export function recordSha256(data: Uint8Array, offset: number): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const recordLen = view.getUint32(offset, true);
  return hashBytes(data.subarray(offset, offset + 4 + recordLen));
}
