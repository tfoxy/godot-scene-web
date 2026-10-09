// Gate 1 G1d checks and leg classification (protocol/gate1-design.md "G1d", "Q4", "Q7"): group
// g1d, a receiver stall with coalescing and newest-state recovery, resync, reconnect, a killed
// receiver, and the ignore-credit and stale-coalesce sabotages. Pure over an evidence directory
// written by run-gate1.sh, so scripts/test/self-test-gate1.ts drives it with fabricated trees.
//
// Evidence layout under <out>/ (scripts/README.md "Gate 1"), every leg with the g1c host setup:
//   <leg>/host/       evidence/{result,live,live-summary}.json, recording.rs2,
//                     recording-patch.rs2, store/, steps.jsonl, tap/stream-<n>.rs2,
//                     tap/live-<n>.jsonl (n = 1, and 2 after a reconnect)
//   <leg>/receiver/   applied.json (mode live), received.rs2 (connection 1), received-2.rs2
//                     (connection 2), shots/seq-<n>.png and shots/stream-2-seq-<n>.png, env.txt
//                     (RS_RECEIVER_SHOT_WINDOWS and the G1d option the runner passed)
//   live-receiver-killed/receiver/killed.json   the runner's SIGKILL record (support leg)
//
// Classification is gate 1's precedence (capture-failure, unsupported, replay-failure,
// delivery-violation, pixel-mismatch, success) with g1c's live rules per connection, except:
//   - a connection the receiver closed itself (the first of a reconnect) may stop short of the
//     host's tap: its received stream must be a byte prefix of the tap, missing its end record;
//   - a stall leg may miss exactly the step windows that lie wholly inside the stall (derived
//     from the host's log, never hard-coded); any other missing shot is replay-failure.
// Since G2b2 the streams are render-stream/2 and every connection (a reconnect's second one
// included) carries its inline payloads as resource records ahead of the transactions that need
// them; transactions are only ever found by seq (summarizeRecording), never by message index.

import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  decodePngRgba,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  classifyLeg,
  loadRecording,
  type RecordingSummary,
  readExitCode,
  type StepJoin,
  type StepLine,
} from "./gate0-checks";
import {
  check,
  classifyGate1,
  computeGate1Checkpoints,
  type Gate1Check,
  type Gate1Checkpoint,
  type Gate1Class,
  type Gate1Classification,
  patchDivergence,
} from "./gate1-checks";
import { type Gate1Expected, synthesizeGate1 } from "./gate1-expected";
import {
  type AppliedLive,
  arr,
  checkpointMismatch,
  connectionSummary,
  type DeliveryReport,
  deliveryReasons,
  deliveryReport,
  existing,
  type LiveConnectionSummary,
  type LiveHostEvidence,
  type LiveLegExpectation,
  type LiveLogLine,
  liveLogName,
  loadLiveHost,
  processArtifacts,
  RECEIVED_NAME,
  reclassify,
  spread,
  stateKey,
  step0Settle,
  tapErrors,
  tapName,
} from "./gate1-live-checks";

// ---------------------------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------------------------

export const G1D_CLASSIFIED_LEGS = [
  "live-stall",
  "live-reconnect",
  "live-resync",
  "sabotage-ignore-credit",
  "sabotage-stale-coalesce",
] as const;
export type G1dLeg = (typeof G1D_CLASSIFIED_LEGS)[number];
/** Support leg: no class, only host-survives-receiver-loss. */
export const G1D_SUPPORT_LEGS = ["live-receiver-killed"] as const;

export const G1D_EXPECTATIONS: Record<G1dLeg, LiveLegExpectation> = {
  "live-stall": { class: "success" },
  "live-reconnect": { class: "success" },
  "live-resync": { class: "success" },
  "sabotage-ignore-credit": {
    class: "delivery-violation",
    reasonIncludes: "more than one transaction in flight",
  },
  "sabotage-stale-coalesce": {
    class: "delivery-violation",
    reasonIncludes: "stale-state",
  },
};

/** The legs whose receiver stalls (RS_RECEIVER_STALL). */
export const STALL_LEGS: readonly G1dLeg[] = [
  "live-stall",
  "sabotage-stale-coalesce",
];

/** sim-kept-running: frames advanced >= this share of the nominal 60 fps over the stall, at an
 * average frame interval <= 1.25 x 1/60 s (gate1-design.md G1d). */
export const NOMINAL_FPS = 60;
export const MIN_FRAME_SHARE = 0.8;
export const MAX_INTERVAL_FACTOR = 1.25;

/** received.rs2 for connection 1, received-<n>.rs2 after a reconnect. */
export function receivedName(n: number): string {
  return n === 1 ? RECEIVED_NAME : `received-${n}.rs2`;
}

/** shots/seq-<seq>.png for connection 1, shots/stream-<n>-seq-<seq>.png after a reconnect. */
export function shotName(stream: number, seq: number): string {
  return stream === 1 ? `seq-${seq}.png` : `stream-${stream}-seq-${seq}.png`;
}

// ---------------------------------------------------------------------------------------------
// The runner's own receiver invocation (env.txt)
// ---------------------------------------------------------------------------------------------

export interface ShotWindow {
  step: number;
  from: number;
  to: number;
}

/** The NAME=value words of an env.txt (comment lines skipped). */
export function parseEnvTxt(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? "").split("\n")) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out.set(line.slice(0, i), line.slice(i + 1));
  }
  return out;
}

/** RS_RECEIVER_SHOT_WINDOWS: <step>:<from>-<to>,... */
export function parseWindows(text: string | undefined): ShotWindow[] {
  const out: ShotWindow[] = [];
  for (const part of (text ?? "").split(",")) {
    const m = /^(\d+):(\d+)-(\d+)$/.exec(part.trim());
    if (m) out.push({ step: +m[1], from: +m[2], to: +m[3] });
  }
  return out;
}

/** RS_RECEIVER_STALL: <step>:<ms>. */
export function parseStall(
  text: string | undefined,
): { step: number; ms: number } | null {
  const m = /^(\d+):(\d+)$/.exec((text ?? "").trim());
  return m ? { step: +m[1], ms: +m[2] } : null;
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

export interface G1dShot {
  stream: number;
  seq: number;
  step: number;
}

/** What the host's connection-1 log says about a receiver stall (pure). */
export interface StallReport {
  injected: boolean | null;
  mechanism: string | null;
  step: number | null;
  requested_ms: number | null;
  /** the receiver's own measurement of its blocked main loop (end_us - start_us) */
  measured_ms: number | null;
  stalled_seq: number | null;
  credit_stage: string | null;
  /** the host frame that sent the stalled seq, and the callback that drained its credit */
  send_frame: number | null;
  credit_frame: number | null;
  frames_during_stall: number | null;
  /** frames in [send_frame, credit_frame] with no frame line (the host skipped a callback) */
  frame_lines_missing: number[];
  avg_frame_interval_ms: number | null;
  /** fixture steps whose applied frame lies in (send_frame, credit_frame] */
  steps_applied_during: number[];
  /** sends logged strictly between the stalled seq's send and its credit */
  sends_during: number;
  coalesced_at_send: number | null;
  coalesced_at_credit: number | null;
  coalesced_delta: number | null;
  /** frame lines in (send_frame, credit_frame) with a pending target */
  pending_lines_during: number;
  first_pending_frame: number | null;
  /** the most targets pending at once on any frame line of the connection (a flag: 0 or 1) */
  max_pending: number;
  oldest_pending_frames: number | null;
  oldest_pending_age_ms: number | null;
  max_queued_bytes_during: number;
  recovery: {
    seq: number;
    frame: number;
    encoding: string | null;
    base_seq: number | null;
    bytes: number | null;
    stale_from: number | null;
    frames_after_credit: number;
    /** its resolved state equals the full recording's at its frame */
    state_equals_full: boolean | null;
    /** host clock (I/O-thread receipt times): credit -> the recovery send, and -> its acks */
    credit_to_send_us: number | null;
    credit_to_applied_ack_us: number | null;
    credit_to_submitted_ack_us: number | null;
  } | null;
  /** windows lying wholly inside (send_frame, recovery frame): derived from the host's log */
  expected_missed_steps: number[];
  /** windows without a shot */
  missed_steps: number[];
}

export interface G1dLegEvaluation {
  leg: G1dLeg;
  legDir: string;
  receiverDir: string;
  /** one per host connection, connection 1 first */
  hosts: LiveHostEvidence[];
  applied: AppliedLive | undefined;
  /** one per receiver stream (received.rs2, received-2.rs2, ...) */
  received: RecordingSummary[];
  shots: G1dShot[];
  windows: ShotWindow[];
  env: Map<string, string>;
  steps: StepLine[] | undefined;
  checkpoints: Gate1Checkpoint[];
  delivery: DeliveryReport[];
  stall: StallReport | null;
  expected_class: Gate1Class;
  classification: Gate1Classification;
  exit_code: number | null;
  artifacts: string[];
  first_applied_frame: number | null;
  step0_settle: number | null;
}

function frameLines(log: LiveLogLine[] | undefined): Map<number, LiveLogLine> {
  const out = new Map<number, LiveLogLine>();
  for (const l of log ?? [])
    if (l.event === undefined && l.state !== undefined) out.set(l.frame, l);
  return out;
}

/** The stall as the host saw it, from the receiver's `live.stall` and the host's log (pure). */
export function stallReport(
  host: LiveHostEvidence,
  applied: AppliedLive | undefined,
  steps: StepLine[] | undefined,
  windows: ShotWindow[],
  shots: G1dShot[],
  requested: { step: number; ms: number } | null,
): StallReport {
  const stall = applied?.live?.stall ?? null;
  const log = host.log ?? [];
  const lines = frameLines(log);
  const hello = log.find((l) => l.event === "hello");
  const creditStage = hello?.credit_stage ?? null;
  const stalledSeq = stall?.after_seq ?? null;
  const sendLine = log.find(
    (l) =>
      l.event === undefined && l.sent?.seq === stalledSeq && !l.sent?.dropped,
  );
  const creditLine = log.find(
    (l) =>
      (l.event === "ack" || l.event === "resync") &&
      l.seq === stalledSeq &&
      l.credited === true,
  );
  const out: StallReport = {
    injected: stall?.injected ?? null,
    mechanism: stall?.mechanism ?? null,
    step: stall?.step ?? null,
    requested_ms: requested?.ms ?? null,
    measured_ms:
      stall?.start_us !== undefined && stall?.end_us !== undefined
        ? (stall.end_us - stall.start_us) / 1000
        : null,
    stalled_seq: stalledSeq,
    credit_stage: creditStage,
    send_frame: sendLine?.frame ?? null,
    credit_frame: creditLine?.frame ?? null,
    frames_during_stall: null,
    frame_lines_missing: [],
    avg_frame_interval_ms: null,
    steps_applied_during: [],
    sends_during: 0,
    coalesced_at_send: sendLine?.coalesced ?? null,
    coalesced_at_credit: null,
    coalesced_delta: null,
    pending_lines_during: 0,
    first_pending_frame: null,
    max_pending: Math.max(
      0,
      ...[...lines.values()].map((l) => (l.pending ? 1 : 0)),
    ),
    oldest_pending_frames: null,
    oldest_pending_age_ms: null,
    max_queued_bytes_during: 0,
    recovery: null,
    expected_missed_steps: [],
    missed_steps: windows
      .map((w) => w.step)
      .filter((k) => !shots.some((s) => s.step === k)),
  };
  if (!sendLine || !creditLine) return out;
  const f1 = sendLine.frame;
  const fc = creditLine.frame;
  out.frames_during_stall = fc - f1;
  for (let f = f1; f <= fc; f++)
    if (!lines.has(f)) out.frame_lines_missing.push(f);
  const atCredit = lines.get(fc);
  if (atCredit && fc > f1)
    out.avg_frame_interval_ms =
      (atCredit.t_us - sendLine.t_us) / (fc - f1) / 1000;
  out.coalesced_at_credit = atCredit?.coalesced ?? null;
  if (out.coalesced_at_credit !== null && out.coalesced_at_send !== null)
    out.coalesced_delta = out.coalesced_at_credit - out.coalesced_at_send;
  out.steps_applied_during = (steps ?? [])
    .filter((s) => s.applied_frame > f1 && s.applied_frame <= fc)
    .map((s) => s.step);
  for (const [f, l] of lines) {
    if (f <= f1 || f > fc) continue;
    out.max_queued_bytes_during = Math.max(
      out.max_queued_bytes_during,
      l.queued_bytes ?? 0,
    );
    if (f === fc) continue;
    if (l.sent) out.sends_during++;
    if (l.pending) {
      out.pending_lines_during++;
      if (out.first_pending_frame === null)
        out.first_pending_frame = l.pending_since ?? f;
    }
  }
  if (out.first_pending_frame !== null && atCredit) {
    out.oldest_pending_frames = fc - out.first_pending_frame;
    const first = lines.get(out.first_pending_frame);
    if (first) out.oldest_pending_age_ms = (atCredit.t_us - first.t_us) / 1000;
  }
  // The recovery: the first send at or after the credit's callback.
  const recoveryLine = [...lines.values()]
    .filter((l) => l.frame >= fc && l.sent && !l.sent.dropped)
    .sort((a, b) => a.frame - b.frame)[0];
  if (recoveryLine?.sent) {
    const seq = recoveryLine.sent.seq;
    const tx = host.tap.transactions.find((t) => t.meta.seq === seq);
    const full = host.full.transactions.find(
      (t) => t.meta.frame === tx?.meta.frame,
    );
    const ackAt = (stage: string) =>
      log.find((l) => l.event === "ack" && l.seq === seq && l.stage === stage)
        ?.t_us ?? null;
    const appliedAck = ackAt("applied");
    const submittedAck = ackAt("submitted");
    out.recovery = {
      seq,
      frame: recoveryLine.frame,
      encoding: tx?.meta.encoding ?? null,
      base_seq: tx?.meta.base_seq ?? null,
      bytes: tx?.bytes ?? recoveryLine.sent.bytes ?? null,
      stale_from: recoveryLine.sent.stale_from ?? null,
      frames_after_credit: recoveryLine.frame - fc,
      state_equals_full: tx && full ? stateKey(tx) === stateKey(full) : null,
      credit_to_send_us: recoveryLine.t_us - creditLine.t_us,
      credit_to_applied_ack_us:
        appliedAck === null ? null : appliedAck - creditLine.t_us,
      credit_to_submitted_ack_us:
        submittedAck === null ? null : submittedAck - creditLine.t_us,
    };
    out.expected_missed_steps = windows
      .filter((w) => w.from > f1 && w.to < recoveryLine.frame)
      .map((w) => w.step);
  }
  return out;
}

function hostConnections(host: LiveHostEvidence): number {
  return Math.max(1, host.summary?.connections?.length ?? 1);
}

export async function evaluateG1dLeg(
  outDir: string,
  leg: G1dLeg,
  expected: Gate1Expected,
): Promise<G1dLegEvaluation> {
  const legDir = join(outDir, leg);
  const hostDir = join(legDir, "host");
  const receiverDir = join(legDir, "receiver");
  const first = await loadLiveHost(hostDir, 1);
  const hosts: LiveHostEvidence[] = [first];
  for (let n = 2; n <= hostConnections(first); n++)
    hosts.push(await loadLiveHost(hostDir, n));
  const applied = await readJson<AppliedLive>(
    join(receiverDir, "applied.json"),
  );
  const appliedOk =
    applied !== undefined && applied !== null && typeof applied === "object";
  const streamCount = Math.max(
    hosts.length,
    arr(appliedOk ? applied?.streams : []).length,
  );
  const received: RecordingSummary[] = [];
  for (let n = 1; n <= streamCount; n++)
    received.push(await loadRecording(join(receiverDir, receivedName(n))));
  const env = parseEnvTxt(
    await readTextOrUndefined(join(receiverDir, "env.txt")),
  );
  const windows = parseWindows(env.get("RS_RECEIVER_SHOT_WINDOWS"));
  const steps = first.steps;
  const shots: G1dShot[] = arr<{
    stream?: number;
    seq?: number;
    step?: number | null;
  }>(appliedOk ? applied?.shots : [])
    .filter(
      (s) =>
        Number.isInteger(s.stream) &&
        Number.isInteger(s.seq) &&
        Number.isInteger(s.step),
    )
    .map((s) => ({
      stream: s.stream as number,
      seq: s.seq as number,
      step: s.step as number,
    }));
  const stall = STALL_LEGS.includes(leg)
    ? stallReport(
        first,
        appliedOk ? applied : undefined,
        steps,
        windows,
        shots,
        parseStall(env.get("RS_RECEIVER_STALL")),
      )
    : null;
  const allowedMissed = new Set(stall?.expected_missed_steps ?? []);

  // Checkpoints: every shot against the reference; a missing step is a checkpoint without a shot
  // unless the stall excuses it.
  const join_: StepJoin = {
    ok: true,
    entries: expected.steps
      .filter(
        (s) =>
          shots.some((x) => x.step === s.step) || !allowedMissed.has(s.step),
      )
      .map((s) => {
        const shot = shots.find((x) => x.step === s.step);
        const tx = shot
          ? received[shot.stream - 1]?.transactions.find(
              (t) => t.meta.seq === shot.seq,
            )
          : undefined;
        return {
          step: s.step,
          settle_frame: tx?.meta.frame ?? -1,
          seq: shot?.seq ?? null,
        };
      }),
    problems: [],
  };
  const { checkpoints } = await computeGate1Checkpoints(
    leg,
    "patch",
    join_,
    join(outDir, "reference", "shots"),
    join(receiverDir, "shots"),
    join(receiverDir, "diff"),
    expected,
    (step, seq) =>
      shotName(shots.find((x) => x.step === step)?.stream ?? 1, seq),
  );

  const extra: string[] = [];
  const replay = (r: string) => extra.push(`replay-failure: ${r}`);
  if (first.live?.status !== "listening")
    extra.push(
      `capture-failure: the live listener is ${JSON.stringify(first.live?.status ?? null)} (${first.live?.reason ?? "no evidence/live.json"})`,
    );
  for (const h of hosts) {
    if (!h.tap.present)
      extra.push(`capture-failure: tap/${tapName(h.connection)} missing`);
    else if (tapErrors(h).length > 0)
      extra.push(
        `capture-failure: tap/${tapName(h.connection)} invalid: ${tapErrors(h)[0]}`,
      );
  }
  // Receiver-side rules (replay-failure), per stream.
  let firstApplied: number | null = null;
  if (!appliedOk || !applied) {
    replay("applied.json missing or unparseable");
  } else {
    if (applied.status !== "ok")
      replay(
        `status=${JSON.stringify(applied.status)} failure=${JSON.stringify(applied.failure ?? null)}`,
      );
    if (applied.end_seen !== true) replay("end_seen is not true");
    if (applied.mode !== "live")
      replay(`mode ${JSON.stringify(applied.mode)}, expected live`);
    const streams = arr<{ closed_by?: string | null }>(applied.streams);
    if (streams.length !== hosts.length)
      replay(
        `the receiver reports ${streams.length} streams, the host served ${hosts.length} connections`,
      );
    const tx = arr<{
      stream?: number;
      seq?: number;
      frame?: number;
      record_sha256?: string;
      applied_us?: number | null;
    }>(applied.transactions);
    received.forEach((r, i) => {
      const n = i + 1;
      const host = hosts[i];
      const last = n === received.length;
      if (!r.present) {
        replay(`${receivedName(n)} missing`);
        return;
      }
      // A connection the receiver closed itself (all but the last) may lack the end record.
      const errors = r.errors.filter(
        (e) => last || !e.startsWith("recording-incomplete:"),
      );
      if (errors.length > 0) replay(`${receivedName(n)} invalid: ${errors[0]}`);
      if (host?.tapBytes) {
        if (last) {
          if (host.tap.sha256 !== r.sha256)
            replay(
              `${receivedName(n)} (${r.bytes} B) differs from the host's tap/${tapName(n)} (${host.tap.bytes} B)`,
            );
        } else if (
          // A connection the receiver closed: what it read is a byte prefix of the tap.
          r.bytes > host.tapBytes.length ||
          sha256Hex(host.tapBytes.subarray(0, r.bytes)) !== r.sha256
        ) {
          replay(
            `${receivedName(n)} is not a byte prefix of tap/${tapName(n)}`,
          );
        }
      } else replay(`no host tap for connection ${n}`);
      const mine = tx.filter((t) => (t.stream ?? 1) === n);
      if (
        mine.length !== r.transactions.length ||
        mine.some(
          (t, j) =>
            t.seq !== r.transactions[j].meta.seq ||
            t.record_sha256 !== r.transactions[j].sha256,
        )
      )
        replay(
          `stream ${n}: applied transactions are not exactly the received stream's (${mine.length} entries, ${r.transactions.length} received)`,
        );
    });
    firstApplied =
      tx.find((t) => t.applied_us !== null && t.applied_us !== undefined)
        ?.frame ?? null;
  }
  const step0 = step0Settle(steps);
  if (step0 === null) replay("host steps.jsonl has no step 0");
  else if (firstApplied === null) replay("no transaction applied");
  else if (firstApplied >= step0)
    replay(
      `receiver-late: first applied transaction has frame ${firstApplied} >= step 0's settle frame ${step0}`,
    );
  const missing = expected.steps
    .map((s) => s.step)
    .filter((k) => !shots.some((s) => s.step === k) && !allowedMissed.has(k));
  if (missing.length > 0)
    replay(
      `no shot for step(s) ${missing.join(",")}${allowedMissed.size > 0 ? ` (the stall excuses ${[...allowedMissed].join(",")})` : ""}`,
    );
  const delivery = hosts.map((h) => deliveryReport(h));
  delivery.forEach((d, i) => {
    for (const r of deliveryReasons(d))
      extra.push(
        hosts.length > 1 ? r.replace(": ", `: connection ${i + 1}: `) : r,
      );
  });
  const mismatching: number[] = [];
  for (const c of checkpoints) {
    if (checkpointMismatch(c)) {
      mismatching.push(c.step);
      extra.push(
        `pixel-mismatch: step ${c.step} (seq ${c.seq}): ${c.mismatched_pixels ?? "no shot"} mismatched pixels, max channel delta ${c.max_channel_delta ?? "?"}`,
      );
    }
  }
  const base = classifyLeg({
    captureResult: first.captureResult,
    recording: first.full,
    checkpoints: [],
  });
  const classification = reclassify(
    classifyGate1(
      base,
      first.full.session,
      patchDivergence(first.full, first.patch),
    ),
    extra,
    mismatching,
  );
  return {
    leg,
    legDir,
    receiverDir,
    hosts,
    applied: appliedOk ? applied : undefined,
    received,
    shots,
    windows,
    env,
    steps,
    checkpoints,
    delivery,
    stall,
    expected_class: G1D_EXPECTATIONS[leg].class,
    classification,
    exit_code: await readExitCode(receiverDir),
    artifacts: await existing([
      ...processArtifacts([hostDir, receiverDir]),
      ...hosts.flatMap((h) => [
        join(hostDir, "tap", tapName(h.connection)),
        join(hostDir, "tap", liveLogName(h.connection)),
      ]),
      ...received.map((r) => r.path),
    ]),
    first_applied_frame: firstApplied,
    step0_settle: step0,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

type Evals = Map<G1dLeg, G1dLegEvaluation>;

function logPath(e: G1dLegEvaluation, n = 1): string {
  return join(e.legDir, "host", "tap", liveLogName(n));
}

export function checkStallObserved(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const e = evals.get("live-stall");
  const s = e?.stall;
  const requested = parseStall(e?.env.get("RS_RECEIVER_STALL"));
  if (!e || !s) problems.push("live-stall not evaluated");
  else if (!requested)
    problems.push("the receiver's env.txt has no RS_RECEIVER_STALL");
  else {
    if (s.step !== requested.step || s.requested_ms === null)
      problems.push(
        `applied.json live.stall is ${JSON.stringify(e.applied?.live?.stall ?? null)}, the runner asked for ${requested.step}:${requested.ms}`,
      );
    if (s.injected !== true)
      problems.push("the stall is not declared injected (live.stall.injected)");
    if (s.measured_ms === null || s.measured_ms < requested.ms)
      problems.push(
        `the receiver blocked ${s.measured_ms} ms, < ${requested.ms} ms`,
      );
    const shot = e.shots.find((x) => x.step === requested.step);
    if (!shot || shot.seq !== s.stalled_seq || shot.stream !== 1)
      problems.push(
        `the stall followed seq ${s.stalled_seq}, the step ${requested.step} shot is ${JSON.stringify(shot ?? null)}`,
      );
  }
  return check(
    "stall-observed",
    "live-stall: the receiver blocked its main loop (an injected OS.delay_msec, declared live.stall.injected) for at least the requested 2000 ms, right after its step 1 shot and before that seq's submitted ack",
    problems,
    s
      ? `blocked ${s.measured_ms?.toFixed(1)} ms after seq ${s.stalled_seq} (step ${s.step}); injected: ${s.mechanism}`
      : "",
    e
      ? [join(e.receiverDir, "applied.json"), join(e.receiverDir, "env.txt")]
      : [],
  );
}

export function checkSimKeptRunning(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const e = evals.get("live-stall");
  const s = e?.stall;
  const requested = parseStall(e?.env.get("RS_RECEIVER_STALL"));
  const minFrames = requested
    ? Math.floor((MIN_FRAME_SHARE * NOMINAL_FPS * requested.ms) / 1000)
    : null;
  const maxInterval = (MAX_INTERVAL_FACTOR * 1000) / NOMINAL_FPS;
  if (!e || !s || minFrames === null) problems.push("live-stall not evaluated");
  else if (s.send_frame === null || s.credit_frame === null)
    problems.push(
      `no send (${s.send_frame}) or no credit (${s.credit_frame}) of the stalled seq ${s.stalled_seq} in the host log`,
    );
  else {
    if ((s.frames_during_stall ?? 0) < minFrames)
      problems.push(
        `host frames advanced ${s.frames_during_stall} between the send and the credit, < ${minFrames}`,
      );
    if (s.frame_lines_missing.length > 0)
      problems.push(
        `no frame line for frames ${s.frame_lines_missing.slice(0, 5).join(",")}`,
      );
    if (
      s.avg_frame_interval_ms === null ||
      s.avg_frame_interval_ms > maxInterval
    )
      problems.push(
        `average frame interval ${s.avg_frame_interval_ms?.toFixed(2)} ms > ${maxInterval.toFixed(2)} ms`,
      );
    if (s.steps_applied_during.length === 0)
      problems.push("no fixture step was applied inside the stall");
  }
  return check(
    "sim-kept-running",
    `live-stall: between the send of the stalled seq and the arrival of its credit the host ran at least 0.8 x 60 x the stall's seconds frame callbacks, every one logged, at an average interval <= 1.25 x 1/60 s, and the fixture applied at least one step in between`,
    problems,
    s
      ? `${s.frames_during_stall} host frames (${s.send_frame} -> ${s.credit_frame}) at ${s.avg_frame_interval_ms?.toFixed(2)} ms; steps applied inside: ${s.steps_applied_during.join(",")}`
      : "",
    e ? [logPath(e), join(e.legDir, "host", "steps.jsonl")] : [],
  );
}

export function checkPendingBounded(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const e = evals.get("live-stall");
  const s = e?.stall;
  const d = e?.delivery[0];
  const summary = e ? connectionSummary(e.hosts[0]) : undefined;
  if (!e || !s || !d) problems.push("live-stall not evaluated");
  else {
    for (const v of [
      ...d.in_flight_violations,
      ...d.sent_without_credit,
      ...d.queued_violations,
    ].slice(0, 3))
      problems.push(v);
    if (d.max_in_flight > 1) problems.push(`max in flight ${d.max_in_flight}`);
    if ((summary?.max_in_flight ?? 0) > 1)
      problems.push(`the host reports max_in_flight ${summary?.max_in_flight}`);
    if (s.max_pending > 1 || (summary?.max_pending ?? 0) > 1)
      problems.push(`more than one pending target (${summary?.max_pending})`);
    if (s.sends_during > 0)
      problems.push(
        `${s.sends_during} transactions sent between the stalled seq and its credit`,
      );
    if (s.send_frame === null || s.credit_frame === null)
      problems.push("the stall is not visible in the host log");
  }
  return check(
    "pending-bounded",
    "live-stall: through the whole leg at most one transaction in flight (recomputed from the log's own acks) and at most one pending target, queued bytes never above the largest credit window + 4096, and nothing sent between the stalled seq and its credit",
    problems,
    s && d
      ? `max in flight ${d.max_in_flight}, max pending ${s.max_pending}, max queued ${d.max_queued_bytes} B <= ${d.queued_limit} (during the stall ${s.max_queued_bytes_during} B), 0 sends during the stall`
      : "",
    e
      ? [logPath(e), join(e.legDir, "host", "evidence", "live-summary.json")]
      : [],
  );
}

export function checkCoalesced(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const e = evals.get("live-stall");
  const s = e?.stall;
  if (!e || !s) problems.push("live-stall not evaluated");
  else if (
    s.coalesced_delta === null ||
    s.first_pending_frame === null ||
    s.credit_frame === null
  )
    problems.push(
      `nothing coalesced during the stall (delta ${s.coalesced_delta}, first pending ${s.first_pending_frame})`,
    );
  else {
    // The mirror only changes at fixture steps, so a target is pending from the first in-stall
    // step's frame (or the frame after, for the deferred top-level raise) to the credit.
    const span = s.credit_frame - s.first_pending_frame;
    if (s.coalesced_delta < span - 2)
      problems.push(
        `coalesced grew by ${s.coalesced_delta}, < ${span - 2} (frames from the first pending target at ${s.first_pending_frame} to the credit at ${s.credit_frame}, minus 2)`,
      );
    if (s.coalesced_delta !== s.pending_lines_during)
      problems.push(
        `coalesced grew by ${s.coalesced_delta} but ${s.pending_lines_during} frame lines had a pending target`,
      );
    const firstStep = (e.steps ?? []).find(
      (x) => x.step === s.steps_applied_during[0],
    );
    if (
      !firstStep ||
      s.first_pending_frame < firstStep.applied_frame ||
      s.first_pending_frame > firstStep.applied_frame + 1
    )
      problems.push(
        `the first pending target (frame ${s.first_pending_frame}) is not the first in-stall step's frame (${firstStep?.applied_frame})`,
      );
  }
  return check(
    "coalesced",
    "live-stall: once the mirror changed inside the stall, every frame callback until the credit coalesced (the connection's coalesced counter grew by at least those frames - 2, one per pending frame line), the pending target starting at the in-stall step's frame",
    problems,
    s
      ? `coalesced +${s.coalesced_delta} (pending from frame ${s.first_pending_frame}, oldest ${s.oldest_pending_frames} frames / ${s.oldest_pending_age_ms?.toFixed(1)} ms)`
      : "",
    e ? [logPath(e)] : [],
  );
}

export function checkNewestAfterStall(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const e = evals.get("live-stall");
  const s = e?.stall;
  const r = s?.recovery;
  if (!e || !s) problems.push("live-stall not evaluated");
  else if (!r || s.credit_frame === null)
    problems.push("no transaction after the credit");
  else {
    if (r.encoding !== "patch" || r.base_seq !== s.stalled_seq)
      problems.push(
        `seq ${r.seq} is ${r.encoding} with base_seq ${r.base_seq}, expected a patch on the stalled seq ${s.stalled_seq}`,
      );
    if (r.frames_after_credit > 2)
      problems.push(
        `sent ${r.frames_after_credit} frames after the credit (> 2)`,
      );
    if (r.state_equals_full !== true)
      problems.push(
        `seq ${r.seq}'s resolved state is not the full recording's at frame ${r.frame}`,
      );
    if (r.stale_from !== null)
      problems.push(`seq ${r.seq} carries frame ${r.stale_from}'s state`);
  }
  return check(
    "newest-after-stall",
    "live-stall: the first transaction after the credit is a patch on the stalled seq, sent at most 2 frames after the credit arrived, whose resolved state equals the full recording at its frame (the newest state, not the missed ones)",
    problems,
    r
      ? `seq ${r.seq} (patch on ${r.base_seq}, ${r.bytes} B) at frame ${r.frame}, ${r.frames_after_credit} frames after the credit; equals the full recording; applied ack ${r.credit_to_applied_ack_us === null ? "?" : (r.credit_to_applied_ack_us / 1000).toFixed(1)} ms after the credit`
      : "",
    e ? [logPath(e), e.hosts[0].tap.path, e.hosts[0].full.path] : [],
  );
}

/** Pixels the first in-stall step changed (vs the stall step) that still show at step `k`. */
function inStallUpdatePixels(
  expected: Gate1Expected,
  stallStep: number,
  inStallStep: number,
  k: number,
): number[] {
  const a = synthesizeGate1(expected, stallStep).rgba;
  const b = synthesizeGate1(expected, inStallStep).rgba;
  const c = synthesizeGate1(expected, k).rgba;
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 4) {
    const changed =
      a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2];
    const kept =
      b[i] === c[i] && b[i + 1] === c[i + 1] && b[i + 2] === c[i + 2];
    if (changed && kept) out.push(i);
  }
  return out;
}

export async function checkStallPixels(
  evals: Evals,
  expected: Gate1Expected,
): Promise<Gate1Check> {
  const problems: string[] = [];
  const notes: string[] = [];
  const e = evals.get("live-stall");
  const s = e?.stall;
  if (!e || !s) problems.push("live-stall not evaluated");
  else {
    const want = [...s.expected_missed_steps].sort((a, b) => a - b).join(",");
    const got = [...s.missed_steps].sort((a, b) => a - b).join(",");
    const declared = [...arr<number>(e.applied?.shots_missed)]
      .sort((a, b) => a - b)
      .join(",");
    if (s.recovery === null) problems.push("no recovery transaction");
    if (want !== got)
      problems.push(
        `missed steps {${got}}, expected exactly the windows inside the stall {${want}}`,
      );
    if (declared !== got)
      problems.push(
        `applied.json shots_missed {${declared}} != the shots' {${got}}`,
      );
    for (const c of e.checkpoints)
      if (checkpointMismatch(c))
        problems.push(
          `step ${c.step} (seq ${c.seq}): ${c.mismatched_pixels ?? "no shot"} px differ from the reference`,
        );
    // The first shot after the stall shows the update applied inside it.
    const inStall = s.steps_applied_during[0];
    const post = e.shots
      .filter((x) => s.step !== null && x.step > s.step)
      .sort((a, b) => a.step - b.step)[0];
    if (inStall === undefined || !post || s.step === null)
      problems.push("no in-stall step or no post-stall shot");
    else {
      const px = inStallUpdatePixels(expected, s.step, inStall, post.step);
      const png = await decodePngRgba(
        join(e.receiverDir, "shots", shotName(post.stream, post.seq)),
      );
      const ref = synthesizeGate1(expected, post.step).rgba;
      if (px.length === 0)
        problems.push(
          `step ${inStall} changes no pixel that still shows at step ${post.step}`,
        );
      else if (!png)
        problems.push(`post-stall shot seq ${post.seq} unreadable`);
      else {
        const bad = px.filter(
          (i) =>
            png.data[i] !== ref[i] ||
            png.data[i + 1] !== ref[i + 1] ||
            png.data[i + 2] !== ref[i + 2],
        ).length;
        if (bad > 0)
          problems.push(
            `${bad} of the ${px.length} pixels step ${inStall} changed inside the stall do not show in the step ${post.step} shot`,
          );
        notes.push(
          `the first post-stall shot (step ${post.step}, seq ${post.seq}) shows all ${px.length} pixels step ${inStall} changed inside the stall`,
        );
      }
    }
    notes.unshift(`missed {${got}} = windows inside the stall {${want}}`);
  }
  return check(
    "stall-pixels",
    "live-stall: the steps without a shot are exactly those whose whole window lies inside the stall (derived from the host log: after the stalled send, before the recovery send); every other step's shot equals the reference; the first post-stall shot shows the persistent update the fixture applied inside the stall (step 2's transforms and R1's colour)",
    problems,
    notes.join("; "),
    e
      ? [
          join(e.receiverDir, "applied.json"),
          ...e.checkpoints.flatMap((c) =>
            c.receiver_png ? [c.receiver_png] : [],
          ),
        ]
      : [],
  );
}

export function checkReconnectFreshSession(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const e = evals.get("live-reconnect");
  if (!e) problems.push("live-reconnect not evaluated");
  else if (e.hosts.length !== 2 || e.received.length !== 2)
    problems.push(
      `${e.hosts.length} host connections and ${e.received.length} received streams, expected 2 and 2`,
    );
  else {
    const [h1, h2] = e.hosts;
    const c1 = connectionSummary(h1);
    const c2 = connectionSummary(h2);
    const r2 = e.received[1];
    const s1 = e.received[0].session?.stream;
    const s2 = r2.session?.stream;
    if (c1?.closed_by !== "receiver" || c1?.close_code !== 1000)
      problems.push(
        `connection 1 closed by ${c1?.closed_by} with ${c1?.close_code}, expected the receiver with 1000`,
      );
    if (
      !h1.log?.some(
        (l) =>
          l.event === "close" && l.closed_by === "receiver" && l.code === 1000,
      )
    )
      problems.push("connection 1's log has no receiver close 1000");
    if (s2?.connection !== 2 || s2.transport !== "websocket")
      problems.push(
        `connection 2's session stream ${JSON.stringify(s2 ?? null)}`,
      );
    if (
      !s2?.stream_id ||
      s2.stream_id === s1?.stream_id ||
      s2.stream_id !== c2?.stream_id
    )
      problems.push(
        `connection 2's stream_id ${s2?.stream_id} is not fresh (connection 1: ${s1?.stream_id})`,
      );
    if (
      [
        h1.full.session?.stream?.stream_id,
        h1.patch.session?.stream?.stream_id,
      ].includes(s2?.stream_id)
    )
      problems.push("connection 2's stream_id is a file sink's");
    if (r2.session?.session_id !== h1.full.session?.session_id)
      problems.push(
        `session_id ${r2.session?.session_id} != the capture session's ${h1.full.session?.session_id}`,
      );
    const t1 = r2.transactions[0];
    if (
      t1?.meta.seq !== 1 ||
      t1.meta.encoding !== "full" ||
      t1.meta.base_seq !== null
    )
      problems.push(
        `connection 2's first transaction is ${JSON.stringify(t1?.meta.seq)} ${t1?.meta.encoding} base ${t1?.meta.base_seq}`,
      );
    else {
      const full = h1.full.transactions.find(
        (t) => t.meta.frame === t1.meta.frame,
      );
      if (!full || stateKey(full) !== stateKey(t1))
        problems.push(
          `connection 2's seq 1 (frame ${t1.meta.frame}) is not the full recording's state`,
        );
    }
    r2.transactions.slice(1).forEach((t) => {
      if (
        (t.meta.encoding !== "patch" || t.meta.base_seq !== t.meta.seq - 1) &&
        problems.length < 8
      )
        problems.push(
          `connection 2 seq ${t.meta.seq} is ${t.meta.encoding} on ${t.meta.base_seq}`,
        );
    });
    if (r2.errors.length > 0)
      problems.push(`${receivedName(2)}: ${r2.errors[0]}`);
  }
  const r2 = e?.received[1];
  return check(
    "reconnect-fresh-session",
    "live-reconnect: the receiver closed connection 1 with 1000 (host log); connection 2 carries a new stream_id, the same session_id, seq 1 full (base null) equal to the full recording at its frame, then patches on its own previous seq only, and validates as a stream of its own",
    problems,
    r2
      ? `connection 2: stream ${r2.session?.stream?.stream_id}, ${r2.transactions.length} transactions, seq 1 full at frame ${r2.transactions[0]?.meta.frame}`
      : "",
    e ? [logPath(e, 1), logPath(e, 2), ...e.received.map((r) => r.path)] : [],
  );
}

export function checkReconnectCleanSlate(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const e = evals.get("live-reconnect");
  const rc = e?.applied?.live?.reconnect;
  const reconnectStep = Number(
    e?.env.get("RS_RECEIVER_RECONNECT") ?? Number.NaN,
  );
  if (!e || !rc) problems.push("applied.json live.reconnect missing");
  else {
    const created = rc.created_rids ?? -1;
    const freedByApply = rc.freed_by_apply ?? -1;
    if (rc.step !== reconnectStep)
      problems.push(
        `reconnected after step ${rc.step}, the runner asked for ${reconnectStep}`,
      );
    if ((rc.freed_rids ?? -1) <= 0 || rc.freed_rids !== created - freedByApply)
      problems.push(
        `dispose freed ${rc.freed_rids} RIDs; created ${created} - freed while applying ${freedByApply} = ${created - freedByApply}`,
      );
    if (rc.owned_before_dispose !== rc.freed_rids)
      problems.push(
        `owned ${rc.owned_before_dispose} before dispose, freed ${rc.freed_rids}`,
      );
    if (rc.leftover_rids !== 0)
      problems.push(`${rc.leftover_rids} RIDs left after dispose`);
    const after = e.checkpoints.filter((c) => {
      const shot = e.shots.find((x) => x.step === c.step);
      return shot !== undefined && shot.stream === 2;
    });
    if (after.length === 0) problems.push("no shot after the reconnect");
    for (const c of after)
      if (checkpointMismatch(c))
        problems.push(
          `step ${c.step} (stream 2 seq ${c.seq}) differs from the reference`,
        );
    const shotStep = e.shots.find((x) => x.step === reconnectStep);
    if (shotStep?.stream !== 1 || shotStep.seq !== rc.after_seq)
      problems.push(
        `the reconnect followed seq ${rc.after_seq}, the step ${reconnectStep} shot is ${JSON.stringify(shotStep ?? null)}`,
      );
  }
  return check(
    "reconnect-clean-slate",
    "live-reconnect: after its step 4 shot the receiver's dispose freed exactly the RIDs it still owned (created - freed while applying), none are left, and every shot taken on connection 2 equals the reference",
    problems,
    rc
      ? `dispose freed ${rc.freed_rids} RIDs (created ${rc.created_rids}, freed while applying ${rc.freed_by_apply}), 0 left; ${e?.shots.filter((x) => x.stream === 2).length} shots on connection 2 match`
      : "",
    e ? [join(e.receiverDir, "applied.json")] : [],
  );
}

export function checkResyncFull(evals: Evals): Gate1Check {
  const problems: string[] = [];
  const e = evals.get("live-resync");
  const rs = e?.applied?.live?.resync;
  const resyncStep = Number(e?.env.get("RS_RECEIVER_RESYNC") ?? Number.NaN);
  let nextSeq: number | null = null;
  if (!e || !rs || rs.seq === undefined)
    problems.push("applied.json live.resync missing");
  else {
    const log = e.hosts[0].log ?? [];
    if (rs.step !== resyncStep)
      problems.push(
        `resync in step ${rs.step}'s window, the runner asked for ${resyncStep}`,
      );
    const ev = log.find((l) => l.event === "resync" && l.seq === rs.seq);
    if (ev?.credited !== true)
      problems.push(`the host logged no credited resync for seq ${rs.seq}`);
    const tx = arr<{
      seq?: number;
      skipped?: string | null;
      applied_us?: number | null;
    }>(e.applied?.transactions).find((t) => t.seq === rs.seq);
    if (tx?.skipped !== "resync" || tx?.applied_us !== null)
      problems.push(
        `the receiver did not mark seq ${rs.seq} skipped "resync" unapplied`,
      );
    if (
      log.some(
        (l) => l.event === "ack" && l.seq === rs.seq && l.stage !== "received",
      )
    )
      problems.push(`seq ${rs.seq} was acked past received`);
    const next = e.hosts[0].tap.transactions.find(
      (t) => t.meta.seq === (rs.seq as number) + 1,
    );
    nextSeq = next?.meta.seq ?? null;
    if (next?.meta.encoding !== "full" || next.meta.base_seq !== null)
      problems.push(
        `the next transaction (seq ${(rs.seq as number) + 1}) is ${next?.meta.encoding} with base ${next?.meta.base_seq}, expected full with base null`,
      );
    const later = e.hosts[0].summary?.connections?.[0]?.full ?? 0;
    if (later !== 2)
      problems.push(
        `the host sent ${later} full transactions, expected 2 (seq 1 and the resync)`,
      );
    if ((e.hosts[0].summary?.connections?.[0]?.resyncs ?? 0) !== 1)
      problems.push(
        `the host counted ${e.hosts[0].summary?.connections?.[0]?.resyncs} resyncs`,
      );
    for (const c of e.checkpoints.filter((c) => c.step >= resyncStep))
      if (checkpointMismatch(c))
        problems.push(`step ${c.step} differs from the reference`);
  }
  return check(
    "resync-full",
    'live-resync: the receiver refused the first transaction of step 6\'s window unapplied (skipped "resync", never acked past received) and sent resync; the host logged it as the credit, and the next transaction is full with base_seq null (the only full one after seq 1); the shots from step 6 on equal the reference',
    problems,
    rs
      ? `seq ${rs.seq} refused at frame ${rs.frame}; seq ${nextSeq} full; later shots match`
      : "",
    e
      ? [logPath(e), join(e.receiverDir, "applied.json"), e.hosts[0].tap.path]
      : [],
  );
}

export interface KilledEvidence {
  dir: string;
  host: LiveHostEvidence;
  killed:
    | {
        pid?: number;
        target_frame?: number;
        host_frame_seen?: number;
        killed?: boolean;
        signal?: string;
      }
    | undefined;
  host_exit: number | null;
  receiver_exit: number | null;
  host_stdout: string | undefined;
}

export async function loadKilled(outDir: string): Promise<KilledEvidence> {
  const dir = join(outDir, "live-receiver-killed");
  return {
    dir,
    host: await loadLiveHost(join(dir, "host"), 1),
    killed: await readJson(join(dir, "receiver", "killed.json")),
    host_exit: await readExitCode(join(dir, "host")),
    receiver_exit: await readExitCode(join(dir, "receiver")),
    host_stdout: await readTextOrUndefined(join(dir, "host", "stdout.log")),
  };
}

export function checkHostSurvivesReceiverLoss(k: KilledEvidence): Gate1Check {
  const problems: string[] = [];
  const c = connectionSummary(k.host);
  const ready = /\[fixture\] gate1 ready: S=\d+ N=\d+ quit=(\d+)/.exec(
    k.host_stdout ?? "",
  );
  const quitting = /\[fixture\] quitting frame=(\d+)/.exec(k.host_stdout ?? "");
  if (k.killed?.killed !== true || k.killed.signal !== "SIGKILL")
    problems.push(
      `the receiver was not SIGKILLed (${JSON.stringify(k.killed ?? null)})`,
    );
  else if (
    (k.killed.host_frame_seen ?? 0) <
    (k.killed.target_frame ?? Number.POSITIVE_INFINITY)
  )
    problems.push(
      `killed at host frame ${k.killed.host_frame_seen} < ${k.killed.target_frame}`,
    );
  if (c?.closed_by !== "receiver" || c?.close_code !== 1006)
    problems.push(
      `the host's connection closed by ${c?.closed_by} with ${c?.close_code}, expected an abnormal close (1006)`,
    );
  if (k.host_exit !== 0) problems.push(`host exit ${k.host_exit}`);
  if (!ready || !quitting || ready[1] !== quitting[1])
    problems.push(
      `the fixture did not reach its quit frame (ready ${ready?.[1]}, quitting ${quitting?.[1]})`,
    );
  for (const r of [k.host.full, k.host.patch]) {
    if (!r.present) problems.push(`${r.path} missing`);
    else if (r.errors.length > 0) problems.push(`${r.path}: ${r.errors[0]}`);
    else if (!r.end) problems.push(`${r.path} has no end record`);
  }
  const lastFrame = k.host.full.transactions.at(-1)?.meta.frame ?? 0;
  if (quitting && lastFrame < Number(quitting[1]) - 1)
    problems.push(
      `the full sink's last transaction is frame ${lastFrame}, the fixture quit at ${quitting[1]}`,
    );
  const lastLogged =
    (k.host.log ?? []).filter((l) => l.event === undefined).at(-1)?.frame ?? 0;
  return check(
    "host-survives-receiver-loss",
    "live-receiver-killed: after the receiver was SIGKILLed mid-stream the host's connection closed abnormally (1006), the fixture still reached its quit frame, the host exited 0, and both file sinks end with an end record",
    problems,
    `killed at host frame ${k.killed?.host_frame_seen}; connection closed ${c?.close_code} (${c?.close_reason}) after frame ${lastLogged}; fixture quit at ${quitting?.[1]}; both sinks complete (last frame ${lastFrame})`,
    [
      join(k.dir, "receiver", "killed.json"),
      join(k.dir, "host", "evidence", "live-summary.json"),
      join(k.dir, "host", "stdout.log"),
      k.host.full.path,
      k.host.patch.path,
    ],
  );
}

export function checkG1dLegClass(e: G1dLegEvaluation): Gate1Check {
  const exp = G1D_EXPECTATIONS[e.leg];
  const c = e.classification;
  const problems: string[] = [];
  if (c.result_class !== exp.class)
    problems.push(`class ${c.result_class}, expected ${exp.class}`);
  if (
    exp.reasonIncludes &&
    !c.reasons.some((r) => r.includes(exp.reasonIncludes as string))
  )
    problems.push(`no reason mentions ${exp.reasonIncludes}`);
  const sabotageFrame = e.hosts[0].full.session?.sabotage?.frame ?? null;
  const summary = connectionSummary(e.hosts[0]);
  if (e.leg === "sabotage-ignore-credit") {
    // The sabotage is the cause: violations start at its frame, never before.
    const d = e.delivery[0];
    const frames = [
      ...(d?.sent_without_credit ?? []),
      ...(d?.in_flight_violations ?? []),
    ]
      .map((v) => Number(/^frame (\d+)/.exec(v)?.[1] ?? Number.NaN))
      .filter((f) => Number.isFinite(f));
    if (sabotageFrame === null)
      problems.push("the host session declares no sabotage frame");
    else if (frames.length === 0 || Math.min(...frames) < sabotageFrame)
      problems.push(
        `the first violation (frame ${Math.min(...frames)}) is not at or after the sabotage frame ${sabotageFrame}`,
      );
    if (!c.reasons.some((r) => r.includes("sent without credit")))
      problems.push("no reason mentions a send without credit");
    if (
      (summary?.sent_without_credit ?? 0) === 0 ||
      (summary?.max_in_flight ?? 0) < 2
    )
      problems.push(
        `the host reports sent_without_credit ${summary?.sent_without_credit}, max_in_flight ${summary?.max_in_flight}`,
      );
  }
  if (e.leg === "sabotage-stale-coalesce") {
    // The first post-stall transaction carries the first missed target: it fails
    // live-resolves-to-recording.
    const r = e.stall?.recovery;
    const stale = e.delivery[0]?.stale_states ?? [];
    if (!r) problems.push("no transaction after the stall's credit");
    else {
      if (r.stale_from === null || r.state_equals_full !== false)
        problems.push(
          `the first post-stall transaction seq ${r.seq} is not stale (stale_from ${r.stale_from}, equals full ${r.state_equals_full})`,
        );
      if (!stale.some((x) => x.startsWith(`seq ${r.seq} `)))
        problems.push(
          `stale-state does not name the first post-stall seq ${r.seq}`,
        );
    }
    if ((summary?.stale_sent ?? 0) === 0)
      problems.push("the host sent no stale copy");
  }
  return check(
    `leg-class-${e.leg}`,
    `the ${e.leg} leg classifies as ${exp.class}${exp.reasonIncludes ? ` with a ${exp.reasonIncludes} reason` : ""}${e.leg === "sabotage-ignore-credit" ? ", every violation at or after the sabotage frame" : e.leg === "sabotage-stale-coalesce" ? ", the first post-stall transaction stale" : ""}`,
    problems,
    `${c.result_class}${c.reasons.length > 0 ? ` (${c.reasons.slice(0, 2).join(" | ")})` : ""}`,
    e.artifacts,
  );
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export interface G1dLegReport {
  connections: LiveConnectionSummary[];
  delivery: (Omit<DeliveryReport, "send_gaps"> & {
    send_gap_frames: { min: number; median: number; max: number } | null;
  })[];
  receiver: {
    streams: number;
    transactions: number;
    applied: number;
    skipped: number;
    shots: number;
    shots_missed: number[];
    acks_sent: unknown;
    presented: string | null;
  };
  stall: StallReport | null;
  reconnect: unknown;
  resync: unknown;
  first_applied_frame: number | null;
}

export function g1dLegReport(e: G1dLegEvaluation): G1dLegReport {
  const tx = arr<{ applied_us?: number | null; skipped?: string | null }>(
    e.applied?.transactions,
  );
  return {
    connections: e.hosts[0].summary?.connections ?? [],
    delivery: e.delivery.map(({ send_gaps, ...rest }) => ({
      ...rest,
      send_gap_frames: spread(send_gaps),
    })),
    receiver: {
      streams: e.received.length,
      transactions: tx.length,
      applied: tx.filter((t) => typeof t.applied_us === "number").length,
      skipped: tx.filter((t) => t.skipped !== null && t.skipped !== undefined)
        .length,
      shots: e.shots.length,
      shots_missed: arr<number>(e.applied?.shots_missed),
      acks_sent: e.applied?.live?.acks_sent ?? null,
      presented: e.applied?.live?.presented ?? null,
    },
    stall: e.stall,
    reconnect: e.applied?.live?.reconnect ?? null,
    resync: e.applied?.live?.resync ?? null,
    first_applied_frame: e.first_applied_frame,
  };
}
