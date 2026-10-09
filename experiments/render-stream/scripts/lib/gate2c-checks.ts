// Gate 2 group g2c (G2c2): live resources over HTTP -- live hosts serving texture payloads by hash
// with pins and retirement, live receivers fetching before they apply, and the unpin,
// drop-resource and live wrong-hash sabotages, each leg classified with gate2-design.md Q7's
// precedence (protocol/gate2-design.md "G2c2").
//
// Everything here reads an evidence directory written by run-gate2.sh, or is pure over values
// already read from one, so scripts/test/self-test-gate2.ts can drive the pure parts with
// fabricated inputs. Nothing launches a process, and classification never reads
// `session.sabotage`.
//
// Evidence layout under <out>/ for g2c (besides g2a's reference, see gate2-checks.ts):
//   <leg>/host/       a live host on the live timeline (S=300, N=60, quit 971): recording.rs2,
//                     recording-patch.rs2, store/, steps.jsonl, textures.jsonl, evidence/{result,
//                     live,live-summary}.json, evidence/resources.jsonl (with the serving lines
//                     pin / retire / http-get), tap/stream-<n>.rs2, tap/live-<n>.jsonl
//   <leg>/receiver/   its live receiver: applied.json (render-stream-receiver-applied/3, fetches
//                     with source http), received.rs2 (received-2.rs2 after a reconnect), cache/,
//                     shots/seq-<n>.png (stream-2-seq-<n>.png), state/
//   live-replay/      a rendered file-mode receiver on live/receiver/received.rs2 with
//                     live/receiver/cache as its store
// Legs: live, live-warm (its receiver uses live/receiver/cache, mode warm), live-headless,
// live-stall, live-reconnect, live-animate (RS_FIXTURE_VARIANT=animate), sabotage-unpin,
// sabotage-drop-resource, sabotage-wrong-hash-live; and live-replay.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  decodePngRgba,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import { diffRgba, readExitCode } from "./gate0-checks";
import { parseEnvTxt } from "./gate1-g1d-checks";
import {
  deliveryReasons,
  deliveryReport,
  type LiveConnectionSummary,
  type LiveHostEvidence,
  type LiveLogLine,
  loadLiveHost,
  tapErrors,
} from "./gate1-live-checks";
import {
  type Gate2Expected,
  gate2Regions,
  synthesizeGate2,
} from "./gate2-expected";
import {
  type Applied3,
  checkLegClass,
  type FixtureLine,
  G2B_PRECEDENCE,
  type G2bCheck,
  type G2bClass,
  type G2bClassification,
  type G2bLegExpectation,
  type HookLine,
  loadFixtureLines,
  loadHookLines,
  loadResolved,
  type ReceiverEvidence,
  type Resolved,
  receiverResourceViolations,
  TRAFFIC_COUNTERS,
  textureIdsByName,
  textureLogDivergence,
} from "./gate2b-checks";
import type { ResolvedTransaction } from "./render-stream-2";
import { statesEqual } from "./render-stream-2";

// ---------------------------------------------------------------------------------------------
// The live timeline and the legs
// ---------------------------------------------------------------------------------------------

/** The budget a host runs with unless its env.txt sets GRC_RESOURCE_BUDGET_BYTES. */
export const DEFAULT_BUDGET_BYTES = 536870912;
export const CACHE_CONTROL = "private, max-age=31536000, immutable";

/** A host's timeline, from its own steps.jsonl (run-gate2.sh runs S = 300, N = 60, quit 971): step
 * -> {applied, settle}, and the quit frame (its full recording's last frame). */
export interface LiveTimeline {
  steps: Map<number, { applied: number; settle: number }>;
  quit: number;
}

export function liveStepFrame(t: LiveTimeline, step: number): number {
  return t.steps.get(step)?.applied ?? Number.NaN;
}

/** A live step's window [applied, next applied - 1] (the last through the quit frame). */
export function liveStepWindow(
  t: LiveTimeline,
  step: number,
): [number, number] {
  const next = t.steps.get(step + 1);
  return [liveStepFrame(t, step), next ? next.applied - 1 : t.quit];
}

export const G2C_LEGS: readonly G2bLegExpectation[] = [
  { leg: "live", expected_class: "success" },
  { leg: "live-warm", expected_class: "success" },
  { leg: "live-replay", expected_class: "success" },
  { leg: "live-headless", expected_class: "success" },
  { leg: "live-stall", expected_class: "success" },
  { leg: "live-reconnect", expected_class: "success" },
  { leg: "live-animate", expected_class: "success" },
  {
    leg: "sabotage-unpin",
    expected_class: "replay-failure",
    reason: "resource-unavailable",
  },
  {
    leg: "sabotage-drop-resource",
    expected_class: "replay-failure",
    reason: "resource-unavailable",
  },
  {
    leg: "sabotage-wrong-hash-live",
    expected_class: "replay-failure",
    reason: "resource-hash-mismatch",
  },
];

/** Legs with a live host of their own. */
export const G2C_HOST_LEGS: readonly string[] = G2C_LEGS.map(
  (l) => l.leg,
).filter((l) => l !== "live-replay");
/** Live legs whose receiver is rendered (shot windows, credit stage submitted). */
export const G2C_RENDERED: ReadonlySet<string> = new Set([
  "live",
  "live-warm",
  "live-stall",
  "live-reconnect",
  "live-animate",
  "sabotage-unpin",
]);
/** The legs that must succeed and whose hosts the capture-side checks cover. */
export const G2C_GOOD: readonly string[] = [
  "live",
  "live-warm",
  "live-headless",
  "live-stall",
  "live-reconnect",
  "live-animate",
];
/** Legs whose fixture is the main variant (the transform-only windows are quiet). */
export const G2C_MAIN_VARIANT: readonly string[] = [
  "live",
  "live-warm",
  "live-headless",
  "live-stall",
  "live-reconnect",
];

function check(
  id: string,
  criterion: string,
  problems: string[],
  okDetail: string,
  evidence: string[],
): G2bCheck {
  return {
    id,
    criterion,
    passed: problems.length === 0,
    status: problems.length === 0 ? "pass" : "fail",
    detail:
      problems.length === 0
        ? okDetail
        : `${problems.slice(0, 8).join("; ")}${problems.length > 8 ? ` (+${problems.length - 8} more)` : ""}`,
    evidence,
  };
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

/** A fetch of applied.json (render-stream-receiver-applied/3; G2c2 adds the http fields). */
export interface G2cFetch {
  stream?: number;
  seq?: number;
  hash?: string;
  source?: string;
  status?: number | null;
  bytes?: number;
  start_us?: number;
  end_us?: number;
  verified?: boolean;
  delay_us?: number;
  headers?: Record<string, string>;
}

export interface G2cTransaction {
  stream?: number;
  seq?: number;
  frame?: number;
  encoding?: string;
  record_sha256?: string;
  received_us?: number | null;
  applied_us?: number | null;
  submitted_us?: number | null;
  skipped?: string | null;
  resources?: Record<string, number> | null;
}

export interface G2cApplied {
  schema?: string;
  mode?: string;
  status?: string;
  failure?: { seq: number | null; reason: string; detail?: string } | null;
  end_seen?: boolean;
  streams?: Array<{
    connection?: number | null;
    received_path?: string;
    received_sha256?: string | null;
    received_bytes?: number;
    end_seen?: boolean;
    closed_by?: string | null;
  }>;
  transactions?: G2cTransaction[];
  shots?: Array<{ stream?: number; seq?: number; step?: number | null }>;
  shots_missed?: number[];
  cache?: Applied3["cache"];
  fetches?: G2cFetch[];
  uploads?: Applied3["uploads"];
  resources_summary?: Applied3["resources_summary"];
  live?: {
    credit_stage?: string;
    presented?: string;
    acks_sent?: { received?: number; applied?: number; submitted?: number };
    stall?: { step?: number; after_seq?: number; after_frame?: number } | null;
    reconnect?: { step?: number; after_seq?: number } | null;
  } | null;
}

/** The host's serving summary (live-summary.json `resources`, G2c2). */
export interface ServingSummary {
  http_gets?: number;
  http_bytes?: number;
  http_errors?: number;
  pinned?: number;
  retired?: number;
  retired_unpinned?: number;
  retained_max?: number;
  retained_bytes_max?: number;
  retained_end?: number;
  retained_bytes_end?: number;
  budget_bytes?: number;
  dropped_hash?: string | null;
  corrupted_hash?: string | null;
}

export interface G2cConnection {
  n: number;
  /** gate 1's per-connection view (tap, live log, full and patch as RecordingSummary) */
  host: LiveHostEvidence;
  tap: Resolved;
  summary: LiveConnectionSummary | undefined;
  /** the receiver's received stream for this connection (null: no receiver file) */
  received: Resolved | null;
}

export interface G2cHost {
  dir: string;
  full: Resolved;
  patch: Resolved;
  hook: { path: string; lines: HookLine[]; problem: string | null };
  fixture: FixtureLine[];
  env: Map<string, string>;
  timeline: LiveTimeline;
  serving: ServingSummary | undefined;
  connections: G2cConnection[];
  exit: number | null;
}

export interface G2cLegEvidence {
  leg: string;
  rendered: boolean;
  /** the live host this leg talked to (live-replay: live's) */
  host: G2cHost | null;
  receiverDir: string;
  applied: G2cApplied | undefined;
  /** live-replay: its recording copy */
  replayed: Resolved | null;
  log: string;
  exit: number | null;
}

async function loadHost(dir: string): Promise<G2cHost> {
  const summary = await readJson<{
    connections?: Array<{ connection?: number }>;
    resources?: ServingSummary;
  }>(join(dir, "evidence", "live-summary.json"));
  const numbers = (summary?.connections ?? [])
    .map((c) => c.connection)
    .filter((n): n is number => Number.isInteger(n));
  if (numbers.length === 0) numbers.push(1);
  const connections: G2cConnection[] = [];
  for (const n of numbers) {
    const host = await loadLiveHost(dir, n);
    connections.push({
      n,
      host,
      tap: await loadResolved(join(dir, "tap", `stream-${n}.rs2`)),
      summary: host.summary?.connections?.find((c) => c.connection === n),
      received: null,
    });
  }
  const full = await loadResolved(join(dir, "recording.rs2"));
  const fullTx = full.recording?.transactions ?? [];
  const timeline: LiveTimeline = {
    steps: new Map(
      (connections[0]?.host.steps ?? []).map((s) => [
        s.step,
        { applied: s.applied_frame, settle: s.settle_frame },
      ]),
    ),
    quit: fullTx.length > 0 ? fullTx[fullTx.length - 1].frame : 0,
  };
  return {
    dir,
    full,
    timeline,
    patch: await loadResolved(join(dir, "recording-patch.rs2")),
    hook: await loadHookLines(dir),
    fixture: await loadFixtureLines(dir),
    env: parseEnvTxt(await readTextOrUndefined(join(dir, "env.txt"))),
    serving: summary?.resources,
    connections,
    exit: await readExitCode(dir),
  };
}

export async function loadG2cLeg(
  outDir: string,
  leg: string,
  hosts: Map<string, G2cHost>,
): Promise<G2cLegEvidence> {
  const hostLeg = leg === "live-replay" ? "live" : leg;
  let host = hosts.get(hostLeg) ?? null;
  if (!host) {
    host = await loadHost(join(outDir, hostLeg, "host"));
    hosts.set(hostLeg, host);
  }
  const receiverDir =
    leg === "live-replay" ? join(outDir, leg) : join(outDir, leg, "receiver");
  const applied = await readJson<G2cApplied>(join(receiverDir, "applied.json"));
  let replayed: Resolved | null = null;
  if (leg === "live-replay") {
    replayed = await loadResolved(join(receiverDir, "recording.rs2"));
  } else {
    for (const c of host.connections) {
      const name = c.n === 1 ? "received.rs2" : `received-${c.n}.rs2`;
      const r = await loadResolved(join(receiverDir, name));
      c.received = r.present ? r : null;
    }
  }
  return {
    leg,
    rendered: G2C_RENDERED.has(leg) || leg === "live-replay",
    host,
    receiverDir,
    applied:
      applied && typeof applied === "object"
        ? (applied as G2cApplied)
        : undefined,
    replayed,
    log: (await readTextOrUndefined(join(receiverDir, "stdout.log"))) ?? "",
    exit: await readExitCode(receiverDir),
  };
}

/** gate2b's ReceiverEvidence for a live receiver (receiverResourceViolations). */
export function asReceiverEvidence(e: G2cLegEvidence): ReceiverEvidence {
  return {
    leg: e.leg,
    dir: e.receiverDir,
    applied: e.applied as Applied3 | undefined,
    capture: null,
    settle: new Map(),
    log: e.log,
    exit: e.exit,
  };
}

// ---------------------------------------------------------------------------------------------
// Pure helpers over the evidence
// ---------------------------------------------------------------------------------------------

/** The `ok` image hashes of a resolved state (exactly the payloads a snapshot holds). */
export function okImageHashes(t: ResolvedTransaction | undefined): Set<string> {
  const out = new Set<string>();
  for (const e of t?.state.textures ?? [])
    if (e.kind === "image" && e.status === "ok" && e.hash) out.add(e.hash);
  return out;
}

/** Every hash a transaction's table names (any status), for gets-advertised. */
export function tableHashes(t: ResolvedTransaction): Set<string> {
  const out = new Set<string>();
  for (const e of t.state.textures) if (e.hash) out.add(e.hash);
  return out;
}

/** The serving lines of a hook log, in order. */
export function servingLines(lines: readonly HookLine[]): HookLine[] {
  return lines.filter(
    (l) => l.op === "pin" || l.op === "retire" || l.op === "http-get",
  );
}

export function httpGets(lines: readonly HookLine[]): HookLine[] {
  return lines.filter((l) => l.op === "http-get");
}

/** The frame a connection closed at (its live log's close event), or null while open. */
export function closeFrame(
  log: readonly LiveLogLine[] | undefined,
): number | null {
  const c = (log ?? []).find((l) => l.event === "close");
  return c ? c.frame : null;
}

/** One connection's sends, from its tap (resolved) in order, with their frames. */
export interface ConnTimeline {
  n: number;
  sends: ResolvedTransaction[];
  closed: number | null;
}

export function connTimelines(host: G2cHost): ConnTimeline[] {
  return host.connections.map((c) => ({
    n: c.n,
    sends: c.tap.recording?.transactions ?? [],
    closed: closeFrame(c.host.log),
  }));
}

/** The base (last transaction sent) of a connection after the callback at `frame`, or null when
 * it has sent nothing yet or is closed by then. */
export function baseAt(
  c: ConnTimeline,
  frame: number,
): ResolvedTransaction | null {
  if (c.closed !== null && frame >= c.closed) return null;
  let base: ResolvedTransaction | null = null;
  for (const t of c.sends) {
    if (t.frame > frame) break;
    base = t;
  }
  return base;
}

export interface PinsReport {
  frames_compared: number;
  first_frame: number | null;
  last_frame: number | null;
  /** frames where a hash that must be servable was not (pins-bounded) */
  missing: string[];
  /** frames where a hash neither current nor named by a base was still servable */
  late: string[];
  /** retire lines at a frame where the hash was still current or a base's */
  early: string[];
  over_budget: string[];
  retained_max: number;
  retained_bytes_max: number;
  budget: number;
  pins: number;
  retirements: number;
}

/**
 * Replays the host's pin and retire lines frame by frame and compares the servable set after
 * each frame callback with what D7 says it must be: the full recording's state at that frame
 * (the mirror's payloads) united with every open connection's base (its last tapped transaction).
 * Pure.
 */
export function pinsReport(
  hookLines: readonly HookLine[],
  full: readonly ResolvedTransaction[],
  conns: readonly ConnTimeline[],
  budget: number,
): PinsReport {
  const out: PinsReport = {
    frames_compared: 0,
    first_frame: null,
    last_frame: null,
    missing: [],
    late: [],
    early: [],
    over_budget: [],
    retained_max: 0,
    retained_bytes_max: 0,
    budget,
    pins: 0,
    retirements: 0,
  };
  const serving = servingLines(hookLines).filter((l) => l.op !== "http-get");
  if (serving.length === 0) return out;
  const byFrame = new Map(full.map((t) => [t.frame, t]));
  const retained = new Map<string, number>();
  let k = 0;
  const firstFrame = serving[0].frame;
  const lastFrame = full.length > 0 ? full[full.length - 1].frame : firstFrame;
  out.first_frame = firstFrame;
  out.last_frame = lastFrame;
  for (let f = firstFrame; f <= lastFrame; f++) {
    const expected = new Set(okImageHashes(byFrame.get(f)));
    for (const c of conns) {
      const base = baseAt(c, f);
      if (base) for (const h of okImageHashes(base)) expected.add(h);
    }
    while (k < serving.length && serving[k].frame === f) {
      const l = serving[k++];
      const h = l.hash ?? "";
      if (l.op === "pin") {
        out.pins++;
        retained.set(h, l.payload_bytes ?? 0);
      } else {
        out.retirements++;
        retained.delete(h);
        if (expected.has(h) && out.early.length < 8)
          out.early.push(
            `frame ${f}: ${h.slice(0, 12)} retired while still named`,
          );
      }
    }
    if (!byFrame.has(f)) continue;
    out.frames_compared++;
    let bytes = 0;
    for (const v of retained.values()) bytes += v;
    out.retained_max = Math.max(out.retained_max, retained.size);
    out.retained_bytes_max = Math.max(out.retained_bytes_max, bytes);
    if (bytes > budget && out.over_budget.length < 4)
      out.over_budget.push(`frame ${f}: ${bytes} > ${budget}`);
    for (const h of expected)
      if (!retained.has(h) && out.missing.length < 8)
        out.missing.push(`frame ${f}: ${h.slice(0, 12)} must be servable`);
    for (const h of retained.keys())
      if (!expected.has(h) && out.late.length < 8)
        out.late.push(
          `frame ${f}: ${h.slice(0, 12)} is servable, named by nothing`,
        );
  }
  // Lines after the last compared frame (the host stops serving at the end) are not compared.
  return out;
}

/** gets-advertised (pure): every GET names a hash of a transaction sent on its connection at an
 * earlier frame callback. */
export function unadvertisedGets(
  gets: readonly HookLine[],
  conns: readonly ConnTimeline[],
): string[] {
  const out: string[] = [];
  for (const g of gets) {
    const c = conns.find((x) => x.n === g.conn);
    if (!c) {
      out.push(
        `GET ${g.hash?.slice(0, 12)} at frame ${g.frame} has no streaming connection`,
      );
      continue;
    }
    const sent = c.sends.filter((t) => t.frame < g.frame);
    if (!g.hash || !sent.some((t) => tableHashes(t).has(g.hash as string)))
      out.push(
        `GET ${g.hash?.slice(0, 12) ?? "<malformed>"} at frame ${g.frame} on connection ${g.conn}: no earlier transaction on it names that hash`,
      );
  }
  return out;
}

/** http-gets-match-fetches (pure): the host's GETs and the receiver's http fetches, in order. */
export function getsVsFetches(
  gets: readonly HookLine[],
  fetches: readonly G2cFetch[],
): string[] {
  const out: string[] = [];
  const http = fetches.filter((f) => f.source === "http");
  if (gets.length !== http.length)
    out.push(`${gets.length} GETs on the host, ${http.length} http fetches`);
  for (let i = 0; i < Math.min(gets.length, http.length); i++) {
    const g = gets[i];
    const f = http[i];
    if (g.hash !== f.hash || g.http_status !== f.status)
      out.push(
        `#${i}: host GET ${g.hash?.slice(0, 12)} ${g.http_status}, receiver ${f.hash?.slice(0, 12)} ${f.status}`,
      );
    else if ((g.payload_bytes ?? 0) !== (f.bytes ?? -1))
      out.push(
        `#${i}: host sent ${g.payload_bytes} B, receiver read ${f.bytes} B`,
      );
  }
  const seen = new Map<string, number>();
  for (const f of http)
    seen.set(f.hash ?? "", (seen.get(f.hash ?? "") ?? 0) + 1);
  for (const [h, n] of seen)
    if (n > 1) out.push(`${h.slice(0, 12)} fetched ${n} times in one process`);
  for (const f of http) {
    const h = f.headers ?? {};
    if (f.status !== 200) {
      out.push(`${f.hash?.slice(0, 12)}: HTTP ${f.status}`);
      continue;
    }
    if (f.verified !== true) out.push(`${f.hash?.slice(0, 12)}: not verified`);
    if (h["Content-Type"] !== "application/octet-stream")
      out.push(`${f.hash?.slice(0, 12)}: Content-Type ${h["Content-Type"]}`);
    if (h["Cache-Control"] !== CACHE_CONTROL)
      out.push(`${f.hash?.slice(0, 12)}: Cache-Control ${h["Cache-Control"]}`);
    if (h.ETag !== `"${f.hash}"`)
      out.push(`${f.hash?.slice(0, 12)}: ETag ${h.ETag}`);
    if (h["Content-Length"] !== String(f.bytes))
      out.push(
        `${f.hash?.slice(0, 12)}: Content-Length ${h["Content-Length"]} for ${f.bytes} B`,
      );
  }
  return out;
}

/** fetch-before-applied (pure, receiver clock): every fetch for (stream, seq) ended before that
 * transaction's applied ack; a transaction that was never applied is the run's failure. */
export function fetchesAfterApplied(a: G2cApplied | undefined): string[] {
  const out: string[] = [];
  const tx = new Map(
    (a?.transactions ?? []).map((t) => [`${t.stream ?? 1}:${t.seq}`, t]),
  );
  for (const f of a?.fetches ?? []) {
    if (f.source !== "http") continue;
    const t = tx.get(`${f.stream ?? 1}:${f.seq}`);
    const applied = t?.applied_us;
    if (typeof applied !== "number") {
      if (a?.failure?.seq !== f.seq)
        out.push(
          `fetch ${f.hash?.slice(0, 12)} for seq ${f.seq}: that seq was never applied`,
        );
      continue;
    }
    if ((f.end_us ?? Number.POSITIVE_INFINITY) > applied)
      out.push(
        `fetch ${f.hash?.slice(0, 12)} for seq ${f.seq} ended at ${f.end_us}, after the applied ack at ${applied}`,
      );
  }
  return out;
}

/** Nearest-rank percentile of a sample set (null when empty). */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1];
}

// ---------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------

export interface G2cCheckpoint {
  leg: string;
  step: number;
  stream: number;
  seq: number | null;
  frame: number | null;
  shot: string;
  reference: string;
  mismatched_pixels: number | null;
  /** live-animate: the anim region against synthesizeGate2 at the shot's frame */
  anim_mismatched: number | null;
}

export function shotName(stream: number, seq: number): string {
  return stream > 1 ? `stream-${stream}-seq-${seq}.png` : `seq-${seq}.png`;
}

/** Each step's shot (stream, seq, frame) of a live receiver: the first shot per step. */
export function stepShots(
  a: G2cApplied | undefined,
): Map<number, { stream: number; seq: number; frame: number | null }> {
  const out = new Map<
    number,
    { stream: number; seq: number; frame: number | null }
  >();
  const frames = new Map(
    (a?.transactions ?? []).map((t) => [`${t.stream ?? 1}:${t.seq}`, t.frame]),
  );
  for (const s of a?.shots ?? []) {
    if (!Number.isInteger(s.step) || !Number.isInteger(s.seq)) continue;
    if (out.has(s.step as number)) continue;
    const stream = s.stream ?? 1;
    out.set(s.step as number, {
      stream,
      seq: s.seq as number,
      frame: frames.get(`${stream}:${s.seq}`) ?? null,
    });
  }
  return out;
}

/** Shots against the reference's step shots: full frame exact, except that under the animate
 * variant the anim region is compared with synthesizeGate2 at the shot's frame instead. */
export async function liveCheckpoints(
  expected: Gate2Expected,
  e: G2cLegEvidence,
  referenceDir: string,
  animate: boolean,
): Promise<G2cCheckpoint[]> {
  const out: G2cCheckpoint[] = [];
  const shots = stepShots(e.applied);
  for (const s of expected.steps) {
    const at = shots.get(s.step);
    const cp: G2cCheckpoint = {
      leg: e.leg,
      step: s.step,
      stream: at?.stream ?? 1,
      seq: at?.seq ?? null,
      frame: at?.frame ?? null,
      shot: at ? join(e.receiverDir, "shots", shotName(at.stream, at.seq)) : "",
      reference: join(referenceDir, "shots", `step-${s.step}.png`),
      mismatched_pixels: null,
      anim_mismatched: null,
    };
    out.push(cp);
    if (!at) continue;
    const ref = await decodePngRgba(cp.reference);
    const got = await decodePngRgba(cp.shot);
    if (!ref || !got || ref.width !== got.width || ref.height !== got.height)
      continue;
    if (!animate) {
      cp.mismatched_pixels = diffRgba(
        ref.data,
        got.data,
        ref.width,
        ref.height,
      ).mismatched_pixels;
      continue;
    }
    const anim = gate2Regions(expected, s.step, "animate").anim;
    // Outside the anim region: the reference; inside: the synthesized frame at the shot's frame.
    const masked = Uint8Array.from(ref.data);
    if (cp.frame !== null && anim) {
      const synth = synthesizeGate2(expected, s.step, {
        variant: "animate",
        frame: cp.frame,
      });
      const [x0, y0, w, h] = anim;
      for (let y = y0; y < y0 + h; y++)
        for (let x = x0; x < x0 + w; x++) {
          const i = (y * ref.width + x) * 4;
          masked.set(synth.rgba.subarray(i, i + 4), i);
        }
      cp.anim_mismatched = diffRgba(
        masked,
        got.data,
        ref.width,
        ref.height,
        anim,
      ).mismatched_pixels;
    }
    cp.mismatched_pixels = diffRgba(
      masked,
      got.data,
      ref.width,
      ref.height,
    ).mismatched_pixels;
  }
  return out;
}

export function checkpointMismatching(cps: readonly G2cCheckpoint[]): number[] {
  return cps
    .filter((c) => c.mismatched_pixels === null || c.mismatched_pixels > 0)
    .map((c) => c.step);
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

/** null when the received stream is the tap byte for byte; "prefix" when it is shorter and the
 * receiver closed that connection itself before the end record (checked byte-wise by the
 * caller); otherwise why not. */
function sameBytesOrPrefix(
  received: Resolved | null,
  tap: Resolved,
  closedByReceiverEarly: boolean,
): string | null {
  if (!received) return "no received stream";
  if (!tap.present) return "no tap";
  if (received.sha256 === tap.sha256) return null;
  if (closedByReceiverEarly && received.bytes < tap.bytes) return "prefix";
  return `received ${received.bytes} B (${received.sha256?.slice(0, 12)}) differs from the tap's ${tap.bytes} B (${tap.sha256?.slice(0, 12)})`;
}

async function isPrefix(
  receivedPath: string,
  tapPath: string,
): Promise<boolean> {
  try {
    const a = new Uint8Array(await readFile(receivedPath));
    const b = new Uint8Array(await readFile(tapPath));
    if (a.length > b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  } catch {
    return false;
  }
}

export interface G2cEvaluation {
  e: G2cLegEvidence;
  checkpoints: G2cCheckpoint[];
  classification: G2bClassification;
}

export async function classifyG2cLeg(
  e: G2cLegEvidence,
  expected: Gate2Expected,
  referenceDir: string,
  warmHashes: ReadonlySet<string> | null,
  liveShots: Map<number, { stream: number; seq: number; frame: number | null }>,
): Promise<G2cEvaluation> {
  const fired = new Map<G2bClass, string[]>();
  const fire = (cls: G2bClass, reason: string) =>
    fired.set(cls, [...(fired.get(cls) ?? []), `${cls}: ${reason}`]);
  const host = e.host;
  // 1. capture-failure
  if (!host) fire("capture-failure", "no live host evidence");
  else {
    const c0 = host.connections[0]?.host;
    const res = c0?.captureResult;
    if (
      res?.status !== "armed" ||
      res?.stream?.status !== "closed" ||
      res?.stream?.reason
    )
      fire(
        "capture-failure",
        `host status ${res?.status} stream ${res?.stream?.status} ${res?.stream?.reason ?? ""}`,
      );
    if (c0?.live?.status !== "listening")
      fire(
        "capture-failure",
        `the live listener is ${JSON.stringify(c0?.live?.status ?? null)}`,
      );
    for (const r of [host.full, host.patch])
      if (r.errors.length > 0)
        fire("capture-failure", `${r.path}: ${r.errors[0]}`);
    if (host.full.recording && !host.hook.problem) {
      const d = textureLogDivergence(host.hook.lines, host.full.recording);
      if (d.length > 0)
        fire("capture-failure", `texture-log-divergence: ${d[0]}`);
    } else if (host.hook.problem)
      fire("capture-failure", `resources.jsonl ${host.hook.problem}`);
    if (e.leg !== "live-replay")
      for (const c of host.connections) {
        const errs = tapErrors(c.host);
        if (!c.tap.present)
          fire("capture-failure", `tap/stream-${c.n}.rs2 missing`);
        else if (errs.length > 0)
          fire("capture-failure", `tap/stream-${c.n}.rs2 invalid: ${errs[0]}`);
      }
  }
  // 2. unsupported
  const streams =
    e.leg === "live-replay"
      ? [e.replayed]
      : (host?.connections ?? []).map((c) => c.received);
  for (const r of streams)
    for (const t of r?.recording?.transactions ?? [])
      if (t.state.unsupported.length > 0) {
        fire(
          "unsupported",
          `seq ${t.seq}: ${t.state.unsupported.map((u) => `${u.op}/${u.reason}`).join(",")}`,
        );
        break;
      }
  // 3. replay-failure
  const a = e.applied;
  if (!a) fire("replay-failure", "applied.json missing or unparseable");
  else {
    if (a.status !== "ok")
      fire(
        "replay-failure",
        `status=${a.status} failure=${JSON.stringify(a.failure ?? null)}`,
      );
    if (a.end_seen !== true) fire("replay-failure", "end_seen is not true");
  }
  if (e.leg === "live-replay") {
    const r = e.replayed;
    if (!r?.present) fire("replay-failure", "no recording copy");
    else if (r.errors.length > 0)
      fire("replay-failure", `the replayed stream: ${r.errors[0]}`);
    const tx = a?.transactions ?? [];
    const want = r?.recording?.transactions ?? [];
    if (tx.length !== want.length || tx.some((t, i) => t.seq !== want[i].seq))
      fire(
        "replay-failure",
        `applied ${tx.length} transactions, the stream has ${want.length}`,
      );
    for (const at of liveShots.values()) {
      const shot = join(e.receiverDir, "shots", shotName(1, at.seq));
      if (!(await decodePngRgba(shot)))
        fire("replay-failure", `no replay shot of seq ${at.seq}`);
    }
  } else if (host && a) {
    for (const c of host.connections) {
      const s = (a.streams ?? []).find((x) => x.connection === c.n);
      const early =
        c.summary?.closed_by === "receiver" && c.summary?.end_sent === false;
      const same = sameBytesOrPrefix(c.received, c.tap, early);
      if (same === "prefix") {
        if (
          !c.received ||
          !(await isPrefix(
            c.received.path,
            join(host.dir, "tap", `stream-${c.n}.rs2`),
          ))
        )
          fire(
            "replay-failure",
            `connection ${c.n}: the receiver closed early, but its stream is not a prefix of the tap`,
          );
      } else if (same !== null && a.status === "ok")
        fire("replay-failure", `connection ${c.n}: ${same}`);
      if (a.status === "ok" && !s)
        fire(
          "replay-failure",
          `applied.json has no stream for connection ${c.n}`,
        );
      const recv = c.received?.recording?.transactions ?? [];
      const mine = (a.transactions ?? []).filter(
        (t) => (t.stream ?? 1) === host.connections.indexOf(c) + 1,
      );
      if (
        a.status === "ok" &&
        (mine.length !== recv.length ||
          mine.some((t, i) => t.seq !== recv[i].seq))
      )
        fire(
          "replay-failure",
          `connection ${c.n}: applied.json lists ${mine.length} transactions, ${recv.length} received`,
        );
    }
    const first = (a.transactions ?? []).find(
      (t) => typeof t.applied_us === "number",
    );
    const settle0 = host.timeline.steps.get(0)?.settle ?? Number.NaN;
    if (a.status === "ok" && (!first || (first.frame ?? 0) >= settle0))
      fire(
        "replay-failure",
        `receiver-late: first applied transaction has frame ${first?.frame ?? "none"} >= ${settle0}`,
      );
    if (e.rendered) {
      const shots = stepShots(a);
      const missing = expected.steps
        .map((s) => s.step)
        .filter((k) => !shots.has(k));
      if (missing.length > 0)
        fire(
          "replay-failure",
          `no shot for step(s) ${missing.join(",")} (shots_missed ${JSON.stringify(a.shots_missed ?? null)})`,
        );
    }
  }
  // 4. delivery-violation
  if (host && e.leg !== "live-replay")
    for (const c of host.connections)
      for (const r of deliveryReasons(deliveryReport(c.host)))
        fire(
          "delivery-violation",
          `connection ${c.n}: ${r.slice(r.indexOf(":") + 2)}`,
        );
  // 5. resource-violation
  const rx = asReceiverEvidence(e);
  for (const v of receiverResourceViolations(rx, warmHashes))
    fire("resource-violation", v);
  if (host && e.leg !== "live-replay") {
    for (const v of unadvertisedGets(
      httpGets(host.hook.lines),
      connTimelines(host),
    ).slice(0, 3))
      fire("resource-violation", `unadvertised-get: ${v}`);
    if (G2C_MAIN_VARIANT.includes(e.leg))
      for (const v of liveTransformOnlyTraffic(host, a).slice(0, 3))
        fire("resource-violation", `transform-only-resource-traffic: ${v}`);
  }
  // 6. pixel-mismatch
  let checkpoints: G2cCheckpoint[] = [];
  if (e.rendered && a?.status === "ok") {
    if (e.leg === "live-replay") {
      const replayApplied: G2cApplied = {
        transactions: a.transactions,
        shots: [...liveShots.entries()].map(([step, at]) => ({
          stream: 1,
          seq: at.seq,
          step,
        })),
      };
      checkpoints = await liveCheckpoints(
        expected,
        { ...e, applied: replayApplied },
        referenceDir,
        false,
      );
    } else
      checkpoints = await liveCheckpoints(
        expected,
        e,
        referenceDir,
        e.leg === "live-animate" || e.leg === "sabotage-unpin",
      );
  }
  const mismatching = checkpointMismatching(checkpoints).filter((k) =>
    checkpoints.some((c) => c.step === k && c.seq !== null),
  );
  for (const step of mismatching) {
    const c = checkpoints.find((x) => x.step === step);
    fire(
      "pixel-mismatch",
      `step ${step} (stream ${c?.stream} seq ${c?.seq}): ${c?.mismatched_pixels ?? "unreadable"} px differ`,
    );
  }
  const result_class =
    G2B_PRECEDENCE.find((cls) => fired.has(cls)) ?? "success";
  return {
    e,
    checkpoints,
    classification: {
      result_class,
      reasons: G2B_PRECEDENCE.flatMap((cls) => fired.get(cls) ?? []),
      mismatching_steps: mismatching,
    },
  };
}

/** transform-only (live, pure over loaded evidence): no GET and no receiver resource traffic in
 * step 2's and step 10's windows. */
export function liveTransformOnlyTraffic(
  host: G2cHost,
  a: G2cApplied | undefined,
): string[] {
  const out: string[] = [];
  for (const step of [2, 10]) {
    const [from, to] = liveStepWindow(host.timeline, step);
    for (const g of httpGets(host.hook.lines))
      if (g.frame >= from && g.frame <= to)
        out.push(
          `step ${step}: GET ${g.hash?.slice(0, 12)} at frame ${g.frame}`,
        );
    for (const t of a?.transactions ?? []) {
      if (
        t.frame === undefined ||
        t.frame < from ||
        t.frame > to ||
        !t.resources
      )
        continue;
      const busy = TRAFFIC_COUNTERS.filter(
        (k) => (t.resources?.[k] ?? 0) !== 0,
      );
      if (busy.length > 0)
        out.push(
          `step ${step}: seq ${t.seq} ${busy.map((k) => `${k}=${t.resources?.[k]}`).join(",")}`,
        );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

type Evals = Map<string, G2cEvaluation>;

function hostOf(evals: Evals, leg: string): G2cHost | null {
  return evals.get(leg)?.e.host ?? null;
}

export function checkLiveTapEqualsReceived(evals: Evals): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of G2C_GOOD) {
    const ev = evals.get(leg);
    const host = ev?.e.host;
    if (!host) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    for (const c of host.connections) {
      const early =
        c.summary?.closed_by === "receiver" && c.summary?.end_sent === false;
      const same = sameBytesOrPrefix(c.received, c.tap, early);
      if (same !== null && same !== "prefix")
        problems.push(`${leg} connection ${c.n}: ${same}`);
      else
        notes.push(
          `${leg}#${c.n} ${c.tap.bytes} B${same === "prefix" ? " (prefix: the receiver closed first)" : ""}`,
        );
    }
  }
  return check(
    "live-tap-equals-received",
    "on every g2c live leg that must succeed, each connection's received stream is byte for byte the host's tap of that connection (a byte prefix only for a connection the receiver itself closed before the end record: the reconnect)",
    problems,
    notes.join(", "),
    G2C_GOOD.map((l) => join(evals.get(l)?.e.receiverDir ?? l, "received.rs2")),
  );
}

export function checkLiveResolvesToRecording(evals: Evals): G2bCheck {
  const problems: string[] = [];
  let compared = 0;
  for (const leg of G2C_HOST_LEGS) {
    const host = hostOf(evals, leg);
    if (!host?.full.recording) {
      problems.push(`${leg}: no full recording`);
      continue;
    }
    const byFrame = new Map(
      host.full.recording.transactions.map((t) => [t.frame, t]),
    );
    for (const c of host.connections) {
      for (const t of c.tap.recording?.transactions ?? []) {
        compared++;
        const f = byFrame.get(t.frame);
        if (!f || !statesEqual(f.state, t.state)) {
          problems.push(
            `${leg} connection ${c.n} seq ${t.seq} (frame ${t.frame}) is not the full recording's state at that frame`,
          );
          break;
        }
      }
    }
  }
  return check(
    "live-resolves-to-recording",
    "every transaction every g2c host sent (each tap, each connection) resolves to the state its full file recording holds at the same frame, texture table included",
    problems,
    `${compared} live transactions equal the host recordings`,
    G2C_HOST_LEGS.map((l) => join(hostOf(evals, l)?.dir ?? l, "tap")),
  );
}

export function checkLiveCreditBounded(evals: Evals): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of G2C_HOST_LEGS) {
    const host = hostOf(evals, leg);
    if (!host) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    for (const c of host.connections) {
      const d = deliveryReport(c.host);
      for (const r of deliveryReasons(d).filter(
        (x) => !x.includes("stale-state"),
      ))
        problems.push(`${leg}#${c.n}: ${r}`);
      notes.push(`${leg}#${c.n} in flight <= ${d.max_in_flight}`);
    }
  }
  return check(
    "live-credit-bounded",
    "every g2c host connection, recomputed from its own log: at most one transaction in flight, no send logged without credit, queued bytes never above the largest credit window + 4096",
    problems,
    notes.join(", "),
    G2C_HOST_LEGS.map((l) => join(hostOf(evals, l)?.dir ?? l, "tap")),
  );
}

export function checkLiveAcksStaged(evals: Evals): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of G2C_GOOD) {
    const ev = evals.get(leg);
    const a = ev?.e.applied;
    const host = ev?.e.host;
    if (!a || !host) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    const rendered = ev.e.rendered;
    let bad = 0;
    for (const t of a.transactions ?? []) {
      const r = t.received_us;
      const ap = t.applied_us;
      const s = t.submitted_us;
      const ok =
        typeof r === "number" &&
        typeof ap === "number" &&
        r <= ap &&
        (rendered ? typeof s === "number" && ap <= s : s === null);
      if (!ok && bad++ < 2)
        problems.push(
          `${leg} seq ${t.seq}: received ${r}, applied ${ap}, submitted ${s}`,
        );
    }
    host.connections.forEach((c, i) => {
      const mine = (a.transactions ?? []).filter(
        (t) => (t.stream ?? 1) === i + 1,
      );
      const acks = c.summary?.acks ?? {};
      const n = mine.length;
      if (
        acks.received !== n ||
        acks.applied !== n ||
        acks.submitted !== (rendered ? n : 0)
      )
        problems.push(
          `${leg}#${c.n}: host saw acks ${JSON.stringify(acks)} for the ${n} transactions the receiver read`,
        );
      const sent = c.summary?.sent ?? 0;
      const early =
        c.summary?.closed_by === "receiver" && c.summary?.end_sent === false;
      if (sent !== n && !(early && sent - n <= 1))
        problems.push(`${leg}#${c.n}: ${sent} sent, ${n} read`);
    });
    if (a.live?.presented !== "unavailable")
      problems.push(`${leg}: presented ${JSON.stringify(a.live?.presented)}`);
    notes.push(`${leg} ${(a.transactions ?? []).length}`);
  }
  return check(
    "live-acks-staged",
    'per seq on every g2c live leg that must succeed, received_us <= applied_us <= submitted_us (submitted null headless); on every connection the host saw received, applied and (rendered) submitted acks for exactly the transactions the receiver read, and sent no more (one more only when the receiver closed first); presented is "unavailable"',
    problems,
    `transactions per leg: ${notes.join(", ")}`,
    G2C_GOOD.map((l) => join(evals.get(l)?.e.receiverDir ?? l, "applied.json")),
  );
}

export function checkLiveVsReference(evals: Evals): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const evidence: string[] = [];
  for (const leg of [
    "live",
    "live-warm",
    "live-stall",
    "live-reconnect",
    "live-animate",
    "live-replay",
  ]) {
    const ev = evals.get(leg);
    if (!ev) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    if (ev.checkpoints.length === 0) problems.push(`${leg}: no checkpoints`);
    for (const c of ev.checkpoints) {
      evidence.push(c.shot);
      if (c.seq === null) problems.push(`${leg} step ${c.step}: no shot`);
      else if (c.mismatched_pixels === null)
        problems.push(`${leg} step ${c.step}: unreadable shot`);
      else if (c.mismatched_pixels > 0)
        problems.push(
          `${leg} step ${c.step} (stream ${c.stream} seq ${c.seq}): ${c.mismatched_pixels} px differ${c.anim_mismatched ? ` (${c.anim_mismatched} in anim)` : ""}`,
        );
    }
    notes.push(
      `${leg} ${ev.checkpoints.filter((c) => c.mismatched_pixels === 0).length}/${ev.checkpoints.length}`,
    );
  }
  return check(
    "live-vs-reference",
    "every rendered g2c receiver's shot per step equals the reference's step shot exactly, full frame (live, live-warm, live-stall, live-reconnect on both connections, live-replay); live-animate's anim region equals synthesizeGate2 at the shot's frame instead, the rest the reference",
    problems,
    notes.join(", "),
    evidence,
  );
}

export async function checkLiveReplayEqualsLive(
  evals: Evals,
): Promise<G2bCheck> {
  const live = evals.get("live");
  const replay = evals.get("live-replay");
  const problems: string[] = [];
  const evidence: string[] = [];
  if (!live?.e.applied || !replay?.e.applied) {
    problems.push("live or live-replay not evaluated");
  } else {
    const a = live.e.applied.transactions ?? [];
    const b = replay.e.applied.transactions ?? [];
    if (replay.e.applied.status !== "ok")
      problems.push(`live-replay status ${replay.e.applied.status}`);
    if (a.length === 0 || a.length !== b.length)
      problems.push(`${a.length} live transactions, ${b.length} replayed`);
    const bad = a.findIndex(
      (t, i) => t.seq !== b[i]?.seq || t.record_sha256 !== b[i]?.record_sha256,
    );
    if (bad >= 0) problems.push(`index ${bad}: seq or record hash differs`);
    for (const at of stepShots(live.e.applied).values()) {
      const shotA = join(live.e.receiverDir, "shots", shotName(1, at.seq));
      const shotB = join(replay.e.receiverDir, "shots", shotName(1, at.seq));
      evidence.push(shotA, shotB);
      const pa = await decodePngRgba(shotA);
      const pb = await decodePngRgba(shotB);
      if (!pa || !pb) problems.push(`seq ${at.seq}: a shot is missing`);
      else if (
        diffRgba(pa.data, pb.data, pa.width, pa.height).mismatched_pixels > 0
      )
        problems.push(`seq ${at.seq}: shots differ`);
      const sa = (
        await readTextOrUndefined(
          join(live.e.receiverDir, "state", `seq-${at.seq}.json`),
        )
      )?.trim();
      const sb = (
        await readTextOrUndefined(
          join(replay.e.receiverDir, "state", `seq-${at.seq}.json`),
        )
      )?.trim();
      if (sa === undefined || sb === undefined)
        problems.push(`seq ${at.seq}: a state dump is missing`);
      else if (sa !== sb) problems.push(`seq ${at.seq}: state dumps differ`);
    }
    const fetched = replay.e.applied.resources_summary?.distinct_fetched ?? 0;
    const liveFetched =
      live.e.applied.resources_summary?.distinct_fetched ?? -1;
    if (fetched !== liveFetched)
      problems.push(
        `live-replay fetched ${fetched} payloads from live's cache, live fetched ${liveFetched} over HTTP`,
      );
  }
  return check(
    "live-replay-equals-live",
    "a file-mode receiver replaying the live receiver's received.rs2, with the live receiver's cache as its store, applies the same seqs with the same record hashes, fetches the same payloads, and its shots and state dumps at the live shots' seqs are identical (live/recording equivalence for textures)",
    problems,
    `${stepShots(live?.e.applied).size} shots and state dumps identical, ${live?.e.applied?.resources_summary?.distinct_fetched ?? 0} payloads from the cache`,
    evidence,
  );
}

export function checkHttpGetsMatchFetches(evals: Evals): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of G2C_GOOD) {
    const ev = evals.get(leg);
    const host = ev?.e.host;
    if (!host || !ev?.e.applied) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    const gets = httpGets(host.hook.lines);
    for (const p of getsVsFetches(gets, ev.e.applied.fetches ?? []))
      problems.push(`${leg}: ${p}`);
    const summaryGets = host.serving?.http_gets;
    if (summaryGets !== gets.length)
      problems.push(
        `${leg}: live-summary http_gets ${summaryGets}, ${gets.length} GET lines`,
      );
    notes.push(`${leg} ${gets.length}`);
  }
  return check(
    "http-gets-match-fetches",
    "on every g2c live leg that must succeed, the host's GET log (http-get lines) equals the receiver's http fetch list hash for hash and byte for byte, in order; every hash is fetched at most once per receiver process; every fetch is a verified 200 with Content-Type application/octet-stream, Cache-Control private, max-age=31536000, immutable, ETag \"<hash>\" and the right Content-Length; the summary counts the same GETs",
    problems,
    `GETs per leg: ${notes.join(", ")}`,
    G2C_GOOD.map((l) =>
      join(hostOf(evals, l)?.dir ?? l, "evidence", "resources.jsonl"),
    ),
  );
}

export function checkGetsAdvertised(evals: Evals): G2bCheck {
  const problems: string[] = [];
  let total = 0;
  for (const leg of G2C_HOST_LEGS) {
    const host = hostOf(evals, leg);
    if (!host) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    const gets = httpGets(host.hook.lines);
    total += gets.length;
    for (const p of unadvertisedGets(gets, connTimelines(host)).slice(0, 3))
      problems.push(`${leg}: ${p}`);
  }
  return check(
    "gets-advertised",
    "on every g2c host, every resource GET names a hash that a transaction already sent on the connection streaming at the time names (sent at an earlier frame callback than the one that logged the GET)",
    problems,
    `${total} GETs, each advertised first`,
    G2C_HOST_LEGS.map((l) =>
      join(hostOf(evals, l)?.dir ?? l, "evidence", "resources.jsonl"),
    ),
  );
}

export function checkFetchBeforeApplied(evals: Evals): G2bCheck {
  const problems: string[] = [];
  let total = 0;
  for (const leg of G2C_HOST_LEGS) {
    const ev = evals.get(leg);
    if (!ev?.e.applied) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    total += (ev.e.applied.fetches ?? []).length;
    for (const p of fetchesAfterApplied(ev.e.applied).slice(0, 3))
      problems.push(`${leg}: ${p}`);
    // Host side: the GET reached the host before the transaction's applied ack did.
    const host = ev.e.host;
    if (!host) continue;
    for (const c of host.connections) {
      const appliedAt = new Map<number, number>();
      for (const l of c.host.log ?? [])
        if (l.event === "ack" && l.stage === "applied" && l.seq !== undefined)
          appliedAt.set(l.seq, l.frame);
      for (const f of ev.e.applied.fetches ?? []) {
        if (f.source !== "http") continue;
        const idx = host.connections.indexOf(c) + 1;
        if ((f.stream ?? 1) !== idx || f.seq === undefined) continue;
        const ackFrame = appliedAt.get(f.seq);
        const get = httpGets(host.hook.lines).find(
          (g) => g.hash === f.hash && g.conn === c.n,
        );
        if (ackFrame !== undefined && get && get.frame > ackFrame)
          problems.push(
            `${leg}#${c.n}: GET ${f.hash?.slice(0, 12)} logged at frame ${get.frame}, seq ${f.seq}'s applied ack at ${ackFrame}`,
          );
      }
    }
  }
  return check(
    "fetch-before-applied",
    "every http fetch for seq n ended (receiver clock) before n's applied ack was sent, and reached the host no later than that ack (host frames), on every g2c leg",
    problems,
    `${total} fetches, each before its applied ack`,
    G2C_HOST_LEGS.map((l) =>
      join(evals.get(l)?.e.receiverDir ?? l, "applied.json"),
    ),
  );
}

export function pinsOf(host: G2cHost): PinsReport {
  const budgetText = host.env.get("GRC_RESOURCE_BUDGET_BYTES");
  const budget = budgetText ? Number(budgetText) : DEFAULT_BUDGET_BYTES;
  return pinsReport(
    host.hook.lines,
    host.full.recording?.transactions ?? [],
    connTimelines(host),
    budget,
  );
}

export function checkPinsBounded(
  evals: Evals,
  pins: Map<string, PinsReport>,
): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of G2C_GOOD) {
    const p = pins.get(leg);
    if (!p || p.frames_compared === 0) {
      problems.push(`${leg}: no pin or retire lines to compare`);
      continue;
    }
    for (const m of [...p.missing, ...p.late, ...p.over_budget].slice(0, 3))
      problems.push(`${leg}: ${m}`);
    notes.push(
      `${leg} ${p.frames_compared} frames, retained max ${p.retained_max} (${p.retained_bytes_max} B)`,
    );
  }
  return check(
    "pins-bounded",
    "on every g2c host that must succeed, after every frame callback the servable hashes (replayed from the pin and retire lines) equal the full recording's ok image hashes at that frame united with every open connection's base (its last tapped transaction), and their bytes never exceed GRC_RESOURCE_BUDGET_BYTES",
    problems,
    notes.join("; "),
    G2C_GOOD.map((l) =>
      join(hostOf(evals, l)?.dir ?? l, "evidence", "resources.jsonl"),
    ),
  );
}

export interface AnimateCounts {
  updates: number;
  versions_sent: number;
  hashes_sent: number;
  hashes_fetched: number;
  retirements: number;
}

/** live-animate: the ANIM updates the fixture made, the ANIM versions and hashes that reached the
 * wire, and the hashes the receiver fetched. */
export function animateCounts(
  ev: G2cEvaluation,
  pins: PinsReport | undefined,
): AnimateCounts | null {
  const host = ev.e.host;
  if (!host) return null;
  const ids = textureIdsByName(host.hook.lines, host.fixture);
  const anim = ids.get("ANIM");
  if (anim === undefined) return null;
  const versions = new Set<number>();
  const hashes = new Set<string>();
  for (const c of host.connections)
    for (const t of c.tap.recording?.transactions ?? []) {
      const e = t.state.textures.find((x) => x.id === anim);
      if (e) {
        versions.add(e.version);
        if (e.hash) hashes.add(e.hash);
      }
    }
  return {
    updates: host.fixture.filter(
      (f) => f.name === "ANIM" && f.op === "texture_2d_update",
    ).length,
    versions_sent: versions.size,
    hashes_sent: hashes.size,
    hashes_fetched: new Set((ev.e.applied?.fetches ?? []).map((f) => f.hash))
      .size,
    retirements: pins?.retirements ?? 0,
  };
}

export function checkObsoleteRetired(
  evals: Evals,
  pins: Map<string, PinsReport>,
): { check: G2bCheck; animate: AnimateCounts | null } {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of G2C_GOOD) {
    const p = pins.get(leg);
    if (!p) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    for (const m of [...p.late, ...p.early].slice(0, 3))
      problems.push(`${leg}: ${m}`);
    notes.push(`${leg} ${p.retirements} retired`);
  }
  const animEv = evals.get("live-animate");
  const animate = animEv
    ? animateCounts(animEv, pins.get("live-animate"))
    : null;
  if (!animEv || !animate) problems.push("live-animate: no ANIM evidence");
  else {
    const sent = new Set<string>();
    for (const c of animEv.e.host?.connections ?? [])
      for (const t of c.tap.recording?.transactions ?? [])
        for (const h of tableHashes(t)) sent.add(h);
    for (const f of animEv.e.applied?.fetches ?? [])
      if (f.hash && !sent.has(f.hash))
        problems.push(
          `live-animate fetched ${f.hash.slice(0, 12)}, which no sent transaction names`,
        );
    if (!(animate.versions_sent < animate.updates))
      problems.push(
        `live-animate: ${animate.versions_sent} ANIM versions sent for ${animate.updates} updates`,
      );
    if (animate.retirements === 0)
      problems.push("live-animate: nothing was retired");
    notes.push(
      `live-animate: ${animate.updates} ANIM updates, ${animate.versions_sent} versions and ${animate.hashes_sent} hashes sent, ${animate.hashes_fetched} hashes fetched, ${animate.retirements} retirements`,
    );
  }
  return {
    check: check(
      "obsolete-retired",
      "on every g2c host that must succeed, a hash is retired at the first frame callback after which neither the current state nor any open connection's base names it, and never while one still does; in live-animate the hashes ever fetched are a subset of the hashes of sent transactions, the ANIM versions sent are fewer than the updates, and superseded versions are retired (counts reported)",
      problems,
      notes.join("; "),
      G2C_GOOD.map((l) =>
        join(hostOf(evals, l)?.dir ?? l, "evidence", "resources.jsonl"),
      ),
    ),
    animate,
  };
}

/** The fixture log's payload hash for a named op (the A1 update, C's and D's creates...). */
function fixtureHash(host: G2cHost, name: string, op: string): string | null {
  return (
    host.fixture.find((f) => f.name === name && f.op === op)?.payload_sha256 ??
    null
  );
}

export function checkStallNewestTexture(evals: Evals): G2bCheck {
  const problems: string[] = [];
  let detail = "";
  const ev = evals.get("live-stall");
  const a = ev?.e.applied;
  const host = ev?.e.host;
  const stall = a?.live?.stall;
  if (!ev || !a || !host || !stall) {
    problems.push("live-stall: no stall evidence");
  } else {
    const ids = textureIdsByName(host.hook.lines, host.fixture);
    const aId = ids.get("A");
    const a1 = fixtureHash(host, "A", "texture_2d_update");
    const tx = (a.transactions ?? []).filter((t) => (t.stream ?? 1) === 1);
    const after = tx.find((t) => (t.seq ?? 0) > (stall.after_seq ?? 0));
    const f6 = liveStepFrame(host.timeline, 6);
    const f7 = liveStepFrame(host.timeline, 7);
    if (!after) problems.push("no transaction after the stall");
    else {
      if (!((stall.after_frame ?? 0) < f6 && (after.frame ?? 0) >= f6))
        problems.push(
          `the stall (after frame ${stall.after_frame}, next transaction at ${after.frame}) does not contain step 6's frame ${f6}`,
        );
      if ((after.frame ?? 0) >= f7)
        problems.push(
          `the first post-stall transaction is at frame ${after.frame} >= step 7's ${f7}`,
        );
      const tap = host.connections[0]?.tap.recording?.transactions.find(
        (t) => t.seq === after.seq,
      );
      const entry = tap?.state.textures.find((t) => t.id === aId);
      if (!a1 || entry?.hash !== a1)
        problems.push(
          `seq ${after.seq} names A (id ${aId}) with hash ${entry?.hash?.slice(0, 12)}, A1 is ${a1?.slice(0, 12)}`,
        );
      const fetches = (a.fetches ?? []).filter((f) => f.hash === a1);
      if (fetches.length !== 1 || fetches[0].seq !== after.seq)
        problems.push(
          `A1 fetched ${fetches.length} time(s) (seqs ${fetches.map((f) => f.seq).join(",")}), expected once for seq ${after.seq}`,
        );
      const cp = ev.checkpoints.find((c) => c.seq === after.seq);
      if (!cp) problems.push(`no shot of seq ${after.seq}`);
      else if (cp.mismatched_pixels !== 0)
        problems.push(
          `the post-stall shot (step ${cp.step}) differs from the reference`,
        );
      detail = `stall after seq ${stall.after_seq} (frame ${stall.after_frame}); seq ${after.seq} at frame ${after.frame} carries A1 (${a1?.slice(0, 12)}), fetched once; its step ${cp?.step} shot equals the reference`;
    }
  }
  return check(
    "stall-newest-texture",
    "live-stall: step 6's texture update lands inside the receiver's stall; the first transaction after it carries A1's hash (the hook-time content of the update), A1 is fetched exactly once, for that transaction, and that transaction's shot equals the reference",
    problems,
    detail,
    [join(ev?.e.receiverDir ?? "live-stall", "applied.json")],
  );
}

export function checkReconnectNoRefetch(evals: Evals): G2bCheck {
  const problems: string[] = [];
  let detail = "";
  const ev = evals.get("live-reconnect");
  const a = ev?.e.applied;
  const host = ev?.e.host;
  if (!ev || !a || !host) problems.push("live-reconnect: not evaluated");
  else if (host.connections.length !== 2)
    problems.push(`${host.connections.length} connections, expected 2`);
  else {
    const tx2 = (a.transactions ?? []).filter((t) => t.stream === 2);
    const first = tx2[0];
    const tap2 = host.connections[1].tap.recording?.transactions ?? [];
    if (first?.encoding !== "full")
      problems.push(
        `connection 2 starts with ${first?.encoding ?? "nothing"}, not full`,
      );
    const res = first?.resources ?? {};
    if ((res.fetched ?? -1) !== 0)
      problems.push(`connection 2's first transaction fetched ${res.fetched}`);
    const state = tap2.find((t) => t.seq === first?.seq);
    const named = new Set<number>();
    const neededHashes = new Set<string>();
    for (const item of state?.state.items ?? [])
      for (const c of item.commands)
        if (
          (c.op === "add_texture_rect" || c.op === "add_texture_rect_region") &&
          typeof c.tex === "number"
        ) {
          const tex = c.tex;
          const t = state?.state.textures.find((x) => x.id === tex);
          if (t && t.status !== "freed" && t.status !== "unsupported") {
            named.add(tex);
            if (t.kind === "image" && t.hash) neededHashes.add(t.hash);
          }
        }
    if ((res.cache_hits ?? -1) !== neededHashes.size)
      problems.push(
        `connection 2's first transaction: ${res.cache_hits} cache hits, ${neededHashes.size} distinct payloads needed`,
      );
    const uploads = (a.uploads ?? []).filter(
      (u) => u.stream === 2 && u.seq === first?.seq,
    );
    if (uploads.length !== named.size)
      problems.push(
        `connection 2's first transaction made ${uploads.length} uploads for ${named.size} resident textures`,
      );
    const f1 = new Set(
      (a.fetches ?? []).filter((f) => (f.stream ?? 1) === 1).map((f) => f.hash),
    );
    const f2 = (a.fetches ?? []).filter((f) => f.stream === 2);
    for (const f of f2)
      if (f1.has(f.hash))
        problems.push(`${f.hash?.slice(0, 12)} fetched on both connections`);
    for (const name of ["C", "D"]) {
      const h = fixtureHash(host, name, "texture_2d_create");
      const n = f2.filter((f) => f.hash === h).length;
      if (!h || n !== 1)
        problems.push(`step 8's ${name} fetched ${n} times on connection 2`);
    }
    detail = `connection 2 seq ${first?.seq} full: 0 fetched, ${res.cache_hits} cache hits, ${uploads.length} uploads for ${named.size} resident textures; then ${f2.length} fetches on connection 2 (C and D once each)`;
  }
  return check(
    "reconnect-no-refetch",
    "live-reconnect: connection 2 starts with a full transaction that fetches nothing (every payload it needs is a disk-cache hit) and uploads exactly its resident textures; step 8's new payloads (C, D) are then fetched once each on connection 2, and nothing fetched on connection 1 is fetched again",
    problems,
    detail,
    [join(ev?.e.receiverDir ?? "live-reconnect", "applied.json")],
  );
}

export function checkLiveTransformOnly(evals: Evals): G2bCheck {
  const problems: string[] = [];
  for (const leg of G2C_MAIN_VARIANT) {
    const ev = evals.get(leg);
    if (!ev?.e.host) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    for (const p of liveTransformOnlyTraffic(ev.e.host, ev.e.applied).slice(
      0,
      3,
    ))
      problems.push(`${leg}: ${p}`);
  }
  return check(
    "transform-only-no-resource-traffic-live",
    "inside step 2's and step 10's windows (transform only) on every main-variant g2c leg: no resource GET reaches the host, and every receiver transaction has every resource counter at 0 (no fetch, cache hit or upload)",
    problems,
    `steps 2 and 10 quiet in ${G2C_MAIN_VARIANT.join(", ")}`,
    G2C_MAIN_VARIANT.map((l) =>
      join(evals.get(l)?.e.receiverDir ?? l, "applied.json"),
    ),
  );
}

export async function checkWarmHostNoGets(evals: Evals): Promise<G2bCheck> {
  const problems: string[] = [];
  const warm = evals.get("live-warm");
  const live = evals.get("live");
  const host = warm?.e.host;
  if (!warm || !host || !live) problems.push("live-warm or live not evaluated");
  else {
    const gets = httpGets(host.hook.lines).length;
    if (gets !== 0 || (host.serving?.http_gets ?? -1) !== 0)
      problems.push(
        `the warm host logged ${gets} GETs (summary ${host.serving?.http_gets})`,
      );
    const s = warm.e.applied?.resources_summary;
    const liveFetched =
      live.e.applied?.resources_summary?.distinct_fetched ?? -1;
    if ((s?.distinct_fetched ?? -1) !== 0)
      problems.push(`the warm receiver fetched ${s?.distinct_fetched}`);
    if ((s?.cache_hits ?? -1) !== liveFetched)
      problems.push(`${s?.cache_hits} cache hits, live fetched ${liveFetched}`);
    if (warm.e.applied?.cache?.mode !== "warm")
      problems.push("the receiver's cache mode is not warm");
    for (const [step, b] of stepShots(warm.e.applied)) {
      const at = stepShots(live.e.applied).get(step);
      if (!at) continue;
      const pa = await decodePngRgba(
        join(live.e.receiverDir, "shots", shotName(at.stream, at.seq)),
      );
      const pb = await decodePngRgba(
        join(warm.e.receiverDir, "shots", shotName(b.stream, b.seq)),
      );
      if (
        !pa ||
        !pb ||
        diffRgba(pa.data, pb.data, pa.width, pa.height).mismatched_pixels > 0
      )
        problems.push(`step ${step}: live-warm's shot differs from live's`);
    }
  }
  return check(
    "warm-host-no-gets",
    "live-warm (a new host and a new receiver on live's cache, mode warm): the host answers no GET at all, the receiver fetches nothing and hits its cache once per payload live fetched, and its shot per step equals live's",
    problems,
    `0 GETs, ${warm?.e.applied?.resources_summary?.cache_hits ?? 0} cache hits, shots equal live's`,
    [join(host?.dir ?? "live-warm", "evidence", "resources.jsonl")],
  );
}

// ---------------------------------------------------------------------------------------------
// The g2c group
// ---------------------------------------------------------------------------------------------

export interface G2cLegReport {
  group: "g2c";
  expected_class: G2bClass | null;
  result_class: G2bClass | null;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface G2cHostNumbers {
  http_gets: number | null;
  http_bytes: number | null;
  http_errors: number | null;
  pinned: number | null;
  retired: number | null;
  retained_max: number | null;
  retained_bytes_max: number | null;
  fetch_latency_us: {
    n: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  fetch_latency_by_bytes: Array<{
    bytes: number;
    n: number;
    p50: number | null;
    p95: number | null;
  }>;
}

export interface G2cResult {
  checks: G2bCheck[];
  legs: Record<string, G2cLegReport>;
  checkpoints: G2cCheckpoint[];
  numbers: Record<string, G2cHostNumbers>;
  animate: AnimateCounts | null;
}

function hostNumbers(
  ev: G2cEvaluation,
  pins: PinsReport | undefined,
): G2cHostNumbers {
  const s = ev.e.host?.serving;
  const lat = (ev.e.applied?.fetches ?? [])
    .filter((f) => f.source === "http" && f.status === 200)
    .map((f) => ({
      bytes: f.bytes ?? 0,
      us: (f.end_us ?? 0) - (f.start_us ?? 0),
    }));
  const sizes = [...new Set(lat.map((l) => l.bytes))].sort((x, y) => x - y);
  return {
    http_gets: s?.http_gets ?? null,
    http_bytes: s?.http_bytes ?? null,
    http_errors: s?.http_errors ?? null,
    pinned: s?.pinned ?? pins?.pins ?? null,
    retired: s?.retired ?? pins?.retirements ?? null,
    retained_max: s?.retained_max ?? pins?.retained_max ?? null,
    retained_bytes_max:
      s?.retained_bytes_max ?? pins?.retained_bytes_max ?? null,
    fetch_latency_us: {
      n: lat.length,
      p50: percentile(
        lat.map((l) => l.us),
        50,
      ),
      p95: percentile(
        lat.map((l) => l.us),
        95,
      ),
      max: lat.length > 0 ? Math.max(...lat.map((l) => l.us)) : null,
    },
    fetch_latency_by_bytes: sizes.map((b) => {
      const us = lat.filter((l) => l.bytes === b).map((l) => l.us);
      return {
        bytes: b,
        n: us.length,
        p50: percentile(us, 50),
        p95: percentile(us, 95),
      };
    }),
  };
}

export async function runG2c(
  outDir: string,
  expected: Gate2Expected,
): Promise<G2cResult> {
  const hosts = new Map<string, G2cHost>();
  const referenceDir = join(outDir, "reference");
  const loaded = new Map<string, G2cLegEvidence>();
  for (const l of G2C_LEGS)
    loaded.set(l.leg, await loadG2cLeg(outDir, l.leg, hosts));
  const liveShots = stepShots(loaded.get("live")?.applied);
  const liveFetched = new Set(
    (loaded.get("live")?.applied?.fetches ?? []).map((f) => f.hash ?? ""),
  );
  const evals: Evals = new Map();
  for (const l of G2C_LEGS) {
    const e = loaded.get(l.leg) as G2cLegEvidence;
    evals.set(
      l.leg,
      await classifyG2cLeg(
        e,
        expected,
        referenceDir,
        l.leg === "live-warm" ? liveFetched : null,
        liveShots,
      ),
    );
  }
  const pins = new Map<string, PinsReport>();
  for (const leg of G2C_HOST_LEGS) {
    const host = hostOf(evals, leg);
    if (host) pins.set(leg, pinsOf(host));
  }
  const obsolete = checkObsoleteRetired(evals, pins);
  const checks: G2bCheck[] = [
    checkLiveTapEqualsReceived(evals),
    checkLiveResolvesToRecording(evals),
    checkLiveCreditBounded(evals),
    checkLiveAcksStaged(evals),
    checkLiveVsReference(evals),
    await checkLiveReplayEqualsLive(evals),
    checkHttpGetsMatchFetches(evals),
    checkGetsAdvertised(evals),
    checkFetchBeforeApplied(evals),
    checkPinsBounded(evals, pins),
    obsolete.check,
    checkStallNewestTexture(evals),
    checkReconnectNoRefetch(evals),
    checkLiveTransformOnly(evals),
    await checkWarmHostNoGets(evals),
  ];
  const legs: Record<string, G2cLegReport> = {};
  const numbers: Record<string, G2cHostNumbers> = {};
  for (const l of G2C_LEGS) {
    const ev = evals.get(l.leg) as G2cEvaluation;
    const extra: string[] = [];
    const failure = ev.e.applied?.failure;
    const host = ev.e.host;
    if (
      host &&
      (l.leg === "sabotage-drop-resource" ||
        l.leg === "sabotage-wrong-hash-live")
    ) {
      // The failure is the first transaction naming A1 (step 6's update).
      const a1 = fixtureHash(host, "A", "texture_2d_update");
      const want = host.connections[0]?.tap.recording?.transactions.find((t) =>
        okImageHashes(t).has(a1 ?? ""),
      )?.seq;
      if (failure?.seq !== want)
        extra.push(
          `receiver failure at seq ${failure?.seq}, expected seq ${want} (the first naming A1)`,
        );
      const dropped =
        host.serving?.dropped_hash ?? host.serving?.corrupted_hash;
      if (dropped !== a1)
        extra.push(
          `the host's sabotaged hash ${dropped?.slice(0, 12)} is not A1 ${a1?.slice(0, 12)}`,
        );
    }
    if (host && l.leg === "sabotage-unpin") {
      if ((host.serving?.retired_unpinned ?? 0) === 0)
        extra.push("the unpin sabotage retired nothing a base still named");
      const gets404 = httpGets(host.hook.lines).filter(
        (g) => g.http_status === 404,
      );
      if (
        gets404.length === 0 ||
        gets404[0].hash !== ev.e.applied?.fetches?.at(-1)?.hash
      )
        extra.push("no 404 GET for the receiver's failing fetch");
    }
    const artifacts = [
      join(ev.e.receiverDir, "applied.json"),
      join(ev.e.receiverDir, "stdout.log"),
    ];
    checks.push(checkLegClass(l, ev.classification, extra, artifacts));
    legs[l.leg] = {
      group: "g2c",
      expected_class: l.expected_class,
      result_class: ev.classification.result_class,
      reasons: ev.classification.reasons,
      exit_code: ev.e.exit,
      artifacts,
    };
    if (ev.e.host && l.leg !== "live-replay")
      numbers[l.leg] = hostNumbers(ev, pins.get(l.leg));
  }
  return {
    checks,
    legs,
    checkpoints: [...evals.values()].flatMap((x) => x.checkpoints),
    numbers,
    animate: obsolete.animate,
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
