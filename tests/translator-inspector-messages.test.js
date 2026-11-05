const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), { build } = require('vite');
const { react, componentHarness } = require('./helpers/renderer-component');
const { createLibraryFixture } = require('./library-layout-fixture');
const { peFixture } = require('./helpers/pe-fixture');
const Description = require('../src/modules/shared/runtime/translator-description');
const Plan = require('../src/modules/shared/runtime/translator-plan');
const Wine = require('../src/modules/shared/runtime/wine-translators');
const Providers = require('../src/modules/shared/runtime/providers');
let GameDetails;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: { ssr: path.join(__dirname, '../src/renderer/src/ui/components/GameDetails.tsx'), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } } } });
  const compiled = new Module(path.join(__dirname, 'translator-inspector-messages.cjs'), module); compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id); GameDetails = compiled.exports.GameDetails.type;
});
function component(t, engine, name, moduleName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-inspector-message-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22); pe.bytes.write('Wine builtin DLL\0', 64);
  fs.writeFileSync(path.join(root, moduleName + '.dll'), pe.bytes);
  return Description.describeTranslator(root, { id: name, engine, version: 'fixture', source: 'UI fixture' });
}
function elements(tree) { return React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)] : []; }
function markup(t, entry, manifest, status) {
  const state = createLibraryFixture(), g = { ...state.recents[0], ...entry, moduleId: manifest.id, moduleSupports: manifest.supports, moduleRuntimeSupport: manifest.runtime.supported };
  const harness = componentHarness(GameDetails, { g, state, moduleInfo: manifest, actions: new Proxy({}, { get: () => async () => {} }),
    runtimeStatusEntry: status ? { runtimeId: entry.runtimeId, status } : null, moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null });
  t.after(() => harness.close());
  return renderToStaticMarkup(React.createElement(React.Fragment, null, ...elements(harness.render()).filter(node => node.props.className === 'detailRow')));
}

test('actual plan settings and inspector share held-back and missing-choice display messages without mutating saved intent', t => {
  const dxvk = component(t, 'dxvk', 'included-dxvk', 'd3d9'), dxmt = component(t, 'dxmt', 'included-dxmt', 'd3d11');
  const held = Plan.resolvePlan({ runtime: 'crossover' });
  Plan.resolveApiRoles(held, { included: [dxvk], selections: { d3d9: dxvk.id } });
  const heldBefore = structuredClone(held), heldOptions = Plan.apiOptions(held, { included: [dxvk], selections: { d3d9: dxvk.id } });
  const heldOption = heldOptions.translatorD3D9Options.find(option => option.value === dxvk.id), heldRow = Wine.inspectorRows(held).find(row => row.component === 'd3d9');
  assert.equal(heldOption.heldBack, true); assert.equal(heldRow.reasonCode, 'runtime-global-automatic');
  assert.equal(heldRow.reason, heldOption.notice); assert.equal(heldRow.reason, Plan.fallbackNotice(heldRow.reasonCode));
  assert.deepEqual(held, heldBefore); assert.equal(held.components.d3d9.value, dxvk.id);
  const missingValue = 'translator-fixture:opaque-missing-build';
  const missing = Plan.resolvePlan({ runtime: 'sikarugir', included: [dxmt], selections: { 'd3d-renderer': dxmt.id } });
  Plan.resolveApiRoles(missing, { included: [dxmt], selections: { d3d11: missingValue }, automatic: { d3d11: dxmt } });
  const missingBefore = structuredClone(missing), missingOptions = Plan.apiOptions(missing, { included: [dxmt], selections: { d3d11: missingValue } });
  const missingOption = missingOptions.translatorD3D11Options.find(option => option.value === missingValue), missingRows = Wine.inspectorRows(missing), missingRow = missingRows.find(row => row.component === 'd3d11');
  assert.equal(missingRow.reasonCode, 'missing-choice'); assert.equal(missingRow.selected, Plan.UNAVAILABLE_CHOICE_LABEL);
  assert.equal(missingRow.selected, missingOption.label); assert.equal(missingRow.reason, missingOption.notice);
  assert.equal(missingRow.used, Description.label(dxmt)); assert.equal(JSON.stringify(missingRows).includes(missingValue), false);
  assert.deepEqual(missing, missingBefore); assert.equal(missing.components.d3d11.value, missingValue);
  const Main = require('../src/modules/crossover/main'), entry = { ...createLibraryFixture().recents[0], runtimeId: 'sikarugir', runtimeData: { sikarugir: { translatorRows: missingRows } } };
  assert.equal(markup(t, entry, Main.manifest, { translatorRows: missingRows }).includes(missingValue), false);
  for (const plan of [held, missing]) for (const warning of Plan.fallbackWarnings(plan)) {
    assert.equal(warning.includes('..'), false); assert.equal(warning.includes('retained for this linked selection'), false);
  }
});

test('actual provider status presents legacy recorded fallbacks without parsing prose or replacing historical used labels', async t => {
  const Main = require('../src/modules/crossover/main'), manager = Main.runtimeManagers.find(manager => manager.id === 'crossover');
  t.mock.method(manager, 'resolveSelection', () => ({ ready: false, version: 'unavailable-current-fixture', reason: 'The current fixture is unavailable.' }));
  const legacy = [{ id: 'translatorD3D9', component: 'd3d9', label: 'Direct3D 9', selected: 'Recorded selected renderer', used: 'Recorded actual renderer',
    fallback: true, reason: 'Arbitrary old diagnostic text, intentionally not a recognized message.', future: { retained: true } }];
  const before = structuredClone(legacy), entry = { ...createLibraryFixture().recents[0], runtimeId: 'crossover', runtimeData: { crossover: { translatorRows: legacy } }, runtimeSettings: {} };
  const initial = markup(t, entry, Main.manifest, null);
  assert.ok(initial.includes('Checking…')); assert.equal(initial.includes('Recorded selected renderer'), false, 'recorded rows wait for the status that presents them');
  assert.equal(initial.includes(legacy[0].reason), false);
  const composed = Providers.composeRuntimeProviders({ manifest: { id: 'fixture-engine', runtime: { supported: [], entries: {} } } }, Main.runtimeProviders);
  const status = await composed.actions.runtimeStatus(entry, {}, { runtimeId: 'crossover', runtimeSettings: {}, settings: {}, userDataDir: os.tmpdir() });
  const row = status.translatorRows[0];
  assert.equal(row.selected, legacy[0].selected); assert.equal(row.used, legacy[0].used); assert.equal(row.reasonCode, 'recorded-fallback');
  assert.equal(row.reason, Plan.fallbackNotice('recorded-fallback')); assert.deepEqual(row.future, legacy[0].future);
  assert.notEqual(row, legacy[0]); assert.deepEqual(legacy, before);
  const rendered = markup(t, entry, Main.manifest, status);
  assert.ok(rendered.includes('Recorded selected renderer → Recorded actual renderer')); assert.ok(rendered.includes(row.reason));
  assert.equal(rendered.includes(legacy[0].reason), false); assert.equal(status.details[0].value, legacy[0].used);
});
