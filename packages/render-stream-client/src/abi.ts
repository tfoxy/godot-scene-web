// The wasm ABI of `rs-gsw-wasm` (experiments/render-stream/web/gsw-rs/src/lib.rs, wasm-bindgen
// `--target web`): the surface the client and the harness receiver (web/gsw-receiver/) drive, its
// accept codes and its stats block. The ABI has one owner; the harness imports it from here.

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
  /** Verify and decode a payload on arrival / provide the next needed one from there. */
  stage_payload(len: number, hash: string): number;
  provide_staged(): number;
  /** A payload staged as its body arrives, piece by piece, in its own buffer: begin (the id,
   * or -1), per piece a pointer then a commit (hashed there), then finish (verify, decode,
   * stage; -1 on a refusal) or abort. `stream_count` is the streams open. */
  stream_begin(hash: string, sizeHint: number): number;
  stream_chunk_ptr(id: number, len: number): number;
  stream_commit(id: number, len: number): number;
  stream_finish(id: number): number;
  stream_abort(id: number): void;
  stream_count(): number;
  /** A KTX2 (uastc) payload: verified, transcoded in the worker, staged; or refused. */
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
  /** `{texture_encodings, gpu_formats, gpu_formats_detected, gpu_format_mask}` after start. */
  delivery_json(): string;
  // The window this receiver presents into, and how it adopted the session's presentation.
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
  // Live mode.
  rx(len: number): number;
  /** The receive buffer's current pointer (after `decode_rx`; `rx()` may have grown it). */
  rx_ptr(): number;
  live_session(len: number, version: number): number;
  live_accept(len: number): number;
  last_digest_ptr(): number;
  live_rebuild(): number;
  /** A coding resync skipped transactions; the next full may jump the seq. */
  transport_skip(): void;
  dispose_json(): string;
  live_reset(keepPayloads: boolean): number;
  memory_hashes(): string;
  // The in-place context restore.
  restore_missing(): string;
  restore_take(hash: string): number;
  /** The bounded resource hold: a needed payload the apply goes without (0, or -1 `error`). */
  defer_payload(hash: string): number;
  names_mask(hashesHex: string): Uint8Array;
  drop_staged(hash: string): boolean;
  restore_unavailable(hash: string): number;
  /** The deferred payloads now in the store made drawable with no transaction (1: applied). */
  revisit(): number;
  deferred_count(): number;
  /** Whether a payload is staged (verified on arrival, not yet in the store). */
  is_staged(hash: string): boolean;
  restore_json(): string;
  // Live mode's residency and budget.
  residency_json(): string;
  /** W11c: "" when a GET of the hash is allowed, else the `inline-fetch-zero` refusal. */
  check_fetch(hash: string): string;
  // PM6b: /12 GPU particles (particles.ts).
  particles_sync(): string;
  shader_time(): number;
  particles_set(id: number, data: Float32Array): void;
  // Client extensions (render-stream-13.md `item_meta`).
  item_meta_json(): string;
  // render-stream/15 resource hints (only a `resourceHints` client calls these).
  /** The hint or unhint record just accepted: its meta JSON as received. */
  hint_json(): string;
  /** Bit 0: the payload is in the store or staged; bit 1: the accepted state names it. */
  hint_state(hash: string): number;
  /** The hinted hashes the last accepted transaction's upserted textures carry (64 hex each,
   * concatenated). */
  hint_refs(): string;
  set_log_removed(on: boolean): void;
  take_removed(): Uint32Array;
  set_overrides(ids: Uint32Array, vals: Float32Array): number;
  refresh_overrides(): number;
  /** 1 when the item's row was written at `query_item_ptr()` (14 f64), 0 for no such item. */
  query_item(id: number): number;
  query_item_ptr(): number;
  /** 1 visible, 0 not, 2 no such item. */
  item_visible(id: number): number;
  /** Room for a batch of `n` u32 ids; returns its address. */
  query_ids(n: number): number;
  /** The batch's rows (14 f64 per id); returns their address. */
  query_items(n: number): number;
  /** The batch's visibility bytes (1, 0, 2 as `item_visible`); returns their address. */
  items_visible(n: number): number;
  /** Moves whenever an item query may answer differently. */
  query_epoch(): number;
  query_subtree_rect(id: number): Float64Array;
  query_children(id: number): Uint32Array;
  // Pointer mapping.
  hit_test(x: number, y: number): number;
  to_game(x: number, y: number): Float64Array;
  // The mouse filters hit tests pick by (1 STOP/PASS, 2 IGNORE or not a Control).
  set_hit_filters(ids: Uint32Array, filters: Uint8Array): number;
  // The order hit tests pick by (0 topmost-drawn order, 1 Godot's GUI tree order).
  set_pick_order(order: number): number;
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
/** A /13 `item_meta` record (render-stream-13.md): the core holds it for its
 * transaction; nothing to apply, nothing to ack, not a transaction. */
export const ACCEPT_ITEM_META = 5;
/** A /15 `resource_hint` record (render-stream-15.md "Resource hints"): advisory; nothing to
 * apply, nothing to ack, not a transaction. */
export const ACCEPT_RESOURCE_HINT = 6;
/** A /15 `resource_unhint` record. */
export const ACCEPT_RESOURCE_UNHINT = 7;

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
  "why",
  "back_buffer_items",
] as const;
export type StatName = (typeof STAT_FIELDS)[number];

/** A reader of the stats block, its view re-derived whenever memory grew. */
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
  "rx_ptr",
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
  "defer_payload",
  "names_mask",
  "drop_staged",
  "restore_unavailable",
  "revisit",
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
  "item_meta_json",
  "hint_json",
  "hint_state",
  "hint_refs",
  "set_log_removed",
  "take_removed",
  "set_overrides",
  "refresh_overrides",
  "query_item",
  "query_item_ptr",
  "item_visible",
  "query_ids",
  "query_items",
  "items_visible",
  "query_epoch",
  "query_subtree_rect",
  "query_children",
  "hit_test",
  "to_game",
  "set_hit_filters",
  "set_pick_order",
  "free",
] as const satisfies readonly (keyof GswRs)[];
