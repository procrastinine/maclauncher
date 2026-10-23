const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Bootstrap = require('../src/modules/android/bionic-bootstrap');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'android-bionic-scope-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime'), directory = path.join(runtimeRoot, 'native/bionic');
  fs.mkdirSync(directory, { recursive: true });
  const options = { config: { runtimeRoot, nativeRoot: path.join(root, 'arm64-v8a') } };
  return { root, directory, options, profile(value) { fs.writeFileSync(path.join(directory, 'profile.json'), JSON.stringify(value)); } };
}

test('JVM builds without a native profile and original ARM32 launches need no image preparation', async t => {
  const { options, directory, profile } = fixture(t);
  assert.equal(await Bootstrap.prepare({ config: {} }), null);
  assert.equal(await Bootstrap.prepare(options), null);
  profile({ schemaVersion: 999 });
  assert.equal(await Bootstrap.prepare({ ...options, config: { ...options.config, nativeRoot: '/runtime/armeabi-v7a' } }), null);
  assert.deepEqual(fs.readdirSync(directory), ['profile.json']);
});

test('native preparation rejects linked profiles and execution helpers outside the selected runtime', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside');
  fs.writeFileSync(outside, 'not executable');
  fs.symlinkSync(outside, path.join(f.directory, 'profile.json'));
  await assert.rejects(Bootstrap.prepare(f.options), /profile is invalid/);
  fs.unlinkSync(path.join(f.directory, 'profile.json'));
  fs.symlinkSync(outside, path.join(f.directory, 'helper'));
  f.profile({ schemaVersion: 1, nativeAbi: 'arm64-v8a', inodeBootstrap: 'native/bionic/helper', inodeBootstrapSha256: crypto.createHash('sha256').update('not executable').digest('hex') });
  await assert.rejects(Bootstrap.prepare(f.options), /outside its runtime/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'not executable');
});

test('native preparation rejects traversal and changed helper bytes before creating app state or preparing an image', async t => {
  const f = fixture(t), profile = { schemaVersion: 1, nativeAbi: 'arm64-v8a', inodeBootstrap: 'native/bionic/../../helper', inodeBootstrapSha256: '0'.repeat(64) };
  f.profile(profile);
  await assert.rejects(Bootstrap.prepare(f.options), /helper path is invalid/);
  fs.writeFileSync(path.join(f.directory, 'helper'), 'changed');
  f.profile({ ...profile, inodeBootstrap: 'native/bionic/helper' });
  await assert.rejects(Bootstrap.prepare(f.options), /storage helper is invalid/);
  assert.deepEqual(fs.readdirSync(f.root), ['runtime']);
});
