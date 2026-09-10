import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/runtime.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  outDir: "dist",
});
