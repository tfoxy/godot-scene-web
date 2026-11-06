// Gate 8 g8tdr checks (TDR, protocol/live-swap-design.md Q5 "served at rest", capture/src/
// rs_payload_rest.h): GRT1 texture bodies are zstd-coded where they are built, and the mirror and
// the live served set hold only the coded body. run-gate8.sh run_g8tdr writes, under g8tdr/:
//
//   sync/capture, sync-off/capture             gate8-tex at /9, GRC_TEXTURE_DECODE=engine, the stock
//                                              delivery, coded on the hook thread; the twin sets
//                                              GRC_HTTP_ENCODING=off (nothing coded at rest)
//   live/{host,viewer}                         a /11 live host, two texture workers, hook log on,
//                                              lib/null-receiver.ts as the viewer, and three curl
//                                              GETs of the largest pinned texture
//                                              (host/get-{zstd,identity,lan}.{headers,body}, get.hash)
//   sabotage-at-rest-keep-identity/host        the live host with GRC_AT_REST_FAULT=keep-identity
//
// Checks: at-rest-legs, served-at-rest, at-rest-get, at-rest-wire-identical and
// sabotage-at-rest-keep-identity (served-at-rest's own predicate must fail on the fault leg).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  check,
  exitCode,
  type G8aCheck,
  jsonl,
  readJson,
  readText,
  skipped,
} from "./gate8-adopt-checks";
import { cmpRec } from "./gate8-htr-checks";

interface Census {
  bodies: number;
  coded: number;
  not_smaller: number;
  untried: number;
  identity_bytes_held: number;
  held_bytes: number;
  identity_bytes: number;
  capacity_slack_bytes: number;
}

interface InflateSite {
  count: number;
  coded_bytes: number;
  identity_bytes: number;
  ns: number;
}

/** evidence/at-rest.json (capture/src/entry.cpp emit_at_rest). */
export interface AtRest {
  coding: string;
  fault: string;
  texture_workers: string;
  worker_min_bytes: number;
  coded: number;
  not_smaller: number;
  in_bytes: number;
  out_bytes: number;
  code_ns: number;
  code_main_thread: number;
  inflate: Record<
    "get" | "store" | "inline" | "basis" | "sabotage",
    InflateSite
  >;
  inflate_failed: number;
  mirror: Census;
  served: Census | null;
  both: Census | null;
  served_retained_bytes: number | null;
}

/** evidence/live-summary.json's `resources` (capture/src/rs_live.cpp summary_json). */
export interface ServingResources {
  http_gets: number;
  http_bytes: number;
  http_coded_bytes: number;
  http_encoding: string;
  at_rest: string;
  identity_inflates: number;
  identity_inflate_bytes: number;
  identity_inflate_ns: number;
  retained_bytes_end: number;
}

interface HookLine {
  op: string;
  hash?: string | null;
  http_status?: number | null;
  payload_bytes?: number | null;
  coding?: string;
  coded_bytes?: number;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function censusText(c: Census | null | undefined): string {
  return c
    ? `${c.coded}/${c.bodies} coded, held ${c.held_bytes} of ${c.identity_bytes} identity (identity held ${c.identity_bytes_held}, untried ${c.untried}, slack ${c.capacity_slack_bytes})`
    : "none";
}

/**
 * served-at-rest's predicate: the problems an honest live host's evidence has (none) or the
 * keep-identity fault leg's evidence has (several). Shared by the check and its sabotage.
 */
export function servedAtRestProblems(
  a: AtRest | undefined,
  summary: { resources?: ServingResources } | undefined,
): string[] {
  if (!a) return ["no evidence/at-rest.json"];
  const problems: string[] = [];
  const r = summary?.resources;
  if (a.coding !== "zstd") problems.push(`coding ${a.coding}, want zstd`);
  if (!(a.coded > 0)) problems.push(`coded ${a.coded}, want > 0`);
  if (a.inflate_failed !== 0)
    problems.push(`inflate_failed ${a.inflate_failed}`);
  if (a.code_main_thread !== 0)
    problems.push(`code_main_thread ${a.code_main_thread}, want 0`);
  if (!(a.mirror.coded > 0)) problems.push(`mirror.coded ${a.mirror.coded}`);
  if (a.mirror.identity_bytes_held !== 0)
    problems.push(`mirror.identity_bytes_held ${a.mirror.identity_bytes_held}`);
  if (a.mirror.untried !== 0)
    problems.push(`mirror.untried ${a.mirror.untried}`);
  // A body whose vector keeps more capacity than its size holds memory its held_bytes hides (the
  // coder's ZSTD_compressBound buffer kept the identity's footprint until TDR copied it exactly).
  if (a.mirror.capacity_slack_bytes !== 0)
    problems.push(`mirror.capacity_slack_bytes ${a.mirror.capacity_slack_bytes}, want 0`);
  const s = a.served;
  if (!s) {
    problems.push("no served census (not a live host)");
  } else {
    if (!(s.coded > 0)) problems.push(`served.coded ${s.coded}`);
    if (s.identity_bytes_held !== 0)
      problems.push(`served.identity_bytes_held ${s.identity_bytes_held}`);
    if (s.untried !== 0) problems.push(`served.untried ${s.untried}`);
    if (s.capacity_slack_bytes !== 0)
      problems.push(`served.capacity_slack_bytes ${s.capacity_slack_bytes}, want 0`);
    if (!(s.held_bytes < s.identity_bytes))
      problems.push(
        `served.held_bytes ${s.held_bytes} not below identity ${s.identity_bytes}`,
      );
    if (a.served_retained_bytes !== s.held_bytes)
      problems.push(
        `served_retained_bytes ${a.served_retained_bytes} != served.held_bytes ${s.held_bytes}`,
      );
  }
  if (a.both && a.both.identity_bytes_held !== 0)
    problems.push(`both.identity_bytes_held ${a.both.identity_bytes_held}`);
  if (!r) {
    problems.push("no live-summary resources");
  } else {
    if (r.at_rest !== "zstd") problems.push(`summary at_rest ${r.at_rest}`);
    if (r.retained_bytes_end !== a.served_retained_bytes)
      problems.push(
        `summary retained_bytes_end ${r.retained_bytes_end} != served_retained_bytes ${a.served_retained_bytes}`,
      );
  }
  return problems;
}

interface Http {
  status: number;
  headers: Map<string, string>;
}

function parseHeaders(text: string | undefined): Http | null {
  if (!text) return null;
  // curl -D writes one block per response (a 100-continue or redirect would add more): the last.
  const blocks = text
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b !== "");
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  const lines = last.split(/\r?\n/);
  const m = /^HTTP\/\S+\s+(\d+)/.exec(lines[0]);
  if (!m) return null;
  const headers = new Map<string, string>();
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0)
      headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
  }
  return { status: Number(m[1]), headers };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

export interface G8tdrReport {
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  at_rest: Record<string, AtRest | null>;
  get: {
    hash: string | null;
    identity_bytes: number | null;
    zstd_bytes: number | null;
    identity_inflates: number | null;
  } | null;
  store_files: number | null;
}

export async function runG8tdr(
  out: string,
): Promise<{ checks: G8aCheck[]; report: G8tdrReport }> {
  const g = join(out, "g8tdr");
  const checks: G8aCheck[] = [];
  const legDirs = [
    "sync/capture",
    "sync-off/capture",
    "live/host",
    "sabotage-at-rest-keep-identity/host",
  ];
  const report: G8tdrReport = {
    legs: {},
    at_rest: {},
    get: null,
    store_files: null,
  };
  for (const l of legDirs)
    report.legs[l] = {
      exit_code: await exitCode(join(g, l)),
      skipped: skipped(join(g, l)),
    };
  const ran = (l: string) =>
    report.legs[l] !== undefined &&
    report.legs[l].exit_code !== null &&
    report.legs[l].skipped === null;
  const atRest = async (leg: string) => {
    const a =
      (await readJson<AtRest>(join(g, leg, "evidence", "at-rest.json"))) ??
      null;
    report.at_rest[leg] = a;
    return a ?? undefined;
  };
  const summary = (leg: string) =>
    readJson<{ resources?: ServingResources }>(
      join(g, leg, "evidence", "live-summary.json"),
    );

  // --- at-rest-legs ----------------------------------------------------------------------
  {
    const problems: string[] = [];
    for (const l of legDirs)
      if (ran(l) && report.legs[l].exit_code !== "0")
        problems.push(`${l} exit ${report.legs[l].exit_code}`);
    let viewerNote = "";
    if (ran("live/host")) {
      const code = (
        await readText(join(g, "live", "viewer", "exit.txt"))
      )?.trim();
      const nr = await readJson<{
        transactions: number;
        end: boolean;
      }>(join(g, "live", "viewer", "null-receiver.json"));
      if (code !== "0") problems.push(`live viewer exit ${code}`);
      if (!nr?.end) problems.push("live viewer saw no end record");
      if (!nr || !(nr.transactions > 0))
        problems.push("live viewer got no transactions");
      viewerNote = `, viewer ${nr?.transactions} transactions`;
      const res = (await summary("live/host"))?.resources;
      if (res && res.http_encoding !== "zstd")
        problems.push(`live http_encoding ${res.http_encoding}`);
    }
    checks.push(
      check(
        "at-rest-legs",
        "every g8tdr leg that ran exits 0, and the live host's null-receiver viewer saw the stream to its end",
        problems,
        `${legDirs.filter(ran).length} legs${viewerNote}`,
      ),
    );
  }

  // --- served-at-rest --------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    if (ran("live/host")) {
      const a = await atRest("live/host");
      const s = await summary("live/host");
      problems = servedAtRestProblems(a, s);
      if (a?.fault !== "") problems.push(`fault ${a?.fault}`);
      if (a?.texture_workers !== "2")
        problems.push(`texture_workers ${a?.texture_workers}, want 2`);
      if (a)
        detail = `coding ${a.coding}: ${a.coded} coded (${a.not_smaller} not smaller), ${a.in_bytes} -> ${a.out_bytes} bytes, ${a.code_main_thread} on the main thread; mirror ${censusText(a.mirror)}; served ${censusText(a.served)}; retained ${a.served_retained_bytes} (summary ${s?.resources?.retained_bytes_end}); both identity held ${a.both?.identity_bytes_held}; inflate_failed ${a.inflate_failed}`;
    }
    checks.push(
      check(
        "served-at-rest",
        "the live host (two texture workers) codes every GRT1 body with zstd off the main thread, and neither the mirror nor the served set holds an identity body or an untried one; the served set's retained bytes are its coded bytes (below the identity bytes) and the live summary reports the same retained bytes",
        problems,
        detail,
      ),
    );
  }

  // --- at-rest-get -----------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    if (ran("live/host")) {
      problems = [];
      const host = join(g, "live", "host");
      const hash = (await readText(join(host, "get.hash")))?.trim() ?? "";
      if (hash === "") {
        problems.push(
          `no get.hash (${(await readText(join(host, "get.error")))?.trim() ?? "the probe never ran"})`,
        );
      } else {
        const hooks = jsonl<HookLine>(
          await readText(join(host, "evidence", "resources.jsonl")),
        );
        const identityBytes =
          hooks.find((h) => h.op === "pin" && h.hash === hash)?.payload_bytes ??
          null;
        const parts: Record<
          "zstd" | "identity" | "lan",
          { http: Http | null; body: Uint8Array | null }
        > = { zstd: null, identity: null, lan: null } as never;
        for (const k of ["zstd", "identity", "lan"] as const) {
          const hp = join(host, `get-${k}.headers`);
          const bp = join(host, `get-${k}.body`);
          parts[k] = {
            http: parseHeaders(await readText(hp)),
            body: existsSync(bp) ? new Uint8Array(readFileSync(bp)) : null,
          };
          const p = parts[k];
          if (!p.http || !p.body) {
            problems.push(`get-${k}: no response`);
            continue;
          }
          if (p.http.status !== 200)
            problems.push(`get-${k}: status ${p.http.status}`);
          const len = p.http.headers.get("content-length");
          if (len === undefined || Number(len) !== p.body.length)
            problems.push(
              `get-${k}: Content-Length ${len} != body ${p.body.length}`,
            );
        }
        const z = parts.zstd;
        let zstdBytes: number | null = null;
        if (z.http && z.body) {
          zstdBytes = z.body.length;
          const enc = z.http.headers.get("content-encoding");
          if (enc !== "zstd")
            problems.push(`get-zstd: Content-Encoding ${enc}`);
          if (identityBytes !== null && !(z.body.length < identityBytes))
            problems.push(
              `get-zstd: body ${z.body.length} not below identity ${identityBytes}`,
            );
          try {
            const plain = zstdDecompressSync(z.body);
            if (sha256(plain) !== hash)
              problems.push(
                "get-zstd: the inflated body does not hash to its name",
              );
            if (identityBytes !== null && plain.length !== identityBytes)
              problems.push(
                `get-zstd: inflated ${plain.length} != payload_bytes ${identityBytes}`,
              );
          } catch (e) {
            problems.push(`get-zstd: zstd decompress failed: ${String(e)}`);
          }
        }
        for (const k of ["identity", "lan"] as const) {
          const p = parts[k];
          if (!p.http || !p.body) continue;
          const enc = p.http.headers.get("content-encoding");
          if (enc !== undefined)
            problems.push(`get-${k}: Content-Encoding ${enc}, want none`);
          if (sha256(p.body) !== hash)
            problems.push(`get-${k}: the body does not hash to its name`);
          if (identityBytes !== null && p.body.length !== identityBytes)
            problems.push(
              `get-${k}: body ${p.body.length} != payload_bytes ${identityBytes}`,
            );
        }
        const res = (await summary("live/host"))?.resources;
        if (!res || !(res.identity_inflates >= 2))
          problems.push(
            `summary identity_inflates ${res?.identity_inflates}, want >= 2`,
          );
        const gets = hooks.filter(
          (h) =>
            h.op === "http-get" && h.hash === hash && h.http_status === 200,
        );
        const byCoding = (c: string) => gets.filter((h) => h.coding === c);
        const idLines = byCoding("identity");
        const zLines = byCoding("zstd");
        if (idLines.length < 2)
          problems.push(`${idLines.length} identity http-get lines, want >= 2`);
        else if (
          !idLines.every(
            (h) =>
              h.coded_bytes === identityBytes &&
              h.payload_bytes === identityBytes,
          )
        )
          problems.push(
            "an identity http-get line's coded_bytes != identity size",
          );
        if (zLines.length < 1) problems.push("no zstd http-get line");
        else if (
          zstdBytes !== null &&
          !zLines.some((h) => h.coded_bytes === zstdBytes)
        )
          problems.push(
            `no zstd http-get line with coded_bytes ${zstdBytes} (${zLines.map((h) => h.coded_bytes).join(",")})`,
          );
        report.get = {
          hash,
          identity_bytes: identityBytes,
          zstd_bytes: zstdBytes,
          identity_inflates: res?.identity_inflates ?? null,
        };
        detail = `${hash.slice(0, 12)}: identity ${identityBytes} bytes, zstd body ${zstdBytes} bytes (Content-Encoding ${z.http?.headers.get("content-encoding")}); identity and LAN (gzip, deflate) bodies hash to the name with no Content-Encoding; summary identity_inflates ${res?.identity_inflates} (${res?.identity_inflate_bytes} bytes); http-get lines ${idLines.length} identity, ${zLines.length} zstd`;
      }
    }
    checks.push(
      check(
        "at-rest-get",
        "a GET taking zstd gets the stored coded bytes (Content-Encoding: zstd, Content-Length equal, smaller than the identity size, inflating to the hash); a GET with no Accept-Encoding and the LAN browser's `gzip, deflate` get the identity body (no Content-Encoding, hashing to the name), each counted as an identity inflate and logged with its coding and coded bytes",
        problems,
        detail,
      ),
    );
  }

  // --- at-rest-wire-identical ------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    if (ran("sync/capture") && ran("sync-off/capture")) {
      problems = [];
      const a = join(g, "sync", "capture");
      const b = join(g, "sync-off", "capture");
      const same = (rel: string) => {
        const pa = join(a, rel);
        const pb = join(b, rel);
        if (!existsSync(pa) || !existsSync(pb)) return `${rel} missing`;
        if (!readFileSync(pa).equals(readFileSync(pb))) return `${rel} differs`;
        return null;
      };
      // cmp-rec.ts: record for record identical but the session and stream ids and the end
      // record's encode timings, which differ between any two runs (it prints what it allowed)
      const recs: string[] = [];
      for (const rel of ["recording.rs9", "recording-patch.rs9"]) {
        const c = cmpRec(join(a, rel), join(b, rel));
        if (!c.identical) problems.push(`${rel} differs (${c.detail})`);
        recs.push(rel);
      }
      const fa = listFiles(join(a, "store"));
      const fb = listFiles(join(b, "store"));
      report.store_files = fa.length;
      if (fa.length === 0) problems.push("sync's store is empty");
      if (fa.join("\n") !== fb.join("\n"))
        problems.push(
          `store file sets differ (${fa.length} vs ${fb.length}: ${fa.filter((f) => !fb.includes(f)).slice(0, 2)} / ${fb.filter((f) => !fa.includes(f)).slice(0, 2)})`,
        );
      else {
        let bytes = 0;
        for (const f of fa) {
          const d = same(join("store", f));
          if (d) problems.push(d);
          bytes += statSync(join(a, "store", f)).size;
        }
        detail = `${recs.length} recordings (record for record) and ${fa.length} store files (${bytes} bytes, index.jsonl included) byte-identical`;
      }
      const sa = await atRest("sync/capture");
      const sb = await atRest("sync-off/capture");
      if (!sa || !sb) {
        problems.push("no at-rest.json");
      } else {
        if (sa.coding !== "zstd") problems.push(`sync coding ${sa.coding}`);
        if (!(sa.coded > 0)) problems.push(`sync coded ${sa.coded}`);
        if (sa.mirror.identity_bytes_held !== 0)
          problems.push(
            `sync mirror.identity_bytes_held ${sa.mirror.identity_bytes_held}`,
          );
        if (sa.mirror.untried !== 0)
          problems.push(`sync mirror.untried ${sa.mirror.untried}`);
        if (!(sa.code_main_thread > 0))
          problems.push(
            `sync code_main_thread ${sa.code_main_thread}, want > 0`,
          );
        if (!(sa.inflate.store.count > 0))
          problems.push(
            `sync inflate.store.count ${sa.inflate.store.count}, want > 0`,
          );
        if (sa.inflate_failed !== 0)
          problems.push(`sync inflate_failed ${sa.inflate_failed}`);
        if (sb.coding !== "identity")
          problems.push(`sync-off coding ${sb.coding}, want identity`);
        if (sb.coded !== 0) problems.push(`sync-off coded ${sb.coded}`);
        detail += `; sync: ${sa.coded} coded on the hook thread (${sa.code_main_thread} calls), mirror ${censusText(sa.mirror)}, ${sa.inflate.store.count} store inflates (${sa.inflate.store.coded_bytes} -> ${sa.inflate.store.identity_bytes} bytes); sync-off: coding ${sb.coding}, ${sb.coded} coded, mirror holds ${sb.mirror.identity_bytes_held} identity bytes`;
      }
    }
    checks.push(
      check(
        "at-rest-wire-identical",
        "coding at rest is invisible on the wire and on disk: the /9 recordings (full and patch, record for record, bar the per-run session ids and timings) and the resource store (every file, index.jsonl included, byte for byte) are identical between the default (zstd at rest, coded on the hook thread, inflated for the store) and GRC_HTTP_ENCODING=off (nothing coded)",
        problems,
        detail,
      ),
    );
  }

  // --- sabotage-at-rest-keep-identity ----------------------------------------------------
  {
    let problems: string[] | null = null;
    let detail = "";
    const leg = "sabotage-at-rest-keep-identity/host";
    if (ran(leg)) {
      problems = [];
      const a = await atRest(leg);
      const honest = servedAtRestProblems(a, await summary(leg));
      if (a?.fault !== "keep-identity") problems.push(`fault ${a?.fault}`);
      // served-at-rest must FAIL here, on the facts the fault perturbs
      const want = [
        /^mirror\.identity_bytes_held [1-9]/,
        /^served\.identity_bytes_held [1-9]/,
        /^served\.held_bytes \d+ not below identity/,
      ];
      for (const re of want)
        if (!honest.some((p) => re.test(p)))
          problems.push(`served-at-rest did not report ${re.source}`);
      if (a)
        detail = `served-at-rest fails with ${honest.length} problem(s) (${honest.slice(0, 3).join("; ")}); mirror holds ${a.mirror.identity_bytes_held} identity bytes beside its coded ones, served ${censusText(a.served)}`;
    }
    checks.push(
      check(
        "sabotage-at-rest-keep-identity",
        "GRC_AT_REST_FAULT=keep-identity (the identity body kept beside the coded one) fails served-at-rest: the mirror and the served set hold identity bytes and the served set's held bytes are not below its identity bytes",
        problems,
        detail,
      ),
    );
  }

  return { checks, report };
}
