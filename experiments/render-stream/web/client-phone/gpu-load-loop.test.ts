import assert from "node:assert/strict";
import { test } from "node:test";
import { type GpuLoadMode, gpuLoadLoop } from "./gpu-load-loop";

function setup(mode: GpuLoadMode) {
  let id = 0;
  let t = 0;
  let draws = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const events: string[] = [];
  const clock = {
    request(cb: FrameRequestCallback) {
      callbacks.set(++id, cb);
      return id;
    },
    cancel(key: number) {
      callbacks.delete(key);
    },
  };
  const loop = gpuLoadLoop(
    mode,
    () => events.push(`load:${t}`),
    () => draws,
    clock,
  );
  let streamFrame = 0;
  let shouldDraw = false;
  const stream = () => {
    events.push(`stream:${t}`);
    if (shouldDraw) draws++;
    streamFrame = clock.request(stream);
  };
  return {
    events,
    loop,
    connect() {
      streamFrame = clock.request(stream);
      loop.streaming();
    },
    reconnect() {
      clock.cancel(streamFrame);
      streamFrame = clock.request(stream);
      loop.streaming();
    },
    frame(drew: boolean) {
      shouldDraw = drew;
      t++;
      // Match browser rAF: callbacks registered during this frame run next frame.
      const pending = [...callbacks.keys()];
      for (const key of pending) {
        const cb = callbacks.get(key);
        callbacks.delete(key);
        cb?.(t);
      }
    },
  };
}

test("coupled load follows the stream in the same frame, skipping empty frames", () => {
  const s = setup("coupled");
  s.frame(false); // async client/core loading: no stream loop yet
  assert.equal(s.events.length, 0);
  s.connect();
  s.frame(true);
  s.frame(false);
  s.frame(true);
  assert.deepEqual(s.events, [
    "stream:2",
    "load:2",
    "stream:3",
    "stream:4",
    "load:4",
  ]);
  // A restarted client may register after the old load callback. Session status
  // must restore order, without charging an old draw to an empty reconnect frame.
  s.reconnect();
  s.frame(false);
  s.frame(true);
  assert.deepEqual(s.events.slice(5), ["stream:5", "stream:6", "load:6"]);
  s.loop.stop();
  s.loop.streaming();
  s.frame(true);
  assert.equal(s.events.at(-1), "stream:7");
  assert.equal(s.events.filter((e) => e.startsWith("load:")).length, 3);
});

test("always load runs before stream startup and on empty stream frames", () => {
  const s = setup("always");
  s.frame(false);
  s.connect();
  s.frame(false);
  s.frame(true);
  assert.deepEqual(
    s.events.filter((e) => e.startsWith("load:")),
    ["load:1", "load:2", "load:3"],
  );
  s.loop.stop();
  s.frame(false);
  assert.equal(s.events.filter((e) => e.startsWith("load:")).length, 3);
});
