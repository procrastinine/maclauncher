const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
let SettingsView;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'runtime-tabs-components.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'runtime-tabs-components.cjs'), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  ({ SettingsView } = compiled.exports);
});

function renderModule(id, moduleSettings = {}) {
  const registry = require('../src/modules/registry');
  const state = require('./library-layout-fixture').createLibraryFixture();
  state.modules = [registry.getModuleInfo(id)];
  state.moduleSettings = { [id]: moduleSettings };
  const offline = () => assert.fail('Rendering Settings must not call the backend');
  const api = new Proxy({}, { get: () => offline });
  return renderToStaticMarkup(React.createElement(SettingsView, { state, api, sectionId: `module:${id}`, showIcons: true,
    showNonDefaultTags: true, onSetLauncherSettings: offline, onSetModuleSettings: offline }));
}

test('fields marked advanced follow the common fields inside one collapsed group', () => {
  const markup = renderModule('rgss');
  // Conditional fields stay hidden until their condition holds and are not counted.
  const fields = require('../src/modules/rgss/manifest.json').runtime.entries.mkxpz.settings.fields.filter(field => !field.visibleWhen);
  const advanced = markup.indexOf('<details class="settingsAdvanced">');
  assert.ok(advanced > 0);
  assert.equal(markup.indexOf('<details class="settingsAdvanced">', advanced + 1), -1);
  assert.doesNotMatch(markup, /<details class="settingsAdvanced" open/);
  assert.match(markup, new RegExp(`<summary>Advanced <span class="settingsAdvancedCount">${fields.filter(field => field.advanced).length}</span></summary>`));
  for (const field of fields) {
    const position = markup.indexOf(`>${field.label}<`);
    assert.ok(position > 0, field.label);
    assert.equal(position > advanced, Boolean(field.advanced), field.label);
  }
  assert.match(markup, /aria-label="Default runtime"/);
  assert.match(markup, /id="settings-runtime-tab-rgss-mkxpz"/);
});

test('a module with one runtime names it in a heading without a one-choice menu or tab strip', () => {
  const markup = renderModule('java');
  assert.doesNotMatch(markup, /aria-label="Default runtime"/);
  assert.doesNotMatch(markup, /settings-runtime-tab-java-|role="tab"/);
  assert.match(markup, /<div class="settingsRuntimeHeading" role="heading" aria-level="3" id="settings-runtime-heading-java-java">Java \(Temurin\)<\/div>/);
  assert.match(markup, /<div id="settings-runtime-panel-java-java" aria-labelledby="settings-runtime-heading-java-java">/);
  const saved = renderModule('java', { defaultRuntime: 'retired-runtime' });
  assert.match(saved, /aria-label="Default runtime"/);
  assert.match(saved, /\(saved; choose a compatible runtime\)/);
  // GUI run-13 (b0d4a3ec): renamed Window capture, the window-capture section read "Window capture" over a runtime
  // heading "Window capture". A lone runtime named as its section has no second heading; the title labels its form.
  const capture = renderModule('window');
  assert.match(capture, /<div class="settingsTitle" id="settings-title-window">Window capture/);
  assert.doesNotMatch(capture, /settingsRuntimeHeading/);
  assert.match(capture, /<div id="settings-runtime-panel-window-capture" aria-labelledby="settings-title-window">/);
});

test('a module section is headed by its sidebar entry, and Settings menus, status and actions keep one compact column (GUI 0877 S1, S4, S6, S9)', () => {
  const markup = renderModule('crossover');
  assert.match(markup, /<div class="settingsTitle" id="settings-title-crossover">Windows<\/div>/);
  assert.doesNotMatch(markup, /<div class="settingsTitle"[^>]*>Windows Game<\/div>/);
  const css = require('node:fs').readFileSync(path.join(__dirname, '../src/renderer/src/ui/styles.css'), 'utf8');
  assert.match(css, /\.settingsControl > select\.input:not\(\[multiple\]\) \{ flex: 0 1 auto; width: auto; min-width: 8rem; \}/, 'a menu sizes to its choices');
  assert.match(css, /\.settingsControl > \.input \+ \.btn:not\(\.iconOnly\) \{ min-width: 6\.5rem; \}/, 'Browse… and Add… share one width');
  assert.match(css, /\.settingsUpdateControl \{ flex-wrap: nowrap; \}/);
  assert.match(css, /\.settingsRow:has\(> \.settingsUpdateControl\) \{ grid-template-columns: minmax\(var\(--field-label\), 18rem\) minmax\(0, 1fr\); \}/);
});
