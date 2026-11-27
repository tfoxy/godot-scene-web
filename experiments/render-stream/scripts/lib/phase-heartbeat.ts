import { appendFileSync } from "node:fs";

export function phaseHeartbeat(
  phase: string,
  event: string,
  name: string,
): void {
  const line = `render-stream phase ${new Date().toISOString()} ${phase} ${event} ${name}\n`;
  if (process.env.RS_PHASE_LOG) {
    try {
      appendFileSync(process.env.RS_PHASE_LOG, line);
    } catch (error) {
      console.error(`heartbeat: ${error}`);
    }
  }
}
