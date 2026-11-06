// @godot-scene-web/input/keyboard: the browser keyboard capture and the DOM-free key map it uses.
// A subpath of its own so the root entry never pulls capture code (docs/architecture.md).
// Spec: docs/input.md "Keyboard".

export {
  createKeyboardCapture,
  type FocusedElementLike,
  isActivationTarget,
  isTextEntryElement,
  type KeyboardCapture,
  type KeyboardCaptureOptions,
  type KeyboardCaptureStats,
  type KeyboardDropReason,
  type KeyboardEventLike,
  type KeyboardHeldState,
  type KeyboardLayoutSource,
  type KeyboardPreventDefault,
  type KeyboardSink,
  type KeyEventTargetLike,
  type KeyVisibilitySource,
} from "./keyboard-capture";
export {
  type DomKeyEvent,
  type KeyboardLayoutLike,
  type KeyRecordOptions,
  keyLocationFromCode,
  keyRecordFromDom,
  physicalKeycodeFromCode,
  releaseKeyRecord,
} from "./keymap";
