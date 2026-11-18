import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CoreMotion } from "../src/core";
import {
  FRAME_CAP_QUIET_MS,
  frameCapLimits,
  IDLE_ANIMATION_COLOR_STEP_MAX,
  IDLE_ANIMATION_MAX_PX,
  IDLE_COLOR_STEP_MAX,
  IDLE_MOTION_MAX_PX,
  motionWake,
} from "../src/frame-cap";
import type { LoopOptions } from "../src/loop";
import { FakeCore, flush, harness, msg, session, tx } from "./fakes";

type Pacing = Pick<
  LoopOptions,
  "creditStage" | "applyOn" | "resourceHoldMs" | "frameCap" | "frameCapBounds"
>;

function streaming(pacing: Pacing = { frameCap: "automatic" }, window = 2) {
  const h = harness(2, pacing, new FakeCore());
  h.loop.connect();
  h.last().on.open();
  h.last().on.message(session(window));
  return h;
}

type H = ReturnType<typeof streaming>;

const draws = (h: H) =>
  h.core.calls.filter((c) => c.startsWith("draw ")).length;

/** One host frame: transaction `seq` arrives, then the frame callback runs. Whether it drew. */
function vsync(h: H, seq: number): boolean {
  h.last().on.message(tx(seq));
  const before = draws(h);
  h.clock.frame();
  return draws(h) > before;
}

/** The FakeClock's frame callbacks are 16.7 ms apart, and the session (t = 0) is activity: the
 * first callback at or past the quiet period engages the cap (and presents). */
const ENGAGE = Math.ceil(FRAME_CAP_QUIET_MS / 16.7);

/** Streams `n` host frames from `from`; the callbacks' answers. */
function run(h: H, from: number, n: number): boolean[] {
  const out: boolean[] = [];
  for (let s = from; s < from + n; s++) out.push(vsync(h, s));
  return out;
}

/** Strictly alternating, starting with a present. */
const alternating = (n: number, first = true) =>
  Array.from({ length: n }, (_, i) => (i % 2 === 0) === first);

describe("idle frame cap", () => {
  it("is off by default: every callback draws, nothing is measured", () => {
    const h = streaming({});
    expect(run(h, 1, 3 * ENGAGE)).toEqual(Array(3 * ENGAGE).fill(true));
    expect(h.loop.stats()).toMatchObject({
      frameCap: "off",
      frameCapEngaged: false,
      cappedFrames: 0,
      skippedFrames: 0,
    });
    expect(h.core.setMotionCalls).toEqual([]);
    expect(h.core.motionReads).toBe(0);
  });

  it("automatic presents every other callback after the quiet period under ambient motion", () => {
    const h = streaming();
    expect(h.core.setMotionCalls).toEqual([true]);
    const drew = run(h, 1, ENGAGE + 100);
    // Every callback before the quiet period ends, then the engaging one presents and the
    // callbacks alternate: an even 30 fps on a 60 Hz panel.
    expect(drew.slice(0, ENGAGE)).toEqual(Array(ENGAGE).fill(true));
    expect(drew.slice(ENGAGE - 1)).toEqual(alternating(101));
    expect(h.loop.stats()).toMatchObject({
      frameCap: "automatic",
      frameCapEngaged: true,
      cappedFrames: 101,
      skippedFrames: 50,
      applied: ENGAGE + 100,
    });
  });

  it("keeps acking at the host's rate while capped: applied at receipt, submitted with the draw", () => {
    const h = streaming();
    run(h, 1, ENGAGE);
    const t = h.last();
    for (let s = ENGAGE + 1; s <= ENGAGE + 40; s++) {
      t.on.message(tx(s));
      // Received and applied in the message's own event, whether or not the next callback draws.
      expect(t.acks().slice(-2)).toEqual([`received ${s}`, `applied ${s}`]);
      h.clock.frame();
    }
    const acks = t.acks();
    for (let s = 1; s <= ENGAGE + 40; s++) {
      expect(acks).toContain(`received ${s}`);
      expect(acks).toContain(`applied ${s}`);
    }
    // A skipped callback's transaction is acked `submitted` with the next draw, which shows it.
    const skipped = ENGAGE + 1;
    const submits = t.sent.filter(
      (m) =>
        m.type === "ack" &&
        m.stage === "submitted" &&
        (m.seq === skipped || m.seq === skipped + 1),
    );
    expect(submits.map((m) => m.seq)).toEqual([skipped, skipped + 1]);
    expect(submits[0].t_us).toBe(submits[1].t_us);
    // Every applied transaction up to the last drawn one is submitted: nothing is lost.
    const last = ENGAGE + 39; // the last presenting callback
    for (let s = 1; s <= last; s++) expect(acks).toContain(`submitted ${s}`);
  });

  it("keeps the host's rate with frame-paced applies and folds at window 2", () => {
    const h = streaming({
      frameCap: "automatic",
      applyOn: "frame",
      creditStage: "submitted",
    });
    run(h, 1, ENGAGE);
    const t = h.last();
    let seq = ENGAGE;
    // A host faster than the panel: two transactions per callback, both applied in it.
    for (let f = 0; f < 20; f++) {
      t.on.message(tx(++seq));
      t.on.message(tx(++seq));
      h.clock.frame();
      expect(t.acks()).toContain(`applied ${seq - 1}`);
      expect(t.acks()).toContain(`applied ${seq}`);
    }
    expect(h.loop.stats().applied).toBe(seq);
    expect(h.loop.stats().skippedFrames).toBe(10);
    // The last callback presented: everything is submitted.
    for (let s = 1; s <= seq; s++) expect(t.acks()).toContain(`submitted ${s}`);
  });

  it("wakes on the same callback for wake() and stays awake for the quiet period", () => {
    const h = streaming();
    run(h, 1, ENGAGE); // the engaging callback presented: the next one would skip
    h.loop.wake();
    expect(h.loop.stats().frameCapWake).toBe("input");
    const drew = run(h, ENGAGE + 1, ENGAGE + 3);
    expect(h.loop.stats().frameCapEngaged).toBe(true);
    // Awake for the whole quiet period from the wake, then even 30 fps again.
    expect(drew.slice(0, ENGAGE)).toEqual(Array(ENGAGE).fill(true));
    expect(drew.slice(ENGAGE - 1)).toEqual(alternating(4));
  });

  it.each([
    [
      "a structural change",
      { changes: 2, maxPx: 0, colorStep: 0 },
      "structure",
    ],
    [
      "an appearance change",
      { changes: 16 | 32, maxPx: 0, colorStep: 0 },
      "appearance",
    ],
    ["a content change", { changes: 8, maxPx: 9, colorStep: 0 }, "content"],
    [
      "motion past the threshold",
      { changes: 0, maxPx: 3, colorStep: 0 },
      "motion",
    ],
    [
      "an unbounded motion",
      { changes: 0, maxPx: Infinity, colorStep: 0 },
      "motion",
    ],
    [
      "sub-viewport content",
      { changes: 128, maxPx: 0, colorStep: 0 },
      "viewport",
    ],
    ["a quick fade", { changes: 0, maxPx: 0, colorStep: 0.1 }, "colour"],
    [
      "animation that teleports",
      { changes: 0, maxPx: 0, colorStep: 0, animPx: 2 * IDLE_ANIMATION_MAX_PX },
      "animation",
    ],
    [
      "a change the receiver did not measure",
      { changes: 256, maxPx: 0, colorStep: 0 },
      "unmeasured",
    ],
  ])("wakes on the same callback for %s", (_name, facts, why) => {
    const h = streaming();
    run(h, 1, ENGAGE);
    h.core.motionFacts = facts;
    expect(vsync(h, ENGAGE + 1)).toBe(true);
    expect(h.loop.stats()).toMatchObject({
      frameCapEngaged: false,
      frameCapWake: why,
    });
    h.core.motionFacts = { changes: 0, maxPx: 0.01, colorStep: 0 };
    // The woken callback was the first of the new quiet period.
    const drew = run(h, ENGAGE + 2, ENGAGE + 2);
    expect(drew.slice(0, ENGAGE - 2)).toEqual(Array(ENGAGE - 2).fill(true));
    expect(drew.slice(ENGAGE - 2)).toEqual(alternating(4));
  });

  it("counts motion and colour steps up to the thresholds as ambient", () => {
    const h = streaming();
    h.core.motionFacts = {
      changes: 0,
      maxPx: IDLE_MOTION_MAX_PX,
      colorStep: IDLE_COLOR_STEP_MAX,
    };
    const drew = run(h, 1, ENGAGE + 9);
    expect(drew.slice(ENGAGE - 1)).toEqual(alternating(10));
  });

  it("counts animation up to its own bounds as ambient", () => {
    const h = streaming();
    h.core.motionFacts = {
      changes: 0,
      maxPx: 0,
      colorStep: 0,
      animPx: IDLE_ANIMATION_MAX_PX,
      animColorStep: IDLE_ANIMATION_COLOR_STEP_MAX,
    };
    const drew = run(h, 1, ENGAGE + 9);
    expect(drew.slice(ENGAGE - 1)).toEqual(alternating(10));
  });

  it("never wakes on animation colour by default, and does under a consumer's bound", () => {
    const flash = { changes: 0, maxPx: 0, colorStep: 0, animColorStep: 1 };
    const h = streaming();
    h.core.motionFacts = flash;
    expect(run(h, 1, ENGAGE + 9).slice(ENGAGE - 1)).toEqual(alternating(10));
    const b = streaming({
      frameCap: "automatic",
      frameCapBounds: { animationColorStep: 0.5 },
    });
    run(b, 1, ENGAGE);
    b.core.motionFacts = flash;
    expect(vsync(b, ENGAGE + 1)).toBe(true);
    expect(b.loop.stats().frameCapWake).toBe("animation colour");
  });

  it("takes new bounds at runtime, over the defaults", () => {
    const h = streaming();
    h.core.motionFacts = { changes: 0, maxPx: 0, colorStep: 0, animPx: 40 };
    run(h, 1, ENGAGE + 1);
    expect(h.loop.stats().frameCapEngaged).toBe(true);
    // A consumer that wants its animation calmer: 40 px now wakes.
    h.loop.setFrameCap("automatic", { animationPx: 16 });
    run(h, ENGAGE + 2, 3);
    expect(h.loop.stats()).toMatchObject({
      frameCapEngaged: false,
      frameCapWake: "animation",
    });
    // Omitted bounds keep the current ones; given ones replace them over the defaults.
    h.loop.setFrameCap("automatic");
    run(h, ENGAGE + 5, 2);
    expect(h.loop.stats().frameCapWake).toBe("animation");
    h.loop.setFrameCap("automatic", {});
    const drew = run(h, ENGAGE + 7, ENGAGE + 9);
    expect(drew.slice(ENGAGE - 1)).toEqual(alternating(10));
  });

  it("refuses a bound that is not a number at least 0", () => {
    expect(() => frameCapLimits({ animationPx: -1 })).toThrow(TypeError);
    expect(() => frameCapLimits({ colorStep: Number.NaN })).toThrow(TypeError);
    expect(frameCapLimits({ animationPx: 64 })).toEqual({
      motionPx: IDLE_MOTION_MAX_PX,
      colorStep: IDLE_COLOR_STEP_MAX,
      animationPx: 64,
      animationColorStep: Number.POSITIVE_INFINITY,
    });
  });

  it("never engages without motion facts (a core that cannot measure)", () => {
    const h = streaming();
    h.core.motionSupported = false;
    expect(run(h, 1, 3 * ENGAGE)).toEqual(Array(3 * ENGAGE).fill(true));
    expect(h.loop.stats()).toMatchObject({
      cappedFrames: 0,
      frameCapWake: "unmeasured",
    });
  });

  it("toggles at runtime: on counts as activity, off presents at once", () => {
    const h = streaming({});
    run(h, 1, ENGAGE);
    h.loop.setFrameCap("automatic");
    expect(h.core.setMotionCalls).toEqual([true]);
    const on = run(h, ENGAGE + 1, ENGAGE + 4);
    expect(on.slice(0, ENGAGE)).toEqual(Array(ENGAGE).fill(true));
    expect(on.slice(ENGAGE - 1)).toEqual(alternating(5));
    // Mid-cap, with the next callback due to skip.
    expect(on.at(-1)).toBe(true);
    h.loop.setFrameCap("off");
    expect(h.core.setMotionCalls).toEqual([true, false]);
    expect(run(h, 2 * ENGAGE + 5, 10)).toEqual(Array(10).fill(true));
    expect(h.loop.stats()).toMatchObject({
      frameCap: "off",
      frameCapEngaged: false,
      cappedFrames: 5,
      skippedFrames: 2,
    });
    const reads = h.core.motionReads;
    run(h, 2 * ENGAGE + 15, 5);
    expect(h.core.motionReads).toBe(reads);
  });

  it("draws a deferred payload's arrival in the callback that finds it, even one due to skip", async () => {
    const h = streaming();
    run(h, 1, ENGAGE - 1);
    const t = h.last();
    // The engaging (presenting) callback applies a transaction whose payload is still loading.
    t.on.message(tx(ENGAGE, ["h1"]));
    h.clock.frame();
    expect(h.loop.stats()).toMatchObject({
      frameCapEngaged: true,
      deferredPayloads: 1,
    });
    t.gets[0].resolve(200);
    await flush();
    const before = draws(h);
    h.clock.frame(); // due to skip
    expect(draws(h)).toBe(before + 1);
    expect(h.core.calls.slice(-2)).toEqual([
      `revisit ${ENGAGE}`,
      `draw ${ENGAGE}`,
    ]);
    expect(h.loop.stats()).toMatchObject({
      frameCapEngaged: false,
      frameCapWake: "payload",
    });
  });

  it("starts the quiet period over on a reconnect's session", () => {
    const h = streaming();
    run(h, 1, ENGAGE + 1);
    expect(h.loop.stats().frameCapEngaged).toBe(true);
    h.last().on.close(1006, "");
    h.clock.frame();
    h.clock.advance(1000);
    h.last().on.open();
    h.last().on.message(session());
    expect(h.loop.stats()).toMatchObject({
      frameCapEngaged: false,
      frameCapWake: "session",
    });
    const drew = run(h, 1, ENGAGE + 1);
    expect(drew.slice(0, ENGAGE)).toEqual(Array(ENGAGE).fill(true));
    expect(drew[ENGAGE]).toBe(false);
  });
  it("draws and acks the last state before draining when the end arrives in a skipped callback", () => {
    const h = streaming();
    run(h, 1, ENGAGE); // the engaging callback presented: the next one would skip
    const t = h.last();
    t.on.message(tx(ENGAGE + 1));
    t.on.message(msg({ kind: "end" }));
    h.clock.frame();
    expect(h.core.calls).toContain(`draw ${ENGAGE + 1}`);
    expect(t.acks()).toContain(`submitted ${ENGAGE + 1}`);
    expect(h.loop.state).toBe("draining");
    expect(h.loop.stats().frameCapWake).toBe("end");
  });
});

/** Motion facts that rs-core measured over 900 transactions of an idle game lobby (skeletal
 * character and background layers, CPU particle motes, a flipbook, a pulsing UI glow; see the
 * fixture's `about`). */
const lobby = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "lobby-motion.json"), "utf8"),
) as { fields: string[]; rows: (number | null)[][] };

function lobbyFacts(row: (number | null)[]): Omit<CoreMotion, "seq"> {
  const n = (v: number | null | undefined) =>
    v === null ? Infinity : (v ?? 0);
  return {
    changes: n(row[0]),
    maxPx: n(row[1]),
    colorStep: n(row[2]),
    animPx: n(row[3]),
    animColorStep: n(row[4]),
  };
}

describe("frame cap on an idle lobby", () => {
  it("classifies at least 95% of its transactions as ambient", () => {
    expect(lobby.fields).toEqual([
      "changes",
      "max_px",
      "color_step",
      "anim_px",
      "anim_color",
    ]);
    const wakes = new Map<string, number>();
    lobby.rows.forEach((row, k) => {
      const why = motionWake({ seq: k + 1, ...lobbyFacts(row) }, k + 1);
      if (why !== null) wakes.set(why, (wakes.get(why) ?? 0) + 1);
    });
    const woken = [...wakes.values()].reduce((a, b) => a + b, 0);
    expect(1 - woken / lobby.rows.length).toBeGreaterThanOrEqual(0.95);
    // Its scene content (sub-pixel drift, the glow pulse) is always ambient, and nothing it does
    // every frame (particle buffers, version-only resource calls, the flipbook's later loops) is
    // a change. What wakes is an animation cut, and a mesh the host switches between its static
    // and dynamic encoding (three times in this window); animation colour never does by default.
    for (const why of [
      "motion",
      "colour",
      "unmeasured",
      "reshape",
      "animation colour",
    ])
      expect(wakes.get(why) ?? 0).toBe(0);
    expect(wakes.get("resource") ?? 0).toBeLessThanOrEqual(3);
  });

  it("engages between the animation's cuts", () => {
    const h = streaming();
    let frames = 0;
    lobby.rows.forEach((row, k) => {
      h.core.motionFacts = lobbyFacts(row);
      vsync(h, k + 1);
      frames++;
    });
    const s = h.loop.stats();
    expect(s.skippedFrames).toBeGreaterThan(0);
    expect(s.cappedFrames / frames).toBeGreaterThanOrEqual(0.6);
  });
});
