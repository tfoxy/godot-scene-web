// Gate 4f checks: the multilingual fixture (protocol/gate4-design.md "G4f", "Q6e").
//
// Group g4f runs fixtures/gate4-i18n/ through G4a's and G4b's legs (capture, reference x3,
// receiver x2, a headless receiver trace) plus sabotage-i18n-omit-atlas. Its evidence lives under
// <out>/i18n/ in the same shape as G4a's under <out>/, so every G4a/G4b/G4c helper that takes an
// evidence root runs on it unchanged; this module adds what shaping needs: glyph commands whose
// fonts come from the fallback chain and whose order is visual (bidi), hex-code boxes drawn as
// add_rects, the script predictions of Q6e checked on the oracle and on the capture, a census over
// four caches, and fallback-pages. Check ids carry an "-i18n" suffix (or name the leg) so that they
// never collide with the other groups'. Nothing here launches a process.
//
// Evidence layout under <out>/i18n/ (see scripts/README.md "Gate 4"):
//   import/fonts.log, import/fixture/   provision-fonts.sh and editor --import of fixtures/gate4-i18n
//   import/receiver/                    editor --import of receiver/
//   capture/                            leg capture-i18n: 400 frames, both sinks, store, strace
//   reference/, reference-repeat/       legs reference-i18n and reference-i18n-repeat (oracle on)
//   reference-armed/                    leg reference-i18n-armed (extension armed, oracle off)
//   receiver-headless-trace/            headless receiver under strace -e openat
//   receiver/, receiver-patch/          legs receiver-i18n and receiver-i18n-patch
//   sabotage-omit-atlas/{capture,receiver}   leg sabotage-i18n-omit-atlas

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readJson, readTextOrUndefined } from "./gate-minus1-checks";
import {
  type AppliedJson,
  type CaptureResultJson,
  checkCaptureArmed,
  checkHeadlessNoGpuGate0,
  checkReceiverNeverLoadedFixture,
  classifyLeg,
  type Gate0Check,
  loadRecording,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
} from "./gate0-checks";
import {
  checkStoreComplete,
  checkTextureVersionsCurrent,
  type HookLine,
  isEngineCall,
  loadCapture,
} from "./gate2b-checks";
import {
  checkCaptureLegClass,
  checkNoDrawIndexTies,
  checkPatchResolvesToFull,
  checkRecordingsDecode,
  evaluateCapture,
} from "./gate3-checks";
import {
  checkAtlasAppendOnly,
  checkAtlasHashParity,
  checkAtlasHashParitySabotage,
  checkLegClass,
  check as checkOf,
  checkReceiverConsumedStream,
  checkReceiverNeverShapes,
  checkReceiverTypedClean,
  checkStepAlignment,
  compareLegs,
  computeGate4Checkpoints,
  type EnvJson,
  evaluateExpectedImage,
  evaluateFixtureEnv,
  evaluateInkPresence,
  evaluateResourceQuiet,
  FONT_PINS,
  type FontLockEntry,
  type Frame,
  type Gate4Check,
  type Gate4Checkpoint,
  loadOracle,
  loadReceiverShots,
  loadShots,
  mapNames4,
  type OracleLog,
  type ParityCell,
  type ReceiverLegInfo,
  type RegionBudget,
  receiverStepSeqs,
  shotsOf,
  type TextStepReport,
  textReport,
} from "./gate4-checks";
import {
  type AtlasPageImage,
  type Box4,
  compareSynthesizedText,
  type Gate4Expected,
  type Gate4ExpectedStep,
  type OracleLine,
  type OraclePage,
  pageKeyOf,
  type Rgba8,
  type SynthesizedFrame,
} from "./gate4-expected";
import {
  evaluateLayoutCensus,
  type LayoutCensusStep,
  type LayoutExpected,
  type LayoutGlyph,
  layoutCensusFromLog,
  loadLayoutPages,
} from "./gate4c-checks";

// ---------------------------------------------------------------------------------------------
// Contract constants and types
// ---------------------------------------------------------------------------------------------

/** The g4f evidence root, relative to the run's --out. */
export const G4F_DIR = "i18n";
/** The main i18n capture's quit frame (as G4a's). */
export const G4F_CAPTURE_QUIT_FRAME = 400;
export const G4F_SABOTAGE = "sabotage-i18n-omit-atlas";

/** A texture glyph command as the i18n oracle computes it: G4c's shape plus its cluster. */
export interface I18nGlyph extends LayoutGlyph {
  start: number;
  end: number;
}

/** One shaped glyph in visual order, whether or not it draws. */
export interface I18nShaped {
  index: number;
  /** null: no font maps it (a hex box) */
  font_key: string | null;
  start: number;
  end: number;
  count: number;
  flags: number;
  advance: number;
  offset: [number, number];
  pen: [number, number];
  /** index into the node's glyphs, -1 when it makes no texture command */
  command: number;
  /** add_rects of its hex box (0 unless font_key is null) */
  hex_rects: number;
}

export type I18nCommand =
  | { op: "add_texture_rect_region"; glyph: number }
  | {
      op: "add_rect";
      rect: [number, number, number, number];
      colour: [number, number, number, number];
      codepoint: number;
    };

export interface I18nNode {
  name: string;
  text: string;
  codepoints: number[];
  font_key: string;
  size: number;
  colour: [number, number, number, number];
  global_xform: number[];
  box: [number, number];
  direction: number;
  inferred_direction: number;
  font_height: number;
  lines: number;
  lines_drawn: number;
  shaped: I18nShaped[];
  shaped_glyphs: number;
  glyphs: I18nGlyph[];
  commands: I18nCommand[];
  problems: string[];
}

export interface I18nOracleLine extends Omit<OracleLine, "nodes"> {
  nodes: I18nNode[];
  caches: {
    font_key: string;
    size: number;
    outline: number;
    glyphs: number;
    textures: number;
  }[];
  cmap: Record<string, number>;
}

export interface I18nStep extends Gate4ExpectedStep {
  ink_min_glyphs: Record<string, number>;
  /** texture glyph commands per node where the model predicts them, else null (complex scripts) */
  glyph_commands: Record<string, number | null>;
  /** add_rect count of the hex box per node that shows one */
  hex_rects: Record<string, number>;
  subpixel_bounded: string[];
  frees: string[];
  clip_rects: Record<string, Box4>;
}

export interface ScriptPrediction {
  id: string;
  node: string;
  text: string;
  claim: string;
  cluster?: [number, number];
  glyphs?: number;
  cmap?: string;
  font?: string;
  commands?: number;
  advance?: number;
  spacing?: number;
  fewer_glyphs_than?: number;
  consonant?: string;
  matra?: [number, number];
  logical?: number[];
  codepoint?: number;
  add_rects?: number;
  texture_commands?: number;
}

export interface I18nExpected extends Omit<Gate4Expected, "steps"> {
  fallback_order: string[];
  fallback_first_steps: Record<string, number>;
  units_model: {
    coverage: Record<string, string>;
    unit_overrides: Record<string, string[]>;
    nfd: { sequence: string; composed: string };
    zero_width: string[];
    unmapped: string[];
  };
  caches: LayoutExpected["caches"];
  subpixel_caches: string[];
  script_predictions: ScriptPrediction[];
  steps: I18nStep[];
}

/** The step list as G4a's helpers see it (structural: the i18n steps are a superset). */
export function asGate4(expected: I18nExpected): Gate4Expected {
  return expected as unknown as Gate4Expected;
}

/** As G4c's census helpers see it (no subpixel caches, frees or clips here). */
function asLayout(expected: I18nExpected): LayoutExpected {
  return expected as unknown as LayoutExpected;
}

const f32 = (v: number): number => Math.fround(v);
const f32eq = (a: readonly number[] | undefined, b: readonly number[]) =>
  !!a && a.length === b.length && a.every((v, i) => f32(v) === f32(b[i]));

/** A check from gate4-checks' `check`, its id suffixed for the i18n group. */
function tag(c: Gate4Check | Gate0Check, suffix = "-i18n"): Gate4Check {
  const status =
    "status" in c ? (c as Gate4Check).status : c.passed ? "pass" : "fail";
  return { ...c, id: `${c.id}${suffix}`, status };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sortObj(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

function overlaps(a: Box4, b: Box4): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** The oracle line of a step, typed. */
function lineAt(oracle: OracleLog, step: number): I18nOracleLine | undefined {
  return oracle.lines.find((l) => l.step === step) as
    | I18nOracleLine
    | undefined;
}

// ---------------------------------------------------------------------------------------------
// expected-self-consistent-i18n: the census re-derived from the strings in TypeScript
// ---------------------------------------------------------------------------------------------

/** A string's glyph-identity units with their fonts (make_expected.py's model, written again):
 * whitespace and zero-width codepoints draw nothing, the NFD sequence is its composition, the
 * hand-segmented strings are their units, ASCII is OS, everything else its string's font. */
export function unitsOf(
  model: I18nExpected["units_model"],
  text: string,
): [string, string][] {
  const override = model.unit_overrides[text];
  if (override) {
    const font = model.coverage[text];
    return override.map((u) => [font, u]);
  }
  if (model.unmapped.includes(text)) return [];
  const fontOf = (ch: string): string => {
    if (ch.codePointAt(0)! < 0x80) return "OS";
    const own = model.coverage[text];
    if (own) return own;
    for (const [t, f] of Object.entries(model.coverage))
      if (t.includes(ch)) return f;
    throw new Error(`no coverage for U+${ch.codePointAt(0)?.toString(16)}`);
  };
  const out: [string, string][] = [];
  for (const ch of text.replaceAll(model.nfd.sequence, model.nfd.composed)) {
    if (/\s/u.test(ch) || model.zero_width.includes(ch)) continue;
    out.push([ch === model.nfd.composed ? "OS" : fontOf(ch), ch]);
  }
  return out;
}

/** The census from the steps' texts and draws: step 0 shapes every Label before drawing; later a
 * Label shapes in its own draw; a draw uploads every page its units made dirty, once. */
export function deriveI18nCensus(expected: I18nExpected): {
  page_creates: Record<string, number>;
  page_uploads: Record<string, number>;
  new_glyphs: Record<string, string>;
}[] {
  const model = expected.units_model;
  const drawn = new Map<string, Set<string>>();
  const pages = new Map<string, { created: boolean; dirty: boolean }>();
  const out = [];
  let prev: I18nStep | undefined;
  for (const s of expected.steps) {
    const creates: Record<string, number> = {};
    const uploads: Record<string, number> = {};
    const fresh: Record<string, string> = {};
    const shape = (n: string) => {
      for (const [font, u] of unitsOf(model, s.texts[n].text)) {
        const cache = `${font}@${s.texts[n].size}`;
        const set = drawn.get(cache) ?? new Set<string>();
        if (set.has(u)) continue;
        set.add(u);
        drawn.set(cache, set);
        fresh[cache] = (fresh[cache] ?? "") + u;
        const p = pages.get(cache) ?? { created: false, dirty: false };
        p.dirty = true;
        pages.set(cache, p);
      }
    };
    const draw = (n: string) => {
      for (const [font] of unitsOf(model, s.texts[n].text)) {
        const cache = `${font}@${s.texts[n].size}`;
        const p = pages.get(cache);
        if (!p?.dirty) continue;
        p.dirty = false;
        if (p.created) uploads[cache] = (uploads[cache] ?? 0) + 1;
        else {
          p.created = true;
          creates[cache] = (creates[cache] ?? 0) + 1;
        }
      }
    };
    if (s.step === 0) {
      for (const n of s.draws) shape(n);
      for (const n of s.draws) draw(n);
    } else
      for (const n of s.draws) {
        if (prev?.texts[n]?.text !== s.texts[n].text) shape(n);
        draw(n);
      }
    out.push({
      page_creates: creates,
      page_uploads: uploads,
      new_glyphs: fresh,
    });
    prev = s;
  }
  return out;
}

const LEVELS = new Set([0, 51, 102, 153, 204, 255]);

export function checkI18nSelfConsistent(expected: I18nExpected): Gate4Check {
  const problems: string[] = [];
  if (expected.schema !== "render-stream-gate4-expected/1")
    problems.push(`schema=${JSON.stringify(expected.schema)}`);
  if (expected.fixture !== "gate4-i18n")
    problems.push(`fixture=${JSON.stringify(expected.fixture)}`);
  const [w, h] = expected.viewport ?? [];
  if (w !== 640 || h !== 360) problems.push(`viewport ${w}x${h}`);
  const S = expected.start_frame_default;
  const N = expected.step_frames_default;
  if (expected.settle_offset !== 7) problems.push("settle_offset is not 7");
  if (expected.quit_frame_default !== S + N * expected.last_step + 11)
    problems.push("quit_frame_default is not S+N*last+11");
  if (!same(expected.fallback_order, ["OS", "VZ", "DV", "HE"]))
    problems.push(`fallback order ${expected.fallback_order.join(",")}`);
  const onGrid = (v: number) => Math.abs(v * 5 - Math.round(v * 5)) < 1e-9;
  const markers = new Set<string>();
  let derived: ReturnType<typeof deriveI18nCensus> = [];
  try {
    derived = deriveI18nCensus(expected);
  } catch (e) {
    problems.push(`census re-derivation: ${(e as Error).message}`);
  }
  const m = expected.regions.marker;
  const markerBox: Box4 = [m[0], m[1], m[0] + m[2], m[1] + m[3]];
  const p = expected.panel.rect;
  const panelBox: Box4 = [p[0], p[1], p[0] + p[2], p[1] + p[3]];
  const firstCreate: Record<string, number> = {};
  for (const s of expected.steps) {
    const fail = (t: string) => problems.push(`step ${s.step}: ${t}`);
    if (
      s.applied_frame !== (s.step === 0 ? 1 : S + N * s.step) ||
      s.settle_frame !== S + N * s.step + 7
    )
      fail(`frames ${s.applied_frame}/${s.settle_frame}`);
    for (const [name, t] of Object.entries(s.texts))
      if (!t.colour.every(onGrid) || (t.colour[3] !== 1 && t.colour[3] !== 0.6))
        fail(`${name} colour ${t.colour.join(",")} breaks the colour rule`);
    if (
      !s.marker_rgba8.every((v) => LEVELS.has(v)) ||
      s.marker_rgba8[3] !== 255
    )
      fail("marker colour breaks the colour rule");
    markers.add(s.marker_rgba8.join(","));
    const names = Object.keys(s.text_regions);
    for (let i = 0; i < names.length; i++) {
      const a = s.text_regions[names[i]];
      for (const b of names.slice(i + 1))
        if (overlaps(a, s.text_regions[b]))
          fail(`regions ${names[i]} and ${b} overlap`);
      const inPanel =
        a[0] >= panelBox[0] &&
        a[1] >= panelBox[1] &&
        a[2] <= panelBox[2] &&
        a[3] <= panelBox[3];
      if (
        !same(
          s.background[names[i]],
          inPanel ? expected.panel.rgba8 : expected.clear_rgba8,
        )
      )
        fail(`${names[i]} background is not its region's`);
      if (!inPanel && overlaps(a, panelBox))
        fail(`${names[i]} straddles the panel`);
      if (overlaps(a, markerBox))
        fail(`${names[i]} overlaps the marker region`);
    }
    if (!same(s.wire_versions, s.hook_versions))
      fail("wire_versions differ from hook_versions");
    const d = derived[s.step];
    if (d)
      for (const key of ["page_creates", "page_uploads", "new_glyphs"] as const)
        if (!same(sortObj(d[key]), sortObj(s[key])))
          fail(
            `${key} ${JSON.stringify(s[key])}, re-derived ${JSON.stringify(d[key])}`,
          );
    for (const cache of Object.keys(s.page_creates))
      firstCreate[cache.split("@")[0]] ??= s.step;
    const hand = (
      expected.hand_table as unknown as Record<
        string,
        { uploads: Record<string, string | number> }
      >
    )[String(s.step)]?.uploads;
    const got: Record<string, string | number> = {};
    for (const cache of new Set([
      ...Object.keys(s.page_creates),
      ...Object.keys(s.page_uploads),
    ])) {
      const cr = s.page_creates[cache] ?? 0;
      const up = s.page_uploads[cache] ?? 0;
      got[cache] = cr ? (up ? `c+${up}` : "c") : up;
    }
    if (!same(sortObj(got), sortObj(hand ?? {})))
      fail(
        `uploads ${JSON.stringify(got)}, hand table ${JSON.stringify(hand)}`,
      );
    if (expected.quiet_steps.includes(s.step) && Object.keys(got).length > 0)
      fail("a quiet step has page traffic");
  }
  if (!same(sortObj(firstCreate), sortObj(expected.fallback_first_steps)))
    problems.push(
      `first page creates ${JSON.stringify(firstCreate)}, fallback_first_steps ${JSON.stringify(expected.fallback_first_steps)}`,
    );
  const firsts = expected.fallback_order.map(
    (k) => expected.fallback_first_steps[k],
  );
  if (new Set(firsts).size !== firsts.length)
    problems.push("two fonts' scripts first appear at the same step");
  if (markers.size !== expected.steps.length)
    problems.push(
      `${markers.size} marker colours for ${expected.steps.length} steps`,
    );
  return checkOf(
    "expected-self-consistent-i18n",
    "fixtures/gate4-i18n/expected.json obeys its rules: 640x360, steps 0..9 at S+N*k (settle +7), fallback order OS, VZ, DV, HE, colours on the 0.2 grid with alpha 1 or 0.6, one marker colour per step, text regions disjoint, each inside one background and clear of the marker, the census (creates, uploads, new glyph units) re-derived in TypeScript from the texts by the same unit model equals the file's and its hand table, quiet steps silent, and each font's first page create at its own fallback_first_steps step",
    problems,
    `${expected.steps.length} steps, ${expected.text_nodes.length} text regions, census re-derived; first pages ${JSON.stringify(expected.fallback_first_steps)}`,
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// fixture-env-i18n
// ---------------------------------------------------------------------------------------------

export function evaluateI18nEnv(
  envs: Record<string, EnvJson | undefined>,
  lock: readonly FontLockEntry[],
): string[] {
  // G4a's evaluator pins "F"; this fixture's F is OS (with three fallbacks) and its fallbacks.
  const problems = evaluateFixtureEnv(envs, lock).filter(
    (p) => !p.startsWith("font F."),
  );
  const first = Object.values(envs)[0] as
    | (EnvJson & { fallback_order?: string[] })
    | undefined;
  const pins: Record<string, Record<string, unknown>> = {
    OS: { ...FONT_PINS.F, fallbacks: 3 },
    VZ: { ...FONT_PINS.F },
    DV: { ...FONT_PINS.F },
    HE: { ...FONT_PINS.F },
  };
  for (const [key, want] of Object.entries(pins)) {
    const font = first?.fonts?.[key];
    for (const [prop, v] of Object.entries(want))
      if (font?.[prop] !== v)
        problems.push(
          `font ${key}.${prop} = ${JSON.stringify(font?.[prop])}, pinned ${JSON.stringify(v)}`,
        );
  }
  if (!same(first?.fallback_order, ["VZ", "DV", "HE"]))
    problems.push(
      `OS's fallbacks ${JSON.stringify(first?.fallback_order)}, expected VZ, DV, HE`,
    );
  return problems;
}

// ---------------------------------------------------------------------------------------------
// oracle-agrees-i18n
// ---------------------------------------------------------------------------------------------

/** The font the fallback order must give a shaped glyph: ASCII OS, otherwise its cluster's
 * string font (null when its codepoint is unmapped), undefined when unconstrained (index 0:
 * zero-width and the paragraph's U+200B). */
function wantFontOf(
  model: I18nExpected["units_model"],
  text: string,
  g: I18nShaped,
): string | null | undefined {
  if (g.index === 0) return undefined;
  if (model.unmapped.includes(text)) return null;
  const cp = text.codePointAt(g.start);
  if (cp === undefined) return undefined;
  if (cp < 0x80) return "OS";
  const own = model.coverage[text];
  if (own) return own;
  const ch = String.fromCodePoint(cp);
  for (const [t, f] of Object.entries(model.coverage))
    if (t.includes(ch)) return f;
  return undefined;
}

export function evaluateI18nOracle(
  expected: I18nExpected,
  logs: readonly OracleLog[],
): string[] {
  const problems: string[] = [];
  const [log, ...others] = logs;
  if (!log) return ["no oracle log"];
  for (const l of logs)
    if (l.problem) problems.push(`${l.leg}: glyphs.jsonl ${l.problem}`);
  for (const o of others)
    if (o.text !== log.text)
      problems.push(`${o.leg}: glyphs.jsonl differs from ${log.leg}'s`);
  const drawn = new Map<string, Set<number>>();
  for (const s of expected.steps) {
    const line = lineAt(log, s.step);
    const fail = (t: string) => problems.push(`step ${s.step}: ${t}`);
    if (!line) {
      fail("no oracle line");
      continue;
    }
    if (line.frame !== s.settle_frame) fail(`oracle frame ${line.frame}`);
    const names = line.nodes.map((n) => n.name);
    if (names.join(",") !== expected.text_nodes.join(","))
      fail(`oracle nodes ${names.join(",")}`);
    for (const node of line.nodes) {
      const t = s.texts[node.name];
      if (!t) continue;
      if (node.text !== t.text)
        fail(`${node.name} text ${JSON.stringify(node.text)}`);
      if (node.font_key !== t.font_key || node.size !== t.size)
        fail(`${node.name} font ${node.font_key}@${node.size}`);
      if (!f32eq(node.colour, t.colour))
        fail(`${node.name} colour ${node.colour.join(",")}`);
      if (node.problems.length > 0)
        fail(`${node.name}: ${node.problems.join("; ")}`);
      if (node.lines !== 1 || node.lines_drawn !== 1)
        fail(`${node.name} draws ${node.lines_drawn} of ${node.lines} lines`);
      const want = s.glyph_commands[node.name];
      if (want !== null && want !== undefined && node.glyphs.length !== want)
        fail(
          `${node.name} ${node.glyphs.length} glyph commands, expected ${want}`,
        );
      const rects = node.commands.filter((c) => c.op === "add_rect").length;
      if (rects !== (s.hex_rects[node.name] ?? 0))
        fail(
          `${node.name} ${rects} hex-box add_rects, expected ${s.hex_rects[node.name] ?? 0}`,
        );
      if (
        node.commands.filter((c) => c.op === "add_texture_rect_region")
          .length !== node.glyphs.length
      )
        fail(`${node.name}'s commands do not list each glyph once`);
      for (const g of node.shaped) {
        const wantFont = wantFontOf(expected.units_model, node.text, g);
        if (wantFont !== undefined && g.font_key !== wantFont)
          fail(
            `${node.name} glyph ${g.index} of cluster [${g.start},${g.end}) from ${g.font_key}, the fallback order gives ${wantFont}`,
          );
      }
      for (const g of node.glyphs) {
        const cache = `${g.font_key}@${g.size}`;
        const set = drawn.get(cache) ?? new Set<number>();
        set.add(g.index);
        drawn.set(cache, set);
      }
    }
    const byCache = new Map<string, OraclePage[]>();
    for (const p of line.pages) {
      const cache = `${p.font_key}@${p.size}`;
      byCache.set(cache, [...(byCache.get(cache) ?? []), p]);
      const c = expected.caches[cache];
      if (
        !c ||
        p.outline !== 0 ||
        p.format !== c.format ||
        p.width !== c.width ||
        p.height !== c.height ||
        p.mipmaps !== c.mipmaps ||
        p.data_bytes !== c.data_bytes
      )
        fail(`page ${pageKeyOf(p)} is ${p.format} ${p.width}x${p.height}`);
    }
    const caches = [...byCache.keys()].sort();
    if (caches.join(",") !== Object.keys(s.page_counts).sort().join(","))
      fail(
        `oracle pages in ${caches.join(",")}, expected ${Object.keys(s.page_counts).sort().join(",")}`,
      );
    for (const [cache, n] of Object.entries(s.page_counts))
      if ((byCache.get(cache)?.length ?? 0) !== n)
        fail(
          `${cache} has ${byCache.get(cache)?.length ?? 0} pages, expected ${n}`,
        );
    for (const [cache, n] of Object.entries(s.page_glyphs))
      if ((drawn.get(cache)?.size ?? 0) !== n)
        fail(
          `${cache} drew ${drawn.get(cache)?.size ?? 0} distinct glyphs so far, expected ${n}`,
        );
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// glyph-commands-i18n
// ---------------------------------------------------------------------------------------------

/** One sink's settle transactions against the oracle's draw commands, in order: each texture glyph
 * as add_texture_rect_region (rect, src, modulate float32-exact, tex its page's wire id) and each
 * hex-box bar as add_rect (rect, colour float32-exact). */
export function evaluateI18nCommands(
  expected: I18nExpected,
  oracle: OracleLog,
  recording: RecordingSummary,
  mapping: ReadonlyMap<string, number>,
): { problems: string[]; commands: Record<string, number> } {
  const problems: string[] = [];
  const commands: Record<string, number> = {};
  const names = mapNames4(asGate4(expected), recording);
  problems.push(...names.problems);
  for (const s of expected.steps) {
    const line = lineAt(oracle, s.step);
    const tx = recording.transactions.find(
      (t) => t.meta.frame === s.settle_frame,
    );
    const fail = (t: string) => problems.push(`step ${s.step}: ${t}`);
    if (!line || !tx) {
      fail(`no ${line ? "settle transaction" : "oracle line"}`);
      continue;
    }
    let count = 0;
    for (const name of expected.creation_order) {
      const item = tx.meta.items.find((i) => i.id === names.byName.get(name));
      if (!item) {
        fail(`${name} is not in the settle transaction`);
        continue;
      }
      if (!expected.text_nodes.includes(name)) {
        const textured = item.commands.filter((c) => c.op !== "add_rect");
        if (textured.length > 0)
          fail(`${name} carries ${textured.length} texture commands`);
        continue;
      }
      const node = line.nodes.find((n) => n.name === name);
      const want = node?.commands ?? [];
      if (item.commands.length !== want.length) {
        fail(
          `${name} has ${item.commands.length} commands, the oracle ${want.length}`,
        );
        continue;
      }
      for (const [i, c] of item.commands.entries()) {
        const w = want[i];
        if (w.op === "add_rect") {
          if (
            c.op !== "add_rect" ||
            !f32eq(c.rect, w.rect) ||
            !f32eq(c.color, w.colour)
          )
            fail(
              `${name} command ${i}: ${c.op} ${c.rect?.join(",")} ${c.color?.join(",")}, oracle hex-box add_rect ${w.rect.join(",")}`,
            );
          continue;
        }
        count++;
        const g = node?.glyphs[w.glyph];
        if (!g) {
          fail(`${name} command ${i}: the oracle names no glyph ${w.glyph}`);
          continue;
        }
        const where = `${name} glyph ${w.glyph} (index ${g.index} ${g.font_key}, cluster [${g.start},${g.end}))`;
        if (c.op !== "add_texture_rect_region" || c.transpose || c.clip_uv)
          fail(
            `${where}: ${c.op} transpose ${c.transpose} clip_uv ${c.clip_uv}`,
          );
        if (!f32eq(c.rect, g.quad))
          fail(
            `${where}: rect ${c.rect?.join(",")}, oracle ${g.quad.join(",")}`,
          );
        if (!f32eq(c.src, g.uv))
          fail(`${where}: src ${c.src?.join(",")}, oracle ${g.uv.join(",")}`);
        if (!f32eq(c.modulate, g.colour))
          fail(`${where}: modulate ${c.modulate?.join(",")}`);
        const page = `${g.font_key}@${g.size}/0#${g.page}`;
        if (mapping.get(page) === undefined || c.tex !== mapping.get(page))
          fail(
            `${where}: tex ${c.tex}, page ${page} is wire id ${mapping.get(page) ?? "<unmapped>"}`,
          );
      }
    }
    commands[s.step] = count;
  }
  return { problems, commands };
}

// ---------------------------------------------------------------------------------------------
// fallback-pages
// ---------------------------------------------------------------------------------------------

export function evaluateFallbackPages(
  expected: I18nExpected,
  oracle: OracleLog,
  full: RecordingSummary,
  patch: RecordingSummary,
  hook: readonly HookLine[],
  mapping: ReadonlyMap<string, number>,
): { problems: string[]; rows: Record<string, unknown> } {
  const problems: string[] = [];
  const rows: Record<string, unknown> = {};
  for (const key of expected.fallback_order) {
    const first = expected.fallback_first_steps[key];
    const page = `${key}@16/0#0`;
    const id = mapping.get(page);
    const firstFrame = expected.steps[first]?.applied_frame;
    const pageSteps: number[] = [];
    const emptyCacheSteps: number[] = [];
    for (const s of expected.steps) {
      const line = lineAt(oracle, s.step);
      const has = !!line?.pages.some((p) => p.font_key === key);
      if (has) pageSteps.push(s.step);
      if (
        line?.caches.some(
          (c) => c.font_key === key && c.textures === 0 && c.glyphs === 0,
        )
      )
        emptyCacheSteps.push(s.step);
      if (has !== s.step >= first)
        problems.push(
          `step ${s.step}: the oracle ${has ? "lists" : "has no"} ${key} page; its script first appears at step ${first}`,
        );
    }
    if (id === undefined) {
      problems.push(`${key}'s page has no wire id`);
      continue;
    }
    const creates = hook.filter(
      (l) =>
        isEngineCall(l) &&
        l.omitted !== true &&
        l.op === "texture_2d_create" &&
        l.id === id,
    );
    if (creates.length !== 1 || creates[0].frame !== firstFrame)
      problems.push(
        `${key}'s page (wire id ${id}) created at frames ${creates.map((l) => l.frame).join(",") || "<none>"}, expected once at ${firstFrame}`,
      );
    for (const [sink, rec] of [
      ["full", full],
      ["patch", patch],
    ] as const) {
      const present = rec.transactions
        .filter((t) => t.meta.textures.some((e) => e.id === id))
        .map((t) => t.meta.frame);
      if (present[0] !== firstFrame)
        problems.push(
          `${sink}: wire id ${id} (${key}) first in the table at frame ${present[0] ?? "<never>"}, expected ${firstFrame}`,
        );
    }
    rows[key] = {
      first_step: first,
      first_frame: firstFrame,
      wire_id: id,
      oracle_page_steps: pageSteps,
      empty_cache_steps: emptyCacheSteps,
    };
  }
  return { problems, rows };
}

// ---------------------------------------------------------------------------------------------
// script-predictions
// ---------------------------------------------------------------------------------------------

export interface ScriptPredictionRow {
  id: string;
  steps: number[];
  oracle: string;
  capture: string;
  ok: boolean;
}

/** Q6e's hand predictions on the oracle line and on one sink's settle commands of every step
 * whose node shows the predicted text. Capture-side, the oracle's glyph <-> command order (which
 * glyph-commands-i18n proves) names the capture command of a shaped glyph. */
export function evaluateScriptPredictions(
  expected: I18nExpected,
  oracle: OracleLog,
  recording: RecordingSummary,
): { problems: string[]; rows: ScriptPredictionRow[] } {
  const problems: string[] = [];
  const rows: ScriptPredictionRow[] = [];
  const names = mapNames4(asGate4(expected), recording);
  for (const p of expected.script_predictions) {
    const steps = expected.steps
      .filter((s) => s.texts[p.node]?.text === p.text)
      .map((s) => s.step);
    const row: ScriptPredictionRow = {
      id: p.id,
      steps,
      oracle: "",
      capture: "",
      ok: true,
    };
    const fail = (step: number, side: string, t: string) => {
      row.ok = false;
      problems.push(`${p.id} step ${step} (${side}): ${t}`);
    };
    if (steps.length === 0) fail(-1, "expected", "no step shows the text");
    for (const step of steps) {
      const line = lineAt(oracle, step);
      const node = line?.nodes.find((n) => n.name === p.node);
      const s = expected.steps[step];
      const tx = recording.transactions.find(
        (t) => t.meta.frame === s.settle_frame,
      );
      const item = tx?.meta.items.find(
        (i) => i.id === names.byName.get(p.node),
      );
      if (!node || !item) {
        fail(step, "both", `no oracle node or capture item for ${p.node}`);
        continue;
      }
      const textured = item.commands.filter(
        (c) => c.op === "add_texture_rect_region",
      );
      const commandOf = (g: I18nShaped) =>
        g.command >= 0 ? textured[g.command] : undefined;
      const inCluster = (c: [number, number]) =>
        node.shaped.filter((g) => g.start === c[0] && g.end === c[1]);
      switch (p.id) {
        case "nfd-composition":
        case "lam-alef":
        case "niqqud-marks": {
          const cluster = p.cluster as [number, number];
          const gs = inCluster(cluster);
          if (gs.length !== p.glyphs)
            fail(
              step,
              "oracle",
              `cluster [${cluster}] has ${gs.length} glyphs, predicted ${p.glyphs}`,
            );
          if (
            p.cmap &&
            (gs[0]?.index !== line?.cmap[p.cmap] ||
              line?.cmap[p.cmap] === undefined)
          )
            fail(
              step,
              "oracle",
              `glyph ${gs[0]?.index}, cmap ${p.cmap} = ${line?.cmap[p.cmap]}`,
            );
          if (p.font && gs.some((g) => g.font_key !== p.font))
            fail(
              step,
              "oracle",
              `fonts ${gs.map((g) => g.font_key).join(",")}, predicted ${p.font}`,
            );
          if (
            p.spacing !== undefined &&
            gs.filter((g) => g.advance !== 0).length !== p.spacing
          )
            fail(
              step,
              "oracle",
              `${gs.filter((g) => g.advance !== 0).length} advancing glyphs, predicted ${p.spacing}`,
            );
          const cmds = gs.map(commandOf);
          if (cmds.some((c) => !c))
            fail(
              step,
              "capture",
              `cluster [${cluster}] lacks a texture command per glyph`,
            );
          for (const [i, g] of gs.entries()) {
            const q = node.glyphs[g.command]?.quad;
            if (q && !f32eq(cmds[i]?.rect, q))
              fail(
                step,
                "capture",
                `cluster glyph ${g.index} rect ${cmds[i]?.rect}, oracle ${q}`,
              );
          }
          if (p.id === "niqqud-marks") {
            // The marks' quads overlap the base's x extent (positioned over it).
            const base = gs.find((g) => g.advance !== 0);
            const bq = base ? commandOf(base)?.rect : undefined;
            for (const g of gs.filter((x) => x.advance === 0)) {
              const mq = commandOf(g)?.rect;
              if (
                !bq ||
                !mq ||
                mq[0] + mq[2] <= bq[0] ||
                mq[0] >= bq[0] + bq[2]
              )
                fail(
                  step,
                  "capture",
                  `mark ${g.index}'s quad ${mq} is not over its base's ${bq}`,
                );
            }
          }
          row.oracle = `${gs.length} glyph(s) [${gs.map((g) => `${g.index}${g.font_key ? `/${g.font_key}` : ""}`).join(" ")}] for ${cluster[1] - cluster[0]} codepoints`;
          row.capture = `${cmds.filter(Boolean).length} command(s) at the oracle's quads`;
          break;
        }
        case "zwnj-invisible": {
          const cluster = p.cluster as [number, number];
          const gs = inCluster(cluster);
          if (
            gs.length !== p.glyphs ||
            gs.some(
              (g) =>
                g.index !== 0 || g.advance !== p.advance || g.command !== -1,
            )
          )
            fail(
              step,
              "oracle",
              `cluster [${cluster}] ${JSON.stringify(gs.map((g) => [g.index, g.advance, g.command]))}`,
            );
          if (textured.length !== node.glyphs.length)
            fail(
              step,
              "capture",
              `${textured.length} texture commands, oracle ${node.glyphs.length} glyphs`,
            );
          row.oracle = `${gs.length} index-0 glyph, advance ${gs[0]?.advance}, no command`;
          row.capture = `${textured.length} texture commands for ${node.shaped.filter((g) => g.index !== 0).length} visible glyphs`;
          break;
        }
        case "devanagari-conjuncts": {
          const n = node.glyphs.length;
          if (
            !(n < (p.fewer_glyphs_than ?? 0)) ||
            node.shaped.some((g) => g.index !== 0 && g.font_key !== p.font)
          )
            fail(
              step,
              "oracle",
              `${n} glyphs for ${p.fewer_glyphs_than} codepoints`,
            );
          if (!(textured.length < (p.fewer_glyphs_than ?? 0)))
            fail(
              step,
              "capture",
              `${textured.length} texture commands for ${p.fewer_glyphs_than} codepoints`,
            );
          row.oracle = `${n} glyphs for ${p.fewer_glyphs_than} codepoints`;
          row.capture = `${textured.length} texture commands`;
          break;
        }
        case "i-matra-reorder": {
          const ka = line?.cmap[p.consonant ?? ""];
          const cluster = [0, (p.matra ?? [0, 0])[1]] as [number, number];
          const gs = inCluster(cluster);
          const kaGlyph = gs.find((g) => g.index === ka);
          const matra = gs.find((g) => g !== kaGlyph);
          const kq = kaGlyph ? node.glyphs[kaGlyph.command]?.quad : undefined;
          const mq = matra ? node.glyphs[matra.command]?.quad : undefined;
          if (
            !kq ||
            !mq ||
            !(mq[0] < kq[0]) ||
            gs.indexOf(matra!) > gs.indexOf(kaGlyph!)
          )
            fail(step, "oracle", `matra quad ${mq}, KA (${ka}) quad ${kq}`);
          const kc = kaGlyph ? commandOf(kaGlyph)?.rect : undefined;
          const mc = matra ? commandOf(matra)?.rect : undefined;
          if (!kc || !mc || !(mc[0] < kc[0]))
            fail(step, "capture", `matra rect ${mc}, KA rect ${kc}`);
          row.oracle = `matra x ${mq?.[0]} < KA x ${kq?.[0]} (visual order matra, KA)`;
          row.capture = `matra x ${mc?.[0]} < KA x ${kc?.[0]}`;
          break;
        }
        case "rtl-run": {
          const xs: number[] = [];
          const cs: number[] = [];
          for (const at of p.logical ?? []) {
            const g = node.shaped.find(
              (x) => x.start === at && x.end === at + 1,
            );
            if (!g || g.font_key !== p.font) {
              fail(step, "oracle", `no ${p.font} glyph for codepoint ${at}`);
              continue;
            }
            xs.push(node.glyphs[g.command]?.quad[0] ?? Number.NaN);
            cs.push(commandOf(g)?.rect?.[0] ?? Number.NaN);
          }
          const decreasing = (v: number[]) =>
            v.length > 1 && v.every((x, i) => i === 0 || x < v[i - 1]);
          if (!decreasing(xs)) fail(step, "oracle", `quad x ${xs.join(",")}`);
          if (!decreasing(cs)) fail(step, "capture", `rect x ${cs.join(",")}`);
          row.oracle = `quad x ${xs.join(" > ")} in logical order`;
          row.capture = `rect x ${cs.join(" > ")}`;
          break;
        }
        case "hex-box": {
          const g = node.shaped.find((x) => x.index === p.codepoint);
          if (
            !g ||
            g.font_key !== null ||
            g.hex_rects !== p.add_rects ||
            node.glyphs.length !== p.texture_commands
          )
            fail(
              step,
              "oracle",
              `glyph ${JSON.stringify(g)}; ${node.glyphs.length} texture glyphs`,
            );
          const rects = item.commands.filter((c) => c.op === "add_rect");
          if (
            textured.length !== p.texture_commands ||
            rects.length !== p.add_rects ||
            item.commands.length !== rects.length
          )
            fail(
              step,
              "capture",
              `${rects.length} add_rects and ${item.commands.length - rects.length} other commands`,
            );
          row.oracle = `no font, ${g?.hex_rects} add_rects, ${node.glyphs.length} texture glyphs`;
          row.capture = `${rects.length} add_rects, ${textured.length} texture commands`;
          break;
        }
        default:
          fail(step, "expected", `unknown prediction ${p.id}`);
      }
    }
    rows.push(row);
  }
  return { problems, rows };
}

// ---------------------------------------------------------------------------------------------
// expected-text-*-i18n (D8)
// ---------------------------------------------------------------------------------------------

/**
 * D8's ink for one node, its commands in draw order: each texture glyph (oracle quad x LA8 page
 * alpha x colour) and each hex-box add_rect (the colour over every pixel whose centre lies in the
 * half-open rect [x, x+w) x [y, y+h)), straight-alpha blended over the region's background.
 */
export function synthesizeI18nText(
  node: I18nNode,
  pages: ReadonlyMap<string, AtlasPageImage>,
  box: Box4,
  background: Rgba8,
): { frame: SynthesizedFrame; missingPages: string[] } {
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  const rgba = new Uint8Array(Math.max(0, width) * Math.max(0, height) * 4);
  for (let i = 0; i < width * height; i++) rgba.set(background, i * 4);
  const missingPages: string[] = [];
  const [xx, xy, yx, yy, ox, oy] = node.global_xform;
  const blend = (bx: number, by: number, colour: number[], a: number) => {
    if (bx < 0 || bx >= width || by < 0 || by >= height || a === 0) return;
    const idx = (by * width + bx) * 4;
    rgba[idx] = Math.round(colour[0] * 255 * a + rgba[idx] * (1 - a));
    rgba[idx + 1] = Math.round(colour[1] * 255 * a + rgba[idx + 1] * (1 - a));
    rgba[idx + 2] = Math.round(colour[2] * 255 * a + rgba[idx + 2] * (1 - a));
    rgba[idx + 3] = 255;
  };
  for (const c of node.commands) {
    if (c.op === "add_rect") {
      // Axis-aligned item transforms only (every Label here): pixel centres in the rect.
      const [rx, ry, rw, rh] = c.rect;
      const x0 = xx * rx + ox;
      const y0 = yy * ry + oy;
      for (let py = Math.ceil(y0 - 0.5); py + 0.5 < y0 + yy * rh; py++)
        for (let px = Math.ceil(x0 - 0.5); px + 0.5 < x0 + xx * rw; px++)
          blend(px - box[0], py - box[1], c.colour, c.colour[3]);
      continue;
    }
    const g = node.glyphs[c.glyph];
    const key = `${g.font_key}@${g.size}/${g.outline}#${g.page}`;
    const page = pages.get(key);
    if (!page) {
      if (!missingPages.includes(key)) missingPages.push(key);
      continue;
    }
    const [qx, qy, qw, qh] = g.quad;
    const [ux, uy] = g.uv;
    for (let ly = 0; ly < qh; ly++)
      for (let lx = 0; lx < qw; lx++) {
        const wx = Math.round(xx * (qx + lx) + yx * (qy + ly) + ox);
        const wy = Math.round(xy * (qx + lx) + yy * (qy + ly) + oy);
        const sx = Math.round(ux) + lx;
        const sy = Math.round(uy) + ly;
        if (sx < 0 || sx >= page.width || sy < 0 || sy >= page.height) continue;
        const a =
          (page.data[(sy * page.width + sx) * 2 + 1] / 255) * g.colour[3];
        blend(wx - box[0], wy - box[1], g.colour, a);
      }
  }
  return { frame: { width, height, rgba }, missingPages };
}

export function evaluateI18nText(
  expected: I18nExpected,
  oracle: OracleLog,
  bySha: ReadonlyMap<string, AtlasPageImage>,
  shots: ReadonlyMap<string, Frame | null>,
): {
  problems: string[];
  maxDelta: number;
  deltaPixels: number;
  perNode: Record<string, number>;
} {
  const problems: string[] = [];
  let maxDelta = 0;
  let deltaPixels = 0;
  const perNode: Record<string, number> = {};
  for (const s of expected.steps) {
    const line = lineAt(oracle, s.step);
    const frame = shots.get(`step-${s.step}.png`);
    if (!line || !frame) {
      problems.push(`step ${s.step}: no ${line ? "shot" : "oracle line"}`);
      continue;
    }
    const pages = new Map<string, AtlasPageImage>();
    for (const p of line.pages) {
      const img = bySha.get(p.sha256);
      if (img) pages.set(pageKeyOf(p), img);
    }
    for (const node of line.nodes) {
      const box = s.text_regions[node.name];
      const background = s.background[node.name];
      if (!box || !background) continue;
      const synth = synthesizeI18nText(node, pages, box, background);
      if (synth.missingPages.length > 0) {
        problems.push(
          `step ${s.step}: ${node.name}'s glyphs name unmapped page(s) ${synth.missingPages.join(",")}`,
        );
        continue;
      }
      const cmp = compareSynthesizedText(frame, box, synth.frame);
      maxDelta = Math.max(maxDelta, cmp.maxDelta);
      perNode[node.name] = Math.max(perNode[node.name] ?? 0, cmp.maxDelta);
      if (cmp.maxDelta >= 1) deltaPixels += cmp.mismatched;
      if (cmp.maxDelta > 1)
        problems.push(
          `step ${s.step}: ${node.name} max channel delta ${cmp.maxDelta} (budget 1), ${cmp.mismatched} px differ`,
        );
    }
  }
  return { problems, maxDelta, deltaPixels, perNode };
}

// ---------------------------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------------------------

export interface G4fResult {
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
  checkpoints: Gate4Checkpoint[];
  text: Record<string, TextStepReport>;
  parity: Record<string, ParityCell[]>;
  budgets: RegionBudget[];
  census: Record<string, LayoutCensusStep>;
  ink: Record<string, Record<string, number>>;
  scripts: ScriptPredictionRow[];
  fallback: Record<string, unknown>;
}

export interface G4fContext {
  expected: I18nExpected;
  lock: FontLockEntry[];
  receiverDir: string;
  /** absolute path to experiments/render-stream/fixtures/gate4-i18n */
  fixtureDir: string;
}

async function shotSeqsPresent(dir: string): Promise<number[]> {
  try {
    return (await readdir(join(dir, "shots")))
      .map((n) => /^seq-(\d+)\.png$/.exec(n)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);
  } catch {
    return [];
  }
}

export async function runG4f(
  outDir: string,
  ctx: G4fContext,
): Promise<G4fResult> {
  const root = join(outDir, G4F_DIR);
  const expected = ctx.expected;
  const g4 = asGate4(expected);
  const checks: Gate4Check[] = [checkI18nSelfConsistent(expected)];
  const legs: G4fResult["legs"] = {};

  // --- capture, reference legs (G4a's checks on this fixture) ---
  const capture = await evaluateCapture(root);
  const evidence = await loadCapture(
    root,
    "capture",
    "capture",
    G4F_CAPTURE_QUIT_FRAME,
  );
  const oracles = [
    await loadOracle(root, "reference"),
    await loadOracle(root, "reference-repeat"),
  ];
  const oracle = oracles[0];
  const reference = await loadShots(root, "reference", g4);
  const repeat = await loadShots(root, "reference-repeat", g4);
  const armed = await loadShots(root, "reference-armed", g4);

  const parityCheck = checkAtlasHashParity(
    g4,
    oracle,
    capture.full,
    capture.patch,
  );
  const mapping = parityCheck.mapping;
  const cmdFull = evaluateI18nCommands(expected, oracle, capture.full, mapping);
  const cmdPatch = evaluateI18nCommands(
    expected,
    oracle,
    capture.patch,
    mapping,
  );
  const census = layoutCensusFromLog(
    asLayout(expected),
    evidence.hook.lines,
    mapping,
    G4F_CAPTURE_QUIT_FRAME,
  );
  const censusProblems = evidence.hook.problem
    ? [`resources.jsonl ${evidence.hook.problem}`]
    : [];
  censusProblems.push(
    ...evaluateLayoutCensus(asLayout(expected), census, capture.full, mapping),
  );
  if (mapping.size === 0)
    censusProblems.push("no page mapping (atlas-hash-parity found none)");
  const fallback = evaluateFallbackPages(
    expected,
    oracle,
    capture.full,
    capture.patch,
    evidence.hook.lines,
    mapping,
  );
  const scriptsFull = evaluateScriptPredictions(expected, oracle, capture.full);
  const scriptsPatch = evaluateScriptPredictions(
    expected,
    oracle,
    capture.patch,
  );
  const image = evaluateExpectedImage(g4, "reference-i18n", reference);
  const inkExpected = {
    ...g4,
    steps: expected.steps.map((s) => ({ ...s, ink_glyphs: s.ink_min_glyphs })),
  } as Gate4Expected;
  const inkRef = evaluateInkPresence(inkExpected, reference);
  const repeatCmp = compareLegs(g4, reference, repeat);
  const armedCmp = compareLegs(g4, reference, armed);
  const armedResult = await readJson<CaptureResultJson>(
    join(root, "reference-armed", "evidence", "result.json"),
  );
  if (
    armedResult?.status !== "armed" ||
    armedResult?.stream?.status !== "closed"
  )
    armedCmp.problems.unshift(
      `reference-armed status=${armedResult?.status} stream=${armedResult?.stream?.status}`,
    );
  const envs: Record<string, EnvJson | undefined> = {};
  for (const leg of ["capture", "reference", "reference-repeat"])
    envs[leg] = await readJson<EnvJson>(join(root, leg, "env.json"));

  checks.push(
    tag(
      await checkCaptureArmed(root, {
        captureResult: capture.captureResult,
        recording: capture.full,
      }),
    ),
    tag(await checkHeadlessNoGpuGate0(root)),
    tag(checkRecordingsDecode(capture.full, capture.patch)),
    tag(checkPatchResolvesToFull(capture.full, capture.patch)),
    tag(await checkStepAlignment(root, g4, capture.full)),
    tag(checkNoDrawIndexTies(capture.full).check),
    tag((await checkStoreComplete([evidence])).check),
    tag(checkTextureVersionsCurrent([evidence])),
    checkOf(
      "fixture-env-i18n",
      "i18n env.json is identical across capture, reference and reference-repeat, names the Advanced TextServer, carries the sha256 of all four pinned fonts as fonts.lock.json pins them, D3's pins on OS (with its three fallbacks) and on VZ, DV and HE, OS's fallback order VZ, DV, HE, the default theme font's pins, the Q1e project settings, viewport oversampling 1.0 and tool locale en",
      evaluateI18nEnv(envs, ctx.lock),
      "identical across capture, reference, reference-repeat; OS -> VZ, DV, HE pinned",
      Object.keys(envs).map((l) => join(root, l, "env.json")),
    ),
    checkOf(
      "oracle-agrees-i18n",
      "the i18n oracle equals expected.json at every settle step: the visible Labels, texts, fonts, sizes and colours, one line each, the glyph commands where the model predicts them (OS strings and the bidi string), the hex-box add_rect counts, every shaped glyph drawn from the font the fallback order gives its codepoint, pages per cache (one 256x256 LA8 page each, a fallback's only from its first script on) and OS's distinct drawn glyphs; reference and reference-repeat wrote byte-identical logs",
      evaluateI18nOracle(expected, oracles),
      `${oracle.lines.length} oracle lines, identical across reference and reference-repeat`,
      oracles.map((o) => o.path),
    ),
    checkOf(
      "glyph-commands-i18n",
      "on both sinks' settle transactions every Label's commands equal the oracle's draw commands in visual order: each glyph as add_texture_rect_region with rect and src equal as float32, modulate the font colour and tex the wire id of its own font's page (OS, VZ, DV or HE), and each hex-box bar as add_rect with the oracle's rect and colour; the panel and the marker carry no texture command",
      [
        ...cmdFull.problems.slice(0, 10),
        ...cmdPatch.problems.slice(0, 10).map((p) => `patch: ${p}`),
      ],
      `${Object.values(cmdFull.commands).reduce((a, b) => a + b, 0)} glyph commands over ${expected.steps.length} settle transactions x 2 sinks equal the oracle (${Object.values(cmdFull.commands).join("/")})`,
      [oracle.path, capture.full.path, capture.patch.path],
    ),
    checkOf(
      "script-predictions",
      `Q6e's hand predictions hold on the oracle and on both sinks' settle commands at every step showing their text: ${expected.script_predictions.map((p) => `${p.id} (${p.claim})`).join("; ")}`,
      [
        ...scriptsFull.problems,
        ...scriptsPatch.problems.map((p) => `patch: ${p}`),
      ],
      scriptsFull.rows
        .map((r) => `${r.id}: ${r.oracle} | ${r.capture}`)
        .join("; "),
      [oracle.path, capture.full.path, capture.patch.path],
    ),
    checkOf(
      "fallback-pages",
      `each font's page appears only once its script appears (${JSON.stringify(expected.fallback_first_steps)}): absent from the oracle's pages before that step and present from it on, created exactly once in the hook log at that step's applied frame, and first in either sink's texture table in that frame's transaction`,
      fallback.problems,
      Object.entries(fallback.rows)
        .map(([k, r]) => {
          const row = r as { first_step: number; wire_id: number };
          return `${k}: step ${row.first_step}, wire id ${row.wire_id}`;
        })
        .join("; "),
      [oracle.path, evidence.hook.path, capture.full.path, capture.patch.path],
    ),
    tag(parityCheck.check),
    tag(
      await checkAtlasAppendOnly(
        g4,
        join(root, "capture"),
        capture.full,
        mapping,
      ),
    ),
    checkOf(
      "atlas-census-i18n",
      `from the hook log (windows [applied_k, applied_k+1) through quit ${G4F_CAPTURE_QUIT_FRAME}), page creates and updates per cache equal expected.json -- one per draw that puts new glyphs into a page, DV created by LD1's draw and updated by LD2's in one frame --, every texture call in the step's applied frame, last hook versions and settle wire versions as predicted, each page's wire format and side its cache's, quiet steps ${expected.quiet_steps.join(",")} silent, and the only other texture the 800x6 ColorPicker strip`,
      censusProblems,
      expected.steps
        .map(
          (s) =>
            `${s.step}:{${Object.entries(census[s.step]?.pages ?? {})
              .map(
                ([k, p]) =>
                  `${k} ${p.creates ? "c" : ""}${p.updates ? `u${p.updates}` : ""}`,
              )
              .join(" ")}}`,
        )
        .join(" "),
      [evidence.hook.path, capture.full.path],
    ),
    checkOf(
      "expected-image-reference-i18n",
      "every reference-i18n shot equals synthesizeGate4 exactly outside the text regions: the clear colour, the panel and the marker",
      image.problems,
      `${shotsOf(g4).length} reference shots exact outside the text regions`,
      [join(root, "reference", "shots")],
    ),
    checkOf(
      "ink-presence-reference-i18n",
      "in every reference-i18n settle shot each text region has at least 6 x ink_min_glyphs differing pixels (its spacing clusters) when it shows text and none otherwise, a region differs from the previous step's exactly when expected.json says fresh, and each early shot's text regions equal its step's settle shot",
      inkRef.problems,
      `ink in ${expected.text_nodes.length} regions x ${expected.steps.length} steps as expected; early shots settled`,
      [join(root, "reference", "shots")],
    ),
    checkOf(
      "reference-repeat-budget-i18n",
      "reference-i18n vs reference-i18n-repeat: identical everywhere at every shot (budget 0, D8)",
      repeatCmp.problems,
      `budget 0: ${repeatCmp.budgets.map((b) => `${b.region} ${b.max_channel_delta}`).join(", ")}`,
      [
        join(root, "reference", "shots"),
        join(root, "reference-repeat", "shots"),
      ],
    ),
    checkOf(
      "armed-transparent-i18n",
      "reference-i18n-armed (extension armed, stream on, oracle off) armed with its stream closed and equals reference-i18n exactly at every shot",
      armedCmp.problems,
      `${shotsOf(g4).length} armed shots byte-identical to the reference`,
      [join(root, "reference-armed", "shots")],
    ),
  );
  {
    const problems: string[] = [];
    for (const leg of [
      "import/fixture",
      "import/receiver",
      "reference",
      "reference-repeat",
      "reference-armed",
      "receiver-headless-trace",
    ]) {
      const code = await readExitCode(join(root, leg));
      if (code !== 0) problems.push(`${leg} exit ${code ?? "<none>"}`);
    }
    const fonts = await readTextOrUndefined(join(root, "import", "fonts.log"));
    for (const entry of ctx.lock)
      if (!fonts?.includes(`${entry.file} ok `))
        problems.push(`i18n/import/fonts.log does not record ${entry.file}`);
    checks.push(
      checkOf(
        "support-legs-exit-i18n",
        "all four fonts were provisioned for fixtures/gate4-i18n and its import, the receiver's import, reference-i18n, -repeat, -armed and the headless receiver trace exited 0",
        problems,
        "6 support legs exited 0; 4 fonts provisioned",
        [join(root, "import", "fonts.log")],
      ),
    );
  }
  checks.push(tag(checkCaptureLegClass(capture)));
  legs["capture-i18n"] = {
    group: "g4f",
    expected_class: capture.expected_class,
    result_class: capture.result_class,
    reasons: capture.reasons,
    harmless_ties: capture.harmless_ties,
    exit_code: capture.exit_code,
    artifacts: capture.artifacts,
  };
  for (const [leg, dir] of [
    ["reference-i18n", "reference"],
    ["reference-i18n-repeat", "reference-repeat"],
    ["reference-i18n-armed", "reference-armed"],
    ["receiver-i18n-headless-trace", "receiver-headless-trace"],
  ] as const)
    legs[leg] = {
      group: "g4f",
      expected_class: null,
      result_class: null,
      reasons: [],
      exit_code: await readExitCode(join(root, dir)),
      artifacts: [join(root, dir)],
    };

  // --- receivers (G4b's checks on this fixture) ---
  const seqs = receiverStepSeqs(g4, capture.full);
  const receiverLegs: ReceiverLegInfo[] = [];
  let checkpoints: Gate4Checkpoint[] = image.checkpoints;
  const receiverShots: Record<string, Map<string, Frame | null>> = {};
  for (const [leg, dir, rec] of [
    ["receiver-i18n", "receiver", capture.full],
    ["receiver-i18n-patch", "receiver-patch", capture.patch],
  ] as const) {
    const applied = await readJson<AppliedJson>(
      join(root, dir, "applied.json"),
    );
    const shots = await loadReceiverShots(root, dir, g4, seqs);
    receiverShots[leg] = shots;
    const cps = computeGate4Checkpoints(
      g4,
      join(root, "reference"),
      reference,
      join(root, dir),
      shots,
      seqs.settle,
    );
    const cls = classifyLeg({
      captureResult: capture.captureResult,
      recording: rec,
      receiver: {
        applied,
        requestedShotSeqs: [...seqs.settle.values(), ...seqs.early.values()],
        shotFiles: await shotSeqsPresent(join(root, dir)),
      },
      checkpoints: cps,
    });
    checks.push(
      checkLegClass(leg, cls, cps, { class: "success" }, [
        join(root, dir, "applied.json"),
      ]),
    );
    legs[leg] = {
      group: "g4f",
      expected_class: "success",
      result_class: cls.result_class,
      reasons: cls.reasons,
      harmless_ties: cls.harmless_ties,
      exit_code: await readExitCode(join(root, dir)),
      artifacts: [join(root, dir, "applied.json")],
    };
    receiverLegs.push({ leg, dir: join(root, dir), applied });
  }
  const traceApplied = await readJson<AppliedJson>(
    join(root, "receiver-headless-trace", "applied.json"),
  );
  receiverLegs.push({
    leg: "receiver-i18n-headless-trace",
    dir: join(root, "receiver-headless-trace"),
    applied: traceApplied,
  });
  const vsRef = compareLegs(g4, reference, receiverShots["receiver-i18n"]);
  const vsRefPatch = compareLegs(
    g4,
    reference,
    receiverShots["receiver-i18n-patch"],
  );
  const imageReceiver = evaluateExpectedImage(
    g4,
    "receiver-i18n",
    receiverShots["receiver-i18n"],
  );
  checkpoints = [...checkpoints, ...imageReceiver.checkpoints];
  const inkReceiver = evaluateInkPresence(
    inkExpected,
    receiverShots["receiver-i18n"],
  );
  const oracleDir = join(root, "reference", "oracle");
  const pages = await loadLayoutPages(oracleDir, oracle);
  const textRef = evaluateI18nText(expected, oracle, pages.bySha, reference);
  const textRecv = evaluateI18nText(
    expected,
    oracle,
    pages.bySha,
    receiverShots["receiver-i18n"],
  );
  const appliedFull = receiverLegs[0].applied;
  const appliedPatch = receiverLegs[1].applied;
  checks.push(
    checkOf(
      "receiver-vs-reference-i18n",
      "receiver-i18n and receiver-i18n-patch shots (re-keyed from wire seq to fixture step, early shots included) equal reference-i18n's exactly, full frame and every region",
      [
        ...vsRef.problems.map((p) => `receiver: ${p}`),
        ...vsRefPatch.problems.map((p) => `patch: ${p}`),
      ],
      `receiver ${vsRef.budgets.map((b) => `${b.region} ${b.max_channel_delta}`).join(", ")}`,
      [join(root, "receiver", "shots"), join(root, "receiver-patch", "shots")],
    ),
    checkOf(
      "expected-image-receiver-i18n",
      "every receiver-i18n shot equals synthesizeGate4 exactly outside the text regions",
      imageReceiver.problems,
      `${shotsOf(g4).length} receiver shots exact outside the text regions`,
      [join(root, "receiver", "shots")],
    ),
    checkOf(
      "expected-text-reference-i18n",
      "D8 on i18n: every command the oracle reports, in draw order -- each glyph's quad x its own font's LA8 page alpha x the font colour, each hex-box add_rect over the pixels whose centres it covers (half-open) -- straight-alpha blended over the region's background, against reference-i18n's settle shots inside every text region, budget maxChannelDelta 1",
      [...pages.problems, ...textRef.problems],
      `max channel delta ${textRef.maxDelta} (budget 1), ${textRef.deltaPixels} px at delta >= 1; per node ${JSON.stringify(textRef.perNode)}`,
      [oracleDir, join(root, "reference", "shots")],
    ),
    checkOf(
      "expected-text-receiver-i18n",
      "D8 on i18n as for the reference, against receiver-i18n's settle shots",
      [...pages.problems, ...textRecv.problems],
      `max channel delta ${textRecv.maxDelta} (budget 1), ${textRecv.deltaPixels} px at delta >= 1`,
      [oracleDir, join(root, "receiver", "shots")],
    ),
    checkOf(
      "ink-presence-receiver-i18n",
      "receiver-i18n's settle shots carry the reference's ink presence and freshness",
      inkReceiver.problems,
      `ink in ${expected.text_nodes.length} regions x ${expected.steps.length} steps as expected`,
      [join(root, "receiver", "shots")],
    ),
    checkOf(
      "resource-quiet-i18n",
      `the quiet steps (${expected.quiet_steps.join(",")}) fetch and upload nothing on either sink's receiver`,
      [
        ...evaluateResourceQuiet(g4, appliedFull, G4F_CAPTURE_QUIT_FRAME).map(
          (p) => `receiver: ${p}`,
        ),
        ...evaluateResourceQuiet(g4, appliedPatch, G4F_CAPTURE_QUIT_FRAME).map(
          (p) => `patch: ${p}`,
        ),
      ],
      `${expected.quiet_steps.length} quiet steps clean on both sinks`,
      [
        join(root, "receiver", "applied.json"),
        join(root, "receiver-patch", "applied.json"),
      ],
    ),
    tag(
      await checkReceiverNeverShapes(root, ctx.receiverDir, [
        "receiver-headless-trace",
      ]),
    ),
  );

  // --- sabotage-i18n-omit-atlas ---
  const prediction = (
    expected.predictions as Record<
      string,
      {
        steps: number[];
        regions?: Record<string, string[]>;
        atlas_hash_parity_fails?: Record<string, number[]>;
      }
    >
  )[G4F_SABOTAGE];
  {
    const capDir = join(root, "sabotage-omit-atlas", "capture");
    const recvDir = join(root, "sabotage-omit-atlas", "receiver");
    const sabResult = await readJson<CaptureResultJson>(
      join(capDir, "evidence", "result.json"),
    );
    const sabFull = await loadRecording(join(capDir, RECORDING_NAME));
    const sabSeqs = receiverStepSeqs(g4, sabFull);
    const sabShots = await loadReceiverShots(
      root,
      "sabotage-omit-atlas/receiver",
      g4,
      sabSeqs,
    );
    const sabApplied = await readJson<AppliedJson>(
      join(recvDir, "applied.json"),
    );
    const cps = computeGate4Checkpoints(
      g4,
      join(root, "reference"),
      reference,
      recvDir,
      sabShots,
      sabSeqs.settle,
    );
    const cls = classifyLeg({
      captureResult: sabResult,
      recording: sabFull,
      // The runner shoots only the settle seqs on a sabotage receiver (memory:
      // rs-g4b-receiver-checker-facts).
      receiver: {
        applied: sabApplied,
        requestedShotSeqs: [...sabSeqs.settle.values()],
        shotFiles: await shotSeqsPresent(recvDir),
      },
      checkpoints: cps,
    });
    checks.push(
      checkLegClass(
        G4F_SABOTAGE,
        cls,
        cps,
        { class: "pixel-mismatch", mismatchSteps: prediction?.steps ?? [] },
        [join(capDir, RECORDING_NAME), join(recvDir, "applied.json")],
      ),
    );
    const regionProblems: string[] = [];
    for (const cp of cps) {
      const want = prediction?.regions?.[String(cp.step)] ?? [];
      for (const r of cp.regions) {
        if (r.name === "panel") continue;
        const bad = r.mismatched_pixels === null || r.mismatched_pixels > 0;
        if (bad && !want.includes(r.name))
          regionProblems.push(
            `step ${cp.step}: region ${r.name} differs (${r.mismatched_pixels} px), predicted only {${want.join(",")}}`,
          );
        if (
          !bad &&
          expected.text_nodes.includes(r.name) &&
          want.includes(r.name)
        )
          regionProblems.push(
            `step ${cp.step}: region ${r.name} matches, predicted to differ`,
          );
      }
      if (cp.mismatched_pixels !== null) {
        let inPredicted = 0;
        for (const r of cp.regions)
          if (want.includes(r.name)) inPredicted += r.mismatched_pixels ?? 0;
        if (cp.mismatched_pixels !== inPredicted)
          regionProblems.push(
            `step ${cp.step}: ${cp.mismatched_pixels - inPredicted} differing pixels outside the predicted regions`,
          );
      }
    }
    checks.push(
      checkOf(
        `${G4F_SABOTAGE}-regions`,
        `on ${G4F_SABOTAGE}'s receiver every differing pixel lies in the predicted Devanagari regions (expected.json predictions: ${JSON.stringify(prediction?.regions ?? {})}) and each predicted region differs`,
        regionProblems,
        `mismatch confined to ${[...new Set(Object.values(prediction?.regions ?? {}).flat())].join(",")}`,
        [recvDir],
      ),
      {
        ...checkAtlasHashParitySabotage(
          G4F_SABOTAGE,
          g4,
          oracle,
          sabFull,
          prediction?.atlas_hash_parity_fails ?? {},
        ),
        id: `atlas-hash-parity-${G4F_SABOTAGE}`,
      },
    );
    legs[G4F_SABOTAGE] = {
      group: "g4f",
      expected_class: "pixel-mismatch",
      result_class: cls.result_class,
      reasons: cls.reasons,
      harmless_ties: cls.harmless_ties,
      exit_code: await readExitCode(recvDir),
      artifacts: [join(capDir, RECORDING_NAME), join(recvDir, "applied.json")],
    };
    receiverLegs.push({
      leg: `${G4F_SABOTAGE}-receiver`,
      dir: recvDir,
      applied: sabApplied,
    });
  }

  checks.push(
    tag(await checkReceiverConsumedStream(receiverLegs)),
    tag(
      await checkReceiverNeverLoadedFixture(root, {
        receiverProjectDir: ctx.receiverDir,
        fixtureProjectDir: ctx.fixtureDir,
        receiverLogs: receiverLegs.map((r) => join(r.dir, "stdout.log")),
      }),
    ),
    tag(
      await checkReceiverTypedClean(
        receiverLegs.map((r) => ({
          leg: r.leg,
          path: join(r.dir, "stdout.log"),
        })),
      ),
    ),
  );

  return {
    checks,
    legs,
    checkpoints,
    text: textReport(
      g4,
      capture.full,
      evidence.hook.lines,
      mapping,
      cmdFull.commands,
      G4F_CAPTURE_QUIT_FRAME,
    ),
    parity: parityCheck.table,
    budgets: repeatCmp.budgets,
    census,
    ink: inkRef.ink,
    scripts: scriptsFull.rows,
    fallback: fallback.rows,
  };
}
