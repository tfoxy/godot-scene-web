import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/webgl.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  // `clean: true`, like every sibling package, and only since the wasm moved out. `build.sh` used
  // to emit `hb-gpu.mjs` / `hb-gpu.wasm` into this same `dist/`, so a cleaning TypeScript build
  // would delete a docker-and-minutes artifact and leave a package importing a module that was no
  // longer there. Those now live in committed `vendor/` (see `vendor/VENDOR.md`), which nothing
  // here writes to, so `dist/` is once again only what tsdown put in it.
  clean: true,
  fixedExtension: false,
  outDir: "dist",
});
