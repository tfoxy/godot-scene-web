import { describe, expect, it } from "vitest";
import {
  type LoopOptions,
  MESSAGE_APPLY_MAX_FRAME_GAP_MS,
  MESSAGE_APPLY_MAX_UNDRAWN,
  RECONNECT_BACKOFF_MS,
} from "../src/loop";
import { flush, harness, msg, session, tx } from "./fakes";

/** Connects and opens the first connection, then delivers its session. */
/** The MIR-1 loop (credit at `submitted`, apply in the frame callback) unless `pacing` says. */
function streaming(
  window: 1 | 2 = 2,
  pacing: Pick<LoopOptions, "creditStage" | "applyOn"> = {
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
    const h = streaming(2);
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

  it("a GET that fails is resource-unavailable", async () => {
    const h = streaming();
    const t = h.last();
    t.on.message(tx(1, ["aa"]));
    h.clock.frame();
    t.gets[0].resolve(404);
    await flush();
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
    expect(h.core.calls.at(-1)).toBe("apply 2");
  });

  it("PH3 credit stage applied: the hello asks it", () => {
    const h = streaming(2, { creditStage: "applied" });
    expect(h.last().sent[0]).toMatchObject({
      credit_stage: "applied",
      credit_window: 2,
    });
  });

  it("PH3 apply on message: applies in onmessage once frames run, draws once at the frame", () => {
    const h = streaming(2, { applyOn: "message", creditStage: "applied" });
    const t = h.last();
    t.on.message(tx(1));
    // No frame callback yet on this loop: the first transaction waits for one.
    expect(h.core.calls).not.toContain("apply 1");
    h.clock.frame();
    expect(t.acks()).toEqual(["received 1", "applied 1", "submitted 1"]);
    t.on.message(tx(2, [], false));
    t.on.message(tx(3, [], false));
    expect(h.core.calls.filter((c) => /^(apply|draw)/.test(c))).toEqual([
      "apply 1",
      "draw 1",
      "apply 2",
      "apply 3",
    ]);
    expect(t.acks().slice(3)).toEqual([
      "received 2",
      "applied 2",
      "received 3",
      "applied 3",
    ]);
    h.clock.frame();
    expect(h.core.calls.at(-1)).toBe("draw 3");
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
    const h = streaming(2, { applyOn: "message" });
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
    expect(h.core.calls.at(-1)).toBe("apply 2");
    h.loop.contextRestored();
    h.clock.frame();
    expect(h.core.calls.at(-1)).toBe("redraw 2");
    expect(t.acks().filter((a) => a.startsWith("submitted"))).toEqual([
      "submitted 1",
      "submitted 2",
    ]);
    h.clock.frame();
    expect(h.core.calls.slice(-2)).toEqual(["apply 3", "draw 3"]);
  });

  it("PH3 apply on message: past the undrawn cap, arrivals wait for the frame callback", () => {
    const h = streaming(2, { applyOn: "message", creditStage: "applied" });
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    const n = MESSAGE_APPLY_MAX_UNDRAWN;
    for (let s = 2; s < 2 + n + 2; s++) t.on.message(tx(s, [], false));
    const applies = () => h.core.calls.filter((c) => c.startsWith("apply"));
    // The first `n` apply at once; the rest wait, unacked `applied` (no credit), for the frame.
    expect(applies()).toHaveLength(1 + n);
    expect(t.acks().filter((a) => a.startsWith("applied"))).toHaveLength(1 + n);
    h.clock.frame();
    // The frame applies the newest waiting one (the older folds into it) and draws once.
    expect(applies().at(-1)).toBe(`apply ${1 + n + 2}`);
    expect(h.core.calls.at(-1)).toBe(`draw ${1 + n + 2}`);
    expect(t.acks().filter((a) => a.startsWith("submitted"))).toHaveLength(
      1 + n + 2,
    );
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
