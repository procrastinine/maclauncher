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
