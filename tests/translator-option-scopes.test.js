const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const Plan = require('../src/modules/shared/runtime/translator-plan');
const Roles = require('../src/modules/shared/runtime/translator-roles');
const { peFixture } = require('./helpers/pe-fixture');

function dll(is64, imported) {
  const f = peFixture({ is64 }); f.bytes.writeUInt16LE(0x2002, f.peOffset + 22); f.bytes.write('Wine builtin DLL\0', 64);
  if (imported) {
    const start = 0x800, rva = value => 0x2000 + value;
    f.bytes.writeUInt32LE(rva(start), f.directories + 8); f.bytes.writeUInt32LE(40, f.directories + 12);
    f.bytes.writeUInt32LE(rva(start + 40), f.raw + start); f.bytes.writeUInt32LE(rva(start + 72), f.raw + start + 12);
    f.bytes.writeUInt32LE(rva(start + 56), f.raw + start + 16); f.bytes.write(imported + '\0', f.raw + start + 72);
    for (const offset of [start + 40, start + 56]) {
      if (is64) f.bytes.writeBigUInt64LE(0x8000000000000001n, f.raw + offset);
      else f.bytes.writeUInt32LE(0x80000001, f.raw + offset);
    }
  }
  return f.bytes;
}

test('Template-shaped identical D3D8/9 files keep distinct atomic scopes with factual API coverage labels', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-option-scopes-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function describe(name, apis) {
    const directory = path.join(root, name);
    for (const is64 of [false, true]) for (const api of apis) {
      const file = path.join(directory, 'wine', is64 ? 'x86_64-windows' : 'i386-windows', `d3d${api}.dll`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, dll(is64, api === 8 ? 'd3d9.dll' : null));
    }
    return Description.describeTranslator(directory, { engine: 'dxvk', id: name, version: 'DXVK-Sikarugir-v3.1.1-async',
      source: { label: 'Sikarugir Template 1.0.24' } });
  }
  const subset = describe('d9vk', [8, 9]), full = describe('dxvk3', [8, 9, 10, 11]), included = [subset, full];
  subset.aliases = ['saved:subset'];
  const plan = Plan.resolvePlan({ runtime: 'sikarugir', included, selections: { 'd3d-renderer': 'saved:subset' } });
  Plan.projectRoles(plan);
  const before = structuredClone(plan), result = Plan.apiOptions(plan, { included });
  for (const role of Roles.DIRECT3D_ROLES.filter(role => ['d3d8', 'd3d9'].includes(role.id))) {
    const files = included.map(item => Plan.filesForRole(item, role));
    assert.equal(files[0].length, files[1].length);
    for (const file of files[0]) assert.deepEqual(fs.readFileSync(file.path), fs.readFileSync(files[1].find(other =>
      path.basename(other.path) === path.basename(file.path) && other.machine === file.machine).path));
    const rows = result[role.optionsKey].filter(row => included.some(item => item.id === row.value));
    assert.equal(rows.length, 2, 'the physical source bindings still have different atomic effects');
    assert.deepEqual(rows.map(row => row.label), ['DXVK 3.1.1 async · Sikarugir Template 1.0.24 · Direct3D 8, 9',
      'DXVK 3.1.1 async · Sikarugir Template 1.0.24 · Direct3D 8, 9, 10, 11']);
    assert.notDeepEqual(rows[0].affectedRoles, rows[1].affectedRoles);
  }
  const aggregate = Plan.options({ runtime: 'sikarugir', component: 'd3d-renderer', included, selections: { 'd3d-renderer': 'saved:subset' } });
  assert.deepEqual(aggregate.filter(row => row.apis).map(row => row.label), result.translatorD3D8Options.filter(row => row.apis).map(row => row.label));
  assert.ok(aggregate.some(row => row.value === 'saved:subset'));
  assert.deepEqual(plan, before, 'disambiguating the menu never rewrites the selected or used plan');
});
