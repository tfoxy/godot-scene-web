import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/node.ts", "src/fetch.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  outDir: "dist",
});
