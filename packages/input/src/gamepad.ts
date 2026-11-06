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
// Type-only: the subpath bundle must not pull the session (and through it the codec) in.
import type { InputHeldState, InputSink } from "./session";

/** One `Gamepad.buttons` entry as engines shape it: a `GamepadButton`, a bare number, or a hole. */
export type GamepadButtonSnapshot =
  | { pressed?: boolean; value?: number }
  | number
  | null
  | undefined;

/** The parts of a `Gamepad` the capture reads. The real `Gamepad` satisfies it. */
export interface GamepadSnapshot {
  /**
   * Slot source for `pads: "each"` and part of a claim's lock name; defaults to the pad's position
   * in `getGamepads()`.
   */
  index?: number;
  /** Part of a claim's lock name; absent reads as `""`. */
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
 * How pads become wire slots (`device`).
 *
 * - `claim` (default): this window reports only the pads it claimed. A pad is claimed by a fresh
 *   press (a button going down or a trigger pulled to 0.55) made while `hasFocus()` is true; the
 *   claim takes the lowest free slot below `maxSlots`, the claiming press is swallowed until it is
 *   released, and a Web Lock `gsw-input/pad/<index>/<id>` (requested `ifAvailable`) makes it
 *   exclusive across same-origin windows. The claim ends when the pad disconnects or the capture is
 *   disposed (closing the window drops its locks too). Without Web Locks, claims are per-window only.
 *   This is what several browser windows on one machine need: each window gets the pads pressed in it.
 * - `each`: `Gamepad.index` is the slot; pads at or above `maxSlots` are ignored.
 * - `merge`: every pad is slot 0, buttons ORed, the largest-magnitude axis wins.
 */
export type GamepadPadsMode = "claim" | "each" | "merge";

/** A gamepad record; the only kinds this capture emits. */
export type GamepadRecord = JoypadButtonRecord | JoypadMotionRecord;

/** One claim of `pads: "claim"`, for diagnostics. */
export interface GamepadClaim {
  /** `Gamepad.index` (or the position in `getGamepads()`). */
  index: number;
  /** `Gamepad.id`, `""` when absent. */
  id: string;
  /** The wire slot (`device`) the pad reports on once held. */
  slot: number;
  /** `pending`: the lock was requested and not yet granted. `held`: the pad reports on `slot`. */
  state: "pending" | "held";
  /** Backed by a Web Lock. `false` for a per-window claim (no `locks`, or the lock manager failed). */
  exclusive: boolean;
}

/**
 * The part of the Web Locks API a claim uses; `navigator.locks` satisfies it. The callback gets the
 * lock, or `null` when another holder has it (`ifAvailable`), and holds the lock until the promise
 * it returns settles.
 */
export interface GamepadLockManager {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: object | null) => Promise<void> | undefined,
  ): Promise<unknown>;
}

/**
 * Where `gamepadconnected` / `gamepaddisconnected` fire (`window`). The capture reads `gamepad`
 * off a disconnect event when there is one.
 */
export interface GamepadEventTarget {
  addEventListener(
    type: string,
    listener: (event: { type: string }) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: { type: string }) => void,
  ): void;
}

export interface GamepadVisibilitySource extends GamepadEventTarget {
  visibilityState?: string;
}

export interface GamepadCaptureOptions {
  /** Receives the records, one at a time in emission order (an input session, or an adapter). */
  sink: InputSink;
  /** See `GamepadPadsMode`. Default `"claim"`. */
  pads?: GamepadPadsMode;
  /** Slots `each` and `claim` use, 1..16. Default 4 (the injector leases 4 devices per source). */
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
  /**
   * The focus gate of `pads: "claim"`, read when a fresh press could claim a pad. Default
   * `document.hasFocus()`, or always true without it.
   */
  hasFocus?: () => boolean;
  /**
   * The lock manager of `pads: "claim"`. Default `navigator.locks`. `null` (or no Web Locks, or a
   * manager whose `request` fails) keeps claims per-window: still focus-gated, but two windows can
   * each claim the same pad, so use one window per pad there.
   */
  locks?: GamepadLockManager | null;
}

export interface GamepadCapture {
  /**
   * Every present slot's held state (empty `held` included), for a session's post-`hello` syncs:
   * `joypad` scope, pressed buttons by `button_index`, then nonzero axes by `axis`.
   */
  heldState(): InputHeldState[];
  /** The current claims of `pads: "claim"` by slot; empty for `each` and `merge`. */
  claims(): GamepadClaim[];
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
  /** `Gamepad.id`, `""` when absent. */
  id: string;
  frame: SlotFrame;
}

/**
 * Turns this frame's usable pads into slot frames. `each` and `merge` are pure. `claim` owns the
 * Web Locks and the focus gate: it returns slots only for pads this window holds a claim for (a pad
 * it loses or that disconnects simply drops out of `assign`, which releases its slot), and lists the
 * slots it was granted since the last frame from `consumed()` so the capture swallows the claiming
 * press until it is released (the path `neutralizeHeldOnStart` uses). `dispose` drops its locks.
 */
interface SlotPolicy {
  assign(pads: readonly UsablePad[]): Map<number, SlotFrame>;
  /** Slots whose currently held controls are suppressed until released. Called after `assign`. */
  consumed?(): Iterable<number>;
  /** A `gamepaddisconnected` for this pad: drop what is bound to it, even while not polling. */
  forget?(index: number, id: string): void;
  claims?(): GamepadClaim[];
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

/** The controls that can claim a pad: buttons, and triggers latched at 0.55 / 0.35. */
interface PressState {
  buttons: boolean[];
  triggers: [boolean, boolean];
}

const RELEASED: PressState = {
  buttons: new Array<boolean>(BUTTON_COUNT).fill(false),
  triggers: [false, false],
};

function pressState(frame: SlotFrame, was: PressState): PressState {
  return {
    buttons: [...frame.buttons],
    triggers: [
      latched(frame.axes[JoyAxis.TRIGGER_LEFT], was.triggers[0]),
      latched(frame.axes[JoyAxis.TRIGGER_RIGHT], was.triggers[1]),
    ],
  };
}

function freshPress(was: PressState, now: PressState): boolean {
  return (
    now.buttons.some((down, b) => down && !was.buttons[b]) ||
    now.triggers.some((down, t) => down && !was.triggers[t])
  );
}

/** The Web Lock that makes a claim exclusive across same-origin windows. */
export function padLockName(index: number, id: string): string {
  return `gsw-input/pad/${index}/${id}`;
}

interface ClaimEntry extends GamepadClaim {
  key: string;
  /** Settles the held lock's promise, which hands the lock back. */
  release: (() => void) | null;
}

function claimPolicy(
  maxSlots: number,
  hasFocus: () => boolean,
  locks: GamepadLockManager | null,
): SlotPolicy {
  const claims = new Map<string, ClaimEntry>();
  /** Last frame's claiming controls per pad, so only an edge claims (a hold carried into focus does not). */
  const seen = new Map<string, PressState>();
  /** Slots granted since the last `consumed()`. */
  let granted: number[] = [];
  let manager = locks;
  let disposed = false;

  const keyOf = (index: number, id: string) => `${index}/${id}`;
  const current = (entry: ClaimEntry) =>
    !disposed && claims.get(entry.key) === entry;

  function drop(entry: ClaimEntry): void {
    if (claims.get(entry.key) === entry) claims.delete(entry.key);
    const release = entry.release;
    entry.release = null;
    release?.();
  }

  function hold(entry: ClaimEntry, exclusive: boolean): void {
    entry.state = "held";
    entry.exclusive = exclusive;
    granted.push(entry.slot);
  }

  function freeSlot(): number {
    const used = new Set([...claims.values()].map((entry) => entry.slot));
    for (let slot = 0; slot < maxSlots; slot += 1)
      if (!used.has(slot)) return slot;
    return -1;
  }

  /** The lock manager is unusable (a sandboxed or opaque origin): fall back to per-window claims. */
  function lockFailed(entry: ClaimEntry): void {
    manager = null;
    if (current(entry) && entry.state === "pending") hold(entry, false);
  }

  function request(entry: ClaimEntry): void {
    if (!manager) {
      hold(entry, false);
      return;
    }
    let pending: Promise<unknown>;
    try {
      pending = manager.request(
        padLockName(entry.index, entry.id),
        { ifAvailable: true },
        (lock) => {
          // A stale grant (disconnected or disposed meanwhile) returns at once, handing the lock back.
          if (!current(entry)) return undefined;
          if (lock === null) {
            // Another window holds this pad; a later fresh press asks again.
            claims.delete(entry.key);
            return undefined;
          }
          hold(entry, true);
          return new Promise<void>((resolve) => {
            entry.release = resolve;
          });
        },
      );
    } catch {
      lockFailed(entry);
      return;
    }
    // Settling while still held means the lock was taken away (`steal`): the claim ends.
    pending.then(
      () => {
        if (current(entry)) drop(entry);
      },
      () => {
        if (!current(entry)) return;
        if (entry.state === "pending") lockFailed(entry);
        else drop(entry);
      },
    );
  }

  return {
    assign(pads) {
      const present = new Set(pads.map((pad) => keyOf(pad.index, pad.id)));
      for (const entry of [...claims.values()])
        if (!present.has(entry.key)) drop(entry);
      for (const key of [...seen.keys()])
        if (!present.has(key)) seen.delete(key);
      const slots = new Map<number, SlotFrame>();
      for (const { index, id, frame } of pads) {
        const key = keyOf(index, id);
        const was = seen.get(key) ?? RELEASED;
        const now = pressState(frame, was);
        seen.set(key, now);
        const entry = claims.get(key);
        if (!entry && freshPress(was, now) && hasFocus()) {
          const slot = freeSlot();
          if (slot >= 0) {
            const claim: ClaimEntry = {
              key,
              index,
              id,
              slot,
              state: "pending",
              exclusive: manager !== null,
              release: null,
            };
            claims.set(key, claim);
            request(claim);
          }
        }
        const claim = claims.get(key);
        if (claim?.state === "held" && !slots.has(claim.slot))
          slots.set(claim.slot, frame);
      }
      return slots;
    },
    consumed() {
      const slots = granted;
      granted = [];
      return slots;
    },
    forget(index, id) {
      const entry = claims.get(keyOf(index, id));
      if (entry) drop(entry);
      seen.delete(keyOf(index, id));
    },
    claims() {
      return [...claims.values()]
        .map(({ index, id, slot, state, exclusive }) => ({
          index,
          id,
          slot,
          state,
          exclusive,
        }))
        .sort((a, b) => a.slot - b.slot);
    },
    dispose() {
      for (const entry of [...claims.values()]) drop(entry);
      disposed = true;
      seen.clear();
      granted = [];
    },
  };
}

// --- environment defaults -----------------------------------------------------------------------

interface BrowserGlobals {
  navigator?: {
    getGamepads?: () => ArrayLike<GamepadSnapshot | null | undefined>;
    locks?: GamepadLockManager;
  };
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  window?: GamepadEventTarget;
  document?: GamepadVisibilitySource & { hasFocus?: () => boolean };
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

function defaultLocks(): GamepadLockManager | null {
  const locks = browser.navigator?.locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

function defaultHasFocus(): () => boolean {
  const doc = browser.document;
  return () =>
    typeof doc?.hasFocus === "function" ? doc.hasFocus() !== false : true;
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
  const mode = options.pads ?? "claim";
  const policy: SlotPolicy =
    mode === "merge"
      ? mergePolicy
      : mode === "each"
        ? eachPolicy(maxSlots)
        : claimPolicy(
            maxSlots,
            options.hasFocus ?? defaultHasFocus(),
            options.locks === undefined ? defaultLocks() : options.locks,
          );
  const minAxisIntervalMs =
    options.maxHz !== undefined && options.maxHz > 0 ? 1000 / options.maxHz : 0;

  /** What the host has been told, per present slot. */
  const sent = new Map<number, SlotFrame>();
  /** Controls ignored until released (neutralized at start, claiming presses). */
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
      usable.push({
        pad,
        index,
        id: typeof pad.id === "string" ? pad.id : "",
        frame: readStandard(view),
      });
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
    // Assigned even when empty, so a claim sees its pad leave.
    const next = policy.assign(pads);
    if (pads.length === 0) {
      // Nothing to read: release what the vanished pads held and park until `gamepadconnected`.
      // Chrome lists no pad before a gesture, so a pending neutralize waits for the first one.
      releaseAll();
      return;
    }
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
  const onDisconnect = (event: { type: string }): void => {
    const pad = (event as { gamepad?: GamepadSnapshot } | undefined)?.gamepad;
    // Drops a claim at once, also while hidden (no poll would notice the pad leaving).
    if (pad && typeof pad.index === "number")
      policy.forget?.(pad.index, typeof pad.id === "string" ? pad.id : "");
    schedule();
  };
  const onVisibility = (): void => {
    if (visible()) schedule();
    else {
      stop();
      releaseAll();
    }
  };

  if (live) {
    events?.addEventListener("gamepadconnected", onPadEvent);
    events?.addEventListener("gamepaddisconnected", onDisconnect);
    visibility?.addEventListener("visibilitychange", onVisibility);
    // A pad the page already knows (a reload with the pad awake) fires no new event.
    if (usablePads().length > 0) schedule();
  }

  return {
    heldState(): InputHeldState[] {
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
    claims() {
      return policy.claims?.() ?? [];
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      if (live) {
        events?.removeEventListener("gamepadconnected", onPadEvent);
        events?.removeEventListener("gamepaddisconnected", onDisconnect);
        visibility?.removeEventListener("visibilitychange", onVisibility);
      }
      releaseAll();
      policy.dispose();
    },
  };
}
