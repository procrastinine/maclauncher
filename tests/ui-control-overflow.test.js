const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

async function load(relative) {
  const bundle = await require("vite").build({ configFile: false, logLevel: "silent", build: {
    ssr: path.resolve(__dirname, "../src/renderer/src/ui", relative), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "control-overflow-render.cjs"), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  return compiled.exports;
}
const loaded = Promise.all([load("components/Select.tsx"), load("ui-helpers.ts")]);

test("closed native selects expose their full displayed label and exact saved version", async () => {
  const [{ Select }] = await loaded;
  const change = () => {}, version = "0.7.7beta-MCLv1";
  const element = Select({ value: version, onChange: change, "aria-label": "Version", className: "input",
    children: React.createElement("optgroup", { label: "Installed" },
      React.createElement("option", { value: version }, "0.7.7 beta")) });
  assert.equal(element.type, "select");
  assert.equal(element.props.value, version);
  assert.equal(element.props.onChange, change);
  assert.equal(element.props.title, "0.7.7 beta (0.7.7beta-MCLv1)");
  const markup = renderToStaticMarkup(element);
  assert.match(markup, /aria-label="Version"/);
  assert.match(markup, /value="0\.7\.7beta-MCLv1" selected=""/);
});

test("automatic defaults retain exact identity in the title and explicit titles remain intact", async () => {
  const [{ Select }] = await loaded;
  const children = [React.createElement("option", { key: "default", value: "", title: "MCLv1-1003" }, "Default (MacLauncher build 1-1003)"),
    React.createElement("option", { key: "other", value: "other" }, "Other")];
  assert.equal(Select({ value: "", children }).props.title, "Default (MacLauncher build 1-1003) (MCLv1-1003)");
  assert.equal(Select({ value: "", title: "Custom help", children }).props.title, "Custom help");
  assert.equal(Select({ value: ["other"], multiple: true, children }).props.title, undefined);
});

test("package version labels keep upstream distinctions and explicit release names", async () => {
  const [, { resolveRuntimeVersionLabel, formatRuntimeVersionTag }] = await loaded;
  assert.equal(formatRuntimeVersionTag("v0.7.7beta-MCLv1"), "0.7.7 beta");
  assert.equal(formatRuntimeVersionTag("MCLv1-1003"), "MacLauncher build 1-1003");
  assert.equal(formatRuntimeVersionTag("MCLv7"), "MacLauncher build 7");
  assert.equal(formatRuntimeVersionTag("MCLv1-1003", { versionLabels: { "MCLv1-1003": "MCLv1-1003" } }), "MacLauncher build 1-1003");
  assert.equal(formatRuntimeVersionTag("5.3.2p3"), "v5.3.2p3");
  assert.equal(formatRuntimeVersionTag("0.1.0-alpha2"), "v0.1.0-alpha2");
  assert.equal(resolveRuntimeVersionLabel("MCLv1-1003", { versionLabels: { "MCLv1-1003": "Spring release" } }), "Spring release");
  assert.equal(formatRuntimeVersionTag("copy-b", { versionLabels: { "copy-b": "26.0 · Player Beta.app" } }), "v26.0 · Player Beta.app");
  assert.equal(resolveRuntimeVersionLabel("abc123", { catalog: { versionLabels: { abc123: "2026-06-28 snapshot" } } }), "2026-06-28 snapshot");
});
