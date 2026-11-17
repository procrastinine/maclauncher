const test = require('node:test'), assert = require('node:assert/strict');
const { prepareForLaunch } = require('../src/core/runtime-preparation');
const { confirmToolInstall } = require('../src/modules/shared/runtime/tool-install');
const terms = 'https://developer.android.com/studio/terms';
const image = { managerId: 'android-system-image', label: 'Android system image if required by the selected runtime', licenseRequired: true, licenseUrl: terms };

async function preparation({ companion = image, answer = { approved: true, licenseAccepted: true }, later = image } = {}) {
  const shown = [], installed = [], managers = ['host', 'reader'].map(id => ({ id, label: id, installRuntime() {}, getState: () => ({ installed: [], catalog: {} }) }));
  const context = { userDataDir: '/test-launcher-data', runtimeId: 'native', settings: { runtimes: {} },
    confirmRuntimeInstall: async plan => { shown.push(plan); return answer; } };
  const mod = { runtimeManagers: managers,
    ensureRuntime: () => ({ managerId: 'host', version: '1', companions: [companion] }),
    getRuntimeRequirements: () => [{ managerId: 'reader', version: '2' }],
    prepareLaunch: async () => {
      const plan = { ...later, version: 'profile-selected-content', requiresDownload: true };
      if (later.kind === 'licence' || later.optional) await context.confirmRuntimeInstall(plan);
      else await confirmToolInstall(context, plan);
    } };
  const result = await prepareForLaunch({ entry: {}, mod, info: { runtime: {} }, context,
    registry: { listModuleIds: () => ['host'], getModule: () => mod }, install: async (manager, payload) => installed.push([manager.id, payload.version]) });
  return { result, context, shown, installed };
}

test('a required image discovered after installation uses only the exact companion terms accepted in the first Play dialog', async () => {
  const f = await preparation();
  assert.equal(f.result, true);
  assert.equal(f.shown.length, 1, 'the later profile-selected image is covered by the named terms');
  assert.ok(f.shown[0].companions.some(row => row.managerId === image.managerId && row.licenseUrl === terms));
  assert.ok(f.shown[0].companions.some(row => row.label === 'reader'), 'the normal required download stays listed too');
  assert.deepEqual(f.installed, [['host', '1'], ['reader', '2']], 'the conditional companion is not installed before its exact profile is known');
  assert.deepEqual(await f.context.confirmRuntimeInstall({ ...image, requiresDownload: true }), { approved: true, licenseAccepted: true });
  assert.equal(f.shown.length, 1);
});

test('the existing Play dialog names conditional SDK terms and returns explicit terms acceptance', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), f = await preparation();
  const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const code = source.slice(source.indexOf('async function confirmRuntimeInstallation('), source.indexOf('\nfunction logRuntimeToolSpawn('));
  const shown = [], boundary = { path, getLauncherDialogOwner: () => null,
    dialog: { showMessageBox: async options => { shown.push(options); return { response: 0 }; } } };
  vm.createContext(boundary);vm.runInContext(code, boundary);
  const answer = await boundary.confirmRuntimeInstallation(f.shown[0], { name: 'Application' });
  assert.equal(shown.length, 1);assert.equal(shown[0].buttons[0], 'Agree, Download and Play');
  assert.ok(shown[0].detail.includes(image.label));assert.ok(shown[0].detail.includes(terms));
  assert.deepEqual(JSON.parse(JSON.stringify(answer)), { approved: true, licenseAccepted: true });
});

test('a different manager or terms, a licence sheet, and an optional offer retain their own consent', async () => {
  for (const later of [{ ...image, managerId: 'different-image' }, { ...image, licenseUrl: terms + '?revision=2' },
    { ...image, kind: 'licence' }, { ...image, optional: true }]) {
    const f = await preparation({ later });
    assert.equal(f.shown.length, 2);
  }
});

test('an approval without explicit terms acceptance cannot cover later licensed downloads', async () => {
  for (const answer of [true, { approved: true, licenseAccepted: false }]) assert.equal((await preparation({ answer })).shown.length, 2);
});

test('a declined companion and a download declined in this Play cannot inherit terms approval', async () => {
  const unchecked = await preparation({ companion: { ...image, checkboxLabel: 'Also install the image' }, answer: { approved: true, licenseAccepted: true, companionsDeclined: true } });
  assert.equal(unchecked.shown.length, 2);
  const f = await preparation();
  (f.context.declinedChoices ||= new Set()).add('download:' + image.managerId);
  await f.context.confirmRuntimeInstall({ ...image, requiresDownload: true });
  assert.equal(f.shown.length, 2);
});

test('Klepton keeps its existing requirements and names conditional SDK terms without guessing an image version', async t => {
  const Custom = require('../src/modules/android/custom-main'), Main = require('../src/modules/android/main');
  const expected = [{ managerId: 'vulkan', version: 'selected' }];
  t.mock.method(Custom, 'getRuntimeRequirements', () => expected);
  assert.deepEqual(Main.getRuntimeRequirements({}, { runtimeId: 'klepton' }), expected);
  const manager = require('../src/modules/android/runtime-manager');
  t.mock.method(manager, 'resolveSelection', () => ({ ready: false, version: null, discoveryRequired: true }));
  const plan = Custom.ensureRuntime({}, { runtimeId: 'klepton' });
  assert.equal(plan.version, null);
  assert.equal(plan.discoveryRequired, true);
  assert.deepEqual(plan.companions, [image]);
});
