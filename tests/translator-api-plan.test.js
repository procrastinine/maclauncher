const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Plan = require('../src/modules/shared/runtime/translator-plan');
const Description = require('../src/modules/shared/runtime/translator-description');
const Binary = require('../src/modules/shared/runtime/binary-compatibility');
const Roles = require('../src/modules/shared/runtime/translator-roles');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-api-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, put(relative, bytes) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  } };
}
function dll(imports = [], { is64 = true, builtin = true } = {}) {
  const f = peFixture({ is64 }), start = 0x800, rva = offset => 0x2000 + offset;
  f.bytes.writeUInt16LE(0x2002, f.peOffset + 22); if (builtin) f.bytes.write('Wine builtin DLL\0', 64);
  if (!imports.length) return f.bytes;
  f.bytes.writeUInt32LE(rva(start), f.directories + 8); f.bytes.writeUInt32LE((imports.length + 1) * 20, f.directories + 12);
  let cursor = start + (imports.length + 1) * 20;
  imports.forEach((name, index) => {
    const at = f.raw + start + index * 20, lookup = cursor, iat = cursor + 16; cursor += 32;
    f.bytes.writeUInt32LE(rva(lookup), at); f.bytes.writeUInt32LE(rva(iat), at + 16);
    f.bytes.writeUInt32LE(rva(cursor), at + 12); f.bytes.write(name + '\0', f.raw + cursor); cursor += Buffer.byteLength(name) + 1;
    for (const offset of [lookup, iat]) {
      if (is64) f.bytes.writeBigUInt64LE(0x8000000000000001n, f.raw + offset);
      else f.bytes.writeUInt32LE(0x80000001, f.raw + offset);
    }
  });
  return f.bytes;
}
function component(f, name, engine, modules, unix = [], extra = {}) {
  for (const [module, imports] of Object.entries(modules)) f.put(`${name}/${module}.dll`, dll(imports));
  for (const module of unix) f.put(`${name}/${module}.so`, image({ cpu: X64 }));
  return Description.describeTranslator(path.join(f.root, name), { id: name, engine, source: 'custom', ...extra });
}
function legacy(base, runtime = 'sikarugir') {
  return Plan.resolvePlan({ runtime, selections: base ? { 'd3d-renderer': base.id } : {}, included: base ? [base] : [] });
}
function compatibility(descriptions) {
  return Object.fromEntries(descriptions.map(description => [description.id, Binary.compatibility(description,
    { layout: { architecture: 'x86_64' }, modules: {} }, { executableArchitecture: 'x86_64', macOSVersion: '26.0' })]));
}
const names = files => files.map(file => path.basename(file.path)).sort();

test('Sikarugir WineD3D 10 and DXVK 3.1.1 retain the real D3D8 dependency when splitting D3D9', async t => {
  const f = fixture(t);
  const describe = (name, engine, version, modules) => {
    for (const [module, imports] of Object.entries(modules)) f.put(`${name}/${module}.dll`, dll(imports, { is64: false, builtin: engine === 'wined3d' }));
    return Description.describeTranslator(path.join(f.root, name), { id: name, engine, component: 'd3d-renderer', version,
      source: { label: engine === 'wined3d' ? 'Sikarugir Template 1.0.24' : 'dxvk' } });
  };
  // Authored PE imports reproduce the selected installed files' API edges.
  const wine = { ...describe('wine10', 'wined3d', '10.0', { d3d8: ['wined3d.dll'], d3d9: ['wined3d.dll'],
    d3d10: ['d3d10core.dll', 'd3dcompiler_39.dll', 'dxgi.dll', 'wined3d.dll'], d3d10core: ['dxgi.dll'],
    d3d11: ['dxgi.dll', 'wined3d.dll'], dxgi: ['wined3d.dll'] }), included: true };
  const dxvk = describe('dxvk311', 'dxvk', '3.1.1', { d3d8: ['d3d9.dll'], d3d9: [], d3d10core: ['d3d11.dll'], d3d11: ['dxgi.dll'], dxgi: [] });
  const input = { runtime: 'sikarugir', included: [wine], choices: [dxvk] };
  const resolve = selections => Plan.resolveApiRoles(Plan.resolvePlan({ ...input, selections: { 'd3d-renderer': dxvk.id } }), { ...input, selections });
  const refused = resolve({ d3d9: wine.id });
  assert.equal(refused.components.d3d9.reason, 'Shared physical binding conflict: pe:332:d3d9.dll');
  assert.deepEqual(refused.components.d3d9.conflictRoles, ['Direct3D 8']);
  assert.deepEqual(names(Plan.filesForRole(dxvk, Roles.ROLES.find(role => role.id === 'd3d8'))), ['d3d8.dll', 'd3d9.dll']);
  assert.deepEqual(names(Plan.filesForRole(wine, Roles.ROLES.find(role => role.id === 'd3d9'))), ['d3d9.dll']);
  const plan = resolve({ d3d8: wine.id, d3d9: wine.id });
  assert.equal(plan.apiMode, true);
  for (const role of ['d3d8', 'd3d9', 'd3d10', 'd3d11']) {
    assert.equal(plan.components[role].used.engine, ['d3d8', 'd3d9'].includes(role) ? 'wined3d' : 'dxvk');
    assert.equal(plan.components[role].fallback, false);
  }
  assert.equal(plan.placements.filter(row => path.basename(row.file.path) === 'd3d9.dll').length, 1);
  assert.equal(plan.placements.find(row => path.basename(row.file.path) === 'd3d9.dll').file.form, 'builtin');
  for (const name of ['d3d10core.dll', 'd3d11.dll', 'dxgi.dll']) assert.equal(plan.placements.find(row => path.basename(row.file.path) === name).description.id, dxvk.id);
  const view = await require('../src/modules/shared/runtime/translator-files').prepareTranslatorFiles(plan,
    { userDataDir: path.join(f.root, 'profile'), layout: { architecture: 'x86_64', unixName: 'x86_64-unix' } });
  assert.ok(view.dllOverrides.includes('d3d9=b'));
  assert.ok(view.dllOverrides.includes('d3d11=n,b'));
  assert.ok(view.dllOverrides.includes('dxgi=n,b'));
  assert.equal(view.native.some(file => file.name === 'd3d9.dll'), false);
});

test('per-API legacy projection leaves saved choice and global automatic behavior unchanged', t => {
  const f = fixture(t), dxmt = component(f, 'included-dxmt', 'dxmt', { d3d11: ['winemetal.dll'], winemetal: [] }, ['winemetal']);
  const plan = legacy(dxmt, 'crossover'), original = structuredClone(plan), saved = { 'd3d-renderer': dxmt.id };
  Plan.resolveApiRoles(plan, { selections: {}, included: [dxmt], compatibility: compatibility([dxmt]) });
  assert.deepEqual(plan.components['d3d-renderer'], original.components['d3d-renderer']);
  assert.deepEqual(saved, { 'd3d-renderer': dxmt.id }); assert.notEqual(plan.apiMode, true);
  assert.equal(plan.components.d3d11.used.id, dxmt.id); assert.equal(plan.components.d3d8.used, null);
  const auto = legacy(null, 'crossover');
  Plan.resolveApiRoles(auto, { selections: { d3d11: dxmt.id }, included: [dxmt], compatibility: compatibility([dxmt]) });
  assert.equal(auto.components.d3d11.selected.id, dxmt.id); assert.equal(auto.components.d3d11.used, null);
  assert.equal(auto.components.d3d11.fallback, true); assert.match(auto.components.d3d11.reason, /global backend|automatic composition/);
  assert.equal(auto.apiMode, false); assert.deepEqual(auto.placements, []);
});

test('per-API D3D9 DXVK and D3D11 DXMT separate unused DXGI and Unix thunk companions using actual imports', t => {
  const f = fixture(t), dxvk = component(f, 'dxvk', 'dxvk', { d3d9: [], d3d11: ['dxgi.dll', 'winemetal.dll'], dxgi: [], winemetal: [] }, ['winemetal']);
  const dxmt = component(f, 'dxmt', 'dxmt', { d3d11: ['dxgi.dll', 'winemetal.dll'], dxgi: [], winemetal: [] }, ['winemetal']);
  assert.equal(dxvk.files.find(file => file.path.endsWith('d3d9.dll')).importsComplete, true);
  assert.deepEqual(names(Plan.filesForRole(dxvk, Roles.ROLES.find(role => role.id === 'd3d9'))), ['d3d9.dll']);
  assert.deepEqual(names(Plan.filesForRole(dxmt, Roles.ROLES.find(role => role.id === 'd3d11'))), ['d3d11.dll', 'dxgi.dll', 'winemetal.dll', 'winemetal.so']);
  const plan = legacy(dxmt, 'crossover');
  Plan.resolveApiRoles(plan, { selections: { d3d9: dxvk.id }, choices: [dxvk], included: [dxmt], compatibility: compatibility([dxvk, dxmt]) });
  assert.equal(plan.apiMode, true); assert.equal(plan.components.d3d9.used.id, dxvk.id); assert.equal(plan.components.d3d11.used.id, dxmt.id);
  assert.equal(plan.components.d3d9.fallback, false);
  assert.equal(plan.placements.filter(item => path.basename(item.file.path) === 'dxgi.dll').length, 1);
  assert.equal(plan.placements.find(item => path.basename(item.file.path) === 'dxgi.dll').description.id, dxmt.id);
  assert.equal(plan.placements.find(item => path.basename(item.file.path) === 'winemetal.so').description.id, dxmt.id);
});

test('per-API shared DXGI conflicts retain selected intent and a coherent supplied composition without overwrite', t => {
  const f = fixture(t), base = component(f, 'base-dxvk', 'dxvk', { d3d11: ['dxgi.dll'], dxgi: [] });
  const metal = component(f, 'metal', 'd3dmetal', { d3d12: ['dxgi.dll'], dxgi: [] }, [], { component: 'd3d12' });
  const plan = legacy(base);
  Plan.resolveApiRoles(plan, { selections: { d3d11: base.id, d3d12: metal.id }, choices: [metal], included: [base], compatibility: compatibility([base, metal]) });
  assert.equal(plan.components.d3d12.selected.id, metal.id); assert.equal(plan.components.d3d12.used, null);
  assert.equal(plan.components.d3d12.fallback, true); assert.match(plan.components.d3d12.reason, /physical binding conflict.*dxgi/);
  assert.equal(plan.components.d3d11.used.id, base.id); assert.equal(plan.apiMode, false); assert.deepEqual(plan.placements, []);
});

test('per-API actual missing files use same-engine included fallback and missing opaque choices keep their reason', t => {
  const f = fixture(t), supplied = component(f, 'included', 'dxmt', { d3d11: [] }), selected = component(f, 'selected', 'dxmt', { d3d11: [] });
  fs.unlinkSync(selected.files[0].path);
  const actual = compatibility([supplied, selected]); assert.equal(actual[selected.id].compatible, false);
  const plan = legacy(supplied);
  Plan.resolveApiRoles(plan, { selections: { d3d11: selected.id }, choices: [selected], included: [supplied], compatibility: actual });
  assert.equal(plan.components.d3d11.selected.id, selected.id); assert.equal(plan.components.d3d11.used.id, supplied.id);
  assert.equal(plan.components.d3d11.fallback, true); assert.match(plan.components.d3d11.reason, /missing/);
  const missing = legacy(supplied);
  Plan.resolveApiRoles(missing, { selections: { d3d11: 'unavailable:opaque' }, included: [supplied], automatic: { d3d11: supplied }, compatibility: actual });
  assert.equal(missing.components.d3d11.value, 'unavailable:opaque'); assert.equal(missing.components.d3d11.selected, null);
  assert.equal(missing.components.d3d11.used.id, supplied.id); assert.equal(missing.components.d3d11.fallback, true); assert.match(missing.components.d3d11.reason, /unavailable/);
});

test('per-API inheritance and option metadata preserve ids and advertise atomic patches limited to affected role keys', t => {
  const f = fixture(t), base = component(f, 'base', 'dxmt', { d3d10core: ['dxgi.dll'], d3d11: ['dxgi.dll'], dxgi: [] });
  const inherited = component(f, 'wrapper-nine', 'dxvk', { d3d9: [] });
  const alternative = component(f, 'alternative', 'dxvk', { d3d10core: ['dxgi.dll'], d3d11: ['dxgi.dll'], dxgi: [] });
  const plan = legacy(base);
  Plan.resolveApiRoles(plan, { selections: { d3d9: Plan.INHERIT }, included: [base], choices: [inherited, alternative], environment: { d3d9: inherited }, compatibility: compatibility([base, inherited, alternative]) });
  assert.equal(plan.components.d3d9.inherited, true); assert.equal(plan.components.d3d9.selected.id, inherited.id); assert.equal(plan.components.d3d9.used.id, inherited.id);
  const options = Plan.apiOptions(plan, { included: [base], choices: [inherited, alternative], environment: { label: 'Wrapper setting' }, selections: { d3d9: Plan.INHERIT } });
  assert.deepEqual(options.translatorRoles.map(role => role.id), Roles.ROLES.map(role => role.id));
  assert.ok(options.translatorRoles.every(role => role.optionsKey && role.settingsKey));
  assert.ok(Array.isArray(options.translatorGroups));
  assert.equal(options.translatorD3D9Options[0].value, Plan.INHERIT);
  const choice = options.translatorD3D11Options.find(option => option.value === alternative.id);
  assert.equal(choice.value, alternative.id); assert.ok(choice.groupId); assert.ok(choice.affectedRoles.includes('d3d11'));
  assert.equal(choice.runtimeSettingsPatch.translatorD3D11, choice.value);
  assert.equal(choice.runtimeSettingsPatch.translatorD3D10, choice.value);
  const affectedKeys = new Set(choice.affectedRoles.map(id => Roles.ROLES.find(role => role.id === id).settingsKey));
  assert.ok(Object.keys(choice.runtimeSettingsPatch).every(key => affectedKeys.has(key)));
  assert.equal(Object.hasOwn(choice.runtimeSettingsPatch, 'translatorRenderer'), false);
  const saved = { translatorD3D9: Plan.INHERIT, unrelated: 'keep me' }, merged = { ...saved, ...choice.runtimeSettingsPatch };
  const selections = Object.fromEntries(Roles.DIRECT3D_ROLES.filter(role => merged[role.settingsKey]).map(role => [role.id, merged[role.settingsKey]]));
  const applied = legacy(base);
  Plan.resolveApiRoles(applied, { selections, included: [base], choices: [inherited, alternative], environment: { d3d9: inherited }, compatibility: compatibility([base, inherited, alternative]) });
  assert.equal(applied.components.d3d10.used.id, alternative.id); assert.equal(applied.components.d3d11.used.id, alternative.id);
  assert.equal(applied.components.d3d9.used.id, inherited.id); assert.equal(applied.components.d3d9.inherited, true);
  assert.equal(merged.unrelated, 'keep me'); assert.deepEqual(saved, { translatorD3D9: Plan.INHERIT, unrelated: 'keep me' });
});

test('per-API unknown scope stays accessible and real historical projects coexist with modern API coverage', t => {
  const f = fixture(t), base = component(f, 'base', 'dxmt', { d3d11: [] });
  const unknown = component(f, 'unknown', 'unfamiliar-project', {}, ['opaque']);
  const historical = component(f, 'historical', 'd8vk', { d3d8: [] }, [], { source: { componentLabel: 'D8VK', label: 'historical source' } });
  const modern = component(f, 'modern', 'dxvk', { d3d8: [], d3d9: [] });
  const plan = legacy(base);
  Plan.resolveApiRoles(plan, { selections: { d3d8: unknown.id }, choices: [unknown, historical, modern], included: [base], compatibility: compatibility([base, unknown, historical, modern]) });
  assert.equal(plan.components.d3d8.used.id, unknown.id); assert.equal(plan.components.d3d8.fallback, false); assert.equal(plan.components.d3d8.scopeKnown, false);
  const options = Plan.apiOptions(plan, { choices: [unknown, historical, modern], included: [base], selections: { d3d8: unknown.id } });
  assert.equal(options.translatorD3D8Options.find(option => option.value === unknown.id).scopeKnown, false);
  assert.ok(options.translatorD3D8Options.some(option => option.value === historical.id));
  assert.ok(options.translatorD3D8Options.some(option => option.value === modern.id));
  assert.equal(options.translatorD3D9Options.some(option => option.value === historical.id), false);
  assert.ok(options.translatorD3D9Options.some(option => option.value === modern.id)); assert.equal(historical.engine, 'd8vk');
});

test('CrossOver automatic rows follow the DXGI provider required by a selected vkd3d-proton', t => {
  const f = fixture(t), dxvk = component(f, 'complete-dxvk', 'dxvk', {
    d3d8: [], d3d9: [], d3d10core: ['dxgi.dll'], d3d11: ['dxgi.dll'], dxgi: []
  });
  const vkd3d = component(f, 'complete-vkd3d', 'vkd3d-proton', { d3d12: [] }, [], { component: 'd3d12' });
  const options = { choices: [dxvk, vkd3d], compatibility: compatibility([dxvk, vkd3d]) };
  const complete = legacy(null, 'crossover');
  Plan.resolveApiRoles(complete, { ...options, selections: Object.fromEntries(Roles.DIRECT3D_ROLES.map(role =>
    [role.id, role.id === 'd3d12' ? vkd3d.id : dxvk.id])) });
  assert.equal(complete.apiMode, true); assert.equal(complete.components['d3d-renderer'].used, null);
  for (const role of Roles.DIRECT3D_ROLES) {
    assert.equal(complete.components[role.id].used.id, role.id === 'd3d12' ? vkd3d.id : dxvk.id);
    assert.equal(complete.components[role.id].fallback, false);
  }
  assert.deepEqual(names(complete.placements.map(placement => placement.file)), ['d3d10core.dll', 'd3d11.dll', 'd3d12.dll', 'd3d8.dll', 'd3d9.dll', 'dxgi.dll']);
  const activeOptions = Plan.apiOptions(complete, options);
  assert.equal(activeOptions.translatorD3D9Options.find(option => option.value === dxvk.id).reason, undefined);
  const partial = legacy(null, 'crossover');
  Plan.resolveApiRoles(partial, { ...options, selections: { d3d9: dxvk.id, d3d12: vkd3d.id } });
  assert.equal(partial.apiMode, true);
  assert.equal(partial.components.d3d9.selected.id, dxvk.id); assert.equal(partial.components.d3d12.selected.id, vkd3d.id);
  assert.ok(Roles.DIRECT3D_ROLES.every(role => partial.components[role.id].used.id === (role.id === 'd3d12' ? vkd3d.id : dxvk.id)));
  assert.equal(partial.components.d3d9.fallback, false);
});

test('per-API linked groups follow shared physical placements instead of a common package identity', t => {
  const f = fixture(t), dxvk = component(f, 'group-dxvk', 'dxvk', {
    d3d8: [], d3d9: [], d3d10core: ['dxgi.dll'], d3d11: ['dxgi.dll'], dxgi: []
  });
  const vkd3d = component(f, 'group-vkd3d', 'vkd3d-proton', { d3d12: [] }, [], { component: 'd3d12' });
  const selections = Object.fromEntries(Roles.DIRECT3D_ROLES.map(role => [role.id, role.id === 'd3d12' ? vkd3d.id : dxvk.id]));
  const plan = legacy(null, 'crossover');
  Plan.resolveApiRoles(plan, { selections, choices: [dxvk, vkd3d], compatibility: compatibility([dxvk, vkd3d]) });
  assert.equal(plan.apiMode, true);
  assert.deepEqual(plan.groups.map(group => group.roles), [['d3d8'], ['d3d9'], ['d3d10', 'd3d11', 'd3d12']]);
  assert.deepEqual(plan.groups.map(group => group.id), ['d3d8', 'd3d9', 'd3d10+d3d11+d3d12']);
  assert.match(plan.groups.find(group => group.id === 'd3d10+d3d11+d3d12').reason, /physical/);
  const coarse = legacy(dxvk); Plan.resolveApiRoles(coarse, {});
  assert.deepEqual(coarse.groups[0].roles, ['d3d8', 'd3d9', 'd3d10', 'd3d11']);
  const automatic = legacy(null, 'crossover'); Plan.resolveApiRoles(automatic, {});
  assert.equal(automatic.groups[0].id, 'd3d8+d3d9+d3d10+d3d11+d3d12');
  const d3d8 = dxvk.files.find(file => file.path.endsWith('d3d8.dll')), bytes = fs.readFileSync(d3d8.path);
  const optional = bytes.readUInt32LE(60) + 24, directories = optional + 112, raw = 0x400, start = 0xc00;
  bytes.writeUInt32LE(0x2000 + start, directories + 13 * 8); bytes.writeUInt32LE(64, directories + 13 * 8 + 4);
  for (const [offset, value] of [[0, 1], [4, 0x2000 + start + 64], [8, 0x2000 + start + 128], [12, 0x2000 + start + 112], [16, 0x2000 + start + 96]]) bytes.writeUInt32LE(value, raw + start + offset);
  bytes.write('dxgi.dll\0', raw + start + 64);
  for (const offset of [96, 112]) bytes.writeBigUInt64LE(0x8000000000000001n, raw + start + offset);
  fs.writeFileSync(d3d8.path, bytes);
  const atomic = Description.describeTranslator(dxvk.root, { id: dxvk.id, engine: 'dxvk', logger: { warn() {} } });
  assert.equal(atomic.files.find(file => file.path === d3d8.path).importsComplete, false);
  const retained = legacy(null, 'crossover');
  Plan.resolveApiRoles(retained, { selections, choices: [atomic, vkd3d], compatibility: compatibility([atomic, vkd3d]) });
  assert.equal(retained.apiMode, true);
  assert.deepEqual(retained.groups.map(group => group.roles), [['d3d8', 'd3d9', 'd3d10', 'd3d11', 'd3d12']]);
});

test('Direct3D 12 and DXGI stay ABI paired on both Wine routes, including incompatible saved choices', async t => {
  const f = fixture(t), Files = require('../src/modules/shared/runtime/translator-files');
  const wine = component(f, 'stock-wine', 'wined3d', { d3d9: [], d3d10core: ['dxgi.dll'], d3d11: ['dxgi.dll'], dxgi: [] });
  const stock12 = component(f, 'stock-vkd3d', 'vkd3d', { d3d12: ['dxgi.dll'] }, [], { component: 'd3d12' });
  const dxvk = component(f, 'dxvk-pair', 'dxvk', { d3d9: [], d3d10core: ['dxgi.dll'], d3d11: ['dxgi.dll'], dxgi: [] });
  const proton = component(f, 'proton-pair', 'vkd3d-proton', { d3d12: ['dxgi.dll'] }, [], { component: 'd3d12' });
  const included = [wine, stock12], choices = [dxvk, proton], checked = compatibility([...included, ...choices]);
  for (const runtime of ['crossover', 'sikarugir']) {
    const resolve = (selections, renderer = null, available = choices) => Plan.resolveApiRoles(
      Plan.resolvePlan({ runtime, selections: { ...(renderer ? { 'd3d-renderer': renderer.id } : {}), d3d12: selections.d3d12 }, included, choices: available }),
      { selections, included, choices: available, compatibility: checked });
    const plan = resolve({ d3d12: proton.id });
    assert.equal(plan.apiMode, true); assert.equal(plan.pairingError, undefined);
    assert.equal(plan.components.d3d12.used.id, proton.id);
    assert.equal(plan.components.d3d11.used.id, dxvk.id);
    assert.equal(plan.placements.find(item => path.basename(item.file.path) === 'dxgi.dll').description.id, dxvk.id);
    const layout = { architecture: 'x86_64', unixName: 'x86_64-unix' };
    const view = await Files.prepareTranslatorFiles(plan, { userDataDir: path.join(f.root, runtime), layout });
    assert.equal(fs.realpathSync(view.links['lib/wine/x86_64-windows/dxgi.dll']), path.join(dxvk.root, 'dxgi.dll'));
    assert.equal(fs.realpathSync(view.links['lib/wine/x86_64-windows/d3d12.dll']), path.join(proton.root, 'd3d12.dll'));
    const incompatible = resolve({ d3d12: proton.id, d3d11: wine.id });
    assert.equal(incompatible.components.d3d11.selected.id, wine.id);
    assert.equal(incompatible.components.d3d11.used.id, dxvk.id);
    assert.equal(incompatible.components.d3d11.reasonCode, 'dxgi-pairing');
    assert.match(incompatible.components.d3d11.reason, /requires DXVK DXGI/);
    const reverse = resolve({ d3d12: stock12.id, d3d11: dxvk.id });
    assert.equal(reverse.components.d3d12.used.id, stock12.id);
    assert.equal(reverse.components.d3d11.selected.id, dxvk.id);
    assert.equal(reverse.components.d3d11.used.id, wine.id);
    assert.equal(reverse.dxgiBinding.description.id, wine.id);
    assert.match(reverse.components.d3d11.reason, /requires Wine's DXGI/);
    const automatic12 = resolve({ d3d11: dxvk.id }, dxvk);
    assert.equal(automatic12.components.d3d12.used.id, proton.id);
    const missingProton = resolve({ d3d11: dxvk.id }, dxvk, [dxvk]);
    assert.deepEqual(missingProton.requiredTranslators, ['vkd3d-proton']);
    const missingDxvk = resolve({ d3d12: proton.id }, null, [proton]);
    assert.deepEqual(missingDxvk.requiredTranslators, ['dxvk']);
    await assert.rejects(Files.prepareTranslatorFiles(missingDxvk, { userDataDir: path.join(f.root, 'blocked'), layout }), /requires DXVK DXGI/);
    assert.equal(fs.existsSync(path.join(f.root, 'blocked')), false);
  }
});

test('a missing DXGI pair uses ordinary consented runtime installation and resumes preparation', async t => {
  const f = fixture(t), Translators = require('../src/modules/shared/runtime/wine-translators');
  const { prepareForLaunch } = require('../src/core/runtime-preparation');
  const { createPinnedNativeManager } = require('../src/modules/shared/runtime/pinned-native-manager');
  const events = [], id = 'fixture-paired-dxvk', version = '3.1.1'; let installed = false;
  const manager = createPinnedNativeManager({ id, label: 'DXVK', discoverCatalog: async () => {
    events.push('catalog'); return [{ version, upstreamRevision: 'fixture-dxvk', asset: { filename: 'dxvk.zip', url: 'https://example.test/dxvk.zip', sha256: 'a'.repeat(64) } }];
  } });
  manager.translatorEngine = 'dxvk';
  const context = { runtimeId: 'crossover', settings: {}, userDataDir: path.join(f.root, 'profile'),
    confirmRuntimeInstall: async () => { events.push('consent'); return true; } };
  const mod = { id: 'pair-fixture', runtimeManagers: [manager], ensureRuntime() {
    events.push(installed ? 'ready' : 'missing');
    return Translators.requirement(installed ? {} : { requiredTranslators: ['dxvk'], layout: { architecture: 'x86_64' },
      pairingError: 'vkd3d-proton requires DXVK DXGI.' }, context, { managers: [manager] });
  }, prepareLaunch() { assert.equal(this.ensureRuntime(), null); } };
  const registry = { listModules: () => [{ id: mod.id }], getModule: () => mod };
  assert.equal(await prepareForLaunch({ entry: {}, mod, info: { runtime: {} }, registry, context,
    install: async (selected, options) => { assert.equal(selected.id, id); assert.equal(options.version, version);
      assert.equal(options.architecture, 'x64'); events.push('install'); installed = true; }, runAction: () => assert.fail('No prefix actions') }), true);
  assert.ok(events.indexOf('consent') < events.indexOf('catalog'));
  assert.ok(events.indexOf('catalog') < events.indexOf('install'));
  assert.ok(events.indexOf('install') < events.indexOf('ready'));
});
