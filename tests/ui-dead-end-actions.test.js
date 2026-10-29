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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-saves-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const entry = { gameId: 'game', saveDirOverride: path.join(userDataDir, 'custom') };
  const result = AliceSoft.resolveSaveLocations(entry, { userDataDir });
  assert.equal(result.primaryDirectory, path.join(userDataDir, 'games', 'game', 'modules', 'alicesoft', 'saves'));
  assert.equal(fs.existsSync(result.primaryDirectory), false);
  assert.equal(entry.saveDirOverride, path.join(userDataDir, 'custom'));
  assert.equal(AliceSoft.resolveSaveLocations({}, { userDataDir }).primaryDirectory, null);
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
