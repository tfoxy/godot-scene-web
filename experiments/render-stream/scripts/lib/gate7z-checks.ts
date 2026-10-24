// Gate 7 group G7z (protocol/gate7-design.md Q11, protocol/gate7/g7z.md): evidence loading, the
// g31 device-target derivation behind make-features.ts --collect, and Q11's seven manifest checks
// (`check-gate7.ts --legs g7-z`). Pure: it reads existing run directories, never runs a leg.
//
// Checks, one row per receiver kind (`<id>@<short kind>`), `pending` where the evidence a check
// needs does not exist yet (printed FAIL with a `pending:` detail, never a pass):
//   manifest-check            make-features.ts --receiver <kind> --check regenerates byte-identically
//   manifest-matches-session  a quoted run's session features lists equal the file's wire statuses
//   manifest-evidence         every evidence check passed in its quoted run, under its own kind
//   manifest-no-substitution  no browser entry cites another kind's evidence (D1)
//   manifest-refused          receiver-typed reasons observed in the kind's legs == its entries
//   manifest-matches-hello    every live connection of the kind sent the file's sha256
//   manifest-device-target    met/not-met cite own-kind g31 g7-dev legs on the file's build
// plus a report-only `evidence-builds` row listing quoted runs off the manifest's build.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FeatureManifest } from "../make-features";
import {
  DEVICE_RUNS,
  EVIDENCE_RUNS,
  type EvidenceRun,
  type FeatureEntry2,
  PRIMARY_BUILD,
  RECEIVER_KINDS,
  RECEIVER_TYPED_REASONS,
  type ReceiverKind,
  SHORT_KIND,
  type ShortKind,
} from "./feature-evidence-7";
import { compareSessionToManifest } from "./gate6z-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..", "..");

/** `<checkout>/artifacts/render-stream/gate7`: this checkout's if present, else the main
 * checkout's (a linked worktree's evidence lives in the main checkout's ignored tree). */
export function defaultEvidenceRoot(): string {
  const own = join(REPO_ROOT, "artifacts", "render-stream", "gate7");
  if (existsSync(own)) return own;
  try {
    const common = execFileSync(
      "git",
      [
        "-C",
        REPO_ROOT,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf8" },
    ).trim();
    return join(dirname(common), "artifacts", "render-stream", "gate7");
  } catch {
    return own;
  }
}

// -------------------------------------------------------------------------------------------
// Run loading
// -------------------------------------------------------------------------------------------

interface CheckRow {
  passed: boolean;
}
export interface IndexedResult {
  group: string;
  kind: ShortKind;
  passed: boolean;
  window: number | null;
  device: string | null;
  runDir: string | null;
  checks: Map<string, CheckRow>;
  legs: Set<string>;
}
export interface IndexedRun {
  path: string;
  dir: string;
  schema: string;
  env: { env?: string; device?: string | null } | null;
  results: IndexedResult[];
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const runCache = new Map<string, IndexedRun | null>();

interface RawCheck {
  id: string;
  passed?: boolean;
  ok?: boolean;
  status?: string;
}
interface RawResult {
  group: string;
  kind: string;
  passed?: boolean;
  window?: number;
  device?: string | null;
  run_dir?: string;
  checks?: RawCheck[];
  legs?: unknown;
}

/** One run's result.json, indexed by (group, kind). Native gate reports (render-stream-gate6/
 * gate55-report) index as one result, group "gate6" / "gate5.5", kind "native". */
export function loadRun(root: string, path: string): IndexedRun | null {
  const abs = resolve(root, path);
  if (runCache.has(abs)) return runCache.get(abs) ?? null;
  const file = abs.endsWith(".json") ? abs : join(abs, "result.json");
  const doc = readJson<{
    schema?: string;
    checks?: RawCheck[];
    results?: RawResult[];
    group_checks?: Record<string, RawCheck[]>;
  }>(file);
  if (!doc) {
    runCache.set(abs, null);
    return null;
  }
  const dir = abs.endsWith(".json") ? dirname(abs) : abs;
  const schema = doc.schema ?? "";
  const results: IndexedResult[] = [];
  const toMap = (cs: RawCheck[] | undefined) =>
    new Map(
      (cs ?? []).map((c) => [
        c.id,
        { passed: c.passed === true || c.ok === true || c.status === "pass" },
      ]),
    );
  if (
    schema.startsWith("render-stream-gate6-report") ||
    schema.startsWith("render-stream-gate55-report")
  ) {
    results.push({
      group: schema.startsWith("render-stream-gate6") ? "gate6" : "gate5.5",
      kind: "native",
      passed: true,
      window: null,
      device: null,
      runDir: dir,
      checks: toMap(doc.checks),
      legs: new Set(),
    });
  }
  for (const r of doc.results ?? []) {
    const legs = new Set<string>();
    if (r.legs && typeof r.legs === "object" && !Array.isArray(r.legs))
      for (const k of Object.keys(r.legs as object)) legs.add(k);
    results.push({
      group: r.group,
      kind: r.kind as ShortKind,
      passed: r.passed === true,
      window: r.window ?? null,
      device: r.device ?? null,
      runDir: r.run_dir ? join(dir, "gate6", basename(r.run_dir)) : null,
      checks: toMap(r.checks),
      legs,
    });
  }
  const run: IndexedRun = {
    path,
    dir,
    schema,
    env: readJson(join(dir, "run.json")) ?? null,
    results,
  };
  runCache.set(abs, run);
  return run;
}

export function quotedRun(key: string): EvidenceRun | undefined {
  return EVIDENCE_RUNS.find((r) => r.key === key);
}

/** The result group a reference's `gate` names (`g7-r-w1` is g7-r at window 1). */
function resultGroup(gate: string): string {
  return gate.replace(/-(w1|live)$/, "");
}

function findFiles(
  dir: string,
  name: string,
  out: string[],
  limit = 100000,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= limit) break;
    const p = join(dir, e);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) findFiles(p, name, out, limit);
    else if (e === name) out.push(p);
  }
  return out;
}

/** RS_RECEIVER_BUILD_SHA256 of every browser page under `dir`, by page kind. */
export function bundleShas(dir: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of findFiles(dir, "page-config.json", [])) {
    const page = readJson<{ url?: string; kind?: string }>(p);
    if (!page?.url) continue;
    const q = new URL(page.url).searchParams.get("env");
    if (!q) continue;
    let env: Record<string, string> = {};
    try {
      env =
        (
          JSON.parse(Buffer.from(q, "base64url").toString("utf8")) as {
            env?: Record<string, string>;
          }
        ).env ?? {};
    } catch {
      continue;
    }
    const sha = env.RS_RECEIVER_BUILD_SHA256;
    if (!sha) continue;
    const k = page.kind ?? (p.includes("/web/") ? "web" : "gsw");
    if (!out.has(k)) out.set(k, new Set());
    out.get(k)?.add(sha);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Device targets (make-features.ts --collect)
// -------------------------------------------------------------------------------------------

export const WORKLOADS = ["pace", "scene", "hd"] as const;
const DECIDED = [
  "device-provenance",
  "dev-rate",
  "dev-cadence",
  "dev-main-thread",
  "dev-gpu",
  "dev-unthrottled",
  "dev-presence",
  "dev-presentation-typed",
];

export interface DeviceTarget {
  id: "moto-g31-60";
  device: "g31";
  baseline: true;
  workload: (typeof WORKLOADS)[number];
  required: boolean;
  credit_window: 1 | 2;
  status: "met" | "not-met" | "unverified" | "not-applicable";
  panel_hz: number | null;
  chrome: string | null;
  build_sha: string | null;
  failed_checks: string[];
  evidence: {
    run: string;
    leg: string;
    check: string;
    receiver_kind: ReceiverKind;
  }[];
  /** extras beyond Q11's shape, for the summary */
  t_p_ms: number | null;
  panel_mode: string | null;
  thermal: string | null;
  freq_cap_derated: boolean | null;
  published_hz: number | null;
  drawn_hz: number | null;
  run_build: string | null;
  acceptance: string;
  notes: string | null;
}

interface SummaryRow {
  receiver_kind: string;
  credit_window: number;
  leg: string;
  provenance_env?: {
    panel?: {
      raf_interval_p50_us?: number;
      mode_hz?: number;
      mode_source?: string;
    };
  };
  stages?: { published_hz?: number; drawn_hz?: number };
  device?: {
    thermal_before?: string;
    thermal_after?: string;
    derated?: boolean;
  };
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}
const r2 = (x: number | null) =>
  x === null ? null : Math.round(x * 100) / 100;

/** The Q13d verdict of one (kind, window, workload) in a g7-dev device run. */
export function judgeDeviceWorkload(
  run: IndexedRun,
  short: ShortKind,
  window: 1 | 2,
  workload: string,
): {
  present: boolean;
  failed: string[];
  checks: string[];
  provenanceOk: boolean;
} {
  const res = run.results.find(
    (r) => r.group === "g7-dev" && r.kind === short && r.window === window,
  );
  if (!res)
    return { present: false, failed: [], checks: [], provenanceOk: false };
  // dev-gpu-headroom-<workload>-gsw runs at window 2 only (G7v).
  const legs = [
    workload,
    ...(short === "gsw" && window === 2 ? [`gpu-headroom-${workload}`] : []),
  ];
  const failed: string[] = [];
  const checks: string[] = [];
  for (const leg of legs) {
    const names = leg.startsWith("gpu-headroom")
      ? [...DECIDED, "dev-gpu-headroom"]
      : DECIDED;
    for (const base of names) {
      const id = `${base}@${short}-w${window}:${leg}`;
      const row = res.checks.get(id);
      if (!row) {
        failed.push(`${base}:${leg}: not run`);
        continue;
      }
      checks.push(id);
      if (!row.passed) failed.push(id);
    }
  }
  const provenanceOk = legs.every(
    (leg) =>
      res.checks.get(`device-provenance@${short}-w${window}:${leg}`)?.passed ===
      true,
  );
  return { present: true, failed, checks, provenanceOk };
}

function acceptanceText(
  short: ShortKind,
  window: number,
  workload: string,
  met: boolean,
): string {
  if (workload === "hd")
    return met
      ? "stretch: met"
      : "stretch: not met, accepted as measured (user 2026-10-22)";
  if (met) return `met at window ${window}`;
  if (short === "gsw" && window === 2)
    return "met with measured shortfall (user 2026-10-22, F3(a)): gate 7's phone receiver";
  if (short === "gsw")
    return "not met at window 1 (window 2 is the default, G7wd)";
  return "not met (user 2026-10-22: recorded with its numbers, F3(a))";
}

/** Six g31 targets for one browser kind, against the manifest build `buildSha`. */
export function collectDeviceTargets(
  root: string,
  kind: ReceiverKind,
  buildSha: string | null,
): DeviceTarget[] {
  const short = SHORT_KIND[kind];
  const out: DeviceTarget[] = [];
  for (const window of [1, 2] as const)
    for (const workload of WORKLOADS) {
      const base: DeviceTarget = {
        id: "moto-g31-60",
        device: "g31",
        baseline: true,
        workload,
        required: workload !== "hd",
        credit_window: window,
        status: kind === "native" ? "not-applicable" : "unverified",
        panel_hz: null,
        chrome: null,
        build_sha: null,
        failed_checks: [],
        evidence: [],
        t_p_ms: null,
        panel_mode: null,
        thermal: null,
        freq_cap_derated: null,
        published_hz: null,
        drawn_hz: null,
        run_build: null,
        acceptance:
          kind === "native"
            ? "not applicable: the phones run browser receivers only"
            : "no g31 run",
        notes: null,
      };
      if (kind === "native") {
        out.push(base);
        continue;
      }
      const dr = DEVICE_RUNS.find(
        (d) => d.kind === short && d.windows.includes(window),
      );
      const run = dr ? loadRun(root, dr.path) : null;
      if (!dr || !run) {
        out.push({
          ...base,
          notes: dr ? `run ${dr.path} missing under the evidence root` : null,
        });
        continue;
      }
      const j = judgeDeviceWorkload(run, short, window, workload);
      const res = run.results.find(
        (r) => r.group === "g7-dev" && r.kind === short && r.window === window,
      );
      const shas = res?.runDir
        ? bundleShas(res.runDir)
        : new Map<string, Set<string>>();
      const runSha = [...(shas.get(short) ?? [])][0] ?? null;
      const rows = (
        readJson<{ device_rows?: SummaryRow[] }>(
          join(run.dir, "g7v-summary.json"),
        )?.device_rows ?? []
      ).filter(
        (r) =>
          r.receiver_kind === kind &&
          r.credit_window === window &&
          r.leg.endsWith(`:${workload}`),
      );
      const raf = mean(
        rows
          .map((r) => r.provenance_env?.panel?.raf_interval_p50_us ?? NaN)
          .filter(Number.isFinite),
      );
      const prov = res?.runDir
        ? findFiles(res.runDir, "provenance.json", [], 1)
        : [];
      const chrome = prov[0]
        ? (readJson<{ chromeVersion?: string }>(prov[0])?.chromeVersion ?? null)
        : null;
      const thermals = new Set(
        rows
          .flatMap((r) => [r.device?.thermal_before, r.device?.thermal_after])
          .filter(Boolean),
      );
      const met = j.present && j.failed.length === 0;
      const sameBuild = runSha !== null && runSha === buildSha;
      out.push({
        ...base,
        status: !j.present
          ? "unverified"
          : sameBuild
            ? met
              ? "met"
              : "not-met"
            : "unverified",
        // The g31 has one display mode, 60.00 Hz by dumpsys (Q13a); T_p is measured per repeat.
        panel_hz: 60,
        chrome,
        build_sha: runSha,
        failed_checks: j.failed,
        evidence: j.checks.map((check) => ({
          run: dr.path,
          leg: `dev-${check.split(":")[1]}-w${window}-${short}`,
          check,
          receiver_kind: kind,
        })),
        t_p_ms: raf ? r2(raf / 1000) : null,
        panel_mode:
          "60 Hz, the g31's only mode (dumpsys); T_p measured per repeat",
        thermal: thermals.size ? [...thermals].join(",") : null,
        freq_cap_derated: rows.length
          ? rows.some((r) => r.device?.derated === true)
          : null,
        published_hz: r2(
          mean(
            rows
              .map((r) => r.stages?.published_hz ?? NaN)
              .filter(Number.isFinite),
          ),
        ),
        drawn_hz: r2(
          mean(
            rows.map((r) => r.stages?.drawn_hz ?? NaN).filter(Number.isFinite),
          ),
        ),
        run_build: dr.build,
        acceptance: j.present
          ? acceptanceText(short, window, workload, met)
          : "not run",
        notes:
          sameBuild || !j.present
            ? dr.note
            : `${dr.note}. Unverified on this manifest's build (D28, Q11): the run is ${dr.build}, bundle ${runSha?.slice(0, 16) ?? "?"}; its own Q13d verdict is ${met ? "met" : "not met"}.`,
      });
    }
  return out;
}

// -------------------------------------------------------------------------------------------
// The checks
// -------------------------------------------------------------------------------------------

export interface G7zCheck {
  id: string;
  ok: boolean;
  /** pending: the evidence the check needs does not exist yet (never a pass) */
  status: "pass" | "fail" | "pending" | "report";
  detail: string;
}

function row(
  id: string,
  problems: string[],
  okDetail: string,
  pending?: string,
): G7zCheck {
  if (pending !== undefined)
    return { id, ok: false, status: "pending", detail: `pending: ${pending}` };
  return problems.length === 0
    ? { id, ok: true, status: "pass", detail: okDetail }
    : {
        id,
        ok: false,
        status: "fail",
        detail: `${problems.length} problem(s): ${problems.slice(0, 8).join("; ")}${problems.length > 8 ? "; ..." : ""}`,
      };
}

export interface Manifest2 {
  receiver: { kind: ReceiverKind; build: { sha256: string | null } };
  entries: FeatureEntry2[];
  limits: { receiver: { device_targets: DeviceTarget[] } };
}

/** Observed receiver-typed reasons in every applied.json under a kind's quoted runs. */
function observedReceiverTyped(
  root: string,
  short: ShortKind,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dirs = new Set(
    EVIDENCE_RUNS.filter((r) => r.key.endsWith(`@${short}`)).map((r) => {
      const run = loadRun(root, r.path);
      return run?.dir ?? resolve(root, r.path);
    }),
  );
  for (const dir of dirs)
    for (const p of findFiles(dir, "applied.json", [])) {
      // Each quoted run directory holds one receiver kind's legs (EVIDENCE_RUNS is per kind).
      let text: string;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      for (const reason of RECEIVER_TYPED_REASONS)
        if (text.includes(`"${reason}"`)) {
          if (!out.has(reason)) out.set(reason, []);
          out.get(reason)?.push(p.slice(root.length + 1));
        }
    }
  return out;
}

function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

export interface G7zInputs {
  root: string;
  manifestPath: (kind: ReceiverKind) => string;
  regenerate: (kind: ReceiverKind) => string;
}

export function runGate7z(inp: G7zInputs): G7zCheck[] {
  // Each call re-reads the evidence (the self-test mutates it between calls).
  runCache.clear();
  const checks: G7zCheck[] = [];
  for (const kind of RECEIVER_KINDS) {
    const short = SHORT_KIND[kind];
    const path = inp.manifestPath(kind);
    let onDisk: string | null = null;
    try {
      onDisk = readFileSync(path, "utf8");
    } catch {
      onDisk = null;
    }

    // manifest-check
    {
      const problems: string[] = [];
      let regen: string | null = null;
      try {
        regen = inp.regenerate(kind);
      } catch (e) {
        problems.push(`make-features --receiver ${kind} failed: ${String(e)}`);
      }
      if (onDisk === null) problems.push(`${path} missing`);
      else if (regen !== null && regen !== onDisk)
        problems.push(`${path} is stale`);
      checks.push(
        row(
          `manifest-check@${short}`,
          problems,
          `${basename(path)} regenerates byte-identically`,
        ),
      );
    }
    if (onDisk === null) continue;
    const m = JSON.parse(onDisk) as Manifest2;

    // manifest-matches-session: any quoted run's capture recording (the /7 live wire carries the
    // /6 lists, so one host session judges all three files).
    {
      const recs = [
        ...findFiles(
          resolve(inp.root, quotedRun("gate6@native")?.path ?? "."),
          "recording.rs2",
          [],
          4,
        ),
      ];
      if (recs.length === 0)
        checks.push(
          row(
            `manifest-matches-session@${short}`,
            [],
            "",
            "no session recording under the quoted native gate 6 run (pruned by the retention policy); the final run must keep scene/capture/recording.rs2 until g7-z has run",
          ),
        );
      else {
        // Deferred to an async caller: recordings need the decoder (runGate7zSessions).
        checks.push(
          row(
            `manifest-matches-session@${short}`,
            [],
            "",
            "recordings present: run with --sessions (runGate7zSessions)",
          ),
        );
      }
    }

    // manifest-evidence
    {
      const problems: string[] = [];
      let n = 0;
      for (const e of m.entries)
        for (const ref of e.evidence) {
          n++;
          const refShort = SHORT_KIND[ref.receiver_kind];
          const q = quotedRun(`${ref.gate}@${refShort}`);
          if (!q) {
            problems.push(`${e.id}: no quoted run for ${ref.gate}@${refShort}`);
            continue;
          }
          const run = loadRun(inp.root, q.path);
          if (!run) {
            problems.push(`${e.id}: quoted run ${q.path} missing`);
            continue;
          }
          const res =
            run.results.find(
              (r) =>
                r.group === resultGroup(ref.gate) &&
                r.kind === refShort &&
                r.checks.has(ref.check),
            ) ??
            run.results.find(
              (r) => r.group === resultGroup(ref.gate) && r.kind === refShort,
            );
          if (!res) {
            problems.push(
              `${e.id}: ${q.path} has no ${resultGroup(ref.gate)}@${refShort} result`,
            );
            continue;
          }
          const c = res.checks.get(ref.check);
          if (!c)
            problems.push(
              `${e.id}: ${ref.check} absent from ${ref.gate}@${refShort} (${q.path})`,
            );
          else if (!c.passed)
            problems.push(`${e.id}: ${ref.check} did not pass in ${q.path}`);
          if (res.legs.size > 0 && !res.legs.has(ref.leg))
            problems.push(
              `${e.id}: leg ${ref.leg} not in ${ref.gate}@${refShort}'s legs`,
            );
        }
      checks.push(
        row(
          `manifest-evidence@${short}`,
          problems,
          `${n} evidence checks passed in their quoted runs`,
        ),
      );
    }

    // manifest-no-substitution
    {
      const problems: string[] = [];
      if (kind !== "native")
        for (const e of m.entries) {
          if (e.status !== "supported" && e.status !== "receiver-typed")
            continue;
          for (const ref of e.evidence)
            if (
              ref.receiver_kind !== kind ||
              (/@[a-z]+/.test(ref.check) && !ref.check.includes(`@${short}`))
            )
              problems.push(
                `${e.id} cites ${ref.receiver_kind} evidence ${ref.check}`,
              );
        }
      checks.push(
        row(
          `manifest-no-substitution@${short}`,
          problems,
          kind === "native"
            ? "native: not applicable (own evidence)"
            : "every supported entry cites its own kind",
        ),
      );
    }

    // manifest-refused
    {
      const problems: string[] = [];
      const observed = observedReceiverTyped(inp.root, short);
      const typed = new Set(
        m.entries
          .filter((e) => e.status === "receiver-typed")
          .map((e) => e.reason as string),
      );
      for (const [reason, where] of observed)
        if (!typed.has(reason))
          problems.push(
            `${reason} observed (${where[0]}) but no receiver-typed entry`,
          );
      for (const reason of typed)
        if (!observed.has(reason))
          problems.push(
            `receiver-typed ${reason} never observed in ${short}'s legs`,
          );
      checks.push(
        row(
          `manifest-refused@${short}`,
          problems,
          `receiver-typed {${[...typed].join(",")}} == observed`,
        ),
      );
    }

    // manifest-matches-hello
    {
      const problems: string[] = [];
      const sha = sha256File(path);
      let conns = 0;
      const nulls: string[] = [];
      const dirs = new Set(
        EVIDENCE_RUNS.filter((r) => r.key.endsWith(`@${short}`)).map(
          (r) => loadRun(inp.root, r.path)?.dir ?? resolve(inp.root, r.path),
        ),
      );
      for (const dir of dirs)
        for (const p of findFiles(dir, "live-summary.json", [])) {
          const doc = readJson<{
            connections?: {
              receiver_kind?: string;
              manifest_sha256?: string | null;
            }[];
          }>(p);
          for (const c of doc?.connections ?? []) {
            if (c.receiver_kind !== kind) continue;
            conns++;
            if (c.manifest_sha256 == null)
              nulls.push(p.slice(inp.root.length + 1));
            else if (c.manifest_sha256 !== sha)
              problems.push(
                `${p.slice(inp.root.length + 1)}: hello ${c.manifest_sha256.slice(0, 12)} != file ${sha?.slice(0, 12)}`,
              );
          }
        }
      if (conns === 0)
        checks.push(
          row(
            `manifest-matches-hello@${short}`,
            [],
            "",
            `no ${kind} live connection in the quoted runs`,
          ),
        );
      else if (nulls.length === conns)
        checks.push(
          row(
            `manifest-matches-hello@${short}`,
            [],
            "",
            `all ${conns} ${kind} hellos sent manifest_sha256 null: the quoted runs predate the file (rerun live groups with run-gate7.sh --manifest-hello)`,
          ),
        );
      else {
        for (const n of nulls.slice(0, 3))
          problems.push(`${n}: hello manifest_sha256 null`);
        checks.push(
          row(
            `manifest-matches-hello@${short}`,
            problems,
            `${conns} hellos carry ${sha?.slice(0, 12)}`,
          ),
        );
      }
    }

    // manifest-device-target
    {
      const problems: string[] = [];
      const targets = m.limits.receiver.device_targets;
      if (targets.length !== 6)
        problems.push(
          `${targets.length} targets, want 6 (the g31's; g86 descoped)`,
        );
      for (const t of targets) {
        const tag = `${t.device}/${t.workload}/w${t.credit_window}`;
        if (kind === "native") {
          if (t.status !== "not-applicable")
            problems.push(`${tag}: native must be not-applicable`);
          continue;
        }
        if (t.status === "not-applicable") {
          problems.push(`${tag}: not-applicable on a browser`);
          continue;
        }
        const dr = DEVICE_RUNS.find(
          (d) => d.kind === short && d.windows.includes(t.credit_window),
        );
        const run = dr ? loadRun(inp.root, dr.path) : null;
        if (t.status === "met" || t.status === "not-met") {
          if (!dr || !run) {
            problems.push(`${tag}: ${t.status} without a device run`);
            continue;
          }
          if (run.env?.env !== "device" || run.env?.device !== t.device)
            problems.push(
              `${tag}: run ${dr.path} is not a ${t.device} device run`,
            );
          if (
            t.evidence.length === 0 ||
            t.evidence.some(
              (e) =>
                e.receiver_kind !== kind ||
                !e.check.includes(`@${short}-w${t.credit_window}:`),
            )
          )
            problems.push(
              `${tag}: evidence must be ${short} g7-dev legs at window ${t.credit_window}`,
            );
          if (t.build_sha !== m.receiver.build.sha256)
            problems.push(
              `${tag}: ${t.status} on build ${t.build_sha?.slice(0, 12)} != manifest ${m.receiver.build.sha256?.slice(0, 12)}`,
            );
          const j = judgeDeviceWorkload(
            run,
            short,
            t.credit_window,
            t.workload,
          );
          if (!j.provenanceOk)
            problems.push(`${tag}: device-provenance not passing`);
          const want = j.present && j.failed.length === 0 ? "met" : "not-met";
          if (want !== t.status)
            problems.push(`${tag}: status ${t.status}, Q13d gives ${want}`);
        } else if (
          t.status === "unverified" &&
          run &&
          t.build_sha !== null &&
          t.build_sha === m.receiver.build.sha256
        )
          problems.push(
            `${tag}: unverified but its run is on the manifest build`,
          );
      }
      checks.push(
        row(
          `manifest-device-target@${short}`,
          problems,
          `${targets.length} targets consistent`,
        ),
      );
    }

    // evidence-builds (report only)
    {
      const off = EVIDENCE_RUNS.filter(
        (r) => r.key.endsWith(`@${short}`) && r.build !== PRIMARY_BUILD,
      );
      checks.push({
        id: `evidence-builds@${short}`,
        ok: true,
        status: "report",
        detail:
          off.length === 0
            ? `every quoted run is on ${PRIMARY_BUILD}`
            : `report: ${off.length} quoted run(s) off ${PRIMARY_BUILD}: ${off.map((r) => `${r.key}=${r.build}`).join(", ")} (g7z.md Pass needs one build)`,
      });
    }
  }
  return checks;
}

/** manifest-matches-session with real recordings (async: the decoder). Replaces the pending rows
 * when a quoted native gate 6 run still holds its capture recordings. */
export async function runGate7zSessions(
  inp: G7zInputs,
  checks: G7zCheck[],
): Promise<void> {
  const q = quotedRun("gate6@native");
  if (!q) return;
  const dir = resolve(inp.root, q.path);
  const recs = [
    "scene/capture",
    "scene/capture-inline",
    "animate/capture",
    "hd/capture-native",
  ]
    .map((d) => join(dir, d, "recording.rs2"))
    .filter((p) => existsSync(p));
  if (recs.length === 0) return;
  const { loadRecording } = await import("./gate0-checks");
  for (const kind of RECEIVER_KINDS) {
    const short = SHORT_KIND[kind];
    const idx = checks.findIndex(
      (c) => c.id === `manifest-matches-session@${short}`,
    );
    if (idx < 0) continue;
    let m: Manifest2;
    try {
      m = JSON.parse(readFileSync(inp.manifestPath(kind), "utf8")) as Manifest2;
    } catch {
      continue;
    }
    // The wire carries a receiver-typed feature; compare it as the wire's "supported".
    const view = {
      entries: m.entries.map((e) => ({
        ...e,
        status:
          e.status === "receiver-typed" ||
          (e.status === "declared-unverified" && e.kind === "op")
            ? "supported"
            : e.status,
      })),
    } as unknown as FeatureManifest;
    const problems: string[] = [];
    let n = 0;
    for (const p of recs) {
      const rec = await loadRecording(p);
      if (!rec.present || !rec.session?.features) continue;
      n++;
      problems.push(
        ...compareSessionToManifest(
          p.slice(dir.length + 1),
          rec.session.features,
          view,
        ),
      );
    }
    checks[idx] = row(
      `manifest-matches-session@${short}`,
      problems,
      `${n} session(s) matched`,
      n === 0 ? "recordings did not decode" : undefined,
    );
  }
}
