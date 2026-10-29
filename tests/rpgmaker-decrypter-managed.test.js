const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Manager = require('../src/modules/shared/runtime/decrypter-manager');
const Rgss = require('../src/modules/rgss/main');
const Decrypt = require('../src/modules/rgss/decrypt');
const Mv = require('../src/modules/shared/mvmz/decrypt');
const { nativeTool, packageFor } = require('./helpers/managed-tool-fixture.cjs');

function packageFixture(root) {
  const tool = nativeTool(path.join(root, 'native'), String.raw`
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2), input = args[0];
if (fs.statSync(input).isFile()) {
  const bytes = fs.readFileSync(input); let offset = 8, key = 0xdeadcafe;
  if (bytes.subarray(0, 8).toString('hex') !== '5247535341440001') throw Error('Expected RGSS fixture');
  const next = () => { key = (Math.imul(key, 7) + 3) >>> 0; };
  const integer = () => { const value = (bytes.readUInt32LE(offset) ^ key) >>> 0; offset += 4; next(); return value; };
  const length = integer(), name = Buffer.alloc(length);
  for (let index = 0; index < length; index++) { name[index] = bytes[offset++] ^ (key & 255); next(); }
  const size = integer(), data = Buffer.alloc(size); let dataKey = key;
  for (let index = 0; index < size; index++) {
    if (index && index % 4 === 0) dataKey = (Math.imul(dataKey, 7) + 3) >>> 0;
    data[index] = bytes[offset++] ^ (dataKey >>> ((index % 4) * 8) & 255);
  }
  const output = args.find(value => value.startsWith('--output=')).slice('--output='.length);
  const target = path.join(output, name.toString().split('\\').join('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
} else {
  // Match the upstream behavior that requires an MV deployment wrapper and
  // decrypts in place, regardless of --output, unless reconstructing a project.
  const www = path.join(input, 'www');
  if (!fs.existsSync(www)) throw Error('MV fixture requires the deployment wrapper');
  const key = Buffer.from(JSON.parse(fs.readFileSync(path.join(www, 'data/System.json'))).encryptionKey, 'hex');
  const image = path.join(www, 'img/sample.rpgmvp'), bytes = fs.readFileSync(image).subarray(16);
  for (let index = 0; index < Math.min(16, bytes.length); index++) bytes[index] ^= key[index];
  fs.writeFileSync(path.join(www, 'img/sample.png'), bytes);
}
`);
  return packageFor(path.join(root, 'package'), { id: 'rpgmaker-decrypter', version: 'fixture-v1',
    manifest: { managerId: 'rpgmaker-decrypter', toolABI: 1, executableRelative: 'files/bin/RPGMakerDecrypter-cli' },
    entries: [{ path: 'files/bin/RPGMakerDecrypter-cli', bytes: tool.binary, mode: 0o755, architectures: ['arm64'] },
      { path: 'files/bin/fixture.cjs', bytes: tool.script, mode: 0o644 }] });
}

function archive(name, data) {
  let key = 0xdeadcafe;
  const chunks = [Buffer.from([82, 71, 83, 83, 65, 68, 0, 1])];
  const next = () => { key = (Math.imul(key, 7) + 3) >>> 0; };
  function integer(value) { const b = Buffer.alloc(4); b.writeUInt32LE((value ^ key) >>> 0); chunks.push(b); next(); }
  const filename = Buffer.from(name); integer(filename.length);
  chunks.push(Buffer.from(filename.map(byte => { const value = byte ^ (key & 255); next(); return value; })));
  integer(data.length);
  let dataKey = key;
  chunks.push(Buffer.from(data.map((byte, index) => { if (index && index % 4 === 0) dataKey = (Math.imul(dataKey, 7) + 3) >>> 0; return byte ^ (dataKey >>> ((index % 4) * 8) & 255); })));
  return Buffer.concat(chunks);
}

test('managed RPGMakerDecrypter fixture: action cancellation, exact install, RGSS/MV consumers, offline reuse and damage detection', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-managed-'));
  const originalEnsure = Manager.ensure;
  t.after(() => { Manager.ensure = originalEnsure; fs.rmSync(root, { recursive: true, force: true }); });
  const { catalog, record, archive: packageArchive } = packageFixture(root); let refreshes = 0, downloads = 0, consents = 0, offline = false, corruptDownload = false;
  const dependencies = {
    fetchUrlBuffer: async () => { if (offline) throw Error('unexpected offline refresh'); refreshes++; return { status: 200, body: Buffer.from(JSON.stringify(catalog)) }; },
    downloadToFile: async (_url, destination) => { if (offline) throw Error('unexpected offline download'); downloads++; const bytes = fs.readFileSync(packageArchive); if (corruptDownload) bytes[0] ^= 1; fs.writeFileSync(destination, bytes); }
  };
  const manager = Manager.createManager(dependencies); Manager.ensure = manager.ensure;
  const context = { userDataDir: path.join(root, 'profile'), settings: { runtimes: { 'rpgmaker-decrypter': { defaultVersion: record.version } } },
    confirmRuntimeInstall: async () => { consents++; return false; } };
  assert.equal(manager.ui.groupId, 'tools'); assert.equal(manager.delivery.included, 'none');
  const input = path.join(root, 'game'); fs.mkdirSync(input);
  const bytes = Buffer.from('managed extraction stays exact\n');
  fs.writeFileSync(path.join(input, 'Game.rgssad'), archive('Data\\sample.txt', bytes));
  const entry = { gameId: 'managed-rpg-fixture', contentRootDir: input, gamePath: input };
  const output = Decrypt.resolveExtractionRoot({ entry, userDataDir: context.userDataDir });
  fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'preserved'), 'keep');
  await assert.rejects(Rgss.actions.decryptGame(entry, {}, context), /cancel/i);
  assert.equal(fs.readFileSync(path.join(output, 'preserved'), 'utf8'), 'keep');
  assert.equal(downloads, 0); assert.equal(refreshes, 0);
  context.confirmRuntimeInstall = async () => { consents++; return true; };
  corruptDownload = true;
  await assert.rejects(Rgss.actions.decryptGame(entry, {}, context), /SHA-256/);
  assert.equal(fs.readFileSync(path.join(output, 'preserved'), 'utf8'), 'keep');
  corruptDownload = false;
  await Rgss.actions.decryptGame(entry, {}, context);
  assert.deepEqual(fs.readFileSync(path.join(output, 'Data', 'sample.txt')), bytes);
  assert.equal(downloads, 2); assert.equal(consents, 3);
  const install = manager.resolveSelection(entry, context.settings, context.userDataDir);
  assert.equal(install.ready, true); assert.equal(install.version, record.version);
  assert.match(install.install.executablePath, /runtimes.*rpgmaker-decrypter/);

  const mvInput = path.join(root, 'mv-game'); fs.mkdirSync(path.join(mvInput, 'js'), { recursive: true }); fs.mkdirSync(path.join(mvInput, 'data'));
  fs.writeFileSync(path.join(mvInput, 'js', 'rpg_core.js'), 'Utils.RPGMAKER_NAME = "MV";\nUtils.RPGMAKER_VERSION = "1.6.2";\n');
  fs.writeFileSync(path.join(mvInput, 'data', 'System.json'), JSON.stringify({ encryptionKey: '00000000000000000000000000000000', hasEncryptedImages: true, hasEncryptedAudio: false }));
  fs.mkdirSync(path.join(mvInput, 'img')); const image = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  const header = Buffer.from('5250474d560000000003010000000000', 'hex');
  fs.writeFileSync(path.join(mvInput, 'img', 'sample.rpgmvp'), Buffer.concat([header, image]));
  offline = true; const oldRefreshes = refreshes;
  context.confirmRuntimeInstall = async () => { throw Error('unexpected offline consent'); };
  const restarted = Manager.createManager(dependencies); Manager.ensure = restarted.ensure;
  await Mv.runDecrypter({ sourcePath: mvInput, outputDir: path.join(root, 'mv-output'), context, entry });
  assert.equal(fs.existsSync(path.join(mvInput, 'img', 'sample.png')), false);
  assert.deepEqual(fs.readFileSync(path.join(mvInput, 'img', 'sample.rpgmvp')), Buffer.concat([header, image]));
  assert.deepEqual(fs.readFileSync(path.join(root, 'mv-output', 'img', 'sample.png')), image);
  await Rgss.actions.decryptGame(entry, {}, context);
  assert.deepEqual(fs.readFileSync(path.join(output, 'Data', 'sample.txt')), bytes);
  assert.equal(refreshes, oldRefreshes); assert.equal(downloads, 2);
  const selected = restarted.resolveSelection(entry, context.settings, context.userDataDir);
  const executable = selected.install.executablePath;
  const fd = fs.openSync(executable, 'r+'); const original = Buffer.alloc(1); fs.readSync(fd, original, 0, 1, 4096); original[0] ^= 1; fs.writeSync(fd, original, 0, 1, 4096); fs.closeSync(fd);
  assert.equal(restarted.resolveSelection(entry, context.settings, context.userDataDir).ready, false);
});
