const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gzipSync, gunzipSync } = require('node:zlib');
const P = require('../scripts/native-payload.cjs');
const B = require('../src/modules/shared/runtime/bundled-native');
const S = require('../scripts/native-supplementals.cjs');

function fixture(t, artifactArch = 'arm64') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'native-payload-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourceRoot = path.join(root, 'resources'), destination = path.join(root, 'published');
  const manager = { id: 'native-fixture', distributionRequired: true, distributionVersions: ['1.0', '2.0'],
    getState: () => ({ catalog: { recommendedVersion: '2.0' } }),
    core: { catalog: ['1.0', '2.0'].map(version => ({ version, upstreamRevision: 'a'.repeat(40), localBuild: true })) } };
  if (artifactArch === 'x64') manager.distributionArchitectures = { arm64: ['x64'], x64: ['x64'] };
  const dependencies = { managers: () => new Map([[manager.id, manager]]), supplementals: () => [], loadCommands: () => ({ minimumMacOS: '13.0' }),
    links: () => [], libraryIds: () => [], verifySignature() {} };
  for (const version of manager.distributionVersions) {
    const directory = path.join(resourceRoot, manager.id, version, artifactArch), payload = path.join(directory, 'files');
    fs.mkdirSync(path.join(payload, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(payload, 'licenses'));
    const runner = Buffer.alloc(32); runner.writeUInt32LE(0xfeedfacf); runner.writeUInt32LE(artifactArch === 'arm64' ? 0x0100000c : 0x01000007, 4); runner.writeUInt32LE(2, 12);
    fs.writeFileSync(path.join(payload, 'bin/runner'), runner, { mode: 0o755 });
    fs.writeFileSync(path.join(payload, 'licenses/LICENSE'), 'Synthetic fixture license notice', { mode: 0o644 });
    const manifest = { schemaVersion: 1, managerId: manager.id, version, upstreamRevision: 'a'.repeat(40), platform: 'darwin', arch: artifactArch, minimumMacOS: '13.0', executableRelative: 'bin/runner',
      files: B.fileInventory(payload).map(name => ({ path: name, ...B.readRegular(path.join(payload, name), 1024), architectures: name === 'bin/runner' ? [artifactArch === 'arm64' ? 'arm64' : 'x86_64'] : undefined })).map(({ bytes, ...item }) => item),
      dependencies: [{ file: 'bin/runner', links: ['/usr/lib/libSystem.B.dylib'] }],
      notices: [{ name: 'Fixture', license: 'Test fixture', sourceUrl: 'https://example.invalid/source', path: 'licenses/LICENSE' }],
      provenance: { sourceRevision: 'a'.repeat(40), verifiedBuild: true }, signature: { identity: '-', verified: true } };
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  return { root, resourceRoot, destination, manager, dependencies, arch: 'arm64', maximumMacOS: '13.0', output: path.join(root, 'native.tar.gz') };
}
function entries(bytes) {
  const out = []; let offset = 0;
  while (!bytes.subarray(offset, offset + 512).every(byte => byte === 0)) {
    const header = P.parseHeader(bytes.subarray(offset, offset + 512));
    const data = bytes.subarray(offset + 512, offset + 512 + header.size);
    out.push({ ...header, data, offset }); offset += 512 + Math.ceil(header.size / 512) * 512;
  }
  return out;
}
function archiveOf(items) {
  return gzipSync(Buffer.concat([...items.flatMap(item => [P.tarHeader(item.name, item.data.length, item.mode), item.data,
    Buffer.alloc((512 - item.data.length % 512) % 512)]), Buffer.alloc(1024)]));
}
function supplementalFixture(f, executionArchitecture) {
  const arch = executionArchitecture ? 'x64' : 'universal';
  const directoryRelative = `graphics-fixture/1.0/${arch}`, directory = path.join(f.resourceRoot, directoryRelative);
  fs.mkdirSync(directory, { recursive: true });
  const library = Buffer.alloc(executionArchitecture ? 32 : 128);
  if (executionArchitecture) {
    library.writeUInt32LE(0xfeedfacf); library.writeUInt32LE(0x01000007, 4); library.writeUInt32LE(6, 12);
  } else {
    library.writeUInt32BE(0xcafebabe); library.writeUInt32BE(2, 4);
    for (const [index, cpu] of [0x0100000c, 0x01000007].entries()) {
      const table = 8 + 20 * index, offset = 64 + 32 * index;
      library.writeUInt32BE(cpu, table); library.writeUInt32BE(offset, table + 8); library.writeUInt32BE(32, table + 12);
      library.writeUInt32LE(0xfeedfacf, offset); library.writeUInt32LE(cpu, offset + 4); library.writeUInt32LE(6, offset + 12);
    }
  }
  fs.writeFileSync(path.join(directory, 'helper.dylib'), library, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, 'source.c'), 'Synthetic module-owned helper source\n');
  fs.writeFileSync(path.join(directory, 'LICENSE'), 'Synthetic helper license notice\n');
  fs.writeFileSync(path.join(directory, 'helper.json'), JSON.stringify({ version: '1.0', minimumMacOS: '13.0' }));
  const files = B.fileInventory(directory).map(name => {
    const { bytes, ...record } = B.readRegular(path.join(directory, name), 1024);
    return { path: name, ...record, ...(name === 'helper.dylib' ? {
      architectures: executionArchitecture ? ['x86_64'] : ['arm64', 'x86_64'],
      ...(executionArchitecture ? { executionArchitecture } : {}) } : {}) };
  });
  const item = { id: 'graphics-fixture', version: '1.0', arch, launcherArchitectures: ['arm64', 'x64'], minimumMacOS: '13.0',
    sourceRelative: 'source.c', sourceSha256: files.find(file => file.path === 'source.c').sha256, directoryRelative,
    manifestRelative: 'helper.json', manifestSha256: files.find(file => file.path === 'helper.json').sha256, files,
    notices: [{ name: 'Module-owned helper', license: 'Test fixture', path: 'LICENSE' }] };
  f.dependencies.supplementals = () => [item];
  return item;
}
async function changedArchive(f, change) {
  const items = entries(gunzipSync(fs.readFileSync(f.output)));
  const result = change(items) || items, bytes = archiveOf(result), archive = path.join(f.root, 'changed.tar.gz');
  fs.writeFileSync(archive, bytes);
  return { archive, sha256: B.digest(bytes), resourceRoot: f.destination, arch: f.arch, maximumMacOS: f.maximumMacOS, dependencies: f.dependencies };
}

test('complete native exports round-trip exact pins, bytes, modes and notices reproducibly', async t => {
  const f = fixture(t), exported = await P.exportPayload(f);
  assert.equal(exported.inventory.packages.length, 2);
  const second = await P.exportPayload({ ...f, output: path.join(f.root, 'second.tar.gz') });
  assert.equal(second.sha256, exported.sha256);
  const result = await P.importPayload({ ...f, resourceRoot: f.destination, archive: f.output, sha256: exported.sha256 });
  assert.equal(result.published.length, 2);
  for (const version of f.manager.distributionVersions) {
    const from = path.join(f.resourceRoot, f.manager.id, version, 'arm64'), to = path.join(f.destination, f.manager.id, version, 'arm64');
    assert.deepEqual(fs.readFileSync(path.join(to, 'manifest.json')), fs.readFileSync(path.join(from, 'manifest.json')));
    const manifest = JSON.parse(fs.readFileSync(path.join(to, 'manifest.json')));
    assert.equal(B.verifyPayload(path.join(to, 'files'), manifest), true);
  }
  await assert.rejects(P.exportPayload(f), /existing release artifacts/);
});
test('architecture mapping retains genuine Intel artifacts in an ARM launcher payload', async t => {
  const f = fixture(t, 'x64'), exported = await P.exportPayload(f);
  assert.equal(exported.inventory.launcherArch, 'arm64');
  assert.ok(exported.inventory.packages.every(item => item.arch === 'x64'));
  const result = await P.importPayload({ ...f, resourceRoot: f.destination, archive: f.output, sha256: exported.sha256 });
  assert.ok(result.published.every(item => item.arch === 'x64'));
});
test('an explicit unavailable architecture omits only that backend while retaining genuine Intel payloads', async t => {
  const f = fixture(t, 'x64'); f.arch = 'x64';
  const armOnly = { id: 'arm-only-fixture', distributionRequired: true, distributionVersions: ['1.0'],
    distributionArchitectures: { arm64: ['arm64'], x64: [] },
    core: { catalog: [{ version: '1.0', upstreamRevision: 'b'.repeat(40), hostArchitectures: ['arm64'] }] } };
  f.dependencies.managers = () => new Map([[f.manager.id, f.manager], [armOnly.id, armOnly]]);
  assert.ok(P.requirementInventory({ arch: 'arm64', maximumMacOS: '27.0' }, f.dependencies).some(item => item.managerId === armOnly.id && item.arch === 'arm64'));
  assert.ok(P.requirementInventory(f, f.dependencies).every(item => item.managerId === f.manager.id && item.arch === 'x64'));
  const exported = await P.exportPayload(f);
  assert.ok(exported.inventory.packages.every(item => item.managerId === f.manager.id && item.arch === 'x64'));
  const imported = await P.importPayload({ ...f, resourceRoot: f.destination, archive: f.output, sha256: exported.sha256 });
  assert.equal(imported.published.length, 2);
  const { verifyPackages } = require('../scripts/verify-native-runtimes.cjs');
  assert.equal(verifyPackages({ resourceRoot: f.destination, architectures: ['x64'], maximumMacOS: f.maximumMacOS, dependencies: f.dependencies }).length, 2);
  assert.throws(() => verifyPackages({ resourceRoot: f.destination, architectures: ['x64'], managerIds: [armOnly.id], dependencies: f.dependencies }), /No native packages support/);
  assert.equal(fs.existsSync(path.join(f.destination, armOnly.id)), false);
});
test('requirements use declared versions without consulting installed or displayed runtime state', t => {
  const f = fixture(t);
  f.manager.getState = () => assert.fail('Packaging must not consult runtime UI state');
  assert.deepEqual(P.requirementInventory(f, f.dependencies).map(item => item.version), ['1.0', '2.0']);
  delete f.manager.distributionVersions;
  assert.throws(() => P.requirementInventory(f, f.dependencies), /outside its pinned catalog/);
});
test('exports fail for missing canonical versions instead of creating a partial payload', async t => {
  const f = fixture(t); fs.rmSync(path.join(f.resourceRoot, f.manager.id, '2.0'), { recursive: true });
  await assert.rejects(P.exportPayload(f), /Missing required/);
  assert.equal(fs.existsSync(f.output), false);
});
test('archive SHA failure preserves all published resources and occurs before extraction', async t => {
  const f = fixture(t); await P.exportPayload(f);
  fs.mkdirSync(f.destination); fs.writeFileSync(path.join(f.destination, 'sentinel'), 'Existing resource');
  await assert.rejects(P.importPayload({ ...f, resourceRoot: f.destination, archive: f.output, sha256: '0'.repeat(64) }), /checksum or file identity/);
  assert.deepEqual(fs.readdirSync(f.destination), ['sentinel']);
});
test('sealed file corruption, unknown files and duplicate entries fail even with a valid outer archive SHA', async t => {
  for (const mutate of [
    items => { items.find(item => item.name.endsWith('/bin/runner')).data[16] ^= 1; },
    items => [...items, { name: 'unexpected.txt', mode: 0o644, data: Buffer.from('Unexpected') }],
    items => [...items, items[items.length - 1]]
  ]) {
    const f = fixture(t); await P.exportPayload(f);
    const request = await changedArchive(f, mutate);
    await assert.rejects(P.importPayload(request), /checksum|outside its sealed inventory|Duplicate/);
    assert.equal(fs.existsSync(f.destination), false);
  }
});
test('sealed metadata must already be public rather than silently retaining projected diagnostic fields', async t => {
  const f = fixture(t), exported = await P.exportPayload(f);
  const request = await changedArchive(f, items => {
    const entry = items.find(item => item.name.endsWith('/manifest.json'));
    const manifest = JSON.parse(entry.data); manifest.provenance.logPath = 'private-build.log';
    entry.data = Buffer.from(JSON.stringify(manifest));
    const inventory = JSON.parse(items[0].data), record = inventory.packages.find(item => entry.name === `native-runtimes/${item.directoryRelative}/manifest.json`);
    record.manifestSize = entry.data.length; record.manifestSha256 = B.digest(entry.data);
    items[0].data = Buffer.from(JSON.stringify(inventory));
  });
  await assert.rejects(P.importPayload(request), /private diagnostic fields.*Restage/);
  assert.equal(fs.existsSync(f.destination), false);
  const manifestPath = path.join(f.resourceRoot, f.manager.id, '1.0', 'arm64', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath)); manifest.provenance.evidenceSource = 'private-session.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const output = path.join(f.root, 'private-metadata.tar.gz');
  await assert.rejects(P.exportPayload({ ...f, output }), /private diagnostic fields.*Restage/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(await P.checksum(f.output), exported.sha256);
});
test('inventory subsets, changed pins and changed launcher architecture cannot substitute a reviewed full payload', async t => {
  for (const mutate of [
    inventory => inventory.packages.pop(),
    inventory => { inventory.packages[0].upstreamRevision = 'b'.repeat(40); },
    inventory => { inventory.launcherArch = 'x64'; },
    inventory => { inventory.unreviewed = 'extra metadata'; }
  ]) {
    const f = fixture(t); await P.exportPayload(f);
    const request = await changedArchive(f, items => {
      const inventory = JSON.parse(items[0].data); mutate(inventory); items[0].data = Buffer.from(JSON.stringify(inventory));
    });
    await assert.rejects(P.importPayload(request), /Missing required|incorrectly pinned|requested architecture|Unknown native inventory/);
    assert.equal(fs.existsSync(f.destination), false);
  }
});
test('portable tar rejects traversal, links, extensions, invalid checksums and private paths', () => {
  for (const name of ['../escape', '/absolute', 'native-runtimes/.local/game.json', 'payload/build.log', 'payload/__pycache__/file']) assert.throws(() => P.tarHeader(name, 1, 0o644), /Unsafe|private/);
  const header = P.tarHeader('safe/path', 1, 0o644);
  assert.deepEqual(P.parseHeader(header), { name: 'safe/path', size: 1, mode: 0o644 });
  for (const type of [49, 50, 53, 120, 103]) {
    const changed = Buffer.from(header); changed[156] = type; changed.fill(32, 148, 156);
    changed.write(changed.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    assert.throws(() => P.parseHeader(changed), /regular files only/);
  }
  header[1] ^= 1; assert.throws(() => P.parseHeader(header), /checksummed/);
});
test('published fetch allows bounded HTTPS redirects and verifies the exact downloaded archive', async t => {
  const f = fixture(t), exported = await P.exportPayload(f), requested = [];
  f.dependencies.fetch = async (url, options) => {
    requested.push(url); assert.equal(options.redirect, 'manual');
    return requested.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://download.example.invalid/native.tar.gz' } }) : new Response(fs.readFileSync(f.output), { status: 200 });
  };
  const result = await P.importPayload({ ...f, resourceRoot: f.destination, url: 'https://example.invalid/reviewed-native.tar.gz', sha256: exported.sha256 });
  assert.equal(result.published.length, 2); assert.equal(requested.length, 2);
});
test('download redirects cannot downgrade to HTTP or embed credentials', async t => {
  for (const location of ['http://example.invalid/native.tar.gz', 'https://fixture:dummy@example.invalid/native.tar.gz']) {
    const f = fixture(t); let requested = 0;
    f.dependencies.fetch = async () => { requested++; return new Response(null, { status: 302, headers: { location } }); };
    await assert.rejects(P.importPayload({ ...f, resourceRoot: f.destination, url: 'https://example.invalid/native.tar.gz', sha256: 'a'.repeat(64) }), /HTTPS without embedded credentials/);
    assert.equal(requested, 1); assert.equal(fs.existsSync(f.destination), false);
  }
});
test('module-declared universal supplemental resources round-trip exact source, notices and native bytes', async t => {
  const f = fixture(t), supplemental = supplementalFixture(f), exported = await P.exportPayload(f);
  assert.deepEqual(exported.inventory.supplementals, [supplemental]);
  const imported = await P.importPayload({ ...f, resourceRoot: f.destination, archive: f.output, sha256: exported.sha256 });
  assert.deepEqual(imported.publishedSupplementals, [supplemental]);
  for (const file of supplemental.files) assert.deepEqual(fs.readFileSync(path.join(f.destination, supplemental.directoryRelative, file.path)),
    fs.readFileSync(path.join(f.resourceRoot, supplemental.directoryRelative, file.path)));
  assert.equal(S.verifySupplementals({ resourceRoot: f.destination, arch: 'x64', maximumMacOS: f.maximumMacOS, dependencies: f.dependencies }).length, 1);
  require('../scripts/ci-macos.cjs').assertCopiedPayload(f.destination, exported.inventory, imported.published);
});
test('supplemental payloads retain complete notice trees within the shared package limit', t => {
  const item = supplementalFixture(fixture(t));
  const notice = item.files.find(file => file.path === 'LICENSE');
  item.files.push(...Array.from({ length: B.LIMITS.files - item.files.length }, (_, index) =>
    ({ ...notice, path: `notices/dependency-${index}.txt` })));
  assert.equal(S.validateDeclaration(item), item);
  assert.throws(() => S.validateDeclaration({ ...item, files: [...item.files,
    { ...notice, path: 'notices/extra.txt' }] }), /Invalid supplemental native declaration/);
});
test('explicit Intel-child supplements round-trip unchanged Intel bytes in an ARM launcher', async t => {
  const f = fixture(t), supplemental = supplementalFixture(f, 'x86_64'), exported = await P.exportPayload(f);
  assert.equal(exported.inventory.launcherArch, 'arm64');
  assert.deepEqual(exported.inventory.supplementals, [supplemental]);
  const imported = await P.importPayload({ ...f, resourceRoot: f.destination, archive: f.output, sha256: exported.sha256 });
  assert.deepEqual(imported.publishedSupplementals, [supplemental]);
  const library = path.join(f.destination, supplemental.directoryRelative, 'helper.dylib');
  assert.deepEqual(require('../src/modules/shared/runtime/local-native').readMachOArchitectures(library, { allowLibrary: true }), ['x86_64']);
  assert.deepEqual(fs.readFileSync(library), fs.readFileSync(path.join(f.resourceRoot, supplemental.directoryRelative, 'helper.dylib')));
  for (const arch of ['arm64', 'x64']) assert.equal(S.verifySupplementals({ resourceRoot: f.destination,
    arch, maximumMacOS: f.maximumMacOS, dependencies: f.dependencies }).length, 1);
  const unmarked = { ...supplemental, files: supplemental.files.map(({ executionArchitecture, ...file }) => file) };
  assert.throws(() => S.validateDeclaration(unmarked), /launcher CPUs/);
});
test('Intel-child metadata cannot bypass architecture checks for another CPU or a non-native file', t => {
  const f = fixture(t), item = supplementalFixture(f, 'x86_64');
  for (const executionArchitecture of ['arm64', 'x64', 'universal', '', null]) {
    assert.throws(() => S.validateDeclaration({ ...item, files: item.files.map(file => file.architectures ?
      { ...file, executionArchitecture } : file) }), /execution architecture/);
  }
  assert.throws(() => S.validateDeclaration({ ...item, files: item.files.map(file => file.architectures ?
    { ...file, architectures: ['arm64'] } : file) }), /genuine Intel/);
  assert.throws(() => S.validateDeclaration({ ...item, files: item.files.map(file => file.path === 'LICENSE' ?
    { ...file, executionArchitecture: 'x86_64' } : file) }), /genuine Intel/);
});
function optionalProviderFixture(f) {
  const item = supplementalFixture(f), relative = 'providers/provider.dylib';
  const full = path.join(f.resourceRoot, item.directoryRelative, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(6, 12);
  fs.writeFileSync(full, bytes, { mode: 0o755 });
  const { bytes: ignored, ...record } = B.readRegular(full, 1024);
  item.files.push({ path: relative, ...record, architectures: ['arm64'],
    optionalLoad: { architectures: ['arm64'], minimumMacOS: '15.0' } });
  f.dependencies.loadCommands = file => ({ minimumMacOS: file.endsWith(relative) ? '15.0' : '13.0' });
  return item;
}
test('optional providers retain verified bytes without raising the shared native baseline', async t => {
  const f = fixture(t), item = optionalProviderFixture(f), checked = [];
  f.dependencies.verifySignature = file => checked.push(file);
  const exported = await P.exportPayload(f);
  assert.deepEqual(exported.inventory.supplementals, [item]);
  assert.deepEqual(S.validatePublicMetadata(item), item);
  const imported = await P.importPayload({ ...f, resourceRoot: f.destination, archive: f.output, sha256: exported.sha256 });
  assert.deepEqual(imported.publishedSupplementals, [item]);
  for (const arch of ['arm64', 'x64']) assert.equal(S.verifySupplementals({ resourceRoot: f.destination,
    arch, maximumMacOS: '13.0', dependencies: f.dependencies }).length, 1);
  const relative = 'providers/provider.dylib';
  assert.deepEqual(fs.readFileSync(path.join(f.destination, item.directoryRelative, relative)),
    fs.readFileSync(path.join(f.resourceRoot, item.directoryRelative, relative)));
  if (process.platform === 'darwin') assert.ok(checked.some(file => file.endsWith(relative)));
  const corrupted = await changedArchive(f, items => { items.find(entry => entry.name.endsWith(relative)).data[16] ^= 1; });
  await assert.rejects(P.importPayload(corrupted), /checksum/);
});
test('optional loading cannot disguise missing CPUs, required images or unsupported native floors', t => {
  const f = fixture(t), item = optionalProviderFixture(f), provider = item.files.at(-1);
  const withProvider = change => ({ ...item, files: [...item.files.slice(0, -1), { ...provider, ...change }] });
  for (const optionalLoad of [null, {}, { architectures: [], minimumMacOS: '15.0' },
    { architectures: ['arm64', 'arm64'], minimumMacOS: '15.0' },
    { architectures: ['x86_64'], minimumMacOS: '15.0' },
    { architectures: ['arm64'], minimumMacOS: '12.0' },
    { architectures: ['arm64'], minimumMacOS: 'bad' }])
    assert.throws(() => S.validateDeclaration(withProvider({ optionalLoad })), /Optional native loading/);
  assert.throws(() => S.validateDeclaration(withProvider({ executionArchitecture: 'x86_64' })), /Optional native loading/);
  assert.throws(() => S.validateDeclaration({ ...item, files: item.files.map(file => file.path === 'LICENSE' ?
    { ...file, optionalLoad: provider.optionalLoad } : file) }), /Optional native loading/);
  assert.throws(() => S.validateDeclaration({ ...item, files: item.files.map(file => file.architectures ?
    { ...file, optionalLoad: { architectures: file.architectures, minimumMacOS: '15.0' } } : file) }), /incomplete/);
  if (process.platform !== 'darwin') return;
  const verify = loadCommands => S.verifySupplementals({ resourceRoot: f.resourceRoot, arch: 'arm64',
    maximumMacOS: '13.0', dependencies: { ...f.dependencies, loadCommands } });
  assert.throws(() => verify(file => ({ minimumMacOS: file.endsWith('provider.dylib') ? '16.0' : '13.0' })), /exceeds its declared/);
  assert.equal(verify(() => ({ minimumMacOS: '13.0' })).length, 1, 'A conservative functional minimum can exceed native load commands');
  assert.throws(() => verify(file => ({ minimumMacOS: file.endsWith('provider.dylib') ? '15.0' : '14.0' })), /Supplemental native floor differs/);
});
test('functional optional floors cover the complete per-CPU native dependency closure', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), item = optionalProviderFixture(f), provider = item.files.at(-1), directory = path.join(f.resourceRoot, item.directoryRelative);
  provider.optionalLoad.minimumMacOS = '26.0';
  f.dependencies.loadCommands = file => ({ minimumMacOS: file.endsWith('provider.dylib') ? '14.0' : '13.0' });
  const verify = () => S.verifySupplementals({ resourceRoot: f.resourceRoot, arch: 'arm64', maximumMacOS: '13.0', dependencies: f.dependencies });
  assert.equal(verify().length, 1, 'Functional macOS 26 requirement remains valid over a macOS 14 executable');

  const dependency = path.join(directory, 'providers/dependency.dylib');
  fs.copyFileSync(path.join(directory, provider.path), dependency);
  fs.chmodSync(dependency, 0o755);
  const { bytes: ignored, ...identity } = B.readRegular(dependency, 1024);
  item.files.push({ path: 'providers/dependency.dylib', ...identity, architectures: ['arm64'], optionalLoad: { architectures: ['arm64'], minimumMacOS: '26.0' } });
  f.dependencies.links = file => file.endsWith('provider.dylib') ? ['@loader_path/dependency.dylib'] : [];
  f.dependencies.loadCommands = file => ({ minimumMacOS: file.endsWith('dependency.dylib') ? '26.0' : file.endsWith('provider.dylib') ? '14.0' : '13.0' });
  assert.equal(verify().length, 1, 'An equal transitive dependency minimum is accepted');
  provider.optionalLoad.minimumMacOS = '25.0';
  assert.throws(verify, /exceeds its declared/, 'A lower direct LC cannot hide the macOS 26 linked dependency');
  provider.optionalLoad.minimumMacOS = '26.0';
  f.dependencies.loadCommands = file => ({ minimumMacOS: file.endsWith('dependency.dylib') ? '26.1' : '13.0' });
  assert.throws(verify, /exceeds its declared/, 'Understated dependency requirements remain rejected');
});
test('native plugins use only their exact declared runtime host library and complete provider CPU closure', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), item = supplementalFixture(f), file = item.files.find(row => row.path === 'helper.dylib');
  const provider = { ...structuredClone(item), id: 'provider-fixture', directoryRelative: 'provider-fixture/1.0/universal' };
  fs.mkdirSync(path.dirname(path.join(f.resourceRoot, provider.directoryRelative)), { recursive: true });
  fs.cpSync(path.join(f.resourceRoot, item.directoryRelative), path.join(f.resourceRoot, provider.directoryRelative), { recursive: true });
  let selected = [item, provider];
  const contract = { id: item.id, version: item.version, file: file.path, sha256: file.sha256,
    dependency: '@loader_path/provided.dylib', provider: { id: provider.id, version: provider.version, file: file.path }, installNames: [] };
  f.dependencies.supplementals = () => selected;
  f.dependencies.nativeHostDependencies = () => [contract];
  f.dependencies.links = name => name.startsWith(path.join(f.resourceRoot, item.directoryRelative) + path.sep) ? [contract.dependency] : [];
  f.dependencies.resolveLink = () => { throw new Error('Unresolved ordinary native dependency'); };
  const verify = () => S.verifySupplementals({ resourceRoot: f.resourceRoot, arch: f.arch, maximumMacOS: f.maximumMacOS, dependencies: f.dependencies });
  assert.equal(verify().length, 2);
  selected = [item]; assert.throws(verify, /host dependency is missing/); selected = [item, provider];
  const providerFile = provider.files.find(row => row.path === file.path), architectures = providerFile.architectures;
  providerFile.architectures = ['arm64']; assert.throws(verify, /architecture does not cover its launcher CPUs/); providerFile.architectures = architectures;
  contract.sha256 = 'f'.repeat(64); assert.throws(verify, /Unresolved ordinary/); contract.sha256 = file.sha256;
  f.dependencies.links = () => ['@loader_path/unrelated.dylib']; assert.throws(verify, /Unresolved ordinary/);
});
test('missing, modified or omitted supplemental resources cannot produce an incomplete release', async t => {
  const f = fixture(t), supplemental = supplementalFixture(f); await P.exportPayload(f);
  const missing = await changedArchive(f, items => {
    const inventory = JSON.parse(items[0].data); inventory.supplementals = []; items[0].data = Buffer.from(JSON.stringify(inventory));
  });
  await assert.rejects(P.importPayload(missing), /complete module declarations/);
  assert.equal(fs.existsSync(f.destination), false);
  const corrupted = await changedArchive(f, items => { items.find(item => item.name.endsWith('/helper.dylib')).data[64] ^= 1; });
  await assert.rejects(P.importPayload(corrupted), /checksum/);
  assert.equal(fs.existsSync(f.destination), false);
  fs.rmSync(path.join(f.resourceRoot, supplemental.directoryRelative, 'LICENSE'));
  const output = path.join(f.root, 'missing-helper-license.tar.gz');
  await assert.rejects(P.exportPayload({ ...f, output }), /file inventory/);
  assert.equal(fs.existsSync(output), false);
});
test('supplemental signature failure rolls back managers and helper publication together', async t => {
  if (process.platform !== 'darwin') { t.skip('Native signature verification requires macOS.'); return; }
  const f = fixture(t), supplemental = supplementalFixture(f), exported = await P.exportPayload(f);
  await P.importPayload({ ...f, resourceRoot: f.destination, archive: f.output, sha256: exported.sha256 });
  const snapshot = () => B.fileInventory(f.destination).map(file => ({ file, sha256: B.readRegular(path.join(f.destination, file), 1024 ** 2).sha256 }));
  const before = snapshot();
  f.dependencies.verifySignature = file => { if (file.startsWith(f.destination + path.sep) && file.endsWith('helper.dylib')) throw new Error('Supplemental signature failure'); };
  await assert.rejects(P.importPayload({ ...f, resourceRoot: f.destination, archive: f.output, sha256: exported.sha256 }), /Supplemental signature failure/);
  assert.deepEqual(snapshot(), before);
  assert.equal(B.readRegular(path.join(f.destination, supplemental.directoryRelative, 'helper.json'), 1024).sha256, supplemental.manifestSha256);
});
test('backup cleanup failure retains every newly verified package after earlier backups were removed', async t => {
  const f = fixture(t), exported = await P.exportPayload(f);
  await P.importPayload({ ...f, resourceRoot: f.destination, archive: f.output, sha256: exported.sha256 });
  const before = B.fileInventory(f.destination).map(file => ({ file, sha256: B.readRegular(path.join(f.destination, file), 1024 ** 2).sha256 }));
  const remove = fs.rmSync; let cleaned = 0;
  fs.rmSync = function(file, options) {
    if (String(file).startsWith(f.destination + path.sep) && String(file).includes('.previous-') && ++cleaned === 2) throw new Error('Synthetic backup cleanup failure');
    return remove.call(fs, file, options);
  };
  try { await assert.rejects(P.importPayload({ ...f, resourceRoot: f.destination, archive: f.output, sha256: exported.sha256 }), /Synthetic backup cleanup failure/); }
  finally { fs.rmSync = remove; }
  for (const item of before) assert.equal(B.readRegular(path.join(f.destination, item.file), 1024 ** 2).sha256, item.sha256);
  assert.equal(require('../scripts/verify-native-runtimes.cjs').verifyPackages({ resourceRoot: f.destination, architectures: [f.arch], maximumMacOS: f.maximumMacOS,
    managerIds: [f.manager.id], dependencies: f.dependencies }).length, 2);
});
test('supplemental declarations retain source identities, license files and honest runtime floors', t => {
  const f = fixture(t), item = supplementalFixture(f);
  assert.throws(() => S.validateDeclaration({ ...item, sourceSha256: 'b'.repeat(64) }), /incomplete/);
  assert.throws(() => S.validateDeclaration({ ...item, notices: [{ name: 'Fixture', license: 'MIT', path: 'missing' }] }), /notice is missing/);
  assert.throws(() => S.validateInventory([item], { arch: 'arm64', maximumMacOS: '12.0' }, f.dependencies), /macOS floor/);
  assert.throws(() => S.validateDeclaration({ ...item, files: item.files.map(file => file.architectures ? { ...file, architectures: ['arm64'] } : file) }), /launcher CPUs/);
});

function sourceFixture(f) {
  const bytes = gzipSync(Buffer.from('Synthetic corresponding-source archive input'));
  const item = { managerId: f.manager.id, version: '2.0', directoryRelative: `${f.manager.id}/2.0-source.tar.gz`,
    sha256: B.digest(bytes), bytes: bytes.length };
  f.manager.core.catalog.find(pin => pin.version === '2.0').sourceArtifact = {
    directoryRelative: item.directoryRelative, sha256: item.sha256, bytes: item.bytes };
  f.sourceRoot = path.join(f.root, 'source-archives');
  fs.mkdirSync(path.dirname(path.join(f.sourceRoot, item.directoryRelative)), { recursive: true });
  fs.writeFileSync(path.join(f.sourceRoot, item.directoryRelative), bytes, { mode: 0o644 });
  return item;
}

test('standalone native helper publication shares verification and atomic rollback without copying runtime managers', t => {
  const f = fixture(t), item = supplementalFixture(f), Publish = require('../scripts/publish-native-runtimes.cjs');
  const options = { sourceRoot: f.resourceRoot, resourceRoot: f.destination, supplementals: [item], architectures: ['arm64'], maximumMacOS: '13.0', dependencies: f.dependencies };
  assert.deepEqual(Publish.publishSupplementals(options), []);
  assert.deepEqual(B.fileInventory(f.destination), item.files.map(file => `${item.directoryRelative}/${file.path}`).sort());
  assert.throws(() => Publish.publishSupplementals({ ...options, supplementals: [] }), /explicit nonempty/);
  const old = path.join(f.destination, item.directoryRelative, 'old.txt'); fs.writeFileSync(old, 'Previous helper copy');
  let checks = 0;
  assert.throws(() => Publish.publishSupplementals({ ...options, dependencies: { ...f.dependencies, verifySignature() {
    if (++checks === 2) throw new Error('Final helper signature failure');
  } } }), /Final helper signature failure/);
  assert.equal(fs.readFileSync(old, 'utf8'), 'Previous helper copy');
  assert.equal(fs.readdirSync(path.dirname(path.dirname(old))).some(name => name.includes('.previous-') || name.startsWith('.publish-')), false);
});

test('runtime-only payload downloads no source archives and retains exact source pins', async t => {
  const f = fixture(t), item = sourceFixture(f);
  const sourceDownload = { url: 'https://example.invalid/published-sources.tar.gz', sha256: 'c'.repeat(64) };
  fs.rmSync(f.sourceRoot, { recursive: true });
  const exported = await P.exportPayload({ ...f, sourceDownload });
  assert.deepEqual(exported.inventory.sourceArtifacts, [item]);
  assert.deepEqual(exported.inventory.sourceDownload, sourceDownload);
  assert.ok(entries(gunzipSync(fs.readFileSync(f.output))).every(entry => !entry.name.startsWith('native-sources/')));
  const requests = [], destination = path.join(f.root, 'no-sources');
  const result = await P.importPayload({ ...f, resourceRoot: f.destination, sourceRoot: destination,
    url: 'https://example.invalid/runtimes.tar.gz', sha256: exported.sha256,
    dependencies: { ...f.dependencies, fetch: async url => { requests.push(url); return new Response(fs.readFileSync(f.output)); } } });
  assert.deepEqual(requests, ['https://example.invalid/runtimes.tar.gz']);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(result.publishedSourceArtifacts, []);
  assert.equal(result.published.length, 2);
  for (const source of [{ ...sourceDownload, sha256: 'bad' }, { ...sourceDownload, url: 'file:///sources' }, { ...sourceDownload, extra: true }]) {
    assert.throws(() => P.validateInventory({ ...exported.inventory, sourceDownload: source }, f, f.dependencies));
  }
  const malformed = await changedArchive(f, items => items.concat({ name: `native-sources/${item.directoryRelative}`, data: Buffer.alloc(item.bytes), mode: 0o644 }));
  await assert.rejects(P.importPayload(malformed), /outside its sealed inventory/);
});
test('runtime payload carries exact corresponding source outside native app resources', async t => {
  const f = fixture(t), item = sourceFixture(f), exported = await P.exportPayload(f);
  assert.deepEqual(exported.inventory.sourceArtifacts, [item]);
  const destination = path.join(f.root, 'published-sources');
  await P.importPayload({ ...f, resourceRoot: f.destination, sourceRoot: destination, archive: f.output, sha256: exported.sha256 });
  assert.equal(B.readRegular(path.join(destination, item.directoryRelative), item.bytes).sha256, item.sha256);
  assert.ok(!B.fileInventory(f.destination).some(file => file.endsWith('-source.tar.gz')));
  const before = fs.statSync(path.join(destination, item.directoryRelative), { bigint: true });
  await P.importPayload({ ...f, resourceRoot: f.destination, sourceRoot: destination, archive: f.output, sha256: exported.sha256 });
  assert.equal(fs.statSync(path.join(destination, item.directoryRelative), { bigint: true }).ino, before.ino);
});

test('native helpers carry separate exact source archives without embedding build sources in the app payload', async t => {
  const f = fixture(t), runtimeSource = sourceFixture(f), helper = supplementalFixture(f);
  fs.unlinkSync(path.join(f.resourceRoot, helper.directoryRelative, helper.sourceRelative));
  helper.files = helper.files.filter(file => file.path !== helper.sourceRelative); delete helper.sourceRelative;
  const bytes = gzipSync(Buffer.from('Synthetic native helper complete source archive'));
  const helperSource = { managerId: helper.id, version: helper.version,
    directoryRelative: `${helper.id}/${helper.version}-source.tar.gz`, bytes: bytes.length, sha256: B.digest(bytes) };
  helper.sourceArtifact = { directoryRelative: helperSource.directoryRelative, bytes: helperSource.bytes, sha256: helperSource.sha256 };
  fs.mkdirSync(path.dirname(path.join(f.sourceRoot, helperSource.directoryRelative)), { recursive: true });
  fs.writeFileSync(path.join(f.sourceRoot, helperSource.directoryRelative), bytes, { mode: 0o644 });
  assert.equal(S.validateDeclaration(helper), helper);
  assert.deepEqual(require('../scripts/distribution-model.cjs').createPlan(f).sourceArtifacts, [helperSource, runtimeSource]);
  const exported = await P.exportPayload(f);
  assert.deepEqual(exported.inventory.sourceArtifacts, [helperSource, runtimeSource]);
  assert.throws(() => P.validateInventory({ ...exported.inventory, sourceArtifacts: [runtimeSource] }, f, f.dependencies), /Corresponding-source archives differ/);
  const destination = path.join(f.root, 'published-sources');
  await P.importPayload({ ...f, resourceRoot: f.destination, sourceRoot: destination, archive: f.output, sha256: exported.sha256 });
  assert.equal(B.readRegular(path.join(destination, helperSource.directoryRelative), helperSource.bytes).sha256, helperSource.sha256);
  assert.ok(!B.fileInventory(f.destination).some(file => file.endsWith('-source.tar.gz') || file.endsWith('/source.c')));
  assert.throws(() => S.validateDeclaration({ ...helper, sourceArtifact: undefined }), /incomplete/);
  assert.throws(() => S.validateDeclaration({ ...helper, sourceArtifact: { ...helper.sourceArtifact, managerId: 'other', directoryRelative: 'other/1.0-source.tar.gz' } }), /package identity/);
  fs.writeFileSync(path.join(f.sourceRoot, helperSource.directoryRelative), Buffer.alloc(helperSource.bytes));
  await assert.rejects(P.exportPayload({ ...f, output: path.join(f.root, 'changed-helper-source.tar.gz') }), /source archive checksum/);
});

test('missing source inventories and tampered archives cannot substitute for required corresponding source', async t => {
  const f = fixture(t), item = sourceFixture(f), exported = await P.exportPayload(f);
  for (const sources of [undefined, [], [{ ...item, sha256: 'b'.repeat(64) }], [item, item]]) {
    assert.throws(() => P.validateInventory({ ...exported.inventory, sourceArtifacts: sources }, f, f.dependencies), /Corresponding-source archives differ/);
  }
  fs.writeFileSync(path.join(f.sourceRoot, item.directoryRelative), Buffer.alloc(item.bytes));
  await assert.rejects(P.exportPayload({ ...f, output: path.join(f.root, 'changed-source.tar.gz') }), /source archive checksum/);
});

test('source publication rolls back new archives when native publication fails', async t => {
  const f = fixture(t), item = sourceFixture(f), exported = await P.exportPayload(f);
  const destination = path.join(f.root, 'published-sources');
  const dependencies = { ...f.dependencies, verifySignature() { throw new Error('Synthetic native signature failure'); } };
  await assert.rejects(P.importPayload({ ...f, dependencies, resourceRoot: f.destination, sourceRoot: destination,
    archive: f.output, sha256: exported.sha256 }), /Synthetic native signature failure/);
  assert.ok(!fs.existsSync(path.join(destination, item.directoryRelative)));
});

test('source archive paths and destinations cannot overlap native resources or escape the catalog identity', async t => {
  const Sources = require('../scripts/native-source-artifacts.cjs');
  const f = fixture(t), item = sourceFixture(f);
  for (const directoryRelative of ['../escape-source.tar.gz', `${f.manager.id}/../escape-source.tar.gz`, 'other/2.0-source.tar.gz']) {
    assert.throws(() => Sources.validate({ ...item, directoryRelative }));
  }
  await assert.rejects(P.exportPayload({ ...f, sourceRoot: path.join(f.resourceRoot, 'sources') }), /storage must be separate/);
  const archive = await P.exportPayload(f);
  await assert.rejects(P.importPayload({ ...f, resourceRoot: f.destination, sourceRoot: f.destination,
    archive: f.output, sha256: archive.sha256 }), /storage must be separate/);
  fs.unlinkSync(path.join(f.sourceRoot, item.directoryRelative));
  fs.symlinkSync(path.join(f.resourceRoot, f.manager.id, '2.0', 'manifest.json'), path.join(f.sourceRoot, item.directoryRelative));
  assert.throws(() => Sources.verify(f.sourceRoot, [item]));
});
