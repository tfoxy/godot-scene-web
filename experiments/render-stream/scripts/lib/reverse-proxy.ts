#!/usr/bin/env -S pnpm exec tsx --conditions=development
// G8g, gate8-design.md D14: the runner-side stand-in for a product's own server in front of the
// capture's listener. The listener stays loopback-only with its token (gate2-design D13); a product
// that serves a phone on its LAN fronts the WebSocket and the resource GETs with its own server,
// which owns TLS and exposure. Receivers fetch resources on the WebSocket's own host and port
// (render-stream-2.md "resources.fetch"), so a reverse proxy that forwards both needs no wire
// change; gate 8's `g8l/proxy` leg proves it with this proxy.
//
// Unlike scripts/throttle-proxy.ts (an L4 byte pipe), this is an HTTP/1.1 reverse proxy, the shape
// of nginx's `proxy_pass` with `Upgrade` forwarding: it parses every request, rewrites `Host` to
// the upstream (as `proxy_set_header Host $proxy_host` does), adds `X-Forwarded-For`,
// `X-Forwarded-Host`, `X-Forwarded-Proto` and `Via`, forwards plain requests (GET, the CORS
// preflight's OPTIONS) through node:http's own client, and a WebSocket upgrade by replaying the
// rewritten request head on a fresh upstream socket and piping both ways after the 101. A request
// the upstream refuses is passed back as it answered. Node standard library only.
//
// CLI:
//   mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/lib/reverse-proxy.ts \
//     --target-port <port> [--target-host 127.0.0.1] [--listen-port 0] --log <requests.jsonl> \
//     [--stats-out <stats.json>]
// Prints `{"listening_port":<port>,"pid":<pid>}` as its first stdout line once bound. Every request
// is one line of --log: {t_ms, method, url, upgrade, status, bytes_out, forwarded_host}; an upgrade
// is logged at its status line (bytes_out: that first chunk). On SIGTERM
// or SIGINT it closes, writes --stats-out ({requests, upgrades, gets, options, statuses, target})
// and exits 0.

import { appendFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
} from "node:http";
import { connect, type Socket } from "node:net";

export interface ProxyLogLine {
  t_ms: number;
  method: string;
  url: string;
  upgrade: boolean;
  status: number | null;
  bytes_out: number;
  forwarded_host: string;
}

/** The headers sent upstream: Host rewritten, the forwarding headers added, hop-by-hop dropped
 * (except a WebSocket upgrade's `Connection: Upgrade` and `Upgrade`, which the upstream needs). */
export function upstreamHeaders(
  h: IncomingHttpHeaders,
  target: string,
  peer: string,
  upgrade: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  const hop = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (hop.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  out.host = target;
  out["x-forwarded-for"] = peer;
  out["x-forwarded-host"] = h.host ?? "";
  out["x-forwarded-proto"] = "http";
  out.via = "1.1 render-stream-g8g-proxy";
  if (upgrade) {
    out.connection = "Upgrade";
    out.upgrade = String(h.upgrade ?? "websocket");
  }
  return out;
}

function parseArgs(argv: string[]): {
  targetHost: string;
  targetPort: number;
  listenPort: number;
  log: string;
  statsOut: string | null;
} {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const targetPort = Number(get("--target-port"));
  const log = get("--log");
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)
    throw new Error("reverse-proxy: --target-port <port> is required");
  if (!log) throw new Error("reverse-proxy: --log <requests.jsonl> is required");
  return {
    targetHost: get("--target-host") ?? "127.0.0.1",
    targetPort,
    listenPort: Number(get("--listen-port") ?? "0"),
    log,
    statsOut: get("--stats-out") ?? null,
  };
}

export interface ProxyStats {
  target: string;
  requests: number;
  upgrades: number;
  gets: number;
  options: number;
  statuses: Record<string, number>;
}

/** The proxy itself (the CLI below and test/self-test-gate8-live.ts use it). */
export function createReverseProxy(a: { targetHost: string; targetPort: number; log: string }): {
  server: Server;
  stats: ProxyStats;
} {
  const target = `${a.targetHost}:${a.targetPort}`;
  const t0 = Date.now();
  const stats: ProxyStats = { target, requests: 0, upgrades: 0, gets: 0, options: 0, statuses: {} };
  writeFileSync(a.log, "");
  const record = (line: ProxyLogLine) => {
    stats.requests++;
    if (line.upgrade) stats.upgrades++;
    else if (line.method === "GET") stats.gets++;
    else if (line.method === "OPTIONS") stats.options++;
    const k = String(line.status ?? "none");
    stats.statuses[k] = (stats.statuses[k] ?? 0) + 1;
    appendFileSync(a.log, `${JSON.stringify(line)}\n`);
  };
  const peerOf = (req: IncomingMessage) => req.socket.remoteAddress ?? "";
  const server = createServer((req, res) => {
    const line: ProxyLogLine = {
      t_ms: Date.now() - t0,
      method: req.method ?? "",
      url: req.url ?? "",
      upgrade: false,
      status: null,
      bytes_out: 0,
      forwarded_host: req.headers.host ?? "",
    };
    const up = request(
      {
        host: a.targetHost,
        port: a.targetPort,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req.headers, target, peerOf(req), false),
      },
      (ur) => {
        line.status = ur.statusCode ?? null;
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.on("data", (c: Buffer) => {
          line.bytes_out += c.length;
        });
        ur.pipe(res);
        ur.on("end", () => record(line));
      },
    );
    up.on("error", (e) => {
      line.status = 502;
      record(line);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`reverse-proxy: upstream ${target}: ${e.message}`);
    });
    req.pipe(up);
  });

  server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const line: ProxyLogLine = {
      t_ms: Date.now() - t0,
      method: req.method ?? "",
      url: req.url ?? "",
      upgrade: true,
      status: null,
      bytes_out: 0,
      forwarded_host: req.headers.host ?? "",
    };
    const upstream = connect(a.targetPort, a.targetHost, () => {
      const headers = upstreamHeaders(req.headers, target, peerOf(req), true);
      let text = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) text += `${k}: ${v}\r\n`;
      upstream.write(`${text}\r\n`);
      if (head.length > 0) upstream.write(head);
    });
    // An upgrade is logged once, at the upstream's status line (its bytes_out: that first chunk),
    // so the log holds it even if the proxy is stopped while the connection is open.
    let logged = false;
    const log = () => {
      if (logged) return;
      logged = true;
      record(line);
    };
    upstream.on("data", (c: Buffer) => {
      if (!logged) {
        const m = /^HTTP\/1\.1 (\d{3})/.exec(c.subarray(0, 16).toString("latin1"));
        line.status = m ? Number(m[1]) : null;
        line.bytes_out = c.length;
        log();
      }
    });
    upstream.pipe(client);
    client.pipe(upstream);
    const done = () => {
      log();
      client.destroy();
      upstream.destroy();
    };
    upstream.on("close", done);
    client.on("close", done);
    upstream.on("error", done);
    client.on("error", done);
  });

  return { server, stats };
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  const { server, stats } = createReverseProxy(a);
  const stop = () => {
    server.close();
    if (a.statsOut) writeFileSync(a.statsOut, `${JSON.stringify(stats, null, 2)}\n`);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  server.listen(a.listenPort, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    process.stdout.write(`${JSON.stringify({ listening_port: port, pid: process.pid })}\n`);
  });
}

if (process.argv[1]?.endsWith("reverse-proxy.ts")) main();
