import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const API_TARGET = process.env.API_TARGET || "http://localhost:8787";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      // Remote-browser frame stream. ws:true is required or the upgrade is dropped.
      "/ws": { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
});
