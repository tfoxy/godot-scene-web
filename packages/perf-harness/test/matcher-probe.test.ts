// `--dump-trace-names` matcher probe.
//
// The single highest-risk assumption in porting this harness to a phone is that the analyzer's event
// names still match. Headless SwiftShader emits `SoftwareImageDecodeCache::*`; a real GPU emits
// `GpuImageDecodeCache::*`. An analyzer matching only one family reports `decode.count: 0`, and zero
// reads like "fast". The probe answers that question in one screen instead of 200 histogram rows.

import { describe, expect, it } from "vitest";
import { formatMatcherProbe, matcherProbe } from "../src/analyze";
import type { TraceEvent } from "../src/trace";
import { complete, healthyTrace, WORKER_TID } from "./trace-fixtures";

function gpuTrace(): TraceEvent[] {
  return healthyTrace().map((event) =>
    event.name === "SoftwareImageDecodeCache::DecodeImageIfNecessary"
      ? { ...event, name: "GpuImageDecodeCache::DecodeImageIfNecessary" }
      : event,
  );
}

describe("matcherProbe", () => {
  it("reports every family as matched on a healthy software-path trace", () => {
    const probe = matcherProbe(healthyTrace());
    expect(probe.rows.filter((row) => !row.ok)).toEqual([]);
    expect(probe.nearMisses).toEqual([]);
  });

  it("matches the GPU decode-cache family too", () => {
    const probe = matcherProbe(gpuTrace());
    const family = probe.rows.find((row) => row.role === "decode cache family");
    expect(family?.ok).toBe(true);
    expect(family?.matched.map((entry) => entry.name)).toContain(
      "GpuImageDecodeCache::DecodeImageIfNecessary",
    );
  });

  it("calls out a family that matched NOTHING, and what it silently zeroes", () => {
    const withoutDecode = healthyTrace().filter(
      (event) => !/ImageDecode|Decode Image/.test(event.name),
    );
    const probe = matcherProbe(withoutDecode);
    const decode = probe.rows.find((row) => row.role === "decode task");
    expect(decode?.ok).toBe(false);
    expect(decode?.breaks).toContain("decode.count");
    expect(formatMatcherProbe(withoutDecode)).toContain(
      "reports ZERO (not fast)",
    );
  });

  it("lists a RENAMED decode event as a near miss instead of losing it", () => {
    // What a future Chrome rename looks like from here: the family still shows up in the trace, the
    // matcher no longer catches it, and the probe puts the new name in front of whoever is porting.
    const renamed = [
      ...healthyTrace(),
      complete("GpuImageDecodeCache2::DecodeImageInTaskV2", 200, 12, {
        tid: WORKER_TID,
        cat: "cc,benchmark",
      }),
    ];
    const probe = matcherProbe(renamed);
    expect(probe.nearMisses.map((entry) => entry.name)).toContain(
      "GpuImageDecodeCache2::DecodeImageInTaskV2",
    );
    expect(formatMatcherProbe(renamed)).toContain("NEAR MISSES");
  });

  it("puts an unmatched DECODE name above the cc raster/activation noise", () => {
    // A real capture lists ~25 near misses (RasterSource::…, EndActivateToDrawLayers, Swap, …).
    // Burying a renamed decode event among them would defeat the purpose: that is the one miss that
    // makes a phone report "no image decoding" and be believed.
    const renamed = [
      ...healthyTrace(),
      complete("GpuImageDecodeCache2::DecodeImageInTaskV2", 200, 12, {
        tid: WORKER_TID,
        cat: "cc,benchmark",
      }),
      ...Array.from({ length: 40 }, (_, index) =>
        complete("RasterSource::PerformSolidColorAnalysis", 210 + index, 0.1, {
          tid: WORKER_TID,
          cat: "cc",
        }),
      ),
    ];
    expect(matcherProbe(renamed).nearMisses[0].name).toBe(
      "GpuImageDecodeCache2::DecodeImageInTaskV2",
    );
  });
});
