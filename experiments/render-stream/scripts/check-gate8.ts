#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 8 checker CLI. Evaluates the checks of the groups that ran against the evidence
// run-gate8.sh wrote to --out, writes <out>/result.json (render-stream-gate8-report/1), prints
// one line per check and leg, and exits non-zero unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate8.ts --out <evidence dir>
//
// The checks live in lib/gate8-*-checks.ts (G8t: lib/gate8-tex-checks.ts, G8a:
// lib/gate8-adopt-checks.ts, G8h: lib/gate8-size-checks.ts), which
// scripts/test/self-test-gate8*.ts drive against fabricated evidence.

// GRT4b: node:crypto behind the decoders' hash seam (lib/node-hash.ts), before anything decodes.
import "./lib/node-hash";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type G8aExpected, runG8a } from "./lib/gate8-adopt-checks";
import { type G8hExpected, runG8h } from "./lib/gate8-size-checks";
import { type G8tExpected, runG8t } from "./lib/gate8-tex-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..");
const KNOWN_GROUPS = ["g8t", "g8a", "g8h"];

function parseArgs(argv: string[]): { out: string } {
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = argv[i + 1];
      i++;
    }
  }
  if (!out) throw new Error("check-gate8: --out <evidence dir> is required");
  return { out: resolve(out) };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const legsJson = JSON.parse(await readFile(join(out, "legs.json"), "utf8")) as {
    groups_run: string[];
  };
  const run = legsJson.groups_run.filter((g) => KNOWN_GROUPS.includes(g));
  const report: Record<string, unknown> = {
    schema: "render-stream-gate8-report/1",
    groups: { run, not_run: KNOWN_GROUPS.filter((g) => !run.includes(g)) },
  };
  const checks: { id: string; passed: boolean; status: string; criterion: string; detail?: string; gating?: boolean }[] = [];
  if (run.includes("g8t")) {
    const expected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-tex", "expected.json"), "utf8"),
    ) as G8tExpected;
    const g8t = await runG8t(out, expected);
    checks.push(...g8t.checks);
    report.g8t = {
      legs: g8t.legs,
      decode_cost: g8t.decode_cost,
      hitch: g8t.hitch,
      hardware_band: g8t.hardware_band,
      workers: g8t.workers,
    };
  }
  if (run.includes("g8a")) {
    const expected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-adopt", "expected.json"), "utf8"),
    ) as G8aExpected;
    const g8a = await runG8a(out, expected);
    checks.push(...g8a.checks);
    report.g8a = g8a.report;
  }
  if (run.includes("g8h")) {
    const expected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-size", "expected.json"), "utf8"),
    ) as G8hExpected;
    const g8h = await runG8h(out, expected);
    checks.push(...g8h.checks);
    report.g8h = g8h.report;
  }
  const gating = checks.filter((c) => c.gating !== false);
  report.gate_passed = gating.length > 0 && gating.every((c) => c.passed);
  report.checks = checks;
  await writeFile(join(out, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const c of checks) {
    const tag = c.status === "not-run" ? "NOT-RUN" : c.passed ? "PASS" : "FAIL";
    console.log(`[${tag}] ${c.id}: ${c.criterion}`);
    if (c.detail) console.log(`       ${c.detail}`);
  }
  const passed = gating.filter((c) => c.passed).length;
  console.log(
    `\ngate 8 (groups ${run.join(",") || "none"}): ${report.gate_passed ? "PASS" : "FAIL"} ${passed}/${gating.length} (${join(out, "result.json")})`,
  );
  if (!report.gate_passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
