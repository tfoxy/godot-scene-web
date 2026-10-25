#!/usr/bin/env -S pnpm exec tsx --conditions=development

// G8z self-test (pure, synthetic): the render-stream-8 manifests and gate 8's profile of
// lib/gate7z-checks.ts. Builds a temporary evidence root from the manifests' own evidence
// references, judges it honest, then mutates it (failed evidence, a stale file, a wrong hello sha,
// a carried run's /7 hello that must be ignored). Also pins the /8 entry set against /7's and the
// hand-off note's environment names against the capture source. Needs no evidence tree.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RECEIVER_KINDS,
  type ReceiverKind,
  receiverFeatureEntries,
  SHORT_KIND,
  validateEntries2,
} from "../lib/feature-evidence-7";
import {
  EVIDENCE_RUNS_8,
  NEW_ENTRY_IDS_8,
  OVERRIDDEN_IDS_8,
  PROFILE_8,
  receiverFeatureEntries8,
} from "../lib/feature-evidence-8";
import { type G7zCheck, type Manifest2, runGate7z } from "../lib/gate7z-checks";
import {
  buildManifest2,
  manifest8Path,
  readCollected,
  serializeManifest2,
} from "../make-features";

let count = 0;
let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  ${detail}`}`);
}

// --- invariants ---------------------------------------------------------------------------
const e8 = new Map(RECEIVER_KINDS.map((k) => [k, receiverFeatureEntries8(k)]));
const e7 = new Map(RECEIVER_KINDS.map((k) => [k, receiverFeatureEntries(k)]));
for (const k of RECEIVER_KINDS) {
  const ids8 = new Set((e8.get(k) ?? []).map((e) => `${e.kind}:${e.id}`));
  const missing = (e7.get(k) ?? []).filter(
    (e) => !ids8.has(`${e.kind}:${e.id}`),
  );
  expect(
    `${k}: every /7 entry is in the /8 file`,
    missing.length === 0,
    missing.map((e) => e.id).join(","),
  );
  expect(
    `${k}: ${NEW_ENTRY_IDS_8.length} new entries, ${OVERRIDDEN_IDS_8.length} overridden`,
    (e8.get(k)?.length ?? 0) ===
      (e7.get(k)?.length ?? 0) + NEW_ENTRY_IDS_8.length,
  );
  expect(
    `${k}: shape rules hold`,
    validateEntries2(e8.get(k) ?? []).length === 0,
    validateEntries2(e8.get(k) ?? []).join("; "),
  );
}
for (const k of ["web-export", "gsw-canvas"] as const) {
  const bad = (e8.get(k) ?? []).filter(
    (e) =>
      e.status === "supported" && e.evidence.some((r) => r.receiver_kind !== k),
  );
  expect(
    `${k}: no supported entry cites another kind`,
    bad.length === 0,
    bad.map((e) => e.id).join(","),
  );
}
const quantized = (e8.get("gsw-canvas") ?? []).filter(
  (e) => e.exactness === "quantized",
);
expect(
  "gsw: float entries are the quantized ones",
  quantized
    .map((e) => e.id)
    .sort()
    .join(",") ===
    "payload.compressed_and_float_texture_formats,payload.float_texture_formats",
  quantized.map((e) => e.id).join(","),
);
expect(
  "gsw: uastc is supported (G8kb)",
  (e8.get("gsw-canvas") ?? []).find(
    (e) => e.id === "delivery.texture_variant_uastc",
  )?.status === "supported",
);
for (const k of RECEIVER_KINDS) {
  const c = readCollected(8).receivers[k];
  expect(
    `${k}: six device targets, none met or not-met (no phone legs at gate 8)`,
    c.device_targets.length === 6 &&
      c.device_targets.every((t) =>
        k === "native"
          ? t.status === "not-applicable"
          : t.status === "unverified",
      ),
  );
}
expect(
  "every new run key has a unique path/kind pair",
  new Set(EVIDENCE_RUNS_8.map((r) => r.key)).size === EVIDENCE_RUNS_8.length,
);

// --- the hand-off note's environment names exist in the capture source ----------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const EXP = resolve(HERE, "..", "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(cpp|h|sh|ts|gd)$/.test(n)) out.push(p);
  }
  return out;
}
const handoff = join(EXP, "protocol", "gate8-product-handoff.md");
if (existsSync(handoff)) {
  const source = walk(join(EXP, "capture", "src"))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  const names = new Set(
    [...readFileSync(handoff, "utf8").matchAll(/\bGRC_[A-Z0-9_]+\b/g)].map(
      (m) => m[0],
    ),
  );
  const unknown = [...names].filter((n) => !source.includes(n));
  expect(
    `hand-off note: ${names.size} GRC_* names all appear in capture/src`,
    names.size > 0 && unknown.length === 0,
    unknown.join(","),
  );
} else expect("hand-off note exists", false, handoff);

// --- a synthetic evidence root ------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "self-test-gate8z-"));
const mdir = join(root, "manifests");
mkdirSync(mdir);
const collected = readCollected(8);
const manifests = new Map<ReceiverKind, Manifest2>();
for (const k of RECEIVER_KINDS)
  manifests.set(
    k,
    JSON.parse(
      serializeManifest2(buildManifest2(k, collected, 8)),
    ) as Manifest2,
  );
const pathOf = (k: ReceiverKind) => join(mdir, `${k}.json`);
const writeManifests = () => {
  for (const [k, m] of manifests)
    writeFileSync(pathOf(k), `${JSON.stringify(m, null, 2)}\n`);
};

interface FakeResult {
  group: string;
  kind: string;
  passed: boolean;
  checks: { id: string; passed: boolean }[];
  legs: Record<string, unknown>;
}
const runs = new Map<
  string,
  {
    results: FakeResult[];
    native: { id: string; status: string }[];
    gate8: { id: string; passed: boolean }[];
  }
>();
const runOf = (p: string) => {
  let r = runs.get(p);
  if (!r) {
    r = { results: [], native: [], gate8: [] };
    runs.set(p, r);
  }
  return r;
};
for (const m of manifests.values())
  for (const e of m.entries)
    for (const ref of e.evidence) {
      const short = SHORT_KIND[ref.receiver_kind];
      const q = EVIDENCE_RUNS_8.find((r) => r.key === `${ref.gate}@${short}`);
      if (!q) continue;
      const run = runOf(q.path);
      if (ref.gate === "gate6" || ref.gate === "gate5.5") {
        run.native.push({ id: ref.check, status: "pass" });
        continue;
      }
      if (ref.gate === "gate8") {
        run.gate8.push({ id: ref.check, passed: true });
        continue;
      }
      const group = ref.gate.replace(/-(w1|live)$/, "");
      let res = run.results.find((r) => r.group === group && r.kind === short);
      if (!res) {
        res = { group, kind: short, passed: true, checks: [], legs: {} };
        run.results.push(res);
      }
      res.checks.push({ id: ref.check, passed: true });
    }
const writeRuns = () => {
  for (const [p, r] of runs) {
    const file = join(root, p, "result.json");
    mkdirSync(dirname(file), { recursive: true });
    const doc = r.gate8.length
      ? { schema: "render-stream-gate8-report/1", checks: r.gate8 }
      : r.native.length
        ? {
            schema: p.includes("gate55")
              ? "render-stream-gate55-report/1"
              : "render-stream-gate6-report/1",
            checks: r.native,
          }
        : { schema: "render-stream-gate7-report/1", results: r.results };
    writeFileSync(file, JSON.stringify(doc));
  }
};
writeManifests();
writeRuns();

const inp = {
  root,
  manifestPath: pathOf,
  regenerate: (k: ReceiverKind) =>
    `${JSON.stringify(manifests.get(k), null, 2)}\n`,
  profile: PROFILE_8,
};
const byId = (cs: G7zCheck[]) => new Map(cs.map((c) => [c.id, c]));
let c = byId(runGate7z(inp));
for (const s of ["native", "web", "gsw"]) {
  expect(
    `honest manifest-check@${s}`,
    c.get(`manifest-check@${s}`)?.ok === true,
  );
  expect(
    `honest manifest-evidence@${s}`,
    c.get(`manifest-evidence@${s}`)?.ok === true,
    c.get(`manifest-evidence@${s}`)?.detail,
  );
  expect(
    `honest manifest-no-substitution@${s}`,
    c.get(`manifest-no-substitution@${s}`)?.ok === true,
  );
  expect(
    `no hellos: manifest-matches-hello@${s} pending`,
    c.get(`manifest-matches-hello@${s}`)?.status === "pending",
  );
  expect(
    `manifest-device-target@${s} consistent`,
    c.get(`manifest-device-target@${s}`)?.ok === true,
    c.get(`manifest-device-target@${s}`)?.detail,
  );
  expect(
    `evidence-builds@${s} reports the carried gate 7 runs`,
    c.get(`evidence-builds@${s}`)?.status === "report" &&
      /carried forward/.test(c.get(`evidence-builds@${s}`)?.detail ?? ""),
  );
}

// the gate 8 report is indexed under the browser kinds for its -gsw / -web checks
expect(
  "native-gate8 report: delivery-pixels-gsw is found as gate8@gsw",
  (manifests.get("gsw-canvas")?.entries ?? []).some((e) =>
    e.evidence.some(
      (r) => r.gate === "gate8" && r.check === "delivery-pixels-gsw",
    ),
  ),
);

// a failed evidence check in the gate 8 report
const g8 = runs.get(
  EVIDENCE_RUNS_8.find((r) => r.key === "gate8@native")?.path ?? "",
);
if (g8) {
  const x = g8.gate8.find((y) => y.id === "delivery-pixels-gsw");
  if (x) x.passed = false;
  writeRuns();
  c = byId(runGate7z(inp));
  expect(
    "sabotage failed gate8 check: manifest-evidence@gsw fails",
    c.get("manifest-evidence@gsw")?.ok === false,
  );
  if (x) x.passed = true;
  writeRuns();
}

// manifest-check: a stale file
const regenerateHonest = inp.regenerate;
inp.regenerate = (k) =>
  k === "native" ? `${regenerateHonest(k)} ` : regenerateHonest(k);
c = byId(runGate7z(inp));
expect(
  "sabotage stale file: manifest-check@native fails",
  c.get("manifest-check@native")?.ok === false,
);
inp.regenerate = regenerateHonest;

// manifest-matches-hello: only runs flagged `hello` count
const sha = (k: ReceiverKind) =>
  createHash("sha256")
    .update(readFileSync(pathOf(k)))
    .digest("hex");
const helloRun = EVIDENCE_RUNS_8.find((r) => r.key === "g7-8-live@gsw");
const carried = EVIDENCE_RUNS_8.find((r) => r.key === "g7-6-live@gsw");
const summary = (path: string, s: string) => {
  const p = join(root, path, "gate8", "live-gsw", "host", "live-summary.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      connections: [{ receiver_kind: "gsw-canvas", manifest_sha256: s }],
    }),
  );
  return p;
};
if (helloRun && carried) {
  const hp = summary(helloRun.path, sha("gsw-canvas"));
  const cp = summary(carried.path, "0".repeat(64));
  c = byId(runGate7z(inp));
  expect(
    "hello: a flagged run with the file's sha passes; a carried /7 run's sha is ignored",
    c.get("manifest-matches-hello@gsw")?.status === "pass",
    c.get("manifest-matches-hello@gsw")?.detail,
  );
  summary(helloRun.path, "1".repeat(64));
  c = byId(runGate7z(inp));
  expect(
    "sabotage wrong hello sha: manifest-matches-hello@gsw fails",
    c.get("manifest-matches-hello@gsw")?.status === "fail",
  );
  rmSync(hp);
  rmSync(cp);
}

rmSync(root, { recursive: true, force: true });
void manifest8Path;
console.log(
  failures === 0
    ? `self-test-gate8z: ${count}/${count} passed`
    : `self-test-gate8z: ${failures} FAILED of ${count}`,
);
process.exitCode = failures === 0 ? 0 : 1;
