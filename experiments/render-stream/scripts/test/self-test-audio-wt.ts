// Audio carriage framing, fallback and cross-stream ordering, with real Web Streams.
import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import type { AudioContextLike } from "../../../../packages/render-stream-client/src/audio/mainEngine";
import { openAudioTrack } from "../../../../packages/render-stream-client/src/audio/session";
import { createWebTransportTransport } from "../../../../packages/render-stream-client/src/audio/webtransport";
import {
  encodeBlock,
  keyId,
} from "../../../../packages/render-stream-client/src/audio/wire";

let passed = 0;
const check = (ok: unknown, message: string) => {
  assert.ok(ok, message);
  passed++;
};
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("audio WT condition timed out");
}
const key = keyId("event:/wt-test");
const bank = "a".repeat(32);
const hash = "b".repeat(64);
const bytes = (parts: Uint8Array[]) => {
  const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    b.set(p, at);
    at += p.length;
  }
  return b;
};
function block(kind = 1, flags = 3) {
  return encodeBlock(
    {
      kind,
      flags,
      lane: kind === 1 ? 0 : 1,
      codec: 0,
      channels: 2,
      stream: 1,
      block: 0,
      frames: kind === 1 ? 1 : 512,
      rate: 48000,
      made_us: 0n,
      due_us: 0n,
      sent_us: 0n,
    },
    new Uint8Array(kind === 1 ? 4 : 2048),
  );
}
function frame(b: Uint8Array) {
  const n = new Uint8Array(4);
  new DataView(n.buffer).setUint32(0, b.length, true);
  return bytes([n, b]);
}
function textFrame(text: string) {
  const b = frame(new TextEncoder().encode(text));
  return bytes([Uint8Array.of(1), b]);
}
function media(kind: number, b = block(kind === 2 ? 1 : 2)) {
  return bytes([
    Uint8Array.of(kind),
    kind === 2
      ? Uint8Array.from(key.match(/../g)!, (x) => Number.parseInt(x, 16))
      : Uint8Array.of(1),
    frame(b),
  ]);
}
class FakeWT {
  static all: FakeWT[] = [];
  ready = Promise.resolve();
  finish!: (info: { closeCode: number; reason: string }) => void;
  closed = new Promise<{ closeCode: number; reason: string }>((r) => {
    this.finish = r;
  });
  live!: ReadableStreamDefaultController<Uint8Array>;
  incoming!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  incomingUnidirectionalStreams = new ReadableStream<
    ReadableStream<Uint8Array>
  >({
    start: (c) => {
      this.incoming = c;
    },
  });
  writes: Uint8Array[] = [];
  uplinks: Uint8Array[][] = [];
  done = false;
  constructor(readonly url: string) {
    FakeWT.all.push(this);
  }
  async createBidirectionalStream() {
    return {
      readable: new ReadableStream<Uint8Array>({
        start: (c) => {
          this.live = c;
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write: (b) => {
          this.writes.push(b);
        },
      }),
    };
  }
  async createUnidirectionalStream() {
    const chunks: Uint8Array[] = [];
    this.uplinks.push(chunks);
    return new WritableStream<Uint8Array>({
      write: (b) => {
        chunks.push(b);
      },
    });
  }
  send(b: Uint8Array, reset?: number) {
    this.incoming.enqueue(
      new ReadableStream<Uint8Array>({
        start(c) {
          // Split every field, length and PCM across chunk boundaries.
          for (let i = 0; i < b.length; i += 3) c.enqueue(b.slice(i, i + 3));
          if (reset === undefined) c.close();
          else setTimeout(() => c.error({ streamErrorCode: reset }), 10);
        },
      }),
    );
  }
  hold(b: Uint8Array) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.incoming.enqueue(
      new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          c.enqueue(b);
        },
      }),
    );
    return (code: number) => controller.error({ streamErrorCode: code });
  }
  close(info = { closeCode: 1000, reason: "done" }) {
    if (this.done) return;
    this.done = true;
    this.live?.close();
    this.incoming.close();
    this.finish(info);
  }
  text(value: unknown) {
    this.live.enqueue(textFrame(JSON.stringify(value)));
  }
}
Object.assign(globalThis, { WebTransport: FakeWT, isSecureContext: true });
const endpoint = {
  url: "ws://localhost/render-stream",
  resourceBase: "",
  token: null,
  protocol: 13 as const,
  webTransport: { url: "https://localhost:443/render-stream" },
};
const received: string[] = [];
const transport = createWebTransportTransport({
  onTake: (k, b) => received.push(`${k}:${b.byteLength}`),
  onLane: (b) => received.push(`lane:${b.byteLength}`),
})(endpoint, "render-stream-audio.1", { open() {}, message() {}, close() {} });
await until(() => FakeWT.all[0]?.live !== undefined);
const first = FakeWT.all[0];
transport.send("hello");
transport.send("clock");
first.send(media(2));
first.send(media(3));
await until(() => received.length === 2 && first.uplinks.length > 0);
check(
  received.includes(`${key}:52`),
  "take header keys media without take-start",
);
check(received.includes("lane:2096"), "lane header and fragmented framing");
check(
  first.writes[0][0] === 0 && first.writes[1][0] === 1,
  "hello uses 0x00 live framing",
);
check(first.uplinks[0][0][0] === 0x10, "client text uses 0x10 batches");
transport.close(1000, "done");
await until(() => first.done);

const ready = {
  type: "track-ready",
  protocol: "render-stream-audio/1",
  source: 1,
  kind: "audio",
  format: "gsw-audio/1",
  down_format: null,
  keepalive_ms: 30000,
  max_message_bytes: 4096,
  rate: { messages_per_second: 1000, burst: 2000 },
  audio: {
    clock_us: 0,
    rate: 48000,
    lane_block_frames: 512,
    codec: "pcm16",
    godot: true,
    fmod: true,
    lanes: [{ id: 1, name: "music", group: "Music" }],
  },
};
let loaded = 0;
const aborted: number[] = [];
const appended: number[] = [];
const noop = () => {};
const runtime = {
  engine: {
    stopLane: noop,
    gate: noop,
    play: noop,
    setGroups: noop,
    loadTake: () => {
      loaded++;
    },
    beginTake: noop,
    abortTake: (stream: number) => {
      aborted.push(stream);
    },
    takeBlock: () => {
      appended.push(1);
    },
    laneBlock: noop,
    reset: noop,
    dispose: noop,
    setSampleActive: noop,
  },
  sampleEngine: () => ({
    snapshot: noop,
    handle: noop,
    reset: noop,
    dispose: noop,
  }),
};
const options = {
  url: endpoint.url,
  webTransport: { ...endpoint.webTransport, features: 2 },
  carrier: "webtransport" as const,
  credential: "c".repeat(64),
  context: { currentTime: 0 } as AudioContextLike,
  reconnect: false as const,
};
const track = openAudioTrack(options, runtime);
await until(() => FakeWT.all[1]?.live !== undefined);
const wt = FakeWT.all[1];
wt.send(media(2)); // reliable media before ready, snapshot and take-start
await delay(10);
wt.text(ready);
wt.text({
  type: "audio-state",
  t: 0,
  s: 0,
  godot: { buses: [], voices: [] },
  fmod: { bankset: bank, groups: {}, lanes: [] },
});
wt.text({
  type: "take-start",
  t: 0,
  s: 0,
  bankset: bank,
  key_id: key,
  stream: 1,
  frames: 1,
});
wt.text({ type: "take-ready", t: 0, s: 0, key_id: key, stream: 1, hash });
await until(() => loaded === 1 || track.state === "closed");
check(
  track.state === "open" && track.store.peek(bank, key)?.frames === 1,
  "take before controls assembles by stream key",
);
// The control stream can reach take-ready before this take stream delivers a block.
wt.text({
  type: "take-start",
  t: 0,
  s: 0,
  bankset: bank,
  key_id: key,
  stream: 2,
  frames: 1,
});
wt.text({ type: "take-ready", t: 0, s: 0, key_id: key, stream: 2, hash });
await delay(10);
const second = block();
new DataView(second.buffer).setUint32(8, 2, true);
wt.send(media(2, second));
await until(() => loaded === 2 || track.state === "closed");
check(
  track.state === "open" && loaded === 2,
  "take-ready waits for last block across streams",
);
wt.send(media(3), 2);
await delay(20);
check(track.state === "open", "stale lane reset preserves the session");
wt.send(new Uint8Array(), 2);
await delay(20);
check(
  track.state === "open",
  "stale reset before lane header preserves the session",
);
track.close();

for (const textFirst of [false, true]) {
  const peersBefore = FakeWT.all.length;
  const abandoned = openAudioTrack(options, runtime);
  await until(() => FakeWT.all.length > peersBefore);
  const peer = FakeWT.all.at(-1)!;
  await until(() => peer.live !== undefined);
  peer.text(ready);
  peer.text({
    type: "audio-state",
    t: 0,
    s: 0,
    godot: { buses: [], voices: [] },
    fmod: { bankset: bank, groups: {}, lanes: [] },
  });
  peer.text({
    type: "take-start",
    t: 0,
    s: 0,
    bankset: bank,
    key_id: key,
    stream: 1,
    frames: 2,
  });
  const before = appended.length;
  const abortsBefore = aborted.length;
  const reset = peer.hold(media(2, block(1, 1)));
  await until(() => appended.length > before);
  const unavailable = () =>
    peer.text({
      type: "take-unavailable",
      t: 0,
      s: 0,
      key_id: key,
      reason: "link-down",
    });
  if (textFirst) {
    unavailable();
    await until(() => aborted.length > abortsBefore);
  }
  reset(3);
  await delay(20);
  check(
    abandoned.state === "open",
    `abandoned reset preserves session (text first: ${textFirst})`,
  );
  check(
    aborted.length === abortsBefore + 1,
    "partial take discarded once on text or reset",
  );
  check(!abandoned.store.peek(bank, key), "partial take never cached");
  if (!textFirst) unavailable();
  await delay(10);
  check(aborted.length === abortsBefore + 1, "late unavailable is idempotent");
  // A fresh take on the same session remains usable after abandonment.
  peer.text({
    type: "take-start",
    t: 0,
    s: 0,
    bankset: bank,
    key_id: key,
    stream: 2,
    frames: 1,
  });
  const next = block();
  new DataView(next.buffer).setUint32(8, 2, true);
  peer.send(media(2, next));
  peer.text({ type: "take-ready", t: 0, s: 0, key_id: key, stream: 2, hash });
  await until(
    () => !!abandoned.store.peek(bank, key) || abandoned.state === "closed",
  );
  check(
    abandoned.state === "open" && abandoned.store.peek(bank, key)?.frames === 1,
    "later take completes after abandonment",
  );
  abandoned.close();
}

for (const [name, payload, reset] of [
  ["take reset cannot silently drop reliable media", media(2, block(1, 1)), 2],
  ["take FIN requires last", media(2, block(1, 1)), undefined],
  ["lane stream header must match each block", media(3, block(1)), undefined],
  [
    "more than eight lane blocks refused",
    bytes([media(3), ...Array.from({ length: 8 }, () => frame(block(2)))]),
    undefined,
  ],
] as const) {
  let code = 0;
  const link = createWebTransportTransport()(
    endpoint,
    "render-stream-audio.1",
    {
      open() {},
      message() {},
      close(c) {
        code = c;
      },
    },
  );
  const invalid = FakeWT.all.at(-1)!;
  await until(() => invalid.live !== undefined);
  invalid.send(payload, reset);
  await until(() => code !== 0);
  check(code === 1002, name);
  link.close(1000, "done");
}

class FakeWS {
  static count = 0;
  binaryType = "";
  onopen?: () => void;
  onclose?: (e: { code: number; reason: string }) => void;
  constructor() {
    FakeWS.count++;
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close(code = 1000, reason = "") {
    this.onclose?.({ code, reason });
  }
}
Object.assign(globalThis, {
  WebSocket: FakeWS,
  location: { href: "http://localhost/" },
});
for (const features of [0, 1]) {
  const before = FakeWT.all.length;
  const fallback = openAudioTrack(
    { ...options, webTransport: { ...options.webTransport, features } },
    runtime,
  );
  await delay(10);
  check(
    FakeWT.all.length === before && FakeWS.count > 0,
    `missing audio bit ${features} uses WS`,
  );
  fallback.close();
}
console.log(`${passed} passed, 0 failed, 0 skipped`);
