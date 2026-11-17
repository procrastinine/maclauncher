// GUI 0877 S2/S3: one help button per Settings section, listing each row's
// explanation; each row label keeps its own explanation as a tooltip and the
// label column fits the longest label.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const { renderToStaticMarkup } = require('react-dom/server');
const { react, componentHarness } = require('./helpers/renderer-component');
const { createLibraryFixture } = require('./library-layout-fixture');

let ui;
test.before(async () => {
  const { build } = require('vite');
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'runtime-tabs-components.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'settings-help-components.cjs'), module);
  compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  ui = compiled.exports;
});
const elements = node => react.isValidElement(node) ? [node, ...react.Children.toArray(node.props.children).flatMap(elements)] : [];
const offline = new Proxy({}, { get: () => async () => null });

function windowsState() {
  const registry = require('../src/modules/registry'), state = createLibraryFixture();
  state.modules = [registry.getModuleInfo('crossover')];
  state.moduleSettings = { crossover: {} };
  return state;
}

test('the Launcher section has one help button listing its rows, and each row label keeps its explanation as a tooltip', () => {
  const state = createLibraryFixture();
  const markup = renderToStaticMarkup(react.createElement(ui.SettingsView, { state, api: offline, showIcons: true, showNonDefaultTags: true,
    onSetLauncherSettings() {}, onSetModuleSettings() {} }));
  assert.equal((markup.match(/class="helpTipButton"/g) || []).length, 1);
  assert.match(markup, /<div class="settingsTitle">Launcher<span class="helpTip"><button type="button" class="helpTipButton"[^>]*aria-label="About Launcher settings"/);
  const list = /<dl class="helpList">([\s\S]*?)<\/dl>/.exec(markup)[1];
  assert.deepEqual([...list.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]), ['Network access', 'Steam client on Play',
    'Bypass graphics effects', 'Save processed screenshot', 'Toggle pointer in window graphics', 'Toggle graphics for front app', 'Check for updates at launch']);
  assert.match(markup, /<div class="settingsLabel" title="Initial setting for newly imported games\.[^"]*">Network access<\/div>/);
  assert.match(markup, /<div class="settingsLabel" title="Each start asks GitHub[^"]*">Check for updates at launch<\/div>/);
  // GUI 0913 H1, H2: Settings does not point to itself, and no button name ends a sentence ("Check for Updates….").
  assert.doesNotMatch(list, /Assign the keyboard shortcut in Settings|…\./);
});

test('a runtime form reports its rows\' explanations to the Settings heading and shows no help button of its own', () => {
  const state = windowsState(), reported = [];
  const props = { api: offline, state, error: null, inline: true, context: { scope: 'module', moduleId: 'crossover', runtimeId: 'sikarugir' },
    onHelpChange: items => reported.push(items) };
  const inline = renderToStaticMarkup(react.createElement(ui.RuntimeSettingsWindow, props));
  assert.doesNotMatch(inline, /helpTipButton/);
  assert.match(inline, /<div class="settingsLabel" title="[^"]+">Direct3D 12/);
  // GUI 0913 W4: labels are in sentence case.
  assert.match(inline, />High resolution \(Retina\)</);
  const harness = componentHarness(ui.RuntimeSettingsWindow, props);
  try { harness.render(); harness.render(); } finally { harness.close(); }
  const labels = reported.at(-1).map(item => item.label);
  assert.ok(labels.includes('Windows version'), JSON.stringify(labels));
  // GUI 0913 H3: rows with the same explanation share one entry naming each of them once.
  assert.ok(labels.includes('Direct3D 8, 9, 10 / 10.1, 11 and 12'), JSON.stringify(labels));
  assert.equal(new Set(reported.at(-1).map(item => item.text)).size, reported.at(-1).length, 'no explanation is listed twice');
  // The game's own Runtime Settings window keeps one help button, in its header.
  const window = renderToStaticMarkup(react.createElement(ui.RuntimeSettingsWindow, { ...props, inline: false, onHelpChange: undefined }));
  assert.equal((window.match(/class="helpTipButton"/g) || []).length, 1);
  assert.match(window, /<dt>Direct3D 8, 9, 10 \/ 10\.1, 11 and 12<\/dt>/);
});

test('a game type section shows the shown runtime form\'s explanations behind its heading\'s one help button', () => {
  const state = windowsState();
  const harness = componentHarness(ui.SettingsView, { state, api: offline, sectionId: 'module:crossover', showIcons: true, showNonDefaultTags: true,
    onSetLauncherSettings() {}, onSetModuleSettings() {} });
  try {
    let tree = harness.render();
    const form = elements(tree).find(node => typeof node.props?.onHelpChange === 'function');
    form.props.onHelpChange([{ label: 'Direct3D 12', text: 'Engine for Direct3D 12.' }]);
    tree = harness.render();
    const markup = renderToStaticMarkup(elements(tree).find(node => node.props?.className === 'settingsTitle'));
    assert.match(markup, /^<div class="settingsTitle">Windows<span class="helpTip"><button[^>]*aria-label="About Windows settings"[\s\S]*<dt>Direct3D 12<\/dt><dd>Engine for Direct3D 12\.<\/dd>/);
  } finally { harness.close(); }
});

test('the Settings label column fits the longest label, and a heading\'s help popover reads as body text', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/styles.css'), 'utf8');
  assert.match(css, /\.settingsRow \{[^}]*grid-template-columns: minmax\(var\(--field-label\), 18rem\) minmax\(0, 26rem\);/);
  assert.match(css, /\.helpList dt \{ font-weight: 600; \}/);
  // A help button inside a heading keeps its popover in body text: the explanations are not bold, uppercase or spaced like the heading.
  const popover = /\n\.helpPopover \{([^}]*)\}/.exec(css)[1];
  for (const rule of ['font-weight: 400', 'letter-spacing: normal', 'text-transform: none', 'white-space: normal'])
    assert.ok(popover.includes(rule), rule);
});

test('a text area\'s label and trailing button line up with its first line (GUI 0913 W3)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/styles.css'), 'utf8');
  assert.match(css, /\.settingsRow:has\(> \.settingsControl > textarea\) \{ align-items: start; \}/);
  assert.match(css, /\.settingsRow:has\(> \.settingsControl > textarea\) > \.settingsLabel \{ padding-top: calc\(var\(--control-padding-y\) \+ 1px\); \}/);
  assert.match(css, /\.settingsControl:has\(> textarea\) \{ align-items: flex-start; \}/);
  assert.match(css, /\.fieldRow:has\(> \.fieldControl > textarea\) \{ align-items: start; \}/);
});

test('user-facing module text uses straight apostrophes (GUI 0913 H4)', () => {
  const registry = require('../src/modules/registry'), found = [];
  const walk = (value, where) => {
    if (typeof value === 'string') { if (value.includes('\u2019')) found.push(`${where}: ${value.slice(0, 80)}`); }
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, `${where}.${key}`);
  };
  for (const info of registry.listModules()) walk(info, info.id);
  assert.deepEqual(found, []);
});

test('the Graphics and runtime tab strips in Settings start at the section edge with one spacing (GUI 0877 S10)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/styles.css'), 'utf8');
  assert.match(css, /\.settingsTabs\.settingsRuntimeTabs, \.graphicsLibrarySettings > \.settingsTabs \{\s*padding: 0;\s*gap: 14px;\s*\}/);
});

test('graphics rows list their explanations in the Graphics heading\'s help instead of a help button each (GUI 0913 L6)', async t => {
  const { build } = require('vite');
  const result = await build({ configFile: false, logLevel: 'silent', build: { ssr: path.join(__dirname, '../src/renderer/src/ui/components/HelpList.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs' } } } });
  const compiled = new Module(path.join(__dirname, 'help-list.cjs'), module); compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  const { useCollectedHelp, HelpCollector, RowHelp, joinHelpLabels } = compiled.exports;
  // The collector keeps each row's entry once, in the order rows appeared, and drops a row that leaves.
  const harness = componentHarness(() => useCollectedHelp(), {}); t.after(() => harness.close());
  const { registry } = harness.render();
  registry.set('a', { label: 'Frame pacing', text: 'Pacing.' }); registry.set('b', { label: 'Display sync', text: 'Sync.' });
  registry.set('a', { label: 'Frame pacing', text: 'Pacing.' }); registry.set('c', { label: 'Drawables', text: 'Sync.' });
  assert.deepEqual(harness.render().items, [{ label: 'Frame pacing', text: 'Pacing.' }, { label: 'Display sync and Drawables', text: 'Sync.' }]);
  registry.set('b', null);
  assert.deepEqual(harness.render().items.map(item => item.label), ['Frame pacing', 'Drawables']);
  // Inside a collector a row shows no button; outside one it keeps its own.
  const inside = renderToStaticMarkup(react.createElement(HelpCollector, { value: registry }, react.createElement(RowHelp, { label: 'Frame pacing', text: 'Pacing.' })));
  assert.equal(inside, '');
  assert.match(renderToStaticMarkup(react.createElement(RowHelp, { label: 'Frame pacing', text: 'Pacing.' })), /aria-label="About frame pacing"/);
  assert.equal(joinHelpLabels(['Direct3D 8', 'Direct3D 9', 'Direct3D 12']), 'Direct3D 8, 9 and 12');
  // Every policy row of the Graphics section uses the row help.
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/components/OutputPolicyControls.tsx'), 'utf8');
  assert.doesNotMatch(source, /<HelpTip/);
  assert.equal((source.match(/<RowHelp label=/g) || []).length, 11);
  const effects = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/components/EffectsControls.tsx'), 'utf8');
  assert.match(effects, /<HelpCollector value=\{collectedHelp\.registry\}>\{editing\}<\/HelpCollector>/);
  assert.match(effects, /\{collectedHelp\.items\.length > 0 && <HelpList items=\{collectedHelp\.items\} \/>\}/);
});
