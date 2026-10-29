#!/usr/bin/env -S pnpm exec tsx --conditions=development
// hc1-checks.ts -- judges run-hc1.sh's legs (HC1, results/p3/hc1.md; protocol/host-cost-design.md
// D5, D6; HC2's re-record legs, results/p3/hc2.md, D1; HC3's lazy mesh surface legs, hc3.md, D2;
// HC4a's shadow oracle and sabotages, hc4a.md, D1).
// Writes <out>/result.json ({schema, checks:[{id, passed, detail}]}); exit 1 on a failure.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeRecording } from "./gate0-checks";
import { stateKey } from "./gate1-live-checks";
import { decodeRecord, splitRecords } from "./render-stream-2";

const out = process.argv[2];
if (!out) throw new Error("hc1-checks: pass the run-hc1.sh output directory");

interface Check {
  id: string;
  passed: boolean;
  detail: string;
}
const checks: Check[] = [];
const add = (id: string, problems: string[], ok: string): void => {
  checks.push({ id, passed: problems.length === 0, detail: problems.length === 0 ? ok : problems.join("; ") });
};
const json = (path: string): any => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
const lines = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "") : [];
const counters = (leg: string) => json(join(out, leg, "evidence", "counters.json"));
const perf = (leg: string) => json(join(out, leg, "evidence", "perf.json"));
const viewer = (leg: string) => json(join(out, leg, "viewer", "null-receiver.json"));
const snapshots = (leg: string): number => perf(leg)?.histograms?.snapshot_us?.count ?? -1;
const tapTransactions = (leg: string) => {
  const dir = join(out, leg, "tap");
  const file = existsSync(dir) ? readdirSync(dir).find((f) => /\.rs\d+$/.test(f)) : undefined;
  if (!file) return [];
  return summarizeRecording(join(dir, file), new Uint8Array(readFileSync(join(dir, file)))).transactions;
};
const sinkTransactions = (leg: string) => {
  const file = join(out, leg, "recording-full.rs8");
  return existsSync(file) ? summarizeRecording(file, new Uint8Array(readFileSync(file))).transactions : [];
};

// hook-log-off-formats-nothing: the counter is the number of lines the log formatted since arm.
{
  const problems: string[] = [];
  const off = counters("late-static-off")?.hook_log_lines_formatted;
  const on = counters("late-static")?.hook_log_lines_formatted;
  const fileLines = lines(join(out, "late-static", "evidence", "resources.jsonl")).length;
  if (off !== 0) problems.push(`hook log off formatted ${off} lines (want 0)`);
  if (existsSync(join(out, "late-static-off", "evidence", "resources.jsonl")))
    problems.push("hook log off still opened resources.jsonl");
  if (!(typeof on === "number" && on > 0)) problems.push(`hook log on formatted ${on} lines (want > 0)`);
  if (on !== fileLines) problems.push(`hook log on: ${on} lines formatted but resources.jsonl has ${fileLines}`);
  add("hook-log-off-formats-nothing", problems, `off: 0 lines formatted; on: ${on} formatted = ${fileLines} in resources.jsonl`);
}

// no-snapshot-without-viewer: the idle leg's listener never has a viewer; the late legs only
// snapshot from the viewer's first callback on.
{
  const problems: string[] = [];
  const idleFrames = counters("idle")?.frames_armed ?? 0;
  const idle = snapshots("idle");
  if (idle !== 0) problems.push(`idle listener took ${idle} snapshots (want 0)`);
  if (idleFrames < 60) problems.push(`idle leg armed only ${idleFrames} frames`);
  for (const leg of ["late-static", "late-static-off"]) {
    const frames = counters(leg)?.frames_armed ?? 0;
    const first = viewer(leg)?.first_tx?.frame ?? 0;
    const n = snapshots(leg);
    if (!(first > 60)) problems.push(`${leg}: the viewer's first transaction is at frame ${first} (not late)`);
    // Snapshots are taken from the viewer's first callback (frame <= first) to the end, plus slack.
    else if (n > frames - first + 3) problems.push(`${leg}: ${n} snapshots, ${frames - first + 3} allowed (${frames} frames, join at ${first})`);
  }
  add("no-snapshot-without-viewer", problems, `idle: 0 snapshots over ${idleFrames} frames; late legs snapshot only from the join`);
}

// late-join-served: the first transaction of a late viewer equals the file sink's full of the same
// state, and every payload GET it makes answers 200 with a body that hashes to its name.
function lateJoin(id: string, leg: string, sinkLeg: string, sameFrame: boolean, expectFail: boolean): void {
  const problems: string[] = [];
  const v = viewer(leg);
  const first = v?.first_tx;
  if (!first) problems.push(`${leg}: the viewer received no transaction`);
  else {
    const tap = tapTransactions(leg)[0];
    const sink = sinkTransactions(sinkLeg);
    const full = sameFrame ? sink.find((t) => t.meta.frame === first.frame) : sink[sink.length - 1];
    if (!tap) problems.push(`${leg}: no tapped transaction`);
    else if (tap.meta.seq !== first.seq) problems.push(`${leg}: tap seq ${tap.meta.seq} != viewer seq ${first.seq}`);
    if (!full) problems.push(`${sinkLeg}: no full recording at frame ${first.frame}`);
    if (tap && full && stateKey(tap) !== stateKey(full)) problems.push(`${leg}: the first transaction (frame ${first.frame}) differs from the sink's full`);
    if (first.hashes < 10) problems.push(`${leg}: only ${first.hashes} payloads to fetch`);
    const bad = Object.entries(first.statuses as Record<string, number>).filter(([k]) => k !== "200");
    if (bad.length > 0) problems.push(`${leg}: GET statuses ${JSON.stringify(first.statuses)}`);
    if (first.bad_sha > 0) problems.push(`${leg}: ${first.bad_sha} bodies do not hash to their name`);
  }
  if (expectFail) {
    add(id, problems.length > 0 ? [] : [`${leg}: the sabotage was not caught`], `caught: ${problems[0] ?? ""}`);
  } else {
    add(id, problems, `${leg}: first tx frame ${first?.frame} equals the sink's full; ${first?.hashes} GETs, statuses ${JSON.stringify(first?.statuses)}`);
  }
}
lateJoin("late-join-served-static", "late-static", "ref-static", false, false);
lateJoin("late-join-served-churn", "late-churn", "late-churn", true, false);
lateJoin("late-join-served-hook-log-off", "late-static-off", "ref-static", false, false);
lateJoin("sabotage-pin-late-caught", "sabotage-pin-late", "ref-static", false, true);

// The hook-log-on legs' serve events: nothing is pinned before the viewer's first callback.
{
  const problems: string[] = [];
  const first = viewer("late-static")?.first_tx?.frame ?? 0;
  const pins = lines(join(out, "late-static", "evidence", "resources.jsonl"))
    .map((l) => JSON.parse(l))
    .filter((l) => l.op === "pin");
  if (pins.length === 0) problems.push("no pin events at all");
  const early = pins.filter((p) => p.frame < first - 1);
  if (early.length > 0) problems.push(`${early.length} pins before the join (frame ${first}), first at ${early[0].frame}`);
  add("no-pin-without-viewer", problems, `${pins.length} pins, all from the join (frame ${first}) on`);
}

// HC2 (host-cost-design.md D1): the /11 re-record legs. Each patch transaction's items, with
// whether they carry commands and their content_version against the last one published.
interface RrTx {
  frame: number;
  full: boolean;
  items: number;
  withCommands: number;
  cvMoved: number;
}
function rrTrace(leg: string): RrTx[] | null {
  const file = join(out, leg, "recording-patch.rs11");
  if (!existsSync(file)) return null;
  const split = splitRecords(new Uint8Array(readFileSync(file)), 11);
  const cv = new Map<number, number>();
  const txs: RrTx[] = [];
  for (let i = 1; i < split.records.length; i++) {
    const meta = decodeRecord(split.records[i], 11).record?.meta as any;
    if (!meta || meta.type !== "transaction") continue;
    const full = meta.encoding === "full";
    if (full) cv.clear();
    let withCommands = 0;
    let cvMoved = 0;
    for (const item of meta.items ?? []) {
      if (item.commands !== null) withCommands++;
      if (cv.has(item.id) && cv.get(item.id) !== item.content_version) cvMoved++;
      cv.set(item.id, item.content_version);
    }
    for (const id of meta.removed_items ?? []) cv.delete(id);
    txs.push({ frame: meta.frame, full, items: (meta.items ?? []).length, withCommands, cvMoved });
  }
  return txs;
}
const rrSkipped = (leg: string): boolean => existsSync(join(out, leg, "skipped-by-tier.txt"));
// result.json stream.gate8.content_version (entry.cpp, /11 file streams).
const cvCounters = (leg: string) =>
  json(join(out, leg, "evidence", "result.json"))?.stream?.gate8?.content_version as
    | { digests: number; rerecords_kept: number }
    | undefined;
const scaleReport = (leg: string) => json(join(out, leg, "scale-report.json"));
// Patches after the first two (the fixture's setup lands in the first full and its follow-up).
const steady = (txs: RrTx[]): RrTx[] => txs.filter((t) => !t.full).slice(2);

// cv-stable-on-rerecord: 40 identical re-records a frame never move content_version and never
// enter a patch; the mirror digests each item once (its first publication) and keeps the rest.
function cvStable(leg: string): string[] {
  const problems: string[] = [];
  const txs = rrTrace(leg);
  const c = cvCounters(leg);
  if (!txs) return [`${leg}: no recording-patch.rs11`];
  const first = txs.find((t) => t.full);
  const patches = steady(txs);
  if (!first) problems.push(`${leg}: no full transaction`);
  if (patches.length < 100) problems.push(`${leg}: only ${patches.length} steady patches`);
  const patched = patches.reduce((n, t) => n + t.items, 0);
  const moved = patches.reduce((n, t) => n + t.cvMoved, 0);
  if (patched !== 0) problems.push(`${leg}: ${patched} items patched over ${patches.length} patches (want 0), ${moved} content_version moves`);
  if (!c) problems.push(`${leg}: result.json has no stream.gate8.content_version`);
  else if (first) {
    if (c.digests !== first.items) problems.push(`${leg}: ${c.digests} digests, want one per item (${first.items})`);
    if (c.rerecords_kept < 40 * patches.length) problems.push(`${leg}: ${c.rerecords_kept} re-records kept, want >= ${40 * patches.length}`);
  }
  return problems;
}
// rerecord-unequal-patched: of the 40, the 8 a frame recorded one float different are patched with
// their list under a moved content_version, and each costs exactly one digest.
function rerecordUnequal(leg: string): string[] {
  const problems: string[] = [];
  const txs = rrTrace(leg);
  const c = cvCounters(leg);
  const varied = scaleReport(leg)?.redraws_varied;
  if (!txs) return [`${leg}: no recording-patch.rs11`];
  const first = txs.find((t) => t.full);
  const patches = steady(txs);
  if (patches.length < 100) problems.push(`${leg}: only ${patches.length} steady patches`);
  const bad = patches.filter((t) => t.items !== 8 || t.withCommands !== 8 || t.cvMoved !== 8);
  if (bad.length > 0)
    problems.push(`${leg}: ${bad.length} patches without exactly 8 re-recorded items carrying lists under new versions (first: frame ${bad[0].frame}, ${bad[0].items} items, ${bad[0].withCommands} with commands, ${bad[0].cvMoved} moved)`);
  if (!c || !first || typeof varied !== "number") problems.push(`${leg}: counters or scale report missing`);
  else {
    const extra = c.digests - first.items;
    if (extra > varied || extra < varied - 8) problems.push(`${leg}: ${extra} digests after setup for ${varied} varied re-records`);
    if (c.rerecords_kept < 32 * patches.length) problems.push(`${leg}: ${c.rerecords_kept} re-records kept, want >= ${32 * patches.length}`);
  }
  return problems;
}
add("cv-stable-on-rerecord", cvStable("rr-same"), "rr-same: 0 items in every steady patch; one digest per item; every identical re-record kept");
add("rerecord-unequal-patched", rerecordUnequal("rr-vary"), "rr-vary: 8 items a patch, each with its new list under a new content_version; one digest per varied re-record");
for (const [id, leg, fn] of [
  ["sabotage-rerecord-stale-caught", "sabotage-rr-stale", rerecordUnequal],
  ["sabotage-cv-churn-caught", "sabotage-rr-cv-churn", cvStable],
] as const) {
  if (rrSkipped(leg)) continue;
  const caught = fn(leg);
  add(id, caught.length > 0 ? [] : [`${leg}: the sabotage was not caught`], `caught: ${caught[0] ?? ""}`);
}

// HC3 (host-cost-design.md D2): lazy mesh surfaces. counters.json mesh_hashes (hooks.cpp) and
// result.json stream.gate8.mesh_dynamic (entry.cpp, /11 streams).
const meshHashes = (leg: string) =>
  counters(leg)?.mesh_hashes as
    | { mirror_surfaces: number; mirror_dynamic_surfaces: number; hook_region_rehashes: number; mirror_payload_copies: number }
    | undefined;
const meshDynamic = (leg: string) =>
  json(join(out, leg, "evidence", "result.json"))?.stream?.gate8?.mesh_dynamic as
    | { meshes_dynamic: number; promotions: number; content_changes: number }
    | undefined;
// dyn-hash-log-off: a /11 host with its hook log off never hashes a dynamic surface (nothing reads
// the hash), while its meshes are dynamic and change; the hook-log-on twin hashes them.
{
  const problems: string[] = [];
  const off = meshHashes("dyn-off");
  const on = meshHashes("dyn-on");
  const dOff = meshDynamic("dyn-off");
  if (!off || !on) problems.push("counters.json has no mesh_hashes");
  if (!dOff) problems.push("dyn-off: result.json has no stream.gate8.mesh_dynamic");
  else if (!(dOff.promotions > 0 && dOff.content_changes > 100))
    problems.push(`dyn-off: ${dOff.promotions} promotions, ${dOff.content_changes} content changes (want dynamic, changing meshes)`);
  if (off && off.mirror_dynamic_surfaces !== 0) problems.push(`dyn-off: ${off.mirror_dynamic_surfaces} dynamic-surface hashes (want 0)`);
  if (off && off.hook_region_rehashes !== 0) problems.push(`dyn-off: ${off.hook_region_rehashes} hook region re-hashes (want 0)`);
  if (off && !(off.mirror_payload_copies > 0)) problems.push("dyn-off: no copy-on-write payload copy (region writes never reached the mirror)");
  if (on && !(on.mirror_dynamic_surfaces > 0 && on.hook_region_rehashes > 0))
    problems.push(`dyn-on: ${on.mirror_dynamic_surfaces} dynamic-surface hashes, ${on.hook_region_rehashes} hook re-hashes (want > 0: the counter is live)`);
  add("dyn-hash-log-off", problems, `dyn-off: 0 dynamic-surface hashes, 0 hook re-hashes, ${off?.mirror_payload_copies} COW copies over ${dOff?.content_changes} content changes; dyn-on: ${on?.mirror_dynamic_surfaces} dynamic-surface hashes, ${on?.hook_region_rehashes} hook re-hashes`);
}
// dyn-wire-log-independent: the hook log does not move the /11 wire (cmp-rec --tree, run-hc1.sh).
{
  const problems: string[] = [];
  const rc = existsSync(join(out, "dyn-cmp.exit")) ? readFileSync(join(out, "dyn-cmp.exit"), "utf8").trim() : "missing";
  const text = existsSync(join(out, "dyn-cmp.txt")) ? readFileSync(join(out, "dyn-cmp.txt"), "utf8") : "";
  const identical = text.split("\n").filter((l) => l.startsWith("IDENTICAL")).length;
  if (rc !== "0") problems.push(`cmp-rec --tree dyn-off dyn-on exited ${rc}: ${text.split("\n").slice(0, 4).join(" | ")}`);
  if (identical < 2) problems.push(`only ${identical} recordings compared identical (want full and patch)`);
  add("dyn-wire-log-independent", problems, `${identical} /11 recordings identical with the hook log off and on`);
}
// late-join-v8-on-v11: a /8 viewer on a /11 host (hook log off) is a hash reader. Every mesh
// surface of every transaction it was sent names a real SHA-256, and its first-transaction GETs
// all answer 200 with bodies that hash to their names.
function lateDynV8(leg: string): string[] {
  const problems: string[] = [];
  const first = viewer(leg)?.first_tx;
  const h = meshHashes(leg);
  if (!first) return [`${leg}: the viewer received no transaction`];
  if (!(first.frame > 60)) problems.push(`${leg}: the viewer joined at frame ${first.frame} (not late)`);
  if (first.hashes < 10) problems.push(`${leg}: only ${first.hashes} payloads to fetch`);
  const bad = Object.entries(first.statuses as Record<string, number>).filter(([k]) => k !== "200");
  if (bad.length > 0) problems.push(`${leg}: GET statuses ${JSON.stringify(first.statuses)}`);
  if (first.bad_sha > 0) problems.push(`${leg}: ${first.bad_sha} bodies do not hash to their name`);
  let surfaces = 0;
  let notSha = 0;
  for (const t of tapTransactions(leg)) {
    for (const m of (t.meta as any).meshes ?? []) {
      for (const s of m.surfaces ?? []) {
        surfaces++;
        if (typeof s.hash !== "string" || !/^[0-9a-f]{64}$/.test(s.hash)) notSha++;
      }
    }
  }
  if (surfaces < 10) problems.push(`${leg}: only ${surfaces} mesh surfaces in the viewer's transactions`);
  if (notSha > 0) problems.push(`${leg}: ${notSha} of ${surfaces} mesh surface hashes are not SHA-256s`);
  if (!h || !(h.mirror_dynamic_surfaces > 0)) problems.push(`${leg}: ${h?.mirror_dynamic_surfaces} dynamic-surface hashes (the /8 viewer reads them)`);
  return problems;
}
{
  const problems = lateDynV8("late-dyn-v8");
  const first = viewer("late-dyn-v8")?.first_tx;
  add("late-join-v8-on-v11", problems, `late-dyn-v8: joined at frame ${first?.frame}; every mesh surface hash a SHA-256; ${first?.hashes} GETs, statuses ${JSON.stringify(first?.statuses)}; ${meshHashes("late-dyn-v8")?.mirror_dynamic_surfaces} dynamic-surface hashes`);
}
if (!rrSkipped("sabotage-dyn-hash-unread")) {
  const caught = lateDynV8("sabotage-dyn-hash-unread");
  add("sabotage-dyn-hash-unread-caught", caught.length > 0 ? [] : ["sabotage-dyn-hash-unread: the sabotage was not caught"], `caught: ${caught[0] ?? ""}`);
}

// HC4a (results/p3/hc4a.md): the shadow oracle agrees with the persistent tables on honest legs,
// and the two sabotages are caught by the oracle and by the gates' own checks.
const shadowOf = (dir: string) => json(join(dir, "evidence", "counters.json"))?.hc_shadow;
{
  const problems: string[] = [];
  const seen: string[] = [];
  for (const leg of ["rr-vary", "dyn-off"]) {
    const s = shadowOf(join(out, leg));
    if (!s?.enabled) problems.push(`${leg}: the shadow oracle was off (${JSON.stringify(s)})`);
    else if (!(s.checked >= 100)) problems.push(`${leg}: only ${s.checked} snapshots compared`);
    else if (s.mismatches !== 0) problems.push(`${leg}: ${s.mismatches} mismatches, first ${s.first}`);
    seen.push(`${leg} ${s?.checked} snapshots`);
  }
  add("shadow-oracle-agrees", problems, `every snapshot equals the full walk: ${seen.join(", ")}`);
}
/** Every {id, passed} object of a nested gate run's result.json, by id. */
function gateChecks(dir: string): Map<string, { passed: boolean; detail: string }> {
  const found = new Map<string, { passed: boolean; detail: string }>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      if (typeof r.id === "string" && typeof r.passed === "boolean")
        found.set(r.id, { passed: r.passed, detail: String(r.detail ?? "") });
      Object.values(r).forEach(walk);
    }
  };
  walk(json(join(dir, "gate", "result.json")));
  return found;
}
/** The named checks of a nested gate run, when every one of them failed (saying `mention` if set). */
function gateCaught(leg: string, want: Array<[string, string]>): string[] {
  const got = gateChecks(join(out, leg));
  const caught: string[] = [];
  for (const [id, mention] of want) {
    const c = got.get(id);
    if (c && !c.passed && (mention === "" || c.detail.includes(mention))) caught.push(`${id}: ${c.detail.slice(0, 160)}`);
  }
  return caught.length === want.length ? caught : [];
}
if (!rrSkipped("sabotage-hc-skip-dirty-oracle")) {
  const s = shadowOf(join(out, "sabotage-hc-skip-dirty-oracle"));
  const dropped = counters("sabotage-hc-skip-dirty-oracle")?.hc_tables?.dirty_marks_dropped ?? 0;
  const ended = lines(join(out, "sabotage-hc-skip-dirty-oracle", "stdout.log")).some((l) =>
    l.includes("stream: hc-shadow-mismatch"));
  const ok = dropped > 0 && s?.mismatches > 0 && ended;
  add("sabotage-hc-skip-dirty-oracle-caught", ok ? [] : [`not caught: ${dropped} marks dropped, shadow ${JSON.stringify(s)}, stream ended: ${ended}`],
    `caught: ${dropped} marks dropped; the stream ended at ${s?.first}`);
}
if (!rrSkipped("sabotage-hc-skip-dirty-gate1")) {
  const caught = gateCaught("sabotage-hc-skip-dirty-gate1", [["receiver-vs-reference", ""], ["expected-image-receiver", ""]]);
  add("sabotage-hc-skip-dirty-gate1-caught", caught.length > 0 ? [] : ["gate 1's receiver pixel checks did not fail"], `caught: ${caught.join(" | ")}`);
}
if (!rrSkipped("sabotage-hc-stale-derived-oracle")) {
  const s = shadowOf(join(out, "sabotage-hc-stale-derived-oracle", "gate", "capture-unsupported"));
  const ok = s?.mismatches > 0 && typeof s.first === "string" && s.first.startsWith("unsupported id ");
  add("sabotage-hc-stale-derived-oracle-caught", ok ? [] : [`not caught: capture-unsupported shadow ${JSON.stringify(s)}`],
    `caught: capture-unsupported ended at ${s?.first}`);
}
if (!rrSkipped("sabotage-hc-stale-derived-gate2")) {
  const caught = gateCaught("sabotage-hc-stale-derived-gate2", [["recordings-decode-2", "unsupported-mismatch"], ["leg-class-unsupported-textures", "unsupported-texture"]]);
  add("sabotage-hc-stale-derived-gate2-caught", caught.length > 0 ? [] : ["gate 2's unsupported checks did not fail"], `caught: ${caught.join(" | ")}`);
}

writeFileSync(join(out, "result.json"), `${JSON.stringify({ schema: "render-stream-hc1-result/1", checks }, null, 2)}\n`);
for (const c of checks) console.log(`hc1: ${c.passed ? "pass" : "FAIL"} ${c.id}: ${c.detail}`);
process.exit(checks.every((c) => c.passed) ? 0 : 1);
