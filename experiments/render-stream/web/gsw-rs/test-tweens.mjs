import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2]);
const glue = readFileSync(join(out, "tween_tests.js"), "utf8");
// The libtest entry point cannot report through WASM stdio. Initialize bindgen's
// externrefs, then invoke the exported Rust assertions individually instead.
const start = "wasm.__wbindgen_start();";
assert.equal(glue.split(start).length, 2, "expected one bindgen startup call");
const callable = glue.replace(
  start,
  '__wbg_get_imports()["./tween_tests_bg.js"].__wbindgen_init_externref_table();',
);
const path = join(out, "tween_tests.cjs");
writeFileSync(path, callable);
const require = createRequire(import.meta.url);
const tests = require(path);
const names = Object.keys(tests).filter((name) =>
  name.startsWith("regression_"),
);
assert.equal(names.length, 5);
let passed = 0;
let failed = 0;
for (const name of names) {
  try {
    // A WASM panic aborts its instance; isolate each regression for useful failures.
    delete require.cache[path];
    require(path)[name]();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error}`);
  }
}
console.log(JSON.stringify({ passed, failed, skipped: 0 }));
process.exitCode = failed ? 1 : 0;
