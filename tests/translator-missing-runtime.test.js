const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Main = require('../src/modules/crossover/main');
const D = require('../src/modules/shared/runtime/translator-description');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const { peFixture } = require('./helpers/pe-fixture');

test('actual translator action lists managed choices with one notice before its selected Wine runtime is installed', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-missing-runtime-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const component = path.join(root, 'managed'); fs.mkdirSync(component);
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22);
  fs.writeFileSync(path.join(component, 'd3d11.dll'), pe.bytes);
  const description = D.describeTranslator(component, { engine: 'dxvk', source: 'Authored installed source', version: 'release' });
  const install = { version: 'release', architecture: 'x64', translatorRoot: component, installDir: component, translator: description };
  const manager = { id: 'fixture-translator', translatorEngine: 'dxvk', getState: () => ({ installed: [install] }),
    resolveSelection: () => ({ ready: true, version: install.version, install }) };
  t.mock.method(Translators, 'resolve', () => { throw Error('No Wine/native compatibility traversal is needed to list installed choices.'); });
  for (const runtimeId of ['crossover', 'sikarugir']) {
    let preparations = 0;
    const runtimeManager = { resolveSelection: () => ({ ready: false, version: 'uninstalled-choice', reason: 'Selected runtime is not installed' }),
      ...(runtimeId === 'sikarugir' ? { installRuntime: () => { preparations++; throw Error('Reading choices must not install Wine.'); } } : {}) };
    const context = { runtimeId, userDataDir: path.join(root, 'profile'), settings: {}, runtimeSettings: { dxvkHud: 'fps' } };
    const before = JSON.stringify(context), result = await Main.__test.translatorOptions({ runtimeId }, {}, context,
      { runtimeManager, managers: [manager] });
    assert.ok(result.translatorRendererOptions.some(option => option.value === 'fixture-translator:release'));
    assert.ok(result.translatorD3D11Options.some(option => option.value === 'fixture-translator:release'));
    assert.ok(result.translatorRoles.some(role => role.id === 'd3d11'));
    assert.match(result.notice, /Included choices.*runtime.*installed/);
    assert.equal(result.notice.includes('Play installs'), runtimeId === 'sikarugir');
    assert.equal(preparations, 0); assert.equal(JSON.stringify(context), before);
  }
});
