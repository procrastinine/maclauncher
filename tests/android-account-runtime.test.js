const test = require('node:test'), assert = require('node:assert/strict');
const { resolveForAccounts } = require('../src/modules/android/account-runtime');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

test('an Android build without included metadata remains manageable and offline', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-optional-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const declarationFile = path.resolve(__dirname, '../src/modules/android/managed-packages.json');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    return path.resolve(String(file)) === declarationFile ? '[]' : read.call(this, file, ...args);
  });
  const Runtime = require('../src/modules/android/runtime');
  assert.equal(Runtime.readDeclaration({ optional: true }), null);
  assert.throws(() => Runtime.readDeclaration(), /metadata is missing/);
  const manager = require('../src/modules/android/runtime-manager').createManager();
  const selection = manager.resolveSelection(null, {}, root);
  assert.equal(selection.ready, false);
  // Discovery requires consent; a missing catalog never selects a package version.
  assert.equal(selection.version, null);
  assert.equal(selection.selectionRequired, true);
  assert.equal(selection.discoveryRequired, true);
  assert.equal(selection.install, null);
  assert.deepEqual(manager.getState({ userDataDir: root }).catalog.includedVersions, []);
});

test('missing account runtime prompts before network, discovers a managed build and resumes with its payload', async () => {
  const calls = [], context = { userDataDir: '/profile', settings: {}, onRuntimeStateChange: () => calls.push('state') };
  let version = null, ready = false;
  const manager = { id: 'android', label: 'MacLauncher Android',
    resolveSelection: () => ({ version, ready, install: ready ? { root: '/managed/runtime', declaration: { version } } : null, reason: 'Runtime unavailable' }),
    refreshCatalog: async () => { calls.push('catalog'); version = '1.0'; },
    installRuntime: async options => { calls.push(['install', options.version]); ready = true; } };
  const dependencies = { manager, confirmToolInstall: async (_context, plan) => calls.push(['consent', plan.requiresDownload]),
    withRuntimeMutation: async (_identity, operation) => operation(),
    resolveForLaunch: async (options, declaration) => ({ ...options, version: declaration.version }) };
  await assert.rejects(resolveForAccounts(context, {}, dependencies), /Runtime unavailable/);
  assert.deepEqual(calls, []);
  const payload = await resolveForAccounts(context, { install: true }, dependencies);
  assert.equal(payload.root, '/managed/runtime');
  assert.deepEqual(calls, [['consent', true], 'catalog', ['install', '1.0'], 'state']);
  calls.length = 0;
  await resolveForAccounts(context, { install: true }, dependencies);
  assert.deepEqual(calls, []);
});

test('declining account runtime installation does not refresh or install', async () => {
  await assert.rejects(resolveForAccounts({ userDataDir: '/profile' }, { install: true }, {
    manager: { resolveSelection: () => ({ ready: false }), refreshCatalog: () => assert.fail('No catalog before consent'), installRuntime: () => assert.fail('No install before consent') },
    confirmToolInstall: async () => { throw new Error('Installation canceled'); }
  }), /canceled/);
});

test('account setup prepares the selected image after verification while enumeration never prompts', async () => {
  const calls=[],payload={root:'/managed/exact-selected'},context={userDataDir:'/profile'};
  const dependencies={manager:{resolveSelection:()=>({ready:true,version:'selected',install:{root:payload.root,declaration:{version:'selected'}}})},
    resolveForLaunch:async()=>{calls.push('verified');return payload;},
    prepareRuntimeImage:async options=>{assert.equal(options.payload,payload);assert.equal(options.context,context);calls.push('image');}};
  assert.equal(await resolveForAccounts(context,{},dependencies),payload);assert.deepEqual(calls,['verified']);
  calls.length=0;assert.equal(await resolveForAccounts(context,{install:true},dependencies),payload);assert.deepEqual(calls,['verified','image']);
});
