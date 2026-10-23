#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the credit-window-2 resync model (pure): gate1-g1d-checks.ts resyncInFlight, the
// seqs the host sent after a refused one before it logged the receiver's resync for it. At window
// 2 a transaction may already be in flight when the resync reaches the host (G7wd made window 2
// the default); at window 1 none can be. checkResyncFull's own pass/fail cases, at both windows,
// are in self-test-gate1.ts (the g1d "window 2" scenarios).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-window2-models.ts

import { resyncInFlight } from "../lib/gate1-g1d-checks";
import type { LiveLogLine } from "../lib/gate1-live-checks";

let failures = 0;
function check(name: string, ok: boolean): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
const same = (a: number[], b: number[]) => a.join() === b.join();

const sent = (frame: number, seq: number, encoding = "patch"): LiveLogLine => ({
  frame,
  t_us: frame,
  sent: { seq, encoding, bytes: 1 },
});
const resync = (frame: number, seq: number, credited = true): LiveLogLine => ({
  frame,
  t_us: frame,
  event: "resync",
  seq,
  credited,
});
// window 1 (and a full window 2): nothing after the refused seq is sent before the resync
const w1 = [sent(1, 288), sent(2, 289), resync(4, 289), sent(4, 290, "full")];
check(
  "window full: nothing in flight after the refused seq",
  same(resyncInFlight(w1, 289), []),
);
// window 2: 471 (a patch on the refused 470) left before the resync arrived (run 39867385871)
const w2 = [
  sent(1, 469),
  sent(2, 470),
  sent(3, 471),
  resync(5, 470),
  resync(6, 471, false),
  sent(5, 472, "full"),
];
check(
  "window 2: the patch sent before the resync is in flight",
  same(resyncInFlight(w2, 470), [471]),
);
check("no resync logged: nothing", same(resyncInFlight(w2, 999), []));
check(
  "a send after the resync is never in flight",
  !resyncInFlight(w2, 470).includes(472),
);
check(
  "a seq sent before the refused one is never in flight",
  !resyncInFlight(w2, 470).includes(469),
);
check(
  "the in-flight seq's own stale resync: nothing was sent after it before",
  same(resyncInFlight(w2, 471), []),
);
// two in flight (more than window 2 allows): both are reported, so the check can count them
const over = [sent(1, 10), sent(2, 11), sent(3, 12), resync(4, 10)];
check(
  "every seq sent before the resync is listed, in seq order",
  same(resyncInFlight(over, 10), [11, 12]),
);

console.log(
  failures ? `${failures} FAILED` : "self-test-window2-models: all passed",
);
process.exit(failures ? 1 : 0);
