// @vitest-environment node
//
// Capture behaviour the frame vectors cannot express: lifecycle and polling, the held-state sync,
// the `nonStandard` function, `latched`, inertness without the Gamepad API, and wire validity.
// Node has no Gamepad API, rAF, `window` or `document`, so default construction must be inert.
import { describe, expect, it, vi } from "vitest";
import {
  createGamepadCapture,
  type GamepadSnapshot,
  LATCH_PRESS,
  LATCH_RELEASE,
  latched,
  STANDARD_GAMEPAD_MAP,
} from "../src/gamepad";
import { JoyAxis, JoyButton } from "../src/godot-enums";
import { encodeInputMessage, validateInputMessage } from "../src/index";
import { fakeGamepadPage } from "./gamepad-fake";

const standard = (buttons: unknown[] = [], axes: number[] = []) =>
  ({ mapping: "standard", buttons, axes }) as GamepadSnapshot;

describe("latched", () => {
  it("presses at 0.55, holds through the band, releases at or below 0.35", () => {
    expect([LATCH_PRESS, LATCH_RELEASE]).toEqual([0.55, 0.35]);
    expect(latched(0.54, false)).toBe(false);
    expect(latched(0.55, false)).toBe(true);
    expect(latched(0.4, true)).toBe(true);
    expect(latched(0.4, false)).toBe(false);
    expect(latched(0.35, true)).toBe(false);
    expect(latched(0.8, false, 0.9, 0.1)).toBe(false);
    expect(latched(0.2, true, 0.9, 0.1)).toBe(true);
  });
});

describe("STANDARD_GAMEPAD_MAP", () => {
  it("is the docs/input.md table: 17 W3C buttons, triggers as axes 4/5", () => {
    expect(STANDARD_GAMEPAD_MAP).toHaveLength(17);
    expect(STANDARD_GAMEPAD_MAP[6]).toEqual({ axis: JoyAxis.TRIGGER_LEFT });
    expect(STANDARD_GAMEPAD_MAP[7]).toEqual({ axis: JoyAxis.TRIGGER_RIGHT });
    expect(STANDARD_GAMEPAD_MAP[8]).toEqual({ button: JoyButton.BACK });
    expect(STANDARD_GAMEPAD_MAP[16]).toEqual({ button: JoyButton.GUIDE });
  });
});

describe("createGamepadCapture lifecycle", () => {
  it("is inert without the Gamepad API (Node, insecure origins)", () => {
    const push = vi.fn();
    const capture = createGamepadCapture({ sink: { push } });
    expect(capture.polling()).toBe(false);
    capture.refresh();
    expect(capture.heldState()).toEqual([]);
    capture.dispose();
    expect(push).not.toHaveBeenCalled();
  });

  it("registers no listeners when inert", () => {
    const page = fakeGamepadPage({ getGamepads: null });
    expect(page.window.count() + page.document.count()).toBe(0);
  });

  it("polls only while a usable pad exists", () => {
    const page = fakeGamepadPage();
    expect(page.pending()).toBe(false);
    page.step({ pads: [standard([1])] });
    expect(page.pending()).toBe(true);
    page.step({ pads: [{ ...standard([1]), mapping: "xr-standard" }] });
    expect(page.pending()).toBe(false);
    page.step({ pads: [] });
    expect(page.pending()).toBe(false);
  });

  it("starts at once for a pad the page already knows", () => {
    const page = fakeGamepadPage({}, [standard([1])]);
    expect(page.pending()).toBe(true);
    expect(page.step({ pads: [standard([1])] })).toEqual([
      { event: "joypad_button", device: 0, button_index: 0, pressed: true },
    ]);
  });

  it("does not poll while hidden, and starts on visible", () => {
    const page = fakeGamepadPage();
    page.document.visibilityState = "hidden";
    page.step({ pads: [standard([1])], visibility: "hidden" });
    expect(page.pending()).toBe(false);
    page.step({ pads: [standard([1])], visibility: "visible" });
    expect(page.pending()).toBe(true);
  });

  it("enabled() off releases and parks; refresh() restarts", () => {
    let on = true;
    const page = fakeGamepadPage({ enabled: () => on });
    expect(page.step({ pads: [standard([1])] })).toHaveLength(1);
    on = false;
    page.capture.refresh();
    expect(page.records.at(-1)).toMatchObject({ pressed: false });
    expect(page.pending()).toBe(false);
    on = true;
    page.capture.refresh();
    expect(page.pending()).toBe(true);
    expect(page.step({ pads: [standard([1])] })).toHaveLength(1);
  });

  it("dispose removes every listener and is idempotent", () => {
    const page = fakeGamepadPage();
    expect(page.window.count() + page.document.count()).toBe(3);
    page.capture.dispose();
    page.capture.dispose();
    expect(page.window.count() + page.document.count()).toBe(0);
    expect(page.pending()).toBe(false);
  });
});

describe("createGamepadCapture options", () => {
  it("nonStandard as a function remaps a pad, or skips it with null", () => {
    const page = fakeGamepadPage({
      nonStandard: (pad) =>
        pad.id === "evdev" ? { buttons: [0, pad.buttons?.[0] ?? 0] } : null,
    });
    const records = page.step({
      pads: [
        { index: 0, id: "evdev", mapping: "", buttons: [1] },
        { index: 1, id: "other", mapping: "", buttons: [1] },
      ],
    });
    expect(records).toEqual([
      { event: "joypad_button", device: 0, button_index: 1, pressed: true },
    ]);
  });

  it("clamps maxSlots to 1..16", () => {
    const page = fakeGamepadPage({ maxSlots: 99 });
    const records = page.step({ pads: [{ ...standard([1]), index: 15 }] });
    expect(records).toEqual([
      { event: "joypad_button", device: 15, button_index: 0, pressed: true },
    ]);
    const one = fakeGamepadPage({ maxSlots: 0 });
    expect(one.step({ pads: [{ ...standard([1]), index: 1 }] })).toEqual([]);
  });

  it("treats connected: false as absent", () => {
    const page = fakeGamepadPage();
    page.step({ pads: [standard([1])] });
    expect(
      page.step({ pads: [{ ...standard([1]), connected: false }] }),
    ).toEqual([
      { event: "joypad_button", device: 0, button_index: 0, pressed: false },
    ]);
  });
});

describe("heldState()", () => {
  it("reports each present slot's pressed buttons then nonzero axes", () => {
    const page = fakeGamepadPage();
    page.step({
      pads: [
        {
          ...standard([0, 1, 0, 0, 0, 0, 0, { value: 0.5 }], [0, -1]),
          index: 0,
        },
        { ...standard(), index: 1 },
      ],
    });
    expect(page.capture.heldState()).toEqual([
      {
        scope: "joypad",
        device: 0,
        held: [
          { event: "joypad_button", device: 0, button_index: 1, pressed: true },
          { event: "joypad_motion", device: 0, axis: 1, axis_value: -1 },
          { event: "joypad_motion", device: 0, axis: 5, axis_value: 0.5 },
        ],
      },
      { scope: "joypad", device: 1, held: [] },
    ]);
    page.step({ pads: [] });
    expect(page.capture.heldState()).toEqual([]);
  });

  it("leaves neutralized controls out", () => {
    const page = fakeGamepadPage({ neutralizeHeldOnStart: true });
    page.step({ pads: [standard([1])] });
    expect(page.capture.heldState()).toEqual([
      { scope: "joypad", device: 0, held: [] },
    ]);
  });
});

describe("wire validity", () => {
  it("every pushed record and held state passes the gsw-input/1 validator", () => {
    const page = fakeGamepadPage({ maxSlots: 16 });
    const buttons = Array.from({ length: 20 }, () => ({ value: 0.73 }));
    page.step({
      pads: [{ ...standard(buttons, [0.123456, -0.98765, 1, -1]), index: 15 }],
    });
    const [text] = encodeInputMessage({
      type: "events",
      epoch: 1,
      seq: 1,
      events: page.records,
    });
    expect(validateInputMessage(JSON.parse(text)).ok).toBe(true);
    for (const state of page.capture.heldState())
      expect(
        validateInputMessage({ type: "sync", epoch: 1, seq: 2, ...state }).ok,
      ).toBe(true);
    for (const record of page.records)
      if (record.event === "joypad_motion")
        expect(
          String(record.axis_value).split(".")[1]?.length ?? 0,
        ).toBeLessThanOrEqual(4);
  });
});
