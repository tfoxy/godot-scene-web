#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 7 checker CLI -- SKELETON (G7h; protocol/gate7-design.md "G7h" increment). This mirrors
// check-gate6.ts's shape (ALL_GROUPS/LANDED_GROUPS, a `render-stream-gate7-report/N` written to
// <out>/result.json, one line per check, non-zero exit unless gate_passed) so each later
// increment (G7a, G7e, G7b, G7t, G7s, G7l, G7g, G7u, G7r, G7k, G7p, G7z) extends this file with
// its own `runGate7<x>` import and a case in `checkGroup`, rather than writing a parallel checker.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate7.ts --out <evidence dir>
//
// `ALL_GROUPS` below is the FINAL vocabulary gate 7 passes against (protocol/gate7-design.md's
// closing paragraph) plus G7d's phone groups. Landed: g7-dev and g7-bench (G7d), and g7-0's web
// half (G7e: `--source gate0=<run> --bundle <web bundle> --extension <.gdextension>`,
// lib/gate7-adapters.ts checkGate0Web, reported in `results`). G7h's harness checks are folded
// into `report.harness` when present. Requesting a group before its increment lands is refused,
// exactly as `run-gate6.sh` refuses an unlanded group.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Gate0Expected } from "./lib/gate0-checks";
import {
  checkGate0Web,
  currentBuildProvenance,
  type Gate7GroupResult,
} from "./lib/gate7-adapters";

import {
  type BenchTableRow,
  type Gate7Check,
  runGate7BenchChecks,
  runGate7DevChecks,
} from "./lib/gate7d-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(EXPERIMENT_DIR, "..", "..");
const PINNED_LINUX_TEMPLATE = join(
  homedir(),
  ".cache",
  "godot-render-stream",
  "templates",
  "4.5.1-stable",
  "linux_release.x86_64",
);

/** The final leg-group vocabulary (gate7-design.md "Gate 7 passes when…") plus G7d's phone groups
 * (`g7-dev`, Q13d; `g7-bench`, Q13e). */
export const ALL_GROUPS = [
  "g7-0",
  "g7-1",
  "g7-2",
  "g7-3",
  "g7-4",
  "g7-5",
  "g7-55",
  "g7-6",
  "g7-lc",
  "g7-r",
  "g7-k",
  "g7-dev",
  "g7-bench",
] as const;
export const LANDED_GROUPS: readonly string[] = ["g7-0", "g7-dev", "g7-bench"];

interface HarnessCheck {
  id: string;
  ok: boolean;
  detail: string;
}

interface HarnessProbes {
  schema?: string;
  gate_passed?: boolean;
  checks?: HarnessCheck[];
  [key: string]: unknown;
}

export interface Gate7Report {
  schema: "render-stream-gate7-report/1";
  generated_at: string;
  gate_passed: boolean;
  groups: { requested: string[]; landed: string[]; not_run: string[] };
  /** G7h's own checks (browser-provenance, wayland-fd-zero, the two evidence-PUT checks,
   * probe-rect-exact-readback, compositor-equals-readback, sabotage-swiftshader-refused), folded
   * in from `<out>/g7h-probes/evidence/probes.json` if that leg was run. `null` if it was not --
   * a gate 7 run that never exercised the harness has nothing to say about it, which is reported
   * honestly rather than assumed passing. */
  harness: {
    present: boolean;
    probes_schema: string | null;
    checks: HarnessCheck[];
  } | null;
  /** G7d: the run's environment (run-gate7.sh run.json). */
  env: { env: string; device: string | null; receiver: string | null } | null;
  /** G7d: each landed group's checks. */
  group_checks: Record<string, Gate7Check[]>;
  /** G7d: the bench's per-receiver, per-input, per-phase table (g7-bench). */
  bench_table: BenchTableRow[];
  /** G7e: one entry per requested group and receiver kind (g7-0 web). */
  results: Gate7GroupResult[];
}

interface Args {
  out: string;
  legs: string[];
  sources: Record<string, string>;
  bundle: string | undefined;
  extension: string | undefined;
}

function parseArgs(argv: string[]): Args {
  let out: string | undefined;
  let legsArg = "";
  const sources: Record<string, string> = {};
  let bundle: string | undefined;
  let extension: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = argv[++i];
    } else if (argv[i] === "--legs") {
      legsArg = argv[++i] ?? "";
    } else if (argv[i] === "--source") {
      for (const pair of (argv[++i] ?? "").split(",").filter(Boolean)) {
        const eq = pair.indexOf("=");
        if (eq > 0) sources[pair.slice(0, eq)] = resolve(pair.slice(eq + 1));
      }
    } else if (argv[i] === "--bundle") {
      bundle = resolve(argv[++i] ?? "");
    } else if (argv[i] === "--extension") {
      extension = resolve(argv[++i] ?? "");
    }
  }
  if (!out) throw new Error("check-gate7: --out <evidence dir> is required");
  const legs = legsArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { out: resolve(out), legs, sources, bundle, extension };
}

async function readJsonOrUndefined<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const { out, legs, sources, bundle, extension } = parseArgs(
    process.argv.slice(2),
  );

  for (const g of legs) {
    if (!(ALL_GROUPS as readonly string[]).includes(g)) {
      throw new Error(
        `check-gate7: unknown leg group: ${g} (known: ${ALL_GROUPS.join(", ")})`,
      );
    }
    if (!LANDED_GROUPS.includes(g)) {
      throw new Error(
        `check-gate7: leg group ${g} has not landed yet (landed: ${LANDED_GROUPS.length === 0 ? "none" : LANDED_GROUPS.join(", ")}) -- see protocol/gate7-design.md "Increments"`,
      );
    }
  }

  const probes = await readJsonOrUndefined<HarnessProbes>(
    join(out, "g7h-probes", "evidence", "probes.json"),
  );
  const harness = probes
    ? {
        present: true,
        probes_schema: probes.schema ?? null,
        checks: probes.checks ?? [],
      }
    : null;

  const notRun = ALL_GROUPS.filter((g) => !legs.includes(g));
  const env = await readJsonOrUndefined<{
    env: string;
    device: string | null;
    receiver: string | null;
  }>(join(out, "run.json"));
  const device = env?.env === "device" ? env.device : null;
  const groupChecks: Record<string, Gate7Check[]> = {};
  let benchTable: BenchTableRow[] = [];
  if (legs.includes("g7-dev"))
    groupChecks["g7-dev"] = await runGate7DevChecks(out, device);
  if (legs.includes("g7-bench")) {
    const bench = await runGate7BenchChecks(out, device, env?.receiver ?? null);
    groupChecks["g7-bench"] = bench.checks;
    benchTable = bench.table;
  }
  const results: Gate7GroupResult[] = [];
  if (legs.includes("g7-0")) {
    const source = sources.gate0;
    if (!source || !bundle || !extension) {
      throw new Error(
        "check-gate7: g7-0 needs --source gate0=<run>, --bundle <web bundle> and --extension <.gdextension>",
      );
    }
    const fixtureProjectDir = join(EXPERIMENT_DIR, "fixtures", "gate0");
    results.push(
      await checkGate0Web({
        sourceDir: source,
        webRoot: join(out, "gate0", "web"),
        viewDir: join(out, "gate0", "web-view"),
        bundleDir: bundle,
        expected: JSON.parse(
          await readFile(join(fixtureProjectDir, "expected.json"), "utf8"),
        ) as Gate0Expected,
        fixtureProjectDir,
        receiverProjectDir: join(EXPERIMENT_DIR, "receiver"),
        current: currentBuildProvenance(
          REPO_ROOT,
          extension,
          PINNED_LINUX_TEMPLATE,
        ),
      }),
    );
  }
  // `gate_passed` here means "every group this run requested passed": gate 7 as a whole needs every
  // increment (D23, "Gate 7 passes when…"), which the summary (G7z) judges, not this run.
  const harnessOk = harness ? harness.checks.every((c) => c.ok) : true;
  const groupsOk = Object.values(groupChecks).every((list) =>
    list.every((c) => c.ok),
  );
  const gatePassed = harnessOk && groupsOk && results.every((r) => r.passed);

  const report: Gate7Report = {
    schema: "render-stream-gate7-report/1",
    generated_at: new Date().toISOString(),
    gate_passed: gatePassed,
    groups: {
      requested: legs,
      landed: [...LANDED_GROUPS],
      not_run: [...notRun],
    },
    harness,
    env: env ?? null,
    group_checks: groupChecks,
    bench_table: benchTable,
    results,
  };

  await import("node:fs/promises").then(({ writeFile, mkdir }) =>
    mkdir(out, { recursive: true }).then(() =>
      writeFile(join(out, "result.json"), JSON.stringify(report, null, 2)),
    ),
  );

  console.log(`check-gate7: wrote ${join(out, "result.json")}`);
  if (harness) {
    for (const c of harness.checks) {
      console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.id}  ${c.detail}`);
    }
  } else {
    console.log(
      "check-gate7: no harness evidence at <out>/g7h-probes/evidence/probes.json",
    );
  }
  for (const [group, list] of Object.entries(groupChecks))
    for (const c of list)
      console.log(`${c.ok ? "PASS" : "FAIL"}  ${group}  ${c.id}  ${c.detail}`);
  for (const r of results) {
    for (const c of r.checks) {
      const tag = c.passed ? "PASS" : c.gating ? "FAIL" : "NOTE";
      console.log(`${tag}  ${r.group}  ${c.id}  ${c.detail}`);
    }
    for (const s of r.startup) console.log(`startup  ${JSON.stringify(s)}`);
  }
  const ms = (x: number | undefined) =>
    x === undefined ? "-" : (x / 1000).toFixed(3);
  for (const row of benchTable)
    console.log(
      `bench  ${row.leg}  ${Object.entries(row.phases)
        .map(([k, v]) => `${k} ${ms(v.p50_us)}/${ms(v.p95_us)}`)
        .join("  ")}  (ms p50/p95)  ${row.verdict ?? ""}`,
    );
  const total = Object.values(groupChecks).reduce((n, l) => n + l.length, 0);
  const passed = Object.values(groupChecks).reduce(
    (n, l) => n + l.filter((c) => c.ok).length,
    0,
  );
  console.log(
    `check-gate7: ${ALL_GROUPS.length} leg groups (${LANDED_GROUPS.length} landed), ${legs.length} requested; group checks ${passed}/${total}`,
  );
  console.log(
    `check-gate7: gate_passed=${gatePassed} (the requested groups; gate 7 overall needs every increment)`,
  );

  if (!gatePassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
