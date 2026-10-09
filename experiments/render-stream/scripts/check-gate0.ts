#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 0 checker CLI. Classifies every leg and evaluates every check against the evidence
// run-gate0.sh wrote to --out, writes <out>/result.json (render-stream-gate0-report/1), prints one
// line per check and per leg, and exits non-zero unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate0.ts --out <evidence dir>
//
// The checks and classifyLeg live in lib/gate0-checks.ts, which scripts/test/self-test-gate0.ts
// drives against fabricated evidence trees.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Gate0Expected, runGate0 } from "./lib/gate0-checks";

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
  if (!out) throw new Error("check-gate0: --out <evidence dir> is required");
  return { out: resolve(out) };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const fixtureProjectDir = join(EXPERIMENT_DIR, "fixtures", "gate0");
  const expected = JSON.parse(
    await readFile(join(fixtureProjectDir, "expected.json"), "utf8"),
  ) as Gate0Expected;

  const report = await runGate0(out, {
    expected,
    fixtureProjectDir,
    receiverProjectDir: join(EXPERIMENT_DIR, "receiver"),
  });
  await writeFile(
    join(out, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  for (const c of report.checks) {
    console.log(`[${c.passed ? "PASS" : "FAIL"}] ${c.id}: ${c.criterion}`);
    if (c.detail) console.log(`       ${c.detail}`);
  }
  console.log("");
  for (const [leg, entry] of Object.entries(report.legs)) {
    const cls = entry.expected_class
      ? `${entry.result_class} (expected ${entry.expected_class})`
      : "support";
    console.log(`  ${leg}: ${cls}, exit ${entry.exit_code ?? "?"}`);
  }
  console.log(
    `\ngate 0: ${report.gate_passed ? "PASS" : "FAIL"} (${join(out, "result.json")})`,
  );
  if (!report.gate_passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
