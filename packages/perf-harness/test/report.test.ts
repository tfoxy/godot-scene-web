import { describe, expect, it } from "vitest";
import { analyzeTrace } from "../src/analyze";
import {
  medianMetrics,
  type PerfReport,
  REPORT_SCHEMA,
  type ReportGeometry,
  type ReportMetrics,
  validateReport,
} from "../src/report";
import { healthyTrace } from "./trace-fixtures";

function browserMetrics(overrides: Partial<ReportMetrics> = {}): ReportMetrics {
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
    ...overrides,
  };
}

/**
 * The geometry every browser-render envelope must now carry: what the run was measured at. A desktop
 * run at the fixed viewport, stage used 1:1.
 */
function geometry(overrides: Partial<ReportGeometry> = {}): ReportGeometry {
  return {
    viewport: { width: 1280, height: 800 },
    devicePixelRatio: 1,
    orientation: "landscape",
    fit: false,
    fitScale: 1,
    stage: { width: 1280, height: 800 },
    fittedStage: { width: 1280, height: 800 },
    grid: "10x5",
    emulatedViewport: "1280x800@1",
    ...overrides,
  };
}

function browserReport(overrides: Partial<PerfReport> = {}): PerfReport {
  const metrics = browserMetrics();
  return {
    schema: REPORT_SCHEMA,
    repo: "godot-scene-web",
    profile: "browser-render",
    scenario: "atlas-sprites",
    env: {
      kind: "ci",
      label: "linux-chrome-148",
      cpuThrottle: 6,
      device: null,
      geometry: geometry(),
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
    metrics,
    runs: [metrics],
    artifacts: {
      trace: "artifacts/perf/runs/x/traces/page-crop-r0.json.gz",
      screenshot: "artifacts/perf/runs/x/shots/page-crop-r0.png",
    },
    ...overrides,
  };
}

describe("validateReport: browser-render", () => {
  it("accepts a well-formed browser report", () => {
    expect(validateReport(browserReport())).toEqual([]);
  });

  it("rejects an unknown profile", () => {
    const issues = validateReport(
      browserReport({ profile: "mystery" as never }),
    );
    expect(issues.map((issue) => issue.path)).toContain("profile");
  });

  it("rejects a run that only partly rendered", () => {
    // The whole point of the presence guard: a report that measured half a blank page must not pass.
    const metrics = browserMetrics({
      presented: {
        nonEmptyRatio: 0.02,
        sampleHits: 12,
        sampleCount: 50,
        screenshot: "shot.png",
      },
    });
    const issues = validateReport(browserReport({ metrics, runs: [metrics] }));
    expect(
      issues.some((issue) => issue.path === "metrics.presented.sampleHits"),
    ).toBe(true);
  });

  it("rejects a report with no decode at all", () => {
    // Zero decode on a page that paints a 16 MP atlas means the cc decode-cache names drifted
    // (software vs GPU family), i.e. UNMEASURED — never "fast".
    const base = browserMetrics();
    const metrics = {
      ...base,
      decode: { ...base.decode, count: 0, cacheFamily: "unknown" as const },
    };
    const issues = validateReport(browserReport({ metrics, runs: [metrics] }));
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["metrics.decode.count", "runs[0].decode.count"]),
    );
  });

  it("accepts zero decode ONLY when the scenario declared it paints no images", () => {
    // S9 `text-render` paints none: glyphs come from the font stack, which emits no cc decode
    // events. Without the declaration this is indistinguishable from a drifted matcher, so the
    // exemption has to be carried IN the report — a consumer validating a file on disk cannot ask
    // the scenario.
    const base = browserMetrics();
    const metrics = {
      ...base,
      decode: {
        ...base.decode,
        count: 0,
        cacheFamily: "unknown" as const,
        imagesExpected: false,
      },
    };
    expect(validateReport(browserReport({ metrics, runs: [metrics] }))).toEqual(
      [],
    );
  });

  it("still rejects zero decode when the scenario says it DOES paint images", () => {
    // The exemption must be opt-in and explicit. `imagesExpected: true` — and its absence, which
    // is how every report written before the field existed reads — keeps the original alarm.
    const base = browserMetrics();
    const metrics = {
      ...base,
      decode: { ...base.decode, count: 0, imagesExpected: true },
    };
    expect(
      validateReport(browserReport({ metrics, runs: [metrics] })).map(
        (issue) => issue.path,
      ),
    ).toEqual(expect.arrayContaining(["metrics.decode.count"]));
  });

  it("accepts an unknown cache family when decode WAS measured", () => {
    // `createImageBitmap` decodes outside cc's image-decode cache, so the canvas mechanism really
    // does report cacheFamily "unknown" with a non-zero decode count. That is a measurement, not a
    // matcher failure, and rejecting it would make the canvas arm unreportable.
    const base = browserMetrics();
    const metrics = {
      ...base,
      decode: { ...base.decode, count: 1, cacheFamily: "unknown" as const },
    };
    expect(validateReport(browserReport({ metrics, runs: [metrics] }))).toEqual(
      [],
    );
  });

  it("accepts a severely parked main thread as a small POSITIVE ratio", () => {
    // Measured on the page-crop arm: 614 ms of main-thread wall at 0.3% CPU — blocked on commit.
    const metrics = browserMetrics({ mainThreadCpuRatio: 0.0029 });
    expect(validateReport(browserReport({ metrics, runs: [metrics] }))).toEqual(
      [],
    );
  });

  it("accepts a null cpu ratio when nothing met the threshold", () => {
    const metrics = browserMetrics({
      mainThreadCpuRatio: null,
      mainThreadCpuSamples: 0,
    });
    expect(validateReport(browserReport({ metrics, runs: [metrics] }))).toEqual(
      [],
    );
  });

  it("rejects a null cpu ratio that HAD samples", () => {
    // null with samples is a dropped measurement, not an absent one.
    const metrics = browserMetrics({
      mainThreadCpuRatio: null,
      mainThreadCpuSamples: 4,
    });
    const issues = validateReport(browserReport({ metrics, runs: [metrics] }));
    expect(issues.map((issue) => issue.path)).toContain(
      "metrics.mainThreadCpuRatio",
    );
  });

  it("rejects a numeric cpu ratio backed by ZERO samples", () => {
    // The pairing that nulling this field exists to remove: a plausible number next to n=0.
    const metrics = browserMetrics({
      mainThreadCpuRatio: 1,
      mainThreadCpuSamples: 0,
    });
    const issues = validateReport(browserReport({ metrics, runs: [metrics] }));
    expect(issues.map((issue) => issue.path)).toContain(
      "metrics.mainThreadCpuSamples",
    );
  });

  it("rejects an exact-zero cpu ratio", () => {
    // 0 is not "parked", it is "never computed". Accepting it would strip the anti-degeneracy guard
    // from the one metric that separates computing from waiting.
    const metrics = browserMetrics({ mainThreadCpuRatio: 0 });
    const issues = validateReport(browserReport({ metrics, runs: [metrics] }));
    expect(issues.map((issue) => issue.path)).toContain(
      "metrics.mainThreadCpuRatio",
    );
  });

  it("rejects zeroed timing fields", () => {
    const base = browserMetrics();
    const metrics = { ...base, initialRenderMs: 0, contentUpdateHz: 0 };
    const issues = validateReport(browserReport({ metrics, runs: [metrics] }));
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "metrics.initialRenderMs",
        "metrics.contentUpdateHz",
      ]),
    );
  });

  it("requires trace and screenshot artifacts", () => {
    const issues = validateReport(browserReport({ artifacts: {} }));
    expect(issues.map((issue) => issue.path)).toContain("artifacts");
  });

  it("requires a cpuThrottle >= 1", () => {
    const issues = validateReport(
      browserReport({
        env: {
          kind: "ci",
          label: "x",
          cpuThrottle: null,
          device: null,
          geometry: geometry(),
        },
      }),
    );
    expect(issues.map((issue) => issue.path)).toContain("env.cpuThrottle");
  });
});

describe("validateReport: device runs", () => {
  const deviceEnv = {
    kind: "device" as const,
    label: "android15-moto-g86-5g-chrome-152",
    // NULL on purpose: throttling the CPU of the slow device you are measuring would measure an
    // emulated phone running on a phone. The validator has to accept that, or a device report can
    // only conform by inventing a throttle factor it never applied.
    cpuThrottle: null,
    device: {
      model: "moto g86 5G",
      androidRelease: "15",
      chrome: "Chrome/152.0.7300.60",
      batteryPct: 84,
      batteryTemperatureC: 30.1,
      thermalStatus: "none",
      thermalStatusCode: 0,
      thermalMaxTempC: 31.5,
      after: {
        batteryPct: 81,
        batteryTemperatureC: 33.4,
        thermalStatus: "none",
        thermalStatusCode: 0,
        thermalMaxTempC: 35,
      },
      warnings: [],
      isolation: "new-tab" as const,
    },
    // A REAL device geometry: a portrait phone measuring the scenario at its own viewport, with the
    // stage fitted into it. Nothing emulated.
    geometry: geometry({
      viewport: { width: 412, height: 883 },
      devicePixelRatio: 2.625,
      orientation: "portrait" as const,
      fit: true,
      fitScale: 0.3872,
      stage: { width: 1064, height: 544 },
      fittedStage: { width: 411.98, height: 210.64 },
      grid: "5x10",
      emulatedViewport: null,
    }),
  };

  it("accepts a browser-render device report with a null cpuThrottle", () => {
    expect(validateReport(browserReport({ env: deviceEnv }))).toEqual([]);
  });

  it("still accepts an explicit throttle on a device run", () => {
    expect(
      validateReport(browserReport({ env: { ...deviceEnv, cpuThrottle: 4 } })),
    ).toEqual([]);
  });

  it("rejects a nonsensical throttle on a device run", () => {
    const issues = validateReport(
      browserReport({ env: { ...deviceEnv, cpuThrottle: 0 } }),
    );
    expect(issues.map((issue) => issue.path)).toContain("env.cpuThrottle");
  });

  it("requires the device block", () => {
    const issues = validateReport(
      browserReport({ env: { ...deviceEnv, device: null } }),
    );
    expect(issues.map((issue) => issue.path)).toContain("env.device");
  });

  it("requires the conditions that tell a cold phone from a hot one", () => {
    const issues = validateReport(
      browserReport({
        env: {
          ...deviceEnv,
          device: {
            ...deviceEnv.device,
            batteryPct: "84" as never,
            thermalStatus: 3 as never,
          },
        },
      }),
    );
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "env.device.batteryPct",
        "env.device.thermalStatus",
      ]),
    );
  });
});

describe("validateReport: env.kind", () => {
  // `host` was added because both sibling repos were failing on this ONE field before a single metric
  // was looked at: spirectl said "dev", couch-coop said "live". The workaround was to fold everything
  // onto "ci" — which labels a capture from a RUNNING GAME HOST as CI, and that is simply false.
  it('accepts "host" as a third hardware-class-of-`ci` environment', () => {
    const report = {
      ...browserReport(),
      env: {
        kind: "host",
        label: "linux-host",
        cpuThrottle: 1,
        device: null,
        geometry: geometry(),
      },
    };
    expect(validateReport(report)).toEqual([]);
  });

  it("holds `host` to the SAME rules as `ci`: no device block", () => {
    const report = {
      ...browserReport(),
      env: {
        kind: "host",
        label: "linux-host",
        cpuThrottle: 1,
        device: { model: "moto g86 5G", androidRelease: "15", chrome: "x" },
        geometry: geometry(),
      },
    };
    const issues = validateReport(report);
    expect(issues.map((issue) => issue.path)).toContain("env.device");
    // ...and names the kind that was actually reported, not "ci".
    expect(
      issues.find((issue) => issue.path === "env.device")?.message,
    ).toContain('"host"');
  });

  it("requires a cpuThrottle for browser-render on `host`, exactly as on `ci`", () => {
    const report = {
      ...browserReport(),
      env: {
        kind: "host",
        label: "linux-host",
        cpuThrottle: null,
        device: null,
        geometry: geometry(),
      },
    };
    expect(validateReport(report).map((issue) => issue.path)).toContain(
      "env.cpuThrottle",
    );
  });

  it("still rejects a kind nobody defined, and says what is allowed", () => {
    const report = {
      ...browserReport(),
      env: {
        kind: "dev",
        label: "linux",
        cpuThrottle: 1,
        device: null,
        geometry: geometry(),
      },
    };
    const issue = validateReport(report).find(
      (candidate) => candidate.path === "env.kind",
    );
    expect(issue?.message).toContain('"ci" | "host" | "device"');
  });
});

describe("validateReport: sibling profiles", () => {
  // spirectl's producer walk has no browser, no trace, no screenshot and nothing to CPU-throttle.
  const producerWalk: PerfReport<Record<string, unknown>> = {
    schema: REPORT_SCHEMA,
    repo: "spirectl",
    profile: "producer-walk",
    scenario: "producer-walk",
    env: { kind: "ci", label: "linux-dotnet", cpuThrottle: null, device: null },
    params: { mode: "incremental" },
    repeats: 5,
    warmups: 1,
    metrics: {
      avgCaptureMs: 4.1,
      maxCaptureMs: 11.9,
      capturesPerSec: 61.2,
      emitsPerSec: 30.4,
      producerBusyPct: 24.8,
      nodes: 3411,
      nodesRead: 812,
      skelElided: 0,
      prefixRefreshMs: 0.9,
      readMsByCategory: { transform: 1.2, text: 0.4, texture: 2.1 },
    },
    runs: [
      {
        avgCaptureMs: 4.3,
        maxCaptureMs: 12.4,
        capturesPerSec: 60.1,
        emitsPerSec: 30.1,
        producerBusyPct: 25.5,
        nodes: 3411,
        nodesRead: 815,
        skelElided: 0,
        prefixRefreshMs: 1,
        readMsByCategory: { transform: 1.3, text: 0.4, texture: 2.2 },
      },
    ],
    artifacts: {},
  };

  it("accepts a producer-walk report with no browser fields", () => {
    expect(validateReport(producerWalk)).toEqual([]);
  });

  it("accepts a wire-payload report", () => {
    expect(
      validateReport({
        ...producerWalk,
        repo: "sts2-couch-coop",
        profile: "wire-payload",
        scenario: "wire-payload",
        metrics: { bytesPerFrame: 4821, upsertsPerFrame: 37 },
        runs: [{ bytesPerFrame: 4903, upsertsPerFrame: 39 }],
        artifacts: { capture: "artifacts/wire/capture.jsonl" },
      }),
    ).toEqual([]);
  });

  it("still rejects an all-zero metrics block", () => {
    // Anti-degeneracy is profile-agnostic: an envelope of zeroes is a broken measurement, not a fast
    // one, whichever repo produced it.
    const issues = validateReport({
      ...producerWalk,
      metrics: {
        avgCaptureMs: 0,
        capturesPerSec: 0,
        readMsByCategory: { transform: 0 },
      },
      runs: [{ avgCaptureMs: 0, capturesPerSec: 0 }],
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/every numeric metric is zero/);
  });

  it("rejects non-finite metrics", () => {
    const issues = validateReport({
      ...producerWalk,
      metrics: { avgCaptureMs: Number.NaN, capturesPerSec: 60 },
    });
    expect(issues.map((issue) => issue.path)).toContain("metrics.avgCaptureMs");
  });

  it("rejects a non-string artifact path", () => {
    const issues = validateReport({
      ...producerWalk,
      artifacts: { capture: 7 },
    });
    expect(issues.map((issue) => issue.path)).toContain("artifacts.capture");
  });
});

describe("medianMetrics", () => {
  it("reports medians, not means", () => {
    const runs = [1, 2, 3, 4, 100].map((value) =>
      browserMetrics({ readyMs: value, blockedMs: value }),
    );
    const median = medianMetrics(runs);
    expect(median.readyMs).toBe(3);
    expect(median.blockedMs).toBe(3);
  });

  it("takes the WORST in-raster count, never the median", () => {
    // An in-raster decode on one repeat out of five is still a hard failure; four clean runs must
    // not smooth it away.
    const runs = [0, 0, 0, 0, 3].map((inRasterCount, index) => {
      const base = browserMetrics();
      return {
        ...base,
        decode: {
          ...base.decode,
          inRasterCount,
          inRasterMs: inRasterCount * 91,
        },
        readyMs: index + 1,
      };
    });
    expect(medianMetrics(runs).decode.inRasterCount).toBe(3);
    expect(medianMetrics(runs).decode.inRasterMs).toBe(273);
  });

  it("does not annihilate small ratios", () => {
    // REGRESSION: a fixed 2-decimal round reported these real page-crop readings as a flat 0,
    // turning "the main thread is 99.7% parked" into a number that reads as "not measured".
    const runs = [0.003, 0.0029, 0.0029, 0.0029, 0.0033].map((ratio) =>
      browserMetrics({ mainThreadCpuRatio: ratio }),
    );
    expect(medianMetrics(runs).mainThreadCpuRatio).toBe(0.0029);
    // …and the result must still survive validation, which requires a strictly positive ratio.
    expect(medianMetrics(runs).mainThreadCpuRatio).toBeGreaterThan(0);
  });

  it("aggregates all-null cpu ratios to null, not to a number", () => {
    const runs = [0, 0, 0].map(() =>
      browserMetrics({ mainThreadCpuRatio: null, mainThreadCpuSamples: 0 }),
    );
    expect(medianMetrics(runs).mainThreadCpuRatio).toBeNull();
    expect(medianMetrics(runs).mainThreadCpuSamples).toBe(0);
  });

  it("drops null runs from the median instead of letting them poison it", () => {
    // region-blob measured [null, 0.04849, null, null, 0.2028]: three repeats had no qualifying
    // task. The median must come from the two that did, and the sample count must describe THOSE
    // runs — otherwise the aggregate reads as a real ratio backed by n=0.
    const values: (number | null)[] = [null, 0.04849, null, null, 0.2028];
    const runs = values.map((ratio) =>
      browserMetrics({
        mainThreadCpuRatio: ratio,
        mainThreadCpuSamples: ratio === null ? 0 : 3,
      }),
    );
    const median = medianMetrics(runs);
    expect(median.mainThreadCpuRatio).toBeCloseTo(0.1256, 3);
    expect(median.mainThreadCpuSamples).toBe(3);
    // The invariant that makes the pair readable: null <=> zero samples.
    expect(median.mainThreadCpuRatio === null).toBe(
      median.mainThreadCpuSamples === 0,
    );
    expect(validateReport(browserReport({ metrics: median, runs }))).toEqual(
      [],
    );
  });

  it("keeps millisecond and count fields readable", () => {
    const runs = [1547, 1547, 1546].map((count) => {
      const base = browserMetrics();
      return { ...base, decode: { ...base.decode, count } };
    });
    expect(medianMetrics(runs).decode.count).toBe(1547);

    const gaps = [16.66666, 16.67012, 16.66801].map((p50) =>
      browserMetrics({
        activationGapMs: {
          p50,
          p95: p50,
          max: p50,
          over100msCount: 0,
          count: 3,
        },
      }),
    );
    expect(medianMetrics(gaps).activationGapMs.p50).toBe(16.67);
  });

  it("takes the WORST sampleHits, never the median", () => {
    const runs = [50, 50, 50, 50, 11].map((sampleHits) =>
      browserMetrics({
        presented: {
          nonEmptyRatio: 0.3,
          sampleHits,
          sampleCount: 50,
          screenshot: "s.png",
        },
      }),
    );
    expect(medianMetrics(runs).presented.sampleHits).toBe(11);
  });
});

describe("metrics.scenario: counters the scenario reports about itself", () => {
  // The seam exists because a CDP trace cannot attribute an arm's own switches: it shows the page got
  // cheaper, not that "the frozen arm's loop really parked" or that "the sim-capped arm suppressed sim
  // steps while the draws kept ticking". Only the scenario can count that, so these numbers are the
  // evidence for the claim the arm is making.
  it("medians the block per key", () => {
    const runs = [
      { simSteps: 1, draws: 100 },
      { simSteps: 2, draws: 101 },
      { simSteps: 3, draws: 300 },
      { simSteps: 4, draws: 102 },
      { simSteps: 100, draws: 103 },
    ].map((scenario) => browserMetrics({ scenario }));
    const median = medianMetrics(runs);
    expect(median.scenario).toEqual({ simSteps: 3, draws: 102 });
    // …and the medianed block is still a valid envelope, not just a valid object.
    expect(validateReport(browserReport({ metrics: median, runs }))).toEqual(
      [],
    );
  });

  it("medians a partly-reported key over the repeats that CARRIED it", () => {
    // Same rule as `cpu.byThread`: a counter present in two repeats out of five reports the two
    // readings it has. Averaging it against zeros the other three never counted would report a
    // number nothing measured — the one thing this block must never do.
    const partial: (number | undefined)[] = [
      undefined,
      40,
      undefined,
      60,
      undefined,
    ];
    const runs = partial.map((parkedFrames) =>
      browserMetrics({
        scenario: {
          draws: 10,
          ...(parkedFrames === undefined ? {} : { parkedFrames }),
        },
      }),
    );
    expect(medianMetrics(runs).scenario).toEqual({
      draws: 10,
      parkedFrames: 50,
    });
  });

  it("leaves an absent block ABSENT, never `{}`", () => {
    // Absent means NOT MEASURED. An empty block would read as "the scenario counted nothing", which
    // is a different claim and one nothing here made.
    const median = medianMetrics([1, 2, 3].map(() => browserMetrics()));
    expect(median.scenario).toBeUndefined();
    expect("scenario" in median).toBe(false);
  });

  it("rejects a non-finite counter", () => {
    const metrics = browserMetrics({
      scenario: { draws: 120, simSteps: Number.NaN },
    });
    const issues = validateReport(browserReport({ metrics, runs: [metrics] }));
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "metrics.scenario.simSteps",
        "runs[0].scenario.simSteps",
      ]),
    );
  });

  it("accepts a report with no scenario block at all", () => {
    // Backward compatibility, stated as a test: the block is optional and additive, so every
    // `perf-report/1` envelope written before the seam existed still validates.
    const report = browserReport();
    expect(report.metrics.scenario).toBeUndefined();
    expect(validateReport(report)).toEqual([]);
  });
});

describe("validateReport: env.geometry", () => {
  // The geometry block is what makes two browser numbers comparable at all. For a whole round the
  // device runner force-emulated a desktop viewport onto a phone and nothing in the report said so;
  // requiring the block is what stops that from being possible again.
  it("REQUIRES geometry on a browser-render report", () => {
    const report = browserReport();
    const { geometry: _dropped, ...env } = report.env;
    const issues = validateReport({ ...report, env });
    expect(issues.map((issue) => issue.path)).toContain("env.geometry");
  });

  it("does not require it on a non-browser profile", () => {
    expect(
      validateReport({
        ...browserReport(),
        profile: "producer-walk",
        env: { kind: "ci", label: "x", cpuThrottle: null, device: null },
        metrics: { captureMs: 12, nodes: 900 },
        runs: [{ captureMs: 12, nodes: 900 }],
        artifacts: {},
      }),
    ).toEqual([]);
  });

  it("accepts a fitted portrait device geometry", () => {
    expect(
      validateReport(
        browserReport({
          env: {
            ...browserReport().env,
            geometry: geometry({
              viewport: { width: 412, height: 883 },
              devicePixelRatio: 2.625,
              orientation: "portrait",
              fit: true,
              fitScale: 0.3872,
              stage: { width: 1064, height: 544 },
              fittedStage: { width: 411.98, height: 210.64 },
              grid: "5x10",
              emulatedViewport: null,
            }),
          },
        }),
      ),
    ).toEqual([]);
  });

  it("rejects a fitScale that is not a real scale", () => {
    for (const fitScale of [0, -1, Number.NaN]) {
      const issues = validateReport(
        browserReport({
          env: {
            ...browserReport().env,
            geometry: geometry({ fit: true, fitScale }),
          },
        }),
      );
      expect(issues.map((issue) => issue.path)).toContain(
        "env.geometry.fitScale",
      );
    }
  });

  it("rejects `fit: false` carrying a scale other than 1 — that pair cannot both be true", () => {
    const issues = validateReport(
      browserReport({
        env: {
          ...browserReport().env,
          geometry: geometry({ fit: false, fitScale: 0.5 }),
        },
      }),
    );
    expect(issues.map((issue) => issue.path)).toContain(
      "env.geometry.fitScale",
    );
  });

  it("rejects an unknown orientation and a degenerate viewport", () => {
    const issues = validateReport(
      browserReport({
        env: {
          ...browserReport().env,
          geometry: geometry({
            orientation: "sideways" as never,
            viewport: { width: 0, height: 800 },
          }),
        },
      }),
    );
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain("env.geometry.orientation");
    expect(paths).toContain("env.geometry.viewport.width");
  });
});
