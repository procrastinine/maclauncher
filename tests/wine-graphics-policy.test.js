const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Plan = require('../src/core/runtime-resolution/translator-plan');
const Description = require('../src/modules/shared/runtime/translator-description');
const Files = require('../src/modules/shared/runtime/translator-files');
const { peFixture } = require('./helpers/pe-fixture');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wine-graphics-policy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function dll({ builtin }) {
  const { bytes, peOffset } = peFixture({ is64: true }); bytes.writeUInt16LE(0x2002, peOffset + 22);
  if (builtin) bytes.write('Wine builtin DLL\0', 64);
  return bytes;
}
// Descriptions in the shape the Wine source's included components and a
// managed translator take.
function component(root, name, engine, modules, { builtin = false, included = true, embedId, component = 'd3d-renderer', id } = {}) {
  for (const module of modules) {
    const file = path.join(root, name, module + '.dll'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, dll({ builtin }));
  }
  const description = Description.describeTranslator(path.join(root, name), { engine, component, source: included ? { label: 'MetalSharp Wine 7.0' } : 'custom' });
  return { ...description, id: id || (included ? `included:${component}:${engine}` : name), ...(included ? { included: true } : {}), ...(embedId ? { sourceId: embedId, embedId } : {}) };
}
function metalSharp(root) {
  const mullion = component(root, 'mullion', 'mullion', ['d3d10core', 'd3d11', 'd3d12', 'd3d12core', 'dxgi', 'nvngx', 'winemetal'], { builtin: true, embedId: 'metalsharp-wine-mullion' });
  const dxvk = component(root, 'dxvk', 'dxvk', ['d3d9', 'd3d10core', 'd3d11', 'dxgi', 'nvapi64'], { embedId: 'metalsharp-wine-dxvk' });
  const proton = component(root, 'vkd3d-proton', 'vkd3d-proton', ['d3d10core', 'd3d11', 'd3d12', 'd3d12core', 'dxgi', 'nvapi64', 'nvngx'], { embedId: 'metalsharp-wine-vkd3d-proton' });
  const wined3d = component(root, 'wine', 'wined3d', ['d3d8', 'd3d9', 'd3d10core', 'd3d11', 'dxgi'], { builtin: true });
  const vkd3d = component(root, 'wine-d3d12', 'vkd3d', ['d3d12', 'd3d12core'], { builtin: true, component: 'd3d12' });
  const managed = component(root, 'dxvk-3.1.1', 'dxvk', ['d3d9', 'd3d10core', 'd3d11', 'dxgi'], { included: false });
  const dxmt = component(root, 'dxmt-0.80', 'dxmt', ['d3d10core', 'd3d11', 'dxgi', 'winemetal'], { builtin: true, included: false });
  const included = [mullion, dxvk, proton, wined3d, vkd3d], choices = [managed, dxmt];
  const compatibility = Object.fromEntries([...included, ...choices].map(item => [item.id, { compatible: true, reason: null, warnings: [], files: item.files }]));
  // The Wine's own automatic composition: WineD3D for Direct3D 8 to 11.
  const plan = (selections) => {
    const value = Plan.resolvePlan({ runtime: 'metalsharp-wine', included, choices, compatibility });
    value.components['d3d-renderer'].used = wined3d;
    return Plan.resolveApiRoles(value, { selections, included, choices, compatibility,
      automatic: { d3d8: wined3d, d3d9: wined3d, d3d10: wined3d, d3d11: wined3d, d3d12: null } });
  };
  return { mullion, dxvk, proton, wined3d, vkd3d, managed, dxmt, plan };
}
const layout = { architecture: 'arm64', unixName: 'aarch64-unix' };
const prepare = (root, plan) => Files.prepareTranslatorFiles(plan, { userDataDir: path.join(root, 'profile'), layout });
const placedFrom = (plan, item) => (plan.placements || []).filter(placement => placement.description.id === item.id);

test('MetalSharp Wine declares its Direct3D lanes and the environment value that selects each', () => {
  const source = require('../src/runtime-adapters/wine').definition('metalsharp-wine');
  const policy = require('../src/modules/crossover/sources').get('metalsharp-wine').graphicsPolicy;
  assert.equal(policy.variable, 'GRAPHICS_BACKEND');
  assert.equal(policy.builtins, 'wine'); assert.equal(policy.default, 'dxmt');
  assert.deepEqual(policy.values.map(entry => entry.value), ['dxmt', 'dxvk', 'vkd3d']);
  const embeds = new Map(source.included.map(embed => [embed.id, embed]));
  for (const entry of policy.values) for (const lane of entry.lanes) assert.equal(embeds.get(lane)?.kind, 'd3d-translator', lane);
  assert.deepEqual(policy.values.map(entry => embeds.get(entry.lanes[0]).parts[0].path), ['lib/mullion', 'lib/dxvk', 'lib/vkd3d-proton']);
  // MetalSharp's loader takes DXVK and vkd3d-proton only for x86_64 programs.
  assert.deepEqual(policy.values.map(entry => entry.architectures || null), [null, ['x64'], ['x64']]);
});

test('an explicit MetalSharp DXVK choice sets GRAPHICS_BACKEND=dxvk and places none of its files', async t => {
  const root = fixture(t), ms = metalSharp(root);
  const plan = ms.plan({ d3d11: ms.dxvk.id });
  assert.deepEqual(plan.graphicsPolicy, { variable: 'GRAPHICS_BACKEND', value: 'dxvk', lanes: ['metalsharp-wine-mullion', 'metalsharp-wine-dxvk', 'metalsharp-wine-vkd3d-proton'] });
  assert.equal(plan.components.d3d11.used.id, ms.dxvk.id); assert.equal(plan.components.d3d11.fallback, false);
  // The value's own lane serves every Direct3D API it covers; Mullion keeps Direct3D 12.
  assert.equal(plan.components.d3d9.used.id, ms.dxvk.id); assert.equal(plan.components.d3d10.used.id, ms.dxvk.id);
  assert.equal(plan.components.d3d12.used.id, ms.mullion.id); assert.equal(plan.components.d3d8.used.id, ms.wined3d.id);
  for (const lane of [ms.dxvk, ms.mullion, ms.proton]) assert.deepEqual(placedFrom(plan, lane), [], lane.id);
  assert.equal(plan.pairingError, undefined);
  const view = await prepare(root, plan);
  assert.equal(view.env.GRAPHICS_BACKEND, 'dxvk');
  assert.equal(Object.keys(view.links).some(name => /\/(?:d3d9|d3d10core|d3d11|dxgi|d3d12)\.dll$/i.test(name)), false, Object.keys(view.links).join(' '));
  assert.equal(view.native.length, 0);
  assert.equal(view.dllOverrides.some(line => /^(?:d3d9|d3d10core|d3d11|dxgi|d3d12)=/.test(line)), false, view.dllOverrides.join(' '));
});

test('automatic MetalSharp choices leave GRAPHICS_BACKEND unset, so its own default stays', async t => {
  const root = fixture(t), ms = metalSharp(root);
  for (const selections of [{}, { d3d9: 'automatic', d3d11: 'automatic', d3d12: 'automatic' }]) {
    const plan = ms.plan(selections);
    assert.equal(plan.graphicsPolicy ?? null, null);
    assert.equal(Object.hasOwn((await prepare(root, plan)).env, 'GRAPHICS_BACKEND'), false);
  }
});

test('explicit MetalSharp vkd3d-proton, Mullion and Wine builtin choices select their own values', async t => {
  const root = fixture(t), ms = metalSharp(root);
  const proton = ms.plan({ d3d12: ms.proton.id });
  assert.equal(proton.graphicsPolicy.value, 'vkd3d');
  assert.equal(proton.components.d3d12.used.id, ms.proton.id); assert.equal(proton.components.d3d11.used.id, ms.proton.id);
  assert.equal(proton.components.d3d9.used.id, ms.dxvk.id, 'its Direct3D 9 comes from the DXVK folder');
  assert.equal((await prepare(root, proton)).env.GRAPHICS_BACKEND, 'vkd3d');
  const mullion = ms.plan({ d3d11: ms.mullion.id });
  assert.equal(mullion.graphicsPolicy.value, 'dxmt'); assert.equal(mullion.components.d3d9.used.id, ms.wined3d.id);
  assert.deepEqual(placedFrom(mullion, ms.mullion), []);
  assert.equal((await prepare(root, mullion)).env.GRAPHICS_BACKEND, 'dxmt');
  // Mullion replaces Wine's own Direct3D 11 and 12 builtins while its value is in effect.
  const wined3d = ms.plan({ d3d11: ms.wined3d.id });
  assert.equal(wined3d.graphicsPolicy.value, 'wine'); assert.equal(wined3d.components.d3d11.used.id, ms.wined3d.id);
  assert.equal((await prepare(root, wined3d)).env.GRAPHICS_BACKEND, 'wine');
  assert.equal(ms.plan({ d3d12: ms.vkd3d.id }).graphicsPolicy.value, 'wine');
  // Wine's own Direct3D 9 is not a Mullion library, so the default stays.
  assert.equal(ms.plan({ d3d9: ms.wined3d.id }).graphicsPolicy ?? null, null);
  // Another builtin set is not in MetalSharp's own builtin folder, which Wine searches first, so the
  // builtins value would load Wine's WineD3D in its place; such a choice sets no value.
  assert.equal(ms.plan({ d3d11: ms.dxmt.id }).graphicsPolicy ?? null, null);
});

test('a placed native translator keeps its route and sets no MetalSharp value', async t => {
  const root = fixture(t), ms = metalSharp(root);
  const plan = ms.plan({ d3d11: ms.managed.id });
  assert.equal(plan.graphicsPolicy ?? null, null);
  assert.equal(plan.components.d3d11.used.id, ms.managed.id);
  const view = await prepare(root, plan);
  assert.equal(Object.hasOwn(view.env, 'GRAPHICS_BACKEND'), false);
  assert.ok(view.dllOverrides.includes('d3d11=n,b')); assert.ok(view.native.some(file => file.name === 'd3d11.dll'));
  // Beside a MetalSharp value, the native library still loads first.
  const mixed = ms.plan({ d3d11: ms.managed.id, d3d12: ms.proton.id });
  assert.equal(mixed.graphicsPolicy.value, 'vkd3d'); assert.equal(mixed.components.d3d11.used.id, ms.managed.id);
  assert.equal(mixed.components.d3d11.fallback, false);
});

test('choices that need two MetalSharp values keep the newest Direct3D choice and report the other', t => {
  const root = fixture(t), ms = metalSharp(root);
  const plan = ms.plan({ d3d9: ms.wined3d.id, d3d11: ms.wined3d.id, d3d12: ms.proton.id });
  assert.equal(plan.graphicsPolicy.value, 'vkd3d');
  assert.equal(plan.components.d3d12.fallback, false);
  for (const role of ['d3d9', 'd3d11']) {
    const row = plan.components[role];
    assert.equal(row.fallback, true, role); assert.equal(row.reasonCode, 'graphics-policy', role);
    assert.equal(row.selected.id, ms.wined3d.id, role);
  }
  assert.equal(plan.components.d3d9.used.id, ms.dxvk.id); assert.equal(plan.components.d3d11.used.id, ms.proton.id);
  assert.match(Plan.fallbackNotice('graphics-policy'), /one Direct3D route/);
});

test('a MetalSharp lane is usable only for the programs its value applies to', () => {
  const Policy = require('../src/core/runtime-resolution/graphics-policy');
  const description = { included: true, embedId: 'metalsharp-wine-dxvk', engine: 'dxvk', files: [] };
  assert.equal(Policy.laneCompatibility('metalsharp-wine', description, 'x86_64').compatible, true);
  const x86 = Policy.laneCompatibility('metalsharp-wine', description, 'x86');
  assert.equal(x86.compatible, false); assert.match(x86.reason, /64-bit Intel/);
  assert.equal(Policy.laneCompatibility('metalsharp-wine', { ...description, embedId: 'metalsharp-wine-mullion' }, 'x86_64').compatible, true);
  assert.equal(Policy.laneCompatibility('metalsharp-wine', { ...description, included: false }, 'x86'), null);
  assert.equal(Policy.laneCompatibility('crossover', description, 'x86'), null);
});


test('a Wine source policy cannot admit a component refused by actual binary or required-file inspection', async t => {
  const Binary = require('../src/modules/shared/runtime/binary-compatibility');
  const { createWineResolver } = require('../src/core/runtime-resolution/wine-plan');
  t.mock.method(Binary, 'wineCompatibilityRecord', async () => ({ layout: { architecture: 'x86_64' }, modules: {} }));
  for (const kind of ['wrong-cpu', 'missing-file']) {
    const root = fixture(t), wine = component(root, 'wine-' + kind, 'wined3d', ['d3d11'], { builtin: true });
    const directory = path.join(root, kind); fs.mkdirSync(directory);
    const file = path.join(directory, 'd3d11.dll'), pe = peFixture({ is64: kind !== 'wrong-cpu' });
    pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22); pe.bytes.write('Wine builtin DLL\0', 64); fs.writeFileSync(file, pe.bytes);
    const selected = { ...Description.describeTranslator(directory, { engine: 'mullion' }), included: true,
      id: kind, embedId: 'metalsharp-wine-mullion', requiredPaths: [file] };
    if (kind === 'missing-file') fs.unlinkSync(file);
    const measured = Binary.compatibility(selected, { layout: { architecture: 'x86_64' }, modules: {} }, { executableArchitecture: 'x86_64', macOSVersion: '26.0' });
    assert.equal(measured.compatible, false, kind);
    const source = require('../src/modules/crossover/sources').get('metalsharp-wine');
    const resolver = createWineResolver({ sourceFor: () => source,
      optionsInventory: async () => ({ included: [selected, wine], choices: [], layout: { architecture: 'x86_64' } }) });
    const plan = await resolver.resolve({}, 'metalsharp-wine', { runtimeSettings: { translatorD3D11: selected.id }, settings: {} },
      { executableArchitecture: 'x86_64', host: { hardwareArch: 'arm64', macOSVersion: '26.0', physicalAppleGPU: false } });
    assert.equal(plan.compatibility[selected.id].compatible, false, kind);
    assert.equal(plan.compatibility[selected.id].reason, measured.reason, kind);
    assert.notEqual(plan.components.d3d11.used?.id, selected.id, kind);
  }
});
