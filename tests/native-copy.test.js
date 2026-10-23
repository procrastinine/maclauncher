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
  for (const name of ['bin', 'lib', 'licenses', 'data']) fs.mkdirSync(path.join(payload, name), { recursive: true });
  const executable = Buffer.alloc(32); executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(payload, 'bin/runner'), executable, { mode: 0o755 });
  const library = Buffer.from(executable); library.writeUInt32LE(6, 12);
  fs.writeFileSync(path.join(payload, 'lib/component.dylib'), library, { mode: 0o600 });
  fs.writeFileSync(path.join(payload, 'licenses/LICENSE'), 'Synthetic native fixture license', { mode: 0o640 });
  fs.writeFileSync(path.join(payload, 'data/.gitkeep'), '', { mode: 0o644 });
  const revision = 'a'.repeat(40), manifest = { schemaVersion: 1, managerId: 'fixture', version: '1.0', upstreamRevision: revision,
    platform: 'darwin', arch: 'arm64', minimumMacOS: '13.0', executableRelative: 'bin/runner', dependencies: [],
    provenance: { sourceRevision: revision }, notices: [{ name: 'Fixture', license: 'Test fixture', sourceUrl: 'https://example.invalid/source', path: 'licenses/LICENSE' }],
    files: B.fileInventory(payload).map(file => { const { bytes, ...record } = B.readRegular(path.join(payload, file), 1024); return { path: file, ...record,
      ...(/runner|dylib$/.test(file) ? { architectures: ['arm64'] } : {}) }; }) };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  fs.cpSync(sourceRoot, resourceRoot, { recursive: true });
  fs.chmodSync(path.join(resourceRoot, relative, 'files/lib/component.dylib'), 0o644);
  fs.chmodSync(path.join(resourceRoot, relative, 'files/licenses/LICENSE'), 0o644);
  fs.rmSync(path.join(resourceRoot, relative, 'files/data/.gitkeep'));
  const dependencies = { managers: () => new Map([['fixture', { id: 'fixture', core: { catalog: [{ version: '1.0', upstreamRevision: revision }] } }]]), supplementals: () => [] };
  return { sourceRoot, resourceRoot, architectures: ['arm64'], dependencies, manifest, relative };
}

test('native copy restoration preserves sealed restrictive modes and omitted regular resource markers before signing', t => {
  const f = fixture(t), before = B.fileInventory(f.sourceRoot).map(file => ({ file, ...B.readRegular(path.join(f.sourceRoot, file), 1024) }));
  assert.deepEqual(restoreCopiedNativePayload(f), { files: 5, restoredFiles: 1, restoredModes: 2 });
  assert.equal(B.verifyPayload(path.join(f.resourceRoot, f.relative, 'files'), f.manifest), true);
  for (const item of before) { const actual = B.readRegular(path.join(f.sourceRoot, item.file), 1024); assert.equal(actual.sha256, item.sha256); assert.equal(actual.mode, item.mode); }
  assert.deepEqual(restoreCopiedNativePayload(f), { files: 5, restoredFiles: 0, restoredModes: 0 });
});

test('native copy restoration refuses unlisted files, directories, links and changed copied bytes before any repair', t => {
  for (const kind of ['file', 'directory', 'link', 'bytes']) {
    const f = fixture(t), extra = path.join(f.resourceRoot, f.relative, 'unlisted');
    if (kind === 'file') fs.writeFileSync(extra, 'Unreviewed');
    if (kind === 'directory') fs.mkdirSync(extra);
    if (kind === 'link') fs.symlinkSync('manifest.json', extra);
    if (kind === 'bytes') fs.writeFileSync(path.join(f.resourceRoot, f.relative, 'files/licenses/LICENSE'), 'Changed fixture license');
    assert.throws(() => restoreCopiedNativePayload(f), /outside its sealed inventory|bytes or source permissions/);
    assert.equal(fs.existsSync(path.join(f.resourceRoot, f.relative, 'files/data/.gitkeep')), false);
  }
});
