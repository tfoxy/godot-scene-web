// The idle frame cap (`frameCap`): under `automatic`, while nobody interacts and the stream shows
// only ambient motion, the client presents every other frame callback (30 fps on a 60 Hz panel),
// and it presents every callback again from the first one after an input or a real change. On a
// GPU-bound (fill-bound) device, presenting half the frames halves the fill, which is what heats a
// phone over a long session. `off` (the default) presents every callback and measures nothing.
//
// Idle is judged from how far things moved and how long ago the last input or real change was,
// never from damage area: a full-screen layer drifting by hundredths of a pixel damages the whole
// screen on every transaction while nothing visibly happens.
//
// The cap touches presentation only. Every transaction is still received, applied and acked at
// the host's rate (`received` and `applied` as they happen, `submitted` with the draw that shows
// it), so the host's credit and the payload fetches, holds and revisits run as uncapped.

import type { CoreMotion } from "./core";

/** `off`: every frame callback presents (the default). `automatic`: every other one while idle. */
export type RenderStreamFrameCap = "off" | "automatic";

/** Idle starts this long after the last input or real change. It outlasts a UI tween's ease-out
 * and the pause between two taps, so an interaction never drops to 30 fps halfway, and it is short
 * enough that the cap engages within seconds of putting the device down. */
export const FRAME_CAP_QUIET_MS = 1500;

/** The largest displacement, in presentation px per transaction, that still counts as ambient
 * motion: a background drifting by hundredths of a pixel, a breathing idle pose (a few pixels
 * over a second or more) stay under it, and presented at 30 fps such motion steps at most twice
 * this. Anything faster (a card tween, an attack, a scroll) passes it within its first frames
 * and wakes the cap. */
export const IDLE_MOTION_MAX_PX = 1;

/** The largest step of one modulate or colour channel (0..1) per transaction that still counts
 * as ambient: a fade or pulse that takes a second or more (64 steps of 4/255) stays under it, a
 * popup's quick fade does not. */
export const IDLE_COLOR_STEP_MAX = 4 / 255;

/** rs-core `motion::Change` bits by name, lowest first (`stats().frameCapWake`). */
const CHANGE_NAMES = [
  "full",
  "structure",
  "visibility",
  "content",
  "appearance",
  "resource",
  "reshape",
  "viewport",
] as const;

/** Why a transaction's motion facts (`StreamCore.motion`) are not ambient: the lowest change bit's
 * name, `motion` or `colour` past the bounds above, or `unmeasured` for facts of another
 * transaction or none (a core that cannot measure: the cap then never engages). Null when they are
 * ambient: no change other than positions and colours, both within the bounds. */
export function motionWake(f: CoreMotion | null, seq: number): string | null {
  if (f === null || f.seq !== seq >>> 0) return "unmeasured";
  if (f.changes !== 0) {
    for (let b = 0; b < CHANGE_NAMES.length; b++)
      if (f.changes & (1 << b)) return CHANGE_NAMES[b] as string;
    return "change";
  }
  if (!(f.maxPx <= IDLE_MOTION_MAX_PX)) return "motion";
  if (!(f.colorStep <= IDLE_COLOR_STEP_MAX)) return "colour";
  return null;
}

/** The cap's state: when the last activity was, whether it is engaged, and the frame parity. */
export class FrameCap {
  /** Engaged: idle under `automatic`, presenting every other frame callback. */
  engaged = false;
  /** Frame callbacks run while engaged, and those that presented nothing because of the cap. */
  cappedFrames = 0;
  skippedFrames = 0;
  /** What last woke the cap (or kept it awake): `stats().frameCapWake`. */
  wake = "mode";
  private lastActive: number;
  /** The next engaged callback skips its draw. */
  private skipNext = false;

  constructor(
    public mode: RenderStreamFrameCap,
    now: number,
  ) {
    this.lastActive = now;
  }

  /** A new mode: either way, a change of mode is someone interacting. */
  setMode(mode: RenderStreamFrameCap, now: number): void {
    this.mode = mode;
    this.activity(now, "mode");
  }

  /** An input or a real change (`why`, a constant string): the cap disengages at once (the next
   * callback presents) and idle starts over. */
  activity(now: number, why: string): void {
    this.lastActive = now;
    this.engaged = false;
    this.wake = why;
  }

  /** One frame callback: whether it presents. Engaged, the callbacks alternate strictly, the first
   * one presenting, so the presented frames are evenly spaced. */
  present(now: number): boolean {
    if (this.mode === "off") return true;
    if (!this.engaged) {
      if (now - this.lastActive < FRAME_CAP_QUIET_MS) return true;
      this.engaged = true;
      this.skipNext = false;
    }
    this.cappedFrames++;
    const skip = this.skipNext;
    this.skipNext = !skip;
    if (skip) this.skippedFrames++;
    return !skip;
  }
}
