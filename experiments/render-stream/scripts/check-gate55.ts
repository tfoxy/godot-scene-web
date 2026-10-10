#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 5.5 checker CLI. Evaluates the checks of the groups that ran against the evidence
// run-gate55.sh wrote to --out, writes <out>/result.json (render-stream-gate55-report/1), prints one
// line per check and per leg, the measured material counters, the shader hashes, the freshness
// table and the reference-repeat budgets, and exits non-zero unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate55.ts --out <evidence dir>
//
// Each group's checks live in its own lib (g55c: lib/gate55c-checks.ts), which its self-test
// drives with synthetic values. A group that was not run is reported `not-run` and fails the gate.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readJson } from "./lib/gate-minus1-checks";
import type {
  Gate5Check,
  Gate5Checkpoint,
  RegionBudget5,
} from "./lib/gate5-checks";
import {
  type Gate55LegEntry,
  type Gate55ShaderExpected,
  runGate55c,
} from "./lib/gate55c-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..");

/** Every group of protocol/gate5_5-design.md "Increments", and those whose increment landed. */
export const ALL_GROUPS = ["g55b", "g55c", "g55d", "g55e", "g55f"] as const;
export const LANDED_GROUPS: readonly string[] = ["g55c"];

export interface Gate55Report {
  schema: "render-stream-gate55-report/1";
  generated_at: string;
  binary: { path: string | null; sha256: string | null };
  gate_passed: boolean;
  groups: { run: string[]; landed: string[]; not_run: string[] };
  legs: Record<string, Gate55LegEntry>;
  checks: Gate5Check[];
  checkpoints: Gate5Checkpoint[];
  /** per fixture: material counters, shader hashes, content versions (G55e adds bytes and costs) */
  materials: Record<string, unknown>;
  /** per fixture: reference vs reference-repeat per region and pixel class, every shot */
  budgets: Record<string, RegionBudget5[]>;
  /** per fixture: per step, the regions whose reference pixels changed */
  freshness: Record<string, Record<string, string[]>>;
}

function parseArgs(argv: string[]): { out: string } {
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = argv[i + 1];
      i++;
    }
  }
  if (!out) throw new Error("check-gate55: --out <evidence dir> is required");
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
  const report: Gate55Report = {
    schema: "render-stream-gate55-report/1",
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
    materials: {},
    budgets: {},
    freshness: {},
  };

  if (run.includes("g55c")) {
    const expected = JSON.parse(
      await readFile(
        join(EXPERIMENT_DIR, "fixtures", "gate55-shader", "expected.json"),
        "utf8",
      ),
    ) as Gate55ShaderExpected;
    const r = await runGate55c(out, expected);
    report.checks.push(...r.checks);
    Object.assign(report.legs, r.legs);
    report.checkpoints.push(...r.checkpoints);
    report.materials[expected.fixture] = r.materials;
    report.budgets[expected.fixture] = r.budgets;
    report.freshness[expected.fixture] = r.freshness;
  }
  for (const group of report.groups.not_run)
    report.checks.push({
      id: `group-${group}`,
      criterion: `leg group ${group} ran`,
      passed: false,
      status: "not-run",
      detail: `run-gate55.sh --legs did not include ${group}`,
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
  for (const [leg, entry] of Object.entries(report.legs)) {
    const cls = entry.expected_class
      ? `${entry.result_class} (expected ${entry.expected_class})`
      : "support";
    console.log(`  ${leg}: ${cls}, exit ${entry.exit_code ?? "?"}`);
  }
  for (const [name, m] of Object.entries(report.materials)) {
    const v = m as {
      counters?: Record<string, number>;
      shader_hashes?: Record<string, Record<string, string>>;
    };
    if (v.counters)
      console.log(
        `  material counters (${name}): ${Object.entries(v.counters)
          .map(([op, n]) => `${op}=${n}`)
          .join(" ")}`,
      );
    if (v.shader_hashes)
      console.log(
        `  shader hashes (${name}), step: ${Object.entries(v.shader_hashes)
          .map(
            ([k, row]) =>
              `${k}:${Object.entries(row)
                .map(([s, h]) => `${s}=${h.slice(0, 8)}`)
                .join(",")}`,
          )
          .join(" ")}`,
      );
  }
  for (const [name, table] of Object.entries(report.freshness))
    console.log(
      `  fresh regions (${name}), step: ${Object.entries(table)
        .map(([k, r]) => `${k}:${r.join("+")}`)
        .join(" ")}`,
    );
  for (const [name, b] of Object.entries(report.budgets))
    console.log(
      `  reference-repeat budget (${name}), max delta over ${b.reduce((n, x) => n + x.pixels, 0)} pixel-shots: ${Math.max(0, ...b.map((x) => x.max_channel_delta))}`,
    );
  const passed = report.checks.filter((c) => c.passed).length;
  console.log(
    `\ngate 5.5 (groups ${run.join(",") || "none"}${report.groups.not_run.length > 0 ? `; not run: ${report.groups.not_run.join(",")}` : ""}): ${report.gate_passed ? "PASS" : "FAIL"} ${passed}/${report.checks.length} (${join(out, "result.json")})`,
  );
  if (!report.gate_passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
