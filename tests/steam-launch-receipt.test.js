const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { normalizeVersions, readDefaultWindowsExecutable } = require('../src/core/steam-downloads');

test('Steam Windows launch metadata preserves the unique publisher default and does not guess inferred or ambiguous entries', () => {
  const info = { common: { oslist: 'windows,macos' }, config: { launch: {
    0: { executable: 'Configuration.exe', type: 'option', config: { oslist: 'windows' } },
    1: { executable: 'Game.app', type: 'default', config: { oslist: 'macos' } },
    2: { executable: 'bin\\Game.exe', type: 'default', arguments: '--publisher-mode', workingdir: 'bin', config: { oslist: 'windows', osarch: '64' }, futurePublisherField: 'preserved' }
  } } };
  const before = structuredClone(info), versions = normalizeVersions(480, info);
  assert.equal(versions.defaultWindowsLaunch.id, '2'); assert.equal(versions.defaultWindowsLaunch.executable, 'bin\\Game.exe');
  assert.equal(versions.defaultWindowsLaunch.arguments, '--publisher-mode'); assert.equal(versions.defaultWindowsLaunch.workingdir, 'bin');
  assert.deepEqual(versions.defaultWindowsLaunch.config, { oslist: 'windows', osarch: '64' });
  assert.equal(versions.defaultWindowsLaunch.futurePublisherField, 'preserved'); assert.deepEqual(info, before);
  const ambiguous = structuredClone(info); ambiguous.config.launch[3] = { ...ambiguous.config.launch[2], executable: 'alternate.exe' };
  const alternatives = normalizeVersions(480, ambiguous);
  assert.equal(alternatives.defaultWindowsLaunch, null); assert.equal(alternatives.launchOptions.length, 4);
  assert.equal(normalizeVersions(480, { common: { oslist: 'windows' }, config: { launch: { 0: { executable: 'inferred.exe', type: 'default' } } } }).defaultWindowsLaunch, null);
});

test('Steam default launch receipt reader uses moved roots and silently ignores missing, older or unsafe metadata', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-launch-receipt-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.maclauncher-steam.json');
  const receipt = { schema: 1, complete: true, platform: 'windows', path: '/previous/download/root', defaultWindowsLaunch: { executable: 'bin\\Game.exe' } };
  const write = value => fs.writeFileSync(file, JSON.stringify(value));
  assert.equal(readDefaultWindowsExecutable(root), null); write(receipt);
  assert.equal(readDefaultWindowsExecutable(root), path.join(root, 'bin/Game.exe'));
  for (const value of [{ ...receipt, complete: false }, { ...receipt, platform: 'macos' }, { ...receipt, defaultWindowsLaunch: undefined }]) {
    write(value); assert.equal(readDefaultWindowsExecutable(root), null);
  }
  for (const executable of ['', '.', '../Game.exe', 'bin/../Game.exe', '/outside/Game.exe', 'C:\\Game.exe', 'C:Game.exe', '\\Game.exe', '\\\\server\\Game.exe', 'bin/Bad\nGame.exe']) {
    write({ ...receipt, defaultWindowsLaunch: { executable } }); assert.equal(readDefaultWindowsExecutable(root), null, executable);
  }
  fs.writeFileSync(file, '{malformed'); assert.equal(readDefaultWindowsExecutable(root), null);
  assert.equal(readDefaultWindowsExecutable(null), null);
});
