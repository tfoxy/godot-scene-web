// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { LiveFetcher } from "../src/fetcher";
import { clientHello } from "../src/hello";
import {
  type LoopOptions,
  type RenderStreamStatus,
  StreamLoop,
} from "../src/loop";
import {
  PACING_TRIAL_CYCLES,
  PacingStarvationTracker,
  type RenderStreamPacing,
  resolvePacing,
} from "../src/pacing";
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

describe("pacing presets", () => {
  for (const protocol of [17, 18, 19] as const) {
    for (const pacing of ["fidelity", "balanced"] as const) {
      it(`${pacing} resolves the /${protocol} hello`, () => {
        const expected = {
          creditStage: pacing === "fidelity" ? "applied" : "submitted",
          creditWindow: protocol >= 18 ? (pacing === "balanced" ? 3 : 8) : 2,
        };
        expect(resolvePacing(pacing, protocol, false)).toEqual(expected);
        expect(resolvePacing("balanced", protocol, true)).toEqual(
          resolvePacing("fidelity", protocol, false),
        );
        const h = setup(pacing, protocol);
        h.loop.connect();
        h.last().on.open();
        expect(h.last().sent[0]).toMatchObject({
          protocol: `render-stream/${protocol}`,
          credit_stage: expected.creditStage,
          credit_window: expected.creditWindow,
        });
        expect(h.loop.stats()).toMatchObject({
          pacing,
          pacingFallback: false,
          creditStage: expected.creditStage,
          creditWindowGranted: null,
          starvedCycleShare: null,
          draws: 0,
        });
        h.last().on.message(session(1));
        h.last().on.message(tx(1));
        h.clock.frame();
        expect(h.loop.stats()).toMatchObject({
          creditWindowGranted: 1,
          draws: 1,
        });
        h.loop.dispose();
      });
    }
    it(`preserves the default /${protocol} hello bytes`, () => {
      const h = setup(undefined, protocol);
      h.loop.connect();
      h.last().on.open();
      expect(h.last().texts[0]).toBe(
        JSON.stringify(
          clientHello({
            protocol,
            creditWindow: protocol >= 18 ? 8 : 2,
            creditStage: "applied",
            token: null,
            backing: [640, 360],
            css: [640, 360],
            dprMilli: 1000,
            gpuFormats: "none",
            itemMeta: null,
          }),
        ),
      );
      expect(h.loop.stats().pacing).toBeNull();
      h.loop.dispose();
    });
  }
});

function streaming(
  pacing: RenderStreamPacing = "balanced",
  grant = 3,
  options: Partial<LoopOptions> = {},
) {
  const h = setup(pacing, 18, options);
  h.loop.connect();
  h.last().on.open();
  h.last().on.message(session(grant));
  h.last().on.message(tx(1));
  h.clock.frame();
  return h;
}

function longRtt(h: ReturnType<typeof setup>, cycles = PACING_TRIAL_CYCLES) {
  for (let i = 0; i < cycles; i++) {
    h.clock.frame();
    h.clock.frame();
    h.last().on.message(tx(i + 2));
    if (i + 1 < cycles) h.clock.frame();
  }
}

describe("pacing starvation tracker", () => {
  function sample(t: PacingStarvationTracker, starved: boolean) {
    t.creditReturned();
    t.frame(starved);
    return t.transaction();
  }
  it.each([
    0, 16, 17, 32,
  ])("trips only with >16 of 32 starved cycles (%i)", (starved) => {
    const t = new PacingStarvationTracker();
    expect(t.share).toBeNull();
    for (let i = 0; i < PACING_TRIAL_CYCLES; i++)
      expect(sample(t, i < starved)).toBe(
        i === PACING_TRIAL_CYCLES - 1 && starved > 16,
      );
    expect(t.share).toBe(starved / PACING_TRIAL_CYCLES);
  });
  it("slides the ring, ignores arrivals without credit, and resets an open cycle", () => {
    const t = new PacingStarvationTracker();
    t.frame(true);
    expect(t.transaction()).toBe(false);
    expect(t.share).toBeNull();
    for (let i = 0; i < PACING_TRIAL_CYCLES; i++) sample(t, false);
    for (let i = 0; i < 16; i++) expect(sample(t, true)).toBe(false);
    expect(sample(t, true)).toBe(true);
    t.creditReturned();
    t.frame(true);
    t.reset();
    expect(t.isOpen).toBe(false);
    expect(t.share).toBeNull();
    expect(t.transaction()).toBe(false);
    expect(sample(t, false)).toBe(false);
    expect(t.share).toBe(0);
  });
  it("skips payload-overlapping cycles without inserting or evicting a sample", () => {
    const t = new PacingStarvationTracker();
    for (let i = 0; i < PACING_TRIAL_CYCLES; i++) sample(t, i >= 16);
    t.creditReturned();
    t.frame(true);
    t.payloadOutstanding();
    expect(t.transaction()).toBe(false);
    expect(t.share).toBe(0.5);
    expect(sample(t, true)).toBe(true);
    t.creditReturned();
    t.payloadOutstanding();
    t.reset();
    expect(sample(t, true)).toBe(false);
    expect(t.share).toBe(1);
  });
});

describe("balanced trial and quiet re-hello", () => {
  it("does not sample submitted credit cycles before the first streaming frame", () => {
    const h = setup("balanced");
    h.loop.connect();
    h.last().on.open();
    h.last().on.message(session(1));
    h.clock.frame();
    h.last().on.message(tx(1)); // applied on message, still not drawn
    h.loop.contextLost();
    h.loop.contextRestored();
    h.clock.frame(); // restore returns submitted credit, before firstFrame: true
    expect(h.last().acks()).toContain("submitted 1");
    expect(h.statuses.at(-1)).toEqual({ kind: "streaming", firstFrame: false });
    h.clock.frame();
    h.last().on.message(tx(2));
    expect(h.loop.stats().starvedCycleShare).toBeNull();
    h.clock.frame();
    expect(h.statuses.at(-1)).toEqual({ kind: "streaming", firstFrame: true });
    h.clock.frame();
    h.last().on.message(tx(3));
    expect(h.loop.stats().starvedCycleShare).toBe(1);
    h.loop.dispose();
  });
  it.each([
    "frame",
    "arrival",
  ] as const)("skips a starved cycle with fetcher busy at %s, then trips at 17/32 clean cycles", (path) => {
    let busy = false;
    const spy = vi
      .spyOn(LiveFetcher.prototype, "busy")
      .mockImplementation(() => busy);
    const h = streaming();
    try {
      h.clock.frame(); // starved, before the payload work
      busy = true;
      if (path === "frame") {
        h.clock.frame();
        busy = false; // finished before the next transaction
      }
      h.last().on.message(tx(2));
      busy = false;
      expect(h.loop.stats().starvedCycleShare).toBeNull();
      h.clock.frame();
      for (let i = 0; i < PACING_TRIAL_CYCLES; i++) {
        if (i >= 16) h.clock.frame();
        h.last().on.message(tx(i + 3));
        if (i + 1 < PACING_TRIAL_CYCLES) h.clock.frame();
      }
      expect(h.loop.stats().starvedCycleShare).toBe(0.5);
      expect(h.transports).toHaveLength(1);
      h.clock.frame();
      h.clock.frame();
      h.last().on.message(tx(35));
      expect(h.loop.stats().pacingFallback).toBe(true);
      expect(h.transports).toHaveLength(2);
    } finally {
      h.loop.dispose();
      spy.mockRestore();
    }
  });
  it("skips a cycle with deferred payloads even when the fetcher reports idle", async () => {
    const spy = vi.spyOn(LiveFetcher.prototype, "busy").mockReturnValue(false);
    const h = streaming();
    try {
      h.last().on.message(tx(2, ["aa"]));
      h.clock.frame();
      expect(h.core.calls).toContain("defer aa");
      expect(h.loop.stats().starvedCycleShare).toBe(0);
      h.clock.frame();
      h.last().gets[0].resolve(200);
      await flush();
      h.clock.frame(); // drains deferred work; the open cycle stays skipped
      h.last().on.message(tx(3));
      expect(h.loop.stats().starvedCycleShare).toBe(0);
      h.clock.frame();
      h.clock.frame();
      h.last().on.message(tx(4));
      expect(h.loop.stats().starvedCycleShare).toBe(0.5);
    } finally {
      h.loop.dispose();
      spy.mockRestore();
    }
  });
  it.each([
    "fallback",
    "setPacing",
  ] as const)("retries a %s re-hello that closes before opening", (cause) => {
    const h = streaming();
    if (cause === "fallback") longRtt(h);
    else h.loop.setPacing("fidelity");
    expect(h.transports).toHaveLength(2);
    h.last().on.close(1006, "transient drop");
    h.clock.frame();
    expect(h.statuses.at(-1)).toEqual({
      kind: "reconnecting",
      attempt: 1,
      inMs: 1000,
    });
    expect(h.statuses.some((s) => s.kind === "failed")).toBe(false);
    h.clock.advance(1000);
    expect(h.transports).toHaveLength(3);
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: 8,
      credit_stage: "applied",
    });
    h.last().on.message(session(8));
    h.last().on.message(tx(1));
    h.clock.frame();
    expect(h.statuses.at(-1)).toEqual({
      kind: "streaming",
      firstFrame: true,
    });
    expect(h.loop.stats().pacingFallback).toBe(cause === "fallback");
    h.loop.dispose();
  });
  it.each([
    false,
    true,
  ])("keeps an unopened initial connect failure terminal (changed pacing: %s)", (changedPacing) => {
    const h = setup("fidelity");
    h.loop.connect();
    if (changedPacing) h.loop.setPacing("balanced");
    h.last().on.close(1006, "unreachable");
    h.clock.frame();
    expect(h.statuses).toEqual([
      { kind: "connecting" },
      {
        kind: "failed",
        reason: "live-connect-failed",
        detail:
          'no open connection (close code 1006 "unreachable", never opened)',
      },
    ]);
    expect(h.loop.state).toBe("failed");
    h.clock.advance(1000);
    expect(h.transports).toHaveLength(changedPacing ? 2 : 1);
    h.loop.dispose();
  });
  it("retries an opened quiet re-hello that drops before its session and any draw", () => {
    const h = setup("balanced");
    h.loop.connect();
    h.last().on.open();
    h.last().on.message(session(3));
    expect(h.loop.stats().draws).toBe(0);
    h.loop.setPacing("fidelity");
    expect(h.transports).toHaveLength(2);
    h.last().on.open();
    h.last().on.close(1006, "transient drop");
    h.clock.frame();
    expect(h.statuses).toEqual([
      { kind: "connecting" },
      { kind: "streaming", firstFrame: false },
      { kind: "reconnecting", attempt: 1, inMs: 1000 },
    ]);
    h.clock.advance(999);
    expect(h.transports).toHaveLength(2);
    h.clock.advance(1);
    expect(h.transports).toHaveLength(3);
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: 8,
      credit_stage: "applied",
    });
    h.last().on.message(session(8));
    h.last().on.message(tx(1));
    h.clock.frame();
    expect(h.statuses.slice(-2)).toEqual([
      { kind: "streaming", firstFrame: false },
      { kind: "streaming", firstFrame: true },
    ]);
    expect(h.loop.stats().draws).toBe(1);
    h.loop.dispose();
  });
  it.each([
    "fallback",
    "setPacing",
  ] as const)("fails an unauthorized %s re-hello before opening", (cause) => {
    const h = streaming();
    if (cause === "fallback") longRtt(h);
    else h.loop.setPacing("fidelity");
    h.last().on.close(1008, "unauthorized");
    h.clock.frame();
    expect(h.statuses.at(-1)).toMatchObject({
      kind: "failed",
      reason: "live-connect-failed",
      detail: "unauthorized",
    });
    expect(h.statuses.some((s) => s.kind === "reconnecting")).toBe(false);
    h.clock.advance(1000);
    expect(h.transports).toHaveLength(2);
    h.loop.dispose();
  });
  it("retries a quiet re-hello that never opens before its deadline", () => {
    const h = streaming("balanced", 3, { connectTimeoutMs: 100 });
    h.loop.setPacing("fidelity");
    h.clock.advance(101);
    h.clock.frame();
    expect(h.statuses.at(-1)).toEqual({
      kind: "reconnecting",
      attempt: 1,
      inMs: 1000,
    });
    h.clock.advance(1000);
    expect(h.transports).toHaveLength(3);
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: 8,
      credit_stage: "applied",
    });
    h.loop.dispose();
  });
  it.each([
    false,
    true,
  ])("keeps a failed initial/new-endpoint open terminal (changed endpoint: %s)", (changedEndpoint) => {
    const h = changedEndpoint ? streaming() : setup("balanced");
    if (changedEndpoint) h.loop.setEndpoint({ ...ENDPOINT, protocol: 17 });
    else h.loop.connect();
    h.last().on.close(1006, "cannot connect");
    h.clock.frame();
    expect(h.statuses.at(-1)).toMatchObject({
      kind: "failed",
      reason: "live-connect-failed",
    });
    expect(h.statuses.some((s) => s.kind === "reconnecting")).toBe(false);
    h.loop.dispose();
  });
  it("falls back once after 32 long-RTT cycles, keeps the core/store, statuses and sticky hello", () => {
    const h = streaming();
    const first = h.last();
    longRtt(h, 31);
    expect(h.transports).toHaveLength(1);
    expect(h.loop.stats().starvedCycleShare).toBe(1);
    h.clock.frame();
    h.clock.frame();
    first.on.message(tx(33));
    expect(h.transports).toHaveLength(2);
    expect(first.closes).toBe(1);
    expect(first.closed).toEqual({ code: 1000, reason: "pacing fallback" });
    expect(h.core.disposed).toBe(0);
    expect(h.core.calls).toContain("reset true");
    expect(h.loop.stats()).toMatchObject({
      pacing: "balanced",
      pacingFallback: true,
      creditWindowGranted: null,
      starvedCycleShare: null,
      draws: 32,
    });
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: 8,
      credit_stage: "applied",
    });
    h.last().on.message(session(8));
    h.last().on.message(tx(1));
    h.clock.frame();
    expect(h.statuses).toEqual([
      { kind: "connecting" },
      { kind: "streaming", firstFrame: false },
      { kind: "streaming", firstFrame: true },
      { kind: "streaming", firstFrame: false },
      { kind: "streaming", firstFrame: true },
    ]);
    h.last().on.close(1006, "drop");
    h.clock.frame();
    h.clock.advance(1000);
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: 8,
      credit_stage: "applied",
    });
    h.loop.dispose();
  });
  it("never falls back at short RTT and excludes the callback that opens the cycle", () => {
    const h = streaming();
    for (let seq = 2; seq <= 100; seq++) {
      h.last().on.message(tx(seq));
      h.clock.frame();
    }
    expect(h.transports).toHaveLength(1);
    expect(h.loop.stats()).toMatchObject({
      pacingFallback: false,
      starvedCycleShare: 0,
      draws: 100,
    });
    h.loop.dispose();
  });
  it("counts one sample for a static stretch, regardless of its callback count", () => {
    const h = streaming();
    for (let i = 0; i < 200; i++) h.clock.frame();
    expect(h.loop.stats().starvedCycleShare).toBeNull();
    h.last().on.message(tx(2));
    expect(h.loop.stats().starvedCycleShare).toBe(1);
    h.clock.frame();
    h.last().on.message(tx(3));
    expect(h.loop.stats().starvedCycleShare).toBe(0.5);
    expect(h.transports).toHaveLength(1);
    h.loop.dispose();
  });
  it("ignores callbacks skipped by the cap", () => {
    const h = streaming("balanced", 3, { frameCap: "automatic" });
    h.clock.advance(1600);
    h.last().on.message(tx(2));
    h.clock.frame(); // engages cap and draws, opening a cycle
    h.clock.frame(); // skipped, while waiting for tx(3)
    expect(h.loop.stats().skippedFrames).toBe(1);
    h.last().on.message(tx(3));
    expect(h.loop.stats().starvedCycleShare).toBe(0);
    for (let seq = 4; seq <= 70; seq++) {
      h.clock.frame(); // presents the preceding transaction, opens cycle
      h.clock.frame(); // skipped
      h.last().on.message(tx(seq));
    }
    expect(h.loop.stats()).toMatchObject({
      pacingFallback: false,
      starvedCycleShare: 0,
    });
    expect(h.transports).toHaveLength(1);
    h.loop.dispose();
  });
  it("ignores callbacks while the context is lost", () => {
    const h = streaming();
    h.loop.contextLost();
    for (let i = 0; i < 40; i++) h.clock.frame();
    h.last().on.message(tx(2));
    expect(h.loop.stats().starvedCycleShare).toBe(0);
    h.loop.dispose();
  });
  it.each([
    1, 2, 3, 8,
  ])("runs the balanced trial at any session grant (%i)", (grant) => {
    const h = streaming("balanced", grant);
    longRtt(h, 31);
    expect(h.transports).toHaveLength(1);
    expect(h.loop.stats()).toMatchObject({
      pacingFallback: false,
      creditWindowGranted: grant,
      starvedCycleShare: 1,
    });
    h.clock.frame();
    h.clock.frame();
    h.last().on.message(tx(33));
    expect(h.loop.stats().pacingFallback).toBe(true);
    expect(h.transports).toHaveLength(2);
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: 8,
      credit_stage: "applied",
    });
    h.loop.dispose();
  });
  it("does not run a starvation trial under fidelity", () => {
    const h = streaming("fidelity");
    longRtt(h, 40);
    expect(h.transports).toHaveLength(1);
    expect(h.loop.stats()).toMatchObject({
      pacingFallback: false,
      starvedCycleShare: null,
    });
    h.loop.dispose();
  });
  it("resets samples and the open cycle on a new connection/session", () => {
    const h = streaming();
    longRtt(h, 31);
    h.loop.setEndpoint({ ...ENDPOINT, protocol: 18, token: "new" });
    h.last().on.open();
    h.last().on.message(session(1));
    expect(h.loop.stats().starvedCycleShare).toBeNull();
    h.last().on.message(tx(1));
    h.clock.frame();
    h.clock.frame();
    h.last().on.message(tx(2));
    expect(h.loop.stats().starvedCycleShare).toBe(1);
    expect(h.loop.stats().pacingFallback).toBe(false);
    h.loop.dispose();
  });
  it("setPacing keeps the same hello, quietly changes a different one, and stores idle settings", () => {
    const h = setup();
    h.loop.setPacing("balanced");
    expect(h.transports).toHaveLength(0);
    h.loop.connect();
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: 3,
      credit_stage: "submitted",
    });
    h.loop.setPacing("balanced");
    expect(h.transports).toHaveLength(1);
    const old = h.last();
    h.loop.setPacing("fidelity");
    expect(old.closes).toBe(1);
    expect(h.transports).toHaveLength(2);
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: 8,
      credit_stage: "applied",
    });
    h.loop.setPacing("balanced");
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: 3,
      credit_stage: "submitted",
    });
    expect(h.loop.stats().creditStage).toBe("submitted");
    expect(h.statuses).toEqual([{ kind: "connecting" }]);
    h.loop.dispose();
  });
  it("setPacing resets fallback even for the same preset; a changed endpoint resets it too", () => {
    const h = streaming();
    longRtt(h);
    h.last().on.open();
    h.loop.setPacing("balanced");
    expect(h.loop.stats().pacingFallback).toBe(false);
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({ credit_window: 3 });
    h.last().on.message(session(1));
    h.last().on.message(tx(1));
    h.clock.frame();
    longRtt(h);
    expect(h.loop.stats().pacingFallback).toBe(true);
    h.loop.setEndpoint({ ...ENDPOINT, protocol: 17 });
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({ credit_window: 2 });
    expect(h.loop.stats().pacingFallback).toBe(false);
    h.loop.dispose();
  });
  it("keeps samples on a same-preset no-op and avoids a re-hello for identical knobs", () => {
    const h = streaming();
    h.clock.frame();
    h.last().on.message(tx(2));
    expect(h.loop.stats().starvedCycleShare).toBe(1);
    h.loop.setPacing("balanced");
    expect(h.loop.stats().starvedCycleShare).toBe(1);
    expect(h.transports).toHaveLength(1);
    h.loop.dispose();
    const defaults = setup();
    defaults.loop.connect();
    defaults.last().on.open();
    defaults.loop.setPacing("fidelity");
    expect(defaults.transports).toHaveLength(1);
    expect(defaults.loop.stats().pacing).toBe("fidelity");
    defaults.loop.dispose();
  });
  it("changes a connecting hello quietly and ignores events from the old connection", () => {
    const h = setup("balanced");
    h.loop.connect();
    const old = h.last();
    h.loop.setPacing("fidelity");
    expect(old.closed).toEqual({ code: 1000, reason: "pacing changed" });
    old.on.open();
    old.on.message(session(1));
    old.on.close(1006, "stale drop");
    expect(old.sent).toEqual([]);
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: 8,
      credit_stage: "applied",
    });
    expect(h.statuses).toEqual([{ kind: "connecting" }]);
    h.loop.dispose();
    h.loop.setPacing("balanced");
    expect(h.loop.stats().pacing).toBe("fidelity");
    expect(h.transports).toHaveLength(2);
  });
  it("stores changes during backoff and preserves the retry count through a quiet re-hello", () => {
    const h = streaming();
    h.last().on.close(1006, "drop");
    h.clock.frame();
    h.loop.setPacing("fidelity");
    expect(h.transports).toHaveLength(1);
    h.clock.advance(1000);
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({ credit_window: 8 });
    h.loop.setPacing("balanced"); // no draw on this retry, keep attempt = 1
    h.last().on.open();
    h.last().on.message(session(3));
    h.last().on.close(1006, "drop again");
    h.clock.frame();
    expect(h.statuses.slice(-1)).toEqual([
      { kind: "reconnecting", attempt: 2, inMs: 2000 },
    ]);
    h.loop.dispose();
  });
  it("uses each connection's resolved stage for credit RTT sampling", () => {
    const h = setup("balanced");
    h.loop.connect();
    h.last().on.open();
    h.last().on.message(session(3));
    h.last().on.message(tx(1));
    h.clock.frame(); // submitted credit at 16.7
    h.clock.advance(2);
    h.last().on.message(tx(2)); // applies in onmessage
    h.clock.advance(5);
    h.last().on.message(tx(3)); // no new submitted credit yet
    expect(h.loop.stats().creditRttMsP50).toBeCloseTo(2);
    h.loop.setPacing("fidelity");
    h.last().on.open();
    h.last().on.message(session(8));
    h.last().on.message(tx(1)); // applied credit now
    h.clock.advance(4);
    h.last().on.message(tx(2)); // applied credit again
    h.clock.advance(6);
    h.last().on.message(tx(3));
    expect(h.loop.stats().creditRttMsP50).toBeCloseTo(4);
    h.loop.dispose();
  });
  it.each([
    17, 19,
  ] as const)("resolves fallback from /%i on each connection", (protocol) => {
    const h = setup("balanced", protocol);
    h.loop.connect();
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: protocol < 18 ? 2 : 3,
      credit_stage: "submitted",
    });
    h.last().on.message(session(protocol < 18 ? 2 : 3));
    h.last().on.message(tx(1));
    h.clock.frame();
    longRtt(h);
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({
      credit_window: protocol < 18 ? 2 : 8,
      credit_stage: "applied",
    });
    h.loop.setPacing("fidelity"); // clears fallback, same resolved hello
    expect(h.transports).toHaveLength(2);
    expect(h.loop.stats()).toMatchObject({
      pacing: "fidelity",
      pacingFallback: false,
    });
    h.loop.dispose();
  });

  it("counts successful presentations, excluding a draw that throws", () => {
    const h = setup("balanced");
    h.loop.connect();
    h.last().on.open();
    h.last().on.message(session(1));
    h.core.draw = () => {
      throw new Error("draw failed");
    };
    h.last().on.message(tx(1));
    h.clock.frame();
    expect(h.statuses.at(-1)).toMatchObject({
      kind: "failed",
      detail: "draw failed",
    });
    expect(h.loop.stats().draws).toBe(0);
    h.loop.dispose();
  });
});
