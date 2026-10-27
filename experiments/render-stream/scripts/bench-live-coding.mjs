// W11t (results/p3/w11t.md): rs-core's live-coding decode timed in wasm, in Node's V8. Loads
// rs-gsw-wasm's `--target web` glue (scripts/build-rs-core.sh) and runs `coding_bench` over a
// coded-message file (capture/build/rs_live_coding_tool encode), writing one JSON line per message
// ({index, decode_us}, the minimum over --repeats passes, each with a fresh decoder).
//
//   node experiments/render-stream/scripts/bench-live-coding.mjs --coded <file> --out <jsonl> \
//        [--build <dir>] [--repeats 3]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const coded = arg("--coded");
const out = arg("--out");
if (!coded || !out) {
  console.error(
    "usage: bench-live-coding.mjs --coded <file> --out <jsonl> [--build <dir>] [--repeats N]",
  );
  process.exit(2);
}
const build = resolve(
  arg("--build", join(root, "artifacts", "render-stream", "rs-core", "latest")),
);
const mod = await import(
  pathToFileURL(join(build, "gsw-rs", "rs_gsw_wasm.js")).href
);
mod.initSync({
  module: readFileSync(join(build, "gsw-rs", "rs_gsw_wasm_bg.wasm")),
});
const times = mod.coding_bench(
  readFileSync(coded),
  Number(arg("--repeats", "3")),
);
writeFileSync(
  out,
  `${Array.from(times, (us, index) =>
    JSON.stringify({ index, decode_us: Math.round(us * 10) / 10 }),
  ).join("\n")}\n`,
);
console.log(
  JSON.stringify({
    messages: times.length,
    total_us: Math.round(times.reduce((a, b) => a + b, 0)),
  }),
);
