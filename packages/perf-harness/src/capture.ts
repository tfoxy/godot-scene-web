// One measured run: fresh page -> navigate -> trace -> screenshot.
//
// METHODOLOGY, NON-NEGOTIABLE: a FRESH browser context and target per repeat. Chrome's decoded-image
// cache survives navigation, so reusing a page would make every repeat after the first report a warm
// decode — silently erasing the cold-decode number this harness exists to measure.
//
// WHERE the page comes from is the one part that differs between attach modes, so it is injected as
// a `TargetProvider` (browser.ts). Desktop Chrome always gives a fresh context; Android Chrome may
// only manage a fresh tab, and the provider records which — see `TargetIsolation`. Everything below
// this line is identical for both, which is what makes desktop and phone numbers comparable at all.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { browserContextTargets, type TargetProvider } from "./browser";
import type { PerfRunResult } from "./browser/runtime";
import type { CdpClient } from "./cdp";
import { sleep } from "./cdp";
import { startTracing, stopTracing, TRACE_CATEGORIES } from "./trace";

export interface CaptureOptions {
  client: CdpClient;
  url: string;
  tracePath: string;
  /** Size hint for the created target. Also the emulated metrics, unless `emulate` is false. */
  viewport: { width: number; height: number };
  deviceScaleFactor?: number;
  /**
   * Whether to force the viewport with `Emulation.setDeviceMetricsOverride`.
   *
   * `false` is the device default: a phone measured at a force-emulated 1280x800 rasters at a scale
   * it would never use, and raster scale is what drives the decode cost this harness measures. The
   * scenario fits ITSELF into whatever viewport the device really has (see fit.ts) instead.
   */
  emulate?: boolean;
  /** `null` (device runs) means: do not touch `Emulation.setCPUThrottlingRate` at all. */
  cpuThrottle?: number | null;
  /** How each repeat gets its page. Defaults to a fresh browser context (desktop Chrome). */
  targets?: TargetProvider;
  categories?: readonly string[];
  readyTimeoutMs?: number;
  runTimeoutMs?: number;
  /** Timeout for the small polling evaluates; short on device so a backgrounded tab fails fast. */
  probeTimeoutMs?: number;
  /**
   * Out-of-band sampling BRACKETING the measured window — the phone's `dumpsys gfxinfo`, which has no
   * trace representation at all. `before` runs immediately before the page's `run()` (so it also
   * covers mount) and `after` the instant it resolves, i.e. as tightly around the window as an adb
   * round trip allows. Both are best-effort: a failure here must never fail a measurement.
   */
  window?: { before(): Promise<void>; after(): Promise<void> };
}

export interface CaptureResult {
  tracePath: string;
  traceBytes: number;
  /** Chrome reported that trace events were DROPPED — the capture is truncated, not cheap. */
  traceDataLoss: boolean;
  screenshot: Buffer;
  page: PerfRunResult;
  layerCount: number;
}

export async function captureRun(
  options: CaptureOptions,
): Promise<CaptureResult> {
  const {
    client,
    url,
    tracePath,
    viewport,
    deviceScaleFactor = 1,
    emulate = true,
    cpuThrottle = 1,
    targets = browserContextTargets(client),
    categories = TRACE_CATEGORIES,
    readyTimeoutMs = 120_000,
    runTimeoutMs = 300_000,
    probeTimeoutMs = 30_000,
  } = options;

  // The lease comes back ALREADY attached: on Android the provider also has to foreground the tab
  // and prove it answers, which only makes sense once the session exists.
  const lease = await targets.acquire(viewport);
  let layerCount = 0;
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    if (emulate) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor,
        mobile: false,
      });
    } else {
      // Belt and braces: a target handed back by a `reused-tab` provider can still be carrying an
      // override from an earlier run, and silently measuring at someone else's viewport is exactly
      // the failure this branch exists to prevent.
      await client
        .send("Emulation.clearDeviceMetricsOverride")
        .catch(() => undefined);
    }
    // `null` is the device case: a phone IS the slow hardware, so throttling it would measure an
    // emulated phone running on a phone.
    if (cpuThrottle != null && cpuThrottle !== 1) {
      await client.send("Emulation.setCPUThrottlingRate", {
        rate: cpuThrottle,
      });
    }
    client.on("LayerTree.layerTreeDidChange", (params) => {
      const layers = (params as { layers?: unknown[] }).layers;
      if (Array.isArray(layers)) {
        layerCount = layers.length;
      }
    });
    await client.send("LayerTree.enable");

    await client.send("Page.navigate", { url });
    await waitForHarness(client, readyTimeoutMs, probeTimeoutMs);

    // Trace starts BEFORE mount so `scenario:mount` -> first `ActivateLayerTree` after
    // `scenario:ready` is fully inside the capture.
    await startTracing(client, categories);
    await options.window?.before().catch(() => undefined);
    const page = await client.evaluate<PerfRunResult>(
      "window.__perfHarness.run()",
      { awaitPromise: true, timeoutMs: runTimeoutMs },
    );
    await options.window?.after().catch(() => undefined);
    const trace = await stopTracing(client);

    // Screenshot AFTER the window: the presence guard must judge the state the measurement ended in.
    const shot = await client.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });

    // `LayerTree.layerTreeDidChange` fires only when the compositor tree actually CHANGES — enabling
    // the domain does not push an initial snapshot, and a page whose animation only repaints
    // existing layers may never fire it at all. Measured: a full navigate + 2.5 s of animation
    // produced zero events on some runs and one on others, i.e. reporting the event count as-is
    // yields a flaky, frequently-zero `layerCount`.
    //
    // So if nothing arrived, deliberately dirty the tree and read the snapshot. This happens AFTER
    // the measured window and AFTER the screenshot, so it cannot influence any measurement. The
    // toggle is applied and then REVERTED, and the last snapshot wins, so a layer the probe itself
    // promoted cannot inflate the count.
    if (layerCount === 0) {
      // Re-arm first: the agent enabled before `Page.navigate` stays bound to the OLD document, so
      // without this the dirty below produces no event at all. (This was the actual cause of a
      // permanently-zero layerCount, not the missing dirty.)
      await client.send("LayerTree.disable");
      await client.send("LayerTree.enable");
      for (const value of ["transform", ""]) {
        await client.evaluate(
          `document.body.style.willChange = ${JSON.stringify(value)};`,
        );
        const deadline = Date.now() + 1500;
        const before: number = layerCount;
        while (layerCount === before && Date.now() < deadline) {
          await sleep(25);
        }
      }
    }

    await mkdir(dirname(tracePath), { recursive: true });
    await writeFile(tracePath, trace.bytes);

    client.off("LayerTree.layerTreeDidChange");
    return {
      tracePath,
      traceBytes: trace.bytes.byteLength,
      traceDataLoss: trace.dataLoss,
      screenshot: Buffer.from(shot.data, "base64"),
      page,
      layerCount,
    };
  } finally {
    client.off("LayerTree.layerTreeDidChange");
    await lease.release();
  }
}

async function waitForHarness(
  client: CdpClient,
  timeoutMs: number,
  probeTimeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await client.evaluate<{
      ready?: boolean;
      error?: string | null;
    } | null>(
      "(() => { const h = window.__perfHarness; return h ? { ready: h.ready, error: h.error } : null; })()",
      { timeoutMs: probeTimeoutMs },
    );
    if (state?.error) {
      throw new Error(`perf harness page reported: ${state.error}`);
    }
    if (state?.ready) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `perf harness page never became ready within ${timeoutMs}ms`,
      );
    }
    await sleep(50);
  }
}
