const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawnSync} = require('node:child_process');

test('Native framework temporary files share the private process directory without relocating Metal caches', {
  skip: process.platform !== 'darwin',
}, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'android-native-storage-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const library = path.join(root, 'libandroid-storage.dylib'), probe = path.join(root, 'probe');
  const run = (command, args, options={}) => {
    const result = spawnSync(command, args, {encoding:'utf8', timeout:20000, ...options});
    assert.equal(result.error, undefined);assert.equal(result.status, 0, result.stdout+result.stderr);return result.stdout;
  };
  run('clang', ['-std=c11','-Wall','-Wextra','-Werror','-dynamiclib','-mmacosx-version-min=13.0',
    path.join(__dirname,'../src/modules/android/native/native-storage.c'),'-o',library]);
  run('clang', ['-fobjc-arc','-framework','Foundation',path.join(__dirname,'fixtures/android-sandbox/NativeStorageProbe.m'),'-o',probe]);
  const cache = run('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR']).trim();
  const base = {PATH:'/usr/bin:/bin', DYLD_INSERT_LIBRARIES:library};
  for (const suffix of ['', '/']) assert.match(run(probe,[cache],{env:{...base,TMPDIR:root+suffix}}),/PASS native temporary owner/);
  assert.match(run(probe,[cache],{env:base}),/PASS original fallback and errors/);
});
