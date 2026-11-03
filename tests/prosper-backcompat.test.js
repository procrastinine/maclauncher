const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { gameDirectory } = require("../src/modules/prosper/prepare");
const { legacyGameMirrors } = require("../src/modules/prosper/backcompat");

function originalGame(root, name = 'selected.elf') {
  const game = path.join(root, 'game'); fs.mkdirSync(game, {recursive: true});
  const elf = Buffer.alloc(64);
  Buffer.from([127, 69, 76, 70, 2, 1, 1, 9]).copy(elf);
  elf.writeUInt16LE(0xfe00, 16); elf.writeUInt16LE(62, 18);
  elf.writeUInt16LE(64, 52); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(1, 56);
  const executablePath = path.join(game, name); fs.mkdirSync(path.dirname(executablePath), {recursive: true});
  fs.writeFileSync(executablePath, elf);
  return {moduleId: 'anyps5', gameId: 'original', gamePath: game, runtimeId: 'prosper', moduleData: {format: 'elf', executablePath}};
}

test('released Prosper obsolete writable-source mapping remains confined to the one-time descriptor hook', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-once-mapping-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const entry = originalGame(root), context = {userDataDir: path.join(root, 'profile')};
  const original = entry.gamePath, privateView = path.join(context.userDataDir, 'old-writable-view');
  entry.contentRootDir = privateView;
  entry.moduleData.writableInput = {schemaVersion: 1, root: privateView, sourceRoot: original};
  const before = JSON.stringify(entry), descriptors = legacyGameMirrors(entry, context);
  assert.equal(descriptors.find(row => row.mirrorRoot === path.join(gameDirectory(entry, context), 'app0')).sourceRoot, original);
  assert.equal(JSON.stringify(entry), before, 'Descriptor generation does not rewrite current records or run a migration');
  assert.equal(fs.existsSync(context.userDataDir), false, 'The old mapping hook creates no folders');
});

test('released Prosper absence of private configuration never invents a visible config override', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-no-old-config-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const entry = originalGame(root), context = {userDataDir: path.join(root, 'profile')}; entry.moduleData.titleId = 'PPSA12345';
  const before = JSON.stringify(entry), mirrorRoot = path.join(gameDirectory(entry, context), 'home', '.config', 'prosper');
  const descriptor = legacyGameMirrors(entry, context).find(row => row.mirrorRoot === mirrorRoot);
  assert.equal(descriptor?.entryPatch, undefined);
  assert.equal(JSON.stringify(entry), before);
  assert.equal(fs.existsSync(context.userDataDir), false);
});

test('released Prosper bytes recover at actual save, config and original game destinations without replacing conflicts', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-released-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const names = ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'PROSPER_SAVE0', 'PROSPER_SAVEDATA_DIR', 'PROSPER_APP_CONFIG', 'PROSPER_CAPTURE_DIR', 'PROSPER_TEMP0', 'PROSPER_DOWNLOAD0'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  process.env.HOME = path.join(root, 'home'); process.env.XDG_DATA_HOME = path.join(root, 'actual-data');
  process.env.XDG_CONFIG_HOME = path.join(root, 'actual-config');
  for (const name of names.filter(name => name.startsWith('PROSPER_'))) delete process.env[name];
  const entry = originalGame(root), context = {userDataDir: path.join(process.env.HOME, 'launcher')};
  entry.moduleData.titleId = 'PPSA12345';
  const released = gameDirectory(entry, context);
  const rows = [
    [path.join(released, 'saves', 'savedata0'), path.join(root, 'actual-data', 'prosper', 'savedata0'), 'PPSA12345/slot.sav', 'released save'],
    [path.join(released, 'saves', 'memory'), path.join(root, 'actual-data', 'prosper', 'savedata-mem'), 'PPSA12345/memory.bin', 'released memory'],
    [path.join(released, 'home', '.config', 'prosper'), path.join(root, 'actual-config', 'prosper', 'games', entry.gameId), 'prosper-app.conf', 'released config'],
    [path.join(released, 'app0'), entry.gamePath, 'game-created.dat', 'released game bytes'],
    [path.join(released, 'captures'), entry.gamePath, 'frame.png', 'released capture']
  ];
  const {retireLegacyGameMirror} = require('../src/core/backcompat/legacy-game-mirrors');
  for (const [mirrorRoot, sourceRoot, relative, bytes] of rows) {
    fs.mkdirSync(path.dirname(path.join(mirrorRoot, relative)), {recursive: true}); fs.writeFileSync(path.join(mirrorRoot, relative), bytes);
    fs.mkdirSync(sourceRoot, {recursive: true});
    const descriptor = legacyGameMirrors(entry, context).find(row => row.mirrorRoot === mirrorRoot);
    assert.equal(descriptor.mirrorRoot, mirrorRoot);
    assert.equal(descriptor.sourceRoot, sourceRoot, 'The exact v0.5.1 root has a descriptor to its normal runtime destination');
    if (relative === 'prosper-app.conf') assert.equal(descriptor.entryPatch.runtimeSettings.prosper.configPath, path.join(sourceRoot, relative));
    const result = await retireLegacyGameMirror(descriptor, context);
    assert.equal(result.complete, true, result.reason);
    assert.equal(fs.readFileSync(path.join(sourceRoot, relative), 'utf8'), bytes, 'The runtime loads the normal filename, not a recovery directory');
    fs.mkdirSync(path.dirname(path.join(mirrorRoot, relative)), {recursive: true}); fs.writeFileSync(path.join(mirrorRoot, relative), 'private conflict');
    const conflict = await retireLegacyGameMirror(descriptor, context);
    assert.equal(conflict.complete, true, conflict.reason);
    assert.equal(fs.readFileSync(path.join(sourceRoot, relative), 'utf8'), bytes, 'An original conflict stays authoritative');
    assert.ok(conflict.recoveredFiles.some(file => fs.readFileSync(file, 'utf8') === 'private conflict'), 'Differing private bytes remain separately preserved');
  }
  process.env.PROSPER_CAPTURE_DIR = 'captures-chosen'; process.env.PROSPER_TEMP0 = path.join(root, 'chosen-temp');
  process.env.PROSPER_DOWNLOAD0 = path.join(root, 'chosen-download');
  const overridden = legacyGameMirrors(entry, context);
  assert.equal(overridden.find(row => row.mirrorRoot === path.join(released, 'captures')).sourceRoot, path.join(entry.gamePath, 'captures-chosen'));
  assert.equal(overridden.find(row => row.mirrorRoot === path.join(released, 'tmp')).sourceRoot, process.env.PROSPER_TEMP0);
  assert.equal(overridden.find(row => row.mirrorRoot === path.join(released, 'saves', 'download0')).sourceRoot, process.env.PROSPER_DOWNLOAD0);
});

test('released Prosper selected save override recovers attributable unknown-title bytes without adopting shared global saves', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-unknown-released-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const previous = process.env.XDG_DATA_HOME; process.env.XDG_DATA_HOME = path.join(root, 'user-data');
  t.after(() => { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; });
  const shared = path.join(process.env.XDG_DATA_HOME, 'prosper', 'savedata0', '_unknown-title');
  fs.mkdirSync(shared, {recursive: true}); fs.writeFileSync(path.join(shared, 'shared.sav'), 'unattributable global save');
  const {retireLegacyGameMirror} = require('../src/core/backcompat/legacy-game-mirrors');
  for (const [gameId, runtimeId] of [['first', 'prosper'], ['second', 'anyps5']]) {
    const entry = {...originalGame(root), gameId, runtimeId, runtimeData: {anyps5: {version: 'keep'}, prosper: {version: 'keep-too'}},
      ...(runtimeId === 'anyps5' ? {saveDirOverride: '/chosen-anyps5'} : {})};
    const expected = path.join(process.env.XDG_DATA_HOME, 'prosper', 'games', gameId);
    entry.runtimeData.prosper.saveDirOverride = expected;
    if (runtimeId === 'prosper') entry.saveDirOverride = expected;
    const context = {userDataDir: path.join(root, 'profile')}, mirrorRoot = path.join(gameDirectory(entry, context), 'saves', 'savedata0');
    fs.mkdirSync(path.join(mirrorRoot, '_unknown-title'), {recursive: true});
    fs.writeFileSync(path.join(mirrorRoot, '_unknown-title', 'slot.sav'), gameId);
    const descriptor = legacyGameMirrors(entry, context).find(row => row.mirrorRoot === mirrorRoot);
    assert.equal(descriptor.sourceRoot, path.join(expected, 'savedata0'));
    assert.equal(descriptor.entryPatch, undefined, 'Backcompat uses the ordinary selected override without a blanket identity patch');
    assert.equal(entry.saveDirOverride, runtimeId === 'anyps5' ? '/chosen-anyps5' : expected);
    fs.mkdirSync(descriptor.sourceRoot, {recursive: true});
    const result = await retireLegacyGameMirror(descriptor, context);
    assert.equal(result.complete, true, result.reason);
    assert.equal(fs.readFileSync(path.join(descriptor.sourceRoot, '_unknown-title', 'slot.sav'), 'utf8'), gameId);
    assert.equal(fs.existsSync(path.join(descriptor.sourceRoot, '_unknown-title', 'shared.sav')), false);
  }
  assert.equal(fs.readFileSync(path.join(shared, 'shared.sav'), 'utf8'), 'unattributable global save');
});

test('released Prosper missing normal save directory recovers beneath its existing upstream data anchor', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-standard-anchor-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const names = ['XDG_DATA_HOME', 'PROSPER_SAVE0'], previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  process.env.XDG_DATA_HOME = path.join(root, 'ordinary-user-data'); delete process.env.PROSPER_SAVE0;
  fs.mkdirSync(process.env.XDG_DATA_HOME);
  const entry = originalGame(root), context = {userDataDir: path.join(root, 'profile')}; entry.moduleData.titleId = 'PPSA12345';
  const mirrorRoot = path.join(gameDirectory(entry, context), 'saves', 'savedata0');
  fs.mkdirSync(path.join(mirrorRoot, 'PPSA12345'), {recursive: true}); fs.writeFileSync(path.join(mirrorRoot, 'PPSA12345', 'slot.sav'), 'released slot');
  const descriptor = legacyGameMirrors(entry, context).find(row => row.mirrorRoot === mirrorRoot);
  assert.equal(descriptor.createSourceWithin, process.env.XDG_DATA_HOME);
  assert.equal(fs.existsSync(descriptor.sourceRoot), false);
  const result = await require('../src/core/backcompat/legacy-game-mirrors').retireLegacyGameMirror(descriptor, context);
  assert.equal(result.complete, true, result.reason);
  assert.equal(fs.readFileSync(path.join(descriptor.sourceRoot, 'PPSA12345', 'slot.sav'), 'utf8'), 'released slot');
  assert.equal(fs.existsSync(mirrorRoot), false);
});

test('released Prosper actual private config recovery applies the persisted entryPatch only to its existing game', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-config-entry-patch-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const names = ['XDG_CONFIG_HOME', 'PROSPER_APP_CONFIG'], previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  process.env.XDG_CONFIG_HOME = path.join(root, 'normal-user-config'); delete process.env.PROSPER_APP_CONFIG;
  fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME, 'prosper'), {recursive: true});
  const ordinaryGlobal = path.join(process.env.XDG_CONFIG_HOME, 'prosper', 'prosper-app.conf');
  fs.writeFileSync(ordinaryGlobal, 'intentional global player preferences');
  const entry = originalGame(root), userDataDir = path.join(root, 'profile'); entry.moduleData.titleId = 'PPSA12345';
  entry.runtimeData = {another: {version: 'preserved'}}; entry.runtimeSettings = {another: {setting: true}, prosper: {showFps: true}};
  const untouched = {...entry, gameId: 'without-private-config', runtimeData: {}, runtimeSettings: {}};
  const old = path.join(gameDirectory(entry, {userDataDir}), 'home', '.config', 'prosper');
  fs.mkdirSync(old, {recursive: true}); fs.writeFileSync(path.join(old, 'prosper-app.conf'), 'guest_args = -force-gfx-direct\n');
  const {runDataMigrations} = require('../src/core/backcompat/data-migrations');
  const persisted = [];
  const result = await runDataMigrations({settings: {}, games: [entry, untouched], userDataDir,
    registry: {getModule: () => ({}), listRuntimeProviderModules: () => [{legacyGameMirrors}]},
    saveSettings: async () => {}, saveEntry: async row => persisted.push(structuredClone(row))});
  assert.equal(result.complete, true);
  assert.deepEqual(result.pendingIds, []);
  const expected = path.join(process.env.XDG_CONFIG_HOME, 'prosper', 'games', entry.gameId, 'prosper-app.conf');
  assert.equal(entry.runtimeSettings.prosper.configPath, expected);
  assert.equal(persisted[0].runtimeSettings.prosper.configPath, expected);
  assert.equal(persisted[0].runtimeSettings.another.setting, true);
  assert.equal(persisted[0].runtimeData.another.version, 'preserved');
  assert.equal(fs.readFileSync(expected, 'utf8'), 'guest_args = -force-gfx-direct\n');
  assert.equal(fs.readFileSync(ordinaryGlobal, 'utf8'), 'intentional global player preferences');
  assert.equal(untouched.runtimeSettings?.prosper?.configPath, undefined, 'An existing game without private preferences gains no blanket override');
  const prepared = await require('../src/modules/prosper/prepare').prepareGame(entry, {userDataDir});
  assert.equal(prepared.environment.PROSPER_APP_CONFIG, expected, 'Current preparation consumes the successfully persisted ordinary setting');
  await runDataMigrations({settings: result.settings, games: [entry, untouched], userDataDir,
    registry: {getModule: () => assert.fail('Completed one-time migration must not consult old state')}});
});

test('released Prosper saves with an absent normal destination remain explicitly blocked and intact', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prosper-missing-destination-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const previous = process.env.PROSPER_SAVE0; process.env.PROSPER_SAVE0 = path.join(root, 'absent', 'savedata0');
  t.after(() => { if (previous === undefined) delete process.env.PROSPER_SAVE0; else process.env.PROSPER_SAVE0 = previous; });
  const entry = originalGame(root), context = {userDataDir: path.join(root, 'profile')};
  entry.moduleData.titleId = 'PPSA12345';
  const mirrorRoot = path.join(gameDirectory(entry, context), 'saves', 'savedata0');
  fs.mkdirSync(mirrorRoot, {recursive: true}); fs.writeFileSync(path.join(mirrorRoot, 'slot.sav'), 'released bytes');
  const descriptor = legacyGameMirrors(entry, context).find(row => row.mirrorRoot === mirrorRoot);
  const result = await require('../src/core/backcompat/legacy-game-mirrors').retireLegacyGameMirror(descriptor, context);
  assert.equal(result.complete, false, 'Missing-destination support belongs to the shared migration owner');
  assert.equal(fs.existsSync(path.join(descriptor.sourceRoot, 'slot.sav')), false, 'Released save does not load at the normal destination yet');
  assert.equal(fs.readFileSync(path.join(mirrorRoot, 'slot.sav'), 'utf8'), 'released bytes');
});


test("Prosper released config facts stay minimal and cannot represent split save roots", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prosper-route-facts-"))); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const names = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "PROSPER_SAVE0", "PROSPER_SAVEDATA_DIR", "PROSPER_APP_CONFIG"], previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  process.env.HOME = path.join(root, "home"); process.env.XDG_DATA_HOME = path.join(root, "data"); process.env.XDG_CONFIG_HOME = path.join(root, "config");
  for (const name of names.filter(name => name.startsWith("PROSPER_"))) delete process.env[name];
  const baseline = {...originalGame(root), launchArguments: "--fps"}, userDataDir = path.join(root, "profile"), oldRoot = gameDirectory(baseline, {userDataDir});
  const mirrorRoot = path.join(oldRoot, "home", ".config", "prosper"), file = path.join(mirrorRoot, "prosper-app.conf");
  fs.mkdirSync(mirrorRoot, {recursive: true}); fs.writeFileSync(file, "released preferences");
  for (const name of ["savedata0", "memory"]) fs.mkdirSync(path.join(oldRoot, "saves", name), {recursive: true});
  const current = {...baseline, runtimeSettings: {prosper: {configPath: path.join(root, "generated", "prosper-app.conf"), showFps: true}}};
  const before = JSON.stringify(current), context = {userDataDir, games: [baseline], gameArguments: ["--fps"]};
  const descriptor = legacyGameMirrors(current, context).find(row => row.mirrorRoot === mirrorRoot);
  assert.deepEqual(descriptor.releasedSaveRoute, {directory: mirrorRoot, entryPatch: {runtimeSettings: {prosper: {configPath: file}}}, proven: true, explicit: false});
  assert.equal(JSON.stringify(current), before);
  for (const row of legacyGameMirrors(current, context).filter(row => ["savedata0", "memory"].includes(path.basename(row.mirrorRoot)))) assert.equal(row.releasedSaveRoute, undefined, "one ordinary save override cannot select one retired sibling");
  const authored = {...baseline, runtimeSettings: {prosper: {configPath: path.join(root, "authored", "prosper-app.conf")}}};
  assert.equal(legacyGameMirrors(current, {...context, games: [authored]}).find(row => row.mirrorRoot === mirrorRoot).releasedSaveRoute.explicit, true);
  process.env.PROSPER_SAVE0 = path.join(root, "authored-env");
  assert.equal(legacyGameMirrors(current, context).find(row => row.mirrorRoot === mirrorRoot).releasedSaveRoute.explicit, true); delete process.env.PROSPER_SAVE0;
  const pending = legacyGameMirrors({...current, gamePath: "unknown-original"}, context);
  assert.equal(pending.length, 1); assert.equal(pending[0].sourceRoot, null); assert.deepEqual(pending[0].releasedSaveRoute, descriptor.releasedSaveRoute);
  delete process.env.HOME; delete process.env.XDG_CONFIG_HOME;
  const unknownConfigParent = legacyGameMirrors(baseline, {userDataDir}).find(row => row.mirrorRoot === mirrorRoot);
  assert.equal(unknownConfigParent.sourceRoot, null); assert.deepEqual(unknownConfigParent.releasedSaveRoute, descriptor.releasedSaveRoute);
  assert.equal(fs.readFileSync(file, "utf8"), "released preferences");
});
