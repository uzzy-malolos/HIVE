import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

export default defineConfig({
  root: here,
  base: "/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    outDir: path.resolve(repoRoot, "dist-web"),
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: path.resolve(here, "src", "test-setup.ts"),
    include: ["src/**/*.test.{ts,tsx}"],
    css: true,
    fileParallelism: false,
  },
});
