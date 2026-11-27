import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSystemErrorName } from "node:util";
import { phaseHeartbeat } from "./phase-heartbeat";

export const JUDGE_CHILD_TIMEOUT_MS = 10 * 60 * 1000;

export interface JudgeChildName {
  group: string;
  view: string;
  checker: string;
}

export class JudgeTimeout extends Error {
  readonly status = "judge-timeout";
  constructor(
    readonly child: JudgeChildName,
    readonly timeoutMs: number,
  ) {
    super(
      `judge-timeout: ${child.group}/${child.view}: ${child.checker} exceeded ${timeoutMs} ms`,
    );
    this.name = "JudgeTimeout";
  }
}

/** A subreaping supervisor kills descendants even when they change process groups. Parent-death
 * notification keeps cleanup alive after the blocked caller is killed by its outer watchdog. */
export function judgeSpawnSync(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
  child: JudgeChildName,
  out: string | undefined,
  timeoutMs: number,
) {
  const temporary = mkdtempSync(join(tmpdir(), "judge-child-"));
  let result: SpawnSyncReturns<string>;
  let timedOut = false;
  try {
    const statusPath = join(temporary, "status.json");
    result = spawnSync(
      "python3",
      [
        fileURLToPath(new URL("./judge-child-supervisor.py", import.meta.url)),
        String(timeoutMs),
        statusPath,
        command,
        ...args,
      ],
      {
        ...options,
        timeout: timeoutMs + 1000,
        // The supervisor handles TERM by SIGKILLing and reaping its entire subtree.
        killSignal: "SIGTERM",
      },
    );
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
        timed_out: boolean;
        launch_error?: { errno: number };
      };
      timedOut = status.timed_out === true;
      if (status.launch_error) {
        const { errno } = status.launch_error;
        const code = getSystemErrorName(errno);
        const error = Object.assign(new Error(`spawnSync ${command} ${code}`), {
          errno,
          code,
          syscall: `spawnSync ${command}`,
          path: command,
          spawnargs: args,
        });
        // Match Node's failed-exec result, including its absent output and original errno.
        Object.assign(result, {
          error,
          status: null,
          signal: null,
          output: null,
          pid: 0,
          stdout: undefined,
          stderr: undefined,
        });
      }
    } catch {
      // A failed supervisor must fail closed; its output is not a checker verdict.
      if (!result.error)
        throw new Error(
          `judge supervisor failed (${result.status}): ${result.stderr}`,
        );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (
    timedOut ||
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
  ) {
    const error = new JudgeTimeout(child, timeoutMs);
    phaseHeartbeat("judge", "timeout", error.message);
    const target = process.env.RS_JUDGE_OUT ?? out;
    if (!target) {
      error.message +=
        "; no evidence directory: set RS_JUDGE_OUT to the run evidence directory";
      console.error(error.message);
      throw error;
    }
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, "judge-timeout.json"),
      `${JSON.stringify({ status: error.status, ...child, timeout_ms: timeoutMs })}\n`,
    );
    console.error(error.message);
    throw error;
  }
  return result;
}

/** Shared signature for subprocesses inside imported checker libraries. */
export function gateJudgeSpawnSync(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) {
  return judgeSpawnSync(
    command,
    args,
    options,
    {
      group: process.env.RS_JUDGE_GROUP ?? "gate7",
      view:
        process.env.RS_JUDGE_VIEW ?? process.env.RS_JUDGE_OUT ?? process.cwd(),
      checker: `${command} ${args.join(" ")}`,
    },
    process.env.RS_JUDGE_OUT,
    options.timeout ?? JUDGE_CHILD_TIMEOUT_MS,
  );
}
