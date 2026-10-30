// The wasm ABI of `rs-gsw-wasm` (experiments/render-stream/web/gsw-rs/src/lib.rs, wasm-bindgen
// `--target web`): the surface the client and the harness receiver (web/gsw-receiver/) drive, its
// accept codes and its stats block. MIR-1 moved these from the harness's common.ts so that the ABI
// has one owner; the harness imports them from here.

/** The wasm-bindgen surface of `rs-gsw-wasm` (web/gsw-rs/src/lib.rs). */
export interface GswRs {
  alloc_recording(len: number): number;
  load(len: number): number;
  start(): number;
  accept(index: number): number;
  needed_count(): number;
  needed_ptr(): number;
  needed_kinds_ptr(): number;
  alloc_payload(len: number): number;
  provide(len: number): number;
  /** G7o2: verify and decode a payload on arrival / provide the next needed one from there. */
  stage_payload(len: number, hash: string): number;
  provide_staged(): number;
  /** G8kb: a KTX2 (uastc) payload: verified, transcoded in the worker, staged; or refused. */
  is_ktx2(hash: string): boolean;
  stage_ktx2(len: number, hash: string): number;
  stage_transcoded(len: number, hash: string, format: string): number;
  transcode_failed(hash: string): number;
  payload_verify_json(): string;
  apply(): number;
  draw(): number;
  /** GLJ: `{arena, shared}`, the texture bytes the last draw took from the draw list's byte arena
   * (copied by apply) and from the payload store's own bytes (shared). */
  last_upload_bytes_json(): string;
  stats_ptr(): number;
  digest(): number;
  poll_fence(): number;
  shot(): number;
  target_width(): number;
  target_height(): number;
  error(): string;
  session_meta(): string;
  /** G8kp: `{texture_encodings, gpu_formats, gpu_formats_detected, gpu_format_mask}` after start. */
  delivery_json(): string;
  // G7g: the window this receiver presents into, and how it adopted the session's presentation.
  set_window(width: number, height: number): void;
  presentation_json(): string;
  state_dump(): string;
  applied_json_parts(): string;
  evidence_json(): string;
  shader_params_jsonl(): string;
  pending_shaders(): number;
  pending_hash(i: number): string;
  pending_shader_id(i: number): bigint;
  pending_withheld(i: number): boolean;
  pending_code(i: number): string | undefined;
  provide_library(i: number, len: number): number;
  define_program(
    i: number,
    glsl: string,
    meta: string,
    vertexGlsl: string,
  ): number;
  refuse_program(i: number, reason: string, detail: string): number;
  // G7l live mode.
  rx(len: number): number;
  live_session(len: number, version: number): number;
  live_accept(len: number): number;
  last_digest_ptr(): number;
  live_rebuild(): number;
  /** GTS: a coding resync skipped transactions; the next full may jump the seq. */
  transport_skip(): void;
  dispose_json(): string;
  live_reset(keepPayloads: boolean): number;
  memory_hashes(): string;
  // G7u: the in-place context restore (D14, D29).
  restore_missing(): string;
  restore_take(hash: string): number;
  /** Whether a payload is staged (verified on arrival, not yet in the store). */
  is_staged(hash: string): boolean;
  restore_json(): string;
  // G7k (Q10 soak): live mode's residency and budget (D29 amendment).
  residency_json(): string;
  /** W11c: "" when a GET of the hash is allowed, else the `inline-fetch-zero` refusal. */
  check_fetch(hash: string): string;
  // PM6b: /12 GPU particles (particles.ts).
  particles_sync(): string;
  shader_time(): number;
  particles_set(id: number, data: Float32Array): void;
  free(): void;
}

export interface GswRsModule {
  default(init: {
    module_or_path: BufferSource | WebAssembly.Module;
  }): Promise<{ memory: WebAssembly.Memory }>;
  GswRs: { new (canvas: HTMLCanvasElement, options: string): GswRs };
  /** W11t: rs-core's live-coding decoder (gsw-rs live_coding.rs). */
  LiveCoding: { new (offer: string, maxBytes: number): LiveCoding };
}

/** W11t (gsw-rs `LiveCoding`): decodes each /11 live message in place in a GswRs's rx buffer. */
export interface LiveCoding {
  decode_rx(g: GswRs, len: number): number;
  error(): string;
  seq(): number;
  stats_json(): string;
  free(): void;
}

export const ACCEPT_TRANSACTION = 0;
export const ACCEPT_RESOURCE = 1;
export const ACCEPT_END = 2;
export const ACCEPT_NEEDS_PAYLOADS = 3;
/** W13c: a /13 patch dropped while a `predict-check` resync awaits its full (no apply, no ack). */
export const ACCEPT_HELD = 4;
/** TAG1: a /13 `item_meta` record (client-extensions-design.md §2.4): the core holds it for its
 * transaction; nothing to apply, nothing to ack, not a transaction. */
export const ACCEPT_ITEM_META = 5;

/** lib.rs `Stats`, `#[repr(C)]`, all u32, in this order. */
export const STAT_FIELDS = [
  "status",
  "seq",
  "frame",
  "needed",
  "structural",
  "relowered",
  "rows_written",
  "lowered_draws",
  "assembly_skips",
  "emitted_draws",
  "expected_calls",
  "executed_calls",
  "merged_draws",
  "texture_uploads",
  "texture_upload_bytes",
  "item_bytes",
  "vertex_bytes",
  "index_bytes",
  "parity_violations",
  "accepted_records",
  "digests_pending",
  "vertices",
  "indices",
  "draws",
  "encoding",
  "stream",
] as const;
export type StatName = (typeof STAT_FIELDS)[number];

/** A reader of the stats block, its view re-derived whenever memory grew (Q14c step 5). */
export function statsReader(
  g: GswRs,
  mem: WebAssembly.Memory,
): () => Record<StatName, number> {
  let view: Uint32Array | null = null;
  let buffer: ArrayBuffer | null = null;
  return () => {
    if (buffer !== mem.buffer || !view) {
      buffer = mem.buffer;
      view = new Uint32Array(mem.buffer, g.stats_ptr(), STAT_FIELDS.length);
    }
    const out = {} as Record<StatName, number>;
    STAT_FIELDS.forEach((k, i) => {
      out[k] = (view as Uint32Array)[i];
    });
    return out;
  };
}

/** The GswRs methods the client calls: a glue missing any of them is a stale or foreign core
 * (`core-load-failed`). */
export const CLIENT_CORE_METHODS = [
  "rx",
  "live_session",
  "live_accept",
  "live_rebuild",
  "live_reset",
  "transport_skip",
  "needed_count",
  "needed_ptr",
  "needed_kinds_ptr",
  "alloc_payload",
  "stage_payload",
  "provide_staged",
  "is_staged",
  "restore_take",
  "restore_missing",
  "check_fetch",
  "apply",
  "draw",
  "stats_ptr",
  "error",
  "session_meta",
  "set_window",
  "pending_shaders",
  "pending_hash",
  "pending_shader_id",
  "pending_withheld",
  "pending_code",
  "provide_library",
  "define_program",
  "refuse_program",
  "particles_sync",
  "shader_time",
  "particles_set",
  "free",
] as const satisfies readonly (keyof GswRs)[];
