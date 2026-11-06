// DOM `KeyboardEvent` -> gsw-input/1 `key` record, DOM-free (docs/input.md "Keyboard").
//
// The `code` -> `Key` table and the location table are ported from the Godot Engine 4.5.1 source file
// `platform/web/dom_keys.inc` (`dom_code2godot_scancode`, `dom_code2godot_key_location`), whose
// header is kept below. The derivation of `keycode`, `key_label` and `unicode` follows Godot web's
// `DisplayServerWeb::_key_callback` (`display_server_web.cpp:181-217`) and `fix_keycode` /
// `fix_key_label` / `fix_unicode` (`core/os/keyboard.cpp:476-495`), with two deliberate fixes:
// `keycode` is the UNSHIFTED Latin label (Godot web derives it from the shifted `key`, so Shift+1
// presses `!` and, Shift released first, releases `1`), and `Dead`/`Process` keys keep their
// physical key instead of the first byte of their name (`D`, `P`). A release replays its press
// record (`releaseKeyRecord`), so Godot's pressed-key sets and `action_match` clear what they set.
//
// Original header of dom_keys.inc:
//
/**************************************************************************/
/*  dom_keys.inc                                                          */
/**************************************************************************/
/*                         This file is part of:                          */
/*                             GODOT ENGINE                               */
/*                        https://godotengine.org                         */
/**************************************************************************/
/* Copyright (c) 2014-present Godot Engine contributors (see AUTHORS.md). */
/* Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur.                  */
/*                                                                        */
/* Permission is hereby granted, free of charge, to any person obtaining  */
/* a copy of this software and associated documentation files (the        */
/* "Software"), to deal in the Software without restriction, including    */
/* without limitation the rights to use, copy, modify, merge, publish,    */
/* distribute, sublicense, and/or sell copies of the Software, and to     */
/* permit persons to whom the Software is furnished to do so, subject to  */
/* the following conditions:                                              */
/*                                                                        */
/* The above copyright notice and this permission notice shall be         */
/* included in all copies or substantial portions of the Software.        */
/*                                                                        */
/* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,        */
/* EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF     */
/* MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. */
/* IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY   */
/* CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,   */
/* TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE      */
/* SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.                 */
/**************************************************************************/

import type { KeyRecord } from "./format";
import { Key, KeyLocation } from "./godot-enums";

// See https://w3c.github.io/uievents-code/#code-value-tables. One table, as in Godot: it maps a DOM
// `code` (physical) and a named DOM `key` (logical) alike. Commented-out Godot entries (UNKNOWN)
// are absent, so those codes are unmapped.
const DOM2GODOT: ReadonlyMap<string, number> = new Map<string, number>([
  // Numpad section.
  ["NumLock", Key.NUMLOCK],
  ["Numpad0", Key.KP_0],
  ["Numpad1", Key.KP_1],
  ["Numpad2", Key.KP_2],
  ["Numpad3", Key.KP_3],
  ["Numpad4", Key.KP_4],
  ["Numpad5", Key.KP_5],
  ["Numpad6", Key.KP_6],
  ["Numpad7", Key.KP_7],
  ["Numpad8", Key.KP_8],
  ["Numpad9", Key.KP_9],
  ["NumpadAdd", Key.KP_ADD],
  ["NumpadBackspace", Key.BACKSPACE],
  ["Clear", Key.CLEAR], // NumLock on macOS.
  ["NumpadClear", Key.CLEAR],
  ["NumpadClearEntry", Key.CLEAR],
  ["NumpadDecimal", Key.KP_PERIOD],
  ["NumpadDivide", Key.KP_DIVIDE],
  ["NumpadEnter", Key.KP_ENTER],
  ["NumpadEqual", Key.EQUAL],
  ["NumpadMultiply", Key.KP_MULTIPLY],
  ["NumpadParenLeft", Key.PARENLEFT],
  ["NumpadParenRight", Key.PARENRIGHT],
  ["NumpadStar", Key.KP_MULTIPLY],
  ["NumpadSubtract", Key.KP_SUBTRACT],

  // Alphanumeric section.
  ["Backquote", Key.QUOTELEFT],
  ["Backslash", Key.BACKSLASH],
  ["BracketLeft", Key.BRACKETLEFT],
  ["BracketRight", Key.BRACKETRIGHT],
  ["Comma", Key.COMMA],
  ["Digit0", Key.KEY_0],
  ["Digit1", Key.KEY_1],
  ["Digit2", Key.KEY_2],
  ["Digit3", Key.KEY_3],
  ["Digit4", Key.KEY_4],
  ["Digit5", Key.KEY_5],
  ["Digit6", Key.KEY_6],
  ["Digit7", Key.KEY_7],
  ["Digit8", Key.KEY_8],
  ["Digit9", Key.KEY_9],
  ["Equal", Key.EQUAL],
  ["IntlBackslash", Key.BACKSLASH],
  ["IntlYen", Key.YEN],

  ["KeyA", Key.A],
  ["KeyB", Key.B],
  ["KeyC", Key.C],
  ["KeyD", Key.D],
  ["KeyE", Key.E],
  ["KeyF", Key.F],
  ["KeyG", Key.G],
  ["KeyH", Key.H],
  ["KeyI", Key.I],
  ["KeyJ", Key.J],
  ["KeyK", Key.K],
  ["KeyL", Key.L],
  ["KeyM", Key.M],
  ["KeyN", Key.N],
  ["KeyO", Key.O],
  ["KeyP", Key.P],
  ["KeyQ", Key.Q],
  ["KeyR", Key.R],
  ["KeyS", Key.S],
  ["KeyT", Key.T],
  ["KeyU", Key.U],
  ["KeyV", Key.V],
  ["KeyW", Key.W],
  ["KeyX", Key.X],
  ["KeyY", Key.Y],
  ["KeyZ", Key.Z],

  ["Minus", Key.MINUS],
  ["Period", Key.PERIOD],
  ["Quote", Key.APOSTROPHE],
  ["Semicolon", Key.SEMICOLON],
  ["Slash", Key.SLASH],

  // Functional keys in the Alphanumeric section.
  ["Alt", Key.ALT],
  ["AltLeft", Key.ALT],
  ["AltRight", Key.ALT],
  ["Backspace", Key.BACKSPACE],
  ["CapsLock", Key.CAPSLOCK],
  ["ContextMenu", Key.MENU],
  ["Control", Key.CTRL],
  ["ControlLeft", Key.CTRL],
  ["ControlRight", Key.CTRL],
  ["Enter", Key.ENTER],
  ["Meta", Key.META],
  ["MetaLeft", Key.META],
  ["MetaRight", Key.META],
  ["OSLeft", Key.META], // Command on macOS.
  ["OSRight", Key.META], // Command on macOS.
  ["Shift", Key.SHIFT],
  ["ShiftLeft", Key.SHIFT],
  ["ShiftRight", Key.SHIFT],
  ["Space", Key.SPACE],
  ["Tab", Key.TAB],

  // ControlPad section.
  ["Delete", Key.DELETE],
  ["End", Key.END],
  ["Help", Key.HELP],
  ["Home", Key.HOME],
  ["Insert", Key.INSERT],
  ["PageDown", Key.PAGEDOWN],
  ["PageUp", Key.PAGEUP],

  // ArrowPad section.
  ["ArrowDown", Key.DOWN],
  ["ArrowLeft", Key.LEFT],
  ["ArrowRight", Key.RIGHT],
  ["ArrowUp", Key.UP],

  // Function section.
  ["Escape", Key.ESCAPE],
  ["F1", Key.F1],
  ["F2", Key.F2],
  ["F3", Key.F3],
  ["F4", Key.F4],
  ["F5", Key.F5],
  ["F6", Key.F6],
  ["F7", Key.F7],
  ["F8", Key.F8],
  ["F9", Key.F9],
  ["F10", Key.F10],
  ["F11", Key.F11],
  ["F12", Key.F12],
  ["PrintScreen", Key.PRINT],
  ["ScrollLock", Key.SCROLLLOCK],
  ["Pause", Key.PAUSE],

  // Media keys section.
  ["BrowserBack", Key.BACK],
  ["BrowserFavorites", Key.FAVORITES],
  ["BrowserForward", Key.FORWARD],
  ["BrowserHome", Key.OPENURL],
  ["BrowserRefresh", Key.REFRESH],
  ["BrowserSearch", Key.SEARCH],
  ["BrowserStop", Key.STOP],
  ["LaunchApp1", Key.LAUNCH0],
  ["LaunchApp2", Key.LAUNCH1],
  ["LaunchMail", Key.LAUNCHMAIL],
  ["MediaPlayPause", Key.MEDIAPLAY],
  ["MediaSelect", Key.LAUNCHMEDIA],
  ["MediaStop", Key.MEDIASTOP],
  ["MediaTrackNext", Key.MEDIANEXT],
  ["MediaTrackPrevious", Key.MEDIAPREVIOUS],
  ["AudioVolumeDown", Key.VOLUMEDOWN],
  ["AudioVolumeMute", Key.VOLUMEMUTE],
  ["AudioVolumeUp", Key.VOLUMEUP],
]);

// dom_code2godot_key_location. Every other code (numpad included) is UNSPECIFIED, as in Godot.
const DOM2LOCATION: ReadonlyMap<string, number> = new Map<string, number>([
  ["AltLeft", KeyLocation.LEFT],
  ["AltRight", KeyLocation.RIGHT],
  ["ControlLeft", KeyLocation.LEFT],
  ["ControlRight", KeyLocation.RIGHT],
  ["MetaLeft", KeyLocation.LEFT],
  ["MetaRight", KeyLocation.RIGHT],
  ["OSLeft", KeyLocation.LEFT],
  ["OSRight", KeyLocation.RIGHT],
  ["ShiftLeft", KeyLocation.LEFT],
  ["ShiftRight", KeyLocation.RIGHT],
]);

/** Named `key` values that the shared table spells differently. `AltGraph` is the AltGr key. */
const KEY_NAME_EXTRA: ReadonlyMap<string, number> = new Map<string, number>([
  ["AltGraph", Key.ALT],
]);

/**
 * The fields of a DOM `KeyboardEvent` the mapping reads. A real `KeyboardEvent` satisfies it except
 * for `altGraph`, which is `getModifierState("AltGraph")` (the capture reads it); the conformance
 * vectors (`conformance/v1/keymap`) use exactly these names.
 */
export interface DomKeyEvent {
  /** `"keydown"` presses; anything else (`"keyup"`) releases. */
  type: string;
  code: string;
  key: string;
  shiftKey?: boolean | undefined;
  ctrlKey?: boolean | undefined;
  altKey?: boolean | undefined;
  metaKey?: boolean | undefined;
  /** `getModifierState("AltGraph")`. */
  altGraph?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  /** Legacy `keyCode`; 229 marks an IME-processed key. */
  keyCode?: number;
}

/** `navigator.keyboard.getLayoutMap()`'s result, or anything else mapping a `code` to its unshifted label. */
export interface KeyboardLayoutLike {
  get(code: string): string | undefined;
}

export interface KeyRecordOptions {
  /** The current keyboard layout map, when the browser exposes one. */
  layout?: KeyboardLayoutLike | null;
}

/** The IME-processed `keyCode` (`Process` key) of a keydown that belongs to a composition. */
const IME_KEY_CODE = 229;

/** `Key` for a DOM `code` (US-QWERTY position), or 0 when Godot's table does not map it. */
export function physicalKeycodeFromCode(code: string): number {
  return DOM2GODOT.get(code) ?? 0;
}

/** `KeyLocation` for a DOM `code`: LEFT/RIGHT for the Shift/Control/Alt/Meta pairs, else UNSPECIFIED. */
export function keyLocationFromCode(code: string): number {
  return DOM2LOCATION.get(code) ?? KeyLocation.UNSPECIFIED;
}

/** The single code point of `text`, or -1 when it is empty or longer (code points, not UTF-16 units). */
function singleCodePoint(text: string): number {
  const first = text.codePointAt(0);
  if (first === undefined) return -1;
  return text.length === (first > 0xffff ? 2 : 1) ? first : -1;
}

/** `String::char_uppercase`: the one-code-point uppercase of `c`, or `c` when it has none. */
function upper(c: number): number {
  const up = String.fromCodePoint(c).toUpperCase();
  const single = singleCodePoint(up);
  return single === -1 ? c : single;
}

const isAsciiPrintable = (c: number) => c >= 0x20 && c <= 0x7e;
const isAsciiLetter = (c: number) =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isPrintable = (c: number) => c >= 0x20 && c !== 0x7f;

/** The `keycode` derivation of docs/input.md "Keyboard", steps 1-3. */
function unshiftedKeycode(
  dom: DomKeyEvent,
  c: number,
  physical: number,
  layout: KeyboardLayoutLike | null | undefined,
): number {
  const named = DOM2GODOT.get(dom.key) ?? KEY_NAME_EXTRA.get(dom.key);
  if (named !== undefined) return named;
  if (c === -1) return physical; // Dead, Process, Unidentified, other names.
  if (!dom.shiftKey && !dom.altGraph && isAsciiPrintable(c)) return upper(c);
  if (isAsciiLetter(c)) return upper(c);
  const label = layout?.get(dom.code);
  if (label !== undefined) {
    const l = singleCodePoint(label);
    if (l !== -1 && isAsciiPrintable(l)) return upper(l);
  }
  return physical;
}

const MODIFIER_FLAGS = [
  ["shift_pressed", "shiftKey", Key.SHIFT],
  ["ctrl_pressed", "ctrlKey", Key.CTRL],
  ["alt_pressed", "altKey", Key.ALT],
  ["meta_pressed", "metaKey", Key.META],
] as const;

/**
 * The `key` record for one DOM key event, or `null` when it is not forwarded: its `code` is not in
 * Godot's table (`IntlRo`, `Lang1`, `Unidentified`), or it is a keydown belonging to an IME
 * composition (`isComposing` / `keyCode` 229). A keyup is always mapped (releases are never
 * gated); a capture that latched the press replays the press record instead (`releaseKeyRecord`).
 *
 * Default-valued fields are omitted, so the result equals its canonical encoding's parse.
 */
export function keyRecordFromDom(
  dom: DomKeyEvent,
  options: KeyRecordOptions = {},
): KeyRecord | null {
  const physical = physicalKeycodeFromCode(dom.code);
  if (physical === 0) return null;
  const pressed = dom.type === "keydown";
  if (pressed && (dom.isComposing === true || dom.keyCode === IME_KEY_CODE))
    return null;

  const c = singleCodePoint(dom.key);
  const keycode = unshiftedKeycode(dom, c, physical, options.layout);
  const keyLabel = c !== -1 && isPrintable(c) ? upper(c) : keycode;
  const unicode = c !== -1 && isPrintable(c) ? c : 0;
  const location = keyLocationFromCode(dom.code);

  const record: KeyRecord = {
    event: "key",
    physical_keycode: physical,
    keycode,
    key_label: keyLabel,
    pressed,
  };
  if (unicode !== 0) record.unicode = unicode;
  if (location !== KeyLocation.UNSPECIFIED) record.location = location;
  if (pressed && dom.repeat === true) record.echo = true;
  // dom2godot_mod (display_server_web.cpp:147-160): a modifier key does not set its own flag.
  for (const [field, flag, own] of MODIFIER_FLAGS)
    if (dom[flag] === true && keycode !== own) record[field] = true;
  if (/^[A-Za-z0-9]{1,32}$/.test(dom.code)) record.code = dom.code;
  return record;
}

/**
 * The release of a latched press: the press record with `pressed: false` and no `echo`, whatever
 * the modifiers are now. Godot clears `keys_pressed`, `physical_keys_pressed` and
 * `key_label_pressed` by the released values, and `InputEventKey::action_match` compares the same
 * fields, so a release that differs from its press leaves a key or an action stuck.
 */
export function releaseKeyRecord(press: KeyRecord): KeyRecord {
  const { echo: _echo, ...rest } = press;
  return { ...rest, pressed: false };
}
