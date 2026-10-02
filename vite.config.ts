import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs so the build works from any path (static hosts, artifact pages).
  base: "./",
  build: {
    target: "es2022",
    // Spark bundles its WASM sorter inline (~3 MB); that is expected.
    chunkSizeWarningLimit: 3500,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        splatPreview: resolve(__dirname, "viewer/splat-preview.html"),
      },
    },
  },
  server: { host: true },
});
