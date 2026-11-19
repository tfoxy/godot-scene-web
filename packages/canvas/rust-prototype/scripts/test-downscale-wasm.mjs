import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const crate = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(crate, "target/downscale-probe");
mkdirSync(out, { recursive: true });
const wasm = resolve(out, "downscale.wasm");
execFileSync(
  "rustc",
  [
    "--edition=2024",
    "--crate-type=cdylib",
    "--cfg=test",
    "--target=wasm32-unknown-unknown",
    "-Ctarget-feature=+simd128",
    "-Copt-level=3",
    "-Cpanic=abort",
    resolve(crate, "tests/downscale_wasm.rs"),
    "-o",
    wasm,
  ],
  { stdio: "inherit" },
);
const { instance } = await WebAssembly.instantiate(readFileSync(wasm));
assert.equal(instance.exports.check_downscale(), 1073);
console.log("PASS: 1073 seeded image comparisons on wasm32 with simd128");
assert.equal(instance.exports.check_division(), 133_042_170);
console.log("PASS: 133042170 exhaustive numerator/alpha pairs on wasm32 SIMD");
