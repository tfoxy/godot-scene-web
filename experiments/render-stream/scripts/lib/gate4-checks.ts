// Gate 4 checks and leg classification (protocol/gate4-design.md "Q7" and "G4a").
//
// Everything here reads an evidence directory written by run-gate4.sh, or is pure over values
// already read from one, so scripts/test/self-test-gate4.ts can drive each check with synthetic
// values. Nothing launches a process. Classification never reads `session.sabotage`. Result
// classes are gate 2's, unchanged (D11).
//
// Group g4a: the Latin grayscale fixture's capture (both sinks and the store), its rendered
// reference with the glyph oracle on, a same-build repeat with the oracle on, and an extension-
// armed reference with the oracle off. Text is checked four independent ways: the oracle against
// expected.json's hand census (`oracle-agrees`), the capture's glyph commands against the
// oracle's quads (`glyph-commands`), the capture's atlas payloads against the oracle's page
// images (`atlas-hash-parity`, `atlas-append-only`), and the hook log against the census
// (`atlas-census`). Pixels outside the text regions are exact; inside them ink presence and
// freshness are checked (G4b adds synthesized ink).
//
// Evidence layout under <out>/ (see scripts/README.md "Gate 4"):
//   legs.json, binary.json
//   import/fonts.log               provision-fonts.sh
//   import/fixture/                editor --import of fixtures/gate4
//   capture/                       400-frame capture host, GRC_ROOT_SIZE=enforce-min-size:
//                                  evidence/ (result, counters, resources.jsonl, ...),
//                                  recording.rs2, recording-patch.rs2, store/, steps.jsonl,
//                                  env.json, strace.txt, maps.txt
//   reference/, reference-repeat/  rendered fixture, extension absent, oracle on: shots/step-<k>.png,
//                                  shots/early-<k>.png, steps.jsonl, env.json,
//                                  oracle/glyphs.jsonl, oracle/pages/<sha256>.grt
//   reference-armed/               rendered, extension armed with a full-sink stream, oracle off:
//                                  shots, steps.jsonl, evidence/, recording.rs2, store/

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  decodePngRgba,
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type AppliedJson,
  type AppliedResources,
  type CaptureResultJson,
  type Checkpoint,
  checkCaptureArmed,
  checkHeadlessNoGpuGate0,
  checkReceiverNeverLoadedFixture,
  classifyLeg,
  diffRgba,
  firstTransactionWithRectColor,
  type Gate0Check,
  type LegClass,
  loadRecording,
  parseStepLog,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
  type StepLine,
  type Transaction,
} from "./gate0-checks";
import {
  type CaptureEvidence,
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
  type Gate3CaptureEvaluation,
  type Gate3Check,
} from "./gate3-checks";
import {
  type AtlasPageImage,
  appendOnlyViolations,
  type Box4,
  boxEqual,
  cacheKeyOf,
  compareSynthesizedText,
  deriveCensus,
  type Gate4Expected,
  inkPixels,
  type OracleLine,
  type OraclePage,
  pageKeyOf,
  type Rect4,
  stepFrames4,
  stepOfFrame4,
  synthesizeGate4,
  synthesizeText,
} from "./gate4-expected";
import { decodeTexturePayload, payloadSha256 } from "./render-stream-2";

// ---------------------------------------------------------------------------------------------
// Constants of the contract
// ---------------------------------------------------------------------------------------------

/** The capture leg's quit frame, as gates 0-3: one transaction per frame, and long enough for
 * the /proc maps/fd sample (As built: the contract's leg table said 102). */
export const G4A_CAPTURE_QUIT_FRAME = 400;

export type Gate4Check = Gate3Check;

export const ALL_GROUPS = ["g4a", "g4b", "g4c", "g4d", "g4e", "g4f"] as const;
/** Groups whose increment has landed; run-gate4.sh's LANDED_GROUPS must say the same. */
export const LANDED_GROUPS: readonly string[] = ["g4a", "g4b", "g4c", "g4d"];

/** G4b: the unchanged receiver on the main capture's full and patch sinks, a headless openat
 * trace, and the three sabotage legs (gate4-design.md "G4b"). */
export const G4B_RECEIVER_LEGS = ["receiver", "receiver-patch"] as const;
export const G4B_SABOTAGE_KINDS = ["freeze", "perturb", "omit-atlas"] as const;
export type G4bSabotageKind = (typeof G4B_SABOTAGE_KINDS)[number];

export const G4A_SUPPORT_LEGS = [
  "import",
  "reference",
  "reference-repeat",
  "reference-armed",
] as const;

/** The legs whose oracle runs (Q6c): both reference legs, never the armed one. */
export const ORACLE_LEGS = ["reference", "reference-repeat"] as const;

/** Q1e/D3 pins as env.json records them. */
export const TEXT_SERVER_NAME = "ICU / HarfBuzz / Graphite (Built-in)";
export const FONT_PINS: Record<string, Record<string, unknown>> = {
  F: {
    antialiasing: 1,
    hinting: 1,
    force_autohinter: false,
    subpixel_positioning: 0,
    multichannel_signed_distance_field: false,
    allow_system_fallback: false,
    generate_mipmaps: false,
    disable_embedded_bitmaps: true,
    oversampling: 0,
    keep_rounding_remainders: true,
    fallbacks: 0,
  },
  // The default theme font is built by the engine from the gui/theme/default_font_* settings
  // (scene/theme/default_theme.cpp:1350-1356); its other properties are the FontFile defaults.
  DF: {
    antialiasing: 1,
    hinting: 1,
    force_autohinter: false,
    subpixel_positioning: 0,
    multichannel_signed_distance_field: false,
    generate_mipmaps: false,
    disable_embedded_bitmaps: true,
    oversampling: 0,
    fallbacks: 0,
  },
};
export const SETTING_PINS: Record<string, unknown> = {
  "internationalization/rendering/text_driver": "",
  "internationalization/rendering/root_node_layout_direction": 1,
  "internationalization/locale/test": "en",
  "internationalization/locale/fallback": "en",
  "gui/theme/default_font_antialiasing": 1,
  "gui/theme/default_font_hinting": 1,
  "gui/theme/default_font_subpixel_positioning": 0,
  "gui/theme/default_font_multichannel_signed_distance_field": false,
  "gui/theme/default_font_generate_mipmaps": false,
  "gui/theme/lcd_subpixel_layout": 1,
  "gui/theme/default_theme_scale": 1,
  "gui/theme/custom": "",
  "gui/theme/custom_font": "",
  "gui/common/snap_controls_to_pixels": true,
  "display/window/stretch/mode": "disabled",
  "display/window/stretch/scale": 1,
};

const LEVELS = new Set([0, 51, 102, 153, 204, 255]);

export function check(
  id: string,
  criterion: string,
  problems: string[],
  okDetail: string,
  evidence: string[],
): Gate4Check {
  return {
    id,
    criterion,
    passed: problems.length === 0,
    status: problems.length === 0 ? "pass" : "fail",
    detail: problems.length === 0 ? okDetail : problems.join("; "),
    evidence,
  };
}

function fromGate0(c: Gate0Check): Gate4Check {
  return { ...c, status: c.passed ? "pass" : "fail" };
}

const f32 = (v: number): number => Math.fround(v);
const f32eq = (a: readonly number[] | undefined, b: readonly number[]) =>
  !!a && a.length === b.length && a.every((v, i) => f32(v) === f32(b[i]));

// ---------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------

export interface Gate4Shot {
  /** "step-<k>.png" or "early-<k>.png" */
  file: string;
  step: number;
  kind: "settle" | "early";
}

export function shotsOf(expected: Gate4Expected): Gate4Shot[] {
  const out: Gate4Shot[] = expected.steps.map((s) => ({
    file: `step-${s.step}.png`,
    step: s.step,
    kind: "settle" as const,
  }));
  for (const k of expected.early_shot_steps)
    out.push({ file: `early-${k}.png`, step: k, kind: "early" });
  return out;
}

export interface Frame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Every shot of one leg, decoded (null when missing or unreadable). */
export async function loadShots(
  outDir: string,
  leg: string,
  expected: Gate4Expected,
): Promise<Map<string, Frame | null>> {
  const out = new Map<string, Frame | null>();
  for (const s of shotsOf(expected)) {
    const png = await decodePngRgba(join(outDir, leg, "shots", s.file));
    out.set(
      s.file,
      png ? { width: png.width, height: png.height, rgba: png.data } : null,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// expected-self-consistent
// ---------------------------------------------------------------------------------------------

function boxInside(b: Box4, r: Rect4): boolean {
  return (
    b[0] >= r[0] && b[1] >= r[1] && b[2] <= r[0] + r[2] && b[3] <= r[1] + r[3]
  );
}

function boxesOverlap(a: Box4, b: Box4): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** expected.json obeys its own rules (Q6 colour rule, regions, the census re-derived). */
export function checkExpectedSelfConsistent(
  expected: Gate4Expected,
): Gate4Check {
  const problems: string[] = [];
  if (expected.schema !== "render-stream-gate4-expected/1")
    problems.push(`schema=${JSON.stringify(expected.schema)}`);
  const [w, h] = expected.viewport ?? [];
  if (w !== 640 || h !== 360)
    problems.push(`viewport=${JSON.stringify(expected.viewport)}`);
  const S = expected.start_frame_default;
  const N = expected.step_frames_default;
  const last = expected.last_step;
  if (expected.settle_offset !== 7) problems.push("settle_offset is not 7");
  if (expected.quit_frame_default !== S + N * last + 11)
    problems.push(
      `quit_frame_default ${expected.quit_frame_default} != S+N*last_step+11`,
    );
  const steps = expected.steps ?? [];
  if (
    steps.map((s) => s.step).join(",") !== [...Array(last + 1).keys()].join(",")
  )
    problems.push(`steps are ${steps.map((s) => s.step).join(",")}`);
  // Colour rule: components on the 0.2 grid; alpha 1 or the deliberate 0.6.
  const onGrid = (v: number) => Math.abs(v * 5 - Math.round(v * 5)) < 1e-9;
  const markers = new Set<string>();
  for (const s of steps) {
    for (const [name, t] of Object.entries(s.texts)) {
      if (!t.colour.every(onGrid) || (t.colour[3] !== 1 && t.colour[3] !== 0.6))
        problems.push(
          `step ${s.step}: ${name} colour ${t.colour.join(",")} breaks the colour rule`,
        );
    }
    if (
      !s.marker_rgba8.every((v) => LEVELS.has(v)) ||
      s.marker_rgba8[3] !== 255
    )
      problems.push(`step ${s.step}: marker colour breaks the colour rule`);
    markers.add(s.marker_rgba8.join(","));
    const f = stepFrames4(expected, s.step);
    if (s.applied_frame !== f.applied || s.settle_frame !== f.settle)
      problems.push(
        `step ${s.step}: frames ${s.applied_frame}/${s.settle_frame}`,
      );
    // Regions: disjoint, each inside one background, none in the marker region.
    const names = Object.keys(s.text_regions);
    for (let i = 0; i < names.length; i++) {
      const a = s.text_regions[names[i]];
      for (const b of names.slice(i + 1))
        if (boxesOverlap(a, s.text_regions[b]))
          problems.push(`step ${s.step}: regions ${names[i]} and ${b} overlap`);
      const inPanel = boxInside(a, expected.panel.rect);
      const bg = s.background[names[i]].join(",");
      const wantBg = (
        inPanel ? expected.panel.rgba8 : expected.clear_rgba8
      ).join(",");
      if (bg !== wantBg)
        problems.push(
          `step ${s.step}: ${names[i]} background ${bg} is not the ${inPanel ? "panel" : "clear colour"} ${wantBg}`,
        );
      const p = expected.panel.rect;
      if (!inPanel && boxesOverlap(a, [p[0], p[1], p[0] + p[2], p[1] + p[3]]))
        problems.push(`step ${s.step}: ${names[i]} straddles the panel`);
      const m = expected.regions.marker;
      if (boxesOverlap(a, [m[0], m[1], m[0] + m[2], m[1] + m[3]]))
        problems.push(`step ${s.step}: ${names[i]} overlaps the marker region`);
    }
  }
  if (markers.size !== steps.length)
    problems.push(
      `${markers.size} distinct marker colours for ${steps.length} steps`,
    );
  if (!expected.panel.rgba8.every((v) => LEVELS.has(v)))
    problems.push("panel colour breaks the colour rule");
  // The census columns, re-derived from the strings with Q1c's rules.
  const derived = deriveCensus(expected);
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
  for (const s of steps) {
    const d = derived[s.step];
    if (!d) continue;
    for (const key of [
      "new_glyphs",
      "page_uploads",
      "page_creates",
      "hook_versions",
      "ink_glyphs",
    ] as const)
      if (!same(d[key], s[key]))
        problems.push(
          `step ${s.step}: ${key} ${JSON.stringify(s[key])}, re-derived ${JSON.stringify(d[key])}`,
        );
    if (!same(s.wire_versions, s.hook_versions))
      problems.push(`step ${s.step}: wire_versions differ from hook_versions`);
  }
  for (const k of expected.quiet_steps ?? []) {
    const s = steps[k];
    if (
      s &&
      (Object.keys(s.page_uploads).length > 0 ||
        Object.keys(s.page_creates).length > 0)
    )
      problems.push(`quiet step ${k} has page traffic`);
  }
  return check(
    "expected-self-consistent",
    "expected.json obeys its rules: 640x360, steps 0..9 at S+N*k (settle +7), text colours on the 0.2 grid with alpha 1 or 0.6, one distinct marker colour per step, text regions disjoint and each inside one background (dark or the panel) and clear of the marker; the census columns (ink glyphs, new glyphs, uploads, creates, hook and wire versions) re-derived from the strings by gate4-design.md Q1c's rules equal the file's",
    problems,
    `${steps.length} steps, ${Object.keys(steps[0]?.text_regions ?? {}).length} text regions, census re-derived`,
    [],
  );
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
// step-alignment
// ---------------------------------------------------------------------------------------------

export async function checkStepAlignment(
  outDir: string,
  expected: Gate4Expected,
  recording: RecordingSummary,
): Promise<Gate4Check> {
  const want: StepLine[] = expected.steps.map((s) => ({
    step: s.step,
    applied_frame: s.applied_frame,
    settle_frame: s.settle_frame,
  }));
  const problems: string[] = [];
  const paths: string[] = [];
  for (const leg of ["capture", ...G4A_SUPPORT_LEGS.slice(1)]) {
    const path = join(outDir, leg, "steps.jsonl");
    paths.push(path);
    const got = parseStepLog(await readTextOrUndefined(path));
    if (JSON.stringify(got) !== JSON.stringify(want))
      problems.push(`${leg} steps.jsonl ${JSON.stringify(got)} != expected`);
  }
  problems.push(...markerAlignment(expected, recording.transactions));
  return check(
    "step-alignment",
    "capture and every reference steps.jsonl list steps 0..9 at S+N*k (settle +7), and each step's marker colour first appears in the capture transaction of its applied frame",
    problems,
    `marker colours first published at ${expected.steps.map((s) => `${s.step}@${s.applied_frame}`).join(", ")}`,
    [...paths, recording.path],
  );
}

export function markerAlignment(
  expected: Gate4Expected,
  transactions: readonly Transaction[],
): string[] {
  const problems: string[] = [];
  for (const s of expected.steps) {
    const t = firstTransactionWithRectColor(
      transactions,
      s.marker_rgba8.map((c) => c / 255),
    );
    if (t?.meta.frame !== s.applied_frame)
      problems.push(
        `step ${s.step}: marker colour first published at frame ${t?.meta.frame ?? "<none>"}, expected ${s.applied_frame}`,
      );
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// fixture-env
// ---------------------------------------------------------------------------------------------

export interface FontLockEntry {
  file: string;
  source: string;
  bytes: number;
  sha256: string;
  license: string;
  license_file: string;
  upstream: string;
}

export interface EnvJson {
  schema?: string;
  text_server?: string;
  font_files?: Record<string, string>;
  fonts?: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
  viewport_oversampling?: number;
  tool_locale?: string;
}

/** env.json identical across the legs given, and equal to the lock and the pins. */
export function evaluateFixtureEnv(
  envs: Record<string, EnvJson | undefined>,
  lock: readonly FontLockEntry[],
): string[] {
  const problems: string[] = [];
  const legs = Object.keys(envs);
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
  if (!first) return problems;
  if (first.schema !== "render-stream-gate4-env/1")
    problems.push(`schema ${JSON.stringify(first.schema)}`);
  if (first.text_server !== TEXT_SERVER_NAME)
    problems.push(
      `text_server ${JSON.stringify(first.text_server)}, expected ${TEXT_SERVER_NAME}`,
    );
  const files = first.font_files ?? {};
  for (const entry of lock)
    if (files[entry.file] !== entry.sha256)
      problems.push(
        `font ${entry.file} sha256 ${files[entry.file] ?? "<none>"}, lock ${entry.sha256}`,
      );
  for (const name of Object.keys(files))
    if (!lock.some((e) => e.file === name))
      problems.push(`font ${name} is not in fonts.lock.json`);
  for (const [key, pins] of Object.entries(FONT_PINS)) {
    const font = first.fonts?.[key];
    for (const [prop, want] of Object.entries(pins))
      if (font?.[prop] !== want)
        problems.push(
          `font ${key}.${prop} = ${JSON.stringify(font?.[prop])}, pinned ${JSON.stringify(want)}`,
        );
  }
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
  return problems;
}

export async function checkFixtureEnv(
  outDir: string,
  lock: readonly FontLockEntry[],
): Promise<Gate4Check> {
  const legs = ["capture", "reference", "reference-repeat"];
  const envs: Record<string, EnvJson | undefined> = {};
  for (const leg of legs)
    envs[leg] = await readJson<EnvJson>(join(outDir, leg, "env.json"));
  const problems = evaluateFixtureEnv(envs, lock);
  return check(
    "fixture-env",
    "env.json is identical across capture, reference and reference-repeat, names the Advanced TextServer, carries each font's sha256 as fonts.lock.json pins it, the D3 FontFile properties, the Q1e project settings, viewport oversampling 1.0 and tool locale en",
    problems,
    `identical across ${legs.join(", ")}; ${TEXT_SERVER_NAME}; ${lock.map((e) => `${e.file} ${e.sha256.slice(0, 12)}`).join(", ")}; oversampling 1.0`,
    legs.map((l) => join(outDir, l, "env.json")),
  );
}

// ---------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------

export interface OracleLog {
  leg: string;
  path: string;
  text: string | undefined;
  lines: OracleLine[];
  problem: string | null;
}

export async function loadOracle(
  outDir: string,
  leg: string,
): Promise<OracleLog> {
  const path = join(outDir, leg, "oracle", "glyphs.jsonl");
  const text = await readTextOrUndefined(path);
  const lines: OracleLine[] = [];
  let problem: string | null = text === undefined ? "missing" : null;
  for (const [i, raw] of (text ?? "").split("\n").entries()) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as OracleLine);
    } catch {
      problem = `line ${i + 1} is not JSON`;
      break;
    }
  }
  return { leg, path, text, lines, problem };
}

/** The oracle line of a step, or undefined. */
export function oracleAt(log: OracleLog, step: number): OracleLine | undefined {
  return log.lines.find((l) => l.step === step);
}

/** The oracle agrees with expected.json at every step (counts, glyph sets per page, pages), and
 * both oracle legs wrote byte-identical logs. */
export function evaluateOracleAgrees(
  expected: Gate4Expected,
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
  const seen = new Map<string, Set<number>>();
  for (const s of expected.steps) {
    const line = oracleAt(log, s.step);
    const fail = (t: string) => problems.push(`step ${s.step}: ${t}`);
    if (!line) {
      fail("no oracle line");
      continue;
    }
    if (line.frame !== s.settle_frame)
      fail(`oracle frame ${line.frame}, settle ${s.settle_frame}`);
    const visible = expected.text_nodes.filter((n) => s.texts[n].visible);
    const names = line.nodes.map((n) => n.name);
    if (names.join(",") !== visible.join(","))
      fail(
        `oracle nodes ${names.join(",")}, expected the visible ${visible.join(",")}`,
      );
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
      if (node.glyphs.length !== s.ink_glyphs[node.name])
        fail(
          `${node.name} ${node.glyphs.length} ink glyphs, expected ${s.ink_glyphs[node.name]}`,
        );
      if (node.lines !== 1) fail(`${node.name} has ${node.lines} lines`);
      for (const g of node.glyphs) {
        const key = cacheKeyOf(g);
        if (key !== cacheKeyOf(t))
          fail(`${node.name} glyph ${g.index} in ${key}`);
        const set = seen.get(`${key}#${g.page}`) ?? new Set<number>();
        set.add(g.index);
        seen.set(`${key}#${g.page}`, set);
      }
    }
    // Pages: count, format and shape per cache; the glyphs drawn so far per cache equal the
    // glyphs rasterized so far (every rasterized glyph is visible at some settle frame here).
    const byCache = new Map<string, OraclePage[]>();
    for (const p of line.pages) {
      const k = cacheKeyOf(p);
      byCache.set(k, [...(byCache.get(k) ?? []), p]);
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
    const caches = [...byCache.keys()].sort();
    const wantCaches = Object.keys(s.page_counts).sort();
    if (caches.join(",") !== wantCaches.join(","))
      fail(
        `oracle caches ${caches.join(",")}, expected ${wantCaches.join(",")}`,
      );
    for (const [k, n] of Object.entries(s.page_counts)) {
      if ((byCache.get(k)?.length ?? 0) !== n)
        fail(`${k} has ${byCache.get(k)?.length ?? 0} pages, expected ${n}`);
      let drawn = 0;
      for (const [pk, set] of seen)
        if (pk.startsWith(`${k}#`)) drawn += set.size;
      if (drawn !== s.page_glyphs[k])
        fail(
          `${k} holds ${drawn} distinct drawn glyphs so far, expected ${s.page_glyphs[k]}`,
        );
    }
  }
  return problems;
}

export function checkOracleAgrees(
  expected: Gate4Expected,
  logs: readonly OracleLog[],
): Gate4Check {
  const problems = evaluateOracleAgrees(expected, logs);
  const glyphs = logs[0]?.lines.reduce(
    (n, l) => n + l.nodes.reduce((m, x) => m + x.glyphs.length, 0),
    0,
  );
  return check(
    "oracle-agrees",
    "the reference's glyph oracle equals expected.json at every settle step: the visible text nodes, their text, font, size and colour, ink-glyph counts, one line each, one LA8 256x256 page per cache with the expected caches, and the distinct glyphs drawn per cache so far equal the glyphs rasterized so far; reference and reference-repeat wrote byte-identical oracle logs",
    problems,
    `${logs[0]?.lines.length ?? 0} oracle lines, ${glyphs ?? 0} glyph quads, identical across ${logs.map((l) => l.leg).join(" and ")}`,
    logs.map((l) => l.path),
  );
}

// ---------------------------------------------------------------------------------------------
// Names and the page mapping
// ---------------------------------------------------------------------------------------------

export interface NameMap4 {
  byName: Map<string, number>;
  byId: Map<number, string>;
  problems: string[];
}

/** Names to wire ids by creation order, cross-checked by P's and the marker's step-0 colours. */
export function mapNames4(
  expected: Gate4Expected,
  recording: RecordingSummary,
): NameMap4 {
  const ids = new Set<number>();
  for (const t of recording.transactions)
    for (const i of t.meta.items) ids.add(i.id);
  const sorted = [...ids].sort((a, b) => a - b);
  const names = [
    ...expected.creation_order,
    ...expected.created_later.map((c) => c.name),
  ];
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
  for (const [name, rgba] of [
    ["P", expected.panel.rgba8],
    ["Marker", expected.steps[0]?.marker_rgba8 ?? [0, 0, 0, 255]],
  ] as const) {
    const item = settle0?.meta.items.find((i) => i.id === byName.get(name));
    const want = rgba.map((c) => f32(c / 255));
    if (
      !item?.commands.some((c) => c.op === "add_rect" && f32eq(c.color, want))
    )
      problems.push(
        `${name} (id ${byName.get(name) ?? "?"}) has no add_rect in ${rgba.join(",")} at step 0`,
      );
  }
  return { byName, byId, problems };
}

export interface ParityCell {
  page: string;
  oracle_sha256: string;
  wire_id: number | null;
  wire_version: number | null;
  ok: boolean;
}

/** Per step, each oracle page against the settle transaction's texture table: the page's sha256
 * must be the hash of exactly one ok image texture, and a page keeps its wire id for life. */
function markFailing(
  failing: Record<string, number[]>,
  key: string,
  step: number,
): void {
  failing[key] = [...(failing[key] ?? []), step];
}

export function evaluateAtlasParity(
  expected: Gate4Expected,
  oracle: OracleLog,
  recording: RecordingSummary,
): {
  problems: string[];
  mapping: Map<string, number>;
  table: Record<string, ParityCell[]>;
  failing: Record<string, number[]>;
} {
  const problems: string[] = [];
  const mapping = new Map<string, number>();
  const table: Record<string, ParityCell[]> = {};
  const failing: Record<string, number[]> = {};
  for (const s of expected.steps) {
    const line = oracleAt(oracle, s.step);
    const tx = recording.transactions.find(
      (t) => t.meta.frame === s.settle_frame,
    );
    if (!line || !tx) {
      problems.push(
        `step ${s.step}: no ${line ? "settle transaction" : "oracle line"}`,
      );
      continue;
    }
    const cells: ParityCell[] = [];
    for (const p of line.pages) {
      const key = pageKeyOf(p);
      const hits = tx.meta.textures.filter(
        (e) => e.kind === "image" && e.status === "ok" && e.hash === p.sha256,
      );
      const cell: ParityCell = {
        page: key,
        oracle_sha256: p.sha256,
        wire_id: hits.length === 1 ? hits[0].id : null,
        wire_version: hits.length === 1 ? hits[0].version : null,
        ok: hits.length === 1,
      };
      if (hits.length !== 1) {
        problems.push(
          `step ${s.step}: page ${key} sha256 ${p.sha256.slice(0, 12)} is the hash of ${hits.length} wire textures`,
        );
        markFailing(failing, cacheKeyOf(p), s.step);
      } else {
        const id = hits[0].id;
        const before = mapping.get(key);
        if (before === undefined) mapping.set(key, id);
        else if (before !== id) {
          cell.ok = false;
          problems.push(
            `step ${s.step}: page ${key} moved from wire id ${before} to ${id}`,
          );
          markFailing(failing, cacheKeyOf(p), s.step);
        }
      }
      cells.push(cell);
    }
    table[s.step] = cells;
  }
  return { problems, mapping, table, failing };
}

export function checkAtlasHashParity(
  expected: Gate4Expected,
  oracle: OracleLog,
  full: RecordingSummary,
  patch: RecordingSummary,
): {
  check: Gate4Check;
  mapping: Map<string, number>;
  table: Record<string, ParityCell[]>;
} {
  const a = evaluateAtlasParity(expected, oracle, full);
  const b = evaluateAtlasParity(expected, oracle, patch);
  const problems = [...a.problems, ...b.problems.map((p) => `patch: ${p}`)];
  if (
    JSON.stringify([...a.mapping].sort()) !==
    JSON.stringify([...b.mapping].sort())
  )
    problems.push("the full and patch sinks map pages to different wire ids");
  const cells = Object.values(a.table).reduce((n, c) => n + c.length, 0);
  return {
    check: check(
      "atlas-hash-parity",
      "at every settle step, each page the rendered reference's oracle dumps (font_get_texture_image as a render-stream-texture/1 payload) has the sha256 of exactly one ok image texture in the capture's settle transaction, on both sinks, and keeps that wire id for its lifetime: headless rasterization is byte-identical to the rendered reference's",
      problems,
      `${cells} page cells match; pages ${[...a.mapping].map(([k, id]) => `${k}=${id}`).join(" ")}`,
      [oracle.path, full.path, patch.path],
    ),
    mapping: a.mapping,
    table: a.table,
  };
}

// ---------------------------------------------------------------------------------------------
// glyph-commands
// ---------------------------------------------------------------------------------------------

/** One sink's settle transactions against the oracle's glyphs. */
export function evaluateGlyphCommands(
  expected: Gate4Expected,
  oracle: OracleLog,
  recording: RecordingSummary,
  names: NameMap4,
  mapping: ReadonlyMap<string, number>,
): { problems: string[]; commands: Record<string, number> } {
  const problems: string[] = [];
  const commands: Record<string, number> = {};
  for (const s of expected.steps) {
    const line = oracleAt(oracle, s.step);
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
    let count = 0;
    for (const name of expected.creation_order) {
      const item = tx.meta.items.find((i) => i.id === names.byName.get(name));
      if (!item) {
        fail(`${name} is not in the settle transaction`);
        continue;
      }
      const textured = item.commands.filter((c) => c.op !== "add_rect");
      const node = line.nodes.find((n) => n.name === name);
      if (!expected.text_nodes.includes(name)) {
        if (textured.length > 0)
          fail(`${name} carries ${textured.length} texture commands`);
        continue;
      }
      if (item.commands.length !== textured.length)
        fail(`${name} carries a non-texture command`);
      const glyphs = node?.glyphs ?? [];
      if (textured.length !== glyphs.length) {
        fail(
          `${name} has ${textured.length} glyph commands, the oracle ${glyphs.length}`,
        );
        continue;
      }
      count += textured.length;
      for (const [i, c] of textured.entries()) {
        const g = glyphs[i];
        const page = `${g.font_key}@${g.size}/0#${g.page}`;
        const where = `${name} glyph ${i} (index ${g.index})`;
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
        if (!node || !f32eq(c.modulate, node.colour))
          fail(
            `${where}: modulate ${c.modulate?.join(",")}, oracle ${node?.colour.join(",")}`,
          );
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

export function checkGlyphCommands(
  expected: Gate4Expected,
  oracle: OracleLog,
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
    const names = mapNames4(expected, rec);
    const r = evaluateGlyphCommands(expected, oracle, rec, names, mapping);
    problems.push(
      ...[...names.problems, ...r.problems]
        .slice(0, 12)
        .map((p) => `${sink}: ${p}`),
    );
    if (sink === "full") commands = r.commands;
  }
  const total = Object.values(commands).reduce((n, c) => n + c, 0);
  return {
    check: check(
      "glyph-commands",
      "on both sinks' settle transactions, every text item's commands are add_texture_rect_region (transpose and clip_uv false) equal to the oracle's glyphs in count and order, with rect and src equal as float32 to the oracle's quad and uv, modulate its font colour, and tex the wire id atlas-hash-parity maps the glyph's page to; P and the marker carry no texture command",
      problems,
      `${total} glyph commands over ${expected.steps.length} settle transactions x 2 sinks equal the oracle (${Object.values(commands).join("/")})`,
      [oracle.path, full.path, patch.path],
    ),
    commands,
  };
}

// ---------------------------------------------------------------------------------------------
// atlas-append-only
// ---------------------------------------------------------------------------------------------

export interface PublishedVersion {
  id: number;
  version: number;
  hash: string;
  frame: number;
}

/** Each wire id's distinct published (version, hash) pairs in order of first appearance. */
export function publishedVersions(
  recording: RecordingSummary,
): Map<number, PublishedVersion[]> {
  const out = new Map<number, PublishedVersion[]>();
  for (const t of recording.transactions)
    for (const e of t.meta.textures) {
      if (e.kind !== "image" || e.status !== "ok" || !e.hash) continue;
      const list = out.get(e.id) ?? [];
      if (list.at(-1)?.version !== e.version)
        list.push({
          id: e.id,
          version: e.version,
          hash: e.hash,
          frame: t.meta.frame,
        });
      out.set(e.id, list);
    }
  return out;
}

/** Consecutive versions of each page write only texels that were empty. `payload` returns a
 * version's GRT1 bytes (from the store). */
export function evaluateAppendOnly(
  versions: Map<number, PublishedVersion[]>,
  pageIds: ReadonlyMap<string, number>,
  payload: (hash: string) => Uint8Array | undefined,
  empty: readonly number[],
): { problems: string[]; pairs: number; texels: number } {
  const problems: string[] = [];
  let pairs = 0;
  let texels = 0;
  for (const [page, id] of pageIds) {
    const list = versions.get(id) ?? [];
    for (let i = 1; i < list.length; i++) {
      const a = payload(list[i - 1].hash);
      const b = payload(list[i].hash);
      if (!a || !b) {
        problems.push(
          `${page}: a payload of v${list[i - 1].version}/v${list[i].version} is not in the store`,
        );
        continue;
      }
      let da: Uint8Array;
      let db: Uint8Array;
      try {
        if (
          payloadSha256(a) !== list[i - 1].hash ||
          payloadSha256(b) !== list[i].hash
        )
          throw new Error("hash mismatch");
        const pa = decodeTexturePayload(a);
        const pb = decodeTexturePayload(b);
        if (
          pa.format !== "LA8" ||
          pb.format !== "LA8" ||
          pa.width !== pb.width ||
          pa.height !== pb.height
        )
          throw new Error(
            `shapes ${pa.format} ${pa.width}x${pa.height} / ${pb.format} ${pb.width}x${pb.height}`,
          );
        da = pa.data;
        db = pb.data;
      } catch (e) {
        problems.push(
          `${page}: v${list[i - 1].version}->v${list[i].version}: ${(e as Error).message}`,
        );
        continue;
      }
      const r = appendOnlyViolations(da, db, empty);
      pairs++;
      texels += r.changed;
      if (r.changed === 0)
        problems.push(
          `${page}: v${list[i - 1].version}->v${list[i].version} changes nothing`,
        );
      if (r.violations.length > 0)
        problems.push(
          `${page}: v${list[i - 1].version}->v${list[i].version} rewrites ${r.violations.length} non-empty texels (first ${r.violations[0]})`,
        );
    }
  }
  return { problems, pairs, texels };
}

export async function checkAtlasAppendOnly(
  expected: Gate4Expected,
  captureDir: string,
  full: RecordingSummary,
  mapping: ReadonlyMap<string, number>,
): Promise<Gate4Check> {
  const versions = publishedVersions(full);
  const cache = new Map<string, Uint8Array | undefined>();
  for (const id of mapping.values())
    for (const v of versions.get(id) ?? [])
      if (!cache.has(v.hash)) {
        try {
          cache.set(
            v.hash,
            new Uint8Array(
              await readFile(
                join(captureDir, "store", "sha256", `${v.hash}.grt`),
              ),
            ),
          );
        } catch {
          cache.set(v.hash, undefined);
        }
      }
  const r = evaluateAppendOnly(
    versions,
    mapping,
    (h) => cache.get(h),
    expected.page.empty_texel,
  );
  if (mapping.size === 0)
    r.problems.push("no page mapping (atlas-hash-parity found none)");
  return check(
    "atlas-append-only",
    "consecutive published versions of every page (store payloads, hash-verified) differ only at texels that were empty -- LA8 (255,0) -- in the earlier one, and each new version changes at least one texel",
    r.problems,
    `${r.pairs} version pairs, ${r.texels} texels written, all onto empty texels`,
    [join(captureDir, "store"), full.path],
  );
}

// ---------------------------------------------------------------------------------------------
// atlas-census
// ---------------------------------------------------------------------------------------------

export interface CensusStep {
  /** per cache key: create and update counts, and the frames they happened in */
  pages: Record<
    string,
    { creates: number; updates: number; frames: number[]; versions: number[] }
  >;
  /** engine-call lines of any op in the step's window */
  lines: number;
  /** texture creates/updates of ids that are no page */
  engine: {
    frame: number;
    op: string;
    format: string | null;
    width: number | null;
    height: number | null;
  }[];
}

const UPLOAD_OPS = ["texture_2d_create", "texture_2d_update"];

/** The hook log per step window, pages named through `pageIds` (page key -> wire id). */
export function censusFromLog(
  expected: Gate4Expected,
  lines: readonly HookLine[],
  pageIds: ReadonlyMap<string, number>,
  quit: number,
): Record<string, CensusStep> {
  const keyOfId = new Map<number, string>();
  for (const [page, id] of pageIds) keyOfId.set(id, page.split("/")[0]);
  const out: Record<string, CensusStep> = {};
  for (const s of expected.steps)
    out[s.step] = { pages: {}, lines: 0, engine: [] };
  for (const l of lines) {
    if (!isEngineCall(l) || l.omitted === true) continue;
    const step = stepOfFrame4(expected, l.frame, quit);
    if (step < 0) continue;
    const bucket = out[step];
    bucket.lines++;
    if (!UPLOAD_OPS.includes(l.op)) continue;
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
      frames: [],
      versions: [],
    };
    bucket.pages[key] = p;
    if (l.op === "texture_2d_create") p.creates++;
    else p.updates++;
    if (!p.frames.includes(l.frame)) p.frames.push(l.frame);
    if (l.version !== null) p.versions.push(l.version);
  }
  return out;
}

export function evaluateAtlasCensus(
  expected: Gate4Expected,
  census: Record<string, CensusStep>,
  recording: RecordingSummary,
  pageIds: ReadonlyMap<string, number>,
): string[] {
  const problems: string[] = [];
  const engineWant = expected.engine_textures.map((e) => JSON.stringify(e));
  const engineGot: string[] = [];
  for (const s of expected.steps) {
    const c = census[s.step];
    const fail = (t: string) => problems.push(`step ${s.step}: ${t}`);
    if (!c) {
      fail("no census window");
      continue;
    }
    for (const e of c.engine) engineGot.push(JSON.stringify(e));
    const keys = new Set([
      ...Object.keys(c.pages),
      ...Object.keys(s.page_creates),
      ...Object.keys(s.page_uploads),
    ]);
    for (const key of keys) {
      const got = c.pages[key] ?? {
        creates: 0,
        updates: 0,
        frames: [],
        versions: [],
      };
      const wantCreates = s.page_creates[key] ?? 0;
      const wantUpdates = s.page_uploads[key] ?? 0;
      if (got.creates !== wantCreates || got.updates !== wantUpdates)
        fail(
          `${key}: ${got.creates} creates and ${got.updates} updates, expected ${wantCreates} and ${wantUpdates}`,
        );
      if (got.frames.some((f) => f !== s.applied_frame))
        fail(
          `${key}: uploads at frames ${got.frames.join(",")}, expected all at ${s.applied_frame}`,
        );
      const want = s.hook_versions[key];
      if (got.versions.length > 0 && got.versions.at(-1) !== want)
        fail(
          `${key}: last hook version ${got.versions.at(-1)}, expected ${want}`,
        );
    }
    if (expected.quiet_steps.includes(s.step) && c.lines > 0)
      fail(`${c.lines} texture lines in a quiet step's window`);
    // Wire versions at the settle transaction.
    const tx = recording.transactions.find(
      (t) => t.meta.frame === s.settle_frame,
    );
    for (const [key, want] of Object.entries(s.wire_versions)) {
      const id = pageIds.get(`${key}/0#0`);
      const e = tx?.meta.textures.find((x) => x.id === id);
      if (e?.version !== want)
        fail(
          `${key} (wire id ${id ?? "?"}) is v${e?.version ?? "<absent>"} on the wire, expected v${want}`,
        );
      if (
        e &&
        (e.format !== expected.page.format ||
          e.width !== expected.page.width ||
          e.height !== expected.page.height ||
          e.mipmaps !== expected.page.mipmaps)
      )
        fail(`${key} is ${e.format} ${e.width}x${e.height} on the wire`);
    }
  }
  if (
    JSON.stringify(engineGot.sort()) !== JSON.stringify([...engineWant].sort())
  )
    problems.push(
      `engine textures ${engineGot.join(" ")}, expected ${engineWant.join(" ")}`,
    );
  return problems;
}

export async function checkAtlasCensus(
  expected: Gate4Expected,
  capture: CaptureEvidence,
  full: RecordingSummary,
  pageIds: ReadonlyMap<string, number>,
): Promise<{ check: Gate4Check; census: Record<string, CensusStep> }> {
  const census = censusFromLog(
    expected,
    capture.hook.lines,
    pageIds,
    G4A_CAPTURE_QUIT_FRAME,
  );
  const problems = capture.hook.problem
    ? [`resources.jsonl ${capture.hook.problem}`]
    : [];
  problems.push(...evaluateAtlasCensus(expected, census, full, pageIds));
  if (pageIds.size === 0)
    problems.push("no page mapping (atlas-hash-parity found none)");
  const row = (k: number) =>
    Object.entries(census[k]?.pages ?? {})
      .map(
        ([key, p]) =>
          `${key} ${p.creates ? "c" : ""}${p.updates ? `u${p.updates}` : ""}@${p.frames.join("+")}`,
      )
      .join(" ");
  return {
    check: check(
      "atlas-census",
      `from the hook log (evidence/resources.jsonl, windows [applied_k, applied_k+1) through quit ${G4A_CAPTURE_QUIT_FRAME}), page creates and updates per step equal page_creates/page_uploads, all in the step's applied frame (step 7: two F@16 updates in one frame), the last hook version equals hook_versions, the settle transaction's version equals wire_versions, the quiet steps ${expected.quiet_steps.join(",")} have no texture line at all, and the only other upload is the engine's 800x6 ColorPicker strip at frame 1`,
      problems,
      expected.steps.map((s) => `${s.step}:{${row(s.step)}}`).join(" "),
      [capture.hook.path, full.path],
    ),
    census,
  };
}

// ---------------------------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------------------------

export interface Gate4Checkpoint {
  leg: string;
  shot: string;
  step: number;
  /** pixels outside the text regions that differ from synthesizeGate4 */
  mismatched_pixels: number | null;
  max_channel_delta: number | null;
  regions: {
    name: string;
    mismatched_pixels: number;
    max_channel_delta: number;
  }[];
}

/** One frame against synthesizeGate4 outside the text regions. */
export function compareOutsideText(
  expected: Gate4Expected,
  step: number,
  got: Frame,
): {
  mismatched: number;
  maxDelta: number;
  regions: Gate4Checkpoint["regions"];
} {
  const want = synthesizeGate4(expected, step);
  let mismatched = 0;
  let maxDelta = 0;
  const regionStats = Object.entries(expected.regions).map(([name, r]) => ({
    name,
    r,
    mismatched_pixels: 0,
    max_channel_delta: 0,
  }));
  for (let y = 0; y < want.height; y++)
    for (let x = 0; x < want.width; x++) {
      const p = y * want.width + x;
      if (want.mask[p]) continue;
      let d = 0;
      for (let c = 0; c < 4; c++)
        d = Math.max(d, Math.abs(want.rgba[p * 4 + c] - got.rgba[p * 4 + c]));
      if (d === 0) continue;
      mismatched++;
      maxDelta = Math.max(maxDelta, d);
      for (const rs of regionStats)
        if (
          x >= rs.r[0] &&
          x < rs.r[0] + rs.r[2] &&
          y >= rs.r[1] &&
          y < rs.r[1] + rs.r[3]
        ) {
          rs.mismatched_pixels++;
          rs.max_channel_delta = Math.max(rs.max_channel_delta, d);
        }
    }
  return {
    mismatched,
    maxDelta,
    regions: regionStats.map(
      ({ name, mismatched_pixels, max_channel_delta }) => ({
        name,
        mismatched_pixels,
        max_channel_delta,
      }),
    ),
  };
}

export function evaluateExpectedImage(
  expected: Gate4Expected,
  leg: string,
  shots: ReadonlyMap<string, Frame | null>,
): { problems: string[]; checkpoints: Gate4Checkpoint[] } {
  const problems: string[] = [];
  const checkpoints: Gate4Checkpoint[] = [];
  for (const s of shotsOf(expected)) {
    const got = shots.get(s.file);
    const cp: Gate4Checkpoint = {
      leg,
      shot: s.file,
      step: s.step,
      mismatched_pixels: null,
      max_channel_delta: null,
      regions: [],
    };
    checkpoints.push(cp);
    if (!got) {
      problems.push(`${s.file} missing or unreadable`);
      continue;
    }
    if (
      got.width !== expected.viewport[0] ||
      got.height !== expected.viewport[1]
    ) {
      problems.push(`${s.file}: ${got.width}x${got.height}`);
      continue;
    }
    const r = compareOutsideText(expected, s.step, got);
    cp.mismatched_pixels = r.mismatched;
    cp.max_channel_delta = r.maxDelta;
    cp.regions = r.regions;
    if (r.mismatched > 0)
      problems.push(
        `${s.file}: ${r.mismatched} pixels outside the text regions differ (max delta ${r.maxDelta}; ${
          r.regions
            .filter((x) => x.mismatched_pixels > 0)
            .map((x) => `${x.name} ${x.mismatched_pixels}`)
            .join(", ") || "elsewhere"
        })`,
      );
  }
  return { problems, checkpoints };
}

/** Ink presence and freshness per text region of the settle shots; each early shot's text
 * regions equal its step's settle shot (the reference is settled one frame after the change). */
export function evaluateInkPresence(
  expected: Gate4Expected,
  shots: ReadonlyMap<string, Frame | null>,
): { problems: string[]; ink: Record<string, Record<string, number>> } {
  const problems: string[] = [];
  const ink: Record<string, Record<string, number>> = {};
  for (const s of expected.steps) {
    const frame = shots.get(`step-${s.step}.png`);
    const prev = s.step > 0 ? shots.get(`step-${s.step - 1}.png`) : undefined;
    if (!frame) {
      problems.push(`step-${s.step}.png missing`);
      continue;
    }
    ink[s.step] = {};
    for (const name of expected.text_nodes) {
      const box = s.text_regions[name];
      const n = inkPixels(frame, box, s.background[name]);
      ink[s.step][name] = n;
      const want = s.ink_glyphs[name];
      if (want > 0 && n < 6 * want)
        problems.push(
          `step ${s.step}: ${name} has ${n} ink pixels, expected >= ${6 * want}`,
        );
      if (want === 0 && n > 0)
        problems.push(
          `step ${s.step}: ${name} has ${n} ink pixels, expected none`,
        );
      if (s.step > 0 && prev) {
        const differs = !boxEqual(frame, prev, box);
        if (differs !== s.fresh[name])
          problems.push(
            `step ${s.step}: ${name}'s region ${differs ? "differs from" : "equals"} step ${s.step - 1}'s, fresh=${s.fresh[name]}`,
          );
      }
    }
  }
  for (const k of expected.early_shot_steps) {
    const early = shots.get(`early-${k}.png`);
    const settle = shots.get(`step-${k}.png`);
    if (!early || !settle) {
      problems.push(`early-${k}.png or step-${k}.png missing`);
      continue;
    }
    const s = expected.steps[k];
    for (const name of expected.text_nodes)
      if (!boxEqual(early, settle, s.text_regions[name]))
        problems.push(
          `early-${k}.png: ${name}'s region differs from step-${k}.png`,
        );
  }
  return { problems, ink };
}

export interface RegionBudget {
  region: string;
  max_channel_delta: number;
  mismatched_pixels: number;
}

/** expected.json's named regions (marker, panel) plus every step-0 text region, as [x, y, w, h]
 * (text regions are the same box at every step, Q6b: a fixed, generous bounding box). Shared by
 * compareLegs and computeGate4Checkpoints (G4b) so both judge the same regions. */
export function gate4Regions(expected: Gate4Expected): Record<string, Rect4> {
  const regions: Record<string, Rect4> = { ...expected.regions };
  for (const [n, box] of Object.entries(expected.steps[0].text_regions))
    regions[n] = [box[0], box[1], box[2] - box[0], box[3] - box[1]];
  return regions;
}

/** Two legs' shots compared everywhere, per region (text regions, marker, panel) and in full. */
export function compareLegs(
  expected: Gate4Expected,
  a: ReadonlyMap<string, Frame | null>,
  b: ReadonlyMap<string, Frame | null>,
): { problems: string[]; budgets: RegionBudget[] } {
  const problems: string[] = [];
  const regions: Record<string, Rect4> = {
    full: [0, 0, expected.viewport[0], expected.viewport[1]],
    ...gate4Regions(expected),
  };
  const budgets = new Map<string, RegionBudget>();
  for (const name of Object.keys(regions))
    budgets.set(name, {
      region: name,
      max_channel_delta: 0,
      mismatched_pixels: 0,
    });
  for (const s of shotsOf(expected)) {
    const ia = a.get(s.file);
    const ib = b.get(s.file);
    if (!ia || !ib || ia.width !== ib.width || ia.height !== ib.height) {
      problems.push(
        `${s.file}: a shot is missing, unreadable or of another size`,
      );
      continue;
    }
    for (const [name, r] of Object.entries(regions)) {
      const d = diffRgba(ia.rgba, ib.rgba, ia.width, ia.height, r);
      const bud = budgets.get(name);
      if (!bud) continue;
      bud.max_channel_delta = Math.max(
        bud.max_channel_delta,
        d.max_channel_delta,
      );
      bud.mismatched_pixels += d.mismatched_pixels;
      if (name === "full" && d.mismatched_pixels > 0)
        problems.push(
          `${s.file}: ${d.mismatched_pixels} pixels differ (max channel delta ${d.max_channel_delta})`,
        );
    }
  }
  return { problems, budgets: [...budgets.values()] };
}

// ---------------------------------------------------------------------------------------------
// G4b: receiver legs, text synthesis, sabotages (gate4-design.md "G4b")
//
// No receiver, mirror or fixture file changes: the receiver already uploads LA8 pages lazily and
// replays add_texture_rect_region unchanged (gate4-design.md Q5). Everything here is new
// evidence and new checks over the unchanged receiver and the existing g4a capture/oracle.
// ---------------------------------------------------------------------------------------------

/** Step and "early" (Q6b "Intermediate shots") settle frames joined to the wire seq published at
 * that frame, from a capture's own recording -- the seq numbering a file-mode receiver (full or
 * patch sink) replays (both sinks share one seq space, gate1-design.md's receiver-patch leg). */
export interface ReceiverStepSeqs {
  settle: Map<number, number>;
  early: Map<number, number>;
  problems: string[];
}

export function receiverStepSeqs(
  expected: Gate4Expected,
  recording: Pick<RecordingSummary, "transactions">,
): ReceiverStepSeqs {
  const problems: string[] = [];
  const byFrame = new Map(
    recording.transactions.map((t) => [t.meta.frame, t.meta.seq]),
  );
  const settle = new Map<number, number>();
  for (const s of expected.steps) {
    const seq = byFrame.get(s.settle_frame);
    if (seq === undefined)
      problems.push(
        `no transaction at settle frame ${s.settle_frame} (step ${s.step})`,
      );
    else settle.set(s.step, seq);
  }
  const early = new Map<number, number>();
  for (const k of expected.early_shot_steps) {
    const frame = stepFrames4(expected, k).early;
    const seq = byFrame.get(frame);
    if (seq === undefined)
      problems.push(`no transaction at early frame ${frame} (step ${k})`);
    else early.set(k, seq);
  }
  return { settle, early, problems };
}

/** A receiver leg's shots re-keyed to the reference's filenames ("step-<k>.png",
 * "early-<k>.png") so every reference-shot evaluator (evaluateExpectedImage, evaluateInkPresence,
 * compareLegs, evaluateExpectedText) runs unchanged over a receiver leg: a receiver only knows
 * wire seqs ("shots/seq-<n>.png"), not fixture step numbers. `legRelDir` is relative to `outDir`
 * (e.g. "receiver", "receiver-patch", "sabotage-freeze/receiver"). */
export async function loadReceiverShots(
  outDir: string,
  legRelDir: string,
  expected: Gate4Expected,
  seqs: ReceiverStepSeqs,
): Promise<Map<string, Frame | null>> {
  const out = new Map<string, Frame | null>();
  const load = async (seq: number | undefined) => {
    if (seq === undefined) return null;
    const png = await decodePngRgba(
      join(outDir, legRelDir, "shots", `seq-${seq}.png`),
    );
    return png
      ? { width: png.width, height: png.height, rgba: png.data }
      : null;
  };
  for (const s of expected.steps)
    out.set(`step-${s.step}.png`, await load(seqs.settle.get(s.step)));
  for (const k of expected.early_shot_steps)
    out.set(`early-${k}.png`, await load(seqs.early.get(k)));
  return out;
}

async function shotSeqsPresentG4(dir: string): Promise<number[]> {
  try {
    const names = await readdir(join(dir, "shots"));
    return names
      .map((n) => /^seq-(\d+)\.png$/.exec(n)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);
  } catch {
    return [];
  }
}

/** Checkpoints over gate4Regions, for classifyLeg: a receiver leg's re-keyed shots against the
 * (unsabotaged) reference's. `seqOf` (step -> seq) fills Checkpoint.seq/.receiver_png. */
export function computeGate4Checkpoints(
  expected: Gate4Expected,
  referenceDir: string,
  referenceShots: ReadonlyMap<string, Frame | null>,
  receiverDir: string,
  receiverShots: ReadonlyMap<string, Frame | null>,
  seqOf: ReadonlyMap<number, number>,
): Checkpoint[] {
  const regionList = Object.entries(gate4Regions(expected));
  const out: Checkpoint[] = [];
  for (const s of expected.steps) {
    const ref = referenceShots.get(`step-${s.step}.png`);
    const got = receiverShots.get(`step-${s.step}.png`);
    const seq = seqOf.get(s.step) ?? null;
    const base = {
      step: s.step,
      settle_frame: s.settle_frame,
      seq,
      reference_png: join(referenceDir, "shots", `step-${s.step}.png`),
      receiver_png:
        seq === null ? null : join(receiverDir, "shots", `seq-${seq}.png`),
      diff_png: null,
    };
    if (!ref || !got || ref.width !== got.width || ref.height !== got.height) {
      out.push({
        ...base,
        mismatched_pixels: null,
        max_channel_delta: null,
        regions: regionList.map(([name, rect]) => ({
          name,
          rect_px: [...rect],
          mismatched_pixels: null,
          max_channel_delta: null,
        })),
      });
      continue;
    }
    const full = diffRgba(ref.rgba, got.rgba, ref.width, ref.height);
    out.push({
      ...base,
      ...full,
      regions: regionList.map(([name, rect]) => ({
        name,
        rect_px: [...rect],
        ...diffRgba(ref.rgba, got.rgba, ref.width, ref.height, rect),
      })),
    });
  }
  return out;
}

function checkpointMismatch4(c: Checkpoint): boolean {
  const bad = (n: number | null): boolean => n === null || n > 0;
  return (
    bad(c.mismatched_pixels) ||
    bad(c.max_channel_delta) ||
    c.regions.some((r) => bad(r.mismatched_pixels) || bad(r.max_channel_delta))
  );
}

export interface Gate4LegExpectation {
  class: LegClass;
  /** required when class is "pixel-mismatch": the exact steps classifyLeg must report, from
   * expected.json "predictions" (make_expected.py; never hand-edited). */
  mismatchSteps?: number[];
}

/** classifyLeg's verdict against one leg's prediction: the class, and -- for a sabotage leg --
 * exactly the predicted mismatching steps, with every other step matching. */
export function checkLegClass(
  leg: string,
  classification: Pick<
    ReturnType<typeof classifyLeg>,
    "result_class" | "reasons" | "mismatching_steps"
  >,
  checkpoints: readonly Checkpoint[],
  exp: Gate4LegExpectation,
  artifacts: string[],
): Gate4Check {
  const problems: string[] = [];
  if (classification.result_class !== exp.class)
    problems.push(
      `class ${classification.result_class}, expected ${exp.class}`,
    );
  if (exp.mismatchSteps) {
    const got = [...classification.mismatching_steps].sort((a, b) => a - b);
    const want = [...exp.mismatchSteps].sort((a, b) => a - b);
    if (got.join(",") !== want.join(","))
      problems.push(
        `mismatching steps {${got.join(",")}}, expected {${want.join(",")}}`,
      );
    for (const cp of checkpoints)
      if (!want.includes(cp.step) && checkpointMismatch4(cp))
        problems.push(
          `step ${cp.step} does not match, expected it to (outside the sabotage)`,
        );
  } else {
    for (const cp of checkpoints)
      if (checkpointMismatch4(cp))
        problems.push(`step ${cp.step} does not match, expected class success`);
  }
  return check(
    `leg-class-${leg}`,
    `the ${leg} leg classifies as ${exp.class}${exp.mismatchSteps ? ` with mismatching steps {${exp.mismatchSteps.join(",")}} and every other step matching` : ""}`,
    problems,
    `${classification.result_class}${classification.reasons.length > 0 ? ` (${classification.reasons.slice(0, 2).join(" | ")})` : ""}`,
    artifacts,
  );
}

// ---------------------------------------------------------------------------------------------
// expected-text-reference / expected-text-receiver (D8)
// ---------------------------------------------------------------------------------------------

/** The oracle's dumped page bytes (`<oracleDir>/pages/<sha256>.grt`) for one step's `pages`,
 * decoded and hash-verified, keyed by pageKeyOf. Only LA8 (grayscale/mono) pages decode; any
 * other format is reported as a problem rather than silently skipped. */
export async function loadAtlasPageImages(
  oracleDir: string,
  pages: readonly OraclePage[],
): Promise<{ images: Map<string, AtlasPageImage>; problems: string[] }> {
  const images = new Map<string, AtlasPageImage>();
  const problems: string[] = [];
  for (const p of pages) {
    const key = pageKeyOf(p);
    if (images.has(key)) continue;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        await readFile(join(oracleDir, "pages", `${p.sha256}.grt`)),
      );
    } catch {
      problems.push(
        `${key}: page bytes ${p.sha256} not found under ${join(oracleDir, "pages")}`,
      );
      continue;
    }
    if (payloadSha256(bytes) !== p.sha256) {
      problems.push(`${key}: page bytes do not hash to ${p.sha256}`);
      continue;
    }
    try {
      const decoded = decodeTexturePayload(bytes);
      if (decoded.format !== "LA8") {
        problems.push(`${key}: page format ${decoded.format}, expected LA8`);
        continue;
      }
      images.set(key, {
        width: decoded.width,
        height: decoded.height,
        data: decoded.data,
      });
    } catch (e) {
      problems.push(`${key}: ${(e as Error).message}`);
    }
  }
  return { images, problems };
}

/** Every oracle step's page images, loaded once (shared by expected-text-reference and
 * -receiver: the receiver has no oracle of its own, D7/Q6c, so both compare against the
 * reference's). */
export async function loadPagesByStep(
  oracleDir: string,
  oracle: OracleLog,
): Promise<{
  byStep: Map<number, Map<string, AtlasPageImage>>;
  problems: string[];
}> {
  const byStep = new Map<number, Map<string, AtlasPageImage>>();
  const problems: string[] = [];
  for (const line of oracle.lines) {
    const r = await loadAtlasPageImages(oracleDir, line.pages);
    problems.push(...r.problems.map((p) => `step ${line.step}: ${p}`));
    byStep.set(line.step, r.images);
  }
  return { byStep, problems };
}

/** D8: synthesizeText against `shots` inside each visible text node's region, at every settle
 * step. `maxDelta` and the count of pixels at delta >= 1 are reported; a delta above 1 (not just
 * the UNORM8 blend-rounding budget) is a problem, as is a glyph naming a page `pagesByStep`
 * never loaded. */
export function evaluateExpectedText(
  expected: Gate4Expected,
  oracle: OracleLog,
  pagesByStep: ReadonlyMap<number, Map<string, AtlasPageImage>>,
  shots: ReadonlyMap<string, Frame | null>,
): { problems: string[]; maxDelta: number; deltaAtLeastOne: number } {
  const problems: string[] = [];
  let maxDelta = 0;
  let deltaAtLeastOne = 0;
  for (const s of expected.steps) {
    const line = oracleAt(oracle, s.step);
    const frame = shots.get(`step-${s.step}.png`);
    if (!line || !frame) {
      problems.push(`step ${s.step}: no ${line ? "shot" : "oracle line"}`);
      continue;
    }
    const pages = pagesByStep.get(s.step);
    if (!pages) {
      problems.push(`step ${s.step}: no page images loaded`);
      continue;
    }
    for (const node of line.nodes) {
      const box = s.text_regions[node.name];
      const background = s.background[node.name];
      if (!box || !background) continue;
      const synth = synthesizeText(node, pages, box, background);
      if (synth.missingPages.length > 0) {
        problems.push(
          `step ${s.step}: ${node.name}'s glyphs name unmapped page(s) ${synth.missingPages.join(",")}`,
        );
        continue;
      }
      const cmp = compareSynthesizedText(frame, box, synth.frame);
      maxDelta = Math.max(maxDelta, cmp.maxDelta);
      if (cmp.maxDelta >= 1) deltaAtLeastOne += cmp.mismatched;
      if (cmp.maxDelta > 1)
        problems.push(
          `step ${s.step}: ${node.name} max channel delta ${cmp.maxDelta} (budget 1), ${cmp.mismatched} px differ`,
        );
    }
  }
  return { problems, maxDelta, deltaAtLeastOne };
}

export function checkExpectedText(
  id: "expected-text-reference" | "expected-text-receiver",
  leg: string,
  expected: Gate4Expected,
  oracle: OracleLog,
  pagesByStep: ReadonlyMap<number, Map<string, AtlasPageImage>>,
  shots: ReadonlyMap<string, Frame | null>,
  extraProblems: readonly string[],
  evidence: string[],
): Gate4Check {
  const r = evaluateExpectedText(expected, oracle, pagesByStep, shots);
  const problems = [...extraProblems, ...r.problems];
  return check(
    id,
    `D8: synthesizeText (the oracle's glyph quads x each page's LA8 alpha x the node's font colour, straight-alpha blended over the region's background) against ${leg}'s shots inside every visible text node's region at every settle step, budget maxChannelDelta 1 (UNORM8 blend rounding is implementation-defined; 2 or more is a bug)`,
    problems,
    `max channel delta ${r.maxDelta} (budget 1), ${r.deltaAtLeastOne} px at delta >=1 across ${expected.steps.length} steps`,
    evidence,
  );
}

// ---------------------------------------------------------------------------------------------
// resource-quiet
// ---------------------------------------------------------------------------------------------

/** Gate 2's resource-quiet, over a receiver's applied.json: the quiet steps (expected.json
 * quiet_steps -- no texture traffic at all, Q6b) fetch and upload nothing. */
export function evaluateResourceQuiet(
  expected: Gate4Expected,
  applied: AppliedJson | undefined,
  quit: number,
): string[] {
  if (!applied?.transactions?.length)
    return ["applied.json has no transactions"];
  const problems: string[] = [];
  for (const t of applied.transactions) {
    if (t.frame === undefined) continue;
    const step = stepOfFrame4(expected, t.frame, quit);
    if (step < 0 || !expected.quiet_steps.includes(step)) continue;
    const r: AppliedResources | null | undefined = t.resources;
    const total =
      (r?.fetched ?? 0) +
      (r?.created ?? 0) +
      (r?.updated ?? 0) +
      (r?.replaced ?? 0) +
      (r?.freed ?? 0);
    if (total > 0)
      problems.push(
        `frame ${t.frame} (step ${step}, quiet): resources ${JSON.stringify(r)}`,
      );
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// receiver-never-shapes (Q5)
// ---------------------------------------------------------------------------------------------

const FONT_FILE_RE = /\.(ttf|otf|woff2?|fnt|fontdata)\b/i;
const FORBIDDEN_SHAPING_SYMBOLS = [
  "TextServer",
  "TextServerManager",
  "FontFile",
  "RichTextLabel",
  "Label",
  "Font",
  "draw_string",
  "draw_char",
] as const;

async function listGdFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".godot") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".gd")) out.push(path);
    }
  };
  await walk(root);
  return out;
}

/** Q5 "receiver-never-shapes": (1) every traced receiver leg's openat trace opens no
 * *.ttf/*.otf/*.woff/*.woff2/*.fnt/*.fontdata; (2) a static scan of receiver/**\/*.gd finds none
 * of TextServer, TextServerManager, Font, FontFile, Label, RichTextLabel, draw_string or
 * draw_char. The receiver project contains no font. */
export async function checkReceiverNeverShapes(
  outDir: string,
  receiverProjectDir: string,
  traceLegs: readonly string[],
): Promise<Gate4Check> {
  const problems: string[] = [];
  for (const leg of traceLegs) {
    const stracePath = join(outDir, leg, "strace.txt");
    const text = await readTextOrUndefined(stracePath);
    if (text === undefined) {
      problems.push(`${leg}: strace.txt missing`);
      continue;
    }
    const opens = text
      .split("\n")
      .filter((l) => /openat\(/.test(l) && !/= -1/.test(l));
    const fontOpens = opens.filter((l) => FONT_FILE_RE.test(l));
    if (fontOpens.length > 0)
      problems.push(`${leg}: opened a font file: ${fontOpens[0].trim()}`);
    if (opens.length === 0)
      problems.push(`${leg}: no successful openat traced`);
  }
  const files = await listGdFiles(receiverProjectDir);
  if (files.length === 0)
    problems.push(`no .gd files found under ${receiverProjectDir}`);
  for (const path of files) {
    const text = (await readTextOrUndefined(path)) ?? "";
    for (const sym of FORBIDDEN_SHAPING_SYMBOLS)
      if (new RegExp(`\\b${sym}\\b`).test(text))
        problems.push(`${path}: references ${sym}`);
  }
  return check(
    "receiver-never-shapes",
    `every traced receiver leg (${traceLegs.join(", ")}) opens no *.ttf/*.otf/*.woff/*.woff2/*.fnt/*.fontdata, and no file under ${receiverProjectDir} (*.gd) references ${FORBIDDEN_SHAPING_SYMBOLS.join(", ")}`,
    problems,
    `${traceLegs.length} trace(s) clean, ${files.length} receiver scripts clean`,
    [
      ...traceLegs.map((l) => join(outDir, l, "strace.txt")),
      receiverProjectDir,
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// receiver-consumed-stream, receiver-typed-clean
// ---------------------------------------------------------------------------------------------

async function fileSha256(path: string): Promise<string | undefined> {
  try {
    return payloadSha256(new Uint8Array(await readFile(path)));
  } catch {
    return undefined;
  }
}

export interface ReceiverLegInfo {
  leg: string;
  dir: string;
  applied: AppliedJson | undefined;
}

export async function checkReceiverConsumedStream(
  receivers: readonly ReceiverLegInfo[],
): Promise<Gate4Check> {
  const problems: string[] = [];
  for (const r of receivers) {
    const copy = await fileSha256(join(r.dir, RECORDING_NAME));
    const src = r.applied?.recording?.sha256;
    if (!copy || src !== copy)
      problems.push(
        `${r.leg}: applied.json recording.sha256 ${src ?? "<none>"} != its own copy ${copy ?? "<unreadable>"}`,
      );
    if (r.applied?.status !== "ok" || r.applied?.end_seen !== true)
      problems.push(
        `${r.leg}: status=${JSON.stringify(r.applied?.status)} end_seen=${JSON.stringify(r.applied?.end_seen)}`,
      );
  }
  return check(
    "receiver-consumed-stream",
    "every g4b file-mode receiver's applied.json reports status ok, end_seen true, and recording.sha256 equal to its own local copy of the capture recording it replayed",
    problems,
    `${receivers.length} receivers consumed their own recording`,
    receivers.map((r) => join(r.dir, "applied.json")),
  );
}

export async function checkReceiverTypedClean(
  logs: readonly { leg: string; path: string }[],
): Promise<Gate4Check> {
  const problems: string[] = [];
  for (const { leg, path } of logs) {
    const text = await readTextOrUndefined(path);
    if (text === undefined) {
      problems.push(`${leg}: ${path} missing`);
      continue;
    }
    for (const marker of [
      "SCRIPT ERROR",
      "SCRIPT WARNING",
      "Parse Error",
      "Failed to load script",
    ])
      if (text.includes(marker)) problems.push(`${leg}: ${marker}`);
  }
  return check(
    "receiver-typed-clean",
    "no g4b receiver log has a SCRIPT ERROR, SCRIPT WARNING, Parse Error or Failed to load script line",
    problems,
    `${logs.length} receiver logs clean`,
    logs.map((l) => l.path),
  );
}

// ---------------------------------------------------------------------------------------------
// atlas-hash-parity under sabotage-omit-atlas
// ---------------------------------------------------------------------------------------------

/** atlas-hash-parity re-run against a sabotage capture's own recording: its `failing` cells
 * (evaluateAtlasParity) must equal the predicted ones exactly, no more and no fewer -- the proof
 * that the sabotage was captured and propagated, not a capture-side regression. */
export function checkAtlasHashParitySabotage(
  leg: string,
  expected: Gate4Expected,
  oracle: OracleLog,
  recording: RecordingSummary,
  want: Record<string, number[]>,
): Gate4Check {
  const r = evaluateAtlasParity(expected, oracle, recording);
  const problems: string[] = [];
  const keys = new Set([...Object.keys(r.failing), ...Object.keys(want)]);
  for (const key of keys) {
    const got = [...(r.failing[key] ?? [])].sort((a, b) => a - b);
    const w = [...(want[key] ?? [])].sort((a, b) => a - b);
    if (got.join(",") !== w.join(","))
      problems.push(
        `${key}: fails at steps {${got.join(",")}}, predicted {${w.join(",")}}`,
      );
  }
  return check(
    "atlas-hash-parity-sabotage-omit-atlas",
    `on ${leg}'s own recording, atlas-hash-parity (evaluateAtlasParity) fails exactly at the predicted cells: ${
      Object.entries(want)
        .map(([k, v]) => `${k} {${v.join(",")}}`)
        .join(", ") || "none"
    }`,
    problems,
    `failing cells ${JSON.stringify(r.failing)}`,
    [recording.path],
  );
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export interface TextStepReport {
  glyph_commands: number;
  msdf_commands: number;
  pages: {
    wire_id: number;
    font_key: string;
    size: number;
    format: string | null;
    w: number;
    h: number;
    hook_versions: number[];
    wire_version: number;
    payload_bytes: number;
  }[];
  atlas_bytes_published: number;
  copy_ns: number;
  hash_ns: number;
}

export function textReport(
  expected: Gate4Expected,
  full: RecordingSummary,
  hook: readonly HookLine[],
  pageIds: ReadonlyMap<string, number>,
  commands: Record<string, number>,
  quit: number,
): Record<string, TextStepReport> {
  const out: Record<string, TextStepReport> = {};
  for (const s of expected.steps) {
    const tx = full.transactions.find((t) => t.meta.frame === s.settle_frame);
    const inWindow = (l: HookLine) =>
      stepOfFrame4(expected, l.frame, quit) === s.step;
    const window = hook.filter(inWindow);
    const pages: TextStepReport["pages"] = [];
    for (const [page, id] of pageIds) {
      const e = tx?.meta.textures.find((x) => x.id === id);
      if (!e) continue;
      const [cache] = page.split("/");
      const [font_key, size] = cache.split("@");
      pages.push({
        wire_id: id,
        font_key,
        size: Number(size),
        format: e.format,
        w: e.width,
        h: e.height,
        hook_versions: window
          .filter(
            (l) => l.id === id && UPLOAD_OPS.includes(l.op) && isEngineCall(l),
          )
          .map((l) => l.version ?? -1),
        wire_version: e.version,
        payload_bytes: e.payload_bytes,
      });
    }
    out[s.step] = {
      glyph_commands: commands[s.step] ?? 0,
      msdf_commands: 0,
      pages,
      atlas_bytes_published: window
        .filter((l) => l.op === "store")
        .reduce((n, l) => n + (l.payload_bytes ?? 0), 0),
      copy_ns: window
        .filter((l) => isEngineCall(l))
        .reduce((n, l) => n + (l.copy_ns ?? 0), 0),
      hash_ns: window
        .filter((l) => isEngineCall(l))
        .reduce((n, l) => n + (l.hash_ns ?? 0), 0),
    };
  }
  return out;
}

export interface Gate4Report {
  schema: "render-stream-gate4-report/1";
  generated_at: string;
  binary: { path: string | null; sha256: string | null };
  gate_passed: boolean;
  groups: { run: string[]; landed: string[]; not_run: string[] };
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
  checks: Gate4Check[];
  checkpoints: Gate4Checkpoint[];
  /** per fixture and step: glyph commands, pages, bytes and copy/hash cost */
  text: Record<string, Record<string, TextStepReport>> | null;
  /** per fixture: per step, each oracle page against the capture's table */
  parity: Record<string, Record<string, ParityCell[]>> | null;
  /** per fixture: reference vs reference-repeat per region, every shot */
  budgets: Record<string, RegionBudget[]> | null;
  /** per fixture and step: the hook-log census per cache */
  census: Record<string, Record<string, CensusStep>> | null;
  /** per fixture, per step: ink pixels per text region in the reference */
  ink: Record<string, Record<string, Record<string, number>>> | null;
  /** G4c (lib/gate4c-checks.ts): the layout fixture's hook-log census per page, its subpixel
   * census and its derived clip rects */
  layout: {
    census: Record<string, unknown>;
    subpixel: Record<string, unknown>;
    clips: Record<string, unknown>;
  } | null;
}

export interface Gate4Context {
  expected: Gate4Expected;
  lock: FontLockEntry[];
  now?: Date;
  /** absolute path to experiments/render-stream/receiver (G4b's receiver-never-shapes static
   * scan: no receiver/**\/*.gd may reference a TextServer/Font/Label symbol). */
  receiverDir: string;
  /** absolute path to experiments/render-stream/fixtures/gate4 (G4b's
   * receiver-never-loaded-fixture). */
  fixtureDir: string;
  /** absolute path to experiments/render-stream/fixtures/gate4-layout (G4c); default: the
   * sibling of fixtureDir */
  layoutFixtureDir?: string;
}

function notRunCheck(group: string, detail: string): Gate4Check {
  return {
    id: `group-${group}`,
    criterion: `leg group ${group} ran`,
    passed: false,
    status: "not-run",
    detail,
    evidence: [],
  };
}

async function supportLeg(
  outDir: string,
  leg: (typeof G4A_SUPPORT_LEGS)[number],
) {
  const dir =
    leg === "import" ? join(outDir, "import", "fixture") : join(outDir, leg);
  const artifacts: string[] = [];
  for (const p of [
    "argv.txt",
    "env.txt",
    "stdout.log",
    "exit-code.txt",
    "steps.jsonl",
    "env.json",
    "oracle/glyphs.jsonl",
    "evidence/result.json",
    RECORDING_NAME,
  ])
    if (await fileExists(join(dir, p))) artifacts.push(join(dir, p));
  return {
    group: "g4a",
    expected_class: null,
    result_class: null,
    reasons: [] as string[],
    exit_code: await readExitCode(dir),
    artifacts,
  };
}

async function checkSupportLegsExit(outDir: string): Promise<Gate4Check> {
  const problems: string[] = [];
  for (const leg of G4A_SUPPORT_LEGS) {
    const code = await readExitCode(
      leg === "import" ? join(outDir, "import", "fixture") : join(outDir, leg),
    );
    if (code !== 0) problems.push(`${leg} exit ${code ?? "<none>"}`);
  }
  const fonts = await readTextOrUndefined(join(outDir, "import", "fonts.log"));
  if (!fonts?.includes(" ok "))
    problems.push("import/fonts.log does not record a provisioned font");
  return check(
    "support-legs-exit",
    "fonts were provisioned (import/fonts.log) and the import, reference, reference-repeat and reference-armed legs exited 0",
    problems,
    `${G4A_SUPPORT_LEGS.length} support legs exited 0`,
    G4A_SUPPORT_LEGS.map((l) =>
      join(outDir, l === "import" ? "import/fixture" : l, "exit-code.txt"),
    ),
  );
}

export async function readGroups(
  outDir: string,
): Promise<{ run: string[]; landed: string[] }> {
  const legs = await readJson<{ groups_run?: string[] }>(
    join(outDir, "legs.json"),
  );
  return { run: legs?.groups_run ?? [], landed: [...LANDED_GROUPS] };
}

export async function runGate4(
  outDir: string,
  ctx: Gate4Context,
): Promise<Gate4Report> {
  const groups = await readGroups(outDir);
  const notRun = groups.landed.filter((g) => !groups.run.includes(g));
  const expected = ctx.expected;
  const checks: Gate4Check[] = [checkExpectedSelfConsistent(expected)];
  const legs: Gate4Report["legs"] = {};
  let checkpoints: Gate4Checkpoint[] = [];
  let text: Gate4Report["text"] = null;
  let parity: Gate4Report["parity"] = null;
  let budgets: Gate4Report["budgets"] = null;
  let census: Gate4Report["census"] = null;
  let ink: Gate4Report["ink"] = null;
  // Shared with the g4b block below (both groups always run together, run-gate4.sh enforces it).
  let g4aCapture: Gate3CaptureEvaluation | undefined;
  let g4aOracle: OracleLog | undefined;
  let g4aReference: Map<string, Frame | null> = new Map();

  if (groups.run.includes("g4a")) {
    const capture: Gate3CaptureEvaluation = await evaluateCapture(outDir);
    g4aCapture = capture;
    const evidence = await loadCapture(
      outDir,
      "capture",
      "capture",
      G4A_CAPTURE_QUIT_FRAME,
    );
    const oracles = [];
    for (const leg of ORACLE_LEGS) oracles.push(await loadOracle(outDir, leg));
    const oracle = oracles[0];
    g4aOracle = oracle;
    const reference = await loadShots(outDir, "reference", expected);
    g4aReference = reference;
    const repeat = await loadShots(outDir, "reference-repeat", expected);
    const armed = await loadShots(outDir, "reference-armed", expected);

    const parityCheck = checkAtlasHashParity(
      expected,
      oracle,
      capture.full,
      capture.patch,
    );
    const mapping = parityCheck.mapping;
    const glyphs = checkGlyphCommands(
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
    const image = evaluateExpectedImage(expected, "reference", reference);
    checkpoints = image.checkpoints;
    const inkCheck = evaluateInkPresence(expected, reference);
    const repeatCmp = compareLegs(expected, reference, repeat);
    const armedCmp = compareLegs(expected, reference, armed);
    const armedResult = await readJson<CaptureResultJson>(
      join(outDir, "reference-armed", "evidence", "result.json"),
    );
    if (armedResult?.status !== "armed")
      armedCmp.problems.unshift(
        `reference-armed result.json status=${JSON.stringify(armedResult?.status)}`,
      );
    if (armedResult?.stream?.status !== "closed")
      armedCmp.problems.unshift(
        `reference-armed stream.status=${JSON.stringify(armedResult?.stream?.status)}`,
      );
    const shotPaths = (leg: string) =>
      shotsOf(expected).map((s) => join(outDir, leg, "shots", s.file));
    const store = await checkStoreComplete([evidence]);

    checks.push(
      fromGate0(
        await checkCaptureArmed(outDir, {
          captureResult: capture.captureResult,
          recording: capture.full,
        }),
      ),
      fromGate0(await checkHeadlessNoGpuGate0(outDir)),
      checkRecordingsDecode(capture.full, capture.patch),
      checkPatchResolvesToFull(capture.full, capture.patch),
      await checkStepAlignment(outDir, expected, capture.full),
      checkNoDrawIndexTies(capture.full).check,
      store.check,
      checkTextureVersionsCurrent([evidence]),
      await checkFixtureEnv(outDir, ctx.lock),
      checkOracleAgrees(expected, oracles),
      glyphs.check,
      parityCheck.check,
      await checkAtlasAppendOnly(
        expected,
        join(outDir, "capture"),
        capture.full,
        mapping,
      ),
      censusCheck.check,
      check(
        "expected-image-reference",
        "every reference shot (step-<k>.png at each settle frame, early-<k>.png one frame after the steps that upload) equals synthesizeGate4 exactly (maxChannelDelta 0) outside the text regions: the clear colour, the panel and the marker, full frame and every region",
        image.problems,
        `${shotsOf(expected).length} reference shots exact outside the text regions`,
        shotPaths("reference"),
      ),
      check(
        "ink-presence-reference",
        "in every reference settle shot, each text region has at least 6 x ink_glyphs pixels differing from its background when its node is visible with text and none otherwise; a region differs from the previous step's exactly when expected.json says fresh; each early shot's text regions equal its step's settle shot",
        inkCheck.problems,
        `ink in ${expected.text_nodes.length} regions x ${expected.steps.length} steps as expected; early shots settled`,
        shotPaths("reference"),
      ),
      check(
        "reference-repeat-budget",
        "reference vs reference-repeat (same build, GPU and driver, oracle on in both): identical everywhere at every shot -- the budget is 0 (D8); the per-region maxima are reported",
        repeatCmp.problems,
        `budget 0: ${shotsOf(expected).length} shot pairs identical (${repeatCmp.budgets.map((b) => `${b.region} ${b.max_channel_delta}`).join(", ")})`,
        [...shotPaths("reference"), ...shotPaths("reference-repeat")],
      ),
      check(
        "armed-transparent",
        "reference-armed (extension armed, stream on, oracle off) armed with its stream closed, and every shot equals the reference's exactly: the hooks forward untouched, and the oracle changes no pixel",
        armedCmp.problems,
        `${shotsOf(expected).length} armed shots byte-identical to the reference`,
        shotPaths("reference-armed"),
      ),
      await checkSupportLegsExit(outDir),
      checkCaptureLegClass(capture),
    );
    legs.capture = {
      group: "g4a",
      expected_class: capture.expected_class,
      result_class: capture.result_class,
      reasons: capture.reasons,
      harmless_ties: capture.harmless_ties,
      exit_code: capture.exit_code,
      artifacts: capture.artifacts,
    };
    for (const leg of G4A_SUPPORT_LEGS)
      legs[leg] = await supportLeg(outDir, leg);
    text = {
      [expected.fixture]: textReport(
        expected,
        capture.full,
        evidence.hook.lines,
        mapping,
        glyphs.commands,
        G4A_CAPTURE_QUIT_FRAME,
      ),
    };
    parity = { [expected.fixture]: parityCheck.table };
    budgets = { [expected.fixture]: repeatCmp.budgets };
    census = { [expected.fixture]: censusCheck.census };
    ink = { [expected.fixture]: inkCheck.ink };
  } else {
    checks.push(
      notRunCheck("g4a", "g4a was not in --legs; its checks are not-run"),
    );
  }

  if (groups.run.includes("g4b")) {
    if (!g4aCapture || !g4aOracle) {
      checks.push(
        check(
          "group-g4b",
          "g4b requires g4a's capture and oracle (run-gate4.sh ties them to the same --legs)",
          ["g4a did not produce a usable capture or oracle in this run"],
          "",
          [],
        ),
      );
    } else {
      const capture = g4aCapture;
      const oracle = g4aOracle;
      const referenceShots = g4aReference;
      const referenceDir = join(outDir, "reference");
      const oracleDir = join(outDir, ORACLE_LEGS[0], "oracle");
      const seqs = receiverStepSeqs(expected, capture.full);

      const receiverApplied = await readJson<AppliedJson>(
        join(outDir, "receiver", "applied.json"),
      );
      const patchApplied = await readJson<AppliedJson>(
        join(outDir, "receiver-patch", "applied.json"),
      );
      const traceApplied = await readJson<AppliedJson>(
        join(outDir, "receiver-headless-trace", "applied.json"),
      );
      const receiverShots = await loadReceiverShots(
        outDir,
        "receiver",
        expected,
        seqs,
      );
      const patchShots = await loadReceiverShots(
        outDir,
        "receiver-patch",
        expected,
        seqs,
      );

      const receiverCheckpoints = computeGate4Checkpoints(
        expected,
        referenceDir,
        referenceShots,
        join(outDir, "receiver"),
        receiverShots,
        seqs.settle,
      );
      const patchCheckpoints = computeGate4Checkpoints(
        expected,
        referenceDir,
        referenceShots,
        join(outDir, "receiver-patch"),
        patchShots,
        seqs.settle,
      );
      const requestedShotSeqs = [
        ...seqs.settle.values(),
        ...seqs.early.values(),
      ];
      const receiverClass = classifyLeg({
        captureResult: capture.captureResult,
        recording: capture.full,
        receiver: {
          applied: receiverApplied,
          requestedShotSeqs,
          shotFiles: await shotSeqsPresentG4(join(outDir, "receiver")),
        },
        checkpoints: receiverCheckpoints,
      });
      const patchClass = classifyLeg({
        captureResult: capture.captureResult,
        recording: capture.patch,
        receiver: {
          applied: patchApplied,
          requestedShotSeqs,
          shotFiles: await shotSeqsPresentG4(join(outDir, "receiver-patch")),
        },
        checkpoints: patchCheckpoints,
      });

      const refVsReceiver = compareLegs(
        expected,
        referenceShots,
        receiverShots,
      );
      const refVsPatch = compareLegs(expected, referenceShots, patchShots);
      const imageReceiver = evaluateExpectedImage(
        expected,
        "receiver",
        receiverShots,
      );
      const inkReceiver = evaluateInkPresence(expected, receiverShots);
      const quietReceiver = evaluateResourceQuiet(
        expected,
        receiverApplied,
        G4A_CAPTURE_QUIT_FRAME,
      );
      const quietPatch = evaluateResourceQuiet(
        expected,
        patchApplied,
        G4A_CAPTURE_QUIT_FRAME,
      );
      const pages = await loadPagesByStep(oracleDir, oracle);
      const textReference = checkExpectedText(
        "expected-text-reference",
        "reference",
        expected,
        oracle,
        pages.byStep,
        referenceShots,
        pages.problems,
        [oracleDir],
      );
      const textReceiver = checkExpectedText(
        "expected-text-receiver",
        "receiver",
        expected,
        oracle,
        pages.byStep,
        receiverShots,
        pages.problems,
        [oracleDir, join(outDir, "receiver", "shots")],
      );

      const receiverLegInfos: ReceiverLegInfo[] = [
        {
          leg: "receiver",
          dir: join(outDir, "receiver"),
          applied: receiverApplied,
        },
        {
          leg: "receiver-patch",
          dir: join(outDir, "receiver-patch"),
          applied: patchApplied,
        },
        {
          leg: "receiver-headless-trace",
          dir: join(outDir, "receiver-headless-trace"),
          applied: traceApplied,
        },
      ];
      const sabotageChecks: Gate4Check[] = [];
      for (const kind of G4B_SABOTAGE_KINDS) {
        const leg = `sabotage-${kind}`;
        const captureDir = join(outDir, leg, "capture");
        const receiverDir2 = join(outDir, leg, "receiver");
        const sabCaptureResult = await readJson<CaptureResultJson>(
          join(captureDir, "evidence", "result.json"),
        );
        const sabFull = await loadRecording(join(captureDir, RECORDING_NAME));
        const sabSeqs = receiverStepSeqs(expected, sabFull);
        const sabShots = await loadReceiverShots(
          outDir,
          `${leg}/receiver`,
          expected,
          sabSeqs,
        );
        const sabApplied = await readJson<AppliedJson>(
          join(receiverDir2, "applied.json"),
        );
        const sabCheckpoints = computeGate4Checkpoints(
          expected,
          referenceDir,
          referenceShots,
          receiverDir2,
          sabShots,
          sabSeqs.settle,
        );
        const sabClass = classifyLeg({
          captureResult: sabCaptureResult,
          recording: sabFull,
          receiver: {
            applied: sabApplied,
            // run_g4b() does not set RECEIVER_EXTRA_SHOTS for a sabotage receiver: only the
            // settle seqs were actually requested (unlike the plain receiver/receiver-patch,
            // which also shoot the early frames).
            requestedShotSeqs: [...sabSeqs.settle.values()],
            shotFiles: await shotSeqsPresentG4(receiverDir2),
          },
          checkpoints: sabCheckpoints,
        });
        const prediction = expected.predictions[leg];
        sabotageChecks.push(
          checkLegClass(
            leg,
            sabClass,
            sabCheckpoints,
            { class: "pixel-mismatch", mismatchSteps: prediction?.steps ?? [] },
            [
              join(captureDir, RECORDING_NAME),
              join(receiverDir2, "applied.json"),
            ],
          ),
        );
        if (kind === "omit-atlas") {
          sabotageChecks.push(
            checkAtlasHashParitySabotage(
              leg,
              expected,
              oracle,
              sabFull,
              prediction?.atlas_hash_parity_fails ?? {},
            ),
          );
        }
        receiverLegInfos.push({
          leg: `${leg}-receiver`,
          dir: receiverDir2,
          applied: sabApplied,
        });
        legs[leg] = {
          group: "g4b",
          expected_class: "pixel-mismatch",
          result_class: sabClass.result_class,
          reasons: sabClass.reasons,
          harmless_ties: sabClass.harmless_ties,
          exit_code: await readExitCode(receiverDir2),
          artifacts: [
            join(captureDir, RECORDING_NAME),
            join(receiverDir2, "applied.json"),
          ],
        };
      }

      checks.push(
        checkLegClass(
          "receiver",
          receiverClass,
          receiverCheckpoints,
          { class: "success" },
          [join(outDir, "receiver", "applied.json")],
        ),
        checkLegClass(
          "receiver-patch",
          patchClass,
          patchCheckpoints,
          { class: "success" },
          [join(outDir, "receiver-patch", "applied.json")],
        ),
        check(
          "receiver-vs-reference",
          "the receiver and receiver-patch legs' shots (re-keyed from wire seq to fixture step) equal the reference's exactly, full frame and every region (gate4Regions)",
          [
            ...refVsReceiver.problems.map((p) => `receiver: ${p}`),
            ...refVsPatch.problems.map((p) => `receiver-patch: ${p}`),
          ],
          `receiver budgets: ${refVsReceiver.budgets.map((b) => `${b.region} ${b.max_channel_delta}`).join(", ")}; receiver-patch budgets: ${refVsPatch.budgets.map((b) => `${b.region} ${b.max_channel_delta}`).join(", ")}`,
          [
            join(outDir, "receiver", "shots"),
            join(outDir, "receiver-patch", "shots"),
          ],
        ),
        check(
          "expected-image-receiver",
          "every receiver shot equals synthesizeGate4 exactly outside the text regions, as for the reference",
          imageReceiver.problems,
          `${shotsOf(expected).length} receiver shots match the synthesis exactly`,
          [join(outDir, "receiver", "shots")],
        ),
        textReference,
        textReceiver,
        check(
          "ink-presence-receiver",
          "the receiver's settle shots carry the same ink presence and freshness as the reference's, as for the reference",
          inkReceiver.problems,
          `ink in ${expected.text_nodes.length} regions x ${expected.steps.length} steps as expected`,
          [join(outDir, "receiver", "shots")],
        ),
        check(
          "resource-quiet",
          `the quiet steps (${expected.quiet_steps.join(",")}: no texture traffic, Q6b) fetch and upload nothing on either sink's receiver (applied.json per-transaction resources)`,
          [
            ...quietReceiver.map((p) => `receiver: ${p}`),
            ...quietPatch.map((p) => `receiver-patch: ${p}`),
          ],
          `${expected.quiet_steps.length} quiet steps clean on both sinks`,
          [
            join(outDir, "receiver", "applied.json"),
            join(outDir, "receiver-patch", "applied.json"),
          ],
        ),
        await checkReceiverNeverShapes(outDir, ctx.receiverDir, [
          "receiver-headless-trace",
        ]),
        await checkReceiverConsumedStream(receiverLegInfos),
        fromGate0(
          await checkReceiverNeverLoadedFixture(outDir, {
            receiverProjectDir: ctx.receiverDir,
            fixtureProjectDir: ctx.fixtureDir,
            receiverLogs: [
              join(outDir, "receiver", "stdout.log"),
              join(outDir, "receiver-patch", "stdout.log"),
              join(outDir, "receiver-headless-trace", "stdout.log"),
              ...G4B_SABOTAGE_KINDS.map((k) =>
                join(outDir, `sabotage-${k}`, "receiver", "stdout.log"),
              ),
            ],
          }),
        ),
        await checkReceiverTypedClean(
          receiverLegInfos.map((r) => ({
            leg: r.leg,
            path: join(r.dir, "stdout.log"),
          })),
        ),
        ...sabotageChecks,
      );
      legs.receiver = {
        group: "g4b",
        expected_class: "success",
        result_class: receiverClass.result_class,
        reasons: receiverClass.reasons,
        harmless_ties: receiverClass.harmless_ties,
        exit_code: await readExitCode(join(outDir, "receiver")),
        artifacts: [join(outDir, "receiver", "applied.json")],
      };
      legs["receiver-patch"] = {
        group: "g4b",
        expected_class: "success",
        result_class: patchClass.result_class,
        reasons: patchClass.reasons,
        harmless_ties: patchClass.harmless_ties,
        exit_code: await readExitCode(join(outDir, "receiver-patch")),
        artifacts: [join(outDir, "receiver-patch", "applied.json")],
      };
      legs["receiver-headless-trace"] = {
        group: "g4b",
        expected_class: null,
        result_class: null,
        reasons: [],
        exit_code: await readExitCode(join(outDir, "receiver-headless-trace")),
        artifacts: [join(outDir, "receiver-headless-trace", "applied.json")],
      };
    }
  } else if (groups.landed.includes("g4b")) {
    checks.push(notRunCheck("g4b", "g4b was not in --legs"));
  }

  let layout: Gate4Report["layout"] = null;
  if (groups.run.includes("g4c")) {
    // Loaded on demand: gate4c-checks builds on this module.
    const { runG4c } = await import("./gate4c-checks");
    const layoutDir =
      ctx.layoutFixtureDir ?? join(ctx.fixtureDir, "..", "gate4-layout");
    const layoutExpected = JSON.parse(
      await readFile(join(layoutDir, "expected.json"), "utf8"),
    );
    const layoutLock = JSON.parse(
      await readFile(join(layoutDir, "fonts.lock.json"), "utf8"),
    ) as FontLockEntry[];
    const r = await runG4c(outDir, {
      expected: layoutExpected,
      lock: layoutLock,
      receiverDir: ctx.receiverDir,
      fixtureDir: layoutDir,
    });
    checks.push(...r.checks);
    Object.assign(legs, r.legs);
    checkpoints = [...checkpoints, ...r.checkpoints];
    const fixture = layoutExpected.fixture as string;
    text = { ...(text ?? {}), [fixture]: r.text };
    parity = { ...(parity ?? {}), [fixture]: r.parity };
    budgets = { ...(budgets ?? {}), [fixture]: r.budgets };
    ink = { ...(ink ?? {}), [fixture]: r.ink };
    layout = { census: r.census, subpixel: r.subpixel, clips: r.clips };
  }

  for (const group of notRun)
    if (group !== "g4a" && group !== "g4b")
      checks.push(notRunCheck(group, `${group} was not in --legs`));

  const binary = await readJson<{ path?: string; sha256?: string }>(
    join(outDir, "binary.json"),
  );
  return {
    schema: "render-stream-gate4-report/1",
    generated_at: (ctx.now ?? new Date()).toISOString(),
    binary: { path: binary?.path ?? null, sha256: binary?.sha256 ?? null },
    gate_passed:
      checks.length > 1 &&
      checks.every((c) => c.status === "pass") &&
      notRun.length === 0,
    groups: { run: groups.run, landed: groups.landed, not_run: notRun },
    legs,
    checks,
    checkpoints,
    text,
    parity,
    budgets,
    census,
    ink,
    layout,
  };
}
