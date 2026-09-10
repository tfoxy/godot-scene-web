import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
  },
  resolve: {
    conditions: ["development"],
    alias: {
      "@godot-scene-web/core": new URL(
        "./packages/core/src/index.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/tscn-parser": new URL(
        "./packages/tscn-parser/src/index.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/scene-graph/provenance": new URL(
        "./packages/scene-graph/src/provenance.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/scene-graph": new URL(
        "./packages/scene-graph/src/index.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/layout/anchors": new URL(
        "./packages/layout/src/anchor-grammar.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/layout": new URL(
        "./packages/layout/src/index.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/html/runtime": new URL(
        "./packages/html/src/runtime.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/html": new URL(
        "./packages/html/src/index.ts",
        import.meta.url,
      ).pathname,
      // MORE SPECIFIC FIRST, for the prefix reason spelled out under hb-gpu below.
      "@godot-scene-web/canvas/glyphs": new URL(
        "./packages/canvas/src/glyph-pass-hbgpu.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/canvas": new URL(
        "./packages/canvas/src/index.ts",
        import.meta.url,
      ).pathname,
      // MORE SPECIFIC FIRST. A vite string alias matches by PREFIX, so a bare
      // `@godot-scene-web/hb-gpu` entry listed above this one would rewrite the `/webgl` subpath to
      // `…/src/index.ts/webgl` and fail to resolve.
      "@godot-scene-web/hb-gpu/webgl": new URL(
        "./packages/hb-gpu/src/webgl.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/hb-gpu": new URL(
        "./packages/hb-gpu/src/index.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/vue": new URL(
        "./packages/vue/src/index.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/test-harness/browser": new URL(
        "./packages/test-harness/src/browser.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/test-harness/parity": new URL(
        "./packages/test-harness/src/parity.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/test-harness": new URL(
        "./packages/test-harness/src/index.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/perf-harness/report": new URL(
        "./packages/perf-harness/src/report.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/perf-harness/node": new URL(
        "./packages/perf-harness/src/node.ts",
        import.meta.url,
      ).pathname,
      "@godot-scene-web/perf-harness": new URL(
        "./packages/perf-harness/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
