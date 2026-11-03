const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const Published = require('../scripts/published-inputs.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'published-inputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('supplier archive'), record = { id: 'example', version: '1.0', arch: 'x64',
    asset: { filename: 'example.tar.gz', url: 'https://github.com/procrastinine/maclauncher-builds/releases/download/example/example.tar.gz', bytes: bytes.length, sha256: sha(bytes) } };
  fs.mkdirSync(path.join(root, 'dist/runtime-downloads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/runtime-downloads', record.asset.filename), bytes);
  return { root, record, lock: { repository: 'procrastinine/maclauncher-builds', packages: [record] } };
}
test('app native packages require signed Runtime build provenance for the exact archive', t => {
  const f = fixture(t), options = { repoRoot: f.root, lock: f.lock };
  assert.throws(() => Published.verifyBuildAttestations(options), /attestation is required/);
  const calls = [], tool = (command, args, options) => {
    calls.push([command, args, options]);
    if (args[1] === 'download') {
      fs.writeFileSync(path.join(options.cwd, 'sha256:' + f.record.asset.sha256 + '.jsonl'), 'signed bundle');
      return '';
    }
    return JSON.stringify([{ verificationResult: { statement: { subject: [{ name: f.record.asset.filename,
      digest: { sha256: f.record.asset.sha256 } }], predicate: { buildDefinition: { resolvedDependencies: [
        { uri: 'git+https://github.com/procrastinine/maclauncher-builds', digest: { gitCommit: 'a'.repeat(40) } }
      ] }, runDetails: { metadata: { invocationId: 'https://github.com/procrastinine/maclauncher-builds/actions/runs/123' } } } } } }]);
  };
  Published.downloadBuildAttestations({ ...options, tool });
  Published.downloadBuildAttestations({ ...options, tool });
  assert.equal(calls.length, 1);
  const verified = Published.verifyBuildAttestations({ ...options, tool })[0];
  assert.equal(verified.sha256, f.record.asset.sha256);
  assert.equal(verified.url, f.record.asset.url);
  assert.equal(verified.statements[0].predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit, 'a'.repeat(40));
  assert.equal(verified.statements[0].predicate.runDetails.metadata.invocationId, 'https://github.com/procrastinine/maclauncher-builds/actions/runs/123');
  assert.ok(calls[1][1].includes('--bundle'));
  assert.ok(calls[1][1].includes('--deny-self-hosted-runners'));
  assert.ok(calls[1][1].includes('procrastinine/maclauncher-builds/.github/workflows/runtime-build.yml'));
  assert.throws(() => Published.verifyBuildAttestations({ ...options, tool() { throw new Error('invalid signature'); } }), /invalid signature/);
  assert.throws(() => Published.verifyBuildAttestations({ ...options, tool: () => '[]' }), /no verified provenance/);
  fs.appendFileSync(path.join(f.root, 'dist/runtime-downloads', f.record.asset.filename), 'changed');
  assert.throws(() => Published.verifyBuildAttestations({ ...options, tool }), /differs from its pinned archive/);
});
test('publisher Python verification rejects a local replacement even when source metadata remains valid', t => {
  const f = fixture(t), pin = require('../src/modules/shared/runtime/python').embeddedPythonProfile('arm64');
  const selected = { repoRoot: f.root, plan: { launcherArch: 'arm64' }, sources: new Map([['python', {
    owner: 'upstream', binary: 'Mach-O', supplier: { name: 'python' }, sourceRelative: 'src/resources/python/bin/python3', sha256: 'a'.repeat(64)
  }]]) };
  const target = path.join(f.root, 'dist/upstream-downloads', pin.sha256 + '.tar.gz');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'unverified local build');
  assert.throws(() => Published.verifyPublisherNativeInputs(selected), /differs from its pinned archive/);
});
test('declared binary suppliers are compared with checksum-verified publisher downloads', async t => {
  const f = fixture(t), bytes = Buffer.from('publisher JAR'), folder = path.join(f.root, 'src/modules/example');
  fs.mkdirSync(folder, { recursive: true });
  const file = { path: 'tool.jar', size: bytes.length, sha256: sha(bytes) };
  fs.writeFileSync(path.join(folder, 'binary.json'), JSON.stringify({ version: '1.0', url: 'https://publisher.example/tool.jar', files: [file] }));
  let calls = 0;
  const download = async (_url, target) => { calls++; fs.writeFileSync(target, bytes); };
  assert.deepEqual(await Published.prepareDeclaredPublishers({ repoRoot: f.root, download }), { files: 1 });
  const installed = path.join(folder, file.path), before = fs.statSync(installed);
  assert.deepEqual(fs.readFileSync(installed), bytes);
  await Published.prepareDeclaredPublishers({ repoRoot: f.root, download }); assert.equal(calls, 1);
  assert.equal(fs.statSync(installed).ino, before.ino);
  fs.writeFileSync(installed, 'damaged');
  await Published.prepareDeclaredPublishers({ repoRoot: f.root, download });
  assert.deepEqual(fs.readFileSync(installed), bytes);
  fs.unlinkSync(path.join(f.root, 'dist/upstream-downloads', file.sha256 + '.bin'));
  await Published.prepareDeclaredPublishers({ repoRoot: f.root, download: () => assert.fail('Pinned installed bytes refill the cache offline') });
  const record = { owner: 'upstream', binary: 'archive', sha256: file.sha256, supplier: { name: 'declared-upstream', file } };
  const selected = { repoRoot: f.root, sources: new Map([['tool', record]]) };
  assert.deepEqual(Published.verifyPublisherNativeInputs(selected), { nativeFiles: 1 });
  record.sha256 = 'a'.repeat(64);
  assert.throws(() => Published.verifyPublisherNativeInputs(selected), /differs from its publisher download/);
  fs.unlinkSync(path.join(f.root, 'dist/upstream-downloads', file.sha256 + '.bin'));
  assert.throws(() => Published.verifyPublisherNativeInputs(selected), /archive is missing/);
  fs.unlinkSync(installed);
  await assert.rejects(Published.prepareDeclaredPublishers({ repoRoot: f.root, download: async (_url, target) => fs.writeFileSync(target, 'wrong') }), /differs from its pinned archive/);
  assert.equal(fs.existsSync(installed), false);
});

test('7-Zip setup preserves a verified executable inode and replaces changed inputs atomically', async t => {
  const f = fixture(t), root = path.join(f.root, 'src/resources/7zip');
  fs.mkdirSync(root, { recursive: true });
  const executable = Buffer.from('publisher executable'), license = Buffer.from('publisher license');
  const archive = Buffer.from('publisher tar');
  const pin = { version: '1', url: 'https://github.com/ip7z/7zip/releases/download/1/7z.tar.xz',
    sha256: sha(archive), bytes: archive.length, executableSha256: sha(executable) };
  fs.writeFileSync(path.join(root, 'source.json'), JSON.stringify(pin));
  const options = { repoRoot: f.root, download: async (_url, target) => fs.writeFileSync(target, archive),
    tool: (_command, args) => args.at(-1) === '7zz' ? executable : license };
  await Published.prepareSevenZip(options);
  const target = path.join(root, '7zz'), licensePath = path.join(root, 'LICENSE.txt');
  const before = fs.statSync(target, { bigint: true }), licenseBefore = fs.statSync(licensePath, { bigint: true });
  await Published.prepareSevenZip(options);
  const after = fs.statSync(target, { bigint: true }), licenseAfter = fs.statSync(licensePath, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(licenseAfter.ino, licenseBefore.ino); assert.equal(licenseAfter.mtimeNs, licenseBefore.mtimeNs);
  fs.writeFileSync(target, 'damaged input');
  await Published.prepareSevenZip(options);
  assert.notEqual(fs.statSync(target, { bigint: true }).ino, before.ino);
  assert.deepEqual(fs.readFileSync(target), executable);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(root).sort(), ['7zz', 'LICENSE.txt', 'source.json']);
});

test('Android producer tool pins restore their declared tools directory without fetching installed publisher bytes', async t => {
  const f = fixture(t), native = path.join(f.root, 'src/modules/android/native');
  fs.mkdirSync(path.join(native, 'tools'), { recursive: true });
  const bytes = Buffer.from('exact publisher ASM'), entry = { path: 'asm-example.jar', size: bytes.length, sha256: sha(bytes) };
  fs.writeFileSync(path.join(native, 'asm-binary.json'), JSON.stringify({ url: 'https://publisher.example/asm.jar', files: [entry] }));
  fs.writeFileSync(path.join(native, 'tools', entry.path), bytes);
  const options = { repoRoot: f.root, download: () => assert.fail('Installed pin stays offline') };
  assert.deepEqual(await Published.prepareDeclaredPublishers(options), { files: 1 });
  fs.unlinkSync(path.join(native, 'tools', entry.path));
  await Published.prepareDeclaredPublishers(options);
  assert.deepEqual(fs.readFileSync(path.join(native, 'tools', entry.path)), bytes);
});
