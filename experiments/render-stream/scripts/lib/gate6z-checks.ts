// Gate 6 group G6z (protocol/gate6-design.md "G6z", "Q8"): the four supported-feature-manifest
// checks, run against an EXISTING gate 6 run directory (no capture of its own). Reuses whichever
// of g6a's and g6b's recordings are present in `out` to verify the manifest's `features` lists
// against the real wire, and g6a's `refused`/g6b's `snap` legs to verify `manifest-refused`.

import { readFile } from "node:fs/promises";

import {
  buildManifest,
  type FeatureManifest,
  MANIFEST_PATH,
  serializeManifest,
} from "../make-features";
import { loadRecording, RECORDING_NAME } from "./gate0-checks";
import { check } from "./gate3-checks";
import { type Gate6Check, unsupportedPairs } from "./gate6a-checks";

export interface G6zResult {
  checks: Gate6Check[];
}

/** Recordings whose session.features this run's `out` directory might hold, in preference
 * order. make-features.ts's wire-derived lists are a static property of the build (every /6
 * session declares the same ones), so one present recording is enough to prove the manifest
 * matches the wire; checking more than one adds robustness at no real cost. */
const SESSION_CANDIDATES: readonly { label: string; dir: string }[] = [
  { label: "g6a scene/capture", dir: "scene/capture" },
  { label: "g6a scene/capture-inline", dir: "scene/capture-inline" },
  { label: "g6a animate/capture", dir: "animate/capture" },
  { label: "g6h hd/capture-native", dir: "hd/capture-native" },
];

function byKind<T extends { kind: FeatureManifest["entries"][number]["kind"] }>(
  entries: readonly T[],
  kind: T["kind"],
): T[] {
  return entries.filter((e) => e.kind === kind);
}

/** Compares one session's wire-declared lists (features.ops etc.) against the manifest's
 * corresponding entries, per kind, per status. Returns a human-readable problem per mismatch. */
export function compareSessionToManifest(
  label: string,
  features: {
    ops: string[];
    item_state: string[];
    canvas_state?: string[];
    resources: string[];
    unsupported_resources: Array<{ resource: string; reason: string }>;
    observed_unsupported_ops: string[];
    unobserved: string[];
  },
  manifest: FeatureManifest,
): string[] {
  const problems: string[] = [];
  const ops = byKind(manifest.entries, "op");
  const itemState = byKind(manifest.entries, "item_state");
  const canvasState = byKind(manifest.entries, "canvas_state");
  const resources = byKind(manifest.entries, "resource");

  const expectSet = (
    what: string,
    manifestIds: readonly string[],
    wireIds: readonly string[],
  ): void => {
    const a = [...manifestIds].sort();
    const b = [...wireIds].sort();
    if (a.length !== b.length || a.some((v, i) => v !== b[i]))
      problems.push(
        `${label}: ${what} manifest=[${a.join(",")}] wire=[${b.join(",")}]`,
      );
  };

  expectSet(
    "ops supported",
    ops.filter((e) => e.status === "supported").map((e) => e.id),
    features.ops,
  );
  expectSet(
    "ops typed-unsupported",
    ops.filter((e) => e.status === "typed-unsupported").map((e) => e.id),
    features.observed_unsupported_ops,
  );
  expectSet(
    "ops unobserved",
    ops.filter((e) => e.status === "unobserved").map((e) => e.id),
    features.unobserved,
  );
  expectSet(
    "item_state supported",
    itemState.filter((e) => e.status === "supported").map((e) => e.name),
    features.item_state,
  );
  if (features.canvas_state)
    expectSet(
      "canvas_state supported",
      canvasState.filter((e) => e.status === "supported").map((e) => e.name),
      features.canvas_state,
    );
  expectSet(
    "resources supported",
    resources.filter((e) => e.status === "supported").map((e) => e.name),
    features.resources,
  );
  expectSet(
    "resources typed-unsupported",
    resources
      .filter((e) => e.status === "typed-unsupported")
      .map((e) => e.name),
    features.unsupported_resources.map((r) => r.resource),
  );
  for (const { resource, reason } of features.unsupported_resources) {
    const entry = resources.find((e) => e.name === resource);
    if (entry && entry.reason !== reason)
      problems.push(
        `${label}: resource ${resource} wire reason ${reason} != manifest reason ${entry.reason}`,
      );
  }
  return problems;
}

export async function runGate6z(out: string): Promise<G6zResult> {
  const checks: Gate6Check[] = [];

  // manifest-check: make-features.ts regenerates protocol/features/render-stream-6.json
  // byte-identically (also re-runs its cross-check of feature-evidence.ts against the
  // rs_publish.cpp-derived wire lists -- a drift there surfaces here as a thrown error).
  {
    const problems: string[] = [];
    let onDisk: string | null = null;
    try {
      onDisk = await readFile(MANIFEST_PATH, "utf8");
    } catch {
      problems.push(`${MANIFEST_PATH} does not exist`);
    }
    let regenerated: string | null = null;
    try {
      regenerated = serializeManifest(buildManifest());
    } catch (error) {
      problems.push(`make-features.ts build failed: ${String(error)}`);
    }
    if (onDisk !== null && regenerated !== null && onDisk !== regenerated)
      problems.push(
        `${MANIFEST_PATH} is stale: regenerated output differs byte-for-byte`,
      );
    checks.push(
      check(
        "manifest-check",
        "scripts/make-features.ts --check regenerates protocol/features/render-stream-6.json byte-identically",
        problems,
        `${MANIFEST_PATH} up to date`,
        [MANIFEST_PATH],
      ),
    );
  }

  let manifest: FeatureManifest | null = null;
  try {
    manifest = buildManifest();
  } catch {
    manifest = null;
  }

  // manifest-matches-session: every gate 6 capture's session features lists equal the
  // manifest's supported/typed-unsupported names exactly, per kind (Q8).
  {
    const problems: string[] = [];
    let checked = 0;
    if (!manifest) {
      problems.push("manifest did not build");
    } else {
      for (const { label, dir } of SESSION_CANDIDATES) {
        const rec = await loadRecording(`${out}/${dir}/${RECORDING_NAME}`);
        if (!rec.present || !rec.session?.features) continue;
        checked++;
        problems.push(
          ...compareSessionToManifest(label, rec.session.features, manifest),
        );
      }
      if (checked === 0)
        problems.push(
          `no session recording found under any of ${SESSION_CANDIDATES.map((c) => c.dir).join(", ")}`,
        );
    }
    checks.push(
      check(
        "manifest-matches-session",
        "every gate 6 capture's session features lists equal the manifest's supported and typed-unsupported names exactly, per kind (ops, item_state, canvas_state, resources)",
        problems,
        `${checked} session(s) checked, all matched`,
        SESSION_CANDIDATES.map((c) => `${c.dir}/${RECORDING_NAME}`),
      ),
    );
  }

  // manifest-evidence (every supported entry's gate6 evidence check id appears as pass) needs
  // the FULL accumulated report of every group check-gate6.ts ran before g6z, which this
  // function does not have -- see verifyManifestEvidence() below, called by check-gate6.ts.

  // manifest-refused: every reason the refused variant and the snap leg produced is a
  // typed-unsupported entry.
  {
    const problems: string[] = [];
    if (!manifest) {
      problems.push("manifest did not build");
    } else {
      const observedReasons = new Set<string>();
      for (const dir of ["refused/capture", "snap/capture"]) {
        const rec = await loadRecording(`${out}/${dir}/${RECORDING_NAME}`);
        if (!rec.present) continue;
        for (const pair of unsupportedPairs(rec))
          observedReasons.add(pair.split("/").slice(1).join("/"));
      }
      if (observedReasons.size === 0)
        problems.push(
          "neither refused/capture nor snap/capture produced any recording",
        );
      const typedReasons = new Set(
        manifest.entries
          .filter((e) => e.status === "typed-unsupported" && e.reason)
          .map((e) => e.reason as string),
      );
      for (const reason of observedReasons)
        if (!typedReasons.has(reason))
          problems.push(
            `reason "${reason}" observed on the wire (refused or snap leg) has no typed-unsupported manifest entry`,
          );
    }
    checks.push(
      check(
        "manifest-refused",
        "every reason the refused variant and the snap leg produced on the wire is a typed-unsupported manifest entry",
        problems,
        "every observed refusal reason is typed in the manifest",
        ["refused/capture", "snap/capture"].map(
          (d) => `${d}/${RECORDING_NAME}`,
        ),
      ),
    );
  }

  return { checks };
}

/** Replaces the placeholder `manifest-evidence` check above with a real one, now that the
 * caller (check-gate6.ts) has the full accumulated report of every earlier group's checks run
 * in this invocation -- g6z cites some of them as evidence for "supported" entries. */
export function verifyManifestEvidence(
  manifest: FeatureManifest,
  priorChecks: readonly Gate6Check[],
): Gate6Check {
  const passed = new Set(
    priorChecks.filter((c) => c.status === "pass").map((c) => c.id),
  );
  const problems: string[] = [];
  for (const e of manifest.entries) {
    if (e.status !== "supported") continue;
    for (const ref of e.evidence) {
      if (ref.gate !== "gate6") continue;
      if (!passed.has(ref.check))
        problems.push(
          `${e.kind}:${e.id} cites gate6 check "${ref.check}", which did not pass in this run`,
        );
    }
  }
  return check(
    "manifest-evidence",
    "every supported entry's gate6 evidence check id appears as pass in the gate 6 run quoted by the summary",
    problems,
    "every gate6-cited evidence check passed in this run",
    [],
  );
}
