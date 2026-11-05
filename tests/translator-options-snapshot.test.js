const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Plan = require('../src/modules/shared/runtime/translator-plan');
const Description = require('../src/modules/shared/runtime/translator-description');
const Roles = require('../src/modules/shared/runtime/translator-roles');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-options-snapshot-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, put(relative, bytes) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  } };
}
function dll() {
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22); pe.bytes.write('Wine builtin DLL\0', 64); return pe.bytes;
}
function plugin() {
  const names = Array.from({ length: 1024 }, (_, index) => 'observed_system_import_' + index);
  const bytes = image({ cpu: X64, installName: '@rpath/libgstfixture.dylib', symbols: names });
  bytes.writeUInt32LE(0x80, 24);
  let command = 32, symbols;
  for (let index = 0; index < bytes.readUInt32LE(16); index++) {
    if (bytes.readUInt32LE(command) === 2) symbols = bytes.readUInt32LE(command + 8);
    command += bytes.readUInt32LE(command + 4);
  }
  for (let index = 0; index < names.length; index++) {
    const offset = symbols + index * 16; bytes[offset + 4] = 1; bytes[offset + 5] = 0; bytes.writeUInt16LE(0x100, offset + 6);
  }
  return bytes;
}

test('translator option role summaries omit derived inventories while preserving the full canonical plan and display contract', t => {
  const f = fixture(t), source = { kind: 'custom', id: 'fixture-source', label: 'Fixture source', futureSource: 'retained' };
  f.put('included/d3d11.dll', dll()); f.put('selected/d3d11.dll', dll());
  const pluginFile = f.put('video/plugins/libgstfixture.dylib', plugin());
  const privateFile = f.put('video/private/libfixture.dylib', image({ cpu: X64 }));
  const supplied = { ...Description.describeTranslator(path.join(f.root, 'included'), { id: 'included-renderer', engine: 'future-engine', source, version: 'included-release' }),
    settingsEngine: 'declared-settings', futureDescription: { label: 'retained', metadata: [1, 2] } };
  const selected = { ...Description.describeTranslator(path.join(f.root, 'selected'), { id: 'selected-renderer', engine: 'future-engine', source, version: 'requested-release' }),
    engineLabel: 'Future project', variant: 'ordinary-variant', futureDescription: { requested: true } };
  const video = { ...Description.describeTranslator(path.join(f.root, 'video'), { id: 'video-choice', engine: 'gstreamer', source, pluginDirectories: ['plugins'] }),
    futureVideo: { metadata: 'retained' } };
  assert.equal(supplied.files[0].format, 'pe'); assert.equal(supplied.files[0].machine, 0x8664);
  const pluginFacts = video.files.find(file => file.path === pluginFile), usedImports = pluginFacts.slices[0].imports;
  assert.equal(pluginFacts.format, 'macho'); assert.equal(usedImports.length, 1024);
  video.videoPreparation = { pluginDirectories: ['plugins'], excludedFiles: [],
    bindings: usedImports.map(() => ({ source: privateFile, target: privateFile })), warnings: ['derived-only-preparation-warning'] };
  const plan = Plan.projectRoles(Plan.resolvePlan({ runtime: 'sikarugir', selections: { 'd3d-renderer': selected.id, video: video.id },
    included: [supplied], choices: [selected, video], compatibility: { [selected.id]: { compatible: false, reason: 'Actual fixture loading fact' } } }));
  plan.groups = [{ id: 'd3d11', roles: ['d3d11'], affectedRoles: ['d3d11'], label: 'Direct3D 11', reason: 'Shared closure', futureGroup: 'retained' }];
  const before = structuredClone(plan), canonicalJson = JSON.stringify(plan), selectedFiles = selected.files;
  const result = Plan.apiOptions(plan, { included: [supplied], choices: [selected, video], environment: { label: 'Wrapper setting' } });
  assert.deepEqual(result.translatorRoles.map(row => row.id), Roles.ROLES.map(role => role.id));
  assert.deepEqual(result.translatorGroups, plan.groups);
  for (const role of result.translatorRoles) for (const key of ['selected', 'used']) if (role[key]) {
    for (const inventory of ['files', 'unixImports', 'videoPreparation']) assert.equal(Object.hasOwn(role[key], inventory), false);
    const { files, unixImports, videoPreparation, ...expected } = plan.components[role.id][key];
    assert.deepEqual(role[key], expected);
  }
  const eleven = result.translatorRoles.find(row => row.id === 'd3d11');
  assert.equal(eleven.settingsKey, 'translatorD3D11'); assert.equal(eleven.optionsKey, 'translatorD3D11Options'); assert.equal(eleven.groupId, 'd3d11');
  assert.equal(eleven.value, selected.id); assert.equal(eleven.selected.id, selected.id); assert.equal(eleven.used.id, supplied.id);
  assert.equal(eleven.fallback, true); assert.equal(eleven.reason, 'Actual fixture loading fact'); assert.equal(eleven.inherited, false);
  assert.equal(eleven.selected.engineLabel, 'Future project'); assert.equal(eleven.used.settingsEngine, 'declared-settings');
  assert.deepEqual(eleven.used.source, source); assert.deepEqual(eleven.used.apis, ['Direct3D 11']);
  assert.equal(result.translatorRoles.find(row => row.id === 'video').used.futureVideo.metadata, 'retained');
  const option = result.translatorD3D11Options.find(row => row.value === supplied.id);
  assert.deepEqual(option.runtimeSettingsPatch, { translatorD3D11: supplied.id });
  assert.equal(result.translatorD3D11Options[0].value, ''); assert.ok(result.translatorD3D11Options.some(row => row.value === 'inherit'));
  assert.ok(result.translatorD3D11Options.some(row => row.value === 'automatic'));
  assert.equal(JSON.stringify(result).includes('derived-only-preparation-warning'), false);
  assert.deepEqual(plan, before); assert.equal(JSON.stringify(plan), canonicalJson);
  assert.equal(plan.components.d3d11.selected.files, selectedFiles);
  assert.equal(plan.components.video.used.files.find(file => file.path === pluginFile).slices[0].imports, usedImports);
  assert.equal(plan.components.video.used.files.find(file => file.path === pluginFile).slices[0].imports.length, 1024);
  assert.equal(plan.components.video.used.videoPreparation.bindings.length, 1024);
});

test('translator option role summaries preserve canonical null Automatic and inheritance rows', () => {
  const plan = Plan.projectRoles(Plan.resolvePlan({ runtime: 'crossover', environment: { label: 'Bottle setting', selections: {} } }));
  const before = structuredClone(plan), result = Plan.apiOptions(plan, { environment: { label: 'Bottle setting' } });
  for (const row of result.translatorRoles) { assert.equal(row.selected, null); assert.equal(row.used, null); assert.equal(row.inherited, true); }
  assert.ok(result.translatorGroups.some(group => /global backend/.test(group.reason)));
  assert.deepEqual(plan, before);
});
