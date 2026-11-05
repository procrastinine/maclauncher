const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Main = require('../src/modules/crossover/main'), D = require('../src/modules/shared/runtime/translator-description');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

test('actual Wine options apply source-declared inspected forms only to new offers and retain saved native selections', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-offer-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const executablePath = put('wine/bin/wine', image({ cpu: X64, fileType: 2 }));
  put('wine/lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64 }));
  fs.mkdirSync(path.join(root, 'support/Frameworks/renderer'), { recursive: true });
  const install = { engineRoot: path.join(root, 'wine'), crossoverRoot: path.join(root, 'wine'), templateRoot: path.join(root, 'support'),
    executablePath, architecture: 'x64', version: 'authored-wine' };
  const create = (id, builtin, policy) => {
    const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22);
    if (builtin) pe.bytes.write('Wine builtin DLL\0', 64);
    if (id === 'custom') pe.bytes[pe.bytes.length - 1] = 1;
    put(id + '/d3d11.dll', pe.bytes);
    return D.describeTranslator(path.join(root, id), { id, engine: 'dxvk', source: { label: 'Authored source', ...(policy ? { optionsRuntimeForms: policy } : {}) } });
  };
  const builtin = create('builtin', true, { crossover: 'builtin' }), native = create('native', false, { crossover: 'builtin' }), custom = create('custom', false);
  const choices = [builtin, native, custom], runtimeManager = { resolveSelection: () => ({ ready: true, install }) };
  for (const runtimeId of ['crossover', 'sikarugir']) {
    const context = { runtimeId, userDataDir: path.join(root, 'profile'), settings: {}, runtimeSettings: {}, logger: { warn() {} } };
    const before = JSON.stringify(context);
    const output = await Main.__test.translatorOptions({ runtimeId }, {}, context, { runtimeManager, managers: [], choices });
    assert.ok(output.translatorD3D11Options.some(row => row.value === builtin.id));
    assert.equal(output.translatorD3D11Options.some(row => row.value === native.id), runtimeId !== 'crossover');
    assert.ok(output.translatorD3D11Options.some(row => row.value === custom.id), 'unknown custom provenance remains available');
    assert.equal(JSON.stringify(context), before);
    const settings = { translatorRenderer: native.id, translatorD3D11: native.id, dxvkHud: 'fps' }, selectedContext = { ...context, runtimeSettings: settings };
    const saved = JSON.stringify(settings), selected = await Main.__test.translatorOptions({ runtimeId }, {}, selectedContext, { runtimeManager, managers: [], choices });
    assert.ok(selected.translatorRendererOptions.some(row => row.value === native.id));
    assert.ok(selected.translatorD3D11Options.some(row => row.value === native.id));
    const plan = await Translators.resolve(install, runtimeId, selectedContext, { managers: [], choices, host: { macOSVersion: '26.0', physicalAppleGPU: false }, executableArchitecture: 'x86_64' });
    assert.equal(plan.components.d3d11.selected.id, native.id); assert.equal(plan.components.d3d11.used.id, native.id); assert.equal(plan.components.d3d11.fallback, false);
    assert.equal(JSON.stringify(settings), saved);
  }
});
