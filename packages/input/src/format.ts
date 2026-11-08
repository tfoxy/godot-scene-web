// gsw-input/1 message and record types. Normative spec: docs/input.md.
//
// A record is one Godot InputEvent described in Godot's own vocabulary: the `event` name is the
// class minus `InputEvent` in snake_case, field names are Godot property names and enum fields
// carry Godot's ints (see godot-enums.ts). Every field except the ones marked required is
// optional and means Godot's default when absent; the encoder omits defaults.
//
// Types here are named `*Record` / `Input*Message`, never `InputEvent`: that name is Godot's
// class, and a consumer mixing both in one file should never have to alias.

/** The format string a `hello` carries. */
export const INPUT_FORMAT = "gsw-input/1";
/** Largest message, in UTF-8 bytes of the JSON text. */
export const INPUT_MAX_MESSAGE_BYTES = 4096;
/** Largest `events` / `held` array. */
export const INPUT_MAX_EVENTS = 64;
/** Largest pointer target handle; handles are 1..this, 0 means "over no node". */
export const INPUT_MAX_TARGET_HANDLE = 1023;

/** A Godot Vector2 as `[x, y]`. */
export type InputVec2 = readonly [number, number];

/** `InputEventWithModifiers` flags. */
export interface ModifierFields {
  shift_pressed?: boolean;
  ctrl_pressed?: boolean;
  alt_pressed?: boolean;
  meta_pressed?: boolean;
}

/**
 * The opt-in pointer target fields (docs/input.md "Pointer targets"). `target` is a handle
 * declared by an earlier `target` record of the same epoch, or 0 for "over no node". `local` is
 * required with a nonzero `target` and forbidden otherwise; `frame` needs `target`.
 */
export interface PointerTargetFields {
  target?: number;
  local?: InputVec2;
  frame?: number;
}

/** `InputEventKey`. At least one of the three keycodes is nonzero. */
export interface KeyRecord extends ModifierFields {
  event: "key";
  physical_keycode?: number;
  keycode?: number;
  key_label?: number;
  unicode?: number;
  location?: number;
  /** Required. */
  pressed: boolean;
  /** Only with `pressed: true`. */
  echo?: boolean;
  /** DOM `KeyboardEvent.code`, informational only; hosts never interpret it. */
  code?: string;
}

/** `InputEventJoypadButton`. `device` is the sender's pad slot (0..15), not a Godot device id. */
export interface JoypadButtonRecord {
  event: "joypad_button";
  device?: number;
  button_index?: number;
  /** Required. */
  pressed: boolean;
}

/** `InputEventJoypadMotion`. */
export interface JoypadMotionRecord {
  event: "joypad_motion";
  device?: number;
  axis?: number;
  axis_value?: number;
}

/** `InputEventMouseButton`. `position` is host root-window pixels; `global_position` = `position`. */
export interface MouseButtonRecord extends ModifierFields, PointerTargetFields {
  event: "mouse_button";
  /** Required, 1..9 (MouseButton). */
  button_index: number;
  /** Required. */
  pressed: boolean;
  /** Required. */
  position: InputVec2;
  button_mask?: number;
  double_click?: boolean;
  canceled?: boolean;
  /** Wheel amount (default 1); see docs/input.md "Wheel". */
  factor?: number;
}

/** `InputEventMouseMotion` (mouse and pen). */
export interface MouseMotionRecord extends ModifierFields, PointerTargetFields {
  event: "mouse_motion";
  /** Required. */
  position: InputVec2;
  relative?: InputVec2;
  button_mask?: number;
  pressure?: number;
  tilt?: InputVec2;
  pen_inverted?: boolean;
}

/** `InputEventScreenTouch`. */
export interface ScreenTouchRecord extends PointerTargetFields {
  event: "screen_touch";
  index?: number;
  /** Required. */
  pressed: boolean;
  /** Required. */
  position: InputVec2;
  canceled?: boolean;
  double_tap?: boolean;
}

/** `InputEventScreenDrag`. */
export interface ScreenDragRecord extends PointerTargetFields {
  event: "screen_drag";
  index?: number;
  /** Required. */
  position: InputVec2;
  relative?: InputVec2;
  pressure?: number;
  tilt?: InputVec2;
  pen_inverted?: boolean;
}

/** `InputEventMagnifyGesture`. Gated by the host's accepted kinds. */
export interface MagnifyGestureRecord extends ModifierFields {
  event: "magnify_gesture";
  /** Required. */
  position: InputVec2;
  factor?: number;
}

/** `InputEventPanGesture`. Gated by the host's accepted kinds. */
export interface PanGestureRecord extends ModifierFields {
  event: "pan_gesture";
  /** Required. */
  position: InputVec2;
  delta?: InputVec2;
}

/** `InputEventAction`. Hosts refuse it unless the action is in their allow-list. */
export interface ActionRecord {
  event: "action";
  /** Required. */
  action: string;
  /** Required. */
  pressed: boolean;
  strength?: number;
}

/**
 * A pointer target declaration: binds `handle` to a node identity for the rest of the epoch (a
 * later declaration of the same handle replaces it). Not a Godot event; never injected.
 */
export interface TargetDeclarationRecord {
  event: "target";
  /** Required, 1..INPUT_MAX_TARGET_HANDLE. */
  handle: number;
  /** A Godot NodePath; scene-relative when `scene` is present. */
  path?: string;
  /** `res://` path of the scene `path` is relative to. Needs `path`. */
  scene?: string;
  /** The node's Godot class, informational. */
  class?: string;
  /** The Godot ObjectID as nonzero unsigned 64-bit decimal text. */
  instance_id?: string;
  /** An opaque renderer item id. */
  item?: number;
}

/** Every record kind of gsw-input/1. */
export type InputRecord =
  | KeyRecord
  | JoypadButtonRecord
  | JoypadMotionRecord
  | MouseButtonRecord
  | MouseMotionRecord
  | ScreenTouchRecord
  | ScreenDragRecord
  | MagnifyGestureRecord
  | PanGestureRecord
  | ActionRecord
  | TargetDeclarationRecord;

export type InputRecordKind = InputRecord["event"];

/** The record kinds, in spec order. */
export const INPUT_RECORD_KINDS: readonly InputRecordKind[] = [
  "key",
  "joypad_button",
  "joypad_motion",
  "mouse_button",
  "mouse_motion",
  "screen_touch",
  "screen_drag",
  "magnify_gesture",
  "pan_gesture",
  "action",
  "target",
];

/** Record kinds that may carry `target` / `local` / `frame`. */
export const POINTER_TARGET_KINDS: readonly InputRecordKind[] = [
  "mouse_button",
  "mouse_motion",
  "screen_touch",
  "screen_drag",
];

/** Opens (or reopens with a new epoch) a source's session. */
export interface InputHelloMessage {
  type: "hello";
  /** Required, exactly INPUT_FORMAT. */
  format: typeof INPUT_FORMAT;
  /** Required, 1..64 of `[A-Za-z0-9._:-]`, stable across reconnects of one sender. */
  source: string;
  /** Required, u32, new on every open. */
  epoch: number;
  /** The hello's own sequence number (default 0); later messages count up from it. */
  seq?: number;
  /** Record kinds the sender may send (advisory). */
  kinds?: readonly string[];
}

export interface InputEventsMessage {
  type: "events";
  epoch: number;
  seq: number;
  /** 1..INPUT_MAX_EVENTS records, applied in order. */
  events: readonly InputRecord[];
}

export type InputSyncScope = "keyboard" | "joypad" | "pointer";

/** One scope's complete held state; the host diffs and releases or presses to match it. */
export interface InputSyncMessage {
  type: "sync";
  epoch: number;
  seq: number;
  scope: InputSyncScope;
  /** Required for `joypad` (0..15), forbidden otherwise. */
  device?: number;
  /** 0..INPUT_MAX_EVENTS records; which kinds a scope allows is in docs/input.md "sync". */
  held: readonly InputRecord[];
}

/** Release everything this source holds; the session continues. */
export interface InputResetMessage {
  type: "reset";
  epoch: number;
  seq: number;
  reason?: string;
}

/** Release everything and end the session. */
export interface InputByeMessage {
  type: "bye";
  epoch: number;
  seq: number;
  reason?: string;
}

/** Liveness only. */
export interface InputHeartbeatMessage {
  type: "heartbeat";
  epoch: number;
  seq: number;
}

export type InputMessage =
  | InputHelloMessage
  | InputEventsMessage
  | InputSyncMessage
  | InputResetMessage
  | InputByeMessage
  | InputHeartbeatMessage;

export type InputMessageType = InputMessage["type"];

/**
 * Codec outcomes (docs/input.md "Validation"). `unknown-type` is an ignore, not a violation:
 * a receiver counts it and carries on.
 */
export type InputErrorCode =
  | "too-large"
  | "malformed"
  | "unknown-type"
  | "unsupported-format"
  | "bad-field"
  | "too-many-events";

export interface InputParseOk {
  ok: true;
  /** A fresh object holding only known fields; unknown records are already removed. */
  message: InputMessage;
  /** Records of unknown kinds removed from `events` / `held`. */
  skipped: number;
}

export interface InputParseError {
  ok: false;
  code: InputErrorCode;
  /** The offending member for `bad-field` / `too-many-events`, e.g. `events[2].position`. */
  path?: string;
  detail: string;
}

export type InputParseResult = InputParseOk | InputParseError;
