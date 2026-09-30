import { defineConfig } from "tsdown";

export default defineConfig({
  // Optional entries keep glyph rendering and Rust serialization out of the default import.
  entry: ["src/index.ts", "src/glyph-pass-hbgpu.ts", "src/pixi-renderer.ts", "src/rust-prototype-scene.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  outDir: "dist",
});
