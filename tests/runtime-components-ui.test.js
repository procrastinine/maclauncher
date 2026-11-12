const assert = require("node:assert/strict"), path = require("node:path"), test = require("node:test"), Module = require("node:module");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server"), { build } = require("vite");
const { react, componentHarness } = require("./helpers/renderer-component");
let UI;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "runtime-components-ui.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } } } });
  const compiled = new Module(path.join(__dirname, "runtime-components-ui.cjs"), module);
  compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  UI = compiled.exports;
});
const elements = element => !React.isValidElement(element) ? [] : [element, ...React.Children.toArray(element.props.children).flatMap(elements)];
const flush = async h => { let tree; for (let index = 0; index < 6; index++) tree = await h.settle(); return tree; };
const button = (tree, label) => elements(tree).find(node => node.type === "button" && (node.props["aria-label"] === label || node.props.children === label));

const item = (id, extra = {}) => ({ id, version: id, identity: "SHA-256 " + "a".repeat(64), architecture: "x64", path: `/Fixture/${id}`, bytes: 2.5 * 1024 * 1024,
  sizeComplete: true, source: { url: "https://example.test/fixture.tar.gz", label: null }, users: ["Fixture games"], status: null, removable: true, removeReason: null, ...extra });
const listing = (gameRunning = false) => ({ gameRunning, components: [
  { id: "fixture-runtime", label: "Fixture runtime", description: "A fixture package.", owner: "fixture", cache: false, error: null,
    items: [item("2.0"), item("1.0", { architecture: "universal", source: { manual: true, label: "Added manually" }, users: [], bytes: 1024 }),
      item("shared", { architecture: "arm64", bytes: 9 * 1024 * 1024, removable: false, removeReason: "Installed runtimes load this library. It is removed with the last of them." })] },
  { id: "fixture-windows", label: "Fixture adapter", description: null, owner: "fixture", cache: false, error: null,
    items: [item("0.5", { windows: true, users: [], bytes: 2048 })] },
  { id: "fixture-cache", label: "Fixture cache", description: null, owner: "core", cache: true, error: null, items: [] }] });

function harness(t, { answer = true, gameRunning = false, importError = null } = {}) {
  const calls = [], confirms = [];
  const api = { componentAction: async (action, payload) => {
    calls.push([action, payload]);
    if (action === "list") return listing(gameRunning);
    if (action === "import") { if (importError) throw new Error(importError); return { componentId: "fixture-runtime", label: "Fixture runtime" }; }
    return true;
  } };
  const previous = global.window;
  global.window = { MacLauncher: { launcher: { confirmAction: async request => { confirms.push(request); return answer; } } } };
  const h = componentHarness(UI.ComponentsView, { api });
  t.after(() => { h.close(); global.window = previous; });
  return { h, calls, confirms };
}

test("Downloaded files lists installed items largest first with CPU, size, source and users, and digests in tooltips", async t => {
  const { h, calls } = harness(t);
  h.render(); const tree = await h.settle(), markup = renderToStaticMarkup(tree);
  assert.deepEqual(calls, [["list", undefined]]);
  for (const text of ["Downloaded files", "Add from file…", "Delete unused", "2.5 MB · Downloaded from example.test", "Used by Fixture games",
    "Not used by an installed runtime", "1.0 KB · Added manually", "Installed runtimes load this library. It is removed with the last of them."]) assert.ok(markup.includes(text), text);
  assert.doesNotMatch(markup, /Fixture cache|Not installed/, "components without installed items are not listed");
  const names = [...markup.matchAll(/data-component-item="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(names, ["shared", "2.0", "0.5", "1.0"], "largest first");
  assert.match(markup, new RegExp(`<span title="SHA-256 ${"a".repeat(64)}">Fixture runtime 2\\.0</span>`), "the digest is the name's tooltip");
  assert.doesNotMatch(markup, />SHA-256 /, "no digest in the row text");
  const badges = [...markup.matchAll(/<span class="badge" title="CPU architecture">([^<]+)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(badges, ["Apple Silicon", "Intel", "x64", "Universal"], "Mac code in Mac names, Windows code in Windows names");
  assert.equal(button(tree, "Delete Fixture runtime shared").props.disabled, true, "an item still required cannot be deleted");
  assert.equal(button(tree, "Delete Fixture runtime 2.0").props.disabled, false);
  assert.ok(button(tree, "Show Fixture runtime 2.0 in Finder"));
  assert.equal(elements(tree).filter(node => node.type === "button" && /^Add /.test(String(node.props.children))).length, 1, "one Add from file");
});

// Opening Downloaded files draws the last list it read at once; a backend
// worker reads the files again and the rows follow. Deleting waits for that
// read, since a file's users may have changed in the meantime.
test("Downloaded files opens with the last list read, reads the files again and enables Delete after that read", async t => {
  const stored = new Map(), previous = global.window;
  const localStorage = { getItem: key => stored.has(key) ? stored.get(key) : null, setItem: (key, value) => stored.set(key, String(value)) };
  global.window = { localStorage, MacLauncher: { launcher: { confirmAction: async () => true } } };
  t.after(() => { global.window = previous; });
  const mount = componentAction => { const h = componentHarness(UI.ComponentsView, { api: { componentAction } }); t.after(() => h.close()); return h; };

  const first = mount(async () => listing());
  first.render(); await flush(first);
  assert.ok(stored.get("maclauncher:downloaded-files"), "a completed read is kept");

  let answer;
  const reading = mount(action => { assert.equal(action, "list"); return new Promise(resolve => { answer = resolve; }); });
  const drawn = reading.render(), markup = renderToStaticMarkup(drawn);
  assert.match(markup, /Fixture runtime 2\.0/, "the first drawing lists the kept rows");
  assert.doesNotMatch(markup, /role="status">Reading downloaded files/);
  assert.equal(button(drawn, "Reload downloaded files").props["aria-busy"], true, "the files are read again");
  assert.equal(button(drawn, "Delete Fixture runtime 2.0").props.disabled, true, "Delete waits for the new read");
  assert.equal(button(drawn, "Delete Fixture runtime 2.0").props.title, "Reading downloaded files…");
  assert.equal(button(drawn, "Delete unused").props.disabled, true);
  assert.equal(button(drawn, "Show Fixture runtime 2.0 in Finder").props.disabled, false);
  const changed = listing();
  changed.components[0].items = changed.components[0].items.filter(item => item.id !== "2.0");
  answer(changed);
  const read = await flush(reading);
  assert.doesNotMatch(renderToStaticMarkup(read), /Fixture runtime 2\.0/, "the new read replaces the kept rows");
  assert.equal(button(read, "Delete Fixture runtime 1.0").props.disabled, false);
  assert.equal(button(read, "Delete unused").props.disabled, false);
  assert.deepEqual(JSON.parse(stored.get("maclauncher:downloaded-files")), changed, "the new read is kept");

  // Reload also waits for current users before allowing deletion.
  button(read, "Reload downloaded files").props.onClick();
  const reloading = reading.render();
  assert.equal(button(reloading, "Delete unused").props.disabled, true);
  assert.equal(button(reloading, "Delete Fixture runtime 1.0").props.disabled, true);
  answer(changed); await flush(reading);

  const malformedLabel = listing(); delete malformedLabel.components[0].label;
  stored.set("maclauncher:downloaded-files", JSON.stringify(malformedLabel));
  const invalidLabel = mount(() => new Promise(() => {}));
  assert.match(renderToStaticMarkup(invalidLabel.render()), /role="status">Reading downloaded files/);

  stored.set("maclauncher:downloaded-files", JSON.stringify({ components: [{ id: "broken" }] }));
  const malformed = mount(() => new Promise(() => {}));
  assert.match(renderToStaticMarkup(malformed.render()), /role="status">Reading downloaded files…/, "a kept value of another shape is not drawn");
  global.window = { MacLauncher: previous?.MacLauncher };
  const unavailable = mount(() => new Promise(() => {}));
  assert.match(renderToStaticMarkup(unavailable.render()), /Reading downloaded files…/, "without page storage the view reads as before");
});

test("Delete warns with the item's users and a running game, and canceling deletes nothing", async t => {
  const declined = harness(t, { answer: false, gameRunning: true });
  declined.h.render(); button(await declined.h.settle(), "Delete Fixture runtime 2.0").props.onClick(); await flush(declined.h);
  assert.deepEqual(declined.confirms, [{ message: "Delete Fixture runtime 2.0?", confirmLabel: "Delete", destructive: true,
    detail: "In use by Fixture games. A running game keeps the files it already loaded until it quits. MacLauncher asks before downloading it again the next time something needs it." }]);
  assert.ok(!declined.calls.some(([action]) => action === "remove"));
  const accepted = harness(t);
  accepted.h.render(); button(await accepted.h.settle(), "Delete Fixture runtime 2.0").props.onClick(); await flush(accepted.h);
  assert.deepEqual(accepted.calls.filter(([action]) => action !== "list"), [["remove", { componentId: "fixture-runtime", itemId: "2.0" }]]);
  assert.equal(accepted.calls.at(-1)[0], "list", "the list is read again after deletion");
  assert.match(renderToStaticMarkup(await flush(accepted.h)), /Deleted Fixture runtime 2\.0\./);
  assert.equal(UI.componentDeleteRequest({ label: "Download cache", cache: true }, { version: "", users: [] }).detail, "MacLauncher fills it again when needed.");
});

test("Delete unused confirms once with every unused item and deletes only those", async t => {
  const declined = harness(t, { answer: false });
  declined.h.render(); button(await declined.h.settle(), "Delete unused").props.onClick(); await flush(declined.h);
  assert.deepEqual(declined.confirms, [{ message: "Delete 2 unused downloads?", confirmLabel: "Delete", destructive: true,
    detail: "Fixture adapter 0.5, Fixture runtime 1.0. MacLauncher asks before downloading one again the next time something needs it." }]);
  assert.ok(!declined.calls.some(([action]) => action === "remove"));
  const accepted = harness(t);
  accepted.h.render(); button(await accepted.h.settle(), "Delete unused").props.onClick();
  assert.match(renderToStaticMarkup(await flush(accepted.h)), /Deleted 2 unused downloads\./);
  assert.deepEqual(accepted.calls.filter(([action]) => action === "remove"), [["remove", { componentId: "fixture-windows", itemId: "0.5" }],
    ["remove", { componentId: "fixture-runtime", itemId: "1.0" }]], "items in use or still required stay");
});

test("Add from file reports a rejected file and Show in Finder reveals one item", async t => {
  const rejected = harness(t, { importError: "Error invoking remote method 'launcher:componentAction': Error: This file matches no download that MacLauncher records. Its SHA-256 is 1234." });
  rejected.h.render(); button(await rejected.h.settle(), "Add from file…").props.onClick();
  const markup = renderToStaticMarkup(await flush(rejected.h));
  assert.ok(markup.includes("This file matches no download that MacLauncher records. Its SHA-256 is 1234."), markup);
  assert.doesNotMatch(markup, /Added Fixture runtime/);
  const accepted = harness(t);
  accepted.h.render(); let tree = await accepted.h.settle();
  button(tree, "Add from file…").props.onClick();
  tree = await flush(accepted.h);
  assert.match(renderToStaticMarkup(tree), /Added Fixture runtime\./);
  button(tree, "Show Fixture runtime 1.0 in Finder").props.onClick(); await flush(accepted.h);
  assert.deepEqual(accepted.calls.filter(([action]) => action !== "list"), [["import", undefined], ["reveal", { componentId: "fixture-runtime", itemId: "1.0" }]]);
  assert.equal(UI.componentSizeText({ bytes: 1024, sizeComplete: false, path: "/x" }), "At least 1.0 KB");
  assert.equal(UI.componentSourceText({ source: { label: "Created by MacLauncher" } }), "Created by MacLauncher");
});

const tool = { id: "fixture-tool", label: "Fixture tool", ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: "Fixture tool", order: 200, memberOrder: 200, management: "managed" },
  sections: [{ id: "default", label: "Fixture tool", installed: [], catalog: { status: "idle", versions: [] } }] };
const engine = { id: "fixture-engine", label: "Fixture engine", ui: { management: "managed" }, sections: [{ id: "default", label: "Fixture engine", installed: [], catalog: { status: "idle", versions: [] } }] };

test("Downloaded files is the last Tools tab, never the first tab of Runtimes", () => {
  const groups = UI.groupRuntimeManagers(UI.presentRuntimeManagers(UI.withLauncherLibraries([engine, tool])), UI.runtimeCategories);
  assert.notEqual(groups[0].id, "tools");
  const tools = groups.find(group => group.id === "tools");
  assert.equal(groups.at(-1), tools);
  const tabs = UI.runtimeSectionTabs(UI.runtimeGroupSections(tools, UI.resolveRuntimeSections));
  assert.deepEqual(tabs.map(tab => tab.label), ["Fixture tool", "Downloaded files"]);
  assert.ok(!UI.groupRuntimeManagers(UI.presentRuntimeManagers(UI.withLauncherLibraries([engine])), UI.runtimeCategories)
    .some(group => group.managers.some(manager => manager.id === "components")), "Downloaded files joins Tools only");
  const markup = render([engine, tool], "components");
  assert.match(markup, /role="tab"[^>]*aria-selected="true"[^>]*>Downloaded files</);
  assert.match(markup, /id="runtime-panel-components"/);
});

function render(managers, selected) {
  const none = () => { throw new Error("Rendering must not act"); };
  return renderToStaticMarkup(React.createElement(UI.RuntimesView, { runtimeManagers: managers, runtimeUi: {}, runtimeManagerId: selected, runtimeSectionId: "default",
    downloadTasks: [], setRuntimeManagerId() {}, setRuntimeSectionId() {}, updateRuntimeUiSection() {}, onRuntimeRefresh: none, onRuntimeInstall: none,
    onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {}, onOpenSource: none }));
}
