// REC1 (client-extensions-design.md §6 "Increments", the REC1 row): the client recorder.
//
// A bounded ring of the decoded messages a live client received since its last full transaction,
// plus the resource payloads it fetched, exported as a recording. A client that never asks builds
// no recorder: `createRenderStreamClient` without `recorder` takes the pure-client path (no ring,
// no copies), exactly as before.
//
// The recording is the wire's own format: the first message (the decoded session, which already
// carries the magic) followed by every later record, in receipt order. The decoder has already
// reversed the live coding, so these bytes are what `rs-core-check validate` accepts; they equal
// the host's tap from the same full (the capture's live tap holds the uncoded messages too).
//
// Bounding. A full transaction re-establishes the whole state, so the records before it are
// dropped and the ring restarts at the full (drop-oldest at the only place a drop is safe: a
// delta depends on every record before it, so dropping a delta would make the recording
// unplayable). Between fulls the ring grows with the stream; `maxBytes` caps it and, once
// exceeded, recording stops (`overflow`), keeping the recording valid up to that point rather
// than corrupting it by dropping the oldest delta. Fetched payloads are bounded separately by
// `maxResourceBytes` (drop-oldest by receipt order there: a missing body only makes the replay
// fetch again, it never breaks the recording).

/** What one decoded record was. `transaction` is a full or a patch; the rest are not. */
export type RecordKind = "transaction" | "resource" | "item_meta" | "end";

export interface RecorderOptions {
  /** The most message bytes the ring may hold (session + records since the last full), before
   * recording stops. Default 64 MiB. */
  maxBytes?: number;
  /** The most fetched payload bytes to keep (drop-oldest beyond it). Default 256 MiB. */
  maxResourceBytes?: number;
}

/** The export: a recording (the decoded messages) and the fetched payloads it names. */
export interface Recording {
  /** The decoded recording (magic + session + records since the last full), or null before the
   * session arrived. It replays through `rs-core-check validate` and equals the host's tap from
   * the same full. */
  bytes: Uint8Array | null;
  /** Fetched resource bodies by hex SHA-256, so a later replay can apply without the host. */
  resources: ReadonlyMap<string, Uint8Array>;
  /** Records captured (transactions + resources + item_meta + end). */
  records: number;
  /** The seq of the last full the recording starts at (0: the session). */
  fullSeq: number;
  /** True when `maxBytes` stopped recording (the recording is valid but shorter than the stream). */
  overflow: boolean;
}

export interface RenderStreamRecorder {
  /** The decoded session message (magic + session record), once per session. Resets the ring. */
  session(bytes: Uint8Array): void;
  /** One decoded record in receipt order. `full`: a full transaction, and `seq` its seq (the ring
   * restarts at it). */
  record(bytes: Uint8Array, kind: RecordKind, full: boolean, seq: number): void;
  /** A fetched payload's body (hex SHA-256). */
  resource(hash: string, body: Uint8Array): void;
  /** The recording so far. */
  export(): Recording;
  /** Message bytes held now (session + records). */
  readonly bytes: number;
  /** Whether recording is still on (false once the bound stopped it). */
  readonly active: boolean;
}

const DEFAULT_MAX_BYTES = 64 << 20;
const DEFAULT_MAX_RESOURCE_BYTES = 256 << 20;

export function createRecorder(options: RecorderOptions = {}): RenderStreamRecorder {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxResourceBytes = options.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES;

  let sessionBytes: Uint8Array | null = null;
  /** Records since the last full. */
  const records: Uint8Array[] = [];
  const resources = new Map<string, Uint8Array>();
  const resourceOrder: string[] = [];
  let recordsBytes = 0;
  let resourceBytes = 0;
  let recordsCount = 0;
  let fullSeq = 0;
  let overflow = false;

  const dropResourcesTo = (target: number): void => {
    while (resourceBytes > target && resourceOrder.length > 0) {
      const hash = resourceOrder.shift() as string;
      const body = resources.get(hash);
      if (body !== undefined) {
        resourceBytes -= body.byteLength;
        resources.delete(hash);
      }
    }
  };

  return {
    session(bytes: Uint8Array): void {
      sessionBytes = bytes;
      records.length = 0;
      recordsBytes = 0;
      recordsCount = 0;
      fullSeq = 0;
      overflow = false;
    },

    record(bytes: Uint8Array, kind: RecordKind, full: boolean, seq: number): void {
      if (overflow || sessionBytes === null) return;
      if (full) {
        // A full re-establishes the whole state: the deltas before it are redundant, and the
        // recording restarts at it.
        records.length = 0;
        recordsBytes = 0;
        fullSeq = seq;
      }
      // The bound covers the whole recording (session + records): the export is always replayable,
      // so past it recording stops rather than drop the oldest delta.
      const nextTotal = sessionBytes.byteLength + recordsBytes + bytes.byteLength;
      if (nextTotal > maxBytes) {
        overflow = true;
        // Drop nothing that already arrived (the recording stays valid up to here), and stop.
        return;
      }
      records.push(bytes);
      recordsBytes += bytes.byteLength;
      recordsCount++;
      void kind;
    },

    resource(hash: string, body: Uint8Array): void {
      if (hash === "" || body.byteLength === 0) return;
      const prev = resources.get(hash);
      if (prev !== undefined) {
        resourceBytes -= prev.byteLength;
      } else {
        resourceOrder.push(hash);
      }
      resources.set(hash, body);
      resourceBytes += body.byteLength;
      dropResourcesTo(maxResourceBytes);
    },

    export(): Recording {
      if (sessionBytes === null)
        return { bytes: null, resources, records: 0, fullSeq, overflow };
      const total = sessionBytes.byteLength + recordsBytes;
      const out = new Uint8Array(total);
      out.set(sessionBytes, 0);
      let at = sessionBytes.byteLength;
      for (const r of records) {
        out.set(r, at);
        at += r.byteLength;
      }
      return {
        bytes: out,
        resources,
        records: recordsCount,
        fullSeq,
        overflow,
      };
    },

    get bytes(): number {
      return (sessionBytes?.byteLength ?? 0) + recordsBytes;
    },

    get active(): boolean {
      return !overflow;
    },
  };
}
