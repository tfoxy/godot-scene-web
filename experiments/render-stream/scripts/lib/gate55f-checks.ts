// Gate 5.5 group g55f (protocol/gate5_5-design.md "G55f"): live ShaderMaterial parameters and
// code through a stall. Live legs on fixtures/gate55-shader with gate 1's live timeline (S=300,
// N=60, LAST_STEP=9, quit=851 -- G55F_* below), reusing gate 2's live-resource machinery
// (G2cHost, pinsReport, the HTTP/pin/retire checks) generalized to GRP1 shader-code hashes, and
// gate 1's G1d stall report (send/credit frames, coalescing, the recovery transaction) unchanged.
// This is the exact structural template G5f used for GRM1 mesh surfaces (branch rs/gate5-g5f,
// scripts/lib/gate5f-checks.ts); nothing here forks that approach, only its hash extractor and
// its continuously-changing region.
//
// PH (the fixture's every-frame `phase` shader parameter) is the one resource busy enough to
// stress pins/retirement/coalescing continuously; every other shader/material is static between
// its own step (gate5_5-design.md Q6c). A per-step reference image is only exactly right for a
// shot taken at the SAME absolute frame as the reference's, and a live shot can land a frame or
// two off its nominal settle frame from ordinary round-trip jitter (memory rs-g5f-live-mesh-facts
// fact 2: even a healthy, unstalled leg's shot can land off-frame). A checkpoint whose only
// mismatching region is PH is therefore judged `benign` when the wire's own resolved state at the
// shot's actual frame equals the host's full file recording at that frame
// (wireStateEqualsFullAtFrame) -- the same newest-state proof `shader-fetches-latest-only` uses
// for the stall's recovery transaction, applied to every checkpoint. The stale-coalesce sabotage
// is exactly the case where that proof fails: its post-stall mismatch is real, not benign, which
// is what makes the leg classify pixel-mismatch instead of success.
//
// The sabotage is not confined to the stall, though: from its arm frame on, the host rewrites
// EVERY coalesced send to carry the first missed target (`sent.stale_from` in its live log), and
// under CPU load the 60 Hz credit loop phase-locks to every other frame (memory
// rs-g55d-rs5-switch-facts), so ordinary sends outside the stall carry a one- or two-frame-old
// snapshot too. A settle shot landing on one of those differs from reference-live in PH because
// the wire deliberately holds an older PH, not because the receiver is wrong (the 2026-10-11 G5f
// flake, same checker shape). On the sabotage leg only, receiver-vs-reference therefore judges
// such a checkpoint against the frame the wire says it carries: `stale_exact` (PH-only, and the
// tap's state at the shot's frame equals the host's full recording at `stale_from` exactly).
//
// Pure over an evidence directory written by run-gate55.sh's run_g55f (under <out>/shader-live/),
// so nothing here launches a process.
//
// Evidence layout added by group g55f under <out>/shader-live/ (beside shader/'s g55c/e evidence):
//   import/fixture-g55f/, import/receiver-g55f/      editor --import passes
//   reference-live/                                  rendered reference at G55f's own timeline:
//                                                     shots/step-<k>.png, steps.jsonl
//   <leg>/host/     a live host on G55f's timeline: recording.rs2, recording-patch.rs2, store/,
//                   steps.jsonl, evidence/{result,live,live-summary}.json,
//                   evidence/resources.jsonl, tap/stream-1.rs2, tap/live-1.jsonl
//   <leg>/receiver/ its live receiver: applied.json, received.rs2, cache/, shots/seq-<n>.png
// Legs: live-shader, live-shader-warm (receiver on live-shader's cache, mode warm),
// live-shader-stall (RS_RECEIVER_STALL=1:2000 after step 1), sabotage-shader-stale-coalesce (the
// same stall, host GRC_SABOTAGE=stale-coalesce from step 1's frame).

import { join } from "node:path";

import {
  decodePngRgba,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import { diffRgba, readExitCode } from "./gate0-checks";
import {
  type G1dShot,
  parseStall,
  type ShotWindow,
  type StallReport,
  stallReport,
} from "./gate1-g1d-checks";
import {
  deliveryReasons,
  deliveryReport,
  type LiveHostEvidence,
  receivedFileName,
} from "./gate1-live-checks";
import {
  G2B_PRECEDENCE,
  type G2bCheck,
  type G2bClass,
  type G2bClassification,
  type G2bLegExpectation,
  loadResolved,
} from "./gate2b-checks";
import {
  appliedAs,
  coldFetchedHashes,
  connTimelines,
  fetchesAfterApplied,
  type G2cHost,
  getsVsFetches,
  httpGets,
  loadHost,
  okImageHashes,
  okShaderHashes,
  type PinsReport,
  pinsReport,
  sameBytesOrPrefix,
  shaderTableHashes,
  tableHashes,
  unadvertisedGets,
  warmCacheProblems,
} from "./gate2c-checks";
import type { Gate55ShaderStep } from "./gate55c-checks";
import type { ResolvedTransaction } from "./render-stream-2";
import { statesEqual } from "./render-stream-2";

/** The fixture also serves TEX16/TEX16B over the same resource mechanism (Q6a's `PA` region, and
 * the engine's default-theme hue strip, memory rs-g2a-texture-census-facts): pins, retirement and
 * GET-advertising are keyed by hash regardless of resource kind, so the "servable" and
 * "advertised" sets g55f checks against must union both kinds, not shader code alone (memory
 * rs-g5f-live-mesh-facts fact 1, the same trap generalized from GRM1 to GRP1). */
function okResourceHashes(t: ResolvedTransaction | undefined): Set<string> {
  return new Set([...okImageHashes(t), ...okShaderHashes(t)]);
}
function resourceTableHashes(t: ResolvedTransaction): Set<string> {
  return new Set([...tableHashes(t), ...shaderTableHashes(t)]);
}

// ---------------------------------------------------------------------------------------------
// The live timeline and the legs (run-gate55.sh's G55F_* constants, mirrored)
// ---------------------------------------------------------------------------------------------

export const G55F_START_FRAME = 300;
export const G55F_STEP_FRAMES = 60;
export const G55F_LAST_STEP = 9;
export const G55F_QUIT_FRAME =
  G55F_START_FRAME + G55F_STEP_FRAMES * G55F_LAST_STEP + 11;
export const G55F_STALL_SPEC = "1:2000";
/** PH is the one region a live shot's frame offset (from a stall) can move away from the
 * reference's; every other region is static between its own step. */
export const G55F_CONTINUOUS_REGION = "PH";
/** The leg whose host runs GRC_SABOTAGE=stale-coalesce. */
export const G55F_SABOTAGE_LEG = "sabotage-shader-stale-coalesce";

export const G55F_LEGS: readonly G2bLegExpectation[] = [
  { leg: "live-shader", expected_class: "success" },
  { leg: "live-shader-warm", expected_class: "success" },
  { leg: "live-shader-stall", expected_class: "success" },
  { leg: "sabotage-shader-stale-coalesce", expected_class: "pixel-mismatch" },
];
/** Legs whose pins/retirement/HTTP must hold exactly (gate 2's live checks for GRP1): every leg
 * but the stale-coalesce sabotage, which deliberately serves a stale snapshot. */
export const G55F_GOOD: readonly string[] = [
  "live-shader",
  "live-shader-warm",
  "live-shader-stall",
];
/** Legs whose host stalls the receiver (RS_RECEIVER_STALL). */
export const G55F_STALL_LEGS: readonly string[] = [
  "live-shader-stall",
  "sabotage-shader-stale-coalesce",
];

export function g55fWindows(): ShotWindow[] {
  const out: ShotWindow[] = [];
  for (let k = 0; k <= G55F_LAST_STEP; k++) {
    const from = G55F_START_FRAME + G55F_STEP_FRAMES * k + 7;
    const to =
      k === G55F_LAST_STEP
        ? G55F_QUIT_FRAME
        : G55F_START_FRAME + G55F_STEP_FRAMES * (k + 1) - 1;
    out.push({ step: k, from, to });
  }
  return out;
}

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

export interface G55fFetch {
  stream?: number;
  seq?: number;
  hash?: string;
  source?: string;
  kind?: string;
  status?: number | null;
  bytes?: number;
  start_us?: number;
  end_us?: number;
  verified?: boolean;
  headers?: Record<string, string>;
}

export interface G55fApplied {
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
  transactions?: Array<{
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
  }>;
  shots?: Array<{ stream?: number; seq?: number; step?: number | null }>;
  shots_missed?: number[];
  cache?: { mode?: string } | null;
  fetches?: G55fFetch[];
  resources_summary?: Record<string, number>;
  live?: {
    credit_stage?: string;
    presented?: string;
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
  } | null;
}

export interface G55fLegEvidence {
  leg: string;
  host: G2cHost | null;
  receiverDir: string;
  applied: G55fApplied | undefined;
  log: string;
  exit: number | null;
}

export async function loadG55fLeg(
  outDir: string,
  leg: string,
): Promise<G55fLegEvidence> {
  const legDir = join(outDir, leg);
  const host = await loadHost(join(legDir, "host"));
  const receiverDir = join(legDir, "receiver");
  // loadHost (gate2c-checks.ts) loads the host's own evidence only; the receiver's copy of each
  // connection's stream (received.rs2, received-<n>.rs2) is this leg's, not the host's (memory
  // rs-g5f-live-mesh-facts fact 4).
  for (const c of host.connections) {
    const name = receivedFileName(receiverDir, c.n);
    const r = await loadResolved(join(receiverDir, name));
    c.received = r.present ? r : null;
  }
  const applied = await readJson<G55fApplied>(
    join(receiverDir, "applied.json"),
  );
  return {
    leg,
    host,
    receiverDir,
    applied:
      applied && typeof applied === "object"
        ? (applied as G55fApplied)
        : undefined,
    log: (await readTextOrUndefined(join(receiverDir, "stdout.log"))) ?? "",
    exit: await readExitCode(receiverDir),
  };
}

export async function loadReferenceLive(
  outDir: string,
): Promise<{ dir: string }> {
  return { dir: join(outDir, "reference-live") };
}

// ---------------------------------------------------------------------------------------------
// Checkpoints: a receiver shot against reference-live's step shot, per expected.json region
// ---------------------------------------------------------------------------------------------

export interface G55fCheckpoint {
  step: number;
  seq: number | null;
  frame: number | null;
  shot: string;
  reference: string;
  mismatched_pixels: number | null;
  /** mismatching pixels per expected.json region, name -> count */
  regions: Record<string, number>;
  /** true when the only region differing from reference-live is PH (G55F_CONTINUOUS_REGION) and
   * the wire's resolved state at this shot's actual frame equals the host's full file recording
   * at that same frame: a benign effect of the live timeline (a shot lands a frame or two off its
   * nominal settle frame), exercised here by ordinary round-trip jitter, not a correctness
   * problem. Null when there is no shot to judge (seq === null) or no wire transaction at that
   * frame to check against. */
  benign: boolean | null;
  /** The frame whose snapshot the host's send of this shot's seq carried (its live log's
   * `sent.stale_from`; only the stale-coalesce sabotage writes it), null for a newest-state send
   * or no shot. */
  stale_from: number | null;
  /** true when `stale_from` is set, the only region differing from reference-live is PH (or
   * none), and the tap's resolved state at this shot's frame equals the host's full recording at
   * `stale_from` exactly: the wire deliberately holds an older PH and the receiver shows it. The
   * sabotage leg's receiver-vs-reference tolerance (never a good leg's: a stale send there is a
   * host bug). Null when there is no shot or the send was not stale. */
  stale_exact: boolean | null;
}

function xywh(box: readonly number[]): [number, number, number, number] {
  return [box[0], box[1], box[2] - box[0], box[3] - box[1]];
}

/** The regions (by name) with at least one mismatching pixel. */
export function mismatchingRegionNames(cp: G55fCheckpoint): string[] {
  return Object.entries(cp.regions)
    .filter(([, n]) => n > 0)
    .map(([name]) => name)
    .sort();
}

/** Each step's shot (stream 1 only; G55f never reconnects) of a live receiver. */
export function stepShots55f(
  a: G55fApplied | undefined,
): Map<number, { seq: number; frame: number | null }> {
  const out = new Map<number, { seq: number; frame: number | null }>();
  const frames = new Map((a?.transactions ?? []).map((t) => [t.seq, t.frame]));
  for (const s of a?.shots ?? []) {
    if (!Number.isInteger(s.step) || !Number.isInteger(s.seq)) continue;
    if (out.has(s.step as number)) continue;
    out.set(s.step as number, {
      seq: s.seq as number,
      frame: frames.get(s.seq as number) ?? null,
    });
  }
  return out;
}

/** Whether a connection's tapped resolved state at `frame` equals the host's own full file
 * recording's state at that same frame (null when either side has no transaction there). The
 * generic wire-correctness check (reused per checkpoint, not only at a stall's recovery seq, as
 * `checkLiveResolvesToRecordingShader` runs it over every transaction of the GOOD legs).
 * `fullFrame` (default `frame`) names a different full-recording frame to compare against: a
 * stale send's `stale_from`. */
export function wireStateEqualsFullAtFrame(
  host: G2cHost,
  frame: number | null,
  fullFrame: number | null = frame,
): boolean | null {
  if (frame === null || fullFrame === null) return null;
  const full = host.full.recording?.transactions.find(
    (t) => t.frame === fullFrame,
  );
  const tap = host.connections[0]?.tap.recording?.transactions.find(
    (t) => t.frame === frame,
  );
  if (!full || !tap) return null;
  return statesEqual(full.state, tap.state);
}

/** The frame whose snapshot the host's (first connection's) send of `seq` carried, per its live
 * log's `sent.stale_from`; null when that send carried the newest state or is not logged. */
export function staleFromOfSeq(
  host: G2cHost,
  seq: number | null,
): number | null {
  if (seq === null) return null;
  const line = host.connections[0]?.host.log?.find((l) => l.sent?.seq === seq);
  return line?.sent?.stale_from ?? null;
}

/** Every settle step's checkpoint against reference-live's step shot, per region, with
 * `benign` and `stale_exact` judged from the host's own wire (see G55fCheckpoint's doc). */
export async function g55fCheckpoints(
  expected: {
    regions: Record<string, readonly number[]>;
    steps?: readonly Pick<Gate55ShaderStep, "step" | "fresh">[];
  },
  e: G55fLegEvidence,
  referenceDir: string,
): Promise<G55fCheckpoint[]> {
  const out: G55fCheckpoint[] = [];
  const shots = stepShots55f(e.applied);
  for (let step = 0; step <= G55F_LAST_STEP; step++) {
    const at = shots.get(step);
    const cp: G55fCheckpoint = {
      step,
      seq: at?.seq ?? null,
      frame: at?.frame ?? null,
      shot: at ? join(e.receiverDir, "shots", `seq-${at.seq}.png`) : "",
      reference: join(referenceDir, "shots", `step-${step}.png`),
      mismatched_pixels: null,
      regions: {},
      benign: null,
      stale_from: null,
      stale_exact: null,
    };
    out.push(cp);
    if (!at) continue;
    const ref = await decodePngRgba(cp.reference);
    const got = await decodePngRgba(cp.shot);
    if (!ref || !got || ref.width !== got.width || ref.height !== got.height)
      continue;
    cp.mismatched_pixels = diffRgba(
      ref.data,
      got.data,
      ref.width,
      ref.height,
    ).mismatched_pixels;
    for (const [name, box] of Object.entries(expected.regions))
      cp.regions[name] = diffRgba(
        ref.data,
        got.data,
        ref.width,
        ref.height,
        xywh(box),
      ).mismatched_pixels;
    const regions = mismatchingRegionNames(cp);
    // Every mismatching pixel lies in PH (none outside every region, none in another region).
    const onlyPh =
      regions.length === 1 &&
      regions[0] === G55F_CONTINUOUS_REGION &&
      cp.regions[G55F_CONTINUOUS_REGION] === cp.mismatched_pixels;
    if (cp.mismatched_pixels === 0) cp.benign = true;
    else if (e.host)
      cp.benign =
        onlyPh && wireStateEqualsFullAtFrame(e.host, cp.frame) === true;
    if (e.host) {
      cp.stale_from = staleFromOfSeq(e.host, cp.seq);
      if (cp.stale_from !== null) {
        // G7q: as gate5f-checks.ts: a stale snapshot from before a step the shot's frame is past
        // differs in PH and in every region the fresh table says those steps touch, and only
        // there (PH alone, the window-1 rule, with no step between).
        const allowed = new Set([G55F_CONTINUOUS_REGION]);
        const sf = cp.stale_from;
        for (const st of expected.steps ?? [])
          if (
            st.step >= 1 &&
            G55F_START_FRAME + G55F_STEP_FRAMES * st.step > sf &&
            G55F_START_FRAME + G55F_STEP_FRAMES * st.step <= (cp.frame ?? 0)
          )
            for (const [name, fresh] of Object.entries(st.fresh))
              if (fresh) allowed.add(name);
        const boxes = [...allowed]
          .map((n) => expected.regions[n])
          .filter((b): b is readonly number[] => b !== undefined);
        let outside = 0;
        for (let y = 0; y < ref.height; y++)
          for (let x = 0; x < ref.width; x++) {
            const i = (y * ref.width + x) * 4;
            if (
              ref.data[i] === got.data[i] &&
              ref.data[i + 1] === got.data[i + 1] &&
              ref.data[i + 2] === got.data[i + 2] &&
              ref.data[i + 3] === got.data[i + 3]
            )
              continue;
            if (
              !boxes.some((b) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3])
            )
              outside++;
          }
        cp.stale_exact =
          (cp.mismatched_pixels === 0 || outside === 0) &&
          wireStateEqualsFullAtFrame(e.host, cp.frame, cp.stale_from) === true;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The stall, reused from gate 1's G1d (frame-exact send/credit/recovery, never reimplemented)
// ---------------------------------------------------------------------------------------------

/** The stalled leg's stall report (gate1-g1d-checks.ts's, unmodified: it reads only
 * `applied?.live?.stall`, `host.log`/`host.tap`/`host.full` and the windows/shots given). Also
 * returns the step whose window contains the recovery frame (the "first post-stall shot"). */
export function g55fStallReport(
  host: LiveHostEvidence,
  applied: G55fApplied | undefined,
  steps:
    | { step: number; applied_frame: number; settle_frame: number }[]
    | undefined,
): { report: StallReport; postStallStep: number | null } {
  const windows = g55fWindows();
  const shots: G1dShot[] = (applied?.shots ?? [])
    .filter((s) => Number.isInteger(s.step) && Number.isInteger(s.seq))
    .map((s) => ({
      stream: s.stream ?? 1,
      seq: s.seq as number,
      step: s.step as number,
    }));
  const requested = parseStall(
    // run-gate55.sh passes RS_RECEIVER_STALL directly; env.txt is read by the caller and handed
    // in as `applied.live.stall.ms`/`.step` already, so re-derive the <step>:<ms> spec from them.
    applied?.live?.stall
      ? `${applied.live.stall.step}:${applied.live.stall.ms}`
      : undefined,
  );
  const report = stallReport(
    host,
    // AppliedLive's declared shape is a superset of what stallReport reads (applied.live.stall
    // only); G55fApplied carries the identical stall fields.
    applied as unknown as Parameters<typeof stallReport>[1],
    steps,
    windows,
    shots,
    requested,
  );
  const recoveryFrame = report.recovery?.frame ?? null;
  const postStallStep =
    recoveryFrame === null
      ? null
      : (windows.find((w) => recoveryFrame >= w.from && recoveryFrame <= w.to)
          ?.step ?? null);
  return { report, postStallStep };
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export interface G55fEvaluation {
  e: G55fLegEvidence;
  checkpoints: G55fCheckpoint[];
  stall: StallReport | null;
  postStallStep: number | null;
  classification: G2bClassification;
}

export async function classifyG55fLeg(
  e: G55fLegEvidence,
  expected: { regions: Record<string, readonly number[]> },
  referenceDir: string,
): Promise<G55fEvaluation> {
  const fired = new Map<G2bClass, string[]>();
  const fire = (cls: G2bClass, reason: string) =>
    fired.set(cls, [...(fired.get(cls) ?? []), `${cls}: ${reason}`]);
  const host = e.host;
  const a = e.applied;

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
    if (host.hook.problem)
      fire("capture-failure", `resources.jsonl ${host.hook.problem}`);
    for (const c of host.connections) {
      if (!c.tap.present)
        fire("capture-failure", `tap/stream-${c.n}.rs2 missing`);
    }
  }
  // 2. unsupported
  for (const c of host?.connections ?? [])
    for (const t of c.received?.recording?.transactions ?? [])
      if (t.state.unsupported.length > 0) {
        fire(
          "unsupported",
          `seq ${t.seq}: ${t.state.unsupported.map((u) => `${u.op}/${u.reason}`).join(",")}`,
        );
        break;
      }
  // The stall report (gate 1's G1d, unmodified): send/credit frames, the recovery transaction,
  // and which windows lie wholly inside the stall (missed by design, not a failure).
  const { report: stall, postStallStep } = host
    ? g55fStallReport(
        host.connections[0].host,
        a,
        host.connections[0].host.steps,
      )
    : { report: null as unknown as StallReport, postStallStep: null };
  const expectedMissed = new Set(host ? stall.expected_missed_steps : []);

  // 3. replay-failure
  if (!a) fire("replay-failure", "applied.json missing or unparseable");
  else {
    if (a.status !== "ok")
      fire(
        "replay-failure",
        `status=${a.status} failure=${JSON.stringify(a.failure ?? null)}`,
      );
    if (a.end_seen !== true) fire("replay-failure", "end_seen is not true");
  }
  if (host && a) {
    const c = host.connections[0];
    if (c) {
      const same = sameBytesOrPrefix(c.received, c.tap, false);
      if (same !== null) fire("replay-failure", `connection ${c.n}: ${same}`);
    }
    const shots = stepShots55f(a);
    const missing = Array.from(
      { length: G55F_LAST_STEP + 1 },
      (_, k) => k,
    ).filter((k) => !shots.has(k) && !expectedMissed.has(k));
    if (missing.length > 0)
      fire(
        "replay-failure",
        `no shot for step(s) ${missing.join(",")} (shots_missed ${JSON.stringify(a.shots_missed ?? null)})`,
      );
  }
  // 4. delivery-violation (gate 1's generic delivery report, reused unmodified; `stale-state`
  // reasons are a content-level question for a continuously-animating shader parameter, not a
  // protocol violation, and are the pixel-mismatch class's job here -- see "stale-coalesce" below)
  if (host)
    for (const c of host.connections)
      for (const r of deliveryReasons(deliveryReport(c.host)).filter(
        (x) => !x.includes("stale-state"),
      ))
        fire(
          "delivery-violation",
          `connection ${c.n}: ${r.slice(r.indexOf(":") + 2)}`,
        );

  // 5. pixel-mismatch: every checkpoint whose mismatch is not `benign` (see G55fCheckpoint's doc;
  // this is where the stale-coalesce sabotage's post-stall mismatch fires, since its wire state
  // does not equal the host's full recording at that frame).
  const checkpoints =
    a?.status === "ok" ? await g55fCheckpoints(expected, e, referenceDir) : [];
  for (const cp of checkpoints)
    if (cp.seq !== null && cp.benign !== true)
      fire(
        "pixel-mismatch",
        `step ${cp.step} (seq ${cp.seq}): ${cp.mismatched_pixels ?? "unreadable"} px differ in ${mismatchingRegionNames(cp).join(",") || "?"}`,
      );

  const result_class =
    G2B_PRECEDENCE.find((cls) => fired.has(cls)) ?? "success";
  return {
    e,
    checkpoints,
    stall: host ? stall : null,
    postStallStep,
    classification: {
      result_class,
      reasons: G2B_PRECEDENCE.flatMap((cls) => fired.get(cls) ?? []),
      mismatching_steps: checkpoints
        .filter((c) => c.seq !== null && c.benign !== true)
        .map((c) => c.step),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

type Evals = Map<string, G55fEvaluation>;

function hostOf(evals: Evals, leg: string): G2cHost | null {
  return evals.get(leg)?.e.host ?? null;
}

export function checkLiveTapEqualsReceivedShader(evals: Evals): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of G55F_LEGS.map((l) => l.leg)) {
    const ev = evals.get(leg);
    const host = ev?.e.host;
    if (!host) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    for (const c of host.connections) {
      const same = sameBytesOrPrefix(c.received, c.tap, false);
      if (same !== null) problems.push(`${leg}: ${same}`);
      else notes.push(`${leg} ${c.tap.bytes} B`);
    }
  }
  return check(
    "live-tap-equals-received",
    "on every g55f leg, the received stream is byte for byte the host's tap",
    problems,
    notes.join(", "),
    G55F_LEGS.map((l) =>
      join(
        evals.get(l.leg)?.e.receiverDir ?? l.leg,
        receivedFileName(evals.get(l.leg)?.e.receiverDir ?? l.leg),
      ),
    ),
  );
}

export function checkLiveResolvesToRecordingShader(evals: Evals): G2bCheck {
  const problems: string[] = [];
  let compared = 0;
  for (const leg of G55F_GOOD) {
    const host = hostOf(evals, leg);
    if (!host?.full.recording) {
      problems.push(`${leg}: no full recording`);
      continue;
    }
    const byFrame = new Map(
      host.full.recording.transactions.map((t) => [t.frame, t]),
    );
    for (const c of host.connections)
      for (const t of c.tap.recording?.transactions ?? []) {
        compared++;
        const f = byFrame.get(t.frame);
        if (!f || !statesEqual(f.state, t.state)) {
          problems.push(
            `${leg} seq ${t.seq} (frame ${t.frame}) is not the full recording's state at that frame`,
          );
          break;
        }
      }
  }
  return check(
    "live-resolves-to-recording",
    "every transaction every g55f good leg sent resolves to the full file recording's state at the same frame, shader and material tables included",
    problems,
    `${compared} live transactions equal the host recordings`,
    G55F_GOOD.map((l) => join(hostOf(evals, l)?.dir ?? l, "tap")),
  );
}

export function pinsOfShader(host: G2cHost): PinsReport {
  return pinsReport(
    host.hook.lines,
    host.full.recording?.transactions ?? [],
    connTimelines(host),
    512 * 1024 * 1024,
    okResourceHashes,
  );
}

export function checkPinsBoundedShader(
  evals: Evals,
  pins: Map<string, PinsReport>,
): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of G55F_GOOD) {
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
    "on every g55f good host, after every frame callback the servable GRP1 shader-code hashes (replayed from the pin and retire lines) equal the full recording's ok shader hashes at that frame united with the connection's base, bytes never exceeding the budget",
    problems,
    notes.join("; "),
    G55F_GOOD.map((l) =>
      join(hostOf(evals, l)?.dir ?? l, "evidence", "resources.jsonl"),
    ),
  );
}

export function checkObsoleteRetiredShader(
  evals: Evals,
  pins: Map<string, PinsReport>,
): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of G55F_GOOD) {
    const p = pins.get(leg);
    if (!p) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    for (const m of [...p.late, ...p.early].slice(0, 3))
      problems.push(`${leg}: ${m}`);
    notes.push(`${leg} ${p.retirements} retired of ${p.pins} pinned`);
  }
  return check(
    "obsolete-retired",
    "on every g55f good host, a GRP1 shader-code hash is retired at the first frame callback after which neither the current state nor the connection's base names it, and never while one still does (tint.code -> tint_b at step 3 retires tint's original hash once no material still names it)",
    problems,
    notes.join("; "),
    G55F_GOOD.map((l) =>
      join(hostOf(evals, l)?.dir ?? l, "evidence", "resources.jsonl"),
    ),
  );
}

export function checkHttpGetsMatchFetchesShader(evals: Evals): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of G55F_GOOD) {
    const ev = evals.get(leg);
    const host = ev?.e.host;
    if (!host || !ev?.e.applied) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    const gets = httpGets(host.hook.lines);
    for (const p of getsVsFetches(
      gets,
      ev.e.applied.fetches ?? [],
      ev.e.applied.cache?.mode,
      coldFetchedHashes(
        ev.e.applied.cache?.mode,
        leg === "live-shader-warm"
          ? evals.get("live-shader")?.e.applied?.fetches
          : null,
      ),
    ))
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
    "on every g55f good leg, the host's GET log equals the receiver's http fetch list hash for hash and byte for byte, in order; every hash fetched at most once per process; every fetch a verified 200 with Content-Type application/octet-stream, the right Cache-Control, ETag and Content-Length",
    problems,
    `GETs per leg: ${notes.join(", ")}`,
    G55F_GOOD.map((l) =>
      join(hostOf(evals, l)?.dir ?? l, "evidence", "resources.jsonl"),
    ),
  );
}

export function checkGetsAdvertisedShader(evals: Evals): G2bCheck {
  const problems: string[] = [];
  let total = 0;
  for (const leg of G55F_LEGS.map((l) => l.leg)) {
    const host = hostOf(evals, leg);
    if (!host) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    const gets = httpGets(host.hook.lines);
    total += gets.length;
    for (const p of unadvertisedGets(
      gets,
      connTimelines(host),
      resourceTableHashes,
    ).slice(0, 3))
      problems.push(`${leg}: ${p}`);
  }
  return check(
    "gets-advertised",
    "on every g55f host, every GET names a shader-code or texture hash a transaction already sent on the connection names, at an earlier frame callback",
    problems,
    `${total} GETs, each advertised first`,
    G55F_LEGS.map((l) =>
      join(hostOf(evals, l.leg)?.dir ?? l.leg, "evidence", "resources.jsonl"),
    ),
  );
}

export function checkFetchBeforeAppliedShader(evals: Evals): G2bCheck {
  const problems: string[] = [];
  let total = 0;
  for (const leg of G55F_LEGS.map((l) => l.leg)) {
    const ev = evals.get(leg);
    if (!ev?.e.applied) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    total += (ev.e.applied.fetches ?? []).length;
    for (const p of fetchesAfterApplied(
      ev.e.applied as unknown as Parameters<typeof fetchesAfterApplied>[0],
    ).slice(0, 3))
      problems.push(`${leg}: ${p}`);
  }
  return check(
    "fetch-before-applied",
    "every http fetch for seq n ended (receiver clock) before n's applied ack, on every g55f leg",
    problems,
    `${total} fetches, each before its applied ack`,
    G55F_LEGS.map((l) =>
      join(evals.get(l.leg)?.e.receiverDir ?? l.leg, "applied.json"),
    ),
  );
}

/** The GRP1 (shader) hashes a leg's receiver fetched over HTTP, in fetch order. */
function shaderFetches(a: G55fApplied | undefined): G55fFetch[] {
  return (a?.fetches ?? []).filter((f) => f.kind === "shader");
}

export function checkShaderFetchesLatestOnly(evals: Evals): G2bCheck {
  const problems: string[] = [];
  let detail = "";
  const ev = evals.get("live-shader-stall");
  const stall = ev?.stall;
  const step = ev?.postStallStep;
  if (!ev || !stall?.recovery || step === null || step === undefined) {
    problems.push("live-shader-stall: no stall recovery evidence");
  } else {
    const r = stall.recovery;
    const windows = g55fWindows();
    const w = windows.find((x) => x.step === step);
    if (!w) problems.push(`no shot window for step ${step}`);
    if (r.state_equals_full !== true)
      problems.push(
        `the recovery transaction (seq ${r.seq}, frame ${r.frame}) does not equal the host's full recording at that frame -- it should carry the newest phase and tint_b code, not a stale one`,
      );
    const host = ev.e.host;
    const newestTintHash = host
      ? [
          ...okShaderHashes(
            host.full.recording?.transactions.find((t) => t.frame === r.frame),
          ),
        ]
      : [];
    const shFetches = shaderFetches(ev.e.applied);
    // Only the fetch(es) tied to the recovery seq itself are judged against "the newest" -- a
    // receiver with a fresh cache legitimately fetches every OTHER shader hash it ever needs
    // (the initial six, at earlier seqs), which has nothing to do with the stall's coalescing.
    // G7q: a fetch made for the recovery or for the send it was folded with (one apply) is the
    // apply's (`appliedAs`); at window 1 that is the recovery seq itself.
    const txs = ev.e.applied?.transactions ?? [];
    const applyOf = (seq: number | undefined) =>
      appliedAs(
        txs,
        txs.find((t) => (t.stream ?? 1) === 1 && t.seq === seq),
      )?.seq ?? seq;
    const fetchesForRecovery = shFetches.filter(
      (f) => applyOf(f.seq) === applyOf(r.seq),
    );
    const distinctAtRecovery = new Set(fetchesForRecovery.map((f) => f.hash));
    const unexpected = [...distinctAtRecovery].filter(
      (h) => h !== undefined && !newestTintHash.includes(h as string),
    );
    if (unexpected.length > 0 && newestTintHash.length > 0)
      problems.push(
        `the receiver fetched shader hash(es) ${unexpected.join(",")} at the recovery seq, not among the host's newest ${newestTintHash.join(",")}`,
      );
    detail = `stall after seq ${stall.stalled_seq} (frame ${stall.send_frame}), credit at frame ${stall.credit_frame}; recovery seq ${r.seq} at frame ${r.frame} equals the host's full recording there (${r.state_equals_full}), ${shFetches.length} shader fetch(es) total, ${fetchesForRecovery.length} tied to the recovery seq`;
  }
  return check(
    "shader-fetches-latest-only",
    "live-shader-stall: the first post-stall applied state's phase and tint code hash equal the host's newest (the recovery transaction equals the full recording at its frame), and the receiver's shader-kind fetches never name a hash other than one the host's newest state actually holds",
    problems,
    detail,
    [join(ev?.e.receiverDir ?? "live-shader-stall", "applied.json")],
  );
}

/** The regions expected.json's `steps[].fresh` says change at any step applied during the stall
 * (steps_applied_during; the fixture's own per-step region table, make_expected.py's prediction,
 * never a diff of rendered shots): PH is in every step's `fresh` set (it changes every frame)
 * union the other regions the swallowed steps themselves touch (gate5_5-design.md Q6c -- step 2's
 * IN update and step 3's TI/RM/code change, both inside the 1:2000 stall, make those regions
 * stale too, not only PH). Generalizes gate5f-checks.ts's `regionsChangedDuringStall` (memory
 * rs-g5f-live-mesh-facts fact 3) from Gate5MeshStep to Gate55ShaderStep -- same shape
 * ({step, fresh}), same rule, a different fixture's table. */
function regionsChangedDuringStall(
  steps: readonly Pick<Gate55ShaderStep, "step" | "fresh">[],
  stall: StallReport,
): string[] {
  const touched = new Set(stall.steps_applied_during);
  const out = new Set<string>();
  for (const s of steps)
    if (touched.has(s.step))
      for (const [name, fresh] of Object.entries(s.fresh))
        if (fresh) out.add(name);
  return [...out].sort();
}

export function checkStaleCoalesce(
  evals: Evals,
  steps: readonly Pick<Gate55ShaderStep, "step" | "fresh">[],
): G2bCheck {
  const problems: string[] = [];
  let detail = "";
  const ev = evals.get("sabotage-shader-stale-coalesce");
  const stall = ev?.stall;
  const step = ev?.postStallStep;
  if (!ev || !stall?.recovery || step === null || step === undefined) {
    problems.push("sabotage-shader-stale-coalesce: no stall recovery evidence");
  } else {
    const r = stall.recovery;
    const expectedRegions = regionsChangedDuringStall(steps, stall);
    if (r.stale_from === null)
      problems.push(
        `the recovery transaction (seq ${r.seq}, frame ${r.frame}) is not labelled stale_from -- the sabotage did not trigger`,
      );
    if (r.state_equals_full !== false)
      problems.push(
        `the recovery transaction equals the host's full recording at frame ${r.frame} -- the stale snapshot had no effect on the wire`,
      );
    const cp = ev.checkpoints.find((c) => c.step === step);
    if (!cp || cp.seq === null)
      problems.push(`no post-stall shot for step ${step}`);
    else {
      const regions = mismatchingRegionNames(cp);
      if (regions.length === 0)
        problems.push(
          `step ${step}: the stale shot is pixel-identical to reference-live's -- the sabotage had no visible effect`,
        );
      else if (JSON.stringify(regions) !== JSON.stringify(expectedRegions))
        problems.push(
          `step ${step}: mismatching regions ${regions.join(",")}, expected exactly ${expectedRegions.join(",")} (the regions expected.json says the swallowed steps touch)`,
        );
      if (cp.benign === true)
        problems.push(
          `step ${step}: the mismatch was judged benign (the wire's own state equals the host's full recording at frame ${cp.frame}) -- the sabotage had no effect on the wire`,
        );
      detail = `recovery seq ${r.seq} at frame ${r.frame}, stale_from ${r.stale_from}; step ${step}'s shot (frame ${cp.frame}) mismatches reference-live exactly in ${regions.join(",") || "none"}, not benign`;
    }
  }
  return check(
    "stale-coalesce",
    "sabotage-shader-stale-coalesce: the recovery transaction is labelled stale_from and does not equal the host's full recording at its frame; the leg's overall classification is pixel-mismatch, and the regions differing from reference-live at the post-stall shot are exactly PH and TI (regions expected.json's per-step fresh table says the stall's swallowed steps touch), judged not benign (the wire itself is wrong, not just off by a frame)",
    problems,
    detail,
    [
      join(
        ev?.e.receiverDir ?? "sabotage-shader-stale-coalesce",
        "applied.json",
      ),
    ],
  );
}

export function checkReceiverVsReferenceShader(evals: Evals): G2bCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const evidence: string[] = [];
  for (const leg of G55F_LEGS.map((l) => l.leg)) {
    const ev = evals.get(leg);
    if (!ev) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    // Windows wholly inside a stall have no shot at all (expected, gate1-design.md G1d); the
    // sabotage leg's own post-stall shot is deliberately non-benign and is the "stale-coalesce"
    // check's job, not this one's.
    const expectedMissed = new Set(ev.stall?.expected_missed_steps ?? []);
    const excludeStep =
      leg === "sabotage-shader-stale-coalesce" ? ev.postStallStep : null;
    const checked = ev.checkpoints.filter(
      (c) => !expectedMissed.has(c.step) && c.step !== excludeStep,
    );
    if (checked.length === 0) problems.push(`${leg}: no checkpoints`);
    // Outside its stall, the sabotage leg's host still rewrites every ordinary coalesced send to
    // carry an older frame (see the header): a shot on one of those is judged against the frame
    // the wire says it carries (`stale_exact`), never on a good leg, where a stale send is a bug.
    const staleTolerated = leg === G55F_SABOTAGE_LEG;
    let ok = 0;
    let stale = 0;
    for (const c of checked) {
      evidence.push(c.shot);
      if (c.seq === null) problems.push(`${leg} step ${c.step}: no shot`);
      else if (c.mismatched_pixels === null)
        problems.push(`${leg} step ${c.step}: unreadable shot`);
      else if (c.benign === true || c.mismatched_pixels === 0) ok++;
      else if (staleTolerated && c.stale_exact === true) {
        ok++;
        stale++;
      } else
        problems.push(
          `${leg} step ${c.step} (seq ${c.seq}${c.stale_from !== null ? `, stale_from ${c.stale_from}${c.stale_exact === true ? "" : ", not stale_exact"}` : ""}): ${c.mismatched_pixels} px differ in ${mismatchingRegionNames(c).join(",") || "no region"}`,
        );
    }
    notes.push(
      `${leg} ${ok}/${checked.length}${stale > 0 ? ` (${stale} on a stale_from send, wire == full at stale_from)` : ""}`,
    );
  }
  return check(
    "receiver-vs-reference",
    "every g55f leg's shot at every settle step outside the stall window equals reference-live's step shot exactly, full frame (reference-live runs the same fixture at G55f's own live timeline, so PH's per-frame value lines up with the live shot's actual frame); a PH-only difference is tolerated when the wire's own state at that frame equals the host's full recording there (ordinary round-trip jitter, not a correctness problem), and on the stale-coalesce sabotage leg only when the shot's send is labelled stale_from F and the wire's state there equals the host's full recording at F exactly (the sabotage rewriting an ordinary coalesced send outside the stall, which CPU load makes common)",
    problems,
    notes.join(", "),
    evidence,
  );
}

export async function checkWarmHostNoGetsShader(
  evals: Evals,
): Promise<G2bCheck> {
  const problems: string[] = [];
  const warm = evals.get("live-shader-warm");
  const live = evals.get("live-shader");
  const host = warm?.e.host;
  if (!warm || !host || !live)
    problems.push("live-shader-warm or live-shader not evaluated");
  else {
    const gets = httpGets(host.hook.lines).length;
    if (gets !== 0 || (host.serving?.http_gets ?? -1) !== 0)
      problems.push(
        `the warm host logged ${gets} GETs (summary ${host.serving?.http_gets})`,
      );
    const liveFetched =
      live.e.applied?.resources_summary?.distinct_fetched ?? -1;
    // G7l: a browser receiver's cache is the cold leg's profile's HTTP cache (warmCacheProblems).
    problems.push(...warmCacheProblems(warm.e.applied, liveFetched));
    // Neither leg stalls, so every checkpoint against reference-live must be a full match or a
    // benign PH-only one (the same round-trip jitter g55fCheckpoints already judges: comparing
    // live-shader's and live-shader-warm's shots against each other, rather than against
    // reference-live, would otherwise double-count that jitter as a failure).
    for (const cp of [...warm.checkpoints, ...live.checkpoints]) {
      if (cp.seq === null || cp.benign === true) continue;
      problems.push(
        `step ${cp.step}: ${cp.mismatched_pixels ?? "unreadable"} px differ in ${mismatchingRegionNames(cp).join(",") || "?"}`,
      );
    }
  }
  return check(
    "warm-host-no-gets",
    "live-shader-warm (a new host and a new receiver on live-shader's cache, mode warm): the host answers no GET at all, the receiver fetches nothing and hits its cache once per payload live-shader fetched, and its shot per step equals reference-live exactly (as live-shader's does); G7l, a browser receiver: its cache is the cold leg's profile's HTTP cache, so it fetches exactly what live-shader fetched, each answered 200 while the host serves none",
    problems,
    `0 GETs, ${warm?.e.applied?.resources_summary?.cache_hits ?? 0} cache hits, shots equal reference-live's`,
    [join(host?.dir ?? "live-shader-warm", "evidence", "resources.jsonl")],
  );
}

function checkLegClass55f(
  e: G2bLegExpectation,
  c: G2bClassification,
  extra: string[],
  evidence: string[],
): G2bCheck {
  const problems: string[] = [...extra];
  if (c.result_class !== e.expected_class)
    problems.push(
      `class ${c.result_class}, expected ${e.expected_class}: ${c.reasons.slice(0, 3).join(" | ")}`,
    );
  return check(
    `leg-class-${e.leg}`,
    `${e.leg} classifies ${e.expected_class}`,
    problems,
    `class ${c.result_class}`,
    evidence,
  );
}

// ---------------------------------------------------------------------------------------------
// The g55f group
// ---------------------------------------------------------------------------------------------

export interface G55fLegReport {
  group: "g55f";
  expected_class: G2bClass;
  result_class: G2bClass;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface G55fResult {
  checks: G2bCheck[];
  legs: Record<string, G55fLegReport>;
  stall: {
    live_shader_stall: {
      send_frame: number | null;
      credit_frame: number | null;
      post_stall_step: number | null;
      coalesced_delta: number | null;
    };
    sabotage: {
      send_frame: number | null;
      credit_frame: number | null;
      post_stall_step: number | null;
      stale_from: number | null;
    };
  };
}

export async function runGate55f(
  outDir: string,
  expected: { regions: Record<string, readonly number[]> } & {
    steps: readonly Pick<Gate55ShaderStep, "step" | "fresh">[];
  },
): Promise<G55fResult> {
  const S = join(outDir, "shader-live");
  const referenceDir = join(S, "reference-live");
  const loaded = new Map<string, G55fLegEvidence>();
  for (const l of G55F_LEGS) loaded.set(l.leg, await loadG55fLeg(S, l.leg));
  const evals: Evals = new Map();
  for (const l of G55F_LEGS) {
    const e = loaded.get(l.leg) as G55fLegEvidence;
    evals.set(l.leg, await classifyG55fLeg(e, expected, referenceDir));
  }
  const pins = new Map<string, PinsReport>();
  for (const leg of G55F_GOOD) {
    const host = hostOf(evals, leg);
    if (host) pins.set(leg, pinsOfShader(host));
  }
  const checks: G2bCheck[] = [
    checkLiveTapEqualsReceivedShader(evals),
    checkLiveResolvesToRecordingShader(evals),
    checkPinsBoundedShader(evals, pins),
    checkObsoleteRetiredShader(evals, pins),
    checkHttpGetsMatchFetchesShader(evals),
    checkGetsAdvertisedShader(evals),
    checkFetchBeforeAppliedShader(evals),
    checkShaderFetchesLatestOnly(evals),
    checkReceiverVsReferenceShader(evals),
    checkStaleCoalesce(evals, expected.steps),
    await checkWarmHostNoGetsShader(evals),
  ];
  const legs: Record<string, G55fLegReport> = {};
  for (const l of G55F_LEGS) {
    const ev = evals.get(l.leg) as G55fEvaluation;
    const artifacts = [
      join(ev.e.receiverDir, "applied.json"),
      join(ev.e.receiverDir, "stdout.log"),
    ];
    checks.push(checkLegClass55f(l, ev.classification, [], artifacts));
    legs[l.leg] = {
      group: "g55f",
      expected_class: l.expected_class,
      result_class: ev.classification.result_class,
      reasons: ev.classification.reasons,
      exit_code: ev.e.exit,
      artifacts,
    };
  }
  const stallEv = evals.get("live-shader-stall");
  const sabEv = evals.get("sabotage-shader-stale-coalesce");
  return {
    checks,
    legs,
    stall: {
      live_shader_stall: {
        send_frame: stallEv?.stall?.send_frame ?? null,
        credit_frame: stallEv?.stall?.credit_frame ?? null,
        post_stall_step: stallEv?.postStallStep ?? null,
        coalesced_delta: stallEv?.stall?.coalesced_delta ?? null,
      },
      sabotage: {
        send_frame: sabEv?.stall?.send_frame ?? null,
        credit_frame: sabEv?.stall?.credit_frame ?? null,
        post_stall_step: sabEv?.postStallStep ?? null,
        stale_from: sabEv?.stall?.recovery?.stale_from ?? null,
      },
    },
  };
}
