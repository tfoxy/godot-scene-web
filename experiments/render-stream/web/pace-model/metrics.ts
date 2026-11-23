import type { PacingSeries } from "./pacing";

export function pacingMetrics(
  series: PacingSeries,
  startMs: number,
  endMs: number,
) {
  const histogram: Record<string, { duration_ms: number; share: number }> = {};
  const duration = endMs - startMs;
  for (let i = 0; i < series.pattern.length; i++) {
    const from = Math.max(startMs, series.patternMs[i]);
    const until = Math.min(endMs, series.patternMs[i + 1] ?? endMs);
    histogram[series.pattern[i]] ??= {
      duration_ms: 0,
      share: 0,
    };
    const entry = histogram[series.pattern[i]];
    entry.duration_ms += Math.max(0, until - from);
    entry.share = duration > 0 ? entry.duration_ms / duration : 0;
  }
  const missed = series.missedSlotMs.length;
  const slots = missed + series.takenSlotMs.length;
  return {
    pattern_changes: series.pattern.length - 1,
    pattern_histogram: histogram,
    probes_kept: series.probes.filter((p) => p.outcome === "kept").length,
    probes_reverted: series.probes.filter((p) => p.outcome === "reverted")
      .length,
    probes_pending: series.probes.filter((p) => p.outcome === "pending").length,
    slots_missed: missed,
    slots_total: slots,
    missed_slot_share: slots ? missed / slots : null,
  };
}

export function percentile(a: number[], p: number): number | null {
  if (!a.length) return null;
  const sorted = [...a].sort((x, y) => x - y);
  return sorted[Math.ceil((sorted.length - 1) * p)];
}

export function drawMetrics(
  ts: number[],
  drew: number[],
  captureMs: (number | null)[],
) {
  const drawMs = ts.filter((_, i) => drew[i]);
  const intervals = drawMs.slice(1).map((t, i) => t - drawMs[i]);
  const ages = ts.flatMap((t, i) =>
    drew[i] && captureMs[i] !== null ? [t - captureMs[i]!] : [],
  );
  const mean = (a: number[]) =>
    a.length ? a.reduce((a, b) => a + b, 0) / a.length : null;
  const intervalMean = mean(intervals);
  const median = percentile(intervals, 0.5);
  return {
    content_age_ms: {
      mean: mean(ages),
      p50: percentile(ages, 0.5),
      p95: percentile(ages, 0.95),
    },
    steadiness: {
      draw_interval_ms: intervals,
      median_ms: median,
      stddev_ms:
        intervalMean === null
          ? null
          : Math.sqrt(
              intervals.reduce((sum, t) => sum + (t - intervalMean) ** 2, 0) /
                intervals.length,
            ),
      stutter_share:
        median === null
          ? null
          : intervals.filter((t) => t > 1.5 * median).length / intervals.length,
    },
  };
}
