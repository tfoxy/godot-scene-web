// The client's protocol loop (mirror-client-design.md "The loop"): the harness receiver's live
// order (web/gsw-receiver/live.ts `LiveReceiver`) minus everything evidence-only.
//
// 1. A message decodes and validates in its own event (one copy into wasm, W11t live coding
//    first), is acked `received`, and queues.
// 2. One frame callback (rAF) runs the connection phases, then the pending transaction's fetches
//    (each payload verified by wasm on arrival, G7o2), then apply, ack `applied`, draw, ack
//    `submitted`. Credit comes from this paced loop, never on receipt: a hidden page runs no frame
//    callback, so no credit returns and the hub stops publishing to this connection (G7u).
//
// Credit window 2 (G7q): a transaction that arrives while another waits for its payloads folds
// into it in place, and several queued transactions apply in one callback, drawing the newest;
// each folded one is acked with it. Window 1 (the host's grant may be 1) keeps the superseded path:
// the newest is applied by a fresh applier.
//
// Loss: a close without an end record, other than 1002/1008/1009, reconnects as a fresh session
// (G1d's RECONNECT: the applier is reset, the payload store, the compiled module and the browser's
// HTTP cache are kept), after 1, 2, 4, 8 s and then every 10 s; the count resets once a connection
// draws. A coding failure asks a `coding` resync in place (W11t, GTS `transport_skip`), and the
// full it forces is applied by a rebuilt applier that inherits the GPU residency (GRH). A WebGL
// context loss holds the loop; after the restore, one callback redraws the last applied state
// in place (G7u), refetching any resident payload the store no longer holds.

import type { Needed, SessionMeta, StreamCore } from "./core";
import { failWith, StreamFailure } from "./core";
import type { RenderStreamEndpoint } from "./endpoint";
import { type FetchResult, LiveFetcher } from "./fetcher";
import { clientHello } from "./hello";
import type {
  RenderStreamTransport,
  RenderStreamTransportFactory,
} from "./transport";

/** The failure reasons the client reports (the receiver's typed names, plus the client's own). */
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
  /** Median ms from a submitted ack to the next transaction's arrival (the last 64), or null. */
  creditRttMsP50: number | null;
  /** The wasm instance's memory (0 after dispose). */
  heapBytes: number;
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
  onStatus: (s: RenderStreamStatus) => void;
  canvas: () => HelloCanvas;
  clock: LoopClock;
  connectTimeoutMs?: number;
  fetchTimeoutMs?: number;
}

/** Backoff before reconnect attempt n (1-based): 1, 2, 4, 8 s, then 10 s. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 10000] as const;
const CLOSE_WAIT_MS = 2000;
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
  /** G7q: the seq each payload was requested for (a folded one's failure is reported at it). */
  requester: Map<string, number>;
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
  // Stats: counters and two fixed rings, no per-frame allocation.
  private applied = 0;
  private readonly applyTimes = new Float64Array(APPLY_RING);
  private applyCount = 0;
  private readonly rtts = new Float64Array(RTT_SAMPLES);
  private rttCount = 0;
  private lastSubmittedAt: number | null = null;

  constructor(private readonly o: LoopOptions) {
    this.endpoint = o.endpoint;
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
    core.beginConnection();
    try {
      conn.transport = this.o.transport(
        this.endpoint,
        `render-stream.${this.endpoint.protocol}`,
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
        protocol: this.endpoint.protocol,
        creditWindow: this.o.creditWindow,
        token: this.endpoint.token,
        backing: c.backing,
        css: c.css,
        dprMilli: c.dprMilli,
        gpuFormats: c.gpuFormats,
      }),
    );
  }

  private send(message: Record<string, unknown>): void {
    this.conn?.transport?.send(JSON.stringify(message));
  }

  private ack(seq: number, stage: "received" | "applied" | "submitted"): void {
    this.send({
      type: "ack",
      stream_id: this.conn?.streamId ?? "",
      seq,
      stage,
      t_us: Math.round(this.o.clock.now() * 1000),
    });
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
    const m = this.o.core.receive(buf, conn.sessionSeen);
    switch (m.kind) {
      case "held":
      case "resource":
        return;
      case "coding-resync":
        // W11t: the decoder skips based transactions until the full one, which a rebuilt
        // applier applies (the applier is delta-driven); GTS: the full may jump the seq.
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
    const now = this.o.clock.now();
    if (this.lastSubmittedAt !== null) {
      this.rtts[this.rttCount % RTT_SAMPLES] = now - this.lastSubmittedAt;
      this.rttCount++;
      this.lastSubmittedAt = null;
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
      this.rebuildDue = true;
    }
    this.queue.push(item);
  }

  private beginSession(conn: Connection, session: SessionMeta): void {
    conn.streamId = session.stream?.stream_id ?? "";
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
      this.makeFetcher = () =>
        new LiveFetcher(
          (path, signal) => transport.fetchResource(path, { token, signal }),
          httpPath,
          this.o.fetchTimeoutMs ?? 10000,
          0,
          (r) => this.stageFetched(r),
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
    try {
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
    } else if (this.pending !== null) {
      this.advancePending();
      if (this.pending?.stage === "ready") this.applyReady();
    } else if (this.queue.length > 0) {
      this.takeQueued();
    }
    if (this.phase !== "streaming") return;
    if (
      this.ctx === "ok" &&
      this.endSeen &&
      this.queue.length === 0 &&
      this.pending === null
    ) {
      // The receiver closes first (the host lingers for it after the end record).
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
    this.endSeen = false;
    this.rebuildDue = false;
    this.lastSubmittedAt = null;
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

  /** G7q: the session granted credit window 2. */
  private windowTwo(): boolean {
    return this.grantedWindow >= 2;
  }

  /** G7q: `next` folds into the pending transaction in place: the fetches it made are kept, and
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
    this.fetcher?.retain(new Set(next.needed.map((n) => n.hash)));
    if (misses.length > 0) {
      const fetcher = this.needFetcher(next.seq, misses[0]);
      this.checkFetches(next.seq, misses);
      fetcher.extend(misses);
    }
  }

  /** The newest queued transaction becomes the one to apply (receiver.gd `_apply_newest`). */
  private takeQueued(): void {
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
    };
    const misses = item.needed.map((n) => n.hash);
    if (misses.length > 0) {
      const fetcher = this.needFetcher(item.seq, misses[0]);
      this.checkFetches(item.seq, misses);
      fetcher.start(misses);
    }
    this.advancePending();
    if (this.pending?.stage === "ready") this.applyReady();
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

  /** G7o2: a 200 body in its fetch completion (between frames): verified and decoded by wasm. */
  private stageFetched(r: FetchResult): void {
    if (this.phase === "disposed" || r.data === null) return;
    r.stage_error = this.o.core.stage(r.hash, r.data);
    r.data = null; // in wasm now
  }

  /** The pending transaction's fetches (polled); all in, every payload provided in wasm's order. */
  private advancePending(): void {
    const p = this.pending as Pending;
    const core = this.o.core;
    const seq = p.item.seq;
    const outstanding = (): boolean =>
      p.item.needed.some((n) => !p.bodies.has(n.hash)) ||
      (this.windowTwo() && (this.fetcher?.busy() ?? false));
    if (outstanding() && this.fetcher !== null) {
      for (const r of this.fetcher.poll().results) {
        const forSeq = p.requester.get(r.hash) ?? seq;
        if (r.error !== "") throw failWith(forSeq, r.error);
        p.bodies.set(r.hash, r.stage_error ?? null);
      }
      if (outstanding()) return;
    }
    for (const n of p.item.needed) {
      const err = p.bodies.get(n.hash) ?? core.provideStaged();
      if (err !== null && err !== undefined)
        throw refusal(p.requester.get(n.hash) ?? seq, err);
    }
    // G7q: a body fetched for a folded transaction the newest no longer needs goes to the store
    // too, so it is never refetched. Empty at window 1.
    for (const [hash, stageError] of p.bodies) {
      if (p.item.needed.some((n) => n.hash === hash)) continue;
      if (stageError === null && !core.isStaged(hash)) continue;
      const err = stageError ?? core.takeStaged(hash);
      if (err !== null) throw refusal(p.requester.get(hash) ?? seq, err);
    }
    p.stage = "ready";
  }

  /** The pending transaction, every payload in: apply, ack applied, draw, ack submitted, all in
   * this frame callback. */
  private applyReady(): void {
    const p = this.pending as Pending;
    this.pending = null;
    const core = this.o.core;
    const seq = p.item.seq;
    core.prepareApply(seq);
    core.apply(seq);
    const folded = this.coalesced;
    this.coalesced = [];
    for (const f of folded) this.ack(f.seq, "applied");
    this.ack(seq, "applied");
    core.draw(seq);
    for (const f of folded) this.ack(f.seq, "submitted");
    this.ack(seq, "submitted");
    const now = this.o.clock.now();
    this.lastSubmittedAt = now;
    this.lastAppliedSeq = seq;
    this.applied += folded.length + 1;
    this.connApplied += folded.length + 1;
    this.applyTimes[this.applyCount % APPLY_RING] = now;
    this.applyCount++;
    this.attempt = 0;
    if (!this.firstFrameSent) {
      this.firstFrameSent = true;
      this.status({ kind: "streaming", firstFrame: true });
    }
  }

  // ----------------------------------------------------------------------- context loss

  /** G7u: nothing while lost; once restored, refetch any evicted resident payload, then redraw
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
