// G7o2 (protocol/gate7/g7o2.md "Profile"): `rs-core-check profile` as wasm in Node. Loads
// rs-gsw-wasm's `--target web` glue (scripts/build-rs-core.sh) and runs `core_profile` -- the same
// `render_stream_core::prof::replay` the native CLI runs, with the core's phase timers on
// `performance.now()` -- over each input of a bench inputs.json, writing <out>/<input>.jsonl (one
// line per transaction, each timer's minimum over the repeats, in µs).
//
//   node experiments/render-stream/scripts/profile-rs-core-wasm.mjs --inputs <inputs.json> \
//        --out <dir> [--build <dir>] [--repeats 5] [--digest inline|deferred] [--only a,b]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const build = resolve(
  arg("--build", join(root, "artifacts", "render-stream", "rs-core", "latest")),
);
const inputsPath = arg("--inputs");
const out = arg("--out");
if (!inputsPath || !out) {
  console.error(
    "usage: profile-rs-core-wasm.mjs --inputs <inputs.json> --out <dir> [--build <dir>] [--repeats N] [--digest inline|deferred] [--only a,b]",
  );
  process.exit(2);
}
const repeats = Number(arg("--repeats", "5"));
const inline = arg("--digest", "deferred") === "inline";
const only = arg("--only", "").split(",").filter(Boolean);

const mod = await import(
  pathToFileURL(join(build, "gsw-rs", "rs_gsw_wasm.js")).href
);
mod.initSync({
  module: readFileSync(join(build, "gsw-rs", "rs_gsw_wasm_bg.wasm")),
});
const inputs = JSON.parse(readFileSync(inputsPath, "utf8")).inputs;
mkdirSync(out, { recursive: true });
for (const input of inputs) {
  if (only.length && !only.includes(input.name)) continue;
  const data = new Uint8Array(readFileSync(input.recording));
  const read = (hex) => {
    for (const ext of ["grt", "grm", "grp"]) {
      try {
        return new Uint8Array(
          readFileSync(join(input.store, "sha256", `${hex}.${ext}`)),
        );
      } catch {}
    }
    return undefined;
  };
  const lines = mod.core_profile(data, read, inline, repeats);
  writeFileSync(join(out, `${input.name}.jsonl`), `${lines}\n`);
  const rows = lines.split("\n").map((l) => JSON.parse(l));
  const total = rows.map((r) => r.total_us).sort((a, b) => a - b);
  const pick = (p) =>
    total[Math.min(total.length - 1, Math.ceil(p * total.length) - 1)];
  console.log(
    `profile-rs-core-wasm: ${input.name}: ${rows.length} transactions, total (no draw) p50 ${pick(0.5).toFixed(1)} p95 ${pick(0.95).toFixed(1)} us`,
  );
}
