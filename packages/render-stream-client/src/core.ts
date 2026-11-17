// The core seam: what the protocol loop (loop.ts) asks of the wasm core, in the loop's own terms,
// and its implementation over `rs-gsw-wasm` (abi.ts). The loop is tested against a fake of
// `StreamCore`; `WasmStreamCore` is the one thin adapter that touches wasm memory. It is the
// harness receiver's (web/gsw-receiver/live.ts) wasm calls, in its order, minus every evidence read.

import {
  ACCEPT_END,
  ACCEPT_HELD,
  ACCEPT_ITEM_META,
  ACCEPT_NEEDS_PAYLOADS,
  ACCEPT_RESOURCE,
  ACCEPT_RESOURCE_HINT,
  type GswRs,
  type GswRsModule,
  type LiveCoding,
  STAT_FIELDS,
} from "./abi";
import type { RenderStreamProtocol } from "./endpoint";
import { type ExtensionCore, ITEM_ROW_STRIDE } from "./extensions";
import type { ResourceHintRecord } from "./hints";
import { GswParticles } from "./particles";
import { definePrograms, type ProgramCounts, ProgramError } from "./programs";

/** A typed failure: the receiver's reason names (`host-error`, `resource-unavailable`, ...) and
 * the wasm's own codes, with the seq it happened at when there is one. */
export class StreamFailure extends Error {
  override name = "StreamFailure";
  constructor(
    readonly seq: number | null,
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
  }
}

/** A wasm error string `code: detail` as a failure (receiver.gd `_fail_with_error`). */
export function failWith(seq: number | null, error: string): StreamFailure {
  const at = error.indexOf(": ");
  return at < 0
    ? new StreamFailure(seq, error, "")
    : new StreamFailure(seq, error.slice(0, at), error.slice(at + 2));
}

/** A payload a transaction needs, hex SHA-256 and kind (0 texture, 1 mesh, 2 shader, 3 KTX2). */
export interface Needed {
  hash: string;
  kind: number;
}

/** What one binary message was. */
export type CoreMessage =
  | { kind: "session"; meta: SessionMeta }
  | {
      kind: "transaction";
      seq: number;
      frame: number;
      full: boolean;
      needed: Needed[];
    }
  | { kind: "resource" }
  | { kind: "end" }
  /** W11t: a based transaction while a coding resync is pending (no apply, no ack). */
  | { kind: "held" }
  /** An item_meta record (identities for extensions): nothing to apply, no ack. */
  | { kind: "item_meta" }
  /** W11t: a based message that did not decode: ask the host for a `coding` resync. */
  | { kind: "coding-resync"; seq: number; error: string }
  /** A /15 `resource_hint` (render-stream-15.md): advisory, nothing to apply, no ack. `held`:
   * the payload is already in the store or staged; `named`: the accepted state already names
   * it (the hint trails its first reference). */
  | { kind: "hint"; hint: ResourceHintRecord; held: boolean; named: boolean }
  /** A /15 `resource_unhint`: the host stops serving `hash` under the pin rule. */
  | { kind: "unhint"; hash: string };

/** The session record's parts the loop reads (`GswRs.session_meta`). */
export interface SessionMeta {
  session_id?: string;
  stream?: { stream_id?: string };
  viewport?: {
    presentation_size?: [number, number] | null;
    logical_size?: [number, number] | null;
  };
  resources?: { fetch?: string; http_path?: string | null };
  publication?: { credit_window?: number } | null;
}

export interface StreamCore {
  /** A fresh connection: a fresh live-coding decoder (W11c: one per connection). */
  beginConnection(protocol: RenderStreamProtocol): void;
  /** One binary message: decoded (W11t), then the session (a connection's first) or one record.
   * Throws `StreamFailure`. `copyDecoded` (only when a recorder is on) copies the decoded
   * bytes out of wasm so `takeDecoded` can hand them to the recorder. */
  receive(
    data: ArrayBuffer,
    sessionSeen: boolean,
    copyDecoded?: boolean,
  ): CoreMessage;
  /** A copy of the last decoded message's bytes (`receive` with `copyDecoded` true), or
   * null. The pure client never asks, so it never copies. */
  takeDecoded(): Uint8Array | null;
  /** /15: the hinted hashes the last accepted transaction's upserted textures carry. Absent:
   * the loop learns no reference of a hinted hash. */
  hintRefs?(): string[];
  /** The coding skipped transactions; the next full may jump the seq. */
  transportSkip(): void;
  /** A fresh applier over the whole resolved state (inheriting the GPU residency); returns
   * the newest transaction's needed set. */
  rebuild(seq: number): Needed[];
  /** W11c `inline-fetch-zero`: "" when a GET of `hash` is allowed, else the refusal. */
  checkFetch(hash: string): string;
  /** A fetched body, verified and decoded on arrival; the refusal, or null. */
  stage(hash: string, bytes: Uint8Array): string | null;
  /** A fetched body staged as it arrives, each chunk hashed when written, with no copy of
   * the whole body; `sizeHint` (its `Content-Length`, 0 when unknown) sizes the buffer only.
   * Absent: the fetcher stages whole bodies through `stage`. */
  stageStream?(hash: string, sizeHint: number): StagingStream;
  isStaged(hash: string): boolean;
  /** The next needed payload from the stage into the store; the refusal, or null. */
  provideStaged(): string | null;
  /** A staged payload into the store out of needed order (a fold's leftover, a restore, a
   * deferred payload's arrival). */
  takeStaged(hash: string): string | null;
  /** The loop stops waiting for the needed payload `hash` (still being fetched, or unavailable):
   * the apply goes ahead without it and what draws it is not drawn until it is in the store
   * (`takeStaged`). Shader code too: its materials' draws are omitted (never shaderless) until
   * the code arrives and compiles. The refusal (not needed), or null. In needed order with
   * `provideStaged`. */
  deferPayload(hash: string): string | null;
  /** With nothing accepted and unapplied: makes the deferred payloads now in the store drawable
   * (programs for arrived shader code first, then an apply of no change over the same state), or
   * re-lowers what `restoreUnavailable` took out; true when it applied (the caller draws). */
  revisit(seq: number): boolean;
  /** Names membership over the newest accepted state, one byte per hash (1 named by any entry
   * or variant, else 0): the loop asks it for the payloads it tracks, after each accepted
   * transaction, only while it tracks any. A protocol without the names (below /11) answers 1. */
  named(hashes: readonly string[]): Uint8Array;
  /** A staged payload nothing uses any more (an obsolete download that completed) is dropped
   * unprovided; whether one was. */
  dropStaged(hash: string): boolean;
  /** A context restore cannot fetch the resident payload `hash` again: what was resident from it
   * leaves residency (never drawn from stale contents) and the next `revisit` (nothing accepted
   * and unapplied) or apply re-lowers what draws it. The refusal, or null. */
  restoreUnavailable(hash: string): string | null;
  /** Programs for the accepted state's shaders, and the /12 particles step (before `apply`). */
  prepareApply(seq: number): void;
  apply(seq: number): void;
  /** What the last `apply` did to the draw list, read after it (`RenderStreamStats`). The
   * returned object may be reused by the next call. Absent: the loop reports none. */
  applyStats?(): CoreApplyStats;
  draw(seq: number): void;
  /** The redraw after a context restore; "lost" when the context was lost again. */
  redraw(seq: number): "ok" | "lost";
  /** Resident payloads the store no longer holds (to refetch before the redraw). */
  restoreMissing(): string[];
  /** A fresh session on the next message (a reconnect); payloads kept when `keepPayloads`. */
  reset(keepPayloads: boolean): void;
  heapBytes(): number;
  dispose(): void;
}

/** `StreamCore.applyStats`: the core's apply diagnostics (lib.rs `Stats`). */
export interface CoreApplyStats {
  /** The apply walked the item tree and re-assembled the draw list. */
  structural: boolean;
  /** Why it walked or re-assembled: `RenderStreamStats.lastApplyWhy`. */
  why: number;
  /** Items holding a canvas group or a back-buffer copy. */
  backBufferItems: number;
}

/** One payload being staged as it arrives (`StreamCore.stageStream`). After `finish` or `abort`
 * nothing more is written; an unfinished stream must be aborted, which frees its buffer. */
export interface StagingStream {
  /** The body's next bytes (copied into wasm and hashed now). */
  write(chunk: Uint8Array): void;
  /** The body is complete: verified and decoded as `stage` would; the refusal, or null. */
  finish(): string | null;
  abort(): void;
}

/** `queryItem`'s answer for an item the state does not hold. */
const NO_ROW: ArrayLike<number> = new Float64Array(0);

/** `n` rows of an item the state does not hold: no parent, nothing else. */
function fillUnknownRows(out: Float64Array, n: number): void {
  out.fill(0, 0, n * ITEM_ROW_STRIDE);
  for (let k = 0; k < n; k++) out[k * ITEM_ROW_STRIDE] = -1;
}

const STAT_SEQ = STAT_FIELDS.indexOf("seq");
const STAT_FRAME = STAT_FIELDS.indexOf("frame");
const STAT_ENCODING = STAT_FIELDS.indexOf("encoding");
const STAT_STRUCTURAL = STAT_FIELDS.indexOf("structural");
const STAT_WHY = STAT_FIELDS.indexOf("why");
const STAT_BACK_BUFFER_ITEMS = STAT_FIELDS.indexOf("back_buffer_items");

const hex = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
};

/** `StreamCore` over a replaceable `GswRs` instance and its module memory. */
export class WasmStreamCore implements StreamCore, ExtensionCore {
  private instance: GswRs | null = null;
  private logRemoved = false;
  private coding: LiveCoding | null = null;
  private particles = new GswParticles();
  private readonly programs: ProgramCounts = {
    defined: 0,
    refused: 0,
    library_reads: 0,
  };
  private lastAcceptedSeq = 0;
  private statsView: Uint32Array | null = null;
  private readonly applied: CoreApplyStats = {
    structural: false,
    why: 0,
    backBufferItems: 0,
  };
  /** The view of `query_item`'s scratch row, re-derived on a new instance or memory growth. */
  private itemView: Float64Array | null = null;
  /** `queryEpoch` = base + the instance's epoch; a new instance starts past the last answer. */
  private epochBase = 1;
  private epochLast = 1;
  private disposed = false;
  /** The decoded bytes of the last `receive`, only when `copyDecoded` asked. */
  private decoded: Uint8Array | null = null;

  constructor(
    private readonly mod: GswRsModule,
    private readonly memory: WebAssembly.Memory,
    private readonly build: (protocol: RenderStreamProtocol) => GswRs,
    private protocol: RenderStreamProtocol,
    private readonly liveCoding: string,
    private readonly inboundBytes: number,
  ) {
    this.instance = build(protocol);
  }

  private get g(): GswRs {
    if (this.instance === null)
      throw new Error("the stream core is unavailable");
    return this.instance;
  }

  beginConnection(protocol = this.protocol): void {
    if (this.disposed) throw new Error("the stream core is disposed");
    this.coding?.free();
    this.coding = null;
    if (this.instance === null || protocol !== this.protocol) {
      const old = this.instance;
      this.instance = null;
      old?.free();
      this.statsView = null;
      this.retireQueries();
      this.decoded = null;
      this.lastAcceptedSeq = 0;
      this.particles = new GswParticles();
      this.programs.defined = 0;
      this.programs.refused = 0;
      this.programs.library_reads = 0;
      const next = this.build(protocol);
      try {
        if (this.logRemoved) next.set_log_removed(true);
      } catch (e) {
        next.free();
        throw e;
      }
      this.instance = next;
      this.protocol = protocol;
    }
    this.coding =
      this.liveCoding !== ""
        ? new this.mod.LiveCoding(this.liveCoding, this.inboundBytes)
        : null;
    this.lastAcceptedSeq = 0;
  }

  receive(
    data: ArrayBuffer,
    sessionSeen: boolean,
    copyDecoded = false,
  ): CoreMessage {
    const g = this.g;
    let len = data.byteLength;
    // One copy into wasm's receive buffer (the pointer after rx(), which may grow).
    const p = g.rx(len);
    new Uint8Array(this.memory.buffer, p, len).set(new Uint8Array(data));
    this.decoded = null;
    if (this.coding !== null) {
      const n = this.coding.decode_rx(g, len);
      if (n === 0) return { kind: "held" };
      if (n < 0) {
        const seq = this.coding.seq();
        const error = this.coding.error();
        if (seq === 0) throw failWith(this.seqOrNull(), error);
        return { kind: "coding-resync", seq, error };
      }
      len = n;
    }
    // A recorder copies the decoded record out of wasm (decode may have grown rx, so read
    // the pointer again). The pure client passes `copyDecoded` false and copies nothing.
    if (copyDecoded) {
      this.decoded = new Uint8Array(
        this.memory.buffer,
        g.rx_ptr(),
        len,
      ).slice();
    }
    if (!sessionSeen) {
      this.particles = new GswParticles();
      if (g.live_session(len, this.protocol) < 0)
        throw failWith(null, g.error());
      return { kind: "session", meta: JSON.parse(g.session_meta()) };
    }
    const code = g.live_accept(len);
    if (code < 0) {
      const err = g.error();
      if (err.startsWith("live-framing")) throw failWith(null, err);
      const seq = failureSeq(data, this.lastAcceptedSeq + 1);
      // W13c (render-stream-13.md "Decoding and check order"): a /13 transaction whose
      // reconstructed blocks miss predict_check applied nothing; it resyncs as a coding failure,
      // and the core drops the patches before the full (ACCEPT_HELD).
      if (err.startsWith("predict-check"))
        return {
          kind: "coding-resync",
          seq:
            this.coding !== null
              ? this.coding.seq()
              : (seq ?? this.lastAcceptedSeq + 1),
          error: err,
        };
      throw failWith(seq, err);
    }
    // One compare for a transaction (0 or 3) to pass the codes from ACCEPT_HELD up.
    if (code >= ACCEPT_HELD) {
      // W13c: a patch dropped while a predict-check resync awaits its full.
      if (code === ACCEPT_HELD) return { kind: "held" };
      if (code === ACCEPT_ITEM_META) return { kind: "item_meta" };
      return this.hintMessage(code === ACCEPT_RESOURCE_HINT);
    }
    if (code === ACCEPT_RESOURCE) return { kind: "resource" };
    if (code === ACCEPT_END) return { kind: "end" };
    const st = this.stats();
    const seq = st[STAT_SEQ];
    this.lastAcceptedSeq = seq;
    return {
      kind: "transaction",
      seq,
      frame: st[STAT_FRAME],
      full: st[STAT_ENCODING] === 0,
      needed: this.readNeeded(code),
    };
  }

  /** The hint or unhint record just accepted (render-stream-15.md "Records"; the core checked
   * every key, so the meta is read as is). */
  private hintMessage(hint: boolean): CoreMessage {
    const g = this.g;
    const m = JSON.parse(g.hint_json()) as Record<string, unknown>;
    const hash = m.hash as string;
    if (!hint) return { kind: "unhint", hash };
    const state = g.hint_state(hash);
    return {
      kind: "hint",
      hint: {
        hash,
        format: m.format as string,
        sourceFormat: m.source_format as string | null,
        width: m.width as number,
        height: m.height as number,
        mipmaps: m.mipmaps as boolean,
        payloadBytes: m.payload_bytes as number,
        variants: (m.variants as Record<string, unknown>[]).map((v) => ({
          encoding: v.encoding as string,
          hash: v.hash as string,
          payloadBytes: v.payload_bytes as number,
          format: (v.format as string | undefined) ?? null,
        })),
        path: m.path as string | null,
        cause: m.cause as ResourceHintRecord["cause"],
        priority: m.priority as number,
      },
      held: (state & 1) !== 0,
      named: (state & 2) !== 0,
    };
  }

  hintRefs(): string[] {
    const s = this.g.hint_refs();
    const out: string[] = [];
    for (let i = 0; i + 64 <= s.length; i += 64) out.push(s.slice(i, i + 64));
    return out;
  }

  transportSkip(): void {
    this.g.transport_skip();
  }

  rebuild(seq: number): Needed[] {
    const code = this.g.live_rebuild();
    if (code < 0) throw failWith(seq, this.g.error());
    return this.readNeeded(code);
  }

  checkFetch(hash: string): string {
    return this.g.check_fetch(hash);
  }

  stage(hash: string, bytes: Uint8Array): string | null {
    const ptr = this.g.alloc_payload(bytes.length);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    return this.g.stage_payload(bytes.length, hash) < 0 ? this.g.error() : null;
  }

  stageStream(hash: string, sizeHint: number): StagingStream {
    const g = this.g;
    const id = g.stream_begin(hash, Math.max(0, Math.floor(sizeHint)) >>> 0);
    let refused = id < 0 ? g.error() : null;
    let open = id > 0;
    // A reconnect that rebuilt the instance (or a dispose) dropped the stream with it.
    const live = (): boolean => open && this.instance === g;
    const memory = this.memory;
    return {
      write(chunk) {
        if (!live() || chunk.length === 0) return;
        const ptr = g.stream_chunk_ptr(id, chunk.length);
        if (ptr === 0) {
          open = false; // a reset dropped it
          refused = "resource-unavailable: the payload stream was dropped";
          return;
        }
        // The view is taken after the reservation, which may have grown the memory.
        new Uint8Array(memory.buffer, ptr, chunk.length).set(chunk);
        g.stream_commit(id, chunk.length);
      },
      finish() {
        if (!live())
          return (
            refused ?? "resource-unavailable: the payload stream was dropped"
          );
        open = false;
        return g.stream_finish(id) < 0 ? g.error() : null;
      },
      abort() {
        if (live()) g.stream_abort(id);
        open = false;
      },
    };
  }

  isStaged(hash: string): boolean {
    return this.g.is_staged(hash);
  }

  provideStaged(): string | null {
    return this.g.provide_staged() < 0 ? this.g.error() : null;
  }

  takeStaged(hash: string): string | null {
    return this.g.restore_take(hash) < 0 ? this.g.error() : null;
  }

  deferPayload(hash: string): string | null {
    return this.g.defer_payload(hash) < 0 ? this.g.error() : null;
  }

  revisit(seq: number): boolean {
    // Shader code that arrived compiles before the apply that draws its materials; a process
    // shader's arrival re-creates its emitters, which the next apply steps (no host time passed
    // here, so nothing is stepped or uploaded).
    try {
      definePrograms(this.g, this.programs);
    } catch (e) {
      if (e instanceof ProgramError)
        throw new StreamFailure(seq, e.reason, e.message);
      throw e;
    }
    this.particles.syncOnly(this.g);
    return this.g.revisit() > 0;
  }

  named(hashes: readonly string[]): Uint8Array {
    if (hashes.length === 0) return new Uint8Array(0);
    return this.g.names_mask(hashes.join(""));
  }

  dropStaged(hash: string): boolean {
    return this.g.drop_staged(hash);
  }

  restoreUnavailable(hash: string): string | null {
    return this.g.restore_unavailable(hash) < 0 ? this.g.error() : null;
  }

  prepareApply(seq: number): void {
    try {
      definePrograms(this.g, this.programs);
    } catch (e) {
      if (e instanceof ProgramError)
        throw new StreamFailure(seq, e.reason, e.message);
      throw e;
    }
    this.particles.step(this.g);
  }

  apply(seq: number): void {
    if (this.g.apply() < 0) throw failWith(seq, this.g.error());
  }

  draw(seq: number): void {
    if (this.g.draw() < 0) throw failWith(seq, this.g.error());
  }

  redraw(seq: number): "ok" | "lost" {
    if (this.g.draw() >= 0) return "ok";
    const err = this.g.error();
    if (/lost/i.test(err)) return "lost";
    throw failWith(seq, err);
  }

  restoreMissing(): string[] {
    const missing = this.g.restore_missing();
    return missing === "" ? [] : missing.split(",");
  }

  reset(keepPayloads: boolean): void {
    this.instance?.live_reset(keepPayloads);
    this.lastAcceptedSeq = 0;
  }

  heapBytes(): number {
    return this.instance === null ? 0 : this.memory.buffer.byteLength;
  }

  // The recorder's one copy per received message, made only when asked (`copyDecoded`).

  takeDecoded(): Uint8Array | null {
    return this.decoded;
  }

  // The extension host's calls (never made by a client with no extension).

  itemMetaJson(): string {
    return this.g.item_meta_json();
  }

  setLogRemoved(on: boolean): void {
    this.logRemoved = on;
    this.instance?.set_log_removed(on);
  }

  takeRemoved(): Uint32Array {
    return this.g.take_removed();
  }

  setOverrides(ids: Uint32Array, vals: Float32Array): void {
    if (this.g.set_overrides(ids, vals) < 0)
      throw failWith(this.seqOrNull(), this.g.error());
  }

  refreshOverrides(): number {
    return this.g.refresh_overrides();
  }

  /** A view of the core's one scratch row (no copy, no allocation): valid until the next
   * `queryItem` on this core. */
  queryItem(id: number): ArrayLike<number> {
    const g = this.instance;
    if (g === null || g.query_item(id) === 0) return NO_ROW;
    let v = this.itemView;
    if (v === null || v.buffer !== this.memory.buffer) {
      v = new Float64Array(
        this.memory.buffer,
        g.query_item_ptr(),
        ITEM_ROW_STRIDE,
      );
      this.itemView = v;
    }
    return v;
  }

  itemVisible(id: number): boolean {
    return this.instance !== null && this.instance.item_visible(id) === 1;
  }

  queryItems(ids: ArrayLike<number>, out: Float64Array): void {
    const g = this.instance;
    const n = ids.length;
    if (g === null) {
      fillUnknownRows(out, n);
      return;
    }
    if (n === 0) return;
    new Uint32Array(this.memory.buffer, g.query_ids(n), n).set(ids);
    const p = g.query_items(n);
    out.set(new Float64Array(this.memory.buffer, p, n * ITEM_ROW_STRIDE));
  }

  itemsVisible(ids: ArrayLike<number>, out: Uint8Array): void {
    const g = this.instance;
    const n = ids.length;
    if (g === null || n === 0) {
      out.fill(0, 0, n);
      return;
    }
    new Uint32Array(this.memory.buffer, g.query_ids(n), n).set(ids);
    const v = new Uint8Array(this.memory.buffer, g.items_visible(n), n);
    for (let k = 0; k < n; k++) out[k] = v[k] === 1 ? 1 : 0;
  }

  /** Strictly greater on a new instance than anything the old one answered. */
  queryEpoch(): number {
    const g = this.instance;
    const e = this.epochBase + (g === null ? 0 : g.query_epoch());
    this.epochLast = e;
    return e;
  }

  querySubtreeRect(id: number): ArrayLike<number> {
    return this.instance?.query_subtree_rect(id) ?? [];
  }

  queryChildren(id: number): Uint32Array {
    return this.instance?.query_children(id) ?? new Uint32Array(0);
  }

  // On demand only; nothing here runs per frame. A failed rebuild has no instance to query.

  hitTest(x: number, y: number): number | null {
    const id = this.instance?.hit_test(x, y) ?? -1;
    return id < 0 ? null : id;
  }

  /** The mouse filters `hitTest` / `toGame` pick by, whole (1 STOP/PASS, 2 IGNORE). */
  setHitFilters(ids: Uint32Array, filters: Uint8Array): void {
    const g = this.instance;
    if (g && g.set_hit_filters(ids, filters) < 0)
      throw failWith(this.seqOrNull(), g.error());
  }

  /** The order `hitTest` / `toGame` pick by: topmost-drawn order, or Godot's GUI tree order. */
  setPickOrder(order: "drawn" | "tree"): void {
    const g = this.instance;
    if (g && g.set_pick_order(order === "tree" ? 1 : 0) < 0)
      throw failWith(this.seqOrNull(), g.error());
  }

  /** `[item (-1: none), x, y]` of the drawn point mapped to the game's, or empty (a singular
   * override). */
  toGame(x: number, y: number): ArrayLike<number> {
    return this.instance?.to_game(x, y) ?? [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.coding?.free();
    this.coding = null;
    this.instance?.free();
    this.instance = null;
    this.statsView = null;
    this.retireQueries();
    this.decoded = null;
  }

  /** The instance is going: its scratch view dies and the next epoch starts past its last. */
  private retireQueries(): void {
    this.itemView = null;
    this.epochBase = this.epochLast + 1;
    this.epochLast = this.epochBase;
  }

  private seqOrNull(): number | null {
    return this.lastAcceptedSeq > 0 ? this.lastAcceptedSeq : null;
  }

  applyStats(): CoreApplyStats {
    const st = this.stats();
    const out = this.applied;
    out.structural = st[STAT_STRUCTURAL] !== 0;
    out.why = st[STAT_WHY];
    out.backBufferItems = st[STAT_BACK_BUFFER_ITEMS];
    return out;
  }

  /** The stats block (lib.rs `Stats`), its view re-derived whenever memory grew. */
  private stats(): Uint32Array {
    if (this.statsView === null || this.statsView.buffer !== this.memory.buffer)
      this.statsView = new Uint32Array(
        this.memory.buffer,
        this.g.stats_ptr(),
        STAT_FIELDS.length,
      );
    return this.statsView;
  }

  private readNeeded(code: number): Needed[] {
    if (code !== ACCEPT_NEEDS_PAYLOADS) return [];
    const g = this.g;
    const n = g.needed_count();
    const hashes = new Uint8Array(this.memory.buffer, g.needed_ptr(), 32 * n);
    const kinds = new Uint8Array(this.memory.buffer, g.needed_kinds_ptr(), n);
    const out: Needed[] = [];
    for (let k = 0; k < n; k++)
      out.push({
        hash: hex(hashes.subarray(32 * k, 32 * k + 32)),
        kind: kinds[k],
      });
    return out;
  }
}

/** A failing record's seq (receiver.gd `_receive_binary`): its meta's integer `seq` for a
 * transaction (or a record that did not decode), else the next expected seq; null for a resource
 * or end record. Read from the message's own meta JSON, off the frame path. */
export function failureSeq(buf: ArrayBuffer, expected: number): number | null {
  try {
    const v = new DataView(buf);
    const metaLen = v.getUint32(4, true);
    const meta = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buf, 8, metaLen)),
    ) as { type?: string; seq?: unknown };
    if (meta.type === "resource" || meta.type === "end") return null;
    return Number.isInteger(meta.seq) ? (meta.seq as number) : expected;
  } catch {
    return expected;
  }
}
