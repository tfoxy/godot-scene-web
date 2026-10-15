#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Wall-clock host frame rate sampler for gate 6 group g6p's `unarmed` arm (protocol/gate6-design.md
// D11: "unarmed (no extension: host simulation alone)"). An unarmed host loads no capture
// extension, so it writes none of the perf-timeline.jsonl / perf.json evidence every other arm's
// `host_frame` rate comes from (scripts/lib/gate6c-checks.ts hostWindow/connectionRates). It DOES
// still write RS_FIXTURE_STEP_LOG (fixtures/gate6-scene/gate6_scene.gd: step logging is a fixture
// feature, independent of the extension), one JSONL line per step at game time `5 + step` seconds
// on the `rate` timeline (steps 1..10 one game-second apart, step 11 at 28 s). Under this fixture's
// realtime pacing (D6), one game second IS one wall-clock second (no `--fixed-fps`), so polling
// `steps.jsonl` for new lines and timestamping each with the poller's own wall clock gives
// (frame, wall_time) pairs whose slope is the achieved host frame rate over the polled span --
// cruder than the extension's own histogram (a single rate, not a distribution; wall-clock poll
// jitter at ~50 ms against ~1 s step spacing), but the only measurement available with no
// extension loaded.
//
//   mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/sample-rate.ts \
//     --pid <pid> --steps <steps.jsonl> --out <wall-rate.json> [--max-step 10] [--poll-ms 50]
//
// Polls until `pid` is gone (or no step beyond `--max-step` has appeared and 45s elapse), then
// writes `--out` once: a least-squares (frame vs wall-clock ms) slope in 1/s over every step line
// with `1 <= step <= max-step`, or `host_frame_rate: null` with a reason when fewer than two such
// lines were seen. Exits 0 whether or not a rate could be computed -- a host that quit before
// writing any step is reported, not a crash.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface WallRateResult {
  schema: "render-stream-wall-rate/1";
  host_frame_rate: number | null;
  samples: number;
  window_seconds: number | null;
  reason: string | null;
  method: string;
}

const METHOD =
  "host steps.jsonl wall-clock slope over step 1..max-step (unarmed has no extension perf-timeline, D11)";

interface StepSample {
  t_ms: number;
  step: number;
  frame: number;
}

/** Least-squares slope of frame vs t_ms, in frames per second. Null (with a reason) below two
 * points or a zero/negative time span. Pure, so the self-test drives it directly. */
export function slopeFramesPerSecond(samples: readonly StepSample[]): {
  rate: number | null;
  reason: string | null;
} {
  if (samples.length < 2) {
    return { rate: null, reason: `only ${samples.length} step line(s) seen` };
  }
  const n = samples.length;
  const mt = samples.reduce((a, s) => a + s.t_ms, 0) / n;
  const mf = samples.reduce((a, s) => a + s.frame, 0) / n;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += (s.t_ms - mt) * (s.frame - mf);
    den += (s.t_ms - mt) ** 2;
  }
  if (den === 0)
    return {
      rate: null,
      reason: "every step line landed at the same wall time",
    };
  const framesPerMs = num / den;
  if (framesPerMs <= 0)
    return {
      rate: null,
      reason: `non-positive slope (${framesPerMs} frames/ms)`,
    };
  return { rate: framesPerMs * 1000, reason: null };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseStepLines(text: string): { step: number; frame: number }[] {
  const out: { step: number; frame: number }[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as {
        step?: number;
        applied_frame?: number;
      };
      if (
        typeof entry.step === "number" &&
        typeof entry.applied_frame === "number"
      ) {
        out.push({ step: entry.step, frame: entry.applied_frame });
      }
    } catch {
      // a line cut mid-write by a kill is not a sample
    }
  }
  return out;
}

function parseArgs(argv: string[]): {
  pid: number;
  steps: string;
  out: string;
  maxStep: number;
  pollMs: number;
} {
  let pid: number | undefined;
  let steps: string | undefined;
  let out: string | undefined;
  let maxStep = 10;
  let pollMs = 50;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pid") pid = Number(argv[++i]);
    else if (argv[i] === "--steps") steps = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--max-step") maxStep = Number(argv[++i]);
    else if (argv[i] === "--poll-ms") pollMs = Number(argv[++i]);
  }
  if (!pid || !Number.isFinite(pid) || !steps || !out) {
    throw new Error(
      "sample-rate: --pid <pid> --steps <steps.jsonl> --out <wall-rate.json> are required",
    );
  }
  return { pid, steps, out, maxStep, pollMs };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { pid, steps, out, maxStep, pollMs } = parseArgs(process.argv.slice(2));
  const samples: StepSample[] = [];
  const seenSteps = new Set<number>();
  let highestSeen = -1;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const alive = pidAlive(pid);
    if (existsSync(steps)) {
      const now = Date.now();
      let text = "";
      try {
        text = readFileSync(steps, "utf8");
      } catch {
        text = "";
      }
      for (const { step, frame } of parseStepLines(text)) {
        if (seenSteps.has(step)) continue;
        seenSteps.add(step);
        highestSeen = Math.max(highestSeen, step);
        if (step >= 1 && step <= maxStep) {
          samples.push({ t_ms: now, step, frame });
        }
      }
    }
    if (!alive) break;
    if (highestSeen >= maxStep) break;
    await sleep(pollMs);
  }
  const { rate, reason } = slopeFramesPerSecond(samples);
  const windowSeconds =
    samples.length >= 2
      ? (samples[samples.length - 1].t_ms - samples[0].t_ms) / 1000
      : null;
  const result: WallRateResult = {
    schema: "render-stream-wall-rate/1",
    host_frame_rate: rate,
    samples: samples.length,
    window_seconds: windowSeconds,
    reason,
    method: METHOD,
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
