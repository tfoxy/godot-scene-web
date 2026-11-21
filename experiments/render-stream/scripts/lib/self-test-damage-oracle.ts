#!/usr/bin/env -S pnpm exec tsx --conditions=development
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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
  serve(new Uint8Array([40, 181, 47, 253, 0, 0, 0, 0]), 1);
  await assert.rejects(collect, /invalid magic/);
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
  console.log("damage-oracle stream: 8 passed, 0 failed");
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
  let batching: number | undefined;
  let damage: boolean | undefined;
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
    set_draw_batching(mask: number) {
      batching = mask;
    }
    set_damage_redraw(on: boolean) {
      damage = on;
    }
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
        batching,
        slot_calls: frames * 4,
        frames,
        partial: damage ? frames : 0,
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
      search: `?nonce=test&input=/recording&store=/store&batching=1&damage=off${windowStop ? "&to-seq=3" : ""}`,
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
  assert.equal(batching, 1);
  assert.equal(damage, false);
  assert.equal(report.batching, 1);
  assert.equal(report.slot_calls, report.frames * 4);
  assert.equal(report.partial, 0);
}
try {
  await replay(true);
  console.log("damage-oracle complete recording: passed");
  await replay(false, true);
  console.log("damage-oracle intentional window stop: passed");
  await assert.rejects(() => replay(false), /recording-incomplete/);
  console.log("damage-oracle record-aligned incomplete recording: passed");
  console.log("damage-oracle self-test: 11 passed, 0 failed");
} finally {
  for (const [i, name] of globals.entries()) {
    const descriptor = saved[i];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

// Optional real-GPU checks use the same driver and compare actual executor bytes, including sabotage.
const { values: args } = parseArgs({
  options: {
    recording: { type: "string" },
    store: { type: "string" },
    out: { type: "string" },
    "rs-build": { type: "string" },
    "to-seq": { type: "string", default: "300" },
  },
});
if (args.recording || args.store || args.out) {
  assert.ok(
    args.recording && args.store && args.out,
    "need recording, store and out",
  );
  for (const sabotage of [false, true]) {
    const out = resolve(args.out, sabotage ? "slot-swap" : "slots");
    const command = [
      "--conditions=development",
      fileURLToPath(new URL("../damage-oracle.ts", import.meta.url)),
      "--recording",
      resolve(args.recording),
      "--store",
      resolve(args.store),
      "--out",
      out,
      "--batching",
      "1",
      "--damage",
      "off",
      "--allow-no-partial",
      "--apply-every",
      "1",
      "--to-seq",
      args["to-seq"],
      ...(args["rs-build"] ? ["--rs-build", resolve(args["rs-build"])] : []),
      ...(sabotage ? ["--sabotage", "slot-swap"] : []),
    ];
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", ...command],
      {
        encoding: "utf8",
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(
      result.status,
      sabotage ? 1 : 0,
      result.stderr + result.stdout,
    );
    const report = JSON.parse(
      await readFile(resolve(out, "oracle.json"), "utf8"),
    );
    assert.equal(report.batching, 1);
    assert.ok(report.frames > 0);
    assert.ok(report.slot_calls > 0);
    assert.equal(report.partial, 0);
    if (sabotage) assert.ok(report.mismatched > 0);
    else assert.equal(report.mismatched, 0);
    console.log(
      `damage-oracle real GPU ${sabotage ? "slot-swap detected" : "slots exact"}: passed (${report.frames} frames, ${report.mismatched} mismatches, ${report.slot_calls} slot calls), ${out}/oracle.json`,
    );
  }
  console.log("damage-oracle self-test with real GPU: 13 passed, 0 failed");
}
