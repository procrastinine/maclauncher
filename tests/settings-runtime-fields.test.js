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
});
