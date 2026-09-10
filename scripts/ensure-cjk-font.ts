// The CJK fixture font: one file, five consumers.
//
// The text benchmark measures the SAME glyphs through Godot, a CSS `@font-face`, canvas2d's
// `fillText`, harfbuzzjs's wasm heap and (later) hb-gpu's wasm heap. Those five only produce
// comparable pixels if they are handed byte-identical font data, so the fixture is one file and
// every arm loads it.
//
// WHY IT IS SUBSET RATHER THAN SHIPPED WHOLE. Upstream `NotoSansSC[wght].ttf` is 17.7 MB. Two wasm
// heaps carry their own copy, Godot re-imports it on every fixture change, and the parity flow
// inlines fixture fonts as base64 `data:` URLs (`packages/test-harness/src/parity.ts`), which would
// make a 23.7 MB string. Subsetting to the charset the benchmark actually draws — and pinning the
// variable `wght` axis to its default, 400 — turns that into ~1-2 MB with the same glyph outlines.
//
// The subset is a PURE FUNCTION OF ITS CHARSET, so it regenerates byte-identically. That is the
// same rule the atlas fixture follows, and it is what lets two runs on different days be compared.
//
// It degrades rather than fails: if `harfbuzzjs` is missing or `hb_subset_or_fail` refuses, the
// full TTF is used and `subset: false` is reported, loudly, rather than a silent fallback that
// would quietly change what every arm was measured against.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const FONT_DIR = "fixtures/assets/fonts/noto-sans-sc";
const BASE_URL =
  "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/";
const SOURCE_FILE = "NotoSansSC[wght].ttf";
const SUBSET_FILE = "NotoSansSC-bench.ttf";

/**
 * The first Han codepoint of the pool, and how many of them the fixture carries.
 *
 * Contiguous from U+4E00 (CJK Unified Ideographs) rather than a frequency-ordered list, for one
 * reason: it is a pure function of a single number, so the charset — and therefore the subset's
 * bytes — can be reproduced from this file alone. What the benchmark needs from the pool is Han
 * STROKE COMPLEXITY and glyph COUNT, both of which a contiguous slice supplies; it does not need
 * the characters to spell anything, and the scenario says so where it builds its strings.
 *
 * 3000 is the ceiling the scenario's `glyphs` param may ask for. Sizing the fixture for the
 * ceiling means changing `glyphs` never regenerates the font, so two runs at different glyph
 * counts still share one file.
 */
export const HAN_POOL_START = 0x4e00;
export const HAN_POOL_SIZE = 3000;

/** ASCII printable, so the mixed-script case has Latin to shape alongside the Han. */
const ASCII_START = 0x20;
const ASCII_END = 0x7e;

/**
 * U+25A0 BLACK SQUARE — the presence guard's beacon, and the reason it is a GLYPH.
 *
 * The perf harness discards any repeat whose sample points are not on visible content, and the #1
 * failure it exists to catch is measuring a blank page. Antialiased 12 px Han stems are far too
 * thin to sample reliably, so a text scenario needs something solid to aim at — but a solid rect
 * drawn BESIDE the text would prove only that the arm composited, not that a single glyph was ever
 * rasterized, which is precisely the lie the guard exists to refuse.
 *
 * A filled square that goes through the same cmap, shaping, rasterisation and blit as every other
 * character cannot pass while the glyph path is broken. It is the text equivalent of the opaque
 * core `static-surfaces` draws at the centre of every sprite.
 */
export const BEACON_CODEPOINT = 0x25a0;

/** Every codepoint the fixture font is required to carry, ascending. */
export function benchCharset(): number[] {
  const codepoints: number[] = [];
  for (let cp = ASCII_START; cp <= ASCII_END; cp += 1) {
    codepoints.push(cp);
  }
  codepoints.push(BEACON_CODEPOINT);
  for (let i = 0; i < HAN_POOL_SIZE; i += 1) {
    codepoints.push(HAN_POOL_START + i);
  }
  return codepoints;
}

/** The `index`-th Han character of the pool, wrapping. Deterministic, and shared by every arm. */
export function hanAt(index: number): string {
  const offset = ((index % HAN_POOL_SIZE) + HAN_POOL_SIZE) % HAN_POOL_SIZE;
  return String.fromCodePoint(HAN_POOL_START + offset);
}

export interface CjkFontFixture {
  /** Absolute path to the font every arm must load. */
  path: string;
  /** Repo-relative path, for `res://` wiring and log lines. */
  relativePath: string;
  bytes: number;
  /** False means the full 17.7 MB upstream file is in use — see the header. */
  subset: boolean;
  /** Why the subset was skipped, when it was. */
  subsetSkippedReason?: string;
}

/**
 * Ensure the benchmark's CJK font exists on disk, downloading and subsetting it if needed.
 *
 * Like `ensureRobotoFonts`, the binaries are deliberately not committed: a clean checkout stays
 * runnable, and the directory stays out of git.
 */
export async function ensureCjkFont(repoRoot: string): Promise<CjkFontFixture> {
  const fontDir = join(repoRoot, FONT_DIR);
  await mkdir(fontDir, { recursive: true });

  const subsetPath = join(fontDir, SUBSET_FILE);
  if (await isNonEmptyFile(subsetPath)) {
    return {
      path: subsetPath,
      relativePath: `${FONT_DIR}/${SUBSET_FILE}`,
      bytes: (await stat(subsetPath)).size,
      subset: true,
    };
  }

  const sourcePath = join(fontDir, SOURCE_FILE);
  await ensureSourceFont(sourcePath);
  const source = await readFile(sourcePath);

  let subsetBytes: Uint8Array | null = null;
  let skipped: string | undefined;
  try {
    subsetBytes = await subsetFont(source, benchCharset());
  } catch (cause) {
    skipped = cause instanceof Error ? cause.message : String(cause);
  }

  if (!subsetBytes) {
    return {
      path: sourcePath,
      relativePath: `${FONT_DIR}/${SOURCE_FILE}`,
      bytes: source.byteLength,
      subset: false,
      subsetSkippedReason: skipped ?? "hb_subset_or_fail returned no data",
    };
  }

  await writeAtomic(subsetPath, Buffer.from(subsetBytes));
  return {
    path: subsetPath,
    relativePath: `${FONT_DIR}/${SUBSET_FILE}`,
    bytes: subsetBytes.byteLength,
    subset: true,
  };
}

async function ensureSourceFont(filePath: string): Promise<void> {
  if (await isNonEmptyFile(filePath)) {
    return;
  }
  const url = `${BASE_URL}${encodeURIComponent(SOURCE_FILE)}`;
  let bytes: Buffer;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (cause) {
    throw new Error(downloadFailureMessage(url, cause));
  }
  if (bytes.length === 0) {
    throw new Error(
      downloadFailureMessage(url, new Error("empty response body")),
    );
  }
  await writeAtomic(filePath, bytes);
}

/**
 * The subset itself, driven straight against `harfbuzz-subset.wasm`.
 *
 * That wasm is built `--no-entry` with no JS glue and no imports (harfbuzzjs's Makefile emits the
 * `.wasm` as its own target), so it is instantiated directly rather than through the package's TS
 * API — which wraps shaping only and exposes no subsetting at all.
 *
 * It is also built with a fixed 65 MB heap and NO `ALLOW_MEMORY_GROWTH`. A 17.7 MB source plus the
 * subsetter's working set fits, but not by a wide margin, so an allocation failure here is an
 * expected outcome and is reported as a skip rather than thrown past the caller.
 */
export async function subsetFont(
  source: Uint8Array,
  codepoints: readonly number[],
): Promise<Uint8Array | null> {
  const require = createRequire(import.meta.url);
  // The package's `exports` map only publishes ".", so the sibling wasm cannot be resolved as a
  // subpath. Resolve the entry point and walk to it inside the same `dist/`.
  const wasmPath = join(
    dirname(require.resolve("harfbuzzjs")),
    "harfbuzz-subset.wasm",
  );
  const { instance } = await WebAssembly.instantiate(await readFile(wasmPath));
  const hb = instance.exports as unknown as HbSubsetExports;

  const fontPtr = hb.malloc(source.byteLength);
  if (!fontPtr) {
    return null;
  }
  new Uint8Array(hb.memory.buffer).set(source, fontPtr);

  const blob = hb.hb_blob_create(fontPtr, source.byteLength, 2, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);

  const input = hb.hb_subset_input_create_or_fail();
  if (!input) {
    hb.hb_face_destroy(face);
    hb.free(fontPtr);
    return null;
  }
  const unicodes = hb.hb_subset_input_unicode_set(input);
  for (const codepoint of codepoints) {
    hb.hb_set_add(unicodes, codepoint);
  }
  // Instance the variable font at its default axis values (`wght` 400). Every arm then renders one
  // fixed weight; leaving the axis live would let CSS, Godot and harfbuzz each pick their own.
  hb.hb_subset_input_pin_all_axes_to_default(input, face);

  const subsetFace = hb.hb_subset_or_fail(face, input);
  hb.hb_subset_input_destroy(input);
  if (!subsetFace) {
    hb.hb_face_destroy(face);
    hb.free(fontPtr);
    return null;
  }

  const resultBlob = hb.hb_face_reference_blob(subsetFace);
  const offset = hb.hb_blob_get_data(resultBlob, 0);
  const length = hb.hb_blob_get_length(resultBlob);
  // Copied out of the heap before anything is destroyed: the subarray is a view, not the bytes.
  const out =
    length > 0
      ? new Uint8Array(
          new Uint8Array(hb.memory.buffer).subarray(offset, offset + length),
        )
      : null;

  hb.hb_blob_destroy(resultBlob);
  hb.hb_face_destroy(subsetFace);
  hb.hb_face_destroy(face);
  hb.free(fontPtr);
  return out;
}

interface HbSubsetExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  hb_blob_create(
    data: number,
    length: number,
    mode: number,
    userData: number,
    destroy: number,
  ): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, lengthOut: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_input_pin_all_axes_to_default(input: number, face: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

async function writeAtomic(filePath: string, bytes: Buffer): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, filePath);
}

async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

function downloadFailureMessage(url: string, cause: unknown): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return [
    `Failed to download fixture font "${SOURCE_FILE}" from ${url} (${reason}).`,
    `Download it manually into "${FONT_DIR}/" and retry:`,
    `  ${url} -> ${FONT_DIR}/${SOURCE_FILE}`,
  ].join("\n");
}
