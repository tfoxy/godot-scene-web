// Run from the repo root: mise exec -- node packages/canvas/rust-prototype/scripts/bench-downscale-wasm.mjs
// --build-only compiles without timing. The runner acquires its own quiet locks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const crate = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(crate, "../../..");
const quiet = resolve(root, "experiments/render-stream/scripts/lib/quiet.sh");
const out = resolve(crate, "target/downscale-probe");
const wasm = resolve(out, "downscale-bench.wasm");
const quietLog = resolve(out, "bench-quiet.jsonl");
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 ||
    (args.length === 1 && ["--build-only", "--under-lock"].includes(args[0])),
  "usage: bench-downscale-wasm.mjs [--build-only]",
);

if (args[0] !== "--under-lock") {
  mkdirSync(out, { recursive: true });
  execFileSync(
    quiet,
    [
      "shared",
      "--label",
      "downscale-bench-build",
      "--log",
      quietLog,
      "--",
      "rustc",
      "--edition=2024",
      "--crate-type=cdylib",
      "--target=wasm32-unknown-unknown",
      "-Ctarget-feature=+simd128",
      "-Copt-level=3",
      "-Clto=true",
      "-Ccodegen-units=1",
      "-Cpanic=abort",
      resolve(crate, "scripts/downscale_wasm.rs"),
      "-o",
      wasm,
    ],
    { stdio: "inherit" },
  );
  if (args[0] === "--build-only") {
    console.log(`Built ${wasm}`);
  } else {
    execFileSync(
      quiet,
      [
        "exclusive",
        "--label",
        "downscale-bench",
        "--log",
        quietLog,
        "--",
        process.execPath,
        script,
        "--under-lock",
      ],
      {
        stdio: "inherit",
      },
    );
  }
} else {
  const uptime = execFileSync("uptime", { encoding: "utf8" }).trim();
  const load = loadavg();
  console.error(uptime);
  execFileSync(quiet, ["status"], { stdio: ["ignore", 2, 2] });
  assert.ok(
    load[0] <= 4,
    `timing deferred: 1-minute load ${load[0]} exceeds 4`,
  );
  const binary = readFileSync(wasm);
  const { instance } = await WebAssembly.instantiate(binary);
  const api = instance.exports;
  const bytes = api.prepare();
  assert.equal(bytes, (5380 / 2) * (1320 / 2) * 4);
  const samples = { scalar: [], simd: [] };
  let expected;
  let comparisons = 0;
  const warmups = 2;
  const repeats = 7;
  for (let round = 0; round < warmups + repeats; round++) {
    // Alternate order to reduce bias from changes in host load and CPU frequency.
    for (const arm of round % 2 ? ["simd", "scalar"] : ["scalar", "simd"]) {
      const start = performance.now();
      const ptr = api[arm]();
      const elapsed = performance.now() - start;
      try {
        const output = Buffer.from(api.memory.buffer, ptr, bytes);
        if (!expected) expected = Buffer.from(output);
        assert.equal(
          Buffer.compare(output, expected),
          0,
          `${arm} round ${round}: output mismatch`,
        );
        comparisons++;
      } finally {
        api.free_output(ptr);
      }
      if (round >= warmups) samples[arm].push(elapsed);
    }
  }
  const median = (values) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const scalarMs = median(samples.scalar);
  const simdMs = median(samples.simd);
  console.log(
    JSON.stringify(
      {
        width: 5380,
        height: 1320,
        k: 2,
        node: process.version,
        wasmSha256: createHash("sha256").update(binary).digest("hex"),
        uptime,
        loadavg: load,
        warmupsPerArm: warmups,
        repeatsPerArm: repeats,
        byteEqualComparisons: comparisons,
        samplesMs: samples,
        medianMs: { scalar: scalarMs, simd: simdMs },
        speedup: scalarMs / simdMs,
        measured:
          "wasm call including output allocation; excludes input generation, output comparison and free",
      },
      null,
      2,
    ),
  );
}
