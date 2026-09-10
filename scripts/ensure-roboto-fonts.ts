import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FONT_DIR = "fixtures/assets/fonts/roboto";
const BASE_URL =
  "https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/";
const REQUIRED_FILES = [
  "Roboto[wdth,wght].ttf",
  "Roboto-Italic[wdth,wght].ttf",
];

/**
 * Ensure the Roboto TTF binaries used by font/parity fixtures exist on disk,
 * downloading any that are missing from the upstream google/fonts repo.
 *
 * The files are intentionally not committed to git; this keeps a clean
 * checkout runnable while staying offline-safe once the fonts are present.
 */
export async function ensureRobotoFonts(repoRoot: string): Promise<void> {
  const fontDir = join(repoRoot, FONT_DIR);
  await mkdir(fontDir, { recursive: true });
  await Promise.all(
    REQUIRED_FILES.map((name) => ensureFontFile(fontDir, name)),
  );
}

async function ensureFontFile(fontDir: string, name: string): Promise<void> {
  const filePath = join(fontDir, name);
  if (await isNonEmptyFile(filePath)) {
    return;
  }
  const url = `${BASE_URL}${encodeURIComponent(name)}`;
  let bytes: Buffer;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (cause) {
    throw new Error(downloadFailureMessage(name, url, cause));
  }
  if (bytes.length === 0) {
    throw new Error(
      downloadFailureMessage(name, url, new Error("empty response body")),
    );
  }
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

function downloadFailureMessage(
  name: string,
  url: string,
  cause: unknown,
): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return [
    `Failed to download fixture font "${name}" from ${url} (${reason}).`,
    `Download the Roboto TTFs manually into "${FONT_DIR}/" and retry:`,
    ...REQUIRED_FILES.map(
      (file) =>
        `  ${BASE_URL}${encodeURIComponent(file)} -> ${FONT_DIR}/${file}`,
    ),
  ].join("\n");
}
