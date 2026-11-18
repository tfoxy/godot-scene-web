// VS5b: summarizes run-gate7.sh's vp sweeps (G7V_LEGS=vp-..., lib/gate7-vp.ts header).
//
//   tsx gate7-vp-summary.ts --out <run-gate7 out>
//
// Writes <sweep dir>/vp-summary.json per sweep and <out>/g7v-vp-summary.json (every sweep), and
// prints one line per arm and per sweep. Exits 0 when at least one sweep was found (admissibility
// is stated, not enforced), 1 when none was.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  findSweeps,
  summarizeSweep,
  type VpSweepSummary,
} from "./lib/gate7-vp";

const argv = process.argv.slice(2);
const i = argv.indexOf("--out");
if (i < 0 || !argv[i + 1]) {
  console.error("usage: gate7-vp-summary.ts --out <run-gate7 out dir>");
  process.exit(2);
}
const out = resolve(argv[i + 1]);
const f = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? "?" : v.toFixed(d);

const sweeps: VpSweepSummary[] = [];
for (const { run, dir } of findSweeps(out)) {
  const s = summarizeSweep(run, dir);
  if (!s) continue;
  writeFileSync(
    join(dir, "vp-summary.json"),
    `${JSON.stringify(s, null, 2)}\n`,
  );
  sweeps.push(s);
  console.log(
    `gate7-vp-summary: ${run} (${s.workload}, window ${s.window}, ${s.env}${s.device ? ` ${s.device}` : ""})`,
  );
  for (const a of s.arms) {
    const d = a.frame_interval_ms;
    const sf = a.surfaces ?? {};
    console.log(
      `  ${a.arm.padEnd(3)} client ${a.viewports_client ? "on " : "off"} host ${a.viewports_host}: ${f(a.metrics.drawn_fps)} fps, interval p50/p95/p99/max ${f(d.p50)}/${f(d.p95)}/${f(d.p99)}/${f(d.max)} ms, >34 ms ${f((d.over_34_fraction ?? 0) * 100)}%, main p95 ${f(a.main_thread_ms.p95, 2)} ms, surfaces alloc ${sf.surfaces_allocated ?? "?"} rendered ${sf.surfaces_rendered ?? "?"} skipped ${sf.surfaces_skipped ?? "?"}, build ${String(a.build?.build_id ?? "?").slice(0, 12)}${a.void ? `  VOID: ${a.void_reasons.join("; ")}` : ""}`,
    );
  }
  console.log(
    `  A-vs-A ${s.a_vs_a.arms?.join("/") ?? "-"} fps spread ${f((s.a_vs_a.spread.drawn_fps ?? NaN) * 100)}%, B-vs-B ${s.b_vs_b.arms?.join("/") ?? "-"} ${f((s.b_vs_b.spread.drawn_fps ?? NaN) * 100)}%; B/A fps ${f(s.a_vs_b.drawn_fps.ratio, 3)}; admissible ${s.admissible}${s.admissible ? "" : ` (${s.admissible_reasons.join("; ")})`}`,
  );
  const amb = (k: string, scale: number, unit: string, d = 1) => {
    const e = s.a_vs_b[k];
    return `${k} ${f(e?.a === null || e?.a === undefined ? null : e.a / scale, d)}/${f(e?.b === null || e?.b === undefined ? null : e.b / scale, d)} A-B ${f(e?.a_minus_b === null || e?.a_minus_b === undefined ? null : e.a_minus_b / scale, d)} ${unit}`;
  };
  console.log(
    `  memory (allocation accounting, the number to use): ${amb("surface_bytes", 1048576, "MiB")}`,
  );
  console.log(
    `  observed on the device, NOT surface cost: ${amb("gpu_proc_graphics_after_kb", 1024, "MiB")}; ${amb("renderer_graphics_after_kb", 1024, "MiB")}; ${amb("gpu_memory_after_bytes", 1048576, "MiB")}; ${amb("pss_after_kb", 1024, "MiB")}`,
  );
}
writeFileSync(
  join(out, "g7v-vp-summary.json"),
  `${JSON.stringify({ schema: "render-stream-gate7-vp-summaries/1", sweeps }, null, 2)}\n`,
);
console.log(
  `gate7-vp-summary: wrote ${join(out, "g7v-vp-summary.json")} (${sweeps.length} sweep(s))`,
);
process.exit(sweeps.length > 0 ? 0 : 1);
