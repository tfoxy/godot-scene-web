import { describe, expect, it } from "vitest";
import { ENDPOINT, FakeCore, flush, harness, session, tx } from "./fakes";

function setup(resourceHints = true, hold = 10000, creditWindow: 1 | 2 = 2) {
  const h = harness(
    creditWindow,
    {
      resourceHints,
      resourceHoldMs: hold,
      applyOn: "frame",
    },
    new FakeCore(),
    { ...ENDPOINT, protocol: 16 },
  );
  h.loop.connect();
  const t = h.last();
  t.on.open();
  t.on.message(session(creditWindow));
  t.on.message(tx(1, ["a"]));
  h.clock.frame();
  return { ...h, t };
}

// Frame() advances 16.7 ms; place the callback exactly at the requested loop-clock time.
function frameAt(h: ReturnType<typeof setup>, at: number) {
  h.clock.t = at - 16.7;
  h.clock.frame();
}

describe("bounded temporary GET retry", () => {
  it.each([
    true,
    false,
  ])("retries at 250/500/1000 ms and stages a later success (hints %s)", async (hints) => {
    const h = setup(hints);
    for (const [i, delay] of [250, 500, 1000].entries()) {
      const failedAt = h.clock.t;
      h.t.gets[i].resolve(503);
      await flush();
      frameAt(h, failedAt + delay - 1);
      expect(h.t.gets).toHaveLength(i + 1);
      expect(h.loop.stats().resources?.found).toBe(0);
      frameAt(h, failedAt + delay);
      expect(h.t.gets).toHaveLength(i + 2);
      expect(h.loop.stats().getRetries).toBe(hints ? i + 1 : undefined);
    }
    h.t.gets[3].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("apply 1");
    expect(h.core.calls.indexOf("provide")).toBeLessThan(
      h.core.calls.indexOf("apply 1"),
    );
    expect(h.loop.stats().resources?.found).toBe(0);
    h.loop.dispose();
  });

  it("settles once after three retries, suppresses while named, and resets for a new naming", async () => {
    const h = setup(true, 0);
    for (const [i, delay] of [250, 500, 1000].entries()) {
      const at = h.clock.t;
      h.t.gets[i].resolve(503);
      await flush();
      frameAt(h, at + delay);
    }
    h.t.gets[3].resolve(503);
    await flush();
    h.clock.frame();
    expect(h.loop.stats().resources).toMatchObject({
      found: 1,
      unavailable: 1,
      temporary: 1,
    });
    expect(h.loop.stats().getRetries).toBe(3);
    h.t.on.message(tx(2, ["a"]));
    frameAt(h, h.clock.t + 10000);
    expect(h.t.gets).toHaveLength(4);
    h.core.unnamed.add("a");
    h.t.on.message(tx(3));
    h.clock.frame();
    h.core.unnamed.delete("a");
    h.t.on.message(tx(4, ["a"]));
    h.clock.frame();
    expect(h.t.gets).toHaveLength(5);
    const at = h.clock.t;
    h.t.gets[4].resolve(503);
    await flush();
    frameAt(h, at + 250);
    expect(h.t.gets).toHaveLength(6);
    h.loop.dispose();
  });

  it("drops a retry when the accepted state no longer names it", async () => {
    const h = setup(true, 0);
    h.t.gets[0].resolve(503);
    await flush();
    h.clock.frame();
    h.core.unnamed.add("a");
    h.t.on.message(tx(2));
    h.clock.frame();
    frameAt(h, 2000);
    expect(h.t.gets).toHaveLength(1);
    expect(h.loop.stats().resources?.found).toBe(0);
    expect(h.loop.stats().getRetries).toBe(0);
    h.loop.dispose();
  });

  it("does not bypass the backoff when a newer transaction needs the same hash", async () => {
    const h = setup(true, 0);
    const at = h.clock.t;
    h.t.gets[0].resolve(503);
    await flush();
    h.t.on.message(tx(2, ["a"]));
    h.clock.frame();
    expect(h.t.gets).toHaveLength(1);
    frameAt(h, at + 250);
    expect(h.t.gets).toHaveLength(2);
    h.loop.dispose();
  });

  it("keeps the hints-off window-1 backoff across supersession", async () => {
    const h = setup(false, 10000, 1);
    h.core.rebuildNeeded = [{ hash: "a", kind: 0 }];
    const at = h.clock.t;
    h.t.gets[0].resolve(503);
    await flush();
    h.t.on.message(tx(2, ["a"]));
    h.clock.frame();
    expect(h.t.gets).toHaveLength(1);
    frameAt(h, at + 249);
    expect(h.t.gets).toHaveLength(1);
    frameAt(h, at + 250);
    expect(h.t.gets).toHaveLength(2);
    h.t.gets[1].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("apply 2");
    expect(h.loop.stats().getRetries).toBeUndefined();
    h.loop.dispose();
  });

  it("exhausts hints-off window-1 retries despite repeated supersessions", async () => {
    const h = setup(false, 10000, 1);
    h.core.rebuildNeeded = [{ hash: "a", kind: 0 }];
    let seq = 1;
    for (const [i, delay] of [250, 500, 1000].entries()) {
      const at = h.clock.t;
      h.t.gets[i].resolve(503);
      await flush();
      h.t.on.message(tx(++seq, ["a"]));
      frameAt(h, at + delay / 2);
      expect(h.t.gets).toHaveLength(i + 1);
      h.t.on.message(tx(++seq, ["a"]));
      frameAt(h, at + delay - 1);
      expect(h.t.gets).toHaveLength(i + 1);
      frameAt(h, at + delay);
      expect(h.t.gets).toHaveLength(i + 2);
    }
    h.t.gets[3].resolve(503);
    await flush();
    h.clock.frame();
    expect(h.loop.stats().resources).toMatchObject({
      unavailable: 1,
      temporary: 1,
    });
    h.t.on.message(tx(++seq, ["a"]));
    frameAt(h, h.clock.t + 5000);
    expect(h.t.gets).toHaveLength(4);
    expect(h.loop.stats().resources?.unavailable).toBe(1);
    h.loop.dispose();
  });

  it("drops a hints-off window-1 retry without an unavailable finding when superseded out", async () => {
    const h = setup(false, 10000, 1);
    h.t.gets[0].resolve(503);
    await flush();
    h.core.unnamed.add("a");
    h.t.on.message(tx(2));
    h.clock.frame();
    frameAt(h, 2000);
    expect(h.t.gets).toHaveLength(1);
    expect(h.loop.stats().resources).toMatchObject({
      unavailable: 0,
      found: 0,
    });
    expect(h.core.calls).toContain("apply 2");
    h.loop.dispose();
  });

  it.each([404, 410, 401, 403])("never retries HTTP %i", async (status) => {
    const h = setup();
    h.t.gets[0].resolve(status);
    await flush();
    h.clock.frame();
    frameAt(h, 10000);
    expect(h.t.gets).toHaveLength(1);
    expect(h.loop.stats().getRetries).toBe(0);
    if (status < 404) expect(h.statuses.at(-1)?.kind).toBe("failed");
    else expect(h.loop.stats().resources?.missing).toBe(1);
    h.loop.dispose();
  });

  it("retries a folded payload still named by the accepted state", async () => {
    const h = setup();
    h.t.on.message(tx(2, ["b"]));
    h.clock.frame();
    const at = h.clock.t;
    h.t.gets[0].resolve(503);
    h.t.gets[1].resolve(200);
    await flush();
    frameAt(h, at + 250);
    expect(h.t.gets.map((g) => g.path.split("/").at(-1))).toEqual([
      "a",
      "b",
      "a",
    ]);
    h.t.gets[2].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("take a");
    expect(h.core.calls).toContain("apply 2");
    h.loop.dispose();
  });

  it("retries a resident payload during context restore", async () => {
    const h = setup(true, 0);
    h.t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    h.loop.contextLost();
    h.core.missing = ["a"];
    h.loop.contextRestored();
    h.clock.frame();
    const at = h.clock.t;
    h.t.gets[1].resolve(503);
    await flush();
    frameAt(h, at + 249);
    expect(h.t.gets).toHaveLength(2);
    frameAt(h, at + 250);
    expect(h.t.gets).toHaveLength(3);
    h.t.gets[2].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("redraw 1");
    expect(h.loop.stats().resources?.found).toBe(0);
    expect(h.loop.stats().getRetries).toBe(1);
    h.loop.dispose();
  });

  it("a new naming during backoff starts afresh without inheriting an old retry", async () => {
    const h = setup(true, 0);
    h.t.gets[0].resolve(503);
    await flush();
    h.core.unnamed.add("a");
    h.t.on.message(tx(2));
    h.core.unnamed.delete("a");
    h.t.on.message(tx(3, ["a"]));
    h.clock.frame();
    h.clock.frame();
    expect(h.t.gets).toHaveLength(2);
    expect(h.loop.stats().getRetries).toBe(0);
    const at = h.clock.t;
    h.t.gets[1].resolve(503);
    await flush();
    frameAt(h, at + 250);
    expect(h.t.gets).toHaveLength(3);
    expect(h.loop.stats().getRetries).toBe(1);
    h.loop.dispose();
  });

  it("clears pending retries on reconnect", async () => {
    const h = setup(true, 0);
    h.t.gets[0].resolve(503);
    await flush();
    h.clock.frame();
    h.t.on.close(1006, "lost");
    h.clock.frame();
    h.clock.advance(1000);
    const t = h.last();
    t.on.open();
    t.on.message(session());
    h.clock.frame();
    expect(h.t.gets).toHaveLength(1);
    expect(t.gets).toHaveLength(0);
    h.loop.dispose();
  });
});
