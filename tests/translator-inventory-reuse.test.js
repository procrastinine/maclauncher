const test = require('node:test'), assert = require('node:assert/strict');
const Revision = require('../src/core/runtime-inventory-revision');
const Translators = require('../src/modules/shared/runtime/wine-translators');

function counted() {
  const calls = { getState: 0, resolveSelection: 0 };
  const manager = { id: 'translator-fixture', translatorEngine: 'dxvk',
    getState() { calls.getState++; return { installed: [{ version: '1.0', ready: true }] }; },
    resolveSelection(_entry, _settings, _data, { version }) {
      calls.resolveSelection++;
      return { install: { version, installDir: '/fixture/dxvk', translator: { engine: 'dxvk', component: 'd3d-renderer', version: '1.0', files: [], apis: [] } } };
    } };
  return { calls, managers: [manager] };
}

test('display inventories are read once per lane revision, never outside a lane and never for Play', async () => {
  const { calls, managers } = counted(), context = { userDataDir: '/fixture/profile', settings: { runtimes: {} }, runtimeSettings: {}, logger: { warn() {} } };
  const read = (dependencies = {}) => Translators.optionsInventory(null, 'crossover', context, { managers, ...dependencies });
  await read({ reuse: true }); await read({ reuse: true });
  assert.deepEqual(calls, { getState: 2, resolveSelection: 2 }, 'outside a backend lane nothing is reused');
  Revision.activate();
  const first = await read({ reuse: true });
  first.choices[0].mutated = true;
  const [second, third] = await Promise.all([read({ reuse: true }), read({ reuse: true })]);
  assert.deepEqual(calls, { getState: 3, resolveSelection: 3 }, 'one read serves the repeated and concurrent display requests');
  assert.equal(second.choices[0].mutated, undefined, 'each caller receives its own copy');
  assert.equal(third.choices[0].id, 'translator-fixture:1.0');
  await read();
  assert.equal(calls.getState, 4, 'Play and other callers without reuse read again');
  await Translators.optionsInventory(null, 'crossover', { ...context, settings: { runtimes: { 'translator-fixture': { defaultVersion: '1.0' } } } }, { managers, reuse: true });
  assert.equal(calls.getState, 5, 'changed runtime settings read again');
  Revision.advance();
  await read({ reuse: true }); await read({ reuse: true });
  assert.equal(calls.getState, 6, 'a runtime change in any lane starts a new revision');
});

test('runtime states report an inventory change only when installed or included rows change', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-change-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let installed = [{ version: '1.0', ready: true }];
  const manager = { id: 'translator-fixture', label: 'Fixture', getState: () => ({ installed, catalog: { versions: ['1.0', '2.0'] } }) };
  const registry = { listModuleIds: () => [], listModules: () => [], getModule: () => null, getModuleInfo: () => null, listSharedRuntimeManagers: () => [manager], getRuntimeManagerUi: () => null };
  const events = [];
  const ops = require('../src/core/backend-operations').createBackendOperations({ userDataDir: root, registry,
    emit: (event, payload) => events.push([event, payload?.managerId || payload?.id]) });
  t.after(() => ops.beginShutdown());
  const changes = () => events.filter(([event]) => event === 'runtimeInventoryChanged').length;
  await ops.runtimeStates({}, [manager.id]); await ops.runtimeStates({}, [manager.id]);
  assert.equal(changes(), 1, 'the first state of a lane is a change; an identical one is not');
  installed = [...installed, { version: '2.0', ready: true }];
  await ops.runtimeStates({}, [manager.id]);
  assert.equal(changes(), 2);
  assert.equal(events.filter(([event]) => event === 'runtimeState').length, 3, 'every state still reaches the windows');
});

test('translator choices whose same-named libraries differ in size are distinct without reading their bytes', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const Plan = require('../src/modules/shared/runtime/translator-plan');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'choice-sizes-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const choice = (id, bytes) => {
    const file = path.join(root, id, 'd3d11.dll'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, bytes);
    return { id, engine: 'dxvk', component: 'd3d-renderer', form: 'builtin', version: id, root: path.dirname(file), apis: ['Direct3D 11'],
      files: [{ path: file, format: 'pe', machine: 0x8664, form: 'builtin' }] };
  };
  const choices = [choice('older', 'a'), choice('newer', 'bb'), choice('copy', 'bb')], opened = [], open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => { if (String(file).startsWith(root)) opened.push(path.basename(path.dirname(String(file)))); return open(file, ...args); });
  const rows = Plan.options({ component: 'd3d-renderer', choices });
  assert.deepEqual(rows.map(row => row.value), ['automatic', 'older', 'newer']);
  assert.deepEqual(opened.sort(), ['copy', 'newer'], 'only the same-sized pair is read');
});
