#!/usr/bin/env node
/**
 * Shared Rust phase-mark verifier used by downstream CPU evidence checks.
 * Keep this standalone function at this path: consumers extract its AST so they
 * can verify trace joins without starting the optional profiler campaign.
 */
export function rustMarkHealth(trace, startMarker, endMarker, events) {
  const ids = new Set(
    events.map(
      (event) =>
        `${event.runId}:${event.rendererInstanceId}:${event.operationId}`,
    ),
  );
  const open = new Map();
  const phases = new Set();
  let count = 0,
    foreign = 0,
    unjoined = 0,
    unbalanced = 0;
  for (const event of [...trace].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    if (event.name !== "TimeStamp") continue;
    const message = event.args?.data?.message;
    if (typeof message !== "string" || !message.startsWith("canvas-profile/1:"))
      continue;
    let mark;
    try {
      mark = JSON.parse(message.slice("canvas-profile/1:".length));
    } catch {
      unjoined++;
      continue;
    }
    const tuple = `${mark.runId}:${mark.rendererInstanceId}:${mark.operationId}`;
    if (!ids.has(tuple)) {
      foreign++;
      continue;
    }
    count++;
    if (
      !Number.isInteger(mark.operationId) ||
      mark.operationId < 1 ||
      !/^rust\.[a-z.-]+$/.test(mark.phase) ||
      !["start", "end"].includes(mark.edge) ||
      !startMarker ||
      !endMarker ||
      event.pid !== startMarker.pid ||
      event.tid !== startMarker.tid ||
      !Number.isFinite(event.ts) ||
      event.ts < startMarker.ts ||
      event.ts > endMarker.ts
    ) {
      unjoined++;
      continue;
    }
    const key = tuple;
    phases.add(mark.phase.slice(5));
    const stack = open.get(key) ?? [];
    if (mark.edge === "start") { stack.push({ phase: mark.phase, ts: event.ts }); open.set(key, stack); }
    else if (stack.at(-1)?.phase !== mark.phase || event.ts < stack.at(-1).ts) unbalanced++;
    else { stack.pop(); if (!stack.length) open.delete(key); }
  }
  unbalanced += [...open.values()].reduce((n, v) => n + v.length, 0);
  return { count, foreign, unjoined, unbalanced, phases: [...phases].sort() };
}
