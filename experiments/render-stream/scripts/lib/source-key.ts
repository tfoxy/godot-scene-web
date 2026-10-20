// The content key of a gate 7 source run (D21 amended by GRT, results/grt.md): a digest of every
// INPUT that shapes a native gate run's recordings, references and verdict, and nothing else. Two
// source runs with the same key are interchangeable whatever commit made them, so a source made
// by one increment (or by the native, gsw or web half of one validation) serves the next; any real
// input change gives another key, and source-run-valid refuses the old source.
//
// The key covers:
//   - template_sha256     the pinned Linux export template the fixtures run on;
//   - extension_sha256    the capture library the .gdextension names (the built .so's bytes);
//   - calibration_sha256  the calibration file the runners pass to every capture;
//   - receiver_core       RS_RECEIVER_CORE as the native receiver legs will see it (default rust);
//   - files_digest        every git-visible file (tracked, or untracked and not ignored: the
//                         working tree as it is, committed or not) under SOURCE_ROOTS, minus
//                         SOURCE_EXCLUDES -- by path and content.
// SOURCE_ROOTS is conservative: the native receiver and the Rust core it runs (rs-core,
// rs-core-capi), the capture library's source, every fixture, and all of scripts/ -- the runners,
// lib/legs.sh, the expected-value derivations and the gate checkers that write the source's
// result.json -- except files that only gate 7's browsers, the lock or the docs read
// (SOURCE_EXCLUDES). A new file under a root is IN the key until someone excludes it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SOURCE_KEY_SCHEMA = "render-stream-source-key/1";

/** Repository-relative roots whose git-visible files are in the key. */
export const SOURCE_ROOTS = [
  "experiments/render-stream/receiver",
  "experiments/render-stream/capture",
  "experiments/render-stream/fixtures",
  "experiments/render-stream/rs-core",
  "experiments/render-stream/rs-core-capi",
  "experiments/render-stream/scripts",
];

/** Files under SOURCE_ROOTS that cannot change a native gate 0-6 run: gate 7's own runner,
 * checker, browser and device harnesses, the GSW bundle, the quiet lock (scheduling only), the
 * smoke tier, this cache, tests and docs. Anchored at experiments/render-stream/scripts/. */
export const SOURCE_EXCLUDES: RegExp[] = [
  /^experiments\/render-stream\/scripts\/(README\.md|run-gate7\.sh|check-gate7\.ts|validate-increment\.sh|smoke-map\.json|source-cache\.sh)$/,
  /^experiments\/render-stream\/scripts\/(gate7-|gate7x-|run-g7x-|build-web-receiver|build-rs-core-web|web-build-json|profile-|sample-|analyze-deltas|compare-receiver-cores|replay-receiver-legs)/,
  /^experiments\/render-stream\/scripts\/lib\/(gate7|browser-|device-|gsw-|quiet|source-key|wasm-side-module-info)/,
  /^experiments\/render-stream\/scripts\/test\//,
  /\.md$/,
];

export interface SourceKeyInputs {
  schema: string;
  key: string;
  template_sha256: string | null;
  extension_sha256: string | null;
  calibration_sha256: string | null;
  receiver_core: string;
  files_digest: string;
  files: number;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function fileSha(path: string | undefined): string | null {
  return path && existsSync(path) ? sha256(readFileSync(path)) : null;
}

/** The capture library's sha256: the `linux.x86_64` library a .gdextension names. */
export function extensionLibrarySha(extension: string): string | null {
  if (!existsSync(extension)) return null;
  const m = /^linux\.x86_64\s*=\s*"([^"]+)"/m.exec(
    readFileSync(extension, "utf8"),
  );
  return m && existsSync(m[1]) ? fileSha(m[1]) : null;
}

/** Repository-relative paths of the key's files, sorted. */
export function sourceKeyFiles(repoRoot: string): string[] {
  const r = spawnSync(
    "git",
    [
      "-C",
      repoRoot,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...SOURCE_ROOTS,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`git ls-files: ${r.stderr}`);
  return [...new Set(r.stdout.split("\0").filter(Boolean))]
    .filter((p) => !SOURCE_EXCLUDES.some((re) => re.test(p)))
    .filter((p) => existsSync(join(repoRoot, p)))
    .sort();
}

export function sourceKey(
  repoRoot: string,
  opts: {
    extension: string;
    template: string;
    calibration?: string;
    receiverCore?: string;
  },
): SourceKeyInputs {
  const files = sourceKeyFiles(repoRoot);
  const h = createHash("sha256");
  for (const p of files) {
    h.update(p);
    h.update("\0");
    h.update(sha256(readFileSync(join(repoRoot, p))));
    h.update("\n");
  }
  const parts = {
    template_sha256: fileSha(opts.template),
    extension_sha256: extensionLibrarySha(opts.extension),
    calibration_sha256: fileSha(opts.calibration),
    receiver_core: opts.receiverCore ?? process.env.RS_RECEIVER_CORE ?? "rust",
    files_digest: h.digest("hex"),
  };
  const key = sha256(
    JSON.stringify({ schema: SOURCE_KEY_SCHEMA, ...parts }),
  ).slice(0, 32);
  return { schema: SOURCE_KEY_SCHEMA, key, ...parts, files: files.length };
}
