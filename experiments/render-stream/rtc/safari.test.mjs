import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { selectLan } from "./lan.mjs";
import {
  capabilities,
  createSession,
  request,
  runPage,
  selectSimulator,
} from "./safari.mjs";

test("LAN selection rejects internal and multicast addresses and records en0 provenance", () => {
  const interfaces = {
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    en0: [{ family: "IPv4", address: "192.168.1.4" }],
    other: [{ family: "IPv4", address: "10.0.0.4" }],
  };
  assert.deepEqual(selectLan(interfaces, "10.0.0.4"), {
    ip: "10.0.0.4",
    interface: "other",
    source: "ipconfig getifaddr en0",
  });
  assert.equal(selectLan(interfaces).interface, "en0");
  assert.throws(() =>
    selectLan({ x: [{ family: "IPv4", address: "224.0.0.1" }] }),
  );
});

test("simulator selection requires exact iPhone 13 and newest stable available iOS", () => {
  const runtime = (version, name = `iOS ${version}`, isAvailable = true) => ({
    name,
    version,
    isAvailable,
    identifier: version,
  });
  const runtimes = {
    runtimes: [
      runtime("18.6"),
      runtime("26.0"),
      runtime("27.0", "iOS 27.0 Beta"),
      runtime("28.0", "iOS 28.0", false),
    ],
  };
  const types = {
    devicetypes: [
      { name: "iPhone 13 Pro", identifier: "pro" },
      { name: "iPhone 13", identifier: "exact" },
    ],
  };
  assert.deepEqual(selectSimulator(runtimes, types), {
    runtime: "26.0",
    version: "26.0",
    type: "exact",
  });
  assert.throws(() =>
    selectSimulator(runtimes, { devicetypes: types.devicetypes.slice(0, 1) }),
  );
  assert.throws(() =>
    selectSimulator({ runtimes: [runtime("27.0", "iOS 27.0 Beta")] }, types),
  );
});

test("Safari capabilities distinguish desktop from simulator and never wait for load", () => {
  assert.deepEqual(capabilities().capabilities.alwaysMatch, {
    browserName: "safari",
    pageLoadStrategy: "none",
  });
  assert.equal(
    capabilities("UDID").capabilities.alwaysMatch["safari:deviceUDID"],
    "UDID",
  );
  assert.equal(
    capabilities("UDID").capabilities.alwaysMatch.platformName,
    "iOS",
  );
});

async function fakeDriver(callback, sessionErrors = [], deleteError = null) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({
      method: req.method,
      path: req.url,
      body: body ? JSON.parse(body) : null,
    });
    let value = null;
    if (req.url === "/session")
      value = sessionErrors.shift() ?? {
        sessionId: "s",
        capabilities: { browserVersion: "26" },
      };
    if (req.url.endsWith("execute/sync")) value = callback(calls);
    if (req.method === "DELETE") value = deleteError;
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ value }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

test("driver collects the final page JSON after a bounded wait and deletes the session", async () => {
  let polls = 0;
  const fake = await fakeDriver(() =>
    ++polls === 1
      ? null
      : { ok: false, phases: { connect: { error: "test" } } },
  );
  try {
    const result = await runPage(fake.url, "http://localhost:1234", "UDID", {
      timeoutMs: 1000,
      pollMs: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.phases.connect.error, "test");
    assert.equal(result.capabilities.browserVersion, "26");
    assert.equal(fake.calls.at(-1).method, "DELETE");
    assert.equal(
      fake.calls[0].body.capabilities.alwaysMatch["safari:useSimulator"],
      true,
    );
  } finally {
    await fake.close();
  }
});

test("missing page results and WebDriver errors fail and release their sessions", async () => {
  for (const value of [
    null,
    { error: "invalid session id", message: "gone" },
  ]) {
    const fake = await fakeDriver(() => value);
    try {
      await assert.rejects(
        runPage(fake.url, "http://localhost:1234", undefined, {
          timeoutMs: 20,
          pollMs: 1,
        }),
        value ? /invalid session id/ : /timeout/,
      );
      assert.equal(fake.calls.at(-1).method, "DELETE");
    } finally {
      await fake.close();
    }
  }
});

test("cold simulator session retries transient failures with a 120 second request budget", async () => {
  const fake = await fakeDriver(
    () => ({ ok: true }),
    [
      { error: "session not created", message: "cold simulator" },
      { error: "unknown error", message: "Safari not ready" },
    ],
  );
  const commands = [];
  try {
    const result = await runPage(fake.url, "http://localhost:1234", "UDID", {
      sessionRetryMs: 1,
      commands,
    });
    assert.equal(result.ok, true);
    const attempts = commands.filter((c) => c.path === "/session");
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every((c) => c.timeoutMs === 120000));
    assert.deepEqual(
      attempts.map((c) => c.ok),
      [false, false, true],
    );
  } finally {
    await fake.close();
  }
});

test("failed WebDriver requests preserve transport cause code and message", async () => {
  const commands = [];
  const cause = Object.assign(new Error("socket closed"), {
    code: "ECONNRESET",
  });
  await assert.rejects(
    request(
      "http://unused",
      "POST",
      "/session",
      {},
      {
        commands,
        fetchImpl: async () => {
          throw new TypeError("fetch failed", { cause });
        },
      },
    ),
  );
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].cause, {
    code: "ECONNRESET",
    message: "socket closed",
  });
  assert.equal(commands[0].method, "POST");
  assert.equal(commands[0].path, "/session");
});

test("session retries stop at three attempts with 5 second backoff", async () => {
  const waits = [];
  let attempts = 0;
  await assert.rejects(
    createSession("unused", "UDID", {
      requestImpl: async (_base, _method, _path, _body, options) => {
        attempts++;
        assert.equal(options.timeoutMs, 120000);
        throw Object.assign(new Error("still cold"), {
          webdriverError: "session not created",
        });
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    }),
    /still cold/,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [5000, 5000]);
});

test("session creation does not retry invalid capabilities or disabled automation", async () => {
  for (const [webdriverError, webdriverMessage] of [
    ["invalid argument", "bad capability"],
    ["session not created", "Remote Automation is turned off"],
    ["session not created", "no matching simulator"],
  ]) {
    let attempts = 0;
    await assert.rejects(
      createSession("unused", "UDID", {
        requestImpl: async () => {
          attempts++;
          throw Object.assign(new Error("terminal error"), {
            webdriverError,
            webdriverMessage,
          });
        },
        sleep: async () => {
          assert.fail("terminal failure must not back off");
        },
      }),
      /terminal error/,
    );
    assert.equal(attempts, 1);
  }
});

test("cleanup request failure is recorded without replacing the original WebDriver failure", async () => {
  const fake = await fakeDriver(
    () => ({ error: "unknown error", message: "original failure" }),
    [],
    { error: "invalid session id", message: "cleanup failure" },
  );
  const commands = [];
  try {
    await assert.rejects(
      runPage(fake.url, "http://localhost:1234", "UDID", { commands }),
      /original failure/,
    );
    const failures = commands.filter((c) => !c.ok);
    assert.equal(failures.length, 2);
    assert.match(failures[0].error, /original failure/);
    assert.match(failures[1].error, /cleanup failure/);
    assert.equal(failures[1].method, "DELETE");
  } finally {
    await fake.close();
  }
});
