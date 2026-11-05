import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreLoadError, loadCore, sha256Chunked } from "../src/loader";
import { Sha256, sha256 } from "../src/sha256";
import {
  after,
  BUILD,
  freshCore,
  hex,
  type Steps,
  scriptedEnv,
  split,
  stall,
  streamOf,
  WASM,
} from "./loader-env";

const MS = 1000;

/** A load whose outcome a test reads without awaiting it. */
function start(
  env: ReturnType<typeof scriptedEnv>["env"],
  core = freshCore(),
  signal?: AbortSignal,
) {
  const out: { value?: unknown; error?: unknown } = {};
  const p = loadCore(core, { timeoutMs: MS, signal, env }).then(
    (v) => {
      out.value = v;
    },
    (e: unknown) => {
      out.error = e;
    },
  );
  return { out, p };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("loadCore deadline", () => {
  it.each<[string, Partial<Steps>]>([
    ["build fetch", { build: stall }],
    ["wasm fetch", { wasm: stall }],
    ["wasm hash", { digest: stall }],
    ["wasm compile", { compile: stall }],
    ["glue import", { glue: stall }],
    ["core init", { init: stall }],
    ["wasm fetch + glue import", { wasm: stall, glue: stall }],
  ])("a stalled %s fails at the deadline, naming it", async (step, over) => {
    const { env, fetches, counts } = scriptedEnv(over);
    const { out } = start(env);
    await vi.advanceTimersByTimeAsync(MS - 1);
    expect(out).toEqual({});
    await vi.advanceTimersByTimeAsync(1);
    expect(out.error).toBeInstanceOf(CoreLoadError);
    expect((out.error as Error).message).toBe(
      `timeout after ${MS} ms in ${step}`,
    );
    // The fetch in flight is aborted (a finished one has nothing to abort).
    if (step.includes("fetch"))
      expect(fetches.at(-1)?.signal?.aborted).toBe(true);
    if (step !== "core init") expect(counts.glues).toBe(0);
  });

  it("a timeout in the hash aborts the hash (the pure-JS one stops at its next chunk)", async () => {
    let hashSignal: AbortSignal | null = null;
    const s = scriptedEnv({
      digest: (_b, signal) => {
        hashSignal = signal;
        return stall();
      },
    });
    start(s.env);
    await vi.advanceTimersByTimeAsync(MS - 1);
    expect((hashSignal as AbortSignal | null)?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((hashSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  it("a load that ends just inside the deadline resolves", async () => {
    // build 200 + wasm 200 + hash 200 + compile 200 + init 199 = 999 ms; the glue (300) in parallel.
    const s = scriptedEnv({
      build: () => after(200, BUILD),
      wasm: () => after(200, WASM),
      digest: (b) => after(200, sha256(b)),
      compile: () => after(200, {} as WebAssembly.Module),
      glue: () => after(300, s.glueModule),
      init: () =>
        after(199, { memory: new WebAssembly.Memory({ initial: 1 }) }),
    });
    const { out } = start(s.env);
    await vi.advanceTimersByTimeAsync(MS - 1);
    expect(out.error).toBeUndefined();
    expect(out.value).toMatchObject({ build: BUILD });
    expect(s.counts.glues).toBe(1);
    // The deadline is cleared: nothing fires after it.
    await vi.advanceTimersByTimeAsync(MS);
    expect(out.error).toBeUndefined();
  });

  it("a compile or import that resolves after the timeout installs nothing", async () => {
    let compile: (m: WebAssembly.Module) => void = () => {};
    let glue: (m: unknown) => void = () => {};
    const s = scriptedEnv({
      compile: () => new Promise((r) => (compile = r)),
      glue: () => new Promise((r) => (glue = r)),
    });
    const { out } = start(s.env);
    await vi.advanceTimersByTimeAsync(MS);
    expect((out.error as Error).message).toBe(
      `timeout after ${MS} ms in wasm compile + glue import`,
    );
    compile({} as WebAssembly.Module);
    glue(s.glueModule);
    await vi.advanceTimersByTimeAsync(MS);
    expect(s.counts).toEqual({ glues: 0, cores: 0 });
    expect(out.value).toBeUndefined();
  });
});

describe("loadCore abort", () => {
  it("an aborted load rejects at once and aborts its fetch", async () => {
    const s = scriptedEnv({ wasm: stall });
    const ac = new AbortController();
    const { out } = start(s.env, freshCore(), ac.signal);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect((out.error as Error).message).toBe("aborted");
    expect(s.fetches.at(-1)?.signal?.aborted).toBe(true);
    // Its deadline is cleared too: no second outcome.
    await vi.advanceTimersByTimeAsync(MS);
    expect((out.error as Error).message).toBe("aborted");
  });

  it("an already-aborted signal fetches nothing", async () => {
    const s = scriptedEnv();
    const ac = new AbortController();
    ac.abort();
    const { out } = start(s.env, freshCore(), ac.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect((out.error as Error).message).toBe("aborted");
    expect(s.counts.glues).toBe(0);
  });

  it("one load giving up keeps the shared wasm fetch of another; the last one aborts it", async () => {
    let deliver: (b: ArrayBuffer) => void = () => {};
    const s = scriptedEnv({ wasm: () => new Promise((r) => (deliver = r)) });
    const core = freshCore();
    const a = new AbortController();
    const first = start(s.env, core, a.signal);
    const second = start(s.env, core);
    await vi.advanceTimersByTimeAsync(10);
    const wasmFetches = () => s.fetches.filter((f) => f.url.endsWith(".wasm"));
    expect(wasmFetches()).toHaveLength(1);
    a.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect((first.out.error as Error).message).toBe("aborted");
    expect(wasmFetches()[0].signal?.aborted).toBe(false);
    deliver(WASM);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.out.error).toBeUndefined();
    expect(second.out.value).toBeDefined();
    expect(wasmFetches()).toHaveLength(1);

    // Two loads of another core both give up: the fetch is aborted, and a third starts afresh.
    const other = freshCore();
    const x = new AbortController();
    const y = new AbortController();
    start(s.env, other, x.signal);
    start(s.env, other, y.signal);
    await vi.advanceTimersByTimeAsync(10);
    const shared = wasmFetches()[1];
    x.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(shared.signal?.aborted).toBe(false);
    y.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(shared.signal?.aborted).toBe(true);
    start(s.env, other);
    await vi.advanceTimersByTimeAsync(10);
    expect(wasmFetches()).toHaveLength(3);
  });
});

describe("sha256Chunked", () => {
  const data = new Uint8Array(1024 * 1024 + 77).map((_, i) => (i * 31) & 0xff);

  it("matches the one-shot hash, a chunk per task", async () => {
    const p = sha256Chunked(data.buffer, new AbortController().signal);
    await vi.runAllTimersAsync();
    expect(await p).toEqual(sha256(data));
  });

  it("stops at the next chunk once aborted", async () => {
    const update = vi.spyOn(Sha256.prototype, "update");
    const ac = new AbortController();
    const p = sha256Chunked(data.buffer, ac.signal);
    const caught = p.catch((e: unknown) => e);
    expect(update).toHaveBeenCalledTimes(1);
    ac.abort(new CoreLoadError("aborted"));
    await vi.runAllTimersAsync();
    expect(((await caught) as Error).message).toBe("aborted");
    expect(update).toHaveBeenCalledTimes(1);
    update.mockRestore();
  });
});

describe("loadCore without crypto.subtle: the hash runs while the wasm downloads", () => {
  const wasmOf = (n: number) =>
    new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
  const A = new Uint8Array(WASM);

  /** A scripted env serving `bytes`, whose build.json names them. */
  function serving(bytes: Uint8Array, over: Partial<Steps> = {}) {
    const build = {
      ...BUILD,
      wasm_sha256: hex(sha256(bytes)),
      wasm_bytes: bytes.length,
    };
    return scriptedEnv({
      subtle: false,
      build: async () => build,
      wasm: async () => bytes.buffer as ArrayBuffer,
      ...over,
    });
  }

  async function settle(out: { value?: unknown; error?: unknown }) {
    for (let i = 0; i < 100 && !out.value && !out.error; i++)
      await vi.advanceTimersByTimeAsync(1);
  }

  it.each([
    [5000, 1],
    [5000, 3],
    [70001, 7],
    [70001, 1000],
    [600 * 1024 + 13, 100 * 1024 + 3],
    [600 * 1024 + 13, 600 * 1024 + 13],
  ])("a %i-byte wasm in %i-byte chunks hashes equal to sha256()", async (size, chunk) => {
    const bytes = wasmOf(size);
    const s = serving(bytes, {
      body: () => streamOf(split(bytes, chunk)).stream,
      digest: stall, // the subtle path is not taken
    });
    const update = vi.spyOn(Sha256.prototype, "update");
    const { out } = start(s.env);
    await settle(out);
    expect(out.error).toBeUndefined();
    expect(out.value).toBeDefined();
    const calls = update.mock.calls.map(([d]) => (d as Uint8Array).length);
    expect(Math.max(...calls)).toBeLessThanOrEqual(256 * 1024);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(size);
    update.mockRestore();
  });

  it("a chunk over 256 KiB is hashed in pieces with a task between them, and an abort stops it", async () => {
    const bytes = wasmOf(600 * 1024);
    const ac = new AbortController();
    const s = serving(bytes, { body: () => streamOf([bytes]).stream });
    const real = Sha256.prototype.update;
    const update = vi
      .spyOn(Sha256.prototype, "update")
      .mockImplementation(function (this: Sha256, d) {
        const r = real.call(this, d);
        ac.abort();
        return r;
      });
    const { out } = start(s.env, freshCore(), ac.signal);
    await vi.advanceTimersByTimeAsync(50);
    expect((out.error as Error).message).toBe("aborted");
    expect(update).toHaveBeenCalledTimes(1);
    update.mockRestore();
  });

  it("a body that delivers part of the wasm and stalls is a timeout in wasm fetch, reader cancelled", async () => {
    const b = streamOf([A.slice(0, 4)], "stall");
    const compile = vi.fn(async () => ({}) as WebAssembly.Module);
    const s = scriptedEnv({ subtle: false, body: () => b.stream, compile });
    const { out } = start(s.env);
    await vi.advanceTimersByTimeAsync(MS - 1);
    expect(out).toEqual({});
    expect(b.cancelled.value).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((out.error as Error).message).toBe(
      `timeout after ${MS} ms in wasm fetch`,
    );
    expect(b.cancelled.value).toBe(true);
    expect(compile).not.toHaveBeenCalled();
    expect(s.counts.glues).toBe(0);
  });

  it("a dispose mid-body rejects at once and cancels the reader", async () => {
    const b = streamOf([A.slice(0, 4)], "stall");
    const s = scriptedEnv({ subtle: false, body: () => b.stream });
    const ac = new AbortController();
    const { out } = start(s.env, freshCore(), ac.signal);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect((out.error as Error).message).toBe("aborted");
    expect(b.cancelled.value).toBe(true);
  });

  it("a body longer than wasm_bytes is stale core at once, naming both sizes, reader cancelled", async () => {
    const b = streamOf([A.slice(0, 5), new Uint8Array(9)], "stall");
    const compile = vi.fn(async () => ({}) as WebAssembly.Module);
    const s = scriptedEnv({ subtle: false, body: () => b.stream, compile });
    const { out } = start(s.env);
    await vi.advanceTimersByTimeAsync(10);
    expect((out.error as Error).message).toBe(
      "stale core: " +
        (s.fetches.at(-1)?.url ?? "") +
        " sent more than the 8 bytes its build.json names (wasm_bytes), at least 14",
    );
    expect(b.cancelled.value).toBe(true);
    expect(compile).not.toHaveBeenCalled();
  });

  it("a body that ends short of wasm_bytes is stale core, naming both sizes", async () => {
    const b = streamOf([A.slice(0, 5)]);
    const s = scriptedEnv({ subtle: false, body: () => b.stream });
    const { out } = start(s.env);
    await vi.advanceTimersByTimeAsync(10);
    expect((out.error as Error).message).toBe(
      "stale core: " +
        (s.fetches.at(-1)?.url ?? "") +
        " ended after 5 of the 8 bytes its build.json names (wasm_bytes)",
    );
  });

  it("a right-sized body of the wrong content is a sha mismatch", async () => {
    const s = scriptedEnv({
      subtle: false,
      body: () => streamOf([new Uint8Array(8)]).stream,
    });
    const { out } = start(s.env);
    await vi.advanceTimersByTimeAsync(10);
    expect((out.error as Error).message).toMatch(/^stale core: .* has sha256 /);
  });

  it("a response without a body, or a build.json without wasm_bytes, takes the buffered path", async () => {
    const digest = vi.fn(async (b: ArrayBuffer) => sha256(b));
    const noBody = scriptedEnv({ subtle: false, body: () => null, digest });
    const first = start(noBody.env);
    await settle(first.out);
    expect(first.out.error).toBeUndefined();
    expect(digest).toHaveBeenCalledTimes(1);

    const noSize = scriptedEnv({
      subtle: false,
      build: async () => ({ ...BUILD, wasm_bytes: undefined }) as never,
      digest,
    });
    const second = start(noSize.env);
    await settle(second.out);
    expect(second.out.error).toBeUndefined();
    expect(digest).toHaveBeenCalledTimes(2);
  });

  it("a page with crypto.subtle never reads the body", async () => {
    const b = streamOf([A]);
    const s = scriptedEnv({ body: () => b.stream });
    const { out } = start(s.env);
    await settle(out);
    expect(out.error).toBeUndefined();
    expect(b.stream.locked).toBe(false);
  });
});
