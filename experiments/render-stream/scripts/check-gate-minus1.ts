#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate -1 checker CLI. Evaluates every pass criterion against the evidence
// run-gate-minus1.sh wrote to --out, writes <out>/result.json (render-stream-gate-report/1),
// prints a one-line-per-criterion summary, and exits non-zero unless every criterion passed (an
// "unavailable" one -- evidence the host could not produce -- is not a pass either).
//
//   mise exec -- pnpm exec tsx --conditions=development check-gate-minus1.ts --out <evidence dir>
//
// The criteria themselves live in lib/gate-minus1-checks.ts, which scripts/test/self-test-checker.ts
// also imports directly, against fabricated evidence, to prove each one can actually fail.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Criterion,
  checkCaptureCounts,
  checkDisarmAndCompletion,
  checkFrameCallbackTicked,
  checkHeadlessNoGpu,
  checkNoMprotectAfterArm,
  checkPixelParity,
  checkPolygonBitExact,
  checkRenderedLegs,
  checkValidateAndRefusals,
  type ExpectedJson,
} from "./lib/gate-minus1-checks";

/** Which of the handoff's eight gate -1 criteria each check id belongs to. */
const CRITERION_NUMBER: Record<string, number> = {
  "frame-callback-ticked": 1,
  "headless-no-gpu": 1,
  "validate-no-write": 2,
  "refuse-sha": 2,
  "refuse-prefix": 2,
  "refuse-nocal": 2,
  "refuse-binary-byte": 2,
  "colorrect-add-rect": 3,
  "label-glyph-path": 3,
  "script-add-rect": 4,
  "polygon-bit-exact": 5,
  "disarm-restored": 6,
  "fixture-completed": 6,
  "frames-after-disarm": 6,
  "armed-vs-unarmed-pixels": 7,
  "unarmed-not-blank": 7,
  "rendered-legs-armed-and-absent": 7,
  "no-mprotect-after-arm": 8,
};

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
  if (!out) {
    throw new Error("check-gate-minus1: --out <evidence dir> is required");
  }
  return { out: resolve(out) };
}

export type NumberedCriterion = Criterion & { criterion: number };

export async function runChecks(outDir: string): Promise<NumberedCriterion[]> {
  const expected = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures/spike/expected.json"),
      "utf8",
    ),
  ) as ExpectedJson;

  const results = await Promise.all([
    checkFrameCallbackTicked(outDir),
    checkHeadlessNoGpu(outDir),
    checkValidateAndRefusals(outDir),
    checkCaptureCounts(outDir, expected),
    checkPolygonBitExact(outDir, expected),
    checkDisarmAndCompletion(outDir),
    checkPixelParity(outDir, expected),
    checkRenderedLegs(outDir, expected),
    checkNoMprotectAfterArm(outDir),
  ]);

  return results.flat().map((criterion) => {
    const criterionNumber = CRITERION_NUMBER[criterion.id];
    if (criterionNumber === undefined) {
      throw new Error(
        `check-gate-minus1: unnumbered criterion ${criterion.id}`,
      );
    }
    return { criterion: criterionNumber, ...criterion };
  });
}

interface GateReport {
  schema: "render-stream-gate-report/1";
  gate: "-1";
  status: "pass" | "fail";
  criteria: NumberedCriterion[];
  artifacts: { out: string };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const criteria = await runChecks(out);
  const status: GateReport["status"] = criteria.every(
    (c) => c.status === "pass",
  )
    ? "pass"
    : "fail";

  const report: GateReport = {
    schema: "render-stream-gate-report/1",
    gate: "-1",
    status,
    criteria,
    artifacts: { out },
  };

  await writeFile(
    join(out, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  for (const criterion of criteria) {
    const mark =
      criterion.status === "pass"
        ? "PASS"
        : criterion.status === "fail"
          ? "FAIL"
          : "SKIP";
    console.log(
      `[${mark}] #${criterion.criterion} ${criterion.id}: ${criterion.description}`,
    );
    if (criterion.detail) console.log(`       ${criterion.detail}`);
  }
  console.log(`\ngate -1: ${status.toUpperCase()} (${out}/result.json)`);

  if (status === "fail") {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
