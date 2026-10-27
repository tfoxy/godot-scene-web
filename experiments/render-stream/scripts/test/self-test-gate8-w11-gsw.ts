#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for g8w11's GSW checks (lib/gate8-w11-gsw-checks.ts, W11c) and gate8-w11-tool.ts's
// frame choice, on golden-11 and synthetic inputs:
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-w11-gsw.ts
//
// 1. resolvedDynamicDigest: golden-11's inline stream has dynamic transactions (a digest unlike the
//    empty one) and static ones; a body change changes the digest; order of the mesh list does not.
// 2. dynamicAppliedProblems: digests equal to the resolved ones pass; one differing seq and one
//    missing digest each fail, naming the seq.
// 3. sharedFrames: only frames every recording holds, at most n, the last included.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sharedFrames } from "../gate8-w11-tool";
import {
  dynamicAppliedProblems,
  resolvedDynamicDigest,
} from "../lib/gate8-w11-gsw-checks";
import { resolveRecording } from "../lib/render-stream-2";

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

const rec = resolveRecording(
  new Uint8Array(await readFile(join(GOLDEN, "inline.rs11"))),
  11,
);
const empty = resolvedDynamicDigest([]);
const digests = rec.transactions.map((t) =>
  resolvedDynamicDigest(t.state.meshes ?? []),
);
assert(
  digests.some((d) => d !== empty),
  "1: golden-11 has a dynamic transaction",
);
assert(
  digests.some((d) => d === empty),
  "1: golden-11 has a transaction with no dynamic mesh",
);
assert(
  new Set(digests.filter((d) => d !== empty)).size >= 2,
  "1: a body change changes the digest",
);
{
  const t = rec.transactions.find(
    (x) => resolvedDynamicDigest(x.state.meshes ?? []) !== empty,
  );
  const meshes = [...(t?.state.meshes ?? [])];
  assert(
    resolvedDynamicDigest(meshes.reverse()) ===
      resolvedDynamicDigest(t?.state.meshes ?? []),
    "1: the mesh list's order does not matter",
  );
}

const applied = rec.transactions.map((t, i) => ({
  seq: t.seq,
  frame: t.frame,
  dynamic_sha256: digests[i],
}));
{
  const r = dynamicAppliedProblems(rec, applied);
  assert(r.problems.length === 0, `2: equal digests pass (${r.problems})`);
  assert(r.compared === rec.transactions.length, "2: every seq compared");
  const k = digests.findIndex((d) => d !== empty);
  const bad = applied.map((a, i) =>
    i === k ? { ...a, dynamic_sha256: empty } : a,
  );
  const r2 = dynamicAppliedProblems(rec, bad);
  assert(
    r2.problems.length === 1 &&
      r2.problems[0].startsWith(`seq ${applied[k].seq}:`),
    `2: a differing seq fails (${r2.problems})`,
  );
  const missing = applied.map((a, i) =>
    i === 0 ? { seq: a.seq, frame: a.frame } : a,
  );
  assert(
    dynamicAppliedProblems(rec, missing).problems.length === 1,
    "2: a missing digest fails",
  );
}

{
  const m = (frames: number[]) => new Map(frames.map((f, i) => [f, i + 1]));
  const a = m([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const b = m([1, 2, 3, 5, 6, 7, 8, 9, 10, 11]);
  const f = sharedFrames([a, b], 3);
  assert(f.length === 3, `3: three frames (${f})`);
  assert(!f.includes(4) && !f.includes(11), `3: only shared frames (${f})`);
  assert(f[f.length - 1] === 10, `3: the last shared frame is included (${f})`);
  assert(
    JSON.stringify(sharedFrames([m([1, 2]), m([2, 3])], 6)) === "[2]",
    "3: fewer shared than n: all of them",
  );
}

console.log(
  `\nself-test-gate8-w11-gsw: ${assertions - failures}/${assertions} assertions passed`,
);
process.exit(failures === 0 ? 0 : 1);
