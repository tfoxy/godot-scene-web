#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for LS0's K5 guard (lib/validation-log.ts): a checker that judges counters.json
// `captured` refuses evidence from a run that did not set GRC_VALIDATION_LOG=on, and the capture
// source and the validation runners agree on the knob.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-validation-log.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValidationLog, validationLogProblem } from "../lib/validation-log";

let failures = 0;
let assertions = 0;
function expect(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

expect(validationLogProblem({ validation_log: "on" }, "p") === undefined, "on passes");
expect(validationLogProblem(undefined, "p") === undefined, "absent counters are the caller's finding");
expect(validationLogProblem({ validation_log: "off" }, "p")?.includes('"off"') === true, "off is refused, naming the value");
expect(validationLogProblem({}, "p")?.includes("null") === true, "a counters.json without the field (an old capture) is refused");
expect(validationLogProblem({ validation_log: true }, "p") !== undefined, "only the string on passes");
let threw = false;
try {
  assertValidationLog({ validation_log: "off" }, "evidence/counters.json");
} catch (e) {
  threw = (e as Error).message.includes("GRC_VALIDATION_LOG=on");
}
expect(threw, "assertValidationLog throws, naming the knob");
assertValidationLog({ validation_log: "on" }, "p");

// The runners that feed a `captured` checker set the knob (a leg that forgets loses its evidence).
const scripts = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = (f: string) => readFileSync(join(scripts, f), "utf8");
for (const [file, want] of [
  ["run-gate-minus1.sh", 2],
  ["run-gate2.sh", 3],
  ["run-gate3.sh", 1],
] as const) {
  const n = (text(file).match(/GRC_VALIDATION_LOG=on/g) ?? []).length;
  expect(n >= want, `${file} sets GRC_VALIDATION_LOG=on at its ${want} capture launch site(s) (found ${n})`);
}
expect(/GRC_VALIDATION_LOG=on/.test(text("lib/legs.sh")), "run_capture (lib/legs.sh) sets GRC_VALIDATION_LOG=on");
expect(/GRC_VALIDATION_LOG/.test(text("lib/gamescope.sh")), "the launcher strips an inherited GRC_VALIDATION_LOG");

if (failures > 0) {
  console.error(`self-test-validation-log: ${failures} of ${assertions} assertion(s) failed`);
  process.exit(1);
}
console.log(`self-test-validation-log: ${assertions}/${assertions} assertions passed`);
