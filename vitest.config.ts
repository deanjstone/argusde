import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src/web");

export default defineConfig({
  resolve: { alias: { "@": webRoot } },
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "test/**/*.test.ts"],
    setupFiles: ["./src/web/test-setup.ts"],
  },
});
