import type { HostOptions, HostSeries } from "./host";
import { percentile } from "./metrics";
import type { PacingSeries } from "./pacing";

export interface RunOptions {
  seconds: number;
  draw: "every" | "none" | { contentHz: number } | { host: HostOptions };
}

export interface Segment {
  startMs: number;
  endMs: number;
  options: RunOptions;
  iterations: number;
  ts: number[];
  drew: number[];
  durationMs: number[];
  ping: { postMs: number[]; delayMs: number[] };
  /** Host mode only; consumed aligns with the callback timestamps. */
  host?: HostSeries & { consumed: number[]; captureMs: (number | null)[] };
  pacing?: PacingSeries;
  /** Device page's display estimate from the idle segment's rAF timestamps. */
  displayIntervalMs?: number;
}

export interface Calibration {
  targetHz: number;
  reachedHz: number;
  iterations: number;
  calibrated: boolean;
  backpressure: boolean;
  limitation?: "minimum-workload-too-slow";
  samples: Segment[];
}

export function callbackRate(segment: Pick<Segment, "ts">): number {
  const n = segment.ts.length;
  return n > 1 ? (1000 * (n - 1)) / (segment.ts[n - 1] - segment.ts[0]) : 0;
}

/** Median callback interval of an independently recorded unloaded segment. */
export function displayIntervalMs(segment: Pick<Segment, "ts">): number {
  const intervals = segment.ts.slice(1).map((t, i) => t - segment.ts[i]);
  return percentile(intervals, 0.5) ?? 0;
}

export function idleReturnsDisplay(
  reference: Pick<Segment, "ts">,
  idle: Pick<Segment, "ts">,
): boolean {
  const displayHz = 1000 / displayIntervalMs(reference);
  return Number.isFinite(displayHz) && callbackRate(idle) >= 0.95 * displayHz;
}

/** Message dispatch delay, separate from timer scheduling delay. */
export function pingProbe() {
  const channel = new MessageChannel();
  const postMs: number[] = [];
  const delayMs: number[] = [];
  channel.port1.onmessage = (event: MessageEvent<number>) => {
    postMs.push(event.data);
    delayMs.push(performance.now() - event.data);
  };
  const timer = window.setInterval(() => {
    channel.port2.postMessage(performance.now());
  }, 4);
  return {
    stop() {
      clearInterval(timer);
      channel.port1.close();
      channel.port2.close();
      return { postMs, delayMs };
    },
  };
}
