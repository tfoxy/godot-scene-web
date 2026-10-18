// Gate 6 group g6l (protocol/gate6-design.md "G6l", Q7c): live motion compared frame for frame,
// a 2-s receiver stall across a resource update, reconnect and a warm cache, on
// fixtures/gate6-scene's `animate` variant with the live timeline (S=300, N=60, quit 1080) and
// `steps` time (D6), on render-stream/6 since G6b (render-stream/5 when G6l landed).
//
// The rule every pixel judgement here follows (memories g5f-stale-coalesce-receiver-vs-reference-
// flake and rs-g5f-live-mesh-facts): a live shot is never compared with a nominal frame. Each shot
// names one transaction (stream, seq); the host's live log names the frame that transaction was
// sent at and, when stale-coalesce rewrote it, the frame its snapshot came from (`stale_from`).
// That wire frame W is checked against the host's own full recording (the tap's resolved state
// must equal the full recording's at W), and the shot against the rendered reference's shot of
// that exact host frame W (reference-live-frames shoots every such frame; frame-indexed time makes
// host frame f reference frame f). Budget 0, whole frame, HU included since G6b (on /5 the HUD's
// CanvasLayer was the session-level `extra-canvas` and HU was excluded). An honest leg's W must
// equal the frame the shot claims; the sabotage's rewritten sends are exactly where W differs.
//
// Pure over an evidence directory written by run-gate6.sh's run_g6l (under <out>/live/), or pure
// over values read from one, so scripts/test/self-test-gate6.ts drives each evaluator with
// synthetic values. Nothing here launches a process.
//
// Evidence layout under <out>/live/:
//   import/{fixture,receiver}/            editor --import passes
//   <leg>/host/       recording.rs2, recording-patch.rs2, store/, steps.jsonl, tap/stream-<n>.rs2,
//                     tap/live-<n>.jsonl, evidence/{result,live,live-summary,perf}.json,
//                     evidence/resources.jsonl
//   <leg>/receiver/   applied.json, received.rs2 (received-2.rs2 after a reconnect), cache/,
//                     shots/seq-<n>.png (stream-2-seq-<n>.png), state/
//   reference-live-frames/   shots/frame-<f>.png (and step-<k>.png), steps.jsonl
//   reference-file/          shots/step-<k>.png (the animate variant on the file timeline)

import { join } from "node:path";

import {
  decodePngRgba,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import { parseStepLog, readExitCode, type StepLine } from "./gate0-checks";
import {
  type G1dShot,
  parseStall,
  type ShotWindow,
  type StallReport,
  shotName,
  stallReport,
} from "./gate1-g1d-checks";
import {
  connectionSummary,
  type DeliveryReport,
  deliveryReasons,
  deliveryReport,
  type LiveConnectionSummary,
  type LiveLogLine,
  receivedFileName,
} from "./gate1-live-checks";
import {
  G2B_PRECEDENCE,
  type G2bClass,
  type HookLine,
  loadResolved,
} from "./gate2b-checks";
import {
  coldFetchedHashes,
  fetchesAfterApplied,
  type G2cApplied,
  type G2cHost,
  getsVsFetches,
  httpGets,
  isPrefix,
  loadHost,
  meshTableHashes,
  okImageHashes,
  okMeshHashes,
  okShaderHashes,
  type PinsReport,
  percentile,
  pinsReport,
  shaderTableHashes,
  tableHashes,
  unadvertisedGets,
} from "./gate2c-checks";
import { check } from "./gate5-checks";
import type { Box } from "./gate5-expected";
import { connTimelinesAtCallback } from "./gate5f-checks";
import { type Gate6Expected, regionMap } from "./gate6-expected";
import {
  diffFrames6,
  excludedRegions,
  type Frame6,
  type Gate6Check,
} from "./gate6a-checks";
import { type ResolvedTransaction, statesEqual } from "./render-stream-2";

// ---------------------------------------------------------------------------------------------
// The live timeline, the windows and the legs (run-gate6.sh's G6L_* constants, mirrored)
// ---------------------------------------------------------------------------------------------

export const G6L_DIR = "live";
/** S: 300 for every G6l run. G7u part D's device lifecycle runs may raise it (run-gate6.sh
 * G7U_START_FRAME); their checker sets it with setG6lStartFrame for that run only and restores
 * it, so the derived frames below are S's. */
export let G6L_START_FRAME = 300;
export const G6L_DEFAULT_START_FRAME = 300;
export const G6L_STEP_FRAMES = 60;
export const G6L_LAST_STEP = 11;
export let G6L_QUIT_FRAME = G6L_START_FRAME + G6L_STEP_FRAMES * 13;
export const G6L_SETTLE_OFFSET = 7;
export const G6L_STALL_SPEC = "2:2000";
export const G6L_RECONNECT_STEP = 5;
export let G6L_SABOTAGE_FRAME = G6L_START_FRAME + G6L_STEP_FRAMES * 2;
export const G6L_MOTION_WINDOWS = 40;
export let G6L_MOTION_FIRST = G6L_START_FRAME + 20;
export const G6L_MOTION_LABEL = 100;

/** Sets S (run-gate6.sh's G6L_START_FRAME override) and every frame derived from it; returns the
 * previous S. Only G7u's device runs call it (lib/gate7u-checks.ts), restoring 300 after. */
export function setG6lStartFrame(s: number): number {
  const previous = G6L_START_FRAME;
  G6L_START_FRAME = s;
  G6L_QUIT_FRAME = s + G6L_STEP_FRAMES * 13;
  G6L_SABOTAGE_FRAME = s + G6L_STEP_FRAMES * 2;
  G6L_MOTION_FIRST = s + 20;
  return previous;
}
/** Q7c: consecutive applied frames differ by at most this at 60/60 (outside the stall and the
 * reconnect, and, As built (G6l), after a transaction that waited on an HTTP fetch or was shot). */
export const G6L_MAX_GAP = 2;
/** The regions continuous animation never touches in `animate` (Q6c: MS, SM, AN, PB every frame;
 * Q6d: TR and RT through TEXA, LB, SC and CD): at a settle shot their pixels are the step's alone,
 * so they equal the file-timeline reference's step shot. HU joined at G6b (render-stream/6 carries
 * the HUD layer; on /5 it was excluded). */
export const G6L_STEP_ONLY_REGIONS: readonly string[] = [
  "NP",
  "Marker",
  "BT",
  "LE",
  "CM",
  "HB",
  "TL",
  "HU",
];
/** Q7c: the regions whose per-frame motion makes a stale post-stall target differ always. */
export const G6L_STALE_MOTION_REGIONS: readonly string[] = ["MS", "SM", "AN"];
/** What the live wire types: nothing since G6b (render-stream/6 carries the HUD layer); on /5 it
 * was `viewport_attach_canvas/extra-canvas` (G6a). */
export const G6L_WIRE_UNSUPPORTED: readonly string[] = [];

export interface G6lLeg {
  leg: string;
  expected_pixel: "success" | "pixel-mismatch";
  stall: boolean;
  reconnect: boolean;
}

export const G6L_LEGS: readonly G6lLeg[] = [
  {
    leg: "live-scene",
    expected_pixel: "success",
    stall: false,
    reconnect: false,
  },
  {
    leg: "live-scene-warm",
    expected_pixel: "success",
    stall: false,
    reconnect: false,
  },
  {
    leg: "live-stall",
    expected_pixel: "success",
    stall: true,
    reconnect: false,
  },
  {
    leg: "live-reconnect",
    expected_pixel: "success",
    stall: false,
    reconnect: true,
  },
  {
    leg: "sabotage-live-stale-coalesce",
    expected_pixel: "pixel-mismatch",
    stall: true,
    reconnect: false,
  },
];
export const G6L_GOOD: readonly string[] = G6L_LEGS.filter(
  (l) => l.expected_pixel === "success",
).map((l) => l.leg);

/** The live timeline's applied frame of step k (step 0 is the `_ready` state, frame 1). */
export function liveAppliedFrame(k: number): number {
  return k === 0 ? 1 : G6L_START_FRAME + G6L_STEP_FRAMES * k;
}

export function liveSettleFrame(k: number): number {
  return G6L_START_FRAME + G6L_STEP_FRAMES * k + G6L_SETTLE_OFFSET;
}

/** The step in force at host frame `frame` on the live timeline. */
export function liveStepAt(frame: number): number {
  let k = 0;
  for (let s = 1; s <= G6L_LAST_STEP; s++)
    if (liveAppliedFrame(s) <= frame) k = s;
  return k;
}

/** The receiver's windows, in the order run-gate6.sh's g6l_windows lists them. */
export function g6lWindows(): ShotWindow[] {
  const out: ShotWindow[] = [];
  for (let k = 0; k <= G6L_LAST_STEP; k++)
    out.push({
      step: k,
      from: liveSettleFrame(k),
      to:
        k === G6L_LAST_STEP
          ? G6L_QUIT_FRAME
          : G6L_START_FRAME + G6L_STEP_FRAMES * (k + 1) - 1,
    });
  for (let i = 0; i < G6L_MOTION_WINDOWS; i++) {
    const from = G6L_MOTION_FIRST + Math.floor((37 * i) / 2);
    out.push({ step: G6L_MOTION_LABEL + i, from, to: from + 9 });
  }
  return out;
}

/** The region boxes in force at a live-timeline host frame: those of the step in force (the
 * expected.json settle shot of that step; regions move only with the step-10 canvas shift). */
export function regionsAtFrame(
  e: Pick<Gate6Expected, "shots">,
  frame: number,
): Record<string, Box> {
  const k = liveStepAt(frame);
  return e.shots.find((s) => s.id === `step-${k}`)?.regions ?? {};
}

function hashUnion(t: ResolvedTransaction | undefined): Set<string> {
  return new Set([
    ...okImageHashes(t),
    ...okMeshHashes(t),
    ...okShaderHashes(t),
  ]);
}
function tableUnion(t: ResolvedTransaction): Set<string> {
  return new Set([
    ...tableHashes(t),
    ...meshTableHashes(t),
    ...shaderTableHashes(t),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

export interface G6lApplied extends G2cApplied {
  transactions?: Array<
    NonNullable<G2cApplied["transactions"]>[number] & {
      stream?: number;
    }
  >;
  live?:
    | (NonNullable<G2cApplied["live"]> & {
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
          closed_us?: number | null;
          memory?: string;
          memory_hashes?: string[];
          cache_hashes?: string[];
        } | null;
      })
    | null;
}

export interface G6lLegEvidence {
  leg: string;
  host: G2cHost | null;
  receiverDir: string;
  applied: G6lApplied | undefined;
  exit: number | null;
  perf: CapturePerf | undefined;
}

/** evidence/perf.json (render-stream-capture-perf/1, G6r), the parts g6l reports. */
export interface CapturePerf {
  histograms?: {
    credit_rtt_us?: Record<string, PerfHistogram>;
    staleness_us?: Record<string, PerfHistogram>;
  };
}
export interface PerfHistogram {
  count?: number;
  min?: number;
  max?: number;
  mean?: number;
  buckets?: [number, number][];
}

export async function loadG6lLeg(
  liveDir: string,
  leg: string,
): Promise<G6lLegEvidence> {
  const legDir = join(liveDir, leg);
  const host = await loadHost(join(legDir, "host"));
  const receiverDir = join(legDir, "receiver");
  // loadHost reads the host's own evidence only; each connection's received copy is the
  // receiver's (memory rs-g5f-live-mesh-facts fact 4).
  for (const c of host.connections) {
    // G7l/G7g: a browser (/7) receiver writes received(-n).rs7.
    const name = receivedFileName(receiverDir, c.n);
    const r = await loadResolved(join(receiverDir, name));
    c.received = r.present ? r : null;
  }
  const applied = await readJson<G6lApplied>(join(receiverDir, "applied.json"));
  return {
    leg,
    host: host.full.present ? host : null,
    receiverDir,
    applied:
      applied && typeof applied === "object"
        ? (applied as G6lApplied)
        : undefined,
    exit: await readExitCode(receiverDir),
    perf: await readJson<CapturePerf>(
      join(legDir, "host", "evidence", "perf.json"),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// The wire frame of a shot
// ---------------------------------------------------------------------------------------------

export interface WireSend {
  frame: number;
  stale_from: number | null;
}

/** seq -> the frame it was sent at and the snapshot frame it carried, from a live log (pure). */
export function wireSends(
  log: readonly LiveLogLine[] | undefined,
): Map<number, WireSend> {
  const out = new Map<number, WireSend>();
  for (const l of log ?? [])
    if (l.event === undefined && l.sent && !l.sent.dropped)
      out.set(l.sent.seq, {
        frame: l.frame,
        stale_from: l.sent.stale_from ?? null,
      });
  return out;
}

/** The frame the connection's tapped transaction `seq` must equal the full recording at (its
 * snapshot's frame), and whether it does. */
export function wireFrameOf(
  host: G2cHost,
  connection: number,
  seq: number,
): { frame: number | null; wire: number | null; equals_full: boolean | null } {
  const c = host.connections.find((x) => x.n === connection);
  const send = wireSends(c?.host.log).get(seq);
  if (!c || !send) return { frame: null, wire: null, equals_full: null };
  const wire = send.stale_from ?? send.frame;
  const tap = c.tap.recording?.transactions.find((t) => t.seq === seq);
  const full = host.full.recording?.transactions.find((t) => t.frame === wire);
  return {
    frame: send.frame,
    wire,
    equals_full: tap && full ? statesEqual(tap.state, full.state) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Checkpoints: every receiver shot against the reference's shot of its wire frame
// ---------------------------------------------------------------------------------------------

export interface G6lCheckpoint {
  leg: string;
  stream: number;
  seq: number;
  window: number;
  /** the frame the transaction was sent at (what the shot claims) */
  frame: number | null;
  /** the frame its snapshot came from (frame, or stale-coalesce's stale_from) */
  wire: number | null;
  /** the tap's state at this seq equals the full recording's at `wire` */
  wire_equals_full: boolean | null;
  shot: string;
  /** mismatching pixels against reference-live-frames' frame-<wire>.png (whole frame) */
  vs_wire: number | null;
  vs_wire_regions: string[];
  /** mismatching pixels against reference-live-frames' frame-<frame>.png (whole frame) */
  vs_frame: number | null;
  vs_frame_regions: string[];
}

export type FrameLoader = (path: string) => Promise<Frame6 | null>;

const frameCache = new Map<string, Promise<Frame6 | null>>();
export const loadFrame: FrameLoader = (path) => {
  let p = frameCache.get(path);
  if (!p) {
    p = decodePngRgba(path).then((png) =>
      png ? { width: png.width, height: png.height, rgba: png.data } : null,
    );
    frameCache.set(path, p);
  }
  return p;
};

/** Mismatching pixel count and regions of two frames, regions at `frame` (nothing excluded in
 * `animate` since G6b; HU was on /5). */
export function compareAt(
  e: Pick<Gate6Expected, "shots">,
  a: Frame6 | null,
  b: Frame6 | null,
  frame: number,
): { mismatched: number | null; regions: string[] } {
  if (!a || !b || a.width !== b.width || a.height !== b.height)
    return { mismatched: null, regions: [] };
  const map = regionMapAt(e, liveStepAt(frame), a.width, a.height);
  const exclude = excludedRegions("animate");
  let mismatched = 0;
  const regions = new Set<string>();
  for (let i = 0; i < a.width * a.height; i++) {
    const region = map[i];
    if (exclude.has(region)) continue;
    const j = i * 4;
    if (
      a.rgba[j] !== b.rgba[j] ||
      a.rgba[j + 1] !== b.rgba[j + 1] ||
      a.rgba[j + 2] !== b.rgba[j + 2] ||
      a.rgba[j + 3] !== b.rgba[j + 3]
    ) {
      mismatched++;
      regions.add(region);
    }
  }
  return { mismatched, regions: [...regions].sort() };
}

/** diffFrames6's pixel-to-region attribution, built once per step (regions move only at step 10). */
const regionMaps = new Map<string, string[]>();
function regionMapAt(
  e: Pick<Gate6Expected, "shots">,
  step: number,
  width: number,
  height: number,
): string[] {
  const key = `${step}:${width}x${height}`;
  let map = regionMaps.get(key);
  if (!map) {
    map = regionMap(
      e.shots.find((s) => s.id === `step-${step}`)?.regions ?? {},
      width,
      height,
    );
    regionMaps.set(key, map);
  }
  return map;
}

export function referenceFrame(liveDir: string, frame: number): string {
  return join(liveDir, "reference-live-frames", "shots", `frame-${frame}.png`);
}

export async function g6lCheckpoints(
  e: Pick<Gate6Expected, "shots">,
  ev: G6lLegEvidence,
  liveDir: string,
  load: FrameLoader = loadFrame,
): Promise<G6lCheckpoint[]> {
  const out: G6lCheckpoint[] = [];
  const host = ev.host;
  for (const s of ev.applied?.shots ?? []) {
    if (!Number.isInteger(s.seq) || !Number.isInteger(s.step)) continue;
    const stream = s.stream ?? 1;
    const seq = s.seq as number;
    const w = host
      ? wireFrameOf(host, stream, seq)
      : { frame: null, wire: null, equals_full: null };
    const cp: G6lCheckpoint = {
      leg: ev.leg,
      stream,
      seq,
      window: s.step as number,
      frame: w.frame,
      wire: w.wire,
      wire_equals_full: w.equals_full,
      shot: join(ev.receiverDir, "shots", shotName(stream, seq)),
      vs_wire: null,
      vs_wire_regions: [],
      vs_frame: null,
      vs_frame_regions: [],
    };
    out.push(cp);
    if (w.frame === null || w.wire === null) continue;
    const got = await load(cp.shot);
    const atWire = compareAt(
      e,
      await load(referenceFrame(liveDir, w.wire)),
      got,
      w.wire,
    );
    cp.vs_wire = atWire.mismatched;
    cp.vs_wire_regions = atWire.regions;
    if (w.wire === w.frame) {
      cp.vs_frame = cp.vs_wire;
      cp.vs_frame_regions = cp.vs_wire_regions;
    } else {
      const atFrame = compareAt(
        e,
        await load(referenceFrame(liveDir, w.frame)),
        got,
        w.frame,
      );
      cp.vs_frame = atFrame.mismatched;
      cp.vs_frame_regions = atFrame.regions;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pure evaluators (self-tested)
// ---------------------------------------------------------------------------------------------

export interface AppliedTx {
  stream: number;
  seq: number;
  frame: number;
  fetched: number;
  /** receiver clock: from reading the transaction to its submitted ack (null when unknown) */
  receive_to_submit_us: number | null;
}

/** The applied (not skipped) transactions of a receiver, in apply order. */
export function appliedTransactions(a: G6lApplied | undefined): AppliedTx[] {
  return (a?.transactions ?? [])
    .filter((t) => typeof t.applied_us === "number" && !t.skipped)
    .map((t) => ({
      stream: t.stream ?? 1,
      seq: t.seq ?? 0,
      frame: t.frame ?? 0,
      fetched: t.resources?.fetched ?? 0,
      receive_to_submit_us:
        typeof t.received_us === "number" && typeof t.submitted_us === "number"
          ? t.submitted_us - t.received_us
          : null,
    }));
}

/** One host frame at 60 fps, the receiver's own frame budget (both run --max-fps 60). */
export const G6L_FRAME_US = 1_000_000 / 60;

export interface MotionReport {
  problems: string[];
  /** gaps between consecutive applied frames inside the motion span, by size */
  gaps: Record<string, number>;
  /** gaps > G6L_MAX_GAP by attributed cause: stall, reconnect, or receiver-<why> (the earlier
   * transaction's receipt-to-submitted time exceeded a frame: fetch, shot or frame) */
  attributed: Record<string, number>;
  max_gap: number;
  /** the host sent each transaction this many callbacks after its predecessor's credit */
  credit_to_send: Record<string, number>;
}

/**
 * motion-monotonic (pure). Per stream, applied host frames strictly increase. From frame `from`
 * to `to`, a gap > G6L_MAX_GAP between consecutive applied frames must be attributed: to the stall
 * (the stalled seq to the next), the reconnect (connection 1's last to connection 2's first), or
 * the receiver itself, when its receipt-to-submitted time for the earlier transaction exceeded one
 * frame (G6L_FRAME_US). Both ends run at 60 fps and the host sends at the first callback after a
 * credit (checked from its log by `creditToSend`), so a gap of 3 or more needs the receiver to hold
 * the credit longer than a frame; what held it is reported (an HTTP fetch, which is frame-quantized
 * (memory rs-g2c2-live-resource-facts); a shot and its state dump; or the frame alone). A gap > 2
 * with a receiver faster than a frame would be the host's or the wire's, and fails.
 */
export function evaluateMotionMonotonic(
  tx: readonly AppliedTx[],
  shots: ReadonlySet<string>,
  stallSeq: number | null,
  from: number,
  to: number,
): MotionReport {
  const out: MotionReport = {
    problems: [],
    gaps: {},
    attributed: {},
    max_gap: 0,
    credit_to_send: {},
  };
  const add = (cause: string) => {
    out.attributed[cause] = (out.attributed[cause] ?? 0) + 1;
  };
  for (let i = 1; i < tx.length; i++) {
    const p = tx[i - 1];
    const n = tx[i];
    if (p.stream !== n.stream) {
      if (n.stream !== p.stream + 1)
        out.problems.push(
          `stream ${p.stream} seq ${p.seq} is followed by stream ${n.stream}`,
        );
      else if (p.frame >= from && n.frame <= to) add("reconnect");
      continue;
    }
    const gap = n.frame - p.frame;
    if (gap <= 0) {
      out.problems.push(
        `stream ${n.stream}: seq ${n.seq} applied frame ${n.frame} after frame ${p.frame}`,
      );
      continue;
    }
    if (p.frame < from || n.frame > to) continue;
    out.gaps[String(gap)] = (out.gaps[String(gap)] ?? 0) + 1;
    out.max_gap = Math.max(out.max_gap, gap);
    if (gap <= G6L_MAX_GAP) continue;
    if (stallSeq !== null && p.seq === stallSeq && p.stream === 1) {
      add("stall");
      continue;
    }
    if (
      p.receive_to_submit_us !== null &&
      p.receive_to_submit_us > G6L_FRAME_US
    ) {
      add(
        p.fetched > 0
          ? "receiver-fetch"
          : shots.has(`${p.stream}:${p.seq}`)
            ? "receiver-shot"
            : "receiver-frame",
      );
      continue;
    }
    if (out.problems.length < 8)
      out.problems.push(
        `stream ${n.stream}: frames ${p.frame} -> ${n.frame} (gap ${gap}) although the receiver held seq ${p.seq} only ${p.receive_to_submit_us ?? "?"} us`,
      );
  }
  return out;
}

/**
 * The host's side of the cadence (pure): for every send after the first, the number of frame
 * callbacks between the credit for the previous seq (its crediting ack or resync line) and the
 * send; 0 means the first callback after the credit sent.
 */
export function creditToSend(log: readonly LiveLogLine[] | undefined): {
  delays: Record<string, number>;
  problems: string[];
} {
  const delays: Record<string, number> = {};
  const problems: string[] = [];
  const lines = log ?? [];
  const creditIndex = new Map<number, number>();
  let last: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (
      (l.event === "ack" || l.event === "resync") &&
      l.credited === true &&
      l.seq !== undefined
    )
      creditIndex.set(l.seq, i);
    if (l.event !== undefined || !l.sent || l.sent.dropped) continue;
    if (last !== null) {
      const ci = creditIndex.get(last);
      if (ci === undefined)
        problems.push(
          `frame ${l.frame}: seq ${l.sent.seq} sent before seq ${last} was credited`,
        );
      else {
        let callbacks = 0;
        for (let j = ci + 1; j < i; j++)
          if (lines[j].event === undefined && lines[j].state !== undefined)
            callbacks++;
        delays[String(callbacks)] = (delays[String(callbacks)] ?? 0) + 1;
        if (callbacks > 0 && problems.length < 4)
          problems.push(
            `frame ${l.frame}: seq ${l.sent.seq} sent ${callbacks} callbacks after seq ${last}'s credit`,
          );
      }
    }
    last = l.sent.seq;
  }
  return { delays, problems };
}

/** A texture's versions from the hook log: [frame, hash] of its create and every update. */
export function textureVersions(
  lines: readonly Pick<HookLine, "frame" | "op" | "id" | "hash" | "kind">[],
  id: number,
): [number, string][] {
  return lines
    .filter(
      (l) =>
        l.id === id &&
        l.kind === "image" &&
        (l.op === "texture_2d_create" || l.op === "texture_2d_update") &&
        l.hash !== null,
    )
    .map((l) => [l.frame, l.hash as string] as [number, string]);
}

/** TEXA's id: the texture whose create carries TEXA(0)'s predicted GRT1 hash. */
export function texaId(
  lines: readonly Pick<HookLine, "op" | "id" | "hash">[],
  texa0: string,
): number | null {
  return (
    lines.find((l) => l.op === "texture_2d_create" && l.hash === texa0)?.id ??
    null
  );
}

/**
 * fetch-latest-only (pure): among TEXA's versions that landed inside the stall (frames in
 * (send_frame, credit_frame]), exactly one is fetched, for the recovery transaction, and it is
 * the version current at the recovery transaction's frame.
 */
export function evaluateFetchLatestOnly(
  versions: readonly [number, string][],
  fetches: readonly {
    stream?: number;
    seq?: number;
    hash?: string;
    source?: string;
  }[],
  sendFrame: number,
  creditFrame: number,
  recovery: { seq: number; frame: number },
): { problems: string[]; in_stall: string[]; current: string | null } {
  const problems: string[] = [];
  const inStall = versions
    .filter(([f]) => f > sendFrame && f <= creditFrame)
    .map(([, h]) => h);
  const current =
    [...versions].filter(([f]) => f <= recovery.frame).at(-1)?.[1] ?? null;
  if (inStall.length === 0)
    problems.push(
      `no TEXA version landed inside the stall (frames ${sendFrame + 1}..${creditFrame})`,
    );
  if (current === null || !inStall.includes(current))
    problems.push(
      `TEXA's version at the recovery frame ${recovery.frame} (${current?.slice(0, 12)}) is not one that landed inside the stall`,
    );
  const set = new Set(inStall);
  const fetched = fetches.filter(
    (f) =>
      f.source === "http" &&
      (f.stream ?? 1) === 1 &&
      f.hash !== undefined &&
      set.has(f.hash),
  );
  if (fetched.length !== 1)
    problems.push(
      `${fetched.length} in-stall TEXA versions fetched (${fetched.map((f) => f.hash?.slice(0, 12)).join(",")}), expected exactly one`,
    );
  else {
    if (fetched[0].hash !== current)
      problems.push(
        `the fetched in-stall version ${fetched[0].hash?.slice(0, 12)} is not the one current at the recovery frame (${current?.slice(0, 12)})`,
      );
    if (fetched[0].seq !== recovery.seq)
      problems.push(
        `it was fetched for seq ${fetched[0].seq}, not the recovery seq ${recovery.seq}`,
      );
  }
  return { problems, in_stall: inStall, current };
}

/**
 * The reconnect's fetches (pure): with RS_RECEIVER_RECONNECT_MEMORY=keep, connection 2 fetches
 * only payloads held neither in memory nor in the cache directory at the reconnect (live.reconnect
 * records both), never one fetched on connection 1, and hits the cache directory zero times (all
 * it holds is in memory too); its first transaction fetches nothing it already held.
 */
export function evaluateReconnectFetches(a: G6lApplied | undefined): {
  problems: string[];
  detail: string;
} {
  const problems: string[] = [];
  const rc = a?.live?.reconnect;
  if (!rc)
    return { problems: ["applied.json live.reconnect missing"], detail: "" };
  if (rc.memory !== "keep")
    problems.push(`reconnect memory mode ${rc.memory}, expected keep`);
  const held = new Set([
    ...(rc.memory_hashes ?? []),
    ...(rc.cache_hashes ?? []),
  ]);
  const disk = new Set(rc.cache_hashes ?? []);
  const memory = new Set(rc.memory_hashes ?? []);
  for (const h of disk)
    if (!memory.has(h))
      problems.push(
        `${h.slice(0, 12)} is in the cache but not in memory at the reconnect`,
      );
  const http = (a?.fetches ?? []).filter((f) => f.source === "http");
  const f1 = new Set(
    http.filter((f) => (f.stream ?? 1) === 1).map((f) => f.hash),
  );
  const f2 = http.filter((f) => f.stream === 2);
  for (const f of f2) {
    if (f.hash !== undefined && held.has(f.hash))
      problems.push(
        `connection 2 fetched ${f.hash.slice(0, 12)}, held at the reconnect`,
      );
    if (f1.has(f.hash))
      problems.push(`${f.hash?.slice(0, 12)} fetched on both connections`);
  }
  const tx2 = (a?.transactions ?? []).filter((t) => t.stream === 2);
  const cacheHits2 = tx2.reduce(
    (n, t) => n + (t.resources?.cache_hits ?? 0),
    0,
  );
  if (cacheHits2 !== 0)
    problems.push(
      `connection 2 hit the cache directory ${cacheHits2} times: memory did not survive`,
    );
  const first = tx2[0];
  if (!first) problems.push("no transaction on connection 2");
  return {
    problems,
    detail: `memory kept (${memory.size} payloads, ${disk.size} in the cache), connection 2: ${f2.length} fetches, none held at the reconnect or fetched on connection 1, 0 cache hits; its first transaction fetched ${first?.resources?.fetched ?? "?"}`,
  };
}

/**
 * The warm fetches (pure): the warm receiver fetches no payload the cold run cached (its http
 * fetch list is exactly the cold cache, a fresh cache), and none of `staticHashes`.
 */
export function evaluateWarmFetches(
  cold: readonly { hash?: string; source?: string }[],
  warm: readonly { hash?: string; source?: string; kind?: string }[],
  staticHashes: ReadonlySet<string>,
): { problems: string[]; by_kind: Record<string, number> } {
  const problems: string[] = [];
  const cache = new Set(
    cold.filter((f) => f.source === "http").map((f) => f.hash),
  );
  const byKind: Record<string, number> = {};
  for (const f of warm) {
    if (f.source !== "http") continue;
    byKind[f.kind ?? "?"] = (byKind[f.kind ?? "?"] ?? 0) + 1;
    if (cache.has(f.hash))
      problems.push(
        `${f.hash?.slice(0, 12)} fetched although live-scene cached it`,
      );
    if (f.hash !== undefined && staticHashes.has(f.hash))
      problems.push(`static payload ${f.hash.slice(0, 12)} fetched`);
  }
  return { problems: problems.slice(0, 8), by_kind: byKind };
}

/** The regions a post-stall stale target differs in, derived from expected.json's per-step
 * `fresh` table (memory rs-g55f-stale-coalesce-region-set): every region fresh at a step applied
 * during the stall, plus Q7c's per-frame regions; HU compared since G6b. */
export function staleFreshRegions(
  steps: readonly { step: number; fresh: Record<string, boolean> }[],
  during: readonly number[],
): string[] {
  const out = new Set<string>(G6L_STALE_MOTION_REGIONS);
  for (const s of steps)
    if (during.includes(s.step))
      for (const [name, fresh] of Object.entries(s.fresh))
        if (fresh) out.add(name);
  return [...out].sort();
}

function histP50(h: PerfHistogram | undefined): number | null {
  const buckets = h?.buckets ?? [];
  const total = buckets.reduce((n, [, c]) => n + c, 0);
  if (total === 0) return null;
  let seen = 0;
  for (const [lower, c] of buckets) {
    seen += c;
    if (seen * 2 >= total) return lower;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export interface G6lEvaluation {
  ev: G6lLegEvidence;
  leg: G6lLeg;
  checkpoints: G6lCheckpoint[];
  stall: StallReport | null;
  delivery: DeliveryReport[];
  /** the shot-window labels the receiver could not shoot (windowsWithoutCandidate) */
  expected_missed: number[];
  result_class: G2bClass;
  reasons: string[];
  pixel_verdict: "success" | "pixel-mismatch" | "incomplete";
  unsupported_pairs: string[];
  /** what the checks need from the host evidence, kept after it is released (runGate6l) */
  digest?: G6lDigest;
}

function stallOf(ev: G6lLegEvidence): StallReport | null {
  const host = ev.host;
  const a = ev.applied;
  if (!host || !a?.live?.stall) return null;
  const shots: G1dShot[] = (a.shots ?? [])
    .filter((s) => Number.isInteger(s.step) && Number.isInteger(s.seq))
    .map((s) => ({
      stream: s.stream ?? 1,
      seq: s.seq as number,
      step: s.step as number,
    }));
  return stallReport(
    host.connections[0].host,
    a as unknown as Parameters<typeof stallReport>[1],
    host.connections[0].host.steps,
    g6lWindows(),
    shots,
    parseStall(`${a.live.stall.step}:${a.live.stall.ms}`),
  );
}

/**
 * The windows a receiver could not shoot (pure): those in which no applied transaction falls
 * that was not shot for another window (`shots`: "<stream>:<seq>" -> the window it was shot for). The receiver shoots the first applied transaction in each
 * window, trying windows in list order, so these and only these may be missed: windows wholly
 * inside the stall or the reconnect, and a window whose only candidate (the stall's recovery, for
 * one) was taken by a settle window listed before it.
 */
export function windowsWithoutCandidate(
  tx: readonly Pick<AppliedTx, "stream" | "seq" | "frame">[],
  shots: ReadonlyMap<string, number>,
  windows: readonly ShotWindow[] = g6lWindows(),
): number[] {
  return windows
    .filter(
      (w) =>
        !tx.some((t) => {
          const shotFor = shots.get(`${t.stream}:${t.seq}`);
          return (
            t.frame >= w.from &&
            t.frame <= w.to &&
            (shotFor === undefined || shotFor === w.step)
          );
        }),
    )
    .map((w) => w.step);
}

export async function classifyG6lLeg(
  e: Pick<Gate6Expected, "shots">,
  ev: G6lLegEvidence,
  leg: G6lLeg,
  liveDir: string,
  load: FrameLoader = loadFrame,
): Promise<G6lEvaluation> {
  const fired = new Map<G2bClass, string[]>();
  const fire = (cls: G2bClass, reason: string) =>
    fired.set(cls, [...(fired.get(cls) ?? []), `${cls}: ${reason}`]);
  const host = ev.host;
  const a = ev.applied;

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
    for (const c of host.connections)
      if (!c.tap.present)
        fire("capture-failure", `tap/stream-${c.n}.rs2 missing`);
  }
  const pairs = new Set<string>();
  for (const c of host?.connections ?? [])
    for (const t of c.received?.recording?.transactions ?? [])
      for (const u of t.state.unsupported)
        if (u.reason !== "draw-index-tie") pairs.add(`${u.op}/${u.reason}`);
  if (pairs.size > 0) fire("unsupported", [...pairs].sort().join(","));

  const stall = stallOf(ev);
  const expectedMissed = windowsWithoutCandidate(
    appliedTransactions(a),
    new Map(
      (a?.shots ?? []).map((s) => [`${s.stream ?? 1}:${s.seq}`, s.step ?? -1]),
    ),
  );
  if (!a) fire("replay-failure", "applied.json missing or unparseable");
  else {
    if (a.status !== "ok")
      fire(
        "replay-failure",
        `status=${a.status} failure=${JSON.stringify(a.failure ?? null)}`,
      );
    if (a.end_seen !== true) fire("replay-failure", "end_seen is not true");
    const missed = (a.shots_missed ?? []).filter(
      (w) => !expectedMissed.includes(w),
    );
    if (missed.length > 0)
      fire(
        "replay-failure",
        `windows ${missed.join(",")} missed outside the stall and the reconnect`,
      );
  }
  if (host && a)
    for (const c of host.connections) {
      const closedEarly =
        connectionSummary(c.host)?.closed_by === "receiver" &&
        c.n < host.connections.length;
      if (!c.received)
        fire("replay-failure", `connection ${c.n}: no received stream`);
      else if (c.received.sha256 !== c.tap.sha256) {
        const prefix =
          closedEarly && (await isPrefix(c.received.path, c.tap.path));
        if (!prefix)
          fire(
            "replay-failure",
            `connection ${c.n}: received ${c.received.bytes} B is not the tap's ${c.tap.bytes} B${closedEarly ? " or a prefix of it" : ""}`,
          );
      }
    }
  const delivery = (host?.connections ?? []).map((c) => deliveryReport(c.host));
  // `stale-state` (a tap transaction unequal to the full recording at its own frame) is the
  // sabotage's whole point and is judged against `stale_from` by live-resolves-to-recording.
  (host?.connections ?? []).forEach((c, i) => {
    for (const r of deliveryReasons(delivery[i]).filter(
      (x) => !x.includes("stale-state"),
    ))
      fire(
        "delivery-violation",
        `connection ${c.n}: ${r.slice(r.indexOf(":") + 2)}`,
      );
  });

  const checkpoints =
    a?.status === "ok" ? await g6lCheckpoints(e, ev, liveDir, load) : [];
  let mismatching = 0;
  for (const cp of checkpoints)
    if (cp.vs_frame === null || cp.vs_frame > 0) {
      mismatching++;
      fire(
        "pixel-mismatch",
        `stream ${cp.stream} seq ${cp.seq} (frame ${cp.frame}, window ${cp.window}): ${cp.vs_frame ?? "unreadable"} px differ from the reference's frame in ${cp.vs_frame_regions.join(",") || "?"}`,
      );
    }
  const result_class =
    G2B_PRECEDENCE.find((cls) => fired.has(cls)) ?? "success";
  return {
    ev,
    leg,
    checkpoints,
    stall,
    delivery,
    expected_missed: expectedMissed.sort((x, y) => x - y),
    result_class,
    reasons: G2B_PRECEDENCE.flatMap((cls) => fired.get(cls) ?? []),
    pixel_verdict:
      a?.status !== "ok" || checkpoints.length === 0
        ? "incomplete"
        : mismatching > 0
          ? "pixel-mismatch"
          : "success",
    unsupported_pairs: [...pairs].sort(),
  };
}

// ---------------------------------------------------------------------------------------------
// The digest: what the checks need from one leg's host evidence (a 1080-frame scene recording
// decoded six ways is too large to keep for five legs at once)
// ---------------------------------------------------------------------------------------------

export interface G6lDigest {
  host_dir: string;
  connections: {
    n: number;
    tap_bytes: number;
    summary: LiveConnectionSummary | undefined;
    received_stream_id: string | null;
    first_received: { seq: number; encoding: string } | null;
  }[];
  resolves: { problems: string[]; compared: number; stale: number };
  /** per connection, callbacks from each credit to the next send (creditToSend) */
  credit_to_send: {
    n: number;
    delays: Record<string, number>;
    problems: string[];
  }[];
  /** TEXA's [frame, hash] versions from the hook log (null: no TEXA create) */
  texa_versions: [number, string][] | null;
  /** the LA8 atlas pages in force at steps 0..2's settle frames (full recording) */
  early_atlas_pages: string[];
  /** gate 2's live resource checks (honest legs only) */
  resources: {
    pins: PinsReport;
    gets_vs_fetches: string[];
    summary_gets: number | undefined;
    gets: number;
    /** G7g: the hashes the host served (a warm browser leg's warm-fetch) */
    served: string[];
    statuses: string;
    unadvertised: string[];
    fetches_after_applied: string[];
  } | null;
}

export function digestLeg(
  e: Pick<Gate6Expected, "texture_hashes">,
  ev: G6lEvaluation,
  /** G7g: the cold leg's fetches, for a warm browser leg (`http-cache`, coldFetchedHashes). */
  coldFetches?: Parameters<typeof coldFetchedHashes>[1],
): G6lDigest | null {
  const host = ev.ev.host;
  if (!host) return null;
  const honest = ev.leg.expected_pixel === "success";
  const resolves = { problems: [] as string[], compared: 0, stale: 0 };
  const full = host.full.recording?.transactions ?? [];
  const byFrame = new Map(full.map((t) => [t.frame, t]));
  for (const c of host.connections) {
    const sends = wireSends(c.host.log);
    for (const t of c.tap.recording?.transactions ?? []) {
      resolves.compared++;
      const staleFrom = sends.get(t.seq)?.stale_from ?? null;
      if (staleFrom !== null) resolves.stale++;
      if (honest && staleFrom !== null) {
        resolves.problems.push(
          `seq ${t.seq}: stale_from ${staleFrom} on an honest host`,
        );
        break;
      }
      const f = byFrame.get(staleFrom ?? t.frame);
      if (!f || !statesEqual(f.state, t.state)) {
        resolves.problems.push(
          `connection ${c.n} seq ${t.seq} (frame ${t.frame}) is not the full recording's state at frame ${staleFrom ?? t.frame}`,
        );
        break;
      }
    }
  }
  const id = texaId(host.hook.lines, e.texture_hashes.TEXA0);
  const early = new Set<string>();
  for (let k = 0; k <= 2; k++)
    for (const tex of byFrame.get(liveSettleFrame(k))?.state.textures ?? [])
      if (
        tex.kind === "image" &&
        tex.status === "ok" &&
        tex.hash &&
        tex.format?.toUpperCase() === "LA8"
      )
        early.add(tex.hash);
  let resources: G6lDigest["resources"] = null;
  if (honest) {
    const timelines = connTimelinesAtCallback(host);
    const gets = httpGets(host.hook.lines);
    const statuses = new Map<number, number>();
    for (const g of gets)
      statuses.set(
        g.http_status ?? 0,
        (statuses.get(g.http_status ?? 0) ?? 0) + 1,
      );
    resources = {
      pins: pinsReport(
        host.hook.lines,
        full,
        timelines,
        512 * 1024 * 1024,
        hashUnion,
      ),
      // G7l/G7g: a browser receiver fetches through its HTTP cache (`http-cache`); the warm
      // leg's profile already holds what live-scene fetched.
      gets_vs_fetches: getsVsFetches(
        gets,
        ev.ev.applied?.fetches ?? [],
        ev.ev.applied?.cache?.mode,
        coldFetchedHashes(ev.ev.applied?.cache?.mode, coldFetches),
      ),
      summary_gets: host.serving?.http_gets,
      gets: gets.length,
      served: gets
        .map((g) => g.hash)
        .filter((h): h is string => typeof h === "string" && h !== ""),
      statuses: [...statuses].map(([s, n]) => `${n}x${s}`).join(" "),
      unadvertised: unadvertisedGets(gets, timelines, tableUnion),
      fetches_after_applied: fetchesAfterApplied(ev.ev.applied),
    };
  }
  return {
    host_dir: host.dir,
    connections: host.connections.map((c) => {
      const t0 = c.received?.recording?.transactions[0];
      return {
        n: c.n,
        tap_bytes: c.tap.bytes,
        summary: connectionSummary(c.host),
        received_stream_id: c.received?.recording?.stream_id ?? null,
        first_received: t0 ? { seq: t0.seq, encoding: t0.encoding } : null,
      };
    }),
    resolves,
    credit_to_send: host.connections.map((c) => ({
      n: c.n,
      ...creditToSend(c.host.log),
    })),
    texa_versions: id === null ? null : textureVersions(host.hook.lines, id),
    early_atlas_pages: [...early].sort(),
    resources,
  };
}

// ---------------------------------------------------------------------------------------------
// Checks (over evaluations whose digest is set)
// ---------------------------------------------------------------------------------------------

type Evals = Map<string, G6lEvaluation>;

function evidenceOf(
  evals: Evals,
  legs: readonly string[],
  file: string,
): string[] {
  return legs.map((l) => join(evals.get(l)?.ev.receiverDir ?? l, file));
}

function hostDirOf(evals: Evals, leg: string): string {
  return evals.get(leg)?.digest?.host_dir ?? join(leg, "host");
}

export function checkLiveMotion(evals: Evals): Gate6Check {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const l of G6L_LEGS) {
    const ev = evals.get(l.leg);
    if (!ev) {
      problems.push(`${l.leg}: not evaluated`);
      continue;
    }
    const motion = ev.checkpoints.filter((c) => c.window >= G6L_MOTION_LABEL);
    if (motion.length === 0) problems.push(`${l.leg}: no motion-window shot`);
    let ok = 0;
    for (const c of ev.checkpoints) {
      if (c.wire === null)
        problems.push(
          `${l.leg} stream ${c.stream} seq ${c.seq}: not in the host's live log`,
        );
      else if (c.wire_equals_full !== true)
        problems.push(
          `${l.leg} stream ${c.stream} seq ${c.seq}: the tap's state is not the full recording's at frame ${c.wire}`,
        );
      else if (l.expected_pixel === "success" && c.wire !== c.frame)
        problems.push(
          `${l.leg} seq ${c.seq}: an honest host sent frame ${c.wire}'s snapshot at frame ${c.frame}`,
        );
      else if (c.vs_wire !== 0)
        problems.push(
          `${l.leg} stream ${c.stream} seq ${c.seq} (window ${c.window}, frame ${c.frame}, wire ${c.wire}): ${c.vs_wire ?? "unreadable"} px differ from reference frame ${c.wire} in ${c.vs_wire_regions.join(",")}`,
        );
      else ok++;
    }
    notes.push(
      `${l.leg} ${ok}/${ev.checkpoints.length} (${motion.length} motion)`,
    );
  }
  return check(
    "live-motion",
    "every shot of every g6l receiver (12 settle and 40 motion windows, both connections) equals reference-live-frames' shot of the exact host frame its transaction's snapshot came from, whole frame outside HU, budget 0; that frame is the send frame on every honest leg, and the tap's state at the seq equals the host's full recording there",
    problems.slice(0, 10),
    notes.join(", "),
    evidenceOf(
      evals,
      G6L_LEGS.map((l) => l.leg),
      "applied.json",
    ),
  );
}

export function checkMotionMonotonic(evals: Evals): {
  check: Gate6Check;
  reports: Record<string, MotionReport>;
} {
  const problems: string[] = [];
  const notes: string[] = [];
  const reports: Record<string, MotionReport> = {};
  for (const l of G6L_LEGS) {
    const ev = evals.get(l.leg);
    if (!ev?.ev.applied) {
      problems.push(`${l.leg}: not evaluated`);
      continue;
    }
    const shots = new Set(
      (ev.ev.applied.shots ?? []).map((s) => `${s.stream ?? 1}:${s.seq}`),
    );
    const r = evaluateMotionMonotonic(
      appliedTransactions(ev.ev.applied),
      shots,
      ev.ev.applied.live?.stall?.after_seq ?? null,
      G6L_MOTION_FIRST,
      G6L_QUIT_FRAME,
    );
    for (const c of ev.digest?.credit_to_send ?? []) {
      for (const [k, v] of Object.entries(c.delays))
        r.credit_to_send[k] = (r.credit_to_send[k] ?? 0) + v;
      for (const p of c.problems.slice(0, 2))
        problems.push(`${l.leg} connection ${c.n}: ${p}`);
    }
    if (!ev.digest) problems.push(`${l.leg}: no host evidence`);
    reports[l.leg] = r;
    for (const p of r.problems.slice(0, 3)) problems.push(`${l.leg}: ${p}`);
    notes.push(
      `${l.leg} gaps ${Object.entries(r.gaps)
        .map(([g, n]) => `${g}x${n}`)
        .join(" ")}, >2 after ${
        Object.entries(r.attributed)
          .map(([c, n]) => `${c} ${n}`)
          .join(", ") || "none"
      }, max ${r.max_gap}, sends ${Object.entries(r.credit_to_send)
        .map(([k, n]) => `${n} at +${k}`)
        .join(" ")} callbacks after the credit`,
    );
  }
  return {
    check: check(
      "motion-monotonic",
      "on every g6l receiver the applied host frames strictly increase per connection; every host sends each transaction at the first frame callback after its predecessor's credit; from frame 320 to the quit, consecutive applied frames differ by at most 2 at 60/60, except after the stalled seq, across the reconnect, or where the receiver itself held the earlier transaction longer than a frame from receipt to its submitted ack (an HTTP fetch, a shot and its state dump, or a slow frame; As built G6l)",
      problems,
      notes.join("; "),
      evidenceOf(
        evals,
        G6L_LEGS.map((l) => l.leg),
        "applied.json",
      ),
    ),
    reports,
  };
}

export async function checkLiveSteps(
  e: Pick<Gate6Expected, "shots">,
  evals: Evals,
  liveDir: string,
  load: FrameLoader = loadFrame,
): Promise<Gate6Check> {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const leg of G6L_GOOD) {
    const ev = evals.get(leg);
    if (!ev) {
      problems.push(`${leg}: not evaluated`);
      continue;
    }
    let ok = 0;
    for (let k = 0; k <= G6L_LAST_STEP; k++) {
      if (ev.expected_missed.includes(k)) continue;
      const cp = ev.checkpoints.find((c) => c.window === k);
      if (!cp || cp.frame === null) {
        problems.push(`${leg}: no settle shot for step ${k}`);
        continue;
      }
      if (liveStepAt(cp.frame) !== k || cp.frame < liveSettleFrame(k)) {
        problems.push(
          `${leg} step ${k}: shot at frame ${cp.frame}, outside its settle window`,
        );
        continue;
      }
      const ref = await load(
        join(liveDir, "reference-file", "shots", `step-${k}.png`),
      );
      const got = await load(cp.shot);
      const regions = e.shots.find((s) => s.id === `step-${k}`)?.regions ?? {};
      if (!ref || !got) {
        problems.push(`${leg} step ${k}: unreadable shot`);
        continue;
      }
      const keep = new Set(G6L_STEP_ONLY_REGIONS);
      const exclude = new Set(
        [...Object.keys(regions), "BG"].filter((r) => !keep.has(r)),
      );
      const d = diffFrames6(ref, got, regions, exclude);
      if (d.mismatched > 0)
        problems.push(
          `${leg} step ${k} (frame ${cp.frame}): ${d.mismatched} px of ${Object.keys(d.regions).join(",")} differ from the file reference's step shot`,
        );
      else ok++;
    }
    notes.push(`${leg} ${ok} steps`);
  }
  return check(
    "live-steps",
    `on every honest g6l leg each step 0..11 (but those wholly inside the stall or the reconnect) has a settle-window shot, and in the regions continuous animation never touches (${G6L_STEP_ONLY_REGIONS.join(", ")}) it equals the animate reference's step shot on the file timeline (live-motion compares the whole frame with the live reference)`,
    problems.slice(0, 10),
    notes.join(", "),
    [join(liveDir, "reference-file", "shots")],
  );
}

export function checkPendingBounded(evals: Evals): Gate6Check {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const l of G6L_LEGS) {
    const ev = evals.get(l.leg);
    const dg = ev?.digest;
    if (!ev || !dg) {
      problems.push(`${l.leg}: not evaluated`);
      continue;
    }
    dg.connections.forEach((c, i) => {
      const d = ev.delivery[i];
      const s = c.summary;
      for (const v of [
        ...d.in_flight_violations,
        ...d.sent_without_credit,
        ...d.queued_violations,
      ].slice(0, 2))
        problems.push(`${l.leg} connection ${c.n}: ${v}`);
      if (d.max_in_flight > 1 || (s?.max_in_flight ?? 0) > 1)
        problems.push(
          `${l.leg} connection ${c.n}: max in flight ${d.max_in_flight} (host ${s?.max_in_flight})`,
        );
      if ((s?.max_pending ?? 0) > 1)
        problems.push(
          `${l.leg} connection ${c.n}: max pending ${s?.max_pending}`,
        );
    });
    if (l.stall) {
      const st = ev.stall;
      if (!st || st.send_frame === null || st.credit_frame === null)
        problems.push(`${l.leg}: the stall is not visible in the host log`);
      else if (st.sends_during > 0)
        problems.push(
          `${l.leg}: ${st.sends_during} transactions sent during the stall`,
        );
      if (st && st.max_pending > 1)
        problems.push(`${l.leg}: max pending ${st.max_pending}`);
    }
    const d0 = ev.delivery[0];
    notes.push(
      `${l.leg} in flight ${d0?.max_in_flight}, queued max ${d0?.max_queued_bytes} B <= ${d0?.queued_limit}${l.stall ? `, during the stall ${ev.stall?.max_queued_bytes_during} B and ${ev.stall?.sends_during} sends` : ""}`,
    );
  }
  return check(
    "pending-bounded",
    "on every g6l host connection at most one transaction in flight (recomputed from the log's own acks and as the host reports it), at most one pending target, queued bytes never above the largest credit window (one transaction and the resources it needs) + 4096 B of control frames; on the stall legs nothing is sent between the stalled seq and its credit",
    problems.slice(0, 10),
    notes.join("; "),
    G6L_LEGS.map((l) => join(hostDirOf(evals, l.leg), "tap", "live-1.jsonl")),
  );
}

export function checkStallLatest(evals: Evals): Gate6Check {
  const problems: string[] = [];
  let detail = "";
  const ev = evals.get("live-stall");
  const st = ev?.stall;
  const r = st?.recovery;
  if (!ev || !st || !r) problems.push("live-stall: no stall recovery evidence");
  else {
    if (r.stale_from !== null)
      problems.push(
        `the recovery seq ${r.seq} carries stale_from ${r.stale_from}`,
      );
    if (r.state_equals_full !== true)
      problems.push(
        `the recovery seq ${r.seq} (frame ${r.frame}) is not the host's state at its frame`,
      );
    const after = appliedTransactions(ev.ev.applied).find(
      (t) => t.stream === 1 && t.seq > (st.stalled_seq ?? 0),
    );
    if (after?.seq !== r.seq)
      problems.push(
        `the first transaction applied after the stall is seq ${after?.seq}, not the recovery seq ${r.seq}`,
      );
    const cp = ev.checkpoints.find((c) => c.stream === 1 && c.seq === r.seq);
    if (!cp) problems.push(`the recovery seq ${r.seq} was not shot`);
    else if (cp.vs_frame !== 0)
      problems.push(
        `the recovery shot differs from the reference at frame ${cp.frame} in ${cp.vs_frame_regions.join(",")}`,
      );
    detail = `stall after seq ${st.stalled_seq} (frame ${st.send_frame}, measured ${st.measured_ms?.toFixed(1)} ms), credit at frame ${st.credit_frame} (${st.frames_during_stall} frames), recovery seq ${r.seq} at frame ${r.frame} (${r.frames_after_credit} after the credit, ${r.encoding}), steps applied during ${st.steps_applied_during.join(",")}; equals the host's full recording there and its shot equals the reference`;
  }
  return check(
    "stall-latest",
    "live-stall: the first transaction applied after the 2-s stall is the host's recovery send, its resolved state equals the host's full recording (the mirror) at its own frame, from the tap (no stale target), and its shot equals the reference at that frame",
    problems,
    detail,
    [join(ev?.ev.receiverDir ?? "live-stall", "applied.json")],
  );
}

export function checkFetchLatestOnly(evals: Evals): Gate6Check {
  const problems: string[] = [];
  let detail = "";
  const ev = evals.get("live-stall");
  const st = ev?.stall;
  const versions = ev?.digest?.texa_versions;
  if (
    !ev ||
    !st?.recovery ||
    st.send_frame === null ||
    st.credit_frame === null
  )
    problems.push("live-stall: no stall recovery evidence");
  else if (!versions) problems.push("no TEXA create in the hook log");
  else {
    const r = evaluateFetchLatestOnly(
      versions,
      ev.ev.applied?.fetches ?? [],
      st.send_frame,
      st.credit_frame,
      {
        seq: st.recovery.seq,
        frame: st.recovery.frame,
      },
    );
    problems.push(...r.problems);
    detail = `${r.in_stall.length} TEXA versions landed in frames ${st.send_frame + 1}..${st.credit_frame}; only ${r.current?.slice(0, 12)} (current at the recovery frame ${st.recovery.frame}) was fetched, for seq ${st.recovery.seq}`;
  }
  return check(
    "fetch-latest-only",
    "live-stall: of TEXA's versions that landed inside the stall (hook log), exactly one is fetched, for the recovery transaction: the one current at its frame (read from the hook log, never a hard-coded frame)",
    problems,
    detail,
    [join(hostDirOf(evals, "live-stall"), "evidence", "resources.jsonl")],
  );
}

export function checkStallRecovery(evals: Evals): Gate6Check {
  const problems: string[] = [];
  let detail = "";
  const ev = evals.get("live-stall");
  const r = ev?.stall?.recovery;
  if (!ev || !r) problems.push("live-stall: no stall recovery evidence");
  else {
    const after = ev.checkpoints.filter(
      (c) => c.frame !== null && c.frame >= r.frame,
    );
    if (after.length === 0) problems.push("no shot after the stall");
    for (const c of after)
      if (c.vs_frame !== 0)
        problems.push(
          `seq ${c.seq} (frame ${c.frame}): ${c.vs_frame} px differ in ${c.vs_frame_regions.join(",")}`,
        );
    detail = `${after.length} shots from frame ${r.frame} on equal the reference at their frames; missed windows ${ev.ev.applied?.shots_missed?.join(",") ?? ""} (expected ${ev.expected_missed.join(",")})`;
  }
  return check(
    "stall-recovery",
    "live-stall: every shot from the recovery transaction on equals the reference at its frame (whole frame outside HU), and only windows wholly inside the stall are missed",
    problems.slice(0, 8),
    detail,
    [join(ev?.ev.receiverDir ?? "live-stall", "applied.json")],
  );
}

export function checkReconnect(evals: Evals): Gate6Check {
  const problems: string[] = [];
  let detail = "";
  const ev = evals.get("live-reconnect");
  const dg = ev?.digest;
  const a = ev?.ev.applied;
  const rc = a?.live?.reconnect;
  if (!ev || !dg || !a || !rc) problems.push("live-reconnect: not evaluated");
  else if (dg.connections.length !== 2)
    problems.push(`${dg.connections.length} host connections, expected 2`);
  else {
    const [c1, c2] = dg.connections;
    const s1 = c1.received_stream_id;
    const s2 = c2.received_stream_id;
    if (!s2 || s2 === s1)
      problems.push(
        `connection 2's stream_id ${s2} is not new (connection 1: ${s1})`,
      );
    if (c2.summary?.stream_id !== s2)
      problems.push(
        `the host names connection 2's stream ${c2.summary?.stream_id}, the receiver ${s2}`,
      );
    if (c1.summary?.closed_by !== "receiver" || c1.summary?.close_code !== 1000)
      problems.push(
        `connection 1 closed by ${c1.summary?.closed_by} with ${c1.summary?.close_code}`,
      );
    const t1 = c2.first_received;
    if (t1?.seq !== 1 || t1.encoding !== "full")
      problems.push(
        `connection 2 starts with seq ${t1?.seq} ${t1?.encoding}, not seq 1 full`,
      );
    if (rc.step !== G6L_RECONNECT_STEP)
      problems.push(`reconnected after step ${rc.step}`);
    if (rc.leftover_rids !== 0)
      problems.push(`${rc.leftover_rids} RIDs left after dispose`);
    if (
      (rc.freed_rids ?? -1) !==
        (rc.created_rids ?? 0) - (rc.freed_by_apply ?? 0) ||
      (rc.freed_rids ?? 0) <= 0
    )
      problems.push(
        `dispose freed ${rc.freed_rids}, created ${rc.created_rids} - freed while applying ${rc.freed_by_apply}`,
      );
    const f = evaluateReconnectFetches(a);
    problems.push(...f.problems.slice(0, 4));
    const after = ev.checkpoints.filter((c) => c.stream === 2);
    if (after.length === 0) problems.push("no shot on connection 2");
    for (const c of after)
      if (c.vs_frame !== 0)
        problems.push(
          `connection 2 seq ${c.seq} (frame ${c.frame}): ${c.vs_frame} px differ`,
        );
    const first = (a.transactions ?? []).find(
      (t) => t.stream === 2 && typeof t.applied_us === "number",
    );
    const ms =
      first && typeof rc.closed_us === "number"
        ? (((first.applied_us as number) - rc.closed_us) / 1000).toFixed(1)
        : "?";
    detail = `connection 1 closed (receiver, 1000) after seq ${rc.after_seq} (frame ${rc.after_frame}); connection 2 stream ${s2?.slice(0, 8)}, seq 1 full at frame ${first?.frame}, applied ${ms} ms after the dispose; dispose freed ${rc.freed_rids} RIDs, 0 left; ${f.detail}; ${after.length} shots on connection 2 equal the reference`;
  }
  return check(
    "reconnect",
    "live-reconnect: the receiver closes after its step-5 shot (1000), disposes every RID it owns (none left) and reconnects; connection 2 carries a new stream_id, seq 1 full; the memory cache survives (RS_RECEIVER_RECONNECT_MEMORY=keep), so connection 2 fetches only payloads held neither in memory nor on disk at that moment (none fetched on connection 1, zero cache-directory hits), and every shot on connection 2 equals the reference at its frame",
    problems.slice(0, 10),
    detail,
    [join(ev?.ev.receiverDir ?? "live-reconnect", "applied.json")],
  );
}

export function checkWarmFetch(
  e: Pick<Gate6Expected, "texture_hashes">,
  evals: Evals,
): Gate6Check {
  const problems: string[] = [];
  let detail = "";
  const warm = evals.get("live-scene-warm");
  const cold = evals.get("live-scene");
  const wa = warm?.ev.applied;
  if (!warm || !cold || !wa || !cold.ev.applied)
    problems.push("live-scene-warm or live-scene not evaluated");
  else if (wa.cache?.mode === "http-cache") {
    // G7g (G7l's rule for g2c/g5f/g55f): a browser receiver's cache is the cold leg's profile's
    // HTTP cache (gate7-design.md Q4), which it fetches through. So the warm receiver fetches what
    // its wire names, and the host must serve exactly the ones live-scene never fetched: none it
    // cached, and none of the static payloads.
    const statics = new Set([
      e.texture_hashes.TEXN,
      e.texture_hashes.TEXB,
      e.texture_hashes.TEXA0,
      ...(warm.digest?.early_atlas_pages ?? []),
    ]);
    const cache = coldFetchedHashes(wa.cache.mode, cold.ev.applied.fetches);
    const served = new Set(warm.digest?.resources?.served ?? []);
    if (!warm.digest?.resources) problems.push("live-scene-warm: no host GETs");
    const fetched = (wa.fetches ?? []).filter((f) => f.source === "http");
    for (const h of served) {
      if (cache.has(h))
        problems.push(
          `the host served ${h.slice(0, 12)}, which live-scene's browser profile already cached`,
        );
      if (statics.has(h))
        problems.push(`the host served static payload ${h.slice(0, 12)}`);
    }
    for (const f of fetched)
      if (f.hash && !cache.has(f.hash) && !served.has(f.hash))
        problems.push(
          `the warm receiver fetched ${f.hash.slice(0, 12)}, which live-scene never fetched, yet the host served no GET for it`,
        );
    detail = `browser HTTP cache: ${fetched.length} payloads fetched, ${served.size} reached the host, none live-scene cached and none of the ${statics.size} static payloads`;
  } else {
    if (wa.cache?.mode !== "warm")
      problems.push(`cache mode ${wa.cache?.mode}, expected warm`);
    const statics = new Set([
      e.texture_hashes.TEXN,
      e.texture_hashes.TEXB,
      e.texture_hashes.TEXA0,
      ...(warm.digest?.early_atlas_pages ?? []),
    ]);
    const r = evaluateWarmFetches(
      cold.ev.applied.fetches ?? [],
      wa.fetches ?? [],
      statics,
    );
    problems.push(...r.problems);
    const coldHttp = (cold.ev.applied.fetches ?? []).filter(
      (f) => f.source === "http",
    ).length;
    detail = `live-scene cached ${coldHttp} payloads; the warm receiver hit its cache ${wa.resources_summary?.cache_hits} times and fetched ${
      Object.entries(r.by_kind)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ") || "nothing"
    }, none of them cached and none of the ${statics.size} static payloads (TEXN, TEXB, TEXA(0), the steps 0-2 atlas pages)`;
  }
  return check(
    "warm-fetch",
    "live-scene-warm (a new host and receiver on live-scene's cache, mode warm): no payload live-scene cached is fetched again, the static payloads (TEXN, TEXB, TEXA(0), the atlas pages of steps 0 to 2) are fetched zero times, and every fetch is of a payload absent from the cold cache (Q7c); G7g, a browser receiver: its cache is the cold leg's profile's HTTP cache, so the host serves only payloads live-scene never fetched, and no static payload",
    problems,
    detail,
    [join(warm?.ev.receiverDir ?? "live-scene-warm", "applied.json")],
  );
}

export function checkLiveTapEqualsReceived(evals: Evals): Gate6Check {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const l of G6L_LEGS) {
    const ev = evals.get(l.leg);
    if (!ev?.digest) {
      problems.push(`${l.leg}: not evaluated`);
      continue;
    }
    for (const r of ev.reasons.filter((x) =>
      x.startsWith("replay-failure: connection"),
    ))
      problems.push(`${l.leg}: ${r}`);
    notes.push(
      `${l.leg} ${ev.digest.connections.map((c) => `${c.tap_bytes} B`).join("+")}`,
    );
  }
  return check(
    "live-tap-equals-received",
    "on every g6l leg each connection's received stream is byte for byte the host's tap (connection 1 of the reconnect: a prefix of it, the receiver closed it)",
    problems,
    notes.join(", "),
    evidenceOf(
      evals,
      G6L_LEGS.map((l) => l.leg),
      "received.rs2",
    ),
  );
}

export function checkLiveResolvesToRecording(evals: Evals): Gate6Check {
  const problems: string[] = [];
  let compared = 0;
  let stale = 0;
  for (const l of G6L_LEGS) {
    const dg = evals.get(l.leg)?.digest;
    if (!dg) {
      problems.push(`${l.leg}: not evaluated`);
      continue;
    }
    compared += dg.resolves.compared;
    stale += dg.resolves.stale;
    for (const p of dg.resolves.problems) problems.push(`${l.leg}: ${p}`);
  }
  return check(
    "live-resolves-to-recording",
    "every transaction every g6l host sent resolves to its full file recording's state at its frame (the sabotage's rewritten sends: at their stale_from frame, an exact copy)",
    problems.slice(0, 8),
    `${compared} live transactions equal the host recordings (${stale} stale-coalesce copies)`,
    G6L_LEGS.map((l) => join(hostDirOf(evals, l.leg), "tap")),
  );
}

export function checkLiveResources(evals: Evals): Gate6Check[] {
  const pb: string[] = [];
  const pbNotes: string[] = [];
  const or: string[] = [];
  const orNotes: string[] = [];
  const gf: string[] = [];
  const gfNotes: string[] = [];
  const ga: string[] = [];
  const fa: string[] = [];
  let gets = 0;
  let fetches = 0;
  for (const leg of G6L_GOOD) {
    const ev = evals.get(leg);
    const r = ev?.digest?.resources;
    if (!ev || !r) {
      pb.push(`${leg}: not evaluated`);
      continue;
    }
    const p = r.pins;
    if (p.frames_compared === 0) pb.push(`${leg}: no pin or retire lines`);
    for (const m of [...p.missing, ...p.late, ...p.over_budget].slice(0, 3))
      pb.push(`${leg}: ${m}`);
    pbNotes.push(
      `${leg} ${p.frames_compared} frames, retained max ${p.retained_max} (${p.retained_bytes_max} B)`,
    );
    for (const m of [...p.late, ...p.early].slice(0, 3))
      or.push(`${leg}: ${m}`);
    orNotes.push(`${leg} ${p.retirements} retired of ${p.pins} pinned`);
    gets += r.gets;
    for (const x of r.gets_vs_fetches.slice(0, 3)) gf.push(`${leg}: ${x}`);
    if (r.summary_gets !== r.gets)
      gf.push(
        `${leg}: live-summary http_gets ${r.summary_gets}, ${r.gets} GET lines`,
      );
    gfNotes.push(`${leg} ${r.gets} (${r.statuses})`);
    for (const x of r.unadvertised.slice(0, 3)) ga.push(`${leg}: ${x}`);
    fetches += (ev.ev.applied?.fetches ?? []).length;
    for (const x of r.fetches_after_applied.slice(0, 3))
      fa.push(`${leg}: ${x}`);
  }
  const hookEvidence = G6L_GOOD.map((l) =>
    join(hostDirOf(evals, l), "evidence", "resources.jsonl"),
  );
  return [
    check(
      "pins-bounded",
      "on every honest g6l host, after every frame callback the servable hashes (replayed from the pin and retire lines) equal the full recording's ok texture, mesh-surface and shader hashes at that frame united with every open connection's base (pinned before the send; a close logged after a frame's line counts from the next frame), bytes never over the budget",
      pb,
      pbNotes.join("; "),
      hookEvidence,
    ),
    check(
      "obsolete-retired",
      "on every honest g6l host a hash is retired at the first frame callback after which neither the current state nor a connection's base names it, and never while one still does (TEXA's versions every 30 frames, MS's surface every frame, TEXA freed at step 9)",
      or,
      orNotes.join("; "),
      hookEvidence,
    ),
    check(
      "http-gets-match-fetches",
      "on every honest g6l leg the host's GET log equals the receiver's http fetch list hash for hash and byte for byte, in order; every hash fetched at most once per process (across the reconnect too); every fetch a verified HTTP 200 with Content-Type application/octet-stream, the immutable Cache-Control, ETag and Content-Length (no 304 or 404 arises on these legs, and no bearer token is set)",
      gf,
      `GETs per leg: ${gfNotes.join(", ")}`,
      hookEvidence,
    ),
    check(
      "gets-advertised",
      "on every honest g6l host every GET names a texture, mesh-surface or shader hash a transaction already sent on its connection names, at an earlier frame callback",
      ga,
      `${gets} GETs, each advertised first`,
      hookEvidence,
    ),
    check(
      "fetch-before-applied",
      "on every honest g6l leg every http fetch for seq n ended (receiver clock) before n's applied ack",
      fa,
      `${fetches} fetches, each before its applied ack`,
      evidenceOf(evals, G6L_GOOD, "applied.json"),
    ),
  ];
}

/** The class a g6l leg must reach on render-stream/6: `success` (honest) or `pixel-mismatch`
 * (the sabotage); nothing is typed since G6b (on /5 every leg was `unsupported` with extra-canvas). */
export function g6lExpectedClass(leg: Pick<G6lLeg, "expected_pixel">): string {
  return leg.expected_pixel === "pixel-mismatch" ? "pixel-mismatch" : "success";
}

/** leg-class-<leg>: on /6 every g6l leg classifies `success` (honest) or `pixel-mismatch` (the
 * sabotage, with the stale-target proof below) with no unsupported entry, nothing else firing;
 * its pixel verdict covers the whole frame, HU included. */
export function checkLegClass(
  e: Pick<Gate6Expected, "steps">,
  ev: G6lEvaluation,
): Gate6Check {
  const problems: string[] = [];
  const wanted = g6lExpectedClass(ev.leg);
  if (ev.result_class !== wanted)
    problems.push(
      `class ${ev.result_class}, expected ${wanted}: ${ev.reasons.slice(0, 2).join(" | ")}`,
    );
  const other = ev.reasons.filter((r) => !r.startsWith("pixel-mismatch:"));
  if (other.length > 0)
    problems.push(`other classes fired: ${other.slice(0, 2).join(" | ")}`);
  if (
    JSON.stringify(ev.unsupported_pairs) !==
    JSON.stringify([...G6L_WIRE_UNSUPPORTED])
  )
    problems.push(
      `unsupported ${JSON.stringify(ev.unsupported_pairs)} != ${JSON.stringify(G6L_WIRE_UNSUPPORTED)}`,
    );
  if (ev.pixel_verdict !== ev.leg.expected_pixel)
    problems.push(
      `pixels ${ev.pixel_verdict}, expected ${ev.leg.expected_pixel}${
        ev.pixel_verdict === "pixel-mismatch"
          ? `: ${ev.reasons
              .filter((r) => r.startsWith("pixel-mismatch"))
              .slice(0, 2)
              .join(" | ")}`
          : ""
      }`,
    );
  let detail = `${ev.result_class} (${ev.unsupported_pairs.join(", ") || "nothing typed"}), pixels ${ev.pixel_verdict}`;
  if (ev.leg.expected_pixel === "pixel-mismatch") {
    const r = ev.stall?.recovery;
    if (!r) problems.push("no stall recovery evidence");
    else {
      if (r.stale_from === null)
        problems.push(
          `the recovery seq ${r.seq} is not labelled stale_from: the sabotage did not trigger`,
        );
      if (r.state_equals_full !== false)
        problems.push(
          `the recovery seq ${r.seq} equals the host's state at its frame: the stale target had no effect`,
        );
      const cp = ev.checkpoints.find((c) => c.stream === 1 && c.seq === r.seq);
      if (!cp) problems.push(`no shot of the recovery seq ${r.seq}`);
      else {
        const want = staleFreshRegions(
          e.steps,
          ev.stall?.steps_applied_during ?? [],
        );
        const got = cp.vs_frame_regions;
        if (cp.vs_wire !== 0)
          problems.push(
            `the recovery shot differs from the reference at its snapshot frame ${cp.wire} in ${cp.vs_wire_regions.join(",")}`,
          );
        const missing = want.filter((x) => !got.includes(x));
        if (missing.length > 0)
          problems.push(
            `the recovery shot (frame ${cp.frame}) differs in ${got.join(",") || "nothing"}, not in ${missing.join(",")} (Q7c's MS, SM, AN and the regions the fresh table says the swallowed steps ${ev.stall?.steps_applied_during.join(",")} touch)`,
          );
        detail += `; recovery seq ${r.seq} at frame ${r.frame} carries frame ${r.stale_from}'s snapshot: its shot equals the reference at ${cp.wire} and differs from frame ${cp.frame} in ${got.join(",")} (fresh-table set ${want.join(",")} included)`;
      }
      // Every pixel mismatch of the leg must be a stale copy the wire itself names.
      for (const c of ev.checkpoints)
        if ((c.vs_frame ?? 1) > 0 && c.wire === c.frame)
          problems.push(
            `seq ${c.seq} (frame ${c.frame}) differs although its send carries its own frame`,
          );
    }
  }
  return check(
    `leg-class-${ev.leg.leg}`,
    `${ev.leg.leg} classifies ${g6lExpectedClass(ev.leg)} on render-stream/6 with no unsupported entry (the HUD layer is carried since G6b) and its pixels, HU included, are ${
      ev.leg.expected_pixel === "success"
        ? "success"
        : "pixel-mismatch exactly where stale-coalesce sent an older snapshot: the first post-stall shot equals the reference at stale_from and differs from its own frame in MS, SM, AN and every region the fresh table says the swallowed steps touch"
    }`,
    problems.slice(0, 8),
    detail,
    [
      join(ev.ev.receiverDir, "applied.json"),
      join(ev.ev.receiverDir, "stdout.log"),
    ],
  );
}

export function checkLiveStepLog(
  hosts: { leg: string; steps: StepLine[] | undefined }[],
): Gate6Check {
  const want = Array.from({ length: G6L_LAST_STEP + 1 }, (_, k) => ({
    step: k,
    applied_frame: liveAppliedFrame(k),
    settle_frame: liveSettleFrame(k),
  }));
  const problems = hosts
    .filter((h) => JSON.stringify(h.steps) !== JSON.stringify(want))
    .map(
      (h) => `${h.leg} steps.jsonl ${JSON.stringify(h.steps)?.slice(0, 100)}`,
    );
  return check(
    "live-step-log",
    "every g6l host and reference-live-frames log steps 0..11 at the live timeline's frames (step 0 at 1, step k at 300 + 60k, settled 7 frames later)",
    problems,
    `${hosts.length} step logs on the live timeline`,
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// The g6l group
// ---------------------------------------------------------------------------------------------

export interface G6lLegEntry {
  group: "g6l";
  expected_class: string;
  result_class: string | null;
  pixel_verdict?: string;
  expected_pixel_verdict?: string;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface G6lTiming {
  credit_rtt_us: { median: number | null; p95: number | null } | null;
  staleness_p50_us: { applied: number | null; submitted: number | null };
  fetch_us: {
    count: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  applied: number;
  shots: number;
  stall?: {
    send_frame: number | null;
    credit_frame: number | null;
    measured_ms: number | null;
    frames: number | null;
    recovery_frame: number | null;
    credit_to_send_us: number | null;
    credit_to_submitted_ack_us: number | null;
    coalesced_delta: number | null;
    stale_from: number | null;
  };
  reconnect?: {
    after_frame: number | null;
    first_frame_2: number | null;
    dispose_to_applied_ms: number | null;
  };
}

export interface Gate6lResult {
  checks: Gate6Check[];
  legs: Record<string, G6lLegEntry>;
  mismatch_tables: Record<string, Record<string, string[]>>;
  timing: Record<string, G6lTiming>;
  motion: Record<string, MotionReport>;
}

function timingOf(ev: G6lEvaluation): G6lTiming {
  const a = ev.ev.applied;
  const c1 = ev.digest?.connections[0]?.summary;
  const http = (a?.fetches ?? []).filter(
    (f) =>
      f.source === "http" && f.end_us !== undefined && f.start_us !== undefined,
  );
  const durations = http.map(
    (f) => (f.end_us as number) - (f.start_us as number),
  );
  const out: G6lTiming = {
    credit_rtt_us: c1?.credit_rtt_us
      ? {
          median: c1.credit_rtt_us.median ?? null,
          p95: c1.credit_rtt_us.p95 ?? null,
        }
      : null,
    staleness_p50_us: {
      applied: histP50(ev.ev.perf?.histograms?.staleness_us?.applied),
      submitted: histP50(ev.ev.perf?.histograms?.staleness_us?.submitted),
    },
    fetch_us: {
      count: durations.length,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.length > 0 ? Math.max(...durations) : null,
    },
    applied: appliedTransactions(a).length,
    shots: (a?.shots ?? []).length,
  };
  if (ev.stall)
    out.stall = {
      send_frame: ev.stall.send_frame,
      credit_frame: ev.stall.credit_frame,
      measured_ms: ev.stall.measured_ms,
      frames: ev.stall.frames_during_stall,
      recovery_frame: ev.stall.recovery?.frame ?? null,
      credit_to_send_us: ev.stall.recovery?.credit_to_send_us ?? null,
      credit_to_submitted_ack_us:
        ev.stall.recovery?.credit_to_submitted_ack_us ?? null,
      coalesced_delta: ev.stall.coalesced_delta,
      stale_from: ev.stall.recovery?.stale_from ?? null,
    };
  const rc = a?.live?.reconnect;
  if (rc) {
    const first = (a?.transactions ?? []).find(
      (t) => t.stream === 2 && typeof t.applied_us === "number",
    );
    out.reconnect = {
      after_frame: rc.after_frame ?? null,
      first_frame_2: first?.frame ?? null,
      dispose_to_applied_ms:
        first && typeof rc.closed_us === "number"
          ? ((first.applied_us as number) - rc.closed_us) / 1000
          : null,
    };
  }
  return out;
}

export async function runGate6l(
  out: string,
  e: Gate6Expected,
): Promise<Gate6lResult> {
  const liveDir = join(out, G6L_DIR);
  const evals: Evals = new Map();
  const steps: { leg: string; steps: StepLine[] | undefined }[] = [];
  for (const l of G6L_LEGS) {
    const loaded = await loadG6lLeg(liveDir, l.leg);
    const ev = await classifyG6lLeg(e, loaded, l, liveDir);
    steps.push({ leg: l.leg, steps: loaded.host?.connections[0]?.host.steps });
    ev.digest =
      digestLeg(
        e,
        ev,
        l.leg === "live-scene-warm"
          ? evals.get("live-scene")?.ev.applied?.fetches
          : undefined,
      ) ?? undefined;
    // Release the decoded recordings, taps and hook log: five legs of them do not fit the heap.
    loaded.host = null;
    evals.set(l.leg, ev);
  }
  steps.push({
    leg: "reference-live-frames",
    steps: parseStepLog(
      await readTextOrUndefined(
        join(liveDir, "reference-live-frames", "steps.jsonl"),
      ),
    ),
  });
  const motion = checkMotionMonotonic(evals);
  const checks: Gate6Check[] = [
    checkLiveStepLog(steps),
    checkLiveTapEqualsReceived(evals),
    checkLiveResolvesToRecording(evals),
    checkLiveMotion(evals),
    motion.check,
    await checkLiveSteps(e, evals, liveDir),
    checkPendingBounded(evals),
    checkStallLatest(evals),
    checkFetchLatestOnly(evals),
    checkStallRecovery(evals),
    checkReconnect(evals),
    checkWarmFetch(e, evals),
    ...checkLiveResources(evals),
  ];
  const legs: Record<string, G6lLegEntry> = {};
  const mismatch_tables: Record<string, Record<string, string[]>> = {};
  const timing: Record<string, G6lTiming> = {};
  for (const l of G6L_LEGS) {
    const ev = evals.get(l.leg) as G6lEvaluation;
    checks.push(checkLegClass(e, ev));
    legs[l.leg] = {
      group: "g6l",
      expected_class: g6lExpectedClass(l),
      result_class: ev.result_class,
      pixel_verdict: ev.pixel_verdict,
      expected_pixel_verdict: l.expected_pixel,
      reasons: ev.reasons.slice(0, 20),
      exit_code: ev.ev.exit,
      artifacts: [
        join(ev.ev.receiverDir, "applied.json"),
        join(ev.ev.receiverDir, "stdout.log"),
      ],
    };
    const table: Record<string, string[]> = {};
    for (const c of ev.checkpoints)
      if (c.vs_frame !== 0)
        table[
          `${c.stream}:${c.seq}@${c.frame}${c.wire !== c.frame ? `<-${c.wire}` : ""}`
        ] = c.vs_frame_regions;
    mismatch_tables[l.leg] = table;
    timing[l.leg] = timingOf(ev);
  }
  return { checks, legs, mismatch_tables, timing, motion: motion.reports };
}
