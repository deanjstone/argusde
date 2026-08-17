import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src/web");

export default defineConfig({
  resolve: { alias: { "@": webRoot } },
  root: "src/web",
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
