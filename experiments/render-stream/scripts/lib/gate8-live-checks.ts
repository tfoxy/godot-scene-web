// Gate 8's live group g8l (G8g, gate8-design.md "Increments" G8g, D14): one live leg per fixture
// at render-stream/8 plus D14's reverse-proxy leg (run-gate8.sh "g8l"). Every check reads only
// g8l/<fixture>/ (host/, receiver/, replay/, proxy/), so the same checks judge a native run and a
// browser run (run-gate7.sh --live --legs g7-8: lib/gate7-live.ts reports each check that reads a
// browser leg as `<id>@<kind>`, the web export's shots through Q7's band).
//
//   g8l-<f>-host     the host published (stream not refused), listened, and its one connection
//                    spoke render-stream/8
//   g8l-<f>-live     the live receiver negotiated render-stream/8, applied every transaction it
//                    received without a failure, read the end record and shot its final state
//   g8l-<f>-states   every transaction of the received tap (received.rs8, decoded at /8) resolves
//                    to the state the host's /8 file sink holds at that transaction's frame, and
//                    the last one is the sink's final state (receiver-independent: a coalesced live
//                    stream still ends where the file does)
//   live-replay-equals-live-g8l-<f>  the live receiver's final shot equals the same receiver's
//                    replay of the host's file sink at its last checkpoint, pixel for pixel (named
//                    so lib/gate7-live.ts counts it for live-vs-replay@<kind>)
//   g8l-<f>-replay-equals-file  (only when the fixture's file group ran in the same run, i.e. a
//                    native gate 8 run) the replay's checkpoints equal the file group's honest
//                    receiver's, so g8l's host is the scene the file legs judged against the
//                    reference
//   g8l-basis-delivery  G8kb (texture-delivery-design.md Q3, Q6): the basis leg (gate8-basis at
//                    render-stream/9 under basis-uastc, the receiver at RS_RECEIVER_PROTOCOL=9 with
//                    `upgrade`): the live /9 hello stated uastc in texture_encodings, the receiver
//                    fetched at least one uastc variant over HTTP, transcoded every one it fetched
//                    without a failure, and uploaded them (uploads[] encoding uastc). The basis leg's
//                    host, live, states and live-replay checks read .rs9 at /9.
//   g8l-proxy-fronted  D14: the proxy leg's receiver connected to the proxy's port, not the host's;
//                    the proxy forwarded exactly one WebSocket upgrade (101) and every GET the
//                    receiver made (each answered 200), the host saw them with the proxy's
//                    forwarding headers' Host rewritten to its own, and the receiver's final shot
//                    equals the direct tex leg's

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import {
  check,
  exitCode,
  type G8aCheck,
  jsonl,
  loadRecording,
  readJson,
  readText,
  skipped,
  stateAt,
} from "./gate8-adopt-checks";
import type { ProxyLogLine } from "./reverse-proxy";
import {
  type ResolvedRecording,
  resolveRecording,
  statesEqual,
  wireVersionOf,
} from "./render-stream-2";

/** run-gate8.sh G8L_FIXTURES, in run order; `proxy` is tex through the reverse proxy. */
export const G8L_FIXTURES = ["tex", "float", "adopt", "size", "mat", "proxy", "basis"] as const;
export type G8lFixture = (typeof G8L_FIXTURES)[number];

/** G8kb: the wire version a fixture's live leg speaks (run-gate8.sh g8l_spec G8L_VERSION). */
export const G8L_VERSION: Record<G8lFixture, 8 | 9> = {
  tex: 8,
  float: 8,
  adopt: 8,
  size: 8,
  mat: 8,
  proxy: 8,
  basis: 9,
};

/** The file group whose honest full-sink receiver shows the same scene (replay-equals-file). G8kb:
 * the basis leg has none (g8ku's receivers attach the variants at a wait frame, the live host does
 * not). */
const FILE_RECEIVER: Record<Exclude<G8lFixture, "proxy" | "basis">, string> = {
  tex: "receiver",
  float: "g8f/receiver",
  adopt: "g8a/late/receiver",
  size: "g8h/late/receiver",
  mat: "g8m/late/receiver",
};

export interface G8lLegReport {
  host_port: number | null;
  receiver_port: number | null;
  transactions_received: number;
  transactions_file: number;
  final_shot: boolean;
  replay_shots: number;
  final_vs_replay_px: number | null;
}

export interface G8lReport {
  legs: Partial<Record<G8lFixture, G8lLegReport>>;
  proxy: { requests: number; upgrades: number; gets: number; options: number } | null;
  /** G8kb: fixtures the runner did not run for this receiver, with its reason. */
  not_applicable?: Partial<Record<G8lFixture, string>>;
}

interface LiveSummary {
  connections?: Array<{
    connection?: number;
    version?: number;
    subprotocol?: string;
    gets?: number;
    /** /9 hellos (G8kp): what the receiver stated. */
    texture_encodings?: string | null;
  }>;
}

/** G8kb: what g8l-basis-delivery reads of a /9 receiver's applied.json. */
interface BasisApplied {
  receiver?: { texture_delivery?: { texture_encodings?: string } };
  uploads?: Array<{ hash?: string | null; encoding?: string | null }>;
  transcodes?: Array<{ hash: string; ok: boolean; format?: number; format_name?: string }>;
}

interface Applied {
  receiver?: { protocol?: string; credit_window?: number };
  failure?: unknown;
  failures?: unknown[];
  result?: string;
  stream?: { ended?: boolean; end?: unknown } | null;
  streams?: Array<{ ended?: boolean; end_seen?: boolean; end?: unknown }>;
  transactions?: Array<{ seq?: number; skipped?: boolean; status?: string }>;
  shots?: Array<{ path?: string; final?: boolean; seq?: number }>;
}

function pngs(dir: string): string[] {
  try {
    return readdirSync(join(dir, "shots"))
      .filter((f) => f.endsWith(".png"))
      .sort();
  } catch {
    return [];
  }
}

/** The replay's last checkpoint shot (seq-<n>.png with the largest n). */
function lastSeqShot(dir: string): string | undefined {
  const seqs = pngs(dir)
    .map((f) => /^seq-(\d+)\.png$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  return seqs.length === 0 ? undefined : join(dir, "shots", `seq-${seqs[seqs.length - 1]}.png`);
}

/** Differing pixels between two PNGs (null: either is missing or the sizes differ). */
async function pixelDiff(a: string | undefined, b: string | undefined): Promise<number | null> {
  if (!a || !b || !existsSync(a) || !existsSync(b)) return null;
  const ia = await decodePngRgba(a);
  const ib = await decodePngRgba(b);
  if (!ia || !ib || ia.width !== ib.width || ia.height !== ib.height) return null;
  let n = 0;
  for (let i = 0; i < ia.data.length; i += 4)
    if (
      ia.data[i] !== ib.data[i] ||
      ia.data[i + 1] !== ib.data[i + 1] ||
      ia.data[i + 2] !== ib.data[i + 2] ||
      ia.data[i + 3] !== ib.data[i + 3]
    )
      n++;
  return n;
}

async function loadTap(dir: string, version: 8 | 9): Promise<{ rec?: ResolvedRecording; error?: string }> {
  const path = join(dir, `received.rs${version}`);
  if (!existsSync(path)) return { error: `${path} missing` };
  const bytes = new Uint8Array(await readFile(path));
  if (wireVersionOf(bytes) !== version) return { error: `${path} is not GRS${version}` };
  try {
    return { rec: resolveRecording(bytes, version) };
  } catch (e) {
    return { error: `${path}: ${(e as Error).message}` };
  }
}

/** Why a leg directory has no evidence (skipped by tier, remotely, or by the runner), or null. */
function absent(dir: string): string | null {
  const s = skipped(dir);
  if (s) return `${s}: ${dir}`;
  if (existsSync(join(dir, "skipped.txt"))) return `skipped: ${dir}`;
  return null;
}

function failuresOf(a: Applied): string[] {
  const out: string[] = [];
  if (a.failure !== undefined && a.failure !== null) out.push(`failure ${JSON.stringify(a.failure).slice(0, 200)}`);
  for (const f of a.failures ?? []) out.push(`failure ${JSON.stringify(f).slice(0, 200)}`);
  return out;
}

export async function runG8l(out: string): Promise<{ checks: G8aCheck[]; report: G8lReport }> {
  const checks: G8aCheck[] = [];
  const report: G8lReport = { legs: {}, proxy: null };
  const finalShot = (dir: string) => join(dir, "shots", "final.png");

  for (const f of G8L_FIXTURES) {
    const v = G8L_VERSION[f];
    const leg = join(out, "g8l", f);
    // G8kb: a fixture the runner declared not applicable to this receiver (run-gate8.sh: the web
    // export's basis leg) has no checks; the reason is in the report.
    const na = await readText(join(leg, "not-applicable.txt"));
    if (na !== undefined) {
      report.not_applicable = { ...(report.not_applicable ?? {}), [f]: na.trim() };
      continue;
    }
    const host = join(leg, "host");
    const receiver = join(leg, "receiver");
    const replay = join(leg, "replay");
    const lr: G8lLegReport = {
      host_port: null,
      receiver_port: null,
      transactions_received: 0,
      transactions_file: 0,
      final_shot: false,
      replay_shots: 0,
      final_vs_replay_px: null,
    };
    report.legs[f] = lr;
    const missingHost = absent(host);

    // host
    {
      const problems: string[] = [];
      const result = await readJson<{ stream?: { status?: string; reason?: string | null; gate8?: unknown } }>(
        join(host, "evidence", "result.json"),
      );
      const live = await readJson<{ status?: string; port?: number }>(join(host, "evidence", "live.json"));
      const summary = await readJson<LiveSummary>(join(host, "evidence", "live-summary.json"));
      const code = await exitCode(host);
      if (code !== "0") problems.push(`host exit ${code ?? "missing"}`);
      if (!result?.stream) problems.push("no evidence/result.json stream");
      else if (result.stream.status === "refused") problems.push(`stream refused: ${result.stream.reason}`);
      if (live?.status !== "listening") problems.push(`live.json status ${JSON.stringify(live?.status)}`);
      lr.host_port = live?.port ?? null;
      const conns = summary?.connections ?? [];
      if (conns.length !== 1) problems.push(`${conns.length} connections, expected 1`);
      for (const c of conns)
        if (c.version !== v) problems.push(`connection ${c.connection}: version ${c.version}, expected ${v}`);
      checks.push(
        check(
          `g8l-${f}-host`,
          `G8g: the fixture's live host published under its gate 8 policy, listened, and its one connection spoke render-stream/${v}`,
          missingHost ? null : problems,
          `port ${lr.host_port}, 1 connection at /${v}`,
        ),
      );
    }

    // live receiver
    const missingReceiver = absent(receiver);
    {
      const problems: string[] = [];
      const applied = await readJson<Applied>(join(receiver, "applied.json"));
      const code = await exitCode(receiver);
      if (!applied) problems.push("applied.json missing");
      else {
        if (applied.receiver?.protocol !== `render-stream/${v}`)
          problems.push(`receiver protocol ${JSON.stringify(applied.receiver?.protocol)}, expected render-stream/${v}`);
        problems.push(...failuresOf(applied));
      }
      if (code !== "0") problems.push(`receiver exit ${code ?? "missing"}`);
      lr.final_shot = existsSync(finalShot(receiver));
      if (!lr.final_shot) problems.push("shots/final.png missing (no final state after the end record)");
      checks.push(
        check(
          `g8l-${f}-live`,
          `G8g: the live receiver negotiated render-stream/${v}, applied the stream without a failure, read its end and shot the final state`,
          missingReceiver ? null : problems,
          `render-stream/${v}, final shot taken`,
        ),
      );
    }

    // states: the received tap against the host's file sink, frame for frame
    {
      const problems: string[] = [];
      const file = await loadRecording(host, v);
      const tap = await loadTap(receiver, v);
      if (file.error) problems.push(`file sink: ${file.error}`);
      if (tap.error) problems.push(`received tap: ${tap.error}`);
      if (file.rec && tap.rec) {
        lr.transactions_file = file.rec.transactions.length;
        lr.transactions_received = tap.rec.transactions.length;
        if (tap.rec.transactions.length === 0) problems.push("the tap holds no transaction");
        for (const t of tap.rec.transactions) {
          const at = stateAt(file.rec, t.frame);
          if (!at) {
            problems.push(`live seq ${t.seq} (frame ${t.frame}): no file transaction at or before it`);
            continue;
          }
          if (!statesEqual(t.state, at.state))
            problems.push(`live seq ${t.seq} (frame ${t.frame}) differs from the file sink's seq ${at.seq}`);
        }
        const lastLive = tap.rec.transactions[tap.rec.transactions.length - 1];
        const lastFile = file.rec.transactions[file.rec.transactions.length - 1];
        if (lastLive && lastFile && !statesEqual(lastLive.state, lastFile.state))
          problems.push(`the last live state (seq ${lastLive.seq}) is not the file sink's final state (seq ${lastFile.seq})`);
      }
      checks.push(
        check(
          `g8l-${f}-states`,
          `G8g: every live transaction (received.rs${v} at /${v}) is the host's /${v} file-sink state at its frame, and the last is the sink's final state`,
          missingHost || missingReceiver ? null : problems,
          `${lr.transactions_received} live transactions against ${lr.transactions_file} file transactions`,
        ),
      );
    }

    // live final == replay's last checkpoint (same receiver)
    {
      const problems: string[] = [];
      const last = lastSeqShot(replay);
      lr.replay_shots = pngs(replay).length;
      if (!last) problems.push("the replay shot no checkpoint");
      const d = await pixelDiff(finalShot(receiver), last);
      lr.final_vs_replay_px = d;
      if (d === null) problems.push("final.png or the replay's last shot missing, or their sizes differ");
      else if (d > 0) problems.push(`${d} px differ between the live final shot and the replay's last checkpoint`);
      if ((await exitCode(replay)) !== "0") problems.push(`replay exit ${(await exitCode(replay)) ?? "missing"}`);
      checks.push(
        check(
          `live-replay-equals-live-g8l-${f}`,
          `G8g: the live receiver's final image equals the same receiver's replay of the host's /${v} file sink at its last checkpoint, exactly`,
          missingReceiver || absent(replay) ? null : problems,
          "0 px",
        ),
      );
    }

    // G8kb: the basis leg delivers uastc over the live /9 transport
    if (f === "basis") {
      const problems: string[] = [];
      const applied = await readJson<BasisApplied>(join(receiver, "applied.json"));
      const conns = (await readJson<LiveSummary>(join(host, "evidence", "live-summary.json")))?.connections ?? [];
      const stated = applied?.receiver?.texture_delivery?.texture_encodings ?? "";
      if (!stated.split(",").includes("uastc"))
        problems.push(`texture_encodings ${JSON.stringify(stated)} lacks uastc`);
      for (const c of conns)
        if (!(c.texture_encodings ?? "").split(",").includes("uastc"))
          problems.push(`host saw connection ${c.connection}'s hello texture_encodings ${JSON.stringify(c.texture_encodings)}`);
      const uastc = (applied?.uploads ?? []).filter((u) => u.encoding === "uastc");
      const transcodes = applied?.transcodes ?? [];
      if (uastc.length === 0) problems.push("no uastc upload");
      if (transcodes.length === 0) problems.push("no transcode logged");
      for (const t of transcodes) if (!t.ok) problems.push(`transcode of ${t.hash.slice(0, 12)} failed`);
      for (const u of uastc)
        if (!transcodes.some((t) => t.hash === u.hash && t.ok))
          problems.push(`uastc upload of ${String(u.hash).slice(0, 12)} has no ok transcode`);
      checks.push(
        check(
          "g8l-basis-delivery",
          "G8kb (texture-delivery-design.md Q3, Q6): at render-stream/9 under basis-uastc, the live receiver's hello states uastc, and it fetches, transcodes (without a failure) and uploads the lazy uastc variants over the live transport",
          missingReceiver || missingHost ? null : problems,
          `${uastc.length} uastc uploads, ${transcodes.length} transcodes (${[...new Set(transcodes.map((t) => t.format_name ?? t.format))].join(",")})`,
        ),
      );
    }

    // replay == the file group's receiver (a native run with that group)
    if (f !== "proxy" && f !== "basis") {
      const file = join(out, FILE_RECEIVER[f]);
      if (existsSync(join(file, "shots")) && !absent(replay)) {
        const problems: string[] = [];
        const a = pngs(replay).filter((p) => p.startsWith("seq-"));
        const b = pngs(file).filter((p) => p.startsWith("seq-"));
        if (a.length === 0 || a.length !== b.length)
          problems.push(`${a.length} replay checkpoints vs ${b.length} file-leg checkpoints`);
        else
          for (let i = 0; i < a.length; i++) {
            const d = await pixelDiff(join(replay, "shots", a[i]), join(file, "shots", b[i]));
            if (d !== 0) problems.push(`checkpoint ${i}: ${d === null ? "unreadable" : `${d} px`}`);
          }
        checks.push(
          check(
            `g8l-${f}-replay-equals-file`,
            `G8g: the live host's scene is the file group's: the replay's checkpoints equal ${FILE_RECEIVER[f]}'s`,
            problems,
            `${a.length} checkpoints, 0 px`,
          ),
        );
      }
    }
  }

  // D14: the proxy leg
  {
    const leg = join(out, "g8l", "proxy");
    const problems: string[] = [];
    const ports = await readJson<{ target_port?: number; listen_port?: number | null }>(join(leg, "proxy", "ports.json"));
    const stats = await readJson<{ requests: number; upgrades: number; gets: number; options: number }>(
      join(leg, "proxy", "stats.json"),
    );
    const lines = jsonl<ProxyLogLine>(await readText(join(leg, "proxy", "requests.jsonl")));
    report.proxy = stats ?? null;
    const page = await readJson<{ env?: Record<string, string> }>(join(leg, "receiver", "page-config.json"));
    const envTxt = (await readText(join(leg, "receiver", "env.txt"))) ?? "";
    const url = page?.env?.RS_RECEIVER_URL ?? /^RS_RECEIVER_URL=(.*)$/m.exec(envTxt)?.[1] ?? "";
    const urlPort = Number(/:(\d+)\//.exec(url)?.[1] ?? "0");
    const hostPort = report.legs.proxy?.host_port ?? null;
    if (!ports?.listen_port) problems.push("the proxy did not bind (proxy/ports.json)");
    else if (urlPort !== ports.listen_port) problems.push(`the receiver connected to port ${urlPort}, not the proxy's ${ports.listen_port}`);
    if (hostPort !== null && urlPort === hostPort) problems.push("the receiver connected to the host's own port");
    if (ports?.target_port !== hostPort) problems.push(`the proxy forwarded to ${ports?.target_port}, the host listened on ${hostPort}`);
    const upgrades = lines.filter((l) => l.upgrade);
    const gets = lines.filter((l) => !l.upgrade && l.method === "GET");
    if (upgrades.length !== 1 || upgrades[0]?.status !== 101)
      problems.push(`${upgrades.length} upgrades (${upgrades.map((u) => u.status).join(",")}), expected one 101`);
    for (const g of gets) if (g.status !== 200) problems.push(`GET ${g.url.replace(/\?.*$/, "")} answered ${g.status}`);
    if (gets.length === 0) problems.push("no resource GET went through the proxy");
    const bad = lines.filter((l) => !l.upgrade && l.method !== "GET" && l.method !== "OPTIONS");
    for (const b of bad) problems.push(`unexpected ${b.method} ${b.url}`);
    const d = await pixelDiff(join(leg, "receiver", "shots", "final.png"), join(out, "g8l", "tex", "receiver", "shots", "final.png"));
    if (d === null) problems.push("the proxy leg's or the tex leg's final shot is missing");
    else if (d > 0) problems.push(`${d} px differ from the direct tex leg's final shot`);
    checks.push(
      check(
        "g8l-proxy-fronted",
        "G8g, D14: a receiver behind an HTTP reverse proxy (the WebSocket upgrade and every resource GET forwarded, Host rewritten) gets the direct leg's stream and pixels, with no wire change",
        absent(join(leg, "receiver")) || absent(join(leg, "host")) ? null : problems,
        `1 upgrade, ${gets.length} GETs, ${lines.filter((l) => l.method === "OPTIONS").length} preflights through port ${ports?.listen_port}; final shot equals tex's`,
      ),
    );
  }
  return { checks, report };
}
