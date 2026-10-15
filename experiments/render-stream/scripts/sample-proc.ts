#!/usr/bin/env -S pnpm exec tsx --conditions=development
// A runner-side `/proc` sampler CLI (gate6-design.md Q7e "Stability (g6s)"): wraps
// `lib/proc-sampler.ts`'s pure functions in a long-lived process `run-gate6.sh` can start in the
// background (as it does the host and the receiver), one per pid it wants a timeline for over a
// long soak. Every sample is appended to `--out` as one JSON line (ProcSample) the moment it is
// read, never buffered until a clean stop: the runner's own cleanup trap kills every process it
// started with a plain `kill`/`kill -9`, never an RPC, and a sampler that only wrote at the end
// would lose everything on that path.
//
//   mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/sample-proc.ts \
//     --pid <pid> --out <abs path.jsonl> [--interval-ms 1000]
//
// Exits 0 on its own once `pid` is gone (ESRCH from readProcStatus), so a caller that forgets to
// kill it does not leak a sampler past the process it was watching. SIGTERM/SIGINT (the runner's
// own kill) stop the interval and exit 0 immediately, mid-sample data included.

import { appendFileSync } from "node:fs";
import { sampleOnce } from "./lib/proc-sampler";

function parseArgs(argv: string[]): {
  pid: number;
  out: string;
  intervalMs: number;
} {
  let pid: number | undefined;
  let out: string | undefined;
  let intervalMs = 1000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pid") {
      pid = Number(argv[++i]);
    } else if (argv[i] === "--out") {
      out = argv[++i];
    } else if (argv[i] === "--interval-ms") {
      intervalMs = Number(argv[++i]);
    }
  }
  if (!pid || !Number.isFinite(pid) || !out) {
    throw new Error(
      "sample-proc: --pid <pid> and --out <abs path.jsonl> are required",
    );
  }
  return { pid, out, intervalMs };
}

function main(): void {
  const { pid, out, intervalMs } = parseArgs(process.argv.slice(2));
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.exit(0);
  };
  const tick = (): void => {
    try {
      const sample = sampleOnce(pid);
      appendFileSync(out, `${JSON.stringify(sample)}\n`);
    } catch {
      // The pid is gone (or /proc is unreadable for some other reason): nothing more to sample.
      stop();
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();
