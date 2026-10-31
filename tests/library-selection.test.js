const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { toggleLibrarySelection } = require('../src/core/library-selection.mjs');
const { selectLibraryEntries, missingGamePaths, trashLibraryGames } = require('../src/core/library-maintenance');
const { checkGameAvailability } = require('../src/core/game-availability');

test('selection toggles individual games and Shift selects ranges in visible sort order', () => {
  const visible = ['c', 'a', 'd', 'b'];
  const first = toggleLibrarySelection([], visible, 'a', null);
  assert.deepEqual(first, { selected: ['a'], anchor: 'a' });
  const range = toggleLibrarySelection(first.selected, visible, 'b', first.anchor, true);
  assert.deepEqual(range, { selected: ['a', 'd', 'b'], anchor: 'a' });
  const cleared = toggleLibrarySelection(range.selected, visible, 'd', range.anchor, true);
  assert.deepEqual(cleared.selected, ['b']);
  assert.deepEqual(toggleLibrarySelection(['hidden', 'c'], ['c', 'b'], 'b', 'hidden', true), { selected: ['c', 'b'], anchor: 'b' });
});

test('batch requests dedupe selected library paths and reject paths outside the library', () => {
  const games = [{ gamePath: '/a' }, { gamePath: '/b' }];
  assert.deepEqual(selectLibraryEntries(games, ['/b', '/b']), [games[1]]);
  assert.throws(() => selectLibraryEntries(games, ['/outside']), /not found/);
  assert.throws(() => selectLibraryEntries(games, '/a'), /list of game paths/);
  assert.throws(() => selectLibraryEntries(games, [null]), /list of game paths/);
});

test('missing checks honor selected scope and distinguish inaccessible paths from missing files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-library-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const present = path.join(root, 'present');
  const missing = path.join(root, 'missing');
  fs.mkdirSync(present);
  const games = [{ gamePath: present }, { gamePath: missing }];
  const check = async (paths, options) => {
    const entries = selectLibraryEntries(games, paths);
    return missingGamePaths(entries, await Promise.all(entries.map(entry => checkGameAvailability(entry, options))));
  };
  assert.deepEqual(await check([present]), []);
  assert.deepEqual(await check([present, missing]), [missing]);
  // Unreadable files are unavailable, but they are not missing.
  assert.deepEqual(await check([present, missing], { stat: async () => { throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }); } }), []);
  assert.deepEqual(missingGamePaths(games, [{ reason: 'missing' }, { reason: 'unresponsive' }]), [present]);
});

test('batch trash reports partial failures, skips missing files, and keeps failed games for retry', async () => {
  const entries = ['/good', '/missing', '/failed'].map(gamePath => ({ gamePath }));
  const calls = [];
  const result = await trashLibraryGames(entries, async gamePath => {
    calls.push(gamePath);
    if (gamePath === '/failed') throw new Error('Trash failed');
  }, gamePath => { if (gamePath === '/missing') throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); });
  assert.deepEqual(calls, ['/good', '/failed']);
  assert.deepEqual(result.removedPaths, ['/good', '/missing']);
  assert.deepEqual(result.failures, [{ gamePath: '/failed', error: 'Trash failed' }]);
});
