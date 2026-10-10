// Gate 4e cases for scripts/test/self-test-gate4.ts: lib/gate4e-checks.ts's pure evaluators over
// the committed fixtures/gate4-msdf/expected.json and small synthetic values, each with a passing
// and a failing case.
//
// 1. expected.json's own rules (checkMsdfSelfConsistent) against broken copies: an upload at the
//    size change, the contract's msdf_size changed to FontFile.new()'s 128.
// 2. A synthetic oracle built from expected.json (one fake MSDF glyph per ink codepoint and pass,
//    the one msdf_size page) and a recording whose settle transactions carry exactly those
//    add_msdf_texture_rect_region commands: evaluateMsdfOracle, evaluateMsdfGlyphCommands and
//    evaluateMsdfArgs pass, then fail on a wrong outline, a wrong scale, a moved quad, a plain
//    region command, px_range 14 and a typed msdf refusal.
// 3. The hook-log census (gate4c's evaluator over the MSDF expected): pass, then fail on an
//    upload at the size change.
// 4. evaluateWithinBudget, evaluatePredictedRegions and evaluatePerturbRecorded on hand-built
//    frames, checkpoints and recordings.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Checkpoint,
  RecordingSummary,
  Transaction,
} from "../lib/gate0-checks";
import type { HookLine } from "../lib/gate2b-checks";
import type { Frame, OracleLog } from "../lib/gate4-checks";
import {
  evaluateLayoutCensus,
  type LayoutExpected,
  layoutCensusFromLog,
} from "../lib/gate4c-checks";
import {
  asGate4,
  checkMsdfSelfConsistent,
  evaluateMsdfArgs,
  evaluateMsdfGlyphCommands,
  evaluateMsdfOracle,
  evaluatePerturbRecorded,
  evaluatePredictedRegions,
  evaluateWithinBudget,
  type MsdfExpected,
  type MsdfGlyph,
  type MsdfNode,
  msdfPageKey,
} from "../lib/gate4e-checks";

type Assert = (name: string, ok: boolean, detail?: string) => void;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const f32 = (v: number) => Math.fround(v);
const ink = (t: string) => [...t].filter((c) => !/\s/u.test(c));

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

/** The synthetic world: oracle lines, the page id and a recording that agrees with them. */
function buildWorld(expected: MsdfExpected) {
  const { msdf_size, msdf_pixel_range, cache } = expected.msdf;
  const pageKey = `${cache}/0#0`;
  const pageIds = new Map<string, number>([[pageKey, 2]]);
  const lines: unknown[] = [];
  const transactions: Transaction[] = [];
  const names = expected.creation_order;
  const itemId = (n: string) => 100 + names.indexOf(n);
  const indices = new Map<string, number>();
  const indexOf = (c: string) => {
    if (!indices.has(c)) indices.set(c, indices.size + 1);
    return indices.get(c) ?? 0;
  };
  let prev: { items: unknown[]; textures: unknown[] } | undefined;
  for (const s of expected.steps) {
    const nodes: MsdfNode[] = [];
    for (const name of expected.text_nodes) {
      const t = s.texts[name];
      const glyphs: MsdfGlyph[] = [];
      const add = (
        pass: MsdfGlyph["pass"],
        outline: number,
        colour: number[],
      ) => {
        for (const [i, c] of ink(t.text).entries())
          glyphs.push({
            pass,
            index: indexOf(c),
            font_key: t.font_key,
            size: t.size,
            cache_size: msdf_size,
            outline,
            x: i * 10.5,
            y: 13.25,
            quad: [
              f32(i * 10.5 - 6.7),
              f32(-3.4),
              f32(26 * (t.size / 48) * 2),
              29,
            ],
            uv: [i * 80 + 1, 1, 78, 87],
            page: 0,
            msdf: true,
            px_range: msdf_pixel_range,
            scale: t.size / msdf_size,
            colour: colour.map(f32) as MsdfGlyph["colour"],
          });
      };
      if (t.outline_size > 0)
        add("outline", t.outline_size, t.outline_colour ?? [0, 0, 0, 1]);
      add("text", 0, t.colour);
      nodes.push({
        name,
        text: t.text,
        font_key: t.font_key,
        size: t.size,
        colour: t.colour.map(f32) as MsdfNode["colour"],
        global_xform: [1, 0, 0, 1, 0, 0],
        font_height: 0,
        ascent: 0,
        lines: 1,
        shaped_glyphs: 0,
        outline_size: t.outline_size,
        outline_colour: (t.outline_colour ?? [
          0, 0, 0, 1,
        ]) as MsdfNode["colour"],
        glyphs,
      });
    }
    const c = expected.caches[cache];
    const pages = [
      {
        font_key: expected.msdf.font_key,
        size: msdf_size,
        outline: 0,
        index: 0,
        width: c.width,
        height: c.height,
        format: c.format,
        mipmaps: false,
        data_bytes: c.data_bytes,
        sha256: `${pageKey}@${s.step}`,
      },
    ];
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
            op: "add_msdf_texture_rect_region",
            tex: pageIds.get(msdfPageKey(g)),
            outline: g.outline,
            rect: g.quad,
            src: g.uv,
            modulate: g.colour,
            px_range: g.px_range,
            scale: f32(g.scale),
          }))
        : name === "P" || name === "Marker"
          ? [
              {
                op: "add_rect",
                rect: [0, 0, 1, 1],
                color: (name === "P"
                  ? expected.panel.rgba8
                  : s.marker_rgba8
                ).map((v) => f32(v / 255)),
              },
            ]
          : [];
      return { id: itemId(name), commands };
    });
    const textures = [
      {
        id: 2,
        kind: "image",
        status: "ok",
        version: s.wire_versions[pageKey] ?? 1,
        format: c.format,
        width: c.width,
        height: c.height,
        mipmaps: false,
      },
    ];
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

/** The hook log the census predicts: the engine's strip, then the page's creates and updates in
 * each step's applied frame. */
function hookFor(expected: MsdfExpected): HookLine[] {
  const line = (frame: number, op: string, id: number, version: number) =>
    ({
      frame,
      op,
      id,
      version,
      thread: "main",
      format: id === 1 ? "RGBA8" : null,
      width: id === 1 ? 800 : null,
      height: id === 1 ? 6 : null,
    }) as unknown as HookLine;
  const out: HookLine[] = [line(1, "texture_2d_create", 1, 1)];
  const key = `${expected.msdf.cache}/0#0`;
  let have = 0;
  for (const s of expected.steps) {
    const want = s.hook_versions[key];
    for (let v = have + 1; v <= want; v++)
      out.push(
        line(
          s.applied_frame,
          v === 1 ? "texture_2d_create" : "texture_2d_update",
          2,
          v,
        ),
      );
    have = want;
  }
  return out;
}

function solid(w: number, h: number, value: number): Frame {
  return { width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(value) };
}

export async function gate4eCases(
  assert: Assert,
  experimentDir: string,
): Promise<void> {
  const { passes, fails } = helpers(assert);
  const expected = JSON.parse(
    await readFile(
      join(experimentDir, "fixtures", "gate4-msdf", "expected.json"),
      "utf8",
    ),
  ) as MsdfExpected;

  // 1. expected.json's rules.
  const committed = checkMsdfSelfConsistent(expected);
  passes(
    "expected-self-consistent-msdf (committed)",
    committed.passed ? [] : [committed.detail],
  );
  {
    const e = clone(expected);
    e.steps[2].page_uploads = { [e.msdf.cache]: 1 };
    const c = checkMsdfSelfConsistent(e);
    fails(
      "expected-self-consistent-msdf (an upload at the size change)",
      c.passed ? [] : [c.detail],
      "page_uploads",
    );
    const m = clone(expected);
    m.msdf.msdf_size = 128;
    const d = checkMsdfSelfConsistent(m);
    fails(
      "expected-self-consistent-msdf (msdf_size 128)",
      d.passed ? [] : [d.detail],
      "48 / 24",
    );
  }

  // 2. Oracle, glyph commands and arguments.
  const w = buildWorld(expected);
  passes(
    "evaluateMsdfOracle (synthetic)",
    evaluateMsdfOracle(expected, [w.oracle]),
  );
  {
    const o = clone(w.oracle);
    const node = (o.lines[3].nodes as unknown as MsdfNode[]).find(
      (n) => n.name === "M40",
    );
    if (node) node.glyphs[0].outline = 0;
    fails(
      "evaluateMsdfOracle (an outline-pass glyph with outline 0)",
      evaluateMsdfOracle(expected, [o]),
      "outline",
    );
    const o2 = clone(w.oracle);
    (o2.lines[2].nodes as unknown as MsdfNode[])[1].glyphs[0].scale = 0.5;
    fails(
      "evaluateMsdfOracle (M24 at the old scale after the size change)",
      evaluateMsdfOracle(expected, [o2]),
      "scale",
    );
    const o3 = clone(w.oracle);
    (o3.lines[1].nodes as unknown as MsdfNode[])[0].glyphs.pop();
    fails(
      "evaluateMsdfOracle (a dropped glyph)",
      evaluateMsdfOracle(expected, [o3]),
      "glyph commands",
    );
  }
  passes(
    "evaluateMsdfGlyphCommands (synthetic)",
    evaluateMsdfGlyphCommands(expected, w.oracle, w.recording, w.pageIds)
      .problems,
  );
  const tamper = (
    mutate: (cmd: Record<string, unknown>) => void,
    frame: number,
    item: string,
  ): RecordingSummary => {
    const r = clone(w.recording);
    const tx = r.transactions.find((t) => t.meta.frame === frame);
    const it = tx?.meta.items.find((i) => i.id === w.itemId(item));
    if (it?.commands[0])
      mutate(it.commands[0] as unknown as Record<string, unknown>);
    return r;
  };
  const settle = (k: number) => expected.steps[k].settle_frame;
  fails(
    "evaluateMsdfGlyphCommands (a quad moved by a quarter pixel)",
    evaluateMsdfGlyphCommands(
      expected,
      w.oracle,
      tamper(
        (c) => {
          const r = c.rect as number[];
          r[0] = f32(r[0] + 0.25);
        },
        settle(4),
        "M16",
      ),
      w.pageIds,
    ).problems,
    "rect",
  );
  fails(
    "evaluateMsdfGlyphCommands (the outline pass recorded with outline 0)",
    evaluateMsdfGlyphCommands(
      expected,
      w.oracle,
      tamper(
        (c) => {
          c.outline = 0;
        },
        settle(3),
        "M40",
      ),
      w.pageIds,
    ).problems,
    "outline",
  );
  fails(
    "evaluateMsdfGlyphCommands (a plain region command)",
    evaluateMsdfGlyphCommands(
      expected,
      w.oracle,
      tamper(
        (c) => {
          c.op = "add_texture_rect_region";
        },
        settle(0),
        "MT",
      ),
      w.pageIds,
    ).problems,
    "add_texture_rect_region",
  );
  passes(
    "evaluateMsdfArgs (synthetic)",
    evaluateMsdfArgs(expected, w.recording).problems,
  );
  fails(
    "evaluateMsdfArgs (px_range 14, FontFile.new()'s default)",
    evaluateMsdfArgs(
      expected,
      tamper(
        (c) => {
          c.px_range = 14;
        },
        settle(5),
        "MR",
      ),
    ).problems,
    "px_range",
  );
  fails(
    "evaluateMsdfArgs (a typed msdf refusal)",
    evaluateMsdfArgs(
      expected,
      tamper(
        (c) => {
          for (const k of Object.keys(c)) delete c[k];
          c.op = "unsupported";
          c.name = "canvas_item_add_msdf_texture_rect_region";
          c.reason = "unsupported-op";
        },
        settle(1),
        "M24",
      ),
    ).problems,
    "unsupported msdf",
  );

  // 3. The census.
  {
    const layout = expected as unknown as LayoutExpected;
    const hook = hookFor(expected);
    const census = layoutCensusFromLog(layout, hook, w.pageIds, 400);
    passes(
      "atlas-census-msdf (hook log as predicted)",
      evaluateLayoutCensus(layout, census, w.recording, w.pageIds),
    );
    const extra = [
      ...hook,
      {
        ...hook[1],
        frame: expected.steps[2].applied_frame,
        op: "texture_2d_update",
        version: 99,
      } as HookLine,
    ];
    fails(
      "atlas-census-msdf (an upload at the size change)",
      evaluateLayoutCensus(
        layout,
        layoutCensusFromLog(layout, extra, w.pageIds, 400),
        w.recording,
        w.pageIds,
      ),
      "updates",
    );
  }

  // 4. Budgets, predicted regions, perturb-glyph as recorded.
  {
    const g4 = asGate4(expected);
    const ref = new Map<string, Frame | null>();
    const same = new Map<string, Frame | null>();
    const off = new Map<string, Frame | null>();
    for (const s of [
      ...expected.steps.map((x) => `step-${x.step}.png`),
      ...expected.early_shot_steps.map((k) => `early-${k}.png`),
    ]) {
      ref.set(s, solid(640, 360, 10));
      same.set(s, solid(640, 360, 10));
      const f = solid(640, 360, 10);
      const [x0, y0] = expected.steps[0].text_regions.M16;
      f.rgba[(y0 * 640 + x0) * 4] = 11;
      off.set(s, f);
    }
    const zero = [
      { region: "full", max_channel_delta: 0, mismatched_pixels: 0 },
      ...Object.keys(expected.regions).map((region) => ({
        region,
        max_channel_delta: 0,
        mismatched_pixels: 0,
      })),
      ...expected.text_nodes.map((region) => ({
        region,
        max_channel_delta: 0,
        mismatched_pixels: 0,
      })),
    ];
    passes(
      "evaluateWithinBudget (identical, budget 0)",
      evaluateWithinBudget(g4, ref, same, zero).problems,
    );
    fails(
      "evaluateWithinBudget (one channel off by 1, budget 0)",
      evaluateWithinBudget(g4, ref, off, zero).problems,
      "exceeds the budget",
    );
    passes(
      "evaluateWithinBudget (one channel off by 1, a measured budget of 1)",
      evaluateWithinBudget(
        g4,
        ref,
        off,
        zero.map((b) => ({ ...b, max_channel_delta: 1 })),
      ).problems,
    );

    const cp = (step: number, bad: Record<string, number>): Checkpoint => {
      const regions = Object.keys({
        ...expected.regions,
        ...expected.steps[0].text_regions,
      }).map((name) => ({
        name,
        rect_px: [0, 0, 1, 1],
        mismatched_pixels: bad[name] ?? 0,
        max_channel_delta: bad[name] ? 9 : 0,
      }));
      return {
        step,
        settle_frame: 0,
        seq: null,
        reference_png: "",
        receiver_png: null,
        diff_png: null,
        mismatched_pixels: Object.values(bad).reduce((a, b) => a + b, 0),
        max_channel_delta: 9,
        regions,
      } as unknown as Checkpoint;
    };
    passes(
      "evaluatePredictedRegions (M16 only, as predicted)",
      evaluatePredictedRegions(g4, [cp(1, { M16: 30 })], { 1: ["M16"] }),
    );
    fails(
      "evaluatePredictedRegions (MR differs, never redrawn)",
      evaluatePredictedRegions(g4, [cp(1, { M16: 30, MR: 4 })], {
        1: ["M16"],
      }),
      "MR",
    );
    fails(
      "evaluatePredictedRegions (a predicted region matches)",
      evaluatePredictedRegions(g4, [cp(2, { M16: 30 })], {
        2: ["M16", "M24"],
      }),
      "M24",
    );

    const regions =
      expected.predictions["sabotage-msdf-perturb-glyph"].regions ?? {};
    const moved = clone(w.recording);
    for (const s of expected.steps) {
      const tx = moved.transactions.find(
        (t) => t.meta.frame === s.settle_frame,
      );
      for (const name of regions[String(s.step)] ?? [])
        for (const c of tx?.meta.items.find((i) => i.id === w.itemId(name))
          ?.commands ?? [])
          if (c.rect) c.rect[0] = f32(c.rect[0] + 0.25);
    }
    const r = evaluatePerturbRecorded(g4, w.recording, moved, regions);
    passes(
      "evaluatePerturbRecorded (predicted Labels moved by +0.25)",
      r.problems,
    );
    assert(
      "evaluatePerturbRecorded counts the moved commands",
      r.moved > 0,
      String(r.moved),
    );
    fails(
      "evaluatePerturbRecorded (nothing moved)",
      evaluatePerturbRecorded(g4, w.recording, w.recording, regions).problems,
      "+0.25 predicted",
    );
  }
}
