const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createLauncher} = require('../src/core/launcher');
const Host = require('../src/modules/android/host');
const Policy = require('../src/modules/android/launch-policy');
const manifest = require('../src/modules/android/manifest.json');

function fixture(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-execution-'));
  t.after(() => fs.rmSync(userDataDir, {recursive:true, force:true}));
  const registry = {listModules:() => [manifest], getModuleInfo:() => manifest,
    getModule:() => ({id:'android', manifest})};
  return {userDataDir, launcher:createLauncher({userDataDir, registry}),
    entry:{moduleId:'android', gameId:'same-profile', gamePath:path.join(userDataDir, 'original.apk'), runtimeId:'klepton'}};
}

const java = {line:21, variant:'arm64', version:'21.fixture', javaPath:'/installed/java/bin/java', installDir:'/installed/java'};
const manager = {id:'java', normalizeSettings:() => ({lines:{21:{defaultVersion:null}}}),
  core:{java:{resolveBestInstalled:() => java}}};

test('Android execution settings reach actual JVM/ART package preparation without changing app storage', async t => {
  const {userDataDir, launcher, entry} = fixture(t);
  const schema = manifest.runtime.entries.klepton.settings;
  assert.equal(schema.defaults.execution, 'jvm');
  assert.equal(schema.fields[0].key, 'execution');
  assert.deepEqual(schema.fields[0].options.map(option => option.value), ['jvm', 'art']);
  const payload = {root:path.join(userDataDir, 'verified-runtime'), profile:{}};
  const cases = [
    {global:undefined, game:undefined, expected:'jvm'},
    {global:'art', game:undefined, expected:'art'},
    {global:'art', game:'jvm', expected:'jvm'},
    {global:'jvm', game:'art', expected:'art'}
  ];
  const preparation = Error('package preparation reached'), observed = [];
  t.mock.method(require('../src/modules/android/art/runtime'), 'resolve', () => ({components:{}, manifest:{android:{architectures:['arm64-v8a']}}}));
  t.mock.method(Host, 'ensureJava', async () => java);
  for (const row of cases) {
    const actualEntry = {...entry, ...(row.game ? {runtimeSettings:{klepton:{execution:row.game}}} : {})};
    const settings = row.global ? {modules:{android:{runtimeSettings:{klepton:{execution:row.global}}}}} : {};
    const context = launcher.getLaunchContext(actualEntry, settings);
    assert.equal(context.runtimeSettings.execution, row.expected);
    assert.equal(Policy.execution(context), row.expected);
    await assert.rejects(Host.launch(actualEntry, context, payload, {manager,
      resolveVulkan:async () => ({}), resolvePlatformRuntime:async () => payload,
      prepare:async (selectedEntry, options) => {
        observed.push({execution:options.execution ?? 'jvm', userDataDir:options.userDataDir, gameId:selectedEntry.gameId});
        throw preparation;
      }}), error => error === preparation);
    assert.deepEqual(actualEntry.runtimeSettings, row.game ? {klepton:{execution:row.game}} : undefined);
    assert.equal(fs.existsSync(path.join(userDataDir, 'android')), false, 'Routing alone does not prepare or rewrite application data');
  }
  assert.deepEqual(observed, cases.map(({expected}) => ({execution:expected, userDataDir, gameId:entry.gameId})));
});

test('Absent direct execution defaults to JVM and invalid execution fails before preparation', async () => {
  assert.equal(Policy.execution(), 'jvm');
  assert.equal(Policy.execution({runtimeSettings:{}}), 'jvm');
  await assert.rejects(Host.launch({}, {runtimeSettings:{execution:'unknown'}}, {}, {
    prepare:async () => assert.fail('Unknown execution must not prepare an APK')
  }), /execution engine is unsupported/);
});

test('Only ART adds its exact managed supplier to ordinary consent and installation planning', async t => {
  const {launcher, entry, userDataDir} = fixture(t);
  const Module = require('../src/modules/android/main');
  const Common = require('../src/modules/android/runtime-manager');
  const Art = require('../src/modules/android/art/runtime-manager');
  const {prepareForLaunch} = require('../src/core/runtime-preparation');
  t.mock.method(Common, 'resolveSelection', () => ({ready:true}));
  t.mock.method(Art.manager, 'resolveSelection', () => ({ready:false, version:'1.2.3', install:null}));
  const registry = {listModuleIds:() => ['android'], getModule:() => Module};
  const events = [];
  const context = launcher.getLaunchContext(entry, {});
  context.confirmRuntimeInstall = async plan => {events.push(['consent', plan.managerId, plan.version]); return false;};
  const prepare = () => prepareForLaunch({entry, mod:Module, info:manifest, context, registry,
    runAction:() => assert.fail('No game or original runtime is executed'),
    install:async (manager, plan) => events.push(['install', manager.id, plan.version])});
  assert.equal(await prepare(), true);
  assert.deepEqual(events, [], 'Default JVM has no ART download or setup requirement');
  context.runtimeSettings.execution = 'art';
  assert.equal(await prepare(), false);
  assert.deepEqual(events, [['consent', 'android-art', '1.2.3']]);
  assert.equal(fs.existsSync(path.join(userDataDir, 'android')), false, 'Declining setup leaves all application storage untouched');
  events.length = 0;
  context.confirmRuntimeInstall = async plan => {events.push(['consent', plan.managerId, plan.version]); return true;};
  assert.equal(await prepare(), true);
  assert.deepEqual(events, [['consent', 'android-art', '1.2.3'], ['install', 'android-art', '1.2.3']]);
  assert.deepEqual(Module.getRuntimeRequirements(entry, {...context, runtimeId:'macapk'}), [], 'Optional providers keep their own runtime selection');
});

function descriptor(root) {
  const definition = require('../src/modules/android/art/supplier.json');
  const components = Object.fromEntries(Object.keys(require('../src/modules/android/art/components.json')).map(name => [name, path.join(root, name)]));
  components.image = path.join(root, '..', 'verified-original-image');
  const manifest = {schemaVersion:1, execution:'art', supplier:definition.id, hostcallVersion:definition.hostcallVersion,
    android:definition.android, bootClasspath:['/apex/com.android.art/javalib/core-oj.jar']};
  return {root, manifest, components, bootClasspath:manifest.bootClasspath};
}

test('ART launch retains the selected common platform and attaches only its verified separate supplier', async t => {
  const {launcher, entry, userDataDir} = fixture(t);
  const Module = require('../src/modules/android/main');
  const Common = require('../src/modules/android/runtime-manager'), Runtime = require('../src/modules/android/runtime');
  const Art = require('../src/modules/android/art/runtime-manager'), ArtRuntime = require('../src/modules/android/art/runtime');
  const common = {root:path.join(userDataDir, 'selected-common'), profile:{processIdentityVersion:1}, runtimeIdentity:{manifestSha256:'a'.repeat(64)}};
  const supplier = descriptor(path.join(userDataDir, 'selected-art'));
  const declaration = {version:'common-explicit', manifestSha256:'a'.repeat(64)};
  t.mock.method(Common, 'resolveSelection', () => ({ready:true, version:declaration.version, install:{root:common.root, installDir:common.root, declaration}}));
  t.mock.method(Runtime, 'resolveForLaunch', async (options, selected) => {assert.equal(options.root, common.root);assert.equal(selected, declaration);return common;});
  let supplierResolutions = 0;
  t.mock.method(Art, 'resolveForLaunch', async () => {supplierResolutions++;return supplier;});
  const context = launcher.getLaunchContext({...entry, runtimeSettings:{klepton:{execution:'art'}}}, {}), leases = [];
  context.useRuntime = async lease => leases.push(lease);
  const child = {pid:1};
  t.mock.method(Host, 'launch', async (_entry, actualContext, actualPayload, dependencies) => {
    assert.equal(actualContext, context);assert.equal(actualPayload.root, common.root);
    assert.equal(actualPayload.runtimeIdentity, common.runtimeIdentity);
    assert.equal(actualPayload.profile.artExecutionVersion, 1);
    assert.equal(ArtRuntime.resolve(actualPayload).components.image, supplier.components.image);
    assert.equal(await dependencies.resolvePlatformRuntime(), common, 'ART services keep the explicit common selection, rather than silently resolving the included default');
    return child;
  });
  assert.equal(await Module.launchRuntime('klepton', entry, context), child);
  assert.equal(supplierResolutions, 1);
  assert.deepEqual(leases, [{managerId:'android', version:declaration.version, sourcePath:common.root}]);
  assert.equal(common.profile.artExecutionVersion, undefined, 'Enabling ART does not mutate the verified common profile');
  assert.throws(() => ArtRuntime.resolve({...common, artSupplier:supplier}), /not included/, 'Imported metadata cannot attach an unverified supplier');
});

test('Managed ART verifies and leases owned code before image acquisition; failure cannot activate a supplier', async t => {
  const {launcher, entry, userDataDir} = fixture(t);
  const Art = require('../src/modules/android/art/runtime-manager'), Verifier = require('../src/modules/android/runtime-verifier');
  const install = {root:path.join(userDataDir, 'owned-art'), installDir:path.join(userDataDir, 'owned-art-install'), declaration:{manifestSha256:'b'.repeat(64)}};
  t.mock.method(Art.manager, 'resolveSelection', () => ({ready:true, version:'art-explicit', install}));
  const context = launcher.getLaunchContext(entry, {}), events = [];
  context.useRuntime = async lease => events.push(['lease', lease]);
  t.mock.method(Verifier, 'verifyPayload', async (root, declaration) => {assert.equal(root, install.root);assert.equal(declaration, install.declaration);events.push(['verify']);});
  const supplier = descriptor(path.join(userDataDir, 'art'));
  assert.equal(await Art.resolveForLaunch(entry, context, {prepareSupplier:async options => {
    assert.equal(options.install, install);assert.equal(options.context, context);events.push(['image']);return supplier;
  }}), supplier);
  assert.deepEqual(events, [['lease', {managerId:'android-art', version:'art-explicit', sourcePath:install.installDir}], ['verify'], ['image']]);
  const failure = Error('Owned ART payload changed');
  t.mock.method(Verifier, 'verifyPayload', async () => {throw failure;});
  await assert.rejects(Art.resolveForLaunch(entry, context, {prepareSupplier:async () => assert.fail('Changed code must not acquire or activate an image')}), error => error === failure);
});

test('ART sandbox binds separate immutable supplier/image roots without exposing their parent or sibling data', async t => {
  const {userDataDir} = fixture(t), root = fs.realpathSync(userDataDir);
  const {prepareIsolation} = await import('../src/modules/android/art/isolation.mjs');
  const names = ['common','owned-art/art','owned-art/native/SDL3.framework','images/selected','images/other','prepared','session','data','graphics'];
  for (const name of names) fs.mkdirSync(path.join(root, name), {recursive:true});
  const supplied = descriptor(path.join(root, 'owned-art/art'));
  supplied.packageRoot = path.join(root, 'owned-art');
  supplied.components.image = path.join(root, 'images/selected');
  supplied.components.linuxRun = '/bin/cat';
  const result = await prepareIsolation({supplier:supplied, payload:{root:path.join(root, 'common'), profile:{}},
    directory:path.join(root, 'session'), dataRoot:path.join(root, 'data'), userDataDir:root,
    prepared:{root:path.join(root, 'prepared')}, sharedGraphics:path.join(root, 'graphics'), binderName:'fixture.art', blockNetwork:true});
  const policy = fs.readFileSync(result.prefix[1], 'utf8');
  for (const code of ['common','owned-art','owned-art/art','images/selected','prepared']) {
    assert.ok(policy.includes('(subpath '+JSON.stringify(path.join(root, code))+')'));
    assert.ok(policy.includes('(allow process-exec (subpath '+JSON.stringify(path.join(root, code))+'))'));
  }
  for (const denied of [path.join(root, 'images'), path.join(root, 'images/other')])
    assert.ok(!policy.includes('(subpath '+JSON.stringify(denied)+')'));
  assert.ok(!policy.includes('(allow process-exec (subpath '+JSON.stringify(path.join(root, 'data'))+'))'));
  assert.match(policy, /\(deny network\*\)/);
  if (process.platform === 'darwin' && process.env.RUN_MACOS_SANDBOX === '1') {
    const {spawnSync} = require('node:child_process');
    for (const name of ['owned-art/native/SDL3.framework','images/selected','images/other']) fs.writeFileSync(path.join(root, name, 'marker'), name);
    for (const [name, permitted] of [['owned-art/native/SDL3.framework',true],['images/selected',true],['images/other',false]]) {
      const child = spawnSync(result.command, [...result.prefix, '/bin/cat', path.join(root, name, 'marker')], {encoding:'utf8'});
      assert.ifError(child.error);
      assert.equal(child.status === 0, permitted, child.stderr);
      if (permitted) assert.equal(child.stdout, name);
    }
  }
});
