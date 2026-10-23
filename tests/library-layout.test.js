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

test('network access is visible for every backend and mirrors runtime defaults and game overrides', () => {
  const { listModules } = require('../src/modules/registry');
  const { resolveRuntimeSettingsForEntry, buildRuntimeSettingsDefaults, resolveRuntimeSettingsSchema } = require('../src/core/runtime-settings');
  const state = createLibraryFixture();
  for (const moduleInfo of listModules()) {
    for (const [runtimeId, entry] of Object.entries(moduleInfo.runtime?.entries || {})) {
      if (entry.launch === false) continue;
      const game = { ...state.recents[0], moduleId: moduleInfo.id, runtimeId, runtimeData: {}, runtimeSettings: {} };
      const markup = renderDetails(state, game, { moduleInfo });
      assert.match(markup, /<input type="checkbox" aria-label="Network access"/, `${moduleInfo.id}/${runtimeId}`);
    }
  }
  const moduleInfo = listModules().find(module => module.id === 'java');
  const game = { ...state.recents[0], moduleId: moduleInfo.id, runtimeId: 'java', runtimeData: {}, runtimeSettings: {} };
  state.runtimeDefaults.java = { networkIsolation: true };
  for (const override of [undefined, false, true]) {
    game.runtimeSettings.java = override === undefined ? {} : { networkIsolation: override };
    const schema = resolveRuntimeSettingsSchema(moduleInfo, 'java');
    const effective = resolveRuntimeSettingsForEntry(game, { modules: state.moduleSettings }, moduleInfo, 'java',
      { ...buildRuntimeSettingsDefaults(schema), ...state.runtimeDefaults.java });
    const checkbox=renderDetails(state,game,{moduleInfo}).match(/<input type="checkbox" aria-label="Network access"[^>]*>/)?.[0];
    assert.ok(checkbox);assert.equal(checkbox.includes('checked=""'),!effective.networkIsolation);
  }
});

test('launch arguments remain a common game control across every registered runtime', () => {
  const state = createLibraryFixture();
  for (const moduleInfo of require('../src/modules/registry').listModules()) {
    for (const runtimeId of moduleInfo.runtime?.supported || []) {
      const game = { ...state.recents[0], moduleId: moduleInfo.id, runtimeId, runtimeData: {}, runtimeSettings: {},
        launchArguments: '--name "A B"', moduleRuntimeSupport: moduleInfo.runtime.supported };
      const markup = renderDetails(state, game, { moduleInfo });
      assert.match(markup, /aria-label="Launch arguments"/, `${moduleInfo.id}/${runtimeId}`);
      assert.match(markup, />--name &quot;A B&quot;<\/textarea>/, `${moduleInfo.id}/${runtimeId}`);
      assert.match(markup, /aria-label="About launch arguments"/, `${moduleInfo.id}/${runtimeId}`);
    }
  }
});

test('Android choices describe automatic Play and preserve each runtime capability boundary', () => {
  const state=createLibraryFixture(),moduleInfo=require('../src/modules/registry').listModules().find(mod=>mod.id==='android');
  assert.deepEqual(moduleInfo.runtime.supported,['klepton','macapk','aim']);
  const game={...state.recents[0],moduleId:'android',runtimeData:{},runtimeSettings:{},moduleRuntimeSupport:moduleInfo.runtime.supported};
  for(const runtimeId of ['klepton','macapk','aim']){
    const markup=renderDetails(state,{...game,runtimeId},{moduleInfo});
    assert.match(markup,/<option value="klepton"[^>]*>MacLauncher Android<\/option>/);
    assert.match(markup,/Each runtime keeps separate game data; switching preserves it/);
    assert.match(markup,/aria-label="About this runtime"/);
    assert.doesNotMatch(markup,/Klepton \+ Java 21|cargo |Install Android runtime/);
    if(runtimeId==='aim'){
      assert.match(markup,/macOS 26\.0 or later/);assert.match(markup,/2560 × 1600 at 320 dpi/);
      assert.match(markup,/1\.95 GB system image after confirmation/);
      const network=markup.match(/<input type="checkbox" aria-label="Network access"[^>]*>/)[0];
      assert.match(network,/disabled=""/);assert.doesNotMatch(network,/checked=""/);
      assert.doesNotMatch(markup,/>Add to Google Play library</);
    }
    if(runtimeId==='macapk')assert.match(markup,/macOS 26\.4 or later/);
  }
});

test('shared graphics choices require presentation support and retain a way to disable unavailable saved methods', () => {
  const state = createLibraryFixture();
  state.reshade = { available: true, presets: [{ id: 'grayscale', label: 'Grayscale' }],
    graphics: { spatial: false, frameGeneration: false, spatialMethods: ['metalfx'], frameGenerationMethods: ['lsfg'] } };
  assert.doesNotMatch(renderDetails(state), /game-spatial-method/);
  state.recents[0].graphics = { spatialMethod: 'metalfx', frameGeneration: 'off' };
  const unavailable = renderDetails(state);
  assert.match(unavailable, /MetalFX Spatial · Unavailable/);
  assert.match(unavailable, /value="off">Off/);
  state.reshade.graphics.spatial = true;
  const available = renderDetails(state);
  assert.match(available, /value="metalfx" selected="">MetalFX Spatial<\/option>/);
  assert.doesNotMatch(available, /Import Lossless|Reload installed models|value="lsfg"/);
});

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
  assert.match(markup, />Save \.command…</);
  assert.match(markup, /aria-label="Play Alpha"/);
  assert.match(markup, /aria-label="Forget Alpha"/);
  assert.match(markup, />Edit saves</);
});

test('every game and runtime retains Save .command beside Play at the top of the inspector', () => {
  const state = createLibraryFixture();
  for (const moduleInfo of require('../src/modules/registry').listModules()) {
    for (const runtimeId of moduleInfo.runtime?.supported || []) {
      const game = { ...state.recents[0], moduleId: moduleInfo.id, runtimeId, runtimeData: {}, runtimeSettings: {},
        moduleRuntimeSupport: moduleInfo.runtime.supported, moduleSupports: { launch: false } };
      const markup = renderDetails(state, game, { moduleInfo });
      const actionRow = markup.slice(markup.indexOf('class="gameActions inspectorGameActions"'), markup.indexOf('class="gameDetails"'));
      const buttons = [...actionRow.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
      assert.match(buttons[0] || '', /aria-label="Play Alpha"/, `${moduleInfo.id}/${runtimeId}`);
      assert.match(buttons[1] || '', />Save \.command…<\/button>/, `${moduleInfo.id}/${runtimeId}`);
      assert.doesNotMatch(buttons[1], /disabled=/, `${moduleInfo.id}/${runtimeId}`);
    }
  }
});

test('fixed save folders retain reveal and tools without relocation controls or legacy path display', () => {
  const state = createLibraryFixture();
  const game = state.recents[0];
  game.defaultSaveDir = '/owned/private-saves';game.saveDirOverride = '/legacy/external-saves';
  game.moduleSupports = {...game.moduleSupports, saveLocation: true, saveLocationOverride: false};
  const markup = renderDetails(state);
  assert.match(markup, /\/owned\/private-saves/);
  assert.match(markup, /aria-label="Reveal in Finder"/);
  assert.match(markup, />Edit saves</);
  assert.doesNotMatch(markup, /\/legacy\/external-saves|>Change…<|>Reset</);
  assert.doesNotMatch(renderRow(state, false), /Custom saves/);
  game.moduleSupports.saveLocationOverride = true;
  assert.match(renderDetails(state), />Change…<|>Reset</);
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
