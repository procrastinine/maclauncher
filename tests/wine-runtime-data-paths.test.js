const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runtimeDataPath } = require('../src/modules/crossover/sources/launch-steps');
const { prepareGamePaths } = require('../src/modules/shared/runtime/wine-game-paths');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wine-runtime-data-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'installed-engine'), data = path.join(engine, 'share', 'wine');
  const prefix = path.join(root, 'prefix');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(prefix);
  return { root, engine, data, prefix };
}

for (const rootKey of ['crossoverRoot', 'engineRoot', 'wineRoot']) {
  test(`${rootKey}: bundled Mono discovery uses the shared data drive below MAX_PATH`, t => {
    const f = fixture(t);
    const mono = path.join(f.data, 'mono', 'wine-mono-10.4.1', 'bin', 'libmono-2.0-x86.dll');
    fs.mkdirSync(path.dirname(mono), { recursive: true });
    fs.writeFileSync(mono, 'fixture Mono payload');
    const view = path.join(f.root, 'graphics', 'identity-'.repeat(20), 'wine');
    const bundle = path.join(view, 'MacLauncher Game.app');
    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    fs.symlinkSync(path.join(f.engine, 'share'), path.join(bundle, 'share'), 'dir');
    // This is ntdll's path from Contents/MacOS: ../../share/wine. Wine's
    // find_drive_nt_root compares stat device/inode before collapsing '..'.
    const derived = path.join(bundle, 'Contents', 'MacOS') + '/../../share/wine';
    const rawDll = 'Z:' + (derived + '/mono/wine-mono-10.4.1/bin/libmono-2.0-x86.dll').replaceAll('/', '\\');
    assert.ok(rawDll.length >= 260, 'the fixture crosses mscoree find_mono_dll MAX_PATH');
    const gameRoot = path.join(f.root, 'original-game');
    fs.mkdirSync(gameRoot);fs.writeFileSync(path.join(gameRoot, 'Game.exe'), 'fixture game');
    const gamePaths = prepareGamePaths(f.prefix, { gameRoot, executablePath: path.join(gameRoot, 'Game.exe') });
    assert.equal(gamePaths.windowsExecutablePath, 'G:\\Game.exe');
    const install = { [rootKey]: f.engine, executablePath: path.join(f.engine, 'bin', 'wine') };
    const drive = runtimeDataPath(f.prefix, install);
    assert.equal(drive, 'H:\\', 'the existing game drive is retained');
    const mapped = path.join(f.prefix, 'dosdevices', drive[0].toLowerCase() + ':');
    assert.equal(fs.statSync(mapped).dev, fs.statSync(derived).dev);
    assert.equal(fs.statSync(mapped).ino, fs.statSync(derived).ino, 'ntdll matches the relocated share alias to this drive');
    const suffix = 'mono\\wine-mono-10.4.1\\bin\\libmono-2.0-x86.dll';
    assert.ok((drive + suffix).length < 260);
    assert.equal(fs.readFileSync(path.join(mapped, ...suffix.split('\\')), 'utf8'), 'fixture Mono payload');
    assert.equal(runtimeDataPath(f.prefix, install), drive, 'a later Play reuses its mapping');
    assert.equal(fs.readFileSync(mono, 'utf8'), 'fixture Mono payload');
    assert.deepEqual(fs.readdirSync(path.join(f.prefix, 'dosdevices')).sort(), ['g:', 'h:']);
  });
}

test('runtime data mapping preserves occupied drives and reuses an existing external mapping', t => {
  const f = fixture(t), devices = path.join(f.prefix, 'dosdevices');
  fs.mkdirSync(devices);fs.symlinkSync(f.root, path.join(devices, 'g:'), 'dir');
  fs.symlinkSync(f.data, path.join(devices, 'd:'), 'dir');
  const before = fs.readlinkSync(path.join(devices, 'g:'));
  assert.equal(runtimeDataPath(f.prefix, { engineRoot: f.engine }), 'D:\\');
  assert.equal(fs.readlinkSync(path.join(devices, 'g:')), before);
  assert.deepEqual(fs.readdirSync(devices).sort(), ['d:', 'g:']);
});

test('an engine without shared data does not create a drive or select a Mono version', t => {
  const f = fixture(t);fs.rmSync(f.data, { recursive: true });
  assert.equal(runtimeDataPath(f.prefix, { engineRoot: f.engine }), null);
  assert.equal(fs.existsSync(path.join(f.prefix, 'dosdevices')), false);
});
