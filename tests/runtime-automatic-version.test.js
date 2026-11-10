const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const Modules = require('../src/modules/registry');
const { createLauncher } = require('../src/core/launcher');
const GameStore = require('../src/core/game-store');

// The inspector's Automatic entry runs beside Play and installs, so it must
// read only local state: no network, game use, coordinator or runtime lock.
test('the Automatic version of every managed runtime is offline, takes no game use or coordinator call and keeps the game\'s own choice', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const network = [], coordination = [];
  for (const [object, key] of [[globalThis, 'fetch'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'], [tls, 'connect']]) {
    const original = object[key];
    object[key] = () => { network.push(key); throw new Error(`Network access: ${key}`); };
    t.after(() => { object[key] = original; });
  }
  const runtimeCoordinator = new Proxy({}, { get: (_, key) => key === 'then' ? undefined
    : (...args) => { coordination.push(String(key)); throw new Error(`Coordinator call: ${String(key)}`); } });
  const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const launcher = createLauncher({ userDataDir: root, registry: Modules, runtimeCoordinator, logger: quiet });
  let checked = 0;
  for (const moduleId of Modules.listModuleIds?.() || Modules.listModules().map(mod => mod.id)) {
    const info = Modules.getModuleInfo(moduleId);
    for (const runtimeId of Object.keys(info?.runtime?.manager || {})) {
      // The lookup works on a copy: the game's own version choice is neither
      // cleared in memory nor written to its stored record.
      const gameId = `automatic-${moduleId}-${runtimeId}`.replace(/[^0-9A-Za-z_-]/g, '_');
      const entry = { gameId, gamePath: path.join(root, 'games', moduleId), moduleId, runtimeId,
        moduleData: {}, runtimeData: { [runtimeId]: { version: '1.0', variant: 'chosen' } } };
      GameStore.writeGameRecord(root, entry);
      const before = structuredClone(entry), stored = JSON.stringify(GameStore.readGameRecord(root, gameId));
      await launcher.runAction(entry, 'runtimeAutomaticVersion', {}, { settings: {} }).catch(() => null);
      assert.deepEqual(entry, before, `${moduleId}/${runtimeId} entry`);
      assert.equal(JSON.stringify(GameStore.readGameRecord(root, gameId)), stored, `${moduleId}/${runtimeId} record`);
      checked++;
    }
  }
  assert.ok(checked >= 20, `checked ${checked} managed runtimes`);
  assert.deepEqual(network, []);
  assert.deepEqual(coordination, []);
});
