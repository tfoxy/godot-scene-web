import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  RenderStreamTransportEvents,
  RenderStreamTransportFactory,
} from "../../../../packages/render-stream-client/src/transport";
import { type DelayClock, delayTransport } from "./delay-transport";

function setup() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: DelayClock = {
    now: () => now,
    setTimeout(fn, ms) {
      timers.set(++id, { at: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer) {
      timers.delete(timer as unknown as number);
    },
  };
  function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = until;
  }
  const sent: { value: string; at: number }[] = [];
  const received: { value: ArrayBuffer | string; at: number }[] = [];
  let events!: RenderStreamTransportEvents;
  let opens = 0;
  let closes = 0;
  let gets = 0;
  const factory: RenderStreamTransportFactory = (_endpoint, _protocol, on) => {
    events = on;
    return {
      carrier: "websocket",
      send: (value) => {
        sent.push({ value, at: now });
      },
      close: (code, reason) => on.close(code, reason),
      fetchResource: async () => {
        gets++;
        return { status: 200, body: null };
      },
    };
  };
  const transport = delayTransport(factory, 24, clock)(
    {
      url: "ws://localhost",
      resourceBase: "http://localhost",
      token: null,
      protocol: 18,
    },
    "render-stream/18",
    {
      open: () => {
        opens++;
      },
      message: (value) => {
        received.push({ value, at: now });
      },
      close: () => {
        closes++;
      },
    },
  );
  return {
    advance,
    transport,
    events,
    sent,
    received,
    timers,
    counts: () => ({ opens, closes, gets }),
  };
}

test("delays both FIFOs by one way, preserves bursts and payload identity", () => {
  const s = setup();
  const binary = new ArrayBuffer(3);
  s.events.open();
  assert.equal(s.counts().opens, 1);
  s.transport.send("a");
  s.transport.send("b");
  s.events.message(binary);
  s.events.message("hello");
  assert.equal(s.timers.size, 2, "one timer per direction");
  s.advance(10);
  s.transport.send("c");
  s.events.message("last");
  s.advance(13);
  assert.equal(s.sent.length, 0);
  assert.equal(s.received.length, 0);
  s.advance(1);
  assert.deepEqual(s.sent, [
    { value: "a", at: 24 },
    { value: "b", at: 24 },
  ]);
  assert.deepEqual(s.received, [
    { value: binary, at: 24 },
    { value: "hello", at: 24 },
  ]);
  assert.equal(s.received[0].value, binary);
  s.advance(10);
  assert.deepEqual(s.sent.at(-1), { value: "c", at: 34 });
  assert.deepEqual(s.received.at(-1), { value: "last", at: 34 });
});

for (const remote of [false, true]) {
  test(`${remote ? "remote" : "local"} close cancels both pending directions`, () => {
    const s = setup();
    s.transport.send("queued");
    s.events.message("queued");
    if (remote) s.events.close(1000, "done");
    else s.transport.close(1000, "done");
    assert.equal(s.counts().closes, 1);
    assert.equal(s.timers.size, 0);
    s.transport.send("late");
    s.events.message("late");
    s.advance(100);
    assert.equal(s.sent.length, 0);
    assert.equal(s.received.length, 0);
  });
}

test("HTTP GET is undelayed", async () => {
  const s = setup();
  assert.equal(
    (
      await s.transport.fetchResource("/x", {
        token: null,
        signal: new AbortController().signal,
      })
    ).status,
    200,
  );
  assert.equal(s.counts().gets, 1);
  assert.equal(s.timers.size, 0);
});
