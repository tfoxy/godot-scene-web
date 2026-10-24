// G7rf self-test: the GSW receiver's fold-during-resync-wait decision (web/gsw-receiver/fold.ts
// foldedFullIndex). receiver.gd's twin is checked by receiver/tests/receiver_selftest.gd.

import { foldedFullIndex } from "../../web/gsw-receiver/fold";

let failures = 0;
function check(name: string, got: number, want: number): void {
  if (got === want) return;
  failures++;
  console.log(`FAIL ${name}: got ${got}, want ${want}`);
}
const p = { encoding: "patch" };
const f = { encoding: "full" };
// The G7w2c bug: the forced full and the next patch in one poll.
check("full + newest patch", foldedFullIndex([f, p], "patch"), 0);
check("patch, full + newest patch", foldedFullIndex([p, f, p], "patch"), 1);
check(
  "full in the middle of several",
  foldedFullIndex([p, f, p, p], "patch"),
  1,
);
check("newest is the full itself", foldedFullIndex([p, p], "full"), -1);
check("no full in the fold", foldedFullIndex([p, p], "patch"), -1);
check("empty fold", foldedFullIndex([], "patch"), -1);
if (failures > 0) process.exit(1);
console.log("self-test-gate7rf ok (6 checks)");
