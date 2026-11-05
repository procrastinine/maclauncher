const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const Files = require('../src/modules/shared/runtime/translator-files');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');
const layout = { architecture: 'x86_64', unixName: 'x86_64-unix' };
function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-api-placement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function put(root, relative, bytes) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
}
function dll(builtin = true) {
  const { bytes, peOffset } = peFixture({ is64: true }); bytes.writeUInt16LE(0x2002, peOffset + 22);
  if (builtin) bytes.write('Wine builtin DLL\0', 64); return bytes;
}
function row(used, inherited = false) { return { used, inherited, fallback: false }; }
function placement(description, file, roles) { return { description, file, roles }; }

test('API placements materialize included CrossOver files and retain the untouched global route', async t => {
  const root = scratch(t), component = path.join(root, 'component');
  const primary = put(component, 'd3d11.dll', dll()), unix = put(component, 'winemetal.so', image({ cpu: X64 }));
  put(component, 'd3d9.dll', dll()); put(component, 'unconsumed/plugin.so', image({ cpu: X64 }));
  const description = { ...Description.describeTranslator(component, { engine: 'dxmt' }), included: true };
  const primaryFile = description.files.find(file => file.path === primary), unixFile = description.files.find(file => file.path === unix);
  const plan = { runtime: 'crossover', apiMode: true, components: {
    'd3d-renderer': row({ ...description, id: 'legacy-aggregate' }), d3d10: row(description, true), d3d11: row(description)
  }, placements: [placement(description, primaryFile, ['d3d11']), placement(description, unixFile, ['d3d10', 'd3d11'])],
  compatibility: { [description.id]: { files: description.files } } };
  const selected = Files.selectedDescriptions(plan);
  assert.equal(selected.length, 1); assert.equal(selected[0].files.length, 2);
  const options = { userDataDir: path.join(root, 'profile'), layout };
  const view = await Files.prepareTranslatorFiles(plan, options);
  assert.equal(view.env.CX_GRAPHICS_BACKEND, 'wined3d');
  assert.equal(fs.realpathSync(view.links['lib/wine/x86_64-windows/d3d11.dll']), primary);
  assert.equal(fs.realpathSync(view.links['lib/wine/x86_64-unix/winemetal.so']), unix);
  assert.equal(Object.hasOwn(view.links, 'lib/wine/x86_64-windows/d3d9.dll'), false);
  assert.equal(view.libraryPaths.includes(path.join(component, 'unconsumed')), false);
  assert.equal((await Files.prepareTranslatorFiles(plan, options)).root, view.root);
  const legacy = await Files.prepareTranslatorFiles({ runtime: 'crossover', components: { 'd3d-renderer': row(description) } }, options);
  assert.equal(legacy.env.CX_GRAPHICS_BACKEND, 'dxmt'); assert.deepEqual(legacy.links, {});
});

test('API placements retain exact builtin vkd3d and DXGI helper files instead of filtering a component name', async t => {
  const root = scratch(t), component = path.join(root, 'vkd3d');
  put(component, 'd3d12.dll', dll()); const dxgi = put(component, 'dxgi.dll', dll());
  put(component, 'd3d12.so', image({ cpu: X64 }));
  const description = Description.describeTranslator(component, { engine: 'vkd3d', component: 'd3d12' });
  const plan = { runtime: 'crossover', apiMode: true, components: { d3d12: row(description) },
    placements: description.files.map(file => placement(description, file, ['d3d12'])) };
  const view = await Files.prepareTranslatorFiles(plan, { userDataDir: path.join(root, 'profile'), layout });
  assert.equal(view.env.CX_GRAPHICS_BACKEND, 'wined3d');
  assert.equal(fs.realpathSync(view.links['lib/wine/x86_64-windows/dxgi.dll']), dxgi);
  assert.ok(view.dllOverrides.includes('d3d12=b')); assert.ok(view.dllOverrides.includes('dxgi=b'));
  const unfamiliar = { ...description, component: 'unfamiliar-component' };
  const unknownView = await Files.prepareTranslatorFiles({ ...plan, components: { d3d12: row(unfamiliar) },
    placements: description.files.map(file => placement(unfamiliar, file, ['d3d12'])) }, { userDataDir: path.join(root, 'profile'), layout });
  assert.equal(unknownView.env.CX_GRAPHICS_BACKEND, 'wined3d');
  assert.equal(fs.realpathSync(unknownView.links['lib/wine/x86_64-windows/dxgi.dll']), dxgi);
});

test('API placements preserve inherited native DLLs when another role explicitly uses the same component', async t => {
  const root = scratch(t), component = path.join(root, 'native');
  const d3d9 = put(component, 'd3d9.dll', dll(false)), d3d11 = put(component, 'd3d11.dll', dll(false));
  const description = Description.describeTranslator(component, { engine: 'dxvk' });
  const plan = { runtime: 'crossover', apiMode: true, components: { d3d9: row(description), d3d11: row(description, true) },
    placements: description.files.map(file => placement(description, file, [file.path === d3d9 ? 'd3d9' : 'd3d11'])) };
  const view = await Files.prepareTranslatorFiles(plan, { userDataDir: path.join(root, 'profile'), layout });
  assert.deepEqual(view.native.map(file => file.source), [d3d9]);
  const prefix = path.join(root, 'external-prefix');
  const original9 = put(prefix, 'drive_c/windows/system32/d3d9.dll', 'original d3d9'), original11 = put(prefix, 'drive_c/windows/system32/d3d11.dll', 'original d3d11');
  await Files.applyNativeLibraries(view, prefix);
  assert.equal(fs.realpathSync(original9), d3d9); assert.equal(fs.readFileSync(original11, 'utf8'), 'original d3d11');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(prefix, '.maclauncher-translators.json')))), ['system32/d3d9.dll']);
  assert.equal(fs.existsSync(d3d11), true);
  await Files.applyNativeLibraries({ native: [] }, prefix);
  assert.equal(fs.readFileSync(original9, 'utf8'), 'original d3d9'); assert.equal(fs.readFileSync(original11, 'utf8'), 'original d3d11');
  const legacy = await Files.prepareTranslatorFiles({ runtime: 'crossover', components: {
    'd3d-renderer': row(description), d3d9: row(description), d3d11: row(description) } }, { userDataDir: path.join(root, 'profile'), layout });
  assert.equal(legacy.native.length, 2, 'projected roles must not duplicate legacy prefix placements or lose backups');
  await Files.applyNativeLibraries(legacy, prefix); await Files.applyNativeLibraries({ native: [] }, prefix);
  assert.equal(fs.readFileSync(original9, 'utf8'), 'original d3d9'); assert.equal(fs.readFileSync(original11, 'utf8'), 'original d3d11');
});
