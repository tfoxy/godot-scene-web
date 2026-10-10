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
// agreement (grouping an outlined span's two expanded entries by `key`, Q6c), and the
// mismatch-confined-to-one-region check the underline variant leg needs. The oracle lines below
// are synthesized from the committed fixtures/gate4-rich/expected.json's own `spans` (one entry
// per span, two for an outlined one), independently of glyph_oracle.gd -- the same arm's-length
// relationship self-test-gate4.ts's own `buildWorld` keeps from fixtures/gate4/glyph_oracle.gd.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Checkpoint } from "../lib/gate0-checks";
import type { OraclePage } from "../lib/gate4-expected";
import {
  checkMismatchConfinedToRegion,
  evaluateRichOracleAgrees,
  type Gate4RichExpected,
  type RichOracleLine,
  type RichOracleLog,
  type RichOracleSpan,
} from "../lib/gate4d-checks";

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
// checkMismatchConfinedToRegion
// ---------------------------------------------------------------------------------------------

function checkpoint(step: number, regions: Record<string, number>): Checkpoint {
  return {
    step,
    settle_frame: step,
    seq: step,
    reference_png: "",
    receiver_png: "",
    diff_png: null,
    mismatched_pixels: Object.values(regions).reduce((a, b) => a + b, 0),
    max_channel_delta: 255,
    regions: Object.entries(regions).map(([name, mismatched_pixels]) => ({
      name,
      rect_px: [0, 0, 1, 1],
      mismatched_pixels,
      max_channel_delta: mismatched_pixels > 0 ? 255 : 0,
    })),
  };
}

function confinedCases(): void {
  const confined = [
    checkpoint(0, { RTL: 12, marker: 0 }),
    checkpoint(1, { RTL: 20, marker: 0 }),
  ];
  assert(
    "checkMismatchConfinedToRegion passes when only RTL differs",
    checkMismatchConfinedToRegion(confined, "RTL").length === 0,
  );

  const leaksElsewhere = [
    checkpoint(0, { RTL: 12, marker: 4 }),
    checkpoint(1, { RTL: 20, marker: 0 }),
  ];
  const leakProblems = checkMismatchConfinedToRegion(leaksElsewhere, "RTL");
  assert(
    "checkMismatchConfinedToRegion fails when marker also differs",
    leakProblems.some((p) => p.includes("marker")),
    leakProblems.join(" | "),
  );

  const noMismatchAtAll = [checkpoint(0, { RTL: 0, marker: 0 })];
  const noneProblems = checkMismatchConfinedToRegion(noMismatchAtAll, "RTL");
  assert(
    "checkMismatchConfinedToRegion fails when RTL itself has no mismatch",
    noneProblems.some((p) => p.includes("no mismatch")),
    noneProblems.join(" | "),
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
  confinedCases();

  console.log(
    `\nself-test-gate4d: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
