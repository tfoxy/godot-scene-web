// W11t (protocol/render-stream-11.md "As built (W11t)"): a /11 live viewer that decodes the live
// coding in rs-core, through rs-gsw-wasm's `LiveCoding` (the same decoder GSW and the capi
// receivers call), and applies nothing. It speaks the /11 hello, offering `live_coding` unless
// --offer is empty, acks every transaction it decodes at all three stages on arrival (so every
// viewer of a leg stays in lockstep with the host's frames), and answers a `coding` error on a
// transaction with `resync` (reason `coding`), as every receiver must.
//
// W13b (render-stream-13.md "As built (W13b)"): --version 12 or 13 speaks that version's
// subprotocol and hello instead. At /13 each decoded transaction is also un-predicted
// (render-stream-2.ts createRs13Unpredictor: the three predicted blocks against this stream's
// history, then predict-check), and a `predict-check` failure resyncs with reason `coding` too;
// the patches that arrive before the full are dropped unacked, the history unchanged.
//
//   tsx --conditions=development coding-receiver.ts --url ws://127.0.0.1:<port>/render-stream
//     --out <dir> [--offer zstd-base,zstd|zstd|""] [--window 1|2] [--version 11|12|13]
//     [--build <rs-core build dir>] [--timeout-s S]
//
// Writes <dir>/decoded.rs<version> (every message it decoded, in order: magic + session first, so
// an honest leg's file is a recording equal to the host's tap), <dir>/messages.jsonl (one line per
// message: index, wire and decoded bytes, kind, seq, outcome) and <dir>/coding-receiver.json
// ({stream_id, transactions, codings: LiveCoding stats, errors, resyncs, end}). Exits 0 once the
// end record arrived (1 on a close before it, a host error, a fatal coding error or the timeout).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createRs13Unpredictor,
  decodeRecord,
  type TransactionMeta,
} from "./render-stream-2";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`coding-receiver: ${name} is required`);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..", "..");
const url = arg("--url");
const out = arg("--out");
const offer = arg("--offer", "zstd-base,zstd");
const window = Number(arg("--window", "2"));
const timeoutS = Number(arg("--timeout-s", "120"));
const version = Number(arg("--version", "11"));
if (version !== 11 && version !== 12 && version !== 13)
  throw new Error(`coding-receiver: --version ${version} (11, 12 or 13)`);
const unpredictor = version === 13 ? createRs13Unpredictor() : null;
const build = resolve(
  arg("--build", join(root, "artifacts", "render-stream", "rs-core", "latest")),
);
const INBOUND = 16777216;
mkdirSync(out, { recursive: true });

interface Wasm {
  initSync(opts: { module: Uint8Array }): void;
  LiveCoding: new (
    offer: string,
    maxBytes: number,
  ) => {
    decode(msg: Uint8Array): Uint8Array | undefined;
    error(): string;
    seq(): number;
    base_seq(): number;
    coded(): number;
    stats_json(): string;
  };
}
const mod = (await import(
  pathToFileURL(join(build, "gsw-rs", "rs_gsw_wasm.js")).href
)) as Wasm;
mod.initSync({
  module: readFileSync(join(build, "gsw-rs", "rs_gsw_wasm_bg.wasm")),
});
// An empty offer: no `live_coding` key, so the host keeps the connection uncoded (and the decoder
// passes every message through).
const coding = new mod.LiveCoding(offer, INBOUND);

function recordMeta(bytes: Uint8Array, at: number): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(at + 4, true);
  return JSON.parse(
    new TextDecoder().decode(bytes.subarray(at + 8, at + 8 + metaLen)),
  ) as Record<string, unknown>;
}

const decoded: Uint8Array[] = [];
const lines: string[] = [];
const report = {
  stream_id: "",
  offer,
  window,
  version,
  transactions: 0,
  // W13b: transactions un-predicted (/13 only), and patches dropped while awaiting the full.
  unpredicted: 0,
  dropped_awaiting_full: 0,
  resource_records: 0,
  wire_bytes: 0,
  errors: [] as { index: number; seq: number; detail: string }[],
  resyncs: [] as number[],
  full_after_resync: [] as number[],
  skipped: 0,
  end: false,
  coding: {} as Record<string, unknown>,
  fatal: null as string | null,
};
let finished = false;
let awaitingFull = false;
let index = 0;

const ws = new WebSocket(url, [`render-stream.${version}`]);
ws.binaryType = "arraybuffer";
const finish = (code: number): void => {
  if (finished) return;
  finished = true;
  report.coding = JSON.parse(coding.stats_json()) as Record<string, unknown>;
  let n = 0;
  for (const d of decoded) n += d.byteLength;
  const all = new Uint8Array(n);
  let at = 0;
  for (const d of decoded) {
    all.set(d, at);
    at += d.byteLength;
  }
  writeFileSync(join(out, `decoded.rs${version}`), all);
  writeFileSync(
    join(out, "messages.jsonl"),
    lines.join("\n") + (lines.length ? "\n" : ""),
  );
  writeFileSync(
    join(out, "coding-receiver.json"),
    `${JSON.stringify(report, null, 1)}\n`,
  );
  try {
    ws.close(1000);
  } catch {
    // already closed
  }
  process.exit(code);
};
const timer = setTimeout(() => {
  report.fatal = "timeout";
  finish(1);
}, timeoutS * 1000);
timer.unref();

ws.addEventListener("open", () => {
  const hello: Record<string, unknown> = {
    type: "hello",
    protocol: `render-stream/${version}`,
    receiver: "coding-receiver",
    receiver_kind: "gsw-canvas",
    credit_stage: "submitted",
    credit_window: window,
    inbound_buffer_bytes: INBOUND,
    token: null,
    manifest_sha256: null,
    presentation_backing_w: 1920,
    presentation_backing_h: 1080,
    presentation_css_w: 1920,
    presentation_css_h: 1080,
    dpr_milli: 1000,
    texture_encodings: "decoded",
    gpu_formats: "none",
  };
  if (offer !== "") hello.live_coding = offer;
  ws.send(JSON.stringify(hello));
});

ws.addEventListener("message", (event: MessageEvent) => {
  if (typeof event.data === "string") {
    const message = JSON.parse(event.data) as {
      type?: string;
      reason?: string;
    };
    if (message.type === "error") {
      report.fatal = `host error ${message.reason ?? "?"}`;
      finish(1);
    }
    return;
  }
  const wire = new Uint8Array(event.data as ArrayBuffer);
  report.wire_bytes += wire.byteLength;
  const i = index++;
  const bytes = coding.decode(wire);
  const line: Record<string, unknown> = {
    index: i,
    wire_bytes: wire.byteLength,
    envelope_seq: coding.seq(),
    base_seq: coding.base_seq(),
  };
  if (bytes === undefined) {
    const error = coding.error();
    if (error === "") {
      // A based transaction while the resync is pending: dropped, never acked.
      report.skipped += 1;
      line.outcome = "skipped";
      lines.push(JSON.stringify(line));
      return;
    }
    line.outcome = "error";
    line.error = error;
    lines.push(JSON.stringify(line));
    const seq = coding.seq();
    report.errors.push({ index: i, seq, detail: error });
    if (seq === 0 || report.stream_id === "") {
      report.fatal = `coding error on a non-transaction message: ${error}`;
      finish(1);
      return;
    }
    // render-stream-11.md "As built (W11t)": `coding` resyncs.
    ws.send(
      JSON.stringify({
        type: "resync",
        stream_id: report.stream_id,
        seq,
        reason: "coding",
      }),
    );
    report.resyncs.push(seq);
    awaitingFull = true;
    return;
  }
  decoded.push(bytes);
  line.decoded_bytes = bytes.byteLength;
  if (report.stream_id === "") {
    const session = recordMeta(bytes, 8) as { stream?: { stream_id?: string } };
    report.stream_id = session.stream?.stream_id ?? "";
    line.kind = "session";
    lines.push(JSON.stringify(line));
    return;
  }
  const meta = recordMeta(bytes, 0);
  line.kind = meta.type;
  line.outcome = "decoded";
  if (meta.type === "transaction" && unpredictor !== null) {
    if (awaitingFull && meta.encoding !== "full") {
      // W13b: a patch after a predict-check resync predicts from a history this viewer never
      // accepted: dropped, never acked (its LiveCoding base chain is kept).
      report.dropped_awaiting_full += 1;
      line.outcome = "dropped";
      lines.push(JSON.stringify(line));
      return;
    }
    const raw = { offset: 0, byte_length: bytes.byteLength, bytes };
    const rec = decodeRecord(raw, 13, { recordDigest: "deferred" });
    const result =
      rec.errors.length > 0 || rec.record === undefined
        ? { error: rec.errors[0] ?? "no record" }
        : unpredictor.transaction(raw, rec.record.meta as TransactionMeta);
    if ("error" in result) {
      line.outcome = "error";
      line.error = result.error;
      lines.push(JSON.stringify(line));
      const seq = meta.seq as number;
      report.errors.push({ index: i, seq, detail: result.error });
      // render-stream-13.md "Decoding and check order": predict-check resyncs (reason coding).
      ws.send(
        JSON.stringify({
          type: "resync",
          stream_id: report.stream_id,
          seq,
          reason: "coding",
        }),
      );
      report.resyncs.push(seq);
      awaitingFull = true;
      return;
    }
    report.unpredicted += 1;
  }
  lines.push(JSON.stringify(line));
  if (meta.type === "resource") {
    report.resource_records += 1;
  } else if (meta.type === "transaction") {
    report.transactions += 1;
    if (awaitingFull) {
      if (meta.encoding !== "full") return; // a resync-ignored patch (never reached here coded)
      awaitingFull = false;
      report.full_after_resync.push(meta.seq as number);
    }
    const tUs = Math.round(performance.now() * 1000);
    for (const stage of ["received", "applied", "submitted"])
      ws.send(
        JSON.stringify({
          type: "ack",
          stream_id: report.stream_id,
          seq: meta.seq,
          stage,
          t_us: tUs,
        }),
      );
  } else if (meta.type === "end") {
    report.end = true;
    finish(0);
  }
});
ws.addEventListener("close", () => {
  if (!report.end && report.fatal === null)
    report.fatal = "closed before the end record";
  finish(report.end ? 0 : 1);
});
ws.addEventListener("error", () => {
  if (report.fatal === null) report.fatal = "websocket error";
  finish(1);
});
