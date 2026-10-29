const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Manager = require('../src/modules/shared/installers/runtime/innoextract-manager');
const fixtureVersion = "fixture-reader", fixtureRevision = "a".repeat(40);
const Inno = require('../src/modules/shared/installers/inno');
const Header = require('../src/modules/shared/installers/inno-header');
const Inputs = require('../src/modules/shared/installers');
const { nativeTool, packageFor, sha } = require('./helpers/managed-tool-fixture.cjs');

function loader() {
  const bytes = Buffer.alloc(256); bytes.write('MZ');
  bytes.writeUInt32LE(0x6f6e6e49, 0x30); bytes.writeUInt32LE(64, 0x34); bytes.writeUInt32LE(~64 >>> 0, 0x38);
  Buffer.from('72446c507453cde6d77b0b2a', 'hex').copy(bytes, 64);
  bytes.writeUInt32LE(1, 76); bytes.writeUInt32LE(128, 96); bytes.writeUInt32LE(0, 100);
  bytes.writeUInt32LE(Header.crc32(bytes.subarray(64, 104)), 104);
  bytes.write('Inno Setup Setup Data (5.5.7) (u)', 128); return bytes;
}

function fixture(root) {
  const protocol = 'fixture-inspector-v1';
  const tool = nativeTool(path.join(root, 'native'), String.raw`
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2), setup = args.at(-1);
const metadata = JSON.parse(fs.readFileSync(setup).subarray(256).toString());
if (args[0] === '--inspect-json') console.log(JSON.stringify(metadata));
else if (args[0] === '--extract') {
  const output = args[args.indexOf('--output-dir') + 1];
  const contents = JSON.parse(fs.readFileSync(path.join(path.dirname(setup), 'setup-1.bin')));
  for (const file of metadata.files) {
    const target = path.join(output, file.path); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(contents[file.path], 'base64'));
  }
} else throw Error('Unexpected fixture command');
`);
  const notice = { name: 'Fixture tool', license: 'MIT', path: 'licenses/LICENSE', sourceUrl: 'https://example.org/fixture' };
  const packed = packageFor(path.join(root, 'package'), { id: 'innoextract', version: fixtureVersion, filesPrefix: 'files/',
    manifest: { managerId: 'innoextract', upstreamRevision: fixtureRevision, platform: 'darwin', executableRelative: 'bin/innoextract',
      runtimeFiles: { inspector: 'bin/maclauncher-inno-inspect' }, dependencies: [], notices: [notice],
      provenance: { sourceRevision: fixtureRevision, version: protocol } },
    entries: [{ path: 'bin/innoextract', bytes: tool.binary, mode: 0o755, architectures: ['arm64'] },
      { path: 'bin/maclauncher-inno-inspect', bytes: tool.binary, mode: 0o755, architectures: ['arm64'] },
      { path: 'bin/fixture.cjs', bytes: tool.script, mode: 0o644 },
      { path: notice.path, bytes: Buffer.from('Fixture license\n'), mode: 0o644 }] });
  // Published records identify their source revision; the launcher keeps no version row.
  packed.record.source = { repository: 'dscharrer/innoextract', revision: fixtureRevision };
  packed.record.source = { repository: "procrastinine/maclauncher-builds", revision: fixtureRevision };
  const setup = path.join(root, 'setup.exe'), companion = path.join(root, 'setup-1.bin');
  const content = Buffer.from('<!doctype html><title>Managed fixture</title>');
  const metadata = { schemaVersion: 1, helperVersion: protocol, sourceRevision: fixtureRevision, format: 'inno',
    formatVersion: '5.5.7 (unicode)', headerOffset: 128, dataOffset: 0, externalData: true, encrypted: false,
    requiredSlices: [{ index: 0, names: ['setup-1.bin'] }],
    files: [{ path: 'app/index.html', authoredPath: '{app}\\index.html', size: content.length, location: 0 }] };
  fs.writeFileSync(setup, Buffer.concat([loader(), Buffer.from(JSON.stringify(metadata))]));
  fs.writeFileSync(companion, JSON.stringify({ 'app/index.html': content.toString('base64') }));
  return { ...packed, setup, companion, content };
}

test('managed installer fixture: consent/install/resume, full extraction, offline cache reuse and native/script tamper',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inno-managed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { record, catalog, archive, setup, companion, content } = fixture(root);
  const originals = [setup, companion].map(Inno.identity);
  assert.equal(sha(fs.readFileSync(archive)), record.asset.sha256);
  let downloads = 0, refreshes = 0, consents = 0, offline = false, corruptDownload = false;
  const dependencies = {
    projectBuilds: { fetchUrlBuffer: async () => { if (offline) throw Error('unexpected offline refresh'); refreshes++; return { status: 200, body: Buffer.from(JSON.stringify(catalog)) }; } },
    downloadToFile: async (_url, destination) => { if (offline) throw Error('unexpected offline download'); downloads++; const bytes = fs.readFileSync(archive); if (corruptDownload) bytes[0] ^= 1; fs.writeFileSync(destination, bytes); }
  };
  const manager = Manager.createManager(dependencies);
  t.mock.method(Manager, 'ensure', manager.ensure); t.mock.method(Manager, 'resolveSelection', manager.resolveSelection);
  const context = { userDataDir: path.join(root, 'profile'), gameId: 'managed-inno-fixture',
    settings: { runtimes: { innoextract: { defaultVersion: record.version } } },
    confirmRuntimeInstall: async () => { consents++; return false; } };
  assert.equal(manager.ui.management, 'managed');
  assert.equal(manager.getState({ userDataDir: context.userDataDir }).catalog.recommendedVersion, null);
  await assert.rejects(Inputs.prepareInput(setup, context), /cancel/i);
  assert.equal(downloads, 0); assert.equal(refreshes, 0); assert.equal(fs.existsSync(context.userDataDir), false);
  const rtp = require('../src/modules/rgss/rtp').createRtpStore({ download: async () => { throw Error('unexpected RTP acquisition after declined helper'); } });
  const rtpContext = { ...context, userDataDir: path.join(root, 'rtp-profile'), id: 'Standard' };
  await assert.rejects(rtp.installPack(rtpContext), /cancel/i);
  assert.equal(fs.existsSync(rtpContext.userDataDir), false);
  assert.equal(downloads, 0); assert.equal(refreshes, 0);
  context.confirmRuntimeInstall = async () => { consents++; return true; };
  corruptDownload = true;
  await assert.rejects(Inputs.prepareInput(setup, context), /SHA-256/);
  assert.equal(fs.existsSync(path.join(context.userDataDir, 'games')), false);
  assert.equal(manager.resolveSelection({}, context.settings, context.userDataDir).ready, false);
  corruptDownload = false;
  const extracted = await Inputs.prepareInput(setup, context);
  assert.deepEqual(fs.readFileSync(path.join(extracted.inputPath, 'app/index.html')), content);
  assert.equal(downloads, 2); assert.equal(consents, 4);
  const helper = Inno.resolveHelper(context);
  assert.equal(helper.packageVersion, record.version); assert.equal(helper.version, 'fixture-inspector-v1');
  assert.equal(helper.identity, record.manifestSha256);
  assert.ok(helper.inspector.startsWith(context.userDataDir + path.sep));
  offline = true;
  const restarted = Manager.createManager(dependencies);
  t.mock.method(Manager, 'ensure', restarted.ensure); t.mock.method(Manager, 'resolveSelection', restarted.resolveSelection);
  context.confirmRuntimeInstall = async () => { throw Error('unexpected offline consent'); };
  const cached = await Inputs.prepareInput(setup, context);
  assert.equal(cached.containerData.cached, true); assert.equal(cached.inputPath, extracted.inputPath);
  assert.deepEqual(fs.readFileSync(path.join(cached.inputPath, 'app/index.html')), content); assert.equal(downloads, 2);
  const script = path.join(path.dirname(helper.inspector), 'fixture.cjs'), scriptBytes = fs.readFileSync(script);
  fs.appendFileSync(script, '\n// changed fixture payload');
  assert.throws(() => Inno.resolveHelper(context), error => error.code === 'INSTALLER_TOOL_MISSING');
  fs.writeFileSync(script, scriptBytes);
  assert.equal(Inno.resolveHelper(context).identity, record.manifestSha256);
  const fd = fs.openSync(helper.inspector, 'r+'), byte = Buffer.alloc(1);
  fs.readSync(fd, byte, 0, 1, 4096); byte[0] ^= 1; fs.writeSync(fd, byte, 0, 1, 4096); fs.closeSync(fd);
  assert.throws(() => Inno.resolveHelper(context), error => error.code === 'INSTALLER_TOOL_MISSING');
  assert.deepEqual([setup, companion].map(Inno.identity), originals);
});
