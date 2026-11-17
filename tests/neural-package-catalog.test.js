const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Packages = require('../src/modules/shared/reshade/neural/package-catalog');
const Releases = require('../src/modules/shared/reshade/neural/catalog'), Models = require('../src/modules/shared/reshade/neural/models');
const Manager = require('../src/modules/shared/reshade/runtime/neural-models-manager'), Neural = require('../src/modules/shared/reshade/neural');
const Cache = require('../src/modules/shared/runtime/runtime-catalog'), Github = require('../src/modules/shared/runtime/github-releases');
const Transport = require('../src/modules/shared/runtime/upstream-transport');
const {writeZipArchive} = require('./helpers/zip-fixture');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-package-'));t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const archive = path.join(userDataDir, 'original.whl');
  writeZipArchive(archive, [{name: 'nvidia_vfx/lib/libnvidia-ngx-vsr.so.1.8.2', data: Buffer.alloc(64, 5)}, {name: 'nvidia_vfx/licenses/LICENSE.txt', data: 'Original publisher notice'}, {name: 'nvidia_vfx/unrelated-never-executed.so', data: 'unrelated code'}]);
  const bytes = fs.readFileSync(archive), digest = hash(bytes), names = ['0.1.0.1', '0.2.0.0'].map(version => 'nvidia_vfx-' + version + '-cp312-abi3-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl');
  t.mock.method(Github, 'fetchGithubReleases', async () => [{tag_name: 'Real-CUGAN', assets: [{name: 'updated_weights.zip', size: 100, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/bilibili/ailab/releases/download/Real-CUGAN/updated_weights.zip'}]}]);
  t.mock.method(Github, 'fetchGithubTags', async () => [{name: 'Real-CUGAN', commit: {sha: 'b'.repeat(40)}}]);
  let metadata = 0, downloads = 0;
  t.mock.method(Transport, 'fetchUrlBuffer', async (url, options) => {
    metadata++;assert.match(url, /^https:\/\/pypi\.nvidia\.com\/nvidia-vfx\//);
    return options.method === 'HEAD' ? {status: 200, headers: {'content-length': String(bytes.length)}, body: Buffer.alloc(0)} :
      {status: 200, headers: {}, body: Buffer.from(names.map(name => '<a href="' + name + '#sha256=' + digest + '">' + name + '</a>').join('\n'))};
  });
  t.mock.method(Transport, 'downloadToFile', async (_url, destination) => {downloads++;fs.writeFileSync(destination, bytes);});
  t.mock.method(Neural, 'hostSupported', () => true);t.mock.method(Neural, 'resolve', () => ({}));
  return {userDataDir, root: '/selected/graphics', archive, bytes, counts: () => ({metadata, downloads})};
}
test('model package catalogs read actual release/index versions and publisher archive digests', async t => {
  const f = fixture(t), found = await Packages.discover(f);
  assert.deepEqual(found.failures, []);
  assert.ok(found.entries.some(row => row.method === 'realcugan' && row.files[0].sha256 === 'a'.repeat(64)));
  const vfx = found.entries.filter(row => row.method === 'mlx-vsr');
  assert.equal(vfx.length, 2);assert.match(vfx[1].label, /0\.2\.0\.0/);
  assert.equal(f.counts().downloads, 0, 'Refresh uses metadata only');assert.equal(f.counts().metadata, 3);
});
test('a verified VFX wheel imports only its model and notices without installing or executing SDK code', async t => {
  const f = fixture(t), source = (await Packages.discover(f)).entries.find(row => row.method === 'mlx-vsr' && row.label.includes('0.2.0.0'));
  assert.ok(Releases.validEntry(source));
  Cache.writeRuntimeCatalog({userDataDir: f.userDataDir, managerId: Models.ID, sourceId: 'upstream', source: 'https://github.com/', entries: [source]});
  const rows = [];t.mock.method(Models, 'listInstalled', () => rows);t.mock.method(Models, 'listManaged', () => rows);
  t.mock.method(Models, 'resolveModel', async (_root, version) => rows.find(row => row.version === version));
  t.mock.method(Models, 'importModel', async options => {
    assert.equal(path.basename(options.runtimePath), 'libnvidia-ngx-vsr.so.1.8.2');assert.deepEqual(fs.readFileSync(options.runtimePath), Buffer.alloc(64, 5));
    const names = fs.readdirSync(path.dirname(options.runtimePath));assert.ok(names.some(name => name.startsWith('NOTICE-')));assert.equal(names.includes('unrelated-never-executed.so'), false);
    const installDir = path.join(f.userDataDir, 'imported-fixture');fs.mkdirSync(installDir);
    const row = {version: 'sha256-' + 'd'.repeat(64), operation: 'mlx-vsr', installDir, modelPath: installDir, ready: true};rows.push(row);return row;
  });
  let prompts = 0;const context = {...f, version: source.version, confirmRuntimeInstall: () => {prompts++;return true;}};
  const first = await Manager.installRuntime(context);await Manager.installRuntime(context);
  assert.equal(first.variant, 'operation:mlx-vsr');assert.equal(prompts, 1);assert.equal(f.counts().downloads, 1);
  assert.deepEqual(fs.readFileSync(f.archive), f.bytes, 'original archive remains unchanged');
});
test('ambiguous model entries are refused without extracting unrelated SDK files', async t => {
  const f = fixture(t), archive = path.join(f.userDataDir, 'ambiguous.whl'), destination = path.join(f.userDataDir, 'out');fs.mkdirSync(destination);
  writeZipArchive(archive, [{name: 'one/libnvidia-ngx-vsr.so.1.8.2', data: 'a'}, {name: 'two/libnvidia-ngx-vsr.so.1.8.2', data: 'b'}]);
  await assert.rejects(require('../src/modules/shared/reshade/neural/archive-source').extract(archive, destination, {method: 'mlx-vsr'}), /unique compatible/);
  assert.deepEqual(fs.readdirSync(destination), []);
});
test('a changed publisher package is refused before any model conversion', async t => {
  const f = fixture(t), source = (await Packages.discover(f)).entries.find(row => row.method === 'mlx-vsr');
  Cache.writeRuntimeCatalog({userDataDir: f.userDataDir, managerId: Models.ID, sourceId: 'upstream', source: 'https://github.com/', entries: [source]});
  t.mock.method(Transport, 'downloadToFile', async (_url, destination) => fs.writeFileSync(destination, Buffer.alloc(f.bytes.length, 1)));
  t.mock.method(Models, 'importModel', () => assert.fail('changed publisher archive reached model conversion'));
  await assert.rejects(Manager.installRuntime({...f, version: source.version, confirmRuntimeInstall: () => true}), /does not match the checksum its publisher lists|checksum differs/);
});
test('a publisher asset without a digest records its actual local archive hash', async t => {
  const f = fixture(t), base = require('../src/modules/shared/reshade/neural/model-source.json').sources.find(row => row.method === 'mlx-vsr');
  const source = Packages.profile(base, {id: 123, name: 'listed.whl', url: 'https://pypi.nvidia.com/nvidia-vfx/listed.whl', bytes: f.bytes.length}, 'published-version', 'https://pypi.nvidia.com/nvidia-vfx/');
  assert.equal(source.files[0].sha256, undefined);assert.equal(source.files[0].integrity, 'recorded-local');assert.equal(source.files[0].assetId, 123);assert.ok(Releases.validEntry(source));
  Cache.writeRuntimeCatalog({userDataDir: f.userDataDir, managerId: Models.ID, sourceId: 'upstream', source: 'https://github.com/', entries: [source]});
  t.mock.method(Models, 'listInstalled', () => []);t.mock.method(Models, 'listManaged', () => []);
  const installDir = path.join(f.userDataDir, 'recorded-model-fixture');fs.mkdirSync(installDir);
  t.mock.method(Models, 'importModel', async () => ({version: 'sha256-'+'e'.repeat(64), operation: 'mlx-vsr', installDir, ready: true}));
  await Manager.installRuntime({...f, version: source.version, confirmRuntimeInstall: () => true});
  const receipt = JSON.parse(fs.readFileSync(path.join(installDir, 'download-source.json'), 'utf8'));
  assert.equal(receipt.observedFiles[0].sha256, hash(f.bytes));assert.equal(receipt.observedFiles[0].integrity, 'recorded-local');
});
