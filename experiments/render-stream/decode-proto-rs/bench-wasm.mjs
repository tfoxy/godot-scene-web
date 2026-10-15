// Runs the decode cost prototype as wasm32-unknown-unknown inside Node's V8 (the browser's wasm
// engine, minus the browser): `node bench-wasm.mjs <recording.rs2> [repeats]`. Build first with
// `cargo build --offline --release --lib --target wasm32-unknown-unknown`. Prints one JSON line in
// the native binary's shape. The clock is performance.now() (5 us-coarsened in browsers, not here).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STAGES = [
  "frame",
  "record_sha256",
  "meta_ascii",
  "json_parse",
  "schema",
  "blocks",
  "lift_resolve",
  "invariants",
  "rest",
];
const [path, repeatsArg] = process.argv.slice(2);
if (!path) {
  console.error("usage: node bench-wasm.mjs <recording.rs2> [repeats]");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(
  here,
  "target/wasm32-unknown-unknown/release/rs_decode_proto.wasm",
);
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {
  env: { now_us: () => performance.now() * 1000 },
});
const { memory, alloc, profile } = instance.exports;
const data = readFileSync(path);
const ptr = alloc(data.length);
new Uint8Array(memory.buffer, ptr, data.length).set(data);
const out = profile(ptr, data.length, Number(repeatsArg ?? 5));
if (out === 0) {
  console.error("error: the prototype rejected the recording");
  process.exit(1);
}
const r = new Float64Array(memory.buffer, out, 13);
const stages = Object.fromEntries(
  STAGES.map((s, i) => [s, Number(r[1 + i].toFixed(2))]),
);
console.log(
  JSON.stringify({
    arm: "wasm-node",
    node: process.version,
    transactions: r[0],
    total_mean_us: Number(r[10].toFixed(2)),
    total_p50_us: Number(r[11].toFixed(2)),
    total_p95_us: Number(r[12].toFixed(2)),
    stages,
  }),
);
