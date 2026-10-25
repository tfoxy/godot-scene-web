// Gate 8 g8cg checks (CG1, protocol/render-stream-10.md): clip_children, CanvasGroup and
// BackBufferCopy carried as the /10 item keys `canvas_group` and `copy_to_backbuffer`, judged on
// fixtures/gate8-cg. The pure helpers (wireStateProblems, toggleProblems, sessionProblems,
// itemKeyProblems, hookCountProblems, cellProblems, modelProblems, exactProblems) are exported so
// scripts/test/self-test-gate8-cg.ts can drive them on synthetic input.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import {
  check,
  exitCode,
  type G8aCheck,
  type Rect,
  readJson,
  readText,
  skipped,
  stateAt,
} from "./gate8-adopt-checks";
import {
  decodeRecording,
  type ResolvedRecording,
  resolveRecording,
  wireVersionOf,
} from "./render-stream-2";

export type CgUse = "canvas_group" | "copy_viewport" | "copy_rect";

export interface CgCell {
  /** inclusive [x0, y0, x1, y1] */
  region: Rect;
  uses: CgUse[];
  /** the checkpoints at which the cell's pixels depend on its uses */
  steps: number[];
}

export interface CgWireEntry {
  state: Record<string, unknown>;
  commands: boolean;
  count: number;
  from_step: number;
  why?: string;
}

export interface G8cgExpected {
  schema: "render-stream-gate8-cg-expected/1";
  doc: string;
  checkpoints: { step: number; applied: number; settle: number }[];
  arm_frame: number;
  late_steps: number[];
  toggle: { step: number; frame: number; mode: string };
  cells: Record<string, CgCell>;
  removes: Record<string, CgUse[]>;
  wire: { canvas_group: CgWireEntry[]; copy_to_backbuffer: CgWireEntry[] };
  hooks: {
    canvas_group_mode: string;
    copy_to_backbuffer: string;
    canvas_group_mode_calls: number;
    copy_to_backbuffer_calls: number;
    teardown_slack: number;
  };
  model: {
    invert: {
      cell: string;
      origin: [number, number];
      size: [number, number];
      seed: number;
    }[];
    solid: { cell: string; rect: Rect; rgb: [number, number, number] }[];
    pattern: {
      cell: string;
      origin: [number, number];
      size: [number, number];
      seed: number;
    }[];
    clipped_rows: {
      cell: string;
      x: [number, number];
      inside_y: number;
      outside_y: number[];
    };
  };
  clear_color: [number, number, number];
}

export interface G8cgReport {
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  wire: Record<
    string,
    { step: number; canvas_group: number; copy_to_backbuffer: number }[]
  >;
  pixels: Record<
    string,
    { step: number; cells: Record<string, number>; outside: number }[]
  >;
}

// ------------------------------------------------------------------------------------ the wire

/** The /10 keys of an item as resolved (render-stream-10.md "Decoded and resolved forms"). */
export interface CgItem {
  id: number;
  canvas_group?: Record<string, unknown> | null;
  copy_to_backbuffer?: { rect: number[] } | null;
  commands: unknown[] | null;
}

const GROUP_KEYS = [
  "mode",
  "clear_margin",
  "fit_empty",
  "fit_margin",
  "blur_mipmaps",
];

function stateKey(
  state: Record<string, unknown>,
  keys: string[] | null,
  commands: boolean,
): string {
  const ordered =
    keys === null ? state : Object.fromEntries(keys.map((k) => [k, state[k]]));
  return `${JSON.stringify(ordered)} commands=${commands}`;
}

function multiset(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

function multisetProblems(
  label: string,
  got: Map<string, number>,
  want: Map<string, number>,
): string[] {
  const problems: string[] = [];
  for (const k of new Set([...got.keys(), ...want.keys()])) {
    const g = got.get(k) ?? 0;
    const w = want.get(k) ?? 0;
    if (g !== w) problems.push(`${label} ${k}: ${g} items, expected ${w}`);
  }
  return problems;
}

/** cg-wire / cg-adopt at one checkpoint: the items' non-null `canvas_group` and
 * `copy_to_backbuffer` states (with whether each item has commands) are exactly expected.json's
 * multisets for that step; every item carries both keys (null elsewhere). */
export function wireStateProblems(
  items: CgItem[],
  expected: Pick<G8cgExpected, "wire">,
  step: number,
): { problems: string[]; groups: number; copies: number } {
  const problems: string[] = [];
  const groups: string[] = [];
  const copies: string[] = [];
  for (const it of items) {
    if (!("canvas_group" in it) || !("copy_to_backbuffer" in it)) {
      problems.push(`item ${it.id} lacks a /10 key`);
      continue;
    }
    const commands = (it.commands ?? []).length > 0;
    if (it.canvas_group != null)
      groups.push(stateKey(it.canvas_group, GROUP_KEYS, commands));
    if (it.copy_to_backbuffer != null)
      copies.push(
        stateKey({ rect: it.copy_to_backbuffer.rect }, ["rect"], commands),
      );
  }
  const want = (entries: CgWireEntry[], keys: string[]) => {
    const m = new Map<string, number>();
    for (const e of entries) {
      if (e.from_step > step) continue;
      const k = stateKey(e.state, keys, e.commands);
      m.set(k, (m.get(k) ?? 0) + e.count);
    }
    return m;
  };
  problems.push(
    ...multisetProblems(
      "canvas_group",
      multiset(groups),
      want(expected.wire.canvas_group, GROUP_KEYS),
    ),
    ...multisetProblems(
      "copy_to_backbuffer",
      multiset(copies),
      want(expected.wire.copy_to_backbuffer, ["rect"]),
    ),
  );
  return { problems, groups: groups.length, copies: copies.length };
}

/** A decoded transaction's items, as the patch sink carries them (commands null: unchanged). */
export interface PatchTransaction {
  frame: number;
  items: {
    id: number;
    canvas_group?: { mode: string } | null;
    commands: unknown[] | null;
  }[];
}

/** cg-toggle-patch: on the patch sink, the transactions after the previous checkpoint's settle
 * frame up to the toggle's settle carry exactly one item entry, at the toggle frame: its
 * `canvas_group` is the toggled mode and its `commands` null (state, not content). */
export function toggleProblems(
  txs: PatchTransaction[],
  expected: Pick<G8cgExpected, "toggle" | "checkpoints">,
): string[] {
  const k = expected.checkpoints.findIndex(
    (c) => c.step === expected.toggle.step,
  );
  if (k <= 0) return ["no checkpoint before the toggle"];
  const from = expected.checkpoints[k - 1].settle;
  const to = expected.checkpoints[k].settle;
  const entries = txs
    .filter((t) => t.frame > from && t.frame <= to)
    .flatMap((t) => t.items.map((it) => ({ frame: t.frame, it })));
  if (entries.length !== 1)
    return [
      `${entries.length} item entries between frames ${from} and ${to}, expected 1 (${entries
        .slice(0, 6)
        .map((e) => `frame ${e.frame} item ${e.it.id}`)
        .join(", ")})`,
    ];
  const [{ frame, it }] = entries;
  const problems: string[] = [];
  if (frame !== expected.toggle.frame)
    problems.push(
      `the entry is at frame ${frame}, expected ${expected.toggle.frame}`,
    );
  if (it.canvas_group?.mode !== expected.toggle.mode)
    problems.push(
      `item ${it.id} canvas_group ${JSON.stringify(it.canvas_group)}, expected mode ${expected.toggle.mode}`,
    );
  if (it.commands !== null)
    problems.push(
      `item ${it.id} carries commands (${it.commands.length}), expected null`,
    );
  return problems;
}

export interface CgSession {
  protocol?: string;
  capture?: { hooks_planned?: string[]; hooks_omitted?: string[] };
  features?: { unobserved?: string[] };
}

/** cg-hooks (version 10) / cg-below-10 (9): render-stream-10.md "Features" and "Capture": a /10
 * session plans both hooks and drops both methods from features.unobserved; a /9 session neither
 * plans nor omits them and keeps both unobserved. */
export function sessionProblems(
  session: CgSession | undefined,
  version: 9 | 10,
  methods: string[],
): string[] {
  if (!session) return ["no session record"];
  const problems: string[] = [];
  const planned = session.capture?.hooks_planned ?? [];
  const omitted = session.capture?.hooks_omitted ?? [];
  const unobserved = session.features?.unobserved ?? [];
  const want = `render-stream/${version}`;
  if (session.protocol !== want)
    problems.push(`protocol ${session.protocol}, expected ${want}`);
  for (const m of methods) {
    if (version === 10) {
      if (!planned.includes(m))
        problems.push(`${m} not in capture.hooks_planned`);
      if (unobserved.includes(m))
        problems.push(`${m} still in features.unobserved`);
    } else {
      if (planned.includes(m))
        problems.push(`${m} in capture.hooks_planned below /10`);
      if (omitted.includes(m))
        problems.push(`${m} in capture.hooks_omitted below /10`);
      if (!unobserved.includes(m))
        problems.push(`${m} missing from features.unobserved below /10`);
    }
  }
  return problems;
}

/** cg-below-10: no item entry of a /9 stream carries either /10 key. */
export function itemKeyProblems(
  txs: { frame: number; items: object[] }[],
): string[] {
  const problems: string[] = [];
  for (const t of txs)
    for (const it of t.items)
      if ("canvas_group" in it || "copy_to_backbuffer" in it)
        problems.push(`frame ${t.frame}: an item carries a /10 key below /10`);
  return [...new Set(problems)].slice(0, 10);
}

/** cg-hooks: counters.json counts every armed call of both methods (teardown may add up to
 * `teardown_slack` disabling calls, one per CanvasGroup destructor) and captured none invalid. */
export function hookCountProblems(
  counters:
    | { counts?: Record<string, number>; captured?: Record<string, number> }
    | undefined,
  hooks: G8cgExpected["hooks"],
): string[] {
  if (!counters) return ["no counters.json"];
  const problems: string[] = [];
  const rows: [string, number, number][] = [
    [
      hooks.canvas_group_mode,
      hooks.canvas_group_mode_calls,
      hooks.teardown_slack,
    ],
    [hooks.copy_to_backbuffer, hooks.copy_to_backbuffer_calls, 0],
  ];
  for (const [m, n, slack] of rows) {
    const got = counters.counts?.[m];
    if (got === undefined) problems.push(`counts.${m} missing`);
    else if (got < n || got > n + slack)
      problems.push(
        `counts.${m} = ${got}, expected ${slack > 0 ? `${n}..${n + slack}` : n}`,
      );
  }
  const invalid = counters.captured?.canvas_group_mode_invalid ?? 0;
  if (invalid !== 0)
    problems.push(`captured.canvas_group_mode_invalid = ${invalid}`);
  return problems;
}

// ---------------------------------------------------------------------------------- the pixels

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

function differs(a: Rgba, b: Rgba, x: number, y: number): boolean {
  const i = (y * a.width + x) * 4;
  for (let c = 0; c < 4; c++) if (a.data[i + c] !== b.data[i + c]) return true;
  return false;
}

/** Differing pixels per cell (inclusive regions) and outside every cell. */
export function cellDiff(
  a: Rgba,
  b: Rgba,
  cells: Record<string, CgCell>,
): { cells: Record<string, number>; outside: number } | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const out: Record<string, number> = Object.fromEntries(
    Object.keys(cells).map((c) => [c, 0]),
  );
  let outside = 0;
  const entries = Object.entries(cells);
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      if (!differs(a, b, x, y)) continue;
      const hit = entries.find(
        ([, c]) =>
          x >= c.region[0] &&
          x <= c.region[2] &&
          y >= c.region[1] &&
          y <= c.region[3],
      );
      if (hit) out[hit[0]]++;
      else outside++;
    }
  return { cells: out, outside };
}

/** cg-native-exact / cg-adopt / cg-reference-repeat: a leg equals the reference everywhere. */
export function exactProblems(d: {
  cells: Record<string, number>;
  outside: number;
}): string[] {
  const n = Object.values(d.cells).reduce((s, v) => s + v, 0) + d.outside;
  if (n === 0) return [];
  const where = Object.entries(d.cells)
    .filter(([, v]) => v > 0)
    .map(([c, v]) => `${c} ${v}`);
  if (d.outside > 0) where.push(`outside ${d.outside}`);
  return [`${n} px differ (${where.join(", ")})`];
}

/** cg-negative-control / cg-sabotage-*: a leg that loses `removed` must differ from the reference
 * in every cell using one of them at that step, and equal it everywhere else. */
export function cellProblems(
  d: { cells: Record<string, number>; outside: number },
  cells: Record<string, CgCell>,
  removed: CgUse[],
  step: number,
): string[] {
  const problems: string[] = [];
  for (const [name, c] of Object.entries(cells)) {
    const affected =
      c.steps.includes(step) && c.uses.some((u) => removed.includes(u));
    const n = d.cells[name] ?? 0;
    if (affected && n === 0)
      problems.push(`${name} equals the reference (expected a difference)`);
    if (!affected && n > 0)
      problems.push(`${name}: ${n} px differ (expected equal)`);
  }
  if (d.outside > 0) problems.push(`${d.outside} px differ outside every cell`);
  return problems;
}

/** gate8-ct's (and cg.gd's) 16x16 pattern: 4x4-texel blocks, distinct per seed. */
export function patternRgb(
  seed: number,
  tx: number,
  ty: number,
): [number, number, number] {
  const i = Math.floor(tx / 4);
  const j = Math.floor(ty / 4);
  return [
    10 + ((20 + 11 * seed + 40 * i) % 230),
    10 + ((60 + 17 * seed + 45 * j) % 230),
    10 + ((200 + 23 * seed + 35 * (i + j)) % 230),
  ];
}

function rgbAt(img: Rgba, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** cg-reference-model: the reference's screen-reading cells match their closed forms (the
 * inverted 16x16 pattern at scale 4, the inverted clear colour outside BBR's rect), PLAIN is its
 * pattern, and the HP bar's fills show only on the mask's rows. */
export function modelProblems(
  img: Rgba,
  model: G8cgExpected["model"],
): string[] {
  const problems: string[] = [];
  const same = (a: number[], b: number[]) =>
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  for (const [kind, rows] of [
    ["invert", model.invert],
    ["pattern", model.pattern],
  ] as const) {
    for (const r of rows) {
      let bad = 0;
      for (let y = 0; y < r.size[1]; y++)
        for (let x = 0; x < r.size[0]; x++) {
          const p = patternRgb(r.seed, Math.floor(x / 4), Math.floor(y / 4));
          const want = kind === "invert" ? p.map((v) => 255 - v) : p;
          if (!same(rgbAt(img, r.origin[0] + x, r.origin[1] + y), want)) bad++;
        }
      if (bad > 0)
        problems.push(
          `${r.cell} ${kind} seed ${r.seed}: ${bad} px off the model`,
        );
    }
  }
  for (const s of model.solid) {
    let bad = 0;
    for (let y = s.rect[1]; y <= s.rect[3]; y++)
      for (let x = s.rect[0]; x <= s.rect[2]; x++)
        if (!same(rgbAt(img, x, y), s.rgb)) bad++;
    if (bad > 0)
      problems.push(`${s.cell} solid ${JSON.stringify(s.rgb)}: ${bad} px off`);
  }
  {
    const c = model.clipped_rows;
    let bad = 0;
    for (let x = c.x[0]; x <= c.x[1]; x++) {
      const fill = rgbAt(img, x, c.inside_y);
      for (const y of c.outside_y) if (same(rgbAt(img, x, y), fill)) bad++;
    }
    if (bad > 0)
      problems.push(
        `${c.cell}: ${bad} px outside the mask's rows carry the fill's colour (unclipped)`,
      );
  }
  return problems;
}

// ------------------------------------------------------------------------------------- the run

const SABOTAGE_CHECKS: Record<string, string> = {
  "sabotage-drop-canvas-group/receiver": "cg-sabotage-drop-group",
  "sabotage-full-backbuffer-copy/receiver": "cg-sabotage-full-copy",
};

async function loadAt(
  dir: string,
  name: string,
  version: 9 | 10,
): Promise<{
  rec?: ResolvedRecording;
  decoded?: ReturnType<typeof decodeRecording>;
  error?: string;
}> {
  const path = join(dir, name);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    return { error: `${path} missing` };
  }
  if (wireVersionOf(bytes) !== version)
    return { error: `${path} is not /${version}` };
  try {
    return {
      decoded: decodeRecording(bytes, version),
      rec: resolveRecording(bytes, version),
    };
  } catch (e) {
    return { error: `${path}: ${(e as Error).message}` };
  }
}

type Decoded = ReturnType<typeof decodeRecording>;

function sessionOf(d: Decoded | undefined): CgSession | undefined {
  const m = d?.records[0]?.meta as { type?: string } | undefined;
  return m?.type === "session" ? (m as CgSession) : undefined;
}

function transactionsOf(d: Decoded | undefined): PatchTransaction[] {
  const out: PatchTransaction[] = [];
  for (const r of d?.records ?? []) {
    const m = r.meta as {
      type?: string;
      frame?: number;
      items?: PatchTransaction["items"];
    };
    if (m.type === "transaction")
      out.push({ frame: m.frame ?? -1, items: m.items ?? [] });
  }
  return out;
}

export async function runG8cg(
  out: string,
  expected: G8cgExpected,
): Promise<{ checks: G8aCheck[]; report: G8cgReport }> {
  const root = join(out, "g8cg");
  const checks: G8aCheck[] = [];
  const nativeReceivers = ["receiver", "receiver-patch"];
  const compared = ["receiver-v9", ...Object.keys(SABOTAGE_CHECKS)];
  const legDirs = [
    "import/fixture",
    "import/receiver",
    "capture",
    "capture-v9",
    "late/capture",
    "reference",
    "reference-repeat",
    ...nativeReceivers,
    "late/receiver",
    ...compared,
  ];
  const legs: G8cgReport["legs"] = {};
  for (const l of legDirs)
    legs[l] = {
      exit_code: await exitCode(join(root, l)),
      skipped: skipped(join(root, l)),
    };
  const ran = (l: string) =>
    legs[l].exit_code !== null && legs[l].skipped === null;
  const report: G8cgReport = { legs, wire: {}, pixels: {} };
  const methods = [
    expected.hooks.canvas_group_mode,
    expected.hooks.copy_to_backbuffer,
  ];
  const allSteps = expected.checkpoints.map((c) => c.step);
  const settleOf = (step: number) =>
    expected.checkpoints.find((c) => c.step === step)?.settle ?? -1;

  {
    const problems: string[] = [];
    for (const l of legDirs) {
      if (legs[l].skipped !== null) continue;
      if (legs[l].exit_code !== "0")
        problems.push(`${l} exit ${legs[l].exit_code}`);
    }
    checks.push(
      check(
        "g8cg-legs",
        "every g8cg leg that ran (the imports, the /10, /9 and late captures, both references, the native receivers on the /10 full and patch sinks, the /9 and late captures, and both receiver sabotages) exits 0",
        problems,
        `${legDirs.filter(ran).length} legs`,
      ),
    );
  }

  const cap = await loadAt(join(root, "capture"), "recording.rs10", 10);
  const capPatch = await loadAt(
    join(root, "capture"),
    "recording-patch.rs10",
    10,
  );
  const capV9 = await loadAt(join(root, "capture-v9"), "recording.rs9", 9);
  const late = await loadAt(join(root, "late/capture"), "recording.rs10", 10);

  // --- cg-hooks -------------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("capture")) {
      problems = cap.decoded
        ? sessionProblems(sessionOf(cap.decoded), 10, methods)
        : [cap.error ?? "no recording"];
      problems.push(
        ...hookCountProblems(
          await readJson<{
            counts?: Record<string, number>;
            captured?: Record<string, number>;
          }>(join(root, "capture", "evidence", "counters.json")),
          expected.hooks,
        ),
      );
    }
    checks.push(
      check(
        "cg-hooks",
        `the /10 capture plans both hooks (${methods.join(", ")}), drops both from features.unobserved, and its counters count every armed call (${expected.hooks.canvas_group_mode_calls} and ${expected.hooks.copy_to_backbuffer_calls}, up to ${expected.hooks.teardown_slack} more disabling calls at teardown) with none invalid`,
        problems,
      ),
    );
  }

  // --- cg-below-10 ----------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("capture-v9")) {
      problems = capV9.decoded
        ? [
            ...sessionProblems(sessionOf(capV9.decoded), 9, methods),
            ...itemKeyProblems(transactionsOf(capV9.decoded)),
          ]
        : [capV9.error ?? "no recording"];
      const counters = await readJson<{
        hooks_planned?: string[];
        counts?: Record<string, number>;
      }>(join(root, "capture-v9", "evidence", "counters.json"));
      for (const m of methods)
        if ((counters?.hooks_planned ?? []).includes(m))
          problems.push(`counters.json hooks_planned lists ${m} below /10`);
    }
    checks.push(
      check(
        "cg-below-10",
        "a /9 capture of the same scene is the pre-/10 session (render-stream-10.md: the two hooks are not installed): neither method is planned or omitted, both stay in features.unobserved, and no item carries a /10 key",
        problems,
      ),
    );
  }

  // --- cg-wire --------------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("capture")) {
      problems = [];
      for (const [label, r] of [
        ["full", cap],
        ["patch", capPatch],
      ] as const) {
        if (!r.rec) {
          problems.push(`${label}: ${r.error ?? "no recording"}`);
          continue;
        }
        report.wire[`capture/${label}`] = [];
        for (const step of allSteps) {
          const t = stateAt(r.rec, settleOf(step));
          if (!t) {
            problems.push(`${label} step ${step}: no state`);
            continue;
          }
          const w = wireStateProblems(
            t.state.items as unknown as CgItem[],
            expected,
            step,
          );
          problems.push(
            ...w.problems.map((p) => `${label} step ${step}: ${p}`),
          );
          report.wire[`capture/${label}`].push({
            step,
            canvas_group: w.groups,
            copy_to_backbuffer: w.copies,
          });
        }
      }
    }
    checks.push(
      check(
        "cg-wire",
        "the /10 capture's full and patch sinks decode at version 10 (the TS decoder validates every record, backbuffer-offset included) and, at every checkpoint, the items carry exactly expected.json's canvas_group and copy_to_backbuffer states (null on every other item)",
        problems,
        Object.entries(report.wire)
          .map(
            ([k, v]) =>
              `${k}: ${v.map((s) => `${s.canvas_group}/${s.copy_to_backbuffer}`).join(" ")}`,
          )
          .join("; "),
      ),
    );
  }

  // --- cg-toggle-patch ------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("capture"))
      problems = capPatch.decoded
        ? toggleProblems(transactionsOf(capPatch.decoded), expected)
        : [capPatch.error ?? "no patch recording"];
    checks.push(
      check(
        "cg-toggle-patch",
        `TGL's clip_children toggle (state only, no redraw) is one patch entry at frame ${expected.toggle.frame}: canvas_group ${expected.toggle.mode} with commands null`,
        problems,
      ),
    );
  }

  // --- pixels ---------------------------------------------------------------------------------
  const refShot = (dir: string, step: number) =>
    decodePngRgba(join(root, dir, "shots", `step-${step}.png`));
  const legShot = async (dir: string, steps: number[], step: number) => {
    const seqs =
      (await readText(join(root, dir, "shot-seqs.txt")))?.trim().split(",") ??
      [];
    const i = steps.indexOf(step);
    if (i < 0 || seqs[i] === undefined) return undefined;
    return decodePngRgba(join(root, dir, "shots", `seq-${seqs[i]}.png`));
  };
  const diffs = async (dir: string, steps: number[]) => {
    const rows: {
      step: number;
      d: { cells: Record<string, number>; outside: number } | null;
    }[] = [];
    for (const step of steps) {
      const a = dir.startsWith("reference")
        ? await refShot(dir, step)
        : await legShot(dir, steps, step);
      const b = await refShot("reference", step);
      const d = a && b ? cellDiff(a, b, expected.cells) : null;
      rows.push({ step, d });
      if (d) {
        report.pixels[dir] ??= [];
        report.pixels[dir].push({ step, ...d });
      }
    }
    return rows;
  };

  // --- cg-reference-repeat --------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("reference") && ran("reference-repeat")) {
      problems = [];
      for (const r of await diffs("reference-repeat", allSteps))
        if (!r.d) problems.push(`step ${r.step}: shot missing`);
        else
          problems.push(
            ...exactProblems(r.d).map((p) => `step ${r.step}: ${p}`),
          );
    }
    checks.push(
      check(
        "cg-reference-repeat",
        "two unarmed runs of the fixture are identical at every checkpoint: the back buffer each screen reader and group reads is deterministic at the settle frames",
        problems,
      ),
    );
  }

  // --- cg-reference-model ---------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("reference")) {
      problems = [];
      for (const step of allSteps) {
        const img = await refShot("reference", step);
        if (!img) problems.push(`step ${step}: no shot`);
        else
          problems.push(
            ...modelProblems(img, expected.model).map(
              (p) => `step ${step}: ${p}`,
            ),
          );
      }
    }
    checks.push(
      check(
        "cg-reference-model",
        "the reference matches the hand model: BBV is its inverted backdrop without the overlay drawn after the viewport copy, BBR's left half its inverted backdrop and its right half the inverted clear colour (BBV's whole-target copy, untouched by BBR's rect copy), PLAIN its pattern, and HPBAR's 18 px fills show only on the mask's 10 rows",
        problems,
      ),
    );
  }

  // --- cg-native-exact ------------------------------------------------------------------------
  {
    let problems: string[] | null = [];
    for (const l of nativeReceivers) {
      if (!ran(l) || !ran("reference")) {
        problems = null;
        break;
      }
      for (const r of await diffs(l, allSteps))
        if (!r.d) problems.push(`${l} step ${r.step}: shot missing`);
        else
          problems.push(
            ...exactProblems(r.d).map((p) => `${l} step ${r.step}: ${p}`),
          );
    }
    checks.push(
      check(
        "cg-native-exact",
        "the native receiver on the /10 full and patch sinks equals the unarmed reference exactly at every checkpoint (its own Godot does the grouping and the copies from the re-issued state)",
        problems,
      ),
    );
  }

  // --- cg-negative-control, cg-sabotage-* ----------------------------------------------------
  for (const l of compared) {
    const id = l === "receiver-v9" ? "cg-negative-control" : SABOTAGE_CHECKS[l];
    const removed = expected.removes[l] ?? [];
    let problems: string[] | null = null;
    if (ran(l) && ran("reference")) {
      problems = [];
      for (const r of await diffs(l, allSteps))
        if (!r.d) problems.push(`step ${r.step}: shot missing`);
        else
          problems.push(
            ...cellProblems(r.d, expected.cells, removed, r.step).map(
              (p) => `step ${r.step}: ${p}`,
            ),
          );
    }
    const what =
      l === "receiver-v9"
        ? "the /9 capture replayed (the pre-/10 picture: no group, no forced copy)"
        : `the receiver sabotage ${l.split("/")[0].replace("sabotage-", "")}`;
    checks.push(
      check(
        id,
        `${what} differs from the reference in every cell whose pixels depend on ${removed.join(", ")} at that checkpoint, and equals it everywhere else`,
        problems,
      ),
    );
  }

  // --- cg-adopt -------------------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("late/capture")) {
      problems = [];
      if (!late.rec) problems.push(late.error ?? "no late recording");
      else {
        problems.push(
          ...sessionProblems(sessionOf(late.decoded), 10, methods).map(
            (p) => `late session: ${p}`,
          ),
        );
        report.wire["late/capture"] = [];
        for (const step of expected.late_steps) {
          const t = stateAt(late.rec, settleOf(step));
          if (!t || t.frame < expected.arm_frame) {
            problems.push(`late step ${step}: no state`);
            continue;
          }
          const w = wireStateProblems(
            t.state.items as unknown as CgItem[],
            expected,
            step,
          );
          problems.push(...w.problems.map((p) => `late step ${step}: ${p}`));
          report.wire["late/capture"].push({
            step,
            canvas_group: w.groups,
            copy_to_backbuffer: w.copies,
          });
        }
      }
      const result = await readJson<{
        stream?: { status?: string; gate8?: { adopt?: string } };
      }>(join(root, "late/capture", "evidence", "result.json"));
      if (result?.stream?.gate8?.adopt === undefined)
        problems.push("late result.json has no stream.gate8.adopt");
      if (ran("late/receiver") && ran("reference")) {
        for (const r of await diffs("late/receiver", expected.late_steps))
          if (!r.d) problems.push(`late/receiver step ${r.step}: shot missing`);
          else
            problems.push(
              ...exactProblems(r.d).map(
                (p) => `late/receiver step ${r.step}: ${p}`,
              ),
            );
      } else problems = null;
    }
    checks.push(
      check(
        "cg-adopt",
        `a capture armed late (frame ${expected.arm_frame}, GRC_ADOPT=arm) adopts every clip_children, CanvasGroup and BackBufferCopy state from the nodes (render-stream-10.md "Adoption"): its items carry exactly expected.json's states at steps ${expected.late_steps.join(", ")}, and its native replay equals the reference exactly there`,
        problems,
      ),
    );
  }

  return { checks, report };
}
