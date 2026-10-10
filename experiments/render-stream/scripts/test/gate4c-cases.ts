// Gate 4c cases for scripts/test/self-test-gate4.ts: lib/gate4c-checks.ts's pure evaluators over
// the committed fixtures/gate4-layout/expected.json and small synthetic values, each with a
// passing and a failing case.
//
// 1. expected.json's own rules (checkLayoutSelfConsistent) and a few hand-typed census facts of
//    the TypeScript re-derivation (deriveLayoutCensus) against broken copies.
// 2. A synthetic oracle built from expected.json (one fake glyph per ink codepoint and pass, one
//    page per cache as page_counts says) and a recording whose settle transactions carry exactly
//    those glyph commands: evaluateLayoutOracle and evaluateLayoutGlyphCommands pass, then fail on
//    a dropped glyph, a wrong line, a moved quad and a wrong page.
// 3. A hook-log census and wire table derived from expected.json: evaluateLayoutCensus and
//    evaluatePageLifetime pass, then fail on an extra update, a late upload, a missing free and a
//    table that still names the freed page.
// 4. newSubpixelPairs / evaluateSubpixelCensus on hand-built subpixel glyphs.
// 5. synthesizeLayoutText on a hand-computed 4x4 page: per-glyph colour, outline page keys, clip.
// 6. evaluateLcdRegions on synthesized frames.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RecordingSummary, Transaction } from "../lib/gate0-checks";
import type { HookLine } from "../lib/gate2b-checks";
import type { Frame, OracleLog } from "../lib/gate4-checks";
import {
  type AtlasPageImage,
  compareSynthesizedText,
} from "../lib/gate4-expected";
import {
  cacheOfPageKey,
  checkLayoutSelfConsistent,
  deriveLayoutCensus,
  evaluateLayoutCensus,
  evaluateLayoutGlyphCommands,
  evaluateLayoutOracle,
  evaluateLcdRegions,
  evaluatePageLifetime,
  evaluateSubpixelCensus,
  type LayoutCensusStep,
  type LayoutExpected,
  type LayoutGlyph,
  type LayoutNode,
  layoutCensusFromLog,
  newSubpixelPairs,
  synthesizeLayoutText,
} from "../lib/gate4c-checks";

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

const ink = (t: string) => [...t].filter((c) => !/\s/u.test(c));

/** The synthetic world: oracle lines, the page ids and a recording that agrees with them. */
function buildWorld(expected: LayoutExpected) {
  const pageIds = new Map<string, number>();
  let nextId = 2;
  const lines: unknown[] = [];
  const transactions: Transaction[] = [];
  const names = expected.creation_order;
  const itemId = (n: string) => 100 + names.indexOf(n);
  let prev: { items: unknown[]; textures: unknown[] } | undefined;
  for (const s of expected.steps) {
    const nodes: LayoutNode[] = [];
    for (const name of expected.text_nodes) {
      const t = s.texts[name] as (typeof s.texts)[string] & {
        outline_size?: number;
        outline_colour?: number[];
        shadow_colour?: number[];
        clip?: boolean;
      };
      const glyphs: LayoutGlyph[] = [];
      const add = (
        pass: LayoutGlyph["pass"],
        outline: number,
        colour: number[],
      ) => {
        for (const [i, c] of ink(t.text).entries())
          glyphs.push({
            pass,
            index: c.codePointAt(0) ?? 0,
            xshift: 0,
            font_key: t.font_key,
            size: t.size,
            outline,
            x: i * 10,
            y: 0,
            quad: [i * 10, 2, 8, 9],
            uv: [i * 9, 0, 8, 9],
            page: 0,
            colour: colour.map(f32) as LayoutGlyph["colour"],
          });
      };
      if (t.shadow_colour) add("shadow", 0, t.shadow_colour);
      if (t.outline_size)
        add("outline", t.outline_size, t.outline_colour ?? [0, 0, 0, 1]);
      add("text", 0, t.colour);
      const want = s.lines[name];
      const lineTexts = Array.isArray(want)
        ? want
        : Array.from({ length: want }, () => "?");
      nodes.push({
        name,
        text: t.text,
        font_key: t.font_key,
        size: t.size,
        colour: t.colour.map(f32) as LayoutNode["colour"],
        global_xform: [1, 0, 0, 1, 0, 0],
        font_height: 0,
        ascent: 0,
        lines: lineTexts.length,
        lines_drawn: lineTexts.length,
        line_texts: lineTexts,
        shaped_glyphs: 0,
        box: [0, 0],
        clip: !!t.clip,
        outline_size: t.outline_size ?? 0,
        glyphs,
      });
    }
    const pages: {
      font_key: string;
      size: number;
      outline: number;
      index: number;
      [k: string]: unknown;
    }[] = [];
    for (const [cache, n] of Object.entries(s.page_counts)) {
      const c = expected.caches[cache];
      const [font_key, rest] = cache.split("@");
      const [size, outline] = rest.split("/");
      for (let index = 0; index < n; index++) {
        const key = `${cache.includes("/") ? cache : `${cache}/0`}#${index}`;
        if (!pageIds.has(key)) pageIds.set(key, nextId++);
        pages.push({
          font_key,
          size: Number(size),
          outline: Number(outline ?? 0),
          index,
          width: c.width,
          height: c.height,
          format: c.format,
          mipmaps: false,
          data_bytes: c.data_bytes,
          sha256: `${key}@${s.step}`,
        });
      }
    }
    lines.push({
      schema: "render-stream-gate4-glyphs/1",
      step: s.step,
      frame: s.settle_frame,
      nodes,
      pages,
    });
    const items = names.map((name) => {
      const node = nodes.find((n) => n.name === name);
      const commands = node
        ? node.glyphs.map((g) => ({
            op: "add_texture_rect_region",
            tex: pageIds.get(`${g.font_key}@${g.size}/${g.outline}#${g.page}`),
            transpose: false,
            clip_uv: false,
            rect: g.quad,
            src: g.uv,
            modulate: g.colour,
          }))
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
    const textures = [...pageIds]
      .filter(([key]) =>
        pages.some(
          (p) => `${p.font_key}@${p.size}/${p.outline}#${p.index}` === key,
        ),
      )
      .map(([key, id]) => {
        const c = expected.caches[cacheOfPageKey(key)];
        return {
          id,
          kind: "image",
          status: "ok",
          version: s.wire_versions[key] ?? 1,
          format: c.format,
          width: c.width,
          height: c.height,
          mipmaps: false,
        };
      });
    // The frame before a step carries the previous step's state; its applied and settle frames
    // carry this step's.
    for (const [frame, state] of [
      [s.applied_frame - 1, prev],
      [s.applied_frame, { items, textures }],
      [s.settle_frame, { items, textures }],
    ] as const)
      if (
        frame >= 1 &&
        state &&
        !transactions.some((t) => t.meta.frame === frame)
      )
        transactions.push({
          meta: { frame, seq: frame, ...state, unsupported: [] },
          sha256: "",
        } as unknown as Transaction);
    prev = { items, textures };
  }
  transactions.sort((a, b) => a.meta.frame - b.meta.frame);
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
  return { oracle, recording, pageIds, itemId };
}

/** The hook log the census predicts: creates, updates and frees in each step's applied frame. */
function hookFor(
  expected: LayoutExpected,
  pageIds: ReadonlyMap<string, number>,
): HookLine[] {
  const line = (
    frame: number,
    op: string,
    id: number | null,
    version: number | null,
  ): HookLine =>
    ({
      frame,
      op,
      id,
      version,
      thread: "main",
      format: "RGBA8",
      width: 800,
      height: 6,
    }) as unknown as HookLine;
  const out: HookLine[] = [line(1, "texture_2d_create", 1, 1)];
  const versions = new Map<string, number>();
  for (const s of expected.steps) {
    for (const cache of s.frees)
      out.push(
        line(
          s.applied_frame,
          "free",
          pageIds.get(`${cache}/0#0`) ?? null,
          null,
        ),
      );
    const pages = [...pageIds.keys()].filter(
      (k) => s.page_counts[cacheOfPageKey(k)] !== undefined,
    );
    for (const key of pages) {
      const cache = cacheOfPageKey(key);
      const want =
        s.hook_versions[key] ??
        (s.subpixel_bounded.includes(cache)
          ? (versions.get(key) ?? 0) + 1
          : (versions.get(key) ?? 0));
      for (let v = (versions.get(key) ?? 0) + 1; v <= want; v++)
        out.push(
          line(
            s.applied_frame,
            v === 1 ? "texture_2d_create" : "texture_2d_update",
            pageIds.get(key) ?? null,
            v,
          ),
        );
      versions.set(key, want);
    }
  }
  return out.map((l) =>
    l.id === 1
      ? l
      : ({
          ...l,
          format: null,
          width: null,
          height: null,
        } as unknown as HookLine),
  );
}

export async function gate4cCases(
  assert: Assert,
  experimentDir: string,
): Promise<void> {
  const { passes, fails } = helpers(assert);
  const expected = JSON.parse(
    await readFile(
      join(experimentDir, "fixtures", "gate4-layout", "expected.json"),
      "utf8",
    ),
  ) as LayoutExpected;

  // 1. expected.json's rules and the census re-derivation.
  passes(
    "expected-self-consistent-layout (committed)",
    checkLayoutSelfConsistent(expected).passed
      ? []
      : [checkLayoutSelfConsistent(expected).detail],
  );
  {
    const e = clone(expected);
    e.steps[3].page_uploads["F@24/4"] = 3;
    fails(
      "expected-self-consistent-layout (outline uploads)",
      [checkLayoutSelfConsistent(e).detail].filter(
        () => !checkLayoutSelfConsistent(e).passed,
      ),
      "page_uploads",
    );
    const r = clone(expected);
    r.steps[0].text_regions.LS = [100, 8, 296, 68];
    fails(
      "expected-self-consistent-layout (overlap)",
      [checkLayoutSelfConsistent(r).detail].filter(
        () => !checkLayoutSelfConsistent(r).passed,
      ),
      "overlap",
    );
    const k = clone(expected);
    k.steps[2].text_regions.LK = [8, 128, 152, 188];
    fails(
      "expected-self-consistent-layout (clip edge)",
      [checkLayoutSelfConsistent(k).detail].filter(
        () => !checkLayoutSelfConsistent(k).passed,
      ),
      "clip",
    );
  }
  const derived = deriveLayoutCensus(expected);
  assert(
    "deriveLayoutCensus: F@24/4 create + 6 updates at step 0, 2 at step 3; F@320 update + create at step 7; FL2 create at step 8",
    derived[0].page_creates["F@24/4"] === 1 &&
      derived[0].page_uploads["F@24/4"] === 6 &&
      derived[3].page_uploads["F@24/4"] === 2 &&
      derived[7].page_uploads["F@320"] === 1 &&
      derived[7].page_creates["F@320"] === 1 &&
      derived[8].page_creates["FL2@16"] === 1 &&
      derived[0].page_uploads["F@16"] === undefined,
    JSON.stringify([derived[0], derived[7]]),
  );

  // 2. Oracle and glyph commands.
  const w = buildWorld(expected);
  passes("evaluateLayoutOracle", evaluateLayoutOracle(expected, [w.oracle]));
  {
    const o = clone(w.oracle);
    (o.lines[2] as unknown as { nodes: LayoutNode[] }).nodes[2].line_texts = [
      "Words",
      "wrap again",
    ];
    fails(
      "evaluateLayoutOracle (wrong word wrap)",
      evaluateLayoutOracle(expected, [o]),
      "lines",
    );
    const d = clone(w.oracle);
    (d.lines[3] as unknown as { nodes: LayoutNode[] }).nodes[5].glyphs.shift();
    fails(
      "evaluateLayoutOracle (dropped outline glyph)",
      evaluateLayoutOracle(expected, [d]),
      "glyph commands",
    );
    const p = clone(w.oracle);
    p.lines[7].pages = p.lines[7].pages.filter(
      (x) => !(x.size === 320 && x.index === 1),
    );
    fails(
      "evaluateLayoutOracle (one F@320 page)",
      evaluateLayoutOracle(expected, [p]),
      "F@320",
    );
    const two = { ...clone(w.oracle), leg: "reference-repeat", text: "y" };
    fails(
      "evaluateLayoutOracle (repeat differs)",
      evaluateLayoutOracle(expected, [w.oracle, two]),
      "differs",
    );
  }
  passes(
    "evaluateLayoutGlyphCommands",
    evaluateLayoutGlyphCommands(expected, w.oracle, w.recording, w.pageIds)
      .problems,
  );
  {
    const r = clone(w.recording);
    const tx = r.transactions.find(
      (t) => t.meta.frame === expected.steps[4].settle_frame,
    );
    const item = tx?.meta.items.find((i) => i.id === w.itemId("LO"));
    if (item?.commands[0]?.rect) item.commands[0].rect[0] += 0.25;
    fails(
      "evaluateLayoutGlyphCommands (outline quad moved)",
      evaluateLayoutGlyphCommands(expected, w.oracle, r, w.pageIds).problems,
      "rect",
    );
    const m = new Map(w.pageIds);
    m.set("F@24/4#0", m.get("F@24/0#0") ?? 0);
    fails(
      "evaluateLayoutGlyphCommands (outline page mapped to the plain page)",
      evaluateLayoutGlyphCommands(expected, w.oracle, w.recording, m).problems,
      "tex",
    );
  }

  // 3. Census and lifetime.
  const hook = hookFor(expected, w.pageIds);
  const census: Record<string, LayoutCensusStep> = layoutCensusFromLog(
    expected,
    hook,
    w.pageIds,
    400,
  );
  passes(
    "evaluateLayoutCensus",
    evaluateLayoutCensus(expected, census, w.recording, w.pageIds),
  );
  {
    const extra = [
      ...hook,
      {
        ...hook.find((l) => l.op === "texture_2d_update" && l.frame === 31),
        version: 99,
      } as HookLine,
    ];
    fails(
      "evaluateLayoutCensus (extra outline update)",
      evaluateLayoutCensus(
        expected,
        layoutCensusFromLog(expected, extra, w.pageIds, 400),
        w.recording,
        w.pageIds,
      ),
      "updates",
    );
    const late = hook.map((l) =>
      l.frame === 61 && l.op === "texture_2d_update" ? { ...l, frame: 62 } : l,
    );
    fails(
      "evaluateLayoutCensus (upload a frame late)",
      evaluateLayoutCensus(
        expected,
        layoutCensusFromLog(expected, late, w.pageIds, 400),
        w.recording,
        w.pageIds,
      ),
      "frames",
    );
    const noFx = hook.filter(
      (l) => !(l.frame === 41 && l.id === w.pageIds.get("FX@14/0#0")),
    );
    fails(
      "evaluateLayoutCensus (subpixel glyphs without an upload)",
      evaluateLayoutCensus(
        expected,
        layoutCensusFromLog(expected, noFx, w.pageIds, 400),
        w.recording,
        w.pageIds,
      ),
      "subpixel",
    );
  }
  passes(
    "evaluatePageLifetime",
    evaluatePageLifetime(expected, census, w.recording, w.recording, w.pageIds)
      .problems,
  );
  {
    const noFree = hook.filter((l) => l.op !== "free");
    fails(
      "evaluatePageLifetime (no free)",
      evaluatePageLifetime(
        expected,
        layoutCensusFromLog(expected, noFree, w.pageIds, 400),
        w.recording,
        w.recording,
        w.pageIds,
      ).problems,
      "free",
    );
    const r = clone(w.recording);
    const oldId = w.pageIds.get("FL@16/0#0");
    const at = r.transactions.find(
      (t) =>
        t.meta.frame === expected.steps[expected.lifetime_step].applied_frame,
    );
    at?.meta.textures.push({
      id: oldId,
      kind: "image",
      status: "ok",
      version: 1,
    } as unknown as (typeof at.meta.textures)[number]);
    fails(
      "evaluatePageLifetime (freed page still in the table)",
      evaluatePageLifetime(expected, census, r, r, w.pageIds).problems,
      "still in the table",
    );
  }

  // 4. Subpixel census.
  {
    const glyph = (index: number, xshift: number): LayoutGlyph => ({
      pass: "text",
      index,
      xshift,
      font_key: "FX",
      size: 14,
      outline: 0,
      x: 0,
      y: 0,
      quad: [0, 0, 1, 1],
      uv: [0, 0, 1, 1],
      page: 0,
      colour: [1, 1, 1, 1],
    });
    const lineOf = (step: number, glyphs: LayoutGlyph[]) => ({
      step,
      frame: 0,
      nodes: [{ name: "LX", glyphs }],
      pages: [],
    });
    const oracle = {
      leg: "reference",
      path: "",
      text: "",
      problem: null,
      lines: expected.steps.map((s) =>
        s.step === 0
          ? lineOf(0, [glyph(5, 0), glyph(6, 1), glyph(5, 2)])
          : s.step === 4
            ? lineOf(4, [glyph(5, 2), glyph(7, 3)])
            : lineOf(s.step, [glyph(5, 0)]),
      ),
    } as unknown as OracleLog;
    const pairs = newSubpixelPairs(expected, oracle, "FX@14");
    assert(
      "newSubpixelPairs: step 0 has 4 new pairs (5:0 6:0 6:1 5:2), step 4 has 2 (7:0 7:3), step 1 none",
      pairs[0] === 4 && pairs[4] === 2 && pairs[1] === 0,
      JSON.stringify(pairs),
    );
    const cen = (uploads: Record<number, number>) => {
      const c: Record<string, LayoutCensusStep> = {};
      for (const s of expected.steps)
        c[s.step] = {
          pages: uploads[s.step]
            ? {
                "FX@14/0#0": {
                  creates: 0,
                  updates: uploads[s.step],
                  frees: 0,
                  frames: [s.applied_frame],
                  versions: [],
                },
              }
            : {},
          texture_lines: 0,
          engine: [],
        };
      return c;
    };
    passes(
      "evaluateSubpixelCensus",
      evaluateSubpixelCensus(expected, cen({ 0: 3, 4: 2 }), oracle).problems,
    );
    fails(
      "evaluateSubpixelCensus (more uploads than new pairs)",
      evaluateSubpixelCensus(expected, cen({ 0: 5, 4: 2 }), oracle).problems,
      "new (glyph, shift) pairs",
    );
    fails(
      "evaluateSubpixelCensus (new pairs, no upload)",
      evaluateSubpixelCensus(expected, cen({ 0: 3 }), oracle).problems,
      "no upload",
    );
  }

  // 5. synthesizeLayoutText on a 4x4 page: texels (0..1, 0..1) opaque.
  {
    const data = new Uint8Array(4 * 4 * 2);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++)
        data.set([255, x < 2 && y < 2 ? 255 : 0], (y * 4 + x) * 2);
    const page: AtlasPageImage = { width: 4, height: 4, data };
    const g = (
      outline: number,
      colour: [number, number, number, number],
      qx: number,
    ): LayoutGlyph => ({
      pass: outline ? "outline" : "text",
      index: 1,
      xshift: 0,
      font_key: "F",
      size: 16,
      outline,
      x: 0,
      y: 0,
      quad: [qx, 1, 2, 2],
      uv: [0, 0, 2, 2],
      page: 0,
      colour,
    });
    const node = {
      name: "N",
      global_xform: [1, 0, 0, 1, 10, 20],
      glyphs: [g(4, [0, 0, 1, 1], 0), g(0, [1, 0, 0, 1], 1)],
    } as unknown as LayoutNode;
    const pages = new Map([
      ["F@16/4#0", page],
      ["F@16/0#0", page],
    ]);
    const bg: [number, number, number, number] = [0, 0, 0, 255];
    const box: [number, number, number, number] = [10, 20, 14, 24];
    const r = synthesizeLayoutText(node, pages, box, bg, null);
    const px = (x: number, y: number) =>
      [
        ...r.frame.rgba.slice(
          ((y - 20) * 4 + (x - 10)) * 4,
          ((y - 20) * 4 + (x - 10)) * 4 + 4,
        ),
      ].join(",");
    assert(
      "synthesizeLayoutText: outline glyph blue at (10,21), text glyph red over it at (11,21) and (12,22), background elsewhere",
      r.missingPages.length === 0 &&
        px(10, 21) === "0,0,255,255" &&
        px(11, 21) === "255,0,0,255" &&
        px(12, 22) === "255,0,0,255" &&
        px(13, 21) === "0,0,0,255",
      `${px(10, 21)} ${px(11, 21)} ${px(12, 22)} ${px(13, 21)}`,
    );
    const clipped = synthesizeLayoutText(
      node,
      pages,
      box,
      bg,
      [10, 20, 12, 24],
    );
    const cpx = (x: number, y: number) =>
      [
        ...clipped.frame.rgba.slice(
          ((y - 20) * 4 + (x - 10)) * 4,
          ((y - 20) * 4 + (x - 10)) * 4 + 4,
        ),
      ].join(",");
    assert(
      "synthesizeLayoutText: a clip at x 12 keeps (12,22) background",
      cpx(12, 22) === "0,0,0,255" && cpx(11, 21) === "255,0,0,255",
      cpx(12, 22),
    );
    const missing = synthesizeLayoutText(
      node,
      new Map([["F@16/0#0", page]]),
      box,
      bg,
      null,
    );
    assert(
      "synthesizeLayoutText: an unmapped outline page is reported",
      missing.missingPages.join() === "F@16/4#0",
      missing.missingPages.join(),
    );
    const frame = { width: 4, rgba: r.frame.rgba };
    const cmp = compareSynthesizedText(frame, [0, 0, 4, 4], r.frame);
    assert(
      "synthesizeLayoutText output compares equal to itself",
      cmp.maxDelta === 0,
      String(cmp.maxDelta),
    );
  }

  // 6. LCD regions.
  {
    const make = (): Frame => ({
      width: 640,
      height: 360,
      rgba: new Uint8Array(640 * 360 * 4),
    });
    const ref = new Map<string, Frame | null>();
    const recv = new Map<string, Frame | null>();
    const [x0, y0] = expected.lcd.region;
    for (const s of expected.steps) {
      const a = make();
      a.rgba[(y0 * 640 + x0 + 5) * 4] = 200;
      ref.set(`step-${s.step}.png`, a);
      recv.set(`step-${s.step}.png`, make());
    }
    passes(
      "evaluateLcdRegions",
      evaluateLcdRegions(expected, ref, recv).problems,
    );
    const outside = new Map(recv);
    const o = make();
    o.rgba[0] = 1;
    outside.set("step-3.png", o);
    fails(
      "evaluateLcdRegions (difference outside LC)",
      evaluateLcdRegions(expected, ref, outside).problems,
      "outside",
    );
    fails(
      "evaluateLcdRegions (LC not different)",
      evaluateLcdRegions(expected, ref, ref).problems,
      "does not differ",
    );
  }
}
