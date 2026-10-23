const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {image} = require('./fixtures/macho-image');
const {createManager} = require('../src/modules/android/art/runtime-manager');
const Bundled = require('../src/modules/shared/runtime/bundled-native');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('ART retained versions remain exact offline choices without replacing the included default', {skip:process.arch !== 'arm64'}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-art-retained-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  function packageFor(version) {
    const directoryRelative = `android-art/${version}/arm64`, directory = path.join(root, directoryRelative);
    const files = [['art/host/linux-run', image({fileType:2, installName:null}), 0o755],
      ['source.tar.gz', Buffer.from('Corresponding owned fixture source ' + version), 0o644]];
    for (const [name, bytes, mode] of files) {
      const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), {recursive:true});
      fs.writeFileSync(file, bytes, {mode}); fs.chmodSync(file, mode);
    }
    const manifest = {schemaVersion:1, version, minimumMacOS:'13.0', architectures:['arm64'], profile:{artExecutionVersion:1},
      files:files.map(([name, bytes, mode]) => ({path:name, size:bytes.length, mode, sha256:sha(bytes),
        ...(name.endsWith('linux-run') ? {architectures:['arm64']} : {})}))};
    const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(directory, 'runtime.json'), bytes, {mode:0o644});
    return {root:directory, record:{id:'android-art', version, arch:'arm64', launcherArchitectures:['arm64'], minimumMacOS:'13.0',
      directoryRelative, manifestRelative:'runtime.json', sourceRelative:'source.tar.gz', manifestSha256:sha(bytes), sourceSha256:sha(files[1][1])}};
  }
  const primary = packageFor('2.0'), retained = packageFor('3.0'), older = packageFor('1.0');
  const absent = {...retained.record, version:'0.5', directoryRelative:'android-art/0.5/arm64'};
  let metadata = {schemaVersion:1, packages:[retained.record, older.record, absent]}, requests = 0;
  const metadataFile = path.resolve(__dirname, '../src/modules/android/art/retained-versions.json');
  const read = fs.readFileSync.bind(fs);
  t.mock.method(fs, 'readFileSync', (file, ...options) => String(file) === metadataFile ? Buffer.from(JSON.stringify(metadata)) : read(file, ...options));
  const manager = createManager({included:() => primary, systemVersionSync:() => '26.0',
    fetchUrlBuffer:async () => { requests++; throw Error('Unexpected network request'); }});
  const userDataDir = path.join(root, 'profile'), options = {nativeResourceRoot:root};
  const state = manager.getState({userDataDir, ...options});
  assert.deepEqual(state.catalog.includedVersions, ['2.0', '3.0', '1.0']);
  assert.equal(state.catalog.recommendedVersion, '2.0');
  assert.equal(manager.resolveSelection(null, {}, userDataDir, options).version, '2.0');
  const chosen = manager.resolveSelection({runtimeData:{'android-art':{version:'3.0'}}}, {}, userDataDir, options);
  assert.equal(chosen.ready, true);
  assert.equal(chosen.install.root, retained.root);
  assert.equal(Bundled.verifyPayload(chosen.install.root, chosen.install.declaration), true);
  const old = manager.resolveSelection({runtimeData:{'android-art':{version:'1.0'}}}, {}, userDataDir, options);
  assert.equal(old.ready, true);
  assert.equal(old.install.root, older.root);
  assert.equal(requests, 0);
  metadata = {schemaVersion:1, packages:[{...retained.record, id:'android-aim'}]};
  assert.throws(() => manager.getState({userDataDir, ...options}), /ART runtime identity/);
  metadata = {schemaVersion:1, packages:[{...retained.record, directoryRelative:'android/1.0/arm64'}]};
  assert.throws(() => manager.getState({userDataDir, ...options}), /ART runtime identity/);
  assert.equal(requests, 0);
});
