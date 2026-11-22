// Test doubles for the protocol loop: a scripted core, a recording transport and a manual clock.

import type {
  CoreApplyStats,
  CoreMessage,
  CoreMotion,
  Needed,
  StreamCore,
} from "../src/core";
import type { RenderStreamEndpoint } from "../src/endpoint";
import {
  type LoopClock,
  type LoopOptions,
  type RenderStreamStatus,
  StreamLoop,
} from "../src/loop";
import type {
  RenderStreamTransport,
  RenderStreamTransportEvents,
} from "../src/transport";

/** A message the fake core decodes: the CoreMessage itself, as JSON bytes. */
export function msg(m: CoreMessage): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(m)).buffer as ArrayBuffer;
}

export const session = (window = 2, fetch = "http"): ArrayBuffer =>
  msg({
    kind: "session",
    meta: {
      session_id: "s",
      stream: { stream_id: "st" },
      resources: { fetch, http_path: "/resources/sha256/" },
      publication: { credit_window: window },
    },
  });

export const tx = (seq: number, needed: string[] = [], full = seq === 1) =>
  msg({
    kind: "transaction",
    seq,
    frame: seq,
    full,
    needed: needed.map((hash) => ({ hash, kind: 0 })),
  });

export class FakeCore implements StreamCore {
  readonly calls: string[] = [];
  staged = new Set<string>();
  missing: string[] = [];
  redrawResult: "ok" | "lost" = "ok";
  disposed = 0;
  /** How many `receive` calls asked for a decoded copy (the pure client must be 0). */
  copyDecoded = 0;
  private decoded: Uint8Array | null = null;
  beginConnection(): void {
    this.calls.push("begin");
  }
  receive(
    data: ArrayBuffer,
    sessionSeen: boolean,
    copyDecoded = false,
  ): CoreMessage {
    if (copyDecoded) {
      this.copyDecoded++;
      this.decoded = new Uint8Array(data);
    } else {
      this.decoded = null;
    }
    const m = JSON.parse(new TextDecoder().decode(data)) as CoreMessage;
    if (!sessionSeen && m.kind !== "session")
      throw new Error("first message is not a session");
    if (m.kind === "transaction") {
      this.motionSeq = m.seq;
      this.unprovided = m.needed.length;
    }
    return m;
  }
  /** `setMotion`: on (the loop asked), and what it answers (false: a core that cannot measure). */
  motionOn = false;
  motionSupported = true;
  setMotionCalls: boolean[] = [];
  setMotion(on: boolean): boolean {
    this.setMotionCalls.push(on);
    this.motionOn = on;
    return this.motionSupported;
  }
  /** What `motion` answers for every transaction received while on (its `seq` is the last
   * transaction's); default ambient: a hundredth of a pixel of drift. null: nothing measured. */
  motionFacts: Omit<CoreMotion, "seq"> | null = {
    changes: 0,
    maxPx: 0.01,
    colorStep: 0,
  };
  motionReads = 0;
  private motionSeq = 0;
  motion(): CoreMotion | null {
    this.motionReads++;
    if (!this.motionOn || !this.motionSupported || this.motionFacts === null)
      return null;
    return { seq: this.motionSeq, ...this.motionFacts };
  }
  takeDecoded(): Uint8Array | null {
    return this.decoded;
  }
  /** What `hintRefs` answers next (then empties); `hintRefsCalls` counts the calls. */
  refs: string[] = [];
  hintRefsCalls = 0;
  hintRefs(): string[] {
    this.hintRefsCalls++;
    const r = this.refs;
    this.refs = [];
    return r;
  }
  transportSkip(): void {
    this.calls.push("transport_skip");
  }
  /** What `rebuild` answers (the rebuilt applier's needed set). */
  rebuildNeeded: Needed[] = [];
  rebuild(seq: number) {
    this.calls.push(`rebuild ${seq}`);
    this.unprovided = this.rebuildNeeded.length;
    return this.rebuildNeeded;
  }
  checkFetch(): string {
    return "";
  }
  /** Refusals `stage` answers by hash (a body failing verification or decoding). */
  stageErrors = new Map<string, string>();
  stage(hash: string): string | null {
    this.calls.push(`stage ${hash}`);
    const err = this.stageErrors.get(hash) ?? null;
    if (err === null) this.staged.add(hash);
    return err;
  }
  isStaged(hash: string): boolean {
    return this.staged.has(hash);
  }
  provideStaged(): string | null {
    this.calls.push("provide");
    this.unprovided = Math.max(0, this.unprovided - 1);
    return null;
  }
  takeStaged(hash: string): string | null {
    this.calls.push(`take ${hash}`);
    this.staged.delete(hash);
    return null;
  }
  deferPayload(hash: string): string | null {
    this.calls.push(`defer ${hash}`);
    this.unprovided = Math.max(0, this.unprovided - 1);
    return null;
  }
  /** Hashes the newest accepted state does not name (`named` answers 0 for them). */
  unnamed = new Set<string>();
  /** How many `named` calls, and how many hashes they asked (the warm stream asks none). */
  namedCalls = 0;
  namedHashes = 0;
  named(hashes: readonly string[]): Uint8Array {
    this.namedCalls++;
    this.namedHashes += hashes.length;
    return Uint8Array.from(hashes, (h) => (this.unnamed.has(h) ? 0 : 1));
  }
  dropStaged(hash: string): boolean {
    this.calls.push(`drop ${hash}`);
    return this.staged.delete(hash);
  }
  restoreUnavailable(hash: string): string | null {
    this.calls.push(`restore-unavailable ${hash}`);
    return null;
  }
  /** What `revisit` answers (a real core: whether a deferred payload reached the store). */
  revisitResult = true;
  revisit(seq: number): boolean {
    this.calls.push(`revisit ${seq}`);
    return this.revisitResult;
  }
  /** J1: what the next `pollPrograms` calls answer, in order (then false); each call is logged
   * in `calls` when `logPolls`. */
  settles: boolean[] = [];
  logPolls = false;
  pollPrograms(): boolean {
    if (this.logPolls) this.calls.push("poll-programs");
    return this.settles.shift() ?? false;
  }
  /** J1: what the next `settleParticles` calls answer, in order (then false); logged when
   * `logPolls`. */
  particleSettles: boolean[] = [];
  settleParticles(seq: number): boolean {
    if (this.logPolls) this.calls.push(`settle-particles ${seq}`);
    return this.particleSettles.shift() ?? false;
  }
  /** How many `prepareApply` calls (one per run of the applier). */
  prepareApplies = 0;
  prepareApply(): void {
    this.prepareApplies++;
  }
  /** Refuse an apply while the last accept's needed payloads are not all provided or deferred,
   * as the Rust core does (its needed list and provide cursor reset at every accept). */
  enforceProvided = false;
  private unprovided = 0;
  apply(seq: number): void {
    if (this.enforceProvided && this.unprovided > 0)
      throw new Error(
        `apply: ${this.unprovided} needed payload(s) not provided`,
      );
    this.calls.push(`apply ${seq}`);
  }
  /** What `applyStats` answers after every apply. */
  facts: CoreApplyStats = { structural: false, why: 0, backBufferItems: 0 };
  applyStats(): CoreApplyStats {
    return this.facts;
  }
  draw(seq: number): void {
    this.calls.push(`draw ${seq}`);
  }
  redraw(seq: number): "ok" | "lost" {
    this.calls.push(`redraw ${seq}`);
    return this.redrawResult;
  }
  restoreMissing(): string[] {
    return this.missing;
  }
  reset(keep: boolean): void {
    this.calls.push(`reset ${keep}`);
  }
  heapBytes(): number {
    return this.disposed ? 0 : 1 << 20;
  }
  dispose(): void {
    this.disposed++;
  }
}

export class FakeTransport implements RenderStreamTransport {
  readonly sent: Record<string, unknown>[] = [];
  /** The sent text as framed, byte for byte. */
  readonly texts: string[] = [];
  closed: { code: number; reason: string } | null = null;
  closes = 0;
  carrier: "websocket" | "webtransport" | undefined;
  readonly gets: {
    path: string;
    resolve: (s: number) => void;
    /** The request rejects (a network error). */
    reject: (e: Error) => void;
    aborted: boolean;
  }[] = [];
  constructor(
    readonly subprotocol: string,
    readonly on: RenderStreamTransportEvents,
  ) {}
  send(text: string): void {
    this.texts.push(text);
    this.sent.push(JSON.parse(text));
  }
  close(code: number, reason: string): void {
    this.closes++;
    this.closed = { code, reason };
  }
  fetchResource(
    path: string,
    init: { token: string | null; signal: AbortSignal },
  ) {
    return new Promise<{ status: number; body: ArrayBuffer | null }>(
      (res, rej) => {
        const g = {
          path,
          aborted: false,
          resolve: (status: number) =>
            res({ status, body: new ArrayBuffer(4) }),
          reject: (e: Error) => rej(e),
        };
        init.signal.addEventListener("abort", () => {
          g.aborted = true;
          rej(new Error("aborted"));
        });
        this.gets.push(g);
      },
    );
  }
  /** The acks sent, as `<stage> <seq>`. */
  acks(): string[] {
    return this.sent
      .filter((m) => m.type === "ack")
      .map((m) => `${m.stage} ${m.seq}`);
  }
}

export class FakeClock implements LoopClock {
  t = 0;
  /** Advances `t` on every `now()` (a real clock moves between two reads). */
  step = 0;
  private frames = new Map<number, (ts: number) => void>();
  private timers = new Map<number, { at: number; cb: () => void }>();
  private next = 1;
  now(): number {
    this.t += this.step;
    return this.t;
  }
  requestFrame(cb: (ts: number) => void): number {
    const id = this.next++;
    this.frames.set(id, cb);
    return id;
  }
  cancelFrame(id: number): void {
    this.frames.delete(id);
  }
  setTimeout(cb: () => void, ms: number): number {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, cb });
    return id;
  }
  clearTimeout(id: number): void {
    this.timers.delete(id);
  }
  pendingFrames(): number {
    return this.frames.size;
  }
  /** One frame callback (16.7 ms later by default). */
  frame(ms = 16.7): void {
    this.t += ms;
    const due = [...this.frames.values()];
    this.frames.clear();
    for (const cb of due) cb(this.t);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].cb();
    }
    this.t = end;
  }
}

export const ENDPOINT: RenderStreamEndpoint = {
  url: "ws://127.0.0.1:1/render-stream",
  resourceBase: "http://127.0.0.1:1",
  token: null,
  protocol: 12,
};

export function harness(
  creditWindow: 1 | 2 = 2,
  pacing: Pick<
    LoopOptions,
    | "creditStage"
    | "applyOn"
    | "ext"
    | "recorder"
    | "resourceHoldMs"
    | "fetchTimeoutMs"
    | "resourceHints"
    | "prefetchMaxInFlight"
    | "prefetchBudgetBytes"
    | "frameCap"
    | "clientTweens"
  > = {},
  core: FakeCore = new FakeCore(),
  endpoint: RenderStreamEndpoint = ENDPOINT,
) {
  const clock = new FakeClock();
  const transports: FakeTransport[] = [];
  const statuses: RenderStreamStatus[] = [];
  const loop = new StreamLoop({
    core,
    clock,
    endpoint,
    creditWindow,
    ...pacing,
    onStatus: (s) => statuses.push(s),
    transport: (_e, sub, on) => {
      const t = new FakeTransport(sub, on);
      transports.push(t);
      return t;
    },
    canvas: () => ({
      backing: [640, 360],
      css: [640, 360],
      dprMilli: 1000,
      gpuFormats: "none",
    }),
  });
  const last = () => transports[transports.length - 1];
  return { core, clock, transports, statuses, loop, last };
}

/** Lets settled promises (a fetch's completion) run. */
export const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------- WebTransport

export interface FakeBidi {
  /** Bytes the client wrote, concatenated. */
  written(): Uint8Array;
  /** Whether the client finished (FIN) its write side. */
  finished(): boolean;
  /** The host sends bytes on the stream. */
  serverSend(bytes: Uint8Array): void;
  serverFin(): void;
  serverReset(e?: unknown): void;
  cancelled(): boolean;
}

export interface FakeUni {
  written(): Uint8Array;
  finished(): boolean;
}

function joined(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A WebTransport double: `ready`/`closed` settled by the test, bidirectional streams the test
 * drives. Install with `vi.stubGlobal("WebTransport", FakeWebTransport)`; instances register in
 * `FakeWebTransport.instances`. */
export class FakeWebTransport {
  static instances: FakeWebTransport[] = [];
  static reset(): void {
    FakeWebTransport.instances = [];
  }
  readonly streams: FakeBidi[] = [];
  readonly closeCalls: { closeCode?: number; reason?: string }[] = [];
  protocol = "";
  /** Set to make `createBidirectionalStream` reject. */
  streamError: unknown = null;
  /** Client unidirectional (uplink) streams, in creation order. */
  readonly uniStreams: FakeUni[] = [];
  /** How the n-th unidirectional stream behaves: `ok` closes at once; `wedge` takes writes and
   * never closes (Chrome on Android); `refuse` rejects its close with stream error 1 (a
   * host that predates uplink streams). */
  uniBehaviour: (n: number) => "ok" | "wedge" | "refuse" = () => "ok";
  /** A bidirectional stream's close never settles (a wedged live stream). */
  bidiCloseHangs = false;
  readonly ready: Promise<void>;
  readonly closed: Promise<{ closeCode?: number; reason?: string }>;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;
  private resolveClosed!: (i: { closeCode?: number; reason?: string }) => void;
  private rejectClosed!: (e: unknown) => void;
  private readonly resets: ((e: unknown) => void)[] = [];
  constructor(
    readonly url: string,
    readonly options: Record<string, unknown> = {},
  ) {
    this.ready = new Promise((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    this.closed = new Promise((res, rej) => {
      this.resolveClosed = res;
      this.rejectClosed = rej;
    });
    this.ready.catch(() => {});
    this.closed.catch(() => {});
    FakeWebTransport.instances.push(this);
  }
  /** The session is established. */
  establish(): void {
    this.resolveReady();
  }
  /** The attempt failed (before or after ready). */
  fail(e: unknown = new Error("net::ERR_QUIC")): void {
    this.rejectReady(e);
    this.rejectClosed(e);
    for (const r of this.resets) r(e);
  }
  /** The host closes the session cleanly. */
  serverClose(info: { closeCode?: number; reason?: string } = {}): void {
    this.end(info);
  }
  close(info: { closeCode?: number; reason?: string } = {}): void {
    this.closeCalls.push(info);
    this.end(info);
  }
  /** Like a browser: a session that ends resets its streams, and rejects `ready` if it never
   * established. */
  private end(info: { closeCode?: number; reason?: string }): void {
    this.rejectReady(new Error("session closed"));
    this.resolveClosed(info);
    for (const r of this.resets) r(new Error("session closed"));
  }
  async createBidirectionalStream() {
    if (this.streamError) throw this.streamError;
    let rc!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const chunks: Uint8Array[] = [];
    let fin = false;
    const readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        rc = c;
      },
      cancel: () => {
        cancelled = true;
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write: (c) => {
        chunks.push(c);
      },
      close: () => {
        if (this.bidiCloseHangs) return new Promise<void>(() => {});
        fin = true;
      },
    });
    this.resets.push((e) => {
      try {
        rc.error(e);
      } catch {
        // already closed
      }
    });
    this.streams.push({
      written: () => {
        const n = chunks.reduce((a, c) => a + c.length, 0);
        const out = new Uint8Array(n);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        return out;
      },
      finished: () => fin,
      serverSend: (b) => rc.enqueue(b),
      serverFin: () => rc.close(),
      serverReset: (e = new Error("reset")) => rc.error(e),
      cancelled: () => cancelled,
    });
    return { readable, writable };
  }
  async createUnidirectionalStream() {
    if (this.streamError) throw this.streamError;
    const mode = this.uniBehaviour(this.uniStreams.length);
    const chunks: Uint8Array[] = [];
    let fin = false;
    this.uniStreams.push({
      written: () => joined(chunks),
      finished: () => fin,
    });
    return new WritableStream<Uint8Array>({
      write: (c) => {
        chunks.push(c);
      },
      close: () => {
        if (mode === "wedge") return new Promise<void>(() => {});
        if (mode === "refuse")
          return Promise.reject(
            Object.assign(new Error("STOP_SENDING"), { streamErrorCode: 1 }),
          );
        fin = true;
      },
    });
  }
}

/** A live-stream frame as the host sends it. */
export function frame(kind: 0 | 1, body: Uint8Array | string): Uint8Array {
  const b = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const out = new Uint8Array(5 + b.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, b.length, true);
  out.set(b, 5);
  return out;
}

/** A resource response as the host sends it. */
export function resourceResponse(
  status: number,
  coding: number,
  body: Uint8Array,
  lenOverride?: number,
): Uint8Array {
  const out = new Uint8Array(7 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, status, true);
  out[2] = coding;
  dv.setUint32(3, lenOverride ?? body.length, true);
  out.set(body, 7);
  return out;
}
