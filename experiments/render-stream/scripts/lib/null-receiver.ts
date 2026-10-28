// A live viewer that decodes nothing (P3-SP, results/p3/p3-sp.md): bench-live-scale.sh's
// `--receiver null`. It speaks the /8 hello (or, HC, the /11 hello offering `live_coding`
// zstd-base,zstd), then acks every transaction at all three stages the moment it arrives, so the
// host sends to it at every frame the credit allows and every viewer of a multi-viewer leg stays in
// lockstep. What the leg then measures is the host's own cost per viewer, with no receiver CPU, GPU
// or browser competing for the machine. At /11 it decodes no transaction: a coded transaction's seq
// is in its envelope (render-stream-11.md "Transport: base-prefix zstd"), and only the plain-coded
// messages (session, resource and end records: one zstd frame, no dictionary) are decompressed.
//
//   tsx --conditions=development null-receiver.ts --url ws://127.0.0.1:<port>/render-stream
//     --out <dir> [--window 1|2] [--protocol 8|11] [--offer zstd-base,zstd|""] [--timeout-s S]
//
// Writes <dir>/null-receiver.json ({transactions, resource_records, bytes, first_ms, end}) and
// exits 0 once the end record arrived (1 on a close before it, an error message, or the timeout).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`null-receiver: ${name} is required`);
}

const url = arg("--url");
const out = arg("--out");
const window = Number(arg("--window", "2"));
const timeoutS = Number(arg("--timeout-s", "600"));
const protocol = arg("--protocol", "8");
const offer = arg("--offer", "zstd-base,zstd");
if (protocol !== "8" && protocol !== "11")
  throw new Error("null-receiver: --protocol 8|11");
// render-stream-11.md "Transport: base-prefix zstd": a coded transaction's envelope (a zstd
// skippable frame: u32le magic, u32le 16, u64le seq, u64le base_seq) and a plain zstd frame.
const ENVELOPE_MAGIC = 0x184d2a5b;
const ZSTD_MAGIC = 0xfd2fb528;
mkdirSync(out, { recursive: true });

// A record is u32le body length, then the body: u32le meta length and the meta JSON first.
function recordMeta(bytes: Uint8Array, at: number): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(at + 4, true);
  const text = new TextDecoder().decode(
    bytes.subarray(at + 8, at + 8 + metaLen),
  );
  return JSON.parse(text) as Record<string, unknown>;
}

const stats = {
  transactions: 0,
  resource_records: 0,
  bytes: 0,
  first_ms: null as number | null,
  end: false,
};
const t0 = performance.now();
let streamId = "";
let finished = false;

const ws = new WebSocket(url, [`render-stream.${protocol}`]);
ws.binaryType = "arraybuffer";
const finish = (code: number): void => {
  if (finished) return;
  finished = true;
  writeFileSync(join(out, "null-receiver.json"), `${JSON.stringify(stats)}\n`);
  try {
    ws.close(1000);
  } catch {
    // already closed
  }
  process.exit(code);
};
const timer = setTimeout(() => finish(1), timeoutS * 1000);
timer.unref();

ws.addEventListener("open", () => {
  const hello: Record<string, unknown> = {
    type: "hello",
    protocol: `render-stream/${protocol}`,
    receiver: "null-receiver",
    receiver_kind: "gsw-canvas",
    credit_stage: "submitted",
    credit_window: window,
    inbound_buffer_bytes: 16777216,
    token: null,
    manifest_sha256: null,
    presentation_backing_w: 1920,
    presentation_backing_h: 1080,
    presentation_css_w: 1920,
    presentation_css_h: 1080,
    dpr_milli: 1000,
  };
  if (protocol === "11") {
    hello.texture_encodings = "decoded";
    hello.gpu_formats = "none";
    if (offer !== "") hello.live_coding = offer;
  }
  ws.send(JSON.stringify(hello));
});

function ack(seq: number): void {
  stats.transactions += 1;
  if (stats.first_ms === null)
    stats.first_ms = Math.round(performance.now() - t0);
  const tUs = Math.round(performance.now() * 1000);
  for (const stage of ["received", "applied", "submitted"]) {
    ws.send(
      JSON.stringify({
        type: "ack",
        stream_id: streamId,
        seq,
        stage,
        t_us: tUs,
      }),
    );
  }
}

ws.addEventListener("message", (event: MessageEvent) => {
  if (typeof event.data === "string") {
    const message = JSON.parse(event.data) as { type?: string };
    if (message.type === "error") finish(1);
    return;
  }
  let bytes = new Uint8Array(event.data as ArrayBuffer);
  stats.bytes += bytes.byteLength;
  if (bytes.byteLength >= 24) {
    const head = new DataView(bytes.buffer, bytes.byteOffset, 24);
    const magic = head.getUint32(0, true);
    if (magic === ENVELOPE_MAGIC && streamId !== "") {
      ack(Number(head.getBigUint64(8, true)));
      return;
    }
    if (magic === ZSTD_MAGIC) bytes = new Uint8Array(zstdDecompressSync(bytes));
  }
  // The first message is the 8-byte magic and the session record.
  if (streamId === "") {
    const session = recordMeta(bytes, 8) as { stream?: { stream_id?: string } };
    streamId = session.stream?.stream_id ?? "";
    return;
  }
  const meta = recordMeta(bytes, 0);
  if (meta.type === "resource") {
    stats.resource_records += 1;
  } else if (meta.type === "transaction") {
    ack(Number(meta.seq));
  } else if (meta.type === "end") {
    stats.end = true;
    finish(0);
  }
});
ws.addEventListener("close", () => finish(stats.end ? 0 : 1));
ws.addEventListener("error", () => finish(1));
