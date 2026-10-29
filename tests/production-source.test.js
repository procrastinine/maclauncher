const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Production = require('../src/modules/shared/runtime/production-source');
const Content = require('../scripts/runtime-content.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-source-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); return target; };
  return { root, put };
}
test('production projection preserves build inputs and notices without following symlink directories', t => {
  const { root, put } = fixture(t);
  put('source/src/runtime.c', 'int run(void) { return 1; }');
  put('source/LICENSE', 'license'); put('source/Cargo.lock', 'locked dependency');
  put('source/Cargo.toml', '[package]\nname="production"\n[[test]]\nname="gpu"\npath="tests/gpu.rs"\n[dependencies]\nserde="1"\n');
  put('source/tests/gpu.rs', 'test'); put('source/native/image-test.mm', 'test');
  put('outside/tests/saved', 'untouched');
  fs.symlinkSync('../outside', path.join(root, 'source/link'));
  const profile = Production.prune(path.join(root, 'source'));
  assert.deepEqual(profile.removed, ['native/image-test.mm', 'tests']);
  assert.equal(fs.readFileSync(path.join(root, 'source/Cargo.toml'), 'utf8'), '[package]\nname="production"\n[dependencies]\nserde="1"\n');
  assert.equal(fs.readFileSync(path.join(root, 'source/Cargo.lock'), 'utf8'), 'locked dependency');
  assert.equal(fs.readFileSync(path.join(root, 'source/LICENSE'), 'utf8'), 'license');
  assert.equal(fs.readFileSync(path.join(root, 'outside/tests/saved'), 'utf8'), 'untouched');
  assert.equal(profile.manifests.length, 1);
});
test('actual source archive projection preserves the input and removes test archive members', t => {
  const { root, put } = fixture(t);
  put('input/source/main.cpp', 'runtime'); put('input/source/tests/test.cpp', 'test'); put('input/source/LICENSE', 'notice');
  const source = path.join(root, 'original.tar.gz'), output = path.join(root, 'production.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', source, '-C', path.join(root, 'input'), '.']);
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before = digest(source);
  const profile = Production.projectArchive(source, output);
  assert.equal(fs.readFileSync(output).readUInt32LE(4), 0, 'the gzip header does not depend on the current second');
  const entries = execFileSync('/usr/bin/tar', ['-tzf', output], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(digest(source), before); assert.equal(profile.inputSha256, before);
  assert.ok(entries.some(name => name.endsWith('/main.cpp')));
  assert.ok(entries.some(name => name.endsWith('/LICENSE')));
  assert.ok(entries.some(name => name.endsWith('/PRODUCTION_SOURCE_PROFILE.json')));
  assert.deepEqual(entries.filter(name => Content.excludedReason(name)), []);
  const repeated = path.join(root, 'repeated.tar.gz');
  Production.projectArchive(source, repeated);
  assert.equal(digest(repeated), digest(output), 'identical source input produces identical projection bytes');
  const Check = require('../scripts/check-packaging.cjs');
  assert.throws(() => Check.inspectSourceArchive(source), /Runtime content excludes/);
  assert.equal(Check.inspectSourceArchive(output).entries, entries.length);
});
