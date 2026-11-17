const Harness = require('./helpers/future-upstream.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Quarantine = require('../src/modules/shared/runtime/managed-quarantine'), quarantine = Quarantine.removeManagedRuntimeQuarantine;
// Only the OS xattr callback is injected; managed-root checks stay production.
Quarantine.removeManagedRuntimeQuarantine = (install, context) => quarantine(install, context, { execute: (_file, _args, _options, done) => done(null, '') });
const Core = require('../src/core/gogdl-tool');
const { createManager } = require('../src/modules/shared/stores/runtime/gogdl-manager');
const { image, ARM64, X64 } = require('./fixtures/macho-image');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gogdl-managed-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = new Map(), rows = [], releases = []; let downloads = 0, consent = 0;
  const start = Harness.network.requests.length; t.after(() => { Harness.network.routes = null; });
  const add = (version, cpu = ARM64) => {
    const content = image({ cpu, fileType: 2 }), name = `gogdl_macos_${cpu === X64 ? 'x86_64' : 'arm64'}`;
    const url = `https://github.com/Heroic-Games-Launcher/heroic-gogdl/releases/download/v${version}/${name}`;
    const release = Harness.githubRelease('Heroic-Games-Launcher/heroic-gogdl', 'v' + version, [name]);
    release.assets[0].size = content.length; release.assets[0].digest = 'sha256:' + digest(content);
    const present = releases.find(row => row.tag_name === release.tag_name); if (present) present.assets.push(...release.assets); else releases.push(release);
    Harness.network.routes = Harness.githubRoutes('Heroic-Games-Launcher/heroic-gogdl', releases);
    bytes.set(url, content); rows.push({ version, revision: version, architecture: cpu === X64 ? 'x64' : 'arm64',
      files: [{ name, url, bytes: content.length, digest: { algorithm: 'sha256', value: digest(content) } }] });
  };
  const manager = createManager({ hostArch: 'arm64', systemVersionSync: () => '26.0', downloadToFile: async (url, file) => {
    downloads++; fs.writeFileSync(file, bytes.get(url)); return { sha256: digest(bytes.get(url)) };
  } });
  const context = { userDataDir: root, settings: {}, confirmRuntimeInstall: async () => { consent++; return true; } };
  return { root, manager, context, add, rows, counts: () => ({ requests: Harness.network.requests.length - start, downloads, consent }) };
}

test('an existing verified GOG helper is honored offline before discovery or consent', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gogdl-existing-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = image({ fileType: 2 }), directory = path.join(root, 'external/tools/gogdl-1.3.1-arm64-' + digest(bytes).slice(0, 12));
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'gogdl'), bytes, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, 'source.json'), JSON.stringify({ version: '1.3.1', sha256: digest(bytes), size: bytes.length }));
  let prompts = 0; const start = Harness.network.requests.length; Harness.network.routes = {};
  t.after(() => { Harness.network.routes = null; });
  const invalid = path.join(root, 'external/tools/gogdl-0.1.0-arm64-' + 'b'.repeat(12)), invalidBytes = Buffer.from('old unsupported helper');
  fs.mkdirSync(invalid); fs.writeFileSync(path.join(invalid, 'gogdl'), invalidBytes, { mode: 0o755 });
  fs.writeFileSync(path.join(invalid, 'source.json'), JSON.stringify({ version: '0.1.0', sha256: digest(invalidBytes), size: invalidBytes.length }));
  const selected = await Core.ensureGogdl({ userDataDir: root, arch: 'arm64', platform: 'darwin', confirmRuntimeInstall: () => { prompts++; throw new Error('already installed'); } });
  assert.equal(selected.version, '1.3.1'); assert.equal(selected.executablePath, path.join(directory, 'gogdl'));
  assert.equal(Harness.network.requests.length - start, 0); assert.equal(prompts, 0); assert.deepEqual(selected.architectures, ['arm64']);
  assert.deepEqual(fs.readFileSync(selected.executablePath), bytes);
  await require('../src/modules/shared/stores/runtime/gogdl-manager').uninstallRuntime({ userDataDir: root, version: selected.version, architecture: 'arm64' });
  assert.equal(fs.existsSync(selected.executablePath), false, 'deleting the migrated download removes its owned original bytes');
  assert.ok(fs.existsSync(path.join(invalid, 'gogdl')), 'an unsupported earlier helper is preserved');
});

test('GOGdl is a managed Tools row with live releases, exact installs, measured custom paths and saved defaults', async t => {
  const f = fixture(t); f.add('1.3.1'); f.add('1.4.0'); f.add('1.4.0', X64);
  assert.equal(f.manager.ui.groupId, 'tools');
  await f.manager.refreshCatalog(f.context);
  assert.deepEqual(f.manager.getState(f.context).catalog.versions, ['1.4.0', '1.3.1']);
  const installed = await f.manager.installRuntime({ ...f.context, version: '1.3.1', architecture: 'arm64' });
  assert.deepEqual(installed.architectures, ['arm64']);
  const settings = { runtimes: { gogdl: f.manager.applySettingsUpdate('setDefault', { version: '1.3.1' }, {}) } };
  assert.equal(f.manager.resolveSelection({}, settings, f.root).version, '1.3.1');
  const before = f.counts(); await f.manager.ensure({ ...f.context, settings }); assert.deepEqual(f.counts(), before);
  const custom = path.join(f.root, 'custom'); fs.mkdirSync(custom); fs.writeFileSync(path.join(custom, 'gogdl'), image({ cpu: X64, fileType: 2 }), { mode: 0o755 });
  const row = await f.manager.registerCustomRuntime({ ...f.context, runtimePath: custom });
  assert.deepEqual(row.architectures, ['x86_64']);
  const configured = f.manager.applySettingsUpdate('setDefault', { version: row.version }, {});
  const customSelected = f.manager.resolveSelection({}, { runtimes: { gogdl: configured } }, f.root);
  assert.equal(customSelected.install.executablePath, path.join(custom, 'gogdl'));
  assert.equal(customSelected.install.needsRosetta, true);
  const missing = path.join(f.root, 'empty'); fs.mkdirSync(missing);
  await assert.rejects(f.manager.registerCustomRuntime({ ...f.context, runtimePath: missing }), /executable|file|ENOENT/i);
  await f.manager.uninstallRuntime({ ...f.context, version: row.version }); assert.ok(fs.existsSync(path.join(custom, 'gogdl')));
  await f.manager.uninstallRuntime({ ...f.context, version: '1.3.1', architecture: 'arm64' });
  assert.equal(f.manager.resolveSelection({}, {}, f.root, { version: '1.3.1', architecture: 'arm64' }).ready, false);
  f.add('1.5.0'); await f.manager.refreshCatalog({ ...f.context, force: true });
  assert.ok(f.manager.getState(f.context).catalog.versions.includes('1.5.0'));
});

test('ordinary missing GOG support asks once, records automatic intent and reuses the verified installed copy', async t => {
  const f = fixture(t); f.add('1.3.1');
  const first = await f.manager.ensure(f.context);
  assert.equal(first.version, '1.3.1'); assert.equal(f.counts().consent, 1); assert.equal(f.counts().downloads, 1);
  const before = f.counts(); await f.manager.ensure(f.context); assert.deepEqual(f.counts(), before);
  assert.equal(require('../src/core/runtime-install-origins').read(f.root).filter(row => row.managerId === 'gogdl').length, 1);
  assert.ok(require('../src/modules/registry').listSharedRuntimeManagers().some(row => row.id === 'gogdl'));
});

test('shared origins retire only superseded automatic GOG copies and preserve explicit/default/custom/in-use versions', async t => {
  const f = fixture(t), Origins = require('../src/core/runtime-install-origins');
  const { runRuntimeManagerAction } = require('../src/core/runtime-manager-service');
  f.add('1.0.0'); await f.manager.ensure(f.context);
  f.add('0.9.0'); f.add('2.0.0'); await f.manager.refreshCatalog({ ...f.context, force: true });
  await f.manager.installRuntime({ ...f.context, version: '0.9.0', architecture: 'arm64' });
  await f.manager.installRuntime({ ...f.context, version: '2.0.0', architecture: 'arm64', automatic: true });
  const custom = path.join(f.root, 'owned-gogdl'); fs.writeFileSync(custom, image({ fileType: 2 }), { mode: 0o755 });
  await f.manager.registerCustomRuntime({ ...f.context, runtimePath: custom });
  const coordinator = require('../src/core/runtime-coordinator').coordinatorFor(f.root), client = coordinator.client();
  const token = await client.acquireUse({ managerId: 'gogdl', version: '1.0.0' }); await client.bindUse(token, process.pid);
  const prune = settings => Origins.pruneSuperseded({ userDataDir: f.root, managers: [f.manager], settings,
    remove: data => f.manager.uninstallRuntime({ ...f.context, ...data }) });
  assert.deepEqual((await prune({})).removed, [], 'an actual use lease protects the older automatic copy');
  await client.release(token); await client.close();
  assert.deepEqual((await prune({})).removed.map(row => row.version), ['1.0.0']);
  assert.ok(f.manager.getState(f.context).installed.some(row => row.version === '0.9.0'), 'explicit install survives');
  assert.ok(fs.existsSync(custom), 'custom original survives');
  let saved = {};
  await runRuntimeManagerAction({ manager: f.manager, action: 'setDefault', payload: { version: '2.0.0' }, userDataDir: f.root,
    readSettings: () => saved, saveSettings: value => { saved = value; } });
  f.add('3.0.0'); await f.manager.refreshCatalog({ ...f.context, force: true });
  await f.manager.installRuntime({ ...f.context, version: '3.0.0', automatic: true, architecture: 'arm64' });
  assert.deepEqual((await prune({ runtimes: { gogdl: saved } })).removed, []);
  assert.ok(f.manager.getState(f.context).installed.some(row => row.version === '2.0.0'), 'already-installed default survives');
});
