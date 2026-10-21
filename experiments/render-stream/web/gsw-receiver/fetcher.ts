// The GSW receiver's live HTTP fetcher (gate7-design.md Q5 "Fetch", G7l): the native receiver's
// RsResourceFetcher with the browser's `fetch`. `GET <origin><http_path><hash>` on the WebSocket's
// own loopback host and port, ONE at a time, polled from the rAF loop: `poll()` starts the next
// request when none is in flight (after the injected RS_RECEIVER_FETCH_DELAY_MS, a timed wait,
// never a blocked loop) and hands back each completed one. G7o2: `onBody` runs in the fetch's own
// completion (between frames), where the caller copies a 200 body into wasm and `stage_payload`
// verifies its SHA-256 and decodes it before anything uses it (Q14c); this file never inspects a
// payload. The transaction that needs them stays unapplied meanwhile, and the canvas keeps the
// previous frame.
//
// A non-200 status, a request that cannot be made, and one not complete within
// RS_RECEIVER_FETCH_TIMEOUT_MS of its start are `resource-unavailable`; the first error stops the
// queue (rs_resource_fetcher.gd). With a token the request carries `Authorization: Bearer
// <token>`, which makes it a CORS non-simple request: the browser sends the host an OPTIONS
// preflight first (cached for its Max-Age), which the host answers without a token. Sabotage
// `wrong-http-token` (G2e) sends the token with `-wrong` appended on every GET while the hello
// carried the right one.
//
// Recorded headers are the native fetcher's four (Content-Type, Content-Length, Cache-Control,
// ETag) as far as the browser exposes them: a cross-origin response shows only CORS-safelisted
// headers and those in Access-Control-Expose-Headers, so `ETag` is absent unless the host exposes
// it. Names are written in the native fetcher's case (the Fetch API lowercases them).

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
}

const KEPT_HEADERS = [
  "Content-Type",
  "Content-Length",
  "Cache-Control",
  "ETag",
] as const;

const us = (): number => Math.round(performance.now() * 1000);

export class LiveFetcher {
  private queue: string[] = [];
  private inFlight = false;
  /** G7q: the hash of the GET in flight (null when none). */
  private inFlightHash: string | null = null;
  private delayUntil = -1;
  private done: FetchResult[] = [];
  private failed = false;
  private generation = 0;

  constructor(
    private readonly origin: string,
    private readonly pathPrefix: string,
    private readonly timeoutMs: number,
    private readonly delayMs: number,
    private readonly token: string | null,
    /** Sabotage `ignore-cache`: every GET bypasses the HTTP cache (the native "fetch even on a
     * cache hit"). */
    private readonly bypassCache = false,
    /** G7o2: called with each 200 result in its completion, before `poll` hands it back. */
    private readonly onBody: ((r: FetchResult) => void) | null = null,
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
    this.done = [];
    this.delayUntil = -1;
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
      finished: this.failed || (!this.inFlight && this.queue.length === 0),
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
    const headers: Record<string, string> = {};
    if (this.token !== null) headers.Authorization = `Bearer ${this.token}`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    const settle = (error: string) => {
      clearTimeout(timer);
      if (gen !== this.generation) return;
      r.end_us = us();
      r.error = error;
      this.inFlight = false;
      this.inFlightHash = null;
      if (error !== "") {
        this.failed = true;
        this.queue = [];
      } else if (this.onBody) this.onBody(r);
      this.done.push(r);
    };
    fetch(`${this.origin}${path}`, {
      headers,
      signal: abort.signal,
      cache: this.bypassCache ? "no-store" : "default",
      credentials: "omit",
    })
      .then(async (res) => {
        r.status = res.status;
        for (const name of KEPT_HEADERS) {
          const v = res.headers.get(name);
          if (v !== null) r.headers[name] = v;
        }
        const body = new Uint8Array(await res.arrayBuffer());
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
