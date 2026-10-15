// Q14d "Goldens" under the wasm build (gate7-design.md G7x R1: "golden-6 passes through the core
// natively and as wasm"): loads rs-gsw-wasm's `--target web` glue in Node (the very module the
// browser loads, built by scripts/build-rs-core.sh) and runs `run_goldens`, the same Rust function
// `rs-core-check goldens` runs natively.
//
//   node experiments/render-stream/scripts/test/self-test-rs-core-wasm.mjs [--build <dir>] [--only 6]
//        [--sabotage skip-payload-hash]
// Exit 0 when every check passes (with --sabotage: when the resource-hash vector's check fails).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..", "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const build = resolve(
  arg("--build", join(root, "artifacts", "render-stream", "rs-core", "latest")),
);
const only = Number(arg("--only", "0"));
const sabotage = arg("--sabotage", "") === "skip-payload-hash";
const protocol = join(root, "experiments", "render-stream", "protocol");

const mod = await import(
  pathToFileURL(join(build, "gsw-rs", "rs_gsw_wasm.js")).href
);
mod.initSync({
  module: readFileSync(join(build, "gsw-rs", "rs_gsw_wasm_bg.wasm")),
});
const read = (path) => {
  try {
    return new Uint8Array(readFileSync(join(protocol, path)));
  } catch {
    return undefined;
  }
};
const checks = mod
  .run_goldens(read, only, sabotage)
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL ${c.name}: ${c.detail}`);
console.log(
  `self-test-rs-core-wasm: ${checks.length - failed.length}/${checks.length} checks pass (wasm32, ${only ? `golden-${only}` : "golden-2..7"}${sabotage ? ", sabotage skip-payload-hash" : ""})`,
);
if (sabotage) {
  const caught = failed.some((c) => c.name.includes("resource-hash"));
  console.log(
    caught
      ? "self-test-rs-core-wasm: sabotage caught by the resource-hash vector"
      : "self-test-rs-core-wasm: sabotage NOT caught",
  );
  process.exitCode = caught ? 0 : 1;
} else {
  process.exitCode = failed.length === 0 && checks.length > 0 ? 0 : 1;
}
