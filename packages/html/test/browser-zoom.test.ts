import {
  type BrowserZoomWindow,
  observeBrowserZoom,
} from "@godot-scene-web/html";
import { describe, expect, it } from "vitest";

interface FakeMediaQuery {
  query: string;
  listeners: Array<() => void>;
  fire(): void;
}

interface FakeZoomWindow extends BrowserZoomWindow {
  setViewport(clientWidth: number, devicePixelRatio: number): void;
  resize(): void;
  mediaQueries: FakeMediaQuery[];
  resizeListenerCount(): number;
}

function createFakeWindow(
  clientWidth: number,
  devicePixelRatio: number,
): FakeZoomWindow {
  const resizeListeners = new Set<() => void>();
  const mediaQueries: FakeMediaQuery[] = [];
  const state = { clientWidth, devicePixelRatio };

  const fake: FakeZoomWindow = {
    get devicePixelRatio() {
      return state.devicePixelRatio;
    },
    document: {
      documentElement: {
        get clientWidth() {
          return state.clientWidth;
        },
      } as unknown as HTMLElement,
    },
    addEventListener: ((type: string, listener: () => void) => {
      if (type === "resize") {
        resizeListeners.add(listener);
      }
    }) as BrowserZoomWindow["addEventListener"],
    removeEventListener: ((type: string, listener: () => void) => {
      if (type === "resize") {
        resizeListeners.delete(listener);
      }
    }) as BrowserZoomWindow["removeEventListener"],
    matchMedia: ((query: string) => {
      const entry: FakeMediaQuery = {
        query,
        listeners: [],
        fire() {
          for (const listener of [...entry.listeners]) {
            listener();
          }
        },
      };
      mediaQueries.push(entry);
      return {
        media: query,
        matches: true,
        addEventListener: (_type: string, listener: () => void) => {
          entry.listeners.push(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          entry.listeners = entry.listeners.filter(
            (other) => other !== listener,
          );
        },
      } as unknown as MediaQueryList;
    }) as BrowserZoomWindow["matchMedia"],
    setViewport(nextClientWidth, nextDevicePixelRatio) {
      state.clientWidth = nextClientWidth;
      state.devicePixelRatio = nextDevicePixelRatio;
    },
    resize() {
      for (const listener of [...resizeListeners]) {
        listener();
      }
    },
    mediaQueries,
    resizeListenerCount: () => resizeListeners.size,
  };
  return fake;
}

describe("observeBrowserZoom", () => {
  it("reports 1 once at install and stays silent for plain resizes", () => {
    const fake = createFakeWindow(1280, 1);
    const reported: number[] = [];
    const dispose = observeBrowserZoom((zoom) => reported.push(zoom), fake);

    expect(reported).toEqual([1]);

    fake.setViewport(900, 1);
    fake.resize();
    expect(reported).toEqual([1]);

    dispose();
  });

  it("reports the dpr ratio for browser zoom in and out", () => {
    const fake = createFakeWindow(1280, 1);
    const reported: number[] = [];
    const dispose = observeBrowserZoom((zoom) => reported.push(zoom), fake);

    // 200%: dpr doubles, layout viewport halves — physical width constant.
    fake.setViewport(640, 2);
    fake.resize();
    expect(reported).toEqual([1, 2]);

    // Back to 100%.
    fake.setViewport(1280, 1);
    fake.resize();
    fake.resize();
    expect(reported).toEqual([1, 2, 1]);

    // 50%: dpr halves, viewport doubles.
    fake.setViewport(2560, 0.5);
    fake.resize();
    expect(reported).toEqual([1, 2, 1, 0.5]);

    dispose();
  });

  it("rebases instead of reporting zoom when the physical size moves with the dpr", () => {
    const fake = createFakeWindow(1280, 1);
    const reported: number[] = [];
    const dispose = observeBrowserZoom((zoom) => reported.push(zoom), fake);

    // Monitor move: dpr doubles but the CSS viewport is unchanged, so the
    // physical width doubled too — not zoom.
    fake.setViewport(1280, 2);
    fake.resize();
    expect(reported).toEqual([1]);

    // Subsequent real zoom to 200% relative to the rebased baseline.
    fake.setViewport(640, 4);
    fake.resize();
    expect(reported).toEqual([1, 2]);

    dispose();
  });

  it("recomputes from a resolution media-query change without a resize event", () => {
    const fake = createFakeWindow(1280, 1);
    const reported: number[] = [];
    const dispose = observeBrowserZoom((zoom) => reported.push(zoom), fake);

    expect(fake.mediaQueries.at(-1)?.query).toBe("(resolution: 1dppx)");

    fake.setViewport(640, 2);
    fake.mediaQueries.at(-1)?.fire();
    expect(reported).toEqual([1, 2]);
    // Re-armed for the new dpr; the old query no longer has listeners.
    expect(fake.mediaQueries.at(-1)?.query).toBe("(resolution: 2dppx)");
    expect(fake.mediaQueries.at(0)?.listeners).toHaveLength(0);

    dispose();
  });

  it("reports 1 for degenerate devicePixelRatio values", () => {
    const fake = createFakeWindow(1280, Number.NaN);
    const reported: number[] = [];
    const dispose = observeBrowserZoom((zoom) => reported.push(zoom), fake);

    expect(reported).toEqual([1]);
    fake.setViewport(640, 0);
    fake.resize();
    expect(reported).toEqual([1]);

    dispose();
  });

  it("removes all listeners on dispose", () => {
    const fake = createFakeWindow(1280, 1);
    const reported: number[] = [];
    const dispose = observeBrowserZoom((zoom) => reported.push(zoom), fake);

    dispose();
    expect(fake.resizeListenerCount()).toBe(0);
    expect(
      fake.mediaQueries.every((entry) => entry.listeners.length === 0),
    ).toBe(true);

    fake.setViewport(640, 2);
    fake.resize();
    expect(reported).toEqual([1]);
  });
});
