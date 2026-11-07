const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
const { react, componentHarness } = require('./helpers/renderer-component');
const video = require('../src/modules/video/manifest.json');

let C;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'plugin-settings-components.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'plugin-settings-components.cjs'), module);
  compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  C = compiled.exports;
});

function nodes(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) nodes(child, found); return found; }
  if (!React.isValidElement(node)) return found;
  found.push(node); nodes(node.props.children, found); return found;
}
const labelled = (tree, label) => nodes(tree).find(node => node.props?.['aria-label'] === label);

// The mpv plugin library as the launcher state carries it: uosc is a built-in
// plugin with a runtime setting, and a plugin added from a URL has its own switch.
function fixture() {
  const ui = video.runtime.managerUi['mpv-plugins'];
  const sections = [
    { id: 'uosc', label: 'uosc', plugin: { version: '5.13.0', settingKey: 'uosc', description: 'Controls.' }, installed: [{ version: '5.13.0', ready: true }] },
    { id: 'thumbfast', label: 'thumbfast', plugin: { version: 'f00d', settingKey: 'timelinePreviews' }, installed: [] },
    { id: 'custom-one', label: 'Added script', plugin: { version: 'abc', custom: true, enabled: false }, installed: [{ version: 'abc', ready: true }] }];
  const manager = { id: 'mpv-plugins', label: 'mpv plugins', ui, sections };
  const state = { modules: [video], moduleSettings: {}, runtimeDefaults: {}, runtimeManagers: { 'mpv-plugins': manager } };
  return { manager, state, sections };
}

test('Runtimes plugin cards install, update and remove without enable switches or configuration', async t => {
  const { manager, state, sections } = fixture(), installs = [], removals = [], settings = [];
  const api = { moduleSettingsAction: async () => true, setGameRuntimeSettings: async () => {},
    setModuleRuntimeSettings: async (...args) => { settings.push(args); } };
  const choices = sections.map(section => ({ id: JSON.stringify(['mpv-plugins', section.id]), label: section.label, managerId: 'mpv-plugins', sectionId: section.id, manager, section }));
  const h = componentHarness(C.PluginLibrary, { manager, sections: choices, state, api, ui: {}, downloads: [],
    onInstall: async (...args) => { installs.push(args); return true; }, onUninstall: async (...args) => { removals.push(args); return true; } });
  t.after(() => h.close());
  const tree = h.render(), markup = renderToStaticMarkup(tree);
  assert.doesNotMatch(markup, /type="checkbox"/, 'whether a plugin is used is set in Settings');
  assert.doesNotMatch(markup, /Configuration and scripts|Configuration folder|Input configuration/);
  assert.match(markup, /aria-label="Remove uosc"/); assert.match(markup, /aria-label="Install thumbfast"/);
  assert.match(markup, /aria-label="Remove Added script"/); assert.match(markup, />Add plugin</);
  await labelled(tree, 'Remove uosc').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removals.map(args => args.slice(0, 2)), [['mpv-plugins', 'uosc']]);
  assert.equal(settings.length, 1, 'removing a plugin turns its setting off');
  assert.equal(settings[0][0], 'video'); assert.equal(settings[0][1], 'mpv'); assert.equal(settings[0][2].uosc, false);
  await labelled(tree, 'Install thumbfast').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(installs, [['mpv-plugins', 'thumbfast', 'f00d']]);
  assert.equal(video.runtime.entries.mpv.settings.defaults.timelinePreviews, true);
  assert.equal(settings.at(-1)[2], null, 'installing a plugin turns its setting on, the default, so nothing is stored');
});

test('Settings shows the switch of each added plugin with the runtime settings and saves it through the plugin action', async t => {
  const { state } = fixture(), calls = [];
  const api = { moduleSettingsAction: async (...args) => { calls.push(args); return true; }, setModuleRuntimeSettings: async () => {}, setGameRuntimeSettings: async () => {} };
  const h = componentHarness(C.PluginSettings, { state, api, moduleId: 'video', runtimeId: 'mpv' });
  t.after(() => h.close());
  const tree = h.render(), markup = renderToStaticMarkup(tree);
  assert.match(markup, />Added plugins</); assert.match(markup, />Added script</);
  assert.doesNotMatch(markup, />uosc</, 'a plugin named by the runtime schema keeps its own runtime setting');
  nodes(tree).find(node => node.props?.label === 'Use Added script').props.onChange(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['video', 'setPluginEnabled', { id: 'custom-one', enabled: true }]]);
  const other = componentHarness(C.PluginSettings, { state, api, moduleId: 'video', runtimeId: 'other' });
  t.after(() => other.close());
  assert.equal(other.render(), null, 'another runtime has no plugin switches');
});
