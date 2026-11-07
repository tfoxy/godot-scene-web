#!/usr/bin/env -S pnpm exec tsx --conditions=development
// wss in the pinned Chromium: the browser proof beside the
// Node legs of self-test-wss.ts. A throwaway test CA and leaf (scripts/lib/test-pki.ts) serve
// rs_live_host's `ws` carrier as ws+wss on one port; the repo-private pinned Chromium, headless,
// trusts that leaf only through --ignore-certificate-errors-spki-list=<its SPKI hash>. The page is
// http://127.0.0.1:<p>/, named in GRC_LIVE_ALLOWED_ORIGINS.
//
// Checks: a `wss://127.0.0.1:<port>` /7 session whose bytes equal its hub tap and that closes
// {1000, "shutdown"}; a `ws://` session from the same page on the same port, same bytes count; an
// https `fetch` of the host's resource (CORS from the allowed origin) is 200 with 1024 bytes; and,
// in a second browser without the SPKI flag, the wss connection fails (the certificate is what
// the page trusts, and plaintext is not what it got).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/wss-chromium-smoke.ts [--out DIR]
// Not a pure self-test (it launches Chromium). Needs build-capture.sh; builds the net module.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  BACKGROUND_THROTTLING_ARGS,
  BROWSER_LAUNCH_ARGS,
  launchHarnessBrowser,
} from "../lib/browser-harness";
import { makeTestPki } from "../lib/test-pki";

const RS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = join(RS, "capture/build/rs_live_host");
const MODULE = join(RS, "capture/build/librender_stream_net.so");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? resolve(process.argv[outArg + 1]) : null;

let failed = 0;
const results: { check: string; ok: boolean }[] = [];
function ok(cond: boolean, what: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  results.push({ check: what, ok: cond });
  if (!cond) failed++;
}

const HELLO = JSON.stringify({
  type: "hello",
  protocol: "render-stream/7",
  receiver: "wss-chromium-smoke",
  receiver_kind: "gsw-canvas",
  credit_stage: "submitted",
  credit_window: 1,
  inbound_buffer_bytes: 16777216,
  token: null,
  manifest_sha256: null,
  presentation_backing_w: 640,
  presentation_backing_h: 360,
  presentation_css_w: 640,
  presentation_css_h: 360,
  dpr_milli: 1000,
});

const PAGE = `<!doctype html><meta charset="utf-8"><title>wss smoke</title><script>
window.wsSmoke = (url, hello) => new Promise((done) => {
  const st = { url, opened: false, error: null, messages: 0, bytes: [], close: null, openMs: null };
  const t0 = performance.now();
  let ws;
  try { ws = new WebSocket(url, "render-stream.7"); } catch (e) { st.error = String(e); done(st); return; }
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { st.opened = true; st.openMs = performance.now() - t0; ws.send(hello); };
  ws.onmessage = (e) => { if (typeof e.data !== "string") { st.messages++; st.bytes.push(new Uint8Array(e.data)); } };
  ws.onerror = () => { st.error = st.error || "error"; };
  ws.onclose = async (e) => {
    st.close = { code: e.code, reason: e.reason };
    const total = st.bytes.reduce((n, b) => n + b.length, 0);
    const all = new Uint8Array(total);
    let o = 0;
    for (const b of st.bytes) { all.set(b, o); o += b.length; }
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
    st.sha256 = Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
    st.total = total;
    delete st.bytes;
    done(st);
  };
});
window.fetchSmoke = async (url) => {
  try {
    const r = await fetch(url, { cache: "no-store" });
    const b = new Uint8Array(await r.arrayBuffer());
    let exact = b.length === 1024;
    for (let i = 0; exact && i < b.length; i++) exact = b[i] === i % 251;
    return { status: r.status, bytes: b.length, exact };
  } catch (e) { return { error: String(e) }; }
};
</script>`;

async function startHost(
  dir: string,
  env: Record<string, string>,
): Promise<{
  proc: ChildProcess;
  port: number;
  exited: Promise<number | null>;
}> {
  const proc = spawn(
    HOST,
    [
      `--net-module=${MODULE}`,
      `--tap-dir=${join(dir, "tap")}`,
      `--evidence-dir=${dir}`,
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...env },
    },
  );
  const exited = new Promise<number | null>((r) =>
    proc.on("exit", (c) => r(c)),
  );
  const port = await new Promise<number>((res, rej) => {
    const t = setTimeout(
      () => rej(new Error("rs_live_host did not print its port")),
      15000,
    );
    createInterface({ input: proc.stdout! }).on("line", (l) => {
      const m = /^RS_LIVE_HOST_PORT (\d+)$/.exec(l);
      if (m) {
        clearTimeout(t);
        res(Number(m[1]));
      }
    });
    proc.on("exit", (c) => rej(new Error(`rs_live_host exited ${c}`)));
  });
  return { proc, port, exited };
}

function tapShas(dir: string): string[] {
  const tap = join(dir, "tap");
  if (!existsSync(tap)) return [];
  return readdirSync(tap)
    .filter((f) => /^stream-\d+\.rs2$/.test(f))
    .map((f) =>
      createHash("sha256")
        .update(readFileSync(join(tap, f)))
        .digest("hex"),
    );
}

interface WsState {
  opened: boolean;
  error: string | null;
  messages: number;
  close: { code: number; reason: string } | null;
  sha256: string;
  total: number;
  openMs: number | null;
}

async function main(): Promise<void> {
  const b = spawnSync(
    "bash",
    [join(RS, "scripts/build-rs-net.sh"), "--no-test"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (b.status !== 0 || !existsSync(HOST))
    throw new Error(
      "build-rs-net.sh failed or rs_live_host is missing (build-capture.sh)",
    );
  const pki = makeTestPki();
  const server = createServer((_q, s) => {
    s.writeHead(200, { "content-type": "text/html" });
    s.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const report: Record<string, unknown> = { schema: "rs-wss-chromium-smoke/1" };
  const dir = mkdtempSync(join(tmpdir(), "wss-smoke-"));
  const profiles: string[] = [];
  const launch = async (trust: boolean) => {
    const profile = mkdtempSync(join(tmpdir(), "wss-smoke-profile-"));
    profiles.push(profile);
    const args = [...BROWSER_LAUNCH_ARGS, ...BACKGROUND_THROTTLING_ARGS];
    if (trust)
      args.push(
        `--ignore-certificate-errors-spki-list=${pki.spkiSha256Base64}`,
      );
    return (await launchHarnessBrowser({ userDataDir: profile, args })).browser;
  };
  try {
    const host = await startHost(dir, {
      GRC_LIVE_TLS_CERT: pki.cert,
      GRC_LIVE_TLS_KEY: pki.key,
      GRC_LIVE_ALLOWED_ORIGINS: pageUrl.replace(/\/$/, ""),
    });
    const trusting = await launch(true);
    const plain = await launch(false);
    report.chromium = trusting.version();
    console.log(
      `chromium ${trusting.version()}, rs_live_host ws+wss on ${host.port}`,
    );
    try {
      const page = await trusting.newPage();
      await page.goto(pageUrl);
      const untrustingPage = await plain.newPage();
      await untrustingPage.goto(pageUrl);
      const run = (p: typeof page, url: string) =>
        p.evaluate(
          ([u, h]) =>
            (
              window as unknown as {
                wsSmoke: (u: string, h: string) => Promise<WsState>;
              }
            ).wsSmoke(u, h),
          [url, HELLO],
        );
      const wss = run(page, `wss://127.0.0.1:${host.port}/render-stream`);
      const ws = run(page, `ws://127.0.0.1:${host.port}/render-stream`);
      const refusedWss = await run(
        untrustingPage,
        `wss://127.0.0.1:${host.port}/render-stream`,
      );
      const fetched = await page.evaluate(
        (u) =>
          (
            window as unknown as { fetchSmoke: (u: string) => Promise<unknown> }
          ).fetchSmoke(u),
        `https://127.0.0.1:${host.port}/resources/sha256/${"1".repeat(64)}`,
      );
      await new Promise((r) => setTimeout(r, 1200));
      host.proc.kill("SIGTERM");
      const [s, p, code] = await Promise.all([wss, ws, host.exited]);
      report.wss = s;
      report.ws = p;
      report.untrusted = refusedWss;
      report.fetch = fetched;
      const shas = tapShas(dir);
      ok(code === 0, `rs_live_host exited 0 (${code})`);
      ok(
        s.opened && s.messages >= 3 && shas.includes(s.sha256),
        `wss session: ${s.messages} messages, ${s.total} bytes == its tap (opened in ${s.openMs?.toFixed(1)} ms)`,
      );
      ok(
        s.close?.code === 1000 && s.close.reason === "shutdown",
        `wss closed ${JSON.stringify(s.close)}`,
      );
      ok(
        p.opened && p.messages === s.messages && shas.includes(p.sha256),
        `ws session from the same page and port: ${p.messages} messages == its tap`,
      );
      const f = fetched as {
        status?: number;
        bytes?: number;
        exact?: boolean;
        error?: string;
      };
      ok(
        f.status === 200 && f.exact === true,
        `https fetch of the resource (CORS): ${JSON.stringify(f)}`,
      );
      ok(
        !refusedWss.opened,
        `without the SPKI flag the wss connection fails (${JSON.stringify(refusedWss.close)})`,
      );
    } finally {
      await trusting.close();
      await plain.close();
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(pki.dir, { recursive: true, force: true });
    for (const p of profiles) rmSync(p, { recursive: true, force: true });
  }
  report.results = results;
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, "wss-chromium-smoke.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  console.log(
    failed === 0
      ? "wss-chromium-smoke: all passed"
      : `wss-chromium-smoke: ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
