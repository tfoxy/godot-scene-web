import { defineConfig } from "tsdown";

export default defineConfig({
  // TWO ENTRIES, matching the two `exports` in package.json. `src/glyph-pass-hbgpu.ts` is the only
  // module that imports `@godot-scene-web/hb-gpu`, and it is a separate chunk so a consumer that
  // never imports `@godot-scene-web/canvas/glyphs` never loads a glyph renderer.
  entry: ["src/index.ts", "src/glyph-pass-hbgpu.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  outDir: "dist",
});
