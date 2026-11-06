// Browser pointer capture -> gsw-input/1 mouse, touch and wheel records (docs/input.md "Pointer"),
// exported as `@godot-scene-web/input/pointer`. Mouse and pen always become `mouse_motion` /
// `mouse_button`. In `mode: "native"` (default) touch becomes `screen_touch` / `screen_drag`, and
// the host's own `emulate_mouse_from_touch` serves mouse-only UI exactly as on a real phone; in
// `mode: "mouse"` touch is translated into mouse gestures by `pointer-mouse-mode.ts`, which drives
// the record primitives below and never pushes a record itself.
//
// COORDINATES ARE THE CALLER'S. `map(clientX, clientY)` turns a DOM client point into host
// root-window px or `null` (letterbox, off picture). A press that maps to `null` never starts; a
// release always goes out, at the last mapped point when the release itself maps to `null`.
//
// EDGES COME FROM POINTER EVENTS ONLY. A second mouse button pressed during a hold arrives as a
// `pointermove` with a changed `buttons` mask, so every mouse/pen event diffs `buttons` against
// what that pointer last reported; `click`/`auxclick`/`mousedown` are never edges. Every path that
// can end a press without its pointerup releases it: `pointercancel`, `lostpointercapture` while
// still held, window blur, the tab hidden, `pagehide`, `enabled()` turning false and dispose
// (mouse buttons with `canceled: true` at the last point, touches `canceled: true`).
//
// MOTION IS COALESCED to one `mouse_motion` (and one `screen_drag` per touch) per animation frame
// with `relative` summed, and is flushed before any edge so a fast move-then-press presses at the
// right place.
//
// TARGETS (`targets: "press" | "all"` with `resolveTarget`, docs/input.md "Pointer targets")
// live in pointer-targets.ts; this file only calls `stampTarget` where a record goes out, and
// hands mouse mode a stamping hook for its synthetic presses. With targets "off" (default) no
// table exists, no resolver runs and no record carries target fields.
//
// DOM-free types: the package typechecks without DOM libraries, so the browser objects are read
// through the structural interfaces below, which the real `HTMLElement`, `window`, `document`,
// `PointerEvent` and `WheelEvent` satisfy. Listener params are `(event: { type: string }) => void`:
// a `never` param would reject the real objects in a DOM-lib consumer.

import type {
  InputRecord,
  InputVec2,
  MagnifyGestureRecord,
  MouseButtonRecord,
  MouseMotionRecord,
  ScreenDragRecord,
  ScreenTouchRecord,
} from "./format";
import { MouseButton } from "./godot-enums";
import type { PointerMap, PointerPoint } from "./pointer-map";
import {
  createMouseMode,
  type MouseMode,
  type PointerGestureOptions,
} from "./pointer-mouse-mode";
import {
  createPointerTargetTable,
  type PointerTargetResolver,
  type PointerTargetStamp,
} from "./pointer-targets";
// Type-only: the subpath bundle must not pull the session (and through it the codec) in.
import type { InputHeldState, InputSink, InputSyncSource } from "./session";

type Listener = (event: { type: string }) => void;

/** The fields of a DOM `PointerEvent` the capture reads. */
export interface PointerEventLike {
  type: string;
  pointerId: number;
  /** `"mouse"`, `"pen"` or `"touch"`; anything else is read as a mouse. */
  pointerType: string;
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  detail?: number;
  movementX?: number;
  movementY?: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  preventDefault?(): void;
  getCoalescedEvents?(): readonly PointerEventLike[];
}

/** The fields of a DOM `WheelEvent` the capture reads. */
export interface WheelEventLike {
  type: string;
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
  /** 0 pixel, 1 line, 2 page. */
  deltaMode: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  preventDefault?(): void;
}

/** An event target (`window`, `document`). */
export interface PointerEventTargetLike {
  addEventListener(
    type: string,
    listener: (event: { type: string }) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: { type: string }) => void,
  ): void;
}

/** The page-visibility source (`document`), which also says who holds the pointer lock. */
export interface PointerVisibilitySource extends PointerEventTargetLike {
  visibilityState?: string;
  pointerLockElement?: unknown;
}

/** The element the game is drawn on (a `<canvas>`, `<video>` or its wrapper). */
export interface PointerStageLike {
  addEventListener(
    type: string,
    listener: (event: { type: string }) => void,
    options?: { passive?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: (event: { type: string }) => void,
  ): void;
  setPointerCapture?(pointerId: number): void;
  focus?(options?: { preventScroll?: boolean }): void;
  requestPointerLock?(): unknown;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  style?: { touchAction: string };
}

/** Why an event was not forwarded. */
export type PointerDropReason =
  | "inactive"
  | "off-picture"
  | "max-touches"
  | "pinch"
  | "unmapped-button"
  | "extra-touch"
  | "intercepted"
  | "button-held";

export interface PointerCaptureStats {
  /** `mouse_motion` records pushed. */
  motions: number;
  /** `mouse_button` presses pushed (wheel steps excluded). */
  presses: number;
  /** `mouse_button` releases pushed, including cancels (wheel steps excluded). */
  releases: number;
  /** Wheel press+release pairs pushed. */
  wheels: number;
  /** `screen_touch` records pushed (presses and releases). */
  touches: number;
  /** `screen_drag` records pushed. */
  drags: number;
  /** `magnify_gesture` records pushed. */
  magnifies: number;
  /** Presses, wheels and gestures not forwarded, by reason. */
  dropped: Record<PointerDropReason, number>;
  /** `resolveTarget` calls (0 with targets off). */
  resolves: number;
  /** `target` declarations pushed, `heldState()`'s included. */
  declarations: number;
}

/**
 * `"native"`: touch is `screen_touch` / `screen_drag`. `"mouse"`: touch is translated into mouse
 * gestures (docs/input.md "Mouse mode"); mouse and pen are the same in both.
 */
export type PointerCaptureMode = "native" | "mouse";

/**
 * `"off"`: no resolver, no target bytes. `"press"`: one resolve per press, release and wheel
 * event. `"all"`: also one per coalesced motion record (at most one per animation frame).
 */
export type PointerTargetsMode = "off" | "press" | "all";

export interface PointerCaptureOptions {
  /** The element the game is drawn on: listened on, captured to, focused. */
  stage: PointerStageLike;
  /** DOM client px -> host root-window px, or `null` off picture (see `objectFitMapper`). */
  map: PointerMap;
  /** Where records go: a session, or a consumer's own adapter. */
  sink: InputSink;
  /** `"native"` (default) or `"mouse"` (touch -> mouse gestures). */
  mode?: PointerCaptureMode;
  /** `mode: "mouse"` tuning and hooks (`intercept`, `onGesture`); ignored in native mode. */
  gestures?: PointerGestureOptions;
  /** `"off"` (default): no resolver calls, no target fields. Others need `resolveTarget`. */
  targets?: PointerTargetsMode;
  /**
   * Which node a client point is over (docs/input.md "Pointer targets"): render-stream-client's
   * `pointerTargetResolver`, html's `htmlPointerTargetResolver`, or a product's own. Called with
   * the event's client point and its mapped host point; never while the pointer is locked.
   */
  resolveTarget?: PointerTargetResolver;
  /**
   * Read live, per press, so a flip lands on the next press (default: always on). Turning it off
   * releases anything held on the next `refresh()`.
   */
  enabled?: () => boolean;
  /** Where `blur`/`pagehide` (and a fallback `pointerup`) are heard (default `window`; null: none). */
  events?: PointerEventTargetLike | null;
  /** Where `visibilitychange` is heard and the pointer lock is read (default `document`). */
  visibility?: PointerVisibilitySource | null;
  /** Set the stage's `touch-action: none` so touches are not page pans or zooms (default true). */
  touchAction?: boolean;
  /** Suppress the browser context menu on the stage (default true). */
  contextMenu?: boolean;
  /**
   * Focus the stage on every press (default true). The press's `preventDefault` cancels the
   * browser's own focus move, and a form control left focused would keep the keyboard capture's
   * text-entry guard engaged; give the keyboard capture this element as its `stage`. A stage with
   * no `tabindex` gets `tabindex="-1"` (removed on dispose).
   */
  focus?: boolean;
  /**
   * Ctrl+wheel (a trackpad pinch) is always prevented so the page does not zoom. `"drop"`
   * (default) forwards nothing; `"magnify"` sends `magnify_gesture` (host-gated kind).
   */
  pinch?: "drop" | "magnify";
  /**
   * Request pointer lock on press (default false). While the stage holds the lock, mouse
   * `relative` comes from `movementX/Y` (scaled through `map`) and `position` stays at the lock
   * point.
   */
  pointerLock?: boolean;
  /**
   * Send every `getCoalescedEvents()` sample as its own motion/drag record instead of one per
   * animation frame (default false; for high-rate drawing).
   */
  coalescedEvents?: boolean;
  /** Frame scheduler for motion coalescing (default `requestAnimationFrame`; none: no coalescing). */
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  /** Clock for the double-click rule, ms (default `performance.now`). */
  now?: () => number;
}

export interface PointerCapture extends InputSyncSource {
  /**
   * The `pointer` scope (a session's `InputSyncSource`): the last mouse position as a
   * `mouse_motion`, then held mouse buttons in press order (each with the mask after it), then
   * active touches by index, all at their last points. Fresh objects.
   */
  heldState(): readonly InputHeldState[];
  /**
   * Push one `mouse_motion` to `position` (host px) now, pending motion first. For gesture hooks
   * and product UI (a tap-to-focus hover). False, and nothing sent, while inactive. With targets
   * "all", `client` (the DOM client point it stands for) is resolved as a motion's would be;
   * without it the record carries no target.
   */
  hover(position: InputVec2, client?: InputVec2): boolean;
  /**
   * Push a press+release pair of `button` (a `MouseButton`; wheel buttons go as one wheel step)
   * at `position`, without a motion first. False, and nothing sent, while inactive or while that
   * button is held. With targets on, `client` is resolved once for the pair, as a press's would
   * be; without it the records carry no target.
   */
  click(button: number, position: InputVec2, client?: InputVec2): boolean;
  /** Push pending coalesced motion now. */
  flush(): void;
  /** Re-read `enabled()`: off releases everything held. Cheap and idempotent. */
  refresh(): void;
  /** Release every held button and cancel every touch now. */
  releaseAll(): void;
  /** Drop every listener, release anything held, and undo the stage attributes it set. */
  dispose(): void;
  stats(): PointerCaptureStats;
}

/** Godot web's per-`deltaMode` wheel factors (display_server_web.cpp:667-686). */
const WHEEL_FACTOR: readonly number[] = [0.03, 0.3, 1.0];
/** Largest touch index + 1 (`screen_touch.index` 0..31). */
const MAX_TOUCHES = 32;
/** The codec's coordinate bound. */
const COORD_LIMIT = 1_000_000;
/** Godot web's double-click rule (display_server_web.cpp:263-280): 400 ms, < 5 px, same button. */
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 5;

/** DOM `buttons` bits -> Godot buttons. Bit 32 is the pen eraser, a LEFT contact. */
const BUTTON_BITS: readonly (readonly [number, number])[] = [
  [1, MouseButton.LEFT],
  [32, MouseButton.LEFT],
  [2, MouseButton.RIGHT],
  [4, MouseButton.MIDDLE],
  [8, MouseButton.XBUTTON1],
  [16, MouseButton.XBUTTON2],
];
/** Godot buttons in edge order (ascending index). */
const MOUSE_BUTTONS: readonly number[] = [
  MouseButton.LEFT,
  MouseButton.RIGHT,
  MouseButton.MIDDLE,
  MouseButton.XBUTTON1,
  MouseButton.XBUTTON2,
];

/** The `held` owner of a press made through `click()` (never a real pointerId). */
const HOOK_OWNER = -0x7fff_ffff;

const bit = (button: number) => 1 << (button - 1);
const wheelScale = (event: { deltaMode: number }) =>
  WHEEL_FACTOR[event.deltaMode] ?? 0.03;

/** The Godot buttons a DOM `buttons` mask holds, as a Godot mask. */
function godotMask(buttons: number): number {
  let mask = 0;
  for (const [domBit, button] of BUTTON_BITS)
    if ((buttons & domBit) !== 0) mask |= bit(button);
  return mask;
}

const q2 = (v: number) => Math.round(v * 100) / 100 || 0;
const q4 = (v: number) => Math.round(v * 10_000) / 10_000 || 0;
const clampCoord = (v: number) =>
  Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v));
const clampUnit = (v: number) => Math.max(-1, Math.min(1, v));

type Vec = [number, number];

function point(p: PointerPoint): Vec {
  return [q2(clampCoord(p.x)), q2(clampCoord(p.y))];
}

interface Modifiers {
  shift_pressed?: true;
  ctrl_pressed?: true;
  alt_pressed?: true;
  meta_pressed?: true;
}

function modifiers(event: {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): Modifiers {
  const out: Modifiers = {};
  if (event.shiftKey === true) out.shift_pressed = true;
  if (event.ctrlKey === true) out.ctrl_pressed = true;
  if (event.altKey === true) out.alt_pressed = true;
  if (event.metaKey === true) out.meta_pressed = true;
  return out;
}

interface PendingMotion {
  relative: Vec;
  mods: Modifiers;
  pressure: number;
  tilt: Vec;
  inverted: boolean;
}

interface Touch {
  index: number;
  last: Vec;
  /** Summed relative of a pending drag, or null when none is pending. */
  pending: Vec | null;
  /** The last client point (a target resolve's input). */
  client: Vec;
  /** The target stamped on this touch's last record and where (targets on only). */
  target: { stamp: PointerTargetStamp; at: Vec } | null;
}

/** A record that may carry the target fields. */
interface TargetFieldsHolder {
  target?: number;
  local?: readonly [number, number];
  frame?: number;
}

const emptyDropped = (): Record<PointerDropReason, number> => ({
  inactive: 0,
  "off-picture": 0,
  "max-touches": 0,
  pinch: 0,
  "unmapped-button": 0,
  "extra-touch": 0,
  intercepted: 0,
  "button-held": 0,
});

/**
 * Create the pointer capture on `stage`. Listens at once; `dispose()` undoes everything.
 */
export function createPointerCapture(
  options: PointerCaptureOptions,
): PointerCapture {
  const g = globalThis as {
    window?: PointerEventTargetLike;
    document?: PointerVisibilitySource;
    requestAnimationFrame?: (callback: (time: number) => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
    performance?: { now(): number };
  };
  const mode = options.mode ?? "native";
  if (mode !== "native" && mode !== "mouse")
    throw new Error(`createPointerCapture: unsupported mode ${String(mode)}`);
  const targets = options.targets ?? "off";
  if (targets !== "off" && targets !== "press" && targets !== "all")
    throw new Error(
      `createPointerCapture: unsupported targets ${String(targets)}`,
    );
  if (targets !== "off" && typeof options.resolveTarget !== "function")
    throw new Error(
      `createPointerCapture: targets "${targets}" needs resolveTarget`,
    );
  const { stage, map, sink } = options;
  const enabled = options.enabled ?? (() => true);
  const events = options.events === undefined ? g.window : options.events;
  const visibility =
    options.visibility === undefined ? g.document : options.visibility;
  const pinch = options.pinch ?? "drop";
  const pointerLock = options.pointerLock ?? false;
  const everySample = options.coalescedEvents ?? false;
  const focusStage = options.focus ?? true;
  const raf =
    options.requestAnimationFrame ??
    (typeof g.requestAnimationFrame === "function"
      ? (cb: (time: number) => void) => g.requestAnimationFrame?.(cb) ?? 0
      : null);
  const cancelRaf =
    options.cancelAnimationFrame ??
    (typeof g.cancelAnimationFrame === "function"
      ? (handle: number) => g.cancelAnimationFrame?.(handle)
      : null);
  const now =
    options.now ?? (() => (g.performance ? g.performance.now() : Date.now()));

  const stats: PointerCaptureStats = {
    motions: 0,
    presses: 0,
    releases: 0,
    wheels: 0,
    touches: 0,
    drags: 0,
    magnifies: 0,
    dropped: emptyDropped(),
    resolves: 0,
    declarations: 0,
  };

  // Mouse and pen share Godot's one mouse.
  /** Last mouse position sent or pending, host px. */
  let mousePos: Vec | null = null;
  /** Godot mask each mouse/pen pointer last reported (from DOM `buttons`). */
  const reported = new Map<number, number>();
  /** Mouse/pen pointers whose buttons went down on the stage (only those press on a move). */
  const pressedHere = new Set<number>();
  /** Held Godot button -> the pointer that pressed it. Map order is press order. */
  const held = new Map<number, number>();
  let pending: PendingMotion | null = null;
  const touches = new Map<number, Touch>();
  let rafHandle: number | null = null;
  const wheelAcc: Vec = [0, 0];
  let lastClick: { button: number; at: number; pos: Vec } | null = null;
  let disposed = false;
  /** The last mouse client point (a target resolve's input). */
  const mouseClient: Vec = [0, 0];
  /** The target stamped on the last mouse record and the position it was resolved at. */
  let mouseTarget: { stamp: PointerTargetStamp; at: Vec } | null = null;
  const table =
    targets === "off" || !options.resolveTarget
      ? null
      : createPointerTargetTable(
          options.resolveTarget,
          (record) => sink.push(record),
          (handle) =>
            mouseTarget?.stamp.target === handle ||
            [...touches.values()].some(
              (t) => t.target?.stamp.target === handle,
            ),
        );
  const motionTargets = targets === "all";

  /**
   * Resolve the node under `client` and stamp `record` (pushing a declaration first when the
   * handle is new this epoch). A no-op with targets off or while the pointer is locked.
   */
  function stampTarget(
    record: TargetFieldsHolder,
    client: Vec,
    at: Vec,
  ): PointerTargetStamp | null {
    if (!table || locked()) return null;
    const stamp = table.resolve(client[0], client[1], at);
    if (stamp) Object.assign(record, stamp);
    return stamp;
  }

  const heldMask = () => {
    let mask = 0;
    for (const button of held.keys()) mask |= bit(button);
    return mask;
  };
  const drop = (reason: PointerDropReason) => {
    stats.dropped[reason]++;
  };
  const pageVisible = () => visibility?.visibilityState !== "hidden";
  const active = () => !disposed && enabled() !== false && pageVisible();
  const locked = () =>
    pointerLock &&
    visibility?.pointerLockElement != null &&
    visibility.pointerLockElement === stage;

  /** A hook's optional client point, when finite. */
  function hookClient(p: InputVec2 | undefined): Vec | undefined {
    return p && Number.isFinite(p[0]) && Number.isFinite(p[1])
      ? [p[0], p[1]]
      : undefined;
  }

  function hookPoint(p: InputVec2): Vec | null {
    return Number.isFinite(p[0]) && Number.isFinite(p[1])
      ? point({ x: p[0], y: p[1] })
      : null;
  }

  function mapEvent(event: { clientX: number; clientY: number }): Vec | null {
    const p = map(event.clientX, event.clientY);
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? point(p) : null;
  }

  // ---- motion coalescing ----

  function schedule(): void {
    if (everySample || !raf) {
      flushMotion();
      return;
    }
    if (rafHandle === null)
      rafHandle = raf(() => {
        rafHandle = null;
        flushMotion();
      });
  }

  function flushMotion(): void {
    if (pending && mousePos) {
      const m = pending;
      pending = null;
      const record: MouseMotionRecord = {
        event: "mouse_motion",
        position: [...mousePos],
      };
      const relative: Vec = [q2(m.relative[0]), q2(m.relative[1])];
      if (relative[0] !== 0 || relative[1] !== 0) record.relative = relative;
      const mask = heldMask();
      if (mask !== 0) record.button_mask = mask;
      if (m.pressure > 0) record.pressure = m.pressure;
      if (m.tilt[0] !== 0 || m.tilt[1] !== 0) record.tilt = m.tilt;
      if (m.inverted) record.pen_inverted = true;
      Object.assign(record, m.mods);
      if (motionTargets) {
        const stamp = stampTarget(record, mouseClient, mousePos);
        mouseTarget = stamp ? { stamp, at: [...mousePos] } : null;
      }
      stats.motions++;
      sink.push(record);
    }
    pending = null;
    for (const touch of touches.values()) {
      if (!touch.pending) continue;
      const relative: Vec = [q2(touch.pending[0]), q2(touch.pending[1])];
      touch.pending = null;
      const record: ScreenDragRecord = {
        event: "screen_drag",
        position: [...touch.last],
      };
      if (touch.index !== 0) record.index = touch.index;
      if (relative[0] !== 0 || relative[1] !== 0) record.relative = relative;
      if (motionTargets) {
        const stamp = stampTarget(record, touch.client, touch.last);
        touch.target = stamp ? { stamp, at: [...touch.last] } : null;
      }
      stats.drags++;
      sink.push(record);
    }
  }

  /** Movement px -> host px through `map`, measured around the lock point. */
  function movementScale(cx: number, cy: number): Vec {
    const a = map(cx, cy);
    if (!a) return [1, 1];
    const right = map(cx + 1, cy);
    const left = right ? null : map(cx - 1, cy);
    const down = map(cx, cy + 1);
    const up = down ? null : map(cx, cy - 1);
    const sx = right ? right.x - a.x : left ? a.x - left.x : 1;
    const sy = down ? down.y - a.y : up ? a.y - up.y : 1;
    return [Number.isFinite(sx) ? sx : 1, Number.isFinite(sy) ? sy : 1];
  }

  function addMouseSample(sample: PointerEventLike, pen: boolean): void {
    let delta: Vec;
    if (locked() && mousePos) {
      const [sx, sy] = movementScale(sample.clientX, sample.clientY);
      delta = [(sample.movementX ?? 0) * sx, (sample.movementY ?? 0) * sy];
    } else {
      const p = mapEvent(sample);
      if (!p) return;
      mouseClient[0] = sample.clientX;
      mouseClient[1] = sample.clientY;
      const before = mousePos;
      delta = before ? [p[0] - before[0], p[1] - before[1]] : [0, 0];
      // A move that changes only `buttons` (a chord) is an edge, not a motion; a pen's pressure
      // or tilt change still is one.
      if (before && !pending && !pen && delta[0] === 0 && delta[1] === 0)
        return;
      mousePos = p;
    }
    const m: PendingMotion = pending ?? {
      relative: [0, 0],
      mods: {},
      pressure: 0,
      tilt: [0, 0],
      inverted: false,
    };
    m.relative[0] += delta[0];
    m.relative[1] += delta[1];
    m.mods = modifiers(sample);
    if (pen) {
      m.pressure = q4(Math.max(0, Math.min(1, sample.pressure ?? 0)));
      m.tilt = [
        q4(clampUnit((sample.tiltX ?? 0) / 90)),
        q4(clampUnit((sample.tiltY ?? 0) / 90)),
      ];
      m.inverted = (sample.buttons & 32) !== 0;
    }
    pending = m;
  }

  // ---- mouse buttons ----

  function doubleClick(event: PointerEventLike, button: number, at: Vec) {
    // Browsers report `detail` 0 on pointerdown (Chromium 148 measured); use it when one does not.
    if (typeof event.detail === "number" && event.detail > 0) {
      lastClick = null;
      return event.detail === 2;
    }
    const t = now();
    const last = lastClick;
    if (
      last &&
      last.button === button &&
      t - last.at < DOUBLE_CLICK_MS &&
      Math.hypot(at[0] - last.pos[0], at[1] - last.pos[1]) < DOUBLE_CLICK_PX
    ) {
      lastClick = null;
      return true;
    }
    lastClick = { button, at: t, pos: at };
    return false;
  }

  function release(
    button: number,
    at: Vec,
    mods: Modifiers,
    canceled: boolean,
    client: Vec | null = null,
  ) {
    held.delete(button);
    const record: MouseButtonRecord = {
      event: "mouse_button",
      button_index: button,
      pressed: false,
      position: [...at],
    };
    const mask = heldMask();
    if (mask !== 0) record.button_mask = mask;
    if (canceled) record.canceled = true;
    Object.assign(record, mods);
    // A user release is resolved; a cancel the capture makes up is not.
    if (client) {
      const stamp = stampTarget(record, client, at);
      mouseTarget = stamp ? { stamp, at: [...at] } : null;
    }
    stats.releases++;
    sink.push(record);
  }

  /** Diff a mouse/pen pointer's `buttons` against what it last reported, and push the edges. */
  function diffButtons(event: PointerEventLike, at: Vec | null): void {
    const id = event.pointerId;
    const before = reported.get(id) ?? 0;
    const after = godotMask(event.buttons);
    if (after === 0) {
      reported.delete(id);
      pressedHere.delete(id);
    } else reported.set(id, after);
    if (before === after) return;
    const mods = modifiers(event);
    const client: Vec = [event.clientX, event.clientY];
    // Releases first, then presses, ascending.
    for (const button of MOUSE_BUTTONS) {
      const b = bit(button);
      if ((before & b) !== 0 && (after & b) === 0 && held.get(button) === id) {
        flushMotion();
        // Off picture the release goes at the last point, by its coordinate only.
        release(
          button,
          at ?? mousePos ?? [0, 0],
          mods,
          false,
          at ? client : null,
        );
      }
    }
    for (const button of MOUSE_BUTTONS) {
      const b = bit(button);
      if ((before & b) !== 0 || (after & b) === 0 || held.has(button)) continue;
      if (!active()) {
        drop("inactive");
        continue;
      }
      if (!at) {
        drop("off-picture");
        continue;
      }
      flushMotion();
      mousePos = at;
      held.set(button, id);
      const record: MouseButtonRecord = {
        event: "mouse_button",
        button_index: button,
        pressed: true,
        position: [...at],
        button_mask: heldMask(),
      };
      if (doubleClick(event, button, at)) record.double_click = true;
      Object.assign(record, mods);
      mouseClient[0] = client[0];
      mouseClient[1] = client[1];
      const stamp = stampTarget(record, client, at);
      mouseTarget = stamp ? { stamp, at: [...at] } : null;
      stats.presses++;
      sink.push(record);
    }
  }

  /** The point a mouse/pen event acts at: the lock point while locked. */
  function mousePoint(event: { clientX: number; clientY: number }): Vec | null {
    if (locked() && mousePos) return mousePos;
    return mapEvent(event);
  }

  // ---- touch ----

  function freeIndex(): number {
    const used = new Set<number>();
    for (const t of touches.values()) used.add(t.index);
    for (let i = 0; i < MAX_TOUCHES; i++) if (!used.has(i)) return i;
    return -1;
  }

  function touchRecord(touch: Touch, pressed: boolean, canceled: boolean) {
    const record: ScreenTouchRecord = {
      event: "screen_touch",
      pressed,
      position: [...touch.last],
    };
    if (touch.index !== 0) record.index = touch.index;
    if (canceled) record.canceled = true;
    else {
      const stamp = stampTarget(record, touch.client, touch.last);
      touch.target = stamp ? { stamp, at: [...touch.last] } : null;
    }
    stats.touches++;
    sink.push(record);
  }

  function endTouch(
    id: number,
    at: Vec | null,
    canceled: boolean,
    client: Vec | null = null,
  ): void {
    const touch = touches.get(id);
    if (!touch) return;
    flushMotion();
    if (at && !canceled) touch.last = at;
    if (client && at && !canceled) touch.client = client;
    touches.delete(id);
    touchRecord(touch, false, canceled);
  }

  // ---- mouse mode: record primitives the gesture module drives ----

  /** Targets: remember the client point a mouse-mode record stands for. */
  function setMouseClient(client: Vec | undefined): void {
    if (!client) return;
    mouseClient[0] = client[0];
    mouseClient[1] = client[1];
  }

  /** One `mouse_motion` at `at` now, after any pending motion (`client`: resolved in "all"). */
  function hoverAt(at: Vec, client?: Vec): void {
    flushMotion();
    const record: MouseMotionRecord = {
      event: "mouse_motion",
      position: [...at],
    };
    if (mousePos) {
      const relative: Vec = [q2(at[0] - mousePos[0]), q2(at[1] - mousePos[1])];
      if (relative[0] !== 0 || relative[1] !== 0) record.relative = relative;
    }
    const mask = heldMask();
    if (mask !== 0) record.button_mask = mask;
    mousePos = at;
    setMouseClient(client);
    if (motionTargets && client) {
      const stamp = stampTarget(record, client, at);
      mouseTarget = stamp ? { stamp, at: [...at] } : null;
    }
    stats.motions++;
    sink.push(record);
  }

  /** Coalesced motion to `at`, as a mouse drag's. */
  function dragTo(at: Vec, client?: Vec): void {
    const before = mousePos;
    mousePos = at;
    setMouseClient(client);
    const m: PendingMotion = pending ?? {
      relative: [0, 0],
      mods: {},
      pressure: 0,
      tilt: [0, 0],
      inverted: false,
    };
    if (before) {
      m.relative[0] += at[0] - before[0];
      m.relative[1] += at[1] - before[1];
    }
    pending = m;
    schedule();
  }

  function pressBy(
    button: number,
    at: Vec,
    owner: number,
    double: boolean,
    client?: Vec,
  ): boolean {
    if (!active()) {
      drop("inactive");
      return false;
    }
    if (held.has(button)) {
      drop("button-held");
      return false;
    }
    flushMotion();
    mousePos = at;
    held.set(button, owner);
    const record: MouseButtonRecord = {
      event: "mouse_button",
      button_index: button,
      pressed: true,
      position: [...at],
      button_mask: heldMask(),
    };
    if (double) record.double_click = true;
    if (client) {
      setMouseClient(client);
      const stamp = stampTarget(record, client, at);
      mouseTarget = stamp ? { stamp, at: [...at] } : null;
    }
    stats.presses++;
    sink.push(record);
    return true;
  }

  function releaseBy(
    button: number,
    at: Vec,
    owner: number,
    canceled: boolean,
    client?: Vec,
  ): void {
    if (held.get(button) !== owner) return;
    flushMotion();
    if (!canceled) mousePos = at;
    release(button, at, {}, canceled, canceled ? null : (client ?? null));
  }

  function clickAt(button: number, at: Vec, client?: Vec): boolean {
    if (!active()) {
      drop("inactive");
      return false;
    }
    if (button >= MouseButton.WHEEL_UP && button <= MouseButton.WHEEL_RIGHT) {
      flushMotion();
      mousePos = at;
      let target: PointerTargetStamp | null = null;
      if (client) {
        target = stampTarget({}, client, at);
        if (target) mouseTarget = { stamp: target, at: [...at] };
      }
      pushWheel(button, 1, at, {}, target);
      return true;
    }
    if (!pressBy(button, at, HOOK_OWNER, false, client)) return false;
    releaseBy(button, at, HOOK_OWNER, false, client);
    return true;
  }

  const mouseMode: MouseMode | null =
    mode === "mouse"
      ? createMouseMode(
          {
            map: (x, y) => mapEvent({ clientX: x, clientY: y }),
            scaleAt: movementScale,
            active,
            drop,
            capturePointer,
            hover: hoverAt,
            drag: dragTo,
            press: pressBy,
            release: releaseBy,
            click: clickAt,
            now,
          },
          options.gestures,
        )
      : null;

  // ---- listeners ----

  const isTouch = (event: PointerEventLike) => event.pointerType === "touch";
  const isPen = (event: PointerEventLike) => event.pointerType === "pen";

  function capturePointer(id: number): void {
    try {
      stage.setPointerCapture?.(id);
    } catch {
      // Not an active pointer any more (a synthetic or already-released one): nothing to keep.
    }
  }

  function onPointerDown(raw: { type: string }): void {
    const event = raw as PointerEventLike;
    if (disposed) return;
    // Cancels text selection, middle-button autoscroll and the compat mouse events (and with them
    // the browser's own focus move, so focus is handed over by hand).
    event.preventDefault?.();
    if (focusStage) stage.focus?.({ preventScroll: true });
    if (isTouch(event) && mouseMode) {
      mouseMode.down(event.pointerId, event.clientX, event.clientY);
      return;
    }
    if (isTouch(event)) {
      if (touches.has(event.pointerId)) return;
      if (!active()) {
        drop("inactive");
        return;
      }
      const at = mapEvent(event);
      if (!at) {
        drop("off-picture");
        return;
      }
      const index = freeIndex();
      if (index < 0) {
        drop("max-touches");
        return;
      }
      flushMotion();
      const touch: Touch = {
        index,
        last: at,
        pending: null,
        client: [event.clientX, event.clientY],
        target: null,
      };
      touches.set(event.pointerId, touch);
      capturePointer(event.pointerId);
      touchRecord(touch, true, false);
      return;
    }
    if (event.button > 5) drop("unmapped-button");
    pressedHere.add(event.pointerId);
    const at = mousePoint(event);
    diffButtons(event, at);
    if (held.size > 0) capturePointer(event.pointerId);
    if (pointerLock && held.size > 0 && !locked()) {
      try {
        const request = stage.requestPointerLock?.() as
          | { catch?: (f: () => void) => unknown }
          | undefined;
        request?.catch?.(() => {});
      } catch {
        // Lock refused (no user activation, sandboxed frame): motion stays absolute.
      }
    }
  }

  function onPointerMove(raw: { type: string }): void {
    const event = raw as PointerEventLike;
    if (disposed) return;
    const samples =
      everySample && typeof event.getCoalescedEvents === "function"
        ? event.getCoalescedEvents()
        : [];
    const list = samples.length > 0 ? samples : [event];
    if (isTouch(event) && mouseMode) {
      for (const sample of list)
        mouseMode.move(event.pointerId, sample.clientX, sample.clientY);
      return;
    }
    if (isTouch(event)) {
      const touch = touches.get(event.pointerId);
      if (!touch) return;
      for (const sample of list) {
        const at = mapEvent(sample);
        if (!at) continue;
        touch.client = [sample.clientX, sample.clientY];
        const rel = touch.pending ?? [0, 0];
        rel[0] += at[0] - touch.last[0];
        rel[1] += at[1] - touch.last[1];
        touch.pending = rel;
        touch.last = at;
        if (everySample) flushMotion();
      }
      schedule();
      return;
    }
    // Hover only while active; a held button's drag always reports.
    if (active() || held.size > 0) {
      for (const sample of list) {
        addMouseSample(sample, isPen(event));
        if (everySample) flushMotion();
      }
      if (pending) schedule();
    }
    const id = event.pointerId;
    const mask = godotMask(event.buttons);
    if (mask === (reported.get(id) ?? 0)) return;
    if (!pressedHere.has(id)) {
      // Buttons that went down elsewhere on the page and were dragged in: never a press here.
      if (mask === 0) reported.delete(id);
      else reported.set(id, mask);
      return;
    }
    flushMotion();
    diffButtons(event, mousePoint(event));
  }

  function onPointerUp(raw: { type: string }): void {
    const event = raw as PointerEventLike;
    if (disposed) return;
    // X1/X2 navigate history on mouseup unless prevented.
    event.preventDefault?.();
    if (isTouch(event) && mouseMode) {
      mouseMode.up(event.pointerId, event.clientX, event.clientY);
      return;
    }
    if (isTouch(event)) {
      endTouch(event.pointerId, mapEvent(event), false, [
        event.clientX,
        event.clientY,
      ]);
      return;
    }
    diffButtons(event, mousePoint(event));
  }

  /** Does this pointer hold anything the capture owes a release for? */
  function tracked(id: number): boolean {
    return (
      touches.has(id) ||
      mouseMode?.tracks(id) === true ||
      [...held.values()].includes(id)
    );
  }

  // The window copy: only a pointer the stage pressed and has not released yet (its pointerup
  // missed the stage), so the rest of the page keeps its own pointerup defaults.
  function onWindowPointerUp(raw: { type: string }): void {
    if (tracked((raw as PointerEventLike).pointerId)) onPointerUp(raw);
  }

  function cancelPointer(id: number): void {
    if (mouseMode?.tracks(id)) {
      mouseMode.cancel(id);
      return;
    }
    if (touches.has(id)) {
      endTouch(id, null, true);
      return;
    }
    reported.delete(id);
    pressedHere.delete(id);
    const owned = [...held].filter(([, owner]) => owner === id);
    if (owned.length > 0) flushMotion();
    for (const [button] of owned) release(button, mousePos ?? [0, 0], {}, true);
  }

  function onPointerCancel(raw: { type: string }): void {
    if (disposed) return;
    cancelPointer((raw as PointerEventLike).pointerId);
  }

  // A capture lost without a pointerup (the stage left the DOM, another element took it): the
  // release would never reach us. After a normal pointerup nothing is held, so this is a no-op.
  function onLostCapture(raw: { type: string }): void {
    if (disposed) return;
    const id = (raw as PointerEventLike).pointerId;
    if (tracked(id)) cancelPointer(id);
  }

  function pushWheel(
    button: number,
    factor: number,
    at: Vec,
    mods: Modifiers,
    target: PointerTargetStamp | null,
  ) {
    const mask = heldMask();
    const press: MouseButtonRecord = {
      event: "mouse_button",
      button_index: button,
      pressed: true,
      position: [...at],
      button_mask: mask | bit(button),
    };
    if (factor !== 1) press.factor = factor;
    Object.assign(press, mods);
    if (target) Object.assign(press, target);
    const rel: MouseButtonRecord = { ...press, pressed: false };
    if (mask !== 0) rel.button_mask = mask;
    else delete rel.button_mask;
    stats.wheels++;
    sink.push(press);
    sink.push(rel);
  }

  function onWheel(raw: { type: string }): void {
    const event = raw as WheelEventLike;
    if (disposed) return;
    if (event.ctrlKey === true) {
      // A trackpad pinch (or Ctrl+wheel): never a page zoom.
      event.preventDefault?.();
      const at = active() ? mousePoint(event) : null;
      if (pinch !== "magnify" || !at || event.deltaY === 0) {
        drop("pinch");
        return;
      }
      // Pinch-out (deltaY < 0) zooms in: factor > 1, 1% per pixel-mode delta unit.
      const factor = q4(
        Math.min(10_000, Math.exp((-event.deltaY * wheelScale(event)) / 3)),
      );
      flushMotion();
      const record: MagnifyGestureRecord = {
        event: "magnify_gesture",
        position: [...at],
      };
      if (factor !== 1) record.factor = factor;
      Object.assign(record, modifiers(event));
      stats.magnifies++;
      sink.push(record);
      return;
    }
    if (!active()) {
      drop("inactive");
      return;
    }
    const at = mousePoint(event);
    if (!at) {
      drop("off-picture");
      return;
    }
    event.preventDefault?.();
    const scale = wheelScale(event);
    // Accumulate in factor units and send what reaches the 1e-4 quantum: a trackpad's sub-pixel
    // deltas add up instead of rounding away.
    wheelAcc[0] += (Number.isFinite(event.deltaX) ? event.deltaX : 0) * scale;
    wheelAcc[1] += (Number.isFinite(event.deltaY) ? event.deltaY : 0) * scale;
    const mods = modifiers(event);
    flushMotion();
    // One resolve per wheel event, made at its first step; every step shares it.
    let target: PointerTargetStamp | null | undefined;
    // Vertical first, as Godot web prefers it; then horizontal. deltaX > 0 -> WHEEL_RIGHT
    // (native Godot, not Godot web; docs/input.md "Wheel").
    for (const axis of [1, 0] as const) {
      const value = wheelAcc[axis];
      // The epsilon keeps float noise (0.3 * 3 = 0.8999…) from truncating a whole quantum away.
      const step =
        Math.trunc(value * 10_000 + Math.sign(value) * 1e-6) / 10_000;
      if (step === 0) continue;
      wheelAcc[axis] = value - step;
      const button =
        axis === 1
          ? step < 0
            ? MouseButton.WHEEL_UP
            : MouseButton.WHEEL_DOWN
          : step < 0
            ? MouseButton.WHEEL_LEFT
            : MouseButton.WHEEL_RIGHT;
      const factor = Math.min(10_000, q4(Math.abs(step)));
      if (Math.abs(step) > 10_000) wheelAcc[axis] = 0;
      if (target === undefined) {
        const probe: TargetFieldsHolder = {};
        target = stampTarget(probe, [event.clientX, event.clientY], at);
        if (target) mouseTarget = { stamp: target, at: [...at] };
      }
      pushWheel(button, factor, at, mods, target);
    }
  }

  function onAuxClick(raw: { type: string }): void {
    // Edges come from pointer events; this only keeps X1/X2 from navigating history.
    (raw as PointerEventLike).preventDefault?.();
  }

  function onContextMenu(raw: { type: string }): void {
    (raw as PointerEventLike).preventDefault?.();
  }

  function releaseAll(): void {
    mouseMode?.cancelAll();
    flushMotion();
    for (const id of [...touches.keys()]) endTouch(id, null, true);
    for (const button of [...held.keys()])
      release(button, mousePos ?? [0, 0], {}, true);
    // Keep `reported`: a button still physically down must not re-press when the pointer moves.
    wheelAcc[0] = 0;
    wheelAcc[1] = 0;
  }

  const onBlur = (): void => releaseAll();
  const onPageHide = (): void => releaseAll();
  const onVisibility = (): void => {
    if (!pageVisible()) releaseAll();
  };

  // ---- attach ----

  const contextMenu = options.contextMenu ?? true;
  const previousTouchAction = stage.style?.touchAction;
  const setTouchAction = (options.touchAction ?? true) && stage.style != null;
  if (setTouchAction && stage.style) stage.style.touchAction = "none";
  const addedTabIndex =
    focusStage &&
    stage.getAttribute?.("tabindex") == null &&
    typeof stage.setAttribute === "function";
  if (addedTabIndex) stage.setAttribute?.("tabindex", "-1");

  const stageListeners: [string, Listener][] = [
    ["pointerdown", onPointerDown],
    ["pointermove", onPointerMove],
    ["pointerup", onPointerUp],
    ["pointercancel", onPointerCancel],
    ["lostpointercapture", onLostCapture],
    ["auxclick", onAuxClick],
  ];
  if (contextMenu) stageListeners.push(["contextmenu", onContextMenu]);
  for (const [type, listener] of stageListeners)
    stage.addEventListener(type, listener);
  stage.addEventListener("wheel", onWheel, { passive: false });
  // A pointerup the stage missed (no capture) still releases; after the stage handled one, the
  // window copy finds nothing tracked and leaves the event alone.
  const windowListeners: [string, Listener][] = [
    ["pointerup", onWindowPointerUp],
    ["pointercancel", onPointerCancel],
    ["blur", onBlur],
    ["pagehide", onPageHide],
  ];
  for (const [type, listener] of windowListeners)
    events?.addEventListener(type, listener);
  visibility?.addEventListener("visibilitychange", onVisibility);

  return {
    hover(position: InputVec2, client?: InputVec2): boolean {
      const at = hookPoint(position);
      if (!at) {
        drop("off-picture");
        return false;
      }
      if (!active()) {
        drop("inactive");
        return false;
      }
      hoverAt(at, hookClient(client));
      return true;
    },
    click(button: number, position: InputVec2, client?: InputVec2): boolean {
      const at = hookPoint(position);
      if (!at || !Number.isInteger(button) || button < 1 || button > 9) {
        drop("unmapped-button");
        return false;
      }
      return clickAt(button, at, hookClient(client));
    },
    heldState(): readonly InputHeldState[] {
      const list: InputRecord[] = [];
      // Handles do not survive an epoch (this runs after each hello): the held state re-declares
      // the targets it references, first, and every later reference re-declares lazily. A target
      // goes along only while its point is still the held one; held buttons carry none (their
      // press's `local` no longer matches the point).
      const stamps: TargetFieldsHolder[] = [];
      const current = (
        t: { stamp: PointerTargetStamp; at: Vec } | null,
        at: Vec,
      ) => (t && t.at[0] === at[0] && t.at[1] === at[1] ? t.stamp : null);
      if (mousePos) {
        const motion: MouseMotionRecord = {
          event: "mouse_motion",
          position: [...mousePos],
        };
        const stamp = table ? current(mouseTarget, mousePos) : null;
        if (stamp) {
          Object.assign(motion, stamp);
          stamps.push(stamp);
        }
        list.push(motion);
      }
      let mask = 0;
      for (const button of held.keys()) {
        mask |= bit(button);
        list.push({
          event: "mouse_button",
          button_index: button,
          pressed: true,
          position: [...(mousePos ?? [0, 0])],
          button_mask: mask,
        });
      }
      for (const touch of [...touches.values()].sort(
        (a, b) => a.index - b.index,
      )) {
        const record: ScreenTouchRecord = {
          event: "screen_touch",
          pressed: true,
          position: [...touch.last],
        };
        if (touch.index !== 0) record.index = touch.index;
        const stamp = table ? current(touch.target, touch.last) : null;
        if (stamp) {
          Object.assign(record, stamp);
          stamps.push(stamp);
        }
        list.push(record);
      }
      if (table) {
        const declarations = table.redeclare(
          stamps.map((stamp) => stamp.target as number),
        );
        list.unshift(...declarations);
      }
      return [{ scope: "pointer", held: list }];
    },
    flush: flushMotion,
    refresh(): void {
      if (!disposed && enabled() === false) releaseAll();
    },
    releaseAll,
    dispose(): void {
      if (disposed) return;
      releaseAll();
      mouseMode?.dispose();
      disposed = true;
      if (rafHandle !== null) {
        cancelRaf?.(rafHandle);
        rafHandle = null;
      }
      for (const [type, listener] of stageListeners)
        stage.removeEventListener(type, listener);
      stage.removeEventListener("wheel", onWheel);
      for (const [type, listener] of windowListeners)
        events?.removeEventListener(type, listener);
      visibility?.removeEventListener("visibilitychange", onVisibility);
      if (setTouchAction && stage.style)
        stage.style.touchAction = previousTouchAction ?? "";
      if (addedTabIndex) stage.removeAttribute?.("tabindex");
    },
    stats(): PointerCaptureStats {
      return {
        ...stats,
        dropped: { ...stats.dropped },
        resolves: table?.stats.resolves ?? 0,
        declarations: table?.stats.declarations ?? 0,
      };
    },
  };
}
