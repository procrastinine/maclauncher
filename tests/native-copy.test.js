const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const B = require('../src/modules/shared/runtime/bundled-native');
const { restoreCopiedNativePayload } = require('../scripts/native-copy.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'native-copy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'), resourceRoot = path.join(root, 'copied'), relative = 'fixture/1.0/arm64';
  const directory = path.join(sourceRoot, relative), payload = path.join(directory, 'files');
  for (const name of ['bin', 'lib', 'licenses']) fs.mkdirSync(path.join(payload, name), { recursive: true });
  const executable = Buffer.alloc(32); executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(payload, 'bin/runner'), executable, { mode: 0o755 });
  const library = Buffer.from(executable); library.writeUInt32LE(6, 12);
  fs.writeFileSync(path.join(payload, 'lib/component.dylib'), library, { mode: 0o600 });
  fs.writeFileSync(path.join(payload, 'licenses/LICENSE'), 'Synthetic native fixture license', { mode: 0o640 });
  fs.writeFileSync(path.join(directory, 'manifest.json'), '{}');
  fs.cpSync(sourceRoot, resourceRoot, { recursive: true });
  fs.chmodSync(path.join(resourceRoot, relative, 'files/lib/component.dylib'), 0o644);
  fs.chmodSync(path.join(resourceRoot, relative, 'files/licenses/LICENSE'), 0o644);
  return { sourceRoot, resourceRoot, relative };
}

test('native copy restoration preserves restrictive source modes without changing copied bytes', t => {
  const f = fixture(t), before = B.fileInventory(f.sourceRoot).map(file => ({ file, ...B.readRegular(path.join(f.sourceRoot, file), 1024) }));
  assert.deepEqual(restoreCopiedNativePayload(f), { files: 4, restoredFiles: 0, restoredModes: 2 });
  assert.deepEqual(fs.readFileSync(path.join(f.resourceRoot, f.relative, 'files/lib/component.dylib')), fs.readFileSync(path.join(f.sourceRoot, f.relative, 'files/lib/component.dylib')));
  for (const item of before) { const actual = B.readRegular(path.join(f.sourceRoot, item.file), 1024); assert.equal(actual.sha256, item.sha256); assert.equal(actual.mode, item.mode); }
  assert.deepEqual(restoreCopiedNativePayload(f), { files: 4, restoredFiles: 0, restoredModes: 0 });
});

test('native copy restoration uses actual copied paths, retains extra bytes and restores relative aliases', t => {
  const f = fixture(t), source = path.join(f.sourceRoot, f.relative, 'files/lib'), target = path.join(f.resourceRoot, f.relative, 'files/lib');
  fs.symlinkSync('component.dylib', path.join(source, 'alias.dylib'));
  fs.writeFileSync(path.join(target, 'alias.dylib'), 'Builder copied this alias as a regular file');
  fs.writeFileSync(path.join(target, 'unlisted'), 'keep copied bytes');
  fs.writeFileSync(path.join(target, 'component.dylib'), 'copied native bytes');
  restoreCopiedNativePayload(f);
  assert.equal(fs.readlinkSync(path.join(target, 'alias.dylib')), 'component.dylib');
  assert.equal(fs.readFileSync(path.join(target, 'component.dylib'), 'utf8'), 'copied native bytes');
  assert.equal(fs.readFileSync(path.join(target, 'unlisted'), 'utf8'), 'keep copied bytes');
  assert.equal(fs.readlinkSync(path.join(source, 'alias.dylib')), 'component.dylib');
});
