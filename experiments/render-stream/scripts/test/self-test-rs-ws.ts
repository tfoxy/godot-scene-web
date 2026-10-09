#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Node interop self-test for rs_ws (protocol/gate1-design.md G1c1), its
// HTTP GET resource serving (protocol/gate2-design.md G2c1) and its
// bearer-token authorization (gate2-design.md D13, G2e), against the
// test-only capture/test/rs_ws_echo.cpp binary built by
// scripts/build-capture.sh. Uses Node's built-in WebSocket and fetch
// (stable since Node 22; this repo pins Node 24, see mise.toml) rather than
// the npm `ws` package, which is not in this workspace. The bearer-auth
// checks use Node's `http` module directly instead of the WebSocket global:
// the WHATWG WebSocket constructor has no way to set a custom header (the
// same restriction browsers have), so a raw upgrade request is the only way
// to see the host's 401 at all -- a spec-compliant WebSocket client can only
// ever observe "never opened".
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-rs-ws.ts \
//     [path/to/rs_ws_echo]
//
// Defaults to capture/build/rs_ws_echo (the path scripts/build-capture.sh
// prints), or RS_WS_ECHO_BINARY if set.
//
// Checks (gate1-design.md G1c1 "Pass criteria", Node interop): the
// subprotocol is negotiated, text sent by this client is echoed back
// verbatim, a 1 MiB and an 8 MiB binary push (rs_ws_echo's tiny test
// protocol: a decimal-text request for N bytes) arrive byte-exact against
// the deterministic pattern byte[i] = i % 256, and the server closes
// cleanly (code 1000) when this client closes.
//
// Also (gate2-design.md G2c1 "Pass criteria", Node interop), while the
// WebSocket connection above is still open: `fetch` of rs_ws_echo's two
// fixed test resources (1 MiB and 8 MiB, see capture/test/rs_ws_echo.cpp's
// header for the hash strings and why they are test fixtures, not real
// content hashes) is byte-exact against byte[i] = i % 251, with the headers
// render-stream-2.md "HTTP (live)" specifies; a third, well-formed but
// unregistered hash gets 404.
//
// Also (gate2-design.md D13 "Pass criteria", Node interop), against a
// second rs_ws_echo instance started with --token=<value>: a WebSocket
// upgrade with no Authorization header, or with the wrong bearer token,
// never receives a 101 (a plain HTTP response instead, status 401); the
// correct token does upgrade. The same three cases over `fetch` for a
// resource GET: 401, 401, 200 byte-exact.
//
// Exits non-zero if any assertion fails or the server never starts.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

type EchoProcess = ChildProcessByStdio<null, Readable, Readable>;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BINARY = resolve(SCRIPT_DIR, "../../capture/build/rs_ws_echo");
const BINARY =
  process.argv[2] ?? process.env.RS_WS_ECHO_BINARY ?? DEFAULT_BINARY;

// capture/test/rs_ws_echo.cpp's fixed test resources and the default resource_prefix
// (capture/src/rs_ws.h ServerConfig::resource_prefix). Test fixtures, not real content hashes.
const RESOURCE_PREFIX = "/resources/sha256/";
const HASH_1MIB = "1".repeat(64);
const HASH_8MIB = `${"8".repeat(63)}a`;
const HASH_UNKNOWN = "f".repeat(64);

let failures = 0;

function ok(condition: boolean, what: string): void {
  if (condition) {
    console.log(`[SELF-TEST OK] ${what}`);
  } else {
    console.error(`[SELF-TEST FAIL] ${what}`);
    failures++;
  }
}

function expectedPayload(len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = i % 256;
  return out;
}

// rs_ws_echo.cpp's HTTP resource bodies: byte[i] = i % 251 (a different modulus from the WS
// binary push above, deliberately, so a test that mixed the two up would be caught).
function expectedResourcePayload(len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = i % 251;
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function startEcho(
  binary: string,
  extraArgs: readonly string[] = [],
): Promise<{ child: EchoProcess; port: number }> {
  const child = spawn(binary, ["--port=0", ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBuf = "";
  const port = await new Promise<number>((res, rej) => {
    const onData = (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const match = stdoutBuf.match(/RS_WS_ECHO_PORT (\d+)/);
      if (match) {
        child.stdout.off("data", onData);
        res(Number(match[1]));
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) =>
      rej(
        new Error(
          `rs_ws_echo exited early (code ${code}) before printing its port`,
        ),
      ),
    );
    setTimeout(
      () => rej(new Error("timed out waiting for RS_WS_ECHO_PORT")),
      5000,
    );
  });
  return { child, port };
}

function once<T extends Event>(target: WebSocket, type: string): Promise<T> {
  return new Promise((res) => {
    target.addEventListener(type, (event) => res(event as T), { once: true });
  });
}

// A raw (non-WebSocket-API) upgrade request: the only way from Node to observe the host's actual
// HTTP response to a WS upgrade attempt, since the WHATWG WebSocket constructor has no way to set
// a custom header. `upgraded` is true only for a 101 response (Node's http.ClientRequest emits
// "upgrade" for that, never "response"); any other status -- 401 included -- is a normal
// "response" event. Destroys the socket immediately either way: this probes the handshake, it
// does not speak the WebSocket frame protocol afterward.
function rawUpgradeProbe(
  port: number,
  authorization: string | undefined,
): Promise<{ status: number; upgraded: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const headers: Record<string, string> = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Protocol": "render-stream.1",
    };
    if (authorization !== undefined) headers.Authorization = authorization;
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/render-stream",
        method: "GET",
        headers,
      },
      (res) => {
        res.resume();
        resolvePromise({ status: res.statusCode ?? 0, upgraded: false });
      },
    );
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolvePromise({ status: res.statusCode ?? 0, upgraded: true });
    });
    req.on("error", reject);
    req.end();
  });
}

async function testBearerAuth(binary: string): Promise<void> {
  const TOKEN = "node-self-test-bearer-token";
  const { child, port } = await startEcho(binary, [`--token=${TOKEN}`]);
  try {
    const noToken = await rawUpgradeProbe(port, undefined);
    ok(
      !noToken.upgraded && noToken.status === 401,
      `WS upgrade without a token -> 401, not an upgrade (got status ${noToken.status}, upgraded ${noToken.upgraded})`,
    );

    const wrongToken = await rawUpgradeProbe(port, "Bearer wrong-token");
    ok(
      !wrongToken.upgraded && wrongToken.status === 401,
      `WS upgrade with the wrong token -> 401, not an upgrade (got status ${wrongToken.status}, upgraded ${wrongToken.upgraded})`,
    );

    const rightToken = await rawUpgradeProbe(port, `Bearer ${TOKEN}`);
    ok(
      rightToken.upgraded && rightToken.status === 101,
      `WS upgrade with the correct token -> 101 upgrade (got status ${rightToken.status}, upgraded ${rightToken.upgraded})`,
    );

    const url = `http://127.0.0.1:${port}${RESOURCE_PREFIX}${HASH_1MIB}`;
    const getNoToken = await fetch(url);
    ok(
      getNoToken.status === 401,
      `GET without a token -> 401 (got ${getNoToken.status})`,
    );
    await getNoToken.arrayBuffer();

    const getWrongToken = await fetch(url, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    ok(
      getWrongToken.status === 401,
      `GET with the wrong token -> 401 (got ${getWrongToken.status})`,
    );
    await getWrongToken.arrayBuffer();

    const getRightToken = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    ok(
      getRightToken.status === 200,
      `GET with the correct token -> 200 (got ${getRightToken.status})`,
    );
    const body = new Uint8Array(await getRightToken.arrayBuffer());
    ok(
      bytesEqual(body, expectedResourcePayload(1 << 20)),
      "GET with the correct token is byte-exact",
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((res) => {
      child.on("exit", () => res());
      setTimeout(res, 2000);
    });
  }
}

async function main(): Promise<void> {
  if (!existsSync(BINARY)) {
    console.error(
      `self-test-rs-ws: ${BINARY} does not exist. Run experiments/render-stream/scripts/build-capture.sh first.`,
    );
    process.exitCode = 1;
    return;
  }

  const { child, port } = await startEcho(BINARY);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/render-stream`, [
      "render-stream.1",
    ]);
    ws.binaryType = "arraybuffer";

    const openEvent = await Promise.race([
      once(ws, "open"),
      once(ws, "error").then(() => {
        throw new Error("WebSocket errored before opening");
      }),
    ]);
    ok(openEvent.type === "open", "connection opens");
    ok(
      ws.protocol === "render-stream.1",
      `subprotocol negotiated (got "${ws.protocol}")`,
    );

    // --- text echo -----------------------------------------------------------------------------
    const textEchoed = new Promise<string>((res) => {
      ws.addEventListener(
        "message",
        (event) => {
          res(event.data as string);
        },
        { once: true },
      );
    });
    ws.send("hello from node");
    const echoed = await textEchoed;
    ok(echoed === "hello from node", `text echoed verbatim (got "${echoed}")`);

    // --- binary pushes ---------------------------------------------------------------------------
    for (const len of [1 << 20, 8 << 20]) {
      const received = new Promise<ArrayBuffer>((res) => {
        ws.addEventListener(
          "message",
          (event) => {
            res(event.data as ArrayBuffer);
          },
          { once: true },
        );
      });
      ws.send(String(len));
      const buf = await received;
      const got = new Uint8Array(buf);
      ok(
        got.length === len,
        `binary push of ${len} bytes has the right length (got ${got.length})`,
      );
      ok(
        bytesEqual(got, expectedPayload(len)),
        `binary push of ${len} bytes is byte-exact`,
      );
    }

    // --- HTTP GET resources, while the WebSocket session above is still open --------------------
    for (const [hash, len] of [
      [HASH_1MIB, 1 << 20],
      [HASH_8MIB, 8 << 20],
    ] as const) {
      const resp = await fetch(
        `http://127.0.0.1:${port}${RESOURCE_PREFIX}${hash}`,
      );
      ok(
        resp.status === 200,
        `GET ${hash.slice(0, 8)}... is 200 (got ${resp.status})`,
      );
      ok(
        resp.headers.get("content-type") === "application/octet-stream",
        `GET ${hash.slice(0, 8)}... has Content-Type: application/octet-stream`,
      );
      ok(
        resp.headers.get("cache-control") ===
          "private, max-age=31536000, immutable",
        `GET ${hash.slice(0, 8)}... has the immutable Cache-Control`,
      );
      ok(
        resp.headers.get("etag") === `"${hash}"`,
        `GET ${hash.slice(0, 8)}... has the matching ETag`,
      );
      const body = new Uint8Array(await resp.arrayBuffer());
      ok(
        body.length === len,
        `GET ${hash.slice(0, 8)}... body length (got ${body.length}, want ${len})`,
      );
      ok(
        bytesEqual(body, expectedResourcePayload(len)),
        `GET ${hash.slice(0, 8)}... body is byte-exact`,
      );
    }

    const notFound = await fetch(
      `http://127.0.0.1:${port}${RESOURCE_PREFIX}${HASH_UNKNOWN}`,
    );
    ok(
      notFound.status === 404,
      `GET of an unregistered hash is 404 (got ${notFound.status})`,
    );

    ok(
      ws.readyState === WebSocket.OPEN,
      "the WebSocket session is still open after the HTTP fetches",
    );

    // --- clean close -----------------------------------------------------------------------------
    const closeEvent = await new Promise<CloseEvent>((res) => {
      ws.addEventListener("close", (event) => res(event as CloseEvent), {
        once: true,
      });
      ws.close(1000, "done");
    });
    ok(
      closeEvent.code === 1000 || closeEvent.wasClean,
      `clean close (code ${closeEvent.code}, clean ${closeEvent.wasClean})`,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((res) => {
      child.on("exit", () => res());
      setTimeout(res, 2000);
    });
  }

  await testBearerAuth(BINARY);

  console.log(
    `\nself-test-rs-ws: ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
