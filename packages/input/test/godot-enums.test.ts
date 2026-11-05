// Spot-checks against Godot 4.5.1 source values (core/os/keyboard.h, core/input/input_enums.h).
import { describe, expect, it } from "vitest";
import {
  JoyAxis,
  JoyButton,
  Key,
  KeyLocation,
  MouseButton,
  MouseButtonMask,
  mouseButtonToMask,
} from "../src/index";

describe("Godot enum values", () => {
  it("matches keyboard.h", () => {
    expect(Key.SPECIAL).toBe(1 << 22);
    expect(Key.ESCAPE).toBe(Key.SPECIAL | 0x01);
    expect(Key.DELETE).toBe(Key.SPECIAL | 0x08);
    expect(Key.SHIFT).toBe(Key.SPECIAL | 0x15);
    expect(Key.F35).toBe(Key.SPECIAL | 0x3e);
    expect(Key.KP_9).toBe(Key.SPECIAL | 0x8f);
    expect(Key.JIS_KANA).toBe(Key.SPECIAL | 0x73);
    expect(Key.UNKNOWN).toBe(Key.SPECIAL | 0x7fffff);
    expect(Key.KEY_0).toBe(0x30);
    expect(Key.A).toBe(0x41);
    expect(Key.SECTION).toBe(0xa7);
    expect(KeyLocation).toEqual({ UNSPECIFIED: 0, LEFT: 1, RIGHT: 2 });
  });

  it("matches input_enums.h", () => {
    expect(JoyAxis.TRIGGER_RIGHT).toBe(5);
    expect(JoyAxis.MAX).toBe(10);
    expect(JoyButton.BACK).toBe(4);
    expect(JoyButton.LEFT_SHOULDER).toBe(9);
    expect(JoyButton.DPAD_RIGHT).toBe(14);
    expect(JoyButton.MAX).toBe(128);
    expect(MouseButton.MIDDLE).toBe(3);
    expect(MouseButton.XBUTTON2).toBe(9);
    expect(MouseButtonMask.XBUTTON1).toBe(
      mouseButtonToMask(MouseButton.XBUTTON1),
    );
    expect(MouseButtonMask.MIDDLE).toBe(mouseButtonToMask(MouseButton.MIDDLE));
    expect(mouseButtonToMask(MouseButton.NONE)).toBe(0);
  });
});
