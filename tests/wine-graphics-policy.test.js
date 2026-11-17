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

// A MoltenVK folder laid out as MetalSharp Wine's: the library and its ICD manifest.
function moltenVk(root, name, extra) {
  const { image, ARM64 } = require('./fixtures/macho-image');
  const lib = path.join(root, name, 'lib', 'libMoltenVK.dylib'), icd = path.join(root, name, 'share', 'vulkan', 'icd.d', 'MoltenVK_icd.json');
  fs.mkdirSync(path.dirname(lib), { recursive: true }); fs.mkdirSync(path.dirname(icd), { recursive: true });
  fs.writeFileSync(lib, image({ cpu: ARM64 }));
  fs.writeFileSync(icd, JSON.stringify({ file_format_version: '1.0.0', ICD: { library_path: '../../../lib/libMoltenVK.dylib', api_version: '1.4.0', is_portability_driver: true } }));
  return { ...Description.describeTranslator(path.join(root, name), { engine: 'moltenvk', component: 'vulkan-driver', source: 'custom' }),
    component: 'vulkan-driver', engine: 'moltenvk', ...extra };
}

test('MetalSharp\'s own MoltenVK runs with its sampler LOD bias emulation off, and no other MoltenVK gets the value', async t => {
  // MetalSharp's MoltenVK adds sampler LOD bias in every shader on Apple GPUs below Apple10 and leaves the bias
  // word undeclared in helper functions, so DXVK's presenter (cursor and gamma helpers) never compiles (P5 0806).
  const source = require('../src/runtime-adapters/wine').definition('metalsharp-wine');
  const embed = source.included.find(item => item.kind === 'vulkan-driver');
  assert.equal(embed.id, 'metalsharp-wine-moltenvk');
  assert.deepEqual(embed.environment, { MVK_CONFIG_EMULATE_SAMPLER_LOD_BIAS: '0' });
  const root = fixture(t), ms = metalSharp(root);
  const own = moltenVk(root, 'metalsharp-moltenvk', { id: 'included:vulkan-driver:moltenvk', included: true, sourceId: embed.id, embedId: embed.id });
  const managed = moltenVk(root, 'moltenvk-1.4.1', { id: 'moltenvk-1.4.1' });
  for (const [driver, expected] of [[own, '0'], [managed, undefined]]) {
    const plan = ms.plan({ d3d11: ms.dxvk.id });
    plan.components['vulkan-driver'] = { used: driver, inherited: false, fallback: false };
    const view = await prepare(root, plan);
    assert.equal(view.env.GRAPHICS_BACKEND, 'dxvk');
    assert.ok(view.env.VK_ICD_FILENAMES, driver.id);
    assert.equal(view.env.MVK_CONFIG_EMULATE_SAMPLER_LOD_BIAS, expected, driver.id);
    // Argument buffers stay at MoltenVK's default: DXVK's 2048-sampler heap needs them (P5 0842).
    assert.equal(Object.hasOwn(view.env, 'MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS'), false, driver.id);
  }
  const Schema = require('../src/runtime-sources/schema');
  const copy = JSON.parse(JSON.stringify(source));
  for (const environment of [[], { lower: '0' }, { MVK_X: 0 }, { MVK_X: 'a\nb' }]) {
    copy.included.find(item => item.id === embed.id).environment = environment;
    assert.throws(() => Schema.validateSource(copy), /environment maps variable names/, JSON.stringify(environment));
  }
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
  // builtins value would load Wine's WineD3D in its place; a set without the DXMT folder the loader
  // reads (aarch64-windows beside aarch64-unix/winemetal.so) sets no value.
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

// A separately installed DXMT build in the layout MetalSharp's loader reads
// from DXMT_RUNTIME_DIR: aarch64-windows libraries beside aarch64-unix/winemetal.so.
function dxmtBuild(root, name, { unix = true, packageRoot = false } = {}) {
  const base = path.join(root, name, 'wine');
  for (const module of ['d3d10core', 'd3d11', 'd3d12', 'dxgi', 'winemetal']) {
    const file = path.join(base, 'aarch64-windows', module + '.dll'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, dll({ builtin: true }));
  }
  if (unix) { fs.mkdirSync(path.join(base, 'aarch64-unix'), { recursive: true }); fs.writeFileSync(path.join(base, 'aarch64-unix', 'winemetal.so'), require('./fixtures/macho-image').image({ installName: '@rpath/winemetal.so' })); }
  // A managed package describes its whole root, with the loader's folder inside it.
  if (packageRoot) fs.writeFileSync(path.join(root, name, 'manifest.json'), '{}');
  return { ...Description.describeTranslator(packageRoot ? path.join(root, name) : base, { engine: 'dxmt', component: 'd3d-renderer', source: 'custom' }), id: 'dxmt:' + name, folder: base };
}
function withChoices(ms, choices) {
  return selections => {
    const included = [ms.mullion, ms.dxvk, ms.proton, ms.wined3d, ms.vkd3d];
    const compatibility = Object.fromEntries([...included, ...choices].map(item => [item.id, { compatible: true, reason: null, warnings: [], files: item.files }]));
    const value = Plan.resolvePlan({ runtime: 'metalsharp-wine', included, choices, compatibility });
    value.components['d3d-renderer'].used = ms.wined3d;
    return Plan.resolveApiRoles(value, { selections, included, choices, compatibility,
      automatic: { d3d8: ms.wined3d, d3d9: ms.wined3d, d3d10: ms.wined3d, d3d11: ms.wined3d, d3d12: null } });
  };
}

test('a chosen MacLauncher DXMT build sets GRAPHICS_BACKEND=dxmt and DXMT_RUNTIME_DIR to its folder, placing none of its files', async t => {
  const root = fixture(t), ms = metalSharp(root), build = dxmtBuild(root, 'dxmt-0.80'), plan = withChoices(ms, [build])({ d3d11: build.id });
  assert.deepEqual(plan.graphicsPolicy, { variable: 'GRAPHICS_BACKEND', value: 'dxmt', lanes: ['metalsharp-wine-mullion', 'metalsharp-wine-dxvk', 'metalsharp-wine-vkd3d-proton'],
    env: { DXMT_RUNTIME_DIR: build.folder }, items: [build.id] });
  // The build serves every Direct3D API it covers ahead of the included Mullion.
  for (const role of ['d3d10', 'd3d11', 'd3d12']) assert.equal(plan.components[role].used.id, build.id, role);
  assert.equal(plan.components.d3d11.fallback, false); assert.equal(plan.components.d3d9.used.id, ms.wined3d.id);
  assert.deepEqual(placedFrom(plan, build), []);
  const view = await prepare(root, plan);
  assert.equal(view.env.GRAPHICS_BACKEND, 'dxmt'); assert.equal(view.env.DXMT_RUNTIME_DIR, build.folder);
  assert.equal(Object.keys(view.links).some(name => /\/(?:d3d10core|d3d11|d3d12|dxgi|winemetal)\.(?:dll|so)$/i.test(name)), false, Object.keys(view.links).join(' '));
  assert.equal(view.dllOverrides.some(line => /^(?:d3d10core|d3d11|d3d12|dxgi)=/.test(line)), false, view.dllOverrides.join(' '));
  // A Mullion choice beside it falls back to the build, because the loader takes that folder's libraries.
  const mixed = withChoices(ms, [build])({ d3d11: build.id, d3d12: ms.mullion.id });
  assert.equal(mixed.graphicsPolicy.env.DXMT_RUNTIME_DIR, build.folder);
  // A package root holding the loader's folder below it loads that folder.
  const packaged = dxmtBuild(root, 'dxmt-package', { packageRoot: true }), whole = withChoices(ms, [packaged])({ d3d11: packaged.id });
  assert.notEqual(packaged.root, packaged.folder);
  assert.deepEqual([whole.graphicsPolicy.env, whole.graphicsPolicy.items], [{ DXMT_RUNTIME_DIR: packaged.folder }, [packaged.id]]);
  assert.deepEqual(placedFrom(whole, packaged), []);
  assert.equal((await prepare(root, whole)).env.DXMT_RUNTIME_DIR, packaged.folder);
  assert.equal(mixed.components.d3d12.used.id, build.id); assert.equal(mixed.components.d3d12.fallback, true);
  assert.equal(mixed.components.d3d12.reasonCode, 'graphics-policy');
});

test('a DXMT build without the files the loader requires sets no MetalSharp value', async t => {
  const root = fixture(t), ms = metalSharp(root), build = dxmtBuild(root, 'windows-only', { unix: false });
  const plan = withChoices(ms, [build])({ d3d11: build.id });
  assert.equal(plan.graphicsPolicy ?? null, null);
  assert.equal(Object.hasOwn((await prepare(root, plan)).env, 'DXMT_RUNTIME_DIR'), false);
});

test('the runtime source schema checks a graphics policy runtime directory', () => {
  const { validateSource } = require('../src/runtime-sources/schema');
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/runtime-sources/wine/metalsharp-wine.json'), 'utf8'));
  assert.doesNotThrow(() => validateSource(source));
  for (const change of [directory => { directory.variable = 'GRAPHICS_BACKEND'; }, directory => { directory.engines = []; }, directory => { directory.files = ['../winemetal.so']; }]) {
    const copy = structuredClone(source); change(copy.graphicsPolicy.values[0].directory);
    assert.throws(() => validateSource(copy), /graphics policy directory/);
  }
});
