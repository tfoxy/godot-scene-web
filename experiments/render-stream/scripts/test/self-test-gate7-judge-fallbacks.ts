#!/usr/bin/env -S pnpm exec tsx --conditions=development
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateJudgeSpawnSync, JudgeTimeout } from "../lib/gate7-judge-child";
import {
  defaultEvidenceRoot,
  defaultEvidenceRoot8,
} from "../lib/gate7z-checks";
import { probeGamescopeVersion } from "../lib/provenance";
import {
  makeSelfTestTempDir,
  removeSelfTestTempDir,
} from "../lib/self-test-temp";

const root = makeSelfTestTempDir(join(tmpdir(), "g7-judge-fallbacks-"));
const previous = {
  PATH: process.env.PATH,
  RS_JUDGE_OUT: process.env.RS_JUDGE_OUT,
};
const originalCwd = process.cwd();
const pidFile = join(root, "probe.pid");
const nativePid = join(root, "native.pid");
try {
  const bin = join(root, "bin");
  const out = join(root, "run");
  mkdirSync(bin);
  mkdirSync(out);
  process.chdir(root);
  process.env.PATH = `${bin}:${previous.PATH}`;
  process.env.RS_JUDGE_OUT = out;
  if (
    !process.argv.includes("--git-only") &&
    !process.argv.includes("--native-only")
  ) {
    writeFileSync(
      join(bin, "gamescope"),
      `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 8\n`,
    );
    chmodSync(join(bin, "gamescope"), 0o755);
    assert.equal(probeGamescopeVersion(), null);
    assert.equal(existsSync(join(out, "judge-timeout.json")), false);
    console.log(
      "PASS optional gamescope probe timeout returns null without judge marker",
    );
  }
  if (
    !process.argv.includes("--probe-only") &&
    !process.argv.includes("--native-only")
  ) {
    const repo = join(root, "checkout");
    mkdirSync(repo);
    const own = join(repo, "artifacts", "render-stream", "gate7");
    assert.equal(
      existsSync(own),
      false,
      "fallback regression needs no own gate7 evidence",
    );
    for (const body of ["exit 128", "exit 0"]) {
      writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, "git"), 0o755);
      assert.equal(defaultEvidenceRoot(repo), own);
      assert.equal(defaultEvidenceRoot8(repo), join(repo, "artifacts"));
    }
    console.log(
      "PASS failed and empty git probes preserve checkout-based evidence roots",
    );
  }
  if (
    !process.argv.includes("--probe-only") &&
    !process.argv.includes("--git-only")
  ) {
    delete process.env.RS_JUDGE_OUT;
    assert.throws(
      () =>
        gateJudgeSpawnSync(
          "bash",
          ["-c", `echo $$ > "${nativePid}"; exec sleep 30`],
          { encoding: "utf8", timeout: 100 },
        ),
      (error) => {
        assert.ok(error instanceof JudgeTimeout);
        assert.match(error.message, /no evidence directory.*RS_JUDGE_OUT/);
        return true;
      },
    );
    assert.equal(existsSync(join(root, "judge-timeout.json")), false);
    console.log(
      "PASS native checker timeout fails loudly without writing a cwd marker",
    );
  }
} finally {
  for (const path of [pidFile, nativePid]) {
    try {
      process.kill(Number(readFileSync(path, "utf8").trim()), "SIGKILL");
    } catch (error) {
      if (
        !["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        console.error(error);
        process.exitCode = 1;
      }
    }
  }
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeSelfTestTempDir(root);
}
