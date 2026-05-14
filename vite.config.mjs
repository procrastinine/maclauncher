import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const devHost = process.env.MACLAUNCHER_DEV_HOST || "127.0.0.1";
const devPort = Number(process.env.MACLAUNCHER_DEV_PORT || "5174");

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/renderer"),
  plugins: [react()],
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true
  },
  server: {
    host: devHost,
    port: devPort,
    strictPort: true
  },
  preview: {
    host: devHost,
    port: devPort,
    strictPort: true
  }
});
