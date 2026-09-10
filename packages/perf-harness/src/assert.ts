// Relational acceptance gates over a finished comparison.
//
// WHY RELATIONAL, NEVER AN ABSOLUTE WALL-CLOCK THRESHOLD
//
// Every millisecond in this harness is a property of the machine: a headless SwiftShader box, a CI
// runner and a phone disagree by an order of magnitude on the same page, and the same box disagrees
// with itself when it is thermally throttled or when another job is resident. A gate written as
// "page-crop must decode in under 1500 ms" therefore encodes the box it was written on: it goes red
// on a slower machine that reproduces the bug perfectly, and green on a faster one that reproduces it
// just as badly. Both outcomes teach the reader to ignore the gate.
//
// What DOES survive the machine is the RELATION between the arms measured in the same process, in the
// same browser, minutes apart, on identical geometry. "page-crop re-decodes at least three times as
// often as region-blob" is a statement about the mechanisms; it holds on a phone and on a workstation
// and it fails exactly when the defect stops reproducing.
//
// The count-valued floors below (`>= 3` re-decodes, `>= 1` long gap) are not wall-clock thresholds:
// they exist because a ratio against zero is not a relation at all. Without them a run where NOTHING
// was measured — 0 re-decodes on every arm — would satisfy "page-crop >= 3x the others" and pass a
// gate whose whole purpose is to prove the bug still reproduces.

import type { BrowserPerfReport } from "./report";

export type AssertionStatus = "pass" | "fail" | "skip";

export interface AssertionResult {
  name: string;
  status: AssertionStatus;
  /** The measured numbers behind the verdict, so a failure is readable without opening the JSON. */
  detail: string;
}

export interface ScenarioGate {
  scenario: string;
  /** One paragraph: what this gate proves and why it is expressed as a relation. */
  rationale: string;
  /** Mechanisms that must be present in the run for the gate to be evaluable at all. */
  requiredMechanisms: string[];
  evaluate(reports: Map<string, BrowserPerfReport>): AssertionResult[];
}

/** page-crop must re-decode at least this many times MORE than each control arm. */
const REDECODE_RATIO = 3;
/**
 * ...and at least this many times in absolute terms. A ratio against a zero baseline is vacuous, so
 * this floor is what stops an all-zero (i.e. unmeasured) run from passing.
 */
const REDECODE_FLOOR = 3;
/** The single largest decode in the run must be at least this much larger on page-crop. */
const DECODE_MAX_RATIO = 3;
/** page-crop's worst source:painted ratio must exceed every control arm's by this much. */
const SOURCE_RATIO_MULTIPLE = 10;
/** Activation gaps above this count as a user-visible stall (same threshold the analyzer uses). */
const GAP_THRESHOLD_MS = 100;

function fmt(value: number): string {
  return Math.abs(value) >= 100 ? value.toFixed(0) : String(value);
}

function verdict(ok: boolean): AssertionStatus {
  return ok ? "pass" : "fail";
}

const ancestorRescaleGate: ScenarioGate = {
  scenario: "ancestor-rescale",
  rationale:
    "S2 re-scales the sprite grid 1.0 -> 1.2 -> 1.0 from JS, every frame, for the whole measured " +
    "window. page-crop's display lists reference the 16 MP atlas page; region-blob's and canvas's " +
    "reference small standalone images. The gate asserts that separation as a set of RATIOS between " +
    "arms measured in the same browser on identical geometry — never as a wall-clock number — so it " +
    "means the same thing on a phone as on a workstation.",
  requiredMechanisms: ["region-blob", "page-crop", "canvas"],

  evaluate(reports) {
    const results: AssertionResult[] = [];
    const hazard = reports.get("page-crop");
    const controls = [...reports.entries()].filter(
      ([mechanism]) => mechanism !== "page-crop",
    );
    if (!hazard) {
      return [
        {
          name: "page-crop arm present",
          status: "fail",
          detail: `the run carries ${[...reports.keys()].join(", ") || "no arms"}; the gate compares page-crop against the others and cannot be evaluated without it`,
        },
      ];
    }

    // 0. Nothing below means anything if the page was blank. A blank page decodes nothing, stalls
    //    nothing and would pass every ratio in the wrong direction.
    const blank = [...reports.entries()].filter(
      ([, report]) =>
        report.metrics.presented.sampleHits <
        report.metrics.presented.sampleCount,
    );
    results.push({
      name: "presence: every arm actually rendered",
      status: verdict(blank.length === 0),
      detail:
        blank.length === 0
          ? [...reports.entries()]
              .map(
                ([mechanism, report]) =>
                  `${mechanism} ${report.metrics.presented.sampleHits}/${report.metrics.presented.sampleCount}`,
              )
              .join(", ")
          : blank
              .map(
                ([mechanism, report]) =>
                  `${mechanism} rendered only ${report.metrics.presented.sampleHits}/${report.metrics.presented.sampleCount} sample points`,
              )
              .join("; "),
    });

    // 1. Re-decodes: the mechanism-level statement of the hazard.
    const hazardRedecodes = hazard.metrics.decode.redecodeCount;
    const redecodeOk =
      hazardRedecodes >= REDECODE_FLOOR &&
      controls.every(
        ([, report]) =>
          hazardRedecodes >=
          REDECODE_RATIO * report.metrics.decode.redecodeCount,
      );
    results.push({
      name: `decode.redecodeCount: page-crop >= ${REDECODE_RATIO}x every control arm, and >= ${REDECODE_FLOOR}`,
      status: verdict(redecodeOk),
      detail:
        `page-crop ${hazardRedecodes}` +
        controls
          .map(
            ([mechanism, report]) =>
              `, ${mechanism} ${report.metrics.decode.redecodeCount}`,
          )
          .join("") +
        (hazardRedecodes < REDECODE_FLOOR
          ? ` — below the absolute floor of ${REDECODE_FLOOR}: a ratio against a zero baseline would pass an unmeasured run`
          : ""),
    });

    // 2. The size of the biggest single decode. Only the arm whose display lists reference the whole
    //    page ever pays a 16 MP decode; the others decode sprite-sized images.
    const hazardMax = hazard.metrics.decode.maxMs;
    const maxOk = controls.every(
      ([, report]) =>
        hazardMax >= DECODE_MAX_RATIO * report.metrics.decode.maxMs,
    );
    results.push({
      name: `decode.maxMs: page-crop's largest single decode >= ${DECODE_MAX_RATIO}x every control arm's`,
      status: verdict(maxOk),
      detail:
        `page-crop ${fmt(hazardMax)} ms` +
        controls
          .map(
            ([mechanism, report]) =>
              `, ${mechanism} ${fmt(report.metrics.decode.maxMs)} ms`,
          )
          .join(""),
    });

    // 3. The cause class itself, straight out of the display lists: a small element referencing a
    //    large source image. This is the relation that stops holding the day someone fixes the
    //    mechanism, which is exactly what a gate is for.
    const hazardSource = hazard.metrics.paint.maxSourceToPaintedRatio;
    const sourceOk = controls.every(
      ([, report]) =>
        hazardSource >=
        SOURCE_RATIO_MULTIPLE * report.metrics.paint.maxSourceToPaintedRatio,
    );
    results.push({
      name: `paint.maxSourceToPaintedRatio: page-crop >= ${SOURCE_RATIO_MULTIPLE}x every control arm`,
      status: verdict(sourceOk),
      detail:
        `page-crop ${fmt(hazardSource)}x` +
        controls
          .map(
            ([mechanism, report]) =>
              `, ${mechanism} ${fmt(report.metrics.paint.maxSourceToPaintedRatio)}x`,
          )
          .join(""),
    });

    // 4. The user-visible symptom the round set out to reproduce.
    //
    //    MEASURED, and deliberately not asserted on the software decode path. On Chrome 148 headless
    //    (SwiftShader, `cacheFamily: software`) a re-scale DOES reach cc's decode cache — the cache
    //    keys' `target_size` moves between mip levels exactly as the scale changes — but
    //    `SoftwareImageDecodeCache` satisfies a new mip by RE-SCALING an existing decode instead of
    //    re-running the codec. Across six measured runs (three drivers x scales 0.5 and 1.2) the
    //    atlas page ran the codec 4 times in every single one, and no arm ever produced a gap over
    //    100 ms. The traced regression is a `GpuImageDecodeCache` behaviour, which this environment
    //    structurally cannot produce.
    //
    //    So the relation is SKIPPED, loudly and with its reason, when the run's decode cache family
    //    is not the one the defect lives on — and enforced the moment a device run reports `gpu`.
    //    Asserting it here would fail every clean run on this box until everybody passed `|| true`.
    const family = hazard.metrics.decode.cacheFamily;
    const hazardGaps = hazard.metrics.activationGapMs;
    const gapDetail =
      `page-crop ${hazardGaps.over100msCount} gap(s) > ${GAP_THRESHOLD_MS} ms (p95 ${fmt(hazardGaps.p95)} ms, max ${fmt(hazardGaps.max)} ms)` +
      controls
        .map(
          ([mechanism, report]) =>
            `, ${mechanism} ${report.metrics.activationGapMs.over100msCount} (p95 ${fmt(report.metrics.activationGapMs.p95)} ms, max ${fmt(report.metrics.activationGapMs.max)} ms)`,
        )
        .join("");
    if (family === "gpu") {
      const noisyControls = controls.filter(
        ([, report]) => report.metrics.activationGapMs.over100msCount > 0,
      );
      results.push({
        name: `activationGapMs: page-crop stalls past ${GAP_THRESHOLD_MS} ms and the control arms do not`,
        status: verdict(
          hazardGaps.over100msCount >= 1 && noisyControls.length === 0,
        ),
        detail: gapDetail,
      });
    } else {
      results.push({
        name: `activationGapMs: page-crop stalls past ${GAP_THRESHOLD_MS} ms and the control arms do not`,
        status: "skip",
        detail:
          `decode cacheFamily is "${family}", not "gpu" — measured: this cache re-scales an existing ` +
          `decode rather than re-running the codec, so the traced stall cannot reproduce here. ` +
          `Observed anyway: ${gapDetail}`,
      });
    }

    return results;
  },
};

export const SCENARIO_GATES: Record<string, ScenarioGate> = {
  [ancestorRescaleGate.scenario]: ancestorRescaleGate,
};

export function getScenarioGate(scenario: string): ScenarioGate {
  const gate = SCENARIO_GATES[scenario];
  if (!gate) {
    throw new Error(
      `no assertions declared for scenario "${scenario}" (have: ${Object.keys(SCENARIO_GATES).join(", ")})`,
    );
  }
  return gate;
}

export interface GateOutcome {
  ok: boolean;
  results: AssertionResult[];
  missingMechanisms: string[];
}

export function evaluateGate(
  gate: ScenarioGate,
  reports: BrowserPerfReport[],
): GateOutcome {
  const byMechanism = new Map<string, BrowserPerfReport>();
  for (const report of reports) {
    if (report.scenario !== gate.scenario) {
      continue;
    }
    byMechanism.set(String(report.params.mechanism ?? "default"), report);
  }
  const missingMechanisms = gate.requiredMechanisms.filter(
    (mechanism) => !byMechanism.has(mechanism),
  );
  // A gate that silently skips a missing arm is a gate that passes when the run was broken.
  if (missingMechanisms.length > 0) {
    return {
      ok: false,
      missingMechanisms,
      results: [
        {
          name: "run carries every arm the gate compares",
          status: "fail",
          detail: `missing: ${missingMechanisms.join(", ")} (have: ${[...byMechanism.keys()].join(", ") || "none"})`,
        },
      ],
    };
  }
  const results = gate.evaluate(byMechanism);
  return {
    ok: results.every((result) => result.status !== "fail"),
    results,
    missingMechanisms,
  };
}

export function formatGateOutcome(
  gate: ScenarioGate,
  outcome: GateOutcome,
): string {
  const lines: string[] = [];
  lines.push(`perf assert — scenario ${gate.scenario}`);
  lines.push("");
  lines.push(gate.rationale);
  lines.push("");
  for (const result of outcome.results) {
    lines.push(`${result.status.toUpperCase().padEnd(4)}  ${result.name}`);
    lines.push(`      ${result.detail}`);
  }
  const failed = outcome.results.filter((r) => r.status === "fail").length;
  const skipped = outcome.results.filter((r) => r.status === "skip").length;
  lines.push("");
  lines.push(
    outcome.ok
      ? `OK — ${outcome.results.length - skipped}/${outcome.results.length} relations hold` +
          (skipped > 0
            ? `, ${skipped} SKIPPED (not evaluable in this environment — see the detail above; the gate is not claiming the traced defect reproduced)`
            : "")
      : `FAILED — ${failed}/${outcome.results.length} relation(s) do not hold.`,
  );
  return lines.join("\n");
}
