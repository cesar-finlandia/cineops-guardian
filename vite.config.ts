// CineOps Guardian — Vite config (DP-UI WU-UI-07).
// build.outDir="dist" for the DP-API static mount + DP-DEPLOY image copy;
// dev proxy forwards API + SSE to the local uvicorn backend.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      src: `${root}src`,
      examples: `${root}examples`,
    },
  },
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/events": "http://localhost:8080",
    },
  },
});
