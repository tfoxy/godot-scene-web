import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { phaseHeartbeat } from "./phase-heartbeat";

let sequence = 0;

/** Persist starts before work begins, including synchronous child checkers that may be killed.
 * Keep diagnostics separate from result.json so timing cannot affect a gate's verdict. */
export async function timeJudge<T>(
  out: string,
  stage: string,
  detail: Record<string, string>,
  run: () => T | Promise<T>,
): Promise<T> {
  const id = `${process.pid}:${sequence++}`;
  const start = performance.now();
  const emit = (event: "start" | "end", extra = {}) => {
    phaseHeartbeat(`judge/${stage}`, event, JSON.stringify(detail));
    try {
      mkdirSync(out, { recursive: true });
      appendFileSync(
        join(out, "judge-timing.jsonl"),
        `${JSON.stringify({
          id,
          stage,
          detail,
          event,
          at: new Date().toISOString(),
          ...extra,
        })}\n`,
      );
    } catch (error) {
      console.error(`check-gate7: could not record judge timing: ${error}`);
    }
  };
  emit("start");
  let outcome = "error";
  try {
    const result = await run();
    outcome = "returned";
    return result;
  } finally {
    emit("end", { elapsed_ms: performance.now() - start, outcome });
  }
}
