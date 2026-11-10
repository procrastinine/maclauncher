const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
const { react } = require('./helpers/renderer-component');
let SettingsView;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'runtime-tabs-components.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'app-update-settings-components.cjs'), module);
  compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  ({ SettingsView } = compiled.exports);
});

const checkedAt = Date.parse('2026-10-31T14:05:00Z');
function render(appUpdate, launcherSettings = {}) {
  const fixture = require('./library-layout-fixture').createLibraryFixture();
  const offline = () => assert.fail('Rendering Settings must not call the backend');
  return renderToStaticMarkup(React.createElement(SettingsView, { state: { ...fixture, appUpdate,
    launcherSettings: { ...fixture.launcherSettings, ...launcherSettings } }, showIcons: true, showNonDefaultTags: true,
  onSetLauncherSettings: offline, onSetModuleSettings: offline, onAppUpdate: offline }));
}
const idle = { currentVersion: '0.5.1', phase: 'idle', version: null, progress: null, error: null, lastCheck: null };
const launcherSection = markup => markup.slice(markup.indexOf('<div class="settingsTitle">Launcher</div>'));

test('the Launcher section holds Check for Updates, its latest result and the opt-in launch check', () => {
  const markup = launcherSection(render(idle));
  assert.match(markup, /<div class="settingsLabel">Updates<\/div>/);
  assert.match(markup, /<button type="button" class="btn small">Check for updates…<\/button>/);
  assert.match(markup, /role="status">MacLauncher 0\.5\.1\. Not checked yet\.<\/span>/);
  assert.match(markup, /Check for updates at launch/);
  assert.match(markup, /aria-label="Check for updates at launch"/);
  // The launch check is off unless it was turned on.
  assert.doesNotMatch(markup, /aria-label="Check for updates at launch"[^>]*checked/);
  assert.match(launcherSection(render(idle, { checkForUpdatesAtLaunch: true })), /aria-label="Check for updates at launch"[^>]*checked|checked=""[^>]*aria-label="Check for updates at launch"/);
  assert.doesNotMatch(render(idle), /settingsTitle">Updates</, 'there is no separate Updates section');
});

test('the update row follows the check, download and restart states', () => {
  const at = state => launcherSection(render({ ...idle, ...state }));
  assert.match(at({ phase: 'checking' }), /<button type="button" class="btn small" disabled="">Checking…<\/button>/);
  assert.match(at({ phase: 'downloading', version: '0.5.2', progress: 0.45 }), /Cancel download<\/button><span class="settingsStatus" role="status">Downloading MacLauncher 0\.5\.2… 45%/);
  assert.match(at({ phase: 'ready', version: '0.5.2' }), /Restart to update<\/button><span class="settingsStatus" role="status">MacLauncher 0\.5\.2 is ready to install\./);
  assert.match(at({ lastCheck: { checkedAt, currentVersion: '0.5.1', outcome: 'current' } }), /MacLauncher 0\.5\.1 is up to date\. Checked /);
  assert.match(at({ lastCheck: { checkedAt, currentVersion: '0.5.1', outcome: 'available', version: '0.5.2' } }), /MacLauncher 0\.5\.2 is available\. Checked /);
  assert.match(at({ lastCheck: { checkedAt, currentVersion: '0.5.1', outcome: 'error', message: 'GitHub could not be reached.' } }), /The last check failed \([^)]*\): GitHub could not be reached\./);
  assert.match(at({ error: 'The downloaded app contains no Intel code.' }), /The update could not be installed: The downloaded app contains no Intel code\./);
});

test('update state travels with launcher activity', async () => {
  const { mergeLauncherActivity } = await import('../src/renderer/src/ui/launcher-state-model.mjs');
  const previous = { downloads: [], appUpdate: idle };
  const next = mergeLauncherActivity(previous, { appUpdate: { ...idle, phase: 'downloading', version: '0.5.2', progress: 0.1 } });
  assert.equal(next.appUpdate.phase, 'downloading');
  assert.equal(next.downloads, previous.downloads);
});
