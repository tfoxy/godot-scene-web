// Arrival-ack receiver for engine-free credit-window measurements. It decodes no transaction:
// zstd-base seqs come from the skippable envelope; only plain session/resource/end messages are
// decompressed. TCP noDelay and separate received/applied/submitted writes avoid Nagle batching.
// Every ack gets a distinct monotonic t_us, so this synthetic receiver never signals draw coalescing.
//
// node null-window-receiver.mjs --url ws://127.0.0.1:PORT/render-stream
//   --origin http://127.0.0.1:13832 --out DIR [--protocol 16|18] [--window 1..8]
//   [--token-file FILE | --token TOKEN] [--timeout-s 120]
// Exits 0 only after end; refusal, early close, host error and timeout exit 1.

import crypto from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { zstdDecompressSync } from "node:zlib";

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  if (i >= 0) return process.argv[i + 1];
  if (d !== undefined) return d;
  throw new Error(`${n} required`);
};
const url = new URL(arg("--url"));
const origin = arg("--origin");
const hostHeader = arg("--host-header", "");
const tokenFile = arg("--token-file", "");
const token = tokenFile
  ? readFileSync(tokenFile, "utf8").trim()
  : arg("--token", "") || null;
const out = arg("--out");
const timeoutS = Number(arg("--timeout-s", "120"));
const protocol = Number(arg("--protocol", "18"));
const window = Number(arg("--window", protocol === 18 ? "8" : "2"));
const stage = "submitted";
if (
  ![16, 18].includes(protocol) ||
  !Number.isInteger(window) ||
  window < 1 ||
  window > (protocol === 18 ? 8 : 2)
)
  throw new Error(
    "null-window-receiver: --protocol 16|18, --window 1..2 below /18, else 1..8",
  );
if (url.protocol !== "ws:" || !Number.isFinite(timeoutS) || timeoutS <= 0)
  throw new Error(
    "null-window-receiver: ws:// URL and positive --timeout-s required",
  );
mkdirSync(out, { recursive: true });
const ENVELOPE_MAGIC = 0x184d2a5b,
  ZSTD_MAGIC = 0xfd2fb528;
const t0 = performance.now();
const log = (o) =>
  appendFileSync(
    `${out}/events.jsonl`,
    `${JSON.stringify({ t_ms: +(performance.now() - t0).toFixed(3), ...o })}\n`,
  );
const stats = {
  protocol,
  window,
  url: url.href,
  origin,
  transactions: 0,
  resource_records: 0,
  bytes: 0,
  text_messages: [],
  first_ms: null,
  interarrival_ms: [],
  end: false,
  close: null,
};
let streamId = "",
  lastTx = null,
  finished = false,
  lastAckUs = 0;

const sock = net.connect({
  host: url.hostname,
  port: Number(url.port),
  noDelay: true,
});
sock.setNoDelay(true);
const key = crypto.randomBytes(16).toString("base64");
sock.on("connect", () => {
  const lines = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${hostHeader || url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Protocol: render-stream.${protocol}`,
    `Origin: ${origin}`,
    "User-Agent: null-window-receiver",
    "",
    "",
  ];
  sock.write(lines.join("\r\n"));
});
function frame(opcode, payload) {
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}
const sendText = (s) => sock.write(frame(1, Buffer.from(s, "utf8")));
const finish = (why) => {
  if (finished) return;
  finished = true;
  const ia = stats.interarrival_ms.slice().sort((a, b) => a - b);
  const pct = (p) =>
    ia.length ? ia[Math.min(ia.length - 1, Math.floor(p * ia.length))] : null;
  stats.interarrival = {
    n: ia.length,
    p50: pct(0.5),
    p95: pct(0.95),
    min: ia[0] ?? null,
    max: ia[ia.length - 1] ?? null,
  };
  delete stats.interarrival_ms;
  stats.finish = why;
  stats.duration_ms = performance.now() - t0;
  writeFileSync(
    `${out}/null-receiver.json`,
    `${JSON.stringify(stats, null, 1)}\n`,
  );
  try {
    sock.write(frame(8, Buffer.from([0x03, 0xe8])));
  } catch {}
  setTimeout(() => {
    sock.destroy();
    process.exit(why === "end" ? 0 : 1);
  }, 200);
};
setTimeout(() => finish("timeout"), timeoutS * 1000).unref?.();

let buf = Buffer.alloc(0),
  upgraded = false,
  frag = [],
  fragOp = 0;
sock.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  if (!upgraded) {
    const i = buf.indexOf("\r\n\r\n");
    if (i < 0) return;
    const head = buf.subarray(0, i).toString("latin1");
    buf = buf.subarray(i + 4);
    log({
      ev: "handshake",
      head: head.split("\r\n").filter((l) => !/^sec-websocket-accept/i.test(l)),
    });
    if (
      !/^HTTP\/1\.1 101/.test(head) ||
      !head
        .toLowerCase()
        .includes(`sec-websocket-protocol: render-stream.${protocol}`)
    ) {
      stats.close = head.split("\r\n")[0];
      finish("handshake-refused");
      return;
    }
    upgraded = true;
    const hello = {
      type: "hello",
      protocol: `render-stream/${protocol}`,
      receiver: "null-window-receiver",
      receiver_kind: "gsw-canvas",
      credit_stage: stage,
      credit_window: window,
      inbound_buffer_bytes: 16777216,
      token,
      manifest_sha256: null,
      presentation_backing_w: 1920,
      presentation_backing_h: 1080,
      presentation_css_w: 1920,
      presentation_css_h: 1080,
      dpr_milli: 1000,
      texture_encodings: "decoded",
      gpu_formats: "none",
      live_coding: "zstd-base,zstd",
    };
    sendText(JSON.stringify(hello));
    log({
      ev: "hello.sent",
      hello: { ...hello, token: token ? "<redacted>" : null },
    });
  }
  for (;;) {
    if (buf.length < 2) return;
    const fin = (buf[0] & 0x80) !== 0,
      op = buf[0] & 0x0f;
    let len = buf[1] & 0x7f,
      off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    if (buf[1] & 0x80) off += 4; // server frames are unmasked
    if (buf.length < off + len) return;
    const payload = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    if (op === 9) {
      sock.write(frame(10, payload));
      continue;
    }
    if (op === 10) continue;
    if (op === 8) {
      stats.close = {
        code: payload.length >= 2 ? payload.readUInt16BE(0) : null,
        reason: payload.subarray(2).toString(),
      };
      finish("closed");
      return;
    }
    if (op === 0) {
      frag.push(Buffer.from(payload));
      if (!fin) continue;
      onMessage(fragOp, Buffer.concat(frag));
      frag = [];
      continue;
    }
    if (!fin) {
      fragOp = op;
      frag = [Buffer.from(payload)];
      continue;
    }
    onMessage(op, payload);
  }
});
sock.on("close", () => finish("socket-close"));
sock.on("error", (e) => {
  stats.error = String(e);
  finish("socket-error");
});

function recordMeta(bytes, at) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint32(at + 4, true);
  return JSON.parse(
    Buffer.from(bytes.subarray(at + 8, at + 8 + n)).toString("utf8"),
  );
}
function ack(seq) {
  const now = performance.now();
  stats.transactions += 1;
  if (stats.first_ms === null) stats.first_ms = +(now - t0).toFixed(1);
  if (lastTx !== null) stats.interarrival_ms.push(+(now - lastTx).toFixed(3));
  lastTx = now;
  for (const s of ["received", "applied", "submitted"]) {
    // Distinct even for transactions delivered in the same TCP read: this receiver has no draw
    // batching. The pacing detector must not interpret timer quantization as a coalesced draw.
    const tUs = Math.max(lastAckUs + 1, Math.round(performance.now() * 1000));
    lastAckUs = tUs;
    sendText(
      JSON.stringify({
        type: "ack",
        stream_id: streamId,
        seq,
        stage: s,
        t_us: tUs,
      }),
    );
  }
}
function onMessage(op, payload) {
  if (finished) return;
  if (op === 1) {
    const t = payload.toString("utf8");
    if (stats.text_messages.length < 20)
      stats.text_messages.push(t.slice(0, 400));
    log({ ev: "text", text: t.slice(0, 400) });
    if (JSON.parse(t).type === "error") finish("error-message");
    return;
  }
  let bytes = new Uint8Array(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  stats.bytes += bytes.byteLength;
  if (bytes.byteLength >= 24) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, 24);
    const magic = v.getUint32(0, true);
    if (magic === ENVELOPE_MAGIC && streamId !== "") {
      ack(Number(v.getBigUint64(8, true)));
      return;
    }
    if (magic === ZSTD_MAGIC)
      bytes = new Uint8Array(zstdDecompressSync(Buffer.from(bytes)));
  }
  if (streamId === "") {
    const s = recordMeta(bytes, 8);
    streamId = s.stream?.stream_id ?? "";
    log({ ev: "session", stream_id: streamId, protocol: s.protocol });
    return;
  }
  const meta = recordMeta(bytes, 0);
  if (meta.type === "resource") stats.resource_records += 1;
  else if (meta.type === "transaction") ack(Number(meta.seq));
  else if (meta.type === "end") {
    stats.end = true;
    finish("end");
  }
}
