// Gate 4e checks: MSDF text on render-stream/3 (protocol/gate4-design.md "G4e2", "Q6e", Q2-Q5).
//
// Group g4e runs fixtures/gate4-msdf/ through G4a's and G4b's legs (capture, reference x3,
// receiver x2, a headless receiver trace) plus three sabotages: sabotage-msdf-perturb-glyph (the
// host's perturb-glyph from the new-glyph step), sabotage-msdf-receiver-drop (the receiver's
// drop-msdf) and sabotage-gray-perturb-glyph (perturb-glyph on fixtures/gate4, judged against
// g4a's reference). Its evidence lives under <out>/msdf/ in G4a's shape, so every G4a/G4b helper
// that takes an evidence root runs on it unchanged; this module adds what MSDF needs: msdf glyph
// commands against the oracle bit for bit, their px_range/scale/outline arguments, one RGBA8
// page with an all-zero empty texel, a census with no upload at a size change or an outline
// toggle, and a receiver budget measured from the same-build reference repeat (D8: "For MSDF and
// any fractional quad, the budget is the measured reference-against-repeat maximum per region",
// never relaxed). There is no synthesized MSDF ink: coverage comes from the GPU's fwidth (Q1d),
// which the checker does not model. Check ids carry a "-msdf" suffix (or name the leg) so that
// they never collide with g4a's. Nothing here launches a process.
//
// Evidence layout under <out>/msdf/ (see scripts/README.md "Gate 4"):
//   import/fonts.log, import/{fixture,receiver}/   provisioning and editor --import
//   capture/                            leg capture-msdf: 400 frames, both sinks, store, strace
//   reference/, reference-repeat/       legs reference-msdf and reference-msdf-repeat (oracle on)
//   reference-armed/                    leg reference-msdf-armed (extension armed, oracle off)
//   receiver-headless-trace/            headless receiver under strace -e openat
//   receiver/, receiver-patch/          legs receiver-msdf and receiver-msdf-patch
//   sabotage-perturb-glyph/{capture,receiver}   leg sabotage-msdf-perturb-glyph
//   sabotage-receiver-drop/receiver     leg sabotage-msdf-receiver-drop (main capture's recording)
//   sabotage-gray-perturb-glyph/{capture,receiver}   leg sabotage-gray-perturb-glyph (fixtures/gate4)

import { readdir } from "node:fs/promises";
import { join } from "node:path";

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
  gate4Regions,
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
  type Box4,
  type Gate4Expected,
  type Gate4ExpectedStep,
  type OracleLine,
  type OracleNode,
  pageKeyOf,
  type Rect4,
} from "./gate4-expected";
import {
  evaluateLayoutCensus,
  type LayoutCensusStep,
  type LayoutExpected,
  layoutCensusFromLog,
} from "./gate4c-checks";

// ---------------------------------------------------------------------------------------------
// Contract constants and types
// ---------------------------------------------------------------------------------------------

/** The g4e evidence root, relative to the run's --out. */
export const G4E_DIR = "msdf";
/** The main MSDF capture's quit frame (as G4a's). */
export const G4E_CAPTURE_QUIT_FRAME = 400;
export const G4E_PERTURB = "sabotage-msdf-perturb-glyph";
export const G4E_DROP = "sabotage-msdf-receiver-drop";
export const G4E_GRAY = "sabotage-gray-perturb-glyph";
export const MSDF_OP = "add_msdf_texture_rect_region";
export const MSDF_METHOD = "canvas_item_add_msdf_texture_rect_region";

/** D3/D5 pins of the MSDF fixture's fonts as env.json records them: FM is G4a's F with MSDF on
 * at msdf_size 48 and msdf_pixel_range 24; DF is the default theme font, as G4a's. */
export function msdfFontPins(): Record<string, Record<string, unknown>> {
  return {
    FM: {
      ...FONT_PINS.F,
      multichannel_signed_distance_field: true,
      msdf_size: 48,
      msdf_pixel_range: 24,
    },
    DF: FONT_PINS.DF,
  };
}

export interface MsdfGlyph {
  pass: "text" | "outline" | "shadow" | "shadow-outline";
  index: number;
  font_key: string;
  /** the draw size (px) */
  size: number;
  /** the cache's size: msdf_size, whatever the draw size */
  cache_size: number;
  /** the command's outline argument (0 for the text pass) */
  outline: number;
  x: number;
  y: number;
  quad: Rect4;
  uv: Rect4;
  page: number;
  msdf: boolean;
  px_range: number;
  scale: number;
  colour: [number, number, number, number];
}

export interface MsdfNode extends Omit<OracleNode, "glyphs"> {
  outline_size: number;
  outline_colour: [number, number, number, number];
  glyphs: MsdfGlyph[];
}

export interface MsdfOracleLine extends Omit<OracleLine, "nodes"> {
  nodes: MsdfNode[];
}

export interface MsdfTextState {
  text: string;
  font_key: string;
  size: number;
  colour: [number, number, number, number];
  visible: boolean;
  position: [number, number];
  outline_size: number;
  outline_colour?: [number, number, number, number];
  rotation_degrees?: number;
}

export interface MsdfStep extends Omit<Gate4ExpectedStep, "texts"> {
  texts: Record<string, MsdfTextState>;
  /** every msdf command per node: ink glyphs x passes */
  commands: Record<string, number>;
  passes: Record<string, string[]>;
  frees: string[];
  subpixel_bounded: string[];
}

export interface MsdfPrediction {
  frame: number;
  steps: number[];
  regions?: Record<string, string[]>;
}

export interface MsdfExpected
  extends Omit<Gate4Expected, "steps" | "predictions"> {
  msdf: {
    font_key: string;
    msdf_size: number;
    msdf_pixel_range: number;
    cache: string;
  };
  rotor: {
    position: [number, number];
    rotation_degrees: number;
    scale: number;
  };
  caches: LayoutExpected["caches"];
  subpixel_caches: string[];
  steps: MsdfStep[];
  predictions: Record<string, MsdfPrediction>;
}

/** The step list as G4a's helpers see it (structural: the MSDF steps are a superset). */
export function asGate4(expected: MsdfExpected): Gate4Expected {
  return expected as unknown as Gate4Expected;
}

function asLayout(expected: MsdfExpected): LayoutExpected {
  return expected as unknown as LayoutExpected;
}

const f32 = (v: number): number => Math.fround(v);
const f32eq = (a: readonly number[] | undefined, b: readonly number[]) =>
  !!a && a.length === b.length && a.every((v, i) => f32(v) === f32(b[i]));

/** A glyph's page key, as pageKeyOf names the oracle's pages: the cache is (msdf_size, 0). */
export function msdfPageKey(g: MsdfGlyph): string {
  return `${g.font_key}@${g.cache_size}/0#${g.page}`;
}

/** A check from gate4-checks' `check`, its id suffixed for the MSDF group. */
function tag(c: Gate4Check | Gate0Check, suffix = "-msdf"): Gate4Check {
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

const LEVELS = new Set([0, 51, 102, 153, 204, 255]);
const ink = (t: string) => [...t].filter((c) => !/\s/u.test(c));

// ---------------------------------------------------------------------------------------------
// expected-self-consistent-msdf
// ---------------------------------------------------------------------------------------------

/** An independent TS re-derivation of make_expected.py's MSDF census: one cache (msdf_size) for
 * every draw size and outline; step 0 shapes every Label before drawing and creates the page
 * once; from step 1 each Label draw that introduces glyphs uploads it once. */
export function deriveMsdfCensus(expected: MsdfExpected): {
  page_creates: Record<string, number>;
  page_uploads: Record<string, number>;
  new_glyphs: Record<string, string>;
  hook_version: number;
}[] {
  const cache = expected.msdf.cache;
  const have = new Set<string>();
  let version = 0;
  const out = [];
  for (const s of expected.steps) {
    const creates: Record<string, number> = {};
    const uploads: Record<string, number> = {};
    let fresh = "";
    if (s.step === 0) {
      for (const n of s.draws)
        for (const c of ink(s.texts[n].text))
          if (!have.has(c)) {
            have.add(c);
            fresh += c;
          }
      version++;
      creates[cache] = 1;
    } else
      for (const n of s.draws) {
        let added = "";
        for (const c of ink(s.texts[n].text))
          if (!have.has(c)) {
            have.add(c);
            added += c;
          }
        if (!added) continue;
        fresh += added;
        version++;
        uploads[cache] = (uploads[cache] ?? 0) + 1;
      }
    out.push({
      page_creates: creates,
      page_uploads: uploads,
      new_glyphs: fresh ? { [cache]: fresh } : {},
      hook_version: version,
    });
  }
  return out;
}

export function checkMsdfSelfConsistent(expected: MsdfExpected): Gate4Check {
  const problems: string[] = [];
  if (expected.schema !== "render-stream-gate4-expected/1")
    problems.push(`schema=${JSON.stringify(expected.schema)}`);
  if (expected.fixture !== "gate4-msdf")
    problems.push(`fixture=${JSON.stringify(expected.fixture)}`);
  const [w, h] = expected.viewport ?? [];
  if (w !== 640 || h !== 360) problems.push(`viewport ${w}x${h}`);
  if (expected.msdf?.msdf_size !== 48 || expected.msdf?.msdf_pixel_range !== 24)
    problems.push(
      `msdf ${JSON.stringify(expected.msdf)}, the contract pins 48 / 24 (D5)`,
    );
  const S = expected.start_frame_default;
  const N = expected.step_frames_default;
  if (expected.settle_offset !== 7) problems.push("settle_offset is not 7");
  if (expected.quit_frame_default !== S + N * expected.last_step + 11)
    problems.push("quit_frame_default is not S+N*last+11");
  const onGrid = (v: number) => Math.abs(v * 5 - Math.round(v * 5)) < 1e-9;
  const derived = deriveMsdfCensus(expected);
  const m = expected.regions.marker;
  const markerBox: Box4 = [m[0], m[1], m[0] + m[2], m[1] + m[3]];
  const p = expected.panel.rect;
  const panelBox: Box4 = [p[0], p[1], p[0] + p[2], p[1] + p[3]];
  const markers = new Set<string>();
  const page = `${expected.msdf.cache}/0#0`;
  for (const s of expected.steps) {
    const fail = (t: string) => problems.push(`step ${s.step}: ${t}`);
    if (
      s.applied_frame !== (s.step === 0 ? 1 : S + N * s.step) ||
      s.settle_frame !== S + N * s.step + 7
    )
      fail(`frames ${s.applied_frame}/${s.settle_frame}`);
    for (const [name, t] of Object.entries(s.texts)) {
      for (const c of [t.colour, t.outline_colour].filter(
        (x): x is [number, number, number, number] => !!x,
      ))
        if (!c.every(onGrid) || (c[3] !== 1 && c[3] !== 0.6))
          fail(`${name} colour ${c.join(",")} breaks the colour rule`);
      const passes = t.outline_size > 0 ? 2 : 1;
      if (s.commands[name] !== ink(t.text).length * passes)
        fail(`${name} commands ${s.commands[name]}, ink x passes`);
      if (s.ink_glyphs[name] !== ink(t.text).length)
        fail(`${name} ink ${s.ink_glyphs[name]}`);
    }
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
        fail(`${names[i]}'s background is not its region's`);
      if (!inPanel && overlaps(a, panelBox))
        fail(`${names[i]} straddles the panel`);
      if (overlaps(a, markerBox))
        fail(`${names[i]} overlaps the marker region`);
    }
    if (!same(s.wire_versions, s.hook_versions))
      fail("wire_versions differ from hook_versions");
    const d = derived[s.step];
    for (const key of ["page_creates", "page_uploads", "new_glyphs"] as const)
      if (!same(sortObj(d[key]), sortObj(s[key])))
        fail(
          `${key} ${JSON.stringify(s[key])}, re-derived ${JSON.stringify(d[key])}`,
        );
    if (s.hook_versions[page] !== d.hook_version)
      fail(
        `hook version ${s.hook_versions[page]}, re-derived ${d.hook_version}`,
      );
    if (
      expected.quiet_steps.includes(s.step) &&
      Object.keys(s.page_uploads).length + Object.keys(s.page_creates).length >
        0
    )
      fail("a quiet step has page traffic");
  }
  if (markers.size !== expected.steps.length)
    problems.push(
      `${markers.size} marker colours for ${expected.steps.length} steps`,
    );
  return checkOf(
    "expected-self-consistent-msdf",
    "fixtures/gate4-msdf/expected.json obeys its rules: 640x360, msdf_size 48 and msdf_pixel_range 24 (D5), steps 0..9 at S+N*k (settle +7), colours on the 0.2 grid with alpha 1 or 0.6, one marker colour per step, text regions disjoint, each inside one background and clear of the marker, commands = ink x passes, and the census (one msdf_size cache: creates, uploads, new glyphs, hook versions) re-derived in TypeScript from the texts and draws equals the file's",
    problems,
    `${expected.steps.length} steps, ${expected.text_nodes.length} text regions, census re-derived`,
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// oracle-agrees-msdf
// ---------------------------------------------------------------------------------------------

export function evaluateMsdfOracle(
  expected: MsdfExpected,
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
  const { msdf_size, msdf_pixel_range, cache } = expected.msdf;
  const drawn = new Set<number>();
  for (const s of expected.steps) {
    const line = log.lines.find((l) => l.step === s.step) as
      | MsdfOracleLine
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
      if (node.outline_size !== t.outline_size)
        fail(`${node.name} outline_size ${node.outline_size}`);
      const text = node.glyphs.filter((g) => g.pass === "text");
      if (text.length !== s.ink_glyphs[node.name])
        fail(
          `${node.name} ${text.length} text glyphs, expected ${s.ink_glyphs[node.name]}`,
        );
      if (node.glyphs.length !== s.commands[node.name])
        fail(
          `${node.name} ${node.glyphs.length} glyph commands, expected ${s.commands[node.name]}`,
        );
      const passes = [...new Set(node.glyphs.map((g) => g.pass))];
      if (!same(passes, s.passes[node.name]))
        fail(
          `${node.name} passes ${passes.join(",")}, expected ${s.passes[node.name].join(",")}`,
        );
      for (const g of node.glyphs) {
        drawn.add(g.index);
        const want = g.pass === "outline" ? t.outline_size : 0;
        if (
          !g.msdf ||
          g.cache_size !== msdf_size ||
          g.outline !== want ||
          f32(g.px_range) !== f32(msdf_pixel_range) ||
          f32(g.scale) !== f32(t.size / msdf_size)
        ) {
          fail(
            `${node.name} ${g.pass} glyph ${g.index}: msdf ${g.msdf} cache ${g.cache_size} outline ${g.outline} px_range ${g.px_range} scale ${g.scale}`,
          );
          break;
        }
      }
    }
    const pages = line.pages.filter(
      (p) => `${p.font_key}@${p.size}` === cache && p.outline === 0,
    );
    if (pages.length !== line.pages.length)
      fail(
        `oracle pages ${line.pages.map((p) => pageKeyOf(p)).join(",")}, expected only ${cache}'s`,
      );
    if (pages.length !== s.page_counts[cache])
      fail(
        `${cache} has ${pages.length} pages, expected ${s.page_counts[cache]}`,
      );
    const c = expected.caches[cache];
    for (const p of pages)
      if (
        p.format !== c.format ||
        p.width !== c.width ||
        p.height !== c.height ||
        p.mipmaps !== c.mipmaps ||
        p.data_bytes !== c.data_bytes
      )
        fail(`page ${pageKeyOf(p)} is ${p.format} ${p.width}x${p.height}`);
    if (drawn.size !== s.page_glyphs[cache])
      fail(
        `${cache} drew ${drawn.size} distinct glyphs so far, expected ${s.page_glyphs[cache]}`,
      );
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// glyph-commands-msdf, msdf-args
// ---------------------------------------------------------------------------------------------

export function evaluateMsdfGlyphCommands(
  expected: MsdfExpected,
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
      | MsdfOracleLine
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
      const glyphs =
        line.nodes.find((n) => n.name === name)?.glyphs ?? ([] as MsdfGlyph[]);
      if (textured.length !== glyphs.length) {
        fail(
          `${name} has ${textured.length} glyph commands, the oracle ${glyphs.length}`,
        );
        continue;
      }
      count += textured.length;
      for (const [i, c] of textured.entries()) {
        const g = glyphs[i];
        const where = `${name} ${g.pass} glyph ${i} (index ${g.index})`;
        if (c.op !== MSDF_OP) {
          fail(`${where}: ${c.op}${c.reason ? ` (${c.reason})` : ""}`);
          continue;
        }
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
        if (c.outline !== g.outline)
          fail(`${where}: outline ${c.outline}, oracle ${g.outline}`);
        if (
          f32(c.px_range ?? Number.NaN) !== f32(g.px_range) ||
          f32(c.scale ?? Number.NaN) !== f32(g.scale)
        )
          fail(
            `${where}: px_range ${c.px_range} scale ${c.scale}, oracle ${g.px_range} ${g.scale}`,
          );
        const page = msdfPageKey(g);
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

/** msdf-args: every msdf command of every transaction of a sink carries px_range 24, a scale of
 * size / 48 for a size the fixture draws, and outline 0 or an outline_size the fixture sets; at
 * each settle step each Label's commands carry its own scale and per pass its outline; no
 * command is a typed msdf refusal and no glyph is a plain region command. */
export function evaluateMsdfArgs(
  expected: MsdfExpected,
  recording: RecordingSummary,
): { problems: string[]; total: number; outlined: number } {
  const problems: string[] = [];
  const { msdf_size, msdf_pixel_range } = expected.msdf;
  const sizes = new Set<number>();
  const outlines = new Set<number>([0]);
  for (const s of expected.steps)
    for (const t of Object.values(s.texts)) {
      sizes.add(f32(t.size / msdf_size));
      outlines.add(t.outline_size);
    }
  let total = 0;
  let outlined = 0;
  for (const t of recording.transactions)
    for (const item of t.meta.items)
      for (const c of item.commands) {
        if (c.op === "add_texture_rect_region" || c.op === "add_texture_rect")
          problems.push(
            `frame ${t.meta.frame}: item ${item.id} has a ${c.op} (no plain glyph expected)`,
          );
        if (c.op === "unsupported" && c.name === MSDF_METHOD)
          problems.push(
            `frame ${t.meta.frame}: item ${item.id} has an unsupported msdf command (${c.reason})`,
          );
        if (c.op !== MSDF_OP) continue;
        total++;
        if ((c.outline ?? 0) > 0) outlined++;
        if (f32(c.px_range ?? Number.NaN) !== f32(msdf_pixel_range))
          problems.push(`frame ${t.meta.frame}: px_range ${c.px_range}`);
        if (!sizes.has(f32(c.scale ?? Number.NaN)))
          problems.push(`frame ${t.meta.frame}: scale ${c.scale}`);
        if (!outlines.has(c.outline ?? -1))
          problems.push(`frame ${t.meta.frame}: outline ${c.outline}`);
      }
  for (const u of recording.transactions.flatMap((t) => t.meta.unsupported))
    if (u.op === MSDF_METHOD)
      problems.push(`unsupported entry ${u.op}/${u.reason}`);
  const names = mapNames4(asGate4(expected), recording);
  for (const s of expected.steps) {
    const tx = recording.transactions.find(
      (t) => t.meta.frame === s.settle_frame,
    );
    for (const name of expected.text_nodes) {
      const t = s.texts[name];
      const cmds =
        tx?.meta.items
          .find((i) => i.id === names.byName.get(name))
          ?.commands.filter((c) => c.op === MSDF_OP) ?? [];
      const n = ink(t.text).length;
      const wantScale = f32(t.size / msdf_size);
      if (cmds.some((c) => f32(c.scale ?? Number.NaN) !== wantScale))
        problems.push(`step ${s.step}: ${name} scale is not ${t.size}/48`);
      const out = cmds.filter((c) => (c.outline ?? 0) > 0);
      if (
        out.length !== (t.outline_size > 0 ? n : 0) ||
        out.some((c) => c.outline !== t.outline_size)
      )
        problems.push(
          `step ${s.step}: ${name} has ${out.length} outline commands (${[...new Set(out.map((c) => c.outline))].join(",")}), expected ${t.outline_size > 0 ? n : 0} at ${t.outline_size}`,
        );
    }
  }
  return { problems: problems.slice(0, 12), total, outlined };
}

// ---------------------------------------------------------------------------------------------
// Budgets (D8): the receiver within the reference repeat's measured maxima
// ---------------------------------------------------------------------------------------------

/** Every region's max channel delta against `ref` within the per-region budget (the same-build
 * reference repeat's measured maximum, `compareLegs`). */
export function evaluateWithinBudget(
  expected: Gate4Expected,
  ref: ReadonlyMap<string, Frame | null>,
  got: ReadonlyMap<string, Frame | null>,
  budgets: readonly RegionBudget[],
): { problems: string[]; measured: RegionBudget[] } {
  const cmp = compareLegs(expected, ref, got);
  const problems: string[] = cmp.problems.filter((p) => p.includes("missing"));
  for (const m of cmp.budgets) {
    const b = budgets.find((x) => x.region === m.region);
    if (!b) {
      problems.push(`no budget for region ${m.region}`);
      continue;
    }
    if (m.max_channel_delta > b.max_channel_delta)
      problems.push(
        `${m.region}: max channel delta ${m.max_channel_delta} (${m.mismatched_pixels} px) exceeds the budget ${b.max_channel_delta}`,
      );
  }
  return { problems, measured: cmp.budgets };
}

// ---------------------------------------------------------------------------------------------
// Sabotages
// ---------------------------------------------------------------------------------------------

/** Every differing pixel of a sabotage receiver lies in the predicted regions at each step, and
 * each predicted text region differs. `panel` holds the panel's text regions and is skipped. */
export function evaluatePredictedRegions(
  expected: Gate4Expected,
  checkpoints: readonly Checkpoint[],
  regions: Record<string, string[]>,
): string[] {
  const problems: string[] = [];
  for (const cp of checkpoints) {
    const want = regions[String(cp.step)] ?? [];
    for (const r of cp.regions) {
      if (r.name === "panel") continue;
      const bad = r.mismatched_pixels === null || r.mismatched_pixels > 0;
      const textRegion = expected.text_nodes.includes(r.name);
      if (bad && !want.includes(r.name))
        problems.push(
          `step ${cp.step}: region ${r.name} differs (${r.mismatched_pixels} px), predicted only {${want.join(",")}}`,
        );
      if (!bad && textRegion && want.includes(r.name))
        problems.push(
          `step ${cp.step}: region ${r.name} matches, predicted to differ`,
        );
    }
    if (cp.mismatched_pixels !== null) {
      let inPredicted = 0;
      for (const r of cp.regions)
        if (want.includes(r.name)) inPredicted += r.mismatched_pixels ?? 0;
      if (cp.mismatched_pixels !== inPredicted)
        problems.push(
          `step ${cp.step}: ${cp.mismatched_pixels - inPredicted} differing pixels outside the predicted regions`,
        );
    }
  }
  return problems;
}

/** perturb-glyph as recorded: at each settle step, a text node's glyph commands in the sabotage
 * capture equal the clean capture's with rect.x + 0.25 (float32) exactly when the node is in the
 * predicted set for that step, and equal them bit for bit otherwise (gate4-design.md Q3: the
 * mirror moves what it records from the sabotage frame on; the engine gets the true arguments). */
export function evaluatePerturbRecorded(
  expected: Gate4Expected,
  clean: RecordingSummary,
  sabotaged: RecordingSummary,
  regions: Record<string, string[]>,
): { problems: string[]; moved: number } {
  const problems: string[] = [];
  let moved = 0;
  const a = mapNames4(expected, clean);
  const b = mapNames4(expected, sabotaged);
  problems.push(...a.problems, ...b.problems.map((p) => `sabotage: ${p}`));
  for (const s of expected.steps) {
    const ta = clean.transactions.find((t) => t.meta.frame === s.settle_frame);
    const tb = sabotaged.transactions.find(
      (t) => t.meta.frame === s.settle_frame,
    );
    if (!ta || !tb) {
      problems.push(`step ${s.step}: no settle transaction`);
      continue;
    }
    const want = regions[String(s.step)] ?? [];
    for (const name of expected.text_nodes) {
      const ca = (
        ta.meta.items.find((i) => i.id === a.byName.get(name))?.commands ?? []
      ).filter((c) => c.op !== "add_rect");
      const cb = (
        tb.meta.items.find((i) => i.id === b.byName.get(name))?.commands ?? []
      ).filter((c) => c.op !== "add_rect");
      if (ca.length !== cb.length) {
        problems.push(
          `step ${s.step}: ${name} has ${cb.length} glyph commands, the clean capture ${ca.length}`,
        );
        continue;
      }
      const shift = want.includes(name);
      for (const [i, c] of cb.entries()) {
        const r: number[] = ca[i].rect ?? [Number.NaN, 0, 0, 0];
        const expect = shift ? [f32(r[0] + 0.25), r[1], r[2], r[3]] : r;
        if (!f32eq(c.rect, expect) || !f32eq(c.src, ca[i].src ?? [])) {
          problems.push(
            `step ${s.step}: ${name} glyph ${i} rect ${c.rect?.join(",")}, clean ${r.join(",")}${shift ? " (+0.25 predicted)" : ""}`,
          );
          break;
        }
        if (shift) moved++;
      }
    }
  }
  return { problems: problems.slice(0, 12), moved };
}

// ---------------------------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------------------------

export interface G4eResult {
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
  receiver_measured: RegionBudget[];
  census: Record<string, LayoutCensusStep>;
  ink: Record<string, Record<string, number>>;
}

export interface G4eContext {
  expected: MsdfExpected;
  lock: FontLockEntry[];
  receiverDir: string;
  /** absolute path to experiments/render-stream/fixtures/gate4-msdf */
  fixtureDir: string;
  /** fixtures/gate4's expected.json (sabotage-gray-perturb-glyph) */
  grayExpected: Gate4Expected;
  /** absolute path to experiments/render-stream/fixtures/gate4 */
  grayFixtureDir: string;
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

type LegEntry = G4eResult["legs"][string];

export async function runG4e(
  outDir: string,
  ctx: G4eContext,
): Promise<G4eResult> {
  const root = join(outDir, G4E_DIR);
  const expected = ctx.expected;
  const g4 = asGate4(expected);
  const checks: Gate4Check[] = [checkMsdfSelfConsistent(expected)];
  const legs: G4eResult["legs"] = {};

  // --- capture, reference legs ---
  const capture = await evaluateCapture(root);
  const evidence = await loadCapture(
    root,
    "capture",
    "capture",
    G4E_CAPTURE_QUIT_FRAME,
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
  const glyphFull = evaluateMsdfGlyphCommands(
    expected,
    oracle,
    capture.full,
    mapping,
  );
  const glyphPatch = evaluateMsdfGlyphCommands(
    expected,
    oracle,
    capture.patch,
    mapping,
  );
  const argsFull = evaluateMsdfArgs(expected, capture.full);
  const argsPatch = evaluateMsdfArgs(expected, capture.patch);
  const census = layoutCensusFromLog(
    asLayout(expected),
    evidence.hook.lines,
    mapping,
    G4E_CAPTURE_QUIT_FRAME,
  );
  const censusProblems = evidence.hook.problem
    ? [`resources.jsonl ${evidence.hook.problem}`]
    : [];
  censusProblems.push(
    ...evaluateLayoutCensus(asLayout(expected), census, capture.full, mapping),
  );
  if (mapping.size === 0)
    censusProblems.push("no page mapping (atlas-hash-parity found none)");
  const image = evaluateExpectedImage(g4, "reference-msdf", reference);
  const inkRef = evaluateInkPresence(g4, reference);
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

  // atlas-pages-msdf: per step, the oracle's pages equal the capture's mapped wire textures in
  // count, format and shape, and no other wire texture than the engine's exists.
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
    for (const e of wirePages)
      if (
        e.format !== expected.page.format ||
        e.width !== expected.page.width ||
        e.height !== expected.page.height
      )
        pageProblems.push(
          `step ${s.step}: wire page ${e.id} is ${e.format} ${e.width}x${e.height}`,
        );
  }

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
      "fixture-env-msdf",
      "MSDF env.json is identical across capture, reference and reference-repeat, names the Advanced TextServer, carries the pinned font's sha256, FM's D3 pins with MSDF on at msdf_size 48 and msdf_pixel_range 24 (D5) and DF's as G4a's, the Q1e project settings, viewport oversampling 1.0 and tool locale en",
      evaluateFixtureEnv(envs, ctx.lock, msdfFontPins()),
      "identical across capture, reference, reference-repeat; FM (MSDF 48/24) and DF pinned",
      Object.keys(envs).map((l) => join(root, l, "env.json")),
    ),
    checkOf(
      "oracle-agrees-msdf",
      "the MSDF oracle equals expected.json at every settle step: the Labels, texts, fonts, sizes, colours and outline sizes, text-pass glyphs = ink glyphs, every pass's commands = ink x passes (outline then text), every glyph an MSDF glyph of the one msdf_size 48 cache with outline as its pass sets it, px_range 24 and scale size/48, one 512x512 RGBA8 page, and the distinct glyphs drawn equal the glyphs rasterized; reference and reference-repeat wrote byte-identical logs",
      evaluateMsdfOracle(expected, oracles),
      `${oracle.lines.length} oracle lines, identical across reference and reference-repeat`,
      oracles.map((o) => o.path),
    ),
    checkOf(
      "glyph-commands-msdf",
      "on both sinks' settle transactions every Label's commands equal the oracle's glyph commands in count and draw order (outline pass, then text pass), as add_msdf_texture_rect_region with rect and src bit for bit the oracle's float32 result of Q1g's MSDF formula, modulate the pass colour, outline, px_range and scale as the oracle computes them, and tex the wire id of the page; the panel, R and the marker carry no texture command",
      [
        ...glyphFull.problems.slice(0, 10),
        ...glyphPatch.problems.slice(0, 10).map((p) => `patch: ${p}`),
      ],
      `${Object.values(glyphFull.commands).reduce((a, b) => a + b, 0)} msdf commands over ${expected.steps.length} settle transactions x 2 sinks equal the oracle (${Object.values(glyphFull.commands).join("/")})`,
      [oracle.path, capture.full.path, capture.patch.path],
    ),
    checkOf(
      "msdf-args",
      "on every transaction of both sinks every msdf command has px_range 24, a scale of size/48 for a size the fixture draws and outline 0 or 4; at each settle step each Label's commands carry its own scale and exactly ink outline commands at 4 while its outline is on; no command or entry is a typed msdf refusal and no glyph is a plain region command",
      [...argsFull.problems, ...argsPatch.problems.map((p) => `patch: ${p}`)],
      `${argsFull.total} msdf commands on the full sink (${argsFull.outlined} outline-pass), all with px_range 24`,
      [capture.full.path, capture.patch.path],
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
      "atlas-census-msdf",
      `from the hook log (windows [applied_k, applied_k+1) through quit ${G4E_CAPTURE_QUIT_FRAME}), the one ${expected.msdf.cache} page is created once at step 0 and updated once per Label draw that adds glyphs (twice at step 7), zero times at the size change (step 2), the outline toggle (step 3) and every other quiet step (${expected.quiet_steps.join(",")}), each call in its step's applied frame, last hook versions and settle wire versions as predicted, the page RGBA8 512x512 on the wire, and the only other texture the 800x6 ColorPicker strip`,
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
      "atlas-pages-msdf",
      "at every settle step the oracle's pages equal the capture's mapped wire textures in count, format and shape (one 512x512 RGBA8 page), and no other wire texture than the engine's exists",
      pageProblems,
      `one ${expected.page.format} ${expected.page.width}x${expected.page.height} page at every step`,
      [oracle.path, capture.full.path],
    ),
    checkOf(
      "expected-image-reference-msdf",
      "every reference-msdf shot equals synthesizeGate4 exactly outside the text regions: the clear colour, the panel and the marker",
      image.problems,
      `${shotsOf(g4).length} reference shots exact outside the text regions`,
      [join(root, "reference", "shots")],
    ),
    checkOf(
      "ink-presence-reference-msdf",
      "in every reference-msdf settle shot each text region has at least 6 x ink_glyphs differing pixels, a region differs from the previous step's exactly when expected.json says fresh (text, size, colour, outline or R's rotation changed), and each early shot's text regions equal its step's settle shot",
      inkRef.problems,
      `ink in ${expected.text_nodes.length} regions x ${expected.steps.length} steps as expected; early shots settled`,
      [join(root, "reference", "shots")],
    ),
    checkOf(
      "reference-repeat-budget-msdf",
      "reference-msdf vs reference-msdf-repeat (same build, GPU and driver, oracle on in both): every shot compared in full and per region; the measured per-region maxima are the MSDF budget (D8, expected 0)",
      repeatCmp.problems.filter((p) => p.includes("missing")),
      `measured budget: ${repeatCmp.budgets.map((b) => `${b.region} ${b.max_channel_delta}/${b.mismatched_pixels}px`).join(", ")}`,
      [
        join(root, "reference", "shots"),
        join(root, "reference-repeat", "shots"),
      ],
    ),
    checkOf(
      "armed-transparent-msdf",
      "reference-msdf-armed (extension armed, stream on, oracle off) armed with its stream closed and equals reference-msdf exactly at every shot",
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
    if (
      !(await readTextOrUndefined(join(root, "import", "fonts.log")))?.includes(
        " ok ",
      )
    )
      problems.push("msdf/import/fonts.log does not record a provisioned font");
    checks.push(
      checkOf(
        "support-legs-exit-msdf",
        "fonts were provisioned for fixtures/gate4-msdf and its import, the receiver import, reference-msdf, -repeat, -armed and the headless receiver trace exited 0",
        problems,
        "6 support legs exited 0",
        [join(root, "import", "fonts.log")],
      ),
    );
  }
  checks.push(tag(checkCaptureLegClass(capture)));
  legs["capture-msdf"] = {
    group: "g4e",
    expected_class: capture.expected_class,
    result_class: capture.result_class,
    reasons: capture.reasons,
    harmless_ties: capture.harmless_ties,
    exit_code: capture.exit_code,
    artifacts: capture.artifacts,
  };
  for (const [leg, dir] of [
    ["reference-msdf", "reference"],
    ["reference-msdf-repeat", "reference-repeat"],
    ["reference-msdf-armed", "reference-armed"],
    ["receiver-msdf-headless-trace", "receiver-headless-trace"],
  ] as const)
    legs[leg] = {
      group: "g4e",
      expected_class: null,
      result_class: null,
      reasons: [],
      exit_code: await readExitCode(join(root, dir)),
      artifacts: [join(root, dir)],
    };

  // --- receivers ---
  const seqs = receiverStepSeqs(g4, capture.full);
  const receiverLegs: ReceiverLegInfo[] = [];
  let checkpoints: Gate4Checkpoint[] = image.checkpoints;
  const receiverShots: Record<string, Map<string, Frame | null>> = {};
  const applied: Record<string, AppliedJson | undefined> = {};
  for (const [leg, dir, rec] of [
    ["receiver-msdf", "receiver", capture.full],
    ["receiver-msdf-patch", "receiver-patch", capture.patch],
  ] as const) {
    const a = await readJson<AppliedJson>(join(root, dir, "applied.json"));
    applied[leg] = a;
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
        applied: a,
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
      group: "g4e",
      expected_class: "success",
      result_class: cls.result_class,
      reasons: cls.reasons,
      harmless_ties: cls.harmless_ties,
      exit_code: await readExitCode(join(root, dir)),
      artifacts: [join(root, dir, "applied.json")],
    };
    receiverLegs.push({ leg, dir: join(root, dir), applied: a });
  }
  receiverLegs.push({
    leg: "receiver-msdf-headless-trace",
    dir: join(root, "receiver-headless-trace"),
    applied: await readJson<AppliedJson>(
      join(root, "receiver-headless-trace", "applied.json"),
    ),
  });
  const vsRef = evaluateWithinBudget(
    g4,
    reference,
    receiverShots["receiver-msdf"],
    repeatCmp.budgets,
  );
  const vsRefPatch = evaluateWithinBudget(
    g4,
    reference,
    receiverShots["receiver-msdf-patch"],
    repeatCmp.budgets,
  );
  const imageReceiver = evaluateExpectedImage(
    g4,
    "receiver-msdf",
    receiverShots["receiver-msdf"],
  );
  checkpoints = [...checkpoints, ...imageReceiver.checkpoints];
  const inkReceiver = evaluateInkPresence(g4, receiverShots["receiver-msdf"]);
  // applied.json msdf_commands (Q5): seq 1 replays every step-0 msdf command.
  const msdfProblems: string[] = [];
  const step0 = Object.values(expected.steps[0].commands).reduce(
    (a, b) => a + b,
    0,
  );
  for (const leg of ["receiver-msdf", "receiver-msdf-patch"]) {
    const txs = (applied[leg]?.transactions ?? []) as {
      seq?: number;
      msdf_commands?: number | null;
    }[];
    if (txs.length === 0) msdfProblems.push(`${leg}: no transactions`);
    if (txs.some((t) => typeof t.msdf_commands !== "number"))
      msdfProblems.push(`${leg}: a transaction without msdf_commands`);
    const first = txs.find((t) => t.seq === 1);
    if (first?.msdf_commands !== step0)
      msdfProblems.push(
        `${leg}: seq 1 replayed ${first?.msdf_commands} msdf commands, step 0 has ${step0}`,
      );
  }
  const appliedFull = applied["receiver-msdf"];
  const appliedPatch = applied["receiver-msdf-patch"];
  checks.push(
    checkOf(
      "receiver-vs-reference-msdf",
      "receiver-msdf and receiver-msdf-patch shots (re-keyed from wire seq to fixture step, early shots included) are within the measured MSDF budget of reference-msdf, full frame and every region (D8: the reference-repeat maxima, never relaxed)",
      [
        ...vsRef.problems.map((p) => `receiver: ${p}`),
        ...vsRefPatch.problems.map((p) => `patch: ${p}`),
      ],
      `receiver ${vsRef.measured.map((b) => `${b.region} ${b.max_channel_delta}`).join(", ")} (budget ${repeatCmp.budgets.map((b) => b.max_channel_delta).reduce((a, b) => Math.max(a, b), 0)})`,
      [join(root, "receiver", "shots"), join(root, "receiver-patch", "shots")],
    ),
    checkOf(
      "expected-image-receiver-msdf",
      "every receiver-msdf shot equals synthesizeGate4 exactly outside the text regions",
      imageReceiver.problems,
      `${shotsOf(g4).length} receiver shots exact outside the text regions`,
      [join(root, "receiver", "shots")],
    ),
    checkOf(
      "ink-presence-receiver-msdf",
      "receiver-msdf's settle shots carry the reference's ink presence and freshness",
      inkReceiver.problems,
      `ink in ${expected.text_nodes.length} regions x ${expected.steps.length} steps as expected`,
      [join(root, "receiver", "shots")],
    ),
    checkOf(
      "receiver-msdf-commands",
      "both receivers' applied.json carry msdf_commands on every transaction (gate4-design.md Q5), and seq 1 replays every step-0 msdf command as canvas_item_add_msdf_texture_rect_region",
      msdfProblems,
      `seq 1 replayed ${step0} msdf commands on both sinks`,
      [
        join(root, "receiver", "applied.json"),
        join(root, "receiver-patch", "applied.json"),
      ],
    ),
    checkOf(
      "resource-quiet-msdf",
      `the quiet steps (${expected.quiet_steps.join(",")}: the size change, the outline toggle, colour, rotation and placement-only steps) fetch and upload nothing on either sink's receiver`,
      [
        ...evaluateResourceQuiet(g4, appliedFull, G4E_CAPTURE_QUIT_FRAME).map(
          (p) => `receiver: ${p}`,
        ),
        ...evaluateResourceQuiet(g4, appliedPatch, G4E_CAPTURE_QUIT_FRAME).map(
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

  // --- sabotages ---
  const predictions = expected.predictions;
  const sabotage = async (
    leg: string,
    capDir: string,
    recvDir: string,
    exp: Gate4Expected,
    refDir: string,
    refShots: ReadonlyMap<string, Frame | null>,
    steps: number[],
    regions: Record<string, string[]> | null,
  ): Promise<{
    checks: Gate4Check[];
    entry: LegEntry;
    full: RecordingSummary;
  }> => {
    const result = await readJson<CaptureResultJson>(
      join(capDir, "evidence", "result.json"),
    );
    const full = await loadRecording(join(capDir, RECORDING_NAME));
    const sSeqs = receiverStepSeqs(exp, full);
    const shots = await loadReceiverShots(
      outDir,
      recvDir.slice(outDir.length + 1),
      exp,
      sSeqs,
    );
    const a = await readJson<AppliedJson>(join(recvDir, "applied.json"));
    const cps = computeGate4Checkpoints(
      exp,
      refDir,
      refShots,
      recvDir,
      shots,
      sSeqs.settle,
    );
    const cls = classifyLeg({
      captureResult: result,
      recording: full,
      // The runner shoots only the settle seqs on a sabotage receiver (memory:
      // rs-g4b-receiver-checker-facts).
      receiver: {
        applied: a,
        requestedShotSeqs: [...sSeqs.settle.values()],
        shotFiles: await shotSeqsPresent(recvDir),
      },
      checkpoints: cps,
    });
    const out: Gate4Check[] = [
      checkLegClass(
        leg,
        cls,
        cps,
        { class: "pixel-mismatch", mismatchSteps: steps },
        [join(capDir, RECORDING_NAME), join(recvDir, "applied.json")],
      ),
    ];
    if (regions)
      out.push(
        checkOf(
          `${leg}-regions`,
          `on ${leg}'s receiver every differing pixel lies in the predicted regions (expected.json predictions: ${JSON.stringify(regions)}) and each predicted region differs`,
          evaluatePredictedRegions(exp, cps, regions),
          `mismatch confined to ${[...new Set(Object.values(regions).flat())].join(",")}`,
          [recvDir],
        ),
      );
    receiverLegs.push({ leg: `${leg}-receiver`, dir: recvDir, applied: a });
    return {
      checks: out,
      full,
      entry: {
        group: "g4e",
        expected_class: "pixel-mismatch",
        result_class: cls.result_class,
        reasons: cls.reasons,
        harmless_ties: cls.harmless_ties,
        exit_code: await readExitCode(recvDir),
        artifacts: [
          join(capDir, RECORDING_NAME),
          join(recvDir, "applied.json"),
        ],
      },
    };
  };

  const perturbPred = predictions[G4E_PERTURB];
  {
    const r = await sabotage(
      G4E_PERTURB,
      join(root, "sabotage-perturb-glyph", "capture"),
      join(root, "sabotage-perturb-glyph", "receiver"),
      g4,
      join(root, "reference"),
      reference,
      perturbPred?.steps ?? [],
      perturbPred?.regions ?? {},
    );
    checks.push(...r.checks);
    const recorded = evaluatePerturbRecorded(
      g4,
      capture.full,
      r.full,
      perturbPred?.regions ?? {},
    );
    checks.push(
      checkOf(
        `${G4E_PERTURB}-recorded`,
        "the perturb-glyph capture's settle transactions carry every msdf command of the predicted Labels with rect.x + 0.25 (float32) against the clean capture, src and everything else bit for bit, and every other Label's commands unchanged",
        recorded.problems,
        `${recorded.moved} msdf commands moved by +0.25 across the settle steps`,
        [r.full.path, capture.full.path],
      ),
    );
    legs[G4E_PERTURB] = r.entry;
  }
  const dropPred = predictions[G4E_DROP];
  {
    const r = await sabotage(
      G4E_DROP,
      join(root, "capture"),
      join(root, "sabotage-receiver-drop", "receiver"),
      g4,
      join(root, "reference"),
      reference,
      dropPred?.steps ?? [],
      dropPred?.regions ?? {},
    );
    const dropApplied = receiverLegs.at(-1)?.applied as
      | { transactions?: { msdf_commands?: number | null }[] }
      | undefined;
    const replayed = (dropApplied?.transactions ?? []).reduce(
      (n, t) => n + (t.msdf_commands ?? 0),
      0,
    );
    checks.push(...r.checks);
    checks.push(
      checkOf(
        `${G4E_DROP}-silent`,
        "the drop-msdf receiver replays no msdf command (applied.json msdf_commands 0 on every transaction) and records no unsupported entry of its own: the pre-/3 picture without its typed record",
        [
          ...(replayed !== 0 ? [`${replayed} msdf commands replayed`] : []),
          ...(
            (dropApplied as { unsupported?: { name?: string }[] } | undefined)
              ?.unsupported ?? []
          )
            .filter((u) => u.name === MSDF_METHOD)
            .map((u) => `unsupported ${u.name}`),
        ],
        "0 msdf commands replayed, no msdf unsupported entry",
        [join(root, "sabotage-receiver-drop", "receiver", "applied.json")],
      ),
    );
    legs[G4E_DROP] = r.entry;
  }
  {
    const grayPred = (
      ctx.grayExpected.predictions as Record<
        string,
        { steps: number[]; regions?: Record<string, string[]> }
      >
    )[G4E_GRAY];
    const grayRef = await loadShots(outDir, "reference", ctx.grayExpected);
    const r = await sabotage(
      G4E_GRAY,
      join(root, "sabotage-gray-perturb-glyph", "capture"),
      join(root, "sabotage-gray-perturb-glyph", "receiver"),
      ctx.grayExpected,
      join(outDir, "reference"),
      grayRef,
      grayPred?.steps ?? [],
      grayPred?.regions ?? null,
    );
    checks.push(...r.checks);
    const grayClean = await loadRecording(
      join(outDir, "capture", RECORDING_NAME),
    );
    const recorded = evaluatePerturbRecorded(
      ctx.grayExpected,
      grayClean,
      r.full,
      grayPred?.regions ?? {},
    );
    checks.push(
      checkOf(
        `${G4E_GRAY}-recorded`,
        "the gray perturb-glyph capture (fixtures/gate4) carries every add_texture_rect_region of the predicted Labels with rect.x + 0.25 (float32) against g4a's clean capture, src and everything else bit for bit, and every other Label's commands unchanged: the integer path moved by a quarter pixel",
        recorded.problems,
        `${recorded.moved} region commands moved by +0.25 across the settle steps`,
        [r.full.path, grayClean.path],
      ),
    );
    legs[G4E_GRAY] = r.entry;
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

  const text = textReport(
    g4,
    capture.full,
    evidence.hook.lines,
    mapping,
    {},
    G4E_CAPTURE_QUIT_FRAME,
  );
  for (const [k, n] of Object.entries(glyphFull.commands))
    if (text[k]) text[k].msdf_commands = n;
  for (const page of Object.values(text).flatMap((t) => t.pages))
    page.size = expected.msdf.msdf_size;

  return {
    checks,
    legs,
    checkpoints,
    text,
    parity: parityCheck.table,
    budgets: repeatCmp.budgets,
    receiver_measured: vsRef.measured,
    census,
    ink: inkRef.ink,
  };
}

// Re-exported so the report and the self-test can name the region set in one place.
export { gate4Regions };
