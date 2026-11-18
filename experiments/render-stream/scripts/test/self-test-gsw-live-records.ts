#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the GSW live receiver's record table (web/gsw-receiver/records.ts):
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gsw-live-records.ts
//
// 1. Every `ACCEPT_*` code the client ABI exports (packages/render-stream-client/src/abi.ts) has a
//    kind, so a code added to the ABI cannot fall through to live.ts's transaction path unnoticed.
// 2. Only ACCEPT_TRANSACTION and ACCEPT_NEEDS_PAYLOADS are transactions. A /15 `resource_hint` or
//    `resource_unhint` taken for one replaced the pending seq 1's needed set with an empty one at
//    credit window 2, and seq 1 failed `shader 1 (...): its code is not held` whenever seq 2 came
//    later than the hints (g8vl's rendered-host legs).
// 3. A code outside the ABI has no kind (live.ts fails it instead of applying it).
//
// Exits non-zero if any assertion fails.

import * as abi from "../../../../packages/render-stream-client/src/abi";
import { liveRecordKind } from "../../web/gsw-receiver/records";

let assertions = 0;
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  assertions++;
  if (!ok) failures.push(what);
}

const codes: [string, number][] = [];
for (const [name, value] of Object.entries(abi) as [string, unknown][])
  if (name.startsWith("ACCEPT_") && typeof value === "number")
    codes.push([name, value]);
check(
  codes.length >= 8,
  `abi.ts exports ${codes.length} ACCEPT_* codes, expected at least 8`,
);

for (const [name, code] of codes) {
  const kind = liveRecordKind(code);
  check(kind !== null, `${name} (${code}) has no live record kind`);
  const transaction =
    code === abi.ACCEPT_TRANSACTION || code === abi.ACCEPT_NEEDS_PAYLOADS;
  check(
    (kind === "transaction") === transaction,
    `${name} (${code}) is ${kind}, expected ${transaction ? "transaction" : "not a transaction"}`,
  );
}

check(
  liveRecordKind(abi.ACCEPT_RESOURCE_HINT) === "skip",
  "resource_hint is not skipped",
);
check(
  liveRecordKind(abi.ACCEPT_RESOURCE_UNHINT) === "skip",
  "resource_unhint is not skipped",
);
check(
  liveRecordKind(abi.ACCEPT_RESOURCE) === "resource",
  "a resource record is not a resource",
);
check(
  liveRecordKind(abi.ACCEPT_END) === "end",
  "the end record is not the end",
);
const unknown = Math.max(...codes.map((c) => c[1])) + 1;
check(liveRecordKind(unknown) === null, `unknown code ${unknown} has a kind`);

for (const f of failures) console.error(`FAIL ${f}`);
console.log(
  `self-test-gsw-live-records: ${assertions - failures.length}/${assertions} assertions passed`,
);
process.exit(failures.length === 0 ? 0 : 1);
