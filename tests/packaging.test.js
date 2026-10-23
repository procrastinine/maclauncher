const { finished } = require("node:stream/promises");
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { deflateRawSync } = require('node:zlib');
const Model = require('../scripts/distribution-model.cjs');
const Check = require('../scripts/check-packaging.cjs');
const Payload = require('../scripts/native-payload.cjs');
const B = require('../src/modules/shared/runtime/bundled-native');
const packageConfig = require('../package.json');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'packaging-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourceRoot = path.join(root, 'native'), manager = { id: 'native-example', distributionRequired: true, distributionVersions: ['2.0'],
    getState: () => ({ catalog: { recommendedVersion: '2.0' } }), delivery: { included: 'direct', catalog: 'remote', sourceBuild: true },
    installRuntime() {}, refreshCatalog() {}, core: { catalog: ['1.0', '2.0'].map(version => ({ version, upstreamRevision: 'a'.repeat(40) })) } };
  const dependencies = { managers: () => new Map([[manager.id, manager]]), supplementals: () => [],
    loadCommands: () => ({ minimumMacOS: '13.0' }), verifySignature() {},
    readMachOLoadCommands: () => ({ architectures: ['arm64'], slices: [{ minimumMacOS: '13.0' }] }) };
  for (const version of ['1.0', '2.0']) {
    const directory = path.join(resourceRoot, manager.id, version, 'arm64'), files = path.join(directory, 'files');
    fs.mkdirSync(path.join(files, 'licenses'), { recursive: true }); fs.mkdirSync(path.join(files, 'bin'));
    const runner = Buffer.alloc(32); runner.writeUInt32LE(0xfeedfacf); runner.writeUInt32LE(0x0100000c, 4); runner.writeUInt32LE(2, 12);
    fs.writeFileSync(path.join(files, 'bin/runner'), runner, { mode: 0o755 });
    fs.writeFileSync(path.join(files, 'licenses/LICENSE'), 'Synthetic license notice');
    const manifest = { schemaVersion: 1, managerId: manager.id, version, upstreamRevision: 'a'.repeat(40), platform: 'darwin', arch: 'arm64',
      minimumMacOS: '13.0', executableRelative: 'bin/runner', files: B.fileInventory(files).map(name => {
        const { bytes, ...record } = B.readRegular(path.join(files, name), 1024);
        return { path: name, ...record, ...(name === 'bin/runner' ? { architectures: ['arm64'] } : {}) };
      }), dependencies: [{ file: 'bin/runner', links: ['/usr/lib/libSystem.B.dylib'] }],
      notices: [{ name: 'Synthetic runtime', license: 'Test fixture', sourceUrl: 'https://example.invalid/source', path: 'licenses/LICENSE' }],
      provenance: { sourceRevision: 'a'.repeat(40) }, signature: { identity: '-', verified: true } };
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  }
  return { root, resourceRoot, manager, dependencies, arch: 'arm64', maximumMacOS: '13.0' };
}
function plan(f) { return Model.createPlan(f); }

test('distribution selection excludes obsolete versions without weakening the full local audit', async t => {
  const f = fixture(t), old = path.join(f.resourceRoot, f.manager.id, '1.0/arm64/manifest.json');
  fs.writeFileSync(old, 'Damaged obsolete package');
  assert.deepEqual(plan(f).packages.map(item => item.version), ['2.0']);
  assert.equal(Check.verifySource(f).packages.length, 1);
  const output = path.join(f.root, 'payload.tar.gz'), result = await Payload.exportPayload({ ...f, output });
  assert.deepEqual(result.inventory.packages.map(item => item.version), ['2.0']);
  const destination = path.join(f.root, 'published');
  await Payload.importPayload({ ...f, archive: output, sha256: result.sha256, resourceRoot: destination });
  assert.deepEqual(fs.readdirSync(path.join(destination, f.manager.id)), ['2.0']);
  assert.equal(fs.readFileSync(old, 'utf8'), 'Damaged obsolete package');
  assert.throws(() => require('../scripts/verify-native-runtimes.cjs').verifyPackages(f), /JSON/);
});
test('explicit compatibility versions and artifact CPU mappings remain in the same delivery plan', t => {
  const f = fixture(t); f.manager.distributionVersions = ['1.0', '2.0'];
  f.manager.distributionArchitectures = { arm64: ['x64'], x64: [] };
  const p = plan(f);
  assert.deepEqual(p.packages.map(item => [item.version, item.arch]), [['1.0', 'x64'], ['2.0', 'x64']]);
  assert.equal(p.runtimes[0].includedExecution, 'direct'); assert.equal(p.runtimes[0].sourceBuild, true);
  assert.equal(p.runtimes[0].download.catalogQuery, true);
  f.manager.distributionVersions.push('2.0'); assert.throws(() => plan(f), /ambiguous/);
  f.manager.distributionVersions = ['../old']; assert.throws(() => plan(f), /outside its pinned catalog/);
});
test('CI source packaging checks validate runtime-only inventories without fetching corresponding sources', async t => {
  const f = fixture(t);
  f.manager.core.catalog.find(pin => pin.version === '2.0').sourceArtifact = {
    directoryRelative: 'native-example/2.0-source.tar.gz', sha256: 'c'.repeat(64), bytes: 123
  };
  const output = path.join(f.root, 'runtime-only.tar.gz');
  const { inventory } = await Payload.exportPayload({ ...f, output,
    sourceDownload: { url: 'https://example.invalid/sources.tar.gz', sha256: 'd'.repeat(64) } });
  fs.rmSync(path.join(f.resourceRoot, f.manager.id, '1.0'), { recursive: true });
  assert.equal(Check.verifySource({ ...f, inventory }).correspondingSourceCount, 1);
  assert.throws(() => Check.verifySource({ ...f, inventory: { ...inventory, sourceArtifacts: [] } }), /Corresponding-source archives differ/);
  assert.throws(() => Check.verifySource(f));
});
test('actual Electron Builder filters include only the selected native set and exclude private inputs', t => {
  const f = fixture(t), p = plan(f);
  require('../scripts/native-supplementals.cjs').validatePublicMetadata(p);
  assert.deepEqual(Check.configurationCheck(p, packageConfig), { applicationRules: 1, resourceRules: 4 });
  const unsafe = structuredClone(packageConfig); unsafe.build.files = ['**/*'];
  assert.throws(() => Check.configurationCheck(p, unsafe), /excluded input/);
  const resources = structuredClone(packageConfig);
  resources.build.extraResources[0].filter = ['native-runtimes/**', 'python/**'];
  assert.throws(() => Check.configurationCheck(Model.createPlan({ ...f, packageConfig: resources }), resources), /excluded data/);
  const rules = Model.resourceRules(p);
  assert.equal(rules[0].filter.includes('native-runtimes/**'), false);
  assert.ok(rules[0].filter.includes('native-runtimes/native-example/2.0/arm64/**'));
  assert.deepEqual(Model.resourceRules({ ...p, resourceRules: rules }), rules);
});
test('beforePack applies explicit architecture selection and rejects local-only native resources', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify(packageConfig));
  const config = await require('app-builder-lib/out/util/config/config').getConfig(f.root);
  assert.equal(config.extraResources[0].to, undefined);
  const context = { electronPlatformName: 'darwin', arch: require('builder-util').Arch.arm64,
    packager: { config } };
  await require('../scripts/before-pack.js')(context, { dependencies: f.dependencies, environment: { MACLAUNCHER_NATIVE_MAXIMUM_MACOS: '13.0' } });
  assert.ok(context.packager.config.extraResources[0].filter.includes('native-runtimes/native-example/2.0/arm64/**'));
  assert.equal(context.packager.config.extraResources[0].filter.includes('native-runtimes/**'), false);
  assert.equal(context.packager.config.extraResources[0].filter.includes('native-runtimes/native-example/1.0/arm64/**'), false);
  await assert.rejects(require('../scripts/before-pack.js')({ ...context, arch: 'universal' }, { dependencies: f.dependencies }), /explicitly/);
  assert.throws(() => Model.assertPublishable({ distributionBlockers: [{ resource: 'restricted/1.0/universal' }] }), /restricted to local use/);
});
test('application inventory permits contained framework links and rejects escaping links and diagnostics', t => {
  const f = fixture(t), app = path.join(f.root, 'MacLauncher.app'); fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'runner'), 'Synthetic executable'); fs.symlinkSync('runner', path.join(app, 'current'));
  assert.deepEqual(Check.appTree(app).files, ['current', 'runner']);
  fs.symlinkSync('../outside', path.join(app, 'escape')); fs.writeFileSync(path.join(f.root, 'outside'), 'External file');
  assert.throws(() => Check.appTree(app), /escapes/); fs.unlinkSync(path.join(app, 'escape'));
  fs.writeFileSync(path.join(app, 'session.log'), 'Private diagnostic'); assert.throws(() => Check.appTree(app), /excluded file/);
});
async function appFixture(t) {
  const f = fixture(t), appPath = path.join(f.root, 'MacLauncher.app'), resources = path.join(appPath, 'Contents/Resources');
  fs.mkdirSync(resources, { recursive: true }); fs.mkdirSync(path.join(appPath, 'Contents/MacOS'));
  fs.writeFileSync(path.join(appPath, 'Contents/Info.plist'), 'Synthetic application metadata');
  fs.writeFileSync(path.join(appPath, 'Contents/MacOS/MacLauncher'), 'Synthetic launcher image');
  const source = path.join(f.root, 'asar-source'); fs.mkdirSync(path.join(source, 'dist/renderer'), { recursive: true });
  fs.mkdirSync(path.join(source, 'src/main'), { recursive: true });
  fs.writeFileSync(path.join(source, 'dist/renderer/index.html'), '<html></html>'); fs.writeFileSync(path.join(source, 'src/main/bootstrap.js'), 'module.exports = {};');
  const packageFile = path.join(source, 'package.json');
  fs.writeFileSync(packageFile, JSON.stringify(packageConfig));
  const transformed = await require('app-builder-lib/out/fileTransformer').createTransformer(source, packageConfig.build)(packageFile);
  assert.equal(typeof transformed, 'string');
  fs.writeFileSync(packageFile, transformed);
  await finished(await require('@electron/asar').createPackage(source, path.join(resources, 'app.asar')));
  const result = await Payload.exportPayload({ ...f, output: path.join(f.root, 'payload.tar.gz') });
  fs.cpSync(path.join(f.resourceRoot, f.manager.id, '2.0'), path.join(resources, 'native-runtimes', f.manager.id, '2.0'), { recursive: true });
  const metadata = { CFBundleDisplayName: packageConfig.build.productName, CFBundleIdentifier: packageConfig.build.appId,
    CFBundleShortVersionString: packageConfig.version, LSMinimumSystemVersion: packageConfig.build.mac.minimumSystemVersion, CFBundleExecutable: 'MacLauncher' };
  const tool = executable => executable.endsWith('plutil') ? JSON.stringify(metadata) : '';
  return { ...f, appPath, inventory: result.inventory, tool, metadata };
}
test('packaged identity survives Electron Builder metadata cleanup and rejects changed products or versions', async t => {
  const f = await appFixture(t), asar = require('@electron/asar');
  const source = path.join(f.root, 'asar-source'), packageFile = path.join(source, 'package.json');
  const packed = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert.equal(packed.build, undefined);
  assert.equal(packed.devDependencies, undefined);
  assert.equal(packed.productName, packageConfig.build.productName);
  assert.equal(Check.verifyApp(f).passed, true);
  const archive = path.join(f.appPath, 'Contents/Resources/app.asar');
  for (const changed of [{ ...packed, version: '0.0.0' }, { ...packed, productName: 'OtherApp' }]) {
    fs.writeFileSync(packageFile, JSON.stringify(changed));
    await finished(await asar.createPackage(source, archive));
    assert.throws(() => Check.verifyApp(f), /version or product/);
  }
});
test('ASAR links retain relative directory aliases and reject missing, cyclic or external targets', async t => {
  const f = await appFixture(t), asar = require('@electron/asar'), source = path.join(f.root, 'asar-source');
  fs.symlinkSync('src/main', path.join(source, 'mainAlias'));
  fs.symlinkSync('mainAlias/bootstrap.js', path.join(source, 'bootstrapAlias'));
  const archive = path.join(f.root, 'links.asar'); await finished(await asar.createPackage(source, archive));
  assert.equal(Check.inspectAsar(archive, plan(f)).archiveLinks, 2);
  const raw = asar.getRawHeader(archive), bytes = fs.readFileSync(archive);
  const { Pickle } = require(path.join(path.dirname(require.resolve('@electron/asar')), 'pickle.js'));
  function rewrite(change) {
    const header = structuredClone(raw.header); change(header);
    const pickle = Pickle.createEmpty(); pickle.writeString(JSON.stringify(header));
    const size = Pickle.createEmpty(); size.writeUInt32(pickle.toBuffer().length);
    fs.writeFileSync(archive, Buffer.concat([size.toBuffer(), pickle.toBuffer(), bytes.subarray(8 + raw.headerSize)]));
  }
  for (const target of ['../outside', '/outside', '.local/config.json', 'missing', 'package.json/child']) {
    rewrite(header => { header.files.mainAlias.link = target; });
    assert.throws(() => Check.inspectAsar(archive, plan(f)), /unsafe.*path|relative|excluded|missing its target|crosses a file/i);
  }
  rewrite(header => { header.files.mainAlias.link = 'bootstrapAlias'; header.files.bootstrapAlias.link = 'mainAlias'; });
  assert.throws(() => Check.inspectAsar(archive, plan(f)), /cyclic link/);
  rewrite(header => { header.files.mainAlias.link = 'mainAlias/child'; });
  assert.throws(() => Check.inspectAsar(archive, plan(f)), /cyclic link/);
  rewrite(header => { header.files.mainAlias = { files: {}, link: 'src/main' }; });
  assert.throws(() => Check.inspectAsar(archive, plan(f)), /invalid type/);
  fs.writeFileSync(archive, bytes);
  assert.equal(Check.inspectAsar(archive, plan(f)).archiveLinks, 2);
  const oversized = Buffer.from(bytes); oversized.writeUInt32LE(Check.LIMITS.headerBytes + 1, 4); fs.writeFileSync(archive, oversized);
  assert.throws(() => Check.inspectAsar(archive, plan(f)), /header.*limit/);
});
test('built application checks reject wrong identities, native corruption, extra copies and signatures', async t => {
  const f = await appFixture(t);
  assert.equal(Check.verifyApp(f).nativePackages, 1);
  f.metadata.CFBundleShortVersionString = '0.0.0'; assert.throws(() => Check.verifyApp(f), /Info.plist/);
  f.metadata.CFBundleShortVersionString = packageConfig.version;
  assert.throws(() => Check.verifyApp({ ...f, tool(executable) { if (executable.endsWith('codesign')) throw new Error('Bad app signature'); return f.tool(executable); } }), /Bad app signature/);
  const extra = path.join(f.appPath, 'Contents/Resources/native-runtimes', f.manager.id, '2.0/arm64/stale.txt');
  fs.writeFileSync(extra, 'Unlisted copy'); assert.throws(() => Check.verifyApp(f), /outside its sealed payload/); fs.unlinkSync(extra);
  const runner = path.join(path.dirname(extra), 'files/bin/runner'); fs.writeFileSync(runner, Buffer.alloc(32));
  assert.throws(() => Check.verifyApp(f), /checksum|architecture|SHA-256/i);
});

// Small standard ZIPs exercise integrity checks without copying a real runtime.
function zipBytes(items) {
  const local = [], central = []; let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name), bytes = item.bytes || Buffer.alloc(0), compressed = item.method === 8 ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(item.method || 0, 8);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(item.method || 0, 10);
    record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((item.mode || 0o100644) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(record, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), footer = Buffer.alloc(22); footer.writeUInt32LE(0x06054b50);
  footer.writeUInt16LE(items.length, 8); footer.writeUInt16LE(items.length, 10); footer.writeUInt32LE(directory.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, footer]);
}
test('zip verification compares every file and link with the verified app without extraction', async t => {
  const f = await appFixture(t), link = path.join(f.appPath, 'Contents/Resources/current'); fs.symlinkSync('app.asar', link);
  const items = Check.appTree(f.appPath).files.map(name => ({ name: `MacLauncher.app/${name}`, method: 8,
    mode: fs.lstatSync(path.join(f.appPath, name)).mode,
    bytes: name.endsWith('/current') ? Buffer.from('app.asar') : fs.readFileSync(path.join(f.appPath, name)) }));
  async function verify(changed) {
    const archive = path.join(f.root, 'app.zip'), bytes = zipBytes(changed); fs.writeFileSync(archive, bytes);
    return Check.verifyZip({ archive, sha256: B.digest(bytes), appPath: f.appPath });
  }
  assert.equal((await verify(items)).comparedFiles, items.length);
  const changed = items.map(item => ({ ...item })); changed[0].bytes = Buffer.alloc(changed[0].bytes.length, 42);
  await assert.rejects(verify(changed), /contents differ/);
  await assert.rejects(verify(items.slice(1)), /missing (?:application files|the application archive)/);
  await assert.rejects(verify([...items, items[0]]), /duplicate paths/);
  await assert.rejects(verify([...items, { name: '../outside', bytes: Buffer.from('Outside') }]), /relative|path/i);
  await assert.rejects(verify([...items, { name: 'other.app/file', bytes: Buffer.from('Other app') }]), /single application/);
  const modeChanged = items.map(item => ({ ...item })); modeChanged.find(item => item.name.endsWith('/MacLauncher')).mode = 0o100755;
  await assert.rejects(verify(modeChanged), /permissions/);
  const linkChanged = items.map(item => ({ ...item })); linkChanged.find(item => item.name.endsWith('/current')).mode = 0o100644;
  await assert.rejects(verify(linkChanged), /preserve an application link/);
});
test('macOS ditto archive preserves verified file bytes, executable modes and relative symlinks', { skip: process.platform !== 'darwin' }, async t => {
  const f = await appFixture(t); fs.symlinkSync('app.asar', path.join(f.appPath, 'Contents/Resources/current'));
  fs.chmodSync(path.join(f.appPath, 'Contents/MacOS/MacLauncher'), 0o755);
  const archive = path.join(f.root, 'ditto.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', f.appPath, archive]);
  assert.equal((await Check.verifyZip({ archive, sha256: await Payload.checksum(archive), appPath: f.appPath })).passed, true);
});
test('packaging CLI refuses unknown, repeated or incomplete options before touching artifacts', async () => {
  for (const args of [['source', '--arch', 'arm64', '--unknown', 'x'], ['source', '--arch', 'arm64', '--arch', 'x64'], ['source', '--maximum-macos']]) {
    await assert.rejects(Check.main(args), /unique packaging-check options/);
  }
});
