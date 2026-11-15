// WasmStreamCore's staging stream over the wasm ABI (a view taken after every reservation, so a
// memory growth between chunks is harmless), and the WebSocket transport's opt-in body stream.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GswRs, GswRsModule } from "../src/abi";
import { WasmStreamCore } from "../src/core";
import { LiveFetcher } from "../src/fetcher";
import { webSocketTransport } from "../src/transport";
import { flush } from "./fakes";

/** A fake wasm instance whose streams live in its linear memory: every reservation grows the
 * memory (detaching every older view) and moves the stream's buffer to fresh pages. */
function wasmFake() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 512 });
  const streams = new Map<
    number,
    { hash: string; hint: number; ptr: number; got: number[] }
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
      if (s.got.includes(0xee)) {
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
