// A test-side render-stream/1 encoder for the checker self-tests (self-test-gate0.ts,
// self-test-gate1.ts): full states in, a recording out, in either encoding. Canonical meta (every
// object built in the wire's key order, protocol/render-stream-1.md), float32 LE blocks. A patch
// stream follows render-stream-1.md "Patch transactions": seq 1 full, then only the entries that
// are new or differ (floats compared as float32), `commands: null` for an item whose
// content_version is unchanged, removed ids ascending.

import { RS1_FEATURES } from "../lib/gate0-checks";

export const MAGIC1 = Buffer.from([
  0x47, 0x52, 0x53, 0x31, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export type TCommand =
  | { op: "add_rect"; rect: number[]; color: number[]; aa?: boolean }
  | { op: "unsupported"; name: string };

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
}

export function encodeRecord(
  meta: Record<string, unknown>,
  blocks: number[][],
): Buffer {
  const metaBytes = Buffer.from(JSON.stringify(meta), "ascii");
  const recordLen =
    8 + metaBytes.length + blocks.reduce((n, b) => n + 4 + 4 * b.length, 0);
  const out = Buffer.alloc(4 + recordLen);
  let p = out.writeUInt32LE(recordLen, 0);
  p = out.writeUInt32LE(metaBytes.length, p);
  p += metaBytes.copy(out, p);
  p = out.writeUInt32LE(blocks.length, p);
  for (const block of blocks) {
    p = out.writeUInt32LE(4 * block.length, p);
    for (const v of block) p = out.writeFloatLE(v, p);
  }
  return out;
}

const blockSpecs = (names: string[], blocks: number[][]) =>
  names.map((name, i) => ({ name, type: "f32", count: blocks[i].length }));

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
      protocol: "render-stream/1",
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
        calibrator_version: opts.calibratorVersion ?? 3,
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
      features: JSON.parse(JSON.stringify(RS1_FEATURES)),
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
    f: itemFloats(it).map((v) => Math.fround(v)),
  });
}

function canvasKey(c: TCanvas): string {
  return JSON.stringify({ ...c, xform: c.xform.map((v) => Math.fround(v)) });
}

/** One transaction record: `base` undefined -> full; otherwise a patch against `base`. */
export function encodeTransaction(
  seq: number,
  state: TState,
  base?: TState,
): Buffer {
  const baseItems = new Map((base?.items ?? []).map((i) => [i.id, i]));
  const baseCanvases = new Map((base?.canvases ?? []).map((c) => [c.id, c]));
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
  const ids = (list: { id: number }[]) => new Set(list.map((x) => x.id));
  const removedItems = base
    ? [...ids(base.items)]
        .filter((id) => !ids(state.items).has(id))
        .sort((a, b) => a - b)
    : [];
  const removedCanvases = base
    ? [...ids(base.canvases)]
        .filter((id) => !ids(state.canvases).has(id))
        .sort((a, b) => a - b)
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
      : it.commands.map((c) => {
          if (c.op === "unsupported")
            return { op: "unsupported", name: c.name };
          const f = cmdF.length;
          cmdF.push(...c.rect, ...c.color);
          return { op: "add_rect", aa: c.aa ?? false, f };
        });
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
      removed_canvases: removedCanvases,
      removed_items: removedItems,
      canvases: canvasMetas,
      items: itemMetas,
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

/** A whole recording: magic, session, one transaction per state (seq 1..N), end record. */
export function encodeRs1Recording(
  states: readonly TState[],
  opts: RecordingEncodeOptions,
): Buffer {
  const records: Buffer[] = [encodeSession(opts)];
  let prev: TState | undefined;
  let full = 0;
  let patch = 0;
  states.forEach((raw, i) => {
    const seq = i + 1;
    const state =
      opts.encoding === "patch" && opts.mutatePatch
        ? opts.mutatePatch(seq, raw)
        : raw;
    const asPatch =
      opts.encoding === "patch" &&
      prev !== undefined &&
      !(opts.fullAt ?? []).includes(seq);
    records.push(encodeTransaction(seq, state, asPatch ? prev : undefined));
    if (asPatch) patch++;
    else full++;
    prev = raw;
  });
  const bytesTotal = MAGIC1.length + records.reduce((n, r) => n + r.length, 0);
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
          },
          blocks: [],
        },
        [],
      ),
    );
  }
  return Buffer.concat([MAGIC1, ...records]);
}
