// Which of a gate's checks judge its receiver legs (G7t, lib/gate7-gsw-g45.ts)? Builds a view of a
// passing source run with every listed receiver leg replaced by an empty directory, runs the
// gate's own checker on it, and prints the checks whose verdict changed: exactly the checks a gsw
// view can change, which GSW_RECEIVER_CHECKS keeps `@gsw` (or lists as not applicable).
//
//   tsx --conditions=development experiments/render-stream/scripts/test/probe-receiver-checks.ts \
//     gate4|gate5 <absolute source run dir> <receiver leg>...
import { mkdirSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGate4Report } from "../check-gate4";
import { buildGate5Report } from "../check-gate5";
import { buildView } from "../lib/gate7-gsw";

const [gate, source, ...legs] = process.argv.slice(2);
const empty = mkdtempSync(join(tmpdir(), "probe-empty-"));
mkdirSync(join(empty, "x"));
const view = mkdtempSync(join(tmpdir(), "probe-view-"));
await buildView(
  source,
  new Map(legs.map((l) => [l, join(empty, "x")])),
  join(view, "v"),
);
const build = gate === "gate4" ? buildGate4Report : buildGate5Report;
const report = (await build(join(view, "v"))) as unknown as {
  checks: { id: string; passed: boolean }[];
};
const base = JSON.parse(
  await readFile(join(source, "result.json"), "utf8"),
) as {
  checks: { id: string; passed: boolean }[];
};
const before = new Map(base.checks.map((c) => [c.id, c.passed]));
for (const c of report.checks)
  if (before.get(c.id) !== c.passed)
    console.log(`CHANGED ${c.id} ${before.get(c.id)} -> ${c.passed}`);
