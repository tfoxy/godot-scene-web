#!/usr/bin/env -S pnpm exec tsx --conditions=development
// G7xn (protocol/gate7-design.md "G7xn", D34): compares native receiver legs run under
// RS_RECEIVER_CORE=rust with the RS_RECEIVER_CORE=gdscript legs of the SAME source run (the
// replays scripts/replay-receiver-legs.sh makes, one leg directory per original leg, at the same
// relative path).
//
// Per leg pair it checks:
//   - applied.json equal except timings and `receiver`: the receiver block is dropped, the run
//     roots in every path are replaced by "<run>", and these keys are dropped wherever they occur:
//     received_us, applied_us, submitted_us, start_us, end_us, fetch_us, delay_us, closed_us,
//     process_frame, received_process_frame, submitted_process_frame (frame-clock timing) and headers (an HTTP response's Date). A failure's
//     `detail` is the two decoders' own prose: it is compared, and a difference is reported apart
//     (`detail_only`) when the reasons and every other field agree.
//   - every shot byte-identical (same file names, same sha256);
//   - every state dump statesEqual() (render-stream-2.ts), the comparison the gate checkers use
//     (the two cores print numbers differently: GDScript's JSON vs JavaScript's).
//
// `--classes` instead compares two WHOLE runs of the same gates (one per core, each its own source
// run; the live legs need their own host): for every gate directory with a result.json under both
// roots, every leg's result_class and every check's pass/fail must be equal.
//
// CLI:
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/compare-receiver-cores.ts --a <gdscript run> --b <rust run> \
//     [--classes] [--out <report.json>]
// Exit 0 when every pair matches (detail-only differences included), 1 otherwise.

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { statesEqual } from "./lib/render-stream-2";

const TIMING_KEYS = new Set([
  "received_us",
  "applied_us",
  "submitted_us",
  "start_us",
  "end_us",
  "fetch_us",
  "delay_us",
  "closed_us",
  "process_frame",
  "received_process_frame",
  "submitted_process_frame",
  "headers",
]);

interface PairReport {
  leg: string;
  applied: "equal" | "detail-only" | "differs" | "missing";
  differences: string[];
  shots: {
    total: number;
    identical: number;
    missing: string[];
    differing: string[];
  };
  states: { total: number; equal: number; differing: string[] };
  /** Excluded from `applied` as frame-clock timing, but reported: equal in every entry? */
  process_frames_equal: boolean;
  ok: boolean;
}

function walkLegs(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    if (names.includes("applied.json") && names.includes("env.txt"))
      out.push(dir);
    for (const n of names) {
      if (n === "cache" || n === "shots" || n === "state" || n === "store")
        continue;
      const p = join(dir, n);
      try {
        if (statSync(p).isDirectory()) visit(p);
      } catch {
        // vanished while walking
      }
    }
  };
  visit(root);
  return out.sort();
}

/** `roots` longest first; both runs' roots, since a replayed leg reads the source run's stores. */
function normalize(value: unknown, roots: string[]): unknown {
  if (typeof value === "string")
    return roots.reduce((s, root) => s.split(root).join("<run>"), value);
  if (Array.isArray(value)) return value.map((v) => normalize(v, roots));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (TIMING_KEYS.has(k)) continue;
      out[k] = normalize(v, roots);
    }
    return out;
  }
  return value;
}

function diff(
  a: unknown,
  b: unknown,
  path: string,
  out: string[],
  limit = 20,
): void {
  if (out.length >= limit) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) {
      out.push(`${path}: length ${a.length} vs ${b.length}`);
    }
    const keys = new Set([
      ...Object.keys(a as object),
      ...Object.keys(b as object),
    ]);
    for (const k of keys) {
      diff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
        out,
        limit,
      );
    }
    return;
  }
  out.push(
    `${path}: ${JSON.stringify(a)?.slice(0, 160)} vs ${JSON.stringify(b)?.slice(0, 160)}`,
  );
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function files(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(ext))
    .sort();
}

function comparePair(
  a: string,
  b: string,
  rootA: string,
  rootB: string,
  leg: string,
): PairReport {
  const report: PairReport = {
    leg,
    applied: "missing",
    differences: [],
    shots: { total: 0, identical: 0, missing: [], differing: [] },
    states: { total: 0, equal: 0, differing: [] },
    process_frames_equal: false,
    ok: false,
  };
  if (
    !existsSync(join(a, "applied.json")) ||
    !existsSync(join(b, "applied.json"))
  ) {
    report.differences.push("an applied.json is missing");
    return report;
  }
  const ja = JSON.parse(
    readFileSync(join(a, "applied.json"), "utf8"),
  ) as Record<string, unknown>;
  const jb = JSON.parse(
    readFileSync(join(b, "applied.json"), "utf8"),
  ) as Record<string, unknown>;
  delete ja.receiver;
  delete jb.receiver;
  const frames = (j: Record<string, unknown>) =>
    JSON.stringify(
      ["transactions", "shots"].map((k) =>
        ((j[k] as Record<string, unknown>[] | null) ?? []).map(
          (e) => e.process_frame,
        ),
      ),
    );
  report.process_frames_equal = frames(ja) === frames(jb);
  const roots = [rootA, rootB].sort((x, y) => y.length - x.length);
  const na = normalize(ja, roots) as Record<string, unknown>;
  const nb = normalize(jb, roots) as Record<string, unknown>;
  diff(na, nb, "applied", report.differences);
  if (report.differences.length === 0) {
    report.applied = "equal";
  } else {
    const fa = na.failure as Record<string, unknown> | null;
    const fb = nb.failure as Record<string, unknown> | null;
    if (fa && fb && fa.reason === fb.reason) {
      const da = { ...na, failure: { ...fa, detail: "" } };
      const db = { ...nb, failure: { ...fb, detail: "" } };
      const rest: string[] = [];
      diff(da, db, "applied", rest);
      report.applied = rest.length === 0 ? "detail-only" : "differs";
    } else {
      report.applied = "differs";
    }
  }
  for (const n of new Set([
    ...files(join(a, "shots"), ".png"),
    ...files(join(b, "shots"), ".png"),
  ])) {
    report.shots.total++;
    const pa = join(a, "shots", n);
    const pb = join(b, "shots", n);
    if (!existsSync(pa) || !existsSync(pb)) report.shots.missing.push(n);
    else if (sha256(pa) === sha256(pb)) report.shots.identical++;
    else report.shots.differing.push(n);
  }
  for (const n of new Set([
    ...files(join(a, "state"), ".json"),
    ...files(join(b, "state"), ".json"),
  ])) {
    report.states.total++;
    const pa = join(a, "state", n);
    const pb = join(b, "state", n);
    if (
      existsSync(pa) &&
      existsSync(pb) &&
      statesEqual(
        JSON.parse(readFileSync(pa, "utf8")),
        JSON.parse(readFileSync(pb, "utf8")),
      )
    )
      report.states.equal++;
    else report.states.differing.push(n);
  }
  report.ok =
    (report.applied === "equal" || report.applied === "detail-only") &&
    report.shots.identical === report.shots.total &&
    report.states.equal === report.states.total;
  return report;
}

interface ResultJson {
  gate_passed?: boolean;
  legs?: Record<string, { result_class?: string; expected_class?: string }>;
  checks?: { id: string; passed?: boolean; status?: string }[];
}

/** Every result.json under `root`, by its directory relative to `root`. */
function results(root: string): Map<string, ResultJson> {
  const out = new Map<string, ResultJson>();
  const visit = (dir: string, depth: number) => {
    if (depth > 3) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    if (names.includes("result.json") && depth > 0) {
      try {
        const r = JSON.parse(
          readFileSync(join(dir, "result.json"), "utf8"),
        ) as ResultJson;
        if (r.legs && r.checks) out.set(relative(root, dir), r);
      } catch {
        // not a gate result
      }
    }
    for (const n of names) {
      const p = join(dir, n);
      try {
        if (statSync(p).isDirectory()) visit(p, depth + 1);
      } catch {
        // vanished
      }
    }
  };
  visit(root, 0);
  return out;
}

function compareClasses(
  rootA: string,
  rootB: string,
  out: string | undefined,
): never {
  const a = results(rootA);
  const b = results(rootB);
  const gates: unknown[] = [];
  let ok = true;
  for (const [gate, rb] of b) {
    const ra = a.get(gate);
    const differences: string[] = [];
    if (!ra) {
      differences.push("no result.json in --a");
    } else {
      if (ra.gate_passed !== rb.gate_passed)
        differences.push(`gate_passed ${ra.gate_passed} vs ${rb.gate_passed}`);
      const legs = new Set([
        ...Object.keys(ra.legs ?? {}),
        ...Object.keys(rb.legs ?? {}),
      ]);
      for (const leg of [...legs].sort()) {
        const ca = ra.legs?.[leg]?.result_class;
        const cb = rb.legs?.[leg]?.result_class;
        if (ca !== cb) differences.push(`leg ${leg}: ${ca} vs ${cb}`);
      }
      const checks = new Map<
        string,
        [boolean | undefined, boolean | undefined]
      >();
      for (const c of ra.checks ?? []) checks.set(c.id, [c.passed, undefined]);
      for (const c of rb.checks ?? [])
        checks.set(c.id, [checks.get(c.id)?.[0], c.passed]);
      for (const [id, [pa, pb]] of checks)
        if (pa !== pb) differences.push(`check ${id}: ${pa} vs ${pb}`);
    }
    const legsN = Object.keys(rb.legs ?? {}).length;
    const checksN = (rb.checks ?? []).length;
    const passedN = (rb.checks ?? []).filter((c) => c.passed).length;
    console.log(
      `${differences.length === 0 ? "ok  " : "FAIL"} ${gate}: gate_passed ${ra?.gate_passed} / ${rb.gate_passed}, ${legsN} legs, checks ${passedN}/${checksN} passed`,
    );
    for (const d of differences.slice(0, 12)) console.log(`       ${d}`);
    if (differences.length > 0) ok = false;
    gates.push({
      gate,
      gate_passed_a: ra?.gate_passed,
      gate_passed_b: rb.gate_passed,
      legs: legsN,
      checks: checksN,
      checks_passed: passedN,
      differences,
    });
  }
  const summary = {
    schema: "render-stream-core-classes/1",
    a: rootA,
    b: rootB,
    ok,
    gates,
  };
  if (out) writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `compare-receiver-cores --classes: ${ok ? "every class and check equal" : "DIFFERENCES"} over ${gates.length} gates`,
  );
  process.exit(ok ? 0 : 1);
}

function main(): void {
  const args = process.argv.slice(2).filter((x) => x !== "--");
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const rootA = get("--a");
  const rootB = get("--b");
  const out = get("--out");
  if (!rootA || !rootB) {
    console.error(
      "usage: compare-receiver-cores.ts --a <gdscript run> --b <rust run> [--classes] [--out <report.json>]",
    );
    process.exit(2);
  }
  if (args.includes("--classes")) compareClasses(rootA, rootB, out);
  const reports: PairReport[] = [];
  for (const legB of walkLegs(rootB)) {
    const leg = relative(rootB, legB);
    reports.push(comparePair(join(rootA, leg), legB, rootA, rootB, leg));
  }
  const summary = {
    schema: "render-stream-core-compare/1",
    a: rootA,
    b: rootB,
    legs: reports.length,
    ok: reports.filter((r) => r.ok).length,
    applied_equal: reports.filter((r) => r.applied === "equal").length,
    applied_detail_only: reports.filter((r) => r.applied === "detail-only")
      .length,
    shots: reports.reduce((n, r) => n + r.shots.total, 0),
    shots_identical: reports.reduce((n, r) => n + r.shots.identical, 0),
    states: reports.reduce((n, r) => n + r.states.total, 0),
    states_equal: reports.reduce((n, r) => n + r.states.equal, 0),
    process_frames_equal: reports.filter((r) => r.process_frames_equal).length,
    reports,
  };
  for (const r of reports) {
    const line = `${r.ok ? "ok  " : "FAIL"} ${r.leg}: applied ${r.applied}, shots ${r.shots.identical}/${r.shots.total}, states ${r.states.equal}/${r.states.total}${r.process_frames_equal ? "" : ", process_frame differs"}`;
    console.log(line);
    if (!r.ok || r.applied === "detail-only")
      for (const d of r.differences.slice(0, 6)) console.log(`       ${d}`);
  }
  console.log(
    `compare-receiver-cores: ${summary.ok}/${summary.legs} legs match (${summary.applied_detail_only} with a failure detail only), shots ${summary.shots_identical}/${summary.shots} byte-identical, states ${summary.states_equal}/${summary.states} equal, process_frame equal in ${summary.process_frames_equal}/${summary.legs}`,
  );
  if (out) writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  process.exit(summary.ok === summary.legs ? 0 : 1);
}

main();
