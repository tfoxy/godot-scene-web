// The GSW canvas receiver's bundle (gate7-design.md Q5, Q8 `no-source-scene`, G7a):
// web/gsw-receiver/main.ts bundled by esbuild (platform browser, conditions ["development"], as
// packages/perf-harness/src/serve.ts bundles), its page, and the rs-gsw-wasm build
// (scripts/build-rs-core.sh) in one directory the harness serves at `/gsw-bundle/`. build.json
// records every file's sha256, the bundle's own sha256 (RS_RECEIVER_BUILD_SHA256) and the esbuild
// metafile's input list, which `no-source-scene@gsw` reads.

import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
export const GSW_RECEIVER_DIR = resolve(
  HERE,
  "..",
  "..",
  "web",
  "gsw-receiver",
);
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
/** build-rs-core.sh's `latest` link. */
export const DEFAULT_RS_BUILD = join(
  REPO_ROOT,
  "artifacts",
  "render-stream",
  "rs-core",
  "latest",
);

export interface GswBundle {
  dir: string;
  sha256: string;
  build: GswBuildJson;
}

export interface GswBuildJson {
  schema: "render-stream-gsw-bundle/1";
  sha256: string;
  files: Record<string, string>;
  /** esbuild's metafile inputs (repo-relative paths): what the bundle was built from. */
  inputs: string[];
  rs_core_build: string | null;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Builds the bundle into `out` (created) from the rs-core build at `rsBuild`. */
export async function buildGswBundle(
  out: string,
  rsBuild: string = DEFAULT_RS_BUILD,
): Promise<GswBundle> {
  const wasmDir = join(rsBuild, "gsw-rs");
  if (!existsSync(join(wasmDir, "rs_gsw_wasm_bg.wasm")))
    throw new Error(
      `no rs-gsw-wasm build at ${wasmDir} (run experiments/render-stream/scripts/build-rs-core.sh)`,
    );
  await mkdir(out, { recursive: true });
  copyFileSync(
    join(GSW_RECEIVER_DIR, "receiver.html"),
    join(out, "receiver.html"),
  );
  const result = await build({
    entryPoints: [join(GSW_RECEIVER_DIR, "main.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"],
    outfile: join(out, "receiver.js"),
    metafile: true,
    logLevel: "warning",
  });
  const inputs = Object.keys(result.metafile?.inputs ?? {}).sort();
  const nodeImports = inputs.filter((p) => p.startsWith("node:"));
  if (nodeImports.length > 0)
    throw new Error(
      `gsw bundle pulls node: modules: ${nodeImports.join(", ")}`,
    );
  cpSync(wasmDir, join(out, "gsw-rs"), { recursive: true });
  const files: Record<string, string> = {};
  for (const f of [
    "receiver.html",
    "receiver.js",
    "gsw-rs/rs_gsw_wasm.js",
    "gsw-rs/rs_gsw_wasm_bg.wasm",
  ])
    files[f] = sha256(readFileSync(join(out, f)));
  const bundleSha = sha256(
    Object.entries(files)
      .map(([k, v]) => `${k} ${v}`)
      .join("\n"),
  );
  const buildTxt = join(rsBuild, "build.txt");
  const doc: GswBuildJson = {
    schema: "render-stream-gsw-bundle/1",
    sha256: bundleSha,
    files,
    inputs,
    rs_core_build: existsSync(buildTxt) ? readFileSync(buildTxt, "utf8") : null,
  };
  await writeFile(join(out, "build.json"), `${JSON.stringify(doc, null, 2)}\n`);
  return { dir: out, sha256: bundleSha, build: doc };
}
