import { createGpuLoad } from "./gpu-load";
import { EmulatedHost } from "./host";
import { percentile } from "./metrics";
import { PresentationPacer } from "./pacing";
import {
  type Calibration,
  pingProbe,
  type RunOptions,
  type Segment,
} from "./probe";

const canvas = document.querySelector("canvas");
if (!canvas) throw new Error("pace-model: no canvas");
const device = new URLSearchParams(location.search).has("device");
if (device) {
  canvas.width = Math.round(innerWidth * devicePixelRatio);
  canvas.height = Math.round(innerHeight * devicePixelRatio);
}
const context = canvas.getContext("webgl2", {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
});
if (!context) throw new Error("pace-model: no WebGL2");
const gl: WebGL2RenderingContext = context;
let lost = false;
let abort: ((error: Error) => void) | null = null;
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  lost = true;
  abort?.(new Error("pace-model: GPU context lost"));
});

const load = createGpuLoad(gl);
let iterations = 1;
let busy = false;
let displayMs = 1000 / 60;
let displayAnchorMs = 0;
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function sample(options: RunOptions): Promise<Segment> {
  if (lost || gl.isContextLost())
    return Promise.reject(new Error("pace-model: GPU context lost"));
  if (!Number.isFinite(options.seconds) || options.seconds <= 0)
    return Promise.reject(new Error("pace-model: seconds must be positive"));
  if (
    typeof options.draw === "object" &&
    "contentHz" in options.draw &&
    (!Number.isFinite(options.draw.contentHz) || options.draw.contentHz <= 0)
  )
    return Promise.reject(new Error("pace-model: contentHz must be positive"));
  return new Promise((resolve, reject) => {
    const startMs = performance.now();
    const ts: number[] = [];
    const drew: number[] = [];
    const durationMs: number[] = [];
    const consumed: number[] = [];
    const captureMs: (number | null)[] = [];
    const host =
      typeof options.draw === "object" && "host" in options.draw
        ? new EmulatedHost(options.draw.host, startMs, {
            now: () => performance.now(),
            setTimeout: (cb, ms) => window.setTimeout(cb, ms),
            clearTimeout: (id) => clearTimeout(id),
          })
        : null;
    const pacing =
      host &&
      ["paced", "pacedOff"].includes(
        typeof options.draw === "object" && "host" in options.draw
          ? options.draw.host.policy
          : "",
      )
        ? new PresentationPacer(startMs, displayAnchorMs, displayMs)
        : null;
    const ping = pingProbe();
    let content = false;
    const contentTimer =
      typeof options.draw === "object" && "contentHz" in options.draw
        ? window.setInterval(() => {
            content = true;
          }, 1000 / options.draw.contentHz)
        : null;
    let raf = 0;
    const finish = (error?: Error) => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      if (contentTimer !== null) clearInterval(contentTimer);
      host?.stop();
      pacing?.finish(performance.now());
      abort = null;
      const result: Segment = {
        startMs,
        endMs: performance.now(),
        options,
        iterations,
        ts,
        drew,
        durationMs,
        ping: ping.stop(),
        ...(host ? { host: { ...host.series, consumed, captureMs } } : {}),
        ...(pacing ? { pacing: pacing.series } : {}),
      };
      if (device && options.draw === "none") {
        const intervals = ts.slice(1).map((t, i) => t - ts[i]);
        result.displayIntervalMs = percentile(intervals, 0.5) ?? 0;
      }
      if (error) reject(error);
      else resolve(result);
    };
    const timer = window.setTimeout(() => finish(), options.seconds * 1000);
    abort = finish;
    const frame = (t: number) => {
      try {
        const begin = performance.now();
        host?.observeCallback(t, begin);
        const eligible = pacing?.callback(t) ?? true;
        if (
          pacing &&
          host &&
          typeof options.draw === "object" &&
          "host" in options.draw &&
          options.draw.host.policy === "paced"
        ) {
          const { oneWayMs, jitterMs, applyMs } = options.draw.host;
          // Cover a round trip, delivery margin, one host interval and the
          // longest presentation-pattern gap before the next planning callback.
          const horizon =
            2 * oneWayMs +
            jitterMs +
            applyMs +
            1 +
            host.series.periodMs +
            3 * displayMs;
          host.planWants(
            begin,
            pacing.futureSlots(begin, begin + horizon),
            horizon,
          );
        }
        const count = eligible ? (host?.consume(begin) ?? 0) : 0;
        const draw =
          options.draw === "every" ||
          (typeof options.draw === "object" && content) ||
          count > 0;
        if (draw) {
          content = false;
          host?.recordDraw(t);
          pacing?.draw(t);
          load.draw(iterations, t);
        }
        ts.push(t);
        drew.push(Number(draw));
        if (host) {
          consumed.push(count);
          captureMs.push(draw ? host.lastConsumedCaptureMs : null);
        }
        durationMs.push(performance.now() - begin);
        raf = requestAnimationFrame(frame);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    raf = requestAnimationFrame(frame);
  });
}

async function run(options: RunOptions): Promise<Segment> {
  if (busy) throw new Error("pace-model: already running");
  busy = true;
  try {
    // Drain work from the preceding segment before recording the next one.
    // Measure the unloaded display grid before paced runs, using the same rAF clock.
    const paced =
      typeof options.draw === "object" &&
      "host" in options.draw &&
      ["paced", "pacedOff"].includes(options.draw.host.policy);
    if (paced) {
      const idle = await sample({ seconds: 0.5, draw: "none" });
      const intervals = idle.ts.slice(1).map((t, i) => t - idle.ts[i]);
      const short = percentile(intervals, 0.1);
      if (short === null || short <= 0)
        throw new Error("pace-model: display grid unavailable");
      const near = intervals.filter(
        (dt) => Math.abs(dt - short) <= Math.min(2, short / 4),
      );
      displayMs = near.reduce((sum, dt) => sum + dt, 0) / near.length;
      displayAnchorMs = idle.ts[idle.ts.length - 1];
    } else await delay(500);
    return await sample(options);
  } finally {
    busy = false;
  }
}

async function calibrate(targetHz: number): Promise<Calibration> {
  if (busy) throw new Error("pace-model: already running");
  if (!Number.isFinite(targetHz) || targetHz <= 0)
    throw new Error("pace-model: invalid targetHz");
  busy = true;
  iterations = 1;
  try {
    const result = await load.calibrate(targetHz, {
      sample: (count) => {
        iterations = count;
        return sample({ seconds: 2, draw: "every" });
      },
      allowMinimumWorkloadTooSlow: device,
    });
    iterations = result.iterations;
    return result;
  } finally {
    busy = false;
  }
}

const api = { calibrate, run, backing: [canvas.width, canvas.height] };
(window as unknown as { paceModel: typeof api }).paceModel = api;
