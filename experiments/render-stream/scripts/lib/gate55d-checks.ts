// Gate 5.5d checks (protocol/gate5_5-design.md "G55d", D5-D10, D13-D15, Q3b, Q5, Q6b and the
// "As built (G55b)" amendments): render-stream/5's shader and material tables, CanvasItemMaterial
// end to end and the canvas modulate, over fixtures/gate55-cim in both scenes (base and variant
// `modulate`). Pure evaluators over values already read from a run-gate55.sh evidence directory,
// plus small loaders and runGate55d, which check-gate55.ts merges into the gate 5.5 report. Nothing
// here launches a process; scripts/test/self-test-gate55d.ts drives the evaluators with synthetic
// values. Classification never reads `session.sabotage`.
//
// Independent expectations only (D12): the capture's hook log (evidence/resources.jsonl, G55a's
// kind shader/material lines) is the ground truth for what the tables held per frame; the wire is
// compared against it (`material-commands`, D15's material-log-divergence). make_expected.py's
// CimSim (expected.json `rs_material_calls`, `builtin`, `effective`, `canvas_modulate`,
// `predictions`) predicts every step's material calls, blend and light mode, canvas modulate and
// sabotage region sets; the blend-aware raster (lib/geometry-raster.ts) and the rendered reference
// judge the receivers' pixels. The wire is never compared with itself.
//
// Legs (G55b amendment 8: under <out>/cim/ and <out>/cim-modulate/, beside g55b's capture and
// reference legs, which g55d reuses), named with the scene like g55b's:
//   capture-inline/                  400-frame capture, every payload inline, no store
//                                    -> capture-cim-inline
//   receiver/, receiver-patch/       rendered receivers on capture/'s full / patch sink (store);
//                                    receiver-patch also dumps state/seq-<n>.json at the settle seqs
//                                    -> receiver-cim, receiver-cim-patch
//   receiver-inline/                 rendered receiver on capture-inline/ -> receiver-cim-inline
//   (base only) sabotage-freeze/{capture,receiver}/            freeze-frame @11
//               sabotage-omit-material-set-shader/{capture,receiver}/   omit-op @21
//               sabotage-receiver-ignore-material/            RS_RECEIVER_SABOTAGE on capture/
//   (modulate only) sabotage-receiver-ignore-canvas-modulate/  RS_RECEIVER_SABOTAGE on capture/
//   <out>/cim/import/receiver/       editor --import of receiver/ (once per run)

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type AppliedJson,
  type CaptureResultJson,
  type Checkpoint,
  CLASS_PRECEDENCE,
  type Classification,
  classifyLeg,
  loadRecording,
  PATCH_RECORDING_NAME,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
} from "./gate0-checks";
import { loadResourceLog, type ResourceLine } from "./gate2-checks";
import { evaluateCapture } from "./gate3-checks";
import {
  check,
  compareLegs5,
  evaluateExpectedImage5,
  evaluateFreshness5,
  type Gate5Check,
  type Gate5Checkpoint,
  loadShots5,
  type RegionBudget5,
} from "./gate5-checks";
import {
  computeGate5Checkpoints,
  evaluateLegClass5,
  type Gate5LegExpectation,
  loadReceiverShots5,
  settleSeqs,
  shotSeqsPresent5,
} from "./gate5d-checks";
import {
  itemIdsByCreation,
  loadWire5,
  tableIdsOverRun,
  txAt,
  type Wire5,
  type Wire5Tx,
} from "./gate55-wire";
import {
  asGate5,
  expectedItemMaterials,
  GATE55_VARIANTS,
  type Gate55Expected,
  type Gate55Variant,
  rasters55,
} from "./gate55b-expected";
import type { Gate5Raster } from "./geometry-raster";
import { statesEqual } from "./render-stream-2";
import { decodeShaderPayload } from "./render-stream-shader";

// ---------------------------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------------------------

export const G55D_CAPTURE_QUIT_FRAME = 400;

/** Each scene's evidence directory (G55b amendment 8), as g55b's SCENE_DIR. */
export const G55D_SCENE_DIR: Record<Gate55Variant, string> = {
  base: "cim",
  modulate: "cim-modulate",
};

/** The honest receivers: directory, the capture directory and sink they replay. */
export const G55D_RECEIVER_LEGS = [
  { dir: "receiver", capture: "capture", sink: RECORDING_NAME },
  { dir: "receiver-patch", capture: "capture", sink: PATCH_RECORDING_NAME },
  { dir: "receiver-inline", capture: "capture-inline", sink: RECORDING_NAME },
] as const;

/** The sabotage legs: the scene they run on, their directory (also the expected.json prediction
 * key) and whether the sabotage is the host's (a capture + receiver) or the receiver's (on
 * capture/). */
export const G55D_SABOTAGES = [
  { variant: "base", dir: "sabotage-freeze", host: true },
  { variant: "base", dir: "sabotage-omit-material-set-shader", host: true },
  { variant: "base", dir: "sabotage-receiver-ignore-material", host: false },
  {
    variant: "modulate",
    dir: "sabotage-receiver-ignore-canvas-modulate",
    host: false,
  },
] as const;

/** The steps with no shader or material traffic (Q6b: transform-only steps 7 and 9). */
export const G55D_QUIET_STEPS = [7, 9] as const;

/** The report name of one g55d leg directory in one scene: `receiver` -> `receiver-cim`,
 * `receiver-patch` -> `receiver-cim-patch`, `capture-inline` -> `capture-cim-inline`,
 * `sabotage-freeze` -> `sabotage-cim-freeze` (and `cim-modulate` for the variant). */
export function g55dLegName(dir: string, variant: Gate55Variant): string {
  const scene = G55D_SCENE_DIR[variant];
  const m = /^(receiver|capture|sabotage)(-.*)?$/.exec(dir);
  if (!m) return `${dir}-${scene}`;
  return `${m[1]}-${scene}${m[2] ?? ""}`;
}

// ---------------------------------------------------------------------------------------------
// The hook log, replayed with the mirror's D5 rule (material-log-divergence)
// ---------------------------------------------------------------------------------------------

/** The hook-log columns this replay reads (G55a's kind shader/material lines). */
export type MaterialLogLine5 = Pick<ResourceLine, "frame" | "op"> &
  Partial<
    Pick<
      ResourceLine,
      | "kind"
      | "id"
      | "version"
      | "status"
      | "reason"
      | "hash"
      | "payload_bytes"
      | "ref_id"
      | "target"
      | "value"
      | "outcome"
      | "mode"
      | "source"
      | "builtin"
      | "uses"
      | "param"
      | "type"
      | "n"
      | "copy_ns"
      | "hash_ns"
      | "scan_ns"
      | "decode_ns"
      | "sabotage"
      | "omitted"
    >
  >;

export interface LogShader {
  version: number;
  status: string;
  reason: string | null;
  mode: string | null;
  source: string | null;
  hash: string | null;
  payload_bytes: number;
  builtin: {
    kind: string;
    blend_mode: string;
    light_mode: string;
    particles_animation: boolean;
  } | null;
  uses: string[];
  default_textures: { name: string; index: number; tex: number }[];
}

export interface LogMaterial {
  version: number;
  status: string;
  reason: string | null;
  shader: number | null;
  /** name -> the hook log's type spelling (packed arrays by element type) and count */
  params: Map<string, { type: string; n: number }>;
}

export interface MaterialLogState {
  shaders: Map<number, LogShader>;
  materials: Map<number, LogMaterial>;
}

function cloneLogState(s: MaterialLogState): MaterialLogState {
  const shaders = new Map<number, LogShader>();
  for (const [id, x] of s.shaders)
    shaders.set(id, {
      ...x,
      uses: [...x.uses],
      default_textures: x.default_textures.map((d) => ({ ...d })),
    });
  const materials = new Map<number, LogMaterial>();
  for (const [id, m] of s.materials)
    materials.set(id, { ...m, params: new Map(m.params) });
  return { shaders, materials };
}

function shaderFromLine(
  l: MaterialLogLine5,
  version: number,
  prev?: LogShader,
): LogShader {
  return {
    version,
    status: l.status ?? "ok",
    reason: l.reason ?? null,
    mode: l.mode ?? null,
    source: l.source ?? (l.hash ? "payload" : null),
    hash: l.hash ?? null,
    payload_bytes: l.payload_bytes ?? 0,
    builtin: l.builtin ?? null,
    uses: [...(l.uses ?? [])],
    default_textures: prev ? prev.default_textures : [],
  };
}

/** Replays the hook log's shader and material lines in order (omitted lines change nothing, as in
 * the mirror) and returns the state at the end of every frame that has a line. The hook log's
 * versions are the mirror's (+1 per accepted mutating call). D5 has no line of its own: freeing a
 * shader sets every material naming it to no shader at version + 1 in the log's registry (and the
 * mirror's), so later lines already carry the bumped version -- the replay applies the same rule
 * on the `free` line. */
export function replayMaterialLog(
  lines: readonly MaterialLogLine5[],
): Array<{ frame: number; state: MaterialLogState }> {
  const out: Array<{ frame: number; state: MaterialLogState }> = [];
  const state: MaterialLogState = { shaders: new Map(), materials: new Map() };
  let frame = 0;
  for (const l of lines) {
    if (l.kind !== "shader" && l.kind !== "material") continue;
    if (l.omitted === true) continue;
    if (l.frame !== frame) {
      if (frame > 0) out.push({ frame, state: cloneLogState(state) });
      frame = l.frame;
    }
    const id = l.id ?? null;
    if (id === null) continue;
    if (l.kind === "shader") {
      const cur = state.shaders.get(id);
      switch (l.op) {
        case "shader_create":
          state.shaders.set(id, {
            version: l.version ?? 1,
            status: l.status ?? "ok",
            reason: null,
            mode: null,
            source: null,
            hash: null,
            payload_bytes: 0,
            builtin: null,
            uses: [],
            default_textures: [],
          });
          break;
        case "shader_create_from_code":
          state.shaders.set(id, shaderFromLine(l, l.version ?? 1));
          break;
        case "shader_set_code":
          if (cur && l.outcome === "applied")
            state.shaders.set(
              id,
              shaderFromLine(l, l.version ?? cur.version + 1, cur),
            );
          break;
        case "shader_set_default_texture_parameter":
          if (cur && l.outcome === "applied") {
            const name = l.param ?? "";
            const index = l.value ?? 0;
            const rest = cur.default_textures.filter(
              (d) => !(d.name === name && d.index === index),
            );
            if (l.target !== null && l.target !== "0" && l.ref_id != null)
              rest.push({ name, index, tex: l.ref_id });
            rest.sort((a, b) =>
              a.name < b.name ? -1 : a.name > b.name ? 1 : a.index - b.index,
            );
            state.shaders.set(id, {
              ...cur,
              version: l.version ?? cur.version + 1,
              default_textures: rest,
            });
          }
          break;
        case "free":
          state.shaders.delete(id);
          for (const m of state.materials.values())
            if (m.shader === id) {
              m.shader = null;
              m.version++;
              m.status = "ok";
              m.reason = null;
            }
          break;
      }
      continue;
    }
    // kind material
    const cur = state.materials.get(id);
    switch (l.op) {
      case "material_create":
      case "material_create_from_shader":
        state.materials.set(id, {
          version: l.version ?? 1,
          status: l.status ?? "ok",
          reason: l.reason ?? null,
          shader: l.op === "material_create" ? null : (l.ref_id ?? null),
          params: new Map(),
        });
        break;
      case "material_set_shader":
        if (cur && l.outcome === "applied") {
          cur.shader = l.target === null ? null : (l.ref_id ?? null);
          cur.version = l.version ?? cur.version + 1;
          cur.status = l.status ?? cur.status;
          cur.reason = l.reason ?? null;
        }
        break;
      case "material_set_param":
        if (cur && l.outcome !== "rejected") {
          const name = l.param ?? "";
          if (l.type === "nil") cur.params.delete(name);
          else cur.params.set(name, { type: l.type ?? "?", n: l.n ?? 1 });
          cur.version = l.version ?? cur.version + 1;
          cur.status = l.status ?? cur.status;
          cur.reason = l.reason ?? null;
        }
        break;
      case "free":
        state.materials.delete(id);
        break;
    }
  }
  if (frame > 0) out.push({ frame, state: cloneLogState(state) });
  return out;
}

/** A wire param's count: its packed array's length, else 1. */
function wireParamCount(p: { type: string; value: unknown }): number {
  if (!p.type.startsWith("packed_")) return 1;
  return Array.isArray(p.value) ? p.value.length : 0;
}

/** Whether a hook-log parameter (scalar type, or a packed array named by its element type) is the
 * wire's (D8 spelling: `packed_<element>_array`). */
export function paramTypeMatches(
  log: { type: string; n: number },
  wire: { type: string; n: number },
): boolean {
  if (log.n !== wire.n) return false;
  return log.type === wire.type || `packed_${log.type}_array` === wire.type;
}

type WireTables = Pick<Wire5Tx["state"], "shaders" | "materials">;

function shaderView(x: {
  version: number;
  status: string;
  reason: string | null;
  mode: string | null;
  source: string | null;
  hash: string | null;
  payload_bytes: number;
  builtin: LogShader["builtin"];
  uses: readonly string[];
  default_textures: readonly { name: string; index: number; tex: number }[];
}): string {
  return JSON.stringify({
    version: x.version,
    status: x.status,
    reason: x.reason,
    mode: x.mode,
    source: x.source,
    hash: x.hash,
    payload_bytes: x.payload_bytes,
    builtin: x.builtin
      ? {
          kind: x.builtin.kind,
          blend_mode: x.builtin.blend_mode,
          light_mode: x.builtin.light_mode,
          particles_animation: x.builtin.particles_animation,
        }
      : null,
    uses: [...x.uses].sort(),
    default_textures: x.default_textures.map((d) => [d.name, d.index, d.tex]),
  });
}

/** Pure (`material-commands`; D15 material-log-divergence): every transaction's shader and material
 * tables against the hook log's state at the end of its frame. Each shader entry's id, version,
 * status, reason, mode, source, hash, payload size, builtin descriptor, uses and default textures
 * equal the log's; each material's id, version (with D5's bump), status, reason, shader and
 * parameter names, types and counts equal the log's (the log carries no values); every entry the
 * log holds is on the wire and nothing else is. */
export function materialLogDivergence(
  lines: readonly MaterialLogLine5[],
  transactions: readonly {
    seq: number;
    frame: number;
    state: Partial<WireTables>;
  }[],
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  const snaps = replayMaterialLog(lines);
  let k = -1;
  let compared = 0;
  const empty: MaterialLogState = { shaders: new Map(), materials: new Map() };
  for (const t of transactions) {
    while (k + 1 < snaps.length && snaps[k + 1].frame <= t.frame) k++;
    const log = k >= 0 ? snaps[k].state : empty;
    const where = `seq ${t.seq} (frame ${t.frame})`;
    if (t.state.shaders === undefined || t.state.materials === undefined) {
      problems.push(`${where}: no shader/material tables (not /5)`);
      break;
    }
    for (const s of t.state.shaders) {
      const l = log.shaders.get(s.id);
      compared++;
      if (!l) {
        problems.push(`${where}: shader ${s.id} is not in the hook log`);
        continue;
      }
      const w = shaderView(s as Parameters<typeof shaderView>[0]);
      const g = shaderView(l);
      if (w !== g)
        problems.push(`${where}: shader ${s.id} wire ${w} != hook log ${g}`);
    }
    for (const id of log.shaders.keys())
      if (!t.state.shaders.some((s) => s.id === id))
        problems.push(`${where}: hook-log shader ${id} is not on the wire`);
    for (const m of t.state.materials) {
      const l = log.materials.get(m.id);
      compared++;
      if (!l) {
        problems.push(`${where}: material ${m.id} is not in the hook log`);
        continue;
      }
      const head = (v: {
        version: number;
        status: string;
        reason: string | null;
        shader: number | null;
      }) =>
        `v${v.version} ${v.status}${v.reason ? `/${v.reason}` : ""} shader ${v.shader}`;
      if (head(m) !== head(l))
        problems.push(
          `${where}: material ${m.id} wire ${head(m)} != hook log ${head(l)}`,
        );
      const names = m.params.map((p) => p.name).sort();
      const logNames = [...l.params.keys()].sort();
      if (JSON.stringify(names) !== JSON.stringify(logNames))
        problems.push(
          `${where}: material ${m.id} params ${names.join(",")} != hook log ${logNames.join(",")}`,
        );
      else
        for (const p of m.params) {
          const lp = l.params.get(p.name);
          const wp = { type: p.type, n: wireParamCount(p) };
          if (!lp || !paramTypeMatches(lp, wp))
            problems.push(
              `${where}: material ${m.id} param ${p.name} wire ${wp.type}x${wp.n} != hook log ${lp?.type}x${lp?.n}`,
            );
        }
    }
    for (const id of log.materials.keys())
      if (!t.state.materials.some((m) => m.id === id))
        problems.push(`${where}: hook-log material ${id} is not on the wire`);
    if (problems.length > 8) break;
  }
  return { problems: problems.slice(0, 9), compared };
}

/** classifyLeg plus D15: a material-log-divergence is a capture-failure, and a receiver shader
 * compile error (the engine's `SHADER ERROR` print in the receiver's stdout) is replay-failure /
 * shader-compile; each takes its place in gate 2's precedence. */
export function classifyMaterialLeg(
  base: Classification,
  divergence: readonly string[],
  receiverStdout?: string,
): Classification {
  const extra: { cls: Classification["result_class"]; reason: string }[] = [];
  if (divergence.length > 0)
    extra.push({
      cls: "capture-failure",
      reason: `capture-failure: material-log-divergence: ${divergence[0]}`,
    });
  const compile = (receiverStdout ?? "")
    .split("\n")
    .find(
      (l) =>
        l.includes("SHADER ERROR") || l.includes("Shader compilation failed"),
    );
  if (compile)
    extra.push({
      cls: "replay-failure",
      reason: `replay-failure: shader-compile: ${compile.trim()}`,
    });
  if (extra.length === 0) return base;
  const rank = (c: Classification["result_class"]) =>
    CLASS_PRECEDENCE.indexOf(c);
  let cls = base.result_class;
  for (const x of extra) if (rank(x.cls) < rank(cls)) cls = x.cls;
  return {
    ...base,
    result_class: cls,
    reasons: [...extra.map((x) => x.reason), ...base.reasons],
  };
}

// ---------------------------------------------------------------------------------------------
// expected.json's CimSim calls, mapped onto wire ids
// ---------------------------------------------------------------------------------------------

/** CimSim's shader and material ids in creation order (shader_create / material_create calls). */
export function simCreationOrder(
  e: Gate55Expected,
  variant: Gate55Variant,
): { shaders: number[]; materials: number[] } {
  const shaders: number[] = [];
  const materials: number[] = [];
  for (const s of e.variants[variant].steps)
    for (const c of s.rs_material_calls) {
      if (c.call === "shader_create") shaders.push(c.shader as number);
      if (c.call === "material_create") materials.push(c.material as number);
    }
  return { shaders, materials };
}

export interface G55dIds {
  items: Map<string, number>;
  itemNames: Map<number, string>;
  /** CimSim id -> wire id */
  shader: Map<number, number>;
  material: Map<number, number>;
  problems: string[];
}

/** Wire ids for the fixture's items (creation order), shaders and materials (CimSim's creation
 * order against the ids the wire's tables take over the run, both ascending: each table counts
 * from 1 per session and never reuses an id, D5). */
export function g55dIds(
  e: Gate55Expected,
  variant: Gate55Variant,
  transactions: readonly Wire5Tx[],
): G55dIds {
  const items = itemIdsByCreation(
    transactions,
    e.variants[variant].creation_order,
  );
  const sim = simCreationOrder(e, variant);
  const problems = [...items.problems];
  const pair = (
    simIds: number[],
    wireIds: number[],
    what: string,
  ): Map<number, number> => {
    if (simIds.length !== wireIds.length)
      problems.push(
        `${wireIds.length} ${what} ids on the wire (${wireIds.join(",")}), CimSim creates ${simIds.length}`,
      );
    return new Map(
      simIds
        .map((s, k) => [s, wireIds[k]] as [number, number])
        .filter(([, w]) => w !== undefined),
    );
  };
  return {
    items: items.ids,
    itemNames: items.names,
    shader: pair(
      sim.shaders,
      tableIdsOverRun(transactions, "shaders"),
      "shader",
    ),
    material: pair(
      sim.materials,
      tableIdsOverRun(transactions, "materials"),
      "material",
    ),
    problems,
  };
}

type WireItem = Wire5Tx["state"]["items"][number];

/** An item's effective material (D9): its parent's while use_parent_material is set and its
 * parent is an item, else its own. */
export function effectiveMaterial(
  items: ReadonlyMap<number, WireItem>,
  id: number,
): number | null {
  let item = items.get(id);
  for (let guard = 0; item && guard < 64; guard++) {
    if (item.use_parent_material === true && item.parent?.kind === "item") {
      item = items.get(item.parent.id);
      continue;
    }
    return item.material ?? null;
  }
  return null;
}

export interface SinkView {
  label: string;
  transactions: readonly Wire5Tx[];
}

/** Pure (`builtin-modes`): at every settle frame of each sink, each item's `material` field names
 * the material CimSim gave it (mapped to wire ids) and its use_parent_material is CimSim's; each
 * item drawing with a material (expected.json `effective`, inherited included) reaches, through
 * item -> (parent) -> material -> shader, a shader whose builtin descriptor has exactly that blend
 * and light mode; each item with its own CanvasItemMaterial (`builtin`) names a shader whose
 * descriptor equals CimSim's, particles_animation included; every other item draws with no
 * material. */
export function evaluateBuiltinModes(
  e: Gate55Expected,
  variant: Gate55Variant,
  ids: G55dIds,
  sinks: readonly SinkView[],
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  const own = expectedItemMaterials(e, variant);
  for (const sink of sinks)
    for (const s of e.variants[variant].steps) {
      const t = txAt(sink.transactions, s.settle_frame);
      const where = `${sink.label} step ${s.step}`;
      if (!t) {
        problems.push(`${where}: no transaction at frame ${s.settle_frame}`);
        continue;
      }
      const items = new Map(t.state.items.map((i) => [i.id, i]));
      const materials = new Map(
        (t.state.materials ?? []).map((m) => [m.id, m]),
      );
      const shaders = new Map((t.state.shaders ?? []).map((x) => [x.id, x]));
      for (const name of e.variants[variant].creation_order) {
        const id = ids.items.get(name);
        const item = id === undefined ? undefined : items.get(id);
        if (!item) {
          problems.push(`${where}: ${name} is not on the wire`);
          continue;
        }
        const want = own.get(s.step)?.get(name);
        const wantMaterial =
          want?.material == null
            ? null
            : (ids.material.get(want.material) ?? -1);
        if (
          (item.material ?? null) !== wantMaterial ||
          (item.use_parent_material ?? false) !== (want?.use_parent ?? false)
        )
          problems.push(
            `${where}: ${name} material ${item.material} use_parent ${item.use_parent_material}, expected ${wantMaterial} / ${want?.use_parent}`,
          );
        const eff = effectiveMaterial(items, item.id);
        const mode = s.effective[name];
        compared++;
        if (!mode) {
          if (eff !== null)
            problems.push(
              `${where}: ${name} draws with material ${eff}, expected none`,
            );
          continue;
        }
        const m = eff === null ? undefined : materials.get(eff);
        const sh =
          m?.shader == null ? undefined : shaders.get(m.shader as number);
        const got = sh?.builtin
          ? [sh.builtin.blend_mode, sh.builtin.light_mode]
          : null;
        if (JSON.stringify(got) !== JSON.stringify(mode))
          problems.push(
            `${where}: ${name} draws with ${JSON.stringify(got)} (material ${eff}, shader ${m?.shader ?? null}), expected ${JSON.stringify(mode)}`,
          );
        const b = s.builtin[name];
        if (b) {
          const ownM =
            item.material == null ? undefined : materials.get(item.material);
          const ownS =
            ownM?.shader == null
              ? undefined
              : shaders.get(ownM.shader as number);
          const wantB = JSON.stringify({ kind: "canvas_item_material", ...b });
          const gotB = JSON.stringify(ownS?.builtin ?? null);
          if (gotB !== wantB)
            problems.push(
              `${where}: ${name}'s own shader builtin ${gotB} != ${wantB}`,
            );
        }
      }
      if (problems.length > 10) return { problems, compared };
    }
  return { problems, compared };
}

/** Pure (`canvas-modulate-wire`): at every settle frame of each sink the root canvas's modulate
 * equals expected.json `canvas_modulate` (white in the base scene; the CanvasModulate's colour,
 * then white once it hides at step 8, in `modulate`). */
export function evaluateCanvasModulate(
  e: Gate55Expected,
  variant: Gate55Variant,
  sinks: readonly SinkView[],
): { problems: string[]; table: Record<string, string> } {
  const problems: string[] = [];
  const table: Record<string, string> = {};
  for (const sink of sinks)
    for (const s of e.variants[variant].steps) {
      const t = txAt(sink.transactions, s.settle_frame);
      const root = t?.state.canvases.find((c) => c.role === "root");
      const got = root?.modulate ?? null;
      const want = s.canvas_modulate.map((v) => Math.fround(v));
      if (got?.length !== 4 || got.some((v, i) => Math.fround(v) !== want[i]))
        problems.push(
          `${sink.label} step ${s.step}: root canvas modulate ${JSON.stringify(got)}, expected ${JSON.stringify(s.canvas_modulate)}`,
        );
      if (sink === sinks[0]) table[String(s.step)] = JSON.stringify(got);
    }
  return { problems, table };
}

/** Pure (`material-census` on the wire): every table event CimSim predicts after step 0 lands in
 * exactly one patch transaction, on its step's applied frame -- a shader_create's new id (step 3's
 * new light_only shader), a freed shader leaving (`removed_shaders`), a freed material leaving
 * (`removed_materials`, step 4), a material_create's new id (step 5's recreation, larger than every
 * id before it) -- and, on the full sink, the id is absent before that frame (new) or after it
 * (removed). Each canvas_item_set_material after step 0 (RI's null at 4, its new material at 5)
 * reaches the item entry of that same patch transaction and the full sink's item at that frame. */
export function evaluateWireMaterialCensus(
  e: Gate55Expected,
  variant: Gate55Variant,
  ids: G55dIds,
  full: readonly Wire5Tx[],
  patch: readonly Wire5Tx[],
): { problems: string[]; events: string[] } {
  const problems: string[] = [];
  const events: string[] = [];
  const patches = patch.filter((t) => t.encoding === "patch");
  for (const s of e.variants[variant].steps) {
    if (s.step === 0) continue;
    const F = s.applied_frame;
    for (const c of s.rs_material_calls) {
      let kind: string | null = null;
      let table: "shaders" | "materials" = "shaders";
      let simId: number | null = null;
      if (c.call === "shader_create") {
        kind = "new";
        simId = c.shader as number;
      } else if (c.call === "material_create") {
        kind = "new";
        table = "materials";
        simId = c.material as number;
      } else if (c.call === "free") {
        kind = "removed";
        table = c.kind === "material" ? "materials" : "shaders";
        simId = (c.kind === "material" ? c.material : c.shader) as number;
      } else if (c.call === "canvas_item_set_material") {
        const name = c.item as string;
        const sim = (c.material as number | null) ?? null;
        const want = sim === null ? null : (ids.material.get(sim) ?? -1);
        const itemId = ids.items.get(name);
        const tp = txAt(patches, F);
        const pe = tp?.wire.items.find((i) => i.id === itemId);
        const fe = txAt(full, F)?.state.items.find((i) => i.id === itemId);
        if (!pe || (pe.material ?? null) !== want)
          problems.push(
            `step ${s.step}: the patch transaction at frame ${F} carries ${name} with material ${pe ? pe.material : "(no entry)"}, expected ${want}`,
          );
        if (!fe || (fe.material ?? null) !== want)
          problems.push(
            `step ${s.step}: the full sink's ${name} has material ${fe?.material} at frame ${F}, expected ${want}`,
          );
        events.push(`${s.step}:${name}.material=${want}@${F}`);
        continue;
      }
      if (kind === null || simId === null) continue;
      const map = table === "shaders" ? ids.shader : ids.material;
      const w = map.get(simId);
      const label = `step ${s.step} ${table === "shaders" ? "shader" : "material"} ${simId}->${w}`;
      if (w === undefined) {
        problems.push(`${label}: no wire id`);
        continue;
      }
      events.push(
        `${s.step}:${table === "shaders" ? "shader" : "material"}-${kind} ${w}@${F}`,
      );
      const removedKey =
        table === "shaders" ? "removed_shaders" : "removed_materials";
      const carrying = patches.filter((t) =>
        kind === "new"
          ? (t.wire[table] ?? []).some((x) => x.id === w)
          : (t.wire[removedKey] ?? []).includes(w),
      );
      const firstNew = carrying[0];
      if (kind === "new") {
        const atF = carrying.filter((t) => t.frame === F);
        if (atF.length !== 1 || !firstNew || firstNew.frame !== F)
          problems.push(
            `${label}: first carried by the patch transaction at frame ${firstNew?.frame ?? "never"} (${atF.length} at ${F}), expected exactly one at ${F}`,
          );
        const before = full.filter((t) => t.frame < F);
        if (before.some((t) => (t.state[table] ?? []).some((x) => x.id === w)))
          problems.push(`${label}: on the full sink before frame ${F}`);
        const older = new Set<number>();
        for (const t of before)
          for (const x of t.state[table] ?? []) older.add(x.id);
        if ([...older].some((o) => o >= w))
          problems.push(
            `${label}: not larger than every earlier id (${[...older].join(",")})`,
          );
        const atFull = txAt(full, F);
        if (!atFull || !(atFull.state[table] ?? []).some((x) => x.id === w))
          problems.push(`${label}: not on the full sink at frame ${F}`);
      } else {
        if (carrying.length !== 1 || carrying[0].frame !== F)
          problems.push(
            `${label}: ${removedKey} names it in ${carrying.length} patch transactions (${carrying.map((t) => t.frame).join(",")}), expected exactly one at ${F}`,
          );
        if (
          full
            .filter((t) => t.frame >= F)
            .some((t) => (t.state[table] ?? []).some((x) => x.id === w))
        )
          problems.push(
            `${label}: still on the full sink at or after frame ${F}`,
          );
        const prev = [...full].reverse().find((t) => t.frame < F);
        if (prev && !(prev.state[table] ?? []).some((x) => x.id === w))
          problems.push(`${label}: not on the full sink before frame ${F}`);
      }
    }
  }
  return { problems, events };
}

/** Pure (`fresh-without-redraw`, Q6b step 6): UC's use_parent_material is false on the full sink
 * before step 6's applied frame and true from it on, while its content_version keeps one value over
 * the whole run; the patch transaction at that frame carries UC with use_parent_material true and
 * no commands (no redraw); and the receiver's UP region changes at step 6. */
export function evaluateFreshWithoutRedraw(
  e: Gate55Expected,
  variant: Gate55Variant,
  ids: G55dIds,
  full: readonly Wire5Tx[],
  patch: readonly Wire5Tx[],
  receiverFresh: Record<string, string[]>,
): { problems: string[]; versions: number[] } {
  const problems: string[] = [];
  const step6 = e.variants[variant].steps.find((s) => s.step === 6);
  const F = step6?.applied_frame ?? -1;
  const uc = ids.items.get("UC");
  const versions = new Set<number>();
  let flips = 0;
  for (const t of full) {
    const item = t.state.items.find((i) => i.id === uc);
    if (!item) continue;
    versions.add(item.content_version);
    const want = t.frame >= F;
    if ((item.use_parent_material ?? false) !== want && flips++ < 3)
      problems.push(
        `frame ${t.frame}: UC use_parent_material ${item.use_parent_material}, expected ${want}`,
      );
  }
  if (versions.size !== 1)
    problems.push(
      `UC's content_version takes ${versions.size} values over the run (${[...versions].join(",")})`,
    );
  const tp = patch.find((t) => t.frame === F && t.encoding === "patch");
  const entry = tp?.wire.items.find((i) => i.id === uc);
  if (entry?.use_parent_material !== true || entry.commands !== null)
    problems.push(
      `the patch transaction at frame ${F} carries UC as ${entry ? `use_parent_material ${entry.use_parent_material}, commands ${entry.commands === null ? "null" : `${entry.commands.length} (a redraw)`}` : "(no entry)"}, expected use_parent_material true with commands null`,
    );
  if (!(receiverFresh["6"] ?? []).includes("UP"))
    problems.push("the receiver's UP region did not change at step 6");
  return { problems, versions: [...versions] };
}

/** applied.json render-stream-receiver-applied/5: the per-transaction shader/material counters
 * (gate5_5-design.md Q5). */
export const MATERIAL_COUNTERS = [
  "shaders_created",
  "shader_code_sets",
  "shader_payload_fetches",
  "materials_created",
  "param_sets",
  "instance_param_sets",
] as const;

export type AppliedJson55d = AppliedJson & {
  transactions?: {
    seq?: number;
    frame?: number;
    rs_calls?: number;
    resources?: Record<string, number> | null;
  }[];
  fetches?: {
    seq?: number;
    hash?: string;
    source?: string;
    kind?: string;
    bytes?: number;
  }[];
};

/** [from, to) frames of step k: its applied frame to the next step's (the last to quit + 1). */
export function stepWindow(
  e: Gate55Expected,
  variant: Gate55Variant,
  step: number,
  quitFrame: number,
): [number, number] {
  const steps = e.variants[variant].steps;
  const k = steps.findIndex((s) => s.step === step);
  const from = k <= 0 ? 1 : steps[k].applied_frame;
  const to = k + 1 < steps.length ? steps[k + 1].applied_frame : quitFrame + 1;
  return [from, to];
}

/** Pure (`resource-quiet`): no patch transaction in the windows of steps 7 and 9 carries a shader
 * or material entry or removal; every receiver's applied.json shows zero shader/material/param
 * counters (MATERIAL_COUNTERS) on the transactions in those windows; and over its whole run each
 * receiver creates every shader and every material its recording carries exactly once
 * (shaders_created and materials_created total the distinct ids). */
export function evaluateResourceQuiet(
  e: Gate55Expected,
  variant: Gate55Variant,
  patch: readonly Wire5Tx[],
  receivers: readonly {
    leg: string;
    applied: AppliedJson55d | undefined;
    transactions: readonly Wire5Tx[];
  }[],
  quitFrame: number,
): { problems: string[]; totals: Record<string, Record<string, number>> } {
  const problems: string[] = [];
  const totals: Record<string, Record<string, number>> = {};
  const windows = G55D_QUIET_STEPS.map((k) => ({
    step: k,
    w: stepWindow(e, variant, k, quitFrame),
  }));
  for (const { step, w } of windows)
    for (const t of patch) {
      if (t.encoding !== "patch" || t.frame < w[0] || t.frame >= w[1]) continue;
      const n =
        (t.wire.shaders ?? []).length +
        (t.wire.materials ?? []).length +
        (t.wire.removed_shaders ?? []).length +
        (t.wire.removed_materials ?? []).length;
      if (n > 0)
        problems.push(
          `step ${step}: the patch transaction at frame ${t.frame} carries ${n} shader/material entries`,
        );
    }
  for (const r of receivers) {
    const sums: Record<string, number> = Object.fromEntries(
      MATERIAL_COUNTERS.map((c) => [c, 0]),
    );
    const txs = r.applied?.transactions ?? [];
    if (!r.applied) {
      problems.push(`${r.leg}: applied.json missing`);
      continue;
    }
    if (
      !txs.some(
        (t) => t.resources && MATERIAL_COUNTERS.every((c) => c in t.resources!),
      )
    ) {
      problems.push(
        `${r.leg}: no applied transaction carries the /5 counters (${MATERIAL_COUNTERS.join(", ")})`,
      );
      continue;
    }
    for (const t of txs) {
      for (const c of MATERIAL_COUNTERS) sums[c] += t.resources?.[c] ?? 0;
      const f = t.frame ?? -1;
      for (const { step, w } of windows) {
        if (f < w[0] || f >= w[1]) continue;
        const busy = MATERIAL_COUNTERS.filter(
          (c) => (t.resources?.[c] ?? 0) > 0,
        );
        if (busy.length > 0)
          problems.push(
            `${r.leg} step ${step}: seq ${t.seq} (frame ${f}) has ${busy.map((c) => `${c} ${t.resources?.[c]}`).join(", ")}`,
          );
      }
    }
    const shaders = tableIdsOverRun(r.transactions, "shaders").length;
    const materials = tableIdsOverRun(r.transactions, "materials").length;
    if (sums.shaders_created !== shaders)
      problems.push(
        `${r.leg}: shaders_created totals ${sums.shaders_created}, the recording carries ${shaders} shader ids`,
      );
    if (sums.materials_created !== materials)
      problems.push(
        `${r.leg}: materials_created totals ${sums.materials_created}, the recording carries ${materials} material ids`,
      );
    totals[r.leg] = sums;
  }
  return { problems: problems.slice(0, 12), totals };
}

/** Pure (`receiver-typed-clean`): an honest receiver records no typed refusal (applied.json
 * `unsupported` empty) and skips nothing (no `skipped*` resource counter above 0); no receiver's
 * stdout, sabotages included, carries an engine shader compile error (`SHADER ERROR`, `Shader
 * compilation failed`) or a script error. */
export function evaluateReceiverTypedClean(
  legs: readonly {
    leg: string;
    honest: boolean;
    applied: AppliedJson55d | undefined;
    stdout: string | undefined;
  }[],
): { problems: string[] } {
  const problems: string[] = [];
  const bad =
    /SHADER ERROR|Shader compilation failed|SCRIPT ERROR|SCRIPT WARNING|Parse Error|Failed to load script/;
  for (const l of legs) {
    if (l.stdout === undefined) problems.push(`${l.leg}: stdout.log missing`);
    else {
      const line = l.stdout.split("\n").find((x) => bad.test(x));
      if (line) problems.push(`${l.leg}: ${line.trim()}`);
    }
    if (!l.honest) continue;
    if (!l.applied) {
      problems.push(`${l.leg}: applied.json missing`);
      continue;
    }
    const typed = l.applied.unsupported ?? [];
    if (typed.length > 0)
      problems.push(
        `${l.leg}: applied.json unsupported ${typed
          .slice(0, 3)
          .map((u) => `${u.name}/${u.reason}`)
          .join(", ")}`,
      );
    for (const t of l.applied.transactions ?? []) {
      const skipped = Object.entries(t.resources ?? {}).filter(
        ([k, v]) => k.startsWith("skipped") && typeof v === "number" && v > 0,
      );
      if (skipped.length > 0) {
        problems.push(
          `${l.leg}: seq ${t.seq} ${skipped.map(([k, v]) => `${k} ${v}`).join(", ")}`,
        );
        break;
      }
    }
  }
  return { problems };
}

/** Pure (`receiver-state-dumps`): each patch receiver state dump at a settle seq equals the patch
 * recording's resolved /5 state there (statesEqual: shaders, materials, item material fields and
 * canvas modulate included). */
export function evaluateStateDumps(
  e: Gate55Expected,
  variant: Gate55Variant,
  patch: readonly Wire5Tx[],
  dumps: ReadonlyMap<number, unknown>,
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  for (const s of e.variants[variant].steps) {
    const t = txAt(patch, s.settle_frame);
    if (!t) {
      problems.push(
        `step ${s.step}: no patch transaction at ${s.settle_frame}`,
      );
      continue;
    }
    const dump = dumps.get(t.seq) as Record<string, unknown> | undefined;
    if (!dump) {
      problems.push(`step ${s.step}: state/seq-${t.seq}.json missing`);
      continue;
    }
    compared++;
    if (statesEqual(dump, t.state)) continue;
    const want = t.state as unknown as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(want), ...Object.keys(dump)])];
    const differ = keys.filter((k) => !statesEqual(dump[k], want[k]));
    problems.push(
      `step ${s.step}: state/seq-${t.seq}.json differs from the patch recording's resolved state in ${differ.join(", ") || "key order"}`,
    );
  }
  return { problems, compared };
}

/** Pure over the listing and payloads (`shader-store`): every `payload` shader hash either sink of
 * capture/ names is <store>/sha256/<hash>.grp, hashing to its name, decoding as GRP1 with its
 * entry's payload size, with an index.jsonl line of type shader-code and its byte count;
 * capture-inline has no store and carries each of its shader hashes as a resource record before the
 * first transaction naming it. */
export async function evaluateShaderStore(
  storeDir: string,
  sinks: readonly (readonly Wire5Tx[])[],
  inline: Wire5,
  inlineStorePresent: boolean,
): Promise<{ problems: string[]; payloads: number; bytes: number }> {
  const problems: string[] = [];
  const want = new Map<string, number>();
  for (const txs of sinks)
    for (const t of txs)
      for (const s of t.state.shaders ?? [])
        if (s.status === "ok" && s.source === "payload" && s.hash)
          want.set(s.hash, s.payload_bytes);
  let files: string[] = [];
  try {
    files = await readdir(join(storeDir, "sha256"));
  } catch {
    problems.push(`${storeDir}/sha256 missing`);
  }
  const index = new Map<string, Record<string, unknown>>();
  for (const line of (
    (await readTextOrUndefined(join(storeDir, "index.jsonl"))) ?? ""
  )
    .split("\n")
    .filter((l) => l.trim() !== "")) {
    try {
      const v = JSON.parse(line) as Record<string, unknown>;
      index.set(String(v.hash), v);
    } catch {
      problems.push("index.jsonl line is not JSON");
    }
  }
  let bytes = 0;
  for (const [hash, size] of want) {
    const name = `${hash}.grp`;
    if (!files.includes(name)) {
      problems.push(`store lacks ${name}`);
      continue;
    }
    const data = new Uint8Array(await readFile(join(storeDir, "sha256", name)));
    bytes += data.length;
    if (createHash("sha256").update(data).digest("hex") !== hash)
      problems.push(`${name} does not hash to its name`);
    if (data.length !== size)
      problems.push(`${name} is ${data.length} bytes, its entry says ${size}`);
    try {
      decodeShaderPayload(data);
    } catch (error) {
      problems.push(`${name}: ${(error as Error).message}`);
    }
    const line = index.get(hash);
    if (line?.type !== "shader-code" || line.bytes !== data.length)
      problems.push(
        `index.jsonl line for ${hash.slice(0, 12)} is ${JSON.stringify(line ?? null)}, expected type shader-code, ${data.length} bytes`,
      );
  }
  if (inlineStorePresent) problems.push("capture-inline wrote a store");
  const firstSeq = new Map<string, number>();
  for (const t of inline.transactions)
    for (const s of t.state.shaders ?? [])
      if (
        s.status === "ok" &&
        s.source === "payload" &&
        s.hash &&
        !firstSeq.has(s.hash)
      )
        firstSeq.set(s.hash, t.seq);
  for (const [hash, seq] of firstSeq) {
    const r = inline.resources.find((x) => x.hash === hash);
    if (!r || r.before_seq === null || r.before_seq > seq)
      problems.push(
        `capture-inline: shader ${hash.slice(0, 12)} (first named at seq ${seq}) has ${r ? `its resource record before seq ${r.before_seq}` : "no resource record"}`,
      );
  }
  return { problems: problems.slice(0, 10), payloads: want.size, bytes };
}

// ---------------------------------------------------------------------------------------------
// Report: materials per step
// ---------------------------------------------------------------------------------------------

/** Per step: shader and material counts on the wire at the settle frame, the GRP1 payload bytes of
 * the shader versions first published in the step's window, the param_f64 bytes (the patch sink's
 * over the window, and one full transaction's), the hook log's copy/hash/scan/decode ns totals over
 * the window, and per receiver its shader payload fetches, material calls (MATERIAL_COUNTERS but
 * fetches) and RenderingServer calls over the window. */
export function materialsPerStep(
  e: Gate55Expected,
  variant: Gate55Variant,
  full: readonly Wire5Tx[],
  patch: readonly Wire5Tx[],
  lines: readonly MaterialLogLine5[],
  receivers: readonly { leg: string; applied: AppliedJson55d | undefined }[],
  quitFrame: number,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const seenVersions = new Set<string>();
  for (const s of e.variants[variant].steps) {
    const [from, to] = stepWindow(e, variant, s.step, quitFrame);
    const settle = txAt(full, s.settle_frame);
    let grp1 = 0;
    for (const t of full) {
      if (t.frame < from || t.frame >= to) continue;
      for (const x of t.state.shaders ?? []) {
        const key = `${x.id}:${x.version}`;
        if (seenVersions.has(key)) continue;
        seenVersions.add(key);
        if (x.source === "payload") grp1 += x.payload_bytes;
      }
    }
    const inWindow = patch.filter((t) => t.frame >= from && t.frame < to);
    const ns = { copy_ns: 0, hash_ns: 0, scan_ns: 0, decode_ns: 0 };
    let hookLines = 0;
    for (const l of lines) {
      if (l.frame < from || l.frame >= to) continue;
      if (
        l.kind !== "shader" &&
        l.kind !== "material" &&
        l.kind !== "item-material"
      )
        continue;
      hookLines++;
      for (const k of Object.keys(ns) as (keyof typeof ns)[])
        ns[k] += (l[k] as number | null | undefined) ?? 0;
    }
    const recv: Record<string, Record<string, number>> = {};
    for (const r of receivers) {
      const row = { fetches: 0, material_calls: 0, rs_calls: 0 };
      for (const t of r.applied?.transactions ?? []) {
        const f = t.frame ?? -1;
        if (f < from || f >= to) continue;
        row.fetches += t.resources?.shader_payload_fetches ?? 0;
        for (const c of MATERIAL_COUNTERS)
          if (c !== "shader_payload_fetches")
            row.material_calls += t.resources?.[c] ?? 0;
        row.rs_calls += t.rs_calls ?? 0;
      }
      recv[r.leg] = row;
    }
    out[String(s.step)] = {
      frames: `${from}-${to - 1}`,
      shaders: (settle?.state.shaders ?? []).length,
      materials: (settle?.state.materials ?? []).length,
      grp1_payload_bytes: grp1,
      param_f64_bytes_patch: inWindow.reduce((n, t) => n + t.param_f64 * 8, 0),
      param_f64_bytes_full: (settle?.param_f64 ?? 0) * 8,
      hook_lines: hookLines,
      ...ns,
      receivers: recv,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface G55dLegEntry {
  group: string;
  expected_class: string | null;
  result_class: string | null;
  reasons: string[];
  harmless_ties?: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface Gate55dResult {
  checks: Gate5Check[];
  legs: Record<string, G55dLegEntry>;
  checkpoints: Gate5Checkpoint[];
  /** keyed like g55b's materials (gate55-cim, gate55-cim-modulate) */
  materials: Record<string, Record<string, unknown>>;
}

function legEntry(
  cls: Pick<Classification, "result_class" | "reasons" | "harmless_ties">,
  expectedClass: string,
  exitCode: number | null,
  artifacts: string[],
): G55dLegEntry {
  return {
    group: "g55d",
    expected_class: expectedClass,
    result_class: cls.result_class,
    reasons: cls.reasons,
    harmless_ties: cls.harmless_ties,
    exit_code: exitCode,
    artifacts,
  };
}

/** The seqs a receiver leg asked to be shot (run-gate55.sh's shot-seqs.txt, RS_RECEIVER_SHOT_SEQS
 * as settle_seqs wrote it), else the settle seqs (memory rs-g4b-receiver-checker-facts:
 * requestedShotSeqs mirrors what each leg requested). */
export async function requestedSeqs(
  dir: string,
  fallback: ReadonlyMap<number, number>,
): Promise<number[]> {
  const text = (await readTextOrUndefined(join(dir, "shot-seqs.txt")))?.trim();
  if (text && /^\d+(,\d+)*$/.test(text)) return text.split(",").map(Number);
  return [...fallback.values()];
}

async function receiverStdout(dir: string): Promise<string | undefined> {
  return readTextOrUndefined(join(dir, "stdout.log"));
}

/** Receiver checkpoints' `shot` paths as the files they are (shots/seq-<n>.png). */
function receiverShotPaths(
  cps: Gate5Checkpoint[],
  dir: string,
  seqs: ReadonlyMap<number, number>,
): Gate5Checkpoint[] {
  return cps.map((c) => ({
    ...c,
    shot: join(dir, "shots", `seq-${seqs.get(c.step) ?? "missing"}.png`),
  }));
}

async function runScene(
  outDir: string,
  e: Gate55Expected,
  variant: Gate55Variant,
  rasters: Map<number, Gate5Raster>,
): Promise<{
  checks: Gate5Check[];
  legs: Record<string, G55dLegEntry>;
  checkpoints: Gate5Checkpoint[];
  materials: Record<string, unknown>;
}> {
  const scene = G55D_SCENE_DIR[variant];
  const dir = join(outDir, scene);
  const id = (name: string) => `${scene}-${name}`;
  const L = (d: string) => g55dLegName(d, variant);
  const e5 = asGate5(e, variant);
  const checks: Gate5Check[] = [];
  const legs: Record<string, G55dLegEntry> = {};
  const checkpoints: Gate5Checkpoint[] = [];

  const capture = await evaluateCapture(dir, { expectedClass: "success" });
  const inline = await evaluateCapture(dir, {
    legDir: "capture-inline",
    expectedClass: "success",
  });
  const full5 = await loadWire5(join(dir, "capture", RECORDING_NAME));
  const patch5 = await loadWire5(join(dir, "capture", PATCH_RECORDING_NAME));
  const inline5 = await loadWire5(join(dir, "capture-inline", RECORDING_NAME));
  const log = await loadResourceLog(join(dir, "capture"));
  const inlineLog = await loadResourceLog(join(dir, "capture-inline"));
  const ids = g55dIds(e, variant, full5.transactions);
  const reference = await loadShots5(dir, "reference", e5);
  const referenceDir = join(dir, "reference");
  const wireProblems = [full5, patch5, inline5]
    .filter((w) => w.error !== null)
    .map((w) => `${w.path}: ${w.error}`);

  // The wire against the hook log and CimSim.
  const cmdFull = materialLogDivergence(log.lines, full5.transactions);
  const cmdPatch = materialLogDivergence(log.lines, patch5.transactions);
  const cmdInline = materialLogDivergence(
    inlineLog.lines,
    inline5.transactions,
  );
  const sinks: SinkView[] = [
    { label: "full", transactions: full5.transactions },
    { label: "patch", transactions: patch5.transactions },
  ];
  const builtin = evaluateBuiltinModes(e, variant, ids, sinks);
  const modulate = evaluateCanvasModulate(e, variant, sinks);
  const census = evaluateWireMaterialCensus(
    e,
    variant,
    ids,
    full5.transactions,
    patch5.transactions,
  );
  const store = await evaluateShaderStore(
    join(dir, "capture", "store"),
    [full5.transactions, patch5.transactions],
    inline5,
    await fileExists(join(dir, "capture-inline", "store", "index.jsonl")),
  );
  checks.push(
    check(
      id("material-commands"),
      "at every transaction of both sinks of the capture (and of capture-inline against its own log) the resolved shader and material tables equal the hook log's state at the end of that frame: shader ids, versions, status, mode, source, GRP1 hash and size, builtin descriptor, uses and default textures; material ids, versions (D5: a freed shader nulls every material naming it at version + 1, with no line of its own), status, shader and parameter names, types and counts; nothing on the wire the log lacks, nothing live in the log missing",
      [
        ...wireProblems,
        ...(log.problem ? [`resources.jsonl: ${log.problem}`] : []),
        ...cmdFull.problems.map((p) => `full: ${p}`),
        ...cmdPatch.problems.map((p) => `patch: ${p}`),
        ...cmdInline.problems.map((p) => `inline: ${p}`),
      ].slice(0, 10),
      `${cmdFull.compared + cmdPatch.compared + cmdInline.compared} table entries equal the hook log over ${full5.transactions.length + patch5.transactions.length + inline5.transactions.length} transactions`,
      [log.path, full5.path, patch5.path, inline5.path],
    ),
    check(
      id("builtin-modes"),
      "at every settle frame of both sinks each item names CimSim's material (wire ids by creation order) with CimSim's use_parent_material, every item drawing with a material reaches through item -> parent -> material -> shader the builtin blend and light mode expected.json `effective` gives it (UC inherits UP's add, then sub), every own CanvasItemMaterial's shader carries expected.json `builtin` exactly, and every other item draws with no material",
      [...ids.problems, ...builtin.problems].slice(0, 10),
      `${builtin.compared} item-steps carry their expected blend and light mode`,
      [full5.path, patch5.path],
    ),
    check(
      id("canvas-modulate-wire"),
      "at every settle frame of both sinks the root canvas's modulate (canvas_f32 floats 6-9) equals expected.json canvas_modulate",
      modulate.problems.slice(0, 6),
      Object.entries(modulate.table)
        .map(([k, v]) => `${k}:${v}`)
        .join(" "),
      [full5.path, patch5.path],
    ),
    check(
      id("material-census-wire"),
      "each table event CimSim predicts after step 0 lands in exactly one patch transaction at its step's applied frame: the freed disabled/light_only/unshaded shaders leave (removed_shaders at 11, 21, 31), step 3's new light_only shader id appears, step 4's RI material leaves (removed_materials at 41, RI's material null), step 5's recreation is a new material id larger than every earlier one (RI names it at 51); the full sink agrees frame by frame",
      [...ids.problems, ...census.problems].slice(0, 10),
      census.events.join(" "),
      [full5.path, patch5.path],
    ),
    check(
      id("shader-store"),
      "every payload shader hash of either capture sink is <store>/sha256/<hash>.grp, hashing to its name, a valid GRP1 payload of its entry's size, with an index.jsonl line of type shader-code; capture-inline has no store and sends every shader hash as a resource record before the first transaction naming it",
      store.problems,
      `${store.payloads} GRP1 payloads stored (${store.bytes} bytes)`,
      [join(dir, "capture", "store", "index.jsonl"), inline5.path],
    ),
  );
  {
    const problems = [
      ...(inline.result_class === "success"
        ? []
        : [
            `class ${inline.result_class}: ${inline.reasons.slice(0, 2).join(" | ")}`,
          ]),
      ...(inline5.session?.resources?.delivery === "inline"
        ? []
        : [`delivery ${inline5.session?.resources?.delivery}`]),
      ...cmdInline.problems
        .slice(0, 1)
        .map((p) => `material-log-divergence: ${p}`),
    ];
    checks.push(
      check(
        `leg-class-${L("capture-inline")}`,
        "the inline capture (every payload, GRP1 included, a resource record before its first transaction; no store) classifies as success: armed, stream closed, both sinks valid and equivalent, no unsupported entry, no material-log-divergence",
        problems,
        inline.result_class,
        inline.artifacts,
      ),
    );
    const diverged = cmdInline.problems.length > 0;
    legs[L("capture-inline")] = {
      group: "g55d",
      expected_class: "success",
      result_class: diverged ? "capture-failure" : inline.result_class,
      reasons: [
        ...(diverged
          ? [
              `capture-failure: material-log-divergence: ${cmdInline.problems[0]}`,
            ]
          : []),
        ...inline.reasons,
      ],
      harmless_ties: inline.harmless_ties,
      exit_code: inline.exit_code,
      artifacts: inline.artifacts,
    };
  }

  // Honest receivers.
  const vsRef: string[] = [];
  const imageProblems: string[] = [];
  const budgets: Record<string, RegionBudget5[]> = {};
  const quietInputs: {
    leg: string;
    applied: AppliedJson55d | undefined;
    transactions: readonly Wire5Tx[];
  }[] = [];
  const typedInputs: Parameters<
    typeof evaluateReceiverTypedClean
  >[0][number][] = [];
  let receiverFresh: Record<string, string[]> = {};
  let receiverFreshProblems: string[] = [];
  for (const r of G55D_RECEIVER_LEGS) {
    const rdir = join(dir, r.dir);
    const leg = L(r.dir);
    const cap = r.capture === "capture" ? capture : inline;
    const recording = r.sink === RECORDING_NAME ? cap.full : cap.patch;
    const wire =
      r.capture === "capture-inline"
        ? inline5
        : r.sink === RECORDING_NAME
          ? full5
          : patch5;
    const lines = r.capture === "capture" ? log.lines : inlineLog.lines;
    const seqs = settleSeqs(e5, recording);
    const shots = await loadReceiverShots5(rdir, e5, seqs);
    const cps = computeGate5Checkpoints(
      e5,
      referenceDir,
      reference,
      rdir,
      shots,
      seqs,
    );
    const applied = await readJson<AppliedJson55d>(join(rdir, "applied.json"));
    const stdout = await receiverStdout(rdir);
    const base = classifyLeg({
      captureResult: cap.captureResult,
      recording,
      receiver: {
        applied,
        requestedShotSeqs: await requestedSeqs(rdir, seqs),
        shotFiles: await shotSeqsPresent5(rdir),
      },
      checkpoints: cps as Checkpoint[],
    });
    const cls = classifyMaterialLeg(
      base,
      materialLogDivergence(lines, wire.transactions).problems,
      stdout,
    );
    const lc = evaluateLegClass5(cls, cps as Checkpoint[], {
      class: "success",
    });
    checks.push(
      check(
        `leg-class-${leg}`,
        `the ${leg} leg (rendered receiver on ${r.capture}/${r.sink}) classifies as success: no material-log-divergence, no shader compile error, applied every seq, every region of every settle shot equal to the reference`,
        lc.problems,
        cls.result_class,
        [join(rdir, "applied.json"), join(rdir, "stdout.log")],
      ),
    );
    legs[leg] = legEntry(cls, "success", await readExitCode(rdir), [
      join(rdir, "applied.json"),
      join(rdir, "shots"),
    ]);
    const cmp = compareLegs5(e5, reference, shots, rasters, [
      `reference-${scene}`,
      leg,
    ]);
    vsRef.push(...cmp.problems.map((p) => `${leg}: ${p}`));
    budgets[leg] = cmp.budgets.filter((b) => b.mismatched_pixels > 0);
    const image = evaluateExpectedImage5(e5, leg, shots, rasters);
    imageProblems.push(...image.problems);
    checkpoints.push(...receiverShotPaths(image.checkpoints, rdir, seqs));
    quietInputs.push({ leg, applied, transactions: wire.transactions });
    typedInputs.push({ leg, honest: true, applied, stdout });
    if (r.dir === "receiver") {
      const fr = evaluateFreshness5(e5, leg, shots);
      receiverFresh = fr.table;
      receiverFreshProblems = fr.problems;
    }
  }
  const fresh = evaluateFreshWithoutRedraw(
    e,
    variant,
    ids,
    full5.transactions,
    patch5.transactions,
    receiverFresh,
  );
  const quiet = evaluateResourceQuiet(
    e,
    variant,
    patch5.transactions,
    quietInputs,
    G55D_CAPTURE_QUIT_FRAME,
  );
  const inlineFetches =
    quiet.totals[L("receiver-inline")]?.shader_payload_fetches ?? 0;
  if (inlineFetches > 0)
    quiet.problems.push(
      `${L("receiver-inline")} fetched ${inlineFetches} shader payloads (every payload is inline)`,
    );
  const dumps = new Map<number, unknown>();
  for (const s of e5.steps) {
    const t = txAt(patch5.transactions, s.settle_frame);
    if (!t) continue;
    const dump = await readJson<unknown>(
      join(dir, "receiver-patch", "state", `seq-${t.seq}.json`),
    );
    if (dump !== undefined) dumps.set(t.seq, dump);
  }
  const dumpEval = evaluateStateDumps(e, variant, patch5.transactions, dumps);
  checks.push(
    check(
      id("fresh-without-redraw"),
      "UC's use_parent_material flips to true on the wire at step 6's applied frame (false before, on the full sink) while its content_version keeps one value over the run; the patch transaction there carries UC with use_parent_material true and commands null (no redraw); the receiver's UP region changes at step 6, and every receiver region changes exactly when expected.json says fresh",
      [...fresh.problems, ...receiverFreshProblems].slice(0, 8),
      `UC content_version ${fresh.versions.join(",")}; receiver fresh at 6: ${(receiverFresh["6"] ?? []).join("+")}`,
      [full5.path, patch5.path, join(dir, "receiver", "shots")],
    ),
    check(
      id("resource-quiet"),
      "no shader or material traffic at steps 7 and 9 (transform only): no patch transaction in those windows carries a shader or material entry or removal, and every honest receiver's applied.json shows zero shaders_created, shader_code_sets, shader_payload_fetches, materials_created, param_sets and instance_param_sets there; over the run each receiver creates every shader and material its recording carries exactly once, and the inline receiver fetches no shader payload",
      quiet.problems,
      Object.entries(quiet.totals)
        .map(
          ([leg, t]) =>
            `${leg} ${Object.entries(t)
              .map(([k, v]) => `${k} ${v}`)
              .join(", ")}`,
        )
        .join("; "),
      [
        patch5.path,
        ...G55D_RECEIVER_LEGS.map((r) => join(dir, r.dir, "applied.json")),
      ],
    ),
    check(
      id("receiver-vs-reference"),
      `${G55D_RECEIVER_LEGS.map((r) => L(r.dir)).join(", ")}: every pixel of every settle shot equals the reference's, raw per channel with alpha (BD's disabled strip writes its own alpha), budget 0 as the reference repeat measures (D13)`,
      vsRef.slice(0, 10),
      `${e5.steps.length * G55D_RECEIVER_LEGS.length} receiver shots identical to the reference`,
      G55D_RECEIVER_LEGS.map((r) => join(dir, r.dir, "shots")),
    ),
    check(
      id("expected-image-receiver"),
      "every honest receiver shot equals the blend-aware raster of its step on every pixel, with g55b's classes: exact for flat opaque mix, add, sub, premul_alpha and disabled (alpha included), within 1 for mul and the .6 strips; light_only paints nothing; unshaded ignores the canvas modulate",
      imageProblems.slice(0, 10),
      `${G55D_RECEIVER_LEGS.length * e5.steps.length} receiver shots match the raster`,
      G55D_RECEIVER_LEGS.map((r) => join(dir, r.dir, "shots")),
    ),
    check(
      id("receiver-state-dumps"),
      "the patch receiver's state dumps at the settle seqs equal the patch recording's resolved /5 state (shader and material tables, item material, use_parent_material and instance_params, canvas modulate included)",
      dumpEval.problems,
      `${dumpEval.compared} state dumps equal`,
      [join(dir, "receiver-patch", "state")],
    ),
  );

  // Sabotages of this scene.
  const sabotageRegions: Record<string, Record<string, string>> = {};
  for (const sab of G55D_SABOTAGES.filter((x) => x.variant === variant)) {
    const leg = L(sab.dir);
    const sdir = join(dir, sab.dir);
    const receiverDir = sab.host ? join(sdir, "receiver") : sdir;
    let captureResult = capture.captureResult;
    let recording: RecordingSummary = capture.full;
    if (sab.host) {
      captureResult = await readJson<CaptureResultJson>(
        join(sdir, "capture", "evidence", "result.json"),
      );
      recording = await loadRecording(join(sdir, "capture", RECORDING_NAME));
    }
    const seqs = settleSeqs(e5, recording);
    const shots = await loadReceiverShots5(receiverDir, e5, seqs);
    const cps = computeGate5Checkpoints(
      e5,
      referenceDir,
      reference,
      receiverDir,
      shots,
      seqs,
    );
    const applied = await readJson<AppliedJson55d>(
      join(receiverDir, "applied.json"),
    );
    const stdout = await receiverStdout(receiverDir);
    const cls = classifyMaterialLeg(
      classifyLeg({
        captureResult,
        recording,
        receiver: {
          applied,
          requestedShotSeqs: await requestedSeqs(receiverDir, seqs),
          shotFiles: await shotSeqsPresent5(receiverDir),
        },
        checkpoints: cps as Checkpoint[],
      }),
      [],
      stdout,
    );
    const pred = e.predictions[sab.dir];
    const exp: Gate5LegExpectation = {
      class: "pixel-mismatch",
      regions: pred?.regions ?? {},
    };
    const r = evaluateLegClass5(cls, cps as Checkpoint[], exp);
    if (!pred) r.problems.unshift(`expected.json has no prediction ${sab.dir}`);
    sabotageRegions[leg] = r.table;
    const artifacts = [
      ...(sab.host ? [join(sdir, "capture", RECORDING_NAME)] : []),
      join(receiverDir, "applied.json"),
    ];
    checks.push(
      check(
        `leg-class-${leg}`,
        `the ${leg} leg classifies as pixel-mismatch with mismatching regions exactly expected.json predictions[${sab.dir}] (${JSON.stringify(exp.regions)}), shots aligned by requested sequence`,
        r.problems,
        `${cls.result_class}; mismatching regions per step ${Object.entries(
          r.table,
        )
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")}`,
        artifacts,
      ),
    );
    legs[leg] = legEntry(
      cls,
      "pixel-mismatch",
      await readExitCode(receiverDir),
      artifacts,
    );
    typedInputs.push({ leg, honest: false, applied, stdout });
  }
  const typed = evaluateReceiverTypedClean(typedInputs);
  checks.push(
    check(
      id("receiver-typed-clean"),
      "the honest receivers record no typed refusal (applied.json unsupported empty) and skip nothing; no receiver's stdout (sabotages included) carries SHADER ERROR, Shader compilation failed or a script error",
      typed.problems,
      `${typedInputs.length} receiver logs clean`,
      typedInputs.map((t) => t.leg),
    ),
  );

  return {
    checks,
    legs,
    checkpoints,
    materials: {
      shader_policy: full5.session?.materials?.shader_policy ?? null,
      store: { grp1_payloads: store.payloads, grp1_bytes: store.bytes },
      receiver_budgets: budgets,
      sabotage_regions: sabotageRegions,
      receiver_totals: quiet.totals,
      census_events: census.events,
      per_step: materialsPerStep(
        e,
        variant,
        full5.transactions,
        patch5.transactions,
        log.lines,
        quietInputs,
        G55D_CAPTURE_QUIT_FRAME,
      ),
    },
  };
}

/** Group g55d over <out>/cim and <out>/cim-modulate (g55b's scene directories). */
export async function runGate55d(
  outDir: string,
  e: Gate55Expected,
): Promise<Gate55dResult> {
  const result: Gate55dResult = {
    checks: [],
    legs: {},
    checkpoints: [],
    materials: {},
  };
  for (const variant of GATE55_VARIANTS) {
    const r = await runScene(outDir, e, variant, rasters55(e, variant));
    result.checks.push(...r.checks);
    Object.assign(result.legs, r.legs);
    result.checkpoints.push(...r.checkpoints);
    result.materials[`${e.fixture}${variant === "base" ? "" : `-${variant}`}`] =
      r.materials;
  }
  const importDir = join(outDir, G55D_SCENE_DIR.base, "import", "receiver");
  const code = await readExitCode(importDir);
  result.checks.push(
    check(
      "cim-receiver-import-exit",
      "the g55d editor --import of receiver/ exited 0",
      code === 0 ? [] : [`import/receiver exit ${code ?? "<none>"}`],
      "receiver import exited 0",
      [join(importDir, "stdout.log")],
    ),
  );
  result.legs["import-receiver-cim"] = {
    group: "g55d",
    expected_class: null,
    result_class: null,
    reasons: [],
    exit_code: code,
    artifacts: [join(importDir, "stdout.log")],
  };
  return result;
}
