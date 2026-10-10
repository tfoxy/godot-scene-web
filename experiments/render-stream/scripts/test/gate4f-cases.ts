// Gate 4f cases for scripts/test/self-test-gate4.ts: lib/gate4f-checks.ts's pure evaluators over
// the committed fixtures/gate4-i18n/expected.json and small synthetic values, each with a passing
// and a failing case.
//
// 1. expected.json's own rules (checkI18nSelfConsistent), the unit model (unitsOf) and the
//    TypeScript census re-derivation (deriveI18nCensus) against broken copies.
// 2. A synthetic oracle built from expected.json -- one shaped glyph per unit, shaped the way the
//    script predictions say (NFD composed, lam-alef one glyph, niqqud marks over their base, the
//    i-matra left of KA, the Hebrew run right to left, the hex box as 26 add_rects) -- and a
//    recording whose settle transactions carry exactly those commands: evaluateI18nOracle,
//    evaluateI18nCommands and evaluateScriptPredictions pass, then fail on a glyph from the wrong
//    fallback, a moved quad, a moved hex bar, a matra right of its consonant, a left-to-right
//    Hebrew run and a texture command in the hex box.
// 3. evaluateFallbackPages on the same world and a hook log from the census: passes, then fails on
//    a fallback page that exists before its script and on a late create.
// 4. synthesizeI18nText: a hex-box bar at a half-pixel y covers the pixel rows whose centres lie in
//    the half-open rect.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RecordingSummary, Transaction } from "../lib/gate0-checks";
import type { HookLine } from "../lib/gate2b-checks";
import type { OracleLog } from "../lib/gate4-checks";
import type { AtlasPageImage } from "../lib/gate4-expected";
import {
  checkI18nSelfConsistent,
  deriveI18nCensus,
  evaluateFallbackPages,
  evaluateI18nCommands,
  evaluateI18nOracle,
  evaluateScriptPredictions,
  type I18nCommand,
  type I18nExpected,
  type I18nGlyph,
  type I18nNode,
  type I18nShaped,
  synthesizeI18nText,
  unitsOf,
} from "../lib/gate4f-checks";

type Assert = (name: string, ok: boolean, detail?: string) => void;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const f32 = (v: number) => Math.fround(v);

function helpers(assert: Assert) {
  return {
    passes: (name: string, problems: string[]) =>
      assert(
        `${name} passes`,
        problems.length === 0,
        problems.slice(0, 3).join(" | "),
      ),
    fails: (name: string, problems: string[], needle?: string) =>
      assert(
        `${name} fails`,
        problems.length > 0 &&
          (!needle || problems.some((p) => p.includes(needle))),
        problems.length === 0
          ? "no problem reported"
          : problems.slice(0, 2).join(" | "),
      ),
  };
}

const CMAP = { "OS:1EBF": 828, "DV:0915": 25, "DV:093F": 67 };

/** A stable fake glyph index per (font, unit). */
function indexOf(font: string, unit: string): number {
  if (font === "OS" && unit === "\u1EBF") return CMAP["OS:1EBF"];
  if (font === "DV" && unit === "\u0915") return CMAP["DV:0915"];
  let h = 7;
  for (const ch of `${font}:${unit}`)
    h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 9000;
  return 1000 + h;
}

/** One node's shaped glyphs and commands as the predictions say the engine shapes it. */
function shapeNode(
  expected: I18nExpected,
  name: string,
  text: string,
  colour: number[],
): I18nNode {
  const model = expected.units_model;
  const shaped: I18nShaped[] = [];
  const glyphs: I18nGlyph[] = [];
  const commands: I18nCommand[] = [];
  const base = (
    start: number,
    end: number,
  ): Omit<I18nShaped, "index" | "font_key"> => ({
    start,
    end,
    count: 1,
    flags: 1,
    advance: 10,
    offset: [0, 0],
    pen: [0, 19.5],
    command: -1,
    hex_rects: 0,
  });
  // Units with their [start, end) in the text, in logical order.
  const spans: {
    font: string | null;
    unit: string;
    start: number;
    end: number;
  }[] = [];
  if (model.unmapped.includes(text)) {
    spans.push({ font: null, unit: text, start: 0, end: 1 });
  } else if (model.unit_overrides[text]) {
    // Devanagari: whole-text clusters as the hand segmentation implies.
    if (text.length === 2)
      spans.push(
        { font: "DV", unit: "\u093F", start: 0, end: 2 },
        { font: "DV", unit: "\u0915", start: 0, end: 2 },
      );
    else
      for (const [i, u] of model.unit_overrides[text].entries())
        spans.push({ font: "DV", unit: u, start: i * 2, end: i * 2 + 2 });
  } else {
    let at = 0;
    const t = text;
    while (at < t.length) {
      if (t.startsWith(model.nfd.sequence, at)) {
        spans.push({
          font: "OS",
          unit: model.nfd.composed,
          start: at,
          end: at + 3,
        });
        at += 3;
        continue;
      }
      const ch = t[at];
      if (/\s/u.test(ch) || model.zero_width.includes(ch)) {
        spans.push({ font: "OS", unit: ch, start: at, end: at + 1 });
        at++;
        continue;
      }
      const wanted =
        (ch.codePointAt(0) ?? 0) < 0x80
          ? "OS"
          : (model.coverage[text] ?? unitsOf(model, ch)[0]?.[0] ?? "OS");
      spans.push({ font: wanted, unit: ch, start: at, end: at + 1 });
      at++;
    }
  }
  let x = 0;
  const push = (
    span: (typeof spans)[number],
    over?: { start: number; end: number; advance: number; at?: number },
  ) => {
    const blank =
      span.font === "OS" &&
      (/\s/u.test(span.unit) || model.zero_width.includes(span.unit));
    const g: I18nShaped = {
      ...base(over?.start ?? span.start, over?.end ?? span.end),
      index:
        span.font === null
          ? (span.unit.codePointAt(0) ?? 0)
          : blank
            ? /\s/u.test(span.unit)
              ? 3
              : 0
            : indexOf(span.font, span.unit),
      font_key: span.font,
      advance: over?.advance ?? (model.zero_width.includes(span.unit) ? 0 : 10),
      pen: [x, 19.5],
    };
    if (span.font === null) {
      g.hex_rects = 26;
      for (let i = 0; i < 26; i++)
        commands.push({
          op: "add_rect",
          rect: [x + (i % 11), 7.5, 1, 15],
          colour: colour as [number, number, number, number],
          codepoint: g.index,
        });
    } else if (!blank) {
      const qx = over?.at ?? x;
      g.command = glyphs.length;
      glyphs.push({
        pass: "text",
        index: g.index,
        xshift: 0,
        font_key: span.font,
        size: 16,
        outline: 0,
        x: qx,
        y: 19.5,
        quad: [qx, 6, 8, 12],
        uv: [glyphs.length * 9, 0, 8, 12],
        page: 0,
        colour: colour.map(f32) as I18nGlyph["colour"],
        start: g.start,
        end: g.end,
      });
      commands.push({ op: "add_texture_rect_region", glyph: g.command });
    }
    shaped.push(g);
    x += g.advance;
  };
  if (text === "\u05E9\u05B8\u05C1\u05DC\u05D5\u05B9\u05DD") {
    // niqqud: shin + qamats + shin dot as one cluster of three, marks first (zero advance) over
    // the base; the rest one glyph each, right to left.
    const [shin, qamats, dot, ...rest] = spans;
    for (const s of rest.reverse()) push(s);
    push(qamats, { start: 0, end: 3, advance: 0, at: x + 2 });
    push(dot, { start: 0, end: 3, advance: 0, at: x + 4 });
    push(shin, { start: 0, end: 3, advance: 10 });
  } else if (text.startsWith("\u0645\u0631\u062D")) {
    // Arabic: right to left, lam + alef one glyph.
    const lam = spans.findIndex((s) => s.unit === "\u0644");
    const merged = [
      ...spans.slice(0, lam),
      { ...spans[lam], end: spans[lam].start + 2 },
    ];
    for (const s of merged.reverse()) push(s);
  } else if (text.startsWith("abc ")) {
    // bidi: abc, space, 123, space, then the Hebrew run reversed.
    const heb = spans.filter((s) => s.font === "HE");
    const rest = spans.filter((s) => s.font !== "HE");
    for (const s of rest) push(s);
    for (const s of heb.reverse()) push(s);
  } else if (/[\u0590-\u06FF]/u.test(text)) {
    for (const s of [...spans].reverse()) push(s);
  } else for (const s of spans) push(s);
  // The paragraph's U+200B.
  shaped.push({
    ...base(text.length, text.length + 1),
    index: 0,
    font_key: "OS",
    advance: 0,
    pen: [x, 19.5],
  });
  return {
    name,
    text,
    codepoints: [...text].map((c) => c.codePointAt(0) ?? 0),
    font_key: "OS",
    size: 16,
    colour: colour.map(f32) as I18nNode["colour"],
    global_xform: [1, 0, 0, 1, 0, 0],
    box: [x, 26],
    direction: 0,
    inferred_direction: 1,
    font_height: 26,
    lines: 1,
    lines_drawn: 1,
    shaped,
    shaped_glyphs: shaped.length,
    glyphs,
    commands,
    problems: [],
  };
}

/** The synthetic world: oracle lines, page ids, a recording and a hook log that agree. */
function buildWorld(expected: I18nExpected) {
  const pageIds = new Map<string, number>();
  let nextId = 2;
  const lines: unknown[] = [];
  const transactions: Transaction[] = [];
  const names = expected.creation_order;
  const itemId = (n: string) => 100 + names.indexOf(n);
  const hook: HookLine[] = [
    {
      frame: 1,
      op: "texture_2d_create",
      id: 1,
      version: 1,
      thread: "main",
    } as unknown as HookLine,
  ];
  for (const s of expected.steps) {
    const nodes = expected.text_nodes.map((n) =>
      shapeNode(expected, n, s.texts[n].text, s.texts[n].colour),
    );
    const pages = [];
    for (const cache of Object.keys(s.page_counts)) {
      const key = `${cache}/0#0`;
      if (!pageIds.has(key)) pageIds.set(key, nextId++);
      const [font_key] = cache.split("@");
      pages.push({
        font_key,
        size: 16,
        outline: 0,
        index: 0,
        width: 256,
        height: 256,
        format: "LA8",
        mipmaps: false,
        data_bytes: 131072,
        sha256: `${key}@v${s.hook_versions[key]}`,
      });
    }
    for (const [cache, n] of Object.entries(s.page_creates))
      for (let i = 0; i < n; i++)
        hook.push({
          frame: s.applied_frame,
          op: "texture_2d_create",
          id: pageIds.get(`${cache}/0#0`),
          version: 1,
          thread: "main",
        } as unknown as HookLine);
    lines.push({
      schema: "render-stream-gate4-glyphs/1",
      step: s.step,
      frame: s.settle_frame,
      nodes,
      pages,
      caches: expected.fallback_order.map((k) => ({
        font_key: k,
        size: 16,
        outline: 0,
        glyphs: 0,
        textures: s.page_counts[`${k}@16`] ?? 0,
      })),
      cmap: CMAP,
    });
    const items = names.map((name) => {
      const node = nodes.find((n) => n.name === name);
      const commands = node
        ? node.commands.map((c) => {
            if (c.op === "add_rect")
              return { op: "add_rect", rect: c.rect, color: c.colour.map(f32) };
            const g = node.glyphs[c.glyph];
            return {
              op: "add_texture_rect_region",
              tex: pageIds.get(`${g.font_key}@16/0#0`),
              transpose: false,
              clip_uv: false,
              rect: g.quad,
              src: g.uv,
              modulate: g.colour,
            };
          })
        : [
            {
              op: "add_rect",
              rect: [0, 0, 1, 1],
              color: (name === "P" ? expected.panel.rgba8 : s.marker_rgba8).map(
                (v) => f32(v / 255),
              ),
            },
          ];
      return { id: itemId(name), commands };
    });
    const textures = [...pageIds].map(([key, id]) => ({
      id,
      kind: "image",
      status: "ok",
      version: s.wire_versions[key] ?? 1,
      hash: `${key}@v${s.hook_versions[key]}`,
      format: "LA8",
      width: 256,
      height: 256,
      mipmaps: false,
    }));
    for (const frame of [s.applied_frame, s.settle_frame])
      if (!transactions.some((t) => t.meta.frame === frame))
        transactions.push({
          meta: { frame, seq: frame, items, textures, unsupported: [] },
          sha256: "",
        } as unknown as Transaction);
  }
  const oracle: OracleLog = {
    leg: "reference",
    path: "glyphs.jsonl",
    text: "x",
    lines: lines as unknown as OracleLog["lines"],
    problem: null,
  };
  const recording = {
    path: "recording.rs2",
    present: true,
    sha256: null,
    bytes: 0,
    errors: [],
    transactions,
  } as unknown as RecordingSummary;
  return { oracle, recording, pageIds, hook };
}

export async function gate4fCases(
  assert: Assert,
  experimentDir: string,
): Promise<void> {
  const { passes, fails } = helpers(assert);
  const expected = JSON.parse(
    await readFile(
      join(experimentDir, "fixtures", "gate4-i18n", "expected.json"),
      "utf8",
    ),
  ) as I18nExpected;

  // 1. expected.json's rules and the unit model.
  const self = checkI18nSelfConsistent(expected);
  assert(
    "g4f expected-self-consistent-i18n passes on the committed file",
    self.passed,
    self.detail,
  );
  {
    const broken = clone(expected);
    broken.steps[5].page_uploads = {};
    fails(
      "g4f self-consistency with step 5's DV update dropped",
      checkI18nSelfConsistent(broken).passed
        ? []
        : [checkI18nSelfConsistent(broken).detail],
      "re-derived",
    );
    const late = clone(expected);
    late.fallback_first_steps.HE = 4;
    fails(
      "g4f self-consistency with HE's first step moved",
      checkI18nSelfConsistent(late).passed
        ? []
        : [checkI18nSelfConsistent(late).detail],
      "fallback_first_steps",
    );
    const overlap = clone(expected);
    for (const s of overlap.steps) s.text_regions.LCy = [150, 8, 392, 56];
    fails(
      "g4f self-consistency with overlapping regions",
      checkI18nSelfConsistent(overlap).passed
        ? []
        : [checkI18nSelfConsistent(overlap).detail],
      "overlap",
    );
  }
  const m = expected.units_model;
  const deva1 =
    expected.script_predictions.find((p) => p.id === "devanagari-conjuncts")
      ?.text ?? "";
  assert(
    "g4f unitsOf: the hand-segmented Devanagari string is its four units",
    unitsOf(m, deva1).length === 4 &&
      unitsOf(m, deva1).every(([f]) => f === "DV"),
  );
  const viet =
    expected.script_predictions.find((p) => p.id === "nfd-composition")?.text ??
    "";
  assert(
    "g4f unitsOf: the NFD sequence is one OS unit, U+1EBF",
    JSON.stringify(unitsOf(m, viet).map(([, u]) => u)) ===
      JSON.stringify(["T", "i", "\u1EBF", "n", "g"]),
  );
  const persian =
    expected.script_predictions.find((p) => p.id === "zwnj-invisible")?.text ??
    "";
  assert(
    "g4f unitsOf: ZWNJ draws nothing, the Persian letters are VZ",
    unitsOf(m, persian).length === 7 &&
      unitsOf(m, persian).every(([f]) => f === "VZ"),
  );
  assert(
    "g4f unitsOf: the bidi string mixes OS and HE",
    unitsOf(m, "abc \u05D0\u05D1\u05D2 123")
      .map(([f]) => f)
      .join("") === "OSOSOSHEHEHEOSOSOS",
  );
  const derived = deriveI18nCensus(expected);
  assert(
    "g4f deriveI18nCensus: step 5 creates DV and updates it once",
    JSON.stringify(derived[5].page_creates) === '{"DV@16":1}' &&
      JSON.stringify(derived[5].page_uploads) === '{"DV@16":1}',
    JSON.stringify(derived[5]),
  );
  assert(
    "g4f deriveI18nCensus: step 9 (existing glyphs) is silent",
    Object.keys(derived[9].page_creates).length +
      Object.keys(derived[9].page_uploads).length ===
      0,
  );

  // 2. Oracle, commands and script predictions on a synthetic world.
  const world = buildWorld(expected);
  const oracleLogs = [
    world.oracle,
    { ...world.oracle, leg: "reference-repeat" },
  ];
  passes(
    "g4f evaluateI18nOracle on a consistent world",
    evaluateI18nOracle(expected, oracleLogs),
  );
  {
    const bad = clone(world.oracle);
    const node = (bad.lines[5] as unknown as { nodes: I18nNode[] }).nodes.find(
      (n) => n.name === "LD1",
    );
    if (node) node.shaped[0].font_key = "VZ";
    fails(
      "g4f evaluateI18nOracle with a Devanagari glyph from VZ",
      evaluateI18nOracle(expected, [bad]),
      "fallback order gives DV",
    );
    const fewer = clone(world.oracle);
    const lg = (fewer.lines[0] as unknown as { nodes: I18nNode[] }).nodes.find(
      (n) => n.name === "LG",
    );
    if (lg) {
      lg.glyphs.pop();
      lg.commands.pop();
    }
    fails(
      "g4f evaluateI18nOracle with a Greek glyph missing",
      evaluateI18nOracle(expected, [fewer]),
      "glyph commands",
    );
  }
  const mapping = world.pageIds;
  passes(
    "g4f evaluateI18nCommands on a consistent world",
    evaluateI18nCommands(expected, world.oracle, world.recording, mapping)
      .problems,
  );
  {
    const moved = clone(world.recording);
    const tx = moved.transactions.find(
      (t) => t.meta.frame === expected.steps[4].settle_frame,
    );
    const item = tx?.meta.items.find(
      (i) => i.id === 100 + expected.creation_order.indexOf("LBi"),
    );
    if (item?.commands[0]?.rect) item.commands[0].rect[0] += 1;
    fails(
      "g4f evaluateI18nCommands with a moved quad",
      evaluateI18nCommands(expected, world.oracle, moved, mapping).problems,
      "rect",
    );
    const hex = clone(world.recording);
    const tx7 = hex.transactions.find(
      (t) => t.meta.frame === expected.steps[7].settle_frame,
    );
    const lx = tx7?.meta.items.find(
      (i) => i.id === 100 + expected.creation_order.indexOf("LX"),
    );
    if (lx?.commands[3]?.rect) lx.commands[3].rect[1] += 0.5;
    fails(
      "g4f evaluateI18nCommands with a moved hex bar",
      evaluateI18nCommands(expected, world.oracle, hex, mapping).problems,
      "hex-box add_rect",
    );
  }
  passes(
    "g4f evaluateScriptPredictions on a consistent world",
    evaluateScriptPredictions(expected, world.oracle, world.recording).problems,
  );
  {
    const matra = clone(world.oracle);
    for (const line of matra.lines as unknown as {
      step: number;
      nodes: I18nNode[];
    }[]) {
      const ld2 = line.nodes.find((n) => n.name === "LD2");
      if (ld2 && ld2.glyphs.length === 2) ld2.glyphs[0].quad[0] = 40;
    }
    fails(
      "g4f script-predictions with the i-matra right of KA",
      evaluateScriptPredictions(expected, matra, world.recording).problems,
      "i-matra-reorder",
    );
    const ltr = clone(world.recording);
    for (const t of ltr.transactions) {
      const item = t.meta.items.find(
        (i) => i.id === 100 + expected.creation_order.indexOf("LBi"),
      );
      const tex =
        item?.commands.filter((c) => c.op === "add_texture_rect_region") ?? [];
      if (tex.length === 9)
        for (const [i, c] of tex.slice(6).entries())
          if (c.rect) c.rect[0] = 102 - i;
    }
    fails(
      "g4f script-predictions with a left-to-right Hebrew run",
      evaluateScriptPredictions(expected, world.oracle, ltr).problems,
      "rtl-run",
    );
    const hexTex = clone(world.recording);
    for (const t of hexTex.transactions) {
      const item = t.meta.items.find(
        (i) => i.id === 100 + expected.creation_order.indexOf("LX"),
      );
      if (item && item.commands.length === 26)
        item.commands.push({
          op: "add_texture_rect_region",
          tex: 2,
          rect: [0, 0, 1, 1],
          src: [0, 0, 1, 1],
          modulate: [1, 1, 1, 1],
        });
    }
    fails(
      "g4f script-predictions with a texture command in the hex box",
      evaluateScriptPredictions(expected, world.oracle, hexTex).problems,
      "hex-box",
    );
  }

  // 3. fallback-pages.
  passes(
    "g4f evaluateFallbackPages on a consistent world",
    evaluateFallbackPages(
      expected,
      world.oracle,
      world.recording,
      world.recording,
      world.hook,
      mapping,
    ).problems,
  );
  {
    const early = clone(world.oracle);
    const line0 = early.lines[0] as unknown as {
      pages: { font_key: string }[];
    };
    line0.pages.push({ ...line0.pages[0], font_key: "VZ" });
    fails(
      "g4f evaluateFallbackPages with a VZ page at step 0",
      evaluateFallbackPages(
        expected,
        early,
        world.recording,
        world.recording,
        world.hook,
        mapping,
      ).problems,
      "VZ page",
    );
    const late = world.hook.map((l) =>
      l.id === mapping.get("DV@16/0#0") ? { ...l, frame: l.frame + 1 } : l,
    );
    fails(
      "g4f evaluateFallbackPages with DV's page created a frame late",
      evaluateFallbackPages(
        expected,
        world.oracle,
        world.recording,
        world.recording,
        late,
        mapping,
      ).problems,
      "DV's page",
    );
  }

  // 4. synthesizeI18nText: a half-pixel hex bar.
  {
    const node = shapeNode(expected, "LX", "\u2603", [1, 0, 0, 1]);
    node.glyphs = [];
    node.commands = [
      {
        op: "add_rect",
        rect: [2, 1.5, 1, 3],
        colour: [1, 0, 0, 1],
        codepoint: 0x2603,
      },
    ];
    const pages = new Map<string, AtlasPageImage>();
    const synth = synthesizeI18nText(node, pages, [0, 0, 4, 6], [0, 0, 0, 255]);
    const rowLit = (y: number) => synth.frame.rgba[(y * 4 + 2) * 4] === 255;
    assert(
      "g4f synthesizeI18nText: a bar from y 1.5 to 4.5 lights rows 1..3 (centres in [y0, y1))",
      !rowLit(0) &&
        rowLit(1) &&
        rowLit(2) &&
        rowLit(3) &&
        !rowLit(4) &&
        synth.frame.rgba[(2 * 4 + 1) * 4] === 0,
    );
  }
}
