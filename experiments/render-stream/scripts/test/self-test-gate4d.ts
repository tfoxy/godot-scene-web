#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for the gate 4d checker (lib/gate4d-checks.ts, group g4d: fixtures/gate4-rich/).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate4d.ts
//
// Most of gate4d-checks.ts reuses G4a/G4b's own pure functions unchanged (atlas-hash-parity,
// atlas-append-only, atlas-census, expected-image, ink-presence, ...), already proven by
// self-test-gate4.ts against the same `evaluate*` functions this file imports through
// gate4d-checks.ts's re-exports; this file covers only what G4d adds: the per-span oracle
// agreement (grouping an outlined span's two expanded entries by `key`, Q6c), and -- since G5d
// (gate5-design.md Q6g, render-stream/4) -- the two class checks whose meaning changed:
// `rich-leg-class-capture` (success, no unsupported op, RTL's per-glyph add_set_transform pairs
// carried as identity commands) and `rich-underline-capture-class` (success, the [u] underline a
// wide add_line). Until G5d both expected "unsupported" and the underline receiver's mismatch was
// confined to RTL's region (checkMismatchConfinedToRegion, retired with that prediction). The
// oracle lines below are synthesized from the committed fixtures/gate4-rich/expected.json's own
// `spans` (one entry per span, two for an outlined one), independently of glyph_oracle.gd -- the
// same arm's-length relationship self-test-gate4.ts's own `buildWorld` keeps from
// fixtures/gate4/glyph_oracle.gd.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CaptureResultJson,
  GATE0_HOOKS,
  type RecordingSummary,
  summarizeRecording,
} from "../lib/gate0-checks";
import type { OraclePage } from "../lib/gate4-expected";
import {
  checkRichCaptureLegClass,
  checkRichUnderlineCaptureClass,
  evaluateRichOracleAgrees,
  type Gate4RichExpected,
  type RichCaptureEvaluation,
  type RichOracleLine,
  type RichOracleLog,
  type RichOracleSpan,
} from "../lib/gate4d-checks";
import {
  encodeRs2Recording,
  type TCommand,
  type TItem,
  type TState,
} from "./rs2-test-encoder";

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
// rich-oracle-agrees
// ---------------------------------------------------------------------------------------------

function oracleCases(
  expected: Gate4RichExpected,
  lines: readonly RichOracleLine[],
): void {
  const log: RichOracleLog = {
    leg: "test",
    path: "test",
    text: lines.map((l) => JSON.stringify(l)).join("\n"),
    lines: lines.map(clone),
    problem: null,
  };

  passes("rich-oracle-agrees", evaluateRichOracleAgrees(expected, [log]));

  // A second, byte-differing "leg" fails the identical-logs requirement.
  const other: RichOracleLog = {
    ...clone(log),
    leg: "test2",
    text: `${log.text}\n`,
  };
  fails(
    "rich-oracle-agrees (legs differ)",
    evaluateRichOracleAgrees(expected, [log, other]),
    "differs from",
  );

  // A wrong glyph_count on the outlined span's fill entry.
  const badCount = clone(log);
  const step4 = badCount.lines.find((l) => l.step === 4);
  const outlineFill = step4?.spans.find(
    (s) => s.key === "outline" && s.font_key === "F",
  );
  if (outlineFill) outlineFill.glyph_count = outlineFill.glyph_count + 1;
  fails(
    "rich-oracle-agrees (wrong glyph_count)",
    evaluateRichOracleAgrees(expected, [badCount]),
    "glyph_count",
  );

  // Dropping the outlined span's outline-pass entry (leaving only the fill) must be caught: an
  // outlined span needs exactly two oracle entries sharing its key (Q1b/Q1d, gate4-rich.gd's
  // header), not one.
  const missingOutline = clone(log);
  const step4b = missingOutline.lines.find((l) => l.step === 4);
  if (step4b)
    step4b.spans = step4b.spans.filter(
      (s) => !(s.key === "outline" && s.font_key === "FO"),
    );
  fails(
    "rich-oracle-agrees (missing outline-pass entry)",
    evaluateRichOracleAgrees(expected, [missingOutline]),
    "oracle entries",
  );

  // A wrong page_glyphs prediction (expected.json itself perturbed) must be caught.
  const badExpected = clone(expected);
  const s5 = badExpected.steps.find((s) => s.step === 5);
  if (s5) s5.page_glyphs["F@16"] = s5.page_glyphs["F@16"] + 1;
  fails(
    "rich-oracle-agrees (wrong page_glyphs)",
    evaluateRichOracleAgrees(badExpected, [log]),
    "distinct glyphs seen so far",
  );
}

// ---------------------------------------------------------------------------------------------
// rich-leg-class-capture and rich-underline-capture-class (render-stream/4, since G5d)
// ---------------------------------------------------------------------------------------------

const IDENTITY = [1, 0, 0, 1, 0, 0];
const ID_RTL = 2;
const ID_SCROLL = 3;
const ID_MARKER = 4;

/** RTL's commands at one step, as RichTextLabel emits them: for every glyph of the text pass,
 * set_transform(char_final_xform) (identity without [fx]), the glyph, set_transform(identity)
 * (scene/gui/rich_text_label.cpp:1358-1378, :1427). `xform` replaces the first transform. */
function rtlCommands(glyphs: number, xform = IDENTITY): TCommand[] {
  const out: TCommand[] = [];
  for (let g = 0; g < glyphs; g++)
    out.push(
      { op: "add_set_transform", transform: g === 0 ? xform : IDENTITY },
      {
        op: "add_texture_rect_region",
        tex: null,
        rect: [24 + 8 * g, 32, 8, 16],
        src: [0, 0, 8, 16],
        modulate: [1, 1, 1, 1],
      },
      { op: "add_set_transform", transform: IDENTITY },
    );
  return out;
}

/** A small recording shaped like rich-capture's: RTL, its VScrollBar and Marker (creation order),
 * one transaction per frame up to the last settle frame, RTL redrawn with `rtl(step)` and Marker
 * in its step colour (mapRichNames's anchor). */
function richRecording(
  expected: Gate4RichExpected,
  rtl: (step: number) => TCommand[],
  edit: (s: TState) => TState = (s) => s,
): RecordingSummary {
  const last = Math.max(...expected.steps.map((s) => s.settle_frame));
  const stepAt = (frame: number) =>
    [...expected.steps].reverse().find((s) => s.settle_frame <= frame) ??
    expected.steps[0];
  const states: TState[] = [];
  for (let frame = 1; frame <= last; frame++) {
    const s = stepAt(frame);
    const item = (
      id: number,
      draw: number,
      commands: TCommand[],
      parent: TItem["parent"] = { kind: "canvas", id: 1 },
      children: number[] = [],
    ): TItem => ({
      id,
      parent,
      children,
      visible: true,
      draw_index: draw,
      z_index: 0,
      visibility_layer: 1,
      content_version: s.step + 1,
      xform: [1, 0, 0, 1, 0, 0],
      modulate: [1, 1, 1, 1],
      self_modulate: [1, 1, 1, 1],
      commands,
    });
    states.push(
      edit({
        frame,
        canvases: [
          {
            id: 1,
            origin: "root-query",
            role: "root",
            items: [ID_RTL, ID_MARKER],
            xform: [1, 0, 0, 1, 0, 0],
          },
        ],
        items: [
          item(ID_RTL, 1, rtl(s.step), undefined, [ID_SCROLL]),
          item(ID_SCROLL, 0, [], { kind: "item", id: ID_RTL }),
          item(ID_MARKER, 2, [
            {
              op: "add_rect",
              rect: [0, 0, 16, 16],
              color: s.marker_rgba8.map((c) => c / 255),
            },
          ]),
        ],
      }),
    );
  }
  const bytes = encodeRs2Recording(states, {
    encoding: "full",
    hooksPlanned: [...GATE0_HOOKS],
  });
  return summarizeRecording("rich.rs2", new Uint8Array(bytes));
}

const ARMED: CaptureResultJson = {
  status: "armed",
  stream: { status: "closed" },
} as CaptureResultJson;

function evaluation(
  full: RecordingSummary,
  resultClass: RichCaptureEvaluation["result_class"] = "success",
): RichCaptureEvaluation {
  return {
    expected_class: "success",
    result_class: resultClass,
    reasons: [],
    harmless_ties: [],
    exit_code: 0,
    artifacts: [],
    full,
    patch: full,
    captureResult: ARMED,
  };
}

function captureClassCases(expected: Gate4RichExpected): void {
  const good = richRecording(expected, (step) => rtlCommands(3 + step));
  const ok = checkRichCaptureLegClass(evaluation(good), expected);
  passes(
    "rich-leg-class-capture (per-glyph identity set_transform pairs)",
    ok.status === "pass" ? [] : [ok.detail],
  );
  assert(
    "rich-leg-class-capture reports the per-step add_set_transform count",
    ok.detail.includes("0:6/3"),
    ok.detail,
  );
  fails(
    "rich-leg-class-capture (the render-stream/3 class, unsupported)",
    [checkRichCaptureLegClass(evaluation(good, "unsupported"), expected)]
      .filter((c) => c.status !== "pass")
      .map((c) => c.detail),
  );
  const typed = richRecording(expected, (step) =>
    rtlCommands(3 + step).map((c) =>
      c.op === "add_set_transform"
        ? {
            op: "unsupported" as const,
            name: "canvas_item_add_set_transform",
            reason: "unsupported-op" as const,
          }
        : c,
    ),
  );
  const typedCheck = checkRichCaptureLegClass(evaluation(typed), expected);
  assert(
    "rich-leg-class-capture fails on set_transform typed unsupported (render-stream/3's shape)",
    typedCheck.status === "fail" &&
      typedCheck.detail.includes("canvas_item_add_set_transform"),
    typedCheck.detail,
  );
  const dropped = richRecording(expected, (step) =>
    rtlCommands(3 + step).filter((c) => c.op !== "add_set_transform"),
  );
  const droppedCheck = checkRichCaptureLegClass(evaluation(dropped), expected);
  assert(
    "rich-leg-class-capture fails when RTL carries no add_set_transform (the mirror dropped them)",
    droppedCheck.status === "fail",
    droppedCheck.detail,
  );
  const skewed = richRecording(expected, (step) =>
    rtlCommands(3 + step, step === 2 ? [1, 0, 0.2, 1, 0, 0] : IDENTITY),
  );
  const skewedCheck = checkRichCaptureLegClass(evaluation(skewed), expected);
  assert(
    "rich-leg-class-capture fails on a non-identity add_set_transform (no [fx] in this fixture)",
    skewedCheck.status === "fail" && skewedCheck.detail.includes("step 2"),
    skewedCheck.detail,
  );
}

function underlineCases(expected: Gate4RichExpected): void {
  // The test encoder has no add_line op, so the underline is spliced into the decoded summary:
  // classifyLeg and the check read only the summary's commands and unsupported entries.
  const withLine = (width: number): RecordingSummary => {
    const rec = richRecording(expected, (step) => rtlCommands(3 + step));
    for (const t of rec.transactions)
      for (const it of t.meta.items)
        if (it.id === ID_RTL)
          it.commands.push({
            op: "add_line",
            aa: false,
            from: [24, 50],
            to: [64, 50],
            colour: [1, 1, 0, 0.8],
            width,
          } as (typeof it.commands)[number]);
    return rec;
  };
  const ok = checkRichUnderlineCaptureClass(withLine(1), ARMED);
  passes(
    "rich-underline-capture-class (a wide add_line, success)",
    ok.status === "pass" ? [] : [ok.detail],
  );
  const none = checkRichUnderlineCaptureClass(
    richRecording(expected, (step) => rtlCommands(3 + step)),
    ARMED,
  );
  assert(
    "rich-underline-capture-class fails with no add_line at all",
    none.status === "fail" && none.detail.includes("no add_line"),
    none.detail,
  );
  const thin = checkRichUnderlineCaptureClass(withLine(-1), ARMED);
  assert(
    "rich-underline-capture-class fails on a thin (width < 1) line",
    thin.status === "fail" && thin.detail.includes("not wide"),
    thin.detail,
  );
  const typed = withLine(1);
  for (const t of typed.transactions)
    for (const it of t.meta.items)
      it.commands = it.commands.map((c) =>
        c.op === "add_line"
          ? {
              op: "unsupported",
              name: "canvas_item_add_line",
              reason: "unsupported-op",
            }
          : c,
      );
  const typedCheck = checkRichUnderlineCaptureClass(typed, ARMED);
  assert(
    "rich-underline-capture-class fails on add_line typed unsupported (render-stream/3's shape)",
    typedCheck.status === "fail" &&
      typedCheck.detail.includes("expected success"),
    typedCheck.detail,
  );
}

// ---------------------------------------------------------------------------------------------
// A synthetic oracle, independent of glyph_oracle.gd (as self-test-gate4.ts's own `buildWorld`
// is independent of fixtures/gate4/glyph_oracle.gd): one oracle entry per expected.json span
// (two, sharing its `key`, for an outlined one), glyph_count the span's text length, and a fake
// glyph index per distinct codepoint seen so far in that cache -- just enough structure for
// evaluateRichOracleAgrees's own rules to hold.
// ---------------------------------------------------------------------------------------------

function synthesizeOracleLines(expected: Gate4RichExpected): RichOracleLine[] {
  const indexOf = new Map<string, Map<string, number>>();
  let nextIndex = 1;
  const indexFor = (cache: string, ch: string): number => {
    const forCache = indexOf.get(cache) ?? new Map<string, number>();
    indexOf.set(cache, forCache);
    let idx = forCache.get(ch);
    if (idx === undefined) {
      idx = nextIndex++;
      forCache.set(ch, idx);
    }
    return idx;
  };
  const pageOf = (cache: string): OraclePage => ({
    font_key: cache.split("@")[0],
    size: Number(cache.split("@")[1]),
    outline: 0,
    index: 0,
    width: expected.page.width,
    height: expected.page.height,
    format: expected.page.format,
    mipmaps: expected.page.mipmaps,
    data_bytes: expected.page.data_bytes,
    sha256: `sha-${cache}`,
  });
  return expected.steps.map((s) => {
    const spans: RichOracleSpan[] = [];
    const caches = new Set<string>();
    for (const sp of s.spans) {
      const fillCache = `${sp.font_key}@${sp.size}`;
      caches.add(fillCache);
      spans.push({
        key: sp.key,
        font_key: sp.font_key,
        size: sp.size,
        glyph_count: sp.text.length,
        glyph_indices: [...new Set(sp.text)]
          .map((ch) => indexFor(fillCache, ch))
          .sort((a, b) => a - b),
        page: 0,
      });
      if (sp.outline > 0) {
        const outlineCache = `${sp.font_key}O@${sp.size}`;
        caches.add(outlineCache);
        spans.push({
          key: sp.key,
          font_key: `${sp.font_key}O`,
          size: sp.size,
          glyph_count: sp.text.length,
          glyph_indices: [...new Set(sp.text)]
            .map((ch) => indexFor(outlineCache, ch))
            .sort((a, b) => a - b),
          page: 0,
        });
      }
    }
    return {
      schema: "render-stream-gate4-glyphs/1" as const,
      step: s.step,
      frame: s.settle_frame,
      spans,
      pages: [...caches].map(pageOf),
    };
  });
}

async function main(): Promise<void> {
  const fixture = join(EXPERIMENT_DIR, "fixtures", "gate4-rich");
  const expected = JSON.parse(
    await readFile(join(fixture, "expected.json"), "utf8"),
  ) as Gate4RichExpected;
  const oracleLines = synthesizeOracleLines(expected);

  oracleCases(expected, oracleLines);
  captureClassCases(expected);
  underlineCases(expected);

  console.log(
    `\nself-test-gate4d: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
