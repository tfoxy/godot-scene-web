// The Latin fixture font: the same five consumers, a different script.
//
// WHY A SECOND FACE AT ALL. Everything the text round has measured so far is Han — full-width,
// unkerned, unligatured, ~3000 distinct outlines. Latin is the other half of what the app renders
// and it is a different problem in every axis that matters here: proportional advances, real
// kerning, and an alphabet of ~95 glyphs instead of thousands. It is also the case where HarfBuzz
// shaping might finally earn its 420 KB — for Han, `bakeShaper=fillText` matched a shaped run
// exactly, because there is nothing to shape.
//
// SAME CONTRACT AS `ensure-cjk-font.ts`, deliberately: one file, every arm loads it, subset to a
// charset that is a pure function of this module so the bytes regenerate identically. The subsetter
// itself is that module's `subsetFont` rather than a second copy.
//
// PINNING THE AXES IS THE POINT. Upstream Roboto is variable (`wdth`, `wght`); left live, CSS,
// Godot and HarfBuzz would each be free to pick their own instance and the three arms would compare
// three different fonts. `hb_subset_input_pin_all_axes_to_default` instances it at 400/100 once.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BEACON_CODEPOINT, subsetFont } from "./ensure-cjk-font";
import { ensureRobotoFonts } from "./ensure-roboto-fonts";

const FONT_DIR = "fixtures/assets/fonts/roboto";
const SOURCE_FILE = "Roboto[wdth,wght].ttf";
const SUBSET_FILE = "Roboto-bench.ttf";

/** ASCII printable — the whole of what the Latin run draws, plus room for any future fixture. */
const ASCII_START = 0x20;
const ASCII_END = 0x7e;

/**
 * Every codepoint the Latin fixture is required to carry, ascending.
 *
 * U+25A0 is here for the same reason it is in the CJK charset: it is S9's presence beacon, and the
 * guard is only worth anything if the beacon reaches the screen through the same cmap, shaping and
 * rasterisation as the text beside it. Roboto has it (gid 1323), so the Latin run can lead with the
 * identical beacon the Han run does and the two runs' sample points mean the same thing.
 */
export function latinBenchCharset(): number[] {
  const codepoints: number[] = [];
  for (let cp = ASCII_START; cp <= ASCII_END; cp += 1) {
    codepoints.push(cp);
  }
  codepoints.push(BEACON_CODEPOINT);
  return codepoints;
}

export interface LatinFontFixture {
  /** Absolute path to the font every arm must load. */
  path: string;
  /** Repo-relative path, for `res://` wiring and log lines. */
  relativePath: string;
  bytes: number;
  /** False means the full upstream variable TTF is in use — see the header. */
  subset: boolean;
  /** Why the subset was skipped, when it was. */
  subsetSkippedReason?: string;
}

/**
 * Ensure the benchmark's Latin font exists on disk, downloading and subsetting it if needed.
 *
 * The download is `ensureRobotoFonts`, which the parity fixtures already use — so on a checkout
 * that has ever run the font fixtures, this costs one subset pass and no network. Like every other
 * font here the binaries stay out of git; the directory is already ignored.
 */
export async function ensureLatinBenchFont(
  repoRoot: string,
): Promise<LatinFontFixture> {
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

  await ensureRobotoFonts(repoRoot);
  const sourcePath = join(fontDir, SOURCE_FILE);
  const source = await readFile(sourcePath);

  let subsetBytes: Uint8Array | null = null;
  let skipped: string | undefined;
  try {
    subsetBytes = await subsetFont(source, latinBenchCharset());
  } catch (cause) {
    skipped = cause instanceof Error ? cause.message : String(cause);
  }

  if (!subsetBytes) {
    // Reported loudly rather than swallowed: the full file is VARIABLE, so every arm would be free
    // to instance it differently and the Latin comparison would quietly stop being one comparison.
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
