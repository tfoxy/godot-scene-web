import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const page = await readFile(
  new URL("./page/index.html", import.meta.url),
  "utf8",
);
const source = page.slice(
  page.indexOf("function channel(pc)"),
  page.indexOf("async function open(pc)"),
);

function setup(trace, closeTimeout = false) {
  const result = {};
  let clock = 0;
  const dc = {
    id: 12,
    readyState: "open",
    close() {
      this.readyState = "closing";
    },
  };
  const scope = vm.createContext({
    query: new URLSearchParams(trace ? "trace=1" : ""),
    result,
    performance: { now: () => ++clock },
    TextEncoder,
    timeout: (promise, ms, what) =>
      closeTimeout && what === "close"
        ? Promise.reject(Error(`${what} timeout (${ms} ms)`))
        : promise,
  });
  vm.runInContext(source, scope);
  const ch = scope.channel({ createDataChannel: () => dc });
  dc.onopen();
  return { ch, dc, result };
}

test("normal channels deliver queued and awaited messages without trace output", async () => {
  const { ch, dc, result } = setup(false);
  const binary = new Uint8Array([1, 2, 3]).buffer;
  dc.onmessage({ data: binary });
  assert.equal(await ch.next(), binary);
  const next = ch.next();
  dc.onmessage({ data: "end" });
  assert.equal(await next, "end");
  const close = ch.close();
  dc.onclose();
  await close;
  assert.deepEqual(result, {});
});

test("channel evidence distinguishes the last message, close request and close event", async () => {
  const { ch, dc, result } = setup(true);
  dc.onmessage({ data: new Uint8Array([1, 2, 3]).buffer });
  const end = '{"t":"end","n":3}';
  dc.onmessage({ data: end });
  const close = ch.close();
  const [trace] = result.channels;
  assert.equal(trace.id, 12);
  assert.equal(trace.messages, 2);
  assert.equal(trace.bytes, 3 + new TextEncoder().encode(end).length);
  assert.equal(trace.lastText, end);
  assert.ok(trace.createdMs < trace.openMs);
  assert.ok(trace.openMs < trace.lastMessageMs);
  assert.ok(trace.lastMessageMs < trace.closeRequestMs);
  assert.equal(trace.closeEventMs, undefined);
  dc.onclose();
  await close;
  assert.ok(trace.closeRequestMs < trace.closeEventMs);
});

test("a close timeout retains the closing state without inventing a close event", async () => {
  const { ch, dc, result } = setup(true, true);
  dc.onmessage({ data: '{"t":"end","n":0}' });
  await assert.rejects(ch.close(), /close timeout \(10000 ms\)/);
  const [trace] = result.channels;
  assert.equal(trace.readyState, "closing");
  assert.equal(trace.closeEventMs, undefined);
  assert.ok(trace.lastMessageMs < trace.closeRequestMs);
  assert.ok(trace.closeRequestMs < trace.closeTimeoutMs);
});
