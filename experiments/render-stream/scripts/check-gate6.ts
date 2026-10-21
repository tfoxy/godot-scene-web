#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 6 checker CLI. Evaluates the checks of the groups that ran against the evidence
// run-gate6.sh wrote to --out, writes <out>/result.json (render-stream-gate6-report/1), prints one
// line per check and per leg, the receivers' mismatch tables, the freshness table, the census and
// the reference-repeat budgets, and exits non-zero unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate6.ts --out <evidence dir>
//
// Each group's checks live in its own lib (g6a: lib/gate6a-checks.ts, fixtures/gate6-scene; g6h:
// lib/gate6h-checks.ts, fixtures/gate6-hd; g6b: lib/gate6b-checks.ts, the render-stream/6 switch's
// presentation, canvas-layer, snap and hazard legs over both fixtures), which its self-test drives
// with synthetic values. Every group speaks render-stream/6 since G6b. A landed group that was not
// run is reported `not-run` and fails the gate.

// GRT4b: node:crypto behind the decoders' hash seam (lib/node-hash.ts), before anything decodes.
import "./lib/node-hash";
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
import { type G6bLegEntry, runGate6b } from "./lib/gate6b-checks";
import {
  type G6cLegEntry,
  type G6cRateRow,
  runGate6c,
} from "./lib/gate6c-checks";
import {
  type G6hLegEntry,
  type Gate6HdExpected,
  runGate6h,
} from "./lib/gate6h-checks";
import {
  type G6lLegEntry,
  type G6lTiming,
  runGate6l,
} from "./lib/gate6l-checks";
import { type G6pLegEntry, runGate6p } from "./lib/gate6p-checks";
import { type G6sLegEntry, runGate6s } from "./lib/gate6s-checks";
import { runGate6z, verifyManifestEvidence } from "./lib/gate6z-checks";
import { buildManifest } from "./make-features";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..");

/** Every group of protocol/gate6-design.md Q7b, and those whose increment landed. g6z (Q8) runs
 * last: it has no capture of its own, only checks against the groups already run. */
export const ALL_GROUPS = [
  "g6a",
  "g6h",
  "g6b",
  "g6l",
  "g6s",
  "g6c",
  "g6p",
  "g6z",
] as const;
/** g6p is deliberately excluded (its ~80-minute matrix is not part of the default run, memory
 * gate6p-default-vs-landed-groups); g6z IS included, since run-gate6.sh's DEFAULT_GROUPS now runs
 * it by default (no capture of its own, cheap to run alongside the other six). */
export const LANDED_GROUPS: readonly string[] = [
  "g6a",
  "g6h",
  "g6l",
  "g6b",
  "g6s",
  "g6c",
  "g6z",
];

export interface Gate6Report {
  schema: "render-stream-gate6-report/1";
  generated_at: string;
  binary: { path: string | null; sha256: string | null };
  gate_passed: boolean;
  groups: { run: string[]; landed: string[]; not_run: string[] };
  legs: Record<
    string,
    | G6aLegEntry
    | G6hLegEntry
    | G6lLegEntry
    | G6bLegEntry
    | G6sLegEntry
    | G6cLegEntry
    | G6pLegEntry
  >;
  checks: Gate6Check[];
  checkpoints: Gate6Checkpoint[];
  /** per leg pair: per region and pixel class, every shot (reference-repeat: Q6g's budget) */
  budgets: Record<string, RegionBudget6[]>;
  /** per leg: per step, the regions whose pixels changed */
  freshness: Record<string, Record<string, string[]>>;
  /** per receiver leg: per shot, the regions (outside RF) that differ from the reference */
  mismatch_tables: Record<string, Record<string, string[]>>;
  /** per capture: the hook-log census summary */
  census: Record<string, string>;
  /** g6l (G6l): per live leg, credit RTT, staleness, fetch latency, stall and reconnect timing */
  live: Record<string, G6lTiming>;
  /** G6b: the presentation hazard's differing pixel-shots per region base name */
  hazard: Record<string, number>;
  /** g6c (G6c): per leg, Q7d's rate table, limits, separation and transport numbers */
  rates: Record<string, G6cRateRow>;
  /** filled by later increments (G6s) */
  stability: Record<string, unknown>;
  /** g6p (G6p): the measurement matrix's render-stream-report/1 path and a one-line per-scenario
   * summary (not in the default --legs; select it explicitly) */
  matrix: {
    report_path: string | null;
    scenario_summary: Record<string, string>;
  };
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

/** Gate 6's report for the evidence in `out` (every group that ran), unprinted: the CLI below and
 * gate 7's adapter (lib/gate7-gsw-g6.ts, judging a gsw view of a gate 6 run, G7g) both call it. */
export async function buildGate6Report(out: string): Promise<Gate6Report> {
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
    live: {},
    hazard: {},
    rates: {},
    stability: {},
    matrix: { report_path: null, scenario_summary: {} },
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
  if (run.includes("g6l")) {
    const expected = JSON.parse(
      await readFile(
        join(EXPERIMENT_DIR, "fixtures", "gate6-scene", "expected.json"),
        "utf8",
      ),
    ) as Gate6Expected;
    const r = await runGate6l(out, expected);
    report.checks.push(...r.checks);
    Object.assign(report.legs, r.legs);
    for (const [leg, table] of Object.entries(r.mismatch_tables))
      report.mismatch_tables[`live/${leg}`] = table;
    Object.assign(report.live, r.timing);
  }
  if (run.includes("g6b")) {
    const scene = JSON.parse(
      await readFile(
        join(EXPERIMENT_DIR, "fixtures", "gate6-scene", "expected.json"),
        "utf8",
      ),
    ) as Gate6Expected;
    const hd = JSON.parse(
      await readFile(
        join(EXPERIMENT_DIR, "fixtures", "gate6-hd", "expected.json"),
        "utf8",
      ),
    ) as Gate6HdExpected;
    const r = await runGate6b(out, scene, hd);
    report.checks.push(...r.checks);
    Object.assign(report.legs, r.legs);
    Object.assign(report.mismatch_tables, r.mismatch_tables);
    Object.assign(report.census, r.census);
    Object.assign(report.hazard, r.hazard);
  }
  if (run.includes("g6s")) {
    const expected = JSON.parse(
      await readFile(
        join(EXPERIMENT_DIR, "fixtures", "gate6-scene", "expected.json"),
        "utf8",
      ),
    ) as Gate6Expected;
    const r = await runGate6s(out, expected);
    report.checks.push(...r.checks);
    Object.assign(report.legs, r.legs);
    Object.assign(report.stability, r.stability);
  }
  if (run.includes("g6c")) {
    const r = await runGate6c(out);
    report.checks.push(...r.checks);
    Object.assign(report.legs, r.legs);
    Object.assign(report.rates, r.rates);
  }
  if (run.includes("g6p")) {
    const r = await runGate6p(out);
    report.checks.push(...r.checks);
    Object.assign(report.legs, r.legs);
    report.matrix = r.matrix;
  }
  if (run.includes("g6z")) {
    const r = await runGate6z(out);
    report.checks.push(...r.checks);
    try {
      report.checks.push(
        verifyManifestEvidence(buildManifest(), report.checks),
      );
    } catch (error) {
      report.checks.push({
        id: "manifest-evidence",
        criterion:
          "every supported entry's gate6 evidence check id appears as pass in the gate 6 run quoted by the summary",
        passed: false,
        status: "fail",
        detail: `manifest did not build: ${String(error)}`,
        evidence: [],
      });
    }
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
  return report;
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const report = await buildGate6Report(out);
  const run = report.groups.run;
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
  for (const [leg, t] of Object.entries(report.live))
    console.log(
      `  live ${leg}: credit RTT median ${t.credit_rtt_us?.median ?? "?"} us p95 ${t.credit_rtt_us?.p95 ?? "?"} us, staleness p50 applied ${t.staleness_p50_us.applied ?? "?"} us submitted ${t.staleness_p50_us.submitted ?? "?"} us, ${t.fetch_us.count} fetches p50 ${t.fetch_us.p50 ?? "?"} us p95 ${t.fetch_us.p95 ?? "?"} us${t.stall ? `, stall frames ${t.stall.send_frame}->${t.stall.credit_frame} (${t.stall.measured_ms?.toFixed(0)} ms), recovery ${t.stall.recovery_frame}${t.stall.stale_from !== null ? ` stale_from ${t.stall.stale_from}` : ""}` : ""}${t.reconnect ? `, reconnect after ${t.reconnect.after_frame}, connection 2 from ${t.reconnect.first_frame_2} (${t.reconnect.dispose_to_applied_ms?.toFixed(1)} ms)` : ""}`,
    );
  const f = (v: number | null | undefined, d = 1): string =>
    v === null || v === undefined ? "-" : v.toFixed(d);
  for (const [leg, row] of Object.entries(report.rates))
    console.log(
      `  rates ${leg}: requested ${row.requested ?? "uncapped"}, host ${f(row.host_frame)}, published ${row.published.map((v) => f(v)).join("/")}, applied ${row.applied.map((v) => f(v)).join("/")}, submitted ${row.submitted.map((v) => f(v)).join("/")}, receiver frame ${row.receiver_frame.map((v) => f(v)).join("/")}, presented unavailable${row.limited_by ? `, limited_by ${row.limited_by.limited_by}` : ""}${row.separation ? `, ${row.separation} (frame p50 ${f(row.receiver_frame_interval_p50_us[0], 0)} us, GPU p50 ${f(row.receiver_gpu_render_p50_us[0], 0)} us)` : ""}`,
    );
  for (const [name, c] of Object.entries(report.census))
    console.log(`  census (${name}): ${c}`);
  if (report.matrix.report_path)
    console.log(`  g6p matrix report: ${report.matrix.report_path}`);
  for (const [id, line] of Object.entries(report.matrix.scenario_summary))
    console.log(`  g6p ${id}: ${line}`);
  if (Object.keys(report.hazard).length > 0)
    console.log(
      `  presentation hazard, differing pixel-shots per region: ${Object.entries(
        report.hazard,
      )
        .map(([k, n]) => `${k}:${n}`)
        .join(" ")}`,
    );
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
