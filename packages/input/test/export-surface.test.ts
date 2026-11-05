import { describe, expect, it } from "vitest";
import { parseBarrelExports } from "../../../scripts/parse-barrel-exports";
import * as input from "../src/index";
import indexSource from "../src/index.ts?raw";

// Consumers alias this package's source and may mirror these names in ambient declarations, so
// both runtime and erased type exports are pinned.
const VALUE_EXPORTS = `
encodeInputMessage parseInputMessage validateInputMessage InputEncodeError
INPUT_FORMAT INPUT_MAX_EVENTS INPUT_MAX_MESSAGE_BYTES INPUT_MAX_TARGET_HANDLE
INPUT_RECORD_KINDS POINTER_TARGET_KINDS
Key KeyLocation JoyAxis JoyButton MouseButton MouseButtonMask mouseButtonToMask
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
