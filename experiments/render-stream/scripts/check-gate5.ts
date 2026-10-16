#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 5 checker CLI. Evaluates the checks of the groups that ran against the evidence
// run-gate5.sh wrote to --out, writes <out>/result.json (render-stream-gate5-report/1), prints one
// line per check and per leg, the measured hook census, the freshness table and the
// reference-repeat budgets, and exits non-zero unless gate_passed.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/check-gate5.ts --out <evidence dir>
//
// The checks live in lib/gate5-checks.ts, which scripts/test/self-test-gate5.ts drives with
// synthetic values.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readGroups, runGate5 } from "./lib/gate5-checks";
import type { Gate5Expected } from "./lib/gate5-expected";
import { type Gate5MeshExpected, runGate5c } from "./lib/gate5c-checks";
import { runGate5e } from "./lib/gate5e-checks";
import { runGate5f } from "./lib/gate5f-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..");

function parseArgs(argv: string[]): { out: string } {
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = argv[i + 1];
      i++;
    }
  }
  if (!out) throw new Error("check-gate5: --out <evidence dir> is required");
  return { out: resolve(out) };
}

/** Gate 5's report for the evidence in `out` (every group that ran), unprinted: the CLI below and
 * gate 7's adapter (lib/gate7-gsw-g45.ts, judging a gsw view of a gate 5 run) both call it. */
export async function buildGate5Report(
  out: string,
): Promise<Awaited<ReturnType<typeof runGate5>>> {
  const fixture = join(EXPERIMENT_DIR, "fixtures", "gate5");
  const expected = JSON.parse(
    await readFile(join(fixture, "expected.json"), "utf8"),
  ) as Gate5Expected;

  // G5g: fixtures/gate5-style/ has its own expected.json; runGate5 reads it only when g5g ran.
  const styleFixture = join(EXPERIMENT_DIR, "fixtures", "gate5-style");
  const styleExpected = JSON.parse(
    await readFile(join(styleFixture, "expected.json"), "utf8"),
  ) as Gate5Expected;

  const report = await runGate5(out, {
    expected,
    receiverProjectDir: join(EXPERIMENT_DIR, "receiver"),
    fixtureProjectDir: fixture,
    styleExpected,
    styleProjectDir: styleFixture,
  });

  // G5c: fixtures/gate5-mesh/ is its own fixture with its own expected.json and legs (mesh/ under
  // the same --out), evaluated by runGate5c and merged into the same report so
  // `--legs g5b,g5c` gives one gate_passed verdict.
  const groups = await readGroups(out);
  if (groups.run.includes("g5c")) {
    const meshExpected = JSON.parse(
      await readFile(
        join(EXPERIMENT_DIR, "fixtures", "gate5-mesh", "expected.json"),
        "utf8",
      ),
    ) as Gate5MeshExpected;
    const mesh = await runGate5c(out, meshExpected);
    report.checks.push(...mesh.checks);
    Object.assign(report.legs, mesh.legs);
    report.checkpoints.push(...mesh.checkpoints);
    report.meshes = {
      ...(report.meshes ?? {}),
      [meshExpected.fixture]: mesh.meshes,
    };
    report.budgets = {
      ...(report.budgets ?? {}),
      [meshExpected.fixture]: mesh.budgets,
    };
    report.freshness = {
      ...(report.freshness ?? {}),
      [meshExpected.fixture]: mesh.freshness,
    };
    // runGate5 counts a run without g5b as failed; with g5b run, g5c's checks join the verdict.
    report.gate_passed =
      report.gate_passed && mesh.checks.every((c) => c.status === "pass");
    // G5e: the mesh fixture's wire, receivers and sabotages (needs g5c's legs in the same run).
    if (groups.run.includes("g5e")) {
      const g5e = await runGate5e(out, meshExpected, {
        receiverProjectDir: join(EXPERIMENT_DIR, "receiver"),
        fixtureProjectDir: join(EXPERIMENT_DIR, "fixtures", "gate5-mesh"),
      });
      report.checks.push(...g5e.checks);
      Object.assign(report.legs, g5e.legs);
      report.g5e = g5e.report;
      report.gate_passed =
        report.gate_passed && g5e.checks.every((c) => c.status === "pass");
    }
    // G5f: live legs on the mesh fixture (its own reference-live and hosts, under <out>/mesh/;
    // reads meshExpected.regions only, so it needs g5c in the same run for that, not g5c's legs).
    if (groups.run.includes("g5f")) {
      const g5f = await runGate5f(out, meshExpected);
      report.checks.push(...g5f.checks);
      Object.assign(report.legs, g5f.legs);
      report.g5f = g5f;
      report.gate_passed =
        report.gate_passed && g5f.checks.every((c) => c.status === "pass");
    }
  }
  return report;
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const report = await buildGate5Report(out);
  await writeFile(
    join(out, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  for (const c of report.checks) {
    const tag = c.status === "not-run" ? "NOT-RUN" : c.passed ? "PASS" : "FAIL";
    console.log(`[${tag}] ${c.id}: ${c.criterion}`);
    if (c.detail) console.log(`       ${c.detail}`);
  }
  console.log("");
  for (const [leg, entry] of Object.entries(report.legs)) {
    const cls = entry.expected_class
      ? `${entry.result_class} (expected ${entry.expected_class})`
      : "support";
    console.log(`  ${leg}: ${cls}, exit ${entry.exit_code ?? "?"}`);
  }
  for (const [name, g] of Object.entries(report.geometry ?? {})) {
    console.log(
      `  hook census (${name}): ${Object.entries(g.hook_census)
        .map(([op, n]) => `${op.replace("canvas_item_add_", "")}=${n}`)
        .join(" ")}`,
    );
    console.log(
      `  pixel classes (${name}), step: exact/delta1/band/undecided: ${Object.entries(
        g.exactness,
      )
        .map(([k, r]) => `${k}:${r.exact}/${r.delta1}/${r.band}/${r.undecided}`)
        .join(" ")}`,
    );
  }
  for (const [name, meshes] of Object.entries(report.meshes ?? {}))
    console.log(
      `  mesh hook log (${name}), mesh: id, lines, last version, median copy/hash ns: ${Object.entries(
        meshes as Record<string, Record<string, unknown>>,
      )
        .filter(([mesh]) => !mesh.startsWith("_"))
        .map(
          ([mesh, m]) =>
            `${mesh} ${m.id}/${m.lines}/v${m.last_version}/${m.copy_ns_median}/${m.hash_ns_median}`,
        )
        .join(" ")}`,
    );
  for (const [name, table] of Object.entries(report.freshness ?? {}))
    console.log(
      `  fresh regions (${name}), step: ${Object.entries(table)
        .map(([k, r]) => `${k}:${r.join("+")}`)
        .join(" ")}`,
    );
  for (const [name, b] of Object.entries(report.budgets ?? {}))
    console.log(
      `  reference-repeat budget (${name}), region/class max/mismatched of pixels: ${b
        .filter(
          (x) =>
            x.class === "band" ||
            x.class === "undecided" ||
            x.mismatched_pixels > 0,
        )
        .map(
          (x) =>
            `${x.region}/${x.class} ${x.max_channel_delta}/${x.mismatched_pixels} of ${x.pixels}`,
        )
        .join(", ")}`,
    );
  if (report.g5d) {
    const g = report.g5d;
    console.log(
      `  g5d: ${g.commands_compared} /4 commands compared (${g.commands_within_ulp} within 2 ulp); lowering: ${Object.entries(
        g.lowering,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join("; ")}`,
    );
    console.log(
      `  g5d scissors (full sink): ${Object.entries(g.clip_rects)
        .map(([k, v]) => `${k} ${v}`)
        .join("; ")}`,
    );
    for (const [leg, table] of Object.entries(g.sabotage_regions))
      console.log(
        `  ${leg}: mismatching regions per step ${Object.entries(table)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")}`,
      );
    console.log(`  capture-canvas entries: ${g.canvas_entries.join(", ")}`);
  }
  if (report.g5e) {
    const g = report.g5e;
    console.log(
      `  g5e: ${g.hash_parity_surfaces} wire surface-steps equal the oracle; store ${g.store.mesh_payloads} GRM1 payloads, ${g.store.mesh_bytes} B`,
    );
    console.log(
      `  g5e wire mesh tables (frame: {id:status}): ${Object.entries(
        g.wire_census,
      )
        .map(([f, v]) => `${f}:{${v}}`)
        .join(" ")}`,
    );
    for (const [leg, u] of Object.entries(g.uploads))
      console.log(
        `  ${leg} uploads: ${u.rows} rows, ${u.bytes} B (${Object.entries(
          u.by_op,
        )
          .map(([op, n]) => `${op} ${n}`)
          .join(
            ", ",
          )}); fetched ${g.fetches[leg]?.fetched ?? 0} mesh payloads, ${g.fetches[leg]?.fetched_bytes ?? 0} B`,
      );
    for (const [leg, table] of Object.entries(g.sabotage_regions))
      console.log(
        `  ${leg}: mismatching regions per step ${Object.entries(table)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")}`,
      );
    console.log(
      `  g5e mesh cost per step (lines, payloads, median copy/hash ns, live surface bytes): ${Object.entries(
        g.per_step,
      )
        .map(
          ([k, v]) =>
            `${k}:${v.mesh_lines}/${v.payloads_made}/${v.copy_ns_median}/${v.hash_ns_median}/${v.live_surface_bytes}`,
        )
        .join(" ")}`,
    );
  }
  if (report.g5f) {
    const g = report.g5f;
    console.log(
      `  g5f live-mesh-stall: send frame ${g.stall.live_mesh_stall.send_frame}, credit frame ${g.stall.live_mesh_stall.credit_frame}, post-stall step ${g.stall.live_mesh_stall.post_stall_step}, coalesced +${g.stall.live_mesh_stall.coalesced_delta}`,
    );
    console.log(
      `  g5f sabotage-mesh-stale-coalesce: send frame ${g.stall.sabotage.send_frame}, credit frame ${g.stall.sabotage.credit_frame}, post-stall step ${g.stall.sabotage.post_stall_step}, stale_from ${g.stall.sabotage.stale_from}`,
    );
  }
  const passed = report.checks.filter((c) => c.passed).length;
  console.log(
    `\ngate 5 (groups ${report.groups.run.join(",") || "none"}${report.groups.not_run.length > 0 ? `; not run: ${report.groups.not_run.join(",")}` : ""}): ${report.gate_passed ? "PASS" : "FAIL"} ${passed}/${report.checks.length} (${join(out, "result.json")})`,
  );
  if (!report.gate_passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
