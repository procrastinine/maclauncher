const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gzipSync, gunzipSync } = require('node:zlib');
const B = require('../src/modules/shared/runtime/bundled-native');
const P = require('../scripts/native-payload.cjs');
const Model = require('../scripts/distribution-model.cjs');
const R = require('../scripts/runtime-packages.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
const bytesEntry = (name, bytes, mode = 0o644) => ({ name, bytes, size: bytes.length, sha256: B.digest(bytes), mode });
const repository = 'example/runtime-builds';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'runtime-packages-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = Buffer.from('Corresponding source fixture\n'), sourceName = '1.0-source.tar.gz';
  const sourceArtifact = { directoryRelative: `runtime-fixture/${sourceName}`, sha256: B.digest(source), bytes: source.length };
  const manager = { id: 'runtime-fixture', distributionRequired: true, distributionVersions: ['1.0'],
    core: { catalog: [{ version: '1.0', upstreamRevision: 'a'.repeat(40), localBuild: true, sourceArtifact }] } };
  const dependencies = { managers: () => new Map([[manager.id, manager]]), supplementals: () => [],
    loadCommands: () => ({ minimumMacOS: '13.0' }), links: () => [], libraryIds: () => [], verifySignature() {} };
  const runner = Buffer.alloc(32);
  runner.writeUInt32LE(0xfeedfacf); runner.writeUInt32LE(0x0100000c, 4); runner.writeUInt32LE(2, 12);
  const notice = Buffer.from('Synthetic license notice\n');
  const payload = [bytesEntry('bin/runner', runner, 0o755), bytesEntry('licenses/LICENSE', notice)];
  const manifest = { schemaVersion: 1, managerId: manager.id, version: '1.0', upstreamRevision: 'a'.repeat(40),
    platform: 'darwin', arch: 'arm64', minimumMacOS: '13.0', executableRelative: 'bin/runner',
    files: payload.map(({ name, bytes, ...record }) => ({ path: name, ...record,
      ...(name === 'bin/runner' ? { architectures: ['arm64'] } : {}) })),
    dependencies: [{ file: 'bin/runner', links: ['/usr/lib/libSystem.B.dylib'] }],
    notices: [{ name: 'Fixture', license: 'Synthetic', sourceUrl: 'https://example.invalid/source', path: 'licenses/LICENSE' }],
    provenance: { sourceRevision: 'a'.repeat(40), verifiedBuild: true }, signature: { identity: '-', verified: true } };
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
  const files = [bytesEntry('manifest.json', manifestBytes), ...payload.map(entry => ({ ...entry, name: 'files/' + entry.name }))];
  const declaration = { id: manager.id, version: '1.0', arch: 'arm64', launcherArchitectures: ['arm64'],
    directoryRelative: 'runtime-fixture/1.0/arm64', sourceArtifact,
    notices: [{ name: 'Fixture', license: 'Synthetic', path: 'files/licenses/LICENSE' }],
    minimumMacOS: '13.0', manifestRelative: 'manifest.json', manifestSha256: B.digest(manifestBytes), sourceSha256: 'b'.repeat(64),
    files: files.map(({ name, bytes, ...record }) => ({ path: name, ...record })) };
  const f = { root, source, sourceName, manager, dependencies, declaration, files, arch: 'arm64', maximumMacOS: '13.0' };
  f.archive = path.join(root, 'runtime-fixture-1.0-arm64.tar.gz');
  await writePackage(f, declaration, files, f.archive);
  const tag = 'runtime-fixture/v1.0/arm64', url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/`;
  f.record = { schemaVersion: 2, id: manager.id, version: '1.0', arch: 'arm64', launcherArchitectures: ['arm64'], minimumMacOS: '13.0',
    manifestRelative: 'manifest.json', manifestSha256: declaration.manifestSha256, sourceSha256: declaration.sourceSha256,
    updatePolicy: 'manual', tag, asset: { filename: path.basename(f.archive), url: url + path.basename(f.archive),
      sha256: await P.checksum(f.archive), bytes: fs.statSync(f.archive).size },
    sourceAsset: { filename: sourceName, url: url + sourceName, sha256: sourceArtifact.sha256, bytes: source.length } };
  f.lock = { schemaVersion: 1, repository, arch: f.arch, maximumMacOS: f.maximumMacOS, packages: [f.record] };
  f.plan = Model.createPlan({ arch: f.arch, maximumMacOS: f.maximumMacOS, dependencies });
  return f;
}
async function writePackage(f, declaration, files = f.files, output = path.join(f.root, 'changed.tar.gz')) {
  const bytes = Buffer.from(JSON.stringify(declaration) + '\n');
  await P.writeArchive([bytesEntry('runtime-package.json', bytes), ...files.map(entry => ({ ...entry, name: 'files/' + entry.name }))], output);
  return output;
}
async function archiveRecord(f, archive) {
  return { ...f.record, asset: { ...f.record.asset, bytes: fs.statSync(archive).size, sha256: await P.checksum(archive) } };
}
function destination(f, name = 'extracted') {
  const output = path.join(f.root, name); fs.mkdirSync(output); return output;
}
function checksumHeader(header) {
  header.fill(32, 148, 156);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
}

test('application locks select only complete compatible packages and matching source assets', async t => {
  const f = await fixture(t);
  assert.equal(R.validateLock(f.lock, { dependencies: f.dependencies }).packages.length, 1);
  for (const mutate of [
    lock => { lock.packages = []; },
    lock => { lock.packages.push(clone(lock.packages[0])); },
    lock => { lock.repository = 'different/builds'; },
    lock => { lock.packages[0].minimumMacOS = '14.0'; },
    lock => { lock.packages[0].launcherArchitectures = ['x64']; },
    lock => { lock.packages[0].sourceAsset.sha256 = 'c'.repeat(64); },
    lock => { lock.packages[0].sourceAsset.bytes++; },
    lock => { lock.packages[0].sourceAsset.filename = 'different-source.tar.gz'; }
  ]) {
    const lock = clone(f.lock); mutate(lock);
    assert.throws(() => R.validateLock(lock, { dependencies: f.dependencies }), /package lock|runtime|source download|corresponding source/i);
  }
});

test('catalog lock creation requires the selected version and reads only declared catalogs', async t => {
  const f = await fixture(t), catalogs = path.join(f.root, 'catalogs'); fs.mkdirSync(catalogs);
  const file = path.join(catalogs, f.manager.id + '.json');
  const catalog = { schemaVersion: 2, projectId: f.manager.id, updatePolicy: 'manual', packages: [f.record] };
  fs.writeFileSync(file, JSON.stringify(catalog));
  const options = { catalogs, arch: f.arch, maximumMacOS: f.maximumMacOS, repository, dependencies: f.dependencies };
  assert.deepEqual(R.createLock(options), R.validateLock(f.lock, { dependencies: f.dependencies }));
  catalog.packages = []; fs.writeFileSync(file, JSON.stringify(catalog));
  assert.throws(() => R.createLock(options), /Missing published package/);
});

test('package extraction restores exact nested bytes and executable permissions', async t => {
  const f = await fixture(t), output = destination(f);
  assert.deepEqual(await R.extractPackage(f.archive, output, f.record), f.declaration);
  assert.equal(B.verifyPayload(output, f.declaration), true);
  assert.equal(fs.statSync(path.join(output, 'files/bin/runner')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(output, 'manifest.json')).mode & 0o777, 0o644);
});

test('package archive identity is checked before writing any file', async t => {
  const f = await fixture(t);
  for (const field of ['sha256', 'bytes']) {
    const record = clone(f.record); record.asset[field] = field === 'sha256' ? '0'.repeat(64) : record.asset.bytes + 1;
    const output = destination(f, field);
    await assert.rejects(R.extractPackage(f.archive, output, record), /checksum|size/);
    assert.deepEqual(fs.readdirSync(output), []);
  }
});

test('package declaration must match every locked wrapper identity', async t => {
  const f = await fixture(t);
  for (const [index, field] of ['id', 'version', 'arch', 'minimumMacOS', 'directoryRelative', 'manifestRelative', 'manifestSha256', 'sourceSha256', 'launcherArchitectures'].entries()) {
    const declaration = clone(f.declaration);
    declaration[field] = field === 'launcherArchitectures' ? ['x64'] : 'different';
    const archive = await writePackage(f, declaration, f.files, path.join(f.root, `identity-${index}.tar.gz`));
    await assert.rejects(R.extractPackage(archive, destination(f, `identity-${index}`), await archiveRecord(f, archive)), /locked runtime identity/);
  }
});

test('package wrappers retain the matching corresponding-source identity', async t => {
  const f = await fixture(t);
  for (const [index, mutate] of [
    declaration => { declaration.sourceArtifact.sha256 = 'c'.repeat(64); },
    declaration => { declaration.sourceArtifact.bytes++; },
    declaration => { declaration.sourceArtifact.directoryRelative = 'runtime-fixture/different-source.tar.gz'; },
    declaration => { delete declaration.sourceArtifact; }
  ].entries()) {
    const declaration = clone(f.declaration); mutate(declaration);
    const archive = await writePackage(f, declaration, f.files, path.join(f.root, `source-${index}.tar.gz`));
    await assert.rejects(R.extractPackage(archive, destination(f, `source-${index}`), await archiveRecord(f, archive)), /source|inventory|manifest|locked runtime identity/i);
  }
});

test('sealed members reject changed bytes, missing members, duplicates and wrong modes', async t => {
  const f = await fixture(t);
  const runner = f.files.find(entry => entry.name === 'files/bin/runner');
  const variants = [
    f.files.map(entry => entry === runner ? bytesEntry(entry.name, Buffer.alloc(entry.size, 1), entry.mode) : entry),
    f.files.filter(entry => entry !== runner),
    [...f.files, runner],
    f.files.map(entry => entry === runner ? { ...entry, mode: 0o644 } : entry)
  ];
  for (const [index, files] of variants.entries()) {
    const archive = await writePackage(f, f.declaration, files, path.join(f.root, `sealed-${index}.tar.gz`));
    await assert.rejects(R.extractPackage(archive, destination(f, `sealed-${index}`), await archiveRecord(f, archive)), /checksum|incomplete|Repeated|member/);
  }
});

test('portable archive safety rejects traversal and symbolic link members with valid outer hashes', async t => {
  const f = await fixture(t), bytes = gunzipSync(fs.readFileSync(f.archive));
  const first = P.parseHeader(bytes.subarray(0, 512));
  const offset = 512 + Math.ceil(first.size / 512) * 512;
  for (const kind of ['traversal', 'link']) {
    const changed = Buffer.from(bytes), header = changed.subarray(offset, offset + 512);
    if (kind === 'traversal') { header.fill(0, 0, 100); header.write('../escape', 0); }
    else { header[156] = 50; header.write('outside', 157); }
    checksumHeader(header);
    const archive = path.join(f.root, kind + '.tar.gz'); fs.writeFileSync(archive, gzipSync(changed));
    await assert.rejects(R.extractPackage(archive, destination(f, kind), await archiveRecord(f, archive)), /Unsafe|regular files only/);
    assert.equal(fs.existsSync(path.join(f.root, 'escape')), false);
  }
});

test('archive symlinks cannot substitute for the selected regular download', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'archive-alias.tar.gz'); fs.symlinkSync(f.archive, alias);
  await assert.rejects(R.extractPackage(alias, destination(f), f.record), /regular|identity|symbolic|symlink|checksum|size/i);
});

test('explicit package fetch reuses immutable resources and retains corresponding source downloads in inventory', async t => {
  const f = await fixture(t), repoRoot = path.join(f.root, 'app'), requested = [];
  const dependencies = { model: f.dependencies, download: async (url, output) => {
    requested.push(url); assert.equal(url, f.record.asset.url); fs.copyFileSync(f.archive, output);
  } };
  const first = await R.fetchPackages({ lock: f.lock, repoRoot, dependencies });
  assert.equal(first.packages, 1);
  assert.equal(first.inventory.packageRepository, repository);
  assert.deepEqual(first.inventory.projectPackages, R.validateLock(f.lock, { dependencies: f.dependencies }).packages);
  assert.deepEqual(first.inventory.sourceArtifacts, f.plan.sourceArtifacts);
  const runtime = path.join(repoRoot, 'src/resources/native-runtimes/runtime-fixture/1.0/arm64');
  assert.equal(B.verifyPayload(runtime, f.declaration), true);
  await R.fetchPackages({ lock: f.lock, repoRoot, dependencies });
  assert.deepEqual(requested, [f.record.asset.url]);
  const runner = path.join(runtime, 'files/bin/runner'); fs.chmodSync(runner, 0o644);
  await assert.rejects(R.fetchPackages({ lock: f.lock, repoRoot, dependencies }), /checksum|permissions/);
  assert.equal(fs.statSync(runner).mode & 0o777, 0o644, 'an existing installed resource is preserved');
  assert.ok(fs.readdirSync(path.dirname(runtime)).every(name => !name.startsWith('.install-')));
});

test('corrupt downloaded archives do not publish resources or leave extraction stages', async t => {
  const f = await fixture(t), repoRoot = path.join(f.root, 'app');
  const dependencies = { model: f.dependencies, download: async (_url, output) => fs.writeFileSync(output, 'changed download') };
  await assert.rejects(R.fetchPackages({ lock: f.lock, repoRoot, dependencies }), /checksum|size/);
  const parent = path.join(repoRoot, 'src/resources/native-runtimes/runtime-fixture/1.0');
  assert.ok(fs.readdirSync(parent).every(name => !name.startsWith('.install-') && name !== 'arm64'));
});

test('failed member verification retires partially extracted stages without publishing them', async t => {
  const f = await fixture(t), repoRoot = path.join(f.root, 'app');
  const files = f.files.map(entry => entry.name === 'files/bin/runner'
    ? bytesEntry(entry.name, Buffer.alloc(entry.size, 1), entry.mode) : entry);
  const archive = await writePackage(f, f.declaration, files);
  const lock = { ...f.lock, packages: [await archiveRecord(f, archive)] };
  const dependencies = { model: f.dependencies, download: async (_url, output) => fs.copyFileSync(archive, output) };
  await assert.rejects(R.fetchPackages({ lock, repoRoot, dependencies }), /checksum/);
  const parent = path.join(repoRoot, 'src/resources/native-runtimes/runtime-fixture/1.0');
  assert.deepEqual(fs.readdirSync(parent), []);
});
