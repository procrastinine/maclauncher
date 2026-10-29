const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function fixture() {
  const handlers = new Map();
  const settings = { launcher: {} };
  const context = {
    LibraryState: { DEFAULT_LIBRARY_STATE: {}, normalizeLibraryState: value => value || {} },
    SteamClientStart: { startPreference: value => value || 'ask' },
    nativeTheme: { themeSource: 'system' }, loadSettings: () => settings,
    saveSettings: () => {}, buildState: () => ({}), loadGamesHydrated: () => [],
    broadcastState: () => {}, ipcMain: { handle: (name, callback) => handlers.set(name, callback) }
  };
  for (const [start, end] of [
    ['const DEFAULT_LAUNCHER_SETTINGS =', 'const GAME_SCHEMA_VERSION'],
    ['function normalizeLauncherSettings(', 'function pruneRuntimeSettingsDefaults('],
    ['ipcMain.handle("launcher:setLauncherSettings",', 'ipcMain.handle("launcher:setModuleSettings",']
  ]) vm.runInNewContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), context);
  return { context, settings, set: patch => handlers.get('launcher:setLauncherSettings')(null, patch) };
}
test('appearance normalization preserves each choice and defaults missing or invalid settings to System', () => {
  const f = fixture();
  for (const value of ['system', 'light', 'dark', undefined, null, '', 'sepia', {}, 1]) {
    f.settings.launcher = { appearance: value, showIcons: false };
    f.context.normalizeLauncherSettings(f.settings);
    assert.equal(f.settings.launcher.appearance, ['system', 'light', 'dark'].includes(value) ? value : 'system');
    assert.equal(f.settings.launcher.showIcons, false);
  }
});
test('changing and resetting appearance applies the normalized native theme immediately', async () => {
  const f = fixture();
  for (const appearance of ['light', 'dark', 'system', 'invalid', null]) {
    await f.set({ appearance });
    const expected = ['light', 'dark', 'system'].includes(appearance) ? appearance : 'system';
    assert.equal(f.settings.launcher.appearance, expected);
    assert.equal(f.context.nativeTheme.themeSource, expected);
  }
});
