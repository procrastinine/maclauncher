const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const Roles = require('../src/modules/shared/runtime/translator-roles');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-api-facts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, put(relative, bytes) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  } };
}
function dll(is64 = true) {
  const { bytes, peOffset } = peFixture({ is64 });
  bytes.writeUInt16LE(0x2002, peOffset + 22); bytes.write('Wine builtin DLL\0', 64); return bytes;
}

test('translator role declaration retains stable per-API settings and options keys', () => {
  assert.deepEqual(Roles.ROLES.map(({ id, settingsKey }) => [id, settingsKey]), [
    ['d3d8', 'translatorD3D8'], ['d3d9', 'translatorD3D9'], ['d3d10', 'translatorD3D10'],
    ['d3d11', 'translatorD3D11'], ['d3d12', 'translatorD3D12'],
    ['vulkan-driver', 'translatorVulkan'], ['video', 'translatorVideo']
  ]);
  assert.ok(Roles.ROLES.every(role => role.optionsKey === role.settingsKey + 'Options'));
  assert.deepEqual(Roles.DIRECT3D_ROLES.map(role => role.id), ['d3d8', 'd3d9', 'd3d10', 'd3d11', 'd3d12']);
  assert.deepEqual(Roles.ROLES.find(role => role.id === 'd3d10').apis, ['Direct3D 10', 'Direct3D 10.1']);
});

test('installed translator API facts follow inspected DLLs including Direct3D 10.1 instead of broad manager hints', t => {
  const f = fixture(t);
  for (const name of ['d3d8', 'd3d9', 'd3d10', 'd3d10core', 'd3d10_1', 'd3d11', 'd3d12core', 'dxgi', 'winemetal']) f.put(`x64/${name}.dll`, dll());
  f.put('x32/d3d9.dll', dll(false));
  const description = Description.describeTranslator(f.root, { engine: 'unfamiliar-project', source: 'custom', apis: ['Unsupported source hint'] });
  assert.deepEqual(description.apis.sort(), ['Direct3D 8', 'Direct3D 9', 'Direct3D 10', 'Direct3D 10.1', 'Direct3D 11', 'Direct3D 12'].sort());
  const tenOne = description.files.find(file => file.path.endsWith('d3d10_1.dll'));
  assert.equal(tenOne.format, 'pe'); assert.equal(tenOne.machine, 0x8664); assert.equal(tenOne.architecture, 'x86_64');
  assert.deepEqual(tenOne.apis, ['Direct3D 10.1']);
  assert.deepEqual(description.files.find(file => file.path.endsWith('dxgi.dll')).apis, []);
  assert.deepEqual(description.files.find(file => file.path.endsWith('winemetal.dll')).apis, []);
});

test('old installed versions and incomplete metadata do not gain APIs from hints or filenames alone', t => {
  const f = fixture(t); f.put('d3d9.dll', dll()); f.put('d3d8.dll', 'uninspected file');
  const description = Description.describeTranslator(f.root, { engine: 'd9vk', apis: ['Direct3D 8', 'Direct3D 11'], future: true });
  assert.deepEqual(description.apis, ['Direct3D 9']);
  assert.deepEqual(description.files.find(file => file.path.endsWith('d3d8.dll')).apis, []);
  assert.equal(description.engine, 'd9vk');
  const unknown = Description.description({ component: 'future', engine: 'unfamiliar', form: 'future-form', files: [], apis: ['Future API'], future: true });
  assert.deepEqual(unknown.apis, ['Future API']); assert.equal(unknown.future, true);
});

test('source-owned Wine vkd3d descriptions derive API scope from their existing consumed files', t => {
  const f = fixture(t), file = f.put('d3d12.dll', dll());
  const facts = Description.inspectFile({ path: file, relative: 'd3d12.dll' });
  const description = Description.description({ id: 'included:d3d12:vkd3d', component: 'd3d12', engine: 'vkd3d', form: 'builtin', files: [facts] });
  assert.deepEqual(description.apis, ['Direct3D 12']);
  assert.deepEqual(description.files[0].apis, ['Direct3D 12']);
  assert.equal(description.files[0].architecture, 'x86_64');
});

test('Vulkan ICD API facts remain observed when installed inspection ignores supplied hints', t => {
  const f = fixture(t); f.put('driver.dylib', image({ cpu: X64 }));
  f.put('driver.json', JSON.stringify({ ICD: { library_path: 'driver.dylib', api_version: '1.4.0' } }));
  const description = Description.describeTranslator(f.root, { engine: 'unfamiliar-driver', component: 'vulkan-driver', apis: ['Vulkan 1.0'] });
  assert.deepEqual(description.apis, ['Vulkan 1.4.0']);
  assert.deepEqual(description.files.find(file => file.format === 'macho').cpuSlices, ['x86_64']);
});

test('used API helpers preserve canonical null and legacy additional renderers without aggregate leakage', () => {
  const legacy = { id: 'legacy', engine: 'dxmt', root: '/legacy' }, twelve = { id: 'twelve', engine: 'd3dmetal', root: '/twelve' };
  const extra = { id: 'd9vk', engine: 'dxvk', root: '/d9vk' };
  const old = { components: { 'd3d-renderer': { used: legacy }, d3d12: { used: twelve } }, additional: [extra] };
  assert.equal(Roles.usedForApi(old, 'd3d11'), legacy);
  assert.deepEqual(Roles.usedRenderers(old), [legacy, twelve, extra]);
  const current = { apiMode: true, components: { 'd3d-renderer': { used: legacy }, d3d8: { used: extra }, d3d9: { used: { ...extra } }, d3d11: { used: null } }, additional: [{ ...extra }] };
  assert.equal(Roles.usedForApi(current, 'd3d11'), null); assert.equal(Roles.usedForApi(current, 'd3d10'), null);
  assert.deepEqual(Roles.usedRenderers(current), [extra]);
  current.additional.push({ ...extra, root: '/other-installed-copy' });
  assert.equal(Roles.usedRenderers(current).length, 2);
});
