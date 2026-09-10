// The comparison table is the product of this harness, so what it says about a DEVICE run matters as
// much as the numbers: a reader must not have to open the JSON to find out the phone was hot.

import { describe, expect, it } from "vitest";
import { analyzeTrace, gfxInfoNotMeasured } from "../src/analyze";
import {
  type BrowserPerfReport,
  REPORT_SCHEMA,
  type ReportMetrics,
} from "../src/report";
import { formatComparison } from "../src/table";
import { healthyTrace } from "./trace-fixtures";

function metrics(): ReportMetrics {
  return {
    ...analyzeTrace(healthyTrace(), { windowMs: 200 }),
    readyMs: 50,
    blockedMs: 42,
    longAnimationFrames: 1,
    longTaskCount: 1,
    layerCount: 4,
    presented: {
      nonEmptyRatio: 0.31,
      sampleHits: 50,
      sampleCount: 50,
      screenshot: "shot.png",
    },
  };
}

function deviceReport(
  overrides: Partial<BrowserPerfReport["env"]["device"]> = {},
): BrowserPerfReport {
  return {
    schema: REPORT_SCHEMA,
    repo: "godot-scene-web",
    profile: "browser-render",
    scenario: "atlas-sprites",
    env: {
      kind: "device",
      label: "android15-moto-g86-5g-chrome-152",
      cpuThrottle: null,
      device: {
        model: "moto g86 5G",
        manufacturer: "motorola",
        androidRelease: "15",
        chrome: "Chrome/152.0.7300.60",
        batteryPct: 84,
        batteryTemperatureC: 30,
        thermalStatus: "none",
        thermalStatusCode: 0,
        thermalMaxTempC: 31,
        isolation: "new-tab",
        viewport: "1280x800@1",
        naturalViewport: "412x883@2.625",
        after: {
          batteryPct: 79,
          batteryTemperatureC: 35,
          thermalStatus: "light",
          thermalStatusCode: 1,
          thermalMaxTempC: 42,
        },
        warnings: ["thermal status ROSE during the run (none -> light)"],
        ...overrides,
      },
    },
    params: {
      mechanism: "page-crop",
      mounted: 50,
      animated: 10,
      regions: 100,
      atlasPage: 4096,
    },
    repeats: 5,
    warmups: 1,
    metrics: metrics(),
    runs: [metrics()],
    artifacts: { trace: "t.json.gz", screenshot: "s.png" },
  };
}

describe("formatComparison: device header", () => {
  it("never prints a null throttle as `nullx`", () => {
    const text = formatComparison([deviceReport()]);
    expect(text).toContain("cpuThrottle: none");
    expect(text).not.toContain("nullx");
  });

  it("shows the phone, the isolation and both viewports", () => {
    const text = formatComparison([deviceReport()]);
    expect(text).toContain("motorola moto g86 5G / Android 15");
    expect(text).toContain("isolation new-tab");
    expect(text).toContain("viewport 1280x800@1 (phone's own 412x883@2.625)");
  });

  it("shows battery and thermal BEFORE -> AFTER, and shouts about the drift", () => {
    const text = formatComparison([deviceReport()]);
    expect(text).toContain("battery 84% -> 79%");
    expect(text).toContain("thermalStatus none -> light");
    expect(text).toContain("!! thermal status ROSE during the run");
  });
});

/** A desktop-headed NVIDIA run: the same `gpu.device` block, filled by a different instrument. */
function nvidiaReport(): BrowserPerfReport {
  const traced = analyzeTrace(healthyTrace(), {
    windowMs: 200,
    gpu: {
      collected: true,
      hardware: "NVIDIA GeForce RTX 2060/PCIe/SSE2 (ANGLE)",
      hardwareDetail: "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 2060)",
      device: {
        source: "nvidia-smi",
        gfxinfo: gfxInfoNotMeasured(),
        gpuMemoryBytes: 132_120_576,
        gpuMemoryDeltaBytes: 2_097_152,
        attribution:
          "nvidia-smi per-process, pid 1002 (C+G) under chrome pid 1000",
        memoryDump: null,
      },
    },
  });
  return {
    ...deviceReport(),
    env: { kind: "ci", label: "linux-chrome-nvidia", cpuThrottle: 1 },
    metrics: { ...metrics(), gpu: traced.gpu },
    runs: [],
  };
}

describe("formatComparison: driver-attributed VRAM on a desktop run", () => {
  it("prints the driver figure, the window delta and the SOURCE", () => {
    const text = formatComparison([nvidiaReport()]);
    expect(text).toContain("gpu memory MB (driver)");
    expect(text).toContain("132.12");
    expect(text).toContain("+2.10");
    expect(text).toContain("nvidia-smi");
  });

  it("names what the bytes were attributed to, and warns off the box-wide total", () => {
    const text = formatComparison([nvidiaReport()]);
    expect(text).toContain(
      "attributed to: nvidia-smi per-process, pid 1002 (C+G) under chrome pid 1000",
    );
    expect(text).toContain("never the box-wide");
  });

  it("does NOT grow the Android-only HWUI rows on a desktop run", () => {
    // The gfxinfo block is all nulls here, and seven em dashes under a heading about Chrome's Android
    // View hierarchy would be rows about a thing this machine does not have.
    const text = formatComparison([nvidiaReport()]);
    expect(text).not.toContain("gfxinfo jank %");
    expect(text).not.toContain("SLOW BITMAP UPLOADS");
  });

  it("renders an em dash, never a 0, for a delta the rung could not take", () => {
    const report = nvidiaReport();
    // The device rung: `dumpsys gfxinfo` RESETS its counters instead of reading them twice, so there
    // is no before-byte to difference. That is not a zero-byte window.
    report.metrics.gpu.device = {
      ...(report.metrics.gpu.device as NonNullable<
        typeof report.metrics.gpu.device
      >),
      gpuMemoryDeltaBytes: null,
    };
    const line = formatComparison([report])
      .split("\n")
      .find((row) => row.includes("window delta MB"));
    expect(line).toContain("—");
    expect(line).not.toContain("0.00");
  });
});
