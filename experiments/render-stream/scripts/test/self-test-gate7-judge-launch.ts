#!/usr/bin/env -S pnpm exec tsx --conditions=development
import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gateJudgeSpawnSync } from "../lib/gate7-judge-child";
import {
  makeSelfTestTempDir,
  removeSelfTestTempDir,
} from "../lib/self-test-temp";

const root = makeSelfTestTempDir(join(tmpdir(), "g7-judge-launch-"));
const previousOut = process.env.RS_JUDGE_OUT;
const shape = (result: SpawnSyncReturns<string>) => ({
  status: result.status,
  signal: result.signal,
  output: result.output,
  pid: result.pid,
  stdout: result.stdout,
  stderr: result.stderr,
  error: result.error && {
    ...result.error,
    message: result.error.message,
  },
});
try {
  process.env.RS_JUDGE_OUT = root;
  if (!process.argv.includes("--coding-only")) {
    const missing = join(root, "nonexistent-executable");
    const denied = join(root, "nonexecutable-file");
    writeFileSync(denied, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    for (const [command, code] of [
      [missing, "ENOENT"],
      [denied, "EACCES"],
    ]) {
      const args = ["--probe"];
      const baseline = spawnSync(command!, args, { encoding: "utf8" });
      assert.equal((baseline.error as NodeJS.ErrnoException).code, code);
      const result = gateJudgeSpawnSync(command!, args, { encoding: "utf8" });
      assert.ok(result.error instanceof Error);
      assert.equal(result.status, null);
      assert.deepEqual(shape(result), shape(baseline));
      console.log(`PASS ${code}: unsuccessful result matches Node spawnSync`);
    }
  }

  // Execute the real, unchanged checker source from a private source checkout. Its encoder
  // stays absent regardless of whether the working checkout already has native build outputs.
  const source = fileURLToPath(
    new URL("../lib/gate8-w11t-checks.ts", import.meta.url),
  );
  const experiment = join(root, "checkout", "experiments", "render-stream");
  const lib = join(experiment, "scripts", "lib");
  mkdirSync(lib, { recursive: true });
  const fixture = join(lib, "gate8-w11t-checks.mts");
  copyFileSync(source, fixture);
  for (const [, dependency] of readFileSync(source, "utf8").matchAll(
    /from "(\.\/[^"]+)"/g,
  )) {
    symlinkSync(
      join(dirname(source), `${dependency}.ts`),
      join(lib, `${dependency}.ts`),
    );
  }
  assert.equal(
    existsSync(join(experiment, "capture", "build", "rs_live_coding_tool")),
    false,
  );
  const { runG8w11Coding } = (await import(
    pathToFileURL(fixture).href
  )) as typeof import("../lib/gate8-w11t-checks");
  const evidence = join(root, "evidence", "g8w11");
  mkdirSync(evidence, { recursive: true });
  const checks = await runG8w11Coding(evidence);
  assert.deepEqual(
    checks.map((check) => check.id),
    [
      "coding-wire",
      "coding-wire-sabotages",
      "coding-negotiated",
      "coding-lossless",
      "coding-validates",
      "coding-applies-as-off",
      "coding-smaller",
      "coding-shared",
      "coding-drop-base-caught",
      "coding-wrong-prefix-caught",
    ],
  );
  for (const id of ["coding-wire", "coding-wire-sabotages"]) {
    const check = checks.find((check) => check.id === id)!;
    assert.equal(check.status, "fail");
    assert.equal(check.passed, false);
  }
  assert.equal(existsSync(join(root, "judge-timeout.json")), false);
  console.log(
    "PASS missing encoder: runG8w11Coding returns all 10 named checks with coding-wire failures",
  );
} finally {
  if (previousOut === undefined) delete process.env.RS_JUDGE_OUT;
  else process.env.RS_JUDGE_OUT = previousOut;
  removeSelfTestTempDir(root);
}
