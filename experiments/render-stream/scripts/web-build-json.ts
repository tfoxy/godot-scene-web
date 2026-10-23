#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Writes <bundle>/build.json for build-web-receiver.sh (gate7-design.md Q4 "Bundle provenance",
// G7e): the editor's and the template's paths and sha256, the committed preset's sha256 and the
// options the export used, the source digest, every bundle file's size and sha256, and the .pck's
// file list (lib/godot-pck.ts), which no-source-scene checks.
//
// G7xw: records the `Web (rust core)` preset's options, the core (`rust`, the only one since
// G7gd, which also made that preset index 0) and the side module's own build record
// (rs-core-web-build.json in the bundle: the nightly, emcc and every artifact's sha256) as
// `rs_core_web`.

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listPck, pckContentDigest, pckEntryBytes } from "./lib/godot-pck";

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

/** The `[preset.<index>.options]` keys of an export_presets.cfg, as raw strings. */
function presetOptions(text: string, index: number): Record<string, string> {
  const out: Record<string, string> = {};
  let inOptions = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inOptions = trimmed === `[preset.${index}.options]`;
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
  const coreAt = argv.indexOf("--core");
  const core = coreAt >= 0 ? argv[coreAt + 1] : "rust";
  if (core !== "rust")
    throw new Error(`web-build-json: --core is rust, not ${core} (G7gd)`);
  const presetAt = argv.indexOf("--preset-index");
  const presetIndex = presetAt >= 0 ? Number(argv[presetAt + 1]) : 0;
  const sideBuild = join(bundle, "rs-core-web-build.json");
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const name of readdirSync(bundle).sort()) {
    if (name === "build.json" || name === "rs-core-web-build.json") continue;
    const path = join(bundle, name);
    if (!statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  const pckBytes = readFileSync(join(bundle, "receiver.pck"));
  const pck = listPck(pckBytes);
  // R3: each entry's md5 checked against its bytes, so the content digest (godot-pck.ts
  // pckContentDigest: sorted path/size/md5) stands for the entries' contents.
  const pckFiles = pck.files.map((f) => {
    const data = pckEntryBytes(pckBytes, pck, f);
    const md5 = createHash("md5").update(data).digest("hex");
    if (md5 !== f.md5)
      throw new Error(
        `web-build-json: pck entry ${f.path} has md5 ${md5}, its directory says ${f.md5}`,
      );
    return { path: f.path, size: f.size, md5: f.md5, sha256: sha256(data) };
  });
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
      index: presetIndex,
      options: presetOptions(stagedPreset, presetIndex),
    },
    core,
    rs_core_web:
      core === "rust" && existsSync(sideBuild)
        ? JSON.parse(readFileSync(sideBuild, "utf8"))
        : null,
    build_ms: Number(arg(argv, "--build-ms")),
    total_bytes: totalBytes,
    files,
    pck: {
      // build identity: varies across machines with no content change (pckContentDigest's comment)
      sha256: sha256(pckBytes),
      // what two builds must agree on: the sorted entry list (lib/remote-determinism.ts compares it)
      content_sha256: pckContentDigest(pckFiles),
      format_version: pck.formatVersion,
      engine: pck.engine,
      files: pckFiles,
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
