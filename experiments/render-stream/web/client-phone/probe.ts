// PHN's page-side probes (scripts/client-device-check.ts, results/p3/phn.md). Installed before the
// client package is created, they time what the package does on the phone's main thread without
// touching it:
//   - every requestAnimationFrame callback: its frame timestamp (the rAF interval is the phone's
//     frame time) and its duration (the client's per-frame apply + lower + GL submission);
//   - every WebSocket `onmessage` handler: its duration and the message bytes (receive: the zstd
//     decode and the transaction accept);
//   - every fetch(): its duration to the response (resource GETs);
//   - long tasks (PerformanceObserver `longtask`);
//   - on demand (`gl(true)`), every WebGL2RenderingContext method: its call count and the time spent
//     inside it, in total and within rAF callbacks. Off by default: wrapping ~300 methods costs two
//     performance.now() per call, so it runs in its own attribution window only.

const RING = 1 << 15;

class Series {
  readonly a = new Float64Array(RING);
  readonly b = new Float64Array(RING);
  n = 0;
  push(x: number, y: number) {
    const i = this.n % RING;
    this.a[i] = x;
    this.b[i] = y;
    this.n++;
  }
  take(): { a: number[]; b: number[]; dropped: number } {
    const k = Math.min(this.n, RING);
    const start = this.n - k;
    const a: number[] = [];
    const b: number[] = [];
    for (let j = start; j < this.n; j++) {
      a.push(this.a[j % RING]);
      b.push(this.b[j % RING]);
    }
    const dropped = start;
    this.n = 0;
    return { a, b, dropped };
  }
}

const now = () => performance.now();
/** rAF: (frame timestamp, callback duration ms). */
const frames = new Series();
/** rAF: (GL ms inside the callback, GL calls inside the callback) when the GL probe is on. */
const frameGl = new Series();
/** onmessage: (bytes, handler ms). */
const messages = new Series();
/** fetch: (start, ms to the response). */
const fetches = new Series();
/** longtask: (start, duration ms). */
const longTasks = new Series();

let glOn = false;
let glMs = 0;
let glCalls = 0;
const glByName = new Map<string, { calls: number; ms: number }>();
const glOriginals = new Map<string, unknown>();

const raf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
  raf((ts) => {
    const t0 = now();
    const g0 = glMs;
    const c0 = glCalls;
    try {
      cb(ts);
    } finally {
      frames.push(ts, now() - t0);
      if (glOn) frameGl.push(glMs - g0, glCalls - c0);
    }
  });

const onmessage = Object.getOwnPropertyDescriptor(
  WebSocket.prototype,
  "onmessage",
);
if (onmessage?.set && onmessage.get) {
  const { get, set } = onmessage;
  Object.defineProperty(WebSocket.prototype, "onmessage", {
    configurable: true,
    enumerable: onmessage.enumerable,
    get() {
      return get.call(this);
    },
    set(fn: ((ev: MessageEvent) => unknown) | null) {
      set.call(
        this,
        fn
          ? function (this: WebSocket, ev: MessageEvent) {
              const t0 = now();
              try {
                return fn.call(this, ev);
              } finally {
                const d = ev.data as ArrayBuffer | string;
                messages.push(
                  typeof d === "string" ? d.length : d.byteLength,
                  now() - t0,
                );
              }
            }
          : null,
      );
    },
  });
}

const fetchOrig = window.fetch.bind(window);
window.fetch = async (...args: Parameters<typeof fetch>) => {
  const t0 = now();
  const r = await fetchOrig(...args);
  fetches.push(t0, now() - t0);
  return r;
};

try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push(e.startTime, e.duration);
  }).observe({ type: "longtask", buffered: false });
} catch {
  // no longtask support: the series stays empty
}

function setGl(on: boolean) {
  const proto = WebGL2RenderingContext.prototype as unknown as Record<
    string,
    unknown
  >;
  if (on && !glOn) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || typeof d.value !== "function" || name === "constructor")
        continue;
      const f = d.value as (...a: unknown[]) => unknown;
      glOriginals.set(name, f);
      const r = glByName.get(name) ?? { calls: 0, ms: 0 };
      glByName.set(name, r);
      proto[name] = function (this: unknown, ...a: unknown[]) {
        const t0 = now();
        try {
          return f.apply(this, a);
        } finally {
          const dt = now() - t0;
          glMs += dt;
          glCalls++;
          r.calls++;
          r.ms += dt;
        }
      };
    }
    glOn = true;
  } else if (!on && glOn) {
    for (const [name, f] of glOriginals) proto[name] = f;
    glOriginals.clear();
    glOn = false;
  }
}

export const probe = {
  crossOriginIsolated: self.crossOriginIsolated,
  take() {
    return {
      frames: frames.take(),
      frameGl: frameGl.take(),
      messages: messages.take(),
      fetches: fetches.take(),
      longTasks: longTasks.take(),
    };
  },
  gl(on: boolean) {
    setGl(on);
    const out = {
      ms: glMs,
      calls: glCalls,
      byName: [...glByName.entries()]
        .filter(([, v]) => v.calls > 0)
        .map(([k, v]) => ({ name: k, calls: v.calls, ms: v.ms }))
        .sort((x, y) => y.ms - x.ms),
    };
    if (on) {
      // Zero the rows in place: each wrapper holds its own row.
      glMs = 0;
      glCalls = 0;
      for (const row of glByName.values()) {
        row.calls = 0;
        row.ms = 0;
      }
    }
    return out;
  },
};
