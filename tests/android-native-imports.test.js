const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Android native barriers synchronize memory and checked strl functions enforce object bounds', t => {
  if (process.platform !== 'darwin') return t.skip('Requires Darwin pthread and strl functions');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-native-imports-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const binary = path.join(temporary, 'probe');
  const compile = spawnSync('clang', ['-std=c11', '-O2', '-Wall', '-Wextra',
    '-I' + path.resolve(__dirname, '../src/modules/android/native'),
    path.join(__dirname, 'fixtures/android-native-imports/probe.c'), '-o', binary], { encoding: 'utf8', timeout: 30000 });
  assert.equal(compile.error, undefined, compile.error?.message);
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS .*8000 waits.*FORTIFY rejection before writes/);
});


test('Android libc adapters preserve conversion, checked I/O and LP64 batch socket ownership', t => {
  if (process.platform !== 'darwin') return t.skip('Requires Darwin libc');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'android-libc-imports-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const binary = path.join(temporary, 'probe');
  const compile = spawnSync('clang', ['-std=c11', '-O2', '-Wall', '-Wextra',
    '-I' + path.resolve(__dirname, '../src/modules/android/native'),
    path.join(__dirname, 'fixtures/android-native-imports/libc-probe.c'),
    path.resolve(__dirname, '../src/modules/android/native/poll-bridge.c'), '-liconv', '-lz', '-o', binary], { encoding: 'utf8', timeout: 30000 });
  assert.equal(compile.error, undefined, compile.error?.message);
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS libc conversion, checked I\/O, LP64 batch messages and immediate exit/);
});
