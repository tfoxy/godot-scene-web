// Exercise the real build script's install with fake build tools. Both copies finish before
// either rename, deterministically exposing a shared temporary destination.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "rs-net-install-"));
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
  stub("cargo", 'echo "cargo fake"');
  stub("rustc", 'echo "rustc fake"');
  stub("nm", "printf '0 T grc_net_module_v1\\n0 T grc_net_tls_v1\\n'");
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
      const proc = spawn(
        "bash",
        [join(dir, "scripts/build-rs-net.sh"), "--no-test"],
        {
          env: {
            ...process.env,
            PATH: `${join(dir, "bin")}:${process.env.PATH}`,
            RS_QUIET_BUILD_WRAPPED: "1",
            INSTALL_BARRIER: join(dir, "barrier"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
  console.log("self-test-rs-net-install: 4 passed, 0 failed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
