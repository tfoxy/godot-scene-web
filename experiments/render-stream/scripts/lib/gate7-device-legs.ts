// G7u part D (g7u-as-built.md "As built, part D"): the browser daemon's DEVICE mode. Under
// GATE7_LIFECYCLE_ENV=device / GATE7_DEVICE=<id> (run-gate7.sh --live --legs g7-lc --env device
// --device <id>), `gate7-tool.ts browser-daemon` runs each lifecycle leg on the phone's real Chrome
// instead of a desktop headless Chromium:
//
//   - one device harness per daemon (browser-harness.ts openHarnessDevice, the device table's
//     entry): `adb reverse` of the page port (GATE7_HARNESS_PORT, the harness server each leg
//     starts) and of GATE7_HOST_PORT (every live host), so the page reaches both at 127.0.0.1;
//     the session settings are applied once and restored when the daemon exits;
//   - per leg: a fresh tab (perf-harness's isolation ladder: a new browser context on the g31's
//     Chrome 154), `device-provenance` (checkDeviceProvenance) on its about:blank written as
//     provenance.json, the lifecycle shim through Page.addScriptToEvaluateOnNewDocument BEFORE the
//     navigation, console capture through Runtime.consoleAPICalled / Runtime.exceptionThrown, and
//     the same files as the desktop leg (console.jsonl, stdout.log, timings.json, env.txt,
//     argv.txt, page-config.json, exit-code.txt, lifecycle.json);
//   - the exit poll pauses while a hide or freeze is in force (the action holds it without any
//     page evaluate, lib/gate7-lifecycle.ts deviceLifecycleActions), the tab is closed at the end
//     (or by the `close` leg's action), and lifecycle.json's `device` block holds the battery %,
//     temperature and thermal status before and after the leg;
//   - no compositor screenshot: a capture at the phone's DPR cannot equal the 640x360 readback, so
//     `compositor-equals-readback` is typed `unavailable` on device legs by the checker.
//
// Only lifecycle legs run here: any other leg is refused (the device run is g7-lc alone).

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";

import type { TargetLease } from "../../../../packages/perf-harness/src/browser";
import {
  checkDeviceProvenance,
  DEVICE_PAGE_FACTS_EXPRESSION,
  type DeviceHarness,
  type DeviceId,
  type DevicePageFacts,
  type DeviceProvenance,
  HarnessServer,
  linkTo,
  loadDeviceTable,
  openHarnessDevice,
} from "./browser-harness";
import {
  deviceLifecycleActions,
  LifecycleDriver,
  type LifecyclePending,
  type LifecycleState,
  lifecycleEnvOf,
} from "./gate7-lifecycle";
import { DeviceSampler, type SamplerTimeline } from "./device-sampler";
import {
  DEV_PROBE_REPORT_EXPRESSION,
  devProbeScript,
  type BrowserLegRequest,
  type BrowserRunContext,
  webPageEnv,
  type LegHandle,
  mapBrowserLeg,
} from "./gate7-live-legs";
import { base64url, parseEnvTxt } from "./gate7-web-legs";

/** The daemon's phone: one harness, its ports, and the console sink of the leg running now. */
export interface DeviceRig {
  id: DeviceId;
  harness: DeviceHarness;
  pagePort: number;
  hostPort: number;
  /** The running leg's CDP event sink (filtered by its session), or null between legs. */
  /** G7v: the tab a startup-warm leg kept open for the next one (RS_RECEIVER_DEV_KEEP_TAB). */
  keptTab: PreparedDeviceTab | null;
  sink: {
    sessionId: string;
    console: (params: Record<string, unknown>) => void;
    exception: (params: Record<string, unknown>) => void;
    dialog: (params: Record<string, unknown>) => void;
  } | null;
}

const portOf = (name: string): number => {
  const v = Number(process.env[name] ?? "");
  if (!Number.isInteger(v) || v <= 0 || v > 65535)
    throw new Error(
      `lifecycle: the device daemon needs ${name} (got ${process.env[name] ?? "<unset>"})`,
    );
  return v;
};

/** Opens GATE7_DEVICE's phone for the daemon (header). */
export async function openDeviceRig(
  log: (line: string) => void,
): Promise<DeviceRig> {
  const { device } = lifecycleEnvOf();
  if (!device)
    throw new Error("lifecycle: the device daemon needs GATE7_DEVICE");
  const table = loadDeviceTable();
  const entry = table[device];
  if (!entry)
    throw new Error(
      `lifecycle: GATE7_DEVICE=${device} is not in the device table (known: ${Object.keys(table).join(", ")})`,
    );
  const pagePort = portOf("GATE7_HARNESS_PORT");
  const hostPort = portOf("GATE7_HOST_PORT");
  const harness = await openHarnessDevice({
    id: device as DeviceId,
    entry,
    serverPort: pagePort,
    extraReversePorts: [hostPort],
    onProgress: (m) => log(`browser-daemon: device: ${m}`),
  });
  const rig: DeviceRig = {
    id: device as DeviceId,
    harness,
    pagePort,
    hostPort,
    keptTab: null,
    sink: null,
  };
  const client = harness.browser.client;
  client.on("Runtime.consoleAPICalled", (p, sid) => {
    if (rig.sink && sid === rig.sink.sessionId) rig.sink.console(p);
  });
  client.on("Runtime.exceptionThrown", (p, sid) => {
    if (rig.sink && sid === rig.sink.sessionId) rig.sink.exception(p);
  });
  client.on("Page.javascriptDialogOpening", (p, sid) => {
    if (rig.sink && sid === rig.sink.sessionId) rig.sink.dialog(p);
  });
  return rig;
}

interface RemoteObject {
  type?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

/** Playwright's ConsoleMessage.text() for CDP args: the values, space-joined. */
export function consoleText(args: readonly RemoteObject[]): string {
  return args
    .map((a) =>
      a.value !== undefined
        ? typeof a.value === "string"
          ? a.value
          : JSON.stringify(a.value)
        : (a.unserializableValue ?? a.description ?? String(a.type ?? "")),
    )
    .join(" ");
}

/** The desktop leg's PageState, as one expression (gate7-live-legs.ts readState). */
const READ_STATE_EXPRESSION = `(() => ({
  lines: (window.__rsShell && window.__rsShell.lines) || [],
  error: (window.__rsShell && window.__rsShell.error) || null,
  exit: (window.__rsShell && window.__rsShell.exit) || null,
  contextLost: (window.__rsShell && window.__rsShell.contextLost) || false,
  wasmHeapBytes: window.__rsWasmHeap ? window.__rsWasmHeap() : null,
  backingStore: {
    device_pixel_ratio: window.devicePixelRatio,
    inner: [window.innerWidth, window.innerHeight],
    canvases: [...document.querySelectorAll("canvas")].map((c) => ({
      width: c.width, height: c.height, client_width: c.clientWidth, client_height: c.clientHeight,
    })),
  },
  marks: performance.getEntriesByType("mark").map((m) => ({ name: m.name, t: m.startTime })),
  navigation: performance.getEntriesByType("navigation").map((n) => n.toJSON()),
  resources: performance.getEntriesByType("resource").map((e) => ({
    name: e.name, start: e.startTime, end: e.responseEnd, transfer: e.transferSize, decoded: e.decodedBodySize,
  })),
}))()`;

const POLL_EXPRESSION = `(() => {
  const lc = window.__rsLifecycle;
  return {
    exit: (window.__rsShell && window.__rsShell.exit) || null,
    error: (window.__rsShell && window.__rsShell.error) || null,
    pending: lc ? lc.pending() : null,
    state: lc ? lc.state() : null,
  };
})()`;

const FINAL_EXPRESSION = `(() => {
  const lc = window.__rsLifecycle;
  return lc ? { state: lc.state(), lines: lc.shellLines() } : null;
})()`;

interface DevicePageState {
  lines: { t: number; stream: string; line: string }[];
  error: string | null;
  exit: { code: number; t: number } | null;
  contextLost: boolean;
  wasmHeapBytes: number | null;
  backingStore: unknown;
  marks: { name: string; t: number }[];
  navigation: unknown[];
  resources: unknown[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Re-applies the harness's landscape lock (D28's recorded session settings) when something on
 * the phone changed it: the g31's portrait-only launcher rewrites `system user_rotation` to 0 on
 * every HOME. Restoring at the daemon's exit still writes each setting's recorded `before`. */
export async function reassertSession(rig: DeviceRig): Promise<string> {
  const settings = rig.harness.settings;
  if (!settings) return "no session settings";
  const adb = rig.harness.browser.adb;
  const done: string[] = [];
  for (const c of settings.changes) {
    if (c.name !== "landscape-lock") continue;
    const now = (
      await adb.shell(`settings get ${c.namespace} ${c.key}`)
    ).trim();
    if (now !== c.applied) {
      await adb.shell(`settings put ${c.namespace} ${c.key} ${c.applied}`);
      done.push(`${c.namespace}/${c.key} ${now}->${c.applied}`);
    }
  }
  return done.length > 0
    ? `landscape lock re-applied: ${done.join(", ")}`
    : "landscape lock held";
}

/** A leg's tab, opened and checked before the leg is asked for (the desktop daemon's spare
 * browser, on the phone): the isolation ladder's fresh tab, the battery/thermal sample, and
 * `device-provenance` on its about:blank (in front, as the receiver will be). */
export interface PreparedDeviceTab {
  lease: TargetLease;
  provenance: DeviceProvenance;
  conditionsBefore: unknown;
  preparedMs: number;
}

export async function prepareDeviceTab(
  rig: DeviceRig,
): Promise<PreparedDeviceTab> {
  const t0 = Date.now();
  const browser = rig.harness.browser;
  const client = browser.client;
  const entry = rig.harness.entry;
  const conditionsBefore = await browser.conditions().catch(() => null);
  await reassertSession(rig).catch(() => "");
  const lease = await browser.targets.acquire({
    width: entry.screen_css_px[0],
    height: entry.screen_css_px[1],
  });
  try {
    const page = {
      evaluate: <T>(
        expression: string,
        opts?: { awaitPromise?: boolean; timeoutMs?: number },
      ) => client.evaluate<T>(expression, opts),
      facts: () =>
        client.evaluate<DevicePageFacts>(DEVICE_PAGE_FACTS_EXPRESSION, {
          timeoutMs: 10_000,
        }),
      close: () => lease.release(),
    };
    let provenance = checkDeviceProvenance(
      entry,
      await rig.harness.facts(page),
    );
    // A rotation still settling (after a HOME round trip) gets a few seconds, never a pass.
    for (
      let tries = 0;
      provenance.refusal === "device-orientation" && tries < 8;
      tries++
    ) {
      await reassertSession(rig).catch(() => "");
      await sleep(1000);
      provenance = checkDeviceProvenance(entry, await rig.harness.facts(page));
    }
    return {
      lease,
      provenance,
      conditionsBefore,
      preparedMs: Date.now() - t0,
    };
  } catch (err) {
    await lease.release().catch(() => {});
    throw err;
  }
}

/** Runs one lifecycle leg on the phone (header) in `prepared`'s tab, which it closes. */
export function runDeviceBrowserLeg(
  ctx: BrowserRunContext,
  req: BrowserLegRequest,
  rig: DeviceRig,
  prepared: Promise<PreparedDeviceTab>,
): LegHandle {
  const log = ctx.log ?? ((line: string) => console.error(line));
  const started = Date.now();
  const dir = resolve(req.dir);
  const staticRoot = resolve(ctx.staticRoot);
  const browser = rig.harness.browser;
  const client = browser.client;
  const consoleLines: string[] = [];
  let exitCode = 124;
  let state: DevicePageState | null = null;
  let aborted = false;
  let finished = false;
  let server: HarnessServer | undefined;
  let token = "";
  let lease: TargetLease | null = null;
  let leaseReleased = false;
  let lifecycle: LifecycleDriver | null = null;
  // G7v: a g7-dev leg's probe mode, its report, and the phone's samplers for the leg.
  let devProbe: "plain" | "fit" | null = null;
  let devProbeReport: unknown = null;
  let devSampler: DevSamplerHandle | null = null;
  const readDevProbe = async (): Promise<void> => {
    if (!devProbe || devProbeReport !== null) return;
    devProbeReport = await client
      .evaluate<unknown>(DEV_PROBE_REPORT_EXPRESSION, { timeoutMs: 30_000 })
      .catch((err: unknown) => ({
        schema: "render-stream-gate7-dev-probe/1",
        error: `no report: ${String(err)}`,
      }));
  };
  let preparedMs = 0;
  let conditionsBefore: unknown = null;
  const scrub = (text: string): string =>
    token !== "" ? text.split(token).join("<token>") : text;
  // G7v: keep this leg's tab for the next (startup-warm) leg instead of closing it.
  let keepTab: PreparedDeviceTab | null = null;
  const releaseTab = async (): Promise<void> => {
    if (!lease || leaseReleased) return;
    leaseReleased = true;
    rig.sink = null;
    if (keepTab && !aborted) {
      rig.keptTab = keepTab;
      return;
    }
    await lease.release().catch(() => {});
  };

  const writeEvidence = async (): Promise<void> => {
    await writeFile(
      join(dir, "console.jsonl"),
      consoleLines.join("\n") + (consoleLines.length ? "\n" : ""),
    );
    const lines = [
      ...(lifecycle?.earlierLines ?? []).flatMap((d) =>
        d.lines.map((l) => ({ ...l, line: scrub(l.line) })),
      ),
      ...(state?.lines ?? []),
    ];
    await writeFile(
      join(dir, "stdout.log"),
      `${lines
        .map((l) => (l.stream === "err" ? `[stderr] ${l.line}` : l.line))
        .join("\n")}\n`,
    );
    if (devProbe)
      await writeFile(
        join(dir, "dev-probe.json"),
        `${JSON.stringify(devProbeReport ?? { schema: "render-stream-gate7-dev-probe/1", error: "no report" })}\n`,
      );
    if (!lifecycle && devProbe) {
      const samples = devSampler ? await devSampler.stop() : null;
      const conditionsAfter = await browser.conditions().catch(() => null);
      await writeFile(
        join(dir, "device.json"),
        `${JSON.stringify(
          {
            schema: "render-stream-gate7-dev-device/1",
            id: rig.id,
            serial: rig.harness.entry.serial,
            model: browser.props.model,
            chrome: browser.chromeVersion,
            isolation: browser.targets.isolation,
            conditions_before: conditionsBefore,
            conditions_after: conditionsAfter,
            samples,
          },
          null,
          2,
        )}\n`,
      );
    }
    if (lifecycle) {
      const conditionsAfter = await browser.conditions().catch(() => null);
      lifecycle.device = {
        serial: rig.harness.entry.serial,
        model: browser.props.model,
        chrome: browser.chromeVersion,
        conditions_before: conditionsBefore,
        conditions_after: conditionsAfter,
        isolation: browser.targets.isolation,
        // run-gate6.sh's G7U_START_FRAME (a device run's raised S), inherited by the daemon.
        fixture_start_frame:
          process.env.G7U_START_FRAME && process.env.G7U_START_FRAME !== "300"
            ? Number(process.env.G7U_START_FRAME)
            : null,
      };
      await lifecycle.write();
    }
    await writeFile(
      join(dir, "timings.json"),
      `${scrub(JSON.stringify({ schema: "render-stream-web-timings/1", wall_ms: Date.now() - started, browser_prepared_ms: preparedMs, exit: state?.exit ?? null, error: state?.error ?? null, context_lost: state?.contextLost ?? false, wasm_heap_bytes: state?.wasmHeapBytes ?? null, backing_store: state?.backingStore ?? null, marks: state?.marks ?? [], navigation: state?.navigation ?? [], resources: state?.resources ?? [], aborted, lines: (state?.lines ?? []).slice(0, 400).map((l) => ({ t: l.t, line: l.line })) }, null, 2))}\n`,
    );
    await writeFile(join(dir, "exit-code.txt"), `${exitCode}\n`);
  };

  const run = async (): Promise<number> => {
    if (req.port !== rig.pagePort)
      throw new Error(
        `lifecycle: the device daemon reversed page port ${rig.pagePort} onto the phone, the leg asks for ${req.port}`,
      );
    const nativeEnv = parseEnvTxt(
      readFileSync(join(dir, "native-env.txt"), "utf8"),
    );
    const nativeArgv = readFileSync(join(dir, "native-argv.txt"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const mapped = mapBrowserLeg(staticRoot, nativeEnv, nativeArgv);
    token = mapped.token;
    // G7v: a leg with neither a lifecycle spec nor the dev probe is not a device leg.
    if (!mapped.lifecycle && !mapped.devProbe)
      throw new Error(
        `device: ${dir}: the device daemon runs lifecycle legs (RS_RECEIVER_LIFECYCLE) and g7-dev legs (RS_RECEIVER_DEV_PROBE) only`,
      );
    if (mapped.warmFrom)
      throw new Error(
        `lifecycle: ${dir}: a warm leg cannot run on the device (no profile to copy)`,
      );
    const outPath = nativeEnv.find(([n]) => n === "RS_RECEIVER_OUT")?.[1];
    if (!outPath) throw new Error(`${dir}: the leg has no RS_RECEIVER_OUT`);
    const evidenceDir = dirname(outPath);
    await mkdir(evidenceDir, { recursive: true });

    const bundleName = ctx.kind === "gsw" ? "gsw-bundle" : "web-bundle";
    const link = join(staticRoot, bundleName);
    linkTo(resolve(ctx.bundleDir), link);
    server = new HarnessServer({
      staticRoot,
      evidenceRoot: join(staticRoot, ".evidence"),
      allowedLegNonces: [],
    });
    const { origin } = await server.start(req.port);
    const nonce = randomBytes(8).toString("hex");
    server.addLeg(nonce, evidenceDir);
    const env: Record<string, string> = {
      ...mapped.env,
      RS_RECEIVER_EVIDENCE_URL: `/evidence/${nonce}`,
      RS_RECEIVER_BUILD_SHA256: ctx.buildSha256,
      ...(ctx.manifestSha256 && mapped.live
        ? { RS_RECEIVER_MANIFEST_SHA256: ctx.manifestSha256 }
        : {}),
      ...webPageEnv(ctx),
    };
    const pageConfig = {
      env,
      engine_args: mapped.engineArgs,
      canvas: mapped.canvas,
      sabotage: mapped.shellSabotage,
    };
    const lc = mapped.lifecycle
      ? new LifecycleDriver(
          mapped.lifecycle,
          "device",
          ctx.kind,
          dir,
          mapped.canvas,
        )
      : null;
    lifecycle = lc;
    devProbe = mapped.devProbe;
    const url = `${origin}/${bundleName}/receiver.html?env=${base64url(JSON.stringify(pageConfig))}`;
    const navigateTo =
      mapped.token !== "" ? `${url}#token=${mapped.token}` : url;

    // The leg's tab (prepared before the leg was asked for: prepareDeviceTab), or, for a G7v
    // startup-warm leg, the tab the previous leg kept (the spare is closed unused).
    let tab: PreparedDeviceTab;
    if (mapped.devTab.warm && rig.keptTab) {
      tab = rig.keptTab;
      rig.keptTab = null;
      void prepared.then((t) => t.lease.release()).catch(() => {});
    } else {
      if (mapped.devTab.warm)
        throw new Error(`${dir}: RS_RECEIVER_DEV_WARM, but no earlier leg kept a tab`);
      tab = await prepared;
    }
    if (mapped.devTab.keep) keepTab = tab;
    lease = tab.lease;
    conditionsBefore = tab.conditionsBefore;
    preparedMs = tab.preparedMs;
    const entry = rig.harness.entry;
    const receiverTargetId = lease.targetId;
    const sessionId = lease.sessionId;
    client.sessionId = sessionId;
    client.targetId = receiverTargetId;
    const provenance = tab.provenance;

    await writeFile(
      join(dir, "page-config.json"),
      `${JSON.stringify(
        {
          url,
          kind: ctx.kind,
          ...(ctx.kind === "web" ? { core: "rust" } : {}),
          origin,
          token: mapped.token !== "" ? "fragment" : null,
          headless_native: mapped.headless,
          profile: null,
          warm_from: null,
          provenance_checked: "before",
          ...pageConfig,
          dropped: mapped.dropped,
          lifecycle: mapped.lifecycle
            ? {
                spec: mapped.lifecycle,
                env: "device",
                injected:
                  "Page.addScriptToEvaluateOnNewDocument(lifecycle-shim.js)",
              }
            : null,
          dev_probe: mapped.devProbe
            ? {
                mode: mapped.devProbe,
                sample: mapped.devSample,
                injected:
                  "Page.addScriptToEvaluateOnNewDocument(dev-probe.js)",
              }
            : null,
          device: {
            id: rig.id,
            serial: entry.serial,
            chrome: browser.chromeVersion,
            isolation: browser.targets.isolation,
            page_port: rig.pagePort,
            host_port: rig.hostPort,
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(dir, "env.txt"),
      `${Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
    );
    await writeFile(
      join(dir, "argv.txt"),
      `${[url, ...mapped.engineArgs].join("\n")}\n`,
    );
    await writeFile(
      join(dir, "provenance.json"),
      `${JSON.stringify({ kind: "device-provenance", ...provenance }, null, 2)}\n`,
    );
    if (!provenance.ok) {
      await writeFile(
        join(dir, "harness-refused.txt"),
        `${provenance.refusal}: ${provenance.reasons.join("; ")}\n`,
      );
      return exitCode;
    }

    rig.sink = {
      sessionId,
      console: (p) =>
        consoleLines.push(
          JSON.stringify({
            t: Date.now(),
            type: String(p.type ?? "log"),
            text: scrub(consoleText((p.args as RemoteObject[]) ?? [])),
          }),
        ),
      exception: (p) => {
        const d = p.exceptionDetails as
          | { text?: string; exception?: RemoteObject }
          | undefined;
        consoleLines.push(
          JSON.stringify({
            t: Date.now(),
            type: "pageerror",
            text: scrub(
              d?.exception?.description ?? d?.text ?? JSON.stringify(d ?? {}),
            ),
          }),
        );
      },
      dialog: (p) => {
        consoleLines.push(
          JSON.stringify({
            t: Date.now(),
            type: "dialog",
            text: scrub(String(p.message ?? "")),
          }),
        );
        client
          .send("Page.handleJavaScriptDialog", { accept: false })
          .catch(() => {});
      },
    };
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    // The shim before any page script (it survives a reload).
    if (lc)
      await client.send("Page.addScriptToEvaluateOnNewDocument", {
        source: lc.initScript(),
      });
    // G7v: the dev probe, likewise (timing only).
    if (mapped.devProbe)
      await client.send("Page.addScriptToEvaluateOnNewDocument", {
        source: devProbeScript(mapped.devProbe),
      });
    if (mapped.devSample) devSampler = await startDevSampler(rig, mapped.devSample);
    await client.send("Page.navigate", { url: navigateTo });
    if (!lc) {
      // G7v: a plain leg (no lifecycle): the desktop leg's exit poll.
      const deadline = Date.now() + req.timeoutMs;
      while (Date.now() < deadline && !aborted) {
        const snap = await client
          .evaluate<{ exit: { code: number } | null; error: string | null }>(
            `(() => ({ exit: (window.__rsShell && window.__rsShell.exit) || null, error: (window.__rsShell && window.__rsShell.error) || null }))()`,
            { timeoutMs: 5000 },
          )
          .catch(() => null);
        if (snap?.exit) {
          exitCode = snap.exit.code;
          break;
        }
        if (snap?.error) break;
        await sleep(250);
      }
      if (aborted) return exitCode;
      state = await client
        .evaluate<DevicePageState>(READ_STATE_EXPRESSION, { timeoutMs: 20_000 })
        .catch(() => null);
      if (state && token !== "")
        state.lines = state.lines.map((l) => ({ ...l, line: scrub(l.line) }));
      await readDevProbe();
      await releaseTab();
      return exitCode;
    }

    const actions = deviceLifecycleActions({
      serial: entry.serial,
      client,
      adb: browser.adb,
      chromePackage: browser.chromePackage ?? "com.android.chrome",
      receiverTargetId,
      closeTab: releaseTab,
      reassertSession: () => reassertSession(rig),
    });
    const readState = (): Promise<DevicePageState | null> =>
      client
        .evaluate<DevicePageState>(READ_STATE_EXPRESSION, { timeoutMs: 20_000 })
        .catch(() => null);
    const readFinal = async (): Promise<void> => {
      const got = await client
        .evaluate<{
          state: LifecycleState;
          lines: LifecycleDriver["earlierLines"];
        } | null>(FINAL_EXPRESSION, { timeoutMs: 20_000 })
        .catch(() => null);
      if (got) {
        lc.state = got.state;
        lc.earlierLines = got.lines;
      }
    };
    const deadline = Date.now() + req.timeoutMs;
    while (Date.now() < deadline && !aborted) {
      const snap = await client
        .evaluate<{
          exit: { code: number; t: number } | null;
          error: string | null;
          pending: LifecyclePending | null;
          state: LifecycleState | null;
        }>(POLL_EXPRESSION, { timeoutMs: 5000 })
        .catch(() => null);
      if (snap?.state) lc.state = snap.state;
      if (snap?.exit) {
        exitCode = snap.exit.code;
        break;
      }
      if (snap?.error) break;
      if (snap?.pending) {
        const p = snap.pending;
        if (p.what === "close") {
          lc.record("close-requested", `pending ${p.id}`);
          await readFinal();
          state = await readState();
          lc.record("close", await actions.close());
          lc.closed = true;
          exitCode = 0;
          break;
        }
        // The exit poll pauses here: the action holds the suspension without any page evaluate.
        const detail =
          p.what === "hide" ? await actions.hide(p) : await actions.freeze(p);
        lc.record(p.what, detail);
        await client
          .evaluate<boolean>(
            `window.__rsLifecycle ? window.__rsLifecycle.ack(${p.id}) : false`,
            { timeoutMs: 5000 },
          )
          .catch(() => false);
        continue;
      }
      await sleep(100);
    }
    if (aborted) return exitCode;
    if (!lc.closed) {
      await readFinal();
      state = await readState();
    }
    if (state && token !== "")
      state.lines = state.lines.map((l) => ({ ...l, line: scrub(l.line) }));
    await releaseTab();
    return exitCode;
  };

  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    await releaseTab();
    await writeEvidence().catch((err) =>
      log(`browser-receiver: writing evidence failed: ${String(err)}`),
    );
    await server?.stop().catch(() => {});
  };

  const done = run()
    .catch(async (err: unknown) => {
      log(`browser-receiver: ${relative(staticRoot, dir)}: ${String(err)}`);
      await writeFile(
        join(dir, "launcher-error.txt"),
        `${String(err)}\n`,
      ).catch(() => {});
      return exitCode;
    })
    .then(async (code) => {
      if (!aborted) {
        await finish();
        log(
          `browser-receiver: ${relative(staticRoot, dir)} exit=${code} (${Date.now() - started} ms, device ${rig.id})`,
        );
      }
      return code;
    });

  const abort = async (): Promise<number> => {
    if (aborted || finished) return exitCode;
    aborted = true;
    exitCode = 143;
    // The phone's browser is not ours to kill: closing the tab is the abnormal end the host sees.
    await releaseTab();
    log(
      `browser-receiver: ${relative(staticRoot, dir)} aborted: closed the receiver tab on ${rig.id}`,
    );
    await finish();
    return exitCode;
  };
  return { done, abort };
}

/** `gate7-tool.ts browser-daemon` under GATE7_LIFECYCLE_ENV=device (header): the desktop daemon's
 * `/run` protocol, one leg at a time on the phone; exits (restoring the phone's session settings)
 * on SIGTERM or when `parentPid` is gone. */
export async function serveDeviceBrowserDaemon(
  ctx: BrowserRunContext,
  readyFile: string,
  parentPid: number,
): Promise<void> {
  const log = ctx.log ?? ((line: string) => console.error(line));
  let rig: DeviceRig;
  try {
    rig = await openDeviceRig(log);
  } catch (err) {
    log(`lifecycle: device: ${String(err)}`);
    process.exit(1);
  }
  let busy = false;
  let current: LegHandle | undefined;
  // The next leg's tab, prepared while no leg runs (never inside a timing leg's window).
  const prepareSpare = (): Promise<PreparedDeviceTab> => {
    const p = prepareDeviceTab(rig);
    p.catch((err) =>
      log(`browser-daemon: preparing a tab failed: ${String(err)}`),
    );
    return p;
  };
  let spare: Promise<PreparedDeviceTab> | null = prepareSpare();
  const takeSpare = (): Promise<PreparedDeviceTab> => {
    const p = spare ?? prepareDeviceTab(rig);
    spare = null;
    return p.catch(() => prepareDeviceTab(rig));
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/run") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (busy) {
      response.writeHead(409);
      response.end("busy\n");
      return;
    }
    const dir = url.searchParams.get("dir") ?? "";
    const port = Number(url.searchParams.get("port"));
    const timeoutS = Number(url.searchParams.get("timeout_s") ?? "180");
    if (!dir.startsWith("/") || !Number.isInteger(port) || port <= 0) {
      response.writeHead(400);
      response.end("dir (absolute) and port are required\n");
      return;
    }
    busy = true;
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    void (async () => {
      let leg: LegHandle | undefined;
      let gone = false;
      response.on("close", () => {
        if (!response.writableEnded) {
          gone = true;
          void leg?.abort();
        }
      });
      try {
        response.write(`started ${dir} (device ${rig.id})\n`);
        leg = runDeviceBrowserLeg(
          ctx,
          { dir, port, timeoutMs: timeoutS * 1000 },
          rig,
          takeSpare(),
        );
        current = leg;
        if (gone) await leg.abort();
        const code = await leg.done;
        response.end(`exit=${code}\n`);
      } catch (err) {
        response.end(`error ${String(err)}\nexit=124\n`);
      } finally {
        current = undefined;
        busy = false;
        if (!spare) spare = prepareSpare();
      }
    })();
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await writeFile(readyFile, `${JSON.stringify({ port, pid: process.pid })}\n`);
  log(
    `browser-daemon: listening on 127.0.0.1:${port} (kind ${ctx.kind}, device ${rig.id} ${rig.harness.entry.serial}, ${rig.harness.browser.chromeVersion}, isolation ${rig.harness.browser.targets.isolation}; page port ${rig.pagePort}, host port ${rig.hostPort} reversed)`,
  );
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await current?.abort().catch(() => 0);
    const s = spare;
    spare = null;
    if (s) await s.then((t) => t.lease.release()).catch(() => {});
    const kept = rig.keptTab;
    rig.keptTab = null;
    if (kept) await kept.lease.release().catch(() => {});
    const settings = await rig.harness.close().catch((err) => {
      log(`browser-daemon: device close failed: ${String(err)}`);
      return null;
    });
    if (settings)
      log(
        `browser-daemon: device session settings restored (${settings.changes.length} changes, errors: ${settings.restore_errors.length})`,
      );
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      if (!busy) void shutdown();
    }
  }, 1000).unref();
  await new Promise<never>(() => {});
}

/** G7v: the phone's samplers for one g7-dev leg (Q13b "Samplers"): conditions and CPU caps every
 * 30 s; `soak` adds renderer/GPU/browser PSS every 5 s (dumpsys meminfo), gfxinfo GPU memory
 * (with the 30-s sample) and the leg tab's CDP JS heap every 10 s. Stopped when the leg ends. */
export interface DevSamplerHandle {
  stop(): Promise<{
    device: SamplerTimeline;
    js_heap: { t_ms: number; used_bytes: number | null }[];
  }>;
}

export async function startDevSampler(
  rig: DeviceRig,
  mode: "light" | "soak",
): Promise<DevSamplerHandle> {
  const browser = rig.harness.browser;
  const entry = rig.harness.entry;
  const chromePackage = entry.chrome_package;
  const processInfo = await browser.client
    .send<{ processInfo: { type: string; id: number }[] }>(
      "SystemInfo.getProcessInfo",
      {},
      { flat: true, timeoutMs: 10_000 },
    )
    .then((r) => r.processInfo ?? [])
    .catch(() => [] as { type: string; id: number }[]);
  const ids = processInfo
    .filter((p) => p.type === "renderer" || p.type === "GPU" || p.type === "browser")
    .map((p) => p.id)
    .filter((pid) => pid > 0);
  const sampler = new DeviceSampler(browser.adb, {
    chromePackage,
    clusters: entry.cpu_clusters,
    pids: () => (mode === "soak" ? ids : []),
    conditionsMs: 30_000,
    memoryMs: mode === "soak" ? 5_000 : 3_600_000,
  });
  sampler.start();
  const t0 = Date.now();
  const jsHeap: { t_ms: number; used_bytes: number | null }[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  if (mode === "soak") {
    await browser.client
      .send("Performance.enable", {})
      .catch(() => {});
    timer = setInterval(() => {
      void browser.client
        .send<{ metrics: { name: string; value: number }[] }>(
          "Performance.getMetrics",
          {},
        )
        .then((r) => {
          const m = r.metrics.find((x) => x.name === "JSHeapUsedSize");
          jsHeap.push({ t_ms: Date.now() - t0, used_bytes: m ? m.value : null });
        })
        .catch(() => jsHeap.push({ t_ms: Date.now() - t0, used_bytes: null }));
    }, 10_000);
  }
  return {
    stop: async () => {
      if (timer) clearInterval(timer);
      const device = await sampler.stop();
      return { device, js_heap: jsHeap };
    },
  };
}
