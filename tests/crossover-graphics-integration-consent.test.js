const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { prepareForLaunch } = require('../src/core/runtime-preparation');
const Winemac = require('../src/modules/crossover/runtime/winemac');

const companion = { managerId: 'integration', version: '26.3.0-MCLv1', optional: true, silentFallback: true, companion: true,
  release: { version: '26.3', build: '26.3.0.39832' }, label: 'CrossOver graphics integration', bytes: 244068,
  summary: 'Adds Vulkan sharing.', cancelLabel: 'Play Without It', detail: 'Adds Vulkan sharing. Fixture also starts without it.' };
function harness({ plans, answers = [] }) {
  const dialogs = [], installs = [], skips = [];
  const manager = (id, label) => ({ id, label, getState: () => ({ installed: [] }), installRuntime() {},
    ...(id === 'integration' ? { skipOptional: (plan, options) => skips.push([plan.release, options.userDataDir]) } : {}) });
  const run = () => prepareForLaunch({ entry: { name: 'Fixture' }, mod: { getRuntimeRequirements: async () => plans }, info: {},
    context: { runtimeId: 'crossover', settings: { runtimes: {} }, userDataDir: '/profile',
      confirmRuntimeInstall: async plan => { dialogs.push(plan); return answers.length ? answers.shift() : true; } },
    registry: { listModuleIds: () => [], listSharedRuntimeManagers: () => [manager('engine', 'Engine'), manager('integration', 'Integration')] },
    install: async (item, payload) => { installs.push([item.id, payload.version]); } });
  return { run, dialogs, installs, skips };
}

test('an optional companion is listed with its version and size in the dialog of a required Play download', async () => {
  const accepted = harness({ plans: [companion, { managerId: 'engine', version: '2.0', label: 'Engine' }] });
  assert.equal(await accepted.run(), true);
  assert.equal(accepted.dialogs.length, 1, 'one dialog');
  assert.equal(accepted.dialogs[0].label, 'Engine');
  assert.deepEqual(accepted.dialogs[0].companions, [{ label: 'CrossOver graphics integration', versionLabel: '26.3.0-MCLv1', bytes: 244068, summary: 'Adds Vulkan sharing.' }]);
  assert.deepEqual(accepted.installs.map(([id]) => id).sort(), ['engine', 'integration']);
  const declined = harness({ plans: [{ managerId: 'engine', version: '2.0', label: 'Engine' }, companion], answers: [false] });
  assert.equal(await declined.run(), false, 'declining the required download cancels Play');
  assert.deepEqual([declined.dialogs.length, declined.installs, declined.skips], [1, [], []]);
});

test('an optional companion alone has its own dialog; declining it continues Play and is remembered once', async () => {
  const alone = harness({ plans: [companion], answers: [false] });
  assert.equal(await alone.run(), true, 'Play continues without it');
  assert.equal(alone.dialogs.length, 1);
  assert.equal(alone.dialogs[0].cancelLabel, 'Play Without It');
  assert.match(alone.dialogs[0].detail, /also starts without it/);
  assert.equal(alone.dialogs[0].companions, undefined);
  assert.deepEqual(alone.installs, []);
  assert.deepEqual(alone.skips, [[companion.release, '/profile']]);
  const failed = harness({ plans: [{ ...companion, version: null, discoveryRequired: true }] });
  assert.equal(await failed.run(), true, 'a failed discovery continues Play');
  assert.deepEqual(failed.skips, [[companion.release, '/profile']], 'and is remembered like a decline');
});

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crossover-graphics-integration-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const application = (build, extra = {}) => ({ version: `local-${build}`, upstreamVersion: '26.3', buildVersion: build, ready: true, ...extra });
const vulkan = { runtime: 'crossover', components: { 'vulkan-driver': { used: true } } };

test('the integration is offered per CrossOver release and build until declined, and Refresh offers it again', async t => {
  const userDataDir = scratch(t);
  let registered = [application('26.3.0.39832')], listed = 0;
  const manager = Winemac.create({ applications: () => { listed++; return registered; } });
  await manager.prune(userDataDir);
  assert.equal(listed, 0, 'with nothing installed or remembered, no CrossOver application is inspected');
  const context = install => ({ userDataDir, translatorPlan: vulkan, wineEnvironment: { install }, settings: { runtimes: {} } });
  const [plan] = await manager.requirements({ name: 'Fixture' }, context(registered[0]));
  assert.equal(plan.companion, true); assert.equal(plan.optional, true); assert.equal(plan.discoveryRequired, true);
  assert.equal(plan.cancelLabel, 'Play Without It');
  assert.deepEqual(plan.release, { version: '26.3', build: '26.3.0.39832' });
  assert.match(plan.detail, /^Adds Vulkan external memory, semaphore and fence sharing to CrossOver 26\.3 \(build 26\.3\.0\.39832\)\. Fixture also starts without it/);
  manager.skipOptional(plan, { userDataDir });
  assert.deepEqual(await manager.requirements({ name: 'Fixture' }, context(registered[0])), [], 'a declined release is not offered again');
  assert.equal((await manager.requirements({ name: 'Fixture' }, context(application('26.3.0.40000')))).length, 1, 'another build is offered');
  registered = [application('26.3.0.39832'), application('26.4.0.1', { ready: false })];
  await manager.prune(userDataDir);
  assert.deepEqual(await manager.requirements({ name: 'Fixture' }, context(registered[0])), [], 'an unavailable application keeps every remembered choice');
  registered = [application('26.3.0.40000')];
  await manager.prune(userDataDir);
  assert.equal((await manager.requirements({ name: 'Fixture' }, context(application('26.3.0.39832')))).length, 1,
    'a choice for a release that is no longer registered is forgotten');
  manager.skipOptional({ ...plan, release: { version: '26.3', build: '26.3.0.40000' } }, { userDataDir });
  manager.clearSkipped(userDataDir);
  assert.equal((await manager.requirements({ name: 'Fixture' }, context(registered[0]))).length, 1, 'an explicit Refresh offers it again');
  assert.deepEqual(await manager.requirements({ name: 'Fixture' }, { ...context(registered[0]), translatorPlan: { ...vulkan, components: {} } }), [],
    'a launch without the Vulkan driver needs no integration');
});

test('the Play download dialog lists each companion with version, size and what it adds', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const code = source.slice(source.indexOf('async function confirmRuntimeInstallation('), source.indexOf('\nfunction logRuntimeToolSpawn('));
  const shown = [];
  const context = { path, getLauncherDialogOwner: () => null, dialog: { showMessageBox: async options => { shown.push(options); return { response: 1 }; } } };
  vm.createContext(context); vm.runInContext(code, context);
  await context.confirmRuntimeInstallation({ label: 'DXVK', versionLabel: '2.7', companions: [{ label: 'CrossOver graphics integration',
    versionLabel: '26.3.0-MCLv1', bytes: 244068, summary: 'Adds Vulkan sharing.' }] }, { name: 'Fixture', gamePath: '/Fixture' });
  assert.equal(shown[0].message, 'Download DXVK 2.7?');
  assert.equal(shown[0].detail, 'Required to run Fixture.\n\nAlso downloads CrossOver graphics integration 26.3.0-MCLv1 (0.2 MB). Adds Vulkan sharing.');
  await context.confirmRuntimeInstallation({ label: 'CrossOver graphics integration', versionLabel: '26.3.0-MCLv1', cancelLabel: 'Play Without It',
    detail: 'Adds Vulkan sharing. Fixture also starts without it.' }, { name: 'Fixture' });
  assert.deepEqual(Array.from(shown[1].buttons), ['Download and Play', 'Play Without It']);
  assert.equal(shown[1].detail, 'Adds Vulkan sharing. Fixture also starts without it.');
});
