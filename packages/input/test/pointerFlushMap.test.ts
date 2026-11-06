// M1: the pointer capture buffers move samples raw and calls `map` once per emitted motion record
// at the flush; edges (press, release, wheel, touch down/up) still map at event time. A counting
// `map` over jsdom elements, synthetic PointerEvents and a fake frame clock.

import {
  createPointerCapture,
  type PointerCaptureOptions,
  type PointerMap,
} from "@godot-scene-web/input/pointer";
import { afterEach, describe, expect, it } from "vitest";
import { type InputRecord, MouseButton } from "../src/index";

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
});

function harness(options: Partial<PointerCaptureOptions> = {}) {
  const stage = document.createElement("div");
  document.body.append(stage);
  const frames: ((time: number) => void)[] = [];
  const records: InputRecord[] = [];
  const doc = new FakeDocument();
  const win = new EventTarget();
  const calls: [number, number][] = [];
  const map: PointerMap = (x, y) => {
    calls.push([x, y]);
    return letterbox(x, y);
  };
  const capture = createPointerCapture({
    stage,
    map,
    sink: { push: (record) => records.push(record) },
    events: win,
    visibility: doc,
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: () => {},
    ...options,
  });
  cleanups.push(() => {
    capture.dispose();
    stage.remove();
  });
  const fire = (type: string, init: Extra = {}, extra: Extra = {}) => {
    const event =
      type === "wheel"
        ? new WheelEvent(type, { bubbles: true, cancelable: true, ...init })
        : new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "mouse",
            ...init,
          });
    for (const [key, value] of Object.entries(extra))
      Object.defineProperty(event, key, { value });
    stage.dispatchEvent(event);
    return event;
  };
  const frame = () => {
    for (const cb of frames.splice(0)) cb(0);
  };
  /** Records and map calls since the last call. */
  const take = () => ({
    records: records.splice(0),
    calls: calls.splice(0),
  });
  return { stage, capture, records, calls, doc, fire, frame, take };
}

const at = (clientX: number, clientY: number, buttons = 0) => ({
  clientX,
  clientY,
  button: buttons === 0 ? 0 : -1,
  buttons,
});
const touch = (id: number, x: number, y: number, buttons = 1) => ({
  ...at(x, y, buttons),
  pointerId: id,
  pointerType: "touch",
});

describe("M1: mouse motion maps once per record at the flush", () => {
  it("buffers raw samples: no map call until the frame, then one for the whole frame", () => {
    const h = harness();
    for (let i = 0; i < 12; i++) h.fire("pointermove", at(20 + i, 5));
    expect(h.take()).toEqual({ records: [], calls: [] });
    h.frame();
    const { records, calls } = h.take();
    expect(calls).toEqual([
      [31, 5], // the newest sample
      [20, 5], // the very first position only: the batch's base
    ]);
    expect(records).toEqual([
      { event: "mouse_motion", position: [42, 10], relative: [22, 0] },
    ]);
    // After the first position every frame is exactly one map call per record.
    for (let i = 0; i < 12; i++) h.fire("pointermove", at(32 + i, 6));
    h.frame();
    const next = h.take();
    expect(next.calls).toEqual([[43, 6]]);
    expect(next.records).toEqual([
      { event: "mouse_motion", position: [66, 12], relative: [24, 2] },
    ]);
  });

  it("sends the same coalesced record as a sample-by-sample capture would", () => {
    const h = harness();
    h.fire("pointermove", at(20, 5));
    h.frame();
    h.take();
    h.fire("pointermove", at(21.004, 6), { shiftKey: true });
    h.fire("pointermove", at(23, 7));
    h.fire("pointermove", at(24, 9));
    h.frame();
    expect(h.take().records).toEqual([
      { event: "mouse_motion", position: [28, 18], relative: [8, 8] },
    ]);
  });

  it("maps a press at event time and flushes the pending motion first, one map each", () => {
    const h = harness();
    h.fire("pointermove", at(20, 5));
    h.frame();
    h.take();
    h.fire("pointermove", at(30, 7));
    h.fire("pointermove", at(32, 7));
    h.fire("pointerdown", { ...at(33, 7, 1), button: 0 });
    const { records, calls } = h.take();
    expect(calls).toEqual([
      [33, 7], // the press, at event time
      [32, 7], // the flush before it: the newest sample only
    ]);
    expect(records).toEqual([
      { event: "mouse_motion", position: [44, 14], relative: [24, 4] },
      {
        event: "mouse_button",
        button_index: MouseButton.LEFT,
        pressed: true,
        position: [46, 14],
        button_mask: 1,
      },
    ]);
    h.fire("pointermove", at(40, 7, 1));
    h.fire("pointerup", { ...at(41, 8, 0), button: 0 });
    const up = h.take();
    expect(up.calls).toEqual([
      [41, 8],
      [40, 7],
    ]);
    expect(up.records.map((r) => r.event)).toEqual([
      "mouse_motion",
      "mouse_button",
    ]);
    expect(up.records[1]).toMatchObject({
      pressed: false,
      position: [62, 16],
    });
  });

  it("maps a wheel event once, at event time", () => {
    const h = harness();
    h.fire("wheel", { clientX: 20, clientY: 5, deltaY: 100, deltaMode: 0 });
    const { records, calls } = h.take();
    expect(calls).toEqual([[20, 5]]);
    expect(records.map((r) => r.event)).toEqual([
      "mouse_button",
      "mouse_button",
    ]);
    expect(records[0]).toMatchObject({ position: [20, 10] });
  });

  it("walks back to the newest sample that maps when the newest is off picture", () => {
    const h = harness();
    h.fire("pointermove", at(20, 5));
    h.frame();
    h.take();
    h.fire("pointermove", at(30, 5));
    h.fire("pointermove", at(5, 5)); // the letterbox bar
    h.fire("pointermove", at(4, 5));
    h.frame();
    const { records, calls } = h.take();
    expect(calls).toEqual([
      [4, 5],
      [5, 5],
      [30, 5],
    ]);
    expect(records).toEqual([
      { event: "mouse_motion", position: [40, 10], relative: [20, 0] },
    ]);
    // Staying on the bar sends nothing and keeps the position.
    h.fire("pointermove", at(3, 5));
    h.frame();
    expect(h.take().records).toEqual([]);
  });

  it("sends no motion for a chord's button-only move, but a there-and-back still is one", () => {
    const h = harness();
    h.fire("pointermove", at(20, 5));
    h.frame();
    h.take();
    // Same point, the right button joins during a left hold: an edge, never a motion.
    h.fire("pointerdown", { ...at(20, 5, 1), button: 0 });
    h.take();
    h.fire("pointermove", { ...at(20, 5, 3), button: 2 });
    h.frame();
    expect(h.take().records.map((r) => r.event)).toEqual(["mouse_button"]);
    // Moved away and back inside one frame: a motion to the same point, as a per-sample capture sent.
    h.fire("pointermove", at(30, 5, 3));
    h.fire("pointermove", at(20, 5, 3));
    h.frame();
    expect(h.take().records).toEqual([
      { event: "mouse_motion", position: [20, 10], button_mask: 3 },
    ]);
  });

  it("with coalescedEvents maps once per sample record, as the records are per sample", () => {
    const h = harness({ coalescedEvents: true });
    h.fire("pointermove", at(20, 5));
    h.take();
    const sample = (x: number) => at(x, 5);
    h.fire("pointermove", at(24, 5), {
      getCoalescedEvents: () => [sample(21), sample(22), sample(24)],
    });
    const { records, calls } = h.take();
    expect(records).toHaveLength(3);
    expect(calls).toHaveLength(3);
  });
});

describe("M1: pointer lock measures its scale once per flush", () => {
  it("scales the summed movement with one measurement for any number of samples", () => {
    const h = harness({ pointerLock: true });
    Object.assign(h.stage, { requestPointerLock: () => undefined });
    h.fire("pointermove", at(20, 5));
    h.frame();
    h.fire("pointerdown", { ...at(20, 5, 1), button: 0 });
    h.doc.pointerLockElement = h.stage;
    h.take();
    for (let i = 0; i < 10; i++)
      h.fire("pointermove", at(20, 5, 1), { movementX: 1, movementY: -1 });
    expect(h.take().calls).toEqual([]);
    h.frame();
    const { records, calls } = h.take();
    // The scale probe around the lock point: centre, +x, +y.
    expect(calls).toEqual([
      [20, 5],
      [21, 5],
      [20, 6],
    ]);
    expect(records).toEqual([
      {
        event: "mouse_motion",
        position: [20, 10],
        relative: [20, -20],
        button_mask: 1,
      },
    ]);
  });
});

describe("M1: touch maps once per record at the flush", () => {
  it("native screen_drag: one map per frame, down and up still map at event time", () => {
    const h = harness();
    h.fire("pointerdown", touch(7, 20, 5));
    expect(h.take().calls).toEqual([[20, 5]]);
    for (let i = 0; i < 8; i++) h.fire("pointermove", touch(7, 21 + i, 5));
    expect(h.take().calls).toEqual([]);
    h.frame();
    const drag = h.take();
    expect(drag.calls).toEqual([[28, 5]]);
    expect(drag.records).toEqual([
      { event: "screen_drag", position: [36, 10], relative: [16, 0] },
    ]);
    h.fire("pointermove", touch(7, 30, 5));
    h.fire("pointerup", touch(7, 31, 5, 0));
    const up = h.take();
    expect(up.calls).toEqual([
      [31, 5],
      [30, 5],
    ]);
    expect(up.records.map((r) => r.event)).toEqual([
      "screen_drag",
      "screen_touch",
    ]);
    expect(up.records[1]).toMatchObject({ pressed: false, position: [42, 10] });
  });

  it("mouse mode: a drag maps its newest sample once per frame and reports one drag-move", () => {
    const seen: string[] = [];
    const h = harness({
      mode: "mouse",
      gestures: { onGesture: (g) => seen.push(g.kind) },
    });
    h.fire("pointerdown", touch(7, 20, 5));
    h.take();
    for (let i = 0; i < 10; i++) h.fire("pointermove", touch(7, 21 + i, 5));
    h.frame();
    const { records, calls } = h.take();
    expect(calls).toEqual([[30, 5]]);
    expect(records.map((r) => r.event)).toEqual([
      "mouse_motion", // hover-first
      "mouse_button", // the press
      "mouse_motion", // the frame's drag motion
    ]);
    expect(records[2]).toMatchObject({ position: [40, 10], button_mask: 1 });
    expect(seen.filter((kind) => kind === "drag-move")).toHaveLength(1);
    // The lift releases where it lifts: the pending sample goes out first.
    h.fire("pointermove", touch(7, 34, 5));
    h.fire("pointerup", touch(7, 35, 5, 0));
    const up = h.take();
    expect(up.calls).toEqual([
      [34, 5], // the pending drag motion
      [35, 5], // the release point
      [35, 5], // the `touch-end` gesture's position
    ]);
    expect(up.records.map((r) => r.event)).toEqual([
      "mouse_motion",
      "mouse_button",
    ]);
    expect(up.records[1]).toMatchObject({ pressed: false, position: [50, 10] });
  });

  it("mouse mode: edges (tap, scroll latch) keep their single event-time map", () => {
    const h = harness({ mode: "mouse" });
    h.fire("pointerdown", touch(7, 20, 5));
    expect(h.take().calls).toEqual([[20, 5]]);
    h.fire("pointerup", touch(7, 20, 5, 0));
    const tap = h.take();
    // The tap's point and the `touch-end` gesture's position: one gesture, two edge maps.
    expect(tap.calls).toEqual([
      [20, 5],
      [20, 5],
    ]);
    expect(tap.records.map((r) => r.event)).toEqual([
      "mouse_motion",
      "mouse_button",
      "mouse_button",
    ]);
  });
});
