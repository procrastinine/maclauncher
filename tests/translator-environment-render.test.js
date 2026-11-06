const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
const { react, componentHarness } = require('./helpers/renderer-component');
const Registry = require('../src/modules/registry');

let C;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'translator-environment-components.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'translator-environment-components.cjs'), module);
  compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  C = compiled.exports;
});

// Declarations reach the renderer as plain data in the launcher state.
const declarations = () => JSON.parse(JSON.stringify(Registry.listTranslatorEnvironments()));
const declaration = id => declarations().find(item => item.id === id);
function nodes(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) nodes(child, found); return found; }
  if (!React.isValidElement(node)) return found;
  found.push(node); nodes(node.props.children, found); return found;
}
const labelled = (tree, label) => nodes(tree).find(node => node.props?.['aria-label'] === label);
const tick = () => new Promise(resolve => setImmediate(resolve));

function runtimesView(managerId, state, settingsApi) {
  const runtime = { id: managerId, label: managerId, ui: {}, catalog: { status: 'idle', versions: [] }, installed: [] };
  return renderToStaticMarkup(React.createElement(C.RuntimesView, { runtimeManagers: [runtime], runtimeUi: {}, runtimeManagerId: managerId,
    runtimeSectionId: 'default', downloadTasks: [], downloadsOpen: false, setDownloadsOpen() {}, setRuntimeManagerId() {}, setRuntimeSectionId() {},
    updateRuntimeUiSection() {}, onRuntimeRefresh() {}, onRuntimeInstall() {}, onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {},
    state, settingsApi }));
}

test('the Runtimes window shows the global Environment editor of the selected translator', () => {
  const state = { translatorEnvironments: declarations(),
    launcherSettings: { translatorEnvironment: { dxvk: { DXVK_HUD: 'fps', CUSTOM_PATH: '$HOME/literal "quoted"' } } } };
  const api = { setModuleRuntimeSettings: async () => {}, setGameRuntimeSettings: async () => {}, setTranslatorEnvironment: async () => {} };
  const markup = runtimesView('translator-dxvk', state, api);
  assert.match(markup, /<section class="runtimeSectionCard" aria-label="Environment variables">/);
  assert.match(markup, /aria-label="DXVK environment"/);
  assert.match(markup, />DXVK_HUD<\/span>/); assert.match(markup, /aria-label="DXVK_HUD value"[^>]*value="fps"|value="fps"[^>]*aria-label="DXVK_HUD value"/);
  assert.ok(markup.includes('value="$HOME/literal &quot;quoted&quot;"'), 'values render literally');
  assert.match(markup, /title="Set by DXVK HUD in Runtime Settings\.">Replaces launcher value</);
  assert.match(markup, /<option value="DXVK_CONFIG">/); assert.doesNotMatch(markup, /<option value="DXVK_HUD">/, 'present names are not suggested again');
  assert.match(markup, /aria-label="Remove CUSTOM_PATH"/); assert.match(markup, /aria-label="New DXVK variable name"/);
  assert.match(markup, />Reset</);
  // KosmicKrisp has two managers; Wine runtimes list only their own environment.
  assert.match(runtimesView('maclauncher-kosmickrisp', state, api), /aria-label="KosmicKrisp environment"/);
  const wine = runtimesView('crossover', state, api);
  assert.match(wine, /aria-label="CrossOver environment"/); assert.doesNotMatch(wine, /DXVK environment/);
  assert.match(wine, /No variables\./);
  assert.doesNotMatch(runtimesView('fixture-manager', state, api), /aria-label="Environment variables"/);
  assert.doesNotMatch(runtimesView('translator-dxvk', state, { setModuleRuntimeSettings: async () => {}, setGameRuntimeSettings: async () => {} }), /aria-label="Environment variables"/);
});

test('editor rows change, remove, restore and add values literally and refuse locked names', async t => {
  const saves = [];
  const h = componentHarness(C.TranslatorEnvironmentEditor, { declaration: declaration('crossover'), scope: 'game',
    global: { SHARED: 'global', WINEDEBUG: '-all' }, earlier: { OLD: '1' }, game: { SHARED: 'game' },
    onSave: async values => { saves.push(values); } });
  t.after(() => h.close());
  let tree = h.render();
  const markup = renderToStaticMarkup(tree);
  assert.match(markup, /title="Set by Wine debug channels in Runtime Settings\.">Replaces launcher value</);
  assert.match(markup, /title="From the Environment variables setting of an earlier MacLauncher version\.">Earlier setting</);
  assert.match(markup, />Changed</); assert.match(markup, />Global</);
  labelled(tree, 'Remove WINEDEBUG').props.onClick(); await tick();
  assert.deepEqual(saves.at(-1), { SHARED: 'game', WINEDEBUG: null }, 'removing an inherited value stores a removal');
  labelled(tree, 'Restore SHARED').props.onClick(); await tick();
  assert.equal(saves.at(-1), null, 'restoring the only game value clears the game entry');
  await labelled(tree, 'OLD value').props.onCommit('1');
  assert.deepEqual(saves.at(-1), { SHARED: 'game' }, 'a value equal to the inherited one is not stored');
  await labelled(tree, 'OLD value').props.onCommit('$X `y` \'z\'');
  assert.deepEqual(saves.at(-1), { SHARED: 'game', OLD: '$X `y` \'z\'' });
  labelled(tree, 'New CrossOver variable name').props.onChange({ currentTarget: { value: 'NEW_NAME' } }); tree = h.render();
  labelled(tree, 'New CrossOver variable value').props.onChange({ currentTarget: { value: ' spaced ' } }); tree = h.render();
  await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saves.at(-1), { SHARED: 'game', NEW_NAME: ' spaced ' }, 'values keep surrounding spaces');
  tree = h.render();
  assert.equal(labelled(tree, 'New CrossOver variable name').props.value, '', 'a saved row clears the add form');
  labelled(tree, 'New CrossOver variable name').props.onChange({ currentTarget: { value: 'WINEPREFIX' } }); tree = h.render();
  assert.equal(nodes(tree).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
  assert.match(renderToStaticMarkup(tree), /WINEPREFIX is set by MacLauncher\. The launcher sets this path/);
  labelled(tree, 'New CrossOver variable name').props.onChange({ currentTarget: { value: '1BAD' } }); tree = h.render();
  const count = saves.length;
  await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(saves.length, count); assert.match(renderToStaticMarkup(h.render()), /1BAD is not a valid variable name/);
  let escaped = false;
  labelled(h.render(), 'New CrossOver variable name').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() { escaped = true; } });
  assert.equal(escaped, true); assert.equal(labelled(h.render(), 'New CrossOver variable name').props.value, '', 'Escape clears the add form');
});

test('a game section loads the translators its settings choose and passes the stored layers', async t => {
  const loads = [];
  const props = { declarations: declarations(), globalStore: { anyps5: { SHARED: 'global' } }, gameStore: { kosmickrisp: { MESA_KK_DEBUG: 'msl' } },
    loadKey: 'first', load: async () => { loads.push('load'); return { translatorEnvironments: ['anyps5', 'kosmickrisp', 'anyps5', 'unknown'] }; },
    onSave: async () => {} };
  const h = componentHarness(C.GameTranslatorEnvironment, props); t.after(() => h.close());
  assert.match(renderToStaticMarkup(h.render()), /Loading translators/);
  const tree = await h.settle();
  const list = nodes(tree).find(node => Array.isArray(node.props?.declarations));
  assert.deepEqual(list.props.declarations.map(item => item.id), ['anyps5', 'kosmickrisp']);
  assert.equal(list.props.globalStore, props.globalStore); assert.equal(list.props.gameStore, props.gameStore); assert.equal(list.props.scope, 'game');
  const markup = renderToStaticMarkup(tree);
  assert.match(markup, /aria-label="AnyPS5 environment"/); assert.match(markup, /aria-label="KosmicKrisp environment"/);
  assert.match(markup, />SHARED<\/span>/); assert.match(markup, />MESA_KK_DEBUG<\/span>/);
  assert.match(markup, /title="MacLauncher sets installed\.">|<option value="APS5_PLAYGO_UNLISTED_CHUNKS">/);
  assert.equal(loads.length, 1);
  const shared = componentHarness(C.GameTranslatorEnvironment, { ...props, load: undefined, result: { translatorEnvironments: [] } });
  t.after(() => shared.close());
  assert.match(renderToStaticMarkup(shared.render()), /No translator environment applies with these settings\./);
});

test('game Runtime Settings request the schema environment action with the edited settings', async t => {
  const state = require('./library-layout-fixture').createLibraryFixture();
  state.modules[0].runtime.entries.managed.settings = { fields: [{ key: 'scale', label: 'Scale', type: 'number', default: 1 }],
    environmentAction: 'listTranslatorEnvironments' };
  state.translatorEnvironments = declarations();
  state.launcherSettings.translatorEnvironment = { anyps5: { SHARED: 'global' } };
  const game = state.recents[0]; game.translatorEnvironment = { anyps5: { SHARED: 'game' } };
  const calls = [], saves = [];
  const api = { moduleAction: async (...args) => { calls.push(args); return { translatorEnvironments: ['anyps5'] }; },
    setModuleRuntimeSettings: async () => {}, setGameRuntimeSettings: async () => {},
    setGameTranslatorEnvironment: async (...args) => { saves.push(args); return true; } };
  const h = componentHarness(C.RuntimeSettingsWindow, { api, state, context: { scope: 'game', moduleId: 'fixture', runtimeId: 'managed', gamePath: game.gamePath }, error: null });
  t.after(() => h.close());
  h.render();
  const tree = await h.settle();
  const section = nodes(tree).find(node => node.type === C.GameTranslatorEnvironment);
  assert.ok(section, 'the game scope shows the Environment section');
  assert.equal(section.props.gameStore, game.translatorEnvironment); assert.equal(section.props.globalStore, state.launcherSettings.translatorEnvironment);
  assert.equal(section.props.result, undefined, 'an action that no field uses is requested by the section');
  assert.deepEqual(await section.props.load(), { translatorEnvironments: ['anyps5'] });
  const [gamePath, action, payload, options] = calls.at(-1);
  assert.equal(gamePath, game.gamePath); assert.equal(action, 'listTranslatorEnvironments'); assert.deepEqual(options, { runtimeId: 'managed' });
  assert.equal(payload.runtimeSettings.scale, 1);
  await section.props.onSave('anyps5', { SHARED: 'changed' });
  assert.deepEqual(saves, [[game.gamePath, 'anyps5', { SHARED: 'changed' }]]);
  const moduleScope = componentHarness(C.RuntimeSettingsWindow, { api, state, context: { scope: 'module', moduleId: 'fixture', runtimeId: 'managed' }, error: null });
  t.after(() => moduleScope.close());
  moduleScope.render();
  assert.equal(nodes(await moduleScope.settle()).some(node => node.type === C.GameTranslatorEnvironment), false, 'game type defaults have no environment section');
});
