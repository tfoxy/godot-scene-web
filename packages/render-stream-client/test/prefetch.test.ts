import { describe, expect, it } from "vitest";
import type { HintSelection } from "../src/core";
import type { ResourceHintRecord } from "../src/hints";
import { FakeCore, flush, harness, msg, session, tx } from "./fakes";

const hash = (n: number) => n.toString(16).padStart(64, "0");
const endpoint = {
  url: "ws://127.0.0.1:1/render-stream",
  resourceBase: "http://127.0.0.1:1",
  token: null,
  protocol: 16,
} as const;
class HintCore extends FakeCore {
  selections = new Map<string, HintSelection>();
  selectionReads = 0;
  hintSelect(h: string): HintSelection | null {
    this.selectionReads++;
    return this.selections.get(h) ?? null;
  }
}
function setup(
  options: {
    creditWindow?: 1 | 2;
    resourceHints?: boolean;
    prefetchMaxInFlight?: number;
    prefetchBudgetBytes?: number;
    resourceHoldMs?: number;
  } = {},
  core = new HintCore(),
) {
  core.enforceProvided = true;
  const { creditWindow = 2, ...pacing } = options;
  const h = harness(
    creditWindow,
    { applyOn: "frame", resourceHints: true, ...pacing },
    core,
    endpoint,
  );
  h.loop.connect();
  const t = h.last();
  t.on.open();
  t.on.message(session(creditWindow));
  function hint(n: number, priority = n, bytes = 4, selected = n) {
    const meta: ResourceHintRecord = {
      hash: hash(n),
      format: "RGBA8",
      sourceFormat: null,
      width: 4,
      height: 4,
      mipmaps: false,
      payloadBytes: bytes,
      variants: [],
      path: null,
      cause: "warm",
      priority,
    };
    core.selections.set(hash(n), {
      hash: hash(selected),
      encoding: selected === n ? "decoded" : "block",
      bytes,
    });
    t.on.message(msg({ kind: "hint", hint: meta, held: false, named: false }));
  }
  return {
    ...h,
    t,
    hint,
    paths: () => t.gets.map((g) => g.path.split("/").at(-1)),
  };
}

describe("idle hint prefetch", () => {
  it("uses priority then arrival, unhint before start, and the default two slots", () => {
    const h = setup();
    h.hint(1, 8);
    h.hint(2, 3);
    h.hint(3, 3);
    h.hint(4, 0);
    h.t.on.message(msg({ kind: "unhint", hash: hash(4) }));
    expect(h.paths()).toEqual([]);
    h.clock.frame();
    expect(h.paths()).toEqual([hash(2), hash(3)]);
    h.clock.frame();
    expect(h.paths()).toHaveLength(2);
    h.loop.dispose();
  });

  it("starts demand first and no hints until queued or in-flight demand settles", async () => {
    const h = setup();
    h.hint(1);
    h.hint(2);
    h.t.on.message(tx(1, [hash(8)]));
    h.clock.frame();
    expect(h.paths()).toEqual([hash(8)]);
    h.clock.frame();
    expect(h.paths()).toEqual([hash(8)]);
    h.t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.paths()).toEqual([hash(8), hash(1), hash(2)]);
    h.loop.dispose();
  });

  it("leaves demand a slot and starts it before another hint when a slot opens", async () => {
    const h = setup({ prefetchMaxInFlight: 3 });
    for (let n = 1; n <= 6; n++) h.hint(n);
    h.clock.frame();
    expect(h.paths()).toEqual([1, 2, 3].map(hash));
    h.t.on.message(tx(1, [hash(8), hash(9)]));
    h.clock.frame();
    expect(h.paths()).toEqual([1, 2, 3, 8].map(hash));
    h.t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.paths()).toEqual([1, 2, 3, 8, 9].map(hash));
    expect(h.t.gets.some((g) => g.aborted)).toBe(false);
    h.loop.dispose();
  });

  it("joins a hinted variant GET already in flight and supplies it before apply", async () => {
    const h = setup();
    h.hint(1, 0, 4, 7);
    h.clock.frame();
    h.t.on.message(tx(1, [hash(7)]));
    h.clock.frame();
    expect(h.paths()).toEqual([hash(7)]);
    h.t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.paths()).toEqual([hash(7)]);
    expect(h.core.calls.indexOf("provide")).toBeLessThan(
      h.core.calls.indexOf("apply 1"),
    );
    expect(h.loop.stats().hintsPrefetched).toBe(1);
    h.loop.dispose();
  });

  it("keeps verified prefetched bytes staged until a later transaction, with zero new GETs", async () => {
    const h = setup();
    h.hint(1);
    h.clock.frame();
    h.t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.isStaged(hash(1))).toBe(true);
    expect(h.core.calls).not.toContain(`take ${hash(1)}`);
    expect(h.loop.hints?.get(hash(1))?.state).toBe("fetched");
    const reads = h.core.selectionReads;
    h.clock.frame();
    expect(h.core.selectionReads).toBe(reads);
    h.t.on.message(tx(1, [hash(1)]));
    h.clock.frame();
    expect(h.paths()).toEqual([hash(1)]);
    expect(h.core.calls).toContain("apply 1");
    expect(h.loop.stats()).toMatchObject({
      hintsPrefetched: 1,
      hintPrefetchBytes: 4,
      hintPrefetchFailed: 0,
    });
    h.loop.dispose();
  });

  it("does not hold an unrelated transaction for hint GETs", () => {
    const h = setup();
    h.hint(1);
    h.clock.frame();
    h.t.on.message(tx(1));
    h.clock.frame();
    expect(h.core.calls).toContain("apply 1");
    h.loop.dispose();
  });

  it("reserves selected payload bytes in flight and stops at the connection budget", async () => {
    const h = setup({ prefetchBudgetBytes: 8 });
    h.hint(1);
    h.hint(2);
    h.hint(3);
    h.clock.frame();
    expect(h.paths()).toEqual([hash(1), hash(2)]);
    for (const g of h.t.gets) g.resolve(200);
    await flush();
    h.clock.frame();
    h.clock.frame();
    expect(h.paths()).toEqual([hash(1), hash(2)]);
    expect(h.loop.stats().hintPrefetchBytes).toBe(8);
    h.loop.dispose();
  });

  it("uses variant byte size and refuses a payload that cannot fit", () => {
    const h = setup({ prefetchBudgetBytes: 4 });
    h.hint(1, 0, 5, 7);
    h.hint(2, 1, 4, 8);
    h.clock.frame();
    expect(h.paths()).toEqual([hash(8)]);
    h.loop.dispose();
  });

  it("keeps an in-flight unhint's bytes when they arrive", async () => {
    const h = setup();
    h.hint(1);
    h.clock.frame();
    h.t.on.message(msg({ kind: "unhint", hash: hash(1) }));
    h.t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.isStaged(hash(1))).toBe(true);
    expect(h.loop.hints?.size).toBe(0);
    h.loop.dispose();
  });

  it.each([
    404, 403,
  ])("counts a hint failure %i once without aborting demand", async (status) => {
    const h = setup();
    h.hint(1);
    h.clock.frame();
    h.t.on.message(tx(1, [hash(8)]));
    h.clock.frame();
    h.t.gets[0].resolve(status);
    await flush();
    h.clock.frame();
    h.clock.frame();
    expect(h.loop.stats().hintPrefetchFailed).toBe(1);
    expect(h.t.gets[1].aborted).toBe(false);
    expect(h.paths()).toEqual([hash(1), hash(8)]);
    h.loop.dispose();
  });

  it("never starts hints while a deferred demand remains in flight", () => {
    const h = setup({ resourceHoldMs: 0 });
    h.hint(1);
    h.t.on.message(tx(1, [hash(8)]));
    h.clock.frame();
    expect(h.core.calls).toContain("apply 1");
    h.clock.frame();
    expect(h.paths()).toEqual([hash(8)]);
    h.loop.dispose();
  });

  it("counts verification failure without making invalid bytes available to demand", async () => {
    const h = setup();
    h.core.stageErrors.set(hash(1), "resource-hash: invalid body");
    h.hint(1);
    h.clock.frame();
    h.t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.isStaged(hash(1))).toBe(false);
    expect(h.loop.hints?.get(hash(1))?.state).toBe("pending");
    expect(h.loop.stats()).toMatchObject({
      hintsPrefetched: 0,
      hintPrefetchBytes: 0,
      hintPrefetchFailed: 1,
    });
    h.core.stageErrors.delete(hash(1));
    h.t.on.message(tx(1, [hash(1)]));
    h.clock.frame();
    expect(h.paths()).toEqual([hash(1), hash(1)]);
    h.t.gets[1].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("apply 1");
    h.loop.dispose();
  });

  it.each([0, 1, 99])("bounds concurrent hints with option %i", (limit) => {
    const h = setup({ prefetchMaxInFlight: limit });
    for (let n = 1; n <= 6; n++) h.hint(n);
    h.clock.frame();
    expect(h.paths()).toHaveLength(Math.min(3, limit));
    h.loop.dispose();
  });

  it("clears requests and the byte budget on reconnect, keeping lifetime counters", async () => {
    const h = setup({ prefetchBudgetBytes: 8 });
    h.hint(1);
    h.hint(2);
    h.clock.frame();
    h.t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    h.t.on.message(tx(1));
    h.clock.frame();
    h.t.on.close(1006, "gone");
    h.clock.frame();
    expect(h.loop.hints?.size).toBe(0);
    expect(h.t.gets[1].aborted).toBe(true);
    h.clock.advance(1000);
    const next = h.last();
    next.on.open();
    next.on.message(session());
    // Resend the same hash whose old request was aborted. Its reservation and attempt ended.
    const meta: ResourceHintRecord = {
      hash: hash(2),
      format: "RGBA8",
      sourceFormat: null,
      width: 4,
      height: 4,
      mipmaps: false,
      payloadBytes: 4,
      variants: [],
      path: null,
      cause: "warm",
      priority: 0,
    };
    next.on.message(
      msg({ kind: "hint", hint: meta, held: false, named: false }),
    );
    h.clock.frame();
    expect(next.gets).toHaveLength(1);
    next.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.loop.stats()).toMatchObject({
      hintsPrefetched: 2,
      hintPrefetchBytes: 8,
    });
    h.loop.dispose();
  });

  it("never starts another hint after the end record", () => {
    const h = setup({ prefetchMaxInFlight: 1 });
    h.hint(1);
    h.hint(2);
    h.clock.frame();
    h.t.on.message(msg({ kind: "end" }));
    h.clock.frame();
    expect(h.paths()).toEqual([hash(1)]);
    h.loop.dispose();
    expect(h.t.gets[0].aborted).toBe(true);
  });

  it("stages streamed hint bodies and reuses them on demand", async () => {
    class StreamingCore extends HintCore {
      writes: number[] = [];
      stageStream(h: string) {
        return {
          write: (chunk: Uint8Array) => {
            this.writes.push(chunk.length);
          },
          finish: () => this.stage(h),
          abort: () => {
            throw new Error("unexpected stream abort");
          },
        };
      }
    }
    const core = new StreamingCore();
    const h = setup({}, core);
    let requests = 0;
    h.t.fetchResource = async () => {
      requests++;
      return {
        status: 200,
        body: null,
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(1));
            c.enqueue(new Uint8Array(3));
            c.close();
          },
        }),
      };
    };
    h.hint(1);
    h.clock.frame();
    await flush();
    h.clock.frame();
    expect(core.writes).toEqual([1, 3]);
    expect(h.loop.stats().hintPrefetchBytes).toBe(4);
    h.t.on.message(tx(1, [hash(1)]));
    h.clock.frame();
    expect(requests).toBe(1);
    expect(core.calls).toContain("apply 1");
    h.loop.dispose();
  });

  it("keeps a joined demand GET through window-one supersession", async () => {
    const h = setup({ creditWindow: 1 });
    h.hint(1);
    h.clock.frame();
    h.t.on.message(tx(1, [hash(1)]));
    h.clock.frame();
    h.core.rebuildNeeded = [{ hash: hash(1), kind: 0 }];
    h.t.on.message(tx(2, [hash(1)]));
    h.clock.frame();
    expect(h.paths()).toEqual([hash(1)]);
    expect(h.t.gets[0].aborted).toBe(false);
    h.t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("apply 2");
    h.loop.dispose();
  });

  it.each([
    1, 2,
  ] as const)("does not let an old joined demand failure suppress a new naming (window %i)", async (creditWindow) => {
    const h = setup({ resourceHoldMs: 10000, creditWindow });
    h.hint(1);
    h.clock.frame();
    h.t.on.message(tx(1, [hash(1)]));
    h.clock.frame();
    h.core.unnamed.add(hash(1));
    h.t.on.message(tx(2));
    h.core.unnamed.delete(hash(1));
    h.core.rebuildNeeded = [{ hash: hash(1), kind: 0 }];
    h.t.on.message(tx(3, [hash(1)]));
    h.t.gets[0].resolve(503);
    await flush();
    h.clock.frame();
    h.clock.frame();
    expect(h.paths()).toEqual([hash(1), hash(1)]);
    h.t.gets[1].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("apply 3");
    h.loop.dispose();
  });

  it("retries a hinted variant at 250/500/1000 ms, reserving its bytes once", async () => {
    const h = setup({ prefetchBudgetBytes: 4 });
    h.hint(1, 0, 4, 7);
    h.hint(2);
    h.clock.frame();
    for (const [i, delay] of [250, 500, 1000].entries()) {
      const at = h.clock.t;
      h.t.gets[i].resolve(503);
      await flush();
      h.clock.t = at + delay - 16.7;
      h.clock.frame();
      expect(h.paths()).toEqual(Array(i + 2).fill(hash(7)));
      expect(h.loop.stats().hintPrefetchFailed).toBe(0);
    }
    h.t.gets[3].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.loop.stats()).toMatchObject({
      getRetries: 3,
      hintsPrefetched: 1,
      hintPrefetchBytes: 4,
    });
    expect(h.loop.hints?.get(hash(1))?.state).toBe("fetched");
    h.t.on.message(tx(1, [hash(7)]));
    h.clock.frame();
    expect(h.paths()).toHaveLength(4);
    expect(h.core.calls).toContain("apply 1");
    h.loop.dispose();
  });

  it("counts an exhausted hint failure once and releases its byte reservation", async () => {
    const h = setup({ prefetchBudgetBytes: 4 });
    h.hint(1);
    h.hint(2);
    h.clock.frame();
    for (const [i, delay] of [250, 500, 1000].entries()) {
      const at = h.clock.t;
      h.t.gets[i].resolve(503);
      await flush();
      h.clock.t = at + delay - 16.7;
      h.clock.frame();
    }
    h.t.gets[3].resolve(503);
    await flush();
    h.clock.frame();
    expect(h.paths()).toEqual([1, 1, 1, 1, 2].map(hash));
    expect(h.loop.stats()).toMatchObject({
      getRetries: 3,
      hintPrefetchFailed: 1,
    });
    h.loop.dispose();
  });

  it("does not retry after unhint during backoff, or after connection end", async () => {
    const h = setup();
    h.hint(1);
    h.hint(2);
    h.clock.frame();
    h.t.gets[0].resolve(503);
    h.t.gets[1].resolve(503);
    await flush();
    h.t.on.message(msg({ kind: "unhint", hash: hash(1) }));
    h.clock.frame();
    h.t.on.message(msg({ kind: "end" }));
    h.clock.t += 2000;
    h.clock.frame();
    expect(h.paths()).toEqual([hash(1), hash(2)]);
    expect(h.loop.stats().getRetries).toBe(0);
    h.loop.dispose();
  });

  it("keeps hint retries idle behind demand and joins a waiting hinted retry", async () => {
    const h = setup({ resourceHoldMs: 10000 });
    h.hint(1);
    h.hint(2);
    h.clock.frame();
    const at = h.clock.t;
    h.t.gets[0].resolve(503);
    h.t.gets[1].resolve(503);
    await flush();
    h.t.on.message(tx(1, [hash(8)]));
    h.clock.t = at + 250 - 16.7;
    h.clock.frame();
    expect(h.paths()).toEqual([1, 2, 8].map(hash));
    h.t.on.message(tx(2, [hash(1), hash(8)]));
    h.clock.frame();
    expect(h.paths()).toEqual([1, 2, 8, 1].map(hash));
    h.t.gets[2].resolve(200);
    h.t.gets[3].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("apply 2");
    h.clock.frame();
    expect(h.paths()).toEqual([1, 2, 8, 1, 2].map(hash));
    expect(h.loop.stats().getRetries).toBe(2);
    h.loop.dispose();
  });

  it("continues a joined demand retry after unhint", async () => {
    const h = setup({ resourceHoldMs: 10000 });
    h.hint(1);
    h.clock.frame();
    h.t.on.message(tx(1, [hash(1)]));
    h.clock.frame();
    const at = h.clock.t;
    h.t.gets[0].resolve(503);
    await flush();
    h.t.on.message(msg({ kind: "unhint", hash: hash(1) }));
    h.clock.t = at + 250 - 16.7;
    h.clock.frame();
    expect(h.paths()).toEqual([hash(1), hash(1)]);
    h.t.gets[1].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("apply 1");
    h.loop.dispose();
  });

  it("orders due hint retries by hint priority rather than failure completion", async () => {
    const h = setup();
    h.hint(1);
    h.hint(2);
    h.clock.frame();
    const at = h.clock.t;
    h.t.gets[1].resolve(503);
    h.t.gets[0].resolve(503);
    await flush();
    h.clock.t = at + 250 - 16.7;
    h.clock.frame();
    expect(h.paths()).toEqual([1, 2, 1, 2].map(hash));
    h.loop.dispose();
  });

  it("continues hinted retries after a joined demand leaves the accepted names", async () => {
    const h = setup();
    h.hint(1);
    h.clock.frame();
    h.t.on.message(tx(1, [hash(1)]));
    h.clock.frame();
    h.core.unnamed.add(hash(1));
    h.t.on.message(tx(2));
    h.clock.frame();
    const at = h.clock.t;
    h.t.gets[0].resolve(503);
    await flush();
    h.clock.t = at + 250 - 16.7;
    h.clock.frame();
    expect(h.paths()).toEqual([hash(1), hash(1)]);
    h.t.gets[1].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.isStaged(hash(1))).toBe(true);
    expect(h.loop.stats().hintPrefetchFailed).toBe(0);
    h.loop.dispose();
  });

  it("keeps a folded joined hint retry ahead of idle work while still named", async () => {
    const h = setup({ resourceHoldMs: 10000 });
    h.hint(1);
    h.clock.frame();
    h.t.on.message(tx(1, [hash(1)]));
    h.clock.frame();
    h.t.on.message(tx(2, [hash(8)]));
    h.clock.frame();
    const at = h.clock.t;
    h.t.gets[0].resolve(503);
    h.t.gets[1].resolve(200);
    await flush();
    h.clock.t = at + 250 - 16.7;
    h.clock.frame();
    expect(h.paths()).toEqual([1, 8, 1].map(hash));
    h.t.gets[2].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("apply 2");
    h.loop.dispose();
  });

  it("keeps hints inert on an older wasm without hint selection", () => {
    const core = new FakeCore();
    const h = harness(2, { resourceHints: true }, core, endpoint);
    h.loop.connect();
    const t = h.last();
    t.on.open();
    t.on.message(session());
    const source = setup();
    source.hint(1);
    const entry = source.loop.hints?.get(hash(1));
    if (!entry) throw new Error("missing fixture");
    t.on.message(
      msg({ kind: "hint", hint: entry.meta, held: false, named: false }),
    );
    h.clock.frame();
    expect(t.gets).toEqual([]);
    h.loop.dispose();
    source.loop.dispose();
  });

  it("leaves the disabled client's GETs, stats and hello byte-for-byte unchanged", () => {
    const off = setup({ resourceHints: false });
    const plain = harness(2, { applyOn: "frame" }, new FakeCore(), endpoint);
    plain.loop.connect();
    plain.last().on.open();
    plain.last().on.message(session());
    off.hint(1);
    off.clock.frame();
    plain.clock.frame();
    expect(off.paths()).toEqual([]);
    expect(off.loop.stats()).toEqual(plain.loop.stats());
    expect(off.t.texts).toEqual(plain.last().texts);
    off.loop.dispose();
    plain.loop.dispose();
  });
});
