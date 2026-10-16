// The TS twin of lib/quiet.sh (results/measurement-isolation.md): the machine-wide
// measurement-isolation lock, for runners written in TS (gate7-bench.ts, the gate 7 browser legs).
//
// It holds nothing itself: every hold is a `quiet.sh hold` HOLDER process, exactly as the bash
// library's, so the lock path, the waiter marker (no starvation), the nesting check (this process or
// an ancestor -- a bash runner calling this TS -- already holding), the optional core pinning
// (RS_TIMING_CPUSET / RS_BACKGROUND_CPUSET: the holder pins this process's whole tree, all
// threads) and the JSON-lines logging are one implementation. The holder exits within 0.25 s of
// this process dying, so a crashed bench never keeps the lock.
//
//   const hold = await quietAcquire("exclusive", "g7-bench/gsw-ts-desktop", { log });
//   try { ...the timed work... } finally { await hold.release(); }

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type QuietMode = "shared" | "exclusive";

export interface QuietHold {
  mode: QuietMode;
  label: string;
  /** "acquired": this process holds the lock; "nested": an ancestor (or this process) already
   * holds it; "none": the holder failed (the work runs unlocked, with a warning). */
  state: "acquired" | "nested" | "none";
  waitS: number;
  release(): Promise<void>;
}

export const QUIET_SH = join(
  dirname(fileURLToPath(import.meta.url)),
  "quiet.sh",
);

/** Blocks until this process holds the lock in `mode` (or is nested in an ancestor's hold). */
export function quietAcquire(
  mode: QuietMode,
  label: string,
  opts: { log?: string } = {},
): Promise<QuietHold> {
  const started = Date.now();
  const child = spawn(
    "bash",
    [
      QUIET_SH,
      "hold",
      mode,
      "--owner",
      String(process.pid),
      "--label",
      label,
      "--log",
      opts.log ?? process.env.QUIET_LOG ?? "",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let exited = false;
  const exit = new Promise<void>((res) =>
    child.on("exit", () => {
      exited = true;
      res();
    }),
  );
  return new Promise((resolveHold) => {
    let buf = "";
    let settled = false;
    const settle = (line: string) => {
      if (settled) return;
      settled = true;
      child.stdout.removeAllListeners("data");
      child.stdout.resume();
      const waitS = (Date.now() - started) / 1000;
      if (line.startsWith("acquired")) {
        resolveHold({
          mode,
          label,
          state: "acquired",
          waitS,
          release: async () => {
            if (!exited) child.kill("SIGTERM");
            await exit;
          },
        });
        return;
      }
      if (!line.startsWith("nested"))
        console.error(
          `quiet-lock: WARNING: ${label} runs without the ${mode} lock (${line || "the holder exited"})`,
        );
      resolveHold({
        mode,
        label,
        state: line.startsWith("nested") ? "nested" : "none",
        waitS,
        release: async () => {
          await exit;
        },
      });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) settle(buf.slice(0, nl));
    });
    child.on("exit", () => settle(buf.trim()));
    child.on("error", (e) => settle(`error ${e.message}`));
  });
}

/** `fn` under a hold, released however it ends. */
export async function withQuietLock<T>(
  mode: QuietMode,
  label: string,
  fn: () => Promise<T>,
  opts: { log?: string } = {},
): Promise<T> {
  const hold = await quietAcquire(mode, label, opts);
  try {
    return await fn();
  } finally {
    await hold.release();
  }
}
