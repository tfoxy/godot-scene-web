// @vitest-environment node
//
// ONE HARFBUZZ, GRADED AGAINST THE OTHER ONE.
//
// `hb-gpu.symbols` now exports `hb_shape`, which means this repo has two HarfBuzz builds that can
// shape the same run — `vendor/hb-gpu.wasm` and npm `harfbuzzjs` — and only one of them was ever
// checked. The whole point of consolidating onto the first is that consumers stop loading the
// second, so this file is the evidence that doing so does not move a single glyph.
//
// WHY THIS IS A STRONG CHECK AND NOT A TAUTOLOGY. The two are separately compiled from separately
// obtained sources with different feature configurations (`vendor/` is `HB_TINY` plus the GPU
// encoder; harfbuzzjs is its own build of its own version), they run in two wasm instances with two
// heaps, and the only thing they share is the font file. If this package's buffer plumbing —
// UTF-16 into the heap, segment properties before the guess, `hb_glyph_info_t` at 20 bytes a
// stride, `hb_position_t` read signed — were wrong in any way that mattered, it would have to be
// wrong in exactly the way an independent build is right.
//
// WHAT `HB_TINY` COSTS, SO A FUTURE FAILURE IS NOT A MYSTERY. `util/gpu/web/config.h` strips AAT
// layout, the legacy `kern` table (GPOS kerning is intact), vertical writing, and the rarely-used
// GSUB/GPOS subtable formats. Latin and Han through GSUB/GPOS are untouched by all of that, which
// is why the fixture faces agree exactly. A face that relied on a `kern` table, or an AAT-only
// Apple font, legitimately would not — that is a documented difference, not a regression.
//
// THE PEN POSITIONS ARE COMPARED TOO, not just the raw numbers. `packages/perf-harness`'s arms turn
// HarfBuzz output into CSS px with `(pen + xOffset) * fontSizePx / upem`, and that arithmetic is
// what a mis-scaled or sign-flipped port would break while every individual field still matched.
// So the same accumulation is run over both shapers' output and the two arrays compared.
//
// LOADS THE GLUE, WHICH `vendor.test.ts` DELIBERATELY DOES NOT — and can, for a reason that file
// predates: `-sINCOMING_MODULE_JS_API=wasmBinary` made `wasmBinary` a supported key, so the glue
// never reaches its (compiled-out) fetch path and the `-sENVIRONMENT=web,worker` build instantiates
// fine under node. Without those bytes it still aborts exactly as documented.
//
// SKIPPED, NOT FAILED, when a fixture font is absent. Both are gitignored and downloaded on demand.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createHbGpu,
  type HbGpu,
  type HbGpuFailure,
  type HbGpuFont,
  type HbGpuModuleFactory,
  type HbGpuShapedGlyph,
  type HbGpuShapeOptions,
} from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const glueFile = join(here, "..", "vendor", "hb-gpu.mjs");
const wasmFile = join(here, "..", "vendor", "hb-gpu.wasm");

const fontsDir = join(repoRoot, "fixtures", "assets", "fonts");

/**
 * U+25A0 BLACK SQUARE, S9's presence beacon. In both fixture subsets, so both runs can lead with
 * it — and it is the one character that exercises a cmap lookup outside the run's own script.
 */
const BEACON = "■";

/** Contiguous Han from U+4E00, which is exactly how `scripts/ensure-cjk-font.ts` builds its pool. */
const HAN = String.fromCodePoint(
  ...Array.from({ length: 12 }, (_, i) => 0x4e00 + i),
);

interface Fixture {
  /** Names the arm in the test title, and in the skip message. */
  name: string;
  file: string;
  /** How the font is obtained when it is not there. */
  ensure: string;
  runs: { what: string; text: string; options?: HbGpuShapeOptions }[];
}

const FIXTURES: Fixture[] = [
  {
    name: "Roboto (Latin)",
    file: join(fontsDir, "roboto", "Roboto-bench.ttf"),
    ensure: "scripts/ensure-latin-font.ts",
    runs: [
      // KERNING PAIRS AND LIGATURES ON PURPOSE. "Wa", "AV", "To" are GPOS kern pairs and "ffi"/"fl"
      // are `liga` substitutions, so a shaper that silently fell back to one-glyph-per-character
      // would come back with a different glyph COUNT here, not just different advances. That is
      // the failure `HB_NO_LEGACY` could plausibly have caused and did not.
      { what: "kerning pairs and ligatures", text: "Waffle office AV To." },
      {
        what: "the whole printable ASCII range",
        // Every codepoint the subset carries, so a cmap difference anywhere shows up.
        text: Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
          String.fromCharCode(0x20 + i),
        ).join(""),
      },
      { what: "the beacon beside Latin", text: `${BEACON} Latin ${BEACON}` },
      {
        what: "ligatures turned off",
        text: "Waffle office",
        // The `liga` feature is on by default, so this changes the run — which is the point: a
        // features array that silently did nothing would produce the identical glyphs and pass.
        options: { features: ["-liga"] },
      },
      {
        what: "explicit script, language and direction",
        text: "Waffle office",
        options: { direction: "ltr", script: "Latn", language: "en" },
      },
      {
        what: "an explicitly RTL Latin run",
        // Nothing about this text implies RTL, so `guess_segment_properties` would not choose it.
        // If the direction setter did nothing, the run would come back in the other order.
        text: "Waffle",
        options: { direction: "rtl" },
      },
    ],
  },
  {
    name: "Noto Sans SC (Han)",
    file: join(fontsDir, "noto-sans-sc", "NotoSansSC-bench.ttf"),
    ensure: "scripts/ensure-cjk-font.ts",
    runs: [
      { what: "a Han run", text: HAN },
      { what: "the beacon beside Han", text: `${BEACON}${HAN}` },
      { what: "mixed Han and Latin", text: `${HAN} mixed 123` },
      {
        what: "explicit Hans script and zh-Hans language",
        text: HAN,
        options: { script: "Hans", language: "zh-Hans", direction: "ltr" },
      },
    ],
  },
];

/** `hb_glyph_info_t` + `hb_glyph_position_t` as this package returns them. */
type Run = HbGpuShapedGlyph[];

/**
 * The reference shaper: npm `harfbuzzjs`, driven exactly the way
 * `perf-harness/src/scenarios/text-hb.ts` drives it — `setScale(upem, upem)`, properties set
 * explicitly and then guessed, `shape`, read back.
 */
async function shapeWithHarfbuzzjs(
  bytes: Buffer,
  text: string,
  options: HbGpuShapeOptions = {},
): Promise<{ run: Run; upem: number; version: string }> {
  const hb = await import("harfbuzzjs");
  const blob = new hb.Blob(new Uint8Array(bytes));
  const face = new hb.Face(blob, 0);
  const font = new hb.Font(face);
  font.setScale(face.upem, face.upem);

  const buffer = new hb.Buffer();
  buffer.addText(text);
  if (options.direction) {
    buffer.setDirection(hb.Direction[directionName(options.direction)]);
  }
  if (options.script) buffer.setScript(options.script);
  if (options.language) buffer.setLanguage(options.language);
  buffer.guessSegmentProperties();
  // `Feature.fromString` is typed as possibly-undefined because it can refuse a string. It never
  // does here — these are the same literals `hb_feature_from_string` accepted on the other side —
  // and a refusal must be an error, not a silently dropped feature.
  const features = (options.features ?? []).map((feature) => {
    const parsed = hb.Feature.fromString(feature);
    if (!parsed) throw new Error(`harfbuzzjs would not parse "${feature}"`);
    return parsed;
  });
  hb.shape(font, buffer, features);
  const run = buffer.getGlyphInfosAndPositions().map((item) => ({
    glyphId: item.codepoint,
    cluster: item.cluster,
    xAdvance: item.xAdvance ?? 0,
    yAdvance: item.yAdvance ?? 0,
    xOffset: item.xOffset ?? 0,
    yOffset: item.yOffset ?? 0,
  }));
  // NOTHING IS DESTROYED HERE and nothing can be: harfbuzzjs 1.6.0 exposes no `destroy` on any of
  // its wrappers and collects them itself. That asymmetry with this package — which frees
  // everything explicitly and has a test that proves it — is one of the reasons the two heaps were
  // worth collapsing into one.
  return { run, upem: face.upem, version: hb.versionString() };
}

/** `HbGpuDirection` -> the key `harfbuzzjs` names the same constant by. */
function directionName(direction: string): "LTR" | "RTL" | "TTB" | "BTT" {
  return direction.toUpperCase() as "LTR" | "RTL" | "TTB" | "BTT";
}

/**
 * Pen positions in CSS px, the arithmetic every arm in the S9 round uses.
 *
 * Stated here rather than imported from the perf-harness on purpose: the point is that a consumer
 * writing this from the doc comment on `HbGpuFont.shape` gets the same pixels as one that wrote it
 * from `harfbuzzjs`'s output, and importing the harness's copy would test the harness instead.
 */
function penPositionsPx(run: Run, upem: number, fontSizePx: number): number[] {
  const toPx = fontSizePx / upem;
  const out: number[] = [];
  let pen = 0;
  for (const glyph of run) {
    out.push((pen + glyph.xOffset) * toPx);
    pen += glyph.xAdvance;
  }
  return out;
}

let hbGpu: HbGpu | null = null;
let skipReason = "";
const failures: HbGpuFailure[] = [];
const fonts = new Map<string, { font: HbGpuFont; bytes: Buffer }>();
/** Printed once, so a future disagreement can be attributed to a version rather than a bug. */
let referenceVersion = "";

beforeAll(async () => {
  if (!existsSync(glueFile) || !existsSync(wasmFile)) {
    skipReason =
      "packages/hb-gpu/vendor/hb-gpu.mjs is missing from this checkout — it is committed (see vendor/VENDOR.md); packages/hb-gpu/build.sh rebuilds it with docker + emscripten";
    return;
  }
  const missing = FIXTURES.filter((fixture) => !existsSync(fixture.file));
  if (missing.length === FIXTURES.length) {
    skipReason = `no fixture font is present — both are gitignored and downloaded on demand (${missing.map((f) => f.ensure).join(", ")})`;
    return;
  }

  const wasmBinary = await readFile(wasmFile);
  const module = (await import(pathToFileURL(glueFile).href)) as {
    default: HbGpuModuleFactory;
  };
  hbGpu = await createHbGpu(module.default, wasmBinary, {
    onError: (failure) => failures.push(failure),
  });
  for (const fixture of FIXTURES) {
    if (!existsSync(fixture.file)) continue;
    const bytes = await readFile(fixture.file);
    const font = hbGpu.createFont(new Uint8Array(bytes));
    if (font) fonts.set(fixture.name, { font, bytes });
  }
});

describe("hb-gpu shaping vs npm harfbuzzjs", () => {
  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      for (const run of fixture.runs) {
        it(`agrees glyph for glyph on ${run.what}`, async ({ skip }) => {
          if (skipReason) skip(skipReason);
          if (!existsSync(fixture.file)) {
            skip(
              `${fixture.file} is absent — run ${fixture.ensure} (or any command that calls it) to fetch it`,
            );
          }
          const entry = fonts.get(fixture.name);
          expect(entry, "createFont refused the fixture face").toBeDefined();
          const { font, bytes } = entry as NonNullable<typeof entry>;

          const mine = font.shape(run.text, run.options);
          expect(
            mine,
            `shape returned null: ${failures.map((f) => f.message).join("; ")}`,
          ).not.toBeNull();
          const reference = await shapeWithHarfbuzzjs(
            bytes,
            run.text,
            run.options,
          );
          referenceVersion = reference.version;

          // NON-EMPTY FIRST. Two shapers that both produced nothing would agree perfectly, and
          // "no glyphs" is precisely what a broken buffer plumbing produces.
          expect(
            (mine as Run).length,
            "the run shaped to no glyphs at all",
          ).toBeGreaterThan(0);
          expect(mine).toEqual(reference.run);

          // ...and the pixels those numbers become. 12 px is S9's font size.
          expect(penPositionsPx(mine as Run, font.upem, 12)).toEqual(
            penPositionsPx(reference.run, reference.upem, 12),
          );
        });
      }
    });
  }

  it("shapes into glyph ids the encoder accepts", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const entry =
      fonts.get("Noto Sans SC (Han)") ?? fonts.get("Roboto (Latin)");
    if (!entry) skip("no fixture font is present");
    const { font } = entry as NonNullable<typeof entry>;
    // THE WHOLE POINT OF SHAPING IN THIS MODULE: the ids come back and go straight into
    // `encode` without a round trip through a second wasm's key space. Under the old split, a
    // gid from harfbuzzjs had to be trusted to mean the same outline in hb-gpu's face.
    const run = font.shape(`${BEACON}${HAN}`);
    expect(run).not.toBeNull();
    for (const glyph of run as Run) {
      const encoded = font.encode(glyph.glyphId);
      expect(encoded, `glyph ${glyph.glyphId} would not encode`).not.toBeNull();
      expect(
        (encoded as NonNullable<typeof encoded>).texels.length,
      ).toBeGreaterThan(0);
    }
  });

  it("reports which reference build it was graded against", ({ skip }) => {
    if (skipReason) skip(skipReason);
    // Not an assertion about a number — an assertion that the number was recorded. A future
    // disagreement is either a bug here or a change over there, and this says which builds agreed.
    expect(referenceVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("does not leak the shaping buffer across runs", ({ skip }) => {
    if (skipReason) skip(skipReason);
    const entry =
      fonts.get("Roboto (Latin)") ?? fonts.get("Noto Sans SC (Han)");
    if (!entry) skip("no fixture font is present");
    const { font } = entry as NonNullable<typeof entry>;
    // ONE buffer, cleared between runs — so a thousand runs must not move the heap. This is the
    // reading `-sINITIAL_MEMORY` was re-tuned against; see `build.sh`.
    const before = (hbGpu as HbGpu).heapBytes;
    for (let i = 0; i < 1000; i += 1) {
      expect(font.shape("Waffle office AV To.")).not.toBeNull();
    }
    expect((hbGpu as HbGpu).heapBytes).toBe(before);
  });
});
