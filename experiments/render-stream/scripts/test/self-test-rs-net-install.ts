// Exercise the real build script's install with fake build tools. Both copies finish before
// either rename, deterministically exposing a shared temporary destination.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeSelfTestTempDir,
  removeSelfTestTempDir,
} from "../lib/self-test-temp";

const dir = makeSelfTestTempDir(join(tmpdir(), "rs-net-install-"));
try {
  for (const sub of ["scripts", "rs-net/target/release", "bin", "barrier"])
    mkdirSync(join(dir, sub), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("../build-rs-net.sh", import.meta.url)),
    join(dir, "scripts/build-rs-net.sh"),
  );
  const library = Buffer.alloc(1024 * 1024, 0xa5);
  writeFileSync(
    join(dir, "rs-net/target/release/librender_stream_net.so"),
    library,
  );
  const stub = (name: string, body: string) =>
    writeFileSync(
      join(dir, "bin", name),
      `#!/usr/bin/env bash\nset -eu\n${body}\n`,
      {
        mode: 0o755,
      },
    );
  stub(
    "cargo",
    `
if [ "$1" = build ] || [ "$1" = test ]; then
  [[ " $* " = *" --features rtc "* ]] || { echo 'missing RTC feature' >&2; exit 1; }
fi
echo 'cargo fake'`,
  );
  stub("rustc", 'echo "rustc fake"');
  stub(
    "nm",
    "printf '0 T grc_net_module_v1\\n0 T grc_net_rtc_v1\\n0 T grc_net_tls_v1\\n'",
  );
  stub(
    "cp",
    `/bin/cp "$@"
touch "$INSTALL_BARRIER/$PPID"
for ((i=0; i<500; i++)); do
  if [ "$(find "$INSTALL_BARRIER" -type f | wc -l)" -eq 2 ]; then exit 0; fi
  sleep 0.01
done
echo 'copy barrier timed out' >&2
exit 1`,
  );
  const run = (): Promise<{ code: number | null; output: string }> =>
    new Promise((resolve, reject) => {
      const proc = spawn("bash", [join(dir, "scripts/build-rs-net.sh")], {
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          RS_QUIET_BUILD_WRAPPED: "1",
          INSTALL_BARRIER: join(dir, "barrier"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      proc.stdout.on("data", (b) => (output += b));
      proc.stderr.on("data", (b) => (output += b));
      proc.on("error", reject);
      proc.on("close", (code) => resolve({ code, output }));
    });
  const results = await Promise.all([run(), run()]);
  for (const [i, result] of results.entries())
    assert.equal(result.code, 0, `install ${i + 1}: ${result.output}`);
  assert.deepEqual(
    readFileSync(join(dir, "capture/build/librender_stream_net.so")),
    library,
  );
  assert.deepEqual(
    readdirSync(join(dir, "capture/build")).sort(),
    ["librender_stream_net.so", "rs-net-build.json"],
    "no temporary install files remain",
  );
  // Windows ships copies of Cargo's test harnesses. Keep every harness (including the RTC
  // ABI tests), but strip their symbol tables without modifying Cargo's original binaries.
  rmSync(join(dir, "bin/cp"));
  mkdirSync(join(dir, "scripts/lib"));
  mkdirSync(join(dir, "capture/build-windows"), { recursive: true });
  writeFileSync(
    join(dir, "scripts/lib/llvm-mingw.sh"),
    `llvm_mingw_ensure() { export LLVM_MINGW_ROOT="${dir}"; }
llvm_mingw_record() { echo '{}' > "$1"; }
`,
  );
  writeFileSync(
    join(dir, "scripts/w-imports.py"),
    `import json, sys
from pathlib import Path
Path(sys.argv[sys.argv.index('--json') + 1]).write_text(json.dumps({'binaries': [{
    'exports': ['grc_net_module_v1', 'grc_net_rtc_v1', 'grc_net_tls_v1'],
    'imports': [], 'delay_imports': []}]}))
`,
  );
  const windowsRelease = join(
    dir,
    "rs-net/target/x86_64-pc-windows-gnullvm/release",
  );
  mkdirSync(windowsRelease, { recursive: true });
  const executable = "executable bytes";
  const unstripped = `${executable}\nsymbol table\n`;
  writeFileSync(join(windowsRelease, "render_stream_net.dll"), unstripped);
  const windowsTests = ["wt", "rtc_abi", "rtc_abi_layout"];
  const artifacts = windowsTests.map((name) => {
    const path = join(windowsRelease, `${name}.exe`);
    writeFileSync(path, unstripped);
    return {
      reason: "compiler-artifact",
      profile: { test: true },
      executable: path,
      target: { name, kind: ["test"] },
    };
  });
  writeFileSync(
    join(dir, "artifacts.jsonl"),
    `${artifacts.map((a) => JSON.stringify(a)).join("\n")}\n`,
  );
  stub(
    "cargo",
    `if [ "$1" = build ] || [ "$1" = test ]; then
  [[ " $* " = *" --features rtc "* ]] || exit 1
fi
if [ "$1" = test ]; then cat '${join(dir, "artifacts.jsonl")}'; else echo 'cargo fake'; fi`,
  );
  stub(
    "llvm-strip",
    `[[ "$#" = 4 && "$1" = --strip-all && "$2" = -o ]] || exit 1
head -c ${executable.length} "$4" > "$3"`,
  );
  const manifestTemplate = join(
    dir,
    "capture/build-windows/w-capture-manifest.json",
  );
  writeFileSync(
    manifestTemplate,
    JSON.stringify({ tests: [], imports_only: [], sabotage: [] }),
  );
  const windows = spawnSync(
    "bash",
    [
      join(dir, "scripts/build-rs-net.sh"),
      "--target",
      "windows",
      "--manifest-template",
      manifestTemplate,
    ],
    {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        RS_QUIET_BUILD_WRAPPED: "1",
      },
      encoding: "utf8",
    },
  );
  assert.equal(windows.status, 0, windows.stdout + windows.stderr);
  const manifest = JSON.parse(
    readFileSync(join(dir, "capture/build-windows/w-manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.tests.map((t: { name: string }) => t.name).sort(),
    windowsTests.map((name) => `rs-net-${name}`).sort(),
  );
  assert.equal(
    readFileSync(
      join(dir, "capture/build-windows/rs-net/render_stream_net.dll"),
      "utf8",
    ),
    executable,
    "installed DLL has no symbol table",
  );
  assert.equal(
    readFileSync(join(windowsRelease, "render_stream_net.dll"), "utf8"),
    unstripped,
    "Cargo's original DLL is preserved",
  );
  for (const name of windowsTests) {
    assert.equal(
      readFileSync(
        join(dir, `capture/build-windows/rs-net/tests/${name}.exe`),
        "utf8",
      ),
      executable,
      `${name}: installed executable has no symbol table`,
    );
    assert.equal(
      readFileSync(join(windowsRelease, `${name}.exe`), "utf8"),
      unstripped,
      `${name}: Cargo's original executable is preserved`,
    );
  }
  console.log("self-test-rs-net-install: 14 passed, 0 failed");
} finally {
  removeSelfTestTempDir(dir);
}
