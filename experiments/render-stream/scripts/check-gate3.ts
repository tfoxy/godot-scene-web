#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 3 checker CLI. Evaluates the checks of the groups that ran against the evidence
// run-gate3.sh wrote to --out, writes <out>/result.json (render-stream-gate3-report/1), prints
// one line per check and per leg, and exits non-zero unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate3.ts --out <evidence dir>
//
// The checks live in lib/gate3-checks.ts, which scripts/test/self-test-gate3.ts drives against
// fabricated evidence trees.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runGate3 } from "./lib/gate3-checks";
import { formatClip, type Gate3Expected } from "./lib/gate3-expected";
import type { Gate3xExpected } from "./lib/gate3x-expected";

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
  if (!out) throw new Error("check-gate3: --out <evidence dir> is required");
  return { out: resolve(out) };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const expected = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate3", "expected.json"),
      "utf8",
    ),
  ) as Gate3Expected;

  const xform = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate3-xform", "expected.json"),
      "utf8",
    ),
  ) as Gate3xExpected;

  const report = await runGate3(out, {
    expected,
    xform,
    receiverProjectDir: join(EXPERIMENT_DIR, "receiver"),
    fixtureProjectDir: join(EXPERIMENT_DIR, "fixtures", "gate3"),
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
  for (const [fixture, steps] of Object.entries(report.clip_rects ?? {})) {
    console.log(`  clip_rects (${fixture}, clip-derive over the full sink):`);
    for (const [step, owners] of Object.entries(steps))
      console.log(
        `    step ${step}: ${Object.entries(owners)
          .map(
            ([o, v]) => `${o} ${formatClip(v === "unknown" ? undefined : v)}`,
          )
          .join("  ")}`,
      );
  }
  for (const [leg, steps] of Object.entries(report.probes ?? {})) {
    const t = Object.values(steps);
    console.log(
      `  probes ${leg}: ${t.reduce((n, s) => n + s.total, 0)} total, ${t.reduce((n, s) => n + s.decisive, 0)} decisive pairs, ${t.reduce((n, s) => n + s.failed.length, 0)} failed`,
    );
  }
  if (report.band)
    console.log(
      `  band (gate3-xform): ${report.band.band_pixels.join("/")} px per step; reference vs repeat differ in ${report.band.repeat_band_diffs.join("/")}; budget ${report.band.budget.pixels} px, delta ${report.band.budget.max_channel_delta}`,
    );
  for (const p of report.semantic_probes ?? [])
    console.log(
      `  semantic ${p.name} (${p.xy.join(",")}): reference ${p.measured?.join(",") ?? "<none>"}`,
    );
  const passed = report.checks.filter((c) => c.passed).length;
  console.log(
    `\ngate 3 (groups ${report.groups.run.join(",") || "none"}${report.groups.not_run.length > 0 ? `; not run: ${report.groups.not_run.join(",")}` : ""}): ${report.gate_passed ? "PASS" : "FAIL"} ${passed}/${report.checks.length} (${join(out, "result.json")})`,
  );
  if (!report.gate_passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
