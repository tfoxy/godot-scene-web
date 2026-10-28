#!/usr/bin/env -S pnpm exec tsx --conditions=development
// hc1-checks.ts -- judges run-hc1.sh's legs (HC1, results/p3/hc1.md; protocol/host-cost-design.md
// D5, D6). Writes <out>/result.json ({schema, checks:[{id, passed, detail}]}); exit 1 on a failure.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeRecording } from "./gate0-checks";
import { stateKey } from "./gate1-live-checks";

const out = process.argv[2];
if (!out) throw new Error("hc1-checks: pass the run-hc1.sh output directory");

interface Check {
  id: string;
  passed: boolean;
  detail: string;
}
const checks: Check[] = [];
const add = (id: string, problems: string[], ok: string): void => {
  checks.push({ id, passed: problems.length === 0, detail: problems.length === 0 ? ok : problems.join("; ") });
};
const json = (path: string): any => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
const lines = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "") : [];
const counters = (leg: string) => json(join(out, leg, "evidence", "counters.json"));
const perf = (leg: string) => json(join(out, leg, "evidence", "perf.json"));
const viewer = (leg: string) => json(join(out, leg, "viewer", "null-receiver.json"));
const snapshots = (leg: string): number => perf(leg)?.histograms?.snapshot_us?.count ?? -1;
const tapTransactions = (leg: string) => {
  const dir = join(out, leg, "tap");
  const file = existsSync(dir) ? readdirSync(dir).find((f) => /\.rs\d+$/.test(f)) : undefined;
  if (!file) return [];
  return summarizeRecording(join(dir, file), new Uint8Array(readFileSync(join(dir, file)))).transactions;
};
const sinkTransactions = (leg: string) => {
  const file = join(out, leg, "recording-full.rs8");
  return existsSync(file) ? summarizeRecording(file, new Uint8Array(readFileSync(file))).transactions : [];
};

// hook-log-off-formats-nothing: the counter is the number of lines the log formatted since arm.
{
  const problems: string[] = [];
  const off = counters("late-static-off")?.hook_log_lines_formatted;
  const on = counters("late-static")?.hook_log_lines_formatted;
  const fileLines = lines(join(out, "late-static", "evidence", "resources.jsonl")).length;
  if (off !== 0) problems.push(`hook log off formatted ${off} lines (want 0)`);
  if (existsSync(join(out, "late-static-off", "evidence", "resources.jsonl")))
    problems.push("hook log off still opened resources.jsonl");
  if (!(typeof on === "number" && on > 0)) problems.push(`hook log on formatted ${on} lines (want > 0)`);
  if (on !== fileLines) problems.push(`hook log on: ${on} lines formatted but resources.jsonl has ${fileLines}`);
  add("hook-log-off-formats-nothing", problems, `off: 0 lines formatted; on: ${on} formatted = ${fileLines} in resources.jsonl`);
}

// no-snapshot-without-viewer: the idle leg's listener never has a viewer; the late legs only
// snapshot from the viewer's first callback on.
{
  const problems: string[] = [];
  const idleFrames = counters("idle")?.frames_armed ?? 0;
  const idle = snapshots("idle");
  if (idle !== 0) problems.push(`idle listener took ${idle} snapshots (want 0)`);
  if (idleFrames < 60) problems.push(`idle leg armed only ${idleFrames} frames`);
  for (const leg of ["late-static", "late-static-off"]) {
    const frames = counters(leg)?.frames_armed ?? 0;
    const first = viewer(leg)?.first_tx?.frame ?? 0;
    const n = snapshots(leg);
    if (!(first > 60)) problems.push(`${leg}: the viewer's first transaction is at frame ${first} (not late)`);
    // Snapshots are taken from the viewer's first callback (frame <= first) to the end, plus slack.
    else if (n > frames - first + 3) problems.push(`${leg}: ${n} snapshots, ${frames - first + 3} allowed (${frames} frames, join at ${first})`);
  }
  add("no-snapshot-without-viewer", problems, `idle: 0 snapshots over ${idleFrames} frames; late legs snapshot only from the join`);
}

// late-join-served: the first transaction of a late viewer equals the file sink's full of the same
// state, and every payload GET it makes answers 200 with a body that hashes to its name.
function lateJoin(id: string, leg: string, sinkLeg: string, sameFrame: boolean, expectFail: boolean): void {
  const problems: string[] = [];
  const v = viewer(leg);
  const first = v?.first_tx;
  if (!first) problems.push(`${leg}: the viewer received no transaction`);
  else {
    const tap = tapTransactions(leg)[0];
    const sink = sinkTransactions(sinkLeg);
    const full = sameFrame ? sink.find((t) => t.meta.frame === first.frame) : sink[sink.length - 1];
    if (!tap) problems.push(`${leg}: no tapped transaction`);
    else if (tap.meta.seq !== first.seq) problems.push(`${leg}: tap seq ${tap.meta.seq} != viewer seq ${first.seq}`);
    if (!full) problems.push(`${sinkLeg}: no full recording at frame ${first.frame}`);
    if (tap && full && stateKey(tap) !== stateKey(full)) problems.push(`${leg}: the first transaction (frame ${first.frame}) differs from the sink's full`);
    if (first.hashes < 10) problems.push(`${leg}: only ${first.hashes} payloads to fetch`);
    const bad = Object.entries(first.statuses as Record<string, number>).filter(([k]) => k !== "200");
    if (bad.length > 0) problems.push(`${leg}: GET statuses ${JSON.stringify(first.statuses)}`);
    if (first.bad_sha > 0) problems.push(`${leg}: ${first.bad_sha} bodies do not hash to their name`);
  }
  if (expectFail) {
    add(id, problems.length > 0 ? [] : [`${leg}: the sabotage was not caught`], `caught: ${problems[0] ?? ""}`);
  } else {
    add(id, problems, `${leg}: first tx frame ${first?.frame} equals the sink's full; ${first?.hashes} GETs, statuses ${JSON.stringify(first?.statuses)}`);
  }
}
lateJoin("late-join-served-static", "late-static", "ref-static", false, false);
lateJoin("late-join-served-churn", "late-churn", "late-churn", true, false);
lateJoin("late-join-served-hook-log-off", "late-static-off", "ref-static", false, false);
lateJoin("sabotage-pin-late-caught", "sabotage-pin-late", "ref-static", false, true);

// The hook-log-on legs' serve events: nothing is pinned before the viewer's first callback.
{
  const problems: string[] = [];
  const first = viewer("late-static")?.first_tx?.frame ?? 0;
  const pins = lines(join(out, "late-static", "evidence", "resources.jsonl"))
    .map((l) => JSON.parse(l))
    .filter((l) => l.op === "pin");
  if (pins.length === 0) problems.push("no pin events at all");
  const early = pins.filter((p) => p.frame < first - 1);
  if (early.length > 0) problems.push(`${early.length} pins before the join (frame ${first}), first at ${early[0].frame}`);
  add("no-pin-without-viewer", problems, `${pins.length} pins, all from the join (frame ${first}) on`);
}

writeFileSync(join(out, "result.json"), `${JSON.stringify({ schema: "render-stream-hc1-result/1", checks }, null, 2)}\n`);
for (const c of checks) console.log(`hc1: ${c.passed ? "pass" : "FAIL"} ${c.id}: ${c.detail}`);
process.exit(checks.every((c) => c.passed) ? 0 : 1);
