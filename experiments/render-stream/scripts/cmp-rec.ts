#!/usr/bin/env -S pnpm exec tsx --conditions=development
// cmp-rec.ts -- compare two render-stream recordings record by record (PM1's byte-identity proof).
//
//   cmp-rec.ts [--allow-session <key,...>] [--json] <a> <b>
//   cmp-rec.ts --tree [--allow-session <key,...>] <dirA> <dirB>   every recording under dirA
//                                                                 (by relative path) against dirB
//
// Two recordings of the same deterministic capture differ only where the run itself differs: the
// session record's `session_id` and `stream.stream_id`, and the end record's wall-clock stats
// (`encode_ns_total`, `snapshot_ns_total`). So a recording "is byte-identical" when every
// transaction, resource and other record has the same bytes (same sha256 over the record), the
// session record differs at most in those ids and the keys named by --allow-session (dotted
// paths), and the end record at most in its timing stats. --tree compares only file sinks
// (`recording*.rsN`): a live tap or a receiver's `received*.rsN` follows the host's pacing, so its
// transaction count is a timing fact, not a wire fact. Exit 0 when identical under those rules, 1 otherwise, 2 on usage errors.
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { decodeRecording } from "./lib/render-stream-2";

type Version = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function versionOf(path: string, data: Uint8Array): Version {
  // Magic "GRS" + one hex digit (render-stream-10.md "File layout"): byte 3. File names do not
  // say: a /6 stream is written to `.rs2` by the older runners.
  const v = Number.parseInt(String.fromCharCode(data[3] ?? 0), 16);
  if (!Number.isNaN(v) && v >= 2 && v <= 11) return v as Version;
  const ext = /\.rs(\d+)$/.exec(path);
  if (ext) return Number(ext[1]) as Version;
  throw new Error(`${path}: cannot tell the version`);
}

function diffPaths(a: Json, b: Json, path: string, out: string[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffPaths((a as Record<string, Json>)[k] ?? null, (b as Record<string, Json>)[k] ?? null, path ? `${path}.${k}` : k, out);
    if (JSON.stringify(Object.keys(a)) !== JSON.stringify(Object.keys(b)) && out.length === 0) out.push(`${path}(key order)`);
    return;
  }
  out.push(path || "(root)");
}

export interface CmpResult {
  a: string;
  b: string;
  identical: boolean;
  whole_file_identical: boolean;
  records: [number, number];
  differing: { index: number; type: string; paths: string[] }[];
  allowed: { index: number; type: string; paths: string[] }[];
}

export function cmpRecordings(a: string, b: string, allowSession: string[]): CmpResult {
  const da = new Uint8Array(readFileSync(a));
  const db = new Uint8Array(readFileSync(b));
  const result: CmpResult = { a, b, identical: false, whole_file_identical: false, records: [0, 0], differing: [], allowed: [] };
  if (da.length === db.length && Buffer.from(da).equals(Buffer.from(db))) {
    result.identical = true;
    result.whole_file_identical = true;
    return result;
  }
  const ra = decodeRecording(da, versionOf(a, da)).records;
  const rb = decodeRecording(db, versionOf(b, db)).records;
  result.records = [ra.length, rb.length];
  const allowed = new Set(["session_id", "stream.stream_id", ...allowSession]);
  const n = Math.max(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const x = ra[i];
    const y = rb[i];
    if (!x || !y) {
      result.differing.push({ index: i, type: "missing", paths: [x ? "only in a" : "only in b"] });
      continue;
    }
    if (x.sha256 === y.sha256) continue;
    const type = String((x.meta as { type?: string }).type ?? "?");
    const paths: string[] = [];
    diffPaths(x.meta as Json, y.meta as Json, "", paths);
    if (JSON.stringify(x.blocks) !== JSON.stringify(y.blocks)) paths.push("blocks");
    // An allowed session difference changes the session record's length, and the end record's
    // `bytes_total` (which counts every byte) by exactly that much.
    const sessionDelta = (rb[0]?.byte_length ?? 0) - (ra[0]?.byte_length ?? 0);
    const endStats = (r: typeof x) => (r.meta as { stats?: { bytes_total?: number } }).stats ?? {};
    const tolerated =
      (type === "session" && paths.every((p) => allowed.has(p) || [...allowed].some((k) => p.startsWith(`${k}.`)))) ||
      (type === "end" &&
        paths.every(
          (p) =>
            (p.startsWith("stats.") && /sha256|digest|_ns_|_us_|_ms_/.test(p)) ||
            (p === "stats.bytes_total" &&
              (endStats(y).bytes_total ?? 0) - (endStats(x).bytes_total ?? 0) === sessionDelta),
        ));
    (tolerated ? result.allowed : result.differing).push({ index: i, type, paths: paths.length ? paths : ["(bytes only)"] });
  }
  result.identical = result.differing.length === 0;
  return result;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isSymbolicLink()) continue; // gate runners link shared sources back into the tree
    if (s.isDirectory()) out.push(...walk(p));
    else if (/^recording[^/]*\.rs\d+$/.test(name) && !p.includes("/tap/")) out.push(p);
  }
  return out.sort();
}

function main(argv: string[]): number {
  let allow: string[] = [];
  let tree = false;
  let json = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--allow-session") allow = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (argv[i] === "--tree") tree = true;
    else if (argv[i] === "--json") json = true;
    else rest.push(argv[i]);
  }
  if (rest.length !== 2) {
    console.error("usage: cmp-rec.ts [--tree] [--allow-session k,...] [--json] <a> <b>");
    return 2;
  }
  const pairs: [string, string][] = tree
    ? walk(rest[0]).map((p) => [p, join(rest[1], relative(rest[0], p))])
    : [[rest[0], rest[1]]];
  let bad = 0;
  const results: CmpResult[] = [];
  for (const [a, b] of pairs) {
    let r: CmpResult;
    try {
      statSync(b);
      r = cmpRecordings(a, b, allow);
    } catch (e) {
      r = { a, b, identical: false, whole_file_identical: false, records: [0, 0], differing: [{ index: -1, type: "error", paths: [String(e)] }], allowed: [] };
    }
    results.push(r);
    if (!r.identical) bad++;
    if (!json) {
      const tag = r.whole_file_identical ? "IDENTICAL(file)" : r.identical ? "IDENTICAL(records)" : "DIFFERENT";
      console.log(`${tag} ${tree ? relative(rest[0], a) : a}${r.records[0] ? ` records=${r.records[0]}/${r.records[1]}` : ""}`);
      for (const d of r.allowed) console.log(`  allowed #${d.index} ${d.type}: ${d.paths.join(", ")}`);
      for (const d of r.differing.slice(0, 5)) console.log(`  differs #${d.index} ${d.type}: ${d.paths.slice(0, 8).join(", ")}`);
    }
  }
  if (json) console.log(JSON.stringify(results, null, 1));
  console.log(`cmp-rec: ${pairs.length - bad}/${pairs.length} identical`);
  return bad === 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
