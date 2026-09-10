// What a "browser to measure in" is, independent of WHERE it runs.
//
// There are two attach modes and exactly one measurement pipeline. `openLocalBrowser` launches
// Chrome on this box; `openDeviceBrowser` (device.ts) attaches to Chrome already running on an
// Android phone over adb. Both hand back the same `PerfBrowser`, so `capture.ts`, `analyze.ts`,
// `presence.ts` and the report envelope are shared verbatim — a second harness for the phone would
// have produced numbers that could not be compared with the desktop ones, which is the whole point
// of having a device mode at all.
//
// The one thing that genuinely differs is HOW a fresh page is obtained per repeat, so that is the
// seam: a `TargetProvider`. Desktop Chrome gives every repeat its own browser context; Android
// Chrome may not support that at all, and what it does support is recorded in `isolation` and
// printed in the report rather than quietly pretended away.

import { join } from "node:path";
import { type CdpClient, type LaunchOptions, launchChrome } from "./cdp";
import { endStaleTracing } from "./trace";

/**
 * How cold a repeat's page really is.
 *
 * `browser-context` — a fresh incognito-style context per repeat: no cookies, no HTTP cache, no
 *   decoded-image cache carried over. What the desktop path always uses.
 * `new-tab`         — a fresh target in the SAME context. The HTTP/image caches are shared, so the
 *   per-repeat cache-busted image URL is doing the cold-decode work on its own.
 * `reused-tab`      — the same tab, navigated. Everything is shared; the harness clears the HTTP
 *   cache between repeats and still relies on the cache-busted URL.
 */
export type TargetIsolation = "browser-context" | "new-tab" | "reused-tab";

/** A page target that is ALREADY attached: `client.sessionId` routes to it until `release()`. */
export interface TargetLease {
  targetId: string;
  sessionId: string;
  release(): Promise<void>;
}

export interface TargetProvider {
  isolation: TargetIsolation;
  acquire(viewport: { width: number; height: number }): Promise<TargetLease>;
}

export interface PerfBrowser {
  client: CdpClient;
  /** The full `Browser` string from `/json/version`, e.g. `Chrome/148.0.7778.56`. */
  version: string;
  /** Default `env.label` when the caller did not pass one. */
  envLabel: string;
  /** One line describing what was attached to, for `--progress` output. */
  describe: string;
  targets: TargetProvider;
  /** `null` on device: throttling a phone's CPU to emulate a phone makes no sense. */
  defaultCpuThrottle: number | null;
  /**
   * OS pid of the browser process this harness LAUNCHED, or `null` when it attached to one it did
   * not spawn (every device run).
   *
   * It is here for exactly one consumer: the desktop VRAM sample has to attribute the driver's
   * per-process figure to OUR Chrome's GPU process, and a pid is the only thing that separates it
   * from the developer's own browser — which carries the same `--type=gpu-process` on its command
   * line and is sitting in the same `nvidia-smi` process list. See nvidia.ts.
   */
  pid: number | null;
  close(): Promise<void>;
}

export interface LocalBrowserOptions
  extends Omit<LaunchOptions, "userDataDir"> {
  artifactsDir: string;
}

/** Desktop mode: launch a private Chrome on this box and give every repeat its own context. */
export async function openLocalBrowser(
  options: LocalBrowserOptions,
): Promise<PerfBrowser> {
  const { artifactsDir, ...launch } = options;
  const chrome = await launchChrome({
    ...launch,
    userDataDir: join(artifactsDir, "chrome-profile"),
  });
  // Harmless on a Chrome this process just launched; kept symmetric with the device path so the
  // browser-global tracing controller is cleared in exactly one place for both attach modes.
  await endStaleTracing(chrome.client);
  return {
    client: chrome.client,
    version: chrome.version,
    envLabel: defaultEnvLabel(chrome.version),
    describe: `chrome ${chrome.version} (${chrome.executable})`,
    targets: browserContextTargets(chrome.client),
    defaultCpuThrottle: 1,
    // `undefined` if the child died before this line; `null` keeps "not launched by us" as the one
    // spelling of an unattributable run.
    pid: chrome.process.pid ?? null,
    close: () => chrome.close(),
  };
}

/**
 * A fresh browser context AND a fresh target per repeat. Chrome's decoded-image cache survives
 * navigation, so reusing a page would make every repeat after the first report a WARM decode —
 * silently erasing the number this harness exists to measure.
 */
export function browserContextTargets(client: CdpClient): TargetProvider {
  return {
    isolation: "browser-context",
    async acquire(viewport) {
      const { browserContextId } = await client.send<{
        browserContextId: string;
      }>(
        "Target.createBrowserContext",
        { disposeOnDetach: true },
        {
          flat: true,
        },
      );
      const { targetId } = await client.send<{ targetId: string }>(
        "Target.createTarget",
        {
          url: "about:blank",
          browserContextId,
          width: viewport.width,
          height: viewport.height,
        },
        { flat: true },
      );
      const previousSession = client.sessionId;
      const sessionId = await client.attach(targetId);
      return {
        targetId,
        sessionId,
        async release() {
          client.sessionId = previousSession;
          try {
            await client.send(
              "Target.closeTarget",
              { targetId },
              {
                flat: true,
              },
            );
          } catch {
            // target may already be gone
          }
          try {
            await client.send(
              "Target.disposeBrowserContext",
              { browserContextId },
              { flat: true },
            );
          } catch {
            // context may already be disposed
          }
        },
      };
    },
  };
}

export function defaultEnvLabel(chromeVersion: string): string {
  const version = /Chrome\/(\d+)/.exec(chromeVersion)?.[1] ?? "unknown";
  return `${process.platform}-chrome-${version}`;
}

/** The shape of `SystemInfo.getInfo` this harness reads. Everything else in it is ignored. */
export interface SystemInfoGpu {
  gpu?: {
    devices?: {
      vendorString?: string;
      deviceString?: string;
      driverVendor?: string;
      driverVersion?: string;
    }[];
    auxAttributes?: Record<string, unknown>;
  };
}

export interface GpuHardware {
  /** Short label: `swiftshader`, `Mali-G615 MC2 (ANGLE)`, … `unknown` when CDP would not say. */
  hardware: string;
  /** The raw renderer string it was derived from, driver version included. */
  hardwareDetail: string;
}

/**
 * Name the GPU from CDP `SystemInfo.getInfo`.
 *
 * WHY IT IS RECORDED AT ALL: this box has no hardware GPU — it is SwiftShader, a software rasteriser
 * — while the phone is a Mali behind ANGLE. GPU numbers are therefore comparable within an
 * environment only, and the report has to name the environment for that warning to mean anything.
 *
 * Both Chromes wrap the real renderer in ANGLE's `ANGLE (<vendor>, <renderer>, <api>)`, so the
 * middle field is unwrapped for the short label and the whole string kept as the detail.
 */
export function describeGpuHardware(info: SystemInfoGpu): GpuHardware {
  const device = info.gpu?.devices?.[0];
  const aux = info.gpu?.auxAttributes ?? {};
  const renderer = String(
    (typeof aux.glRenderer === "string" && aux.glRenderer) ||
      device?.deviceString ||
      "",
  );
  const vendor = String(
    (typeof aux.glVendor === "string" && aux.glVendor) ||
      device?.vendorString ||
      "",
  );
  if (!renderer) {
    return { hardware: "unknown", hardwareDetail: "" };
  }
  // SwiftShader is not a GPU. Naming it as one would invite exactly the cross-environment comparison
  // the portability rule forbids.
  if (/swiftshader/i.test(`${renderer} ${vendor}`)) {
    return { hardware: "swiftshader", hardwareDetail: renderer };
  }
  const angle = /^ANGLE \(([^,]+), (.+?), (?:OpenGL|Vulkan|D3D|Direct3D)/.exec(
    renderer,
  );
  return {
    hardware: angle ? `${angle[2]} (ANGLE)` : renderer,
    hardwareDetail: renderer,
  };
}

/** Best-effort: a browser that will not answer `SystemInfo.getInfo` must not fail a measurement. */
export async function readGpuHardware(client: CdpClient): Promise<GpuHardware> {
  try {
    const info = await client.send<SystemInfoGpu>(
      "SystemInfo.getInfo",
      {},
      { flat: true, timeoutMs: 15_000 },
    );
    return describeGpuHardware(info);
  } catch {
    return { hardware: "unknown", hardwareDetail: "" };
  }
}
