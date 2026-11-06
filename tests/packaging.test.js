const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Model = require('../scripts/distribution-model.cjs');
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
test('beforePack applies explicit architecture selection and rejects local-only native resources', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify(packageConfig));
  // Raw Builder stdout can interleave with Node's binary test event stream.
  t.mock.method(require('builder-util').log, 'info', (...args) => t.diagnostic(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')));
  const config = await require('app-builder-lib/out/util/config/config').getConfig(f.root);
  assert.equal(config.extraResources[0].to, undefined);
  const context = { electronPlatformName: 'darwin', arch: require('builder-util').Arch.arm64,
    packager: { config, info: {projectDir:f.root} } };
  let mapped;
  const buildRosettaLibraryLoader = options => { assert.equal(options.output, path.join(f.root, 'src/resources/rosetta-library-load-x64')); };
  t.mock.method(require('../scripts/build-launch-activation.cjs'), 'build', options => { assert.equal(options.repoRoot, f.root);assert.equal(options.arch, 'arm64'); });
  t.mock.method(require('../scripts/app-deduplication.cjs'),'unpackPatterns',input=>{mapped=input;return[];});
  await require('../scripts/before-pack.js')(context, { dependencies: f.dependencies, buildRosettaLibraryLoader, environment: { MACLAUNCHER_NATIVE_MAXIMUM_MACOS: '13.0' } });
  assert.equal(mapped.projectDir,f.root);
  assert.equal(mapped.packageConfig.build, context.packager.config);
  assert.ok(context.packager.config.extraResources[0].filter.includes('native-runtimes/native-example/2.0/arm64/**'));
  assert.equal(context.packager.config.extraResources[0].filter.includes('native-runtimes/**'), false);
  assert.equal(context.packager.config.extraResources[0].filter.includes('native-runtimes/native-example/1.0/arm64/**'), false);
  await assert.rejects(require('../scripts/before-pack.js')({ ...context, arch: 'universal' }, { dependencies: f.dependencies }), /explicitly/);
  assert.throws(() => Model.assertPublishable({ distributionBlockers: [{ resource: 'restricted/1.0/universal' }] }), /restricted to local use/);
});
