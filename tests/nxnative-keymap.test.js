const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { build } = require("vite");
const manifest = require("../src/modules/nxnative/manifest.json");
let RuntimeSettingsWindow;

test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "../src/renderer/src/ui/components/RuntimeSettingsWindow.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs" } }
  } });
  const compiled = new Module(path.join(__dirname, "nxnative-keymap.cjs"), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  RuntimeSettingsWindow = compiled.exports.RuntimeSettingsWindow;
});

for (const scope of ["module", "game"]) test(`nxnative ${scope} settings show fixed mappings without editable mapping controls`, () => {
  const gamePath = "/fixture/game.nsp";
  const state = { modules: [manifest], settings: {}, moduleSettings: {}, runtimeDefaults: {},
    recents: [{ gamePath, gameType: "switch", runtimeSettings: {} }] };
  const html = renderToStaticMarkup(React.createElement(RuntimeSettingsWindow, {
    api: {}, state, inline: true, error: null,
    context: { scope, moduleId: "nxnative", runtimeId: "nxnative", ...(scope === "game" ? { gamePath } : {}) }
  }));
  assert.match(html, /Fixed keyboard mapping/);
  assert.match(html, /nxnative uses fixed physical key positions; keyboard remapping is not supported\./);
  assert.match(html, /Fixed controller mapping/);
  assert.match(html, /controller remapping is not supported/);
  assert.match(html, /<th scope="row">A \/ B \/ X \/ Y<\/th><td>J \/ K \/ U \/ I<\/td>/);
  assert.match(html, /<th scope="row">Left stick<\/th><td>W A S D<\/td>/);
  assert.match(html, /<th scope="row">Right stick<\/th><td>No keyboard binding<\/td>/);
  assert.match(html, /Right \/ Bottom \/ Top \/ Left/);
  const fields = manifest.runtime.entries.nxnative.settings.fields.filter(field => field.type === "display");
  for (const field of fields) {
    const table = html.match(new RegExp(`<table[^>]+aria-label="${field.label}"[\\s\\S]*?<\\/table>`))?.[0];
    assert.ok(table, `${field.label} is accessible as a table`);
    assert.doesNotMatch(table, /<(?:input|select|button)\b|disabled|unavailable/i);
  }
});
