// A `ResizeObserver` stub that behaves like a BROWSER's, for the jsdom suites (jsdom ships no
// ResizeObserver at all).
//
// The load-bearing part is the INITIAL DELIVERY: a real observer reports every newly observed
// target once, and Chrome does so even when the box is 0x0 (verified directly — `observe()` on a
// 0x0 element, and on one inside a `display: none` subtree, both deliver a 0x0 `contentRect`, and
// the element is reported again if it later gains a box). The particle runtime's default sizing
// path (`particleObserverSizing`) takes a new binding's FIRST box from exactly that delivery, so a
// stub whose `observe()` only records the call models a browser that does not exist: every particle
// canvas would sit unmounted forever and every DOM assertion in these suites would fail for a
// reason no real consumer can hit.
//
// ONE deliberate infidelity: the delivery is synchronous inside `observe()` rather than at the end
// of the next frame's layout step. That keeps a test free to assert on the DOM straight after
// `reconcile()` without pumping frames. Tests that care about the ASYNC gap (the canvas is not
// mounted until the box arrives, and the backstop that covers an engine which never delivers) drive
// the timing explicitly instead of using this stub — see `particles-rect-cache.test.ts`.
//
// The box comes from the target's own `clientWidth`/`clientHeight`, which is 0x0 under jsdom — the
// same value the read path's `clientWidth` would have returned, so switching a suite onto this stub
// changes no size any assertion sees.

export interface ResizeObserverStubHooks {
  /** Called with each constructed observer's callback (tests that deliver entries by hand). */
  onConstruct?: (callback: ResizeObserverCallback) => void;
  /** Called with each `observe()` target, BEFORE its initial delivery. */
  onObserve?: (target: Element) => void;
  /** Content box to deliver. Defaults to the target's own `clientWidth`/`clientHeight`, which is 0x0
   *  under jsdom. Suites that INSTRUMENT those getters to count the runtime's forced layouts must
   *  override this: a real observer measures during the browser's own layout step and costs the
   *  runtime no read at all, so the stub reaching for `clientWidth` would book a layout that does
   *  not exist and make the counter lie. */
  box?: (target: Element) => { width: number; height: number };
  /** Suppress the initial delivery, modelling a spec-strict engine that never reports a 0x0 box. */
  initialDelivery?: false;
}

export function makeResizeObserverStub(
  hooks: ResizeObserverStubHooks = {},
): typeof globalThis.ResizeObserver {
  class ResizeObserverStub {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      hooks.onConstruct?.(callback);
    }
    observe(target: Element): void {
      hooks.onObserve?.(target);
      if (hooks.initialDelivery === false) return;
      const contentRect = hooks.box
        ? hooks.box(target)
        : { width: target.clientWidth, height: target.clientHeight };
      this.callback(
        [{ target, contentRect } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  return ResizeObserverStub as unknown as typeof globalThis.ResizeObserver;
}
