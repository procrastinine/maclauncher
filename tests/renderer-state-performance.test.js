const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLibraryFixture } = require('./library-layout-fixture');
let model;
test.before(async () => { model = await import('../src/renderer/src/ui/launcher-state-model.mjs'); });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('identical IPC snapshots reuse the entire launcher state', () => {
  const previous = createLibraryFixture();
  assert.equal(model.shareLauncherValue(previous, structuredClone(previous)), previous);
});
test('download progress preserves game, module, settings and catalog identities', () => {
  const previous = createLibraryFixture();
  previous.downloads = [{ id: 'download', downloaded: 0, status: 'downloading' }];
  const incoming = structuredClone(previous);
  incoming.downloads[0].downloaded = 100;
  const shared = model.shareLauncherValue(previous, incoming);
  assert.notEqual(shared, previous);
  for (const key of ['recents', 'modules', 'moduleSettings', 'moduleStates', 'runtimeManagers', 'runtimeDefaults', 'launcherSettings', 'running']) {
    assert.equal(shared[key], previous[key], key);
  }
  assert.notEqual(shared.downloads, previous.downloads);
  assert.equal(shared.downloads[0].downloaded, 100);
  assert.equal(previous.downloads[0].downloaded, 0);
  assert.deepEqual(shared, incoming);
});
test('local application inventory updates cached backend choices immediately while catalog refreshes preserve game objects', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const decorateSource = source.slice(source.indexOf('const recentDecorationCache = new Map();'), source.indexOf('\nfunction resolveSaveContext('));
  const eventStart = source.indexOf('  onEvent: (event, payload, lane) => {');
  const eventSource = source.slice(eventStart + '  onEvent: '.length, source.indexOf('\n});\nasync function confirmRuntimeInstallation', eventStart)).trim();
  const games = [{ gameId: 'windows', gamePath: '/game/player.exe', moduleId: 'engine' }];
  const settings = { modules: {}, runtimes: {} };
  let normalized = 0, broadcasts = 0;
  const context = { Map, JSON, runtimeInventoryRevision: 0, runtimeStateSnapshots: { local: { installed: [] } },
    moduleStateSnapshots: {}, cachedState: null, loadSettings: () => settings,
    loadGamesHydrated: () => games, orderGames: entries => entries,
    resolveModuleId: entry => entry.moduleId,
    normalizeGameEntry: entry => { normalized += 1; return { ...entry, moduleRuntimeSupport:
      context.runtimeStateSnapshots.local.installed.some(install => install.ready) ? ['local'] : [] }; },
    iconUrlForPath: () => null,
    buildRuntimeManagerState: () => structuredClone(context.runtimeStateSnapshots),
    launcherService: { getResolvedModuleSettings: () => settings.modules },
    saveStateSnapshotsSoon() {}, broadcastState: () => { broadcasts += 1; },
    buildState: () => ({ recents: games.map(entry => context.decorateRecentEntry(entry, settings)) })
  };
  vm.createContext(context);
  vm.runInContext(decorateSource, context);
  const onEvent = vm.runInContext('(' + eventSource + ')', context);
  context.cachedState = context.buildState();
  assert.deepEqual(Array.from(context.cachedState.recents[0].moduleRuntimeSupport), []);
  assert.equal(normalized, 1);
  const installed = { installed: [{ version: 'same-version-copy', ready: true, installDir: '/Applications/Player.app' }] };
  onEvent('runtimeState', { id: 'local', state: installed });
  assert.deepEqual(Array.from(context.cachedState.recents[0].moduleRuntimeSupport), ['local']);
  assert.equal(normalized, 2);
  const usable = context.cachedState.recents[0];
  onEvent('runtimeState', { id: 'local', state: structuredClone(installed) });
  assert.equal(broadcasts, 1);
  onEvent('runtimeState', { id: 'local', state: { ...installed, catalog: { status: 'ready', versions: ['same-version-copy'] } } });
  assert.equal(context.cachedState.recents[0], usable);
  assert.equal(normalized, 2);
  onEvent('runtimeState', { id: 'local', state: { installed: [] } });
  assert.deepEqual(Array.from(context.cachedState.recents[0].moduleRuntimeSupport), []);
  assert.equal(normalized, 3);
  settings.runtimes.local = { defaultVersion: 'another-copy' };
  onEvent('settingsChanged', { managerId: 'local' });
  assert.equal(normalized, 4, 'Changed local defaults are visible even when game and module settings are unchanged');
});
test('serialized games use the selected backend capabilities and pass local runtime context to eligibility', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const normalizeSource = source.slice(source.indexOf('function normalizeGameEntry('), source.indexOf('\nfunction buildModuleLaunchContext('));
  const manifest = { id: 'engine', gameType: 'engine', supports: { cheats: true, cheatsPatcher: true, saveEditing: true, saveLocation: false } };
  const provider = { supports: { cheats: false, cheatsPatcher: false, saveEditing: false, saveLocation: true } };
  let runtimeId = 'managed', eligibilityContext;
  const mod = { getRuntimeProvider: id => id === 'local' ? provider : null };
  const context = { path, GAME_SCHEMA_VERSION: 1, app: {}, userDataDir: '/state', runtimeStateSnapshots: { local: { installed: [] } },
    resolveModuleId: () => manifest.id, Modules: { getModule: () => mod, getModuleInfo: () => manifest },
    mergeRuntimeSettingsMap: (_, value) => value, resolveRuntimeForEntry: () => runtimeId,
    getModuleCheats: () => null, resolveImportPath: entry => entry.gamePath,
    resolveModuleDefaultIconPath: () => null, normalizeIconPath: () => null,
    ICON_SOURCES: { MODULE_DEFAULT: 'module-default' },
    resolveRuntimeSupportForEntry: (_mod, _info, _entry, _settings, supplied) => { eligibilityContext = supplied; return [runtimeId]; },
    canLaunchEntry: () => true
  };
  vm.createContext(context); vm.runInContext(normalizeSource, context);
  const entry = { gameId: 'game', gamePath: '/game/player.exe', runtimeSettings: {}, moduleData: {} };
  const settings = { runtimes: { local: { defaultVersion: 'app-copy' } } };
  const engine = context.normalizeGameEntry(entry, settings);
  assert.equal(engine.moduleSupports.cheats, true);
  assert.equal(engine.moduleSupports.saveLocation, false);
  runtimeId = 'local';
  const local = context.normalizeGameEntry(entry, settings);
  assert.equal(local.moduleSupports.cheats, false);
  assert.equal(local.moduleSupports.cheatsPatcher, false);
  assert.equal(local.moduleSupports.saveEditing, false);
  assert.equal(local.moduleSupports.saveLocation, true);
  assert.equal(local.moduleSupports.launch, true);
  assert.equal(eligibilityContext.settings, settings);
  assert.equal(eligibilityContext.userDataDir, '/state');
  assert.equal(eligibilityContext.getRuntimeManagerState('local'), context.runtimeStateSnapshots.local);
});
test('changing one game leaves every other game and its extracted icon stable', () => {
  const previous = createLibraryFixture();
  previous.recents = [previous.recents[0], { ...previous.recents[0], gamePath: '/other', gameId: 'other', iconUrl: 'data:image/png;base64,original' }];
  const incoming = structuredClone(previous);
  incoming.recents[0].runtimeData = { managed: { version: '2.0' } };
  const shared = model.shareLauncherValue(previous, incoming);
  assert.notEqual(shared.recents, previous.recents);
  assert.notEqual(shared.recents[0], previous.recents[0]);
  assert.equal(shared.recents[1], previous.recents[1]);
  assert.equal(shared.recents[0].moduleData, previous.recents[0].moduleData);
  assert.deepEqual(shared, incoming);
});
test('reordering or removing games preserves surviving game objects', () => {
  const previous = [{ gamePath: '/a', data: { ready: true } }, { gamePath: '/b', data: { ready: false } }];
  const reordered = model.shareLauncherValue(previous, structuredClone([...previous].reverse()));
  assert.equal(reordered[0], previous[1]);
  assert.equal(reordered[1], previous[0]);
  const removed = model.shareLauncherValue(previous, structuredClone([previous[1]]));
  assert.equal(removed[0], previous[1]);
  assert.deepEqual(model.shareLauncherValue([{ id: 'same', value: 1 }, { id: 'same', value: 2 }], [{ id: 'same', value: 2 }]), [{ id: 'same', value: 2 }]);
});
test('state reconciliation retains false and zero, removes missing fields, and does not merge opaque values', () => {
  const previous = { active: true, count: 1, absent: undefined, date: new Date(0) };
  const incoming = { active: false, count: 0, date: new Date(100) };
  const shared = model.shareLauncherValue(previous, incoming);
  assert.deepEqual(shared, incoming);
  assert.equal(Object.hasOwn(shared, 'absent'), false);
  assert.equal(shared.date, incoming.date);
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"zero":0}');
  assert.deepEqual(model.shareLauncherValue({}, hostile), hostile);
  assert.equal(Object.prototype.polluted, undefined);
});
test('identical per-game status responses do not change result maps', () => {
  const statuses = { '/game': { ready: true, version: '1.0' }, '/none': null };
  assert.equal(model.updatePathValue(statuses, '/game', { ready: true, version: '1.0' }), statuses);
  assert.equal(model.updatePathValue(statuses, '/none', null), statuses);
  assert.deepEqual(model.updatePathValue(statuses, '/new', null), { ...statuses, '/new': null });
});
test('inspector requests deduplicate concurrent calls and return cached results on reselection', async () => {
  const requests = model.createInspectionRequests();
  const pending = deferred(); let calls = 0;
  const request = () => { calls += 1; return pending.promise; };
  const first = requests.run('/a', 'status', 'version1', request);
  const strictModeReplay = requests.run('/a', 'status', 'version1', request);
  await Promise.resolve(); assert.equal(calls, 1);
  pending.resolve({ ready: true });
  assert.deepEqual(await first, { current: true, value: { ready: true } });
  assert.deepEqual(await strictModeReplay, { current: true, value: { ready: true } });
  await requests.run('/b', 'status', 'version1', async () => 'other game');
  assert.deepEqual(await requests.run('/a', 'status', 'version1', request), { current: true, value: { ready: true } });
  assert.equal(calls, 1);
});
test('changed runtime inputs suppress a slower old status response', async () => {
  const requests = model.createInspectionRequests();
  const pending = deferred();
  const previous = requests.run('/a', 'status', 'old-runtime-settings', () => pending.promise);
  const changed = await requests.run('/a', 'status', 'new-runtime-settings', async () => 'new');
  assert.deepEqual(changed, { current: true, value: 'new' });
  pending.resolve('old');
  assert.deepEqual(await previous, { current: false, value: 'old' });
});
test('manual refresh invalidates its status while other games and tools keep their cache', async () => {
  const requests = model.createInspectionRequests(); let calls = 0;
  const request = async () => ++calls;
  await requests.run('/a', 'status', 'same', request);
  await requests.run('/a', 'detect', 'same', request);
  await requests.run('/b', 'status', 'same', request);
  requests.invalidate('/a', 'status');
  assert.equal((await requests.run('/a', 'status', 'same', request)).value, 4);
  assert.equal((await requests.run('/a', 'detect', 'same', request)).value, 2);
  assert.equal((await requests.run('/b', 'status', 'same', request)).value, 3);
});
test('failed requests retry and removed-game requests cannot publish', async () => {
  const requests = model.createInspectionRequests();
  await assert.rejects(requests.run('/a', 'status', 'same', async () => { throw Error('temporary'); }), /temporary/);
  assert.equal((await requests.run('/a', 'status', 'same', async () => 'recovered')).value, 'recovered');
  const pending = deferred();
  const removed = requests.run('/removed', 'status', 'same', () => pending.promise);
  requests.retain(['/a']); pending.resolve('obsolete');
  assert.equal((await removed).current, false);
});
test('the initial snapshot cannot replace a newer state broadcast', async () => {
  const pending = deferred(); const received = []; let listener, removed = false;
  const stop = model.subscribeLauncherState({ getState: () => pending.promise,
    onState(callback) { listener = callback; return () => { removed = true; }; } }, state => received.push(state), error => { throw error; });
  listener({ revision: 2 }); pending.resolve({ revision: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [{ revision: 2 }]);
  stop(); assert.equal(removed, true);
  listener({ revision: 3 }); assert.equal(received.length, 1);
});
test('unmounted state subscriptions ignore late snapshots and failures', async () => {
  const pending = deferred(); const received = []; const errors = [];
  const stop = model.subscribeLauncherState({ getState: () => pending.promise, onState: () => () => {} },
    state => received.push(state), error => errors.push(error));
  stop(); pending.reject(Error('late'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, []); assert.deepEqual(errors, []);
});
