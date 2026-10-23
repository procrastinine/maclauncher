const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Input = require('../src/modules/alicesoft/decompiler-input');
const Tools = require('../src/modules/alicesoft/decompiler');
const { managers, profiles } = require('../src/modules/alicesoft/decompiler-managers');
const { inspectRoot } = require('../src/modules/alicesoft/detect');
const { createCatalogDiscovery } = require('../src/modules/alicesoft/catalog');

function dri() {
  const bytes = Buffer.alloc(768);
  bytes.writeUInt16LE(2, 0); bytes.writeUInt16LE(3, 2); bytes.writeUInt16LE(4, 4);
  bytes[256] = 1; bytes[257] = 1;
  return bytes;
}
function ald() {
  const bytes = Buffer.alloc(784);
  bytes.writeUIntLE(1, 0, 3); bytes.writeUIntLE(2, 3, 3); bytes.writeUIntLE(3, 6, 3);
  bytes[256] = 1; bytes.writeUInt16LE(1, 257);
  bytes.writeUInt32LE(32, 512); bytes.writeUInt32LE(64, 516); bytes.write('1.sco\0', 528);
  bytes.write('S350', 544); bytes.writeUInt32LE(40, 548); bytes.writeUInt32LE(64, 552);
  bytes.writeUInt16LE(13, 560); bytes.write('../escape.adv', 562);
  bytes.writeUInt32LE(0x14c4e, 768); bytes[776] = 1;
  return bytes;
}
function ain(name) {
  const payload = Buffer.concat([Buffer.from('HEL0'), Buffer.alloc(4), Buffer.from([1, 0, 0, 0]), Buffer.from(name + '\0'), Buffer.alloc(4)]);
  for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] >> 2 | payload[i] << 6) & 255;
  const header = Buffer.alloc(8); header.write('AIN2'); header.writeUInt32LE(1, 4);
  return Buffer.concat([header, payload]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'alicesoft-source-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contentRootDir = path.join(root, 'game'), userDataDir = path.join(root, 'userdata');
  fs.mkdirSync(contentRootDir); fs.writeFileSync(path.join(contentRootDir, 'ADISK.DAT'), dri()); fs.writeFileSync(path.join(contentRootDir, 'ACG.DAT'), Buffer.alloc(512));
  const entry = { gameId: 'fixture', gamePath: path.join(contentRootDir, 'adv.exe'), contentRootDir, moduleData: inspectRoot(contentRootDir) };
  const context = { userDataDir, settings: {}, runtimeSettings: { gameId: 'system1_generic' } };
  return { root, entry, context };
}
function registerFake(f, managerId = 'sys3-decompiler', version = profiles.find(profile => profile.managerId === managerId).version) {
  const executable = path.join(f.root, 'tool'); const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4); bytes.writeUInt32LE(2, 12);
  fs.writeFileSync(executable, bytes, { mode: 0o755 });
  managers[managerId].core.registerLocal({ userDataDir: f.context.userDataDir, version, runtimePath: executable });
}

for (const profile of profiles) test(`${profile.repo} catalog retains complete release identities and excludes non-release tags`, async () => {
  const upstream = profile.releases.filter(release => release.upstreamTag);
  const releases = upstream.map(release => ({ tag_name: release.upstreamTag }));
  const tags = upstream.map(release => ({ name: release.upstreamTag, commit: { sha: release.upstreamRevision } }));
  let calls = 0;
  const discovered = await createCatalogDiscovery(profile.repo, {
    fetchGithubReleases: async () => { calls++; return [...releases, { tag_name: 'nightly' }]; },
    fetchGithubTags: async () => { calls++; return tags; },
    resolveGithubTagCommit: () => { throw Error('Unnecessary commit request'); }
  })();
  assert.equal(calls, 2); assert.equal(discovered.length, profile.repo === 'sys3c' ? 7 : 17);
  assert.equal(discovered[0].upstreamRevision, upstream[0].upstreamRevision);
  assert.equal(new Set(discovered.map(row => row.version)).size, discovered.length);
  assert.ok(discovered.every(row => row.localBuild === false && !row.asset));
});

test('scenario preflight validates native first-page index and rejects escaping tables and unsafe AIN library names', () => {
  assert.equal(Input.validateDri(dri(), 'ADISK.DAT'), 1);
  assert.equal(Input.validateAld(ald(), 'TestSA.ALD'), 1);
  const broken = ald(); broken.writeUInt32LE(4096, 548); assert.throws(() => Input.validateAld(broken, 'TestSA.ALD'), /compiled scenario header/);
  const bytes = dri(); bytes[257] = 128;
  assert.throws(() => Input.validateDri(bytes, 'ADISK.DAT'), /pointer/);
  assert.equal(Input.validateAin(ain('SafeLibrary')), 1);
  assert.throws(() => Input.validateAin(ain('../../escape')), /Unsafe/);
  assert.throws(() => Input.validateAin(ain('SafeLibrary').subarray(0, 18)), /Truncated|Invalid/);
});

test('scenario inputs omit asset archives, reject symlinks, and require matching imported generation', t => {
  const f = fixture(t); const input = Input.inspectInputs(f.entry, f.context);
  assert.deepEqual(input.files.map(file => path.basename(file.file)), ['ADISK.DAT']);
  assert.equal(input.gameId, 'system1_generic');
  f.entry.moduleData.generation = 'system35'; assert.throws(() => Input.inspectInputs(f.entry, f.context), /matching original/);
  f.entry.moduleData.generation = 'system3';
  fs.symlinkSync(path.join(f.entry.contentRootDir, 'ADISK.DAT'), path.join(f.entry.contentRootDir, 'BDISK.DAT'));
  assert.throws(() => Input.inspectInputs(f.entry, f.context), /regular original/);
});

test('decompile checks exact tool version, exports private source and preserves originals', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t); registerFake(f);
  const original = fs.readFileSync(path.join(f.entry.contentRootDir, 'ADISK.DAT'));
  const calls = [];
  const result = await Tools.decompile(f.entry, {}, f.context, { runProcess: async (_executable, args) => {
    calls.push(args);
    if (args[0] === '--version') return { stdout: 'sys3dc 0.5.0\n', stderr: '' };
    assert.ok(args.includes('--game=system1_generic')); assert.ok(args.includes('--encoding=utf8'));
    const dir = args.find(arg => arg.startsWith('--outdir=')).slice(9);
    fs.writeFileSync(path.join(dir, '0.adv'), 'R:\n'); fs.writeFileSync(path.join(dir, 'sys3c.cfg'), 'game=system1_generic\n');
    return { stdout: '', stderr: '' };
  } });
  assert.equal(calls.length, 2); assert.equal(result.scriptCount, 1);
  assert.ok(result.outputDir.startsWith(f.context.userDataDir + path.sep));
  assert.equal(f.entry.moduleData.sourceExportDir, result.outputDir);
  const report = JSON.parse(fs.readFileSync(path.join(result.outputDir, 'manifest.json')));
  assert.equal(report.toolVersion, '0.5.0'); assert.equal(report.originalFiles.length, 1);
  assert.equal(report.originalFiles[0].sha256, crypto.createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(fs.readFileSync(path.join(f.entry.contentRootDir, 'ADISK.DAT')), original);
});

test('failed or cancelled native exports remove only their new output and keep earlier export metadata', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t); registerFake(f); f.entry.moduleData.sourceExportDir = 'previous-export';
  const controller = new AbortController(); f.context.signal = controller.signal;
  await assert.rejects(Tools.decompile(f.entry, {}, f.context, { runProcess: async (_executable, args) => {
    if (args[0] === '--version') return { stdout: 'sys3dc 0.5.0', stderr: '' };
    const dir = args.find(arg => arg.startsWith('--outdir=')).slice(9); fs.writeFileSync(path.join(dir, '0.adv'), 'R:\n'); controller.abort();
    return { stdout: '', stderr: '' };
  } }), error => error.name === 'AbortError');
  assert.equal(f.entry.moduleData.sourceExportDir, 'previous-export');
  const root = path.join(f.context.userDataDir, 'games/fixture/modules/alicesoft/source'); assert.deepEqual(fs.readdirSync(root), []);
});

test('native version mismatches and unsafe output cannot create a successful export', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t); registerFake(f);
  await assert.rejects(Tools.decompile(f.entry, {}, f.context, { runProcess: async () => ({ stdout: 'sys3dc 0.4.1', stderr: '' }) }), /different version/);
  await assert.rejects(Tools.decompile(f.entry, {}, f.context, { runProcess: async (_executable, args) => {
    if (args[0] === '--version') return { stdout: 'sys3dc 0.5.0', stderr: '' };
    const dir = args.find(arg => arg.startsWith('--outdir=')).slice(9); fs.symlinkSync(path.join(f.entry.contentRootDir, 'ADISK.DAT'), path.join(dir, '0.adv'));
    return { stdout: '', stderr: '' };
  } }), /symlinks/);
  assert.equal(f.entry.moduleData.sourceExportDir, undefined);
});


test('System3.x exports use sequential names instead of embedded scenario paths', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.entry.contentRootDir, 'ADISK.DAT'));
  fs.writeFileSync(path.join(f.entry.contentRootDir, 'TestSA.ALD'), ald());
  f.entry.moduleData = inspectRoot(f.entry.contentRootDir);
  registerFake(f, 'xsys35-decompiler');
  const result = await Tools.decompile(f.entry, {}, f.context, { runProcess: async (_executable, args) => {
    if (args[0] === '--version') return { stdout: 'xsys35dc 1.13.0', stderr: '' };
    assert.ok(args.includes('--seq')); assert.ok(!args.some(arg => arg.includes('escape.adv')));
    const dir = args.find(arg => arg.startsWith('--outdir=')).slice(9); fs.writeFileSync(path.join(dir, '0.adv'), 'R:\n');
    return { stdout: '', stderr: '' };
  } });
  assert.equal(result.scriptCount, 1); assert.equal(result.toolVersion, '1.13.0');
});
