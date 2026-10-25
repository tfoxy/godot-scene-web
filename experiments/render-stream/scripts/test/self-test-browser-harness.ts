#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for G7h: launches the real pinned Chromium (D9) and runs every probe
// protocol/gate7-design.md's "G7h" section lists, against `lib/browser-probes/index.html` and two
// local `HarnessServer` instances (a page origin and a cross-origin "resource" origin). This is
// not a synthetic self-test over fabricated values the way `self-test-gate6.ts` is -- Q1b's
// probes are explicitly about what THIS Chromium build actually does, so this script IS the
// evidence, and it writes `evidence/probes.json` under `--out` (default a UTC-stamped directory
// under `artifacts/render-stream/`, gitignored) exactly as a real leg would.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-browser-harness.ts [--out DIR]
//
// Exits non-zero if any of G7h's four `Checks` fails, or if the sabotage case fails to refuse.
// Probes 2-6 and the suspension candidates in probe 3/4 are RECORDED findings, not pass/fail --
// a probe disagreeing with gate7-design.md's prediction is itself the point (D22, "Every browser
// statement ... is checked by G7h before any gate relies on it").

import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CDPSession, Page } from "@playwright/test";

import { compareRgbaBuffers } from "../../../../packages/test-harness/src/image-diff";
import {
  BACKGROUND_THROTTLING_ARGS,
  BROWSER_LAUNCH_ARGS,
  CI_RENDERER_ALLOWANCE,
  checkBrowserProvenance,
  EXPECTED_CHROMIUM_SHA256,
  EXPECTED_CHROMIUM_VERSION,
  HarnessServer,
  type LaunchedBrowser,
  launchHarnessBrowser,
  SABOTAGE_SWIFTSHADER_ARGS,
  SuspensionController,
} from "../lib/browser-harness";
import { decodePngRgba } from "../lib/gate-minus1-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..", "..");
const PROBES_STATIC_ROOT = join(
  EXPERIMENT_DIR,
  "scripts",
  "lib",
  "browser-probes",
);

function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv: string[]): { out: string } {
  let out = join(
    EXPERIMENT_DIR,
    "..",
    "..",
    "artifacts",
    "render-stream",
    "gate7h-probes",
    utcStamp(),
  );
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) out = resolve(argv[++i]);
  }
  return { out };
}

// --- A minimal raw WebSocket echo endpoint (RFC 6455), for probe 4's "socket stays open" leg. No
// `ws` package is a dependency of this workspace, and the handshake is ~15 lines, so this stays
// self-contained rather than adding one for a single self-test. --------------------------------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function attachWebSocketEcho(
  server: HttpServer,
  onConnection: () => void,
): void {
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (
      req.headers.upgrade?.toLowerCase() !== "websocket" ||
      typeof key !== "string"
    ) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    onConnection();
    socket.on("data", (buf) => {
      // Echo back a minimal unmasked text frame "pong" on ANY client frame -- good enough to
      // prove the socket is alive without implementing full RFC 6455 framing both ways.
      if (buf.length === 0) return;
      const payload = Buffer.from("pong");
      const frame = Buffer.concat([
        Buffer.from([0x81, payload.length]),
        payload,
      ]);
      socket.write(frame);
    });
    socket.on("error", () => {});
  });
}

interface ProbeReport {
  [key: string]: unknown;
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  await mkdir(out, { recursive: true });
  const evidenceDir = join(out, "evidence");
  await mkdir(evidenceDir, { recursive: true });

  const report: ProbeReport = {
    schema: "render-stream-gate7h-probes/1",
    generated_at: new Date().toISOString(),
    expected_chromium: {
      sha256: EXPECTED_CHROMIUM_SHA256,
      version: EXPECTED_CHROMIUM_VERSION,
    },
  };
  let anyCheckFailed = false;
  const checks: { id: string; ok: boolean; detail: string }[] = [];

  // --- Servers: page origin + a cross-origin "resource" origin for probes 5/6. ------------------
  const pageServer = new HarnessServer({
    staticRoot: PROBES_STATIC_ROOT,
    evidenceRoot: evidenceDir,
    allowedLegNonces: ["selftest"],
    role: "page",
  });
  const { origin: pageOrigin } = await pageServer.start();

  const resourceBody = randomBytes(2048);
  const resourceServer = new HarnessServer({
    staticRoot: PROBES_STATIC_ROOT, // unused for GET in resource role beyond registered resources
    evidenceRoot: evidenceDir,
    allowedLegNonces: ["selftest"],
    role: "resource",
    allowedOrigins: [pageOrigin],
  });
  resourceServer.setResource("/res/thing.bin", resourceBody);
  const { origin: resourceOrigin } = await resourceServer.start();

  // A tiny raw HTTP(+WS) server for probe 4's socket-stays-open leg, separate from the two
  // HarnessServers above (which never call `server.listen` with upgrade handling).
  let wsConnections = 0;
  const wsServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  attachWebSocketEcho(wsServer, () => {
    wsConnections++;
  });
  const wsPort = await new Promise<number>((resolveWs) => {
    wsServer.listen(0, "127.0.0.1", () => {
      const addr = wsServer.address();
      resolveWs(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  // --- Launch (D9) and load the probe page. ------------------------------------------------------
  const launchArgs = [...BROWSER_LAUNCH_ARGS, ...BACKGROUND_THROTTLING_ARGS];
  const launched: LaunchedBrowser = await launchHarnessBrowser({
    args: launchArgs,
  });
  const context = await launched.browser.newContext({
    viewport: { width: 256, height: 256 },
  });
  const consoleLines: string[] = [];
  const page: Page = await context.newPage();
  page.on("console", (msg) =>
    consoleLines.push(`[${msg.type()}] ${msg.text()}`),
  );
  page.on("pageerror", (err) =>
    consoleLines.push(`[pageerror] ${err.stack ?? err.message}`),
  );
  await page.goto(`${pageOrigin}/index.html`);
  await page.waitForFunction(() => window.__probeReady === true, undefined, {
    timeout: 15000,
  });
  const session: CDPSession = await context.newCDPSession(page);

  // Probe 1: renderer string and extensions under D9's flags.
  const glInfo = await page.evaluate(() => window.__probe?.glInfo());
  report.probe1_renderer = glInfo;

  // Probe 7: EXT_disjoint_timer_query_webgl2 availability (folded into glInfo above).
  report.probe7_timer_query_available = glInfo?.hasTimerQuery ?? false;

  // Probe 2: rAF rate when visible. Discard the first 500ms (compositor warm-up: measured
  // separately at ~2/500ms vs ~30/500ms once warm) then measure a clean window.
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__probe?.resetRafCount());
  const sampleMs = 2000;
  await page.waitForTimeout(sampleMs);
  const rafCount = (await page.evaluate(() => window.__probe?.rafCount())) ?? 0;
  report.probe2_raf_rate_hz = (rafCount * 1000) / sampleMs;
  report.probe2_raf_count = rafCount;
  report.probe2_sample_ms = sampleMs;

  // Probe 3: which Q1b mechanism hides a headless=new page, and the rAF count while hidden.
  const suspension = new SuspensionController(page, context, session);
  const hideActivate = await suspension.hideViaActivateAuxiliary();
  const hideMinimize = await suspension.hideViaMinimize();
  const hideFocus = await suspension.hideViaFocusEmulation();
  report.probe3_hide_candidates = [hideActivate, hideMinimize, hideFocus];
  report.probe3_any_candidate_hides = [
    hideActivate,
    hideMinimize,
    hideFocus,
  ].some((r) => r.visibilityStateAfter === "hidden");

  // Probe 4: Page.setWebLifecycleState("frozen") stops tasks, and the WebSocket stays open.
  const freezeResult = await suspension.freeze(1200);
  report.probe4_freeze = freezeResult;

  let wsOpenThroughFreeze = false;
  await page.evaluate(
    (port) =>
      new Promise<void>((res) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
        ws.addEventListener("open", () => {
          window.__wsProbe = ws;
          res();
        });
      }),
    wsPort,
  );
  await session.send("Page.setWebLifecycleState", { state: "frozen" });
  await new Promise((r) => setTimeout(r, 500));
  const wsStateDuringFreeze = await page.evaluate(
    () => window.__wsProbe?.readyState,
  );
  await session.send("Page.setWebLifecycleState", { state: "active" });
  wsOpenThroughFreeze = wsStateDuringFreeze === WebSocket.OPEN;
  report.probe4_ws_open_through_freeze = wsOpenThroughFreeze;
  report.probe4_ws_connections_accepted = wsConnections;

  // Probes 5 & 6: preflight caching and HTTP-cache reuse for Authorization + private/max-age GETs,
  // across a same-process reload and a fresh browser process.
  async function fetchResource(): Promise<{ status: number }> {
    return page.evaluate(
      async ({ url }) => {
        const res = await fetch(url, {
          headers: { Authorization: "Bearer deadbeef" },
        });
        return { status: res.status };
      },
      { url: `${resourceOrigin}/res/thing.bin` },
    );
  }
  // A settle delay after each fetch, before snapshotting hit counts: Chromium races a cold
  // cross-origin request over more than one speculative connection (observed here as an
  // occasional +2 instead of +1 on the very first fetch to a fresh origin), and that race's
  // losing socket can still complete server-side slightly after the client-visible fetch
  // resolves. Reading the counter immediately attributed a late-arriving speculative hit to the
  // WRONG phase in early runs of this self-test; settling first is the fix (G7h "As built").
  const settle = () => new Promise((r) => setTimeout(r, 400));

  const hitsBefore0 = resourceServer.getHits("/res/thing.bin");
  const f1 = await fetchResource(); // fetch 1: cold -- expect +1 OPTIONS, +1 GET (see note above).
  await settle();
  const hits1 = resourceServer.getHits("/res/thing.bin");
  const f2 = await fetchResource(); // fetch 2: same page, immediately after -- tests both caches warm.
  await settle();
  const hits2 = resourceServer.getHits("/res/thing.bin");
  await page.reload();
  await page.waitForFunction(() => window.__probeReady === true, undefined, {
    timeout: 15000,
  });
  const f3 = await fetchResource(); // fetch 3: same process, after reload -- preflight cache across navigation.
  await settle();
  const hits3 = resourceServer.getHits("/res/thing.bin");

  report.probe5_6_same_process = {
    fetch_statuses: { f1, f2, f3 },
    hits_before: hitsBefore0,
    hits_after_fetch1_cold: hits1,
    hits_after_fetch2_same_page: hits2,
    hits_after_fetch3_after_reload: hits3,
  };

  // A fresh browser PROCESS (new profile): a new preflight is expected (Q1b bullet 2).
  const launched2 = await launchHarnessBrowser({ args: launchArgs });
  const context2 = await launched2.browser.newContext({
    viewport: { width: 256, height: 256 },
  });
  const page2 = await context2.newPage();
  await page2.goto(`${pageOrigin}/index.html`);
  await page2.waitForFunction(() => window.__probeReady === true, undefined, {
    timeout: 15000,
  });
  const fetchResource2 = () =>
    page2.evaluate(
      async ({ url }) => {
        const res = await fetch(url, {
          headers: { Authorization: "Bearer deadbeef" },
        });
        return { status: res.status };
      },
      { url: `${resourceOrigin}/res/thing.bin` },
    );
  const f4 = await fetchResource2();
  await settle();
  const hits4 = resourceServer.getHits("/res/thing.bin");
  const f5 = await fetchResource2();
  await settle();
  const hits5 = resourceServer.getHits("/res/thing.bin");
  report.probe5_6_fresh_process = {
    fetch_statuses: { f4, f5 },
    hits_after_fetch4_new_process: hits4,
    hits_after_fetch5_same_new_process: hits5,
  };
  await launched2.browser.close();

  report.probe5_preflight_cached_within_process =
    hits2.options === hits1.options;
  report.probe5_preflight_cached_across_reload =
    hits3.options === hits1.options;
  report.probe5_new_process_repreflights = hits4.options > hits3.options;
  report.probe6_http_cache_reused_within_process = hits2.get === hits1.get;
  report.probe6_http_cache_reused_across_reload = hits3.get === hits1.get;
  report.probe6_fresh_process_misses_cache = hits4.get > hits3.get;

  // Probe 8 + check 4: draw a known flat color, read it back via WebGL, and via a CDP screenshot
  // of the composited page -- they must agree exactly on an opaque frame (`compositor-equals-
  // readback`, Q7), and the WebGL readback itself must be byte-exact at the drawn rect (the
  // "probe rect read back exactly" check).
  const drawColor = [37, 201, 99, 255] as const;
  await page.evaluate(
    ([r, g, b, a]) => window.__probe?.drawFlatColor(r, g, b, a),
    drawColor,
  );
  const rect = (await page.evaluate(() => window.__probe?.canvasRect())) ?? {
    width: 256,
    height: 256,
  };
  const readback =
    (await page.evaluate(
      ([x, y, w, h]) => window.__probe?.readPixelsRect(x, y, w, h),
      [0, 0, rect.width, rect.height] as const,
    )) ?? [];
  const readbackBuf = Uint8Array.from(readback);

  let rectExact = true;
  const sampleCoords: [number, number][] = [
    [0, 0],
    [10, 10],
    [rect.width - 1, rect.height - 1],
    [128, 64],
  ];
  for (const [x, y] of sampleCoords) {
    const idx = (y * rect.width + x) * 4;
    const px = [
      readbackBuf[idx],
      readbackBuf[idx + 1],
      readbackBuf[idx + 2],
      readbackBuf[idx + 3],
    ];
    if (px.some((v, i) => v !== drawColor[i])) rectExact = false;
  }
  checks.push({
    id: "probe-rect-exact-readback",
    ok: rectExact,
    detail: `sampled ${sampleCoords.length} px against drawn ${JSON.stringify(drawColor)}`,
  });

  const screenshotB64 = await session.send("Page.captureScreenshot", {
    format: "png",
  });
  const screenshotPath = join(
    evidenceDir,
    "selftest",
    "compositor-screenshot.png",
  );
  await mkdir(dirname(screenshotPath), { recursive: true });
  await writeFile(
    screenshotPath,
    Buffer.from((screenshotB64 as { data: string }).data, "base64"),
  );
  const decoded = await decodePngRgba(screenshotPath);
  let compositorOk = false;
  let compositorDetail = "decode failed";
  if (
    decoded &&
    decoded.width === rect.width &&
    decoded.height === rect.height
  ) {
    const cmp = await compareRgbaBuffers(readbackBuf, decoded.data, {
      width: rect.width,
      height: rect.height,
      maxChannelDelta: 1,
    });
    compositorOk = cmp.ok;
    compositorDetail = JSON.stringify(cmp);
  }
  report.probe8_compositor_equals_readback = {
    ok: compositorOk,
    detail: compositorDetail,
  };
  checks.push({
    id: "compositor-equals-readback",
    ok: compositorOk,
    detail: compositorDetail,
  });

  // Check 1: browser-provenance on the probe page.
  const provenance = await checkBrowserProvenance(page, launched, launchArgs, {
    DISPLAY: undefined,
    WAYLAND_DISPLAY: undefined,
  });
  report.check_browser_provenance = provenance;
  checks.push({
    id: "browser-provenance",
    ok: provenance.ok,
    detail: provenance.ok
      ? (provenance.renderer ?? "")
      : provenance.reasons.join("; "),
  });

  // Check 2: Wayland FD count 0 for every Chromium process.
  checks.push({
    id: "wayland-fd-zero",
    ok: provenance.totalWaylandFds === 0,
    detail: `${provenance.totalWaylandFds} Wayland fd(s) across ${provenance.processes.length} process(es)`,
  });

  // Check 3: an evidence PUT outside the leg nonce rejected.
  //
  // Finding (G7h "As built"): a `..`-escaping PUT never reaches `HarnessServer.handlePut`'s own
  // traversal guard here, because `fetch()`'s URL parser (and Node's `new URL()` on the server,
  // same WHATWG algorithm) normalizes `.`/`..` segments out of the pathname BEFORE either side
  // sees a literal `..` -- `/evidence/selftest/../../../escaped.json` arrives at the server as
  // `/escaped.json`, which matches no route and gets the generic 404, not the guard's 403. The
  // in-code guard is still kept as defense in depth for a caller that bypasses URL normalization
  // (a raw socket write), but this check asserts the SAFETY PROPERTY (the write never lands
  // outside the leg directory, whichever status code produced that outcome), not one fixed code.
  const badPutUrl = `${pageOrigin}/evidence/not-a-real-nonce/x.json`;
  const badPutRes = await page.evaluate(async (url) => {
    const res = await fetch(url, { method: "PUT", body: "{}" });
    return res.status;
  }, badPutUrl);
  const traversalPutUrl = `${pageOrigin}/evidence/selftest/../../../escaped.json`;
  const traversalPutRes = await page.evaluate(async (url) => {
    const res = await fetch(url, { method: "PUT", body: "{}" });
    return res.status;
  }, traversalPutUrl);
  const { existsSync: existsSyncCheck } = await import("node:fs");
  const escapedWritten =
    existsSyncCheck(join(out, "..", "escaped.json")) ||
    existsSyncCheck(join(evidenceDir, "..", "escaped.json"));
  checks.push({
    id: "evidence-put-outside-nonce-rejected",
    ok: badPutRes !== 200 && traversalPutRes !== 200 && !escapedWritten,
    detail: `unknown-nonce PUT -> ${badPutRes} (expect != 200), traversal PUT -> ${traversalPutRes} (expect != 200, normalized away before reaching the guard -- see comment), file escaped: ${escapedWritten}`,
  });
  // And the allowed path DOES succeed, so the rejection above is a real guard, not a broken route.
  const goodPutRes = await page.evaluate(async (url) => {
    const res = await fetch(url, { method: "PUT", body: "{}" });
    return res.status;
  }, `${pageOrigin}/evidence/selftest/ok.json`);
  checks.push({
    id: "evidence-put-allowed-nonce-accepted",
    ok: goodPutRes === 200,
    detail: `allowed-nonce PUT -> ${goodPutRes}`,
  });

  // P3-HX: a body PUT as `?part=k&of=n` pieces lands as their byte concatenation (a multi-byte
  // character cut between parts included), and a part sequence that is out of range is refused.
  const partsText = "\u00e9\u4e16\u754c-part-body-\ud83d\ude00";
  const partsRes = await page.evaluate(
    async ({ base, text }) => {
      const bytes = new TextEncoder().encode(text);
      const cuts = [0, 1, 4, bytes.length];
      const statuses: number[] = [];
      for (let k = 0; k + 1 < cuts.length; k++) {
        const r = await fetch(`${base}?part=${k}&of=${cuts.length - 1}`, {
          method: "PUT",
          body: bytes.slice(cuts[k], cuts[k + 1]),
        });
        statuses.push(r.status);
      }
      const bad = await fetch(`${base}?part=3&of=3`, {
        method: "PUT",
        body: "x",
      });
      return { statuses, bad: bad.status };
    },
    { base: `${pageOrigin}/evidence/selftest/parts.bin`, text: partsText },
  );
  const {
    readFileSync: readFileSyncParts,
    statSync: statSyncParts,
    rmSync: rmSyncParts,
  } = await import("node:fs");
  const partsBack = readFileSyncParts(
    join(evidenceDir, "selftest", "parts.bin"),
    "utf8",
  );
  checks.push({
    id: "evidence-put-parts-assembled",
    ok:
      partsBack === partsText &&
      partsRes.statuses.every((c) => c === 200) &&
      partsRes.bad === 400,
    detail: `parts -> ${partsRes.statuses.join(",")}, bad part -> ${partsRes.bad}, bytes equal: ${partsBack === partsText}`,
  });

  // P3-HX: 640 MB in 8 MB parts (more than Playwright's 512 MB pipe message, which one such PUT
  // overran with ERR_STRING_TOO_LONG at STS2 scale) completes and leaves 640 MB on disk.
  const hugeParts = 80;
  const hugeStatuses = await page.evaluate(
    async ({ base, n }) => {
      const piece = new Uint8Array(8 * 1024 * 1024).fill(0x41);
      const codes: number[] = [];
      for (let k = 0; k < n; k++) {
        const r = await fetch(`${base}?part=${k}&of=${n}`, {
          method: "PUT",
          body: piece,
        });
        codes.push(r.status);
      }
      return codes;
    },
    { base: `${pageOrigin}/evidence/selftest/huge.bin`, n: hugeParts },
  );
  const hugePath = join(evidenceDir, "selftest", "huge.bin");
  const hugeBytes = statSyncParts(hugePath).size;
  rmSyncParts(hugePath);
  checks.push({
    id: "evidence-put-640mb-in-parts",
    ok:
      hugeStatuses.length === hugeParts &&
      hugeStatuses.every((c) => c === 200) &&
      hugeBytes === hugeParts * 8 * 1024 * 1024,
    detail: `${hugeStatuses.length} parts, ${hugeBytes} bytes on disk`,
  });

  // Sabotage: --use-angle=swiftshader must make browser-provenance refuse. Under the CI-only
  // lavapipe allowance (R3, lib/browser-renderer.ts) the same SwiftShader browser is judged by the
  // lavapipe rule, which refuses it as an undeclared renderer; locally it is the NVIDIA default.
  const sabotageLaunched = await launchHarnessBrowser({
    args: [...SABOTAGE_SWIFTSHADER_ARGS],
  });
  const sabotageContext = await sabotageLaunched.browser.newContext({
    viewport: { width: 256, height: 256 },
  });
  const sabotagePage = await sabotageContext.newPage();
  await sabotagePage.goto(`${pageOrigin}/index.html`);
  await sabotagePage.waitForFunction(
    () => window.__probeReady === true,
    undefined,
    {
      timeout: 15000,
    },
  );
  const sabotageProvenance = await checkBrowserProvenance(
    sabotagePage,
    sabotageLaunched,
    SABOTAGE_SWIFTSHADER_ARGS,
    { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
    CI_RENDERER_ALLOWANCE,
  );
  report.sabotage_swiftshader = sabotageProvenance;
  checks.push({
    id: "sabotage-swiftshader-refused",
    ok: sabotageProvenance.ok === false,
    detail:
      sabotageProvenance.ok !== false
        ? "DID NOT REFUSE -- sabotage case failed to trip the guard"
        : sabotageProvenance.reasons.join("; "),
  });
  await sabotageLaunched.browser.close();

  report.console = consoleLines;
  report.checks = checks;
  anyCheckFailed = checks.some((c) => !c.ok);
  report.gate_passed = !anyCheckFailed;

  await writeFile(
    join(evidenceDir, "probes.json"),
    JSON.stringify(report, null, 2),
  );

  await launched.browser.close();
  await pageServer.stop();
  await resourceServer.stop();
  await new Promise<void>((r) => wsServer.close(() => r()));

  // Written to a file as well as the console: a long-lived Node process sharing stdio with
  // several Chromium children was observed, during this increment's own development, to lose
  // buffered console output on some runs even though the process exits 0 and `probes.json` is
  // fully and correctly written (fs writes are awaited; terminal output is not synchronized the
  // same way) -- so this summary is not solely trusted to the terminal.
  const summaryLines = [
    `Evidence written to ${join(evidenceDir, "probes.json")}`,
    "",
    ...checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.id}  ${c.detail}`),
    "",
    `raf rate when visible: ${report.probe2_raf_rate_hz} Hz`,
    `hide candidates took effect: ${JSON.stringify(report.probe3_any_candidate_hides)}`,
    `frozen stopped tasks: ${!(freezeResult.tookEffect === false)}`,
    "",
    anyCheckFailed
      ? "G7h self-test FAILED: one or more checks did not pass."
      : "G7h self-test PASSED.",
  ];
  const summaryText = summaryLines.join("\n");
  await writeFile(join(evidenceDir, "selftest", "summary.txt"), summaryText);
  console.log(summaryText);

  if (anyCheckFailed) {
    process.exitCode = 1;
  }
}

declare global {
  interface Window {
    __probeReady?: boolean;
    __wsProbe?: WebSocket;
  }
}

main().catch((err) => {
  console.error(err);
  // exit now: a launched Chromium and the servers keep the event loop alive, so setting exitCode
  // alone hung the runner until its timeout (R3 run 39791880071, a probe page with no WebGL2)
  process.exit(1);
});
