#!/usr/bin/env -S pnpm exec tsx --conditions=development
// CLI and builder for `render-stream-report/2` (gate7-design.md Q12, G7p): `validate` checks a report
// file (either schema), `build` assembles a /2 report from a run-set directory that lib/gate7p-checks.ts
// wrote.
//
//   mise exec -- pnpm render-stream:report2 -- validate <report.json> [--repeats 1]
//   mise exec -- pnpm render-stream:report2 -- build <run-set dir> --out <report.json>
//
// The run-set directory is report-gate6.ts's (run.json, scenarios/<id>/{meta.json, warmup,
// repeat-N/repeat.json}), with two differences:
//
//   <dir>/provenance.json   a complete /2 provenance (engine, capture, receiver with kind/browser/bundle,
//                           protocol, host, display, timing, env), host fields filled in from this machine
//   <dir>/device-rows.json  optional {rows, omitted, startup}: the phone's rows (lib/gate7p-device.ts)
//
// `build` refuses to write a report that fails `validate()`, as report-gate6.ts does.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { probeHostProvenance } from "./lib/provenance";
import {
  type DeviceRow,
  type OmittedDeviceRow,
  RENDER_STREAM_REPORT_2_SCHEMA,
  type RenderStreamReport,
  type ReportProvenance,
  type ReportRun,
  type ReportScenario,
  validate,
} from "./lib/render-stream-report";
import { buildScenario, readJson } from "./report-gate6";

export interface DeviceRowsFile {
  rows: DeviceRow[];
  omitted: OmittedDeviceRow[];
  startup?: unknown[];
}

export async function buildReport2(
  dir: string,
  opts: { repeats?: 1 | 5 } = {},
): Promise<RenderStreamReport> {
  const run = await readJson<ReportRun>(join(dir, "run.json"));
  const declared = await readJson<ReportProvenance>(
    join(dir, "provenance.json"),
  );
  const host = probeHostProvenance();
  const provenance: ReportProvenance = {
    ...declared,
    host: {
      cpu_model: declared.host?.cpu_model ?? host.cpu_model ?? "unknown",
      logical_cpus: declared.host?.logical_cpus ?? host.logical_cpus,
      ram_bytes: declared.host?.ram_bytes ?? host.ram_bytes,
      kernel: declared.host?.kernel ?? host.kernel,
      cpu_governor: declared.host?.cpu_governor ?? host.cpu_governor,
    },
  };
  const ids = (await readdir(join(dir, "scenarios"), { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const scenarios: ReportScenario[] = [];
  for (const id of ids)
    scenarios.push(await buildScenario(dir, id, opts.repeats ?? 5));
  let rows: DeviceRowsFile = { rows: [], omitted: [] };
  try {
    rows = JSON.parse(
      await readFile(join(dir, "device-rows.json"), "utf8"),
    ) as DeviceRowsFile;
  } catch {
    /* no device evidence for this report */
  }
  return {
    schema: RENDER_STREAM_REPORT_2_SCHEMA,
    run,
    provenance,
    scenarios,
    optimizations: null,
    device_rows: rows.rows,
    omitted_device_rows: rows.omitted,
    ...(rows.startup ? { device_startup: rows.startup } : {}),
  } as RenderStreamReport;
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  const argv = raw[0] === "--" ? raw.slice(1) : raw;
  const [cmd, target, ...rest] = argv;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const repeats = flag("--repeats") === "1" ? 1 : 5;
  if (cmd === "validate" && target) {
    const errors = validate(await readJson<unknown>(target), { repeats });
    if (errors.length === 0) {
      console.log(`report-gate7: ${target} is a valid render-stream-report`);
      return;
    }
    console.error(`report-gate7: ${target} failed validation:`);
    for (const e of errors) console.error(`  ${e}`);
    process.exitCode = 1;
    return;
  }
  if (cmd === "build" && target) {
    const out = flag("--out");
    if (!out) throw new Error("report-gate7: build needs --out <file.json>");
    const report = await buildReport2(target, { repeats });
    const errors = validate(report, { repeats });
    if (errors.length > 0) {
      console.error(
        "report-gate7: built report fails validation, refusing to write it:",
      );
      for (const e of errors) console.error(`  ${e}`);
      process.exitCode = 1;
      return;
    }
    await writeFile(out, JSON.stringify(report, null, 2));
    console.log(`report-gate7: wrote ${out}`);
    return;
  }
  throw new Error(
    "report-gate7: usage: report-gate7.ts validate <report.json> | build <run-set dir> --out <file>",
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
