#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 5 checker CLI. Evaluates the checks of the groups that ran against the evidence
// run-gate5.sh wrote to --out, writes <out>/result.json (render-stream-gate5-report/1), prints one
// line per check and per leg, the measured hook census, the freshness table and the
// reference-repeat budgets, and exits non-zero unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate5.ts --out <evidence dir>
//
// The checks live in lib/gate5-checks.ts, which scripts/test/self-test-gate5.ts drives with
// synthetic values.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGate5 } from "./lib/gate5-checks";
import type { Gate5Expected } from "./lib/gate5-expected";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..");

function parseArgs(argv: string[]): { out: string } {
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = argv[i + 1];
      i++;
    }
  }
  if (!out) throw new Error("check-gate5: --out <evidence dir> is required");
  return { out: resolve(out) };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const fixture = join(EXPERIMENT_DIR, "fixtures", "gate5");
  const expected = JSON.parse(
    await readFile(join(fixture, "expected.json"), "utf8"),
  ) as Gate5Expected;

  const report = await runGate5(out, { expected });
  await writeFile(
    join(out, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  for (const c of report.checks) {
    const tag = c.status === "not-run" ? "NOT-RUN" : c.passed ? "PASS" : "FAIL";
    console.log(`[${tag}] ${c.id}: ${c.criterion}`);
    if (c.detail) console.log(`       ${c.detail}`);
  }
  console.log("");
  for (const [leg, entry] of Object.entries(report.legs)) {
    const cls = entry.expected_class
      ? `${entry.result_class} (expected ${entry.expected_class})`
      : "support";
    console.log(`  ${leg}: ${cls}, exit ${entry.exit_code ?? "?"}`);
  }
  for (const [name, g] of Object.entries(report.geometry ?? {})) {
    console.log(
      `  hook census (${name}): ${Object.entries(g.hook_census)
        .map(([op, n]) => `${op.replace("canvas_item_add_", "")}=${n}`)
        .join(" ")}`,
    );
    console.log(
      `  pixel classes (${name}), step: exact/delta1/band/undecided: ${Object.entries(
        g.exactness,
      )
        .map(([k, r]) => `${k}:${r.exact}/${r.delta1}/${r.band}/${r.undecided}`)
        .join(" ")}`,
    );
  }
  for (const [name, table] of Object.entries(report.freshness ?? {}))
    console.log(
      `  fresh regions (${name}), step: ${Object.entries(table)
        .map(([k, r]) => `${k}:${r.join("+")}`)
        .join(" ")}`,
    );
  for (const [name, b] of Object.entries(report.budgets ?? {}))
    console.log(
      `  reference-repeat budget (${name}), region/class max/mismatched of pixels: ${b
        .filter(
          (x) =>
            x.class === "band" ||
            x.class === "undecided" ||
            x.mismatched_pixels > 0,
        )
        .map(
          (x) =>
            `${x.region}/${x.class} ${x.max_channel_delta}/${x.mismatched_pixels} of ${x.pixels}`,
        )
        .join(", ")}`,
    );
  const passed = report.checks.filter((c) => c.passed).length;
  console.log(
    `\ngate 5 (groups ${report.groups.run.join(",") || "none"}${report.groups.not_run.length > 0 ? `; not run: ${report.groups.not_run.join(",")}` : ""}): ${report.gate_passed ? "PASS" : "FAIL"} ${passed}/${report.checks.length} (${join(out, "result.json")})`,
  );
  if (!report.gate_passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
