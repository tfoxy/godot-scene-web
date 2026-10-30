// Gate 8 g8w11's /13 checks (W13b, protocol/render-stream-13.md "As built (W13b)"): the capture's
// /13 file sinks and the listener's /13 connections, judged on run-gate8.sh run_g8w11_v13's legs
// (scale13/, mesh13/ and coding13/ under g8w11/):
//
//   w13-validate          every /13 recording (scale13 and mesh13, both sinks) passes the TypeScript
//                         validator and rs-core-check at /13 (predict-check on every transaction)
//   w13-file-equiv        each /13 recording, transcoded to /12 by rs-core-check, is its /12 twin
//                         (the same fixture, frames and env at GRC_STREAM_VERSION=12) byte for byte
//                         under cmp-rec.ts's rules (session ids and end-record timings excepted)
//   w13-dyn-wire          dyn-wire (W11b) on the transcoded /13 scale and mesh recordings
//   w13-dyn-wire-catches-perturb-vertex   perturb-vertex at /13 still fails dyn-wire
//   w13-equiv             coding13/live: one host, /13 viewers and a /12 viewer; each /13 viewer's
//                         stream transcoded to /12 equals the /12 viewer's, message for message,
//                         at every transaction both received from the same base (seq and base_seq
//                         aside, which each connection numbers itself)
//   w13-predict-stale-caught   coding13/sabotage-predict-stale: the viewer fails predict-check at
//                         the seq the host coded stale, resyncs (reason coding), the host logs it,
//                         a full follows and the stream reaches its end
//   w13-predict-shared    (informative) /13 codings the host shared between lockstep viewers
//   w13-bytes             (informative) raw and coded (zstd-base, W11t) bytes a warm patch, /13
//                         against the /12 twin, on the scale recordings
// plus gate8-w11t-checks.ts's coding checks at /13 (runG8w11Coding(g, 13): `w13-coding-*`).

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ResourceLine } from "./gate2-checks";
import { RS_CORE_CHECK } from "./gate7-gsw-checks";
import {
  check,
  type G8aCheck,
  jsonl,
  readText,
  skipped,
} from "./gate8-adopt-checks";
import { dynWireProblems, traceDynamic } from "./gate8-w11-checks";
import { runG8w11Coding, viewersOf } from "./gate8-w11t-checks";
import {
  resolveRecording,
  splitRecords,
  validateRecording,
} from "./render-stream-2";

const EXPERIMENT = resolve(import.meta.dirname, "..", "..");
const REPO = resolve(EXPERIMENT, "..", "..");
const CMP_REC = join(EXPERIMENT, "scripts", "cmp-rec.ts");
const CODING_TOOL = join(EXPERIMENT, "capture", "build", "rs_live_coding_tool");

// [leg, its /12 twin, sinks]
const FILE_LEGS: [string, string][] = [
  ["scale13/capture", "scale13/v12/capture"],
  ["mesh13/capture", "mesh13/v12/capture"],
];
const SINKS = ["recording", "recording-patch"];

async function bytesOf(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

function rsCore(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(RS_CORE_CHECK, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function rsCoreValidate(path: string, version: number): string {
  const r = spawnSync(
    RS_CORE_CHECK,
    ["validate", path, "--version", `${version}`],
    {
      encoding: "utf8",
    },
  );
  const cols = ((r.stdout ?? "").trim().split("\n").at(-1) ?? "").split("\t");
  return cols[1] === "ok"
    ? "ok"
    : `${cols[1] ?? "?"}: ${(cols[2] ?? r.stderr ?? "").slice(0, 200)}`;
}

/** The transcodes' scratch directory: <root>/w13, or (W13d) a fresh temporary one when that is
 * not writable: gate 7's views link a cached source run's directories, which the cache keeps
 * read-only, so g7-8's re-judging could not write its transcodes there. Removed at exit. */
function scratchDir(root: string): string {
  const dir = join(root, "w13");
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return dir;
  } catch {
    const tmp = mkdtempSync(join(tmpdir(), "gate8-w13-"));
    process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
    return tmp;
  }
}

/** rs-core-check transcode --to 12 into `out`; null on success, else the error. */
function transcode12(input: string, out: string): string | null {
  const r = rsCore(["transcode", "--to", "12", input, out]);
  return r.ok && existsSync(out)
    ? null
    : `transcode: ${r.out.trim().slice(0, 200)}`;
}

/** cmp-rec.ts a b: null when identical under its rules, else its report. */
function cmpRec(a: string, b: string): string | null {
  const r = spawnSync(
    "pnpm",
    ["exec", "tsx", "--conditions=development", CMP_REC, a, b],
    { cwd: REPO, encoding: "utf8" },
  );
  return r.status === 0
    ? null
    : `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 300);
}

function notRun(id: string, criterion: string, why: string): G8aCheck {
  return {
    id,
    criterion,
    passed: true,
    status: "not-run",
    detail: why,
    gating: false,
  };
}

/** A transaction's meta text with seq and base_seq blanked (each connection numbers its own). */
function unnumbered(meta: string): string {
  return meta
    .replace(
      /^\{"type":"transaction","seq":\d+,/,
      '{"type":"transaction","seq":0,',
    )
    .replace(/"base_seq":\d+,"status"/, '"base_seq":0,"status"');
}

interface TxView {
  frame: number;
  base_frame: number | null; // null: full
  key: string; // unnumbered meta + blocks
  records: string[]; // the resource records before it
}

/** A live stream's transactions by (frame, base frame), with the resource records before each. */
function txViews(data: Uint8Array, version: 12): Map<string, TxView> {
  const out = new Map<string, TxView>();
  const frameOf = new Map<number, number>();
  let pending: string[] = [];
  const recs = splitRecords(data, version).records;
  for (let i = 1; i < recs.length; i++) {
    const b = recs[i].bytes;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const metaLen = view.getUint32(4, true);
    const meta = new TextDecoder().decode(b.subarray(8, 8 + metaLen));
    const m = JSON.parse(meta) as {
      type: string;
      seq?: number;
      frame?: number;
      base_seq?: number | null;
    };
    if (m.type === "resource") {
      pending.push(Buffer.from(b).toString("latin1"));
      continue;
    }
    if (m.type !== "transaction") continue;
    const seq = m.seq ?? 0;
    const frame = m.frame ?? 0;
    frameOf.set(seq, frame);
    const baseFrame =
      m.base_seq === null || m.base_seq === undefined
        ? null
        : (frameOf.get(m.base_seq) ?? -1);
    const key = `${frame}:${baseFrame}`;
    out.set(key, {
      frame,
      base_frame: baseFrame,
      key:
        unnumbered(meta) +
        Buffer.from(b.subarray(8 + metaLen)).toString("latin1"),
      records: pending,
    });
    pending = [];
  }
  return out;
}

/** A /12 stream's resolved state at each transaction's frame. */
function statesByFrame(data: Uint8Array): Map<number, string> {
  const m = new Map<number, string>();
  for (const t of resolveRecording(data, 12).transactions)
    m.set(t.frame, JSON.stringify(t.state));
  return m;
}

/** The zstd-base coded bytes of each warm patch (after the first `skip` transactions). */
function codedPatchBytes(
  rec: string,
  out: string,
  skip: number,
): number[] | string {
  const stats = `${out}.stats.jsonl`;
  const r = spawnSync(
    CODING_TOOL,
    ["encode", rec, out, "--coding", "zstd-base", "--stats", stats],
    { encoding: "utf8" },
  );
  if (r.status !== 0)
    return `rs_live_coding_tool: ${(r.stderr ?? "").slice(0, 200)}`;
  const lines = readFileSync(stats, "utf8");
  const sizes: number[] = [];
  let n = 0;
  for (const line of lines.split("\n")) {
    if (!line.trim()) continue;
    const s = JSON.parse(line) as { encoding?: string; coded_bytes?: number };
    n++;
    if (n <= skip || s.encoding !== "patch") continue;
    sizes.push(s.coded_bytes ?? 0);
  }
  return sizes;
}

const mean = (a: number[]) =>
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

/** w13-validate and w13-file-equiv over `pairs` ([/13 leg, its /12 twin] under `root`), with the
 * transcoded /12 files by "<leg>/<sink>". `suffix` names the group's ids (W13b: "" for g8w11,
 * "-g8pt" for g8pt's headless twins). */
export async function fileEquiv(
  root: string,
  pairs: [string, string][],
  suffix: string,
  what: string,
): Promise<{ checks: G8aCheck[]; transcoded: Map<string, string> }> {
  const checks: G8aCheck[] = [];
  const scratch = scratchDir(root);
  const legDir = (leg: string) => join(root, leg);
  const transcoded = new Map<string, string>(); // "<leg>/<sink>" -> the /12 file
  {
    const validate: string[] = [];
    const equiv: string[] = [];
    let any = false;
    let compared = 0;
    for (const [leg, twin] of pairs) {
      if (skipped(legDir(leg))) continue;
      for (const sink of SINKS) {
        const path = join(legDir(leg), `${sink}.rs13`);
        const data = await bytesOf(path);
        if (!data) {
          validate.push(`${leg}/${sink}.rs13: missing`);
          continue;
        }
        any = true;
        const ts = validateRecording(data, 13);
        if (ts.length > 0)
          validate.push(`${leg}/${sink}: TS ${ts[0].slice(0, 200)}`);
        const rc = rsCoreValidate(path, 13);
        if (rc !== "ok") validate.push(`${leg}/${sink}: rs-core ${rc}`);
        const out = join(scratch, `${leg.replaceAll("/", "_")}_${sink}.rs12`);
        const e = transcode12(path, out);
        if (e) {
          equiv.push(`${leg}/${sink}: ${e}`);
          continue;
        }
        transcoded.set(`${leg}/${sink}`, out);
        if (skipped(legDir(twin))) continue;
        const twinPath = join(legDir(twin), `${sink}.rs12`);
        if (!existsSync(twinPath)) {
          equiv.push(`${twin}/${sink}.rs12: missing`);
          continue;
        }
        compared++;
        const c = cmpRec(twinPath, out);
        if (c) equiv.push(`${leg}/${sink}: ${c}`);
      }
    }
    if (any && compared === 0)
      equiv.push("no /12 twin to compare (the check proves nothing)");
    const all = pairs.every(([leg]) => skipped(legDir(leg)));
    if (all) {
      const why = `skipped-by-tier: ${pairs.map(([leg]) => leg).join(", ")}`;
      checks.push(
        notRun(
          `w13-validate${suffix}`,
          `W13b: /13 recordings (${what}) validate`,
          why,
        ),
      );
      checks.push(
        notRun(
          `w13-file-equiv${suffix}`,
          `W13b: /13 recordings (${what}) equal their /12 twins`,
          why,
        ),
      );
      return { checks, transcoded };
    }
    checks.push(
      check(
        `w13-validate${suffix}`,
        `W13b: every /13 recording (${what}, both sinks) passes the TypeScript validator and rs-core-check at /13`,
        any ? validate : null,
      ),
    );
    checks.push(
      check(
        `w13-file-equiv${suffix}`,
        "W13b: each /13 recording transcoded to /12 (rs-core-check transcode) is its /12 twin byte for byte (cmp-rec.ts: session ids and end-record timings excepted)",
        any ? equiv : null,
        `${compared} recording pairs`,
      ),
    );
  }

  return { checks, transcoded };
}

export async function runG8w13(g: string): Promise<G8aCheck[]> {
  const checks: G8aCheck[] = [];
  const scratch = scratchDir(g);
  const legDir = (leg: string) => join(g, leg);

  // w13-validate, w13-file-equiv (and the transcoded files the dyn-wire checks read)
  const files = await fileEquiv(
    g,
    FILE_LEGS,
    "",
    "capture-scale and gate5-mesh",
  );
  checks.push(...files.checks);
  const transcoded = files.transcoded;

  // w13-dyn-wire on the transcoded recordings
  {
    const problems: string[] = [];
    let any = false;
    for (const [leg] of FILE_LEGS) {
      if (skipped(legDir(leg))) continue;
      const lines = jsonl<ResourceLine>(
        await readText(join(legDir(leg), "evidence", "resources.jsonl")),
      );
      for (const sink of SINKS) {
        const path = transcoded.get(`${leg}/${sink}`);
        const data = path ? await bytesOf(path) : null;
        if (!data) continue;
        any = true;
        for (const p of dynWireProblems(traceDynamic(data, 12), lines))
          problems.push(`${leg}/${sink}: ${p}`);
      }
    }
    checks.push(
      check(
        "w13-dyn-wire",
        "W13b: dyn-wire at /13: every dynamic body a transaction holds (the /13 recording transcoded), rebuilt into GRM1, hashes to the hook log's surface hash at that frame",
        any ? problems : null,
      ),
    );
  }
  {
    const id = "w13-dyn-wire-catches-perturb-vertex";
    const leg = "scale13/sabotage-perturb-vertex/capture";
    const criterion =
      "W13b: perturb-vertex at /13 still fails dyn-wire (the patch recording transcoded)";
    if (skipped(legDir(leg)))
      checks.push(notRun(id, criterion, `skipped-by-tier: ${leg}`));
    else {
      const out = join(
        scratch,
        "scale13_sabotage-perturb-vertex_recording-patch.rs12",
      );
      const e = transcode12(join(legDir(leg), "recording-patch.rs13"), out);
      const data = e ? null : await bytesOf(out);
      if (!data)
        checks.push(check(id, criterion, [e ?? "no transcoded recording"]));
      else {
        const lines = jsonl<ResourceLine>(
          await readText(join(legDir(leg), "evidence", "resources.jsonl")),
        );
        const caught = dynWireProblems(traceDynamic(data, 12), lines);
        checks.push(
          check(
            id,
            criterion,
            caught.length > 0
              ? []
              : ["dyn-wire passed: the sabotage went unseen"],
            caught[0],
          ),
        );
      }
    }
  }

  // The coding legs at /13 (gate8-w11t-checks.ts, ids w13-coding-*).
  checks.push(...(await runG8w11Coding(g, 13)));

  const coding = join(g, "coding13");
  // w13-equiv, w13-predict-shared
  {
    const id = "w13-equiv";
    const criterion =
      "W13b: one host, a /12 and /13 viewers: each /13 viewer's stream transcoded to /12 equals the /12 viewer's, message for message (resource records included), at every transaction both received from the same base, and resolves alike at every frame both received";
    const leg = join(coding, "live");
    const viewers =
      skipped(leg) || skipped(join(leg, "host")) ? null : await viewersOf(leg);
    if (!viewers)
      checks.push(notRun(id, criterion, "skipped-by-tier: coding13/live"));
    else {
      const problems: string[] = [];
      let detail = "";
      const v12 = viewers.find((v) => v.version === 12);
      const v13s = viewers.filter((v) => v.version === 13);
      let shared = 0;
      if (!v12?.decoded || v13s.length === 0)
        problems.push("no /12 viewer, or no /13 viewer");
      else {
        const ref = txViews(v12.decoded, 12);
        const refStates = statesByFrame(v12.decoded);
        for (const v of v13s) {
          shared += v.host?.predict?.shared ?? 0;
          const name = v.dir.split("/").at(-1) ?? v.dir;
          const out = join(scratch, `live_${name}.rs12`);
          const e = transcode12(join(v.dir, "decoded.rs13"), out);
          const data = e ? null : await bytesOf(out);
          if (!data) {
            problems.push(`${name}: ${e ?? "no transcoded stream"}`);
            continue;
          }
          const mine = txViews(data, 12);
          let common = 0;
          let differ = 0;
          for (const [key, t] of mine) {
            const o = ref.get(key);
            if (!o) continue;
            common++;
            if (o.key !== t.key || o.records.join("") !== t.records.join("")) {
              differ++;
              if (differ <= 3)
                problems.push(
                  `${name}: frame ${t.frame} (base frame ${t.base_frame}) differs from the /12 viewer's`,
                );
            }
          }
          // Every frame both resolved: the same state (the bases need not match).
          let frames = 0;
          for (const [frame, st] of statesByFrame(data)) {
            const o = refStates.get(frame);
            if (o === undefined) continue;
            frames++;
            if (o !== st) {
              problems.push(`${name}: frame ${frame} resolves differently from the /12 viewer`);
              break;
            }
          }
          // Live acks follow the clock: under load a slow viewer shares few frames with the others
          // (rs_live_test proves the whole stream with deterministic pacing).
          if (common === 0 || frames < 5)
            problems.push(
              `${name}: ${common} transactions from a common base and ${frames} frames in common with the /12 viewer (too little overlap to judge)`,
            );
          detail += `${name}: ${common}/${mine.size} messages from a common base (${differ} differ), ${frames} frames resolved alike; `;
        }
      }
      checks.push(check(id, criterion, problems, detail));
      checks.push({
        id: "w13-predict-shared",
        criterion:
          "W13b (informative): /13 codings the host shared between viewers (lockstep is not guaranteed live; rs_live_test proves the sharing)",
        passed: true,
        status: "pass",
        detail: `${shared} shared`,
        gating: false,
      });
    }
  }
  // w13-predict-stale-caught
  {
    const id = "w13-predict-stale-caught";
    const criterion =
      "W13b: host predict-stale: the /13 viewer fails predict-check at the stale seq, resyncs (reason coding), the host logs it, a full follows and the stream reaches its end";
    const dir = join(coding, "sabotage-predict-stale");
    if (skipped(dir) || skipped(join(dir, "host")) || !existsSync(join(dir, "host")))
      checks.push(
        notRun(
          id,
          criterion,
          "skipped-by-tier: coding13/sabotage-predict-stale",
        ),
      );
    else {
      const problems: string[] = [];
      let detail = "";
      const v = (await viewersOf(dir))?.[0];
      if (!v?.report) problems.push("no viewer report");
      else {
        const e = v.report.errors[0];
        const stale = v.host?.predict?.stale_seq ?? null;
        if (stale === null)
          problems.push(
            "the host coded no patch stale (predict.stale_seq null: no patch from the frame on had a unit whose H1 and H2 differ)",
          );
        if (!e?.detail.startsWith("predict-check"))
          problems.push(
            `expected a predict-check error, got ${JSON.stringify(e ?? null)}`,
          );
        else {
          detail = `seq ${e.seq}: ${e.detail.slice(0, 120)}`;
          if (stale !== e.seq)
            problems.push(
              `the host coded seq ${stale} stale, the viewer failed seq ${e.seq}`,
            );
          if (v.report.resyncs[0] !== e.seq)
            problems.push(`no resync for seq ${e.seq}`);
          if (
            !v.log.some(
              (l) =>
                l.event === "resync" &&
                l.seq === e.seq &&
                l.reason === "coding",
            )
          )
            problems.push(
              `the host logged no resync (reason coding) for seq ${e.seq}`,
            );
          if (
            !v.log.some(
              (l) =>
                l.event === "sabotage" &&
                l.kind === "predict-stale" &&
                l.seq === e.seq,
            )
          )
            problems.push(
              "the host logged no predict-stale sabotage line for that seq",
            );
          if (v.report.full_after_resync.length === 0)
            problems.push("no full transaction followed");
          if (!v.report.end || v.report.fatal)
            problems.push(`end ${v.report.end}, fatal ${v.report.fatal}`);
          if (v.report.errors.length !== 1)
            problems.push(
              `${v.report.errors.length} errors (one stale patch expected)`,
            );
        }
      }
      checks.push(check(id, criterion, problems, detail));
    }
  }
  // w13-bytes (informative)
  {
    const rec13 = join(g, "scale13", "capture", "recording-patch.rs13");
    const rec12 = join(g, "scale13", "v12", "capture", "recording-patch.rs12");
    let detail = "scale13 or its /12 twin missing";
    if (existsSync(rec13) && existsSync(rec12) && existsSync(CODING_TOOL)) {
      const c13 = codedPatchBytes(rec13, join(scratch, "bytes13.coded"), 10);
      const c12 = codedPatchBytes(rec12, join(scratch, "bytes12.coded"), 10);
      const raw13 = (await bytesOf(rec13))?.length ?? 0;
      const raw12 = (await bytesOf(rec12))?.length ?? 0;
      detail =
        typeof c13 === "string" || typeof c12 === "string"
          ? `${c13} ${c12}`
          : `warm patches (after the 10th transaction), zstd-base coded: /12 ${mean(c12).toFixed(0)} B, /13 ${mean(c13).toFixed(0)} B a patch (${c13.length} patches); raw recording /12 ${raw12} B, /13 ${raw13} B`;
    }
    checks.push({
      id: "w13-bytes",
      criterion:
        "W13b (informative): bytes a warm patch on the g8w11 capture-scale recording, /13 against its /12 twin, coded as W11t's zstd-base",
      passed: true,
      status: existsSync(rec13) ? "pass" : "not-run",
      detail,
      gating: false,
    });
  }
  return checks;
}
