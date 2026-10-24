// GSW's KTX2 transcoder worker (G8kb, protocol/texture-delivery-design.md D14, Q6 "GSW"): runs
// basis_transcoder.wasm (transcoder.cpp, scripts/build-basis-transcoder.sh) off the main thread.
// A payload is transcoded when it arrives, before the transaction that needs it is applied (G7o2's
// pattern: the main thread's step transaction never transcodes).
//
// Messages in:  { type: "init", wasmUrl }                        -> { type: "ready" } | { type: "error" }
//               { type: "transcode", id, bytes, families }       -> TranscodeReply
// `bytes` is transferred both ways: the KTX2 in, every transcoded level out. `families` is
// transcoder.cpp's bit set of the context's gpu_formats. The worker never sees a hash: the main
// thread verifies the payload in rs-core before it posts it here (stage_ktx2), and only a payload
// that verified is transcoded.

import type { TranscodeReply, TranscodeRequest } from "./protocol";

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  bt_init: () => void;
  bt_alloc: (n: number) => number;
  bt_free: (p: number) => void;
  bt_transcode: (p: number, n: number, families: number) => number;
  bt_out_ptr: () => number;
  bt_out_len: () => number;
  bt_info: (i: number) => number;
  bt_error_code: () => number;
}

const STAGES = ["", "init", "shape", "start", "level", "alloc"];

let ex: Exports | null = null;

/** Every import the standalone wasm names: the memory-growth notice is a no-op, and WASI's file
 * calls (libc's stdio, never reached on the transcode path) return ENOSYS. */
function imports(module: WebAssembly.Module): WebAssembly.Imports {
  const out: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== "function") throw new Error(`basis transcoder imports ${imp.module}.${imp.name} (${imp.kind})`);
    out[imp.module] ??= {};
    out[imp.module][imp.name] = imp.name === "emscripten_notify_memory_growth" ? () => {} : () => 52;
  }
  return out;
}

async function init(wasmUrl: string): Promise<void> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`GET ${wasmUrl}: ${response.status}`);
  const module = await WebAssembly.compile(await response.arrayBuffer());
  const instance = await WebAssembly.instantiate(module, imports(module));
  const e = instance.exports as unknown as Exports;
  e._initialize?.();
  const t0 = performance.now();
  e.bt_init();
  ex = e;
  (self as unknown as Worker).postMessage({ type: "ready", init_ms: performance.now() - t0 });
}

function transcode(req: TranscodeRequest): TranscodeReply {
  const e = ex;
  if (!e) return { type: "result", id: req.id, ok: false, error: "the transcoder is not initialized" };
  const input = new Uint8Array(req.bytes);
  const p = e.bt_alloc(input.length);
  new Uint8Array(e.memory.buffer, p, input.length).set(input);
  const t0 = performance.now();
  const rc = e.bt_transcode(p, input.length, req.families);
  const ms = performance.now() - t0;
  e.bt_free(p);
  if (rc !== 0)
    return {
      type: "result",
      id: req.id,
      ok: false,
      error: `basisu ktx2_transcoder failed at ${STAGES[e.bt_error_code()] ?? e.bt_error_code()}`,
      ms,
    };
  const len = e.bt_out_len();
  const data = new Uint8Array(len);
  data.set(new Uint8Array(e.memory.buffer, e.bt_out_ptr(), len));
  return {
    type: "result",
    id: req.id,
    ok: true,
    width: e.bt_info(0),
    height: e.bt_info(1),
    levels: e.bt_info(2),
    target: e.bt_info(3),
    components: e.bt_info(4),
    level0Bytes: e.bt_info(5),
    data: data.buffer,
    ms,
  };
}

self.onmessage = (ev: MessageEvent): void => {
  const msg = ev.data as { type: string } & Record<string, unknown>;
  if (msg.type === "init") {
    init(String(msg.wasmUrl)).catch((err: unknown) => {
      (self as unknown as Worker).postMessage({ type: "error", error: String(err) });
    });
    return;
  }
  if (msg.type === "transcode") {
    const req = msg as unknown as TranscodeRequest;
    let reply: TranscodeReply;
    try {
      reply = transcode(req);
    } catch (err) {
      reply = { type: "result", id: req.id, ok: false, error: `transcoder trapped: ${String(err)}` };
    }
    const transfer = reply.ok && reply.data ? [reply.data] : [];
    (self as unknown as Worker).postMessage(reply, transfer);
  }
};
