const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CURRENT_RECORD_SCHEMA_VERSION: CURRENT } = require('../src/core/game-store');
const { runDataMigrations, ORIGINAL_GAME_MIRRORS_MIGRATION: KEY } = require('../src/core/backcompat/data-migrations');
const { retireLegacyGameMirror } = require('../src/core/backcompat/legacy-game-mirrors');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'data-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'), source = path.join(root, 'Original'), mirror = path.join(profile, 'games', 'one', 'view');
  fs.mkdirSync(source);fs.mkdirSync(mirror, { recursive: true });
  return { root, profile, source, mirror };
}
function write(root, relative, bytes) { const file = path.join(root, relative);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, bytes);return file; }

test('declared mirrors recover missing files into the actual game tree and preserve conflicts as sibling regular files', async t => {
  const f = fixture(t);write(f.source, 'asset', 'same');write(f.mirror, 'asset', 'same');
  write(f.source, 'saves/slot', 'original');write(f.mirror, 'saves/slot', 'private');write(f.mirror, 'new/save', 'unique');
  write(f.mirror, 'receipt.json', 'owned receipt');write(f.source, 'asset-link', 'linked original');
  fs.symlinkSync(path.join(f.source, 'asset-link'), path.join(f.mirror, 'asset-link'));
  const result = await retireLegacyGameMirror({ mirrorRoot: f.mirror, sourceRoot: f.source, generated: ['receipt.json'] }, { userDataDir: f.profile });
  assert.equal(result.complete, true);assert.equal(fs.existsSync(f.mirror), false);
  const conflict = result.recoveredFiles.find(file => file.startsWith(path.join(f.source, 'saves/slot.MacLauncher-conflict-')));
  assert.ok(conflict);assert.equal(fs.lstatSync(conflict).isSymbolicLink(), false);
  assert.equal(fs.statSync(conflict).nlink, 1, 'published recovery has no surviving staging link');
  assert.equal(fs.readFileSync(path.join(f.source, 'saves/slot'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'private');
  assert.equal(fs.readFileSync(path.join(f.source, 'new/save'), 'utf8'), 'unique');
  assert.equal(fs.existsSync(path.join(f.source, 'receipt.json')), false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['Original', 'profile'], 'no recovery directory appears beside the game');
  fs.rmSync(f.profile, { recursive: true });assert.equal(fs.readFileSync(path.join(f.source, 'new/save'), 'utf8'), 'unique');
});

test('unknown links and linked mirror parents retain the affected root without following or changing targets', async t => {
  const f = fixture(t), outside = write(f.root, 'outside', 'must remain');write(f.mirror, 'save', 'private');fs.symlinkSync(outside, path.join(f.mirror, 'unknown'));
  const result = await retireLegacyGameMirror({ mirrorRoot: f.mirror, sourceRoot: f.source }, { userDataDir: f.profile });
  assert.equal(result.complete, false);assert.equal(fs.readFileSync(path.join(f.mirror, 'save'), 'utf8'), 'private');assert.equal(fs.readFileSync(outside, 'utf8'), 'must remain');
  const alias = path.join(f.profile, 'alias');fs.symlinkSync(path.dirname(f.mirror), alias);
  assert.equal((await retireLegacyGameMirror({ mirrorRoot: path.join(alias, 'view'), sourceRoot: f.source }, { userDataDir: f.profile })).complete, false);
});

test('failed exclusive recovery preserves every original and private file', async t => {
  const f = fixture(t);write(f.mirror, 'save', 'private');write(f.source, 'save', 'original');
  t.mock.method(fs.promises, 'chmod', async () => { throw Object.assign(Error('read-only original parent'), { code: 'EACCES' }); });
  const result = await retireLegacyGameMirror({ mirrorRoot: f.mirror, sourceRoot: f.source }, { userDataDir: f.profile });
  assert.equal(result.complete, false);assert.equal(fs.readFileSync(path.join(f.mirror, 'save'), 'utf8'), 'private');assert.equal(fs.readFileSync(path.join(f.source, 'save'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(f.source), ['save'], 'failed staging leaves no conflict or temporary file');
});

test('absent declared mirrors complete without inspecting a missing original; unsafe roots stay pending', async t => {
  const f = fixture(t);
  assert.equal((await retireLegacyGameMirror({ mirrorRoot: path.join(f.profile, 'absent/view'), sourceRoot: path.join(f.root, 'missing') }, { userDataDir: f.profile })).complete, true);
  for (const mirrorRoot of [f.source, f.profile]) assert.equal((await retireLegacyGameMirror({ mirrorRoot, sourceRoot: f.source }, { userDataDir: f.profile })).complete, false);
});

test('an absent owned mirror completes before inspecting an extracted canonical source inside the profile', async t => {
  const f = fixture(t), source = path.join(f.profile, 'canonical/extracted');
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    assert.notEqual(String(file), source, 'an absent mirror must not inspect the source');return lstat(file, ...args);
  });
  assert.equal((await retireLegacyGameMirror({ mirrorRoot: path.join(f.profile, 'never-created/view'), sourceRoot: source }, { userDataDir: f.profile })).complete, true);
});

test('necessary extracted canonical sources inside the profile receive recovered files directly without external directories', async t => {
  const f = fixture(t), source = path.join(f.profile, 'canonical/extracted');fs.mkdirSync(source, { recursive: true });
  write(f.mirror, 'saves/slot', 'private save');write(source, 'existing', 'canonical');write(f.mirror, 'existing', 'private conflict');
  const result = await retireLegacyGameMirror({ mirrorRoot: f.mirror, sourceRoot: source }, { userDataDir: f.profile });
  assert.equal(result.complete, true);assert.equal(fs.readFileSync(path.join(source, 'saves/slot'), 'utf8'), 'private save');
  assert.equal(fs.readFileSync(path.join(source, 'existing'), 'utf8'), 'canonical');
  const conflict = result.recoveredFiles.find(file => file.startsWith(path.join(source, 'existing.MacLauncher-conflict-')));
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'private conflict');assert.equal(fs.existsSync(f.mirror), false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['Original', 'profile']);
});

test('completed settings return before filesystem work, registry callbacks or persistence', async t => {
  const retained = [{ id: 'unsafe', failures: [{ reason: 'unavailable original' }] }];
  const settings = { dataMigrations: { [KEY]: { complete: true, remainingIds: [], pendingIds: ['unsafe'], retained } } };
  for (const method of ['lstatSync', 'readdirSync', 'openSync', 'mkdirSync']) t.mock.method(fs, method, () => assert.fail('Completed migrations perform no filesystem work'));
  const result = await runDataMigrations({ settings, games: [{ schemaVersion: CURRENT, gameId: 'one', moduleId: 'one' }], registry: {
    getModule: () => assert.fail('No module hook'), listSharedRuntimeManagers: () => assert.fail('No shared registry enumeration'),
    listRuntimeProviderModules: () => assert.fail('No runtime-provider enumeration')
  }, saveSettings: () => assert.fail('No settings write') });
  assert.equal(result.settings, settings);assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, ['unsafe']);assert.deepEqual(result.retained, retained);
});

test('failed entries are attempted once and retained diagnostically without future hooks or filesystem probes', async t => {
  const f = fixture(t), calls = [], saved = [], entriesSaved = [];let settings = {}, retry = false;
  const games = [{ schemaVersion: CURRENT, id: 'unsafe', moduleId: 'one' }, { schemaVersion: CURRENT, id: 'unaffected', moduleId: 'one' }];
  const registry = { getModule: () => ({ legacyGameMirrors: entry => {
    calls.push(entry.id);return entry.id === 'unsafe' && !retry ? [{ mirrorRoot: f.source, sourceRoot: f.source }] : [];
  } }) };
  const options = { settings, games, registry, userDataDir: f.profile, saveSettings: next => { saved.push(next);settings = next; }, saveEntry: entry => entriesSaved.push(entry.id) };
  const first = await runDataMigrations(options);assert.deepEqual(first.pendingIds, ['unsafe']);assert.equal(first.complete, true);assert.deepEqual(first.remainingIds, []);
  assert.deepEqual(saved[0].dataMigrations[KEY].remainingIds, ['unsafe', 'unaffected'], 'automatic queue is saved before any hook');
  assert.deepEqual(calls, ['unsafe', 'unaffected']);assert.deepEqual(entriesSaved, ['unsafe', 'unaffected']);
  retry = true;calls.length = 0;
  const second = await runDataMigrations({ ...options, settings, games: [...games, { schemaVersion: CURRENT, id: 'new', moduleId: 'one' }] });
  assert.deepEqual(calls, []);assert.equal(second.complete, true);assert.deepEqual(second.pendingIds, ['unsafe']);
  assert.equal(settings.dataMigrations[KEY].complete, true);
  await runDataMigrations({ ...options, settings });assert.deepEqual(calls, []);
});

test('crash resume uses canonical gameId and only remaining IDs; removed entries become diagnostics rather than endless work', async t => {
  const f = fixture(t), calls = [];
  const settings = { dataMigrations: { [KEY]: { complete: false, remainingIds: ['canonical-id', 'removed'], pendingIds: ['retained-id'] } } };
  const result = await runDataMigrations({ settings, userDataDir: f.profile,
    games: [{ schemaVersion: CURRENT, gameId: 'canonical-id', id: 'wrong-id', gamePath: '/WrongPath', moduleId: 'one' }, { schemaVersion: CURRENT, gameId: 'new-id', moduleId: 'one' }],
    registry: { getModule: () => ({ legacyGameMirrors: entry => { calls.push(entry.gameId);return []; } }) }, saveSettings() {} });
  assert.deepEqual(calls, ['canonical-id']);assert.equal(result.complete, true);assert.deepEqual(result.remainingIds, []);
  assert.deepEqual(result.pendingIds, ['retained-id', 'removed']);assert.match(result.retained[0].failures[0].reason, /entry was removed/);
});

test('unavailable canonical source retains the old private bytes with a recorded failed-once result', async t => {
  const f = fixture(t);write(f.mirror, 'save', 'sole private save');
  const descriptor = { mirrorRoot: f.mirror, sourceRoot: path.join(f.root, 'missing-original') };
  const result = await runDataMigrations({ settings: {}, games: [{ schemaVersion: CURRENT, gameId: 'one', moduleId: 'one' }], userDataDir: f.profile,
    registry: { getModule: () => ({ legacyGameMirrors: () => [descriptor] }) }, saveSettings() {} });
  assert.equal(result.complete, true);assert.deepEqual(result.remainingIds, []);assert.deepEqual(result.pendingIds, ['one']);
  assert.equal(result.retained[0].failures[0].mirrorRoot, f.mirror);assert.equal(fs.readFileSync(path.join(f.mirror, 'save'), 'utf8'), 'sole private save');
});

test('initial settings persistence must succeed before module hooks or mirror cleanup', async t => {
  const f = fixture(t);write(f.mirror, 'save', 'private');
  await assert.rejects(runDataMigrations({ settings: {}, games: [{ schemaVersion: CURRENT, id: 'one', moduleId: 'one' }], userDataDir: f.profile,
    registry: { getModule: () => assert.fail('No hooks before checkpoint') }, saveSettings: () => { throw Error('settings unavailable'); } }), /settings unavailable/);
  assert.equal(fs.readFileSync(path.join(f.mirror, 'save'), 'utf8'), 'private');
});

test('shared runtime mirror hooks join module descriptors only for first-run or remaining entries', async t => {
  for (const resume of [false, true]) {
    const f = fixture(t), sharedMirror = path.join(f.profile, 'games/one/shared-view'), events = [];
    write(f.mirror, 'module-save', 'module private');write(sharedMirror, 'shared-save', 'shared private');
    const shared = { id: 'shared-owner', async legacyGameMirrors(entry, context) {
      assert.equal(this, shared);assert.equal(entry.gameId, 'one');assert.equal(context.userDataDir, f.profile);
      events.push('shared');return [{ mirrorRoot: sharedMirror, sourceRoot: f.source }];
    } };
    const registry = {
      listSharedRuntimeManagers() { events.push('list');return [shared, { id: 'no-migration-hook' }]; },
      getModule() { return { legacyGameMirrors(entry) { assert.equal(entry.gameId, 'one');events.push('module');return [{ mirrorRoot: f.mirror, sourceRoot: f.source }]; } }; }
    };
    const settings = resume ? { dataMigrations: { [KEY]: { complete: false, remainingIds: ['one'], pendingIds: [] } } } : {};
    const games = [{ schemaVersion: CURRENT, gameId: 'one', moduleId: 'one' }, ...(resume ? [{ schemaVersion: CURRENT, gameId: 'new', moduleId: 'one' }] : [])];
    const result = await runDataMigrations({ settings, games, registry, userDataDir: f.profile, saveSettings() { events.push('save'); } });
    assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, []);
    assert.equal(events.filter(event => event === 'list').length, 1);assert.equal(events.filter(event => event === 'module').length, 1);assert.equal(events.filter(event => event === 'shared').length, 1);
    assert.ok(events.indexOf('save') < events.indexOf('module'));assert.ok(events.indexOf('module') < events.indexOf('shared'));
    assert.equal(fs.readFileSync(path.join(f.source, 'module-save'), 'utf8'), 'module private');
    assert.equal(fs.readFileSync(path.join(f.source, 'shared-save'), 'utf8'), 'shared private');
    assert.equal(fs.existsSync(f.mirror), false);assert.equal(fs.existsSync(sharedMirror), false);
  }
});

test('exclusive recovery publication leaves no partial original after I/O failure or source mutation and preserves raced targets', async t => {
  for (const scenario of ['io-failure', 'changed-source', 'raced-target']) await t.test(scenario, async st => {
    const f = fixture(st), privateFile = write(f.mirror, 'save', 'private'), destination = path.join(f.source, 'save');
    if (scenario === 'io-failure') st.mock.method(fs.promises, 'chmod', async () => { throw Object.assign(Error('staging I/O failure'), { code: 'EIO' }); });
    if (scenario === 'changed-source') {
      const chmod = fs.promises.chmod;
      st.mock.method(fs.promises, 'chmod', async (...args) => { fs.writeFileSync(privateFile, 'changed');return chmod(...args); });
    }
    if (scenario === 'raced-target') {
      const link = fs.promises.link;
      st.mock.method(fs.promises, 'link', async (from, to) => {
        if (to === destination) fs.writeFileSync(destination, 'legitimate concurrent save', { flag: 'wx' });
        return link(from, to);
      });
    }
    const result = await retireLegacyGameMirror({ mirrorRoot: f.mirror, sourceRoot: f.source }, { userDataDir: f.profile });
    assert.equal(result.complete, false);assert.equal(fs.existsSync(f.mirror), true);
    assert.equal(fs.readFileSync(privateFile, 'utf8'), scenario === 'changed-source' ? 'changed' : 'private');
    if (scenario === 'raced-target') assert.equal(fs.readFileSync(destination, 'utf8'), 'legitimate concurrent save');
    else assert.equal(fs.existsSync(destination), false, 'failed recovery never exposes partial or invalid original bytes');
    assert.equal(fs.readdirSync(f.source).some(name => name.startsWith('.copy-') || name.startsWith('.clone-')), false, 'owned stages are removed');
  });
});

test('hook record edits persist from a working clone before updating the loaded game entry', async t => {
  for (const rejectSave of [false, true]) await t.test(rejectSave ? 'save failure' : 'successful save', async st => {
    const original = { schemaVersion: CURRENT, gameId: 'one', moduleId: 'one', launchArguments: '--authored', moduleData: { identity: 'current' } }, saved = [];
    const result = await runDataMigrations({ settings: {}, games: [original], saveSettings() {},
      registry: { getModule: () => ({ legacyGameMirrors(entry) {
        assert.notEqual(entry, original);assert.notEqual(entry.moduleData, original.moduleData);
        entry.launchArguments += ' --gameid=released-id';entry.moduleData.identity = 'released';return [];
      } }) }, saveEntry: async working => {
        assert.equal(original.launchArguments, '--authored');assert.equal(original.moduleData.identity, 'current');
        saved.push(structuredClone(working));if (rejectSave) throw Error('record write failed');
      } });
    assert.equal(saved.length, 1);assert.equal(saved[0].launchArguments, '--authored --gameid=released-id');
    if (rejectSave) { assert.equal(original.launchArguments, '--authored');assert.deepEqual(result.pendingIds, ['one']); }
    else { assert.equal(original.launchArguments, saved[0].launchArguments);assert.equal(original.moduleData.identity, 'released');assert.deepEqual(result.pendingIds, []); }
  });
});

test('retained explicit workspace recovers saves and conflicts once while retiring only declared obsolete generated files', async t => {
  const f = fixture(t), buildOutput = write(f.profile, 'games/one/builds/output.zip', 'unchanged build output');
  write(f.source, 'save/conflict', 'original');write(f.mirror, 'save/conflict', 'private conflict');write(f.mirror, 'save/missing', 'private missing');
  write(f.source, 'build-receipt.json', 'current build receipt');write(f.mirror, 'build-receipt.json', 'current build receipt');
  const generated = write(f.mirror, 'obsolete-steam-bootstrap.py', '# owned obsolete bootstrap');
  const privateBefore = fs.readFileSync(path.join(f.mirror, 'save/conflict')), outputBefore = fs.readFileSync(buildOutput);
  let hooks = 0;
  const options = { settings: {}, games: [{ schemaVersion: CURRENT, gameId: 'one', moduleId: 'one' }], userDataDir: f.profile, saveSettings() {}, saveEntry() {},
    registry: { getModule: () => ({ legacyGameMirrors() { hooks++;return [{ mirrorRoot: f.mirror, sourceRoot: f.source, retainMirror: true, generated: ['obsolete-steam-bootstrap.py'] }]; } }) } };
  const result = await runDataMigrations(options);
  assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, []);assert.equal(hooks, 1);
  assert.equal(fs.existsSync(f.mirror), true);assert.deepEqual(fs.readFileSync(path.join(f.mirror, 'save/conflict')), privateBefore);
  assert.equal(fs.readFileSync(path.join(f.mirror, 'save/missing'), 'utf8'), 'private missing');assert.deepEqual(fs.readFileSync(buildOutput), outputBefore);
  assert.equal(fs.readFileSync(path.join(f.mirror, 'build-receipt.json'), 'utf8'), 'current build receipt');assert.equal(fs.existsSync(generated), false);
  assert.equal(fs.readFileSync(path.join(f.source, 'save/missing'), 'utf8'), 'private missing');assert.equal(fs.readFileSync(path.join(f.source, 'save/conflict'), 'utf8'), 'original');
  const conflict = fs.readdirSync(path.join(f.source, 'save')).find(name => name.startsWith('conflict.MacLauncher-conflict-'));
  assert.equal(fs.readFileSync(path.join(f.source, 'save', conflict), 'utf8'), 'private conflict');
  const second = await runDataMigrations({ ...options, settings: result.settings, registry: { getModule: () => assert.fail('A retained workspace must not be inspected again'), listSharedRuntimeManagers: () => assert.fail('No shared hook discovery') } });
  assert.equal(second.complete, true);assert.equal(hooks, 1);
});

test('once-per-game attempt checkpoint prevents hook reentry after an interrupted attempt and deduplicates identical hooks and roots', async t => {
  let checkpoint, release, calls = 0;
  const sharedHook = async () => { calls++;await new Promise(resolve => { release = resolve; });return []; };
  const registry = { getModule: () => ({ legacyGameMirrors: sharedHook }), listSharedRuntimeManagers: () => [{ legacyGameMirrors: sharedHook }, { legacyGameMirrors: sharedHook }] };
  const pending = runDataMigrations({ settings: {}, games: [{ schemaVersion: CURRENT, gameId: 'one', moduleId: 'one' }], registry, saveSettings: next => { checkpoint = next; }, saveEntry() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);assert.deepEqual(checkpoint.dataMigrations[KEY].remainingIds, []);assert.deepEqual(checkpoint.dataMigrations[KEY].pendingIds, ['one']);
  const resumed = await runDataMigrations({ settings: checkpoint, games: [{ schemaVersion: CURRENT, gameId: 'one', moduleId: 'one' }],
    registry: { getModule: () => assert.fail('Interrupted game must not run twice'), listSharedRuntimeManagers: () => assert.fail('Completed queue must not enumerate') } });
  assert.equal(resumed.complete, true);assert.deepEqual(resumed.pendingIds, ['one']);assert.match(resumed.retained[0].failures[0].reason, /interrupted/);
  release();const finished = await pending;assert.deepEqual(finished.pendingIds, []);assert.equal(calls, 1);
  const f = fixture(t);let probes = 0;const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => { if (file === f.mirror) probes++;return lstat(file, ...args); });
  const descriptor = { mirrorRoot: f.mirror, sourceRoot: f.source };
  const result = await runDataMigrations({ settings: {}, games: [{ schemaVersion: CURRENT, gameId: 'one', moduleId: 'one' }], userDataDir: f.profile, saveSettings() {},
    registry: { getModule: () => ({ legacyGameMirrors: () => [descriptor, { ...descriptor }] }) } });
  assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, []);assert.equal(probes, 1, 'one known root is visited once despite duplicate descriptors');
});

test('runtime-provider module hooks recover another module entry once with shared and repeated owners isolated', async t => {
  const f = fixture(t), providerRoot = path.join(f.profile, 'games/one/provider-view'), calls = [];
  write(f.mirror, 'module-save', 'module bytes');write(providerRoot, 'provider-save', 'provider bytes');
  write(providerRoot, 'conflict', 'private conflict');write(f.source, 'conflict', 'existing original');
  const providerDescriptor = { mirrorRoot: providerRoot, sourceRoot: f.source, retainMirror: true };
  const entryModule = { legacyGameMirrors(entry) { assert.equal(entry.moduleId, 'other-entry-module');calls.push('entry');return [{ mirrorRoot: f.mirror, sourceRoot: f.source }]; } };
  const providerModule = { legacyGameMirrors(entry, context) {
    assert.equal(this, providerModule);assert.equal(entry.moduleId, 'other-entry-module');assert.equal(context.userDataDir, f.profile);
    calls.push('provider');return [providerDescriptor, { ...providerDescriptor }];
  } };
  const shared = { legacyGameMirrors() { calls.push('shared');return [{ generated: [], sourceRoot: path.join(f.source, '.'), retainMirror: true, mirrorRoot: providerRoot }]; } };
  let providerEnumerations = 0;
  const registry = { getModule: () => entryModule, listRuntimeProviderModules() { providerEnumerations++;return [entryModule, providerModule, providerModule]; },
    listSharedRuntimeManagers: () => [shared, providerModule] };
  const result = await runDataMigrations({ settings: {}, games: [{ schemaVersion: CURRENT, gameId: 'one', moduleId: 'other-entry-module' }], registry, userDataDir: f.profile, saveSettings() {}, saveEntry() {} });
  assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, []);assert.equal(providerEnumerations, 1);
  assert.deepEqual(calls, ['entry', 'provider', 'shared']);
  assert.equal(fs.readFileSync(path.join(f.source, 'module-save'), 'utf8'), 'module bytes');assert.equal(fs.readFileSync(path.join(f.source, 'provider-save'), 'utf8'), 'provider bytes');
  assert.equal(fs.existsSync(f.mirror), false);assert.equal(fs.existsSync(providerRoot), true);
  assert.equal(fs.readFileSync(path.join(f.source, 'conflict'), 'utf8'), 'existing original');
  const conflicts = fs.readdirSync(f.source).filter(name => name.startsWith('conflict.MacLauncher-conflict-'));
  assert.equal(conflicts.length, 1, 'duplicate root descriptors do not repeat conflict recovery');
  assert.equal(fs.readFileSync(path.join(f.source, conflicts[0]), 'utf8'), 'private conflict');
});

test('explicit existing source anchor initializes the actual upstream save folder and recovers the released save once', async t => {
  const f = fixture(t), source = path.join(f.source, 'normal-engine/userdata');write(f.mirror, 'slot.sav', 'released save');
  const result = await retireLegacyGameMirror({ mirrorRoot: f.mirror, sourceRoot: source, createSourceWithin: f.source }, { userDataDir: f.profile });
  assert.equal(result.complete, true);assert.equal(fs.readFileSync(path.join(source, 'slot.sav'), 'utf8'), 'released save');assert.equal(fs.existsSync(f.mirror), false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['Original', 'profile'], 'no unrelated recovery/game directory is created outside the declared anchor');
});

test('source creation rejects missing outside and symlink anchors without creating directories or discarding private bytes', async t => {
  for (const scenario of ['missing-anchor', 'outside-anchor', 'symlink-anchor', 'symlink-parent', 'overlapping-mirror']) await t.test(scenario, async st => {
    const f = fixture(st);write(f.mirror, 'slot.sav', 'sole released save');
    let anchor = f.source, source = path.join(f.source, 'not-created/userdata'), external;
    if (scenario === 'missing-anchor') { anchor = path.join(f.root, 'offline-game');source = path.join(anchor, 'userdata'); }
    if (scenario === 'outside-anchor') source = path.join(f.root, 'not-the-game/userdata');
    if (scenario === 'symlink-anchor') { anchor = path.join(f.root, 'game-link');fs.symlinkSync(f.source, anchor);source = path.join(anchor, 'userdata'); }
    if (scenario === 'symlink-parent') { external = path.join(f.root, 'external');fs.mkdirSync(external);fs.symlinkSync(external, path.join(anchor, 'redirect'));source = path.join(anchor, 'redirect/userdata'); }
    if (scenario === 'overlapping-mirror') { anchor = f.profile;source = path.join(f.mirror, 'userdata'); }
    const result = await retireLegacyGameMirror({ mirrorRoot: f.mirror, sourceRoot: source, createSourceWithin: anchor }, { userDataDir: f.profile });
    assert.equal(result.complete, false);assert.equal(fs.existsSync(source), false);assert.equal(fs.readFileSync(path.join(f.mirror, 'slot.sav'), 'utf8'), 'sole released save');
    if (scenario === 'missing-anchor') assert.equal(fs.existsSync(anchor), false, 'an offline game/volume anchor is never fabricated');
    if (external) assert.deepEqual(fs.readdirSync(external), [], 'a source directory link is never followed');
    if (scenario === 'outside-anchor') assert.equal(fs.existsSync(path.join(f.root, 'not-the-game')), false);
  });
});

test('successful descriptor entryPatch merges current fields without clobbering sibling provider changes and persists before cache update', async t => {
  const f = fixture(t), one = path.join(f.profile, 'absent-one'), two = path.join(f.profile, 'absent-two');
  const original = { schemaVersion: CURRENT, gameId: 'one', moduleId: 'one', launchArguments: '--authored', runtimeData: { first: { existing: 1 }, other: { keep: true } }, saveLocations: ['old'] };
  let persisted;
  const result = await runDataMigrations({ settings: {}, games: [original], userDataDir: f.profile, saveSettings() {},
    registry: { getModule: () => ({ legacyGameMirrors: () => [
      { mirrorRoot: one, sourceRoot: f.source, entryPatch: { launchArguments: '--authored --gameid=released', runtimeData: { first: { added: 2 } }, saveLocations: ['normal'] } },
      { mirrorRoot: two, sourceRoot: f.source, entryPatch: { runtimeData: { second: { added: 3 } } } }
    ] }), listSharedRuntimeManagers: () => [{ legacyGameMirrors(entry) {
      entry.runtimeData.fromHook = { keep: 4 };
      return [{ mirrorRoot: one, sourceRoot: f.source, entryPatch: { runtimeData: { first: { fromShared: 5 } } } }];
    } }] }, saveEntry: async working => { assert.equal(original.launchArguments, '--authored');persisted = structuredClone(working); } });
  assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, []);assert.equal(persisted.launchArguments, '--authored --gameid=released');
  assert.deepEqual(persisted.runtimeData, { first: { existing: 1, added: 2, fromShared: 5 }, other: { keep: true }, second: { added: 3 }, fromHook: { keep: 4 } });
  assert.deepEqual(persisted.saveLocations, ['normal']);assert.deepEqual(original, persisted);
});

test('failed descriptor retirement does not apply entryPatch arguments or point current settings at an empty new save root', async t => {
  const f = fixture(t), target = path.join(f.source, 'new-upstream-saves');write(f.mirror, 'slot', 'sole private save');
  const original = { schemaVersion: CURRENT, gameId: 'one', moduleId: 'one', launchArguments: '--authored --gameid=explicit', saveDirOverride: '/Previous', runtimeData: { keep: true } }, before = structuredClone(original);
  t.mock.method(fs.promises, 'chmod', async () => { throw Object.assign(Error('copy I/O failure'), { code: 'EIO' }); });
  let persisted;
  const result = await runDataMigrations({ settings: {}, games: [original], userDataDir: f.profile, saveSettings() {}, saveEntry: working => { persisted = structuredClone(working); },
    registry: { getModule: () => ({ legacyGameMirrors: () => [{ mirrorRoot: f.mirror, sourceRoot: target, createSourceWithin: f.source,
      entryPatch: { launchArguments: '--wrong', saveDirOverride: target, runtimeData: { keep: false } } }] }) } });
  assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, ['one']);assert.deepEqual(original, before);assert.deepEqual(persisted, before);
  assert.deepEqual(fs.readdirSync(target), []);assert.equal(fs.readFileSync(path.join(f.mirror, 'slot'), 'utf8'), 'sole private save');
  assert.match(result.retained[0].failures[0].reason, /copy I\/O failure/);
});

test('invalid descriptor entryPatch is diagnosed without partial record mutation or retiring private files', async t => {
  const cycle = {};cycle.self = cycle;
  let getterCalls = 0;const accessor = {};Object.defineProperty(accessor, 'bad', { enumerable: true, get() { getterCalls++;return 'bad'; } });
  const patches = [
    { launchArguments: 'must-not-apply', runtimeData: { bad: () => 'bad' } },
    { launchArguments: 'must-not-apply', runtimeData: cycle },
    JSON.parse('{"launchArguments":"must-not-apply","__proto__":{"polluted":true}}'),
    { launchArguments: 'must-not-apply', runtimeData: accessor }, ['not-a-record']
  ];
  for (const patch of patches) {
    const f = fixture(t);write(f.mirror, 'slot', 'private');const original = { schemaVersion: CURRENT, gameId: 'one', moduleId: 'one', launchArguments: '--authored' };
    const result = await runDataMigrations({ settings: {}, games: [original], userDataDir: f.profile, saveSettings() {}, saveEntry: working => assert.equal(working.launchArguments, '--authored'),
      registry: { getModule: () => ({ legacyGameMirrors: () => [{ mirrorRoot: f.mirror, sourceRoot: f.source, entryPatch: patch }] }) } });
    assert.deepEqual(result.pendingIds, ['one']);assert.equal(result.complete, true);assert.equal(original.launchArguments, '--authored');
    assert.match(result.retained[0].failures[0].reason, /unusable recovery result/);assert.equal(fs.readFileSync(path.join(f.mirror, 'slot'), 'utf8'), 'private');
  }
  assert.equal(getterCalls, 0);assert.equal({}.polluted, undefined);
});

test('post-recovery hooks see exact outcomes once and cumulative successful save maps survive stale later patches', async t => {
  const f = fixture(t), second = path.join(f.profile, 'second-view'), failed = path.join(f.profile, 'failed-view'), source2 = path.join(f.root, 'second-source');fs.mkdirSync(source2);
  write(f.mirror, 'one', 'one');write(second, 'two', 'two');write(failed, 'sole', 'retained');
  const original = { schemaVersion: CURRENT, gameId: 'one', moduleId: 'one', gamePath: f.source, importPath: path.join(f.source, 'original.exe'), contentRootDir: failed,
    defaultSaveDir: f.mirror, saveDirOverride: '/AuthoredOverride', launchArguments: '--authored', saveLocations: [
      { id: 'first', directory: path.join(f.mirror, 'one') }, { id: 'second', directory: path.join(second, 'two') }, { id: 'failed', directory: failed }, { provider: 'authored', directory: '/AuthoredProvider' }
    ] };
  const stale = structuredClone(original.saveLocations);let postCalls = 0, saved;
  const owner = { legacyGameMirrors: () => [
    { mirrorRoot: f.mirror, sourceRoot: f.source, entryPatch: { saveLocations: stale } },
    { mirrorRoot: second, sourceRoot: source2, entryPatch: { saveLocations: stale } },
    { mirrorRoot: failed, sourceRoot: path.join(f.root, 'unavailable'), entryPatch: { launchArguments: '--must-not-apply' } }
  ], migrateLegacyGameData(snapshot, context) {
    postCalls++;assert.notEqual(snapshot, original);assert.equal(context.settings.authoredSetting, true);
    assert.deepEqual(context.successfulDescriptors.map(row => row.mirrorRoot), [f.mirror, second]);assert.deepEqual(context.failedDescriptors.map(row => row.mirrorRoot), [failed]);
    assert.deepEqual(context.descriptorResults.map(row => row.result.complete), [true, true, false]);
    assert.equal(fs.existsSync(f.mirror), false);assert.equal(fs.existsSync(second), false);assert.equal(fs.existsSync(failed), true);
    return { complete: true, entryPatch: { defaultSaveDir: f.mirror, saveLocations: stale, contentRootDir: '/WrongFailedNormalization' } };
  } };
  const result = await runDataMigrations({ settings: { authoredSetting: true }, games: [original], userDataDir: f.profile,
    registry: { getModule: () => owner, listRuntimeProviderModules: () => [owner] }, saveSettings() {}, saveEntry: entry => { saved = structuredClone(entry); } });
  assert.equal(postCalls, 1);assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, ['one']);
  assert.equal(saved.defaultSaveDir, f.source);assert.equal(saved.contentRootDir, failed);assert.equal(saved.saveDirOverride, '/AuthoredOverride');assert.equal(saved.launchArguments, '--authored');
  assert.deepEqual(saved.saveLocations, [{ id: 'first', directory: path.join(f.source, 'one') }, { id: 'second', directory: path.join(source2, 'two') }, { id: 'failed', directory: failed }, { provider: 'authored', directory: '/AuthoredProvider' }]);
  assert.equal(saved.gameId, 'one');assert.equal(saved.gamePath, f.source);assert.equal(saved.importPath, path.join(f.source, 'original.exe'));
});

test('post-only shared owners persist validated success patches while failed invalid or identity-changing patches stay diagnostic', async t => {
  for (const scenario of ['success', 'failed', 'invalid', 'identity', 'direct-mutation']) {
    const original = { schemaVersion: CURRENT, gameId: 'one', moduleId: 'one', gamePath: '/Original', importPath: '/Original.exe', launchArguments: '--authored' };
    let calls = 0;
    const owner = { migrateLegacyGameData(entry, context) {
      calls++;assert.deepEqual(context.successfulDescriptors, []);assert.deepEqual(context.failedDescriptors, []);
      if (scenario === 'failed') return { complete: false, reason: 'receipt unavailable' };
      if (scenario === 'invalid') return { complete: true, entryPatch: { launchArguments: '--wrong', bad: () => {} } };
      if (scenario === 'identity') return { complete: true, entryPatch: { launchArguments: '--wrong', gamePath: '/Different' } };
      if (scenario === 'direct-mutation') { entry.launchArguments = '--wrong';return { complete: true }; }
      return { complete: true, entryPatch: { launchArguments: '--authored --released-setting', moduleData: { converted: true } } };
    } };
    const result = await runDataMigrations({ settings: {}, games: [original], registry: { getModule: () => ({}), listSharedRuntimeManagers: () => [owner, owner] }, saveSettings() {}, saveEntry() {} });
    assert.equal(calls, 1);assert.equal(result.complete, true);
    if (scenario === 'success') { assert.deepEqual(result.pendingIds, []);assert.equal(original.launchArguments, '--authored --released-setting'); }
    else { assert.deepEqual(result.pendingIds, ['one']);assert.equal(original.launchArguments, '--authored');assert.ok(result.retained[0].failures[0].reason); }
    assert.equal(original.gamePath, '/Original');assert.equal(original.importPath, '/Original.exe');assert.equal(original.gameId, 'one');
  }
});

test('post-hook null is a no-op and owner-scoped outcomes exclude unrelated provider failures using loaded games', async t => {
  const f = fixture(t), good = { mirrorRoot: path.join(f.profile, 'absent-good'), sourceRoot: f.source }, bad = { mirrorRoot: f.mirror, sourceRoot: path.join(f.root, 'unavailable') };
  write(f.mirror, 'sole', 'private');const games = [{ schemaVersion: CURRENT, gameId: 'one', moduleId: 'one' }], calls = [];
  const entryOwner = { legacyGameMirrors: () => [good], migrateLegacyGameData(entry, context) {
    assert.equal(context.games, games);assert.deepEqual(context.ownerSuccessfulDescriptors, [good]);assert.deepEqual(context.ownerFailedDescriptors, []);
    assert.deepEqual(context.failedDescriptors, [bad]);calls.push('good');return { complete: true, entryPatch: { moduleData: { normalized: true } } };
  } };
  const providerOwner = { legacyGameMirrors: () => [bad], migrateLegacyGameData(entry, context) {
    assert.deepEqual(context.ownerSuccessfulDescriptors, []);assert.deepEqual(context.ownerFailedDescriptors, [bad]);calls.push('bad');return null;
  } };
  const noopOwner = { migrateLegacyGameData() { calls.push('noop');return null; } };
  const result = await runDataMigrations({ settings: {}, games, userDataDir: f.profile,
    registry: { getModule: () => entryOwner, listRuntimeProviderModules: () => [providerOwner, noopOwner] }, saveSettings() {}, saveEntry() {} });
  assert.deepEqual(calls, ['good', 'bad', 'noop']);assert.deepEqual(result.pendingIds, ['one']);assert.equal(result.retained[0].failures.length, 1, 'null callbacks add no failure');
  assert.equal(games[0].moduleData.normalized, true);assert.equal(fs.readFileSync(path.join(f.mirror, 'sole'), 'utf8'), 'private');
});

test('descriptor and post hooks share loaded library identity facts for a real cross-module collision without scans', async t => {
  const f = fixture(t), { applySaveIdentity } = require('../src/core/save-identity'), common = path.join(f.source, 'upstream-shared-save');
  const target = { schemaVersion: CURRENT, gameId: 'target', moduleId: 'target-module' }, peer = { schemaVersion: CURRENT, gameId: 'peer', moduleId: 'peer-module' }, games = [target, peer], factCalls = [];
  const describe = (entry, context) => {
    assert.equal(context.games, games);assert.equal(context.settings.keepSetting, true);assert.equal(context.userDataDir, f.profile);
    factCalls.push(entry.gameId);
    return { namespace: 'filesystem', identity: entry.saveDirOverride || common,
      createPatch: ({ gameId, reason }) => { assert.equal(reason, 'collision');return { saveDirOverride: path.join(f.source, 'upstream-save', gameId) }; } };
  };
  const targetOwner = { resolveSaveIdentity: describe, legacyGameMirrors(entry, context) {
    const prospective = applySaveIdentity(entry, { games: context.games, describe: context.describeSaveIdentity, context });
    assert.notEqual(prospective.saveDirOverride, undefined);
    return [{ mirrorRoot: path.join(f.profile, 'absent-released-view'), sourceRoot: prospective.saveDirOverride,
      entryPatch: { saveDirOverride: prospective.saveDirOverride } }];
  }, migrateLegacyGameData(entry, context) {
    assert.equal(context.describeSaveIdentity(peer, context).identity, common);return null;
  } };
  const settings = { keepSetting: true, dataMigrations: { [KEY]: { complete: false, remainingIds: ['target'], pendingIds: [] } } };
  const result = await runDataMigrations({ settings, games, userDataDir: f.profile,
    registry: { getModule: id => id === 'target-module' ? targetOwner : { resolveSaveIdentity: describe } }, saveSettings() {}, saveEntry() {} });
  assert.deepEqual(result.pendingIds, []);assert.equal(result.complete, true);assert.ok(factCalls.includes('target') && factCalls.includes('peer'));
  assert.equal(target.saveDirOverride, path.join(f.source, 'upstream-save/target'));assert.equal(peer.saveDirOverride, undefined);
});

test('post-result retained roots preserve successful adoption and feed the existing explicit removal guard once', async t => {
  const f = fixture(t), { retainedGameDataRemoval, assertRetainedGameDataRemoval } = require('../src/core/backcompat/game-removal');
  const entry = { schemaVersion: CURRENT, gameId: 'one', moduleId: 'one' }, older = path.join(f.profile, 'games/one/older-profile');let settings;
  const result = await runDataMigrations({ settings: {}, games: [entry], userDataDir: f.profile,
    registry: { getModule: () => ({ migrateLegacyGameData: () => ({ complete: true,
      entryPatch: { runtimeData: { currentProfile: 'adopted-working-profile' } }, retained: [
        { runtimeId: 'fixture-runtime', path: f.mirror, reason: 'Divergent older profile retained intentionally.' },
        { runtimeId: 'fixture-runtime', path: older, reason: 'Older environment unavailable.' }
      ] }) }) }, saveSettings: next => { settings = next; }, saveEntry() {} });
  assert.equal(result.complete, true);assert.deepEqual(result.remainingIds, []);assert.deepEqual(result.pendingIds, ['one']);
  assert.equal(entry.runtimeData.currentProfile, 'adopted-working-profile');
  assert.deepEqual(result.retained[0].failures.map(row => row.mirrorRoot), [f.mirror, older]);
  const acknowledgment = retainedGameDataRemoval(entry, settings, f.profile);
  assert.deepEqual(acknowledgment.retained.map(row => row.mirrorRoot), [f.mirror, older]);
  assert.throws(() => assertRetainedGameDataRemoval(entry, settings, f.profile), { code: 'GAME_DATA_RETAINED' });
  assert.doesNotThrow(() => assertRetainedGameDataRemoval(entry, settings, f.profile, acknowledgment));
  const again = await runDataMigrations({ settings, games: [entry], registry: { getModule: () => assert.fail('No retained-root retries') } });
  assert.deepEqual(again.retained, result.retained);
});
