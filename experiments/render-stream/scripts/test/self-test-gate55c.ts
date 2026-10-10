#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 5.5c: the g55c checks of lib/gate55c-checks.ts on the committed
// fixtures/gate55-shader/expected.json and on synthetic oracle logs, counters, stdout logs and
// recordings, each with a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate55c.ts
//
// 1. checkShaderExpectedSelfConsistent on the committed expected.json (both variants) and on
//    broken copies (an off-grid colour, a wrong `fresh`, overlapping regions, a status going back,
//    a phase off its settle frame).
// 2. evaluateOracleAgrees and evaluateOracleShaderCode on oracle lines made from expected.json
//    (pass) and with a type, a value one float32 ulp off, a status, a frame, a hash, an include
//    marker or one leg's bytes off (each fails).
// 3. evaluateCounters, evaluateShaderLogClean, evaluateStepLog and evaluateShaderCaptureTyped on
//    synthetic values.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RecordingSummary } from "../lib/gate0-checks";
import type { Gate3CaptureEvaluation } from "../lib/gate3-checks";
import { rastersOf } from "../lib/gate5-checks";
import {
  asGate5,
  checkShaderExpectedSelfConsistent,
  evaluateCounters,
  evaluateOracleAgrees,
  evaluateOracleShaderCode,
  evaluateShaderCaptureTyped,
  evaluateShaderLogClean,
  evaluateStepLog,
  type Gate55ShaderExpected,
  jsonEqual,
  type OracleLine,
  type OracleLog,
  refusedView,
} from "../lib/gate55c-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "../..");

let assertions = 0;
let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  assertions++;
  if (ok) console.log(`[SELF-TEST OK] ${name}`);
  else {
    failures++;
    console.error(`[SELF-TEST FAIL] ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const passes = (name: string, problems: string[]) =>
  assert(
    `${name} passes`,
    problems.length === 0,
    problems.slice(0, 3).join(" | "),
  );
const fails = (name: string, problems: string[], needle?: string) =>
  assert(
    `${name} fails`,
    problems.length > 0 &&
      (!needle || problems.some((p) => p.includes(needle))),
    problems.length === 0
      ? "no problem reported"
      : problems.slice(0, 2).join(" | "),
  );

function selfConsistentCases(expected: Gate55ShaderExpected): void {
  const rasters = rastersOf(asGate5(expected));
  const c0 = checkShaderExpectedSelfConsistent(expected, rasters);
  passes(
    "shader-expected-self-consistent (committed)",
    c0.passed ? [] : [c0.detail ?? ""],
  );
  const refused = refusedView(expected);
  const r = checkShaderExpectedSelfConsistent(
    refused,
    rastersOf(asGate5(refused)),
  );
  passes(
    "refused-expected-self-consistent (committed)",
    r.passed ? [] : [r.detail ?? ""],
  );

  const offGrid = clone(expected);
  const key = offGrid.steps[0].items[0].ops;
  const shape = offGrid.op_lists[key][0] as { colors: number[][] };
  shape.colors[0][0] = 0.3;
  const c1 = checkShaderExpectedSelfConsistent(
    offGrid,
    rastersOf(asGate5(offGrid)),
  );
  fails(
    "self-consistent (off-grid colour)",
    c1.passed ? [] : [c1.detail ?? ""],
    "off the grid",
  );

  const stale = clone(expected);
  stale.steps[1].fresh.TI = false;
  const c2 = checkShaderExpectedSelfConsistent(stale, rasters);
  fails(
    "self-consistent (TI not fresh at 1)",
    c2.passed ? [] : [c2.detail ?? ""],
    "TI fresh=false",
  );

  const overlap = clone(expected);
  overlap.regions.PA = [100, 16, 192, 96];
  const c3 = checkShaderExpectedSelfConsistent(overlap, rasters);
  fails(
    "self-consistent (overlapping regions)",
    c3.passed ? [] : [c3.detail ?? ""],
    "overlap",
  );

  const back = clone(expected);
  const sha = back.steps[9].oracle.shaders.find((s) => s.name === "sh_a");
  if (sha) sha.status = "live";
  const c4 = checkShaderExpectedSelfConsistent(back, rasters);
  fails(
    "self-consistent (sh_a revived)",
    c4.passed ? [] : [c4.detail ?? ""],
    "freed -> live",
  );

  const phase = clone(expected);
  phase.steps[3].phase = 37;
  const c5 = checkShaderExpectedSelfConsistent(phase, rasters);
  fails(
    "self-consistent (phase off)",
    c5.passed ? [] : [c5.detail ?? ""],
    "phase 37",
  );
}

/** Oracle lines exactly as expected.json predicts them. */
function oracleLog(
  expected: Pick<Gate55ShaderExpected, "steps">,
  leg: string,
): OracleLog {
  const lines: OracleLine[] = expected.steps.map((s) => ({
    schema: "render-stream-gate55-materials/1",
    step: s.step,
    frame: s.settle_frame,
    ...clone(s.oracle),
  }));
  return {
    leg,
    path: "synthetic",
    text: lines.map((l) => JSON.stringify(l)).join("\n"),
    lines,
    problem: null,
  };
}

function withText(log: OracleLog): OracleLog {
  return { ...log, text: log.lines.map((l) => JSON.stringify(l)).join("\n") };
}

function oracleCases(expected: Gate55ShaderExpected): void {
  const a = oracleLog(expected, "reference-shader");
  const b = oracleLog(expected, "reference-shader-repeat");
  passes("oracle-agrees", evaluateOracleAgrees(expected, [a, b]).problems);
  passes(
    "oracle-agrees (refused)",
    evaluateOracleAgrees(
      refusedView(expected),
      [oracleLog(refusedView(expected), "reference-refused")],
      [],
    ).problems,
  );
  assert(
    "oracle-agrees compares every declared parameter",
    evaluateOracleAgrees(expected, [a]).compared ===
      expected.steps.reduce(
        (n, s) =>
          n +
          s.oracle.materials.reduce((m, x) => m + (x.params?.length ?? 0), 0) +
          s.oracle.items.reduce((m, x) => m + x.instance_params.length, 0),
        0,
      ),
  );

  const type = clone(a);
  const gain = type.lines[0].materials
    .find((m) => m.name === "MT")
    ?.params?.find((p) => p.name === "gain");
  if (gain) gain.type = "int";
  fails(
    "oracle-agrees (gain typed int)",
    evaluateOracleAgrees(expected, [withText(type), b]).problems,
    "MT.gain",
  );

  const ulp = clone(a);
  const tint = ulp.lines[1].materials
    .find((m) => m.name === "MT")
    ?.params?.find((p) => p.name === "tint");
  if (tint) (tint.value as number[])[0] = 0.8; // the double 0.8, not float32(0.8)
  fails(
    "oracle-agrees (tint not float32)",
    evaluateOracleAgrees(expected, [withText(ulp), b]).problems,
    "MT.tint",
  );

  const inst = clone(a);
  const i2 = inst.lines[0].items.find((i) => i.name === "I2");
  if (i2) i2.instance_params[0].type = "color";
  fails(
    "oracle-agrees (I2 default typed color)",
    evaluateOracleAgrees(expected, [withText(inst), b]).problems,
    "I2 instance inst_color",
  );

  const status = clone(a);
  const mr = status.lines[5].materials.find((m) => m.name === "MR");
  if (mr) mr.status = "live";
  fails(
    "oracle-agrees (MR not freed at 5)",
    evaluateOracleAgrees(expected, [withText(status), b]).problems,
    "MR: status live",
  );

  const frame = clone(a);
  frame.lines[2].frame = 27;
  fails(
    "oracle-agrees (a frame off)",
    evaluateOracleAgrees(expected, [withText(frame), b]).problems,
    "frame 27",
  );

  const differ = clone(b);
  differ.text = `${differ.text}\n`;
  fails(
    "oracle-agrees (repeat differs)",
    evaluateOracleAgrees(expected, [a, differ]).problems,
    "differ",
  );

  passes("shader-code-model", evaluateOracleShaderCode(expected, a).problems);
  const hash = clone(a);
  const t3 = hash.lines[3].shaders.find((s) => s.name === "tint");
  const t2 = hash.lines[2].shaders.find((s) => s.name === "tint");
  if (t3 && t2) t3.sha256 = t2.sha256; // the code change never reached the reference
  fails(
    "shader-code-model (tint code unchanged at 3)",
    evaluateOracleShaderCode(expected, hash).problems,
    "step 3 tint: sha256",
  );
  const marker = clone(a);
  const pal = marker.lines[0].shaders.find((s) => s.name === "pal");
  if (pal) pal.include_markers = true;
  fails(
    "shader-code-model (include markers on pal)",
    evaluateOracleShaderCode(expected, marker).problems,
    "include_markers",
  );

  assert("jsonEqual: float32 vs double", !jsonEqual([Math.fround(0.4)], [0.4]));
  assert("jsonEqual: key order", jsonEqual({ a: 1, b: [2] }, { b: [2], a: 1 }));
}

function syntheticCapture(
  expected: Gate55ShaderExpected,
): Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full"> {
  const idOf = (name: string) => expected.creation_order.indexOf(name) + 2;
  const transactions = expected.steps.map((s, k) => ({
    meta: {
      seq: k + 1,
      frame: s.settle_frame,
      items: expected.creation_order.map((name) => ({
        id: idOf(name),
        content_version: name === "Marker" ? s.step + 1 : 1,
        commands: [],
      })),
      unsupported: expected.typed.items.map((name) => ({
        op: "canvas_item_set_material",
        item: idOf(name),
        reason: "unsupported-state",
      })),
    },
    sha256: "",
  }));
  return {
    result_class: "unsupported",
    reasons: [],
    full: {
      path: "synthetic",
      present: true,
      sha256: null,
      bytes: 0,
      errors: [],
      transactions,
    } as unknown as RecordingSummary,
  };
}

function captureCases(expected: Gate55ShaderExpected): void {
  passes(
    "shader-counters",
    evaluateCounters(expected.counters, {
      ...expected.counters.counts,
      canvas_item_add_circle: 0,
    }).problems,
  );
  fails(
    "shader-counters (PH's phase short by one frame)",
    evaluateCounters(expected.counters, {
      ...expected.counters.counts,
      material_set_param: expected.counters.counts.material_set_param - 1,
    }).problems,
    "material_set_param",
  );
  fails(
    "shader-counters (an unexpected draw)",
    evaluateCounters(expected.counters, {
      ...expected.counters.counts,
      canvas_item_add_polygon: 1,
    }).problems,
    "canvas_item_add_polygon",
  );
  passes(
    "capture-shader-log-clean",
    evaluateShaderLogClean([
      { leg: "capture-shader", text: "[fixture] gate55-shader ready\n" },
    ]).problems,
  );
  fails(
    "capture-shader-log-clean (a compile error)",
    evaluateShaderLogClean([
      {
        leg: "capture-shader",
        text: "SHADER ERROR: Unknown identifier\nShader compilation failed.\n",
      },
    ]).problems,
    "2 shader error lines",
  );
  fails(
    "capture-shader-log-clean (missing log)",
    evaluateShaderLogClean([{ leg: "capture-refused", text: undefined }])
      .problems,
    "missing",
  );

  const lines = expected.steps.map((s) => ({
    step: s.step,
    applied_frame: s.applied_frame,
    settle_frame: s.settle_frame,
  }));
  passes("step log", evaluateStepLog(expected, "capture-refused", lines));
  fails(
    "step log (a step missing)",
    evaluateStepLog(expected, "capture-refused", lines.slice(1)),
    "capture-refused",
  );

  const good = syntheticCapture(expected);
  passes(
    "leg-class-capture-shader",
    evaluateShaderCaptureTyped(expected, good).problems,
  );
  const refused = refusedView(expected);
  passes(
    "leg-class-capture-refused",
    evaluateShaderCaptureTyped(refused, syntheticCapture(refused)).problems,
  );
  fails(
    "leg-class-capture-shader (class success)",
    evaluateShaderCaptureTyped(expected, { ...good, result_class: "success" })
      .problems,
    "class success",
  );
  const redrawn = clone(good);
  redrawn.full.transactions[1].meta.items[0].content_version = 2;
  fails(
    "leg-class-capture-shader (TI redrawn)",
    evaluateShaderCaptureTyped(expected, redrawn).problems,
    "TI's content_version",
  );
  const missing = clone(good);
  missing.full.transactions[4].meta.unsupported.pop();
  fails(
    "leg-class-capture-shader (an item not typed)",
    evaluateShaderCaptureTyped(expected, missing).problems,
    "step 4: typed items",
  );
  const reason = clone(good);
  reason.full.transactions[0].meta.unsupported[0].reason =
    "unsupported-op" as never;
  fails(
    "leg-class-capture-shader (another reason)",
    evaluateShaderCaptureTyped(expected, reason).problems,
    "unsupported-op",
  );
}

async function main(): Promise<void> {
  const expected = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate55-shader", "expected.json"),
      "utf8",
    ),
  ) as Gate55ShaderExpected;
  selfConsistentCases(expected);
  oracleCases(expected);
  captureCases(expected);
  console.log(
    `\nself-test-gate55c: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
