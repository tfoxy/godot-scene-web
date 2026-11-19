import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

// Execute the drivers with fake tools: a Darwin test must never reach quiet.sh.
async function drive(
  file,
  platform,
  {
    failPage = false,
    failSimulator,
    failDriver = false,
    failDiagnostics = false,
  } = {},
) {
  const events = [];
  const builds = [];
  const artifacts = [];
  const driverOptions = [];
  let acquired = 0;
  let released = 0;
  const page = {
    on() {},
    async goto() {},
    async waitForFunction() {},
    async evaluate() {
      return { ok: true };
    },
    async close() {},
  };
  const browser = {
    async newPage() {
      return page;
    },
    version: () => "stub",
    async close() {},
  };
  const browserType = {
    async launch() {
      return browser;
    },
    executablePath: () => "/stub/browser",
  };
  const mocks = {
    "node:child_process": {
      spawnSync(command, args) {
        builds.push([command, ...args]);
        return { status: 0 };
      },
      execFileSync(command, args) {
        events.push(args.join(" "));
        if (failSimulator && args.includes(failSimulator))
          throw Error(`simulator ${failSimulator} failed`);
        if (args.includes("runtimes")) return JSON.stringify({ runtimes: [] });
        if (args.includes("devicetypes"))
          return JSON.stringify({ devicetypes: [] });
        return command === "xcrun" ? "stub-udid" : "";
      },
      spawn() {
        return { once() {}, kill() {} };
      },
    },
    "node:fs": { createWriteStream: () => ({ write() {} }) },
    "node:fs/promises": {
      async mkdir() {},
      async writeFile(_path, value) {
        artifacts.push(JSON.parse(value));
      },
    },
    "node:path": {
      dirname: () => "/stub",
      resolve: (...parts) => parts.join("/"),
    },
    "node:util": {
      parseArgs: () => ({
        values: {
          ip: "10.0.0.4",
          out: "/stub/result.json",
          browsers: "chromium,webkit",
        },
      }),
    },
    "@playwright/test": { chromium: browserType, webkit: browserType },
    "../scripts/lib/quiet-lock": {
      async quietAcquire() {
        assert.notEqual(
          platform,
          "darwin",
          "Darwin must bypass the Linux quiet lock",
        );
        acquired++;
        return {
          waitS: 2.25,
          async release() {
            released++;
          },
        };
      },
    },
    "./probe.mjs": {
      async startProbe() {
        return {
          discovery: { ip: "10.0.0.4", port: 45000, fp: "stable" },
          async stop() {},
        };
      },
    },
    "./serve.mjs": {
      async serve() {
        return {
          server: { close: (done) => done() },
          url: "http://localhost:8000",
        };
      },
    },
    "./safari-driver.mjs": {
      async withSafariDriver(path, callback, options) {
        driverOptions.push(options);
        events.push(`driver-start ${path}`);
        try {
          if (failDriver) throw Error("SafariDriver startup timeout");
          return await callback("http://driver");
        } finally {
          events.push(`driver-exited ${path}`);
        }
      },
      async collectSafariDiagnostics(_out, udid) {
        events.push(`diagnostics ${udid}`);
        if (failDiagnostics) throw Error("diagnostics failed");
        return { files: [] };
      },
    },
    "./safari.mjs": {
      async request() {},
      async runPage(_base, url, udid) {
        events.push(url);
        assert.equal(
          udid,
          new URL(url).searchParams.has("seq") ? "stub-udid" : undefined,
        );
        if (failPage)
          throw new TypeError("fetch failed", {
            cause: { code: "ECONNRESET", message: "socket closed" },
          });
        return { ok: true };
      },
      errorDetails: (error) => ({ error: String(error), cause: error.cause }),
      selectSimulator: () => ({
        type: "iphone13",
        runtime: "ios",
        version: "18.0",
      }),
    },
  };
  const context = createContext({
    process: { platform },
    console: { log() {} },
    Date,
    JSON,
    URL,
  });
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  const module = new SourceTextModule(stripTypeScriptTypes(source), {
    context,
  });
  await module.link((name) => {
    assert.ok(mocks[name], `unexpected dependency: ${name}`);
    const exports = mocks[name];
    return new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports))
          this.setExport(key, value);
      },
      { context },
    );
  });
  await module.evaluate();
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].ok, !failPage && !failSimulator && !failDriver);
  return {
    builds,
    result: artifacts[0],
    acquired,
    released,
    events,
    driverOptions,
  };
}

test("Playwright on Darwin builds and runs without quiet.sh", async () => {
  const { builds, result, acquired } = await drive("run-browsers.ts", "darwin");
  assert.deepEqual(builds[0].slice(0, 2), ["cargo", "build"]);
  assert.equal(acquired, 0);
  assert.equal(result.lock_wait_s, 0);
  assert.equal(Object.keys(result.results).length, 4);
});

test("Playwright on Linux retains shared build and exclusive browser locks", async () => {
  const { builds, result, acquired, released } = await drive(
    "run-browsers.ts",
    "linux",
  );
  assert.deepEqual(builds[0].slice(0, 6), [
    "bash",
    "experiments/render-stream/scripts/lib/quiet.sh",
    "shared",
    "--",
    "cargo",
    "build",
  ]);
  assert.equal(acquired, 1);
  assert.equal(released, 1);
  assert.equal(result.lock_wait_s, 2.25);
});

test("desktop and iPhone Safari run without the Linux quiet lock", async () => {
  const { result, acquired } = await drive("run-safari.ts", "darwin");
  assert.equal(acquired, 0);
  assert.deepEqual(Object.keys(result.results), [
    "safari",
    "safari-negative",
    "iphone-safari",
    "iphone-safari-negative",
  ]);
});

test("simulator boots before one shared driver runs desktop then iPhone sessions", async () => {
  const { events, driverOptions } = await drive("run-safari.ts", "darwin");
  const starts = events.filter((e) => e.startsWith("driver-start"));
  assert.equal(starts.length, 1);
  assert.equal(driverOptions[0].startupMs, 60000);
  const bootstatus = events.indexOf("simctl bootstatus stub-udid -b");
  const driverStart = events.indexOf(starts[0]);
  const driverExit = events.findIndex((e) => e.startsWith("driver-exited"));
  assert.ok(bootstatus >= 0 && bootstatus < driverStart);
  assert.ok(bootstatus < events.indexOf("-n safaridriver --enable"));
  const pages = events.filter((e) => e.startsWith("http://localhost"));
  assert.equal(pages.length, 4);
  assert.ok(driverStart < events.indexOf(pages[0]));
  assert.ok(events.lastIndexOf(pages[3]) < driverExit);
  assert.ok(driverExit < events.indexOf("simctl delete stub-udid"));
  assert.ok(
    pages.slice(0, 2).every((url) => !new URL(url).searchParams.has("seq")),
  );
  assert.ok(
    pages
      .slice(2)
      .every((url) => new URL(url).searchParams.get("seq") === "200"),
  );
});

test("shared driver startup failure retains diagnostics and deletes the simulator after exit", async () => {
  const { events, result } = await drive("run-safari.ts", "darwin", {
    failDriver: true,
  });
  assert.match(result.results.setup.error, /SafariDriver startup timeout/);
  assert.ok(result.diagnostics.setup);
  const driverExit = events.findIndex((e) => e.startsWith("driver-exited"));
  const diagnostics = events.indexOf("diagnostics stub-udid");
  assert.ok(
    driverExit < diagnostics &&
      diagnostics < events.indexOf("simctl delete stub-udid"),
  );
});

for (const failSimulator of ["runtimes", "create", "boot", "bootstatus"]) {
  test(`simulator ${failSimulator} failure preserves desktop legs and fails both iPhone legs`, async () => {
    const { events, result } = await drive("run-safari.ts", "darwin", {
      failSimulator,
    });
    assert.equal(result.results.safari.ok, true);
    assert.equal(result.results["safari-negative"].ok, true);
    for (const label of ["iphone-safari", "iphone-safari-negative"]) {
      assert.equal(result.results[label].ok, false);
      assert.match(
        result.results[label].error,
        new RegExp(`simulator ${failSimulator} failed`),
      );
    }
    assert.equal(events.filter((e) => e.startsWith("driver-start")).length, 1);
    assert.equal(
      events.filter((e) => e.startsWith("http://localhost")).length,
      2,
    );
    if (["boot", "bootstatus"].includes(failSimulator)) {
      const driverExit = events.findIndex((e) => e.startsWith("driver-exited"));
      assert.ok(driverExit < events.indexOf("simctl delete stub-udid"));
    }
  });
}

test("failed simulator requests retain their cause and collect logs before deleting the device", async () => {
  const { events, result } = await drive("run-safari.ts", "darwin", {
    failPage: true,
  });
  assert.equal(result.results["iphone-safari"].cause.code, "ECONNRESET");
  assert.ok(result.diagnostics["iphone-safari"]);
  const diagnostics = events.indexOf("diagnostics stub-udid");
  assert.ok(
    diagnostics > 0 && diagnostics < events.indexOf("simctl delete stub-udid"),
  );
});

test("diagnostic failures preserve page errors and allow later sessions to run", async () => {
  const { events, result } = await drive("run-safari.ts", "darwin", {
    failPage: true,
    failDiagnostics: true,
  });
  assert.equal(
    events.filter((e) => e.startsWith("http://localhost")).length,
    4,
  );
  assert.equal(
    result.results["iphone-safari-negative"].cause.code,
    "ECONNRESET",
  );
  assert.match(result.diagnostics["iphone-safari"].error, /diagnostics failed/);
  assert.ok(events.includes("simctl delete stub-udid"));
});
