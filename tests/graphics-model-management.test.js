const test = require('node:test');
const assert = require('node:assert/strict');
const {runRuntimeManagerAction} = require('../src/core/runtime-manager-service');
const Lossless = require('../src/modules/shared/reshade/models');
const Neural = require('../src/modules/shared/reshade/neural/models');
const Managers = [require('../src/modules/shared/reshade/runtime/models-manager'), require('../src/modules/shared/reshade/runtime/neural-models-manager')];

test('model import never turns an automatic selection into a saved default', async t => {
  const version = 'sha256-' + 'a'.repeat(64);
  for (const [index, manager] of Managers.entries()) {
    t.mock.method(index ? Neural : Lossless, 'importModel', async () => ({version}));
    let writes = 0;
    const result = await runRuntimeManagerAction({manager, action: 'import', payload: {runtimePath: '/original/model'},
      readSettings: () => ({}), saveSettings: () => { writes++; }});
    assert.equal(result.version, version);
    assert.equal(writes, 0, manager.id + ' must leave automatic preferences unstored');
  }
});

test('model imports preserve explicit installed and operation defaults', async t => {
  const prior = 'sha256-' + 'b'.repeat(64), next = 'sha256-' + 'c'.repeat(64);
  for (const [index, manager] of Managers.entries()) {
    t.mock.method(index ? Neural : Lossless, 'importModel', async () => ({version: next}));
    const settings = index ? {defaultVersion: prior, defaultVersions: {'mlx-dlss': prior}} : {defaultVersion: prior};
    const original = structuredClone(settings);let writes = 0;
    await runRuntimeManagerAction({manager, action: 'import', payload: {runtimePath: '/original/model'},
      readSettings: () => settings, saveSettings: () => { writes++; }});
    assert.equal(writes, 0);assert.deepEqual(settings, original);
    assert.equal(manager.applySettingsUpdate('setDefault', {version: next}, settings).defaultVersion, next);
  }
});
