import { afterEach, describe, expect, it, vi } from "vitest";
import type { HintSelection } from "../src/core";
import type { ResourceHintRecord } from "../src/hints";
import { ENDPOINT, FakeCore, harness, msg, session, tx } from "./fakes";

const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

class WorkerCore extends FakeCore {
  stageStream(hash: string) {
    return {
      write() {},
      finish: () => this.stage(hash),
      abort: () => this.calls.push(`abort ${hash}`),
    };
  }
  hintSelect(hash: string): HintSelection {
    return { hash, encoding: "decoded", bytes: 4 };
  }
}

function setup(resourceHints = false) {
  const tasks: (() => void)[] = [];
  vi.stubGlobal("scheduler", {
    yield: () => new Promise<void>((resolve) => tasks.push(resolve)),
  });
  const h = harness(2, { applyOn: "frame", resourceHints }, new WorkerCore(), {
    ...ENDPOINT,
    protocol: 16,
  });
  h.loop.connect();
  const t = h.last();
  t.on.open();
  t.on.message(session(2));
  const gets: { hash: string; resolve: () => void }[] = [];
  t.fetchResource = (path) =>
    new Promise((resolve) => {
      gets.push({
        hash: path.split("/").at(-1) as string,
        resolve: () =>
          resolve({ status: 200, body: new ArrayBuffer(4), workerBody: true }),
      });
    });
  const complete = (hash: string) => {
    const g = [...gets].reverse().find((g) => g.hash === hash);
    if (!g) throw new Error(`no GET for ${hash}`);
    g.resolve();
  };
  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      await tick();
      if (!tasks.length) return;
      tasks.shift()?.();
    }
    throw new Error("staging did not drain");
  };
  return { ...h, t, tasks, gets, complete, drain };
}

afterEach(() => vi.unstubAllGlobals());

describe("StreamLoop buffered worker resources", () => {
  it("refills four wire slots before any frame or staging task runs", async () => {
    const h = setup();
    const hashes = Array.from({ length: 9 }, (_, i) => String(i));
    h.t.on.message(tx(1, hashes));
    h.clock.frame();
    for (const hash of hashes.slice(0, 4)) {
      h.complete(hash);
      await tick();
    }
    expect(h.gets.map((g) => g.hash)).toEqual(hashes.slice(0, 8));
    expect(h.core.calls.some((c) => c.startsWith("stage "))).toBe(false);
    await h.drain();
    h.clock.frame();
    expect(h.core.calls).toContain("take 0");
    h.loop.dispose();
  });

  it("releases an obsolete waiting body and fetches it again after reintroduction", async () => {
    const h = setup();
    h.t.on.message(tx(1, ["a"]));
    h.clock.frame();
    h.complete("a");
    await tick();
    h.core.unnamed.add("a");
    h.t.on.message(tx(2));
    h.clock.frame();
    expect(h.core.calls).not.toContain("stage a");
    await h.drain();
    h.core.unnamed.delete("a");
    h.t.on.message(tx(3, ["a"]));
    h.clock.frame();
    expect(h.gets.map((g) => g.hash)).toEqual(["a", "a"]);
    h.complete("a");
    await h.drain();
    h.clock.frame();
    expect(h.core.calls.filter((c) => c === "stage a")).toHaveLength(1);
    expect(h.loop.stats().resources?.found).toBe(0);
    h.loop.dispose();
  });

  it("requeues demand reintroduced after discard but before its result is polled", async () => {
    const h = setup();
    h.t.on.message(tx(1, ["a"]));
    h.clock.frame();
    h.complete("a");
    await tick();
    h.core.unnamed.add("a");
    h.t.on.message(tx(2));
    await h.drain(); // discard between frames
    h.core.unnamed.delete("a");
    h.t.on.message(tx(3, ["a"]));
    h.clock.frame();
    h.clock.frame();
    expect(h.gets.map((g) => g.hash)).toEqual(["a", "a"]);
    h.complete("a");
    await h.drain();
    h.clock.frame();
    expect(h.core.calls).toContain("take a");
    expect(h.loop.state).toBe("streaming");
    h.loop.dispose();
  });

  it.each([
    false,
    true,
  ])("keeps a hinted unnamed body unless unhinted (%s)", async (unhint) => {
    const h = setup(true);
    const hint: ResourceHintRecord = {
      hash: "a",
      format: "RGBA8",
      sourceFormat: null,
      width: 1,
      height: 1,
      mipmaps: false,
      payloadBytes: 4,
      variants: [],
      path: null,
      cause: "warm",
      priority: 0,
    };
    h.core.unnamed.add("a");
    h.t.on.message(msg({ kind: "hint", hint, held: false, named: false }));
    h.clock.frame();
    h.complete("a");
    await tick();
    if (unhint) h.t.on.message(msg({ kind: "unhint", hash: "a" }));
    await h.drain();
    h.clock.frame();
    expect(h.core.calls.includes("stage a")).toBe(!unhint);
    expect(h.loop.stats().hintsPrefetched).toBe(unhint ? 0 : 1);
    expect(h.loop.stats().hintPrefetchFailed).toBe(0);
    h.loop.dispose();
  });

  it("stages restore bodies even when the accepted state does not name them", async () => {
    const h = setup();
    h.t.on.message(tx(1));
    h.clock.frame();
    h.core.missing = ["resident"];
    h.core.unnamed.add("resident");
    h.loop.contextLost();
    h.loop.contextRestored();
    h.clock.frame();
    expect(h.gets.map((g) => g.hash)).toEqual(["resident"]);
    h.complete("resident");
    await h.drain();
    h.clock.frame();
    expect(h.core.calls).toContain("stage resident");
    expect(h.core.calls).toContain("take resident");
    expect(h.loop.state).toBe("streaming");
    h.loop.dispose();
  });

  it("disposes without staging a queued worker body", async () => {
    const h = setup();
    h.t.on.message(tx(1, ["a"]));
    h.clock.frame();
    h.complete("a");
    await tick();
    h.loop.dispose();
    await h.drain();
    expect(h.core.calls).not.toContain("stage a");
  });
});
