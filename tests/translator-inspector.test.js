const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), Module = require('node:module');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), { build } = require('vite');
const { react, componentHarness } = require('./helpers/renderer-component');
const { createLibraryFixture } = require('./library-layout-fixture');
const manifest = require('../src/modules/crossover/manifest.json');
const Description = require('../src/modules/shared/runtime/translator-description');
const Plan = require('../src/modules/shared/runtime/translator-plan');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const Providers = require('../src/modules/shared/runtime/providers');

let GameDetails, inspector;
async function compile(file, name) {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: { ssr: path.join(__dirname, '../src/renderer/src/ui/components', file), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } } } });
  const compiled = new Module(path.join(__dirname, name + '.cjs'), module); compiled.paths = module.paths;
  compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id); return compiled.exports;
}
test.before(async () => {
  const values = await Promise.all([compile('GameDetails.tsx', 'translator-inspector-details'), compile('runtime-inspector-model.ts', 'translator-inspector-model')]);
  GameDetails = values[0].GameDetails.type; inspector = values[1];
});
function elements(tree) { return React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)] : []; }
function rowsFor(runtime) {
  const component = (id, component, engine, version) => Description.description({ id, component, engine, version, form: 'builtin', source: 'Fixture source', files: [] });
  const selected = component('requested', 'd3d-renderer', 'dxmt', 'requested'), used = component('included', 'd3d-renderer', 'dxmt', 'included');
  const driver = component('driver', 'vulkan-driver', 'kosmickrisp', 'driver'), video = component('codecs', 'video', 'gstreamer', 'codec');
  const plan = Plan.projectRoles(Plan.resolvePlan({ runtime, selections: { 'd3d-renderer': selected.id, 'vulkan-driver': driver.id, video: video.id },
    included: [used], choices: [selected, driver, video], compatibility: { [selected.id]: { compatible: false, reason: 'Required fixture symbol is absent.' } } }));
  const rows = Translators.inspectorRows(plan);
  rows[0] = { ...rows[0], selected: 'Automatic', used: 'Automatic', fallback: true, reason: 'Identical choices need no reason.' };
  return rows;
}
function propsFor(runtime, runtimeData = {}) {
  const state = createLibraryFixture(), g = { ...state.recents[0], moduleId: manifest.id, moduleLabel: manifest.label, runtimeId: runtime,
    moduleSupports: manifest.supports, moduleRuntimeSupport: manifest.runtime.supported, runtimeData, moduleData: {} };
  state.modules = [manifest]; state.moduleSettings = { [manifest.id]: {} }; state.moduleStates = { [manifest.id]: {} };
  const props = { g, state, moduleInfo: manifest, actions: new Proxy({}, { get: () => async () => {} }),
    runtimeStatusEntry: null, moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null };
  return props;
}
function renderRows(t, props) {
  const harness = componentHarness(GameDetails, props); t.after(() => harness.close());
  const rows = elements(harness.render()).filter(node => node.props.className === 'detailRow');
  const markup = renderToStaticMarkup(React.createElement(React.Fragment, null, ...rows));
  return { rows, markup };
}

test('both real runtime entries declare inspector status across provider composition and explicit Wine version choices', async t => {
  const Main = require('../src/modules/crossover/main');
  const composed = Providers.composeRuntimeProviders({ manifest: { id: 'fixture-engine', runtime: { supported: ['native'], entries: { native: { label: 'Native' } } } } }, Main.runtimeProviders);
  for (const runtime of manifest.runtime.supported) {
    const props = propsFor(runtime), game = { ...props.g, runtimeData: { [runtime]: { version: 'explicit-installed-version' } } };
    assert.equal(manifest.runtime.entries[runtime].statusAction, 'runtimeStatus');
    assert.equal(inspector.runtimeInspectorStatusAction(manifest, runtime, game, null), 'runtimeStatus');
    assert.equal(inspector.runtimeInspectorStatusAction(composed.manifest, runtime, game, null), 'runtimeStatus');
    assert.equal(typeof composed.actions?.runtimeStatus, 'function');
  }
  assert.equal(manifest.runtime.preLaunch, undefined, 'inspector status does not add a Play readiness check');
  const legacy = structuredClone(manifest); delete legacy.runtime.entries.crossover.statusAction;
  legacy.runtime.preLaunch = { crossover: { statusAction: 'legacyStatus' } };
  const game = propsFor('crossover').g;
  assert.equal(inspector.runtimeInspectorStatusAction(legacy, 'crossover', game, null), 'legacyStatus');
  assert.equal(inspector.runtimeInspectorStatusAction(legacy, 'crossover', { ...game, runtimeData: { crossover: { version: 'explicit' } } }, null), null);
});

test('actual provider status rows render selected to used for every API, Vulkan and video without duplicate generic details', async t => {
  const Main = require('../src/modules/crossover/main');
  const composed = Providers.composeRuntimeProviders({ manifest: { id: 'fixture-engine', runtime: { supported: [], entries: {} } } }, Main.runtimeProviders);
  for (const runtime of manifest.runtime.supported) {
    const manager = Main.runtimeManagers.find(manager => manager.id === runtime);
    t.mock.method(manager, 'resolveSelection', () => ({ ready: false, version: 'unavailable-fixture', reason: 'Fixture runtime is not installed.' }));
    const rows = rowsFor(runtime), props = propsFor(runtime, { [runtime]: { translatorRows: rows } });
    const status = await composed.actions.runtimeStatus(props.g, {}, { runtimeId: runtime, runtimeSettings: {}, settings: {}, userDataDir: '/private/tmp/unused-translator-inspector-profile' });
    assert.deepEqual(status.translatorRows, rows);
    props.runtimeStatusEntry = { runtimeId: runtime, status: { ...status, details: [...status.details,
      { label: 'Camera adapter', value: 'Unavailable', detail: 'Camera fixture notice.' }] } };
    const rendered = renderRows(t, props);
    for (const row of rows) {
      const labelRows = rendered.rows.filter(node => elements(node).some(child => child.props.className === 'detailLabel' && child.props.children === row.label));
      assert.equal(labelRows.length, 1, row.label + ' appears once');
      const value = elements(labelRows[0]).find(child => child.props.className === 'detailValue');
      assert.equal(React.Children.toArray(value.props.children).filter(child => typeof child === 'string').join(''), row.selected + ' → ' + row.used);
      assert.ok(renderToStaticMarkup(labelRows[0]).includes(' → '));
    }
    assert.ok(rendered.markup.includes('Required fixture symbol is absent.'));
    assert.equal(rendered.markup.includes('Identical choices need no reason.'), false);
    assert.ok(rendered.markup.includes('Camera fixture notice.'));
    assert.deepEqual(rows.map(row => row.component), ['d3d8', 'd3d9', 'd3d10', 'd3d11', 'd3d12', 'vulkan-driver', 'video']);
  }
});

test('last-launch translator rows remain visible before status arrives and stale other-runtime status cannot replace them', t => {
  for (const runtime of manifest.runtime.supported) {
    const saved = rowsFor(runtime), props = propsFor(runtime, { [runtime]: { translatorRows: saved } });
    const initial = renderRows(t, props).markup; assert.ok(initial.includes('requested')); assert.ok(initial.includes(' → '));
    props.runtimeStatusEntry = { runtimeId: runtime === 'crossover' ? 'sikarugir' : 'crossover', status: { translatorRows: [{ label: 'Wrong runtime', selected: 'Wrong', used: 'Wrong' }] } };
    assert.equal(renderRows(t, props).markup.includes('Wrong runtime'), false);
    props.runtimeStatusEntry = { runtimeId: runtime, status: { translatorRows: [{ id: 'fresh', label: 'Fresh status', selected: 'New selection', used: 'New used', reason: 'Actual new reason.' }] } };
    const current = renderRows(t, props).markup;
    assert.ok(current.includes('New selection → New used')); assert.ok(current.includes('Actual new reason.'));
    assert.equal(current.includes('Required fixture symbol is absent.'), false);
  }
});
