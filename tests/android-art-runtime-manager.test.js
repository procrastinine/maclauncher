const test = require('node:test'), assert = require('node:assert/strict');
const Art = require('../src/modules/android/art/runtime-manager');

function manager(id, {installed = [], catalog = []} = {}) {
  const calls = [];
  const state = () => ({installed, versionLabels:{}, defaultVersion:null,
    catalog:{versions:catalog.map(pin => pin.version), installableVersions:catalog.map(pin => pin.version), versionRequirements:{}, installable:catalog.length > 0,
      sources:[{id:'builds', label:'MacLauncher Builds', source:'https://example.test', versions:catalog.map(pin => pin.version), installableVersions:catalog.map(pin => pin.version)}]}});
  return {id, label:id, calls, delivery:{included:'none', catalog:'remote', sourceBuild:false},
    normalizeSettings:value => value || {}, core:{listDiscoveredCatalog:() => catalog}, getState:state,
    resolveSelection(entry, settings, _userDataDir, options = {}) {
      const version = options.version || entry?.runtimeData?.[id]?.version || settings?.runtimes?.[id]?.defaultVersion ||
        catalog.find(pin => !options.compatible || options.compatible(pin))?.version || installed[0]?.version || null;
      const install = installed.find(row => row.version === version);
      return {version, install:install || null, ready:Boolean(install), discoveryRequired:!catalog.length, reason:'Not installed'};
    },
    refreshCatalog:async options => {calls.push(['refresh', options]);},
    installRuntime:async options => {calls.push(['install', options]); return {version:options.version, installDir:'/'+id+'/'+options.version};},
    uninstallRuntime:async options => {calls.push(['remove', options]); return true;},
    importRuntime:async options => {calls.push(['import', options]);},
    registerCustomRuntime:async options => {calls.push(['register', options]);}
  };
}
const installed = (version, root, profile = {artExecutionVersion:1}) => ({version, ready:true, root, installDir:root, manifest:{profile}});
const pin = (version, capabilities = {artExecutionVersion:1}) => ({version, projectPackage:{capabilities}});

test('ART uses the installed unified Android root without creating another installation', async () => {
  const common = manager('android', {installed:[installed('0.2.0-MCLv1', '/android/unified')], catalog:[pin('0.2.0-MCLv1')]}),
    legacy = manager('android-art'), art = Art.createManager({commonManager:common, legacyManager:legacy});
  const selected = art.resolveSelection({}, {}, '/profile');
  assert.equal(selected.managerId, 'android');
  assert.equal(selected.install.root, '/android/unified');
  assert.deepEqual(selected.runtimeUses, [{managerId:'android', version:'0.2.0-MCLv1', sourcePath:'/android/unified'}]);
  assert.equal(art.resolveCommonSelection({}, {}, '/profile').install.root, selected.install.root);
  await art.installRuntime({userDataDir:'/profile', version:selected.version});
  assert.equal(common.calls[0][0], 'install');
  assert.deepEqual(legacy.calls, []);
});

test('saved and per-game separate ART versions remain usable offline', () => {
  const common = manager('android', {installed:[installed('new', '/android/new')], catalog:[pin('new')]}),
    legacy = manager('android-art', {installed:[installed('old', '/android-art/old')]}),
    art = Art.createManager({commonManager:common, legacyManager:legacy});
  for (const [entry, settings] of [[{}, {runtimes:{'android-art':{defaultVersion:'old'}}}],
    [{runtimeData:{'android-art':{version:'old'}}}, {}]]) {
    const selected = art.resolveSelection(entry, settings, '/profile');
    assert.equal(selected.managerId, 'android-art');
    assert.equal(selected.install.root, '/android-art/old');
  }
  assert.deepEqual(common.calls, []);
  assert.deepEqual(legacy.calls, []);
});

test('missing legacy ART choices select the ART-capable combined runtime offline', () => {
  for (const ready of [false, true]) {
    const common = manager('android', {installed:[installed('jvm', '/android/jvm', {}),
      ...(ready ? [installed('new', '/android/new')] : [])], catalog:[pin('jvm', {}), pin('new')]}),
      legacy = manager('android-art', {installed:[installed('kept', '/android-art/kept')], catalog:[pin('missing'), pin('kept')]}),
      art = Art.createManager({commonManager:common, legacyManager:legacy});
    const choices = [
      {entry:{}, settings:{runtimes:{'android-art':{defaultVersion:'missing'}, android:{defaultVersion:'jvm'}}}, options:{}},
      {entry:{}, settings:{runtimes:{'android-art':{customDefaults:{default:'missing'}}}}, options:{}},
      {entry:{runtimeData:{'android-art':{version:'missing'}}}, settings:{}, options:{}},
      {entry:{}, settings:{}, options:{version:'missing'}}
    ];
    for (const choice of choices) {
      const original = structuredClone(choice);
      const selected = art.resolveSelection(choice.entry, choice.settings, '/profile', choice.options);
      assert.equal(selected.managerId, 'android');
      assert.equal(selected.version, 'new');
      assert.equal(selected.ready, ready);
      assert.deepEqual(choice, original);
    }
    assert.deepEqual(common.calls, []);
    assert.deepEqual(legacy.calls, []);
  }
});

test('ART installation never downloads a standalone adapter and preserves installed adapters', async () => {
  const kept = installed('kept', '/android-art/kept'),
    common = manager('android', {catalog:[pin('jvm', {}), pin('new')]}),
    legacy = manager('android-art', {installed:[kept], catalog:[pin('missing'), pin('kept')]}),
    art = Art.createManager({commonManager:common, legacyManager:legacy});
  assert.equal(await art.installRuntime({userDataDir:'/profile', version:'kept', legacyAdapter:true}), kept);
  assert.deepEqual(legacy.calls, []);
  assert.deepEqual(common.calls, []);
  const options = {userDataDir:'/profile', version:'missing', legacyAdapter:true};
  const result = await art.installRuntime(options);
  assert.equal(result.version, 'new');
  assert.equal(common.calls.length, 1);
  assert.equal(common.calls[0][0], 'install');
  const forwarded = common.calls[0][1];
  assert.equal(forwarded.version, 'new');
  assert.equal(Object.hasOwn(forwarded, 'legacyAdapter'), false);
  assert.equal(forwarded.compatible(pin('new')), true);
  assert.equal(forwarded.compatible(pin('jvm', {})), false);
  assert.deepEqual(options, {userDataDir:'/profile', version:'missing', legacyAdapter:true});
  assert.deepEqual(legacy.calls, []);
  const state = art.getState({userDataDir:'/profile', settings:{defaultVersion:'kept'}});
  assert.equal(state.defaultVersion, 'kept');
  assert.equal(state.installed.find(row => row.version === 'kept'), kept);
  await art.uninstallRuntime({userDataDir:'/profile', version:'kept'});
  assert.equal(legacy.calls[0][0], 'remove');
});

test('missing legacy ART requirements use combined Android and never request a legacy install', t => {
  const common = manager('android', {catalog:[pin('new')]}),
    legacy = manager('android-art', {catalog:[pin('missing')]}),
    art = Art.createManager({commonManager:common, legacyManager:legacy});
  t.mock.method(Art.manager, 'resolveSelection', (...args) => art.resolveSelection(...args));
  const entry = {runtimeData:{'android-art':{version:'missing'}}};
  assert.deepEqual(Art.requirements(entry, {settings:{}, userDataDir:'/profile'}),
    [{managerId:'android', version:'new', label:Art.manager.label}]);
  common.core.listDiscoveredCatalog = () => [];
  const absent = art.resolveSelection(entry, {}, '/profile');
  assert.equal(absent.managerId, 'android');
  assert.equal(absent.version, null);
  assert.equal(absent.discoveryRequired, true);
  assert.deepEqual(legacy.calls, []);
});

test('an installed unified ART profile works without optional catalog capability metadata', () => {
  const common = manager('android', {installed:[installed('future', '/android/future')], catalog:[pin('future', {})]}),
    legacy = manager('android-art'), art = Art.createManager({commonManager:common, legacyManager:legacy});
  assert.equal(art.resolveSelection({}, {}, '/profile').install.root, '/android/future');
});

test('ART keeps one section and removes each installation through its original owner', async () => {
  const common = manager('android', {installed:[installed('new', '/android/new'), installed('jvm', '/android/jvm', {})], catalog:[pin('new'), pin('jvm', {})]}),
    legacy = manager('android-art', {installed:[installed('old', '/android-art/old')], catalog:[pin('old')]}),
    art = Art.createManager({commonManager:common, legacyManager:legacy});
  const state = art.getState({userDataDir:'/profile'});
  assert.equal(state.sections.length, 1);
  assert.equal(state.sections[0].id, 'default');
  assert.deepEqual(state.installed.map(row => row.version), ['new', 'old']);
  assert.deepEqual(state.catalog.versions, ['new']);
  assert.deepEqual(state.catalog.sources[0].versions, ['new']);
  // Runtimes names the Android runtime for downloads instead of an ART download list.
  assert.equal(state.catalog.packagesFrom.managerId, 'android');
  await art.uninstallRuntime({userDataDir:'/profile', version:'old'});
  await art.uninstallRuntime({userDataDir:'/profile', version:'new'});
  assert.equal(legacy.calls[0][1].version, 'old');
  assert.equal(common.calls[0][1].version, 'new');
  await art.refreshCatalog({userDataDir:'/profile'});
  assert.equal(common.calls[1][0], 'refresh');
  assert.equal(legacy.calls.length, 1);
});

test('ART replaces a common-only global default with one unified root for the launch', () => {
  const common = manager('android', {installed:[installed('jvm', '/android/jvm', {}), installed('unified', '/android/unified')], catalog:[pin('unified'), pin('jvm', {})]}),
    legacy = manager('android-art'), art = Art.createManager({commonManager:common, legacyManager:legacy});
  const settings = {runtimes:{android:{defaultVersion:'jvm'}}};
  assert.equal(art.resolveSelection({}, settings, '/profile').install.root, '/android/unified');
  assert.equal(art.resolveCommonSelection({}, settings, '/profile').install.root, '/android/unified');
});

test('ordinary ART launch uses its unified package for both common code and the supplier', async t => {
  const Module = require('../src/modules/android/custom-main'), Common = require('../src/modules/android/runtime-manager'),
    Runtime = require('../src/modules/android/runtime'), ArtRuntime = require('../src/modules/android/art/runtime'),
    Host = require('../src/modules/android/host');
  const common = {root:'/android/unified', profile:{}}, declaration = {version:'unified'}, supplier = {};
  t.mock.method(Common, 'resolveSelection', () => ({ready:true, version:'old', install:{root:'/android/old'}}));
  t.mock.method(Art.manager, 'resolveSelection', () => ({ready:true, managerId:'android', version:'unified',
    install:{root:common.root, installDir:common.root, declaration}}));
  t.mock.method(Runtime, 'resolveForLaunch', async (options, record) => {
    assert.equal(options.root, common.root);assert.equal(record, declaration);return common;
  });
  t.mock.method(Art, 'resolveForLaunch', async () => supplier);
  t.mock.method(ArtRuntime, 'attachSupplier', (platform, actualSupplier) => {
    assert.equal(platform, common);assert.equal(actualSupplier, supplier);return {...platform, artSupplier:supplier};
  });
  t.mock.method(Host, 'launch', async (_entry, _context, payload, dependencies) => {
    assert.equal(payload.root, common.root);assert.equal(await dependencies.resolvePlatformRuntime(), common);return 'prepared';
  });
  const context = {runtimeSettings:{execution:'art'}, settings:{}, userDataDir:'/profile'};
  assert.equal(await Module.launchRuntime('klepton', {gameId:'fixture'}, context), 'prepared');
});
