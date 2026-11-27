#!/usr/bin/env -S pnpm exec tsx --conditions=development

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timeJudge } from "../lib/gate7-judge-timing";
import { GATE7B_GATES, runChecker } from "../lib/gate7b-adapters";
import {
  makeSelfTestTempDir,
  removeSelfTestTempDir,
} from "../lib/self-test-temp";

const root = makeSelfTestTempDir(join(tmpdir(), "g7-judge-timing-"));
const rows = (out: string) =>
  readFileSync(join(out, "judge-timing.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

try {
  // The real adapter must journal the cold spawn, including a checker returning a failed gate.
  const bin = join(root, "bin");
  const view = join(root, "gate6", "web-view");
  mkdirSync(bin);
  mkdirSync(view, { recursive: true });
  const report = { gate_passed: false, checks: [], legs: {} };
  writeFileSync(
    join(bin, "mise"),
    `#!/bin/sh\nfor last; do :; done\nprintf '%s' '${JSON.stringify(report)}' >"$last/result.json"\nexit 1\n`,
  );
  chmodSync(join(bin, "mise"), 0o755);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${originalPath}`;
    assert.deepEqual(
      await runChecker(GATE7B_GATES.find((def) => def.group === "g7-6")!, view),
      report,
    );
  } finally {
    process.env.PATH = originalPath;
  }
  assert.ok(
    existsSync(join(root, "gate6", "judge-timing.jsonl")),
    "runChecker must persist its start and end outside result.json",
  );
  const checker = rows(join(root, "gate6"));
  assert.deepEqual(
    checker.map((r) => r.event),
    ["start", "end"],
  );
  assert.equal(checker[0].stage, "runChecker");
  assert.equal(checker[0].detail.view, view);
  assert.equal(checker[1].detail.exit_code, "1");
  console.log("PASS spawned checker timing and unchanged failed verdict");

  const value = { gate_passed: false };
  assert.equal(await timeJudge(root, "outer", {}, async () => value), value);
  const failure = new Error("checker failure");
  await assert.rejects(
    timeJudge(root, "throws", {}, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  const events = rows(root);
  assert.deepEqual(
    events.map((r) => r.event),
    ["start", "end", "start", "end"],
  );
  assert.equal(events[1].outcome, "returned");
  assert.equal(events[3].outcome, "error");
  for (const index of [0, 2]) {
    assert.equal(events[index].id, events[index + 1].id);
    assert.ok(Number.isFinite(Date.parse(events[index].at)));
    assert.ok(events[index + 1].elapsed_ms >= 0);
  }
  console.log(
    "PASS return values, exception identity and paired monotonic durations",
  );

  // Synchronize on the callback starting, then kill: no timeout/sleep race in this test.
  const killed = join(root, "killed");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--conditions=development",
      "--input-type=module",
      "-e",
      `import { timeJudge } from ${JSON.stringify(new URL("../lib/gate7-judge-timing.ts", import.meta.url).href)};
     await timeJudge(${JSON.stringify(killed)}, "blocked", {}, async () => {
       process.stdout.write("ready\\n");
       await new Promise(() => { setInterval(() => {}, 1000); });
     });`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = once(child, "exit");
  await Promise.race([
    once(child.stdout, "data"),
    exited.then(([code, signal]) => {
      throw new Error(`timing child exited before ready: ${code}/${signal}`);
    }),
  ]);
  child.kill("SIGKILL");
  await exited;
  assert.deepEqual(
    rows(killed).map((r) => r.event),
    ["start"],
  );
  console.log("PASS SIGKILL retains the unfinished stage start");

  const runner = readFileSync(
    new URL("../run-gate7.sh", import.meta.url),
    "utf8",
  );
  const journal = runner.slice(
    runner.indexOf('QUIET_T0="$EPOCHREALTIME"'),
    runner.indexOf('echo "run-gate7: evidence directory:'),
  );
  assert.ok(journal.includes("runner-timing.jsonl"));
  const shellOut = join(root, "shell");
  mkdirSync(shellOut);
  const shell = spawnSync(
    "bash",
    [
      "-c",
      `
    OUT="$1"
    quiet_run() { shift 3; "$@"; }
    quiet_summary() { :; }
    quiet__secs() { echo 0; }
    ${journal}
    gate7_checker bash -c 'exit 7'
  `,
      "_",
      shellOut,
    ],
    { encoding: "utf8" },
  );
  assert.equal(shell.status, 7, shell.stderr);
  const boundaries = readFileSync(join(shellOut, "runner-timing.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    boundaries.map((r) => [r.stage, r.event]),
    [
      ["runner", "start"],
      ["judge", "start"],
      ["judge", "end"],
      ["runner", "end"],
    ],
  );
  assert.equal(boundaries[2].exit_code, 7);
  console.log("PASS runner phase boundaries preserve a failed judge exit");

  const workflow = readFileSync(
    new URL(
      "../../../../.github/workflows/remote-validate.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const exportTimings = workflow.slice(
    workflow.indexOf("          # Always print judge timings"),
    workflow.indexOf("          # the check ids of the run's own verdict"),
  );
  assert.ok(exportTimings.includes("judge-timing.jsonl"));
  const remote = join(root, "remote");
  for (const repeat of ["v", "v2"]) {
    const run = join(remote, repeat, "g7-gsw", "run");
    mkdirSync(join(run, "gate6"), { recursive: true });
    writeFileSync(join(run, "runner-timing.jsonl"), "runner\n");
    writeFileSync(join(run, "gate6", "judge-timing.jsonl"), "judge\n");
    symlinkSync(run, join(run, "cycle"));
  }
  const exported = spawnSync("bash", ["-c", exportTimings], {
    env: {
      ...process.env,
      RUNNER_TEMP: remote,
      ID: "g7-gsw",
      LABEL: "g7-gsw@g7-6",
      art: join(remote, "art"),
    },
    encoding: "utf8",
  });
  assert.equal(exported.status, 0, exported.stderr);
  for (const repeat of ["v", "v2"]) {
    assert.equal(
      readFileSync(
        join(
          remote,
          "art",
          "judge-timings",
          repeat,
          "gate6",
          "judge-timing.jsonl",
        ),
        "utf8",
      ),
      "judge\n",
    );
    assert.ok(
      exported.stdout.includes(`g7-gsw@g7-6/${repeat}/runner-timing.jsonl`),
    );
    assert.ok(
      exported.stdout.includes(
        `g7-gsw@g7-6/${repeat}/gate6/judge-timing.jsonl`,
      ),
    );
  }
  console.log(
    "PASS workflow logs and copies timings for success, failure and repeats without following symlinks",
  );
} finally {
  removeSelfTestTempDir(root);
}
