// Gate 8 g8a checks (G8a, protocol/gate8-design.md "Q2. Late-join adoption"): the arm-time
// adoption of canvases, layers and items, judged on fixtures/gate8-adopt. The pure helpers
// (canonicalState, compareStates, ...) are exported so scripts/test/self-test-gate8-adopt.ts can
// drive them on synthetic resolved states.
//
// Born-armed equivalence (D15.1) compares the late capture's resolved state with the born
// capture's at every frame from the arm on, through an id bijection built per container in draw
// order (children sorted by draw_index, then list position), never through the ids themselves.
// Q2's exception list, and only it, is applied:
//   - ids, versions and content_version (the bijection; never compared);
//   - origin;
//   - draw-index values (the order per container is compared instead);
//   - items not visible in tree in either capture: their draw-derived state (commands, a
//     Control's custom rect and clip) is not compared, and the RS visibility flag of every item
//     is compared as effective visibility (an item hidden at arm carries no commands until shown);
//   - the residue: born-only trailing items with no commands and no children (the fixture's one
//     RS-only item, at draw index 1000 under the root canvas), counted.
// A command naming a texture is compared through the texture's payload hash (texture ids differ:
// the born capture also saw the engine's frame-1 default-theme texture), one naming a mesh through
// its surfaces' hashes.
//
// G8r (gate8-design.md D6, D7) adds lazily adopted textures and meshes, and two exceptions, each
// counted per resource and judged against expected.json `exceptions`:
//   - creation: a command whose late texture is adopted with adopted_content "creation" may name
//     other content than born's (the dummy's creation copy of a texture updated in place before
//     arm: the declared limit of D6);
//   - refused: a command the late capture types `unsupported` / `unknown-texture` where born names
//     a texture (a pre-arm texture nothing can read back, e.g. a PlaceholderTexture2D), and the
//     derived item-level unknown-texture entry that goes with it.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { compareWorkerRecordings } from "./gate8-tex-checks";
import {
  decodeRecording,
  type ResolvedItem,
  type ResolvedRecording,
  type ResolvedTransaction,
  resolveRecording,
  validateRecording,
  wireVersionOf,
} from "./render-stream-2";

export interface G8aCheck {
  id: string;
  criterion: string;
  passed: boolean;
  status: "pass" | "fail" | "not-run";
  detail?: string;
  gating?: boolean;
}

export interface G8aCensus {
  items: number;
  layers: number;
  canvases: number;
  hidden: number;
  top_level: number;
  redraws: number;
  canvas_modulates: number;
  lights: number;
  materials: number;
  non_root_viewports: number;
}

/** G8r: lazy resource adoption's account (stream.gate8.adopt_stats.resources). */
export interface G8rResources {
  textures: number;
  textures_current: number;
  textures_creation: number;
  atlas_pages: number;
  compressed: number;
  from_update: number;
  decoded: number;
  textures_refused: number;
  meshes: number;
  mesh_surfaces: number;
  meshes_refused: number;
  cached_compressed: number;
  /** the host-decoded adopted texture's source format. */
  source_format: string;
}

/** G8r: the equivalence exceptions the fixture's resources allow (counted per draw path). */
export interface EquivalenceAllow {
  creation?: { paths: number; until_frame: number };
  refused?: { paths: number };
}

export interface G8aExpected {
  schema: "render-stream-gate8-adopt-expected/1";
  doc: string;
  arm_frame: number;
  /** [applied, settle] offsets from the arm frame, per checkpoint (adopt.gd). */
  checkpoints: { step: number; applied: number; settle: number }[];
  census: G8aCensus;
  /** draw signals the arm-time redraws emit (the items visible in tree at arm). */
  visible_at_arm: number;
  /** nodes adopt.gd's probe hashes (the Adopt subtree). */
  probe_nodes: number;
  residue: number;
  strict: { reason: string; op: string; frame_offset: number };
  resources: G8rResources;
  exceptions: { creation: { paths: number; until_offset: number }; refused: { paths: number } };
  /** screen rects [x0, y0, x1, y1] inclusive and the checkpoints at which each may differ. */
  regions: Record<"creation" | "refused", { rect: [number, number, number, number]; steps: number[] }>;
}

export interface G8aReport {
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  cost: Record<string, unknown> | null;
  equivalence: { frames_compared: number; residue: number; first_problems: string[] } | null;
  pixels: Record<string, { step: number; differing: number; max_delta: number; outside?: number }[]>;
  sabotages: Record<string, { equivalence_problems: number; differing_px: number }>;
  /** G8r: lazy resource adoption. */
  resources: {
    late: Record<string, unknown> | null;
    exceptions: { creation: string[]; refused: string[]; creation_frames: number[] } | null;
    workers: { sync_transactions: number; async_transactions: number; held_frames: number } | null;
  };
}

// --------------------------------------------------------------------------- canonical states

type State = ResolvedTransaction["state"];

export interface CanonItem {
  path: string;
  effective: boolean;
  fields: Record<string, unknown>;
  draw: Record<string, unknown>;
  children: CanonItem[];
}

export interface CanonCanvas {
  key: string;
  fields: Record<string, unknown>;
  items: CanonItem[];
}

/** Children in draw order: draw_index ascending, ties in list order (the server's stable view). */
export function drawOrder(ids: number[], items: Map<number, ResolvedItem>): ResolvedItem[] {
  return ids
    .map((id, pos) => ({ item: items.get(id), pos }))
    .filter((x): x is { item: ResolvedItem; pos: number } => x.item !== undefined)
    .sort((a, b) => a.item.draw_index - b.item.draw_index || a.pos - b.pos)
    .map((x) => x.item);
}

/** A texture reference's canonical key: its payload hash (else kind:status); an adopted texture
 * declared "creation" is marked `creation:<hash>` so compareStates can apply G8r's exception. */
const CREATION = "creation:";

export function canonicalState(state: State): CanonCanvas[] {
  const items = new Map<number, ResolvedItem>();
  for (const it of state.items) items.set(it.id, it);
  const texHash = new Map<number, string>();
  for (const t of state.textures) {
    const key = t.hash ?? `${t.kind}:${t.status}`;
    texHash.set(t.id, t.origin === "adopted" && t.adopted_content === "creation" ? CREATION + key : key);
  }
  const meshKey = new Map<number, string>();
  for (const m of state.meshes ?? [])
    meshKey.set(m.id, `mesh:${m.status}:${m.surfaces.map((x) => x.hash).join(",")}`);
  // G8m: a material compares by content (ids, versions and origin are Q2's exceptions): its status,
  // its shader's status, reason, hash, builtin and default textures, and its parameters, every
  // texture named through its payload hash (an adopted creation copy by its hash too: no resource
  // exception applies to a material, so a creation copy that differs is a difference).
  const plainTex = (id: number) => {
    const key = texHash.get(id);
    return key === undefined ? `missing:${id}` : key.startsWith(CREATION) ? key.slice(CREATION.length) : key;
  };
  const texOf = (v: unknown) =>
    v !== null && typeof v === "object" && typeof (v as { tex?: unknown }).tex === "number"
      ? { tex: plainTex((v as { tex: number }).tex) }
      : v;
  const canonParams = (ps: { name: string; type: string; value: unknown }[] | undefined) =>
    (ps ?? []).map((p) => ({ name: p.name, type: p.type, value: texOf(p.value) }));
  const shaderKey = new Map<number, unknown>();
  for (const sh of state.shaders ?? [])
    shaderKey.set(sh.id, {
      status: sh.status,
      reason: sh.reason,
      hash: sh.hash,
      builtin: sh.builtin,
      defaults: sh.default_textures.map((d) => ({ name: d.name, index: d.index, tex: plainTex(d.tex) })),
    });
  const materialKey = new Map<number, unknown>();
  for (const m of state.materials ?? [])
    materialKey.set(m.id, {
      status: m.status,
      reason: m.reason,
      shader: m.shader === null ? null : (shaderKey.get(m.shader) ?? `missing-shader:${m.shader}`),
      params: canonParams(m.params),
    });
  const canonCommands = (it: ResolvedItem) =>
    it.commands.map((c) => {
      const out: Record<string, unknown> = { ...c };
      if (typeof c.tex === "number") out.tex = texHash.get(c.tex) ?? `missing:${c.tex}`;
      const mesh = (c as { mesh?: unknown }).mesh;
      if (typeof mesh === "number") out.mesh = meshKey.get(mesh) ?? `missing-mesh:${mesh}`;
      return out;
    });
  const visit = (it: ResolvedItem, path: string, parentEffective: boolean): CanonItem => {
    const effective = parentEffective && it.visible;
    return {
      path,
      effective,
      fields: {
        xform: it.xform,
        modulate: it.modulate,
        self_modulate: it.self_modulate,
        z_index: it.z_index,
        z_relative: it.z_relative,
        behind: it.behind,
        visibility_layer: it.visibility_layer,
        texture_filter: it.texture_filter,
        texture_repeat: it.texture_repeat,
        material:
          it.material === null || it.material === undefined
            ? null
            : (materialKey.get(it.material) ?? `missing-material:${it.material}`),
        use_parent_material: it.use_parent_material ?? false,
        instance_params: canonParams(it.instance_params),
      },
      draw: {
        commands: canonCommands(it),
        clip: it.clip,
        custom_rect: it.custom_rect,
        custom_rect_rect: it.custom_rect ? it.custom_rect_rect : null,
      },
      children: drawOrder(it.children, items).map((c, i) => visit(c, `${path}/${i}`, effective)),
    };
  };
  const canvases = [...state.canvases].sort((a, b) => {
    const rank = (c: typeof a) => (c.role === "root" ? 0 : c.attached ? 1 : 2);
    return (
      rank(a) - rank(b) || (a.layer ?? 0) - (b.layer ?? 0) || (a.sublayer ?? 0) - (b.sublayer ?? 0) || a.id - b.id
    );
  });
  return canvases.map((c, ci) => {
    const key = c.role === "root" ? "root" : `${c.attached ? "attached" : "detached"}#${ci}`;
    return {
      key,
      fields: {
        role: c.role,
        attached: c.attached,
        layer: c.layer ?? 0,
        sublayer: c.sublayer ?? 0,
        xform: c.xform,
        modulate: c.modulate ?? [1, 1, 1, 1],
      },
      items: drawOrder(c.items, items).map((it, i) => visit(it, `${key}/${i}`, c.attached)),
    };
  });
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function residueLike(it: CanonItem): boolean {
  return (it.draw.commands as unknown[]).length === 0 && it.children.length === 0;
}

/** G8r: whether two differing command lists differ only by the resource exceptions. Returns the
 * exception kind ("creation" before "refused" when both occur), "none" when only the creation
 * marks of exact creation copies differ, or null for a real difference. */
export function resourceException(
  born: Record<string, unknown>[],
  late: Record<string, unknown>[],
  keys?: { creation: Set<string>; refused: Set<string> },
): "none" | "creation" | "refused" | null {
  if (born.length !== late.length) return null;
  let kind: "none" | "creation" | "refused" = "none";
  const creation: string[] = [];
  const refused: string[] = [];
  for (let i = 0; i < born.length; i++) {
    const b = born[i];
    const l = late[i];
    if (eq(b, l)) continue;
    const lt = l.tex;
    if (typeof lt === "string" && lt.startsWith(CREATION) && typeof b.tex === "string") {
      if (!eq({ ...b, tex: null }, { ...l, tex: null })) return null;
      if (lt.slice(CREATION.length) === b.tex) continue;  // a creation copy that is exact
      kind = "creation";
      creation.push(lt);
      continue;
    }
    if (l.op === "unsupported" && l.reason === "unknown-texture" && typeof b.tex === "string") {
      if (kind === "none") kind = "refused";
      refused.push(b.tex);
      continue;
    }
    return null;
  }
  // The exception's identity is the resource (the late creation copy's hash, the born texture's
  // key), not the draw path, which moves when a sibling leaves.
  for (const k of creation) keys?.creation.add(k);
  for (const k of refused) keys?.refused.add(k);
  return kind;
}

/** Compares a late capture's canonical state with the born one's under Q2's exceptions. Returns
 * the problems and the residue count (born-only trailing items with no commands or children).
 * `exceptions` (G8r) collects the resources excused by resourceException (creation-copy hashes,
 * refused born texture keys); without it a resource difference is a problem. */
export function compareStates(
  born: CanonCanvas[],
  late: CanonCanvas[],
  exceptions?: { creation: Set<string>; refused: Set<string> },
): { problems: string[]; residue: number } {
  const problems: string[] = [];
  let residue = 0;
  const items = (b: CanonItem[], l: CanonItem[], where: string) => {
    for (let i = 0; i < Math.max(b.length, l.length); i++) {
      const x = b[i];
      const y = l[i];
      if (x && !y) {
        if (residueLike(x)) residue++;
        else problems.push(`${x.path}: only in born`);
        continue;
      }
      if (!x && y) {
        problems.push(`${y.path}: only in late (${where})`);
        continue;
      }
      if (!x || !y) continue;
      if (x.effective !== y.effective)
        problems.push(`${x.path}: effective visibility ${x.effective} vs ${y.effective}`);
      for (const k of Object.keys(x.fields))
        if (!eq(x.fields[k], y.fields[k]))
          problems.push(`${x.path}: ${k} ${JSON.stringify(x.fields[k])} vs ${JSON.stringify(y.fields[k])}`);
      if (x.effective && y.effective)
        for (const k of Object.keys(x.draw)) {
          if (eq(x.draw[k], y.draw[k])) continue;
          if (k === "commands") {
            const kind = resourceException(
              x.draw[k] as Record<string, unknown>[],
              y.draw[k] as Record<string, unknown>[],
              exceptions,
            );
            if (kind === "none") continue;  // exact creation copies: not a difference
            if (kind !== null && exceptions) continue;
          }
          problems.push(
            `${x.path}: ${k} ${JSON.stringify(x.draw[k]).slice(0, 120)} vs ${JSON.stringify(y.draw[k]).slice(0, 120)}`,
          );
        }
      items(x.children, y.children, x.path);
    }
  };
  for (let i = 0; i < Math.max(born.length, late.length); i++) {
    const b = born[i];
    const l = late[i];
    if (b && !l) {
      if (b.items.every(residueLike) && b.key !== "root") residue += b.items.length;
      else problems.push(`canvas ${b.key}: only in born`);
      continue;
    }
    if (!b && l) {
      problems.push(`canvas ${l.key}: only in late`);
      continue;
    }
    if (!b || !l) continue;
    for (const k of Object.keys(b.fields))
      if (!eq(b.fields[k], l.fields[k]))
        problems.push(`canvas ${b.key}: ${k} ${JSON.stringify(b.fields[k])} vs ${JSON.stringify(l.fields[k])}`);
    items(b.items, l.items, `canvas ${b.key}`);
  }
  return { problems, residue };
}

/** The resolved state in force at `frame`: the last transaction published at or before it. */
export function stateAt(rec: ResolvedRecording, frame: number): ResolvedTransaction | undefined {
  let best: ResolvedTransaction | undefined;
  for (const t of rec.transactions) if (t.frame <= frame) best = t;
  return best;
}

const unsupportedKeys = (s: State) => s.unsupported.map((u) => `${u.op}|${u.reason}`).sort();
const failureKeys = (s: State) => s.failures.map((f) => f.reason).sort();

/** Equivalence over every frame from `fromFrame` to the last frame both recordings cover. `allow`
 * (G8r): the resource exceptions the fixture declares; each is counted per draw path over the
 * whole run and must match exactly (a creation exception only before `until_frame`), and every
 * frame's late unknown-texture entries must be exactly its refused paths. */
export function equivalence(
  born: ResolvedRecording,
  late: ResolvedRecording,
  fromFrame: number,
  expectedResidue: number,
  allow: EquivalenceAllow = {},
): {
  problems: string[];
  frames: number;
  residue: number;
  exceptions: { creation: string[]; refused: string[]; creation_frames: number[] };
} {
  const problems: string[] = [];
  const creationAll = new Set<string>();
  const refusedAll = new Set<string>();
  const creationFrames: number[] = [];
  const last = Math.min(
    born.transactions.at(-1)?.frame ?? 0,
    late.transactions.at(-1)?.frame ?? 0,
  );
  let frames = 0;
  let residueMax = 0;
  for (let f = fromFrame; f <= last; f++) {
    const b = stateAt(born, f);
    const l = stateAt(late, f);
    if (!b || !l) {
      problems.push(`frame ${f}: ${!b ? "born" : "late"} has no transaction yet`);
      continue;
    }
    frames++;
    const ex = { creation: new Set<string>(), refused: new Set<string>() };
    const r = compareStates(canonicalState(b.state), canonicalState(l.state), ex);
    residueMax = Math.max(residueMax, r.residue);
    if (r.residue !== expectedResidue)
      problems.push(`frame ${f}: residue ${r.residue}, expected ${expectedResidue}`);
    for (const p of r.problems) problems.push(`frame ${f}: ${p}`);
    for (const p of ex.creation) creationAll.add(p);
    for (const p of ex.refused) refusedAll.add(p);
    if (ex.creation.size > 0) {
      creationFrames.push(f);
      if (!allow.creation || f >= allow.creation.until_frame)
        problems.push(`frame ${f}: creation-content difference at ${[...ex.creation].join(",")}`);
    }
    if (ex.refused.size > 0 && !allow.refused)
      problems.push(`frame ${f}: refused texture at ${[...ex.refused].join(",")}`);
    // The refused draws' derived item-level unknown-texture entries are the exception's own.
    const lateUnknown = l.state.unsupported.filter((u) => u.reason === "unknown-texture").length;
    const lateKeys = unsupportedKeys(l.state).filter((k) => !k.endsWith("|unknown-texture"));
    const bornKeys = unsupportedKeys(b.state);
    if (lateUnknown !== ex.refused.size)
      problems.push(`frame ${f}: ${lateUnknown} unknown-texture entries, ${ex.refused.size} refused draws`);
    if (!eq(bornKeys, lateKeys))
      problems.push(`frame ${f}: unsupported ${bornKeys.join(",")} vs ${lateKeys.join(",")}`);
    if (!eq(failureKeys(b.state), failureKeys(l.state)))
      problems.push(`frame ${f}: failures ${failureKeys(b.state)} vs ${failureKeys(l.state)}`);
  }
  if (frames === 0) problems.push("no frame compared");
  const wantCreation = allow.creation?.paths ?? 0;
  const wantRefused = allow.refused?.paths ?? 0;
  if (creationAll.size !== wantCreation)
    problems.push(`${creationAll.size} creation-content resource(s) (${[...creationAll].join(",")}), expected ${wantCreation}`);
  if (refusedAll.size !== wantRefused)
    problems.push(`${refusedAll.size} refused-texture resource(s) (${[...refusedAll].join(",")}), expected ${wantRefused}`);
  return {
    problems,
    frames,
    residue: residueMax,
    exceptions: { creation: [...creationAll], refused: [...refusedAll], creation_frames: creationFrames },
  };
}

// ------------------------------------------------------------------------------- evidence

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  const t = await readText(path);
  if (t === undefined) return undefined;
  try {
    return JSON.parse(t) as T;
  } catch {
    return undefined;
  }
}

export function jsonl<T>(text: string | undefined): T[] {
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

export async function exitCode(dir: string): Promise<string | null> {
  const t = await readText(join(dir, "exit-code.txt"));
  return t === undefined ? null : t.trim();
}

export function skipped(dir: string): string | null {
  if (existsSync(join(dir, "skipped-by-tier.txt"))) return "skipped-by-tier";
  if (existsSync(join(dir, "skipped-remote.txt"))) return "skipped-remote";
  return null;
}

export async function loadRecording(
  dir: string,
  version: 8 | 9 = 8,
): Promise<{ bytes?: Uint8Array; rec?: ResolvedRecording; error?: string }> {
  const path = join(dir, `recording.rs${version}`);
  if (!existsSync(path)) return { error: `${path} missing` };
  const bytes = new Uint8Array(await readFile(path));
  if (wireVersionOf(bytes) !== version) return { bytes, error: `${path} is not GRS${version}` };
  try {
    return { bytes, rec: resolveRecording(bytes, version) };
  } catch (e) {
    return { bytes, error: `${path}: ${(e as Error).message}` };
  }
}

interface CaptureResult {
  stream?: {
    status?: string;
    reason?: string | null;
    unknown_items?: { unknown_rids_named: number; withheld_items: number } | null;
    gate8?: { adopt?: string; adopt_stats?: Record<string, number | string | boolean | null> };
  };
}

interface ProbeLine {
  frame: number;
  nodes: number;
  hash: string;
  draws: number;
}

async function shotPath(dir: string, step: number): Promise<string> {
  const seqs = await readText(join(dir, "shot-seqs.txt"));
  if (seqs === undefined) return join(dir, "shots", `step-${step}.png`);
  return join(dir, "shots", `seq-${seqs.trim().split(",")[step]}.png`);
}

export type Rect = [number, number, number, number];

/** Differing pixels of two shots; with `regions` (G8r's declared rects) also split by region:
 * `inside[i]` counts the pixels in regions[i], `outside` the rest. */
export async function shotDiff(
  a: string,
  b: string,
  step: number,
  regions: Rect[] = [],
): Promise<{ step: number; present: boolean; differing: number; max_delta: number; inside: number[]; outside: number }> {
  const ia = existsSync(await shotPath(a, step)) ? await decodePngRgba(await shotPath(a, step)) : undefined;
  const ib = existsSync(await shotPath(b, step)) ? await decodePngRgba(await shotPath(b, step)) : undefined;
  const out = { step, present: false, differing: 0, max_delta: 0, inside: regions.map(() => 0), outside: 0 };
  if (!ia || !ib || ia.width !== ib.width || ia.height !== ib.height) return out;
  out.present = true;
  for (let i = 0; i < ia.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(ia.data[i + c] - ib.data[i + c]));
    if (d > 0) {
      out.differing++;
      out.max_delta = Math.max(out.max_delta, d);
      const p = i / 4;
      const x = p % ia.width;
      const y = Math.floor(p / ia.width);
      const r = regions.findIndex((q) => x >= q[0] && x <= q[2] && y >= q[1] && y <= q[3]);
      if (r >= 0) out.inside[r]++;
      else out.outside++;
    }
  }
  return out;
}

export function check(
  id: string,
  criterion: string,
  problems: string[] | null,
  detailOk?: string,
): G8aCheck {
  if (problems === null)
    // A failure, not "not-run": lib/tier-verdict.py excuses exactly the checks whose id or
    // detail names a leg skipped by tier or on a remote runner.
    return { id, criterion, passed: false, status: "fail", detail: "evidence missing (a leg did not run)" };
  const passed = problems.length === 0;
  return {
    id,
    criterion,
    passed,
    status: passed ? "pass" : "fail",
    detail: passed ? detailOk : `${problems.length} problem(s): ${problems.slice(0, 12).join("; ")}`,
  };
}

/** adopt-account's census problems for one capture's result.json. */
export function censusProblems(
  stats: Record<string, number | string | boolean | null> | undefined,
  census: G8aCensus,
  sabotage: "none" | "adopt-skip-layers" | "adopt-no-redraw" = "none",
): string[] {
  if (!stats) return ["no stream.gate8.adopt_stats"];
  const problems: string[] = [];
  const want: Record<string, number> = { ...census };
  if (sabotage === "adopt-skip-layers") {
    want.layers = 0;
    want.canvases = 0;
  }
  if (sabotage === "adopt-no-redraw") want.redraws = 0;
  if (stats.ran !== true) problems.push("adoption did not run");
  if (stats.error !== null && stats.error !== undefined) problems.push(`error ${stats.error}`);
  for (const [k, v] of Object.entries(want))
    if (stats[k] !== v) problems.push(`${k} ${stats[k]}, expected ${v}`);
  if (typeof stats.total_ns !== "number" || stats.total_ns <= 0) problems.push("no adoption time");
  return problems;
}

// ------------------------------------------------------------------------------- the group

const SABOTAGES = ["adopt-skip-state", "adopt-no-redraw", "adopt-skip-layers"] as const;
// G8r: the GRC_ADOPT_FAULT captures (run-gate8.sh G8R_FAULTS); the first two also rendered.
const FAULTS = ["no-resources", "atlas-from-dummy", "claim-current"] as const;
const FAULTS_RENDERED = ["no-resources", "atlas-from-dummy"] as const;

export async function runG8a(out: string, expected: G8aExpected): Promise<{ checks: G8aCheck[]; report: G8aReport }> {
  const root = join(out, "g8a");
  const checks: G8aCheck[] = [];
  const legDirs = [
    "import/fixture",
    "import/receiver",
    "born/capture",
    "born-adopt/capture",
    "late/capture",
    "late-strict/capture",
    "late-thread/capture",
    "late-workers/capture",
    ...SABOTAGES.map((s) => `sabotage-${s}/capture`),
    ...FAULTS.map((s) => `fault-${s}/capture`),
    "reference",
    "born/receiver",
    "late/receiver",
    "late/receiver-patch",
    ...SABOTAGES.map((s) => `sabotage-${s}/receiver`),
    ...FAULTS_RENDERED.map((s) => `fault-${s}/receiver`),
  ];
  const legs: G8aReport["legs"] = {};
  for (const l of legDirs)
    legs[l] = { exit_code: await exitCode(join(root, l)), skipped: skipped(join(root, l)) };
  const ran = (l: string) => legs[l].exit_code !== null && legs[l].skipped === null;
  const K = expected.arm_frame;
  const report: G8aReport = {
    legs,
    cost: null,
    equivalence: null,
    pixels: {},
    sabotages: {},
    resources: { late: null, exceptions: null, workers: null },
  };
  // G8r's declared exceptions (expected.json), shared by every comparison with born.
  const allow: EquivalenceAllow = {
    creation: { paths: expected.exceptions.creation.paths, until_frame: K + expected.exceptions.creation.until_offset },
    refused: { paths: expected.exceptions.refused.paths },
  };

  {
    const problems: string[] = [];
    for (const l of legDirs) {
      if (legs[l].skipped !== null) continue;
      if (legs[l].exit_code !== "0") problems.push(`${l} exit ${legs[l].exit_code}`);
    }
    checks.push(
      check(
        "g8a-legs",
        "every g8a leg that ran (import, the born/born-adopt/late/late-strict/sabotage captures, the rendered reference and every receiver) exits 0",
        problems,
        `${legDirs.filter(ran).length} legs`,
      ),
    );
  }

  const born = await loadRecording(join(root, "born/capture"));
  const late = await loadRecording(join(root, "late/capture"));
  const bornResult = await readJson<CaptureResult>(join(root, "born/capture/evidence/result.json"));
  const lateResult = await readJson<CaptureResult>(join(root, "late/capture/evidence/result.json"));

  // --- adopt-wire -------------------------------------------------------------------------
  {
    const problems: string[] = [];
    for (const [name, r] of [["born", born], ["late", late]] as const) {
      if (r.error || !r.bytes) {
        problems.push(r.error ?? `${name}: no recording`);
        continue;
      }
      const errors = validateRecording(r.bytes, 8);
      if (errors.length > 0) problems.push(`${name}: invalid /8 recording: ${errors[0]}`);
      const decoded = decodeRecording(r.bytes, 8) as unknown as { records: { meta: Record<string, unknown> }[] };
      const adoption = decoded.records[0]?.meta.adoption as { mode: string; frame: number } | null | undefined;
      if (name === "born" && adoption !== null) problems.push(`born: session adoption ${JSON.stringify(adoption)}`);
      if (name === "late" && (adoption?.mode !== "arm" || adoption.frame !== K))
        problems.push(`late: session adoption ${JSON.stringify(adoption)}, expected {"mode":"arm","frame":${K}}`);
    }
    if (late.rec) {
      const first = late.rec.transactions[0];
      if (!first || first.frame !== K) problems.push(`late: first transaction at frame ${first?.frame}, expected ${K}`);
      const adoptedFirst = new Set(first?.state.items.filter((i) => i.origin === "adopted").map((i) => i.id));
      if (adoptedFirst.size !== expected.census.items)
        problems.push(`late: ${adoptedFirst.size} adopted items in the first transaction, expected ${expected.census.items}`);
      for (const t of late.rec.transactions.slice(1))
        for (const i of t.state.items)
          if (i.origin === "adopted" && !adoptedFirst.has(i.id))
            problems.push(`late: item ${i.id} adopted after the first transaction (frame ${t.frame})`);
      const layers = first?.state.canvases.filter((c) => c.origin === "adopted").length ?? 0;
      if (layers !== expected.census.canvases) problems.push(`late: ${layers} adopted canvases`);
    }
    if (born.rec)
      for (const t of born.rec.transactions)
        if (t.state.items.some((i) => i.origin === "adopted") || t.state.canvases.some((c) => c.origin === "adopted"))
          problems.push(`born: adopted origin at frame ${t.frame}`);
    checks.push(
      check(
        "adopt-wire",
        `the born and late /8 recordings validate; born declares adoption null and carries no adopted origin; late declares {"mode":"arm","frame":${K}}, its first transaction is at frame ${K} and holds every adopted item and canvas, and nothing is adopted later`,
        born.bytes || late.bytes ? problems : null,
      ),
    );
  }

  // --- adopt-equivalence ------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (born.rec && late.rec) {
      const e = equivalence(born.rec, late.rec, K, expected.residue, allow);
      problems = e.problems;
      report.equivalence = { frames_compared: e.frames, residue: e.residue, first_problems: e.problems.slice(0, 20) };
      report.resources.exceptions = e.exceptions;
      // The creation exception is exactly the declared window: from the arm until the update.
      const cf = e.exceptions.creation_frames;
      if (cf.length > 0 && (cf[0] !== K || cf.at(-1) !== allow.creation!.until_frame - 1))
        problems.push(`creation-content frames ${cf[0]}..${cf.at(-1)}, expected ${K}..${allow.creation!.until_frame - 1}`);
    }
    checks.push(
      check(
        "adopt-equivalence",
        `at every frame from the arm (${K}) on, the late capture's resolved state equals the born capture's under an id bijection, with Q2's exceptions only (ids, versions, content_version, origin, draw-index values, draw-derived state of items not visible in tree, the ${expected.residue} residue item) and G8r's declared resource exceptions (${expected.exceptions.creation.paths} creation-copy texture from the arm until K+${expected.exceptions.creation.until_offset}, ${expected.exceptions.refused.paths} refused texture); textures compare by payload hash, meshes by surface hashes`,
        problems,
        `${report.equivalence?.frames_compared} frames equal, residue ${report.equivalence?.residue}, creation ${report.resources.exceptions?.creation.join(",")} (frames ${report.resources.exceptions?.creation_frames[0]}..${report.resources.exceptions?.creation_frames.at(-1)}), refused ${report.resources.exceptions?.refused.join(",")}`,
      ),
    );
  }

  // --- adopt-noop-at-birth: GRC_ADOPT=arm on the born layout adopts nothing ------------------
  {
    const ba = await loadRecording(join(root, "born-adopt/capture"));
    const baResult = await readJson<CaptureResult>(join(root, "born-adopt/capture/evidence/result.json"));
    let problems: string[] | null = null;
    if (ba.rec && born.rec) {
      problems = [];
      const st = baResult?.stream?.gate8?.adopt_stats;
      if (!st || st.items !== 0 || st.layers !== 0 || st.ran !== true)
        problems.push(`adopt_stats ${JSON.stringify(st)}`);
      const e = equivalence(born.rec, ba.rec, 1, 0);
      problems.push(...e.problems);
    }
    checks.push(
      check(
        "adopt-noop-at-birth",
        "GRC_ADOPT=arm on a capture armed at birth (the born layout) adopts nothing and publishes exactly the born capture's states from frame 1 on",
        problems,
      ),
    );
  }

  // --- adopt-account ----------------------------------------------------------------------
  {
    const problems: string[] = [];
    const st = lateResult?.stream?.gate8?.adopt_stats;
    problems.push(...censusProblems(st, expected.census).map((p) => `late: ${p}`));
    if (st && st.residue !== expected.residue) problems.push(`late: residue ${st.residue}, expected ${expected.residue}`);
    const ui = lateResult?.stream?.unknown_items;
    if (!ui || ui.unknown_rids_named !== expected.residue || ui.withheld_items !== 0)
      problems.push(`late: unknown_items ${JSON.stringify(ui)}`);
    if (bornResult?.stream?.gate8?.adopt !== "off") problems.push(`born: adopt ${bornResult?.stream?.gate8?.adopt}`);
    // strict: the residue's first post-arm call is the sticky pre-existing-object failure
    const strict = await loadRecording(join(root, "late-strict/capture"));
    const strictResult = await readJson<CaptureResult>(join(root, "late-strict/capture/evidence/result.json"));
    problems.push(...censusProblems(strictResult?.stream?.gate8?.adopt_stats, expected.census).map((p) => `late-strict: ${p}`));
    if (!strict.rec) problems.push(`late-strict: ${strict.error}`);
    else {
      const failAt = K + expected.strict.frame_offset;
      for (const t of strict.rec.transactions) {
        const reasons = t.state.failures.map((f) => f.reason);
        if (t.frame < failAt && reasons.length > 0) problems.push(`late-strict: failure ${reasons} at frame ${t.frame}`);
        if (t.frame >= failAt) {
          const f = t.state.failures.find((x) => x.reason === expected.strict.reason);
          if (!f || !f.detail.includes(`op=${expected.strict.op}`) || !f.detail.includes(`frame=${failAt}`)) {
            problems.push(`late-strict: frame ${t.frame}: failures ${JSON.stringify(t.state.failures)}`);
            break;
          }
        }
      }
    }
    checks.push(
      check(
        "adopt-account",
        `the late capture's adoption counts equal expected.json's census (${expected.census.items} items, ${expected.census.layers} layer, ${expected.census.hidden} hidden, ${expected.census.top_level} canvas-group members re-raised), under skip the residue is exactly ${expected.residue} unknown RID and nothing is withheld; under strict the residue's first post-arm call (frame K+${expected.strict.frame_offset}) is the sticky ${expected.strict.reason} and nothing fails before it`,
        lateResult || strictResult ? problems : null,
      ),
    );
    report.cost = st
      ? Object.fromEntries(
          ["items", "layers", "walk_ns", "apply_ns", "engine_ns", "total_ns", "redraws", "top_level"].map((k) => [k, st[k]]),
        )
      : null;
  }

  // --- adopt-thread-refused: D4 ---------------------------------------------------------------
  {
    const r = await readJson<CaptureResult>(join(root, "late-thread/capture/evidence/result.json"));
    let problems: string[] | null = null;
    if (r) {
      problems = [];
      if (r.stream?.status !== "refused" || !(r.stream.reason ?? "").startsWith("adopt-thread:"))
        problems.push(`stream ${r.stream?.status} (${r.stream?.reason})`);
      const rec = await loadRecording(join(root, "late-thread/capture"));
      if (rec.rec && rec.rec.transactions.length > 0)
        problems.push(`${rec.rec.transactions.length} transactions published`);
    }
    checks.push(
      check(
        "adopt-thread-refused",
        "a capture loaded from a worker thread with GRC_ADOPT=arm refuses its stream with adopt-thread (D4) and publishes no transaction",
        problems,
        r?.stream?.reason ?? undefined,
      ),
    );
  }

  // --- adopt-no-scene-mutation --------------------------------------------------------------
  {
    let problems: string[] | null = null;
    const lp = jsonl<ProbeLine>(await readText(join(root, "late/capture/probe.jsonl")));
    const bp = jsonl<ProbeLine>(await readText(join(root, "born/capture/probe.jsonl")));
    if (lp.length > 0 || bp.length > 0) {
      problems = [];
      const pair = (p: ProbeLine[], name: string) => {
        const a = p.find((x) => x.frame === K - 1);
        const b = p.find((x) => x.frame === K + 1);
        if (!a || !b) {
          problems?.push(`${name}: probe lines at ${K - 1} and ${K + 1} missing`);
          return undefined;
        }
        if (a.nodes !== expected.probe_nodes) problems?.push(`${name}: ${a.nodes} nodes probed, expected ${expected.probe_nodes}`);
        if (a.hash !== b.hash) problems?.push(`${name}: stored properties changed across the arm`);
        return { a, b };
      };
      const l = pair(lp, "late");
      const b = pair(bp, "born");
      if (l && l.b.draws - l.a.draws !== expected.visible_at_arm)
        problems.push(`late: ${l.b.draws - l.a.draws} draw signals across the arm, expected ${expected.visible_at_arm}`);
      if (b && b.b.draws !== b.a.draws) problems.push(`born: ${b.b.draws - b.a.draws} draw signals across K`);
      if (l && b && l.a.hash !== b.a.hash) problems.push("born and late probe different scenes");
    }
    checks.push(
      check(
        "adopt-no-scene-mutation",
        `a fixture probe hashes every node's stored properties at K-1 and K+1: equal across the late arm (and equal to born's); only draw signals move (${expected.visible_at_arm}: one per item visible in tree at arm)`,
        problems,
      ),
    );
  }

  // --- adopt-reference: pixels --------------------------------------------------------------
  // G8r: the late capture may differ from the reference (and from born) only inside the declared
  // regions -- the creation copy's at its steps (where it must differ: the declaration is honest)
  // and the refused texture's -- and nowhere else; born equals the reference exactly.
  const regionRects: Rect[] = [expected.regions.creation.rect, expected.regions.refused.rect];
  {
    let problems: string[] | null = [];
    const pairs: [string, string, boolean][] = [
      ["late/receiver", "reference", true],
      ["late/receiver-patch", "reference", true],
      ["born/receiver", "reference", false],
      ["late/receiver", "born/receiver", true],
    ];
    let any = false;
    for (const [a, b, lateSide] of pairs) {
      if (!ran(a) || !ran(b)) {
        problems?.push(`${a} vs ${b}: a leg did not run`);
        continue;
      }
      any = true;
      const rows = [];
      for (const c of expected.checkpoints) {
        const d = await shotDiff(join(root, a), join(root, b), c.step, lateSide ? regionRects : []);
        rows.push({ step: c.step, differing: d.differing, max_delta: d.max_delta, outside: d.outside });
        if (!d.present) {
          problems?.push(`${a} vs ${b} step ${c.step}: shot missing`);
          continue;
        }
        if (!lateSide) {
          if (d.differing > 0) problems?.push(`${a} vs ${b} step ${c.step}: ${d.differing} px differ (max ${d.max_delta})`);
          continue;
        }
        if (d.outside > 0)
          problems?.push(`${a} vs ${b} step ${c.step}: ${d.outside} px differ outside the declared regions (max ${d.max_delta})`);
        const creationStep = expected.regions.creation.steps.includes(c.step);
        if (!creationStep && d.inside[0] > 0)
          problems?.push(`${a} vs ${b} step ${c.step}: ${d.inside[0]} px differ in the creation region after its update`);
        if (creationStep && d.inside[0] === 0)
          problems?.push(`${a} vs ${b} step ${c.step}: the creation region does not differ (the stale copy is not shown)`);
        if (!expected.regions.refused.steps.includes(c.step) && d.inside[1] > 0)
          problems?.push(`${a} vs ${b} step ${c.step}: ${d.inside[1]} px differ in the refused region`);
      }
      report.pixels[`${a} vs ${b}`] = rows;
    }
    if (!any) problems = null;
    checks.push(
      check(
        "adopt-reference",
        "the native receiver's shots of the born capture equal the rendered reference exactly at every checkpoint; those of the late capture (full and patch sinks) equal the reference, and born's, everywhere but G8r's declared regions: the creation copy's rect at steps 0 and 1 (where it must differ) and the refused placeholder's rect",
        problems,
      ),
    );
  }

  // --- G8r: lazy resource adoption -------------------------------------------------------------
  const R = expected.resources;
  const resourceProblems = (
    stats: Record<string, unknown> | undefined,
    want: Partial<Record<keyof G8rResources, number>>,
  ): string[] => {
    const res = stats?.resources as Record<string, unknown> | undefined;
    if (!res) return ["no stream.gate8.adopt_stats.resources"];
    const out: string[] = [];
    for (const [k, v] of Object.entries(want)) if (res[k] !== v) out.push(`${k} ${res[k]}, expected ${v}`);
    return out;
  };
  const wantResources: Partial<Record<keyof G8rResources, number>> = {
    textures: R.textures,
    textures_current: R.textures_current,
    textures_creation: R.textures_creation,
    atlas_pages: R.atlas_pages,
    compressed: R.compressed,
    from_update: R.from_update,
    decoded: R.decoded,
    textures_refused: R.textures_refused,
    meshes: R.meshes,
    mesh_surfaces: R.mesh_surfaces,
    meshes_refused: R.meshes_refused,
    cached_compressed: R.cached_compressed,
  };
  // --- adopt-resources-account: result.json, the hook log and the wire agree with the census ---
  {
    let problems: string[] | null = null;
    const st = lateResult?.stream?.gate8?.adopt_stats as Record<string, unknown> | undefined;
    report.resources.late = (st?.resources as Record<string, unknown> | undefined) ?? null;
    if (lateResult && late.rec) {
      problems = resourceProblems(st, wantResources).map((p) => `late: ${p}`);
      const res = st?.resources as Record<string, number> | undefined;
      if (res && !(res.fonts >= 1)) problems.push(`late: ${res.fonts} fonts in the census`);
      if (st?.fault !== "none") problems.push(`late: fault ${st?.fault}`);
      // The hook log: one adopt line per adopted texture and mesh, by declared content.
      const lines = jsonl<Record<string, unknown>>(await readText(join(root, "late/capture/evidence/resources.jsonl")));
      const adopt = lines.filter((l) => l.op === "adopt");
      const tex = adopt.filter((l) => l.kind === "image");
      const count = (f: (l: Record<string, unknown>) => boolean) => tex.filter(f).length;
      const want: [string, number, number][] = [
        ["adopt lines (textures)", tex.length, R.textures],
        ["current", count((l) => l.adopted_content === "current"), R.textures_current],
        ["creation", count((l) => l.adopted_content === "creation"), R.textures_creation],
        ["textserver", count((l) => l.adopt_source === "textserver"), R.atlas_pages],
        ["cache", count((l) => l.adopt_source === "cache"), R.compressed],
        ["update", count((l) => l.adopt_source === "update"), R.from_update],
        ["decoded", count((l) => l.source_format === R.source_format), R.decoded],
        ["adopt lines (meshes)", adopt.filter((l) => l.kind === "mesh").length, R.meshes],
      ];
      for (const [what, got, exp] of want) if (got !== exp) problems.push(`hook log: ${what} ${got}, expected ${exp}`);
      // The wire: every adopted entry, at its first appearance.
      const firstTex = new Map<number, { adopted_content: unknown; source_format: unknown }>();
      const firstMesh = new Map<number, unknown>();
      for (const t of late.rec.transactions) {
        for (const e of t.state.textures)
          if (e.origin === "adopted" && !firstTex.has(e.id))
            firstTex.set(e.id, { adopted_content: e.adopted_content, source_format: e.source_format ?? null });
        for (const m of t.state.meshes ?? [])
          if (m.origin === "adopted" && !firstMesh.has(m.id)) firstMesh.set(m.id, m.adopted_content);
      }
      const wire = [...firstTex.values()];
      if (wire.length !== R.textures) problems.push(`wire: ${wire.length} adopted textures, expected ${R.textures}`);
      const cur = wire.filter((w) => w.adopted_content === "current").length;
      if (cur !== R.textures_current) problems.push(`wire: ${cur} adopted current, expected ${R.textures_current}`);
      const dec = wire.filter((w) => w.source_format === R.source_format).length;
      if (dec !== R.decoded) problems.push(`wire: ${dec} adopted with source_format ${R.source_format}, expected ${R.decoded}`);
      if (firstMesh.size !== R.meshes || [...firstMesh.values()].some((c) => c !== "creation"))
        problems.push(`wire: adopted meshes ${JSON.stringify([...firstMesh.values()])}, expected ${R.meshes} creation`);
      if (born.rec)
        for (const t of born.rec.transactions)
          if (t.state.textures.some((e) => e.origin === "adopted") || (t.state.meshes ?? []).some((m) => m.origin === "adopted"))
            problems.push(`born: an adopted resource at frame ${t.frame}`);
      // After the post-arm update the stale texture's entry is current (version raised).
      const lastT = late.rec.transactions.at(-1);
      const creationLeft = lastT?.state.textures.filter((e) => e.adopted_content === "creation").length ?? -1;
      if (creationLeft !== R.textures_creation - 1)
        problems.push(`wire: ${creationLeft} creation entries at the end, expected ${R.textures_creation - 1} (the updated one is current)`);
    }
    checks.push(
      check(
        "adopt-resources-account",
        `G8r (D6, D7): the late capture adopts exactly expected.json's resources -- ${R.textures} textures (${R.textures_current} current: ${R.atlas_pages} atlas page read back from the TextServer, ${R.compressed} CompressedTexture2Ds from the resource cache, ${R.from_update} first met as an update; ${R.textures_creation} creation), ${R.decoded} host-decoded from ${R.source_format}, ${R.textures_refused} refused, ${R.meshes} mesh (creation) -- in result.json, in the hook log's adopt lines and on the wire; born adopts nothing; the stale texture is current after its post-arm update`,
        problems,
        report.resources.late ? JSON.stringify(report.resources.late) : undefined,
      ),
    );
  }

  // --- adopt-resources-workers: G8kw's path ----------------------------------------------------
  {
    let problems: string[] | null = null;
    const w = await loadRecording(join(root, "late-workers/capture"));
    const wr = await readJson<CaptureResult & { stream?: { texture_workers?: Record<string, number> } }>(
      join(root, "late-workers/capture/evidence/result.json"),
    );
    if (w.rec && late.rec) {
      const cmp = compareWorkerRecordings(late.rec, w.rec);
      problems = [...cmp.problems];
      report.resources.workers = {
        sync_transactions: cmp.sync_transactions,
        async_transactions: cmp.async_transactions,
        held_frames: cmp.held_frames.length,
      };
      if (cmp.held_frames.length === 0) problems.push("no frame was held back: the adopted copies never waited on a worker");
      problems.push(...resourceProblems(wr?.stream?.gate8?.adopt_stats, wantResources).map((p) => `late-workers: ${p}`));
      const lines = jsonl<Record<string, unknown>>(await readText(join(root, "late-workers/capture/evidence/resources.jsonl")));
      const workerAdopts = lines.filter((l) => l.op === "adopt" && l.kind === "image" && l.worker === true).length;
      if (workerAdopts === 0) problems.push("no adopt line was a worker copy");
    } else if (w.error) problems = [w.error];
    checks.push(
      check(
        "adopt-resources-workers",
        "G8r through G8kw: the late capture at GRC_TEXTURE_WORKERS=2 (every copy on a delayed worker) adopts the same resources, its adopted copies are worker copies, publication is held back, and every transaction equals the synchronous late capture's at the same frame",
        problems,
        report.resources.workers ? JSON.stringify(report.resources.workers) : undefined,
      ),
    );
  }

  // --- G8r faults (GRC_ADOPT_FAULT) -----------------------------------------------------------
  for (const f of FAULTS) {
    const dir = join(root, `fault-${f}`);
    let problems: string[] | null = null;
    const cap = await loadRecording(join(dir, "capture"));
    const rendered = (FAULTS_RENDERED as readonly string[]).includes(f);
    if (cap.rec && born.rec && (!rendered || (ran(`fault-${f}/receiver`) && ran("reference")))) {
      problems = [];
      const e = equivalence(born.rec, cap.rec, K, expected.residue, allow);
      let outside = 0;
      if (rendered)
        for (const c of expected.checkpoints)
          outside += (await shotDiff(join(dir, "receiver"), join(root, "reference"), c.step, regionRects)).outside;
      report.sabotages[`fault-${f}`] = { equivalence_problems: e.problems.length, differing_px: outside };
      if (e.problems.length === 0) problems.push("adopt-equivalence did not fail");
      if (rendered && outside === 0) problems.push("adopt-reference did not fail (no pixel outside the declared regions)");
      const r = await readJson<CaptureResult>(join(dir, "capture/evidence/result.json"));
      const st = r?.stream?.gate8?.adopt_stats as Record<string, unknown> | undefined;
      if (st?.fault !== f) problems.push(`its result.json names fault ${st?.fault}`);
      if (resourceProblems(st, wantResources).length === 0) {
        if (f !== "atlas-from-dummy") problems.push("adopt-resources-account would not fail");
      }
      if (f === "atlas-from-dummy") {
        // The same account (the page is found), but its bytes are the dummy's stale copy.
        const lines = jsonl<Record<string, unknown>>(await readText(join(dir, "capture/evidence/resources.jsonl")));
        if (lines.some((l) => l.op === "adopt" && l.adopt_source === "textserver"))
          problems.push("an atlas page was still read from the TextServer");
      }
    }
    checks.push(
      check(
        `fault-${f}`,
        `G8r's GRC_ADOPT_FAULT=${f} (${f === "no-resources" ? "no lazy adoption: G8a's unknown-texture/unknown-mesh come back" : f === "atlas-from-dummy" ? "atlas pages read from the dummy's stale copy, still declared current" : "every adopted texture declared current"}) fails adopt-equivalence against born${rendered ? " and its receiver fails adopt-reference outside the declared regions" : ""}${f !== "atlas-from-dummy" ? "; its account fails adopt-resources-account" : ""}`,
        problems,
        report.sabotages[`fault-${f}`]
          ? `${report.sabotages[`fault-${f}`].equivalence_problems} state problems${rendered ? `, ${report.sabotages[`fault-${f}`].differing_px} px outside the declared regions` : " (not rendered: its pixels are late's)"}`
          : undefined,
      ),
    );
  }

  // --- sabotages ------------------------------------------------------------------------------
  for (const s of SABOTAGES) {
    const dir = join(root, `sabotage-${s}`);
    let problems: string[] | null = null;
    const cap = await loadRecording(join(dir, "capture"));
    if (cap.rec && born.rec && ran(`sabotage-${s}/receiver`) && ran("reference")) {
      problems = [];
      const e = equivalence(born.rec, cap.rec, K, expected.residue, allow);
      let differing = 0;
      for (const c of expected.checkpoints)
        differing += (await shotDiff(join(dir, "receiver"), join(root, "reference"), c.step, regionRects)).outside;
      report.sabotages[s] = { equivalence_problems: e.problems.length, differing_px: differing };
      if (e.problems.length === 0) problems.push("adopt-equivalence did not fail");
      if (differing === 0) problems.push("adopt-reference did not fail");
      if (s === "adopt-skip-layers") {
        const r = await readJson<CaptureResult>(join(dir, "capture/evidence/result.json"));
        const st = r?.stream?.gate8?.adopt_stats;
        const cp = censusProblems(st, expected.census, s);
        if (cp.length > 0) problems.push(`its account is not the skip-layers one: ${cp.join(", ")}`);
        if (censusProblems(st, expected.census).length === 0) problems.push("the account did not change");
        const ui = r?.stream?.unknown_items;
        if (!ui || ui.unknown_rids_named <= expected.residue) problems.push(`unknown_items ${JSON.stringify(ui)}`);
      }
    }
    checks.push(
      check(
        `sabotage-${s}`,
        `the ${s} capture fails adopt-equivalence against born and its receiver fails adopt-reference${s === "adopt-skip-layers" ? "; its account changes (no layer adopted, the layer canvas an extra unknown RID)" : ""}`,
        problems,
        report.sabotages[s] ? `${report.sabotages[s].equivalence_problems} state problems, ${report.sabotages[s].differing_px} px` : undefined,
      ),
    );
  }

  return { checks, report };
}
