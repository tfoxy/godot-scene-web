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
import { runTrkChecks } from "./gate8-track-checks";
import {
  type ResolvedRecording,
  resolveRecording,
  statesEqual,
  wireVersionOf,
} from "./render-stream-2";
import type { ProxyLogLine } from "./reverse-proxy";

/** run-gate8.sh G8L_FIXTURES, in run order; `proxy` is tex through the reverse proxy. */
export const G8L_FIXTURES = [
  "tex",
  "float",
  "adopt",
  "size",
  "mat",
  "proxy",
  "basis",
] as const;
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
  proxy: {
    requests: number;
    upgrades: number;
    gets: number;
    options: number;
  } | null;
  /** G8kb: fixtures the runner did not run for this receiver, with its reason. */
  not_applicable?: Partial<Record<G8lFixture, string>>;
  /** CAR2: the lan leg (native only), or why this machine could not run it. */
  lan?: { status: "ran" | "unavailable"; address?: string; reason?: string };
  /** CAR4: the wss leg (native only), or why this machine could not run it. */
  wss?: {
    status: "ran" | "unavailable";
    port?: number | null;
    cert_sha256?: string;
    reason?: string;
  };
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
  transcodes?: Array<{
    hash: string;
    ok: boolean;
    format?: number;
    format_name?: string;
  }>;
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
  return seqs.length === 0
    ? undefined
    : join(dir, "shots", `seq-${seqs[seqs.length - 1]}.png`);
}

/** Differing pixels between two PNGs (null: either is missing or the sizes differ). */
async function pixelDiff(
  a: string | undefined,
  b: string | undefined,
): Promise<number | null> {
  if (!a || !b || !existsSync(a) || !existsSync(b)) return null;
  const ia = await decodePngRgba(a);
  const ib = await decodePngRgba(b);
  if (!ia || !ib || ia.width !== ib.width || ia.height !== ib.height)
    return null;
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

async function loadTap(
  dir: string,
  version: 8 | 9,
): Promise<{ rec?: ResolvedRecording; error?: string }> {
  const path = join(dir, `received.rs${version}`);
  if (!existsSync(path)) return { error: `${path} missing` };
  const bytes = new Uint8Array(await readFile(path));
  if (wireVersionOf(bytes) !== version)
    return { error: `${path} is not GRS${version}` };
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
  if (a.failure !== undefined && a.failure !== null)
    out.push(`failure ${JSON.stringify(a.failure).slice(0, 200)}`);
  for (const f of a.failures ?? [])
    out.push(`failure ${JSON.stringify(f).slice(0, 200)}`);
  return out;
}

/**
 * CAR6: the bytes the hub sent on the connection that opened on carrier `carrier`, found by the
 * `open` event's `carrier` in the tap's live-<n>.jsonl (never by the carrier's index), against the
 * bytes the GDScript peer kept (peer/received.bin). `problems` is empty when they are identical.
 */
export async function extCarrierBytes(
  host: string,
  carrier: string,
): Promise<{ problems: string[]; tapBytes: number; peerBytes: number }> {
  const problems: string[] = [];
  const tapDir = join(host, "tap");
  let n: string | null = null;
  const names = existsSync(tapDir) ? readdirSync(tapDir) : [];
  for (const f of names) {
    const m = /^live-(\d+)\.jsonl$/.exec(f);
    if (!m) continue;
    const first = (await readText(join(tapDir, f)))?.split("\n")[0] ?? "";
    try {
      const o = JSON.parse(first) as { event?: string; carrier?: string };
      if (o.event === "open" && o.carrier === carrier) n = m[1];
    } catch {
      // not an event line
    }
  }
  if (n === null)
    return {
      problems: [`no tap connection opened on carrier ${carrier}`],
      tapBytes: 0,
      peerBytes: 0,
    };
  let tap: Buffer | null = null;
  let peer: Buffer | null = null;
  try {
    tap = await readFile(join(tapDir, `stream-${n}.rs2`));
  } catch {
    problems.push(`tap stream-${n}.rs2 missing`);
  }
  try {
    peer = await readFile(join(host, "peer", "received.bin"));
  } catch {
    problems.push("peer/received.bin missing");
  }
  if (tap && peer) {
    if (tap.length === 0) problems.push(`tap stream-${n}.rs2 is empty`);
    if (!tap.equals(peer))
      problems.push(
        `the peer kept ${peer.length} bytes, the hub's tap of connection ${n} holds ${tap.length} (not identical)`,
      );
  }
  return { problems, tapBytes: tap?.length ?? 0, peerBytes: peer?.length ?? 0 };
}

export async function runG8l(
  out: string,
): Promise<{ checks: G8aCheck[]; report: G8lReport }> {
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
      report.not_applicable = {
        ...(report.not_applicable ?? {}),
        [f]: na.trim(),
      };
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
      const result = await readJson<{
        stream?: { status?: string; reason?: string | null; gate8?: unknown };
      }>(join(host, "evidence", "result.json"));
      const live = await readJson<{ status?: string; port?: number }>(
        join(host, "evidence", "live.json"),
      );
      const summary = await readJson<LiveSummary>(
        join(host, "evidence", "live-summary.json"),
      );
      const code = await exitCode(host);
      if (code !== "0") problems.push(`host exit ${code ?? "missing"}`);
      if (!result?.stream) problems.push("no evidence/result.json stream");
      else if (result.stream.status === "refused")
        problems.push(`stream refused: ${result.stream.reason}`);
      if (live?.status !== "listening")
        problems.push(`live.json status ${JSON.stringify(live?.status)}`);
      lr.host_port = live?.port ?? null;
      const conns = summary?.connections ?? [];
      if (conns.length !== 1)
        problems.push(`${conns.length} connections, expected 1`);
      for (const c of conns)
        if (c.version !== v)
          problems.push(
            `connection ${c.connection}: version ${c.version}, expected ${v}`,
          );
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
          problems.push(
            `receiver protocol ${JSON.stringify(applied.receiver?.protocol)}, expected render-stream/${v}`,
          );
        problems.push(...failuresOf(applied));
      }
      if (code !== "0") problems.push(`receiver exit ${code ?? "missing"}`);
      lr.final_shot = existsSync(finalShot(receiver));
      if (!lr.final_shot)
        problems.push(
          "shots/final.png missing (no final state after the end record)",
        );
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
        if (tap.rec.transactions.length === 0)
          problems.push("the tap holds no transaction");
        for (const t of tap.rec.transactions) {
          const at = stateAt(file.rec, t.frame);
          if (!at) {
            problems.push(
              `live seq ${t.seq} (frame ${t.frame}): no file transaction at or before it`,
            );
            continue;
          }
          if (!statesEqual(t.state, at.state))
            problems.push(
              `live seq ${t.seq} (frame ${t.frame}) differs from the file sink's seq ${at.seq}`,
            );
        }
        const lastLive = tap.rec.transactions[tap.rec.transactions.length - 1];
        const lastFile =
          file.rec.transactions[file.rec.transactions.length - 1];
        if (
          lastLive &&
          lastFile &&
          !statesEqual(lastLive.state, lastFile.state)
        )
          problems.push(
            `the last live state (seq ${lastLive.seq}) is not the file sink's final state (seq ${lastFile.seq})`,
          );
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
      if (d === null)
        problems.push(
          "final.png or the replay's last shot missing, or their sizes differ",
        );
      else if (d > 0)
        problems.push(
          `${d} px differ between the live final shot and the replay's last checkpoint`,
        );
      if ((await exitCode(replay)) !== "0")
        problems.push(`replay exit ${(await exitCode(replay)) ?? "missing"}`);
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
      const applied = await readJson<BasisApplied>(
        join(receiver, "applied.json"),
      );
      const conns =
        (
          await readJson<LiveSummary>(
            join(host, "evidence", "live-summary.json"),
          )
        )?.connections ?? [];
      const stated =
        applied?.receiver?.texture_delivery?.texture_encodings ?? "";
      if (!stated.split(",").includes("uastc"))
        problems.push(
          `texture_encodings ${JSON.stringify(stated)} lacks uastc`,
        );
      for (const c of conns)
        if (!(c.texture_encodings ?? "").split(",").includes("uastc"))
          problems.push(
            `host saw connection ${c.connection}'s hello texture_encodings ${JSON.stringify(c.texture_encodings)}`,
          );
      const uastc = (applied?.uploads ?? []).filter(
        (u) => u.encoding === "uastc",
      );
      const transcodes = applied?.transcodes ?? [];
      if (uastc.length === 0) problems.push("no uastc upload");
      if (transcodes.length === 0) problems.push("no transcode logged");
      for (const t of transcodes)
        if (!t.ok) problems.push(`transcode of ${t.hash.slice(0, 12)} failed`);
      for (const u of uastc)
        if (!transcodes.some((t) => t.hash === u.hash && t.ok))
          problems.push(
            `uastc upload of ${String(u.hash).slice(0, 12)} has no ok transcode`,
          );
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
          problems.push(
            `${a.length} replay checkpoints vs ${b.length} file-leg checkpoints`,
          );
        else
          for (let i = 0; i < a.length; i++) {
            const d = await pixelDiff(
              join(replay, "shots", a[i]),
              join(file, "shots", b[i]),
            );
            if (d !== 0)
              problems.push(
                `checkpoint ${i}: ${d === null ? "unreadable" : `${d} px`}`,
              );
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
    const ports = await readJson<{
      target_port?: number;
      listen_port?: number | null;
    }>(join(leg, "proxy", "ports.json"));
    const stats = await readJson<{
      requests: number;
      upgrades: number;
      gets: number;
      options: number;
    }>(join(leg, "proxy", "stats.json"));
    const lines = jsonl<ProxyLogLine>(
      await readText(join(leg, "proxy", "requests.jsonl")),
    );
    report.proxy = stats ?? null;
    const page = await readJson<{ env?: Record<string, string> }>(
      join(leg, "receiver", "page-config.json"),
    );
    const envTxt = (await readText(join(leg, "receiver", "env.txt"))) ?? "";
    const url =
      page?.env?.RS_RECEIVER_URL ??
      /^RS_RECEIVER_URL=(.*)$/m.exec(envTxt)?.[1] ??
      "";
    const urlPort = Number(/:(\d+)\//.exec(url)?.[1] ?? "0");
    const hostPort = report.legs.proxy?.host_port ?? null;
    if (!ports?.listen_port)
      problems.push("the proxy did not bind (proxy/ports.json)");
    else if (urlPort !== ports.listen_port)
      problems.push(
        `the receiver connected to port ${urlPort}, not the proxy's ${ports.listen_port}`,
      );
    if (hostPort !== null && urlPort === hostPort)
      problems.push("the receiver connected to the host's own port");
    if (ports?.target_port !== hostPort)
      problems.push(
        `the proxy forwarded to ${ports?.target_port}, the host listened on ${hostPort}`,
      );
    const upgrades = lines.filter((l) => l.upgrade);
    const gets = lines.filter((l) => !l.upgrade && l.method === "GET");
    if (upgrades.length !== 1 || upgrades[0]?.status !== 101)
      problems.push(
        `${upgrades.length} upgrades (${upgrades.map((u) => u.status).join(",")}), expected one 101`,
      );
    for (const g of gets)
      if (g.status !== 200)
        problems.push(`GET ${g.url.replace(/\?.*$/, "")} answered ${g.status}`);
    if (gets.length === 0)
      problems.push("no resource GET went through the proxy");
    const bad = lines.filter(
      (l) => !l.upgrade && l.method !== "GET" && l.method !== "OPTIONS",
    );
    for (const b of bad) problems.push(`unexpected ${b.method} ${b.url}`);
    const d = await pixelDiff(
      join(leg, "receiver", "shots", "final.png"),
      join(out, "g8l", "tex", "receiver", "shots", "final.png"),
    );
    if (d === null)
      problems.push("the proxy leg's or the tex leg's final shot is missing");
    else if (d > 0)
      problems.push(`${d} px differ from the direct tex leg's final shot`);
    checks.push(
      check(
        "g8l-proxy-fronted",
        "G8g, D14: a receiver behind an HTTP reverse proxy (the WebSocket upgrade and every resource GET forwarded, Host rewritten) gets the direct leg's stream and pixels, with no wire change",
        absent(join(leg, "receiver")) || absent(join(leg, "host"))
          ? null
          : problems,
        `1 upgrade, ${gets.length} GETs, ${lines.filter((l) => l.method === "OPTIONS").length} preflights through port ${ports?.listen_port}; final shot equals tex's`,
      ),
    );
  }
  // CAR2 (carrier-design.md D10, F6): the lan leg is tex served on 0.0.0.0 under
  // GRC_LIVE_EXPOSE=lan, its receiver connected through this machine's non-loopback address with
  // the token. It exists only in a native run (run-gate8.sh run_g8l_lan); no directory, no check.
  // This is not a g8l fixture (the browsers' groups replay none), and it does not go through
  // gate1-live-checks.ts, whose `live-listening` asserts a loopback live.json address for gate
  // 1's own legs: exposure is recorded in live-carriers.json only, live.json keeps its shape.
  {
    const leg = join(out, "g8l", "lan");
    if (existsSync(leg)) {
      const unavailable = await readText(join(leg, "unavailable.txt"));
      if (unavailable !== undefined) {
        // A typed `unavailable` (no non-loopback address on the runner) is not a failure.
        report.lan = { status: "unavailable", reason: unavailable.trim() };
      } else {
        const host = join(leg, "host");
        const receiver = join(leg, "receiver");
        const problems: string[] = [];
        const address = (
          (await readText(join(leg, "lan-address.txt"))) ?? ""
        ).trim();
        report.lan = { status: "ran", address };
        const live = await readJson<Record<string, unknown>>(
          join(host, "evidence", "live.json"),
        );
        const carriers = await readJson<{
          expose?: string;
          carriers?: Array<{
            name?: string;
            address?: string | null;
            tls?: string;
            sessions?: number;
          }>;
        }>(join(host, "evidence", "live-carriers.json"));
        const hostPort = typeof live?.port === "number" ? live.port : null;
        if (live?.status !== "listening")
          problems.push(`live.json status ${JSON.stringify(live?.status)}`);
        if (live && "expose" in live)
          problems.push(
            "live.json carries an `expose` key (exposure belongs in live-carriers.json)",
          );
        if (carriers?.expose !== "lan")
          problems.push(
            `live-carriers.json expose ${JSON.stringify(carriers?.expose)}, expected "lan"`,
          );
        const ws = carriers?.carriers?.find((c) => c.name === "ws");
        if (ws?.address !== "0.0.0.0")
          problems.push(
            `ws carrier address ${JSON.stringify(ws?.address)}, expected "0.0.0.0"`,
          );
        if (ws?.tls !== "none")
          problems.push(
            `ws carrier tls ${JSON.stringify(ws?.tls)}, expected "none" (F6: plain ws on the LAN)`,
          );
        if (!existsSync(join(host, "evidence", "live-token")))
          problems.push(
            "no evidence/live-token (the lan leg requires GRC_LIVE_AUTH=token)",
          );
        const envTxt = (await readText(join(receiver, "env.txt"))) ?? "";
        const url = /^RS_RECEIVER_URL=(.*)$/m.exec(envTxt)?.[1] ?? "";
        const m = /^ws:\/\/([^:/]+):(\d+)\//.exec(url);
        if (!m)
          problems.push(
            `receiver URL ${JSON.stringify(url)} is not ws://<host>:<port>/`,
          );
        else {
          if (/^127\./.test(m[1]) || m[1] === "0.0.0.0" || m[1] === "localhost")
            problems.push(
              `the receiver connected through ${m[1]}, not a non-loopback address`,
            );
          if (m[1] !== address)
            problems.push(
              `the receiver connected to ${m[1]}, the leg's address is ${address}`,
            );
          if (hostPort !== null && Number(m[2]) !== hostPort)
            problems.push(
              `the receiver connected to port ${m[2]}, the host listened on ${hostPort}`,
            );
        }
        if (
          !existsSync(join(receiver, "env.txt")) ||
          !/RS_RECEIVER_TOKEN_FILE=/.test(envTxt)
        )
          problems.push("the receiver was given no token file");
        const applied = await readJson<Applied>(join(receiver, "applied.json"));
        if (!applied) problems.push("receiver applied.json missing");
        else problems.push(...failuresOf(applied));
        const code = await exitCode(receiver);
        if (code !== "0") problems.push(`receiver exit ${code ?? "missing"}`);
        const lanTap = await loadTap(receiver, 8);
        const texTap = await loadTap(join(out, "g8l", "tex", "receiver"), 8);
        if (lanTap.error) problems.push(`lan tap: ${lanTap.error}`);
        if (texTap.error) problems.push(`tex tap: ${texTap.error}`);
        // A live receiver's transaction count depends on coalescing (credit timing), so the
        // loopback leg is matched by its end state: the last frame and the final shot.
        if (lanTap.rec && lanTap.rec.transactions.length === 0)
          problems.push("the lan tap holds no transaction");
        if (lanTap.rec && texTap.rec) {
          const last = (r: { transactions: Array<{ frame: number }> }) =>
            r.transactions[r.transactions.length - 1]?.frame;
          if (last(lanTap.rec) !== last(texTap.rec))
            problems.push(
              `the last transaction is frame ${last(lanTap.rec)} over the LAN, ${last(texTap.rec)} over loopback`,
            );
        }
        const d = await pixelDiff(
          join(receiver, "shots", "final.png"),
          join(out, "g8l", "tex", "receiver", "shots", "final.png"),
        );
        if (d === null)
          problems.push("the lan leg's or the tex leg's final shot is missing");
        else if (d > 0)
          problems.push(
            `${d} px differ from the loopback tex leg's final shot`,
          );
        checks.push(
          check(
            "g8l-lan-served",
            "CAR2, D10, F6: tex served on 0.0.0.0 under GRC_LIVE_EXPOSE=lan (token and origins required) reaches a receiver through the machine's non-loopback address with the loopback leg's last frame and final pixels; the exposure is in live-carriers.json (ws, tls none), not live.json",
            absent(receiver) || absent(host) ? null : problems,
            `${lanTap.rec?.transactions.length ?? 0} transactions through ${address}:${hostPort}, final shot equals tex's`,
          ),
        );
      }
    }
  }
  // CAR6 (carrier-design.md, CAR6 row): fixtures/carrier-ext registers a GDScript carrier through
  // the capture's RenderStreamCarrier class and carries one live session over it. Native only
  // (run-gate8.sh run_g8l_ext); no g8l/ext directory, no check. The honest leg's peer kept exactly
  // the bytes the hub's tap holds for the connection that opened on that carrier; the sabotage
  // leg's peer drops its second binary message, which the same comparison must catch.
  {
    const honest = join(out, "g8l", "ext", "host");
    if (existsSync(join(out, "g8l", "ext"))) {
      const problems: string[] = [];
      const peer = await readJson<Record<string, unknown>>(
        join(honest, "peer", "peer.json"),
      );
      const carriers = await readJson<{
        carriers?: Array<{
          name?: string;
          index?: number;
          status?: string;
          sessions?: number;
          abi_version?: number | null;
          transport?: string | null;
          faults?: Record<string, unknown>;
        }>;
      }>(join(honest, "evidence", "live-carriers.json"));
      const want = (k: string, v: unknown) => {
        if (peer?.[k] !== v)
          problems.push(
            `peer.${k} ${JSON.stringify(peer?.[k])}, expected ${JSON.stringify(v)}`,
          );
      };
      if (!peer) problems.push("peer/peer.json missing");
      else {
        want("class", true);
        want("index", 2);
        want("duplicate", -1);
        want("unlisted_index", 3);
        want("unlisted_status", "destroyed");
        want("late", -1);
        if (!String(peer.late_error ?? "").startsWith("carrier-late"))
          problems.push(
            `peer.late_error ${JSON.stringify(peer.late_error)} does not start with carrier-late`,
          );
        want("opened", true);
        want("second_open", false);
        want("lookup_missing_bytes", 0);
        want("close_code", 1000);
        want("close_reason", "disarm");
        want("stopped", true);
        want("status_stopped", "stopped");
        if (!/librender_stream_capture\.so$/.test(String(peer.library_path ?? "")))
          problems.push(
            `peer.library_path ${JSON.stringify(peer.library_path)} does not end in librender_stream_capture.so`,
          );
        want("messages", 3);
      }
      const names = (carriers?.carriers ?? []).map((c) => c.name);
      const ws = carriers?.carriers?.find((c) => c.name === "ws");
      const gd = carriers?.carriers?.find((c) => c.name === "gdpeer");
      if (!carriers) problems.push("evidence/live-carriers.json missing");
      else {
        if (ws?.index !== 0)
          problems.push(`ws carrier index ${JSON.stringify(ws?.index)}, expected 0`);
        if (!gd) problems.push("no gdpeer entry in live-carriers.json");
        else {
          if (gd.index !== 2)
            problems.push(`gdpeer index ${gd.index}, expected 2`);
          if (gd.abi_version !== 1)
            problems.push(`gdpeer abi_version ${gd.abi_version}, expected 1`);
          if (gd.status !== "stopped")
            problems.push(`gdpeer status ${gd.status}, expected stopped`);
          if (gd.sessions !== 1)
            problems.push(`gdpeer sessions ${gd.sessions}, expected 1`);
          if (gd.transport !== null)
            problems.push(`gdpeer transport ${JSON.stringify(gd.transport)}, expected null`);
          if (Object.keys(gd.faults ?? {}).length > 0)
            problems.push(`gdpeer faults ${JSON.stringify(gd.faults)}`);
        }
        if (names.includes("gdunlisted"))
          problems.push("gdunlisted (registered, not in GRC_LIVE_CARRIERS) is listed");
      }
      const bytes = await extCarrierBytes(honest, "gdpeer");
      problems.push(...bytes.problems);
      checks.push(
        check(
          "g8l-ext-carried",
          "CAR6: a GDScript carrier registered through RenderStreamCarrier carries one live session: the registration contract (index 2, duplicate and late refused, an unlisted carrier destroyed), the lifecycle (opened once, a second connection refused, close 1000 disarm, stopped), live-carriers.json (gdpeer abi 1, one session, no faults, no gdunlisted), and the bytes the peer kept equal the hub's tap of the connection that opened on gdpeer",
          absent(honest) ? null : problems,
          `${bytes.peerBytes} bytes identical to the tap, ${peer?.messages ?? "?"} messages, gdpeer at index ${gd?.index}`,
        ),
      );
      const sab = join(out, "g8l", "ext", "sabotage-drop-one");
      const sabBytes = await extCarrierBytes(sab, "gdpeer");
      const identical = sabBytes.problems.length === 0;
      const sabProblems: string[] = [];
      if (identical)
        sabProblems.push(
          "the byte comparison passed on a peer that dropped a message (the check is blind)",
        );
      else if (
        sabBytes.problems.some((x) => /missing|no tap connection/.test(x))
      )
        sabProblems.push(...sabBytes.problems);
      checks.push(
        check(
          "g8l-ext-sabotage-drop-one",
          "CAR6 sabotage: the same peer-to-tap byte comparison fails when the peer drops its second binary message",
          absent(sab) ? null : sabProblems,
          `the comparison failed as it must: ${sabBytes.problems[0] ?? ""}`,
        ),
      );
    }
  }
  // TRK2 (tracks-design.md, TRK2 row): fixtures/track-input's RenderStreamTrack receiver and the
  // reference injector under the track client, plus four sabotage legs (lib/gate8-track-checks.ts).
  // Native only (run-gate8.sh run_g8l_trk); no g8l/trk directory, no check.
  checks.push(...(await runTrkChecks(out)));
  // CAR4 (carrier-design.md D11, D12): the wss leg is tex with a certificate pair, its receiver
  // on plain ws from loopback (still served under a pair), and `openssl s_client` over TLS on the
  // same port while the host ran (run-gate8.sh run_g8l_wss). Native only; no directory, no check.
  {
    const leg = join(out, "g8l", "wss");
    if (existsSync(leg)) {
      const unavailable = await readText(join(leg, "unavailable.txt"));
      if (unavailable !== undefined) {
        report.wss = { status: "unavailable", reason: unavailable.trim() };
      } else {
        const host = join(leg, "host");
        const receiver = join(leg, "receiver");
        const problems: string[] = [];
        const want = (
          (await readText(join(leg, "cert-sha256.txt"))) ?? ""
        ).trim();
        const live = await readJson<Record<string, unknown>>(
          join(host, "evidence", "live.json"),
        );
        const carriers = await readJson<{
          carriers?: Array<{
            name?: string;
            tls?: string;
            cert_sha256?: string | null;
            address?: string | null;
          }>;
        }>(join(host, "evidence", "live-carriers.json"));
        const hostPort = typeof live?.port === "number" ? live.port : null;
        if (live?.status !== "listening")
          problems.push(`live.json status ${JSON.stringify(live?.status)}`);
        const ws = carriers?.carriers?.find((c) => c.name === "ws");
        if (ws?.tls !== "consumer")
          problems.push(
            `ws carrier tls ${JSON.stringify(ws?.tls)}, expected "consumer" (a pair is set)`,
          );
        if (!/^[0-9a-f]{64}$/.test(want) || ws?.cert_sha256 !== want)
          problems.push(
            `ws carrier cert_sha256 ${JSON.stringify(ws?.cert_sha256)}, the leg's certificate is ${want}`,
          );
        if (carriers?.carriers?.some((c) => c.name === "wt"))
          problems.push(
            "a wt carrier started (the pair alone must load the module for ws, not wt)",
          );
        const sc = (await readText(join(leg, "s_client.txt"))) ?? "";
        if (!/TLSv1\.3/.test(sc))
          problems.push("s_client did not negotiate TLS 1.3 on the live port");
        if (!/Verify return code: 0 \(ok\)/.test(sc))
          problems.push("s_client did not verify the leg's certificate");
        if (!/ALPN protocol: http\/1\.1/.test(sc))
          problems.push("s_client got no ALPN http/1.1");
        if (!/HTTP\/1\.1 404 /.test(sc))
          problems.push(
            "no HTTP response over TLS (expected 404 for the probe path)",
          );
        const envTxt = (await readText(join(receiver, "env.txt"))) ?? "";
        const url = /^RS_RECEIVER_URL=(.*)$/m.exec(envTxt)?.[1] ?? "";
        if (
          hostPort === null ||
          url !== `ws://127.0.0.1:${hostPort}/render-stream`
        )
          problems.push(
            `receiver URL ${JSON.stringify(url)}, expected plain ws to 127.0.0.1:${hostPort}`,
          );
        const applied = await readJson<Applied>(join(receiver, "applied.json"));
        if (!applied) problems.push("receiver applied.json missing");
        else problems.push(...failuresOf(applied));
        const code = await exitCode(receiver);
        if (code !== "0") problems.push(`receiver exit ${code ?? "missing"}`);
        const wssTap = await loadTap(receiver, 8);
        const texTap = await loadTap(join(out, "g8l", "tex", "receiver"), 8);
        if (wssTap.error) problems.push(`wss tap: ${wssTap.error}`);
        if (texTap.error) problems.push(`tex tap: ${texTap.error}`);
        if (wssTap.rec && wssTap.rec.transactions.length === 0)
          problems.push("the wss leg's tap holds no transaction");
        if (wssTap.rec && texTap.rec) {
          const last = (r: { transactions: Array<{ frame: number }> }) =>
            r.transactions[r.transactions.length - 1]?.frame;
          if (last(wssTap.rec) !== last(texTap.rec))
            problems.push(
              `the last transaction is frame ${last(wssTap.rec)} here, ${last(texTap.rec)} on the tex leg`,
            );
        }
        const d = await pixelDiff(
          join(receiver, "shots", "final.png"),
          join(out, "g8l", "tex", "receiver", "shots", "final.png"),
        );
        if (d === null)
          problems.push("the wss leg's or the tex leg's final shot is missing");
        else if (d > 0)
          problems.push(`${d} px differ from the tex leg's final shot`);
        report.wss = { status: "ran", port: hostPort, cert_sha256: want };
        checks.push(
          check(
            "g8l-wss-served",
            "CAR4, D11, D12: tex with GRC_LIVE_TLS_CERT/KEY loads the net module for ws alone (live-carriers.json ws tls consumer, the certificate's SHA-256), the same port speaks TLS 1.3 with that certificate and HTTP over it (openssl s_client), and a plaintext receiver from loopback still gets the tex leg's last frame and final pixels",
            absent(receiver) || absent(host) ? null : problems,
            `${wssTap.rec?.transactions.length ?? 0} transactions over ws on a ws+wss port ${hostPort}; s_client TLS 1.3 verified`,
          ),
        );
      }
    }
  }
  return { checks, report };
}
