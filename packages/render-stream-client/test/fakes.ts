// Test doubles for the protocol loop: a scripted core, a recording transport and a manual clock.

import type { CoreMessage, StreamCore } from "../src/core";
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
    return m;
  }
  takeDecoded(): Uint8Array | null {
    return this.decoded;
  }
  transportSkip(): void {
    this.calls.push("transport_skip");
  }
  rebuild(seq: number) {
    this.calls.push(`rebuild ${seq}`);
    return [];
  }
  checkFetch(): string {
    return "";
  }
  stage(hash: string): string | null {
    this.staged.add(hash);
    this.calls.push(`stage ${hash}`);
    return null;
  }
  isStaged(hash: string): boolean {
    return this.staged.has(hash);
  }
  provideStaged(): string | null {
    this.calls.push("provide");
    return null;
  }
  takeStaged(hash: string): string | null {
    this.calls.push(`take ${hash}`);
    this.staged.delete(hash);
    return null;
  }
  prepareApply(): void {}
  apply(seq: number): void {
    this.calls.push(`apply ${seq}`);
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
  closed: { code: number; reason: string } | null = null;
  closes = 0;
  carrier: "websocket" | "webtransport" | undefined;
  readonly gets: {
    path: string;
    resolve: (s: number) => void;
    aborted: boolean;
  }[] = [];
  constructor(
    readonly subprotocol: string,
    readonly on: RenderStreamTransportEvents,
  ) {}
  send(text: string): void {
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
  /** One frame callback (16.7 ms later). */
  frame(): void {
    this.t += 16.7;
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
    "creditStage" | "applyOn" | "ext" | "recorder"
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
