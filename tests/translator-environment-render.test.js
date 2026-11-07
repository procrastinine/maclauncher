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

function settingsView(state, api) {
  return renderToStaticMarkup(React.createElement(C.SettingsView, { state: { modules: [], recents: [], ...state, launcherSettings: { ...state.launcherSettings } },
    api, sectionId: 'environment', showIcons: true, showNonDefaultTags: false, onSetLauncherSettings() {}, onSetModuleSettings() {} }));
}

test('Settings lists the global values of every translator once, each in a collapsed block, and Runtimes lists none', () => {
  const state = { translatorEnvironments: declarations(),
    launcherSettings: { translatorEnvironment: { dxvk: { DXVK_HUD: 'fps', CUSTOM_PATH: '$HOME/literal "quoted"' },
      'android-jvm': { JDK_JAVA_OPTIONS: '-Xmx4g' }, angle: { MTL_HUD_ENABLED: '1' } } } };
  const api = { setModuleRuntimeSettings: async () => {}, setGameRuntimeSettings: async () => {}, setTranslatorEnvironment: async () => {} };
  const markup = settingsView(state, api);
  assert.match(markup, /id="settings-panel-environment"/, 'Environment variables is a section of its own');
  assert.match(markup, /<div class="settingsTitle">Environment variables/);
  assert.match(markup, /<details class="translatorEnvironmentBlock" aria-label="DXVK environment variables"><summary>DXVK<span class="translatorEnvironmentCount"> \(2\)<\/span><\/summary>/,
    'a collapsed block names its translator and counts the values');
  assert.match(markup, /Applies to games whose Direct3D 8, 9, 10 or 11 choice uses DXVK/, 'a block opens with what its values apply to');
  assert.match(markup, />DXVK_HUD<\/span>/); assert.match(markup, /aria-label="DXVK_HUD value"[^>]*value="fps"|value="fps"[^>]*aria-label="DXVK_HUD value"/);
  assert.ok(markup.includes('value="$HOME/literal &quot;quoted&quot;"'), 'values render literally');
  assert.match(markup, /title="Set by DXVK HUD in Runtime Settings\. This value replaces it\.">Set by MacLauncher</);
  assert.match(markup, /<option value="DXVK_CONFIG">/); assert.doesNotMatch(markup, /<option value="DXVK_HUD">/, 'present names are not suggested again');
  const blocks = (markup.match(/<details class="translatorEnvironmentBlock"/g) || []).length;
  assert.equal(blocks, new Set(declarations().map(item => item.id)).size - 3, 'the Android engines and ANGLE share the MacLauncher Android block');
  assert.equal((markup.match(/>Reset</g) || []).length, blocks, 'one Reset for each block');
  assert.equal((markup.match(/class="translatorEnvironmentGroup"[^>]*>ANGLE</g) || []).length, 1, 'a translator of two runtimes is shown once');
  assert.match(markup, /<summary>MacLauncher Android<span class="translatorEnvironmentCount"> \(2\)<\/span><\/summary>/);
  assert.match(markup, /class="translatorEnvironmentGroup"[^>]*>Android JVM<[\s\S]*JDK_JAVA_OPTIONS[\s\S]*class="translatorEnvironmentGroup"[^>]*>ANGLE<[\s\S]*MTL_HUD_ENABLED/);
  assert.doesNotMatch(markup, />Android ART</, 'translators without values have no heading');
  assert.match(markup, /<summary>CrossOver<\/summary>/, 'no count without values'); assert.match(markup, /No variables\./);
  assert.doesNotMatch(settingsView(state, { setModuleRuntimeSettings: async () => {}, setGameRuntimeSettings: async () => {} }), /Environment variables/,
    'without the setting action the section is absent');
  assert.doesNotMatch(runtimesView('translator-dxvk', state, api), /Environment variables|DXVK_HUD/, 'Runtimes only downloads, removes and chooses defaults');
});

test('a runtime block keeps the locks of its translators that another block shows', async t => {
  const { settingsBlocks } = require('../src/modules/shared/runtime/translator-environment.mjs');
  const macapk = settingsBlocks(declarations()).find(block => block.id === 'macapk');
  assert.deepEqual(macapk.declarations.map(item => item.id), ['macapk']); assert.deepEqual(macapk.companions.map(item => item.id), ['angle']);
  const saves = [];
  const h = componentHarness(C.TranslatorEnvironmentTable, { declarations: macapk.declarations, companions: macapk.companions, scope: 'global',
    globalStore: {}, onSave: async (id, values) => { saves.push([id, values]); } });
  t.after(() => h.close());
  labelled(h.render(), 'New variable name').props.onChange({ currentTarget: { value: 'KL_ANGLE_BACKEND' } });
  const tree = h.render();
  assert.equal(nodes(tree).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
  assert.doesNotMatch(renderToStaticMarkup(tree), /translatorEnvironmentGroup/, 'companions add no rows');
});

test('one table edits every translator of a game: rows change, remove and restore in their own translator and new names find their owner', async t => {
  const saves = [];
  const chosen = ['crossover', 'dxvk', 'kosmickrisp'].map(declaration);
  const h = componentHarness(C.TranslatorEnvironmentTable, { declarations: chosen, scope: 'game',
    globalStore: { crossover: { SHARED: 'global', WINEDEBUG: '-all' }, dxvk: { DXVK_HUD: 'fps' } },
    gameStore: { crossover: { SHARED: 'game' } },
    onSave: async (id, values) => { saves.push([id, values]); } });
  t.after(() => h.close());
  let tree = h.render();
  const markup = renderToStaticMarkup(tree);
  assert.match(markup, />CrossOver<[\s\S]*>SHARED<[\s\S]*>WINEDEBUG<[\s\S]*>DXVK<[\s\S]*>DXVK_HUD</, 'rows are grouped under their translators');
  assert.doesNotMatch(markup, /translatorEnvironmentGroup[^>]*>KosmicKrisp</);
  assert.match(markup, /title="Set by Wine debug channels in Runtime Settings\. This value replaces it\.">Set by MacLauncher</);
  assert.match(markup, />From Settings</); assert.match(markup, />Changed</);
  assert.doesNotMatch(markup, /Earlier setting|Replaces launcher value|Not applied/);
  labelled(tree, 'Remove WINEDEBUG').props.onClick(); await tick();
  assert.deepEqual(saves.at(-1), ['crossover', { SHARED: 'game', WINEDEBUG: null }], 'removing an inherited value stores a removal');
  labelled(tree, 'Restore SHARED').props.onClick(); await tick();
  assert.deepEqual(saves.at(-1), ['crossover', null], 'restoring the only game value clears the translator');
  await labelled(tree, 'DXVK_HUD value').props.onCommit('fps');
  assert.deepEqual(saves.at(-1), ['dxvk', null], 'a value equal to the inherited one is not stored');
  await labelled(tree, 'DXVK_HUD value').props.onCommit('$X `y` \'z\'');
  assert.deepEqual(saves.at(-1), ['dxvk', { DXVK_HUD: '$X `y` \'z\'' }]);
  const add = async (name, value) => {
    labelled(h.render(), 'New variable name').props.onChange({ currentTarget: { value: name } });
    labelled(h.render(), 'New variable value').props.onChange({ currentTarget: { value } });
    tree = h.render();
    await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  };
  await add('MESA_KK_DEBUG', 'msl');
  assert.deepEqual(saves.at(-1), ['kosmickrisp', { MESA_KK_DEBUG: 'msl' }], 'a suggested name joins the translator that suggests it');
  await add('NEW_NAME', ' spaced ');
  assert.deepEqual(saves.at(-1), ['crossover', { SHARED: 'game', NEW_NAME: ' spaced ' }], 'an unknown name joins the runtime group and keeps its spaces');
  await add('DXVK_HUD', 'full');
  assert.deepEqual(saves.at(-1), ['dxvk', { DXVK_HUD: 'full' }], 'a listed name stays with its row');
  assert.equal(labelled(h.render(), 'New variable name').props.value, '', 'a saved row clears the add form');
  labelled(h.render(), 'New variable name').props.onChange({ currentTarget: { value: 'VK_DRIVER_FILES' } }); tree = h.render();
  assert.equal(nodes(tree).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
  assert.match(renderToStaticMarkup(tree), /VK_DRIVER_FILES is set by MacLauncher\. Points the Vulkan loader at the selected driver\./,
    'a name locked by any translator in the table is refused');
  labelled(tree, 'New variable name').props.onChange({ currentTarget: { value: 'DXVK_CONFIG' } });
  assert.match(renderToStaticMarkup(h.render()), /dxvk\.conf options separated by semicolons[^<]*Applies with DXVK\./);
  labelled(h.render(), 'New variable name').props.onChange({ currentTarget: { value: '1BAD' } }); tree = h.render();
  const count = saves.length;
  await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(saves.length, count); assert.match(renderToStaticMarkup(h.render()), /1BAD is not a valid variable name/);
  let escaped = false;
  labelled(h.render(), 'New variable name').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() { escaped = true; } });
  assert.equal(escaped, true); assert.equal(labelled(h.render(), 'New variable name').props.value, '', 'Escape clears the add form');
  const reset = nodes(h.render()).find(node => node.type === 'button' && node.props.children === 'Reset');
  assert.equal(reset.props['aria-label'], 'Use the values from Settings for this game');
  saves.length = 0; await reset.props.onClick(); await tick();
  assert.deepEqual(saves, [['crossover', null]], 'Reset clears every translator that stores values for the game');
});

test('in the MacLauncher Android block an unknown name goes to the runtime and each engine keeps its own locks', async t => {
  const { managerDeclarations } = require('../src/modules/shared/runtime/translator-environment.mjs');
  const saves = [];
  const h = componentHarness(C.TranslatorEnvironmentTable, { declarations: managerDeclarations(declarations(), 'android'), scope: 'global',
    globalStore: {}, onSave: async (id, values) => { saves.push([id, values]); } });
  t.after(() => h.close());
  const type = name => { labelled(h.render(), 'New variable name').props.onChange({ currentTarget: { value: name } }); return h.render(); };
  const submit = async (name, value) => {
    type(name); labelled(h.render(), 'New variable value').props.onChange({ currentTarget: { value } });
    await nodes(h.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  };
  assert.match(renderToStaticMarkup(type('CUSTOM_FLAG')), /Applies with MacLauncher Android\./);
  await submit('CUSTOM_FLAG', 'on');
  assert.deepEqual(saves.at(-1), ['android', { CUSTOM_FLAG: 'on' }]);
  await submit('JAVA_TOOL_OPTIONS', '-Xss4m');
  assert.deepEqual(saves.at(-1), ['android-jvm', { JAVA_TOOL_OPTIONS: '-Xss4m' }], 'a JVM option is not refused because ART locks it');
  const tree = type('LD_PRELOAD');
  assert.equal(nodes(tree).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
  assert.match(renderToStaticMarkup(tree), /LD_PRELOAD is set by MacLauncher\. The ART runtime sets the game&#x27;s library loading\./);
});

test('a game section loads the translators its settings choose and shows them in one table', async t => {
  const loads = [];
  const props = { declarations: declarations(), globalStore: { anyps5: { SHARED: 'global' } }, gameStore: { kosmickrisp: { MESA_KK_DEBUG: 'msl' } },
    loadKey: 'first', load: async () => { loads.push('load'); return { translatorEnvironments: ['anyps5', 'kosmickrisp', 'anyps5', 'unknown'] }; },
    onSave: async () => {} };
  const h = componentHarness(C.GameTranslatorEnvironment, props); t.after(() => h.close());
  assert.match(renderToStaticMarkup(h.render()), /Loading translators/);
  const tree = await h.settle();
  const table = nodes(tree).find(node => node.type === C.TranslatorEnvironmentTable);
  assert.deepEqual(table.props.declarations.map(item => item.id), ['anyps5', 'kosmickrisp']);
  assert.equal(table.props.globalStore, props.globalStore); assert.equal(table.props.gameStore, props.gameStore); assert.equal(table.props.scope, 'game');
  const markup = renderToStaticMarkup(tree);
  assert.equal((markup.match(/<form/g) || []).length, 1, 'one add form for the game');
  assert.match(markup, />AnyPS5<[\s\S]*>SHARED<[\s\S]*>KosmicKrisp<[\s\S]*>MESA_KK_DEBUG</);
  assert.equal(loads.length, 1);
  const none = componentHarness(C.GameTranslatorEnvironment, { ...props, load: undefined, result: { translatorEnvironments: [] } });
  t.after(() => none.close());
  assert.match(renderToStaticMarkup(none.render()), /No translator environment applies with these settings\./);
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
