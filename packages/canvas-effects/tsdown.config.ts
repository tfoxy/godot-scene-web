import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/webgl.ts", "src/webgpu.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
