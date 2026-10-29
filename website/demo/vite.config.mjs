// Builds the interactive launcher demo from the launcher's own renderer
// source. Nothing here is copied from the launcher: the demo entry imports
// the renderer, and data/state.json is generated from the launcher's
// module registry, backend and graphics modules.
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const demoRoot = import.meta.dirname;
const repoRoot = path.resolve(demoRoot, "../..");

export default defineConfig({
  root: demoRoot,
  base: "./",
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { fs: { allow: [repoRoot] } },
  build: {
    target: "es2022",
    outDir: path.resolve(demoRoot, "../public/demo"),
    emptyOutDir: true,
    rollupOptions: { input: { index: path.resolve(demoRoot, "index.html"), launcher: path.resolve(demoRoot, "launcher.html") } }
  }
});
