// Gate 4d checks: fixtures/gate4-rich/ (RichTextLabel spans, protocol/gate4-design.md "G4d").
//
// This is its own fixture (expected.json, schema render-stream-gate4-expected/1, fixture
// "gate4-rich"), so every check id here is prefixed "rich-" to stay distinct from fixtures/gate4/
// (G4a/G4b)'s identically-shaped checks in the same flat `report.checks` array when
// `--legs g4a,g4b,g4d` runs together. Evidence lives under its own `rich-*/` directories (never
// `capture/`, `reference/`, ... which g4a/g4b already own in the same `--out`).
//
// Per gate4-design.md Q6c, "For RichTextLabel the oracle reports glyph sets and counts per span,
// not quads": there is no exact-quad placement check here (no `rich-expected-text-*`, D8's exact
// synthesis, which fundamentally needs quads). `rich-expected-image-reference`/`-receiver` and
// `rich-ink-presence-*` are quad-independent (a flat mask / a pixel-count threshold) and apply
// unchanged. `rich-glyph-commands` is a counts-and-pages check, not a quad check: it sums each
// wire texture id's glyph draws against the oracle's per-span glyph_count grouped by the same
// id (through atlas-hash-parity's cache-key -> wire-id mapping), and separately asserts bold and
// italic map to a *different* wire id than the plain fill cache ("own pages").
//
// Many G4a/G4b primitives are reused verbatim because they are generic over `Gate4Expected` and
// an `OracleLog`-shaped `{step, frame, pages}` (nothing here depends on `OracleLine.nodes`, which
// this file's oracle adapter leaves empty): `shotsOf`, `loadShots`, `gate4Regions`, `compareLegs`,
// `evaluateExpectedImage`, `evaluateInkPresence`, `markerAlignment`, `receiverStepSeqs`,
// `loadReceiverShots`, `computeGate4Checkpoints`, `checkLegClass`, `evaluateResourceQuiet`,
// `censusFromLog`/`evaluateAtlasCensus`/`checkAtlasCensus`, `evaluateAtlasParity`/
// `checkAtlasHashParity`, `evaluateAppendOnly`/`checkAtlasAppendOnly`. Every reused check's `id`
// is renamed with the "rich-" prefix at the call site (the functions themselves are unchanged).
//
// Capture-evaluation and env primitives that hardcode the leg directory name "capture" (gate0's
// `checkCaptureArmed`, gate3's `evaluateCapture`, gate4's `checkStepAlignment`/`checkFixtureEnv`)
// are not reusable as-is for a fixture whose capture lives at `rich-capture/`; this file has its
// own small, directory-parameterized equivalents instead (`evaluateRichCapture`,
// `checkRichStepAlignment`, `checkRichFixtureEnv`). `checkHeadlessNoGpu` (gate -1's) already takes
// a leg-name parameter and is reused directly.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { type ClipRect, deriveClipRects, ownerClip } from "./clip-derive";
import {
  checkHeadlessNoGpu,
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type AppliedJson,
  type CaptureResultJson,
  checkReceiverNeverLoadedFixture,
  classifyLeg,
  GATE0_HOOKS,
  type Gate0Check,
  type LegClass,
  loadRecording,
  PATCH_RECORDING_NAME,
  parseStepLog,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
  type StepLine,
} from "./gate0-checks";
import { classifyGate1, patchDivergence } from "./gate1-checks";
import { type CaptureEvidence, loadCapture } from "./gate2b-checks";
import { unsupportedOps } from "./gate3-checks";
import {
  type CensusStep,
  check,
  checkAtlasAppendOnly,
  checkAtlasCensus,
  checkAtlasHashParity,
  checkLegClass,
  compareLegs,
  computeGate4Checkpoints,
  evaluateExpectedImage,
  evaluateInkPresence,
  evaluateResourceQuiet,
  FONT_PINS,
  type Gate4Check,
  type Gate4LegExpectation,
  loadReceiverShots,
  loadShots,
  markerAlignment,
  type OracleLog,
  type ParityCell,
  type RegionBudget,
  receiverStepSeqs,
  SETTING_PINS,
  shotsOf,
  TEXT_SERVER_NAME,
  type TextStepReport,
  textReport,
} from "./gate4-checks";
import {
  cacheKeyOf,
  type Gate4Expected,
  type Gate4ExpectedStep,
  type OraclePage,
  pageKeyOf,
  type Rect4,
} from "./gate4-expected";

// ---------------------------------------------------------------------------------------------
// Types: expected.json's rich-specific fields, and the span-level oracle line
// ---------------------------------------------------------------------------------------------

export interface Gate4RichSpan {
  key: string;
  font_key: string;
  size: number;
  text: string;
  colour: [number, number, number, number];
  bgcolor: [number, number, number, number] | null;
  outline: number;
}

export interface Gate4RichExpectedStep extends Gate4ExpectedStep {
  spans: Gate4RichSpan[];
  /** owner -> [x0,y0,x1,y1): gate 3's clip-rect shape, hand-computed (RTL's fixed rect: see
   * fixtures/gate4-rich/gate4-rich.gd's header for why fit_content never grows it). */
  clip_rects: Record<string, Rect4>;
}

export interface Gate4RichExpected extends Gate4Expected {
  steps: Gate4RichExpectedStep[];
}

export interface RichOracleSpan {
  key: string;
  font_key: string;
  size: number;
  glyph_count: number;
  glyph_indices: number[];
  page: number;
}

export interface RichOracleLine {
  schema: "render-stream-gate4-glyphs/1";
  step: number;
  frame: number;
  spans: RichOracleSpan[];
  pages: OraclePage[];
}

export interface RichOracleLog {
  leg: string;
  path: string;
  text: string | undefined;
  lines: RichOracleLine[];
  problem: string | null;
}

const f32 = (v: number): number => Math.fround(v);
const f32eq = (a: readonly number[] | undefined, b: readonly number[]) =>
  !!a && a.length === b.length && a.every((v, i) => f32(v) === f32(b[i]));

function fromGate0(c: Gate0Check): Gate4Check {
  return { ...c, status: c.passed ? "pass" : "fail" };
}

function rich(c: Gate4Check): Gate4Check {
  return { ...c, id: `rich-${c.id}` };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  return v;
}

// ---------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------

export async function loadRichOracle(
  outDir: string,
  legRelDir: string,
): Promise<RichOracleLog> {
  const path = join(outDir, legRelDir, "oracle", "glyphs.jsonl");
  const text = await readTextOrUndefined(path);
  const lines: RichOracleLine[] = [];
  let problem: string | null = text === undefined ? "missing" : null;
  for (const [i, raw] of (text ?? "").split("\n").entries()) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as RichOracleLine);
    } catch {
      problem = `line ${i + 1} is not JSON`;
      break;
    }
  }
  return { leg: legRelDir, path, text, lines, problem };
}

export function richOracleAt(
  log: RichOracleLog,
  step: number,
): RichOracleLine | undefined {
  return log.lines.find((l) => l.step === step);
}

/** Adapts a RichOracleLog to the OracleLog shape that `evaluateAtlasParity`/`evaluateAtlasCensus`/
 * `evaluateAppendOnly`'s callers need (they read only `.step`, `.frame` and `.pages`; `.nodes` is
 * never touched by those functions and is left empty here). */
function toOracleLogShim(log: RichOracleLog): OracleLog {
  return {
    leg: log.leg,
    path: log.path,
    text: log.text,
    problem: log.problem,
    lines: log.lines.map((l) => ({
      schema: l.schema,
      step: l.step,
      frame: l.frame,
      nodes: [],
      pages: l.pages,
    })),
  };
}

/** The oracle agrees with expected.json: per step, every span's glyph_count/cache/page key
 * matches, both oracle legs wrote byte-identical logs, and each cache's cumulative distinct-glyph
 * count equals `page_glyphs`. */
export function evaluateRichOracleAgrees(
  expected: Gate4RichExpected,
  logs: readonly RichOracleLog[],
): string[] {
  const problems: string[] = [];
  const [log, ...others] = logs;
  if (!log) return ["no oracle log"];
  for (const l of logs)
    if (l.problem) problems.push(`${l.leg}: glyphs.jsonl ${l.problem}`);
  for (const o of others)
    if (o.text !== log.text)
      problems.push(`${o.leg}: glyphs.jsonl differs from ${log.leg}'s`);
  const seen = new Map<string, Set<number>>();
  for (const s of expected.steps) {
    const line = richOracleAt(log, s.step);
    const fail = (t: string) => problems.push(`step ${s.step}: ${t}`);
    if (!line) {
      fail("no oracle line");
      continue;
    }
    if (line.frame !== s.settle_frame)
      fail(`oracle frame ${line.frame}, settle ${s.settle_frame}`);
    // An outlined span expands to two oracle entries sharing its `key` (the fill pass, cache
    // `font_key@size`, and the outline pass, cache `font_keyO@size`); every other span is one
    // entry. Grouped by `key` rather than by position, since the counts differ per span.
    const byKey = new Map<string, RichOracleSpan[]>();
    for (const span of line.spans)
      byKey.set(span.key, [...(byKey.get(span.key) ?? []), span]);
    const wantKeys = s.spans.map((sp) => sp.key).sort();
    const gotKeys = [...byKey.keys()].sort();
    if (wantKeys.join(",") !== gotKeys.join(","))
      fail(
        `oracle span keys ${gotKeys.join(",")}, expected ${wantKeys.join(",")}`,
      );
    for (const want of s.spans) {
      const entries = byKey.get(want.key) ?? [];
      const wantEntryCount = want.outline > 0 ? 2 : 1;
      if (entries.length !== wantEntryCount) {
        fail(
          `span ${want.key}: ${entries.length} oracle entries, expected ${wantEntryCount} (outline ${want.outline})`,
        );
        continue;
      }
      for (const span of entries) {
        const isOutlinePass = span.font_key.endsWith("O");
        const key = isOutlinePass
          ? `${want.font_key}O@${want.size}`
          : `${want.font_key}@${want.size}`;
        const gotKey = `${span.font_key}@${span.size}`;
        if (gotKey !== key)
          fail(
            `span ${want.key}: oracle cache ${gotKey}, expected ${key} (font_key ${want.font_key}, outline ${want.outline})`,
          );
        // The oracle's glyph_count is the plain character count of the span's text (no spaces,
        // no ligating pairs here): it must equal the span's text length, for the fill pass and
        // (same characters) the outline pass alike.
        if (span.glyph_count !== want.text.length)
          fail(
            `span ${want.key}: oracle glyph_count ${span.glyph_count}, text length ${want.text.length}`,
          );
        const set = seen.get(key) ?? new Set<number>();
        for (const idx of span.glyph_indices) set.add(idx);
        seen.set(key, set);
      }
    }
    for (const [key, want] of Object.entries(s.page_glyphs)) {
      const got = seen.get(key)?.size ?? 0;
      if (got !== want)
        fail(`${key}: ${got} distinct glyphs seen so far, expected ${want}`);
    }
    for (const p of line.pages) {
      if (
        p.format !== expected.page.format ||
        p.width !== expected.page.width ||
        p.height !== expected.page.height ||
        p.mipmaps !== expected.page.mipmaps ||
        p.data_bytes !== expected.page.data_bytes ||
        p.outline !== 0
      )
        fail(
          `page ${pageKeyOf(p)} is ${p.format} ${p.width}x${p.height} mipmaps ${p.mipmaps} outline ${p.outline}`,
        );
    }
    const caches = [...new Set(line.pages.map((p) => cacheKeyOf(p)))].sort();
    const wantCaches = Object.keys(s.page_counts).sort();
    if (caches.join(",") !== wantCaches.join(","))
      fail(
        `oracle caches ${caches.join(",")}, expected ${wantCaches.join(",")}`,
      );
  }
  return problems;
}

export function checkRichOracleAgrees(
  expected: Gate4RichExpected,
  logs: readonly RichOracleLog[],
): Gate4Check {
  const problems = evaluateRichOracleAgrees(expected, logs);
  const spans = logs[0]?.lines.reduce((n, l) => n + l.spans.length, 0);
  return check(
    "rich-oracle-agrees",
    "the reference's glyph oracle (per-span glyph_count/cache/page, not quads: gate4-design.md Q6c) equals expected.json's independent derivation at every settle step, and reference/reference-repeat wrote byte-identical oracle logs",
    problems,
    `${logs[0]?.lines.length ?? 0} oracle lines, ${spans ?? 0} span entries, identical across ${logs.map((l) => l.leg).join(" and ")}`,
    logs.map((l) => l.path),
  );
}

// ---------------------------------------------------------------------------------------------
// Names (wire ids by creation order: RTL, Marker)
// ---------------------------------------------------------------------------------------------

export interface RichNameMap {
  byName: Map<string, number>;
  byId: Map<number, string>;
  problems: string[];
}

export function mapRichNames(
  expected: Gate4RichExpected,
  recording: RecordingSummary,
): RichNameMap {
  const ids = new Set<number>();
  for (const t of recording.transactions)
    for (const i of t.meta.items) ids.add(i.id);
  const sorted = [...ids].sort((a, b) => a - b);
  const names = expected.creation_order;
  const problems: string[] = [];
  if (sorted.length !== names.length)
    problems.push(
      `${sorted.length} item ids in the recording, expected ${names.length}`,
    );
  const byName = new Map<string, number>();
  const byId = new Map<number, string>();
  for (let i = 0; i < Math.min(sorted.length, names.length); i++) {
    byName.set(names[i], sorted[i]);
    byId.set(sorted[i], names[i]);
  }
  const settle0 = recording.transactions.find(
    (t) => t.meta.frame === expected.steps[0]?.settle_frame,
  );
  const markerId = byName.get("Marker");
  const want = (expected.steps[0]?.marker_rgba8 ?? [0, 0, 0, 255]).map((c) =>
    f32(c / 255),
  );
  const markerItem = settle0?.meta.items.find((i) => i.id === markerId);
  if (
    !markerItem?.commands.some(
      (c) => c.op === "add_rect" && f32eq(c.color, want),
    )
  )
    problems.push(
      `Marker (id ${markerId ?? "?"}) has no add_rect in ${want.join(",")} at step 0`,
    );
  return { byName, byId, problems };
}

// ---------------------------------------------------------------------------------------------
// rich-atlas-hash-parity's page mapping feeds rich-glyph-commands (per-id glyph counts, "own
// pages" for bold/italic) and rich-bgcolor-rects.
// ---------------------------------------------------------------------------------------------

export function evaluateRichGlyphCommands(
  expected: Gate4RichExpected,
  oracle: RichOracleLog,
  recording: RecordingSummary,
  names: RichNameMap,
  mapping: ReadonlyMap<string, number>,
): { problems: string[]; commands: Record<string, number> } {
  const problems: string[] = [];
  const commands: Record<string, number> = {};
  const rtlId = names.byName.get("RTL");
  for (const s of expected.steps) {
    const line = richOracleAt(oracle, s.step);
    const tx = recording.transactions.find(
      (t) => t.meta.frame === s.settle_frame,
    );
    if (!line || !tx) {
      problems.push(
        `step ${s.step}: no ${line ? "settle transaction" : "oracle line"}`,
      );
      continue;
    }
    const fail = (t: string) => problems.push(`step ${s.step}: ${t}`);
    const item = tx.meta.items.find((i) => i.id === rtlId);
    if (!item) {
      fail("RTL is not in the settle transaction");
      continue;
    }
    const textured = item.commands.filter(
      (c) => c.op === "add_texture_rect_region",
    );
    const rects = item.commands.filter((c) => c.op === "add_rect");
    // Per-id glyph counts: group the oracle's spans by the wire id their cache maps to, and
    // compare against the item's own texture commands grouped by `tex`.
    const wantById = new Map<number, number>();
    for (const span of line.spans) {
      const key = `${span.font_key}@${span.size}/0#${span.page}`;
      const id = mapping.get(key);
      if (id === undefined) {
        fail(
          `span ${span.key}: page ${key} is not in atlas-hash-parity's mapping`,
        );
        continue;
      }
      wantById.set(id, (wantById.get(id) ?? 0) + span.glyph_count);
    }
    const gotById = new Map<number, number>();
    for (const c of textured)
      if (typeof c.tex === "number")
        gotById.set(c.tex, (gotById.get(c.tex) ?? 0) + 1);
    const ids = new Set([...wantById.keys(), ...gotById.keys()]);
    for (const id of ids) {
      const want = wantById.get(id) ?? 0;
      const got = gotById.get(id) ?? 0;
      if (want !== got)
        fail(`wire id ${id}: ${got} texture commands, oracle expects ${want}`);
    }
    commands[s.step] = textured.length;
    // bgcolor: one add_rect per active [bgcolor] span, colour-matched.
    const bgSpans = s.spans.filter((sp) => sp.bgcolor !== null);
    if (rects.length !== bgSpans.length)
      fail(
        `${rects.length} add_rect commands on RTL, expected ${bgSpans.length} ([bgcolor] spans)`,
      );
    for (const sp of bgSpans) {
      if (!rects.some((c) => f32eq(c.color, sp.bgcolor as number[])))
        fail(`span ${sp.key}: no add_rect colour ${sp.bgcolor?.join(",")}`);
    }
  }
  // Bold and italic each have their own page (distinct wire id from the plain fill cache).
  const idOf = (key: string) => mapping.get(`${key}/0#0`);
  const plain = idOf("F@16");
  const bold = idOf("FB@16");
  const italic = idOf("FI@16");
  if (plain !== undefined && bold !== undefined && plain === bold)
    problems.push(
      `FB@16 shares wire id ${bold} with F@16 (expected its own page)`,
    );
  if (plain !== undefined && italic !== undefined && plain === italic)
    problems.push(
      `FI@16 shares wire id ${italic} with F@16 (expected its own page)`,
    );
  return { problems, commands };
}

export function checkRichGlyphCommands(
  expected: Gate4RichExpected,
  oracle: RichOracleLog,
  full: RecordingSummary,
  patch: RecordingSummary,
  mapping: ReadonlyMap<string, number>,
): { check: Gate4Check; commands: Record<string, number> } {
  const problems: string[] = [];
  let commands: Record<string, number> = {};
  for (const [sink, rec] of [
    ["full", full],
    ["patch", patch],
  ] as const) {
    const names = mapRichNames(expected, rec);
    const r = evaluateRichGlyphCommands(expected, oracle, rec, names, mapping);
    problems.push(
      ...[...names.problems, ...r.problems]
        .slice(0, 16)
        .map((p) => `${sink}: ${p}`),
    );
    if (sink === "full") commands = r.commands;
  }
  const total = Object.values(commands).reduce((n, c) => n + c, 0);
  return {
    check: check(
      "rich-glyph-commands",
      "on both sinks' settle transactions, RTL's add_texture_rect_region commands grouped by wire id equal the oracle's per-span glyph_count grouped by the same id (atlas-hash-parity's mapping); bold and italic map to a wire id distinct from the plain fill cache (their own page); each [bgcolor] span has exactly one matching add_rect",
      problems,
      `${total} glyph commands over ${expected.steps.length} settle transactions x 2 sinks equal the oracle by wire id`,
      [oracle.path, full.path, patch.path],
    ),
    commands,
  };
}

// ---------------------------------------------------------------------------------------------
// rich-clip-rects-derived: gate 3's clip derivation over RTL's own clip (fixed rect every step)
// ---------------------------------------------------------------------------------------------

export function checkRichClipRects(
  expected: Gate4RichExpected,
  full: RecordingSummary,
  patch: RecordingSummary,
): Gate4Check {
  const problems: string[] = [];
  for (const [sink, rec] of [
    ["full", full],
    ["patch", patch],
  ] as const) {
    const names = mapRichNames(expected, rec);
    problems.push(...names.problems.map((p) => `${sink}: ${p}`));
    const rtlId = names.byName.get("RTL");
    const mask = Number(rec.session?.viewport?.canvas_cull_mask ?? 0xffffffff);
    for (const s of expected.steps) {
      const tx = rec.transactions.find((t) => t.meta.frame === s.settle_frame);
      if (!tx || rtlId === undefined) {
        problems.push(
          `${sink} step ${s.step}: no settle transaction or RTL id`,
        );
        continue;
      }
      const derived = deriveClipRects(tx.meta, expected.viewport, {
        cullMask: mask,
      });
      const got = rtlId === undefined ? null : ownerClip(derived, rtlId);
      const want = s.clip_rects.RTL;
      const gotRect: ClipRect | null =
        got && typeof got === "object" ? got : null;
      if (
        !gotRect ||
        gotRect[0] !== want[0] ||
        gotRect[1] !== want[1] ||
        gotRect[2] !== want[2] ||
        gotRect[3] !== want[3]
      )
        problems.push(
          `${sink} step ${s.step}: RTL derives ${JSON.stringify(got)}, expected [${want.join(",")})`,
        );
    }
  }
  return check(
    "rich-clip-rects-derived",
    "deriveClipRects (lib/clip-derive.ts) over RTL on each settle transaction of both sinks equals expected.json's fixed clip rect for every step (RTL's position/size never changes: fit_content only grows a free Control up to its minimum, and the chosen size is generous enough that it never needs to)",
    problems,
    `${expected.steps.length} steps x 2 sinks derive RTL's fixed clip rect exactly`,
    [full.path, patch.path],
  );
}

// ---------------------------------------------------------------------------------------------
// Capture evaluation and fixture-env (directory-parameterized, since fixtures/gate4-rich/ legs
// live under rich-*/, not the bare leg names gate0/gate2b/gate3/gate4's own helpers hardcode)
// ---------------------------------------------------------------------------------------------

export interface RichCaptureEvaluation {
  expected_class: LegClass;
  result_class: LegClass;
  reasons: string[];
  harmless_ties: string[];
  exit_code: number | null;
  artifacts: string[];
  full: RecordingSummary;
  patch: RecordingSummary;
  captureResult: CaptureResultJson | undefined;
}

export async function evaluateRichCapture(
  outDir: string,
  legRelDir: string,
): Promise<RichCaptureEvaluation> {
  const dir = join(outDir, legRelDir);
  const captureResult = await readJson<CaptureResultJson>(
    join(dir, "evidence", "result.json"),
  );
  const full = await loadRecording(join(dir, RECORDING_NAME));
  const patch = await loadRecording(join(dir, PATCH_RECORDING_NAME));
  const base = classifyLeg({ captureResult, recording: full, checkpoints: [] });
  const c = classifyGate1(base, full.session, patchDivergence(full, patch));
  const artifacts: string[] = [];
  for (const p of [
    "argv.txt",
    "env.txt",
    "stdout.log",
    "exit-code.txt",
    "evidence/result.json",
    "evidence/counters.json",
    RECORDING_NAME,
    PATCH_RECORDING_NAME,
    "steps.jsonl",
    "strace.txt",
  ])
    if (await fileExists(join(dir, p))) artifacts.push(join(dir, p));
  return {
    // As built (G4d): RichTextLabel unconditionally emits canvas_item_add_set_transform while
    // drawing text, unrelated to any span this fixture chose, which render-stream/3 typed
    // unsupported, so every RichTextLabel capture classified "unsupported" then. Corrected since
    // G5d (gate5-design.md D9, Q1g, Q6g): the emission is per glyph, not per line --
    // _draw_line's text/outline passes call draw_set_transform_matrix(char_final_xform) before
    // each glyph and draw_set_transform_matrix(Transform2D()) after it
    // (scene/gui/rich_text_label.cpp:1358-1378, :1427), both identity without a [fx] effect --
    // and render-stream/4 carries add_set_transform as a real command the receiver replays, so
    // rich-capture classifies "success" with no unsupported op at all.
    expected_class: "success",
    result_class: c.result_class as LegClass,
    reasons: c.reasons,
    harmless_ties: c.harmless_ties,
    exit_code: await readExitCode(dir),
    artifacts,
    full,
    patch,
    captureResult,
  };
}

const IDENTITY_XFORM = [1, 0, 0, 1, 0, 0];

/** RTL's add_set_transform commands at one settle transaction: how many, how many are identity,
 * and how many glyph (add_texture_rect_region) commands they surround. */
export interface RichSetTransformStep {
  step: number;
  set_transform: number;
  identity: number;
  glyph_commands: number;
}

/** Per settle step, RTL's add_set_transform commands on `recording` (gate5-design.md Q1g's
 * measurement): RichTextLabel brackets every glyph of its text and outline passes with
 * draw_set_transform_matrix(char_final_xform) and draw_set_transform_matrix(Transform2D())
 * (scene/gui/rich_text_label.cpp:1358-1378, :1427), both identity without a [fx] effect. */
export function richSetTransformSteps(
  expected: Gate4RichExpected,
  recording: RecordingSummary,
): { steps: RichSetTransformStep[]; problems: string[] } {
  const names = mapRichNames(expected, recording);
  const problems = [...names.problems];
  const rtlId = names.byName.get("RTL");
  const steps: RichSetTransformStep[] = [];
  for (const s of expected.steps) {
    const tx = recording.transactions.find(
      (t) => t.meta.frame === s.settle_frame,
    );
    const item = tx?.meta.items.find((i) => i.id === rtlId);
    if (!item) {
      problems.push(`step ${s.step}: RTL is not in the settle transaction`);
      continue;
    }
    const xforms = item.commands.filter((c) => c.op === "add_set_transform");
    steps.push({
      step: s.step,
      set_transform: xforms.length,
      identity: xforms.filter((c) =>
        IDENTITY_XFORM.every((v, k) => c.transform?.[k] === v),
      ).length,
      glyph_commands: item.commands.filter(
        (c) => c.op === "add_texture_rect_region",
      ).length,
    });
  }
  return { steps, problems };
}

/** `rich-leg-class-capture` (as amended by gate5-design.md Q6g, G5d): the rich-capture leg
 * classifies success with no unsupported op at all, and RTL's text pass reaches the wire as real
 * render-stream/4 add_set_transform commands -- at least two per settle step (one glyph's
 * set-and-reset), every one identity (this fixture uses no [fx] effect). Until G5d
 * (render-stream/3) the class was "unsupported", from canvas_item_add_set_transform alone. */
export function checkRichCaptureLegClass(
  e: RichCaptureEvaluation,
  expected: Gate4RichExpected,
): Gate4Check {
  const problems: string[] = [];
  if (e.result_class !== e.expected_class)
    problems.push(
      `class ${e.result_class}, expected ${e.expected_class}: ${e.reasons.slice(0, 2).join(" | ")}`,
    );
  const ops = unsupportedOps(e.full);
  if (ops.length > 0)
    problems.push(`the recording carries unsupported ${ops.join(", ")}`);
  const xf = richSetTransformSteps(expected, e.full);
  problems.push(...xf.problems);
  for (const s of xf.steps) {
    if (s.set_transform < 2 || s.set_transform % 2 !== 0)
      problems.push(
        `step ${s.step}: RTL carries ${s.set_transform} add_set_transform command(s), expected a set and a reset per glyph (an even count, at least 2)`,
      );
    if (s.identity !== s.set_transform)
      problems.push(
        `step ${s.step}: ${s.set_transform - s.identity} of RTL's add_set_transform commands are not identity`,
      );
  }
  return check(
    "rich-leg-class-capture",
    "the rich-capture leg classifies as success (since G5d, render-stream/4: add_set_transform is a real command, gate5-design.md D9): armed, closed, equivalent sinks, no unsupported op at all; RTL carries its per-glyph add_set_transform set/reset pairs as real commands at every settle step, every one identity",
    problems,
    `${e.result_class}${e.harmless_ties.length > 0 ? ` (${e.harmless_ties.length} harmless tie entries)` : ""}; unsupported ops: ${ops.join(", ") || "none"}; add_set_transform/glyph commands per step: ${xf.steps.map((s) => `${s.step}:${s.set_transform}/${s.glyph_commands}`).join(" ")}`,
    e.artifacts,
  );
}

/** `checkHeadlessNoGpu` already takes a leg name; adapts its `Criterion` to `Gate4Check`, as
 * gate0-checks.ts's own `checkHeadlessNoGpuGate0` does for the bare "capture" leg name. */
export async function checkRichHeadlessNoGpu(
  outDir: string,
): Promise<Gate4Check> {
  const c = await checkHeadlessNoGpu(outDir, "rich-capture");
  return {
    id: "rich-headless-no-gpu",
    criterion: c.description,
    passed: c.status === "pass",
    status: c.status === "pass" ? "pass" : "fail",
    detail:
      c.status === "unavailable"
        ? `unavailable: ${c.detail ?? ""}`
        : (c.detail ?? ""),
    evidence: c.evidence.split(", "),
  };
}

/** A minimal, directory-parameterized `capture-armed`: result.json armed/closed and the
 * session's own hooks_planned/hooks_omitted record (counters.json's own copy is gate -1/0's
 * deeper, already-proven check; this fixture only needs the session-level one). */
export function checkRichCaptureArmed(
  capture: Pick<RichCaptureEvaluation, "captureResult" | "full">,
): Gate4Check {
  const problems: string[] = [];
  const result = capture.captureResult;
  const session = capture.full.session;
  if (result?.status !== "armed")
    problems.push(`result.json status=${JSON.stringify(result?.status)}`);
  if (result?.stream?.status !== "closed")
    problems.push(`stream.status=${JSON.stringify(result?.stream?.status)}`);
  if (!session) {
    problems.push("recording has no session record");
  } else {
    const omitted = session.capture?.hooks_omitted;
    if (!Array.isArray(omitted) || omitted.length > 0)
      problems.push(`session capture.hooks_omitted=${JSON.stringify(omitted)}`);
    const planned = [...(session.capture?.hooks_planned ?? [])].sort();
    if (JSON.stringify(planned) !== JSON.stringify([...GATE0_HOOKS].sort()))
      problems.push(
        `session capture.hooks_planned is not the ${GATE0_HOOKS.length} gate 0 hooks`,
      );
  }
  return check(
    "rich-capture-armed",
    `the rich-capture leg armed with stream.status closed and hooks_planned exactly the ${GATE0_HOOKS.length} hooks named by the committed record, none omitted`,
    problems,
    `armed, stream closed, ${GATE0_HOOKS.length} hooks planned`,
    [capture.full.path],
  );
}

export async function checkRichStepAlignment(
  outDir: string,
  expected: Gate4RichExpected,
  recording: RecordingSummary,
  legs: readonly string[],
): Promise<Gate4Check> {
  const want: StepLine[] = expected.steps.map((s) => ({
    step: s.step,
    applied_frame: s.applied_frame,
    settle_frame: s.settle_frame,
  }));
  const problems: string[] = [];
  const paths: string[] = [];
  for (const leg of legs) {
    const path = join(outDir, leg, "steps.jsonl");
    paths.push(path);
    const got = parseStepLog(await readTextOrUndefined(path));
    if (JSON.stringify(got) !== JSON.stringify(want))
      problems.push(`${leg} steps.jsonl ${JSON.stringify(got)} != expected`);
  }
  problems.push(...markerAlignment(expected, recording.transactions));
  return check(
    "rich-step-alignment",
    "rich-capture and every rich reference leg's steps.jsonl list steps 0..5 at S+N*k (settle +7), and each step's marker colour first appears in the capture transaction of its applied frame",
    problems,
    `marker colours first published at ${expected.steps.map((s) => `${s.step}@${s.applied_frame}`).join(", ")}`,
    [...paths, recording.path],
  );
}

export interface RichEnvJson {
  schema?: string;
  text_server?: string;
  font_files?: Record<string, string>;
  fonts?: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
  viewport_oversampling?: number;
  tool_locale?: string;
}

export async function checkRichFixtureEnv(
  outDir: string,
  legs: readonly string[],
): Promise<Gate4Check> {
  const problems: string[] = [];
  const envs: Record<string, RichEnvJson | undefined> = {};
  for (const leg of legs)
    envs[leg] = await readJson<RichEnvJson>(join(outDir, leg, "env.json"));
  const first = envs[legs[0]];
  for (const leg of legs) {
    const e = envs[leg];
    if (!e) {
      problems.push(`${leg}: env.json missing or unparseable`);
      continue;
    }
    if (
      leg !== legs[0] &&
      JSON.stringify(sortKeys(e)) !== JSON.stringify(sortKeys(first))
    )
      problems.push(`${leg}: env.json differs from ${legs[0]}'s`);
  }
  if (first) {
    if (first.schema !== "render-stream-gate4-env/1")
      problems.push(`schema ${JSON.stringify(first.schema)}`);
    if (first.text_server !== TEXT_SERVER_NAME)
      problems.push(`text_server ${JSON.stringify(first.text_server)}`);
    for (const [prop, want] of Object.entries(FONT_PINS.F)) {
      const got = first.fonts?.F?.[prop];
      if (got !== want)
        problems.push(
          `F.${prop} = ${JSON.stringify(got)}, pinned ${JSON.stringify(want)}`,
        );
    }
    if (typeof first.fonts?.FB?.variation_embolden !== "number")
      problems.push("FB.variation_embolden missing");
    if (!Array.isArray(first.fonts?.FI?.variation_transform))
      problems.push("FI.variation_transform missing");
    for (const [key, want] of Object.entries(SETTING_PINS))
      if (first.settings?.[key] !== want)
        problems.push(
          `${key} = ${JSON.stringify(first.settings?.[key])}, pinned ${JSON.stringify(want)}`,
        );
    if (first.viewport_oversampling !== 1)
      problems.push(
        `viewport oversampling ${first.viewport_oversampling}, expected 1.0`,
      );
    if (first.tool_locale !== "en")
      problems.push(`tool locale ${JSON.stringify(first.tool_locale)}`);
  }
  return check(
    "rich-fixture-env",
    "env.json is identical across rich-capture, rich-reference and rich-reference-repeat, names the Advanced TextServer, carries F's D3 FontFile pins, FB/FI's variation properties, the Q1e project settings, viewport oversampling 1.0 and tool locale en",
    problems,
    `identical across ${legs.join(", ")}; ${TEXT_SERVER_NAME}; oversampling 1.0`,
    legs.map((l) => join(outDir, l, "env.json")),
  );
}

// ---------------------------------------------------------------------------------------------
// Underline variant: capture-underline / receiver-underline. On render-stream/3 both classified
// unsupported (canvas_item_add_line), the receiver's mismatch confined to RTL; since G5d
// (gate5-design.md Q6g) both classify success and the receiver matches the reference exactly.
// ---------------------------------------------------------------------------------------------

/** The underline [u] strokes on `recording`: every add_line command of any item at any
 * transaction (RichTextLabel's draw_line, scene/gui/rich_text_label.cpp:1161-1174, a wide line:
 * width = MAX(1, underline thickness)). */
export function richUnderlineLines(
  recording: RecordingSummary,
): { seq: number; item: number; width: number | undefined }[] {
  const lines: { seq: number; item: number; width: number | undefined }[] = [];
  for (const t of recording.transactions)
    for (const it of t.meta.items)
      for (const c of it.commands)
        if (c.op === "add_line")
          lines.push({ seq: t.meta.seq, item: it.id, width: c.width });
  return lines;
}

/** `rich-underline-capture-class` (as amended by gate5-design.md Q6g, G5d): rich-underline/capture
 * classifies success purely from the recording's own content -- no unsupported op at all -- and
 * the [u] underline reaches the wire as at least one real add_line command, a wide line (width
 * >= 1, never the thin GL-line form). Until G5d (render-stream/3) add_line was an unsupported
 * command and the class was "unsupported". */
export function checkRichUnderlineCaptureClass(
  full: RecordingSummary,
  captureResult: CaptureResultJson | undefined,
): Gate4Check {
  const c = classifyLeg({ captureResult, recording: full, checkpoints: [] });
  const problems: string[] = [];
  if (c.result_class !== "success")
    problems.push(
      `class ${c.result_class}, expected success: ${c.reasons.slice(0, 2).join(" | ")}`,
    );
  const ops = unsupportedOps(full);
  if (ops.length > 0)
    problems.push(`the recording carries unsupported ${ops.join(", ")}`);
  const lines = richUnderlineLines(full);
  if (lines.length === 0)
    problems.push("no add_line command anywhere (expected the [u] underline)");
  const thin = lines.filter(
    (l) => !(typeof l.width === "number" && l.width >= 1),
  );
  if (thin.length > 0)
    problems.push(
      `${thin.length} add_line command(s) are not wide (width ${JSON.stringify(thin[0].width)})`,
    );
  const widths = [...new Set(lines.map((l) => l.width))];
  return check(
    "rich-underline-capture-class",
    "rich-underline/capture classifies as success (since G5d, render-stream/4) purely from the recording's own content: no unsupported op at all, and the [u] underline travels as real add_line commands, each a wide line (width >= 1)",
    problems,
    `${c.result_class}; ${lines.length} add_line command(s) over the run, widths ${JSON.stringify(widths)}`,
    [full.path],
  );
}

// ---------------------------------------------------------------------------------------------
// runGate4d: ties the above into gate4-checks.ts's runGate4 for group "g4d"
// ---------------------------------------------------------------------------------------------

export interface Gate4dResult {
  checks: Gate4Check[];
  legs: Record<
    string,
    {
      group: string;
      expected_class: string | null;
      result_class: string | null;
      reasons: string[];
      harmless_ties?: string[];
      exit_code: number | null;
      artifacts: string[];
    }
  >;
  text: Record<string, TextStepReport>;
  parity: Record<string, ParityCell[]>;
  budgets: RegionBudget[];
  census: Record<string, CensusStep>;
  ink: Record<string, Record<string, number>>;
}

export interface Gate4dContext {
  expected: Gate4RichExpected;
  fixtureDir: string;
  receiverDir: string;
}

export async function runGate4d(
  outDir: string,
  ctx: Gate4dContext,
): Promise<Gate4dResult> {
  const expected = ctx.expected;
  const checks: Gate4Check[] = [];
  const legs: Gate4dResult["legs"] = {};

  const capture = await evaluateRichCapture(outDir, "rich-capture");
  const evidence: CaptureEvidence = await loadCapture(
    outDir,
    "rich-capture",
    "rich-capture",
    G4D_CAPTURE_QUIT_FRAME,
  );
  const oracleLegs = ["rich-reference", "rich-reference-repeat"] as const;
  const oracles: RichOracleLog[] = [];
  for (const leg of oracleLegs) oracles.push(await loadRichOracle(outDir, leg));
  const oracle = oracles[0];
  const oracleShim = toOracleLogShim(oracle);

  const reference = await loadShots(outDir, "rich-reference", expected);
  const repeat = await loadShots(outDir, "rich-reference-repeat", expected);
  const armed = await loadShots(outDir, "rich-reference-armed", expected);

  const parityCheck = checkAtlasHashParity(
    expected,
    oracleShim,
    capture.full,
    capture.patch,
  );
  const mapping = parityCheck.mapping;
  const glyphs = checkRichGlyphCommands(
    expected,
    oracle,
    capture.full,
    capture.patch,
    mapping,
  );
  const censusCheck = await checkAtlasCensus(
    expected,
    evidence,
    capture.full,
    mapping,
  );
  const image = evaluateExpectedImage(expected, "rich-reference", reference);
  const inkCheck = evaluateInkPresence(expected, reference);
  const repeatCmp = compareLegs(expected, reference, repeat);
  const armedCmp = compareLegs(expected, reference, armed);
  const armedResult = await readJson<CaptureResultJson>(
    join(outDir, "rich-reference-armed", "evidence", "result.json"),
  );
  if (armedResult?.status !== "armed")
    armedCmp.problems.unshift(
      `rich-reference-armed result.json status=${JSON.stringify(armedResult?.status)}`,
    );
  if (armedResult?.stream?.status !== "closed")
    armedCmp.problems.unshift(
      `rich-reference-armed stream.status=${JSON.stringify(armedResult?.stream?.status)}`,
    );
  const shotPaths = (leg: string) =>
    shotsOf(expected).map((s) => join(outDir, leg, "shots", s.file));

  checks.push(
    checkRichCaptureArmed(capture),
    await checkRichHeadlessNoGpu(outDir),
    await checkRichStepAlignment(outDir, expected, capture.full, [
      "rich-capture",
      "rich-reference",
      "rich-reference-repeat",
      "rich-reference-armed",
    ]),
    await checkRichFixtureEnv(outDir, [
      "rich-capture",
      "rich-reference",
      "rich-reference-repeat",
    ]),
    checkRichOracleAgrees(expected, oracles),
    glyphs.check,
    rich(parityCheck.check),
    rich(
      await checkAtlasAppendOnly(
        expected,
        join(outDir, "rich-capture"),
        capture.full,
        mapping,
      ),
    ),
    rich(censusCheck.check),
    check(
      "rich-expected-image-reference",
      "every rich-reference shot (step-<k>.png at each settle frame) equals the clear colour and the marker exactly outside RTL's region",
      image.problems,
      `${shotsOf(expected).length} reference shots exact outside RTL's region`,
      shotPaths("rich-reference"),
    ),
    check(
      "rich-ink-presence-reference",
      "in every rich-reference settle shot, RTL's region has at least 6 x ink_glyphs pixels differing from the clear colour, and it differs from the previous step's exactly when fresh",
      inkCheck.problems,
      `ink in RTL's region x ${expected.steps.length} steps as expected`,
      shotPaths("rich-reference"),
    ),
    check(
      "rich-reference-repeat-budget",
      "rich-reference vs rich-reference-repeat (same build, GPU and driver, oracle on in both): identical everywhere -- budget 0",
      repeatCmp.problems,
      `budget 0: ${shotsOf(expected).length} shot pairs identical (${repeatCmp.budgets.map((b) => `${b.region} ${b.max_channel_delta}`).join(", ")})`,
      [...shotPaths("rich-reference"), ...shotPaths("rich-reference-repeat")],
    ),
    check(
      "rich-armed-transparent",
      "rich-reference-armed (extension armed, stream on, oracle off) armed with its stream closed, and every shot equals rich-reference's exactly",
      armedCmp.problems,
      `${shotsOf(expected).length} armed shots byte-identical to the reference`,
      shotPaths("rich-reference-armed"),
    ),
    checkRichCaptureLegClass(capture, expected),
    checkRichClipRects(expected, capture.full, capture.patch),
  );
  legs["rich-capture"] = {
    group: "g4d",
    expected_class: capture.expected_class,
    result_class: capture.result_class,
    reasons: capture.reasons,
    harmless_ties: capture.harmless_ties,
    exit_code: capture.exit_code,
    artifacts: capture.artifacts,
  };

  // Receivers: full and patch sinks of rich-capture.
  const seqs = receiverStepSeqs(expected, capture.full);
  const receiverApplied = await readJson<AppliedJson>(
    join(outDir, "rich-receiver", "applied.json"),
  );
  const patchApplied = await readJson<AppliedJson>(
    join(outDir, "rich-receiver-patch", "applied.json"),
  );
  const receiverShots = await loadReceiverShots(
    outDir,
    "rich-receiver",
    expected,
    seqs,
  );
  const patchShots = await loadReceiverShots(
    outDir,
    "rich-receiver-patch",
    expected,
    seqs,
  );
  const referenceDir = join(outDir, "rich-reference");
  const receiverCheckpoints = computeGate4Checkpoints(
    expected,
    referenceDir,
    reference,
    join(outDir, "rich-receiver"),
    receiverShots,
    seqs.settle,
  );
  const patchCheckpoints = computeGate4Checkpoints(
    expected,
    referenceDir,
    reference,
    join(outDir, "rich-receiver-patch"),
    patchShots,
    seqs.settle,
  );
  const requestedShotSeqs = [...seqs.settle.values()];
  const shotFiles = async (dir: string) => {
    try {
      const names = await readdir(join(dir, "shots"));
      return names
        .map((n) => /^seq-(\d+)\.png$/.exec(n)?.[1])
        .filter((x): x is string => x !== undefined)
        .map(Number);
    } catch {
      return [];
    }
  };
  const receiverClass = classifyLeg({
    captureResult: capture.captureResult,
    recording: capture.full,
    receiver: {
      applied: receiverApplied,
      requestedShotSeqs,
      shotFiles: await shotFiles(join(outDir, "rich-receiver")),
    },
    checkpoints: receiverCheckpoints,
  });
  const patchClass = classifyLeg({
    captureResult: capture.captureResult,
    recording: capture.patch,
    receiver: {
      applied: patchApplied,
      requestedShotSeqs,
      shotFiles: await shotFiles(join(outDir, "rich-receiver-patch")),
    },
    checkpoints: patchCheckpoints,
  });
  const refVsReceiver = compareLegs(expected, reference, receiverShots);
  const refVsPatch = compareLegs(expected, reference, patchShots);
  const imageReceiver = evaluateExpectedImage(
    expected,
    "rich-receiver",
    receiverShots,
  );
  const inkReceiver = evaluateInkPresence(expected, receiverShots);
  const quietReceiver = evaluateResourceQuiet(
    expected,
    receiverApplied,
    G4D_CAPTURE_QUIT_FRAME,
  );
  const quietPatch = evaluateResourceQuiet(
    expected,
    patchApplied,
    G4D_CAPTURE_QUIT_FRAME,
  );

  // As built (G4d): RichTextLabel's canvas_item_add_set_transform (evaluateRichCapture's note)
  // made every receiver leg here "unsupported" on render-stream/3, with no step's pixels
  // mismatching. Since G5d (gate5-design.md Q6g, render-stream/4) the receiver replays the
  // commands, so both receivers classify "success": no mismatch at any step.
  const g4dExp: Gate4LegExpectation = { class: "success" };
  checks.push(
    checkLegClass("rich-receiver", receiverClass, receiverCheckpoints, g4dExp, [
      join(outDir, "rich-receiver", "applied.json"),
    ]),
    checkLegClass("rich-receiver-patch", patchClass, patchCheckpoints, g4dExp, [
      join(outDir, "rich-receiver-patch", "applied.json"),
    ]),
    check(
      "rich-receiver-vs-reference",
      "rich-receiver and rich-receiver-patch's shots equal rich-reference's exactly, full frame and every region",
      [
        ...refVsReceiver.problems.map((p) => `rich-receiver: ${p}`),
        ...refVsPatch.problems.map((p) => `rich-receiver-patch: ${p}`),
      ],
      `budgets: ${refVsReceiver.budgets.map((b) => `${b.region} ${b.max_channel_delta}`).join(", ")}`,
      [
        join(outDir, "rich-receiver", "shots"),
        join(outDir, "rich-receiver-patch", "shots"),
      ],
    ),
    check(
      "rich-expected-image-receiver",
      "every rich-receiver shot equals the clear colour and the marker exactly outside RTL's region, as for the reference",
      imageReceiver.problems,
      `${shotsOf(expected).length} receiver shots match exactly`,
      [join(outDir, "rich-receiver", "shots")],
    ),
    check(
      "rich-ink-presence-receiver",
      "the receiver's settle shots carry the same ink presence and freshness as the reference's",
      inkReceiver.problems,
      `ink in RTL's region x ${expected.steps.length} steps as expected`,
      [join(outDir, "rich-receiver", "shots")],
    ),
    check(
      "rich-resource-quiet",
      "every step fetches/uploads something new here (no quiet steps: each cumulatively adds a span), so this check is vacuously satisfied -- kept for shape parity with G4b",
      [
        ...quietReceiver.map((p) => `rich-receiver: ${p}`),
        ...quietPatch.map((p) => `rich-receiver-patch: ${p}`),
      ],
      "0 quiet steps",
      [
        join(outDir, "rich-receiver", "applied.json"),
        join(outDir, "rich-receiver-patch", "applied.json"),
      ],
    ),
  );
  legs["rich-receiver"] = {
    group: "g4d",
    expected_class: "success",
    result_class: receiverClass.result_class,
    reasons: receiverClass.reasons,
    harmless_ties: receiverClass.harmless_ties,
    exit_code: await readExitCode(join(outDir, "rich-receiver")),
    artifacts: [join(outDir, "rich-receiver", "applied.json")],
  };
  legs["rich-receiver-patch"] = {
    group: "g4d",
    expected_class: "success",
    result_class: patchClass.result_class,
    reasons: patchClass.reasons,
    harmless_ties: patchClass.harmless_ties,
    exit_code: await readExitCode(join(outDir, "rich-receiver-patch")),
    artifacts: [join(outDir, "rich-receiver-patch", "applied.json")],
  };

  // Underline variant: capture-underline (classified alone, no receiver) and receiver-underline.
  // On render-stream/3 both were unsupported (canvas_item_add_line) and the receiver's mismatch
  // was confined to RTL's region; since G5d (gate5-design.md Q6g) the underline is a replayed
  // wide add_line, so both classify success and the receiver equals the reference exactly.
  const ulCaptureResult = await readJson<CaptureResultJson>(
    join(outDir, "rich-underline", "capture", "evidence", "result.json"),
  );
  const ulFull = await loadRecording(
    join(outDir, "rich-underline", "capture", RECORDING_NAME),
  );
  checks.push(checkRichUnderlineCaptureClass(ulFull, ulCaptureResult));
  legs["rich-underline-capture"] = {
    group: "g4d",
    expected_class: "success",
    result_class: classifyLeg({
      captureResult: ulCaptureResult,
      recording: ulFull,
      checkpoints: [],
    }).result_class,
    reasons: [],
    exit_code: await readExitCode(join(outDir, "rich-underline", "capture")),
    artifacts: [join(outDir, "rich-underline", "capture", RECORDING_NAME)],
  };

  const ulSeqs = receiverStepSeqs(expected, ulFull);
  const ulReferenceShots = await loadShots(
    outDir,
    join("rich-underline", "reference"),
    expected,
  );
  const ulReceiverShots = await loadReceiverShots(
    outDir,
    join("rich-underline", "receiver"),
    expected,
    ulSeqs,
  );
  const ulApplied = await readJson<AppliedJson>(
    join(outDir, "rich-underline", "receiver", "applied.json"),
  );
  const ulCheckpoints = computeGate4Checkpoints(
    expected,
    join(outDir, "rich-underline", "reference"),
    ulReferenceShots,
    join(outDir, "rich-underline", "receiver"),
    ulReceiverShots,
    ulSeqs.settle,
  );
  const ulClass = classifyLeg({
    captureResult: ulCaptureResult,
    recording: ulFull,
    receiver: {
      applied: ulApplied,
      requestedShotSeqs: [...ulSeqs.settle.values()],
      shotFiles: await shotFiles(join(outDir, "rich-underline", "receiver")),
    },
    checkpoints: ulCheckpoints,
  });
  const ulVsReference = compareLegs(
    expected,
    ulReferenceShots,
    ulReceiverShots,
  );
  checks.push(
    checkLegClass(
      "rich-underline-receiver",
      ulClass,
      ulCheckpoints,
      { class: "success" },
      [
        join(outDir, "rich-underline", "capture", RECORDING_NAME),
        join(outDir, "rich-underline", "receiver", "applied.json"),
      ],
    ),
    check(
      "rich-underline-receiver-vs-reference",
      "the underline receiver's shots equal rich-underline/reference's exactly at every step, full frame and every region (since G5d the [u] stroke is a replayed add_line; on render-stream/3 it was dropped and the mismatch was confined to RTL's region, check rich-underline-confined)",
      ulVsReference.problems,
      `${ulCheckpoints.length} steps identical; budgets: ${ulVsReference.budgets.map((b) => `${b.region} ${b.max_channel_delta}`).join(", ")}`,
      [
        join(outDir, "rich-underline", "reference", "shots"),
        join(outDir, "rich-underline", "receiver", "shots"),
      ],
    ),
  );
  legs["rich-underline-receiver"] = {
    group: "g4d",
    expected_class: "success",
    result_class: ulClass.result_class,
    reasons: ulClass.reasons,
    harmless_ties: ulClass.harmless_ties,
    exit_code: await readExitCode(join(outDir, "rich-underline", "receiver")),
    artifacts: [join(outDir, "rich-underline", "receiver", "applied.json")],
  };

  // receiver-never-loaded-fixture, reusing gate 0's check with this fixture's directory.
  checks.push(
    fromGate0(
      await checkReceiverNeverLoadedFixture(outDir, {
        receiverProjectDir: ctx.receiverDir,
        fixtureProjectDir: ctx.fixtureDir,
        receiverLogs: [
          join(outDir, "rich-receiver", "stdout.log"),
          join(outDir, "rich-receiver-patch", "stdout.log"),
          join(outDir, "rich-underline", "receiver", "stdout.log"),
        ],
      }),
    ),
  );

  const text = textReport(
    expected,
    capture.full,
    evidence.hook.lines,
    mapping,
    glyphs.commands,
    G4D_CAPTURE_QUIT_FRAME,
  );

  return {
    checks,
    legs,
    text,
    parity: parityCheck.table,
    budgets: repeatCmp.budgets,
    census: censusCheck.census,
    ink: inkCheck.ink,
  };
}

/** The leg's own quit frame: as g4a, longer than the fixture's default so the /proc maps/fd
 * sample has time to run (rich-capture mirrors fixtures/gate4's own amendment). */
export const G4D_CAPTURE_QUIT_FRAME = 400;
