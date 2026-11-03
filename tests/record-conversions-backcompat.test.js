const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {convertLegacyRecord, upgradeLoadedRecord} = require('../src/core/backcompat/record-conversions');
const Policy = require('../src/core/network-access');
const info = {id: 'fixture-record', runtime: {default: 'runner', entries: {runner: {settings: {fields: [
  {key: 'mode', type: 'select', values: [{value: 'current'}]}, {key: 'keep', type: 'boolean'}]}}}}};
const aliases = [{runtimeId: 'runner', key: 'mode', values: [{value: true, replacement: 'current'}, {value: false, replacement: 'other'}]}];
const registry = {getModule: () => info, getLegacyRuntimeSettingAliases: () => aliases};
function directory(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'record-backcompat-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));return root;
}

test('old privacy choices become concrete once, with selected-runtime and explicit-choice precedence', () => {
  const old = {runtimeId: 'runner', runtimeSettings: {runner: {networkIsolation: false, enableProtections: true}}};
  const before = JSON.stringify(old), converted = convertLegacyRecord(old, {registry});
  assert.equal(converted.networkAccess, true);assert.equal(Policy.overrideForEntry(converted), true);
  assert.equal(JSON.stringify(old), before);
  assert.equal(convertLegacyRecord({...old, networkAccess: false}, {registry}).networkAccess, false);
  assert.equal(convertLegacyRecord({...old, networkAccess: null}, {registry}).networkAccess, null);
  assert.equal(convertLegacyRecord({runtimeSettings: {runner: {enableProtections: false}}}, {registry}).networkAccess, true,
    'module default is read through a plain-module registry API');
  const inactive = {runtimeId: 'runner', runtimeSettings: {other: {networkIsolation: false}}};
  assert.deepEqual(convertLegacyRecord(inactive, {registry}), {...inactive, schemaVersion: 2});
});

test('boolean select aliases convert through module declarations while current booleans and fields stay intact', () => {
  const old = {moduleId: info.id, runtimeId: 'runner', runtimeSettings: {runner: {mode: true, keep: true, extra: 'kept'}}};
  const next = convertLegacyRecord(old, {registry});
  assert.deepEqual(next.runtimeSettings.runner, {mode: 'current', keep: true, extra: 'kept'});
  assert.equal(old.runtimeSettings.runner.mode, true);
  assert.equal(convertLegacyRecord(next, {registry}), next);
});

test('current or unknown graphics records have no conversion hooks, writes or filesystem probes', t => {
  const root = directory(t), current = {gameId: 'current', schemaVersion: 2, networkAccess: false,
    runtimeSettings: {runner: {mode: 'current', keep: true}}, effects: {schema: 7, video: 'unknown'}};
  const unavailable = {getModuleInfo() {throw Error('unexpected module lookup');}};
  let writes = 0;
  t.mock.method(fs, 'statSync', () => {throw Error('unexpected file probe');});
  t.mock.method(fs, 'lstatSync', () => {throw Error('unexpected file probe');});
  assert.equal(upgradeLoadedRecord(root, current, () => writes++, {registry: unavailable}), current);
  assert.equal(writes, 0);
});

test('actual failed persistence uses the memoized converted privacy/choice record without retrying', t => {
  const root = directory(t), old = {gameId: 'failed', moduleId: info.id, runtimeId: 'runner', runtimeSettings: {runner: {networkIsolation: true, mode: false}}};
  let writes = 0, lookups = 0;
  const counting = {...registry, getModule() {lookups++;return info;}};
  const write = () => {writes++;throw Error('disk full');}, warnings = [], logger = {warn: (...args) => warnings.push(args.join(' '))};
  const first = upgradeLoadedRecord(root, old, write, {registry: counting, logger});
  assert.equal(first.schemaVersion, 2);assert.equal(first.networkAccess, false);assert.equal(first.runtimeSettings.runner.mode, 'other');
  assert.deepEqual(upgradeLoadedRecord(root, structuredClone(old), write, {registry: counting, logger}), first);
  assert.equal(writes, 1);assert.equal(lookups, 1);assert.match(warnings[0], /remain active in memory/);
  const changed = {...old, runtimeSettings: {runner: {networkIsolation: false}}};
  assert.equal(upgradeLoadedRecord(root, changed, write, {registry: counting, logger}).networkAccess, true);
  assert.equal(writes, 2, 'an actual changed old record receives its own bounded attempt');
});

test('plain Node game-record reads persist old privacy and choices once without touching the write implementation', t => {
  const root = directory(t), Store = require('../src/core/game-store');
  const old = {gameId: 'node-read', moduleId: info.id, runtimeId: 'runner', runtimeSettings: {runner: {networkIsolation: false, mode: true}}};
  Store.writeGameRecord(root, old);
  const file = path.join(root, 'games', old.gameId, 'game.json');
  const loaded = Store.readGameRecord(root, old.gameId, {registry});
  assert.equal(loaded.schemaVersion, 2);assert.equal(loaded.networkAccess, true);assert.equal(loaded.runtimeSettings.runner.mode, 'current');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), loaded);
  const inode = fs.statSync(file).ino;
  assert.deepEqual(Store.readGameRecord(root, old.gameId, {registry}), loaded);
  assert.equal(fs.statSync(file).ino, inode, 'current read performs no rewrite');
});

test('an old plain record advances to the current schema in one persisted read', t => {
  const root = directory(t), Store = require('../src/core/game-store'), old = {gameId: 'plain', schemaVersion: 1, name: 'Kept'};
  assert.equal(Store.CURRENT_RECORD_SCHEMA_VERSION, 2);
  Store.writeGameRecord(root, old);
  const file = path.join(root, 'games', old.gameId, 'game.json');
  const loaded = Store.readGameRecord(root, old.gameId);
  assert.deepEqual(loaded, {...old, schemaVersion: Store.CURRENT_RECORD_SCHEMA_VERSION});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), loaded);
  const inode = fs.statSync(file).ino;
  assert.deepEqual(Store.readGameRecord(root, old.gameId), loaded);assert.equal(fs.statSync(file).ino, inode);
});

test('current and future schema records bypass legacy conversion and are never downgraded', t => {
  const root = directory(t), Store = require('../src/core/game-store');
  const unavailable = {getModuleInfo() {throw Error('unexpected registry conversion');}};
  for (const schemaVersion of [Store.CURRENT_RECORD_SCHEMA_VERSION, 99]) {
    const current = {gameId: 'version-' + schemaVersion, schemaVersion, runtimeSettings: {runner: {mode: true}}, reshade: {enabled: true}};
    const write = () => {throw Error('unexpected schema rewrite');};
    assert.equal(upgradeLoadedRecord(root, current, write, {registry: unavailable, currentVersion: Store.CURRENT_RECORD_SCHEMA_VERSION}), current);
    assert.equal(convertLegacyRecord(current, {registry: unavailable, currentVersion: Store.CURRENT_RECORD_SCHEMA_VERSION}), current);
    Store.writeGameRecord(root, current);
    const file = path.join(root, 'games', current.gameId, 'game.json'), inode = fs.statSync(file).ino;
    assert.deepEqual(Store.readGameRecord(root, current.gameId, {registry: unavailable}), current);
    assert.equal(fs.statSync(file).ino, inode);
  }
});
