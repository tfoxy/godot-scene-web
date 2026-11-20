// WasmStreamCore's staging stream over the wasm ABI (a view taken after every reservation, so a
// memory growth between chunks is harmless), and the WebSocket transport's opt-in body stream.

import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GswRs, GswRsModule } from "../src/abi";
import { WasmStreamCore } from "../src/core";
import { LiveFetcher } from "../src/fetcher";
import { RESOURCE_WORKER_SOURCE } from "../src/resource-worker";
import { stagingSample } from "../src/staging";
import { webSocketTransport } from "../src/transport";
import { flush } from "./fakes";

/** A fake wasm instance whose streams live in its linear memory: every reservation grows the
 * memory (detaching every older view) and moves the stream's buffer to fresh pages. */
function wasmFake() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 512 });
  const streams = new Map<
    number,
    { hash: string; hint: number; ptr: number; got: number[]; digest?: string }
  >();
  const finished: { hash: string; bytes: number[]; hint: number }[] = [];
  let next = 0;
  let err = "";
  const g = {
    stream_begin(hash: string, hint: number) {
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        err = `resource-unavailable: "${hash}" is not a sha256 hex name`;
        return -1;
      }
      streams.set(++next, { hash, hint, ptr: 0, got: [] });
      return next;
    },
    stream_begin_hashed(hash: string, digest: string, hint: number) {
      const id = this.stream_begin(hash, hint);
      if (id > 0) {
        const s = streams.get(id);
        if (s) s.digest = digest;
      }
      return id;
    },
    live_reset() {
      streams.clear();
    },
    stream_chunk_ptr(id: number, len: number) {
      const s = streams.get(id);
      if (!s) return 0;
      const pages = memory.buffer.byteLength / 65536;
      memory.grow(Math.ceil(len / 65536) + 1);
      s.ptr = pages * 65536;
      return s.ptr;
    },
    stream_commit(id: number, len: number) {
      const s = streams.get(id);
      if (!s) return -1;
      s.got.push(...new Uint8Array(memory.buffer, s.ptr, len));
      return 0;
    },
    stream_finish(id: number) {
      const s = streams.get(id);
      streams.delete(id);
      if (!s) {
        err = "not open";
        return -1;
      }
      finished.push({ hash: s.hash, bytes: s.got, hint: s.hint });
      if (s.digest !== undefined ? s.digest !== s.hash : s.got.includes(0xee)) {
        err = "resource-hash: payload sha256 x disagrees with the wire's y";
        return -1;
      }
      return 0;
    },
    stream_abort(id: number) {
      streams.delete(id);
    },
    stream_count() {
      return streams.size;
    },
    staged_info: (_hash: string) => "other,0",
    error() {
      return err;
    },
    set_log_removed() {},
    free: vi.fn(),
  };
  const mod = {} as unknown as GswRsModule;
  const core = new WasmStreamCore(
    mod,
    memory,
    () => g as unknown as GswRs,
    12,
    "",
    1 << 20,
  );
  return { core, g, memory, streams, finished };
}

const HASH = "ab".repeat(32);

describe("WasmStreamCore.stageStream", () => {
  it.each([
    false,
    true,
  ])("passes the main-requested hash separately from the worker digest (mismatch %s)", (mismatch) => {
    const w = wasmFake();
    const hashed = vi.spyOn(w.g, "stream_begin_hashed");
    const digest = mismatch ? "cd".repeat(32) : HASH;
    const stream = w.core.stageStream(HASH, 2, undefined, digest);
    stream.write(Uint8Array.of(1, 2));
    expect(hashed).toHaveBeenCalledWith(HASH, digest, 2);
    expect(stream.finish()).toBe(
      mismatch
        ? "resource-hash: payload sha256 x disagrees with the wire's y"
        : null,
    );
    expect(w.g.stream_count()).toBe(0);
  });

  it("keeps wasm hashing without a worker digest or with an older wasm core", () => {
    const w = wasmFake();
    const hashed = vi.spyOn(w.g, "stream_begin_hashed");
    const begin = vi.spyOn(w.g, "stream_begin");
    w.core.stageStream(HASH, 1).abort();
    expect(hashed).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledOnce();
    Object.assign(w.g, { stream_begin_hashed: undefined });
    const sample = stagingSample();
    sample.digestPath = "native";
    const s = w.core.stageStream(HASH, 1, sample, HASH);
    s.write(Uint8Array.of(1));
    expect(s.finish()).toBeNull();
    expect(begin).toHaveBeenCalledTimes(2);
    expect(w.core.stagingStats().other.wasmPayloads).toBe(2);
    expect(w.core.stagingStats().other.nativePayloads).toBe(0);
  });

  it.each([
    "abort",
    "reset",
  ])("releases a worker-hashed stream on %s without staging", (action) => {
    const w = wasmFake();
    const s = w.core.stageStream(HASH, 2, undefined, HASH);
    s.write(Uint8Array.of(1));
    expect(w.g.stream_count()).toBe(1);
    if (action === "abort") s.abort();
    else w.core.reset(true);
    s.write(Uint8Array.of(2));
    expect(s.finish()).toContain("resource-unavailable");
    expect(w.g.stream_count()).toBe(0);
    expect(w.finished).toEqual([]);
  });

  it.each([
    false,
    true,
  ])("stages only bytes transferred and hashed by the production worker (perturbed %s)", async (perturbed) => {
    const good = Uint8Array.of(1, 2, 3, 4);
    const hash = createHash("sha256").update(good).digest("hex");
    const body = good.slice();
    if (perturbed) body[3] ^= 1;
    let transferred!: ArrayBuffer;
    let response!: {
      status: number;
      body: ArrayBuffer;
      digest: string;
      digestPath: "js-incremental";
    };
    const self = {
      onmessage: null as ((event: { data: unknown }) => Promise<void>) | null,
      postMessage(m: { type: string }, transfer?: ArrayBuffer[]) {
        if (m.type === "body") {
          transferred = transfer?.[0] as ArrayBuffer;
          response = structuredClone(m, {
            transfer,
          }) as unknown as typeof response;
        }
      },
    };
    runInNewContext(RESOURCE_WORKER_SOURCE, {
      self,
      performance,
      AbortController,
      Uint8Array,
      fetch: async () => new Response(body),
    });
    await self.onmessage?.({ data: { type: "fetch", id: 1, url: "/body" } });
    expect(transferred.byteLength).toBe(0);
    const w = wasmFake();
    const hashed = vi.spyOn(w.g, "stream_begin_hashed");
    const f = new LiveFetcher(
      async () => ({
        ...response,
        workerBody: true,
        workerDigest: response.digest,
        workerDigestPath: response.digestPath,
      }),
      "/r/",
      1000,
      0,
      null,
      {
        stager: w.core.stageStream.bind(w.core),
        sliceBytes: 2,
        yieldTask: async () => {},
      },
    );
    f.start([hash]);
    f.poll();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const [result] = f.poll().results;
    expect(hashed).toHaveBeenCalledWith(hash, response.digest, 0);
    expect(result.stage_error).toBe(
      perturbed
        ? "resource-hash: payload sha256 x disagrees with the wire's y"
        : null,
    );
    expect(w.finished[0].bytes).toEqual(Array.from(body));
    expect(w.g.stream_count()).toBe(0);
    expect(w.core.stagingStats().other.bytesInSum).toBe(body.length);
    expect(w.core.stagingStats().other.jsIncrementalPayloads).toBe(1);
    expect(w.core.stagingStats().other.wasmPayloads).toBe(0);
    f.abort();
  });

  it("adds staging totals and per-payload maxima by kind without counting yielded time", () => {
    const w = wasmFake();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now++);
    try {
      const kinds = [
        "rgba8Texture",
        "otherTexture",
        "mesh",
        "shader",
        "other",
      ] as const;
      for (const kind of kinds) {
        w.g.staged_info = () => `${kind},8`;
        for (const n of [2, 3]) {
          const sample = stagingSample();
          sample.workerMessageMs = n;
          sample.sliceMs = n * 2;
          const stream = w.core.stageStream(HASH, n, sample);
          stream.write(new Uint8Array(n));
          now += 1000; // Time yielded to other tasks is excluded.
          stream.write(Uint8Array.of(9));
          expect(stream.finish()).toBeNull();
        }
      }
      for (const row of Object.values(w.core.stagingStats())) {
        expect(row).toEqual({
          payloads: 2,
          nativePayloads: 0,
          jsIncrementalPayloads: 0,
          wasmPayloads: 2,
          copyMsSum: 4,
          copyMsMax: 2,
          commitMsSum: 4,
          commitMsMax: 2,
          finishMsSum: 2,
          finishMsMax: 1,
          workerMessageMsSum: 5,
          workerMessageMsMax: 3,
          workerHashMsSum: 0,
          workerHashMsMax: 0,
          nativeHashMsSum: 0,
          nativeHashMsMax: 0,
          jsIncrementalHashMsSum: 0,
          jsIncrementalHashMsMax: 0,
          sliceMsSum: 10,
          sliceMsMax: 6,
          bytesInSum: 7,
          bytesInMax: 4,
          bytesOutSum: 16,
          bytesOutMax: 8,
        });
      }
      const snapshot = w.core.stagingStats();
      snapshot.mesh.bytesInSum = -1;
      expect(w.core.stagingStats().mesh.bytesInSum).toBe(7);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("counts each digest path once through the worker response and staging pipeline", async () => {
    const w = wasmFake();
    const f = new LiveFetcher(
      async (path) => ({
        status: 200,
        body: Uint8Array.of(1, 2).buffer,
        workerBody: true,
        workerDigest: HASH,
        workerHashMs: path.endsWith("native") ? 7 : 11,
        workerDigestPath: path.endsWith("native") ? "native" : "js-incremental",
      }),
      "/",
      1000,
      0,
      null,
      {
        stager: w.core.stageStream.bind(w.core),
        yieldTask: async () => {},
      },
    );
    for (const path of ["native", "js", "js-again"]) {
      f.start([path]);
      f.poll();
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(f.poll().results).toHaveLength(1);
    }
    w.core.stageStream(HASH, 0).finish();
    const row = w.core.stagingStats().other;
    expect(row.nativePayloads).toBe(1);
    expect(row.jsIncrementalPayloads).toBe(2);
    expect(row.workerHashMsSum).toBe(29);
    expect(row.workerHashMsMax).toBe(11);
    expect(row.nativeHashMsSum).toBe(7);
    expect(row.nativeHashMsMax).toBe(7);
    expect(row.jsIncrementalHashMsSum).toBe(22);
    expect(row.jsIncrementalHashMsMax).toBe(11);
    expect(row.wasmPayloads).toBe(1);
    expect(row.payloads).toBe(
      row.nativePayloads + row.jsIncrementalPayloads + row.wasmPayloads,
    );
    f.abort();
  });
  it("writes every chunk through a view taken after its reservation, across memory growth", () => {
    const w = wasmFake();
    const s = w.core.stageStream(HASH, 9);
    const before = w.memory.buffer.byteLength;
    s.write(Uint8Array.of(1, 2, 3));
    s.write(new Uint8Array(70000).fill(7));
    s.write(Uint8Array.of(4));
    expect(w.memory.buffer.byteLength).toBeGreaterThan(before);
    expect(s.finish()).toBeNull();
    expect(w.finished).toHaveLength(1);
    const f = w.finished[0];
    expect([f.hash, f.hint, f.bytes.length]).toEqual([HASH, 9, 70004]);
    expect(f.bytes.slice(0, 4)).toEqual([1, 2, 3, 7]);
    expect(f.bytes.at(-1)).toBe(4);
    expect(w.streams.size).toBe(0);
  });

  it("a refusal is the core's error; abort frees the stream; a bad name refuses at finish", () => {
    const w = wasmFake();
    const bad = w.core.stageStream(HASH, 0);
    bad.write(Uint8Array.of(0xee));
    expect(bad.finish()).toMatch(/^resource-hash: /);
    const dropped = w.core.stageStream(HASH, 0);
    dropped.write(Uint8Array.of(1));
    expect(w.streams.size).toBe(1);
    dropped.abort();
    expect(w.streams.size).toBe(0);
    dropped.write(Uint8Array.of(2)); // nothing after an abort
    expect(w.streams.size).toBe(0);
    const named = w.core.stageStream("nope", 0);
    named.write(Uint8Array.of(1));
    expect(named.finish()).toMatch(/is not a sha256 hex name/);
  });

  it("a stream the instance dropped (a reset) refuses at finish instead of writing at 0", () => {
    const w = wasmFake();
    const s = w.core.stageStream(HASH, 0);
    w.streams.clear();
    s.write(Uint8Array.of(1));
    expect(s.finish()).toBe(
      "resource-unavailable: the payload stream was dropped",
    );
    expect(new Uint8Array(w.memory.buffer, 0, 1)[0]).toBe(0);
  });

  it("end to end with the fetcher: chunks of a fetched body land in wasm as they arrive", async () => {
    const w = wasmFake();
    const chunks = [new Uint8Array(100_000).fill(3), Uint8Array.of(9, 9)];
    const f = new LiveFetcher(
      async () => ({
        status: 200,
        body: null,
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            for (const x of chunks) c.enqueue(x);
            c.close();
          },
        }),
        sizeHint: 100_002,
      }),
      "/r/",
      10000,
      0,
      null,
      { stager: (h, n) => w.core.stageStream(h, n), sliceBytes: 65536 },
    );
    f.start([HASH]);
    f.poll();
    for (let i = 0; i < 6; i++) await flush();
    const [r] = f.poll().results;
    expect(r).toMatchObject({ bytes: 100_002, stage_error: null });
    expect(w.finished[0].bytes.length).toBe(100_002);
    expect(w.finished[0].hint).toBe(100_002);
  });
});

describe("webSocketTransport.fetchResource body stream", () => {
  afterEach(() => vi.unstubAllGlobals());

  function transportWith(res: Response) {
    class FakeSocket {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = 0;
      binaryType = "";
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const fetch = vi.fn(async () => res);
    vi.stubGlobal("fetch", fetch);
    const t = webSocketTransport(
      {
        url: "ws://127.0.0.1:1/s",
        resourceBase: "http://127.0.0.1:1",
      } as never,
      "render-stream/12",
      { open() {}, message() {}, close() {} },
    );
    return { t, fetch };
  }

  it("answers a 200 with its stream and Content-Length when asked", async () => {
    const { t } = transportWith(
      new Response(new Uint8Array(5), {
        status: 200,
        headers: { "content-length": "5" },
      }),
    );
    const r = await t.fetchResource("/a", {
      token: null,
      signal: new AbortController().signal,
      stream: true,
    });
    expect(r.body).toBeNull();
    expect(r.sizeHint).toBe(5);
    expect(r.stream).toBeInstanceOf(ReadableStream);
  });

  it("a content-encoded body is streamed whole, its length only a hint (the decoded body is longer)", async () => {
    const decoded = new Uint8Array(3000).fill(1);
    const { t } = transportWith(
      new Response(decoded, {
        status: 200,
        headers: { "content-length": "40", "content-encoding": "gzip" },
      }),
    );
    const got: number[] = [];
    const f = new LiveFetcher(
      (path, signal, opts) =>
        t.fetchResource(path, { token: null, signal, stream: opts?.stream }),
      "/r/",
      10000,
      0,
      null,
      {
        stager: (_h, hint) => {
          got.push(hint);
          let n = 0;
          return {
            write: (c) => {
              n += c.length;
            },
            finish: () => {
              got.push(n);
              return null;
            },
            abort: () => {},
          };
        },
      },
    );
    f.start(["a"]);
    f.poll();
    for (let i = 0; i < 6; i++) await flush();
    expect(f.poll().results[0].bytes).toBe(3000);
    expect(got).toEqual([40, 3000]);
  });

  it("without the ask, or on a non-200, answers with the whole body", async () => {
    const a = transportWith(new Response(new Uint8Array(3), { status: 200 }));
    const r = await a.t.fetchResource("/a", {
      token: "t",
      signal: new AbortController().signal,
    });
    expect([r.stream, r.body?.byteLength]).toEqual([undefined, 3]);
    const b = transportWith(new Response("gone", { status: 404 }));
    const r404 = await b.t.fetchResource("/a", {
      token: null,
      signal: new AbortController().signal,
      stream: true,
    });
    expect([r404.status, r404.stream, r404.body?.byteLength]).toEqual([
      404,
      undefined,
      4,
    ]);
  });
});
