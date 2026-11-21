import { expect, it, vi } from "vitest";
import { StreamFailure } from "../src/core";
import { RECONNECT_BACKOFF_MS } from "../src/loop";
import { harness, session, tx } from "./fakes";

function preparing() {
  const h = harness(2, { applyOn: "frame", creditStage: "submitted" });
  let remaining = 3;
  const prepareExecutor = vi.fn();
  const prepareStep = vi.fn(() => --remaining <= 0);
  Object.assign(h.core, { prepareExecutor, prepareStep });
  const raf = vi.spyOn(h.clock, "requestFrame");
  const timer = vi.spyOn(h.clock, "setTimeout");
  h.loop.connect();
  return { ...h, prepareExecutor, prepareStep, raf, timer };
}

it("prepares after transport open, one stage per existing tick before and after the session", () => {
  const h = preparing();
  expect(h.prepareExecutor).not.toHaveBeenCalled();
  h.clock.frame();
  expect(h.prepareStep).not.toHaveBeenCalled();
  h.last().on.open();
  expect(h.last().sent[0].type).toBe("hello");
  expect(h.prepareExecutor).toHaveBeenCalledTimes(1);
  h.clock.frame();
  expect(h.prepareStep).toHaveBeenCalledTimes(1);
  h.last().on.message(session());
  h.clock.frame();
  expect(h.prepareStep).toHaveBeenCalledTimes(2);
  h.clock.frame();
  h.clock.frame();
  expect(h.prepareStep).toHaveBeenCalledTimes(3);
  expect(h.clock.pendingFrames()).toBe(1);
  // The original chain requests exactly one successor per tick; preparation adds none.
  expect(h.raf).toHaveBeenCalledTimes(6);
  expect(h.timer).not.toHaveBeenCalled();
  expect(h.core.calls.some((c) => c.startsWith("draw"))).toBe(false);
  h.loop.dispose();
});

it("does not skip a due draw while preparation still has work", () => {
  const h = preparing();
  h.last().on.open();
  h.last().on.message(session());
  h.last().on.message(tx(1));
  const draw = vi.spyOn(h.core, "draw");
  h.clock.frame();
  expect(h.prepareStep).toHaveBeenCalledTimes(1);
  expect(draw).toHaveBeenCalledTimes(1);
  expect(h.last().acks()).toContain("submitted 1");
  expect(h.timer).not.toHaveBeenCalled();
  h.loop.dispose();
});

it("pauses half-prepared work on loss and resumes through the same restored loop", () => {
  const h = preparing();
  h.last().on.open();
  h.clock.frame();
  h.loop.contextLost();
  h.clock.frame();
  h.clock.frame();
  expect(h.prepareStep).toHaveBeenCalledTimes(1);
  h.loop.contextRestored();
  h.clock.frame();
  h.clock.frame();
  expect(h.prepareStep).toHaveBeenCalledTimes(2);
  expect(h.clock.pendingFrames()).toBe(1);
  h.loop.dispose();
  h.clock.frame();
  expect(h.prepareStep).toHaveBeenCalledTimes(2);
  expect(h.clock.pendingFrames()).toBe(0);
});

it("stops preparation on reconnect teardown and re-arms it only on the next transport open", () => {
  const h = preparing();
  h.last().on.open();
  h.last().on.message(session());
  h.clock.frame();
  h.last().on.close(1006, "dropped");
  h.clock.frame();
  const stopped = h.prepareStep.mock.calls.length;
  h.clock.advance(RECONNECT_BACKOFF_MS[0]);
  h.clock.frame();
  expect(h.prepareStep).toHaveBeenCalledTimes(stopped);
  h.last().on.open();
  h.clock.frame();
  expect(h.prepareExecutor).toHaveBeenCalledTimes(2);
  expect(h.prepareStep).toHaveBeenCalledTimes(stopped + 1);
  h.loop.dispose();
});

it("preserves preparation failure reason and detail and stops the existing chain", () => {
  const h = preparing();
  h.last().on.open();
  h.prepareStep.mockImplementation(() => {
    throw new StreamFailure(null, "shader", "link refused");
  });
  h.clock.frame();
  expect(h.statuses.at(-1)).toEqual({
    kind: "failed",
    reason: "shader",
    detail: "link refused",
  });
  expect(h.clock.pendingFrames()).toBe(0);
  expect(h.timer).not.toHaveBeenCalled();
  h.loop.dispose();
});

it("holds a loss observed by preparation before the canvas event and resumes after restore", () => {
  const h = preparing();
  h.last().on.open();
  h.prepareStep.mockImplementationOnce(() => {
    throw new StreamFailure(null, "WebGL2 context lost", "");
  });
  h.clock.frame();
  h.clock.frame();
  expect(h.prepareStep).toHaveBeenCalledTimes(1);
  expect(h.loop.state).toBe("streaming");
  h.loop.contextRestored();
  h.clock.frame();
  h.clock.frame();
  expect(h.prepareStep).toHaveBeenCalledTimes(2);
  h.loop.dispose();
});

it("defers context preparation when loss precedes transport open, then begins before stepping", () => {
  const h = preparing();
  let begun = false;
  h.prepareExecutor.mockImplementation(() => {
    begun = true;
  });
  h.prepareStep.mockImplementation(() => {
    expect(begun).toBe(true);
    return true;
  });
  h.loop.contextLost();
  h.last().on.open();
  expect(h.prepareExecutor).not.toHaveBeenCalled();
  expect(h.last().sent[0].type).toBe("hello");
  h.clock.frame();
  expect(h.prepareStep).not.toHaveBeenCalled();
  h.loop.contextRestored();
  h.clock.frame();
  h.clock.frame();
  expect(h.prepareExecutor).toHaveBeenCalledTimes(1);
  expect(h.prepareStep).toHaveBeenCalledTimes(1);
  h.last().on.message(session());
  expect(h.loop.state).toBe("streaming");
  expect(h.timer).not.toHaveBeenCalled();
  expect(h.clock.pendingFrames()).toBe(1);
  h.loop.dispose();
});

it("retries Stage A after a canonical loss before the canvas event without caching a failure", () => {
  const h = preparing();
  h.prepareExecutor.mockImplementationOnce(() => {
    throw new StreamFailure(null, "WebGL2 context lost", "");
  });
  h.last().on.open();
  expect(h.loop.state).toBe("streaming");
  h.clock.frame();
  expect(h.prepareStep).not.toHaveBeenCalled();
  h.loop.contextRestored();
  h.clock.frame();
  h.clock.frame();
  expect(h.prepareExecutor).toHaveBeenCalledTimes(2);
  expect(h.prepareStep).toHaveBeenCalledTimes(1);
  h.last().on.message(session());
  expect(h.loop.state).toBe("streaming");
  expect(h.timer).not.toHaveBeenCalled();
  expect(h.clock.pendingFrames()).toBe(1);
  h.loop.dispose();
});
