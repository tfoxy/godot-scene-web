// One-shot verification tool, not a unit test: re-run the CURRENT analyzer over the traces a PREVIOUS
// run captured, and diff every field the previous run's report already carried.
//
// This is deterministic where a fresh A/B run is not. The question "did lifting the renderer-pid
// filter change any pre-existing metric?" cannot be answered by comparing two measured runs — they
// disagree by a few percent on every number anyway — but it IS answerable by feeding the same bytes
// through both analyzers and demanding an exact match.
//
//   node packages/perf-harness/test/reanalyze-before-after.mjs artifacts/perf/runs/<dir>

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { analyzeTrace } from "../src/analyze.ts";
import { readTraceEvents } from "../src/trace.ts";

// `resolve("")` is the CWD, not a falsy value, so a missing argument has to be caught BEFORE resolving
// it — otherwise this silently scans the CWD, finds no browser-render report, and "passes" having
// compared nothing.
const arg = process.argv[2];
if (!arg) {
  console.error("usage: reanalyze-before-after.mjs <run dir>");
  process.exit(2);
}
const dir = resolve(arg);

/** Fields the `cpu` / `gpu` work ADDED. Everything else must be byte-identical. */
const ADDED = new Set(["cpu", "gpu"]);
/** Fields the runner (not the analyzer) supplies, so they are not re-derivable here. */
const RUNNER_OWNED = new Set([
  "readyMs",
  "blockedMs",
  "longAnimationFrames",
  "longTaskCount",
  "layerCount",
  "presented",
]);

const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
let compared = 0;
let mismatched = 0;

for (const file of files.sort()) {
  const report = JSON.parse(await readFile(join(dir, file), "utf8"));
  if (report.profile !== "browser-render") {
    continue;
  }
  const mechanism = String(report.params.mechanism);
  for (const [index, before] of report.runs.entries()) {
    const tracePath = join(dir, "traces", `${mechanism}-r${index}.json.gz`);
    const events = await readTraceEvents(tracePath);
    const after = analyzeTrace(events, { windowMs: before.windowMs });
    for (const key of Object.keys(after)) {
      if (ADDED.has(key) || RUNNER_OWNED.has(key)) {
        continue;
      }
      compared++;
      const a = JSON.stringify(after[key]);
      const b = JSON.stringify(before[key]);
      if (a !== b) {
        mismatched++;
        console.log(`MISMATCH ${mechanism} r${index} .${key}`);
        console.log(`   before: ${b}`);
        console.log(`   after:  ${a}`);
      }
    }
    // And a positive control: the NEW blocks must actually be populated.
    if (!after.cpu || after.cpu.totalCpuMs <= 0) {
      console.log(`EMPTY cpu block on ${mechanism} r${index}`);
      mismatched++;
    }
  }
}

console.log(
  `\n${compared} pre-existing field readings compared, ${mismatched} mismatched`,
);

// Nothing compared is NOT a pass. A verification tool that green-lights on an empty input set is the
// exact failure mode this harness exists to prevent: "0 compared, 0 mismatched" reads like success to
// anyone skimming, while proving nothing at all. Point it at a run dir with no browser-render report
// (or no traces beside it) and you get this instead.
if (compared === 0) {
  console.error(
    `\nNOTHING COMPARED — ${dir} holds no browser-render report with per-run traces beside it.\n` +
      "This is a failure, not a pass: the analyzer was never exercised.",
  );
  process.exit(2);
}

process.exit(mismatched === 0 ? 0 : 1);
