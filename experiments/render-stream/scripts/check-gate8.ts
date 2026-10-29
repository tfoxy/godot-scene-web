#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 8 checker CLI. Evaluates the checks of the groups that ran against the evidence
// run-gate8.sh wrote to --out, writes <out>/result.json (render-stream-gate8-report/1), prints
// one line per check and leg, and exits non-zero unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate8.ts --out <evidence dir>
//
// The checks live in lib/gate8-*-checks.ts (G8t: lib/gate8-tex-checks.ts, G8a:
// lib/gate8-adopt-checks.ts, G8h: lib/gate8-size-checks.ts, G8f: lib/gate8-float-checks.ts, G8m:
// lib/gate8-mat-checks.ts, G8kp: lib/gate8-delivery-checks.ts, G8kc: lib/gate8-cache-checks.ts, P3-CT:
// lib/gate8-ct-checks.ts, CG1: lib/gate8-cg-checks.ts, W11b: lib/gate8-w11-checks.ts, PM1: lib/gate8-mm-checks.ts, PM5: lib/gate8-pt-checks.ts, G8g: lib/gate8-live-checks.ts, the
// live group g8l), which scripts/test/self-test-gate8*.ts drive against fabricated evidence.
// buildGate8Report is also check-gate7.ts's gate 8 checker for the GSW receiver's file legs (G8g).

// GRT4b: node:crypto behind the decoders' hash seam (lib/node-hash.ts), before anything decodes.
import "./lib/node-hash";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type G8aExpected, runG8a } from "./lib/gate8-adopt-checks";
import { type FloatExpected, runG8f } from "./lib/gate8-float-checks";
import { type G8mExpected, runG8m } from "./lib/gate8-mat-checks";
import { runG8l } from "./lib/gate8-live-checks";
import { runG8w11cResync } from "./lib/gate8-w11-native-checks";
import { type G8cgExpected, runG8cg } from "./lib/gate8-cg-checks";
import { runG8w11 } from "./lib/gate8-w11-checks";
import { type G8mmExpected, runG8mm } from "./lib/gate8-mm-checks";
import { type G8ptExpected, runG8pt } from "./lib/gate8-pt-checks";
import { fileEquiv } from "./lib/gate8-w13-checks";
import { runG8pt13Gsw } from "./lib/gate8-w13-gsw-checks";
import { type G8cExpected, runG8c } from "./lib/gate8-ct-checks";
import { type G8hExpected, runG8h } from "./lib/gate8-size-checks";
import { type G8kuExpected, runG8ku } from "./lib/gate8-basis-checks";
import { runG8kc } from "./lib/gate8-cache-checks";
import { runG8kp } from "./lib/gate8-delivery-checks";
import { type G8tExpected, runG8t } from "./lib/gate8-tex-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..");
const KNOWN_GROUPS = ["g8t", "g8a", "g8h", "g8f", "g8m", "g8kp", "g8ku", "g8kc", "g8l", "g8c", "g8cg", "g8w11", "g8w11c", "g8mm", "g8pt"];

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

interface Gate8Check {
  id: string;
  passed: boolean;
  status: string;
  criterion: string;
  detail?: string;
  gating?: boolean;
}

export interface Gate8Report {
  schema: string;
  groups: { run: string[]; not_run: string[] };
  gate_passed: boolean;
  checks: Gate8Check[];
  [group: string]: unknown;
}

/** The gate 8 report over an evidence directory (render-stream-gate8-report/1): every group that ran.
 * check-gate7.ts judges the GSW receiver's gate 8 legs through it (G8g, D21: the gate's own code). */
export async function buildGate8Report(out: string): Promise<Gate8Report> {
  const legsJson = JSON.parse(await readFile(join(out, "legs.json"), "utf8")) as {
    groups_run: string[];
  };
  const run = legsJson.groups_run.filter((g) => KNOWN_GROUPS.includes(g));
  const report: Record<string, unknown> = {
    schema: "render-stream-gate8-report/1",
    groups: { run, not_run: KNOWN_GROUPS.filter((g) => !run.includes(g)) },
  };
  const checks: Gate8Check[] = [];
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
  if (run.includes("g8c")) {
    const expected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-ct", "expected.json"), "utf8"),
    ) as G8cExpected;
    const g8c = await runG8c(out, expected);
    checks.push(...g8c.checks);
    report.g8c = g8c.report;
  }
  if (run.includes("g8cg")) {
    const expected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-cg", "expected.json"), "utf8"),
    ) as G8cgExpected;
    const g8cg = await runG8cg(out, expected);
    checks.push(...g8cg.checks);
    report.g8cg = g8cg.report;
  }
  if (run.includes("g8w11")) {
    const g8w11 = await runG8w11(out);
    checks.push(...g8w11.checks);
    report.g8w11 = g8w11.report;
  }
  if (run.includes("g8w11c")) {
    checks.push(...(await runG8w11cResync(out)));
  }
  if (run.includes("g8mm")) {
    const expected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-mm", "expected.json"), "utf8"),
    ) as G8mmExpected;
    const g8mm = await runG8mm(out, expected);
    checks.push(...g8mm.checks);
    report.g8mm = g8mm.report;
  }
  if (run.includes("g8pt")) {
    const expected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-pt", "expected.json"), "utf8"),
    ) as G8ptExpected;
    // pt-pump judges fixtures/gate8-mm's headless legs against g8mm's own predictions.
    const mmExpected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-mm", "expected.json"), "utf8"),
    ) as G8mmExpected;
    const g8pt = await runG8pt(out, expected, mmExpected);
    checks.push(...g8pt.checks);
    // W13b: g8pt's /13 headless twins (lib/gate8-w13-checks.ts fileEquiv).
    const w13 = await fileEquiv(
      join(out, "g8pt"),
      [
        ["headless-shim13/capture", "headless-shim/capture"],
        ["headless-pump13/capture", "headless-pump/capture"],
      ],
      "-g8pt",
      "gate8-pt headless-shim (particles) and gate8-mm headless-pump (multimesh)",
    );
    checks.push(...w13.checks);
    // W13c: GSW at /13 on those twins (lib/gate8-w13-gsw-checks.ts).
    const mmPixels = (mmExpected as { pixels?: Parameters<typeof runG8pt13Gsw>[1] }).pixels ?? null;
    checks.push(...(await runG8pt13Gsw(out, mmPixels)));
    report.g8pt = g8pt.report;
  }
  if (run.includes("g8f")) {
    const expected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-tex", "expected-float.json"), "utf8"),
    ) as FloatExpected;
    const g8f = await runG8f(out, expected);
    checks.push(...g8f.checks);
    report.g8f = {
      legs: g8f.legs,
      carried_formats: g8f.carried_formats,
      shot_diffs: g8f.shot_diffs,
      workers: g8f.workers,
    };
  }
  if (run.includes("g8m")) {
    const expected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-mat", "expected.json"), "utf8"),
    ) as G8mExpected;
    const g8m = await runG8m(out, expected);
    checks.push(...g8m.checks);
    report.g8m = g8m.report;
  }
  if (run.includes("g8kp")) {
    const expected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-tex", "expected.json"), "utf8"),
    ) as G8tExpected;
    const g8kp = await runG8kp(out, expected);
    checks.push(...g8kp.checks);
    report.g8kp = { legs: g8kp.legs, select: g8kp.select, pixels: g8kp.pixels };
  }
  if (run.includes("g8kc")) {
    const g8kc = await runG8kc(out);
    checks.push(...g8kc.checks);
    report.g8kc = { legs: g8kc.legs, stats: g8kc.stats };
  }
  if (run.includes("g8l")) {
    const g8l = await runG8l(out);
    checks.push(...g8l.checks);
    report.g8l = g8l.report;
  }
  if (run.includes("g8ku")) {
    const expected = JSON.parse(
      await readFile(join(EXPERIMENT_DIR, "fixtures", "gate8-basis", "expected.json"), "utf8"),
    ) as G8kuExpected;
    const g8ku = await runG8ku(out, expected);
    checks.push(...g8ku.checks);
    report.g8ku = {
      legs: g8ku.legs,
      quality: g8ku.quality,
      transcodes: g8ku.transcodes,
      pixels: g8ku.pixels,
    };
  }
  const gating = checks.filter((c) => c.gating !== false);
  report.gate_passed = gating.length > 0 && gating.every((c) => c.passed);
  report.checks = checks;
  return report as Gate8Report;
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const report = await buildGate8Report(out);
  const checks = report.checks;
  const gating = checks.filter((c) => c.gating !== false);
  await writeFile(join(out, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const c of checks) {
    const tag = c.status === "not-run" ? "NOT-RUN" : c.passed ? "PASS" : "FAIL";
    console.log(`[${tag}] ${c.id}: ${c.criterion}`);
    if (c.detail) console.log(`       ${c.detail}`);
  }
  const passed = gating.filter((c) => c.passed).length;
  console.log(
    `\ngate 8 (groups ${report.groups.run.join(",") || "none"}): ${report.gate_passed ? "PASS" : "FAIL"} ${passed}/${gating.length} (${join(out, "result.json")})`,
  );
  if (!report.gate_passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
