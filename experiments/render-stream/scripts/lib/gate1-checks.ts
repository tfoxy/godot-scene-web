// Gate 1 checks and leg classification (protocol/gate1-design.md "Q7", "G1a" and "G1b2"; the
// live legs of "G1c2" are in gate1-live-checks.ts, those of "G1d" in gate1-g1d-checks.ts, both
// joined in by runGate1).
//
// Everything here reads an evidence directory written by run-gate1.sh, or is pure over values
// already read from one, so scripts/test/self-test-gate1.ts can drive it with fabricated trees.
// Nothing launches a process. Classification never reads `session.sabotage`.
//
// Since G1b2 every capture publishes to two file sinks, the full and the patch encoding, and the
// host's root geometry is read from the session (evidence/root.json is still written, and only
// quoted in the report). Since G2b2 both sinks are render-stream/2, `recording.rs2` and
// `recording-patch.rs2`, with the capture's out-of-band resource store in `store/`; every resolved
// state compared here (patch against full, receiver dumps, live taps) includes the root
// viewport's default texture filter/repeat and the texture table, which in a gate 1 fixture holds
// only the engine's own unreferenced hue strip.
//
// Evidence layout under <out>/ (see scripts/README.md "Gate 1"):
//   legs.json                     {"groups_run":[...],"groups_landed":[...]}
//   capture/                      400-frame capture host, GRC_ROOT_SIZE=enforce-min-size:
//                                 evidence/, recording.rs2, recording-patch.rs2, store/,
//                                 steps.jsonl, root.jsonl, strace.txt, maps.txt, fd.txt
//   reference/                    rendered fixture, extension absent: shots/step-<k>.png and
//                                 shots/frame-<tie frame>.png, steps.jsonl, root.jsonl
//   receiver/                     rendered receiver on capture/recording.rs2: shots/seq-<n>.png,
//                                 state/seq-<n>.json, diff/step-<k>.png, applied.json
//   receiver-headless-trace/      headless receiver under strace
//   sabotage-omit-{modulate,transform,order,visibility}/{capture,receiver}/
//   root-size-observe/{capture,receiver}/   GRC_ROOT_SIZE unset (capture writes root.jsonl too)
//   import/{fixture,receiver}/, receiver-typecheck/{selftest,minimal}/
//   (g1b) receiver-patch/         rendered receiver on capture/recording-patch.rs2, as receiver/
//   (g1b) sabotage-omit-{free,visible}/{capture,receiver}/, sabotage-patch-drop/{capture,receiver}/
//   (g1b) tie-overlap/{capture,receiver,reference}/   RS_FIXTURE_TIE=overlap
//   (g1c) live/{host,receiver}/, live-replay/, live-headless/{host,receiver}/,
//         sabotage-drop-message/{host,receiver}/   (gate1-live-checks.ts)
//   (g1d) live-{stall,reconnect,resync,receiver-killed}/{host,receiver}/,
//         sabotage-{ignore-credit,stale-coalesce}/{host,receiver}/   (gate1-g1d-checks.ts)

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { compareRgbaBuffers } from "../../../../packages/test-harness/src/image-diff";
import {
  decodePngRgba,
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type AppliedJson,
  type CaptureResultJson,
  type Checkpoint,
  type Classification,
  checkCaptureArmed,
  checkHeadlessNoGpuGate0,
  checkManifestPresent,
  checkReceiverConsumedStream,
  checkReceiverNeverLoadedFixture,
  checkReceiverTypedClean,
  checkRecordingDecodes,
  classifyLeg,
  type DrawIndexTie,
  diffRgba,
  drawIndexTies,
  firstTransactionWithRectColor,
  type Gate0Check,
  joinSettleSeqs,
  type LegEvaluation,
  loadRecording,
  PATCH_RECORDING_NAME,
  parseStepLog,
  RECORDING_NAME,
  type RecordingSummary,
  type ResolvedCanvas,
  type ResolvedItem,
  readExitCode,
  type SessionMeta,
  type StepJoin,
  type StepLine,
} from "./gate0-checks";
import {
  type Gate1Expected,
  gate1Names,
  stepFrames,
  synthesizeGate1,
} from "./gate1-expected";
import {
  checkCoalesced,
  checkG1dLegClass,
  checkHostSurvivesReceiverLoss,
  checkNewestAfterStall,
  checkPendingBounded,
  checkReconnectCleanSlate,
  checkReconnectFreshSession,
  checkResyncFull,
  checkSimKeptRunning,
  checkStallObserved,
  checkStallPixels,
  evaluateG1dLeg,
  G1D_CLASSIFIED_LEGS,
  G1D_SUPPORT_LEGS,
  type G1dLeg,
  type G1dLegEvaluation,
  type G1dLegReport,
  g1dLegReport,
  loadKilled,
} from "./gate1-g1d-checks";
import {
  checkLiveAcksStaged,
  checkLiveCreditBounded,
  checkLiveDecodes,
  checkLiveFirstFullThenPatch,
  checkLiveHandshake,
  checkLiveLegClass,
  checkLiveListening,
  checkLiveReceiverLate,
  checkLiveReceiverNeverLoadedFixture,
  checkLiveReplayEqualsLive,
  checkLiveResolvesToRecording,
  checkLiveTapEqualsReceived,
  checkLiveVsReference,
  evaluateLiveLeg,
  G1C_CLASSIFIED_LEGS,
  type G1cLeg,
  type LiveHostEvidence,
  type LiveHostLeg,
  type LiveLegEvaluation,
  type LiveLegReport,
  liveLegReport,
} from "./gate1-live-checks";

// ---------------------------------------------------------------------------------------------
// Constants of the contract
// ---------------------------------------------------------------------------------------------

/** The capture leg's quit frame: one transaction per frame, so 400 transactions. */
export const G1A_CAPTURE_QUIT_FRAME = 400;

export type Gate1Class =
  | "capture-failure"
  | "unsupported"
  | "replay-failure"
  | "delivery-violation"
  | "pixel-mismatch"
  | "success";

/** First match wins (gate1-design.md Q7 "Classes"). */
export const GATE1_CLASS_PRECEDENCE: readonly Gate1Class[] = [
  "capture-failure",
  "unsupported",
  "replay-failure",
  "delivery-violation",
  "pixel-mismatch",
  "success",
];

/** Leg groups in increment order; LANDED_GROUPS are the ones a full run requires today. */
export const ALL_GROUPS = ["g1a", "g1b", "g1c", "g1d"] as const;
export const LANDED_GROUPS: readonly string[] = ["g1a", "g1b", "g1c", "g1d"];

export const G1A_CLASSIFIED_LEGS = [
  "capture",
  "receiver",
  "sabotage-omit-modulate",
  "sabotage-omit-transform",
  "sabotage-omit-order",
  "sabotage-omit-visibility",
  "root-size-observe",
] as const;
export type G1aLeg = (typeof G1A_CLASSIFIED_LEGS)[number];

/** G1b2's legs (gate1-design.md "G1b2"), plus `tie-overlap`: the fixture's one-frame
 * top-level draw-index tie made to overlap, which must classify `unsupported`. */
export const G1B_CLASSIFIED_LEGS = [
  "receiver-patch",
  "sabotage-omit-free",
  "sabotage-omit-visible",
  "sabotage-patch-drop",
  "tie-overlap",
] as const;
export type G1bLeg = (typeof G1B_CLASSIFIED_LEGS)[number];
export type Gate1Leg = G1aLeg | G1bLeg;

export const G1A_SUPPORT_LEGS = [
  "import",
  "receiver-typecheck",
  "reference",
  "receiver-headless-trace",
] as const;

export interface Gate1LegExpectation {
  class: Gate1Class;
  /** pixel-mismatch legs: exactly these steps mismatch (all others match exactly) */
  mismatchSteps?: number[];
  /** a substring one of the reasons must contain */
  reasonIncludes?: string;
  /** every step mismatches in exactly these regions and nowhere outside them */
  mismatchRegions?: string[];
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** The sabotage step sets are gate1-design.md's predictions, confirmed by running (README
 * "Gate 1a result", "Gate 1b result"). G1e (steps 11/12) extends the ranges that never recover
 * (modulate, transform, visibility, free: nothing after the sabotaged step resets the dropped
 * state, so the mismatch persists into the two new steps too); order and visible converge again
 * before step 11, so their sets are unchanged. */
export const G1A_EXPECTATIONS: Record<G1aLeg, Gate1LegExpectation> = {
  capture: { class: "success" },
  receiver: { class: "success" },
  "sabotage-omit-modulate": {
    class: "pixel-mismatch",
    mismatchSteps: range(1, 12),
  },
  "sabotage-omit-transform": {
    class: "pixel-mismatch",
    mismatchSteps: range(2, 12),
  },
  "sabotage-omit-order": { class: "pixel-mismatch", mismatchSteps: [3] },
  "sabotage-omit-visibility": {
    class: "pixel-mismatch",
    mismatchSteps: range(7, 12),
  },
  "root-size-observe": {
    class: "unsupported",
    reasonIncludes: "degenerate-host-size",
    mismatchRegions: ["corner", "corner-degenerate"],
  },
};

export const G1B_EXPECTATIONS: Record<G1bLeg, Gate1LegExpectation> = {
  "receiver-patch": { class: "success" },
  "sabotage-omit-free": {
    class: "pixel-mismatch",
    mismatchSteps: [8, 9, 10, 11, 12],
  },
  "sabotage-omit-visible": { class: "pixel-mismatch", mismatchSteps: [6] },
  "sabotage-patch-drop": {
    class: "capture-failure",
    reasonIncludes: "patch-divergence",
  },
  "tie-overlap": { class: "unsupported", reasonIncludes: "draw-index-tie" },
};

export const GATE1_EXPECTATIONS: Record<Gate1Leg, Gate1LegExpectation> = {
  ...G1A_EXPECTATIONS,
  ...G1B_EXPECTATIONS,
};

export function legGroup(leg: Gate1Leg): "g1a" | "g1b" {
  return (G1A_CLASSIFIED_LEGS as readonly string[]).includes(leg)
    ? "g1a"
    : "g1b";
}

export interface Gate1LegLayout {
  legDir: string;
  captureDir: string;
  receiverDir?: string;
  /** whether the receiver takes the settle-step shots compared with the reference */
  shots: boolean;
  /** the recording the receiver consumed (and whose hashes it must echo) */
  recordingName: string;
}

export function gate1LegLayout(outDir: string, leg: Gate1Leg): Gate1LegLayout {
  const legDir = join(outDir, leg);
  switch (leg) {
    case "capture":
      return {
        legDir,
        captureDir: legDir,
        shots: false,
        recordingName: RECORDING_NAME,
      };
    case "receiver":
      return {
        legDir,
        captureDir: join(outDir, "capture"),
        receiverDir: legDir,
        shots: true,
        recordingName: RECORDING_NAME,
      };
    case "receiver-patch":
      return {
        legDir,
        captureDir: join(outDir, "capture"),
        receiverDir: legDir,
        shots: true,
        recordingName: PATCH_RECORDING_NAME,
      };
    case "sabotage-patch-drop":
      return {
        legDir,
        captureDir: join(legDir, "capture"),
        receiverDir: join(legDir, "receiver"),
        shots: true,
        recordingName: PATCH_RECORDING_NAME,
      };
    case "tie-overlap":
      // Its own fixture variant: no expected.json images, so no settle checkpoints. The tie
      // frame is shot and compared with the variant's own reference as a measurement.
      return {
        legDir,
        captureDir: join(legDir, "capture"),
        receiverDir: join(legDir, "receiver"),
        shots: false,
        recordingName: RECORDING_NAME,
      };
    default:
      return {
        legDir,
        captureDir: join(legDir, "capture"),
        receiverDir: join(legDir, "receiver"),
        shots: true,
        recordingName: RECORDING_NAME,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Evidence shapes
// ---------------------------------------------------------------------------------------------

export interface RootGeometryState {
  window_size?: number[];
  visible_rect?: number[];
  canvas_transform?: number[];
  final_transform?: number[];
}

/** evidence/root.json (render-stream-root-geometry/1): reported, no longer classified. */
export interface RootEvidence {
  schema?: string;
  policy?: string;
  logical_size?: number[];
  stretch?: { mode?: string; aspect?: string; scale_mode?: string };
  content_scale_factor?: number;
  before?: RootGeometryState;
  after?: RootGeometryState;
  host_size_status?: string;
  enforce?: { called?: boolean; ok?: boolean; detail?: string | null };
}

/** The root geometry a session declares (render-stream-1.md "Session record", unchanged at /2). */
export interface SessionRoot {
  policy: string | null;
  host_size_status: string | null;
  logical_size: number[] | null;
  host_window_size: number[] | null;
  stretch: unknown;
  host_visible_rect: number[] | null;
  host_final_xform: number[] | null;
  root_canvas_xform: number[] | null;
}

export function sessionRoot(recording: RecordingSummary): SessionRoot | null {
  const s = recording.session;
  if (!s) return null;
  const b = recording.session_blocks ?? [];
  return {
    policy: s.viewport?.root_size_policy ?? null,
    host_size_status: s.viewport?.host_size_status ?? null,
    logical_size: s.viewport?.logical_size ?? null,
    host_window_size: s.viewport?.host_window_size ?? null,
    stretch: s.viewport?.stretch ?? null,
    host_visible_rect: b[2] ?? null,
    host_final_xform: b[3] ?? null,
    root_canvas_xform: b[1] ?? null,
  };
}

/** One line of the fixture's RS_FIXTURE_ROOT_LOG. */
export interface RootLine {
  step: number;
  frame: number;
  display_server: string;
  window_size: number[];
  visible_rect: number[];
  canvas_transform: number[];
  final_transform: number[];
  content_scale_size: number[];
  content_scale_mode: number;
}

export function parseRootLog(text: string | undefined): RootLine[] | undefined {
  if (!text) return undefined;
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return undefined;
  try {
    return lines.map((l) => JSON.parse(l) as RootLine);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Resolved per-transaction state
// ---------------------------------------------------------------------------------------------

export type ItemFull = ResolvedItem;
export type CanvasFull = ResolvedCanvas;

export interface TxState {
  seq: number;
  frame: number;
  items: Map<number, ItemFull>;
  canvases: Map<number, CanvasFull>;
}

/** Every transaction's resolved state, in record order (a patch recording resolves to full
 * states). Records after the first that fails to decode are absent. */
export function statesOf(recording: RecordingSummary): TxState[] {
  return recording.transactions.map((t) => ({
    seq: t.meta.seq,
    frame: t.meta.frame,
    items: new Map(t.meta.items.map((i) => [i.id, i] as const)),
    canvases: new Map(t.meta.canvases.map((c) => [c.id, c] as const)),
  }));
}

export interface NameMap {
  byName: Map<string, number>;
  byId: Map<number, string>;
  problems: string[];
}

/** Names to wire ids: the k-th id ever seen is the k-th name of creation_order + created_later.
 * Cross-checked: every named item drawing at step 0 has an add_rect in its step-0 colour. */
export function mapNames(
  expected: Gate1Expected,
  states: readonly TxState[],
): NameMap {
  const names = gate1Names(expected);
  const ids = new Set<number>();
  for (const s of states) for (const id of s.items.keys()) ids.add(id);
  const sorted = [...ids].sort((a, b) => a - b);
  const problems: string[] = [];
  if (sorted.length !== names.length) {
    problems.push(
      `${sorted.length} item ids in the recording, expected ${names.length} (${names.join(",")})`,
    );
  }
  const byName = new Map<string, number>();
  const byId = new Map<number, string>();
  for (let i = 0; i < Math.min(sorted.length, names.length); i++) {
    byName.set(names[i], sorted[i]);
    byId.set(sorted[i], names[i]);
  }
  const settle0 = stateAtFrame(states, stepFrames(expected, 0).settle);
  const step0 = expected.steps.find((s) => s.step === 0);
  if (settle0 && step0) {
    for (const draw of step0.draws) {
      const id = byName.get(draw.name);
      const item = id === undefined ? undefined : settle0.items.get(id);
      const want = draw.rgba8.map((c) => Math.fround(c / 255));
      const ok = item?.commands.some(
        (c) => c.op === "add_rect" && want.every((v, i) => c.color?.[i] === v),
      );
      if (!ok) {
        problems.push(
          `${draw.name} (id ${id ?? "?"}) has no add_rect in colour ${draw.rgba8.join(",")} at step 0`,
        );
      }
    }
  } else {
    problems.push("no transaction at step 0's settle frame");
  }
  return { byName, byId, problems };
}

export function stateAtFrame(
  states: readonly TxState[],
  frame: number,
): TxState | undefined {
  return states.find((s) => s.frame === frame);
}

const f32eq = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === Math.fround(b[i]));

function parentName(
  parent: ItemFull["parent"],
  names: NameMap,
): { canvas: number } | { item: string } | null {
  if (parent === null) return null;
  if (parent.kind === "canvas") return { canvas: parent.id };
  return { item: names.byId.get(parent.id) ?? `#${parent.id}` };
}

function fieldValue(item: ItemFull, field: string, names: NameMap): unknown {
  switch (field) {
    case "parent":
      return parentName(item.parent, names);
    case "children":
      return item.children.map((id) => names.byId.get(id) ?? `#${id}`);
    case "command_count":
      return item.commands.length;
    case "visible":
      return item.visible;
    case "draw_index":
      return item.draw_index;
    case "z_index":
      return item.z_index;
    case "z_relative":
      return item.z_relative;
    case "behind":
      return item.behind;
    case "visibility_layer":
      return item.visibility_layer;
    case "modulate":
      return item.modulate;
    case "self_modulate":
      return item.self_modulate;
    case "xform":
      return item.xform;
    default:
      return undefined;
  }
}

function valuesEqual(field: string, got: unknown, want: unknown): boolean {
  if (field === "modulate" || field === "self_modulate" || field === "xform") {
    return (
      Array.isArray(got) && Array.isArray(want) && f32eq(got as number[], want)
    );
  }
  return JSON.stringify(got) === JSON.stringify(want);
}

/** Every invariant of every step, on the settle transactions. Returns the problems and the
 * number of assertions evaluated. */
export function evaluateInvariants(
  expected: Gate1Expected,
  states: readonly TxState[],
  names: NameMap,
): { problems: string[]; evaluated: number } {
  const problems: string[] = [];
  let evaluated = 0;
  const settle = (step: number): TxState | undefined =>
    stateAtFrame(states, stepFrames(expected, step).settle);
  for (const step of expected.steps) {
    const now = settle(step.step);
    if (!now) {
      problems.push(`step ${step.step}: no settle transaction`);
      continue;
    }
    const item = (name: string, state: TxState): ItemFull | undefined => {
      const id = names.byName.get(name);
      return id === undefined ? undefined : state.items.get(id);
    };
    const fail = (text: string): void => {
      problems.push(`step ${step.step}: ${text}`);
    };
    for (const inv of step.invariants) {
      evaluated++;
      switch (inv.kind) {
        case "field": {
          const it = item(inv.item, now);
          if (!it) {
            fail(`${inv.item} absent (field ${inv.field})`);
            break;
          }
          const got = fieldValue(it, inv.field, names);
          if (!valuesEqual(inv.field, got, inv.value)) {
            fail(
              `${inv.item}.${inv.field} = ${JSON.stringify(got)}, expected ${JSON.stringify(inv.value)}`,
            );
          }
          break;
        }
        case "version":
        case "version_all": {
          const then = settle(inv.step);
          if (!then) {
            fail(`no settle transaction for step ${inv.step}`);
            break;
          }
          const list =
            inv.kind === "version"
              ? inv.items
              : [...now.items.keys()]
                  .filter((id) => then.items.has(id))
                  .map((id) => names.byId.get(id) ?? `#${id}`)
                  .filter((n) => !inv.except.includes(n));
          for (const name of list) {
            const a = item(name, now);
            const b = item(name, then);
            if (!a || !b) {
              fail(`${name} absent for the version comparison`);
              continue;
            }
            const ok =
              inv.cmp === "eq"
                ? a.content_version === b.content_version
                : a.content_version > b.content_version;
            if (!ok) {
              fail(
                `${name}.content_version ${a.content_version} is not ${inv.cmp} step ${inv.step}'s ${b.content_version}`,
              );
            }
          }
          break;
        }
        case "changed": {
          const then = settle(inv.step);
          for (const name of inv.items) {
            const a = then ? item(name, now) : undefined;
            const b = then ? item(name, then) : undefined;
            if (!a || !b) {
              fail(`${name} absent for the ${inv.field} comparison`);
            } else if (f32eq(a[inv.field], b[inv.field])) {
              fail(
                `${name}.${inv.field} unchanged since step ${inv.step} (${a[inv.field].join(",")})`,
              );
            }
          }
          break;
        }
        case "swapped": {
          const then = settle(inv.step);
          const [na, nb] = inv.items;
          const a = item(na, now);
          const b = item(nb, now);
          const a0 = then ? item(na, then) : undefined;
          const b0 = then ? item(nb, then) : undefined;
          if (!a || !b || !a0 || !b0) {
            fail(`${na}/${nb} absent for the swap comparison`);
          } else if (
            !(
              a[inv.field] === b0[inv.field] &&
              b[inv.field] === a0[inv.field] &&
              a[inv.field] !== b[inv.field]
            )
          ) {
            fail(
              `${na}/${nb}.${inv.field} not swapped: now ${a[inv.field]}/${b[inv.field]}, step ${inv.step} ${a0[inv.field]}/${b0[inv.field]}`,
            );
          }
          break;
        }
        case "absent":
        case "present": {
          for (const name of inv.items) {
            const id = names.byName.get(name);
            const here = id !== undefined && now.items.has(id);
            if (inv.kind === "absent" ? here : !here) {
              fail(
                `${name} (id ${id ?? "?"}) is ${here ? "present" : "absent"}`,
              );
            }
          }
          break;
        }
        case "new_ids": {
          const then = settle(inv.step);
          if (!then) {
            fail(`no settle transaction for step ${inv.step}`);
            break;
          }
          const fresh = [...now.items.keys()].filter(
            (id) => !then.items.has(id),
          );
          const want = inv.items.map((n) => names.byName.get(n));
          if (
            JSON.stringify(fresh.sort((a, b) => a - b)) !== JSON.stringify(want)
          ) {
            fail(
              `new ids since step ${inv.step} are ${JSON.stringify(fresh)}, expected ${JSON.stringify(want)} (${inv.items.join(",")})`,
            );
          }
          const applied = stepFrames(expected, step.step).applied;
          let maxBefore = 0;
          for (const s of states) {
            if (s.frame >= applied) break;
            for (const id of s.items.keys())
              maxBefore = Math.max(maxBefore, id);
          }
          for (const id of want) {
            if (id === undefined || id <= maxBefore) {
              fail(
                `new id ${id ?? "?"} is not above every id seen before frame ${applied} (max ${maxBefore})`,
              );
            }
          }
          break;
        }
        case "canvas_xform": {
          const cv = now.canvases.get(inv.canvas);
          if (!cv || !f32eq(cv.xform, inv.value)) {
            fail(
              `canvas ${inv.canvas} transform ${JSON.stringify(cv?.xform ?? null)}, expected ${JSON.stringify(inv.value)}`,
            );
          }
          break;
        }
      }
    }
  }
  return { problems, evaluated };
}

// ---------------------------------------------------------------------------------------------
// Patch sink against full sink
// ---------------------------------------------------------------------------------------------

/** A resolved state as one comparable string: numbers bit-exact (-0 kept apart from 0). */
function stateKey(t: RecordingSummary["transactions"][number]): string {
  return JSON.stringify(resolvedStateOf(t.meta), (_key, value) =>
    Object.is(value, -0) ? "-0" : value,
  );
}

/** The resolved `state` of a transaction, in render-stream-2.md's key order: exactly what a
 * receiver's state dump (state/seq-<n>.json) holds. */
export function resolvedStateOf(
  t: RecordingSummary["transactions"][number]["meta"],
): {
  status: string;
  failures: unknown[];
  unsupported: unknown[];
  default_texture_filter: string;
  default_texture_repeat: string;
  canvases: unknown[];
  items: unknown[];
  textures: unknown[];
} {
  return {
    status: t.status,
    failures: t.failures,
    unsupported: t.unsupported,
    default_texture_filter: t.default_texture_filter,
    default_texture_repeat: t.default_texture_repeat,
    canvases: t.canvases,
    items: t.items,
    textures: t.textures,
  };
}

/**
 * Differences between the patch sink's resolved states and the full sink's, frame by frame
 * (gate1-design.md Q7 class 1, `patch-divergence`): both recordings must be valid, cover the same
 * frames, and resolve to bit-identical states at every one. Empty means equivalent.
 */
export function patchDivergence(
  full: RecordingSummary,
  patch: RecordingSummary,
): string[] {
  if (!patch.present) return [`${PATCH_RECORDING_NAME} missing`];
  if (!full.present) return [`${RECORDING_NAME} missing`];
  const out: string[] = [];
  if (patch.errors.length > 0)
    out.push(`patch recording invalid: ${patch.errors[0]}`);
  const byFrame = new Map(full.transactions.map((t) => [t.meta.frame, t]));
  for (const t of patch.transactions) {
    const f = byFrame.get(t.meta.frame);
    if (!f) out.push(`frame ${t.meta.frame}: no full-sink transaction`);
    else if (stateKey(f) !== stateKey(t))
      out.push(
        `frame ${t.meta.frame} (seq ${t.meta.seq}): the patch sink resolves to a different state`,
      );
  }
  if (patch.transactions.length !== full.transactions.length)
    out.push(
      `${patch.transactions.length} patch-sink transactions, ${full.transactions.length} full-sink`,
    );
  return out;
}

// ---------------------------------------------------------------------------------------------
// classifyGate1 (pure): gate 0's rules plus the root-size declaration and patch divergence
// ---------------------------------------------------------------------------------------------

export interface Gate1Classification {
  result_class: Gate1Class;
  reasons: string[];
  mismatching_steps: number[];
  harmless_ties: string[];
}

/** Gate 0's classifyLeg plus gate 1's rules: no session is capture-failure; a declared
 * non-match host size is unsupported (`degenerate-host-size`; under enforce-min-size the
 * recording also carries the root-size-enforce-failed failure, which gate 0's rules already
 * make capture-failure); a patch sink that does not resolve to the full sink's states is
 * capture-failure (`patch-divergence`). */
export function classifyGate1(
  base: Classification,
  session: SessionMeta | undefined,
  divergence: string[] | null,
): Gate1Classification {
  const reasons = [...base.reasons];
  if (!session) {
    reasons.push("capture-failure: the recording has no session record");
  } else if (session.viewport?.host_size_status !== "match") {
    reasons.push(
      `unsupported: degenerate-host-size (session host_size_status ${JSON.stringify(session.viewport?.host_size_status ?? null)}, logical ${JSON.stringify(session.viewport?.logical_size ?? null)}, window ${JSON.stringify(session.viewport?.host_window_size ?? null)})`,
    );
  }
  if (divergence && divergence.length > 0) {
    reasons.push(
      `capture-failure: patch-divergence: ${divergence.slice(0, 3).join("; ")}${divergence.length > 3 ? ` (+${divergence.length - 3} more)` : ""}`,
    );
  }
  const fired = new Set(reasons.map((r) => r.slice(0, r.indexOf(":"))));
  const resultClass =
    GATE1_CLASS_PRECEDENCE.find((c) => fired.has(c)) ?? "success";
  const ordered = GATE1_CLASS_PRECEDENCE.flatMap((c) =>
    reasons.filter((r) => r.startsWith(`${c}:`)),
  );
  return {
    result_class: resultClass,
    reasons: ordered,
    mismatching_steps: base.mismatching_steps,
    harmless_ties: base.harmless_ties,
  };
}

// ---------------------------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------------------------

export interface Gate1Checkpoint extends Checkpoint {
  leg: string;
  stream: "full" | "patch";
  /** mismatching pixels outside every expected.json region */
  outside_regions_mismatched_pixels: number | null;
}

function insideAny(x: number, y: number, rects: readonly number[][]): boolean {
  return rects.some(
    ([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh,
  );
}

export async function computeGate1Checkpoints(
  leg: string,
  stream: "full" | "patch",
  join_: StepJoin,
  referenceShotsDir: string,
  receiverShotsDir: string,
  diffDir: string,
  expected: Gate1Expected,
  /** the receiver shot's file name for a step (default `seq-<seq>.png`; G1d's second live
   * connection names its shots `stream-2-seq-<seq>.png`) */
  shotName: (step: number, seq: number) => string = (_step, seq) =>
    `seq-${seq}.png`,
): Promise<{ checkpoints: Gate1Checkpoint[]; compareOk: boolean }> {
  const checkpoints: Gate1Checkpoint[] = [];
  let compareOk = true;
  const regionList = Object.entries(expected.regions);
  for (const entry of join_.entries) {
    const referencePng = join(referenceShotsDir, `step-${entry.step}.png`);
    const receiverPng =
      entry.seq === null
        ? null
        : join(receiverShotsDir, shotName(entry.step, entry.seq));
    const ref = await decodePngRgba(referencePng);
    const got = receiverPng ? await decodePngRgba(receiverPng) : undefined;
    const base = {
      leg,
      stream,
      step: entry.step,
      settle_frame: entry.settle_frame,
      seq: entry.seq,
      reference_png: referencePng,
      receiver_png: receiverPng,
    };
    if (!ref || !got || ref.width !== got.width || ref.height !== got.height) {
      compareOk = false;
      checkpoints.push({
        ...base,
        diff_png: null,
        mismatched_pixels: null,
        max_channel_delta: null,
        outside_regions_mismatched_pixels: null,
        regions: regionList.map(([name, rect]) => ({
          name,
          rect_px: [...rect],
          mismatched_pixels: null,
          max_channel_delta: null,
        })),
      });
      continue;
    }
    const full = diffRgba(ref.data, got.data, ref.width, ref.height);
    const diffPng = join(diffDir, `step-${entry.step}.png`);
    await mkdir(diffDir, { recursive: true });
    const verdict = await compareRgbaBuffers(ref.data, got.data, {
      width: ref.width,
      height: ref.height,
      threshold: 0,
      maxDiffRatio: 0,
      maxChannelDelta: 0,
      diffPath: diffPng,
    });
    if (!verdict.ok) compareOk = false;
    let outside = 0;
    const rects = regionList.map(([, r]) => r);
    for (let y = 0; y < ref.height; y++) {
      for (let x = 0; x < ref.width; x++) {
        const i = (y * ref.width + x) * 4;
        if (
          (ref.data[i] !== got.data[i] ||
            ref.data[i + 1] !== got.data[i + 1] ||
            ref.data[i + 2] !== got.data[i + 2] ||
            ref.data[i + 3] !== got.data[i + 3]) &&
          !insideAny(x, y, rects)
        ) {
          outside++;
        }
      }
    }
    checkpoints.push({
      ...base,
      diff_png: diffPng,
      ...full,
      outside_regions_mismatched_pixels: outside,
      regions: regionList.map(([name, rect]) => ({
        name,
        rect_px: [...rect],
        ...diffRgba(ref.data, got.data, ref.width, ref.height, rect),
      })),
    });
  }
  return { checkpoints, compareOk };
}

function checkpointMismatch(c: Checkpoint): boolean {
  const bad = (n: number | null): boolean => n === null || n > 0;
  return (
    bad(c.mismatched_pixels) ||
    bad(c.max_channel_delta) ||
    c.regions.some((r) => bad(r.mismatched_pixels) || bad(r.max_channel_delta))
  );
}

/** Steps of the timeline joined to the transactions at their settle frames (expected frames when
 * the capture's steps.jsonl is unreadable is NOT a fallback: the join then fails). */
async function stepJoinFor(captureDir: string, recording: RecordingSummary) {
  return joinSettleSeqs(
    parseStepLog(await readTextOrUndefined(join(captureDir, "steps.jsonl"))),
    recording.transactions,
  );
}

// ---------------------------------------------------------------------------------------------
// Leg evaluation
// ---------------------------------------------------------------------------------------------

export interface Gate1LegEvaluation {
  leg: Gate1Leg;
  layout: Gate1LegLayout;
  expected_class: Gate1Class;
  classification: Gate1Classification;
  exit_code: number | null;
  artifacts: string[];
  /** the recording the leg's receiver consumed (the full one when it has no receiver) */
  recording: RecordingSummary;
  /** the capture's full-sink recording */
  full: RecordingSummary;
  /** the capture's patch-sink recording */
  patch: RecordingSummary;
  captureResult: CaptureResultJson | undefined;
  root: SessionRoot | null;
  stepJoin?: StepJoin;
  applied?: AppliedJson;
  checkpoints: Gate1Checkpoint[];
  compareOk: boolean;
  /** tie-overlap only, filled by checkLegClass */
  tieMeasurement?: TieMeasurement;
}

async function existing(paths: string[]): Promise<string[]> {
  const flags = await Promise.all(paths.map(fileExists));
  return paths.filter((_, i) => flags[i]);
}

async function shotSeqsPresent(receiverDir: string): Promise<number[]> {
  try {
    const names = await readdir(join(receiverDir, "shots"));
    return names
      .map((n) => /^seq-(\d+)\.png$/.exec(n)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);
  } catch {
    return [];
  }
}

export async function evaluateGate1Leg(
  outDir: string,
  leg: Gate1Leg,
  expected: Gate1Expected,
): Promise<Gate1LegEvaluation> {
  const layout = gate1LegLayout(outDir, leg);
  const captureResult = await readJson<CaptureResultJson>(
    join(layout.captureDir, "evidence", "result.json"),
  );
  const full = await loadRecording(join(layout.captureDir, RECORDING_NAME));
  const patch = await loadRecording(
    join(layout.captureDir, PATCH_RECORDING_NAME),
  );
  const recording = layout.recordingName === RECORDING_NAME ? full : patch;
  const stepJoin = layout.shots
    ? await stepJoinFor(layout.captureDir, recording)
    : undefined;
  let applied: AppliedJson | undefined;
  let checkpoints: Gate1Checkpoint[] = [];
  let compareOk = true;
  let receiverInput: Parameters<typeof classifyLeg>[0]["receiver"];
  if (layout.receiverDir) {
    applied = await readJson<AppliedJson>(
      join(layout.receiverDir, "applied.json"),
    );
    if (
      applied !== undefined &&
      (applied === null || typeof applied !== "object")
    ) {
      applied = undefined;
    }
    receiverInput = {
      applied,
      requestedShotSeqs:
        stepJoin?.entries
          .map((e) => e.seq)
          .filter((s): s is number => s !== null) ?? [],
      shotFiles: await shotSeqsPresent(layout.receiverDir),
    };
    if (stepJoin?.ok) {
      ({ checkpoints, compareOk } = await computeGate1Checkpoints(
        leg,
        layout.recordingName === RECORDING_NAME ? "full" : "patch",
        stepJoin,
        join(outDir, "reference", "shots"),
        join(layout.receiverDir, "shots"),
        join(layout.receiverDir, "diff"),
        expected,
      ));
    }
  }
  const base = classifyLeg({
    captureResult,
    recording,
    stepJoin,
    receiver: receiverInput,
    checkpoints,
  });
  const classification = classifyGate1(
    base,
    recording.session,
    patchDivergence(full, patch),
  );
  const processDirs = [
    layout.captureDir,
    ...(layout.receiverDir ? [layout.receiverDir] : []),
  ];
  const artifacts = await existing(
    processDirs.flatMap((dir) => [
      join(dir, "argv.txt"),
      join(dir, "env.txt"),
      join(dir, "stdout.log"),
      join(dir, "exit-code.txt"),
      join(dir, "evidence", "result.json"),
      join(dir, "evidence", "root.json"),
      join(dir, RECORDING_NAME),
      join(dir, PATCH_RECORDING_NAME),
      join(dir, "steps.jsonl"),
      join(dir, "root.jsonl"),
      join(dir, "applied.json"),
      join(dir, "strace.txt"),
    ]),
  );
  return {
    leg,
    layout,
    expected_class: GATE1_EXPECTATIONS[leg].class,
    classification,
    exit_code: await readExitCode(layout.receiverDir ?? layout.captureDir),
    artifacts: [...new Set(artifacts)],
    recording,
    full,
    patch,
    captureResult,
    root: sessionRoot(recording),
    stepJoin,
    applied,
    checkpoints,
    compareOk,
  };
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

export type Gate1Check = Gate0Check & { status: "pass" | "fail" | "not-run" };

export function check(
  id: string,
  criterion: string,
  problems: string[],
  okDetail: string,
  evidence: string[],
): Gate1Check {
  return {
    id,
    criterion,
    passed: problems.length === 0,
    status: problems.length === 0 ? "pass" : "fail",
    detail: problems.length === 0 ? okDetail : problems.join("; "),
    evidence,
  };
}

function fromGate0(c: Gate0Check, criterion?: string): Gate1Check {
  return {
    ...c,
    criterion: criterion ?? c.criterion,
    status: c.passed ? "pass" : "fail",
  };
}

const RGBA8_LEVELS = new Set([0, 51, 102, 153, 204, 255]);

/** expected.json obeys its own rules (gate1-design.md Q6 "Colour rule", layout, timeline). */
export function checkExpectedSelfConsistent(
  expected: Gate1Expected,
): Gate1Check {
  const problems: string[] = [];
  const [w, h] = expected.viewport ?? [];
  if (expected.schema !== "render-stream-gate1-expected/1")
    problems.push(`schema=${JSON.stringify(expected.schema)}`);
  if (w !== 640 || h !== 360)
    problems.push(`viewport=${JSON.stringify(expected.viewport)}`);
  const S = expected.start_frame_default;
  const N = expected.step_frames_default;
  if (expected.settle_offset !== 7) problems.push("settle_offset is not 7");
  if (!(N > expected.settle_offset))
    problems.push("step_frames_default <= settle_offset");
  if (expected.quit_frame_default !== S + N * 12 + 11) {
    problems.push(
      `quit_frame_default ${expected.quit_frame_default} != S+N*12+11 = ${S + N * 12 + 11}`,
    );
  }
  const steps = expected.steps ?? [];
  if (steps.map((s) => s.step).join(",") !== range(0, 12).join(",")) {
    problems.push(
      `steps are ${steps.map((s) => s.step).join(",")}, expected 0..12`,
    );
  }
  const names = new Set(gate1Names(expected));
  if (names.size !== gate1Names(expected).length)
    problems.push("creation_order + created_later repeat a name");
  const regions = Object.values(expected.regions ?? {});
  const markerColors = new Set<string>();
  const nonMarkerColors = new Set<string>();
  for (const step of steps) {
    for (const d of step.draws) {
      if (!names.has(d.name))
        problems.push(`step ${step.step}: draw of unknown item ${d.name}`);
      if (
        d.rgba8.length !== 4 ||
        d.rgba8[3] !== 255 ||
        !d.rgba8.every((c) => RGBA8_LEVELS.has(c))
      ) {
        problems.push(
          `step ${step.step}: ${d.name} rgba8 ${d.rgba8.join(",")} breaks the colour rule`,
        );
      }
      // Clip to the viewport, then require containment in some region.
      const x0 = Math.max(0, d.rect_px[0]);
      const y0 = Math.max(0, d.rect_px[1]);
      const x1 = Math.min(w, d.rect_px[0] + d.rect_px[2]);
      const y1 = Math.min(h, d.rect_px[1] + d.rect_px[3]);
      const inside = regions.some(
        ([rx, ry, rw, rh]) =>
          x0 >= rx && y0 >= ry && x1 <= rx + rw && y1 <= ry + rh,
      );
      if (!inside)
        problems.push(
          `step ${step.step}: ${d.name} ${d.rect_px.join(",")} lies outside every region`,
        );
      if (x0 < 72 && y0 < 72)
        problems.push(`step ${step.step}: ${d.name} draws in [0,0,72,72]`);
      (d.name === "Marker" ? markerColors : nonMarkerColors).add(
        d.rgba8.join(","),
      );
    }
    const markers = step.draws.filter((d) => d.name === "Marker");
    if (
      markers.length !== 1 ||
      markers[0].rgba8.join(",") !== step.marker_rgba8.join(",")
    ) {
      problems.push(
        `step ${step.step}: the Marker draw does not carry marker_rgba8`,
      );
    }
    for (const inv of step.invariants) {
      const used: string[] =
        "item" in inv ? [inv.item] : "items" in inv ? [...inv.items] : [];
      for (const n of used)
        if (!names.has(n))
          problems.push(`step ${step.step}: invariant names unknown item ${n}`);
    }
    if (
      !Array.isArray(step.canvas_transform) ||
      step.canvas_transform.length !== 6
    )
      problems.push(`step ${step.step}: canvas_transform is not 6 numbers`);
  }
  if (markerColors.size !== steps.length)
    problems.push(
      `${markerColors.size} distinct marker colours for ${steps.length} steps`,
    );
  for (const c of markerColors)
    if (nonMarkerColors.has(c))
      problems.push(`marker colour ${c} is also drawn by another item`);
  // Step 10 is step 9 shifted by its canvas transform, with step 10's marker colour.
  const s9 = steps.find((s) => s.step === 9);
  const s10 = steps.find((s) => s.step === 10);
  if (s9 && s10) {
    const [, , , , tx, ty] = s10.canvas_transform;
    const shifted = s9.draws.map((d) => ({
      name: d.name,
      rect_px: [
        d.rect_px[0] + tx,
        d.rect_px[1] + ty,
        d.rect_px[2],
        d.rect_px[3],
      ],
      rgba8: d.name === "Marker" ? s10.marker_rgba8 : d.rgba8,
    }));
    if (JSON.stringify(shifted) !== JSON.stringify(s10.draws))
      problems.push(
        "step 10's draws are not step 9's shifted by step 10's canvas transform",
      );
  }
  return check(
    "expected-self-consistent",
    "expected.json obeys its rules: 640x360, steps 0..12, every draw colour in {0,51,..,255} with alpha 255, every draw inside a region and none in [0,0,72,72], one distinct marker colour per step used by nothing else, known names, step 10 = step 9 shifted",
    problems,
    `${steps.length} steps, ${steps.reduce((n, s) => n + s.draws.length, 0)} draws, ${steps.reduce((n, s) => n + s.invariants.length, 0)} invariants consistent`,
    [],
  );
}

export async function checkStepAlignment(
  outDir: string,
  expected: Gate1Expected,
  recording: RecordingSummary,
): Promise<Gate1Check> {
  const capturePath = join(outDir, "capture", "steps.jsonl");
  const referencePath = join(outDir, "reference", "steps.jsonl");
  const want: StepLine[] = expected.steps.map((s) => {
    const f = stepFrames(expected, s.step);
    return { step: s.step, applied_frame: f.applied, settle_frame: f.settle };
  });
  const same = (got: StepLine[] | undefined): boolean =>
    JSON.stringify(got) === JSON.stringify(want);
  const problems: string[] = [];
  const captureSteps = parseStepLog(await readTextOrUndefined(capturePath));
  const referenceSteps = parseStepLog(await readTextOrUndefined(referencePath));
  if (!same(captureSteps))
    problems.push(
      `capture steps.jsonl ${JSON.stringify(captureSteps)} != expected`,
    );
  if (!same(referenceSteps))
    problems.push(
      `reference steps.jsonl ${JSON.stringify(referenceSteps)} != expected`,
    );
  const firsts: string[] = [];
  for (const s of expected.steps) {
    const t = firstTransactionWithRectColor(
      recording.transactions,
      s.marker_rgba8.map((c) => c / 255),
    );
    const applied = stepFrames(expected, s.step).applied;
    firsts.push(`${s.step}@${t?.meta.frame ?? "none"}`);
    if (t?.meta.frame !== applied) {
      problems.push(
        `step ${s.step}: marker colour first published at frame ${t?.meta.frame ?? "<none>"}, expected ${applied}`,
      );
    }
  }
  return check(
    "step-alignment",
    "capture and reference steps.jsonl list steps 0..12 at S+N*k (settle +7), and each step's marker colour first appears in the transaction of its applied frame",
    problems,
    `marker colours first published at ${firsts.join(", ")}`,
    [capturePath, referencePath, recording.path],
  );
}

export async function compareWithSynth(
  pngPath: string | null,
  expected: Gate1Expected,
  step: number,
): Promise<string | undefined> {
  if (!pngPath) return `step ${step}: no shot`;
  const got = await decodePngRgba(pngPath);
  if (!got) return `step ${step}: ${pngPath} missing or unreadable`;
  const want = synthesizeGate1(expected, step);
  if (got.width !== want.width || got.height !== want.height) {
    return `step ${step}: ${got.width}x${got.height}, expected ${want.width}x${want.height}`;
  }
  const d = diffRgba(want.rgba, got.data, want.width, want.height);
  if (d.mismatched_pixels > 0) {
    return `step ${step}: ${d.mismatched_pixels} pixels differ from synthesizeGate1 (max channel delta ${d.max_channel_delta})`;
  }
  return undefined;
}

export async function checkExpectedImageReference(
  outDir: string,
  expected: Gate1Expected,
): Promise<Gate1Check> {
  const paths = expected.steps.map((s) =>
    join(outDir, "reference", "shots", `step-${s.step}.png`),
  );
  const problems = (
    await Promise.all(
      expected.steps.map((s, i) =>
        compareWithSynth(paths[i], expected, s.step),
      ),
    )
  ).filter((p): p is string => p !== undefined);
  return check(
    "expected-image-reference",
    "each reference/shots/step-<k>.png (k = 0..12) equals synthesizeGate1(k) exactly",
    problems,
    `${paths.length} reference shots match exactly`,
    paths,
  );
}

export async function checkExpectedImageReceiver(
  receiver: Gate1LegEvaluation,
  expected: Gate1Expected,
): Promise<Gate1Check> {
  const shotsDir = join(
    receiver.layout.receiverDir ?? receiver.layout.legDir,
    "shots",
  );
  const problems: string[] = [];
  const paths: string[] = [];
  if (!receiver.stepJoin?.ok)
    problems.push(
      `step join failed: ${receiver.stepJoin?.problems.join("; ") ?? "no join"}`,
    );
  for (const s of expected.steps) {
    const seq =
      receiver.stepJoin?.entries.find((e) => e.step === s.step)?.seq ?? null;
    const path = seq === null ? null : join(shotsDir, `seq-${seq}.png`);
    if (path) paths.push(path);
    const problem = await compareWithSynth(path, expected, s.step);
    if (problem) problems.push(problem);
  }
  return check(
    "expected-image-receiver",
    "each receiver shot for step k (the transaction at its settle frame) equals synthesizeGate1(k) exactly",
    problems,
    `${paths.length} receiver shots match exactly`,
    paths,
  );
}

export function checkReceiverVsReference(
  receiver: Gate1LegEvaluation,
  expected: Gate1Expected,
): Gate1Check {
  const problems: string[] = [];
  if (!receiver.stepJoin?.ok) problems.push("step join failed: no checkpoints");
  if (receiver.checkpoints.length !== expected.steps.length) {
    problems.push(
      `${receiver.checkpoints.length} checkpoints, expected ${expected.steps.length}`,
    );
  }
  for (const c of receiver.checkpoints) {
    if (checkpointMismatch(c)) {
      problems.push(
        `step ${c.step}: full ${c.mismatched_pixels ?? "unreadable"} px (max delta ${c.max_channel_delta ?? "?"}), ${c.regions
          .filter((r) => r.mismatched_pixels !== 0)
          .map((r) => `${r.name} ${r.mismatched_pixels ?? "?"} px`)
          .join(", ")}`,
      );
    }
  }
  if (!receiver.compareOk && problems.length === 0)
    problems.push("compareRgbaBuffers reported a difference");
  return check(
    "receiver-vs-reference",
    "receiver shots equal the reference shots at all 13 steps: full frame and every expected.json region, 0 mismatched pixels and max channel delta 0",
    problems,
    `${receiver.checkpoints.length} checkpoints identical (full frame and ${Object.keys(expected.regions).length} regions)`,
    receiver.checkpoints.flatMap((c) => [
      c.reference_png,
      ...(c.receiver_png ? [c.receiver_png] : []),
    ]),
  );
}

export function checkRetainedInvariants(
  expected: Gate1Expected,
  states: readonly TxState[],
  recordingPath: string,
): Gate1Check {
  const names = mapNames(expected, states);
  const { problems, evaluated } = evaluateInvariants(expected, states, names);
  return check(
    "retained-invariants",
    "every expected.json invariant holds on its step's settle transaction of the capture recording (names mapped to wire ids by creation order, cross-checked by step-0 colours)",
    [...names.problems, ...problems],
    `${evaluated} invariants hold over ${expected.steps.length} settle transactions; ids ${[...names.byName.entries()].map(([n, id]) => `${n}=${id}`).join(" ")}`,
    [recordingPath],
  );
}

// ---------------------------------------------------------------------------------------------
// Draw-index ties (G1b2): the fixture's one-frame top-level tie, exactly where expected
// ---------------------------------------------------------------------------------------------

export interface ExpectedTie {
  frame: number;
  container: string;
  members: number[];
  harmless: boolean;
}

/** expected.json `draw_index_ties`, with names mapped to wire ids and steps to frames. */
export function expectedTies(
  expected: Gate1Expected,
  names: NameMap,
): ExpectedTie[] {
  return (expected.draw_index_ties ?? []).map((d) => ({
    frame: stepFrames(expected, d.step).applied + d.frame_offset,
    container: `canvas:${d.canvas}`,
    members: d.members
      .map((n) => names.byName.get(n) ?? -1)
      .sort((a, b) => a - b),
    harmless: d.harmless,
  }));
}

const tieKey = (t: Pick<ExpectedTie, "frame" | "container" | "members">) =>
  `${t.frame}/${t.container}/${t.members.join(",")}`;

function cullMaskOf(recording: RecordingSummary): number {
  return Number(recording.session?.viewport?.canvas_cull_mask ?? 0xffffffff);
}

export function recordingTies(recording: RecordingSummary): DrawIndexTie[] {
  const mask = cullMaskOf(recording);
  return recording.transactions.flatMap((t) => drawIndexTies(t.meta, mask));
}

/** Every invariant-9 tie of the capture's full recording is one expected.json declares (frame,
 * container, members, harmless), each declared tie occurs, and each carries its wire entry. */
export function checkDrawIndexTies(
  expected: Gate1Expected,
  capture: Gate1LegEvaluation,
): Gate1Check {
  const names = mapNames(expected, statesOf(capture.full));
  const got = recordingTies(capture.full);
  const want = expectedTies(expected, names);
  const problems: string[] = [];
  const gotKeys = new Map(got.map((t) => [tieKey(t), t]));
  const wantKeys = new Map(want.map((t) => [tieKey(t), t]));
  for (const [key, t] of gotKeys) {
    const w = wantKeys.get(key);
    if (!w) problems.push(`undeclared tie ${key} (harmless ${t.harmless})`);
    else if (w.harmless !== t.harmless)
      problems.push(
        `tie ${key}: harmless ${t.harmless}, expected ${w.harmless} (footprints ${JSON.stringify(t.footprints)})`,
      );
  }
  for (const key of wantKeys.keys())
    if (!gotKeys.has(key)) problems.push(`declared tie ${key} did not occur`);
  for (const t of got) {
    const tx = capture.full.transactions.find((x) => x.meta.seq === t.seq);
    const declared = tx?.meta.unsupported.some(
      (u) =>
        u.reason === "draw-index-tie" &&
        u.item === t.members[0] &&
        u.op === "canvas_item_set_draw_index",
    );
    if (!declared)
      problems.push(
        `seq ${t.seq}: no draw-index-tie entry for item ${t.members[0]}`,
      );
  }
  if (capture.full.transactions.length === 0)
    problems.push("no transactions decoded");
  const named = (ids: number[]) =>
    ids.map((id) => names.byId.get(id) ?? `#${id}`).join("+");
  return check(
    "draw-index-ties",
    "the capture recording's draw-index ties (render-stream-0.md invariant 9) are exactly expected.json's draw_index_ties -- the top-level item added at step 1 ties with P at index 0 for its applied frame only -- each declared on the wire, and each judged harmless exactly when declared so (pairwise disjoint paint footprints)",
    problems,
    `${got.length} tie(s): ${got.map((t) => `frame ${t.frame} ${t.container} {${named(t.members)}}@${t.draw_index} ${t.harmless ? "harmless" : "overlapping"} footprints ${JSON.stringify(t.footprints)}`).join("; ")}`,
    [capture.full.path],
  );
}

async function pngDiff(
  a: string,
  b: string,
): Promise<{ mismatched_pixels: number; max_channel_delta: number } | string> {
  const x = await decodePngRgba(a);
  const y = await decodePngRgba(b);
  if (!x) return `${a} missing or unreadable`;
  if (!y) return `${b} missing or unreadable`;
  if (x.width !== y.width || x.height !== y.height)
    return `${a} is ${x.width}x${x.height}, ${b} is ${y.width}x${y.height}`;
  return diffRgba(x.data, y.data, x.width, x.height);
}

function seqAtFrame(recording: RecordingSummary, frame: number): number | null {
  return (
    recording.transactions.find((t) => t.meta.frame === frame)?.meta.seq ?? null
  );
}

/** The tie frame renders identically in the reference and in both receivers (full and patch):
 * the harmless tie costs nothing on screen. */
export async function checkTieFramePixels(
  outDir: string,
  expected: Gate1Expected,
  capture: Gate1LegEvaluation,
): Promise<Gate1Check> {
  const problems: string[] = [];
  const evidence: string[] = [];
  const notes: string[] = [];
  const frames = [
    ...new Set(
      (expected.draw_index_ties ?? []).map(
        (d) => stepFrames(expected, d.step).applied + d.frame_offset,
      ),
    ),
  ];
  if (frames.length === 0) problems.push("expected.json declares no tie");
  for (const frame of frames) {
    const ref = join(outDir, "reference", "shots", `frame-${frame}.png`);
    const seq = seqAtFrame(capture.full, frame);
    if (seq === null) {
      problems.push(`no capture transaction at frame ${frame}`);
      continue;
    }
    evidence.push(ref);
    for (const leg of ["receiver", "receiver-patch"]) {
      const shot = join(outDir, leg, "shots", `seq-${seq}.png`);
      evidence.push(shot);
      const d = await pngDiff(ref, shot);
      if (typeof d === "string") problems.push(d);
      else if (d.mismatched_pixels > 0)
        problems.push(
          `frame ${frame}: ${leg} seq ${seq} differs from the reference in ${d.mismatched_pixels} px (max delta ${d.max_channel_delta})`,
        );
      else notes.push(`${leg} seq ${seq} == reference frame ${frame}`);
    }
  }
  return check(
    "tie-frame-pixels",
    "at each declared tie frame, reference/shots/frame-<f>.png equals the receiver's and the patch receiver's shot of the transaction at that frame exactly",
    problems,
    notes.join("; "),
    evidence,
  );
}

// ---------------------------------------------------------------------------------------------
// Root geometry (Q1), from the session since G1b2
// ---------------------------------------------------------------------------------------------

const IDENTITY = [1, 0, 0, 1, 0, 0];

export interface RootGeometryReport {
  host: SessionRoot | null;
  /** evidence/root.json, quoted for its before/after window sizes */
  host_evidence: RootEvidence | null;
  observe: SessionRoot | null;
  reference_line: RootLine | null;
  status: string | null;
  per_step: {
    step: number;
    recording: number[] | null;
    reference: number[] | null;
    equal: boolean;
  }[];
}

export async function checkRootGeometry(
  outDir: string,
  expected: Gate1Expected,
  capture: Gate1LegEvaluation,
  observe: Gate1LegEvaluation | undefined,
): Promise<{ check: Gate1Check; report: RootGeometryReport }> {
  const evidencePath = join(outDir, "capture", "evidence", "root.json");
  const hostLogPath = join(outDir, "capture", "root.jsonl");
  const refLogPath = join(outDir, "reference", "root.jsonl");
  const host = capture.root;
  const hostLog = parseRootLog(await readTextOrUndefined(hostLogPath));
  const refLog = parseRootLog(await readTextOrUndefined(refLogPath));
  const problems: string[] = [];
  const [vw, vh] = expected.viewport;
  // 1. The declared logical size equals the reference's content scale size, visible size and
  //    window size (640x360).
  if (!host) problems.push("capture recording has no session");
  if (!refLog) problems.push("reference root.jsonl missing or unparseable");
  const logical = host?.logical_size ?? [];
  if (logical[0] !== vw || logical[1] !== vh)
    problems.push(
      `session logical_size ${JSON.stringify(logical)} != ${vw}x${vh}`,
    );
  for (const line of refLog ?? []) {
    const sizes = {
      content_scale_size: line.content_scale_size,
      visible_size: line.visible_rect?.slice(2, 4),
      window_size: line.window_size,
    };
    for (const [key, value] of Object.entries(sizes)) {
      if (JSON.stringify(value) !== JSON.stringify(logical)) {
        problems.push(
          `reference step ${line.step} ${key} ${JSON.stringify(value)} != session logical ${JSON.stringify(logical)}`,
        );
      }
    }
  }
  // 2. Under enforce-min-size: match, 0,0,640,360, identity final transform, a 640x360 window,
  //    and the host's own root.jsonl equal to the reference's line for line except
  //    display_server.
  if (host) {
    if (host.policy !== "enforce-min-size")
      problems.push(`session root_size_policy ${JSON.stringify(host.policy)}`);
    if (host.host_size_status !== "match")
      problems.push(
        `session host_size_status ${JSON.stringify(host.host_size_status)}`,
      );
    if (!f32eq(host.host_visible_rect ?? [], [0, 0, vw, vh]))
      problems.push(
        `session host_visible_rect ${JSON.stringify(host.host_visible_rect)}`,
      );
    if (!f32eq(host.host_final_xform ?? [], IDENTITY))
      problems.push(
        `session host_final_xform ${JSON.stringify(host.host_final_xform)}`,
      );
    if (JSON.stringify(host.host_window_size) !== JSON.stringify([vw, vh]))
      problems.push(
        `session host_window_size ${JSON.stringify(host.host_window_size)}`,
      );
  }
  if (!hostLog) {
    problems.push("capture root.jsonl missing or unparseable");
  } else if (refLog) {
    const strip = (l: RootLine) =>
      JSON.stringify({ ...l, display_server: null });
    if (hostLog.length !== refLog.length)
      problems.push(
        `capture root.jsonl has ${hostLog.length} lines, reference ${refLog.length}`,
      );
    hostLog.forEach((line, i) => {
      if (refLog[i] && strip(line) !== strip(refLog[i])) {
        problems.push(
          `root.jsonl line ${i} (step ${line.step}) differs: host ${strip(line)} reference ${strip(refLog[i])}`,
        );
      }
    });
    if (hostLog.some((l) => l.display_server !== "headless"))
      problems.push("capture root.jsonl display_server is not headless");
  }
  // 3. Canvas 1's transform at every settle transaction equals the reference's, as float32.
  const states = statesOf(capture.full);
  const perStep: RootGeometryReport["per_step"] = [];
  for (const s of expected.steps) {
    const tx = stateAtFrame(states, stepFrames(expected, s.step).settle);
    const recXform = tx?.canvases.get(1)?.xform ?? null;
    const refXform =
      refLog?.find((l) => l.step === s.step)?.canvas_transform ?? null;
    const equal =
      recXform !== null && refXform !== null && f32eq(recXform, refXform);
    perStep.push({
      step: s.step,
      recording: recXform,
      reference: refXform,
      equal,
    });
    if (!equal)
      problems.push(
        `step ${s.step}: canvas 1 transform ${JSON.stringify(recXform)} != reference ${JSON.stringify(refXform)}`,
      );
  }
  const hostEvidence = (await readJson<RootEvidence>(evidencePath)) ?? null;
  return {
    check: check(
      "root-geometry",
      "the capture session's logical size equals the reference's content scale size, visible size and window size; under enforce-min-size the session declares match, host_visible_rect 0,0,640,360, an identity host_final_xform and a 640x360 window, and the host's root.jsonl equals the reference's except display_server; canvas 1's transform at every settle transaction equals the reference's (float32)",
      problems,
      `logical ${logical.join("x")}; window ${hostEvidence?.before?.window_size?.join("x") ?? "?"} -> ${host?.host_window_size?.join("x") ?? "?"} (${host?.host_size_status ?? "?"}); ${perStep.filter((p) => p.equal).length}/${perStep.length} canvas transforms equal`,
      [capture.full.path, evidencePath, hostLogPath, refLogPath],
    ),
    report: {
      host,
      host_evidence: hostEvidence,
      observe: observe?.root ?? null,
      reference_line: refLog?.[0] ?? null,
      status: host?.host_size_status ?? null,
      per_step: perStep,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Patch sink (G1b2)
// ---------------------------------------------------------------------------------------------

export function checkPatchResolvesToFull(
  capture: Gate1LegEvaluation,
): Gate1Check {
  const problems = [...patchDivergence(capture.full, capture.patch)];
  if (capture.full.errors.length > 0)
    problems.push(`full recording invalid: ${capture.full.errors[0]}`);
  if (capture.full.transactions.length === 0)
    problems.push("no transactions decoded");
  return check(
    "patch-resolves-to-full",
    "the capture's patch sink (recording-patch.rs2) is valid and, resolved, equals the full sink (recording.rs2) at every frame -- canvases, items, the default texture filter/repeat and the texture table -- floats bit for bit",
    problems,
    `${capture.patch.transactions.length} frames resolve bit-identically`,
    [capture.full.path, capture.patch.path],
  );
}

export function checkPatchFirstFull(capture: Gate1LegEvaluation): Gate1Check {
  const problems: string[] = [];
  const fs = capture.full.session;
  const ps = capture.patch.session;
  if (fs?.stream?.encoding !== "full")
    problems.push(
      `full sink session encoding ${JSON.stringify(fs?.stream?.encoding)}`,
    );
  if (ps?.stream?.encoding !== "patch")
    problems.push(
      `patch sink session encoding ${JSON.stringify(ps?.stream?.encoding)}`,
    );
  if (!fs?.session_id || fs.session_id !== ps?.session_id)
    problems.push("the two sinks do not share one session_id");
  if (!fs?.stream?.stream_id || fs.stream.stream_id === ps?.stream?.stream_id)
    problems.push("the two sinks do not have distinct stream_ids");
  capture.full.transactions.forEach((t) => {
    if (t.meta.encoding !== "full" || t.meta.base_seq !== null)
      problems.push(`full sink seq ${t.meta.seq} is ${t.meta.encoding}`);
  });
  capture.patch.transactions.forEach((t, i) => {
    const wantFull = i === 0;
    if ((t.meta.encoding === "full") !== wantFull)
      problems.push(`patch sink seq ${t.meta.seq} is ${t.meta.encoding}`);
    if (!wantFull && t.meta.base_seq !== t.meta.seq - 1)
      problems.push(
        `patch sink seq ${t.meta.seq} has base_seq ${t.meta.base_seq}`,
      );
  });
  const n = capture.patch.transactions.length;
  const stats = capture.patch.end?.stats;
  if (stats?.full_transactions !== 1 || stats?.patch_transactions !== n - 1)
    problems.push(
      `patch end stats full/patch ${stats?.full_transactions}/${stats?.patch_transactions}, expected 1/${n - 1}`,
    );
  const fstats = capture.full.end?.stats;
  if (
    fstats?.full_transactions !== capture.full.transactions.length ||
    fstats?.patch_transactions !== 0 ||
    fstats?.diff_ns_total !== 0
  )
    problems.push(
      `full end stats full/patch/diff_ns ${fstats?.full_transactions}/${fstats?.patch_transactions}/${fstats?.diff_ns_total}`,
    );
  return check(
    "patch-first-full",
    "the patch sink's seq 1 is full and every later seq a patch on seq-1; the full sink is all full; both sinks share the session_id with distinct stream_ids and matching end stats",
    problems.slice(0, 10),
    `full sink ${capture.full.transactions.length} full; patch sink 1 full + ${n - 1} patches`,
    [capture.full.path, capture.patch.path],
  );
}

/** The patch at step 2's applied frame (transform-only moves of P and C, R1's recolour) and at
 * step 10's (the canvas shift) carry `commands: null` for every item whose content did not
 * change. G1b2 contract text corrected as built: G (a child of C) does not change at step 2 and
 * is absent, and the Marker is recoloured at every step, step 10 included. */
export function checkPatchTransformOnly(
  expected: Gate1Expected,
  capture: Gate1LegEvaluation,
): Gate1Check {
  const names = mapNames(expected, statesOf(capture.full));
  const problems: string[] = [...names.problems];
  const wireAt = (step: number) =>
    capture.patch.transactions.find(
      (t) => t.meta.frame === stepFrames(expected, step).applied,
    )?.wire;
  const nameOf = (id: number) => names.byId.get(id) ?? `#${id}`;
  const step2 = wireAt(2);
  let cmdFloats = -1;
  if (step2?.encoding !== "patch") {
    problems.push("no patch transaction at step 2's applied frame");
  } else {
    for (const name of ["P", "C"]) {
      const e = step2.items.find((i) => i.id === names.byName.get(name));
      if (!e) problems.push(`step 2: ${name} has no entry`);
      else if (e.commands !== null)
        problems.push(`step 2: ${name} carries commands`);
    }
    const g = step2.items.find((i) => i.id === names.byName.get("G"));
    if (g && g.commands !== null) problems.push("step 2: G carries commands");
    const withCommands = step2.items
      .filter((i) => i.commands !== null)
      .map((i) => nameOf(i.id))
      .sort();
    if (withCommands.join(",") !== "Marker,R1")
      problems.push(
        `step 2: entries with commands {${withCommands.join(",")}}, expected {Marker,R1}`,
      );
    cmdFloats = step2.blocks.find((b) => b.name === "cmd_f32")?.count ?? -1;
    if (cmdFloats !== 16)
      problems.push(
        `step 2: cmd_f32 holds ${cmdFloats} floats, expected 16 (R1's and the Marker's one rect each)`,
      );
  }
  // A transaction that changes only transforms has empty textures and removed_textures
  // (render-stream-2.md "Full and patch transactions").
  for (const [step, wire] of [
    [2, step2],
    [10, wireAt(10)],
  ] as const) {
    if (wire?.encoding !== "patch") continue;
    if (wire.textures.length > 0 || wire.removed_textures.length > 0)
      problems.push(
        `step ${step}: the patch carries texture entries ${JSON.stringify(wire.textures.map((t) => t.id))} / removed ${JSON.stringify(wire.removed_textures)}, expected none`,
      );
  }
  const step10 = wireAt(10);
  if (step10?.encoding !== "patch") {
    problems.push("no patch transaction at step 10's applied frame");
  } else {
    if (!step10.canvases.some((c) => c.id === 1))
      problems.push("step 10: canvas 1 has no entry");
    const withCommands = step10.items
      .filter((i) => i.commands !== null)
      .map((i) => nameOf(i.id));
    if (withCommands.join(",") !== "Marker")
      problems.push(
        `step 10: entries with commands {${withCommands.join(",")}}, expected {Marker}`,
      );
  }
  return check(
    "patch-transform-only",
    "in the patch at step 2's applied frame P and C carry commands:null (G unchanged, absent) and cmd_f32 holds only R1's and the Marker's floats; in the patch at step 10's frame canvas 1 is present and every item entry but the Marker's carries commands:null; neither patch carries a texture entry or a removed texture",
    problems,
    `step 2: ${step2?.items.map((i) => `${nameOf(i.id)}${i.commands === null ? "(null)" : ""}`).join(" ")} cmd_f32 ${cmdFloats}; step 10: ${step10?.items.map((i) => `${nameOf(i.id)}${i.commands === null ? "(null)" : ""}`).join(" ")}`,
    [capture.patch.path],
  );
}

export async function checkPatchVsFullPixels(
  receiver: Gate1LegEvaluation,
  receiverPatch: Gate1LegEvaluation,
  expected: Gate1Expected,
): Promise<Gate1Check> {
  const problems: string[] = [];
  for (const e of [receiver, receiverPatch]) {
    if (e.checkpoints.length !== expected.steps.length)
      problems.push(`${e.leg}: ${e.checkpoints.length} checkpoints`);
    for (const c of e.checkpoints)
      if (checkpointMismatch(c))
        problems.push(
          `${e.leg} step ${c.step}: ${c.mismatched_pixels ?? "?"} px differ from the reference`,
        );
  }
  const evidence: string[] = [];
  for (const c of receiver.checkpoints) {
    const p = receiverPatch.checkpoints.find((k) => k.step === c.step);
    if (!c.receiver_png || !p?.receiver_png) {
      problems.push(`step ${c.step}: a receiver shot is missing`);
      continue;
    }
    evidence.push(c.receiver_png, p.receiver_png);
    const d = await pngDiff(c.receiver_png, p.receiver_png);
    if (typeof d === "string") problems.push(d);
    else if (d.mismatched_pixels > 0)
      problems.push(
        `step ${c.step}: full and patch receiver shots differ in ${d.mismatched_pixels} px`,
      );
  }
  return check(
    "patch-vs-full-pixels",
    "the patch receiver's settle shots equal the full receiver's and the reference's exactly at all 13 steps",
    problems,
    `${receiverPatch.checkpoints.length} patch-receiver shots == receiver shots == reference`,
    evidence,
  );
}

/** Deep value with object keys sorted and every number rounded to float32. */
function canonical(value: unknown): unknown {
  if (typeof value === "number") return Math.fround(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort())
      out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function canonicalEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export async function checkPatchVsFullReceiverState(
  receiver: Gate1LegEvaluation,
  receiverPatch: Gate1LegEvaluation,
  capture: Gate1LegEvaluation,
): Promise<Gate1Check> {
  const problems: string[] = [];
  const evidence: string[] = [];
  const seqs =
    receiver.stepJoin?.entries
      .map((e) => e.seq)
      .filter((s): s is number => s !== null) ?? [];
  if (seqs.length === 0) problems.push("no settle seqs");
  for (const seq of seqs) {
    const a = join(
      receiver.layout.receiverDir ?? "",
      "state",
      `seq-${seq}.json`,
    );
    const b = join(
      receiverPatch.layout.receiverDir ?? "",
      "state",
      `seq-${seq}.json`,
    );
    evidence.push(a, b);
    const sa = await readJson<unknown>(a);
    const sb = await readJson<unknown>(b);
    const t = capture.full.transactions.find((x) => x.meta.seq === seq)?.meta;
    if (sa === undefined || sb === undefined) {
      problems.push(
        `seq ${seq}: state dump missing (${sa === undefined ? a : b})`,
      );
      continue;
    }
    if (!canonicalEqual(sa, sb))
      problems.push(
        `seq ${seq}: the full and patch receivers' state dumps differ`,
      );
    const want = t && resolvedStateOf(t);
    if (!want || !canonicalEqual(sa, want))
      problems.push(
        `seq ${seq}: the receiver's state differs from the full recording's resolved state`,
      );
  }
  const calls = (e: Gate1LegEvaluation) =>
    (e.applied?.transactions ?? []).map((t) => t.rs_calls ?? null);
  const fc = calls(receiver);
  const pc = calls(receiverPatch);
  if (fc.length === 0 || JSON.stringify(fc) !== JSON.stringify(pc)) {
    const first = fc.findIndex((v, i) => v !== pc[i]);
    problems.push(
      `per-seq rs_calls differ (${fc.length} vs ${pc.length} transactions; first difference at index ${first})`,
    );
  }
  const total = fc.reduce<number>((n, v) => n + (v ?? 0), 0);
  return check(
    "patch-vs-full-receiver-state",
    "at every settle seq the patch receiver's state dump equals the full receiver's and the full recording's resolved state, and both receivers made the same RenderingServer calls per seq (the receiver's work does not depend on encoding)",
    problems,
    `${seqs.length} state dumps equal; ${fc.length} seqs with identical rs_calls (${total} in all)`,
    evidence,
  );
}

export interface PatchBytesReport {
  full: StreamStats;
  patch: StreamStats;
  patch_transaction_bytes: {
    first: number | null;
    median: number | null;
    max: number | null;
  };
  full_transaction_bytes: { median: number | null; max: number | null };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

export function checkPatchBytes(capture: Gate1LegEvaluation): {
  check: Gate1Check;
  report: PatchBytesReport;
} {
  const fb = capture.full.transactions.map((t) => t.bytes ?? 0);
  const pb = capture.patch.transactions.map((t) => t.bytes ?? 0);
  const report: PatchBytesReport = {
    full: streamStats(capture.full),
    patch: streamStats(capture.patch),
    patch_transaction_bytes: {
      first: pb[0] ?? null,
      median: median(pb.slice(1)),
      max: pb.length > 1 ? Math.max(...pb.slice(1)) : null,
    },
    full_transaction_bytes: {
      median: median(fb),
      max: fb.length > 0 ? Math.max(...fb) : null,
    },
  };
  const problems: string[] = [];
  if (report.full.bytes_total === null || report.patch.bytes_total === null)
    problems.push("an end record is missing");
  return {
    check: check(
      "patch-bytes",
      "recorded, not gated: bytes_total, max_record_bytes, encode/snapshot/diff ns and per-transaction bytes of both sinks",
      problems,
      `full ${report.full.bytes_total} B (max record ${report.full.max_record_bytes}, encode ${report.full.encode_ns_total} ns); patch ${report.patch.bytes_total} B (max record ${report.patch.max_record_bytes}, encode ${report.patch.encode_ns_total} ns, diff ${report.patch.diff_ns_total} ns); median transaction ${report.full_transaction_bytes.median} B full vs ${report.patch_transaction_bytes.median} B patch`,
      [capture.full.path, capture.patch.path],
    ),
    report,
  };
}

// ---------------------------------------------------------------------------------------------
// Leg class
// ---------------------------------------------------------------------------------------------

/** tie-overlap's pixel measurements (gate1-design.md G1b2 "As built"): px differing between the
 * receiver's and the variant reference's shots of the tie frame and of the frame after it, and
 * between the reference's two frames; null where a shot is missing. */
export interface TieMeasurement {
  frames: number[];
  receiver_vs_reference: (number | null)[];
  reference_tie_vs_next: number | null;
  notes: string[];
}

async function measureTieOverlap(
  e: Gate1LegEvaluation,
  ties: readonly ExpectedTie[],
): Promise<TieMeasurement> {
  const out: TieMeasurement = {
    frames: [],
    receiver_vs_reference: [],
    reference_tie_vs_next: null,
    notes: [],
  };
  const refPng = (frame: number) =>
    join(e.layout.legDir, "reference", "shots", `frame-${frame}.png`);
  for (const t of ties.slice(0, 1)) {
    for (const frame of [t.frame, t.frame + 1]) {
      const seq = seqAtFrame(e.full, frame);
      const d = await pngDiff(
        refPng(frame),
        join(e.layout.receiverDir ?? "", "shots", `seq-${seq}.png`),
      );
      out.frames.push(frame);
      out.receiver_vs_reference.push(
        typeof d === "string" ? null : d.mismatched_pixels,
      );
      out.notes.push(
        typeof d === "string"
          ? `frame ${frame}: not compared (${d})`
          : `frame ${frame}: receiver vs variant reference ${d.mismatched_pixels} px differ`,
      );
    }
    const pop = await pngDiff(refPng(t.frame), refPng(t.frame + 1));
    out.reference_tie_vs_next =
      typeof pop === "string" ? null : pop.mismatched_pixels;
    out.notes.push(
      typeof pop === "string"
        ? `reference frames ${t.frame}/${t.frame + 1}: not compared (${pop})`
        : `reference frame ${t.frame} vs ${t.frame + 1}: ${pop.mismatched_pixels} px differ (the raise)`,
    );
  }
  out.notes.push("(measured, not gated)");
  return out;
}

export async function checkLegClass(
  e: Gate1LegEvaluation,
  expected: Gate1Expected,
): Promise<Gate1Check> {
  const exp = GATE1_EXPECTATIONS[e.leg];
  const c = e.classification;
  const problems: string[] = [];
  const notes: string[] = [];
  if (c.result_class !== exp.class)
    problems.push(`class ${c.result_class}, expected ${exp.class}`);
  if (exp.mismatchSteps) {
    const got = [...c.mismatching_steps].sort((a, b) => a - b);
    if (got.join(",") !== exp.mismatchSteps.join(",")) {
      problems.push(
        `mismatching steps {${got.join(",")}}, expected {${exp.mismatchSteps.join(",")}}`,
      );
    }
    if (e.checkpoints.length !== expected.steps.length)
      problems.push(
        `${e.checkpoints.length} checkpoints, expected ${expected.steps.length}`,
      );
  }
  if (
    exp.reasonIncludes &&
    !c.reasons.some((r) => r.includes(exp.reasonIncludes as string))
  ) {
    problems.push(`no reason mentions ${exp.reasonIncludes}`);
  }
  if (exp.mismatchRegions) {
    const want = [...exp.mismatchRegions].sort().join(",");
    if (e.checkpoints.length !== expected.steps.length)
      problems.push(
        `${e.checkpoints.length} checkpoints, expected ${expected.steps.length}`,
      );
    for (const cp of e.checkpoints) {
      const got = cp.regions
        .filter((r) => r.mismatched_pixels === null || r.mismatched_pixels > 0)
        .map((r) => r.name)
        .sort()
        .join(",");
      if (got !== want)
        problems.push(
          `step ${cp.step}: mismatching regions {${got}}, expected {${want}}`,
        );
      if (cp.outside_regions_mismatched_pixels !== 0) {
        problems.push(
          `step ${cp.step}: ${cp.outside_regions_mismatched_pixels ?? "?"} mismatching pixels outside every region`,
        );
      }
    }
    // The declaration must be the degenerate one it is warranted by.
    if (e.root?.host_size_status !== "degenerate-visible")
      problems.push(
        `session host_size_status ${JSON.stringify(e.root?.host_size_status)}, expected degenerate-visible`,
      );
    if (!f32eq(e.root?.host_visible_rect ?? [], [0, 0, 64, 64]))
      problems.push(
        `session host_visible_rect ${JSON.stringify(e.root?.host_visible_rect)}, expected [0,0,64,64]`,
      );
  }
  if (e.leg === "tie-overlap") {
    // Exactly the fixture's declared ties, at the same frames; RS_FIXTURE_TIE=overlap only
    // widens step 1's T, so only step 1's tie flips to overlapping (not harmless) -- every other
    // declared tie (G1e's step 11/12 additions) is unaffected and keeps its usual harmlessness.
    // Plus the measured (not gated) comparison of the tie frame with the variant's own reference.
    const names = mapNames(expected, statesOf(e.full));
    const ties = recordingTies(e.full);
    const declared = expected.draw_index_ties ?? [];
    const want = expectedTies(expected, names).map((t, i) => ({
      ...t,
      harmless: declared[i]?.step === 1 ? false : t.harmless,
    }));
    const got = ties.map((t) => ({
      frame: t.frame,
      container: t.container,
      members: t.members,
      harmless: t.harmless,
    }));
    if (JSON.stringify(got) !== JSON.stringify(want))
      problems.push(
        `ties ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
      );
    // Measured, not gated: the tie frame and the next one (after the raise), receiver against the
    // variant's own reference, and the reference's two frames against each other (the one-frame
    // "pop" of the raised item).
    const tieOverlap = await measureTieOverlap(e, want);
    e.tieMeasurement = tieOverlap;
    notes.push(...tieOverlap.notes);
  }
  const regionsNote = exp.mismatchRegions
    ? ` mismatching only in {${exp.mismatchRegions.join(",")}} at every step`
    : "";
  return check(
    `leg-class-${e.leg}`,
    `the ${e.leg} leg classifies as ${exp.class}${exp.mismatchSteps ? ` with mismatching steps exactly {${exp.mismatchSteps.join(",")}}` : ""}${exp.reasonIncludes ? ` with a ${exp.reasonIncludes} reason` : ""}${regionsNote}${e.leg === "tie-overlap" ? ", its only tie being the fixture's step-1 tie, overlapping" : ""}`,
    problems,
    `${c.result_class}${c.mismatching_steps.length > 0 ? ` steps {${c.mismatching_steps.join(",")}}` : ""}${c.reasons.length > 0 ? ` (${c.reasons.slice(0, 2).join(" | ")})` : ""}${c.harmless_ties.length > 0 ? `; harmless ties ${c.harmless_ties.join(",")}` : ""}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`,
    e.artifacts,
  );
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export interface StreamStats {
  transactions: number | null;
  bytes_total: number | null;
  encode_ns_total: number | null;
  snapshot_ns_total: number | null;
  diff_ns_total: number | null;
  max_record_bytes: number | null;
  full_transactions: number | null;
  patch_transactions: number | null;
}

export function streamStats(recording: RecordingSummary): StreamStats {
  const stats = recording.end?.stats;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    transactions: num(recording.end?.transactions),
    bytes_total: num(stats?.bytes_total),
    encode_ns_total: num(stats?.encode_ns_total),
    snapshot_ns_total: num(stats?.snapshot_ns_total),
    diff_ns_total: num(stats?.diff_ns_total),
    max_record_bytes: num(stats?.max_record_bytes),
    full_transactions: num(stats?.full_transactions),
    patch_transactions: num(stats?.patch_transactions),
  };
}

export interface Gate1Report {
  schema: "render-stream-gate1-report/1";
  generated_at: string;
  binary: { path: string | null; sha256: string | null };
  gate_passed: boolean;
  groups: { run: string[]; landed: string[]; not_run: string[] };
  legs: Record<
    string,
    {
      group: string;
      expected_class: Gate1Class | null;
      result_class: Gate1Class | null;
      reasons: string[];
      harmless_ties?: string[];
      exit_code: number | null;
      artifacts: string[];
    }
  >;
  checks: Gate1Check[];
  checkpoints: Gate1Checkpoint[];
  stream: { full: StreamStats; patch: StreamStats | null };
  patch_bytes: PatchBytesReport | null;
  ties: {
    capture: DrawIndexTie[];
    tie_overlap: DrawIndexTie[];
    tie_overlap_pixels: TieMeasurement | null;
  } | null;
  /** g1c: per live leg, the host's connection summaries, the recomputed delivery report and the
   * receiver's stage counts (null when g1c did not run) */
  live: Record<string, LiveLegReport> | null;
  /** g1d: per leg, the same per connection plus the stall, reconnect and resync evidence
   * (null when g1d did not run) */
  g1d: Record<string, G1dLegReport> | null;
  root_geometry: RootGeometryReport | null;
}

export interface Gate1Context {
  expected: Gate1Expected;
  receiverProjectDir: string;
  fixtureProjectDir: string;
  now?: Date;
}

/** Receiver-side logs of a run, for receiver-never-loaded-fixture (missing ones are skipped). */
export function gate1ReceiverLogPaths(outDir: string): string[] {
  return [
    join(outDir, "receiver", "stdout.log"),
    join(outDir, "receiver-headless-trace", "stdout.log"),
    join(outDir, "receiver-patch", "stdout.log"),
    ...[...G1A_CLASSIFIED_LEGS, ...G1B_CLASSIFIED_LEGS]
      .filter(
        (l) => l !== "capture" && l !== "receiver" && l !== "receiver-patch",
      )
      .map((l) => join(outDir, l, "receiver", "stdout.log")),
    join(outDir, "receiver-typecheck", "selftest", "stdout.log"),
    join(outDir, "receiver-typecheck", "minimal", "stdout.log"),
    // g1c (G1c2)
    join(outDir, "live", "receiver", "stdout.log"),
    join(outDir, "live-replay", "stdout.log"),
    join(outDir, "live-headless", "receiver", "stdout.log"),
    join(outDir, "sabotage-drop-message", "receiver", "stdout.log"),
    // g1d (G1d)
    ...[...G1D_CLASSIFIED_LEGS, ...G1D_SUPPORT_LEGS].map((l) =>
      join(outDir, l, "receiver", "stdout.log"),
    ),
  ];
}

async function supportLeg(
  outDir: string,
  leg: (typeof G1A_SUPPORT_LEGS)[number],
) {
  const legDir = join(outDir, leg);
  const dirs =
    leg === "import"
      ? [join(legDir, "fixture"), join(legDir, "receiver")]
      : leg === "receiver-typecheck"
        ? [join(legDir, "selftest"), join(legDir, "minimal")]
        : [legDir];
  const codes = await Promise.all(dirs.map(readExitCode));
  const known = codes.filter((c): c is number => c !== null);
  return {
    group: "g1a",
    expected_class: null,
    result_class: null,
    reasons: [] as string[],
    exit_code: known.length === 0 ? null : (known.find((c) => c !== 0) ?? 0),
    artifacts: await existing(
      dirs.flatMap((dir) => [
        join(dir, "argv.txt"),
        join(dir, "env.txt"),
        join(dir, "stdout.log"),
        join(dir, "exit-code.txt"),
        join(dir, "applied.json"),
        join(dir, "steps.jsonl"),
        join(dir, "root.jsonl"),
        join(dir, "strace.txt"),
      ]),
    ),
  };
}

export async function readGroups(
  outDir: string,
): Promise<{ run: string[]; landed: string[] }> {
  const legs = await readJson<{
    groups_run?: string[];
    groups_landed?: string[];
  }>(join(outDir, "legs.json"));
  return { run: legs?.groups_run ?? [], landed: [...LANDED_GROUPS] };
}

function notRunCheck(group: string, detail: string): Gate1Check {
  return {
    id: `group-${group}`,
    criterion: `leg group ${group} ran`,
    passed: false,
    status: "not-run",
    detail,
    evidence: [],
  };
}

export async function runGate1(
  outDir: string,
  ctx: Gate1Context,
): Promise<Gate1Report> {
  const groups = await readGroups(outDir);
  const notRun = groups.landed.filter((g) => !groups.run.includes(g));
  const checks: Gate1Check[] = [];
  const legs: Gate1Report["legs"] = {};
  let checkpoints: Gate1Checkpoint[] = [];
  let rootGeometry: RootGeometryReport | null = null;
  let stream: Gate1Report["stream"] = {
    full: streamStats({
      path: "",
      present: false,
      sha256: null,
      bytes: 0,
      errors: [],
      transactions: [],
    }),
    patch: null,
  };
  let patchBytes: PatchBytesReport | null = null;
  let ties: Gate1Report["ties"] = null;
  const evaluations = new Map<Gate1Leg, Gate1LegEvaluation>();
  const record = (e: Gate1LegEvaluation): void => {
    legs[e.leg] = {
      group: legGroup(e.leg),
      expected_class: e.expected_class,
      result_class: e.classification.result_class,
      reasons: e.classification.reasons,
      harmless_ties: e.classification.harmless_ties,
      exit_code: e.exit_code,
      artifacts: e.artifacts,
    };
    checkpoints = checkpoints.concat(e.checkpoints);
  };

  checks.push(checkExpectedSelfConsistent(ctx.expected));
  if (groups.run.includes("g1a")) {
    for (const leg of G1A_CLASSIFIED_LEGS) {
      evaluations.set(leg, await evaluateGate1Leg(outDir, leg, ctx.expected));
    }
    const capture = evaluations.get("capture") as Gate1LegEvaluation;
    const receiver = evaluations.get("receiver") as Gate1LegEvaluation;
    const states = statesOf(capture.full);
    const rg = await checkRootGeometry(
      outDir,
      ctx.expected,
      capture,
      evaluations.get("root-size-observe"),
    );
    rootGeometry = rg.report;
    const asGate0 = (e: Gate1LegEvaluation) => e as unknown as LegEvaluation;
    checks.push(
      fromGate0(await checkCaptureArmed(outDir, capture)),
      fromGate0(await checkHeadlessNoGpuGate0(outDir)),
      fromGate0(checkRecordingDecodes(capture.full)),
      fromGate0(checkManifestPresent(capture.full)),
      await checkStepAlignment(outDir, ctx.expected, capture.full),
      await checkExpectedImageReference(outDir, ctx.expected),
      await checkExpectedImageReceiver(receiver, ctx.expected),
      checkReceiverVsReference(receiver, ctx.expected),
      checkRetainedInvariants(ctx.expected, states, capture.full.path),
      rg.check,
      fromGate0(checkReceiverConsumedStream(asGate0(receiver))),
      fromGate0(
        await checkReceiverNeverLoadedFixture(outDir, {
          receiverProjectDir: ctx.receiverProjectDir,
          fixtureProjectDir: ctx.fixtureProjectDir,
          receiverLogs: gate1ReceiverLogPaths(outDir),
        }),
        "the headless receiver trace opens its recording and nothing under fixtures/; no receiver file is byte-identical to a fixtures/gate1 file; no receiver log has a [fixture] line; argv passes --path <abs receiver>",
      ),
      fromGate0(await checkReceiverTypedClean(outDir)),
    );
    for (const leg of G1A_CLASSIFIED_LEGS) {
      const e = evaluations.get(leg) as Gate1LegEvaluation;
      checks.push(await checkLegClass(e, ctx.expected));
      record(e);
    }
    for (const leg of G1A_SUPPORT_LEGS)
      legs[leg] = await supportLeg(outDir, leg);
    stream = {
      full: streamStats(capture.full),
      patch: streamStats(capture.patch),
    };
  } else {
    checks.push(
      notRunCheck("g1a", "g1a was not in --legs; its checks are not-run"),
    );
  }

  if (groups.run.includes("g1b")) {
    const capture = evaluations.get("capture");
    const receiver = evaluations.get("receiver");
    if (!capture || !receiver) {
      checks.push({
        ...notRunCheck(
          "g1b",
          "g1b compares against g1a's capture, reference and receiver; run it with g1a",
        ),
        status: "fail",
      });
    } else {
      for (const leg of G1B_CLASSIFIED_LEGS) {
        evaluations.set(leg, await evaluateGate1Leg(outDir, leg, ctx.expected));
      }
      const receiverPatch = evaluations.get(
        "receiver-patch",
      ) as Gate1LegEvaluation;
      const bytes = checkPatchBytes(capture);
      patchBytes = bytes.report;
      checks.push(
        checkPatchResolvesToFull(capture),
        checkPatchFirstFull(capture),
        checkPatchTransformOnly(ctx.expected, capture),
        await checkPatchVsFullPixels(receiver, receiverPatch, ctx.expected),
        await checkPatchVsFullReceiverState(receiver, receiverPatch, capture),
        bytes.check,
        checkDrawIndexTies(ctx.expected, capture),
        await checkTieFramePixels(outDir, ctx.expected, capture),
      );
      for (const leg of G1B_CLASSIFIED_LEGS) {
        const e = evaluations.get(leg) as Gate1LegEvaluation;
        checks.push(await checkLegClass(e, ctx.expected));
        record(e);
      }
      const overlap = evaluations.get("tie-overlap") as Gate1LegEvaluation;
      ties = {
        capture: recordingTies(capture.full),
        tie_overlap: recordingTies(overlap.full),
        tie_overlap_pixels: overlap.tieMeasurement ?? null,
      };
    }
  } else {
    checks.push(
      notRunCheck("g1b", "g1b was not in --legs; its checks are not-run"),
    );
  }

  let live: Gate1Report["live"] = null;
  if (groups.run.includes("g1c")) {
    if (!evaluations.get("capture")) {
      checks.push({
        ...notRunCheck(
          "g1c",
          "g1c compares against g1a's reference; run it with g1a",
        ),
        status: "fail",
      });
    } else {
      const hosts = new Map<LiveHostLeg, LiveHostEvidence>();
      const liveEvals = new Map<G1cLeg, LiveLegEvaluation>();
      for (const leg of G1C_CLASSIFIED_LEGS)
        liveEvals.set(
          leg,
          await evaluateLiveLeg(outDir, leg, ctx.expected, hosts),
        );
      checks.push(
        await checkLiveListening(liveEvals),
        await checkLiveHandshake(liveEvals),
        checkLiveTapEqualsReceived(liveEvals),
        checkLiveDecodes(liveEvals),
        checkLiveFirstFullThenPatch(liveEvals),
        checkLiveResolvesToRecording(liveEvals),
        await checkLiveReplayEqualsLive(liveEvals),
        await checkLiveVsReference(liveEvals, ctx.expected),
        checkLiveCreditBounded(liveEvals),
        checkLiveAcksStaged(liveEvals),
        checkLiveReceiverLate(liveEvals),
        await checkLiveReceiverNeverLoadedFixture(outDir, liveEvals, {
          receiverProjectDir: ctx.receiverProjectDir,
          fixtureProjectDir: ctx.fixtureProjectDir,
        }),
      );
      live = {};
      for (const leg of G1C_CLASSIFIED_LEGS) {
        const e = liveEvals.get(leg) as LiveLegEvaluation;
        checks.push(await checkLiveLegClass(e));
        legs[leg] = {
          group: "g1c",
          expected_class: e.expected_class,
          result_class: e.classification.result_class,
          reasons: e.classification.reasons,
          harmless_ties: e.classification.harmless_ties,
          exit_code: e.exit_code,
          artifacts: e.artifacts,
        };
        checkpoints = checkpoints.concat(e.checkpoints);
        live[leg] = liveLegReport(e);
      }
    }
  } else {
    checks.push(
      notRunCheck("g1c", "g1c was not in --legs; its checks are not-run"),
    );
  }

  let g1d: Gate1Report["g1d"] = null;
  if (groups.run.includes("g1d")) {
    if (!evaluations.get("capture")) {
      checks.push({
        ...notRunCheck(
          "g1d",
          "g1d compares against g1a's reference; run it with g1a",
        ),
        status: "fail",
      });
    } else {
      const g1dEvals = new Map<G1dLeg, G1dLegEvaluation>();
      for (const leg of G1D_CLASSIFIED_LEGS)
        g1dEvals.set(leg, await evaluateG1dLeg(outDir, leg, ctx.expected));
      const killed = await loadKilled(outDir);
      checks.push(
        checkStallObserved(g1dEvals),
        checkSimKeptRunning(g1dEvals),
        checkPendingBounded(g1dEvals),
        checkCoalesced(g1dEvals),
        checkNewestAfterStall(g1dEvals),
        await checkStallPixels(g1dEvals, ctx.expected),
        checkReconnectFreshSession(g1dEvals),
        checkReconnectCleanSlate(g1dEvals),
        checkResyncFull(g1dEvals),
        checkHostSurvivesReceiverLoss(killed),
      );
      g1d = {};
      for (const leg of G1D_CLASSIFIED_LEGS) {
        const e = g1dEvals.get(leg) as G1dLegEvaluation;
        checks.push(checkG1dLegClass(e));
        legs[leg] = {
          group: "g1d",
          expected_class: e.expected_class,
          result_class: e.classification.result_class,
          reasons: e.classification.reasons,
          harmless_ties: e.classification.harmless_ties,
          exit_code: e.exit_code,
          artifacts: e.artifacts,
        };
        checkpoints = checkpoints.concat(e.checkpoints);
        g1d[leg] = g1dLegReport(e);
      }
      legs["live-receiver-killed"] = {
        group: "g1d",
        expected_class: null,
        result_class: null,
        reasons: [],
        exit_code: killed.host_exit,
        artifacts: await existing([
          join(killed.dir, "host", "stdout.log"),
          join(killed.dir, "host", "exit-code.txt"),
          join(killed.dir, "host", "evidence", "live-summary.json"),
          join(killed.dir, "host", RECORDING_NAME),
          join(killed.dir, "host", PATCH_RECORDING_NAME),
          join(killed.dir, "host", "tap", "live-1.jsonl"),
          join(killed.dir, "receiver", "killed.json"),
          join(killed.dir, "receiver", "stdout.log"),
        ]),
      };
    }
  } else {
    checks.push(
      notRunCheck("g1d", "g1d was not in --legs; its checks are not-run"),
    );
  }

  const binary = await readJson<{ path?: string; sha256?: string }>(
    join(outDir, "binary.json"),
  );
  return {
    schema: "render-stream-gate1-report/1",
    generated_at: (ctx.now ?? new Date()).toISOString(),
    binary: { path: binary?.path ?? null, sha256: binary?.sha256 ?? null },
    gate_passed: notRun.length === 0 && checks.every((c) => c.passed),
    groups: { run: groups.run, landed: groups.landed, not_run: notRun },
    legs,
    checks,
    checkpoints,
    stream,
    patch_bytes: patchBytes,
    ties,
    live,
    g1d,
    root_geometry: rootGeometry,
  };
}
