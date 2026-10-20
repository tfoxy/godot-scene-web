#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the GRT smoke tier's file-leg filter (lib/gate7-web-legs.ts smokeSkipsLeg):
// GATE7_SMOKE_LEGS names the legs that run; unset runs every leg; `@first` is the first leg with
// no "sabotage" in its id; an entry also covers the legs under it.
import { smokeSkipsLeg } from "../lib/gate7-web-legs";

const all = [
  "sabotage-freeze/receiver",
  "receiver",
  "corrupt",
  "mesh/live-mesh",
];
let failed = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
}
const skips = (leg: string, v?: string) =>
  smokeSkipsLeg(leg, all, { GATE7_SMOKE_LEGS: v });

check(
  "unset: no leg is skipped",
  all.every((l) => !skips(l)),
);
check(
  "empty: no leg is skipped",
  all.every((l) => !skips(l, "")),
);
check(
  "@first keeps the first non-sabotage leg only",
  !skips("receiver", "@first") &&
    skips("corrupt", "@first") &&
    skips("sabotage-freeze/receiver", "@first"),
);
check(
  "an entry covers the legs under it",
  !skips("mesh/live-mesh", "mesh") && skips("receiver", "mesh"),
);
check(
  "an entry is not a prefix match on the name",
  skips("mesh/live-mesh", "mes"),
);
check(
  "several entries keep the union",
  !skips("corrupt", "receiver,corrupt") &&
    !skips("receiver", "receiver,corrupt"),
);
console.log(
  `self-test-smoke-legs: ${failed === 0 ? "all pass" : `${failed} FAIL`}`,
);
process.exit(failed === 0 ? 0 : 1);
