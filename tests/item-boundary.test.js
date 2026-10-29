const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), Module = require("node:module"), React = require("react");
const {renderToStaticMarkup} = require("react-dom/server");
const {build} = require("vite");

async function load() {
  const result = await build({configFile: false, logLevel: "silent", build: {ssr: path.join(__dirname, "../src/renderer/src/ui/components/ItemBoundary.tsx"), write: false,
    rollupOptions: {external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: {format: "cjs", codeSplitting: false}}}});
  const m = new Module(path.join(__dirname, "item-boundary.cjs"), module);m.paths = module.paths;
  m._compile(result.output.find(row => row.type === "chunk").code, m.id);
  return m.exports;
}

test("one list item that fails to render is replaced by its reason while the other items render", async () => {
  const {isolatedItem} = await load();
  const rows = ["first", "broken", "last"].map(id => isolatedItem(id, {label: "This effect", as: "li", reset: id,
    action: React.createElement("button", null, "Remove")}, () => {
    if (id === "broken") throw new Error("The row has no shader.");
    return React.createElement("li", {key: id}, id);
  }));
  const markup = renderToStaticMarkup(React.createElement("ol", null, rows));
  assert.match(markup, /<li>first<\/li>/);assert.match(markup, /<li>last<\/li>/);
  assert.match(markup, /This effect could not be displayed\. The row has no shader\./);assert.match(markup, /<button>Remove<\/button>/);
  // A component that throws while rendering is contained by the item's boundary.
  const Boundary = rows[0].type, failed = Boundary.getDerivedStateFromError(new Error("render failed"));
  assert.deepEqual(failed, {error: new Error("render failed")});
  assert.equal(Boundary.getDerivedStateFromProps({reset: "same"}, {...failed, reset: "same"}), null, "the failure stays until the item changes");
  assert.deepEqual(Boundary.getDerivedStateFromProps({reset: "next"}, {...failed, reset: "same"}), {error: undefined, reset: "next"});
});
