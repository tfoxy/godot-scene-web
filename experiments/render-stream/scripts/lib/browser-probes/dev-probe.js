// G7v dev probe (gate7-design.md Q13b "Watchdog", Q13c "Measured per repeat", Q13d checks): the
// harness injects this before any page script on every g7-dev leg, desktop (`ctl-`) and device
// (`dev-`), for both browser receivers alike (page.addInitScript /
// Page.addScriptToEvaluateOnNewDocument). It changes no receiver behaviour; it only times what the
// page's main thread already runs:
//
//   - every requestAnimationFrame callback: its timestamp argument, start and duration
//     (performance.now()), so T_p (the median rAF interval), the max rAF gap and the per-callback
//     main-thread work come from one clock for both receivers (the web export runs one Godot
//     main-loop iteration per callback);
//   - every WebSocket `message` handler: start and duration (GSW decodes in onmessage);
//   - the page's hidden time (visibilitychange) and the first WebSocket message (the stream's
//     start on the page clock);
//   - once a second, the JS heap (performance.memory, where present) and the receiver's wasm heap
//     (window.__rsWasmHeap), for the soak;
//   - FIT=1 (device legs only): Godot's `keep` rule on the largest canvas, as perf-harness fit.ts
//     does on a phone: the backing store stays the presentation size and the CSS size is scaled
//     to fit the viewport (Q13a "Presentation is CSS-fitted"), re-applied once a second.
//
// window.__rsDevProbe.report() returns everything as arrays of numbers; the harness writes it to
// dev-probe.json beside the leg's other evidence.
(() => {
  if (window.__rsDevProbe) return;
  const FIT = /*FIT*/ false;
  const now = () => performance.now();
  const raf = []; // flat: ts, start, dur
  const ws = []; // flat: start, dur
  const mem = []; // flat: t, js_heap_used (or -1), wasm_heap (or -1)
  const fits = [];
  let firstWsMs = -1;
  let hiddenMs = 0;
  let hiddenSince = document.visibilityState === "hidden" ? now() : -1;
  const visibility = [];
  document.addEventListener(
    "visibilitychange",
    () => {
      const t = now();
      visibility.push([t, document.visibilityState === "hidden" ? 1 : 0]);
      if (document.visibilityState === "hidden") {
        if (hiddenSince < 0) hiddenSince = t;
      } else if (hiddenSince >= 0) {
        hiddenMs += t - hiddenSince;
        hiddenSince = -1;
      }
    },
    true,
  );

  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    origRaf((ts) => {
      const s = now();
      try {
        cb(ts);
      } finally {
        raf.push(ts, s, now() - s);
      }
    });

  const timed = (fn) =>
    function (ev) {
      const s = now();
      if (firstWsMs < 0) firstWsMs = s;
      try {
        return fn.call(this, ev);
      } finally {
        ws.push(s, now() - s);
      }
    };
  const wrapped = new WeakMap();
  const WS = window.WebSocket;
  if (WS) {
    const proto = WS.prototype;
    const add = proto.addEventListener;
    const remove = proto.removeEventListener;
    proto.addEventListener = function (type, listener, opts) {
      if (type === "message" && typeof listener === "function") {
        let w = wrapped.get(listener);
        if (!w) {
          w = timed(listener);
          wrapped.set(listener, w);
        }
        return add.call(this, type, w, opts);
      }
      return add.call(this, type, listener, opts);
    };
    proto.removeEventListener = function (type, listener, opts) {
      if (type === "message" && wrapped.has(listener))
        return remove.call(this, type, wrapped.get(listener), opts);
      return remove.call(this, type, listener, opts);
    };
    const desc = Object.getOwnPropertyDescriptor(proto, "onmessage");
    if (desc && desc.set && desc.get) {
      Object.defineProperty(proto, "onmessage", {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          return desc.get.call(this);
        },
        set(fn) {
          desc.set.call(this, typeof fn === "function" ? timed(fn) : fn);
        },
      });
    }
  }

  const fit = () => {
    const canvases = [...document.querySelectorAll("canvas")];
    if (canvases.length === 0) return;
    const c = canvases.reduce((a, b) =>
      a.width * a.height >= b.width * b.height ? a : b,
    );
    if (!c.width || !c.height) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(vw / c.width, vh / c.height);
    const w = `${Math.floor(c.width * scale)}px`;
    const h = `${Math.floor(c.height * scale)}px`;
    if (
      c.style.getPropertyValue("width") === w &&
      c.style.getPropertyPriority("width") === "important" &&
      c.style.getPropertyValue("height") === h
    )
      return;
    c.style.setProperty("width", w, "important");
    c.style.setProperty("height", h, "important");
    fits.push({
      t: now(),
      backing: [c.width, c.height],
      viewport: [vw, vh],
      css: [Math.floor(c.width * scale), Math.floor(c.height * scale)],
      scale,
      dpr: window.devicePixelRatio,
    });
  };

  setInterval(() => {
    const m = performance.memory;
    let wasm = -1;
    try {
      wasm = window.__rsWasmHeap ? window.__rsWasmHeap() : -1;
    } catch {
      wasm = -1;
    }
    mem.push(now(), m ? m.usedJSHeapSize : -1, wasm ?? -1);
    if (FIT) fit();
  }, 1000);
  if (FIT) {
    new MutationObserver(() => fit()).observe(document, {
      childList: true,
      subtree: true,
    });
  }

  window.__rsDevProbe = {
    report: () => ({
      schema: "render-stream-gate7-dev-probe/1",
      fit_applied: FIT,
      raf,
      ws,
      mem,
      fits,
      first_ws_ms: firstWsMs,
      hidden_ms: hiddenMs + (hiddenSince >= 0 ? now() - hiddenSince : 0),
      visibility,
      now_ms: now(),
    }),
  };
})();
