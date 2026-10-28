#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for g8w11's native checks (lib/gate8-w11-native-checks.ts, W11d) and
// gate8-w11-tool.ts's native leg names, on golden-11 and synthetic inputs:
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-w11-native.ts
//
// 1. messagesPerTransaction: golden-11's inline stream carries records before some transactions
//    (more than one message a transaction); its patch stream none (exactly one); the warm-up
//    transactions are not counted.
// 2. nativeLeg: every native leg the checks read is a leg the tool plans, and the sabotage legs sit
//    beside their capture's receiver.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { nativeLeg, W11_GSW_LEGS } from "../gate8-w11-tool";
import {
  messagesPerTransaction,
  NATIVE_HONEST,
  NATIVE_SABOTAGE_LEGS,
  NATIVE_TWINS,
} from "../lib/gate8-w11-native-checks";
import { decodeRecording } from "../lib/render-stream-2";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, "..", "..", "protocol", "golden-11");

let assertions = 0;
let failures = 0;
function assert(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}`);
  }
}

const records = async (name: string) =>
  decodeRecording(new Uint8Array(await readFile(join(GOLDEN, name))), 11).records;

// 1
{
  const inline = messagesPerTransaction(await records("inline.rs11"), 0);
  assert(inline.transactions === 23, `inline.rs11: 23 transactions (got ${inline.transactions})`);
  assert(inline.records > 0 && inline.perTx > 1, `inline.rs11: records counted (${inline.perTx})`);
  const patch = messagesPerTransaction(await records("patch.rs11"), 0);
  assert(patch.records === 0 && patch.perTx === 1, `patch.rs11: one message a transaction (${patch.perTx})`);
  const warm = messagesPerTransaction(await records("inline.rs11"), 23);
  assert(warm.transactions === 0 && warm.perTx === 0, "every transaction warm-up: nothing counted");
  const late = messagesPerTransaction(await records("inline.rs11"), 10);
  assert(late.transactions === 13 && late.records <= inline.records, "warm-up transactions excluded");
}

// 2
{
  const planned = new Set(W11_GSW_LEGS.map(nativeLeg));
  for (const leg of [...NATIVE_HONEST, ...NATIVE_TWINS.flat(), ...Object.values(NATIVE_SABOTAGE_LEGS)])
    assert(planned.has(leg), `${leg} is planned by gate8-w11-tool.ts native-plan`);
  assert(planned.size === W11_GSW_LEGS.length, "one native leg per GSW leg, no two alike");
  assert(
    nativeLeg({ leg: "x", capture: "scene/off/capture", sink: "s", version: 11, frames: "scene", sabotage: "no-prune" }) ===
      "scene/off/sabotage-no-prune/receiver",
    "a sabotage leg sits beside its capture's receiver",
  );
}

console.log(`\nself-test-gate8-w11-native: ${assertions - failures}/${assertions} assertions passed`);
process.exit(failures === 0 ? 0 : 1);
