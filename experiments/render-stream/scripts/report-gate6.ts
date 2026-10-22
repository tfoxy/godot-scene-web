#!/usr/bin/env -S pnpm exec tsx --conditions=development
// CLI for `render-stream-report/1` (D10, Q7a/Q7f of ../protocol/gate6-design.md): `validate` checks
// an existing report file, `build` assembles one from a run-set directory a measurement increment
// (G6r/G6l/G6c/G6p) wrote.
//
//   mise exec -- pnpm render-stream:report -- validate <report.json> [--repeats 1]
//   mise exec -- pnpm render-stream:report -- build <run-set dir> --out <report.json> \
//     [--deltas <resources.jsonl>] [--repeats 1]
//
// `--repeats 1` (G6c) is the single functional repeat a gate leg writes: each scenario has
// `repeat-1/` only, no warmup directory, and the report carries `warmup: null` and
// `aggregate: null` (validated, not aggregated); the default is Q7f's five repeats.
//
// `build`'s run-set directory layout (this file's own convention -- nothing elsewhere in the
// repository defines the per-repeat measurement format yet, since that is G6r/G6l/G6c/G6p's job;
// this is the shape `scripts/lib/render-stream-report.ts`'s types already describe, laid out one
// JSON file per repeat so a measurement increment can write its five repeats and a warmup without
// assembling the whole document itself):
//
//   <dir>/run.json                                  ReportRun
//   <dir>/provenance.json                            a ReportProvenance, missing `host` fields
//                                                      filled in from this machine (provenance.ts)
//   <dir>/scenarios/<id>/meta.json                    the ReportScenario fields but `repeats`/
//                                                      `aggregate` (built here)
//   <dir>/scenarios/<id>/warmup/repeat.json           {"run_dir": "..."} (discarded; not read)
//   <dir>/scenarios/<id>/repeat-1/repeat.json ... repeat-5/repeat.json   each a ReportRepeat
//
// `build` refuses to write a report that fails `validate()` -- same rule every other check-gateN
// runner in this directory follows: never emit a result that is not internally sound.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { computeOptimizations, parseHookLog } from "./analyze-deltas";
import { probeHostProvenance } from "./lib/provenance";
import {
  aggregate,
  type RenderStreamReport,
  type ReportProvenance,
  type ReportRepeat,
  type ReportRun,
  type ReportScenario,
  validate,
} from "./lib/render-stream-report";

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function buildProvenance(dir: string): Promise<ReportProvenance> {
  const declared = await readJson<Partial<ReportProvenance>>(
    join(dir, "provenance.json"),
  );
  const probedHost = probeHostProvenance();
  return {
    engine: declared.engine as ReportProvenance["engine"],
    capture: declared.capture as ReportProvenance["capture"],
    receiver: declared.receiver as ReportProvenance["receiver"],
    protocol: declared.protocol as string,
    host: {
      cpu_model: declared.host?.cpu_model ?? probedHost.cpu_model ?? "unknown",
      logical_cpus: declared.host?.logical_cpus ?? probedHost.logical_cpus,
      ram_bytes: declared.host?.ram_bytes ?? probedHost.ram_bytes,
      kernel: declared.host?.kernel ?? probedHost.kernel,
      cpu_governor: declared.host?.cpu_governor ?? probedHost.cpu_governor,
    },
    display: declared.display as ReportProvenance["display"],
    timing: declared.timing as ReportProvenance["timing"],
  };
}

export async function buildScenario(
  dir: string,
  id: string,
  count: 1 | 5,
): Promise<ReportScenario> {
  const scenarioDir = join(dir, "scenarios", id);
  const meta = await readJson<Omit<ReportScenario, "repeats" | "aggregate">>(
    join(scenarioDir, "meta.json"),
  );
  const repeats: ReportRepeat[] = [];
  for (let i = 1; i <= count; i++) {
    repeats.push(
      await readJson<ReportRepeat>(
        join(scenarioDir, `repeat-${i}`, "repeat.json"),
      ),
    );
  }
  if (count === 1) return { ...meta, warmup: null, repeats, aggregate: null };
  return { ...meta, repeats, aggregate: aggregate(repeats) };
}

export async function buildReport(
  dir: string,
  opts: { deltasPath?: string; repeats?: 1 | 5 } = {},
): Promise<RenderStreamReport> {
  const run = await readJson<ReportRun>(join(dir, "run.json"));
  const provenance = await buildProvenance(dir);
  const scenarioIds = (
    await readdir(join(dir, "scenarios"), { withFileTypes: true })
  )
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const scenarios: ReportScenario[] = [];
  for (const id of scenarioIds)
    scenarios.push(await buildScenario(dir, id, opts.repeats ?? 5));

  let optimizations: RenderStreamReport["optimizations"] = null;
  if (opts.deltasPath) {
    const { lines } = parseHookLog(await readFile(opts.deltasPath, "utf8"));
    optimizations = computeOptimizations(lines);
  }

  return {
    schema: "render-stream-report/1",
    run,
    provenance,
    scenarios,
    optimizations,
  };
}

function parseArgs(argv: string[]): {
  out?: string;
  deltas?: string;
  repeats?: 1 | 5;
} {
  const out: { out?: string; deltas?: string; repeats?: 1 | 5 } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--deltas") out.deltas = argv[++i];
    else if (argv[i] === "--repeats") {
      const n = argv[++i];
      if (n !== "1" && n !== "5")
        throw new Error(`report-gate6: --repeats must be 1 or 5 (got ${n})`);
      out.repeats = n === "1" ? 1 : 5;
    }
  }
  return out;
}

async function main(): Promise<void> {
  // `pnpm render-stream:report -- validate|build ...` (Q7a's own invocation form) forwards the
  // literal "--" separator onto this script's argv alongside the args after it; a direct `tsx
  // report-gate6.ts validate ...` call never has one, so only strip it when it is first.
  const rawArgv = process.argv.slice(2);
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const [cmd, target, ...rest] = argv;
  if (cmd === "validate") {
    if (!target)
      throw new Error(
        "report-gate6: usage: report-gate6.ts validate <report.json>",
      );
    const report = await readJson<unknown>(target);
    const errors = validate(report, { repeats: parseArgs(rest).repeats });
    if (errors.length === 0) {
      console.log(`report-gate6: ${target} is a valid render-stream-report/1`);
      return;
    }
    console.error(`report-gate6: ${target} failed validation:`);
    for (const e of errors) console.error(`  ${e}`);
    process.exitCode = 1;
    return;
  }
  if (cmd === "build") {
    if (!target)
      throw new Error(
        "report-gate6: usage: report-gate6.ts build <run-set dir> --out <file> [--deltas <resources.jsonl>]",
      );
    const { out, deltas, repeats } = parseArgs(rest);
    if (!out) throw new Error("report-gate6: build needs --out <file.json>");
    const report = await buildReport(target, { deltasPath: deltas, repeats });
    const errors = validate(report, { repeats });
    if (errors.length > 0) {
      console.error(
        "report-gate6: built report fails validation, refusing to write it:",
      );
      for (const e of errors) console.error(`  ${e}`);
      process.exitCode = 1;
      return;
    }
    await writeFile(out, JSON.stringify(report, null, 2));
    console.log(`report-gate6: wrote ${out}`);
    return;
  }
  throw new Error("report-gate6: usage: report-gate6.ts validate|build ...");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
