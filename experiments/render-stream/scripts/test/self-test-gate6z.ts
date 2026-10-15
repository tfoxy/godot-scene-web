// Self-test for gate 6 group g6z (scripts/make-features.ts, lib/feature-evidence.ts,
// lib/gate6z-checks.ts), driven from self-test-gate6.ts's main: every pure evaluator with a
// passing and a failing case, never a real Godot run.
//
//  1. validateManifestShape: the real, committed FEATURE_ENTRIES passes (every "supported" entry
//     has evidence, every "typed-unsupported" has a reason and owner, every "unobserved" has an
//     owner and notes, every "declared-unverified" has notes); mutated copies of each rule fail.
//  2. crossCheckWireLists: the real FEATURE_ENTRIES passes; a copy with one wire-listed id's
//     status flipped throws; a copy missing a wire-listed id throws; a copy with an extra
//     op-kind entry naming an unknown id throws.
//  3. buildManifest/serializeManifest: deterministic (two calls serialize byte-identically) and
//     entries are sorted by kind (Q8's listed order) then id.
//  4. compareSessionToManifest: a session whose features lists exactly match the manifest's
//     supported/typed-unsupported/unobserved names produces no problems; dropping one supported
//     op from the session, or adding an extra typed-unsupported op, each produces exactly one.
//  5. verifyManifestEvidence: passes when every gate6-cited evidence check appears as pass in
//     the prior checks; fails, naming the entry, when one such check is missing or failed.

import { FEATURE_ENTRIES, type FeatureEntry } from "../lib/feature-evidence";
import {
  compareSessionToManifest,
  verifyManifestEvidence,
} from "../lib/gate6z-checks";
import {
  buildManifest,
  crossCheckWireLists,
  OPS_V6,
  validateManifestShape,
} from "../make-features";
import type { SelfTestHooks } from "./self-test-gate6l";

function clone(entries: readonly FeatureEntry[]): FeatureEntry[] {
  return entries.map((e) => ({ ...e, evidence: [...e.evidence] }));
}

export function selfTestG6z(hooks: SelfTestHooks): void {
  const { assert, passes, fails } = hooks;

  // 1. validateManifestShape.
  passes(
    "the real manifest's entries satisfy Q8's per-status shape rules",
    validateManifestShape(FEATURE_ENTRIES),
  );
  {
    const broken = clone(FEATURE_ENTRIES);
    const i = broken.findIndex((e) => e.status === "supported");
    broken[i] = { ...broken[i], evidence: [] };
    fails(
      "a supported entry with no evidence fails shape validation",
      validateManifestShape(broken),
      "supported needs at least one evidence entry",
    );
  }
  {
    const broken = clone(FEATURE_ENTRIES);
    const i = broken.findIndex((e) => e.status === "typed-unsupported");
    broken[i] = { ...broken[i], owner: null };
    fails(
      "a typed-unsupported entry with no owner fails shape validation",
      validateManifestShape(broken),
      "typed-unsupported needs reason and owner",
    );
  }
  {
    const broken = clone(FEATURE_ENTRIES);
    const i = broken.findIndex((e) => e.status === "unobserved");
    broken[i] = { ...broken[i], notes: null };
    fails(
      "an unobserved entry with no notes fails shape validation",
      validateManifestShape(broken),
      "unobserved needs owner and notes",
    );
  }
  {
    const broken = clone(FEATURE_ENTRIES);
    const i = broken.findIndex((e) => e.status === "declared-unverified");
    broken[i] = { ...broken[i], notes: null };
    fails(
      "a declared-unverified entry with no notes fails shape validation",
      validateManifestShape(broken),
      "declared-unverified needs notes",
    );
  }

  // 2. crossCheckWireLists.
  {
    let threw = false;
    try {
      crossCheckWireLists(FEATURE_ENTRIES);
    } catch {
      threw = true;
    }
    assert(
      "the real manifest's entries cross-check against the wire-derived lists",
      !threw,
    );
  }
  {
    const broken = clone(FEATURE_ENTRIES);
    const i = broken.findIndex((e) => e.kind === "op" && e.id === OPS_V6[0]);
    broken[i] = { ...broken[i], status: "unobserved" };
    let threw = false;
    try {
      crossCheckWireLists(broken);
    } catch {
      threw = true;
    }
    assert(`flipping ${OPS_V6[0]}'s status away from supported throws`, threw);
  }
  {
    const broken = FEATURE_ENTRIES.filter(
      (e) => !(e.kind === "op" && e.id === OPS_V6[0]),
    );
    let threw = false;
    try {
      crossCheckWireLists(broken);
    } catch {
      threw = true;
    }
    assert(`removing ${OPS_V6[0]}'s entry entirely throws`, threw);
  }
  {
    const broken: FeatureEntry[] = [
      ...clone(FEATURE_ENTRIES),
      {
        id: "not_a_real_op",
        kind: "op",
        name: "not_a_real_op",
        status: "supported",
        reason: null,
        exactness: null,
        evidence: [],
        owner: null,
        notes: null,
      },
    ];
    let threw = false;
    try {
      crossCheckWireLists(broken);
    } catch {
      threw = true;
    }
    assert("an extra op-kind entry naming an unknown id throws", threw);
  }

  // 3. buildManifest/serializeManifest determinism and ordering.
  {
    const a = buildManifest();
    const b = buildManifest();
    assert(
      "buildManifest is deterministic across two calls",
      JSON.stringify(a) === JSON.stringify(b),
    );
    const kindOrder = [
      "op",
      "item_state",
      "canvas_state",
      "resource",
      "payload",
      "material",
      "viewport",
      "delivery",
      "text",
      "control",
    ];
    let sorted = true;
    for (let i = 1; i < a.entries.length; i++) {
      const prevKind = kindOrder.indexOf(a.entries[i - 1].kind);
      const curKind = kindOrder.indexOf(a.entries[i].kind);
      if (
        curKind < prevKind ||
        (curKind === prevKind && a.entries[i].id < a.entries[i - 1].id)
      )
        sorted = false;
    }
    assert("manifest entries are sorted by kind (Q8 order) then id", sorted);
  }

  // 4. compareSessionToManifest.
  const manifest = buildManifest();
  const honestFeatures = {
    ops: manifest.entries
      .filter((e) => e.kind === "op" && e.status === "supported")
      .map((e) => e.id),
    item_state: manifest.entries
      .filter((e) => e.kind === "item_state" && e.status === "supported")
      .map((e) => e.name),
    canvas_state: manifest.entries
      .filter((e) => e.kind === "canvas_state" && e.status === "supported")
      .map((e) => e.name),
    resources: manifest.entries
      .filter((e) => e.kind === "resource" && e.status === "supported")
      .map((e) => e.name),
    unsupported_resources: manifest.entries
      .filter((e) => e.kind === "resource" && e.status === "typed-unsupported")
      .map((e) => ({ resource: e.name, reason: e.reason as string })),
    observed_unsupported_ops: manifest.entries
      .filter((e) => e.kind === "op" && e.status === "typed-unsupported")
      .map((e) => e.id),
    unobserved: manifest.entries
      .filter((e) => e.kind === "op" && e.status === "unobserved")
      .map((e) => e.id),
  };
  passes(
    "a session whose features lists exactly match the manifest produces no problems",
    compareSessionToManifest("honest", honestFeatures, manifest),
  );
  fails(
    "a session missing one supported op produces a problem",
    compareSessionToManifest(
      "missing-op",
      { ...honestFeatures, ops: honestFeatures.ops.slice(1) },
      manifest,
    ),
    "ops supported",
  );
  fails(
    "a session with an extra typed-unsupported op produces a problem",
    compareSessionToManifest(
      "extra-unsupported",
      {
        ...honestFeatures,
        observed_unsupported_ops: [
          ...honestFeatures.observed_unsupported_ops,
          "not_a_real_op",
        ],
      },
      manifest,
    ),
    "ops typed-unsupported",
  );

  // 5. verifyManifestEvidence.
  const gate6Checks = new Set<string>();
  for (const e of manifest.entries)
    for (const ref of e.evidence)
      if (ref.gate === "gate6") gate6Checks.add(ref.check);
  const allPassing = [...gate6Checks].map((id) => ({
    id,
    criterion: "",
    passed: true,
    status: "pass" as const,
    detail: "",
    evidence: [],
  }));
  {
    const result = verifyManifestEvidence(manifest, allPassing);
    assert(
      "verifyManifestEvidence passes when every gate6-cited check passed",
      result.passed,
    );
  }
  {
    const droppedId = [...gate6Checks][0];
    const result = verifyManifestEvidence(
      manifest,
      allPassing.filter((c) => c.id !== droppedId),
    );
    assert(
      `verifyManifestEvidence fails when "${droppedId}" is missing from the prior checks`,
      !result.passed && result.detail.includes(droppedId),
    );
  }
}
