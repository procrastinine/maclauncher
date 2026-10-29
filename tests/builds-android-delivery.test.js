const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm'), { createRequire } = require('node:module');
const B = require('../src/modules/shared/runtime/bundled-native');
const Aim = require('../src/modules/android/providers/aim');
const { nativeTool, packageFor } = require('./helpers/managed-tool-fixture.cjs');
const { zip } = require('./helpers/android-packages');

test('AIM installs a sealed Builds package, keeps exact offline selection and checks its controller before execution',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builds-aim-delivery-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const version = '1.0.0-fixture', revision = '1'.repeat(40);
    const native = nativeTool(path.join(root, 'native'), 'process.stdout.write("verified AIM fixture\\n");');
    const { archive, catalog } = packageFor(root, { id: 'android-aim', version, filesPrefix: 'files/',
      manifest: { managerId: 'android-aim', platform: 'darwin', upstreamRevision: revision,
        provenance: { sourceRevision: revision }, executableRelative: 'bin/aimctl',
        runtimeFiles: { controller: 'bin/maclauncher-aim' }, dependencies: [],
        notices: [{ name: 'Fixture', license: 'MIT', path: 'LICENSE', sourceUrl: 'https://example.com/fixture' }] },
      entries: [
        { path: 'bin/aimctl', bytes: native.binary, mode: 0o755, architectures: ['arm64'] },
        { path: 'bin/maclauncher-aim', bytes: native.binary, mode: 0o755, architectures: ['arm64'] },
        { path: 'bin/fixture.cjs', bytes: native.script, mode: 0o644 },
        { path: 'LICENSE', bytes: Buffer.from('MIT fixture license\n'), mode: 0o644 }
      ] });
    const userDataDir = path.join(root, 'data'); let fetches = 0, downloads = 0;
    const dependencies = { systemVersionSync: () => '26.0',
      fetchUrlBuffer: async url => { assert.match(url, /catalogs\/android-aim\.json$/); fetches++; return {status: 200, body: Buffer.from(JSON.stringify(catalog))}; },
      downloadToFile: async (url, file) => { assert.equal(url, catalog.packages[0].asset.url); downloads++; fs.copyFileSync(archive, file); } };
    const manager = Aim.manager.createManager(dependencies);
    assert.equal(manager.resolveSelection(null, {}, userDataDir).ready, false); assert.equal(fetches, 0);
    await manager.refreshCatalog({userDataDir, force: true});
    await manager.installRuntime({userDataDir, version: catalog.packages[0].version, confirmRuntimeInstall: async () => true});
    const entry = {runtimeData: {aim: {version: catalog.packages[0].version}}};
    const selected = manager.resolveSelection(entry, {}, userDataDir);
    assert.equal(selected.ready, true); assert.equal(selected.version, version);
    B.verifyPayload(selected.install.root, selected.install.declaration);
    const runtime = {...selected.install, root: selected.install.payloadRoot};
    const controller = Aim.resolveController(runtime); assert.match(controller, /files\/bin\/maclauncher-aim$/);
    assert.equal(await Aim.capture(controller, []), 'verified AIM fixture\n');
    const offline = Aim.manager.createManager({systemVersionSync: () => '26.0',
      fetchUrlBuffer: () => assert.fail('Offline selection fetched a catalog'), downloadToFile: () => assert.fail('Offline reuse downloaded')});
    assert.equal(offline.resolveSelection(entry, {}, userDataDir).ready, true);
    assert.equal(fetches, 1); assert.equal(downloads, 1);
    const bytes = fs.readFileSync(controller), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    fs.writeFileSync(controller, changed);
    assert.throws(() => Aim.resolveController(runtime), /controller changed/);
    assert.throws(() => B.verifyPayload(selected.install.root, selected.install.declaration), /checksum/);
    fs.writeFileSync(controller, bytes);
    assert.equal(offline.resolveSelection(entry, {}, userDataDir).ready, true);
    assert.equal(offline.resolveSelection({ runtimeData: { aim: { version: '2.0.0-uninstalled' } } }, {}, userDataDir).ready, false,
      'an unavailable exact selection never substitutes another installed version');
    assert.throws(() => Aim.resolveController({...runtime, manifest: {...runtime.manifest, runtimeFiles: {}, files: []}}), /no controller/);
  });

test('Android launcher metadata and bytecode use only the declared sealed helper', t => {
  const IncludedResolver = require('../src/modules/shared/runtime/included-helpers');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builds-android-helper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const components = { schemaVersion: 1, components: [{ id: 'fixture-platform', version: '1.0' }] };
  const entries = [
    ['files/runtime/src/modules/android/art/components.json', Buffer.from(JSON.stringify(components))],
    ['files/resources/launch-arguments.jar', zip([['META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\n\r\n')]])]
  ];
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'android-launcher', version: '1.0-fixture' }));
  entries.push(['manifest.json', manifest]);
  const declaration = { id: 'android-launcher', version: '1.0-fixture', arch: 'universal', launcherArchitectures: ['arm64', 'x64'],
    directoryRelative: 'android-launcher/1.0-fixture/universal', manifestRelative: 'manifest.json', manifestSha256: B.digest(manifest),
    files: entries.map(([name, bytes]) => ({ path: name, size: bytes.length, mode: 0o644, sha256: B.digest(bytes) })) };
  const directory = path.join(root, 'native-runtimes', declaration.directoryRelative);
  for (const [name, bytes] of entries) {
    const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode: 0o644 }); fs.chmodSync(file, 0o644);
  }
  function load(file, dependencies) {
    const filename = require.resolve(file), originalRequire = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, __filename: filename,
      __dirname: path.dirname(filename), JSON, require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : originalRequire(name) }, { filename });
    return module.exports;
  }
  let declarations = [declaration];
  const Included = load('../src/modules/android/included-files', {
    './distribution-included.json': declarations,
    '../shared/runtime/included-helpers': { resolveIncluded: (items, options) => IncludedResolver.resolveIncluded(items,
      { ...options, resourcesRoot: root }) }
  });
  const Source = load('../src/modules/android/runtime-source', { './included-files': Included });
  assert.equal(Source.root(), path.join(directory, 'files/runtime'));
  assert.deepEqual(Source.json('art/components.json'), components);
  const jar = Included.file('resources/launch-arguments.jar');
  assert.equal(fs.readFileSync(jar).readUInt32BE(0), 0x504b0304);
  assert.throws(() => Included.file('../resources/launch-arguments.jar'), /path|relative|unsafe/i);
  const original = fs.readFileSync(jar); fs.writeFileSync(jar, Buffer.alloc(original.length));
  assert.throws(() => Included.file('resources/launch-arguments.jar'), /checksum|changed/i);
  fs.writeFileSync(jar, original);
  fs.renameSync(directory, directory + '-unselected');
  assert.throws(() => Source.root(), /missing.*Reinstall/i, 'missing included bytes never fall back to a source checkout');
  declarations.length = 0;
  assert.throws(() => Source.root(), /unavailable.*Reinstall/i, 'an undeclared tree cannot become an included helper');
  assert.throws(() => require('../src/modules/android/runtime').resolve({ platform: 'darwin', arch: 'arm64' },
    { version: '1.0-fixture' }), /Select an installed/);
});
