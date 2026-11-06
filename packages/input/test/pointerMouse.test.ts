// createPointerCapture `mode: "mouse"` against docs/input.md "Mouse mode": jsdom elements and
// synthetic PointerEvents, a fake frame clock, a fake clock and fake timers. The generic cases of
// couch's `streamInput.spec.ts` (tap, slop, drag, off-picture releases, two-finger scroll, stray
// fingers) are ported here in gsw-input/1 records; its product gestures appear as hook recipes.

import {
  createPointerCapture,
  type PointerCaptureOptions,
  type PointerGesture,
  type PointerGestureDecision,
  type PointerMap,
} from "@godot-scene-web/input/pointer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInputSession,
  encodeInputMessage,
  type InputRecord,
  MouseButton,
  parseInputMessage,
} from "../src/index";

/** Letterboxed: client x < 10 is a bar; otherwise host px = (client - [10, 0]) * 2. */
const letterbox: PointerMap = (x, y) =>
  x < 10 ? null : { x: (x - 10) * 2, y: y * 2 };

class FakeDocument extends EventTarget {
  visibilityState = "visible";
  pointerLockElement: unknown = null;
}

type Extra = Record<string, unknown>;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function harness(options: Partial<PointerCaptureOptions> = {}) {
  const stage = document.createElement("div");
  document.body.append(stage);
  const captured: number[] = [];
  Object.assign(stage, {
    setPointerCapture: (id: number) => captured.push(id),
  });
  const frames: ((time: number) => void)[] = [];
  const records: InputRecord[] = [];
  const gestures: [string, PointerGestureDecision][] = [];
  const clock = { t: 1000 };
  const doc = new FakeDocument();
  const win = new EventTarget();
  const capture = createPointerCapture({
    stage,
    map: letterbox,
    sink: { push: (record) => records.push(record) },
    mode: "mouse",
    events: win,
    visibility: doc,
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: () => {},
    now: () => clock.t,
    ...options,
    gestures: {
      onGesture: (gesture, decision) => gestures.push([gesture.kind, decision]),
      ...options.gestures,
    },
  });
  cleanups.push(() => {
    capture.dispose();
    stage.remove();
  });
  const make = (type: string, init: Extra) =>
    type === "wheel"
      ? new WheelEvent(type, { bubbles: true, cancelable: true, ...init })
      : new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse",
          ...init,
        });
  const fire = (type: string, init: Extra = {}) => {
    const event = make(type, init);
    stage.dispatchEvent(event);
    return event;
  };
  /** A touch pointer event: down/move hold `buttons` 1, up/cancel 0. */
  const touch = (type: string, id: number, clientX: number, clientY: number) =>
    fire(`pointer${type}`, {
      pointerId: id,
      pointerType: "touch",
      clientX,
      clientY,
      button: type === "move" ? -1 : 0,
      buttons: type === "up" || type === "cancel" ? 0 : 1,
    });
  const frame = () => {
    for (const cb of frames.splice(0)) cb(0);
  };
  const take = () => records.splice(0);
  const takeGestures = () => gestures.splice(0);
  return {
    stage,
    capture,
    records,
    captured,
    clock,
    doc,
    win,
    make,
    fire,
    touch,
    frame,
    take,
    takeGestures,
  };
}

function expectEncodable(records: readonly InputRecord[]): void {
  for (let i = 0; i < records.length; i += 64)
    encodeInputMessage({
      type: "events",
      epoch: 1,
      seq: 1,
      events: records.slice(i, i + 64),
    });
}

const L = MouseButton.LEFT;
const motion = (x: number, y: number, extra: Extra = {}) => ({
  event: "mouse_motion",
  position: [x, y],
  ...extra,
});
const press = (button: number, x: number, y: number, extra: Extra = {}) => ({
  event: "mouse_button",
  button_index: button,
  pressed: true,
  position: [x, y],
  button_mask: 1 << (button - 1),
  ...extra,
});
const release = (button: number, x: number, y: number, extra: Extra = {}) => ({
  event: "mouse_button",
  button_index: button,
  pressed: false,
  position: [x, y],
  ...extra,
});

describe("mouse mode: tap and drag", () => {
  it("turns a tap into a motion at its point, then a LEFT click, with no touch records", () => {
    const h = harness();
    h.touch("down", 5, 60, 50);
    expect(h.records).toEqual([]); // nothing until the finger lifts or travels
    h.touch("up", 5, 60, 50);
    expect(h.take()).toEqual([
      motion(100, 100),
      press(L, 100, 100),
      release(L, 100, 100),
    ]);
    expect(h.captured).toEqual([5]);
    // The next tap's hover carries its relative from the last mouse position.
    h.clock.t += 1000;
    h.touch("down", 6, 110, 50);
    h.touch("up", 6, 110, 50);
    expect(h.take()[0]).toEqual(motion(200, 100, { relative: [100, 0] }));
  });

  it("keeps a sub-slop jitter a tap, clicking at the lift point", () => {
    const h = harness();
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 64, 54); // 5.7 px < 8
    h.frame();
    expect(h.records).toEqual([]);
    h.touch("up", 5, 65, 50);
    expect(h.take()).toEqual([
      motion(110, 100),
      press(L, 110, 100),
      release(L, 110, 100),
    ]);
  });

  it("presses at the start once the finger passes the slop, then drags and releases where it lifts", () => {
    const h = harness();
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    expect(h.take()).toEqual([motion(100, 100), press(L, 100, 100)]);
    h.frame();
    expect(h.take()).toEqual([
      motion(140, 100, { relative: [40, 0], button_mask: 1 }),
    ]);
    h.touch("move", 5, 90, 50);
    h.touch("move", 5, 95, 60);
    h.frame(); // coalesced: one motion per frame
    expect(h.take()).toEqual([
      motion(170, 120, { relative: [30, 20], button_mask: 1 }),
    ]);
    h.touch("move", 5, 100, 60);
    h.touch("up", 5, 105, 60);
    // Pending motion goes out before the release edge.
    expect(h.take()).toEqual([
      motion(180, 120, { relative: [10, 0], button_mask: 1 }),
      release(L, 190, 120),
    ]);
  });

  it("honours a custom touchSlop", () => {
    const h = harness({ gestures: { touchSlop: 30 } });
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    h.touch("up", 5, 80, 50);
    expect(h.take()).toEqual([
      motion(140, 100),
      press(L, 140, 100),
      release(L, 140, 100),
    ]);
  });

  it("keeps a drag that slides off the picture and releases at the last mapped point", () => {
    const h = harness();
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    h.touch("move", 5, 5, 50); // the letterbox bar: no motion, still a drag
    h.frame();
    h.touch("up", 5, 4, 50);
    expect(h.take()).toEqual([
      motion(100, 100),
      press(L, 100, 100),
      motion(140, 100, { relative: [40, 0], button_mask: 1 }),
      release(L, 140, 100),
    ]);
  });

  it("starts nothing for a touch off picture and owes nothing for a tap lifted off picture", () => {
    const h = harness();
    h.touch("down", 5, 5, 50);
    h.touch("move", 5, 60, 50);
    h.touch("up", 5, 60, 50);
    h.frame();
    expect(h.take()).toEqual([]);
    expect(h.takeGestures()).toEqual([]);
    h.touch("down", 6, 60, 50);
    h.touch("move", 6, 5, 52); // 55 px: a drag, but it was already ...
    h.touch("up", 6, 5, 52);
    // ... it pressed at the start (which mapped) and released there.
    expect(h.take()).toEqual([
      motion(100, 100),
      press(L, 100, 100),
      release(L, 100, 100),
    ]);
    h.touch("down", 7, 12, 50);
    h.touch("up", 7, 8, 50); // 4 px: a tap, lifted on the bar
    expect(h.take()).toEqual([]);
    expect(h.capture.stats().dropped["off-picture"]).toBe(2);
  });

  it("marks a second tap within 400 ms and 24 CSS px as a double click, and starts over after it", () => {
    const h = harness();
    const tap = (x: number) => {
      h.touch("down", 5, x, 50);
      h.touch("up", 5, x, 50);
      return h.take().find((r) => r.event === "mouse_button" && r.pressed);
    };
    expect(tap(60)).not.toHaveProperty("double_click");
    h.clock.t += 300;
    expect(tap(75)).toMatchObject({ double_click: true });
    h.clock.t += 100;
    expect(tap(75)).not.toHaveProperty("double_click"); // the pair is spent
    h.clock.t += 500;
    expect(tap(75)).not.toHaveProperty("double_click"); // too late
    h.clock.t += 100;
    expect(tap(110)).not.toHaveProperty("double_click"); // too far
  });
});

describe("mouse mode: long press", () => {
  it("is off by default: a long still hold is a tap", () => {
    vi.useFakeTimers();
    const h = harness();
    h.touch("down", 5, 60, 50);
    vi.advanceTimersByTime(5000);
    h.touch("up", 5, 60, 50);
    expect(h.take()).toEqual([
      motion(100, 100),
      press(L, 100, 100),
      release(L, 100, 100),
    ]);
  });

  it("turns a still hold into a RIGHT click at the press point, then ignores the finger", () => {
    vi.useFakeTimers();
    const h = harness({ gestures: { longPressMs: 500 } });
    const R = MouseButton.RIGHT;
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 63, 50); // under the slop: still a press-and-hold
    vi.advanceTimersByTime(499);
    expect(h.records).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.take()).toEqual([
      motion(100, 100),
      press(R, 100, 100),
      release(R, 100, 100),
    ]);
    h.touch("move", 5, 120, 50);
    h.frame();
    h.touch("up", 5, 120, 50);
    expect(h.take()).toEqual([]);
    expect(h.takeGestures()).toEqual([
      ["touch-down", "send"],
      ["long-press", "send"],
      ["touch-end", "send"],
    ]);
  });

  it("never fires once the finger dragged, lifted or was canceled", () => {
    vi.useFakeTimers();
    const h = harness({ gestures: { longPressMs: 500 } });
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    vi.advanceTimersByTime(1000);
    h.touch("up", 5, 80, 50);
    expect(
      h
        .take()
        .filter((r) => r.event === "mouse_button")
        .map((r) => r.button_index),
    ).toEqual([L, L]);
    h.touch("down", 6, 60, 50);
    h.touch("up", 6, 60, 50);
    h.take();
    h.touch("down", 7, 60, 50);
    h.touch("cancel", 7, 60, 50);
    vi.advanceTimersByTime(1000);
    expect(h.take()).toEqual([]);
  });
});

describe("mouse mode: two fingers", () => {
  it("turns vertical centroid drift into wheel ticks at the latch point, natural direction, never a click", () => {
    const h = harness();
    // 2 host px per client px: the 56 px wheel step is 28 client px of centroid drift.
    h.touch("down", 1, 100, 200);
    h.touch("down", 2, 200, 200);
    h.touch("move", 1, 100, 230);
    h.touch("move", 2, 200, 230); // fingers DOWN 30: 60 host px -> one WHEEL_UP, 4 carried
    h.frame();
    const W_UP = MouseButton.WHEEL_UP;
    const W_DOWN = MouseButton.WHEEL_DOWN;
    // Latch: the centroid (150, 200) -> host (280, 400). Factor 1 is omitted.
    expect(h.take()).toEqual([press(W_UP, 280, 400), release(W_UP, 280, 400)]);
    h.touch("move", 1, 100, 170);
    h.touch("move", 2, 200, 170); // fingers UP 60: -120 + 4 -> two WHEEL_DOWN
    expect(h.take()).toEqual([
      press(W_DOWN, 280, 400),
      release(W_DOWN, 280, 400),
      press(W_DOWN, 280, 400),
      release(W_DOWN, 280, 400),
    ]);
    h.touch("up", 1, 100, 170);
    h.touch("move", 2, 200, 400); // one finger left: inert
    h.touch("up", 2, 200, 400);
    h.frame();
    expect(h.take()).toEqual([]);
    expect(h.captured).toEqual([1, 2]);
    expect(h.takeGestures()).toEqual([
      ["touch-down", "send"],
      ["scroll-start", "send"],
      ["wheel", "send"],
      ["wheel", "send"],
      ["wheel", "send"],
      ["touch-end", "send"],
    ]);
  });

  it("honours a custom wheelStep and scrollSlop", () => {
    const h = harness({ gestures: { wheelStep: 10, scrollSlop: 2 } });
    h.touch("down", 1, 100, 200);
    h.touch("down", 2, 200, 200);
    h.touch("move", 1, 100, 210); // centroid +5 client = 10 host: one tick
    expect(h.take()).toHaveLength(2);
  });

  it("sends nothing for a still two-finger touch, then takes the next tap normally", () => {
    const h = harness();
    h.touch("down", 1, 100, 200);
    h.touch("down", 2, 200, 200);
    h.touch("up", 1, 100, 200);
    h.touch("up", 2, 200, 200);
    h.frame();
    expect(h.take()).toEqual([]);
    h.touch("down", 3, 300, 300);
    h.touch("up", 3, 300, 300);
    expect(h.take().at(-1)).toEqual(release(L, 580, 600));
  });

  it("sends no tick for jitter below the scroll slop", () => {
    const h = harness();
    h.touch("down", 1, 100, 200);
    h.touch("down", 2, 200, 200);
    h.touch("move", 1, 100, 210);
    h.touch("move", 2, 200, 210);
    expect(h.take()).toEqual([]);
  });

  it("ignores a third finger entirely", () => {
    const h = harness();
    h.touch("down", 1, 100, 200);
    h.touch("down", 2, 200, 200);
    h.touch("down", 3, 300, 200);
    h.touch("move", 3, 300, 400);
    h.touch("up", 3, 300, 400);
    expect(h.take()).toEqual([]);
    h.touch("move", 1, 100, 230);
    h.touch("move", 2, 200, 230);
    expect(h.take()).toHaveLength(2); // the scroll is unaffected
    expect(h.capture.stats().dropped["extra-touch"]).toBe(1);
  });

  it("ignores a second finger during a drag: its lift releases nothing", () => {
    const h = harness();
    h.touch("down", 1, 60, 50);
    h.touch("move", 1, 80, 50);
    h.touch("down", 2, 200, 200);
    h.touch("move", 2, 220, 260);
    h.touch("up", 2, 220, 260);
    h.frame();
    expect(h.take()).toEqual([
      motion(100, 100),
      press(L, 100, 100),
      motion(140, 100, { relative: [40, 0], button_mask: 1 }),
    ]);
    h.touch("up", 1, 80, 50);
    expect(h.take()).toEqual([release(L, 140, 100)]);
  });

  it("keeps fingers left down after the gesture ignored until they lift", () => {
    const h = harness();
    h.touch("down", 1, 60, 50);
    h.touch("move", 1, 80, 50); // drag
    h.touch("down", 2, 200, 200); // stray
    h.touch("up", 1, 80, 50);
    h.take();
    h.touch("down", 3, 60, 50); // still a stray: finger 2 is down
    h.touch("up", 3, 60, 50);
    expect(h.take()).toEqual([]);
    h.touch("up", 2, 200, 200);
    h.touch("down", 4, 60, 50);
    h.touch("up", 4, 60, 50);
    expect(h.take()).toHaveLength(3);
  });
});

describe("mouse mode: mouse and pen pass through", () => {
  it("sends exactly what native mode sends for every button, chords, the wheel and pen", () => {
    const run = (mode: "native" | "mouse") => {
      const h = harness({ mode });
      const buttons: [number, number][] = [
        [0, 1],
        [1, 4],
        [2, 2],
        [3, 8],
        [4, 16],
      ];
      for (const [button, mask] of buttons) {
        h.fire("pointermove", { clientX: 20 + button, clientY: 5, buttons: 0 });
        h.frame();
        h.fire("pointerdown", {
          clientX: 20,
          clientY: 5,
          button,
          buttons: mask,
        });
        h.fire("pointerup", { clientX: 20, clientY: 5, button, buttons: 0 });
      }
      h.fire("pointerdown", { clientX: 30, clientY: 5, button: 0, buttons: 1 });
      h.fire("pointermove", { clientX: 30, clientY: 5, button: 2, buttons: 3 });
      h.fire("pointerup", { clientX: 30, clientY: 5, button: 0, buttons: 0 });
      h.fire("wheel", { clientX: 30, clientY: 5, deltaY: -100, deltaX: 3 });
      h.fire("pointerdown", {
        clientX: 40,
        clientY: 5,
        button: 0,
        buttons: 1,
        pointerType: "pen",
        pointerId: 9,
        pressure: 0.5,
      });
      h.fire("pointermove", {
        clientX: 45,
        clientY: 6,
        buttons: 1,
        pointerType: "pen",
        pointerId: 9,
        pressure: 0.7,
      });
      h.frame();
      h.fire("pointerup", {
        clientX: 45,
        clientY: 6,
        button: 0,
        buttons: 0,
        pointerType: "pen",
        pointerId: 9,
      });
      return h.take();
    };
    const native = run("native");
    expect(native.length).toBeGreaterThan(20);
    expect(run("mouse")).toEqual(native);
  });

  it("shares Godot's one mouse: a tap cannot press LEFT while the mouse holds it", () => {
    const h = harness();
    h.fire("pointerdown", { clientX: 20, clientY: 5, button: 0, buttons: 1 });
    h.take();
    h.touch("down", 5, 60, 50);
    h.touch("up", 5, 60, 50);
    expect(h.take()).toEqual([
      motion(100, 100, { relative: [80, 90], button_mask: 1 }),
    ]);
    expect(h.capture.stats().dropped["button-held"]).toBe(1);
    h.fire("pointerup", { clientX: 20, clientY: 5, button: 0, buttons: 0 });
    expect(h.take()).toEqual([release(L, 20, 10)]);
  });
});

describe("mouse mode: hooks", () => {
  it("reports every gesture of a tap and a drag in order, after its records", () => {
    const seen: [string, number][] = [];
    const h = harness({
      gestures: {
        onGesture: (gesture) => seen.push([gesture.kind, h.records.length]),
      },
    });
    h.touch("down", 5, 60, 50);
    h.touch("up", 5, 60, 50);
    expect(seen).toEqual([
      ["touch-down", 0],
      ["tap", 3],
      ["touch-end", 3],
    ]);
    seen.length = 0;
    h.take();
    h.touch("down", 6, 60, 50);
    h.touch("move", 6, 80, 50);
    h.frame(); // drag-move is per coalesced motion (one per frame), not per sample
    h.touch("move", 6, 80, 50); // same point: no drag-move
    h.touch("move", 6, 85, 50);
    h.touch("move", 6, 90, 50); // 85 and 90 share a frame: one drag-move, at 90
    h.frame();
    h.touch("up", 6, 90, 50);
    expect(seen).toEqual([
      ["touch-down", 0],
      ["drag-start", 2],
      ["drag-move", 2], // told while its frame's motion is being built
      ["drag-move", 3],
      ["drag-end", 5],
      ["touch-end", 5],
    ]);
  });

  it("hands hooks the gesture's client point, host position and button", () => {
    const got: PointerGesture[] = [];
    const h = harness({
      gestures: {
        intercept: (gesture) => {
          got.push(gesture);
          return "send";
        },
      },
    });
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    h.touch("up", 5, 80, 50);
    expect(got[0]).toEqual({
      kind: "touch-down",
      pointerId: 5,
      clientX: 60,
      clientY: 50,
      position: [100, 100],
    });
    expect(got[1]).toEqual({
      kind: "drag-start",
      pointerId: 5,
      clientX: 60,
      clientY: 50,
      position: [100, 100],
      button: L,
    });
    expect(got.map((gesture) => gesture.kind)).toEqual([
      "touch-down",
      "drag-start",
      "drag-move",
    ]); // drag-end and touch-end are never interceptable
  });

  it("builds tap-to-focus: the first tap on an item only hovers, a re-tap clicks", () => {
    // Couch's recipe: the product resolves its own item at the point.
    let armed: string | null = null;
    const itemAt = (x: number) => (x < 100 ? "card" : null);
    const h = harness({
      gestures: {
        intercept: (gesture) => {
          if (gesture.kind !== "tap" || !gesture.position) return "send";
          const item = itemAt(gesture.clientX);
          if (item !== null && armed !== item) {
            armed = item;
            h.capture.hover(gesture.position);
            return "swallow";
          }
          armed = null;
          return "send";
        },
      },
    });
    h.touch("down", 5, 60, 50);
    h.touch("up", 5, 60, 50);
    expect(h.take()).toEqual([motion(100, 100)]);
    h.clock.t += 1000;
    h.touch("down", 5, 60, 50);
    h.touch("up", 5, 60, 50);
    expect(h.take()).toEqual([
      motion(100, 100),
      press(L, 100, 100),
      release(L, 100, 100),
    ]);
    expect(h.capture.stats().dropped.intercepted).toBe(1);
  });

  it("builds a held-card peek: a swallowed long press keeps the finger pending", () => {
    vi.useFakeTimers();
    let peeking = false;
    const h = harness({
      gestures: {
        longPressMs: 100,
        intercept: (gesture) => {
          if (gesture.kind === "long-press" && gesture.position) {
            peeking = true;
            h.capture.hover(gesture.position);
            return "swallow";
          }
          if (gesture.kind === "tap" && peeking) return "swallow";
          return "send";
        },
        onGesture: (gesture) => {
          if (gesture.kind === "touch-end") peeking = false;
        },
      },
    });
    h.touch("down", 5, 60, 50);
    vi.advanceTimersByTime(100);
    expect(h.take()).toEqual([motion(100, 100)]);
    h.touch("up", 5, 60, 50);
    expect(h.take()).toEqual([]); // a peek release never plays the card
    // A peek that then travels is still a drag (the card is played by dragging).
    h.touch("down", 6, 60, 50);
    vi.advanceTimersByTime(100);
    h.touch("move", 6, 90, 50);
    h.touch("up", 6, 90, 50);
    expect(
      h
        .take()
        .filter((r) => r.event === "mouse_button")
        .map((r) => r.pressed),
    ).toEqual([true, false]);
  });

  it("builds a confirm tap: click() commits later at the focus point, without a motion", () => {
    let focus: readonly [number, number] | null = null;
    const h = harness({
      gestures: {
        intercept: (gesture) => {
          if (gesture.kind !== "tap" || !gesture.position) return "send";
          focus = gesture.position;
          h.capture.hover(gesture.position);
          return "swallow";
        },
      },
    });
    h.touch("down", 5, 60, 50);
    h.touch("up", 5, 60, 50);
    expect(h.take()).toEqual([motion(100, 100)]);
    // The product's own confirm button, outside the stage:
    expect(focus).not.toBeNull();
    if (focus) expect(h.capture.click(L, focus)).toBe(true);
    expect(h.take()).toEqual([press(L, 100, 100), release(L, 100, 100)]);
  });

  it("claims a finger when touch-down is swallowed: nothing for it, touch-end still comes", () => {
    const h = harness({
      gestures: {
        intercept: (gesture) =>
          gesture.kind === "touch-down" ? "swallow" : "send",
      },
    });
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 100, 50);
    h.touch("down", 6, 200, 50);
    h.touch("move", 6, 200, 150);
    h.touch("up", 6, 200, 150);
    h.touch("up", 5, 100, 50);
    h.frame();
    expect(h.take()).toEqual([]);
    expect(h.takeGestures()).toEqual([
      ["touch-down", "swallow"],
      ["touch-end", "send"],
    ]);
  });

  it("swallowing drag-start leaves the finger inert, with no press to release", () => {
    const h = harness({
      gestures: {
        intercept: (gesture) =>
          gesture.kind === "drag-start" ? "swallow" : "send",
      },
    });
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    h.touch("move", 5, 90, 50);
    h.touch("up", 5, 90, 50);
    h.frame();
    expect(h.take()).toEqual([]);
  });

  it("never lets a hook swallow the release of a press that went out", () => {
    const h = harness({
      gestures: {
        intercept: (gesture) =>
          gesture.kind === "drag-move" || gesture.kind === "tap"
            ? "swallow"
            : "send",
      },
    });
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    h.touch("move", 5, 90, 50);
    h.touch("up", 5, 90, 50);
    h.frame();
    expect(h.take()).toEqual([
      motion(100, 100),
      press(L, 100, 100),
      release(L, 160, 100),
    ]);
  });

  it("swallowing a wheel tick sends nothing for that tick only", () => {
    let n = 0;
    const h = harness({
      gestures: {
        wheelStep: 10,
        intercept: (gesture) =>
          gesture.kind === "wheel" && n++ === 0 ? "swallow" : "send",
      },
    });
    h.touch("down", 1, 100, 200);
    h.touch("down", 2, 200, 200);
    h.touch("move", 1, 100, 220); // 20 host px of centroid drift: two ticks
    expect(h.take()).toHaveLength(2);
  });

  it("click() and hover() refuse while inactive, while the button is held, and bad input", () => {
    let on = true;
    const h = harness({ enabled: () => on });
    expect(h.capture.click(MouseButton.WHEEL_DOWN, [10, 20])).toBe(true);
    expect(h.take()).toEqual([
      press(MouseButton.WHEEL_DOWN, 10, 20),
      release(MouseButton.WHEEL_DOWN, 10, 20),
    ]);
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    expect(h.capture.click(L, [1, 2])).toBe(false);
    expect(h.capture.click(0, [1, 2])).toBe(false);
    expect(h.capture.hover([Number.NaN, 2])).toBe(false);
    on = false;
    expect(h.capture.hover([1, 2])).toBe(false);
    expect(h.capture.click(MouseButton.RIGHT, [1, 2])).toBe(false);
    const dropped = h.capture.stats().dropped;
    expect(dropped["button-held"]).toBe(1);
    expect(dropped["unmapped-button"]).toBe(1);
    expect(dropped["off-picture"]).toBe(1);
    expect(dropped.inactive).toBe(2);
  });
});

describe("mouse mode: release guarantees", () => {
  it("releases a drag on pointercancel with canceled: true at the last mapped point", () => {
    const h = harness();
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    h.touch("move", 5, 90, 50);
    h.take();
    h.touch("cancel", 5, 300, 300);
    expect(h.take()).toEqual([
      motion(160, 100, { relative: [60, 0], button_mask: 1 }),
      release(L, 160, 100, { canceled: true }),
    ]);
    expect(h.takeGestures().slice(-2)).toEqual([
      ["drag-end", "send"],
      ["touch-end", "send"],
    ]);
  });

  it("cancels a pending finger with nothing to release, and a scroll with nothing sent", () => {
    const h = harness();
    h.touch("down", 5, 60, 50);
    h.touch("cancel", 5, 60, 50);
    h.touch("down", 1, 100, 200);
    h.touch("down", 2, 200, 200);
    h.touch("cancel", 1, 100, 200);
    h.touch("cancel", 2, 200, 200);
    expect(h.take()).toEqual([]);
    h.touch("down", 3, 60, 50);
    h.touch("up", 3, 60, 50);
    expect(h.take()).toHaveLength(3);
  });

  for (const how of ["blur", "hidden", "pagehide", "refresh", "lost-capture"]) {
    it(`releases a drag on ${how}, and ignores the finger until it lifts`, () => {
      let on = true;
      const h = harness({ enabled: () => on });
      h.touch("down", 5, 60, 50);
      h.touch("move", 5, 80, 50);
      h.frame();
      h.take();
      if (how === "blur") h.win.dispatchEvent(new Event("blur"));
      if (how === "pagehide") h.win.dispatchEvent(new Event("pagehide"));
      if (how === "hidden") {
        h.doc.visibilityState = "hidden";
        h.doc.dispatchEvent(new Event("visibilitychange"));
        h.doc.visibilityState = "visible";
      }
      if (how === "refresh") {
        on = false;
        h.capture.refresh();
        on = true;
      }
      if (how === "lost-capture")
        h.fire("lostpointercapture", { pointerId: 5, pointerType: "touch" });
      expect(h.take()).toEqual([release(L, 140, 100, { canceled: true })]);
      h.touch("move", 5, 120, 50);
      h.frame();
      h.touch("up", 5, 120, 50);
      expect(h.take()).toEqual([]);
      expect(h.takeGestures().slice(-2)).toEqual([
        ["drag-end", "send"],
        ["touch-end", "send"],
      ]);
      // The next touch is a fresh gesture.
      h.touch("down", 6, 60, 50);
      h.touch("up", 6, 60, 50);
      expect(h.take()).toHaveLength(3);
    });
  }

  it("ends a two-finger scroll on blur: the fingers send nothing more", () => {
    const h = harness();
    h.touch("down", 1, 100, 200);
    h.touch("down", 2, 200, 200);
    h.win.dispatchEvent(new Event("blur"));
    h.touch("move", 1, 100, 300);
    h.touch("move", 2, 200, 300);
    h.touch("up", 1, 100, 300);
    h.touch("up", 2, 200, 300);
    expect(h.take()).toEqual([]);
  });

  it("releases a drag on dispose and clears a pending long press", () => {
    vi.useFakeTimers();
    const h = harness({ gestures: { longPressMs: 200 } });
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    h.frame();
    h.take();
    h.capture.dispose();
    expect(h.take()).toEqual([release(L, 140, 100, { canceled: true })]);
    const p = harness({ gestures: { longPressMs: 200 } });
    p.touch("down", 5, 60, 50);
    p.capture.dispose();
    vi.advanceTimersByTime(1000);
    expect(p.take()).toEqual([]);
  });

  it("releases from a pointerup only the window heard", () => {
    const h = harness();
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    h.frame();
    h.take();
    h.win.dispatchEvent(
      h.make("pointerup", {
        pointerId: 5,
        pointerType: "touch",
        clientX: 85,
        clientY: 50,
      }),
    );
    expect(h.take()).toEqual([release(L, 150, 100)]);
  });

  it("drops touches while disabled and keeps a drag's release ungated", () => {
    let on = false;
    const h = harness({ enabled: () => on });
    h.touch("down", 5, 60, 50);
    h.touch("up", 5, 60, 50);
    expect(h.take()).toEqual([]);
    expect(h.capture.stats().dropped.inactive).toBe(1);
    on = true;
    h.touch("down", 6, 60, 50);
    h.touch("move", 6, 80, 50);
    on = false;
    h.touch("up", 6, 80, 50);
    expect(h.take().at(-1)).toEqual(release(L, 140, 100));
  });
});

describe("mouse mode: held state and the session", () => {
  it("reports a drag's LEFT in the pointer scope and never a touch", () => {
    const h = harness();
    h.touch("down", 5, 60, 50);
    h.touch("move", 5, 80, 50);
    h.frame();
    expect(h.capture.heldState()).toEqual([
      {
        scope: "pointer",
        held: [motion(140, 100), press(L, 140, 100)],
      },
    ]);
  });

  it("pushes only codec-valid mouse records, never a touch record", () => {
    vi.useFakeTimers();
    const h = harness({ gestures: { longPressMs: 300 } });
    h.touch("down", 5, 60, 50);
    h.touch("up", 5, 60, 50);
    h.touch("down", 5, 60.123, 50.456);
    h.touch("move", 5, 99.999, 70.001);
    h.frame();
    h.touch("up", 5, 99.999, 70.001);
    h.touch("down", 6, 60, 50);
    vi.advanceTimersByTime(300);
    h.touch("up", 6, 60, 50);
    h.touch("down", 1, 100, 200);
    h.touch("down", 2, 200, 200);
    h.touch("move", 1, 100, 400);
    h.touch("up", 1, 100, 400);
    h.touch("cancel", 2, 200, 200);
    h.capture.dispose();
    expect(h.records.length).toBeGreaterThan(12);
    expectEncodable(h.records);
    for (const record of h.records)
      expect(record.event.startsWith("mouse_")).toBe(true);
  });

  it("round-trips through createInputSession with only codec-valid mouse records", async () => {
    const sent: string[] = [];
    const session = createInputSession({
      send: (text) => sent.push(text),
      heartbeatMs: 0,
    });
    const h = harness({ sink: session });
    session.attach(h.capture);
    session.open();
    h.touch("down", 5, 60, 50);
    h.touch("up", 5, 60, 50);
    h.touch("down", 1, 100, 200);
    h.touch("down", 2, 200, 200);
    h.touch("move", 1, 100, 260);
    h.touch("up", 1, 100, 260);
    h.touch("up", 2, 200, 200);
    await Promise.resolve();
    session.dispose();
    const events = sent.flatMap((text) => {
      const parsed = parseInputMessage(text);
      if (!parsed.ok) throw new Error(parsed.detail);
      return parsed.message.type === "events" ? parsed.message.events : [];
    });
    expect(events.map((e) => e.event)).toEqual([
      "mouse_motion",
      "mouse_button",
      "mouse_button",
      "mouse_button",
      "mouse_button",
    ]);
  });
});
