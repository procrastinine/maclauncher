import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { runtimeContentPlugin } from "./scripts/runtime-content-vite.mjs";

const devHost = process.env.MACLAUNCHER_DEV_HOST || "127.0.0.1";
const devPort = Number(process.env.MACLAUNCHER_DEV_PORT || "5174");

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/renderer"),
  plugins: [runtimeContentPlugin(), react()],
  resolve: { alias: { "@utility-controls": path.resolve(import.meta.dirname, "src/renderer/src/ui/UtilityApp.tsx") }, dedupe: ["react", "react-dom"] },
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "@utility-controls"], extensions: [".tsx"] },
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    rolldownOptions: { input: { main: path.resolve(import.meta.dirname, "src/renderer/index.html"),
      utility: path.resolve(import.meta.dirname, "src/renderer/utility.html") }, output: { codeSplitting: { groups: [
      { name: "react", test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ }
    ] } } }
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
