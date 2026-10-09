#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 1 checker CLI. Classifies every leg of the groups that ran and evaluates their checks
// against the evidence run-gate1.sh wrote to --out, writes <out>/result.json
// (render-stream-gate1-report/1), prints one line per check and per leg, and exits non-zero
// unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate1.ts --out <evidence dir>
//
// The checks and classifyGate1 live in lib/gate1-checks.ts, which scripts/test/self-test-gate1.ts
// drives against fabricated evidence trees.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGate1 } from "./lib/gate1-checks";
import type { Gate1Expected } from "./lib/gate1-expected";

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
  if (!out) throw new Error("check-gate1: --out <evidence dir> is required");
  return { out: resolve(out) };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const fixtureProjectDir = join(EXPERIMENT_DIR, "fixtures", "gate1");
  const expected = JSON.parse(
    await readFile(join(fixtureProjectDir, "expected.json"), "utf8"),
  ) as Gate1Expected;

  const report = await runGate1(out, {
    expected,
    fixtureProjectDir,
    receiverProjectDir: join(EXPERIMENT_DIR, "receiver"),
  });
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
  const passed = report.checks.filter((c) => c.passed).length;
  console.log(
    `\ngate 1 (groups ${report.groups.run.join(",") || "none"}${report.groups.not_run.length > 0 ? `; not run: ${report.groups.not_run.join(",")}` : ""}): ${report.gate_passed ? "PASS" : "FAIL"} ${passed}/${report.checks.length} (${join(out, "result.json")})`,
  );
  if (!report.gate_passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
