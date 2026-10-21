#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the smoke tier's unrun sabotage leg in gate 7's web checker (lib/gate7-adapters.ts
// cssOpacitySabotageCheck, the part of checkGate0Web that reads the sabotage-css-opacity leg):
//  1. a leg dir holding skipped-by-tier.txt (no exit-code.txt) is reported as a failing check whose
//     detail starts `skipped-by-tier` and names the leg (the tier verdict excuses it), never passed,
//     and never throws;
//  2. a leg that ran (exit-code.txt present, no marker) keeps the old verdict exactly: the problems
//     joined as before, `exit N` included.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cssOpacitySabotageCheck } from "../lib/gate7-adapters";
import type { WebLegSpec } from "../lib/gate7-web-legs";

let failures = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (!ok) {
    failures++;
    console.error(`FAIL: ${name} ${extra}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "smoke-sab-"));
const spec = (leg: string): WebLegSpec =>
  ({ leg, webDir: join(root, leg) }) as unknown as WebLegSpec;
const honest = spec("receiver");
const sab = spec("sabotage-css-opacity");
mkdirSync(honest.webDir, { recursive: true });

// 1. not run by the smoke tier.
mkdirSync(sab.webDir, { recursive: true });
writeFileSync(join(sab.webDir, "skipped-by-tier.txt"), "skipped-by-tier: x\n");
const skipped = await cssOpacitySabotageCheck(honest, sab);
check("skipped: id", skipped.id === "sabotage-css-opacity@web");
check("skipped: never passed", skipped.passed === false);
check(
  "skipped: detail names the tier and the leg",
  skipped.detail.startsWith("skipped-by-tier") &&
    skipped.detail.includes("sabotage-css-opacity"),
  skipped.detail,
);

// 2. ran: the old verdict (no evidence besides the exit code).
rmSync(sab.webDir, { recursive: true, force: true });
mkdirSync(sab.webDir, { recursive: true });
writeFileSync(join(sab.webDir, "exit-code.txt"), "3\n");
const ran = await cssOpacitySabotageCheck(honest, sab);
check(
  "ran: old verdict",
  ran.passed === false &&
    ran.detail ===
      `it failed for another reason: ${sab.webDir}: applied.json missing; exit 3`,
  ran.detail,
);

rmSync(root, { recursive: true, force: true });
console.log(
  failures === 0
    ? "self-test-smoke-sabotage: all checks correct"
    : `self-test-smoke-sabotage: ${failures} FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
