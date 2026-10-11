#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 6 checker CLI. Evaluates the checks of the groups that ran against the evidence
// run-gate6.sh wrote to --out, writes <out>/result.json (render-stream-gate6-report/1), prints one
// line per check and per leg, the receivers' mismatch tables, the freshness table, the census and
// the reference-repeat budgets, and exits non-zero unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate6.ts --out <evidence dir>
//
// Each group's checks live in its own lib (g6a: lib/gate6a-checks.ts, fixtures/gate6-scene on
// render-stream/5; g6h: lib/gate6h-checks.ts, fixtures/gate6-hd), which its self-test drives with
// synthetic values. A landed group that was not
// run is reported `not-run` and fails the gate.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readJson } from "./lib/gate-minus1-checks";
import type { Gate6Expected } from "./lib/gate6-expected";
import {
  type G6aLegEntry,
  type Gate6Check,
  type Gate6Checkpoint,
  type RegionBudget6,
  runGate6a,
} from "./lib/gate6a-checks";
import {
  type G6hLegEntry,
  type Gate6HdExpected,
  runGate6h,
} from "./lib/gate6h-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..");

/** Every group of protocol/gate6-design.md Q7b, and those whose increment landed. */
export const ALL_GROUPS = [
  "g6a",
  "g6h",
  "g6b",
  "g6l",
  "g6s",
  "g6c",
  "g6p",
] as const;
export const LANDED_GROUPS: readonly string[] = ["g6a", "g6h"];

export interface Gate6Report {
  schema: "render-stream-gate6-report/1";
  generated_at: string;
  binary: { path: string | null; sha256: string | null };
  gate_passed: boolean;
  groups: { run: string[]; landed: string[]; not_run: string[] };
  legs: Record<string, G6aLegEntry | G6hLegEntry>;
  checks: Gate6Check[];
  checkpoints: Gate6Checkpoint[];
  /** per leg pair: per region and pixel class, every shot (reference-repeat: Q6g's budget) */
  budgets: Record<string, RegionBudget6[]>;
  /** per leg: per step, the regions whose pixels changed */
  freshness: Record<string, Record<string, string[]>>;
  /** per receiver leg: per shot, the regions (outside HU/RF) that differ from the reference */
  mismatch_tables: Record<string, Record<string, string[]>>;
  /** per capture: the hook-log census summary */
  census: Record<string, string>;
  /** filled by later increments (G6c, G6s) */
  rates: Record<string, unknown>;
  stability: Record<string, unknown>;
}

function parseArgs(argv: string[]): { out: string } {
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = argv[i + 1];
      i++;
    }
  }
  if (!out) throw new Error("check-gate6: --out <evidence dir> is required");
  return { out: resolve(out) };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const legsJson = await readJson<{ groups_run?: string[] }>(
    join(out, "legs.json"),
  );
  const binary = await readJson<{ path?: string; sha256?: string }>(
    join(out, "binary.json"),
  );
  const run = legsJson?.groups_run ?? [];
  const report: Gate6Report = {
    schema: "render-stream-gate6-report/1",
    generated_at: new Date().toISOString(),
    binary: { path: binary?.path ?? null, sha256: binary?.sha256 ?? null },
    gate_passed: false,
    groups: {
      run,
      landed: [...LANDED_GROUPS],
      not_run: LANDED_GROUPS.filter((g) => !run.includes(g)),
    },
    legs: {},
    checks: [],
    checkpoints: [],
    budgets: {},
    freshness: {},
    mismatch_tables: {},
    census: {},
    rates: {},
    stability: {},
  };

  if (run.includes("g6a")) {
    const expected = JSON.parse(
      await readFile(
        join(EXPERIMENT_DIR, "fixtures", "gate6-scene", "expected.json"),
        "utf8",
      ),
    ) as Gate6Expected;
    const r = await runGate6a(out, expected);
    report.checks.push(...r.checks);
    Object.assign(report.legs, r.legs);
    report.checkpoints.push(...r.checkpoints);
    Object.assign(report.budgets, r.budgets);
    Object.assign(report.freshness, r.freshness);
    Object.assign(report.mismatch_tables, r.mismatch_tables);
    Object.assign(report.census, r.census);
  }
  if (run.includes("g6h")) {
    const expected = JSON.parse(
      await readFile(
        join(EXPERIMENT_DIR, "fixtures", "gate6-hd", "expected.json"),
        "utf8",
      ),
    ) as Gate6HdExpected;
    const r = await runGate6h(out, expected);
    report.checks.push(...r.checks);
    Object.assign(report.legs, r.legs);
    report.checkpoints.push(...r.checkpoints);
    Object.assign(report.budgets, r.budgets);
    Object.assign(report.freshness, r.freshness);
    Object.assign(report.mismatch_tables, r.mismatch_tables);
    Object.assign(report.census, r.census);
  }
  for (const group of report.groups.not_run)
    report.checks.push({
      id: `group-${group}`,
      criterion: `leg group ${group} ran`,
      passed: false,
      status: "not-run",
      detail: `run-gate6.sh --legs did not include ${group}`,
      evidence: [],
    });
  report.gate_passed =
    run.length > 0 && report.checks.every((c) => c.status === "pass");
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
  for (const [leg, entry] of Object.entries(report.legs))
    console.log(
      `  ${leg}: ${entry.result_class} (expected ${entry.expected_class})${entry.pixel_verdict ? `, pixels ${entry.pixel_verdict} (expected ${entry.expected_pixel_verdict})` : ""}, exit ${entry.exit_code ?? "?"}`,
    );
  for (const [leg, table] of Object.entries(report.mismatch_tables)) {
    const cells = Object.entries(table).filter(([, v]) => v.length > 0);
    if (cells.length > 0)
      console.log(
        `  mismatching regions (${leg}): ${cells.map(([k, v]) => `${k}:${v.join("+")}`).join(" ")}`,
      );
  }
  for (const [name, table] of Object.entries(report.freshness))
    console.log(
      `  fresh regions (${name}), step: ${Object.entries(table)
        .map(([k, r]) => `${k}:${r.join("+")}`)
        .join(" ")}`,
    );
  for (const [name, c] of Object.entries(report.census))
    console.log(`  census (${name}): ${c}`);
  for (const [name, b] of Object.entries(report.budgets))
    console.log(
      `  ${name} budget: max delta ${Math.max(0, ...b.map((x) => x.max_channel_delta))} over ${b.reduce((n, x) => n + x.pixels, 0)} pixel-shots`,
    );
  const passed = report.checks.filter((c) => c.passed).length;
  console.log(
    `\ngate 6 (groups ${run.join(",") || "none"}${report.groups.not_run.length > 0 ? `; not run: ${report.groups.not_run.join(",")}` : ""}): ${report.gate_passed ? "PASS" : "FAIL"} ${passed}/${report.checks.length} (${join(out, "result.json")})`,
  );
  if (!report.gate_passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
