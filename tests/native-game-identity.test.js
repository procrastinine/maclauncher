const test = require('node:test'), assert = require('node:assert/strict');
const Identity = require('../src/modules/shared/runtime/game-identity');
test('native identity preserves the prepared child environment without mutating its owner', () => {
  const base = Object.freeze({ PATH: '/runtime/bin', DYLD_INSERT_LIBRARIES: '/effects.dylib:/steam.dylib', DOTNET_ROOT: '/dotnet', RESHADE_SESSION: 'session', MACLAUNCHER_GAME_NAME: 'old' });
  const result = Identity.environment({ name: 'Game title', iconPath: '/existing/icon.png' }, base);
  assert.deepEqual(result, { ...base, MACLAUNCHER_GAME_NAME: 'Game title', MACLAUNCHER_GAME_ICON: '/existing/icon.png' });
  assert.equal(base.MACLAUNCHER_GAME_NAME, 'old');
  assert.notEqual(result, base);
});
test('native identity defaults to inherited process values and clears absent optional identity', () => {
  const result = Identity.environment({});
  assert.equal(result.PATH, process.env.PATH);
  assert.equal(result.MACLAUNCHER_GAME_NAME, ''); assert.equal(result.MACLAUNCHER_GAME_ICON, '');
  assert.deepEqual(Identity.environment(null, { A: 'retained' }), { A: 'retained', MACLAUNCHER_GAME_NAME: '', MACLAUNCHER_GAME_ICON: '' });
});
