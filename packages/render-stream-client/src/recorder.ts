// The client recorder.
//
// A bounded ring of the decoded messages a live client received since its last full transaction,
// plus the resource payloads it fetched, exported as a recording. A client that never asks builds
// no recorder: `createRenderStreamClient` without `recorder` takes the pure-client path (no ring,
// no copies).
//
// The recording is the wire's own format: the first message (the decoded session, which already
// carries the magic) followed by every later record, in receipt order. The decoder has already
// reversed the live coding, so these bytes are what `rs-core-check validate` accepts; they equal
// the host's tap from the same full (the capture's live tap holds the uncoded messages too).
//
// Bounding. A full transaction re-establishes the whole state, so the records before it are
// dropped (all but those since the transaction before it: the full's own `item_meta`, which goes
// immediately before it, and inline payloads) and the ring restarts at the full (drop-oldest at the only place a drop is safe: a
// delta depends on every record before it, so dropping a delta would make the recording
// unplayable). Between fulls the ring grows with the stream; `maxBytes` caps it and, once
// exceeded, recording stops (`overflow`), keeping the recording valid up to that point rather
// than corrupting it by dropping the oldest delta. The next full that fits restarts the ring and
// recording resumes from it. Fetched payloads are bounded separately by `maxResourceBytes`
// (drop-oldest by receipt order there: a missing body only makes the replay fetch again, it never
// breaks the recording).
//
// The defaults are sized for a phone tab, where the recorder's JS copies sit beside the wasm
// core's own heap: 16 MiB of messages holds an STS2 full transaction (about 1.5 MB) plus its
// deltas many times over, and 32 MiB of payloads keeps the recent bodies (STS2's texture set is
// hundreds of MB, so no default could hold it whole; a replay re-fetches what was dropped). A
// desktop debugging session that wants long or self-contained recordings passes larger caps.

/** What one decoded record was. `transaction` is a full or a patch; the rest are not. */
export type RecordKind = "transaction" | "resource" | "item_meta" | "end";

export interface RecorderOptions {
  /** The most message bytes the ring may hold (session + records since the last full), before
   * recording stops until the next full. Default 16 MiB (sized for a phone tab; raise it for a
   * long desktop recording). */
  maxBytes?: number;
  /** The most fetched payload bytes to keep (drop-oldest beyond it). Default 32 MiB (a replay
   * re-fetches a dropped body from the host). */
  maxResourceBytes?: number;
}

/** The export: a recording (the decoded messages) and the fetched payloads it names. */
export interface Recording {
  /** The decoded recording (magic + session + records since the last full), or null before the
   * session arrived. It replays through `rs-core-check validate` and equals the host's tap from
   * the same full. */
  bytes: Uint8Array | null;
  /** Fetched resource bodies by hex SHA-256, so a later replay can apply without the host. A
   * snapshot: later fetches do not change an exported map. */
  resources: ReadonlyMap<string, Uint8Array>;
  /** Records captured (transactions + resources + item_meta + end). */
  records: number;
  /** The seq of the last full the recording starts at (0: the session). */
  fullSeq: number;
  /** True when `maxBytes` stopped recording since the last full (the recording is valid but
   * shorter than the stream). */
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
  /** Whether recording is on (false from the bound stopping it until the next full that fits). */
  readonly active: boolean;
}

const DEFAULT_MAX_BYTES = 16 << 20;
const DEFAULT_MAX_RESOURCE_BYTES = 32 << 20;

export function createRecorder(
  options: RecorderOptions = {},
): RenderStreamRecorder {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxResourceBytes =
    options.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES;

  let sessionBytes: Uint8Array | null = null;
  /** Records since the last full (with the records that preceded it since the transaction
   * before it). */
  let records: Uint8Array[] = [];
  /** How many of `records`' last entries arrived after the last transaction. */
  let sinceTx = 0;
  /** While stopped: the non-transaction records since the last transaction (the next full's). */
  let preamble: Uint8Array[] = [];
  let preambleBytes = 0;
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
      records = [];
      sinceTx = 0;
      preamble = [];
      preambleBytes = 0;
      recordsBytes = 0;
      recordsCount = 0;
      fullSeq = 0;
      overflow = false;
    },

    record(
      bytes: Uint8Array,
      kind: RecordKind,
      full: boolean,
      seq: number,
    ): void {
      if (sessionBytes === null) return;
      const isTx = kind === "transaction";
      if (full) {
        // A full re-establishes the whole state: the deltas before it are redundant, and the
        // recording restarts at it (and resumes after an overflow). The records since the last
        // transaction stay: they precede this full and belong to it (its `item_meta` goes
        // immediately before it, and the inline payloads it names).
        const prefix = overflow
          ? preamble
          : records.slice(records.length - sinceTx);
        let prefixBytes = 0;
        for (const r of prefix) prefixBytes += r.byteLength;
        if (
          sessionBytes.byteLength + prefixBytes + bytes.byteLength >
          maxBytes
        ) {
          // Not even the full fits: stop, and keep the valid recording so far.
          overflow = true;
          preamble = [];
          preambleBytes = 0;
          return;
        }
        if (overflow) recordsCount += prefix.length;
        records = prefix;
        records.push(bytes);
        recordsBytes = prefixBytes + bytes.byteLength;
        recordsCount++;
        fullSeq = seq;
        overflow = false;
        preamble = [];
        preambleBytes = 0;
        sinceTx = 0;
        return;
      }
      if (overflow) {
        // Stopped: only the records the next full may need are kept (those since the last
        // transaction, within the bound).
        if (isTx) {
          preamble = [];
          preambleBytes = 0;
        } else if (
          sessionBytes.byteLength + preambleBytes + bytes.byteLength <=
          maxBytes
        ) {
          preamble.push(bytes);
          preambleBytes += bytes.byteLength;
        }
        return;
      }
      // The bound covers the whole recording (session + records): the export is always replayable,
      // so past it recording stops rather than drop the oldest delta.
      const nextTotal =
        sessionBytes.byteLength + recordsBytes + bytes.byteLength;
      if (nextTotal > maxBytes) {
        overflow = true;
        // Drop nothing that already arrived (the recording stays valid up to here), and stop.
        // A non-transaction record that did not fit may still precede the next full.
        if (!isTx) {
          preamble = records.slice(records.length - sinceTx);
          preambleBytes = 0;
          for (const r of preamble) preambleBytes += r.byteLength;
          if (
            sessionBytes.byteLength + preambleBytes + bytes.byteLength <=
            maxBytes
          ) {
            preamble.push(bytes);
            preambleBytes += bytes.byteLength;
          }
        }
        return;
      }
      records.push(bytes);
      recordsBytes += bytes.byteLength;
      recordsCount++;
      sinceTx = isTx ? 0 : sinceTx + 1;
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
        return {
          bytes: null,
          resources: new Map(resources),
          records: 0,
          fullSeq,
          overflow,
        };
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
        resources: new Map(resources),
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
