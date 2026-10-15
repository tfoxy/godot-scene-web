// GSW receiver evidence (gate7-design.md Q5 "Evidence", D10, G7a): applied.json in the native
// receiver's file-mode shape (`render-stream-receiver-applied/7`, receiver.gd `_init_report`),
// shots as 8-bit RGBA PNGs read back from the RGB10_A2 target, state dumps as the native receiver
// writes them (the wasm module spells them, Godot's floats included), every file PUT to the
// harness. Every encode and PUT happens after the frame that produced it, outside the timers.
//
// Fields the native receiver fills from RenderingServer counters (rs_calls, reparented,
// meshes_rebuilt, surface_updates, shader_code_sets, param_sets, canvas_attach,
// canvas_stacking_sets, ...) have no GSW meaning and are `null` here; window_size and oversampling
// are the canvas's. Everything a gate checker reads is filled by the same rule as natively.

import type { ReceiverConfig } from "./config";
import type { FetchEntry } from "./source";

export const APPLIED_SCHEMA = "render-stream-receiver-applied/7";

export async function put(
  cfg: ReceiverConfig,
  rel: string,
  body: BodyInit,
): Promise<void> {
  const res = await fetch(`${cfg.evidenceUrl}/${rel}`, { method: "PUT", body });
  if (!res.ok) throw new Error(`PUT ${rel}: HTTP ${res.status}`);
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
  transactions: {
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
    };
  }[];
  uploads: {
    id: number;
    hash: string | null;
    op: string;
    data_bytes: number;
    stream: number;
    seq: number;
  }[];
  unsupported: {
    seq: number | null;
    item: number | null;
    name: string;
    reason: string;
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
}

export interface Shot {
  stream: number;
  seq: number;
  step: null;
  path: string;
  state_path: string | null;
  process_frame: number;
  applied_through: number;
}

export interface Report {
  cfg: ReceiverConfig;
  recording: { path: string; sha256: string | null; bytes: number | null };
  sessionId: string | null;
  stream: Record<string, unknown> | null;
  status: "ok" | "replay-failure";
  failure: { seq: number | null; reason: string; detail: string } | null;
  endSeen: boolean;
  viewport: Record<string, unknown>;
  shots: Shot[];
  /** Session-level typed entries (seq null), before the per-transaction ones. */
  sessionUnsupported: RustParts["unsupported"];
  rust: RustParts | null;
  shell: Map<number, ShellTx>;
  fetches: FetchEntry[];
  distinctFetched: number;
}

/** applied.json, keys in receiver.gd's order (`_init_report`, `_write_report`). */
export function appliedJson(r: Report): Record<string, unknown> {
  const full = r.cfg.log === "full";
  const rust = r.rust ?? { transactions: [], uploads: [], unsupported: [] };
  const transactions = rust.transactions.map((t) => {
    const s = r.shell.get(t.seq);
    return {
      stream: 1,
      seq: t.seq,
      frame: t.frame,
      encoding: t.encoding,
      record_sha256: t.record_sha256,
      process_frame: s?.process_frame ?? null,
      created: t.created,
      freed: t.freed,
      reparented: null,
      commands_replayed: t.commands_replayed,
      msdf_commands: t.msdf_commands,
      mesh_commands: t.mesh_commands,
      rs_calls: null,
      received_us: null,
      applied_us: null,
      submitted_us: null,
      skipped: null,
      resources: {
        fetched: s?.fetched ?? 0,
        fetched_bytes: s?.fetched_bytes ?? 0,
        cache_hits: 0,
        inline_received: s?.inline_received ?? 0,
        created: t.resources.created,
        updated: t.resources.updated,
        replaced: t.resources.replaced,
        freed: t.resources.freed,
        upload_bytes: t.resources.upload_bytes,
        fetch_us: Math.round(s?.fetch_us ?? 0),
        skipped_commands: null,
        meshes_created: null,
        meshes_rebuilt: null,
        surface_updates: null,
        mesh_upload_bytes: null,
        skipped_mesh_commands: null,
        shaders_created: null,
        shader_code_sets: null,
        shader_payload_fetches: s?.shader_payload_fetches ?? 0,
        materials_created: null,
        param_sets: null,
        instance_param_sets: null,
        canvases_created: t.resources.canvases_created,
        canvas_attach: null,
        canvas_stacking_sets: null,
      },
    };
  });
  const sum = (f: (t: (typeof transactions)[number]) => number) =>
    transactions.reduce((n, t) => n + f(t), 0);
  const counted = rust.uploads.filter((u) => u.op !== "placeholder");
  return {
    schema: APPLIED_SCHEMA,
    receiver: {
      kind: "gsw-canvas",
      build_sha256: r.cfg.buildSha256,
      manifest_sha256: r.cfg.manifestSha256,
      protocol: "render-stream/6",
      credit_window: null,
    },
    mode: "file",
    recording: r.recording,
    session_id: r.sessionId,
    streams: r.stream ? [r.stream] : [],
    status: r.status,
    failure: r.failure,
    end_seen: r.endSeen,
    viewport: r.viewport,
    transactions: full ? transactions : null,
    shots: r.shots,
    shots_missed: [],
    unsupported: [...r.sessionUnsupported, ...rust.unsupported],
    live: null,
    cache: {
      dir: null,
      mode: "http-cache",
      entries_before: null,
      entries_after: null,
      bytes_after: null,
    },
    fetches: full ? r.fetches : null,
    uploads: full ? rust.uploads : null,
    mesh_uploads: full ? [] : null,
    resources_summary: {
      distinct_fetched: r.distinctFetched,
      fetched_bytes: sum((t) => t.resources.fetched_bytes),
      cache_hits: 0,
      uploads: counted.length,
      upload_bytes: counted.reduce((n, u) => n + u.data_bytes, 0),
      meshes_created: null,
      meshes_rebuilt: null,
      surface_updates: null,
      mesh_upload_bytes: null,
      shaders_created: null,
      shader_code_sets: null,
      shader_payload_fetches: sum((t) => t.resources.shader_payload_fetches),
      materials_created: null,
      param_sets: null,
      instance_param_sets: null,
      canvases_created: sum((t) => t.resources.canvases_created ?? 0),
      canvas_attach: null,
      canvas_stacking_sets: null,
      evictions_memory: 0,
      evictions_disk: 0,
      refetch_after_evict: 0,
    },
  };
}
