import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:3000", ws: true } },
  },
  build: {
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), terminal: resolve(import.meta.dirname, "terminal.html") } },
  },
});
