// Gate 8 g8vp checks (render-stream-16.md viewport surfaces) on
// fixtures/viewport-scene. run-gate8.sh run_g8vp writes, under g8vp/:
//
//   <leg>/capture     a file-sink capture: recording.rs16 (recording.rs15 for v15), its patch twin,
//                     the store, steps.jsonl, arm.jsonl (the loader's API arm log) and
//                     evidence/result.json (stream.gate8.viewports, stream.gate8.adopt_stats)
//
// legs: born (headless, armed at birth), late (headless, GRC_MODE=standby, armed through the API at
// frame K, GRC_ADOPT=arm), off (born with GRC_VIEWPORTS=off), v15 (born at GRC_STREAM_VERSION=15),
// born-rendered and late-rendered (the same on the private gamescope host), and the sabotages
// sabotage-no-adjacency (born), sabotage-no-node-route and sabotage-wrong-order (late), each under
// GRC_VIEWPORT_SABOTAGE.
//
// Checks:
//   vp-validate     every honest leg's recordings validate at their version; /16 sessions say
//                   viewports "on" (the off leg "off"), /15 carries no viewports key; no
//                   non-root-viewport entry under "on"; the late legs armed through the API at K
//   vp-equivalence  late = born from the arm on (headless pair and rendered pair): items through
//                   gate8-adopt-checks' canonical states, plus the viewport table compared
//                   structurally, modulo VP_EXCEPTIONS and only them. One residue exception:
//                   an embedded Window that registered before a late arm made the root's subwindow
//                   canvas (layer SUBWINDOW_CANVAS_LAYER = 1024) and its texture-rect item there,
//                   RS-only objects no node exposes, so the walk cannot adopt them; a root canvas
//                   at that layer present only in born is excused when it holds nothing but
//                   add_texture_rect draws of adopted viewports' proxies (anything else on it, or
//                   such a canvas present only in late, still fails); counted per frame
//   vp-account      each honest leg's stream.gate8.viewports and adopt_stats against expected.json;
//                   on live legs the final resolved viewport table holds created + adopted entries
//                   (the evidence is written at stream end, after the scene's teardown freed every
//                   viewport, so `freed` is only bounded); on headless live legs no proxy-unresolved
//                   entry in the final resolved state
//   vp-off          the off leg: viewports "off", no /16 key, kind or reason anywhere,
//                   non-root-viewport entries present, and every resolved state equal to v15's
//   vp-sabotage     each sabotage leg fails its target check and passes the checks named for it
//
// The pure helpers (canonicalVpState, compareVpStates, vpEquivalence, accountProblems, offProblems,
// sabotageProblems, ...) are exported so scripts/test/self-test-gate8-vp.ts drives them on
// synthetic evidence.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";

import {
  type CanonCanvas,
  canonicalState,
  check,
  compareStates,
  type G8aCheck,
  jsonl,
  readJson,
  readText,
  skipped,
  stateAt,
} from "./gate8-adopt-checks";
import {
  decodeRecording,
  type ResolvedCanvas,
  type ResolvedRecording,
  type ResolvedTexture,
  type ResolvedTransaction,
  type ResolvedViewport,
  resolveRecording,
  validateRecording,
  wireVersionOf,
} from "./render-stream-2";

type State = ResolvedTransaction["state"];

// ------------------------------------------------------------------------------- expectations

/** One leg's account (result.json stream.gate8): `viewports` exact, `min` lower bounds on
 * stream.gate8.viewports, `adopt_stats` exact (null: not judged). */
export interface VpLegAccount {
  viewports: Record<string, string | number | boolean>;
  min?: Record<string, number>;
  adopt_stats?: Record<string, number> | null;
}

export interface VpExpected {
  schema: "render-stream-gate8-vp-expected/1";
  doc: string;
  arm_frame: number;
  quit_offset: number;
  checkpoints: { step: number; applied: number; settle: number }[];
  /** the fixture's viewports by name: [width, height] (pre_arm: in the scene before K). */
  viewports: {
    pre_arm: Record<string, [number, number]>;
    post_arm: Record<string, [number, number]>;
    renders_3d: string[];
  };
  account: Record<string, VpLegAccount>;
  /** subwindow_residue: an embedded Window registers before the late arm, so the subwindow-canvas
   * residue exception applies (at SUBWINDOW_RESIDUE_LAYER). */
  equivalence: {
    residue: number;
    subwindow_residue: boolean;
    exceptions: string[];
  };
  /** VS3's vp-reference budget (hand-derived from the scene's layout, never from a receiver run). */
  reference?: VpReference;
}

/** vp-reference: the screen regions each display node of the scene covers, and how a receiver's
 * pixels there are judged against the rendered Godot reference (fixtures/gsw-tolerance.json's
 * policy): `exact`, every pixel within `channel` steps (P-G1 with P-G3's translucent-blend
 * allowance); `banded`, counted and reported (a typed receiver caveat makes it approximate);
 * `excluded`, reported only (the receiver types the content it cannot draw). Pixels outside every
 * region are `exact`. Regions are first match. */
export interface VpReference {
  doc: string;
  channel: number;
  regions: {
    name: string;
    rect: [number, number, number, number];
    class: "exact" | "banded" | "excluded";
    reason?: string;
  }[];
  /** VS5: the regions a late (API-armed) leg judges under another class, each with its reason
   * (an adoption limit render-stream-16.md / viewport-surfaces-design.md Q4 names); born legs and
   * every other region keep `regions`. */
  late?: {
    name: string;
    class: "exact" | "banded" | "excluded";
    reason: string;
    /** the region's rect at each step (the object it follows moves); the rest of the region's
     * own rect is then judged as the pixels outside every region are */
    by_step?: Record<string, [number, number, number, number]>;
  }[];
}

/** The reference a receiver leg is judged by at `step`: `ref` itself, or for a late leg `ref` with
 * its `late` classes (and, under `by_step`, that step's rect) applied. A `late` entry naming no
 * region, or a `by_step` without the step, is reported, never ignored. */
export function referenceFor(
  leg: string,
  ref: VpReference,
  step: number,
): { ref: VpReference; problems: string[] } {
  if (!leg.startsWith("late") || !ref.late) return { ref, problems: [] };
  const problems = ref.late
    .filter((o) => !ref.regions.some((r) => r.name === o.name))
    .map((o) => `expected.json reference.late names no region ${o.name}`);
  return {
    ref: {
      ...ref,
      regions: ref.regions.map((r) => {
        const o = ref.late?.find((x) => x.name === r.name);
        if (!o) return r;
        let rect = r.rect;
        if (o.by_step) {
          const at = o.by_step[String(step)];
          if (at) rect = at;
          else
            problems.push(
              `expected.json reference.late ${o.name} has no rect for step ${step}`,
            );
        }
        return { ...r, rect, class: o.class, reason: o.reason };
      }),
    },
    problems,
  };
}

/** The receiver legs vp-reference judges, each with the rendered capture whose own Godot shots it
 * is judged against: the rendered capture of the same arm (born legs: born-rendered; VS5's late
 * legs: late-rendered, the same scene at the same settle frames, armed at K as the leg was). */
export const VP_RECEIVER_LEGS = [
  "born/receiver",
  "born-rendered/receiver",
  "late/receiver",
  "late-rendered/receiver",
] as const;
export const VP_REFERENCE_DIR = "born-rendered/capture";
export const VP_LATE_REFERENCE_DIR = "late-rendered/capture";
export function vpReferenceDirOf(leg: string): string {
  return leg.startsWith("late") ? VP_LATE_REFERENCE_DIR : VP_REFERENCE_DIR;
}

export interface VpPixelRow {
  step: number;
  region: string;
  class: string;
  /** pixels over the channel allowance, and the largest channel difference */
  over: number;
  max: number;
}

/** Each region's pixels over `channel` and the largest difference, for one shot pair. */
export function regionDiff(
  a: { data: Uint8Array; width: number; height: number },
  b: { data: Uint8Array; width: number; height: number },
  ref: VpReference,
): { region: string; class: string; over: number; max: number }[] {
  const rows = [
    ...ref.regions.map((r) => ({
      region: r.name,
      class: r.class,
      over: 0,
      max: 0,
    })),
    { region: "rest", class: "exact", over: 0, max: 0 },
  ];
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 3; c++)
        d = Math.max(d, Math.abs(a.data[ia + c] - b.data[ib + c]));
      let k = ref.regions.findIndex(
        (r) =>
          x >= r.rect[0] &&
          y >= r.rect[1] &&
          x < r.rect[0] + r.rect[2] &&
          y < r.rect[1] + r.rect[3],
      );
      if (k < 0) k = ref.regions.length;
      const row = rows[k];
      if (d > ref.channel) row.over++;
      if (d > row.max) row.max = d;
    }
  }
  return rows;
}

/** vp-reference's problems for the receiver legs under `g` (null: evidence missing). A browser
 * (GSW) leg -- one with a page-config.json -- is judged pixel by pixel against the reference's
 * shot at each step; a native receiver, which draws no viewport surface (render-stream-16.md:
 * receivers other than GSW defer surfaces), is judged on its exit and its shots. */
export async function referenceProblems(
  g: string,
  ref: VpReference | undefined,
): Promise<{
  problems: string[] | null;
  rows: string[];
  pixels: Record<string, VpPixelRow[]>;
}> {
  const rows: string[] = [];
  const pixels: Record<string, VpPixelRow[]> = {};
  if (!ref)
    return { problems: ["expected.json has no reference block"], rows, pixels };
  const problems: string[] = [];
  const stepsOf = async (dir: string) =>
    jsonl<{ step: number }>(await readText(join(g, dir, "steps.jsonl"))).map(
      (l) => l.step,
    );
  for (const refDir of new Set(VP_RECEIVER_LEGS.map(vpReferenceDirOf)))
    if ((await stepsOf(refDir)).length === 0)
      return { problems: null, rows, pixels };
  for (const leg of VP_RECEIVER_LEGS) {
    const dir = join(g, leg);
    const refDir = vpReferenceDirOf(leg);
    const exit = (await readText(join(dir, "exit-code.txt")))?.trim();
    if (exit === undefined) return { problems: null, rows, pixels };
    const browser = existsSync(join(dir, "page-config.json"));
    if (exit !== "0") {
      // render-stream-16.md / viewport-surfaces-design.md D2: the native receiver does not read
      // /16 (it refuses the GRSG magic before any record); only GSW draws surfaces.
      const applied = await readJson<{ status?: string; failure?: unknown }>(
        join(dir, "applied.json"),
      );
      const refused =
        !browser &&
        applied?.status === "replay-failure" &&
        JSON.stringify(applied.failure ?? {}).includes("bad-magic");
      if (refused) rows.push(`${leg} (native: refuses /16, deferred by D2)`);
      else problems.push(`${leg}: exit ${exit}`);
      continue;
    }
    const capture = leg.replace(/\/receiver$/, "/capture");
    const steps = await stepsOf(capture);
    const seqs = ((await readText(join(dir, "shot-seqs.txt"))) ?? "")
      .trim()
      .split(",")
      .filter(Boolean);
    let compared = 0;
    for (const [i, step] of steps.entries()) {
      const shot =
        seqs[i] === undefined
          ? undefined
          : join(dir, "shots", `seq-${seqs[i]}.png`);
      const a = shot ? await decodePngRgba(shot) : undefined;
      if (!a) {
        problems.push(`${leg}: step ${step}: no shot`);
        continue;
      }
      if (!browser) continue;
      const b = await decodePngRgba(
        join(g, refDir, "shots", `step-${step}.png`),
      );
      if (!b) {
        problems.push(`${leg}: step ${step}: no reference shot`);
        continue;
      }
      if (a.width !== b.width || a.height !== b.height)
        problems.push(
          `${leg}: step ${step}: ${a.width}x${a.height} against the reference's ${b.width}x${b.height}`,
        );
      compared++;
      const legRef = referenceFor(leg, ref, step);
      problems.push(...legRef.problems);
      for (const r of regionDiff(a, b, legRef.ref)) {
        pixels[leg] ??= [];
        pixels[leg].push({ step, ...r });
        if (r.class === "exact" && r.over > 0)
          problems.push(
            `${leg}: step ${step}: ${r.region}: ${r.over} px over ${ref.channel} (max ${r.max})`,
          );
      }
    }
    rows.push(
      browser
        ? `${leg} (GSW) ${compared}/${steps.length} steps against ${refDir}`
        : `${leg} (native: draws no surface; exit and ${steps.length} shots only)`,
    );
  }
  return { problems, rows, pixels };
}

/** The equivalence exceptions of an adopting arm (render-stream-16.md: adopted entries, tree-order activation, an adopted once viewport's once_seq 1), and only they (the criterion text and the self-test name them). */
export const VP_EXCEPTIONS = [
  "ids (viewport, texture, canvas, item): viewports are matched by parent chain and size, items through gate8-adopt-checks' draw-order bijection",
  "origin (created vs adopted, on viewports and textures)",
  "raw active_seq: the order of active siblings under each parent is compared instead",
  "once_seq of a viewport the late capture adopted: its advance since the first compared frame is compared instead",
  "adopted_content",
  "the root's subwindow canvas (layer 1024) present only in born, holding only the texture-rect draws of embedded Windows adopted at arm (RS-only residue: SUBWINDOW_RESIDUE_LAYER)",
] as const;

/** Godot's SUBWINDOW_CANVAS_LAYER: the root viewport's subwindow canvas, made (canvas_create,
 * viewport_attach_canvas, stacking 1024/0) when the first embedded Window registers. */
export const SUBWINDOW_RESIDUE_LAYER = 1024;

/** The subwindow-canvas residue exception: born's root canvases at `layer` that late lacks, each
 * holding only add_texture_rect draws (no children) of proxies of viewports the late state adopted,
 * are dropped from born. Returns born's remaining root canvases and how many were excused. */
export function excuseSubwindowResidue(
  born: CanonVpState,
  late: CanonVpState,
  layer: number,
): { root: CanonCanvas[]; excused: number } {
  const at = (c: CanonCanvas) =>
    c.fields.layer === layer && c.fields.role !== "root";
  if (late.root.some(at)) return { root: born.root, excused: 0 };
  const windowDraw = (cmd: Record<string, unknown>) => {
    if (cmd.op !== "add_texture_rect" || typeof cmd.tex !== "string")
      return false;
    const m = /^proxy->viewport:(.+)$/.exec(cmd.tex);
    return m !== null && late.viewports.get(m[1])?.origin === "adopted";
  };
  let excused = 0;
  const root = born.root.filter((c) => {
    if (!at(c)) return true;
    const ok =
      c.items.length > 0 &&
      c.items.every(
        (it) =>
          it.children.length === 0 &&
          (it.draw.commands as Record<string, unknown>[]).every(windowDraw),
      );
    if (ok) excused++;
    return !ok;
  });
  return { root, excused };
}

/** render-stream-16.md's viewport family (the contract's 20 hooks): planned at /15 by capability,
 * never under GRC_VIEWPORTS=off, so vp-off's session comparison ignores exactly these names. */
export const VIEWPORT_FAMILY = [
  "texture_proxy_create",
  "texture_proxy_update",
  "viewport_create",
  "viewport_set_size",
  "viewport_set_active",
  "viewport_set_parent_viewport",
  "viewport_set_canvas_cull_mask",
  "viewport_set_update_mode",
  "viewport_set_clear_mode",
  "viewport_get_texture",
  "viewport_set_disable_3d",
  "viewport_set_disable_2d",
  "viewport_attach_camera",
  "viewport_set_scenario",
  "viewport_set_transparent_background",
  "viewport_set_use_hdr_2d",
  "viewport_set_snap_2d_transforms_to_pixel",
  "viewport_set_snap_2d_vertices_to_pixel",
  "viewport_set_msaa_2d",
  "instance_set_scenario",
] as const;

export type VpLeg =
  | "born"
  | "late"
  | "off"
  | "v15"
  | "born-rendered"
  | "late-rendered"
  | "sabotage-no-adjacency"
  | "sabotage-no-node-route"
  | "sabotage-wrong-order";

export interface VpLegSpec {
  version: 15 | 16;
  arm: "born" | "late";
  host: "headless" | "rendered";
  /** the session's viewports key (null at /15). */
  mode: "on" | "off" | null;
  /** the honest leg whose expectations a sabotage leg is judged against. */
  base?: VpLeg;
}

export const VP_LEGS: Record<VpLeg, VpLegSpec> = {
  born: { version: 16, arm: "born", host: "headless", mode: "on" },
  late: { version: 16, arm: "late", host: "headless", mode: "on" },
  off: { version: 16, arm: "born", host: "headless", mode: "off" },
  v15: { version: 15, arm: "born", host: "headless", mode: null },
  "born-rendered": { version: 16, arm: "born", host: "rendered", mode: "on" },
  "late-rendered": { version: 16, arm: "late", host: "rendered", mode: "on" },
  "sabotage-no-adjacency": {
    version: 16,
    arm: "born",
    host: "headless",
    mode: "on",
    base: "born",
  },
  "sabotage-no-node-route": {
    version: 16,
    arm: "late",
    host: "headless",
    mode: "on",
    base: "late",
  },
  "sabotage-wrong-order": {
    version: 16,
    arm: "late",
    host: "headless",
    mode: "on",
    base: "late",
  },
};
export const HONEST_LEGS: VpLeg[] = [
  "born",
  "late",
  "off",
  "v15",
  "born-rendered",
  "late-rendered",
];

export type VpCheckId = "vp-validate" | "vp-account" | "vp-equivalence";
export const VP_SABOTAGES: Record<
  "no-adjacency" | "no-node-route" | "wrong-order",
  { leg: VpLeg; target: VpCheckId; must_pass: VpCheckId[] }
> = {
  // the constructor's proxies never bind by adjacency: the account's adjacency floor fails (and on
  // the headless host they stay unresolved)
  "no-adjacency": {
    leg: "sabotage-no-adjacency",
    target: "vp-account",
    must_pass: ["vp-validate"],
  },
  // the scene ViewportTexture stays proxy-unresolved: the final state's proxy-unresolved entry and the node-route floor fail
  // (equivalence fails too, which is not judged)
  "no-node-route": {
    leg: "sabotage-no-node-route",
    target: "vp-account",
    must_pass: ["vp-validate"],
  },
  // adoption's activation order is not tree order: only the sibling order differs
  "wrong-order": {
    leg: "sabotage-wrong-order",
    target: "vp-equivalence",
    must_pass: ["vp-validate", "vp-account"],
  },
};

// ------------------------------------------------------------------------- canonical viewports

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const IDENTITY = [1, 0, 0, 1, 0, 0];

/** Each viewport's key: its parent's key (`root` for parent 0, `detached` for null) then
 * `/<w>x<h>`; same-size siblings get `#<i>` in the order of their id-free field signature. */
export function viewportKeys(vps: ResolvedViewport[]): Map<number, string> {
  const byId = new Map<number, ResolvedViewport>();
  for (const v of vps) byId.set(v.id, v);
  const keys = new Map<number, string>();
  const parentKey = (v: ResolvedViewport, depth: number): string => {
    if (v.parent === null) return "detached";
    if (v.parent === 0) return "root";
    const p = byId.get(v.parent);
    if (!p || depth > 64) return `missing:${v.parent}`;
    return keyOf(p, depth + 1);
  };
  const signature = (v: ResolvedViewport) =>
    JSON.stringify({
      transparent: v.transparent,
      update: v.update,
      clear: v.clear,
      disable_2d: v.disable_2d,
      renders_3d: v.renders_3d,
      rows: v.canvases.length,
    });
  const keyOf = (v: ResolvedViewport, depth: number): string => {
    const have = keys.get(v.id);
    if (have !== undefined) return have;
    const pk = parentKey(v, depth);
    const base = `${pk}/${v.size[0]}x${v.size[1]}`;
    const twins = vps
      .filter(
        (w) =>
          w.size[0] === v.size[0] &&
          w.size[1] === v.size[1] &&
          w.parent === v.parent,
      )
      .sort((a, b) => signature(a).localeCompare(signature(b)) || a.id - b.id);
    const k = twins.length > 1 ? `${base}#${twins.indexOf(v)}` : base;
    keys.set(v.id, k);
    return k;
  };
  for (const v of vps) keyOf(v, 0);
  return keys;
}

/** The texture keys canonicalState compares commands by: a viewport texture names its viewport's
 * key, an ok proxy names its target's key (so a proxy bound to the wrong viewport differs), an
 * unresolved proxy is `proxy:unresolved`; other kinds keep their payload hash. */
export function textureKeys(
  state: State,
  vpKey: Map<number, string>,
): Map<number, string> {
  const byId = new Map<number, ResolvedTexture>();
  for (const t of state.textures) byId.set(t.id, t);
  const plain = (t: ResolvedTexture | undefined, id: number | null) => {
    if (!t) return `missing:${id}`;
    if (t.kind === "viewport")
      return `viewport:${vpKey.get(t.viewport ?? -1) ?? `missing:${t.viewport}`}${t.status === "freed" ? ":freed" : ""}`;
    return t.hash ?? `${t.kind}:${t.status}`;
  };
  const out = new Map<number, string>();
  for (const t of state.textures) {
    if (t.kind === "viewport") out.set(t.id, plain(t, t.id));
    else if (t.kind === "proxy") {
      if (t.status === "ok") {
        const target = byId.get(t.target ?? -1);
        out.set(
          t.id,
          `proxy->${target?.kind === "proxy" ? "proxy" : plain(target, t.target ?? null)}`,
        );
      } else
        out.set(
          t.id,
          t.status === "freed"
            ? "proxy:freed"
            : `proxy:${t.reason ?? t.status}`,
        );
    }
  }
  return out;
}

export interface CanonViewport {
  key: string;
  parent: string;
  origin: string;
  active: boolean;
  active_seq: number;
  once_seq: number;
  fields: Record<string, unknown>;
  /** one canonical canvas per `canvases` row, in (layer, sublayer, content) order. */
  canvases: CanonCanvas[];
}

export interface CanonVpState {
  root: CanonCanvas[];
  viewports: Map<string, CanonViewport>;
  /** every ok proxy's `proxy->target` key, sorted; unresolved proxies as `proxy:proxy-unresolved`. */
  proxies: string[];
  unsupported: string[];
  failures: string[];
}

/** A /16 resolved state in the form vp-equivalence compares: the root's canvases through
 * canonicalState (texture keys mapped by textureKeys), each viewport's canvases the same way (the
 * canvas marked attached at its row's stacking and transform, so its items' draws are compared),
 * and the viewport table keyed by viewportKeys. */
export function canonicalVpState(state: State): CanonVpState {
  const vps = state.viewports ?? [];
  const vpKey = viewportKeys(vps);
  const tk = textureKeys(state, vpKey);
  const mapped: State = {
    ...state,
    textures: state.textures.map((t) =>
      tk.has(t.id) ? { ...t, hash: tk.get(t.id) ?? null } : t,
    ),
  };
  const canvasById = new Map<number, ResolvedCanvas>();
  for (const c of state.canvases) canvasById.set(c.id, c);
  const root = canonicalState({
    ...mapped,
    canvases: state.canvases.filter((c) => c.role === "root" || c.attached),
  });
  const viewports = new Map<string, CanonViewport>();
  for (const v of vps) {
    const key = vpKey.get(v.id) ?? `missing:${v.id}`;
    const rows = v.canvases.map(([cid, layer, sublayer], i) => {
      const c = canvasById.get(cid);
      const canon: CanonCanvas = c
        ? canonicalState({
            ...mapped,
            canvases: [
              {
                ...c,
                attached: true,
                layer,
                sublayer,
                xform: (v.floats.canvas_xforms[i] ??
                  IDENTITY) as ResolvedCanvas["xform"],
              },
            ],
          })[0]
        : { key: `missing-canvas:${cid}`, fields: {}, items: [] };
      return { layer, sublayer, canon };
    });
    rows.sort(
      (a, b) =>
        a.layer - b.layer ||
        a.sublayer - b.sublayer ||
        JSON.stringify(a.canon).localeCompare(JSON.stringify(b.canon)),
    );
    viewports.set(key, {
      key,
      parent:
        v.parent === null
          ? "detached"
          : v.parent === 0
            ? "root"
            : (vpKey.get(v.parent) ?? `missing:${v.parent}`),
      origin: v.origin,
      active: v.active,
      active_seq: v.active_seq,
      once_seq: v.once_seq,
      fields: {
        active: v.active,
        size: v.size,
        transparent: v.transparent,
        update: v.update,
        clear: v.clear,
        clear_seq: v.clear_seq,
        disable_2d: v.disable_2d,
        renders_3d: v.renders_3d,
        hdr_2d: v.hdr_2d,
        msaa_2d: v.msaa_2d,
        canvas_cull_mask: v.canvas_cull_mask,
        default_texture_filter: v.default_texture_filter,
        default_texture_repeat: v.default_texture_repeat,
        snap_2d: v.snap_2d,
        stacking: rows.map((r) => [r.layer, r.sublayer]),
        global_xform: v.floats.global_xform,
      },
      canvases: rows.map((r) => r.canon),
    });
  }
  const proxies = state.textures
    .filter((t) => t.kind === "proxy" && t.status !== "freed")
    .map((t) => tk.get(t.id) ?? "?")
    .sort();
  return {
    root,
    viewports,
    proxies,
    unsupported: state.unsupported.map((u) => `${u.op}|${u.reason}`).sort(),
    failures: state.failures.map((f) => f.reason).sort(),
  };
}

/** The active siblings of each parent key, in ascending active_seq (Godot's sibling order). */
export function siblingOrder(c: CanonVpState): Map<string, string[]> {
  const out = new Map<string, CanonViewport[]>();
  for (const v of c.viewports.values()) {
    if (!v.active) continue;
    const list = out.get(v.parent) ?? [];
    list.push(v);
    out.set(v.parent, list);
  }
  const order = new Map<string, string[]>();
  for (const [p, list] of out)
    order.set(
      p,
      list.sort((a, b) => a.active_seq - b.active_seq).map((v) => v.key),
    );
  return order;
}

/** Compares a late canonical state with a born one under VP_EXCEPTIONS. `base` holds each
 * viewport's once_seq at the first compared frame (born's and late's), for the adopted-once
 * exception. Returns the problems and the residue (gate8-adopt's born-only empty items). */
export function compareVpStates(
  born: CanonVpState,
  late: CanonVpState,
  base?: { born: Map<string, number>; late: Map<string, number> },
  subwindowLayer?: number,
): { problems: string[]; residue: number; subwindow_excused: number } {
  const problems: string[] = [];
  let residue = 0;
  const sub =
    subwindowLayer === undefined
      ? { root: born.root, excused: 0 }
      : excuseSubwindowResidue(born, late, subwindowLayer);
  const root = compareStates(sub.root, late.root);
  residue += root.residue;
  for (const p of root.problems) problems.push(`root: ${p}`);
  for (const k of born.viewports.keys())
    if (!late.viewports.has(k)) problems.push(`viewport ${k}: only in born`);
  for (const k of late.viewports.keys())
    if (!born.viewports.has(k)) problems.push(`viewport ${k}: only in late`);
  for (const [k, b] of born.viewports) {
    const l = late.viewports.get(k);
    if (!l) continue;
    for (const f of Object.keys(b.fields))
      if (!eq(b.fields[f], l.fields[f]))
        problems.push(
          `viewport ${k}: ${f} ${JSON.stringify(b.fields[f])} vs ${JSON.stringify(l.fields[f])}`,
        );
    // an adopted viewport's once_seq is its advance since the first compared frame (without
    // `base`, a single-state comparison, it is not compared)
    if (l.origin === "adopted") {
      const db = base ? b.once_seq - (base.born.get(k) ?? b.once_seq) : 0;
      const dl = base ? l.once_seq - (base.late.get(k) ?? l.once_seq) : 0;
      if (db !== dl)
        problems.push(
          `viewport ${k}: once_seq advanced ${db} vs ${dl} since the first compared frame`,
        );
    } else if (b.once_seq !== l.once_seq)
      problems.push(`viewport ${k}: once_seq ${b.once_seq} vs ${l.once_seq}`);
    if (b.canvases.length !== l.canvases.length)
      problems.push(
        `viewport ${k}: ${b.canvases.length} vs ${l.canvases.length} canvas rows`,
      );
    else {
      const r = compareStates(b.canvases, l.canvases);
      residue += r.residue;
      for (const p of r.problems) problems.push(`viewport ${k}: ${p}`);
    }
  }
  const bo = siblingOrder(born);
  const lo = siblingOrder(late);
  for (const p of new Set([...bo.keys(), ...lo.keys()]))
    if (!eq(bo.get(p) ?? [], lo.get(p) ?? []))
      problems.push(
        `sibling order under ${p}: ${(bo.get(p) ?? []).join(",")} vs ${(lo.get(p) ?? []).join(",")}`,
      );
  if (!eq(born.proxies, late.proxies))
    problems.push(
      `proxies ${born.proxies.join(",")} vs ${late.proxies.join(",")}`,
    );
  if (!eq(born.unsupported, late.unsupported))
    problems.push(
      `unsupported ${born.unsupported.join(",")} vs ${late.unsupported.join(",")}`,
    );
  if (!eq(born.failures, late.failures))
    problems.push(
      `failures ${born.failures.join(",")} vs ${late.failures.join(",")}`,
    );
  return { problems, residue, subwindow_excused: sub.excused };
}

/** vp-equivalence over every frame from `fromFrame` to the last frame both recordings cover. */
export function vpEquivalence(
  born: ResolvedRecording,
  late: ResolvedRecording,
  fromFrame: number,
  expectedResidue: number,
  subwindowLayer?: number,
): {
  problems: string[];
  frames: number;
  viewports: number;
  sibling_parents: number;
  /** frames at which the subwindow-canvas residue exception excused a born canvas. */
  subwindow_excused_frames: number;
} {
  const problems: string[] = [];
  const last = Math.min(
    born.transactions.at(-1)?.frame ?? 0,
    late.transactions.at(-1)?.frame ?? 0,
  );
  let frames = 0;
  let viewports = 0;
  let siblingParents = 0;
  let excusedFrames = 0;
  let base: { born: Map<string, number>; late: Map<string, number> } | null =
    null;
  for (let f = fromFrame; f <= last; f++) {
    const b = stateAt(born, f);
    const l = stateAt(late, f);
    if (!b || !l) {
      problems.push(
        `frame ${f}: ${!b ? "born" : "late"} has no transaction yet`,
      );
      continue;
    }
    frames++;
    const cb = canonicalVpState(b.state);
    const cl = canonicalVpState(l.state);
    if (base === null) {
      base = { born: new Map(), late: new Map() };
      for (const [k, v] of cb.viewports) base.born.set(k, v.once_seq);
      for (const [k, v] of cl.viewports) base.late.set(k, v.once_seq);
    }
    viewports = Math.max(viewports, cb.viewports.size);
    siblingParents = Math.max(
      siblingParents,
      [...siblingOrder(cb).values()].filter((x) => x.length > 1).length,
    );
    const r = compareVpStates(cb, cl, base, subwindowLayer);
    if (r.subwindow_excused > 0) excusedFrames++;
    if (r.residue !== expectedResidue)
      problems.push(
        `frame ${f}: residue ${r.residue}, expected ${expectedResidue}`,
      );
    for (const p of r.problems) problems.push(`frame ${f}: ${p}`);
  }
  if (frames === 0) problems.push("no frame compared");
  if (viewports === 0) problems.push("no viewport in the born recording");
  return {
    problems,
    frames,
    viewports,
    sibling_parents: siblingParents,
    subwindow_excused_frames: excusedFrames,
  };
}

// ------------------------------------------------------------------------------- per-leg facts

export interface VpResult {
  stream?: {
    status?: string;
    reason?: string | null;
    gate8?: {
      viewports?: Record<string, string | number | boolean>;
      adopt_stats?: Record<string, number | string | boolean | null>;
    };
  };
}

export interface ArmLine {
  event: string;
  frame: number;
  code?: number;
  state_before?: string;
  state_after?: string;
}

export interface VpLegFacts {
  leg: VpLeg;
  ran: boolean;
  exit_code: string | null;
  /** the full sink's errors (missing, magic, validator, resolver), then the patch sink's. */
  errors: string[];
  session: Record<string, unknown> | null;
  /** decoded transaction metas (vp-off reads their keys). */
  metas: Record<string, unknown>[];
  rec: ResolvedRecording | null;
  result: VpResult | null;
  arm: ArmLine[];
}

const recordingName = (spec: VpLegSpec, patch = false) =>
  `recording${patch ? "-patch" : ""}.rs${spec.version}`;

export async function readLeg(g: string, leg: VpLeg): Promise<VpLegFacts> {
  const spec = VP_LEGS[leg];
  const dir = join(g, leg, "capture");
  const exitText = await readText(join(dir, "exit-code.txt"));
  const facts: VpLegFacts = {
    leg,
    ran: exitText !== undefined && skipped(dir) === null,
    exit_code: exitText === undefined ? null : exitText.trim(),
    errors: [],
    session: null,
    metas: [],
    rec: null,
    result:
      (await readJson<VpResult>(join(dir, "evidence/result.json"))) ?? null,
    arm: jsonl<ArmLine>(await readText(join(dir, "arm.jsonl"))),
  };
  if (!facts.ran) return facts;
  for (const patch of [false, true]) {
    const p = join(dir, recordingName(spec, patch));
    if (!existsSync(p)) {
      if (!patch) facts.errors.push(`${recordingName(spec)} missing`);
      continue;
    }
    const bytes = new Uint8Array(readFileSync(p));
    const tag = recordingName(spec, patch);
    if (wireVersionOf(bytes) !== spec.version) {
      facts.errors.push(`${tag} is not render-stream/${spec.version}`);
      continue;
    }
    const errors = validateRecording(bytes, spec.version);
    if (errors.length > 0) {
      facts.errors.push(`${tag}: ${errors[0]}`);
      continue;
    }
    if (patch) continue;
    try {
      const decoded = decodeRecording(bytes, spec.version);
      facts.session = decoded.records[0].meta as unknown as Record<
        string,
        unknown
      >;
      facts.metas = decoded.records
        .filter((r) => r.meta.type === "transaction")
        .map((r) => r.meta as unknown as Record<string, unknown>);
      facts.rec = resolveRecording(bytes, spec.version);
    } catch (e) {
      facts.errors.push(`${tag}: ${(e as Error).message}`);
    }
  }
  return facts;
}

/** vp-validate's problems for one leg. */
export function validateProblems(
  f: VpLegFacts,
  spec: VpLegSpec,
  armFrame: number,
): string[] {
  if (!f.ran) return [`g8vp/${f.leg}/capture did not run`];
  const problems: string[] = [];
  if (f.exit_code !== "0") problems.push(`exit ${f.exit_code}`);
  for (const e of f.errors) problems.push(e);
  if (f.session) {
    const mode = f.session.viewports;
    if (spec.mode === null) {
      if ("viewports" in f.session)
        problems.push(
          `a /15 session carries viewports ${JSON.stringify(mode)}`,
        );
    } else if (mode !== spec.mode)
      problems.push(
        `session viewports ${JSON.stringify(mode)}, want "${spec.mode}"`,
      );
  }
  if (spec.mode === "on" && f.rec) {
    const bad = f.rec.transactions.filter((t) =>
      t.state.unsupported.some((u) => u.reason === "non-root-viewport"),
    );
    if (bad.length > 0)
      problems.push(
        `non-root-viewport under "on" in ${bad.length} transaction(s), first at frame ${bad[0].frame}`,
      );
  }
  if (spec.arm === "late") {
    const call = f.arm.find((a) => a.event === "arm-call");
    if (!call)
      problems.push("no arm-call in arm.jsonl (not armed through the API)");
    else {
      if (call.code !== 0) problems.push(`arm() returned ${call.code}`);
      if (call.frame !== armFrame)
        problems.push(`arm() called at frame ${call.frame}, want ${armFrame}`);
      if (call.state_before !== "standby")
        problems.push(`arm() from state ${call.state_before}, want standby`);
    }
    if (!f.arm.some((a) => a.event === "armed"))
      problems.push("no armed signal in arm.jsonl");
    const first = f.rec?.transactions[0]?.frame;
    if (first !== undefined && (first < armFrame || first > armFrame + 2))
      problems.push(
        `first transaction at frame ${first}, want K..K+2 (K=${armFrame})`,
      );
  }
  return problems;
}

/** vp-account's problems for one leg: stream.gate8.viewports and adopt_stats against `want`; on a
 * headless live leg no proxy-unresolved entry in the final resolved state; on a live leg the final
 * table holds created + adopted - freed viewports. `finalState` null: the final state is not
 * judged here (g8vl's live hosts, whose final state the receiver's shot judges). */
export function accountProblems(
  result: VpResult | null,
  want: VpLegAccount | undefined,
  finalState: State | undefined | null,
  headless: boolean,
): string[] {
  if (!want) return ["no expectation for this leg in expected.json"];
  const vp = result?.stream?.gate8?.viewports;
  if (!vp) return ["no stream.gate8.viewports in result.json"];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(want.viewports))
    if (vp[k] !== v) problems.push(`viewports.${k} ${vp[k]}, expected ${v}`);
  for (const [k, v] of Object.entries(want.min ?? {})) {
    const got = vp[k];
    if (typeof got !== "number" || got < v)
      problems.push(`viewports.${k} ${got}, expected >= ${v}`);
  }
  if (want.adopt_stats) {
    const stats = result?.stream?.gate8?.adopt_stats;
    if (!stats) problems.push("no stream.gate8.adopt_stats");
    else
      for (const [k, v] of Object.entries(want.adopt_stats))
        if (stats[k] !== v)
          problems.push(`adopt_stats.${k} ${stats[k]}, expected ${v}`);
  }
  if (vp.live === true && finalState !== null) {
    if (!finalState) problems.push("no final resolved state");
    else {
      // The evidence is written at stream end, after the scene's teardown freed its viewports,
      // while the last transaction precedes it; the fixture frees no viewport during the run. So
      // the final resolved table holds every viewport, and `freed` is only bounded.
      const table = (finalState.viewports ?? []).length;
      const n = Number(vp.created ?? 0) + Number(vp.adopted ?? 0);
      if (table !== n)
        problems.push(
          `final viewport table holds ${table}, created + adopted = ${n}`,
        );
      const freed = Number(vp.freed ?? 0);
      if (!(freed >= 0 && freed <= n))
        problems.push(`viewports.freed ${vp.freed}, expected 0..${n}`);
      if (headless) {
        const unresolved = finalState.textures.filter(
          (t) => t.reason === "proxy-unresolved",
        ).length;
        if (unresolved > 0)
          problems.push(
            `${unresolved} proxy-unresolved entr${unresolved === 1 ? "y" : "ies"} in the final resolved state`,
          );
      }
    }
  }
  return problems;
}

const V16_KEYS = ["viewports", "removed_viewports"];
const V16_REASONS = new Set([
  "viewport-3d",
  "viewport-hdr-2d",
  "viewport-msaa-2d",
]);

/** The session minus what /15 and /16-off may differ by: the protocol, the viewports key, the
 * session and stream ids, and the viewport family in hooks_planned/hooks_omitted. */
export function sessionModuloVp(
  s: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!s) return null;
  const c = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  delete c.protocol;
  delete c.viewports;
  delete c.session_id;
  const stream = c.stream as Record<string, unknown> | undefined;
  if (stream) delete stream.stream_id;
  const capture = c.capture as Record<string, unknown> | undefined;
  const family = new Set<string>(VIEWPORT_FAMILY);
  if (capture)
    for (const k of ["hooks_planned", "hooks_omitted"])
      if (Array.isArray(capture[k]))
        capture[k] = (capture[k] as string[]).filter((h) => !family.has(h));
  return c;
}

/** vp-off's problems: the off leg against the v15 leg. */
export function offProblems(off: VpLegFacts, v15: VpLegFacts): string[] {
  if (!off.ran || !v15.ran)
    return [
      `${!off.ran ? "g8vp/off/capture" : "g8vp/v15/capture"} did not run`,
    ];
  const problems: string[] = [];
  if (!off.rec || !v15.rec)
    return [`${!off.rec ? "off" : "v15"} recording unreadable`];
  if (off.session?.viewports !== "off")
    problems.push(
      `off session viewports ${JSON.stringify(off.session?.viewports)}`,
    );
  let nonRoot = 0;
  for (const m of off.metas) {
    for (const k of V16_KEYS)
      if (k in m) problems.push(`seq ${m.seq}: transaction key ${k}`);
    const textures = (m.textures ?? []) as { kind?: string; reason?: string }[];
    for (const t of textures) {
      if (t.kind === "viewport" || t.kind === "proxy")
        problems.push(`seq ${m.seq}: a ${t.kind} texture`);
      if (t.reason === "proxy-unresolved")
        problems.push(`seq ${m.seq}: a proxy-unresolved texture`);
    }
    const unsupported = (m.unsupported ?? []) as {
      reason: string;
      item: number | null;
    }[];
    for (const u of unsupported) {
      if (V16_REASONS.has(u.reason))
        problems.push(`seq ${m.seq}: unsupported ${u.reason}`);
      if (u.reason === "non-root-viewport" && u.item === null) nonRoot++;
    }
  }
  if (nonRoot === 0)
    problems.push("no session-level non-root-viewport entry (the /15 typing)");
  const so = sessionModuloVp(off.session) ?? {};
  const sv = sessionModuloVp(v15.session) ?? {};
  if (!eq(so, sv)) {
    const keys = new Set([...Object.keys(so), ...Object.keys(sv)]);
    const diff = [...keys].filter((k) => !eq(so[k], sv[k]));
    problems.push(
      `session differs from v15's beyond protocol/viewports: ${diff.join(",")}`,
    );
  }
  const framesOff = off.rec.transactions.map((t) => t.frame);
  const framesV15 = v15.rec.transactions.map((t) => t.frame);
  if (!eq(framesOff, framesV15))
    problems.push(
      `transaction frames differ (${framesOff.length} vs ${framesV15.length})`,
    );
  const first = Math.min(framesOff[0] ?? 0, framesV15[0] ?? 0);
  const last = Math.max(framesOff.at(-1) ?? 0, framesV15.at(-1) ?? 0);
  let differing = 0;
  for (let f = first; f <= last; f++) {
    const a = stateAt(off.rec, f);
    const b = stateAt(v15.rec, f);
    if (!a && !b) continue;
    if (!eq(a?.state, b?.state)) {
      differing++;
      if (differing <= 3)
        problems.push(`frame ${f}: the resolved state differs from v15's`);
    }
  }
  if (differing > 3)
    problems.push(`${differing} frames' resolved states differ from v15's`);
  return problems;
}

/** vp-sabotage's problems for one sabotage leg, given its per-check problems (null: not judged). */
export function sabotageProblems(
  kind: keyof typeof VP_SABOTAGES,
  results: Partial<Record<VpCheckId, string[] | null>>,
): string[] {
  const s = VP_SABOTAGES[kind];
  const problems: string[] = [];
  const target = results[s.target];
  if (target === null || target === undefined)
    problems.push(`${kind}: ${s.target} could not be judged`);
  else if (target.length === 0)
    problems.push(`${kind}: ${s.target} passed on the sabotage leg`);
  for (const id of s.must_pass) {
    const r = results[id];
    if (r === null || r === undefined)
      problems.push(`${kind}: ${id} could not be judged`);
    else if (r.length > 0)
      problems.push(`${kind}: ${id} failed too: ${r.slice(0, 2).join("; ")}`);
  }
  return problems;
}

// ------------------------------------------------------------------------------------- the group

export async function runG8vp(
  out: string,
  ex: VpExpected,
): Promise<{ checks: G8aCheck[]; report: Record<string, unknown> }> {
  const g = join(out, "g8vp");
  const K = ex.arm_frame;
  const checks: G8aCheck[] = [];
  const report: Record<string, unknown> = {};
  const facts = {} as Record<VpLeg, VpLegFacts>;
  for (const leg of Object.keys(VP_LEGS) as VpLeg[])
    facts[leg] = await readLeg(g, leg);
  report.legs = Object.fromEntries(
    Object.values(facts).map((f) => [
      f.leg,
      {
        exit_code: f.exit_code,
        ran: f.ran,
        transactions: f.rec?.transactions.length ?? null,
        viewports: f.result?.stream?.gate8?.viewports ?? null,
      },
    ]),
  );

  const validate = (leg: VpLeg) =>
    validateProblems(facts[leg], VP_LEGS[leg], K);
  const account = (leg: VpLeg) => {
    const f = facts[leg];
    if (!f.ran) return [`g8vp/${leg}/capture did not run`];
    const spec = VP_LEGS[leg];
    return accountProblems(
      f.result,
      ex.account[spec.base ?? leg],
      f.rec?.transactions.at(-1)?.state,
      spec.host === "headless",
    );
  };
  const equivalencePair = (bornLeg: VpLeg, lateLeg: VpLeg) => {
    const b = facts[bornLeg];
    const l = facts[lateLeg];
    if (!b.rec || !l.rec)
      return {
        problems: [
          `${!b.rec ? `g8vp/${bornLeg}` : `g8vp/${lateLeg}`}/capture has no readable recording`,
        ],
        frames: 0,
        viewports: 0,
        sibling_parents: 0,
        subwindow_excused_frames: 0,
      };
    const from = Math.max(K, l.rec.transactions[0]?.frame ?? K);
    return vpEquivalence(
      b.rec,
      l.rec,
      from,
      ex.equivalence.residue,
      ex.equivalence.subwindow_residue ? SUBWINDOW_RESIDUE_LAYER : undefined,
    );
  };

  // --- vp-validate ---------------------------------------------------------------------------
  {
    const problems: string[] = [];
    const rows: string[] = [];
    for (const leg of HONEST_LEGS) {
      const p = validate(leg);
      for (const x of p) problems.push(`${leg}: ${x}`);
      rows.push(
        `${leg} ${facts[leg].rec?.transactions.length ?? 0} tx ${VP_LEGS[leg].mode ?? "/15"}`,
      );
    }
    checks.push(
      check(
        "vp-validate",
        'every honest g8vp leg (born, late, off, v15, born-rendered, late-rendered) exited 0 and its full and patch recordings validate with the TS oracle at their version (/16, v15 at /15); /16 sessions say viewports "on" (the off leg "off"), the /15 session has no viewports key, no non-root-viewport entry occurs under "on", and the late legs armed through RenderStreamCapture.arm() from standby at frame K (arm.jsonl: code 0, then the armed signal; first transaction at K..K+2)',
        problems,
        rows.join(", "),
      ),
    );
  }

  // --- vp-equivalence --------------------------------------------------------------------------
  {
    const pairs: [VpLeg, VpLeg][] = [
      ["born", "late"],
      ["born-rendered", "late-rendered"],
    ];
    const problems: string[] = [];
    const rows: string[] = [];
    const eqReport: Record<string, unknown> = {};
    for (const [b, l] of pairs) {
      const e = equivalencePair(b, l);
      for (const p of e.problems) problems.push(`${l}: ${p}`);
      rows.push(
        `${l} vs ${b}: ${e.frames} frames, ${e.viewports} viewports, ${e.sibling_parents} parent(s) with ordered siblings, subwindow residue excused at ${e.subwindow_excused_frames} frame(s)`,
      );
      eqReport[l] = {
        frames: e.frames,
        subwindow_excused_frames: e.subwindow_excused_frames,
        viewports: e.viewports,
        problems: e.problems.length,
        first_problems: e.problems.slice(0, 8),
      };
    }
    report.equivalence = eqReport;
    checks.push(
      check(
        "vp-equivalence",
        `late equals born at every frame from the arm (K=${K}) on, for the headless pair and the rendered pair: the root's canvases and items through gate8-adopt-checks' canonical states, each viewport's canvases and items the same way, and the viewport table structurally (keys, every field and float, sibling order, the proxies' targets mapped to the corresponding viewport, unsupported and failures), modulo exactly: ${VP_EXCEPTIONS.join("; ")}`,
        problems,
        rows.join("; "),
      ),
    );
  }

  // --- vp-account ------------------------------------------------------------------------------
  {
    const problems: string[] = [];
    const rows: string[] = [];
    for (const leg of HONEST_LEGS) {
      for (const p of account(leg)) problems.push(`${leg}: ${p}`);
      const v = facts[leg].result?.stream?.gate8?.viewports;
      if (v)
        rows.push(
          `${leg} ${v.mode} created ${v.created} adopted ${v.adopted} adj ${v.proxies_bound_adjacency} rid ${v.proxies_bound_rid} node ${v.proxies_bound_node_route} unresolved_now ${v.unresolved_now}`,
        );
    }
    checks.push(
      check(
        "vp-account",
        "each honest leg's result.json stream.gate8.viewports (mode, hooked, live, created, adopted, renders_3d, unknown_viewport_calls exactly; freed at most created + adopted, as the scene's teardown precedes the evidence; the proxy routes' floors: adjacency and node route on the headless born leg, adopted proxies on the late legs, proxies_bound_rid on the rendered legs) and stream.gate8.adopt_stats (viewports_adopted, non_root_viewports 0 when live) match expected.json; on every live leg the final resolved viewport table holds created + adopted entries, and on the headless live legs no proxy-unresolved texture is left in the final resolved state",
        problems,
        rows.join("; "),
      ),
    );
  }

  // --- vp-off ----------------------------------------------------------------------------------
  {
    const problems = offProblems(facts.off, facts.v15);
    checks.push(
      check(
        "vp-off",
        "GRC_VIEWPORTS=off at /16: the session says viewports \"off\", no transaction carries viewports/removed_viewports, a viewport or proxy texture, proxy-unresolved or a viewport-* reason, session-level non-root-viewport entries are present (the /15 typing), and every frame's resolved state equals the v15 leg's (the session equal modulo protocol, viewports, ids and the viewport hook family)",
        problems,
        `${facts.off.rec?.transactions.length ?? 0} transactions equal to v15's`,
      ),
    );
  }

  // --- vp-sabotage -----------------------------------------------------------------------------
  {
    const problems: string[] = [];
    const rows: string[] = [];
    const sabReport: Record<string, unknown> = {};
    for (const kind of Object.keys(
      VP_SABOTAGES,
    ) as (keyof typeof VP_SABOTAGES)[]) {
      const s = VP_SABOTAGES[kind];
      const f = facts[s.leg];
      if (!f.ran) {
        problems.push(`g8vp/${s.leg}/capture did not run`);
        continue;
      }
      const results: Partial<Record<VpCheckId, string[] | null>> = {
        "vp-validate": validate(s.leg),
        "vp-account": account(s.leg),
      };
      if (VP_LEGS[s.leg].arm === "late")
        results["vp-equivalence"] = equivalencePair("born", s.leg).problems;
      const p = sabotageProblems(kind, results);
      problems.push(...p);
      const target = results[s.target] ?? [];
      sabReport[kind] = Object.fromEntries(
        Object.entries(results).map(([k, v]) => [k, (v ?? []).slice(0, 3)]),
      );
      rows.push(
        `${kind}: ${s.target} fails (${target.slice(0, 2).join("; ")})`,
      );
    }
    report.sabotages = sabReport;
    checks.push(
      check(
        "vp-sabotage",
        "each GRC_VIEWPORT_SABOTAGE leg fails its target check and passes the others named for it: no-adjacency (born) fails vp-account, passes vp-validate; no-node-route (late) fails vp-account, passes vp-validate; wrong-order (late) fails vp-equivalence, passes vp-validate and vp-account",
        problems,
        rows.join("; "),
      ),
    );
  }
  // --- vp-reference (VS3) -----------------------------------------------------------------------
  {
    const r = await referenceProblems(g, ex.reference);
    report.reference = r.pixels;
    checks.push(
      check(
        "vp-reference",
        `the born and late captures (headless: adjacency and node-route proxies; rendered: RID proxies; late: viewports and proxies adopted at the API arm) replayed by a rendered receiver match the rendered host's own Godot shots of the same arm (${VP_REFERENCE_DIR}/shots for born, ${VP_LATE_REFERENCE_DIR}/shots for late) at every step: a GSW receiver draws every reached viewport into its own surface, judged per expected.json reference region (exact: every pixel within ${ex.reference?.channel ?? "?"} channel step(s); banded: counted; excluded: typed content the receiver does not draw); a native receiver draws no surface and is judged on its exit and shots`,
        r.problems,
        r.rows.join("; "),
      ),
    );
  }
  return { checks, report };
}
