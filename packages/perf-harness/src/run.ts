// Orchestration: fixture -> server -> chrome -> (per mechanism, per repeat) capture -> analyze ->
// presence -> envelope.
//
// Methodology, non-negotiable and enforced here rather than in a doc:
//   * fixed viewport + device pixel ratio;
//   * seeded fixture data (the atlas is a pure function of its seed);
//   * 1 warmup repeat, DISCARDED;
//   * N repeats, MEDIANS reported;
//   * a FRESH browser context and target per repeat, with a per-repeat cache-busted image URL, so
//     every repeat pays a cold image decode.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCjkFont } from "../../../scripts/ensure-cjk-font";
import { ensureLatinBenchFont } from "../../../scripts/ensure-latin-font";
import {
  analyzeTrace,
  buildThreadIndex,
  formatMatcherProbe,
  type GpuDeviceMetrics,
  gfxInfoNotMeasured,
} from "./analyze";
import { openLocalBrowser, type PerfBrowser, readGpuHardware } from "./browser";
import type { PerfRunResult } from "./browser/runtime";
import { captureRun } from "./capture";
import {
  conditionWarnings,
  type DeviceBrowser,
  decorateDeviceError,
  openDeviceBrowser,
  readGpuDeviceMetrics,
  resetGfxInfo,
  reverseServerPort,
  selectDevice,
} from "./device";
import {
  describeFit,
  resolveViewportPolicy,
  type StageFit,
  sameGeometry,
} from "./fit";
import {
  ATLAS_DEFAULTS,
  ensureAtlasFixture,
  ensureBackgroundFixture,
} from "./fixtures/atlas";
import {
  type UnavailableMechanism,
  unavailableMechanismError,
  unavailableMechanisms,
} from "./hb-gpu-build";
import {
  type MemoryDumpCrossCheck,
  memoryDumpCrossCheck,
  parseMemoryDumps,
} from "./memory-dump";
import {
  type ChromeVramSample,
  GPU_PROCESS_FLAG,
  isNvidiaGpu,
  sampleChromeVram,
} from "./nvidia";
import { checkPresence } from "./presence";
import {
  type BrowserPerfReport,
  medianMetrics,
  REPORT_SCHEMA,
  type ReportEnvironment,
  type ReportGeometry,
  type ReportMetrics,
} from "./report";
import {
  getScenario,
  mechanismsOf,
  type ParamValue,
  resolveParams,
  type Scenario,
  usesUniformRegions,
} from "./scenarios";
import { startPerfServer } from "./serve";
import {
  formatTraceNameHistogram,
  readTraceEvents,
  type TraceEvent,
  traceCategoriesFor,
  traceNameHistogram,
} from "./trace";

/** `--env device`: which phone, and how to reach its DevTools socket. */
export interface DeviceOptions {
  serial?: string;
  adbBin?: string;
  devtoolsPort?: number;
}

export interface RunOptions {
  scenario: string;
  mechanisms?: string[];
  paramOverrides?: Record<string, ParamValue | undefined>;
  repeats?: number;
  warmups?: number;
  env?: Partial<ReportEnvironment>;
  /**
   * Force a viewport with `Emulation.setDeviceMetricsOverride`. Defaults to 1280x800 on `ci`; on
   * `device` LEAVING THIS UNSET is the point — the phone is measured at its own viewport.
   */
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  /**
   * Fit the scenario's stage into the viewport (letterboxed, uniform scale — see fit.ts).
   *
   * Defaults to ON for `device` and OFF for `ci`, and that asymmetry is deliberate:
   *   * a phone must render the scenario at ITS OWN size and orientation, because the raster scale
   *     is what the decode numbers are about;
   *   * the desktop run is the round's measured record (`baselines/linux-chrome-148.json` and the
   *     S1-S4 tables in docs/perf-harness.md), so it stays at its fixed 1280x800 viewport with the
   *     stage used 1:1, and those numbers stay comparable. `--fit` opts a desktop run in.
   */
  fit?: boolean;
  /**
   * Collect the GPU trace categories and emit the `gpu` metric block (default `true`).
   *
   * `--no-gpu` is PROTECTIVE, not cosmetic: `disabled-by-default-skia.gpu` emits one event per draw
   * op, and a sibling repo has already had a capture silently truncated by trace-buffer overflow into
   * something that read as an idle page. Turning it off shrinks the trace and leaves every CPU number
   * untouched.
   */
  gpu?: boolean;
  /**
   * Also request a Chrome memory-infra dump at the measurement bracket and report the GPU allocator
   * deltas (default `false`).
   *
   * OFF BY DEFAULT because it is a CROSS-CHECK of the driver's VRAM figure, not a second answer: it
   * is Chrome's own accounting, and where the two disagree the driver number is the truth. It also
   * costs a category, two synchronous dumps and a detailed walk of every allocator in every process.
   */
  memoryDump?: boolean;
  durationMs?: number;
  artifactsDir?: string;
  outDir?: string;
  headless?: boolean;
  /**
   * Extra Chrome launch flags (the CLI's repeatable `--chrome-arg`), forwarded to the args of the
   * Chrome this harness launches.
   *
   * DESKTOP ONLY, and not a policy choice: a `device` run ATTACHES to the Chrome already running on
   * the phone, so there is no launch line to put a flag on. The device path warns rather than
   * dropping them quietly.
   */
  extraArgs?: string[];
  device?: DeviceOptions;
  onProgress?: (message: string) => void;
}

export interface RunOutcome {
  reports: BrowserPerfReport[];
  outDir: string;
  /**
   * Arms this checkout could not measure, and the command that would make it able to.
   *
   * ABSENT MEANS NOT MEASURED, NEVER ZERO — the rule this harness exists to keep. An arm whose
   * build output is missing is dropped from the sweep rather than run into a blank page, and it is
   * reported HERE so the caller prints it beside the table instead of a reader inferring a missing
   * row. Empty on every run that swept everything it was asked to.
   */
  notMeasured: UnavailableMechanism[];
}

export const DEFAULT_ARTIFACTS_DIR = resolve("artifacts/perf");

/**
 * Atlas fixture options implied by a scenario's resolved parameters. Single source of truth so the
 * measured run, `--serve` and `--dump-trace-names` can never end up looking at DIFFERENT pages —
 * `scaleDiversity` changes the fixture, not just the DOM.
 */
function atlasOptionsFor(params: Record<string, ParamValue>): {
  pageSize: number;
  regionCount: number;
  regionInset: boolean;
} {
  // A scenario that does not declare `atlasPage` / `regions` gets the shared defaults. Reading the
  // params raw produced `Number(undefined)` -> NaN, which reached `Buffer.alloc(NaN)` inside the
  // generator and failed with `ERR_OUT_OF_RANGE` — an error that says nothing about the missing
  // parameter and points at a file the scenario author never touched.
  return {
    pageSize: numberOr(params.atlasPage, ATLAS_DEFAULTS.pageSize),
    regionCount: numberOr(params.regions, ATLAS_DEFAULTS.regionCount),
    regionInset: !usesUniformRegions(params),
  };
}

function numberOr(value: ParamValue | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Generate + describe the optional large-background fixture a scenario declared. Returns the shape
 * `startPerfServer` wants, so no call site has to know whether a scenario uses one.
 */
async function backgroundFixtureFor(
  scenario: Scenario,
  params: Record<string, ParamValue>,
  artifactsDir: string,
): Promise<{
  backgroundPngPath?: string;
  backgroundSize?: { width: number; height: number };
  described: string;
}> {
  const size = scenario.backgroundFixture?.(params);
  if (!size) {
    return { described: "" };
  }
  const background = await ensureBackgroundFixture(artifactsDir, size);
  return {
    backgroundPngPath: background.pngPath,
    backgroundSize: { width: background.width, height: background.height },
    described: `background ${background.width}x${background.height}, ${(background.bytes / 1e6).toFixed(2)} MB${background.generated ? " (generated)" : " (cached)"}`,
  };
}

/**
 * Download + subset the CJK font a scenario declared, and describe it. Same shape as
 * `backgroundFixtureFor`, so no call site has to know whether a scenario draws text.
 *
 * The repo root is derived from this module's own location rather than `process.cwd()`: the atlas
 * fixture can afford a cwd assumption because it writes under `artifacts/`, but the font is written
 * into `fixtures/` and read back by Godot through a `res://` symlink, so landing it in the wrong
 * tree would produce a Godot arm that renders a different font from the browser arms.
 */
async function fontFixtureFor(scenario: Scenario): Promise<{
  fontPath?: string;
  latinFontPath?: string;
  described: string;
}> {
  if (!scenario.fontFixture) {
    return { described: "" };
  }
  const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
  // BOTH faces, whatever `script` asks for. The scenario fetches only the ones it draws, so serving
  // the other costs a file read; NOT serving it would turn `--param script=latin` into a 404 inside
  // `ready()`, i.e. a whole failed run rather than a parameter.
  const [han, latin] = await Promise.all([
    ensureCjkFont(repoRoot),
    ensureLatinBenchFont(repoRoot),
  ]);
  const describe = (font: {
    relativePath: string;
    bytes: number;
    subset: boolean;
    subsetSkippedReason?: string;
  }) =>
    `${font.relativePath} ${(font.bytes / 1e6).toFixed(2)} MB${
      font.subset
        ? " (subset)"
        : ` (FULL UPSTREAM FILE - subset skipped: ${font.subsetSkippedReason})`
    }`;
  return {
    fontPath: han.path,
    latinFontPath: latin.path,
    described: `fonts ${describe(han)}, ${describe(latin)}`,
  };
}

/** A `StageFit` reconstructed from what the page reported, for the geometry lock. */
function fitOf(page: PerfRunResult): StageFit {
  return {
    scale: page.fit.scale,
    stage: page.fit.stage,
    fitted: page.fit.fitted,
    offset: page.fit.offset,
    viewport: page.viewport,
    orientation: page.fit.orientation,
    fits: page.fit.fits,
  };
}

function geometryOf(
  page: PerfRunResult,
  emulatedViewport: string | null,
): ReportGeometry {
  return {
    viewport: page.viewport,
    devicePixelRatio: page.devicePixelRatio,
    orientation: page.fit.orientation,
    fit: page.fit.enabled,
    fitScale: Math.round(page.fit.scale * 1e6) / 1e6,
    stage: page.fit.stage,
    fittedStage: {
      width: Math.round(page.fit.fitted.width * 100) / 100,
      height: Math.round(page.fit.fitted.height * 100) / 100,
    },
    grid: page.fit.grid
      ? `${page.fit.grid.columns}x${page.fit.grid.rows}`
      : null,
    emulatedViewport,
  };
}

/**
 * The desktop rung of `GpuDeviceMetrics`: what the DRIVER attributes to our Chrome's GPU process.
 *
 * The `gfxinfo` block is filled with nulls rather than left out — it is Android's HWUI read-out, this
 * run has no Android View hierarchy, and NOT MEASURED is the only honest thing to say about it. The
 * table renders each of those nulls as an em dash next to the command that would have produced them.
 */
function vramMetrics(
  before: ChromeVramSample | null,
  after: ChromeVramSample,
): GpuDeviceMetrics {
  const delta =
    before?.usedBytes != null && after.usedBytes != null
      ? after.usedBytes - before.usedBytes
      : null;
  return {
    source: "nvidia-smi",
    gfxinfo: gfxInfoNotMeasured(),
    gpuMemoryBytes: after.usedBytes,
    gpuMemoryDeltaBytes: delta,
    attribution: after.attribution,
    memoryDump: null,
  };
}

/**
 * Attach the `--memory-dump` cross-check to whatever driver reading the run has.
 *
 * When there is none (the flag on a box with no NVIDIA GPU), the block still goes out with
 * `source: null` — the cross-check WAS measured and hiding it would be a lie, but promoting Chrome's
 * self-counted total into `gpuMemoryBytes` would be the worse one: that field means "the driver said
 * so", and nothing about a memory-infra dump is the driver saying anything.
 */
function withMemoryDump(
  device: GpuDeviceMetrics | null,
  crossCheck: MemoryDumpCrossCheck | null,
): GpuDeviceMetrics | null {
  if (crossCheck === null) {
    return device;
  }
  if (device) {
    return { ...device, memoryDump: crossCheck };
  }
  return {
    source: null,
    gfxinfo: gfxInfoNotMeasured(),
    gpuMemoryBytes: null,
    gpuMemoryDeltaBytes: null,
    attribution: null,
    memoryDump: crossCheck,
  };
}

/** The memory-infra dumps belonging to the GPU PROCESS, which is where GPU allocators live. */
function gpuMemoryDumpOf(events: TraceEvent[]): MemoryDumpCrossCheck | null {
  const samples = parseMemoryDumps(events);
  if (samples.length === 0) {
    return null;
  }
  for (const [pid, name] of buildThreadIndex(events).process) {
    if (/GPU Process/i.test(name)) {
      const crossCheck = memoryDumpCrossCheck(samples, pid);
      if (crossCheck) {
        return crossCheck;
      }
    }
  }
  return null;
}

/** One progress line per repeat, so the number is visible while it is being measured. */
function describeGpuMemory(device: GpuDeviceMetrics): string {
  const mb = (bytes: number | null, signed = false): string =>
    bytes === null
      ? "—"
      : `${signed && bytes >= 0 ? "+" : ""}${(bytes / 1e6).toFixed(2)} MB`;
  const head =
    device.gpuMemoryBytes === null
      ? "gpu memory: NOT MEASURED"
      : `gpu memory: ${mb(device.gpuMemoryBytes)} (window ${mb(device.gpuMemoryDeltaBytes, true)})`;
  return `${head} — ${device.attribution ?? `${device.source ?? "no driver source"}`}`;
}

export async function runComparison(options: RunOptions): Promise<RunOutcome> {
  const {
    scenario: scenarioName,
    paramOverrides = {},
    repeats = 5,
    warmups = 1,
    deviceScaleFactor = 1,
    durationMs = 2500,
    artifactsDir = DEFAULT_ARTIFACTS_DIR,
    headless = true,
    gpu: collectGpu = true,
    memoryDump = false,
    extraArgs = [],
    onProgress = () => {},
  } = options;
  const categories = traceCategoriesFor(collectGpu, memoryDump);

  const scenario = getScenario(scenarioName);

  // THE SWEEP, AND WHAT THIS CHECKOUT CAN ACTUALLY MEASURE.
  //
  // An arm whose build output is missing must never be RUN — it would mount, fail to fetch its
  // wasm, and either abort the whole run from `ready()` (S7's trap) or, worse, draw nothing and
  // report the excellent numbers of a blank page. So the sweep is filtered here, before a fixture
  // is generated or a browser launched, and the absence travels out in `RunOutcome.notMeasured`.
  //
  // ASKED FOR EXPLICITLY IS A FAILURE, NOT A SKIP. Dropping `--mechanism hb-gpu` on a checkout that
  // has not built it would print an empty table and exit 0, which is the same lie in a quieter
  // voice.
  const requested = options.mechanisms?.length ? options.mechanisms : null;
  const sweep = requested ?? mechanismsOf(scenario);
  const notMeasured = await unavailableMechanisms(scenario.name, sweep);
  if (requested && notMeasured.length > 0) {
    throw new Error(unavailableMechanismError(notMeasured));
  }
  const mechanisms = sweep.filter(
    (mechanism) => !notMeasured.some((entry) => entry.mechanism === mechanism),
  );
  for (const entry of notMeasured) {
    onProgress(
      `NOT MEASURED: ${entry.mechanism} — ${entry.what}\n  ${entry.command}`,
    );
  }
  const kind = options.env?.kind ?? "ci";

  // VIEWPORT POLICY, in one place.
  //
  // `ci` keeps the fixed 1280x800 emulated viewport it always had, so the committed baseline and the
  // reference tables in docs/perf-harness.md stay comparable. `device` measures at the phone's OWN
  // viewport and orientation — force-emulating a desktop size there rasters the page at a scale the
  // device never uses, and raster scale is what the decode numbers this harness exists for are made
  // of. Passing `--viewport` explicitly re-enables emulation on either.
  const { viewport, emulate, fit } = resolveViewportPolicy({
    // The viewport policy only ever splits phone from local box. `host` is the same hardware class as
    // `ci` (see `ReportEnvironmentKind`), so it takes the `ci` policy rather than widening a knob that
    // has no third setting.
    kind: kind === "device" ? "device" : "ci",
    viewport: options.viewport,
    fit: options.fit,
  });

  // Device preflight FIRST, before anything expensive. A device run that cannot see the phone must
  // say so in a second with one actionable message, not after generating a 15 MB atlas page.
  const preflight =
    kind === "device" ? await selectDevice(options.device ?? {}) : undefined;

  // Say it out loud instead of dropping them. `--chrome-arg` exists for flags a scenario NEEDS (a
  // WebGPU scenario is not measurable without them), so a device run that silently ignored them
  // would report numbers for a page that never got the feature — which reads as the feature being
  // slow, not as the flag having gone nowhere.
  if (preflight !== undefined && extraArgs.length > 0) {
    onProgress(
      "WARNING: --chrome-arg is IGNORED with --env device — the phone's Chrome is attached to, not launched",
    );
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = options.outDir ?? join(artifactsDir, "runs", runId);
  await mkdir(outDir, { recursive: true });

  const baseParams = resolveParams(scenario, paramOverrides);
  const atlas = await ensureAtlasFixture(
    artifactsDir,
    atlasOptionsFor(baseParams),
  );
  onProgress(
    `atlas ${atlas.pageSize}x${atlas.pageSize}, ${atlas.regions.length} regions, ${(atlas.bytes / 1e6).toFixed(2)} MB${atlas.generated ? " (generated)" : " (cached)"}`,
  );

  const background = await backgroundFixtureFor(
    scenario,
    baseParams,
    artifactsDir,
  );
  if (background.described) {
    onProgress(background.described);
  }
  const font = await fontFixtureFor(scenario);
  if (font.described) {
    onProgress(font.described);
  }

  const server = await startPerfServer({
    atlasPngPath: atlas.pngPath,
    atlasJsonPath: atlas.jsonPath,
    backgroundPngPath: background.backgroundPngPath,
    backgroundSize: background.backgroundSize,
    fontPath: font.fontPath,
    latinFontPath: font.latinFontPath,
  });

  let browser: PerfBrowser;
  try {
    browser =
      preflight === undefined
        ? await openLocalBrowser({
            artifactsDir,
            headless,
            windowSize: viewport,
            deviceScaleFactor,
            extraArgs,
          })
        : await openDeviceBrowser({
            ...options.device,
            serial: preflight.entry.serial,
            serverPort: server.port,
            onProgress,
          });
  } catch (error) {
    // The server holds the event loop open; without this an unreachable phone hangs the CLI after
    // printing its (perfectly good) error.
    await server.close();
    throw error;
  }
  onProgress(browser.describe);

  const device =
    preflight === undefined ? undefined : (browser as DeviceBrowser);
  // What GPU is this, really? Asked once per run, browser-level, and it costs nothing — but without
  // it a bucket total is a number with no environment attached, and GPU numbers are comparable within
  // an environment ONLY (this box is SwiftShader; there is no hardware GPU here at all).
  const gpuHardware = await readGpuHardware(browser.client);
  onProgress(
    collectGpu
      ? `gpu: ${gpuHardware.hardware}${gpuHardware.hardwareDetail && gpuHardware.hardwareDetail !== gpuHardware.hardware ? ` — ${gpuHardware.hardwareDetail}` : ""}`
      : `gpu: NOT COLLECTED (--no-gpu); gpu.available will be false. CPU numbers are unaffected. Hardware is ${gpuHardware.hardware}`,
  );

  // DESKTOP VRAM, gated on the environment actually being able to produce it. All four conditions are
  // load-bearing:
  //   * not a device run — the phone's driver figure comes from `dumpsys gfxinfo` at the same seam;
  //   * `--gpu` on — a run that declined to measure the GPU must not publish a GPU byte count;
  //   * an NVIDIA renderer string, straight from Chrome (`describeGpuHardware`) — a headless
  //     SwiftShader run has no GPU context at all, and shelling out to nvidia-smi there would pay a
  //     subprocess per bracket to learn nothing;
  //   * a pid we LAUNCHED — attribution is by descendant pid, and there is nothing to descend from
  //     when the harness attached to a browser it did not spawn.
  const chromePid = browser.pid;
  const vramEnabled =
    !device && collectGpu && chromePid !== null && isNvidiaGpu(gpuHardware);
  if (vramEnabled) {
    onProgress(
      `vram: nvidia-smi per-process, attributed to the ${GPU_PROCESS_FLAG} descendant of chrome pid ${chromePid} — never the box-wide fb_memory_usage`,
    );
  }
  if (memoryDump) {
    onProgress(
      "memory-dump: ON — Chrome's own allocator totals as a CROSS-CHECK. Self-counted; where it disagrees with the driver's VRAM figure, the DRIVER is the truth",
    );
  }

  const conditionsBefore = await device?.conditions();
  const naturalViewport = device
    ? await probeNaturalViewport(browser, viewport)
    : undefined;
  if (device && conditionsBefore) {
    onProgress(
      `before: battery ${conditionsBefore.batteryPct ?? "?"}% ${conditionsBefore.batteryTemperatureC ?? "?"} °C, thermalStatus ${conditionsBefore.thermalStatus ?? "?"}`,
    );
    onProgress(
      emulate
        ? `viewport: measuring at ${viewport.width}x${viewport.height}@${deviceScaleFactor} (EMULATED, --viewport was passed) — the phone's own is ${naturalViewport ?? "unknown"}`
        : `viewport: measuring at the phone's OWN ${naturalViewport ?? "unknown"} — the scenario stage is fitted into it`,
    );
  }
  onProgress(
    fit
      ? "fit: on — the scenario shapes itself to the viewport's aspect and is scaled to fit it"
      : "fit: off — the scenario is laid out directly in the viewport at its authored size",
  );

  const env: ReportEnvironment = {
    kind,
    label: options.env?.label ?? browser.envLabel,
    // Never throttle a phone: it IS the slow hardware. `null` is legal for a device browser-render
    // report precisely so nobody has to invent a "1" that reads like a measured choice.
    cpuThrottle:
      browser.defaultCpuThrottle === null
        ? null
        : (options.env?.cpuThrottle ?? 1),
    device: null,
  };

  const reports: BrowserPerfReport[] = [];
  let viewportWarned = false;
  // The GEOMETRY LOCK. The first measured repeat fixes the geometry every later one must match:
  // decode and raster cost scale with the raster scale, so a repeat taken at a different fit scale
  // (a phone rotated mid-run, a window resized) is a different experiment and must not be averaged
  // into the same median.
  let locked: StageFit | undefined;
  try {
    for (const mechanism of mechanisms) {
      const params = resolveParams(scenario, { ...paramOverrides, mechanism });
      const runs: ReportMetrics[] = [];
      const failures: string[] = [];
      let lastTrace = "";
      let lastShot = "";

      for (let repeat = 0; repeat < warmups + repeats; repeat++) {
        const isWarmup = repeat < warmups;
        const tag = `${mechanism}-${isWarmup ? "warmup" : `r${repeat - warmups}`}`;
        const tracePath = join(outDir, "traces", `${tag}.json.gz`);
        const shotPath = join(outDir, "shots", `${tag}.png`);
        const url = server.scenarioUrl({
          ...params,
          scenario: scenario.name,
          durationMs,
          // The page fits itself: only it knows the real viewport, which on a device run is
          // deliberately not one this process chose.
          fit: fit ? 1 : 0,
          // A per-repeat URL is what makes each repeat a COLD decode: Chrome's decoded-image cache
          // is keyed by URL and survives across contexts.
          cacheBust: `${runId}-${tag}`,
        });

        onProgress(`  ${tag}…`);
        // THE OUT-OF-BAND BRACKET. Neither the phone's `dumpsys gfxinfo` nor the desktop's
        // `nvidia-smi` has a trace representation, so both are sampled around the page's own `run()`
        // — as tightly as an adb round trip / a subprocess allows. The bracket therefore covers
        // mount + the measured window, which is wider than the trace window: stated in the docs
        // rather than papered over, and for the VRAM delta it is exactly the span wanted, because
        // mount is when a scenario uploads its textures.
        //
        // ONE SEAM, TWO INSTRUMENTS: a device run gets the gfxinfo window, a desktop NVIDIA run the
        // nvidia one, and `--memory-dump` adds Chrome's own dump to whichever is in play. Every hook
        // is individually try/caught on top of `capture.ts`'s own `.catch()`, so one instrument
        // failing can never suppress another — and a failure here must never fail a measurement.
        let windowDevice: GpuDeviceMetrics | null = null;
        let vramBefore: ChromeVramSample | null = null;
        const chromePackage = device?.chromePackage ?? null;
        const hooks: {
          before?: () => Promise<void>;
          after?: () => Promise<void>;
        }[] = [];
        if (device && collectGpu && chromePackage) {
          hooks.push({
            before: () => resetGfxInfo(device.adb, chromePackage),
            after: async () => {
              windowDevice = await readGpuDeviceMetrics(
                device.adb,
                chromePackage,
              );
            },
          });
        }
        if (vramEnabled && chromePid !== null) {
          hooks.push({
            before: async () => {
              vramBefore = await sampleChromeVram(chromePid);
            },
            after: async () => {
              windowDevice = vramMetrics(
                vramBefore,
                await sampleChromeVram(chromePid),
              );
            },
          });
        }
        if (memoryDump) {
          // Same seam, and the dump is SYNCHRONOUS with the call: `deterministic: true` also asks
          // Chrome to run a GC first, so the totals describe live allocations rather than whatever
          // had not been collected yet.
          const requestDump = async () => {
            await browser.client.send(
              "Tracing.requestMemoryDump",
              { levelOfDetail: "detailed", deterministic: true },
              { flat: true, timeoutMs: 30_000 },
            );
          };
          hooks.push({ before: requestDump, after: requestDump });
        }
        const gfxWindow =
          hooks.length === 0
            ? undefined
            : {
                before: async () => {
                  for (const hook of hooks) {
                    await hook.before?.().catch(() => undefined);
                  }
                },
                after: async () => {
                  for (const hook of hooks) {
                    await hook.after?.().catch(() => undefined);
                  }
                },
              };
        let capture: Awaited<ReturnType<typeof captureRun>>;
        try {
          capture = await captureRun({
            client: browser.client,
            targets: browser.targets,
            url,
            tracePath,
            viewport,
            deviceScaleFactor,
            emulate,
            cpuThrottle: env.cpuThrottle,
            categories,
            window: gfxWindow,
            // On a phone a stalled poll almost always means the tab went to the background; fail in
            // 20 s with the reason instead of after a minute with "CDP timeout".
            probeTimeoutMs: device ? 20_000 : 30_000,
          });
        } catch (error) {
          throw device ? decorateDeviceError(error) : error;
        }
        await mkdir(join(outDir, "shots"), { recursive: true });
        await writeFile(shotPath, capture.screenshot);

        const presence = await checkPresence({
          screenshot: capture.screenshot,
          samplePoints: capture.page.samplePoints,
          devicePixelRatio: capture.page.devicePixelRatio,
          // MEASURED scale, not DPR × CSS: an Android screenshot is the physical window, which is
          // neither `viewport × DPR` nor the same on both axes. See presence.ts.
          cssViewport: capture.page.viewport,
        });

        // An emulation that did not take effect changes the geometry under the measurement, so say
        // so rather than let the presence guard report a mysterious "blank page". Only checked when
        // emulation was actually requested: on a device run the page's viewport is SUPPOSED to be
        // the phone's own and differ from this default.
        if (
          emulate &&
          !viewportWarned &&
          Math.abs(capture.page.viewport.width - viewport.width) > 2
        ) {
          viewportWarned = true;
          onProgress(
            `WARNING: requested a ${viewport.width}x${viewport.height} viewport but the page reports ${capture.page.viewport.width}x${capture.page.viewport.height} — Emulation.setDeviceMetricsOverride did not take effect`,
          );
        }

        const measuredFit = fitOf(capture.page);
        if (!isWarmup && locked === undefined) {
          locked = measuredFit;
          env.geometry = geometryOf(
            capture.page,
            emulate
              ? `${viewport.width}x${viewport.height}@${deviceScaleFactor}`
              : null,
          );
          onProgress(`geometry: ${describeFit(measuredFit, fit)}`);
        }

        if (isWarmup) {
          continue;
        }
        lastTrace = tracePath;
        lastShot = shotPath;

        // Chrome told us it DROPPED events. A truncated capture does not look broken — it looks like
        // a page that did less work, which is the most dangerous shape a perf measurement can take, so
        // the repeat is discarded rather than analyzed. The GPU categories are the usual cause.
        if (capture.traceDataLoss) {
          failures.push(
            `${tag}: Chrome reported dataLossOccurred — the trace ring buffer wrapped and events were DROPPED, ` +
              `so this capture is TRUNCATED, not cheap; run DISCARDED. ` +
              (collectGpu
                ? "The GPU categories are the usual cause: re-run with --no-gpu (CPU numbers are unaffected) or a shorter --duration."
                : "Try a shorter --duration."),
          );
          continue;
        }

        // A repeat measured at different geometry is a different experiment. Discarded rather than
        // averaged in — the alternative is a median over two raster scales, which is a number that
        // describes nothing.
        if (locked && !sameGeometry(locked, measuredFit)) {
          failures.push(
            `${tag}: geometry CHANGED mid-run (${describeFit(locked, fit)} -> ${describeFit(measuredFit, fit)}) — ` +
              "raster scale drives decode cost, so this repeat is not comparable with the others; run DISCARDED",
          );
          continue;
        }
        // The scenario under-declared its own stage: content it mounts lies outside the box the fit
        // scaled, so the stage's clip is eating it. A scenario defect, named as one.
        if (capture.page.fit.samplePointsOutsideStage > 0) {
          failures.push(
            `${tag}: ${capture.page.fit.samplePointsOutsideStage}/${capture.page.samplePoints.length} sample points lie OUTSIDE the scenario's declared stage ` +
              `(${capture.page.fit.stage.width}x${capture.page.fit.stage.height} CSS px) — \`${scenario.name}.stageSize()\` is too small for what it mounts; run DISCARDED`,
          );
          continue;
        }
        if (!capture.page.fit.fits) {
          failures.push(
            `${tag}: the fitted stage (${capture.page.fit.fitted.width}x${capture.page.fit.fitted.height}) does not fit the ` +
              `${capture.page.viewport.width}x${capture.page.viewport.height} viewport — the content genuinely cannot be shown at this size; run DISCARDED`,
          );
          continue;
        }

        if (!presence.ok) {
          // The geometry goes in the message: a presence failure is almost always "the content did
          // not fit the viewport", and a bare hit count makes that indistinguishable from "the page
          // rendered nothing". `outsideViewport` separates the two outright.
          failures.push(
            `${tag}: presence guard failed — only ${presence.sampleHits}/${presence.sampleCount} sample points were on screen ` +
              `(${presence.outsideViewport} of the misses fell OUTSIDE the viewport entirely, i.e. the content did not fit; ` +
              `page viewport ${capture.page.viewport.width}x${capture.page.viewport.height} CSS px, ` +
              `${describeFit(measuredFit, fit)}, ` +
              `screenshot ${presence.imageSize.width}x${presence.imageSize.height} px, ` +
              `CSS->image scale ${presence.scale.x}x${presence.scale.y}; screenshot ${shotPath}); run DISCARDED`,
          );
          continue;
        }

        // A device trace is captured over a USB-forwarded websocket and can take longer to read and
        // parse than to record. Without this line a slow phase is indistinguishable from a hang —
        // which is exactly how a real stall in this pipeline was misdiagnosed twice.
        onProgress(`  ${tag}: analyzing trace…`);
        const events = await readTraceEvents(tracePath);
        // The dumps come out of the trace, not out of the CDP reply: `Tracing.requestMemoryDump`
        // answers with a guid and writes the numbers into the capture as `ph: "v"` events.
        const deviceMetrics = memoryDump
          ? withMemoryDump(windowDevice, gpuMemoryDumpOf(events))
          : windowDevice;
        if (!isWarmup && deviceMetrics) {
          onProgress(`  ${tag}: ${describeGpuMemory(deviceMetrics)}`);
        }
        const traceMetrics = analyzeTrace(events, {
          windowMs: capture.page.windowMs,
          watchImageUrl: scenario.watchImageUrl,
          imagesExpected: scenario.paintsImages ?? true,
          gpu: {
            collected: collectGpu,
            ...gpuHardware,
            device: deviceMetrics,
          },
        });
        runs.push({
          ...traceMetrics,
          readyMs: Math.round(capture.page.readyMs * 100) / 100,
          blockedMs: Math.round(capture.page.blockedMs * 100) / 100,
          longAnimationFrames: capture.page.longAnimationFrames,
          longTaskCount: capture.page.longTaskCount,
          layerCount: capture.layerCount,
          presented: {
            nonEmptyRatio: presence.nonEmptyRatio,
            sampleHits: presence.sampleHits,
            sampleCount: presence.sampleCount,
            screenshot: relative(process.cwd(), shotPath),
          },
          // The scenario's own counters, only when it reported any. Spread rather than assigned so a
          // scenario that declares none carries NO key — an absent block means "not measured", and
          // writing `scenario: undefined` (or `{}`) here would blur that into "counted nothing".
          ...(capture.page.scenarioMetrics
            ? { scenario: capture.page.scenarioMetrics }
            : {}),
        });
      }

      if (runs.length === 0) {
        throw new Error(
          `mechanism "${mechanism}": every repeat failed.\n${failures.join("\n")}`,
        );
      }

      const report: BrowserPerfReport = {
        schema: REPORT_SCHEMA,
        repo: "godot-scene-web",
        // Every scenario in this package measures a real page in a browser; the sibling repos emit
        // the same envelope with their own profile (producer-walk / wire-payload / asset-render).
        profile: "browser-render",
        scenario: scenario.name,
        env,
        params,
        repeats: runs.length,
        warmups,
        metrics: medianMetrics(runs),
        runs,
        artifacts: {
          trace: relative(process.cwd(), lastTrace),
          screenshot: relative(process.cwd(), lastShot),
        },
        ...(failures.length > 0 ? { failures } : {}),
      };
      reports.push(report);
    }

    // Device conditions AFTER the last repeat. Sampled here, while the phone is still attached, and
    // written into the shared `env` object every report references — which is also why the report
    // files are written below rather than inside the loop.
    if (device && conditionsBefore) {
      const after = await device.conditions();
      const warnings = conditionWarnings(conditionsBefore, after);
      env.device = {
        model: device.props.model,
        androidRelease: device.props.androidRelease,
        chrome: device.chromeVersion,
        serial: device.props.serial,
        manufacturer: device.props.manufacturer,
        androidSdk: device.props.androidSdk,
        chromePackage: device.chromePackage,
        ...conditionsBefore,
        after,
        warnings,
        isolation: device.targets.isolation,
        // What the scenario was ACTUALLY measured at — the phone's own viewport unless `--viewport`
        // forced an emulated one. Reporting the requested size here while the page rendered at
        // another is precisely the mismatch this workstream removed.
        viewport: env.geometry
          ? `${env.geometry.viewport.width}x${env.geometry.viewport.height}@${env.geometry.devicePixelRatio}${emulate ? " (emulated)" : ""}`
          : `${viewport.width}x${viewport.height}@${deviceScaleFactor}`,
        naturalViewport: naturalViewport ?? undefined,
      };
      onProgress(
        `after:  battery ${after.batteryPct ?? "?"}% ${after.batteryTemperatureC ?? "?"} °C, thermalStatus ${after.thermalStatus ?? "?"}`,
      );
      for (const warning of warnings) {
        onProgress(`WARNING: ${warning}`);
      }
    }

    for (const report of reports) {
      await writeFile(
        join(outDir, `${scenario.name}-${report.params.mechanism}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
  } finally {
    onProgress("closing browser…");
    await browser.close();
    onProgress("closing harness server…");
    await server.close();
    onProgress("done");
  }

  return { reports, outDir, notMeasured };
}

/**
 * Start the server and stay up. Required so an EXTERNAL browser (chrome-devtools-mcp, a phone) can
 * visit the very same pages the harness measures and cross-check them visually and with its own
 * trace — a self-contained harness that nobody can look at is a harness nobody should trust.
 */
export async function serveScenarios(
  options: Pick<
    RunOptions,
    | "scenario"
    | "paramOverrides"
    | "durationMs"
    | "artifactsDir"
    | "device"
    | "fit"
  > & { reverseToDevice?: boolean },
): Promise<{
  origin: string;
  urls: string[];
  reversedTo: string | null;
  close(): Promise<void>;
}> {
  const {
    scenario: scenarioName,
    paramOverrides = {},
    durationMs = 2500,
    artifactsDir = DEFAULT_ARTIFACTS_DIR,
  } = options;
  const scenario = getScenario(scenarioName);
  const baseParams = resolveParams(scenario, paramOverrides);
  const atlas = await ensureAtlasFixture(
    artifactsDir,
    atlasOptionsFor(baseParams),
  );
  const background = await backgroundFixtureFor(
    scenario,
    baseParams,
    artifactsDir,
  );
  const font = await fontFixtureFor(scenario);
  const server = await startPerfServer({
    atlasPngPath: atlas.pngPath,
    atlasJsonPath: atlas.jsonPath,
    backgroundPngPath: background.backgroundPngPath,
    backgroundSize: background.backgroundSize,
    fontPath: font.fontPath,
    latinFontPath: font.latinFontPath,
  });
  // `--serve` exists so a HUMAN (or chrome-devtools-mcp) can open the very page the harness measures,
  // and the most common reason to do that is on a phone — so these URLs carry the fit by default.
  // `--no-fit` serves the unfitted page instead, which is what the desktop run measures.
  const fit = options.fit ?? true;
  const urls = mechanismsOf(scenario).map((mechanism) =>
    server.scenarioUrl({
      ...resolveParams(scenario, { ...paramOverrides, mechanism }),
      scenario: scenario.name,
      durationMs,
      fit: fit ? 1 : 0,
      autorun: 1,
      cacheBust: mechanism,
    }),
  );

  // `--serve --env device` makes these exact URLs work IN THE PHONE'S BROWSER, by tunnelling the
  // phone's own 127.0.0.1:<port> back here. That is how the render gets eyeballed on the device and
  // how an independent DevTools trace gets taken there.
  let reversedTo: string | null = null;
  let adb: Awaited<ReturnType<typeof selectDevice>>["adb"] | undefined;
  if (options.reverseToDevice) {
    try {
      const selected = await selectDevice(options.device ?? {});
      adb = selected.adb;
      await reverseServerPort(adb, server.port);
      reversedTo = selected.entry.serial;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  return {
    origin: server.origin,
    urls,
    reversedTo,
    async close() {
      if (adb) {
        await adb
          .exec(["reverse", "--remove", `tcp:${server.port}`])
          .catch(() => "");
      }
      await server.close();
    },
  };
}

/**
 * Capture one real trace and print a name+category+thread histogram over it.
 *
 * This exists because Chrome trace event names DRIFT between versions, and an analyzer coded against
 * remembered names silently reports zeroes. Run this first on any new Chrome (or on the phone) and
 * code the analyzer against what it actually prints.
 */
export async function dumpTraceNames(
  options: Pick<
    RunOptions,
    | "scenario"
    | "paramOverrides"
    | "durationMs"
    | "artifactsDir"
    | "viewport"
    | "headless"
    | "env"
    | "device"
    | "fit"
    | "gpu"
    | "extraArgs"
  > & { limit?: number; categories?: readonly string[] },
): Promise<{ text: string; chrome: string; tracePath: string }> {
  const {
    scenario: scenarioName,
    paramOverrides = {},
    durationMs = 2000,
    artifactsDir = DEFAULT_ARTIFACTS_DIR,
    headless = true,
    limit = 200,
    // The probe must see what a MEASURED run sees, GPU categories included — otherwise the first
    // person to wonder why a GPU bucket is empty gets a histogram that could not have shown it.
    categories = traceCategoriesFor(options.gpu ?? true),
  } = options;
  const kind = options.env?.kind ?? "ci";
  // Same viewport policy as a measured run: the probe must capture the trace the REAL device run
  // will produce, and a probe taken at a force-emulated desktop viewport can differ in exactly the
  // way that matters here (a phone that composites the fitted page on the GPU emits a different
  // decode-cache family from one that does not).
  const { viewport, emulate, fit } = resolveViewportPolicy({
    // The viewport policy only ever splits phone from local box. `host` is the same hardware class as
    // `ci` (see `ReportEnvironmentKind`), so it takes the `ci` policy rather than widening a knob that
    // has no third setting.
    kind: kind === "device" ? "device" : "ci",
    viewport: options.viewport,
    fit: options.fit,
  });
  const preflight =
    kind === "device" ? await selectDevice(options.device ?? {}) : undefined;

  const scenario = getScenario(scenarioName);
  const params = resolveParams(scenario, paramOverrides);
  const atlas = await ensureAtlasFixture(artifactsDir, atlasOptionsFor(params));
  const background = await backgroundFixtureFor(scenario, params, artifactsDir);
  const font = await fontFixtureFor(scenario);

  const server = await startPerfServer({
    atlasPngPath: atlas.pngPath,
    atlasJsonPath: atlas.jsonPath,
    backgroundPngPath: background.backgroundPngPath,
    backgroundSize: background.backgroundSize,
    fontPath: font.fontPath,
    latinFontPath: font.latinFontPath,
  });
  let browser: PerfBrowser;
  try {
    browser =
      preflight === undefined
        ? await openLocalBrowser({
            artifactsDir,
            headless,
            windowSize: viewport,
            // The probe must launch the browser a MEASURED run launches, flags included: a trace
            // taken without them is a histogram of a different Chrome.
            extraArgs: options.extraArgs,
          })
        : await openDeviceBrowser({
            ...options.device,
            serial: preflight.entry.serial,
            serverPort: server.port,
          });
  } catch (error) {
    await server.close();
    throw error;
  }
  const tracePath = join(artifactsDir, "trace-names", "capture.json.gz");
  try {
    const capture = await captureRun({
      client: browser.client,
      targets: browser.targets,
      url: server.scenarioUrl({
        ...params,
        scenario: scenario.name,
        durationMs,
        fit: fit ? 1 : 0,
        cacheBust: "dump-trace-names",
      }),
      tracePath,
      viewport,
      emulate,
      cpuThrottle: browser.defaultCpuThrottle,
      categories,
    });
    const events = await readTraceEvents(capture.tracePath);
    const histogram = traceNameHistogram(events);
    const header = [
      `browser: ${browser.describe}`,
      `categories: ${categories.join(",")}`,
      `trace: ${capture.tracePath} (${(capture.traceBytes / 1e6).toFixed(2)} MB)`,
      "",
    ].join("\n");
    return {
      // The matcher probe goes FIRST: on a new Chrome (and above all on the phone, whose GPU decode
      // path emits a different cache family from this box's SwiftShader) the only question that
      // matters is "do the analyzer's names still match?", and it should not have to be answered by
      // reading 200 histogram rows.
      text: `${header + formatMatcherProbe(events)}\n\n${formatTraceNameHistogram(histogram, limit)}`,
      chrome: browser.version,
      tracePath: capture.tracePath,
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

/**
 * The phone's natural viewport, probed on `about:blank` before any emulation override — context for
 * the emulated one the scenario is actually measured at.
 */
async function probeNaturalViewport(
  browser: PerfBrowser,
  viewport: { width: number; height: number },
): Promise<string | undefined> {
  try {
    const lease = await browser.targets.acquire(viewport);
    try {
      const info = await browser.client.evaluate<{
        w: number;
        h: number;
        dpr: number;
      }>(
        "({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })",
        { timeoutMs: 15_000 },
      );
      return `${info.w}x${info.h}@${info.dpr}`;
    } finally {
      await lease.release();
    }
  } catch {
    return undefined;
  }
}
