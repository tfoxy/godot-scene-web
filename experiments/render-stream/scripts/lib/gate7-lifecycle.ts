// G7u (suspension and lifecycle; protocol/gate7/g7u.md, g7u-as-built.md): the harness half of a
// lifecycle leg. A native leg's RS_RECEIVER_LIFECYCLE word is a HARNESS word (mapBrowserLeg drops
// it from the page env and returns it parsed here); on such a leg runBrowserLeg injects
// browser-probes/lifecycle-shim.js before any page script and drives it through a LifecycleDriver:
// it polls `__rsLifecycle.pending()`/`state()` with the exit poll, performs the actions only a
// harness can (close the tab; on the device: hide and freeze for real), and at leg end writes
// `<receiver dir>/lifecycle.json` (schema render-stream-lifecycle/1) and
// `<receiver dir>/compositor/screenshot.png` (the canvas, CSS-pixel clip, at exit).
//
//   RS_RECEIVER_LIFECYCLE=suspend:<hidden|frozen>:<step>:<ms>[:<tab|home>]
//                        reload:<step>   close:<step>   context-loss:<step>:<restore ms>
//
// <step> is the trigger: the receiver's own `shot step <k> seq <n> frame <f> -> ...` line for
// k = step. Desktop (GATE7_LIFECYCLE_ENV unset or `desktop`): the shim SIMULATES a suspension
// (`simulated-suspension`, never a pass of hidden/frozen) and does reload and context loss itself;
// the harness only closes. Device (GATE7_LIFECYCLE_ENV=device, GATE7_DEVICE=<id>): the shim posts
// `hide`/`freeze` and the harness performs them for real through deviceLifecycleActions, on the
// browser daemon's device mode (lib/gate7-device-legs.ts; g7u-as-built.md "As built, part D").

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CDPSession, Page } from "@playwright/test";

import type { CdpClient } from "../../../../packages/perf-harness/src/cdp";
import type { Adb } from "../../../../packages/perf-harness/src/device";

export type LifecycleAction = "suspend" | "reload" | "close" | "context-loss";
export type SuspendKind = "hidden" | "frozen";
export type HideMechanism = "tab" | "home";
export type LifecycleEnv = "desktop" | "device";

/** The parsed RS_RECEIVER_LIFECYCLE word (lifecycle.json `spec`). */
export interface LifecycleSpec {
  action: LifecycleAction;
  suspend_kind: SuspendKind | null;
  step: number;
  /** suspend: the suspension's length. */
  ms: number | null;
  /** context-loss: restoreContext() this long after loseContext(). */
  restore_ms: number | null;
  /** suspend hidden on the device: `tab` (a new foreground tab, the default) or `home`. */
  mechanism_hint: HideMechanism | null;
}

const nonNegInt = (text: string | undefined, what: string): number => {
  if (text === undefined || !/^\d+$/.test(text))
    throw new Error(
      `RS_RECEIVER_LIFECYCLE: ${what} must be a non-negative integer (got ${JSON.stringify(text)})`,
    );
  return Number(text);
};

/** Parses RS_RECEIVER_LIFECYCLE (header); throws on anything else. */
export function parseLifecycleSpec(text: string): LifecycleSpec {
  const parts = text.trim().split(":");
  const [action] = parts;
  const arity = (min: number, max: number): void => {
    if (parts.length < min || parts.length > max)
      throw new Error(
        `RS_RECEIVER_LIFECYCLE=${text}: ${action} takes ${min - 1}${max > min ? `-${max - 1}` : ""} fields`,
      );
  };
  switch (action) {
    case "suspend": {
      arity(4, 5);
      const kind = parts[1];
      if (kind !== "hidden" && kind !== "frozen")
        throw new Error(
          `RS_RECEIVER_LIFECYCLE=${text}: suspend kind is hidden or frozen`,
        );
      const ms = nonNegInt(parts[3], "suspend ms");
      if (ms === 0)
        throw new Error(
          `RS_RECEIVER_LIFECYCLE=${text}: suspend ms must be > 0`,
        );
      let hint: HideMechanism | null = null;
      if (parts[4] !== undefined) {
        if (kind !== "hidden" || (parts[4] !== "tab" && parts[4] !== "home"))
          throw new Error(
            `RS_RECEIVER_LIFECYCLE=${text}: the mechanism is tab or home, hidden only`,
          );
        hint = parts[4];
      } else if (kind === "hidden") {
        hint = "tab";
      }
      return {
        action,
        suspend_kind: kind,
        step: nonNegInt(parts[2], "step"),
        ms,
        restore_ms: null,
        mechanism_hint: hint,
      };
    }
    case "reload":
    case "close":
      arity(2, 2);
      return {
        action,
        suspend_kind: null,
        step: nonNegInt(parts[1], "step"),
        ms: null,
        restore_ms: null,
        mechanism_hint: null,
      };
    case "context-loss":
      arity(3, 3);
      return {
        action,
        suspend_kind: null,
        step: nonNegInt(parts[1], "step"),
        ms: null,
        restore_ms: nonNegInt(parts[2], "restore ms"),
        mechanism_hint: null,
      };
    default:
      throw new Error(
        `RS_RECEIVER_LIFECYCLE=${text}: the action is suspend, reload, close or context-loss`,
      );
  }
}

/** lifecycle.json `mechanism`. */
export function lifecycleMechanism(
  spec: LifecycleSpec,
  env: LifecycleEnv,
): string {
  switch (spec.action) {
    case "suspend":
      if (env === "desktop") return "simulated-suspension";
      if (spec.suspend_kind === "frozen")
        return "real-frozen:Page.setWebLifecycleState";
      return spec.mechanism_hint === "home"
        ? "real-hidden:home-key"
        : "real-hidden:new-foreground-tab";
    case "reload":
      return "location.reload";
    case "close":
      return "tab-close";
    case "context-loss":
      return "WEBGL_lose_context";
  }
}

/** GATE7_LIFECYCLE_ENV / GATE7_DEVICE (run-gate7.sh --env device with g7-lc). */
export function lifecycleEnvOf(env: NodeJS.ProcessEnv = process.env): {
  env: LifecycleEnv;
  device: string | null;
} {
  const e = env.GATE7_LIFECYCLE_ENV ?? "";
  if (e === "" || e === "desktop") return { env: "desktop", device: null };
  if (e !== "device")
    throw new Error(`GATE7_LIFECYCLE_ENV must be desktop or device (got ${e})`);
  const device = env.GATE7_DEVICE ?? "";
  if (device === "")
    throw new Error(
      "GATE7_LIFECYCLE_ENV=device needs GATE7_DEVICE (the device id)",
    );
  return { env: "device", device };
}

export const LIFECYCLE_SHIM_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "browser-probes",
  "lifecycle-shim.js",
);

/** The init script: the spec (with the env), then the shim. */
export function lifecycleInitScript(
  spec: LifecycleSpec,
  env: LifecycleEnv,
  shimSource: string = readFileSync(LIFECYCLE_SHIM_PATH, "utf8"),
): string {
  return `window.__rsLifecycleSpec = ${JSON.stringify({ ...spec, env })};\n${shimSource}`;
}

/** `__rsLifecycle.pending()`. */
export interface LifecyclePending {
  id: number;
  what: "hide" | "freeze" | "close";
  ms: number;
  mechanism: HideMechanism | null;
}

/** One document's shim record (build notes, `lifecycle.json` `record`). */
export interface LifecycleRecord {
  time_origin: number;
  navigation: number;
  trigger: {
    line: string;
    step: number;
    seq: number;
    frame: number;
    t: number;
  } | null;
  window: {
    requested_t: number;
    start_t: number | null;
    end_t: number | null;
  } | null;
  raf: {
    total: number;
    during: number;
    held: number;
    first_after_t: number | null;
    after_intervals_ms: number[];
    /** device only: performance.now() of each callback run inside the window (the first 100). */
    during_t?: number[];
  };
  timers_during: number;
  ws_events_deferred: number;
  visibility: { t: number; state: string }[];
  lifecycle_events: { t: number; type: string }[];
  context: { lost_t: number | null; restored_t: number | null } | null;
  errors: string[];
}

/** `__rsLifecycle.state()`. */
export interface LifecycleState {
  spec: LifecycleSpec & { env: LifecycleEnv };
  done: boolean;
  pages: LifecycleRecord[];
}

export interface HarnessAction {
  wall_ms: number;
  what: string;
  detail: string;
}

/** What a harness does for a posted `pending()` action. hide/freeze perform the suspension for
 * real, hold it `pending.ms` WITHOUT any page evaluate, restore it, and resolve with a detail
 * string; close() closes the receiver tab. The desktop never gets hide/freeze (the shim simulates
 * them); the device path (DeviceLifecycleActions) is a later agent's. */
export interface LifecycleActions {
  hide(pending: LifecyclePending): Promise<string>;
  freeze(pending: LifecyclePending): Promise<string>;
  close(): Promise<string>;
}

/** Desktop: only close is the harness's. */
export function desktopLifecycleActions(page: Page): LifecycleActions {
  const refuse = (what: string) => (): Promise<string> =>
    Promise.reject(
      new Error(
        `lifecycle: the desktop shim simulates ${what}; a desktop page never posts it`,
      ),
    );
  return {
    hide: refuse("hide"),
    freeze: refuse("freeze"),
    close: async () => {
      await page.close();
      return "page.close()";
    },
  };
}

/** The device's actions (g7u-as-built.md "Device facts (g31 probe)"): hide via
 * `Target.createTarget` about:blank in the receiver tab's browser context (it comes to the front by
 * itself; restore: `Target.activateTarget` + `Page.bringToFront` on the receiver session, then
 * `Target.closeTarget` on the aux tab) or `adb shell input keyevent KEYCODE_HOME` (restore:
 * `am start` Chrome's main activity); freeze via `Page.setWebLifecycleState frozen` (restore:
 * `active`, then a HOME + `am start` round trip, since the page stays hidden after `active`);
 * close via the leg's own tab release (`Target.closeTarget`). `client.sessionId` is the receiver
 * tab's session for the whole leg. Nothing evaluates in the page between the hide and the restore;
 * after the restore the harness waits (short evaluates) until the page reports `visible`. */
export interface DeviceLifecycleContext {
  serial: string;
  client: CdpClient;
  adb: Adb;
  chromePackage: string;
  receiverTargetId: string;
  /** Closes the receiver tab (the leg's target lease). */
  closeTab: () => Promise<void>;
  /** Re-applies the harness's session settings (the landscape lock) and says what it did. */
  reassertSession: () => Promise<string>;
}

/** Whether the browser daemon can run device lifecycle legs (run-gate7.sh asks before any build,
 * through `gate7-tool.ts lifecycle-env-check`; the daemon refuses too). */
export const DEVICE_LIFECYCLE_SUPPORT: { ok: boolean; reason: string } = {
  ok: true,
  reason:
    "the browser daemon's device mode (lib/gate7-device-legs.ts) drives the phone's real Chrome",
};

/** Chrome's launcher activity (`am start -n <package>/<this>`). */
export const CHROME_MAIN_ACTIVITY = "com.google.android.apps.chrome.Main";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** After a restore: polls `document.visibilityState` (short evaluates) until `visible`. */
async function waitVisible(
  client: CdpClient,
  maxMs: number,
): Promise<{ state: string; ms: number }> {
  const t0 = Date.now();
  let state = "no-answer";
  while (Date.now() - t0 < maxMs) {
    state = await client
      .evaluate<string>("document.visibilityState", { timeoutMs: 1500 })
      .catch(() => "no-answer");
    if (state === "visible") break;
    await sleep(100);
  }
  return { state, ms: Date.now() - t0 };
}

/** After a HOME round trip: polls the page until its viewport is landscape again. */
export async function waitLandscape(
  client: CdpClient,
  maxMs: number,
): Promise<{ ok: boolean; size: string; ms: number }> {
  const t0 = Date.now();
  let size = "no-answer";
  while (Date.now() - t0 < maxMs) {
    const wh = await client
      .evaluate<[number, number]>("[window.innerWidth, window.innerHeight]", {
        timeoutMs: 1500,
      })
      .catch(() => null);
    if (wh) {
      size = `${wh[0]}x${wh[1]}`;
      if (wh[0] > wh[1]) return { ok: true, size, ms: Date.now() - t0 };
    }
    await sleep(200);
  }
  return { ok: false, size, ms: Date.now() - t0 };
}

export function deviceLifecycleActions(
  ctx: DeviceLifecycleContext,
): LifecycleActions {
  const { client, adb } = ctx;
  const amStart = `am start -n ${ctx.chromePackage}/${CHROME_MAIN_ACTIVITY}`;
  const bringBack = async (steps: string[], t0: number): Promise<void> => {
    let v = await waitVisible(client, 4000);
    steps.push(`visible: ${v.state} after ${v.ms} ms (+${Date.now() - t0} ms)`);
    if (v.state === "visible") return;
    await client
      .send(
        "Target.activateTarget",
        { targetId: ctx.receiverTargetId },
        { flat: true },
      )
      .catch((e) => steps.push(`activateTarget: ${String(e)}`));
    await client
      .send("Page.bringToFront")
      .catch((e) => steps.push(`bringToFront: ${String(e)}`));
    v = await waitVisible(client, 4000);
    steps.push(
      `activateTarget + bringToFront fallback: ${v.state} after ${v.ms} ms (+${Date.now() - t0} ms)`,
    );
  };
  const homeRoundTrip = async (
    steps: string[],
    t0: number,
    holdUntil: number | null,
  ): Promise<void> => {
    await adb.shell("input keyevent KEYCODE_HOME");
    steps.push(`input keyevent KEYCODE_HOME (+${Date.now() - t0} ms)`);
    await sleep(holdUntil !== null ? holdUntil - Date.now() : 1500);
    // Device fact (device-gsw, 2026-10-18): the g31's portrait-only launcher rewrites
    // `system user_rotation` to 0 under the harness's landscape lock, so the lock is re-applied
    // while the launcher is in front, before Chrome comes back.
    steps.push(
      await ctx.reassertSession().catch((e) => `reassert: ${String(e)}`),
    );
    const tR = Date.now();
    await adb.shell(amStart);
    steps.push(`${amStart} (+${tR - t0} ms, took ${Date.now() - tR} ms)`);
    await bringBack(steps, t0);
    const o = await waitLandscape(client, 5000);
    steps.push(`landscape: ${o.ok} (${o.size}) after ${o.ms} ms`);
  };
  return {
    async hide(pending) {
      const t0 = Date.now();
      const steps: string[] = [];
      if (pending.mechanism === "home") {
        await homeRoundTrip(steps, t0, t0 + pending.ms);
        return `real-hidden:home-key ${pending.ms} ms: ${steps.join("; ")}`;
      }
      const info = await client
        .send<{ targetInfo: { browserContextId?: string } }>(
          "Target.getTargetInfo",
          { targetId: ctx.receiverTargetId },
          { flat: true },
        )
        .catch(() => null);
      const browserContextId = info?.targetInfo.browserContextId;
      const { targetId: aux } = await client.send<{ targetId: string }>(
        "Target.createTarget",
        {
          url: "about:blank",
          ...(browserContextId ? { browserContextId } : {}),
        },
        { flat: true },
      );
      steps.push(
        `Target.createTarget about:blank${browserContextId ? " in the receiver's browser context" : ""} (+${Date.now() - t0} ms)`,
      );
      await sleep(t0 + pending.ms - Date.now());
      const tR = Date.now();
      await client
        .send(
          "Target.activateTarget",
          { targetId: ctx.receiverTargetId },
          { flat: true },
        )
        .catch((e) => steps.push(`activateTarget: ${String(e)}`));
      await client
        .send("Page.bringToFront")
        .catch((e) => steps.push(`bringToFront: ${String(e)}`));
      steps.push(
        `Target.activateTarget + Page.bringToFront (+${tR - t0} ms, took ${Date.now() - tR} ms)`,
      );
      await client
        .send("Target.closeTarget", { targetId: aux }, { flat: true })
        .then(() => steps.push("aux tab closed"))
        .catch((e) => steps.push(`closeTarget aux: ${String(e)}`));
      await bringBack(steps, t0);
      return `real-hidden:new-foreground-tab ${pending.ms} ms: ${steps.join("; ")}`;
    },
    async freeze(pending) {
      const t0 = Date.now();
      const steps: string[] = [];
      await client.send("Page.setWebLifecycleState", { state: "frozen" });
      steps.push(`Page.setWebLifecycleState frozen (+${Date.now() - t0} ms)`);
      await sleep(t0 + pending.ms - Date.now());
      const tR = Date.now();
      await client
        .send("Page.setWebLifecycleState", { state: "active" })
        .catch((e) => steps.push(`active: ${String(e)}`));
      steps.push(`Page.setWebLifecycleState active (+${tR - t0} ms)`);
      // Device fact: the page stays hidden after `active` until a HOME + am start round trip.
      const v = await waitVisible(client, 1000);
      steps.push(`after active: ${v.state} after ${v.ms} ms`);
      if (v.state !== "visible") await homeRoundTrip(steps, t0, null);
      return `real-frozen:Page.setWebLifecycleState ${pending.ms} ms: ${steps.join("; ")}`;
    },
    async close() {
      await ctx.closeTab();
      return "Target.closeTarget (the receiver tab)";
    },
  };
}

/** A real hide's rAF callbacks inside the window, told apart (g31 probe: a new foreground tab runs
 * a few callbacks right after `hidden`): `inside` ran strictly after start_t + edge ms (and before
 * end_t, as `during` counts), `edge` within edge ms of start_t. Without `during_t` (a desktop
 * record) every callback counted in `during` is inside. Pure. The edge is 150 ms: on the g31 the
 * renderer keeps its 60-Hz frames for ~90 ms after `hidden` (6 callbacks over 87 ms, dev-d-gsw1
 * hidden-2s; ~80 ms in the probe), then none until `visible`; a page whose rAF never stops still
 * runs ~110 callbacks after the edge of a 2-s hide. */
export const REAL_HIDE_EDGE_MS = 150;
export function rafInsideWindow(
  rec: Pick<LifecycleRecord, "raf" | "window">,
  edgeMs = REAL_HIDE_EDGE_MS,
): { inside: number; edge: number; edge_t: number[] } {
  const w = rec.window;
  const ts = rec.raf.during_t;
  if (!ts || !w || w.start_t === null)
    return { inside: rec.raf.during, edge: 0, edge_t: [] };
  const start = w.start_t;
  const edge_t = ts.filter((t) => t <= start + edgeMs);
  // during_t keeps the first 100; anything past that is inside.
  return {
    inside: rec.raf.during - edge_t.length,
    edge: edge_t.length,
    edge_t,
  };
}

/** lifecycle.json (build notes). */
export interface LifecycleEvidence {
  schema: "render-stream-lifecycle/1";
  leg: string;
  kind: "gsw" | "web";
  env: LifecycleEnv;
  spec: LifecycleSpec;
  simulated: boolean;
  mechanism: string;
  pages: LifecycleRecord[];
  took_effect: boolean;
  took_effect_detail: string;
  harness: { actions: HarnessAction[] };
  device: null | {
    serial: string;
    model: string | null;
    chrome: string | null;
    conditions_before: unknown;
    conditions_after: unknown;
    /** perf-harness's target isolation for the leg's tab (browser-context on the g31). */
    isolation?: string;
    /** RS_FIXTURE_START_FRAME when a device run raised S (null: the leg's own S). */
    fixture_start_frame?: number | null;
  };
  compositor: string | null;
}

/** took_effect / took_effect_detail from the page's own records (never a CDP reply). */
export function tookEffect(
  spec: LifecycleSpec,
  env: LifecycleEnv,
  pages: LifecycleRecord[],
  actions: HarnessAction[],
): { ok: boolean; detail: string } {
  const first = pages[0];
  const triggered = pages.find((p) => p.trigger !== null);
  if (!triggered)
    return {
      ok: false,
      detail: `the trigger (shot step ${spec.step}) never appeared`,
    };
  switch (spec.action) {
    case "suspend": {
      const w = triggered.window;
      if (!w) return { ok: false, detail: "no suspension window recorded" };
      if (env === "desktop") {
        const ok = w.start_t !== null && w.end_t !== null;
        return {
          ok,
          detail: ok
            ? `simulated-suspension: the shim held ${triggered.raf.held} rAF callbacks${spec.suspend_kind === "frozen" ? ` and deferred ${triggered.ws_events_deferred} WebSocket events` : ""} for ${Math.round((w.end_t as number) - (w.start_t as number))} ms`
            : "the simulated suspension never ended",
        };
      }
      if (spec.suspend_kind === "hidden") {
        const hidden = triggered.visibility.some(
          (v) =>
            v.state === "hidden" &&
            v.t >= w.requested_t &&
            (w.end_t === null || v.t <= w.end_t),
        );
        const r = rafInsideWindow(triggered);
        const ok = hidden && r.inside === 0;
        return {
          ok,
          detail: `visibility hidden inside the window: ${hidden}; rAF during: ${r.inside} inside${r.edge > 0 ? ` (+${r.edge} at the window's start edge, within ${REAL_HIDE_EDGE_MS} ms of hidden)` : ""}`,
        };
      }
      const types = new Set(triggered.lifecycle_events.map((e) => e.type));
      const events = types.has("freeze") && types.has("resume");
      const quiet = triggered.raf.during === 0 && triggered.timers_during === 0;
      return {
        ok: events || quiet,
        detail: `freeze+resume events: ${events}; rAF during ${triggered.raf.during}, timers during ${triggered.timers_during}`,
      };
    }
    case "reload":
      return {
        ok: pages.length >= 2,
        detail: `${pages.length} document(s)`,
      };
    case "close": {
      const closed = actions.some((a) => a.what === "close");
      return {
        ok: closed,
        detail: closed
          ? "the harness closed the tab"
          : "the tab was never closed",
      };
    }
    case "context-loss": {
      const lost = first?.context?.lost_t ?? null;
      const restored = first?.context?.restored_t ?? null;
      return {
        ok: lost !== null,
        detail: `lost at ${lost ?? "never"}, restored at ${restored ?? "never"}${pages.length >= 2 ? `; the page reloaded (${pages.length} documents)` : ""}`,
      };
    }
  }
}

export function buildLifecycleEvidence(args: {
  leg: string;
  kind: "gsw" | "web";
  env: LifecycleEnv;
  spec: LifecycleSpec;
  state: LifecycleState | null;
  actions: HarnessAction[];
  compositor: string | null;
  device?: LifecycleEvidence["device"];
}): LifecycleEvidence {
  const pages = args.state?.pages ?? [];
  const effect = tookEffect(args.spec, args.env, pages, args.actions);
  return {
    schema: "render-stream-lifecycle/1",
    leg: args.leg,
    kind: args.kind,
    env: args.env,
    spec: args.spec,
    simulated: args.env === "desktop" && args.spec.action === "suspend",
    mechanism: lifecycleMechanism(args.spec, args.env),
    pages,
    took_effect: effect.ok,
    took_effect_detail: args.state
      ? effect.detail
      : "the shim's state was never read",
    harness: { actions: args.actions },
    device: args.device ?? null,
    compositor: args.compositor,
  };
}

/** The lifecycle half of one runBrowserLeg (header). */
export class LifecycleDriver {
  readonly actions: HarnessAction[] = [];
  state: LifecycleState | null = null;
  /** The earlier documents' shell lines (a reload), read at the end. */
  earlierLines: {
    navigation: number;
    lines: { t: number; stream: string; line: string }[];
  }[] = [];
  compositor: string | null = null;
  closed = false;
  /** lifecycle.json `device` (the device daemon sets it; null on the desktop). */
  device: LifecycleEvidence["device"] = null;

  constructor(
    readonly spec: LifecycleSpec,
    readonly env: LifecycleEnv,
    readonly kind: "gsw" | "web",
    /** The receiver leg directory (`<leg>/receiver`): lifecycle.json and compositor/ go here. */
    readonly dir: string,
    readonly canvas: [number, number],
  ) {}

  get leg(): string {
    return basename(dirname(this.dir));
  }

  initScript(): string {
    return lifecycleInitScript(this.spec, this.env);
  }

  record(what: string, detail: string): void {
    this.actions.push({ wall_ms: Date.now(), what, detail });
  }

  /** One poll (the exit poll's evaluate), tolerant of a navigation in flight (null). */
  static async poll(page: Page): Promise<{
    exit: { code: number; t: number } | null;
    error: string | null;
    pending: LifecyclePending | null;
    state: LifecycleState | null;
  } | null> {
    return page
      .evaluate(() => {
        const lc = (
          window as unknown as {
            __rsLifecycle?: {
              pending: () => unknown;
              state: () => unknown;
            };
          }
        ).__rsLifecycle;
        return {
          exit: window.__rsShell?.exit ?? null,
          error: window.__rsShell?.error ?? null,
          pending: (lc?.pending() ?? null) as never,
          state: (lc?.state() ?? null) as never,
        };
      })
      .catch(() => null);
  }

  /** Performs a posted action; true when the tab is gone (close). */
  async perform(
    page: Page,
    pending: LifecyclePending,
    actions: LifecycleActions,
    beforeClose: () => Promise<void>,
  ): Promise<boolean> {
    if (pending.what === "close") {
      this.record("close-requested", `pending ${pending.id}`);
      await beforeClose();
      const detail = await actions.close();
      this.record("close", detail);
      this.closed = true;
      return true;
    }
    const detail =
      pending.what === "hide"
        ? await actions.hide(pending)
        : await actions.freeze(pending);
    this.record(pending.what, detail);
    await page
      .evaluate(
        (id) =>
          (
            window as unknown as {
              __rsLifecycle?: { ack: (id: number) => boolean };
            }
          ).__rsLifecycle?.ack(id) ?? false,
        pending.id,
      )
      .catch(() => false);
    return false;
  }

  /** The final state and the earlier documents' shell lines (call while the page is open). */
  async readFinal(page: Page): Promise<void> {
    const got = await page
      .evaluate(() => {
        const lc = (
          window as unknown as {
            __rsLifecycle?: { state: () => unknown; shellLines: () => unknown };
          }
        ).__rsLifecycle;
        return lc
          ? { state: lc.state() as never, lines: lc.shellLines() as never }
          : null;
      })
      .catch(() => null);
    if (got) {
      this.state = got.state;
      this.earlierLines = got.lines;
    }
  }

  /** compositor/screenshot.png: the canvas (CSS-pixel clip), now. */
  async screenshot(page: Page, session: CDPSession): Promise<void> {
    try {
      const rect = await page
        .evaluate(() => {
          const c = document.querySelector("canvas");
          if (!c) return null;
          const r = c.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })
        .catch(() => null);
      const clip = rect ?? {
        x: 0,
        y: 0,
        width: this.canvas[0],
        height: this.canvas[1],
      };
      const shot = (await session.send("Page.captureScreenshot", {
        format: "png",
        clip: { ...clip, scale: 1 },
        captureBeyondViewport: false,
      })) as { data: string };
      await mkdir(join(this.dir, "compositor"), { recursive: true });
      await writeFile(
        join(this.dir, "compositor", "screenshot.png"),
        Buffer.from(shot.data, "base64"),
      );
      this.compositor = "compositor/screenshot.png";
      this.record(
        "screenshot",
        `Page.captureScreenshot clip ${clip.x},${clip.y} ${clip.width}x${clip.height}`,
      );
    } catch (err) {
      this.record("screenshot-failed", String(err));
    }
  }

  async write(): Promise<LifecycleEvidence> {
    const evidence = buildLifecycleEvidence({
      leg: this.leg,
      kind: this.kind,
      env: this.env,
      spec: this.spec,
      state: this.state,
      actions: this.actions,
      compositor: this.compositor,
      device: this.device,
    });
    await writeFile(
      join(this.dir, "lifecycle.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    return evidence;
  }
}
