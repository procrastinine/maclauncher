const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
const { react, componentHarness } = require('./helpers/renderer-component');
const { createLibraryFixture } = require('./library-layout-fixture');

// One bundle serves static markup and harnessed hooks; useCallback follows useMemo.
const testReact = { ...react, useCallback: (callback, dependencies) => react.useMemo(() => callback, dependencies) };
let ui;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'ui-shared-components.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'ui-shared-components.cjs'), module);
  compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? testReact : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  ui = compiled.exports;
});
function elements(tree) { return React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)] : []; }
const textOf = node => React.Children.toArray(node.props.children).map(child => typeof child === 'string' ? child : '').join('');
function withGlobals(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(global, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(global, key, { value, configurable: true, writable: true });
  const restore = () => { for (const [key, descriptor] of Object.entries(previous)) descriptor ? Object.defineProperty(global, key, descriptor) : delete global[key]; };
  let result;
  try { result = run(); } catch (error) { restore(); throw error; }
  return Promise.resolve(result).finally(restore);
}
// Field events carry the element's text; Enter and Escape blur the field as a browser does.
function field(harness) {
  const input = () => harness.render();
  const event = (value, extra = {}) => ({ currentTarget: { value, blur() { input().props.onBlur({ currentTarget: { value } }); } },
    nativeEvent: {}, preventDefault() {}, stopPropagation() {}, ...extra });
  return {
    get value() { return input().props.value; },
    get invalid() { return input().props['aria-invalid']; },
    type(value) { input().props.onFocus(); input().props.onChange(event(value)); },
    blur() { const value = input().props.value; input().props.onBlur(event(value)); },
    key(key) { const value = input().props.value; input().props.onKeyDown(event(value, { key })); },
    props: () => input().props
  };
}

test('number parsing never turns empty or partial text into a value and applies bounds', () => {
  const { parseCommitNumber } = ui;
  for (const text of ['', '   ', '-', '.', 'e', 'abc', 'Infinity', 'NaN']) assert.equal(parseCommitNumber(text), null, JSON.stringify(text));
  assert.equal(parseCommitNumber(' 42 '), 42);
  assert.equal(parseCommitNumber('0'), 0);
  assert.equal(parseCommitNumber('-3.5', { min: 0 }), 0);
  assert.equal(parseCommitNumber('150.6', { max: 100, integer: true }), 100);
  assert.equal(parseCommitNumber('2.6', { integer: true }), 3);
});

test('number fields commit once on Enter or blur, and empty text or Escape restores the saved value', async t => {
  const commits = [], props = { value: 30, min: 0, max: 100, integer: true, onCommit: value => { commits.push(value); } };
  const harness = componentHarness(ui.CommitNumberInput, props); t.after(() => harness.close());
  const input = field(harness);
  assert.equal(input.value, '30');
  assert.equal(input.props().type, 'number');
  assert.equal(input.props().inputMode, 'numeric');

  input.type('4'); input.type('45');
  assert.deepEqual(commits, [], 'typing does not publish each keystroke');
  assert.equal(input.value, '45');
  input.key('Enter');
  assert.deepEqual(commits, [45]);
  await harness.settle();
  props.value = 45; await harness.settle();

  input.type('');
  input.blur();
  assert.deepEqual(commits, [45], 'an empty field never saves 0');
  assert.equal(input.value, '45');

  input.type('7');
  input.key('Escape');
  assert.deepEqual(commits, [45], 'Escape cancels the blur commit');
  assert.equal(input.value, '45');

  input.type('150.6');
  input.blur();
  assert.deepEqual(commits, [45, 100], 'bounds clamp the committed value');
  await harness.settle();
  props.value = 100; await harness.settle();

  input.type('100');
  input.blur();
  assert.deepEqual(commits, [45, 100], 'an unchanged value is not committed again');
});

test('a rejected text commit keeps the draft and marks the field invalid until the next edit', async t => {
  const commits = [], props = { value: 'Alpha', 'aria-label': 'Name', onCommit: value => { commits.push(value); return false; } };
  const harness = componentHarness(ui.CommitTextInput, props); t.after(() => harness.close());
  const input = field(harness);
  input.type('Beta');
  input.blur();
  await harness.settle();
  assert.deepEqual(commits, ['Beta']);
  assert.equal(input.value, 'Beta');
  assert.equal(input.invalid, true);
  input.type('Beta 2');
  assert.equal(input.invalid, undefined);
});

test('multiline fields keep Enter for new lines and commit with Command-Enter', async t => {
  const commits = [], harness = componentHarness(ui.CommitTextArea, { value: 'one', onCommit: value => { commits.push(value); } });
  t.after(() => harness.close());
  const input = field(harness);
  input.type('one\ntwo');
  input.key('Enter');
  assert.deepEqual(commits, []);
  const value = input.value;
  input.props().onKeyDown({ key: 'Enter', metaKey: true, nativeEvent: {}, preventDefault() {}, stopPropagation() {},
    currentTarget: { value, blur() { input.props().onBlur({ currentTarget: { value } }); } } });
  assert.deepEqual(commits, ['one\ntwo']);
});

test('menus open below the button, align to the right edge and flip above when space is short', () => {
  const { positionMenu } = ui;
  const anchor = { left: 100, right: 180, top: 40, bottom: 64 };
  assert.deepEqual(positionMenu(anchor, 200, 120, 1200, 800), { left: 100, top: 68 });
  assert.deepEqual(positionMenu({ left: 1100, right: 1180, top: 40, bottom: 64 }, 200, 120, 1200, 800), { left: 980, top: 68 });
  assert.deepEqual(positionMenu({ left: 100, right: 180, top: 700, bottom: 724 }, 200, 120, 1200, 800), { left: 100, top: 576 });
  // Without room above either, the menu stays below and is clamped inside the window.
  assert.deepEqual(positionMenu({ left: 100, right: 180, top: 60, bottom: 84 }, 200, 760, 1200, 800), { left: 100, top: 32 });
});

test('popover buttons use native light dismiss and describe their expanded state', () => {
  const markup = renderToStaticMarkup(React.createElement(ui.MenuButton, { label: 'More…', ariaLabel: 'More actions' },
    React.createElement('button', null, 'Remove')));
  assert.match(markup, /<span class="popoverAnchor"><button type="button" class="btn small" popoverTarget="([^"]+)" aria-controls="\1" aria-label="More actions" aria-expanded="false">More…<\/button><div id="\1" popover="auto" class="menuPopover"><button>Remove<\/button><\/div><\/span>/);
  const toolbar = renderToStaticMarkup(React.createElement(ui.LibraryToolbar, {
    count: '2 games', sort: { mode: 'custom', direction: 'asc' }, onSortChange() {}, scope: 'all', onScopeChange() {},
    types: React.createElement('label', null, 'Fixture'), typesFiltered: true, hasTypes: true,
    inspectorOpen: false, hasSelection: false, onToggleInspector() {} }));
  assert.match(toolbar, /<button type="button" class="btn small primary" popoverTarget="([^"]+)"[^>]*aria-label="Game types" title="Some game types are hidden" aria-expanded="false">Game types •<\/button><div id="\1" popover="auto" class="menuPopover gameSearchDropdown"><label>Fixture<\/label><\/div>/);
});

test('availability uses one vocabulary for options, rows and badges', () => {
  assert.deepEqual(['installed', 'included', 'notInstalled', 'downloadNeeded', 'unavailable', 'needsRepair'].map(ui.availabilityLabel),
    ['Installed', 'Included', 'Not installed', 'Download needed', 'Unavailable', 'Needs repair']);
  assert.equal(ui.withAvailability('1.2.0', 'installed'), '1.2.0 · Installed');
  assert.equal(ui.withAvailability('1.2.0'), '1.2.0');
  assert.equal(ui.withAvailability('1.2.0', null), '1.2.0');
  const badges = ['neutral', 'positive', 'warning', 'danger'].map(tone =>
    renderToStaticMarkup(React.createElement(ui.StatusBadge, { tone, title: 'Detail' }, 'State')));
  assert.deepEqual(badges, ['<span class="badge" title="Detail">State</span>', '<span class="badge badgeAccent" title="Detail">State</span>',
    '<span class="badge badgeWarn" title="Detail">State</span>', '<span class="badge badgeDanger" title="Detail">State</span>']);
});

test('errors read as plain sentences beside their action and banners can be dismissed', () => {
  const render = props => renderToStaticMarkup(React.createElement(ui.ErrorText, props));
  for (const error of [null, undefined, false, '']) assert.equal(render({ error }), '');
  assert.equal(render({ error: "Error invoking remote method 'launcher:install': Error: Error: Disk full", inline: true }),
    '<div class="error errorInline" role="alert"><span class="errorMessage">Disk full</span></div>');
  assert.equal(render({ error: new Error('Network unavailable') }), '<div class="error" role="alert"><span class="errorMessage">Network unavailable</span></div>');
  assert.equal(render({ error: 'Error: path /Games/Error: kept' }).includes('path /Games/Error: kept'), true);
  let dismissed = 0;
  const banner = ui.ErrorText({ error: 'Failed', onDismiss: () => dismissed++ });
  const markup = renderToStaticMarkup(banner);
  assert.match(markup, /class="error errorDismissible" role="alert"/);
  assert.match(markup, /aria-label="Dismiss error"/);
  elements(banner).find(node => node.type === 'button').props.onClick();
  assert.equal(dismissed, 1);
});

test('field rows share one label column and toggles carry no On or Off text', () => {
  const row = renderToStaticMarkup(React.createElement(ui.FieldRow, { label: 'Launch arguments', labelFor: 'args', help: 'Passed to the game.' },
    React.createElement('input', { id: 'args' })));
  assert.match(row, /^<div class="detailRow fieldRow"><div class="detailLabel"><label for="args">Launch arguments<\/label>/);
  assert.match(row, /aria-label="About launch arguments"/);
  assert.match(row, /<div class="fieldControl"><input id="args"\/><\/div><\/div>$/);
  const toggles = [true, false].map(checked => renderToStaticMarkup(React.createElement(ui.Toggle, { label: 'Show game icons', checked, onChange() {} })));
  assert.match(toggles[0], /^<label class="inlineCheck settingsToggle"><input type="checkbox" aria-label="Show game icons" checked=""\/><\/label>$/);
  assert.match(toggles[1], /^<label class="inlineCheck settingsToggle"><input type="checkbox" aria-label="Show game icons"\/><\/label>$/);
});

test('the graphics summary names enabled effects once and reports timing and launch warnings', () => {
  const plan = (video, extra = {}) => ({ schema: 2, mode: 'advanced', enabled: true, video, ...extra });
  assert.equal(ui.graphicsSummary(plan([], { enabled: false })), 'Off');
  assert.equal(ui.graphicsSummary(plan([])), 'No effects');
  const video = [{ id: 'a', kind: 'upscale', enabled: true }, { id: 'b', kind: 'frame-generation', enabled: true },
    { id: 'c', kind: 'upscale', enabled: true }, { id: 'd', kind: 'temporal', enabled: false },
    { id: 'auto-scale-input-a', kind: 'downsample', enabled: true }];
  assert.equal(ui.graphicsSummary(plan(video)), 'Upscale, Frame generation');
  assert.equal(ui.graphicsSummary(plan(video), { live: true }), 'Upscale, Frame generation', 'a stopped game shows no timing');
  assert.equal(ui.graphicsSummary(plan(video), { running: true, live: true }), 'Upscale, Frame generation · Running');
  assert.equal(ui.graphicsSummary(plan(video), { running: true }), 'Upscale, Frame generation · Next launch');
  assert.equal(ui.graphicsSummary(plan(video, { enabled: false }), { warnings: 1 }), 'Off · Needs attention');
  assert.equal(ui.graphicsSummary(plan([]), { running: true, warnings: 2 }), 'No effects · Next launch · Needs attention');
  assert.equal(ui.graphicsSummary(null), 'No effects');
  assert.equal(ui.graphicsSummary(plan([], { renderResolution: { multiplier: 2 } })), 'Game resolution 50%', 'a game resolution set on its own is named');
  assert.equal(ui.graphicsSummary(plan(video, { renderResolution: { height: 720 } })), 'Upscale, Frame generation, Game resolution 720p');
  assert.equal(ui.graphicsSummary(plan(video, { renderResolution: { multiplier: 2, managedBy: 'owner' } })), 'Upscale, Frame generation', 'an owned request belongs to its effect');
  assert.equal(ui.graphicsSummary(null, { running: true, unreadable: true }), 'Saved settings unreadable · Needs attention');
});

test('setup progress belongs to the activated setup row only', () => {
  assert.equal(ui.runtimePendingAction('setup', { setupActionId: 'downloadSteam' }), 'setup:downloadSteam');
  assert.equal(ui.runtimePendingAction('install', { setupActionId: 'downloadSteam' }), 'install');
  assert.equal(ui.isRuntimeSetupPending('setup:downloadSteam', 'downloadSteam'), true);
  assert.equal(ui.isRuntimeSetupPending('setup:downloadSteam', 'findInstalled'), false);
  assert.equal(ui.isRuntimeSetupPending('install', 'findInstalled'), false);
  assert.equal(ui.isRuntimeSetupPending(null, 'findInstalled'), false);
  const manager = { id: 'tools', label: 'Tools', ui: {}, sections: [{ id: 'default', label: 'Tools', installed: [],
    catalog: { status: 'idle', versions: [] }, setupActions: [
      { id: 'findInstalled', label: 'Installed copies', buttonLabel: 'Find copies' },
      { id: 'downloadSteam', label: 'Steam download', buttonLabel: 'Download from Steam…' }] }] };
  const markup = renderRuntimes([manager], manager.id, { onRuntimeSetupAction() {},
    runtimeUi: { tools: { pendingActions: { default: 'setup:downloadSteam' } } } });
  assert.equal((markup.match(/Setting up…/g) || []).length, 1);
  assert.match(markup, /disabled="">Find copies<\/button>/);
  assert.match(markup, /disabled="">Setting up…<\/button>/);
});

test('Graphics providers list Lossless Scaling model families beside their component without a provider select', () => {
  const component = (id, label, available) => ({ id, label, available, status: available ? 'Ready' : 'Not imported', description: `${label} component` });
  const section = { id: 'default', label: 'Lossless Scaling', installed: [], catalog: { status: 'success', versions: [], delivery: 'local-files' },
    capabilities: [{ id: 'ls1', label: 'LS1 spatial upscaling', available: true }, { id: 'lsfg', label: 'LSFG frame generation', available: false }],
    components: [component('metalfx', 'Apple MetalFX', true), component('lossless', 'Lossless Scaling', true), component('xess', 'Intel XeSS', false)],
    componentsTitle: 'Graphics components' };
  const models = { ...section, id: 'graphics-models', label: 'Graphics', sections: [section],
    ui: { groupId: 'graphics', tabLabel: 'Graphics', sectionLabel: 'Lossless Scaling', memberOrder: 0 } };
  const xessSection = { id: 'default', label: 'XeSS', installed: [], catalog: { status: 'idle', versions: [] } };
  const xess = { id: 'graphics-xess', label: 'XeSS', ui: { groupId: 'graphics', tabLabel: 'Graphics', sectionLabel: 'XeSS', memberOrder: 1 }, sections: [xessSection] };
  const markup = renderRuntimes([models, xess], models.id);
  assert.match(markup, />Providers<\/button>/);
  assert.match(markup, /<button type="button" class="btn small" aria-pressed="true" aria-label="Manage Lossless Scaling">Manage<\/button>/);
  assert.match(markup, /<button type="button" class="btn small" aria-pressed="false" aria-label="Manage Intel XeSS">Manage<\/button>/);
  assert.doesNotMatch(markup, /aria-label="Manage Apple MetalFX"/, 'components without their own library have no Manage button');
  assert.match(markup, /<ul class="runtimeComponentCapabilities" aria-label="Lossless Scaling models"><li><span>LS1 spatial upscaling<\/span><span class="badge badgeAccent">Installed<\/span><\/li><li><span>LSFG frame generation<\/span><span class="badge">Not installed<\/span><\/li><\/ul>/);
  assert.doesNotMatch(markup, /aria-label="Provider"|>Upscaling</);
  assert.match(markup, />Presets<\/button>/, 'launcher presets join the Graphics group');
});

test('launcher libraries join only groups that a backend provides', () => {
  const plain = [{ id: 'engine', ui: { groupId: 'engine' } }];
  assert.equal(ui.withLauncherLibraries(plain), plain);
  const graphics = [{ id: 'graphics-models', ui: { groupId: 'graphics' } }];
  const joined = ui.withLauncherLibraries(graphics);
  assert.deepEqual(joined.map(manager => manager.id), ['graphics-models', 'graphics-presets']);
  assert.equal(joined[1].ui.library, 'presets');
  assert.deepEqual(ui.withLauncherLibraries(joined).map(manager => manager.id), ['graphics-models', 'graphics-presets']);
});

test('the Lossless Scaling section reports LS1 and LSFG families separately', t => {
  const models = require('../src/modules/shared/reshade/runtime/models-manager');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lossless-families-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const section = models.getState({ userDataDir }).sections[0];
  assert.equal(section.label, 'Lossless Scaling');
  assert.equal(models.ui.sectionLabel, 'Lossless Scaling');
  assert.deepEqual(section.capabilities, [{ id: 'ls1', label: 'LS1 spatial upscaling', available: false },
    { id: 'lsfg', label: 'LSFG frame generation', available: false }]);
  // The providers card covers both upscaling and frame generation components.
  assert.equal(section.componentsTitle, 'Upscaling and frame generation');
  assert.match(section.components.find(row => row.id === 'lossless').description, /LS1 spatial upscaling and LSFG frame generation/);
});

test('Settings has no Graphics section and module fields use toggles and committed inputs', () => {
  const state = createLibraryFixture();
  state.modules = [{ ...state.modules[0], settingsDefaults: { defaultRuntime: 'managed', fastStart: true, frameLimit: 60, title: 'Fixture' } }];
  const offline = () => assert.fail('Rendering must not save settings');
  const render = sectionId => renderToStaticMarkup(React.createElement(ui.SettingsView, { state, sectionId, navigationKey: 1,
    showIcons: true, showNonDefaultTags: false, onSetLauncherSettings: offline, onSetModuleSettings: offline }));
  const launcher = render('launcher');
  assert.doesNotMatch(launcher, />Graphics<|Shader library|Graphics presets/);
  assert.match(launcher, /<label class="inlineCheck settingsToggle"><input type="checkbox" aria-label="Show game icons" checked=""\/><\/label>/);
  assert.doesNotMatch(launcher, />(On|Off)</);
  const module = render('module:fixture');
  assert.match(module, /<label class="inlineCheck settingsToggle"><input type="checkbox" aria-label="Fast Start" checked=""\/><\/label>/);
  assert.match(module, /<input aria-label="Frame Limit" type="number" inputMode="decimal" class="input" value="60"\/>/);
  assert.match(module, /<input aria-label="Title" type="text" class="input" value="Fixture"\/>/);
  assert.doesNotMatch(module, />(On|Off)</);
  assert.doesNotMatch(render('graphics'), /Shader library|Graphics presets/);
});

const runtimeUiDefaults = { remoteOpen: {}, installedSort: {}, installVersion: {}, installVariant: {}, pendingActions: {}, messages: {}, sourceErrors: {} };
function renderRuntimes(managers, selected, overrides = {}) {
  const noNetwork = () => { throw new Error('Rendering must not request a runtime or source URL'); };
  const runtimeUi = Object.fromEntries(Object.entries(overrides.runtimeUi || {}).map(([id, value]) => [id, { ...runtimeUiDefaults, ...value }]));
  return renderToStaticMarkup(React.createElement(ui.RuntimesView, {
    runtimeManagers: managers, runtimeManagerId: selected, runtimeSectionId: 'default', downloadTasks: [],
    setRuntimeManagerId() {}, setRuntimeSectionId() {}, updateRuntimeUiSection() {}, onRuntimeRefresh: noNetwork,
    onRuntimeInstall: noNetwork, onRuntimeSetDefault() {}, onRuntimeUninstall() {}, onCancelDownload() {},
    onOpenSource: noNetwork, ...overrides, runtimeUi
  }));
}

const detailProps = (state, overrides = {}) => ({ g: state.recents[0], state, moduleInfo: state.modules[0],
  actions: new Proxy({}, { get: () => async () => {} }), cheatsStatus: { patched: true }, libsStatus: null,
  runtimeStatusEntry: null, cheatsPatchBusy: false, libsPatchBusy: false, moduleActionResults: {},
  moduleActionBusy: {}, moduleActionError: null, ...overrides });

test('the inspector places Graphics after Tools as a collapsible section and Notes last', () => {
  const state = createLibraryFixture();
  const markup = renderToStaticMarkup(React.createElement(ui.GameDetails, detailProps(state)));
  const order = ['>Files</h3>', '>Detection</summary>', '>Launch</h3>', '>Patches</h3>', '>Tools</h3>',
    'class="effectsControls collapsibleSection graphicsSection', 'id="game-notes"'].map(text => markup.indexOf(text));
  assert.ok(order.every(index => index >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(markup, /class="collapsibleToggle" aria-expanded="true"[^>]*>Graphics<\/button>/);
});

test('the runtime settings button appears only for runtimes with settings', () => {
  const state = createLibraryFixture();
  const render = runtimeId => renderToStaticMarkup(React.createElement(ui.GameDetails,
    detailProps(state, { g: { ...state.recents[0], runtimeId } })));
  assert.match(render('managed'), /aria-label="Runtime settings"/);
  assert.doesNotMatch(render('native'), /aria-label="Runtime settings"/);
});

test('a failed tool action shows its error inside the tool group before Graphics', () => {
  const state = createLibraryFixture();
  const markup = renderToStaticMarkup(React.createElement(ui.GameDetails, detailProps(state, {
    moduleActionError: { actionId: 'extract', message: "Error invoking remote method 'launcher:moduleAction': Error: Extract failed" } })));
  assert.equal((markup.match(/Extract failed/g) || []).length, 1);
  assert.match(markup, /<div class="error errorInline" role="alert"><span class="errorMessage">Extract failed<\/span><\/div>/);
  const error = markup.indexOf('Extract failed');
  assert.ok(markup.indexOf('>Tools</h3>') < error && error < markup.indexOf('collapsibleSection'));
});

test('detection explanations load on the first expansion only', t => {
  const state = createLibraryFixture(), calls = [];
  const actions = new Proxy({}, { get: (_, name) => async (...args) => { calls.push([name, ...args]); } });
  const harness = componentHarness(ui.GameDetails.type, detailProps(state, { actions })); t.after(() => harness.close());
  const disclosure = () => elements(harness.render()).find(node => node.type === 'details' && /detectionDiagnostics/.test(node.props.className));
  const moduleActions = () => calls.filter(([name]) => name === 'onModuleAction');
  assert.deepEqual(moduleActions(), []);
  disclosure().props.onToggle({ currentTarget: { open: false } });
  assert.deepEqual(moduleActions(), []);
  disclosure().props.onToggle({ currentTarget: { open: true } });
  disclosure().props.onToggle({ currentTarget: { open: true } });
  assert.deepEqual(moduleActions(), [['onModuleAction', state.recents[0].gamePath, 'explainDetection']]);
});

test('deleting a preset asks for confirmation first', async t => {
  const preset = { id: 'film', name: 'Film', updatedAt: 1, plan: { schema: 2, mode: 'advanced', enabled: true, video: [] } };
  const deletes = [], api = { listEffectsPresets: async () => [structuredClone(preset)],
    getEffectsPresetEditor: async () => ({ mode: 'advanced', live: false, plan: preset.plan, catalog: [] }),
    deleteEffectsPreset: async (id, updatedAt) => { deletes.push([id, updatedAt]); return []; } };
  const questions = [];
  let answer = false;
  const launcher = { confirmAction: async request => { questions.push(request); return answer; } };
  await withGlobals({ window: { MacLauncher: { launcher }, confirm: () => assert.fail('the native confirmation is used') } }, async () => {
    const harness = componentHarness(ui.EffectsPresetManager, { api, status: { available: true, presets: [] }, selectedId: preset.id });
    try {
      harness.render(); await harness.settle();
      const remove = () => elements(harness.render()).find(node => node.type === 'button' && textOf(node) === 'Delete…');
      assert.match(remove().props.className, /danger/);
      remove().props.onClick(); await harness.settle();
      assert.deepEqual(deletes, []);
      assert.deepEqual(questions, [{ message: 'Delete the preset “Film”?', detail: 'Games that applied it keep their own copies.',
        confirmLabel: 'Delete', destructive: true }]);
      answer = true;
      remove().props.onClick(); await harness.settle();
      assert.deepEqual(deletes, [['film', 1]]);
    } finally { harness.close(); }
  });
});

test('graphics menu presets apply copies, keep no selection and show reasons on unavailable templates', async t => {
  const plan = name => ({ schema: 2, mode: 'advanced', enabled: true, video: [], name });
  const listeners = new Set(), opened = [], applied = [];
  let release, saves = 0;
  const api = { listEffectsPresets: () => new Promise(resolve => { release = resolve; }),
    onEffectsPresetsChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    openUtilityWindow: async request => { opened.push(request); } };
  const templates = [{ id: 'crt', name: 'CRT', plan: plan('crt'), available: true },
    { id: 'upscale', name: 'Reconstruction', plan: plan('upscale'), available: false, reason: 'Requires imported models.' }];
  await withGlobals({ window: { MacLauncher: { launcher: api } } }, async () => {
    const harness = componentHarness(ui.EffectsPresetMenuItems, { templates, disabled: false,
      onApply: value => applied.push(value), onSave: () => saves++ });
    try {
      harness.render();
      for (const listener of listeners) listener([{ id: 'film', name: 'Film', updatedAt: 2, plan: plan('film') }]);
      release([{ id: 'old', name: 'Old list', updatedAt: 1, plan: plan('old') }]);
      await harness.settle();
      const tree = harness.render(), markup = renderToStaticMarkup(tree);
      assert.match(markup, /<div class="menuGroupLabel" id="[^"]+">Apply preset<\/div>/);
      assert.match(markup, />Film<\/button>/);
      assert.doesNotMatch(markup, /Old list/, 'a list older than a broadcast is ignored');
      assert.match(markup, /<button type="button" class="btn small" disabled="">Reconstruction · Unavailable<span class="menuItemDetail">Requires imported models\.<\/span><\/button>/);
      assert.doesNotMatch(markup, /<select|aria-selected|Edit preset/);
      const button = label => elements(harness.render()).find(node => node.type === 'button' && React.Children.toArray(node.props.children)[0] === label);
      button('Film').props.onClick();
      button('CRT').props.onClick();
      assert.deepEqual(applied.map(value => value.name), ['film', 'crt']);
      assert.notEqual(applied[1], templates[0].plan, 'applying copies the chain');
      button('Save as preset…').props.onClick();
      assert.equal(saves, 1);
      button('Manage presets…').props.onClick(); await harness.settle();
      assert.deepEqual(opened, [{ view: 'runtimes', managerId: 'graphics-presets' }]);
    } finally { harness.close(); }
  });
  assert.equal(listeners.size, 0);
});

test('saving a preset names the current chain and closes only after it is saved', async t => {
  const plan = { schema: 2, mode: 'advanced', enabled: true, video: [] }, saves = [];
  let fail = true, closed = 0;
  const api = { saveEffectsPreset: async value => { saves.push(value); if (fail) throw new Error('Disk full'); return { ...value, id: 'new', updatedAt: 1 }; } };
  await withGlobals({ window: { MacLauncher: { launcher: api } } }, async () => {
    const harness = componentHarness(ui.EffectsPresetSaveForm, { plan, onClose: () => closed++ });
    try {
      const find = predicate => elements(harness.render()).find(predicate);
      const input = () => find(node => node.props.id === 'effects-preset-name');
      const submit = () => find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
      assert.equal(find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
      input().props.onChange({ target: { value: 'Mine' } });
      submit(); await harness.settle();
      assert.deepEqual(saves, [{ name: 'Mine', plan }]);
      assert.equal(closed, 0);
      assert.match(renderToStaticMarkup(harness.render()), /<span class="errorMessage">Disk full<\/span>/);
      find(node => node.type === 'form').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
      assert.equal(closed, 1, 'Escape closes without saving');
      fail = false;
      submit(); await harness.settle();
      assert.equal(saves.length, 2);
      assert.equal(closed, 2);
    } finally { harness.close(); }
  });
});

test('removing an account asks for confirmation first', async t => {
  const calls = [], questions = [];
  let answer = false;
  const action = async (moduleId, name, payload) => {
    calls.push([moduleId, name, payload]);
    if (name === 'accounts') return { accounts: [{ id: 'one', label: 'Player One', canRemove: true }], canSignIn: true };
  };
  const descriptor = { label: 'Store accounts', stateAction: 'accounts', signInAction: 'signIn', removeAction: 'removeAccount' };
  const target = { addEventListener() {}, removeEventListener() {} };
  await withGlobals({ window: { ...target, confirm: message => { questions.push(message); return answer; } },
    document: { ...target, visibilityState: 'visible' } }, async () => {
    const harness = componentHarness(ui.ModuleAccountsPanel, { moduleId: 'fixture', descriptor, action });
    try {
      harness.render(); await harness.settle();
      const remove = () => elements(harness.render()).find(node => node.type === 'button' && textOf(node) === 'Remove account…');
      remove().props.onClick(); await harness.settle();
      assert.equal(calls.filter(([, name]) => name === 'removeAccount').length, 0);
      assert.deepEqual(questions, ['Remove Player One from Store accounts? Signing in again is required to use it.']);
      answer = true;
      remove().props.onClick(); await harness.settle();
      assert.deepEqual(calls.filter(([, name]) => name === 'removeAccount'), [['fixture', 'removeAccount', { accountId: 'one' }]]);
    } finally { harness.close(); }
  });
});

test('module tool menus close after an action and share one error presentation', () => {
  const game = createLibraryFixture().recents[0];
  const groups = [{ id: 'tools', label: 'Engine tools', actions: ['status', 'extract', 'repair', 'clean'] }];
  const actions = ['status', 'extract', 'repair', 'clean'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
  const markup = renderToStaticMarkup(React.createElement(ui.ModuleTools, { game, groups, actions, results: {}, busy: {}, cancelling: {},
    error: { actionId: 'repair', message: 'Error: Repair failed' }, onAction() {}, onCancel() {}, onRevealPath() {} }));
  assert.match(markup, /class="popoverAnchor moduleToolMenu"/);
  assert.match(markup, /popover="auto" class="moduleToolMenuItems"/);
  assert.match(markup, /<span class="errorMessage">Repair failed<\/span>/);
  assert.doesNotMatch(markup, /Error: Repair failed/);
});
