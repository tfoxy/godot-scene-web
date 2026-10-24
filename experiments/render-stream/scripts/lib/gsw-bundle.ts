// The GSW canvas receiver's bundle (gate7-design.md Q5, Q8 `no-source-scene`, G7a):
// web/gsw-receiver/main.ts bundled by esbuild (platform browser, conditions ["development"], as
// packages/perf-harness/src/serve.ts bundles), its page, and the rs-gsw-wasm build
// (scripts/build-rs-core.sh) in one directory the harness serves at `/gsw-bundle/`. build.json
// records every file's sha256, the bundle's own sha256 (RS_RECEIVER_BUILD_SHA256) and the esbuild
// metafile's input list, which `no-source-scene@gsw` reads.

import { execFileSync } from "node:child_process";
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
  /** G8kb: scripts/build-basis-transcoder.sh's build.json (the KTX2 transcoder wasm). */
  basis_transcoder: Record<string, unknown> | null;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** G8kb: scripts/build-basis-transcoder.sh (reused when its source digest is unchanged); the
 * directory holding basis_transcoder.wasm and build.json. */
export function buildBasisTranscoder(): string {
  const log = execFileSync(
    "bash",
    [join(HERE, "..", "build-basis-transcoder.sh")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const dir = log.trim().split("\n").pop()?.trim() ?? "";
  if (!dir || !existsSync(join(dir, "basis_transcoder.wasm")))
    throw new Error(`build-basis-transcoder.sh printed no build directory:\n${log}`);
  return dir;
}

/** Builds the bundle into `out` (created) from the rs-core build at `rsBuild` and (G8kb) the KTX2
 * transcoder build at `transcoderDir` (default: build-basis-transcoder.sh's, built if needed). */
export async function buildGswBundle(
  out: string,
  rsBuild: string = DEFAULT_RS_BUILD,
  transcoderDir: string = buildBasisTranscoder(),
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
  // G8kb: the KTX2 transcoder's Web Worker (web/basis-transcoder/worker.ts) beside receiver.js,
  // and its wasm under basis/ (transcode.ts resolves both against the page).
  const worker = await build({
    entryPoints: [join(GSW_RECEIVER_DIR, "..", "basis-transcoder", "worker.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"],
    outfile: join(out, "basis-worker.js"),
    metafile: true,
    logLevel: "warning",
  });
  await mkdir(join(out, "basis"), { recursive: true });
  copyFileSync(
    join(transcoderDir, "basis_transcoder.wasm"),
    join(out, "basis", "basis_transcoder.wasm"),
  );
  const inputs = [
    ...new Set([
      ...Object.keys(result.metafile?.inputs ?? {}),
      ...Object.keys(worker.metafile?.inputs ?? {}),
    ]),
  ].sort();
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
    "basis-worker.js",
    "basis/basis_transcoder.wasm",
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
    basis_transcoder: JSON.parse(
      readFileSync(join(transcoderDir, "build.json"), "utf8"),
    ) as Record<string, unknown>,
  };
  await writeFile(join(out, "build.json"), `${JSON.stringify(doc, null, 2)}\n`);
  return { dir: out, sha256: bundleSha, build: doc };
}
