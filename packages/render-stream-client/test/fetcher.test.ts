// LiveFetcher: parallel GETs, and bodies staged as they arrive.

import { describe, expect, it, vi } from "vitest";
import type { StagingStream } from "../src/core";
import {
  type FetchResult,
  LiveFetcher,
  type LiveFetcherOptions,
  type ResourceResponse,
  statusOutcome,
} from "../src/fetcher";
import { flush } from "./fakes";

interface Get {
  path: string;
  signal: AbortSignal;
  stream: boolean;
  resolve: (r: ResourceResponse) => void;
  reject: (e: Error) => void;
}

function requests() {
  const gets: Get[] = [];
  const request = (
    path: string,
    signal: AbortSignal,
    opts?: { stream: boolean },
  ) =>
    new Promise<ResourceResponse>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      gets.push({
        path,
        signal,
        stream: opts?.stream === true,
        resolve,
        reject,
      });
    });
  const by = (hash: string): Get => {
    const g = gets.find((x) => x.path === `/r/${hash}`);
    if (!g) throw new Error(`no GET of ${hash}`);
    return g;
  };
  return { gets, request, by };
}

const ok = (n = 4): ResourceResponse => ({
  status: 200,
  body: new ArrayBuffer(n),
});

/** A body arriving as `chunks`, each released by `next()` (or all at once by `rest()`). */
function body(chunks: Uint8Array[]) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  const left = [...chunks];
  return {
    stream,
    cancelled: () => cancelled,
    next() {
      const c = left.shift();
      if (c) ctl.enqueue(c);
      else ctl.close();
    },
    rest() {
      for (const c of left.splice(0)) ctl.enqueue(c);
      ctl.close();
    },
    fail(e: Error) {
      ctl.error(e);
    },
  };
}

/** A stager recording what each stream saw. */
function stager(verdict: (hash: string, bytes: Uint8Array) => string | null) {
  const log: string[] = [];
  const open = new Set<string>();
  const sizes = new Map<string, number[]>();
  const make = (hash: string, sizeHint: number): StagingStream => {
    log.push(`begin ${hash} ${sizeHint}`);
    open.add(hash);
    const parts: Uint8Array[] = [];
    sizes.set(hash, []);
    return {
      write(chunk) {
        parts.push(chunk.slice());
        sizes.get(hash)?.push(chunk.length);
      },
      finish() {
        open.delete(hash);
        const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
          all.set(p, at);
          at += p.length;
        }
        log.push(`finish ${hash} ${all.length}`);
        return verdict(hash, all);
      },
      abort() {
        open.delete(hash);
        log.push(`abort ${hash}`);
      },
    };
  };
  return { make, log, open, sizes };
}

function fetcher(
  o: LiveFetcherOptions & { onBody?: (r: FetchResult) => void } = {},
) {
  const rq = requests();
  const f = new LiveFetcher(rq.request, "/r/", 10000, 0, o.onBody ?? null, o);
  return { f, ...rq };
}

describe("LiveFetcher parallel GETs", () => {
  it("defaults to one GET at a time, in queue order", async () => {
    const { f, gets } = fetcher();
    f.start(["a", "b", "c"]);
    f.poll();
    expect(gets.map((g) => g.path)).toEqual(["/r/a"]);
    expect(f.poll().finished).toBe(false);
    expect(gets).toHaveLength(1);
    gets[0].resolve(ok());
    await flush();
    const p = f.poll();
    expect(p.results.map((r) => r.hash)).toEqual(["a"]);
    expect(gets.map((g) => g.path)).toEqual(["/r/a", "/r/b"]);
  });

  it("keeps up to maxInFlight GETs going and hands back completions in any order", async () => {
    const { f, gets, by } = fetcher({ maxInFlight: 4 });
    f.start(["a", "b", "c", "d", "e", "f"]);
    f.poll();
    expect(gets.map((g) => g.path)).toEqual(["/r/a", "/r/b", "/r/c", "/r/d"]);
    expect(f.inFlightCount()).toBe(4);
    expect([...f.requested()].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(f.busy()).toBe(true);
    by("c").resolve(ok());
    by("a").resolve(ok());
    await flush();
    let p = f.poll();
    expect(p.results.map((r) => r.hash)).toEqual(["c", "a"]);
    expect(p.finished).toBe(false);
    expect(gets.map((g) => g.path).slice(4)).toEqual(["/r/e", "/r/f"]);
    expect(f.inFlightCount()).toBe(4);
    for (const h of ["f", "d", "b", "e"]) by(h).resolve(ok());
    await flush();
    p = f.poll();
    expect(p.results.map((r) => r.hash)).toEqual(["f", "d", "b", "e"]);
    expect(p.finished).toBe(true);
    expect(f.busy()).toBe(false);
    expect(f.requested().size).toBe(0);
  });

  it("the first failure ends the queue and aborts the other GETs in flight, unseen", async () => {
    const { f, gets, by } = fetcher({ maxInFlight: 3 });
    f.start(["a", "b", "c", "d"]);
    f.poll();
    by("a").resolve(ok());
    await flush();
    by("b").resolve({ status: 404, body: null });
    await flush();
    expect(by("c").signal.aborted).toBe(true);
    expect(by("a").signal.aborted).toBe(false);
    const p = f.poll();
    expect(p.results.map((r) => [r.hash, r.error])).toEqual([
      ["a", ""],
      ["b", "resource-unavailable: GET /r/b answered HTTP 404"],
    ]);
    expect(p.finished).toBe(true);
    expect(f.busy()).toBe(false);
    await flush();
    expect(f.poll().results).toEqual([]);
    expect(gets.map((g) => g.path)).toEqual(["/r/a", "/r/b", "/r/c"]);
  });

  it("settle: a missing or temporary GET settles alone; the queue and the others go on", async () => {
    const { f, gets, by } = fetcher({ maxInFlight: 3, failures: "settle" });
    f.start(["a", "b", "c", "d", "e"]);
    f.poll();
    by("b").resolve({ status: 404, body: null });
    by("a").reject(new TypeError("Failed to fetch"));
    await flush();
    expect(by("c").signal.aborted).toBe(false);
    let p = f.poll();
    expect(p.results.map((r) => [r.hash, r.outcome, r.status])).toEqual([
      ["b", "missing", 404],
      ["a", "temporary", null],
    ]);
    expect(p.finished).toBe(false);
    expect(gets.map((g) => g.path)).toEqual([
      "/r/a",
      "/r/b",
      "/r/c",
      "/r/d",
      "/r/e",
    ]);
    by("c").resolve(ok());
    by("d").resolve({ status: 503, body: null });
    by("e").resolve({ status: 403, body: null }); // fatal: stops the queue as before
    await flush();
    p = f.poll();
    expect(p.results.map((r) => [r.hash, r.outcome])).toEqual([
      ["c", "ok"],
      ["d", "temporary"],
      ["e", "fatal"],
    ]);
    expect(p.finished).toBe(true);
  });

  it("settle: a fatal GET still aborts the others in flight", async () => {
    const { f, by } = fetcher({ maxInFlight: 3, failures: "settle" });
    f.start(["a", "b", "c"]);
    f.poll();
    by("b").resolve({ status: 401, body: null });
    await flush();
    expect([by("a").signal.aborted, by("c").signal.aborted]).toEqual([
      true,
      true,
    ]);
    expect(f.poll().results.map((r) => [r.hash, r.outcome])).toEqual([
      ["b", "fatal"],
    ]);
  });

  it("a request function that throws cannot be made: fatal", async () => {
    const f = new LiveFetcher(
      () => {
        throw new Error("no fetch here");
      },
      "/r/",
      10000,
      0,
      null,
      { failures: "settle" },
    );
    f.start(["a"]);
    f.poll();
    await flush();
    expect(f.poll().results.map((r) => r.outcome)).toEqual(["fatal"]);
  });

  it("statusOutcome: 404/410 missing, 408/429/5xx temporary, the rest fatal", () => {
    const got = [
      200, 404, 410, 408, 429, 500, 599, 401, 403, 400, 302, 600,
    ].map((s) => [s, statusOutcome(s)]);
    expect(got).toEqual([
      [200, "ok"],
      [404, "missing"],
      [410, "missing"],
      [408, "temporary"],
      [429, "temporary"],
      [500, "temporary"],
      [599, "temporary"],
      [401, "fatal"],
      [403, "fatal"],
      [400, "fatal"],
      [302, "fatal"],
      [600, "fatal"],
    ]);
  });

  it("extend never queues a hash twice; unqueue drops a queued one, never one in flight", async () => {
    const { f, gets } = fetcher({ maxInFlight: 1 });
    f.start(["a", "b"]);
    f.poll();
    f.extend(["a", "b", "c", "c"]);
    expect([...f.queued()]).toEqual(["b", "c"]);
    f.unqueue("a"); // in flight: kept
    f.unqueue("b");
    expect([...f.queued()]).toEqual(["c"]);
    expect(f.active("a") && f.has("a") && !f.has("b")).toBe(true);
    expect(gets).toHaveLength(1);
  });

  it("a fold extends the queue without duplicating a GET in flight; retain keeps those in flight", async () => {
    const { f, gets, by } = fetcher({ maxInFlight: 3 });
    f.start(["a", "b", "x"]);
    f.retain(new Set(["a", "b"])); // x is dropped before it went out
    f.poll();
    expect(gets.map((g) => g.path)).toEqual(["/r/a", "/r/b"]);
    f.retain(new Set(["c"])); // a and b are in flight: kept
    f.extend(["a", "c"]);
    f.poll(); // the duplicate a is skipped, c goes out
    expect(gets.map((g) => g.path)).toEqual(["/r/a", "/r/b", "/r/c"]);
    for (const h of ["a", "b", "c"]) by(h).resolve(ok());
    await flush();
    const p = f.poll();
    expect(p.results.map((r) => r.hash)).toEqual(["a", "b", "c"]);
    expect(p.finished).toBe(true);
  });

  it("abort aborts every GET in flight; cancel lets whole-body GETs complete unseen", async () => {
    const { f, by } = fetcher({ maxInFlight: 2 });
    f.start(["a", "b"]);
    f.poll();
    f.cancel();
    expect(by("a").signal.aborted).toBe(false);
    by("a").resolve(ok());
    await flush();
    expect(f.poll().results).toEqual([]);
    f.start(["c", "d"]);
    f.poll();
    f.abort();
    expect(by("c").signal.aborted && by("d").signal.aborted).toBe(true);
  });
});

describe("LiveFetcher staging as bodies arrive", () => {
  const bytes = (n: number, seed = 1) =>
    Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

  it("writes each chunk as it arrives and stages on the last; onBody is not called", async () => {
    const onBody = vi.fn();
    const st = stager(() => null);
    const { f, gets } = fetcher({ stager: st.make, onBody });
    f.start(["a"]);
    f.poll();
    expect(gets[0].stream).toBe(true);
    const b = body([bytes(5), bytes(7), bytes(3)]);
    gets[0].resolve({
      status: 200,
      body: null,
      stream: b.stream,
      sizeHint: 15,
    });
    await flush();
    expect(st.log).toEqual(["begin a 15"]);
    b.next();
    await flush();
    expect(st.sizes.get("a")).toEqual([5]);
    expect(f.poll().results).toEqual([]);
    b.next();
    b.next();
    b.next();
    await flush();
    const [r] = f.poll().results;
    expect(st.log).toEqual(["begin a 15", "finish a 15"]);
    expect(r).toMatchObject({
      hash: "a",
      status: 200,
      bytes: 15,
      data: null,
      streamed: true,
      stage_error: null,
      error: "",
    });
    expect(onBody).not.toHaveBeenCalled();
  });

  it("yields a task after every sliceBytes, splitting a large chunk and chained small ones", async () => {
    const yields: number[] = [];
    const st = stager(() => null);
    let written = 0;
    const { f, gets } = fetcher({
      stager: (h, n) => {
        const s = st.make(h, n);
        return {
          ...s,
          write(c) {
            written += c.length;
            s.write(c);
          },
        };
      },
      sliceBytes: 10,
      yieldTask: async () => {
        yields.push(written);
      },
    });
    f.start(["a"]);
    f.poll();
    const b = body([bytes(25), bytes(3), bytes(4), bytes(4)]);
    gets[0].resolve({ status: 200, body: null, stream: b.stream });
    b.rest();
    await flush();
    await flush();
    expect(st.sizes.get("a")).toEqual([10, 10, 5, 3, 2, 2, 4]);
    expect(yields).toEqual([10, 20, 30]);
    const [r] = f.poll().results;
    expect(r.bytes).toBe(36);
    expect(st.log.at(-1)).toBe("finish a 36");
  });

  it("a refused body keeps the stager's refusal as its stage_error", async () => {
    const st = stager((h) => `resource-hash: ${h} mismatch`);
    const { f, gets } = fetcher({ stager: st.make });
    f.start(["a"]);
    f.poll();
    const b = body([bytes(4)]);
    gets[0].resolve({ status: 200, body: null, stream: b.stream });
    b.rest();
    await flush();
    const [r] = f.poll().results;
    expect(r.error).toBe("");
    expect(r.stage_error).toBe("resource-hash: a mismatch");
  });

  it("parallel streams stage per hash, in completion order", async () => {
    const st = stager(() => null);
    const { f, by } = fetcher({ stager: st.make, maxInFlight: 2 });
    f.start(["a", "b"]);
    f.poll();
    const ba = body([bytes(3, 1), bytes(3, 2)]);
    const bb = body([bytes(2, 3)]);
    by("a").resolve({ status: 200, body: null, stream: ba.stream });
    by("b").resolve({ status: 200, body: null, stream: bb.stream });
    await flush();
    ba.next();
    bb.rest();
    await flush();
    ba.rest();
    await flush();
    expect(f.poll().results.map((r) => [r.hash, r.bytes])).toEqual([
      ["b", 2],
      ["a", 6],
    ]);
    expect(st.open.size).toBe(0);
  });

  it("retries a failed stream with a fresh staging buffer", async () => {
    let now = 0;
    let retried = 0;
    const st = stager(() => null);
    const { f, gets } = fetcher({
      stager: st.make,
      failures: "settle",
      retry: {
        now: () => now,
        mode: () => "demand",
        onRetry: () => retried++,
      },
    });
    f.start(["a"]);
    f.poll();
    const first = body([new Uint8Array([9])]);
    gets[0].resolve({ status: 200, body: null, stream: first.stream });
    first.next();
    await flush();
    first.fail(new Error("link lost"));
    await flush();
    expect(st.log).toContain("abort a");
    expect(st.open.size).toBe(0);
    expect(f.poll()).toEqual({ results: [], finished: false });
    now = 250;
    f.poll();
    expect(gets).toHaveLength(2);
    expect(retried).toBe(1);
    const second = body([new Uint8Array([1, 2])]);
    gets[1].resolve({ status: 200, body: null, stream: second.stream });
    second.rest();
    await flush();
    expect(f.poll()).toMatchObject({
      results: [{ hash: "a", outcome: "ok", streamed: true, bytes: 2 }],
      finished: true,
    });
    expect(st.log).toEqual(["begin a 0", "abort a", "begin a 0", "finish a 2"]);
  });

  it("a read error is resource-unavailable and frees the staging buffer", async () => {
    const st = stager(() => null);
    const { f, gets } = fetcher({ stager: st.make });
    f.start(["a"]);
    f.poll();
    const b = body([bytes(4)]);
    gets[0].resolve({ status: 200, body: null, stream: b.stream });
    b.next();
    await flush();
    b.fail(new Error("reset"));
    await flush();
    const [r] = f.poll().results;
    expect(r.error).toBe(
      "resource-unavailable: GET /r/a: the request failed (reset)",
    );
    expect(st.log.at(-1)).toBe("abort a");
    expect(st.open.size).toBe(0);
  });

  it("a cancel mid-body stops the read and frees the buffer; another's failure aborts it", async () => {
    const st = stager(() => null);
    const { f, by } = fetcher({ stager: st.make, maxInFlight: 2 });
    f.start(["a"]);
    f.poll();
    const b = body([bytes(4), bytes(4)]);
    by("a").resolve({ status: 200, body: null, stream: b.stream });
    b.next();
    await flush();
    f.cancel();
    b.next();
    await flush();
    expect(b.cancelled()).toBe(true);
    expect(st.log).toEqual(["begin a 0", "abort a"]);
    expect(f.poll().results).toEqual([]);

    f.start(["c", "d"]);
    f.poll();
    const bc = body([bytes(4), bytes(4)]);
    by("c").resolve({ status: 200, body: null, stream: bc.stream });
    bc.next();
    await flush();
    by("d").resolve({ status: 500, body: null });
    await flush();
    expect(by("c").signal.aborted).toBe(true);
    bc.fail(new Error("aborted"));
    await flush();
    expect(st.log.at(-1)).toBe("abort c");
    expect(st.open.size).toBe(0);
    expect(f.poll().results.map((r) => r.hash)).toEqual(["d"]);
  });

  it("a non-200 stream is cancelled; a body without a stream goes through onBody", async () => {
    const st = stager(() => null);
    const seen: FetchResult[] = [];
    const { f, by } = fetcher({
      stager: st.make,
      maxInFlight: 2,
      onBody: (r) => {
        seen.push(r);
      },
    });
    f.start(["a", "b"]);
    f.poll();
    by("a").resolve(ok(9)); // a transport that ignores the ask
    await flush();
    expect(seen.map((r) => [r.hash, r.data?.length])).toEqual([["a", 9]]);
    const b = body([bytes(4)]);
    by("b").resolve({ status: 404, body: null, stream: b.stream });
    await flush();
    expect(b.cancelled()).toBe(true);
    expect(st.log).toEqual([]);
    expect(f.poll().results.map((r) => r.error)).toEqual([
      "",
      "resource-unavailable: GET /r/b answered HTTP 404",
    ]);
  });
});

describe("LiveFetcher stall timeout", () => {
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const timed = (timeoutMs: number, o: LiveFetcherOptions = {}) => {
    const rq = requests();
    const f = new LiveFetcher(rq.request, "/r/", timeoutMs, 0, null, o);
    return { f, ...rq };
  };
  const st = () => stager(() => null).make;

  it("a body that keeps arriving outlives the timeout; it counts from the last bytes", async () => {
    const { f, gets } = timed(60, { stager: st() });
    f.start(["a"]);
    f.poll();
    const b = body([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)]);
    await wait(40);
    gets[0].resolve({ status: 200, body: null, stream: b.stream });
    for (let i = 0; i < 3; i++) {
      await wait(40);
      b.next();
    }
    await wait(40);
    b.next(); // the end, 200 ms after the start
    await wait(5);
    const [r] = f.poll().results;
    expect(r).toMatchObject({ hash: "a", error: "", bytes: 12 });
  });

  it("no bytes for the timeout is resource-unavailable (stalled)", async () => {
    const { f, gets } = timed(40, { stager: st() });
    f.start(["a"]);
    f.poll();
    const b = body([new Uint8Array(4)]);
    gets[0].resolve({ status: 200, body: null, stream: b.stream });
    await wait(5);
    b.next();
    await wait(80);
    const [r] = f.poll().results;
    expect(r.error).toMatch(
      /^resource-unavailable: GET \/r\/a: stalled, no progress for 40 ms$/,
    );
    expect(gets[0].signal.aborted).toBe(true);
    expect(b.cancelled()).toBe(true); // the read ended with the abort
  });

  it("no response for the timeout is resource-unavailable (stalled)", async () => {
    const { f } = timed(30);
    f.start(["a"]);
    f.poll();
    await wait(60);
    const [r] = f.poll().results;
    expect(r.error).toMatch(/stalled, no progress for 30 ms$/);
  });

  it("a whole-body request's progress calls restart the timeout", async () => {
    let progress: (() => void) | undefined;
    let resolve!: (r: ResourceResponse) => void;
    const f = new LiveFetcher(
      (_p, _s, opts) => {
        progress = opts?.progress;
        return new Promise<ResourceResponse>((res) => {
          resolve = res;
        });
      },
      "/r/",
      50,
      0,
    );
    f.start(["a"]);
    f.poll();
    for (let i = 0; i < 4; i++) {
      await wait(30);
      progress?.();
    }
    resolve({ status: 200, body: new ArrayBuffer(8) });
    await wait(5);
    const [r] = f.poll().results;
    expect(r).toMatchObject({ error: "", bytes: 8 });
  });
});
