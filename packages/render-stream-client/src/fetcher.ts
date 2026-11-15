// The live HTTP fetcher: the native receiver's
// RsResourceFetcher over an injected request function. `GET <prefix><hash>`, up to `maxInFlight`
// at a time (default ONE, the harness's evidence order), polled from the rAF loop: `poll()` starts
// requests while a slot is free (after an optional delay, a timed wait, never a blocked loop) and
// hands back each completed one, in completion order. `onBody` runs in the request's own
// completion (between frames), where the caller copies a 200 body into wasm and `stage_payload`
// verifies its SHA-256 and decodes it before anything uses it; this file never inspects a payload.
// The transaction that needs them stays unapplied meanwhile, and the canvas keeps the previous
// frame.
//
// With a `stager`, the fetcher asks for the body as a stream and writes each chunk into wasm
// as it arrives (hashed there, in its own buffer per hash), yielding a task after every
// `sliceBytes`, so no single task copies or hashes a whole large body; the result's
// `stage_error` is the stager's verdict and `onBody` is not called for it. A response without a
// stream (a transport that ignores the ask) goes through `onBody` as before.
//
// A non-200 status, a request that cannot be made, and one not complete within `timeoutMs` of its
// start are `resource-unavailable`; the first error stops the queue and aborts the other GETs in
// flight (rs_resource_fetcher.gd).
//
// The request is injectable: the client passes its transport's `fetchResource`, and the harness passes
// its own `fetch` with the token, the cache mode its sabotages need and the response headers its
// evidence records.

import type { StagingStream } from "./core";

/** One GET's answer: its status, its body, and (the harness's evidence) its kept headers. With
 * `stream` asked, a 200 may carry `stream` (and `sizeHint`, its `Content-Length` or 0) instead
 * of `body`. */
export interface ResourceResponse {
  status: number;
  body: ArrayBuffer | null;
  headers?: Record<string, string>;
  stream?: ReadableStream<Uint8Array> | null;
  sizeHint?: number;
}

/** `GET <path>`, aborted through `signal` (the fetcher's timeout, or `abort`). `opts.stream`:
 * the fetcher can take the body as a stream. */
export type ResourceRequest = (
  path: string,
  signal: AbortSignal,
  opts?: { stream: boolean },
) => Promise<ResourceResponse>;

export interface FetchResult {
  hash: string;
  status: number | null;
  bytes: number;
  data: Uint8Array | null;
  start_us: number;
  end_us: number;
  delay_us: number;
  headers: Record<string, string>;
  /** `resource-unavailable: ...`, or "" */
  error: string;
  /** Set by `onBody` (the verify and decode on arrival, and its refusal if any). */
  verify_us?: number;
  stage_error?: string | null;
  /** The body was a KTX2 whose transcode failed (`delivery-transcode-failed`): the variant
   * is refused and wasm's needed set recomputed; the caller fetches the fallback. */
  transcode_fallback?: boolean;
  /** The body was staged as it arrived (the stager's verdict is `stage_error`). */
  streamed?: boolean;
}

export interface LiveFetcherOptions {
  /** GETs in flight at once (default 1). */
  maxInFlight?: number;
  /** Stage bodies as they arrive (absent: whole bodies through `onBody`). */
  stager?: ((hash: string, sizeHint: number) => StagingStream) | null;
  /** Streamed bytes written between two yielded tasks (default 256 KiB: a short task
   * even on a phone). */
  sliceBytes?: number;
  /** Yields the task (default `scheduler.yield`, else a MessageChannel round trip). */
  yieldTask?: () => Promise<void>;
}

const us = (): number => Math.round(performance.now() * 1000);

const DEFAULT_SLICE_BYTES = 256 << 10;

/** A new task (not a microtask), unclamped: `scheduler.yield` where the page has it, else a
 * MessageChannel message (a nested `setTimeout(0)` is clamped to 4 ms). */
export function yieldTask(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } })
    .scheduler;
  if (typeof sched?.yield === "function") return sched.yield();
  if (typeof MessageChannel === "function")
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(null);
    });
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** One GET in flight. */
interface InFlight {
  abort: AbortController;
}

export class LiveFetcher {
  private queue: string[] = [];
  /** The GETs in flight, by hash. */
  private readonly inFlight = new Map<string, InFlight>();
  private delayUntil = -1;
  private done: FetchResult[] = [];
  /** Completed bodies whose `onBody` promise (a transcode) has not settled yet. */
  private staging = new Set<string>();
  private failed = false;
  private generation = 0;
  /** Every request's abort controller (`abort` aborts them; a reconnect's `cancel` keeps them). */
  private readonly aborts = new Set<AbortController>();
  private readonly maxInFlight: number;
  private readonly stager: LiveFetcherOptions["stager"];
  private readonly sliceBytes: number;
  private readonly yieldTask: () => Promise<void>;

  constructor(
    private readonly request: ResourceRequest,
    private readonly pathPrefix: string,
    private readonly timeoutMs: number,
    private readonly delayMs: number,
    /** Called with each 200 result in its completion, before `poll` hands it back. It
     * may return a promise (a KTX2's transcode in the worker); the result is handed back when
     * it settles, while the next GET goes out meanwhile. */
    private readonly onBody:
      | ((r: FetchResult) => void | Promise<void>)
      | null = null,
    options: LiveFetcherOptions = {},
  ) {
    this.maxInFlight = Math.max(1, Math.floor(options.maxInFlight ?? 1));
    this.stager = options.stager ?? null;
    this.sliceBytes = Math.max(1, options.sliceBytes ?? DEFAULT_SLICE_BYTES);
    this.yieldTask = options.yieldTask ?? yieldTask;
  }

  /** Queues one transaction's misses, in the order wasm needs them. */
  start(hashes: string[]): void {
    this.queue = [...hashes];
    this.done = [];
    this.failed = false;
    this.delayUntil = -1;
  }

  /** Credit window 2 (a fold in place): queues more misses after those already queued,
   * keeping the GETs in flight and every completed result not yet polled. */
  extend(hashes: string[]): void {
    this.queue.push(...hashes);
  }

  /** Every hash queued, in flight, or completed and not yet polled (a fold queues only the
   * others). */
  requested(): Set<string> {
    const out = new Set(this.queue);
    for (const h of this.inFlight.keys()) out.add(h);
    for (const h of this.staging) out.add(h);
    for (const r of this.done) out.add(r.hash);
    return out;
  }

  /** Drops the queued (not yet issued) hashes not in `keep`; those in flight are kept. */
  retain(keep: ReadonlySet<string>): void {
    this.queue = this.queue.filter((h) => keep.has(h));
  }

  /** A request queued, in flight, or completed and not yet polled. */
  busy(): boolean {
    return (
      this.inFlight.size > 0 ||
      this.staging.size > 0 ||
      this.done.length > 0 ||
      (!this.failed && this.queue.length > 0)
    );
  }

  /** The GETs in flight now. */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Drops everything queued or in flight (a reconnect). A body being streamed stops at its next
   * chunk and its staging buffer is freed. */
  cancel(): void {
    this.generation++;
    this.queue = [];
    this.inFlight.clear();
    this.staging.clear();
    this.done = [];
    this.delayUntil = -1;
  }

  /** The client's dispose: `cancel`, and the GETs in flight are aborted too (a reconnect's
   * `cancel` lets a whole-body GET complete unseen, as the harness's evidence expects). */
  abort(): void {
    this.cancel();
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
  }

  /** One rAF step: completed results (in completion order), and whether the queue is finished. */
  poll(): { results: FetchResult[]; finished: boolean } {
    while (
      !this.failed &&
      this.queue.length > 0 &&
      this.inFlight.size < this.maxInFlight
    ) {
      if (this.delayMs > 0 && this.delayUntil < 0)
        this.delayUntil = performance.now() + this.delayMs;
      if (this.delayUntil >= 0 && performance.now() < this.delayUntil) break;
      const hash = this.queue.shift() as string;
      if (!this.inFlight.has(hash)) this.issue(hash);
    }
    const results = this.done;
    this.done = [];
    return {
      results,
      finished:
        this.failed ||
        (this.inFlight.size === 0 &&
          this.staging.size === 0 &&
          this.queue.length === 0),
    };
  }

  private issue(hash: string): void {
    const gen = this.generation;
    this.delayUntil = -1;
    const r: FetchResult = {
      hash,
      status: null,
      bytes: 0,
      data: null,
      start_us: us(),
      end_us: 0,
      delay_us: this.delayMs * 1000,
      headers: {},
      error: "",
    };
    const path = `${this.pathPrefix}${hash}`;
    const abort = new AbortController();
    const entry: InFlight = { abort };
    this.inFlight.set(hash, entry);
    this.aborts.add(abort);
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    /** Whether this GET still counts (not cancelled, not aborted by another's failure). */
    const current = (): boolean =>
      gen === this.generation && this.inFlight.get(hash) === entry;
    const settle = (error: string) => {
      clearTimeout(timer);
      this.aborts.delete(abort);
      if (!current()) return;
      r.end_us = us();
      r.error = error;
      this.inFlight.delete(hash);
      if (error !== "") {
        this.failed = true;
        this.queue = [];
        // The first error ends the queue: the other GETs in flight are aborted, unseen.
        for (const [h, other] of this.inFlight) {
          this.inFlight.delete(h);
          other.abort.abort();
        }
      } else if (this.onBody && !r.streamed) {
        const pending = this.onBody(r);
        if (pending instanceof Promise) {
          this.staging.add(hash);
          void pending.finally(() => {
            if (gen !== this.generation) return;
            this.staging.delete(hash);
            this.done.push(r);
          });
          return;
        }
      }
      this.done.push(r);
    };
    let started: Promise<ResourceResponse>;
    try {
      started = this.request(path, abort.signal, {
        stream: this.stager !== null,
      });
    } catch (e) {
      started = Promise.reject(e);
    }
    started
      .then(async (res) => {
        r.status = res.status;
        if (res.headers) r.headers = res.headers;
        const stream = res.stream ?? null;
        if (res.status !== 200) {
          if (stream !== null) {
            r.bytes = 0;
            stream.cancel().catch(() => {});
          } else r.bytes = res.body?.byteLength ?? 0;
          settle(
            `resource-unavailable: GET ${path} answered HTTP ${res.status}`,
          );
          return;
        }
        if (stream !== null && this.stager) {
          if (!(await this.streamInto(r, stream, res.sizeHint ?? 0, current)))
            return; // cancelled meanwhile: dropped unseen
          settle("");
          return;
        }
        const body = new Uint8Array(
          stream !== null
            ? await new Response(stream).arrayBuffer()
            : (res.body ?? new ArrayBuffer(0)),
        );
        r.bytes = body.length;
        r.data = body;
        settle("");
      })
      .catch((e: unknown) => {
        const why = abort.signal.aborted
          ? `not complete within ${this.timeoutMs} ms`
          : `the request failed (${e instanceof Error ? e.message : String(e)})`;
        settle(`resource-unavailable: GET ${path}: ${why}`);
      });
  }

  /** Reads `stream` to its end into a staging stream, yielding a task after every
   * `sliceBytes`; sets `r.bytes`, `r.streamed` and `r.stage_error`. False when the GET stopped
   * counting meanwhile (the stream is cancelled). A read error rejects; the staging buffer is
   * freed on every path but a finished one. */
  private async streamInto(
    r: FetchResult,
    stream: ReadableStream<Uint8Array>,
    sizeHint: number,
    current: () => boolean,
  ): Promise<boolean> {
    const stager = this.stager as NonNullable<LiveFetcherOptions["stager"]>;
    const sink = stager(r.hash, sizeHint);
    const reader = stream.getReader();
    let finished = false;
    try {
      let sinceYield = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (!current()) {
          reader.cancel().catch(() => {});
          return false;
        }
        if (done) break;
        for (let at = 0; at < value.length; ) {
          if (sinceYield >= this.sliceBytes) {
            await this.yieldTask();
            sinceYield = 0;
            if (!current()) {
              reader.cancel().catch(() => {});
              return false;
            }
          }
          const n = Math.min(value.length - at, this.sliceBytes - sinceYield);
          sink.write(
            at === 0 && n === value.length ? value : value.subarray(at, at + n),
          );
          at += n;
          sinceYield += n;
          r.bytes += n;
        }
      }
      finished = true;
      r.streamed = true;
      r.stage_error = sink.finish();
      return true;
    } finally {
      if (!finished) sink.abort();
      reader.releaseLock();
    }
  }
}
