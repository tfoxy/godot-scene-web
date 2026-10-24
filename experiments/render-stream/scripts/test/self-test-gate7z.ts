#!/usr/bin/env -S pnpm exec tsx --conditions=development

// G7z self-test (pure, synthetic): lib/gate7z-checks.ts's seven checks against a temporary
// evidence root built from the committed manifests themselves, honest and with one mutation per
// check, plus feature-evidence-7.ts's invariants. Needs no evidence tree, so it runs anywhere.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEVICE_RUNS,
  EVIDENCE_RUNS,
  RECEIVER_KINDS,
  type ReceiverKind,
  receiverFeatureEntries,
  SHORT_KIND,
  validateEntries2,
} from "../lib/feature-evidence-7";
import { type G7zCheck, type Manifest2, runGate7z } from "../lib/gate7z-checks";
import {
  buildManifest2,
  manifest7Path,
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
const ids = RECEIVER_KINDS.map((k) =>
  receiverFeatureEntries(k)
    .map((e) => `${e.kind}:${e.id}`)
    .sort()
    .join(","),
);
expect(
  "same entry ids in every file",
  ids.every((x) => x === ids[0]),
);
for (const k of RECEIVER_KINDS)
  expect(
    `${k}: shape rules hold`,
    validateEntries2(receiverFeatureEntries(k)).length === 0,
  );
for (const k of ["web-export", "gsw-canvas"] as const) {
  const bad = receiverFeatureEntries(k).filter(
    (e) =>
      e.status === "supported" && e.evidence.some((r) => r.receiver_kind !== k),
  );
  expect(
    `${k}: no supported entry cites another kind`,
    bad.length === 0,
    bad.map((e) => e.id).join(","),
  );
}
for (const k of RECEIVER_KINDS)
  expect(
    `${k}: six g31 device targets, no g86`,
    readCollected().receivers[k].device_targets.length === 6 &&
      readCollected().receivers[k].device_targets.every(
        (t) => t.device === "g31",
      ),
  );

// --- a synthetic evidence root ------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "self-test-gate7z-"));
const mdir = join(root, "manifests");
mkdirSync(mdir);
const manifests = new Map<ReceiverKind, Manifest2>();
for (const k of RECEIVER_KINDS)
  manifests.set(
    k,
    JSON.parse(serializeManifest2(buildManifest2(k))) as Manifest2,
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
  window?: number;
  device?: string;
  run_dir?: string;
  checks: { id: string; passed: boolean }[];
  legs: Record<string, unknown>;
}
const runs = new Map<
  string,
  { results: FakeResult[]; native: { id: string; status: string }[] }
>();
const runOf = (p: string) => {
  if (!runs.has(p)) runs.set(p, { results: [], native: [] });
  return runs.get(p) as {
    results: FakeResult[];
    native: { id: string; status: string }[];
  };
};
for (const [k, m] of manifests)
  for (const e of m.entries)
    for (const ref of e.evidence) {
      const short = SHORT_KIND[ref.receiver_kind];
      const q = EVIDENCE_RUNS.find((r) => r.key === `${ref.gate}@${short}`);
      if (!q) continue;
      const run = runOf(q.path);
      if (ref.gate === "gate6" || ref.gate === "gate5.5") {
        run.native.push({ id: ref.check, status: "pass" });
        continue;
      }
      const group = ref.gate.replace(/-(w1|live)$/, "");
      let res = run.results.find((r) => r.group === group && r.kind === short);
      if (!res) {
        res = { group, kind: short, passed: true, checks: [], legs: {} };
        run.results.push(res);
      }
      res.checks.push({ id: ref.check, passed: true });
      void k;
    }
const writeRuns = () => {
  for (const [p, r] of runs) {
    const file = p.endsWith(".json")
      ? join(root, p)
      : join(root, p, "result.json");
    mkdirSync(dirname(file), { recursive: true });
    const schema = r.native.length
      ? p.includes("gate55")
        ? "render-stream-gate55-report/1"
        : "render-stream-gate6-report/1"
      : "render-stream-gate7-report/1";
    writeFileSync(
      file,
      JSON.stringify({ schema, checks: r.native, results: r.results }),
    );
  }
};
writeManifests();
writeRuns();

const inp = {
  root,
  manifestPath: pathOf,
  regenerate: (k: ReceiverKind) =>
    `${JSON.stringify(manifests.get(k), null, 2)}\n`,
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
    `no recordings: manifest-matches-session@${s} pending`,
    c.get(`manifest-matches-session@${s}`)?.status === "pending",
  );
  expect(
    `no hellos: manifest-matches-hello@${s} pending`,
    c.get(`manifest-matches-hello@${s}`)?.status === "pending",
  );
}

// manifest-check: a stale file
const regenerateHonest = inp.regenerate;
inp.regenerate = (k) =>
  k === "gsw-canvas" ? `${regenerateHonest(k)} ` : regenerateHonest(k);
c = byId(runGate7z(inp));
expect(
  "sabotage stale file: manifest-check@gsw fails",
  c.get("manifest-check@gsw")?.ok === false,
);
inp.regenerate = regenerateHonest;

// manifest-evidence: one cited check failed in its run
const anyGsw = [...runs.values()]
  .flatMap((r) => r.results)
  .find((r) => r.kind === "gsw");
const flip = (to: boolean) => {
  if (anyGsw)
    for (const x of anyGsw.checks)
      if (x.id === anyGsw.checks[0].id) x.passed = to;
};
flip(false);
writeRuns();
c = byId(runGate7z(inp));
expect(
  "sabotage failed evidence: manifest-evidence@gsw fails",
  c.get("manifest-evidence@gsw")?.ok === false,
);
flip(true);
writeRuns();

// manifest-no-substitution: a gsw entry citing web evidence
const gsw = manifests.get("gsw-canvas") as Manifest2;
const sup = gsw.entries.find(
  (e) => e.status === "supported" && e.evidence.length > 0,
);
if (sup) {
  const orig = { ...sup.evidence[0] };
  sup.evidence[0] = {
    ...orig,
    check: orig.check.replace("@gsw", "@web"),
    receiver_kind: "web-export",
  };
  writeManifests();
  c = byId(runGate7z(inp));
  expect(
    "sabotage substitution: manifest-no-substitution@gsw fails",
    c.get("manifest-no-substitution@gsw")?.ok === false,
  );
  sup.evidence[0] = orig;
  writeManifests();
}

// manifest-refused: a receiver-typed reason observed in gsw's legs with no entry
const gswRun = EVIDENCE_RUNS.find((r) => r.key === "g7-55@gsw");
if (gswRun) {
  const p = join(
    root,
    gswRun.path,
    "gate55",
    "gsw",
    "x",
    "receiver",
    "applied.json",
  );
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({ unsupported: [{ reason: "gsw-shader-transpile" }] }),
  );
  c = byId(runGate7z(inp));
  expect(
    "sabotage unlisted refusal: manifest-refused@gsw fails",
    c.get("manifest-refused@gsw")?.ok === false,
  );
  rmSync(p);
}
c = byId(runGate7z(inp));
expect(
  "web: receiver-typed with no observation fails manifest-refused@web",
  c.get("manifest-refused@web")?.ok === false,
);

// manifest-matches-hello: honest sha, then a wrong one
const live = EVIDENCE_RUNS.find((r) => r.key === "g7-6-live@gsw");
if (live) {
  const p = join(
    root,
    live.path,
    "gate6",
    "live",
    "host",
    "evidence",
    "live-summary.json",
  );
  mkdirSync(dirname(p), { recursive: true });
  const sha = createHash("sha256")
    .update(serializeOf("gsw-canvas"))
    .digest("hex");
  writeFileSync(
    p,
    JSON.stringify({
      connections: [{ receiver_kind: "gsw-canvas", manifest_sha256: sha }],
    }),
  );
  c = byId(runGate7z(inp));
  expect(
    "honest hello: manifest-matches-hello@gsw passes",
    c.get("manifest-matches-hello@gsw")?.ok === true,
    c.get("manifest-matches-hello@gsw")?.detail,
  );
  writeFileSync(
    p,
    JSON.stringify({
      connections: [
        { receiver_kind: "gsw-canvas", manifest_sha256: "0".repeat(64) },
      ],
    }),
  );
  c = byId(runGate7z(inp));
  expect(
    "sabotage hello sha: manifest-matches-hello@gsw fails",
    c.get("manifest-matches-hello@gsw")?.status === "fail",
  );
}
function serializeOf(k: ReceiverKind): string {
  return `${JSON.stringify(manifests.get(k), null, 2)}\n`;
}

// manifest-device-target: a device run on the manifest's build, honest not-met, then claimed met
const dr = DEVICE_RUNS.find((d) => d.kind === "gsw" && d.windows.includes(2));
const target = gsw.limits.receiver.device_targets.find(
  (t) => t.credit_window === 2 && t.workload === "pace",
);
if (dr && target) {
  const runDir = join(root, dr.path);
  const legDir = join(
    runDir,
    "gate6",
    "dev-g31-gsw-w2",
    "rates",
    "dev-pace-r1",
    "receiver",
  );
  mkdirSync(legDir, { recursive: true });
  const env = Buffer.from(
    JSON.stringify({
      env: { RS_RECEIVER_BUILD_SHA256: gsw.receiver.build.sha256 },
    }),
  ).toString("base64url");
  writeFileSync(
    join(legDir, "page-config.json"),
    JSON.stringify({ kind: "gsw", url: `http://127.0.0.1:1/x?env=${env}` }),
  );
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({ env: "device", device: "g31" }),
  );
  const checks = [
    "device-provenance",
    "dev-rate",
    "dev-cadence",
    "dev-main-thread",
    "dev-gpu",
    "dev-unthrottled",
    "dev-presence",
    "dev-presentation-typed",
  ].flatMap((b) =>
    ["pace", "gpu-headroom-pace"].map((leg) => ({
      id: `${b}@gsw-w2:${leg}`,
      passed: !(b === "dev-cadence" && leg === "pace"),
    })),
  );
  checks.push({
    id: "dev-gpu-headroom@gsw-w2:gpu-headroom-pace",
    passed: true,
  });
  writeFileSync(
    join(runDir, "result.json"),
    JSON.stringify({
      schema: "render-stream-gate7-report/1",
      results: [
        {
          group: "g7-dev",
          kind: "gsw",
          passed: false,
          window: 2,
          device: "g31",
          run_dir: "/elsewhere/gate6/dev-g31-gsw-w2",
          checks,
          legs: {},
        },
      ],
    }),
  );
  gsw.limits.receiver.device_targets = gsw.limits.receiver.device_targets.map(
    (t) =>
      t === target
        ? {
            ...t,
            status: "not-met",
            build_sha: gsw.receiver.build.sha256,
            evidence: checks
              .filter((x) => x.id.endsWith(":pace"))
              .map((x) => ({
                run: dr.path,
                leg: "dev-pace-w2-gsw",
                check: x.id,
                receiver_kind: "gsw-canvas" as const,
              })),
          }
        : {
            ...t,
            status: t.status === "not-met" ? "unverified" : t.status,
            build_sha: t.status === "not-met" ? null : t.build_sha,
          },
  );
  writeManifests();
  c = byId(runGate7z(inp));
  expect(
    "honest not-met: manifest-device-target@gsw passes",
    c.get("manifest-device-target@gsw")?.ok === true,
    c.get("manifest-device-target@gsw")?.detail,
  );
  const t2 = gsw.limits.receiver.device_targets.find(
    (t) => t.status === "not-met",
  );
  if (t2) t2.status = "met";
  writeManifests();
  c = byId(runGate7z(inp));
  expect(
    "sabotage claimed met: manifest-device-target@gsw fails",
    c.get("manifest-device-target@gsw")?.ok === false,
  );
  if (t2) {
    t2.status = "not-met";
    t2.build_sha = "f".repeat(64);
  }
  writeManifests();
  c = byId(runGate7z(inp));
  expect(
    "sabotage other build: manifest-device-target@gsw fails",
    c.get("manifest-device-target@gsw")?.ok === false,
  );
}
const nat = manifests.get("native") as Manifest2;
nat.limits.receiver.device_targets[0].status = "met";
writeManifests();
c = byId(runGate7z(inp));
expect(
  "sabotage native met: manifest-device-target@native fails",
  c.get("manifest-device-target@native")?.ok === false,
);

rmSync(root, { recursive: true, force: true });
void manifest7Path;
console.log(
  failures === 0
    ? `self-test-gate7z: ${count}/${count} passed`
    : `self-test-gate7z: ${failures} FAILED of ${count}`,
);
if (failures > 0) process.exitCode = 1;
