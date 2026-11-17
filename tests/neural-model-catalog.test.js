const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const Releases = require('../src/modules/shared/reshade/neural/catalog'), Models = require('../src/modules/shared/reshade/neural/models');
const Manager = require('../src/modules/shared/reshade/runtime/neural-models-manager'), Neural = require('../src/modules/shared/reshade/neural');
const Github = require('../src/modules/shared/runtime/github-releases'), Upstream = require('../src/modules/shared/runtime/upstream');
const Static = require('../src/modules/shared/reshade/neural/model-source.json');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const blob = data => crypto.createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex');
function fixture(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-catalog-'));t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  let revision = 'a'.repeat(40), requests = 0;const files = new Map();
  t.mock.method(Github, 'fetchGithubCommits', async () => { requests++;return [{sha: revision, commit: {message: 'Checkpoint update', committer: {date: '2026-11-16T00:00:00Z'}}}]; });
  t.mock.method(Github, 'fetchGithubReleases', async () => []);t.mock.method(Github, 'fetchGithubTags', async () => []);
  t.mock.method(Upstream, 'githubTree', async ({repository}) => {
    const paths = new Set();
    for (const source of Static.sources) for (const file of source.files || []) {
      const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/[a-f0-9]{40}\/(.+)$/.exec(file.url);
      if (match?.[1] === repository) paths.add(match[2]);
    }
    return {tree: [...paths].map(name => { const bytes = Buffer.alloc(2048, name.charCodeAt(0));files.set('https://raw.githubusercontent.com/' + repository + '/' + revision + '/' + name, bytes);return {path: name, type: 'blob', sha: blob(bytes), size: bytes.length}; })};
  });
  t.mock.method(Neural, 'hostSupported', () => true);t.mock.method(Neural, 'resolve', () => ({}));
  return {userDataDir, root: '/selected/graphics', files, setRevision: value => revision = value, requests: () => requests};
}
test('neural Refresh discovers immutable checkpoint commits without reading weights', async t => {
  const f = fixture(t), state = await Manager.refreshCatalog(f);
  assert.ok(state.versions.some(version => version.endsWith('git-' + 'a'.repeat(40))));assert.equal(state.installable, true);
  assert.ok(state.versions.includes(Static.sources.find(row => row.method === 'nafnet').version), 'a source without public history keeps its declared profile');
  const count = f.requests();Manager.getState(f);assert.equal(f.requests(), count);
  f.setRevision('b'.repeat(40));await Manager.refreshCatalog(f);
  assert.ok(Releases.sources(f.userDataDir).some(row => row.revision === 'b'.repeat(40)));
  assert.ok(Releases.sources(f.userDataDir).some(row => row.revision === 'a'.repeat(40)), 'previous immutable source identities remain available');
});
test('neural installs verify Git bytes, preserve defaults and reuse installed models without network or consent', async t => {
  const f = fixture(t);await Manager.refreshCatalog(f);
  const source = Releases.sources(f.userDataDir).find(row => row.version.startsWith('mlx-interpolation-') && row.gitBlobSha1 === undefined && row.files?.[0].gitBlobSha1);
  assert.ok(source);let downloads = 0, imports = 0, confirmations = 0;const rows = [];
  t.mock.method(Models, 'listInstalled', () => rows);t.mock.method(Models, 'listManaged', () => rows);
  t.mock.method(Upstream, 'download', async (listed, file) => { downloads++;assert.ok(f.files.has(listed.url));fs.writeFileSync(file, f.files.get(listed.url)); });
  t.mock.method(Models, 'importModel', async options => {
    imports++;assert.equal(fs.statSync(options.runtimePath).size, 2048);
    const installDir = path.join(f.userDataDir, 'bounded-model-fixture');fs.mkdirSync(installDir);
    const row = {version: 'sha256-' + 'c'.repeat(64), operation: source.method, method: source.method, ready: true, installDir, modelPath: installDir};rows.push(row);return row;
  });
  t.mock.method(Models, 'resolveModel', async (_root, version) => rows.find(row => row.version === version));
  const settings = {defaultVersion: 'sha256-' + 'd'.repeat(64)}, original = structuredClone(settings);
  const context = {...f, version: source.version, settings, confirmRuntimeInstall: () => { confirmations++;return true; }};
  const first = await Manager.installRuntime(context);await Manager.installRuntime(context);
  assert.equal(imports, 1);assert.equal(downloads, source.files.length);assert.equal(confirmations, 1);assert.deepEqual(settings, original);
  assert.equal(Manager.applySettingsUpdate('setDefault', {version: first.version}, settings).defaultVersion, first.version);
  let removed;t.mock.method(Manager, 'uninstallRuntime', options => { removed = options.version; });
  await Manager.uninstallRuntime({...f, version: first.version});assert.equal(removed, first.version);
});
test('committed LFS pointer metadata supplies actual SHA-256 and size; pointer substitutions are refused', async () => {
  const file = {file: 'weights.safetensors', bytes: 4096, url: 'https://raw.githubusercontent.com/example/model/' + 'a'.repeat(40) + '/weights.safetensors'};
  const pointer = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + 'e'.repeat(64) + '\nsize 4096\n');
  const item = {path: 'weights.safetensors', type: 'blob', size: pointer.length, sha: blob(pointer)};
  const request = async () => ({status: 200, body: Buffer.from(JSON.stringify({encoding: 'base64', content: pointer.toString('base64')}))});
  const row = await Releases.checkpointFile(file, 'b'.repeat(40), [item], 'example/model', {request});
  assert.equal(row.sha256, 'e'.repeat(64));assert.equal(row.bytes, 4096);assert.equal(row.gitBlobSha1, undefined);
  await assert.rejects(Releases.checkpointFile(file, 'b'.repeat(40), [{...item, sha: 'f'.repeat(40)}], 'example/model', {request}), /committed Git object/);
});
test('neural custom packages keep the actual model manifest and content checks', t => {
  const f = fixture(t), runtimePath = path.join(f.userDataDir, 'custom.dlssmodel');fs.mkdirSync(runtimePath);
  const weights = Buffer.alloc(4096, 7), manifest = {schemaVersion: 1, identifier: 'bounded-fixture', architecture: 'mlxdlss.neural-rendering-transformer.v1',
    inputs: [{name: 'color', dataType: 'float32', layout: 'nhwc', shape: [1, 'height', 'width', 16]}], outputs: [{name: 'color', dataType: 'float32', layout: 'nhwc', shape: [1, 'height', 'width', 4]}],
    state: {kind: 'stateless'}, weights: {file: 'weights.safetensors', sha256: sha256(weights), tensors: require('./helpers/neural-model-contract').nrTensors()}};
  fs.writeFileSync(path.join(runtimePath, 'weights.safetensors'), weights);fs.writeFileSync(path.join(runtimePath, 'manifest.json'), JSON.stringify(manifest));
  assert.equal(Manager.customRuntime.inspect(runtimePath).ready, true);
  fs.writeFileSync(path.join(runtimePath, 'weights.safetensors'), Buffer.alloc(4096, 8));
  assert.throws(() => Manager.customRuntime.inspect(runtimePath), /checksum/);
});
test('changed committed checkpoint bytes are refused before model import', async t => {
  const f = fixture(t);await Manager.refreshCatalog(f);
  const source = Releases.sources(f.userDataDir).find(row => row.version.startsWith('mlx-interpolation-') && row.files?.[0].gitBlobSha1);
  t.mock.method(Upstream, 'download', async (_listed, file) => fs.writeFileSync(file, Buffer.alloc(2048, 1)));
  t.mock.method(Models, 'importModel', () => assert.fail('changed source bytes reached model import'));
  await assert.rejects(Manager.installRuntime({...f, version: source.version, confirmRuntimeInstall: () => true}), /checksum differs/);
  assert.equal(fs.readdirSync(path.join(f.userDataDir, 'runtimes', Models.ID)).some(name => name.startsWith('.download-')), false);
});
test('prepared DLSSMac release versions come from actual assets and published digests', async t => {
  const f = fixture(t), tag = 'v0.2.0';
  t.mock.method(Github, 'fetchGithubTags', async () => [{name: tag, commit: {sha: 'f'.repeat(40)}}]);
  t.mock.method(Github, 'fetchGithubReleases', async () => [{tag_name: tag, assets: [{name: 'DLSSMac-0.2.0-macos.zip', size: 100,
    browser_download_url: 'https://github.com/Mappsnet7/DLSSMac/releases/download/' + tag + '/DLSSMac-0.2.0-macos.zip', digest: 'sha256:' + 'e'.repeat(64)}]}]);
  await Manager.refreshCatalog(f);
  const source = Releases.sources(f.userDataDir).find(row => row.version === 'dlssmac-release-' + tag);
  assert.equal(source.files[0].sha256, 'e'.repeat(64));assert.equal(source.entry, 'DLSSMac-0.2.0-macos.zip');
  const Setup = require('../src/modules/shared/reshade/neural/setup');
  assert.equal(Setup.automaticSelection({}, 'realesrgan'), true);
  assert.equal(Setup.automaticSelection({settings: {defaultVersions: {realesrgan: 'sha256-' + 'd'.repeat(64)}}}, 'realesrgan'), false);
});
