#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for R3's remote timing-group skip inside gate 7's gsw sources (lib/gate7-gsw.ts
// remoteSkipExcused; run-gate7.sh writes the source's tier-verdict.py verdict). Pure.

import { judgedCheck, remoteSkipExcused } from "../lib/gate7-gsw";

let failures = 0;
function check(name: string, ok: boolean): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
const ids = (s: Set<string>) => [...s].sort().join(",");

const failing = [
  "live-rate-30-rate",
  "g1d-stall-holds",
  "receiver-vs-reference",
];
const pass = {
  verdict: "pass",
  skipped_by_tier: ["live-rate-30-rate", "g1d-stall-holds"],
  skipped_remote_groups: ["g1c-rate", "g1d"],
};
check(
  "remote skip: exactly the ids tier-verdict excused",
  ids(remoteSkipExcused(failing, pass, "1")) ===
    "g1d-stall-holds,live-rate-30-rate",
);
check(
  "no RS_SKIP_TIMING_GROUPS (local): nothing excused",
  remoteSkipExcused(failing, pass, undefined).size === 0,
);
check(
  "empty RS_SKIP_TIMING_GROUPS: nothing excused",
  remoteSkipExcused(failing, pass, "").size === 0,
);
check(
  "no verdict file: nothing excused",
  remoteSkipExcused(failing, null, "1").size === 0,
);
check(
  "a failing verdict: nothing excused",
  remoteSkipExcused(failing, { ...pass, verdict: "fail" }, "1").size === 0,
);
check(
  "no group skipped remotely (a tier skip only): nothing excused",
  remoteSkipExcused(failing, { ...pass, skipped_remote_groups: [] }, "1")
    .size === 0,
);
check(
  "a correctness check never excused",
  !remoteSkipExcused(failing, pass, "1").has("receiver-vs-reference"),
);

// gate 5's report carries `receiver-vs-reference` twice: g5d's file legs, then g5f's live legs
// (skipped remotely: "no checkpoints"). The gsw fold judges the gate's own first one.
const gate5 = [
  { id: "leg-class-receiver", passed: true, detail: "success" },
  {
    id: "receiver-vs-reference",
    passed: true,
    detail: "20 shots identical to the reference",
  },
  {
    id: "receiver-vs-reference",
    passed: false,
    detail: "live-mesh: no checkpoints",
  },
];
const j = judgedCheck(gate5, "receiver-vs-reference");
check(
  "same-id checks: the gate's own first check is judged (g5d file legs, not g5f's live legs)",
  j.check === gate5[1] && j.shadowed === 1,
);
const bad = judgedCheck(
  [
    { ...gate5[1], passed: false, detail: "receiver/shots/seq-8.png: 3 px" },
    gate5[2],
  ],
  "receiver-vs-reference",
);
check(
  "same-id checks: a failing file-leg comparison still fails",
  bad.check?.passed === false,
);
const once = judgedCheck(gate5, "leg-class-receiver");
check(
  "a unique id: judged as is",
  once.check === gate5[0] && once.shadowed === 0,
);
check(
  "an absent id: undefined",
  judgedCheck(gate5, "nope").check === undefined,
);

console.log(
  failures ? `${failures} FAILED` : "self-test-remote-skip-source: all passed",
);
process.exit(failures ? 1 : 0);
