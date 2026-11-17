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
});

test('a runtime form reports its rows\' explanations to the Settings heading and shows no help button of its own', () => {
  const state = windowsState(), reported = [];
  const props = { api: offline, state, error: null, inline: true, context: { scope: 'module', moduleId: 'crossover', runtimeId: 'sikarugir' },
    onHelpChange: items => reported.push(items) };
  const inline = renderToStaticMarkup(react.createElement(ui.RuntimeSettingsWindow, props));
  assert.doesNotMatch(inline, /helpTipButton/);
  assert.match(inline, /<div class="settingsLabel" title="[^"]+">Direct3D 12/);
  const harness = componentHarness(ui.RuntimeSettingsWindow, props);
  try { harness.render(); harness.render(); } finally { harness.close(); }
  const labels = reported.at(-1).map(item => item.label);
  assert.ok(labels.includes('Direct3D 12') && labels.includes('Windows version'), JSON.stringify(labels));
  // The game's own Runtime Settings window keeps one help button, in its header.
  const window = renderToStaticMarkup(react.createElement(ui.RuntimeSettingsWindow, { ...props, inline: false, onHelpChange: undefined }));
  assert.equal((window.match(/class="helpTipButton"/g) || []).length, 1);
  assert.match(window, /<dt>Direct3D 12<\/dt>/);
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
