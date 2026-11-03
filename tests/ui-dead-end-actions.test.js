const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Construct = require('../src/modules/construct/main');
const AliceSoft = require('../src/modules/alicesoft/main');
const Nitroplus = require('../src/modules/nitroplus/manifest.json');
const { resolveExtractionRoot } = require('../src/modules/construct/extract');

test('Construct exposes a result folder only when extracted content is ready', t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-actions-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const entry = { gameId: 'game', moduleId: 'construct', moduleData: { packagedType: 'nwjs', packagedPath: path.join(userDataDir, 'bundle.exe') } };
  const refresh = () => Construct.actions.refreshExtractionStatus(entry, null, { userDataDir });
  const initial = refresh();
  assert.equal(initial.extractedReady, false);
  assert.equal(initial.extractedRoot, null);
  assert.equal(initial.extractionStatus, 'Extract bundle first');
  const extracted = resolveExtractionRoot({ entry, userDataDir });
  fs.mkdirSync(extracted, { recursive: true });
  fs.writeFileSync(path.join(extracted, 'index.html'), '<html>Construct 3</html>');
  const ready = refresh();
  assert.equal(ready.extractedReady, true);
  assert.equal(ready.extractedRoot, extracted);
  assert.equal(ready.extractionStatus, null);
  fs.rmSync(extracted, { recursive: true });
  assert.equal(refresh().extractedRoot, null, 'removed extracted content cannot leave an actionable result path');
});

test('AliceSoft resolves its ordinary save target before launch without creating it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-saves-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'profile'), gamePath = path.join(root, 'original-game');
  fs.mkdirSync(gamePath);
  const disk = Buffer.alloc(768);disk.writeUInt16LE(2, 0);disk.writeUInt16LE(3, 2);
  fs.writeFileSync(path.join(gamePath, 'ADISK.DAT'), disk);
  fs.writeFileSync(path.join(gamePath, 'system3.ini'), '[config]\nsavedir = Authored\n');
  const entry = { gameId: 'game', moduleId: 'alicesoft', gamePath, contentRootDir: gamePath, moduleData: {generation: 'system3'} };
  const context = {userDataDir, environment: {}}, result = AliceSoft.resolveSaveLocations(entry, context);
  const expected = path.join(gamePath, 'Authored');
  assert.equal(result.primaryDirectory, expected);
  assert.equal(fs.existsSync(expected), false, 'Reading upstream save configuration does not allocate the save folder');
  const {hydrateGameSaveLocations, saveDirectoryForEntry} = require('../src/core/save-locations');
  const registry = {getModule: () => AliceSoft};
  assert.equal(saveDirectoryForEntry(hydrateGameSaveLocations(entry, registry, context), registry), expected,
    'The Open Saves backend receives a real upstream target instead of a dead-end null path');
  entry.saveDirOverride = path.join(root, 'user-chosen');
  assert.equal(AliceSoft.resolveSaveLocations(entry, context).primaryDirectory, entry.saveDirOverride);
  assert.equal(fs.existsSync(entry.saveDirOverride), false);
  assert.equal(fs.existsSync(userDataDir), false, 'Save discovery does not route through a launcher save folder');
  assert.equal(AliceSoft.resolveSaveLocations({}, context).primaryDirectory, null);
});

test('Nitroplus archives and script tools remain directly available', () => {
  const group = Nitroplus.ui.actionGroups.find(group => group.id === 'advanced');
  assert.equal(group.label, 'Archives and scripts');
  assert.equal(group.collapsed, false);
  const actions = new Map(Nitroplus.ui.actions.map(action => [action.id, action]));
  assert.equal(group.actions[0], 'inspectGame', 'fresh profiles start with local archive inspection');
  assert.deepEqual(new Set(group.actions), new Set(['inspectGame', 'extractScripts', 'checkScripts', 'readNativeLog']));
  for (const id of group.actions) assert.ok(actions.get(id)?.label);
});
