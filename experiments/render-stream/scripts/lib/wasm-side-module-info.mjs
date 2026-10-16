// Summarizes an emscripten side module for build-rs-core-web.sh (G7xw): its dylink.0 memory and
// table sizes, its function exports, and its imports grouped by module and kind (what the
// template's main module must provide at load time). Prints JSON.
//
//   node wasm-side-module-info.mjs <module.wasm>
import { readFileSync } from "node:fs";

const bytes = readFileSync(process.argv[2]);
const module = new WebAssembly.Module(bytes);

function leb(buf, at) {
  let result = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return [result, pos];
}

// dylink.0 (https://github.com/WebAssembly/tool-conventions/blob/main/DynamicLinking.md):
// subsection 1 = WASM_DYLINK_MEM_INFO (memsize, memalign, tablesize, tablealign).
let memInfo = null;
const needed = [];
for (const section of WebAssembly.Module.customSections(module, "dylink.0")) {
  const buf = new Uint8Array(section);
  let pos = 0;
  while (pos < buf.length) {
    const type = buf[pos++];
    let len;
    [len, pos] = leb(buf, pos);
    const end = pos + len;
    if (type === 1) {
      const v = [];
      let p = pos;
      for (let i = 0; i < 4; i++) {
        let x;
        [x, p] = leb(buf, p);
        v.push(x);
      }
      memInfo = {
        memory_size: v[0],
        memory_align_log2: v[1],
        table_size: v[2],
        table_align_log2: v[3],
      };
    } else if (type === 2) {
      let p = pos;
      let count;
      [count, p] = leb(buf, p);
      for (let i = 0; i < count; i++) {
        let n;
        [n, p] = leb(buf, p);
        needed.push(new TextDecoder().decode(buf.subarray(p, p + n)));
        p += n;
      }
    }
    pos = end;
  }
}

const imports = {};
for (const imp of WebAssembly.Module.imports(module)) {
  const key = `${imp.module}.${imp.kind}`;
  if (!imports[key]) imports[key] = [];
  imports[key].push(imp.name);
}
for (const list of Object.values(imports)) list.sort();
const exports = WebAssembly.Module.exports(module);

console.log(
  JSON.stringify(
    {
      bytes: bytes.length,
      dylink: memInfo,
      needed,
      functionExports: exports
        .filter((e) => e.kind === "function")
        .map((e) => e.name)
        .sort(),
      otherExports: exports
        .filter((e) => e.kind !== "function")
        .map((e) => `${e.kind}:${e.name}`)
        .sort(),
      importCounts: Object.fromEntries(
        Object.entries(imports).map(([k, v]) => [k, v.length]),
      ),
      imports,
    },
    null,
    2,
  ),
);
