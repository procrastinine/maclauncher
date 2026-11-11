const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const test = require("node:test");
const { build } = require("vite");

const components = path.join(__dirname, "../src/renderer/src/ui/components");
let iconLoading;
test.before(async () => {
  const result = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(components, "ExternalStoreView.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "external-store-view.cjs"), module);
  compiled.paths = module.paths;
  compiled._compile(result.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  ({ iconLoading } = compiled.exports);
});

test("Steam and External rows paint local icons with the list and load only remote artwork lazily", () => {
  for (const url of ["data:image/png;base64,AAAA", "file:///Users/example/icon.png", "maclauncher-steam://icon/440"]) {
    assert.deepEqual(iconLoading(url), { decoding: "sync" }, url);
  }
  assert.deepEqual(iconLoading("https://cdn.example.com/icon.jpg"), { loading: "lazy", decoding: "async" });
  for (const file of ["SteamView.tsx", "ExternalStoreView.tsx"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(components, file), "utf8"), /loading="lazy"/, file);
  }
});
