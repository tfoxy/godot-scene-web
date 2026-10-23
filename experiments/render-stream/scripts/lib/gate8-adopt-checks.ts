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
// the born capture also saw the engine's frame-1 default-theme texture).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
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
}

export interface G8aReport {
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  cost: Record<string, unknown> | null;
  equivalence: { frames_compared: number; residue: number; first_problems: string[] } | null;
  pixels: Record<string, { step: number; differing: number; max_delta: number }[]>;
  sabotages: Record<string, { equivalence_problems: number; differing_px: number }>;
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

export function canonicalState(state: State): CanonCanvas[] {
  const items = new Map<number, ResolvedItem>();
  for (const it of state.items) items.set(it.id, it);
  const texHash = new Map<number, string>();
  for (const t of state.textures) texHash.set(t.id, t.hash ?? `${t.kind}:${t.status}`);
  const canonCommands = (it: ResolvedItem) =>
    it.commands.map((c) => {
      const out: Record<string, unknown> = { ...c };
      if (typeof c.tex === "number") out.tex = texHash.get(c.tex) ?? `missing:${c.tex}`;
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
        material: it.material ?? null,
        use_parent_material: it.use_parent_material ?? false,
        instance_params: it.instance_params ?? [],
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

/** Compares a late capture's canonical state with the born one's under Q2's exceptions. Returns
 * the problems and the residue count (born-only trailing items with no commands or children). */
export function compareStates(
  born: CanonCanvas[],
  late: CanonCanvas[],
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
        for (const k of Object.keys(x.draw))
          if (!eq(x.draw[k], y.draw[k]))
            problems.push(
              `${x.path}: ${k} ${JSON.stringify(x.draw[k]).slice(0, 120)} vs ${JSON.stringify(y.draw[k]).slice(0, 120)}`,
            );
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

/** Equivalence over every frame from `fromFrame` to the last frame both recordings cover. */
export function equivalence(
  born: ResolvedRecording,
  late: ResolvedRecording,
  fromFrame: number,
  expectedResidue: number,
): { problems: string[]; frames: number; residue: number } {
  const problems: string[] = [];
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
    const r = compareStates(canonicalState(b.state), canonicalState(l.state));
    residueMax = Math.max(residueMax, r.residue);
    if (r.residue !== expectedResidue)
      problems.push(`frame ${f}: residue ${r.residue}, expected ${expectedResidue}`);
    for (const p of r.problems) problems.push(`frame ${f}: ${p}`);
    if (!eq(unsupportedKeys(b.state), unsupportedKeys(l.state)))
      problems.push(
        `frame ${f}: unsupported ${unsupportedKeys(b.state).join(",")} vs ${unsupportedKeys(l.state).join(",")}`,
      );
    if (!eq(failureKeys(b.state), failureKeys(l.state)))
      problems.push(`frame ${f}: failures ${failureKeys(b.state)} vs ${failureKeys(l.state)}`);
  }
  if (frames === 0) problems.push("no frame compared");
  return { problems, frames, residue: residueMax };
}

// ------------------------------------------------------------------------------- evidence

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const t = await readText(path);
  if (t === undefined) return undefined;
  try {
    return JSON.parse(t) as T;
  } catch {
    return undefined;
  }
}

function jsonl<T>(text: string | undefined): T[] {
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

async function exitCode(dir: string): Promise<string | null> {
  const t = await readText(join(dir, "exit-code.txt"));
  return t === undefined ? null : t.trim();
}

function skipped(dir: string): string | null {
  if (existsSync(join(dir, "skipped-by-tier.txt"))) return "skipped-by-tier";
  if (existsSync(join(dir, "skipped-remote.txt"))) return "skipped-remote";
  return null;
}

async function loadRecording(dir: string): Promise<{ bytes?: Uint8Array; rec?: ResolvedRecording; error?: string }> {
  const path = join(dir, "recording.rs8");
  if (!existsSync(path)) return { error: `${path} missing` };
  const bytes = new Uint8Array(await readFile(path));
  if (wireVersionOf(bytes) !== 8) return { bytes, error: `${path} is not GRS8` };
  try {
    return { bytes, rec: resolveRecording(bytes, 8) };
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

export async function shotDiff(
  a: string,
  b: string,
  step: number,
): Promise<{ step: number; present: boolean; differing: number; max_delta: number }> {
  const ia = existsSync(await shotPath(a, step)) ? await decodePngRgba(await shotPath(a, step)) : undefined;
  const ib = existsSync(await shotPath(b, step)) ? await decodePngRgba(await shotPath(b, step)) : undefined;
  const out = { step, present: false, differing: 0, max_delta: 0 };
  if (!ia || !ib || ia.width !== ib.width || ia.height !== ib.height) return out;
  out.present = true;
  for (let i = 0; i < ia.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(ia.data[i + c] - ib.data[i + c]));
    if (d > 0) {
      out.differing++;
      out.max_delta = Math.max(out.max_delta, d);
    }
  }
  return out;
}

function check(
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
    ...SABOTAGES.map((s) => `sabotage-${s}/capture`),
    "reference",
    "born/receiver",
    "late/receiver",
    "late/receiver-patch",
    ...SABOTAGES.map((s) => `sabotage-${s}/receiver`),
  ];
  const legs: G8aReport["legs"] = {};
  for (const l of legDirs)
    legs[l] = { exit_code: await exitCode(join(root, l)), skipped: skipped(join(root, l)) };
  const ran = (l: string) => legs[l].exit_code !== null && legs[l].skipped === null;
  const K = expected.arm_frame;
  const report: G8aReport = { legs, cost: null, equivalence: null, pixels: {}, sabotages: {} };

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
      const e = equivalence(born.rec, late.rec, K, expected.residue);
      problems = e.problems;
      report.equivalence = { frames_compared: e.frames, residue: e.residue, first_problems: e.problems.slice(0, 20) };
    }
    checks.push(
      check(
        "adopt-equivalence",
        `at every frame from the arm (${K}) on, the late capture's resolved state equals the born capture's under an id bijection, with Q2's exceptions only (ids, versions, content_version, origin, draw-index values, draw-derived state of items not visible in tree, the ${expected.residue} residue item)`,
        problems,
        `${report.equivalence?.frames_compared} frames equal, residue ${report.equivalence?.residue}`,
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
  {
    let problems: string[] | null = [];
    const pairs: [string, string][] = [
      ["late/receiver", "reference"],
      ["late/receiver-patch", "reference"],
      ["born/receiver", "reference"],
      ["late/receiver", "born/receiver"],
    ];
    let any = false;
    for (const [a, b] of pairs) {
      if (!ran(a) || !ran(b)) {
        problems?.push(`${a} vs ${b}: a leg did not run`);
        continue;
      }
      any = true;
      const rows = [];
      for (const c of expected.checkpoints) {
        const d = await shotDiff(join(root, a), join(root, b), c.step);
        rows.push({ step: c.step, differing: d.differing, max_delta: d.max_delta });
        if (!d.present) problems?.push(`${a} vs ${b} step ${c.step}: shot missing`);
        else if (d.differing > 0)
          problems?.push(`${a} vs ${b} step ${c.step}: ${d.differing} px differ (max ${d.max_delta})`);
      }
      report.pixels[`${a} vs ${b}`] = rows;
    }
    if (!any) problems = null;
    checks.push(
      check(
        "adopt-reference",
        "the native receiver's shots of the late capture (full and patch sinks) and of the born capture equal the rendered reference exactly at every checkpoint (the arm and the three post-arm steps), and late equals born",
        problems,
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
      const e = equivalence(born.rec, cap.rec, K, expected.residue);
      let differing = 0;
      for (const c of expected.checkpoints)
        differing += (await shotDiff(join(dir, "receiver"), join(root, "reference"), c.step)).differing;
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
