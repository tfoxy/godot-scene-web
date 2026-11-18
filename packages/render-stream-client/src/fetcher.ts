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
// A non-200 status, a request that cannot be made, and one that stalls (no progress for
// `timeoutMs`: no response yet, or no body bytes since the last ones) are `resource-unavailable`,
// each with a structured `outcome` (`fetchOutcome`): `missing` (404, 410), `temporary` (408, 429,
// 5xx, a rejected request, a stall, a read error) or `fatal` (401, 403, any other status, a request
// function that throws). With `failures: "stop"` (the default, rs_resource_fetcher.gd's evidence
// order) the first error stops the queue and aborts the other GETs in flight. With `"settle"` (the
// client) a `missing` or `temporary` GET settles on its own: the queue goes on and the other GETs
// keep going; only a `fatal` one stops it.
// The stall timeout counts from the last progress, not from the start, so a large body that keeps
// arriving over a shared, slow link is never cut off mid-way. Progress is the response, each
// streamed chunk, and each `progress()` call of a request that reports its whole-body reads.
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

/** `GET <path>`, aborted through `signal` (the fetcher's stall timeout, or `abort`).
 * `opts.stream`: the fetcher can take the body as a stream. `opts.progress`: a request that reads
 * a whole body itself may call it as bytes arrive, which restarts the stall timeout. */
export type ResourceRequest = (
  path: string,
  signal: AbortSignal,
  opts?: { stream: boolean; progress?: () => void },
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
  /** What the GET came to (`fetchOutcome`); "ok" with `error` "". */
  outcome?: FetchOutcome;
  /** Set by `onBody` (the verify and decode on arrival, and its refusal if any). */
  verify_us?: number;
  stage_error?: string | null;
  /** The body was a KTX2 whose transcode failed (`delivery-transcode-failed`): the variant
   * is refused and wasm's needed set recomputed; the caller fetches the fallback. */
  transcode_fallback?: boolean;
  /** The body was staged as it arrived (the stager's verdict is `stage_error`). */
  streamed?: boolean;
}

/** A GET's structured result: `ok` (a 200 body), `missing` (the host does not hold the payload:
 * 404, 410), `temporary` (it could not be had now: 408, 429, 5xx, a rejected request, a stall, a
 * read error) or `fatal` (a configuration or protocol error: 401, 403, any other status, a request
 * that cannot be made). */
export type FetchOutcome = "ok" | "missing" | "temporary" | "fatal";

/** The outcome of an HTTP status (`FetchOutcome`). */
export function statusOutcome(status: number): FetchOutcome {
  if (status === 200) return "ok";
  if (status === 404 || status === 410) return "missing";
  if (status === 408 || status === 429 || (status >= 500 && status <= 599))
    return "temporary";
  return "fatal";
}

export interface LiveFetcherOptions {
  /** GETs in flight at once (default 1). */
  maxInFlight?: number;
  /** `stop` (default): the first error stops the queue and aborts the other GETs in flight.
   * `settle`: a `missing` or `temporary` GET is handed back on its own and the rest go on; a
   * `fatal` one still stops the queue. */
  failures?: "stop" | "settle";
  /** Client retries use its loop clock and live demand/hint eligibility. Absent: settle as before. */
  retry?: {
    now: () => number;
    mode: (hash: string, background: boolean) => "demand" | "prefetch" | null;
    onRetry: () => void;
  };
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

// Three retries after the initial GET; bounded backoff avoids hammering a temporary outage.
const TEMPORARY_RETRY_DELAYS_MS = [250, 500, 1000] as const;

interface Retry {
  result: FetchResult;
  background: boolean;
  due: number;
  attempt: number;
}

/** One GET in flight. */
interface InFlight {
  abort: AbortController;
  /** Advisory work must never abort another GET when it fails. */
  background: boolean;
}

export class LiveFetcher {
  private queue: string[] = [];
  /** The GETs in flight, by hash. */
  private readonly inFlight = new Map<string, InFlight>();
  private delayUntil = -1;
  private done: FetchResult[] = [];
  /** Completed bodies whose `onBody` promise (a transcode) has not settled yet. */
  private staging = new Set<string>();
  private readonly retries = new Map<string, Retry>();
  private readonly retry: LiveFetcherOptions["retry"];
  private failed = false;
  private generation = 0;
  /** Every request's abort controller (`abort` aborts them; a reconnect's `cancel` keeps them). */
  private readonly aborts = new Set<AbortController>();
  private readonly maxInFlight: number;
  private readonly settleFailures: boolean;
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
    this.settleFailures = options.failures === "settle";
    this.stager = options.stager ?? null;
    this.retry = options.retry;
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
   * keeping the GETs in flight and every completed result not yet polled. A hash already queued,
   * in flight or completed and not yet polled is not queued twice. */
  extend(hashes: readonly string[]): void {
    for (const h of hashes) if (!this.has(h)) this.queue.push(h);
  }

  /** Starts advisory work only in a free slot after every queued demand. No background queue:
   * the caller rechecks hint validity and its idle condition before each start. */
  prefetch(hash: string): boolean {
    if (
      this.failed ||
      this.queue.length > 0 ||
      this.inFlight.size >= this.maxInFlight
    )
      return false;
    const retry = this.retries.get(hash);
    if (retry !== undefined) {
      if (
        this.retry?.mode(hash, retry.background) !== "prefetch" ||
        this.retry.now() < retry.due
      )
        return false;
      this.retries.delete(hash);
      this.retry.onRetry();
      this.issue(hash, retry.background, retry.attempt);
    } else {
      if (this.has(hash)) return false;
      this.issue(hash, true);
    }
    return true;
  }

  /** `hash` is queued, waiting to retry, in flight, or completed and not yet polled. */
  has(hash: string): boolean {
    if (
      this.inFlight.has(hash) ||
      this.staging.has(hash) ||
      this.retries.has(hash)
    )
      return true;
    if (this.queue.includes(hash)) return true;
    for (const r of this.done) if (r.hash === hash) return true;
    return false;
  }

  /** `hash` is in flight (issued, or its body being staged), not merely queued. */
  active(hash: string): boolean {
    return this.inFlight.has(hash) || this.staging.has(hash);
  }

  /** Drops `hash` from the queue (not yet issued); one in flight is kept. */
  unqueue(hash: string): void {
    const at = this.queue.indexOf(hash);
    if (at >= 0) this.queue.splice(at, 1);
  }

  /** The hashes queued and not yet issued. */
  queued(): readonly string[] {
    return this.queue;
  }

  /** Every hash queued, waiting to retry, in flight, or completed and not yet polled
   * (a fold queues only the others). */
  requested(): Set<string> {
    const out = new Set(this.queue);
    for (const h of this.inFlight.keys()) out.add(h);
    for (const h of this.staging) out.add(h);
    for (const h of this.retries.keys()) out.add(h);
    for (const r of this.done) out.add(r.hash);
    return out;
  }

  /** Drops the queued (not yet issued) hashes not in `keep`; those in flight are kept. */
  retain(keep: ReadonlySet<string>): void {
    this.queue = this.queue.filter((h) => keep.has(h));
  }

  /** A request queued, waiting to retry, in flight, or completed and not yet polled. */
  busy(): boolean {
    return (
      this.inFlight.size > 0 ||
      this.staging.size > 0 ||
      this.done.length > 0 ||
      this.retries.size > 0 ||
      (!this.failed && this.queue.length > 0)
    );
  }

  /** The GETs in flight now. */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Drops everything queued or in flight (a reconnect). A body being streamed stops at its next
   * chunk and its staging buffer is freed. A window-1 supersession can keep waiting retries,
   * preserving their deadlines and attempt counts while the new accepted state is rebuilt. */
  cancel(options: { keepRetries?: boolean } = {}): void {
    this.generation++;
    this.queue = [];
    this.inFlight.clear();
    this.staging.clear();
    if (!options.keepRetries) this.retries.clear();
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
    // Leaving the accepted names or hint window cancels a wait, never an in-flight GET.
    for (const [hash, retry] of this.retries)
      if (this.retry?.mode(hash, retry.background) == null) {
        this.retries.delete(hash);
        this.done.push(retry.result);
      }
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
    // Queued demands get first use of free slots, then demand retries. Hint retries are
    // started by `prefetch`, so the loop's idle gate and hint priority order still apply.
    for (const [hash, retry] of this.retries) {
      if (this.inFlight.size >= this.maxInFlight) break;
      if (
        this.failed ||
        this.queue.length > 0 ||
        this.retry?.mode(hash, retry.background) !== "demand" ||
        this.retry.now() < retry.due
      )
        continue;
      this.retries.delete(hash);
      this.retry.onRetry();
      this.issue(hash, retry.background, retry.attempt);
    }
    const results = this.done;
    this.done = [];
    return {
      results,
      finished:
        this.failed ||
        (this.inFlight.size === 0 &&
          this.staging.size === 0 &&
          this.queue.length === 0 &&
          this.retries.size === 0),
    };
  }

  private issue(hash: string, background = false, attempt = 0): void {
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
    const entry: InFlight = { abort, background };
    this.inFlight.set(hash, entry);
    this.aborts.add(abort);
    // The stall timeout: restarted by every sign of progress, so it fires only after
    // `timeoutMs` with none.
    let stalled = false;
    let timer = setTimeout(() => {
      stalled = true;
      abort.abort();
    }, this.timeoutMs);
    let over = false;
    const progress = (): void => {
      if (stalled || over) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        abort.abort();
      }, this.timeoutMs);
    };
    /** Whether this GET still counts (not cancelled, not aborted by another's failure). */
    const current = (): boolean =>
      gen === this.generation && this.inFlight.get(hash) === entry;
    const settle = (error: string, outcome: FetchOutcome) => {
      over = true;
      clearTimeout(timer);
      this.aborts.delete(abort);
      if (!current()) return;
      r.end_us = us();
      r.error = error;
      r.outcome = outcome;
      this.inFlight.delete(hash);
      if (
        outcome === "temporary" &&
        attempt < TEMPORARY_RETRY_DELAYS_MS.length &&
        this.retry?.mode(hash, background) != null
      ) {
        this.retries.set(hash, {
          result: r,
          background,
          due: this.retry.now() + TEMPORARY_RETRY_DELAYS_MS[attempt],
          attempt: attempt + 1,
        });
        return;
      }
      if (
        error !== "" &&
        (entry.background || (this.settleFailures && outcome !== "fatal"))
      ) {
        // Settled on its own: the queue goes on, the other GETs keep going.
      } else if (error !== "") {
        this.failed = true;
        this.queue = [];
        this.retries.clear();
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
    /** The request function threw: the request cannot be made at all (a configuration error). */
    let unmade = false;
    try {
      started = this.request(path, abort.signal, {
        stream: this.stager !== null,
        progress,
      });
    } catch (e) {
      unmade = true;
      started = Promise.reject(e);
    }
    started
      .then(async (res) => {
        progress();
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
            statusOutcome(res.status),
          );
          return;
        }
        if (stream !== null && this.stager) {
          if (
            !(await this.streamInto(
              r,
              stream,
              res.sizeHint ?? 0,
              current,
              progress,
              abort.signal,
            ))
          )
            return; // cancelled meanwhile: dropped unseen
          settle("", "ok");
          return;
        }
        const body =
          stream !== null
            ? await readStream(stream, progress, abort.signal)
            : new Uint8Array(res.body ?? new ArrayBuffer(0));
        r.bytes = body.length;
        r.data = body;
        settle("", "ok");
      })
      .catch((e: unknown) => {
        const why = stalled
          ? `stalled, no progress for ${this.timeoutMs} ms`
          : abort.signal.aborted
            ? "aborted"
            : `the request failed (${e instanceof Error ? e.message : String(e)})`;
        settle(
          `resource-unavailable: GET ${path}: ${why}`,
          unmade ? "fatal" : "temporary",
        );
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
    progress: () => void,
    signal: AbortSignal,
  ): Promise<boolean> {
    const stager = this.stager as NonNullable<LiveFetcherOptions["stager"]>;
    const sink = stager(r.hash, sizeHint);
    const reader = stream.getReader();
    const stop = abortRead(reader, signal);
    let finished = false;
    try {
      let sinceYield = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (!current()) {
          reader.cancel().catch(() => {});
          return false;
        }
        if (signal.aborted) throw new Error("aborted");
        if (done) break;
        progress();
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
      stop();
      if (!finished) sink.abort();
      reader.releaseLock();
    }
  }
}

/** A whole body read from `stream`, `progress` called at every chunk. */
async function readStream(
  stream: ReadableStream<Uint8Array>,
  progress: () => void,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const stop = abortRead(reader, signal);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (done) break;
      progress();
      chunks.push(value);
      total += value.length;
    }
  } finally {
    stop();
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** An abort of `signal` ends `reader`'s pending read (a transport whose body ignores the signal
 * would otherwise keep it waiting); returns the listener's removal. */
function abortRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): () => void {
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
