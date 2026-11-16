// Streaming through payloads the host cannot serve: a GET that is missing or temporarily
// unavailable settles on its own (the queue and the other GETs go on), the payload is deferred
// while the accepted state names it (never refetched meanwhile, never a failed status), and the
// payloads the loop tracks follow the accepted names after every transaction (`core.named`).

import { describe, expect, it } from "vitest";
import type { Needed } from "../src/core";
import { type LoopOptions, RESOURCE_LOG_MAX } from "../src/loop";
import { flush, harness, msg, session } from "./fakes";

const txk = (seq: number, needed: Needed[], full = seq === 1) =>
  msg({ kind: "transaction", seq, frame: seq, full, needed });
const tex = (...hashes: string[]): Needed[] =>
  hashes.map((hash) => ({ hash, kind: 0 }));

/** Zero-wait (the default hold), frame-paced, credit window 2. */
function streaming(
  extra: Pick<LoopOptions, "fetchTimeoutMs" | "resourceHoldMs"> = {},
) {
  const h = harness(2, {
    creditStage: "submitted",
    applyOn: "frame",
    ...extra,
  });
  h.loop.connect();
  h.last().on.open();
  h.last().on.message(session(2));
  return h;
}

const name = (g: { path: string }) => g.path.split("/").at(-1);
const of = (calls: string[], re: RegExp) => calls.filter((c) => re.test(c));
const failed = (h: ReturnType<typeof streaming>) =>
  h.statuses.some((s) => s.kind === "failed");
/** GETs still open (neither answered nor aborted). */
const open = (t: ReturnType<ReturnType<typeof streaming>["last"]>) =>
  t.gets.filter((g) => !(g as { done?: boolean }).done && !g.aborted);
function answer(
  t: ReturnType<ReturnType<typeof streaming>["last"]>,
  i: number,
  status: number,
) {
  (t.gets[i] as { done?: boolean }).done = true;
  t.gets[i].resolve(status);
}

describe("render-stream client unavailable payloads", () => {
  it("six misses then their removal: the queued two are pruned, a 404 in flight settles alone", async () => {
    const h = streaming();
    const t = h.last();
    const six = ["m1", "m2", "m3", "m4", "m5", "m6"];
    t.on.message(txk(1, tex(...six)));
    h.clock.frame();
    // Four in flight, two queued; zero-wait applies without them.
    expect(t.gets.map(name)).toEqual(six.slice(0, 4));
    expect(of(h.core.calls, /^(defer|apply)/)).toEqual([
      ...six.map((x) => `defer ${x}`),
      "apply 1",
    ]);
    expect(h.loop.stats().deferredPayloads).toBe(6);
    // tx2 removes all six: nothing tracks them any more.
    for (const x of six) h.core.unnamed.add(x);
    t.on.message(txk(2, []));
    h.clock.frame();
    expect(h.loop.stats().deferredPayloads).toBe(0);
    // The first GET completes: the obsolete fifth is never issued; the body is dropped.
    answer(t, 0, 200);
    await flush();
    h.clock.frame();
    expect(t.gets).toHaveLength(4);
    expect(h.core.calls).toContain("drop m1");
    expect(h.core.calls).not.toContain("take m1");
    // A 404 of an obsolete one settles alone: no failure, no abort, no diagnostic.
    answer(t, 1, 404);
    await flush();
    h.clock.frame();
    expect(failed(h)).toBe(false);
    expect(t.closed).toBeNull();
    expect([t.gets[2].aborted, t.gets[3].aborted]).toEqual([false, false]);
    expect(h.loop.stats().resources?.found).toBe(0);
    answer(t, 2, 200);
    answer(t, 3, 404);
    await flush();
    h.clock.frame();
    expect(t.gets).toHaveLength(4);
    expect(failed(h)).toBe(false);
    expect(h.loop.stats().resources).toMatchObject({
      found: 0,
      unavailable: 0,
    });
  });

  it("a 404 while named: unavailable, suppressed while named, the others and the queue go on", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("a1", "a2", "a3", "a4", "a5")));
    h.clock.frame();
    answer(t, 1, 404);
    answer(t, 0, 200);
    await flush();
    h.clock.frame();
    // The queue went on (a5 issued), nothing was aborted, the stream streams.
    expect(t.gets.map(name)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(t.gets.some((g) => g.aborted)).toBe(false);
    expect(failed(h)).toBe(false);
    const r = h.loop.stats().resources;
    expect(r).toMatchObject({ unavailable: 1, found: 1, missing: 1 });
    expect(r?.recent).toEqual([
      expect.objectContaining({
        hash: "a2",
        kind: 0,
        seq: 1,
        reason: "missing",
        status: 404,
        restore: false,
        count: 1,
      }),
    ]);
    expect(h.loop.stats().deferredPayloads).toBe(3);
    // A later transaction needing it again defers it at once: no second GET.
    t.on.message(txk(2, tex("a2")));
    h.clock.frame();
    expect(t.gets.filter((g) => name(g) === "a2")).toHaveLength(1);
    expect(of(h.core.calls, /^(defer a2|apply 2)/)).toEqual([
      "defer a2",
      "defer a2",
      "apply 2",
    ]);
    // It is never counted as fetched or drawn.
    expect(h.loop.stats().coldPayloadLog?.some((p) => p.hash === "a2")).toBe(
      false,
    );
  });

  it("successful parallel GETs beside an unavailable one provide in wasm's order", async () => {
    const h = streaming({ resourceHoldMs: Number.POSITIVE_INFINITY });
    const t = h.last();
    t.on.message(txk(1, tex("p1", "p2", "p3", "p4")));
    h.clock.frame();
    answer(t, 2, 503);
    answer(t, 3, 200);
    answer(t, 0, 200);
    answer(t, 1, 200);
    await flush();
    h.clock.frame();
    expect(of(h.core.calls, /^(provide|defer|apply)/)).toEqual([
      "provide",
      "provide",
      "defer p3",
      "provide",
      "apply 1",
    ]);
    expect(h.loop.stats().resources?.recent[0]).toMatchObject({
      hash: "p3",
      reason: "temporary",
      status: 503,
    });
  });

  it("H leaves and comes back in one batch: the old GET's 404 asks it afresh, no diagnostic", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("hh")));
    h.clock.frame();
    // Two transactions before the next frame: H leaves, then comes back.
    h.core.unnamed.add("hh");
    t.on.message(txk(2, []));
    h.core.unnamed.delete("hh");
    t.on.message(txk(3, tex("hh")));
    // The GET in flight answers 404: that naming's, not this one's.
    answer(t, 0, 404);
    await flush();
    h.clock.frame();
    expect(h.loop.stats().resources?.found).toBe(0);
    h.clock.frame(); // the fresh GET goes out
    expect(t.gets.map(name)).toEqual(["hh", "hh"]);
    expect(open(t)).toHaveLength(1);
    // Its own 404 is this naming's: unavailable, once.
    answer(t, 1, 404);
    await flush();
    h.clock.frame();
    expect(h.loop.stats().resources).toMatchObject({
      found: 1,
      unavailable: 1,
    });
    expect(failed(h)).toBe(false);
  });

  it("H leaves and comes back across frames: the old GET's body serves the new naming", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("hh")));
    h.clock.frame();
    h.core.unnamed.add("hh");
    t.on.message(txk(2, []));
    h.clock.frame();
    h.core.unnamed.delete("hh");
    t.on.message(txk(3, tex("hh")));
    h.clock.frame();
    expect(t.gets).toHaveLength(1); // never asked twice while one is in flight
    answer(t, 0, 200);
    await flush();
    h.clock.frame();
    expect(of(h.core.calls, /^(take hh|drop hh|revisit)/)).toEqual([
      "take hh",
      "revisit 3",
    ]);
    expect(h.loop.stats().deferredPayloads).toBe(0);
  });

  it("H leaves and comes back in one batch: the old GET's body serves it, one GET", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("hh")));
    h.clock.frame();
    h.core.unnamed.add("hh");
    t.on.message(txk(2, []));
    h.core.unnamed.delete("hh");
    t.on.message(txk(3, tex("hh")));
    answer(t, 0, 200);
    await flush();
    h.clock.frame();
    h.clock.frame();
    expect(t.gets).toHaveLength(1);
    // The newest transaction's apply provides it in needed order (not dropped as obsolete).
    expect(of(h.core.calls, /^(provide|take hh|drop hh|apply 3)/)).toEqual([
      "provide",
      "apply 3",
    ]);
    expect(h.loop.stats().deferredPayloads).toBe(0);
  });

  it("H leaves and comes back across frames: the old GET's 404 is not this naming's", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("hh")));
    h.clock.frame();
    h.core.unnamed.add("hh");
    t.on.message(txk(2, []));
    h.clock.frame();
    h.core.unnamed.delete("hh");
    t.on.message(txk(3, tex("hh")));
    h.clock.frame();
    answer(t, 0, 404);
    await flush();
    h.clock.frame();
    h.clock.frame();
    expect(h.loop.stats().resources?.found).toBe(0);
    expect(t.gets.map(name)).toEqual(["hh", "hh"]);
    expect(h.loop.stats().deferredPayloads).toBe(1);
    answer(t, 1, 200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("take hh");
    expect(h.loop.stats().deferredPayloads).toBe(0);
  });

  it("an unavailable payload that leaves and is named again is fetched afresh", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("hh")));
    h.clock.frame();
    answer(t, 0, 404);
    await flush();
    h.clock.frame();
    h.core.unnamed.add("hh");
    t.on.message(txk(2, []));
    h.clock.frame();
    expect(h.loop.stats().resources?.unavailable).toBe(0);
    h.core.unnamed.delete("hh");
    t.on.message(txk(3, tex("hh")));
    h.clock.frame();
    expect(t.gets.map(name)).toEqual(["hh", "hh"]);
    answer(t, 1, 200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("take hh");
  });

  it("a transform-only delta (no needed list) keeps a still-named deferred payload", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    t.on.message(txk(2, []));
    h.clock.frame();
    expect(h.core.namedCalls).toBeGreaterThan(0);
    expect(h.loop.stats().deferredPayloads).toBe(1);
    answer(t, 0, 200);
    await flush();
    h.clock.frame();
    expect(of(h.core.calls, /^(take aa|revisit)/)).toEqual([
      "take aa",
      "revisit 2",
    ]);
  });

  it("a shared or variant hash still named by another entry stays tracked", async () => {
    // The core answers names membership over every entry and variant: removing one user of a
    // shared payload (or the entry choosing another variant while this one stays named) keeps it.
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("sh", "vv")));
    h.clock.frame();
    t.on.message(txk(2, [])); // one user of "sh" gone; "vv" no longer selected but named
    h.clock.frame();
    expect(h.loop.stats().deferredPayloads).toBe(2);
    h.core.unnamed.add("sh");
    t.on.message(txk(3, [])); // the last user gone
    h.clock.frame();
    expect(h.loop.stats().deferredPayloads).toBe(1);
  });

  it("the warm stream asks the core nothing", () => {
    const h = streaming();
    const t = h.last();
    for (let seq = 1; seq <= 20; seq++) {
      t.on.message(txk(seq, []));
      h.clock.frame();
    }
    expect(h.core.namedCalls).toBe(0);
  });

  it("repeated failure churn returns the tracking to baseline, never two GETs of one hash at once", async () => {
    const h = streaming();
    const t = h.last();
    let seq = 0;
    for (let k = 0; k < 8; k++) {
      h.core.unnamed.delete("hh");
      t.on.message(txk(++seq, tex("hh")));
      h.clock.frame();
      expect(open(t)).toHaveLength(1);
      answer(t, t.gets.length - 1, k % 2 === 0 ? 404 : 500);
      await flush();
      h.clock.frame();
      expect(h.loop.stats().resources?.unavailable).toBe(1);
      h.core.unnamed.add("hh");
      t.on.message(txk(++seq, []));
      h.clock.frame();
      const loop = h.loop as unknown as {
        deferred: Map<string, unknown>;
        unavailable: Map<string, unknown>;
        stale: Set<string>;
      };
      expect([
        loop.deferred.size,
        loop.unavailable.size,
        loop.stale.size,
      ]).toEqual([0, 0, 0]);
    }
    expect(t.gets).toHaveLength(8);
    const r = h.loop.stats().resources;
    expect(r).toMatchObject({
      found: 8,
      missing: 4,
      temporary: 4,
      unavailable: 0,
    });
    // One record per hash in the ring, its count every finding, its seq the first.
    expect(r?.recent).toHaveLength(1);
    expect(r?.recent[0]).toMatchObject({ hash: "hh", count: 8, seq: 1 });
    expect(failed(h)).toBe(false);
  });

  it("the diagnostic ring is bounded and its view stable until it changes", async () => {
    const h = streaming();
    const t = h.last();
    const many = Array.from(
      { length: RESOURCE_LOG_MAX + 4 },
      (_, i) => `x${i}`,
    );
    t.on.message(txk(1, tex(...many)));
    for (let i = 0; i < many.length; i++) {
      h.clock.frame();
      answer(t, i, 410);
      await flush();
    }
    h.clock.frame();
    const a = h.loop.stats().resources;
    expect(a?.found).toBe(many.length);
    expect(a?.recent).toHaveLength(RESOURCE_LOG_MAX);
    expect(a?.recent.at(-1)?.hash).toBe(many.at(-1));
    expect(h.loop.stats().resources).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it.each([
    [404, "missing"],
    [410, "missing"],
    [408, "temporary"],
    [429, "temporary"],
    [500, "temporary"],
    [503, "temporary"],
  ] as const)("HTTP %i is %s, never a failed status", async (status, reason) => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("aa", "bb")));
    h.clock.frame();
    answer(t, 0, status);
    await flush();
    h.clock.frame();
    expect(failed(h)).toBe(false);
    expect(t.gets[1].aborted).toBe(false);
    expect(h.loop.stats().resources?.recent[0]).toMatchObject({
      reason,
      status,
    });
  });

  it("a rejected request is temporary, with no status", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("aa", "bb")));
    h.clock.frame();
    t.gets[0].reject(new TypeError("Failed to fetch"));
    await flush();
    h.clock.frame();
    expect(failed(h)).toBe(false);
    expect(t.gets[1].aborted).toBe(false);
    expect(h.loop.stats().resources?.recent[0]).toMatchObject({
      hash: "aa",
      reason: "temporary",
      status: null,
    });
  });

  it("a stalled GET is temporary; the others keep going", async () => {
    const h = streaming({ fetchTimeoutMs: 5 });
    const t = h.last();
    t.on.message(txk(1, tex("aa", "bb")));
    h.clock.frame();
    await new Promise((r) => setTimeout(r, 30));
    answer(t, 1, 200);
    await flush();
    h.clock.frame();
    expect(failed(h)).toBe(false);
    const recent = h.loop.stats().resources?.recent ?? [];
    expect(recent.map((e) => [e.hash, e.reason])).toContainEqual([
      "aa",
      "temporary",
    ]);
    expect(recent.find((e) => e.hash === "aa")?.detail).toMatch(/stalled/);
  });

  it.each([401, 403, 400, 302])("HTTP %i stays fatal", async (status) => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("aa", "bb")));
    h.clock.frame();
    answer(t, 0, status);
    await flush();
    h.clock.frame();
    expect(h.statuses.at(-1)).toMatchObject({
      kind: "failed",
      reason: "resource-unavailable",
    });
    expect(t.gets[1].aborted).toBe(true);
  });

  it("a body failing verification stays fatal", async () => {
    const h = streaming();
    h.core.stageErrors.set("aa", "resource-hash: the body's sha256 differs");
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    answer(t, 0, 200);
    await flush();
    h.clock.frame();
    expect(h.statuses.at(-1)).toMatchObject({
      kind: "failed",
      reason: "resource-hash-mismatch",
    });
  });

  it("unavailable shader code defers: the apply goes on and acks flow", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, [{ hash: "sh", kind: 2 }, ...tex("aa")]));
    h.clock.frame();
    expect(of(h.core.calls, /^(defer|apply)/)).toEqual([
      "defer sh",
      "defer aa",
      "apply 1",
    ]);
    answer(t, 0, 404);
    answer(t, 1, 200);
    await flush();
    h.clock.frame();
    expect(h.loop.stats().resources?.recent[0]).toMatchObject({
      hash: "sh",
      kind: 2,
    });
    expect(t.acks()).toEqual(["received 1", "applied 1", "submitted 1"]);
    // The next transaction defers it again (named, suppressed) and applies.
    t.on.message(txk(2, [{ hash: "sh", kind: 2 }]));
    h.clock.frame();
    expect(of(h.core.calls, /^(defer sh|apply 2)/).slice(-2)).toEqual([
      "defer sh",
      "apply 2",
    ]);
    expect(t.gets).toHaveLength(2);
  });

  it("the end record does not wait for an unavailable payload", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    t.on.message(msg({ kind: "end" }));
    h.clock.frame();
    expect(h.loop.state).toBe("streaming"); // waits for the deferred payload
    answer(t, 0, 404);
    await flush();
    h.clock.frame();
    expect(h.loop.state).toBe("draining");
    expect(failed(h)).toBe(false);
  });

  it("a reconnect fetches what was unavailable afresh", async () => {
    const h = streaming();
    let t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    answer(t, 0, 404);
    await flush();
    h.clock.frame();
    expect(h.loop.stats().resources?.unavailable).toBe(1);
    t.on.close(1006, "");
    h.clock.frame();
    h.clock.advance(1000);
    t = h.last();
    t.on.open();
    t.on.message(session(2));
    expect(h.loop.stats().resources?.unavailable).toBe(0);
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    expect(t.gets.map(name)).toEqual(["aa"]);
    expect(h.loop.stats().resources?.found).toBe(1); // history kept
  });

  it("a coding resync's rebuild keeps an unavailable payload suppressed", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    answer(t, 0, 404);
    await flush();
    h.clock.frame();
    t.on.message(msg({ kind: "coding-resync", seq: 2, error: "x" }));
    h.core.rebuildNeeded = tex("aa");
    t.on.message(txk(3, [], true));
    h.clock.frame();
    expect(of(h.core.calls, /^(rebuild|defer aa|apply 3)/).slice(-3)).toEqual([
      "rebuild 3",
      "defer aa",
      "apply 3",
    ]);
    expect(t.gets).toHaveLength(1);
  });

  it("a fold keeps a GET in flight for the newest transaction (no cancel, no refetch)", async () => {
    const h = streaming({ resourceHoldMs: Number.POSITIVE_INFINITY });
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    t.on.message(txk(2, tex("aa", "bb")));
    h.clock.frame();
    expect(t.gets.map(name)).toEqual(["aa", "bb"]);
    answer(t, 0, 200);
    answer(t, 1, 404);
    await flush();
    h.clock.frame();
    expect(of(h.core.calls, /^(provide|defer|apply)/)).toEqual([
      "provide",
      "defer bb",
      "apply 2",
    ]);
    expect(t.acks().filter((a) => a.startsWith("applied"))).toEqual([
      "applied 1",
      "applied 2",
    ]);
  });

  it("a context restore that cannot refetch a resident texture re-lowers and redraws the rest", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, []));
    h.clock.frame();
    h.loop.contextLost();
    h.core.missing = ["tt", "uu"];
    h.loop.contextRestored();
    h.clock.frame();
    expect(t.gets.map(name)).toEqual(["tt", "uu"]);
    answer(t, 0, 404);
    answer(t, 1, 200);
    await flush();
    h.clock.frame();
    expect(
      of(h.core.calls, /^(restore-unavailable|take|revisit|redraw)/),
    ).toEqual(["restore-unavailable tt", "take uu", "revisit 1", "redraw 1"]);
    expect(failed(h)).toBe(false);
    expect(h.loop.stats().resources?.recent[0]).toMatchObject({
      hash: "tt",
      restore: true,
      reason: "missing",
    });
    // Acks and input go on: the next transaction applies and draws.
    t.on.message(txk(2, []));
    h.clock.frame();
    expect(h.core.calls.slice(-2)).toEqual(["apply 2", "draw 2"]);
  });

  it("a context restore with a transaction waiting leaves the re-lower to its apply", async () => {
    const h = streaming({ resourceHoldMs: Number.POSITIVE_INFINITY });
    const t = h.last();
    t.on.message(txk(1, []));
    h.clock.frame();
    h.loop.contextLost();
    t.on.message(txk(2, tex("bb"))); // accepted while lost, not applied
    h.core.missing = ["tt"];
    h.loop.contextRestored();
    h.clock.frame();
    answer(t, 0, 404);
    await flush();
    h.clock.frame();
    expect(h.core.calls).toContain("restore-unavailable tt");
    expect(h.core.calls).toContain("redraw 1");
    expect(h.core.calls).not.toContain("revisit 1");
    h.clock.frame(); // the waiting transaction's GET goes out
    answer(t, 1, 200);
    await flush();
    h.clock.frame();
    expect(h.core.calls.slice(-2)).toEqual(["apply 2", "draw 2"]);
  });
});
