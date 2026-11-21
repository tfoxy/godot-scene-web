import { describe, expect, it } from "vitest";
import {
  type LoopOptions,
  MESSAGE_APPLY_MAX_FRAME_GAP_MS,
  MESSAGE_APPLY_MAX_UNDRAWN,
  RECONNECT_BACKOFF_MS,
} from "../src/loop";
import { flush, harness, msg, session, tx } from "./fakes";

/** Connects and opens the first connection, then delivers its session. */
/** The frame-paced loop (credit at `submitted`, apply in the frame callback) unless `pacing` says. */
function streaming(
  window: 1 | 2 = 2,
  pacing: Pick<LoopOptions, "creditStage" | "applyOn" | "resourceHoldMs"> = {
    creditStage: "submitted",
    applyOn: "frame",
  },
) {
  const h = harness(2, pacing);
  h.loop.connect();
  h.last().on.open();
  h.last().on.message(session(window));
  return h;
}

/** Frame-paced and waiting for every payload (`resourceHoldMs: Infinity`; the default is 0). */
const WAIT: Pick<LoopOptions, "creditStage" | "applyOn" | "resourceHoldMs"> = {
  creditStage: "submitted",
  applyOn: "frame",
  resourceHoldMs: Infinity,
};

describe("render-stream client loop", () => {
  it("sends the hello on open and credits only from the frame loop", () => {
    const h = streaming();
    const t = h.last();
    expect(t.subprotocol).toBe("render-stream.12");
    expect(t.sent[0]).toMatchObject({
      type: "hello",
      protocol: "render-stream/12",
      receiver_kind: "gsw-canvas",
      credit_stage: "submitted",
      credit_window: 2,
      texture_encodings: "decoded",
      live_coding: "zstd-base,zstd",
    });
    t.on.message(tx(1));
    expect(t.acks()).toEqual(["received 1"]);
    expect(h.core.calls).not.toContain("apply 1");
    h.clock.frame();
    expect(t.acks()).toEqual(["received 1", "applied 1", "submitted 1"]);
    expect(h.core.calls.slice(-2)).toEqual(["apply 1", "draw 1"]);
    expect(h.statuses).toEqual([
      { kind: "connecting" },
      { kind: "streaming", firstFrame: false },
      { kind: "streaming", firstFrame: true },
    ]);
    // Nothing applied in a callback with nothing queued.
    h.clock.frame();
    expect(t.acks()).toHaveLength(3);
    expect(h.loop.stats().applied).toBe(1);
  });

  it("stats() counts the core's structural applies and keeps the last apply's why", () => {
    const h = streaming(2);
    const t = h.last();
    expect(h.loop.stats()).toMatchObject({
      structuralApplies: 0,
      lastApplyWhy: 0,
      backBufferItems: 0,
    });
    h.core.facts = { structural: true, why: 1, backBufferItems: 2 };
    t.on.message(tx(1));
    h.clock.frame();
    h.core.facts = { structural: false, why: 0, backBufferItems: 2 };
    t.on.message(tx(2));
    h.clock.frame();
    expect(h.loop.stats()).toMatchObject({
      applied: 2,
      structuralApplies: 1,
      lastApplyWhy: 0,
      backBufferItems: 2,
    });
    h.core.facts = { structural: true, why: 16384, backBufferItems: 2 };
    t.on.message(tx(3));
    h.clock.frame();
    expect(h.loop.stats()).toMatchObject({
      structuralApplies: 2,
      lastApplyWhy: 16384,
    });
  });

  it("stats() carries the last apply's viewport surface counts (render-stream/16), 0 without them", () => {
    const h = streaming(2);
    const t = h.last();
    const zero = {
      surfacesRendered: 0,
      surfacesSkipped: 0,
      surfacesUnchanged: 0,
      surfacesAllocated: 0,
      surfacePixels: 0,
    };
    expect(h.loop.stats()).toMatchObject(zero);
    h.core.facts = {
      structural: false,
      why: 0,
      backBufferItems: 0,
      surfacesRendered: 2,
      surfacesSkipped: 3,
      surfacesUnchanged: 1,
      surfacesAllocated: 4,
      surfacePixels: 1550000,
    };
    t.on.message(tx(1));
    h.clock.frame();
    expect(h.loop.stats()).toMatchObject({
      surfacesRendered: 2,
      surfacesSkipped: 3,
      surfacesUnchanged: 1,
      surfacesAllocated: 4,
      surfacePixels: 1550000,
    });
    h.core.facts = { structural: false, why: 0, backBufferItems: 0 };
    t.on.message(tx(2));
    h.clock.frame();
    expect(h.loop.stats()).toMatchObject(zero);
  });

  it("stats().carrier names the open connection's carrier, else null", () => {
    const h = streaming(2);
    expect(h.loop.stats().carrier).toBeNull();
    h.last().carrier = "webtransport";
    expect(h.loop.stats().carrier).toBe("webtransport");
    h.last().on.close(1006, "gone");
    expect(h.loop.stats().carrier).toBeNull();
  });

  it("window 2: queued transactions apply in one callback, each acked in order", () => {
    const h = streaming(2);
    const t = h.last();
    t.on.message(tx(1));
    t.on.message(tx(2));
    h.clock.frame();
    expect(h.core.calls.filter((c) => c.startsWith("apply"))).toEqual([
      "apply 2",
    ]);
    expect(t.acks()).toEqual([
      "received 1",
      "received 2",
      "applied 1",
      "applied 2",
      "submitted 1",
      "submitted 2",
    ]);
    expect(h.core.calls).not.toContain("rebuild 2");
  });

  it("window 2: a transaction arriving while one fetches folds into it in place", async () => {
    const h = streaming(2, WAIT);
    const t = h.last();
    t.on.message(tx(1, ["aa"]));
    h.clock.frame(); // takes seq 1, issues the GET
    expect(t.gets.map((g) => g.path)).toEqual(["/resources/sha256/aa"]);
    t.on.message(tx(2, ["aa", "bb"], false));
    h.clock.frame();
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame(); // polls aa, issues bb
    expect(t.gets.map((g) => g.path)).toEqual([
      "/resources/sha256/aa",
      "/resources/sha256/bb",
    ]);
    t.gets[1].resolve(200);
    await flush();
    h.clock.frame();
    expect(
      h.core.calls.filter((c) => /^(apply|stage|provide)/.test(c)),
    ).toEqual(["stage aa", "stage bb", "provide", "provide", "apply 2"]);
    expect(t.acks().slice(2)).toEqual([
      "applied 1",
      "applied 2",
      "submitted 1",
      "submitted 2",
    ]);
  });

  it("window 1 (the host's grant): a superseded transaction rebuilds for the newest", () => {
    const h = streaming(1);
    const t = h.last();
    t.on.message(tx(1));
    t.on.message(tx(2, [], false));
    h.clock.frame();
    expect(h.core.calls.filter((c) => /^(apply|rebuild)/.test(c))).toEqual([
      "rebuild 2",
      "apply 2",
    ]);
    expect(t.acks()).toEqual([
      "received 1",
      "received 2",
      "applied 2",
      "submitted 2",
    ]);
  });

  it("the end record: drains, closes first (1000), then reports ended", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1));
    t.on.message(msg({ kind: "end" }));
    h.clock.frame(); // applies seq 1 and starts draining
    expect(t.closed).toEqual({ code: 1000, reason: "end seen" });
    t.on.close(1000, "");
    h.clock.frame();
    expect(h.statuses.at(-1)).toEqual({ kind: "ended" });
    expect(h.loop.state).toBe("ended");
    expect(h.clock.pendingFrames()).toBe(0);
  });

  it("a host error text is failed host-error with its reason and detail", () => {
    const h = streaming();
    h.last().on.message(
      JSON.stringify({
        type: "error",
        reason: "window-overrun",
        detail: "too far",
      }),
    );
    expect(h.statuses.at(-1)).toEqual({
      kind: "failed",
      reason: "host-error",
      detail: "window-overrun: too far",
    });
    expect(h.last().closed?.code).toBe(1000);
  });

  it("unauthorized (text or close 1008) is live-connect-failed with detail unauthorized", () => {
    const a = harness();
    a.loop.connect();
    a.last().on.open();
    a.last().on.message(
      JSON.stringify({ type: "error", reason: "unauthorized", detail: "x" }),
    );
    expect(a.statuses.at(-1)).toEqual({
      kind: "failed",
      reason: "live-connect-failed",
      detail: "unauthorized",
    });
    const b = harness();
    b.loop.connect();
    b.last().on.open();
    b.last().on.close(1008, "unauthorized");
    b.clock.frame();
    expect(b.statuses.at(-1)).toEqual({
      kind: "failed",
      reason: "live-connect-failed",
      detail: "unauthorized",
    });
    // A refreshed descriptor and connect() start over.
    b.loop.setEndpoint({
      url: "ws://h/x",
      resourceBase: "",
      token: null,
      protocol: 12,
    });
    b.loop.connect();
    expect(b.transports).toHaveLength(2);
    expect(b.statuses.at(-1)).toEqual({ kind: "connecting" });
  });

  it("a first connection that never opens is live-connect-failed", () => {
    const h = harness();
    h.loop.connect();
    h.last().on.close(1006, "");
    h.clock.frame();
    expect(h.statuses.at(-1)).toMatchObject({
      kind: "failed",
      reason: "live-connect-failed",
    });
  });

  it("1002/1008/1009 closes are host-error, never retried", () => {
    for (const code of [1002, 1008, 1009]) {
      const h = streaming();
      h.last().on.message(tx(1));
      h.clock.frame();
      h.last().on.close(code, "why");
      h.clock.frame();
      expect(h.statuses.at(-1)).toMatchObject({
        kind: "failed",
        reason: "host-error",
      });
      expect(h.transports).toHaveLength(1);
    }
  });

  it("loss reconnects as a fresh session after 1, 2, 4, 8 s, then every 10 s", () => {
    const h = streaming();
    h.last().on.message(tx(1));
    h.clock.frame();
    h.last().on.close(1006, "");
    h.clock.frame();
    expect(h.core.calls).toContain("reset true");
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const s = h.statuses.at(-1);
      expect(s).toMatchObject({ kind: "reconnecting", attempt: i + 1 });
      delays.push((s as { inMs: number }).inMs);
      const before = h.transports.length;
      h.clock.advance(delays[i] - 1);
      expect(h.transports).toHaveLength(before);
      h.clock.advance(1);
      expect(h.transports).toHaveLength(before + 1);
      // The attempt does not open.
      h.last().on.close(1006, "");
      h.clock.frame();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
    expect([...RECONNECT_BACKOFF_MS]).toEqual([1000, 2000, 4000, 8000, 10000]);
    // An attempt that opens and draws resets the backoff.
    h.clock.advance(10000);
    const t = h.last();
    t.on.open();
    t.on.message(session());
    expect(h.statuses.at(-1)).toEqual({ kind: "streaming", firstFrame: false });
    t.on.message(tx(5, [], true));
    h.clock.frame();
    expect(h.statuses.at(-1)).toEqual({ kind: "streaming", firstFrame: true });
    t.on.close(1006, "");
    h.clock.frame();
    expect(h.statuses.at(-1)).toEqual({
      kind: "reconnecting",
      attempt: 1,
      inMs: 1000,
    });
  });

  it("sends each ack as the JSON.stringify text of its object, keys in wire order", () => {
    const h = streaming();
    const t = h.last();
    h.clock.step = 0.37;
    t.on.message(tx(1));
    t.on.message(tx(2));
    h.clock.frame();
    t.on.message(tx(3));
    h.clock.frame();
    const acks = t.texts.filter((x) => x.startsWith('{"type":"ack"'));
    expect(acks).toHaveLength(9);
    for (const text of acks) {
      const m = JSON.parse(text);
      expect(text).toBe(
        JSON.stringify({
          type: "ack",
          stream_id: "st",
          seq: m.seq,
          stage: m.stage,
          t_us: m.t_us,
        }),
      );
      expect(Number.isInteger(m.t_us)).toBe(true);
    }
  });

  it("a coding failure asks a coding resync and rebuilds for the full", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    t.on.message(msg({ kind: "coding-resync", seq: 2, error: "coding: base" }));
    expect(h.core.calls).toContain("transport_skip");
    expect(t.sent.at(-1)).toEqual({
      type: "resync",
      stream_id: "st",
      seq: 2,
      reason: "coding",
    });
    t.on.message(msg({ kind: "held" }));
    t.on.message(tx(4, [], true));
    h.clock.frame();
    expect(h.core.calls.slice(-3)).toEqual(["rebuild 4", "apply 4", "draw 4"]);
  });

  it("a GET refused for authorization (401) is fatal resource-unavailable", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1, ["aa"]));
    h.clock.frame();
    t.gets[0].resolve(401);
    await flush();
    h.clock.frame();
    expect(h.statuses.at(-1)).toMatchObject({
      kind: "failed",
      reason: "resource-unavailable",
    });
  });

  it("up to four GETs go out at once; completions in any order provide in wasm's order", async () => {
    const h = streaming(2, WAIT);
    const t = h.last();
    const need = ["a1", "a2", "a3", "a4", "a5"];
    t.on.message(tx(1, need));
    h.clock.frame();
    expect(t.gets.map((g) => g.path.split("/").at(-1))).toEqual(
      need.slice(0, 4),
    );
    for (const i of [3, 0, 2]) t.gets[i].resolve(200);
    await flush();
    h.clock.frame(); // a5 goes out
    expect(t.gets).toHaveLength(5);
    expect(h.core.calls).not.toContain("apply 1");
    t.gets[4].resolve(200);
    t.gets[1].resolve(200);
    await flush();
    h.clock.frame();
    expect(
      h.core.calls.filter((c) => /^(apply|stage|provide)/.test(c)),
    ).toEqual([
      "stage a4",
      "stage a1",
      "stage a3",
      "stage a5",
      "stage a2",
      "provide",
      "provide",
      "provide",
      "provide",
      "provide",
      "apply 1",
    ]);
  });

  it("a fatal GET (403) aborts the others in flight and fails for its transaction", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1, ["b1", "b2", "b3"]));
    h.clock.frame();
    t.gets[1].resolve(403);
    await flush();
    expect([t.gets[0].aborted, t.gets[2].aborted]).toEqual([true, true]);
    h.clock.frame();
    expect(h.statuses.at(-1)).toMatchObject({
      kind: "failed",
      reason: "resource-unavailable",
    });
  });

  it("a context loss holds the loop, and the restore redraws in place", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    h.loop.contextLost();
    t.on.message(tx(2, [], false));
    h.clock.frame();
    expect(h.core.calls).not.toContain("apply 2");
    expect(t.acks()).toEqual([
      "received 1",
      "applied 1",
      "submitted 1",
      "received 2",
    ]);
    h.loop.contextRestored();
    h.clock.frame();
    expect(h.core.calls.at(-1)).toBe("redraw 1");
    h.clock.frame();
    expect(h.core.calls.at(-1)).toBe("draw 2");
  });

  it("dispose is idempotent and silences the old connection", () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1, ["aa"]));
    h.clock.frame();
    const n = h.statuses.length;
    h.loop.dispose();
    h.loop.dispose();
    expect(t.closes).toBe(1);
    expect(t.closed).toEqual({ code: 1000, reason: "dispose" });
    expect(t.gets[0].aborted).toBe(true);
    expect(h.clock.pendingFrames()).toBe(0);
    t.on.message(tx(2));
    t.on.close(1006, "");
    h.loop.connect();
    expect(h.statuses).toHaveLength(n);
    expect(h.transports).toHaveLength(1);
    expect(h.loop.state).toBe("disposed");
  });
  it("PH3 defaults: credit stage applied, apply on message", () => {
    const h = streaming(2, {});
    const t = h.last();
    expect(t.sent[0]).toMatchObject({ credit_stage: "applied" });
    t.on.message(tx(1));
    h.clock.frame();
    t.on.message(tx(2, [], false));
    // Applied (acked) in onmessage; the applier runs before the frame's draw.
    expect(t.acks().at(-1)).toBe("applied 2");
    expect(h.core.calls).not.toContain("apply 2");
    h.clock.frame();
    expect(h.core.calls.slice(-2)).toEqual(["apply 2", "draw 2"]);
  });

  it("PH3 credit stage applied: the hello asks it", () => {
    const h = streaming(2, { creditStage: "applied" });
    expect(h.last().sent[0]).toMatchObject({
      credit_stage: "applied",
      credit_window: 2,
    });
  });

  it("PH3 apply on message: applies in onmessage once frames run, runs the applier and draws once at the frame", () => {
    const h = streaming(2, { applyOn: "message", creditStage: "applied" });
    const t = h.last();
    t.on.message(tx(1));
    // No frame callback yet on this loop: the first transaction waits for one.
    expect(h.core.calls).not.toContain("apply 1");
    h.clock.frame();
    expect(t.acks()).toEqual(["received 1", "applied 1", "submitted 1"]);
    const prepares = h.core.prepareApplies;
    t.on.message(tx(2, [], false));
    t.on.message(tx(3, [], false));
    expect(h.core.calls.filter((c) => /^(apply|draw)/.test(c))).toEqual([
      "apply 1",
      "draw 1",
    ]);
    expect(t.acks().slice(3)).toEqual([
      "received 2",
      "applied 2",
      "received 3",
      "applied 3",
    ]);
    h.clock.frame();
    // Two transactions between frame callbacks: one run of the applier (and of its glue).
    expect(h.core.calls.filter((c) => /^(apply|draw)/.test(c))).toEqual([
      "apply 1",
      "draw 1",
      "apply 3",
      "draw 3",
    ]);
    expect(h.core.prepareApplies).toBe(prepares + 1);
    expect(t.acks().slice(7)).toEqual(["submitted 2", "submitted 3"]);
    expect(h.loop.stats().applied).toBe(3);
    // A frame with nothing applied draws nothing.
    h.clock.frame();
    expect(h.core.calls.at(-1)).toBe("draw 3");
  });

  it("PH3 apply on message: no frame callback for the gap (a hidden page) holds the apply", () => {
    const h = streaming(2, { applyOn: "message", creditStage: "applied" });
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    h.clock.t += MESSAGE_APPLY_MAX_FRAME_GAP_MS + 1;
    t.on.message(tx(2, [], false));
    expect(h.core.calls).not.toContain("apply 2");
    expect(t.acks().at(-1)).toBe("received 2");
    h.clock.frame();
    expect(t.acks().slice(-2)).toEqual(["applied 2", "submitted 2"]);
  });

  it("PH3 apply on message: a transaction with payloads fetches at once and applies at a frame", async () => {
    const h = streaming(2, { applyOn: "message", resourceHoldMs: Infinity });
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    t.on.message(tx(2, ["aa"], false));
    expect(t.gets.map((g) => g.path)).toEqual(["/resources/sha256/aa"]);
    expect(h.core.calls).not.toContain("apply 2");
    t.on.message(tx(3, [], false)); // folds into the pending one
    expect(h.core.calls).not.toContain("apply 3");
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls.filter((c) => /^(apply|draw)/.test(c))).toEqual([
      "apply 1",
      "draw 1",
      "apply 3",
      "draw 3",
    ]);
    expect(t.acks().slice(-4)).toEqual([
      "applied 2",
      "applied 3",
      "submitted 2",
      "submitted 3",
    ]);
  });

  it("PH3 apply on message: a context loss holds applies; the restore redraw acks the undrawn", () => {
    const h = streaming(2, { applyOn: "message", creditStage: "applied" });
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    t.on.message(tx(2, [], false));
    h.loop.contextLost();
    t.on.message(tx(3, [], false));
    expect(h.core.calls).not.toContain("apply 3");
    h.clock.frame();
    // Nothing runs while lost; 3, accepted meanwhile, is in the core's prepared state, so the
    // due run waits for it: the restore redraws the last run's state.
    expect(h.core.calls).not.toContain("apply 2");
    h.loop.contextRestored();
    h.clock.frame();
    expect(h.core.calls.slice(-2)).toEqual(["draw 1", "redraw 2"]);
    expect(t.acks().filter((a) => a.startsWith("submitted"))).toEqual([
      "submitted 1",
    ]);
    h.clock.frame();
    expect(h.core.calls.slice(-2)).toEqual(["apply 3", "draw 3"]);
    expect(t.acks().filter((a) => a.startsWith("submitted"))).toEqual([
      "submitted 1",
      "submitted 2",
      "submitted 3",
    ]);
  });

  it("J1: a callback that only draws a transaction applied in onmessage settles no particles (one apply per frame)", () => {
    const h = streaming(2, { applyOn: "message", creditStage: "applied" });
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    // Its payload is already staged: the run goes in onmessage, leaving 2 applied and undrawn.
    h.core.staged.add("aa");
    t.on.message(tx(2, ["aa"], false));
    expect(h.core.calls).toContain("apply 2");
    h.core.logPolls = true;
    h.core.particleSettles = [true];
    h.core.calls.length = 0;
    h.clock.frame();
    expect(h.core.calls).toEqual(["poll-programs", "draw 2"]);
    // The next idle callback settles.
    h.core.calls.length = 0;
    h.clock.frame();
    expect(h.core.calls).toEqual([
      "poll-programs",
      "settle-particles 2",
      "draw 2",
    ]);
  });

  it("PH3 apply on message: past the undrawn cap, arrivals wait for the frame callback", () => {
    const h = streaming(2, { applyOn: "message", creditStage: "applied" });
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    const n = MESSAGE_APPLY_MAX_UNDRAWN;
    for (let s = 2; s < 2 + n + 2; s++) t.on.message(tx(s, [], false));
    const applies = () => h.core.calls.filter((c) => c.startsWith("apply"));
    // The first `n` apply at once (the applier waits for the frame); the rest wait, unacked
    // `applied` (no credit), for the frame.
    expect(applies()).toHaveLength(1);
    expect(t.acks().filter((a) => a.startsWith("applied"))).toHaveLength(1 + n);
    h.clock.frame();
    // The frame applies the newest waiting one (the older ones fold into it): one run, one draw.
    expect(applies()).toEqual(["apply 1", `apply ${1 + n + 2}`]);
    expect(h.core.calls.at(-1)).toBe(`draw ${1 + n + 2}`);
    expect(t.acks().filter((a) => a.startsWith("submitted"))).toHaveLength(
      1 + n + 2,
    );
  });

  it("applied transactions a hidden page leaves undrawn run with the next arrivals at the frame", () => {
    const h = streaming(2, { applyOn: "message", creditStage: "applied" });
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    t.on.message(tx(2, [], false));
    expect(t.acks().at(-1)).toBe("applied 2");
    // The page hides: no frame callback, so the next arrival gets no credit.
    h.clock.t += MESSAGE_APPLY_MAX_FRAME_GAP_MS + 1;
    t.on.message(tx(3, [], false));
    expect(t.acks().at(-1)).toBe("received 3");
    expect(h.core.calls).not.toContain("apply 2");
    h.clock.frame();
    expect(h.core.calls.filter((c) => /^(apply|draw)/.test(c))).toEqual([
      "apply 1",
      "draw 1",
      "apply 3",
      "draw 3",
    ]);
    expect(t.acks().slice(-3)).toEqual([
      "applied 3",
      "submitted 2",
      "submitted 3",
    ]);
  });

  it("an applied transaction waits, undrawn, with a later one holding for its payloads", async () => {
    const h = streaming(2, { applyOn: "message", resourceHoldMs: Infinity });
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    t.on.message(tx(2, [], false));
    t.on.message(tx(3, ["aa"], false));
    expect(t.acks().filter((a) => a.startsWith("applied"))).toEqual([
      "applied 1",
      "applied 2",
    ]);
    // The core's prepared state holds 2 and 3: nothing runs or draws until 3's payload is in.
    h.clock.frame();
    expect(h.core.calls.filter((c) => /^(apply|draw)/.test(c))).toEqual([
      "apply 1",
      "draw 1",
    ]);
    expect(t.acks()).not.toContain("submitted 2");
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    const runs = h.core.calls.filter((c) => /^(apply|draw)/.test(c));
    expect(runs).toEqual(["apply 1", "draw 1", "apply 3", "draw 3"]);
    expect(t.acks().slice(-3)).toEqual([
      "applied 3",
      "submitted 2",
      "submitted 3",
    ]);
  });

  it("a deferred payload arriving while a run is due goes in with that run (no revisit)", async () => {
    const h = streaming(2, { applyOn: "message", resourceHoldMs: 0 });
    const t = h.last();
    t.on.message(tx(1, ["aa"]));
    h.clock.frame();
    // The hold is 0: 1 applied without "aa", which stays deferred and in flight.
    expect(h.core.calls).toContain("defer aa");
    t.on.message(tx(2, [], false));
    expect(t.acks().at(-1)).toBe("applied 2");
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.core.calls).not.toContain("revisit 2");
    expect(h.core.calls.slice(-2)).toEqual(["apply 2", "draw 2"]);
  });

  it("a transaction queued during a context loss, naming an uncached payload, is fetched before the due run", async () => {
    const h = streaming(2, {
      applyOn: "message",
      creditStage: "applied",
      resourceHoldMs: Infinity,
    });
    h.core.enforceProvided = true;
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    t.on.message(tx(2, [], false));
    expect(t.acks().at(-1)).toBe("applied 2");
    h.loop.contextLost();
    t.on.message(tx(3, ["aa"], false));
    h.clock.frame();
    h.loop.contextRestored();
    h.clock.frame();
    expect(h.loop.state).toBe("streaming");
    // The restore redraws the last run's state; nothing runs before 3's payload is in.
    expect(h.core.calls).not.toContain("apply 2");
    expect(t.acks()).not.toContain("submitted 2");
    // The next callback takes 3: its fetch starts, and nothing runs or draws without it.
    h.clock.frame();
    expect(h.loop.state).toBe("streaming");
    expect(h.core.calls).not.toContain("apply 2");
    expect(t.gets.map((g) => g.path)).toEqual(["/resources/sha256/aa"]);
    t.gets[0].resolve(200);
    await flush();
    h.clock.frame();
    expect(h.loop.state).toBe("streaming");
    const runs = h.core.calls.filter((c) => /^(apply|draw)/.test(c));
    expect(runs).toEqual(["apply 1", "draw 1", "apply 3", "draw 3"]);
    expect(h.core.calls.indexOf("provide")).toBeLessThan(
      h.core.calls.indexOf("apply 3"),
    );
    expect(t.acks().slice(-3)).toEqual([
      "applied 3",
      "submitted 2",
      "submitted 3",
    ]);
  });

  it("a payload-free transaction queued during a context loss is taken before the due run", () => {
    const h = streaming(2, { applyOn: "message", creditStage: "applied" });
    h.core.enforceProvided = true;
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    t.on.message(tx(2, [], false));
    h.loop.contextLost();
    t.on.message(tx(3, [], false));
    h.clock.frame();
    h.loop.contextRestored();
    h.clock.frame();
    expect(h.core.calls).not.toContain("apply 2");
    h.clock.frame();
    const runs = h.core.calls.filter((c) => /^(apply|draw|redraw)/.test(c));
    // The redraw shows the last run's state (labelled with the newest applied seq).
    expect(runs).toEqual([
      "apply 1",
      "draw 1",
      "redraw 2",
      "apply 3",
      "draw 3",
    ]);
    expect(t.acks().filter((a) => a.startsWith("submitted"))).toEqual([
      "submitted 1",
      "submitted 2",
      "submitted 3",
    ]);
  });

  it("PH3: the acks of one apply, and of one draw, share their t_us (a fold is one instant)", () => {
    const h = streaming(2);
    const t = h.last();
    h.clock.step = 0.3;
    t.on.message(tx(1));
    t.on.message(tx(2, [], false));
    h.clock.frame();
    const at = (stage: string) =>
      t.sent
        .filter((m) => m.type === "ack" && m.stage === stage)
        .map((m) => m.t_us);
    expect(at("applied")).toHaveLength(2);
    expect(new Set(at("applied")).size).toBe(1);
    expect(new Set(at("submitted")).size).toBe(1);
    expect(new Set(at("received")).size).toBe(2);
  });
});

describe("rolling damage diagnostics", () => {
  it("counts successful draws and reports medians over the last second", () => {
    const h = streaming();
    const d = { mode: 1, us: 200, permille: 1000, regions: 1 };
    Object.assign(h.core, { damageStats: () => d });
    expect(h.loop.stats()).toMatchObject({
      damageModeCounts: [0, 0, 0, 0],
      damageUsP50: null,
    });
    for (let seq = 1; seq <= 3; seq++) {
      d.mode = seq;
      d.us = [200, 40, 0][seq - 1];
      d.permille = [1000, 256, 0][seq - 1];
      d.regions = [1, 8, 0][seq - 1];
      h.last().on.message(tx(seq));
      h.clock.frame();
    }
    expect(h.loop.stats()).toMatchObject({
      damageModeCounts: [0, 1, 1, 1],
      damageUsP50: 40,
      damagePermilleP50: 256,
      damageRegionsP50: 1,
    });
    h.clock.t += 1001;
    expect(h.loop.stats()).toMatchObject({
      damageModeCounts: [0, 0, 0, 0],
      damageUsP50: null,
      damagePermilleP50: null,
      damageRegionsP50: null,
    });
    h.loop.dispose();
  });

  it("keeps a bounded ring when more than 256 draws fit the window", () => {
    const h = streaming();
    Object.assign(h.core, {
      damageStats: () => ({ mode: 2, us: 5, permille: 25, regions: 4 }),
    });
    for (let seq = 1; seq <= 300; seq++) {
      h.last().on.message(tx(seq));
      h.clock.frame(1);
    }
    expect(h.loop.stats()).toMatchObject({
      damageModeCounts: [0, 0, 256, 0],
      damageUsP50: 5,
    });
    h.loop.dispose();
  });
});
