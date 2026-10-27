// Gate 8 g8w11's live-coding checks (W11t, protocol/render-stream-11.md "As built (W11t)"), judged
// on the g8w11 group's /11 captures and its coding/ legs (run-gate8.sh run_g8w11_coding):
//
//   coding-wire            every golden-11 recording and every honest g8w11 recording, coded by
//                          the capture's encoder (rs_live_coding_tool, zstd-base and zstd), decodes
//                          in rs-core (rs-core-check live-decode) to exactly its messages
//   coding-wire-sabotages  on the scale patch recording, a dropped base and a wrong prefix are
//                          rs-core `coding` errors (not retained; checksum)
//   coding-negotiated      live: each viewer gets the coding its offer and GRC_LIVE_CODING imply
//                          (zstd-base, zstd, off; off for every viewer of the host-off leg)
//   coding-lossless        live: what each viewer decoded is byte for byte the host's tap of its
//                          connection, with the end record
//   coding-validates       live: every viewer's decoded stream passes rs-core-check at /11
//   coding-applies-as-off  live: the zstd-base viewers' resolved state at every frame they share
//                          with the uncoded viewer equals the uncoded viewer's
//   coding-smaller         live: the zstd-base viewers' wire bytes are under a third of their
//                          uncoded bytes, with based frames
//   coding-drop-base-caught    drop-message under zstd-base: the next transaction's base is
//                              missing, a `coding` error, the viewer resyncs (reason coding), the
//                              host logs it, a full transaction follows and decodes like the tap
//   coding-wrong-prefix-caught coding-wrong-prefix: the checksum catches it, then the same resync
//   coding-shared          (informative) zstd-base viewers' coded messages shared by the host

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { RS_CORE_CHECK } from "./gate7-gsw-checks";
import {
  check,
  type G8aCheck,
  jsonl,
  readText,
  skipped,
} from "./gate8-adopt-checks";
import { resolveRecording, splitRecords } from "./render-stream-2";

const EXPERIMENT = resolve(import.meta.dirname, "..", "..");
const CODING_TOOL = join(EXPERIMENT, "capture", "build", "rs_live_coding_tool");
const GOLDEN11 = join(EXPERIMENT, "protocol", "golden-11");
const WIRE_LEGS = [
  "scale/capture",
  "scene/capture",
  "scene/off/capture",
  "mesh/capture",
];

interface LiveDecodeSummary {
  messages: number;
  prefixed: number;
  expected: number | null;
  equal: number;
  first_mismatch: number | null;
  error: { index: number; seq: number; code: string; detail: string } | null;
  skipped: number;
}

function liveDecode(
  coded: string,
  expect: string,
  sabotage?: string,
): LiveDecodeSummary | string {
  const args = ["live-decode", coded, "--expect", expect];
  if (sabotage) args.push("--sabotage", sabotage);
  const r = spawnSync(RS_CORE_CHECK, args, { encoding: "utf8" });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as LiveDecodeSummary;
  } catch {
    return `rs-core-check live-decode: ${(r.stderr ?? "").slice(0, 200)}`;
  }
}

function encode(rec: string, out: string, coding: string): string | null {
  const r = spawnSync(CODING_TOOL, ["encode", rec, out, "--coding", coding], {
    encoding: "utf8",
  });
  return r.status === 0
    ? null
    : `rs_live_coding_tool: ${(r.stderr ?? "").slice(0, 200)}`;
}

interface ViewerReport {
  stream_id: string;
  offer: string;
  window: number;
  transactions: number;
  wire_bytes: number;
  errors: { index: number; seq: number; detail: string }[];
  resyncs: number[];
  full_after_resync: number[];
  skipped: number;
  end: boolean;
  fatal: string | null;
  coding: { coded: boolean | null; prefixed: number; decoded_bytes: number };
}

interface HostConnection {
  connection: number;
  stream_id: string | null;
  live_coding?: {
    offered: string | null;
    coding: string;
    messages: number;
    prefixed: number;
    shared: number;
    input_bytes: number;
    wire_bytes: number;
    wrong_prefix_seq: number | null;
  };
}

interface Viewer {
  dir: string;
  report: ViewerReport | null;
  decoded: Uint8Array | null;
  host: HostConnection | null;
  tap: Uint8Array | null;
  log: Record<string, unknown>[];
}

async function bytesOf(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

async function viewersOf(leg: string): Promise<Viewer[] | null> {
  const host = join(leg, "host");
  const summary = await readText(join(host, "evidence", "live-summary.json"));
  if (summary === undefined) return null;
  const conns =
    (JSON.parse(summary) as { connections?: HostConnection[] }).connections ??
    [];
  const out: Viewer[] = [];
  for (let k = 1; existsSync(join(leg, `viewer-${k}`)); k++) {
    const dir = join(leg, `viewer-${k}`);
    const text = await readText(join(dir, "coding-receiver.json"));
    const report =
      text === undefined ? null : (JSON.parse(text) as ViewerReport);
    const c = report
      ? (conns.find((x) => x.stream_id === report.stream_id) ?? null)
      : null;
    out.push({
      dir,
      report,
      decoded: await bytesOf(join(dir, "decoded.rs11")),
      host: c,
      tap: c
        ? await bytesOf(join(host, "tap", `stream-${c.connection}.rs2`))
        : null,
      log: c
        ? jsonl(await readText(join(host, "tap", `live-${c.connection}.jsonl`)))
        : [],
    });
  }
  return out;
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The records of a stream (magic + records) as byte strings, first the session. */
function records(data: Uint8Array): string[] {
  return splitRecords(data, 11).records.map((r) =>
    Buffer.from(r.bytes).toString("latin1"),
  );
}

function rsCoreValidate(path: string): string {
  const r = spawnSync(RS_CORE_CHECK, ["validate", path, "--version", "11"], {
    encoding: "utf8",
  });
  const cols = ((r.stdout ?? "").trim().split("\n").at(-1) ?? "").split("\t");
  return cols[1] === "ok"
    ? "ok"
    : `${cols[1] ?? "?"}: ${(cols[2] ?? "").slice(0, 200)}`;
}

/** The expected coding of a viewer: its offer against the host's GRC_LIVE_CODING. */
function expectedCoding(offer: string, host: string): string {
  const tokens = offer.split(",");
  if (host === "zstd-base" && tokens.includes("zstd-base")) return "zstd-base";
  if (host !== "off" && tokens.includes("zstd")) return "zstd";
  return "off";
}

export async function runG8w11Coding(g: string): Promise<G8aCheck[]> {
  const checks: G8aCheck[] = [];
  const coding = join(g, "coding");
  const scratch = join(coding, "wire");
  mkdirSync(scratch, { recursive: true });

  // coding-wire
  {
    const problems: string[] = [];
    const inputs: [string, string][] = ["full", "patch", "inline"].map((n) => [
      `golden-11/${n}`,
      join(GOLDEN11, `${n}.rs11`),
    ]);
    for (const leg of WIRE_LEGS)
      for (const sink of ["recording.rs11", "recording-patch.rs11"])
        if (!skipped(join(g, leg)) && existsSync(join(g, leg, sink)))
          inputs.push([`${leg}/${sink}`, join(g, leg, sink)]);
    let prefixed = 0;
    let files = 0;
    for (const [name, rec] of inputs) {
      for (const c of ["zstd-base", "zstd"]) {
        const coded = join(scratch, `${name.replaceAll("/", "_")}.${c}.coded`);
        const e = encode(rec, coded, c);
        if (e) {
          problems.push(`${name} ${c}: ${e}`);
          continue;
        }
        const r = liveDecode(coded, rec);
        if (typeof r === "string") problems.push(`${name} ${c}: ${r}`);
        else {
          files++;
          if (c === "zstd-base") prefixed += r.prefixed;
          if (r.error || r.first_mismatch !== null || r.equal !== r.expected)
            problems.push(
              `${name} ${c}: ${r.equal}/${r.expected} equal, ${r.error ? `${r.error.code}: ${r.error.detail}` : `first mismatch ${r.first_mismatch}`}`,
            );
          if (c === "zstd" && r.prefixed !== 0)
            problems.push(`${name} zstd: ${r.prefixed} based frames`);
        }
      }
    }
    if (prefixed === 0)
      problems.push("no based frame anywhere (the check proves nothing)");
    checks.push(
      check(
        "coding-wire",
        "W11t: golden-11 and every honest g8w11 recording, coded by the capture's encoder (zstd-base and zstd), decode in rs-core to exactly their messages",
        existsSync(CODING_TOOL) && existsSync(RS_CORE_CHECK) ? problems : null,
        `${files} coded streams, ${prefixed} based frames`,
      ),
    );
  }
  // coding-wire-sabotages
  {
    const rec = join(g, "scale", "capture", "recording-patch.rs11");
    const coded = join(
      scratch,
      "scale_capture_recording-patch.rs11.zstd-base.coded",
    );
    const problems: string[] = [];
    let detail = "";
    if (existsSync(coded)) {
      for (const [s, want] of [
        ["drop-base", "not retained"],
        ["wrong-prefix", "checksum"],
      ] as const) {
        const r = liveDecode(coded, rec, s);
        if (typeof r === "string") problems.push(`${s}: ${r}`);
        else if (r.error?.code !== "coding" || !r.error.detail.includes(want))
          problems.push(
            `${s}: expected a coding error (${want}), got ${JSON.stringify(r.error)}`,
          );
        else
          detail += `${s}: seq ${r.error.seq} ${r.error.code}, ${r.skipped} skipped after it; `;
      }
    }
    checks.push(
      check(
        "coding-wire-sabotages",
        "W11t: a dropped base and a wrong prefix are rs-core coding errors (missing base; content checksum)",
        existsSync(coded) ? problems : null,
        detail,
      ),
    );
  }

  // the live legs
  const live = skipped(join(coding, "live"))
    ? null
    : await viewersOf(join(coding, "live"));
  const hostOff = skipped(join(coding, "host-off"))
    ? null
    : await viewersOf(join(coding, "host-off"));
  {
    const problems: string[] = [];
    for (const [leg, viewers, hostCoding] of [
      ["live", live, "zstd-base"],
      ["host-off", hostOff, "off"],
    ] as const) {
      if (!viewers) continue;
      if (viewers.length === 0) problems.push(`${leg}: no viewer`);
      for (const v of viewers) {
        if (!v.report || !v.host?.live_coding) {
          problems.push(`${v.dir}: no viewer report or host connection`);
          continue;
        }
        const want = expectedCoding(v.report.offer, hostCoding);
        if (v.host.live_coding.coding !== want)
          problems.push(
            `${v.dir}: offer "${v.report.offer}" got ${v.host.live_coding.coding}, expected ${want}`,
          );
        if ((v.report.coding.coded === true) !== (want !== "off"))
          problems.push(
            `${v.dir}: the viewer saw coded=${v.report.coding.coded}`,
          );
      }
    }
    checks.push(
      check(
        "coding-negotiated",
        "W11t: the viewer offers, the host chooses: zstd-base, zstd or off by offer and GRC_LIVE_CODING",
        live || hostOff ? problems : null,
      ),
    );
  }
  {
    const lossless: string[] = [];
    const validates: string[] = [];
    let n = 0;
    for (const viewers of [live, hostOff]) {
      for (const v of viewers ?? []) {
        if (!v.report || !v.decoded || !v.tap) {
          lossless.push(`${v.dir}: missing decoded stream or tap`);
          continue;
        }
        n++;
        if (!v.report.end || v.report.fatal || v.report.errors.length > 0)
          lossless.push(
            `${v.dir}: end ${v.report.end}, fatal ${v.report.fatal}, ${v.report.errors.length} errors`,
          );
        if (!equalBytes(v.decoded, v.tap))
          lossless.push(
            `${v.dir}: decoded ${v.decoded.length} B differs from the tap's ${v.tap.length} B`,
          );
        const r = rsCoreValidate(join(v.dir, "decoded.rs11"));
        if (r !== "ok") validates.push(`${v.dir}: ${r}`);
      }
    }
    checks.push(
      check(
        "coding-lossless",
        "W11t: every viewer decoded, byte for byte, the host's tap of its connection, end record included",
        live || hostOff ? lossless : null,
        `${n} viewers`,
      ),
    );
    checks.push(
      check(
        "coding-validates",
        "W11t: every viewer's decoded stream passes rs-core-check at /11",
        live || hostOff ? validates : null,
      ),
    );
  }
  {
    const problems: string[] = [];
    let detail = "";
    const off = live?.find((v) => v.report?.offer === "");
    const based =
      live?.filter((v) => v.report?.offer.includes("zstd-base")) ?? [];
    if (live && off?.decoded && based.length > 0) {
      const states = (data: Uint8Array) => {
        const m = new Map<number, string>();
        for (const t of resolveRecording(data, 11).transactions)
          m.set(t.frame, JSON.stringify(t.state));
        return m;
      };
      const ref = states(off.decoded);
      for (const v of based) {
        if (!v.decoded) {
          problems.push(`${v.dir}: no decoded stream`);
          continue;
        }
        let common = 0;
        for (const [frame, s] of states(v.decoded)) {
          const o = ref.get(frame);
          if (o === undefined) continue;
          common++;
          if (o !== s) {
            problems.push(
              `${v.dir}: frame ${frame} resolves differently from the uncoded viewer`,
            );
            break;
          }
        }
        if (common < 20)
          problems.push(
            `${v.dir}: only ${common} frames shared with the uncoded viewer`,
          );
        detail += `${v.dir.split("/").at(-1)}: ${common} shared frames; `;
      }
    }
    checks.push(
      check(
        "coding-applies-as-off",
        "W11t: zstd-base viewers resolve the same state as the uncoded viewer at every frame both received",
        live ? problems : null,
        detail,
      ),
    );
    const smaller: string[] = [];
    let shared = 0;
    let sizes = "";
    for (const v of based) {
      const lc = v.host?.live_coding;
      if (!lc) continue;
      shared += lc.shared;
      if (lc.prefixed === 0) smaller.push(`${v.dir}: no based frame`);
      if (lc.wire_bytes * 3 > lc.input_bytes)
        smaller.push(
          `${v.dir}: wire ${lc.wire_bytes} B against ${lc.input_bytes} B uncoded`,
        );
      sizes += `${v.dir.split("/").at(-1)}: ${lc.input_bytes} -> ${lc.wire_bytes} B; `;
    }
    checks.push(
      check(
        "coding-smaller",
        "W11t: zstd-base viewers' wire bytes are under a third of their uncoded bytes, with based frames",
        live ? smaller : null,
        sizes,
      ),
    );
    checks.push({
      id: "coding-shared",
      criterion:
        "W11t (informative): coded messages the host shared between viewers (lockstep is not guaranteed live; rs_live_test proves the sharing)",
      passed: true,
      status: live ? "pass" : "not-run",
      detail: `${shared} shared`,
      gating: false,
    });
  }
  // the sabotages, live
  for (const [id, leg, want] of [
    ["coding-drop-base-caught", "sabotage-drop-base", "not retained"],
    ["coding-wrong-prefix-caught", "sabotage-wrong-prefix", "checksum"],
  ] as const) {
    const dir = join(coding, leg);
    if (skipped(dir) || !existsSync(join(dir, "host"))) {
      checks.push({
        id,
        criterion: `W11t: ${leg} is a coding error and resyncs`,
        passed: true,
        status: "not-run",
        detail: `skipped-by-tier: ${leg}`,
        gating: false,
      });
      continue;
    }
    const problems: string[] = [];
    let detail = "";
    const v = (await viewersOf(dir))?.[0];
    if (!v?.report || !v.decoded || !v.tap)
      problems.push("no viewer report, decoded stream or tap");
    else {
      const e = v.report.errors[0];
      if (!e?.detail.startsWith("coding") || !e.detail.includes(want))
        problems.push(
          `expected a coding error (${want}), got ${JSON.stringify(e ?? null)}`,
        );
      else {
        detail = `seq ${e.seq}: ${e.detail.slice(0, 120)}`;
        if (v.report.resyncs[0] !== e.seq)
          problems.push(`no resync for seq ${e.seq}`);
        const logged = v.log.some(
          (l) =>
            l.event === "resync" && l.seq === e.seq && l.reason === "coding",
        );
        if (!logged)
          problems.push(
            `the host logged no resync (reason coding) for seq ${e.seq}`,
          );
        if (v.report.full_after_resync.length === 0)
          problems.push("no full transaction followed");
        if (!v.report.end)
          problems.push("the stream did not reach its end record");
        if (
          id === "coding-wrong-prefix-caught" &&
          v.host?.live_coding?.wrong_prefix_seq !== e.seq
        )
          problems.push(
            `the host coded seq ${v.host?.live_coding?.wrong_prefix_seq} wrongly, the viewer failed seq ${e.seq}`,
          );
        // Everything the viewer decoded is the tap's, in order.
        const tap = records(v.tap);
        let at = 0;
        for (const r of records(v.decoded).slice(1)) {
          while (at < tap.length && tap[at] !== r) at++;
          if (at === tap.length) {
            problems.push(
              "a decoded message is not in the host's tap (in order)",
            );
            break;
          }
          at++;
        }
      }
    }
    checks.push(
      check(
        id,
        `W11t: ${leg.replace("sabotage-", "")} under zstd-base is a coding error (${want}); the viewer resyncs, the host logs it, and the stream continues from a full transaction`,
        problems,
        detail,
      ),
    );
  }
  return checks;
}
