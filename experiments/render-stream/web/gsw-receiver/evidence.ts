// GSW receiver evidence (gate7-design.md Q5 "Evidence", D10, G7a): applied.json in the native
// receiver's file-mode shape (`render-stream-receiver-applied/7`, receiver.gd `_init_report`) and,
// since G7l, its live-mode shape (`_ready_live`, `_live_report`, per-transaction receipt entries),
// shots as 8-bit RGBA PNGs read back from the RGB10_A2 target, state dumps as the native receiver
// writes them (the wasm module spells them, Godot's floats included), every file PUT to the
// harness. Every encode and PUT happens after the frame that produced it, outside the timers.
//
// Fields the native receiver fills from RenderingServer counters (rs_calls, reparented, ...) have
// no GSW meaning and are `null` here; window_size and oversampling are the canvas's. Everything a
// gate checker reads is filled by the same rule as natively; G7t adds the mesh residency's
// `mesh_uploads` rows and counters (meshes_created, meshes_rebuilt, surface_updates,
// mesh_upload_bytes), G7s the shader and material counters, and G7g canvas_attach and
// canvas_stacking_sets (the applier's count of rs_applier.gd `_apply_canvas`'s calls).

import type { ReceiverConfig } from "./config";
import type { FetchEntry } from "./source";

export const APPLIED_SCHEMA = "render-stream-receiver-applied/7";

/** P3-HX: a PUT body larger than this is sent as several `?part=k&of=n` PUTs. Chromium reports a
 * request body to the automation client whole, so one 367 MB applied.json at STS2 scale overran
 * Playwright's 512 MB pipe-message limit (`ERR_STRING_TOO_LONG`); the harness server appends the
 * parts byte for byte and answers the last one (the one a held-PUT screenshot waits on) after the
 * file is complete. */
export const PUT_PART_BYTES = 8 * 1024 * 1024;

export async function put(
  cfg: ReceiverConfig,
  rel: string,
  body: BodyInit | string[],
): Promise<void> {
  const send = async (url: string, b: BodyInit): Promise<void> => {
    const res = await fetch(url, { method: "PUT", body: b });
    if (!res.ok) throw new Error(`PUT ${rel}: HTTP ${res.status}`);
  };
  const url = `${cfg.evidenceUrl}/${rel}`;
  if (typeof body === "string" && body.length <= PUT_PART_BYTES / 4)
    return send(url, body);
  if (
    (body instanceof Blob && body.size <= PUT_PART_BYTES) ||
    (body instanceof Uint8Array && body.length <= PUT_PART_BYTES)
  )
    return send(url, body as BodyInit);
  // Large body: cut it into byte parts. Strings and string lists are UTF-8 encoded piecewise (a
  // part boundary may fall anywhere: the server concatenates raw bytes).
  const parts: Blob[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const flush = (): void => {
    if (pendingBytes === 0) return;
    parts.push(new Blob(pending as BlobPart[]));
    pending = [];
    pendingBytes = 0;
  };
  const enc = new TextEncoder();
  const addBytes = (b: Uint8Array): void => {
    for (let o = 0; o < b.length; o += PUT_PART_BYTES) {
      const piece = b.subarray(o, Math.min(b.length, o + PUT_PART_BYTES));
      pending.push(piece);
      pendingBytes += piece.length;
      if (pendingBytes >= PUT_PART_BYTES) flush();
    }
  };
  const addString = (str: string): void => {
    // 1M-char slices (never splitting a surrogate pair) bound the encoder's output.
    const step = 1 << 20;
    for (let o = 0; o < str.length; ) {
      let end = Math.min(str.length, o + step);
      if (end < str.length) {
        const c = str.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end++;
      }
      addBytes(enc.encode(str.slice(o, end)));
      o = end;
    }
  };
  if (Array.isArray(body)) for (const s of body) addString(s);
  else if (typeof body === "string") addString(body);
  else if (body instanceof Uint8Array) addBytes(body);
  else if (body instanceof Blob) {
    for (let o = 0; o < body.size; o += PUT_PART_BYTES)
      parts.push(body.slice(o, o + PUT_PART_BYTES));
  } else throw new Error(`PUT ${rel}: unsupported large body`);
  flush();
  if (parts.length === 0) parts.push(new Blob([]));
  for (let k = 0; k < parts.length; k++)
    await send(`${url}?part=${k}&of=${parts.length}`, parts[k]);
}

/** `JSON.stringify(value, null, 2)` as string pieces whose concatenation is byte-equal to it,
 * built without ever holding the whole text as one string (V8 caps a string at 2^29-24 chars;
 * the STS2-scale applied.json is 367 MB). Arrays and objects with at least `minEntries` entries
 * are split per entry; anything smaller is stringified whole. */
export function prettyJsonParts(value: unknown, minEntries = 64): string[] {
  const out: string[] = [];
  const walk = (v: unknown, pad: string): void => {
    const inner = `${pad}  `;
    if (Array.isArray(v) && v.length >= minEntries) {
      out.push("[\n");
      v.forEach((e, i) => {
        out.push(inner);
        const skip =
          e === undefined || typeof e === "function" || typeof e === "symbol";
        walk(skip ? null : e, inner);
        out.push(i + 1 < v.length ? ",\n" : "\n");
      });
      out.push(`${pad}]`);
      return;
    }
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof (v as { toJSON?: unknown }).toJSON !== "function"
    ) {
      const entries = Object.entries(v as Record<string, unknown>).filter(
        ([, x]) =>
          x !== undefined && typeof x !== "function" && typeof x !== "symbol",
      );
      if (entries.length >= minEntries || entries.some(([, x]) => isBig(x))) {
        out.push("{\n");
        entries.forEach(([k, x], i) => {
          out.push(`${inner}${JSON.stringify(k)}: `);
          walk(x, inner);
          out.push(i + 1 < entries.length ? ",\n" : "\n");
        });
        out.push(`${pad}}`);
        return;
      }
    }
    // JSON text never holds a raw newline inside a string, so re-indenting by line is exact.
    out.push((JSON.stringify(v, null, 2) ?? "null").replace(/\n/g, `\n${pad}`));
  };
  const isBig = (x: unknown, depth = 0): boolean => {
    if (Array.isArray(x)) return x.length >= minEntries;
    if (
      x === null ||
      typeof x !== "object" ||
      depth >= 3 ||
      typeof (x as { toJSON?: unknown }).toJSON === "function"
    )
      return false;
    return Object.values(x).some((y) => isBig(y, depth + 1));
  };
  walk(value, "");
  return out;
}

// ------------------------------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit RGBA PNG of `rgba` (rows top-down), zlib through the platform's CompressionStream. */
export async function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new Uint8Array((4 * width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (4 * width + 1)] = 0;
    raw.set(
      rgba.subarray(4 * width * y, 4 * width * (y + 1)),
      y * (4 * width + 1) + 1,
    );
  }
  const zlib = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------- applied.json

/** The wasm module's applied.json parts (`GswRs::applied_json_parts`). */
export interface RustParts {
  /** G8g: the float payload formats taken as RGBA8 (rs-core's quantization) and the caveat. */
  float_quantized?: string[];
  caveats?: string[];
  transactions: {
    /** G7l: the connection (1 in file mode). */
    stream?: number;
    seq: number;
    frame: number;
    encoding: string;
    record_sha256: string | null;
    created: number;
    freed: number;
    commands_replayed: number;
    msdf_commands: number;
    mesh_commands: number;
    resources: {
      created: number;
      updated: number;
      replaced: number;
      freed: number;
      upload_bytes: number;
      canvases_created: number;
      /** G7g: rs_applier.gd `_apply_canvas`'s attach/remove and stacking calls. */
      canvas_attach: number;
      canvas_stacking_sets: number;
      /** G7s: the native receiver's /5 shader and material counters. */
      shaders_created: number;
      shader_code_sets: number;
      materials_created: number;
      param_sets: number;
      instance_param_sets: number;
      /** G7t: native mesh residency's counters (applied.json `resources`). */
      meshes_created?: number;
      meshes_rebuilt?: number;
      surface_updates?: number;
      mesh_upload_bytes?: number;
    };
  }[];
  /** G7t: native mesh residency's rows (`rs_applier.gd` `_apply_meshes`). */
  mesh_uploads?: {
    id: number;
    op: string;
    surfaces: number[];
    buffers: string[];
    bytes: number;
    stream: number;
    seq: number;
  }[];
  uploads: {
    id: number;
    hash: string | null;
    op: string;
    data_bytes: number;
    stream: number;
    seq: number;
    /** G8kp: D3's choice (`decoded` or `block`), at /9 only. */
    encoding?: string;
  }[];
  unsupported: {
    seq: number | null;
    item: number | null;
    name: string;
    reason: string;
    /** G7s: a shader drawn without its code (`shader-withheld`, `gsw-shader-transpile`). */
    shader?: number;
    detail?: string;
  }[];
}

/** What the shell tracks per applied transaction (the fetcher's side and the frame). */
export interface ShellTx {
  fetched: number;
  fetched_bytes: number;
  fetch_us: number;
  inline_received: number;
  shader_payload_fetches: number;
  process_frame: number;
  /** G7l live: payloads taken from the page's payload cache (the cache directory's stand-in). */
  cache_hits?: number;
}

export interface Shot {
  stream: number;
  seq: number;
  step: number | null;
  /** RS_RECEIVER_SHOT_FINAL's shot (live). */
  final?: true;
  /** Live: the wire frame of the shot's transaction (G6s). */
  frame?: number;
  path: string;
  state_path: string | null;
  process_frame: number;
  applied_through: number;
}

/** G7l: one received transaction (live), in receipt order, as receiver.gd's `_transaction_entry`
 * keeps it: the applier's facts are merged in from the wasm parts by (stream, seq) when written. */
export interface LiveEntry {
  stream: number;
  seq: number;
  frame: number;
  encoding: string;
  record_sha256: string;
  received_us: number;
  /** G7mm: the rAF callback that would first handle the record (processFrames + 1 at receipt) */
  received_process_frame: number;
  applied_us: number | null;
  submitted_us: number | null;
  /** G7mm: processFrames of the callback that sent the `submitted` ack */
  submitted_process_frame: number | null;
  skipped: string | null;
  /** G7q (credit window 2 only): the seq this transaction was applied and drawn with, when the
   * receiver applied several queued transactions in one callback (only the last is drawn). */
  coalesced_into?: number;
  /** Q9 `credit-from-paced-loop` evidence (GSW only): the rAF callback that applied and drew
   * this transaction (its index and timestamp), and when its `submitted` ack was sent and from
   * where (`raf`, or `onmessage` under the `ack-on-receipt` sabotage). */
  paced: {
    received_ms: number;
    applied_raf: number | null;
    applied_raf_ts_ms: number | null;
    applied_ms: number | null;
    drawn_raf: number | null;
    drawn_ms: number | null;
    submitted_ack_ms: number | null;
    submitted_from: "raf" | "onmessage" | null;
  };
}

export interface Report {
  cfg: ReceiverConfig;
  mode: "file" | "live";
  recording: { path: string; sha256: string | null; bytes: number | null };
  sessionId: string | null;
  /** One per connection (file mode: the recording). */
  streams: Record<string, unknown>[];
  status: "ok" | "replay-failure";
  failure: { seq: number | null; reason: string; detail: string } | null;
  endSeen: boolean;
  viewport: Record<string, unknown>;
  shots: Shot[];
  shotsMissed: number[];
  /** Session-level typed entries (seq null), before the per-transaction ones. */
  sessionUnsupported: RustParts["unsupported"];
  rust: RustParts | null;
  /** Keyed `<stream>:<seq>`. */
  shell: Map<string, ShellTx>;
  /** File mode's store reads (source.ts) or live mode's HTTP fetches (live.ts). */
  fetches: (FetchEntry | Record<string, unknown>)[];
  distinctFetched: number;
  /** Live: the `live` block (receiver.gd `_live_report`), the protocol and the granted window. */
  live: Record<string, unknown> | null;
  entries: LiveEntry[] | null;
  protocol:
    | "render-stream/6"
    | "render-stream/7"
    | "render-stream/8"
    | "render-stream/9"
    | "render-stream/10";
  creditWindow: number | null;
  /** G8kp: at /9, the module's `delivery_json()` (what this receiver states and selects with). */
  textureDelivery?: Record<string, unknown> | null;
  /** G8kb: every KTX2 transcode (transcode.ts `TranscodeRow`) and every `delivery-transcode-failed`
   * fallback to `decoded` (`FallbackRow`), written at /9 as `transcodes[]`, `delivery_fallbacks[]`. */
  transcodes?: unknown[];
  deliveryFallbacks?: unknown[];
  /** Live: the page payload cache's block (null: file mode's `http-cache`). */
  cache?: Record<string, unknown> | null;
  /** G7k (Q10 soak), live mode only: the `PayloadStore`'s cumulative eviction count at the last
   * residency sample (`perf.ts` `Perf.residencyEvictions`). `null`/undefined (file mode, or no
   * residency sample was ever taken) reports as 0, the native receiver's own default. */
  residencyEvictions?: number | null;
}

type RustTx = RustParts["transactions"][number];

function resourcesOf(t: RustTx | undefined, s: ShellTx | undefined) {
  return {
    fetched: s?.fetched ?? 0,
    fetched_bytes: s?.fetched_bytes ?? 0,
    cache_hits: s?.cache_hits ?? 0,
    inline_received: s?.inline_received ?? 0,
    created: t?.resources.created ?? 0,
    updated: t?.resources.updated ?? 0,
    replaced: t?.resources.replaced ?? 0,
    freed: t?.resources.freed ?? 0,
    upload_bytes: t?.resources.upload_bytes ?? 0,
    fetch_us: Math.round(s?.fetch_us ?? 0),
    skipped_commands: null,
    meshes_created: t?.resources.meshes_created ?? null,
    meshes_rebuilt: t?.resources.meshes_rebuilt ?? null,
    surface_updates: t?.resources.surface_updates ?? null,
    mesh_upload_bytes: t?.resources.mesh_upload_bytes ?? null,
    skipped_mesh_commands: null,
    shaders_created: t?.resources.shaders_created ?? 0,
    shader_code_sets: t?.resources.shader_code_sets ?? 0,
    shader_payload_fetches: s?.shader_payload_fetches ?? 0,
    materials_created: t?.resources.materials_created ?? 0,
    param_sets: t?.resources.param_sets ?? 0,
    instance_param_sets: t?.resources.instance_param_sets ?? 0,
    canvases_created: t?.resources.canvases_created ?? 0,
    canvas_attach: t?.resources.canvas_attach ?? 0,
    canvas_stacking_sets: t?.resources.canvas_stacking_sets ?? 0,
  };
}

/** applied.json, keys in receiver.gd's order (`_init_report`, `_write_report`). */
export function appliedJson(r: Report): Record<string, unknown> {
  const full = r.cfg.log === "full";
  const rust = r.rust ?? { transactions: [], uploads: [], unsupported: [] };
  const byKey = new Map<string, RustTx>();
  for (const t of rust.transactions) byKey.set(`${t.stream ?? 1}:${t.seq}`, t);
  const appliedEntry = (t: RustTx | undefined, s: ShellTx | undefined) => ({
    process_frame: s?.process_frame ?? null,
    created: t ? t.created : null,
    freed: t ? t.freed : null,
    reparented: null,
    commands_replayed: t ? t.commands_replayed : null,
    msdf_commands: t ? t.msdf_commands : null,
    mesh_commands: t ? t.mesh_commands : null,
    rs_calls: null,
  });
  const transactions =
    r.entries === null
      ? rust.transactions.map((t) => {
          const s = r.shell.get(`${t.stream ?? 1}:${t.seq}`);
          return {
            stream: t.stream ?? 1,
            seq: t.seq,
            frame: t.frame,
            encoding: t.encoding,
            record_sha256: t.record_sha256,
            ...appliedEntry(t, s),
            received_us: null,
            applied_us: null,
            submitted_us: null,
            skipped: null,
            resources: resourcesOf(t, s) as ReturnType<
              typeof resourcesOf
            > | null,
          };
        })
      : r.entries.map((e) => {
          const key = `${e.stream}:${e.seq}`;
          const t = e.applied_us === null ? undefined : byKey.get(key);
          const s = e.applied_us === null ? undefined : r.shell.get(key);
          const applied = t !== undefined;
          return {
            stream: e.stream,
            seq: e.seq,
            frame: e.frame,
            encoding: e.encoding,
            record_sha256: e.record_sha256,
            ...appliedEntry(t, s),
            received_us: e.received_us,
            received_process_frame: e.received_process_frame,
            applied_us: e.applied_us,
            submitted_us: e.submitted_us,
            submitted_process_frame: e.submitted_process_frame,
            skipped: e.skipped,
            // G7q (credit window 2 only): applied and drawn with this later seq.
            ...(e.coalesced_into !== undefined
              ? { coalesced_into: e.coalesced_into }
              : {}),
            resources: applied ? resourcesOf(t, s) : null,
            paced: e.paced,
          };
        });
  const applied = transactions.filter((t) => t.resources !== null);
  const sum = (
    f: (t: ReturnType<typeof resourcesOf>) => number | null,
  ): number =>
    applied.reduce(
      (n, t) => n + (f(t.resources as ReturnType<typeof resourcesOf>) ?? 0),
      0,
    );
  const counted = rust.uploads.filter((u) => u.op !== "placeholder");
  return {
    schema: APPLIED_SCHEMA,
    receiver: {
      kind: "gsw-canvas",
      build_sha256: r.cfg.buildSha256,
      manifest_sha256: r.cfg.manifestSha256,
      protocol: r.protocol,
      credit_window: r.creditWindow,
      ...(r.textureDelivery ? { texture_delivery: r.textureDelivery } : {}),
      // G8g: `float-texture-quantized` when a float payload was drawn as RGBA8, with its formats.
      caveats: rust.caveats ?? [],
      float_quantized: rust.float_quantized ?? [],
    },
    mode: r.mode,
    ...(r.textureDelivery
      ? { transcodes: r.transcodes ?? [], delivery_fallbacks: r.deliveryFallbacks ?? [] }
      : {}),
    recording: r.recording,
    session_id: r.sessionId,
    streams: r.streams,
    status: r.status,
    failure: r.failure,
    end_seen: r.endSeen,
    viewport: r.viewport,
    transactions: full ? transactions : null,
    shots: r.shots,
    shots_missed: r.shotsMissed,
    unsupported: [...r.sessionUnsupported, ...rust.unsupported],
    live: r.live,
    cache: r.cache ?? {
      dir: null,
      mode: "http-cache",
      entries_before: null,
      entries_after: null,
      bytes_after: null,
    },
    fetches: full ? r.fetches : null,
    uploads: full ? rust.uploads : null,
    mesh_uploads: full ? (rust.mesh_uploads ?? []) : null,
    resources_summary: {
      distinct_fetched: r.distinctFetched,
      fetched_bytes: sum((t) => t.fetched_bytes),
      cache_hits: sum((t) => t.cache_hits),
      uploads: counted.length,
      upload_bytes: counted.reduce((n, u) => n + u.data_bytes, 0),
      meshes_created: sum((t) => t.meshes_created),
      meshes_rebuilt: sum((t) => t.meshes_rebuilt),
      surface_updates: sum((t) => t.surface_updates),
      mesh_upload_bytes: sum((t) => t.mesh_upload_bytes),
      shaders_created: sum((t) => t.shaders_created),
      shader_code_sets: sum((t) => t.shader_code_sets),
      shader_payload_fetches: sum((t) => t.shader_payload_fetches),
      materials_created: sum((t) => t.materials_created),
      param_sets: sum((t) => t.param_sets),
      instance_param_sets: sum((t) => t.instance_param_sets),
      canvases_created: sum((t) => t.canvases_created),
      canvas_attach: sum((t) => t.canvas_attach),
      canvas_stacking_sets: sum((t) => t.canvas_stacking_sets),
      // G7k (Q10 soak): live mode's PayloadStore evictions; file mode never evicts (0, as
      // natively). There is no disk tier (GSW has no cache directory) and no HTTP re-fetch of a
      // hash this receiver evicted, by protocol (a carried hash is never resent, memory
      // g6s-carried-set-resource-duplicate): an evicted hash needed again is GET-fetched, the
      // same fetch path any other missing payload uses, so it is never a `refetch_after_evict`.
      evictions_memory: r.residencyEvictions ?? 0,
      evictions_disk: 0,
      refetch_after_evict: 0,
    },
  };
}
