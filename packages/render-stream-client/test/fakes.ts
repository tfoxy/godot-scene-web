// Test doubles for the protocol loop: a scripted core, a recording transport and a manual clock.

import type { CoreMessage, StreamCore } from "../src/core";
import type { RenderStreamEndpoint } from "../src/endpoint";
import {
  type LoopClock,
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
  beginConnection(): void {
    this.calls.push("begin");
  }
  receive(data: ArrayBuffer, sessionSeen: boolean): CoreMessage {
    const m = JSON.parse(new TextDecoder().decode(data)) as CoreMessage;
    if (!sessionSeen && m.kind !== "session")
      throw new Error("first message is not a session");
    return m;
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
  private frames = new Map<number, (ts: number) => void>();
  private timers = new Map<number, { at: number; cb: () => void }>();
  private next = 1;
  now(): number {
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

export function harness(creditWindow: 1 | 2 = 2) {
  const core = new FakeCore();
  const clock = new FakeClock();
  const transports: FakeTransport[] = [];
  const statuses: RenderStreamStatus[] = [];
  const loop = new StreamLoop({
    core,
    clock,
    endpoint: ENDPOINT,
    creditWindow,
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
