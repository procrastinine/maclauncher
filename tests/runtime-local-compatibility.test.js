const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { installedRuntimeVersion } = require('../src/modules/shared/runtime/version-choices');
const { createPinnedNativeManager } = require('../src/modules/shared/runtime/pinned-native-manager');
const { prepareForLaunch } = require('../src/core/runtime-preparation');
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function replace(t, object, key, value) {
  const original = object[key]; object[key] = value;
  t.after(() => { object[key] = original; });
}
test('local resolution prefers exact, otherwise newest ready compatible; manual and invalid copies stay exact', () => {
  const installed = ['8.2.1', '7.9.9', '8.2.10', '8.3.4', '8.9.0'].map(version => ({version, ready: version !== '8.9.0'}));
  const select = options => installedRuntimeVersion({ version: '8.3.4', source: 'recommended', installed, compatibility: 'major', ...options });
  assert.equal(select(), '8.3.4');
  assert.equal(select({installed: installed.filter(row => row.version !== '8.3.4')}), '8.2.10');
  assert.equal(select({source: 'manual', version: '8.3.5'}), null);
  assert.equal(select({version: '9.0.0'}), null);
  assert.equal(select({installed: [{version: '8.3.4', status: 'damaged'}, {version: '8.2.1', error: 'changed'}]}), null);
  assert.equal(select({version: '/custom/runtime'}), null);
});

test("Ren'Py 8.3.4 uses installed 8.2.x for preparation and runtime use; manual 8.3.4 still requests install", async t => {
  const Renpy = require('../src/modules/renpy/main');
  const Manager = require('../src/modules/renpy/runtime/sdk-runtime-manager');
  const root = temporary(t), sdk = path.join(root, 'sdk'); fs.mkdirSync(sdk);
  replace(t, Manager.core, 'listInstalled', () => [{version: '8.2.3', ready: true, installDir: sdk}]);
  const entry = {gameId: 'local', runtimeId: 'sdk', moduleData: {renpyMajor: 8, detectedVersion: '8.3.4', builtSdkVersion: '8.3.4'}, runtimeData: {}};
  // Use the same version evidence and game-only layout used by imported SDK games.
  entry.moduleData.version = '8.3.4'; entry.contentRootDir = root;
  let used;
  const context = {userDataDir: root, runtimeId: 'sdk', settings: {}, useRuntime: value => {used = value;}};
  assert.equal(await Renpy.ensureRuntime(entry, context), null);
  await Renpy.prepareLaunch(entry, context);
  assert.equal(used.version, '8.2.3');
  const plan = await Renpy.ensureRuntime({...entry, runtimeData: {sdk: {version: '8.3.4'}}}, context);
  assert.equal(plan.version, '8.3.4'); assert.equal(plan.managerId, 'sdk');
});

const policies = [
  ['EasyRPG', 'easyrpg/runtime/manager'], ['DOSBox', 'dosbox/runtime/manager'],
  ['ScummVM', 'scummvm/runtime/manager'], ['HashLink', 'hashlink/runtime/manager'],
  ['FNA', 'fna/runtime/manager'], ['Butterscotch', 'gamemaker/runtime/butterscotch'],
  ['OpenGMK', 'gamemaker/runtime/opengmk'], ['MKXP-Z/RGSS', 'rgss/runtime/mkxpz-manager'],
  ['NW.js', 'shared/web/runtime/nwjs-manager'], ['LÖVE', 'love/runtime/love-runtime-manager'],
  ['Java', 'java/runtime/java-runtime-manager'],
  ["mpv", "video/runtime/manager"],
  ["GemRB", "gemrb/runtime/manager"],
  ["Ikemen", "ikemen/runtime/manager"],
  ["rfvp", "fvp/runtime/manager"],
  ["Nitroplus", "nitroplus/runtime/manager"],
  ["Minori", "minori/runtime/manager"],
  ["Siglus", "siglus/runtime/manager"],
  ["RLVM", "siglus/runtime/rlvm-manager"],
  ["msg-tool", "shared/runtime/msg-tool"],
];
for (const [label, location] of policies) test(`${label}: declared policy reuses local preference before shared Play consent and keeps manual pin exact`, async t => {
  const policy = (require('../src/modules/' + location).manager || require('../src/modules/' + location)).versionCompatibility;
  assert.ok(policy, label + ' declares its compatibility contract');
  const root = temporary(t), id = 'local-policy';
  const manager = createPinnedNativeManager({id, label, versionCompatibility: policy,
    discoverCatalog: () => assert.fail('No network discovery while using an installed runtime'),
    inspectRuntime: ({runtimePath}) => ({executablePath: runtimePath, architectures: ['arm64','x86_64'], ready: true})});
  const version = '11.2.0', requested = '11.3.0', runtimePath = path.join(root, 'runtime'); fs.writeFileSync(runtimePath, 'program');
  manager.core.registerLocal({userDataDir: root, version, runtimePath});
  const settings = {runtimes: {[id]: {defaultVersion: requested}}};
  const entry = {runtimeId: id, runtimeData: {}};
  const selection = manager.resolveSelection(entry, settings, root, {recommendedVersion: requested});
  assert.equal(selection.version, version); assert.equal(selection.ready, true);
  assert.equal(manager.resolveSelection({...entry, runtimeData: {[id]: {version: requested}}}, settings, root).ready, false);
  await prepareForLaunch({entry, info: {runtime: {manager: {[id]: id}}}, mod: {},
    context: {settings, userDataDir: root, runtimeId: id, confirmRuntimeInstall: () => assert.fail('Usable local runtime must not ask')},
    registry: {listModuleIds: () => ['fixture'], getModule: () => ({runtimeManagers: [manager]})},
    install: () => assert.fail('Usable local runtime must not install')});
});

test('Godot exact mismatch still produces a Play download request', async t => {
  const Godot = require('../src/modules/godot/runtime/godot-runtime-manager');
  assert.equal(Godot.versionCompatibility, 'exact');
  const root = temporary(t); let asked = false, installed = false;
  const manager = {id: 'exact', versionCompatibility: Godot.versionCompatibility,
    getState: () => ({defaultVersion: '4.3.0', installed: [{version: '4.2.0', ready: true}],
      catalog: {versions: ['4.3.0'], versionRequirements: {'4.3.0': {requiresDownload: true}}}}),
    installRuntime: () => {}};
  await prepareForLaunch({entry: {}, mod: {}, info: {runtime: {manager: {exact: 'exact'}}},
    context: {runtimeId: 'exact', userDataDir: root, settings: {}, confirmRuntimeInstall: plan => {asked = plan.version; return true;}},
    registry: {listModuleIds: () => ['fixture'], getModule: () => ({runtimeManagers: [manager]})},
    install: async (_manager, plan) => {installed = plan.version;}});
  assert.equal(asked, '4.3.0'); assert.equal(installed, '4.3.0');
});

test('native profile predicates exclude an installed HashLink/argument ABI mismatch', t => {
  const root = temporary(t), manager = createPinnedNativeManager({id: 'profiled', label: 'Profiled', versionCompatibility: () => true,
    discoverCatalog: () => [], inspectRuntime: ({runtimePath}) => ({executablePath: runtimePath, architectures: ['arm64','x86_64'], ready: true})});
  for (const version of ['1.0', '2.0']) {const runtimePath = path.join(root, version);fs.writeFileSync(runtimePath, version);manager.core.registerLocal({userDataDir: root, version, runtimePath});}
  const selected = manager.resolveSelection({}, {}, root, {recommendedVersion: '3.0', compatible: pin => pin.version === '1.0'});
  assert.equal(selected.version, '1.0');assert.equal(selected.ready, true);
});

test('Kirikiri and GameMaker retain module-owned feature/resource compatibility', () => {
  const Kiri = require('../src/modules/kirikiri/main').runtimeManagers[0];
  assert.equal(installedRuntimeVersion({version: '2.0', source: 'default', installed: [{version:'1.0',ready:true}], compatibility: Kiri.versionCompatibility}), '1.0');
  const GameMaker = require('../src/modules/gamemaker/runtime/official').manager;
  const compatibility = candidate => GameMaker.versionCompatibility(candidate, null, null, {moduleData:{minimumEngineVersion:'2024.1.0.1', maximumOfficialRuntimeExclusive:'2025.0.0.1'}});
  assert.equal(installedRuntimeVersion({version:'2024.9.0.1', source:'recommended', installed:[{version:'2023.1.0.1'},{version:'2024.3.0.1'}], compatibility}), '2024.3.0.1');
});

test('graphics driver/translator packages retain exact consumer contracts', () => {
  const translator = require('../src/modules/shared/runtime/translator-managers').createManager('dxvk');
  const driver = require('../src/modules/shared/vulkan/libraries').managers[0];
  for (const manager of [translator, driver]) {
    assert.equal(manager.versionCompatibility, 'exact');
    assert.equal(installedRuntimeVersion({version:'2.0',source:'default',installed:[{version:'1.0',ready:true}],compatibility:manager.versionCompatibility}), null);
  }
});

test('NW.js actual resolver uses another local web host, while a manual missing host stays missing', async t => {
  const Manager = require('../src/modules/shared/web/runtime/nwjs-manager'), root = temporary(t);
  const local = {version: '0.80.0', ready: true, platformKey: 'osx-x64'};
  replace(t, Manager.core, 'listInstalled', () => [local]);
  replace(t, Manager.core, 'resolveBestInstalled', ({version}) => !version || version === local.version ? local : null);
  const settings = {runtimes: {nwjs: {defaultVersion: '0.81.0'}}};
  const selected = await Manager.resolveSelection({runtimeId: 'nwjs'}, settings, root);
  assert.equal(selected.version, local.version); assert.equal(selected.ready, true);
  assert.equal((await Manager.resolveSelection({runtimeId:'nwjs',runtimeData:{nwjs:{version:'0.81.0'}}}, settings, root)).ready, false);
});

test('LÖVE actual Play resolver reuses the detected API family and keeps a manual release exact', async t => {
  const Love = require('../src/modules/love/main'), Manager = require('../src/modules/love/runtime/love-runtime-manager');
  const root = temporary(t), local = {version:'11.4',ready:true,appPath:'/fixture/love.app'};
  const section = {id:'stable',defaultVersion:'11.5',installed:[local],catalog:{versions:['11.5','11.4']}};
  replace(t, Manager, 'getState', () => ({sections:[section],stable:section}));
  replace(t, Manager.core, 'resolveInstalled', ({version}) => version === local.version ? local : null);
  replace(t, Manager.core, 'findNightlyByBundleVersion', () => null);
  const entry = {runtimeId:'love',runtimeData:{},moduleData:{detectedVersionNormalized:'11.5'}};
  assert.equal(await Love.ensureRuntime(entry,{runtimeId:'love',settings:{},userDataDir:root}), null);
  const plan = await Love.ensureRuntime({...entry,runtimeData:{love:{version:'11.5'}}},{runtimeId:'love',settings:{},userDataDir:root});
  assert.equal(plan.version, '11.5');
  assert.equal(installedRuntimeVersion({version:'12.0',source:'recommended',installed:[local],compatibility:Manager.versionCompatibility}), null);
});

test('Java actual resolver reuses a local patch within its JVM line and preserves required variants', t => {
  const Java = require('../src/modules/java/main'), Core = require('../src/modules/java/runtime/java-runtime');
  const root = temporary(t), local = {version:'21.0.2+13',variant:'arm64',javaPath:'/fixture/java',ready:true};
  replace(t, Core, 'listInstalled', () => [local]);
  replace(t, Core, 'resolveBestInstalled', ({version,strictVariant,variant}) => (!version || version === local.version) && (!strictVariant || variant === local.variant) ? local : null);
  const options = {userDataDir:root,line:21,runtimeData:{},lineConfig:{defaultVersion:'21.0.3+9',defaultVariant:'arm64'}};
  assert.equal(Java.__test.resolveInstalledRuntime(options).version, local.version);
  assert.equal(Java.__test.resolveInstalledRuntime({...options,runtimeData:{version:'21.0.3+9'}}), null);
});

for (const location of ['unity/runtime/manager','xash3d/runtime/manager','mac32/runtime/manager','ios/runtime/manager',
  'shared/runtime/decrypter-manager','anyps5/runtime/manager','prosper/runtime/manager','siglus/runtime/rlvm-adapter-manager'])
  test(`${location}: a different installed package cannot satisfy its declared native contract`, () => {
    const manager = require('../src/modules/' + location);
    assert.equal(manager.versionCompatibility, 'exact');
    assert.equal(installedRuntimeVersion({version:'2.0',source:'default',installed:[{version:'1.0',ready:true}],compatibility:manager.versionCompatibility}), null);
  });

test('AliceSoft interpreter generations reuse local copies without crossing manager generations', () => {
  const managers = require('../src/modules/alicesoft/main').runtimeManagers.filter(manager => ['system3','xsystem35','xsystem4'].includes(manager.id));
  assert.equal(managers.length, 3);
  for (const manager of managers) assert.equal(installedRuntimeVersion({version:'2.0',source:'default',installed:[{version:'1.0',ready:true}],compatibility:manager.versionCompatibility}), '1.0');
});

test('NX and Impacto retain exact guest/profile ABI packages', () => {
  const nx = require('../src/modules/nxnative/runtime/legacy-manager').createManager();
  const impacto = require('../src/modules/mages/native/manager').createManager();
  for (const manager of [nx, impacto]) {
    assert.equal(manager.versionCompatibility, 'exact');
    assert.equal(installedRuntimeVersion({version:'2.0',source:'recommended',installed:[{version:'1.0',ready:true}],compatibility:manager.versionCompatibility}), null);
  }
});

test('Java tool host uses a compatible local JVM despite a missing saved patch', async t => {
  const Host = require('../src/modules/shared/runtime/java-tool-host'), Manager = require('../src/modules/java/runtime/java-runtime-manager');
  const core = Manager.core.java, root = temporary(t), local = {version:'21.0.2+13',javaPath:'/fixture/java',ready:true,requiresRosetta:false};
  replace(t, core, 'listInstalled', (_dir, line) => line === 21 ? [local] : []);
  replace(t, core, 'resolveBestInstalled', ({line,version}) => line === 21 && (!version || version === local.version) ? local : null);
  const host = await Host.ensure({userDataDir:root,settings:{runtimes:{java:{defaultLine:21,lines:{21:{defaultVersion:'21.0.3+9'}}}}},
    confirmRuntimeInstall: () => assert.fail('A usable Java host must not ask')},17);
  assert.equal(host.version,local.version);
});

test('Greenworks explicit host remains tied to its exact bridge ABI', t => {
  const Manager = require('../src/modules/shared/web/runtime/nwjs-manager');
  const contracts = require('../src/modules/shared/web/runtime/greenworks-contracts.json');
  const root = temporary(t), requested = contracts[0].nwVersion;
  replace(t, Manager.core, 'listInstalled', () => [{version:'0.80.0',ready:true}]);
  replace(t, Manager.core, 'resolveBestInstalled', ({versions}) => versions ? null : {version:'0.80.0',ready:true});
  const config = Manager.resolveRuntimeConfig({userDataDir:root,needsGreenworks:true,runtimeData:{version:requested}});
  assert.equal(config.version,requested);
});

test('managed Vulkan package declares its feature contract exact', () => {
  const Managed = require('../src/modules/shared/vulkan/managed');
  assert.equal(Managed.manager.versionCompatibility,'exact');
});

for (const location of ['ai5/runtime/manager','nscripter/runtime/onscripter-en-manager','flash/runtime/ruffle-runtime-manager'])
  test(`${location}: interpreter policy accepts a ready local release and keeps manual choices exact`, () => {
    const manager = require('../src/modules/' + location);
    assert.equal(installedRuntimeVersion({version:'2.0',source:'recommended',installed:[{version:'1.0',ready:true}],compatibility:manager.versionCompatibility}), '1.0');
    assert.equal(installedRuntimeVersion({version:'2.0',source:'manual',installed:[{version:'1.0',ready:true}],compatibility:manager.versionCompatibility}), null);
  });
for (const location of ['flash/runtime/projector-manager','android/runtime-manager','android/providers/aim/manager',
  'android/providers/macapk/manager','shared/runtime/apple-metal-toolchain'])
  test(`${location}: the selected native/framework/compiler profile stays exact`, () => {
    const module = require('../src/modules/' + location), manager = module.versionCompatibility ? module : module.createManager();
    assert.equal(manager.versionCompatibility,'exact');
    assert.equal(installedRuntimeVersion({version:'2.0',source:'default',installed:[{version:'1.0',ready:true}],compatibility:manager.versionCompatibility}), null);
  });

test('Browser Woditor selects the same ready local preference for Play and status', t => {
  const Manager = require('../src/modules/wolfrpg/runtime/manager'), root = temporary(t);
  const local = {version:'1.0.0',ready:true};
  replace(t, Manager, 'getState', () => ({defaultVersion:'1.1.0',installed:[local],catalog:{versions:['1.1.0','1.0.0']}}));
  replace(t, Manager.core, 'resolveInstalled', ({version}) => version === local.version ? local : null);
  assert.equal(Manager.resolveSelection({}, {}, root).version,local.version);
  const status = require('../src/modules/wolfrpg/main').actions.runtimeStatus({}, {}, {settings:{},userDataDir:root});
  assert.equal(status.version,local.version);assert.equal(status.ready,true);
  assert.equal(Manager.resolveSelection({runtimeData:{'browser-woditor':{version:'1.1.0'}}},{},root).ready,false);
});

test('Ruffle actual Play selection uses a compatible installed interpreter before download', async t => {
  const Flash = require('../src/modules/flash/main'), Manager = require('../src/modules/flash/runtime/ruffle-runtime-manager');
  const root = temporary(t), local = {version:'2026.1.1',ready:true,appPath:'/fixture/Ruffle.app'};
  replace(t, Manager, 'getState', () => ({defaultVersion:'2026.2.1',installed:[local],catalog:{versions:['2026.2.1','2026.1.1']}}));
  replace(t, Manager.core, 'listInstalled', () => [local]);
  replace(t, Manager.core, 'resolveInstalled', ({version}) => version === local.version ? local : null);
  const context = {userDataDir:root,settings:{},runtimeId:'ruffle'};
  assert.equal(await Flash.ensureRuntime({runtimeId:'ruffle'},context),null);
  const plan = await Flash.ensureRuntime({runtimeId:'ruffle',runtimeData:{ruffle:{version:'2026.2.1'}}},context);
  assert.ok(plan,'A manual absent runtime still requests preparation');
});
