#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 2 checker CLI. Evaluates the checks of the groups that ran against the evidence
// run-gate2.sh wrote to --out, writes <out>/result.json (render-stream-gate2-report/1), prints
// one line per check and per leg, and exits non-zero unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate2.ts --out <evidence dir>
//
// The checks live in lib/gate2-checks.ts, which scripts/test/self-test-gate2.ts drives against
// fabricated evidence trees.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGate2 } from "./lib/gate2-checks";
import type { Gate2Expected } from "./lib/gate2-expected";

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
  if (!out) throw new Error("check-gate2: --out <evidence dir> is required");
  return { out: resolve(out) };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const expected = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate2", "expected.json"),
      "utf8",
    ),
  ) as Gate2Expected;

  const report = await runGate2(out, { expected });
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
  for (const [leg, r] of Object.entries(report.resources ?? {})) {
    for (const s of r.host.by_shape) {
      console.log(
        `  ${leg} copy/hash ${s.shape} (${s.payload_bytes} B): copy median ${s.copy_ns?.median ?? "?"} ns, hash median ${s.hash_ns?.median ?? "?"} ns (n=${s.copy_ns?.n ?? 0})`,
      );
    }
  }
  const passed = report.checks.filter((c) => c.passed).length;
  console.log(
    `\ngate 2 (groups ${report.groups.run.join(",") || "none"}${report.groups.not_run.length > 0 ? `; not run: ${report.groups.not_run.join(",")}` : ""}): ${report.gate_passed ? "PASS" : "FAIL"} ${passed}/${report.checks.length} (${join(out, "result.json")})`,
  );
  if (!report.gate_passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
