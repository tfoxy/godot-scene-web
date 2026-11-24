// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  type LoopOptions,
  type RenderStreamStatus,
  StreamLoop,
} from "../src/loop";
import { type RenderStreamPacing, resolvePacing } from "../src/pacing";
import {
  ENDPOINT,
  FakeClock,
  FakeCore,
  FakeTransport,
  flush,
  session,
  tx,
} from "./fakes";

function setup(
  pacing?: RenderStreamPacing,
  protocol: 17 | 18 | 19 = 18,
  options: Partial<LoopOptions> = {},
) {
  const clock = new FakeClock();
  const core = new FakeCore();
  const transports: FakeTransport[] = [];
  const statuses: RenderStreamStatus[] = [];
  const loop = new StreamLoop({
    core,
    clock,
    endpoint: { ...ENDPOINT, protocol },
    pacing,
    transport: (_e, sub, on) => {
      const t = new FakeTransport(sub, on);
      transports.push(t);
      return t;
    },
    canvas: () => ({
      backing: [640, 360],
      css: [640, 360],
      dprMilli: 1000,
      gpuFormats: "none",
    }),
    ...options,
    onStatus: (s) => statuses.push(s),
  });
  const last = () => transports[transports.length - 1];
  return { loop, clock, core, transports, last, statuses };
}

function streaming(options: Partial<LoopOptions> = {}) {
  const h = setup("saver", 18, options);
  h.loop.connect();
  h.last().on.open();
  h.last().on.message(session(8));
  let seq = 0;
  function frame(ms = 10) {
    h.last().on.message(tx(++seq));
    h.clock.frame(ms);
  }
  return { ...h, frame };
}

const NULL_SAVER = {
  saverDivisor: null,
  saverDisplayHz: null,
  saverCapacityHz: null,
  saverMissedSlotShare: null,
  saverStaleSlotShare: null,
};

describe("saver loop integration", () => {
  it.each([
    17, 18, 19,
  ] as const)("uses fidelity credit on /%i without a starvation trial", (protocol) => {
    expect(resolvePacing("saver", protocol, false)).toEqual(
      resolvePacing("fidelity", protocol, false),
    );
    expect(resolvePacing("saver", protocol, true)).toEqual(
      resolvePacing("saver", protocol, false),
    );
    const h = setup("saver", protocol);
    h.loop.connect();
    h.last().on.open();
    const f = setup("fidelity", protocol);
    f.loop.connect();
    f.last().on.open();
    expect(h.last().texts[0]).toBe(f.last().texts[0]);
    expect(h.loop.stats().starvedCycleShare).toBeNull();
    h.loop.dispose();
    f.loop.dispose();
  });

  it.each([
    "raf",
    "message",
  ] as const)("applies and acks applied with %s on a skipped presentation callback, folding for the next slot", (applyOn) => {
    const h = streaming({ applyOn });
    for (let i = 0; i < 560; i++) h.frame();
    expect(h.loop.stats()).toMatchObject({
      saverDivisor: 2,
      saverCapacityHz: 100,
      starvedCycleShare: null,
    });
    let sawSkip = false;
    for (let i = 0; i < 2; i++) {
      const draws = h.loop.stats().draws;
      const applied = h.loop.stats().applied;
      h.frame();
      expect(h.loop.stats().applied).toBe(applied + 1);
      expect(h.last().acks()).toContain(`applied ${applied + 1}`);
      if (h.loop.stats().draws === draws) {
        sawSkip = true;
        expect(h.last().acks()).not.toContain(`submitted ${applied + 1}`);
        h.frame();
        expect(h.last().acks()).toContain(`submitted ${applied + 1}`);
        expect(h.loop.stats().draws).toBe(draws! + 1);
        break;
      }
    }
    expect(sawSkip).toBe(true);
    h.loop.dispose();
  });

  it.each([
    0, 1,
  ])("caps every other saver slot with %i leading callbacks, including after activity", (leading) => {
    const h = streaming({ frameCap: "automatic" });
    try {
      for (let i = 0; i < leading; i++) h.clock.frame(10);
      for (let i = 0; i < 600; i++) h.frame();
      expect(h.loop.stats()).toMatchObject({
        saverDivisor: 2,
        frameCapEngaged: true,
      });
      function run(count: number, spacing: number) {
        const before = h.loop.stats();
        const drawnAt: number[] = [];
        for (let i = 0; i < count; i++) {
          const draws = h.loop.stats().draws;
          h.frame();
          if (h.loop.stats().draws !== draws) drawnAt.push(i);
        }
        expect(drawnAt).toHaveLength(count / spacing);
        expect(drawnAt.slice(1).map((at, i) => at - drawnAt[i])).toEqual(
          Array(count / spacing - 1).fill(spacing),
        );
        expect(h.loop.stats().applied).toBe(before.applied + count);
        return before;
      }
      for (let i = 0; i < 4; i++) {
        const before = run(100, 4);
        expect(h.loop.stats().cappedFrames).toBe(before.cappedFrames! + 50);
        expect(h.loop.stats().skippedFrames).toBe(before.skippedFrames! + 25);
      }
      h.loop.wake();
      expect(h.loop.stats().frameCapEngaged).toBe(false);
      run(100, 2);
      for (let i = 0; i < 100; i++) h.frame();
      expect(h.loop.stats().frameCapEngaged).toBe(true);
      run(100, 4);
      const applied = h
        .last()
        .acks()
        .filter((ack) => ack.startsWith("applied "));
      expect(applied).toHaveLength(1300);
      expect(applied.at(-1)).toBe("applied 1300");
    } finally {
      h.loop.dispose();
    }
  });

  it("keeps fidelity's automatic cap alternating on every callback", () => {
    const h = streaming({ frameCap: "automatic", pacing: "fidelity" });
    try {
      for (let i = 0; i < 600; i++) h.frame();
      const before = h.loop.stats();
      const drawn: boolean[] = [];
      for (let i = 0; i < 100; i++) {
        const draws = h.loop.stats().draws;
        h.frame();
        drawn.push(h.loop.stats().draws !== draws);
      }
      expect(drawn.filter(Boolean)).toHaveLength(50);
      expect(drawn.slice(1).every((value, i) => value !== drawn[i])).toBe(true);
      expect(h.loop.stats()).toMatchObject({
        frameCapEngaged: true,
        cappedFrames: before.cappedFrames! + 100,
        skippedFrames: before.skippedFrames! + 50,
        applied: 700,
      });
      expect(
        h
          .last()
          .acks()
          .filter((ack) => ack.startsWith("applied ")),
      ).toHaveLength(700);
    } finally {
      h.loop.dispose();
    }
  });

  it.each([
    "same preset",
    "new connection",
    "visibility",
    "context restore",
  ])("resets grid and capacity on %s", (trigger) => {
    const h = streaming();
    for (let i = 0; i < 560; i++) h.frame();
    expect(h.loop.stats().saverDivisor).toBe(2);
    const connections = h.transports.length;
    if (trigger === "same preset") h.loop.setPacing("saver");
    else if (trigger === "visibility") h.loop.resetSaver();
    else if (trigger === "context restore") {
      h.loop.contextLost();
      h.loop.contextRestored();
    } else h.loop.setEndpoint({ ...ENDPOINT, protocol: 18, token: "new" });
    expect(h.loop.stats()).toMatchObject({
      saverDivisor: 1,
      saverDisplayHz: null,
      saverCapacityHz: null,
      saverMissedSlotShare: null,
      saverStaleSlotShare: null,
    });
    if (trigger !== "new connection")
      expect(h.transports).toHaveLength(connections);
    h.loop.dispose();
  });

  it.each([
    undefined,
    "fidelity",
    "balanced",
  ] as const)("sets saver stats null under %s, and switches without re-hello for identical credit", (pacing) => {
    const h = setup(pacing);
    expect(h.loop.stats()).toMatchObject(NULL_SAVER);
    h.loop.connect();
    h.last().on.open();
    h.loop.setPacing("saver");
    expect(h.transports).toHaveLength(pacing === "balanced" ? 2 : 1);
    expect(h.loop.stats().saverDivisor).toBe(1);
    h.loop.setPacing("fidelity");
    expect(h.loop.stats()).toMatchObject(NULL_SAVER);
    h.loop.dispose();
  });

  it("uses rAF timestamps even when callback dispatch is delayed, falling back to clock.now", () => {
    const h = streaming();
    const request = vi.spyOn(h.clock, "requestFrame");
    let callback = 0;
    request.mockImplementation((cb) =>
      FakeClock.prototype.requestFrame.call(h.clock, (ts) => {
        h.clock.t = ts + [0, 2, 6, 1, 9][callback++ % 5];
        cb(ts);
        h.clock.t = ts;
      }),
    );
    for (let i = 0; i < 560; i++) h.frame();
    expect(h.loop.stats()).toMatchObject({
      saverDivisor: 2,
      // The first completed draw is at 519 ms, so the window starts at 2519;
      // the 5520 callback completes it with 301 callbacks across 3001 ms.
      saverCapacityHz: 301000 / 3001,
      saverDisplayHz: 100,
    });
    h.loop.setPacing("saver");
    request.mockImplementation((cb) =>
      FakeClock.prototype.requestFrame.call(h.clock, () =>
        (cb as (ts?: number) => void)(),
      ),
    );
    for (let i = 0; i < 560; i++) h.frame();
    expect(h.loop.stats()).toMatchObject({
      saverDivisor: 2,
      saverCapacityHz: 100,
    });
    request.mockRestore();
    h.loop.dispose();
  });

  it("draws a payload revisit on a saver-skipped callback", async () => {
    const h = streaming();
    for (let i = 0; i < 560; i++) h.frame();
    expect(h.loop.stats().saverDivisor).toBe(2);
    // Fit used transaction 560. At 5610 the divisor's odd slot skips, but still
    // applies the payload-less state; its late payload must draw without waiting for a slot.
    h.last().on.message(tx(561, ["late"]));
    h.clock.frame(10);
    expect(h.loop.stats().deferredPayloads).toBe(1);
    h.last().gets[0].resolve(200);
    await flush();
    // Move to an odd eligible-grid parity with a fresh pending revisit.
    const before = h.loop.stats().draws;
    h.clock.frame(20);
    const draws = h.loop.stats().draws;
    expect(h.core.calls).toContain("revisit 561");
    expect(draws).toBe(before! + 1);
    expect(h.core.calls.at(-1)).toBe("draw 561");
    h.loop.dispose();
  });

  it("client tweens still force presentation on saver-skipped callbacks", () => {
    const h = streaming({ clientTweens: true });
    for (let i = 0; i < 560; i++) h.frame();
    expect(h.loop.stats().saverDivisor).toBe(2);
    h.core.tweensActive = () => true;
    const draws = h.loop.stats().draws;
    for (let i = 0; i < 10; i++) h.frame();
    expect(h.loop.stats().draws).toBe(draws! + 10);
    h.loop.dispose();
  });
  it("observes transactions, actual draws and finalized saver slots without changing credits", () => {
    const onTransaction = vi.fn();
    const onPresent = vi.fn();
    const onSlot = vi.fn((_slot: { missed: boolean }) => false);
    const plain = streaming();
    const observed = streaming({
      pacingObserver: { onTransaction, onPresent, onSlot },
    });
    for (let i = 0; i < 570; i++) {
      plain.frame();
      observed.frame();
    }
    expect(observed.core.calls).toEqual(plain.core.calls);
    expect(observed.last().sent).toEqual(plain.last().sent);
    expect(onTransaction).toHaveBeenCalledTimes(570);
    expect(onTransaction.mock.calls[0][0]).toMatchObject({
      seq: 1,
      arrivalMs: 0,
    });
    expect(onPresent.mock.calls.at(-1)![0]).toMatchObject({
      newestSeq: 569,
      tMs: 5690,
    });
    expect(onPresent.mock.calls.at(-1)![0].seqs).toEqual([568, 569]);
    expect(onSlot.mock.calls.at(-1)![0]).toMatchObject({
      k: 2,
      missed: false,
      stale: false,
    });
    // No new content in an eligible slot is stale; a long callback gap emits no misses.
    observed.clock.frame(10); // Draw the final applied transaction.
    observed.clock.frame(20);
    expect(onSlot.mock.calls.at(-1)![0]).toMatchObject({
      stale: true,
      missed: false,
    });
    onSlot.mockClear();
    observed.clock.frame(800);
    expect(onSlot.mock.calls.length).toBeGreaterThan(0);
    expect(onSlot.mock.calls.every(([slot]) => !slot.missed)).toBe(true);
    const reported = onSlot.mock.calls.length;
    observed.loop.contextLost();
    observed.clock.frame(10);
    expect(onSlot).toHaveBeenCalledTimes(reported);
    plain.loop.dispose();
    observed.loop.dispose();
  });

  it("ignores observer return values and exceptions", () => {
    const reject = vi.fn(() => {
      throw new Error("observer failure");
    });
    const plain = streaming();
    const observed = streaming({
      pacingObserver: {
        onTransaction: reject,
        onPresent: reject,
        onSlot: reject,
      },
    });
    for (let i = 0; i < 570; i++) {
      plain.frame();
      observed.frame();
    }
    expect(observed.core.calls).toEqual(plain.core.calls);
    expect(observed.last().sent).toEqual(plain.last().sent);
    expect(reject).toHaveBeenCalled();
    expect(observed.loop.stats()).toEqual(plain.loop.stats());
    plain.loop.dispose();
    observed.loop.dispose();
  });
});
