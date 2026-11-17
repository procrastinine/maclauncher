const Harness = require('./helpers/future-upstream.cjs');
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Quarantine = require('../src/modules/shared/runtime/managed-quarantine'), quarantine = Quarantine.removeManagedRuntimeQuarantine;
Quarantine.removeManagedRuntimeQuarantine = (install, context) => quarantine(install, context, { execute: (_file, _args, _options, done) => done(null, '') });
const { image, X64 } = require('./fixtures/macho-image');
const Core = require('../src/core/external-store-downloads'), { createManager } = require('../src/modules/shared/stores/runtime/legendary-manager');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legendary-managed-'))), pythonPath = path.join(root, 'python');
  fs.writeFileSync(pythonPath, image({ fileType: 2 }), { mode: 0o755 }); t.after(() => { Harness.network.routes = null; fs.rmSync(root, { recursive: true, force: true }); });
  const routes = {}, releases = {}, calls = [], downloads = [], start = Harness.network.requests.length; let prompts = 0;
  const put = (directory, name, content) => { const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  function wheel(name, version, files, requires = []) {
    const filename = name.replace(/-/g, '_') + '-' + version + '-py3-none-any.whl';
    const metadata = name.replace(/-/g, '_') + '-' + version + '.dist-info/METADATA';
    const bytes = Buffer.from(JSON.stringify({ version, files: { ...files, [metadata]: 'Name: ' + name + '\nVersion: ' + version + '\n' }, requires }));
    const url = 'https://files.pythonhosted.org/packages/' + filename; routes[url] = bytes;
    (releases[name] ||= {})[version] = [{ filename, url, size: bytes.length, digests: { sha256: digest(bytes) }, yanked: false }];
    routes['https://pypi.org/pypi/' + name + '/json'] = { info: { name }, releases: releases[name] };
    Harness.network.routes = routes; return bytes;
  }
  const add = (version, hooks = true) => wheel('legendary-gl', version, {
    'legendary/__init__.py': '__version__=' + JSON.stringify(version), 'legendary/cli.py': 'import requests\n',
    'legendary/core.py': 'class LegendaryCore:\n    def get_cdn_manifest(self): pass\n    def load_manifest(self): pass\n' + (hooks ? '    def get_uri_manifest(self): pass\n' : '')
  }, [{ name: 'requests', specifier: '<3' }]);
  wheel('requests', '2.0', { 'requests/__init__.py': 'required package\n' });
  const execute = async (_python, args, options) => {
    const request = options.input && JSON.parse(options.input); calls.push(request?.mode || 'check');
    if (request?.mode === 'select') {
      const row = [...request.releases].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
      return { stdout: JSON.stringify(row ? { version: row.version, name: row.files[0].name, prerelease: row.version.includes('rc') } : null) };
    }
    if (request?.mode === 'requires') return { stdout: JSON.stringify(JSON.parse(fs.readFileSync(request.wheel)).requires) };
    if (request?.mode === 'extract') {
      for (const [name, bytes] of Object.entries(JSON.parse(fs.readFileSync(request.wheel)).files)) put(request.root, name, bytes);
      return { stdout: 'null' };
    }
    assert.equal(args[1], Core.LEGENDARY_CHECK);
    assert.ok(options.env.LEGENDARY_CONFIG_PATH.startsWith(root));
    const base = options.env.PYTHONPATH;
    assert.ok(fs.existsSync(path.join(base, 'requests/__init__.py')), 'required imports must exist before package verification');
    return { stdout: String(fs.readFileSync(path.join(base, 'legendary/core.py'), 'utf8').includes('get_uri_manifest')) + '\nlegendary version\n' };
  };
  const manager = createManager({ pythonPath, execute, hostArch: 'arm64', systemVersionSync: () => '26.0', downloadToFile: async (url, file) => {
    downloads.push(url); fs.writeFileSync(file, routes[url]); return { sha256: digest(routes[url]) };
  } });
  const context = { userDataDir: root, settings: {}, confirmRuntimeInstall: async () => { prompts++; return true; } };
  return { root, pythonPath, manager, context, add, put, routes, calls, counts: () => ({ requests: Harness.network.requests.length - start, python: calls.length, downloads: downloads.length, prompts }) };
}

test('Legendary live Refresh and exact install retain complete wheel dependencies, measured Python and an installed default', async t => {
  const f = fixture(t); f.add('0.21.1'); f.add('0.21.2'); await f.manager.refreshCatalog(f.context);
  assert.deepEqual(f.manager.getState(f.context).catalog.versions, ['0.21.2', '0.21.1']);
  const installed = await f.manager.installRuntime({ ...f.context, version: '0.21.1' });
  assert.deepEqual(installed.architectures, ['arm64']); assert.equal(installed.pythonPath, f.pythonPath);
  const receipt = JSON.parse(fs.readFileSync(path.join(installed.packagesPath, '.maclauncher-tools.json')));
  assert.deepEqual(receipt.packages.map(row => row.name), ['legendary-gl', 'requests']); assert.ok(receipt.files.some(row => row.path === 'requests/__init__.py'));
  let saved = f.manager.applySettingsUpdate('setDefault', { version: '0.21.1' }, {});
  const before = f.counts(); const selected = await f.manager.ensure({ ...f.context, settings: { runtimes: { legendary: saved } } });
  assert.equal(selected.version, '0.21.1'); assert.deepEqual(f.counts(), before, 'installed selection performs no network, Python execution or consent');
  f.add('0.22.0'); await f.manager.refreshCatalog({ ...f.context, force: true }); assert.ok(f.manager.getState(f.context).catalog.versions.includes('0.22.0'));
  fs.rmSync(path.join(installed.packagesPath, 'requests/__init__.py'));
  assert.equal(f.manager.resolveSelection({}, {}, f.root, { version: '0.21.1' }).ready, false, 'missing dependency refuses ordinary use');
  await f.manager.uninstallRuntime({ ...f.context, version: '0.21.1' }); assert.equal(fs.existsSync(installed.installDir), false);
});

test('Legendary custom cli.py and package folders use the same required closure and stay at their original paths', async t => {
  const f = fixture(t); f.add('0.21.2'); const installed = await f.manager.ensure(f.context);
  const custom = path.join(f.root, 'custom'); fs.cpSync(installed.packagesPath, custom, { recursive: true }); fs.rmSync(path.join(custom, 'runtime.json'));
  for (const input of [custom, path.join(custom, 'legendary/cli.py')]) {
    const row = await f.manager.registerCustomRuntime({ ...f.context, runtimePath: input }); assert.deepEqual(row.architectures, ['arm64']);
    const saved = f.manager.applySettingsUpdate('setDefault', { version: row.version }, {});
    assert.equal((await f.manager.ensure({ ...f.context, settings: { runtimes: { legendary: saved } } })).packagesPath, custom);
    await f.manager.uninstallRuntime({ ...f.context, version: row.version }); assert.ok(fs.existsSync(path.join(custom, 'legendary/cli.py')));
  }
  fs.rmSync(path.join(custom, '.maclauncher-tools.json'));
  fs.writeFileSync(path.join(custom, 'requests/extension.so'), image({ cpu: X64 }));
  await assert.rejects(f.manager.registerCustomRuntime({ ...f.context, runtimePath: custom }), /CPU/);
  fs.rmSync(path.join(custom, 'requests/extension.so'));
  fs.rmSync(path.join(custom, 'legendary/core.py'));
  await assert.rejects(f.manager.registerCustomRuntime({ ...f.context, runtimePath: custom }), /core.py|ENOENT/);
});

test('ordinary Legendary preparation asks once, stays offline when usable, and records shared automatic ownership', async t => {
  const f = fixture(t); f.add('0.21.2'); const first = await f.manager.ensure(f.context);
  assert.equal(first.version, '0.21.2'); assert.equal(f.counts().prompts, 1);
  const damaged = path.join(f.root, 'external/tools/legendary-0.1.0-' + 'b'.repeat(12));
  f.put(damaged, 'legendary/cli.py', 'incomplete'); f.put(damaged, '.maclauncher-tools.json', JSON.stringify({ legendaryVersion: '0.1.0' }));
  const before = f.counts(); await f.manager.ensure(f.context); assert.deepEqual(f.counts(), before);
  assert.ok(fs.existsSync(path.join(damaged, 'legendary/cli.py')), 'an unrelated incomplete earlier copy is preserved');
  assert.equal(require('../src/core/runtime-install-origins').read(f.root).filter(row => row.managerId === 'legendary').length, 1);
  assert.ok(require('../src/modules/registry').listSharedRuntimeManagers().some(row => row.id === 'legendary'));
});

test('verified legacy Legendary remains offline and deletion removes only its original owned download', async t => {
  const f = fixture(t), legacy = path.join(f.root, 'external/tools/legendary-0.20.0-' + 'a'.repeat(12));
  f.put(legacy, 'legendary/cli.py', 'import requests\n'); f.put(legacy, 'legendary/core.py', 'get_uri_manifest\n'); f.put(legacy, 'legendary/__init__.py', '');
  f.put(legacy, 'legendary_gl-0.20.0.dist-info/METADATA', 'Name: legendary-gl\nVersion: 0.20.0\n'); f.put(legacy, 'requests/__init__.py', '');
  f.put(legacy, '.maclauncher-tools.json', JSON.stringify({ legendaryVersion: '0.20.0', confirmsBuilds: true }));
  Harness.network.routes = {}; const before = f.counts();
  const selected = await Core.ensureLegendary({ userDataDir: f.root, pythonPath: f.pythonPath, confirmRuntimeInstall: async () => assert.fail('installed legacy needs no consent') });
  assert.deepEqual(f.counts(), before); assert.equal(selected.version, '0.20.0'); assert.equal(selected.packagesPath, legacy);
  await require('../src/modules/shared/stores/runtime/legendary-manager').uninstallRuntime({ userDataDir: f.root, version: '0.20.0' });
  assert.equal(fs.existsSync(legacy), false);
});

test('Legendary shared retention preserves explicit/default/custom and active versions, then removes the superseded automatic copy', async t => {
  const f = fixture(t), Origins = require('../src/core/runtime-install-origins');
  f.add('0.21.1'); await f.manager.ensure(f.context);
  f.add('0.20.0'); f.add('0.21.2'); await f.manager.refreshCatalog({ ...f.context, force: true });
  await f.manager.installRuntime({ ...f.context, version: '0.20.0' });
  await f.manager.installRuntime({ ...f.context, version: '0.21.2', automatic: true });
  const copy = f.manager.core.resolveInstalled({ userDataDir: f.root, version: '0.21.2' });
  const custom = path.join(f.root, 'retained-custom'); fs.cpSync(copy.packagesPath, custom, { recursive: true }); fs.rmSync(path.join(custom, 'runtime.json'));
  const customRow = await f.manager.registerCustomRuntime({ ...f.context, runtimePath: custom });
  const coordinator = require('../src/core/runtime-coordinator').coordinatorFor(f.root), client = coordinator.client();
  const token = await client.acquireUse({ managerId: 'legendary', version: '0.21.1' }); await client.bindUse(token, process.pid);
  const prune = settings => Origins.pruneSuperseded({ userDataDir: f.root, managers: [f.manager], settings,
    remove: data => f.manager.uninstallRuntime({ ...f.context, ...data }) });
  assert.deepEqual((await prune({})).removed, []); await client.release(token); await client.close();
  assert.deepEqual((await prune({})).removed.map(row => row.version), ['0.21.1']);
  assert.ok(f.manager.getState(f.context).installed.some(row => row.version === '0.20.0'));
  assert.ok(f.manager.getState(f.context).installed.some(row => row.version === customRow.version));
  assert.ok(fs.existsSync(path.join(custom, 'legendary/cli.py')));
  let saved = {};
  await require('../src/core/runtime-manager-service').runRuntimeManagerAction({ manager: f.manager, action: 'setDefault', payload: { version: '0.21.2' }, userDataDir: f.root,
    readSettings: () => saved, saveSettings: value => { saved = value; } });
  f.add('0.22.0'); await f.manager.refreshCatalog({ ...f.context, force: true }); await f.manager.installRuntime({ ...f.context, version: '0.22.0', automatic: true });
  assert.deepEqual((await prune({ runtimes: { legendary: saved } })).removed, []);
  assert.ok(f.manager.getState(f.context).installed.some(row => row.version === '0.21.2'));
});

test('Legendary required-build compatibility preserves an explicit default and refuses changed dependency downloads', async t => {
  const f = fixture(t); f.add('0.21.2'); const first = await f.manager.ensure(f.context);
  f.add('0.22.0', false); await f.manager.refreshCatalog({ ...f.context, force: true }); await f.manager.installRuntime({ ...f.context, version: '0.22.0' });
  assert.equal((await f.manager.ensure({ ...f.context, requiresConfirmedBuilds: true })).version, first.version);
  const saved = f.manager.applySettingsUpdate('setDefault', { version: '0.22.0' }, {});
  assert.equal((await f.manager.ensure({ ...f.context, settings: { runtimes: { legendary: saved } }, requiresConfirmedBuilds: true })).version, '0.22.0');
  f.add('0.23.0'); await f.manager.refreshCatalog({ ...f.context, force: true });
  const dependency = Object.keys(f.routes).find(url => /requests-2.0.*whl$/.test(url)); f.routes[dependency] = Buffer.alloc(f.routes[dependency].length);
  await assert.rejects(f.manager.installRuntime({ ...f.context, version: '0.23.0' }), /checksum|SHA-256/);
  assert.equal(f.manager.resolveSelection({}, {}, f.root, { version: '0.23.0' }).ready, false);
});

 test('Legendary exposes compatible upstream previews for explicit installation while automatic selection remains stable', async t => {
  const f = fixture(t); f.add('0.21.2'); f.add('0.22.0rc1'); await f.manager.refreshCatalog(f.context);
  assert.ok(f.manager.getState(f.context).catalog.versions.includes('0.22.0rc1'));
  assert.equal(f.manager.resolveSelection({}, {}, f.root).version, '0.21.2');
  const preview = await f.manager.installRuntime({ ...f.context, version: '0.22.0rc1' });
  assert.equal(preview.version, '0.22.0rc1');
});

test('ordinary registry exposes both store helpers with Refresh, Install, Delete, default and custom management', () => {
  const managers = require('../src/modules/registry').listSharedRuntimeManagers();
  for (const id of ['gogdl', 'legendary']) {
    const manager = managers.find(row => row.id === id); assert.ok(manager, id);
    for (const operation of ['refreshCatalog', 'installRuntime', 'uninstallRuntime', 'applySettingsUpdate', 'registerCustomRuntime'])
      assert.equal(typeof manager[operation], 'function', id + ' ' + operation);
  }
});
