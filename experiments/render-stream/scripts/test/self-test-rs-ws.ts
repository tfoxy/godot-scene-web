#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Node interop self-test for rs_ws (protocol/gate1-design.md G1c1) and its
// HTTP GET resource serving (protocol/gate2-design.md G2c1), against the
// test-only capture/test/rs_ws_echo.cpp binary built by
// scripts/build-capture.sh. Uses Node's built-in WebSocket and fetch
// (stable since Node 22; this repo pins Node 24, see mise.toml) rather than
// the npm `ws` package, which is not in this workspace.
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
// Exits non-zero if any assertion fails or the server never starts.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
): Promise<{ child: EchoProcess; port: number }> {
  const child = spawn(binary, ["--port=0"], {
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

  console.log(
    `\nself-test-rs-ws: ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`}`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
