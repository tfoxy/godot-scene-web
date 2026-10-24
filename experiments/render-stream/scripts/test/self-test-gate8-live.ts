#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for G8g's pieces that need no engine or browser: lib/reverse-proxy.ts (D14's proxy),
// lib/gate8-live-checks.ts (g8l) on missing evidence, and lib/gate7-gsw-g8.ts's band regions, each
// with a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-live.ts
//
// 1. upstreamHeaders: Host rewritten to the upstream, X-Forwarded-* and Via added, hop-by-hop
//    headers dropped, a WebSocket upgrade's Connection/Upgrade kept (and only then).
// 2. createReverseProxy against an in-process upstream on 127.0.0.1: a GET is forwarded with the
//    rewritten Host and logged 200; an upgrade gets the upstream's 101 and its bytes both ways and
//    is logged 101; a dead upstream answers 502.
// 3. runG8l on an empty run: every g8l check fails with "evidence missing" or a problem, none passes.
// 4. gate8BandRegions: g8t's legs get rows B, C and D of all 7 columns (undecided), g8f's the two
//    float-gain strips (excluded), every other gate 8 leg none.
//
// Exits non-zero if any assertion fails.

import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gate8BandRegions } from "../lib/gate7-gsw-g8";
import { runG8l } from "../lib/gate8-live-checks";
import { createReverseProxy, type ProxyLogLine, upstreamHeaders } from "../lib/reverse-proxy";

let assertions = 0;
let failures = 0;
let last = "start";
// A hung socket fails the test instead of the run (the proxy cases are network round trips).
setTimeout(() => {
  console.error(`FAIL timed out after "${last}"`);
  process.exit(1);
}, 30000).unref();
function assert(condition: boolean, what: string): void {
  assertions++;
  last = what;
  if (!condition) {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

const listen = (s: { listen: (p: number, h: string, cb: () => void) => unknown; address: () => unknown }) =>
  new Promise<number>((done) => {
    s.listen(0, "127.0.0.1", () => {
      const a = s.address() as { port: number };
      done(a.port);
    });
  });

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, connection: "keep-alive" } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => {
        body += c.toString();
      });
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    r.on("error", fail);
    r.end();
  });
}

async function main(): Promise<void> {
  // 1.
  {
    const h = upstreamHeaders(
      { host: "proxy:1", connection: "keep-alive", "keep-alive": "5", origin: "http://page", accept: "*/*" },
      "127.0.0.1:9",
      "10.0.0.2",
      false,
    );
    assert(h.host === "127.0.0.1:9", "Host is the upstream");
    assert(h["x-forwarded-host"] === "proxy:1" && h["x-forwarded-for"] === "10.0.0.2", "X-Forwarded-* added");
    assert(h.origin === "http://page" && h.accept === "*/*", "end-to-end headers kept");
    assert(h.connection === undefined && h["keep-alive"] === undefined, "hop-by-hop headers dropped");
    const u = upstreamHeaders({ host: "p", connection: "Upgrade", upgrade: "websocket" }, "u:2", "x", true);
    assert(u.connection === "Upgrade" && u.upgrade === "websocket", "an upgrade keeps Connection/Upgrade");
  }

  // 2.
  {
    const seen: string[] = [];
    const upstream = createServer((req, res) => {
      seen.push(String(req.headers.host));
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`ok ${req.url}`);
    });
    upstream.on("upgrade", (req, socket) => {
      seen.push(`upgrade ${req.headers.host} ${req.headers.upgrade}`);
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.on("data", (c: Buffer) => socket.write(Buffer.concat([Buffer.from("echo:"), c])));
    });
    const upPort = await listen(upstream);
    const log = join(mkdtempSync(join(tmpdir(), "g8g-proxy-")), "requests.jsonl");
    const { server, stats } = createReverseProxy({ targetHost: "127.0.0.1", targetPort: upPort, log });
    const port = await listen(server);
    const r = await get(port, "/resources/sha256/abc");
    assert(r.status === 200 && r.body === "ok /resources/sha256/abc", "a GET is forwarded");
    assert(seen[0] === `127.0.0.1:${upPort}`, "the upstream sees its own Host");
    const echoed = await new Promise<string>((done) => {
      const s = connect(port, "127.0.0.1", () => {
        s.write(
          "GET /render-stream HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: x\r\n\r\n",
        );
      });
      let buf = "";
      let sent = false;
      s.on("data", (c: Buffer) => {
        buf += c.toString("latin1");
        if (!sent && buf.includes("\r\n\r\n")) {
          sent = true;
          s.write("frame");
        }
        if (buf.includes("echo:frame")) {
          s.destroy();
          done(buf);
        }
      });
    });
    assert(echoed.startsWith("HTTP/1.1 101"), "the upgrade gets the upstream's 101");
    assert(seen.includes(`upgrade 127.0.0.1:${upPort} websocket`), "the upstream sees the upgrade with its own Host");
    await new Promise((d) => setTimeout(d, 100));
    const lines = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ProxyLogLine);
    assert(lines.some((l) => !l.upgrade && l.method === "GET" && l.status === 200), "the GET is logged 200");
    assert(lines.some((l) => l.upgrade && l.status === 101), "the upgrade is logged 101");
    assert(stats.gets === 1 && stats.upgrades === 1, "stats count one GET and one upgrade");
    upstream.close();
    upstream.closeAllConnections();
    await new Promise((d) => setTimeout(d, 50));
    const dead = await get(port, "/x");
    assert(dead.status === 502, "a dead upstream answers 502");
    server.close();
    server.closeAllConnections();
  }

  // 3.
  {
    const empty = mkdtempSync(join(tmpdir(), "g8g-empty-"));
    const { checks } = await runG8l(empty);
    assert(checks.length >= 6 * 4 + 1, `every g8l check reported (${checks.length})`);
    assert(checks.every((c) => !c.passed), "none passes on an empty run");
    assert(checks.some((c) => c.id === "g8l-proxy-fronted"), "the proxy check is reported");
  }

  // 4.
  {
    const tex = gate8BandRegions("receiver");
    assert(tex.length === 21 && tex.every((r) => r.class === "undecided"), "g8t: rows B, C and D of 7 columns");
    assert(gate8BandRegions("sabotage-perturb-decode/receiver").length === 21, "g8t's sabotage leg too");
    const fl = gate8BandRegions("g8f/receiver");
    assert(fl.length === 2 && fl.every((r) => r.class === "excluded"), "g8f: the two gain strips, excluded");
    assert(gate8BandRegions("g8a/late/receiver").length === 0, "g8a: no region");
    assert(gate8BandRegions("g8m/late/receiver-patch").length === 0, "g8m: no region");
  }

  console.log(`\nself-test-gate8-live: ${assertions - failures}/${assertions} assertions passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
