// `--env device`: run the SAME scenarios, on a real Android phone, over adb.
//
// Transport is `adb reverse tcp:<port> tcp:<port>`, so the phone reaches the desktop's harness
// server at `http://127.0.0.1:<port>` — deliberately NOT a LAN IP. Reverse forwarding needs no
// network configuration, survives the phone changing (or losing) Wi-Fi, keeps the URL byte-identical
// to the desktop run so the HTTP cache keys and the `origin` in the trace look the same, and cannot
// be reached by anything else on the network.
//
// Attach is the flattened path and nothing else:
//   adb forward tcp:<port> localabstract:chrome_devtools_remote
//   GET http://127.0.0.1:<port>/json/version -> webSocketDebuggerUrl (the BROWSER endpoint)
//   Target.attachToTarget{flatten:true}
// The legacy per-page endpoint (`ws://…/devtools/page/<id>`) stopped responding in Chrome 151 and
// the phone runs a newer Chrome than this box, so there is no fallback to it — see cdp.ts.
//
// THE ANDROID FOREGROUND RULE: CDP drives only the ACTIVE tab. A backgrounded tab attaches fine and
// then never answers — `Runtime.evaluate` simply hangs until the timeout. Every lease therefore ends
// with a short responsiveness probe, so the failure mode is a one-line explanation instead of a
// two-minute hang.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GfxInfoMetrics, GpuDeviceMetrics } from "./analyze";
import type { PerfBrowser, TargetIsolation, TargetProvider } from "./browser";
import { CdpClient } from "./cdp";
import { endStaleTracing } from "./trace";

const execFileAsync = promisify(execFile);

export class AdbError extends Error {}

/** The message every "no phone" failure ends with. Actionable, and never a stack trace. */
export const NO_DEVICE_HELP = [
  "`--env device` needs a real Android phone attached to adb.",
  "  1. plug the phone in over USB (or `adb connect <ip>:5555` for Wi-Fi debugging)",
  "  2. unlock it and keep the screen on",
  "  3. Settings -> Developer options -> USB debugging, then accept the RSA prompt",
  "  4. `adb devices -l` must list it as `device` (not `unauthorized` / `offline`)",
  "  5. open Chrome on the phone — the DevTools socket only exists while Chrome is running",
].join("\n");

export interface AdbDeviceEntry {
  serial: string;
  state: string;
  model: string | null;
  product: string | null;
}

/** `adb devices -l` -> entries. Pure, so the error paths are testable without hardware. */
export function parseAdbDevices(text: string): AdbDeviceEntry[] {
  const entries: AdbDeviceEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      /^List of devices/i.test(trimmed) ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("adb server")
    ) {
      continue;
    }
    // `no permissions (udev rules…)` is a multi-word state, hence the alternation.
    const match = /^(\S+)\s+(no permissions[^\n]*?|\S+)(\s+.*)?$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const tags = new Map<string, string>();
    for (const token of (match[3] ?? "").trim().split(/\s+/)) {
      const index = token.indexOf(":");
      if (index > 0) {
        tags.set(token.slice(0, index), token.slice(index + 1));
      }
    }
    entries.push({
      serial: match[1],
      state: match[2].startsWith("no permissions")
        ? "no permissions"
        : match[2],
      model: tags.get("model") ?? null,
      product: tags.get("product") ?? null,
    });
  }
  return entries;
}

export interface AdbOptions {
  /** Override the adb binary (`GSW_PERF_ADB`, then `adb` from PATH). */
  bin?: string;
  serial?: string;
  timeoutMs?: number;
}

export class Adb {
  readonly bin: string;
  readonly serial: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: AdbOptions = {}) {
    this.bin = options.bin ?? process.env.GSW_PERF_ADB ?? "adb";
    this.serial = options.serial;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** Run adb, targeted at this device when a serial is bound. Throws `AdbError` on failure. */
  async exec(
    args: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<string> {
    const full = this.serial ? ["-s", this.serial, ...args] : args;
    try {
      const { stdout } = await execFileAsync(this.bin, full, {
        timeout: options.timeoutMs ?? this.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stderr?: string;
        stdout?: string;
      };
      if (err.code === "ENOENT") {
        throw new AdbError(
          `adb not found (tried "${this.bin}"). Install Android platform-tools, or set GSW_PERF_ADB to the binary.\n${NO_DEVICE_HELP}`,
        );
      }
      const detail = (err.stderr || err.stdout || err.message || "").trim();
      throw new AdbError(`adb ${full.join(" ")} failed: ${detail}`);
    }
  }

  shell(
    command: string,
    options: { timeoutMs?: number } = {},
  ): Promise<string> {
    return this.exec(["shell", command], options);
  }
}

/** `key=value` lines (what the props probe echoes) -> map. */
export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return out;
}

export interface DeviceProps {
  serial: string;
  model: string;
  manufacturer: string;
  androidRelease: string;
  androidSdk: string;
}

export async function readDeviceProps(adb: Adb): Promise<DeviceProps> {
  const text = await adb.shell(
    [
      'echo "model=$(getprop ro.product.model)"',
      'echo "manufacturer=$(getprop ro.product.manufacturer)"',
      'echo "release=$(getprop ro.build.version.release)"',
      'echo "sdk=$(getprop ro.build.version.sdk)"',
    ].join("; "),
  );
  const props = parseKeyValueLines(text);
  return {
    serial: adb.serial ?? "unknown",
    model: props.model || "unknown",
    manufacturer: props.manufacturer || "unknown",
    androidRelease: props.release || "unknown",
    androidSdk: props.sdk || "unknown",
  };
}

export interface BatterySample {
  /** Charge level in percent, or null when `dumpsys battery` did not report one. */
  pct: number | null;
  /** Battery temperature in °C (`dumpsys battery` reports tenths of a degree). */
  temperatureC: number | null;
}

export function parseBattery(text: string): BatterySample {
  const level = /^\s*level:\s*(-?\d+)/m.exec(text)?.[1];
  const temperature = /^\s*temperature:\s*(-?\d+)/m.exec(text)?.[1];
  return {
    pct: level === undefined ? null : Number(level),
    temperatureC:
      temperature === undefined ? null : Math.round(Number(temperature)) / 10,
  };
}

/** `PowerManager.THERMAL_STATUS_*`. Index is the integer `dumpsys thermalservice` reports. */
export const THERMAL_STATUS_NAMES = [
  "none",
  "light",
  "moderate",
  "severe",
  "critical",
  "emergency",
  "shutdown",
] as const;

export interface ThermalSample {
  /** `none` … `shutdown`, or null when the status could not be read. */
  status: string | null;
  code: number | null;
  /** Hottest sensor reading the HAL reported, in °C — context for a status that is not `none`. */
  maxTempC: number | null;
}

/**
 * `dumpsys thermalservice`. The headline `Thermal Status: N` is authoritative; when a build does not
 * print it, the WORST per-sensor `mStatus=` from the HAL block is used instead, because under-reading
 * throttling is the failure that silently invalidates a baseline.
 */
export function parseThermal(text: string): ThermalSample {
  let code: number | null = null;
  const headline = /Thermal Status:\s*(-?\d+)/i.exec(text)?.[1];
  if (headline !== undefined) {
    code = Number(headline);
  } else {
    const statuses = [...text.matchAll(/mStatus\s*=\s*(-?\d+)/g)].map((m) =>
      Number(m[1]),
    );
    if (statuses.length > 0) {
      code = Math.max(...statuses);
    }
  }
  const values = [...text.matchAll(/mValue\s*=\s*(-?[\d.]+)/g)]
    .map((m) => Number(m[1]))
    .filter((value) => Number.isFinite(value) && value > -100 && value < 200);
  return {
    status:
      code === null ? null : (THERMAL_STATUS_NAMES[code] ?? `unknown(${code})`),
    code,
    maxTempC: values.length > 0 ? Math.max(...values) : null,
  };
}

export interface LockState {
  /** `mDreamingLockscreen=true` — the lockscreen is up. CDP will attach and then hang. */
  dreamingLockscreen: boolean | null;
  awake: boolean | null;
  raw: string;
}

/** `adb shell dumpsys window | grep mDreamingLockscreen` — checked EARLY, before anything hangs. */
export function parseLockState(text: string): LockState {
  const dreaming = /mDreamingLockscreen=(true|false)/.exec(text)?.[1];
  const awake = /mAwake=(true|false)/.exec(text)?.[1];
  const raw = (
    text.split(/\r?\n/).find((line) => line.includes("mDreamingLockscreen")) ??
    ""
  ).trim();
  return {
    dreamingLockscreen: dreaming === undefined ? null : dreaming === "true",
    awake: awake === undefined ? null : awake === "true",
    raw,
  };
}

/**
 * Abstract-socket names from `/proc/net/unix`. Chrome publishes `@chrome_devtools_remote`; Chrome
 * Beta/Dev/Canary and WebView publish suffixed variants, so the socket is DISCOVERED rather than
 * assumed — attaching to the wrong browser is a confusing way to fail.
 */
export function parseDevtoolsSockets(procNetUnix: string): string[] {
  const names = new Set<string>();
  for (const match of procNetUnix.matchAll(
    /@([\w.-]*devtools_remote[\w.-]*)/g,
  )) {
    names.add(match[1]);
  }
  const sorted = [...names].sort();
  return sorted.sort((a, b) =>
    a === "chrome_devtools_remote"
      ? -1
      : b === "chrome_devtools_remote"
        ? 1
        : 0,
  );
}

export interface SelectDeviceOptions {
  serial?: string;
  adbBin?: string;
}

/**
 * Pick the device to drive, or explain — in one message — exactly what to do about it. This is the
 * FIRST thing a device run does: a workstream that cannot see the phone should say so in a second,
 * not after building a 15 MB atlas.
 */
export async function selectDevice(
  options: SelectDeviceOptions = {},
): Promise<{ adb: Adb; entry: AdbDeviceEntry }> {
  const probe = new Adb({ bin: options.adbBin });
  const listing = await probe.exec(["devices", "-l"]);
  const entries = parseAdbDevices(listing);
  const wanted = options.serial ?? process.env.ANDROID_SERIAL;

  if (entries.length === 0) {
    throw new AdbError(
      `no Android device is visible to adb (\`adb devices -l\` is empty).\n${NO_DEVICE_HELP}`,
    );
  }
  const described = entries
    .map(
      (entry) =>
        `    ${entry.serial}  ${entry.state}${entry.model ? `  model:${entry.model}` : ""}`,
    )
    .join("\n");

  const candidates = wanted
    ? entries.filter((entry) => entry.serial === wanted)
    : entries;
  if (candidates.length === 0) {
    throw new AdbError(
      `adb has no device with serial "${wanted}". Visible devices:\n${described}\n${NO_DEVICE_HELP}`,
    );
  }
  const ready = candidates.filter((entry) => entry.state === "device");
  if (ready.length === 0) {
    const entry = candidates[0];
    const why =
      entry.state === "unauthorized"
        ? "the phone has not accepted this computer's debugging key — unlock it and tap ALLOW on the 'Allow USB debugging?' prompt"
        : entry.state === "offline"
          ? "adb sees the device but it is offline — replug the cable, or `adb kill-server && adb devices`"
          : entry.state === "no permissions"
            ? "the udev rules do not grant this user access to the USB device"
            : `adb reports state "${entry.state}"`;
    throw new AdbError(
      `device ${entry.serial} is not usable: ${why}.\nVisible devices:\n${described}`,
    );
  }
  if (ready.length > 1) {
    throw new AdbError(
      `more than one device is connected; pass --device-serial (or set ANDROID_SERIAL):\n${described}`,
    );
  }
  return {
    adb: new Adb({ bin: options.adbBin, serial: ready[0].serial }),
    entry: ready[0],
  };
}

/** Conditions sampled around the run. Sampled TWICE — before and after — and both are reported. */
export interface DeviceConditions {
  batteryPct: number | null;
  batteryTemperatureC: number | null;
  thermalStatus: string | null;
  thermalStatusCode: number | null;
  thermalMaxTempC: number | null;
}

export async function sampleConditions(adb: Adb): Promise<DeviceConditions> {
  const [battery, thermal] = await Promise.all([
    adb.shell("dumpsys battery").catch(() => ""),
    adb.shell("dumpsys thermalservice").catch(() => ""),
  ]);
  const batterySample = parseBattery(battery);
  const thermalSample = parseThermal(thermal);
  return {
    batteryPct: batterySample.pct,
    batteryTemperatureC: batterySample.temperatureC,
    thermalStatus: thermalSample.status,
    thermalStatusCode: thermalSample.code,
    thermalMaxTempC: thermalSample.maxTempC,
  };
}

/**
 * Whether the run is still comparable to a cold-phone baseline.
 *
 * A thermally throttled phone silently invalidates a baseline, and a baseline that cannot be told
 * apart from a hot-phone run is worse than no baseline at all — so the drift is computed, stored in
 * the report and printed, never left for the reader to spot in two dumps.
 */
export function conditionWarnings(
  before: DeviceConditions,
  after: DeviceConditions,
): string[] {
  const warnings: string[] = [];
  if ((before.thermalStatusCode ?? 0) > 0) {
    warnings.push(
      `phone was ALREADY thermally throttled before the run (thermalStatus=${before.thermalStatus}) — these numbers are not a cold-phone baseline`,
    );
  }
  if (
    after.thermalStatusCode !== null &&
    before.thermalStatusCode !== null &&
    after.thermalStatusCode > before.thermalStatusCode
  ) {
    warnings.push(
      `thermal status ROSE during the run (${before.thermalStatus} -> ${after.thermalStatus}) — later repeats ran on a throttled phone`,
    );
  }
  if (
    before.batteryTemperatureC !== null &&
    after.batteryTemperatureC !== null &&
    after.batteryTemperatureC - before.batteryTemperatureC >= 3
  ) {
    warnings.push(
      `battery temperature rose ${(after.batteryTemperatureC - before.batteryTemperatureC).toFixed(1)} °C during the run (${before.batteryTemperatureC} -> ${after.batteryTemperatureC} °C)`,
    );
  }
  if (after.batteryPct !== null && after.batteryPct < 20) {
    warnings.push(
      `battery at ${after.batteryPct}% — Android may be applying power-save CPU limits`,
    );
  }
  return warnings;
}

/**
 * `adb shell dumpsys gfxinfo <package>` -> the counters worth reporting.
 *
 * WHAT THIS IS AND IS NOT. These are **HWUI** frame statistics for Chrome's ANDROID VIEW hierarchy,
 * reset to zero by `dumpsys gfxinfo <pkg> reset` and read back after the window. Web content is
 * composited by Chrome's GPU process through a SurfaceControl/SurfaceView, so the percentiles here are
 * NOT the page's frame times and must never be printed as such — `contentUpdateHz` remains the honest
 * content rate. What they DO carry is device-level GPU-driver pressure under the same load, and the
 * two named counters (`Slow bitmap uploads`, `Slow issue draw commands`) are HWUI's own read-out of
 * texture upload and draw-command cost, which is exactly the failure class this harness hunts.
 */
export function parseGfxInfo(text: string): GfxInfoMetrics {
  const num = (pattern: RegExp): number | null => {
    const match = pattern.exec(text);
    return match ? Number(match[1]) : null;
  };
  return {
    totalFrames: num(/Total frames rendered:\s*(\d+)/),
    // The headline `Janky frames: N (P%)`. The `(legacy)` line is a DIFFERENT, much noisier counter
    // and is deliberately not the one reported.
    jankPct: num(/^\s*Janky frames:\s*\d+\s*\(([\d.]+)%\)/m),
    p50Ms: num(/^\s*50th percentile:\s*(\d+)ms/m),
    p95Ms: num(/^\s*95th percentile:\s*(\d+)ms/m),
    p99Ms: num(/^\s*99th percentile:\s*(\d+)ms/m),
    slowBitmapUploads: num(/Number Slow bitmap uploads:\s*(\d+)/),
    slowIssueDrawCommands: num(/Number Slow issue draw commands:\s*(\d+)/),
  };
}

/**
 * `Total GPU memory usage: <bytes> bytes` from the same dump.
 *
 * MEASURED DECISION: perfetto's `android.gpu.memory` data source was NOT used. It is the only GPU
 * counter this unrooted phone exposes, but reading it costs a second trace session, a pull, and a
 * protobuf decoder — against one already-parsed line of a dump this run takes anyway, for the same
 * number at the same moment. See docs/perf-harness.md.
 */
export function parseGpuMemoryBytes(text: string): number | null {
  const match = /Total GPU memory usage:\s*\n?\s*(\d+)\s*bytes/.exec(text);
  return match ? Number(match[1]) : null;
}

/** Zero HWUI's counters so the following read describes only the measured window. */
export async function resetGfxInfo(adb: Adb, pkg: string): Promise<void> {
  await adb.shell(`dumpsys gfxinfo ${pkg} reset`).catch(() => "");
}

export async function readGpuDeviceMetrics(
  adb: Adb,
  pkg: string,
): Promise<GpuDeviceMetrics> {
  const text = await adb.shell(`dumpsys gfxinfo ${pkg}`).catch(() => "");
  return {
    source: "dumpsys-gfxinfo",
    gfxinfo: parseGfxInfo(text),
    gpuMemoryBytes: parseGpuMemoryBytes(text),
    // NO DELTA on this rung, and that is a measurement fact rather than an omission: the bracket
    // RESETS HWUI's counters instead of reading them twice, so there is no "before" byte count to
    // difference. `null` says that; a 0 would claim the window allocated nothing.
    gpuMemoryDeltaBytes: null,
    attribution: `dumpsys gfxinfo ${pkg} (whole package, HWUI's Total GPU memory usage)`,
    memoryDump: null,
  };
}

export interface DeviceBrowserOptions {
  serial?: string;
  adbBin?: string;
  /** Local port for the DevTools forward. Tries this port and the next few if it is taken. */
  devtoolsPort?: number;
  /** Harness server port to expose to the phone via `adb reverse`. */
  serverPort: number;
  onProgress?: (message: string) => void;
  /** How long a freshly attached page gets to answer before it is declared backgrounded. */
  foregroundTimeoutMs?: number;
}

export interface DeviceBrowser extends PerfBrowser {
  adb: Adb;
  props: DeviceProps;
  chromeVersion: string;
  chromePackage: string | null;
  devtoolsSocket: string;
  devtoolsPort: number;
  conditions(): Promise<DeviceConditions>;
}

const FOREGROUND_HELP = [
  "the attached Android tab never answered.",
  "On Android, CDP drives only the ACTIVE tab: a backgrounded tab attaches and then goes silent.",
  "  * unlock the phone and keep the screen on (`adb shell dumpsys window | grep mDreamingLockscreen`)",
  "  * bring Chrome to the foreground, on the tab the harness opened",
  "  * close any full-screen app / split-screen that keeps Chrome hidden",
].join("\n  ");

/** Attach to Chrome on a connected phone. Every failure here is a sentence, not a stack trace. */
export async function openDeviceBrowser(
  options: DeviceBrowserOptions,
): Promise<DeviceBrowser> {
  const {
    serverPort,
    devtoolsPort = 9222,
    onProgress = () => {},
    foregroundTimeoutMs = 10_000,
  } = options;

  const { adb, entry } = await selectDevice({
    serial: options.serial,
    adbBin: options.adbBin,
  });
  const props = await readDeviceProps(adb);
  onProgress(
    `device ${props.manufacturer} ${props.model} (${entry.serial}), Android ${props.androidRelease} (sdk ${props.androidSdk})`,
  );

  // Lock state FIRST: a locked phone attaches fine and then hangs on the first evaluate.
  const lock = parseLockState(
    await adb.shell("dumpsys window").catch(() => ""),
  );
  if (lock.dreamingLockscreen === true || lock.awake === false) {
    throw new AdbError(
      `the phone is locked or asleep (${lock.raw || `mAwake=${lock.awake}`}). Unlock it and keep the screen on, then re-run.\nTip: \`adb shell svc power stayon usb\` keeps the screen awake while charging over USB.`,
    );
  }

  const sockets = parseDevtoolsSockets(
    await adb.shell("cat /proc/net/unix").catch(() => ""),
  );
  if (sockets.length === 0) {
    throw new AdbError(
      `no Chrome DevTools socket on ${entry.serial}: nothing in /proc/net/unix matches *devtools_remote.\nOpen Chrome on the phone (the socket only exists while it runs) and make sure USB debugging is on.`,
    );
  }
  const socket = sockets[0];

  const port = await forwardDevtools(adb, socket, devtoolsPort);
  await adb.exec(["reverse", `tcp:${serverPort}`, `tcp:${serverPort}`]);
  onProgress(
    `adb forward tcp:${port} -> localabstract:${socket}; adb reverse tcp:${serverPort} (phone reaches the harness at http://127.0.0.1:${serverPort})`,
  );

  const version = await fetchDevtoolsVersion(port);
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new AdbError(
      `GET http://127.0.0.1:${port}/json/version returned no webSocketDebuggerUrl (${JSON.stringify(version).slice(0, 200)}). This harness only attaches through the BROWSER endpoint — the legacy per-page endpoint stopped responding in Chrome 151.`,
    );
  }
  const client = await CdpClient.connect(wsUrl);
  const chromeVersion = version.Browser ?? "unknown";
  onProgress(
    `attached ${chromeVersion}${version["Android-Package"] ? ` (${version["Android-Package"]})` : ""} over the flattened browser endpoint`,
  );

  // A run interrupted with Ctrl-C leaves Chrome's BROWSER-GLOBAL tracing controller started, and
  // every later run then dies on `Tracing.start` with "Tracing has already been started (possibly in
  // another tab)". There is no such tab: the controller outlives the session that started it. Ending
  // it here — browser level, no sessionId — is what actually releases it; a `Tracing.end` per
  // attached page answers "Tracing is not started" and clears nothing.
  if (await endStaleTracing(client)) {
    onProgress(
      "note: ended a tracing session left running by an earlier, interrupted run (Chrome's tracing controller is browser-global)",
    );
  }

  const targets = await deviceTargets(client, {
    foregroundTimeoutMs,
    onProgress,
  });

  let closed = false;
  return {
    client,
    adb,
    props,
    chromeVersion,
    chromePackage: version["Android-Package"] ?? null,
    devtoolsSocket: socket,
    devtoolsPort: port,
    version: chromeVersion,
    envLabel: deviceEnvLabel(props, chromeVersion),
    describe: `${props.manufacturer} ${props.model} / Android ${props.androidRelease} / ${chromeVersion} / target isolation: ${targets.isolation}`,
    targets,
    // A phone IS the slow device. Throttling it would measure an emulated phone on a phone.
    defaultCpuThrottle: null,
    // ATTACHED, never launched: the browser's pid lives on the phone and means nothing to this
    // machine's `/proc`. The desktop VRAM attribution is off by construction here, which is right —
    // Android's driver figure comes from `dumpsys gfxinfo` instead.
    pid: null,
    conditions: () => sampleConditions(adb),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      client.close();
      await adb
        .exec(["reverse", "--remove", `tcp:${serverPort}`])
        .catch(() => "");
      await adb.exec(["forward", "--remove", `tcp:${port}`]).catch(() => "");
    },
  };
}

export function deviceEnvLabel(
  props: DeviceProps,
  chromeVersion: string,
): string {
  const major = /Chrome\/(\d+)/.exec(chromeVersion)?.[1] ?? "unknown";
  const model = props.model.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `android${props.androidRelease}-${model}-chrome-${major}`;
}

/** `adb reverse` for the harness server, used by `--serve --env device` too. */
export async function reverseServerPort(adb: Adb, port: number): Promise<void> {
  await adb.exec(["reverse", `tcp:${port}`, `tcp:${port}`]);
}

async function forwardDevtools(
  adb: Adb,
  socket: string,
  preferredPort: number,
): Promise<number> {
  let lastError: unknown;
  for (let port = preferredPort; port < preferredPort + 8; port++) {
    // A stale forward on this port from an earlier run would silently point at another browser.
    await adb.exec(["forward", "--remove", `tcp:${port}`]).catch(() => "");
    try {
      await adb.exec(["forward", `tcp:${port}`, `localabstract:${socket}`]);
      return port;
    } catch (error) {
      lastError = error;
    }
  }
  throw new AdbError(
    `could not bind a local port for the DevTools forward (tried ${preferredPort}..${preferredPort + 7}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

interface DevtoolsVersion {
  Browser?: string;
  webSocketDebuggerUrl?: string;
  "Android-Package"?: string;
  "User-Agent"?: string;
}

async function fetchDevtoolsVersion(port: number): Promise<DevtoolsVersion> {
  const url = `http://127.0.0.1:${port}/json/version`;
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new AdbError(
      `GET ${url} failed (${error instanceof Error ? error.message : String(error)}).\nThe adb forward is up but nothing is listening on the phone's DevTools socket — open Chrome on the phone and try again.`,
    );
  }
  if (!response.ok) {
    throw new AdbError(`GET ${url} -> ${response.status}`);
  }
  return (await response.json()) as DevtoolsVersion;
}

interface DeviceTargetOptions {
  foregroundTimeoutMs: number;
  onProgress: (message: string) => void;
}

/**
 * Per-repeat page acquisition on Android, best isolation first.
 *
 * Desktop Chrome hands out a fresh browser context per repeat. Android Chrome may refuse both
 * `Target.createBrowserContext` and `Target.createTarget`, and the honest answer to that is to say
 * which one it refused — reusing a warm tab and presenting the numbers as cold would be exactly the
 * kind of quiet lie this harness exists to prevent. Whatever is used ends up in
 * `env.device.isolation` and in the report.
 */
export async function deviceTargets(
  client: CdpClient,
  options: DeviceTargetOptions,
): Promise<TargetProvider> {
  const { foregroundTimeoutMs, onProgress } = options;
  const isolation = await probeIsolation(client);
  if (isolation !== "browser-context") {
    onProgress(
      isolation === "new-tab"
        ? "note: Android Chrome refused Target.createBrowserContext; using a FRESH TAB per repeat (HTTP + image caches are shared, so the per-repeat cache-busted image URL is what keeps each decode cold)"
        : "note: Android Chrome refused both Target.createBrowserContext and Target.createTarget; REUSING the foreground tab (cache cleared between repeats, plus the per-repeat cache-busted image URL)",
    );
  }

  return {
    isolation,
    async acquire() {
      const previousSession = client.sessionId;
      let browserContextId: string | undefined;
      let targetId: string;
      let ownsTarget = true;

      if (isolation === "browser-context") {
        const context = await client.send<{ browserContextId: string }>(
          "Target.createBrowserContext",
          { disposeOnDetach: true },
          { flat: true },
        );
        browserContextId = context.browserContextId;
        targetId = (
          await client.send<{ targetId: string }>(
            "Target.createTarget",
            { url: "about:blank", browserContextId },
            { flat: true },
          )
        ).targetId;
      } else if (isolation === "new-tab") {
        targetId = (
          await client.send<{ targetId: string }>(
            "Target.createTarget",
            { url: "about:blank" },
            { flat: true },
          )
        ).targetId;
      } else {
        targetId = await findForegroundPage(client);
        ownsTarget = false;
      }

      const sessionId = await client.attach(targetId);
      // Android needs the tab ACTUALLY in front, not merely attached.
      await client.send("Page.bringToFront").catch(() => undefined);
      await ensureResponsive(client, foregroundTimeoutMs);
      if (!ownsTarget) {
        // Reused tab: at least drop the HTTP cache, and start from a blank document so the previous
        // repeat's DOM is not still mounted when the next one measures.
        await client.send("Network.enable").catch(() => undefined);
        await client.send("Network.clearBrowserCache").catch(() => undefined);
        await client.send("Network.disable").catch(() => undefined);
        await client
          .send("Page.navigate", { url: "about:blank" })
          .catch(() => undefined);
      }

      return {
        targetId,
        sessionId,
        async release() {
          client.sessionId = previousSession;
          if (ownsTarget) {
            try {
              await client.send(
                "Target.closeTarget",
                { targetId },
                {
                  flat: true,
                },
              );
            } catch {
              // tab may already be gone
            }
          }
          if (browserContextId) {
            try {
              await client.send(
                "Target.disposeBrowserContext",
                { browserContextId },
                { flat: true },
              );
            } catch {
              // context may already be disposed
            }
          }
        },
      };
    },
  };
}

async function probeIsolation(client: CdpClient): Promise<TargetIsolation> {
  try {
    const { browserContextId } = await client.send<{
      browserContextId: string;
    }>("Target.createBrowserContext", {}, { flat: true, timeoutMs: 15_000 });
    await client
      .send(
        "Target.disposeBrowserContext",
        { browserContextId },
        {
          flat: true,
        },
      )
      .catch(() => undefined);
    return "browser-context";
  } catch {
    // Android Chrome historically answers "Not supported" here.
  }
  try {
    const { targetId } = await client.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
      { flat: true, timeoutMs: 15_000 },
    );
    await client
      .send("Target.closeTarget", { targetId }, { flat: true })
      .catch(() => undefined);
    return "new-tab";
  } catch {
    return "reused-tab";
  }
}

async function findForegroundPage(client: CdpClient): Promise<string> {
  const { targetInfos } = await client.send<{
    targetInfos: {
      targetId: string;
      type: string;
      url: string;
      attached?: boolean;
    }[];
  }>("Target.getTargets", {}, { flat: true });
  const pages = targetInfos.filter(
    (target) =>
      target.type === "page" &&
      !target.url.startsWith("devtools://") &&
      !target.url.startsWith("chrome-native://"),
  );
  if (pages.length === 0) {
    throw new AdbError(
      "Chrome on the phone has no page target to drive. Open a tab (any http page) and re-run.",
    );
  }
  return pages[0].targetId;
}

/**
 * Prove the attached tab actually answers. A backgrounded Android tab attaches and then never
 * replies, so without this probe the harness hangs for two minutes and reports a CDP timeout on
 * whatever unlucky command came next.
 */
export async function ensureResponsive(
  client: CdpClient,
  timeoutMs: number,
): Promise<void> {
  try {
    await client.evaluate<number>("1", { timeoutMs });
  } catch (error) {
    throw new AdbError(
      `${FOREGROUND_HELP}\n  (probe failed after ${timeoutMs}ms: ${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Append the Android foreground hint to a mid-run stall, which is nearly always what caused it. */
export function decorateDeviceError(error: unknown): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  if (!/CDP timeout|never became ready|websocket closed/i.test(base.message)) {
    return base;
  }
  base.message = `${base.message}\n\nOn a device run this usually means ${FOREGROUND_HELP}`;
  return base;
}
