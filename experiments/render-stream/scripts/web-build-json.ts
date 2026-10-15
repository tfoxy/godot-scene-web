#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Writes <bundle>/build.json for build-web-receiver.sh (gate7-design.md Q4 "Bundle provenance",
// G7e): the editor's and the template's paths and sha256, the committed preset's sha256 and the
// options the export used, the source digest, every bundle file's size and sha256, and the .pck's
// file list (lib/godot-pck.ts), which no-source-scene checks.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listPck } from "./lib/godot-pck";

export const WEB_BUILD_SCHEMA = "render-stream-web-build/1";

function arg(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (value === undefined)
    throw new Error(`web-build-json: ${name} is required`);
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The `[preset.0.options]` keys of an export_presets.cfg, as raw strings. */
function presetOptions(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inOptions = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inOptions = trimmed === "[preset.0.options]";
      continue;
    }
    if (!inOptions || trimmed === "" || trimmed.startsWith(";")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function main(): void {
  const argv = process.argv.slice(2);
  const bundle = arg(argv, "--bundle");
  const project = arg(argv, "--project");
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const name of readdirSync(bundle).sort()) {
    if (name === "build.json") continue;
    const path = join(bundle, name);
    if (!statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  const pckBytes = readFileSync(join(bundle, "receiver.pck"));
  const pck = listPck(pckBytes);
  const committedPreset = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "receiver",
      "export_presets.cfg",
    ),
  );
  const stagedPreset = readFileSync(
    join(project, "export_presets.cfg"),
    "utf8",
  );
  const totalBytes = Object.values(files).reduce((sum, f) => sum + f.bytes, 0);
  const doc = {
    schema: WEB_BUILD_SCHEMA,
    generated_at: new Date().toISOString(),
    source_sha256: arg(argv, "--source-sha256"),
    git: {
      commit: arg(argv, "--git-commit"),
      receiver_dirty_files: Number(arg(argv, "--git-dirty-files")),
    },
    editor: {
      path: arg(argv, "--editor"),
      sha256: arg(argv, "--editor-sha256"),
    },
    template: {
      path: arg(argv, "--template"),
      sha256: arg(argv, "--template-sha256"),
    },
    preset: {
      committed_sha256: sha256(committedPreset),
      options: presetOptions(stagedPreset),
    },
    build_ms: Number(arg(argv, "--build-ms")),
    total_bytes: totalBytes,
    files,
    pck: {
      sha256: sha256(pckBytes),
      format_version: pck.formatVersion,
      engine: pck.engine,
      files: pck.files.map((f) => ({ path: f.path, size: f.size, md5: f.md5 })),
    },
  };
  writeFileSync(
    join(bundle, "build.json"),
    `${JSON.stringify(doc, null, 2)}\n`,
  );
  console.log(
    `web-build-json: ${Object.keys(files).length} bundle files, ${totalBytes} bytes; pck ${pck.files.length} entries (format ${pck.formatVersion}, engine ${pck.engine})`,
  );
}

main();
