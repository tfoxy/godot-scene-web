import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { buildPage } from "./build-page.mjs";
import { serve } from "./serve.mjs";

const scratch = new URL("../../../.local/", import.meta.url);
await mkdir(scratch, { recursive: true });

test("single-file browser artifact bundles direct-peer source", async () => {
  const dir = await mkdtemp(new URL("rtc-page-test-", scratch));
  try {
    const { path, inputs } = await buildPage(join(dir, "index.html"));
    assert.ok(
      inputs.some((input) =>
        input.endsWith("packages/direct-peer/src/index.ts"),
      ),
    );
    assert.ok(
      inputs.some((input) =>
        input.endsWith("packages/direct-peer/src/helpers.ts"),
      ),
    );
    const page = await readFile(path, "utf8");
    assert.ok(page.includes("openDirectPeer("));
    assert.ok(page.includes("__rtcResult"));
    assert.ok(!page.includes("RTC_SCRIPT"));
    assert.ok(!/<script[^>]+src=/.test(page));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("static server serves the artifact and service worker; virtual URLs have no HTTP fallback", async () => {
  const dir = await mkdtemp(new URL("rtc-page-test-", scratch));
  const { path } = await buildPage(join(dir, "index.html"));
  const { server, url } = await serve(0, path);
  try {
    const page = await readFile(path, "utf8");
    assert.equal(await (await fetch(`${url}?h=example`)).text(), page);
    assert.equal(new URL(url).hostname, "127.0.0.1");
    const sw = await fetch(`${url}rtc-worker-sw.js`);
    assert.match(sw.headers.get("content-type"), /javascript/);
    assert.equal(
      await sw.text(),
      await readFile(new URL("./page/worker-sw.js", import.meta.url), "utf8"),
    );
    assert.equal((await fetch(`${url}~h/absolute?token=test`)).status, 404);
    assert.equal((await fetch(`${url}missing`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
