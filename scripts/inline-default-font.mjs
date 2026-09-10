#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fontPath = join(
  repoRoot,
  "packages/html/vendor/OpenSans_SemiBold.woff2",
);
const outputPath = join(repoRoot, "packages/html/src/default-font-data.ts");
const font = await readFile(fontPath);
const source = `/*\n * Generated from ../vendor/OpenSans_SemiBold.woff2 by scripts/inline-default-font.mjs.\n * Keep this data URL byte-identical with the vendored binary; the vendor test asserts it.\n */\nexport const GODOT_DEFAULT_FONT_DATA_URL = "data:font/woff2;base64,${font.toString("base64")}";\n`;
await writeFile(outputPath, source, "utf8");
