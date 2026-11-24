import { defineConfig } from "vitest/config";

// The workspace config discovers test/ only. This config also permits the
// package-local `vitest run src/audio` acceptance filter.
export default defineConfig({
  root: new URL("../../..", import.meta.url).pathname,
  test: {
    environment: "node",
    include: ["src/audio/__tests__/**/*.test.ts"],
  },
  resolve: { conditions: ["development"] },
});
