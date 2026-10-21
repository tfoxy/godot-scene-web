// GRT3: the frame-counted stall checks (lib/gate1-g1d-checks.ts hostFpsOfArgv, stallFrames and
// checkSimKeptRunning) with synthetic evidence -- a real-time stall and the same stall in frames
// on a fast host judge alike, and a host that missed its fast rate fails.
//
//   pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-fast-frames-checks.ts

import {
  checkSimKeptRunning,
  hostFpsOfArgv,
  NOMINAL_FPS,
  stallFrames,
} from "../lib/gate1-g1d-checks";

let fails = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) fails++;
};

check("no argv is 60 fps", hostFpsOfArgv(undefined) === NOMINAL_FPS);
check(
  "a real-time host is 60",
  hostFpsOfArgv("b\n--headless\n--max-fps\n60\n--path\n/f\n") === 60,
);
check(
  "a fast host is its --max-fps",
  hostFpsOfArgv("b\n--headless\n--max-fps\n240\n--disable-vsync\n") === 240,
);
check("a bad value is 60", hostFpsOfArgv("b\n--max-fps\nx\n") === 60);
check("2000 ms at 60 fps = 120 frames", stallFrames(2000, 60) === 120);
check("500 ms at 240 fps = 120 frames", stallFrames(500, 240) === 120);
check("1300 ms at 60 fps = 78 frames", stallFrames(1300, 60) === 78);
check("325 ms at 240 fps = 78 frames", stallFrames(325, 240) === 78);

/** One live-stall evaluation: the receiver's spec, the host's rate, what the host log showed. */
function evals(spec: string, fps: number, frames: number, intervalMs: number) {
  const e = {
    leg: "live-stall",
    legDir: "/nowhere/live-stall",
    env: new Map([["RS_RECEIVER_STALL", spec]]),
    host_fps: fps,
    stall: {
      send_frame: 400,
      credit_frame: 400 + frames,
      frames_during_stall: frames,
      frame_lines_missing: [],
      avg_frame_interval_ms: intervalMs,
      steps_applied_during: [2],
    },
  };
  return new Map([["live-stall", e]]) as unknown as Parameters<
    typeof checkSimKeptRunning
  >[0];
}
const pass = (x: ReturnType<typeof checkSimKeptRunning>) => x.status === "pass";

check(
  "real time: 1:2000 over 118 frames at 16.9 ms passes",
  pass(checkSimKeptRunning(evals("1:2000", 60, 118, 16.9))),
);
check(
  "fast: 1:500 (120 frames at 240) over 118 frames at 4.2 ms passes",
  pass(checkSimKeptRunning(evals("1:500", 240, 118, 4.2))),
);
check(
  "fast: a host capped near 145 fps (72 frames at 6.9 ms) fails",
  !pass(checkSimKeptRunning(evals("1:500", 240, 72, 6.9))),
);
check(
  "real time: too few frames (90 of 120) fails",
  !pass(checkSimKeptRunning(evals("1:2000", 60, 90, 22.2))),
);
check(
  "a 1:500 spec on a 60 fps host needs only 24 frames",
  pass(checkSimKeptRunning(evals("1:500", 60, 118, 4.2))),
);

console.log(
  fails === 0
    ? "self-test-fast-frames-checks: PASS"
    : `self-test-fast-frames-checks: FAIL (${fails})`,
);
process.exit(fails === 0 ? 0 : 1);
