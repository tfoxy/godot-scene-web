// @godot-scene-web/input root entry: DOM-free gsw-input/1 types, codec, sender session and Godot
// enum values.
// Browser captures arrive as their own subpaths (`./keyboard`, `./gamepad`, `./pointer`) so this
// entry never pulls DOM code. Spec: docs/input.md.

export {
  encodeInputMessage,
  InputEncodeError,
  type InputEncodeErrorCode,
  type InputEncodeOptions,
  parseInputMessage,
  validateInputMessage,
} from "./codec";
export {
  type ActionRecord,
  INPUT_FORMAT,
  INPUT_MAX_EVENTS,
  INPUT_MAX_MESSAGE_BYTES,
  INPUT_MAX_TARGET_HANDLE,
  INPUT_RECORD_KINDS,
  type InputByeMessage,
  type InputErrorCode,
  type InputEventsMessage,
  type InputHeartbeatMessage,
  type InputHelloMessage,
  type InputMessage,
  type InputMessageType,
  type InputParseError,
  type InputParseOk,
  type InputParseResult,
  type InputRecord,
  type InputRecordKind,
  type InputResetMessage,
  type InputSyncMessage,
  type InputSyncScope,
  type InputVec2,
  type JoypadButtonRecord,
  type JoypadMotionRecord,
  type KeyRecord,
  type MagnifyGestureRecord,
  type ModifierFields,
  type MouseButtonRecord,
  type MouseMotionRecord,
  type PanGestureRecord,
  POINTER_TARGET_KINDS,
  type PointerTargetFields,
  type ScreenDragRecord,
  type ScreenTouchRecord,
  type TargetDeclarationRecord,
} from "./format";
export {
  JoyAxis,
  JoyButton,
  Key,
  KeyLocation,
  MouseButton,
  MouseButtonMask,
  mouseButtonToMask,
} from "./godot-enums";
export {
  createInputSession,
  type InputHeldState,
  type InputSession,
  type InputSessionOptions,
  type InputSessionState,
  type InputSessionStats,
  type InputSink,
  type InputSyncSource,
} from "./session";
