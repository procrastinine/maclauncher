const test = require('node:test'), assert = require('node:assert/strict');
const { resolveForAccounts } = require('../src/modules/android/account-runtime');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

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
