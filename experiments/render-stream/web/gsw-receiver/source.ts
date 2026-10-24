// GSW receiver sources (gate7-design.md Q5, G7a): the recording (file mode) and the payload
// fetcher. The fetcher is the native receiver's file-mode one: a payload the wire names and the
// receiver does not hold is read from the store (`<store>/sha256/<hash>.<ext>`), one at a time, and
// that read is a fetch (`source: "directory"`). Payload bytes cross into wasm once and are verified
// there (Q14c `provide`); this file never inspects them. The browser's HTTP cache stands in for
// the native cache directory (as the web export's does, Q4), so a GSW leg has no cache hits.
//
// Live mode (the /7 WebSocket client, credit, the authenticated HTTP fetcher) is G7l's.

export interface FetchEntry {
  stream: number;
  seq: number;
  hash: string;
  source: "directory";
  status: null;
  bytes: number;
  start_us: number;
  end_us: number;
  verified: boolean;
  kind: "texture" | "mesh" | "shader" | "texture-ktx2";
}

// G8kb: kind 3 is a KTX2 texture variant (`uastc`, `<hash>.ktx2` in the store, index type
// `texture-ktx2`).
export const KIND_EXT = ["grt", "grm", "grp", "ktx2"] as const;
export const KIND_NAME = ["texture", "mesh", "shader", "texture-ktx2"] as const;

export class SourceError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
  }
}

/** The whole recording, read once before the session (Q14c step 1, outside every timer). */
export async function readRecording(url: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new SourceError("recording-unreadable", `${url}: ${String(e)}`);
  }
  if (!res.ok)
    throw new SourceError("recording-unreadable", `${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Sequential store reads, with the native receiver's accounting. */
export class StoreFetcher {
  readonly fetches: FetchEntry[] = [];
  readonly distinct = new Set<string>();

  constructor(
    private readonly store: string | null,
    private readonly delayMs: number,
    private readonly keepLog: boolean,
  ) {}

  /** One payload: its bytes (unverified; wasm `provide` verifies) and the fetch's duration. */
  async fetch(
    seq: number,
    hash: string,
    kind: number,
  ): Promise<{ bytes: Uint8Array; us: number }> {
    if (this.store === null)
      throw new SourceError(
        "resource-unavailable",
        `payload ${hash} is not held and RS_RECEIVER_STORE_DIR is unset`,
      );
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const url = `${this.store}/sha256/${hash}.${KIND_EXT[kind] ?? "grt"}`;
    const start = performance.now();
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new SourceError("resource-unavailable", `${url}: ${String(e)}`);
    }
    if (!res.ok)
      throw new SourceError(
        "resource-unavailable",
        `${url}: HTTP ${res.status}`,
      );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const end = performance.now();
    this.distinct.add(hash);
    if (this.keepLog)
      this.fetches.push({
        stream: 1,
        seq,
        hash,
        source: "directory",
        status: null,
        bytes: bytes.length,
        start_us: Math.round(start * 1000),
        end_us: Math.round(end * 1000),
        verified: false,
        kind: KIND_NAME[kind] ?? "texture",
      });
    return { bytes, us: (end - start) * 1000 };
  }

  /** Marks the newest fetch of `hash` verified (after wasm `provide` accepted it). */
  verified(hash: string): void {
    for (let i = this.fetches.length - 1; i >= 0; i--) {
      if (this.fetches[i].hash === hash) {
        this.fetches[i].verified = true;
        return;
      }
    }
  }
}
