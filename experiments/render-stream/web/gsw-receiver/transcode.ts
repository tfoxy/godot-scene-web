// G8kb (texture-delivery-design.md Q3, Q6 "GSW", D14): a KTX2 (`uastc`) payload's arrival in the
// GSW receiver, shared by file mode (main.ts) and live mode (live.ts). In the payload's fetch
// completion, between frames (G7o2's pattern, so the step transaction never transcodes):
//
//   1. rs-core verifies it: SHA-256 against the hash it was fetched for, then the KTX2 header and
//      its shape against the entry (wasm `stage_ktx2`). A refusal is the payload's, raised where
//      `stage_payload`'s would be (`resource-hash-mismatch`): a perturbed KTX2 is never transcoded.
//   2. The transcoder worker (web/basis-transcoder/) transcodes every level to D14's target for
//      the context's stated gpu_formats: ASTC 4x4, BC7, BC3, ETC2 RGBA (4 components), BC7, ASTC 4x4, BC1,
//      ETC1 (3), else RGBA8.
//   3. wasm `stage_transcoded` stages level 0 (and the accounting's every-level length) like any
//      verified payload; `provide_staged` then moves it to the store when its transaction runs.
//
// A transcode that fails (basisu refuses it, the worker cannot start, or the test fault
// RS_RECEIVER_TRANSCODE_FAULT=fail) is Q3's typed `delivery-transcode-failed`: wasm refuses the
// variant for the session and recomputes the needed set, so D3 falls through to `decoded` (always
// servable), which the caller then fetches. Each one is a `delivery_fallbacks[]` row.

import { BasisTranscoder, type Transcoded } from "../basis-transcoder/client";
import type { GswRs } from "./common";

/** Godot's Image.Format value of each upload name, as applied.json `transcodes[].format` carries
 * it natively (rs_core_ext.cpp logs the Image's format). */
const IMAGE_FORMAT: Record<string, number> = {
  RGBA8: 5,
  DXT1: 17,
  DXT5: 19,
  RGTC_R: 20,
  RGTC_RG: 21,
  BPTC_RGBA: 22,
  ETC2_RGB8: 30,
  ETC2_RGBA8: 31,
  ASTC_4x4: 35,
};

export interface TranscodeRow {
  hash: string;
  ok: boolean;
  error: string | null;
  format: number | null;
  format_name: string | null;
  width: number;
  height: number;
  mipmaps: boolean;
  levels: number;
  components: number;
  data_bytes: number;
  ktx2_bytes: number;
  /** The worker's own transcode time (zstd inflate and every level). */
  transcode_us: number;
  /** Post to reply, seen from the main thread (queueing and both copies included). */
  round_trip_us: number;
  /** RS_RECEIVER_TRANSCODE_LOG=1: SHA-256 of every transcoded level, as uploaded natively. */
  data_sha256: string | null;
  stream: number;
  seq: number | null;
}

export interface FallbackRow {
  stream: number;
  seq: number | null;
  hash: string;
  reason: "delivery-transcode-failed";
  detail: string;
}

export interface KtxOutcome {
  /** A refusal of the payload itself (raised when the transaction is provided), or null. */
  error: string | null;
  /** True when the transcode failed: the variant is refused and wasm's needed set recomputed
   * (`code` is its accept code); the caller re-reads it and fetches what is missing. */
  fallback: boolean;
  code: number;
}

const hex = (b: ArrayBuffer): string =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

let shared: BasisTranscoder | null = null;

/** The page's transcoder worker, started on first use (one per page). */
export function pageTranscoder(): BasisTranscoder {
  if (shared === null) {
    const base = new URL(".", location.href).href;
    shared = new BasisTranscoder(
      `${base}basis-worker.js`,
      `${base}basis/basis_transcoder.wasm`,
    );
    // An init failure surfaces on each transcode as a typed fallback, never unhandled.
    shared.ready.catch(() => {});
  }
  return shared;
}

export class KtxStager {
  readonly transcodes: TranscodeRow[] = [];
  readonly fallbacks: FallbackRow[] = [];

  constructor(
    private readonly g: GswRs,
    private readonly mem: WebAssembly.Memory,
    private readonly opts: { log: boolean; fault: "fail" | null; stream: () => number },
  ) {}

  /** The context's stated gpu_formats (after the mask): D14's input. */
  private families(): string[] {
    try {
      const d = JSON.parse(this.g.delivery_json()) as { gpu_formats?: string };
      return (d.gpu_formats ?? "none").split(",").filter((f) => f !== "none");
    } catch {
      return [];
    }
  }

  private write(bytes: Uint8Array): number {
    const p = this.g.alloc_payload(bytes.length);
    new Uint8Array(this.mem.buffer, p, bytes.length).set(bytes);
    return bytes.length;
  }

  /** Steps 1-3 above for one fetched KTX2 body. */
  async stage(hash: string, bytes: Uint8Array, seq: number | null): Promise<KtxOutcome> {
    const g = this.g;
    if (g.stage_ktx2(this.write(bytes), hash) < 0)
      return { error: g.error(), fallback: false, code: 0 };
    let t: Transcoded;
    try {
      if (this.opts.fault === "fail")
        throw new Error("RS_RECEIVER_TRANSCODE_FAULT=fail (test fault)");
      t = await pageTranscoder().transcode(bytes, this.families());
    } catch (e) {
      return this.fail(hash, bytes.length, seq, e instanceof Error ? e.message : String(e));
    }
    if (g.stage_transcoded(this.write(t.data), hash, t.format) < 0)
      return this.fail(hash, bytes.length, seq, g.error());
    let sha: string | null = null;
    if (this.opts.log) sha = hex(await crypto.subtle.digest("SHA-256", t.data));
    this.transcodes.push({
      hash,
      ok: true,
      error: null,
      format: IMAGE_FORMAT[t.format] ?? null,
      format_name: t.format,
      width: t.width,
      height: t.height,
      mipmaps: t.levels > 1,
      levels: t.levels,
      components: t.components,
      data_bytes: t.data.length,
      ktx2_bytes: bytes.length,
      transcode_us: Math.round(t.ms * 1000),
      round_trip_us: Math.round(t.roundTripMs * 1000),
      data_sha256: sha,
      stream: this.opts.stream(),
      seq,
    });
    return { error: null, fallback: false, code: 0 };
  }

  private fail(hash: string, ktx2Bytes: number, seq: number | null, detail: string): KtxOutcome {
    this.transcodes.push({
      hash,
      ok: false,
      error: detail,
      format: null,
      format_name: null,
      width: 0,
      height: 0,
      mipmaps: false,
      levels: 0,
      components: 0,
      data_bytes: 0,
      ktx2_bytes: ktx2Bytes,
      transcode_us: 0,
      round_trip_us: 0,
      data_sha256: null,
      stream: this.opts.stream(),
      seq,
    });
    this.fallbacks.push({
      stream: this.opts.stream(),
      seq,
      hash,
      reason: "delivery-transcode-failed",
      detail,
    });
    const code = this.g.transcode_failed(hash);
    return {
      error: code < 0 ? this.g.error() : null,
      fallback: code >= 0,
      code,
    };
  }
}
