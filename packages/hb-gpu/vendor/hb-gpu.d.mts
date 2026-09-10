// TYPES FOR `hb-gpu.mjs`, HAND-WRITTEN AND NOT VENDORED. Everything else in this directory came out
// of emscripten or out of an upstream tarball; this file is ours, and it exists because `.mjs` next
// to a `.wasm` has no type surface of its own and TypeScript will not import it without one.
//
// DELIBERATELY THIN. The factory's resolved value is the emscripten `Module` object, whose real
// shape — the `_hb_*` exports, `HEAPU8`, `HEAP32`, `UTF8ToString` — is already stated once, as
// `HbGpuWasmExports` in `../src/index.ts`, and restating it here would be a second copy free to
// drift from the `-sEXPORTED_FUNCTIONS` list that actually determines it. `createHbGpu` is the
// supported way in, and it takes the factory and narrows the result.
//
// `wasmBinary` IS THE ONLY OPTION, because `-sINCOMING_MODULE_JS_API=wasmBinary` is the only key
// the glue was compiled to pick up. And the caller SHOULD pass it: this module was built with
// `-sENVIRONMENT=web,worker`, so the node branch is compiled out and a node import that lets the
// glue go looking for `hb-gpu.wasm` itself aborts with "both async and sync fetching of the wasm
// failed".

export interface HbGpuModuleOptions {
  /** The bytes of `hb-gpu.wasm`. Without it the glue fetches the file relative to its own
   *  `import.meta.url`, which only works in a browser served over HTTP. */
  wasmBinary?: ArrayBuffer | ArrayBufferView;
}

/** Emscripten's MODULARIZE=1 / EXPORT_ES6=1 factory. Resolves to the `Module` object; pass it to
 *  `createHbGpu` from the package root, which is what gives it a checked type. */
declare const createHbGpuModule: (
  options?: HbGpuModuleOptions,
) => Promise<unknown>;

export default createHbGpuModule;
