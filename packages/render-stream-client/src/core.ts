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
  type GswRs,
  type GswRsModule,
  type LiveCoding,
  STAT_FIELDS,
} from "./abi";
import type { ExtensionCore } from "./extensions";
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
  /** TAG1: an item_meta record (identities for extensions): nothing to apply, no ack. */
  | { kind: "item_meta" }
  /** W11t: a based message that did not decode: ask the host for a `coding` resync. */
  | { kind: "coding-resync"; seq: number; error: string };

/** The session record's parts the loop reads (`GswRs.session_meta`). */
export interface SessionMeta {
  session_id?: string;
  stream?: { stream_id?: string };
  viewport?: { presentation_size?: [number, number] | null };
  resources?: { fetch?: string; http_path?: string | null };
  publication?: { credit_window?: number } | null;
}

export interface StreamCore {
  /** A fresh connection: a fresh live-coding decoder (W11c: one per connection). */
  beginConnection(): void;
  /** One binary message: decoded (W11t), then the session (a connection's first) or one record.
   * Throws `StreamFailure`. */
  receive(data: ArrayBuffer, sessionSeen: boolean): CoreMessage;
  /** GTS: the coding skipped transactions; the next full may jump the seq. */
  transportSkip(): void;
  /** A fresh applier over the whole resolved state (inheriting the GPU residency, GRH); returns
   * the newest transaction's needed set. */
  rebuild(seq: number): Needed[];
  /** W11c `inline-fetch-zero`: "" when a GET of `hash` is allowed, else the refusal. */
  checkFetch(hash: string): string;
  /** G7o2: a fetched body, verified and decoded on arrival; the refusal, or null. */
  stage(hash: string, bytes: Uint8Array): string | null;
  isStaged(hash: string): boolean;
  /** The next needed payload from the stage into the store; the refusal, or null. */
  provideStaged(): string | null;
  /** A staged payload into the store out of needed order (a fold's leftover, a restore). */
  takeStaged(hash: string): string | null;
  /** Programs for the accepted state's shaders, and the /12 particles step (before `apply`). */
  prepareApply(seq: number): void;
  apply(seq: number): void;
  draw(seq: number): void;
  /** G7u: the redraw after a context restore; "lost" when the context was lost again. */
  redraw(seq: number): "ok" | "lost";
  /** G7u: resident payloads the store no longer holds (to refetch before the redraw). */
  restoreMissing(): string[];
  /** A fresh session on the next message (a reconnect); payloads kept when `keepPayloads`. */
  reset(keepPayloads: boolean): void;
  heapBytes(): number;
  dispose(): void;
}

const STAT_SEQ = STAT_FIELDS.indexOf("seq");
const STAT_FRAME = STAT_FIELDS.indexOf("frame");
const STAT_ENCODING = STAT_FIELDS.indexOf("encoding");

const hex = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
};

/** `StreamCore` over one `GswRs` instance and its memory. */
export class WasmStreamCore implements StreamCore, ExtensionCore {
  private coding: LiveCoding | null = null;
  private particles = new GswParticles();
  private readonly programs: ProgramCounts = {
    defined: 0,
    refused: 0,
    library_reads: 0,
  };
  private lastAcceptedSeq = 0;
  private statsView: Uint32Array | null = null;
  private disposed = false;

  constructor(
    private readonly mod: GswRsModule,
    private readonly memory: WebAssembly.Memory,
    private readonly g: GswRs,
    private readonly protocol: 11 | 12 | 13,
    private readonly liveCoding: string,
    private readonly inboundBytes: number,
  ) {}

  beginConnection(): void {
    this.coding?.free();
    this.coding =
      this.liveCoding !== ""
        ? new this.mod.LiveCoding(this.liveCoding, this.inboundBytes)
        : null;
    this.lastAcceptedSeq = 0;
  }

  receive(data: ArrayBuffer, sessionSeen: boolean): CoreMessage {
    const g = this.g;
    let len = data.byteLength;
    // Q14c step 1: one copy into wasm's receive buffer (the pointer after rx(), which may grow).
    const p = g.rx(len);
    new Uint8Array(this.memory.buffer, p, len).set(new Uint8Array(data));
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
    // W13c: a patch dropped while a predict-check resync awaits its full.
    if (code === ACCEPT_HELD) return { kind: "held" };
    if (code === ACCEPT_ITEM_META) return { kind: "item_meta" };
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

  isStaged(hash: string): boolean {
    return this.g.is_staged(hash);
  }

  provideStaged(): string | null {
    return this.g.provide_staged() < 0 ? this.g.error() : null;
  }

  takeStaged(hash: string): string | null {
    return this.g.restore_take(hash) < 0 ? this.g.error() : null;
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
    this.g.live_reset(keepPayloads);
    this.lastAcceptedSeq = 0;
  }

  heapBytes(): number {
    return this.disposed ? 0 : this.memory.buffer.byteLength;
  }

  // TAG2: the extension host's calls (never made by a client with no extension).

  itemMetaJson(): string {
    return this.g.item_meta_json();
  }

  setLogRemoved(on: boolean): void {
    this.g.set_log_removed(on);
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

  queryItem(id: number): ArrayLike<number> {
    return this.g.query_item(id);
  }

  querySubtreeRect(id: number): ArrayLike<number> {
    return this.g.query_subtree_rect(id);
  }

  queryChildren(id: number): Uint32Array {
    return this.g.query_children(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.coding?.free();
    this.coding = null;
    this.g.free();
    this.statsView = null;
  }

  private seqOrNull(): number | null {
    return this.lastAcceptedSeq > 0 ? this.lastAcceptedSeq : null;
  }

  /** The stats block (lib.rs `Stats`), its view re-derived whenever memory grew (Q14c step 5). */
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
