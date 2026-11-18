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

/** The default `frameCapBounds.motionPx`: the largest displacement of scene content (items,
 * canvases, an emitter's transform), in presentation px per transaction, that still counts as
 * ambient motion: a background drifting by
 * hundredths of a pixel stays under it, and presented at 30 fps such motion steps at most twice
 * this. Anything faster (a card tween, a panel sliding in, a scroll) passes it within its first
 * frames and wakes the cap. */
export const IDLE_MOTION_MAX_PX = 1;

/** The default `frameCapBounds.colorStep`: the largest step of one modulate or colour channel
 * (0..1) of scene content per transaction that still counts as ambient: a glow pulse whose full swing takes half a second or more (32
 * steps of 8/255) stays under it, a popup's fade (a quarter second or less, 15/255 or more per
 * step) does not. */
export const IDLE_COLOR_STEP_MAX = 8 / 255;

/** The default `frameCapBounds.animationPx`: the largest displacement, in presentation px per
 * transaction, of animation content (skeletal bodies, CPU particle instances, flipbook geometry)
 * that still counts as ambient. An idle
 * skeleton sweeps parts of itself, or a background layer, by tens of pixels per frame and a mote
 * drifts by a few, all of it ambient; what passes this is a cut: a visible part or particle
 * teleporting across the screen. Animation that starts with a real change (a new emitter, an
 * attachment swap, a new body, an item shown) wakes through that change. */
export const IDLE_ANIMATION_MAX_PX = 128;

/** The default `frameCapBounds.animationColorStep`: unbounded, so animation colour never wakes
 * the cap. An idle skeleton's slot colours cycle, flicker and flash within its loop; a real
 * change that comes with a flash (a hit, a new effect) wakes through its other changes. A
 * consumer that wants flashes to wake sets a step (0..1, premultiplied where the material scales
 * by alpha). */
export const IDLE_ANIMATION_COLOR_STEP_MAX = Number.POSITIVE_INFINITY;

/** How much ambient motion a transaction may carry and still leave the cap engaged (all per
 * transaction; omitted fields take the `IDLE_*` defaults). */
export interface RenderStreamFrameCapBounds {
  /** Scene content's displacement, presentation px (`IDLE_MOTION_MAX_PX`, 1). */
  motionPx?: number;
  /** Scene content's colour channel step, 0..1 (`IDLE_COLOR_STEP_MAX`, 8/255). */
  colorStep?: number;
  /** Animation content's displacement, presentation px (`IDLE_ANIMATION_MAX_PX`, 128). */
  animationPx?: number;
  /** Animation content's colour step, 0..1 (`IDLE_ANIMATION_COLOR_STEP_MAX`, unbounded). */
  animationColorStep?: number;
}

/** Bounds with every field set. */
export type FrameCapLimits = Required<RenderStreamFrameCapBounds>;

/** `bounds` over the defaults. Throws on a bound that is not a number at least 0 (`Infinity`
 * is a bound that never wakes). */
export function frameCapLimits(
  bounds: RenderStreamFrameCapBounds | undefined,
): FrameCapLimits {
  const out: FrameCapLimits = {
    motionPx: IDLE_MOTION_MAX_PX,
    colorStep: IDLE_COLOR_STEP_MAX,
    animationPx: IDLE_ANIMATION_MAX_PX,
    animationColorStep: IDLE_ANIMATION_COLOR_STEP_MAX,
  };
  if (bounds === undefined) return out;
  for (const k of Object.keys(out) as (keyof FrameCapLimits)[]) {
    const v = bounds[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !(v >= 0))
      throw new TypeError(
        `render-stream client: frameCapBounds.${k} must be a number >= 0`,
      );
    out[k] = v;
  }
  return out;
}

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
  "unmeasured",
] as const;

/** Why a transaction's motion facts (`StreamCore.motion`) are not ambient: the lowest change bit's
 * name, `motion` or `colour` (scene content) or `animation` or `animation colour` past `limits`, or `unmeasured` for facts of another transaction or none (a core that cannot measure: the
 * cap then never engages). Null when they are ambient: no change other than positions and
 * colours, all within the bounds. */
export function motionWake(
  f: CoreMotion | null,
  seq: number,
  limits: FrameCapLimits = frameCapLimits(undefined),
): string | null {
  if (f === null || f.seq !== seq >>> 0) return "unmeasured";
  if (f.changes !== 0) {
    for (let b = 0; b < CHANGE_NAMES.length; b++)
      if (f.changes & (1 << b)) return CHANGE_NAMES[b] as string;
    return "change";
  }
  if (!(f.maxPx <= limits.motionPx)) return "motion";
  if (!(f.colorStep <= limits.colorStep)) return "colour";
  if (!((f.animPx ?? 0) <= limits.animationPx)) return "animation";
  if (!((f.animColorStep ?? 0) <= limits.animationColorStep))
    return "animation colour";
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
    /** What still counts as ambient (`frameCapBounds`). */
    public limits: FrameCapLimits = frameCapLimits(undefined),
  ) {
    this.lastActive = now;
  }

  /** A new mode, and new limits when given: either way, a change is someone interacting. */
  setMode(
    mode: RenderStreamFrameCap,
    now: number,
    limits?: FrameCapLimits,
  ): void {
    this.mode = mode;
    if (limits !== undefined) this.limits = limits;
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
