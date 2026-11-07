const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), { build } = require('vite');
const { react, componentHarness } = require('./helpers/renderer-component');
const Description = require('../src/modules/shared/runtime/translator-description');
const Plan = require('../src/modules/shared/runtime/translator-plan');
const Wine = require('../src/modules/shared/runtime/wine-translators');
const Roles = require('../src/modules/shared/runtime/translator-roles');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

let RuntimeSettingsWindow;
test.before(async () => {
  const result = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, '../src/renderer/src/ui/components/RuntimeSettingsWindow.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'translator-ui-presentation.cjs'), module); compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  ({ RuntimeSettingsWindow } = compiled.exports);
});
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-ui-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function put(root, relative, bytes) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
}
function dll(marker = '') {
  const { bytes, peOffset } = peFixture({ is64: true }); bytes.writeUInt16LE(0x2002, peOffset + 22); bytes.write('Wine builtin DLL\0', 64);
  return marker ? Buffer.concat([bytes, Buffer.from(marker)]) : bytes;
}
function component(root, name, apis, options = {}) {
  const directory = path.join(root, name);
  for (const api of apis) put(directory, `d3d${api}.dll`, dll());
  return Description.describeTranslator(directory, { id: name, engine: 'dxvk', version: '3.1.1', ...options });
}
function projected(runtime, included = [], selections = {}) {
  const plan = Plan.resolvePlan({ runtime, included, selections }); Plan.projectRoles(plan); return plan;
}
function nodes(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value, ...nodes(value.props?.children), ...nodes(value.props?.rows), ...nodes(value.control)];
}

test('D8 options fold complete equivalent API closures while retaining partial differences and saved IDs', t => {
  const root = scratch(t), full = component(root, 'dxvk3', [8, 9, 10, 11]), subset = component(root, 'd9vk', [8, 9]);
  const partialA = component(root, 'partial-a', [8]), partialB = component(root, 'partial-b', [8]);
  put(partialA.root, 'support.dll', dll('first helper')); put(partialB.root, 'support.dll', dll('different helper'));
  const partial = [partialA, partialB].map(item => Description.describeTranslator(item.root, { id: item.id, engine: item.engine }));
  const metal = component(root, 'metal', [11, 12], { engine: 'd3dmetal' }), metal12 = { ...metal, id: 'metal12', component: 'd3d12' };
  const included = [full, subset, metal, metal12, ...partial];
  const plan = projected('sikarugir', included, { 'd3d-renderer': full.id });
  const options = Plan.apiOptions(plan, { included });
  assert.equal(options.translatorD3D8Options.filter(row => [full.id, subset.id].includes(row.value)).length, 1);
  assert.ok(options.translatorD3D8Options.some(row => row.value === full.id), 'the complete provider represents its equivalent subset');
  assert.equal(options.translatorD3D8Options.filter(row => row.value.startsWith('partial-')).length, 2, 'shared primary bytes do not erase different helper closures');
  for (const key of ['translatorD3D11Options', 'translatorD3D12Options']) assert.equal(options[key].filter(row => [metal.id, metal12.id].includes(row.value)).length, 1);
  const saved = projected('sikarugir', included, { 'd3d-renderer': full.id, d3d12: metal12.id });
  Plan.resolveApiRoles(saved, { included, selections: { d3d8: subset.id } });
  const preserved = Plan.apiOptions(saved, { included, selections: { d3d8: subset.id, d3d12: metal12.id } });
  assert.ok(preserved.translatorD3D8Options.some(row => row.value === subset.id));
  assert.equal(preserved.translatorD3D8Options.some(row => row.value === full.id), false);
  assert.ok(preserved.translatorD3D12Options.some(row => row.value === metal12.id));
  assert.equal(saved.components.d3d8.selected.id, subset.id, 'presentation does not replace saved intent');
  const base = component(root, 'shared-base', [11]), wide = component(root, 'shared-wide', [8, 11]), narrow = component(root, 'shared-narrow', [8]);
  for (const item of [base, wide, narrow]) put(item.root, 'support.dll', dll(item === base ? 'existing helper' : 'same alternative helper'));
  const [baseFacts, ...alternatives] = [base, wide, narrow].map(item => Description.describeTranslator(item.root, { id: item.id, engine: item.engine }));
  const linked = projected('sikarugir', [baseFacts], { 'd3d-renderer': baseFacts.id });
  const linkedOptions = Plan.apiOptions(linked, { included: [baseFacts], choices: alternatives }).translatorD3D8Options;
  assert.ok(linkedOptions.some(row => row.value === wide.id) && linkedOptions.some(row => row.value === narrow.id), 'equal API8 files retain different linked API11 effects');
  assert.equal(linkedOptions.find(row => row.value === wide.id).runtimeSettingsPatch.translatorD3D11, wide.id);
  assert.equal(linkedOptions.find(row => row.value === narrow.id).runtimeSettingsPatch.translatorD3D11, 'automatic');
});

test('D8 has one Automatic row and standalone candidates are available without filling other APIs', t => {
  const root = scratch(t), dxvk = component(root, 'dxvk', [8, 9, 10, 11]), vkd3d = component(root, 'vkd3d', [12], { engine: 'vkd3d', component: 'd3d12' });
  const included = [dxvk, vkd3d], plan = projected('crossover', included), settings = {};
  const options = Plan.apiOptions(plan, { included, selections: settings });
  for (const role of Roles.DIRECT3D_ROLES) {
    const automatic = options[role.optionsKey].filter(row => /automatic choice/.test(row.label));
    assert.equal(automatic.length, 1); assert.equal(automatic[0].value, '');
    assert.equal(automatic[0].heldBack, undefined);
  }
  assert.deepEqual(settings, {}); assert.equal(plan.apiMode, undefined);
  const candidate = options.translatorD3D11Options.find(row => row.value === dxvk.id);
  assert.notEqual(candidate.reason, 'runtime-global-automatic'); assert.equal(candidate.heldBack, false);
  const selections = Object.fromEntries(['d3d8', 'd3d9', 'd3d10', 'd3d11'].map(role => [role, dxvk.id]));
  const partial = projected('crossover', included); Plan.resolveApiRoles(partial, { included, selections });
  const remaining = Plan.apiOptions(partial, { included, selections }).translatorD3D12Options.find(row => row.value === vkd3d.id);
  assert.equal(remaining.heldBack, false, 'the last concrete role can complete the composition');
  const complete = projected('crossover', included);
  Plan.resolveApiRoles(complete, { included, selections: { ...selections, d3d12: vkd3d.id } });
  assert.equal(complete.apiMode, true);
  assert.ok(Plan.apiOptions(complete, { included, selections }).translatorD3D11Options.every(row => !row.heldBack));
  const unknown = Plan.apiOptions(plan, { included, selections: { d3d9: 'future:opaque:choice' } }).translatorD3D9Options.find(row => row.value === 'future:opaque:choice');
  assert.ok(unknown); assert.deepEqual(unknown.runtimeSettingsPatch, { translatorD3D9: 'future:opaque:choice' });
});

test('D8 actual action and manifest render one refresh with no stale global Automatic warning', async t => {
  const root = scratch(t), wine = path.join(root, 'wine');
  for (const name of ['wine', 'wineserver', 'wineloader']) put(wine, 'bin/' + name, image({ cpu: X64, fileType: 2 }));
  put(wine, 'lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64, symbols: ['wine_unix_call'] }));
  for (const api of [11, 12]) put(wine, `lib64/apple_gptk/x86_64-windows/d3d${api}.dll`, dll());
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(2, pe.peOffset + 22); pe.bytes.writeUInt16LE(3, pe.optional + 68);
  const executable = put(root, 'game/Game.exe', pe.bytes), gamePath = path.dirname(executable);
  const install = { crossoverRoot: wine, engineRoot: wine, installDir: wine, version: 'fixture', upstreamVersion: '26.3',
    executablePath: path.join(wine, 'bin/wine'), serverPath: path.join(wine, 'bin/wineserver'), loaderPath: path.join(wine, 'bin/wineloader') };
  const registry = require('../src/modules/registry'), manager = require('../src/modules/crossover/runtime/manager');
  t.mock.method(registry, 'listSharedRuntimeManagers', () => []); t.mock.method(registry, 'listModuleIds', () => []);
  t.mock.method(manager, 'resolveSelection', () => ({ ready: true, install }));
  const main = require('../src/modules/crossover/main'), values = { translatorD3D11: 'included:d3d-renderer:d3dmetal', wineDebug: '-warn' };
  const entry = { gameId: 'presentation', gamePath, runtimeId: 'crossover', runtimeData: { crossover: {
    sourceRoot: gamePath, windowsExecutablePath: executable, executableArchitecture: 'x86_64', detectionComplete: true } } };
  const result = await main.actions.listTranslatorOptions(entry, {}, { runtimeId: 'crossover', runtimeSettings: values,
    settings: {}, userDataDir: path.join(root, 'profile'), logger: { warn() {} } });
  assert.equal(result.translatorD3D11Options.filter(row => row.value.endsWith(':d3dmetal')).length, 1);
  const selected = result.translatorD3D11Options.find(row => row.value === values.translatorD3D11);
  assert.equal(selected.heldBack, false); assert.equal(selected.notice, undefined);
  result.notice = 'Included choices appear after the runtime is installed.';
  const schema = main.manifest.runtime.entries.crossover.settings, saves = [], requests = [];
  const state = { modules: [main.manifest], runtimeDefaults: {}, recents: [] };
  const api = { moduleSettingsAction: async (...args) => { requests.push(args); return result; }, setModuleRuntimeSettings: async () => {}, setGameRuntimeSettings: async () => {} };
  const harness = componentHarness(RuntimeSettingsWindow, { api, state, context: { scope: 'module', moduleId: 'crossover', runtimeId: 'crossover' }, error: null,
    fieldKeys: schema.fields.filter(field => field.optionsAction === 'listTranslatorOptions').map(field => field.key),
    controlled: { schema, values, save: async next => saves.push(next) } });
  try {
    harness.render(); const tree = await harness.settle(), markup = renderToStaticMarkup(tree);
    assert.equal(requests.filter(args => args[1] === 'listTranslatorOptions').length, 1); assert.equal((markup.match(/aria-label="Refresh choices"/g) || []).length, 1);
    assert.equal((markup.match(/Included choices appear after the runtime is installed\./g) || []).length, 1);
    assert.doesNotMatch(markup, /keeps its automatic renderer until every Direct3D row/);
    assert.doesNotMatch(markup, /CrossOver shared automatic choice|global backend|Shared physical|API binding|Existing selection: Automatic/);
    assert.equal(saves.length, 0, 'opening settings never migrates saved values');
    const control = nodes(tree).find(node => node.props?.['aria-label'] === 'Direct3D 11');
    await control.props.onChange({ target: { value: 'automatic' } });
    assert.equal(saves.length, 1); assert.equal(saves[0].translatorD3D11, 'automatic'); assert.equal(saves[0].wineDebug, '-warn');
  } finally { harness.close(); }
});
