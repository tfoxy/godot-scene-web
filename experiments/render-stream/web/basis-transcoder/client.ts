// GSW's handle on its KTX2 transcoder worker (G8kb, protocol/texture-delivery-design.md Q6 "GSW";
// worker.ts). One worker per page, started once; transcodes are queued in the worker's own message
// order and resolved by id.

import {
  familyBits,
  TARGET_FORMAT,
  type TranscodeReply,
} from "./protocol";

export interface Transcoded {
  /** The Image.Format name of the output (protocol.ts TARGET_FORMAT). */
  format: string;
  width: number;
  height: number;
  levels: number;
  components: number;
  /** Every level, level 0 first; `level0Bytes` of it is level 0. */
  data: Uint8Array<ArrayBuffer>;
  level0Bytes: number;
  /** The worker's transcode time, and the round trip seen from the main thread. */
  ms: number;
  roundTripMs: number;
}

export class TranscodeError extends Error {}

/** The BC families WebGL uploads only at block-aligned sizes: WEBGL_compressed_texture_s3tc,
 * EXT_texture_compression_bptc and _rgtc refuse a level 0 whose width or height is not a multiple
 * of 4 (INVALID_OPERATION; measured in the pinned Chromium, G8kb), where desktop GL, Godot's
 * native target, accepts it. ETC2 and ASTC have no such rule. */
export const BLOCK_ALIGNED_FAMILIES: readonly string[] = ["s3tc", "bptc", "rgtc"];

/** D14's input for one KTX2 in a WebGL context: the stated families, minus the BC ones when the
 * KTX2's level 0 (header pixelWidth/pixelHeight, bytes 20-27) is not 4-aligned, so Godot's rule
 * falls through to the next target it would take without them (at worst RGBA8). */
export function webglFamilies(ktx2: Uint8Array, families: readonly string[]): string[] {
  if (ktx2.length < 28) return [...families];
  const view = new DataView(ktx2.buffer, ktx2.byteOffset, 28);
  const w = view.getUint32(20, true);
  const h = view.getUint32(24, true);
  if (w % 4 === 0 && h % 4 === 0) return [...families];
  return families.filter((f) => !BLOCK_ALIGNED_FAMILIES.includes(f));
}

export class BasisTranscoder {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (r: TranscodeReply) => void; t0: number }
  >();
  readonly ready: Promise<number>;

  /** `workerUrl` and `wasmUrl` are the bundle's basis-worker.js and basis_transcoder.wasm. */
  constructor(workerUrl: string, wasmUrl: string) {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.ready = new Promise<number>((resolve, reject) => {
      this.worker.onmessage = (ev: MessageEvent): void => {
        const msg = ev.data as { type: string; init_ms?: number; error?: string };
        if (msg.type === "ready") {
          this.worker.onmessage = (e: MessageEvent): void => this.reply(e.data as TranscodeReply);
          resolve(msg.init_ms ?? 0);
        } else reject(new TranscodeError(`basis transcoder worker: ${msg.error ?? msg.type}`));
      };
      this.worker.onerror = (ev: ErrorEvent): void =>
        reject(new TranscodeError(`basis transcoder worker: ${ev.message}`));
    });
    this.worker.postMessage({ type: "init", wasmUrl });
  }

  private reply(r: TranscodeReply): void {
    const w = this.waiting.get(r.id);
    if (!w) return;
    this.waiting.delete(r.id);
    w.resolve(r);
  }

  /** Transcode one verified KTX2 (a copy of `bytes` is transferred) to D14's target for
   * `families`, the context's stated gpu_formats (after the mask). Rejects with TranscodeError
   * when basisu refuses it or the target is unknown. */
  async transcode(bytes: Uint8Array, families: readonly string[]): Promise<Transcoded> {
    await this.ready;
    families = webglFamilies(bytes, families);
    const id = this.nextId++;
    const copy = bytes.slice().buffer;
    const t0 = performance.now();
    const r = await new Promise<TranscodeReply>((resolve) => {
      this.waiting.set(id, { resolve, t0 });
      this.worker.postMessage(
        { type: "transcode", id, bytes: copy, families: familyBits(families) },
        [copy],
      );
    });
    const roundTripMs = performance.now() - t0;
    if (!r.ok || !r.data) throw new TranscodeError(r.error ?? "transcode failed");
    const format = TARGET_FORMAT[r.target ?? -1];
    if (!format) throw new TranscodeError(`transcode target ${r.target} has no upload format`);
    return {
      format,
      width: r.width ?? 0,
      height: r.height ?? 0,
      levels: r.levels ?? 0,
      components: r.components ?? 0,
      data: new Uint8Array(r.data),
      level0Bytes: r.level0Bytes ?? 0,
      ms: r.ms ?? 0,
      roundTripMs,
    };
  }

  terminate(): void {
    this.worker.terminate();
    for (const w of this.waiting.values())
      w.resolve({ type: "result", id: 0, ok: false, error: "the transcoder was terminated" });
    this.waiting.clear();
  }
}
