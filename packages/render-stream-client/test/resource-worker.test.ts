// @vitest-environment node
import { createHash, webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveFetcher } from "../src/fetcher";
import { FETCH_PARALLEL } from "../src/resource-limits";
import { RESOURCE_WORKER_SOURCE } from "../src/resource-worker";
import { createWebSocketTransport } from "../src/transport";

class FakeWorker {
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  messages: { type: string; id: number; url?: string; headers?: unknown }[] =
    [];
  terminate = vi.fn();
  postMessage = vi.fn((m) => this.messages.push(m));
  reply(data: unknown) {
    this.onmessage?.call(this as unknown as Worker, { data } as MessageEvent);
  }
}

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror = null;
  close(code: number, reason: string) {
    this.onclose?.({ code, reason });
  }
}

const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function setup(
  options: Parameters<typeof createWebSocketTransport>[0] = {},
  resourceBase = "http://localhost/r",
) {
  const worker = new FakeWorker();
  const workers: FakeWorker[] = [];
  let initializeWorker: ((worker: FakeWorker) => void) | undefined;
  const createWorker = vi.fn(() => {
    const next = workers.length === 0 ? worker : new FakeWorker();
    workers.push(next);
    initializeWorker?.(next);
    return next as unknown as Worker;
  });
  const fetch = vi.fn(async () => new Response(Uint8Array.of(7, 8)));
  let socket!: FakeSocket;
  vi.stubGlobal(
    "WebSocket",
    class extends FakeSocket {
      constructor() {
        super();
        socket = this;
      }
    },
  );
  vi.stubGlobal("location", { href: "http://localhost/" });
  vi.stubGlobal("fetch", fetch);
  const t = createWebSocketTransport({ createWorker, ...options })(
    { url: "ws://localhost/s", resourceBase },
    "render-stream.13",
    { open() {}, message() {}, close() {} },
  );
  const request = (signal = new AbortController().signal) =>
    t.fetchResource("/a", { token: "secret", signal });
  return {
    t,
    worker,
    workers,
    fetch,
    createWorker,
    request,
    socket,
    allMessages: () =>
      workers.flatMap((w) => w.messages).sort((a, b) => a.id - b.id),
    runWorkers: (
      fetch: (url: string, init: RequestInit) => Promise<Response>,
    ) => {
      initializeWorker = (w) => runWorkerScript(w, fetch);
    },
  };
}

/** Run the production worker source behind the transport's Worker seam. */
function runWorkerScript(
  worker: FakeWorker,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
) {
  const self = {
    onmessage: null as ((event: { data: unknown }) => Promise<void>) | null,
    postMessage(message: unknown, transfer?: ArrayBuffer[]) {
      worker.reply(structuredClone(message, { transfer }));
    },
  };
  runInNewContext(RESOURCE_WORKER_SOURCE, {
    self,
    fetch,
    performance,
    AbortController,
    Uint8Array,
  });
  worker.postMessage.mockImplementation((message) => {
    worker.messages.push(message);
    void self.onmessage?.({ data: message });
  });
}

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("worker resource GETs", () => {
  it("counts main-thread progress and body message work without counting the wait", async () => {
    const s = setup();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now++);
    const response = s.request();
    const id = s.worker.messages[0].id;
    s.worker.reply({ type: "progress", id, bytes: 0 });
    now += 1000;
    s.worker.reply({ type: "progress", id, bytes: 4 });
    now += 1000;
    s.worker.reply({
      type: "body",
      id,
      status: 200,
      body: new ArrayBuffer(4),
      hashMs: 17,
    });
    expect(await response).toMatchObject({
      workerMessageMs: 3,
      workerHashMs: 17,
    });
    s.t.close(1000, "done");
  });
  it("creates workers only on demand, bounds the pool, and reuses idle workers", async () => {
    const s = setup();
    s.socket.onopen?.();
    expect(s.createWorker).not.toHaveBeenCalled();
    const pending = Array.from({ length: FETCH_PARALLEL + 1 }, () =>
      s.request(),
    );
    expect(s.workers).toHaveLength(FETCH_PARALLEL);
    for (const w of s.workers) expect(w.messages).toHaveLength(1);
    const idle = s.workers[1];
    idle.reply({ type: "body", id: 2, status: 200, body: new ArrayBuffer(0) });
    await pending[1];
    expect(idle.messages.map((m) => m.id)).toEqual([2, FETCH_PARALLEL + 1]);
    expect(s.createWorker).toHaveBeenCalledTimes(FETCH_PARALLEL);
    const settled = Promise.allSettled(pending);
    s.t.close(1000, "done");
    expect((await settled).filter((r) => r.status === "rejected")).toHaveLength(
      FETCH_PARALLEL,
    );
    for (const w of s.workers) expect(w.terminate).toHaveBeenCalledOnce();
  });

  it("routes aborts to the owning worker and cancels queued requests locally", async () => {
    const s = setup();
    const aborts = Array.from(
      { length: FETCH_PARALLEL + 1 },
      () => new AbortController(),
    );
    const pending = aborts.map((a) => s.request(a.signal));
    const settled = Promise.allSettled(pending);
    aborts[FETCH_PARALLEL].abort();
    expect(s.allMessages().filter((m) => m.type === "abort")).toEqual([]);
    aborts[1].abort();
    expect(s.workers[1].messages.at(-1)).toEqual({ type: "abort", id: 2 });
    for (const [i, w] of s.workers.entries())
      if (i !== 1) expect(w.messages).toHaveLength(1);
    s.t.close(1000, "done");
    expect((await settled).every((r) => r.status === "rejected")).toBe(true);
  });

  it.each([
    "error",
    "messageerror",
    "malformed",
  ] as const)("isolates a ready worker's %s and keeps healthy and queued fetches in workers", async (failure) => {
    const s = setup();
    const pending = Array.from({ length: FETCH_PARALLEL + 1 }, () =>
      s.request(),
    );
    const original = [...s.workers];
    for (const w of original) w.reply({ type: "ready" });
    const failed = original[1];
    if (failure === "malformed") failed.reply({ type: "unknown" });
    else if (failure === "error")
      failed.onerror?.call(failed as unknown as Worker, {} as ErrorEvent);
    else
      failed.onmessageerror?.call(
        failed as unknown as Worker,
        {} as MessageEvent,
      );

    expect(failed.terminate).toHaveBeenCalledOnce();
    expect(failed.onmessage).toBeNull();
    expect(failed.onerror).toBeNull();
    expect(failed.onmessageerror).toBeNull();
    for (const [i, w] of original.entries()) {
      if (i === 1) continue;
      expect(w.terminate).not.toHaveBeenCalled();
      w.reply({
        type: "body",
        id: i + 1,
        status: 200,
        body: Uint8Array.of(i + 1).buffer,
      });
    }
    expect(s.fetch).toHaveBeenCalledOnce();
    expect(s.createWorker).toHaveBeenCalledTimes(FETCH_PARALLEL + 1);
    const replacement = s.workers[FETCH_PARALLEL];
    expect(replacement.messages).toEqual([
      expect.objectContaining({ type: "fetch", id: FETCH_PARALLEL + 1 }),
    ]);
    replacement.reply({ type: "ready" });
    replacement.reply({
      type: "body",
      id: FETCH_PARALLEL + 1,
      status: 200,
      body: Uint8Array.of(5).buffer,
    });
    const responses = await Promise.all(pending);
    for (const [i, response] of responses.entries()) {
      expect(
        Array.from(new Uint8Array(response.body ?? new ArrayBuffer(0))),
      ).toEqual(i === 1 ? [7, 8] : [i + 1]);
    }

    const later = s.request();
    const owner = s.workers.find((w) =>
      w.messages.some((m) => m.id === FETCH_PARALLEL + 2),
    );
    expect(owner).toBeDefined();
    expect(owner).not.toBe(failed);
    owner?.reply({
      type: "body",
      id: FETCH_PARALLEL + 2,
      status: 200,
      body: new ArrayBuffer(0),
    });
    await later;
    expect(s.fetch).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
    s.t.close(1000, "done");
    for (const w of s.workers) expect(w.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    "error",
    "messageerror",
    "malformed",
  ] as const)("disables the pool and falls back all requests on %s before ready", async (failure) => {
    const s = setup();
    const pending = Array.from({ length: FETCH_PARALLEL + 1 }, () =>
      s.request(),
    );
    for (const [i, w] of s.workers.entries())
      if (i !== 1) w.reply({ type: "ready" });
    const failed = s.workers[1];
    if (failure === "malformed") failed.reply(null);
    else if (failure === "error")
      failed.onerror?.call(failed as unknown as Worker, {} as ErrorEvent);
    else
      failed.onmessageerror?.call(
        failed as unknown as Worker,
        {} as MessageEvent,
      );
    await Promise.all(pending);
    await s.request();
    expect(s.fetch).toHaveBeenCalledTimes(FETCH_PARALLEL + 2);
    expect(s.createWorker).toHaveBeenCalledTimes(FETCH_PARALLEL);
    for (const w of s.workers) expect(w.terminate).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledOnce();
    s.t.close(1000, "done");
  });

  it("keeps the pool disabled after createWorker throws", async () => {
    const createWorker = vi.fn(() => {
      throw new Error("blocked");
    });
    const s = setup({ createWorker });
    await s.request();
    await s.request();
    expect(createWorker).toHaveBeenCalledOnce();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      "render-stream: resource worker unavailable; using main-thread fetch",
    );
    s.t.close(1000, "done");
  });

  it("a reconnect closes the old pool and lazily creates a fresh one", async () => {
    const old = setup();
    const requests = Array.from({ length: FETCH_PARALLEL }, () =>
      old.request(),
    );
    const settled = Promise.allSettled(requests);
    old.socket.onclose?.({ code: 1006, reason: "reconnect" });
    expect((await settled).every((r) => r.status === "rejected")).toBe(true);
    for (const w of old.workers) expect(w.terminate).toHaveBeenCalledOnce();
    const fresh = setup();
    fresh.socket.onopen?.();
    expect(fresh.workers).toHaveLength(0);
    const body = fresh.request();
    fresh.worker.reply({
      type: "body",
      id: 1,
      status: 200,
      body: new ArrayBuffer(0),
    });
    await body;
    expect(fresh.workers).toHaveLength(1);
    fresh.t.close(1000, "done");
  });

  it.each([
    ["", "/body", "https://base.test/body"],
    ["res/", "body", "https://base.test/assets/res/body"],
    ["//resources.test/res", "/body", "https://resources.test/res/body"],
    ["https://cdn.test/res", "/body", "https://cdn.test/res/body"],
  ])("resolves resourceBase %j before the worker fetches", async (resourceBase, path, absolute) => {
    const s = setup({}, resourceBase);
    vi.stubGlobal("location", { href: "https://page.test/app/index.html" });
    vi.stubGlobal("document", { baseURI: "https://base.test/assets/" });
    const workerFetch = vi.fn(async () => new Response(Uint8Array.of(1, 2)));
    runWorkerScript(s.worker, workerFetch);
    const response = await s.t.fetchResource(path, {
      token: null,
      signal: new AbortController().signal,
    });
    expect(workerFetch).toHaveBeenCalledWith(
      absolute,
      expect.objectContaining({ cache: "default", credentials: "omit" }),
    );
    expect(response).toMatchObject({
      status: 200,
      workerBody: true,
      workerDigestPath: "js-incremental",
    });
    expect(s.fetch).not.toHaveBeenCalled();
    s.t.close(1000, "done");
  });

  it.each([
    undefined,
    { baseURI: undefined },
  ])("uses location.href without a document base (%j)", async (document) => {
    const s = setup({}, "res/");
    vi.stubGlobal("document", document);
    vi.stubGlobal("location", { href: "https://page.test/app/index.html" });
    const workerFetch = vi.fn(async () => new Response());
    runWorkerScript(s.worker, workerFetch);
    await s.t.fetchResource("body", {
      token: null,
      signal: new AbortController().signal,
    });
    expect(workerFetch).toHaveBeenCalledWith(
      "https://page.test/app/res/body",
      expect.anything(),
    );
    s.t.close(1000, "done");
  });

  it("passes the URL through when document and location are unavailable", async () => {
    const s = setup({}, "res/");
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("location", undefined);
    const workerFetch = vi.fn(async () => new Response());
    runWorkerScript(s.worker, workerFetch);
    await s.t.fetchResource("body", {
      token: null,
      signal: new AbortController().signal,
    });
    expect(workerFetch).toHaveBeenCalledWith("res/body", expect.anything());
    s.t.close(1000, "done");
  });

  it.each([
    "disabled",
    "creation",
    "first error",
  ])("keeps the fallback's relative fetch URL after %s", async (failure) => {
    const s = setup(
      failure === "disabled"
        ? { fetchInWorker: false }
        : failure === "creation"
          ? {
              createWorker: () => {
                throw new Error("blocked");
              },
            }
          : {},
      "res/",
    );
    vi.stubGlobal("document", { baseURI: "https://base.test/assets/" });
    const response = s.t.fetchResource("body", {
      token: null,
      signal: new AbortController().signal,
    });
    if (failure === "first error")
      s.worker.onerror?.call(s.worker as unknown as Worker, {} as ErrorEvent);
    await response;
    expect(s.fetch).toHaveBeenCalledWith("res/body", expect.anything());
    s.t.close(1000, "done");
  });

  it("settles a worker fetch TypeError as temporary without switching to fallback", async () => {
    const s = setup();
    const workerFetch = vi.fn(async () => {
      throw new TypeError("Invalid URL");
    });
    runWorkerScript(s.worker, workerFetch);
    const f = new LiveFetcher(
      (path, signal) => s.t.fetchResource(path, { token: null, signal }),
      "/",
      1000,
      0,
      null,
      { failures: "settle" },
    );
    f.start(["a"]);
    f.poll();
    await tick();
    expect(f.poll().results[0]).toMatchObject({
      status: null,
      outcome: "temporary",
      error:
        "resource-unavailable: GET /a: the request failed (TypeError: Invalid URL)",
    });
    f.start(["b"]);
    f.poll();
    await tick();
    expect(f.poll().results[0].outcome).toBe("temporary");
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.worker.terminate).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    f.abort();
    s.t.close(1000, "done");
  });

  it.each([
    false,
    true,
  ])("three generations keep only four slow worker GETs (keepRetries %s)", async (keepRetries) => {
    const s = setup();
    const outstanding = new Set<AbortSignal>();
    let peak = 0;
    const workerFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            outstanding.add(signal);
            peak = Math.max(peak, outstanding.size);
            signal.addEventListener(
              "abort",
              () => {
                outstanding.delete(signal);
                controller.error(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          },
        }),
      );
    });
    s.runWorkers(workerFetch);
    const onBody = vi.fn();
    const f = new LiveFetcher(
      (path, signal) => s.t.fetchResource(path, { token: null, signal }),
      "/",
      1000,
      0,
      onBody,
      { maxInFlight: 4, failures: "settle", abortOnCancel: true },
    );
    for (let generation = 0; generation < 3; generation++) {
      if (generation > 0) f.cancel({ keepRetries });
      f.start(["a", "b", "c", "d"]);
      f.poll();
      await tick();
      expect(f.inFlightCount()).toBe(4);
      expect(outstanding.size).toBe(4);
    }
    expect(workerFetch).toHaveBeenCalledTimes(12);
    expect(peak).toBe(4);
    expect(
      s
        .allMessages()
        .filter((m) => m.type === "abort")
        .map((m) => m.id),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // A reply already queued by a superseded request must not stage under its new generation.
    s.worker.reply({
      type: "body",
      id: 1,
      status: 200,
      body: new ArrayBuffer(4),
    });
    await tick();
    expect(onBody).not.toHaveBeenCalled();
    expect(f.poll().results).toEqual([]);
    f.abort();
    await tick();
    expect(outstanding.size).toBe(0);
    s.t.close(1000, "done");
  });

  it("preserves retry deadlines and bounds while cancel aborts other worker GETs", async () => {
    const s = setup();
    let now = 0;
    const onRetry = vi.fn();
    const f = new LiveFetcher(
      (path, signal) => s.t.fetchResource(path, { token: null, signal }),
      "/",
      1000,
      0,
      null,
      {
        maxInFlight: 4,
        failures: "settle",
        abortOnCancel: true,
        retry: { now: () => now, mode: () => "demand", onRetry },
      },
    );
    f.start(["retry", "slow"]);
    f.poll();
    s.worker.reply({
      type: "body",
      id: 1,
      status: 500,
      body: new ArrayBuffer(0),
    });
    await tick();
    f.cancel({ keepRetries: true });
    await tick();
    expect(s.allMessages().filter((m) => m.type === "abort")).toEqual([
      { type: "abort", id: 2 },
    ]);
    expect([...f.requested()]).toEqual(["retry"]);
    for (const [index, delay] of [250, 500, 1000].entries()) {
      const due = now + delay;
      now = due - 1;
      f.cancel({ keepRetries: true });
      f.poll();
      expect(s.allMessages().filter((m) => m.type === "fetch")).toHaveLength(
        index + 2,
      );
      now = due;
      f.poll();
      s.worker.reply({
        type: "body",
        id: index + 3,
        status: 500,
        body: new ArrayBuffer(0),
      });
      await tick();
    }
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(f.poll()).toMatchObject({
      results: [{ hash: "retry", outcome: "temporary" }],
      finished: true,
    });
    expect(f.has("slow")).toBe(false);
    f.start(["reset"]);
    f.poll();
    s.worker.reply({
      type: "body",
      id: 6,
      status: 500,
      body: new ArrayBuffer(0),
    });
    await tick();
    expect(f.has("reset")).toBe(true);
    f.cancel();
    expect(f.requested().size).toBe(0);
    expect(f.poll().finished).toBe(true);
    s.t.close(1000, "done");
  });

  it("hands a transferred 200 body to the fetcher's staging callback", async () => {
    const { t, worker, fetch } = setup();
    const staged: number[][] = [];
    const f = new LiveFetcher(
      (path, signal, opts) =>
        t.fetchResource(path, { token: null, signal, ...opts }),
      "/",
      1000,
      0,
      (r) => {
        staged.push(Array.from(r.data ?? []));
      },
      { yieldTask: async () => {} },
    );
    f.start(["a"]);
    f.poll();
    const source = Uint8Array.of(1, 2, 3).buffer;
    const transferred = structuredClone(source, { transfer: [source] });
    worker.reply({
      type: "body",
      id: 1,
      status: 200,
      sizeHint: 3,
      body: transferred,
    });
    await tick();
    expect(source.byteLength).toBe(0);
    expect(staged).toEqual([[1, 2, 3]]);
    expect(f.poll()).toMatchObject({
      results: [{ outcome: "ok", bytes: 3 }],
      finished: true,
    });
    expect(fetch).not.toHaveBeenCalled();
    t.close(1000, "done");
  });

  it.each([
    "error",
    "stall",
  ])("a worker %s frees the next wire slot without poll", async (failure) => {
    vi.useFakeTimers();
    const { t, worker } = setup();
    const f = new LiveFetcher(
      (path, signal, opts) =>
        t.fetchResource(path, { token: null, signal, ...opts }),
      "/",
      100,
      0,
      null,
      { maxInFlight: 1, failures: "settle" },
    );
    f.start(["a", "b"]);
    f.poll();
    if (failure === "error")
      worker.reply({ type: "error", id: 1, error: "offline" });
    else await vi.advanceTimersByTimeAsync(100);
    await tick();
    expect(
      worker.messages.filter((m) => m.type === "fetch").map((m) => m.url),
    ).toEqual(["http://localhost/r/a", "http://localhost/r/b"]);
    expect(f.poll().results[0].outcome).toBe("temporary");
    f.abort();
    t.close(1000, "done");
  });

  it("progress resets the stall timer; a stalled body is temporary and aborted by id", async () => {
    vi.useFakeTimers();
    const { t, worker } = setup();
    const f = new LiveFetcher(
      (path, signal, opts) =>
        t.fetchResource(path, { token: null, signal, ...opts }),
      "/",
      100,
      0,
      null,
      { failures: "settle" },
    );
    f.start(["a"]);
    f.poll();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(80);
      worker.reply({ type: "progress", id: 1, bytes: i * 10 });
    }
    expect(f.poll().results).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.poll().results[0]).toMatchObject({
      outcome: "temporary",
      error: "resource-unavailable: GET /a: stalled, no progress for 100 ms",
    });
    expect(worker.messages.at(-1)).toEqual({ type: "abort", id: 1 });
    t.close(1000, "done");
  });

  it.each([
    [404, "missing"],
    [500, "temporary"],
    [401, "fatal"],
  ])("classifies worker HTTP %s as %s", async (status, outcome) => {
    const { t, worker } = setup();
    const f = new LiveFetcher(
      (path, signal) => t.fetchResource(path, { token: null, signal }),
      "/",
      1000,
      0,
    );
    f.start(["a"]);
    f.poll();
    worker.reply({ type: "body", id: 1, status, body: new ArrayBuffer(0) });
    await tick();
    expect(f.poll().results[0].outcome).toBe(outcome);
    t.close(1000, "done");
  });

  it("drops late replies after abort or close and terminates on close", async () => {
    const { t, worker, request } = setup();
    const a = new AbortController();
    const first = request(a.signal);
    a.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    worker.reply({
      type: "body",
      id: 1,
      status: 200,
      body: new ArrayBuffer(5),
    });
    const second = request();
    const late = worker.onmessage;
    t.close(1000, "done");
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    late?.call(
      worker as unknown as Worker,
      {
        data: { type: "body", id: 2, status: 200, body: new ArrayBuffer(5) },
      } as MessageEvent,
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    await expect(request()).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    "creation",
    "first post",
    "first error",
    "message error",
    "malformed message",
    "missing API",
    "disabled",
  ])("keeps the main-thread path for the transport lifetime after %s", async (failure) => {
    const createWorker = vi.fn(() => {
      throw new Error("blocked");
    });
    const s = setup(
      failure === "creation"
        ? { createWorker }
        : failure === "disabled"
          ? { fetchInWorker: false }
          : {},
    );
    if (failure === "missing API") {
      vi.stubGlobal("Worker", undefined);
      // Exercise the real capability check, without the test factory.
      const other = setup({ createWorker: undefined });
      const r = await other.request();
      expect(r.body?.byteLength).toBe(2);
      expect(console.warn).toHaveBeenCalledOnce();
      other.t.close(1000, "done");
      return;
    }
    if (failure === "first post")
      s.worker.postMessage.mockImplementation(() => {
        throw new Error("clone");
      });
    const first = s.request();
    if (failure === "first error")
      s.worker.onerror?.call(s.worker as unknown as Worker, {} as ErrorEvent);
    if (failure === "message error")
      s.worker.onmessageerror?.call(
        s.worker as unknown as Worker,
        {} as MessageEvent,
      );
    if (failure === "malformed message") s.worker.reply(null);
    const r = await first;
    expect(Array.from(new Uint8Array(r.body ?? new ArrayBuffer(0)))).toEqual([
      7, 8,
    ]);
    await s.request();
    expect(r.workerDigest).toBeUndefined();
    expect(r.workerBody).toBeUndefined();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.fetch).toHaveBeenCalledWith(
      "http://localhost/r/a",
      expect.objectContaining({
        headers: { Authorization: "Bearer secret" },
        cache: "default",
        credentials: "omit",
      }),
    );
    expect(console.warn).toHaveBeenCalledTimes(failure === "disabled" ? 0 : 1);
    if (failure === "creation") expect(createWorker).toHaveBeenCalledOnce();
    s.t.close(1000, "done");
  });

  it("revokes the Blob URL on success and constructor failure", async () => {
    for (const throws of [false, true]) {
      const s = setup({ createWorker: undefined });
      const create = vi.fn(() => "blob:resource-worker");
      const revoke = vi.fn();
      vi.stubGlobal(
        "URL",
        class extends URL {
          static createObjectURL = create;
          static revokeObjectURL = revoke;
        },
      );
      let worker!: FakeWorker;
      vi.stubGlobal(
        "Worker",
        class extends FakeWorker {
          constructor() {
            super();
            if (throws) throw new Error("CSP");
            worker = this;
          }
        },
      );
      const p = s.request();
      if (!throws)
        worker.reply({
          type: "body",
          id: 1,
          status: 200,
          body: new ArrayBuffer(0),
        });
      await p;
      expect(create).toHaveBeenCalledOnce();
      expect(revoke).toHaveBeenCalledWith("blob:resource-worker");
      s.t.close(1000, "done");
    }
  });
});

describe("self-contained worker source", () => {
  it.each([
    false,
    true,
  ])("hashes fallback chunks on arrival and releases an aborted stream (%s)", async (abort) => {
    const bytes = Uint8Array.from({ length: 257 }, (_, i) => i);
    const updates: number[] = [];
    const messages: {
      type: string;
      id?: number;
      digest?: string;
      body?: ArrayBuffer;
    }[] = [];
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const self = {
      onmessage: null as ((event: { data: unknown }) => Promise<void>) | null,
      postMessage(m: (typeof messages)[number], transfer?: ArrayBuffer[]) {
        messages.push(structuredClone(m, { transfer }));
      },
    };
    const context = {
      self,
      performance,
      AbortController,
      Uint8Array,
      onUpdate: (n: number) => updates.push(n),
      fetch: async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              stream = c;
              init.signal?.addEventListener(
                "abort",
                () => c.error(new Error("aborted")),
                { once: true },
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    };
    runInNewContext(
      `${RESOURCE_WORKER_SOURCE}
      const update = Sha256.prototype.update;
      Sha256.prototype.update = function(bytes) { onUpdate(bytes.length); return update.call(this, bytes); };
    `,
      context,
    );
    const pending = self.onmessage?.({
      data: { type: "fetch", id: 1, url: "/body" },
    });
    await tick();
    stream.enqueue(bytes.subarray(0, 65));
    await tick();
    expect(updates).toEqual([65]);
    expect(messages.some((m) => m.type === "body")).toBe(false);
    if (abort) {
      await self.onmessage?.({ data: { type: "abort", id: 1 } });
    } else {
      stream.enqueue(bytes.subarray(65));
      stream.close();
    }
    await pending;
    expect(cancelled).toBe(false);
    expect(runInNewContext("requests.size", context)).toBe(0);
    const body = messages.find((m) => m.type === "body");
    if (abort) {
      expect(body).toBeUndefined();
      expect(messages.some((m) => m.type === "error")).toBe(false);
      expect(updates).toEqual([65]);
    } else {
      expect(updates).toEqual([65, 192]);
      expect(body?.digest).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(new Uint8Array(body?.body ?? new ArrayBuffer(0))).toEqual(bytes);
    }
    expect(() => stream.desiredSize).not.toThrow();
  });

  it("keeps the SHA fallback self-contained after bundling and minification", async () => {
    const bundled = await build({
      entryPoints: [
        fileURLToPath(new URL("../src/resource-worker.ts", import.meta.url)),
      ],
      bundle: true,
      minify: true,
      write: false,
      format: "iife",
      globalName: "ResourceModule",
      target: "es2022",
    });
    const source = runInNewContext(
      `${bundled.outputFiles[0].text}; ResourceModule.RESOURCE_WORKER_SOURCE`,
    );
    let reply!: { digest: string };
    const self = {
      onmessage: null as ((event: { data: unknown }) => Promise<void>) | null,
      postMessage(m: { type: string; digest: string }) {
        if (m.type === "body") reply = m;
      },
    };
    runInNewContext(source, {
      self,
      performance,
      AbortController,
      Uint8Array,
      fetch: async () => new Response(Uint8Array.of(1, 2, 3)),
    });
    await self.onmessage?.({ data: { type: "fetch", id: 1, url: "/body" } });
    expect(reply.digest).toBe(
      createHash("sha256")
        .update(Uint8Array.of(1, 2, 3))
        .digest("hex"),
    );
  });

  it.each([
    ["native", true, 200, 1],
    ["fallback", true, 200, 4],
    ["native rejects", true, 200, 2],
    ["fallback", false, 200, 3],
    ["fallback", true, 404, 0],
  ] as const)("times hash work for %s (stream %s, status %s), excluding reads", async (mode, streamed, status, expectedMs) => {
    let now = 0;
    const clock = { now: () => now++ };
    const messages: { type: string; hashMs?: number; digestPath?: string }[] =
      [];
    const self = {
      onmessage: null as ((event: { data: unknown }) => Promise<void>) | null,
      postMessage(m: (typeof messages)[number]) {
        messages.push(m);
      },
    };
    runInNewContext(RESOURCE_WORKER_SOURCE, {
      self,
      performance: clock,
      AbortController,
      Uint8Array,
      crypto:
        mode === "fallback"
          ? undefined
          : {
              subtle: {
                digest: () =>
                  mode === "native rejects"
                    ? Promise.reject(new Error("unavailable"))
                    : Promise.resolve(new ArrayBuffer(32)),
              },
            },
      fetch: async () => ({
        status,
        headers: new Headers(),
        body: streamed
          ? {
              getReader: () => {
                let chunk = 0;
                return {
                  read: async () => {
                    now += 1000;
                    return chunk++ < 2
                      ? { done: false, value: Uint8Array.of(chunk) }
                      : { done: true };
                  },
                  releaseLock() {},
                };
              },
            }
          : null,
        arrayBuffer: async () => {
          now += 1000;
          return Uint8Array.of(1, 2).buffer;
        },
      }),
    });
    await self.onmessage?.({ data: { type: "fetch", id: 1, url: "/body" } });
    expect(messages.find((m) => m.type === "body")).toMatchObject({
      hashMs: expectedMs,
    });
  });

  it("drops a body if abort arrives while the native digest is pending", async () => {
    let resolveDigest!: (value: ArrayBuffer) => void;
    let hashing!: () => void;
    const started = new Promise<void>((resolve) => {
      hashing = resolve;
    });
    const messages: { type: string; id?: number }[] = [];
    const self = {
      onmessage: null as ((event: { data: unknown }) => Promise<void>) | null,
      postMessage(m: (typeof messages)[number]) {
        messages.push(m);
      },
    };
    runInNewContext(RESOURCE_WORKER_SOURCE, {
      self,
      performance,
      AbortController,
      Uint8Array,
      crypto: {
        subtle: {
          digest: () =>
            new Promise<ArrayBuffer>((resolve) => {
              resolveDigest = resolve;
              hashing();
            }),
        },
      },
      fetch: async () => new Response(Uint8Array.of(1, 2, 3)),
    });
    const pending = self.onmessage?.({
      data: { type: "fetch", id: 1, url: "/body" },
    });
    await started;
    await self.onmessage?.({ data: { type: "abort", id: 1 } });
    resolveDigest(new ArrayBuffer(32));
    await pending;
    expect(
      messages.filter((m) => m.id === 1).every((m) => m.type === "progress"),
    ).toBe(true);
  });

  it.each([
    "native",
    "fallback",
    "native rejects",
  ])("hashes the exact transferred body using %s, including a perturbed body", async (mode) => {
    for (const bytes of [Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4)]) {
      const digest = vi.fn(
        (...args: Parameters<typeof webcrypto.subtle.digest>) =>
          mode === "native rejects"
            ? Promise.reject(new Error("unavailable"))
            : webcrypto.subtle.digest(...args),
      );
      const messages: {
        type: string;
        digest?: string;
        digestPath?: string;
        body?: ArrayBuffer;
      }[] = [];
      const transferred: ArrayBuffer[] = [];
      const self = {
        onmessage: null as ((event: { data: unknown }) => Promise<void>) | null,
        postMessage(
          message: (typeof messages)[number],
          transfer?: ArrayBuffer[],
        ) {
          messages.push(structuredClone(message, { transfer }));
          transferred.push(...(transfer ?? []));
        },
      };
      runInNewContext(RESOURCE_WORKER_SOURCE, {
        self,
        performance,
        AbortController,
        Uint8Array,
        crypto: mode === "fallback" ? undefined : { subtle: { digest } },
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(bytes.subarray(0, 1));
                c.enqueue(bytes.subarray(1));
                c.close();
              },
            }),
          ),
      });
      await self.onmessage?.({ data: { type: "fetch", id: 1, url: "/body" } });
      const body = messages.find((m) => m.type === "body");
      expect(body?.digest).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(body?.digestPath).toBe(
        mode === "native" ? "native" : "js-incremental",
      );
      expect(
        Array.from(new Uint8Array(body?.body ?? new ArrayBuffer(0))),
      ).toEqual(Array.from(bytes));
      expect(transferred[0].byteLength).toBe(0);
      expect(digest).toHaveBeenCalledTimes(mode === "fallback" ? 0 : 1);
    }
  });

  it("reads and reports progress, transfers the body and honors abort messages", async () => {
    const messages: {
      type: string;
      id?: number;
      bytes?: number;
      body?: ArrayBuffer;
      status?: number;
      sizeHint?: number;
    }[] = [];
    const transfers: ArrayBuffer[] = [];
    const self = {
      onmessage: null as ((event: { data: unknown }) => Promise<void>) | null,
      postMessage(m: (typeof messages)[number], transfer?: ArrayBuffer[]) {
        const clone = structuredClone(m, { transfer });
        messages.push(clone);
        if (transfer) transfers.push(...transfer);
      },
    };
    const fetch = vi.fn(async (_url, init) => {
      if (_url === "abort")
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(Uint8Array.of(1, 2));
            c.enqueue(Uint8Array.of(3));
            c.close();
          },
        }),
        { headers: { "content-length": "2" } },
      );
    });
    runInNewContext(RESOURCE_WORKER_SOURCE, {
      self,
      fetch,
      performance,
      AbortController,
      Uint8Array,
    });
    expect(messages[0]).toEqual({ type: "ready" });
    await self.onmessage?.({
      data: {
        type: "fetch",
        id: 1,
        url: "/body",
        headers: { Authorization: "Bearer t" },
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      "/body",
      expect.objectContaining({
        headers: { Authorization: "Bearer t" },
        cache: "default",
        credentials: "omit",
      }),
    );
    expect(
      messages.filter((m) => m.type === "progress").map((m) => m.bytes),
    ).toEqual([0, 2, 3]);
    expect(messages.at(-1)).toMatchObject({
      type: "body",
      status: 200,
      sizeHint: 2,
    });
    expect(
      Array.from(new Uint8Array(messages.at(-1)?.body ?? new ArrayBuffer(0))),
    ).toEqual([1, 2, 3]);
    expect(transfers[0].byteLength).toBe(0);
    const pending = self.onmessage?.({
      data: { type: "fetch", id: 2, url: "abort", headers: {} },
    });
    await self.onmessage?.({ data: { type: "abort", id: 2 } });
    await pending;
    expect(messages.some((m) => m.id === 2)).toBe(false);
  });
});
