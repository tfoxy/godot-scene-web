// createKeyboardCapture against docs/input.md "Keyboard" and the K1-K14 edge-case matrix.

import {
  createKeyboardCapture,
  type FocusedElementLike,
  type KeyboardCaptureOptions,
  type KeyboardLayoutLike,
} from "@godot-scene-web/input/keyboard";
import { describe, expect, it, vi } from "vitest";
import {
  createInputSession,
  encodeInputMessage,
  type InputRecord,
  Key,
  KeyLocation,
  type KeyRecord,
  parseInputMessage,
} from "../src/index";

type Listener = (event: unknown) => void;

class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

class FakeDocument extends FakeTarget {
  visibilityState = "visible";
  activeElement: FocusedElementLike | null = null;
}

interface KeyInit {
  code: string;
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  altGraph?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

function harness(options: Partial<KeyboardCaptureOptions> = {}) {
  const win = new FakeTarget();
  const doc = new FakeDocument();
  const records: InputRecord[] = [];
  const capture = createKeyboardCapture({
    sink: { push: (record) => records.push(record) },
    events: win,
    visibility: doc,
    keyboard: null,
    platform: "Linux x86_64",
    ...options,
  });
  const fire = (type: "keydown" | "keyup", init: KeyInit) => {
    const event = {
      ...init,
      type,
      getModifierState: (key: string) =>
        key === "AltGraph" ? init.altGraph === true : false,
      preventDefault: vi.fn(),
    };
    win.emit(type, event);
    return event.preventDefault;
  };
  const down = (init: KeyInit) => fire("keydown", init);
  const up = (init: KeyInit) => fire("keyup", init);
  const take = () => records.splice(0) as KeyRecord[];
  return { win, doc, capture, records, take, down, up };
}

const W = { code: "KeyW", key: "w" };
const pressW: KeyRecord = {
  event: "key",
  physical_keycode: Key.W,
  keycode: Key.W,
  key_label: Key.W,
  unicode: 0x77,
  pressed: true,
  code: "KeyW",
};
const releaseW: KeyRecord = { ...pressW, pressed: false };

const element = (
  tagName: string,
  extra: Partial<FocusedElementLike> & { attrs?: Record<string, string> } = {},
): FocusedElementLike => ({
  tagName,
  ...extra,
  hasAttribute: (name) => extra.attrs?.[name] !== undefined,
  getAttribute: (name) => extra.attrs?.[name] ?? null,
});

describe("createKeyboardCapture", () => {
  it("forwards a press and replays it on release", () => {
    const h = harness();
    h.down(W);
    h.up(W);
    expect(h.take()).toEqual([pressW, releaseW]);
    expect(h.capture.stats()).toMatchObject({ presses: 1, releases: 1 });
  });

  it("K1: drops auto-repeat by default, sends the latched press as echo when asked", () => {
    const off = harness();
    off.down(W);
    off.down({ ...W, repeat: true });
    expect(off.take()).toEqual([pressW]);
    expect(off.capture.stats().dropped.repeat).toBe(1);

    const on = harness({ echo: true });
    on.down({ ...W, shiftKey: true, key: "W" });
    on.down({ ...W, repeat: true }); // Shift already released: the echo is still the latched press
    const [press, echo] = on.take();
    expect(echo).toEqual({ ...press, echo: true });
    expect(on.capture.stats().echoes).toBe(1);

    // A repeat for a key that was never latched is never sent, echo or not.
    on.down({ code: "KeyE", key: "e", repeat: true });
    expect(on.take()).toEqual([]);
  });

  it("K2: a second keydown of a held key is ignored", () => {
    const h = harness();
    h.down(W);
    h.down(W);
    h.up(W);
    expect(h.take()).toEqual([pressW, releaseW]);
    expect(h.capture.stats().dropped.held).toBe(1);
  });

  it("K3: a release is ungated (text focus, Ctrl, disabled, composing)", () => {
    let on = true;
    const h = harness({ enabled: () => on });
    h.down(W);
    h.doc.activeElement = element("TEXTAREA");
    on = false;
    h.up({ ...W, ctrlKey: true, isComposing: true, keyCode: 229 });
    expect(h.take()).toEqual([pressW, releaseW]);
    // An unlatched keyup sends nothing.
    h.up({ code: "KeyE", key: "e" });
    expect(h.take()).toEqual([]);
  });

  it("K4: blur, hidden, pagehide, disable and dispose release everything", () => {
    for (const end of ["blur", "hidden", "pagehide", "disable", "dispose"]) {
      let on = true;
      const h = harness({ enabled: () => on });
      h.down(W);
      h.down({ code: "ShiftLeft", key: "Shift", shiftKey: true });
      h.take();
      if (end === "blur") h.win.emit("blur");
      if (end === "pagehide") h.win.emit("pagehide");
      if (end === "hidden") {
        h.doc.visibilityState = "hidden";
        h.doc.emit("visibilitychange");
      }
      if (end === "disable") {
        on = false;
        h.capture.refresh();
      }
      if (end === "dispose") h.capture.dispose();
      const released = h.take();
      expect(
        released.map((r) => [r.code, r.pressed]),
        end,
      ).toEqual([
        ["KeyW", false],
        ["ShiftLeft", false],
      ]);
      expect(h.capture.held(), end).toEqual([]);
    }
  });

  it("K4: does not press while hidden or disabled, and dispose removes every listener", () => {
    let on = false;
    const h = harness({ enabled: () => on });
    h.down(W);
    on = true;
    h.doc.visibilityState = "hidden";
    h.down(W);
    expect(h.take()).toEqual([]);
    expect(h.capture.stats().dropped.inactive).toBe(2);
    h.capture.dispose();
    expect(h.win.count() + h.doc.count()).toBe(0);
    h.doc.visibilityState = "visible";
    h.down(W);
    expect(h.take()).toEqual([]);
  });

  it("K5: ctrl/meta chords stay with the browser, the modifier keys themselves are forwarded", () => {
    const h = harness();
    const prevented = h.down({ code: "KeyR", key: "r", ctrlKey: true });
    h.down({ code: "KeyT", key: "t", metaKey: true });
    expect(h.take()).toEqual([]);
    expect(prevented).not.toHaveBeenCalled();
    expect(h.capture.stats().dropped.chord).toBe(2);

    h.down({ code: "ControlLeft", key: "Control", ctrlKey: true });
    h.down({ code: "MetaLeft", key: "Meta", metaKey: true });
    h.down({ code: "ShiftLeft", key: "Shift", shiftKey: true, ctrlKey: true });
    expect(h.take().map((r) => r.code)).toEqual([
      "ControlLeft",
      "MetaLeft",
      "ShiftLeft",
    ]);

    const forward = harness({ chords: "forward" });
    forward.down({ code: "KeyR", key: "r", ctrlKey: true });
    expect(forward.take()).toMatchObject([
      { keycode: Key.R, ctrl_pressed: true },
    ]);
  });

  it("K6: AltGr is exempt from the chord rule; the AltGraph key is ALT on the right", () => {
    const h = harness();
    h.down({ code: "ControlLeft", key: "Control", ctrlKey: true }); // Windows phantom
    h.down({
      code: "AltRight",
      key: "AltGraph",
      ctrlKey: true,
      altKey: true,
      altGraph: true,
    });
    h.down({
      code: "KeyQ",
      key: "@",
      ctrlKey: true,
      altKey: true,
      altGraph: true,
    });
    const [ctrl, altGr, at] = h.take();
    expect(ctrl).toMatchObject({
      keycode: Key.CTRL,
      location: KeyLocation.LEFT,
    });
    expect(altGr).toMatchObject({
      keycode: Key.ALT,
      location: KeyLocation.RIGHT,
    });
    expect(at).toMatchObject({
      keycode: Key.Q,
      key_label: 0x40,
      unicode: 0x40,
      ctrl_pressed: true,
      alt_pressed: true,
    });
  });

  it("K7: an IME-composing press is not forwarded; a release still owed is sent", () => {
    const h = harness();
    h.down({ code: "KeyN", key: "Process", keyCode: 229 });
    h.down({ code: "KeyI", key: "Process", isComposing: true, keyCode: 229 });
    expect(h.take()).toEqual([]);
    expect(h.capture.stats().dropped.composing).toBe(2);
    h.down(W);
    h.up({ ...W, key: "Process", isComposing: true, keyCode: 229 });
    expect(h.take()).toEqual([pressW, releaseW]);
  });

  it("K8: a dead key forwards its physical key with no unicode", () => {
    const h = harness();
    h.down({ code: "Quote", key: "Dead" });
    expect(h.take()).toEqual([
      {
        event: "key",
        physical_keycode: Key.APOSTROPHE,
        keycode: Key.APOSTROPHE,
        key_label: Key.APOSTROPHE,
        pressed: true,
        code: "Quote",
      },
    ]);
  });

  it("K9: Shift released before the symbol key, the release replays the press", () => {
    const h = harness();
    h.down({ code: "ShiftLeft", key: "Shift", shiftKey: true });
    h.down({ code: "Digit1", key: "!", shiftKey: true });
    h.up({ code: "ShiftLeft", key: "Shift" });
    h.up({ code: "Digit1", key: "1" });
    const [, bang, , release] = h.take();
    expect(bang).toMatchObject({
      keycode: Key.KEY_1,
      key_label: 0x21,
      shift_pressed: true,
    });
    expect(release).toEqual({ ...bang, pressed: false });
  });

  it("K10: macMetaRelease releases latched non-modifier keys on Meta down and up", () => {
    const h = harness({ platform: "MacIntel", chords: "forward" });
    h.down({ code: "ShiftLeft", key: "Shift", shiftKey: true });
    h.down({ code: "KeyW", key: "W", shiftKey: true });
    h.take();
    h.down({ code: "MetaLeft", key: "Meta", metaKey: true, shiftKey: true });
    expect(h.take().map((r) => [r.code, r.pressed])).toEqual([
      ["KeyW", false],
      ["MetaLeft", true],
    ]);
    h.down({ code: "KeyS", key: "s", metaKey: true }); // its keyup will be lost
    h.up({ code: "MetaLeft", key: "Meta" });
    expect(h.take().map((r) => [r.code, r.pressed])).toEqual([
      ["KeyS", true],
      ["KeyS", false],
      ["MetaLeft", false],
    ]);
    expect(h.capture.held()).toEqual(["ShiftLeft"]);

    const linux = harness({ chords: "forward" });
    linux.down(W);
    linux.down({ code: "MetaLeft", key: "Meta", metaKey: true });
    expect(linux.capture.held()).toEqual(["KeyW", "MetaLeft"]);
    expect(harness({ macMetaRelease: true }).capture).toBeDefined();
  });

  it("K11: text-entry and activation guards, the stage exempt", () => {
    const stage = element("CANVAS", { attrs: { tabindex: "0" } });
    const h = harness({ stage });
    const space = { code: "Space", key: " " };

    h.doc.activeElement = element("INPUT", { type: "text" });
    h.down(W);
    h.doc.activeElement = element("DIV", { isContentEditable: true });
    h.down(W);
    expect(h.capture.stats().dropped["text-entry"]).toBe(2);

    // A focused checkbox keeps Space but not the game's letters (couch's focused-checkbox bug).
    h.doc.activeElement = element("INPUT", { type: "checkbox" });
    h.down(space);
    h.down(W);
    h.up(W);
    h.doc.activeElement = element("A", { attrs: { href: "#" } });
    h.down({ code: "Enter", key: "Enter" });
    expect(h.capture.stats().dropped.activation).toBe(2);
    expect(h.take()).toEqual([pressW, releaseW]);

    // The stage carries a tabindex but is the game, so Space goes through.
    h.doc.activeElement = stage;
    h.down(space);
    expect(h.take()).toMatchObject([{ keycode: Key.SPACE, pressed: true }]);

    const off = harness({ textEntry: false, activation: false });
    off.doc.activeElement = element("TEXTAREA");
    off.down(W);
    expect(off.take()).toEqual([pressW]);

    const custom = harness({ textEntry: (el) => el.tagName === "X-EDITOR" });
    custom.doc.activeElement = element("X-EDITOR");
    custom.down(W);
    expect(custom.take()).toEqual([]);
  });

  it("K12: an unmapped code is not forwarded; filter and reservedCodes gate presses only", () => {
    const h = harness({
      filter: (code) => code !== "KeyE",
      reservedCodes: ["F5"],
    });
    h.down({ code: "IntlRo", key: "/" });
    h.down({ code: "KeyE", key: "e" });
    const f5 = h.down({ code: "F5", key: "F5" });
    expect(h.take()).toEqual([]);
    expect(f5).not.toHaveBeenCalled();
    expect(h.capture.stats().dropped).toMatchObject({
      unmapped: 1,
      filtered: 1,
      reserved: 1,
    });
  });

  it("K13: the 17th held key is not forwarded and is counted", () => {
    const h = harness();
    const letters = "ABCDEFGHIJKLMNOPQ".split("");
    for (const l of letters) h.down({ code: `Key${l}`, key: l.toLowerCase() });
    expect(h.take()).toHaveLength(16);
    expect(h.capture.stats().dropped["max-held"]).toBe(1);
    h.up({ code: "KeyQ", key: "q" });
    expect(h.take()).toEqual([]);
    h.up({ code: "KeyA", key: "a" });
    h.down({ code: "KeyQ", key: "q" });
    expect(h.take().map((r) => [r.code, r.pressed])).toEqual([
      ["KeyA", false],
      ["KeyQ", true],
    ]);
    expect(harness({ maxHeld: 1 }).capture).toBeDefined();
  });

  it("K14: preventDefault on forwarded keydown, repeat and keyup, per policy", () => {
    const h = harness();
    const space = { code: "Space", key: " " };
    expect(h.down(space)).toHaveBeenCalledOnce();
    expect(h.down({ ...space, repeat: true })).toHaveBeenCalledOnce();
    expect(h.up(space)).toHaveBeenCalledOnce();
    expect(h.down(W)).not.toHaveBeenCalled();
    // A key refused by a gate keeps its browser behaviour.
    h.doc.activeElement = element("INPUT");
    expect(h.down({ code: "ArrowUp", key: "ArrowUp" })).not.toHaveBeenCalled();

    const all = harness({ preventDefault: "forwarded" });
    expect(all.down(W)).toHaveBeenCalledOnce();
    expect(all.up(W)).toHaveBeenCalledOnce();
    expect(
      all.down({ code: "KeyR", key: "r", ctrlKey: true }),
    ).not.toHaveBeenCalled();

    const none = harness({ preventDefault: "none" });
    expect(none.down(space)).not.toHaveBeenCalled();

    const fn = harness({ preventDefault: (r) => r.keycode === Key.W });
    expect(fn.down(W)).toHaveBeenCalledOnce();
    expect(fn.down(space)).not.toHaveBeenCalled();
  });

  it("uses the layout map for the unshifted label once it resolves", async () => {
    let resolveMap: (map: KeyboardLayoutLike) => void = () => {};
    const keyboard = new FakeTarget() as FakeTarget & {
      getLayoutMap(): Promise<KeyboardLayoutLike>;
    };
    let requests = 0;
    keyboard.getLayoutMap = () => {
      requests++;
      return new Promise((resolve) => {
        resolveMap = resolve;
      });
    };
    const h = harness({ keyboard });
    const shift1 = { code: "Digit1", key: "1", shiftKey: true }; // AZERTY Shift+&
    h.down(shift1);
    h.up(shift1);
    resolveMap(new Map([["Digit1", "&"]]));
    await Promise.resolve();
    h.down(shift1);
    const [before, , after] = h.take();
    expect(before.keycode).toBe(Key.KEY_1);
    expect(after.keycode).toBe(Key.AMPERSAND);
    keyboard.emit("layoutchange");
    h.win.emit("focus");
    expect(requests).toBe(3);
    h.capture.dispose();
    expect(keyboard.count()).toBe(0);
  });

  it("keeps the fallback rules when the layout map is refused", async () => {
    const h = harness({
      keyboard: { getLayoutMap: () => Promise.reject(new Error("denied")) },
    });
    await Promise.resolve();
    h.down({ code: "Digit1", key: "1", shiftKey: true });
    expect(h.take()).toMatchObject([{ keycode: Key.KEY_1 }]);
  });

  it("heldState lists the latched presses as one keyboard scope that encodes as a sync", () => {
    const h = harness({ echo: true });
    expect(h.capture.heldState()).toEqual([{ scope: "keyboard", held: [] }]);
    h.down({ code: "ShiftLeft", key: "Shift", shiftKey: true });
    h.down({ ...W, key: "W", shiftKey: true });
    h.down({ ...W, key: "W", shiftKey: true, repeat: true });
    const [state] = h.capture.heldState();
    expect(state.held.map((r) => (r as KeyRecord).code)).toEqual([
      "ShiftLeft",
      "KeyW",
    ]);
    // Fresh objects: mutating a snapshot or a pushed record changes no later output.
    (state.held[1] as KeyRecord).keycode = 1;
    (h.records[1] as KeyRecord).keycode = 2;
    const [text] = encodeInputMessage({
      type: "sync",
      epoch: 1,
      seq: 2,
      ...h.capture.heldState()[0],
    });
    const parsed = parseInputMessage(text);
    expect(parsed.ok).toBe(true);
    expect(
      parsed.ok && parsed.message.type === "sync" && parsed.message.held,
    ).toMatchObject([{ code: "ShiftLeft" }, { code: "KeyW", keycode: Key.W }]);
  });

  it("is inert without a window", () => {
    const capture = createKeyboardCapture({
      sink: { push: () => {} },
      events: null,
      visibility: null,
    });
    expect(capture.heldState()).toEqual([{ scope: "keyboard", held: [] }]);
    capture.refresh();
    capture.dispose();
  });

  it("listens on the real window and document by default (jsdom)", () => {
    const records: InputRecord[] = [];
    const capture = createKeyboardCapture({
      sink: { push: (r) => records.push(r) },
    });
    const input = document.createElement("input");
    input.type = "checkbox";
    document.body.append(input);
    input.focus();
    const event = new KeyboardEvent("keydown", {
      code: "KeyW",
      key: "w",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Space",
        key: " ",
        cancelable: true,
      }),
    );
    input.type = "text";
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyE", key: "e" }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keyup", { code: "KeyW", key: "w" }),
    );
    expect(records).toEqual([pressW, releaseW]);
    input.blur();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyW", key: "w" }),
    );
    window.dispatchEvent(new Event("blur"));
    expect(records.slice(2)).toEqual([pressW, releaseW]);
    capture.dispose();
    input.remove();
  });
});

describe("keyboard capture on an input session", () => {
  it("heals a press made before open() with the post-hello sync, then streams edges", async () => {
    const texts: string[] = [];
    const session = createInputSession({
      send: (text) => texts.push(text),
      heartbeatMs: 0,
      source: "kbtest",
    });
    const win = new FakeTarget();
    const capture = createKeyboardCapture({
      sink: session,
      events: win,
      visibility: null,
      keyboard: null,
    });
    session.attach(capture);
    const fire = (type: string, init: { code: string; key: string }) =>
      win.emit(type, { ...init, type });

    fire("keydown", W); // carrier not open yet: dropped by the session, kept in the latch
    await Promise.resolve();
    expect(texts).toEqual([]);
    session.open();
    fire("keyup", W);
    await Promise.resolve();
    const messages = texts.map((text) => {
      const parsed = parseInputMessage(text);
      if (!parsed.ok) throw new Error(parsed.detail);
      return parsed.message;
    });
    expect(messages.map((m) => m.type)).toEqual(["hello", "sync", "events"]);
    expect(messages[1]).toMatchObject({ scope: "keyboard", held: [pressW] });
    expect(messages[2]).toMatchObject({ events: [releaseW] });
    capture.dispose();
    session.dispose();
  });
});
