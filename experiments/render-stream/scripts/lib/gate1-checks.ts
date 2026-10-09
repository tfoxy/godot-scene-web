// Gate 1 checks and leg classification (protocol/gate1-design.md "Q7" and "G1a").
//
// Everything here reads an evidence directory written by run-gate1.sh, or is pure over values
// already read from one, so scripts/test/self-test-gate1.ts can drive it with fabricated trees.
// Nothing launches a process. Classification never reads `session.sabotage`.
//
// G1a runs on render-stream/0, so the root geometry a host declares is read from its capture
// evidence (`evidence/root.json`, render-stream-root-geometry/1) until G1b2 moves it into the
// /1 session.
//
// Evidence layout under <out>/ (group g1a; see scripts/README.md "Gate 1"):
//   legs.json                     {"groups_run":[...],"groups_landed":[...]}
//   capture/                      400-frame capture host, GRC_ROOT_SIZE=enforce-min-size:
//                                 evidence/ (root.json), recording.rs0, steps.jsonl, root.jsonl,
//                                 strace.txt, maps.txt, fd.txt
//   reference/                    rendered fixture, extension absent: shots/step-<k>.png,
//                                 steps.jsonl, root.jsonl
//   receiver/                     rendered receiver on capture/recording.rs0: shots/seq-<n>.png,
//                                 diff/step-<k>.png, applied.json
//   receiver-headless-trace/      headless receiver under strace
//   sabotage-omit-{modulate,transform,order,visibility}/{capture,receiver}/
//   root-size-observe/{capture,receiver}/   GRC_ROOT_SIZE unset (capture writes root.jsonl too)
//   import/{fixture,receiver}/, receiver-typecheck/{selftest,minimal}/

import { mkdir, readdir, readFile } from "node:fs/promises";
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
  diffRgba,
  firstTransactionWithRectColor,
  type Gate0Check,
  joinSettleSeqs,
  type LegEvaluation,
  loadRecording,
  parseStepLog,
  type RecordingSummary,
  readExitCode,
  type StepJoin,
  type StepLine,
} from "./gate0-checks";
import {
  type Gate1Expected,
  gate1Names,
  stepFrames,
  synthesizeGate1,
} from "./gate1-expected";
import { decodeRecord, splitRecords } from "./render-stream-0";

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
export const LANDED_GROUPS: readonly string[] = ["g1a"];

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
 * "Gate 1a result"). */
export const G1A_EXPECTATIONS: Record<G1aLeg, Gate1LegExpectation> = {
  capture: { class: "success" },
  receiver: { class: "success" },
  "sabotage-omit-modulate": {
    class: "pixel-mismatch",
    mismatchSteps: range(1, 10),
  },
  "sabotage-omit-transform": {
    class: "pixel-mismatch",
    mismatchSteps: range(2, 10),
  },
  "sabotage-omit-order": { class: "pixel-mismatch", mismatchSteps: [3] },
  "sabotage-omit-visibility": {
    class: "pixel-mismatch",
    mismatchSteps: range(7, 10),
  },
  "root-size-observe": {
    class: "unsupported",
    reasonIncludes: "degenerate-host-size",
    mismatchRegions: ["corner", "corner-degenerate"],
  },
};

export interface Gate1LegLayout {
  legDir: string;
  captureDir: string;
  receiverDir?: string;
  shots: boolean;
}

export function gate1LegLayout(outDir: string, leg: G1aLeg): Gate1LegLayout {
  const legDir = join(outDir, leg);
  switch (leg) {
    case "capture":
      return { legDir, captureDir: legDir, shots: false };
    case "receiver":
      return {
        legDir,
        captureDir: join(outDir, "capture"),
        receiverDir: legDir,
        shots: true,
      };
    default:
      return {
        legDir,
        captureDir: join(legDir, "capture"),
        receiverDir: join(legDir, "receiver"),
        shots: true,
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

/** evidence/root.json (render-stream-root-geometry/1). */
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
// Full per-transaction state (summarizeRecording keeps only ids and commands)
// ---------------------------------------------------------------------------------------------

export interface WireParent {
  kind: "canvas" | "item";
  id: number;
}

export interface ItemFull {
  id: number;
  parent: WireParent | null;
  children: number[];
  visible: boolean;
  draw_index: number;
  z_index: number;
  visibility_layer: number;
  content_version: number;
  xform: number[];
  modulate: number[];
  self_modulate: number[];
  /** add_rect: rect + colour (float32 values); unsupported: name */
  commands: { op: string; rect?: number[]; color?: number[]; name?: string }[];
}

export interface CanvasFull {
  id: number;
  items: number[];
  xform: number[];
}

export interface TxState {
  seq: number;
  frame: number;
  items: Map<number, ItemFull>;
  canvases: Map<number, CanvasFull>;
}

const ITEM_FLOATS = 18;
const CANVAS_FLOATS = 6;

/** Every transaction's full state, in record order. Records that do not decode are skipped
 * (recording-decodes reports them). */
export function decodeStates(data: Uint8Array | undefined): TxState[] {
  if (!data) return [];
  const out: TxState[] = [];
  const split = splitRecords(data);
  for (const raw of split.records) {
    const { record } = decodeRecord(raw);
    if (!record) continue;
    const meta = record.meta as unknown as Record<string, unknown>;
    if (meta.type !== "transaction") continue;
    const names = (meta.blocks as { name: string }[]).map((b) => b.name);
    const block = (name: string, fallback: number): number[] =>
      record.blocks[
        names.indexOf(name) >= 0 ? names.indexOf(name) : fallback
      ] ?? [];
    const itemF = block("item_f32", 0);
    const canvasF = block("canvas_f32", 1);
    const cmdF = block("cmd_f32", 2);
    const items = new Map<number, ItemFull>();
    (meta.items as Record<string, unknown>[]).forEach((it, i) => {
      const f = itemF.slice(ITEM_FLOATS * i, ITEM_FLOATS * (i + 1));
      items.set(Number(it.id), {
        id: Number(it.id),
        parent: (it.parent as WireParent | null) ?? null,
        children: (it.children as number[]) ?? [],
        visible: it.visible === true,
        draw_index: Number(it.draw_index),
        z_index: Number(it.z_index),
        visibility_layer: Number(it.visibility_layer),
        content_version: Number(it.content_version),
        xform: f.slice(0, 6),
        modulate: f.slice(6, 10),
        self_modulate: f.slice(10, 14),
        commands: ((it.commands as Record<string, unknown>[]) ?? []).map((c) =>
          c.op === "add_rect"
            ? {
                op: "add_rect",
                rect: cmdF.slice(Number(c.f), Number(c.f) + 4),
                color: cmdF.slice(Number(c.f) + 4, Number(c.f) + 8),
              }
            : { op: String(c.op), name: String(c.name) },
        ),
      });
    });
    const canvases = new Map<number, CanvasFull>();
    (meta.canvases as Record<string, unknown>[]).forEach((cv, i) => {
      canvases.set(Number(cv.id), {
        id: Number(cv.id),
        items: (cv.items as number[]) ?? [],
        xform: canvasF.slice(CANVAS_FLOATS * i, CANVAS_FLOATS * (i + 1)),
      });
    });
    out.push({
      seq: Number(meta.seq),
      frame: Number(meta.frame),
      items,
      canvases,
    });
  }
  return out;
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
  parent: WireParent | null,
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

/** Containers with two drawing children (a command anywhere in the subtree) at one draw_index. */
export function findDrawIndexTies(states: readonly TxState[]): string[] {
  const out: string[] = [];
  for (const s of states) {
    const draws = new Map<number, boolean>();
    const drawing = (id: number, depth = 0): boolean => {
      const cached = draws.get(id);
      if (cached !== undefined) return cached;
      const it = s.items.get(id);
      const value =
        it !== undefined &&
        depth < 64 &&
        (it.commands.length > 0 ||
          it.children.some((c) => drawing(c, depth + 1)));
      draws.set(id, value);
      return value;
    };
    const lists: [string, number[]][] = [
      ...[...s.canvases.values()].map(
        (c) => [`canvas ${c.id}`, c.items] as [string, number[]],
      ),
      ...[...s.items.values()].map(
        (i) => [`item ${i.id}`, i.children] as [string, number[]],
      ),
    ];
    for (const [label, list] of lists) {
      const seen = new Map<number, number>();
      for (const child of list) {
        if (!drawing(child)) continue;
        const index = s.items.get(child)?.draw_index ?? 0;
        const other = seen.get(index);
        if (other !== undefined) {
          out.push(
            `seq ${s.seq} frame ${s.frame}: ${label} children ${other} and ${child} share draw_index ${index}`,
          );
        } else {
          seen.set(index, child);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// classifyGate1 (pure): gate 0's rules plus the root-size evidence
// ---------------------------------------------------------------------------------------------

export interface Gate1Classification {
  result_class: Gate1Class;
  reasons: string[];
  mismatching_steps: number[];
}

/** Gate 0's classifyLeg plus G1a's extra rules: a missing root.json or a failed enforcement is
 * capture-failure; a declared non-match host size under `observe` is unsupported
 * (`degenerate-host-size`). */
export function classifyGate1(
  base: Classification,
  root: RootEvidence | undefined,
): Gate1Classification {
  const reasons = [...base.reasons];
  if (!root) {
    reasons.push("capture-failure: evidence/root.json missing or unparseable");
  } else {
    if (root.enforce?.called === true && root.enforce.ok !== true) {
      reasons.push(
        `capture-failure: root-size-enforce-failed (${root.enforce.detail ?? root.host_size_status ?? "?"})`,
      );
    }
    if (root.host_size_status !== "match" && root.enforce?.called !== true) {
      reasons.push(
        `unsupported: degenerate-host-size (host_size_status ${JSON.stringify(root.host_size_status ?? null)}, visible ${JSON.stringify(root.after?.visible_rect ?? null)}, logical ${JSON.stringify(root.logical_size ?? null)})`,
      );
    }
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
  };
}

// ---------------------------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------------------------

export interface Gate1Checkpoint extends Checkpoint {
  leg: string;
  stream: "full";
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
  join_: StepJoin,
  referenceShotsDir: string,
  receiverShotsDir: string,
  diffDir: string,
  expected: Gate1Expected,
): Promise<{ checkpoints: Gate1Checkpoint[]; compareOk: boolean }> {
  const checkpoints: Gate1Checkpoint[] = [];
  let compareOk = true;
  const regionList = Object.entries(expected.regions);
  for (const entry of join_.entries) {
    const referencePng = join(referenceShotsDir, `step-${entry.step}.png`);
    const receiverPng =
      entry.seq === null
        ? null
        : join(receiverShotsDir, `seq-${entry.seq}.png`);
    const ref = await decodePngRgba(referencePng);
    const got = receiverPng ? await decodePngRgba(receiverPng) : undefined;
    const base = {
      leg,
      stream: "full" as const,
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
  leg: G1aLeg;
  layout: Gate1LegLayout;
  expected_class: Gate1Class;
  classification: Gate1Classification;
  exit_code: number | null;
  artifacts: string[];
  recording: RecordingSummary;
  captureResult: CaptureResultJson | undefined;
  root: RootEvidence | undefined;
  stepJoin?: StepJoin;
  applied?: AppliedJson;
  checkpoints: Gate1Checkpoint[];
  compareOk: boolean;
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
  leg: G1aLeg,
  expected: Gate1Expected,
): Promise<Gate1LegEvaluation> {
  const layout = gate1LegLayout(outDir, leg);
  const captureResult = await readJson<CaptureResultJson>(
    join(layout.captureDir, "evidence", "result.json"),
  );
  const root = await readJson<RootEvidence>(
    join(layout.captureDir, "evidence", "root.json"),
  );
  const recording = await loadRecording(
    join(layout.captureDir, "recording.rs0"),
  );
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
  const classification = classifyGate1(base, root);
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
      join(dir, "recording.rs0"),
      join(dir, "steps.jsonl"),
      join(dir, "root.jsonl"),
      join(dir, "applied.json"),
      join(dir, "strace.txt"),
    ]),
  );
  return {
    leg,
    layout,
    expected_class: G1A_EXPECTATIONS[leg].class,
    classification,
    exit_code: await readExitCode(layout.receiverDir ?? layout.captureDir),
    artifacts: [...new Set(artifacts)],
    recording,
    captureResult,
    root,
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

function check(
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
  if (expected.quit_frame_default !== S + N * 10 + 11) {
    problems.push(
      `quit_frame_default ${expected.quit_frame_default} != S+N*10+11 = ${S + N * 10 + 11}`,
    );
  }
  const steps = expected.steps ?? [];
  if (steps.map((s) => s.step).join(",") !== range(0, 10).join(",")) {
    problems.push(
      `steps are ${steps.map((s) => s.step).join(",")}, expected 0..10`,
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
    "expected.json obeys its rules: 640x360, steps 0..10, every draw colour in {0,51,..,255} with alpha 255, every draw inside a region and none in [0,0,72,72], one distinct marker colour per step used by nothing else, known names, step 10 = step 9 shifted",
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
    "capture and reference steps.jsonl list steps 0..10 at S+N*k (settle +7), and each step's marker colour first appears in the transaction of its applied frame",
    problems,
    `marker colours first published at ${firsts.join(", ")}`,
    [capturePath, referencePath, recording.path],
  );
}

async function compareWithSynth(
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
    "each reference/shots/step-<k>.png (k = 0..10) equals synthesizeGate1(k) exactly",
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
    "receiver shots equal the reference shots at all 11 steps: full frame and every expected.json region, 0 mismatched pixels and max channel delta 0",
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

export function checkNoDrawIndexTies(
  states: readonly TxState[],
  recordingPath: string,
): Gate1Check {
  const ties = findDrawIndexTies(states);
  const problems =
    ties.length > 0
      ? [`${ties.length} ties; first: ${ties.slice(0, 3).join(" | ")}`]
      : [];
  if (states.length === 0) problems.push("no transactions decoded");
  return check(
    "no-draw-index-ties",
    "no container (canvas or item) has two drawing children with equal draw_index in any transaction of the capture recording",
    problems,
    `${states.length} transactions, no ties`,
    [recordingPath],
  );
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

export interface RootGeometryReport {
  host: RootEvidence | null;
  observe: RootEvidence | null;
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
  captureStates: readonly TxState[],
): Promise<{ check: Gate1Check; report: RootGeometryReport }> {
  const rootPath = join(outDir, "capture", "evidence", "root.json");
  const observePath = join(
    outDir,
    "root-size-observe",
    "capture",
    "evidence",
    "root.json",
  );
  const hostLogPath = join(outDir, "capture", "root.jsonl");
  const refLogPath = join(outDir, "reference", "root.jsonl");
  const host = await readJson<RootEvidence>(rootPath);
  const observe = await readJson<RootEvidence>(observePath);
  const hostLog = parseRootLog(await readTextOrUndefined(hostLogPath));
  const refLog = parseRootLog(await readTextOrUndefined(refLogPath));
  const problems: string[] = [];
  const [vw, vh] = expected.viewport;
  // 1. The declared logical size equals the reference's content scale size, visible size and
  //    window size (640x360).
  if (!host) problems.push("capture evidence/root.json missing");
  if (!refLog) problems.push("reference root.jsonl missing or unparseable");
  const logical = host?.logical_size ?? [];
  if (logical[0] !== vw || logical[1] !== vh)
    problems.push(
      `host logical_size ${JSON.stringify(logical)} != ${vw}x${vh}`,
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
          `reference step ${line.step} ${key} ${JSON.stringify(value)} != host logical ${JSON.stringify(logical)}`,
        );
      }
    }
  }
  // 2. Under enforce-min-size: match, 0,0,640,360, identity final transform, and the host's own
  //    root.jsonl equal to the reference's line for line except display_server.
  if (host) {
    if (host.policy !== "enforce-min-size")
      problems.push(`capture policy ${JSON.stringify(host.policy)}`);
    if (host.host_size_status !== "match")
      problems.push(
        `capture host_size_status ${JSON.stringify(host.host_size_status)}`,
      );
    if (
      JSON.stringify(host.after?.visible_rect) !==
      JSON.stringify([0, 0, vw, vh])
    )
      problems.push(
        `capture after.visible_rect ${JSON.stringify(host.after?.visible_rect)}`,
      );
    if (!f32eq(host.after?.final_transform ?? [], IDENTITY))
      problems.push(
        `capture after.final_transform ${JSON.stringify(host.after?.final_transform)}`,
      );
    if (host.enforce?.called !== true || host.enforce.ok !== true)
      problems.push(`capture enforce ${JSON.stringify(host.enforce)}`);
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
  const perStep: RootGeometryReport["per_step"] = [];
  for (const s of expected.steps) {
    const tx = stateAtFrame(captureStates, stepFrames(expected, s.step).settle);
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
  return {
    check: check(
      "root-geometry",
      "the host's declared logical size equals the reference's content scale size, visible size and window size; under enforce-min-size the host matches (0,0,640,360, identity final transform) and its root.jsonl equals the reference's except display_server; canvas 1's transform at every settle transaction equals the reference's (float32)",
      problems,
      `logical ${logical.join("x")}; host ${host?.before?.window_size?.join("x") ?? "?"} -> ${host?.after?.window_size?.join("x") ?? "?"} (${host?.host_size_status ?? "?"}); ${perStep.filter((p) => p.equal).length}/${perStep.length} canvas transforms equal`,
      [rootPath, hostLogPath, refLogPath, observePath],
    ),
    report: {
      host: host ?? null,
      observe: observe ?? null,
      reference_line: refLog?.[0] ?? null,
      status: host?.host_size_status ?? null,
      per_step: perStep,
    },
  };
}

export function checkLegClass(e: Gate1LegEvaluation): Gate1Check {
  const exp = G1A_EXPECTATIONS[e.leg];
  const c = e.classification;
  const problems: string[] = [];
  if (c.result_class !== exp.class)
    problems.push(`class ${c.result_class}, expected ${exp.class}`);
  if (exp.mismatchSteps) {
    const got = [...c.mismatching_steps].sort((a, b) => a - b);
    if (got.join(",") !== exp.mismatchSteps.join(",")) {
      problems.push(
        `mismatching steps {${got.join(",")}}, expected {${exp.mismatchSteps.join(",")}}`,
      );
    }
    if (e.checkpoints.length !== 11)
      problems.push(`${e.checkpoints.length} checkpoints, expected 11`);
  }
  if (
    exp.reasonIncludes &&
    !c.reasons.some((r) => r.includes(exp.reasonIncludes as string))
  ) {
    problems.push(`no reason mentions ${exp.reasonIncludes}`);
  }
  if (exp.mismatchRegions) {
    const want = [...exp.mismatchRegions].sort().join(",");
    if (e.checkpoints.length !== 11)
      problems.push(`${e.checkpoints.length} checkpoints, expected 11`);
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
        `host_size_status ${JSON.stringify(e.root?.host_size_status)}, expected degenerate-visible`,
      );
    if (
      JSON.stringify(e.root?.after?.visible_rect) !==
      JSON.stringify([0, 0, 64, 64])
    )
      problems.push(
        `visible_rect ${JSON.stringify(e.root?.after?.visible_rect)}, expected [0,0,64,64]`,
      );
  }
  const regionsNote = exp.mismatchRegions
    ? ` mismatching only in {${exp.mismatchRegions.join(",")}} at every step`
    : "";
  return check(
    `leg-class-${e.leg}`,
    `the ${e.leg} leg classifies as ${exp.class}${exp.mismatchSteps ? ` with mismatching steps exactly {${exp.mismatchSteps.join(",")}}` : ""}${exp.reasonIncludes ? ` with a ${exp.reasonIncludes} reason` : ""}${regionsNote}`,
    problems,
    `${c.result_class}${c.mismatching_steps.length > 0 ? ` steps {${c.mismatching_steps.join(",")}}` : ""}${c.reasons.length > 0 ? ` (${c.reasons.slice(0, 2).join(" | ")})` : ""}`,
    e.artifacts,
  );
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

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
      exit_code: number | null;
      artifacts: string[];
    }
  >;
  checks: Gate1Check[];
  checkpoints: Gate1Checkpoint[];
  stream: {
    full: {
      transactions: number | null;
      bytes_total: number | null;
      encode_ns_total: number | null;
      snapshot_ns_total: number | null;
      max_record_bytes: number | null;
    };
  };
  live: null;
  root_geometry: RootGeometryReport | null;
}

export interface Gate1Context {
  expected: Gate1Expected;
  receiverProjectDir: string;
  fixtureProjectDir: string;
  now?: Date;
}

/** Receiver-side logs of a g1a run, for receiver-never-loaded-fixture. */
export function gate1ReceiverLogPaths(outDir: string): string[] {
  return [
    join(outDir, "receiver", "stdout.log"),
    join(outDir, "receiver-headless-trace", "stdout.log"),
    ...G1A_CLASSIFIED_LEGS.filter(
      (l) => l !== "capture" && l !== "receiver",
    ).map((l) => join(outDir, l, "receiver", "stdout.log")),
    join(outDir, "receiver-typecheck", "selftest", "stdout.log"),
    join(outDir, "receiver-typecheck", "minimal", "stdout.log"),
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
  let streamStats: Gate1Report["stream"]["full"] = {
    transactions: null,
    bytes_total: null,
    encode_ns_total: null,
    snapshot_ns_total: null,
    max_record_bytes: null,
  };

  // Checks of each landed group; a group that did not run reports its checks as not-run.
  checks.push(checkExpectedSelfConsistent(ctx.expected));
  if (groups.run.includes("g1a")) {
    const evaluations = new Map<G1aLeg, Gate1LegEvaluation>();
    for (const leg of G1A_CLASSIFIED_LEGS) {
      evaluations.set(leg, await evaluateGate1Leg(outDir, leg, ctx.expected));
    }
    const capture = evaluations.get("capture") as Gate1LegEvaluation;
    const receiver = evaluations.get("receiver") as Gate1LegEvaluation;
    let captureBytes: Uint8Array | undefined;
    try {
      captureBytes = new Uint8Array(
        await readFile(join(outDir, "capture", "recording.rs0")),
      );
    } catch {
      captureBytes = undefined;
    }
    const states = decodeStates(captureBytes);
    const rg = await checkRootGeometry(outDir, ctx.expected, states);
    rootGeometry = rg.report;
    const asGate0 = (e: Gate1LegEvaluation) => e as unknown as LegEvaluation;
    checks.push(
      fromGate0(await checkCaptureArmed(outDir, capture)),
      fromGate0(await checkHeadlessNoGpuGate0(outDir)),
      fromGate0(checkRecordingDecodes(capture.recording)),
      fromGate0(checkManifestPresent(capture.recording)),
      await checkStepAlignment(outDir, ctx.expected, capture.recording),
      await checkExpectedImageReference(outDir, ctx.expected),
      await checkExpectedImageReceiver(receiver, ctx.expected),
      checkReceiverVsReference(receiver, ctx.expected),
      checkRetainedInvariants(ctx.expected, states, capture.recording.path),
      checkNoDrawIndexTies(states, capture.recording.path),
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
      ...G1A_CLASSIFIED_LEGS.map((leg) =>
        checkLegClass(evaluations.get(leg) as Gate1LegEvaluation),
      ),
    );
    for (const leg of G1A_SUPPORT_LEGS)
      legs[leg] = await supportLeg(outDir, leg);
    for (const leg of G1A_CLASSIFIED_LEGS) {
      const e = evaluations.get(leg) as Gate1LegEvaluation;
      legs[leg] = {
        group: "g1a",
        expected_class: e.expected_class,
        result_class: e.classification.result_class,
        reasons: e.classification.reasons,
        exit_code: e.exit_code,
        artifacts: e.artifacts,
      };
      checkpoints = checkpoints.concat(e.checkpoints);
    }
    const stats = capture.recording.end?.stats;
    const num = (v: unknown): number | null =>
      typeof v === "number" ? v : null;
    streamStats = {
      transactions: num(capture.recording.end?.transactions),
      bytes_total: num(stats?.bytes_total),
      encode_ns_total: num(stats?.encode_ns_total),
      snapshot_ns_total: num(stats?.snapshot_ns_total),
      max_record_bytes: num(stats?.max_record_bytes),
    };
  } else {
    checks.push({
      id: "group-g1a",
      criterion: "leg group g1a ran",
      passed: false,
      status: "not-run",
      detail: "g1a was not in --legs; its checks are not-run",
      evidence: [],
    });
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
    stream: { full: streamStats },
    live: null,
    root_geometry: rootGeometry,
  };
}
