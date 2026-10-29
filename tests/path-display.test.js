const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const Module = require("node:module");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { build } = require("vite");
let ui;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "path-display-components.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "path-display-components.cjs"), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  ui = compiled.exports;
});

test("path display preserves the filename and complete hover/accessibility path", () => {
  const value = "/Users/player/Games/Long collection/Game.exe";
  const html = renderToStaticMarkup(React.createElement(ui.PathDisplay, { path: value }));
  assert.match(html, /class="pathDisplayPrefix"/);
  assert.match(html, /class="pathDisplayName">Game.exe/);
  assert.ok(html.includes(`title="${value}"`));
  assert.ok(html.includes(`aria-label="${value}"`));
  assert.deepEqual(ui.pathDisplayParts("C:\\Games\\Adventure.exe"), { prefix: "C:\\Games\\", name: "Adventure.exe" });
  assert.deepEqual(ui.pathDisplayParts("Game.app"), { prefix: "", name: "Game.app" });
});

test("managed paths replace internal identifiers with a readable label while retaining hover details", () => {
  const value = "/launcher/games/id/modules/example/saves";
  const html = renderToStaticMarkup(React.createElement(ui.PathDisplay, { path: value, managed: true }));
  assert.equal(html, `<span title="${value}">Managed by MacLauncher</span>`);
  assert.equal(renderToStaticMarkup(React.createElement(ui.PathDisplay, {})), "<span>—</span>");
});

test("external locations identify libraries, bottles and managed downloads", () => {
  assert.equal(ui.libraryLocationLabel({ sourceLabel: "Steam" }), "Steam");
  assert.equal(ui.libraryLocationLabel({ sourceLabel: "CrossOver", bottle: "Steam" }), "CrossOver bottle: Steam");
  assert.equal(ui.libraryLocationLabel({ sourceLabel: "MacLauncher", managed: true }), "MacLauncher downloads");
  assert.equal(ui.libraryLocationLabel({ storeLabel: "GOG" }), "GOG");
  assert.equal(ui.libraryLocationLabel({}), "Local library");
});
