#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Keep the engine-free macOS swap regressions in the portable pure-test census.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(
  "python3",
  ["-I", "-B", fileURLToPath(new URL("../m-swap-test.py", import.meta.url))],
  { stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
