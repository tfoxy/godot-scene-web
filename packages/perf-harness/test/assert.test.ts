// @vitest-environment node
//
// The relational gate. What is asserted here is not "the numbers are good" but "the gate cannot pass
// for the wrong reason": an all-zero run, a blank page, a missing arm and a wrong-way-round result
// must each come out FAILED, and the one relation this environment cannot evaluate must come out
// SKIP rather than silently disappearing.

import { describe, expect, it } from "vitest";
import {
  evaluateGate,
  formatGateOutcome,
  getScenarioGate,
} from "../src/assert";
import type { BrowserPerfReport, ReportMetrics } from "../src/report";

const gate = getScenarioGate("ancestor-rescale");

interface ArmShape {
  redecodeCount?: number;
  decodeMaxMs?: number;
  sourceRatio?: number;
  gapsOver100?: number;
  sampleHits?: number;
  cacheFamily?: ReportMetrics["decode"]["cacheFamily"];
}

function report(mechanism: string, shape: ArmShape): BrowserPerfReport {
  const metrics = {
    initialRenderMs: 500,
    readyMs: 30,
    frameCostMs: { p50: 1, p95: 2, max: 5 },
    contentUpdateHz: 48,
    activationGapMs: {
      p50: 16.7,
      p95: 17,
      max: shape.gapsOver100 ? 420 : 18,
      over100msCount: shape.gapsOver100 ?? 0,
      count: 120,
    },
    swapRateHz: 48,
    blockedMs: 0,
    longAnimationFrames: 0,
    longTaskCount: 1,
    decode: {
      count: 1000,
      totalMs: 1300,
      maxMs: shape.decodeMaxMs ?? 100,
      distinctImages: 1,
      redecodeCount: shape.redecodeCount ?? 0,
      redecodeMs: 300,
      inRasterCount: 0,
      inRasterMs: 0,
      codecRuns: 4,
      codecMs: 900,
      imageKey: "pixelRefId",
      cacheFamily: shape.cacheFamily ?? "software",
    },
    paint: {
      count: 1200,
      distinctUrls: 1,
      maxSourceMegapixels: 16.78,
      maxSourceToPaintedRatio: shape.sourceRatio ?? 17.71,
    },
    rasterMs: 200,
    renderSurfaces: 0,
    renderSurfaceReasons: {},
    renderSurfaceListPasses: 3,
    mainThreadCpuRatio: 0.5,
    mainThreadCpuSamples: 2,
    mainThreadBusyMs: 300,
    windowMs: 2500,
    activationCount: 120,
    layerCount: 4,
    presented: {
      nonEmptyRatio: 0.3,
      sampleHits: shape.sampleHits ?? 50,
      sampleCount: 50,
      screenshot: "shots/x.png",
    },
  } satisfies ReportMetrics;
  return {
    schema: "perf-report/1",
    repo: "godot-scene-web",
    profile: "browser-render",
    scenario: "ancestor-rescale",
    env: { kind: "ci", label: "test", cpuThrottle: 1, device: null },
    params: { mechanism },
    repeats: 5,
    warmups: 1,
    metrics,
    runs: [metrics],
    artifacts: { trace: "t.json.gz", screenshot: "shots/x.png" },
  };
}

/** A run in which page-crop separates from the controls exactly as the mechanism predicts. */
function reproducingRun(overrides: Record<string, ArmShape> = {}) {
  return [
    report("region-blob", { ...overrides["region-blob"] }),
    report("page-crop", {
      redecodeCount: 3,
      decodeMaxMs: 505,
      sourceRatio: 1820,
      ...overrides["page-crop"],
    }),
    report("canvas", { sourceRatio: 0, ...overrides.canvas }),
  ];
}

describe("ancestor-rescale gate", () => {
  it("passes when every relation holds", () => {
    const outcome = evaluateGate(gate, reproducingRun());
    expect(outcome.ok).toBe(true);
    expect(outcome.results.filter((r) => r.status === "fail")).toEqual([]);
  });

  it("FAILS an all-zero run instead of passing it on a vacuous ratio", () => {
    // 0 >= 3 * 0 is true. Without the absolute floor, a run that measured nothing at all — the shape
    // a broken capture takes — would satisfy the headline relation and go green.
    const outcome = evaluateGate(
      gate,
      reproducingRun({ "page-crop": { redecodeCount: 0 } }),
    );
    expect(outcome.ok).toBe(false);
    expect(
      outcome.results.find((r) => r.name.startsWith("decode.redecodeCount"))
        ?.status,
    ).toBe("fail");
  });

  it("FAILS when a control arm re-decodes as much as page-crop", () => {
    const outcome = evaluateGate(
      gate,
      reproducingRun({ "region-blob": { redecodeCount: 3 } }),
    );
    expect(outcome.ok).toBe(false);
  });

  it("FAILS a blank page even when every other ratio holds", () => {
    const outcome = evaluateGate(
      gate,
      reproducingRun({ canvas: { sampleHits: 12, sourceRatio: 0 } }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.results[0].status).toBe("fail");
    expect(outcome.results[0].detail).toContain("12/50");
  });

  it("FAILS when an arm is missing rather than skipping it", () => {
    const outcome = evaluateGate(gate, reproducingRun().slice(0, 2));
    expect(outcome.ok).toBe(false);
    expect(outcome.missingMechanisms).toEqual(["canvas"]);
  });

  it("ignores reports from a different scenario", () => {
    const foreign = report("page-crop", {});
    foreign.scenario = "atlas-sprites";
    const outcome = evaluateGate(gate, [...reproducingRun(), foreign]);
    expect(outcome.ok).toBe(true);
  });
});

describe("the activation-gap relation is environment-scoped", () => {
  const gapCheck = (reports: BrowserPerfReport[]) =>
    evaluateGate(gate, reports).results.find((r) =>
      r.name.startsWith("activationGapMs"),
    );

  it("SKIPS on the software decode cache, and says why", () => {
    // Measured: SoftwareImageDecodeCache re-scales an existing decode instead of re-running the
    // codec, so the traced stall cannot reproduce here. Asserting it anyway would fail every clean
    // run on this box until everyone stopped reading the gate.
    const result = gapCheck(reproducingRun());
    expect(result?.status).toBe("skip");
    expect(result?.detail).toContain("software");
  });

  it("is ENFORCED on the GPU decode cache", () => {
    const gpu = { cacheFamily: "gpu" as const };
    expect(
      gapCheck(
        reproducingRun({
          "page-crop": {
            redecodeCount: 3,
            decodeMaxMs: 505,
            sourceRatio: 1820,
            ...gpu,
          },
        }),
      )?.status,
    ).toBe("fail");
    expect(
      gapCheck(
        reproducingRun({
          "page-crop": {
            redecodeCount: 3,
            decodeMaxMs: 505,
            sourceRatio: 1820,
            gapsOver100: 2,
            ...gpu,
          },
        }),
      )?.status,
    ).toBe("pass");
  });

  it("a skipped relation is never counted as a passing one", () => {
    const outcome = evaluateGate(gate, reproducingRun());
    const text = formatGateOutcome(gate, outcome);
    expect(text).toContain("SKIP");
    expect(text).toContain("1 SKIPPED");
    expect(text).not.toMatch(/OK — \d+\/\d+ relations hold$/m);
  });
});
