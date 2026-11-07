const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Plan = require('../src/modules/shared/runtime/translator-plan');
const Description = require('../src/modules/shared/runtime/translator-description');
const Files = require('../src/modules/shared/runtime/translator-files');
const Binary = require('../src/modules/shared/runtime/binary-compatibility');
const Roles = require('../src/modules/shared/runtime/translator-roles');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');
function put(root, relative, bytes) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
}
function component(root, name, apis) {
  const directory = path.join(root, name);
  const bridge = put(directory, 'external/libd3dshared.dylib', image({ cpu: X64, installName: '@rpath/libd3dshared.dylib', symbols: ['bridge_' + name] }));
  put(directory, 'external/D3DMetal.framework/Versions/A/D3DMetal', image({ cpu: X64, symbols: ['framework_' + name] }));
  for (const api of apis) {
    const { bytes, peOffset } = peFixture({ is64: true });
    bytes.writeUInt16LE(0x2002, peOffset + 22); bytes.write('Wine builtin DLL\0', 64);
    put(directory, `d3d${api}.dll`, bytes); fs.symlinkSync('external/libd3dshared.dylib', path.join(directory, `d3d${api}.so`));
  }
  return { bridge, description: Description.describeTranslator(directory, { id: name, engine: 'd3dmetal' }) };
}
function legacy(base) { return Plan.resolvePlan({ runtime: 'sikarugir', included: [base], selections: { 'd3d-renderer': base.id } }); }

test('per-API bridge destinations conflict across sources while one physical bridge retains both logical Unix aliases', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-api-bridge-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = component(root, 'a', [11]), b = component(root, 'b', [11, 12]);
  const compatibility = Object.fromEntries([a, b].map(({ description }) => [description.id, Binary.compatibility(description,
    { layout: { architecture: 'x86_64' }, modules: {} }, { executableArchitecture: 'x86_64', macOSVersion: '26.0' })]));
  const options = { choices: [b.description], included: [a.description], compatibility };
  const conflict = legacy(a.description);
  Plan.resolveApiRoles(conflict, { ...options, selections: { d3d11: a.description.id, d3d12: b.description.id } });
  assert.equal(conflict.components.d3d12.selected.id, b.description.id);
  assert.equal(conflict.components.d3d12.used, null); assert.equal(conflict.components.d3d12.fallback, true);
  assert.match(conflict.components.d3d12.reason, /external:libd3dshared\.dylib/);
  assert.equal(conflict.components.d3d12.reasonCode, 'shared-physical-binding');
  assert.equal(conflict.requiredTranslators, undefined, 'a known bridge collision cannot request another download');
  assert.equal(conflict.pairingError, undefined);
  const offered = Plan.apiOptions(conflict, options).translatorD3D12Options.find(option => option.value === b.description.id);
  assert.deepEqual(offered.affectedRoles, ['d3d11', 'd3d12']);
  assert.deepEqual(offered.runtimeSettingsPatch, { translatorD3D11: b.description.id, translatorD3D12: b.description.id });
  const selections = Object.fromEntries(Roles.DIRECT3D_ROLES.filter(role => offered.runtimeSettingsPatch[role.settingsKey]).map(role =>
    [role.id, offered.runtimeSettingsPatch[role.settingsKey]]));
  const coherent = legacy(a.description); Plan.resolveApiRoles(coherent, { ...options, selections });
  assert.equal(coherent.apiMode, true);
  assert.equal(coherent.requiredTranslators, undefined, 'one physical bridge needs no inferred DXGI download');
  assert.equal(coherent.pairingError, undefined);
  const aliases = coherent.placements.filter(placement => placement.file.path.endsWith('.so'));
  assert.deepEqual(aliases.map(placement => path.basename(placement.file.path)).sort(), ['d3d11.so', 'd3d12.so']);
  assert.ok(aliases.every(placement => placement.file.realPath === b.bridge));
  assert.ok(aliases.every(placement => placement.roles.includes('d3d11') && placement.roles.includes('d3d12')));
  assert.deepEqual(coherent.groups.find(group => group.roles.includes('d3d11')).roles, ['d3d11', 'd3d12']);
  const view = await Files.prepareTranslatorFiles(coherent, { userDataDir: path.join(root, 'profile'), layout: { architecture: 'x86_64', unixName: 'x86_64-unix' } });
  for (const api of [11, 12]) assert.equal(fs.realpathSync(view.links[`lib/wine/x86_64-unix/d3d${api}.so`]), view.env.CX_APPLEGPTK_LIBD3DSHARED_PATH);
  assert.deepEqual(fs.readFileSync(view.env.CX_APPLEGPTK_LIBD3DSHARED_PATH), fs.readFileSync(b.bridge));
  assert.equal(fs.realpathSync(path.join(view.root, 'external/D3DMetal.framework')), path.join(root, 'b/external/D3DMetal.framework'));
});
