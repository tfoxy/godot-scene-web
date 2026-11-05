#!/usr/bin/env -S pnpm exec tsx --conditions=development
// wss on the built-in `ws` carrier (protocol/carrier-design.md D11, D12, CAR4), a pure self-test:
// no Godot, no browser. It builds the net module (scripts/build-rs-net.sh --no-test; a no-op when
// fresh), makes a throwaway test CA and leaf with the `openssl` CLI (scripts/lib/test-pki.ts), and
//
//   1. runs capture/build/rs_ws_test --tls-only --require-tls: the C++ wss cases against the real
//      module (handshake, upgrade and frames over TLS, https GETs with ETag/304 and zstd/gzip,
//      plaintext from loopback on the same port, tls-required off loopback, bad records, a bad
//      pair), which ctest skips when the module is not built yet;
//   2. refusals through rs_live_host (as entry.cpp): a key that is not the certificate's, a
//      half-set pair, a missing module -> exit 2 with `tls-config-invalid` / `net-module-missing`;
//   3. one rs_live_host with the pair and a token on 127.0.0.1: a Node `https` + `wss` client
//      (raw upgrade over node:https, the test CA as its only trust anchor) runs a /7 session
//      whose received bytes equal its hub tap; a plaintext `ws://` session from loopback on the
//      same port does too, with the same message count and close; https resource GETs give 200,
//      401 without the token and 304 for the ETag; live-carriers.json says ws tls `consumer` with
//      the leaf's SHA-256; the TLS stats line counts the sniff's decisions;
//   4. with a non-loopback IPv4 (else `unavailable`), rs_live_host on 0.0.0.0 under
//      GRC_LIVE_EXPOSE=lan: plaintext through the LAN address is 403 `tls-required` and closed
//      (the CAR4 sabotage row), wss through it equals its tap; then again with
//      GRC_LIVE_LAN_PLAINTEXT=allow (D12): plaintext GET and a ws session through the LAN address
//      are served (the session equals its tap), wss still is, the stats count `plaintext_lan` and
//      live-carriers.json says ws `lan_plaintext: true` (false in the first run). Refusal rows:
//      a value other than `allow`, and `allow` without GRC_LIVE_EXPOSE=lan, are
//      `lan-plaintext-invalid`.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-wss.ts [--keep]
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { connect as netConnect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { makeTestPki, type TestPki } from "../lib/test-pki";

const RS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = join(RS, "capture/build/rs_live_host");
const WS_TEST = join(RS, "capture/build/rs_ws_test");
const MODULE = join(RS, "capture/build/librender_stream_net.so");
const HASH = "1".repeat(64);
const TOKEN = "cd".repeat(32);
const ORIGIN = "https://lan.example:5173";
const keep = process.argv.includes("--keep");

let failed = 0;
function ok(cond: boolean, what: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
}

function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("127."))
        return a.address;
  return null;
}

function hello7(token: string | null): string {
  return JSON.stringify({
    type: "hello",
    protocol: "render-stream/7",
    receiver: "wss-test",
    receiver_kind: "gsw-canvas",
    credit_stage: "submitted",
    credit_window: 1,
    inbound_buffer_bytes: 16777216,
    token,
    manifest_sha256: null,
    presentation_backing_w: 640,
    presentation_backing_h: 360,
    presentation_css_w: 640,
    presentation_css_h: 360,
    dpr_milli: 1000,
  });
}

function cleanEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("GRC_")) delete e[k];
  return e;
}

interface Host {
  proc: ChildProcess;
  port: number;
  tlsSha: string;
  stdout: string[];
  exited: Promise<number | null>;
}

async function startHost(
  dir: string,
  env: Record<string, string>,
  args: string[],
): Promise<Host> {
  const proc = spawn(
    HOST,
    [
      ...args,
      `--net-module=${MODULE}`,
      `--tap-dir=${join(dir, "tap")}`,
      `--evidence-dir=${dir}`,
    ],
    { env: { ...cleanEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((r) =>
    proc.on("exit", (c) => r(c)),
  );
  const stdout: string[] = [];
  const got: Record<string, string> = {};
  proc.stderr!.on("data", () => {});
  await new Promise<void>((res, rej) => {
    const t = setTimeout(
      () => rej(new Error("rs_live_host did not print its port")),
      15000,
    );
    createInterface({ input: proc.stdout! }).on("line", (l) => {
      stdout.push(l);
      const m = /^(RS_LIVE_HOST_[A-Z0-9_]+) (\S+)$/.exec(l);
      if (m) got[m[1]] = m[2];
      if (got.RS_LIVE_HOST_PORT && got.RS_LIVE_HOST_TLS_SHA256) {
        clearTimeout(t);
        res();
      }
    });
    proc.on("exit", (c) =>
      rej(new Error(`rs_live_host exited ${c} before listening`)),
    );
  });
  return {
    proc,
    port: Number(got.RS_LIVE_HOST_PORT),
    tlsSha: got.RS_LIVE_HOST_TLS_SHA256,
    stdout,
    exited,
  };
}

async function refused(
  env: Record<string, string>,
  args: string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(HOST, args, {
      env: { ...cleanEnv(), ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    p.stderr!.on("data", (d) => {
      stderr += String(d);
    });
    const t = setTimeout(() => p.kill("SIGKILL"), 8000);
    p.on("exit", (code) => {
      clearTimeout(t);
      res({ code, stderr });
    });
  });
}

interface WsResult {
  messages: Buffer[];
  texts: string[];
  close: { code: number; reason: string } | null;
  status: number;
  alpn: string | false;
  protocol: string | null;
}

/** A client frame: FIN, masked (RFC 6455 5.3). */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const len = payload.length;
  const head =
    len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : Buffer.alloc(4);
  if (len >= 126) {
    if (len > 0xffff) throw new Error("test frames stay under 64 KiB");
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  }
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/** Feeds server frames from `socket` (after the upgrade's `head`) until the server closes. */
function runFrames(
  socket: TLSSocket | import("node:net").Socket,
  head: Buffer,
  out: WsResult,
  done: () => void,
): void {
  let buf = head;
  const pump = () => {
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (op === 0x2) out.messages.push(Buffer.from(payload));
      else if (op === 0x1) out.texts.push(payload.toString("utf8"));
      else if (op === 0x9) socket.write(clientFrame(0xa, Buffer.from(payload)));
      else if (op === 0x8) {
        out.close = {
          code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
          reason: payload.subarray(2).toString(),
        };
        socket.write(clientFrame(0x8, Buffer.from(payload.subarray(0, 2))));
      }
    }
  };
  socket.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    pump();
  });
  socket.on("close", done);
  socket.on("error", () => {});
  pump();
}

/** A /7 session over wss through node:https (an upgrade request; the test CA as trust anchor). */
function wssSession(
  host: string,
  port: number,
  pki: TestPki,
  token: string | null,
): { opened: Promise<void>; done: Promise<WsResult> } {
  const out: WsResult = {
    messages: [],
    texts: [],
    close: null,
    status: 0,
    alpn: false,
    protocol: null,
  };
  let resolveOpen: () => void = () => {};
  const opened = new Promise<void>((r) => {
    resolveOpen = r;
  });
  const done = new Promise<WsResult>((res) => {
    // ALPNProtocols is a tls.connect option node:https passes through (absent from its typings).
    const r = httpsRequest({
      host,
      port,
      servername: "localhost",
      ca: readFileSync(pki.ca),
      path: "/render-stream",
      method: "GET",
      ALPNProtocols: ["http/1.1"],
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Protocol": "render-stream.7",
      },
    } as RequestOptions);
    r.on("upgrade", (resp, socket, head) => {
      const tls = socket as TLSSocket;
      out.status = resp.statusCode ?? 0;
      out.alpn = tls.alpnProtocol ?? false;
      out.protocol = tls.getProtocol();
      tls.write(clientFrame(0x1, Buffer.from(hello7(token))));
      resolveOpen();
      runFrames(tls, head, out, () => res(out));
    });
    r.on("response", (resp) => {
      out.status = resp.statusCode ?? 0;
      resp.resume();
      resolveOpen();
      res(out);
    });
    r.on("error", (e) => {
      out.texts.push(`error: ${e.message}`);
      resolveOpen();
      res(out);
    });
    r.end();
  });
  return { opened, done };
}

/** The same /7 session over plain ws (a raw upgrade on node:net). */
function wsSession(
  host: string,
  port: number,
  token: string | null,
): { opened: Promise<void>; done: Promise<WsResult> } {
  const out: WsResult = {
    messages: [],
    texts: [],
    close: null,
    status: 0,
    alpn: false,
    protocol: null,
  };
  let resolveOpen: () => void = () => {};
  const opened = new Promise<void>((r) => {
    resolveOpen = r;
  });
  const done = new Promise<WsResult>((res) => {
    const s = netConnect(port, host, () => {
      s.write(
        "GET /render-stream HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
          "Sec-WebSocket-Protocol: render-stream.7\r\n\r\n",
      );
    });
    let head = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      out.status = Number(head.subarray(9, 12).toString());
      if (out.status !== 101) {
        s.destroy();
        resolveOpen();
        res(out);
        return;
      }
      s.write(clientFrame(0x1, Buffer.from(hello7(token))));
      resolveOpen();
      runFrames(s, head.subarray(end + 4), out, () => res(out));
    };
    s.on("data", onData);
    s.on("error", () => {
      resolveOpen();
      res(out);
    });
  });
  return { opened, done };
}

interface Got {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  error?: string;
}

function httpsGet(
  host: string,
  port: number,
  path: string,
  pki: TestPki,
  headers: Record<string, string>,
): Promise<Got> {
  return new Promise((res) => {
    const r = httpsRequest(
      {
        host,
        port,
        path,
        servername: "localhost",
        ca: readFileSync(pki.ca),
        headers,
        agent: false,
      },
      (resp) => {
        const chunks: Buffer[] = [];
        resp.on("data", (c: Buffer) => chunks.push(c));
        resp.on("end", () =>
          res({
            status: resp.statusCode ?? 0,
            headers: resp.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    r.on("error", (e) =>
      res({ status: 0, headers: {}, body: Buffer.alloc(0), error: e.message }),
    );
    r.end();
  });
}

/** Plaintext bytes in, everything the server answers until it closes. */
function rawPlain(
  host: string,
  port: number,
  data: string,
): Promise<{ text: string; closed: boolean }> {
  return new Promise((res) => {
    const s = netConnect(port, host, () => s.write(data));
    let text = "";
    s.on("data", (d) => {
      text += String(d);
    });
    const t = setTimeout(() => {
      s.destroy();
      res({ text, closed: false });
    }, 4000);
    s.on("close", () => {
      clearTimeout(t);
      res({ text, closed: true });
    });
    s.on("error", () => {});
  });
}

/** The tap bytes of each connection, per tap/live-<n>.jsonl `open` lines. */
function taps(dir: string): Buffer[] {
  const out: Buffer[] = [];
  const tap = join(dir, "tap");
  if (!existsSync(tap)) return out;
  for (const f of readdirSync(tap).sort()) {
    const m = /^live-(\d+)\.jsonl$/.exec(f);
    if (!m) continue;
    const s = join(tap, `stream-${m[1]}.rs2`);
    out.push(existsSync(s) ? readFileSync(s) : Buffer.alloc(0));
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tlsStats(host: Host): Record<string, number> {
  const line =
    host.stdout.find((l) => l.startsWith("RS_LIVE_HOST_TLS_STATS ")) ?? "";
  const out: Record<string, number> = {};
  for (const kv of line.split(" ").slice(1)) {
    const [k, v] = kv.split("=");
    out[k] = Number(v);
  }
  return out;
}

function wsCarrier(dir: string): {
  tls?: string;
  cert_sha256?: string | null;
  lan_plaintext?: boolean | null;
} {
  const p = join(dir, "live-carriers.json");
  if (!existsSync(p)) return {};
  const j = JSON.parse(readFileSync(p, "utf8")) as {
    carriers: {
      name: string;
      tls: string;
      cert_sha256: string | null;
      lan_plaintext: boolean | null;
    }[];
  };
  return j.carriers.find((c) => c.name === "ws") ?? {};
}

async function refusals(pki: TestPki): Promise<void> {
  const rows: {
    what: string;
    env: Record<string, string>;
    args: string[];
    reason: string;
  }[] = [
    {
      what: "a key that is not the certificate's",
      env: { GRC_LIVE_TLS_CERT: pki.cert, GRC_LIVE_TLS_KEY: pki.otherKey },
      args: [`--net-module=${MODULE}`],
      reason: "tls-config-invalid",
    },
    {
      what: "a certificate without a key",
      env: { GRC_LIVE_TLS_CERT: pki.cert },
      args: [`--net-module=${MODULE}`],
      reason: "tls-config-invalid",
    },
    {
      what: "an unreadable certificate",
      env: {
        GRC_LIVE_TLS_CERT: join(pki.dir, "missing.pem"),
        GRC_LIVE_TLS_KEY: pki.key,
      },
      args: [`--net-module=${MODULE}`],
      reason: "tls-config-invalid",
    },
    {
      what: "no module",
      env: { GRC_LIVE_TLS_CERT: pki.cert, GRC_LIVE_TLS_KEY: pki.key },
      args: ["--net-module=/nonexistent/librender_stream_net.so"],
      reason: "net-module-missing",
    },
    {
      what: "GRC_LIVE_LAN_PLAINTEXT other than allow",
      env: {
        GRC_LIVE_EXPOSE: "lan",
        GRC_LIVE_LISTEN: "0.0.0.0:0",
        GRC_LIVE_ALLOWED_ORIGINS: ORIGIN,
        GRC_LIVE_LAN_PLAINTEXT: "yes",
      },
      args: [`--token=${TOKEN}`],
      reason: "lan-plaintext-invalid",
    },
    {
      what: "GRC_LIVE_LAN_PLAINTEXT=allow without GRC_LIVE_EXPOSE=lan",
      env: { GRC_LIVE_LAN_PLAINTEXT: "allow" },
      args: [],
      reason: "lan-plaintext-invalid",
    },
  ];
  for (const r of rows) {
    const run = await refused(r.env, r.args);
    ok(
      run.code === 2 && run.stderr.includes(r.reason),
      `refused ${r.reason}: ${r.what} (exit ${run.code}, ${run.stderr.trim().split("\n").pop()})`,
    );
  }
}

async function loopback(pki: TestPki): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wss-loop-"));
  try {
    const host = await startHost(
      dir,
      { GRC_LIVE_TLS_CERT: pki.cert, GRC_LIVE_TLS_KEY: pki.key },
      [`--token=${TOKEN}`],
    );
    ok(
      host.port > 0 && host.tlsSha === pki.leafSha256,
      `ws+wss on 127.0.0.1:${host.port}, the leaf's SHA-256 reported`,
    );
    const t0 = performance.now();
    const secure = wssSession("127.0.0.1", host.port, pki, TOKEN);
    await secure.opened;
    const openMs = performance.now() - t0;
    const plain = wsSession("127.0.0.1", host.port, TOKEN);
    await plain.opened;
    const path = `/resources/sha256/${HASH}`;
    const g200 = await httpsGet("127.0.0.1", host.port, path, pki, {
      Authorization: `Bearer ${TOKEN}`,
    });
    ok(
      g200.status === 200 &&
        g200.body.length === 1024 &&
        g200.body.every((b, i) => b === i % 251),
      `https GET -> 200, 1024 bytes byte-exact (${g200.status} ${g200.error ?? ""})`,
    );
    ok(g200.headers.etag === `"${HASH}"`, `https ETag ${g200.headers.etag}`);
    const g304 = await httpsGet("127.0.0.1", host.port, path, pki, {
      Authorization: `Bearer ${TOKEN}`,
      "If-None-Match": `"${HASH}"`,
    });
    ok(
      g304.status === 304 && g304.body.length === 0,
      `https If-None-Match -> 304 (${g304.status})`,
    );
    const g401 = await httpsGet("127.0.0.1", host.port, path, pki, {});
    ok(
      g401.status === 401,
      `https GET without the token -> 401 (${g401.status})`,
    );
    const untrusted = await new Promise<string>((res) => {
      const s = tlsConnect(
        { host: "127.0.0.1", port: host.port, servername: "localhost" },
        () => {
          s.destroy();
          res("trusted");
        },
      );
      s.on("error", (e) => res(e.message));
    });
    ok(
      untrusted !== "trusted",
      `a client without the test CA refuses the certificate (${untrusted})`,
    );
    // Handshake cost from a Node client: connect + TLS 1.3 handshake, mean of 50.
    const n = 50;
    const h0 = performance.now();
    for (let i = 0; i < n; i++) {
      await new Promise<void>((res, rej) => {
        const s = tlsConnect(
          {
            host: "127.0.0.1",
            port: host.port,
            servername: "localhost",
            ca: readFileSync(pki.ca),
            ALPNProtocols: ["http/1.1"],
          },
          () => {
            s.destroy();
            res();
          },
        );
        s.on("error", rej);
      });
    }
    const handshakeMs = (performance.now() - h0) / n;
    await sleep(1200);
    host.proc.kill("SIGTERM");
    const [a, b, code] = await Promise.all([
      secure.done,
      plain.done,
      host.exited,
    ]);
    ok(code === 0, `rs_live_host exited 0 (got ${code})`);
    ok(
      a.status === 101 && a.alpn === "http/1.1" && a.protocol === "TLSv1.3",
      `wss upgrade: ${a.status}, ALPN ${a.alpn}, ${a.protocol}`,
    );
    ok(
      b.status === 101,
      `plaintext ws upgrade from loopback on the same port: ${b.status}`,
    );
    const t = taps(dir);
    const ra = Buffer.concat(a.messages);
    const rb = Buffer.concat(b.messages);
    ok(
      ra.length > 0 && t.some((x) => x.equals(ra)),
      `the wss session's bytes equal its hub tap (${a.messages.length} messages, ${ra.length} bytes)`,
    );
    ok(
      rb.length > 0 && t.some((x) => x.equals(rb)),
      `the plaintext session's bytes equal its hub tap (${b.messages.length} messages)`,
    );
    ok(
      a.messages.length === b.messages.length &&
        a.close?.code === 1000 &&
        b.close?.code === 1000,
      `same count and close 1000 (${JSON.stringify(a.close)} / ${JSON.stringify(b.close)})`,
    );
    const ws = wsCarrier(dir);
    ok(
      ws.tls === "consumer" && ws.cert_sha256 === pki.leafSha256,
      `live-carriers.json: ws tls ${ws.tls}, cert_sha256 the leaf's`,
    );
    const st = tlsStats(host);
    // 55 TLS connections: the wss session, 3 GETs, the untrusted client and 50 handshakes; one
    // plaintext session. Whether the server sees the untrusted client's alert, or the Finished of
    // a client that destroys its socket at secureConnect, depends on that teardown's timing, so
    // only the 4 sessions that sent requests must count as completed handshakes.
    ok(
      st.connections === 55 &&
        st.handshakes >= 4 &&
        st.plaintext_loopback === 1 &&
        st.tls_required === 0,
      `TLS stats: ${JSON.stringify(st)}`,
    );
    console.log(
      `measure: wss upgrade opened in ${openMs.toFixed(1)} ms; connect + TLS 1.3 handshake ${handshakeMs.toFixed(2)} ms (Node client, mean of ${n})`,
    );
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

async function lan(pki: TestPki, addr: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wss-lan-"));
  try {
    const host = await startHost(
      dir,
      {
        GRC_LIVE_TLS_CERT: pki.cert,
        GRC_LIVE_TLS_KEY: pki.key,
        GRC_LIVE_EXPOSE: "lan",
        GRC_LIVE_LISTEN: "0.0.0.0:0",
        GRC_LIVE_ALLOWED_ORIGINS: ORIGIN,
      },
      [`--token=${TOKEN}`],
    );
    const refusal = await rawPlain(
      addr,
      host.port,
      `GET /resources/sha256/${HASH} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`,
    );
    ok(
      refusal.text.startsWith("HTTP/1.1 403 ") &&
        refusal.text.endsWith("\r\n\r\ntls-required\n") &&
        refusal.closed,
      `plaintext through ${addr} -> 403 tls-required, closed (${JSON.stringify(refusal.text.split("\r\n")[0])})`,
    );
    const upgrade = await rawPlain(
      addr,
      host.port,
      "GET /render-stream HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: render-stream.7\r\n\r\n",
    );
    ok(
      upgrade.text.startsWith("HTTP/1.1 403 ") && upgrade.closed,
      "a plaintext upgrade through the LAN address -> 403, closed",
    );
    const secure = wssSession(addr, host.port, pki, TOKEN);
    await secure.opened;
    const g = await httpsGet(
      addr,
      host.port,
      `/resources/sha256/${HASH}`,
      pki,
      { Authorization: `Bearer ${TOKEN}` },
    );
    ok(
      g.status === 200,
      `https GET through ${addr} -> 200 (${g.status} ${g.error ?? ""})`,
    );
    await sleep(1200);
    host.proc.kill("SIGTERM");
    const [a, code] = await Promise.all([secure.done, host.exited]);
    ok(code === 0, `rs_live_host exited 0 (got ${code})`);
    const ra = Buffer.concat(a.messages);
    ok(
      a.status === 101 && ra.length > 0 && taps(dir).some((x) => x.equals(ra)),
      `wss through ${addr}: bytes equal its tap (${a.messages.length} messages)`,
    );
    const st = tlsStats(host);
    ok(
      st.tls_required === 2 && st.connections === 2 && st.plaintext_lan === 0,
      `TLS stats: ${JSON.stringify(st)}`,
    );
    const ws = wsCarrier(dir);
    ok(
      ws.lan_plaintext === false,
      `live-carriers.json: ws lan_plaintext ${ws.lan_plaintext} without GRC_LIVE_LAN_PLAINTEXT`,
    );
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

/** D12: GRC_LIVE_LAN_PLAINTEXT=allow serves a plain-http LAN page's ws and GETs beside wss. */
async function lanPlaintext(pki: TestPki, addr: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wss-lan-plain-"));
  try {
    const host = await startHost(
      dir,
      {
        GRC_LIVE_TLS_CERT: pki.cert,
        GRC_LIVE_TLS_KEY: pki.key,
        GRC_LIVE_EXPOSE: "lan",
        GRC_LIVE_LISTEN: "0.0.0.0:0",
        GRC_LIVE_ALLOWED_ORIGINS: ORIGIN,
        GRC_LIVE_LAN_PLAINTEXT: "allow",
      },
      [`--token=${TOKEN}`],
    );
    const get = await rawPlain(
      addr,
      host.port,
      `GET /resources/sha256/${HASH} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`,
    );
    ok(
      get.text.startsWith("HTTP/1.1 200 ") && get.closed,
      `lan-plaintext: plaintext GET through ${addr} -> 200 (${JSON.stringify(get.text.split("\r\n")[0])})`,
    );
    const plain = wsSession(addr, host.port, TOKEN);
    await plain.opened;
    const secure = wssSession(addr, host.port, pki, TOKEN);
    await secure.opened;
    const g = await httpsGet(
      addr,
      host.port,
      `/resources/sha256/${HASH}`,
      pki,
      { Authorization: `Bearer ${TOKEN}` },
    );
    ok(
      g.status === 200,
      `lan-plaintext: https GET through ${addr} -> 200 (${g.status} ${g.error ?? ""})`,
    );
    await sleep(1200);
    host.proc.kill("SIGTERM");
    const [a, b, code] = await Promise.all([
      secure.done,
      plain.done,
      host.exited,
    ]);
    ok(code === 0, `rs_live_host exited 0 (got ${code})`);
    const t = taps(dir);
    const ra = Buffer.concat(a.messages);
    const rb = Buffer.concat(b.messages);
    ok(
      b.status === 101 && rb.length > 0 && t.some((x) => x.equals(rb)),
      `lan-plaintext: ws through ${addr}: bytes equal its tap (${b.status}, ${b.messages.length} messages)`,
    );
    ok(
      a.status === 101 && ra.length > 0 && t.some((x) => x.equals(ra)),
      `lan-plaintext: wss through ${addr}: bytes equal its tap (${a.messages.length} messages)`,
    );
    const st = tlsStats(host);
    ok(
      st.plaintext_lan === 2 &&
        st.tls_required === 0 &&
        st.connections === 2 &&
        st.plaintext_loopback === 0,
      `lan-plaintext: TLS stats: ${JSON.stringify(st)}`,
    );
    const ws = wsCarrier(dir);
    ok(
      ws.lan_plaintext === true && ws.tls === "consumer",
      `live-carriers.json: ws lan_plaintext ${ws.lan_plaintext}, tls ${ws.tls}`,
    );
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const b = spawnSync(
    "bash",
    [join(RS, "scripts/build-rs-net.sh"), "--no-test"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (b.status !== 0 || !existsSync(HOST) || !existsSync(WS_TEST)) {
    console.error(
      `self-test-wss: build-rs-net.sh failed (${b.status}) or ${HOST} / ${WS_TEST} is missing (build-capture.sh)`,
    );
    process.exit(1);
  }
  const addr = lanAddress();
  const pki = makeTestPki(addr ? [addr] : []);
  try {
    const cpp = spawnSync(WS_TEST, ["--tls-only", "--require-tls"], {
      encoding: "utf8",
      env: cleanEnv(),
    });
    ok(
      cpp.status === 0,
      `rs_ws_test --tls-only --require-tls: ${(cpp.stdout + cpp.stderr).trim().split("\n").slice(-3).join(" | ")}`,
    );
    await refusals(pki);
    await loopback(pki);
    if (addr) {
      await lan(pki, addr);
      await lanPlaintext(pki, addr);
    } else
      console.log(
        "unavailable: no non-loopback IPv4 address on this machine; the LAN parts are skipped",
      );
  } finally {
    if (!keep) rmSync(pki.dir, { recursive: true, force: true });
  }
  console.log(
    failed === 0
      ? "self-test-wss: all passed"
      : `self-test-wss: ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
