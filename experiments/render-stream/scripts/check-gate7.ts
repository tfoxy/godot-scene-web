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
// closing paragraph) plus G7d's phone groups. Landed: g7-dev and g7-bench (G7d), g7-0's web
// half (G7e: `--source gate0=<run> --bundle <web bundle> --extension <.gdextension>`,
// lib/gate7-adapters.ts checkGate0Web, reported in `results`), the web half of g7-1 to g7-6
// and g7-55 (G7b: `--source gate<N>=<run>` each, lib/gate7b-adapters.ts checkGateWeb), and the
// gsw half of g7-0 to g7-3 (G7a) and g7-4 and g7-5 (G7t; lib/gate7-gsw.ts, lib/gate7-gsw-g45.ts).
// G7l: `--live` judges the live runs of g7-1, g7-2, g7-5 and g7-55 instead (run-gate7.sh --live;
// lib/gate7-live.ts checkGateLive), one result per group and receiver kind; `--web-core rust`
// (G7xwl) judges a web run on the Rust core (receiver-core@web). G7g: the gsw half of g7-6
// (lib/gate7-gsw-g6.ts), presentation-check on both halves, and g7-6's live g6l.
// G7r: `--live` with g7-r judges <out>/gate6/rates-<kind>/ for each receiver kind present
// (`--receiver native|web|gsw` asks for one; lib/gate7r-checks.ts), one result per kind.
// G7h's harness checks are folded into `report.harness` when present. Requesting a group before
// its increment lands is refused,
// exactly as `run-gate6.sh` refuses an unlanded group.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildGate4Report } from "./check-gate4";
import { buildGate5Report } from "./check-gate5";
import { buildGate6Report } from "./check-gate6";
import { type Gate0Expected, runGate0 } from "./lib/gate0-checks";
import { runGate1 } from "./lib/gate1-checks";
import type { Gate1Expected } from "./lib/gate1-expected";
import { runGate2 } from "./lib/gate2-checks";
import type { Gate2Expected } from "./lib/gate2-expected";
import { runGate3 } from "./lib/gate3-checks";
import type { Gate3Expected } from "./lib/gate3-expected";
import type { Gate3xExpected } from "./lib/gate3x-expected";
import {
  checkGate0Web,
  currentBuildProvenance,
  type Gate7GroupResult,
} from "./lib/gate7-adapters";
import { presentationCheck } from "./lib/gate7-g6-checks";
import {
  checkGswGroup,
  type GswGate,
  type GswGroupInput,
  type GswGroupResult,
} from "./lib/gate7-gsw";
import { gswExtraChecks } from "./lib/gate7-gsw-checks";
import { GATE6_LEGS } from "./lib/gate7-gsw-g6";

import {
  checkGateLive,
  GATE7L_GATES,
  type LiveGroupResult,
} from "./lib/gate7-live";
import { checkGateWeb, GATE7B_GATES } from "./lib/gate7b-adapters";
import {
  type BenchTableRow,
  type Gate7Check,
  runGate7BenchChecks,
  runGate7DevChecks,
} from "./lib/gate7d-checks";
import {
  checkG7rKind,
  G7R_KINDS,
  type G7rKindResult,
} from "./lib/gate7r-checks";
import type { Gate55Expected as Gate55CimExpected } from "./lib/gate55b-expected";
import { runGate55d } from "./lib/gate55d-checks";
import { type Gate55eExpected, runGate55e } from "./lib/gate55e-checks";

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
export const LANDED_GROUPS: readonly string[] = [
  "g7-0",
  "g7-1",
  "g7-2",
  "g7-3",
  "g7-4",
  "g7-5",
  "g7-55",
  "g7-6",
  "g7-r",
  "g7-dev",
  "g7-bench",
];
/** G7a: the groups with gsw legs (G7b adds the web half of g7-1..g7-6 and g7-55; G7t and G7s
 * the gsw half of g7-4, g7-5 and g7-55). */
const GSW_GATES: Record<string, GswGate> = {
  "g7-0": "gate0",
  "g7-1": "gate1",
  "g7-2": "gate2",
  "g7-3": "gate3",
  "g7-55": "gate55",
  "g7-4": "gate4",
  "g7-5": "gate5",
  "g7-6": "gate6",
};

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
  /** G7e: one entry per requested group and receiver kind (g7-0 web; G7a: g7-0..g7-3 gsw). */
  results: (
    | Gate7GroupResult
    | GswGroupResult
    | LiveGroupResult
    | G7rKindResult
  )[];
}

interface Args {
  out: string;
  legs: string[];
  sources: Record<string, string>;
  bundle: string | undefined;
  gswBundle: string | undefined;
  extension: string | undefined;
  /** web, gsw, or both (unset). */
  receiver: string | undefined;
  /** G7l: judge only the live runs (`<out>/<gate>/live-<kind>/`) of the requested groups. */
  live: boolean;
  /** G7xwl: the web export's expected core on a live run (`--web-core`, default rust since G7xd). */
  webCore: "gdscript" | "rust";
}

function parseArgs(argv: string[]): Args {
  let out: string | undefined;
  let legsArg = "";
  const sources: Record<string, string> = {};
  let bundle: string | undefined;
  let gswBundle: string | undefined;
  let extension: string | undefined;
  let receiver: string | undefined;
  let live = false;
  let webCore: "gdscript" | "rust" = "rust";
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
    } else if (argv[i] === "--gsw-bundle") {
      gswBundle = resolve(argv[++i] ?? "");
    } else if (argv[i] === "--receiver") {
      receiver = argv[++i] || undefined;
    } else if (argv[i] === "--live") {
      live = true;
    } else if (argv[i] === "--web-core") {
      const v = argv[++i];
      if (v !== "gdscript" && v !== "rust")
        throw new Error(
          `check-gate7: --web-core is gdscript or rust, not ${v}`,
        );
      webCore = v;
    }
  }
  if (!out) throw new Error("check-gate7: --out <evidence dir> is required");
  const legs = legsArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    out: resolve(out),
    legs,
    sources,
    bundle,
    gswBundle,
    extension,
    receiver,
    live,
    webCore,
  };
}

async function readJsonOrUndefined<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The gate's own checker (D21: judged by its own code, never a fork). */
async function gateChecker(
  gate: GswGate,
): Promise<GswGroupInput["runChecker"]> {
  const fixtures = join(EXPERIMENT_DIR, "fixtures");
  const receiverProjectDir = join(EXPERIMENT_DIR, "receiver");
  const json = async <T>(path: string) =>
    JSON.parse(await readFile(path, "utf8")) as T;
  switch (gate) {
    case "gate0": {
      const expected = await json<Gate0Expected>(
        join(fixtures, "gate0", "expected.json"),
      );
      return (dir) =>
        runGate0(dir, {
          expected,
          fixtureProjectDir: join(fixtures, "gate0"),
          receiverProjectDir,
        }) as never;
    }
    case "gate1": {
      const expected = await json<Gate1Expected>(
        join(fixtures, "gate1", "expected.json"),
      );
      return (dir) =>
        runGate1(dir, {
          expected,
          fixtureProjectDir: join(fixtures, "gate1"),
          receiverProjectDir,
        }) as never;
    }
    case "gate2": {
      const expected = await json<Gate2Expected>(
        join(fixtures, "gate2", "expected.json"),
      );
      return (dir) => runGate2(dir, { expected }) as never;
    }
    case "gate3": {
      const expected = await json<Gate3Expected>(
        join(fixtures, "gate3", "expected.json"),
      );
      const xform = await json<Gate3xExpected>(
        join(fixtures, "gate3-xform", "expected.json"),
      );
      return (dir) =>
        runGate3(dir, {
          expected,
          xform,
          receiverProjectDir,
          fixtureProjectDir: join(fixtures, "gate3"),
        }) as never;
    }
    case "gate55": {
      // Gate 5.5's receiver legs are judged by its g55d (CanvasItemMaterial) and g55e
      // (ShaderMaterial) checks; g55b/g55c judge captures and references only (D21).
      const cim = await json<Gate55CimExpected>(
        join(fixtures, "gate55-cim", "expected.json"),
      );
      const shader = await json<Gate55eExpected>(
        join(fixtures, "gate55-shader", "expected.json"),
      );
      return async (dir) => {
        const d = await runGate55d(dir, cim);
        const e = await runGate55e(dir, shader);
        const checks = [...d.checks, ...e.checks];
        return {
          checks,
          legs: { ...d.legs, ...e.legs },
          gate_passed: checks.every((c) => c.passed),
        } as never;
      };
    }
    // G7t: gates 4 and 5 through their CLIs' own report builders (every group that ran).
    case "gate4":
      return (dir) => buildGate4Report(dir) as never;
    case "gate5":
      return (dir) => buildGate5Report(dir) as never;
    // G7g: gate 6 through its CLI's report builder.
    case "gate6":
      return (dir) => buildGate6Report(dir) as never;
  }
}

async function main(): Promise<void> {
  const {
    out,
    legs,
    sources,
    bundle,
    gswBundle,
    extension,
    receiver,
    live,
    webCore,
  } = parseArgs(process.argv.slice(2));

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
  const results: (
    | Gate7GroupResult
    | GswGroupResult
    | LiveGroupResult
    | G7rKindResult
  )[] = [];
  // G7l: `--live` judges only the live runs (lib/gate7-live.ts), never the file legs' sources.
  const wantWeb =
    !live && (receiver === "web" || (!receiver && bundle !== undefined));
  const wantGsw =
    !live && (receiver === "gsw" || (!receiver && gswBundle !== undefined));
  if (live) {
    for (const def of GATE7L_GATES) {
      if (!legs.includes(def.group)) continue;
      for (const kind of ["web", "gsw"] as const) {
        if (receiver && receiver !== kind) continue;
        const runDir = join(out, def.gate, `live-${kind}`);
        if (!existsSync(runDir)) {
          if (receiver === kind)
            throw new Error(
              `check-gate7: --live ${def.group}@${kind}: no ${runDir}`,
            );
          continue;
        }
        console.log(
          `check-gate7: judging ${def.group} live (${def.gate}) @${kind}`,
        );
        results.push(
          await checkGateLive({
            def,
            kind,
            runDir,
            viewsDir: join(out, def.gate, `live-${kind}-views`),
            core: webCore,
          }),
        );
      }
    }
    // G7r: one result per receiver kind that ran (run-gate7.sh --live --legs g7-r).
    if (legs.includes("g7-r")) {
      for (const kind of G7R_KINDS) {
        if (receiver && receiver !== kind) continue;
        const runDir = join(out, "gate6", `rates-${kind}`);
        if (!existsSync(runDir)) {
          if (receiver === kind)
            throw new Error(`check-gate7: --live g7-r@${kind}: no ${runDir}`);
          continue;
        }
        console.log(`check-gate7: judging g7-r @${kind} (${runDir})`);
        results.push(await checkG7rKind(out, kind, webCore));
      }
      if (!results.some((r) => r.group === "g7-r"))
        throw new Error(
          "check-gate7: --live g7-r: no <out>/gate6/rates-<kind>/",
        );
    }
  }
  if (legs.includes("g7-0") && wantWeb) {
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
  if (wantGsw) {
    if (!extension)
      throw new Error(
        "check-gate7: gsw groups need --extension <.gdextension> (D21)",
      );
    const current = currentBuildProvenance(
      REPO_ROOT,
      extension,
      PINNED_LINUX_TEMPLATE,
    );
    for (const group of legs.filter((g) => g in GSW_GATES)) {
      const gate = GSW_GATES[group];
      const source = sources[gate];
      if (!source || !gswBundle)
        throw new Error(
          `check-gate7: ${group}@gsw needs --source ${gate}=<run> and --gsw-bundle <dir>`,
        );
      const input: GswGroupInput = {
        gate,
        sourceDir: source,
        gswRoot: join(out, gate, "gsw"),
        viewDir: join(out, gate, "gsw-view"),
        bundleDir: gswBundle,
        current,
        runChecker: await gateChecker(gate),
        extra: () => gswExtraChecks(gate, { out, sourceDir: source }),
      };
      results.push(await checkGswGroup(input));
    }
  }
  // G7b: gates 1 to 6, web half (lib/gate7b-adapters.ts). Each needs `--source <gate>=<run>`.
  for (const def of GATE7B_GATES) {
    if (!wantWeb || !legs.includes(def.group)) continue;
    const source = sources[def.gate];
    if (!source || !bundle || !extension) {
      throw new Error(
        `check-gate7: ${def.group} needs --source ${def.gate}=<run>, --bundle <web bundle> and --extension <.gdextension>`,
      );
    }
    console.log(`check-gate7: judging ${def.group} (${def.gate}) on the web`);
    const r = await checkGateWeb({
      def,
      sourceDir: source,
      gateOut: join(out, def.gate),
      bundleDir: bundle,
      current: currentBuildProvenance(
        REPO_ROOT,
        extension,
        PINNED_LINUX_TEMPLATE,
      ),
    });
    const { classification: _c, ...rest } = r;
    // G7g: the web export's backing store at gate 6's three presentation sizes.
    if (def.gate === "gate6") {
      rest.checks.push(
        await presentationCheck(
          "web",
          new Map(
            GATE6_LEGS.filter((d) => d.replaces).map((d) => [
              d.leg,
              join(out, def.gate, "web", d.leg),
            ]),
          ),
        ),
      );
      rest.passed = rest.checks.every((c) => c.passed || !c.gating);
    }
    results.push(rest);
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
    if ("startup" in r)
      for (const s of r.startup) console.log(`startup  ${JSON.stringify(s)}`);
    if ("not_applicable" in r)
      for (const n of r.not_applicable)
        console.log(`N/A   ${r.group}  ${n.id}  ${n.reason}`);
    if ("phase" in r)
      for (const p of r.phase)
        console.log(
          `phase  g7-r@${r.kind}  ${p.variant} r${p.run}  published ${p.published?.toFixed(2)}/s  credit RTT mean ${p.credit_rtt_mean_frames?.toFixed(2)} frames  hold p50/p95 ${p.hold_p50_us}/${p.hold_p95_us} us  ${p.class}`,
        );
    if ("cadence" in r)
      for (const c of r.cadence)
        console.log(
          `cadence  ${r.group}@${r.kind}  ${c.leg}#${c.connection}  sent ${c.sent}/${c.frames_offered} offered, coalesced ${c.coalesced}, credit RTT frames p50 ${c.credit_rtt_frames_median} p95 ${c.credit_rtt_frames_p95}, submitted ack us p50 ${c.submitted_ack_us_median} p95 ${c.submitted_ack_us_p95}`,
        );
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
