// A scripted browser for `createGamepadCapture`: `getGamepads`, one pending rAF callback, the
// `gamepadconnected` / `gamepaddisconnected` / `visibilitychange` events a real page would fire
// when a frame's pad list or visibility changes, `document.hasFocus()`, and a Web Locks manager
// (`FakeLocks`, which several pages can share to model same-origin windows). Shared by the unit
// tests and the vector runner.
import {
  createGamepadCapture,
  type GamepadCapture,
  type GamepadCaptureOptions,
  type GamepadLockManager,
  type GamepadRecord,
  type GamepadSnapshot,
} from "../src/gamepad";

export interface FakeFrame {
  pads?: GamepadSnapshot[];
  /** rAF timestamp; defaults to `16 * frameNumber`. */
  t?: number;
  visibility?: "visible" | "hidden";
  /** `document.hasFocus()` from this frame on (default true). */
  focus?: boolean;
  /** Lock names another window holds from this frame on (replaces the previous list). */
  others?: string[];
  dispose?: boolean;
}

/**
 * The Web Locks manager shape a claim uses, granting in a microtask like the real one never grants
 * synchronously. Only `ifAvailable` requests are supported: a claim must never queue for a pad.
 */
export class FakeLocks implements GamepadLockManager {
  /** Lock name -> holder. */
  readonly held = new Map<string, symbol>();
  readonly requests: string[] = [];
  private readonly others = new Map<string, symbol>();
  private readonly aborts = new Map<symbol, (error: Error) => void>();
  failing = false;

  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: object | null) => Promise<void> | undefined,
  ): Promise<unknown> {
    if (options.ifAvailable !== true)
      throw new Error("a claim must request ifAvailable");
    this.requests.push(name);
    if (this.failing) return Promise.reject(new Error("SecurityError"));
    return new Promise((resolve, reject) => {
      queueMicrotask(async () => {
        if (this.held.has(name)) {
          resolve(callback(null));
          return;
        }
        const holder = Symbol(name);
        this.held.set(name, holder);
        this.aborts.set(holder, reject);
        try {
          resolve(await callback({ name, mode: "exclusive" }));
        } catch (error) {
          reject(error);
        } finally {
          this.aborts.delete(holder);
          if (this.held.get(name) === holder) this.held.delete(name);
        }
      });
    });
  }

  /** `request(name, { steal: true })` from another window: the holder's request rejects. */
  steal(name: string): void {
    const holder = this.held.get(name);
    this.held.set(name, Symbol(`thief ${name}`));
    if (holder) this.aborts.get(holder)?.(new Error("AbortError"));
  }

  /** Model another window holding exactly `names`. */
  holdElsewhere(names: readonly string[]): void {
    for (const [name, holder] of this.others)
      if (!names.includes(name)) {
        this.others.delete(name);
        if (this.held.get(name) === holder) this.held.delete(name);
      }
    for (const name of names)
      if (!this.others.has(name) && !this.held.has(name)) {
        const holder = Symbol(`other ${name}`);
        this.others.set(name, holder);
        this.held.set(name, holder);
      }
  }
}

/** Let pending lock grants and releases run. */
export const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

type Listener = (event: { type: string }) => void;

class Target {
  readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    this.listeners.set(type, set);
    set.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, detail: object = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])])
      listener({ type, ...detail });
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
  document: Target & { visibilityState: string; focused: boolean };
  /** The page's lock manager, unless the options passed `locks` themselves. */
  locks: FakeLocks;
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
  const document = Object.assign(new Target(), {
    visibilityState: "visible",
    focused: true,
  });
  const locks = new FakeLocks();
  const capture = createGamepadCapture({
    sink: { push: (record) => records.push(record as GamepadRecord) },
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
    hasFocus: () => document.focused,
    locks,
    ...options,
  });
  return {
    capture,
    records,
    window,
    document,
    locks,
    pending: () => callback !== null,
    step(frame) {
      const start = records.length;
      const next = frame.pads ?? [];
      const after = new Set(next.map(slotKey));
      const gone = pads
        .map((pad, i) => ({ pad, key: slotKey(pad, i) }))
        .filter(({ key }) => !after.has(key));
      const before = new Set(pads.map(slotKey));
      pads = next;
      for (const { pad, key } of gone)
        window.dispatch("gamepaddisconnected", {
          gamepad: { index: key, id: pad.id ?? "" },
        });
      for (const key of after)
        if (!before.has(key)) window.dispatch("gamepadconnected");
      if (frame.focus !== undefined) document.focused = frame.focus;
      if (frame.others !== undefined) locks.holdElsewhere(frame.others);
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
