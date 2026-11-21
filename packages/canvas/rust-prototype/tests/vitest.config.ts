import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [new URL("./executor-prepare.test.ts", import.meta.url).pathname],
    testTimeout: 15000,
  },
});
