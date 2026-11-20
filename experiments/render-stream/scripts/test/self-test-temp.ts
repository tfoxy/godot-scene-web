#!/usr/bin/env -S pnpm exec tsx --conditions=development
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeSelfTestTempDir,
  removeSelfTestTempDir,
} from "../lib/self-test-temp";

const helper = fileURLToPath(
  new URL("../lib/self-test-temp.ts", import.meta.url),
);
const originalKeep = process.env.RS_SELF_TEST_KEEP_TMP;
delete process.env.RS_SELF_TEST_KEEP_TMP;
let passed = 0;
const root = makeSelfTestTempDir(join(tmpdir(), "self-test-temp-parent-"));
const childScratch = makeSelfTestTempDir(
  join(tmpdir(), "self-test-temp-children-"),
);
try {
  writeFileSync(join(root, "evidence"), "test");
  removeSelfTestTempDir(root);
  assert(
    !existsSync(root),
    "explicit removal deletes the root and its contents",
  );
  passed++;
  removeSelfTestTempDir(root);
  passed++;

  for (const keep of [false, true]) {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      const env = { ...process.env };
      if (keep) env.RS_SELF_TEST_KEEP_TMP = "1";
      const child = spawn(
        process.execPath,
        [
          ...process.execArgv,
          "--input-type=module",
          "-e",
          `import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSelfTestTempDir, removeSelfTestTempDir } from ${JSON.stringify(helper)};
const roots = [0, 1, 2].map(() => makeSelfTestTempDir(${JSON.stringify(join(childScratch, "child-"))}));
for (const root of roots) writeFileSync(join(root, 'evidence'), 'test');
removeSelfTestTempDir(roots[2]);
mkdirSync(roots[2], { recursive: true });
process.send(roots);
setInterval(() => {}, 1000);`,
        ],
        { env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let stderr = "";
      child.stderr?.on("data", (data) => {
        stderr += data;
      });
      let roots: string[] = [];
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        const exited = new Promise<{
          code: number | null;
          signal: string | null;
        }>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        child.once("message", (message) => {
          roots = message as string[];
          child.kill(signal);
        });
        const exit = await exited;
        assert.equal(
          roots.length,
          3,
          `child creates roots before ${signal}: ${stderr}`,
        );
        assert.equal(exit.signal, null, stderr);
        assert.equal(exit.code, 128 + constants.signals[signal], stderr);
        assert.equal(
          existsSync(roots[0]),
          keep,
          `${signal} cleans first registered root`,
        );
        assert.equal(
          existsSync(roots[1]),
          keep,
          `${signal} cleans second registered root`,
        );
        assert(
          existsSync(roots[2]),
          "explicit removal unregisters a reused path",
        );
        if (keep) {
          for (const path of roots)
            assert(stderr.includes(path), "keep prints each root");
          assert(
            existsSync(join(roots[2], "evidence")),
            "keep preserves explicit removal",
          );
        }
        passed += keep ? 10 : 6;
      } finally {
        clearTimeout(timeout);
        child.kill("SIGKILL");
        for (const path of roots)
          rmSync(path, { recursive: true, force: true });
      }
    }
  }
} finally {
  removeSelfTestTempDir(childScratch);
  rmSync(root, { recursive: true, force: true });
  if (originalKeep === undefined) delete process.env.RS_SELF_TEST_KEEP_TMP;
  else process.env.RS_SELF_TEST_KEEP_TMP = originalKeep;
}
console.log(`self-test-temp: ${passed} passed, 0 failed`);
