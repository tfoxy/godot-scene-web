// @godot-scene-web/input/gamepad: a polled W3C Gamepad API capture that emits gsw-input/1
// `joypad_button` / `joypad_motion` records in Godot's own vocabulary. Spec: docs/input.md "Gamepad".
//
// The Gamepad API has no input events: a pad is a per-frame snapshot, so the capture runs an rAF poll
// and diffs each frame against what it already sent. The poll runs only while a usable pad exists
// (`gamepadconnected` starts it, a frame with none parks it), so a page with no pad costs two idle
// listeners. Prior art: sts2-couch-coop `frontend/src/mirror/gamepadCapture.ts`, whose edge-only
// token wire this replaces with Godot records (couch keeps its tokens in an adapter over `latched`).
//
// This module types the browser objects it reads structurally, so the package still typechecks
// without DOM libraries and a test can hand over plain objects.

import type { JoypadButtonRecord, JoypadMotionRecord } from "./format";
import { JoyAxis, JoyButton } from "./godot-enums";

/** One `Gamepad.buttons` entry as engines shape it: a `GamepadButton`, a bare number, or a hole. */
export type GamepadButtonSnapshot =
  | { pressed?: boolean; value?: number }
  | number
  | null
  | undefined;

/** The parts of a `Gamepad` the capture reads. The real `Gamepad` satisfies it. */
export interface GamepadSnapshot {
  /** Slot source for `pads: "each"`; defaults to the pad's position in `getGamepads()`. */
  index?: number;
  id?: string;
  /** `false` counts as absent. */
  connected?: boolean;
  /** `"standard"` is read as is, `"xr-standard"` is always skipped, anything else follows `nonStandard`. */
  mapping?: string;
  buttons?: ArrayLike<GamepadButtonSnapshot> | null;
  axes?: ArrayLike<number> | null;
}

/** A pad's controls in W3C standard order (b0..b16, a0..a3). */
export interface StandardGamepadView {
  buttons?: ArrayLike<GamepadButtonSnapshot> | null;
  axes?: ArrayLike<number> | null;
}

/**
 * What to do with a pad whose `mapping` is not `"standard"` (in practice `""`). `skip` (default):
 * Firefox and Chrome on Linux report evdev order, which differs from the standard layout
 * (godotcontrollerdb.txt:24-26). `as-standard`: read it as if it were standard (right for the
 * XInput-shaped pads most desktops have). A function remaps the pad itself and returns its controls
 * in standard order, or `null` to skip it.
 */
export type GamepadNonStandardPolicy =
  | "skip"
  | "as-standard"
  | ((pad: GamepadSnapshot) => StandardGamepadView | null | undefined);

/**
 * How pads become wire slots (`device`). `each` (default for now): `Gamepad.index` is the slot and
 * pads at or above `maxSlots` are ignored. `merge`: every pad is slot 0, buttons ORed, the
 * largest-magnitude axis wins. docs/input.md names `claim` (a focused press claims a pad, exclusive
 * across tabs through Web Locks) as the eventual default; it lands in IN6 as a third policy beside
 * these two, see `SlotPolicy` below.
 */
export type GamepadPadsMode = "each" | "merge";

/** A gamepad record; the only kinds this capture emits. */
export type GamepadRecord = JoypadButtonRecord | JoypadMotionRecord;

/**
 * Where the capture pushes records, one at a time in emission order. An input session batches the
 * records of one task into one `events` message; a product adapter may consume them directly.
 */
export interface GamepadSink {
  push(record: GamepadRecord): void;
}

/** One pad slot's complete held state, the body of a `joypad` `sync`. */
export interface GamepadHeldState {
  scope: "joypad";
  device: number;
  /** Pressed buttons (`pressed: true`) by `button_index`, then nonzero axes by `axis`. */
  held: GamepadRecord[];
}

export interface GamepadEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface GamepadVisibilitySource extends GamepadEventTarget {
  visibilityState?: string;
}

export interface GamepadCaptureOptions {
  sink: GamepadSink;
  /** See `GamepadPadsMode`. Default `"each"`. */
  pads?: GamepadPadsMode;
  /** Slots `each` uses, 1..16. Default 4 (the injector leases 4 devices per source). */
  maxSlots?: number;
  /** See `GamepadNonStandardPolicy`. Default `"skip"`. */
  nonStandard?: GamepadNonStandardPolicy;
  /**
   * Ignore controls already held in the first sample that has a usable pad until each is released
   * (buttons: until up; axes and triggers: until `|v| < 0.35`). For a capture created while the
   * player may be mid-press, e.g. on resuming access. Default false.
   */
  neutralizeHeldOnStart?: boolean;
  /** Cap on axis updates per second (buttons are never delayed). Default: once per animation frame. */
  maxHz?: number;
  /** Read on every poll; `false` releases everything and parks until `refresh()`. Default: always on. */
  enabled?: () => boolean;
  /** `navigator.getGamepads`, bound. Default: the bound browser function; `null` or absent API = inert. */
  getGamepads?:
    | (() => ArrayLike<GamepadSnapshot | null | undefined> | null | undefined)
    | null;
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  /** Where `gamepadconnected` / `gamepaddisconnected` fire. Default `window`. */
  events?: GamepadEventTarget | null;
  /** Where `visibilitychange` fires and `visibilityState` is read. Default `document`. */
  visibility?: GamepadVisibilitySource | null;
}

export interface GamepadCapture {
  /** Every present slot's held state (empty `held` included), for a session's post-`hello` syncs. */
  heldState(): GamepadHeldState[];
  /** Re-read `enabled()` and visibility: start the poll or release and park. Idempotent. */
  refresh(): void;
  /** Whether a poll frame is scheduled. Diagnostics and tests. */
  polling(): boolean;
  /** Stop polling, drop listeners, release everything held. */
  dispose(): void;
}

/** W3C standard mapping -> Godot, `input_enums.h:68-105`, `godotcontrollerdb.txt:23`. b17+ is dropped. */
export const STANDARD_GAMEPAD_MAP: readonly (
  | { readonly button: number }
  | { readonly axis: number }
)[] = [
  { button: JoyButton.A },
  { button: JoyButton.B },
  { button: JoyButton.X },
  { button: JoyButton.Y },
  { button: JoyButton.LEFT_SHOULDER },
  { button: JoyButton.RIGHT_SHOULDER },
  { axis: JoyAxis.TRIGGER_LEFT },
  { axis: JoyAxis.TRIGGER_RIGHT },
  { button: JoyButton.BACK },
  { button: JoyButton.START },
  { button: JoyButton.LEFT_STICK },
  { button: JoyButton.RIGHT_STICK },
  { button: JoyButton.DPAD_UP },
  { button: JoyButton.DPAD_DOWN },
  { button: JoyButton.DPAD_LEFT },
  { button: JoyButton.DPAD_RIGHT },
  { button: JoyButton.GUIDE },
];

/** Hysteresis thresholds for `latched`: down at 0.55, back up only below 0.35. */
export const LATCH_PRESS = 0.55;
export const LATCH_RELEASE = 0.35;

/**
 * Press/release hysteresis for adapters that need edges from an analog control (a trigger axis, one
 * stick direction): held stays held while `value > release`; otherwise it presses at `value >= press`.
 * A value hovering between the two keeps whatever it was, so a trigger at its bite point never chatters.
 */
export function latched(
  value: number,
  wasHeld: boolean,
  press: number = LATCH_PRESS,
  release: number = LATCH_RELEASE,
): boolean {
  return wasHeld ? value > release : value >= press;
}

// --- analog policy (docs/input.md "Gamepad") ----------------------------------------------------

/** |v| below this reads 0: kills drift at rest without becoming a deadzone (Godot owns deadzones). */
const REST_FLOOR = 0.02;
const QUANTUM = 256;
/** A neutralized axis rejoins once it reads below this magnitude. */
const NEUTRAL_AXIS = LATCH_RELEASE;
const DIGITAL_THRESHOLD = 0.5;
const STICK_AXES = 4;
/** Sticks (0..3) then triggers (4, 5): Godot axis order, which is also the emission order. */
const AXIS_COUNT = 6;
const BUTTON_COUNT = JoyButton.DPAD_RIGHT + 1;
const DEFAULT_MAX_SLOTS = 4;
const MAX_SLOTS = 16;

/** Finite, clamped, rest-floored, quantized to 1/256 and written with ≤ 4 decimals. */
function shapeAxis(raw: unknown, min: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const v = Math.min(1, Math.max(min, raw));
  const magnitude = Math.abs(v);
  if (magnitude < REST_FLOOR) return 0;
  // Rounded on the magnitude so -v is always the mirror of v (Math.round breaks .5 ties upward).
  const steps = Math.round(magnitude * QUANTUM);
  return (Math.sign(v) * Math.round(steps * (10000 / QUANTUM))) / 10000;
}

function buttonValue(button: GamepadButtonSnapshot): number {
  if (typeof button === "number") return Number.isFinite(button) ? button : 0;
  if (!button) return 0;
  if (typeof button.value === "number" && Number.isFinite(button.value))
    return button.value;
  return button.pressed === true ? 1 : 0;
}

function buttonDown(button: GamepadButtonSnapshot): boolean {
  if (
    button &&
    typeof button === "object" &&
    typeof button.pressed === "boolean"
  )
    return button.pressed;
  return buttonValue(button) >= DIGITAL_THRESHOLD;
}

/** One slot's controls for one frame, in Godot order. */
interface SlotFrame {
  buttons: boolean[];
  axes: number[];
}

function emptyFrame(): SlotFrame {
  return {
    buttons: new Array<boolean>(BUTTON_COUNT).fill(false),
    axes: new Array<number>(AXIS_COUNT).fill(0),
  };
}

function readStandard(view: StandardGamepadView): SlotFrame {
  const frame = emptyFrame();
  STANDARD_GAMEPAD_MAP.forEach((target, w3c) => {
    const button = view.buttons?.[w3c];
    if ("button" in target) frame.buttons[target.button] = buttonDown(button);
    else frame.axes[target.axis] = shapeAxis(buttonValue(button), 0);
  });
  for (let axis = 0; axis < STICK_AXES; axis += 1)
    frame.axes[axis] = shapeAxis(view.axes?.[axis], -1);
  return frame;
}

/** Merge: buttons ORed, the largest-magnitude axis wins (the earlier pad on a tie). */
function mergeInto(into: SlotFrame, from: SlotFrame): void {
  for (let b = 0; b < BUTTON_COUNT; b += 1)
    into.buttons[b] = into.buttons[b] || from.buttons[b];
  for (let a = 0; a < AXIS_COUNT; a += 1)
    if (Math.abs(from.axes[a]) > Math.abs(into.axes[a]))
      into.axes[a] = from.axes[a];
}

// --- slot policies ------------------------------------------------------------------------------

/** A usable pad of this frame, already read into Godot order. */
interface UsablePad {
  pad: GamepadSnapshot;
  /** `Gamepad.index`, or its position in `getGamepads()`. */
  index: number;
  frame: SlotFrame;
}

/**
 * Turns this frame's usable pads into slot frames. `each` and `merge` are pure. IN6's `claim` is
 * the third implementation: it owns the Web Locks and the `document.hasFocus()` gate, returns
 * slots only for pads this window holds a lock for (a pad it loses or that disconnects simply
 * drops out of `assign`, which releases its slot), and lists the slots it claimed this frame from
 * `consumed()` so the capture swallows the claiming press until it is released (the path
 * `neutralizeHeldOnStart` uses). `dispose` drops its locks.
 */
interface SlotPolicy {
  assign(pads: readonly UsablePad[]): Map<number, SlotFrame>;
  /** Slots whose currently held controls are suppressed until released. Called after `assign`. */
  consumed?(): Iterable<number>;
  dispose(): void;
}

function eachPolicy(maxSlots: number): SlotPolicy {
  return {
    assign(pads) {
      const slots = new Map<number, SlotFrame>();
      for (const { index, frame } of pads)
        if (index < maxSlots && !slots.has(index)) slots.set(index, frame);
      return slots;
    },
    dispose() {},
  };
}

const mergePolicy: SlotPolicy = {
  assign(pads) {
    const slots = new Map<number, SlotFrame>();
    if (pads.length === 0) return slots;
    const merged = emptyFrame();
    for (const { frame } of pads) mergeInto(merged, frame);
    slots.set(0, merged);
    return slots;
  },
  dispose() {},
};

// --- environment defaults -----------------------------------------------------------------------

interface BrowserGlobals {
  navigator?: {
    getGamepads?: () => ArrayLike<GamepadSnapshot | null | undefined>;
  };
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  window?: GamepadEventTarget;
  document?: GamepadVisibilitySource;
}

const browser = globalThis as BrowserGlobals;

function defaultGetGamepads(): GamepadCaptureOptions["getGamepads"] {
  const nav = browser.navigator;
  // Bound: Chrome throws "Illegal invocation" on a detached `getGamepads`. Absent on insecure
  // origins (secure-context only) and in Node, which leaves the capture inert.
  return nav && typeof nav.getGamepads === "function"
    ? () => nav.getGamepads?.() ?? null
    : null;
}

// --- the capture --------------------------------------------------------------------------------

/** Create the capture. Inert (no listeners, no records) where the Gamepad API or rAF is missing. */
export function createGamepadCapture(
  options: GamepadCaptureOptions,
): GamepadCapture {
  const { sink } = options;
  const enabled = options.enabled ?? (() => true);
  const getGamepads =
    options.getGamepads === undefined
      ? defaultGetGamepads()
      : options.getGamepads;
  const raf =
    options.requestAnimationFrame ??
    (typeof browser.requestAnimationFrame === "function"
      ? (cb: (time: number) => void) => browser.requestAnimationFrame?.(cb) ?? 0
      : null);
  const cancelRaf =
    options.cancelAnimationFrame ??
    (typeof browser.cancelAnimationFrame === "function"
      ? (handle: number) => browser.cancelAnimationFrame?.(handle)
      : null);
  const events =
    options.events === undefined ? (browser.window ?? null) : options.events;
  const visibility =
    options.visibility === undefined
      ? (browser.document ?? null)
      : options.visibility;
  const nonStandard = options.nonStandard ?? "skip";
  const maxSlots = Math.min(
    MAX_SLOTS,
    Math.max(1, Math.floor(options.maxSlots ?? DEFAULT_MAX_SLOTS)),
  );
  const policy: SlotPolicy =
    options.pads === "merge" ? mergePolicy : eachPolicy(maxSlots);
  const minAxisIntervalMs =
    options.maxHz !== undefined && options.maxHz > 0 ? 1000 / options.maxHz : 0;

  /** What the host has been told, per present slot. */
  const sent = new Map<number, SlotFrame>();
  /** Controls ignored until released (neutralized at start; IN6 adds claim presses). */
  const suppressed = new Map<
    number,
    { buttons: Set<number>; axes: Set<number> }
  >();
  let neutralizePending = options.neutralizeHeldOnStart === true;
  let lastAxisSendMs = Number.NEGATIVE_INFINITY;
  let rafHandle: number | null = null;
  let disposed = false;
  const live = Boolean(getGamepads && raf && cancelRaf);

  function visible(): boolean {
    return visibility?.visibilityState !== "hidden";
  }

  function shouldRun(): boolean {
    return live && !disposed && enabled() !== false && visible();
  }

  function standardView(pad: GamepadSnapshot): StandardGamepadView | null {
    if (pad.mapping === "standard") return pad;
    if (pad.mapping === "xr-standard") return null;
    if (nonStandard === "skip") return null;
    if (nonStandard === "as-standard") return pad;
    return nonStandard(pad) ?? null;
  }

  function usablePads(): UsablePad[] {
    const pads = getGamepads?.();
    const usable: UsablePad[] = [];
    const count = pads?.length ?? 0;
    for (let i = 0; i < count; i += 1) {
      const pad = pads?.[i];
      if (!pad || pad.connected === false) continue;
      const view = standardView(pad);
      if (!view) continue;
      const index =
        typeof pad.index === "number" && Number.isInteger(pad.index)
          ? pad.index
          : i;
      usable.push({ pad, index, frame: readStandard(view) });
    }
    return usable;
  }

  /** Suppress every control `frame` holds, until each is released. */
  function suppressHeld(slot: number, frame: SlotFrame): void {
    const entry = suppressed.get(slot) ?? {
      buttons: new Set<number>(),
      axes: new Set<number>(),
    };
    frame.buttons.forEach((down, b) => {
      if (down) entry.buttons.add(b);
    });
    frame.axes.forEach((v, a) => {
      if (Math.abs(v) >= NEUTRAL_AXIS) entry.axes.add(a);
    });
    if (entry.buttons.size > 0 || entry.axes.size > 0)
      suppressed.set(slot, entry);
  }

  /** Drop released controls from the suppressed set and mask the rest out of `frame`. */
  function applySuppression(slot: number, frame: SlotFrame): void {
    const entry = suppressed.get(slot);
    if (!entry) return;
    for (const b of entry.buttons) {
      if (!frame.buttons[b]) entry.buttons.delete(b);
      else frame.buttons[b] = false;
    }
    for (const a of entry.axes) {
      if (Math.abs(frame.axes[a]) < NEUTRAL_AXIS) entry.axes.delete(a);
      else frame.axes[a] = 0;
    }
    if (entry.buttons.size === 0 && entry.axes.size === 0)
      suppressed.delete(slot);
  }

  /**
   * Diff `next` against `sent` and push: every button release, then axis motions, then presses
   * (slots ascending within each). A slot missing from `next` is released and forgotten.
   */
  function emit(next: Map<number, SlotFrame>, time: number | null): void {
    const slots = [...new Set([...sent.keys(), ...next.keys()])].sort(
      (a, b) => a - b,
    );
    const axesDue =
      time === null || time - lastAxisSendMs >= minAxisIntervalMs - 0.5;
    const previous = (slot: number) => sent.get(slot) ?? emptyFrame();
    const target = (slot: number) => next.get(slot) ?? emptyFrame();
    for (const device of slots) {
      const was = previous(device).buttons;
      const now = target(device).buttons;
      for (let b = 0; b < BUTTON_COUNT; b += 1)
        if (was[b] && !now[b])
          sink.push({
            event: "joypad_button",
            device,
            button_index: b,
            pressed: false,
          });
    }
    let axisSent = false;
    for (const device of slots) {
      const was = previous(device);
      const now = target(device);
      // A vanished slot always zeroes at once; a live one waits for the maxHz window.
      const due = axesDue || !next.has(device);
      for (let a = 0; a < AXIS_COUNT; a += 1) {
        if (was.axes[a] === now.axes[a]) continue;
        if (!due) {
          now.axes[a] = was.axes[a];
          continue;
        }
        sink.push({
          event: "joypad_motion",
          device,
          axis: a,
          axis_value: now.axes[a],
        });
        axisSent = true;
      }
    }
    if (axisSent && time !== null) lastAxisSendMs = time;
    for (const device of slots) {
      const was = previous(device).buttons;
      const now = target(device).buttons;
      for (let b = 0; b < BUTTON_COUNT; b += 1)
        if (!was[b] && now[b])
          sink.push({
            event: "joypad_button",
            device,
            button_index: b,
            pressed: true,
          });
    }
    sent.clear();
    for (const [slot, frame] of next) sent.set(slot, frame);
  }

  function releaseAll(): void {
    if (sent.size > 0) emit(new Map(), null);
    suppressed.clear();
  }

  function stop(): void {
    if (rafHandle !== null) {
      cancelRaf?.(rafHandle);
      rafHandle = null;
    }
  }

  function schedule(): void {
    if (rafHandle === null && shouldRun()) rafHandle = raf?.(poll) ?? null;
  }

  function poll(time: number): void {
    rafHandle = null;
    if (!shouldRun()) {
      releaseAll();
      return;
    }
    const pads = usablePads();
    if (pads.length === 0) {
      // Nothing to read: release what the vanished pads held and park until `gamepadconnected`.
      // Chrome lists no pad before a gesture, so a pending neutralize waits for the first one.
      releaseAll();
      return;
    }
    const next = policy.assign(pads);
    if (neutralizePending) {
      neutralizePending = false;
      for (const [slot, frame] of next) suppressHeld(slot, frame);
    }
    for (const slot of policy.consumed?.() ?? []) {
      const frame = next.get(slot);
      if (frame) suppressHeld(slot, frame);
    }
    for (const slot of [...suppressed.keys()])
      if (!next.has(slot)) suppressed.delete(slot);
    for (const [slot, frame] of next) applySuppression(slot, frame);
    emit(next, time);
    schedule();
  }

  // `gamepadconnected` is the earliest a pad exists for the page (Chrome fires it on the first
  // press); a disconnect needs one more poll to release the departed pad, after which it parks.
  const onPadEvent = (): void => schedule();
  const onVisibility = (): void => {
    if (visible()) schedule();
    else {
      stop();
      releaseAll();
    }
  };

  if (live) {
    events?.addEventListener("gamepadconnected", onPadEvent);
    events?.addEventListener("gamepaddisconnected", onPadEvent);
    visibility?.addEventListener("visibilitychange", onVisibility);
    // A pad the page already knows (a reload with the pad awake) fires no new event.
    if (usablePads().length > 0) schedule();
  }

  return {
    heldState() {
      return [...sent.keys()]
        .sort((a, b) => a - b)
        .map((device) => {
          const frame = sent.get(device) ?? emptyFrame();
          const held: GamepadRecord[] = [];
          frame.buttons.forEach((down, b) => {
            if (down)
              held.push({
                event: "joypad_button",
                device,
                button_index: b,
                pressed: true,
              });
          });
          frame.axes.forEach((v, a) => {
            if (v !== 0)
              held.push({
                event: "joypad_motion",
                device,
                axis: a,
                axis_value: v,
              });
          });
          return { scope: "joypad" as const, device, held };
        });
    },
    refresh() {
      if (disposed) return;
      if (shouldRun()) schedule();
      else {
        stop();
        releaseAll();
      }
    },
    polling() {
      return rafHandle !== null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      if (live) {
        events?.removeEventListener("gamepadconnected", onPadEvent);
        events?.removeEventListener("gamepaddisconnected", onPadEvent);
        visibility?.removeEventListener("visibilitychange", onVisibility);
      }
      releaseAll();
      policy.dispose();
    },
  };
}
