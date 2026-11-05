const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Plan = require('../src/modules/shared/runtime/translator-plan');
const Description = require('../src/modules/shared/runtime/translator-description');
const Binary = require('../src/modules/shared/runtime/binary-compatibility');
const Roles = require('../src/modules/shared/runtime/translator-roles');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const { peFixture } = require('./helpers/pe-fixture');

function dll(imports = []) {
  const f = peFixture({ is64: true }), start = 0x800, rva = offset => 0x2000 + offset;
  f.bytes.writeUInt16LE(0x2002, f.peOffset + 22); f.bytes.write('Wine builtin DLL\0', 64);
  if (!imports.length) return f.bytes;
  f.bytes.writeUInt32LE(rva(start), f.directories + 8); f.bytes.writeUInt32LE((imports.length + 1) * 20, f.directories + 12);
  let cursor = start + (imports.length + 1) * 20;
  imports.forEach((name, index) => {
    const at = f.raw + start + index * 20, lookup = cursor, iat = cursor + 16; cursor += 32;
    f.bytes.writeUInt32LE(rva(lookup), at); f.bytes.writeUInt32LE(rva(iat), at + 16);
    f.bytes.writeUInt32LE(rva(cursor), at + 12); f.bytes.write(name + '\0', f.raw + cursor); cursor += Buffer.byteLength(name) + 1;
    for (const offset of [lookup, iat]) f.bytes.writeBigUInt64LE(0x8000000000000001n, f.raw + offset);
  });
  return f.bytes;
}

// CrossOver with its included DXVK and WineD3D, a separate DXVK whose Direct3D
// 8 library is built on its own Direct3D 9 library, and vkd3d-proton.
function ownerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-conflict-roles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const component = (name, engine, modules, extra = {}) => {
    for (const [module, imports] of Object.entries(modules)) {
      const file = path.join(root, name, module + '.dll'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, dll(imports));
    }
    return Description.describeTranslator(path.join(root, name), { id: name, engine, source: 'custom', ...extra });
  };
  const included = (name, engine, modules) => ({ ...component(name, engine, modules), included: true, component: 'd3d-renderer', id: `included:d3d-renderer:${engine}` });
  const crossoverDxvk = included('crossover-dxvk', 'dxvk', { d3d9: [], d3d10core: ['dxgi.dll'], d3d11: ['dxgi.dll'], dxgi: [] });
  const wined3d = included('crossover-wined3d', 'wined3d', { d3d8: [], d3d9: [], d3d10core: ['dxgi.dll'], d3d11: ['dxgi.dll'], dxgi: [] });
  const dxvk = component('dxvk-3.1.1', 'dxvk', { d3d8: ['d3d9.dll'], d3d9: [], d3d10core: ['dxgi.dll'], d3d11: ['dxgi.dll'], dxgi: [] });
  const vkd3d = component('vkd3d-proton', 'vkd3d-proton', { d3d12: [] }, { component: 'd3d12' });
  const all = [crossoverDxvk, wined3d, dxvk, vkd3d];
  const compatibility = Object.fromEntries(all.map(item => [item.id, Binary.compatibility(item,
    { layout: { architecture: 'x86_64' }, modules: {} }, { executableArchitecture: 'x86_64', macOSVersion: '26.0' })]));
  const input = { runtime: 'crossover', included: [crossoverDxvk, wined3d], choices: [dxvk, vkd3d], compatibility };
  const resolve = selections => Plan.resolveApiRoles(Plan.resolvePlan({ ...input, selections: { 'd3d-renderer': crossoverDxvk.id } }), { ...input, selections });
  const owner = { d3d8: dxvk.id, d3d9: crossoverDxvk.id, d3d10: crossoverDxvk.id, d3d11: crossoverDxvk.id, d3d12: vkd3d.id };
  return { crossoverDxvk, wined3d, dxvk, vkd3d, input, resolve, owner };
}

const settingsFor = selections => Object.fromEntries(Roles.DIRECT3D_ROLES.filter(role => selections[role.id]).map(role => [role.settingsKey, selections[role.id]]));
const selectionsFor = settings => Object.fromEntries(Roles.DIRECT3D_ROLES.filter(role => settings[role.settingsKey]).map(role => [role.id, settings[role.settingsKey]]));

test('a Direct3D 8 choice that needs another Direct3D 9 library names that API and shows the WineD3D renderer that loads', t => {
  const f = ownerFixture(t), plan = f.resolve(f.owner);
  assert.equal(plan.components.d3d8.fallback, true); assert.equal(plan.components.d3d8.reasonCode, 'shared-physical-binding');
  assert.deepEqual(plan.components.d3d8.conflictRoles, ['Direct3D 9']);
  for (const role of ['d3d9', 'd3d10', 'd3d11']) assert.equal(plan.components[role].used.id, f.crossoverDxvk.id);
  assert.equal(plan.components.d3d12.used.id, f.vkd3d.id);
  const rows = Object.fromEntries(Translators.inspectorRows(plan).map(row => [row.component, row]));
  assert.equal(rows.d3d8.selected, Description.label(f.dxvk));
  assert.equal(rows.d3d8.used, Description.label(f.wined3d), 'CrossOver renders unplaced Direct3D APIs with WineD3D once a library is placed');
  assert.equal(rows.d3d8.reason, 'This choice needs its own copy of a library that the Direct3D 9 choice provides, and a game can load only one copy.');
  assert.equal(rows.d3d8.reason, Plan.fallbackNotice('shared-physical-binding', { roles: ['Direct3D 9'] }));
  assert.equal(rows.d3d9.used, Description.label(f.crossoverDxvk)); assert.equal(rows.d3d9.reason, null);
});

test('each Direct3D option resolves the conflict it would leave, so no saved choice stays silently held back', t => {
  const f = ownerFixture(t), plan = f.resolve(f.owner), options = Plan.apiOptions(plan, { ...f.input, selections: f.owner });
  const option = (key, value) => options[key].find(row => row.value === value);
  const apply = row => {
    const settings = { ...settingsFor(f.owner), ...row.runtimeSettingsPatch }, selections = selectionsFor(settings);
    const next = f.resolve(selections);
    return { selections, next, held: Roles.DIRECT3D_ROLES.filter(role => next.components[role.id].fallback).map(role => role.id) };
  };
  // Keeping CrossOver's DXVK for Direct3D 9 resets the Direct3D 8 choice that needs another copy.
  const crossover = option('translatorD3D9Options', f.crossoverDxvk.id);
  assert.deepEqual(crossover.affectedRoles, ['d3d8', 'd3d9']);
  assert.equal(crossover.runtimeSettingsPatch.translatorD3D8, Plan.AUTOMATIC);
  assert.deepEqual(apply(crossover).held, []);
  // DXVK 3.1.1 for Direct3D 9 supplies the library its Direct3D 8 choice needs.
  const separate = option('translatorD3D9Options', f.dxvk.id);
  assert.deepEqual(separate.affectedRoles, ['d3d9']);
  const applied = apply(separate);
  assert.deepEqual(applied.held, []); assert.equal(applied.next.components.d3d8.used.id, f.dxvk.id); assert.equal(applied.next.components.d3d9.used.id, f.dxvk.id);
  // The held-back Direct3D 8 option names the API it shares a library with and links it.
  const direct3D8 = option('translatorD3D8Options', f.dxvk.id);
  assert.equal(direct3D8.heldBack, true); assert.match(direct3D8.notice, /Direct3D 9 choice provides/);
  assert.deepEqual(direct3D8.runtimeSettingsPatch, { translatorD3D8: f.dxvk.id, translatorD3D9: f.dxvk.id });
  assert.deepEqual(apply(direct3D8).held, []);
});

test('the inspector uses rows recorded at Play only while the translator settings and Wine installation are unchanged', async t => {
  const f = ownerFixture(t), Main = require('../src/modules/crossover/main'), Providers = require('../src/modules/shared/runtime/providers');
  const manager = Main.runtimeManagers.find(item => item.id === 'crossover'), install = { executablePath: '/fixture/CrossOver/bin/wine', versionLabel: '26.3' };
  t.mock.method(manager, 'resolveSelection', () => ({ ready: true, version: '26.3', install }));
  let inventories = 0;
  t.mock.method(Translators, 'optionsInventory', async () => { inventories++; return null; });
  t.mock.method(Translators, 'optionsPlan', () => f.resolve(f.owner));
  const composed = Providers.composeRuntimeProviders({ manifest: { id: 'fixture-engine', runtime: { supported: [], entries: {} } } }, Main.runtimeProviders);
  const runtimeSettings = settingsFor(f.owner), recorded = [{ id: 'translatorD3D8', component: 'd3d8', label: 'Direct3D 8', selected: 'Recorded', used: 'Recorded', fallback: false }];
  const status = entry => composed.actions.runtimeStatus(entry, {}, { runtimeId: 'crossover', runtimeSettings, settings: {}, userDataDir: os.tmpdir() });
  const entry = inputs => ({ gamePath: '/fixture/game', runtimeId: 'crossover', runtimeData: { crossover: { translatorRows: recorded, translatorPlanInputs: inputs } } });
  const unchanged = await status(entry(Translators.planInputs(runtimeSettings, install)));
  assert.deepEqual(unchanged.translatorRows.map(row => row.used), ['Recorded']); assert.equal(inventories, 0);
  const changed = await status(entry(Translators.planInputs({ ...runtimeSettings, translatorD3D9: f.dxvk.id }, install)));
  assert.equal(changed.translatorRows.find(row => row.component === 'd3d8').used, Description.label(f.wined3d)); assert.ok(inventories > 0);
  inventories = 0;
  const older = await status(entry(undefined));
  assert.equal(older.translatorRows.find(row => row.component === 'd3d8').used, Description.label(f.wined3d)); assert.ok(inventories > 0);
  assert.equal(Translators.samePlanInputs(Translators.planInputs(runtimeSettings, install), runtimeSettings, { ...install, executablePath: '/other/wine' }), false);
});
