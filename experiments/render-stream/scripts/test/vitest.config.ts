import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "experiments/render-stream/scripts/lib/frame-budget*.test.ts",
      "experiments/render-stream/web/bench/bench-rs.test.ts",
    ],
  },
  resolve: { conditions: ["development"] },
});
