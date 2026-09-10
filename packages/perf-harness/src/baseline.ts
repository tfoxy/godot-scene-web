// Committed baselines: `packages/perf-harness/baselines/<env>.json`.
//
// Deliberately NOT under the gitignored `artifacts/` tree. A baseline is the one output of this
// harness that is worth keeping in the repository — it is small, it is reviewable in a diff, and its
// whole purpose is to still be there in six months when someone asks "was the phone always this
// slow?". Traces (hundreds of MB) and screenshots stay ignored.
//
// A baseline is the MEDIANS per mechanism plus the environment they were measured in. Per-repeat
// `runs` are dropped: they are what the medians are for, and keeping them would multiply the file
// size by six for no reviewable gain.
//
// It carries the environment block verbatim on purpose, including the device's battery and thermal
// readings before AND after. Numbers from a thermally throttled phone are not a baseline, and a file
// that cannot be told apart from one is worse than no file.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BrowserPerfReport,
  ReportEnvironment,
  ReportMetrics,
} from "./report";

export const BASELINE_SCHEMA = "perf-baseline/1";

export interface PerfBaseline {
  schema: typeof BASELINE_SCHEMA;
  capturedAt: string;
  repo: "godot-scene-web";
  scenario: string;
  env: ReportEnvironment;
  repeats: number;
  warmups: number;
  /** Scenario params shared by every mechanism (`mechanism` itself is the key below). */
  params: Record<string, string | number | boolean>;
  /** Median metrics per mechanism. */
  mechanisms: Record<string, ReportMetrics>;
  /**
   * Which metrics survive a change of environment. GPU/compositing counts do NOT: SwiftShader has no
   * `CompositorGpuThread` and its layerisation is its own, so comparing a headless `layerCount`
   * against a phone's is meaningless. CPU, decode and activation timings do compare.
   */
  portability: {
    portable: string[];
    environmentSpecific: string[];
  };
}

export const PORTABLE_METRICS = [
  "initialRenderMs",
  "readyMs",
  "frameCostMs",
  "contentUpdateHz",
  "activationGapMs",
  "blockedMs",
  "longTaskCount",
  "longAnimationFrames",
  "decode.*",
  "paint.*",
  "rasterMs",
  "mainThreadCpuRatio",
  "mainThreadBusyMs",
  // WHICH thread holds the work ports between environments even though the milliseconds do not.
  "cpu.byThread[].process/thread ordering",
];

export const ENVIRONMENT_SPECIFIC_METRICS = [
  "layerCount",
  "renderSurfaces",
  "renderSurfaceReasons",
  "renderSurfaceListPasses",
  "swapRateHz",
  "presented.nonEmptyRatio",
  // The whole GPU block. This box is SwiftShader when headless — a software rasteriser with no
  // hardware GPU at all — an RTX 2060 when headed, and the phone is a Mali behind ANGLE, so a bucket
  // total from one says nothing about the other.
  "gpu.* (SwiftShader headless / RTX 2060 headed here, Mali/ANGLE on the phone)",
  // DRIVER-ATTRIBUTED VRAM, and the reason it needs its own line rather than hiding under `gpu.*`:
  // the two rungs are different instruments as well as different hardware. `dumpsys gfxinfo` reports
  // HWUI's total for the WHOLE Chrome package on Android; `nvidia-smi -q -x` reports the NVIDIA
  // driver's PER-PROCESS figure for the GPU process of the Chrome the run launched. `source` names
  // which one produced the bytes, and a byte from one is not comparable with a byte from the other.
  "gpu.device.gpuMemoryBytes / gpu.device.gpuMemoryDeltaBytes (source: dumpsys-gfxinfo | nvidia-smi)",
  // Chrome's own allocator totals (`--memory-dump`). Self-counted, and its relationship to the
  // driver's figure is a property of the GPU stack under it — an ANGLE/Mali gap is not this box's.
  "gpu.device.memoryDump.*",
  // Absolute CPU milliseconds: they are `tdur` LOWER BOUNDS, so they are only as comparable as the
  // two captures' category sets and thread inventories.
  "cpu.totalCpuMs / cpu.byProcess.*.cpuMs",
];

/** `packages/perf-harness/baselines`, resolved from this module so cwd cannot move it. */
export function defaultBaselineDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "baselines");
}

export function buildBaseline(reports: BrowserPerfReport[]): PerfBaseline {
  if (reports.length === 0) {
    throw new Error("buildBaseline: no reports");
  }
  const head = reports[0];
  const { mechanism: _mechanism, ...params } = head.params;
  const mechanisms: Record<string, ReportMetrics> = {};
  for (const report of reports) {
    mechanisms[String(report.params.mechanism ?? "default")] = {
      ...report.metrics,
      presented: {
        ...report.metrics.presented,
        // The screenshot path points into the ignored artifacts tree and is meaningless to a reader
        // of a committed file six months later; the hit counts are what the guard actually proves.
        screenshot: "",
      },
    };
  }
  return {
    schema: BASELINE_SCHEMA,
    capturedAt: new Date().toISOString(),
    repo: "godot-scene-web",
    scenario: head.scenario,
    env: head.env,
    repeats: head.repeats,
    warmups: head.warmups,
    params,
    mechanisms,
    portability: {
      portable: PORTABLE_METRICS,
      environmentSpecific: ENVIRONMENT_SPECIFIC_METRICS,
    },
  };
}

export async function writeBaseline(
  reports: BrowserPerfReport[],
  options: { name?: string; dir?: string } = {},
): Promise<{ path: string; baseline: PerfBaseline }> {
  const baseline = buildBaseline(reports);
  const name = (options.name ?? baseline.env.label).replace(
    /[^a-zA-Z0-9._-]+/g,
    "-",
  );
  const dir = options.dir ?? defaultBaselineDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`);
  return { path, baseline };
}
