// A test-side render-stream/2 encoder for the checker self-tests (self-test-gate0.ts,
// self-test-gate1.ts): full states in, a recording out, in either encoding. Canonical meta (every
// object built in the wire's key order, protocol/render-stream-2.md), float32 LE blocks and the
// resource record's single u8 block. A patch stream follows render-stream-2.md "Full and patch
// transactions": seq 1 full, then only the entries that are new or differ (floats compared as
// float32), `commands: null` for an item whose content_version is unchanged, removed ids
// ascending -- textures treated like items, every entry complete.
//
// A session's `resources` object follows its delivery: a file stream is out-of-band with a
// `directory` fetch (as the capture's file sinks declare it), a websocket stream inline with no
// fetch (every live connection until G2c2). In an inline stream the encoder writes one resource
// record per hash right before the first transaction whose texture table needs it, from the
// payload registry (registerPayload; the engine's hue strip is registered).
//
// By default every state carries the texture the engine creates by itself in frame 1, the default
// theme's 800x6 RGBA8 ColorPicker hue strip (id 1, `ok`, unreferenced): what every gate 0 and gate 1
// capture's texture table holds.

import { createHash } from "node:crypto";

import {
  FILE_RESOURCES,
  LIVE_RESOURCES,
  RS2_FEATURES,
} from "../lib/gate0-checks";
import {
  decodeRecord,
  splitRecords,
  type TextureReason,
} from "../lib/render-stream-2";

export const MAGIC2 = Buffer.from([
  0x47, 0x52, 0x53, 0x32, 0x0d, 0x0a, 0x1a, 0x0a,
]);
export const GRT1_MAGIC = Buffer.from([
  0x47, 0x52, 0x54, 0x31, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export type TFilter =
  | "default"
  | "nearest"
  | "linear"
  | "nearest_mipmaps"
  | "linear_mipmaps"
  | "nearest_mipmaps_anisotropic"
  | "linear_mipmaps_anisotropic";
export type TRepeat = "default" | "disabled" | "enabled" | "mirror";

export type TCommand =
  | { op: "add_rect"; rect: number[]; color: number[]; aa?: boolean }
  | {
      op: "add_texture_rect";
      tex: number | null;
      rect: number[];
      modulate: number[];
      tile?: boolean;
      transpose?: boolean;
    }
  | {
      op: "add_texture_rect_region";
      tex: number | null;
      rect: number[];
      src: number[];
      modulate: number[];
      transpose?: boolean;
      clip_uv?: boolean;
    }
  | {
      op: "unsupported";
      name: string;
      reason?: "unsupported-op" | "unknown-texture";
    };

/** A texture-table entry exactly as on the wire (render-stream-2.md "Texture"). */
export interface TTexture {
  id: number;
  origin: "created";
  kind: "image" | "placeholder" | "canvas";
  status: "ok" | "unsupported" | "freed";
  reason: TextureReason | null;
  version: number;
  hash: string | null;
  format: string | null;
  width: number;
  height: number;
  mipmaps: boolean;
  payload_bytes: number;
  canvas: { diffuse: number | null; filter: TFilter; repeat: TRepeat } | null;
}

export interface TItem {
  id: number;
  parent: { kind: "canvas" | "item"; id: number } | null;
  children: number[];
  visible: boolean;
  draw_index: number;
  z_index: number;
  visibility_layer: number;
  content_version: number;
  xform: number[];
  modulate: number[];
  self_modulate: number[];
  commands: TCommand[];
  z_relative?: boolean;
  behind?: boolean;
  clip?: boolean;
  custom_rect?: boolean;
  custom_rect_rect?: number[];
  origin?: string;
  /** canvas_item_set_default_texture_filter / _repeat (default "default") */
  texture_filter?: TFilter;
  texture_repeat?: TRepeat;
}

export interface TCanvas {
  id: number;
  items: number[];
  xform: number[];
  origin?: string;
  role?: string | null;
  attached?: boolean;
}

export interface TState {
  frame: number;
  failures?: { reason: string; detail: string }[];
  unsupported?: { op: string; item: number | null; reason: string }[];
  canvases: TCanvas[];
  items: TItem[];
  /** the root viewport's defaults (default "linear" / "disabled", the project defaults) */
  default_texture_filter?: TFilter;
  default_texture_repeat?: TRepeat;
  /** the full texture table, ascending id (default [hueStrip()]) */
  textures?: TTexture[];
}

export interface TSessionOptions {
  encoding: "full" | "patch";
  sessionId?: string;
  streamId?: string;
  hooksPlanned: string[];
  calibratorVersion?: number;
  sabotage?: { kind: string; frame: number; op?: string | null } | null;
  policy?: "observe" | "enforce-min-size";
  hostSizeStatus?: "match" | "degenerate-visible" | "degenerate-window";
  hostWindowSize?: [number, number];
  hostVisibleRect?: number[];
  hostFinalXform?: number[];
  rootCanvasXform?: number[];
  clearColor?: number[];
  /** a live stream (G1c2): transport websocket and its connection number */
  transport?: "file" | "websocket";
  connection?: number | null;
  /** the session's `resources` object (default: FILE_RESOURCES for a file stream,
   * LIVE_RESOURCES for a websocket one) */
  resources?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Texture payloads (render-stream-texture/1) and the registry inline streams draw from
// ---------------------------------------------------------------------------------------------

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A canonical render-stream-texture/1 payload: magic, meta, data. */
export function texturePayload(
  format: string,
  width: number,
  height: number,
  mipmaps: boolean,
  data: Uint8Array,
): Buffer {
  const meta = Buffer.from(
    JSON.stringify({
      type: "texture-2d",
      format,
      width,
      height,
      mipmaps,
      data_bytes: data.length,
    }),
    "ascii",
  );
  const head = Buffer.alloc(4);
  head.writeUInt32LE(meta.length, 0);
  const dataLen = Buffer.alloc(4);
  dataLen.writeUInt32LE(data.length, 0);
  return Buffer.concat([GRT1_MAGIC, head, meta, dataLen, Buffer.from(data)]);
}

const PAYLOADS = new Map<string, Buffer>();

/** Makes `payload` available to inline streams; returns its hash. */
export function registerPayload(payload: Buffer): string {
  const hash = sha256Hex(payload);
  PAYLOADS.set(hash, payload);
  return hash;
}

export function payloadOf(hash: string): Buffer | undefined {
  return PAYLOADS.get(hash);
}

/** The default theme's ColorPicker hue strip: 800x6 RGBA8, one hue ramp repeated on every row. */
function hueStripData(): Uint8Array {
  const width = 800;
  const height = 6;
  const data = new Uint8Array(width * height * 4);
  for (let x = 0; x < width; x++) {
    const h = (x / width) * 6;
    const i = Math.floor(h);
    const f = h - i;
    const rgb = [
      [1, f, 0],
      [1 - f, 1, 0],
      [0, 1, f],
      [0, 1 - f, 1],
      [f, 0, 1],
      [1, 0, 1 - f],
    ][i % 6];
    for (let y = 0; y < height; y++) {
      const p = (y * width + x) * 4;
      data[p] = Math.round(rgb[0] * 255);
      data[p + 1] = Math.round(rgb[1] * 255);
      data[p + 2] = Math.round(rgb[2] * 255);
      data[p + 3] = 255;
    }
  }
  return data;
}

export const HUE_STRIP_PAYLOAD = texturePayload(
  "RGBA8",
  800,
  6,
  false,
  hueStripData(),
);
export const HUE_STRIP_HASH = registerPayload(HUE_STRIP_PAYLOAD);

/** The hue strip's texture-table entry (an `ok` image no command names). */
export function hueStrip(id = 1): TTexture {
  return {
    id,
    origin: "created",
    kind: "image",
    status: "ok",
    reason: null,
    version: 1,
    hash: HUE_STRIP_HASH,
    format: "RGBA8",
    width: 800,
    height: 6,
    mipmaps: false,
    payload_bytes: HUE_STRIP_PAYLOAD.length,
    canvas: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

/** One record: f32 blocks from number arrays, a u8 block from a Uint8Array. */
export function encodeRecord(
  meta: Record<string, unknown>,
  blocks: (number[] | Uint8Array)[],
): Buffer {
  const metaBytes = Buffer.from(JSON.stringify(meta), "ascii");
  const blockLen = (b: number[] | Uint8Array) =>
    b instanceof Uint8Array ? b.length : 4 * b.length;
  const recordLen =
    8 + metaBytes.length + blocks.reduce((n, b) => n + 4 + blockLen(b), 0);
  const out = Buffer.alloc(4 + recordLen);
  let p = out.writeUInt32LE(recordLen, 0);
  p = out.writeUInt32LE(metaBytes.length, p);
  p += metaBytes.copy(out, p);
  p = out.writeUInt32LE(blocks.length, p);
  for (const block of blocks) {
    p = out.writeUInt32LE(blockLen(block), p);
    if (block instanceof Uint8Array) p += Buffer.from(block).copy(out, p);
    else for (const v of block) p = out.writeFloatLE(v, p);
  }
  return out;
}

const blockSpecs = (names: string[], blocks: number[][]) =>
  names.map((name, i) => ({ name, type: "f32", count: blocks[i].length }));

function sessionResources(opts: TSessionOptions): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(
      opts.resources ??
        (opts.transport === "websocket" ? LIVE_RESOURCES : FILE_RESOURCES),
    ),
  );
}

export function encodeSession(opts: TSessionOptions): Buffer {
  const blocks = [
    opts.clearColor ?? [0.2, 0.2, 0.4, 1],
    opts.rootCanvasXform ?? [1, 0, 0, 1, 0, 0],
    opts.hostVisibleRect ?? [0, 0, 640, 360],
    opts.hostFinalXform ?? [1, 0, 0, 1, 0, 0],
    [1],
  ];
  return encodeRecord(
    {
      type: "session",
      protocol: "render-stream/2",
      session_id: opts.sessionId ?? "0123456789abcdef0123456789abcdef",
      stream: {
        stream_id:
          opts.streamId ??
          (opts.encoding === "full"
            ? "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"
            : "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"),
        connection: opts.connection ?? null,
        transport: opts.transport ?? "file",
        encoding: opts.encoding,
      },
      engine: {
        version_string: "Godot Engine v4.5.1.stable.official",
        sha256:
          "54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c",
        display_server: "headless",
        rendering_driver: "opengl3",
        rendering_method: "gl_compatibility",
      },
      capture: {
        calibrator_version: opts.calibratorVersion ?? 5,
        hooks_planned: opts.hooksPlanned,
        hooks_omitted: [],
      },
      viewport: {
        canvas_cull_mask: 4294967295,
        root_canvas: 1,
        logical_size: [640, 360],
        stretch: { mode: "disabled", aspect: "keep", scale_mode: "fractional" },
        stretch_applied_by: "receiver",
        root_size_policy: opts.policy ?? "enforce-min-size",
        host_size_status: opts.hostSizeStatus ?? "match",
        host_window_size: opts.hostWindowSize ?? [640, 360],
      },
      resources: sessionResources(opts),
      features: JSON.parse(JSON.stringify(RS2_FEATURES)),
      sabotage:
        opts.sabotage == null
          ? null
          : {
              kind: opts.sabotage.kind,
              frame: opts.sabotage.frame,
              op: opts.sabotage.op ?? null,
            },
      blocks: blockSpecs(
        [
          "clear_color",
          "root_canvas_xform",
          "host_visible_rect",
          "host_final_xform",
          "content_scale_factor",
        ],
        blocks,
      ),
    },
    blocks,
  );
}

/** A resource record carrying `payload` (render-stream-2.md "Resource record"). */
export function encodeResource(payload: Buffer): Buffer {
  return encodeRecord(
    {
      type: "resource",
      hash: sha256Hex(payload),
      bytes: payload.length,
      blocks: [{ name: "payload", type: "u8", count: payload.length }],
    },
    [payload],
  );
}

function itemFloats(it: TItem): number[] {
  return [
    ...it.xform,
    ...it.modulate,
    ...it.self_modulate,
    ...(it.custom_rect_rect ?? [0, 0, 0, 0]),
  ];
}

function itemKey(it: TItem): string {
  const { commands: _c, ...rest } = it;
  return JSON.stringify({
    ...rest,
    z_relative: it.z_relative ?? true,
    behind: it.behind ?? false,
    clip: it.clip ?? false,
    custom_rect: it.custom_rect ?? false,
    origin: it.origin ?? "created",
    texture_filter: it.texture_filter ?? "default",
    texture_repeat: it.texture_repeat ?? "default",
    f: itemFloats(it).map((v) => Math.fround(v)),
  });
}

function canvasKey(c: TCanvas): string {
  return JSON.stringify({ ...c, xform: c.xform.map((v) => Math.fround(v)) });
}

/** The texture table of a state (the hue strip unless the state says otherwise). */
export function texturesOf(state: TState): TTexture[] {
  return [...(state.textures ?? [hueStrip()])].sort((a, b) => a.id - b.id);
}

/** A texture entry with its keys in wire order. */
function textureMeta(t: TTexture): Record<string, unknown> {
  return {
    id: t.id,
    origin: t.origin,
    kind: t.kind,
    status: t.status,
    reason: t.reason,
    version: t.version,
    hash: t.hash,
    format: t.format,
    width: t.width,
    height: t.height,
    mipmaps: t.mipmaps,
    payload_bytes: t.payload_bytes,
    canvas:
      t.canvas === null
        ? null
        : {
            diffuse: t.canvas.diffuse,
            filter: t.canvas.filter,
            repeat: t.canvas.repeat,
          },
  };
}

function commandMeta(c: TCommand, cmdF: number[]): Record<string, unknown> {
  if (c.op === "unsupported")
    return {
      op: "unsupported",
      name: c.name,
      reason: c.reason ?? "unsupported-op",
    };
  const f = cmdF.length;
  if (c.op === "add_rect") {
    cmdF.push(...c.rect, ...c.color);
    return { op: "add_rect", aa: c.aa ?? false, f };
  }
  if (c.op === "add_texture_rect") {
    cmdF.push(...c.rect, ...c.modulate);
    return {
      op: "add_texture_rect",
      tex: c.tex,
      tile: c.tile ?? false,
      transpose: c.transpose ?? false,
      f,
    };
  }
  cmdF.push(...c.rect, ...c.src, ...c.modulate);
  return {
    op: "add_texture_rect_region",
    tex: c.tex,
    transpose: c.transpose ?? false,
    clip_uv: c.clip_uv ?? false,
    f,
  };
}

/** One transaction record: `base` undefined -> full; otherwise a patch against `base`. */
export function encodeTransaction(
  seq: number,
  state: TState,
  base?: TState,
): Buffer {
  const baseItems = new Map((base?.items ?? []).map((i) => [i.id, i]));
  const baseCanvases = new Map((base?.canvases ?? []).map((c) => [c.id, c]));
  const baseTextures = new Map(
    (base ? texturesOf(base) : []).map((t) => [t.id, t]),
  );
  const items = [...state.items]
    .sort((a, b) => a.id - b.id)
    .filter((it) => {
      if (!base) return true;
      const b = baseItems.get(it.id);
      return !b || itemKey(b) !== itemKey(it);
    });
  const canvases = [...state.canvases]
    .sort((a, b) => a.id - b.id)
    .filter((c) => {
      if (!base) return true;
      const b = baseCanvases.get(c.id);
      return !b || canvasKey(b) !== canvasKey(c);
    });
  const textures = texturesOf(state).filter((t) => {
    if (!base) return true;
    const b = baseTextures.get(t.id);
    return (
      !b || JSON.stringify(textureMeta(b)) !== JSON.stringify(textureMeta(t))
    );
  });
  const ids = (list: { id: number }[]) => new Set(list.map((x) => x.id));
  const removed = (from: { id: number }[], now: { id: number }[]) =>
    [...ids(from)].filter((id) => !ids(now).has(id)).sort((a, b) => a - b);
  const removedItems = base ? removed(base.items, state.items) : [];
  const removedCanvases = base ? removed(base.canvases, state.canvases) : [];
  const removedTextures = base
    ? removed(texturesOf(base), texturesOf(state))
    : [];
  const itemF: number[] = [];
  const canvasF: number[] = [];
  const cmdF: number[] = [];
  const itemMetas = items.map((it) => {
    itemF.push(...itemFloats(it));
    const b = baseItems.get(it.id);
    const nullCommands =
      base !== undefined &&
      b !== undefined &&
      b.content_version === it.content_version;
    const commands = nullCommands
      ? null
      : it.commands.map((c) => commandMeta(c, cmdF));
    return {
      id: it.id,
      origin: it.origin ?? "created",
      parent: it.parent,
      children: it.children,
      visible: it.visible,
      draw_index: it.draw_index,
      z_index: it.z_index,
      z_relative: it.z_relative ?? true,
      behind: it.behind ?? false,
      clip: it.clip ?? false,
      custom_rect: it.custom_rect ?? false,
      visibility_layer: it.visibility_layer,
      texture_filter: it.texture_filter ?? "default",
      texture_repeat: it.texture_repeat ?? "default",
      content_version: it.content_version,
      commands,
    };
  });
  const canvasMetas = canvases.map((c) => {
    canvasF.push(...c.xform);
    return {
      id: c.id,
      origin: c.origin ?? (c.id === 1 ? "root-query" : "created"),
      role: c.role === undefined ? (c.id === 1 ? "root" : null) : c.role,
      attached: c.attached ?? c.id === 1,
      items: c.items,
    };
  });
  const blocks = [itemF, canvasF, cmdF];
  const failures = state.failures ?? [];
  return encodeRecord(
    {
      type: "transaction",
      seq,
      frame: state.frame,
      encoding: base ? "patch" : "full",
      base_seq: base ? seq - 1 : null,
      status: failures.length > 0 ? "capture-failure" : "ok",
      failures,
      unsupported: state.unsupported ?? [],
      default_texture_filter: state.default_texture_filter ?? "linear",
      default_texture_repeat: state.default_texture_repeat ?? "disabled",
      removed_canvases: removedCanvases,
      removed_items: removedItems,
      removed_textures: removedTextures,
      canvases: canvasMetas,
      items: itemMetas,
      textures: textures.map(textureMeta),
      blocks: blockSpecs(["item_f32", "canvas_f32", "cmd_f32"], blocks),
    },
    blocks,
  );
}

export interface RecordingEncodeOptions extends TSessionOptions {
  /** drop the end record */
  noEnd?: boolean;
  /** a hook to alter one transaction's state for the patch stream only, e.g. to diverge */
  mutatePatch?: (seq: number, state: TState) => TState;
  /** patch encoding only: write these seqs as full transactions (as after a resync) */
  fullAt?: number[];
}

/** A whole recording: magic, session, one transaction per state (seq 1..N), each preceded in an
 * inline stream by the resource records it first needs, then the end record. */
export function encodeRs2Recording(
  states: readonly TState[],
  opts: RecordingEncodeOptions,
): Buffer {
  const session = encodeSession(opts);
  const resources = sessionResources(opts);
  const inlineMax = Number(resources.inline_max_bytes ?? 0);
  const records: Buffer[] = [session];
  const carried = new Set<string>();
  let prev: TState | undefined;
  let full = 0;
  let patch = 0;
  let resourceRecords = 0;
  let resourceBytes = 0;
  states.forEach((raw, i) => {
    const seq = i + 1;
    const state =
      opts.encoding === "patch" && opts.mutatePatch
        ? opts.mutatePatch(seq, raw)
        : raw;
    for (const t of texturesOf(state)) {
      if (t.kind !== "image" || t.status !== "ok" || t.hash === null) continue;
      if (t.payload_bytes > inlineMax || carried.has(t.hash)) continue;
      const payload = payloadOf(t.hash);
      if (!payload)
        throw new Error(`rs2-test-encoder: no registered payload ${t.hash}`);
      records.push(encodeResource(payload));
      carried.add(t.hash);
      resourceRecords++;
      resourceBytes += payload.length;
    }
    const asPatch =
      opts.encoding === "patch" &&
      prev !== undefined &&
      !(opts.fullAt ?? []).includes(seq);
    records.push(encodeTransaction(seq, state, asPatch ? prev : undefined));
    if (asPatch) patch++;
    else full++;
    prev = raw;
  });
  const bytesTotal = MAGIC2.length + records.reduce((n, r) => n + r.length, 0);
  const maxRecord = Math.max(...records.map((r) => r.length));
  if (!opts.noEnd) {
    records.push(
      encodeRecord(
        {
          type: "end",
          transactions: states.length,
          reason: "shutdown",
          stats: {
            bytes_total: bytesTotal,
            encode_ns_total: 1000 * states.length,
            snapshot_ns_total: 100 * states.length,
            diff_ns_total: opts.encoding === "patch" ? 50 * states.length : 0,
            max_record_bytes: maxRecord,
            full_transactions: full,
            patch_transactions: patch,
            resource_records: resourceRecords,
            resource_bytes: resourceBytes,
          },
          blocks: [],
        },
        [],
      ),
    );
  }
  return Buffer.concat([MAGIC2, ...records]);
}

/** Where each transaction record of a recording sits (offset and length prefix included), by
 * seq; resource, session and end records are skipped. */
export function transactionRecords(
  bytes: Uint8Array,
): Map<number, { offset: number; byte_length: number }> {
  const out = new Map<number, { offset: number; byte_length: number }>();
  for (const raw of splitRecords(bytes).records) {
    const meta = decodeRecord(raw).record?.meta;
    if (meta?.type === "transaction")
      out.set(meta.seq, { offset: raw.offset, byte_length: raw.byte_length });
  }
  return out;
}
