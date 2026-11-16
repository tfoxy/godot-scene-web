// The bounded resource hold: a transaction waits for its payloads at most `resourceHoldMs`, then
// applies without the texture and mesh payloads still in flight; each one that arrives later is
// drawn by a revisit with no transaction (or by the next apply).

import { describe, expect, it } from "vitest";
import type { Needed } from "../src/core";
import { DEFAULT_RESOURCE_HOLD_MS, type LoopOptions } from "../src/loop";
import { flush, harness, msg, session } from "./fakes";

/** The bounded hold these tests exercise (the default is 0, no hold). */
const HOLD = 150;

const txk = (seq: number, needed: Needed[], full = seq === 1) =>
  msg({ kind: "transaction", seq, frame: seq, full, needed });
const tex = (...hashes: string[]): Needed[] =>
  hashes.map((hash) => ({ hash, kind: 0 }));

/** Frame-paced (apply and draw in the frame callback, credit at `submitted`), window 2. */
function streaming(
  hold?: number,
  pacing: Pick<LoopOptions, "creditStage" | "applyOn"> = {
    creditStage: "submitted",
    applyOn: "frame",
  },
) {
  const h = harness(2, { ...pacing, resourceHoldMs: hold });
  h.loop.connect();
  h.last().on.open();
  h.last().on.message(session(2));
  return h;
}

/** Frame callbacks until the clock has moved `ms` past `from`. */
function framesUntil(
  h: ReturnType<typeof streaming>,
  from: number,
  ms: number,
) {
  while (h.clock.t - from < ms) h.clock.frame();
}

const applyDraw = (calls: string[]) =>
  calls.filter((c) => /^(apply|draw|defer|provide|take|revisit|stage)/.test(c));

describe("render-stream client bounded resource hold", () => {
  it("defaults to 0: never hold, like images on a web page", () => {
    expect(DEFAULT_RESOURCE_HOLD_MS).toBe(0);
  });

  it("with no resourceHoldMs the first callback applies without what is missing", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    expect(applyDraw(h.core.calls)).toEqual(["defer aa", "apply 1", "draw 1"]);
  });

  it("holds for resourceHoldMs, then applies without the payload and acks; it pops in later with no transaction", async () => {
    const h = streaming(HOLD);
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame(); // the GET goes out; the hold starts
    const since = h.clock.t;
    expect(t.gets).toHaveLength(1);
    while (h.clock.t + 16.7 - since < HOLD) {
      h.clock.frame();
      expect(h.core.calls).not.toContain("apply 1");
    }
    h.clock.frame(); // the hold is over
    expect(applyDraw(h.core.calls)).toEqual(["defer aa", "apply 1", "draw 1"]);
    expect(t.acks()).toEqual(["received 1", "applied 1", "submitted 1"]);
    expect(h.loop.stats().deferredPayloads).toBe(1);
    expect(h.statuses.at(-1)).toEqual({ kind: "streaming", firstFrame: true });
    // Frames go on while it loads; nothing redraws.
    h.clock.frame();
    expect(applyDraw(h.core.calls)).toHaveLength(3);
    // It arrives: into the store, a revisit, one draw, no ack and no refetch.
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(applyDraw(h.core.calls).slice(3)).toEqual([
      "stage aa",
      "take aa",
      "revisit 1",
      "draw 1",
    ]);
    expect(t.acks()).toHaveLength(3);
    expect(t.gets).toHaveLength(1);
    expect(h.loop.stats().deferredPayloads).toBe(0);
    h.clock.frame();
    expect(applyDraw(h.core.calls)).toHaveLength(7);
  });

  it("a payload in within the hold applies with its transaction, exactly as without a hold", async () => {
    const h = streaming(HOLD);
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    h.clock.frame();
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(applyDraw(h.core.calls)).toEqual([
      "stage aa",
      "provide",
      "apply 1",
      "draw 1",
    ]);
    expect(h.loop.stats().deferredPayloads).toBe(0);
  });

  it("resourceHoldMs 0 never holds: the first callback applies without what is missing", () => {
    const h = streaming(0);
    const t = h.last();
    t.on.message(txk(1, tex("aa", "bb")));
    h.clock.frame();
    expect(applyDraw(h.core.calls)).toEqual([
      "defer aa",
      "defer bb",
      "apply 1",
      "draw 1",
    ]);
    expect(t.gets).toHaveLength(2);
    expect(t.acks()).toEqual(["received 1", "applied 1", "submitted 1"]);
  });

  it("resourceHoldMs 0 with apply on message applies in onmessage", () => {
    const h = streaming(0, { creditStage: "applied", applyOn: "message" });
    const t = h.last();
    h.clock.frame(); // frames run
    t.on.message(txk(1, tex("aa")));
    expect(applyDraw(h.core.calls)).toEqual(["defer aa", "apply 1"]);
    expect(t.acks()).toEqual(["received 1", "applied 1"]);
  });

  it("Infinity waits for every payload", () => {
    const h = streaming(Number.POSITIVE_INFINITY);
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    for (let i = 0; i < 200; i++) h.clock.frame();
    expect(h.core.calls).not.toContain("apply 1");
    expect(h.core.calls).not.toContain("defer aa");
  });

  it("shader code is never deferred: its transaction keeps waiting", async () => {
    const h = streaming(0);
    const t = h.last();
    t.on.message(txk(1, [{ hash: "sh", kind: 2 }, ...tex("aa")]));
    for (let i = 0; i < 20; i++) h.clock.frame();
    expect(h.core.calls).not.toContain("apply 1");
    expect(h.core.calls.filter((c) => c.startsWith("defer"))).toEqual([]);
    t.gets[0].resolve(200); // the shader
    await flush();
    h.clock.frame();
    expect(applyDraw(h.core.calls)).toEqual([
      "stage sh",
      "provide",
      "defer aa",
      "apply 1",
      "draw 1",
    ]);
  });

  it("a later transaction needing a payload still loading does not wait for it again", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    framesUntil(h, h.clock.t, HOLD);
    expect(h.core.calls).toContain("apply 1");
    t.on.message(txk(2, tex("aa"), false));
    h.clock.frame();
    expect(applyDraw(h.core.calls).slice(3)).toEqual([
      "defer aa",
      "apply 2",
      "draw 2",
    ]);
    expect(t.gets).toHaveLength(1); // not refetched
    expect(t.acks().slice(-2)).toEqual(["applied 2", "submitted 2"]);
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(applyDraw(h.core.calls).slice(6)).toEqual([
      "stage aa",
      "take aa",
      "revisit 2",
      "draw 2",
    ]);
  });

  it("a deferred payload that arrives while a later transaction waits goes in with that apply", async () => {
    const h = streaming(HOLD);
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    framesUntil(h, h.clock.t, HOLD);
    t.on.message(txk(2, tex("bb"), false));
    h.clock.frame(); // bb goes out
    expect(t.gets).toHaveLength(2);
    t.gets[0].resolve(200); // aa
    await flush();
    h.clock.frame(); // polled into the waiting transaction
    expect(h.core.calls).not.toContain("revisit 1");
    t.gets[1].resolve(200); // bb
    await flush();
    h.clock.frame();
    expect(applyDraw(h.core.calls).slice(3)).toEqual([
      "stage aa",
      "stage bb",
      "provide",
      "take aa",
      "apply 2",
      "draw 2",
    ]);
    expect(h.loop.stats().deferredPayloads).toBe(0);
    h.clock.frame();
    expect(h.core.calls.filter((c) => c.startsWith("revisit"))).toEqual([]);
  });

  it("the hold counts from the first wait: a fold does not restart it", () => {
    const h = streaming(HOLD);
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    const since = h.clock.t;
    h.clock.frame();
    h.clock.frame();
    t.on.message(txk(2, tex("aa", "bb"), false)); // folds in
    framesUntil(h, since, HOLD);
    expect(applyDraw(h.core.calls)).toEqual([
      "defer aa",
      "defer bb",
      "apply 2",
      "draw 2",
    ]);
    expect(t.acks().slice(-4)).toEqual([
      "applied 1",
      "applied 2",
      "submitted 1",
      "submitted 2",
    ]);
  });

  it("a deferred payload's failed GET fails the stream at the seq that needed it", async () => {
    const h = streaming(0);
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    expect(h.core.calls).toContain("apply 1");
    t.gets[0].resolve(404);
    await flush();
    h.clock.frame();
    expect(h.statuses.at(-1)).toMatchObject({
      kind: "failed",
      reason: "resource-unavailable",
    });
  });

  it("a revisit with nothing to draw draws nothing", async () => {
    const h = streaming(0);
    h.core.revisitResult = false;
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(applyDraw(h.core.calls).slice(-2)).toEqual(["take aa", "revisit 1"]);
  });

  it("a reconnect drops what was deferred", () => {
    const h = streaming(0);
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    expect(h.loop.stats().deferredPayloads).toBe(1);
    t.on.close(1006, "");
    h.clock.frame();
    expect(h.loop.stats().deferredPayloads).toBe(0);
  });
});

describe("render-stream client bounded resource hold at the end", () => {
  it("the end record waits for the deferred payloads before closing", async () => {
    const h = streaming(0);
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    t.on.message(msg({ kind: "end" }));
    h.clock.frame();
    h.clock.frame();
    expect(t.closed).toBeNull();
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls.slice(-2)).toEqual(["revisit 1", "draw 1"]);
    h.clock.frame();
    expect(t.closed).toEqual({ code: 1000, reason: "end seen" });
  });
});
