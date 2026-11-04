const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process'), asar = require('@electron/asar');
const { image, X64 } = require('./fixtures/macho-image');
const pkg = require('../package.json'), script = path.resolve(__dirname, '../scripts/output-warnings.cjs');
function write(root, file, bytes, mode = 0o644) {
  const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { mode }); return target;
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-symptoms-')), app = path.join(root, 'Example.app'), source = path.join(root, 'source');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(app, 'Contents/Info.plist', require('plist').build({ CFBundleShortVersionString: pkg.version, CFBundleDisplayName: pkg.build.productName,
    CFBundleIdentifier: pkg.build.appId, LSMinimumSystemVersion: pkg.build.mac.minimumSystemVersion, CFBundleExecutable: 'runner' }));
  write(source, 'package.json', JSON.stringify({ version: pkg.version, productName: pkg.productName }));
  await asar.createPackage(source, path.join(app, 'Contents/Resources/app.asar'));
  return { root, app, run: zip => spawnSync(process.execPath, [script, app, 'arm64', ...(zip ? [zip] : [])], { encoding: 'utf8' }) };
}
test('output symptoms warn without an expected file list or a failing exit', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  write(f.app, 'Contents/MacOS/runner', image({ cpu: X64, fileType: 2, minimumOS: 0x001b0000, dependencies: ['/outside/output/library.dylib'] }), 0o755);
  write(f.app, 'Contents/Resources/tests/private.js', 'duplicate'); write(f.app, 'Contents/Resources/copy.txt', 'duplicate');
  write(f.app, 'Contents/Resources/python/runtime.json', JSON.stringify({ publisher: 'astral-sh/python-build-standalone' }));
  write(f.app, 'Contents/Resources/python/bin/python3', 'interpreter'); write(f.app, 'Contents/Resources/python/bin/python', 'wrong alias');
  const expected = Buffer.from('original'), base = 'Contents/Resources/native-runtimes';
  write(f.app, base + '/example/engine', 'modified');
  write(f.app, base + '/.declarations/generated.json', JSON.stringify({ id: 'example', directoryRelative: 'example', files: [
    { path: 'engine', mode: 0o644, size: expected.length, sha256: crypto.createHash('sha256').update(expected).digest('hex') },
    { path: 'missing', mode: 0o644, size: 0, sha256: crypto.createHash('sha256').update('').digest('hex') }
  ] }));
  const info = path.join(f.app, 'Contents/Info.plist');
  execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleShortVersionString', '-string', 'other-version', info]);
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  for (const symptom of ['Identical files', 'test directory or fixture', 'no arm64 slice', 'minimum macOS exceeds', 'Invalid or missing code signature',
    'App version mismatch', 'Embedded Python interpreter', 'Embedded Python alias', 'Package file differs', 'Package file missing', 'Library outside output'])
    assert.ok(result.stdout.includes('::warning::') && result.stdout.includes(symptom), symptom + '\n' + result.stdout);
  assert.equal(result.stderr, '');
});
test('release ZIP diagnostics compare actual app bytes and detect later changes without failing', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), archive = path.join(f.root, 'output.zip');
  write(f.app, 'Contents/MacOS/runner', 'not a native fixture', 0o755);
  write(f.app, 'Contents/Resources/ordinary.txt', 'before');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', f.app, archive]);
  const same = f.run(archive); assert.equal(same.status, 0, same.stderr); assert.doesNotMatch(same.stdout, /Release ZIP .*differ|Release ZIP missing/);
  write(f.app, 'Contents/Resources/ordinary.txt', 'after');
  const changed = f.run(archive); assert.equal(changed.status, 0, changed.stderr); assert.match(changed.stdout, /::warning::Release ZIP bytes or permissions differ.*ordinary\.txt/);
});
