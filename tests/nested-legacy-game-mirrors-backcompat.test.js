const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Backcompat = require('../src/modules/mac32/backcompat');
const Copy = require('../src/modules/shared/copy-file');
const GameStore = require('../src/core/game-store');
const { runDataMigrations } = require('../src/core/backcompat/data-migrations');
const { retireLegacyGameMirror } = require('../src/core/backcompat/legacy-game-mirrors');
const write = (root, relative, bytes) => {
  const file = path.join(root, relative);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, bytes);return file;
};
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nested-mirror-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), profile = path.join(home, 'Library/Application Support/MacLauncher');
  const mirror = path.join(profile, 'games/fixture/runtimes/mac32/home');
  fs.mkdirSync(mirror, { recursive: true });
  return { root, home, profile, mirror };
}
const descriptor = f => ({ mirrorRoot: f.mirror, sourceRoot: f.home });

test('copied mac32 profile nested under HOME recovers once using unchanged generic declarations and leaves private home intact', async t => {
  const original = fixture(t), missing = 'Library/Application Support/Example/slot.sav';
  const conflict = 'Documents/Example/config.ini', identical = 'Library/Preferences/example.plist';
  const protectedFiles = [write(original.mirror, missing, 'released save'), write(original.mirror, conflict, 'private config'),
    write(original.home, conflict, 'original config'), write(original.mirror, identical, 'same preference'), write(original.home, identical, 'same preference')];
  const sourceFacts = protectedFiles.map(file => ({ file, bytes: fs.readFileSync(file), stat: fs.statSync(file, { bigint: true }) }));
  const home = path.join(original.root, 'copied-home');
  Copy.cloneOrCopySync(original.home, home, { exclusive: true });
  const profile = path.join(home, path.relative(original.home, original.profile));
  const mirror = path.join(home, path.relative(original.home, original.mirror));
  const app = path.join(home, 'Games/Example.app');fs.mkdirSync(app, { recursive: true });
  const entry = { schemaVersion: GameStore.CURRENT_RECORD_SCHEMA_VERSION, gameId: 'fixture', moduleId: 'generic-app',
    gamePath: app, importPath: app, notes: 'authored notes', runtimeData: { mac32: { appPath: app } } };
  t.mock.method(os, 'homedir', () => home);
  const rows = Backcompat.legacyGameMirrors(entry, { userDataDir: profile });
  assert.deepEqual(rows.map(row => row.mirrorRoot), [mirror, path.join(path.dirname(mirror), 'work')]);
  assert.equal(rows[0].sourceRoot, home);
  const privateBefore = [missing, conflict, identical].map(relative => fs.readFileSync(path.join(mirror, relative)));
  const identicalBefore = fs.statSync(path.join(home, identical), { bigint: true });
  const readDirectory = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (file, ...args) => {
    assert.notEqual(String(file), home, 'recovery must not enumerate HOME');
    return readDirectory(file, ...args);
  });
  let settings = {}, recordWrites = 0;
  const options = { userDataDir: profile, settings, games: [entry],
    registry: { getModule: () => ({}), listRuntimeProviderModules: () => [Backcompat] },
    saveSettings(next) { settings = next; }, saveEntry(next) { recordWrites++;GameStore.writeGameRecord(profile, next); } };
  const result = await runDataMigrations(options);
  assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, []);assert.equal(recordWrites, 1);
  assert.equal(fs.readFileSync(path.join(home, missing), 'utf8'), 'released save');
  assert.equal(fs.readFileSync(path.join(home, conflict), 'utf8'), 'original config');
  const siblings = readDirectory(path.dirname(path.join(home, conflict))).filter(name => name.startsWith('config.ini.MacLauncher-conflict-'));
  assert.equal(siblings.length, 1);
  assert.equal(fs.readFileSync(path.join(home, 'Documents/Example', siblings[0]), 'utf8'), 'private config');
  assert.deepEqual(fs.statSync(path.join(home, identical), { bigint: true }), identicalBefore, 'identical destination is not rewritten');
  for (const [index, relative] of [missing, conflict, identical].entries())
    assert.deepEqual(fs.readFileSync(path.join(mirror, relative)), privateBefore[index]);
  assert.notEqual(fs.statSync(path.join(home, missing)).ino, fs.statSync(path.join(mirror, missing)).ino);
  const persisted = GameStore.readGameRecord(profile, 'fixture');
  assert.equal(persisted.notes, 'authored notes');assert.equal(persisted.gamePath, app);assert.equal(persisted.saveDirOverride, undefined);
  for (const item of sourceFacts) {
    assert.deepEqual(fs.readFileSync(item.file), item.bytes);
    const current = fs.statSync(item.file, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs']) assert.equal(current[key], item.stat[key]);
  }
  for (const name of ['lstatSync', 'readdirSync', 'openSync', 'mkdirSync']) t.mock.method(fs, name, () => assert.fail('completed migration performs no filesystem work'));
  await runDataMigrations({ ...options, settings, registry: { getModule: () => assert.fail('no repeated hooks'),
    listRuntimeProviderModules: () => assert.fail('no repeated provider enumeration') },
    saveSettings: () => assert.fail('no repeated settings write'), saveEntry: () => assert.fail('no repeated record write') });
});

test('nested recovery refuses private file/directory links and destination links without changing external targets', async t => {
  for (const mode of ['private-file', 'private-directory', 'destination-parent', 'destination-file']) await t.test(mode, async st => {
    const f = fixture(st), outside = path.join(f.root, 'protected');fs.mkdirSync(outside);
    const protectedFile = write(outside, 'keep', 'protected bytes');
    write(f.mirror, 'Documents/Game/slot', 'private bytes');
    if (mode.startsWith('private-')) fs.symlinkSync(mode === 'private-file' ? protectedFile : outside, path.join(f.mirror, 'link'));
    else if (mode === 'destination-parent') fs.symlinkSync(outside, path.join(f.home, 'Documents'));
    else { fs.mkdirSync(path.join(f.home, 'Documents/Game'), { recursive: true });fs.symlinkSync(protectedFile, path.join(f.home, 'Documents/Game/slot')); }
    const result = await retireLegacyGameMirror(descriptor(f), { userDataDir: f.profile });
    // A linked leaf is retained as the original; recovery may only publish an
    // independent conflict sibling beside it, never follow it.
    assert.equal(result.complete, mode === 'destination-file');
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'protected bytes');
    assert.equal(fs.readFileSync(path.join(f.mirror, 'Documents/Game/slot'), 'utf8'), 'private bytes');
    assert.deepEqual(fs.readdirSync(outside), ['keep']);
  });
});

test('nested recovery preflights mapped private-tree targets before any copy', async t => {
  const f = fixture(t);write(f.mirror, 'Documents/Game/first', 'private first');
  const relative = path.join(path.relative(f.home, f.mirror), 'loop');write(f.mirror, relative, 'must not self-copy');
  const result = await retireLegacyGameMirror(descriptor(f), { userDataDir: f.profile });
  assert.equal(result.complete, false);assert.match(result.reason, /land inside the folder it came from/);
  assert.equal(fs.existsSync(path.join(f.home, 'Documents')), false);
  assert.equal(fs.readFileSync(path.join(f.mirror, relative), 'utf8'), 'must not self-copy');
  for (const sourceRoot of [f.mirror, path.join(f.mirror, 'new-child')])
    assert.equal((await retireLegacyGameMirror({ mirrorRoot: f.mirror, sourceRoot }, { userDataDir: f.profile })).complete, false);
  assert.equal(fs.existsSync(path.join(f.mirror, 'new-child')), false);
});

test('failed nested exclusive copy retains originals and every private byte', async t => {
  const f = fixture(t);write(f.mirror, 'Documents/Game/slot', 'private');write(f.home, 'Documents/Game/slot', 'original');
  t.mock.method(fs.promises, 'chmod', async () => { throw Object.assign(Error('copy unavailable'), { code: 'EACCES' }); });
  const result = await retireLegacyGameMirror(descriptor(f), { userDataDir: f.profile });
  assert.equal(result.complete, false);
  assert.equal(fs.readFileSync(path.join(f.home, 'Documents/Game/slot'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(f.mirror, 'Documents/Game/slot'), 'utf8'), 'private');
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'Documents/Game')), ['slot']);
});

test('ordinary disjoint recovery retains its existing deletion and matching-link behavior', async t => {
  const f = fixture(t), source = path.join(f.root, 'original-game');fs.mkdirSync(source);
  write(f.mirror, 'slot', 'private');write(source, 'asset', 'original');fs.symlinkSync(path.join(source, 'asset'), path.join(f.mirror, 'asset'));
  const result = await retireLegacyGameMirror({ mirrorRoot: f.mirror, sourceRoot: source }, { userDataDir: f.profile });
  assert.equal(result.complete, true);assert.equal(fs.existsSync(f.mirror), false);
  assert.equal(fs.readFileSync(path.join(source, 'slot'), 'utf8'), 'private');
  assert.equal(fs.readFileSync(path.join(source, 'asset'), 'utf8'), 'original');
});
