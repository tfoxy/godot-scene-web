// Real loopback WebSocket regressions: hello auth/version, arrival acks and failure exits.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const receiver =
  process.env.NULL_WINDOW_RECEIVER ??
  fileURLToPath(new URL("../lib/null-window-receiver.mjs", import.meta.url));
const tsx = fileURLToPath(
  new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);
function record(meta) {
  const json = Buffer.from(JSON.stringify(meta));
  const head = Buffer.alloc(8);
  head.writeUInt32LE(json.length + 4);
  head.writeUInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}
function frame(op, payload) {
  const head = Buffer.alloc(payload.length < 126 ? 2 : 4);
  head[0] = 0x80 | op;
  if (payload.length < 126) head[1] = payload.length;
  else {
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([head, payload]);
}
async function run(protocol, window, mode = "success") {
  const dir = mkdtempSync(join(tmpdir(), "rs-null-window-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "test-token\n");
  const server = createServer();
  const sockets = new Set();
  let hello;
  let origin;
  const acks = [];
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    origin = req.headers.origin;
    const accept = createHash("sha1")
      .update(
        req.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: render-stream.${protocol}\r\n\r\n`,
    );
    let buf = Buffer.alloc(0);
    socket.on("data", (data) => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 2) {
        const op = buf[0] & 15;
        let n = buf[1] & 127;
        let at = 2;
        if (n === 126) {
          if (buf.length < 4) return;
          n = buf.readUInt16BE(2);
          at = 4;
        }
        if (buf.length < at + 4 + n) return;
        const mask = buf.subarray(at, at + 4);
        const payload = Buffer.from(buf.subarray(at + 4, at + 4 + n));
        for (let i = 0; i < n; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(at + 4 + n);
        if (op === 8) {
          if (!socket.writableEnded)
            socket.end(frame(8, Buffer.from([3, 232])));
          return;
        }
        if (op !== 1) continue;
        const message = JSON.parse(payload.toString());
        if (message.type === "hello") {
          hello = message;
          if (mode === "early-close") {
            socket.end(frame(8, Buffer.from([3, 232])));
            return;
          }
          if (mode === "error") {
            socket.write(
              frame(1, Buffer.from('{"type":"error","code":"test-error"}')),
            );
            continue;
          }
          const session = Buffer.concat([
            Buffer.from("RSTEST00"),
            record({ type: "session", stream: { stream_id: "test-stream" } }),
          ]);
          // Two coded transactions in ONE TCP write must still have distinct submitted timestamps.
          const txs = [1, 2].map((seq) => {
            const envelope = Buffer.alloc(24);
            envelope.writeUInt32LE(0x184d2a5b);
            envelope.writeUInt32LE(16, 4);
            envelope.writeBigUInt64LE(BigInt(seq), 8);
            return frame(2, envelope);
          });
          socket.write(Buffer.concat([frame(2, session), ...txs]));
        } else if (message.type === "ack") {
          acks.push(message);
          if (acks.length === 6)
            socket.write(frame(2, record({ type: "end" })));
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const child = spawn(process.execPath, [
      tsx,
      "--conditions=development",
      receiver,
      "--url",
      `ws://127.0.0.1:${server.address().port}/render-stream`,
      "--origin",
      "http://127.0.0.1:13832",
      "--protocol",
      String(protocol),
      "--window",
      String(window),
      "--token-file",
      tokenFile,
      "--out",
      dir,
      "--timeout-s",
      "2",
    ]);
    let output = "";
    child.stderr.on("data", (d) => {
      output += d;
    });
    const code = await new Promise((r) => child.on("exit", r));
    const stats =
      code === 0
        ? JSON.parse(readFileSync(join(dir, "null-receiver.json"), "utf8"))
        : null;
    return { code, output, hello, origin, acks, stats };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}
for (const [protocol, window] of [
  [16, 2],
  [18, 8],
]) {
  test(`/${protocol} window ${window}: authenticated hello and distinct arrival acks`, async () => {
    const r = await run(protocol, window);
    assert.equal(r.code, 0, r.output);
    assert.equal(r.origin, "http://127.0.0.1:13832");
    assert.equal(r.hello.protocol, `render-stream/${protocol}`);
    assert.equal(r.hello.token, "test-token");
    assert.equal(r.hello.credit_window, window);
    assert.equal(r.hello.credit_stage, "submitted");
    assert.equal(r.stats.transactions, 2);
    assert.equal(r.stats.end, true);
    assert.deepEqual(
      r.acks.map((a) => [a.seq, a.stage]),
      [1, 2].flatMap((seq) =>
        ["received", "applied", "submitted"].map((stage) => [seq, stage]),
      ),
    );
    assert.equal(new Set(r.acks.map((a) => a.t_us)).size, 6);
    assert.ok(
      r.acks.every(
        (a, i) =>
          a.stream_id === "test-stream" &&
          (i === 0 || a.t_us > r.acks[i - 1].t_us),
      ),
    );
  });
}
for (const mode of ["early-close", "error"]) {
  test(`${mode} exits unsuccessfully`, async () => {
    assert.equal((await run(18, 8, mode)).code, 1);
  });
}
test("/16 rejects window 3 before connecting", async () => {
  const r = await run(16, 3);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /--window 1\.\.2 below \/18/);
  assert.equal(r.hello, undefined);
});
