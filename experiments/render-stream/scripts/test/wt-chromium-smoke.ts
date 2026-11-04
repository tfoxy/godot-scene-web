// CAR3 Chromium smoke (protocol/carrier-design.md Q4, Q4.6, "Validation gaps"): the pinned
// headless Chromium (chromium-1223, the repo-private copy, lib/browser-harness.ts) opens a
// WebTransport session to the `wt` carrier of capture/build/rs_live_host, pinning its
// self-signed certificate through `serverCertificateHashes`, speaks render-stream-wt/1 from page
// script (live stream 0x00 with a /7 hello, one resource stream 0x01 with gzip accepted and
// decoded by DecompressionStream), and reads until the host shuts down. Checks: the session opens;
// the SHA-256 of every binary message the page received equals the hub tap's for that
// connection; the close arrives as `closed` = {closeCode 1000, reason "shutdown"}
// (CLOSE_WEBTRANSPORT_SESSION, Q4.5); the resource answers 200. A wrong certificate hash must make
// `ready` reject (the sabotage). CAR5's live leg reuses this shape against a capture.
//
// The page is served from http://127.0.0.1 (a secure context). Headless only (launchHarnessBrowser).
// Usage: mise exec -- pnpm exec tsx --conditions=development \
//          experiments/render-stream/scripts/test/wt-chromium-smoke.ts [--out DIR]
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { launchHarnessBrowser } from "../lib/browser-harness";

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
  receiver: "wt-chromium-smoke",
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

async function startHost(dir: string, origin: string): Promise<{ proc: ChildProcess; wtPort: number; cert: string; exited: Promise<number | null> }> {
  const proc = spawn(HOST, ["--carriers=ws,wt", `--net-module=${MODULE}`, `--tap-dir=${join(dir, "tap")}`, `--evidence-dir=${dir}`], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GRC_LIVE_ALLOWED_ORIGINS: origin }, // the page's Origin (Q4.1)
  });
  const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
  const got: Record<string, string> = {};
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("rs_live_host did not print its ports")), 15000);
    createInterface({ input: proc.stdout! }).on("line", (l) => {
      const m = /^(RS_LIVE_HOST_[A-Z0-9_]+) (\S+)$/.exec(l);
      if (m) got[m[1]] = m[2];
      if (got.RS_LIVE_HOST_WT_PORT && got.RS_LIVE_HOST_CERT_SHA256) {
        clearTimeout(t);
        res();
      }
    });
  });
  return { proc, wtPort: Number(got.RS_LIVE_HOST_WT_PORT), cert: got.RS_LIVE_HOST_CERT_SHA256, exited };
}

/** Page script: one render-stream-wt/1 session; resolves `window.__wtDone` at the session's end. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>wt smoke</title><script>
window.wtSmoke = async (url, certHex, hello, resourcePath) => {
  const value = new Uint8Array(certHex.match(/../g).map((h) => parseInt(h, 16)));
  const state = { opened: false, error: null, messages: 0, sizes: [], binary: [], texts: [], close: null, resource: null, protocol: null };
  window.__wtState = state;
  const wt = new WebTransport(url, { allowPooling: false, serverCertificateHashes: [{ algorithm: "sha-256", value }] });
  window.__wtDone = (async () => {
    try { await wt.ready; } catch (e) { state.error = "ready: " + e; return state; }
    state.opened = true;
    const live = await wt.createBidirectionalStream();
    const w = live.writable.getWriter();
    const body = new TextEncoder().encode(hello);
    const first = new Uint8Array(1 + 5 + body.length);
    first[0] = 0; first[1] = 1; new DataView(first.buffer).setUint32(2, body.length, true); first.set(body, 6);
    await w.write(first);
    const fetchRes = (async () => {
      const s = await wt.createBidirectionalStream();
      const p = new TextEncoder().encode(resourcePath);
      const req = new Uint8Array(4 + p.length + 1);
      req[0] = 1; req[1] = 1; new DataView(req.buffer).setUint16(2, p.length, true); req.set(p, 4); req[4 + p.length] = 0;
      const sw = s.writable.getWriter(); await sw.write(req); await sw.close();
      const chunks = []; const r = s.readable.getReader();
      for (;;) { const x = await r.read(); if (x.done) break; chunks.push(x.value); }
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
      const dv = new DataView(all.buffer); const status = dv.getUint16(0, true); const coding = all[2]; const len = dv.getUint32(3, true);
      let bytes = all.length - 7;
      if (status === 200 && coding === 1) {
        const ds = new Blob([all.slice(7)]).stream().pipeThrough(new DecompressionStream("gzip"));
        bytes = (await new Response(ds).arrayBuffer()).byteLength;
      }
      state.resource = { status, coding, len, bytes, framed: all.length === 7 + len };
    })().catch((e) => { state.resource = { error: String(e) }; });
    const r = live.readable.getReader();
    let buf = new Uint8Array(0);
    try {
      for (;;) {
        const x = await r.read();
        if (x.done) break;
        const n = new Uint8Array(buf.length + x.value.length); n.set(buf); n.set(x.value, buf.length); buf = n;
        let at = 0;
        while (buf.length - at >= 5) {
          const kind = buf[at]; const len = new DataView(buf.buffer, buf.byteOffset + at + 1, 4).getUint32(0, true);
          if (buf.length - at < 5 + len) break;
          const m = buf.slice(at + 5, at + 5 + len);
          if (kind === 0) state.binary.push(m); else state.texts.push(new TextDecoder().decode(m));
          state.messages++; state.sizes.push(len); at += 5 + len;
        }
        buf = buf.slice(at);
      }
    } catch (e) { state.error = "read: " + e; }
    try { const c = await wt.closed; state.close = { closeCode: c.closeCode, reason: c.reason }; }
    catch (e) { state.close = { error: String(e) }; }
    await fetchRes;
    const total = state.binary.reduce((n, b) => n + b.length, 0);
    const cat = new Uint8Array(total); let o = 0; for (const b of state.binary) { cat.set(b, o); o += b.length; }
    state.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", cat))).map((b) => b.toString(16).padStart(2, "0")).join("");
    state.binaryBytes = total; delete state.binary;
    return state;
  })();
  for (let i = 0; i < 200 && !(state.messages >= 2 || state.error); i++) await new Promise((r) => setTimeout(r, 25));
  return { opened: state.opened, messages: state.messages, error: state.error, secure: isSecureContext };
};
</script>`;

function tapSha(dir: string): string | null {
  const tap = join(dir, "tap");
  if (!existsSync(tap)) return null;
  for (const f of readdirSync(tap)) {
    const m = /^live-(\d+)\.jsonl$/.exec(f);
    if (m && readFileSync(join(tap, f), "utf8").includes('"carrier":"wt"')) {
      return createHash("sha256").update(readFileSync(join(tap, `stream-${m[1]}.rs2`))).digest("hex");
    }
  }
  return null;
}

async function main(): Promise<void> {
  const b = spawnSync("bash", [join(RS, "scripts/build-rs-net.sh"), "--no-test"], { stdio: ["ignore", "ignore", "inherit"] });
  if (b.status !== 0 || !existsSync(HOST)) throw new Error("build-rs-net.sh failed or rs_live_host is missing (build-capture.sh)");
  const server = createServer((_q, s) => {
    s.writeHead(200, { "content-type": "text/html" });
    s.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const profile = mkdtempSync(join(tmpdir(), "wt-smoke-profile-"));
  const { browser, executablePath } = await launchHarnessBrowser({ userDataDir: profile });
  console.log(`chromium ${browser.version()} (${executablePath})`);
  const report: Record<string, unknown> = { schema: "rs-wt-chromium-smoke/1", chromium: browser.version() };
  try {
    for (const leg of ["honest", "wrong-cert-hash"] as const) {
      const dir = mkdtempSync(join(tmpdir(), "wt-smoke-"));
      try {
        const host = await startHost(dir, pageUrl.replace(/\/$/, ""));
        const page = await browser.newPage();
        await page.goto(pageUrl);
        const cert = leg === "honest" ? host.cert : "0".repeat(64);
        const url = `https://127.0.0.1:${host.wtPort}/render-stream?protocol=render-stream.7`;
        const t0 = Date.now();
        const early = await page.evaluate(
          ([u, c, h, p]) => (window as unknown as { wtSmoke: (...a: string[]) => Promise<unknown> }).wtSmoke(u, c, h, p),
          [url, cert, HELLO, `/resources/sha256/${"1".repeat(64)}`],
        );
        const openMs = Date.now() - t0;
        await new Promise((r) => setTimeout(r, 500));
        host.proc.kill("SIGTERM");
        await host.exited;
        const state = (await page.evaluate(() => (window as unknown as { __wtDone: Promise<unknown> }).__wtDone)) as {
          opened: boolean;
          error: string | null;
          messages: number;
          close: { closeCode?: number; reason?: string; error?: string } | null;
          resource: { status?: number; bytes?: number; framed?: boolean; coding?: number } | null;
          sha256: string;
          binaryBytes: number;
        };
        report[leg] = { early, state, openMs };
        if (leg === "honest") {
          ok((early as { secure: boolean }).secure, "the page is a secure context (http://127.0.0.1)");
          ok(state.opened && state.error === null, `WebTransport opened with serverCertificateHashes (${state.error ?? "no error"})`);
          ok(state.messages >= 3 && state.sha256 === tapSha(dir), `page bytes == tap (${state.messages} messages, ${state.binaryBytes} bytes)`);
          ok(state.close?.closeCode === 1000 && state.close?.reason === "shutdown", `closed = ${JSON.stringify(state.close)}`);
          ok(state.resource?.status === 200 && state.resource.bytes === 1024 && state.resource.framed === true, `resource stream: ${JSON.stringify(state.resource)}`);
          console.log(`measure: session + first messages in ${openMs} ms (page.evaluate wall)`);
        } else {
          ok(!state.opened && (state.error ?? "").startsWith("ready:"), `a wrong hash fails the handshake (${state.error})`);
        }
        await page.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
  report.results = results;
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "wt-chromium-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(failed === 0 ? "wt-chromium-smoke: all passed" : `wt-chromium-smoke: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
