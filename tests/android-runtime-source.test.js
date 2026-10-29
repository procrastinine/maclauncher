const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Source = require('../src/modules/android/runtime-source');
const { execFileSync } = require('node:child_process');

test('Android source members use the supplied source owner and retain module identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-source-'));
  try {
    const directory = path.join(root, 'src/modules/android/art');
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'components.json');
    fs.writeFileSync(target, JSON.stringify({ linuxRun: 'host/linux-run' }));
    const options = { sourceRoot: root };
    assert.equal(Source.file('art/components.json', options), target);
    assert.equal(Source.moduleUrl('art/components.json', options), pathToFileURL(target).href);
    assert.deepEqual(Source.json('art/components.json', options), { linuxRun: 'host/linux-run' });
    for (const name of ['../other.json', '/absolute.json', 'art/../components.json', 'art\\components.json', 'art//components.json'])
      assert.throws(() => Source.file(name, options), /Invalid Android source member/);
    assert.throws(() => Source.file('art', options), /unavailable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the packaged Android metadata closure resolves without a source checkout or producers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-packaged-source-'));
  try {
    const repository = path.resolve(__dirname, '..');
    const pin = require('../src/modules/android/distribution-included.json').find(item => item.id === 'android-launcher');
    const packageRoot = path.join(root, 'src/resources/native-runtimes', pin.directoryRelative);
    assert.equal(require('../package.json').build.files.some(row => typeof row === 'object' && row.to === 'src/android-runtime'), false);
    for (const file of pin.files) {
      const destination = path.join(packageRoot, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(repository, 'src/resources/native-runtimes', pin.directoryRelative, file.path), destination);
      fs.chmodSync(destination, file.mode);
    }
    for (const name of ['runtime-source.js', 'included-files.js', 'distribution-included.json', 'apk.js', 'binary-manifest.js', 'profile.js', 'art/runtime.js', 'art/boot-classpath.mjs']) {
      const destination = path.join(root, 'src/modules/android', name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(repository, 'src/modules/android', name), destination);
    }
    for (const name of ['included-helpers.js', 'bundled-native.js', 'local-native.js', 'app-bundle.js', 'pe-exports.js']) {
      const destination = path.join(root, 'src/modules/shared/runtime', name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(repository, 'src/modules/shared/runtime', name), destination);
    }
    const result = JSON.parse(execFileSync(process.execPath, ['-e', `
      (async()=>{
      const Source=require('./src/modules/android/runtime-source');
      const Apk=require('./src/modules/android/apk');
      const Manifest=require('./src/modules/android/binary-manifest');
      const Profile=require('./src/modules/android/profile');
      const Art=require('./src/modules/android/art/runtime');
      const boot=await import('./src/modules/android/art/boot-classpath.mjs');
      console.log(JSON.stringify({root:Source.root(),apk:typeof Apk.inspectApk,
        manifest:typeof Manifest.readBinaryManifest,profile:typeof Profile.runtimeProfile,
        art:typeof Art.attachSupplier,linuxRun:Source.json('art/components.json').linuxRun,
        storageMappings:Source.json('native/resources/storage-namespace.json').mappings?.length,boot:boot.guestHooksArchive}));
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `], { cwd: root, encoding: 'utf8' }));
    assert.equal(result.root, fs.realpathSync(path.join(packageRoot, 'files/runtime')));
    assert.equal(result.apk, 'function');
    assert.equal(result.manifest, 'function');
    assert.equal(result.profile, 'function');
    assert.equal(result.art, 'function');
    assert.equal(result.linuxRun, 'host/linux-run');
    assert.equal(result.boot, '/system/framework/maclauncher.jar');
    assert.equal(fs.existsSync(path.join(root, 'src/external')), false);
    assert.equal(fs.existsSync(path.join(packageRoot, 'files/runtime/src/modules/android/native/build.mjs')), false);
    assert.equal(fs.existsSync(path.join(root, 'src/android-runtime')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
