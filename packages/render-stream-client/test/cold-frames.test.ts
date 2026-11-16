// Cold payloads: a payload a transaction needs and the store lacks counts the frame callbacks
// shown without it, from the first transaction naming it to the draw that first draws it.

import { describe, expect, it } from "vitest";
import type { Needed } from "../src/core";
import type { LoopOptions } from "../src/loop";
import { flush, harness, msg, session } from "./fakes";

const txk = (seq: number, needed: Needed[], full = seq === 1) =>
  msg({ kind: "transaction", seq, frame: seq, full, needed });
const tex = (...hashes: string[]): Needed[] =>
  hashes.map((hash) => ({ hash, kind: 0 }));

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

const draws = (calls: string[]) =>
  calls.filter((c) => /^(draw|redraw)/.test(c)).length;

describe("render-stream client cold payloads", () => {
  it("starts empty, and a transaction that needs nothing records nothing", () => {
    const h = streaming();
    const before = h.loop.stats();
    expect(before.missedPayloads).toBe(0);
    expect(before.coldPayloads).toBe(0);
    expect(before.coldFramesSum).toBe(0);
    expect(before.coldFramesMax).toBe(0);
    expect(before.coldMsMax).toBe(0);
    expect(before.coldPayloadLog).toEqual([]);
    h.last().on.message(txk(1, []));
    h.clock.frame();
    h.clock.frame();
    const after = h.loop.stats();
    expect(after.missedPayloads).toBe(0);
    // The same frozen log while nothing was added.
    expect(after.coldPayloadLog).toBe(before.coldPayloadLog);
    expect(Object.isFrozen(after.coldPayloadLog)).toBe(true);
  });

  it("resourceHoldMs 0: a deferred payload counts every frame until the revisit draws it", async () => {
    const h = streaming(0);
    const t = h.last();
    h.clock.frame(); // a frame before the reference
    t.on.message(txk(1, tex("aa")));
    const refAt = h.clock.t;
    h.clock.frame(); // drawn without aa
    h.clock.frame(); // still without
    h.clock.frame(); // still without
    expect(h.loop.stats().deferredPayloads).toBe(1);
    expect(h.loop.stats().missedPayloads).toBe(0);
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame(); // take, revisit, draw: aa is on screen
    expect(h.core.calls.slice(-3)).toEqual(["take aa", "revisit 1", "draw 1"]);
    const s = h.loop.stats();
    expect(s.missedPayloads).toBe(1);
    expect(s.coldPayloads).toBe(1);
    expect(s.coldFramesSum).toBe(3);
    expect(s.coldFramesMax).toBe(3);
    expect(s.coldMsMax).toBeCloseTo(h.clock.t - refAt, 6);
    const log = s.coldPayloadLog ?? [];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      hash: "aa",
      kind: 0,
      bytes: 4,
      seq: 1,
      coldFrames: 3,
      streamed: false,
    });
    expect(log[0].refAt).toBe(refAt);
    expect(log[0].inMs).toBeCloseTo(h.clock.t - refAt, 6);
    // Later frames add nothing.
    h.clock.frame();
    expect(h.loop.stats().coldPayloadLog).toBe(s.coldPayloadLog);
  });

  it("a payload in before the first frame after its reference counts 0", async () => {
    const h = streaming(150, { creditStage: "applied", applyOn: "message" });
    const t = h.last();
    h.clock.frame(); // frames run, so onmessage starts the fetch
    t.on.message(txk(1, tex("aa")));
    expect(t.gets).toHaveLength(1);
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame(); // provide, apply, draw: in the very next frame
    expect(h.core.calls.slice(-3)).toEqual(["provide", "apply 1", "draw 1"]);
    const s = h.loop.stats();
    expect(s.missedPayloads).toBe(1);
    expect(s.coldPayloads).toBe(0);
    expect(s.coldFramesSum).toBe(0);
    expect(s.coldPayloadLog?.[0]).toMatchObject({ hash: "aa", coldFrames: 0 });
  });

  it("a held transaction counts the frames that kept the previous state", async () => {
    const h = streaming(150);
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame(); // the GET goes out, the hold starts: the previous state stays
    h.clock.frame();
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls.slice(-2)).toEqual(["apply 1", "draw 1"]);
    expect(h.loop.stats().coldPayloadLog?.[0].coldFrames).toBe(2);
  });

  it("a later transaction naming a deferred payload does not restart its clock", async () => {
    const h = streaming(0);
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame();
    t.on.message(txk(2, tex("aa"), false));
    h.clock.frame();
    h.clock.frame();
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    const log = h.loop.stats().coldPayloadLog ?? [];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ hash: "aa", seq: 1, coldFrames: 3 });
  });

  it("with no revisit draw, the next apply's draw closes it", async () => {
    const h = streaming(0);
    h.core.revisitResult = false;
    const t = h.last();
    t.on.message(txk(1, tex("aa")));
    h.clock.frame(); // without aa
    t.gets[0].resolve(200);
    await flush();
    const before = draws(h.core.calls);
    h.clock.frame(); // in the store, nothing draws
    expect(draws(h.core.calls)).toBe(before);
    expect(h.loop.stats().missedPayloads).toBe(0);
    t.on.message(txk(2, [], false));
    h.clock.frame(); // apply 2, draw: aa is drawn
    const log = h.loop.stats().coldPayloadLog ?? [];
    expect(log).toHaveLength(1);
    expect(log[0].coldFrames).toBe(2);
  });

  it("counts several payloads apart, and a reconnect drops the open ones unrecorded", async () => {
    const h = streaming(0);
    const t = h.last();
    t.on.message(txk(1, tex("aa", "bb")));
    h.clock.frame();
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame(); // aa in after 1 frame without it
    const s = h.loop.stats();
    expect(s.missedPayloads).toBe(1);
    expect(s.coldPayloadLog?.map((r) => r.hash)).toEqual(["aa"]);
    // The host goes away with bb still missing: it is not recorded.
    t.on.close(1006, "");
    h.clock.frame();
    const after = h.loop.stats();
    expect(after.missedPayloads).toBe(1);
    expect(after.coldFramesSum).toBe(1);
  });
});
