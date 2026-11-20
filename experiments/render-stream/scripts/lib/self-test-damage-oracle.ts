#!/usr/bin/env -S pnpm exec tsx --conditions=development
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { records } from "../../web/bench/oracle";

const originalFetch = globalThis.fetch;
const magic = new Uint8Array([71, 82, 83, 71, 13, 10, 26, 10]);
const record = new Uint8Array([3, 0, 0, 0, 10, 20, 30]);
const bytes = new Uint8Array([...magic, ...record, ...record]);
let cancelled = false;
function serve(input: Uint8Array, chunkSize: number) {
  let offset = 0;
  cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (offset === input.length) {
            controller.close();
            return;
          }
          controller.enqueue(input.slice(offset, offset + chunkSize));
          offset = Math.min(offset + chunkSize, input.length);
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
}
const collect = async () => {
  const out: Uint8Array[] = [];
  for await (const r of records("test")) out.push(r);
  return out;
};
try {
  for (const size of [1, 5, bytes.length]) {
    serve(bytes, size);
    assert.deepEqual(await collect(), [magic, record, record]);
  }
  serve(bytes.slice(0, -1), 1);
  await assert.rejects(collect, /truncated recording/);
  serve(bytes.slice(0, 9), 2);
  await assert.rejects(collect, /truncated recording/);
  serve(bytes, 1);
  const stream = records("test");
  await stream.next();
  await stream.return(undefined);
  assert.equal(cancelled, true);
  globalThis.fetch = async () => new Response(null, { status: 404 });
  await assert.rejects(collect, /HTTP 404/);
  console.log("damage-oracle stream: 7 passed, 0 failed");
} finally {
  globalThis.fetch = originalFetch;
}

// Exercise the real page loop; only its dynamically loaded wasm host and browser APIs are mocked.
const pageSource = new URL("../../web/bench/oracle.ts", import.meta.url);
const source = await readFile(pageSource, "utf8");
const moduleImport = /const mod = \(await import\([\s\S]*?\)\) as GswRsModule;/;
assert.match(source, moduleImport);
const bundled = await build({
  stdin: {
    contents: source.replace(
      moduleImport,
      "const mod = globalThis.__damageOracleModule;",
    ),
    loader: "ts",
    resolveDir: dirname(fileURLToPath(pageSource)),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  conditions: ["development"],
});
const { runOracle } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
)) as typeof import("../../web/bench/oracle");
const globals = [
  "fetch",
  "window",
  "location",
  "document",
  "requestAnimationFrame",
  "__damageOracleModule",
];
const saved = globals.map((name) =>
  Object.getOwnPropertyDescriptor(globalThis, name),
);
async function replay(complete: boolean, windowStop = false) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let seq = 0;
  let frames = 0;
  let freed = false;
  const evidence = new Map<string, string>();
  const pageWindow: { __bench?: { state: string } } = {};
  class Host {
    rx() {
      return 0;
    }
    live_session() {
      return 0;
    }
    live_accept() {
      const code = new Uint8Array(memory.buffer)[4];
      if (code === 0) new Uint32Array(memory.buffer, 64, 3)[1] = ++seq;
      return code;
    }
    pending_shaders() {
      return 0;
    }
    stats_ptr() {
      return 64;
    }
    enable_damage_oracle() {}
    damage_oracle_compare() {}
    apply() {
      return 0;
    }
    draw() {
      frames++;
      return 0;
    }
    damage_oracle_json() {
      return JSON.stringify({
        frames,
        partial: frames,
        mismatched: 0,
        first_mismatch: null,
      });
    }
    free() {
      freed = true;
    }
  }
  // The host accepts these framed markers as session, transactions, and ACCEPT_END (2).
  const packet = (code: number) => [1, 0, 0, 0, code];
  serve(
    new Uint8Array([
      ...magic,
      ...packet(1),
      ...Array.from({ length: 6 }, () => packet(0)).flat(),
      ...(complete ? packet(2) : []),
    ]),
    5,
  );
  const recordingFetch = globalThis.fetch;
  Object.assign(globalThis, {
    __damageOracleModule: { default: async () => ({ memory }), GswRs: Host },
    window: pageWindow,
    location: {
      origin: "http://oracle.test",
      search: `?nonce=test&input=/recording&store=/store${windowStop ? "&to-seq=3" : ""}`,
    },
    document: {
      getElementById: () => ({}),
      createElement: () => ({}),
      body: { append() {} },
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/recording") return recordingFetch(input, init);
    if (url.endsWith(".wasm")) return new Response(new Uint8Array());
    assert.equal(init?.method, "PUT");
    evidence.set(url, String(init?.body));
    return new Response();
  };
  try {
    await runOracle();
  } catch (error) {
    assert.notEqual(pageWindow.__bench?.state, "done");
    assert.equal(evidence.has("/evidence/test/oracle.json"), false);
    throw error;
  } finally {
    assert.equal(freed, true);
  }
  assert.equal(pageWindow.__bench?.state, "done");
  const report = JSON.parse(
    evidence.get("/evidence/test/oracle.json") ?? "null",
  );
  assert.equal(report?.frames, windowStop ? 1 : 2);
  assert.equal(report.partial, report.frames);
}
try {
  await replay(true);
  console.log("damage-oracle complete recording: passed");
  await replay(false, true);
  console.log("damage-oracle intentional window stop: passed");
  await assert.rejects(() => replay(false), /recording-incomplete/);
  console.log("damage-oracle record-aligned incomplete recording: passed");
  console.log("damage-oracle self-test: 10 passed, 0 failed");
} finally {
  for (const [i, name] of globals.entries()) {
    const descriptor = saved[i];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}
