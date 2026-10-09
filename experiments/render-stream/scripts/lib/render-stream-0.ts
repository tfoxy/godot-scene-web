// render-stream/0 wire decoder and validator: pure over Uint8Array, no file or network I/O.
//
// The wire format (record framing, canonical JSON key order, float32 LE blocks) is specified in
// ../../protocol/render-stream-0.md; this must agree with it byte for byte, and with the C++
// encoder (../../capture/src/rs0_codec.cpp) and the GDScript decoder (../../receiver/rs0_decoder.gd).
// The golden vectors in ../../protocol/golden/ are shared by all three.
//
// splitRecords() handles only the outer magic + length-prefix framing (bad-magic, truncated).
// decodeRecord() parses one record's content (meta JSON, canonical-form and schema checks, block
// layout) and can additionally fail with meta-json, meta-schema, meta-noncanonical (TypeScript
// only -- GDScript has no canonical re-serialisation to compare against), record-length or
// block-length. validateRecording() runs both of those plus every cross-record and
// per-transaction invariant render-stream-0.md "Recording invariants" / "Per-transaction
// invariants" describes, and stops at the first problem it finds: the golden invalid vectors are
// each built with exactly one deliberate flaw, so every one of them must come back with exactly
// one error.

import { createHash } from "node:crypto";

// --------------------------------------------------------------------------------------- wire types

export type Origin = "created" | "root-query" | "adopted";
export type CanvasRole = "root" | null;
export type ParentKind = "canvas" | "item";
export type TransactionStatus = "ok" | "capture-failure";
export type FailureReason =
  | "root-query-failed"
  | "pre-existing-object"
  | "mirror-capacity";
export type UnsupportedReason =
  | "unsupported-op"
  | "unsupported-state"
  | "non-root-viewport"
  | "extra-canvas";
export type SabotageKind = "freeze-frame" | "omit-update" | "perturb-transform";
export type EndReason = "shutdown" | "disarm";

export interface BlockDescriptor {
  name: string;
  type: "f32";
  count: number;
}

export interface SessionMeta {
  type: "session";
  protocol: string;
  session_id: string;
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
  };
  features: {
    ops: string[];
    item_state: string[];
    observed_unsupported_ops: string[];
    unobserved: string[];
    publication: string;
  };
  sabotage: { kind: SabotageKind; frame: number } | null;
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
  clip: boolean;
  custom_rect: boolean;
  visibility_layer: number;
  content_version: number;
  commands: Command[];
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
  status: TransactionStatus;
  failures: Array<{ reason: FailureReason; detail: string }>;
  unsupported: Array<{
    op: string;
    item: number | null;
    reason: UnsupportedReason;
  }>;
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
    max_record_bytes: number;
  };
  blocks: BlockDescriptor[];
}

export type Rs0Meta = SessionMeta | TransactionMeta | EndMeta;

// --------------------------------------------------------------------------------------- constants

export const MAGIC: Uint8Array = new Uint8Array([
  0x47, 0x52, 0x53, 0x30, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const SESSION_KEYS = [
  "type",
  "protocol",
  "session_id",
  "engine",
  "capture",
  "viewport",
  "features",
  "sabotage",
  "blocks",
];
const ENGINE_KEYS = [
  "version_string",
  "sha256",
  "display_server",
  "rendering_driver",
  "rendering_method",
];
const CAPTURE_KEYS = ["calibrator_version", "hooks_planned", "hooks_omitted"];
const VIEWPORT_KEYS = ["canvas_cull_mask", "root_canvas"];
const FEATURES_KEYS = [
  "ops",
  "item_state",
  "observed_unsupported_ops",
  "unobserved",
  "publication",
];
const SABOTAGE_KEYS = ["kind", "frame"];

const TRANSACTION_KEYS = [
  "type",
  "seq",
  "frame",
  "status",
  "failures",
  "unsupported",
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
  "max_record_bytes",
];

const BLOCK_KEYS = ["name", "type", "count"];

// --------------------------------------------------------------------------------------- small helpers

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Every byte of meta is printable ASCII (render-stream-0.md "Meta JSON"); null on any other byte.
function bytesToAscii(bytes: Uint8Array): string | null {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x20 || b > 0x7e) {
      return null;
    }
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
  if (actual.length !== keys.length) {
    return false;
  }
  for (let i = 0; i < keys.length; i++) {
    if (actual[i] !== keys[i]) {
      return false;
    }
  }
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

// --------------------------------------------------------------------------------------- schema checks

function checkSessionSchema(
  meta: Record<string, unknown>,
  offset: number,
): string[] {
  const err = (detail: string) => [
    `meta-schema: record at offset ${offset}: ${detail}`,
  ];
  if (!hasExactKeys(meta, SESSION_KEYS)) {
    return err("session has the wrong top-level keys or order");
  }
  if (meta.protocol !== "render-stream/0") {
    return err(`unknown protocol ${JSON.stringify(meta.protocol)}`);
  }
  if (typeof meta.session_id !== "string") {
    return err('"session_id" is not a string');
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
    !hasExactKeys(viewport, VIEWPORT_KEYS) ||
    !isInt(viewport.canvas_cull_mask) ||
    !isInt(viewport.root_canvas)
  ) {
    return err('"viewport" has the wrong keys or an invalid field');
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
      !isOneOf(sabotage.kind, [
        "freeze-frame",
        "omit-update",
        "perturb-transform",
      ] as const) ||
      !isInt(sabotage.frame) ||
      sabotage.frame < 1
    ) {
      return err('"sabotage" is neither null nor a valid sabotage object');
    }
  }

  const blocksError = checkBlocksField(meta.blocks, offset);
  if (blocksError !== null) {
    return [blocksError];
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
  if (!hasExactKeys(meta, TRANSACTION_KEYS)) {
    return err("transaction has the wrong top-level keys or order");
  }
  if (!isInt(meta.seq) || meta.seq < 1) {
    return err('"seq" is not an integer >= 1');
  }
  if (!isInt(meta.frame) || meta.frame < 1) {
    return err('"frame" is not an integer >= 1');
  }
  if (meta.status !== "ok" && meta.status !== "capture-failure") {
    return err(`unknown status ${JSON.stringify(meta.status)}`);
  }

  if (!Array.isArray(meta.failures)) {
    return err('"failures" is not an array');
  }
  for (const f of meta.failures) {
    if (
      !isPlainObject(f) ||
      !hasExactKeys(f, FAILURE_KEYS) ||
      !isOneOf(f.reason, [
        "root-query-failed",
        "pre-existing-object",
        "mirror-capacity",
      ] as const) ||
      typeof f.detail !== "string"
    ) {
      return err("a failures[] entry is malformed");
    }
  }

  if (!Array.isArray(meta.unsupported)) {
    return err('"unsupported" is not an array');
  }
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
      ] as const)
    ) {
      return err("an unsupported[] entry is malformed");
    }
  }

  if (!Array.isArray(meta.canvases)) {
    return err('"canvases" is not an array');
  }
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

  if (!Array.isArray(meta.items)) {
    return err('"items" is not an array');
  }
  for (const it of meta.items) {
    if (
      !isPlainObject(it) ||
      !hasExactKeys(it, ITEM_KEYS) ||
      !isInt(it.id) ||
      !isOneOf(it.origin, ["created", "root-query", "adopted"] as const) ||
      typeof it.visible !== "boolean" ||
      !isInt(it.draw_index) ||
      !isInt(it.z_index) ||
      typeof it.clip !== "boolean" ||
      typeof it.custom_rect !== "boolean" ||
      !isInt(it.visibility_layer) ||
      !isInt(it.content_version) ||
      !isIntArray(it.children) ||
      !Array.isArray(it.commands)
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
    for (const cmd of it.commands) {
      if (!isPlainObject(cmd)) {
        return err("a commands[] entry is not an object");
      }
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

  const blocksError = checkBlocksField(meta.blocks, offset);
  if (blocksError !== null) {
    return [blocksError];
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
  if (!hasExactKeys(meta, END_KEYS)) {
    return err("end has the wrong top-level keys or order");
  }
  if (!isInt(meta.transactions) || meta.transactions < 0) {
    return err('"transactions" is not a non-negative integer');
  }
  if (meta.reason !== "shutdown" && meta.reason !== "disarm") {
    return err(`unknown reason ${JSON.stringify(meta.reason)}`);
  }

  const stats = meta.stats;
  if (
    !isPlainObject(stats) ||
    !hasExactKeys(stats, STATS_KEYS) ||
    !isInt(stats.bytes_total) ||
    !isInt(stats.encode_ns_total) ||
    !isInt(stats.snapshot_ns_total) ||
    !isInt(stats.max_record_bytes)
  ) {
    return err('"stats" has the wrong keys or a non-integer field');
  }

  if (!Array.isArray(meta.blocks) || meta.blocks.length !== 0) {
    return err('"blocks" must be an empty array for an end record');
  }
  return [];
}

function checkMetaSchema(meta: unknown, offset: number): string[] {
  if (!isPlainObject(meta)) {
    return [
      `meta-schema: record at offset ${offset}: meta is not a JSON object`,
    ];
  }
  if (meta.type === "session") {
    return checkSessionSchema(meta, offset);
  }
  if (meta.type === "transaction") {
    return checkTransactionSchema(meta, offset);
  }
  if (meta.type === "end") {
    return checkEndSchema(meta, offset);
  }
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

// Outer magic + length-prefix framing only: never touches meta or block contents, so it can
// locate every record without understanding JSON (render-stream-0.md "File layout" / "Record
// framing"). Stops at the first framing problem, since nothing after it can be located reliably.
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
  meta: Rs0Meta;
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
  if (schemaErrors.length > 0) {
    return { errors: schemaErrors };
  }
  // TypeScript-only canonical check: JavaScript preserves insertion order for these non-numeric
  // keys, so a byte-exact re-serialisation proves the source was already canonical.
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
    for (let f = 0; f < metaBlocks[i].count; f++) {
      floats.push(view.getFloat32(pos + f * 4, true));
    }
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
      meta: meta as Rs0Meta,
      blocks,
    },
    errors: [],
  };
}

// --------------------------------------------------------------------------------------- decodeRecording

export function decodeRecording(data: Uint8Array): {
  schema: "render-stream-0-decoded/1";
  magic: string;
  records: DecodedRecord[];
} {
  const split = splitRecords(data);
  if (split.errors.length > 0) {
    throw new Error(split.errors[0]);
  }
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
  return { schema: "render-stream-0-decoded/1", magic: toHex(MAGIC), records };
}

// --------------------------------------------------------------------------------------- validateRecording

// Following parent links from any item must end at a canvas or null, never revisiting an item
// (render-stream-0.md "Per-transaction invariants" #5).
function hasParentCycle(items: TransactionItem[]): boolean {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  for (const start of items) {
    const visited = new Set<number>([start.id]);
    let current: TransactionItem = start;
    for (let steps = 0; steps <= items.length; steps++) {
      const parent = current.parent;
      if (parent === null || parent.kind === "canvas") {
        break;
      }
      const next = byId.get(parent.id);
      if (next === undefined) {
        break; // dangling parent: reported separately
      }
      if (visited.has(next.id)) {
        return true;
      }
      visited.add(next.id);
      current = next;
    }
  }
  return false;
}

// Self-contained structural checks for one transaction (render-stream-0.md "Per-transaction
// invariants"): everything that does not need history from earlier transactions. Returns [] or
// exactly one error, matching validateRecording's "stop at the first problem" contract.
function checkTransactionInvariants(
  tx: TransactionMeta,
  offset: number,
): string[] {
  for (const [label, list] of [
    ["canvases", tx.canvases] as const,
    ["items", tx.items] as const,
  ]) {
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
  }

  const roots = tx.canvases.filter((c) => c.role === "root");
  if (roots.length !== 1 || roots[0].id !== 1) {
    return [
      `root-canvas: record at offset ${offset}: expected exactly one canvas with role "root" and id 1`,
    ];
  }

  const canvasIds = new Set(tx.canvases.map((c) => c.id));
  const itemIds = new Set(tx.items.map((i) => i.id));

  const claimedChildrenOf = new Map<string, number[]>();
  for (const item of tx.items) {
    if (item.parent === null) {
      continue;
    }
    const key = `${item.parent.kind}:${item.parent.id}`;
    const exists =
      item.parent.kind === "canvas"
        ? canvasIds.has(item.parent.id)
        : itemIds.has(item.parent.id);
    if (!exists) {
      return [
        `dangling-parent: record at offset ${offset}: item ${item.id} names parent ${key}, which is not in this transaction`,
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

  for (const canvas of tx.canvases) {
    const claimed = new Set(claimedChildrenOf.get(`canvas:${canvas.id}`) ?? []);
    if (!sameSet(canvas.items, claimed)) {
      return [
        `child-list-mismatch: record at offset ${offset}: canvas ${canvas.id}'s items[] disagrees with items' parent fields`,
      ];
    }
  }
  for (const item of tx.items) {
    const claimed = new Set(claimedChildrenOf.get(`item:${item.id}`) ?? []);
    if (!sameSet(item.children, claimed)) {
      return [
        `child-list-mismatch: record at offset ${offset}: item ${item.id}'s children[] disagrees with items' parent fields`,
      ];
    }
  }
  const allListed = new Set<number>();
  for (const c of tx.canvases) {
    for (const id of c.items) {
      allListed.add(id);
    }
  }
  for (const i of tx.items) {
    for (const id of i.children) {
      allListed.add(id);
    }
  }
  for (const item of tx.items) {
    if (item.parent === null && allListed.has(item.id)) {
      return [
        `child-list-mismatch: record at offset ${offset}: item ${item.id} has no parent but appears in a children/items list`,
      ];
    }
  }

  if (hasParentCycle(tx.items)) {
    return [
      `parent-cycle: record at offset ${offset}: following parent links revisits an item`,
    ];
  }

  let runningOffset = 0;
  let addRectCount = 0;
  for (const item of tx.items) {
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
  const blockByName = new Map(tx.blocks.map((b) => [b.name, b.count] as const));
  const expected: Array<[string, number]> = [
    ["item_f32", 18 * tx.items.length],
    ["canvas_f32", 6 * tx.canvases.length],
    ["cmd_f32", 8 * addRectCount],
  ];
  for (const [name, count] of expected) {
    if (blockByName.get(name) !== count) {
      return [
        `block-count: record at offset ${offset}: block "${name}" declares count ${blockByName.get(name)}, expected ${count}`,
      ];
    }
  }

  const expectedStatus = tx.failures.length === 0 ? "ok" : "capture-failure";
  if (tx.status !== expectedStatus) {
    return [
      `meta-schema: record at offset ${offset}: status "${tx.status}" disagrees with failures.length ${tx.failures.length}`,
    ];
  }

  const actualUnsupportedOps = new Set<string>();
  for (const item of tx.items) {
    const names = new Set<string>();
    for (const command of item.commands) {
      if (command.op === "unsupported") {
        names.add(command.name);
      }
    }
    for (const name of names) {
      actualUnsupportedOps.add(`${item.id}:${name}`);
    }
  }
  const declaredUnsupportedOps = new Set<string>();
  for (const entry of tx.unsupported) {
    if (entry.item !== null && !itemIds.has(entry.item)) {
      return [
        `dangling-parent: record at offset ${offset}: unsupported entry names item ${entry.item}, which is not in this transaction`,
      ];
    }
    if (entry.item !== null && entry.reason === "unsupported-op") {
      const key = `${entry.item}:${entry.op}`;
      if (declaredUnsupportedOps.has(key)) {
        return [
          `unsupported-mismatch: record at offset ${offset}: duplicate unsupported entry for item ${entry.item} op "${entry.op}"`,
        ];
      }
      declaredUnsupportedOps.add(key);
    }
  }
  if (
    actualUnsupportedOps.size !== declaredUnsupportedOps.size ||
    ![...actualUnsupportedOps].every((k) => declaredUnsupportedOps.has(k))
  ) {
    return [
      `unsupported-mismatch: record at offset ${offset}: unsupported[] disagrees with items' unsupported commands`,
    ];
  }

  return [];
}

// Runs splitRecords + decodeRecord plus every cross-record invariant render-stream-0.md
// "Recording invariants" describes, and stops at the first problem found anywhere in that
// pipeline: every golden invalid vector has exactly one deliberate flaw and must come back with
// exactly that one error, in "<code>: <detail>" form. [] means the recording is valid.
export function validateRecording(data: Uint8Array): string[] {
  const split = splitRecords(data);
  if (split.errors.length > 0) {
    return [split.errors[0]];
  }
  if (split.records.length === 0) {
    return ["missing-session: the recording has no records"];
  }

  const first = decodeRecord(split.records[0]);
  if (first.errors.length > 0 || first.record === undefined) {
    return [first.errors[0]];
  }
  const sessionMeta = first.record.meta;
  if (sessionMeta.type !== "session") {
    return [`missing-session: the first record has type "${sessionMeta.type}"`];
  }
  if (sessionMeta.viewport.root_canvas !== 1) {
    return [
      `root-canvas: session.viewport.root_canvas is ${sessionMeta.viewport.root_canvas}, not 1`,
    ];
  }

  let bytesTotal = MAGIC.length + first.record.byte_length;
  let maxRecordBytes = first.record.byte_length;
  let transactionCount = 0;
  let prevSeq = 0;
  let prevFrame = -Infinity;
  const maxIdSeen = { canvas: 0, item: 0 };
  let prevIds: { canvas: Set<number>; item: Set<number> } = {
    canvas: new Set<number>(),
    item: new Set<number>(),
  };
  let endSeen = false;

  for (let i = 1; i < split.records.length; i++) {
    const decoded = decodeRecord(split.records[i]);
    if (decoded.errors.length > 0 || decoded.record === undefined) {
      return [decoded.errors[0]];
    }
    const meta = decoded.record.meta;
    const offset = split.records[i].offset;

    if (meta.type === "session") {
      return [`duplicate-session: a second session record at offset ${offset}`];
    }

    if (meta.type === "transaction") {
      const structural = checkTransactionInvariants(meta, offset);
      if (structural.length > 0) {
        return structural;
      }
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
      if (!meta.canvases.some((c) => c.id === 1)) {
        return [`root-canvas: record at offset ${offset}: no canvas with id 1`];
      }

      const currentIds = {
        canvas: new Set(meta.canvases.map((c) => c.id)),
        item: new Set(meta.items.map((it) => it.id)),
      };
      for (const kind of ["canvas", "item"] as const) {
        for (const id of currentIds[kind]) {
          if (!prevIds[kind].has(id) && id <= maxIdSeen[kind]) {
            return [
              `id-reused: record at offset ${offset}: ${kind} id ${id} reappears after not being in the previous transaction`,
            ];
          }
        }
        for (const id of currentIds[kind]) {
          maxIdSeen[kind] = Math.max(maxIdSeen[kind], id);
        }
      }

      prevSeq = meta.seq;
      prevFrame = meta.frame;
      prevIds = currentIds;
      transactionCount += 1;
      bytesTotal += decoded.record.byte_length;
      maxRecordBytes = Math.max(maxRecordBytes, decoded.record.byte_length);
      continue;
    }

    // meta.type === "end" (the only remaining member of the Rs0Meta union here).
    if (meta.transactions !== transactionCount) {
      return [
        `end-count-mismatch: end record says ${meta.transactions} transactions, but ${transactionCount} were seen`,
      ];
    }
    if (
      meta.stats.bytes_total !== bytesTotal ||
      meta.stats.max_record_bytes !== maxRecordBytes
    ) {
      return [
        `end-stats-mismatch: end record stats disagree with the recording (bytes_total ${meta.stats.bytes_total} vs ${bytesTotal}, max_record_bytes ${meta.stats.max_record_bytes} vs ${maxRecordBytes})`,
      ];
    }
    if (i !== split.records.length - 1) {
      return [
        `trailing-bytes: data follows the end record at offset ${offset}`,
      ];
    }
    endSeen = true;
  }

  if (!endSeen) {
    return ["recording-incomplete: the recording ends without an end record"];
  }
  return [];
}

// --------------------------------------------------------------------------------------- recordSha256

// The lowercase hex SHA-256 of exactly the `4 + record_len` bytes of the record starting at
// `offset` (the first byte of its record_len), per render-stream-0.md "Record framing".
export function recordSha256(data: Uint8Array, offset: number): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const recordLen = view.getUint32(offset, true);
  return hashBytes(data.subarray(offset, offset + 4 + recordLen));
}
