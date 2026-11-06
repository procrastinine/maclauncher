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
  { id: "fixture-runtime", label: "Fixture runtime", description: "A fixture package.", owner: "fixture", cache: false, error: null, importable: true, importLabel: "Add Fixture archive",
    items: [item("2.0"), item("1.0", { architecture: "universal", source: { manual: true, label: "Added manually" }, users: [] }),
      item("shared", { architecture: "arm64", removable: false, removeReason: "Installed runtimes load this library. It is removed with the last of them." })] },
  { id: "fixture-cache", label: "Fixture cache", description: null, owner: "core", cache: true, error: null, importable: false, importLabel: null, items: [] }] });

function harness(t, { answer = true, gameRunning = false, importError = null } = {}) {
  const calls = [], confirms = [];
  const api = { componentAction: async (action, payload) => {
    calls.push([action, payload]);
    if (action === "list") return listing(gameRunning);
    if (action === "import" && importError) throw new Error(importError);
    return true;
  } };
  const previous = global.window;
  global.window = { MacLauncher: { launcher: { confirmAction: async request => { confirms.push(request); return answer; } } } };
  const h = componentHarness(UI.ComponentsView, { api });
  t.after(() => { h.close(); global.window = previous; });
  return { h, calls, confirms };
}

test("Components rows show identity, CPU build, size, source and users with per-item actions", async t => {
  const { h, calls } = harness(t);
  h.render(); const tree = await h.settle(), markup = renderToStaticMarkup(tree);
  assert.deepEqual(calls, [["list", undefined]]);
  for (const text of ["Fixture runtime", "2.5 MB · Downloaded from example.test", "SHA-256 aaaaaaaaaaaa…", "Used by Fixture games",
    "Not used by an installed runtime", "2.5 MB · Added manually", "Add Fixture archive…", "Not installed.",
    "Installed runtimes load this library. It is removed with the last of them."]) assert.ok(markup.includes(text), text);
  const badges = [...markup.matchAll(/<span class="badge" title="CPU architecture">([^<]+)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(badges, ["x64", "universal", "arm64"]);
  assert.equal(button(tree, "Delete Fixture runtime shared").props.disabled, true, "an item still required cannot be deleted");
  assert.equal(button(tree, "Delete Fixture runtime 2.0").props.disabled, false);
  assert.ok(button(tree, "Show Fixture runtime 2.0 in Finder"));
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

test("Add manually reports a rejected file and Show in Finder reveals one item", async t => {
  const rejected = harness(t, { importError: "Error invoking remote method 'launcher:componentAction': Error: The file's SHA-256 is 1234; Fixture runtime 3.0 is 5678." });
  rejected.h.render(); button(await rejected.h.settle(), "Add Fixture archive…").props.onClick();
  const markup = renderToStaticMarkup(await flush(rejected.h));
  assert.ok(markup.includes("The file&#x27;s SHA-256 is 1234; Fixture runtime 3.0 is 5678."), markup);
  assert.doesNotMatch(markup, /Added Fixture runtime/);
  const accepted = harness(t);
  accepted.h.render(); let tree = await accepted.h.settle();
  button(tree, "Add Fixture archive…").props.onClick();
  tree = await flush(accepted.h);
  assert.match(renderToStaticMarkup(tree), /Added Fixture runtime\./);
  button(tree, "Show Fixture runtime 1.0 in Finder").props.onClick(); await flush(accepted.h);
  assert.deepEqual(accepted.calls.filter(([action]) => action !== "list"), [["import", { componentId: "fixture-runtime" }], ["reveal", { componentId: "fixture-runtime", itemId: "1.0" }]]);
  assert.equal(UI.componentIdentityText("SHA-1 " + "b".repeat(40)), "SHA-1 bbbbbbbbbbbb…");
  assert.equal(UI.componentSizeText({ bytes: 1024, sizeComplete: false, path: "/x" }), "At least 1.0 KB");
  assert.equal(UI.componentSourceText({ source: { label: "Created by MacLauncher" } }), "Created by MacLauncher");
});

const tool = { id: "fixture-tool", label: "Fixture tool", ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: "Fixture tool", order: 200, memberOrder: 200, management: "managed" },
  sections: [{ id: "default", label: "Fixture tool", installed: [], catalog: { status: "idle", versions: [] } }] };
const engine = { id: "fixture-engine", label: "Fixture engine", ui: { management: "managed" }, sections: [{ id: "default", label: "Fixture engine", installed: [], catalog: { status: "idle", versions: [] } }] };

test("Components is the last Tools tab, never the first tab of Runtimes", () => {
  const groups = UI.groupRuntimeManagers(UI.presentRuntimeManagers(UI.withLauncherLibraries([engine, tool])), UI.runtimeCategories);
  assert.notEqual(groups[0].id, "tools");
  const tools = groups.find(group => group.id === "tools");
  assert.equal(groups.at(-1), tools);
  const tabs = UI.runtimeSectionTabs(UI.runtimeGroupSections(tools, UI.resolveRuntimeSections));
  assert.deepEqual(tabs.map(tab => tab.label), ["Fixture tool", "Components"]);
  assert.ok(!UI.groupRuntimeManagers(UI.presentRuntimeManagers(UI.withLauncherLibraries([engine])), UI.runtimeCategories)
    .some(group => group.managers.some(manager => manager.id === "components")), "Components joins Tools only");
  const markup = render([engine, tool], "components");
  assert.match(markup, /role="tab"[^>]*aria-selected="true"[^>]*>Components</);
  assert.match(markup, /id="runtime-panel-components"/);
});

function render(managers, selected) {
  const none = () => { throw new Error("Rendering must not act"); };
  return renderToStaticMarkup(React.createElement(UI.RuntimesView, { runtimeManagers: managers, runtimeUi: {}, runtimeManagerId: selected, runtimeSectionId: "default",
    downloadTasks: [], setRuntimeManagerId() {}, setRuntimeSectionId() {}, updateRuntimeUiSection() {}, onRuntimeRefresh: none, onRuntimeInstall: none,
    onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {}, onOpenSource: none }));
}
