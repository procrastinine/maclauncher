// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// The dev server serves public/ files but not their directory indexes, which GitHub Pages does.
const devDemoIndex = {
  name: "dev-demo-index",
  apply: /** @type {const} */ ("serve"),
  /** @param {import("vite").ViteDevServer} server */
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      // Optimized images keep their URL when the source file is replaced, so
      // the preview must not let the browser cache them.
      if (/^(\/maclauncher)?\/_image\?/.test(req.url || "")) {
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) => setHeader(name, /^cache-control$/i.test(name) ? "no-store" : value);
        setHeader("Cache-Control", "no-store");
      }
      // The base may already be stripped from req.url here.
      const match = (req.url || "").match(/^(\/maclauncher)?\/demo\/?(\?.*)?$/);
      if (match) req.url = `${match[1] || ""}/demo/index.html${match[2] || ""}`;
      next();
    });
  }
};

// Published by .github/workflows/pages.yml at procrastinine.github.io/maclauncher.
export default defineConfig({
  site: "https://procrastinine.github.io",
  base: "/maclauncher",
  vite: { plugins: [devDemoIndex] },
  integrations: [
    starlight({
      title: "MacLauncher",
      description: "Play games on macOS with native runtimes, a Metal graphics and effects layer, and tools for tinkering.",
      logo: { src: "./src/assets/maclauncher.svg" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/procrastinine/maclauncher" }],
      customCss: ["./src/styles/custom.css"],
      lastUpdated: false,
      sidebar: [
        { label: "Try the launcher", link: "/demo/" },
        { label: "Start here", items: ["introduction", "getting-started", "launcher"] },
        { label: "Background", items: ["background/how-games-run", "background/choosing-a-runtime"] },
        { label: "Games and runtimes", items: [{ autogenerate: { directory: "games" } }] },
        { label: "Graphics and effects", items: [{ autogenerate: { directory: "graphics" } }] },
        { label: "Tinker tools", items: [{ autogenerate: { directory: "tools" } }] },
        { label: "Help", items: ["help/faq"] },
        { label: "About", items: ["about/credits"] }
      ]
    })
  ]
});
