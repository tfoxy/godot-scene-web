// G7u's page-side lifecycle shim (protocol/gate7/g7u-as-built.md "The shim"). Injected before
// any page script, only on a leg with RS_RECEIVER_LIFECYCLE (lib/gate7-lifecycle.ts prepends
// `window.__rsLifecycleSpec = {...}`; desktop: page.addInitScript, device:
// Page.addScriptToEvaluateOnNewDocument; both run again on a reload). Plain ES2020, no imports.
//
// window.__rsLifecycle:
//   state()      {spec, done, pages: [record per document, this one last]} (JSON-able)
//   suspended()  true while a simulated OR real suspension is in force
//   pending()    {id, what: "hide"|"freeze"|"close", ms, mechanism} or null: an action the harness
//                must perform; it calls ack(id) when done (a hide/freeze: once restored)
//   ack(id)
//   shellLines() [{navigation, lines}] of the earlier documents' window.__rsShell.lines (a reload)
//
// The trigger is the receiver's own console line `shot step <k> seq <n> frame <f> -> ...` for
// k = spec.step (first occurrence, in the first document only: the action is done once per leg;
// records survive a reload in sessionStorage).
//
// Desktop `suspend` is SIMULATED (headless=new has no occlusion/freeze model, G7h): every rAF
// callback that comes due while suspended is HELD and, on release after `ms`, all run from one real
// rAF (a browser's pending list on resume); `frozen` also defers every WebSocket message/close
// dispatch until release. Nothing here fakes document.visibilityState.
(() => {
  const spec = window.__rsLifecycleSpec;
  if (!spec || window.__rsLifecycle) return;
  const KEY = "__rsLifecycle/1";
  const LINES_KEY = (n) => `${KEY}/lines/${n}`;
  const now = () => performance.now();
  const simulatedEnv = spec.env !== "device";

  let saved = { pages: [], done: false };
  try {
    const text = sessionStorage.getItem(KEY);
    if (text) saved = JSON.parse(text);
  } catch (_) {
    // no sessionStorage: a single-document record
  }
  const navigation = saved.pages.length + 1;
  const rec = {
    time_origin: performance.timeOrigin,
    navigation,
    trigger: null,
    window: null,
    raf: {
      total: 0,
      during: 0,
      held: 0,
      first_after_t: null,
      after_intervals_ms: [],
      // device only: performance.now() of each callback run inside the window (the first 100),
      // so a real hide's edge callbacks (a new foreground tab runs a few right after `hidden`)
      // are told from callbacks inside it
      ...(simulatedEnv ? {} : { during_t: [] }),
    },
    timers_during: 0,
    ws_events_deferred: 0,
    visibility: [{ t: now(), state: document.visibilityState }],
    lifecycle_events: [],
    context: null,
    errors: [],
  };
  let done = saved.done === true;
  let pending = null;
  let pendingSeq = 0;
  let simulated = false; // a simulated hold in force (rAF held)
  let wsDefer = false; // simulated frozen: WebSocket message/close deferred
  let pagehideStashed = false;

  const persist = () => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ pages: saved.pages, done }));
    } catch (e) {
      rec.errors.push(`sessionStorage: ${String(e)}`);
    }
  };
  const inWindow = () =>
    rec.window !== null &&
    rec.window.start_t !== null &&
    rec.window.end_t === null;

  // --- rAF ------------------------------------------------------------------------------------
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  let nextId = 1;
  const liveIds = new Map(); // shim id -> real id
  const cancelled = new Set();
  let held = []; // [shim id, callback]
  let lastAfterTs = null;
  const noteFrame = (ts) => {
    const w = rec.window;
    if (!w || w.end_t === null || ts < w.end_t - 20) return;
    if (rec.raf.first_after_t === null) {
      // performance.now() when it ran (the frame timestamp `ts` is the frame's begin time, which
      // can precede the release itself); the intervals below are frame-timestamp deltas.
      rec.raf.first_after_t = now();
      lastAfterTs = ts;
      return;
    }
    if (ts !== lastAfterTs && rec.raf.after_intervals_ms.length < 10) {
      rec.raf.after_intervals_ms.push(
        Math.round((ts - lastAfterTs) * 1000) / 1000,
      );
      lastAfterTs = ts;
    }
  };
  const runCallback = (id, cb, ts) => {
    if (cancelled.delete(id)) return;
    rec.raf.total++;
    if (inWindow()) {
      rec.raf.during++;
      if (rec.raf.during_t && rec.raf.during_t.length < 100)
        rec.raf.during_t.push(now());
    }
    noteFrame(ts);
    cb(ts);
  };
  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    const id = nextId++;
    if (simulated) {
      held.push([id, cb]);
      rec.raf.held++;
      return id;
    }
    const realId = realRaf((ts) => {
      liveIds.delete(id);
      if (simulated) {
        held.push([id, cb]);
        rec.raf.held++;
        return;
      }
      runCallback(id, cb, ts);
    });
    liveIds.set(id, realId);
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    const realId = liveIds.get(id);
    if (realId !== undefined) {
      liveIds.delete(id);
      realCancel(realId);
      return;
    }
    if (held.some((h) => h[0] === id)) cancelled.add(id);
  };

  // --- timers probe (frozen evidence) ---------------------------------------------------------
  setInterval(() => {
    if (inWindow()) rec.timers_during++;
  }, 50);

  // --- WebSocket deferral (simulated frozen only) ---------------------------------------------
  const wsQueue = [];
  if (
    simulatedEnv &&
    spec.action === "suspend" &&
    spec.suspend_kind === "frozen"
  ) {
    const WSP = window.WebSocket.prototype;
    const DEFERRED = new Set(["message", "close"]);
    const call = (fn, target, ev) => {
      if (typeof fn === "function") fn.call(target, ev);
      else if (fn && typeof fn.handleEvent === "function") fn.handleEvent(ev);
    };
    const wrap = (target, fn) =>
      function deferred(ev) {
        if (wsDefer) {
          rec.ws_events_deferred++;
          wsQueue.push(() => call(fn, target, ev));
          return;
        }
        call(fn, target, ev);
      };
    const wrappers = new WeakMap(); // listener -> Map<type, wrapper>
    const add = WSP.addEventListener;
    const remove = WSP.removeEventListener;
    WSP.addEventListener = function addEventListener(type, fn, options) {
      if (!DEFERRED.has(type) || !fn) return add.call(this, type, fn, options);
      let byType = wrappers.get(fn);
      if (!byType) {
        byType = new Map();
        wrappers.set(fn, byType);
      }
      let w = byType.get(type);
      if (!w) {
        w = wrap(this, fn);
        byType.set(type, w);
      }
      return add.call(this, type, w, options);
    };
    WSP.removeEventListener = function removeEventListener(type, fn, options) {
      const w = fn && wrappers.get(fn)?.get(type);
      return remove.call(this, type, w || fn, options);
    };
    for (const type of DEFERRED) {
      const prop = `on${type}`;
      const desc = Object.getOwnPropertyDescriptor(WSP, prop);
      if (!desc || !desc.set) continue;
      const own = new WeakMap(); // socket -> the page's own handler
      Object.defineProperty(WSP, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          return own.has(this) ? own.get(this) : null;
        },
        set(fn) {
          own.set(this, typeof fn === "function" ? fn : null);
          desc.set.call(this, typeof fn === "function" ? wrap(this, fn) : null);
        },
      });
    }
  }

  // --- events ---------------------------------------------------------------------------------
  document.addEventListener("visibilitychange", () => {
    const t = now();
    const state = document.visibilityState;
    rec.visibility.push({ t, state });
    const w = rec.window;
    if (!simulatedEnv && w && w.end_t === null) {
      if (state === "hidden" && w.start_t === null) w.start_t = t;
      else if (state === "visible" && w.start_t !== null) w.end_t = t;
    }
  });
  const lifecycleEvent = (type) => () => {
    const t = now();
    rec.lifecycle_events.push({ t, type });
    const w = rec.window;
    if (
      !simulatedEnv &&
      w &&
      w.end_t === null &&
      spec.suspend_kind === "frozen"
    ) {
      if (type === "freeze" && w.start_t === null) w.start_t = t;
      else if (type === "resume" && w.start_t !== null) w.end_t = t;
    }
  };
  document.addEventListener("freeze", lifecycleEvent("freeze"));
  document.addEventListener("resume", lifecycleEvent("resume"));
  window.addEventListener("pageshow", lifecycleEvent("pageshow"));
  window.addEventListener("pagehide", () => {
    lifecycleEvent("pagehide")();
    stash();
  });
  // webglcontextlost/restored do not bubble, but a capturing window listener sees every canvas's.
  window.addEventListener(
    "webglcontextlost",
    () => {
      rec.context = rec.context || { lost_t: null, restored_t: null };
      if (rec.context.lost_t === null) rec.context.lost_t = now();
    },
    true,
  );
  window.addEventListener(
    "webglcontextrestored",
    () => {
      rec.context = rec.context || { lost_t: null, restored_t: null };
      rec.context.restored_t = now();
    },
    true,
  );

  // This document's record (and the shell's lines) into sessionStorage before it goes away.
  function stash() {
    if (pagehideStashed) return;
    pagehideStashed = true;
    saved.pages.push(rec);
    persist();
    const lines = (window.__rsShell && window.__rsShell.lines) || [];
    for (const keep of [lines.length, 5000, 1000]) {
      try {
        sessionStorage.setItem(
          LINES_KEY(navigation),
          JSON.stringify(lines.slice(-keep)),
        );
        break;
      } catch (_) {
        // over the quota: keep fewer (the newest)
      }
    }
  }

  // --- actions --------------------------------------------------------------------------------
  const post = (what, ms) => {
    pending = {
      id: ++pendingSeq,
      what,
      ms,
      mechanism: spec.mechanism_hint || null,
    };
    return pending;
  };
  const release = () => {
    const w = rec.window;
    if (!w || w.end_t !== null) return;
    w.end_t = now();
    simulated = false;
    wsDefer = false;
    const queued = wsQueue.splice(0, wsQueue.length);
    for (const run of queued) {
      try {
        run();
      } catch (e) {
        setTimeout(() => {
          throw e;
        });
      }
    }
    realRaf((ts) => {
      const list = held;
      held = [];
      for (const [id, cb] of list) runCallback(id, cb, ts);
    });
  };
  const act = () => {
    const t = now();
    switch (spec.action) {
      case "suspend":
        rec.window = { requested_t: t, start_t: null, end_t: null };
        if (simulatedEnv) {
          rec.window.start_t = t;
          simulated = true;
          wsDefer = spec.suspend_kind === "frozen";
          setTimeout(release, spec.ms);
        } else {
          post(spec.suspend_kind === "frozen" ? "freeze" : "hide", spec.ms);
        }
        break;
      case "reload":
        persist();
        location.reload();
        break;
      case "close":
        post("close", 0);
        break;
      case "context-loss": {
        const canvas = document.querySelector("canvas");
        const gl =
          canvas && (canvas.getContext("webgl2") || canvas.getContext("webgl"));
        const ext = gl && gl.getExtension("WEBGL_lose_context");
        if (!ext) {
          rec.errors.push(
            "context-loss: no WEBGL_lose_context on the receiver canvas",
          );
          break;
        }
        rec.context = rec.context || { lost_t: null, restored_t: null };
        ext.loseContext();
        setTimeout(() => {
          try {
            ext.restoreContext();
          } catch (e) {
            rec.errors.push(`restoreContext: ${String(e)}`);
          }
        }, spec.restore_ms);
        break;
      }
      default:
        rec.errors.push(`unknown action ${spec.action}`);
    }
  };

  // --- the trigger: the receiver's `shot step <k> seq <n> frame <f> -> ...` -------------------
  const TRIGGER = /shot step (\d+) seq (\d+) frame (-?\d+) -> /;
  for (const level of ["log", "info", "debug"]) {
    const original = console[level];
    console[level] = function (...args) {
      if (!done && rec.trigger === null && typeof args[0] === "string") {
        const m = TRIGGER.exec(args.join(" "));
        if (m && Number(m[1]) === spec.step) {
          rec.trigger = {
            line: args.join(" "),
            step: Number(m[1]),
            seq: Number(m[2]),
            frame: Number(m[3]),
            t: now(),
          };
          done = true;
          persist();
          setTimeout(act, 0);
        }
      }
      return original.apply(this, args);
    };
  }

  window.__rsLifecycle = {
    state: () => ({
      spec,
      done,
      pages: [...saved.pages, ...(pagehideStashed ? [] : [rec])],
    }),
    suspended: () => {
      if (simulated) return true;
      const w = rec.window;
      return (
        !simulatedEnv && w !== null && w.end_t === null && pending !== null
      );
    },
    pending: () => pending,
    ack: (id) => {
      if (!pending || pending.id !== id) return false;
      const what = pending.what;
      pending = null;
      const w = rec.window;
      if ((what === "hide" || what === "freeze") && w && w.end_t === null)
        w.end_t = now();
      return true;
    },
    shellLines: () => {
      const out = [];
      for (let n = 1; n < navigation; n++) {
        try {
          out.push({
            navigation: n,
            lines: JSON.parse(sessionStorage.getItem(LINES_KEY(n)) || "[]"),
          });
        } catch (_) {
          out.push({ navigation: n, lines: [] });
        }
      }
      return out;
    },
  };
})();
