// J1: shader programs whose links settle in the background. The loop polls the core once per frame
// callback, before that callback's applier run; a settle with nothing accepted is revisited and drawn
// (no ack, no credit); with a transaction waiting, that transaction's run takes it.
import { describe, expect, it } from "vitest";
import type { LoopOptions } from "../src/loop";
import { harness, session, tx } from "./fakes";

const FRAME: Pick<LoopOptions, "creditStage" | "applyOn"> = {
  creditStage: "submitted",
  applyOn: "frame",
};

function streaming() {
  const h = harness(2, FRAME);
  h.loop.connect();
  h.last().on.open();
  h.last().on.message(session(2));
  h.core.logPolls = true;
  return h;
}

describe("program links settling between frames (J1)", () => {
  it("polls once per callback, before the applier run", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1));
    h.core.calls.length = 0;
    h.clock.frame();
    expect(h.core.calls).toEqual(["poll-programs", "apply 1", "draw 1"]);
    h.clock.frame();
    expect(h.core.calls.filter((c) => c === "poll-programs")).toHaveLength(2);
  });

  it("a settle with nothing accepted revisits and draws the applied state, acking nothing", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    const acks = t.acks().length;
    h.core.calls.length = 0;
    h.core.settles = [true];
    h.clock.frame();
    expect(h.core.calls).toEqual(["poll-programs", "revisit 1", "draw 1"]);
    expect(t.acks()).toHaveLength(acks);
    // Nothing settled: no revisit, no draw (an idle callback offers particle bursts a slice).
    h.core.calls.length = 0;
    h.clock.frame();
    expect(h.core.calls).toEqual(["poll-programs", "settle-particles 1"]);
  });

  it("a revisit that applied nothing draws nothing", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    h.core.calls.length = 0;
    h.core.revisitResult = false;
    h.core.settles = [true];
    h.clock.frame();
    expect(h.core.calls).toEqual([
      "poll-programs",
      "revisit 1",
      "settle-particles 1",
    ]);
  });

  it("a settle in the callback that applies a transaction is taken by that run: one apply, one draw", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    t.on.message(tx(2));
    h.core.calls.length = 0;
    // The real core's revisit finds nothing left after the apply took the settle.
    h.core.revisitResult = false;
    h.core.settles = [true];
    h.clock.frame();
    expect(h.core.calls.filter((c) => c.startsWith("apply"))).toEqual([
      "apply 2",
    ]);
    expect(h.core.calls.filter((c) => c.startsWith("draw"))).toEqual([
      "draw 2",
    ]);
    expect(h.core.calls.indexOf("poll-programs")).toBeLessThan(
      h.core.calls.indexOf("apply 2"),
    );
  });

  it("an idle host: a particle burst settles from the frame callback and is drawn, acking nothing", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    const acks = t.acks().length;
    h.core.calls.length = 0;
    // No transaction after the first: the callbacks settle, and the one that ends draws.
    h.core.particleSettles = [false, false, true];
    h.clock.frame();
    h.clock.frame();
    expect(h.core.calls).toEqual([
      "poll-programs",
      "settle-particles 1",
      "poll-programs",
      "settle-particles 1",
    ]);
    h.core.calls.length = 0;
    h.clock.frame();
    expect(h.core.calls).toEqual([
      "poll-programs",
      "settle-particles 1",
      "draw 1",
    ]);
    expect(t.acks()).toHaveLength(acks);
  });

  it("a callback that runs the applier does not settle particles separately", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    t.on.message(tx(2));
    h.core.calls.length = 0;
    h.core.particleSettles = [true];
    h.clock.frame();
    expect(h.core.calls.some((c) => c.startsWith("settle-particles"))).toBe(
      false,
    );
    expect(h.core.calls.filter((c) => c.startsWith("draw"))).toEqual([
      "draw 2",
    ]);
  });

  it("no poll while the context is lost; polling resumes after the restore", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    h.loop.contextLost();
    h.core.calls.length = 0;
    h.core.settles = [true];
    h.clock.frame();
    expect(h.core.calls).not.toContain("poll-programs");
    h.loop.contextRestored();
    h.clock.frame();
    expect(h.core.calls.at(-1)).toBe("redraw 1");
    h.core.calls.length = 0;
    h.core.settles = [true];
    h.clock.frame();
    expect(h.core.calls.slice(0, 3)).toEqual([
      "poll-programs",
      "revisit 1",
      "draw 1",
    ]);
  });
});
