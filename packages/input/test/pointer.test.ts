// createPointerCapture (native mode) and objectFitMapper against docs/input.md "Pointer": jsdom
// elements and synthetic PointerEvent/WheelEvent, a fake frame clock and a fake clock.

import {
  createPointerCapture,
  objectFitMapper,
  type PointerCaptureOptions,
  type PointerMap,
} from "@godot-scene-web/input/pointer";
import { afterEach, describe, expect, it } from "vitest";
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
});

function harness(options: Partial<PointerCaptureOptions> = {}) {
  const stage = document.createElement("div");
  document.body.append(stage);
  const captured: number[] = [];
  const pointerCapture = (id: number) => captured.push(id);
  Object.assign(stage, { setPointerCapture: pointerCapture });
  const frames: ((time: number) => void)[] = [];
  const records: InputRecord[] = [];
  const clock = { t: 1000 };
  const doc = new FakeDocument();
  const win = new EventTarget();
  const capture = createPointerCapture({
    stage,
    map: letterbox,
    sink: { push: (record) => records.push(record) },
    events: win,
    visibility: doc,
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: () => {},
    now: () => clock.t,
    ...options,
  });
  cleanups.push(() => {
    capture.dispose();
    stage.remove();
  });
  const make = (type: string, init: Extra, extra: Extra = {}) => {
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
    return event;
  };
  const fire = (type: string, init: Extra = {}, extra: Extra = {}) => {
    const event = make(type, init, extra);
    stage.dispatchEvent(event);
    return event;
  };
  const frame = () => {
    for (const cb of frames.splice(0)) cb(0);
  };
  const take = () => records.splice(0);
  return {
    stage,
    capture,
    records,
    captured,
    frames,
    clock,
    doc,
    win,
    make,
    fire,
    frame,
    take,
  };
}

/** Every record must be one the codec accepts. */
function expectEncodable(records: readonly InputRecord[]): void {
  if (records.length === 0) return;
  for (let i = 0; i < records.length; i += 64)
    encodeInputMessage({
      type: "events",
      epoch: 1,
      seq: 1,
      events: records.slice(i, i + 64),
    });
}

const down = (clientX: number, clientY: number, button = 0, buttons = 1) => ({
  clientX,
  clientY,
  button,
  buttons,
});

describe("pointer capture: mouse buttons", () => {
  it("maps DOM buttons 0..4 to LEFT/MIDDLE/RIGHT/XBUTTON1/XBUTTON2 with exact masks", () => {
    const h = harness();
    const cases: [number, number, number][] = [
      [0, 1, MouseButton.LEFT],
      [1, 4, MouseButton.MIDDLE],
      [2, 2, MouseButton.RIGHT],
      [3, 8, MouseButton.XBUTTON1],
      [4, 16, MouseButton.XBUTTON2],
    ];
    for (const [button, buttons, godot] of cases) {
      h.fire("pointerdown", down(20, 5, button, buttons));
      h.fire("pointerup", down(20, 5, button, 0));
      const mask = 1 << (godot - 1);
      expect(h.take()).toEqual([
        {
          event: "mouse_button",
          button_index: godot,
          pressed: true,
          position: [20, 10],
          button_mask: mask,
        },
        {
          event: "mouse_button",
          button_index: godot,
          pressed: false,
          position: [20, 10],
        },
      ]);
    }
  });

  it("diffs `buttons` on pointermove for chords and keeps the mask exact", () => {
    const h = harness();
    h.fire("pointerdown", down(20, 5, 0, 1));
    h.fire("pointermove", down(20, 5, 2, 3)); // right joins the hold
    h.fire("pointermove", down(20, 5, 3, 11)); // X1 too
    h.fire("pointermove", down(20, 5, 0, 10)); // left lets go
    h.fire("pointermove", down(20, 5, 2, 8));
    h.fire("pointerup", down(20, 5, 3, 0));
    const edges = h
      .take()
      .map((r) =>
        r.event === "mouse_button"
          ? [r.button_index, r.pressed, r.button_mask ?? 0]
          : r.event,
      );
    expect(edges).toEqual([
      [MouseButton.LEFT, true, 1],
      [MouseButton.RIGHT, true, 3],
      [MouseButton.XBUTTON1, true, 131],
      [MouseButton.LEFT, false, 130],
      [MouseButton.RIGHT, false, 128],
      [MouseButton.XBUTTON1, false, 0],
    ]);
    expect(h.capture.stats()).toMatchObject({ presses: 3, releases: 3 });
  });

  it("never presses for buttons that went down elsewhere and were dragged in", () => {
    const h = harness();
    h.fire("pointermove", down(20, 5, -1, 1));
    h.fire("pointerup", down(20, 5, 0, 0));
    expect(h.take().filter((r) => r.event === "mouse_button")).toEqual([]);
  });

  it("ignores click/auxclick duplicates and prevents the browser traps", () => {
    const h = harness();
    const middle = h.fire("pointerdown", down(20, 5, 1, 4));
    expect(middle.defaultPrevented).toBe(true); // no autoscroll
    const middleUp = h.fire("pointerup", down(20, 5, 1, 0));
    expect(middleUp.defaultPrevented).toBe(true);
    h.take();
    for (const button of [3, 4]) {
      h.fire("pointerdown", down(20, 5, button, button === 3 ? 8 : 16));
      const up = h.fire("pointerup", down(20, 5, button, 0));
      expect(up.defaultPrevented).toBe(true); // no history navigation
      const aux = new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button,
      });
      h.stage.dispatchEvent(aux);
      expect(aux.defaultPrevented).toBe(true);
    }
    expect(h.take()).toHaveLength(4);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    h.stage.dispatchEvent(click);
    const menu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    h.stage.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(h.take()).toEqual([]);
  });

  it("leaves the context menu alone with contextMenu: false", () => {
    const h = harness({ contextMenu: false });
    const menu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    h.stage.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
  });

  it("takes double_click from Godot web's rule when `detail` is 0, and from `detail` otherwise", () => {
    const h = harness();
    const click = (dx = 0) => {
      h.fire("pointerdown", down(20 + dx, 5));
      h.fire("pointerup", down(20 + dx, 5, 0, 0));
      return h.take()[0];
    };
    expect(click()).not.toHaveProperty("double_click");
    h.clock.t += 300;
    expect(click(1)).toMatchObject({ double_click: true }); // 2 host px away
    h.clock.t += 100;
    expect(click()).not.toHaveProperty("double_click"); // a triple is not a double
    h.clock.t += 500;
    expect(click()).not.toHaveProperty("double_click"); // too slow
    h.clock.t += 100;
    expect(click(5)).not.toHaveProperty("double_click"); // 10 host px away
    h.fire("pointerdown", { ...down(20, 5), detail: 2 });
    expect(h.take()[0]).toMatchObject({ double_click: true });
  });

  it("starts no press off picture, and releases at the last mapped point", () => {
    const h = harness();
    h.fire("pointerdown", down(5, 5)); // letterbox bar
    h.fire("pointerup", down(5, 5, 0, 0));
    expect(h.take()).toEqual([]);
    expect(h.capture.stats().dropped["off-picture"]).toBe(1);

    h.fire("pointerdown", down(20, 5));
    h.fire("pointermove", down(30, 5, -1, 1));
    h.fire("pointermove", down(2, 5, -1, 1)); // dragged into the bar: no motion
    h.fire("pointerup", down(2, 5, 0, 0));
    h.frame();
    expect(h.take()).toEqual([
      {
        event: "mouse_button",
        button_index: 1,
        pressed: true,
        position: [20, 10],
        button_mask: 1,
      },
      {
        event: "mouse_motion",
        position: [40, 10],
        relative: [20, 0],
        button_mask: 1,
      },
      {
        event: "mouse_button",
        button_index: 1,
        pressed: false,
        position: [40, 10],
      },
    ]);
  });

  it("captures the pointer and cancels a hold whose capture was lost", () => {
    const h = harness();
    h.fire("pointerdown", { ...down(20, 5), pointerId: 7 });
    expect(h.captured).toEqual([7]);
    h.fire("lostpointercapture", { pointerId: 7 });
    expect(h.take().at(-1)).toEqual({
      event: "mouse_button",
      button_index: 1,
      pressed: false,
      position: [20, 10],
      canceled: true,
    });
    // After a normal release the loss is a no-op.
    h.fire("pointerdown", down(20, 5));
    h.fire("pointerup", down(20, 5, 0, 0));
    h.fire("lostpointercapture", { pointerId: 1 });
    expect(h.take()).toHaveLength(2);
  });

  it("releases from a pointerup only the window heard, and leaves other pointerups alone", () => {
    const h = harness();
    const stray = h.make("pointerup", down(20, 5, 3, 0));
    h.win.dispatchEvent(stray);
    expect(stray.defaultPrevented).toBe(false);
    h.fire("pointerdown", down(20, 5));
    const missed = h.make("pointerup", down(500, 5, 0, 0));
    h.win.dispatchEvent(missed);
    expect(missed.defaultPrevented).toBe(true);
    expect(h.take()).toEqual([
      {
        event: "mouse_button",
        button_index: 1,
        pressed: true,
        position: [20, 10],
        button_mask: 1,
      },
      {
        event: "mouse_button",
        button_index: 1,
        pressed: false,
        position: [980, 10],
      },
    ]);
  });

  it("releases a hold on pointercancel with canceled: true", () => {
    const h = harness();
    h.fire("pointerdown", down(20, 5, 2, 2));
    h.fire("pointercancel", { pointerId: 1 });
    expect(h.take()[1]).toEqual({
      event: "mouse_button",
      button_index: MouseButton.RIGHT,
      pressed: false,
      position: [20, 10],
      canceled: true,
    });
  });

  it("releases on blur, hidden, pagehide and dispose, and never re-presses a still-held button", () => {
    for (const how of ["blur", "hidden", "pagehide", "dispose"] as const) {
      const h = harness();
      h.fire("pointerdown", down(20, 5));
      h.fire("pointerdown", {
        ...down(30, 5),
        pointerId: 2,
        pointerType: "touch",
      });
      h.take();
      if (how === "blur") h.win.dispatchEvent(new Event("blur"));
      if (how === "pagehide") h.win.dispatchEvent(new Event("pagehide"));
      if (how === "hidden") {
        h.doc.visibilityState = "hidden";
        h.doc.dispatchEvent(new Event("visibilitychange"));
      }
      if (how === "dispose") h.capture.dispose();
      expect(h.take()).toEqual([
        {
          event: "screen_touch",
          pressed: false,
          position: [40, 10],
          canceled: true,
        },
        {
          event: "mouse_button",
          button_index: 1,
          pressed: false,
          position: [20, 10],
          canceled: true,
        },
      ]);
      h.doc.visibilityState = "visible";
      h.fire("pointermove", down(25, 5, -1, 1));
      h.fire("pointermove", {
        ...down(35, 5),
        pointerId: 2,
        pointerType: "touch",
      });
      h.fire("pointerup", down(25, 5, 0, 0));
      h.fire("pointerup", {
        ...down(35, 5, 0, 0),
        pointerId: 2,
        pointerType: "touch",
      });
      h.frame();
      const after = h.take();
      expect(after.filter((r) => r.event !== "mouse_motion")).toEqual([]);
    }
  });

  it("drops presses while disabled, keeps releases ungated, and releases on refresh()", () => {
    let on = true;
    const h = harness({ enabled: () => on });
    h.fire("pointerdown", down(20, 5));
    on = false;
    h.fire("pointermove", down(20, 5, 2, 3));
    h.fire("pointerup", down(20, 5, 0, 0));
    expect(h.take().map((r) => (r as { pressed?: boolean }).pressed)).toEqual([
      true,
      false,
    ]);
    expect(h.capture.stats().dropped.inactive).toBe(1);
    on = true;
    h.fire("pointerdown", down(20, 5));
    on = false;
    h.capture.refresh();
    expect(h.take().at(-1)).toMatchObject({ pressed: false, canceled: true });
  });

  it("focuses the stage on press (tabindex added), sets touch-action, and undoes both", () => {
    const h = harness();
    expect(h.stage.getAttribute("tabindex")).toBe("-1");
    expect(h.stage.style.touchAction).toBe("none");
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    h.fire("pointerdown", down(20, 5));
    expect(document.activeElement).toBe(h.stage);
    h.capture.dispose();
    expect(h.stage.hasAttribute("tabindex")).toBe(false);
    expect(h.stage.style.touchAction).toBe("");
    other.remove();
  });

  it("keeps an existing tabindex and touch-action when asked", () => {
    const stage = document.createElement("div");
    stage.setAttribute("tabindex", "0");
    const capture = createPointerCapture({
      stage,
      map: letterbox,
      sink: { push: () => {} },
      touchAction: false,
    });
    expect(stage.style.touchAction).toBe("");
    capture.dispose();
    expect(stage.getAttribute("tabindex")).toBe("0");
  });
});

describe("pointer capture: motion", () => {
  it("coalesces motion once per frame with relative summed and flushes before a press", () => {
    const h = harness();
    h.fire("pointermove", down(20, 5, -1, 0));
    h.fire("pointermove", down(21.004, 6, -1, 0));
    h.fire("pointermove", down(23, 7, -1, 0));
    expect(h.records).toEqual([]);
    expect(h.frames).toHaveLength(1);
    h.frame();
    expect(h.take()).toEqual([
      { event: "mouse_motion", position: [26, 14], relative: [6, 4] },
    ]);
    // A fast move then press in one frame: the motion goes first.
    h.fire("pointermove", down(30, 7, -1, 0), { shiftKey: true });
    h.fire("pointerdown", { ...down(31, 7), shiftKey: true });
    expect(h.take()).toEqual([
      {
        event: "mouse_motion",
        position: [40, 14],
        relative: [14, 0],
        shift_pressed: true,
      },
      {
        event: "mouse_button",
        button_index: 1,
        pressed: true,
        position: [42, 14],
        button_mask: 1,
        shift_pressed: true,
      },
    ]);
    h.fire("pointermove", down(32, 7, -1, 1));
    h.frame();
    expect(h.take()).toEqual([
      {
        event: "mouse_motion",
        position: [44, 14],
        relative: [2, 0],
        button_mask: 1,
      },
    ]);
  });

  it("carries pen pressure, tilt and the eraser, and presses LEFT for an eraser contact", () => {
    const h = harness();
    h.fire("pointermove", {
      ...down(20, 5, -1, 0),
      pointerType: "pen",
      pressure: 0.25,
      tiltX: 45,
      tiltY: -90,
    });
    h.frame();
    h.fire("pointerdown", {
      ...down(20, 5, 5, 32),
      pointerType: "pen",
      pressure: 0.5,
    });
    h.fire("pointermove", {
      ...down(21, 5, -1, 32),
      pointerType: "pen",
      pressure: 0.75,
    });
    h.frame();
    expect(h.take()).toEqual([
      {
        event: "mouse_motion",
        position: [20, 10],
        pressure: 0.25,
        tilt: [0.5, -1],
      },
      {
        event: "mouse_button",
        button_index: 1,
        pressed: true,
        position: [20, 10],
        button_mask: 1,
      },
      {
        event: "mouse_motion",
        position: [22, 10],
        relative: [2, 0],
        button_mask: 1,
        pressure: 0.75,
        pen_inverted: true,
      },
    ]);
  });

  it("sends every coalesced sample with coalescedEvents: true", () => {
    const h = harness({ coalescedEvents: true });
    const samples = [20, 21, 22].map((x) =>
      h.make("pointermove", down(x, 5, -1, 0)),
    );
    h.fire("pointermove", down(22, 5, -1, 0), {
      getCoalescedEvents: () => samples,
    });
    expect(h.take().map((r) => (r as { position: unknown }).position)).toEqual([
      [20, 10],
      [22, 10],
      [24, 10],
    ]);
  });

  it("takes relative from movementX/Y under pointer lock and keeps position at the lock point", () => {
    const h = harness({ pointerLock: true });
    let requested = 0;
    Object.assign(h.stage, {
      requestPointerLock: () => {
        requested++;
        return Promise.reject(new Error("no activation"));
      },
    });
    h.fire("pointerdown", down(20, 5));
    expect(requested).toBe(1);
    h.doc.pointerLockElement = h.stage;
    h.fire("pointermove", down(20, 5, -1, 1), { movementX: 3, movementY: -1 });
    h.fire("pointermove", down(20, 5, -1, 1), { movementX: 2, movementY: 0 });
    h.frame();
    expect(h.take().at(-1)).toEqual({
      event: "mouse_motion",
      position: [20, 10],
      relative: [10, -2], // map scales by 2
      button_mask: 1,
    });
  });

  it("flush() pushes pending motion at once", () => {
    const records: InputRecord[] = [];
    const stage = document.createElement("div");
    const capture = createPointerCapture({
      stage,
      map: letterbox,
      sink: { push: (r) => records.push(r) },
      requestAnimationFrame: undefined,
      events: null,
      visibility: null,
    });
    stage.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 20, pointerType: "mouse" }),
    );
    capture.flush();
    expect(records).toEqual([{ event: "mouse_motion", position: [20, 0] }]);
    capture.dispose();
  });
});

describe("pointer capture: touch", () => {
  const touch = (id: number, x: number, buttons = 1) => ({
    ...down(x, 5, 0, buttons),
    pointerId: id,
    pointerType: "touch",
  });

  it("gives each pointer the lowest free index, reuses it, and caps at 32", () => {
    const h = harness();
    h.fire("pointerdown", touch(11, 20));
    h.fire("pointerdown", touch(12, 30));
    h.fire("pointerup", touch(11, 20, 0));
    h.fire("pointerdown", touch(13, 40)); // reuses index 0
    const rec = h.take();
    expect(rec).toEqual([
      { event: "screen_touch", pressed: true, position: [20, 10] },
      { event: "screen_touch", index: 1, pressed: true, position: [40, 10] },
      { event: "screen_touch", pressed: false, position: [20, 10] },
      { event: "screen_touch", pressed: true, position: [60, 10] },
    ]);
    for (let id = 100; id < 131; id++) h.fire("pointerdown", touch(id, 50));
    expect(h.take()).toHaveLength(30);
    expect(h.capture.stats().dropped["max-touches"]).toBe(1);
    expect(h.captured).toContain(13);
  });

  it("coalesces drags per touch per frame and cancels on pointercancel", () => {
    const h = harness();
    h.fire("pointerdown", touch(1, 20));
    h.fire("pointerdown", touch(2, 30));
    h.fire("pointermove", touch(1, 21));
    h.fire("pointermove", touch(1, 22));
    h.fire("pointermove", touch(2, 35));
    h.take();
    h.frame();
    expect(h.take()).toEqual([
      { event: "screen_drag", position: [24, 10], relative: [4, 0] },
      { event: "screen_drag", index: 1, position: [50, 10], relative: [10, 0] },
    ]);
    h.fire("pointermove", touch(2, 36));
    h.fire("pointercancel", touch(2, 36, 0));
    expect(h.take()).toEqual([
      { event: "screen_drag", index: 1, position: [52, 10], relative: [2, 0] },
      {
        event: "screen_touch",
        index: 1,
        pressed: false,
        position: [52, 10],
        canceled: true,
      },
    ]);
    h.fire("pointerup", touch(1, 3, 0)); // released in the bar: the last point
    expect(h.take()).toEqual([
      { event: "screen_touch", pressed: false, position: [24, 10] },
    ]);
  });

  it("never starts a touch off picture and never sends mouse records for touch", () => {
    const h = harness();
    h.fire("pointerdown", touch(1, 3));
    h.fire("pointermove", touch(1, 20));
    h.fire("pointerup", touch(1, 20, 0));
    h.frame();
    expect(h.take()).toEqual([]);
  });
});

describe("pointer capture: wheel", () => {
  const wheel = (init: Extra) => ({ clientX: 20, clientY: 5, ...init });

  it("sends a press+release pair per axis with Godot web's deltaMode factors", () => {
    const h = harness();
    const cases: [Extra, number, number][] = [
      [{ deltaY: 100 }, MouseButton.WHEEL_DOWN, 3],
      [{ deltaY: -100 }, MouseButton.WHEEL_UP, 3],
      [{ deltaY: 3, deltaMode: 1 }, MouseButton.WHEEL_DOWN, 0.9],
      [{ deltaY: -1, deltaMode: 2 }, MouseButton.WHEEL_UP, 1],
      [{ deltaX: 40 }, MouseButton.WHEEL_RIGHT, 1.2],
      [{ deltaX: -40 }, MouseButton.WHEEL_LEFT, 1.2],
    ];
    for (const [init, button, factor] of cases) {
      const event = h.fire("wheel", wheel(init));
      expect(event.defaultPrevented).toBe(true);
      const pair = h.take();
      const press: Record<string, unknown> = {
        event: "mouse_button",
        button_index: button,
        pressed: true,
        position: [20, 10],
        button_mask: 1 << (button - 1),
      };
      if (factor !== 1) press.factor = factor;
      const { button_mask: _mask, ...releaseRest } = press;
      expect(pair).toEqual([press, { ...releaseRest, pressed: false }]);
    }
    expect(h.capture.stats().wheels).toBe(cases.length);
  });

  it("emits vertical then horizontal for a diagonal event, with a held button in the mask", () => {
    const h = harness();
    h.fire("pointerdown", down(20, 5));
    h.take();
    h.fire("wheel", wheel({ deltaX: 10, deltaY: -10, shiftKey: true }));
    expect(
      h
        .take()
        .map((r) => [
          (r as { button_index: number }).button_index,
          (r as { pressed: boolean }).pressed,
          (r as { button_mask?: number }).button_mask,
          (r as { shift_pressed?: boolean }).shift_pressed,
        ]),
    ).toEqual([
      [MouseButton.WHEEL_UP, true, 1 | 8, true],
      [MouseButton.WHEEL_UP, false, 1, true],
      [MouseButton.WHEEL_RIGHT, true, 1 | 64, true],
      [MouseButton.WHEEL_RIGHT, false, 1, true],
    ]);
  });

  it("accumulates trackpad sub-quantum deltas instead of dropping them", () => {
    const h = harness();
    for (let i = 0; i < 9; i++) h.fire("wheel", wheel({ deltaY: 0.001 }));
    // 9 * 0.001 * 0.03 = 0.00027: two whole 1e-4 quanta out, the rest carried.
    const pairs = h.take().filter((r) => (r as { pressed: boolean }).pressed);
    expect(pairs.map((r) => (r as { factor?: number }).factor)).toEqual([
      0.0001, 0.0001,
    ]);
  });

  it("does not take a wheel off picture or while disabled", () => {
    const h = harness();
    const event = h.fire("wheel", wheel({ clientX: 2, deltaY: 100 }));
    expect(event.defaultPrevented).toBe(false);
    expect(h.take()).toEqual([]);
    expect(h.capture.stats().dropped["off-picture"]).toBe(1);
  });

  it("prevents ctrl+wheel and drops it by default", () => {
    const h = harness();
    const event = h.fire("wheel", wheel({ deltaY: -5, ctrlKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(h.take()).toEqual([]);
    expect(h.capture.stats().dropped.pinch).toBe(1);
  });

  it("sends ctrl+wheel as magnify_gesture with pinch: magnify", () => {
    const h = harness({ pinch: "magnify" });
    h.fire("wheel", wheel({ deltaY: -10, ctrlKey: true }));
    h.fire("wheel", wheel({ deltaY: 10, ctrlKey: true }));
    const [zoomIn, zoomOut] = h.take() as {
      event: string;
      factor: number;
      ctrl_pressed: boolean;
    }[];
    expect(zoomIn).toMatchObject({
      event: "magnify_gesture",
      position: [20, 10],
      ctrl_pressed: true,
    });
    expect(zoomIn?.factor).toBeGreaterThan(1);
    expect(zoomOut?.factor).toBeLessThan(1);
    expect((zoomIn?.factor ?? 0) * (zoomOut?.factor ?? 0)).toBeCloseTo(1, 3);
  });
});

describe("pointer capture: held state and the session", () => {
  it("reports the pointer scope: last position, held buttons with masks, touches by index", () => {
    const h = harness();
    expect(h.capture.heldState()).toEqual([{ scope: "pointer", held: [] }]);
    h.fire("pointerdown", down(20, 5, 2, 2));
    h.fire("pointermove", down(25, 5, 0, 3));
    h.fire("pointerdown", {
      ...down(40, 5),
      pointerId: 9,
      pointerType: "touch",
    });
    h.fire("pointerdown", {
      ...down(30, 5),
      pointerId: 8,
      pointerType: "touch",
    });
    h.fire("pointerup", {
      ...down(40, 5, 0, 0),
      pointerId: 9,
      pointerType: "touch",
    });
    const [state] = h.capture.heldState();
    expect(state?.held).toEqual([
      { event: "mouse_motion", position: [30, 10] },
      {
        event: "mouse_button",
        button_index: MouseButton.RIGHT,
        pressed: true,
        position: [30, 10],
        button_mask: 2,
      },
      {
        event: "mouse_button",
        button_index: MouseButton.LEFT,
        pressed: true,
        position: [30, 10],
        button_mask: 3,
      },
      { event: "screen_touch", index: 1, pressed: true, position: [40, 10] },
    ]);
    expectEncodable(h.records);
    // The codec accepts it as a pointer sync.
    expect(
      parseInputMessage(
        encodeInputMessage({
          type: "sync",
          epoch: 1,
          seq: 2,
          scope: "pointer",
          held: state?.held ?? [],
        })[0] ?? "",
      ).ok,
    ).toBe(true);
  });

  it("round-trips through createInputSession: hello, pointer sync, then edges", async () => {
    const texts: string[] = [];
    const session = createInputSession({
      send: (text) => texts.push(text),
      heartbeatMs: 0,
      source: "ptrtest",
    });
    const h = harness({ sink: session });
    session.attach(h.capture);
    h.fire("pointerdown", down(20, 5)); // carrier closed: kept as held state
    session.open();
    h.fire("wheel", { clientX: 20, clientY: 5, deltaY: 100 });
    h.fire("pointerup", down(20, 5, 0, 0));
    await Promise.resolve();
    const messages = texts.map((text) => {
      const parsed = parseInputMessage(text);
      if (!parsed.ok) throw new Error(parsed.detail);
      return parsed.message;
    });
    expect(messages.map((m) => m.type)).toEqual(["hello", "sync", "events"]);
    expect(messages[1]).toMatchObject({
      scope: "pointer",
      held: [
        { event: "mouse_motion" },
        { event: "mouse_button", button_index: 1, pressed: true },
      ],
    });
    expect(messages[2]).toMatchObject({
      events: [
        { button_index: 5, pressed: true, button_mask: 17, factor: 3 },
        { button_index: 5, pressed: false, button_mask: 1, factor: 3 },
        { button_index: 1, pressed: false },
      ],
    });
    session.dispose();
  });

  it("pushes only records the codec accepts, with no target fields when targets are off", () => {
    const h = harness({ pinch: "magnify" });
    h.fire("pointermove", down(1e9, 1e9, -1, 0));
    h.fire("pointerdown", down(20, 5));
    h.fire("pointermove", down(20.123456, 5.987654, -1, 1));
    h.fire("wheel", { clientX: 20, clientY: 5, deltaX: 1e9 });
    h.fire("wheel", { clientX: 20, clientY: 5, deltaY: -3, ctrlKey: true });
    h.fire("pointerdown", {
      ...down(30, 5),
      pointerId: 4,
      pointerType: "touch",
    });
    h.fire("pointermove", {
      ...down(31, 5),
      pointerId: 4,
      pointerType: "touch",
    });
    h.frame();
    h.capture.dispose();
    expectEncodable(h.records);
    for (const record of h.records) {
      expect(record).not.toHaveProperty("target");
      expect(record).not.toHaveProperty("local");
    }
  });

  it("rejects modes and target settings later increments add", () => {
    const base = {
      stage: document.createElement("div"),
      map: letterbox,
      sink: { push: () => {} },
    };
    expect(() =>
      createPointerCapture({ ...base, mode: "mouse" as "native" }),
    ).toThrow(/mode/);
    expect(() =>
      createPointerCapture({ ...base, targets: "all" as "off" }),
    ).toThrow(/targets/);
  });
});

describe("objectFitMapper", () => {
  const box = { left: 100, top: 50, width: 400, height: 300 };
  const size = { width: 1600, height: 900 }; // 16:9 in a 4:3 box

  it("contain: letterboxes and maps into host px", () => {
    const map = objectFitMapper(box, size, "contain");
    // Drawn 400x225, top bars of 37.5 px.
    expect(map(100, 87.5)).toEqual({ x: 0, y: 0 });
    expect(map(300, 200)).toEqual({ x: 800, y: 450 });
    expect(map(500, 312.5)).toEqual({ x: 1600, y: 900 });
    expect(map(300, 60)).toBeNull();
    expect(map(99, 200)).toBeNull();
  });

  it("cover crops to the box, fill stretches, none and scale-down keep 1:1", () => {
    const cover = objectFitMapper(box, size, "cover");
    // Drawn 533.33x300, centred: left edge at 100 - 66.67.
    expect(cover(300, 200)?.x).toBeCloseTo(800, 6);
    expect(cover(300, 200)?.y).toBeCloseTo(450, 6);
    expect(cover(100, 50)?.x).toBeCloseTo(200, 6);
    expect(cover(99, 50)).toBeNull();
    const fill = objectFitMapper(box, size, "fill");
    expect(fill(500, 350)).toEqual({ x: 1600, y: 900 });
    const small = { width: 200, height: 100 };
    expect(objectFitMapper(box, small, "none")(300, 200)).toEqual({
      x: 100,
      y: 50,
    });
    expect(objectFitMapper(box, small, "scale-down")(200, 150)).toEqual({
      x: 0,
      y: 0,
    });
    expect(objectFitMapper(box, size, "scale-down")(300, 200)).toEqual({
      x: 800,
      y: 450,
    });
  });

  it("honours object-position and reads getters live", () => {
    let current = { ...box };
    const map = objectFitMapper(
      () => current,
      () => size,
      "contain",
      {
        x: 0,
        y: 0,
      },
    );
    expect(map(100, 50)).toEqual({ x: 0, y: 0 });
    expect(map(100, 280)).toBeNull(); // the bar is at the bottom now
    current = { left: 0, top: 0, width: 0, height: 0 };
    expect(map(0, 0)).toBeNull();
  });
});
