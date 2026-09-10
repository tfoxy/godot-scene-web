// The `cpu` and `gpu` metric blocks.
//
// Two properties are load-bearing and are asserted directly rather than implied:
//   1. the cpu block reads EVERY process (the renderer-pid filter is lifted for it alone), and
//   2. lifting it changes NOTHING else — the renderer-scoped metrics are byte-identical whether or
//      not browser/GPU events are in the trace.
// (2) is the reason the pre-existing baselines are still valid, so it is a test, not a comment.

import { describe, expect, it } from "vitest";
import {
  analyzeTrace,
  computeCpu,
  gfxInfoNotMeasured,
  gpuBucketOf,
  processKeyOf,
} from "../src/analyze";
import { describeGpuHardware } from "../src/browser";
import { parseGfxInfo, parseGpuMemoryBytes } from "../src/device";
import {
  medianCpu,
  medianGpu,
  validateCpuBlock,
  validateGpuBlock,
} from "../src/report";
import { GPU_TRACE_CATEGORIES, traceCategoriesFor } from "../src/trace";
import { crossProcessEvents, healthyTrace } from "./trace-fixtures";

const GPU_ON = { collected: true, hardware: "swiftshader" };

function tracedRun() {
  return analyzeTrace([...healthyTrace(), ...crossProcessEvents()], {
    windowMs: 200,
    gpu: GPU_ON,
  });
}

describe("cpu block", () => {
  it("counts browser and GPU processes, which the renderer-pid filter discards", () => {
    const { cpu } = tracedRun();
    // Browser 30 + GPU main 16 + viz 6 = 52 ms outside the renderer entirely.
    expect(cpu.byProcess.browser.cpuMs).toBe(30);
    expect(cpu.byProcess.gpu.cpuMs).toBe(22);
    expect(cpu.byProcess.gpu.threads).toBe(2);
    expect(cpu.byThread.map((row) => `${row.process}/${row.thread}`)).toContain(
      "GPU Process/VizCompositorThread",
    );
  });

  it("totals CPU as a fraction of ONE core over the window, and may exceed 1", () => {
    const { cpu } = tracedRun();
    expect(cpu.windowMs).toBe(200);
    // renderer main 4 + 8 + 5 = 17, browser 30, gpu 22 => 69 ms of traced CPU.
    expect(cpu.totalCpuMs).toBe(69);
    expect(cpu.totalCoreRatio).toBeCloseTo(69 / 200, 5);
  });

  it("takes CPU from MAXIMAL events only, so nested ops are not double counted", () => {
    const { cpu } = tracedRun();
    const gpuMain = cpu.byThread.find((row) => row.thread === "CrGpuMain");
    // The 20 ms RunTask carries tdur 16; its three nested ops carry none and must add nothing.
    expect(gpuMain?.cpuMs).toBe(16);
    expect(gpuMain?.wallMs).toBe(20);
  });

  it("reports cpuCoverage, so an unknown CPU cannot read as an idle thread", () => {
    const events = [
      ...healthyTrace(),
      ...crossProcessEvents(),
      // 100 ms of wall on a thread with NO tdur at all: real work, unknown CPU.
      {
        name: "RunTask",
        cat: "toplevel",
        ph: "X",
        ts: 60_000,
        dur: 100_000,
        pid: 300,
        tid: 999,
      },
    ];
    const withUnknown = analyzeTrace(events, { windowMs: 200, gpu: GPU_ON });
    expect(withUnknown.cpu.cpuCoverage).toBeLessThan(
      tracedRun().cpu.cpuCoverage,
    );
    // ...and the wall shows up even though the CPU does not.
    const row = withUnknown.cpu.byThread.find((r) => r.thread === "tid 999");
    expect(row?.wallMs).toBe(100);
    expect(row?.cpuMs).toBe(0);
  });

  it("folds several OS threads with the same process/thread name into one row", () => {
    const { cpu } = tracedRun();
    // The fixture has two renderer processes, both with a CrRendererMain. Only one does work here,
    // but the folding key is the NAME pair, so `instances` is what says how many were summed.
    const main = cpu.byThread.find((row) => row.thread === "CrRendererMain");
    expect(main?.instances).toBeGreaterThanOrEqual(1);
  });

  it("leaves every renderer-scoped metric untouched", () => {
    const withOthers = tracedRun();
    const rendererOnly = analyzeTrace(healthyTrace(), {
      windowMs: 200,
      gpu: GPU_ON,
    });
    for (const key of Object.keys(
      rendererOnly,
    ) as (keyof typeof rendererOnly)[]) {
      if (key === "cpu" || key === "gpu") {
        continue;
      }
      expect({ [key]: withOthers[key] }).toEqual({ [key]: rendererOnly[key] });
    }
  });

  it("normalises the three process names that matter and slugs the rest", () => {
    expect(processKeyOf("Renderer")).toBe("renderer");
    expect(processKeyOf("Browser")).toBe("browser");
    expect(processKeyOf("GPU Process")).toBe("gpu");
    expect(processKeyOf("Service: network.mojom.NetworkService")).toBe(
      "service-network-mojom-networkservice",
    );
  });

  it("clamps to the window rather than counting work outside it", () => {
    const threads = {
      name: new Map([["1:1", "CrGpuMain"]]),
      process: new Map([[1, "GPU Process"]]),
    };
    const cpu = computeCpu(
      [
        // Half in, half out: 100 ms wall with tdur 100 straddling the window start.
        {
          name: "RunTask",
          ph: "X",
          ts: 0,
          dur: 100_000,
          tdur: 100_000,
          pid: 1,
          tid: 1,
        },
      ],
      threads,
      { windowStart: 50_000, windowEnd: 250_000, windowMs: 200 },
    );
    expect(cpu.totalCpuMs).toBe(50);
  });
});

describe("gpu block", () => {
  it("buckets GPU-process ops by self time and names what it could not bucket", () => {
    const { gpu } = tracedRun();
    expect(gpu.available).toBe(true);
    expect(gpu.opDetail).toBe(true);
    expect(gpu.processCpuMs).toBe(22);
    expect(gpu.byBucket.uploadDecode).toBe(8);
    expect(gpu.byBucket.skiaExecute).toBe(5);
    expect(gpu.byBucket.presentSwap).toBe(10);
    // The outer RunTask's SELF time is 20 - (8 + 5 + 3) = 4 ms of scheduling.
    expect(gpu.byBucket.schedulerIpc).toBe(4);
    expect(gpu.byBucket.other).toBe(3);
    expect(gpu.topUnbucketedOps[0]).toEqual({
      name: "SomeUnnamedGpuThing",
      selfMs: 3,
      count: 1,
    });
  });

  it('reports `available: false` for --no-gpu, meaning UNMEASURED not "idle"', () => {
    const metrics = analyzeTrace([...healthyTrace(), ...crossProcessEvents()], {
      windowMs: 200,
      gpu: { collected: false, hardware: "swiftshader" },
    });
    expect(metrics.gpu.available).toBe(false);
    expect(metrics.gpu.byBucket.presentSwap).toBe(0);
    // ...and the CPU story is UNCHANGED: the GPU process's bulk cost still comes out of tdur.
    expect(metrics.cpu.byProcess.gpu.cpuMs).toBe(22);
    expect(metrics.cpu.totalCpuMs).toBe(tracedRun().cpu.totalCpuMs);
  });

  it("says op-level detail is missing rather than reporting zero cost", () => {
    const metrics = analyzeTrace(
      [
        ...healthyTrace(),
        // A GPU process traced WITHOUT the gpu/viz/skia categories: RunTask and nothing else.
        {
          name: "RunTask",
          cat: "toplevel",
          ph: "X",
          ts: 60_000,
          dur: 20_000,
          tdur: 16_000,
          pid: 400,
          tid: 401,
        },
      ],
      { windowMs: 200, gpu: GPU_ON },
    );
    expect(metrics.gpu.available).toBe(true);
    expect(metrics.gpu.opDetail).toBe(false);
    expect(metrics.gpu.processCpuMs).toBe(16);
  });

  it("has no GPU process at all -> available false, never a fabricated zero-cost GPU", () => {
    const metrics = analyzeTrace(healthyTrace(), {
      windowMs: 200,
      gpu: GPU_ON,
    });
    expect(metrics.gpu.available).toBe(false);
  });

  it("buckets the real Chrome op names the reference analyzer defined", () => {
    expect(gpuBucketOf("GpuImageDecodeCache::UploadImage")).toBe(
      "uploadDecode",
    );
    expect(gpuBucketOf("GpuRasterBuffer::Playback")).toBe("rasterPlayback");
    expect(gpuBucketOf("OpsTask::onPrepareDraws")).toBe("skiaPrepare");
    expect(gpuBucketOf("GrDrawingManager::flush")).toBe("skiaExecute");
    expect(gpuBucketOf("SkiaOutputSurfaceImplOnGpu::SwapBuffers")).toBe(
      "presentSwap",
    );
    expect(gpuBucketOf("SurfaceFillContext::clear")).toBe("clear");
    expect(gpuBucketOf("RunTask")).toBe("schedulerIpc");
    // Deliberately NOT bucketed: the reference's `texture lifetime` names land in `other` so they
    // surface by name in topUnbucketedOps instead of hiding inside a bucket nobody reads.
    expect(gpuBucketOf("GrGLTexture::onRelease")).toBe("other");
  });
});

describe("trace categories", () => {
  it("adds the GPU categories only when GPU collection is on", () => {
    const on = traceCategoriesFor(true);
    const off = traceCategoriesFor(false);
    for (const category of GPU_TRACE_CATEGORIES) {
      expect(on).toContain(category);
      expect(off).not.toContain(category);
    }
    expect(on.length).toBe(off.length + GPU_TRACE_CATEGORIES.length);
  });
});

describe("GPU hardware naming", () => {
  it("unwraps ANGLE to name the real device on the phone", () => {
    expect(
      describeGpuHardware({
        gpu: {
          devices: [
            {
              deviceString:
                "ANGLE (ARM, Mali-G615 MC2, OpenGL ES 3.2 v1.r44p1-01eac0)",
            },
          ],
        },
      }).hardware,
    ).toBe("Mali-G615 MC2 (ANGLE)");
  });

  it("calls SwiftShader what it is — a software rasteriser, not a GPU", () => {
    expect(
      describeGpuHardware({
        gpu: {
          auxAttributes: {
            glRenderer:
              "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
          },
        },
      }).hardware,
    ).toBe("swiftshader");
  });

  it("says `unknown` rather than inventing a name", () => {
    expect(describeGpuHardware({}).hardware).toBe("unknown");
  });
});

const GFXINFO = `** Graphics info for pid 7584 [com.android.chrome] **

Total frames rendered: 980
Janky frames: 659 (0.07%)
Janky frames (legacy): 271643 (27.70%)
50th percentile: 10ms
90th percentile: 14ms
95th percentile: 15ms
99th percentile: 17ms
Number Slow UI thread: 433
Number Slow bitmap uploads: 16
Number Slow issue draw commands: 297
Total GPU memory usage:
  19723742 bytes, 18.81 MB (7.34 MB is purgeable)
`;

describe("dumpsys gfxinfo", () => {
  it("parses the headline jank, percentiles and the two slow counters", () => {
    expect(parseGfxInfo(GFXINFO)).toEqual({
      totalFrames: 980,
      // The `(legacy)` line is a different, much noisier counter and must NOT be the one reported.
      jankPct: 0.07,
      p50Ms: 10,
      p95Ms: 15,
      p99Ms: 17,
      slowBitmapUploads: 16,
      slowIssueDrawCommands: 297,
    });
  });

  it("reads GPU memory in bytes off the same dump (no perfetto session needed)", () => {
    expect(parseGpuMemoryBytes(GFXINFO)).toBe(19723742);
  });

  it("returns nulls, never zeros, for a dump that reported nothing", () => {
    expect(parseGfxInfo("")).toEqual({
      totalFrames: null,
      jankPct: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      slowBitmapUploads: null,
      slowIssueDrawCommands: null,
    });
    expect(parseGpuMemoryBytes("")).toBeNull();
  });
});

describe("aggregation", () => {
  it("medians cpu per thread over the repeats that carried the thread", () => {
    const runs = [tracedRun().cpu, tracedRun().cpu, tracedRun().cpu];
    const median = medianCpu(runs);
    expect(median.totalCpuMs).toBe(69);
    expect(median.byProcess.gpu.cpuMs).toBe(22);
  });

  it("ANDs gpu.available: one blind repeat makes the aggregate blind", () => {
    const seeing = tracedRun().gpu;
    const blind = { ...seeing, available: false };
    expect(medianGpu([seeing, seeing, blind]).available).toBe(false);
  });

  it("aggregates the gfxinfo slow counters by WORST case, like inRasterCount", () => {
    const base = tracedRun().gpu;
    const device = (slow: number) => ({
      ...base,
      device: {
        source: "dumpsys-gfxinfo" as const,
        gpuMemoryDeltaBytes: null,
        attribution: "dumpsys gfxinfo com.android.chrome",
        memoryDump: null,
        gfxinfo: {
          totalFrames: 100,
          jankPct: 1,
          p50Ms: 8,
          p95Ms: 9,
          p99Ms: 10,
          slowBitmapUploads: slow,
          slowIssueDrawCommands: 0,
        },
        gpuMemoryBytes: 1000,
      },
    });
    const merged = medianGpu([device(0), device(0), device(0), device(7)]);
    expect(merged.device?.gfxinfo.slowBitmapUploads).toBe(7);
  });
});

describe("profile gating (task 3: a tree walk does not need GPU)", () => {
  it("rejects a `gpu` block on a non-browser-render report", () => {
    const issues = validateGpuBlock({ gpu: tracedRun().gpu }, "metrics", false);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("metrics.gpu");
    expect(issues[0].message).toMatch(/only a browser-render report/i);
  });

  it("accepts it on browser-render", () => {
    expect(validateGpuBlock({ gpu: tracedRun().gpu }, "metrics", true)).toEqual(
      [],
    );
  });

  it("accepts a non-browser report that carries only `cpu`", () => {
    const metrics = { walkMs: 12, cpu: tracedRun().cpu };
    expect(validateGpuBlock(metrics, "metrics", false)).toEqual([]);
    expect(validateCpuBlock(metrics, "metrics", false)).toEqual([]);
  });

  it("requires `cpu` on browser-render and not elsewhere", () => {
    expect(validateCpuBlock({ walkMs: 12 }, "metrics", false)).toEqual([]);
    expect(validateCpuBlock({ walkMs: 12 }, "metrics", true)).toHaveLength(1);
  });

  it("rejects a cpu block whose thread rows are not real measurements", () => {
    const cpu = tracedRun().cpu;
    const issues = validateCpuBlock(
      { cpu: { ...cpu, byThread: [{ process: "Renderer" }] } },
      "metrics",
      true,
    );
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("a driver GPU-memory byte must name its instrument", () => {
  const withDevice = (device: Record<string, unknown>) =>
    validateGpuBlock(
      { gpu: { ...tracedRun().gpu, available: true, device } },
      "metrics",
      true,
    );
  const nvidia = {
    source: "nvidia-smi",
    gfxinfo: gfxInfoNotMeasured(),
    gpuMemoryBytes: 132_120_576,
    gpuMemoryDeltaBytes: 2_097_152,
    attribution: "nvidia-smi per-process, pid 1002 under chrome pid 1000",
    memoryDump: null,
  };

  it("accepts either rung's label", () => {
    expect(withDevice(nvidia)).toEqual([]);
    expect(withDevice({ ...nvidia, source: "dumpsys-gfxinfo" })).toEqual([]);
  });

  it("rejects an unknown source: two rungs, and a byte from one is not the other's", () => {
    const issues = withDevice({ ...nvidia, source: "guessed" });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("metrics.gpu.device.source");
  });

  it("rejects a byte count with no source at all", () => {
    // `source: null` is legal ONLY for a block that carries nothing but the --memory-dump cross-check.
    expect(
      withDevice({ ...nvidia, source: null, gpuMemoryBytes: null }),
    ).toEqual([]);
    expect(withDevice({ ...nvidia, source: null })).toHaveLength(1);
  });
});
