import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  collectSafariDiagnostics,
  withSafariDriver,
} from "./safari-driver.mjs";

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "rtc-safari-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeDriver(events, forceKill = false) {
  return (command, args) => {
    events.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      events.push(signal);
      if (!forceKill || signal === "SIGKILL")
        setTimeout(() => {
          child.stdout.end();
          child.stderr.end();
          events.push("exited");
          child.emit("close", 0);
        }, 5);
    };
    return child;
  };
}

test("one diagnosed driver is killed and awaited after both legs", async (t) => {
  const dir = await scratch(t);
  const events = [];
  await withSafariDriver(
    join(dir, "shared.log"),
    async () => {
      events.push("desktop", "simulator");
    },
    {
      spawnDriver: fakeDriver(events),
      requestDriver: async () => ({}),
    },
  );
  assert.deepEqual(events, [
    ["safaridriver", "--diagnose", "-p", "4444"],
    "desktop",
    "simulator",
    "SIGTERM",
    "exited",
  ]);
});

test("driver cleanup awaits forced exit when the page fails and SIGTERM is ignored", async (t) => {
  const dir = await scratch(t);
  const events = [];
  await assert.rejects(
    withSafariDriver(
      join(dir, "failed.log"),
      async () => {
        throw Error("page failed");
      },
      {
        spawnDriver: fakeDriver(events, true),
        requestDriver: async () => ({}),
        stopMs: 10,
      },
    ),
    /page failed/,
  );
  assert.deepEqual(events.slice(1), ["SIGTERM", "SIGKILL", "exited"]);
});

test("startup failure also kills and awaits the driver", async (t) => {
  const dir = await scratch(t);
  const events = [];
  await assert.rejects(
    withSafariDriver(
      join(dir, "startup.log"),
      async () => {
        assert.fail("page must not run");
      },
      { spawnDriver: fakeDriver(events), startupMs: 0 },
    ),
    /startup timeout/,
  );
  assert.deepEqual(events.slice(1), ["SIGTERM", "exited"]);
});

test("diagnostics copy bounded WebDriver tails and a bounded simulator excerpt", async (t) => {
  const dir = await scratch(t);
  const logsDir = join(dir, "source");
  await mkdir(join(logsDir, "session"), { recursive: true });
  await writeFile(join(logsDir, "session", "driver.log"), "prefix-abcdefghij");
  await symlink(
    join(logsDir, "session", "driver.log"),
    join(logsDir, "ignored-link"),
  );
  let argv;
  const result = await collectSafariDiagnostics(join(dir, "artifact"), "UDID", {
    logsDir,
    fileBytes: 8,
    maxBytes: 8,
    run(command, args, options) {
      argv = [command, ...args];
      assert.equal(options.timeout, 60000);
      assert.equal(options.maxBuffer, 1024 * 1024);
      return "s".repeat(300 * 1024);
    },
  });
  assert.equal(result.bytes, 8);
  assert.equal(
    await readFile(join(dir, "artifact/webdriver/session/driver.log"), "utf8"),
    "cdefghij",
  );
  assert.ok(result.files.every((f) => f.truncated));
  assert.equal(
    (await readFile(join(dir, "artifact/simulator.log"))).length,
    256 * 1024,
  );
  assert.deepEqual(argv.slice(0, 7), [
    "xcrun",
    "simctl",
    "spawn",
    "UDID",
    "log",
    "show",
    "--last",
  ]);
  assert.ok(
    argv.includes(
      'process == "MobileSafari" OR process == "com.apple.WebKit.Networking"',
    ),
  );
});

test("diagnostic command failure preserves partial output and cause without hiding the leg failure", async (t) => {
  const dir = await scratch(t);
  const result = await collectSafariDiagnostics(join(dir, "artifact"), "UDID", {
    logsDir: join(dir, "missing"),
    run() {
      throw Object.assign(new Error("maxBuffer"), {
        stdout: "partial log",
        stderr: "error log",
        cause: { code: "ENOBUFS", message: "too large" },
      });
    },
  });
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[1].cause.code, "ENOBUFS");
  assert.match(
    await readFile(join(dir, "artifact/simulator.log"), "utf8"),
    /partial log\nerror log/,
  );
});
