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
  MOTION_FIELDS,
  STAT_FIELDS,
  statsWords,
} from "./abi";
import type { RenderStreamProtocol } from "./endpoint";
import { type ExtensionCore, ITEM_ROW_STRIDE } from "./extensions";
import type { ResourceHintRecord } from "./hints";
import {
  CLIENT_PARTICLE_PACING,
  GswParticles,
  type ParticleBurstPacing,
} from "./particles";
import {
  definePrograms,
  LIVE_PROGRAM_BUDGET,
  type ProgramCounts,
  ProgramError,
} from "./programs";
import {
  StagingCounters,
  type StagingKind,
  type StagingSample,
  type StagingStats,
  stagingSample,
} from "./staging";

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

/** A hint selected with the same delivery preferences as a demand payload. */
export interface HintSelection {
  hash: string;
  encoding: string;
  bytes: number;
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
  | { kind: "tween" }
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
  /** Prepare the context after opening transport; older cores do this at the session. */
  prepareExecutor?(): void;
  /** One preparation slice; true once done. Draw synchronously finishes any remainder. */
  prepareStep?(): boolean;
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
  /** The demand selector's choice for a hint; null when unsupported or no longer hinted. */
  hintSelect?(hash: string): HintSelection | null;
  /** The coding skipped transactions; the next full may jump the seq. */
  transportSkip(): void;
  /** A fresh applier over the whole resolved state (inheriting the GPU residency); returns
   * the newest transaction's needed set. */
  rebuild(seq: number): Needed[];
  /** W11c `inline-fetch-zero`: "" when a GET of `hash` is allowed, else the refusal. */
  checkFetch(hash: string): string;
  /** A fetched body, verified and decoded on arrival; the refusal, or null. */
  stage(hash: string, bytes: Uint8Array, sample?: StagingSample): string | null;
  stagingStats?(): StagingStats;
  /** A fetched body staged as it arrives, each chunk hashed when written, with no copy of
   * the whole body; `sizeHint` (its `Content-Length`, 0 when unknown) sizes the buffer only.
   * `workerDigest` is only for exclusively owned bytes hashed before worker transfer; the
   * requested `hash` remains independent. Absent: whole bodies through `stage`. */
  stageStream?(
    hash: string,
    sizeHint: number,
    sample?: StagingSample,
    workerDigest?: string,
  ): StagingStream;
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
  /** J1: settle the shader programs whose links run in the driver's background, once per frame
   * callback and before its applier run. True when one settled: the next apply draws its
   * materials (omitted until then), or with nothing accepted and unapplied a `revisit`. Absent
   * (or a core that links synchronously): never anything to settle. */
  pollPrograms?(): boolean;
  /** J1: a frame callback with no applier run: particle bursts in progress continue (no host time
   * passes), and one that ends is applied over the same state, as is a shader-pin toggle.
   * True when that applied (the caller draws). Absent: bursts advance only with applies. */
  settleParticles?(seq: number): boolean;
  /** Suspend off-frame particle work during context loss. */
  pauseParticles?(paused: boolean): void;
  /** Restart GPU emitters in the selected client simulation mode. */
  setStaticParticles?(on: boolean): void;
  /** Pin material TIME while particle simulation keeps the carried clock. */
  setStaticShaders?(on: boolean): void;
  setDrawBatching?(mask: number): void;
  setDamageRedraw?(on: boolean): void;
  setCoverTiles?(on: boolean): void;
  tweensActive?(): boolean;
  tweenTick?(nowMs: number, picture: boolean): boolean;
  tweenDiagnostics?(): Record<string, number>;
  apply(seq: number): void;
  /** What the last `apply` did to the draw list, read after it (`RenderStreamStats`). The
   * returned object may be reused by the next call. Absent: the loop reports none. */
  applyStats?(): CoreApplyStats;
  /** Last successful draw's damage diagnostics, if supported; the object may be reused. */
  damageStats?(): Readonly<CoreDamageStats> | undefined;
  /** Measure each accepted transaction's motion (`motion`), or stop; kept across connections.
   * Returns whether the core can (a core built before the measure cannot). Absent: it cannot. */
  setMotion?(on: boolean): boolean;
  /** The last accepted transaction's motion facts, read right after `receive` answered it; null
   * while not measuring. The returned object may be reused by the next call. */
  motion?(): CoreMotion | null;
  draw(seq: number): void;
  /** The redraw after a context restore; "lost" when the context was lost again. */
  redraw(seq: number): "ok" | "lost";
  /** Resident payloads the store no longer holds (to refetch before the redraw). */
  restoreMissing(): string[];
  /** A fresh session on the next message (a reconnect); payloads kept when `keepPayloads`. */
  reset(keepPayloads: boolean): void;
  heapBytes(): number;
  /** Custom shader counters, absent on cores that do not report them. */
  programCounts?(): Readonly<ProgramCounts>;
  dispose(): void;
}

export interface CoreDamageStats {
  mode: number;
  us: number;
  permille: number;
  regions: number;
}

/** `StreamCore.applyStats`: the core's apply diagnostics (lib.rs `Stats`). */
export interface CoreApplyStats {
  /** The apply walked the item tree and re-assembled the draw list. */
  structural: boolean;
  /** Why it walked or re-assembled: `RenderStreamStats.lastApplyWhy`. */
  why: number;
  /** Items holding a canvas group or a back-buffer copy. */
  backBufferItems: number;
  /** render-stream/16 viewport surfaces after the apply (`RenderStreamStats.surfacesRendered` and
   * the four after it); absent from a core without them. */
  surfacesRendered?: number;
  surfacesSkipped?: number;
  surfacesUnchanged?: number;
  surfacesAllocated?: number;
  surfacePixels?: number;
}

/** `StreamCore.motion`: one transaction's motion facts (rs-core `motion::TxMotion`). */
export interface CoreMotion {
  /** The transaction they describe. */
  seq: number;
  /** rs-core `motion::Change` bits: 1 full, 2 structure (added, removed, reparented, reordered),
   * 4 visibility, 8 content (commands other than positions and colours), 16 appearance
   * (material, clip, a clipping custom rect, filter, groups, a changed viewport entry), 32
   * resource (texture, shader, material, a static mesh, a multimesh's or emitter's
   * configuration, defaults), 64 reshape (a dynamic body or multimesh buffer that cannot be
   * measured: another vertex count, other UVs or indices, drawn by a multimesh or particles,
   * custom data a material reads), 128 viewport (content a sub-viewport draws), 256 unmeasured
   * (a multimesh buffer or static geometry the receiver did not measure). 0: only positions and
   * colours moved. */
  changes: number;
  /** The largest displacement of changed visible scene content (items, canvases, an emitter's
   * transform), in presentation px (a bound; may be `Infinity`). */
  maxPx: number;
  /** The largest step of a modulate or colour channel of the scene content (0..1). */
  colorStep: number;
  /** The same two over animation content: dynamic mesh bodies (skeletal deformation), multimesh
   * instances (CPU particles) and flipbook geometry. Absent from a core built before them (it
   * counts that content in `maxPx` and `colorStep`). */
  animPx?: number;
  animColorStep?: number;
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
const STAT_SURFACES_RENDERED = STAT_FIELDS.indexOf("surfaces_rendered");
const STAT_SURFACES_SKIPPED = STAT_FIELDS.indexOf("surfaces_skipped");
const STAT_SURFACES_UNCHANGED = STAT_FIELDS.indexOf("surfaces_unchanged");
const STAT_SURFACES_ALLOCATED = STAT_FIELDS.indexOf("surfaces_allocated");
const STAT_SURFACE_PIXELS = STAT_FIELDS.indexOf("surface_pixels");
const STAT_DAMAGE_MODE = STAT_FIELDS.indexOf("damage_mode");
const STAT_DAMAGE_US = STAT_FIELDS.indexOf("damage_us");
const STAT_DAMAGE_PERMILLE = STAT_FIELDS.indexOf("damage_permille");
const STAT_DAMAGE_REGIONS = STAT_FIELDS.indexOf("damage_regions");
const MOTION_SEQ = MOTION_FIELDS.indexOf("seq");
const MOTION_CHANGES = MOTION_FIELDS.indexOf("changes");
const MOTION_MAX_PX = MOTION_FIELDS.indexOf("max_px");
const MOTION_COLOR_STEP = MOTION_FIELDS.indexOf("color_step");
const MOTION_ANIM_PX = MOTION_FIELDS.indexOf("anim_px");
const MOTION_ANIM_COLOR = MOTION_FIELDS.indexOf("anim_color");

const hex = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
};

/** `StreamCore` over a replaceable `GswRs` instance and its module memory. */
export class WasmStreamCore implements StreamCore, ExtensionCore {
  private instance: GswRs | null = null;
  private executorError: string | null = null;
  private sessionStarted = false;
  private logRemoved = false;
  /** `setMotion`: re-applied to every new instance. */
  private motionOn = false;
  private motionU32: Uint32Array | null = null;
  private motionF32: Float32Array | null = null;
  /** The block holds the animation measures (`motion_len`). */
  private motionAnim = false;
  private readonly motionOut: CoreMotion = {
    seq: 0,
    changes: 0,
    maxPx: 0,
    colorStep: 0,
  };
  private coding: LiveCoding | null = null;
  private particles: GswParticles;
  private staticParticles = false;
  private drawBatching: number | undefined;
  private drawBatchingDirty = false;
  private staticShaders = false;
  private staticShadersDirty = false;
  private damageRedraw = false;
  private coverTiles = true;
  private particleUploadReady = false;
  private particleIdlePaused = false;
  private programsHeld = false;
  /** Accept exposes the next state's shaders before its payloads are ready for apply. */
  private transactionPending = false;
  private readonly programs: ProgramCounts = {
    defined: 0,
    refused: 0,
    library_reads: 0,
    identical_glsl: 0,
  };
  private lastAcceptedSeq = 0;
  private statsView: Uint32Array | null = null;
  private readonly damage: CoreDamageStats = {
    mode: 0,
    us: 0,
    permille: 0,
    regions: 0,
  };
  private readonly applied: CoreApplyStats = {
    structural: false,
    why: 0,
    backBufferItems: 0,
    surfacesRendered: 0,
    surfacesSkipped: 0,
    surfacesUnchanged: 0,
    surfacesAllocated: 0,
    surfacePixels: 0,
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
    private readonly particlePacing: ParticleBurstPacing = CLIENT_PARTICLE_PACING,
  ) {
    this.particles = this.makeParticles();
    this.instance = build(protocol);
    this.instance.set_async_programs?.(true);
    this.instance.set_static_shaders?.(this.staticShaders);
  }

  private get g(): GswRs {
    if (this.instance === null)
      throw new Error("the stream core is unavailable");
    return this.instance;
  }

  tweensActive(): boolean {
    return this.g.tweens_active?.() ?? false;
  }
  tweenTick(nowMs: number, picture: boolean): boolean {
    return (this.g.tween_tick?.(nowMs * 1000, picture) ?? 0) > 0;
  }
  tweenDiagnostics(): Record<string, number> {
    return JSON.parse(this.g.tween_diagnostics_json?.() ?? "{}");
  }

  queryDisplayedTransform(id: number): import("./extensions").Affine2D | null {
    const g = this.instance;
    if (!g) return null;
    if (!g.query_display_transform) {
      const row = this.queryItem(id);
      return row.length && row[2]
        ? [row[3], row[4], row[5], row[6], row[7], row[8]]
        : null;
    }
    if (g.query_display_transform(id) === 0) return null;
    const row = new Float64Array(this.memory.buffer, g.query_item_ptr(), 6);
    return [row[0], row[1], row[2], row[3], row[4], row[5]];
  }

  beginConnection(protocol = this.protocol): void {
    this.sessionStarted = false;
    this.executorError = null;
    this.programsHeld = false;
    this.transactionPending = false;
    if (this.disposed) throw new Error("the stream core is disposed");
    this.coding?.free();
    this.coding = null;
    if (this.instance === null || protocol !== this.protocol) {
      this.resetParticles();
      const old = this.instance;
      this.instance = null;
      old?.free();
      this.statsView = null;
      this.motionU32 = null;
      this.retireQueries();
      this.decoded = null;
      this.lastAcceptedSeq = 0;
      this.programs.defined = 0;
      this.programs.refused = 0;
      this.programs.library_reads = 0;
      this.programs.identical_glsl = 0;
      const next = this.build(protocol);
      try {
        if (this.logRemoved) next.set_log_removed(true);
        if (this.motionOn) next.set_motion?.(true);
        next.set_damage_redraw?.(this.damageRedraw);
        next.set_cover_tiles?.(this.coverTiles);
        next.set_async_programs?.(true);
        next.set_static_shaders?.(this.staticShaders);
        if (this.drawBatching !== undefined)
          next.set_draw_batching?.(this.drawBatching);
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

  prepareExecutor(): void {
    if ((this.g.prepare_executor?.() ?? 0) < 0) this.preparationFailed();
  }

  prepareStep(): boolean {
    if (this.executorError !== null) return true;
    const result = this.g.prepare_step?.() ?? 0;
    if (result < 0) this.preparationFailed();
    return result <= 0;
  }

  private preparationFailed(): void {
    const error = this.g.error();
    // Loss can be observed before the canvas event; the loop holds work until restore.
    if (/lost/i.test(error)) throw failWith(null, error);
    this.executorError = error;
    // Session validation keeps precedence over GL construction errors, as synchronous start did.
    if (this.sessionStarted) throw failWith(null, this.executorError);
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
      this.resetParticles();
      if (g.live_session(len, this.protocol) < 0)
        throw failWith(null, g.error());
      this.sessionStarted = true;
      if (this.executorError !== null) throw failWith(null, this.executorError);
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
      if (code === 8) return { kind: "tween" };
      if (code === ACCEPT_ITEM_META) return { kind: "item_meta" };
      return this.hintMessage(code === ACCEPT_RESOURCE_HINT);
    }
    if (code === ACCEPT_RESOURCE) return { kind: "resource" };
    if (code === ACCEPT_END) return { kind: "end" };
    this.transactionPending = true;
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

  get hintSelect(): StreamCore["hintSelect"] {
    return typeof this.g.hint_select === "function"
      ? this.selectHint
      : undefined;
  }

  private readonly selectHint = (hash: string): HintSelection | null => {
    const selected = this.g.hint_select?.(hash) ?? "";
    return selected === "" ? null : (JSON.parse(selected) as HintSelection);
  };

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

  private readonly staging = new StagingCounters();

  stagingStats(): StagingStats {
    return this.staging.snapshot();
  }

  private recordStaging(
    hash: string,
    sample: StagingSample,
    staged = true,
  ): void {
    const info = (staged ? this.g.staged_info?.(hash).split(",") : null) ?? [
      "other",
      "0",
    ];
    sample.bytesOut = Number(info[1]);
    this.staging.record(info[0] as StagingKind, sample);
  }

  stage(
    hash: string,
    bytes: Uint8Array,
    sample = stagingSample(),
  ): string | null {
    sample.digestPath = "wasm";
    const ptr = this.g.alloc_payload(bytes.length);
    let t = performance.now();
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    sample.copyMs += performance.now() - t;
    sample.bytesIn += bytes.length;
    t = performance.now();
    const result = this.g.stage_payload(bytes.length, hash);
    // Whole-body staging includes its hash in this export's finish time.
    sample.finishMs += performance.now() - t;
    this.recordStaging(hash, sample, result >= 0);
    return result < 0 ? this.g.error() : null;
  }

  stageStream(
    hash: string,
    sizeHint: number,
    sample = stagingSample(),
    workerDigest?: string,
  ): StagingStream {
    const g = this.g;
    const hint = Math.max(0, Math.floor(sizeHint)) >>> 0;
    if (workerDigest === undefined || !g.stream_begin_hashed)
      sample.digestPath = "wasm";
    // Only the buffered worker path supplies a digest; network streams keep hashing in wasm.
    const id =
      workerDigest === undefined || !g.stream_begin_hashed
        ? g.stream_begin(hash, hint)
        : g.stream_begin_hashed(hash, workerDigest, hint);
    let refused = id < 0 ? g.error() : null;
    let open = id > 0;
    // A reconnect that rebuilt the instance (or a dispose) dropped the stream with it.
    const live = (): boolean => open && this.instance === g;
    const memory = this.memory;
    let recorded = false;
    const record = (staged = false) => {
      if (recorded) return;
      recorded = true;
      if (this.instance === g) this.recordStaging(hash, sample, staged);
      else this.staging.record("other", sample);
    };
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
        let t = performance.now();
        new Uint8Array(memory.buffer, ptr, chunk.length).set(chunk);
        sample.copyMs += performance.now() - t;
        sample.bytesIn += chunk.length;
        t = performance.now();
        g.stream_commit(id, chunk.length);
        sample.commitMs += performance.now() - t;
      },
      finish() {
        if (!live()) {
          record();
          return (
            refused ?? "resource-unavailable: the payload stream was dropped"
          );
        }
        open = false;
        const t = performance.now();
        const result = g.stream_finish(id);
        sample.finishMs += performance.now() - t;
        record(result >= 0);
        return result < 0 ? g.error() : null;
      },
      abort() {
        if (live()) g.stream_abort(id);
        open = false;
        record();
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
    // A prepared transaction may still be fetching shader code; prepareApply defines it once
    // its payloads are provided or deferred. The wasm revisit declines while it is prepared.
    if (!this.transactionPending) {
      try {
        this.programsHeld = definePrograms(
          this.g,
          this.programs,
          undefined,
          LIVE_PROGRAM_BUDGET,
        );
      } catch (e) {
        if (e instanceof ProgramError)
          throw new StreamFailure(seq, e.reason, e.message);
        throw e;
      }
    }
    this.particles.syncOnly(this.g, this.memory);
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
      this.programsHeld = definePrograms(
        this.g,
        this.programs,
        undefined,
        LIVE_PROGRAM_BUDGET,
      );
    } catch (e) {
      if (e instanceof ProgramError)
        throw new StreamFailure(seq, e.reason, e.message);
      throw e;
    }
    this.particles.step(this.g, this.memory);
    this.particleUploadReady = false;
  }

  pollPrograms(): boolean {
    const g = this.instance;
    if (g === null) return false;
    const before = this.programs.defined + this.programs.refused;
    if (this.programsHeld && !this.transactionPending) {
      try {
        this.programsHeld = definePrograms(
          g,
          this.programs,
          undefined,
          LIVE_PROGRAM_BUDGET,
        );
      } catch (e) {
        if (e instanceof ProgramError)
          throw new StreamFailure(this.lastAcceptedSeq, e.reason, e.message);
        throw e;
      }
    }
    const settled = g.poll_programs?.() ?? 0;
    // A held slice can define or refuse synchronously, with no GL link reporting a settle.
    if (settled === 0)
      return this.programs.defined + this.programs.refused !== before;
    // A failed link was counted defined when it began: it draws shaderless, as refused.
    const failed = settled >>> 16;
    this.programs.defined -= failed;
    this.programs.refused += failed;
    return true;
  }

  private makeParticles(): GswParticles {
    const particles = new GswParticles(
      this.particlePacing,
      () => {
        // Uploads happen off-frame; reapply and GL draws stay on the frame callback.
        this.particleUploadReady = true;
      },
      this.staticParticles,
    );
    particles.pauseIdle(this.particleIdlePaused);
    return particles;
  }

  private resetParticles(): void {
    this.particles.dispose();
    this.particleUploadReady = false;
    this.particles = this.makeParticles();
  }

  setDrawBatching(mask: number): void {
    if (this.drawBatching !== mask) this.drawBatchingDirty = true;
    this.drawBatching = mask;
    this.instance?.set_draw_batching?.(mask);
  }

  setStaticShaders(on: boolean): void {
    if (this.staticShaders !== on) this.staticShadersDirty = true;
    this.staticShaders = on;
    this.instance?.set_static_shaders?.(on);
  }

  setCoverTiles(on: boolean): void {
    this.coverTiles = on;
    // draw() settles pending cover work, so this needs no reapply/dirty flag.
    this.instance?.set_cover_tiles?.(on);
  }

  setDamageRedraw(on: boolean): void {
    this.damageRedraw = on;
    this.instance?.set_damage_redraw?.(on);
  }

  setStaticParticles(on: boolean): void {
    this.staticParticles = on;
    this.particles.setStaticParticles(on);
  }

  pauseParticles(paused: boolean): void {
    this.particleIdlePaused = paused;
    this.particles.pauseIdle(paused);
  }

  settleParticles(_seq: number): boolean {
    const g = this.instance;
    if (g === null || g.reapply === undefined) return false;
    const uploaded =
      this.particles.settling && this.particles.settle(g, this.memory);
    if (
      !uploaded &&
      !this.particleUploadReady &&
      !this.staticShadersDirty &&
      !this.drawBatchingDirty
    )
      return false;
    this.particleUploadReady = false;
    const applied = g.reapply() > 0;
    if (applied) {
      this.staticShadersDirty = false;
      this.drawBatchingDirty = false;
    }
    return applied;
  }

  apply(seq: number): void {
    this.transactionPending = false;
    if (this.g.apply() < 0) throw failWith(seq, this.g.error());
    this.staticShadersDirty = false;
    this.drawBatchingDirty = false;
  }

  draw(seq: number): void {
    if (this.particles.expire(this.g, this.memory)) this.g.reapply?.();
    if (this.g.draw() < 0) throw failWith(seq, this.g.error());
  }

  redraw(seq: number): "ok" | "lost" {
    if (this.particles.expire(this.g, this.memory)) this.g.reapply?.();
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
    this.resetParticles();
    this.instance?.live_reset(keepPayloads);
    this.programsHeld = false;
    this.transactionPending = false;
    this.lastAcceptedSeq = 0;
  }

  heapBytes(): number {
    return this.instance === null ? 0 : this.memory.buffer.byteLength;
  }

  programCounts(): Readonly<ProgramCounts> {
    return { ...this.programs };
  }

  // The recorder's one copy per received message, made only when asked (`copyDecoded`).

  takeDecoded(): Uint8Array | null {
    return this.decoded;
  }

  // The extension host's calls (never made by a client with no extension).

  itemMetaJson(): string {
    return this.g.item_meta_json();
  }

  setMotion(on: boolean): boolean {
    this.motionOn = on;
    const g = this.instance;
    if (g === null) return true;
    if (
      typeof g.set_motion !== "function" ||
      typeof g.motion_ptr !== "function"
    )
      return false;
    g.set_motion(on);
    return true;
  }

  motion(): CoreMotion | null {
    const g = this.instance;
    if (!this.motionOn || g === null || typeof g.motion_ptr !== "function")
      return null;
    if (
      this.motionU32 === null ||
      this.motionU32.buffer !== this.memory.buffer
    ) {
      const ptr = g.motion_ptr();
      this.motionAnim = (g.motion_len?.() ?? 0) >= 4 * MOTION_FIELDS.length;
      const fields = this.motionAnim ? MOTION_FIELDS.length : MOTION_ANIM_PX;
      this.motionU32 = new Uint32Array(this.memory.buffer, ptr, fields);
      this.motionF32 = new Float32Array(this.memory.buffer, ptr, fields);
    }
    const u = this.motionU32;
    const f = this.motionF32 as Float32Array;
    const out = this.motionOut;
    out.seq = u[MOTION_SEQ];
    out.changes = u[MOTION_CHANGES];
    out.maxPx = f[MOTION_MAX_PX];
    out.colorStep = f[MOTION_COLOR_STEP];
    if (this.motionAnim) {
      out.animPx = f[MOTION_ANIM_PX];
      out.animColorStep = f[MOTION_ANIM_COLOR];
    }
    return out;
  }

  setLogRemoved(on: boolean): void {
    this.logRemoved = on;
    this.instance?.set_log_removed(on);
  }

  takeRemoved(): Uint32Array {
    return this.g.take_removed();
  }

  /** Whole override table, 16 floats per id; last four are clip outsets (L/T/R/B). */
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

  queryControlRect(id: number): ArrayLike<number> {
    return this.instance?.query_control_rect(id) ?? [];
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
    this.particles.dispose();
    this.coding?.free();
    this.coding = null;
    this.instance?.free();
    this.instance = null;
    this.statsView = null;
    this.motionU32 = null;
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

  damageStats(): Readonly<CoreDamageStats> | undefined {
    const st = this.stats();
    if (st.length <= STAT_DAMAGE_REGIONS) return undefined;
    const out = this.damage;
    out.mode = st[STAT_DAMAGE_MODE];
    out.us = st[STAT_DAMAGE_US];
    out.permille = st[STAT_DAMAGE_PERMILLE];
    out.regions = st[STAT_DAMAGE_REGIONS];
    return out;
  }

  applyStats(): CoreApplyStats {
    const st = this.stats();
    const out = this.applied;
    out.structural = st[STAT_STRUCTURAL] !== 0;
    out.why = st[STAT_WHY];
    out.backBufferItems = st[STAT_BACK_BUFFER_ITEMS];
    out.surfacesRendered = st[STAT_SURFACES_RENDERED];
    out.surfacesSkipped = st[STAT_SURFACES_SKIPPED];
    out.surfacesUnchanged = st[STAT_SURFACES_UNCHANGED];
    out.surfacesAllocated = st[STAT_SURFACES_ALLOCATED];
    out.surfacePixels = st[STAT_SURFACE_PIXELS];
    return out;
  }

  /** The stats block (lib.rs `Stats`), its view re-derived whenever memory grew. */
  private stats(): Uint32Array {
    if (this.statsView === null || this.statsView.buffer !== this.memory.buffer)
      this.statsView = new Uint32Array(
        this.memory.buffer,
        this.g.stats_ptr(),
        statsWords(this.g),
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
