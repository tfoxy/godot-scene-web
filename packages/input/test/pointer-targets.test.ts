// createPointerCapture's opt-in targets (docs/input.md "Pointer targets"): resolve counts per mode,
// handle interning and declarations, re-declaration in heldState, sanitising, recycling, and the
// pure path (targets off: no resolver call, no target bytes).

import {
  createPointerCapture,
  type PointerCaptureOptions,
  type PointerTargetHit,
  type PointerTargetResolver,
} from "@godot-scene-web/input/pointer";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInputSession,
  encodeInputMessage,
  type InputRecord,
  parseInputMessage,
} from "../src/index";

class FakeDocument extends EventTarget {
  visibilityState = "visible";
  pointerLockElement: unknown = null;
}

type Extra = Record<string, unknown>;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Two nodes side by side in client px: A covers x < 100, B covers x >= 100 (y < 100). */
function nodes(calls: [number, number][] = []): PointerTargetResolver {
  return (clientX, clientY, point) => {
    calls.push([clientX, clientY]);
    if (clientY >= 100) return null;
    const a = clientX < 100;
    return {
      key: a ? "A" : "B",
      identity: a
        ? { path: "Main/A", scene: "res://main.tscn", class: "Button" }
        : { path: "Main/B", item: 7 },
      local: { x: point.x - (a ? 0 : 200), y: point.y },
      frame: 42,
    };
  };
}

function harness(options: Partial<PointerCaptureOptions> = {}) {
  const stage = document.createElement("div");
  document.body.append(stage);
  Object.assign(stage, { setPointerCapture: () => {} });
  const frames: ((time: number) => void)[] = [];
  const records: InputRecord[] = [];
  const doc = new FakeDocument();
  const capture = createPointerCapture({
    stage,
    // host px = client px * 2
    map: (x, y) => ({ x: x * 2, y: y * 2 }),
    sink: { push: (record) => records.push(record) },
    events: new EventTarget(),
    visibility: doc,
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: () => {},
    now: () => 0,
    ...options,
  });
  cleanups.push(() => {
    capture.dispose();
    stage.remove();
  });
  const fire = (type: string, init: Extra = {}) => {
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
    stage.dispatchEvent(event);
  };
  const frame = () => {
    for (const cb of frames.splice(0)) cb(0);
  };
  return {
    capture,
    records,
    fire,
    frame,
    doc,
    stage,
    take: () => records.splice(0),
  };
}

const at = (clientX: number, clientY: number, extra: Extra = {}) => ({
  clientX,
  clientY,
  ...extra,
});
const press = (x: number, y: number) => at(x, y, { button: 0, buttons: 1 });
const lift = (x: number, y: number) => at(x, y, { button: 0, buttons: 0 });

function expectEncodable(records: readonly InputRecord[]) {
  for (let i = 0; i < records.length; i += 64)
    encodeInputMessage({
      type: "events",
      epoch: 1,
      seq: 1,
      events: records.slice(i, i + 64),
    });
}

describe("pointer targets: off (the pure path)", () => {
  it("never calls a resolver and sends no target bytes", () => {
    const calls: [number, number][] = [];
    const h = harness({ resolveTarget: nodes(calls) });
    h.fire("pointermove", at(10, 10));
    h.frame();
    h.fire("pointerdown", press(20, 10));
    h.fire("pointermove", at(150, 10, { buttons: 1 }));
    h.frame();
    h.fire("pointerup", lift(150, 10));
    h.fire("wheel", at(150, 10, { deltaY: 100 }));
    h.fire(
      "pointerdown",
      at(30, 30, { pointerType: "touch", pointerId: 9, buttons: 1 }),
    );
    h.fire("pointerup", at(30, 30, { pointerType: "touch", pointerId: 9 }));
    const records = h.take();
    expect(records.length).toBeGreaterThan(5);
    expect(calls).toEqual([]);
    const text = encodeInputMessage({
      type: "events",
      epoch: 1,
      seq: 1,
      events: records,
    })[0];
    expect(text).not.toMatch(/"target"|"local"|"frame"|"handle"/);
    expect(
      h.capture.heldState()[0].held.some((r) => r.event === "target"),
    ).toBe(false);
    expect(h.capture.stats()).toMatchObject({ resolves: 0, declarations: 0 });
  });

  it("needs a resolver for press and all, and refuses unknown modes", () => {
    const stage = document.createElement("div");
    const base = { stage, map: () => null, sink: { push() {} } };
    expect(() => createPointerCapture({ ...base, targets: "press" })).toThrow(
      /resolveTarget/,
    );
    expect(() =>
      createPointerCapture({
        ...base,
        targets: "some" as "all",
        resolveTarget: nodes(),
      }),
    ).toThrow(/unsupported targets/);
  });
});

describe("pointer targets: press", () => {
  it("resolves presses and releases once each, declaring a handle once", () => {
    const calls: [number, number][] = [];
    const h = harness({ targets: "press", resolveTarget: nodes(calls) });
    h.fire("pointermove", at(10, 10));
    h.frame();
    h.fire("pointerdown", press(10, 10));
    h.fire("pointermove", at(20, 10, { buttons: 1 }));
    h.frame();
    h.fire("pointerup", lift(20, 10));
    h.fire("pointerdown", press(30, 10));
    h.fire("pointerup", lift(30, 10));
    const records = h.take();
    expectEncodable(records);
    expect(calls).toEqual([
      [10, 10],
      [20, 10],
      [30, 10],
      [30, 10],
    ]);
    expect(records).toEqual([
      { event: "mouse_motion", position: [20, 20] },
      {
        event: "target",
        handle: 1,
        path: "Main/A",
        scene: "res://main.tscn",
        class: "Button",
      },
      {
        event: "mouse_button",
        button_index: 1,
        pressed: true,
        position: [20, 20],
        button_mask: 1,
        target: 1,
        local: [20, 20],
        frame: 42,
      },
      // Motion carries no target in "press" mode.
      {
        event: "mouse_motion",
        position: [40, 20],
        relative: [20, 0],
        button_mask: 1,
      },
      {
        event: "mouse_button",
        button_index: 1,
        pressed: false,
        position: [40, 20],
        target: 1,
        local: [40, 20],
        frame: 42,
      },
      {
        event: "mouse_button",
        button_index: 1,
        pressed: true,
        position: [60, 20],
        button_mask: 1,
        target: 1,
        local: [60, 20],
        frame: 42,
      },
      {
        event: "mouse_button",
        button_index: 1,
        pressed: false,
        position: [60, 20],
        target: 1,
        local: [60, 20],
        frame: 42,
      },
    ]);
    expect(h.capture.stats()).toMatchObject({ resolves: 4, declarations: 1 });
  });

  it("resolves a wheel event once for all its steps; a miss sends no fields", () => {
    const calls: [number, number][] = [];
    const h = harness({ targets: "press", resolveTarget: nodes(calls) });
    h.fire("wheel", at(150, 10, { deltaY: 100, deltaX: 50 }));
    h.fire("wheel", at(150, 150, { deltaY: 100 }));
    const records = h.take();
    expectEncodable(records);
    expect(calls).toEqual([
      [150, 10],
      [150, 150],
    ]);
    expect(records[0]).toEqual({
      event: "target",
      handle: 1,
      path: "Main/B",
      item: 7,
    });
    const wheel = records.slice(1, 5);
    expect(
      wheel.map((r) => [r.event, "target" in r ? r.target : null]),
    ).toEqual([
      ["mouse_button", 1],
      ["mouse_button", 1],
      ["mouse_button", 1],
      ["mouse_button", 1],
    ]);
    expect(records.slice(5).every((r) => !("target" in r))).toBe(true);
  });

  it("resolves touch presses and releases, not drags or cancels", () => {
    const calls: [number, number][] = [];
    const h = harness({ targets: "press", resolveTarget: nodes(calls) });
    const touch = (x: number, y: number) =>
      at(x, y, { pointerType: "touch", pointerId: 5, buttons: 1 });
    h.fire("pointerdown", touch(10, 10));
    h.fire("pointermove", touch(150, 10));
    h.frame();
    h.fire("pointerup", touch(150, 10));
    h.fire("pointerdown", touch(20, 20));
    h.fire("pointercancel", touch(20, 20));
    const records = h.take();
    expectEncodable(records);
    expect(calls).toEqual([
      [10, 10],
      [150, 10],
      [20, 20],
    ]);
    expect(
      records.map((r) => [r.event, "target" in r ? r.target : null]),
    ).toEqual([
      ["target", null],
      ["screen_touch", 1],
      ["screen_drag", null],
      ["target", null],
      ["screen_touch", 2],
      ["screen_touch", 1],
      ["screen_touch", null],
    ]);
  });
});

describe("pointer targets: all", () => {
  it("resolves once per coalesced motion frame, never per raw pointermove", () => {
    const calls: [number, number][] = [];
    const h = harness({ targets: "all", resolveTarget: nodes(calls) });
    for (let x = 10; x <= 50; x += 10) h.fire("pointermove", at(x, 10));
    expect(calls).toEqual([]);
    h.frame();
    for (let x = 110; x <= 150; x += 10) h.fire("pointermove", at(x, 10));
    h.frame();
    h.fire("pointermove", at(150, 150));
    h.frame();
    const records = h.take();
    expectEncodable(records);
    expect(calls).toEqual([
      [50, 10],
      [150, 10],
      [150, 150],
    ]);
    expect(records).toEqual([
      {
        event: "target",
        handle: 1,
        path: "Main/A",
        scene: "res://main.tscn",
        class: "Button",
      },
      {
        event: "mouse_motion",
        position: [100, 20],
        relative: [80, 0],
        target: 1,
        local: [100, 20],
        frame: 42,
      },
      { event: "target", handle: 2, path: "Main/B", item: 7 },
      {
        event: "mouse_motion",
        position: [300, 20],
        relative: [200, 0],
        target: 2,
        local: [100, 20],
        frame: 42,
      },
      // Over no node: no target fields at all.
      { event: "mouse_motion", position: [300, 300], relative: [0, 280] },
    ]);
  });

  it("stamps touch drags once per frame per touch", () => {
    const calls: [number, number][] = [];
    const h = harness({ targets: "all", resolveTarget: nodes(calls) });
    const touch = (id: number, x: number, y: number) =>
      at(x, y, { pointerType: "touch", pointerId: id, buttons: 1 });
    h.fire("pointerdown", touch(1, 10, 10));
    h.fire("pointerdown", touch(2, 150, 10));
    h.fire("pointermove", touch(1, 12, 10));
    h.fire("pointermove", touch(1, 14, 10));
    h.fire("pointermove", touch(2, 160, 10));
    h.frame();
    expect(calls.length).toBe(4);
    const drags = h.take().filter((r) => r.event === "screen_drag");
    expect(drags.map((d) => ("target" in d ? d.target : null))).toEqual([1, 2]);
  });

  it("re-declares in heldState, then lazily for the rest", () => {
    const h = harness({ targets: "all", resolveTarget: nodes() });
    h.fire("pointermove", at(150, 10));
    h.frame();
    h.fire("pointermove", at(10, 10));
    h.frame();
    h.take();
    const held = h.capture.heldState();
    expect(held[0].held).toEqual([
      {
        event: "target",
        handle: 2,
        path: "Main/A",
        scene: "res://main.tscn",
        class: "Button",
      },
      {
        event: "mouse_motion",
        position: [20, 20],
        target: 2,
        local: [20, 20],
        frame: 42,
      },
    ]);
    const sync = parseInputMessage(
      JSON.stringify({
        type: "sync",
        epoch: 2,
        seq: 1,
        scope: "pointer",
        held: held[0].held,
      }),
    );
    expect(sync.ok).toBe(true);
    // A's handle 2 was declared by the held state; B's handle 1 is re-declared on next use.
    h.fire("pointermove", at(12, 10));
    h.frame();
    h.fire("pointermove", at(150, 10));
    h.frame();
    expect(h.take().map((r) => r.event)).toEqual([
      "mouse_motion",
      "target",
      "mouse_motion",
    ]);
    expect(h.capture.stats().declarations).toBe(4);
  });

  it("drops a moved held target from heldState (its local no longer matches)", () => {
    const h = harness({ targets: "press", resolveTarget: nodes() });
    h.fire("pointerdown", press(10, 10));
    h.fire("pointermove", at(30, 10, { buttons: 1 }));
    h.frame();
    const held = h.capture.heldState()[0].held;
    expect(held.some((r) => r.event === "target" || "target" in r)).toBe(false);
  });
});

describe("pointer targets: interning", () => {
  it("passes through instance ids and re-declares a changed id under one key", () => {
    let instanceId: string | undefined = "9007199254740993";
    const h = harness({
      targets: "all",
      resolveTarget: () => ({
        key: "same-node",
        identity: {
          item: 5,
          ...(instanceId === undefined ? {} : { instanceId }),
        },
        local: { x: 0, y: 0 },
      }),
    });
    let x = 10;
    const move = () => {
      h.fire("pointermove", at(x++, 10));
      h.frame();
    };
    move();
    move();
    instanceId = "18446744073709551615";
    move();
    instanceId = undefined;
    move();
    const records = h.take();
    expectEncodable(records);
    expect(records.filter((r) => r.event === "target")).toEqual([
      { event: "target", handle: 1, item: 5, instance_id: "9007199254740993" },
      {
        event: "target",
        handle: 1,
        item: 5,
        instance_id: "18446744073709551615",
      },
      { event: "target", handle: 1, item: 5 },
    ]);
  });

  it.each([
    "01",
    "0",
    "100000000000000000000",
    "18446744073709551616",
    "12x",
    "",
    "1\n",
    "１２",
    123,
  ])("drops invalid instance id %j without losing the hit", (instanceId) => {
    const h = harness({
      targets: "press",
      resolveTarget: () => ({
        key: "k",
        identity: { path: "Main/A", instanceId: instanceId as string },
        local: { x: 0, y: 0 },
      }),
    });
    h.fire("pointerdown", press(10, 10));
    const records = h.take();
    expectEncodable(records);
    expect(records[0]).toEqual({ event: "target", handle: 1, path: "Main/A" });
    expect(records[1]).toMatchObject({ target: 1 });
  });

  it("drops invalid identity fields, and a hit without path or item", () => {
    const hits: (PointerTargetHit | null)[] = [
      {
        key: 1,
        identity: {
          path: "Bad\npath",
          item: 3,
          class: "Not.A.Class",
          scene: "res://x",
        },
        local: { x: 1.234, y: 2 },
        frame: 1.5,
      },
      {
        key: 2,
        identity: { path: "", scene: "res://x" },
        local: { x: 0, y: 0 },
      },
      { key: 3, identity: { path: "A" }, local: { x: Number.NaN, y: 0 } },
    ];
    let i = 0;
    const h = harness({
      targets: "press",
      resolveTarget: () => hits[i++] ?? null,
    });
    for (let n = 0; n < 3; n++) {
      h.fire("pointerdown", press(10, 10));
      h.fire("pointerup", lift(10, 10));
    }
    const records = h.take();
    expectEncodable(records);
    expect(records[0]).toEqual({ event: "target", handle: 1, item: 3 });
    expect(records[1]).toMatchObject({ target: 1, local: [1.23, 2] });
    expect(records[1]).not.toHaveProperty("frame");
    expect(
      records.slice(3).every((r) => r.event !== "target" && !("target" in r)),
    ).toBe(true);
  });

  it("keeps input flowing when the resolver throws", () => {
    const h = harness({
      targets: "press",
      resolveTarget: () => {
        throw new Error("boom");
      },
    });
    h.fire("pointerdown", press(10, 10));
    expect(h.take()).toEqual([
      {
        event: "mouse_button",
        button_index: 1,
        pressed: true,
        position: [20, 20],
        button_mask: 1,
      },
    ]);
  });

  it("re-declares a key whose identity changed, under the same handle", () => {
    let path = "Main/A";
    const h = harness({
      targets: "press",
      resolveTarget: () => ({
        key: "k",
        identity: { item: 5, path },
        local: { x: 0, y: 0 },
      }),
    });
    h.fire("pointerdown", press(10, 10));
    path = "Main/Renamed";
    h.fire("pointerup", lift(10, 10));
    const declarations = h.take().filter((r) => r.event === "target");
    expect(declarations).toEqual([
      { event: "target", handle: 1, path: "Main/A", item: 5 },
      { event: "target", handle: 1, path: "Main/Renamed", item: 5 },
    ]);
  });

  it("recycles the least recently used handle past 1023", () => {
    let key = 0;
    const h = harness({
      targets: "press",
      resolveTarget: () => ({
        key,
        identity: { item: key },
        local: { x: 0, y: 0 },
      }),
    });
    for (key = 1; key <= 1024; key++)
      h.fire("wheel", at(10, 10, { deltaY: 100 }));
    key = 2; // touch handle 2 so handle 1's key stays least recently used
    const declarations = h.take().filter((r) => r.event === "target");
    expect(declarations.length).toBe(1024);
    expect(declarations[1022]).toEqual({
      event: "target",
      handle: 1023,
      item: 1023,
    });
    expect(declarations[1023]).toEqual({
      event: "target",
      handle: 1,
      item: 1024,
    });
  });

  it("does not resolve while the pointer is locked", () => {
    const calls: [number, number][] = [];
    const h = harness({
      targets: "all",
      resolveTarget: nodes(calls),
      pointerLock: true,
    });
    h.fire("pointerdown", press(10, 10));
    h.doc.pointerLockElement = h.stage;
    h.fire("pointermove", at(10, 10, { buttons: 1, movementX: 5 }));
    h.frame();
    h.fire("pointerup", lift(10, 10));
    expect(calls).toEqual([[10, 10]]);
  });

  it("round-trips through a session: declarations precede their first use", () => {
    const texts: string[] = [];
    const session = createInputSession({
      source: "t",
      send: (text) => texts.push(text),
    });
    const h = harness({
      targets: "all",
      resolveTarget: nodes(),
      sink: session,
    });
    session.attach(h.capture);
    session.open();
    h.fire("pointermove", at(10, 10));
    h.frame();
    h.fire("pointerdown", press(150, 10));
    h.fire("pointerup", lift(150, 10));
    session.flush();
    const events = texts
      .map((text) => parseInputMessage(text))
      .flatMap((r) =>
        r.ok && r.message.type === "events" ? r.message.events : [],
      );
    expect(events.map((e) => e.event)).toEqual([
      "target",
      "mouse_motion",
      "target",
      "mouse_button",
      "mouse_button",
    ]);
  });
});

describe("pointer targets: mouse mode", () => {
  const finger = (x: number, y: number, id = 3) =>
    at(x, y, { pointerType: "touch", pointerId: id, buttons: 1 });
  const lifted = (x: number, y: number, id = 3) =>
    at(x, y, { pointerType: "touch", pointerId: id, buttons: 0 });

  it("resolves a tap's press and release at the lift point (press mode)", () => {
    const calls: [number, number][] = [];
    const h = harness({
      mode: "mouse",
      targets: "press",
      resolveTarget: nodes(calls),
    });
    h.fire("pointerdown", finger(150, 10));
    h.fire("pointerup", lifted(152, 10));
    const records = h.take();
    expectEncodable(records);
    expect(calls).toEqual([
      [152, 10],
      [152, 10],
    ]);
    expect(
      records.map((r) => [r.event, "target" in r ? r.target : null]),
    ).toEqual([
      ["mouse_motion", null],
      ["target", null],
      ["mouse_button", 1],
      ["mouse_button", 1],
    ]);
  });

  it("stamps the hover-first motion and the drag in all mode, the press at the down point", () => {
    const calls: [number, number][] = [];
    const h = harness({
      mode: "mouse",
      targets: "all",
      resolveTarget: nodes(calls),
    });
    h.fire("pointerdown", finger(10, 10));
    h.fire("pointermove", finger(150, 10));
    h.frame();
    h.fire("pointerup", lifted(150, 10));
    const records = h.take();
    expectEncodable(records);
    // hover + press at the down point (10, 10), then the coalesced drag and the release at 150.
    expect(calls).toEqual([
      [10, 10],
      [10, 10],
      [150, 10],
      [150, 10],
    ]);
    const stamped = records
      .filter((r) => r.event !== "target")
      .map((r) => [r.event, "target" in r ? r.target : null]);
    expect(stamped).toEqual([
      ["mouse_motion", 1],
      ["mouse_button", 1],
      ["mouse_motion", 2],
      ["mouse_button", 2],
    ]);
  });

  it("resolves hover() and click() only when given a client point", () => {
    const calls: [number, number][] = [];
    const h = harness({
      mode: "mouse",
      targets: "all",
      resolveTarget: nodes(calls),
    });
    h.capture.hover([20, 20]);
    h.capture.click(1, [20, 20]);
    expect(calls).toEqual([]);
    h.capture.hover([20, 20], [10, 10]);
    h.capture.click(1, [300, 20], [150, 10]);
    h.capture.click(4, [300, 20], [150, 10]);
    expect(calls).toEqual([
      [10, 10],
      [150, 10],
      [150, 10],
      [150, 10],
    ]);
    const records = h.take();
    expectEncodable(records);
    expect(records.filter((r) => "target" in r).length).toBe(5);
  });
});
