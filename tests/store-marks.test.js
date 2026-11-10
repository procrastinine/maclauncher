const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { build } = require("vite");

const components = path.join(__dirname, "../src/renderer/src/ui/components");
let StoreMark;
test.before(async () => {
  const result = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(components, "StoreMarks.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "store-marks.cjs"), module);
  compiled.paths = module.paths;
  compiled._compile(result.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  ({ StoreMark } = compiled.exports);
});

test("Epic, GOG and itch.io sign-in intros show the store's mark, as Steam's does", () => {
  const paths = new Set();
  for (const store of ["epic", "gog", "itch"]) {
    const markup = renderToStaticMarkup(React.createElement(StoreMark, { store, size: 42 }));
    assert.match(markup, new RegExp(`^<span class="steamMark store-${store}" aria-hidden="true"><svg viewBox="0 0 24 24" width="42" height="42"><path d="M`));
    paths.add(/<path d="([^"]+)"/.exec(markup)[1]);
  }
  assert.equal(paths.size, 3, "each store has its own glyph");
  const view = fs.readFileSync(path.join(components, "ExternalStoreView.tsx"), "utf8");
  const intro = /<div className="steamLoginIntro">[^\n]*/.exec(view)[0];
  assert.match(intro, /<StoreMark store=/);
  assert.doesNotMatch(intro, /steamBadge/);
  const css = fs.readFileSync(path.join(components, "SteamView.css"), "utf8");
  for (const store of ["epic", "gog", "itch"]) assert.match(css, new RegExp(`\\.steamMark\\.store-${store} \\{ color:`));
});
