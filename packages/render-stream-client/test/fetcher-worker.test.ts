import { afterEach, describe, expect, it, vi } from "vitest";
import type { StagingStream } from "../src/core";
import {
  LiveFetcher,
  type LiveFetcherOptions,
  type ResourceResponse,
} from "../src/fetcher";

const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function setup(
  options: LiveFetcherOptions = {},
  onBody: ConstructorParameters<typeof LiveFetcher>[4] = null,
) {
  const gets: {
    hash: string;
    signal: AbortSignal;
    resolve: (r: ResourceResponse) => void;
    reject: (e: Error) => void;
  }[] = [];
  const tasks: (() => void)[] = [];
  const writes: { hash: string; data: number[] }[] = [];
  const finished: string[] = [];
  const aborted: string[] = [];
  const f = new LiveFetcher(
    (path, signal) =>
      new Promise((resolve, reject) => {
        gets.push({ hash: path.slice(3), signal, resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    "/r/",
    100,
    0,
    onBody,
    {
      maxInFlight: 4,
      failures: "settle",
      yieldTask: () => new Promise((resolve) => tasks.push(resolve)),
      stager: (hash): StagingStream => ({
        write: (chunk) => {
          writes.push({ hash, data: [...chunk] });
        },
        finish: () => {
          finished.push(hash);
          return null;
        },
        abort: () => {
          aborted.push(hash);
        },
      }),
      ...options,
    },
  );
  const complete = (hash: string, n = 4, status = 200) => {
    const get = [...gets].reverse().find((g) => g.hash === hash);
    if (!get) throw new Error(`no GET for ${hash}`);
    get.resolve({ ...workerBody(n, status) });
  };
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      await tick();
      if (!tasks.length) return;
      tasks.shift()?.();
    }
    throw new Error("staging did not drain");
  };
  return { f, gets, tasks, writes, finished, aborted, complete, drain };
}

function workerBody(n = 4, status = 200): ResourceResponse {
  return {
    status,
    body: new Uint8Array(n).fill(7).buffer,
    sizeHint: n,
    workerBody: true,
  };
}

afterEach(() => vi.useRealTimers());

describe("worker wire slots and staging backlog", () => {
  it("keeps refilling four wire slots without polling or a buffered body count limit", async () => {
    const { f, gets, writes, complete, drain } = setup();
    const hashes = Array.from({ length: 14 }, (_, i) => String(i));
    f.start(hashes);
    f.poll();
    expect(gets).toHaveLength(4);
    for (const h of hashes.slice(0, 4)) {
      complete(h);
      await tick();
    }
    expect(gets.map((g) => g.hash)).toEqual(hashes.slice(0, 8));
    expect(f.inFlightCount()).toBe(4);
    expect(writes).toEqual([]);
    for (const h of hashes.slice(4)) {
      complete(h);
      await tick();
      expect(f.inFlightCount()).toBeLessThanOrEqual(4);
    }
    expect(gets.map((g) => g.hash)).toEqual(hashes);
    expect(f.inFlightCount()).toBe(0);
    expect(f.poll().results).toEqual([]);
    expect(f.busy()).toBe(true);
    expect(f.active("0")).toBe(true);
    await drain();
    expect(gets.map((g) => g.hash)).toEqual(hashes);
    expect(f.poll().results.map((r) => r.hash)).toEqual(hashes);
    expect(f.poll().finished).toBe(true);
  });

  it("resumes one GET as soon as one staging body drains", async () => {
    const { f, gets, complete, tasks, drain } = setup({
      maxInFlight: 1,
      sliceBytes: 32 << 20,
      stager: () => ({ write() {}, finish: () => null, abort() {} }),
    });
    f.start(["big", "next"]);
    f.poll();
    complete("big", 64 << 20);
    await tick();
    expect(gets).toHaveLength(1);
    tasks.shift()?.();
    await tick(); // first slice only
    expect(gets).toHaveLength(1);
    tasks.shift()?.();
    await tick(); // first body's final slice
    expect(gets).toHaveLength(2);
    f.abort();
    await drain();
  });

  it.each([
    32 << 20,
    65 << 20,
  ])("stops starts at the byte threshold with %s-byte bodies, and drains an oversized body", async (size) => {
    const { f, gets, complete, drain, finished } = setup({
      sliceBytes: 64 << 20,
      stager: () => ({ write() {}, finish: () => null, abort() {} }),
    });
    f.start(["a", "b", "c", "d", "e", "f", "g", "h"]);
    f.poll();
    complete("a", size);
    await tick();
    expect(gets).toHaveLength(size >= 64 << 20 ? 4 : 5);
    if (size < 64 << 20) {
      complete("b", size);
      await tick();
    }
    const count = gets.length;
    f.poll();
    expect(gets).toHaveLength(count);
    await drain();
    expect(gets.length).toBeGreaterThan(count);
    expect(f.poll().results[0]).toMatchObject({
      hash: "a",
      bytes: size,
      streamed: true,
    });
    expect(finished).toEqual([]);
    f.abort();
  });

  it("stages a lone oversized body without deadlock", async () => {
    const { f, gets, complete, drain } = setup({
      maxInFlight: 1,
      sliceBytes: 64 << 20,
      stager: () => ({ write() {}, finish: () => null, abort() {} }),
    });
    f.start(["big", "next"]);
    f.poll();
    complete("big", 65 << 20);
    await tick();
    expect(gets).toHaveLength(1);
    await drain();
    expect(gets).toHaveLength(2);
    complete("next");
    await drain();
    expect(f.poll()).toMatchObject({
      results: [{ hash: "big" }, { hash: "next" }],
      finished: true,
    });
  });

  it("slices ready worker bodies in demand issue order and polls staging completions in that order", async () => {
    const onBody = vi.fn();
    const { f, writes, complete, drain } = setup({ sliceBytes: 3 }, onBody);
    f.start(["a", "b", "c"]);
    f.poll();
    complete("b", 7);
    complete("c", 4);
    complete("a", 1);
    await drain();
    expect(writes.map((w) => [w.hash, w.data.length])).toEqual([
      ["a", 1],
      ["b", 3],
      ["b", 3],
      ["b", 1],
      ["c", 3],
      ["c", 1],
    ]);
    expect(onBody).not.toHaveBeenCalled();
    const p = f.poll();
    expect(
      p.results.map((r) => [r.hash, r.data, r.streamed, r.stage_error]),
    ).toEqual([
      ["a", null, true, null],
      ["b", null, true, null],
      ["c", null, true, null],
    ]);
    expect(p.finished).toBe(true);
  });

  it("releases unwanted waiting bodies and starts replacement GETs before staging", async () => {
    const wanted = new Set(Array.from({ length: 9 }, (_, i) => String(i)));
    const { f, gets, writes, complete, drain } = setup({
      wanted: (hash) => wanted.has(hash),
    });
    f.start([...wanted]);
    f.poll();
    complete("0", 64 << 20);
    await tick();
    expect(gets).toHaveLength(4);
    wanted.delete("0");
    f.poll();
    expect(gets).toHaveLength(5);
    expect(f.active("0")).toBe(false);
    await drain();
    expect(writes.some((w) => w.hash === "0")).toBe(false);
    f.abort();
  });

  it("stages ready demand before earlier hints without waiting for outstanding demand", async () => {
    const { f, complete, drain, finished } = setup();
    expect(f.prefetch("hint")).toBe(true);
    f.extend(["slow", "a", "b"]);
    f.poll();
    complete("hint");
    complete("b");
    complete("a");
    await drain();
    expect(finished).toEqual(["a", "b", "hint"]);
    expect(f.poll().results.map((r) => r.hash)).toEqual(finished);
    complete("slow");
    await drain();
    expect(f.poll()).toMatchObject({
      results: [{ hash: "slow" }],
      finished: true,
    });
  });

  it("does not preempt a sliced body when earlier demand becomes ready", async () => {
    const { f, complete, tasks, drain, writes } = setup({ sliceBytes: 2 });
    f.start(["a", "b"]);
    f.poll();
    complete("b", 4);
    await tick();
    tasks.shift()?.();
    await tick();
    complete("a", 1);
    await drain();
    expect(writes.map((w) => w.hash)).toEqual(["b", "b", "a"]);
    expect(f.poll().results.map((r) => r.hash)).toEqual(["b", "a"]);
  });

  it("drops an unwanted body on arrival without consuming a backlog place", async () => {
    const { f, gets, complete, drain, writes } = setup({ wanted: () => false });
    f.start(["a", "b", "c", "d", "e"]);
    f.poll();
    complete("a", 65 << 20);
    await tick();
    expect(gets).toHaveLength(5);
    await drain();
    expect(writes).toEqual([]);
    expect(f.poll().results).toMatchObject([
      { hash: "a", discarded: true, data: null },
    ]);
    f.abort();
  });

  it("stops the wire stall timer while a complete body waits for staging", async () => {
    vi.useFakeTimers();
    const { f, gets, complete, drain } = setup();
    f.start(["a"]);
    f.poll();
    complete("a");
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(gets[0].signal.aborted).toBe(false);
    await drain();
    expect(f.poll().results[0].outcome).toBe("ok");
  });

  it("drops waiting bodies on cancel and aborts a sliced staging buffer", async () => {
    const { f, complete, tasks, drain, aborted, writes } = setup({
      sliceBytes: 2,
    });
    f.start(["a", "b"]);
    f.poll();
    complete("a", 6);
    complete("b");
    await tick();
    tasks.shift()?.();
    await tick();
    expect(writes).toHaveLength(1);
    f.cancel();
    f.start(["c"]);
    f.poll();
    complete("c", 1);
    await drain();
    expect(aborted).toEqual(["a"]);
    expect(writes.map((w) => w.hash)).toEqual(["a", "c"]);
    expect(f.poll().results.map((r) => r.hash)).toEqual(["c"]);
  });

  it("cancel releases buffered bodies and their byte reservation", async () => {
    const { f, gets, complete, drain, writes } = setup();
    f.start(["old-a", "old-b", "old-c", "old-d"]);
    f.poll();
    complete("old-a", 65 << 20);
    await tick();
    f.cancel({ keepRetries: true });
    const next = Array.from({ length: 8 }, (_, i) => `new-${i}`);
    f.start(next);
    f.poll();
    expect(f.inFlightCount()).toBe(4);
    for (const h of next.slice(0, 4)) {
      complete(h);
      await tick();
    }
    expect(gets.map((g) => g.hash).slice(4)).toEqual(next);
    expect([...f.requested()].some((h) => h.startsWith("old-"))).toBe(false);
    await drain();
    expect(writes.some((w) => w.hash.startsWith("old-"))).toBe(false);
    expect(f.poll().results.map((r) => r.hash)).toEqual(next.slice(0, 4));
    f.abort();
  });

  it("fatal failure discards waiting bodies and aborts other GETs", async () => {
    const { f, gets, complete, drain, writes } = setup();
    f.start(["a", "b", "c", "d", "e"]);
    f.poll();
    complete("a");
    await tick();
    complete("b", 0, 401);
    await tick();
    expect(gets.find((g) => g.hash === "c")?.signal.aborted).toBe(true);
    await drain();
    expect(writes).toEqual([]);
    expect(f.poll()).toMatchObject({
      results: [{ hash: "b", outcome: "fatal" }],
      finished: true,
    });
  });

  it("settles missing separately and retries temporary replies with the existing bound", async () => {
    let now = 0;
    const retried = vi.fn();
    const { f, gets, complete, drain } = setup({
      maxInFlight: 1,
      retry: { now: () => now, mode: () => "demand", onRetry: retried },
    });
    f.start(["a", "b", "c"]);
    f.poll();
    complete("a", 0, 404);
    await tick();
    expect(gets.map((g) => g.hash)).toEqual(["a", "b"]);
    complete("b", 0, 500);
    await tick();
    expect(gets.map((g) => g.hash)).toEqual(["a", "b", "c"]);
    complete("c");
    await drain();
    expect(f.poll().results.map((r) => [r.hash, r.outcome])).toEqual([
      ["a", "missing"],
      ["c", "ok"],
    ]);
    for (const delay of [250, 500, 1000]) {
      now += delay;
      f.poll();
      complete("b", 0, 500);
      await tick();
    }
    expect(retried).toHaveBeenCalledTimes(3);
    expect(f.poll()).toMatchObject({
      results: [{ hash: "b", outcome: "temporary" }],
      finished: true,
    });
  });

  it("prefetch shares both wire slots and backlog capacity with demand", async () => {
    const { f, gets, complete, drain } = setup({
      maxInFlight: 1,
      sliceBytes: 64 << 20,
      stager: () => ({ write() {}, finish: () => null, abort() {} }),
    });
    expect(f.prefetch("hint")).toBe(true);
    f.extend(["demand"]);
    complete("hint", 65 << 20);
    await tick();
    expect(gets).toHaveLength(1);
    expect(f.prefetch("other-hint")).toBe(false);
    await drain();
    expect(gets.map((g) => g.hash)).toEqual(["hint", "demand"]);
    complete("demand");
    await drain();
    f.poll();
    expect(f.prefetch("other-hint")).toBe(true);
    f.abort();
  });

  it("holds the backlog reservation until an async whole-body consumer finishes", async () => {
    let finish!: () => void;
    const onBody = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { f, gets, complete, tasks } = setup(
      { stager: null, maxInFlight: 1 },
      onBody,
    );
    f.start(["a", "b"]);
    f.poll();
    complete("a", 65 << 20);
    await tick();
    tasks.shift()?.();
    await tick();
    expect(onBody).toHaveBeenCalledTimes(1);
    expect(gets).toHaveLength(1);
    finish();
    await tick();
    expect(gets).toHaveLength(2);
    expect(f.poll().results[0].hash).toBe("a");
    f.abort();
  });
});
