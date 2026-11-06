// A scripted browser for `createGamepadCapture`: `getGamepads`, one pending rAF callback, and the
// `gamepadconnected` / `gamepaddisconnected` / `visibilitychange` events a real page would fire
// when a frame's pad list or visibility changes. Shared by the unit tests and the vector runner.
import {
  createGamepadCapture,
  type GamepadCapture,
  type GamepadCaptureOptions,
  type GamepadRecord,
  type GamepadSnapshot,
} from "../src/gamepad";

export interface FakeFrame {
  pads?: GamepadSnapshot[];
  /** rAF timestamp; defaults to `16 * frameNumber`. */
  t?: number;
  visibility?: "visible" | "hidden";
  dispose?: boolean;
}

class Target {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    this.listeners.set(type, set);
    set.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
  count(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

export interface FakeGamepadPage {
  capture: GamepadCapture;
  records: GamepadRecord[];
  window: Target;
  document: Target & { visibilityState: string };
  /** Apply one frame (events first, then the pending poll) and return the records it pushed. */
  step(frame: FakeFrame): GamepadRecord[];
  pending(): boolean;
}

const slotKey = (pad: GamepadSnapshot, position: number) =>
  pad.index ?? position;

export function fakeGamepadPage(
  options: Partial<GamepadCaptureOptions> = {},
  initialPads: GamepadSnapshot[] = [],
): FakeGamepadPage {
  let pads: GamepadSnapshot[] = initialPads;
  let callback: ((time: number) => void) | null = null;
  let handles = 0;
  let frameNumber = 0;
  const records: GamepadRecord[] = [];
  const window = new Target();
  const document = Object.assign(new Target(), { visibilityState: "visible" });
  const capture = createGamepadCapture({
    sink: { push: (record) => records.push(record) },
    getGamepads: () => pads,
    requestAnimationFrame: (cb) => {
      callback = cb;
      handles += 1;
      return handles;
    },
    cancelAnimationFrame: () => {
      callback = null;
    },
    events: window,
    visibility: document,
    ...options,
  });
  return {
    capture,
    records,
    window,
    document,
    pending: () => callback !== null,
    step(frame) {
      const start = records.length;
      const next = frame.pads ?? [];
      const before = new Set(pads.map(slotKey));
      const after = new Set(next.map(slotKey));
      pads = next;
      for (const key of before)
        if (!after.has(key)) window.dispatch("gamepaddisconnected");
      for (const key of after)
        if (!before.has(key)) window.dispatch("gamepadconnected");
      if (
        frame.visibility !== undefined &&
        frame.visibility !== document.visibilityState
      ) {
        document.visibilityState = frame.visibility;
        document.dispatch("visibilitychange");
      }
      if (frame.dispose) capture.dispose();
      const run = callback;
      callback = null;
      run?.(frame.t ?? 16 * frameNumber);
      frameNumber += 1;
      return records.slice(start);
    },
  };
}
