const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const Plan = require('../src/modules/shared/runtime/translator-plan');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

test('API bindings preserve inspected aliases to the same real PE and Unix source while linking different sources', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-api-alias-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  const dll = () => {
    const { bytes, peOffset } = peFixture({ is64: true });
    bytes.writeUInt16LE(0x2002, peOffset + 22); bytes.write('Wine builtin DLL\0', 64); return bytes;
  };
  const dxgi = put('shared/dxgi-real.dll', dll()), unix = put('shared/winemetal-real.so', image({ cpu: X64 }));
  const alias = (relative, source) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(file), source), file);
    return Description.inspectFile({ path: file, relative });
  };
  const baseDxgi = alias('base/dxgi.dll', dxgi), otherDxgi = alias('selected/dxgi.dll', dxgi);
  const baseUnix = alias('base/winemetal.so', unix), otherUnix = alias('selected/winemetal.so', unix);
  assert.notEqual(baseDxgi.path, otherDxgi.path); assert.equal(baseDxgi.realPath, otherDxgi.realPath);
  assert.equal(baseUnix.realPath, otherUnix.realPath); assert.equal(baseUnix.realPath, unix);
  assert.equal(path.basename(baseDxgi.path), 'dxgi.dll'); assert.equal(path.basename(baseUnix.path), 'winemetal.so');
  const describe = (id, engine, files) => Description.description({ id, root, engine, component: 'd3d-renderer', form: 'builtin', files });
  const base = describe('base', 'dxmt', [Description.inspectFile({ path: put('base/d3d10core.dll', dll()) }), baseDxgi, baseUnix]);
  const selected = describe('selected', 'dxvk', [Description.inspectFile({ path: put('selected/d3d11.dll', dll()) }), otherDxgi, otherUnix]);
  const legacy = () => Plan.resolvePlan({ runtime: 'sikarugir', selections: { 'd3d-renderer': base.id }, included: [base] });
  const plan = legacy();
  Plan.resolveApiRoles(plan, { selections: { d3d11: selected.id }, included: [base], choices: [selected] });
  assert.equal(plan.apiMode, true); assert.equal(plan.components.d3d11.used.id, selected.id); assert.equal(plan.components.d3d11.fallback, false);
  assert.equal(plan.placements.filter(item => path.basename(item.file.path) === 'dxgi.dll').length, 1);
  assert.equal(plan.placements.filter(item => path.basename(item.file.path) === 'winemetal.so').length, 1);
  const options = Plan.apiOptions(plan, { included: [base], choices: [selected], selections: { d3d11: selected.id } });
  const option = options.translatorD3D11Options.find(row => row.value === selected.id);
  assert.deepEqual(option.affectedRoles, ['d3d11']);
  assert.deepEqual(option.runtimeSettingsPatch, { translatorD3D11: selected.id });

  const differentDxgi = alias('different/dxgi.dll', put('shared/another-dxgi.dll', dll()));
  const different = describe('different', 'dxvk', selected.files.map(file => path.basename(file.path) === 'dxgi.dll' ? differentDxgi : file));
  const conflicting = legacy();
  Plan.resolveApiRoles(conflicting, { selections: { d3d11: different.id }, included: [base], choices: [different] });
  assert.equal(conflicting.components.d3d11.selected.id, different.id); assert.equal(conflicting.components.d3d11.used, null);
  assert.equal(conflicting.components.d3d11.fallback, true); assert.match(conflicting.components.d3d11.reason, /physical binding conflict.*dxgi/);
  const distinctOption = Plan.apiOptions(plan, { included: [base], choices: [different] }).translatorD3D11Options.find(row => row.value === different.id);
  assert.ok(distinctOption.affectedRoles.includes('d3d10'));
  assert.equal(distinctOption.runtimeSettingsPatch.translatorD3D10, 'automatic');
  const differentUnix = alias('different/winemetal.so', put('shared/another-winemetal.so', image({ cpu: X64 })));
  const unixConflict = describe('different-unix', 'dxvk', selected.files.map(file => path.basename(file.path) === 'winemetal.so' ? differentUnix : file));
  const separateUnix = legacy();
  Plan.resolveApiRoles(separateUnix, { selections: { d3d11: unixConflict.id }, included: [base], choices: [unixConflict] });
  assert.equal(separateUnix.components.d3d11.selected.id, unixConflict.id);
  assert.equal(separateUnix.components.d3d11.fallback, true); assert.match(separateUnix.components.d3d11.reason, /physical binding conflict.*winemetal/);
});
