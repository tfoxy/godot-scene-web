#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for g7-8's group shards (run-gate7.sh GATE7_G8_LEGS; lib/gate7-gsw-g8.ts gate8Lists):
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate7-g8-shard.ts
//
// 1. Every gsw leg, not-applicable leg, compositor leg, judged check and not-applicable check of
//    gate 8 belongs to exactly one group of run-gate7.sh's G8_FILE_LEGS (read from the script, so a
//    new group cannot be forgotten), every group has legs, and the web half's GATE8_FILE_GROUPS is
//    a subset of it.
// 2. For the full set (and a source with no legs.json) the restricted lists are today's tables
//    exactly, through gswLegDefs/gswNotApplicable/gswReceiverChecks on a fabricated source too.
// 3. For every two-way partition of G8_FILE_LEGS (g8mm and g8pt together), the singleton partition
//    and a few three-way ones: the restricted lists of the parts are disjoint and their union is
//    the full lists.
// 4. run-gate7.sh refuses (exit 2, before any run) a non-member, a value that parses to no group
//    and a g8mm/g8pt split, and normalizes a valid subset to G8_FILE_LEGS order.
//
// Exits non-zero if any assertion fails.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GSW_LEGS,
  GSW_NOT_APPLICABLE,
  GSW_RECEIVER_CHECKS,
  gswLegDefs,
  gswNotApplicable,
  gswReceiverChecks,
} from "../lib/gate7-gsw";
import {
  GATE8_CHECKS_NA_BY_GROUP,
  GATE8_COMPOSITOR_LEGS,
  GATE8_JUDGED_BY_GROUP,
  GATE8_LEGS,
  GATE8_NOT_APPLICABLE,
  GATE8_RECEIVER_CHECKS,
  type Gate8Lists,
  gate8GroupOf,
  gate8Lists,
  gate8SourceGroups,
} from "../lib/gate7-gsw-g8";
import { GATE8_FILE_GROUPS } from "../lib/gate7b-adapters";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_GATE7 = resolve(HERE, "..", "run-gate7.sh");

let assertions = 0;
let failures = 0;
function assert(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}`);
  }
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const m = /^G8_FILE_LEGS=(\S+)$/m.exec(readFileSync(RUN_GATE7, "utf8"));
assert(m !== null, "run-gate7.sh defines G8_FILE_LEGS");
const G8 = (m?.[1] ?? "").split(",");
assert(
  G8.length >= 12,
  `G8_FILE_LEGS lists the gate 8 file groups (${G8.join(",")})`,
);

// 1
{
  const member = (g: string) => G8.includes(g);
  for (const d of GATE8_LEGS) {
    assert(
      member(gate8GroupOf(d.leg)),
      `leg ${d.leg}: group ${gate8GroupOf(d.leg)} is in G8_FILE_LEGS`,
    );
    if (d.from)
      assert(
        gate8GroupOf(d.from) === gate8GroupOf(d.leg),
        `leg ${d.leg}: derived from its own group's ${d.from}`,
      );
  }
  for (const n of GATE8_NOT_APPLICABLE)
    assert(
      member(gate8GroupOf(n.leg)),
      `not-applicable ${n.leg}: group in G8_FILE_LEGS`,
    );
  for (const l of GATE8_COMPOSITOR_LEGS) {
    assert(member(gate8GroupOf(l)), `compositor ${l}: group in G8_FILE_LEGS`);
    assert(
      GATE8_LEGS.some((d) => d.leg === l),
      `compositor ${l} is a gsw leg`,
    );
  }
  const seen = new Map<string, string>();
  for (const [g, ids] of Object.entries(GATE8_JUDGED_BY_GROUP)) {
    assert(member(g), `judged group ${g} is in G8_FILE_LEGS`);
    for (const id of ids) {
      assert(
        !seen.has(id),
        `judged ${id} in one group only (${seen.get(id) ?? ""} and ${g})`,
      );
      seen.set(id, g);
    }
  }
  for (const [g, na] of Object.entries(GATE8_CHECKS_NA_BY_GROUP)) {
    assert(member(g), `not-applicable check group ${g} is in G8_FILE_LEGS`);
    for (const id of Object.keys(na))
      assert(!seen.has(id), `not-applicable check ${id} is not also judged`);
  }
  for (const g of G8)
    assert(
      GATE8_LEGS.some((d) => gate8GroupOf(d.leg) === g),
      `group ${g} has gsw legs`,
    );
  for (const g of GATE8_FILE_GROUPS)
    assert(member(g), `web GATE8_FILE_GROUPS ${g} is in G8_FILE_LEGS`);
}

// 2
const full: Gate8Lists = {
  legs: GATE8_LEGS,
  notApplicable: GATE8_NOT_APPLICABLE,
  checks: GATE8_RECEIVER_CHECKS,
  compositor: [...GATE8_COMPOSITOR_LEGS],
};
{
  assert(same(gate8Lists(null), full), "no groups_run: the full tables");
  assert(
    same(gate8Lists(new Set(G8)), full),
    "every G8_FILE_LEGS group: the full tables, in order",
  );
  assert(
    same(gate8Lists(new Set([...G8, "g8l", "g8kc"])), full),
    "a superset source (the cache's `all`): the full tables",
  );
  assert(same(GSW_LEGS.gate8, GATE8_LEGS), "GSW_LEGS.gate8 is GATE8_LEGS");
  assert(
    same(GSW_RECEIVER_CHECKS.gate8, GATE8_RECEIVER_CHECKS),
    "GSW_RECEIVER_CHECKS.gate8 is GATE8_RECEIVER_CHECKS",
  );
  const dir = mkdtempSync(join(tmpdir(), "g7-g8-shard-"));
  try {
    assert(gate8SourceGroups(dir) === null, "no legs.json: null");
    assert(
      same(gswLegDefs("gate8", dir), GSW_LEGS.gate8),
      "no legs.json: every gsw leg",
    );
    writeFileSync(join(dir, "legs.json"), JSON.stringify({ groups_run: G8 }));
    assert(
      same(gswLegDefs("gate8", dir), GSW_LEGS.gate8),
      "full source: gswLegDefs unchanged",
    );
    assert(
      same(gswNotApplicable("gate8", dir), GSW_NOT_APPLICABLE.gate8),
      "full source: gswNotApplicable unchanged",
    );
    assert(
      same(gswReceiverChecks("gate8", dir), GSW_RECEIVER_CHECKS.gate8),
      "full source: gswReceiverChecks unchanged",
    );
    writeFileSync(
      join(dir, "legs.json"),
      JSON.stringify({ groups_run: ["g8c", "g8cg", "g8m"] }),
    );
    const legs = gswLegDefs("gate8", dir).map((d) => d.leg);
    assert(
      legs.length > 0 && legs.every((l) => /^g8(c|cg|m)\//.test(l)),
      `subset source: only its groups' legs (${legs.length})`,
    );
    assert(
      !gswReceiverChecks("gate8", dir).judged.includes("decode-reference") &&
        gswReceiverChecks("gate8", dir).judged.includes("cg-adopt"),
      "subset source: g8t's checks dropped, g8cg's kept",
    );
    assert(
      same(gswLegDefs("gate6", dir), GSW_LEGS.gate6),
      "another gate: its full table whatever the source",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3
{
  const units = G8.filter((g) => g !== "g8pt").map((g) =>
    g === "g8mm" ? ["g8mm", "g8pt"] : [g],
  );
  const partitions: string[][][] = [];
  for (let mask = 1; mask < 1 << (units.length - 1); mask++) {
    const a: string[] = [];
    const b: string[] = [];
    for (const [i, u] of units.entries())
      (i > 0 && mask & (1 << (i - 1)) ? a : b).push(...u);
    partitions.push([a, b]);
  }
  partitions.push(units);
  for (let k = 0; k < 8; k++) {
    const parts: string[][] = [[], [], []];
    for (const [i, u] of units.entries())
      parts[(i * 7 + k * 3 + ((i * k) % 5)) % 3].push(...u);
    partitions.push(parts.filter((p) => p.length > 0));
  }
  const key = {
    legs: (l: Gate8Lists) => l.legs.map((d) => d.leg),
    notApplicable: (l: Gate8Lists) => l.notApplicable.map((n) => n.leg),
    judged: (l: Gate8Lists) => l.checks.judged,
    checksNa: (l: Gate8Lists) => Object.keys(l.checks.notApplicable),
    compositor: (l: Gate8Lists) => l.compositor,
  };
  let bad = 0;
  for (const p of partitions) {
    const lists = p.map((part) => gate8Lists(new Set(part)));
    for (const [name, f] of Object.entries(key)) {
      const parts = lists.flatMap(f);
      const want = f(full);
      const ok =
        parts.length === want.length &&
        new Set(parts).size === parts.length &&
        same([...parts].sort(), [...want].sort());
      if (!ok) {
        bad++;
        if (bad <= 5)
          console.log(
            `  partition ${p.map((x) => x.join("+")).join(" | ")}: ${name} not a disjoint cover`,
          );
      }
    }
    // A part's restricted legs keep the full table's entries (env, from, compositor) unchanged.
    for (const l of lists)
      for (const d of l.legs)
        if (
          !same(
            d,
            GATE8_LEGS.find((x) => x.leg === d.leg),
          )
        )
          bad++;
  }
  assert(
    bad === 0,
    `${partitions.length} partitions: every list a disjoint cover of the full list (${bad} bad)`,
  );
}

// 4
{
  const run = (value: string, extra: string[] = []) => {
    const r = spawnSync("bash", [RUN_GATE7, ...extra], {
      encoding: "utf8",
      env: { ...process.env, GATE7_G8_LEGS: value },
      timeout: 120_000,
    });
    return { status: r.status, err: r.stderr ?? "" };
  };
  const nonMember = run("g8c,g8zz");
  assert(
    nonMember.status === 2 &&
      /g8zz is not a gate 8 file group/.test(nonMember.err),
    `non-member: exit 2 (${nonMember.status}: ${nonMember.err.trim()})`,
  );
  const live = run("g8l");
  assert(
    live.status === 2 && /g8l is not a gate 8 file group/.test(live.err),
    `a live group: exit 2 (${live.status})`,
  );
  for (const v of [",", " , ,"]) {
    const empty = run(v);
    assert(
      empty.status === 2 && /names no group/.test(empty.err),
      `'${v}': exit 2 (${empty.status}: ${empty.err.trim()})`,
    );
  }
  for (const v of ["g8mm", "g8pt,g8c", "g8t,g8mm,g8a"]) {
    const split = run(v);
    assert(
      split.status === 2 &&
        /g8mm and g8pt must be in the same subset/.test(split.err),
      `${v}: exit 2 (${split.status}: ${split.err.trim()})`,
    );
  }
  // A valid subset passes the check (normalized), then stops at D28's selection refusal (--env
  // device without --device): exit 2, nothing run.
  const ok = run(" g8pt, g8c,g8mm,", ["--env", "device"]);
  assert(
    /the gate 8 source runs g8c,g8mm,g8pt\n/.test(ok.err),
    `valid subset normalized (${ok.err.trim()})`,
  );
  assert(
    ok.status === 2 && /refusing/.test(ok.err),
    `valid subset reaches the selection check (${ok.status})`,
  );
  const unset = run("", ["--env", "device"]);
  assert(
    !/GATE7_G8_LEGS/.test(unset.err) && unset.status === 2,
    "empty: no subset, the selection check as before",
  );
}

console.log(
  `self-test-gate7-g8-shard: ${assertions - failures}/${assertions} assertions passed`,
);
process.exit(failures === 0 ? 0 : 1);
