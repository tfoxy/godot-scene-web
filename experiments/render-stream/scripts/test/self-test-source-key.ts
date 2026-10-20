#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for GRT's input-keyed source validity and source cache (results/grt.md; D21 as
// amended). Pure: a scratch git repository with the source roots' layout, a fake capture library,
// template and calibration -- never a Godot run.
//
//  1. source-run-valid (sourceProvenanceProblems, the comparison all three source-run-valid
//     checks use) accepts a source made at another commit from the same inputs, and an edit to a
//     file outside the key (a gate 7 runner); and refuses, each naming the input: a changed
//     fixture, a new untracked fixture file, a changed runner, a changed capture library
//     (extension), template, calibration, and another receiver core. An ignored file does not count.
//  2. A schema /1 source (no key) keeps the old rule: another commit is refused.
//  3. source-cache.sh publishes a passing run by copying it, relocating its own absolute path in
//     its text files (env.txt), leaving the maker's run untouched; a lookup hits by exact legs
//     and by the gate's `all` entry; a failing run and a run with another key are refused; a
//     second publish of the same entry is a no-op.
//
//   pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-source-key.ts

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  currentBuildProvenance,
  type SourceProvenance,
  sourceProvenanceProblems,
} from "../lib/gate7-adapters";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` -- ${detail}` : ""}`,
  );
}

const root = mkdtempSync(join(tmpdir(), "self-test-source-key-"));
const rs = join(root, "experiments/render-stream");
const put = (rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const git = (...args: string[]): string => {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

put("experiments/render-stream/fixtures/gate0/main.tscn", "[gd_scene]\n");
put("experiments/render-stream/fixtures/.gitignore", ".godot/\n");
put("experiments/render-stream/receiver/receiver.gd", "extends Node\n");
put("experiments/render-stream/capture/src/hooks.cpp", "int x;\n");
put("experiments/render-stream/rs-core/src/lib.rs", "pub fn f() {}\n");
put("experiments/render-stream/scripts/run-gate0.sh", "echo gate0\n");
put("experiments/render-stream/scripts/run-gate7.sh", "echo gate7\n");
put("experiments/render-stream/scripts/lib/gate7-live.ts", "export {};\n");
put("experiments/render-stream/calibration/cal.json", "{}\n");
put("ext/librender_stream_capture.so", "ELF-1");
put(
  "ext/capture.gdextension",
  `[libraries]\nlinux.x86_64 = "${join(root, "ext/librender_stream_capture.so")}"\n`,
);
put("tpl/linux_release.x86_64", "TEMPLATE-1");
git("init", "-q");
git("add", "-A");
git("commit", "-q", "-m", "one");

const EXT = join(root, "ext/capture.gdextension");
const TPL = join(root, "tpl/linux_release.x86_64");
const CAL = join(rs, "calibration/cal.json");
const prov = (): SourceProvenance =>
  currentBuildProvenance(root, EXT, TPL, CAL);
const made = prov();

function expectValid(name: string): void {
  const p = sourceProvenanceProblems(made, prov());
  check(name, p.length === 0, p.join("; "));
}
function expectRefused(name: string, mention: string, undo: () => void): void {
  const p = sourceProvenanceProblems(made, prov());
  check(
    `${name} (${p.join("; ").slice(0, 140)})`,
    p.length > 0 && p.join("; ").includes(mention),
    `expected a problem naming ${mention}`,
  );
  undo();
  const back = sourceProvenanceProblems(made, prov());
  check(`${name}: undone, valid again`, back.length === 0, back.join("; "));
}

// --- 1. the content key ----------------------------------------------------------------------
check(
  "the source carries a schema /2 key",
  made.schema === "render-stream-gate7-source/2" &&
    /^[0-9a-f]{32}$/.test(made.source_key ?? ""),
);
git("commit", "-q", "--allow-empty", "-m", "two");
check(
  "another commit: git_commit differs",
  prov().git_commit !== made.git_commit,
);
expectValid(
  "another commit with the same inputs is still valid (reuse across commits)",
);
put("experiments/render-stream/scripts/run-gate7.sh", "echo gate7 v2\n");
put(
  "experiments/render-stream/scripts/lib/gate7-live.ts",
  "export const a = 1;\n",
);
expectValid(
  "an edit outside the key (gate 7's runner and live lib) keeps it valid",
);
put("experiments/render-stream/fixtures/.godot/cache.bin", "ignored");
expectValid("an ignored file under a root does not count");

put(
  "experiments/render-stream/fixtures/gate0/main.tscn",
  "[gd_scene changed]\n",
);
expectRefused("a changed fixture is refused", "files_digest", () =>
  put("experiments/render-stream/fixtures/gate0/main.tscn", "[gd_scene]\n"),
);
put("experiments/render-stream/fixtures/gate0/extra.tscn", "[gd_scene]\n");
expectRefused("a new untracked fixture file is refused", "files_digest", () =>
  rmSync(join(rs, "fixtures/gate0/extra.tscn")),
);
put("experiments/render-stream/scripts/run-gate0.sh", "echo gate0 v2\n");
expectRefused("a changed gate runner is refused", "files_digest", () =>
  put("experiments/render-stream/scripts/run-gate0.sh", "echo gate0\n"),
);
put("experiments/render-stream/receiver/receiver.gd", "extends Node2D\n");
expectRefused("a changed native receiver is refused", "files_digest", () =>
  put("experiments/render-stream/receiver/receiver.gd", "extends Node\n"),
);
put("ext/librender_stream_capture.so", "ELF-2");
expectRefused(
  "a changed capture library (extension) is refused",
  "extension_sha256",
  () => put("ext/librender_stream_capture.so", "ELF-1"),
);
put("tpl/linux_release.x86_64", "TEMPLATE-2");
expectRefused("a changed template is refused", "template_sha256", () =>
  put("tpl/linux_release.x86_64", "TEMPLATE-1"),
);
put("experiments/render-stream/calibration/cal.json", '{"x":1}\n');
expectRefused("a changed calibration is refused", "calibration_sha256", () =>
  put("experiments/render-stream/calibration/cal.json", "{}\n"),
);
process.env.RS_RECEIVER_CORE = "gdscript";
expectRefused(
  "another native receiver core is refused",
  "receiver_core",
  () => {
    delete process.env.RS_RECEIVER_CORE;
  },
);

// --- 2. legacy schema /1 sources --------------------------------------------------------------
{
  const legacy: SourceProvenance = {
    schema: "render-stream-gate7-source/1",
    git_commit: made.git_commit,
    git_dirty_digest: made.git_dirty_digest,
    extension_sha256: made.extension_sha256,
    template_sha256: made.template_sha256,
  };
  const p = sourceProvenanceProblems(legacy, prov());
  check(
    `a schema /1 source keeps the commit rule (${p.join("; ").slice(0, 100)})`,
    p.some((x) => x.startsWith("git_commit")),
  );
}

// --- 3. source-cache.sh ------------------------------------------------------------------------
{
  const cache = join(root, "cache");
  const env = { ...process.env, GSW_SOURCE_CACHE: cache };
  const sc = (...args: string[]) =>
    spawnSync("bash", [join(SCRIPTS, "source-cache.sh"), ...args], {
      encoding: "utf8",
      env,
    });
  const key = made.source_key ?? "";
  const run = join(root, "runs/gate1");
  const leg = join(run, "receiver");
  mkdirSync(leg, { recursive: true });
  writeFileSync(
    join(leg, "env.txt"),
    `RS_RECEIVER_RECORDING=${run}/capture/recording.rs2\n`,
  );
  writeFileSync(join(leg, "shot.png"), Buffer.from([0x89, 0x50, 0, 0, 1, 2]));
  writeFileSync(
    join(run, "result.json"),
    JSON.stringify({ gate_passed: true, checks: [] }),
  );
  writeFileSync(
    join(run, "gate7-source.json"),
    JSON.stringify({ ...made, source_dir: run }, null, 2),
  );
  const pub = sc("publish", key, "gate1", "all", run);
  const at = pub.stdout.trim();
  check(
    `publish: a passing run is published (${at.replace(root, "<tmp>")})`,
    pub.status === 0 && at.endsWith(`/${key}/gate1--all`),
    pub.stderr,
  );
  const relocated = readFileSync(join(at, "receiver/env.txt"), "utf8");
  check(
    "publish: env.txt's absolute path is relocated to the entry",
    relocated === `RS_RECEIVER_RECORDING=${at}/capture/recording.rs2\n`,
    relocated,
  );
  check(
    "publish: the maker's run is untouched",
    readFileSync(join(leg, "env.txt"), "utf8").includes(`${run}/capture`),
  );
  check(
    "publish: a binary file is copied byte for byte",
    Buffer.compare(
      readFileSync(join(at, "receiver/shot.png")),
      readFileSync(join(leg, "shot.png")),
    ) === 0,
  );
  check(
    "publish: gate7-source.json's source_dir names the entry",
    JSON.parse(readFileSync(join(at, "gate7-source.json"), "utf8"))
      .source_dir === at,
  );
  const exact = sc("lookup", key, "gate1", "all");
  const sub = sc("lookup", key, "gate1", "g1a,g1b");
  check(
    "lookup: exact legs hit",
    exact.status === 0 && exact.stdout.trim() === at,
  );
  check(
    "lookup: a legs subset hits the gate's `all` entry",
    sub.status === 0 && sub.stdout.trim() === at,
  );
  check(
    "lookup: another gate misses",
    sc("lookup", key, "gate2", "all").status === 1,
  );
  check(
    "lookup: another key misses",
    sc("lookup", "0".repeat(32), "gate1", "all").status === 1,
  );
  const again = sc("publish", key, "gate1", "all", run);
  check(
    "publish: a second publish of the entry is a no-op",
    again.status === 0 && again.stdout.trim() === at,
  );

  const bad = join(root, "runs/gate2");
  mkdirSync(bad, { recursive: true });
  writeFileSync(
    join(bad, "result.json"),
    JSON.stringify({
      gate_passed: false,
      checks: [{ id: "receiver-vs-reference", passed: false }],
    }),
  );
  writeFileSync(join(bad, "gate7-source.json"), JSON.stringify(made, null, 2));
  const refused = sc("publish", key, "gate2", "all", bad);
  check(
    `publish: a failing run is refused (${refused.stderr.trim().slice(0, 90)})`,
    refused.status === 3,
  );
  const partial = join(root, "runs/gate55");
  mkdirSync(partial, { recursive: true });
  writeFileSync(
    join(partial, "result.json"),
    JSON.stringify({
      gate_passed: false,
      checks: [
        { id: "a", passed: true },
        { id: "g55f", passed: false, status: "not-run" },
      ],
    }),
  );
  writeFileSync(
    join(partial, "gate7-source.json"),
    JSON.stringify(made, null, 2),
  );
  check(
    "publish: a partial run (only not-run failures) is published",
    sc("publish", key, "gate55", "g55b,g55c", partial).status === 0,
  );
  const other = join(root, "runs/gate3");
  mkdirSync(other, { recursive: true });
  writeFileSync(
    join(other, "result.json"),
    JSON.stringify({ gate_passed: true, checks: [] }),
  );
  writeFileSync(
    join(other, "gate7-source.json"),
    JSON.stringify({ ...made, source_key: "f".repeat(32) }, null, 2),
  );
  check(
    "publish: a run made from other inputs is refused",
    sc("publish", key, "gate3", "all", other).status === 3,
  );
  // entries are read-only; make them writable so the scratch repo can be removed
  spawnSync("chmod", ["-R", "u+w", cache]);
}
chmodSync(root, 0o755);
rmSync(root, { recursive: true, force: true });
console.log(`self-test-source-key: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
