// Gate 5d checks: render-stream/4 immediate geometry, add_set_transform and add_clip_ignore end to
// end (protocol/gate5-design.md "G5d", D9-D11, Q3b/Q3c, Q5, Q6b, Q6c). Pure evaluators over values
// already read from a run-gate5.sh evidence directory, plus small loaders; gate5-checks.ts's
// runGate5 wires them into the report. Nothing here launches a process, and nothing here imports
// gate5-checks.ts (that module imports this one).
//
// Independent expectations only (D12): every expected command comes from fixtures/gate5/
// expected.json `calls` (make_expected.py's float32 restatement of each script's RenderingServer
// calls; computed arguments flagged `ulp: 2`), every sabotage set from its `predictions`, every
// scissor from its `items[].clip_px` -- never from the capture itself.
//
// Evidence layout added by group g5d under <out>/ (see scripts/README.md "Gate 5"):
//   import/receiver/                 editor --import of receiver/
//   receiver/, receiver-patch/       rendered receiver on capture/'s full / patch sink: applied.json,
//                                    shots/seq-<n>.png at the settle seqs (receiver-patch also
//                                    state/seq-<n>.json)
//   receiver-headless-trace/         headless receiver under strace (openat)
//   capture-canvas/                  headless capture, RS_FIXTURE_VARIANT=canvas (D11)
//   sabotage-{freeze,perturb-vertex,omit-polygon}/{capture,receiver}/
//   sabotage-receiver-{ignore-set-transform,ignore-clip-ignore}/   receivers on capture/

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { deriveClipRects } from "./clip-derive";
import { decodePngRgba, readJson } from "./gate-minus1-checks";
import {
  type Checkpoint,
  type Classification,
  diffRgba,
  type RecordingSummary,
} from "./gate0-checks";
import { resolvedStateOf } from "./gate1-checks";
import type { Box, Gate5Call, Gate5Expected } from "./gate5-expected";
import { statesEqual } from "./render-stream-2";

/** The g5d legs judged by classifyLeg, with the prediction key of each sabotage leg. */
export const G5D_RECEIVER_LEGS = ["receiver", "receiver-patch"] as const;
export const G5D_SABOTAGE_CAPTURE_KINDS = [
  "freeze",
  "perturb-vertex",
  "omit-polygon",
] as const;
export const G5D_SABOTAGE_RECEIVER_KINDS = [
  "ignore-set-transform",
  "ignore-clip-ignore",
] as const;

const f32 = (v: number): number => Math.fround(v);

// ---------------------------------------------------------------------------------------------
// Expected /4 commands from expected.json `calls`
// ---------------------------------------------------------------------------------------------

/** A resolved /4 command (render-stream-4.md "Decoded and resolved forms"), as plain values. */
export type WireCommand = Record<string, unknown> & { op: string };

/** The `tex` of a call's `texture` argument: null for RID(), else the wire id the capture gave
 * the named fixture texture. */
export type TextureIds = ReadonlyMap<string, number>;

/** The resolved /4 command a fixture call records (D3: argument for argument). `tex` maps
 * expected.json texture names to wire ids. Unknown ops return null. */
export function wireCommandOf(
  call: Gate5Call,
  tex: TextureIds,
): WireCommand | null {
  const texOf = (name: unknown): number | null =>
    name === null || name === undefined ? null : (tex.get(String(name)) ?? -1);
  const c = call as Record<string, unknown>;
  switch (call.op) {
    case "canvas_item_add_rect":
      return {
        op: "add_rect",
        aa: c.antialiased,
        rect: c.rect,
        color: c.color,
      };
    case "canvas_item_add_line":
      return {
        op: "add_line",
        aa: c.antialiased,
        from: c.from,
        to: c.to,
        colour: c.color,
        width: c.width,
      };
    case "canvas_item_add_polyline":
    case "canvas_item_add_multiline":
      return {
        op: call.op.replace("canvas_item_", ""),
        aa: c.antialiased,
        width: c.width,
        points: c.points,
        colors: c.colors,
      };
    case "canvas_item_add_circle":
      return {
        op: "add_circle",
        aa: c.antialiased,
        position: c.position,
        radius: c.radius,
        colour: c.color,
      };
    case "canvas_item_add_primitive":
    case "canvas_item_add_polygon":
      return {
        op: call.op.replace("canvas_item_", ""),
        tex: texOf(c.texture),
        points: c.points,
        colors: c.colors,
        uvs: c.uvs,
      };
    case "canvas_item_add_triangle_array":
      return {
        op: "add_triangle_array",
        tex: texOf(c.texture),
        count: c.count,
        points: c.points,
        colors: c.colors,
        uvs: c.uvs,
        indices: c.indices,
      };
    case "canvas_item_add_nine_patch": {
      const tl = c.topleft as number[];
      const br = c.bottomright as number[];
      return {
        op: "add_nine_patch",
        tex: texOf(c.texture),
        rect: c.rect,
        source: c.source,
        margins: [tl[0], tl[1], br[0], br[1]],
        x_axis: c.x_axis,
        y_axis: c.y_axis,
        draw_center: c.draw_center,
        modulate: c.modulate,
      };
    }
    case "canvas_item_add_set_transform":
      return { op: "add_set_transform", transform: c.transform };
    case "canvas_item_add_clip_ignore":
      return { op: "add_clip_ignore", ignore: c.ignore };
    default:
      return null;
  }
}

/** One expected command and the ulp tolerance its floats compare within (0: float32-exact). */
export interface ExpectedCommand {
  call: Gate5Call;
  command: WireCommand | null;
  ulp: number;
}

/** Per step, each item's expected command list as of that step (carried from its last redraw),
 * in call order. */
export function expectedCommandsByStep(
  expected: Pick<Gate5Expected, "steps">,
  tex: TextureIds,
): Map<number, Map<string, ExpectedCommand[]>> {
  const out = new Map<number, Map<string, ExpectedCommand[]>>();
  const current = new Map<string, ExpectedCommand[]>();
  for (const s of expected.steps) {
    const fresh = new Map<string, ExpectedCommand[]>();
    for (const calls of Object.values(s.calls))
      for (const call of calls) {
        const list = fresh.get(call.item) ?? [];
        list.push({
          call,
          command: wireCommandOf(call, tex),
          ulp: call.ulp ?? 0,
        });
        fresh.set(call.item, list);
      }
    for (const [item, list] of fresh) current.set(item, list);
    out.set(s.step, new Map(current));
  }
  return out;
}

/** The distance between two float32 values in units in the last place (Infinity for NaN). */
export function ulpDistance(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  const buf = new DataView(new ArrayBuffer(4));
  const ordered = (v: number): number => {
    buf.setFloat32(0, v, true);
    const i = buf.getInt32(0, true);
    return i < 0 ? -2147483648 - i : i;
  };
  return Math.abs(ordered(f32(a)) - ordered(f32(b)));
}

/** Deep comparison of an expected value with a decoded one: numbers float32-exact (ulp 0) or
 * within `ulp` float32 ulps, arrays element by element, objects key by key (the same key set). */
export function sameValue(want: unknown, got: unknown, ulp: number): boolean {
  if (typeof want === "number") {
    if (typeof got !== "number") return false;
    if (Number.isInteger(want) && Number.isInteger(got) && ulp === 0)
      return want === got;
    return ulp === 0 ? f32(want) === got : ulpDistance(want, got) <= ulp;
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) return false;
    return want.every((w, i) => sameValue(w, got[i], ulp));
  }
  if (want !== null && typeof want === "object") {
    if (got === null || typeof got !== "object" || Array.isArray(got))
      return false;
    const wk = Object.keys(want as object);
    const gk = Object.keys(got as object);
    if (wk.length !== gk.length || wk.some((k) => !gk.includes(k)))
      return false;
    return wk.every((k) =>
      sameValue(
        (want as Record<string, unknown>)[k],
        (got as Record<string, unknown>)[k],
        ulp,
      ),
    );
  }
  return want === got;
}

/** Fixture item name -> wire id: ids in creation order (every item is made in `_ready`). */
export function itemIdsByName(
  expected: Pick<Gate5Expected, "creation_order">,
  recording: Pick<RecordingSummary, "transactions">,
): { ids: Map<string, number>; problems: string[] } {
  const seen = new Set<number>();
  for (const t of recording.transactions)
    for (const i of t.meta.items) seen.add(i.id);
  const sorted = [...seen].sort((a, b) => a - b);
  const problems: string[] = [];
  if (sorted.length !== expected.creation_order.length)
    problems.push(
      `${sorted.length} item ids in the recording, expected ${expected.creation_order.length}`,
    );
  return {
    ids: new Map(expected.creation_order.map((n, k) => [n, sorted[k]])),
    problems,
  };
}

/** expected.json texture name -> wire id: the recording's `ok` image entries whose shape is the
 * fixture texture's (the engine's 800x6 hue strip matches neither TEX16 nor TEX9). */
export function textureIdsByName(
  expected: Pick<Gate5Expected, "textures">,
  recording: Pick<RecordingSummary, "transactions">,
): { ids: Map<string, number>; problems: string[] } {
  const ids = new Map<string, number>();
  const problems: string[] = [];
  const last = recording.transactions[recording.transactions.length - 1];
  for (const [name, t] of Object.entries(expected.textures)) {
    const match = (last?.meta.textures ?? []).filter(
      (e) =>
        e.kind === "image" &&
        e.status === "ok" &&
        e.width === t.width &&
        e.height === t.height,
    );
    if (match.length !== 1)
      problems.push(
        `${match.length} ok ${t.width}x${t.height} image textures for ${name}, expected 1`,
      );
    else ids.set(name, match[0].id);
  }
  return { ids, problems };
}

// ---------------------------------------------------------------------------------------------
// geometry-commands (D12 (1))
// ---------------------------------------------------------------------------------------------

/** Pure: at every settle frame of every given sink, each fixture item's resolved commands equal
 * its expected.json calls as /4 commands, in order: passthrough arguments float32-exact, computed
 * ones (`ulp: 2`) within 2 ulp; tex names map to the capture's wire ids. */
export function evaluateGeometryCommands(
  expected: Gate5Expected,
  sinks: readonly { label: string; recording: RecordingSummary }[],
): { problems: string[]; compared: number; ulpUsed: number } {
  const problems: string[] = [];
  let compared = 0;
  let ulpUsed = 0;
  for (const { label, recording } of sinks) {
    if (!recording.present) {
      problems.push(`${label}: recording missing`);
      continue;
    }
    const items = itemIdsByName(expected, recording);
    const tex = textureIdsByName(expected, recording);
    problems.push(...items.problems.map((p) => `${label}: ${p}`));
    problems.push(...tex.problems.map((p) => `${label}: ${p}`));
    const byStep = expectedCommandsByStep(expected, tex.ids);
    for (const s of expected.steps) {
      const t = recording.transactions.find(
        (x) => x.meta.frame === s.settle_frame,
      );
      if (!t) {
        problems.push(
          `${label} step ${s.step}: no transaction at frame ${s.settle_frame}`,
        );
        continue;
      }
      for (const [name, want] of byStep.get(s.step) ?? []) {
        const item = t.meta.items.find((i) => i.id === items.ids.get(name));
        const got = (item?.commands ?? []) as unknown as WireCommand[];
        if (got.length !== want.length) {
          problems.push(
            `${label} step ${s.step} ${name}: ${got.length} commands (${got.map((c) => c.op).join(",")}), expected ${want.length} (${want.map((w) => w.command?.op).join(",")})`,
          );
          continue;
        }
        want.forEach((w, k) => {
          compared++;
          if (sameValue(w.command, got[k], 0)) return;
          if (w.ulp > 0 && sameValue(w.command, got[k], w.ulp)) {
            ulpUsed++;
            return;
          }
          problems.push(
            `${label} step ${s.step} ${name} command ${k}: ${JSON.stringify(got[k]).slice(0, 160)} != ${JSON.stringify(w.command).slice(0, 160)}${w.ulp > 0 ? ` (within ${w.ulp} ulp)` : ""}`,
          );
        });
      }
    }
  }
  return { problems, compared, ulpUsed };
}

// ---------------------------------------------------------------------------------------------
// lowering-predictions (D12 (5))
// ---------------------------------------------------------------------------------------------

/** Pure: on the capture, each expected.json lowering prediction (Line2D's one triangle array, the
 * dashed line's multiline, the unfilled rect's and circle's closed polylines) holds at every
 * settle frame, and Line2D's command is byte-for-byte the same across step 3 although the item
 * redraws there (`Line2D.antialiased` is stored and never used). */
export function evaluateLoweringPredictions(
  expected: Gate5Expected,
  full: RecordingSummary,
): { problems: string[]; measured: Record<string, string> } {
  const problems: string[] = [];
  const measured: Record<string, string> = {};
  const items = itemIdsByName(expected, full);
  problems.push(...items.problems);
  const settle = (step: number) =>
    full.transactions.find(
      (x) => x.meta.frame === expected.steps[step]?.settle_frame,
    );
  for (const [key, raw] of Object.entries(expected.lowering_predictions)) {
    const pred = raw as {
      op: string;
      item: string;
      index: number;
      vertices?: number;
      indices?: number;
      points?: number;
      colors?: number;
      uvs?: number;
      count?: number;
    };
    const op = pred.op.replace("canvas_item_", "");
    for (const s of expected.steps) {
      const t = settle(s.step);
      const item = t?.meta.items.find((i) => i.id === items.ids.get(pred.item));
      const c = item?.commands[pred.index] as
        | (WireCommand & {
            points?: unknown[];
            colors?: unknown[];
            uvs?: unknown[];
            indices?: unknown[];
            count?: number;
          })
        | undefined;
      if (!c || c.op !== op) {
        problems.push(
          `${key} step ${s.step}: ${pred.item} command ${pred.index} is ${c?.op ?? "<none>"}, expected ${op}`,
        );
        continue;
      }
      const got = {
        vertices: c.points?.length,
        points: c.points?.length,
        indices: c.indices?.length,
        colors: c.colors?.length,
        uvs: c.uvs?.length,
        count: c.count,
      };
      for (const field of [
        "vertices",
        "points",
        "indices",
        "colors",
        "uvs",
        "count",
      ] as const)
        if (pred[field] !== undefined && got[field] !== pred[field])
          problems.push(
            `${key} step ${s.step}: ${field} ${got[field]}, expected ${pred[field]}`,
          );
      if (s.step === 0)
        measured[key] =
          op === "add_triangle_array"
            ? `${got.vertices} vertices, ${got.indices} indices, count ${got.count}`
            : `${got.points} points, ${got.colors} colour(s)`;
    }
  }
  // Line2D.antialiased (step 3): a redraw that changes no byte of the command.
  const l2 = items.ids.get("L2");
  const before = settle(2)?.meta.items.find((i) => i.id === l2);
  const after = settle(3)?.meta.items.find((i) => i.id === l2);
  if (!before || !after) problems.push("L2 missing at steps 2/3");
  else {
    if (!(after.content_version > before.content_version))
      problems.push(
        `L2 content_version ${before.content_version} -> ${after.content_version}: expected a redraw at step 3`,
      );
    if (JSON.stringify(after.commands) !== JSON.stringify(before.commands))
      problems.push("L2's commands differ across step 3 (antialiased = true)");
    measured.L2_step3 = `content_version ${before.content_version} -> ${after.content_version}, commands identical`;
  }
  return { problems, measured };
}

// ---------------------------------------------------------------------------------------------
// clip-rects-derived (D9, D10, gate 3's derivation extended)
// ---------------------------------------------------------------------------------------------

/** The command indices drawn with the scissor dropped, from an item's expected calls (D10,
 * restated over the calls rather than clip-derive's resolved commands). */
export function expectedIgnoredIndices(calls: readonly Gate5Call[]): number[] {
  const out: number[] = [];
  let ignoring = false;
  calls.forEach((c, i) => {
    if (c.op === "canvas_item_add_clip_ignore") ignoring = c.ignore === true;
    else if (ignoring && c.op !== "canvas_item_add_set_transform") out.push(i);
  });
  return out;
}

/** Pure: deriveClipRects (lib/clip-derive.ts, with D9's draw transform and D10's clip-ignore
 * spans) over each settle state equals expected.json: every item's scissor is its `clip_px`
 * (null without one), and CG's clip-ignored commands are exactly those between its
 * add_clip_ignore pair. `states` are resolved states per step (a sink's transactions, or a
 * receiver's state dumps). */
export function evaluateClipRectsDerived(
  expected: Gate5Expected,
  label: string,
  states: ReadonlyMap<
    number,
    Parameters<typeof deriveClipRects>[0] | undefined
  >,
  ids: ReadonlyMap<string, number>,
): { problems: string[]; table: Record<string, string> } {
  const problems: string[] = [];
  const table: Record<string, string> = {};
  const lastCalls = new Map<string, Gate5Call[]>();
  for (const s of expected.steps) {
    const fresh = new Map<string, Gate5Call[]>();
    for (const calls of Object.values(s.calls))
      for (const c of calls)
        fresh.set(c.item, [...(fresh.get(c.item) ?? []), c]);
    for (const [item, calls] of fresh) lastCalls.set(item, calls);
    const state = states.get(s.step);
    if (!state) {
      problems.push(`${label} step ${s.step}: no state`);
      continue;
    }
    const derived = deriveClipRects(state, expected.viewport);
    for (const it of s.items) {
      const d = derived.get(ids.get(it.name) ?? -1);
      if (d === undefined || d === "skipped" || d === "unknown") {
        problems.push(
          `${label} step ${s.step} ${it.name}: derived ${JSON.stringify(d ?? "absent")}`,
        );
        continue;
      }
      if (JSON.stringify(d.rect) !== JSON.stringify(it.clip_px))
        problems.push(
          `${label} step ${s.step} ${it.name}: scissor ${JSON.stringify(d.rect)}, expected ${JSON.stringify(it.clip_px)}`,
        );
      const want = it.clip_px
        ? expectedIgnoredIndices(lastCalls.get(it.name) ?? [])
        : [];
      const got = d.ignored ?? [];
      if (JSON.stringify(got) !== JSON.stringify(want))
        problems.push(
          `${label} step ${s.step} ${it.name}: clip-ignored commands ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        );
      if (it.clip_px)
        table[`${it.name}@${s.step}`] =
          `${JSON.stringify(d.rect)}${got.length > 0 ? ` ignore ${JSON.stringify(got)}` : ""}`;
    }
  }
  return { problems, table };
}

/** The settle states of a sink, keyed by step (the resolved state DeriveInput needs). */
export function sinkStates(
  expected: Pick<Gate5Expected, "steps">,
  recording: Pick<RecordingSummary, "transactions">,
): Map<number, Parameters<typeof deriveClipRects>[0] | undefined> {
  const out = new Map<
    number,
    Parameters<typeof deriveClipRects>[0] | undefined
  >();
  for (const s of expected.steps)
    out.set(
      s.step,
      recording.transactions.find((x) => x.meta.frame === s.settle_frame)
        ?.meta as Parameters<typeof deriveClipRects>[0] | undefined,
    );
  return out;
}

/** A receiver's state dumps (state/seq-<n>.json) at the settle seqs, keyed by step, each also
 * compared with the recording's own resolved state at that seq (statesEqual: the receiver
 * resolved every /4 command exactly as the TypeScript decoder does). */
export async function receiverStates(
  expected: Pick<Gate5Expected, "steps">,
  dir: string,
  recording: Pick<RecordingSummary, "transactions">,
): Promise<{
  states: Map<number, Parameters<typeof deriveClipRects>[0] | undefined>;
  problems: string[];
}> {
  const states = new Map<
    number,
    Parameters<typeof deriveClipRects>[0] | undefined
  >();
  const problems: string[] = [];
  for (const s of expected.steps) {
    const t = recording.transactions.find(
      (x) => x.meta.frame === s.settle_frame,
    );
    if (!t) {
      problems.push(
        `step ${s.step}: no transaction at frame ${s.settle_frame}`,
      );
      states.set(s.step, undefined);
      continue;
    }
    const dump = await readJson<Parameters<typeof deriveClipRects>[0]>(
      join(dir, "state", `seq-${t.meta.seq}.json`),
    );
    if (!dump) problems.push(`${dir}/state/seq-${t.meta.seq}.json missing`);
    else if (!statesEqual(dump, resolvedStateOf(t.meta)))
      problems.push(
        `step ${s.step}: state/seq-${t.meta.seq}.json differs from the recording's resolved state`,
      );
    states.set(s.step, dump);
  }
  return { states, problems };
}

// ---------------------------------------------------------------------------------------------
// Receiver shots, checkpoints and per-region classification
// ---------------------------------------------------------------------------------------------

export interface Frame5 {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** step -> the seq of the recording's transaction at that step's settle frame. */
export function settleSeqs(
  expected: Pick<Gate5Expected, "steps">,
  recording: Pick<RecordingSummary, "transactions">,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of expected.steps) {
    const t = recording.transactions.find(
      (x) => x.meta.frame === s.settle_frame,
    );
    if (t) out.set(s.step, t.meta.seq);
  }
  return out;
}

/** A receiver leg's settle shots (shots/seq-<n>.png) keyed by step. */
export async function loadReceiverShots5(
  dir: string,
  expected: Pick<Gate5Expected, "steps">,
  seqs: ReadonlyMap<number, number>,
): Promise<Map<number, Frame5 | null>> {
  const out = new Map<number, Frame5 | null>();
  for (const s of expected.steps) {
    const seq = seqs.get(s.step);
    const png =
      seq === undefined
        ? undefined
        : await decodePngRgba(join(dir, "shots", `seq-${seq}.png`));
    out.set(
      s.step,
      png ? { width: png.width, height: png.height, rgba: png.data } : null,
    );
  }
  return out;
}

export async function shotSeqsPresent5(dir: string): Promise<number[]> {
  try {
    return (await readdir(join(dir, "shots")))
      .map((n) => /^seq-(\d+)\.png$/.exec(n)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);
  } catch {
    return [];
  }
}

/** The gate 5 regions as Checkpoint rects ([x, y, w, h]). */
function regionRects(
  expected: Pick<Gate5Expected, "regions">,
): [string, Box][] {
  return Object.entries(expected.regions).map(([name, r]) => [
    name,
    [r[0], r[1], r[2] - r[0], r[3] - r[1]],
  ]);
}

/** Checkpoints for classifyLeg: a receiver leg's shots against the reference's, per region. */
export function computeGate5Checkpoints(
  expected: Pick<Gate5Expected, "steps" | "regions">,
  referenceDir: string,
  reference: ReadonlyMap<number, Frame5 | null>,
  receiverDir: string,
  receiver: ReadonlyMap<number, Frame5 | null>,
  seqs: ReadonlyMap<number, number>,
): Checkpoint[] {
  const regions = regionRects(expected);
  return expected.steps.map((s) => {
    const ref = reference.get(s.step);
    const got = receiver.get(s.step);
    const seq = seqs.get(s.step) ?? null;
    const base = {
      step: s.step,
      settle_frame: s.settle_frame,
      seq,
      reference_png: join(referenceDir, "shots", `step-${s.step}.png`),
      receiver_png:
        seq === null ? null : join(receiverDir, "shots", `seq-${seq}.png`),
      diff_png: null,
    };
    if (!ref || !got || ref.width !== got.width || ref.height !== got.height)
      return {
        ...base,
        mismatched_pixels: null,
        max_channel_delta: null,
        regions: regions.map(([name, rect]) => ({
          name,
          rect_px: [...rect],
          mismatched_pixels: null,
          max_channel_delta: null,
        })),
      };
    return {
      ...base,
      ...diffRgba(ref.rgba, got.rgba, ref.width, ref.height),
      regions: regions.map(([name, rect]) => ({
        name,
        rect_px: [...rect],
        ...diffRgba(ref.rgba, got.rgba, ref.width, ref.height, rect),
      })),
    };
  });
}

/** Per step, the regions whose pixels differ ("outside" when pixels outside every region do,
 * "?" when a shot is missing). */
export function mismatchingRegions(
  checkpoints: readonly Checkpoint[],
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const cp of checkpoints) {
    if (cp.mismatched_pixels === null) {
      out.set(cp.step, ["?"]);
      continue;
    }
    const list = cp.regions
      .filter((r) => (r.mismatched_pixels ?? 1) > 0)
      .map((r) => r.name);
    const inside = cp.regions.reduce(
      (n, r) => n + (r.mismatched_pixels ?? 0),
      0,
    );
    if (cp.mismatched_pixels > inside) list.push("outside");
    out.set(cp.step, list);
  }
  return out;
}

export interface Gate5LegExpectation {
  class: Classification["result_class"];
  /** exactly these steps mismatch (any region) */
  steps?: number[];
  /** exactly these regions mismatch, at exactly these steps each */
  regions?: Record<string, number[]>;
}

/** Pure: classifyLeg's verdict against one leg's prediction. With `regions`, every step's set of
 * mismatching regions must be exactly the predicted one; with `steps`, exactly those steps
 * mismatch; otherwise no pixel may differ. */
export function evaluateLegClass5(
  classification: Pick<Classification, "result_class" | "reasons">,
  checkpoints: readonly Checkpoint[],
  exp: Gate5LegExpectation,
): { problems: string[]; table: Record<string, string> } {
  const problems: string[] = [];
  if (classification.result_class !== exp.class)
    problems.push(
      `class ${classification.result_class}, expected ${exp.class}: ${classification.reasons.slice(0, 2).join(" | ")}`,
    );
  const got = mismatchingRegions(checkpoints);
  const table: Record<string, string> = {};
  for (const cp of checkpoints) {
    const regions = [...(got.get(cp.step) ?? [])].sort();
    if (regions.length > 0) table[String(cp.step)] = regions.join("+");
    let want: string[] = [];
    if (exp.regions)
      want = Object.entries(exp.regions)
        .filter(([, steps]) => steps.includes(cp.step))
        .map(([r]) => r)
        .sort();
    if (exp.steps) {
      const should = exp.steps.includes(cp.step);
      if (should !== regions.length > 0)
        problems.push(
          `step ${cp.step}: ${regions.length > 0 ? `mismatches in ${regions.join(",")}` : "matches"}, expected it ${should ? "to mismatch" : "to match"}`,
        );
      continue;
    }
    if (JSON.stringify(regions) !== JSON.stringify(want))
      problems.push(
        `step ${cp.step}: mismatching regions {${regions.join(",")}}, expected {${want.join(",")}}`,
      );
  }
  return { problems, table };
}

// ---------------------------------------------------------------------------------------------
// capture-canvas (D11)
// ---------------------------------------------------------------------------------------------

/** Pure: the `canvas` variant's headless capture classifies `unsupported`, and the only
 * unsupported entries are canvas-texture-headless for exactly the predicted (item, op) pairs
 * (expected.json predictions["capture-canvas"]); at every settle frame each item's commands are
 * its expected /4 commands with every refused call replaced, in place, by an `unsupported`
 * command of that op and reason (the ops with a texture, and those without a texture argument,
 * are untouched). */
export function evaluateCaptureCanvas(
  expected: Gate5Expected,
  capture: {
    result_class: string;
    reasons: string[];
    full: RecordingSummary;
  },
): { problems: string[]; entries: string[] } {
  const problems: string[] = [];
  const pred = expected.predictions["capture-canvas"] as
    | { class?: string; reason?: string; entries?: [string, string][] }
    | undefined;
  if (!pred?.entries)
    return { problems: ["no capture-canvas prediction"], entries: [] };
  if (capture.result_class !== pred.class)
    problems.push(
      `class ${capture.result_class}, expected ${pred.class}: ${capture.reasons.slice(0, 2).join(" | ")}`,
    );
  const items = itemIdsByName(expected, capture.full);
  const tex = textureIdsByName(expected, capture.full);
  problems.push(...items.problems, ...tex.problems);
  const nameOf = new Map([...items.ids].map(([n, id]) => [id, n]));
  const refused = new Set(pred.entries.map(([i, op]) => `${i}:${op}`));
  const seen = new Set<string>();
  for (const t of capture.full.transactions)
    for (const u of t.meta.unsupported) {
      if (u.reason === "draw-index-tie") continue;
      const key = `${nameOf.get(u.item ?? -1) ?? u.item}:${u.op}`;
      seen.add(`${key}:${u.reason}`);
    }
  const want = [...refused].map((k) => `${k}:${pred.reason}`).sort();
  const got = [...seen].sort();
  if (JSON.stringify(got) !== JSON.stringify(want))
    problems.push(
      `unsupported entries ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
    );
  const byStep = expectedCommandsByStep(expected, tex.ids);
  for (const s of expected.steps) {
    const t = capture.full.transactions.find(
      (x) => x.meta.frame === s.settle_frame,
    );
    if (!t) {
      problems.push(
        `step ${s.step}: no transaction at frame ${s.settle_frame}`,
      );
      continue;
    }
    for (const [name, list] of byStep.get(s.step) ?? []) {
      const item = t.meta.items.find((i) => i.id === items.ids.get(name));
      const gotCmds = (item?.commands ?? []) as unknown as WireCommand[];
      const wantCmds = list.map((w) =>
        refused.has(`${name}:${w.call.op}`) && w.call.texture === null
          ? { op: "unsupported", name: w.call.op, reason: pred.reason }
          : w.command,
      );
      const ok =
        gotCmds.length === wantCmds.length &&
        wantCmds.every((w, k) => sameValue(w, gotCmds[k], list[k].ulp));
      if (!ok)
        problems.push(
          `step ${s.step} ${name}: commands ${gotCmds.map((c) => c.op).join(",")} != ${wantCmds.map((c) => c?.op).join(",")}`,
        );
    }
  }
  return { problems, entries: got };
}
