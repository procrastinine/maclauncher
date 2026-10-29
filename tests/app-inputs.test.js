const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Inputs = require('../scripts/app-inputs.cjs');
const { finished } = require('node:stream/promises');
const sha = require('../src/modules/shared/runtime/bundled-native').digest;
function write(root, relative, bytes) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-app-inputs-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageConfig = { name: 'maclauncher', version: '1.0.0', main: 'src/main/bootstrap.js', dependencies: {},
    build: { productName: 'MacLauncher', appId: 'com.maclauncher.launcher', asar: true, directories: { output: 'dist' },
      mac: { minimumSystemVersion: '13.0' }, files: ['src/**', 'package.json', '!src/resources{,/**}'],
      extraResources: [{ from: 'src/resources', to: '.', filter: ['native-runtimes/**', 'icon.png'] }] } };
  write(root, 'package.json', JSON.stringify(packageConfig)); write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages: {}\n");
  write(root, 'src/main/bootstrap.js', 'module.exports = 42;\n'); write(root, 'src/resources/icon.png', 'image');
  const plan = { launcherArch: 'arm64', launcherMinimumMacOS: '13.0', maximumNativeMacOS: '13.0', packages: [], supplementals: [], sourceArtifacts: [] };
  const packageLock = { schemaVersion: 1, repository: 'procrastinine/maclauncher-builds', arch: 'arm64', maximumMacOS: '13.0', packages: [] };
  return { root, options: { repoRoot: root, packageConfig, plan, packageLock, requireRenderer: false, requireHost: false }, packageConfig, plan, packageLock };
}
test('application inputs map renamed FileSets and reject undeclared compiled source', async t => {
  const f = fixture(t); write(f.root, 'bridge/module.js', 'module.exports=true;');
  f.packageConfig.build.files.push({ from: 'bridge', to: 'src/bridge', filter: ['*.js'] });
  const selected = await Inputs.prepare(f.options);
  assert.equal(selected.asar.get('src/bridge/module.js').sourceRelative, 'bridge/module.js');
  assert.equal(Inputs.checkMember(selected, 'src/bridge/module.js', Buffer.from('module.exports=true;')), 'source');
  write(f.root, 'src/main/hidden', Buffer.from('7f454c4600000000', 'hex'));
  await assert.rejects(Inputs.prepare(f.options), /Missing source, upstream supplier or Builds record.*native executable/);
});
test('application input maps detect source mutation and unlisted archive members', async t => {
  const f = fixture(t), selected = await Inputs.prepare(f.options);
  assert.throws(() => Inputs.checkMember(selected, 'src/main/injected.js', Buffer.from('injected')), /without a source, supplier or Builds record/);
  write(f.root, 'src/main/bootstrap.js', 'module.exports = 24;\n');
  assert.throws(() => Inputs.assertUnchanged(selected), /source changed during packaging/);
});
test('stock bundled helper files trace directly to the publisher without a Builds package', async t => {
  const f = fixture(t), code = Buffer.from('7f454c4600000000', 'hex');
  write(f.root, 'src/resources/7zip/7zz', code);
  write(f.root, 'src/resources/7zip/source.json', JSON.stringify({ version: '26.05', url: 'https://example.org/7zip.tar.xz',
    sha256: 'a'.repeat(64), executableSha256: sha(code) }));
  f.packageConfig.build.extraResources[0].filter.push('7zip/**');
  const selected = await Inputs.prepare(f.options), record = selected.resources.get('7zip/7zz');
  assert.equal(record.owner, 'upstream');
  assert.equal(record.supplier.version, '26.05');
  assert.equal(selected.plan.supplementals.length, 0);
  assert.equal(Inputs.checkMember(selected, '7zip/7zz', code, { resource: true }), 'upstream');
  write(f.root, 'src/resources/7zip/7zz', Buffer.from('changed'));
  await assert.rejects(Inputs.prepare(f.options), /official supplier executable/);
});
test('declared upstream binary inputs use publisher metadata and reject modified bytes', async t => {
  const f = fixture(t), relative = 'src/modules/example/tools/tool.jar', code = Buffer.from('504b030400000000', 'hex');
  write(f.root, relative, code);
  await assert.rejects(Inputs.prepare(f.options), /Missing source, upstream supplier or Builds record/);
  write(f.root, 'src/modules/example/tools/binary.json', JSON.stringify({ version: '1.2.3',
    url: 'https://example.org/tool.jar', files: [{ path: 'tool.jar', size: code.length, sha256: sha(code) }] }));
  const selected = await Inputs.prepare(f.options), record = selected.asar.get(relative);
  assert.equal(record.owner, 'upstream');
  assert.equal(record.supplier.version, '1.2.3');
  assert.equal(Inputs.checkMember(selected, relative, code), 'upstream');
  assert.equal(selected.plan.supplementals.length, 0);
  write(f.root, relative, Buffer.from('504b030400000001', 'hex'));
  await assert.rejects(Inputs.prepare(f.options), /differs from its declared supplier identity/);
});
test('sealed Builds files retain the exact lock identity and reject changed payload bytes', async t => {
  const f = fixture(t), directoryRelative = 'fixture-helper/1.0.0/universal', prefix = 'src/resources/native-runtimes/' + directoryRelative;
  const code = Buffer.from('0061736d01000000', 'hex'), manifest = Buffer.from('{"schemaVersion":1}');
  write(f.root, prefix + '/engine.wasm', code); write(f.root, prefix + '/manifest.json', manifest);
  const files = [{ path: 'engine.wasm', size: code.length, mode: 0o644, sha256: sha(code) }, { path: 'manifest.json', size: manifest.length, mode: 0o644, sha256: sha(manifest) }];
  const item = { id: 'fixture-helper', version: '1.0.0', arch: 'universal', launcherArchitectures: ['arm64', 'x64'], minimumMacOS: '13.0', directoryRelative,
    sourceRelative: null, sourceSha256: sha(manifest), manifestRelative: 'manifest.json', manifestSha256: sha(manifest), files,
    notices: [{ name: 'fixture', license: 'MIT', path: 'manifest.json', sourceUrl: 'https://example.org' }] };
  f.plan.supplementals.push(item);
  f.packageLock.packages.push({ schemaVersion: 2, id: item.id, version: item.version, arch: item.arch, launcherArchitectures: item.launcherArchitectures,
    minimumMacOS: item.minimumMacOS, manifestRelative: item.manifestRelative, manifestSha256: item.manifestSha256, sourceSha256: item.sourceSha256,
    updatePolicy: 'manual', tag: 'fixture-helper/v1.0.0/universal', asset: { filename: 'fixture-helper-1.0.0-universal.tar.gz', bytes: 100, sha256: 'a'.repeat(64),
      url: 'https://github.com/procrastinine/maclauncher-builds/releases/download/fixture-helper%2Fv1.0.0%2Funiversal/fixture-helper-1.0.0-universal.tar.gz' } });
  const selected = await Inputs.prepare(f.options), relative = 'native-runtimes/' + directoryRelative + '/engine.wasm';
  assert.equal(Inputs.checkMember(selected, relative, code, { resource: true }), 'builds');
  assert.throws(() => Inputs.checkMember(selected, relative, Buffer.from('changed'), { resource: true }), /differs from its source, supplier or Builds record/);
  const changed = Buffer.from(code); changed[4] ^= 1; write(f.root, prefix + '/engine.wasm', changed);
  await assert.rejects(Inputs.prepare(f.options), /checksum/);
});
test('actual ASAR and unpacked/resource trees reject files absent from the source map', async t => {
  const f = fixture(t), selected = await Inputs.prepare(f.options), assembly = path.join(f.root, 'assembly'), resources = path.join(f.root, 'Resources');
  const transformer = require('app-builder-lib/out/fileTransformer').createTransformer(f.root, f.packageConfig.build);
  for (const [name, record] of selected.asar) write(assembly, name, await transformer(record.source) || fs.readFileSync(record.source));
  fs.mkdirSync(resources); write(resources, 'icon.png', 'image');
  const archive = path.join(resources, 'app.asar'); await finished(await require('@electron/asar').createPackage(assembly, archive));
  assert.equal(Inputs.verifyContents(selected, { archive, resources, requireHost: false }).archiveFiles, 2);
  write(resources, 'app.asar.unpacked/src/main/unlisted.js', 'injected');
  assert.throws(() => Inputs.verifyContents(selected, { archive, resources, requireHost: false }), /unlisted unpacked/);
  fs.rmSync(path.join(resources, 'app.asar.unpacked'), { recursive: true }); write(resources, 'unlisted.txt', 'injected');
  assert.throws(() => Inputs.verifyContents(selected, { archive, resources, requireHost: false }), /unlisted resource/);
  fs.rmSync(path.join(resources, 'unlisted.txt')); write(assembly, 'src/main/injected.js', 'injected');
  await finished(await require('@electron/asar').createPackage(assembly, archive));
  assert.throws(() => Inputs.verifyContents(selected, { archive, resources, requireHost: false }), /without a source, supplier or Builds record/);
});
test('renderer output records bind real module sources and reject stale or injected output', t => {
  const f = fixture(t), source = write(f.root, 'src/renderer/src/main.js', 'source'), output = write(f.root, 'dist/renderer/index.html', '<html>output</html>');
  const plugin = Inputs.rendererPlugin(); plugin.configResolved({ root: path.join(f.root, 'src/renderer'), build: { outDir: path.join(f.root, 'dist/renderer') } });
  plugin.transform('', source);
  // Rolldown provides no getWatchFiles; consumed transform inputs still bind outputs.
  plugin.writeBundle.call({ getModuleIds: () => [source] }, {}, { 'index.html': {} });
  f.packageConfig.build.files.push('dist/renderer/**'); f.options.requireRenderer = true;
  assert.equal(Inputs.expectedSelections(f.options).asar.get('dist/renderer/index.html').owner, 'renderer');
  write(f.root, 'dist/renderer/injected.js', 'injected');
  assert.throws(() => Inputs.expectedSelections(f.options), /absent from its build map/);
  fs.rmSync(path.join(f.root, 'dist/renderer/injected.js')); fs.writeFileSync(source, 'changed');
  assert.throws(() => Inputs.expectedSelections(f.options), /Renderer source changed/);
  assert.throws(() => plugin.writeBundle.call({ getModuleIds: () => [source] }, {}, { 'index.html': {} }), /Renderer source changed while it was being built/);
});

test('resource aliases verify through relative CLI paths and reject redirected targets', async t => {
  const f = fixture(t), selected = await Inputs.prepare(f.options), assembly = path.join(f.root, 'assembly'), resources = path.join(f.root, 'Resources');
  const transformer = require('app-builder-lib/out/fileTransformer').createTransformer(f.root, f.packageConfig.build);
  for (const [name, record] of selected.asar) write(assembly, name, await transformer(record.source) || fs.readFileSync(record.source));
  write(resources, 'icon.png', 'image');
  write(resources, 'python/bin/python3', 'image');
  fs.symlinkSync('python3', path.join(resources, 'python/bin/python'));
  selected.resources.set('python/bin/python3', selected.resources.get('icon.png'));
  selected.resources.set('python/bin/python', { ...selected.resources.get('icon.png'), aliasTarget: 'python3' });
  const archive = path.join(resources, 'app.asar');
  await finished(await require('@electron/asar').createPackage(assembly, archive));
  const options = { archive: path.relative(process.cwd(), archive), resources: path.relative(process.cwd(), resources), requireHost: false };
  assert.equal(Inputs.verifyContents(selected, options).resourceFiles, 3);
  const alias = path.join(resources, 'python/bin/python');
  fs.unlinkSync(alias); fs.symlinkSync('../bin/python3', alias);
  assert.throws(() => Inputs.verifyContents(selected, options), /alias differs/);
  fs.unlinkSync(alias); fs.symlinkSync('python3', alias);
  const canonical = path.join(resources, 'python/bin/python3');
  fs.unlinkSync(canonical); write(f.root, 'outside-python', 'image'); fs.symlinkSync(path.join(f.root, 'outside-python'), canonical);
  assert.throws(() => Inputs.verifyContents(selected, options), /alias differs/);
});
