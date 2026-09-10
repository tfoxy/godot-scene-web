import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // Keep source consumers on the browser arm of @godot-scene-web/project.
    conditions: ["browser", "development"],
  },
  server: {
    fs: {
      allow: ["../.."],
    },
  },
});
