const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const Policy = require('../src/modules/android/launch-policy');

test('ART and JVM profile owners select the same verified common runtime independently of image execution', async t => {
  const signal = new AbortController().signal, context = { userDataDir: '/private/profile', signal, runtimeSettings: {} };
  const java = { javaPath: '/runtime/java' }, installed = { google: { enabled: false } };
  const profile = { processIdentityVersion: 1, lazyProfileServicesVersion: 1,
    platformServicesVersion: 1, systemServicesVersion: 1, sharedAccountsVersion: 1, frameworkServicesVersion: 1 };
  const common = { root: '/managed/common', runtimeIdentity: { platformHash: 'a'.repeat(64) },
    runtimeDeclaration: { files: [{ path: 'android-host.jar' }], manifestSha256: 'b'.repeat(64) }, profile };
  const art = { ...common, profile: { ...profile, artExecutionVersion: 1 } };
  let verified = 0;
  t.mock.method(require('../src/modules/android/runtime'), 'resolveForLaunch', async (options, identity) => {
    assert.deepEqual(options, { root: common.root, signal }); assert.equal(identity, common.runtimeDeclaration); verified++; return common;
  });
  t.mock.method(require('../src/modules/android/runtime'), 'resolveSelectedForLaunch', () => assert.fail('An in-flight common owner must retain the launch snapshot, independent of a new default'));
  t.mock.method(require('../src/modules/android/google-accounts'), 'selected', () => null);
  const platformPayload = await Policy.resolvePlatformRuntime({ context, payload: art });
  assert.equal(platformPayload, common); assert.equal(verified, 1);
  const native = Policy.serviceOptions({ context, payload: art, platformPayload, java, installed });
  const jvm = Policy.serviceOptions({ context, payload: common, java, installed });
  assert.deepEqual(native.platformOptions, jvm.platformOptions);
  assert.deepEqual(native.accountOptions, jvm.accountOptions);
  assert.equal(native.platformOptions.runtimeRoot, common.root);
  assert.equal(native.accountOptions.runtimeIdentity, common.runtimeIdentity);
  assert.equal(native.descriptorSender, path.join(art.root, 'native/android-supervisor-send'));
  assert.equal(native.processIdentityVersion, art.profile.processIdentityVersion);
  assert.deepEqual(Policy.platformServiceOptions({ context, payload: art, platformPayload, java }), {
    userDataDir: context.userDataDir, runtimeRoot: common.root, runtimeIdentity: common.runtimeIdentity,
    javaPath: java.javaPath, moduleRoot: path.resolve('src/modules/android')
  });
  const incompatible = { ...art, profile: { ...art.profile, processIdentityVersion: 0 } };
  assert.throws(() => Policy.serviceOptions({ context, payload: incompatible, platformPayload, java, installed }), /incompatible process identities/);
  await assert.rejects(Policy.resolvePlatformRuntime({ context, payload: incompatible }), /incompatible process identities/);
});

test('Common runtime verification failure prevents ART platform selection', async t => {
  const failure = Error('Runtime inventory mismatch');
  t.mock.method(require('../src/modules/android/runtime'), 'resolveForLaunch', async () => { throw failure; });
  await assert.rejects(Policy.resolvePlatformRuntime({ context: {}, payload: { root: '/managed/common', runtimeIdentity: {}, runtimeDeclaration: { files: [] }, profile: {} } }), error => error === failure);
  await assert.rejects(Policy.resolvePlatformRuntime({ context: {}, payload: { profile: {} } }), /runtime identity is unavailable/);
});
