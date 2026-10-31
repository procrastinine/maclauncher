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

test('the app lock selects a native build instead of Universal for the same version', () => {
  const universal = { id: 'graphics', version: '1.0', arch: 'universal', launcherArchitectures: ['arm64', 'x64'] };
  const intel = { ...universal, arch: 'x64', launcherArchitectures: ['x64'] };
  const legacy = { ...intel, version: '0.9', launcherArchitectures: ['arm64', 'x64'] };
  const lock = { architectures: ['arm64', 'x64'], packages: [universal, intel, legacy] };
  assert.deepEqual(R.selectArchitecture(lock, 'arm64').packages, [universal, legacy]);
  assert.deepEqual(R.selectArchitecture(lock, 'x64').packages, [intel, legacy]);
  assert.deepEqual(lock.packages, [universal, intel, legacy]);
});

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
  f.lock = { schemaVersion: 2, repository, architectures: [f.arch], maximumMacOS: f.maximumMacOS, packages: [f.record] };
  f.selection = R.selectArchitecture(f.lock, f.arch);
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

test('one lock covers each app architecture with exactly the packages its plan includes', () => {
  // Two included runtimes: one published for Apple Silicon launchers only,
  // one published per CPU. Each app selects the records for its own CPU.
  const manager = (id, distributionArchitectures) => ({ id, distributionRequired: true, distributionVersions: ['1.0'],
    ...(distributionArchitectures ? { distributionArchitectures } : {}),
    core: { catalog: [{ version: '1.0', upstreamRevision: 'a'.repeat(40) }] } });
  const managers = [manager('silicon-only', { arm64: ['arm64'], x64: [] }), manager('per-cpu')];
  const dependencies = { managers: () => new Map(managers.map(item => [item.id, item])), supplementals: () => [] };
  const record = (id, arch) => {
    const tag = `${id}/v1.0/${arch}`, filename = `${id}-1.0-${arch}.tar.gz`;
    return { schemaVersion: 2, id, version: '1.0', arch, launcherArchitectures: [arch], minimumMacOS: '13.0',
      manifestRelative: 'manifest.json', manifestSha256: 'd'.repeat(64), sourceSha256: 'e'.repeat(64), updatePolicy: 'manual', tag,
      asset: { filename, url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}`, sha256: 'f'.repeat(64), bytes: 1 } };
  };
  const lock = { schemaVersion: 2, repository, architectures: ['arm64', 'x64'], maximumMacOS: '13.0',
    packages: [record('per-cpu', 'arm64'), record('per-cpu', 'x64'), record('silicon-only', 'arm64')] };
  assert.equal(R.validateLock(lock, { dependencies }).packages.length, 3);
  const ids = arch => R.validateSelection(R.selectArchitecture(lock, arch), { dependencies }).packages.map(item => `${item.id}/${item.arch}`).sort();
  assert.deepEqual(ids('arm64'), ['per-cpu/arm64', 'silicon-only/arm64']);
  assert.deepEqual(ids('x64'), ['per-cpu/x64']);
  for (const mutate of [
    value => { value.architectures = ['x64', 'arm64']; },
    value => { value.architectures = ['arm64', 'arm64']; },
    value => { value.packages.pop(); },
    value => { value.packages.push(record('unused', 'x64')); },
    value => { value.packages[1].launcherArchitectures = ['arm64']; }
  ]) {
    const changed = clone(lock); mutate(changed);
    assert.throws(() => R.validateLock(changed, { dependencies }), /package lock|runtime/i);
  }
  assert.throws(() => R.selectArchitecture({ ...lock, architectures: ['arm64'] }, 'x64'), /does not cover/);
});

test('catalog lock creation requires the selected version and reads only declared catalogs', async t => {
  const f = await fixture(t), catalogs = path.join(f.root, 'catalogs'); fs.mkdirSync(catalogs);
  const file = path.join(catalogs, f.manager.id + '.json');
  const catalog = { schemaVersion: 2, projectId: f.manager.id, updatePolicy: 'manual', packages: [f.record] };
  fs.writeFileSync(file, JSON.stringify(catalog));
  const options = { catalogs, architectures: [f.arch], maximumMacOS: f.maximumMacOS, repository, dependencies: f.dependencies };
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
  const first = await R.fetchPackages({ lock: f.selection, packageLock: f.lock, repoRoot, dependencies });
  assert.equal(first.packages, 1);
  assert.deepEqual(first.removed, []);
  assert.equal(first.inventory.packageRepository, repository);
  assert.deepEqual(first.inventory.projectPackages, R.validateSelection(f.selection, { dependencies: f.dependencies }).packages);
  assert.deepEqual(first.inventory.sourceArtifacts, f.plan.sourceArtifacts);
  const runtime = path.join(repoRoot, 'src/resources/native-runtimes/runtime-fixture/1.0/arm64');
  assert.equal(B.verifyPayload(runtime, f.declaration), true);
  await R.fetchPackages({ lock: f.selection, packageLock: f.lock, repoRoot, dependencies });
  assert.deepEqual(requested, [f.record.asset.url]);
  const runner = path.join(runtime, 'files/bin/runner'); fs.chmodSync(runner, 0o644);
  await assert.rejects(R.fetchPackages({ lock: f.selection, packageLock: f.lock, repoRoot, dependencies }), /checksum|permissions/);
  assert.equal(fs.statSync(runner).mode & 0o777, 0o644, 'an existing installed resource is preserved');
  assert.ok(fs.readdirSync(path.dirname(runtime)).every(name => !name.startsWith('.install-')));
});

test('stage cleanup retries shared-volume directory-not-empty races without failing the fetch', async t => {
  const f = await fixture(t), repoRoot = path.join(f.root, 'app');
  const dependencies = { model: f.dependencies, download: async (_url, output) => fs.copyFileSync(f.archive, output) };
  const original = fs.rmSync.bind(fs);
  let failures = 0;
  const simulated = t.mock.method(fs, 'rmSync', (target, options) => {
    if (typeof target === 'string' && options?.recursive &&
        path.basename(target).startsWith('.install-') && failures < 2) {
      failures += 1;
      throw Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' });
    }
    return original(target, options);
  });
  const result = await R.fetchPackages({ lock: f.selection, packageLock: f.lock, repoRoot, dependencies });
  assert.equal(result.packages, 1);
  assert.ok(simulated.mock.calls.length >= 3, 'the staged removal is retried before giving up');
  const parent = path.join(repoRoot, 'src/resources/native-runtimes/runtime-fixture/1.0');
  assert.ok(fs.readdirSync(parent).every(name => !name.startsWith('.install-')));
});

test('corrupt downloaded archives do not publish resources or leave extraction stages', async t => {
  const f = await fixture(t), repoRoot = path.join(f.root, 'app');
  const dependencies = { model: f.dependencies, download: async (_url, output) => fs.writeFileSync(output, 'changed download') };
  await assert.rejects(R.fetchPackages({ lock: f.selection, packageLock: f.lock, repoRoot, dependencies }), /checksum|size/);
  const parent = path.join(repoRoot, 'src/resources/native-runtimes/runtime-fixture/1.0');
  assert.ok(fs.readdirSync(parent).every(name => !name.startsWith('.install-') && name !== 'arm64'));
});

test('failed member verification retires partially extracted stages without publishing them', async t => {
  const f = await fixture(t), repoRoot = path.join(f.root, 'app');
  const files = f.files.map(entry => entry.name === 'files/bin/runner'
    ? bytesEntry(entry.name, Buffer.alloc(entry.size, 1), entry.mode) : entry);
  const archive = await writePackage(f, f.declaration, files);
  const lock = { ...f.selection, packages: [await archiveRecord(f, archive)] };
  const dependencies = { model: f.dependencies, download: async (_url, output) => fs.copyFileSync(archive, output) };
  await assert.rejects(R.fetchPackages({ lock, repoRoot, dependencies }), /checksum/);
  const parent = path.join(repoRoot, 'src/resources/native-runtimes/runtime-fixture/1.0');
  assert.deepEqual(fs.readdirSync(parent), []);
});

function installedLayout(t) {
  const repoRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'runtime-packages-prune-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const root = path.join(repoRoot, 'src/resources/native-runtimes'), cache = path.join(repoRoot, 'dist/runtime-downloads');
  const write = (file, bytes = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const install = (id, version, arch, { archive = true } = {}) => {
    write(path.join(root, id, version, arch, 'helper.json'), JSON.stringify({ id, version }));
    if (archive) write(path.join(cache, `${id}-${version}-${arch}.tar.gz`));
  };
  const record = (id, version, arch) => ({ id, version, arch, launcherArchitectures: arch === 'universal' ? ['arm64', 'x64'] : [arch],
    manifestRelative: 'helper.json', asset: { filename: `${id}-${version}-${arch}.tar.gz` } });
  return { repoRoot, root, cache, write, install, record };
}

test('cleanup removes only earlier fetched versions that no architecture in the full lock uses', async t => {
  const f = installedLayout(t), exists = relative => fs.existsSync(path.join(f.repoRoot, relative));
  // Apple Silicon selects 2.0; the Intel app still uses 1.5 from the same folder.
  const lock = { packages: [f.record('helper', '2.0', 'arm64'), f.record('helper', '1.5', 'x64')] };
  const selection = { packages: [lock.packages[0]] };
  f.install('helper', '2.0', 'arm64'); f.install('helper', '1.5', 'x64'); f.install('helper', '1.0', 'universal');
  f.install('helper', '0.9', 'arm64'); f.install('helper', '0.9', 'x64');
  f.install('helper', '0.8-local', 'universal', { archive: false });
  f.install('helper', '0.7', 'universal');
  f.install('other', '1.0', 'universal');
  f.write(path.join(f.root, 'helper/effects/common.fxh'));
  f.write(path.join(f.root, 'helper/0.6/universal.json'));
  f.write(path.join(f.cache, 'helper-0.6-universal.tar.gz'));
  f.write(path.join(f.cache, 'helper-0.5-arm64.tar.gz'));
  f.write(path.join(f.cache, 'notes.txt'));
  fs.symlinkSync(path.join(f.root, 'helper/1.0'), path.join(f.root, 'helper/link'));
  const running = `/usr/bin/game --helper ${path.join(f.root, 'helper/0.7')}/universal/helper.json\n`;
  const removed = await R.pruneUnlockedPackages({ lock, selection, repoRoot: f.repoRoot, processes: running });
  assert.deepEqual(removed.sort(), ['dist/runtime-downloads/helper-0.5-arm64.tar.gz', 'dist/runtime-downloads/helper-0.9-arm64.tar.gz',
    'dist/runtime-downloads/helper-0.9-x64.tar.gz', 'dist/runtime-downloads/helper-1.0-universal.tar.gz',
    'src/resources/native-runtimes/helper/0.9', 'src/resources/native-runtimes/helper/1.0']);
  for (const kept of ['helper/2.0/arm64', 'helper/1.5/x64', 'helper/0.8-local', 'helper/0.7', 'helper/effects', 'helper/0.6', 'other/1.0'])
    assert.ok(exists('src/resources/native-runtimes/' + kept), kept);
  for (const kept of ['helper-2.0-arm64.tar.gz', 'helper-1.5-x64.tar.gz', 'helper-0.7-universal.tar.gz', 'helper-0.6-universal.tar.gz',
    'other-1.0-universal.tar.gz', 'notes.txt'])
    assert.ok(exists('dist/runtime-downloads/' + kept), kept);
  assert.ok(fs.lstatSync(path.join(f.root, 'helper/link')).isSymbolicLink());
  assert.deepEqual(await R.pruneUnlockedPackages({ lock, selection, repoRoot: f.repoRoot, processes: running }), []);
});

test('cleanup keeps every folder of an id with generation leases or when processes cannot be listed', async t => {
  const f = installedLayout(t), lock = { packages: [f.record('helper', '2.0', 'universal')] };
  f.install('helper', '2.0', 'universal'); f.install('helper', '1.0', 'universal');
  assert.deepEqual(R.unlockedPackages({ lock, repoRoot: f.repoRoot, processes: null }), { folders: [], archives: [] });
  f.write(path.join(f.root, 'helper/.generation-leases/1-lease.json'), '{}');
  assert.deepEqual(R.unlockedPackages({ lock, repoRoot: f.repoRoot, processes: '' }), { folders: [], archives: [] });
  fs.rmSync(path.join(f.root, 'helper/.generation-leases/1-lease.json'));
  assert.deepEqual(R.unlockedPackages({ lock, repoRoot: f.repoRoot, processes: '' }).folders, [path.join(f.root, 'helper/1.0')]);
});

test('the stale package hint compares local manifests for this CPU without network access', t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('The hint must stay offline.'); });
  const f = installedLayout(t), manifest = Buffer.from('{"id":"helper","version":"2.0"}\n');
  const arm = { ...f.record('helper', '2.0', 'arm64'), manifestSha256: B.digest(manifest) };
  const intel = { ...f.record('helper', '1.5', 'x64'), manifestSha256: 'a'.repeat(64) };
  const hint = arch => R.includedPackagesHint({ repoRoot: f.repoRoot, arch });
  assert.equal(hint('arm64'), null, 'no lock file means nothing to compare');
  f.write(path.join(f.repoRoot, R.LOCK), JSON.stringify({ architectures: ['arm64', 'x64'], packages: [arm, intel] }));
  const installed = path.join(f.root, 'helper/2.0/arm64/helper.json');
  assert.match(hint('arm64'), /differ from build\/runtime-packages\.json\. Run pnpm install/);
  f.write(installed, manifest);
  assert.equal(hint('arm64'), null);
  assert.match(hint('x64'), /Run pnpm install/, 'the Intel selection is not installed');
  f.write(installed, '{"id":"helper","version":"1.9"}\n');
  assert.match(hint('arm64'), /Run pnpm install/);
  assert.equal(globalThis.fetch.mock.calls.length, 0);
});
