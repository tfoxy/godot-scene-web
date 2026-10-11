// Gate 6b checks (protocol/gate6-design.md "G6b", "Q3a", "Q3b", "Q5", "Q6h", "Q7b"): the
// render-stream/6 switch's own legs -- presentation (the HD fixture captured at
// presentation:960x540 and replayed by 960x540 receivers that adopt the session's stretch), canvas
// layers (the HUD CanvasLayer carried with its stacking), snap-to-pixel typed at arm, the
// presentation hazard (a host evaluated at the logical size, presented at half), and the receiver
// sabotages ignore-presentation and ignore-canvas-stacking.
//
// Everything here reads an evidence directory written by run-gate6.sh's g6a, g6h and g6b groups
// (lib/gate6b-legs.sh), or is pure over values already read from one, so
// scripts/test/self-test-gate6b.ts can drive each pure check with synthetic values. Nothing
// launches a process. Classification never reads `session.sabotage`.
//
// The records that meet here, none a replay of another (D7):
//   - fixtures/gate6-hd/expected.json's half model (scale 0.5, the StyleBoxFlat port at
//     aa_size / 0.5: `ops_half`) and fixtures/gate6-scene/expected.json's predictions;
//   - the rendered references (g6a's reference-scene, g6h's reference-hd-half) and their oracles
//     (canvas layers, atlas pages at oversampling 0.5);
//   - the captures' wire (sessions, canvases, unsupported entries, triangle arrays) and hook log
//     (calibrator 9's stacking and removal lines);
//   - the receivers' frames and applied.json (render-stream-receiver-applied/6's viewport block
//     and receiver-typed entries).
//
// Evidence under <out>/ (lib/gate6b-legs.sh): hd/capture-half{,-inline,-at-logical}/,
// hd/receiver-half{,-patch,-inline,-at-logical}/, hd/sabotage-receiver-ignore-presentation/,
// scene/sabotage-receiver-ignore-canvas-stacking/, snap/{project,import,capture}/.

import { join } from "node:path";

import { readJson } from "./gate-minus1-checks";
import {
  type AppliedJson,
  type Checkpoint,
  classifyLeg,
  PATCH_RECORDING_NAME,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
} from "./gate0-checks";
import { loadResourceLog, type ResourceLine } from "./gate2-checks";
import { evaluateCapture, type Gate3CaptureEvaluation } from "./gate3-checks";
import { check } from "./gate5-checks";
import type { Box } from "./gate5-expected";
import { ulpDistance } from "./gate5d-checks";
import type { Gate6Expected, Gate6Shot } from "./gate6-expected";
import {
  appliedPairs,
  compareShots6,
  evaluateAtlasParity6,
  evaluatePixelVerdict,
  evaluateUnsupportedClass,
  type Gate6Check,
  loadOracle6,
  loadReceiverShots6,
  loadReferenceShots6,
  nameIds6,
  type OracleLog6,
  shotSeqs,
  unsupportedPairs,
  wantedClass,
} from "./gate6a-checks";
import {
  asOracle6,
  diffFramesHd,
  type FrameDiffHd,
  type Gate6HdExpected,
  type HdOracleLog,
  loadFrame,
  loadHdOracle,
  regionIndexHd,
  requestedSeqs,
  shotFiles,
} from "./gate6h-checks";
import { loadWire5, txAt, type Wire5 } from "./gate55-wire";

export const G6B_DIRS = {
  hd: "hd",
  scene: "scene",
  snap: "snap",
} as const;

/** The half presentation every g6b HD leg presents at. */
export const HALF_SIZE: [number, number] = [960, 540];

export interface G6bLegEntry {
  group: "g6b";
  expected_class: string;
  result_class: string | null;
  pixel_verdict?: string;
  expected_pixel_verdict?: string;
  reasons: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface Gate6bResult {
  checks: Gate6Check[];
  legs: Record<string, G6bLegEntry>;
  mismatch_tables: Record<string, Record<string, string[]>>;
  census: Record<string, string>;
  /** the presentation hazard's per-region pixel counts, summed over every shot */
  hazard: Record<string, number>;
}

// ---------------------------------------------------------------------------------------------
// Sessions (presentation-declared, snap-typed)
// ---------------------------------------------------------------------------------------------

interface ViewportMeta6 {
  logical_size?: number[];
  stretch?: { mode?: string; aspect?: string; scale_mode?: string };
  root_size_policy?: string;
  presentation_size?: number[];
  host_size_status?: string;
  host_window_size?: number[];
  font_oversampling?: number;
  snap_2d?: { transforms?: boolean; vertices?: boolean };
}

/** What one capture's session must declare (render-stream-6.md "Viewport", "Publication"). */
export interface SessionWant {
  label: string;
  logical_size: [number, number];
  stretch_mode: string;
  root_size_policy: string;
  presentation_size: [number, number];
  host_window_size: [number, number];
  font_oversampling: number;
  snap_2d: { transforms: boolean; vertices: boolean };
  host_final_xform: number[];
}

/** Pure: the session of `recording` declares `want` exactly: protocol render-stream/6, the
 * viewport (policy, presentation size, window, status `match`, oversampling, snap), the
 * host_visible_rect block at the logical size, the host_final_xform block (the stretch), and a
 * file sink's `publication` every-frame/null. */
export function evaluateSessionDeclared(
  recording: Pick<RecordingSummary, "session" | "session_blocks" | "present">,
  want: SessionWant,
): string[] {
  const problems: string[] = [];
  if (!recording.present) return [`${want.label}: recording missing`];
  const s = recording.session as unknown as
    | {
        protocol?: string;
        viewport?: ViewportMeta6;
        publication?: { mode?: string; target_fps?: number | null };
      }
    | undefined;
  if (s?.protocol !== "render-stream/6")
    problems.push(`${want.label}: protocol ${s?.protocol}`);
  const v = s?.viewport;
  const got = {
    logical_size: v?.logical_size,
    stretch_mode: v?.stretch?.mode,
    root_size_policy: v?.root_size_policy,
    presentation_size: v?.presentation_size,
    host_size_status: v?.host_size_status,
    host_window_size: v?.host_window_size,
    font_oversampling: v?.font_oversampling,
    snap_2d: v?.snap_2d,
  };
  const wantView = {
    logical_size: want.logical_size,
    stretch_mode: want.stretch_mode,
    root_size_policy: want.root_size_policy,
    presentation_size: want.presentation_size,
    host_size_status: "match",
    host_window_size: want.host_window_size,
    font_oversampling: want.font_oversampling,
    snap_2d: want.snap_2d,
  };
  if (JSON.stringify(got) !== JSON.stringify(wantView))
    problems.push(
      `${want.label}: viewport ${JSON.stringify(got)} != ${JSON.stringify(wantView)}`,
    );
  if (
    JSON.stringify(s?.publication) !==
    JSON.stringify({ mode: "every-frame", target_fps: null })
  )
    problems.push(
      `${want.label}: publication ${JSON.stringify(s?.publication)}, expected every-frame/null`,
    );
  const blocks = recording.session_blocks ?? [];
  const visible = blocks[2];
  const final = blocks[3];
  if (
    JSON.stringify(visible) !==
    JSON.stringify([0, 0, want.logical_size[0], want.logical_size[1]])
  )
    problems.push(
      `${want.label}: host_visible_rect ${JSON.stringify(visible)}, expected the logical size`,
    );
  if (JSON.stringify(final) !== JSON.stringify(want.host_final_xform))
    problems.push(
      `${want.label}: host_final_xform ${JSON.stringify(final)}, expected ${JSON.stringify(want.host_final_xform)}`,
    );
  return problems;
}

/** Pure: every transaction of `recording` carries exactly the session-level entries `want` (and
 * nothing item-level), in that order. */
export function evaluateSessionEntries(
  recording: Pick<RecordingSummary, "transactions" | "present">,
  want: readonly [string, string][],
  label: string,
): string[] {
  if (!recording.present) return [`${label}: recording missing`];
  const problems: string[] = [];
  const w = JSON.stringify(want.map(([op, reason]) => [op, null, reason]));
  let bad = 0;
  for (const t of recording.transactions) {
    const got = JSON.stringify(
      t.meta.unsupported.map((u) => [u.op, u.item, u.reason]),
    );
    if (got !== w) {
      bad++;
      if (bad <= 3)
        problems.push(
          `${label} seq ${t.meta.seq}: unsupported ${got}, expected ${w}`,
        );
    }
  }
  if (recording.transactions.length === 0)
    problems.push(`${label}: no transactions`);
  if (bad > 3) problems.push(`${label}: ${bad} transactions in all`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// canvas-commands, canvas-stacking-parity
// ---------------------------------------------------------------------------------------------

/** The hook log's canvas lines (calibrator 9) as the per-RID state they leave. */
export interface CanvasLogState {
  /** canvas RID -> the frame of its first stacking line and that line's (layer, sublayer) */
  first: Map<string, { frame: number; layer: number; sublayer: number }>;
  /** canvas RID -> the time-ordered (frame, layer, sublayer | removed) events */
  events: Map<
    string,
    { frame: number; layer?: number; sublayer?: number; removed?: boolean }[]
  >;
}

export function canvasLogState(lines: readonly ResourceLine[]): CanvasLogState {
  const first = new Map<
    string,
    { frame: number; layer: number; sublayer: number }
  >();
  const events = new Map<
    string,
    { frame: number; layer?: number; sublayer?: number; removed?: boolean }[]
  >();
  for (const l of lines) {
    if (l.kind !== "canvas" || l.rid === null) continue;
    if (l.op === "viewport_set_canvas_stacking") {
      const layer = l.layer ?? 0;
      const sublayer = l.sublayer ?? 0;
      if (!first.has(l.rid))
        first.set(l.rid, { frame: l.frame, layer, sublayer });
      const list = events.get(l.rid) ?? [];
      list.push({ frame: l.frame, layer, sublayer });
      events.set(l.rid, list);
    } else if (l.op === "viewport_remove_canvas") {
      const list = events.get(l.rid) ?? [];
      list.push({ frame: l.frame, removed: true });
      events.set(l.rid, list);
    }
  }
  return { first, events };
}

/** Pure: the non-root wire canvases of `wire` against the hook log's stacking and removal lines.
 * Each wire canvas id is matched to the one canvas RID whose first stacking line has the frame and
 * (layer, sublayer) the canvas first appears attached with; then, at every transaction up to
 * `lastFrame` (the quit frame: the teardown's removals come after it), the canvas's (layer,
 * sublayer) equals the RID's last stacking line at or before that frame, and it is attached
 * exactly while no removal line precedes it. The root canvas stays at (0,0), attached. No
 * transaction carries a canvas-stacking-tie entry, and every attached non-root canvas sits on its
 * hook-logged key in its first attached transaction (the stacking lands in the attach frame,
 * Q1e). */
export function evaluateCanvasCommands(
  wire: Pick<Wire5, "transactions">,
  log: CanvasLogState,
  lastFrame: number,
  label: string,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const firstAttached = new Map<
    number,
    { frame: number; layer: number; sublayer: number }
  >();
  let compared = 0;
  for (const t of wire.transactions) {
    if (t.state.unsupported.some((u) => u.reason === "canvas-stacking-tie"))
      problems.push(`${label} seq ${t.seq}: a canvas-stacking-tie entry`);
    for (const c of t.state.canvases) {
      if (c.id === 1) {
        if (!c.attached || (c.layer ?? 0) !== 0 || (c.sublayer ?? 0) !== 0)
          problems.push(
            `${label} seq ${t.seq}: the root canvas is ${c.attached ? "" : "not "}attached at (${c.layer},${c.sublayer})`,
          );
        continue;
      }
      if (c.attached && !firstAttached.has(c.id))
        firstAttached.set(c.id, {
          frame: t.frame,
          layer: c.layer ?? 0,
          sublayer: c.sublayer ?? 0,
        });
    }
  }
  // Match wire ids to RIDs by their first key.
  const ridOf = new Map<number, string>();
  for (const [id, f] of firstAttached) {
    const hits = [...log.first].filter(
      ([, l]) =>
        l.frame === f.frame && l.layer === f.layer && l.sublayer === f.sublayer,
    );
    if (hits.length !== 1) {
      problems.push(
        `${label}: canvas ${id} first attached at frame ${f.frame} on (${f.layer},${f.sublayer}) matches ${hits.length} hook-logged first stacking lines${f.layer === 0 && f.sublayer === 0 ? " (published at the attach default: the stacking did not land in the attach frame)" : ""}`,
      );
      continue;
    }
    ridOf.set(id, hits[0][0]);
  }
  if (log.first.size !== firstAttached.size)
    problems.push(
      `${label}: ${log.first.size} canvas RIDs stacked in the hook log, ${firstAttached.size} canvases attached on the wire`,
    );
  for (const t of wire.transactions) {
    if (t.frame > lastFrame) continue;
    for (const c of t.state.canvases) {
      const rid = ridOf.get(c.id);
      if (rid === undefined) continue;
      const events = (log.events.get(rid) ?? []).filter(
        (e) => e.frame <= t.frame,
      );
      let layer = 0;
      let sublayer = 0;
      let removed = false;
      for (const e of events) {
        if (e.removed) removed = true;
        else {
          layer = e.layer ?? 0;
          sublayer = e.sublayer ?? 0;
        }
      }
      compared++;
      if (
        (c.layer ?? 0) !== layer ||
        (c.sublayer ?? 0) !== sublayer ||
        c.attached === removed
      )
        problems.push(
          `${label} seq ${t.seq} canvas ${c.id}: wire (${c.layer},${c.sublayer}) ${c.attached ? "attached" : "detached"}, hook log (${layer},${sublayer}) ${removed ? "removed" : "attached"}`,
        );
    }
  }
  return {
    problems,
    detail: `${label}: ${firstAttached.size} layer canvases, ${compared} canvas-transactions equal the hook log`,
  };
}

/** Pure: at every settle step, the wire's layer canvases carry the oracle's HUD (layer, sublayer)
 * in the step's settle transaction, in canvas id order matching `hudOrder` (scene: one HUD; HD:
 * the nine cells' HUDs, created in cell order), and the visible flag the oracle reads is the
 * HUD panel item's visibility (canvas layer visibility travels as item visibility, cl.cpp:49-64). */
export function evaluateStackingParity(
  steps: readonly { step: number; settle_frame: number }[],
  hudsAt: (step: number) => { layer: number; sublayer: number }[] | null,
  wire: Pick<Wire5, "transactions">,
  label: string,
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  for (const s of steps) {
    const huds = hudsAt(s.step);
    const tx = txAt(wire.transactions, s.settle_frame);
    if (!huds || !tx) {
      problems.push(
        `${label} step ${s.step}: no ${huds ? "settle transaction" : "oracle line"}`,
      );
      continue;
    }
    const layers = tx.state.canvases
      .filter((c) => c.id !== 1)
      .sort((a, b) => a.id - b.id);
    if (layers.length !== huds.length) {
      problems.push(
        `${label} step ${s.step}: ${layers.length} layer canvases on the wire, the oracle reads ${huds.length} HUDs`,
      );
      continue;
    }
    huds.forEach((h, k) => {
      compared++;
      const c = layers[k];
      if (!c.attached || c.layer !== h.layer || c.sublayer !== h.sublayer)
        problems.push(
          `${label} step ${s.step} canvas ${c.id}: wire (${c.layer},${c.sublayer})${c.attached ? "" : " detached"}, oracle (${h.layer},${h.sublayer})`,
        );
    });
  }
  return { problems, compared };
}

// ---------------------------------------------------------------------------------------------
// stylebox-aa-scale
// ---------------------------------------------------------------------------------------------

interface MeshOp {
  name: string;
  kind: string;
  vertices?: number[][];
  triangles?: number[][];
  colors?: number[][];
}

/** One StyleBoxFlat's add_triangle_array as the model's op list describes it: the consecutive
 * `mesh` parts sharing a box name (`<item>.<box>.<role>`), vertices and colours concatenated in
 * draw order, triangles offset by each part's first vertex. */
export interface ModelTriangleArray {
  box: string;
  points: number[][];
  colors: number[][];
  indices: number[];
}

export function modelTriangleArrays(
  ops: readonly MeshOp[],
): ModelTriangleArray[] {
  const out: ModelTriangleArray[] = [];
  for (const op of ops) {
    if (op.kind !== "mesh" || !op.vertices || !op.triangles) continue;
    const box = op.name.split(".").slice(0, -1).join(".");
    let last = out[out.length - 1];
    if (!last || last.box !== box) {
      last = { box, points: [], colors: [], indices: [] };
      out.push(last);
    }
    const base = last.points.length;
    const n = op.vertices.length;
    const colors = op.colors ?? [];
    last.points.push(...op.vertices);
    for (let k = 0; k < n; k++)
      last.colors.push(colors.length === 1 ? colors[0] : colors[k]);
    for (const t of op.triangles) last.indices.push(...t.map((i) => i + base));
  }
  return out;
}

interface WireTriangleArray {
  op: string;
  points?: number[][];
  colors?: number[][];
  indices?: number[] | Int32Array;
}

/** Pure: one item's wire triangle arrays against the model's, in order: indices exact, points
 * within `ulp` float32 ulps, colours float32-exact (a colour the model collapsed to one value
 * applies to every vertex). Returns problems and how many arrays used the allowance. */
export function compareTriangleArrays(
  want: readonly ModelTriangleArray[],
  got: readonly WireTriangleArray[],
  ulp: number,
  where: string,
): { problems: string[]; compared: number; ulpUsed: number } {
  const problems: string[] = [];
  let ulpUsed = 0;
  if (got.length !== want.length)
    return {
      problems: [
        `${where}: ${got.length} triangle arrays on the wire, the model's lowering has ${want.length} (${want.map((w) => w.box).join(",")})`,
      ],
      compared: 0,
      ulpUsed: 0,
    };
  want.forEach((w, k) => {
    const g = got[k];
    const points = g.points ?? [];
    const colors = g.colors ?? [];
    const indices = [...(g.indices ?? [])];
    if (JSON.stringify(indices) !== JSON.stringify(w.indices)) {
      problems.push(
        `${where} ${w.box}: ${indices.length} indices differ from the model's ${w.indices.length}`,
      );
      return;
    }
    if (points.length !== w.points.length) {
      problems.push(
        `${where} ${w.box}: ${points.length} points, the model has ${w.points.length}`,
      );
      return;
    }
    let worst = 0;
    w.points.forEach((p, i) => {
      for (let a = 0; a < 2; a++)
        worst = Math.max(worst, ulpDistance(p[a], points[i][a]));
    });
    if (worst > ulp)
      problems.push(
        `${where} ${w.box}: a point is ${worst} ulp from the model (allowance ${ulp})`,
      );
    else if (worst > 0) ulpUsed++;
    const colourBad = w.colors.some(
      (c, i) =>
        colors[i] === undefined ||
        c.some((v, j) => Math.fround(v) !== colors[i][j]),
    );
    if (colourBad || colors.length !== w.colors.length)
      problems.push(
        `${where} ${w.box}: vertex colours differ from the model's`,
      );
  });
  return { problems, compared: want.length, ulpUsed };
}

/** Every item of an HD shot that draws an antialiased StyleBoxFlat (its half lowering differs:
 * `ops_half`), with the op list one presentation draws. Items sharing a wire item (a sub-shape
 * named `<item>.<part>`, e.g. PB's bar) are merged into it in paint order. */
export function styleboxItemsHd(
  e: Pick<Gate6HdExpected, "op_lists">,
  shot: Gate6HdExpected["shots"][number],
  pres: "native" | "half",
): Map<string, MeshOp[]> {
  const out = new Map<string, MeshOp[]>();
  const owners = new Set(
    shot.items
      .filter((i) => i.ops_half !== undefined)
      .map((i) => owner(i.name)),
  );
  for (const i of shot.items) {
    const name = owner(i.name);
    if (!owners.has(name)) continue;
    const key = pres === "half" ? (i.ops_half ?? i.ops) : i.ops;
    const ops = (e.op_lists[key] ?? []) as unknown as MeshOp[];
    out.set(name, [...(out.get(name) ?? []), ...ops]);
  }
  return out;
}

/** `c0.PB.bar` -> `c0.PB`: the model's sub-shapes of one engine item share its wire item. */
function owner(name: string): string {
  return name.split(".").slice(0, 2).join(".");
}

export function evaluateStyleboxAaScale(
  e: Gate6HdExpected,
  wire: Pick<Wire5, "transactions">,
  ids: ReadonlyMap<string, number>,
  pres: "native" | "half",
  label: string,
): { problems: string[]; compared: number; ulpUsed: number; items: number } {
  const problems: string[] = [];
  let compared = 0;
  let ulpUsed = 0;
  const seen = new Set<string>();
  for (const shot of e.shots) {
    if (shot.kind !== "settle") continue;
    const tx = txAt(wire.transactions, shot.frame);
    if (!tx) {
      problems.push(
        `${label} ${shot.id}: no transaction at frame ${shot.frame}`,
      );
      continue;
    }
    for (const [name, ops] of styleboxItemsHd(e, shot, pres)) {
      const id = ids.get(name);
      const item = tx.state.items.find((i) => i.id === id);
      if (!item) {
        problems.push(`${label} ${shot.id} ${name}: no wire item`);
        continue;
      }
      seen.add(name);
      const want = modelTriangleArrays(ops);
      const got = (item.commands as unknown as WireTriangleArray[]).filter(
        (c) => c.op === "add_triangle_array",
      );
      const r = compareTriangleArrays(
        want,
        got,
        2,
        `${label} ${shot.id} ${name}`,
      );
      problems.push(...r.problems);
      compared += r.compared;
      ulpUsed += r.ulpUsed;
    }
  }
  return { problems, compared, ulpUsed, items: seen.size };
}

// ---------------------------------------------------------------------------------------------
// atlas-parity-half
// ---------------------------------------------------------------------------------------------

/** Pure: splits the half oracle's pages by font size. Per font key, the sizes the native oracle
 * reads (oversampling 1) are the logical sizes; at half each must have its page at size x
 * `scale` too (the drawn, oversampled one), and every other half page must be one of those. The
 * logical-size pages at half are shaping-only (see atlas-parity-half). */
export function splitHalfPages(
  half: HdOracleLog,
  native: HdOracleLog,
  scale: number,
): {
  drawn: OracleLog6;
  shaping: Map<number, string[]>;
  shapingCells: number;
  problems: string[];
} {
  const problems: string[] = [];
  const logical = new Map<string, Set<number>>();
  for (const line of native.lines)
    for (const p of line.pages) {
      const set = logical.get(p.font_key) ?? new Set<number>();
      set.add(p.size);
      logical.set(p.font_key, set);
    }
  const shaping = new Map<number, string[]>();
  let shapingCells = 0;
  const lines = half.lines.map((line) => {
    const drawn = line.pages.filter((p) => {
      const sizes = logical.get(p.font_key);
      if (sizes?.has(p.size)) {
        shaping.set(line.step, [...(shaping.get(line.step) ?? []), p.sha256]);
        shapingCells++;
        return false;
      }
      if (![...(sizes ?? [])].some((s) => Math.round(s * scale) === p.size))
        problems.push(
          `step ${line.step}: half page ${p.font_key}/${p.size} is neither a logical size nor a logical size x ${scale}`,
        );
      return true;
    });
    for (const [key, sizes] of logical)
      for (const size of sizes)
        if (
          !drawn.some(
            (p) => p.font_key === key && p.size === Math.round(size * scale),
          )
        )
          problems.push(
            `step ${line.step}: no half page ${key}/${Math.round(size * scale)} for the logical ${key}/${size}`,
          );
    return { ...line, pages: drawn };
  });
  const drawn = asOracle6({ ...half, lines: lines as HdOracleLog["lines"] });
  return { drawn, shaping, shapingCells, problems };
}

/** Pure: shaping-only page hashes that a wire texture carries (none is drawn, so none may). */
export function shapingPagesOnWire(
  shaping: Map<number, string[]>,
  wire: Pick<Wire5, "transactions">,
): string[] {
  const hashes = new Set<string>();
  for (const list of shaping.values()) for (const h of list) hashes.add(h);
  const out = new Set<string>();
  for (const t of wire.transactions)
    for (const tex of t.state.textures)
      if (tex.hash && hashes.has(tex.hash)) out.add(tex.hash.slice(0, 12));
  return [...out].map((h) => `shaping-only page ${h} is a wire texture`);
}

// ---------------------------------------------------------------------------------------------
// Receivers: typed entries and the viewport block (receiver-typed-clean)
// ---------------------------------------------------------------------------------------------

interface AppliedViewport6 {
  display_server?: string;
  size_check?: string | null;
  presentation_size?: number[] | null;
  window_size?: number[] | null;
  oversampling?: number | null;
  presentation_check?: string | null;
  stretch_applied?: boolean;
}

/** The receiver-typed session entries (seq null, item null, name "viewport") an applied.json
 * carries, sorted. */
export function receiverTyped(applied: AppliedJson | undefined): string[] {
  const list =
    (
      applied as
        | { unsupported?: { seq?: unknown; name?: string; reason?: string }[] }
        | undefined
    )?.unsupported ?? [];
  return [
    ...new Set(
      list
        .filter((u) => u.seq === null && u.name === "viewport")
        .map((u) => u.reason ?? ""),
    ),
  ].sort();
}

/** Pure: an applied.json is render-stream-receiver-applied/6 whose viewport block reports the
 * presentation check `check`, `stretch` adopted or not, the window and oversampling the session
 * asked for when the check is ok, and exactly the receiver-typed reasons `typed`. */
export function evaluateAppliedViewport(
  applied: AppliedJson | undefined,
  want: {
    leg: string;
    check: "ok" | "mismatch" | "skipped-headless";
    stretch: boolean;
    presentation?: [number, number];
    oversampling?: number;
    typed: string[];
  },
): string[] {
  const problems: string[] = [];
  if (!applied) return [`${want.leg}: applied.json missing`];
  const a = applied as unknown as {
    schema?: string;
    viewport?: AppliedViewport6;
  };
  if (a.schema !== "render-stream-receiver-applied/6")
    problems.push(`${want.leg}: schema ${a.schema}`);
  const v = a.viewport ?? {};
  if (v.presentation_check !== want.check)
    problems.push(
      `${want.leg}: presentation_check ${v.presentation_check}, expected ${want.check}`,
    );
  if ((v.stretch_applied ?? false) !== want.stretch)
    problems.push(
      `${want.leg}: stretch_applied ${v.stretch_applied}, expected ${want.stretch}`,
    );
  if (
    want.presentation &&
    JSON.stringify(v.presentation_size) !== JSON.stringify(want.presentation)
  )
    problems.push(
      `${want.leg}: presentation_size ${JSON.stringify(v.presentation_size)}, expected ${JSON.stringify(want.presentation)}`,
    );
  if (
    want.check === "ok" &&
    want.presentation &&
    JSON.stringify(v.window_size) !== JSON.stringify(want.presentation)
  )
    problems.push(
      `${want.leg}: window ${JSON.stringify(v.window_size)} != presentation ${JSON.stringify(want.presentation)}`,
    );
  if (
    want.check === "ok" &&
    want.oversampling !== undefined &&
    v.oversampling !== want.oversampling
  )
    problems.push(
      `${want.leg}: oversampling ${v.oversampling}, the session declares ${want.oversampling}`,
    );
  const typed = receiverTyped(applied);
  if (JSON.stringify(typed) !== JSON.stringify([...want.typed].sort()))
    problems.push(
      `${want.leg}: receiver-typed ${JSON.stringify(typed)}, expected ${JSON.stringify(want.typed)}`,
    );
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The hazard: which regions a host at the wrong presentation can change
// ---------------------------------------------------------------------------------------------

export type HazardKind = "flat" | "text" | "aa" | "text+aa";

/** Per region base name (`SC`, `HB`, ..., `BG`): `text` when an item drawn in it has undecided
 * text, `aa` when one draws an antialiased StyleBoxFlat (its half lowering differs), both, or
 * neither (`flat`: every command is independent of the host's window size). From the model's
 * shot 0 of the HD fixture, cell 0 (every cell is the same scene). */
export function hazardKinds(
  e: Pick<Gate6HdExpected, "op_lists" | "shots">,
): Record<string, HazardKind> {
  const text = new Set<string>();
  const aa = new Set<string>();
  const all = new Set<string>(["BG"]);
  for (const shot of e.shots)
    for (const item of shot.items) {
      const base = item.region.replace(/^c\d+\./, "");
      all.add(base);
      if (item.ops_half !== undefined) aa.add(base);
      const ops = (e.op_lists[item.ops] ?? []) as unknown as MeshOp[];
      if (ops.some((o) => o.kind === "undecided")) text.add(base);
    }
  const out: Record<string, HazardKind> = {};
  for (const r of [...all].sort())
    out[r] =
      text.has(r) && aa.has(r)
        ? "text+aa"
        : text.has(r)
          ? "text"
          : aa.has(r)
            ? "aa"
            : "flat";
  return out;
}

/** Pure: the hazard's differing pixels per region base name (summed over cells and shots) against
 * the kinds: every flat region equal, the text-only and the aa-only regions each differing
 * somewhere (D1, D2's evidence). */
export function evaluateHazard(
  counts: Record<string, number>,
  kinds: Record<string, HazardKind>,
): string[] {
  const problems: string[] = [];
  let text = 0;
  let aa = 0;
  for (const [r, kind] of Object.entries(kinds)) {
    const n = counts[r] ?? 0;
    if (kind === "flat" && n > 0)
      problems.push(`flat region ${r} differs in ${n} pixel-shots`);
    if (kind === "text") text += n;
    if (kind === "aa") aa += n;
  }
  if (text === 0) problems.push("no text-only region differs");
  if (aa === 0) problems.push("no antialiased-only region differs");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

const HALF_RECEIVERS: {
  leg: string;
  dir: string;
  capture: "capture-half" | "capture-half-inline";
  sink: string;
}[] = [
  {
    leg: "receiver-hd-half",
    dir: "receiver-half",
    capture: "capture-half",
    sink: RECORDING_NAME,
  },
  {
    leg: "receiver-hd-half-patch",
    dir: "receiver-half-patch",
    capture: "capture-half",
    sink: PATCH_RECORDING_NAME,
  },
  {
    leg: "receiver-hd-half-inline",
    dir: "receiver-half-inline",
    capture: "capture-half-inline",
    sink: RECORDING_NAME,
  },
];

const HALF_XFORM = [0.5, 0, 0, 0.5, 0, 0];

function hudsOfScene(
  oracle: OracleLog6,
): (step: number) => { layer: number; sublayer: number }[] | null {
  return (step) => {
    const line = oracle.lines.find((l) => l.step === step);
    const hud = line?.canvas_layers.find((l) => l.name === "HUD");
    return hud ? [{ layer: hud.layer, sublayer: hud.sublayer }] : null;
  };
}

function hudsOfHd(
  oracle: HdOracleLog,
): (step: number) => { layer: number; sublayer: number }[] | null {
  return (step) => {
    const line = oracle.lines.find((l) => l.step === step);
    if (!line) return null;
    const out: { layer: number; sublayer: number }[] = [];
    for (const c of [...line.cells].sort((a, b) => a.cell - b.cell)) {
      const hud = c.canvas_layers.find((l) => l.name === "HUD");
      if (!hud) return null;
      out.push({ layer: hud.layer, sublayer: hud.sublayer });
    }
    return out;
  };
}

export async function runGate6b(
  out: string,
  scene: Gate6Expected,
  hd: Gate6HdExpected,
): Promise<Gate6bResult> {
  const checks: Gate6Check[] = [];
  const legs: Record<string, G6bLegEntry> = {};
  const mismatchTables: Record<string, Record<string, string[]>> = {};
  const census: Record<string, string> = {};
  const H = join(out, G6B_DIRS.hd);
  const S = join(out, G6B_DIRS.scene);
  const P = join(out, G6B_DIRS.snap);

  // Captures: classes.
  const caps = new Map<string, Gate3CaptureEvaluation>();
  const capLegs: {
    leg: string;
    base: string;
    dir: string;
    want: [string, string][];
  }[] = [
    { leg: "capture-hd-half", base: H, dir: "capture-half", want: [] },
    {
      leg: "capture-hd-half-inline",
      base: H,
      dir: "capture-half-inline",
      want: [],
    },
    {
      leg: "capture-hd-half-at-logical",
      base: H,
      dir: "capture-half-at-logical",
      want: [],
    },
    {
      leg: "capture-snap",
      base: P,
      dir: "capture",
      want: [["viewport_set_snap_2d_transforms_to_pixel", "snap-2d"]],
    },
  ];
  for (const c of capLegs) {
    const ev = await evaluateCapture(c.base, {
      legDir: c.dir,
      expectedClass: wantedClass(c.want),
    });
    caps.set(c.leg, ev);
    const pairs = unsupportedPairs(ev.full);
    const problems = evaluateUnsupportedClass(ev, pairs, c.want);
    checks.push(
      check(
        `leg-class-${c.leg}`,
        c.want.length > 0
          ? `the ${c.leg} leg classifies unsupported with exactly ${c.want.map((w) => w.join("/")).join(", ")} on render-stream/6: armed, stream closed, both sinks valid and equivalent, no capture failure`
          : `the ${c.leg} leg classifies success on render-stream/6 (no unsupported entry: the nine HUD layers at distinct keys, no snap, no global canvas transform change): armed, stream closed, both sinks valid and equivalent, no capture failure`,
        problems,
        `${ev.result_class}: ${pairs.join(", ") || "nothing typed"}`,
        ev.artifacts,
      ),
    );
    legs[c.leg] = {
      group: "g6b",
      expected_class: wantedClass(c.want),
      result_class: ev.result_class,
      reasons: ev.reasons,
      exit_code: ev.exit_code,
      artifacts: ev.artifacts,
    };
  }
  const half = caps.get("capture-hd-half") as Gate3CaptureEvaluation;
  const halfInline = caps.get(
    "capture-hd-half-inline",
  ) as Gate3CaptureEvaluation;
  const atLogical = caps.get(
    "capture-hd-half-at-logical",
  ) as Gate3CaptureEvaluation;
  const snap = caps.get("capture-snap") as Gate3CaptureEvaluation;
  const sceneCap = await evaluateCapture(S, {
    legDir: "capture",
    expectedClass: wantedClass(scene.unsupported),
  });
  const nativeCap = await evaluateCapture(H, {
    legDir: "capture-native",
    expectedClass: wantedClass(hd.unsupported),
  });

  // presentation-declared
  {
    const scenePres = {
      logical_size: [640, 360] as [number, number],
      stretch_mode: "disabled",
      root_size_policy: "enforce-min-size",
      presentation_size: [640, 360] as [number, number],
      host_window_size: [640, 360] as [number, number],
      font_oversampling: 1,
      snap_2d: { transforms: false, vertices: false },
      host_final_xform: [1, 0, 0, 1, 0, 0],
    };
    const native = {
      logical_size: [1920, 1080] as [number, number],
      stretch_mode: "canvas_items",
      root_size_policy: "enforce-min-size",
      presentation_size: [1920, 1080] as [number, number],
      host_window_size: [1920, 1080] as [number, number],
      font_oversampling: 1,
      snap_2d: { transforms: false, vertices: false },
      host_final_xform: [1, 0, 0, 1, 0, 0],
    };
    const halfWant = {
      ...native,
      root_size_policy: "presentation",
      presentation_size: HALF_SIZE,
      host_window_size: HALF_SIZE,
      font_oversampling: 0.5,
      host_final_xform: HALF_XFORM,
    };
    const problems = [
      ...evaluateSessionDeclared(half.full, {
        label: "capture-hd-half full",
        ...halfWant,
      }),
      ...evaluateSessionDeclared(half.patch, {
        label: "capture-hd-half patch",
        ...halfWant,
      }),
      ...evaluateSessionDeclared(halfInline.full, {
        label: "capture-hd-half-inline",
        ...halfWant,
      }),
      ...evaluateSessionDeclared(nativeCap.full, {
        label: "capture-hd-native",
        ...native,
      }),
      ...evaluateSessionDeclared(atLogical.full, {
        label: "capture-hd-half-at-logical",
        ...native,
      }),
      ...evaluateSessionDeclared(sceneCap.full, {
        label: "capture-scene",
        ...scenePres,
      }),
      ...evaluateSessionDeclared(snap.full, {
        label: "capture-snap",
        ...scenePres,
        snap_2d: { transforms: true, vertices: false },
      }),
    ];
    checks.push(
      check(
        "presentation-declared",
        "every /6 capture's session declares what its policy made the host evaluate: capture-hd-half (GRC_ROOT_SIZE=presentation:960x540) root_size_policy presentation, presentation_size and host_window_size 960x540, host_size_status match, font_oversampling 0.5, host_visible_rect the logical 1920x1080 and host_final_xform scale 0.5 (on both sinks and the inline capture); capture-hd-native and the hazard's capture enforce-min-size at 1920x1080 with oversampling 1 and the identity; capture-scene and capture-snap 640x360, oversampling 1, stretch disabled; snap_2d false except capture-snap's transforms; every file sink's publication every-frame/null",
        problems.slice(0, 10),
        `half: ${JSON.stringify((half.full.session as unknown as { viewport?: ViewportMeta6 } | undefined)?.viewport)}`,
        [
          half.full.path,
          nativeCap.full.path,
          sceneCap.full.path,
          snap.full.path,
        ],
      ),
    );
  }

  // snap-typed
  {
    const problems = [
      ...evaluateSessionEntries(
        snap.full,
        [["viewport_set_snap_2d_transforms_to_pixel", "snap-2d"]],
        "capture-snap full",
      ),
      ...evaluateSessionEntries(
        snap.patch,
        [["viewport_set_snap_2d_transforms_to_pixel", "snap-2d"]],
        "capture-snap patch",
      ),
    ];
    checks.push(
      check(
        "snap-typed",
        "capture-snap (a scratch copy of gate6-scene with override.cfg rendering/2d/snap/snap_2d_transforms_to_pixel=true, Q6d) declares snap_2d {transforms: true, vertices: false} (presentation-declared) and every transaction of both sinks carries exactly one unsupported entry, the session-level {op: viewport_set_snap_2d_transforms_to_pixel, item: null, reason: snap-2d} (D17: declared at arm, typed, never replayed)",
        problems.slice(0, 8),
        `${snap.full.transactions.length} transactions, each typed snap-2d`,
        [snap.full.path, snap.patch.path],
      ),
    );
  }

  // canvas-commands
  {
    const problems: string[] = [];
    const details: string[] = [];
    for (const [label, dir, quit] of [
      ["capture-scene", join(S, "capture"), scene.capture_quit_frame],
      ["capture-hd-half", join(H, "capture-half"), hd.quit_frame_default],
    ] as const) {
      const log = await loadResourceLog(dir);
      if (log.problem)
        problems.push(`${label} resources.jsonl: ${log.problem}`);
      const state = canvasLogState(log.lines);
      for (const sink of [RECORDING_NAME, PATCH_RECORDING_NAME]) {
        const wire = await loadWire5(join(dir, sink));
        if (wire.error) problems.push(`${label} ${sink}: ${wire.error}`);
        const r = evaluateCanvasCommands(wire, state, quit, `${label} ${sink}`);
        problems.push(...r.problems);
        details.push(r.detail);
      }
    }
    checks.push(
      check(
        "canvas-commands",
        "on both sinks of capture-scene and capture-hd-half, every layer canvas's wire state equals the hook log's last calibrator-9 line at or before each transaction's frame (layer and sublayer from viewport_set_canvas_stacking, attached until a viewport_remove_canvas), each canvas matched to its RID by its first stacking line; the root canvas stays attached at (0,0); no transaction carries a canvas-stacking-tie, and every layer is first published on its own key, never the attach default (0,0): the stacking lands in the attach frame (Q1e's prediction)",
        problems.slice(0, 10),
        details.join("; "),
        [join(S, "capture"), join(H, "capture-half")],
      ),
    );
  }

  // canvas-stacking-parity
  {
    const oScene = await loadOracle6(join(S, "reference"), "reference-scene");
    const oHalf = await loadHdOracle(
      join(H, "reference-half"),
      "reference-hd-half",
    );
    const problems: string[] = [];
    let compared = 0;
    for (const sink of [RECORDING_NAME, PATCH_RECORDING_NAME]) {
      const w = await loadWire5(join(S, "capture", sink));
      const a = evaluateStackingParity(
        scene.steps,
        hudsOfScene(oScene),
        w,
        `capture-scene ${sink}`,
      );
      problems.push(...a.problems);
      compared += a.compared;
      const wh = await loadWire5(join(H, "capture-half", sink));
      const b = evaluateStackingParity(
        hd.steps,
        hudsOfHd(oHalf),
        wh,
        `capture-hd-half ${sink}`,
      );
      problems.push(...b.problems);
      compared += b.compared;
    }
    checks.push(
      check(
        "canvas-stacking-parity",
        "at every settle step, the wire's layer canvases carry exactly the (layer, sublayer) the rendered reference's oracle reads from the CanvasLayer nodes (layer, get_index()): the scene's HUD at 1, -1 (step 9) and 1 again, the HD fixture's nine HUDs at 1 + c (-1 - c at step 9) on capture-hd-half against reference-hd-half's oracle, on both sinks",
        problems.slice(0, 10),
        `${compared} canvas-steps equal the oracle`,
        [oScene.path, oHalf.path],
      ),
    );
  }

  // atlas-parity-half
  const wireHalf = await loadWire5(join(H, "capture-half", RECORDING_NAME));
  const wireHalfPatch = await loadWire5(
    join(H, "capture-half", PATCH_RECORDING_NAME),
  );
  {
    const oHalf = await loadHdOracle(
      join(H, "reference-half"),
      "reference-hd-half",
    );
    const oNative = await loadHdOracle(
      join(H, "reference-native"),
      "reference-hd-native",
    );
    const view = {
      steps: hd.steps,
      hook_census: { atlas_format: "LA8" },
    } as unknown as Pick<Gate6Expected, "steps" | "hook_census">;
    const split = splitHalfPages(oHalf, oNative, 0.5);
    const a = evaluateAtlasParity6(view, split.drawn, wireHalf);
    const b = evaluateAtlasParity6(view, split.drawn, wireHalfPatch);
    const shapingOnWire = shapingPagesOnWire(split.shaping, wireHalf);
    checks.push(
      check(
        "atlas-parity-half",
        "at every settle step, each atlas page reference-hd-half's oracle reads back at the oversampled sizes (the native oracle's font sizes x 0.5: rasterized at oversampling 0.5 by the rendered 960x540 reference) is the hash of exactly one ok image texture in capture-hd-half's settle transaction, and every ok LA8 image there is such a page, on both sinks: a headless host at presentation:960x540 rasterizes the reference's own glyph atlases (D2). The oracle's pages at the logical sizes (the native oracle's sizes) are shaping-only at half -- the TextServer rasterizes them to measure text at the logical size, nothing draws them, so no GPU texture is ever made of them -- and none is on the wire",
        [
          ...(wireHalf.error ? [`full: ${wireHalf.error}`] : []),
          ...split.problems,
          ...a.problems,
          ...b.problems.map((p) => `patch: ${p}`),
          ...shapingOnWire,
        ].slice(0, 10),
        `${a.pages} drawn page cells (${Object.entries(a.table)
          .map(([k, n]) => `${k}:${n}`)
          .join(
            " ",
          )}); ${split.shapingCells} shaping-only page cells at the logical sizes`,
        [oHalf.path, oNative.path, wireHalf.path, wireHalfPatch.path],
      ),
    );
    census["capture-hd-half"] =
      `full ${half.full.bytes} B, patch ${half.patch.bytes} B, inline ${halfInline.full.bytes} B`;
  }

  // stylebox-aa-scale
  {
    const order = [
      ...hd.creation_order,
      ...hd.created_later.map((c) => c.name),
    ];
    const namesHalf = nameIds6(wireHalf.transactions, order);
    const wireNative = await loadWire5(
      join(H, "capture-native", RECORDING_NAME),
    );
    const namesNative = nameIds6(wireNative.transactions, order);
    const a = evaluateStyleboxAaScale(
      hd,
      wireHalf,
      namesHalf.ids,
      "half",
      "capture-hd-half",
    );
    const b = evaluateStyleboxAaScale(
      hd,
      wireNative,
      namesNative.ids,
      "native",
      "capture-hd-native",
    );
    checks.push(
      check(
        "stylebox-aa-scale",
        "at every settle step, every antialiased StyleBoxFlat (panels, scrollbars, buttons, the LineEdits, the progress bars; every item whose half lowering differs) draws on capture-hd-half exactly the triangle arrays gate 5g's float32 port gives at aa_size / 0.5 (sbf.cpp:497-511: the host evaluated the root's 0.5 stretch), and on capture-hd-native the arrays at aa_size: indices exact, points within 2 ulp, vertex colours float32-exact",
        [...namesHalf.problems, ...a.problems, ...b.problems].slice(0, 10),
        `half: ${a.compared} arrays over ${a.items} items (${a.ulpUsed} used the 2-ulp allowance); native: ${b.compared} arrays (${b.ulpUsed})`,
        [wireHalf.path, wireNative.path],
      ),
    );
  }

  // The half shots, one at a time: receivers, the hazard, ignore-presentation.
  const refDir = join(H, "reference-half");
  const legDirs: { leg: string; dir: string; recording: RecordingSummary }[] = [
    ...HALF_RECEIVERS.map((r) => ({
      leg: r.leg,
      dir: join(H, r.dir),
      recording:
        r.capture === "capture-half"
          ? r.sink === PATCH_RECORDING_NAME
            ? half.patch
            : half.full
          : halfInline.full,
    })),
    {
      leg: "receiver-hd-half-at-logical",
      dir: join(H, "receiver-half-at-logical"),
      recording: atLogical.full,
    },
    {
      leg: "sabotage-receiver-ignore-presentation",
      dir: join(H, "sabotage-receiver-ignore-presentation"),
      recording: half.full,
    },
  ];
  const diffs = new Map<string, { shot: string; diff: FrameDiffHd | null }[]>();
  const seqsOf = new Map<string, Map<string, number>>();
  for (const l of legDirs) {
    diffs.set(l.leg, []);
    seqsOf.set(
      l.leg,
      shotSeqs(hd.shots as unknown as Gate6Shot[], l.recording.transactions),
    );
  }
  const none = new Set<string>();
  for (const shot of hd.shots) {
    const ref = await loadFrame(join(refDir, "shots", `${shot.id}.png`));
    const ri = regionIndexHd(
      shot.regions as Record<string, Box>,
      HALF_SIZE[0],
      HALF_SIZE[1],
      0.5,
    );
    for (const l of legDirs) {
      const seq = seqsOf.get(l.leg)?.get(shot.id);
      const got =
        seq === undefined
          ? null
          : await loadFrame(join(l.dir, "shots", `seq-${seq}.png`));
      const diff =
        ref && got && ref.width === got.width && ref.height === got.height
          ? diffFramesHd(ref, got, ri, none)
          : null;
      diffs.get(l.leg)?.push({ shot: shot.id, diff });
    }
  }

  // Honest half receivers.
  const vsRef: string[] = [];
  const vsDetail: string[] = [];
  const typedProblems: string[] = [];
  const classify = async (
    leg: string,
    dir: string,
    captureResult: Gate3CaptureEvaluation,
    recording: RecordingSummary,
  ) => {
    const applied = await readJson<AppliedJson>(join(dir, "applied.json"));
    const requested = await requestedSeqs(dir);
    const seqs = seqsOf.get(leg) ?? new Map<string, number>();
    const cps: Checkpoint[] = (diffs.get(leg) ?? []).map((d) => ({
      step: Number(d.shot.replace(/^\D+/, "")),
      settle_frame: hd.shots.find((s) => s.id === d.shot)?.frame ?? 0,
      seq: seqs.get(d.shot) ?? null,
      reference_png: join(refDir, "shots", `${d.shot}.png`),
      receiver_png: join(dir, "shots", `seq-${seqs.get(d.shot)}.png`),
      diff_png: null,
      mismatched_pixels: d.diff?.mismatched ?? null,
      max_channel_delta: d.diff?.max_delta ?? null,
      regions: [],
    }));
    const cls = classifyLeg({
      captureResult: captureResult.captureResult,
      recording,
      receiver: {
        applied,
        requestedShotSeqs: requested,
        shotFiles: await shotFiles(dir, requested),
      },
      checkpoints: cps,
    });
    return { applied, cls };
  };
  for (const r of HALF_RECEIVERS) {
    const l = legDirs.find((x) => x.leg === r.leg) as (typeof legDirs)[number];
    const capEval = r.capture === "capture-half" ? half : halfInline;
    const { applied, cls } = await classify(r.leg, l.dir, capEval, l.recording);
    const d = diffs.get(r.leg) ?? [];
    const problems = evaluateUnsupportedClass(
      cls,
      unsupportedPairs(l.recording),
      [],
    );
    if (appliedPairs(applied).length > 0)
      problems.push(
        `applied.json unsupported ${JSON.stringify(appliedPairs(applied))}`,
      );
    const typed = evaluateAppliedViewport(applied, {
      leg: r.leg,
      check: "ok",
      stretch: true,
      presentation: HALF_SIZE,
      oversampling: 0.5,
      typed: [],
    });
    typedProblems.push(...typed);
    const table: Record<string, string[]> = {};
    let any = false;
    let missing = false;
    for (const x of d) {
      if (!x.diff) {
        missing = true;
        vsRef.push(`${r.leg} ${x.shot}: shot missing`);
        continue;
      }
      table[x.shot] = Object.keys(x.diff.regions).sort();
      if (x.diff.mismatched > 0) {
        any = true;
        vsRef.push(
          `${r.leg} ${x.shot}: ${x.diff.mismatched} pixels differ (${table[x.shot].slice(0, 6).join(",")})`,
        );
      }
    }
    mismatchTables[r.leg] = table;
    const verdict = missing ? "incomplete" : any ? "pixel-mismatch" : "success";
    if (verdict !== "success") problems.push(`pixels ${verdict}`);
    checks.push(
      check(
        `leg-class-${r.leg}`,
        `the ${r.leg} leg (a rendered 960x540 receiver on ${r.capture}/${r.sink}) classifies success on render-stream/6: it adopted the session's canvas_items stretch (logical 1920x1080 at window 960x540), its presentation and oversampling checks are ok, it typed nothing, applied every seq, and every pixel of every shot equals reference-hd-half`,
        [...problems, ...typed].slice(0, 8),
        `${cls.result_class}, pixels ${verdict}`,
        [join(l.dir, "applied.json"), join(l.dir, "shots")],
      ),
    );
    legs[r.leg] = {
      group: "g6b",
      expected_class: "success",
      result_class: cls.result_class,
      pixel_verdict: verdict,
      expected_pixel_verdict: "success",
      reasons: cls.reasons,
      exit_code: await readExitCode(l.dir),
      artifacts: [join(l.dir, "applied.json"), join(l.dir, "shots")],
    };
    vsDetail.push(
      `${r.leg} ${d.reduce((n, x) => n + (x.diff?.compared ?? 0), 0)}`,
    );
  }
  checks.push(
    check(
      "receiver-vs-reference-half",
      "receiver-hd-half, -patch and -inline: every pixel of every shot (settle and intermediate, 960x540, all nine cells, HU included) equals reference-hd-half's, raw per channel with alpha; budget 0 (Q6g): a host evaluated at presentation:960x540 plus a receiver applying the session's stretch reproduce a 960x540 canvas_items presentation exactly",
      vsRef.slice(0, 10),
      `pixels compared: ${vsDetail.join(", ")}`,
      HALF_RECEIVERS.map((r) => join(H, r.dir, "shots")),
    ),
  );

  // The hazard.
  const hazardCounts: Record<string, number> = {};
  {
    const leg = "receiver-hd-half-at-logical";
    const l = legDirs.find((x) => x.leg === leg) as (typeof legDirs)[number];
    const { applied, cls } = await classify(leg, l.dir, atLogical, l.recording);
    const problems: string[] = [];
    if (cls.result_class !== "unsupported")
      problems.push(`class ${cls.result_class}, expected unsupported`);
    problems.push(
      ...evaluateAppliedViewport(applied, {
        leg,
        check: "mismatch",
        stretch: true,
        presentation: [1920, 1080],
        typed: ["oversampling-mismatch", "presentation-mismatch"],
      }),
    );
    if (unsupportedPairs(l.recording).length > 0)
      problems.push(
        `the capture typed ${unsupportedPairs(l.recording).join(",")}`,
      );
    const kinds = hazardKinds(hd);
    let missing = 0;
    for (const x of diffs.get(leg) ?? []) {
      if (!x.diff) {
        missing++;
        continue;
      }
      for (const [region, n] of Object.entries(x.diff.regions)) {
        const base = region.replace(/^c\d+\./, "");
        hazardCounts[base] = (hazardCounts[base] ?? 0) + n;
      }
    }
    if (missing > 0) problems.push(`${missing} shots missing`);
    problems.push(...evaluateHazard(hazardCounts, kinds));
    const byKind = Object.entries(kinds)
      .map(([r, k]) => `${r}(${k}):${hazardCounts[r] ?? 0}`)
      .join(" ");
    checks.push(
      check(
        "presentation-hazard-measured",
        "the hazard: capture-hd-half-at-logical (enforce-min-size: the host evaluates a 1920x1080 window, oversampling 1, feather aa_size) replayed by a receiver presented at 960x540 classifies unsupported, typed by the receiver as presentation-mismatch (window 960x540, presentation_size 1920x1080) and oversampling-mismatch (0.5 vs the declared 1), still drawn; against reference-hd-half every flat region (commands independent of the host window) is equal, while the text-only regions (RT, LB: atlases rasterized at oversampling 1) and the antialiased-only region (HB: the feather at aa_size, not aa_size / 0.5) each differ: the evidence for D1 and D2, counts per region reported",
        problems.slice(0, 10),
        `${cls.result_class}; differing pixel-shots per region (kind): ${byKind}`,
        [join(l.dir, "applied.json"), join(l.dir, "shots")],
      ),
    );
    legs[leg] = {
      group: "g6b",
      expected_class: "unsupported",
      result_class: cls.result_class,
      reasons: cls.reasons,
      exit_code: await readExitCode(l.dir),
      artifacts: [join(l.dir, "applied.json"), join(l.dir, "shots")],
    };
    mismatchTables[leg] = Object.fromEntries(
      (diffs.get(leg) ?? []).map((x) => [
        x.shot,
        x.diff ? Object.keys(x.diff.regions).sort() : [],
      ]),
    );
  }

  // sabotage-receiver-ignore-presentation: every region of every shot differs.
  {
    const leg = "sabotage-receiver-ignore-presentation";
    const l = legDirs.find((x) => x.leg === leg) as (typeof legDirs)[number];
    const { applied, cls } = await classify(leg, l.dir, half, l.recording);
    const problems: string[] = [];
    // The receiver keeps stretch disabled, so its oversampling (1) is not the session's 0.5:
    // oversampling-mismatch is typed, the window matches the presentation.
    if (cls.result_class !== "unsupported")
      problems.push(
        `class ${cls.result_class}, expected unsupported (oversampling-mismatch)`,
      );
    problems.push(
      ...evaluateAppliedViewport(applied, {
        leg,
        check: "mismatch",
        stretch: false,
        presentation: HALF_SIZE,
        typed: ["oversampling-mismatch"],
      }),
    );
    const table: Record<string, string[]> = {};
    let shotsAll = 0;
    for (const x of diffs.get(leg) ?? []) {
      const shot = hd.shots.find((s) => s.id === x.shot);
      if (!x.diff || !shot) {
        problems.push(`${x.shot}: shot missing`);
        continue;
      }
      const differ = Object.keys(x.diff.regions).sort();
      table[x.shot] = differ;
      const want = [...Object.keys(shot.regions), "BG"].sort();
      const same = want.filter((r) => !differ.includes(r));
      if (same.length === 0) shotsAll++;
      else
        problems.push(
          `${x.shot}: ${same.length} regions equal the reference (${same.slice(0, 6).join(",")})`,
        );
    }
    mismatchTables[leg] = table;
    checks.push(
      check(
        `leg-class-${leg}`,
        "RS_RECEIVER_SABOTAGE=ignore-presentation (a 960x540 receiver that keeps stretch disabled whatever the session says) on capture-hd-half differs from reference-hd-half in every region of every cell and BG at every shot (Q6h: it presents the top-left quarter of the logical frame at scale 1), and is typed oversampling-mismatch (its own 1 against the declared 0.5) with presentation_check mismatch",
        problems.slice(0, 8),
        `${cls.result_class}; ${shotsAll} of ${hd.shots.length} shots differ in every region`,
        [join(l.dir, "applied.json"), join(l.dir, "shots")],
      ),
    );
    legs[leg] = {
      group: "g6b",
      expected_class: "unsupported",
      result_class: cls.result_class,
      pixel_verdict:
        shotsAll === hd.shots.length ? "pixel-mismatch" : "incomplete",
      expected_pixel_verdict: "pixel-mismatch",
      reasons: cls.reasons,
      exit_code: await readExitCode(l.dir),
      artifacts: [join(l.dir, "applied.json"), join(l.dir, "shots")],
    };
  }

  // sabotage-receiver-ignore-canvas-stacking (scene): Q6h's set as make_expected.py recomputes it.
  {
    const leg = "sabotage-receiver-ignore-canvas-stacking";
    const dir = join(S, leg);
    const recording = sceneCap.full;
    const seqs = shotSeqs(scene.shots, recording.transactions);
    const ref = await loadReferenceShots6(join(S, "reference"), scene.shots);
    const shots = await loadReceiverShots6(dir, scene.shots, seqs);
    const d = compareShots6(scene.shots, ref, shots, none);
    const applied = await readJson<AppliedJson>(join(dir, "applied.json"));
    const requested = await requestedSeqs(dir);
    const cps: Checkpoint[] = d.map((x) => ({
      step: Number(x.shot.replace(/^\D+/, "")),
      settle_frame: scene.shots.find((s) => s.id === x.shot)?.frame ?? 0,
      seq: seqs.get(x.shot) ?? null,
      reference_png: join(S, "reference", "shots", `${x.shot}.png`),
      receiver_png: join(dir, "shots", `seq-${seqs.get(x.shot)}.png`),
      diff_png: null,
      mismatched_pixels: x.diff?.mismatched ?? null,
      max_channel_delta: x.diff?.max_delta ?? null,
      regions: [],
    }));
    const cls = classifyLeg({
      captureResult: sceneCap.captureResult,
      recording,
      receiver: {
        applied,
        requestedShotSeqs: requested,
        shotFiles: await shotFiles(dir, requested),
      },
      checkpoints: cps,
    });
    const problems = evaluateUnsupportedClass(
      cls,
      unsupportedPairs(recording),
      scene.unsupported,
      true,
    );
    const pv = evaluatePixelVerdict(
      d,
      "pixel-mismatch",
      scene.predictions[`sabotage-receiver-${"ignore-canvas-stacking"}`]?.shots,
    );
    problems.push(...pv.problems);
    if (!scene.predictions["sabotage-receiver-ignore-canvas-stacking"])
      problems.push(
        "expected.json has no sabotage-receiver-ignore-canvas-stacking prediction",
      );
    const stacking = (
      applied as unknown as {
        resources_summary?: {
          canvas_stacking_sets?: number;
          canvas_attach?: number;
        };
      }
    )?.resources_summary;
    if ((stacking?.canvas_stacking_sets ?? -1) !== 0)
      problems.push(
        `the sabotaged receiver made ${stacking?.canvas_stacking_sets} stacking calls, expected 0`,
      );
    mismatchTables[leg] = pv.table;
    checks.push(
      check(
        `leg-class-${leg}`,
        "RS_RECEIVER_SABOTAGE=ignore-canvas-stacking (attaches the HUD's canvas, never stacks it) on capture-scene classifies pixel-mismatch and differs from reference-scene at exactly expected.json predictions[\"sabotage-receiver-ignore-canvas-stacking\"]: HU while the HUD shows at a negative layer (step 9 and frame 93), where the unstacked canvas draws over BG instead of behind it; at layer 1 the attach default (0,0) already draws after the root canvas (canvas RID order, rv.h:125-130), so no other shot differs (As built G6b amends Q6h's {0..7, 10})",
        problems.slice(0, 8),
        `${cls.result_class}, pixels ${pv.verdict}: ${Object.entries(pv.table)
          .filter(([, v]) => v.length > 0)
          .map(([k, v]) => `${k}:${v.join("+")}`)
          .join(" ")}`,
        [join(dir, "applied.json"), join(dir, "shots")],
      ),
    );
    legs[leg] = {
      group: "g6b",
      expected_class: "pixel-mismatch",
      result_class: cls.result_class,
      pixel_verdict: pv.verdict,
      expected_pixel_verdict: "pixel-mismatch",
      reasons: cls.reasons,
      exit_code: await readExitCode(dir),
      artifacts: [join(dir, "applied.json"), join(dir, "shots")],
    };
  }

  // receiver-typed-clean: every honest rendered receiver of gate 6.
  {
    const honest: {
      leg: string;
      dir: string;
      stretch: boolean;
      presentation: [number, number];
      oversampling: number;
    }[] = [
      ...[
        "scene/receiver",
        "scene/receiver-patch",
        "scene/receiver-inline",
        "animate/receiver",
        "refused/receiver",
        "scene/sabotage-receiver-ignore-clip",
        "scene/sabotage-receiver-stale-texture",
        "scene/sabotage-receiver-ignore-canvas-stacking",
      ].map((d) => ({
        leg: d,
        dir: join(out, d),
        stretch: false,
        presentation: [640, 360] as [number, number],
        oversampling: 1,
      })),
      ...["hd/receiver-native", "hd/receiver-native-patch"].map((d) => ({
        leg: d,
        dir: join(out, d),
        stretch: true,
        presentation: [1920, 1080] as [number, number],
        oversampling: 1,
      })),
    ];
    for (const h of honest) {
      const applied = await readJson<AppliedJson>(join(h.dir, "applied.json"));
      typedProblems.push(
        ...evaluateAppliedViewport(applied, {
          leg: h.leg,
          check: "ok",
          stretch: h.stretch,
          presentation: h.presentation,
          oversampling: h.oversampling,
          typed: [],
        }),
      );
    }
    checks.push(
      check(
        "receiver-typed-clean",
        "every honest rendered receiver of gate 6 (g6a's scene, animate and refused receivers and receiver sabotages, g6h's native receivers, g6b's half receivers) writes render-stream-receiver-applied/6 with presentation_check ok (its window equals the session's presentation_size and its oversampling the declared font_oversampling), stretch_applied exactly for the canvas_items sessions, and no receiver-typed entry (presentation-mismatch, oversampling-mismatch, stretch-mode); only the hazard and ignore-presentation type (checked by their own leg checks)",
        typedProblems.slice(0, 10),
        `${honest.length + HALF_RECEIVERS.length} receivers clean`,
        honest.map((h) => join(h.dir, "applied.json")),
      ),
    );
  }

  return {
    checks,
    legs,
    mismatch_tables: mismatchTables,
    census,
    hazard: hazardCounts,
  };
}
