import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
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
