const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { build } = require("vite");
const { react, componentHarness } = require("./helpers/renderer-component");
const { createLibraryFixture } = require("./library-layout-fixture");
let GameDetails;
function elements(tree) { return React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)] : []; }
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "../src/renderer/src/ui/components/GameDetails.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "game-details-keys.cjs"), module);
  compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  GameDetails = compiled.exports.GameDetails.type;
});

test("runtime description and requirements share one help button beside Runtime", t => {
  const state = createLibraryFixture(), moduleInfo = structuredClone(state.modules[0]);
  Object.assign(moduleInfo.runtime.entries.managed, { description: "Runtime description", requirements: "Included · Apple Silicon · macOS 13.0 or later",
    preparation: "Automatic preparation", dataNotice: "Separate runtime data" });
  const actions = new Proxy({}, { get: () => async () => {} });
  const harness = componentHarness(GameDetails, { g: state.recents[0], state, moduleInfo, actions,
    moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null }); t.after(() => harness.close());
  const tree = harness.render(), nodes = elements(tree), description = nodes.filter(n => n.type?.name === "RuntimeDescription");
  assert.equal(description.length, 1);
  assert.ok(nodes.some(n => n.props.className === "detailLabel" && React.Children.toArray(n.props.children).some(c => React.isValidElement(c) && c.type?.name === "RuntimeDescription")), "Runtime help sits inside its label");
  const help = description[0].type(description[0].props);
  assert.equal(help.type.name, "HelpTip");
  const markup = renderToStaticMarkup(help);
  assert.equal((markup.match(/aria-label="About this runtime"/g) || []).length, 1);
  for (const text of ["Runtime description", "Included · Apple Silicon · macOS 13.0 or later", "Automatic preparation", "Separate runtime data"]) assert.ok(markup.includes(text));
  assert.match(markup, /popover="auto"/);
});

test("library startup keeps spinner and accessible Cancel without visible Starting text", t => {
  const state = createLibraryFixture(), g = state.recents[0], actions = new Proxy({}, { get: () => async () => {} });
  const harness = componentHarness(GameDetails, { g, state, moduleInfo: state.modules[0], actions,
    moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null }); t.after(() => harness.close());
  const component = elements(harness.render()).find(n => n.type?.type?.name === "GameActions");
  assert.ok(component);
  const render = phase => renderToStaticMarkup(React.createElement(component.type, { g, actions, isRunning: false,
    inspector: false, preparation: { phase, label: "Preparing game" } }));
  const starting = render("launch");
  assert.doesNotMatch(starting, />Starting</);
  assert.match(starting, /class="gameLaunchSpinner"/);
  assert.match(starting, /aria-label="Cancel Alpha"/);
  assert.match(starting, /aria-busy="true"/);
  assert.match(starting, /title="Starting · Cancel"/);
  assert.match(render("install"), />Installing</);
  assert.match(render("remove"), />Removing</);
});
// Simple and Advanced are views of the one mounted graphics editor; the former
// per-mode ReShadeControls and GraphicsControls are no longer mounted.
test("inspector forwards the same current live capability to Simple and Advanced mode help", t => {
  const state = createLibraryFixture(), g = state.recents[0], actions = new Proxy({}, {get: () => async () => {}});
  const props = {g, state, moduleInfo: state.modules[0], actions, moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null};
  const harness = componentHarness(GameDetails, props);t.after(() => harness.close());
  for (const graphicsLive of [false, true, false]) {
    props.runtimeStatusEntry = {runtimeId: g.runtimeId, status: {graphicsLive}};
    const nodes = elements(harness.render());
    assert.equal(nodes.filter(node => ["ReShadeControls", "GraphicsControls"].includes(node.type?.name)).length, 0);
    const sections = nodes.filter(node => node.type?.name === "EffectsControls");
    assert.equal(sections.length, 1);
    assert.deepEqual(sections.map(node => node.props.live), [graphicsLive]);
  }
});

test("network checkbox preserves the game choice across global defaults and runtimes", async t => {
  const state = createLibraryFixture(), changes = [];
  const actions = new Proxy({}, {get: (_target, key) => key === "onSetNetworkAccess"
    ? async (...args) => changes.push(args) : async () => {}});
  const props = {g: {...state.recents[0], networkAccess: false}, state, moduleInfo: state.modules[0], actions,
    moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null};
  const harness = componentHarness(GameDetails, props);t.after(() => harness.close());
  for (const enabled of [false, true]) {
    state.launcherSettings.networkAccess = enabled;
    const controls = elements(harness.render()).filter(node => node.props["aria-label"] === "Network access");
    assert.equal(controls.length, 1);
    const control = controls[0];
    assert.equal(control.type, "input");assert.equal(control.props.type, "checkbox");
    assert.equal(control.props.checked, false);
    for (const checked of [true, false]) await control.props.onChange({target: {checked}});
  }
  assert.deepEqual(changes.map(values => values[1]), [true, false, true, false]);
  props.g = {...props.g, runtimeId: "other", networkAccess: true};
  assert.equal(elements(harness.render()).find(node => node.props["aria-label"] === "Network access").props.checked, true);
});

function inspect(tree, sections = []) {
  if (!React.isValidElement(tree)) return sections;
  // React applies nested-array key prefixes here, matching sibling identity in
  // reconciliation rather than comparing unrelated keys from different lists.
  const children = React.Children.toArray(tree.props.children);
  const keys = children.filter(React.isValidElement).map(child => child.key);
  assert.equal(new Set(keys).size, keys.length, `Duplicate inspector sibling keys: ${keys.join(", ")}`);
  if (["GameNotes", "GameArguments", "EffectsControls"].includes(tree.type?.name)) sections.push(tree);
  for (const child of children) inspect(child, sections);
  return sections;
}

test("inspector stateful sections have separate sibling identities during repeated game and status updates", t => {
  const state = createLibraryFixture(), actions = new Proxy({}, { get: () => async () => {} });
  const props = { g: state.recents[0], state, moduleInfo: state.modules[0], actions,
    cheatsStatus: null, libsStatus: null, runtimeStatusEntry: null, cheatsPatchBusy: false, libsPatchBusy: false,
    moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null };
  const harness = componentHarness(GameDetails, props); t.after(() => harness.close());
  let priorGame, priorKeys;
  for (let update = 0; update < 12; update++) {
    const game = state.recents[Math.floor(update / 4) % 2];
    props.g = { ...game, gameId: update % 2 ? game.gameId : undefined,
      launchArguments: update % 2 ? "--windowed" : "", graphicsWarnings: update % 3 ? [] : ["Saved graphics status"] };
    props.runtimeStatusEntry = { runtimeId: game.runtimeId, status: { ready: Boolean(update % 2) } };
    const sections = inspect(harness.render());
    assert.equal(sections.filter(section => section.type.name === "GameArguments").length, 1);
    assert.equal(sections.length, 3);
    const keys = sections.map(section => section.key);
    if (priorGame && game.gamePath !== priorGame) assert.ok(keys.every((key, index) => key !== priorKeys[index]), "A different game resets each section's local state");
    priorGame = game.gamePath; priorKeys = keys;
  }
});
