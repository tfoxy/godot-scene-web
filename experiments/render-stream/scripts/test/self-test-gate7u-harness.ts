#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for G7u's harness half (never a browser, a host or a Godot run):
//
//  1. parseLifecycleSpec (lib/gate7-lifecycle.ts) reads every RS_RECEIVER_LIFECYCLE word of the
//     g7u-as-built.md legs table and refuses malformed ones; lifecycleMechanism names the
//     desktop's simulated suspension and the device's real mechanisms; lifecycleEnvOf needs a
//     device id on GATE7_LIFECYCLE_ENV=device.
//  2. mapBrowserLeg (lib/gate7-live-legs.ts) drops RS_RECEIVER_LIFECYCLE and
//     RS_RECEIVER_SHELL_SABOTAGE from the page env (listed in `dropped`), returns them as
//     `lifecycle` / `shellSabotage`, refuses an unknown shell sabotage, and leaves a leg without
//     them exactly as before (both null, nothing extra dropped).
//  3. lifecycle-shim.js, run in a node:vm fake page: the trigger line starts a simulated
//     suspension that holds every rAF callback (none run during the window), releases them all
//     from one real rAF after `ms`, and records the window, the held count and the frames after;
//     a frozen one also defers WebSocket message events to the release; close posts `pending()`;
//     a reload stashes the record and the shell's lines in sessionStorage for the next document,
//     which does not act again.
//  4. tookEffect: simulated true only once the window ended; reload needs two documents; a leg
//     whose trigger never appeared did not take effect.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { consoleText } from "../lib/gate7-device-legs";
import {
  LIFECYCLE_SHIM_PATH,
  type LifecycleRecord,
  lifecycleEnvOf,
  lifecycleInitScript,
  lifecycleMechanism,
  parseLifecycleSpec,
  rafInsideWindow,
  tookEffect,
} from "../lib/gate7-lifecycle";
import { mapBrowserLeg } from "../lib/gate7-live-legs";

let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`,
  );
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// 1. parseLifecycleSpec / lifecycleMechanism / lifecycleEnvOf
const hidden2 = parseLifecycleSpec("suspend:hidden:2:2000");
expect(
  "suspend:hidden:2:2000 (mechanism defaults to tab)",
  JSON.stringify(hidden2) ===
    JSON.stringify({
      action: "suspend",
      suspend_kind: "hidden",
      step: 2,
      ms: 2000,
      restore_ms: null,
      mechanism_hint: "tab",
    }),
  JSON.stringify(hidden2),
);
const hidden30 = parseLifecycleSpec("suspend:hidden:2:30000:home");
expect(
  "suspend:hidden:2:30000:home",
  hidden30.ms === 30000 && hidden30.mechanism_hint === "home",
);
const frozen = parseLifecycleSpec("suspend:frozen:2:30000");
expect(
  "suspend:frozen:2:30000 (no mechanism hint)",
  frozen.suspend_kind === "frozen" && frozen.mechanism_hint === null,
);
const reload = parseLifecycleSpec("reload:5");
const close = parseLifecycleSpec("close:5");
const loss = parseLifecycleSpec("context-loss:5:500");
expect(
  "reload:5, close:5, context-loss:5:500",
  reload.action === "reload" &&
    reload.step === 5 &&
    close.action === "close" &&
    loss.action === "context-loss" &&
    loss.restore_ms === 500 &&
    loss.ms === null,
);
for (const bad of [
  "",
  "pause:2",
  "suspend:hidden:2",
  "suspend:asleep:2:2000",
  "suspend:hidden:2:0",
  "suspend:frozen:2:2000:home",
  "suspend:hidden:2:2000:window",
  "suspend:hidden:x:2000",
  "reload",
  "reload:5:1",
  "close:-1",
  "context-loss:5",
]) {
  expect(
    `refused: ${JSON.stringify(bad)}`,
    throws(() => parseLifecycleSpec(bad)),
  );
}
expect(
  "mechanisms: desktop simulated, device real per kind/hint",
  lifecycleMechanism(hidden2, "desktop") === "simulated-suspension" &&
    lifecycleMechanism(frozen, "desktop") === "simulated-suspension" &&
    lifecycleMechanism(hidden2, "device") ===
      "real-hidden:new-foreground-tab" &&
    lifecycleMechanism(hidden30, "device") === "real-hidden:home-key" &&
    lifecycleMechanism(frozen, "device") ===
      "real-frozen:Page.setWebLifecycleState" &&
    lifecycleMechanism(reload, "desktop") === "location.reload" &&
    lifecycleMechanism(close, "device") === "tab-close" &&
    lifecycleMechanism(loss, "desktop") === "WEBGL_lose_context",
);
expect(
  "lifecycleEnvOf: unset/desktop is desktop; device needs GATE7_DEVICE",
  lifecycleEnvOf({}).env === "desktop" &&
    lifecycleEnvOf({ GATE7_LIFECYCLE_ENV: "desktop" }).env === "desktop" &&
    lifecycleEnvOf({ GATE7_LIFECYCLE_ENV: "device", GATE7_DEVICE: "g31" })
      .device === "g31" &&
    throws(() => lifecycleEnvOf({ GATE7_LIFECYCLE_ENV: "device" })) &&
    throws(() => lifecycleEnvOf({ GATE7_LIFECYCLE_ENV: "phone" })),
);

// 2. mapBrowserLeg
const root = "/runs/lc";
const baseEnv: Array<[string, string]> = [
  ["RS_RECEIVER_MODE", "live"],
  ["RS_RECEIVER_URL", "ws://127.0.0.1:4000/render-stream"],
  ["RS_RECEIVER_OUT", `${root}/live/x/receiver/applied.json`],
  ["RS_RECEIVER_SHOT_FINAL", "1"],
];
const argv = ["/bin/godot", "--path", "/receiver", "--max-fps", "60"];
const lcLeg = mapBrowserLeg(
  root,
  [
    ...baseEnv,
    ["RS_RECEIVER_LIFECYCLE", "suspend:hidden:2:2000"],
    ["RS_RECEIVER_SHELL_SABOTAGE", "css-opacity"],
    ["RS_RECEIVER_SABOTAGE", "ack-while-hidden"],
  ],
  argv,
);
expect(
  "lc leg: both harness words dropped from the page env and listed in dropped",
  lcLeg.env.RS_RECEIVER_LIFECYCLE === undefined &&
    lcLeg.env.RS_RECEIVER_SHELL_SABOTAGE === undefined &&
    lcLeg.dropped.includes("RS_RECEIVER_LIFECYCLE") &&
    lcLeg.dropped.includes("RS_RECEIVER_SHELL_SABOTAGE"),
  JSON.stringify(lcLeg.dropped),
);
expect(
  "lc leg: lifecycle parsed, shell sabotage returned, receiver words kept",
  JSON.stringify(lcLeg.lifecycle) === JSON.stringify(hidden2) &&
    lcLeg.shellSabotage === "css-opacity" &&
    lcLeg.env.RS_RECEIVER_SABOTAGE === "ack-while-hidden" &&
    lcLeg.env.RS_RECEIVER_SHOT_FINAL === "1",
);
const plain = mapBrowserLeg(root, baseEnv, argv);
expect(
  "a leg without them: lifecycle and shellSabotage null, nothing dropped",
  plain.lifecycle === null &&
    plain.shellSabotage === null &&
    plain.dropped.length === 0,
  JSON.stringify(plain.dropped),
);
expect(
  "an unknown shell sabotage or a malformed lifecycle word is refused",
  throws(() =>
    mapBrowserLeg(
      root,
      [...baseEnv, ["RS_RECEIVER_SHELL_SABOTAGE", "opacity"]],
      argv,
    ),
  ) &&
    throws(() =>
      mapBrowserLeg(
        root,
        [...baseEnv, ["RS_RECEIVER_LIFECYCLE", "suspend:hidden"]],
        argv,
      ),
    ),
);

// 3. The shim in a fake page.
const shimSource = readFileSync(LIFECYCLE_SHIM_PATH, "utf8");
const script = lifecycleInitScript(hidden2, "desktop", shimSource);
expect(
  "init script: the spec (with env) first, then the shim",
  script.startsWith(
    `window.__rsLifecycleSpec = ${JSON.stringify({ ...hidden2, env: "desktop" })};\n`,
  ) && script.endsWith(shimSource),
);

interface FakePage {
  win: Record<string, unknown> & {
    __rsLifecycle: {
      state: () => { pages: LifecycleRecord[]; done: boolean };
      suspended: () => boolean;
      pending: () => { id: number; what: string } | null;
      ack: (id: number) => boolean;
      shellLines: () => { navigation: number; lines: { line: string }[] }[];
    };
    requestAnimationFrame: (cb: (t: number) => void) => number;
    console: { log: (...a: unknown[]) => void };
    __rsShell: { lines: { t: number; stream: string; line: string }[] };
  };
  /** Advances fake time by `ms`, running timers, and one real frame every 16 ms. */
  advance: (ms: number) => void;
  dispatch: (target: "window" | "document", type: string) => void;
  reloads: number;
  now: () => number;
  frames: number;
}

function fakePage(
  spec: string,
  storage: Map<string, string>,
  extra: Record<string, unknown> = {},
): FakePage {
  let t = 0;
  let frames = 0;
  let timerSeq = 0;
  const timers = new Map<
    number,
    { at: number; fn: () => void; every: number | null }
  >();
  let rafQueue: Array<(ts: number) => void> = [];
  const listeners: Record<string, Map<string, Array<(e: unknown) => void>>> = {
    window: new Map(),
    document: new Map(),
  };
  const on =
    (where: "window" | "document") =>
    (type: string, fn: (e: unknown) => void): void => {
      const list = listeners[where].get(type) ?? [];
      list.push(fn);
      listeners[where].set(type, list);
    };
  const page: FakePage = {
    win: {} as FakePage["win"],
    reloads: 0,
    now: () => t,
    frames: 0,
    advance: (ms: number) => {
      const end = t + ms;
      while (t < end) {
        t += 1;
        for (const [id, timer] of [...timers]) {
          if (timer.at <= t) {
            if (timer.every === null) timers.delete(id);
            else timer.at += timer.every;
            timer.fn();
          }
        }
        if (t % 16 === 0) {
          frames++;
          page.frames = frames;
          const q = rafQueue;
          rafQueue = [];
          for (const cb of q) cb(t);
        }
      }
    },
    dispatch: (where, type) => {
      for (const fn of listeners[where].get(type) ?? []) fn({ type });
    },
  };
  const consoleLog = (): void => {};
  const win: Record<string, unknown> = {
    __rsLifecycleSpec: undefined,
    performance: { now: () => t, timeOrigin: 1000 },
    requestAnimationFrame: (cb: (ts: number) => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => {},
    setTimeout: (fn: () => void, ms = 0) => {
      const id = ++timerSeq;
      timers.set(id, { at: t + Math.max(1, ms), fn, every: null });
      return id;
    },
    setInterval: (fn: () => void, ms: number) => {
      const id = ++timerSeq;
      timers.set(id, { at: t + ms, fn, every: ms });
      return id;
    },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    },
    location: {
      reload: () => {
        page.reloads++;
        page.dispatch("window", "pagehide");
      },
    },
    document: {
      visibilityState: "visible",
      addEventListener: on("document"),
      querySelector: () => null,
    },
    addEventListener: on("window"),
    console: { log: consoleLog, info: consoleLog, debug: consoleLog },
    __rsShell: { lines: [] },
    ...extra,
  };
  win.window = win;
  page.win = win as FakePage["win"];
  runInNewContext(
    lifecycleInitScript(parseLifecycleSpec(spec), "desktop", shimSource),
    win,
  );
  return page;
}

// A Godot-like main loop: one rAF callback per frame, re-requested from inside itself.
function mainLoop(page: FakePage): number[] {
  const runs: number[] = [];
  const tick = (ts: number): void => {
    runs.push(ts);
    page.win.requestAnimationFrame(tick);
  };
  page.win.requestAnimationFrame(tick);
  return runs;
}
const trigger = (page: FakePage, step: number): void => {
  const line = `[receiver] shot step ${step} seq ${40 + step} frame ${427 + step} -> /x/shots/step-${step}.png`;
  page.win.__rsShell.lines.push({ t: page.now(), stream: "out", line });
  page.win.console.log(line);
};

{
  const page = fakePage("suspend:hidden:2:2000", new Map());
  const runs = mainLoop(page);
  page.advance(500);
  trigger(page, 1); // not the step
  page.advance(100);
  expect(
    "step 1 does not trigger step 2's action",
    !page.win.__rsLifecycle.suspended(),
  );
  trigger(page, 2);
  page.advance(2); // the action runs on a fresh task
  const before = runs.length;
  expect(
    "the trigger line starts a simulated suspension",
    page.win.__rsLifecycle.suspended(),
  );
  page.advance(1990);
  const during = runs.length - before;
  page.advance(200);
  const rec = page.win.__rsLifecycle.state().pages[0];
  expect(
    "no rAF callback runs during the window; they run again after it",
    during === 0 &&
      runs.length > before + 5 &&
      !page.win.__rsLifecycle.suspended(),
    `during ${during}, after ${runs.length - before}`,
  );
  expect(
    "record: trigger, window ~2000 ms, raf.during 0, held >= 1, frames after",
    rec.trigger?.step === 2 &&
      rec.trigger.seq === 42 &&
      rec.trigger.frame === 429 &&
      rec.window !== null &&
      rec.window.end_t !== null &&
      rec.window.start_t !== null &&
      Math.abs(rec.window.end_t - rec.window.start_t - 2000) <= 1 &&
      rec.raf.during === 0 &&
      rec.raf.held >= 1 &&
      rec.raf.first_after_t !== null &&
      rec.raf.after_intervals_ms.length === 10 &&
      rec.raf.after_intervals_ms.every((i) => i === 16),
    JSON.stringify(rec),
  );
  expect(
    "timers keep ticking in a simulated hidden window (counted)",
    rec.timers_during >= 35,
    String(rec.timers_during),
  );
  trigger(page, 2);
  page.advance(100);
  expect(
    "the action is done once (a second step-2 line does nothing)",
    !page.win.__rsLifecycle.suspended() &&
      page.win.__rsLifecycle.state().pages[0].trigger?.t === rec.trigger?.t,
  );
  const effect = tookEffect(hidden2, "desktop", [rec], []);
  expect("tookEffect: simulated, ended", effect.ok, effect.detail);
}

{
  // A frozen one defers WebSocket message events to the release.
  const delivered: number[] = [];
  class FakeWebSocket {
    listeners: Array<(e: unknown) => void> = [];
    addEventListener(_type: string, fn: (e: unknown) => void): void {
      this.listeners.push(fn);
    }
    removeEventListener(): void {}
    fire(n: number): void {
      for (const fn of this.listeners) fn({ data: n });
    }
  }
  const page = fakePage("suspend:frozen:2:3000", new Map(), {
    WebSocket: FakeWebSocket,
  });
  const ws = new FakeWebSocket();
  ws.addEventListener("message", (e) =>
    delivered.push((e as { data: number }).data),
  );
  mainLoop(page);
  ws.fire(1);
  trigger(page, 2);
  page.advance(5);
  ws.fire(2);
  ws.fire(3);
  page.advance(1000);
  const mid = delivered.length;
  page.advance(2100);
  const rec = page.win.__rsLifecycle.state().pages[0];
  expect(
    "frozen: messages during the window are deferred, then delivered in order",
    mid === 1 &&
      JSON.stringify(delivered) === "[1,2,3]" &&
      rec.ws_events_deferred === 2,
    `mid ${mid}, delivered ${JSON.stringify(delivered)}, deferred ${rec.ws_events_deferred}`,
  );
}

{
  const page = fakePage("close:5", new Map());
  mainLoop(page);
  trigger(page, 5);
  page.advance(5);
  const pending = page.win.__rsLifecycle.pending();
  expect("close posts pending() = close", pending?.what === "close");
  expect(
    "ack(id) clears it",
    pending !== null &&
      page.win.__rsLifecycle.ack(pending.id) &&
      page.win.__rsLifecycle.pending() === null,
  );
}

{
  const storage = new Map<string, string>();
  const first = fakePage("reload:5", storage);
  mainLoop(first);
  trigger(first, 5);
  first.advance(5);
  expect("reload: location.reload() once", first.reloads === 1);
  const second = fakePage("reload:5", storage);
  mainLoop(second);
  trigger(second, 5);
  second.advance(50);
  const st = second.win.__rsLifecycle.state();
  const lines = second.win.__rsLifecycle.shellLines();
  expect(
    "reload: the next document sees the first's record and lines, and does not act again",
    second.reloads === 0 &&
      st.pages.length === 2 &&
      st.pages[0].navigation === 1 &&
      st.pages[1].navigation === 2 &&
      st.pages[0].trigger?.step === 5 &&
      st.pages[1].trigger === null &&
      lines.length === 1 &&
      lines[0].lines.length === 1 &&
      lines[0].lines[0].line.includes("shot step 5"),
    JSON.stringify({ pages: st.pages.length, lines }),
  );
  const effect = tookEffect(reload, "desktop", st.pages, []);
  expect("tookEffect: reload with two documents", effect.ok, effect.detail);
}

// 4. tookEffect edge cases.
const blank: LifecycleRecord = {
  time_origin: 0,
  navigation: 1,
  trigger: null,
  window: null,
  raf: {
    total: 0,
    during: 0,
    held: 0,
    first_after_t: null,
    after_intervals_ms: [],
  },
  timers_during: 0,
  ws_events_deferred: 0,
  visibility: [],
  lifecycle_events: [],
  context: null,
  errors: [],
};
expect(
  "tookEffect: no trigger, no effect",
  !tookEffect(hidden2, "desktop", [blank], []).ok,
);
const unended: LifecycleRecord = {
  ...blank,
  trigger: { line: "x", step: 2, seq: 1, frame: 1, t: 1 },
  window: { requested_t: 1, start_t: 1, end_t: null },
};
expect(
  "tookEffect: a simulated window that never ended did not take effect",
  !tookEffect(hidden2, "desktop", [unended], []).ok,
);
expect(
  "tookEffect: a real hidden window without a hidden event did not take effect",
  !tookEffect(
    hidden2,
    "device",
    [{ ...unended, window: { requested_t: 1, start_t: null, end_t: 2001 } }],
    [],
  ).ok,
);

// Part D: a real tab hide's start-edge rAFs (device shim `during_t`) are not counted; a later one is.
{
  const edged: LifecycleRecord = {
    ...unended,
    window: { requested_t: 1, start_t: 10, end_t: 2010 },
    visibility: [
      { t: 10, state: "hidden" },
      { t: 2010, state: "visible" },
    ],
    raf: { ...blank.raf, during: 3, during_t: [12, 30, 55] },
  };
  const e = tookEffect(hidden2, "device", [edged], []);
  expect(
    "tookEffect (device): start-edge rAFs are reported, not counted",
    e.ok && /3 at the window's start edge/.test(e.detail),
    e.detail,
  );
  const late = {
    ...edged,
    raf: { ...edged.raf, during: 4, during_t: [12, 30, 55, 900] },
  };
  expect(
    "tookEffect (device): a rAF inside the hidden window fails",
    !tookEffect(hidden2, "device", [late], []).ok &&
      rafInsideWindow(late).inside === 1,
  );
  expect(
    "rafInsideWindow: a desktop record (no during_t) counts every callback",
    rafInsideWindow({ ...edged, raf: { ...blank.raf, during: 2 } }).inside ===
      2,
  );
  expect(
    "consoleText: CDP console args joined as Playwright's text()",
    consoleText([
      { type: "string", value: "shot step 2" },
      { type: "number", value: 7 },
      { type: "object", description: "Object" },
    ]) === "shot step 2 7 Object",
  );
}

console.log(
  failures === 0
    ? "self-test-gate7u-harness: all checks correct"
    : `self-test-gate7u-harness: ${failures} FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
