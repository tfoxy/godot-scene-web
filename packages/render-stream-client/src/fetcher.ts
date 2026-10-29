// The live HTTP fetcher (gate7-design.md Q5 "Fetch", G7l): the native receiver's
// RsResourceFetcher over an injected request function. `GET <prefix><hash>`, ONE at a time, polled
// from the rAF loop: `poll()` starts the next request when none is in flight (after an optional
// delay, a timed wait, never a blocked loop) and hands back each completed one. G7o2: `onBody` runs
// in the request's own completion (between frames), where the caller copies a 200 body into wasm
// and `stage_payload` verifies its SHA-256 and decodes it before anything uses it (Q14c); this file
// never inspects a payload. The transaction that needs them stays unapplied meanwhile, and the
// canvas keeps the previous frame.
//
// A non-200 status, a request that cannot be made, and one not complete within `timeoutMs` of its
// start are `resource-unavailable`; the first error stops the queue (rs_resource_fetcher.gd).
//
// MIR-1 moved this file from the harness receiver (web/gsw-receiver/) into the package and made the
// request injectable: the client passes its transport's `fetchResource`, and the harness passes
// its own `fetch` with the token, the cache mode its sabotages need and the response headers its
// evidence records.

/** One GET's answer: its status, its body, and (the harness's evidence) its kept headers. */
export interface ResourceResponse {
  status: number;
  body: ArrayBuffer | null;
  headers?: Record<string, string>;
}

/** `GET <path>`, aborted through `signal` (the fetcher's timeout, or `abort`). */
export type ResourceRequest = (
  path: string,
  signal: AbortSignal,
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
  /** G7o2: set by `onBody` (the verify and decode on arrival, and its refusal if any). */
  verify_us?: number;
  stage_error?: string | null;
  /** G8kb: the body was a KTX2 whose transcode failed (`delivery-transcode-failed`): the variant
   * is refused and wasm's needed set recomputed; the caller fetches the fallback. */
  transcode_fallback?: boolean;
}

const us = (): number => Math.round(performance.now() * 1000);

export class LiveFetcher {
  private queue: string[] = [];
  private inFlight = false;
  /** G7q: the hash of the GET in flight (null when none). */
  private inFlightHash: string | null = null;
  private delayUntil = -1;
  private done: FetchResult[] = [];
  /** G8kb: completed bodies whose `onBody` promise (a transcode) has not settled yet. */
  private staging = new Set<string>();
  private failed = false;
  private generation = 0;
  /** The in-flight request's abort controller (`abort` aborts it). */
  private readonly aborts = new Set<AbortController>();

  constructor(
    private readonly request: ResourceRequest,
    private readonly pathPrefix: string,
    private readonly timeoutMs: number,
    private readonly delayMs: number,
    /** G7o2: called with each 200 result in its completion, before `poll` hands it back. G8kb:
     * it may return a promise (a KTX2's transcode in the worker); the result is handed back when
     * it settles, while the next GET goes out meanwhile. */
    private readonly onBody:
      | ((r: FetchResult) => void | Promise<void>)
      | null = null,
  ) {}

  /** Queues one transaction's misses, in the order wasm needs them. */
  start(hashes: string[]): void {
    this.queue = [...hashes];
    this.done = [];
    this.failed = false;
    this.delayUntil = -1;
  }

  /** G7q (credit window 2, a fold in place): queues more misses after those already queued,
   * keeping the GET in flight and every completed result not yet polled. */
  extend(hashes: string[]): void {
    this.queue.push(...hashes);
  }

  /** G7q: every hash queued, in flight, or completed and not yet polled (a fold queues only the
   * others). */
  requested(): Set<string> {
    const out = new Set(this.queue);
    if (this.inFlight && this.inFlightHash !== null) out.add(this.inFlightHash);
    for (const h of this.staging) out.add(h);
    for (const r of this.done) out.add(r.hash);
    return out;
  }

  /** G7q: drops the queued (not yet issued) hashes not in `keep`; one in flight is kept. */
  retain(keep: ReadonlySet<string>): void {
    this.queue = this.queue.filter((h) => keep.has(h));
  }

  /** G7q: a request queued, in flight, or completed and not yet polled. */
  busy(): boolean {
    return (
      this.inFlight ||
      this.staging.size > 0 ||
      this.done.length > 0 ||
      (!this.failed && this.queue.length > 0)
    );
  }

  /** Drops everything queued or in flight (a reconnect). */
  cancel(): void {
    this.generation++;
    this.queue = [];
    this.inFlight = false;
    this.inFlightHash = null;
    this.staging.clear();
    this.done = [];
    this.delayUntil = -1;
  }

  /** MIR-1 (the client's dispose): `cancel`, and the GET in flight is aborted too (a reconnect's
   * `cancel` lets it complete unseen, as the harness's evidence expects). */
  abort(): void {
    this.cancel();
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
  }

  /** One rAF step: completed results (in order), and whether the queue is finished. */
  poll(): { results: FetchResult[]; finished: boolean } {
    if (!this.inFlight && !this.failed && this.queue.length > 0) {
      if (this.delayMs > 0 && this.delayUntil < 0)
        this.delayUntil = performance.now() + this.delayMs;
      if (this.delayUntil < 0 || performance.now() >= this.delayUntil)
        this.issue(this.queue.shift() as string);
    }
    const results = this.done;
    this.done = [];
    return {
      results,
      finished:
        this.failed ||
        (!this.inFlight && this.staging.size === 0 && this.queue.length === 0),
    };
  }

  private issue(hash: string): void {
    const gen = this.generation;
    this.delayUntil = -1;
    this.inFlight = true;
    this.inFlightHash = hash;
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
    this.aborts.add(abort);
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    const settle = (error: string) => {
      clearTimeout(timer);
      this.aborts.delete(abort);
      if (gen !== this.generation) return;
      r.end_us = us();
      r.error = error;
      this.inFlight = false;
      this.inFlightHash = null;
      if (error !== "") {
        this.failed = true;
        this.queue = [];
      } else if (this.onBody) {
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
      started = this.request(path, abort.signal);
    } catch (e) {
      started = Promise.reject(e);
    }
    started
      .then((res) => {
        r.status = res.status;
        if (res.headers) r.headers = res.headers;
        const body = new Uint8Array(res.body ?? new ArrayBuffer(0));
        r.bytes = body.length;
        if (res.status !== 200) {
          settle(
            `resource-unavailable: GET ${path} answered HTTP ${res.status}`,
          );
          return;
        }
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
}
