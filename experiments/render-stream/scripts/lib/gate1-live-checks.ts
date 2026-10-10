// Gate 1 live-delivery checks and leg classification (protocol/gate1-design.md "Q4", "Q7" and
// "G1c2"): group g1c. Pure over an evidence directory written by run-gate1.sh, so
// scripts/test/self-test-gate1.ts drives it with fabricated trees. Nothing launches a process.
//
// Evidence layout under <out>/ (see scripts/README.md "Gate 1"):
//   live/host/                 the capture host: evidence/{result,live,live-summary,root}.json,
//                              recording.rs2, recording-patch.rs2, store/, steps.jsonl,
//                              tap/stream-1.rs2 (every binary message formed, in order),
//                              tap/live-1.jsonl (one line per frame callback, plus event lines)
//   live/receiver/             the rendered live receiver: applied.json (mode live),
//                              received.rs2, shots/seq-<n>.png, state/seq-<n>.json
//   live-replay/               a rendered file-mode receiver on live/receiver/received.rs2,
//                              shooting the live shots' seqs
//
// Since G2b2 the streams are render-stream/2 (subprotocol render-stream.2). Until G2c2 every live
// connection is inline: right before the transaction that first needs a payload the host sends it
// as a resource record, one binary message of its own (at least the engine's hue strip before
// seq 1), and logs a `resource` event line. Every message after the first is still exactly one
// record, but not every record is a transaction: everything here that walks a tap or a received
// stream goes through summarizeRecording (transactions only, by seq), never by message index, and
// the queued-bytes bound is taken over a credit window (a transaction and the records sent ahead
// of it), not over one message.
//   live-headless/{host,receiver}/   credit stage applied, receiver under strace -e openat
//   sabotage-drop-message/{host,receiver}/   GRC_SABOTAGE=drop-message
//
// Classification extends gate 1's precedence (capture-failure, unsupported, replay-failure,
// delivery-violation, pixel-mismatch, success) with the live rules:
//   capture-failure     gate 0/1 rules on the host's full and patch recordings; a host that did not
//                       listen; a tap that is not a valid stream
//   replay-failure      the receiver's status, end record, transactions (exactly the received
//                       stream, hashes equal), received bytes != the host's tap, a receiver that
//                       joined late (first applied frame >= step 0's settle frame), missed shot
//                       windows (rendered legs)
//   delivery-violation  two transactions in flight, a send logged without credit, queued bytes
//                       above the largest message + 4096, a tapped transaction whose resolved
//                       state differs from the full recording at its frame (stale-state)
//   pixel-mismatch      a step shot that differs from the reference

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  decodePngRgba,
  fileExists,
  readJson,
  readTextOrUndefined,
  successfulOpenats,
} from "./gate-minus1-checks";
import {
  type AppliedJson,
  type CaptureResultJson,
  classifyLeg,
  diffRgba,
  loadRecording,
  PATCH_RECORDING_NAME,
  parseStepLog,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
  type StepJoin,
  type StepLine,
} from "./gate0-checks";
import {
  check,
  classifyGate1,
  compareWithSynth,
  computeGate1Checkpoints,
  GATE1_CLASS_PRECEDENCE,
  type Gate1Check,
  type Gate1Checkpoint,
  type Gate1Class,
  type Gate1Classification,
  patchDivergence,
  resolvedStateOf,
} from "./gate1-checks";
import type { Gate1Expected } from "./gate1-expected";
import { decodeRecord, splitRecords } from "./render-stream-2";

async function readBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------------------------

export const G1C_CLASSIFIED_LEGS = [
  "live",
  "live-replay",
  "live-headless",
  "sabotage-drop-message",
] as const;
export type G1cLeg = (typeof G1C_CLASSIFIED_LEGS)[number];

/** The legs with a live host (live-replay reuses live's host). */
export const LIVE_HOST_LEGS = [
  "live",
  "live-headless",
  "sabotage-drop-message",
] as const;
export type LiveHostLeg = (typeof LIVE_HOST_LEGS)[number];

export interface LiveLegExpectation {
  class: Gate1Class;
  reasonIncludes?: string;
}

export const G1C_EXPECTATIONS: Record<G1cLeg, LiveLegExpectation> = {
  live: { class: "success" },
  "live-replay": { class: "success" },
  "live-headless": { class: "success" },
  "sabotage-drop-message": {
    class: "replay-failure",
    reasonIncludes: "seq-gap",
  },
};

/** Rendered live receivers shoot every step window and credit at `submitted`. */
const RENDERED: Record<LiveHostLeg, boolean> = {
  live: true,
  "live-headless": false,
  "sabotage-drop-message": true,
};

export const TAP_NAME = "stream-1.rs2";
export const LIVE_LOG_NAME = "live-1.jsonl";
/** The tap and live log of connection `n` (G1d's reconnect makes a connection 2). */
export const tapName = (n: number): string => `stream-${n}.rs2`;
export const liveLogName = (n: number): string => `live-${n}.jsonl`;
export const RECEIVED_NAME = "received.rs2";
/** The WebSocket subprotocol a receiver negotiates (render-stream-4.md "Live transport", since
 * G5d; render-stream.3 from G4e2). */
export const SUBPROTOCOL = "render-stream.4";
/** Queued bytes may exceed the largest credit window by this much (gate1-design.md Q7 class 4). */
export const QUEUED_SLACK_BYTES = 4096;

// ---------------------------------------------------------------------------------------------
// Evidence shapes
// ---------------------------------------------------------------------------------------------

/** evidence/live.json (render-stream-live/1). */
export interface LiveJson {
  schema?: string;
  status?: string;
  address?: string | null;
  port?: number | null;
  reason?: string | null;
}

export interface LatencySummary {
  count?: number;
  min?: number;
  median?: number;
  p95?: number;
  max?: number;
}

/** One connection of evidence/live-summary.json (render-stream-live-summary/1). */
export interface LiveConnectionSummary {
  connection?: number;
  stream_id?: string | null;
  receiver?: string | null;
  credit_stage?: string | null;
  inbound_buffer_bytes?: number;
  max_message_bytes?: number;
  frames_offered?: number;
  transactions?: number;
  sent?: number;
  dropped?: number;
  full?: number;
  patch?: number;
  coalesced?: number;
  /** G1d: pending targets (at most one at a time), their count and the oldest one's age */
  max_pending?: number;
  pending_episodes?: number;
  max_pending_frames?: number;
  max_pending_age_us?: number;
  /** G1d sabotage evidence: sends without credit (ignore-credit), stale copies sent */
  sent_without_credit?: number;
  stale_sent?: number;
  max_in_flight?: number;
  max_queued_bytes?: number;
  max_message_sent?: number;
  bytes_sent?: number;
  /** G2b2: resource records sent (inline payloads) and their payload bytes */
  resource_records?: number;
  resource_bytes?: number;
  resyncs?: number;
  credits?: number;
  acks?: { received?: number; applied?: number; submitted?: number };
  acks_ignored?: number;
  end_sent?: boolean;
  close_code?: number | null;
  closed_by?: string | null;
  close_reason?: string | null;
  error_sent?: string | null;
  ack_latency_us?: {
    received?: LatencySummary | null;
    applied?: LatencySummary | null;
    submitted?: LatencySummary | null;
  };
  credit_rtt_us?: LatencySummary | null;
  credit_rtt_frames?: LatencySummary | null;
}

export interface LiveSummaryJson {
  schema?: string;
  connections?: LiveConnectionSummary[];
}

/** One line of tap/live-<n>.jsonl: a frame line (`state` set) or an event line (`event` set). */
export interface LiveLogLine {
  frame: number;
  t_us: number;
  event?: string;
  state?: string;
  credit?: boolean;
  in_flight?: number | null;
  pending?: boolean;
  /** G1d: the frame the current pending target became pending, null when nothing is pending */
  pending_since?: number | null;
  coalesced?: number;
  queued_bytes?: number;
  sent?: {
    seq: number;
    encoding: string;
    bytes: number;
    dropped?: boolean;
    /** stale-coalesce: the frame whose snapshot this transaction carries */
    stale_from?: number;
  } | null;
  seq?: number;
  stage?: string;
  stream_id?: string;
  credited?: boolean;
  ignored?: string | null;
  credit_stage?: string;
  code?: number;
  closed_by?: string;
  reason?: string;
  /** G2b2 `resource` event lines: the payload sent inline */
  hash?: string;
  bytes?: number;
}

export function parseLiveLog(
  text: string | undefined,
): LiveLogLine[] | undefined {
  if (text === undefined) return undefined;
  const out: LiveLogLine[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as LiveLogLine;
      if (!Number.isInteger(value.frame)) return undefined;
      out.push(value);
    } catch {
      return undefined;
    }
  }
  return out;
}

/** applied.json in live mode (render-stream-receiver-applied/3 since G2b2: gate1-design.md Q5's
 * /2 plus gate2-design.md Q5's resource keys). */
export interface AppliedLive extends AppliedJson {
  streams?: {
    stream_id?: string | null;
    connection?: number | null;
    received_path?: string;
    received_sha256?: string | null;
    received_bytes?: number;
    end_seen?: boolean;
    closed_by?: string | null;
    close_code?: number | null;
  }[];
  transactions?: {
    stream?: number;
    seq?: number;
    frame?: number;
    encoding?: string;
    record_sha256?: string;
    rs_calls?: number;
    received_us?: number | null;
    applied_us?: number | null;
    submitted_us?: number | null;
    skipped?: string | null;
  }[];
  shots?: {
    stream?: number;
    seq?: number;
    step?: number | null;
    path?: string;
    applied_through?: number;
    state_path?: string | null;
  }[];
  shots_missed?: number[];
  live?: {
    url?: string;
    credit_stage?: string;
    inbound_buffer_bytes?: number;
    presented?: string;
    acks_sent?: { received?: number; applied?: number; submitted?: number };
    /** G1d (gate1-design.md Q5) */
    stall?: {
      step?: number;
      ms?: number;
      after_seq?: number;
      after_frame?: number;
      start_us?: number;
      end_us?: number;
      injected?: boolean;
      mechanism?: string;
    } | null;
    reconnect?: {
      step?: number;
      after_seq?: number;
      after_frame?: number;
      connect_attempts?: number;
      created_rids?: number | null;
      freed_by_apply?: number | null;
      owned_before_dispose?: number | null;
      freed_rids?: number | null;
      leftover_rids?: number | null;
    } | null;
    resync?: { step?: number; seq?: number; frame?: number } | null;
  } | null;
}

export interface LiveHostEvidence {
  dir: string;
  /** the connection whose tap and log these are (1 unless G1d reconnected) */
  connection: number;
  captureResult:
    | (CaptureResultJson & {
        live?: { status?: string; port?: number; connections?: number };
      })
    | undefined;
  live: LiveJson | undefined;
  summary: LiveSummaryJson | undefined;
  log: LiveLogLine[] | undefined;
  tap: RecordingSummary;
  tapBytes: Uint8Array | undefined;
  full: RecordingSummary;
  patch: RecordingSummary;
  steps: StepLine[] | undefined;
  exit_code: number | null;
}

export async function loadLiveHost(
  dir: string,
  connection = 1,
): Promise<LiveHostEvidence> {
  return {
    dir,
    connection,
    captureResult: await readJson(join(dir, "evidence", "result.json")),
    live: await readJson<LiveJson>(join(dir, "evidence", "live.json")),
    summary: await readJson<LiveSummaryJson>(
      join(dir, "evidence", "live-summary.json"),
    ),
    log: parseLiveLog(
      await readTextOrUndefined(join(dir, "tap", liveLogName(connection))),
    ),
    tap: await loadRecording(join(dir, "tap", tapName(connection))),
    tapBytes: await readBytes(join(dir, "tap", tapName(connection))),
    full: await loadRecording(join(dir, RECORDING_NAME)),
    patch: await loadRecording(join(dir, PATCH_RECORDING_NAME)),
    steps: parseStepLog(await readTextOrUndefined(join(dir, "steps.jsonl"))),
    exit_code: await readExitCode(dir),
  };
}

/** validateRecording() of the tap, except that a connection the receiver closed before the end
 * record may lack it (render-stream-1.md "File layout", unchanged at /2: "a stream the receiver
 * itself closed may lack the end record"); every other error stands. */
export function tapErrors(host: LiveHostEvidence): string[] {
  const c = connectionSummary(host);
  const receiverClosedEarly =
    c?.closed_by === "receiver" && c.end_sent === false;
  return host.tap.errors.filter(
    (e) => !(receiverClosedEarly && e.startsWith("recording-incomplete:")),
  );
}

/** The live-summary.json entry of the host evidence's own connection. */
export function connectionSummary(
  host: LiveHostEvidence,
): LiveConnectionSummary | undefined {
  return host.summary?.connections?.find(
    (c) => c.connection === host.connection,
  );
}

/** Step 0's settle frame (S + 7): a live receiver must have applied something before it. */
export function step0Settle(steps: StepLine[] | undefined): number | null {
  return steps?.find((s) => s.step === 0)?.settle_frame ?? null;
}

// ---------------------------------------------------------------------------------------------
// Delivery (pure): what the host's live log and tap say about credit and freshness
// ---------------------------------------------------------------------------------------------

/** A resolved state as one comparable string: numbers bit-exact (-0 kept apart from 0). The live
 * stream's session declares inline delivery where the file sinks declare out-of-band, but the
 * texture tables themselves (ids, versions, hashes, payload sizes) must agree. */
export function stateKey(t: RecordingSummary["transactions"][number]): string {
  return JSON.stringify(resolvedStateOf(t.meta), (_key, value) =>
    Object.is(value, -0) ? "-0" : value,
  );
}

export interface DeliveryReport {
  credit_stage: string | null;
  frame_lines: number;
  sends: number;
  dropped: number;
  /** independently recomputed: sends whose credit (an ack at the credit stage, or a resync, for
   * that seq) had not been logged when the next send happened */
  max_in_flight: number;
  in_flight_violations: string[];
  /** sends logged with `credit: false` */
  sent_without_credit: string[];
  max_queued_bytes: number;
  /** the largest credit window + QUEUED_SLACK_BYTES */
  queued_limit: number | null;
  queued_violations: string[];
  /** tapped transactions whose resolved state differs from the full recording at their frame */
  stale_states: string[];
  compared_states: number;
  /** host frames between consecutive sends (the delivery cadence) */
  send_gaps: number[];
}

/** The largest binary message of a live stream: the magic plus the session record (the first
 * message), or any later record (one per message: a resource, a transaction or the end record).
 * Null when the tap is missing. */
export function largestMessage(
  tapBytes: Uint8Array | undefined,
): number | null {
  if (!tapBytes) return null;
  const { records } = splitRecords(tapBytes);
  if (records.length === 0) return null;
  return Math.max(
    8 + records[0].byte_length,
    ...records.slice(1).map((r) => r.byte_length),
  );
}

/** The largest credit window of a live stream: the bytes a host may queue for one send, i.e. one
 * transaction plus every message sent since the previous transaction (the resource records the
 * transaction needs, which go out right before it in the same credit window, and for seq 1 the
 * magic and the session). A window that ends in no transaction (the end record, or what precedes
 * it) counts too. Null when the tap is missing. Equals largestMessage on a stream without
 * resource records, up to the session joining seq 1's window. */
export function largestCreditWindow(
  tapBytes: Uint8Array | undefined,
): number | null {
  if (!tapBytes) return null;
  const { records } = splitRecords(tapBytes);
  if (records.length === 0) return null;
  let largest = 0;
  let window = 8;
  for (const raw of records) {
    window += raw.byte_length;
    const type = decodeRecord(raw).record?.meta.type;
    if (type === "transaction" || type === "end") {
      largest = Math.max(largest, window);
      window = 0;
    }
  }
  return Math.max(largest, window);
}

export function deliveryReport(host: LiveHostEvidence): DeliveryReport {
  const log = host.log ?? [];
  const hello = log.find((l) => l.event === "hello");
  const creditStage = hello?.credit_stage ?? null;
  const outstanding = new Set<number>();
  const out: DeliveryReport = {
    credit_stage: creditStage,
    frame_lines: 0,
    sends: 0,
    dropped: 0,
    max_in_flight: 0,
    in_flight_violations: [],
    sent_without_credit: [],
    max_queued_bytes: 0,
    queued_limit: null,
    queued_violations: [],
    stale_states: [],
    compared_states: 0,
    send_gaps: [],
  };
  const largest = largestCreditWindow(host.tapBytes);
  out.queued_limit = largest === null ? null : largest + QUEUED_SLACK_BYTES;
  let lastSendFrame: number | null = null;
  for (const line of log) {
    if (line.event === "ack" || line.event === "resync") {
      const credits = line.event === "resync" || line.stage === creditStage;
      if (credits && line.seq !== undefined) outstanding.delete(line.seq);
      continue;
    }
    if (line.event !== undefined || line.state === undefined) continue;
    out.frame_lines++;
    const queued = line.queued_bytes ?? 0;
    out.max_queued_bytes = Math.max(out.max_queued_bytes, queued);
    if (out.queued_limit !== null && queued > out.queued_limit)
      out.queued_violations.push(
        `frame ${line.frame}: queued_bytes ${queued} > ${out.queued_limit}`,
      );
    const sent = line.sent;
    if (!sent) continue;
    if (line.credit !== true)
      out.sent_without_credit.push(`frame ${line.frame}: seq ${sent.seq}`);
    if (sent.dropped) {
      out.dropped++;
      continue;
    }
    out.sends++;
    if (lastSendFrame !== null) out.send_gaps.push(line.frame - lastSendFrame);
    lastSendFrame = line.frame;
    if (outstanding.size > 0)
      out.in_flight_violations.push(
        `frame ${line.frame}: seq ${sent.seq} sent while seq ${[...outstanding].join(",")} had no credit`,
      );
    outstanding.add(sent.seq);
    out.max_in_flight = Math.max(out.max_in_flight, outstanding.size);
  }
  if (host.log === undefined)
    out.in_flight_violations.push(
      `${liveLogName(host.connection)} missing or unparseable`,
    );
  const byFrame = new Map(host.full.transactions.map((t) => [t.meta.frame, t]));
  for (const t of host.tap.transactions) {
    out.compared_states++;
    const f = byFrame.get(t.meta.frame);
    if (!f)
      out.stale_states.push(
        `seq ${t.meta.seq} frame ${t.meta.frame}: no full-recording transaction`,
      );
    else if (stateKey(f) !== stateKey(t))
      out.stale_states.push(
        `seq ${t.meta.seq} frame ${t.meta.frame}: resolves to a state other than the full recording's`,
      );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Leg evaluation and classification
// ---------------------------------------------------------------------------------------------

export interface LiveLegEvaluation {
  leg: G1cLeg;
  legDir: string;
  /** the live host this leg's receiver talked to (live-replay: live's) */
  host: LiveHostEvidence;
  receiverDir: string;
  expected_class: Gate1Class;
  classification: Gate1Classification;
  exit_code: number | null;
  artifacts: string[];
  /** what the receiver consumed: received.rs2 (live legs) or its copy (live-replay) */
  received: RecordingSummary;
  applied: AppliedLive | undefined;
  /** shots by step: step -> seq (live legs: from applied.shots; live-replay: live's) */
  stepShots: Map<number, number>;
  checkpoints: Gate1Checkpoint[];
  compareOk: boolean;
  delivery: DeliveryReport | null;
  step0_settle: number | null;
  first_applied_frame: number | null;
}

export function arr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function reclassify(
  c: Gate1Classification,
  extra: string[],
  mismatchingSteps: number[] = c.mismatching_steps,
): Gate1Classification {
  const reasons = [...c.reasons, ...extra];
  const fired = new Set(reasons.map((r) => r.slice(0, r.indexOf(":"))));
  return {
    result_class: GATE1_CLASS_PRECEDENCE.find((x) => fired.has(x)) ?? "success",
    reasons: GATE1_CLASS_PRECEDENCE.flatMap((x) =>
      reasons.filter((r) => r.startsWith(`${x}:`)),
    ),
    mismatching_steps: mismatchingSteps,
    harmless_ties: c.harmless_ties,
  };
}

export async function shotFiles(dir: string): Promise<number[]> {
  try {
    return (await readdir(join(dir, "shots")))
      .map((n) => /^seq-(\d+)\.png$/.exec(n)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);
  } catch {
    return [];
  }
}

export function stepShotsOf(
  applied: AppliedLive | undefined,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of arr<{ step?: number | null; seq?: number }>(applied?.shots)) {
    if (Number.isInteger(s.step) && Number.isInteger(s.seq))
      out.set(s.step as number, s.seq as number);
  }
  return out;
}

export async function liveCheckpoints(
  leg: G1cLeg,
  outDir: string,
  receiverDir: string,
  stepShots: Map<number, number>,
  frames: Map<number, number>,
  expected: Gate1Expected,
): Promise<{ checkpoints: Gate1Checkpoint[]; compareOk: boolean }> {
  const join_: StepJoin = {
    ok: true,
    entries: expected.steps.map((s) => {
      const seq = stepShots.get(s.step) ?? null;
      return {
        step: s.step,
        settle_frame: seq === null ? -1 : (frames.get(seq) ?? -1),
        seq,
      };
    }),
    problems: [],
  };
  return computeGate1Checkpoints(
    leg,
    "patch",
    join_,
    join(outDir, "reference", "shots"),
    join(receiverDir, "shots"),
    join(receiverDir, "diff"),
    expected,
  );
}

export function checkpointMismatch(c: Gate1Checkpoint): boolean {
  const bad = (n: number | null): boolean => n === null || n > 0;
  return (
    bad(c.mismatched_pixels) ||
    bad(c.max_channel_delta) ||
    c.regions.some((r) => bad(r.mismatched_pixels) || bad(r.max_channel_delta))
  );
}

export async function existing(paths: string[]): Promise<string[]> {
  const flags = await Promise.all(paths.map(fileExists));
  return [...new Set(paths.filter((_, i) => flags[i]))];
}

export function processArtifacts(dirs: string[]): string[] {
  return dirs.flatMap((dir) => [
    join(dir, "argv.txt"),
    join(dir, "env.txt"),
    join(dir, "stdout.log"),
    join(dir, "exit-code.txt"),
    join(dir, "evidence", "result.json"),
    join(dir, "evidence", "live.json"),
    join(dir, "evidence", "live-summary.json"),
    join(dir, RECORDING_NAME),
    join(dir, PATCH_RECORDING_NAME),
    join(dir, "steps.jsonl"),
    join(dir, "tap", TAP_NAME),
    join(dir, "tap", LIVE_LOG_NAME),
    join(dir, "applied.json"),
    join(dir, RECEIVED_NAME),
    join(dir, "strace.txt"),
  ]);
}

/** The receiver-side rules of a live leg (rule 3, replay-failure). */
export function liveReplayReasons(
  e: Pick<
    LiveLegEvaluation,
    | "applied"
    | "received"
    | "host"
    | "stepShots"
    | "first_applied_frame"
    | "step0_settle"
  >,
  rendered: boolean,
  expected: Gate1Expected,
): string[] {
  const out: string[] = [];
  const fire = (r: string) => out.push(`replay-failure: ${r}`);
  const applied = e.applied;
  if (!applied) {
    fire("applied.json missing or unparseable");
    return out;
  }
  if (applied.status !== "ok")
    fire(
      `status=${JSON.stringify(applied.status)} failure=${JSON.stringify(applied.failure ?? null)}`,
    );
  if (applied.end_seen !== true) fire("end_seen is not true");
  if (applied.mode !== "live")
    fire(`mode ${JSON.stringify(applied.mode)}, expected live`);
  if (!e.received.present) fire(`${RECEIVED_NAME} missing`);
  else if (e.received.errors.length > 0)
    fire(`received stream invalid: ${e.received.errors[0]}`);
  if (
    e.host.tap.present &&
    e.received.present &&
    e.host.tap.sha256 !== e.received.sha256
  )
    fire(
      `received bytes (${e.received.bytes}, ${e.received.sha256}) differ from the host's tap (${e.host.tap.bytes}, ${e.host.tap.sha256})`,
    );
  const tx = arr<{ seq?: number; record_sha256?: string }>(
    applied.transactions,
  );
  const host = e.received.transactions;
  if (
    tx.length !== host.length ||
    tx.some(
      (t, i) =>
        t.seq !== host[i].meta.seq || t.record_sha256 !== host[i].sha256,
    )
  )
    fire(
      `applied transactions are not exactly the received stream's (${tx.length} entries, ${host.length} received)`,
    );
  if (e.step0_settle === null) fire("host steps.jsonl has no step 0");
  else if (e.first_applied_frame === null) fire("no transaction applied");
  else if (e.first_applied_frame >= e.step0_settle)
    fire(
      `receiver-late: first applied transaction has frame ${e.first_applied_frame} >= step 0's settle frame ${e.step0_settle}`,
    );
  if (rendered) {
    const missing = expected.steps
      .map((s) => s.step)
      .filter((k) => !e.stepShots.has(k));
    if (missing.length > 0)
      fire(
        `no shot for step(s) ${missing.join(",")} (shots_missed ${JSON.stringify(applied.shots_missed ?? null)})`,
      );
  }
  return out;
}

export function deliveryReasons(d: DeliveryReport): string[] {
  const out: string[] = [];
  const fire = (r: string) => out.push(`delivery-violation: ${r}`);
  if (d.in_flight_violations.length > 0)
    fire(
      `more than one transaction in flight: ${d.in_flight_violations.slice(0, 2).join("; ")}`,
    );
  if (d.sent_without_credit.length > 0)
    fire(
      `sent without credit: ${d.sent_without_credit.slice(0, 2).join("; ")}`,
    );
  if (d.queued_violations.length > 0)
    fire(
      `queued bytes above one message + ${QUEUED_SLACK_BYTES}: ${d.queued_violations[0]}`,
    );
  if (d.stale_states.length > 0)
    fire(
      `stale-state: ${d.stale_states.slice(0, 2).join("; ")}${d.stale_states.length > 2 ? ` (+${d.stale_states.length - 2} more)` : ""}`,
    );
  return out;
}

export async function evaluateLiveLeg(
  outDir: string,
  leg: G1cLeg,
  expected: Gate1Expected,
  hosts: Map<LiveHostLeg, LiveHostEvidence>,
): Promise<LiveLegEvaluation> {
  const legDir = join(outDir, leg);
  const hostLeg: LiveHostLeg = leg === "live-replay" ? "live" : leg;
  let host = hosts.get(hostLeg);
  if (!host) {
    host = await loadLiveHost(join(outDir, hostLeg, "host"));
    hosts.set(hostLeg, host);
  }
  const receiverDir = leg === "live-replay" ? legDir : join(legDir, "receiver");
  const applied = await readJson<AppliedLive>(
    join(receiverDir, "applied.json"),
  );
  const appliedOk =
    applied !== undefined && applied !== null && typeof applied === "object";
  const received = await loadRecording(
    join(receiverDir, leg === "live-replay" ? RECORDING_NAME : RECEIVED_NAME),
  );
  const frames = new Map(
    received.transactions.map((t) => [t.meta.seq, t.meta.frame]),
  );
  const step0_settle = step0Settle(host.steps);

  let classification: Gate1Classification;
  let stepShots: Map<number, number>;
  let checkpoints: Gate1Checkpoint[] = [];
  let compareOk = true;
  let delivery: DeliveryReport | null = null;
  let firstApplied: number | null = null;

  if (leg === "live-replay") {
    // A file-mode receiver on the live receiver's received stream, shooting the live shots' seqs.
    const live = await readJson<AppliedLive>(
      join(outDir, "live", "receiver", "applied.json"),
    );
    stepShots = stepShotsOf(live);
    ({ checkpoints, compareOk } = await liveCheckpoints(
      leg,
      outDir,
      receiverDir,
      stepShots,
      frames,
      expected,
    ));
    const base = classifyLeg({
      captureResult: host.captureResult,
      recording: received,
      receiver: {
        applied: appliedOk ? applied : undefined,
        requestedShotSeqs: [...stepShots.values()],
        shotFiles: await shotFiles(receiverDir),
      },
      checkpoints,
    });
    const extra: string[] = [];
    if (stepShots.size !== expected.steps.length)
      extra.push(
        `replay-failure: the live leg shot ${stepShots.size} steps, expected ${expected.steps.length}`,
      );
    classification = reclassify(
      classifyGate1(base, received.session, null),
      extra,
    );
  } else {
    const rendered = RENDERED[leg];
    stepShots = stepShotsOf(appliedOk ? applied : undefined);
    const firstTx = arr<{ frame?: number; applied_us?: number | null }>(
      appliedOk ? applied?.transactions : [],
    ).find((t) => t.applied_us !== null && t.applied_us !== undefined);
    firstApplied = firstTx?.frame ?? null;
    if (rendered)
      ({ checkpoints, compareOk } = await liveCheckpoints(
        leg,
        outDir,
        receiverDir,
        stepShots,
        frames,
        expected,
      ));
    const base = classifyLeg({
      captureResult: host.captureResult,
      recording: host.full,
      checkpoints: [],
    });
    const extra: string[] = [];
    if (host.live?.status !== "listening")
      extra.push(
        `capture-failure: the live listener is ${JSON.stringify(host.live?.status ?? null)} (${host.live?.reason ?? "no evidence/live.json"})`,
      );
    if (!host.tap.present)
      extra.push(`capture-failure: tap/${TAP_NAME} missing`);
    else if (tapErrors(host).length > 0)
      extra.push(
        `capture-failure: tap/${TAP_NAME} invalid: ${tapErrors(host)[0]}`,
      );
    extra.push(
      ...liveReplayReasons(
        {
          applied: appliedOk ? applied : undefined,
          received,
          host,
          stepShots,
          first_applied_frame: firstApplied,
          step0_settle,
        },
        rendered,
        expected,
      ),
    );
    delivery = deliveryReport(host);
    extra.push(...deliveryReasons(delivery));
    const mismatching: number[] = [];
    for (const c of checkpoints) {
      if (checkpointMismatch(c)) {
        mismatching.push(c.step);
        extra.push(
          `pixel-mismatch: step ${c.step} (seq ${c.seq}): ${c.mismatched_pixels ?? "unreadable"} mismatched pixels, max channel delta ${c.max_channel_delta ?? "?"}`,
        );
      }
    }
    classification = reclassify(
      classifyGate1(
        base,
        host.full.session,
        patchDivergence(host.full, host.patch),
      ),
      extra,
      mismatching,
    );
  }

  return {
    leg,
    legDir,
    host,
    receiverDir,
    expected_class: G1C_EXPECTATIONS[leg].class,
    classification,
    exit_code: await readExitCode(receiverDir),
    artifacts: await existing(
      processArtifacts(
        leg === "live-replay" ? [receiverDir] : [host.dir, receiverDir],
      ),
    ),
    received,
    applied: appliedOk ? applied : undefined,
    stepShots,
    checkpoints,
    compareOk,
    delivery,
    step0_settle,
    first_applied_frame: firstApplied,
  };
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

type Evals = Map<G1cLeg, LiveLegEvaluation>;

function hostEvals(evals: Evals): LiveLegEvaluation[] {
  return LIVE_HOST_LEGS.map((l) => evals.get(l)).filter(
    (e): e is LiveLegEvaluation => e !== undefined,
  );
}

export async function checkLiveListening(evals: Evals): Promise<Gate1Check> {
  const problems: string[] = [];
  const evidence: string[] = [];
  for (const e of hostEvals(evals)) {
    const live = e.host.live;
    const path = join(e.host.dir, "evidence", "live.json");
    evidence.push(path);
    if (!live) {
      problems.push(`${e.leg}: evidence/live.json missing`);
      continue;
    }
    if (live.schema !== "render-stream-live/1")
      problems.push(`${e.leg}: schema ${JSON.stringify(live.schema)}`);
    if (live.status !== "listening")
      problems.push(
        `${e.leg}: status ${JSON.stringify(live.status)} (${live.reason ?? ""})`,
      );
    if (live.address !== "127.0.0.1" && live.address !== "::1")
      problems.push(
        `${e.leg}: address ${JSON.stringify(live.address)} is not loopback`,
      );
    const port = live.port;
    if (
      !Number.isInteger(port) ||
      (port as number) < 1 ||
      (port as number) > 65535
    )
      problems.push(`${e.leg}: port ${JSON.stringify(port)}`);
    if (e.host.captureResult?.live?.port !== port)
      problems.push(
        `${e.leg}: result.json live.port ${JSON.stringify(e.host.captureResult?.live?.port)} != live.json ${port}`,
      );
    const url = e.applied?.live?.url ?? "";
    const host = live.address === "::1" ? "[::1]" : live.address;
    if (url !== `ws://${host}:${port}/render-stream`)
      problems.push(
        `${e.leg}: the receiver used ${JSON.stringify(url)}, not the port from evidence`,
      );
  }
  if (hostEvals(evals).length !== LIVE_HOST_LEGS.length)
    problems.push("not every live host leg was evaluated");
  return check(
    "live-listening",
    "every live host wrote evidence/live.json (render-stream-live/1) status listening on a loopback address and an ephemeral port, result.json live.port agrees, and its receiver connected to exactly that port",
    problems,
    hostEvals(evals)
      .map((e) => `${e.leg} ${e.host.live?.address}:${e.host.live?.port}`)
      .join(", "),
    evidence,
  );
}

export async function checkLiveHandshake(evals: Evals): Promise<Gate1Check> {
  const problems: string[] = [];
  const evidence: string[] = [];
  for (const leg of ["live", "live-headless"] as const) {
    const e = evals.get(leg);
    if (!e) {
      problems.push(`${leg} not evaluated`);
      continue;
    }
    const log = join(e.receiverDir, "stdout.log");
    evidence.push(log, join(e.host.dir, "evidence", "live-summary.json"));
    const text = (await readTextOrUndefined(log)) ?? "";
    if (!text.includes(`(subprotocol ${SUBPROTOCOL})`))
      problems.push(
        `${leg}: the receiver did not report subprotocol ${SUBPROTOCOL}`,
      );
    const conns = e.host.summary?.connections ?? [];
    if (conns.length !== 1) {
      problems.push(
        `${leg}: ${conns.length} connections in live-summary.json, expected 1`,
      );
      continue;
    }
    const c = conns[0];
    const stage = RENDERED[leg] ? "submitted" : "applied";
    if (c.credit_stage !== stage)
      problems.push(
        `${leg}: credit_stage ${JSON.stringify(c.credit_stage)}, expected ${stage}`,
      );
    if (c.error_sent)
      problems.push(`${leg}: the host sent error ${c.error_sent}`);
    if (!c.end_sent) problems.push(`${leg}: no end record sent`);
    if (c.closed_by !== "receiver" || c.close_code !== 1000)
      problems.push(
        `${leg}: closed by ${JSON.stringify(c.closed_by)} with ${JSON.stringify(c.close_code)}, expected the receiver with 1000 after its end record`,
      );
    if (!e.host.log?.some((l) => l.event === "hello"))
      problems.push(`${leg}: no hello in the host's live log`);
    if (
      (c.inbound_buffer_bytes ?? 0) !==
      (e.applied?.live?.inbound_buffer_bytes ?? -1)
    )
      problems.push(
        `${leg}: hello.inbound_buffer_bytes ${c.inbound_buffer_bytes} != the receiver's ${e.applied?.live?.inbound_buffer_bytes}`,
      );
  }
  return check(
    "live-handshake",
    "live and live-headless: the receiver negotiated subprotocol render-stream.4 (render-stream.3 from G4e2, render-stream.2 before), the host logged its hello (credit stage submitted / applied, inbound buffer as configured), served exactly one connection with no error or refusal, sent the end record, and the receiver closed with 1000 after reading it",
    problems,
    "one connection each, hello, end record, closed by the receiver with 1000",
    evidence,
  );
}

export function checkLiveTapEqualsReceived(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const evidence: string[] = [];
  for (const leg of ["live", "live-headless"] as const) {
    const e = evals.get(leg);
    if (!e) {
      problems.push(`${leg} not evaluated`);
      continue;
    }
    evidence.push(e.host.tap.path, e.received.path);
    if (!e.host.tap.present) problems.push(`${leg}: tap missing`);
    if (!e.received.present) problems.push(`${leg}: received stream missing`);
    if (
      e.host.tap.present &&
      e.received.present &&
      e.host.tap.sha256 !== e.received.sha256
    )
      problems.push(
        `${leg}: tap ${e.host.tap.bytes} B ${e.host.tap.sha256} != received ${e.received.bytes} B ${e.received.sha256}`,
      );
    const stream = e.applied?.streams?.[0];
    if (
      stream?.received_sha256 !== e.received.sha256 ||
      stream?.received_bytes !== e.received.bytes
    )
      problems.push(
        `${leg}: applied.json streams[0] does not describe the received file`,
      );
  }
  return check(
    "live-tap-equals-received",
    "live and live-headless: the bytes the receiver wrote to received.rs2 are exactly the host's tap of connection 1 (same length, same sha256; resource records included), as applied.json streams[0] reports",
    problems,
    ["live", "live-headless"]
      .map((l) => `${l} ${evals.get(l as G1cLeg)?.received.bytes ?? "?"} B`)
      .join(", "),
    evidence,
  );
}

export function checkLiveDecodes(evals: Evals): Gate1Check {
  const problems: string[] = [];
  for (const leg of ["live", "live-headless"] as const) {
    const e = evals.get(leg);
    if (!e) problems.push(`${leg} not evaluated`);
    else if (!e.received.present)
      problems.push(`${leg}: received stream missing`);
    else if (e.received.errors.length > 0)
      problems.push(`${leg}: ${e.received.errors.slice(0, 2).join(" | ")}`);
  }
  return check(
    "live-decodes",
    "validateRecording(received.rs2) is [] for live and live-headless (framing, meta, patch rules, invariants, resource records, end stats)",
    problems,
    "both received streams validate",
    ["live", "live-headless"].map(
      (l) => evals.get(l as G1cLeg)?.received.path ?? l,
    ),
  );
}

export function checkLiveFirstFullThenPatch(evals: Evals): Gate1Check {
  const problems: string[] = [];
  for (const leg of ["live", "live-headless"] as const) {
    const e = evals.get(leg);
    if (!e) {
      problems.push(`${leg} not evaluated`);
      continue;
    }
    const s = e.received.session;
    const stream = s?.stream;
    if (
      stream?.transport !== "websocket" ||
      stream?.connection !== 1 ||
      stream?.encoding !== "patch"
    )
      problems.push(
        `${leg}: session stream ${JSON.stringify(stream ?? null)}, expected websocket, connection 1, patch`,
      );
    if (
      s?.session_id === undefined ||
      s.session_id !== e.host.full.session?.session_id
    )
      problems.push(
        `${leg}: session_id ${s?.session_id} != the file sinks' ${e.host.full.session?.session_id}`,
      );
    const fileStreams = [
      e.host.full.session?.stream?.stream_id,
      e.host.patch.session?.stream?.stream_id,
    ];
    if (
      stream?.stream_id === undefined ||
      fileStreams.includes(stream.stream_id)
    )
      problems.push(`${leg}: the live stream_id is not fresh`);
    if (stream?.stream_id !== e.host.summary?.connections?.[0]?.stream_id)
      problems.push(`${leg}: stream_id differs from live-summary.json's`);
    const tx = e.received.transactions;
    if (tx.length === 0) problems.push(`${leg}: no transactions`);
    tx.forEach((t, i) => {
      const want =
        i === 0
          ? t.meta.encoding === "full" && t.meta.base_seq === null
          : t.meta.encoding === "patch" && t.meta.base_seq === t.meta.seq - 1;
      if (!want && problems.length < 6)
        problems.push(
          `${leg}: seq ${t.meta.seq} is ${t.meta.encoding} with base_seq ${t.meta.base_seq}`,
        );
    });
  }
  return check(
    "live-first-full-then-patch",
    "live and live-headless: the session declares transport websocket, connection 1, encoding patch, the capture session's session_id and a fresh stream_id; seq 1 is full (base_seq null) and every later seq a patch on seq - 1",
    problems,
    ["live", "live-headless"]
      .map(
        (l) =>
          `${l}: ${evals.get(l as G1cLeg)?.received.transactions.length ?? 0} transactions`,
      )
      .join(", "),
    ["live", "live-headless"].map(
      (l) => evals.get(l as G1cLeg)?.received.path ?? l,
    ),
  );
}

export function checkLiveResolvesToRecording(evals: Evals): Gate1Check {
  const problems: string[] = [];
  let compared = 0;
  for (const leg of ["live", "live-headless"] as const) {
    const e = evals.get(leg);
    if (!e?.delivery) {
      problems.push(`${leg} not evaluated`);
      continue;
    }
    compared += e.delivery.compared_states;
    if (e.delivery.compared_states === 0)
      problems.push(`${leg}: nothing compared`);
    for (const s of e.delivery.stale_states.slice(0, 3))
      problems.push(`${leg}: ${s}`);
    if (e.host.tap.sha256 !== e.received.sha256)
      problems.push(
        `${leg}: compared on the tap, which differs from the received stream`,
      );
  }
  return check(
    "live-resolves-to-recording",
    "every live transaction (live and live-headless), resolved, equals the full file recording's state at its frame (texture table and default filter/repeat included), floats bit for bit",
    problems,
    `${compared} live transactions equal the full recording at their frames`,
    ["live", "live-headless"].map(
      (l) => evals.get(l as G1cLeg)?.host.tap.path ?? l,
    ),
  );
}

export async function samePng(
  a: string,
  b: string,
): Promise<string | undefined> {
  const pa = await decodePngRgba(a);
  const pb = await decodePngRgba(b);
  if (!pa || !pb) return `${!pa ? a : b} missing or unreadable`;
  if (pa.width !== pb.width || pa.height !== pb.height)
    return `${a} and ${b} differ in size`;
  const d = diffRgba(pa.data, pb.data, pa.width, pa.height);
  return d.mismatched_pixels > 0
    ? `${a} vs ${b}: ${d.mismatched_pixels} px differ`
    : undefined;
}

export async function checkLiveReplayEqualsLive(
  evals: Evals,
): Promise<Gate1Check> {
  const live = evals.get("live");
  const replay = evals.get("live-replay");
  const problems: string[] = [];
  const evidence: string[] = [];
  if (!live || !replay) {
    problems.push("live or live-replay not evaluated");
  } else {
    const a = arr<{ seq?: number; record_sha256?: string }>(
      live.applied?.transactions,
    );
    const b = arr<{ seq?: number; record_sha256?: string }>(
      replay.applied?.transactions,
    );
    if (replay.applied?.status !== "ok")
      problems.push(
        `live-replay status ${JSON.stringify(replay.applied?.status)}`,
      );
    if (a.length === 0 || a.length !== b.length)
      problems.push(`${a.length} live transactions, ${b.length} replayed`);
    const bad = a.findIndex(
      (t, i) => t.seq !== b[i]?.seq || t.record_sha256 !== b[i]?.record_sha256,
    );
    if (bad >= 0)
      problems.push(
        `index ${bad}: live seq ${a[bad].seq} differs from the replay's (seq or record hash)`,
      );
    // Files are taken from each leg's own directory by seq (shots/seq-<n>.png, state/seq-<n>.json),
    // never from paths quoted in applied.json.
    const replayShots = new Set(
      arr<{ seq?: number }>(replay.applied?.shots).map((s) => s.seq),
    );
    for (const seq of live.stepShots.values()) {
      if (!replayShots.has(seq)) {
        problems.push(`seq ${seq}: no replay shot`);
        continue;
      }
      const shotA = join(live.receiverDir, "shots", `seq-${seq}.png`);
      const shotB = join(replay.receiverDir, "shots", `seq-${seq}.png`);
      evidence.push(shotA, shotB);
      const p = await samePng(shotA, shotB);
      if (p) problems.push(p);
      const sa = (
        await readTextOrUndefined(
          join(live.receiverDir, "state", `seq-${seq}.json`),
        )
      )?.trim();
      const sb = (
        await readTextOrUndefined(
          join(replay.receiverDir, "state", `seq-${seq}.json`),
        )
      )?.trim();
      if (sa === undefined || sb === undefined)
        problems.push(`seq ${seq}: a state dump is missing`);
      else if (sa !== sb) problems.push(`seq ${seq}: state dumps differ`);
    }
    if (live.stepShots.size === 0) problems.push("the live leg took no shots");
  }
  return check(
    "live-replay-equals-live",
    "a file-mode receiver replaying the live receiver's received.rs2 applies the same seqs with the same record hashes, and its shots and state dumps at the live shots' seqs are identical to the live receiver's",
    problems,
    `${live?.stepShots.size ?? 0} shots and state dumps identical; ${arr(live?.applied?.transactions).length} transactions with identical hashes`,
    evidence,
  );
}

export async function checkLiveVsReference(
  evals: Evals,
  expected: Gate1Expected,
): Promise<Gate1Check> {
  const live = evals.get("live");
  const problems: string[] = [];
  const evidence: string[] = [];
  if (!live) problems.push("live not evaluated");
  else {
    if (live.checkpoints.length !== expected.steps.length)
      problems.push(
        `${live.checkpoints.length} checkpoints, expected ${expected.steps.length}`,
      );
    for (const c of live.checkpoints) {
      evidence.push(
        c.reference_png,
        ...(c.receiver_png ? [c.receiver_png] : []),
      );
      if (checkpointMismatch(c))
        problems.push(
          `step ${c.step} (seq ${c.seq}): ${c.mismatched_pixels ?? "no shot"} px differ from the reference`,
        );
      const synth = await compareWithSynth(c.receiver_png, expected, c.step);
      if (synth) problems.push(synth);
    }
  }
  return check(
    "live-vs-reference",
    "the live receiver shot every step (one transaction inside each step window) and each shot equals the reference's step-<k>.png and synthesizeGate1(k) exactly (full frame and every region)",
    problems,
    `${live?.checkpoints.length ?? 0} live shots identical to the reference and the synthesized images`,
    evidence,
  );
}

export function checkLiveCreditBounded(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const e of hostEvals(evals)) {
    const d = e.delivery;
    if (!d) {
      problems.push(`${e.leg}: no delivery report`);
      continue;
    }
    if (d.frame_lines === 0 || d.sends === 0)
      problems.push(`${e.leg}: no frame lines or no sends logged`);
    for (const v of [
      ...d.in_flight_violations,
      ...d.sent_without_credit,
      ...d.queued_violations,
    ].slice(0, 3))
      problems.push(`${e.leg}: ${v}`);
    if (d.max_in_flight > 1)
      problems.push(`${e.leg}: max in flight ${d.max_in_flight}`);
    const summary = e.host.summary?.connections?.[0];
    if (summary && (summary.max_in_flight ?? 0) > 1)
      problems.push(
        `${e.leg}: the host reports max_in_flight ${summary.max_in_flight}`,
      );
    notes.push(
      `${e.leg}: ${d.sends} sends${d.dropped ? ` + ${d.dropped} dropped` : ""} over ${d.frame_lines} frames, max queued ${d.max_queued_bytes} <= ${d.queued_limit}`,
    );
  }
  return check(
    "live-credit-bounded",
    "every live host log: recomputed from its own ack/resync lines, at most one transaction in flight; no send logged without credit; queued_bytes never above the connection's largest credit window (a transaction and the resource records sent ahead of it) + 4096",
    problems,
    notes.join("; "),
    hostEvals(evals).map((e) => join(e.host.dir, "tap", LIVE_LOG_NAME)),
  );
}

export function checkLiveAcksStaged(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of ["live", "live-headless"] as const) {
    const e = evals.get(leg);
    if (!e?.applied) {
      problems.push(`${leg}: applied.json missing`);
      continue;
    }
    const rendered = RENDERED[leg];
    const tx = arr<{
      seq?: number;
      received_us?: number | null;
      applied_us?: number | null;
      submitted_us?: number | null;
    }>(e.applied.transactions);
    let bad = 0;
    for (const t of tx) {
      const r = t.received_us;
      const a = t.applied_us;
      const s = t.submitted_us;
      const ok =
        typeof r === "number" &&
        typeof a === "number" &&
        r <= a &&
        (rendered ? typeof s === "number" && a <= s : s === null);
      if (!ok && bad++ < 3)
        problems.push(
          `${leg} seq ${t.seq}: received ${r}, applied ${a}, submitted ${s}`,
        );
    }
    if (tx.length === 0) problems.push(`${leg}: no transactions`);
    const live = e.applied.live;
    if (live?.presented !== "unavailable")
      problems.push(
        `${leg}: presented is ${JSON.stringify(live?.presented)}, not "unavailable"`,
      );
    const stage = rendered ? "submitted" : "applied";
    if (live?.credit_stage !== stage)
      problems.push(
        `${leg}: receiver credit_stage ${live?.credit_stage}, expected ${stage}`,
      );
    const c = e.host.summary?.connections?.[0];
    const sent = c?.sent ?? -1;
    const acks = c?.acks ?? {};
    if (
      acks.received !== sent ||
      acks.applied !== sent ||
      acks.submitted !== (rendered ? sent : 0)
    )
      problems.push(
        `${leg}: the host saw acks ${JSON.stringify(acks)} for ${sent} sent transactions (expected received = applied = ${rendered ? "submitted = " : ""}sent${rendered ? "" : ", submitted 0"})`,
      );
    const sentByReceiver = live?.acks_sent ?? {};
    if (
      sentByReceiver.received !== acks.received ||
      sentByReceiver.applied !== acks.applied ||
      sentByReceiver.submitted !== acks.submitted
    )
      problems.push(
        `${leg}: the receiver sent acks ${JSON.stringify(sentByReceiver)}, the host saw ${JSON.stringify(acks)}`,
      );
    notes.push(
      `${leg}: ${tx.length} transactions, host acks ${acks.received}/${acks.applied}/${acks.submitted}`,
    );
  }
  return check(
    "live-acks-staged",
    "per seq, the receiver's received_us <= applied_us <= submitted_us (submitted null headless); the host saw received, applied and (rendered) submitted acks for every transaction it sent and the receiver's ack counts; presented is \"unavailable\"",
    problems,
    notes.join("; "),
    ["live", "live-headless"].map((l) =>
      join(evals.get(l as G1cLeg)?.receiverDir ?? l, "applied.json"),
    ),
  );
}

export function checkLiveReceiverLate(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const e of hostEvals(evals)) {
    if (e.step0_settle === null)
      problems.push(`${e.leg}: host steps.jsonl has no step 0`);
    else if (e.first_applied_frame === null)
      problems.push(`${e.leg}: nothing applied`);
    else if (e.first_applied_frame >= e.step0_settle)
      problems.push(
        `${e.leg}: first applied frame ${e.first_applied_frame} >= ${e.step0_settle}`,
      );
    notes.push(
      `${e.leg} first applied at host frame ${e.first_applied_frame} (< ${e.step0_settle})`,
    );
  }
  return check(
    "live-receiver-late",
    "every live receiver applied its first transaction at a host frame before step 0's settle frame (S + 7), so no step was over before it joined",
    problems,
    notes.join("; "),
    hostEvals(evals).map((e) => join(e.receiverDir, "applied.json")),
  );
}

export async function checkLiveReceiverNeverLoadedFixture(
  outDir: string,
  evals: Evals,
  paths: { receiverProjectDir: string; fixtureProjectDir: string },
): Promise<Gate1Check> {
  const legDir = join(outDir, "live-headless", "receiver");
  const stracePath = join(legDir, "strace.txt");
  const fixturesRoot = join(paths.fixtureProjectDir, "..");
  const problems: string[] = [];
  if (await fileExists(join(legDir, "strace-status.txt")))
    problems.push("strace was not installed when live-headless ran");
  const strace = await readTextOrUndefined(stracePath);
  if (!strace)
    problems.push("live-headless/receiver/strace.txt missing or empty");
  else {
    const opened = successfulOpenats(strace);
    const fixtureOpens = opened.filter(
      (l) =>
        l.includes(`${fixturesRoot}/`) ||
        l.includes("/experiments/render-stream/fixtures/"),
    );
    if (fixtureOpens.length > 0)
      problems.push(
        `${fixtureOpens.length} successful openat under fixtures/: ${fixtureOpens[0]}`,
      );
    if (!opened.some((l) => l.includes(join(legDir, RECEIVED_NAME))))
      problems.push(
        `no successful openat of ${join(legDir, RECEIVED_NAME)} in the trace`,
      );
  }
  const argv =
    (await readTextOrUndefined(join(legDir, "argv.txt")))
      ?.split("\n")
      .map((l) => l.trim()) ?? [];
  const i = argv.indexOf("--path");
  if (i < 0 || argv[i + 1] !== paths.receiverProjectDir)
    problems.push(
      `live-headless argv.txt does not pass --path ${paths.receiverProjectDir}`,
    );
  const logs = [...G1C_CLASSIFIED_LEGS].map((l) =>
    join(evals.get(l)?.receiverDir ?? join(outDir, l), "stdout.log"),
  );
  for (const log of logs) {
    const text = await readTextOrUndefined(log);
    if (text === undefined) problems.push(`${log} missing`);
    const line = text?.split("\n").find((l) => l.includes("[fixture]"));
    if (line) problems.push(`${log} has a [fixture] line: ${line}`);
  }
  return check(
    "receiver-never-loaded-fixture-live",
    "the headless live receiver's trace opens nothing under fixtures/ and does open (writes) its received.rs2; argv passes --path <abs receiver>; no live receiver log has a [fixture] line",
    problems,
    `0 fixture opens; ${logs.length} live receiver logs clean`,
    [stracePath, ...logs],
  );
}

export async function checkLiveLegClass(
  e: LiveLegEvaluation,
): Promise<Gate1Check> {
  const exp = G1C_EXPECTATIONS[e.leg];
  const c = e.classification;
  const problems: string[] = [];
  if (c.result_class !== exp.class)
    problems.push(`class ${c.result_class}, expected ${exp.class}`);
  if (
    exp.reasonIncludes &&
    !c.reasons.some((r) => r.includes(exp.reasonIncludes as string))
  )
    problems.push(`no reason mentions ${exp.reasonIncludes}`);
  if (e.leg === "sabotage-drop-message") {
    // The sabotage must be the cause: the host dropped exactly one transaction, and the receiver
    // stopped at the seq right after it.
    const d = e.delivery;
    if (d?.dropped !== 1)
      problems.push(
        `the host logged ${d?.dropped ?? "?"} dropped transactions, expected 1`,
      );
    const dropped = e.host.log?.find((l) => l.sent?.dropped)?.sent?.seq;
    const failure = e.applied?.failure;
    if (dropped === undefined || failure?.seq !== dropped + 1)
      problems.push(
        `the receiver failed at seq ${failure?.seq ?? "?"}, expected ${dropped === undefined ? "?" : dropped + 1} (the one after the dropped seq)`,
      );
    if (tapErrors(e.host).length > 0)
      problems.push(`the tap is not a valid stream: ${tapErrors(e.host)[0]}`);
  }
  return check(
    `leg-class-${e.leg}`,
    `the ${e.leg} leg classifies as ${exp.class}${exp.reasonIncludes ? ` with a ${exp.reasonIncludes} reason` : ""}${e.leg === "sabotage-drop-message" ? ", the receiver failing at the seq after the one dropped" : ""}`,
    problems,
    `${c.result_class}${c.reasons.length > 0 ? ` (${c.reasons.slice(0, 2).join(" | ")})` : ""}${c.harmless_ties.length > 0 ? `; harmless ties ${c.harmless_ties.join(",")}` : ""}`,
    e.artifacts,
  );
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export interface LiveLegReport {
  connections: LiveConnectionSummary[];
  delivery:
    | (Omit<DeliveryReport, "send_gaps"> & {
        send_gap_frames: { min: number; median: number; max: number } | null;
      })
    | null;
  receiver: {
    transactions: number;
    applied: number;
    submitted: number;
    shots: number;
    received_bytes: number | null;
    acks_sent: unknown;
    presented: string | null;
    /** receiver-side stage latencies, microseconds: received -> applied, applied -> submitted */
    received_to_applied_us: { min: number; median: number; max: number } | null;
    applied_to_submitted_us: {
      min: number;
      median: number;
      max: number;
    } | null;
  };
  first_applied_frame: number | null;
}

export function spread(
  values: number[],
): { min: number; median: number; max: number } | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  return {
    min: v[0],
    median: v[Math.floor((v.length - 1) / 2)],
    max: v[v.length - 1],
  };
}

export function liveLegReport(e: LiveLegEvaluation): LiveLegReport {
  const tx = arr<{
    received_us?: number | null;
    applied_us?: number | null;
    submitted_us?: number | null;
  }>(e.applied?.transactions);
  const num = (v: unknown): v is number => typeof v === "number";
  const delivery = e.delivery;
  return {
    // live-replay has no host of its own: its connection is the live leg's, reported there.
    connections:
      e.leg === "live-replay" ? [] : (e.host.summary?.connections ?? []),
    delivery: delivery
      ? (() => {
          const { send_gaps, ...rest } = delivery;
          return { ...rest, send_gap_frames: spread(send_gaps) };
        })()
      : null,
    receiver: {
      transactions: tx.length,
      applied: tx.filter((t) => num(t.applied_us)).length,
      submitted: tx.filter((t) => num(t.submitted_us)).length,
      shots: arr(e.applied?.shots).length,
      received_bytes: e.received.present ? e.received.bytes : null,
      acks_sent: e.applied?.live?.acks_sent ?? null,
      presented: e.applied?.live?.presented ?? null,
      received_to_applied_us: spread(
        tx
          .filter((t) => num(t.received_us) && num(t.applied_us))
          .map((t) => (t.applied_us as number) - (t.received_us as number)),
      ),
      applied_to_submitted_us: spread(
        tx
          .filter((t) => num(t.applied_us) && num(t.submitted_us))
          .map((t) => (t.submitted_us as number) - (t.applied_us as number)),
      ),
    },
    first_applied_frame: e.first_applied_frame,
  };
}
