// The LOOP-PACING contract shared by the two live effect runtimes (`./webgl/runtime`'s WebGL
// shader runtime and `./particles/runtime`'s particle runtime).
//
// WHY: both loops are FPS-CAPPED (`shaderFps` / `particleFps`) but used to stay armed on a
// per-DISPLAY-frame rAF chain: a capped tick that fired before its cap boundary re-armed rAF
// and returned, so a 30fps cap on a 60Hz display cost TWO main-thread wakeups per rendered
// frame — one that renders, one that only computes "too early". A phone trace showed that spin
// as a measurable slice of sustained main-thread busy, paid on screens where nothing changes.
//
// CONTRACT
//   A capped loop asks the pacer for its next wakeup with the SECONDS REMAINING until its cap
//   boundary. The pacer either:
//     - `"timer"` (default): PARKS on a `setTimeout` for that interval, then re-enters through
//       exactly ONE rAF, so the render itself is still frame-aligned. No rAF is registered
//       while parked, so the browser can skip those frames on the main thread entirely.
//     - `"raf"`: re-arms rAF immediately, i.e. the pre-pacing spin, verbatim. The kill switch.
//
//   ONE wakeup at a time: `arm` is a no-op while a rAF or a park timer is already in flight, so
//   an invalidation/wake path (a host reconcile, a texture load, a quality retune) never
//   double-arms. A pending park already guarantees a tick within one cap interval — exactly the
//   worst-case latency of the old skip-and-re-arm path — so respecting it costs no latency.
//
//   SLOP (`"timer"` only): the park is shortened by `PARK_SLOP_S` and a boundary within that
//   slop counts as reached (`isDue`). Without it a park that ends a hair AFTER the boundary
//   would re-enter on the NEXT vsync (a whole display frame late, i.e. 30fps → 20fps), or worse,
//   land a hair BEFORE it and pay a second wakeup to re-park. The cost is that the effective
//   rate may exceed the cap by at most `PARK_SLOP_S` per frame. `"raf"` pacing uses zero slop,
//   so its cap check stays bit-identical to the pre-pacing one.
//
// The pacer owns NOTHING else: no cap bookkeeping, no dirty/dormancy/suspend state, no clock —
// each runtime keeps its own and passes the remaining time in.

/** How a capped effect loop arms its next tick (see `GodotHtmlRenderOptions.effectsLoopPacing`). */
export type EffectsLoopPacing = "timer" | "raf";

/** Slop (seconds) around a cap boundary, `"timer"` pacing only (see the module doc). */
export const PARK_SLOP_S = 0.004;

/** The wakeup scheduler of one capped effect loop (see `createEffectsLoopPacer`). */
export interface EffectsLoopPacer {
  /** Whether a boundary `remaining` seconds away counts as reached now (absorbs the park slop). */
  isDue(remaining: number): boolean;
  /** Whether a wakeup (rAF or park timer) is already in flight. */
  isArmed(): boolean;
  /** Arm the next tick `remaining` seconds from now. No-op while already armed. */
  arm(remaining: number): void;
  /** Drop a pending park (NOT a pending rAF) — for a cap change that invalidates its deadline. */
  cancelPark(): void;
  /** Drop every pending wakeup. */
  cancel(): void;
}

/**
 * Create the wakeup scheduler for one capped effect loop. `tick` is the loop body; it runs
 * inside a rAF callback in both pacing modes.
 */
export function createEffectsLoopPacer(
  tick: () => void,
  pacing: EffectsLoopPacing | undefined,
): EffectsLoopPacer {
  const parks = (pacing ?? "timer") === "timer";
  const slop = parks ? PARK_SLOP_S : 0;
  let rafId: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onFrame = (): void => {
    rafId = null;
    tick();
  };
  const requestFrame = (): void => {
    if (rafId === null) rafId = requestAnimationFrame(onFrame);
  };
  const onPark = (): void => {
    timer = null;
    requestFrame();
  };
  return {
    isDue: (remaining: number): boolean => remaining <= slop,
    isArmed: (): boolean => rafId !== null || timer !== null,
    arm(remaining: number): void {
      if (rafId !== null || timer !== null) return;
      if (!parks || remaining <= slop) {
        requestFrame();
        return;
      }
      timer = setTimeout(onPark, Math.ceil((remaining - slop) * 1000));
    },
    cancelPark(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    cancel(): void {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
