// Required first: it replaces the network before modules load.
const Harness = require('./helpers/future-upstream.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Cutter = require('../src/modules/shared/decompilation/runtime/native-manager');
const AssetRipper = require('../src/modules/unity/tools/assetripper-manager');
const Cpp2IL = require('../src/modules/unity/tools/cpp2il-manager');
const UTMT = require('../src/modules/gamemaker/runtime/undertale-mod-tool');
const Dotnet = require('../src/modules/shared/runtime/dotnet-tool-host');
const { image, X64 } = require('./fixtures/macho-image');
async function discover(source, routes) {
  Harness.network.routes = routes;
  try { return await source.discover({}); } finally { Harness.network.routes = null; }
}
const github = (source, tag, names) => discover(source, Harness.githubRoutes(source.repository, [Harness.githubRelease(source.repository, tag, names)]));
test('publisher tool catalogs list both CPU builds under the release version and read floors at install', async () => {
  const rows = list => list.map(row => [row.version, row.architecture, row.files.length]);
  assert.deepEqual(rows(await github(Cutter.upstream, 'v2.5.0', ['arm64', 'x86_64'].map(cpu => `Cutter-v2.5.0-macOS-${cpu}.dmg`))), [['2.5.0', 'arm64', 1], ['2.5.0', 'x64', 1]]);
  assert.deepEqual(rows(await github(AssetRipper.__test.upstream, '2.0.0', ['arm64', 'x64'].map(cpu => `AssetRipper_mac_${cpu}.tar.xz`))), [['2.0.0', 'arm64', 1], ['2.0.0', 'x64', 1]]);
  const repository = 'SamboyCoding/Cpp2IL', API = `https://api.github.com/repos/${repository}/actions`, sha = 'a'.repeat(40);
  const run = { id: 7, status: 'completed', conclusion: 'success', head_branch: 'development', event: 'push', path: '.github/workflows/dotnet-core.yml',
    head_sha: sha, created_at: '2026-10-30T00:00:00Z', repository: { full_name: repository }, head_repository: { full_name: repository } };
  const artifact = (id, name) => ({ id, name, size_in_bytes: 100, expired: false, digest: 'sha256:' + 'b'.repeat(64), expires_at: '2099-01-01T00:00:00Z',
    workflow_run: { id: 7, head_sha: sha, head_branch: 'development' } });
  const cpp = await discover(Cpp2IL.__test.upstream, { [`${API}/workflows/dotnet-core.yml/runs`]: { workflow_runs: [run] },
    [`${API}/runs/7/artifacts`]: { artifacts: [artifact(5, 'Cpp2IL-net9-osx-x64'), artifact(6, 'Cpp2IL-net9-win-x64')] } });
  assert.deepEqual(rows(cpp), [['2026-10-30-aaaaaaaaaaaa-5', 'x64', 1]]);
  assert.deepEqual(rows(await github(UTMT.upstream, '0.9.2.0', ['', '-x86'].map(cpu => `UTMT_CLI_v0.9.2.0-macOS${cpu}.zip`))),
    [['0.9.2.0-native-macos', 'arm64', 1], ['0.9.2.0-x86_64', 'x64', 1]]);
});

test('installs and saved defaults under earlier CPU-suffixed version IDs still resolve', { skip: process.platform !== 'darwin' }, async t => {
  const { createPinnedNativeManager } = require('../src/modules/shared/runtime/pinned-native-manager');
  const Architecture = require('../src/modules/shared/runtime/architecture');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-legacy-id-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pin = (version, architecture) => ({ version, upstreamRevision: 'r', architecture, hostArchitectures: [architecture],
    asset: { url: `https://example.test/${architecture}.zip`, filename: `${architecture}.zip`, sha256: 'a'.repeat(64) } });
  const create = (architecture, rows) => Architecture.withArchitecture(architecture, () => createPinnedNativeManager({ id: 'legacy-tool', label: 'Legacy tool', importLocal: true, discoverCatalog: async () => rows }));
  const before = create('arm64', [pin('2.0.0', 'arm64'), pin('2.0.0-x64', 'x64')]);
  await before.refreshCatalog({ userDataDir: directory, force: true });
  const file = path.join(directory, 'x64'); fs.writeFileSync(file, image({ cpu: X64, fileType: 2, minimumOS: 0x000c0000 }), { mode: 0o755 });
  await before.importRuntime({ userDataDir: directory, architecture: 'x64', version: '2.0.0-x64', runtimePath: file });
  const settings = { runtimes: { 'legacy-tool': { defaultVersion: '2.0.0-x64', defaultArchitecture: 'x64' } } };
  for (const architecture of ['arm64', 'x64']) {
    const after = create(architecture, ['arm64', 'x64'].map(cpu => pin('2.0.0', cpu)));
    await after.refreshCatalog({ userDataDir: directory, force: true });
    assert.equal(after.resolveSelection({}, settings, directory).install.installDir, path.join(directory, 'runtimes', 'legacy-tool', 'x64', '2.0.0-x64'));
    assert.equal(after.resolveSelection({ runtimeData: { 'legacy-tool': { version: '2.0.0-x64', architecture: 'x64' } } }, {}, directory).ready, true);
    assert.deepEqual(after.getState({ userDataDir: directory }).catalog.architectureCatalogs.x64.versions, ['2.0.0']);
  }
});
test('AssetRipper verifies the selected Intel payload instead of requiring an ARM slice', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-x64-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AssetRipper.GUI.Free'), image({ cpu: X64, fileType: 2, minimumOS: 0x000c0000 }));
  fs.writeFileSync(path.join(root, 'libcapstone.dylib'), image({ cpu: X64, fileType: 6, minimumOS: 0x000c0000 }));
  const result = AssetRipper.__test.prepareInstall({ unpacked: root, pin: { architecture: 'x64' } }, { systemVersionSync: () => '13.0' });
  assert.equal(result.architecture, 'x64'); assert.equal(result.minimumMacOS, '12.0.0');
  assert.throws(() => AssetRipper.__test.prepareInstall({ unpacked: root, pin: { architecture: 'arm64' } }, { systemVersionSync: () => '13.0' }), { code: 'MACHO_ARCH' });
});
test('Microsoft runtime metadata selects x64 and installed CPU variants coexist offline', async t => {
  const version = '10.0.42', url = `https://builds.dotnet.microsoft.com/dotnet/Runtime/${version}/dotnet-runtime-${version}-osx-x64.tar.gz`;
  Harness.network.routes = { 'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json': { releases: [{ runtime: { version, files: [
    { name: 'dotnet-runtime-osx-x64.tar.gz', rid: 'osx-x64', url, hash: 'a'.repeat(128) }] } }] } };
  t.after(() => { Harness.network.routes = null; });
  const pin = await Dotnet.__test.selectPin({ framework: 'net10.0', minimumVersion: version, architecture: 'x64' });
  assert.equal(pin.architecture, 'x64'); assert.equal(pin.url, url);
  const Architecture = require('../src/modules/shared/runtime/architecture');
  const implicit = await Architecture.withArchitecture('x64', () => Dotnet.__test.selectPin({ framework: 'net10.0', minimumVersion: '10.0.0' }));
  assert.equal(implicit.architecture, 'x64');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-cpus-')); t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  for (const architecture of ['arm64', 'x64']) {
    const target = path.join(Dotnet.__test.root(userDataDir), version, architecture), files = path.join(target, 'files');
    const required = ['dotnet', `host/fxr/${version}/libhostfxr.dylib`, `shared/Microsoft.NETCore.App/${version}/libhostpolicy.dylib`, `shared/Microsoft.NETCore.App/${version}/libcoreclr.dylib`, `shared/Microsoft.NETCore.App/${version}/System.Private.CoreLib.dll`];
    for (const name of required) { const file = path.join(files, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name.endsWith('.dll') ? 'managed' : image({ cpu: architecture === 'x64' ? X64 : 0x0100000c, fileType: 2, minimumOS: 0x000e0000 })); }
    const records = Dotnet.__test.inventory(files);
    Dotnet.__test.validateNative(files, { ...pin, architecture }, records);
    fs.writeFileSync(path.join(target, 'host.json'), JSON.stringify({ version, architecture, minimumMacOS: '14.0', archiveSha512: 'a'.repeat(128), files: records }));
    const selected = Dotnet.resolve({ userDataDir, framework: 'net10.0', minimumVersion: version, architecture });
    assert.equal(selected.runtimeIdentity.variant, architecture); assert.equal(selected.runtimeIdentity.sourcePath, target);
  }
});
test('neural downloads require their host and XeSS downloads require a compatible compute provider', async t => {
  const Neural = require('../src/modules/shared/reshade/neural');
  const Models = require('../src/modules/shared/reshade/runtime/neural-models-manager');
  const XeSS = require('../src/modules/shared/reshade/runtime/xess-manager');
  const Provider = require('../src/modules/shared/reshade/xess');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-host-')); t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  assert.equal(Neural.hostSupported({ platform: 'darwin', hostArchitecture: 'x64', macOSVersion: '27.0' }), false);
  assert.equal(Neural.hostSupported({ platform: 'darwin', hostArchitecture: 'arm64', macOSVersion: '13.0' }), false);
  assert.equal(Neural.hostSupported({ platform: 'darwin', hostArchitecture: 'arm64', macOSVersion: '14.0' }), true);
  const context = { userDataDir, platform: 'darwin', hostArchitecture: 'x64', macOSVersion: '27.0' };
  assert(Models.getState(context).setupActions.every(row => row.available === false && row.reason));
  assert.throws(() => Models.performSetupAction({ ...context, setupActionId: 'downloadDlssMac' }), /Apple Silicon/);
  t.mock.method(Provider, 'state', () => ({ available: false, reason: 'A compatible GPU compute host is required.' }));
  assert.equal(XeSS.getState({ userDataDir, root: userDataDir }).catalog.installable, false);
  await assert.rejects(XeSS.installRuntime({ userDataDir, root: userDataDir, confirmRuntimeInstall: () => assert.fail('Unsupported hosts cannot download') }), /compute host/);
});
test('neural downloads follow the included provider when an Intel app runs on Apple Silicon', t => {
  const Neural = require('../src/modules/shared/reshade/neural');
  const Models = require('../src/modules/shared/reshade/runtime/neural-models-manager');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-included-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { root, userDataDir: root, platform: 'darwin', hostArchitecture: 'arm64', macOSVersion: '14.0', graphicsArchitecture: 'x64' };
  assert.equal(Neural.hostSupported(context), true);
  assert(Models.getState(context).setupActions.every(row => row.available === false && /neural provider/.test(row.reason)));
  assert.equal(Models.getState(context).catalog.importable, false);
  assert.throws(() => Models.performSetupAction({ ...context, setupActionId: 'downloadDlssMac' }), /neural provider/);
  t.mock.method(Neural, 'resolve', (selectedRoot, options) => {
    assert.equal(selectedRoot, root); assert.equal(options.graphicsArchitecture, 'x64');
    return { execution: 'service', supportedMethods: ['mlx-dlss'] };
  });
  assert(Models.getState(context).setupActions.every(row => row.available === true));
  assert.equal(Models.getState(context).catalog.importable, true);
});
test('UndertaleModTool Auto chooses the selected CPU from a cache containing both publisher builds', async t => {
  const { writeRuntimeCatalog } = require('../src/modules/shared/runtime/runtime-catalog');
  const { createPinnedNativeManager } = require('../src/modules/shared/runtime/pinned-native-manager');
  const Architecture = require('../src/modules/shared/runtime/architecture');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'utmt-both-cpus-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = '0.9.2.0', sourceUrl = 'https://github.com/UnderminersTeam/UndertaleModTool/releases';
  const rows = [['native-macos', 'arm64', ''], ['x86_64', 'x64', '-x86']].map(([suffix, architecture, name]) => ({ version: `${version}-${suffix}`,
    upstreamRevision: 'a'.repeat(40), architecture, asset: { filename: `UTMT_CLI_v${version}-macOS${name}.zip`, sha256: 'b'.repeat(64),
      url: `https://github.com/UnderminersTeam/UndertaleModTool/releases/download/${version}/UTMT_CLI_v${version}-macOS${name}.zip` } }));
  writeRuntimeCatalog({ userDataDir: root, managerId: UTMT.manager.id, entries: rows, source: sourceUrl });
  for (const [architecture, expected] of [['arm64', `${version}-native-macos`], ['x64', `${version}-x86_64`]]) {
    Architecture.withArchitecture(architecture, () => {
      const manager = createPinnedNativeManager({ id: UTMT.manager.id, label: 'UndertaleModTool CLI',
        supportsDefault: true, sourceUrl, importLocal: true,
        discoverCatalog: () => assert.fail('A persisted publisher catalog stays offline'),
        resolveExecutable: directory => path.join(directory, 'UndertaleModCli'),
        dependencies: { systemVersionSync: () => '27.0' } });
      assert.equal(manager.resolveSelection({}, {}, root).version, expected);
      const other = architecture === 'arm64' ? 'x64' : 'arm64', otherVersion = other === 'arm64' ? `${version}-native-macos` : `${version}-x86_64`;
      const alternate = manager.getState({ userDataDir: root }).catalog.architectureCatalogs[other];
      assert(alternate.versions.includes(otherVersion));
      assert.equal(alternate.versionRequirements[otherVersion].architecture, other);
    });
  }
});
