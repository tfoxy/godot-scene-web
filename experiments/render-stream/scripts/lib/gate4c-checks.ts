// Gate 4c checks: the layout fixture (protocol/gate4-design.md "G4c", "Q6e").
//
// Group g4c runs fixtures/gate4-layout/ through G4a's and G4b's legs (capture, reference x3,
// receiver x2, a headless receiver trace) plus the LCD variant (capture-lcd, reference-lcd,
// receiver-lcd) and sabotage-layout-omit-atlas. Its evidence lives under <out>/layout/ in the same
// shape as G4a's under <out>/, so every G4a/G4b helper that takes an evidence root runs on it
// unchanged; this module adds what layout needs: multi-pass glyph commands (shadow, outline,
// text) with their own caches, oracle-derived page counts, a census with draw-time outline and
// subpixel uploads, page lifetime, clip rects, and synthesized ink with per-glyph colours and the
// Labels' clips. Check ids carry a "-layout" suffix (or name the leg) so that they never collide
// with g4a's and g4b's. Nothing here launches a process.
//
// Evidence layout under <out>/layout/ (see scripts/README.md "Gate 4"):
//   import/fonts.log, import/fixture/   provision-fonts.sh and editor --import of fixtures/gate4-layout
//   capture/                            leg capture-layout: 400 frames, both sinks, store, strace
//   reference/, reference-repeat/       legs reference-layout and reference-layout-repeat (oracle on)
//   reference-armed/                    leg reference-layout-armed (extension armed, oracle off)
//   receiver-headless-trace/            headless receiver under strace -e openat
//   receiver/, receiver-patch/          legs receiver-layout and receiver-layout-patch
//   sabotage-omit-atlas/{capture,receiver}   leg sabotage-layout-omit-atlas
//   lcd/{capture,reference,receiver}    legs capture-lcd, reference-lcd and receiver-lcd

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type ClipRect,
  type DeriveInput,
  deriveClipRects,
} from "./clip-derive";
import { readJson, readTextOrUndefined } from "./gate-minus1-checks";
import {
  type AppliedJson,
  type CaptureResultJson,
  type Checkpoint,
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
  type OracleNode,
  type OraclePage,
  pageKeyOf,
  type Rgba8,
  type SynthesizedFrame,
  stepOfFrame4,
} from "./gate4-expected";
import { decodeTexturePayload, payloadSha256 } from "./render-stream-2";

// ---------------------------------------------------------------------------------------------
// Contract constants and types
// ---------------------------------------------------------------------------------------------

/** The g4c evidence root, relative to the run's --out. */
export const G4C_DIR = "layout";
/** The main layout capture's quit frame (as G4a's: one transaction per frame, room for the /proc
 * maps/fd sample). */
export const G4C_CAPTURE_QUIT_FRAME = 400;
export const G4C_SABOTAGE = "sabotage-layout-omit-atlas";

/** D3 pins per layout font as env.json records them: F and DF as G4a's, FX differs from F only in
 * subpixel positioning auto (1), FL is F's twin (env.json is written before step 8's hinting
 * change). */
export function layoutFontPins(): Record<string, Record<string, unknown>> {
  return {
    FX: { ...FONT_PINS.F, subpixel_positioning: 1 },
    FL: { ...FONT_PINS.F },
  };
}

export interface LayoutGlyph {
  pass: "text" | "outline" | "shadow" | "shadow-outline";
  index: number;
  xshift: number;
  font_key: string;
  size: number;
  outline: number;
  x: number;
  y: number;
  quad: [number, number, number, number];
  uv: [number, number, number, number];
  page: number;
  colour: [number, number, number, number];
}

export interface LayoutNode extends Omit<OracleNode, "glyphs"> {
  box: [number, number];
  clip: boolean;
  lines_drawn: number;
  line_texts: string[];
  outline_size: number;
  glyphs: LayoutGlyph[];
}

export interface LayoutOracleLine extends Omit<OracleLine, "nodes"> {
  nodes: LayoutNode[];
}

export interface LayoutStep extends Gate4ExpectedStep {
  ink_min_glyphs: Record<string, number>;
  /** every glyph command per node: ink glyphs x passes */
  commands: Record<string, number>;
  /** word-wrap line texts, or the predicted line count */
  lines: Record<string, string[] | number>;
  subpixel_bounded: string[];
  frees: string[];
  clip_rects: Record<string, Box4>;
}

export interface LayoutExpected extends Omit<Gate4Expected, "steps"> {
  lifetime_step: number;
  caches: Record<
    string,
    {
      format: string;
      width: number;
      height: number;
      mipmaps: boolean;
      data_bytes: number;
      outline: number;
      subpixel: boolean;
    }
  >;
  subpixel_caches: string[];
  lcd: {
    name: string;
    font: string;
    size: number;
    pos: [number, number];
    region: Box4;
    background: string;
    background_rgba8: Rgba8;
    text: string;
    ink_glyphs: number;
    page: { format: string; width: number; height: number };
    op: string;
    reason: string;
    creation_order: string[];
  };
  steps: LayoutStep[];
}

/** The step list as G4a's helpers see it (structural: the layout steps are a superset). */
export function asGate4(expected: LayoutExpected): Gate4Expected {
  return expected as unknown as Gate4Expected;
}

const f32 = (v: number): number => Math.fround(v);
const f32eq = (a: readonly number[] | undefined, b: readonly number[]) =>
  !!a && a.length === b.length && a.every((v, i) => f32(v) === f32(b[i]));

/** "F@16" for a plain cache, "F@24/4" for an outline cache. */
export function layoutCacheKey(p: {
  font_key: string;
  size: number;
  outline: number;
}): string {
  return `${p.font_key}@${p.size}${p.outline ? `/${p.outline}` : ""}`;
}

/** A glyph's page key, as pageKeyOf names the oracle's pages. */
export function glyphPageKey(g: LayoutGlyph): string {
  return `${g.font_key}@${g.size}/${g.outline}#${g.page}`;
}

/** The cache key of a page key: "F@16/0#0" -> "F@16", "F@24/4#0" -> "F@24/4". */
export function cacheOfPageKey(page: string): string {
  const [cache] = page.split("#");
  return cache.endsWith("/0") ? cache.slice(0, -2) : cache;
}

/** A check from gate4-checks' `check`, its id suffixed for the layout group. */
function tag(c: Gate4Check | Gate0Check, suffix = "-layout"): Gate4Check {
  const status =
    "status" in c ? (c as Gate4Check).status : c.passed ? "pass" : "fail";
  return { ...c, id: `${c.id}${suffix}`, status };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------------------------
// expected-self-consistent-layout
// ---------------------------------------------------------------------------------------------

const LEVELS = new Set([0, 51, 102, 153, 204, 255]);

function overlaps(a: Box4, b: Box4): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** An independent TS re-derivation of make_expected.py's upload model (module docstring there):
 * step 0 shapes everything before drawing; later steps shape in their draws; a dirty plain page
 * uploads once at its first draw; each new outline glyph uploads its page at once; F@320 opens a
 * second page at the multi-page step. Subpixel caches count their creates only. */
export function deriveLayoutCensus(expected: LayoutExpected): {
  page_creates: Record<string, number>;
  page_uploads: Record<string, number>;
  new_glyphs: Record<string, string>;
}[] {
  const ink = (t: string) => [...t].filter((c) => !/\s/u.test(c));
  const glyphs = new Map<string, Set<string>>();
  const pages = new Map<string, { created: boolean; dirty: boolean }>();
  const out = [];
  let prev: LayoutStep | undefined;
  for (const s of expected.steps) {
    const creates: Record<string, number> = {};
    const uploads: Record<string, number> = {};
    const fresh: Record<string, string> = {};
    const plainOf = (n: string) => `${s.texts[n].font_key}@${s.texts[n].size}`;
    const upload = (cache: string, page: string) => {
      const p = pages.get(page) ?? { created: false, dirty: false };
      p.dirty = false;
      if (p.created) uploads[cache] = (uploads[cache] ?? 0) + 1;
      else {
        p.created = true;
        creates[cache] = (creates[cache] ?? 0) + 1;
      }
      pages.set(page, p);
    };
    const shape = (n: string) => {
      const cache = plainOf(n);
      const set = glyphs.get(cache) ?? new Set<string>();
      const added = ink(s.texts[n].text).filter(
        (c, i, all) => !set.has(c) && all.indexOf(c) === i,
      );
      if (added.length === 0) return;
      for (const c of added) set.add(c);
      glyphs.set(cache, set);
      fresh[cache] = (fresh[cache] ?? "") + added.join("");
      const twoPages =
        (s.page_counts[cache] ?? 1) > 1 && set.size > added.length;
      for (const i of twoPages ? [0, 1] : [0]) {
        const key = `${cache}/0#${i}`;
        const p = pages.get(key) ?? { created: false, dirty: false };
        p.dirty = true;
        pages.set(key, p);
      }
    };
    const draw = (n: string) => {
      const t = s.texts[n] as LayoutStep["texts"][string] & {
        outline_size?: number;
        shadow_colour?: number[];
      };
      const plain = plainOf(n);
      const seq: [string, string, boolean][] = [];
      for (const c of ink(t.text)) {
        if (t.shadow_colour) seq.push([plain, c, false]);
      }
      if (t.outline_size)
        for (const c of ink(t.text))
          seq.push([`${plain}/${t.outline_size}`, c, true]);
      for (const c of ink(t.text)) seq.push([plain, c, false]);
      for (const [cache, c, outline] of seq) {
        if (outline) {
          const set = glyphs.get(cache) ?? new Set<string>();
          if (set.has(c)) continue;
          set.add(c);
          glyphs.set(cache, set);
          fresh[cache] = (fresh[cache] ?? "") + c;
          upload(cache, `${cache}#0`);
          continue;
        }
        for (const [key, p] of pages)
          if (key.startsWith(`${cache}/0#`) && p.dirty) upload(cache, key);
      }
    };
    if (s.step === 0) {
      for (const n of s.draws) shape(n);
      for (const n of s.draws) draw(n);
    } else {
      for (const n of s.draws) {
        const was = prev?.texts[n];
        const t = s.texts[n];
        if (
          !was ||
          was.text !== t.text ||
          was.size !== t.size ||
          was.font_key !== t.font_key
        )
          shape(n);
        draw(n);
      }
    }
    for (const cache of expected.subpixel_caches) delete uploads[cache];
    out.push({
      page_creates: creates,
      page_uploads: uploads,
      new_glyphs: fresh,
    });
    prev = s;
  }
  return out;
}

export function checkLayoutSelfConsistent(
  expected: LayoutExpected,
): Gate4Check {
  const problems: string[] = [];
  if (expected.schema !== "render-stream-gate4-expected/1")
    problems.push(`schema=${JSON.stringify(expected.schema)}`);
  if (expected.fixture !== "gate4-layout")
    problems.push(`fixture=${JSON.stringify(expected.fixture)}`);
  const [w, h] = expected.viewport ?? [];
  if (w !== 640 || h !== 360) problems.push(`viewport ${w}x${h}`);
  const S = expected.start_frame_default;
  const N = expected.step_frames_default;
  const last = expected.last_step;
  if (expected.settle_offset !== 7) problems.push("settle_offset is not 7");
  if (expected.quit_frame_default !== S + N * last + 11)
    problems.push("quit_frame_default is not S+N*last+11");
  const onGrid = (v: number) => Math.abs(v * 5 - Math.round(v * 5)) < 1e-9;
  const markers = new Set<string>();
  const derived = deriveLayoutCensus(expected);
  const m = expected.regions.marker;
  const markerBox: Box4 = [m[0], m[1], m[0] + m[2], m[1] + m[3]];
  const p = expected.panel.rect;
  const panelBox: Box4 = [p[0], p[1], p[0] + p[2], p[1] + p[3]];
  for (const s of expected.steps) {
    const fail = (t: string) => problems.push(`step ${s.step}: ${t}`);
    if (
      s.applied_frame !== (s.step === 0 ? 1 : S + N * s.step) ||
      s.settle_frame !== S + N * s.step + 7
    )
      fail(`frames ${s.applied_frame}/${s.settle_frame}`);
    for (const [name, t] of Object.entries(s.texts)) {
      const colours = [
        t.colour,
        (t as { outline_colour?: number[] }).outline_colour,
        (t as { shadow_colour?: number[] }).shadow_colour,
      ].filter((c): c is number[] => !!c);
      for (const c of colours)
        if (!c.every(onGrid) || (c[3] !== 1 && c[3] !== 0.6))
          fail(`${name} colour ${c.join(",")} breaks the colour rule`);
    }
    if (
      !s.marker_rgba8.every((v) => LEVELS.has(v)) ||
      s.marker_rgba8[3] !== 255
    )
      fail("marker colour breaks the colour rule");
    markers.add(s.marker_rgba8.join(","));
    const regions = {
      ...s.text_regions,
      [expected.lcd.name]: expected.lcd.region,
    };
    const names = Object.keys(regions);
    for (let i = 0; i < names.length; i++) {
      const a = regions[names[i]];
      for (const b of names.slice(i + 1))
        if (overlaps(a, regions[b]))
          fail(`regions ${names[i]} and ${b} overlap`);
      const inPanel =
        a[0] >= panelBox[0] &&
        a[1] >= panelBox[1] &&
        a[2] <= panelBox[2] &&
        a[3] <= panelBox[3];
      const bg =
        names[i] === expected.lcd.name
          ? expected.lcd.background_rgba8
          : s.background[names[i]];
      if (!same(bg, inPanel ? expected.panel.rgba8 : expected.clear_rgba8))
        fail(`${names[i]} background ${bg?.join(",")} is not its region's`);
      if (!inPanel && overlaps(a, panelBox))
        fail(`${names[i]} straddles the panel`);
      if (overlaps(a, markerBox))
        fail(`${names[i]} overlaps the marker region`);
    }
    for (const [name, clip] of Object.entries(s.clip_rects))
      if (s.text_regions[name]?.[2] !== clip[2])
        fail(
          `${name}'s region does not end at its clip's right edge ${clip[2]}`,
        );
    if (!same(s.wire_versions, s.hook_versions))
      fail("wire_versions differ from hook_versions");
    const d = derived[s.step];
    for (const key of ["page_creates", "page_uploads", "new_glyphs"] as const)
      if (!same(sortObj(d[key]), sortObj(s[key])))
        fail(
          `${key} ${JSON.stringify(s[key])}, re-derived ${JSON.stringify(d[key])}`,
        );
    if (expected.quiet_steps.includes(s.step))
      if (
        Object.keys(s.page_uploads).length +
          Object.keys(s.page_creates).length +
          s.subpixel_bounded.length +
          s.frees.length >
        0
      )
        fail("a quiet step has page traffic");
  }
  if (markers.size !== expected.steps.length)
    problems.push(
      `${markers.size} marker colours for ${expected.steps.length} steps`,
    );
  return checkOf(
    "expected-self-consistent-layout",
    "fixtures/gate4-layout/expected.json obeys its rules: 640x360, steps 0..9 at S+N*k (settle +7), colours on the 0.2 grid with alpha 1 or 0.6, one marker colour per step, text regions (and the LCD variant's) disjoint, each inside one background and clear of the marker, the clipped Labels' regions ending at their clips' right edges, and the census (creates, plain and outline uploads, new glyphs) re-derived in TypeScript from the texts and draws by the same model equals the file's",
    problems,
    `${expected.steps.length} steps, ${expected.text_nodes.length} text regions + ${expected.lcd.name}, census re-derived`,
    [],
  );
}

function sortObj(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

// ---------------------------------------------------------------------------------------------
// fixture-env-layout
// ---------------------------------------------------------------------------------------------

export function evaluateLayoutEnv(
  envs: Record<string, EnvJson | undefined>,
  lock: readonly FontLockEntry[],
): string[] {
  const problems = evaluateFixtureEnv(envs, lock);
  const first = Object.values(envs)[0];
  for (const [key, pins] of Object.entries(layoutFontPins())) {
    const font = first?.fonts?.[key];
    for (const [prop, want] of Object.entries(pins))
      if (font?.[prop] !== want)
        problems.push(
          `font ${key}.${prop} = ${JSON.stringify(font?.[prop])}, pinned ${JSON.stringify(want)}`,
        );
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// oracle-agrees-layout
// ---------------------------------------------------------------------------------------------

export function evaluateLayoutOracle(
  expected: LayoutExpected,
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
    const line = log.lines.find((l) => l.step === s.step) as
      | LayoutOracleLine
      | undefined;
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
        fail(
          `${node.name} font ${node.font_key}@${node.size}, expected ${t.font_key}@${t.size}`,
        );
      if (!f32eq(node.colour, t.colour))
        fail(`${node.name} colour ${node.colour.join(",")}`);
      const textGlyphs = node.glyphs.filter((g) => g.pass === "text");
      if (textGlyphs.length !== s.ink_glyphs[node.name])
        fail(
          `${node.name} ${textGlyphs.length} text glyphs, expected ${s.ink_glyphs[node.name]}`,
        );
      if (node.glyphs.length !== s.commands[node.name])
        fail(
          `${node.name} ${node.glyphs.length} glyph commands, expected ${s.commands[node.name]}`,
        );
      const want = s.lines[node.name];
      if (
        Array.isArray(want) ? !same(node.line_texts, want) : node.lines !== want
      )
        fail(
          `${node.name} lines ${JSON.stringify(node.line_texts)}, expected ${JSON.stringify(want)}`,
        );
      if (node.lines_drawn !== node.lines)
        fail(`${node.name} draws ${node.lines_drawn} of ${node.lines} lines`);
      if (node.clip !== !!(t as { clip?: boolean }).clip)
        fail(`${node.name} clip ${node.clip}`);
      for (const g of node.glyphs) {
        const cache = layoutCacheKey(g);
        const set = drawn.get(cache) ?? new Set<number>();
        set.add(g.index);
        drawn.set(cache, set);
        const wantOutline =
          g.pass === "outline"
            ? (t as { outline_size?: number }).outline_size
            : 0;
        if (g.outline !== wantOutline)
          fail(`${node.name} ${g.pass} glyph in outline ${g.outline}`);
      }
    }
    const byCache = new Map<string, OraclePage[]>();
    for (const p of line.pages) {
      const cache = layoutCacheKey(p);
      byCache.set(cache, [...(byCache.get(cache) ?? []), p]);
      const c = expected.caches[cache];
      if (
        !c ||
        p.format !== c.format ||
        p.width !== c.width ||
        p.height !== c.height ||
        p.mipmaps !== c.mipmaps ||
        p.data_bytes !== c.data_bytes
      )
        fail(
          `page ${pageKeyOf(p)} is ${p.format} ${p.width}x${p.height}, expected ${JSON.stringify(c)}`,
        );
    }
    const caches = [...byCache.keys()].sort();
    if (caches.join(",") !== Object.keys(s.page_counts).sort().join(","))
      fail(
        `oracle caches ${caches.join(",")}, expected ${Object.keys(s.page_counts).sort().join(",")}`,
      );
    for (const [cache, n] of Object.entries(s.page_counts)) {
      if ((byCache.get(cache)?.length ?? 0) !== n)
        fail(
          `${cache} has ${byCache.get(cache)?.length ?? 0} pages, expected ${n}`,
        );
      if ((drawn.get(cache)?.size ?? 0) !== s.page_glyphs[cache])
        fail(
          `${cache} drew ${drawn.get(cache)?.size ?? 0} distinct glyphs so far, expected ${s.page_glyphs[cache]}`,
        );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// glyph-commands-layout
// ---------------------------------------------------------------------------------------------

export function evaluateLayoutGlyphCommands(
  expected: LayoutExpected,
  oracle: OracleLog,
  recording: RecordingSummary,
  mapping: ReadonlyMap<string, number>,
): { problems: string[]; commands: Record<string, number> } {
  const problems: string[] = [];
  const commands: Record<string, number> = {};
  const names = mapNames4(asGate4(expected), recording);
  problems.push(...names.problems);
  for (const s of expected.steps) {
    const line = oracle.lines.find((l) => l.step === s.step) as
      | LayoutOracleLine
      | undefined;
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
      const textured = item.commands.filter((c) => c.op !== "add_rect");
      if (!expected.text_nodes.includes(name)) {
        if (textured.length > 0)
          fail(`${name} carries ${textured.length} texture commands`);
        continue;
      }
      if (item.commands.length !== textured.length)
        fail(`${name} carries a non-texture command`);
      const glyphs = line.nodes.find((n) => n.name === name)?.glyphs ?? [];
      if (textured.length !== glyphs.length) {
        fail(
          `${name} has ${textured.length} glyph commands, the oracle ${glyphs.length}`,
        );
        continue;
      }
      count += textured.length;
      for (const [i, c] of textured.entries()) {
        const g = glyphs[i];
        const where = `${name} ${g.pass} glyph ${i} (index ${g.index}, shift ${g.xshift})`;
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
          fail(
            `${where}: modulate ${c.modulate?.join(",")}, oracle ${g.colour.join(",")}`,
          );
        const page = glyphPageKey(g);
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
// atlas-census-layout, atlas-pages, subpixel-census, page-lifetime
// ---------------------------------------------------------------------------------------------

const TEXTURE_OPS = ["texture_2d_create", "texture_2d_update", "free"];

export interface LayoutCensusStep {
  pages: Record<
    string,
    {
      creates: number;
      updates: number;
      frees: number;
      frames: number[];
      versions: number[];
    }
  >;
  texture_lines: number;
  engine: {
    frame: number;
    op: string;
    format: string | null;
    width: number | null;
    height: number | null;
  }[];
}

/** The hook log's texture lines per step window, by page key through `pageIds`. */
export function layoutCensusFromLog(
  expected: LayoutExpected,
  lines: readonly HookLine[],
  pageIds: ReadonlyMap<string, number>,
  quit: number,
): Record<string, LayoutCensusStep> {
  const keyOfId = new Map<number, string>();
  for (const [page, id] of pageIds) keyOfId.set(id, page);
  const out: Record<string, LayoutCensusStep> = {};
  for (const s of expected.steps)
    out[s.step] = { pages: {}, texture_lines: 0, engine: [] };
  for (const l of lines) {
    if (!isEngineCall(l) || l.omitted === true || !TEXTURE_OPS.includes(l.op))
      continue;
    const step = stepOfFrame4(asGate4(expected), l.frame, quit);
    if (step < 0) continue;
    const bucket = out[step];
    bucket.texture_lines++;
    const key = l.id === null ? undefined : keyOfId.get(l.id);
    if (!key) {
      bucket.engine.push({
        frame: l.frame,
        op: l.op,
        format: l.format,
        width: l.width,
        height: l.height,
      });
      continue;
    }
    const p = bucket.pages[key] ?? {
      creates: 0,
      updates: 0,
      frees: 0,
      frames: [],
      versions: [],
    };
    bucket.pages[key] = p;
    if (l.op === "texture_2d_create") p.creates++;
    else if (l.op === "texture_2d_update") p.updates++;
    else p.frees++;
    if (!p.frames.includes(l.frame)) p.frames.push(l.frame);
    if (l.op !== "free" && l.version !== null) p.versions.push(l.version);
  }
  return out;
}

export function evaluateLayoutCensus(
  expected: LayoutExpected,
  census: Record<string, LayoutCensusStep>,
  recording: RecordingSummary,
  pageIds: ReadonlyMap<string, number>,
): string[] {
  const problems: string[] = [];
  const engineGot: string[] = [];
  for (const s of expected.steps) {
    const c = census[s.step];
    const fail = (t: string) => problems.push(`step ${s.step}: ${t}`);
    if (!c) {
      fail("no census window");
      continue;
    }
    for (const e of c.engine) engineGot.push(JSON.stringify(e));
    const byCache = new Map<
      string,
      { creates: number; updates: number; frees: number }
    >();
    for (const [page, p] of Object.entries(c.pages)) {
      const cache = cacheOfPageKey(page);
      const b = byCache.get(cache) ?? { creates: 0, updates: 0, frees: 0 };
      b.creates += p.creates;
      b.updates += p.updates;
      b.frees += p.frees;
      byCache.set(cache, b);
      if (p.frames.some((f) => f !== s.applied_frame))
        fail(
          `${page}: texture calls at frames ${p.frames.join(",")}, expected all at ${s.applied_frame}`,
        );
      const want = s.hook_versions[page];
      if (
        want !== undefined &&
        p.versions.length > 0 &&
        p.versions.at(-1) !== want
      )
        fail(
          `${page}: last hook version ${p.versions.at(-1)}, expected ${want}`,
        );
    }
    const caches = new Set([
      ...byCache.keys(),
      ...Object.keys(s.page_creates),
      ...Object.keys(s.page_uploads),
      ...s.frees,
      ...s.subpixel_bounded,
    ]);
    for (const cache of caches) {
      const got = byCache.get(cache) ?? { creates: 0, updates: 0, frees: 0 };
      const wantCreates = s.page_creates[cache] ?? 0;
      const wantFrees = s.frees.includes(cache) ? 1 : 0;
      if (got.creates !== wantCreates || got.frees !== wantFrees)
        fail(
          `${cache}: ${got.creates} creates and ${got.frees} frees, expected ${wantCreates} and ${wantFrees}`,
        );
      if (expected.subpixel_caches.includes(cache)) {
        const any = s.subpixel_bounded.includes(cache);
        if (any !== got.creates + got.updates > 0)
          fail(
            `${cache}: ${got.creates + got.updates} uploads, expected ${any ? "some" : "none"} (subpixel)`,
          );
      } else if (got.updates !== (s.page_uploads[cache] ?? 0))
        fail(
          `${cache}: ${got.updates} updates, expected ${s.page_uploads[cache] ?? 0}`,
        );
    }
    if (expected.quiet_steps.includes(s.step) && c.texture_lines > 0)
      fail(`${c.texture_lines} texture lines in a quiet step's window`);
    const tx = recording.transactions.find(
      (t) => t.meta.frame === s.settle_frame,
    );
    for (const [page, want] of Object.entries(s.wire_versions)) {
      const id = pageIds.get(page);
      const e = tx?.meta.textures.find((x) => x.id === id);
      if (e?.version !== want)
        fail(
          `${page} (wire id ${id ?? "?"}) is v${e?.version ?? "<absent>"} on the wire, expected v${want}`,
        );
    }
    for (const [page, id] of pageIds) {
      const e = tx?.meta.textures.find((x) => x.id === id);
      const cache = expected.caches[cacheOfPageKey(page)];
      if (!e || !cache) continue;
      if (
        e.format !== cache.format ||
        e.width !== cache.width ||
        e.height !== cache.height ||
        e.mipmaps !== cache.mipmaps
      )
        fail(`${page} is ${e.format} ${e.width}x${e.height} on the wire`);
    }
  }
  const engineWant = expected.engine_textures.map((e) => JSON.stringify(e));
  if (!same(engineGot.sort(), [...engineWant].sort()))
    problems.push(
      `engine textures ${engineGot.join(" ")}, expected ${engineWant.join(" ")}`,
    );
  return problems;
}

/** Per step, the (glyph, x shift) pairs of a subpixel cache that no earlier step drew, counting
 * the unshifted variant shaping rasterizes for every glyph (ts_adv:6870-6872). */
export function newSubpixelPairs(
  expected: LayoutExpected,
  oracle: OracleLog,
  cache: string,
): Record<string, number> {
  const seen = new Set<string>();
  const out: Record<string, number> = {};
  for (const s of expected.steps) {
    const line = oracle.lines.find((l) => l.step === s.step) as
      | LayoutOracleLine
      | undefined;
    let n = 0;
    for (const node of line?.nodes ?? [])
      for (const g of node.glyphs) {
        if (layoutCacheKey(g) !== cache) continue;
        for (const pair of [`${g.index}:0`, `${g.index}:${g.xshift}`])
          if (!seen.has(pair)) {
            seen.add(pair);
            n++;
          }
      }
    out[s.step] = n;
  }
  return out;
}

export function evaluateSubpixelCensus(
  expected: LayoutExpected,
  census: Record<string, LayoutCensusStep>,
  oracle: OracleLog,
): {
  problems: string[];
  rows: Record<
    string,
    Record<string, { uploads: number; new_pairs: number; shifts: number[] }>
  >;
} {
  const problems: string[] = [];
  const rows: Record<
    string,
    Record<string, { uploads: number; new_pairs: number; shifts: number[] }>
  > = {};
  for (const cache of expected.subpixel_caches) {
    const pairs = newSubpixelPairs(expected, oracle, cache);
    rows[cache] = {};
    for (const s of expected.steps) {
      let uploads = 0;
      for (const [page, p] of Object.entries(census[s.step]?.pages ?? {}))
        if (cacheOfPageKey(page) === cache) uploads += p.creates + p.updates;
      const line = oracle.lines.find((l) => l.step === s.step) as
        | LayoutOracleLine
        | undefined;
      const shifts = new Set<number>();
      for (const node of line?.nodes ?? [])
        for (const g of node.glyphs)
          if (layoutCacheKey(g) === cache) shifts.add(g.xshift);
      rows[cache][s.step] = {
        uploads,
        new_pairs: pairs[s.step],
        shifts: [...shifts].sort(),
      };
      if (uploads > pairs[s.step])
        problems.push(
          `step ${s.step}: ${cache} ${uploads} uploads > ${pairs[s.step]} new (glyph, shift) pairs`,
        );
      if (pairs[s.step] > 0 && uploads < 1)
        problems.push(
          `step ${s.step}: ${cache} has ${pairs[s.step]} new pairs but no upload`,
        );
    }
    const all = new Set(Object.values(rows[cache]).flatMap((r) => r.shifts));
    if (all.size < 2)
      problems.push(
        `${cache}: the oracle's glyphs use x shifts {${[...all].join(",")}} only`,
      );
  }
  return { problems, rows };
}

export function evaluatePageLifetime(
  expected: LayoutExpected,
  census: Record<string, LayoutCensusStep>,
  full: RecordingSummary,
  patch: RecordingSummary,
  pageIds: ReadonlyMap<string, number>,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const k = expected.lifetime_step;
  const s = expected.steps[k];
  const [freedCache] = s.frees;
  const created = Object.keys(s.page_creates)[0];
  const oldId = pageIds.get(`${freedCache}/0#0`);
  const newId = pageIds.get(`${created}/0#0`);
  if (oldId === undefined || newId === undefined || oldId === newId)
    problems.push(
      `page ids ${freedCache}=${oldId ?? "?"} ${created}=${newId ?? "?"}`,
    );
  const c = census[k];
  const oldLine = c?.pages[`${freedCache}/0#0`];
  const newLine = c?.pages[`${created}/0#0`];
  if (oldLine?.frees !== 1 || oldLine.frames.join() !== String(s.applied_frame))
    problems.push(
      `${freedCache}'s page has no single free at frame ${s.applied_frame}: ${JSON.stringify(oldLine)}`,
    );
  if (
    newLine?.creates !== 1 ||
    newLine.frames.join() !== String(s.applied_frame)
  )
    problems.push(
      `${created}'s page has no single create at frame ${s.applied_frame}: ${JSON.stringify(newLine)}`,
    );
  for (const [sink, rec] of [
    ["full", full],
    ["patch", patch],
  ] as const) {
    const before = rec.transactions.find(
      (t) => t.meta.frame === s.applied_frame - 1,
    );
    const at = rec.transactions.find((t) => t.meta.frame === s.applied_frame);
    if (!before?.meta.textures.some((e) => e.id === oldId && e.status === "ok"))
      problems.push(
        `${sink}: wire id ${oldId} is not an ok entry at frame ${s.applied_frame - 1}`,
      );
    if (at?.meta.textures.some((e) => e.id === oldId))
      problems.push(
        `${sink}: wire id ${oldId} is still in the table at frame ${s.applied_frame}`,
      );
    if (before?.meta.textures.some((e) => e.id === newId))
      problems.push(
        `${sink}: wire id ${newId} exists before frame ${s.applied_frame}`,
      );
    if (
      !at?.meta.textures.some(
        (e) => e.id === newId && e.status === "ok" && e.version === 1,
      )
    )
      problems.push(
        `${sink}: wire id ${newId} is not created (ok, v1) at frame ${s.applied_frame}`,
      );
    for (const t of rec.transactions)
      if (t.meta.frame >= s.applied_frame)
        for (const item of t.meta.items)
          for (const cmd of item.commands)
            if (cmd.tex === oldId)
              problems.push(
                `${sink}: frame ${t.meta.frame} still draws wire id ${oldId}`,
              );
  }
  return {
    problems: problems.slice(0, 12),
    detail: `step ${k} (frame ${s.applied_frame}): ${freedCache} page wire id ${oldId} freed and gone from the table, ${created} page wire id ${newId} created, in one frame`,
  };
}

// ---------------------------------------------------------------------------------------------
// clip-rects-derived-layout
// ---------------------------------------------------------------------------------------------

export function evaluateLayoutClips(
  expected: LayoutExpected,
  recording: RecordingSummary,
): {
  problems: string[];
  table: Record<string, Record<string, ClipRect | null | string>>;
} {
  const problems: string[] = [];
  const table: Record<string, Record<string, ClipRect | null | string>> = {};
  const names = mapNames4(asGate4(expected), recording);
  problems.push(...names.problems);
  const mask = Number(
    recording.session?.viewport?.canvas_cull_mask ?? 0xffffffff,
  );
  for (const s of expected.steps) {
    const tx = recording.transactions.find(
      (t) => t.meta.frame === s.settle_frame,
    );
    if (!tx) {
      problems.push(`step ${s.step}: no settle transaction`);
      continue;
    }
    const derived = deriveClipRects(tx.meta as DeriveInput, expected.viewport, {
      cullMask: mask,
    });
    table[s.step] = {};
    for (const name of expected.text_nodes) {
      const id = names.byName.get(name);
      const e = id === undefined ? undefined : derived.get(id);
      const want = s.clip_rects[name] ?? null;
      let got: ClipRect | null | string;
      if (e === undefined || typeof e === "string") got = e ?? "absent";
      else got = e.owner === id ? e.rect : null;
      if (want !== null || got !== null) table[s.step][name] = got;
      if (!same(got, want))
        problems.push(
          `step ${s.step}: ${name} derives ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        );
    }
  }
  return { problems, table };
}

// ---------------------------------------------------------------------------------------------
// expected-text-*-layout (D8)
// ---------------------------------------------------------------------------------------------

/** Every distinct page of the oracle log, decoded (LA8) and hash-verified, by sha256. */
export async function loadLayoutPages(
  oracleDir: string,
  oracle: OracleLog,
): Promise<{ bySha: Map<string, AtlasPageImage>; problems: string[] }> {
  const bySha = new Map<string, AtlasPageImage>();
  const problems: string[] = [];
  for (const line of oracle.lines)
    for (const p of line.pages) {
      if (bySha.has(p.sha256)) continue;
      try {
        const bytes = new Uint8Array(
          await readFile(join(oracleDir, "pages", `${p.sha256}.grt`)),
        );
        if (payloadSha256(bytes) !== p.sha256)
          throw new Error("bytes do not hash to their name");
        const d = decodeTexturePayload(bytes);
        if (d.format !== "LA8") throw new Error(`format ${d.format}`);
        bySha.set(p.sha256, { width: d.width, height: d.height, data: d.data });
      } catch (e) {
        problems.push(
          `step ${line.step} ${pageKeyOf(p)}: ${(e as Error).message}`,
        );
      }
    }
  return { bySha, problems };
}

/**
 * D8's ink for one layout node: every glyph command (shadow, outline, text, in draw order) with
 * its own colour and its own page (outline pages included), straight-alpha blended over the
 * region's background, and limited to the node's clip box when it clips (root-canvas pixels).
 */
export function synthesizeLayoutText(
  node: LayoutNode,
  pages: ReadonlyMap<string, AtlasPageImage>,
  box: Box4,
  background: Rgba8,
  clip: Box4 | null,
): { frame: SynthesizedFrame; missingPages: string[] } {
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  const rgba = new Uint8Array(Math.max(0, width) * Math.max(0, height) * 4);
  for (let i = 0; i < width * height; i++) rgba.set(background, i * 4);
  const missingPages: string[] = [];
  const [xx, xy, yx, yy, ox, oy] = node.global_xform;
  for (const g of node.glyphs) {
    const key = glyphPageKey(g);
    const page = pages.get(key);
    if (!page) {
      if (!missingPages.includes(key)) missingPages.push(key);
      continue;
    }
    const [qx, qy, qw, qh] = g.quad;
    const [ux, uy] = g.uv;
    const [cr, cg, cb, ca] = g.colour;
    for (let ly = 0; ly < qh; ly++)
      for (let lx = 0; lx < qw; lx++) {
        const wx = Math.round(xx * (qx + lx) + yx * (qy + ly) + ox);
        const wy = Math.round(xy * (qx + lx) + yy * (qy + ly) + oy);
        if (
          clip &&
          (wx < clip[0] || wx >= clip[2] || wy < clip[1] || wy >= clip[3])
        )
          continue;
        const bx = wx - box[0];
        const by = wy - box[1];
        if (bx < 0 || bx >= width || by < 0 || by >= height) continue;
        const sx = Math.round(ux) + lx;
        const sy = Math.round(uy) + ly;
        if (sx < 0 || sx >= page.width || sy < 0 || sy >= page.height) continue;
        const a = (page.data[(sy * page.width + sx) * 2 + 1] / 255) * ca;
        if (a === 0) continue;
        const idx = (by * width + bx) * 4;
        rgba[idx] = Math.round(cr * 255 * a + rgba[idx] * (1 - a));
        rgba[idx + 1] = Math.round(cg * 255 * a + rgba[idx + 1] * (1 - a));
        rgba[idx + 2] = Math.round(cb * 255 * a + rgba[idx + 2] * (1 - a));
        rgba[idx + 3] = 255;
      }
  }
  return { frame: { width, height, rgba }, missingPages };
}

export function evaluateLayoutText(
  expected: LayoutExpected,
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
    const line = oracle.lines.find((l) => l.step === s.step) as
      | LayoutOracleLine
      | undefined;
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
      const synth = synthesizeLayoutText(
        node,
        pages,
        box,
        background,
        s.clip_rects[node.name] ?? null,
      );
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
// The LCD variant
// ---------------------------------------------------------------------------------------------

/** The expected file with the LCD Label's region and creation order added (regions, names). */
export function lcdExpected(expected: LayoutExpected): LayoutExpected {
  const lcd = expected.lcd;
  return {
    ...expected,
    creation_order: lcd.creation_order,
    steps: expected.steps.map((s) => ({
      ...s,
      text_regions: { ...s.text_regions, [lcd.name]: lcd.region },
      background: { ...s.background, [lcd.name]: lcd.background_rgba8 },
    })),
  };
}

export function evaluateLcdCommands(
  expected: LayoutExpected,
  recording: RecordingSummary,
): string[] {
  const problems: string[] = [];
  const lx = lcdExpected(expected);
  const names = mapNames4(asGate4(lx), recording);
  problems.push(...names.problems);
  const lcd = expected.lcd;
  const lcId = names.byName.get(lcd.name);
  for (const s of expected.steps) {
    const tx = recording.transactions.find(
      (t) => t.meta.frame === s.settle_frame,
    );
    if (!tx) {
      problems.push(`step ${s.step}: no settle transaction`);
      continue;
    }
    for (const item of tx.meta.items) {
      const unsupported = item.commands.filter((c) => c.op === "unsupported");
      if (item.id !== lcId) {
        if (unsupported.length > 0)
          problems.push(
            `step ${s.step}: ${names.byId.get(item.id)} carries ${unsupported.length} unsupported commands`,
          );
        continue;
      }
      if (
        item.commands.length !== lcd.ink_glyphs ||
        unsupported.length !== lcd.ink_glyphs
      )
        problems.push(
          `step ${s.step}: ${lcd.name} has ${item.commands.length} commands (${unsupported.length} unsupported), expected ${lcd.ink_glyphs} unsupported`,
        );
      for (const c of unsupported)
        if (c.name !== lcd.op || c.reason !== lcd.reason)
          problems.push(
            `step ${s.step}: ${lcd.name} unsupported ${c.name}/${c.reason}`,
          );
    }
    const lcdPages = tx.meta.textures.filter(
      (e) =>
        e.kind === "image" &&
        e.status === "ok" &&
        e.format === lcd.page.format &&
        e.width === lcd.page.width &&
        e.height === lcd.page.height,
    );
    if (lcdPages.length !== 1)
      problems.push(
        `step ${s.step}: ${lcdPages.length} ok ${lcd.page.format} ${lcd.page.width}x${lcd.page.height} pages in the table, expected the LCD page`,
      );
    for (const u of tx.meta.unsupported)
      if (u.reason !== "draw-index-tie" && u.item !== lcId)
        problems.push(
          `step ${s.step}: unsupported entry ${u.op}/${u.reason} on item ${u.item}`,
        );
  }
  return problems.slice(0, 12);
}

/** receiver-lcd against reference-lcd: exact everywhere outside the LCD Label's region, and
 * different inside it at every settle step (the receiver skips the typed commands). */
export function evaluateLcdRegions(
  expected: LayoutExpected,
  reference: ReadonlyMap<string, Frame | null>,
  receiver: ReadonlyMap<string, Frame | null>,
): { problems: string[]; rows: string[] } {
  const problems: string[] = [];
  const rows: string[] = [];
  const r = expected.lcd.region;
  for (const s of expected.steps) {
    const a = reference.get(`step-${s.step}.png`);
    const b = receiver.get(`step-${s.step}.png`);
    if (!a || !b || a.width !== b.width || a.height !== b.height) {
      problems.push(`step ${s.step}: a shot is missing or of another size`);
      continue;
    }
    let inside = 0;
    let outside = 0;
    for (let y = 0; y < a.height; y++)
      for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        if (
          a.rgba[i] === b.rgba[i] &&
          a.rgba[i + 1] === b.rgba[i + 1] &&
          a.rgba[i + 2] === b.rgba[i + 2] &&
          a.rgba[i + 3] === b.rgba[i + 3]
        )
          continue;
        if (x >= r[0] && x < r[2] && y >= r[1] && y < r[3]) inside++;
        else outside++;
      }
    rows.push(`${s.step}:${inside}/${outside}`);
    if (outside > 0)
      problems.push(
        `step ${s.step}: ${outside} pixels differ outside ${expected.lcd.name}'s region`,
      );
    if (inside === 0)
      problems.push(
        `step ${s.step}: ${expected.lcd.name}'s region does not differ`,
      );
  }
  return { problems, rows };
}

// ---------------------------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------------------------

export interface G4cResult {
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
  subpixel: Record<
    string,
    Record<string, { uploads: number; new_pairs: number; shifts: number[] }>
  >;
  clips: Record<string, Record<string, ClipRect | null | string>>;
}

export interface G4cContext {
  expected: LayoutExpected;
  lock: FontLockEntry[];
  receiverDir: string;
  /** absolute path to experiments/render-stream/fixtures/gate4-layout */
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

export async function runG4c(
  outDir: string,
  ctx: G4cContext,
): Promise<G4cResult> {
  const root = join(outDir, G4C_DIR);
  const expected = ctx.expected;
  const g4 = asGate4(expected);
  const checks: Gate4Check[] = [checkLayoutSelfConsistent(expected)];
  const legs: G4cResult["legs"] = {};

  // --- capture, reference legs (G4a's checks on this fixture) ---
  const capture = await evaluateCapture(root);
  const evidence = await loadCapture(
    root,
    "capture",
    "capture",
    G4C_CAPTURE_QUIT_FRAME,
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
  const glyphFull = evaluateLayoutGlyphCommands(
    expected,
    oracle,
    capture.full,
    mapping,
  );
  const glyphPatch = evaluateLayoutGlyphCommands(
    expected,
    oracle,
    capture.patch,
    mapping,
  );
  const census = layoutCensusFromLog(
    expected,
    evidence.hook.lines,
    mapping,
    G4C_CAPTURE_QUIT_FRAME,
  );
  const censusProblems = evidence.hook.problem
    ? [`resources.jsonl ${evidence.hook.problem}`]
    : [];
  censusProblems.push(
    ...evaluateLayoutCensus(expected, census, capture.full, mapping),
  );
  if (mapping.size === 0)
    censusProblems.push("no page mapping (atlas-hash-parity found none)");
  const subpixel = evaluateSubpixelCensus(expected, census, oracle);
  const lifetime = evaluatePageLifetime(
    expected,
    census,
    capture.full,
    capture.patch,
    mapping,
  );
  const clipFull = evaluateLayoutClips(expected, capture.full);
  const clipPatch = evaluateLayoutClips(expected, capture.patch);
  const image = evaluateExpectedImage(g4, "reference-layout", reference);
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

  // atlas-pages: per step, the oracle's pages per cache equal the wire's mapped textures in
  // count, format and shape; LP's cache has at least two pages once it shows the alphabet.
  const pageProblems: string[] = [];
  for (const s of expected.steps) {
    const line = oracle.lines.find((l) => l.step === s.step);
    const tx = capture.full.transactions.find(
      (t) => t.meta.frame === s.settle_frame,
    );
    if (!line || !tx) {
      pageProblems.push(`step ${s.step}: no oracle line or settle transaction`);
      continue;
    }
    const pageIds = line.pages.map((p) => mapping.get(pageKeyOf(p)));
    const wirePages = tx.meta.textures.filter(
      (e) => e.kind === "image" && e.status === "ok" && pageIds.includes(e.id),
    );
    if (wirePages.length !== line.pages.length)
      pageProblems.push(
        `step ${s.step}: ${line.pages.length} oracle pages, ${wirePages.length} mapped wire pages`,
      );
    const others = tx.meta.textures.filter(
      (e) => e.kind === "image" && e.status === "ok" && !pageIds.includes(e.id),
    );
    if (others.length !== expected.engine_textures.length)
      pageProblems.push(
        `step ${s.step}: ${others.length} unmapped wire textures (ids ${others.map((e) => e.id).join(",")})`,
      );
    for (const p of line.pages) {
      const e = tx.meta.textures.find(
        (x) => x.id === mapping.get(pageKeyOf(p)),
      );
      if (
        e &&
        (e.format !== p.format || e.width !== p.width || e.height !== p.height)
      )
        pageProblems.push(
          `step ${s.step}: ${pageKeyOf(p)} is ${e.format} ${e.width}x${e.height} on the wire, ${p.format} ${p.width}x${p.height} in the oracle`,
        );
    }
    const lpPages = line.pages.filter((p) => p.size === 320).length;
    if (s.texts.LP?.text.length === 26 && lpPages < 2)
      pageProblems.push(
        `step ${s.step}: F@320 has ${lpPages} pages, expected at least 2`,
      );
  }
  const lpPagesAtEnd =
    oracle.lines.at(-1)?.pages.filter((p) => p.size === 320) ?? [];

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
      "fixture-env-layout",
      "layout env.json is identical across capture, reference and reference-repeat, names the Advanced TextServer, carries the pinned font's sha256, F's and DF's D3 pins as G4a's, FX = F with subpixel positioning auto and FL = F, the Q1e project settings, viewport oversampling 1.0 and tool locale en",
      evaluateLayoutEnv(envs, ctx.lock),
      "identical across capture, reference, reference-repeat; F, FX, FL, DF pinned",
      Object.keys(envs).map((l) => join(root, l, "env.json")),
    ),
    checkOf(
      "oracle-agrees-layout",
      "the layout oracle equals expected.json at every settle step: the visible Labels, texts, fonts, sizes and colours, text-pass glyphs = ink glyphs, every pass's glyph commands = ink x passes, the word-wrapped line texts and the arbitrary-wrapped line counts, all lines drawn, clip flags, outline glyphs in the outline cache, pages per cache (F@320: 2 from step 7) with the predicted format and side, and the distinct glyphs drawn per cache equal the glyphs rasterized; reference and reference-repeat wrote byte-identical logs",
      evaluateLayoutOracle(expected, oracles),
      `${oracle.lines.length} oracle lines, identical across reference and reference-repeat`,
      oracles.map((o) => o.path),
    ),
    checkOf(
      "glyph-commands-layout",
      "on both sinks' settle transactions every Label's commands equal the oracle's glyph commands -- shadow, outline and text passes, line by line, in draw order -- as add_texture_rect_region with rect and src equal as float32, modulate the pass colour, and tex the wire id of the glyph's page (outline pages included); the panel and the marker carry no texture command",
      [
        ...glyphFull.problems.slice(0, 10),
        ...glyphPatch.problems.slice(0, 10).map((p) => `patch: ${p}`),
      ],
      `${Object.values(glyphFull.commands).reduce((a, b) => a + b, 0)} glyph commands over ${expected.steps.length} settle transactions x 2 sinks equal the oracle (${Object.values(glyphFull.commands).join("/")})`,
      [oracle.path, capture.full.path, capture.patch.path],
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
      "atlas-census-layout",
      `from the hook log (windows [applied_k, applied_k+1) through quit ${G4C_CAPTURE_QUIT_FRAME}), page creates, frees and updates per cache equal expected.json -- plain caches once per dirty page, outline caches once per new outline glyph, FX (subpixel) some exactly when it gains glyphs -- every texture call in the step's applied frame, last hook versions and settle wire versions as predicted, each page's wire format and side its cache's, quiet steps ${expected.quiet_steps.join(",")} silent, and the only other texture the 800x6 ColorPicker strip`,
      censusProblems,
      expected.steps
        .map(
          (s) =>
            `${s.step}:{${Object.entries(census[s.step]?.pages ?? {})
              .map(
                ([k, p]) =>
                  `${k} ${p.creates ? "c" : ""}${p.updates ? `u${p.updates}` : ""}${p.frees ? "f" : ""}`,
              )
              .join(" ")}}`,
        )
        .join(" "),
      [evidence.hook.path, capture.full.path],
    ),
    checkOf(
      "atlas-pages",
      "at every settle step each cache's oracle pages equal the capture's mapped wire textures in count, format and shape, no other wire texture than the engine's exists, and F@320 (LP's 26 capitals at 320 px) has at least 2 pages of 1024x1024 LA8",
      pageProblems,
      `F@320 ends with ${lpPagesAtEnd.length} pages (${lpPagesAtEnd.map((p) => `${p.width}x${p.height} ${p.format}`).join(", ")})`,
      [oracle.path, capture.full.path],
    ),
    checkOf(
      "subpixel-census",
      `for every subpixel cache (${expected.subpixel_caches.join(", ")}), the uploads in each step's window are at most the oracle's new (glyph, x shift) pairs (the unshifted variant shaping rasterizes included) and at least 1 when there are any, and its glyphs use more than one x shift`,
      subpixel.problems,
      Object.entries(subpixel.rows)
        .map(
          ([cache, rows]) =>
            `${cache}: ${Object.entries(rows)
              .map(([k, r]) => `${k}:${r.uploads}/${r.new_pairs}`)
              .join(" ")} (uploads/new pairs)`,
        )
        .join("; "),
      [evidence.hook.path, oracle.path],
    ),
    checkOf(
      "page-lifetime",
      "at the lifetime step the FL page's wire id is freed in the hook log and leaves the texture table in that frame's transaction (both sinks), nothing draws it afterwards, and FL2's page is created with a new wire id in the same frame",
      lifetime.problems,
      lifetime.detail,
      [evidence.hook.path, capture.full.path, capture.patch.path],
    ),
    checkOf(
      "clip-rects-derived-layout",
      "gate 3's deriveClipRects (lib/clip-derive.ts) over each settle transaction of both sinks gives LK and LP their own scissors equal to expected.json clip_rects (LK's box; LP's box cut by the viewport) and no other Label a clip",
      [...clipFull.problems, ...clipPatch.problems.map((p) => `patch: ${p}`)],
      `${Object.entries(clipFull.table[0] ?? {})
        .map(([n, r]) => `${n} ${JSON.stringify(r)}`)
        .join(", ")}`,
      [capture.full.path, capture.patch.path],
    ),
    checkOf(
      "expected-image-reference-layout",
      "every reference-layout shot equals synthesizeGate4 exactly outside the text regions: the clear colour, the panel, the marker, and the strips a clip keeps clear (right of LK's and LP's clips)",
      image.problems,
      `${shotsOf(g4).length} reference shots exact outside the text regions`,
      [join(root, "reference", "shots")],
    ),
    checkOf(
      "ink-presence-reference-layout",
      "in every reference-layout settle shot each text region has at least 6 x ink_min_glyphs differing pixels (ink glyphs, or for a clipped Label the glyphs its clip must show), a region differs from the previous step's exactly when expected.json says fresh, and each early shot's text regions equal its step's settle shot",
      inkRef.problems,
      `ink in ${expected.text_nodes.length} regions x ${expected.steps.length} steps as expected; early shots settled`,
      [join(root, "reference", "shots")],
    ),
    checkOf(
      "reference-repeat-budget-layout",
      "reference-layout vs reference-layout-repeat: identical everywhere at every shot (budget 0, D8)",
      repeatCmp.problems,
      `budget 0: ${repeatCmp.budgets.map((b) => `${b.region} ${b.max_channel_delta}`).join(", ")}`,
      [
        join(root, "reference", "shots"),
        join(root, "reference-repeat", "shots"),
      ],
    ),
    checkOf(
      "armed-transparent-layout",
      "reference-layout-armed (extension armed, stream on, oracle off) armed with its stream closed and equals reference-layout exactly at every shot",
      armedCmp.problems,
      `${shotsOf(g4).length} armed shots byte-identical to the reference`,
      [join(root, "reference-armed", "shots")],
    ),
  );
  {
    const problems: string[] = [];
    for (const leg of [
      "import/fixture",
      "reference",
      "reference-repeat",
      "reference-armed",
      "receiver-headless-trace",
      "lcd/reference",
    ]) {
      const code = await readExitCode(join(root, leg));
      if (code !== 0) problems.push(`${leg} exit ${code ?? "<none>"}`);
    }
    if (
      !(await readTextOrUndefined(join(root, "import", "fonts.log")))?.includes(
        " ok ",
      )
    )
      problems.push(
        "layout/import/fonts.log does not record a provisioned font",
      );
    checks.push(
      checkOf(
        "support-legs-exit-layout",
        "fonts were provisioned for fixtures/gate4-layout and its import, reference-layout, -repeat, -armed, the headless receiver trace and reference-lcd exited 0",
        problems,
        "6 support legs exited 0",
        [join(root, "import", "fonts.log")],
      ),
    );
  }
  checks.push(tag(checkCaptureLegClass(capture)));
  legs["capture-layout"] = {
    group: "g4c",
    expected_class: capture.expected_class,
    result_class: capture.result_class,
    reasons: capture.reasons,
    harmless_ties: capture.harmless_ties,
    exit_code: capture.exit_code,
    artifacts: capture.artifacts,
  };
  for (const [leg, dir] of [
    ["reference-layout", "reference"],
    ["reference-layout-repeat", "reference-repeat"],
    ["reference-layout-armed", "reference-armed"],
    ["receiver-layout-headless-trace", "receiver-headless-trace"],
    ["reference-lcd", "lcd/reference"],
  ] as const)
    legs[leg] = {
      group: "g4c",
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
    ["receiver-layout", "receiver", capture.full],
    ["receiver-layout-patch", "receiver-patch", capture.patch],
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
      group: "g4c",
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
    leg: "receiver-layout-headless-trace",
    dir: join(root, "receiver-headless-trace"),
    applied: traceApplied,
  });
  const vsRef = compareLegs(g4, reference, receiverShots["receiver-layout"]);
  const vsRefPatch = compareLegs(
    g4,
    reference,
    receiverShots["receiver-layout-patch"],
  );
  const imageReceiver = evaluateExpectedImage(
    g4,
    "receiver-layout",
    receiverShots["receiver-layout"],
  );
  checkpoints = [...checkpoints, ...imageReceiver.checkpoints];
  const inkReceiver = evaluateInkPresence(
    inkExpected,
    receiverShots["receiver-layout"],
  );
  const oracleDir = join(root, "reference", "oracle");
  const pages = await loadLayoutPages(oracleDir, oracle);
  const textRef = evaluateLayoutText(expected, oracle, pages.bySha, reference);
  const textRecv = evaluateLayoutText(
    expected,
    oracle,
    pages.bySha,
    receiverShots["receiver-layout"],
  );
  const appliedFull = receiverLegs[0].applied;
  const appliedPatch = receiverLegs[1].applied;
  checks.push(
    checkOf(
      "receiver-vs-reference-layout",
      "receiver-layout and receiver-layout-patch shots (re-keyed from wire seq to fixture step, early shots included) equal reference-layout's exactly, full frame and every region",
      [
        ...vsRef.problems.map((p) => `receiver: ${p}`),
        ...vsRefPatch.problems.map((p) => `patch: ${p}`),
      ],
      `receiver ${vsRef.budgets.map((b) => `${b.region} ${b.max_channel_delta}`).join(", ")}`,
      [join(root, "receiver", "shots"), join(root, "receiver-patch", "shots")],
    ),
    checkOf(
      "expected-image-receiver-layout",
      "every receiver-layout shot equals synthesizeGate4 exactly outside the text regions",
      imageReceiver.problems,
      `${shotsOf(g4).length} receiver shots exact outside the text regions`,
      [join(root, "receiver", "shots")],
    ),
    checkOf(
      "expected-text-reference-layout",
      "D8 on layout: every glyph command the oracle reports (shadow, outline and text, each with its pass colour and its own page, outline pages included) straight-alpha blended over the region's background and limited to the Label's clip, against reference-layout's settle shots inside every text region, budget maxChannelDelta 1",
      [...pages.problems, ...textRef.problems],
      `max channel delta ${textRef.maxDelta} (budget 1), ${textRef.deltaPixels} px at delta >= 1; per node ${JSON.stringify(textRef.perNode)}`,
      [oracleDir, join(root, "reference", "shots")],
    ),
    checkOf(
      "expected-text-receiver-layout",
      "D8 on layout as for the reference, against receiver-layout's settle shots",
      [...pages.problems, ...textRecv.problems],
      `max channel delta ${textRecv.maxDelta} (budget 1), ${textRecv.deltaPixels} px at delta >= 1`,
      [oracleDir, join(root, "receiver", "shots")],
    ),
    checkOf(
      "ink-presence-receiver-layout",
      "receiver-layout's settle shots carry the reference's ink presence and freshness",
      inkReceiver.problems,
      `ink in ${expected.text_nodes.length} regions x ${expected.steps.length} steps as expected`,
      [join(root, "receiver", "shots")],
    ),
    checkOf(
      "resource-quiet-layout",
      `the quiet steps (${expected.quiet_steps.join(",")}) fetch and upload nothing on either sink's receiver`,
      [
        ...evaluateResourceQuiet(g4, appliedFull, G4C_CAPTURE_QUIT_FRAME).map(
          (p) => `receiver: ${p}`,
        ),
        ...evaluateResourceQuiet(g4, appliedPatch, G4C_CAPTURE_QUIT_FRAME).map(
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

  // --- sabotage-layout-omit-atlas ---
  const prediction = (
    expected.predictions as Record<
      string,
      {
        steps: number[];
        regions?: Record<string, string[]>;
        atlas_hash_parity_fails?: Record<string, number[]>;
      }
    >
  )[G4C_SABOTAGE];
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
        G4C_SABOTAGE,
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
        const textRegion = expected.text_nodes.includes(r.name);
        if (bad && !want.includes(r.name))
          regionProblems.push(
            `step ${cp.step}: region ${r.name} differs (${r.mismatched_pixels} px), predicted only {${want.join(",")}}`,
          );
        if (!bad && textRegion && want.includes(r.name))
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
        `${G4C_SABOTAGE}-regions`,
        `on ${G4C_SABOTAGE}'s receiver every differing pixel lies in the predicted regions (expected.json predictions: ${JSON.stringify(prediction?.regions ?? {})}) and each predicted region differs`,
        regionProblems,
        `mismatch confined to ${[...new Set(Object.values(prediction?.regions ?? {}).flat())].join(",")}`,
        [recvDir],
      ),
      {
        ...checkAtlasHashParitySabotage(
          G4C_SABOTAGE,
          g4,
          oracle,
          sabFull,
          prediction?.atlas_hash_parity_fails ?? {},
        ),
        id: `atlas-hash-parity-${G4C_SABOTAGE}`,
      },
    );
    legs[G4C_SABOTAGE] = {
      group: "g4c",
      expected_class: "pixel-mismatch",
      result_class: cls.result_class,
      reasons: cls.reasons,
      harmless_ties: cls.harmless_ties,
      exit_code: await readExitCode(recvDir),
      artifacts: [join(capDir, RECORDING_NAME), join(recvDir, "applied.json")],
    };
    receiverLegs.push({
      leg: `${G4C_SABOTAGE}-receiver`,
      dir: recvDir,
      applied: sabApplied,
    });
  }

  // --- the LCD variant ---
  {
    const lx = lcdExpected(expected);
    const capDir = join(root, "lcd", "capture");
    const refDir = join(root, "lcd", "reference");
    const recvDir = join(root, "lcd", "receiver");
    const lcdResult = await readJson<CaptureResultJson>(
      join(capDir, "evidence", "result.json"),
    );
    const lcdFull = await loadRecording(join(capDir, RECORDING_NAME));
    const capCls = classifyLeg({
      captureResult: lcdResult,
      recording: lcdFull,
      checkpoints: [],
    });
    const lcdSeqs = receiverStepSeqs(asGate4(lx), lcdFull);
    const lcdRef = await loadShots(root, "lcd/reference", asGate4(lx));
    const lcdRecv = await loadReceiverShots(
      root,
      "lcd/receiver",
      asGate4(lx),
      lcdSeqs,
    );
    const lcdApplied = await readJson<AppliedJson>(
      join(recvDir, "applied.json"),
    );
    const cps: Checkpoint[] = computeGate4Checkpoints(
      asGate4(lx),
      refDir,
      lcdRef,
      recvDir,
      lcdRecv,
      lcdSeqs.settle,
    );
    const recvCls = classifyLeg({
      captureResult: lcdResult,
      recording: lcdFull,
      receiver: {
        applied: lcdApplied,
        requestedShotSeqs: [...lcdSeqs.settle.values()],
        shotFiles: await shotSeqsPresent(recvDir),
      },
      checkpoints: cps,
    });
    const want = `${expected.lcd.op}/command`;
    const reasonsOk = (reasons: string[]) =>
      reasons.some((r) => r.startsWith("unsupported:") && r.includes(want));
    const capProblems: string[] = [];
    if (capCls.result_class !== "unsupported" || !reasonsOk(capCls.reasons))
      capProblems.push(
        `class ${capCls.result_class}: ${capCls.reasons.slice(0, 2).join(" | ")}`,
      );
    capProblems.push(...evaluateLcdCommands(expected, lcdFull));
    const recvProblems: string[] = [];
    if (recvCls.result_class !== "unsupported")
      recvProblems.push(
        `class ${recvCls.result_class}: ${recvCls.reasons.slice(0, 2).join(" | ")}`,
      );
    const appliedUnsupported =
      (lcdApplied as { unsupported?: { name?: string }[] } | undefined)
        ?.unsupported ?? [];
    if (
      appliedUnsupported.length === 0 ||
      appliedUnsupported.some((u) => u.name !== expected.lcd.op)
    )
      recvProblems.push(
        `applied.json unsupported ${JSON.stringify(appliedUnsupported.slice(0, 2))}`,
      );
    const regions = evaluateLcdRegions(expected, lcdRef, lcdRecv);
    recvProblems.push(...regions.problems);
    checks.push(
      checkOf(
        "leg-class-capture-lcd",
        `capture-lcd (RS_FIXTURE_VARIANT=lcd) classifies as unsupported because of ${want} only: at every settle step LC's ${expected.lcd.ink_glyphs} glyph commands are typed unsupported (${expected.lcd.op}, ${expected.lcd.reason}), no other item carries one, and LC's ${expected.lcd.page.format} ${expected.lcd.page.width}x${expected.lcd.page.height} page is an ok texture in the table`,
        capProblems,
        `${capCls.result_class} (${capCls.reasons.slice(0, 1).join("")})`,
        [join(capDir, RECORDING_NAME)],
      ),
      checkOf(
        "leg-class-receiver-lcd",
        `receiver-lcd classifies as unsupported, its applied.json lists only ${expected.lcd.op}, and against reference-lcd it differs only inside LC's region, at every settle step`,
        recvProblems,
        `${recvCls.result_class}; per step inside/outside differing px ${regions.rows.join(" ")}`,
        [
          join(recvDir, "applied.json"),
          join(recvDir, "shots"),
          join(refDir, "shots"),
        ],
      ),
    );
    legs["capture-lcd"] = {
      group: "g4c",
      expected_class: "unsupported",
      result_class: capCls.result_class,
      reasons: capCls.reasons,
      harmless_ties: capCls.harmless_ties,
      exit_code: await readExitCode(capDir),
      artifacts: [join(capDir, RECORDING_NAME)],
    };
    legs["receiver-lcd"] = {
      group: "g4c",
      expected_class: "unsupported",
      result_class: recvCls.result_class,
      reasons: recvCls.reasons,
      harmless_ties: recvCls.harmless_ties,
      exit_code: await readExitCode(recvDir),
      artifacts: [join(recvDir, "applied.json")],
    };
    receiverLegs.push({
      leg: "receiver-lcd",
      dir: recvDir,
      applied: lcdApplied,
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
      glyphFull.commands,
      G4C_CAPTURE_QUIT_FRAME,
    ),
    parity: parityCheck.table,
    budgets: repeatCmp.budgets,
    census,
    ink: inkRef.ink,
    subpixel: subpixel.rows,
    clips: clipFull.table,
  };
}
