const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { build } = require('vite');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createLibraryFixture } = require('./library-layout-fixture');

// Use the production TSX compiler: TypeScript 7 no longer exposes transpileModule.
let GameRow, GameDetails;
test.before(async () => {
  const bundle = await build({
    configFile: false, logLevel: 'silent',
    build: { ssr: path.join(__dirname, 'library-layout-components.tsx'), write: false,
      rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } } }
  });
  const compiled = new Module(path.join(__dirname, 'library-components.cjs'), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  ({ GameRow, GameDetails } = compiled.exports);
});
const actions = new Proxy({}, { get: () => async () => {} });
const renderRow = (state, selected) => renderToStaticMarkup(React.createElement(GameRow, {
  g: state.recents[0], moduleInfo: state.modules[0], moduleSettings: state.moduleSettings,
  runtimeDefaults: state.runtimeDefaults, selected, dragging: false, dragDisabled: false,
  isRunning: false, showIcons: true, showNonDefaultTags: true,
  favorite: false, actions, onSelect: actions.onSelect,
  onDragStart: actions.onDragStart, onDragEnd: actions.onDragEnd
}));
const renderDetails = (state, game = state.recents[0], overrides = {}) => renderToStaticMarkup(React.createElement(GameDetails, {
  g: game, state, moduleInfo: state.modules[0], actions, cheatsStatus: { patched: true },
  libsStatus: { partial: true, warnings: ['Fixture warning'] }, runtimeStatusEntry: null,
  cheatsPatchBusy: false, libsPatchBusy: false, moduleActionResults: { status: { value: 'Ready' } },
  moduleActionBusy: {}, moduleActionError: null, ...overrides
}));

test('library-layout: selection keeps rows stable with all quick actions available', () => {
  const state = createLibraryFixture();
  const normal = renderRow(state, false);
  const selected = renderRow(state, true);
  assert.match(selected, /<li class="gameItem selected">/);
  assert.match(selected, /<button[^>]*aria-label="Show details for Alpha"[^>]*aria-pressed="true"[^>]*aria-controls="game-details"/);
  assert.equal(selected.replace('gameItem selected', 'gameItem').replace('aria-pressed="true"', 'aria-pressed="false"'), normal);
  assert.match(normal, /aria-label="Play Alpha"/);
  for (const label of ['Saves', 'Cheats', 'Shortcut']) assert.match(normal, new RegExp(`>${label}<`));
  assert.match(normal, /aria-label="Forget Alpha"/);
  assert.match(normal, /aria-label="Add Alpha to favorites"/);
  assert.doesNotMatch(normal, /<select|gameDetails|role="tab"/);
});

test('library-layout: selected details retain module metadata, runtime controls, patching, and game tools', () => {
  const markup = renderDetails(createLibraryFixture());
  for (const label of ['Alpha', 'Saves', 'Engine version', 'Engine tools', 'Ready', 'Partial', 'Patched', 'Extract']) {
    assert.ok(markup.includes(label), `Missing ${label}`);
  }
  for (const label of ['Runtime', 'Channel', 'Managed runtime version', 'Runtime variant', 'Engine library']) {
    assert.ok(markup.includes(`<select aria-label="${label}"`), `Missing accessible ${label} selector`);
  }
  assert.match(markup, /<option value="native">Native app<\/option>/);
  assert.doesNotMatch(markup, /Hidden info|Hidden action/);
  assert.match(markup, /disabled=""[^>]*aria-label="Disabled action"/);
  assert.match(markup, />Shortcut</);
  assert.match(markup, /aria-label="Play Alpha"/);
  assert.match(markup, /aria-label="Forget Alpha"/);
  assert.match(markup, />Edit saves</);
});

test('library-layout: built-in management hiding preserves inspector runtime, version and settings', () => {
  const state = createLibraryFixture(), manager = state.runtimeManagers['fixture-manager'];
  manager.ui = { management: 'built-in' };
  const builtIn = renderDetails(state);
  assert.doesNotMatch(builtIn, />Runtimes…<\/button>/);
  assert.match(builtIn, /aria-label="Managed runtime version"/);
  assert.match(builtIn, /<option value="2.0">/);
  assert.match(builtIn, /aria-label="Runtime"/);
  assert.match(builtIn, /aria-label="Runtime settings"/);
  assert.match(builtIn, /aria-label="Play Alpha"/);
  manager.ui = { management: 'managed', sectionManagement: { stable: 'built-in', preview: 'managed' } };
  assert.doesNotMatch(renderDetails(state), />Runtimes…<\/button>/);
  state.recents[0].runtimeData = { managed: { channel: 'preview' } };
  assert.match(renderDetails(state), />Runtimes…<\/button>/);
});

test('library-layout: inspector renders from its game state without global downloads or library data', () => {
  const fixture = createLibraryFixture();
  const game = fixture.recents[0];
  const focused = { modules: fixture.modules, moduleStates: fixture.moduleStates,
    runtimeManagers: fixture.runtimeManagers, running: { [game.gamePath]: 1 }, preparing: {} };
  const markup = renderDetails(focused, game);
  assert.match(markup, /aria-label="Stop Alpha"/);
  assert.match(markup, /Managed runtime version/);
  assert.match(markup, /Engine version/);
  assert.doesNotMatch(markup, /Loading|Downloading/);
});

test('library-layout: non-native games and unsupported features retain their capability restrictions', () => {
  const state = createLibraryFixture();
  const game = { ...state.recents[1], moduleSupports: { cheats: false, cheatsPatcher: false, saveEditing: false, saveLocation: false } };
  const markup = renderDetails(state, game);
  assert.doesNotMatch(markup, /<option value="native">|Tools patch|Change…/);
  const rows = renderRow({ ...state, recents: [game] }, false);
  assert.match(rows, /disabled="">Saves<\/button>/);
  assert.match(rows, /disabled="">Cheats<\/button>/);
});

test('library-layout: errors stay in the inspector and running sessions use row actions', () => {
  const state = createLibraryFixture();
  state.running[state.recents[0].gamePath] = 2;
  const markup = renderDetails(state, state.recents[0], { moduleActionError: 'Fixture failed' });
  const row = renderToStaticMarkup(React.createElement(GameRow, {
    g: state.recents[0], moduleInfo: state.modules[0], moduleSettings: state.moduleSettings,
    runtimeDefaults: {}, actions, isRunning: true, showIcons: true, showNonDefaultTags: true,
    favorite: true, selected: true, dragging: false, dragDisabled: false, onSelect: () => {}, onDragStart: () => {}, onDragEnd: () => {}
  }));
  assert.match(row, /aria-label="Stop Alpha"/);
  assert.match(row, /aria-label="Remove Alpha from favorites" aria-pressed="true"/);
  assert.match(markup, /Error: Fixture failed/);
});

test('library-layout: runtime and save override badges retain their inherited-default behavior', () => {
  const state = createLibraryFixture();
  state.moduleSettings.fixture.defaultRuntime = 'native';
  state.recents[0].runtimeSettings.managed = { scale: 2 };
  const markup = renderRow(state, false);
  assert.match(markup, />Managed runtime<\/span>/);
  assert.match(markup, />Modified<\/span>/);
  assert.match(markup, />Custom saves<\/span>/);
  assert.ok(markup.indexOf('>Managed runtime</span>') < markup.indexOf('class="badge">FX</span>'), 'Runtime override must precede the game-type label');
});

const engineTools = {
  mv: { before: ['installClipboardPlugin', 'installSaveSlotsPlugin', 'reconstructProject'], after: ['removeClipboardPlugin', 'removeSaveSlotsPlugin', 'removeDecryption'] },
  mz: { before: ['installClipboardPlugin', 'installSaveSlotsPlugin', 'reconstructProject'], after: ['removeClipboardPlugin', 'removeSaveSlotsPlugin', 'removeDecryption'] },
  rgss: { before: ['stageAssets', 'reconstructProject'], after: ['removeAssets', 'removeDecryption'] },
  renpy: { before: ['patchStatus', 'patch', 'unpatch', 'buildApp', 'extractGame'], after: ['patchStatus', 'unpatch', 'deleteBuild', 'removeExtraction'] }
};
for (const [id, scenarios] of Object.entries(engineTools)) {
  test(`library-layout: ${id} retains its real manifest tools before and after patch/build/extraction`, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', id, 'manifest.json'), 'utf8'));
    const state = createLibraryFixture();
    state.modules = [manifest];
    state.moduleSettings = { [id]: manifest.settingsDefaults };
    state.moduleStates = { [id]: {} };
    const base = {
      ...state.recents[0], moduleId: id, moduleSupports: manifest.supports,
      moduleRuntimeSupport: manifest.runtime.supported, moduleLabel: manifest.label,
      moduleShortLabel: manifest.shortLabel, runtimeId: manifest.runtime.default,
      nativeAppPath: null, moduleData: {}
    };
    for (const [phase, expectedIds] of Object.entries(scenarios)) {
      const game = phase === 'before' ? base : {
        ...base, lastBuiltAt: 1,
        moduleData: { patched: true, assetsStaged: true, decryptedReady: true,
          extractedReady: true, clipboardPluginInstalled: true, saveSlotsPluginInstalled: true }
      };
      const markup = renderDetails(state, game);
      for (const actionId of expectedIds) {
        const action = manifest.ui.actions.find(action => action.id === actionId);
        assert.ok(action, `Missing ${id} action ${actionId}`);
        const escaped = action.label.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        assert.ok(markup.includes(`aria-label="${escaped}"`), `${id} ${phase}: missing ${actionId}`);
      }
      assert.match(markup, /aria-label="Runtime"/);
      if (manifest.supports.cheats) assert.match(markup, />Cheats<\/button>/);
      else assert.doesNotMatch(markup, />Cheats<\/button>/);
    }
  });
}
