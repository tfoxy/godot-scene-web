#!/usr/bin/env -S pnpm exec tsx --conditions=development
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JudgeTimeout, judgeSpawnSync } from "../lib/gate7-judge-child";
import { GATE7B_GATES, runChecker } from "../lib/gate7b-adapters";
import { phaseHeartbeat } from "../lib/phase-heartbeat";
import {
  makeSelfTestTempDir,
  removeSelfTestTempDir,
} from "../lib/self-test-temp";

const root = makeSelfTestTempDir(join(tmpdir(), "g7-judge-timeout-"));
const oldPath = process.env.PATH;
const oldOut = process.env.RS_JUDGE_OUT;
const oldHeartbeat = process.env.RS_PHASE_LOG;
const markers: string[] = [];
const pidMarker = (name: string) => {
  const path = join(root, `${name}.pid`);
  markers.push(path);
  return path;
};
const state = (pid: number): string => {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")[1]!
      .split(" ")[0]!;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw error;
  }
};
const assertDead = async (path: string) => {
  const pid = Number(readFileSync(path, "utf8").trim());
  for (
    let attempt = 0;
    attempt < 100 && !["gone", "Z", "X"].includes(state(pid));
    attempt++
  )
    await delay(20);
  assert.ok(
    ["gone", "Z", "X"].includes(state(pid)),
    `${path}: PID ${pid} survived (${state(pid)})`,
  );
};
try {
  const bin = join(root, "bin");
  const out = join(root, "job", "g7-web-rust", "run");
  const view = join(out, "gate6", "web-view");
  mkdirSync(bin);
  mkdirSync(view, { recursive: true });
  const grandchild = pidMarker("grandchild");
  // Both the immediate checker and its background grandchild must be killed.
  writeFileSync(
    join(bin, "mise"),
    `#!/bin/bash\nsleep 30 &\necho $! >'${grandchild}'\nwait\nprintf '{"gate_passed":true,"checks":[],"legs":{}}' >"${view}/result.json"\n`,
  );
  chmodSync(join(bin, "mise"), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.RS_JUDGE_OUT = out;
  process.env.RS_PHASE_LOG = join(root, "heartbeat.log");
  await assert.rejects(
    runChecker(GATE7B_GATES.find((def) => def.group === "g7-6")!, view, 200),
    (error) => {
      assert.ok(error instanceof JudgeTimeout);
      assert.equal(error.status, "judge-timeout");
      assert.equal(error.child.group, "g7-6");
      assert.equal(error.child.view, view);
      assert.equal(error.child.checker, "check-gate6.ts");
      return true;
    },
  );
  const marker = JSON.parse(
    readFileSync(join(out, "judge-timeout.json"), "utf8"),
  );
  assert.equal(marker.status, "judge-timeout");
  assert.equal(marker.checker, "check-gate6.ts");
  await assertDead(grandchild);
  console.log(
    "PASS sleeping checker: named judge-timeout and killed process group",
  );

  delete process.env.RS_JUDGE_OUT;
  if (!process.argv.includes("--external-only")) {
    const nestedSupervisor = pidMarker("nested-supervisor");
    const nestedWorker = pidMarker("nested-worker");
    const nestedCommand = `timeout --signal=KILL 30s bash -c 'echo $$ > "${nestedWorker}"; exec sleep 30' >/dev/null 2>&1 & nested=$!; echo "$nested" > "${nestedSupervisor}"; wait`;
    assert.throws(
      () =>
        judgeSpawnSync(
          "bash",
          ["-c", nestedCommand],
          { encoding: "utf8" },
          { group: "nested", view, checker: "nested timeout" },
          join(root, "nested-out"),
          300,
        ),
      JudgeTimeout,
    );
    await assertDead(nestedSupervisor);
    await assertDead(nestedWorker);
    console.log(
      "PASS checker deadline kills nested supervisor and worker across process groups",
    );
  }

  for (const forceKill of [false, true]) {
    const outerSupervisor = pidMarker(`watchdog-${forceKill}-supervisor`);
    const externalNested = pidMarker(`watchdog-${forceKill}-nested`);
    const externalWorker = pidMarker(`watchdog-${forceKill}-worker`);
    const externalCommand = `echo "$PPID" > "${outerSupervisor}"; timeout --signal=KILL 30s bash -c 'echo $$ > "${externalWorker}"; exec sleep 30' >/dev/null 2>&1 & nested=$!; echo "$nested" > "${externalNested}"; wait`;
    const caller = join(root, `watchdog-${forceKill}-caller.mjs`);
    writeFileSync(
      caller,
      `import { judgeSpawnSync } from ${JSON.stringify(new URL("../lib/gate7-judge-child.ts", import.meta.url).href)};
${forceKill ? 'process.on("SIGTERM", () => {});' : ""}
judgeSpawnSync("bash", ["-c", ${JSON.stringify(externalCommand)}], { encoding: "utf8" }, { group: "external", view: "nested", checker: "sleep" }, ${JSON.stringify(out)}, 600000);`,
    );
    const watchdog = spawnSync(
      "timeout",
      [
        "-k",
        "1",
        "4",
        process.execPath,
        "--import",
        "tsx",
        "--conditions=development",
        caller,
      ],
      { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" },
    );
    if (forceKill)
      assert.ok(
        watchdog.status === 137 || watchdog.signal === "SIGKILL",
        watchdog.stderr,
      );
    else assert.equal(watchdog.status, 124, watchdog.stderr);
    await assertDead(outerSupervisor);
    await assertDead(externalNested);
    await assertDead(externalWorker);
    console.log(
      forceKill
        ? "PASS escalated watchdog SIGKILL leaves no checker subtree"
        : "PASS external watchdog kills caller and entire nested checker subtree",
    );
  }

  // A normal failed checker, including exit 137, must retain its original exit status.
  const failed = judgeSpawnSync(
    "bash",
    ["-c", "exit 137"],
    { encoding: "utf8" },
    { group: "test", view, checker: "failed" },
    root,
    5000,
  );
  assert.equal(failed.status, 137);
  console.log("PASS ordinary checker exit status unchanged");

  const job = join(root, "job");
  writeFileSync(
    join(job, "plan.json"),
    JSON.stringify({
      runs: [{ id: "g7-web-rust", phase: "g7" }],
      skipped_targets: [],
      sabotage: false,
      tier: "full",
    }),
  );
  const summaryScript = new URL("../lib/validate-summary.py", import.meta.url)
    .pathname;
  const summary = spawnSync("python3", [summaryScript, job, "0", "1"], {
    encoding: "utf8",
  });
  assert.equal(summary.status, 1, summary.stderr);
  assert.match(summary.stdout, /judge-timeout/);
  const row = JSON.parse(
    readFileSync(join(job, "validate-summary.json"), "utf8"),
  ).runs[0];
  assert.equal(row.rc, "judge-timeout", "missing rc must retain timeout cause");
  assert.equal(row.judge_timeouts[0].checker, "check-gate6.ts");
  const fold = spawnSync(
    "python3",
    [
      "-c",
      `import importlib.util, json, sys
spec=importlib.util.spec_from_file_location('summary', sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r=json.load(open(sys.argv[2]))['runs'][0]
f=m.fold_shards([r], {'g7-web-rust':2})[0]
assert f['rc']=='judge-timeout' and f['missing_shards']==1
assert f['judge_timeouts'][0]['checker']=='check-gate6.ts'
`,
      summaryScript,
      join(job, "validate-summary.json"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(fold.status, 0, fold.stderr);
  console.log(
    "PASS summary and shard folding retain named judge-timeout and fail",
  );

  phaseHeartbeat("leg", "start", "gate6/receiver");
  phaseHeartbeat("leg", "end", "gate6/receiver exit=0");
  const heartbeats = readFileSync(join(root, "heartbeat.log"), "utf8");
  assert.match(heartbeats, /\d{4}-\d\d-\d\dT.*leg start gate6\/receiver/);
  assert.match(heartbeats, /judge\/runChecker start/);
  assert.match(heartbeats, /judge\/runChecker end/);
  console.log(
    "PASS timestamped leg and judge heartbeats bypass redirected runner output",
  );
} finally {
  // Markers are private to this test. Reap every survivor even when an assertion fails.
  for (const path of markers) {
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
  for (const [key, value] of [
    ["PATH", oldPath],
    ["RS_JUDGE_OUT", oldOut],
    ["RS_PHASE_LOG", oldHeartbeat],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
  removeSelfTestTempDir(root);
}
