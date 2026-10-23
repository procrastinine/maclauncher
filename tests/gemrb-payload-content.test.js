const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const B = require('../src/modules/shared/runtime/bundled-native');
const Content = require('../src/modules/gemrb/runtime/payload-content');
const { projectGemRB } = require('../scripts/project-gemrb-runtime.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemrb-content-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'), files = path.join(input, 'files'), app = path.join(files, 'gemrb.app');
  const put = (name, value, mode = 0o644) => { const target = path.join(files, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value, { mode }); };
  for (const name of Content.OPTIONAL_TESTS) put('gemrb.app/' + name, 'optional test');
  const executable = 'gemrb.app/Contents/MacOS/gemrb';
  const macho = Buffer.alloc(64); macho.writeUInt32LE(0xfeedfacf, 0); macho.writeUInt32LE(0x0100000c, 4); macho.writeUInt32LE(2, 12);
  put(executable, macho, 0o755);
  put('gemrb.app/Contents/_CodeSignature/CodeResources', 'old seal');
  put('gemrb.app/Contents/Resources/GUIScripts/bg1/Start.py', 'production'); put('LICENSE', 'GPL');
  const records = B.fileInventory(files).map(name => { const actual = B.readRegular(path.join(files, name), 1024); return { path: name, size: actual.size, sha256: actual.sha256, mode: actual.mode, ...(name === executable ? { architectures: ['arm64'] } : {}) }; });
  const manifest = { schemaVersion: 1, managerId: 'gemrb', version: '0.9.5-cli-v4', upstreamRevision: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', minimumMacOS: '13.0', executableRelative: executable, files: records, dependencies: [{ file: executable, links: [] }], notices: [{ path: 'LICENSE', name: 'GemRB', license: 'GPL', sourceUrl: 'https://github.com/gemrb/gemrb' }], provenance: { sourceRevision: 'a'.repeat(40) } };
  fs.writeFileSync(path.join(input, 'manifest.json'), JSON.stringify(manifest));
  const output = path.join(root, 'output'), calls = [];
  const dependencies = { loadCommands: () => ({ slices: [{ architecture: 'arm64', minimumMacOS: '13.0', dependencies: [] }] }), tool(command, args) {
    calls.push({ command, args });
    if (command.endsWith('otool')) return 'filename\nconstant instruction bytes\n';
    if (args.includes('--force')) {
      const copiedApp = args.at(-1);
      assert.deepEqual(Content.OPTIONAL_TESTS.filter(name => fs.existsSync(path.join(copiedApp, name))), []);
      fs.appendFileSync(path.join(copiedApp, 'Contents/MacOS/gemrb'), ' new signature');
      fs.writeFileSync(path.join(copiedApp, 'Contents/_CodeSignature/CodeResources'), 'new seal');
    }
    return '';
  } };
  return { root, input, app, files, put, output, manifest, dependencies, calls };
}
test('GemRB publication removes only optional tests in a fresh copy, resigns and reseals without input mutation', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.input, 'manifest.json'));
  const result = projectGemRB(f);
  assert.equal(result.files, f.manifest.files.length - 3);
  assert.equal(result.removed.length, 3);
  assert.deepEqual(result.changed.sort(), ['gemrb.app/Contents/MacOS/gemrb', 'gemrb.app/Contents/_CodeSignature/CodeResources']);
  assert.ok(f.calls.some(call => call.args.includes('--force')));
  assert.equal(f.calls.filter(call => call.args.includes('--verify')).length, 2);
  assert.deepEqual(fs.readFileSync(path.join(f.input, 'manifest.json')), before);
  B.verifyPayload(f.files, f.manifest);
  const projected = JSON.parse(fs.readFileSync(path.join(f.output, 'manifest.json')));
  assert.equal(projected.version, '0.9.5-cli-v4-content1');
  B.verifyPayload(path.join(f.output, 'files'), projected);
  assert.equal(fs.readFileSync(path.join(f.output, 'files/gemrb.app/Contents/Resources/GUIScripts/bg1/Start.py'), 'utf8'), 'production');
});
test('GemRB projection rejects modified inputs and existing destinations before signing', t => {
  const f = fixture(t); f.put('LICENSE', 'BAD');
  assert.throws(() => projectGemRB(f), /checksum|changed|differ/i);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.output), false);
  fs.mkdirSync(f.output); assert.throws(() => projectGemRB(f), /fresh/);
});
test('optional test removal validates all files before deletion and rejects directory aliases', t => {
  const f = fixture(t), directory = path.join(f.app, 'Contents/Resources/GUIScripts/test');
  fs.renameSync(directory, path.join(f.root, 'preserved')); fs.symlinkSync(path.join(f.root, 'preserved'), directory);
  assert.throws(() => Content.omitOptionalTests(f.app), /symlink/);
  assert.ok(fs.existsSync(path.join(f.app, 'Contents/Resources/GUIScripts/demo/Tests.py')));
  assert.ok(fs.existsSync(path.join(f.root, 'preserved/Start.py')));
});
test('GemRB resource publication preserves old choices and exact upstream/source/backend while selecting a new included payload', () => {
  const manager = require('../src/modules/gemrb/runtime/manager');
  const current = manager.core.catalog.find(pin => pin.version === '0.9.5-cli-v4-content1');
  const previous = manager.core.catalog.find(pin => pin.version === '0.9.5-cli-v4');
  assert.deepEqual(manager.distributionVersions, [current.version]);
  for (const key of ['upstreamRevision', 'sourceTreeSha256', 'overlaySha256', 'backend', 'minimumMacOS']) assert.equal(current[key], previous[key]);
  assert.equal(current.sourceArtifact.sha256, previous.sourceArtifact.sha256);
  assert.equal(current.sourceArtifact.bytes, previous.sourceArtifact.bytes);
  assert.notEqual(current.sourceArtifact.directoryRelative, previous.sourceArtifact.directoryRelative);
  const requirements = require('../scripts/native-source-artifacts.cjs').requirements([{ managerId: manager.id, version: current.version }], new Map([[manager.id, manager]]));
  assert.equal(requirements[0].directoryRelative, current.sourceArtifact.directoryRelative);
});
