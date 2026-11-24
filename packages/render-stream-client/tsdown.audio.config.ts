import { defineConfig } from "tsdown";
// Separate invocation preserves the existing entry bundles byte for byte.
export default defineConfig({
  entry: [
    "src/audio.ts",
    "src/audio/transport.worker.ts",
    "src/audio/mixer.worklet.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: false,
  fixedExtension: false,
  outDir: "dist",
  platform: "browser",
});
