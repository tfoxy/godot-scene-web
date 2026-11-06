import { describe, expect, it } from "vitest";
import { parseBarrelExports } from "../../../scripts/parse-barrel-exports";
import * as gamepad from "../src/gamepad";
import gamepadSource from "../src/gamepad.ts?raw";
import * as input from "../src/index";
import indexSource from "../src/index.ts?raw";
import * as keyboard from "../src/keyboard";
import keyboardSource from "../src/keyboard.ts?raw";

// Consumers alias this package's source and may mirror these names in ambient declarations, so
// both runtime and erased type exports are pinned.
const VALUE_EXPORTS = `
encodeInputMessage parseInputMessage validateInputMessage InputEncodeError
INPUT_FORMAT INPUT_MAX_EVENTS INPUT_MAX_MESSAGE_BYTES INPUT_MAX_TARGET_HANDLE
INPUT_RECORD_KINDS POINTER_TARGET_KINDS
Key KeyLocation JoyAxis JoyButton MouseButton MouseButtonMask mouseButtonToMask
createInputSession
`
  .trim()
  .split(/\s+/);

const TYPE_EXPORTS = `
InputEncodeErrorCode InputEncodeOptions
ActionRecord JoypadButtonRecord JoypadMotionRecord KeyRecord MagnifyGestureRecord MouseButtonRecord
MouseMotionRecord PanGestureRecord ScreenDragRecord ScreenTouchRecord TargetDeclarationRecord
InputRecord InputRecordKind ModifierFields PointerTargetFields InputVec2
InputByeMessage InputEventsMessage InputHeartbeatMessage InputHelloMessage InputMessage
InputMessageType InputResetMessage InputSyncMessage InputSyncScope
InputErrorCode InputParseError InputParseOk InputParseResult
InputHeldState InputSession InputSessionOptions InputSessionState InputSessionStats InputSink
InputSyncSource
`
  .trim()
  .split(/\s+/);

describe("@godot-scene-web/input export surface", () => {
  it("exports exactly the checked-in value and type lists", () => {
    expect(Object.keys(input).sort()).toEqual([...VALUE_EXPORTS].sort());
    const parsed = parseBarrelExports(indexSource);
    expect(parsed.values.sort()).toEqual([...VALUE_EXPORTS].sort());
    expect(parsed.types.sort()).toEqual([...TYPE_EXPORTS].sort());
  });

  it("names every record kind once", () => {
    expect(new Set(input.INPUT_RECORD_KINDS).size).toBe(
      input.INPUT_RECORD_KINDS.length,
    );
    for (const kind of input.POINTER_TARGET_KINDS)
      expect(input.INPUT_RECORD_KINDS).toContain(kind);
  });
});

const GAMEPAD_VALUE_EXPORTS = `
createGamepadCapture latched LATCH_PRESS LATCH_RELEASE STANDARD_GAMEPAD_MAP
`
  .trim()
  .split(/\s+/);

const GAMEPAD_TYPE_EXPORTS = `
GamepadButtonSnapshot GamepadSnapshot StandardGamepadView GamepadNonStandardPolicy GamepadPadsMode
GamepadRecord GamepadSink GamepadHeldState GamepadEventTarget GamepadVisibilitySource
GamepadCaptureOptions GamepadCapture
`
  .trim()
  .split(/\s+/);

describe("@godot-scene-web/input/gamepad export surface", () => {
  it("exports exactly the checked-in value list", () => {
    expect(Object.keys(gamepad).sort()).toEqual(
      [...GAMEPAD_VALUE_EXPORTS].sort(),
    );
    // Declared in place rather than re-exported, so read the declarations themselves.
    const declared = (kinds: string) =>
      [
        ...gamepadSource.matchAll(
          new RegExp(`^export (?:${kinds}) (\\w+)`, "gm"),
        ),
      ]
        .map((match) => match[1])
        .sort();
    expect(declared("const|function")).toEqual(
      [...GAMEPAD_VALUE_EXPORTS].sort(),
    );
    expect(declared("interface|type")).toEqual(
      [...GAMEPAD_TYPE_EXPORTS].sort(),
    );
  });
});

const KEYBOARD_VALUE_EXPORTS = `
createKeyboardCapture isActivationTarget isTextEntryElement
keyLocationFromCode keyRecordFromDom physicalKeycodeFromCode releaseKeyRecord
`
  .trim()
  .split(/\s+/);

const KEYBOARD_TYPE_EXPORTS = `
FocusedElementLike KeyboardCapture KeyboardCaptureOptions KeyboardCaptureStats KeyboardDropReason
KeyboardEventLike KeyboardHeldState KeyboardLayoutSource KeyboardPreventDefault KeyboardSink
KeyEventTargetLike KeyVisibilitySource
DomKeyEvent KeyboardLayoutLike KeyRecordOptions
`
  .trim()
  .split(/\s+/);

describe("@godot-scene-web/input/keyboard export surface", () => {
  it("exports exactly the checked-in value and type lists", () => {
    expect(Object.keys(keyboard).sort()).toEqual(
      [...KEYBOARD_VALUE_EXPORTS].sort(),
    );
    const parsed = parseBarrelExports(keyboardSource);
    expect(parsed.values.sort()).toEqual([...KEYBOARD_VALUE_EXPORTS].sort());
    expect(parsed.types.sort()).toEqual([...KEYBOARD_TYPE_EXPORTS].sort());
  });
});
