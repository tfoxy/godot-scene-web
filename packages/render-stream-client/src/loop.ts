// The client's protocol loop: the harness receiver's live
// order (web/gsw-receiver/live.ts `LiveReceiver`) minus everything evidence-only.
//
// 1. A message decodes and validates in its own event (one copy into wasm, W11t live coding
//    first), is acked `received`, and queues.
// 2. With `applyOn: "message"` (the default): while frame callbacks run, nothing waits ahead of
//    it and fewer than MESSAGE_APPLY_MAX_UNDRAWN applies wait for a draw, the same event applies
//    it (ack `applied`) when it needs no payload, or starts its fetches.
// 3. Otherwise one frame callback (rAF) runs the connection phases, then the pending
//    transaction's fetches (each payload verified by wasm on arrival), then apply, ack
//    `applied`. Every frame callback with an apply since its last draw draws the newest applied
//    state once and acks `submitted` for each of them.
// Credit (`applied` by default, or `submitted`) never comes on receipt alone: a hidden
// page runs no frame callback, so after MESSAGE_APPLY_MAX_FRAME_GAP_MS arrivals wait for one, no
// credit returns and the hub stops publishing to this connection.
//
// Credit window 2: a transaction that arrives while another waits for its payloads folds
// into it in place, and several queued transactions apply in one callback, drawing the newest;
// each folded one is acked with it. Window 1 (the host's grant may be 1) keeps the superseded path:
// the newest is applied by a fresh applier.
//
// Bounded hold: a transaction waits for its payloads at most `resourceHoldMs` (from the first
// callback that found one missing). Then it applies without the texture and mesh payloads still in
// flight ("deferred"): what draws them is not drawn (never an older payload in its place), the rest
// is, and acks flow, so the host keeps publishing. A later transaction needing a deferred payload
// does not wait for it again. The fetches go on; each deferred payload that arrives goes into the
// store, and the next apply, or with none waiting a revisit (an apply over the same state, no ack),
// draws what needs it. Shader code is never deferred: a material without its program would draw
// something else, so a transaction missing one keeps waiting. A fetch failure fails the stream, as
// before.
//
// Loss: a close without an end record, other than 1002/1008/1009, reconnects as a fresh session
// (the applier is reset, the payload store, the compiled module and the browser's
// HTTP cache are kept), after 1, 2, 4, 8 s and then every 10 s; the count resets once a connection
// draws. A coding failure asks a `coding` resync in place (W11t, GTS `transport_skip`), and the
// full it forces is applied by a rebuilt applier that inherits the GPU residency (GRH). A WebGL
// context loss holds the loop; after the restore, one callback redraws the last applied state
// in place, refetching any resident payload the store no longer holds.

import { type AckStage, AckWriter } from "./ack";
import type { Needed, SessionMeta, StreamCore } from "./core";
import { failWith, StreamFailure } from "./core";
import type { RenderStreamEndpoint } from "./endpoint";
import type { ExtensionHost } from "./extensions";
import { type FetchResult, LiveFetcher } from "./fetcher";
import { clientHello, clientProtocol } from "./hello";
import type { RenderStreamRecorder } from "./recorder";
import type {
  RenderStreamTransport,
  RenderStreamTransportFactory,
} from "./transport";

/** The failure reasons the client reports (the receiver's typed names, plus the client's own).
 * `core-load-failed`'s detail says why: `stale core: ...`, `timeout after <ms> ms in <steps>`. */
export type RenderStreamFailureReason =
  | "live-connect-failed"
  | "host-error"
  | "live-disconnected"
  | "resource-unavailable"
  | "receiver-error"
  | "core-load-failed"
  | "no-webgl2"
  | (string & {});

export type RenderStreamStatus =
  | { kind: "connecting" }
  /** The connection's session arrived (`firstFrame` false), then its first transaction drew
   * (`firstFrame` true): once each per connection. */
  | { kind: "streaming"; firstFrame: boolean }
  | { kind: "reconnecting"; attempt: number; inMs: number }
  | { kind: "failed"; reason: RenderStreamFailureReason; detail: string }
  | { kind: "ended" };

export interface RenderStreamStats {
  /** Transactions applied (folded ones included) by this client, over all its connections. */
  applied: number;
  /** Applies (drawn frames) over the last second. */
  appliesPerSec: number;
  /** Median ms from a credit-stage ack (`applied` by default) to the next transaction's
   * arrival (the last 64), or null. */
  creditRttMsP50: number | null;
  /** The wasm instance's memory (0 after dispose). */
  heapBytes: number;
  /** The open connection's carrier, or null while not connected (or on a custom transport
   * that does not name one). `stats()` always sets it; it is optional so that code building a
   * `RenderStreamStats` of its own (a consumer's test double) need not. */
  carrier?: "websocket" | "webtransport" | null;
  /** Payloads the drawn state went without (the resource hold ran out) and still being fetched:
   * what draws them is not on screen yet. `stats()` always sets it (optional as `carrier`). */
  deferredPayloads?: number;
  /** Applies that walked the item tree and re-assembled the draw list (the core's slow path),
   * over all connections: compare with `applied`. `stats()` always sets it (optional as
   * `carrier`). */
  structuralApplies?: number;
  /** Why the last apply walked or re-assembled, as the core's bits: 1 first, 2 defaults,
   * 4 material, 8 texture-size, 16 item-removed, 32 item-added, 64 content-shape, 128 order-key,
   * 256 dependency, 512 canvas, 1024 compact, 2048 move-fallback, 4096 move-attach,
   * 8192 override, 16384 back-buffer (a move or content change reached a canvas group). 0 when
   * it did neither. `stats()` always sets it (optional as `carrier`). */
  lastApplyWhy?: number;
  /** Items in the last applied state holding a canvas group or a back-buffer copy. `stats()`
   * always sets it (optional as `carrier`). */
  backBufferItems?: number;
}

/** The frame and timer functions the loop runs on (the page's, or a test's). */
export interface LoopClock {
  now(): number;
  requestFrame(cb: (ts: number) => void): number;
  cancelFrame(id: number): void;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/** What the hello states about the canvas, read when the socket opens. */
export interface HelloCanvas {
  backing: [number, number];
  css: [number, number];
  dprMilli: number;
  gpuFormats: string;
}

export interface LoopOptions {
  core: StreamCore;
  transport: RenderStreamTransportFactory;
  endpoint: RenderStreamEndpoint;
  creditWindow: 1 | 2;
  /** The hello's credit stage: the ack the host waits on. Default `applied`. */
  creditStage?: CreditStage;
  /** Where a transaction with every payload in is applied: `frame` (the next frame
   * callback) or `message` (its own `onmessage`, while frames run; draw stays on the frame
   * callback). Default `message`. */
  applyOn?: ApplyOn;
  onStatus: (s: RenderStreamStatus) => void;
  canvas: () => HelloCanvas;
  clock: LoopClock;
  connectTimeoutMs?: number;
  /** A resource GET with no progress (no response, no body bytes) for this long fails
   * `resource-unavailable`; default 10000. */
  fetchTimeoutMs?: number;
  /** The longest a transaction waits for its payloads before it applies without the texture and
   * mesh payloads still in flight (their items drawn once they arrive); default
   * `DEFAULT_RESOURCE_HOLD_MS`. 0 never waits; `Infinity` always waits for every payload. */
  resourceHoldMs?: number;
  /** The extension list's runtime; null (the pure client) costs one branch per frame. */
  ext?: ExtensionHost | null;
  /** The session record, once per session (the client keeps its presentation size). */
  onSession?: (session: SessionMeta) => void;
  /** The recorder (null: the pure client copies nothing). */
  recorder?: RenderStreamRecorder | null;
}

/** The ack the host's credit waits on (render-stream-1.md hello `credit_stage`). */
export type CreditStage = "submitted" | "applied";
/** Where a ready transaction is applied. */
export type ApplyOn = "frame" | "message";
/** The defaults: crediting at `applied` and applying in `onmessage` take
 * the wait for the next vsync out of the credit round trip. */
export const DEFAULT_CREDIT_STAGE: CreditStage = "applied";
export const DEFAULT_APPLY_ON: ApplyOn = "message";

/** `applyOn: "message"` applies in `onmessage` only while the frame callbacks run: no frame
 * callback for this long (a hidden page) and arrivals queue for the next one, so no credit
 * returns from a page that draws nothing. */
export const MESSAGE_APPLY_MAX_FRAME_GAP_MS = 100;
/** `applyOn: "message"` applies in `onmessage` while fewer than this many applies wait for a
 * draw; past it, arrivals wait for the frame callback, so a client whose draws fall behind (a slow
 * GPU, a busy thread) is paced by its draws again and never applies far more than it shows. Two
 * absorbs a host frame rate a little above the panel's (60 Hz against a panel just under it). */
export const MESSAGE_APPLY_MAX_UNDRAWN = 2;

/** The default `resourceHoldMs`: never wait. Like images on a web page, a texture or mesh still
 * loading is not drawn and everything else is; it pops in once it arrives. */
export const DEFAULT_RESOURCE_HOLD_MS = 0;

/** Backoff before reconnect attempt n (1-based): 1, 2, 4, 8 s, then 10 s. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 10000] as const;
const CLOSE_WAIT_MS = 2000;
/** Resource GETs in flight at once. The host serves at most 8 HTTP connections and a seat
 * may have 2 viewers, so 4 each never queues behind the other viewer. */
const FETCH_PARALLEL = 4;
const RTT_SAMPLES = 64;
const APPLY_RING = 256;

interface Queued {
  seq: number;
  frame: number;
  full: boolean;
  needed: Needed[];
}

interface Pending {
  item: Queued;
  stage: "fetch" | "ready";
  /** Fetched bodies by hash, with the refusal staging gave them (null: staged). */
  bodies: Map<string, string | null>;
  /** The seq each payload was requested for (a folded one's failure is reported at it). */
  requester: Map<string, number>;
  /** When a callback first found a payload missing (the hold's start), or -1. */
  since: number;
}

type Phase =
  | "idle"
  | "connecting"
  | "streaming"
  | "backoff"
  | "draining"
  | "failed"
  | "ended"
  | "disposed";

/** One connection's identity: events of an older one are ignored. */
interface Connection {
  transport: RenderStreamTransport | null;
  opened: boolean;
  closeInfo: { code: number; reason: string } | null;
  sessionSeen: boolean;
  streamId: string;
}

export class StreamLoop {
  private endpoint: RenderStreamEndpoint;
  private phase: Phase = "idle";
  private conn: Connection | null = null;
  private frameId: number | null = null;
  private timerId: number | null = null;
  private deadline = 0;
  /** Reconnect attempts since the last connection that drew (0: this is not a reconnect). */
  private attempt = 0;
  private grantedWindow = 1;
  private queue: Queued[] = [];
  private coalesced: Queued[] = [];
  private pending: Pending | null = null;
  private fetcher: LiveFetcher | null = null;
  private makeFetcher: (() => LiveFetcher) | null = null;
  private endSeen = false;
  private rebuildDue = false;
  private connApplied = 0;
  private firstFrameSent = false;
  private ctx: "ok" | "lost" | "restoring" = "ok";
  private restoreFetcher: LiveFetcher | null = null;
  private restoreWant: string[] | null = null;
  private readonly restoreBodies = new Map<string, string | null>();
  private lastAppliedSeq = 0;
  /** IN12: the transaction on screen (the last draw's), null before one in this session; a
   * pointer target's `frame`. */
  drawnSeq: number | null = null;
  /** Seqs applied (folded ones included) and not drawn yet; their `submitted` acks wait for
   * the draw. */
  private undrawn: number[] = [];
  /** Ack text from a prefix cached per stream id (the acks are the steady-state sends). */
  private readonly acks = new AckWriter();
  /** The start of the last frame callback (null: none on this loop yet). */
  private lastFrameAt: number | null = null;
  // Stats: counters and two fixed rings, no per-frame allocation.
  private applied = 0;
  private structuralApplies = 0;
  private lastApplyWhy = 0;
  private backBufferItems = 0;
  private readonly applyTimes = new Float64Array(APPLY_RING);
  private applyCount = 0;
  private readonly rtts = new Float64Array(RTT_SAMPLES);
  private rttCount = 0;
  private lastCreditAt: number | null = null;
  /** Payloads an applied transaction went without (the hold ran out), still being fetched, with
   * the seq that needed each (a failure's seq). */
  private readonly deferred = new Map<string, number>();
  /** A revisit drew deferred payloads in: the callback draws once with no transaction. */
  private revisitDraw = false;

  private readonly creditStage: CreditStage;
  private readonly resourceHoldMs: number;
  private readonly ext: ExtensionHost | null;
  private readonly recorder: RenderStreamRecorder | null;

  constructor(private readonly o: LoopOptions) {
    this.endpoint = o.endpoint;
    this.creditStage = o.creditStage ?? DEFAULT_CREDIT_STAGE;
    this.ext = o.ext ?? null;
    this.recorder = o.recorder ?? null;
    const hold = o.resourceHoldMs ?? DEFAULT_RESOURCE_HOLD_MS;
    this.resourceHoldMs = hold >= 0 ? hold : DEFAULT_RESOURCE_HOLD_MS;
  }

  // ----------------------------------------------------------------------- public

  connect(): void {
    if (
      this.phase !== "idle" &&
      this.phase !== "failed" &&
      this.phase !== "ended"
    )
      return;
    if (this.phase !== "idle") this.o.core.reset(true);
    this.attempt = 0;
    this.status({ kind: "connecting" });
    this.open();
  }

  /** A changed descriptor: an active client reconnects with it at once; an idle, failed or
   * ended one keeps it for the next `connect`. */
  setEndpoint(e: RenderStreamEndpoint): void {
    this.endpoint = e;
    if (
      this.phase === "connecting" ||
      this.phase === "streaming" ||
      this.phase === "backoff" ||
      this.phase === "draining"
    ) {
      this.teardown(1000, "endpoint changed");
      this.attempt = 0;
      this.status({ kind: "connecting" });
      this.open();
    }
  }

  contextLost(): void {
    if (this.phase === "disposed") return;
    this.ctx = "lost";
    this.restoreFetcher?.abort();
    this.restoreFetcher = null;
    this.restoreWant = null;
    this.restoreBodies.clear();
  }

  contextRestored(): void {
    if (this.phase === "disposed" || this.ctx === "ok") return;
    this.ctx = "restoring";
  }

  stats(): RenderStreamStats {
    const now = this.o.clock.now();
    let perSec = 0;
    const n = Math.min(this.applyCount, APPLY_RING);
    for (let i = 0; i < n; i++) if (now - this.applyTimes[i] <= 1000) perSec++;
    let p50: number | null = null;
    const m = Math.min(this.rttCount, RTT_SAMPLES);
    if (m > 0) {
      const sorted = Array.from(this.rtts.subarray(0, m)).sort((a, b) => a - b);
      p50 = sorted[(m - 1) >> 1];
    }
    return {
      applied: this.applied,
      appliesPerSec: perSec,
      creditRttMsP50: p50,
      heapBytes: this.o.core.heapBytes(),
      carrier:
        this.conn?.opened && this.conn.closeInfo === null
          ? (this.conn.transport?.carrier ?? null)
          : null,
      deferredPayloads: this.deferred.size,
      structuralApplies: this.structuralApplies,
      lastApplyWhy: this.lastApplyWhy,
      backBufferItems: this.backBufferItems,
    };
  }

  /** Stops the loop and closes the connection (1000); the caller frees the core. Idempotent. */
  dispose(): void {
    if (this.phase === "disposed") return;
    this.teardown(1000, "dispose");
    this.restoreFetcher?.abort();
    this.restoreFetcher = null;
    this.phase = "disposed";
    this.stopFrames();
  }

  get state(): string {
    return this.phase;
  }

  // ----------------------------------------------------------------------- connection

  private open(): void {
    const core = this.o.core;
    this.phase = "connecting";
    this.deadline = this.o.clock.now() + (this.o.connectTimeoutMs ?? 10000);
    const conn: Connection = {
      transport: null,
      opened: false,
      closeInfo: null,
      sessionSeen: false,
      streamId: "",
    };
    this.conn = conn;
    this.firstFrameSent = false;
    const protocol = clientProtocol(this.endpoint.protocol, this.ext?.request);
    try {
      core.beginConnection(protocol);
    } catch (e) {
      this.fail(
        e instanceof StreamFailure
          ? e
          : new StreamFailure(
              null,
              "core-load-failed",
              e instanceof Error ? e.message : String(e),
            ),
      );
      return;
    }
    try {
      conn.transport = this.o.transport(
        this.endpoint,
        `render-stream.${protocol}`,
        {
          open: () => this.onOpen(conn),
          message: (d) => this.onMessage(conn, d),
          close: (code, reason) => {
            if (conn === this.conn) conn.closeInfo = { code, reason };
          },
        },
      );
    } catch (e) {
      conn.closeInfo = { code: 1006, reason: `cannot connect: ${String(e)}` };
    }
    this.startFrames();
  }

  private onOpen(conn: Connection): void {
    if (conn !== this.conn || this.phase !== "connecting") return;
    conn.opened = true;
    this.phase = "streaming";
    const c = this.o.canvas();
    this.send(
      clientHello({
        protocol: clientProtocol(this.endpoint.protocol, this.ext?.request),
        creditWindow: this.o.creditWindow,
        creditStage: this.creditStage,
        token: this.endpoint.token,
        backing: c.backing,
        css: c.css,
        dprMilli: c.dprMilli,
        gpuFormats: c.gpuFormats,
        itemMeta: this.ext?.request ?? null,
      }),
    );
  }

  private send(message: Record<string, unknown>): void {
    this.conn?.transport?.send(JSON.stringify(message));
  }

  /** `at` (ms, the loop clock): acks of one apply or one draw share it, so a fold reads as one
   * instant (the host tap's rule: `applied` acks sharing the receiver's `t_us` applied together). */
  private ack(seq: number, stage: AckStage, at = this.o.clock.now()): void {
    const conn = this.conn;
    const transport = conn?.transport;
    if (!transport) return;
    transport.send(
      this.acks.write(conn.streamId, seq, stage, Math.round(at * 1000)),
    );
  }

  /** Acks `submitted` every applied seq waiting for a draw, with one `t_us`, and clears them. */
  private ackUndrawnSubmitted(now: number): void {
    const undrawn = this.undrawn;
    for (let i = 0; i < undrawn.length; i++)
      this.ack(undrawn[i] as number, "submitted", now);
    undrawn.length = 0;
  }

  private onMessage(conn: Connection, data: ArrayBuffer | string): void {
    if (conn !== this.conn || this.phase !== "streaming") return;
    try {
      if (typeof data === "string") this.onHostText(conn, data);
      else this.onBinary(conn, data);
    } catch (e) {
      this.fail(e);
    }
  }

  private onHostText(conn: Connection, text: string): never {
    let reason: string | null = null;
    let detail = text;
    try {
      const m = JSON.parse(text) as Record<string, unknown>;
      if (
        Object.keys(m).length === 3 &&
        m.type === "error" &&
        typeof m.reason === "string" &&
        typeof m.detail === "string"
      ) {
        reason = m.reason;
        detail = m.detail;
      }
    } catch {
      // not JSON: unexpected text
    }
    if (reason === "unauthorized" && !conn.sessionSeen)
      throw new StreamFailure(null, "live-connect-failed", "unauthorized");
    throw new StreamFailure(
      this.lastAppliedSeq || null,
      "host-error",
      reason === null
        ? `unexpected text message ${JSON.stringify(text)}`
        : `${reason}: ${detail}`,
    );
  }

  private onBinary(conn: Connection, buf: ArrayBuffer): void {
    const rec = this.recorder;
    const m = this.o.core.receive(buf, conn.sessionSeen, rec !== null);
    if (rec) {
      // The decoded record, in receipt order (the session carries the magic). `held` and
      // `coding-resync` are not records: nothing to record.
      const bytes = this.o.core.takeDecoded() as Uint8Array;
      if (m.kind === "session") rec.session(bytes);
      else if (m.kind === "transaction")
        rec.record(bytes, "transaction", m.full, m.seq);
      else if (m.kind === "resource") rec.record(bytes, "resource", false, 0);
      else if (m.kind === "item_meta") rec.record(bytes, "item_meta", false, 0);
      else if (m.kind === "end") rec.record(bytes, "end", false, 0);
    }
    switch (m.kind) {
      case "item_meta":
        // Identities for the extensions, at receipt (no ext: skipped).
        if (this.ext) this.ext.itemMeta();
        return;
      case "held":
      case "resource":
        return;
      case "coding-resync":
        // W11t: the decoder skips based transactions until the full one, which a rebuilt
        // applier applies (the applier is delta-driven); the full may jump the seq.
        this.rebuildDue = true;
        this.o.core.transportSkip();
        this.send({
          type: "resync",
          stream_id: conn.streamId,
          seq: m.seq,
          reason: "coding",
        });
        return;
      case "session":
        conn.sessionSeen = true;
        this.beginSession(conn, m.meta);
        return;
      case "end":
        this.endSeen = true;
        return;
      case "transaction":
        break;
    }
    if (this.ext) this.ext.transaction();
    const now = this.o.clock.now();
    if (this.lastCreditAt !== null) {
      this.rtts[this.rttCount % RTT_SAMPLES] = now - this.lastCreditAt;
      this.rttCount++;
      this.lastCreditAt = null;
    }
    this.ack(m.seq, "received");
    const item: Queued = {
      seq: m.seq,
      frame: m.frame,
      full: m.full,
      needed: m.needed,
    };
    if (this.pending !== null && this.windowTwo()) {
      this.foldIntoPending(this.pending, item);
      return;
    }
    if (this.pending !== null) {
      // Window 1: the wasm core holds ONE accepted state, so the newest supersedes the pending
      // one and is applied by a fresh applier (takeQueued's rebuild).
      this.pending = null;
      this.fetcher?.cancel();
      this.deferred.clear(); // their GETs went with the cancel; the rebuild needs them again
      this.rebuildDue = true;
    }
    this.queue.push(item);
    if ((this.o.applyOn ?? DEFAULT_APPLY_ON) === "message")
      this.applyOnMessage(now);
  }

  /** `applyOn: "message"`: the queued transactions go now, not at the next frame callback,
   * when nothing waits ahead of them and the frame callbacks run. A transaction that needs
   * payloads starts its fetches here and applies at the frame callback that finds them in. */
  private applyOnMessage(now: number): void {
    if (
      this.ctx !== "ok" ||
      this.pending !== null ||
      this.rebuildDue ||
      this.undrawn.length >= MESSAGE_APPLY_MAX_UNDRAWN ||
      this.lastFrameAt === null ||
      now - this.lastFrameAt > MESSAGE_APPLY_MAX_FRAME_GAP_MS
    )
      return;
    this.takeQueued(false);
  }

  private beginSession(conn: Connection, session: SessionMeta): void {
    conn.streamId = session.stream?.stream_id ?? "";
    this.o.onSession?.(session);
    this.drawnSeq = null;
    if (this.ext)
      this.ext.beginSession(session.session_id ?? "", conn.streamId);
    this.grantedWindow = session.publication?.credit_window ?? 1;
    const res = session.resources ?? {};
    const fetchKind = res.fetch ?? "none";
    this.fetcher?.abort();
    this.fetcher = null;
    this.makeFetcher = null;
    if (fetchKind === "directory")
      throw new StreamFailure(
        null,
        "resource-unavailable",
        "a live session advertises fetch directory",
      );
    if (fetchKind === "http") {
      const httpPath = res.http_path ?? null;
      if (httpPath === null)
        throw new StreamFailure(
          null,
          "resource-unavailable",
          "fetch http with http_path null",
        );
      const transport = conn.transport as RenderStreamTransport;
      const token = this.endpoint.token;
      // Bodies are staged as they arrive, unless the recorder needs each whole body.
      const stager =
        this.recorder === null
          ? (this.o.core.stageStream?.bind(this.o.core) ?? null)
          : null;
      this.makeFetcher = () =>
        new LiveFetcher(
          (path, signal, opts) =>
            transport.fetchResource(path, {
              token,
              signal,
              stream: opts?.stream === true,
              progress: opts?.progress,
            }),
          httpPath,
          this.o.fetchTimeoutMs ?? 10000,
          0,
          (r) => this.stageFetched(r),
          { maxInFlight: FETCH_PARALLEL, stager },
        );
      this.fetcher = this.makeFetcher();
    }
    this.status({ kind: "streaming", firstFrame: false });
  }

  // ----------------------------------------------------------------------- frames

  private startFrames(): void {
    if (this.frameId === null)
      this.frameId = this.o.clock.requestFrame(this.onFrame);
  }

  private stopFrames(): void {
    if (this.frameId !== null) this.o.clock.cancelFrame(this.frameId);
    this.frameId = null;
    if (this.timerId !== null) this.o.clock.clearTimeout(this.timerId);
    this.timerId = null;
  }

  private readonly onFrame = (): void => {
    this.frameId = null;
    this.lastFrameAt = this.o.clock.now();
    try {
      if (this.ext) this.ext.beginFrame();
      this.step();
    } catch (e) {
      this.fail(e);
      return;
    }
    if (
      this.phase === "connecting" ||
      this.phase === "streaming" ||
      this.phase === "draining"
    )
      this.startFrames();
  };

  /** receiver.gd `_process_live`, one callback. */
  private step(): void {
    const now = this.o.clock.now();
    const conn = this.conn as Connection;
    switch (this.phase) {
      case "connecting":
        if (conn.closeInfo !== null || now > this.deadline)
          this.connectFailed(conn);
        return;
      case "draining":
        if (conn.closeInfo !== null || now > this.deadline) {
          this.teardown(1000, "end seen");
          this.phase = "ended";
          this.status({ kind: "ended" });
        }
        return;
      case "streaming":
        break;
      default:
        return;
    }
    if (this.ctx !== "ok") {
      this.stepContext();
    } else {
      if (this.pending !== null) {
        this.advancePending();
        if (this.pending?.stage === "ready") this.applyReady(true);
      } else if (this.queue.length > 0) {
        this.takeQueued(true);
      }
      if (
        this.deferred.size > 0 &&
        this.pending === null &&
        this.queue.length === 0
      )
        this.pollDeferred();
    }
    if (this.ctx === "ok" && this.undrawn.length > 0) this.drawApplied();
    else if (this.ctx === "ok" && this.revisitDraw) this.drawRevisit(now);
    else if (this.ext && this.ctx === "ok") this.extensionRedraw(now);
    if (this.phase !== "streaming") return;
    if (
      this.ctx === "ok" &&
      this.endSeen &&
      this.queue.length === 0 &&
      this.pending === null &&
      (this.deferred.size === 0 || conn.closeInfo !== null)
    ) {
      // The receiver closes first (the host lingers for it after the end record), once the
      // deferred payloads are drawn (unless the host closed already).
      this.phase = "draining";
      conn.transport?.close(1000, "end seen");
      this.deadline = now + CLOSE_WAIT_MS;
      return;
    }
    if (conn.closeInfo !== null && !this.endSeen) {
      const { code, reason } = conn.closeInfo;
      if (!conn.sessionSeen && code === 1008 && reason === "unauthorized")
        throw new StreamFailure(null, "live-connect-failed", "unauthorized");
      if (code === 1002 || code === 1008 || code === 1009)
        throw new StreamFailure(
          this.lastAppliedSeq || null,
          "host-error",
          `${reason}: the host closed with ${code}`,
        );
      if (!conn.sessionSeen && this.attempt === 0 && this.applied === 0)
        throw new StreamFailure(
          null,
          "live-connect-failed",
          `the connection closed (code ${code}) before its session`,
        );
      this.scheduleReconnect();
    }
  }

  private connectFailed(conn: Connection): void {
    const c = conn.closeInfo;
    // A reconnect attempt that does not open just waits for the next one.
    if (this.attempt > 0) {
      this.scheduleReconnect();
      return;
    }
    const why =
      c === null
        ? "not open in time"
        : `close code ${c.code}${c.reason ? ` ${JSON.stringify(c.reason)}` : ""}${conn.opened ? "" : ", never opened"}`;
    throw new StreamFailure(
      null,
      "live-connect-failed",
      c?.code === 1008 && c.reason === "unauthorized"
        ? "unauthorized"
        : `no open connection (${why})`,
    );
  }

  private scheduleReconnect(): void {
    this.teardown(1000, "reconnect");
    const delay =
      RECONNECT_BACKOFF_MS[
        Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)
      ];
    this.attempt++;
    this.phase = "backoff";
    this.status({ kind: "reconnecting", attempt: this.attempt, inMs: delay });
    this.timerId = this.o.clock.setTimeout(() => {
      this.timerId = null;
      if (this.phase === "backoff") this.open();
    }, delay);
  }

  /** Closes the current connection and drops its unapplied state; the core starts a fresh
   * session on the next one (payloads kept). */
  private teardown(code: number, reason: string): void {
    const conn = this.conn;
    this.conn = null;
    if (conn?.transport) conn.transport.close(code, reason);
    if (this.timerId !== null) this.o.clock.clearTimeout(this.timerId);
    this.timerId = null;
    this.fetcher?.abort();
    this.fetcher = null;
    this.makeFetcher = null;
    this.pending = null;
    this.queue = [];
    this.coalesced = [];
    this.deferred.clear();
    this.revisitDraw = false;
    this.undrawn.length = 0;
    this.endSeen = false;
    this.rebuildDue = false;
    this.lastCreditAt = null;
    if (conn?.sessionSeen) {
      this.o.core.reset(true);
      this.connApplied = 0;
    }
  }

  private fail(e: unknown): void {
    if (this.phase === "disposed" || this.phase === "failed") return;
    const f =
      e instanceof StreamFailure
        ? e
        : new StreamFailure(
            this.lastAppliedSeq || null,
            "receiver-error",
            e instanceof Error ? e.message : String(e),
          );
    this.teardown(1000, "receiver failure");
    this.phase = "failed";
    this.stopFrames();
    this.status({ kind: "failed", reason: f.reason, detail: f.message });
  }

  private status(s: RenderStreamStatus): void {
    try {
      this.o.onStatus(s);
    } catch {
      // a product callback's error is not the stream's
    }
  }

  // ----------------------------------------------------------------------- transactions

  /** The session granted credit window 2. */
  private windowTwo(): boolean {
    return this.grantedWindow >= 2;
  }

  /** `next` folds into the pending transaction in place: the fetches it made are kept, and
   * only the payloads neither fetched nor requested yet are queued. */
  private foldIntoPending(p: Pending, next: Queued): void {
    this.coalesced.push(p.item);
    p.item = next;
    p.stage = "fetch";
    const asked = this.fetcher?.requested() ?? new Set<string>();
    const misses = next.needed
      .map((n) => n.hash)
      .filter((h) => !p.bodies.has(h) && !asked.has(h));
    for (const h of misses) p.requester.set(h, next.seq);
    const keep = new Set(next.needed.map((n) => n.hash));
    for (const h of this.deferred.keys()) keep.add(h);
    this.fetcher?.retain(keep);
    if (misses.length > 0) {
      const fetcher = this.needFetcher(next.seq, misses[0]);
      this.checkFetches(next.seq, misses);
      fetcher.extend(misses);
    }
  }

  /** The newest queued transaction becomes the one to apply (receiver.gd `_apply_newest`). */
  private takeQueued(draw: boolean): void {
    let rebuild = this.rebuildDue;
    const queued = this.queue;
    this.queue = [];
    const item = queued[queued.length - 1];
    const firstNeeder = new Map<string, number>();
    if (this.windowTwo()) {
      for (const q of queued)
        for (const n of q.needed)
          if (!firstNeeder.has(n.hash)) firstNeeder.set(n.hash, q.seq);
      // Several queued transactions apply in this one callback, drawing only the newest.
      for (const older of queued.slice(0, -1)) this.coalesced.push(older);
    } else if (queued.length > 1) rebuild = true; // superseded
    if (rebuild) {
      this.rebuildDue = false;
      item.needed = this.o.core.rebuild(item.seq);
    }
    this.pending = {
      item,
      stage: "fetch",
      bodies: new Map(),
      requester: new Map(
        item.needed.map((n) => [n.hash, firstNeeder.get(n.hash) ?? item.seq]),
      ),
      since: -1,
    };
    const misses = item.needed.map((n) => n.hash);
    if (misses.length > 0) {
      const fetcher = this.needFetcher(item.seq, misses[0]);
      this.checkFetches(item.seq, misses);
      if (this.deferred.size === 0) fetcher.start(misses);
      else {
        // Deferred payloads are still being fetched: keep their GETs and results.
        const asked = fetcher.requested();
        fetcher.extend(misses.filter((h) => !asked.has(h)));
      }
    }
    this.advancePending();
    if (this.pending?.stage === "ready") this.applyReady(draw);
  }

  private needFetcher(seq: number, hash: string): LiveFetcher {
    if (this.fetcher === null)
      throw new StreamFailure(
        seq,
        "resource-unavailable",
        `payload ${hash} is needed, and the session has no HTTP fetch`,
      );
    return this.fetcher;
  }

  /** W11c `inline-fetch-zero`: a hash that always arrives inline is never fetched. */
  private checkFetches(seq: number, misses: readonly string[]): void {
    for (const h of misses) {
      const err = this.o.core.checkFetch(h);
      if (err !== "") throw new StreamFailure(seq, "inline-fetch-zero", err);
    }
  }

  /** A 200 body in its fetch completion (between frames): verified and decoded by wasm. */
  private stageFetched(r: FetchResult): void {
    if (this.phase === "disposed" || r.data === null) return;
    // The recorder keeps the fetched body (before wasm takes ownership and it is dropped).
    this.recorder?.resource(r.hash, r.data);
    r.stage_error = this.o.core.stage(r.hash, r.data);
    r.data = null; // in wasm now
  }

  /** The pending transaction's fetches (polled); all in, or the hold over, every payload in
   * provided in wasm's order and every other one deferred. */
  private advancePending(): void {
    const p = this.pending as Pending;
    const core = this.o.core;
    const seq = p.item.seq;
    const deferred = this.deferred;
    /** Missing and not deferred already (a deferred one is not waited for again). */
    const waiting = (h: string): boolean =>
      !p.bodies.has(h) && !deferred.has(h);
    const outstanding = (): boolean =>
      p.item.needed.some((n) => waiting(n.hash)) || this.folding();
    if (outstanding() && this.fetcher !== null) {
      for (const r of this.fetcher.poll().results) {
        const forSeq = p.requester.get(r.hash) ?? deferred.get(r.hash) ?? seq;
        if (r.error !== "") throw failWith(forSeq, r.error);
        p.bodies.set(r.hash, r.stage_error ?? null);
      }
      if (outstanding()) {
        const now = this.o.clock.now();
        if (p.since < 0) p.since = now;
        if (now - p.since < this.resourceHoldMs) return;
        // The hold is over: what is still missing is deferred, unless it is shader code.
        for (const n of p.item.needed)
          if (n.kind === 2 && waiting(n.hash)) return;
        for (const n of p.item.needed)
          if (waiting(n.hash))
            deferred.set(n.hash, p.requester.get(n.hash) ?? seq);
      }
    }
    for (const n of p.item.needed) {
      if (deferred.size > 0 && !p.bodies.has(n.hash) && deferred.has(n.hash)) {
        const err = core.deferPayload(n.hash);
        if (err !== null)
          throw new StreamFailure(
            p.requester.get(n.hash) ?? seq,
            "receiver-error",
            err,
          );
        continue;
      }
      const err = p.bodies.get(n.hash) ?? core.provideStaged();
      if (err !== null && err !== undefined)
        throw refusal(p.requester.get(n.hash) ?? seq, err);
    }
    // A body fetched for a folded transaction the newest no longer needs goes to the store
    // too, so it is never refetched (a deferred one is then drawn by this apply). Empty at
    // window 1.
    for (const [hash, stageError] of p.bodies) {
      if (p.item.needed.some((n) => n.hash === hash)) continue;
      if (stageError === null && !core.isStaged(hash)) continue;
      const err = stageError ?? core.takeStaged(hash);
      if (err !== null)
        throw refusal(p.requester.get(hash) ?? deferred.get(hash) ?? seq, err);
    }
    if (deferred.size > 0) for (const h of p.bodies.keys()) deferred.delete(h);
    p.stage = "ready";
  }

  /** Window 2: GETs of a folded transaction's payloads still going (not a deferred one's). */
  private folding(): boolean {
    const f = this.fetcher;
    if (f === null || !this.windowTwo()) return false;
    if (this.deferred.size === 0) return f.busy();
    for (const h of f.requested()) if (!this.deferred.has(h)) return true;
    return false;
  }

  /** Nothing waiting to apply: the deferred payloads fetched since go into the store, and a
   * revisit (an apply over the same state, no ack) makes what draws them drawable; the callback
   * then draws. Another fetched body (a folded one's) goes into the store too. */
  private pollDeferred(): void {
    const f = this.fetcher;
    if (f === null) return;
    const core = this.o.core;
    let arrived = false;
    for (const r of f.poll().results) {
      const forSeq = this.deferred.get(r.hash) ?? this.lastAppliedSeq;
      if (r.error !== "") throw failWith(forSeq, r.error);
      if (r.stage_error) throw refusal(forSeq, r.stage_error);
      if (core.isStaged(r.hash)) {
        const err = core.takeStaged(r.hash);
        if (err !== null) throw refusal(forSeq, err);
      }
      if (this.deferred.delete(r.hash)) arrived = true;
    }
    if (arrived && core.revisit(this.lastAppliedSeq)) this.revisitDraw = true;
  }

  /** The revisited state drawn, with no transaction: acks nothing, asks no credit. */
  private drawRevisit(now: number): void {
    this.revisitDraw = false;
    if (this.ext) this.ext.beforeDraw(null, now);
    this.o.core.draw(this.lastAppliedSeq);
  }

  /** The pending transaction, every payload in: apply and ack applied; then, in a frame callback
   * (`draw`), draw and ack submitted. From `onmessage` the draw waits for the next frame
   * callback, which draws the newest applied state once for every apply since the last draw. */
  private applyReady(draw: boolean): void {
    const p = this.pending as Pending;
    this.pending = null;
    const core = this.o.core;
    const seq = p.item.seq;
    core.prepareApply(seq);
    core.apply(seq);
    const facts = core.applyStats?.();
    if (facts) {
      if (facts.structural) this.structuralApplies++;
      this.lastApplyWhy = facts.why;
      this.backBufferItems = facts.backBufferItems;
    }
    if (this.ext) this.ext.applied();
    const folded = this.coalesced;
    this.coalesced = [];
    const now = this.o.clock.now();
    for (const f of folded) {
      this.ack(f.seq, "applied", now);
      this.undrawn.push(f.seq);
    }
    this.ack(seq, "applied", now);
    this.undrawn.push(seq);
    if (this.creditStage === "applied") this.lastCreditAt = now;
    this.lastAppliedSeq = seq;
    this.applied += folded.length + 1;
    this.connApplied += folded.length + 1;
    this.applyTimes[this.applyCount % APPLY_RING] = now;
    this.applyCount++;
    if (draw) this.drawApplied();
  }

  /** Draws the newest applied state and acks submitted every seq applied since the last draw. */
  private drawApplied(): void {
    const seq = this.lastAppliedSeq;
    if (this.ext) this.ext.beforeDraw(seq, this.o.clock.now());
    this.o.core.draw(seq);
    this.drawnSeq = seq;
    const now = this.o.clock.now();
    this.ackUndrawnSubmitted(now);
    this.revisitDraw = false;
    if (this.creditStage !== "applied") this.lastCreditAt = now;
    this.attempt = 0;
    if (!this.firstFrameSent) {
      this.firstFrameSent = true;
      this.status({ kind: "streaming", firstFrame: true });
    }
  }

  /** An extension asked to draw again with no
   * transaction: `beforeDraw` (seq null), the table composed, one draw. Acks nothing, asks no
   * credit. */
  private extensionRedraw(now: number): void {
    const ext = this.ext as ExtensionHost;
    if (!ext.wantsRedraw || this.connApplied === 0 || this.pending !== null)
      return;
    ext.beforeDraw(null, now);
    this.o.core.draw(this.lastAppliedSeq);
    ext.redraws++;
  }

  // ----------------------------------------------------------------------- context loss

  /** Nothing while lost; once restored, refetch any evicted resident payload, then redraw
   * the last applied state with no transaction. Credit resumes with the next transaction. */
  private stepContext(): void {
    if (this.ctx !== "restoring") return;
    const core = this.o.core;
    if (this.connApplied === 0) {
      this.ctx = "ok";
      return;
    }
    if (this.restoreWant === null) {
      this.restoreWant = core.restoreMissing();
      if (this.restoreWant.length > 0) {
        if (this.makeFetcher === null)
          throw new StreamFailure(
            this.lastAppliedSeq,
            "resource-unavailable",
            `context restore: payload ${this.restoreWant[0]} left the store, and the session has no HTTP fetch`,
          );
        this.restoreFetcher = this.makeFetcher();
        this.restoreFetcher.start(this.restoreWant);
      }
    }
    if (this.restoreFetcher !== null) {
      for (const r of this.restoreFetcher.poll().results) {
        if (r.error !== "") throw failWith(this.lastAppliedSeq, r.error);
        if (r.stage_error) throw refusal(this.lastAppliedSeq, r.stage_error);
        this.restoreBodies.set(r.hash, null);
      }
      if (this.restoreWant.some((h) => !this.restoreBodies.has(h))) return;
      for (const h of this.restoreWant) {
        const err = core.takeStaged(h);
        if (err !== null)
          throw new StreamFailure(this.lastAppliedSeq, "resource-invalid", err);
      }
      this.restoreFetcher = null;
      this.restoreBodies.clear();
    }
    if (core.redraw(this.lastAppliedSeq) === "lost") {
      this.ctx = "lost";
      this.restoreWant = null;
      return;
    }
    this.restoreWant = null;
    this.ctx = "ok";
    this.drawnSeq = this.lastAppliedSeq;
    // The redraw drew the newest applied state, so every apply waiting for a draw is in it.
    const now = this.o.clock.now();
    this.ackUndrawnSubmitted(now);
  }
}

function refusal(seq: number, err: string): StreamFailure {
  return new StreamFailure(
    seq,
    err.startsWith("resource-hash")
      ? "resource-hash-mismatch"
      : "resource-invalid",
    err,
  );
}
