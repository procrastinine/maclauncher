const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const Stage = require('../scripts/stage-native-runtimes.cjs');
const Native = require('../src/modules/shared/runtime/local-native');

test('selected native slices preserve original universal inputs and remain loadable with recorded identities', { skip: process.platform !== 'darwin' }, t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'native-slices-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.c'), original = path.join(root, 'original.dylib'), payload = path.join(root, 'payload');
  fs.writeFileSync(source, 'int native_value(void) { return 73; }\n'); fs.mkdirSync(payload);
  execFileSync('/usr/bin/clang', ['-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0', '-dynamiclib', source, '-o', original], { timeout: 30000, stdio: 'pipe' });
  const inputSha256 = Native.hashFile(original), inputBytes = fs.statSync(original).size;
  for (const architecture of ['arm64', 'x86_64']) {
    const file = path.join(payload, `${architecture}.dylib`); fs.copyFileSync(original, file); fs.chmodSync(file, 0o755);
    const record = Stage.thinStagedMachO(file, payload, architecture);
    assert.equal(record.beforeSha256, inputSha256); assert.equal(record.beforeBytes, inputBytes);
    assert.equal(record.afterSha256, Native.hashFile(file)); assert.equal(record.afterBytes, fs.statSync(file).size);
    assert.deepEqual(Native.readMachOArchitectures(file, { allowLibrary: true }), [architecture]);
    assert.equal(record.file, `${architecture}.dylib`); assert.ok(record.afterBytes < record.beforeBytes);
    assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    assert.equal(Stage.loadCommands(file).minimumMacOS, '13.0');
    assert.equal(Stage.thinStagedMachO(file, payload, architecture), null);
    assert.throws(() => Stage.thinStagedMachO(file, payload, architecture === 'arm64' ? 'x86_64' : 'arm64'), /no selected CPU/);
    assert.equal(Native.hashFile(file), record.afterSha256);
  }
  assert.equal(Native.hashFile(original), inputSha256);
  const hostSource = path.join(root, 'host.c'), host = path.join(root, 'host');
  fs.writeFileSync(hostSource, '#include <dlfcn.h>\nint main(int argc,char **argv){if(argc!=2)return 1;void *p=dlopen(argv[1],RTLD_NOW);if(!p)return 2;int(*f)(void)=dlsym(p,"native_value");return !f||f()!=73;}\n');
  execFileSync('/usr/bin/clang', ['-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=13.0', hostSource, '-o', host], { timeout: 30000, stdio: 'pipe' });
  execFileSync(host, [path.join(payload, `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.dylib`)], { timeout: 10000, stdio: 'pipe' });
  const failed = path.join(payload, 'failed.dylib'); fs.copyFileSync(original, failed);
  assert.throws(() => Stage.thinStagedMachO(failed, payload, 'arm64', () => { throw new Error('Slice extraction failed'); }), /Slice extraction failed/);
  assert.equal(Native.hashFile(failed), inputSha256); assert.ok(!fs.readdirSync(payload).some(name => name.startsWith('.thin-')));
  assert.throws(() => Stage.thinStagedMachO(original, payload, 'arm64'), /Unsafe.*path/);
  fs.symlinkSync(original, path.join(payload, 'external.dylib'));
  assert.throws(() => Stage.thinStagedMachO(path.join(payload, 'external.dylib'), payload, 'arm64'), /contained regular/);
  assert.throws(() => Stage.thinStagedMachO(failed, payload, 'unknown'), /explicit target CPU/);
});
