#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the gate 4 checker (lib/gate4-checks.ts and lib/gate4-expected.ts, group g4a).
// Proves that every check can fail as well as pass.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate4.ts
//
// A synthetic world is built from the committed fixtures/gate4/expected.json alone: an oracle
// log (one fake glyph per ink codepoint, one LA8 page per cache whose texels record the glyphs
// rasterized so far), a capture recording whose settle transactions carry the matching glyph
// commands and page versions, a hook log with the census's creates and updates plus the engine's
// hue strip, a payload store, env.json files and synthesized shots. Each check runs on it and
// passes, then on at least one perturbation and fails. GRT1 hashing is checked against SHA-256
// values computed independently (Python hashlib over the render-stream-2.md layout), and
// append-only on a hand-built 8x8 LA8 pair.
//
// Group g4c's cases (lib/gate4c-checks.ts, fixtures/gate4-layout) live in test/gate4c-cases.ts,
// group g4f's (lib/gate4f-checks.ts, fixtures/gate4-i18n) in test/gate4f-cases.ts, and group
// g4e's (lib/gate4e-checks.ts, fixtures/gate4-msdf) in test/gate4e-cases.ts.
//
// Exits non-zero if any assertion fails.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  RecordingSummary,
  Transaction,
  TransactionMeta,
} from "../lib/gate0-checks";
import type { CaptureEvidence, HookLine } from "../lib/gate2b-checks";
import {
  censusFromLog,
  checkAtlasCensus,
  checkExpectedSelfConsistent,
  compareLegs,
  type EnvJson,
  evaluateAppendOnly,
  evaluateAtlasCensus,
  evaluateAtlasParity,
  evaluateExpectedImage,
  evaluateFixtureEnv,
  evaluateGlyphCommands,
  evaluateInkPresence,
  evaluateOracleAgrees,
  FONT_PINS,
  type FontLockEntry,
  type Frame,
  loadOracle,
  mapNames4,
  markerAlignment,
  type OracleLog,
  publishedVersions,
  SETTING_PINS,
  shotsOf,
  TEXT_SERVER_NAME,
} from "../lib/gate4-checks";
import {
  type AtlasPageImage,
  appendOnlyViolations,
  type Box4,
  cacheKeyOf,
  compareSynthesizedText,
  type Gate4Expected,
  inkCodepoints,
  type OracleLine,
  type OracleNode,
  type OraclePage,
  type Rgba8,
  stepOfFrame4,
  synthesizeGate4,
  synthesizeText,
} from "../lib/gate4-expected";
import {
  decodeTexturePayload,
  payloadSha256,
  type ResolvedCommand,
  type ResolvedItem,
  type ResolvedTexture,
} from "../lib/render-stream-2";
import { gate4cCases } from "./gate4c-cases";
import { gate4eCases } from "./gate4e-cases";
import { gate4fCases } from "./gate4f-cases";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "../..");

let assertions = 0;
let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  assertions++;
  if (ok) console.log(`[SELF-TEST OK] ${name}`);
  else {
    failures++;
    console.error(`[SELF-TEST FAIL] ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const passes = (name: string, problems: string[]) =>
  assert(
    `${name} passes`,
    problems.length === 0,
    problems.slice(0, 3).join(" | "),
  );
const fails = (name: string, problems: string[], needle?: string) =>
  assert(
    `${name} fails`,
    problems.length > 0 &&
      (!needle || problems.some((p) => p.includes(needle))),
    problems.length === 0
      ? "no problem reported"
      : problems.slice(0, 2).join(" | "),
  );

// ---------------------------------------------------------------------------------------------
// GRT1
// ---------------------------------------------------------------------------------------------

/** An independent render-stream-texture/1 encoder (render-stream-2.md "Texture payload"). */
function grt1(
  format: string,
  width: number,
  height: number,
  data: Uint8Array,
): Uint8Array {
  const meta = new TextEncoder().encode(
    `{"type":"texture-2d","format":"${format}","width":${width},"height":${height},"mipmaps":false,"data_bytes":${data.length}}`,
  );
  const out = new Uint8Array(8 + 4 + meta.length + 4 + data.length);
  out.set([0x47, 0x52, 0x54, 0x31, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, meta.length, true);
  out.set(meta, 12);
  view.setUint32(12 + meta.length, data.length, true);
  out.set(data, 16 + meta.length);
  return out;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function emptyLa8(w: number, h: number): Uint8Array {
  const d = new Uint8Array(w * h * 2);
  for (let i = 0; i < w * h; i++) d[i * 2] = 255;
  return d;
}

function grt1Cases(): void {
  // Computed with Python hashlib over the byte layout, independently of this file and of the
  // engine: an empty 256x256 LA8 page (the oracle's dump of a fresh page) and an empty 8x8 one.
  const page = grt1("LA8", 256, 256, emptyLa8(256, 256));
  assert(
    "GRT1 empty 256x256 LA8 page is 131185 bytes (the capture's payload_bytes)",
    page.length === 131185,
    String(page.length),
  );
  assert(
    "GRT1 empty 256x256 LA8 page hashes to the independent value",
    payloadSha256(page) ===
      "3ea534ca3fc576ee8c94babfa8578e885b59604159791f0fc5bcef6907565b34",
    payloadSha256(page),
  );
  const small = grt1("LA8", 8, 8, emptyLa8(8, 8));
  assert(
    "GRT1 empty 8x8 LA8 page hashes to the independent value",
    sha(small) ===
      "10595480d51b96f4342646d70e5a019192c2f9ec9613d3088c951ef369857f20",
  );
  const decoded = decodeTexturePayload(page);
  assert(
    "decodeTexturePayload reads the dumped page back",
    decoded.format === "LA8" &&
      decoded.width === 256 &&
      decoded.data.length === 131072,
  );
}

function appendOnlyCases(): void {
  const a = emptyLa8(8, 8);
  // glyph one: texels (1,1) and (2,1) inked
  a.set([255, 180], (1 * 8 + 1) * 2);
  a.set([255, 90], (1 * 8 + 2) * 2);
  const b = a.slice();
  b.set([255, 255], (4 * 8 + 4) * 2); // a second glyph on empty texels
  const okPair = appendOnlyViolations(a, b, [255, 0]);
  assert(
    "append-only: an 8x8 LA8 pair writing one empty texel passes",
    okPair.changed === 1 && okPair.violations.length === 0,
    JSON.stringify(okPair),
  );
  const c = b.slice();
  c.set([255, 10], (1 * 8 + 1) * 2); // rewrites glyph one's texel
  const badPair = appendOnlyViolations(b, c, [255, 0]);
  assert(
    "append-only: rewriting an inked texel is a violation",
    badPair.violations.length === 1 && badPair.violations[0] === 9,
    JSON.stringify(badPair),
  );
  const d = b.slice();
  d.set([0, 0], (6 * 8 + 6) * 2); // an empty texel whose L changes is still a write onto empty
  assert(
    "append-only: any write onto an empty texel is allowed",
    appendOnlyViolations(b, d, [255, 0]).violations.length === 0,
  );
  // Through evaluateAppendOnly with real payloads.
  const store = new Map<string, Uint8Array>();
  const put = (data: Uint8Array) => {
    const p = grt1("LA8", 8, 8, data);
    const h = payloadSha256(p);
    store.set(h, p);
    return h;
  };
  const ha = put(a);
  const hb = put(b);
  const hc = put(c);
  const versions = (hs: string[]) =>
    new Map([
      [2, hs.map((hash, i) => ({ id: 2, version: i + 1, hash, frame: i + 1 }))],
    ]);
  const ids = new Map([["F@16/0#0", 2]]);
  passes(
    "evaluateAppendOnly (a -> b)",
    evaluateAppendOnly(versions([ha, hb]), ids, (h) => store.get(h), [255, 0])
      .problems,
  );
  fails(
    "evaluateAppendOnly (b -> c rewrites)",
    evaluateAppendOnly(
      versions([ha, hb, hc]),
      ids,
      (h) => store.get(h),
      [255, 0],
    ).problems,
    "non-empty",
  );
  fails(
    "evaluateAppendOnly (a -> a changes nothing)",
    evaluateAppendOnly(versions([ha, ha]), ids, (h) => store.get(h), [255, 0])
      .problems,
  );
  fails(
    "evaluateAppendOnly (payload missing)",
    evaluateAppendOnly(
      versions([ha, "0".repeat(64)]),
      ids,
      (h) => store.get(h),
      [255, 0],
    ).problems,
    "not in the store",
  );
}

// ---------------------------------------------------------------------------------------------
// The synthetic world
// ---------------------------------------------------------------------------------------------

interface World {
  expected: Gate4Expected;
  oracle: OracleLine[];
  oracleText: string;
  recording: RecordingSummary;
  hook: HookLine[];
  store: Map<string, Uint8Array>;
  pageIds: Map<string, number>;
  shots: Map<string, Frame | null>;
  env: EnvJson;
  lock: FontLockEntry[];
}

const PAGE_IDS: Record<string, number> = { "F@16": 2, "F@24": 3, "DF@16": 4 };
const HUE = { id: 1, hash: "e".repeat(64) };

function hookLine(o: Partial<HookLine>): HookLine {
  return {
    frame: 1,
    thread: "main",
    op: "texture_2d_create",
    id: null,
    by_id: null,
    rid: null,
    version: null,
    kind: "image",
    status: "ok",
    reason: null,
    format: "LA8",
    width: 256,
    height: 256,
    mipmaps: false,
    data_bytes: 131072,
    payload_bytes: 131185,
    hash: null,
    copy_ns: 10,
    hash_ns: 20,
    conn: null,
    target: null,
    ...o,
  };
}

function item(id: number, commands: ResolvedCommand[]): ResolvedItem {
  return {
    id,
    origin: "created",
    parent: { kind: "canvas", id: 1 },
    children: [],
    visible: true,
    draw_index: id,
    z_index: 0,
    z_relative: true,
    behind: false,
    clip: false,
    custom_rect: false,
    visibility_layer: 1,
    texture_filter: "default" as ResolvedItem["texture_filter"],
    texture_repeat: "default",
    content_version: 1,
    xform: [1, 0, 0, 1, 0, 0],
    modulate: [1, 1, 1, 1],
    self_modulate: [1, 1, 1, 1],
    custom_rect_rect: [0, 0, 0, 0],
    commands,
  };
}

function texture(
  id: number,
  version: number,
  hash: string,
  w = 256,
  h = 6,
): ResolvedTexture {
  return {
    id,
    origin: "created",
    kind: "image",
    status: "ok",
    reason: null,
    version,
    hash,
    format: id === HUE.id ? "RGBA8" : "LA8",
    width: id === HUE.id ? 800 : w,
    height: id === HUE.id ? h : 256,
    mipmaps: false,
    payload_bytes: id === HUE.id ? 19312 : 131185,
    canvas: null,
  };
}

const f32 = (v: number) => Math.fround(v);

function buildWorld(expected: Gate4Expected): World {
  // Glyph slots per cache in rasterization order, and the page bytes after every hook version.
  const slots = new Map<string, string[]>();
  const pageData = new Map<string, Uint8Array>();
  const store = new Map<string, Uint8Array>();
  const versionHash = new Map<string, string>(); // "<key>@v<n>" -> hash
  const hook: HookLine[] = [
    hookLine({
      frame: 1,
      id: HUE.id,
      version: 1,
      format: "RGBA8",
      width: 800,
      height: 6,
      data_bytes: 19200,
      payload_bytes: 19312,
      hash: HUE.hash,
    }),
  ];
  for (const s of expected.steps) {
    // Uploads in draw order: each draw that introduces glyphs is one hook version.
    for (const node of s.draws) {
      const t = s.texts[node];
      const key = cacheKeyOf(t);
      const have = slots.get(key) ?? [];
      const fresh = inkCodepoints(t.text).filter(
        (c, i, all) => !have.includes(c) && all.indexOf(c) === i,
      );
      if (fresh.length === 0) continue;
      const data = pageData.get(key)?.slice() ?? emptyLa8(256, 256);
      for (const c of fresh) {
        const slot = have.length;
        have.push(c);
        for (let k = 0; k < 3; k++) data.set([255, 200], (slot * 3 + k) * 2);
      }
      slots.set(key, have);
      pageData.set(key, data);
      const payload = grt1("LA8", 256, 256, data);
      const hash = payloadSha256(payload);
      store.set(hash, payload);
      const version = hook.filter((l) => l.id === PAGE_IDS[key]).length + 1;
      versionHash.set(`${key}@v${version}`, hash);
      hook.push(
        hookLine({
          frame: s.applied_frame,
          op: version === 1 ? "texture_2d_create" : "texture_2d_update",
          id: PAGE_IDS[key],
          version,
          hash,
        }),
      );
    }
  }
  // Oracle lines and the matching recording.
  const oracle: OracleLine[] = [];
  const transactions: Transaction[] = [];
  const names = expected.creation_order;
  const idOf = (n: string) => names.indexOf(n) + 1;
  const stepState = new Map<
    number,
    { nodes: OracleNode[]; pages: OraclePage[]; textures: ResolvedTexture[] }
  >();
  for (const s of expected.steps) {
    const nodes: OracleNode[] = [];
    for (const name of expected.text_nodes) {
      const t = s.texts[name];
      if (!t.visible) continue;
      const key = cacheKeyOf(t);
      const have = slots.get(key) ?? [];
      nodes.push({
        name,
        text: t.text,
        font_key: t.font_key,
        size: t.size,
        colour: t.colour.map(f32) as [number, number, number, number],
        global_xform: [1, 0, 0, 1, t.position[0], t.position[1]],
        font_height: 22,
        ascent: 18,
        lines: 1,
        shaped_glyphs: [...t.text].length + 1,
        glyphs: inkCodepoints(t.text).map((c, i) => ({
          index: c.codePointAt(0) ?? 0,
          font_key: t.font_key,
          size: t.size,
          x: i * 9,
          y: 18,
          quad: [i * 9 - 1, 4, 10, 14] as [number, number, number, number],
          uv: [have.indexOf(c) * 12 + 1, 1, 10, 14] as [
            number,
            number,
            number,
            number,
          ],
          page: 0,
        })),
      });
    }
    const pages: OraclePage[] = [];
    const textures: ResolvedTexture[] = [texture(HUE.id, 1, HUE.hash)];
    for (const key of Object.keys(s.hook_versions).sort()) {
      const v = s.hook_versions[key];
      const hash = versionHash.get(`${key}@v${v}`) ?? "";
      const [font_key, size] = key.split("@");
      pages.push({
        font_key,
        size: Number(size),
        outline: 0,
        index: 0,
        width: 256,
        height: 256,
        format: "LA8",
        mipmaps: false,
        data_bytes: 131072,
        sha256: hash,
      });
      textures.push(texture(PAGE_IDS[key], v, hash));
    }
    textures.sort((a, b) => a.id - b.id);
    oracle.push({
      schema: "render-stream-gate4-glyphs/1",
      step: s.step,
      frame: s.settle_frame,
      nodes,
      pages,
    });
    stepState.set(s.step, { nodes, pages, textures });
  }
  for (let frame = 1; frame <= 400; frame++) {
    const k = stepOfFrame4(expected, frame, 400);
    const s = expected.steps[k];
    const st = stepState.get(k);
    if (!st) continue;
    const items: ResolvedItem[] = names.map((n) => {
      if (n === "P")
        return item(idOf(n), [
          {
            op: "add_rect",
            aa: false,
            rect: expected.panel.rect,
            color: expected.panel.rgba8.map((c) => f32(c / 255)) as never,
          },
        ]);
      if (n === "Marker")
        return item(idOf(n), [
          {
            op: "add_rect",
            aa: false,
            rect: [0, 0, 32, 32],
            color: s.marker_rgba8.map((c) => f32(c / 255)) as never,
          },
        ]);
      const node = st.nodes.find((x) => x.name === n);
      return item(
        idOf(n),
        (node?.glyphs ?? []).map((g) => ({
          op: "add_texture_rect_region" as const,
          tex: PAGE_IDS[cacheKeyOf(g)],
          transpose: false,
          clip_uv: false,
          rect: g.quad.map(f32) as [number, number, number, number],
          src: g.uv.map(f32) as [number, number, number, number],
          modulate: node?.colour.map(f32) as [number, number, number, number],
        })),
      );
    });
    const meta: TransactionMeta = {
      type: "transaction",
      seq: frame,
      frame,
      encoding: "full",
      base_seq: null,
      status: "ok",
      failures: [],
      unsupported: [],
      items,
      canvases: [
        {
          id: 1,
          origin: "root-query",
          role: "root",
          attached: true,
          items: items.map((i) => i.id),
          xform: [1, 0, 0, 1, 0, 0],
        },
      ],
      default_texture_filter: "linear",
      default_texture_repeat: "disabled",
      textures: st.textures,
    };
    transactions.push({ meta, sha256: "" });
  }
  const recording: RecordingSummary = {
    path: "synthetic.rs2",
    present: true,
    sha256: null,
    bytes: 0,
    errors: [],
    transactions,
  };
  // Shots: the synthesized frame plus, per visible node with ink, 7 x ink pixels of a colour
  // derived from its text, colour and position (so a region changes exactly with them).
  const shots = new Map<string, Frame | null>();
  for (const shot of shotsOf(expected)) {
    const s = expected.steps[shot.step];
    const base = synthesizeGate4(expected, shot.step);
    const rgba = base.rgba.slice();
    for (const name of expected.text_nodes) {
      const box = s.text_regions[name];
      const bg = s.background[name];
      for (let y = box[1]; y < box[3]; y++)
        for (let x = box[0]; x < box[2]; x++)
          rgba.set(bg, (y * base.width + x) * 4);
      const n = s.ink_glyphs[name];
      if (n === 0) continue;
      const t = s.texts[name];
      const h = createHash("sha256")
        .update(JSON.stringify([t.text, t.colour, t.position]))
        .digest();
      const colour = [h[0], h[1], 7, 255];
      for (let i = 0; i < 7 * n; i++) {
        const x = box[0] + 2 + (i % 200);
        const y = box[1] + 2 + Math.floor(i / 200);
        rgba.set(colour, (y * base.width + x) * 4);
      }
    }
    shots.set(shot.file, { width: base.width, height: base.height, rgba });
  }
  const lock: FontLockEntry[] = [
    {
      file: "OpenSans_SemiBold.woff2",
      source: "x",
      bytes: 46392,
      sha256:
        "661e2d9975d3029aeb32bf37b1b963c31c7c3ce08ac1bab2c8ebe27e135c4ec2",
      license: "Apache-2.0",
      license_file: "y",
      upstream: "z",
    },
  ];
  const env: EnvJson = {
    schema: "render-stream-gate4-env/1",
    text_server: TEXT_SERVER_NAME,
    font_files: { "OpenSans_SemiBold.woff2": lock[0].sha256 },
    fonts: {
      F: { ...FONT_PINS.F, msdf_size: 128 },
      DF: { ...FONT_PINS.DF, allow_system_fallback: true },
    },
    settings: { ...SETTING_PINS },
    viewport_oversampling: 1,
    tool_locale: "en",
  };
  return {
    expected,
    oracle,
    oracleText: `${oracle.map((l) => JSON.stringify(l)).join("\n")}\n`,
    recording,
    hook,
    store,
    pageIds: new Map(
      Object.entries(PAGE_IDS).map(([k, id]) => [`${k}/0#0`, id]),
    ),
    shots,
    env,
    lock,
  };
}

function oracleLog(
  w: World,
  leg = "reference",
  lines = w.oracle,
  text?: string,
): OracleLog {
  return {
    leg,
    path: `${leg}/oracle/glyphs.jsonl`,
    text: text ?? `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    lines,
    problem: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------

function selfConsistentCases(expected: Gate4Expected): void {
  passes(
    "expected-self-consistent (committed)",
    problemsOf(checkExpectedSelfConsistent(expected)),
  );
  const a = clone(expected);
  a.steps[3].ink_glyphs.L1 = 10;
  fails(
    "expected-self-consistent (ink count edited)",
    problemsOf(checkExpectedSelfConsistent(a)),
    "ink_glyphs",
  );
  const b = clone(expected);
  b.steps[0].text_regions.L2 = [16, 30, 312, 70];
  fails(
    "expected-self-consistent (overlapping regions)",
    problemsOf(checkExpectedSelfConsistent(b)),
    "overlap",
  );
  const c = clone(expected);
  c.steps[7].page_uploads["F@16"] = 1;
  fails(
    "expected-self-consistent (step 7 single upload)",
    problemsOf(checkExpectedSelfConsistent(c)),
    "page_uploads",
  );
  const d = clone(expected);
  d.steps[2].texts.L3.colour = [1, 0.75, 0.2, 1];
  fails(
    "expected-self-consistent (colour off the grid)",
    problemsOf(checkExpectedSelfConsistent(d)),
    "colour rule",
  );
  const e = clone(expected);
  e.steps[3].draws = ["LH"];
  e.steps[3].texts.LH.visible = true;
  fails(
    "expected-self-consistent (a hidden Label that shapes)",
    problemsOf(checkExpectedSelfConsistent(e)),
  );
}

function problemsOf(c: { passed: boolean; detail: string }): string[] {
  return c.passed ? [] : [c.detail];
}

function envCases(w: World): void {
  const envs = {
    capture: w.env,
    reference: clone(w.env),
    "reference-repeat": clone(w.env),
  };
  passes("fixture-env", evaluateFixtureEnv(envs, w.lock));
  const diff = clone(envs);
  diff["reference-repeat"].viewport_oversampling = 1.5;
  fails(
    "fixture-env (a leg differs)",
    evaluateFixtureEnv(diff, w.lock),
    "differs",
  );
  const sha = clone(envs);
  for (const e of Object.values(sha))
    e.font_files = { "OpenSans_SemiBold.woff2": "0".repeat(64) };
  fails(
    "fixture-env (font hash is not the lock's)",
    evaluateFixtureEnv(sha, w.lock),
    "sha256",
  );
  const sub = clone(envs);
  for (const e of Object.values(sub))
    if (e.fonts) e.fonts.F.subpixel_positioning = 1;
  fails(
    "fixture-env (subpixel positioning auto)",
    evaluateFixtureEnv(sub, w.lock),
    "subpixel_positioning",
  );
  const ts = clone(envs);
  for (const e of Object.values(ts)) e.text_server = "Fallback";
  fails(
    "fixture-env (fallback TextServer)",
    evaluateFixtureEnv(ts, w.lock),
    "text_server",
  );
  fails(
    "fixture-env (missing env.json)",
    evaluateFixtureEnv({ ...envs, reference: undefined }, w.lock),
    "missing",
  );
}

function oracleCases(w: World): void {
  const ref = oracleLog(w);
  const rep = oracleLog(w, "reference-repeat");
  passes("oracle-agrees", evaluateOracleAgrees(w.expected, [ref, rep]));
  const dropped = clone(w.oracle);
  dropped[1].nodes[0].glyphs.pop();
  fails(
    "oracle-agrees (a glyph short)",
    evaluateOracleAgrees(w.expected, [
      oracleLog(w, "reference", dropped),
      oracleLog(w, "reference-repeat", dropped),
    ]),
    "ink glyphs",
  );
  fails(
    "oracle-agrees (repeat log differs)",
    evaluateOracleAgrees(w.expected, [
      ref,
      oracleLog(w, "reference-repeat", w.oracle, "x\n"),
    ]),
    "differs",
  );
  const hidden = clone(w.oracle);
  hidden[3].nodes.push({ ...hidden[3].nodes[0], name: "LH", glyphs: [] });
  fails(
    "oracle-agrees (a hidden node reported)",
    evaluateOracleAgrees(w.expected, [
      oracleLog(w, "reference", hidden),
      oracleLog(w, "reference-repeat", hidden),
    ]),
    "visible",
  );
  const twoPages = clone(w.oracle);
  twoPages[5].pages.push({ ...twoPages[5].pages[0], index: 1 });
  fails(
    "oracle-agrees (an extra page)",
    evaluateOracleAgrees(w.expected, [
      oracleLog(w, "reference", twoPages),
      oracleLog(w, "reference-repeat", twoPages),
    ]),
    "pages",
  );
}

function parityCases(w: World): void {
  const ref = oracleLog(w);
  const r = evaluateAtlasParity(w.expected, ref, w.recording);
  passes("atlas-hash-parity", r.problems);
  assert(
    "atlas-hash-parity maps the three pages",
    JSON.stringify([...r.mapping].sort()) ===
      JSON.stringify([...w.pageIds].sort()),
    JSON.stringify([...r.mapping]),
  );
  // The omit-atlas prediction: F@16 frozen at its step-3 hash from step 4 on, DF@16 at step 9.
  const omitted = clone(w.recording);
  const at3 = (key: string) =>
    omitted.transactions
      .find((t) => t.meta.frame === w.expected.steps[3].settle_frame)
      ?.meta.textures.find((e) => e.id === PAGE_IDS[key])?.hash;
  const f16 = at3("F@16");
  const df = at3("DF@16");
  for (const t of omitted.transactions)
    if (t.meta.frame >= w.expected.predictions["sabotage-omit-atlas"].frame)
      for (const e of t.meta.textures) {
        if (e.id === PAGE_IDS["F@16"] && f16) e.hash = f16;
        if (e.id === PAGE_IDS["DF@16"] && df) e.hash = df;
      }
  const bad = evaluateAtlasParity(w.expected, ref, omitted);
  fails(
    "atlas-hash-parity (omit-op texture_2d_update from step 4)",
    bad.problems,
  );
  assert(
    "atlas-hash-parity fails exactly at the predicted cells",
    JSON.stringify(Object.entries(bad.failing).sort()) ===
      JSON.stringify(
        Object.entries(
          w.expected.predictions["sabotage-omit-atlas"]
            .atlas_hash_parity_fails ?? {},
        ).sort(),
      ),
    JSON.stringify(bad.failing),
  );
  const moved = clone(w.recording);
  for (const t of moved.transactions)
    if (t.meta.frame >= 50)
      for (const e of t.meta.textures) if (e.id === 3) e.id = 9;
  fails(
    "atlas-hash-parity (a page changes wire id)",
    evaluateAtlasParity(w.expected, ref, moved).problems,
    "moved",
  );
}

function glyphCases(w: World): void {
  const ref = oracleLog(w);
  const names = mapNames4(w.expected, w.recording);
  passes("mapNames4", names.problems);
  passes(
    "glyph-commands",
    evaluateGlyphCommands(w.expected, ref, w.recording, names, w.pageIds)
      .problems,
  );
  const perturbed = clone(w.recording);
  for (const t of perturbed.transactions)
    for (const i of t.meta.items)
      for (const c of i.commands)
        if (c.op === "add_texture_rect_region" && c.rect)
          c.rect[0] = f32(c.rect[0] + 0.25);
  fails(
    "glyph-commands (every quad +0.25 px: perturb-glyph)",
    evaluateGlyphCommands(w.expected, ref, perturbed, names, w.pageIds)
      .problems,
    "rect",
  );
  const wrongTex = clone(w.recording);
  for (const t of wrongTex.transactions)
    for (const i of t.meta.items)
      for (const c of i.commands)
        if (c.op === "add_texture_rect_region" && i.id === 2) c.tex = 3;
  fails(
    "glyph-commands (L1 names F@24's page)",
    evaluateGlyphCommands(w.expected, ref, wrongTex, names, w.pageIds).problems,
    "tex",
  );
  const extra = clone(w.recording);
  for (const t of extra.transactions) {
    const marker = t.meta.items.find((i) => i.id === 9);
    marker?.commands.push({
      op: "add_texture_rect_region",
      tex: 2,
      transpose: false,
      clip_uv: false,
      rect: [0, 0, 1, 1],
      src: [0, 0, 1, 1],
      modulate: [1, 1, 1, 1],
    });
  }
  fails(
    "glyph-commands (the marker carries a texture command)",
    evaluateGlyphCommands(w.expected, ref, extra, names, w.pageIds).problems,
    "Marker",
  );
  const tint = clone(w.recording);
  for (const t of tint.transactions)
    for (const i of t.meta.items)
      for (const c of i.commands)
        if (c.op === "add_texture_rect_region" && i.id === 3 && c.modulate)
          c.modulate[3] = f32(0.8);
  fails(
    "glyph-commands (L3 modulate wrong)",
    evaluateGlyphCommands(w.expected, ref, tint, names, w.pageIds).problems,
    "modulate",
  );
  const noMarker = clone(w.recording);
  for (const t of noMarker.transactions) {
    const marker = t.meta.items.find((i) => i.id === 9);
    if (marker) marker.commands = [];
  }
  fails(
    "mapNames4 (no marker colour at step 0)",
    mapNames4(w.expected, noMarker).problems,
    "Marker",
  );
}

function appendOnlyWorldCases(w: World): void {
  const versions = publishedVersions(w.recording);
  const r = evaluateAppendOnly(
    versions,
    w.pageIds,
    (h) => w.store.get(h),
    w.expected.page.empty_texel,
  );
  passes("atlas-append-only (synthetic pages)", r.problems);
  assert(
    "atlas-append-only compares the published version pairs (F@16 1-2-3-5, DF@16 1-2)",
    r.pairs === 4,
    String(r.pairs),
  );
}

async function censusCases(w: World): Promise<void> {
  const census = censusFromLog(w.expected, w.hook, w.pageIds, 400);
  passes(
    "atlas-census",
    evaluateAtlasCensus(w.expected, census, w.recording, w.pageIds),
  );
  const collapsed = w.hook.filter((l) => !(l.frame === 71 && l.version === 4));
  fails(
    "atlas-census (step 7 has one F@16 update)",
    evaluateAtlasCensus(
      w.expected,
      censusFromLog(w.expected, collapsed, w.pageIds, 400),
      w.recording,
      w.pageIds,
    ),
    "updates",
  );
  const quiet = [
    ...w.hook,
    hookLine({ frame: 25, op: "texture_2d_update", id: 3, version: 2 }),
  ];
  fails(
    "atlas-census (an upload in quiet step 2)",
    evaluateAtlasCensus(
      w.expected,
      censusFromLog(w.expected, quiet, w.pageIds, 400),
      w.recording,
      w.pageIds,
    ),
    "quiet",
  );
  const noHue = w.hook.filter((l) => l.id !== HUE.id);
  fails(
    "atlas-census (engine texture missing)",
    evaluateAtlasCensus(
      w.expected,
      censusFromLog(w.expected, noHue, w.pageIds, 400),
      w.recording,
      w.pageIds,
    ),
    "engine",
  );
  const late = w.hook.map((l) => (l.frame === 41 ? { ...l, frame: 42 } : l));
  fails(
    "atlas-census (the step 4 upload a frame late)",
    evaluateAtlasCensus(
      w.expected,
      censusFromLog(w.expected, late, w.pageIds, 400),
      w.recording,
      w.pageIds,
    ),
    "frames",
  );
  const after = [...w.hook, hookLine({ frame: 401, op: "free", id: 2 })];
  passes(
    "atlas-census (teardown after quit is outside the window)",
    evaluateAtlasCensus(
      w.expected,
      censusFromLog(w.expected, after, w.pageIds, 400),
      w.recording,
      w.pageIds,
    ),
  );
  const stale = clone(w.recording);
  for (const t of stale.transactions)
    if (t.meta.frame === w.expected.steps[7].settle_frame)
      for (const e of t.meta.textures) if (e.id === 2) e.version = 4;
  fails(
    "atlas-census (the wire publishes v4 at step 7)",
    evaluateAtlasCensus(w.expected, census, stale, w.pageIds),
    "on the wire",
  );
  // The file-reading wrapper on a CaptureEvidence-shaped value.
  const evidence = {
    leg: "capture",
    dir: "x",
    hook: { path: "x/evidence/resources.jsonl", lines: w.hook, problem: null },
  } as unknown as CaptureEvidence;
  const wrapped = await checkAtlasCensus(
    w.expected,
    evidence,
    w.recording,
    w.pageIds,
  );
  assert(
    "checkAtlasCensus passes on the synthetic hook log",
    wrapped.check.passed,
    wrapped.check.detail,
  );
}

function pixelCases(w: World): void {
  passes(
    "expected-image-reference",
    evaluateExpectedImage(w.expected, "reference", w.shots).problems,
  );
  const marker = new Map(w.shots);
  const f = marker.get("step-4.png");
  if (f) {
    const rgba = f.rgba.slice();
    rgba.set([0, 0, 0, 255], (20 * f.width + 600) * 4);
    marker.set("step-4.png", { ...f, rgba });
  }
  fails(
    "expected-image-reference (a marker pixel)",
    evaluateExpectedImage(w.expected, "reference", marker).problems,
    "marker",
  );
  const inside = new Map(w.shots);
  const g = inside.get("step-4.png");
  if (g) {
    const rgba = g.rgba.slice();
    rgba.set([1, 2, 3, 255], (30 * g.width + 30) * 4); // inside L1's region
    inside.set("step-4.png", { ...g, rgba });
  }
  passes(
    "expected-image-reference (a pixel inside a text region is not judged)",
    evaluateExpectedImage(w.expected, "reference", inside).problems,
  );
  const missing = new Map(w.shots);
  missing.set("early-7.png", null);
  fails(
    "expected-image-reference (an early shot missing)",
    evaluateExpectedImage(w.expected, "reference", missing).problems,
    "early-7",
  );

  passes(
    "ink-presence-reference",
    evaluateInkPresence(w.expected, w.shots).problems,
  );
  const blank = new Map(w.shots);
  const step6 = synthesizeGate4(w.expected, 6);
  const s6 = w.shots.get("step-6.png");
  if (s6) {
    const rgba = s6.rgba.slice();
    const box = w.expected.steps[6].text_regions.L1;
    const bg = w.expected.steps[6].background.L1;
    for (let y = box[1]; y < box[3]; y++)
      for (let x = box[0]; x < box[2]; x++)
        rgba.set(bg, (y * step6.width + x) * 4);
    blank.set("step-6.png", { ...s6, rgba });
  }
  fails(
    "ink-presence-reference (L1 blank at step 6)",
    evaluateInkPresence(w.expected, blank).problems,
    "L1",
  );
  const stale = new Map(w.shots);
  stale.set("step-2.png", w.shots.get("step-1.png") ?? null);
  fails(
    "ink-presence-reference (L3 did not move at step 2)",
    evaluateInkPresence(w.expected, stale).problems,
    "fresh",
  );
  const early = new Map(w.shots);
  early.set("early-4.png", w.shots.get("step-3.png") ?? null);
  fails(
    "ink-presence-reference (an atlas published a frame late)",
    evaluateInkPresence(w.expected, early).problems,
    "early-4",
  );

  passes(
    "reference-repeat-budget",
    compareLegs(w.expected, w.shots, w.shots).problems,
  );
  const one = new Map(w.shots);
  const h = one.get("step-9.png");
  if (h) {
    const rgba = h.rgba.slice();
    rgba[(150 * h.width + 30) * 4] ^= 1;
    one.set("step-9.png", { ...h, rgba });
  }
  const cmp = compareLegs(w.expected, w.shots, one);
  fails(
    "reference-repeat-budget (one channel off by one)",
    cmp.problems,
    "step-9",
  );
  assert(
    "compareLegs reports the region maximum",
    cmp.budgets.find((b) => b.region === "LD")?.max_channel_delta === 1,
    JSON.stringify(cmp.budgets),
  );

  passes(
    "step-alignment (marker colours)",
    markerAlignment(w.expected, w.recording.transactions),
  );
  const shifted = clone(w.recording);
  for (const t of shifted.transactions)
    if (t.meta.frame === 41)
      for (const i of t.meta.items) if (i.id === 9) i.commands = [];
  fails(
    "step-alignment (the step 4 marker a frame late)",
    markerAlignment(w.expected, shifted.transactions),
    "step 4",
  );
}

// ---------------------------------------------------------------------------------------------
// synthesizeText / compareSynthesizedText (G4b, D8)
// ---------------------------------------------------------------------------------------------

function synthesizeTextCases(): void {
  // An 8x8 LA8 page: L=255 everywhere (gray/mono glyphs, D4), one glyph's 2x2 uv rect at (1,1)
  // with coverage 170 (= 2/3 of 255 exactly, so the blend below has no rounding ambiguity).
  const page: AtlasPageImage = {
    width: 8,
    height: 8,
    data: new Uint8Array(8 * 8 * 2),
  };
  for (let i = 0; i < 8 * 8; i++) page.data[i * 2] = 255;
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++)
      page.data[((1 + y) * 8 + (1 + x)) * 2 + 1] = 170;
  const pages = new Map<string, AtlasPageImage>([["F@16/0#0", page]]);
  const node: OracleNode = {
    name: "L1",
    text: "A",
    font_key: "F",
    size: 16,
    colour: [1, 0, 0, 1],
    global_xform: [1, 0, 0, 1, 10, 20],
    font_height: 20,
    ascent: 16,
    lines: 1,
    shaped_glyphs: 1,
    glyphs: [
      {
        index: 1,
        font_key: "F",
        size: 16,
        x: 0,
        y: 0,
        quad: [2, 3, 2, 2],
        uv: [1, 1, 2, 2],
        page: 0,
      },
    ],
  };
  const box: Box4 = [10, 20, 20, 30];
  const background: Rgba8 = [51, 51, 102, 255];
  const { frame, missingPages } = synthesizeText(node, pages, box, background);
  assert(
    "synthesizeText: no missing pages",
    missingPages.length === 0,
    JSON.stringify(missingPages),
  );
  // world quad = local (2,3) + origin (10,20) = (12,23); box-local offset (2,3). Hand-computed
  // straight-alpha blend at coverage 2/3, red ink (1,0,0,1) over (51,51,102,255): R round(255*2/3
  // + 51*1/3)=187, G round(0 + 51/3)=17, B round(0 + 102/3)=34, A stays 255.
  const w = box[2] - box[0];
  const idx = (3 * w + 2) * 4;
  assert(
    "synthesizeText: glyph pixel blends red ink over the background at 2/3 coverage",
    frame.rgba[idx] === 187 &&
      frame.rgba[idx + 1] === 17 &&
      frame.rgba[idx + 2] === 34 &&
      frame.rgba[idx + 3] === 255,
    frame.rgba.slice(idx, idx + 4).join(","),
  );
  assert(
    "synthesizeText: a pixel outside the glyph stays the background",
    frame.rgba[0] === 51 &&
      frame.rgba[1] === 51 &&
      frame.rgba[2] === 102 &&
      frame.rgba[3] === 255,
  );
  const got: Frame = {
    width: 40,
    height: 60,
    rgba: new Uint8Array(40 * 60 * 4),
  };
  for (let i = 0; i < 40 * 60; i++) got.rgba.set(background, i * 4);
  for (let y = box[1]; y < box[3]; y++)
    for (let x = box[0]; x < box[2]; x++) {
      const gi = (y * got.width + x) * 4;
      const si = ((y - box[1]) * w + (x - box[0])) * 4;
      for (let c = 0; c < 4; c++) got.rgba[gi + c] = frame.rgba[si + c];
    }
  const cmp = compareSynthesizedText(got, box, frame);
  assert(
    "compareSynthesizedText: an exact copy has zero mismatch",
    cmp.mismatched === 0 && cmp.maxDelta === 0,
    JSON.stringify(cmp),
  );
  got.rgba[((box[1] + 3) * got.width + (box[0] + 2)) * 4] = 200;
  const cmp2 = compareSynthesizedText(got, box, frame);
  assert(
    "compareSynthesizedText: a perturbed pixel is reported with the right delta",
    cmp2.mismatched === 1 && cmp2.maxDelta === Math.abs(200 - 187),
    JSON.stringify(cmp2),
  );
  const node2: OracleNode = {
    ...node,
    glyphs: [{ ...node.glyphs[0], font_key: "DF" }],
  };
  const r2 = synthesizeText(node2, pages, box, background);
  assert(
    "synthesizeText: a glyph on an unmapped page is recorded as missing, not synthesized wrong",
    r2.missingPages.length === 1 &&
      r2.missingPages[0] === "DF@16/0#0" &&
      r2.frame.rgba.every((v, i) => v === background[i % 4]),
    JSON.stringify(r2.missingPages),
  );
}

async function fileCases(w: World): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "gate4-selftest-"));
  try {
    await mkdir(join(dir, "reference", "oracle"), { recursive: true });
    await writeFile(
      join(dir, "reference", "oracle", "glyphs.jsonl"),
      w.oracleText,
    );
    const log = await loadOracle(dir, "reference");
    assert(
      "loadOracle reads every line",
      log.problem === null && log.lines.length === 10,
      String(log.problem),
    );
    await writeFile(
      join(dir, "reference", "oracle", "glyphs.jsonl"),
      `${w.oracleText}{oops\n`,
    );
    const bad = await loadOracle(dir, "reference");
    assert("loadOracle reports a broken line", bad.problem !== null);
    const missing = await loadOracle(dir, "nowhere");
    assert("loadOracle reports a missing log", missing.problem === "missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const expected = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate4", "expected.json"),
      "utf8",
    ),
  ) as Gate4Expected;
  grt1Cases();
  appendOnlyCases();
  selfConsistentCases(expected);
  const w = buildWorld(expected);
  envCases(w);
  oracleCases(w);
  parityCases(w);
  glyphCases(w);
  appendOnlyWorldCases(w);
  await censusCases(w);
  pixelCases(w);
  synthesizeTextCases();
  await fileCases(w);
  // Group g4c (test/gate4c-cases.ts): the layout fixture's evaluators.
  await gate4cCases(assert, EXPERIMENT_DIR);
  // Group g4f (test/gate4f-cases.ts): the multilingual fixture's evaluators.
  await gate4fCases(assert, EXPERIMENT_DIR);
  // Group g4e (test/gate4e-cases.ts): the MSDF fixture's evaluators.
  await gate4eCases(assert, EXPERIMENT_DIR);
  console.log(
    `\nself-test-gate4: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
