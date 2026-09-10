// Committed baselines. Small, reviewable, and honest about what does and does not port between
// environments.

import { describe, expect, it } from "vitest";
import { analyzeTrace } from "../src/analyze";
import { buildBaseline } from "../src/baseline";
import {
  type BrowserPerfReport,
  REPORT_SCHEMA,
  type ReportMetrics,
} from "../src/report";
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
      screenshot: "artifacts/perf/runs/x/shots/page-crop-r0.png",
    },
  };
}

function report(mechanism: string): BrowserPerfReport {
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
        androidRelease: "15",
        chrome: "Chrome/152.0.7300.60",
        batteryPct: 84,
        batteryTemperatureC: 30,
        thermalStatus: "none",
        thermalStatusCode: 0,
        thermalMaxTempC: 31,
      },
    },
    params: {
      mechanism,
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

describe("buildBaseline", () => {
  it("keys the medians by mechanism and keeps the environment they came from", () => {
    const baseline = buildBaseline([report("page-crop"), report("canvas")]);
    expect(Object.keys(baseline.mechanisms)).toEqual(["page-crop", "canvas"]);
    expect(baseline.env.label).toBe("android15-moto-g86-5g-chrome-152");
    expect(baseline.env.device?.thermalStatus).toBe("none");
    expect(baseline.params.mechanism).toBeUndefined();
    expect(baseline.params.mounted).toBe(50);
  });

  it("drops the per-repeat runs and the artifact paths", () => {
    // A committed baseline must stay small and must not point at ignored artifacts that will not
    // exist when someone reads it six months from now.
    const baseline = buildBaseline([report("page-crop")]);
    expect(baseline.mechanisms["page-crop"].presented.screenshot).toBe("");
    expect(JSON.stringify(baseline)).not.toContain("artifacts/perf/runs");
    expect(JSON.stringify(baseline).length).toBeLessThan(8000);
  });

  it("records which metrics survive a change of environment", () => {
    // SwiftShader has no GPU compositing to speak of and layerises differently; comparing a headless
    // layerCount against a phone's is meaningless, while decode and activation timings do compare.
    const baseline = buildBaseline([report("page-crop")]);
    expect(baseline.portability.environmentSpecific).toContain("layerCount");
    expect(baseline.portability.portable).toContain("contentUpdateHz");
  });
});
