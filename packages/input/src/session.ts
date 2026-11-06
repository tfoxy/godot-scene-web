// gsw-input/1 sender session: hello/epoch/seq, microtask batching, byte splitting, sync-on-open,
// reset/bye and heartbeat. DOM-free (timers and microtasks come from globalThis). Spec:
// docs/input.md "Session".
//
// Captures (`./keyboard`, `./gamepad`, `./pointer`) never see epochs, seqs or the carrier: they
// write records into an InputSink and, to be healed after a (re)connect, expose their current held
// state as an InputSyncSource. A session is both an InputSink and the thing an InputSyncSource is
// attached to; a consumer that speaks its own wire (couch) implements InputSink itself instead.

import { encodeInputMessage, InputEncodeError, utf8Length } from "./codec";
import {
  INPUT_FORMAT,
  INPUT_RECORD_KINDS,
  type InputMessage,
  type InputRecord,
  type InputSyncScope,
} from "./format";

/**
 * Where a capture writes its records, in order. The session reads a pushed record at the end of
 * the current microtask, so a capture pushes a fresh object and never mutates it afterwards.
 * `push` never throws for a closed session: it drops the record (stale input is never replayed).
 */
export interface InputSink {
  push(record: InputRecord): void;
}

/**
 * One scope's complete held state: a `sync` message without `type`, `epoch` and `seq`. `device` is
 * required for `joypad` (the sender's pad slot, 0..15) and forbidden otherwise; which records
 * `held` may list per scope is in docs/input.md "sync".
 */
export interface InputHeldState {
  scope: InputSyncScope;
  device?: number;
  held: readonly InputRecord[];
}

/**
 * What a capture exposes so a session can heal the host: its held state right now, one entry per
 * scope it owns (keyboard: one `keyboard` entry, even when nothing is held; gamepad: one `joypad`
 * entry per pad slot it currently reports; pointer: one `pointer` entry). Return fresh objects.
 *
 * The session calls it after every `hello` (each `open()`, so a new epoch) and on `sync()`, in
 * attach order. A pointer capture that interns target handles re-declares, inside its `held`, every
 * handle it will reference next: handles do not survive an epoch.
 */
export interface InputSyncSource {
  heldState(): readonly InputHeldState[];
}

export interface InputSessionOptions {
  /** Writes one message text to the carrier. Called synchronously; it should not throw. */
  send(text: string): void;
  /** Idle interval before a `heartbeat`, in ms (default 1000; 0 turns heartbeats off). */
  heartbeatMs?: number;
  /** `hello.source`, stable across this session's reopens (default: 12 random characters). */
  source?: string;
  /** `hello.kinds`, advisory (default none). */
  kinds?: readonly string[];
  /** Byte budget per message, 64..4096 (default 4096). */
  maxBytes?: number;
  /**
   * Called for a pushed record or a sync the encoder refused (`invalid`, or `too-large` for one
   * record or a sync that cannot fit); the rest of the batch is still sent.
   */
  onReject?(
    error: InputEncodeError,
    refused: InputRecord | InputHeldState,
  ): void;
}

export type InputSessionState = "closed" | "open" | "disposed";

export interface InputSessionStats {
  /** Messages handed to `send`. */
  messages: number;
  /** UTF-8 bytes handed to `send`. */
  bytes: number;
  /** Records pushed while not open, or still pending when the session closed or reopened. */
  dropped: number;
  /** Records and syncs refused by the encoder (see `onReject`). */
  rejected: number;
}

export interface InputSession extends InputSink {
  readonly source: string;
  readonly state: InputSessionState;
  /** The current epoch while open, else undefined. */
  readonly epoch: number | undefined;
  /**
   * Attach a capture's held state. While open, its state is synced at once (after any pending
   * records). Returns a detach function; detaching sends nothing (a capture releases through its
   * sink before it goes).
   */
  attach(capture: InputSyncSource): () => void;
  /**
   * The carrier is open: pick a new epoch, send `hello`, then one `sync` per attached scope.
   * Calling it while open reopens (records pending for the old epoch are dropped).
   */
  open(): void;
  /** Send pending records now instead of at the end of the microtask. */
  flush(): void;
  /** Send one `sync` per attached scope now (after pending records). No-op unless open. */
  sync(): void;
  /**
   * Send `reset`: the host releases everything this source holds, in every scope, and the session
   * continues. For focus loss and hidden pages, after the captures released (a safety net). Held
   * state the host should keep pressing comes back with the next `sync()` or `open()`.
   */
  reset(reason?: string): void;
  /**
   * Stop sending. With a `reason` and while open, pending records and then `bye` are sent first
   * (an intentional end); without one, nothing is sent (the carrier is already gone). `open()`
   * may follow.
   */
  close(reason?: string): void;
  /** `close(reason)` (bye while open, default reason `dispose`), detach everything, for good. */
  dispose(reason?: string): void;
  stats(): InputSessionStats;
}

interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  queueMicrotask?(callback: () => void): void;
  crypto?: { getRandomValues(array: Uint32Array): Uint32Array };
}

const host = () => globalThis as unknown as Timers;

function randomU32(): number {
  const crypto = host().crypto;
  if (crypto !== undefined)
    return crypto.getRandomValues(new Uint32Array(1))[0] as number;
  return Math.floor(Math.random() * 0x1_0000_0000);
}

const SOURCE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomSource(): string {
  let out = "";
  for (let i = 0; i < 12; i++)
    out += SOURCE_ALPHABET[randomU32() % SOURCE_ALPHABET.length];
  return out;
}

/** The index `i` of an encoder path `events[i]...`, else undefined. */
function eventIndex(path: string | undefined): number | undefined {
  const match = path === undefined ? null : /^events\[(\d+)\]/.exec(path);
  return match === null ? undefined : Number(match[1]);
}

/**
 * A gsw-input/1 sender over a caller-supplied carrier. Wire it as
 * `const session = createInputSession({ send: (t) => socket.send(t) })`, pass `session` as the
 * captures' sink, `session.attach(capture)` each, call `open()` when the carrier opens and
 * `close()` when it closes, and `reset("blur" | "hidden")` from the page's focus/visibility
 * handlers (this entry is DOM-free, so it does not watch them itself).
 */
export function createInputSession(options: InputSessionOptions): InputSession {
  const { send, onReject } = options;
  const heartbeatMs = options.heartbeatMs ?? 1000;
  const maxBytes = options.maxBytes;
  const kinds = options.kinds ?? [];
  const source = options.source ?? randomSource();
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 0)
    throw new RangeError("heartbeatMs must be a finite number >= 0");
  // Fail on a bad source/kinds/maxBytes now rather than at the first open() (longest epoch).
  encodeInputMessage(
    { type: "hello", format: INPUT_FORMAT, source, epoch: 0xffff_ffff, kinds },
    { maxBytes },
  );

  let state: InputSessionState = "closed";
  let epoch: number | undefined;
  let seq = 0;
  let pending: InputRecord[] = [];
  let flushQueued = false;
  let heartbeat: unknown;
  let lastSent = 0;
  const captures: InputSyncSource[] = [];
  const stats: InputSessionStats = {
    messages: 0,
    bytes: 0,
    dropped: 0,
    rejected: 0,
  };

  const reject = (
    error: InputEncodeError,
    refused: InputRecord | InputHeldState,
  ) => {
    stats.rejected++;
    onReject?.(error, refused);
  };

  const transmit = (texts: readonly string[]) => {
    for (const text of texts) {
      seq++;
      stats.messages++;
      stats.bytes += utf8Length(text);
      lastSent = Date.now();
      send(text);
    }
  };

  // Encode a non-splitting message at the current seq, or throw InputEncodeError.
  const single = (message: InputMessage) =>
    encodeInputMessage(message, { maxBytes });

  const flushPending = () => {
    if (state !== "open" || pending.length === 0) return;
    let records = pending;
    pending = [];
    while (records.length > 0) {
      let texts: string[];
      try {
        texts = encodeInputMessage(
          { type: "events", epoch: epoch as number, seq, events: records },
          { maxBytes },
        );
      } catch (error) {
        if (!(error instanceof InputEncodeError)) throw error;
        // The encoder names the record by path, except an unknown kind (it reports no path).
        let index = eventIndex(error.path);
        if (index === undefined && error.path === undefined)
          index = records.findIndex(
            (record) => !INPUT_RECORD_KINDS.includes(record?.event),
          );
        if (index === undefined || index < 0) throw error;
        reject(error, records[index] as InputRecord);
        records = records.filter((_, i) => i !== index);
        continue;
      }
      transmit(texts);
      return;
    }
  };

  const sendSyncs = (targets: readonly InputSyncSource[]) => {
    for (const capture of targets) {
      for (const held of capture.heldState()) {
        let texts: string[];
        try {
          texts = single({
            type: "sync",
            epoch: epoch as number,
            seq,
            scope: held.scope,
            ...(held.device === undefined ? {} : { device: held.device }),
            held: held.held,
          });
        } catch (error) {
          if (!(error instanceof InputEncodeError)) throw error;
          reject(error, held);
          continue;
        }
        transmit(texts);
      }
    }
  };

  const stopHeartbeat = () => {
    if (heartbeat !== undefined) host().clearTimeout(heartbeat);
    heartbeat = undefined;
  };

  const scheduleHeartbeat = (ms: number) => {
    heartbeat = host().setTimeout(() => {
      heartbeat = undefined;
      if (state !== "open") return;
      const idle = Date.now() - lastSent;
      if (idle >= heartbeatMs) {
        transmit(single({ type: "heartbeat", epoch: epoch as number, seq }));
        scheduleHeartbeat(heartbeatMs);
      } else scheduleHeartbeat(heartbeatMs - idle);
    }, ms);
  };

  const dropPending = () => {
    stats.dropped += pending.length;
    pending = [];
  };

  const assertUsable = () => {
    if (state === "disposed") throw new Error("input session is disposed");
  };

  const session: InputSession = {
    source,
    get state() {
      return state;
    },
    get epoch() {
      return state === "open" ? epoch : undefined;
    },

    push(record) {
      if (state !== "open") {
        stats.dropped++;
        return;
      }
      pending.push(record);
      if (flushQueued) return;
      flushQueued = true;
      const run = () => {
        flushQueued = false;
        flushPending();
      };
      const queue = host().queueMicrotask;
      if (queue !== undefined) queue(run);
      else void Promise.resolve().then(run);
    },

    attach(capture) {
      assertUsable();
      captures.push(capture);
      if (state === "open") {
        flushPending();
        sendSyncs([capture]);
      }
      return () => {
        const index = captures.indexOf(capture);
        if (index >= 0) captures.splice(index, 1);
      };
    },

    open() {
      assertUsable();
      dropPending();
      stopHeartbeat();
      let next = randomU32();
      // A hello repeating the current epoch is a duplicate to the host.
      while (next === epoch) next = randomU32();
      epoch = next;
      seq = 0;
      state = "open";
      transmit(
        single({ type: "hello", format: INPUT_FORMAT, source, epoch, kinds }),
      );
      sendSyncs(captures);
      if (heartbeatMs > 0) scheduleHeartbeat(heartbeatMs);
    },

    flush: flushPending,

    sync() {
      if (state !== "open") return;
      flushPending();
      sendSyncs(captures);
    },

    reset(reason) {
      if (state !== "open") return;
      const message: InputMessage = {
        type: "reset",
        epoch: epoch as number,
        seq: 0,
        ...(reason === undefined ? {} : { reason }),
      };
      single(message); // an invalid reason throws before anything is sent
      flushPending();
      transmit(single({ ...message, seq }));
    },

    close(reason) {
      if (state === "open" && reason !== undefined) {
        const message: InputMessage = {
          type: "bye",
          epoch: epoch as number,
          seq: 0,
          reason,
        };
        single(message);
        flushPending();
        transmit(single({ ...message, seq }));
      }
      dropPending();
      stopHeartbeat();
      if (state === "open") state = "closed";
    },

    dispose(reason = "dispose") {
      if (state === "disposed") return;
      session.close(reason);
      captures.length = 0;
      state = "disposed";
    },

    stats: () => ({ ...stats }),
  };
  return session;
}
