#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 4 checker CLI. Evaluates the checks of the groups that ran against the evidence
// run-gate4.sh wrote to --out, writes <out>/result.json (render-stream-gate4-report/1), prints
// one line per check and per leg, the measured census and the atlas parity table, and exits
// non-zero unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate4.ts --out <evidence dir>
//
// The checks live in lib/gate4-checks.ts, which scripts/test/self-test-gate4.ts drives with
// synthetic values.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type FontLockEntry, runGate4 } from "./lib/gate4-checks";
import type { Gate4Expected } from "./lib/gate4-expected";

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
  if (!out) throw new Error("check-gate4: --out <evidence dir> is required");
  return { out: resolve(out) };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const fixture = join(EXPERIMENT_DIR, "fixtures", "gate4");
  const expected = JSON.parse(
    await readFile(join(fixture, "expected.json"), "utf8"),
  ) as Gate4Expected;
  const lock = JSON.parse(
    await readFile(join(fixture, "fonts.lock.json"), "utf8"),
  ) as FontLockEntry[];

  const report = await runGate4(out, {
    expected,
    lock,
    receiverDir: join(EXPERIMENT_DIR, "receiver"),
    fixtureDir: fixture,
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
  for (const [fixtureName, steps] of Object.entries(report.text ?? {})) {
    console.log(
      `  text (${fixtureName}): step: glyph commands; pages wire id@version [hook versions]; bytes published; copy/hash us`,
    );
    for (const [step, t] of Object.entries(steps))
      console.log(
        `    ${step}: ${t.glyph_commands}; ${t.pages.map((p) => `${p.font_key}@${p.size}=${p.wire_id}@v${p.wire_version}[${p.hook_versions.join(",")}]`).join(" ")}; ${t.atlas_bytes_published} B; ${(t.copy_ns / 1000).toFixed(0)}/${(t.hash_ns / 1000).toFixed(0)}`,
      );
  }
  for (const [fixtureName, steps] of Object.entries(report.parity ?? {})) {
    console.log(
      `  atlas parity (${fixtureName}): step: page=wire id@version sha256`,
    );
    for (const [step, cells] of Object.entries(steps))
      console.log(
        `    ${step}: ${cells.map((c) => `${c.page}=${c.wire_id ?? "?"}@v${c.wire_version ?? "?"} ${c.oracle_sha256.slice(0, 10)}${c.ok ? "" : " FAIL"}`).join("  ")}`,
      );
  }
  for (const [fixtureName, b] of Object.entries(report.budgets ?? {}))
    console.log(
      `  reference-repeat budget (${fixtureName}): ${b.map((x) => `${x.region} ${x.max_channel_delta}/${x.mismatched_pixels}px`).join(", ")}`,
    );
  const passed = report.checks.filter((c) => c.passed).length;
  console.log(
    `\ngate 4 (groups ${report.groups.run.join(",") || "none"}${report.groups.not_run.length > 0 ? `; not run: ${report.groups.not_run.join(",")}` : ""}): ${report.gate_passed ? "PASS" : "FAIL"} ${passed}/${report.checks.length} (${join(out, "result.json")})`,
  );
  if (!report.gate_passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
