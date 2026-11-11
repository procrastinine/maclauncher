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
test('sustained activity updates retain large library objects without visiting their contents', () => {
  const catalog = Object.defineProperty({}, 'entries', { enumerable: true,
    get() { throw Error('Activity must not traverse catalog data'); } });
  const games = [Object.defineProperty({ gamePath: '/game' }, 'moduleData', { enumerable: true,
    get() { throw Error('Activity must not traverse game metadata'); } })];
  const previous = { recents: games, runtimeManagers: catalog, running: {}, downloads: [] };
  let current = previous;
  for (let index = 0; index < 10000; index += 1) {
    current = model.mergeLauncherActivity(current, { downloads: [{ id: 'java', downloaded: index, status: 'downloading' }] });
    assert.equal(current.recents, games);
    assert.equal(current.runtimeManagers, catalog);
    assert.equal(current.running, previous.running);
  }
  assert.equal(current.downloads[0].downloaded, 9999);
  assert.deepEqual(previous.downloads, []);
  assert.equal(model.mergeLauncherActivity(current, { downloads: structuredClone(current.downloads) }), current);
  assert.equal(model.mergeLauncherActivity(current, { recents: [], runtimeManagers: {} }), current,
    'Only activity fields can change on the activity channel');
});
test('activity received before the initial snapshot is rebased per field without dropping library data', async () => {
  const pending = deferred(), received = [];
  let activity, state;
  const stop = model.subscribeLauncherState({ getState: () => pending.promise,
    onState(callback) { state = callback; return () => {}; },
    onActivity(callback) { activity = callback; return () => {}; }
  }, next => received.push(next), error => { throw error; });
  activity({ downloads: [{ id: 'java', downloaded: 10 }] });
  activity({ preparing: { '/game': { phase: 'download' } } });
  activity({ downloads: [{ id: 'java', downloaded: 20 }] });
  assert.equal(received.length, 0);
  const snapshot = { recents: [{ gamePath: '/game' }], downloads: [], preparing: {}, running: {} };
  pending.resolve(snapshot);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 1);
  assert.equal(received[0].recents, snapshot.recents);
  assert.equal(received[0].downloads[0].downloaded, 20);
  assert.equal(received[0].preparing['/game'].phase, 'download');
  state({ ...snapshot, recents: [], downloads: [] });
  activity({ running: { '/other': 1 } });
  assert.deepEqual(received.at(-1).recents, []);
  assert.deepEqual(received.at(-1).downloads, []);
  assert.deepEqual(received.at(-1).running, { '/other': 1 });
  stop();
});
test('a utility view follows its first snapshot after subscribing and applies later activity to it', async () => {
  const received = [];
  let activity, requests = 0;
  const initial = { recents: [], downloads: [], preparing: {}, running: {}, utilityWindow: { view: 'runtimes', revision: 1 } };
  assert.equal(model.restoreLauncherState(initial).utilityWindow, initial.utilityWindow);
  const stop = model.subscribeLauncherState({ getState: () => { requests++; return new Promise(() => {}); },
    onState() { return () => {}; }, onActivity(callback) { activity = callback; return () => {}; }
  }, next => received.push(next), error => { throw error; }, initial);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1, 'A follow-up covers the interval before listeners mounted');
  activity({ downloads: [{ id: 'java', downloaded: 10 }] });
  assert.equal(received.length, 1);
  assert.equal(received[0].utilityWindow, initial.utilityWindow);
  assert.equal(received[0].downloads[0].downloaded, 10);
  stop();
});
test('a full broadcast supersedes buffered activity and a late initial response', async () => {
  const pending = deferred(), received = [];
  let activity, state, stateRemoved = false, activityRemoved = false;
  const stop = model.subscribeLauncherState({ getState: () => pending.promise,
    onState(callback) { state = callback; return () => { stateRemoved = true; }; },
    onActivity(callback) { activity = callback; return () => { activityRemoved = true; }; }
  }, next => received.push(next), error => { throw error; });
  activity({ downloads: [{ id: 'old' }] });
  state({ recents: [{ gamePath: '/new' }], downloads: [], running: {} });
  activity({ downloads: [{ id: 'current', downloaded: 50 }] });
  pending.resolve({ recents: [], downloads: [{ id: 'stale' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 2);
  assert.equal(received.at(-1).recents[0].gamePath, '/new');
  assert.equal(received.at(-1).downloads[0].id, 'current');
  stop();
  assert.ok(stateRemoved && activityRemoved);
  activity({ downloads: [] }); state({ recents: [] });
  assert.equal(received.length, 2);
});
test('library work shares availability, runs checks off main, retains previous results and batches updates', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const decorateSource = source.slice(source.indexOf('const recentDecorationCache = new Map();'), source.indexOf('\nfunction resolveSaveContext('));
  const eventStart = source.indexOf('  onEvent: (event, payload, lane) => {');
  const eventSource = source.slice(eventStart + '  onEvent: '.length, source.indexOf('\n});\nasync function confirmRuntimeInstallation', eventStart)).trim();
  const games = [{ gameId: 'windows', gamePath: '/game', iconPath: '/game/icon.png', moduleId: 'engine', runtimeId: 'local', networkAccess: false }];
  const settings = { modules: {}, runtimes: {} };
  const manifest = { id: 'engine', runtime: { default: 'local', supported: ['local'] }, supports: {} };
  const requests = [], warnings = [], iconReads = [], availability = deferred();
  let normalized = 0, scheduled = 0, rebuilds = 0, probes = 0, installed = false;
  const monitor = require('../src/main/game-availability-monitor').createAvailabilityMonitor({
    listGames: () => games, check: async () => { probes++; return availability.promise; },
    onChange: () => { if (context.cachedState) context.scheduleStateRebuild(); }
  });
  const context = { Map, JSON, String, Array, path, require: id => require(path.resolve(__dirname, '../src/main', id)),
    sanitizeRuntimeErrors: require('../src/core/runtime-errors.mjs').sanitizeRuntimeErrors,
    graphicsLaunchWarnings: new Map(), gameLaunchNotices: new Map(), runtimeInventoryRevision: 0,
    runtimeStateSnapshots: { local: { installed: [] } }, gameAvailability: monitor,
    GameAvailability: require('../src/core/game-availability'), Modules: { getModule: () => ({}), getModuleInfo: () => manifest },
    StoredPlan: require('../src/modules/shared/effects/stored-plan'), userDataDir: '/state', graphicsNotices: notices => notices,
    moduleStateSnapshots: {}, cachedState: null, loadSettings: () => structuredClone(settings),
    loadGamesHydrated: () => games, orderGames: entries => entries, gameRecordsCache: games,
    resolveModuleId: entry => entry.moduleId, logger: { warn: (...args) => warnings.push(args) },
    backendService: { request: (lane, method, entry, checkedSettings, options) => new Promise((resolve, reject) => {
      requests.push({ lane, method, entry, checkedSettings, options, resolve, reject });
    }) },
    NetworkAccess: require('../src/core/network-access'),
    SteamClientStart: { clientEligible: () => false, startPreference: value => value },
    entryModuleLabels: require('../src/core/entry-labels').entryModuleLabels,
    isChildGame: false, GAME_SCHEMA_VERSION: 1,
    mergeRuntimeSettingsMap: (_, value) => value,
    getModuleCheats: () => null, resolveImportPath: entry => entry.gamePath,
    resolveModuleDefaultIconPath: () => null, canRenderIconPath: () => true,
    normalizeIconPath: file => { iconReads.push(file); return file; },
    ICON_SOURCES: { MODULE_DEFAULT: 'module-default' },
    iconUrlForPath: file => file ? 'icon:' + file : null, libraryIcon: file => file ? { url: 'icon:' + file } : null,
    iconGeneration: 0, iconPendingReads: 0, iconDataUrlCache: new Map([['/game/icon.png', { url: 'data:image/png;base64,earlier' }]]),
    buildRuntimeManagerState: () => structuredClone(context.runtimeStateSnapshots),
    launcherService: { getResolvedModuleSettings: () => settings.modules },
    saveStateSnapshotsSoon() {}, broadcastState() {}, scheduleStateRebuild: () => { scheduled++; },
    buildState: () => ({ recents: games.map(entry => context.decorateRecentEntry(entry, settings)) }),
    GameStore: { readGameRecord: () => null },
    serializeGameEntry: entry => entry, mergeSettingsChanges: (_old, fresh) => fresh,
    saveGameRecord: entry => { games[0] = entry; }
  };
  const turn = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
  const flush = () => { if (scheduled) { scheduled = 0; rebuilds++; context.cachedState = context.buildState(); } };
  vm.createContext(context); vm.runInContext(decorateSource, context);
  vm.runInContext(source.slice(source.indexOf('function normalizeGameEntry('), source.indexOf('\nfunction buildModuleLaunchContext(')), context);
  const normalize = context.normalizeGameEntry;
  context.normalizeGameEntry = (entry, checkedSettings, precomputed) => {
    assert.ok(precomputed?.checks, 'no module checks run on main'); normalized++;
    return normalize(entry, checkedSettings, precomputed);
  };
  const handle = vm.runInContext('(' + eventSource + ')', context);
  const answer = async () => {
    for (const request of requests.splice(0)) request.resolve({ entry: request.entry,
      checks: { runtimeId: 'local', launch: true, managedSaveDir: false, runtimeSupport: installed ? ['local'] : [] }, metadataError: null });
    await turn(); flush(); await turn();
  };
  context.cachedState = context.buildState();
  assert.equal(context.cachedState.recents[0].iconUrl, 'data:image/png;base64,earlier', 'the preview from an earlier launch shows while the files are checked');
  assert.equal(context.cachedState.recents[0].iconPending, undefined);
  assert.deepEqual(iconReads, [], 'a hung first probe cannot trigger an icon read');
  vm.runInContext('queueLibraryWork(gameRecordsCache[0], loadSettings(), { refreshMetadata: true })', context);
  await turn();
  assert.equal(requests.length, 0, 'backend work waits for the shared availability check');
  availability.resolve({ available: true }); await turn(); flush(); await turn();
  assert.equal(context.cachedState.recents[0].iconUrl, 'icon:/game/icon.png', 'the first result releases the icon before backend checks finish');
  assert.deepEqual(iconReads, ['/game/icon.png']);
  assert.deepEqual(Array.from(context.cachedState.recents[0].moduleRuntimeSupport), ['local']);
  assert.equal(requests.length, 1, 'startup refresh and row checks coalesce');
  assert.match(requests[0].lane, /^library-view:/);
  assert.equal(requests[0].method, 'libraryEntry');
  assert.equal(requests[0].options.refreshMetadata, true);
  assert.equal(requests[0].options.availability.available, true);
  await answer();
  assert.deepEqual(Array.from(context.cachedState.recents[0].moduleRuntimeSupport), []);
  assert.equal(normalized, 3); assert.equal(probes, 1);
  installed = true;
  handle('runtimeState', { id: 'local', state: { installed: [{ version: 'copy', ready: true }] } });
  flush(); await turn();
  assert.equal(requests.length, 1);
  assert.equal(normalized, 3, 'previous usable checks stay while replacement runs');
  await answer();
  assert.deepEqual(Array.from(context.cachedState.recents[0].moduleRuntimeSupport), ['local']);
  assert.equal(probes, 1, 'inventory changes reuse main availability');
  const usable = context.cachedState.recents[0];
  const proxyUrl = new URL('http://proxy.invalid');
  proxyUrl.username = 'fixture';
  proxyUrl.password = 'secret';
  assert.ok(proxyUrl.username && proxyUrl.password, 'The event carries nonempty URL credentials');
  handle('runtimeState', { id: 'local', state: { installed: [{ version: 'copy', ready: true }], catalog: { versions: ['remote'] }, error: `Proxy ${proxyUrl.href} failed` } });
  assert.equal(context.runtimeStateSnapshots.local.error, 'Proxy http://proxy.invalid/ failed', 'The actual event handler sanitizes errors before storing a snapshot');
  flush(); await turn();
  assert.equal(requests.length, 0, 'catalog-only changes do no game work');
  assert.equal(context.cachedState.recents[0], usable);
  const before = rebuilds;
  for (const id of ['a', 'b', 'c']) handle('runtimeState', { id, state: { installed: [{ version: id }] } });
  flush(); await turn();
  assert.equal(rebuilds, before + 1);
  assert.equal(requests.length, 1, 'inventory burst becomes one check');
  const stale = requests.shift();
  settings.runtimes.local = { defaultVersion: 'new' };
  handle('settingsChanged', {}); flush(); await turn();
  stale.resolve({ entry: stale.entry, checks: { runtimeSupport: ['obsolete'] } });
  await turn(); flush(); await turn();
  assert.deepEqual(Array.from(context.cachedState.recents[0].moduleRuntimeSupport), ['local'], 'outdated replies cannot replace a usable result');
  assert.equal(requests.length, 1);
  requests.shift().reject(Error('worker failed')); await turn();
  assert.ok(warnings.some(args => args.join(' ').includes('worker failed')), 'per-game failures reach warning logs');
  context.buildState(); await turn();
  assert.equal(requests.length, 0, 'a failed unchanged job is not repeatedly retried by state rebuilds');
  assert.equal(probes, 1);
  monitor.close();
});
test('serialized games use the selected backend capabilities, and library checks that are not current are shown without being saved', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const normalizeSource = source.slice(source.indexOf('function normalizeGameEntry('), source.indexOf('\nfunction buildModuleLaunchContext('));
  const manifest = { id: 'engine', gameType: 'engine', supports: { cheats: true, cheatsPatcher: true, saveEditing: true, saveLocation: false } };
  const provider = { supports: { cheats: false, cheatsPatcher: false, saveEditing: false, saveLocation: true } };
  let runtimeId = 'managed';
  const checked = [];
  const mod = { getRuntimeProvider: id => id === 'local' ? provider : null };
  const context = { path, StoredPlan: require('../src/modules/shared/effects/stored-plan'),
    NetworkAccess: require('../src/core/network-access'), SteamClientStart: { clientEligible: () => false, startPreference: value => value },
    entryModuleLabels: require('../src/core/entry-labels').entryModuleLabels,
    isManagedSaveDirectory: require('../src/core/save-locations').isManagedSaveDirectory,
    isChildGame: false, gameRecordsCache: null, logger: { warn() {} },
    GameStore: { readGameRecord: () => null, setGameNetworkAccess: () => assert.fail('A game without a stored record is not written') },
    GAME_SCHEMA_VERSION: 1, app: {}, userDataDir: '/state', runtimeStateSnapshots: { local: { installed: [] } },
    resolveModuleId: () => manifest.id, Modules: { getModule: () => mod, getModuleInfo: () => manifest },
    mergeRuntimeSettingsMap: (_, value) => value,
    getModuleCheats: () => null, resolveImportPath: entry => entry.gamePath,
    resolveModuleDefaultIconPath: () => null, normalizeIconPath: () => null,
    gameAvailability: { get: () => null }, GameAvailability: require('../src/core/game-availability'),
    ICON_SOURCES: { MODULE_DEFAULT: 'module-default' },
    launcherService: { resolveEntryChecks: (entry, settings, options) => {
      checked.push({ entry, settings, options });
      return { runtimeId, runtimeSupport: [runtimeId], launch: true, managedSaveDir: false };
    } }
  };
  vm.createContext(context); vm.runInContext(normalizeSource, context);
  const entry = { gameId: 'game', gamePath: '/game/player.exe', runtimeSettings: {}, moduleData: {} };
  const settings = { runtimes: { local: { defaultVersion: 'app-copy' } } };
  const engine = context.normalizeGameEntry(entry, settings);
  assert.equal(engine.moduleSupports.cheats, true);
  assert.equal(engine.moduleSupports.saveLocation, false);
  assert.equal(engine.moduleSupports.saveLocationOverride, true);
  manifest.supports.saveLocationOverride = false;
  const fixed = context.normalizeGameEntry({...entry, saveDirOverride: '/old-import'}, settings);
  assert.equal(fixed.moduleSupports.saveLocationOverride, false);
  assert.equal(fixed.saveDirOverride, null);
  provider.supports.saveLocationOverride = true;
  runtimeId = 'local';
  const local = context.normalizeGameEntry(entry, settings);
  assert.equal(local.moduleSupports.cheats, false);
  assert.equal(local.moduleSupports.cheatsPatcher, false);
  assert.equal(local.moduleSupports.saveEditing, false);
  assert.equal(local.moduleSupports.saveLocation, true);
  assert.equal(local.moduleSupports.launch, true);
  assert.deepEqual(Array.from(local.moduleRuntimeSupport), ['local']);
  assert.equal(checked.at(-1).settings, settings);
  assert.equal(checked.at(-1).options.availability, null);
  const count = checked.length;
  const saved = [];
  context.GameStore.readGameRecord = () => ({ gameId: 'game' });
  context.GameStore.setGameNetworkAccess = (_dir, id, value) => saved.push({ id, value });
  const pending = context.normalizeGameEntry({ ...entry, networkAccess: undefined }, settings,
    { checks: { runtimeId: 'managed', runtimeSupport: ['managed'], launch: false, managedSaveDir: true }, current: false });
  assert.equal(checked.length, count, 'precomputed checks replace the module checks');
  assert.equal(pending.runtimeId, 'managed');
  assert.equal(pending.moduleSupports.launch, false);
  assert.equal(pending.managedSaveDir, true);
  assert.equal(typeof pending.networkAccess, 'boolean');
  assert.deepEqual(saved, [], 'a network setting derived from checks that are not current is not saved');
  context.normalizeGameEntry({ ...entry, networkAccess: undefined }, settings,
    { checks: { runtimeId: 'managed', runtimeSupport: ['managed'], launch: true, managedSaveDir: false }, current: true });
  assert.deepEqual(saved.map(change => change.id), ['game']);
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
test('removing games releases their inspector results without cloning retained reports', () => {
  const report = { lines: new Array(10000).fill('retained report') };
  const values = { '/kept': report, '/removed': { lines: ['old report'] } };
  const paths = new Set(['/kept']);
  const retained = model.retainPathValues(values, paths);
  assert.deepEqual(Object.keys(retained), ['/kept']);
  assert.equal(retained['/kept'], report);
  assert.equal(model.retainPathValues(retained, paths), retained);
  const late = model.updatePathValue(retained, '/removed', { lines: ['late response'] });
  assert.deepEqual(model.retainPathValues(late, paths), retained);
  assert.deepEqual(model.retainPathValues(retained, new Set()), {});
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

test('utility snapshot follow-up repairs changes lost between render and listener installation', async () => {
  const initial = {recents: [], runtimeManagers: {}, downloads: [], running: {}};
  const latest = {...initial, runtimeManagers: {wine: {installed: [{version:'new'}]}}};
  const received = [];
  const stop = model.subscribeLauncherState({getState: async () => latest, onState: () => () => {}, onActivity: () => () => {}},
    next => received.push(next), error => {throw error;}, initial);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.at(-1)?.runtimeManagers.wine.installed[0].version, 'new');
  stop();
});
