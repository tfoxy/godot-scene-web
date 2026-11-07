// `mode: "mouse"` of the pointer capture (docs/input.md "Mouse mode"): touch -> mouse gestures for
// mouse-only games and for hosts with `emulate_mouse_from_touch` off. Mouse and pen never reach this
// module; they pass through the capture's native path unchanged.
//
// One gesture runs at a time, from the first finger down until every finger on the stage is up:
//
//   touch-down -> pending ── lift under the slop ─────────────────> tap (motion, LEFT press+release)
//                   │ ─ travel past touchSlop ────────────────────> drag-start (motion, LEFT press),
//                   │                                                drag-move (coalesced motion),
//                   │                                                drag-end (LEFT release)
//                   │ ─ still for longPressMs (opt-in) ───────────> long-press (motion, RIGHT click)
//                   │ ─ a second finger ──────────────────────────> scroll: vertical centroid drift
//                   │                                                -> wheel ticks, natural direction
//   any finger beyond the gesture's own is ignored (`dropped["extra-touch"]`); touch-end closes it.
//
// Every press is preceded by a motion at its point (hover-first widgets ignore a press the cursor
// never reached, and a finger, unlike a mouse, never travelled there). A press that went out is
// always released: at the lift point, at the last mapped point when the lift maps nowhere, or with
// `canceled: true` on pointercancel / blur / hidden / pagehide / disable / dispose.
//
// Hooks: `intercept(gesture)` decides whether an interceptable gesture's default records go out
// ("swallow" sends nothing and lets the gesture continue as documented per kind); `onGesture`
// observes every gesture after its records. Products build their own gestures from these plus the
// capture's `hover()` / `click()` (couch: tap-to-focus, held-card peek, confirm tap).
//
// The capture owns every record and the one-mouse state; this module only decides when, through
// the `MouseModeHost` primitives, so targets and stats stay in one place.

import type { InputVec2 } from "./format";
import { MouseButton } from "./godot-enums";

/** What a mouse-mode gesture is. See docs/input.md "Mouse mode" for each kind's records. */
export type PointerGestureKind =
  | "touch-down"
  | "tap"
  | "long-press"
  | "drag-start"
  | "drag-move"
  | "drag-end"
  | "scroll-start"
  | "wheel"
  | "touch-end";

/** One mouse-mode gesture, as hooks see it. */
export interface PointerGesture {
  readonly kind: PointerGestureKind;
  /** The finger it concerns (for `scroll-start` and `wheel`, the finger whose event caused it). */
  readonly pointerId: number;
  /** The DOM client point it happened at (`wheel`, `scroll-start`: the latch centroid). */
  readonly clientX: number;
  readonly clientY: number;
  /**
   * Host root-window px the default records act at: the mapped point (`drag-start` and
   * `long-press`: the press point; `wheel`: the latch point). `null` when it maps nowhere, which
   * only `touch-end` and an off-picture `drag-end` lift can see (`drag-end` then releases at the
   * last mapped point, given here instead).
   */
  readonly position: InputVec2 | null;
  /** The Godot button the default records use: LEFT, RIGHT (`long-press`) or WHEEL_UP/WHEEL_DOWN. */
  readonly button?: number;
  /** `tap`: the press is a double click (a second tap within 400 ms and 24 CSS px). */
  readonly doubleClick?: boolean;
  /** `drag-end`, `touch-end`: ended by a cancel or release-all rather than a lift. */
  readonly canceled?: boolean;
}

/** `intercept`'s answer: send the gesture's default records, or send nothing. */
export type PointerGestureDecision = "send" | "swallow";

/** `mode: "mouse"` tuning and hooks (`createPointerCapture({ gestures })`). Ignored in native mode. */
export interface PointerGestureOptions {
  /** CSS px a finger travels before it is a drag, not a tap (default 8). */
  touchSlop?: number;
  /**
   * ms a still, lone finger is held before `long-press` (default 0: off). Its default records are
   * a motion and a RIGHT click at the press point; the finger is then inert until it lifts.
   */
  longPressMs?: number;
  /** CSS px either scroll finger travels before the two-finger drift scrolls (default 16). */
  scrollSlop?: number;
  /** Host px of vertical centroid drift per wheel tick (default 56). */
  wheelStep?: number;
  /**
   * Asked before the default records of `touch-down`, `tap`, `long-press`, `drag-start`,
   * `drag-move` and `wheel` go out. Releases (`drag-end`) and `touch-end` are never interceptable.
   */
  intercept?: (gesture: PointerGesture) => PointerGestureDecision;
  /** Told of every gesture after its records went out (or were swallowed). */
  onGesture?: (
    gesture: PointerGesture,
    decision: PointerGestureDecision,
  ) => void;
}

type Vec = [number, number];

/** The capture-side primitives mouse mode drives. Every record is pushed by the capture. */
export interface MouseModeHost {
  /** DOM client px -> quantized host px, or null off picture. */
  map(clientX: number, clientY: number): Vec | null;
  /** Host px per client px around a client point, [x, y]. */
  scaleAt(clientX: number, clientY: number): Vec;
  /**
   * A drag sample was buffered: call `settle()` when the next motion record is due (the capture's
   * frame, or at once without coalescing). Never called from inside `settle()`.
   */
  schedule(): void;
  /** A drag sample is about to be buffered: motion buffered before it must go first. */
  beforeDrag(): void;
  active(): boolean;
  drop(
    reason: "inactive" | "off-picture" | "extra-touch" | "intercepted",
  ): void;
  capturePointer(pointerId: number): void;
  // Every primitive takes the DOM client point the record stands for (`client`), which the
  // capture's pointer targets resolve at; absent (a cancel), nothing is resolved.
  /** One `mouse_motion` at `at` now (pending motion flushed first). */
  hover(at: Vec, client?: Vec): void;
  /** Coalesced drag motion to `at` (one per animation frame). */
  drag(at: Vec, client?: Vec): void;
  /** LEFT/RIGHT press owned by `owner`; false (and nothing sent) when refused. */
  press(
    button: number,
    at: Vec,
    owner: number,
    doubleClick: boolean,
    client?: Vec,
  ): boolean;
  /** Release `button` if `owner` holds it. */
  release(
    button: number,
    at: Vec,
    owner: number,
    canceled: boolean,
    client?: Vec,
  ): void;
  /** A press+release pair of any button (wheel buttons: factor 1); false when refused. */
  click(button: number, at: Vec, client?: Vec): boolean;
  now(): number;
}

export interface MouseMode {
  down(pointerId: number, clientX: number, clientY: number): void;
  move(pointerId: number, clientX: number, clientY: number): void;
  up(pointerId: number, clientX: number, clientY: number): void;
  cancel(pointerId: number): void;
  /**
   * Map and report the dragging finger's newest buffered sample (one `map`, one `drag-move`),
   * called by the capture at the start of a motion flush.
   */
  settle(): void;
  /** Is a drag sample waiting for `settle()`? */
  buffered(): boolean;
  /** Release / cancel the running gesture; fingers still down stay ignored until they lift. */
  cancelAll(): void;
  /** Is this finger down on the stage (so a missed pointerup must still reach `up`)? */
  tracks(pointerId: number): boolean;
  dispose(): void;
}

/** Most unmapped drag samples one frame keeps to look back through. */
const MAX_RAW = 64;
const DEFAULT_TOUCH_SLOP = 8;
const DEFAULT_SCROLL_SLOP = 16;
const DEFAULT_WHEEL_STEP = 56;
/** Godot web's double-click window (display_server_web.cpp:263-280), with a finger-sized radius. */
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 24;

/** A timer handle (the package typechecks without DOM or Node libraries). */
type Timer = unknown;

/** One finger down, under the slop: still a potential tap, drag, long press or scroll. */
interface Pending {
  type: "pending";
  startX: number;
  startY: number;
  /** The latest client point (the scroll latch uses it). */
  x: number;
  y: number;
  /** The mapped press point. */
  down: Vec;
  timer: Timer | null;
}

interface Drag {
  type: "drag";
  /** Last mapped point and its client point: where a lift that maps nowhere releases. */
  last: Vec;
  lastX: number;
  lastY: number;
  /** The samples not yet mapped (client px), oldest first. */
  raw: [number, number][];
}

interface ScrollFinger {
  startX: number;
  startY: number;
  x: number;
  y: number;
}

interface Scroll {
  type: "scroll";
  fingers: Map<number, ScrollFinger>;
  at: Vec;
  clientAt: Vec;
  /** Host px per client px, vertical, measured once at the latch. */
  scale: number;
  prevCentroid: number;
  acc: number;
  moved: boolean;
  /** A finger lifted: the other is inert until it lifts too. */
  lifted: boolean;
}

/** Nothing more comes of this gesture until its fingers lift. */
interface Inert {
  type: "inert";
}

/** One gesture, from its first finger down until its own fingers are all up. */
interface Session {
  /** The first finger. */
  id: number;
  /** The fingers this gesture uses; it ends when they have all lifted. */
  own: Set<number>;
  /** A `touch-down` went out, so a `touch-end` is owed. */
  reported: boolean;
  phase: Pending | Drag | Scroll | Inert;
}

const nonNegative = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;

export function createMouseMode(
  host: MouseModeHost,
  options: PointerGestureOptions = {},
): MouseMode {
  const touchSlop = nonNegative(options.touchSlop, DEFAULT_TOUCH_SLOP);
  const scrollSlop = nonNegative(options.scrollSlop, DEFAULT_SCROLL_SLOP);
  const wheelStep =
    nonNegative(options.wheelStep, DEFAULT_WHEEL_STEP) || DEFAULT_WHEEL_STEP;
  const longPressMs = nonNegative(options.longPressMs, 0);
  const { intercept, onGesture } = options;
  const timers = globalThis as {
    setTimeout?: (callback: () => void, ms: number) => Timer;
    clearTimeout?: (handle: Timer) => void;
  };

  /** Every touch pointer down on the stage. */
  const fingers = new Set<number>();
  let session: Session | null = null;
  let lastTap: { at: number; x: number; y: number } | null = null;

  function decide(gesture: PointerGesture): PointerGestureDecision {
    if (intercept?.(gesture) !== "swallow") return "send";
    host.drop("intercepted");
    return "swallow";
  }
  const tell = (gesture: PointerGesture, decision: PointerGestureDecision) =>
    onGesture?.(gesture, decision);

  // A lift ends a gesture twice over (the tap or release, then `touch-end`) at one point: the
  // point maps once per lift, however many of them ask. Only the calls inside `lifting` share it.
  let lifted: { x: number; y: number; at: Vec | null } | null = null;
  function mapLift(x: number, y: number): Vec | null {
    if (lifted === null || lifted.x !== x || lifted.y !== y)
      lifted = { x, y, at: host.map(x, y) };
    return lifted.at ? [...lifted.at] : null;
  }
  /** Runs one lift's calls with `mapLift`'s memo, which never outlives them. */
  function lifting(run: () => void): void {
    lifted = null;
    try {
      run();
    } finally {
      lifted = null;
    }
  }

  function setPhase(s: Session, phase: Session["phase"]): void {
    if (s.phase.type === "pending" && s.phase.timer !== null) {
      timers.clearTimeout?.(s.phase.timer);
      s.phase.timer = null;
    }
    s.phase = phase;
  }

  /** Stray fingers still down: ignored, as one unreported gesture, until they lift. */
  function strays(): Session | null {
    if (fingers.size === 0) return null;
    return {
      id: -1,
      own: new Set(fingers),
      reported: false,
      phase: { type: "inert" },
    };
  }

  function end(s: Session, canceled: boolean, x: number, y: number): void {
    setPhase(s, { type: "inert" });
    if (session === s) session = strays();
    if (s.reported)
      tell(
        {
          kind: "touch-end",
          pointerId: s.id,
          clientX: x,
          clientY: y,
          position: mapLift(x, y),
          ...(canceled ? { canceled: true } : {}),
        },
        "send",
      );
  }

  function longPress(s: Session, p: Pending): void {
    p.timer = null;
    if (s.phase !== p) return;
    if (!host.active()) {
      host.drop("inactive");
      return;
    }
    const gesture: PointerGesture = {
      kind: "long-press",
      pointerId: s.id,
      clientX: p.startX,
      clientY: p.startY,
      position: [...p.down],
      button: MouseButton.RIGHT,
    };
    const decision = decide(gesture);
    // "swallow" leaves the finger pending: a later lift is still a tap, travel still a drag.
    if (decision === "send" && s.phase === p) {
      setPhase(s, { type: "inert" });
      const start: Vec = [p.startX, p.startY];
      host.hover(p.down, start);
      host.click(MouseButton.RIGHT, p.down, start);
    }
    tell(gesture, decision);
  }

  function startDrag(s: Session, p: Pending, x: number, y: number): void {
    setPhase(s, { type: "inert" });
    if (!host.active()) {
      host.drop("inactive");
      return;
    }
    const gesture: PointerGesture = {
      kind: "drag-start",
      pointerId: s.id,
      clientX: p.startX,
      clientY: p.startY,
      position: [...p.down],
      button: MouseButton.LEFT,
    };
    const decision = decide(gesture);
    // "swallow" makes the finger inert to its lift (no press, so nothing to release).
    if (decision === "send" && session === s) {
      const start: Vec = [p.startX, p.startY];
      host.hover(p.down, start);
      if (host.press(MouseButton.LEFT, p.down, s.id, false, start))
        setPhase(s, {
          type: "drag",
          last: p.down,
          lastX: p.startX,
          lastY: p.startY,
          raw: [],
        });
    }
    tell(gesture, decision);
    if (s.phase.type === "drag") dragMove(s, s.phase, x, y);
  }

  /** Buffer a drag sample; the flush maps it (the newest of a frame that maps wins). */
  function dragMove(_s: Session, d: Drag, x: number, y: number): void {
    host.beforeDrag();
    if (d.raw.length >= MAX_RAW) d.raw.shift();
    d.raw.push([x, y]);
    host.schedule();
  }

  /**
   * Map the newest buffered drag sample (one `map` call; older ones only while the newest is off
   * the picture) and report it as the frame's `drag-move`.
   */
  function settleDrag(s: Session, d: Drag): void {
    if (d.raw.length === 0) return;
    const samples = d.raw;
    d.raw = [];
    let x = 0;
    let y = 0;
    let at: Vec | null = null;
    for (let i = samples.length - 1; i >= 0 && !at; i--) {
      [x, y] = samples[i] as Vec;
      at = host.map(x, y);
    }
    // Off the picture: still a drag, released at the last mapped point.
    if (!at || (at[0] === d.last[0] && at[1] === d.last[1])) return;
    const gesture: PointerGesture = {
      kind: "drag-move",
      pointerId: s.id,
      clientX: x,
      clientY: y,
      position: [...at],
      button: MouseButton.LEFT,
    };
    const decision = decide(gesture);
    if (decision === "send" && s.phase === d) {
      d.last = at;
      d.lastX = x;
      d.lastY = y;
      host.drag(at, [x, y]);
    }
    tell(gesture, decision);
  }

  /** The press went out, so the release always does (never interceptable). */
  function endDrag(
    s: Session,
    d: Drag,
    x: number,
    y: number,
    canceled: boolean,
  ) {
    // The sample still buffered is this frame's drag motion: it goes out before the release.
    settleDrag(s, d);
    setPhase(s, { type: "inert" });
    const liftAt = canceled ? null : mapLift(x, y);
    const point = liftAt ?? d.last;
    const client: Vec | undefined = canceled
      ? undefined
      : liftAt
        ? [x, y]
        : [d.lastX, d.lastY];
    host.release(MouseButton.LEFT, point, s.id, canceled, client);
    tell(
      {
        kind: "drag-end",
        pointerId: s.id,
        clientX: x,
        clientY: y,
        position: [...point],
        button: MouseButton.LEFT,
        ...(canceled ? { canceled: true } : {}),
      },
      "send",
    );
  }

  function tap(s: Session, x: number, y: number): void {
    setPhase(s, { type: "inert" });
    const at = mapLift(x, y);
    if (!at) {
      // Lifted off the picture under the slop: nothing was pressed, nothing is owed.
      host.drop("off-picture");
      return;
    }
    if (!host.active()) {
      host.drop("inactive");
      return;
    }
    const t = host.now();
    const doubleClick =
      lastTap !== null &&
      t - lastTap.at < DOUBLE_TAP_MS &&
      Math.hypot(x - lastTap.x, y - lastTap.y) < DOUBLE_TAP_PX;
    lastTap = doubleClick ? null : { at: t, x, y };
    const gesture: PointerGesture = {
      kind: "tap",
      pointerId: s.id,
      clientX: x,
      clientY: y,
      position: [...at],
      button: MouseButton.LEFT,
      ...(doubleClick ? { doubleClick: true } : {}),
    };
    const decision = decide(gesture);
    if (decision === "send") {
      const client: Vec = [x, y];
      host.hover(at, client);
      if (host.press(MouseButton.LEFT, at, s.id, doubleClick, client))
        host.release(MouseButton.LEFT, at, s.id, false, client);
    }
    tell(gesture, decision);
  }

  function startScroll(
    s: Session,
    p: Pending,
    id: number,
    x: number,
    y: number,
  ) {
    const cx = (p.x + x) / 2;
    const cy = (p.y + y) / 2;
    const at = host.map(cx, cy) ?? p.down;
    const scroll: Scroll = {
      type: "scroll",
      fingers: new Map([
        [s.id, { startX: p.x, startY: p.y, x: p.x, y: p.y }],
        [id, { startX: x, startY: y, x, y }],
      ]),
      at,
      clientAt: [cx, cy],
      scale: host.scaleAt(cx, cy)[1],
      prevCentroid: cy,
      acc: 0,
      moved: false,
      lifted: false,
    };
    setPhase(s, scroll);
    s.own.add(id);
    tell(
      {
        kind: "scroll-start",
        pointerId: id,
        clientX: cx,
        clientY: cy,
        position: [...at],
      },
      "send",
    );
  }

  function scrollMove(
    s: Session,
    scroll: Scroll,
    id: number,
    x: number,
    y: number,
  ) {
    const f = scroll.fingers.get(id);
    if (!f || scroll.lifted) return;
    f.x = x;
    f.y = y;
    if (!scroll.moved) {
      if (Math.hypot(x - f.startX, y - f.startY) < scrollSlop) return;
      scroll.moved = true;
    }
    // Natural scroll: fingers moving DOWN pull the content down, which is WHEEL_UP. One tick per
    // whole step of drift (several when a fast move covers several), the remainder carried.
    let c = 0;
    for (const finger of scroll.fingers.values()) c += finger.y;
    c /= scroll.fingers.size;
    scroll.acc += (c - scroll.prevCentroid) * scroll.scale;
    scroll.prevCentroid = c;
    while (Math.abs(scroll.acc) >= wheelStep && s.phase === scroll) {
      const up = scroll.acc > 0;
      scroll.acc -= up ? wheelStep : -wheelStep;
      if (!host.active()) {
        host.drop("inactive");
        continue;
      }
      const button = up ? MouseButton.WHEEL_UP : MouseButton.WHEEL_DOWN;
      const gesture: PointerGesture = {
        kind: "wheel",
        pointerId: id,
        clientX: scroll.clientAt[0],
        clientY: scroll.clientAt[1],
        position: [...scroll.at],
        button,
      };
      const decision = decide(gesture);
      if (decision === "send")
        host.click(button, scroll.at, [scroll.clientAt[0], scroll.clientAt[1]]);
      tell(gesture, decision);
    }
  }

  /** A finger of `s` lifted (or was canceled); `s` ends when its own fingers are all up. */
  function lift(
    s: Session,
    id: number,
    x: number,
    y: number,
    canceled: boolean,
  ) {
    lifting(() => {
      const phase = s.phase;
      if (id === s.id && phase.type === "pending") {
        if (canceled) setPhase(s, { type: "inert" });
        else tap(s, x, y);
      } else if (id === s.id && phase.type === "drag") {
        if (canceled) endDrag(s, phase, phase.lastX, phase.lastY, true);
        else endDrag(s, phase, x, y, false);
      } else if (phase.type === "scroll") {
        phase.fingers.delete(id);
        phase.lifted = true;
      }
      s.own.delete(id);
      if (s.own.size === 0) end(s, canceled, x, y);
    });
  }

  return {
    down(id, x, y): void {
      if (fingers.has(id)) return;
      fingers.add(id);
      host.capturePointer(id);
      const s = session;
      if (s === null) {
        const at = host.active() ? host.map(x, y) : null;
        const fresh: Session = {
          id,
          own: new Set([id]),
          reported: at !== null,
          phase: { type: "inert" },
        };
        session = fresh;
        if (!at) {
          host.drop(host.active() ? "off-picture" : "inactive");
          return;
        }
        const pending: Pending = {
          type: "pending",
          startX: x,
          startY: y,
          x,
          y,
          down: at,
          timer: null,
        };
        fresh.phase = pending;
        const gesture: PointerGesture = {
          kind: "touch-down",
          pointerId: id,
          clientX: x,
          clientY: y,
          position: [...at],
        };
        const decision = decide(gesture);
        // "swallow" claims the finger for the product: inert to its lift, `touch-end` still comes.
        if (decision === "swallow") setPhase(fresh, { type: "inert" });
        else if (
          fresh.phase === pending &&
          longPressMs > 0 &&
          timers.setTimeout
        )
          pending.timer = timers.setTimeout(
            () => longPress(fresh, pending),
            longPressMs,
          );
        tell(gesture, decision);
        return;
      }
      if (s.phase.type === "pending") {
        startScroll(s, s.phase, id, x, y);
        return;
      }
      // A third finger, a second one during a drag, or any during an inert gesture.
      host.drop("extra-touch");
    },

    move(id, x, y): void {
      const s = session;
      if (!s?.own.has(id)) return;
      const phase = s.phase;
      if (phase.type === "pending") {
        phase.x = x;
        phase.y = y;
        // Raw client travel, so a finger sliding off the picture still becomes (and stays) a drag.
        if (Math.hypot(x - phase.startX, y - phase.startY) >= touchSlop)
          startDrag(s, phase, x, y);
      } else if (phase.type === "drag") dragMove(s, phase, x, y);
      else if (phase.type === "scroll") scrollMove(s, phase, id, x, y);
    },

    up(id, x, y): void {
      if (!fingers.delete(id)) return;
      if (session?.own.has(id)) lift(session, id, x, y, false);
    },

    cancel(id): void {
      if (!fingers.delete(id)) return;
      const s = session;
      if (!s?.own.has(id)) return;
      const phase = s.phase;
      if (phase.type === "drag") settleDrag(s, phase);
      const finger = phase.type === "scroll" ? phase.fingers.get(id) : null;
      const point: Vec =
        phase.type === "pending"
          ? [phase.x, phase.y]
          : phase.type === "drag"
            ? [phase.lastX, phase.lastY]
            : finger
              ? [finger.x, finger.y]
              : [0, 0];
      lift(s, id, point[0], point[1], true);
    },

    cancelAll(): void {
      const s = session;
      if (!s) return;
      const phase = s.phase;
      lifting(() => {
        let point: Vec = [0, 0];
        if (phase.type === "drag") {
          settleDrag(s, phase);
          point = [phase.lastX, phase.lastY];
          endDrag(s, phase, point[0], point[1], true);
        } else if (phase.type === "pending") point = [phase.x, phase.y];
        // Every finger still down is ignored until it lifts.
        s.own = new Set();
        end(s, true, point[0], point[1]);
      });
    },

    settle(): void {
      const s = session;
      if (s?.phase.type === "drag") settleDrag(s, s.phase);
    },

    buffered(): boolean {
      const phase = session?.phase;
      return phase?.type === "drag" && phase.raw.length > 0;
    },

    tracks(id): boolean {
      return fingers.has(id);
    },

    dispose(): void {
      if (session) setPhase(session, { type: "inert" });
      session = null;
      fingers.clear();
    },
  };
}
