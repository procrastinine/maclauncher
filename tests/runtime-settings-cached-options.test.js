const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), Module = require('node:module');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
const { createLibraryFixture } = require('./library-layout-fixture');
let choices, RuntimeSettingsWindow;

async function compile(relative) {
  const bundled = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, '..', relative), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'cached-options-' + path.basename(relative) + '.cjs'), module);
  compiled.paths = module.paths; compiled._compile(bundled.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  return compiled.exports;
}
test.before(async () => {
  [choices, { RuntimeSettingsWindow }] = await Promise.all([
    compile('src/renderer/src/ui/components/runtime-setting-choices.ts'),
    compile('src/renderer/src/ui/components/RuntimeSettingsWindow.tsx')
  ]);
});
function storage(t) {
  const previous = global.window, values = new Map();
  const localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)) };
  global.window = { localStorage };
  t.after(() => { if (previous === undefined) delete global.window; else global.window = previous; });
  return { values, localStorage };
}
function fixture() {
  const state = createLibraryFixture(), values = { left: 'opaque:prepared-component', right: '' };
  const fields = ['left', 'right'].map(key => ({ key, type: 'select', label: key + ' choice', optionsAction: 'localChoices',
    optionsKey: key + 'Options', options: [{ value: '', label: 'Automatic' }] }));
  const schema = { defaults: values, fields, visibilityAction: 'localChoices' };
  state.modules[0].runtime.entries.managed.settings = schema;
  state.moduleSettings.fixture.runtimeSettings = { managed: values };
  const context = { scope: 'module', moduleId: 'fixture', runtimeId: 'managed' };
  const inputs = { environmentReference: undefined, runtimeSettings: values };
  const option = { value: values.left, label: 'Prepared component 3', runtimeSettingsPatch: { left: values.left, right: values.left } };
  const result = { leftOptions: [{ value: '', label: 'Automatic' }, option], rightOptions: [{ value: '', label: 'Automatic' }, option],
    translatorRoles: [{ id: 'declared-role', settingsKey: 'left', optionsKey: 'leftOptions', groupId: 'shared' }],
    translatorGroups: [{ id: 'shared', label: 'Shared libraries', reason: 'Declared provider scope.' }], futureMetadata: { publisher: 'retained' } };
  return { state, context, inputs, fields, result };
}
function render(fixture) {
  let requested = 0, written = 0;
  const api = { moduleSettingsAction: async () => { requested++; return new Promise(() => {}); },
    setModuleRuntimeSettings: async () => { written++; }, setGameRuntimeSettings: async () => { written++; } };
  const markup = renderToStaticMarkup(React.createElement(RuntimeSettingsWindow, { api, state: fixture.state, context: fixture.context, error: null }));
  return { markup, requested, written };
}
function select(markup, label) {
  const found = [...markup.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)].map(match => match[0]).find(block => block.includes('aria-label="' + label + '"'));
  assert.ok(found, label + ' exists'); return found;
}
function receive(fixture, result) {
  return new Promise((resolve, reject) => choices.loadSettingChoices(['localChoices'], async () => result,
    (action, groups) => choices.storeSettingChoices(fixture.context, fixture.inputs, action, groups),
    (_action, error) => reject(error), resolve, fixture.fields));
}

test('a new settings render synchronously uses persistent provider choices, labels and atomic metadata', async t => {
  storage(t); const data = fixture(); await receive(data, data.result);
  // The component and writer have separately bundled copies of the helper: this
  // result comes from persistent browser storage, rather than a module Map.
  const first = render(data), control = select(first.markup, 'left choice');
  assert.equal(first.requested, 0); assert.equal(first.written, 0);
  assert.match(control, /selected="">Prepared component 3<\/option>/);
  assert.doesNotMatch(control, /\bdisabled=/);
  assert.match(select(first.markup, 'right choice'), /Prepared component 3/);
  const restored = choices.readSettingChoices(data.context, data.inputs, data.fields).localChoices;
  assert.deepEqual(restored, data.result);
  assert.deepEqual(restored.leftOptions[1].runtimeSettingsPatch, { left: data.inputs.runtimeSettings.left, right: data.inputs.runtimeSettings.left });

  data.state.moduleSettings.fixture.runtimeSettings.managed = { ...data.inputs.runtimeSettings, right: data.inputs.runtimeSettings.left };
  const changed = render(data), changedControl = select(changed.markup, 'left choice');
  assert.match(changedControl, /selected="">Prepared component 3<\/option>/, 'a prior provider label remains descriptive when request inputs change');
  assert.match(changedControl, />Automatic<\/option>/);
  assert.doesNotMatch(changedControl, /\bdisabled=/);
  assert.deepEqual(choices.readSettingChoices(data.context, { ...data.inputs, runtimeSettings: { ...data.inputs.runtimeSettings, right: data.inputs.runtimeSettings.left } }, data.fields), {},
    'different inputs do not reuse stale selectable groups or atomic patches');
});

test('without cached lists, the recorded launch of a game names its saved choices instead of a loading placeholder', t => {
  storage(t); const data = fixture(), game = data.state.recents[0];
  Object.assign(game, { moduleId: 'fixture', runtimeId: 'managed', runtimeSettings: { managed: data.inputs.runtimeSettings },
    runtimeData: { managed: { translatorPlanInputs: { settings: { left: data.inputs.runtimeSettings.left, right: 'opaque:other' } },
      translatorRows: [{ id: 'left', label: 'left choice', selected: 'Recorded component 3', used: 'Recorded component 3' },
        { id: 'right', label: 'right choice', selected: 'Other recorded component', used: 'Other recorded component' }] } } });
  data.context = { scope: 'game', moduleId: 'fixture', runtimeId: 'managed', gamePath: game.gamePath };
  const rendered = render(data);
  assert.match(select(rendered.markup, 'left choice'), /selected="">Recorded component 3<\/option>/);
  assert.doesNotMatch(rendered.markup, /Loading saved selection/);
  assert.doesNotMatch(rendered.markup, /Other recorded component/, 'a recorded row names only the value it was recorded for');
});

test('canceled and invalid refreshes preserve cached choices, report only real failure and permit successful recovery', async t => {
  storage(t); const data = fixture(); await receive(data, data.result);
  let finish; const failures = [], diagnostics = [];
  t.mock.method(console, 'warn', (...args) => diagnostics.push(args));
  const settled = new Promise(resolve => choices.loadSettingChoices(['localChoices'], () => new Promise(done => { finish = done; }),
    (action, groups) => choices.storeSettingChoices(data.context, data.inputs, action, groups),
    (action, error) => failures.push({ action, message: error.message }), resolve, data.fields));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(choices.readSettingChoices(data.context, data.inputs, data.fields).localChoices, data.result);
  assert.doesNotMatch(select(render(data).markup, 'left choice'), /\bdisabled=/);
  finish(false); await settled;
  assert.deepEqual(failures, [], 'the IPC cancellation sentinel is a settled refresh');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(choices.readSettingChoices(data.context, data.inputs, data.fields).localChoices, data.result);
  await new Promise(resolve => choices.loadSettingChoices(['localChoices'], async () => true,
    (action, groups) => choices.storeSettingChoices(data.context, data.inputs, action, groups),
    (action, error) => failures.push({ action, message: error.message }), resolve, data.fields));
  assert.deepEqual(failures, [{ action: 'localChoices', message: 'Local setting choices are unavailable.' }]);
  assert.deepEqual(diagnostics, [['Local setting choice response is unavailable.', { action: 'localChoices', responseType: 'boolean' }]]);
  assert.deepEqual(choices.readSettingChoices(data.context, data.inputs, data.fields).localChoices, data.result);
  const replacement = { ...data.result, leftOptions: [{ value: data.inputs.runtimeSettings.left, label: 'Refreshed component 4', runtimeSettingsPatch: { left: data.inputs.runtimeSettings.left } }] };
  await receive(data, replacement);
  assert.match(select(render(data).markup, 'left choice'), /selected="">Refreshed component 4<\/option>/);
});

test('cache scope and inputs stay isolated and missing or unavailable storage keeps static choices editable', async t => {
  const { values, localStorage } = storage(t), data = fixture();
  const cold = select(render(data).markup, 'left choice');
  assert.match(cold, />Automatic<\/option>/); assert.doesNotMatch(cold, /\bdisabled=/);
  await receive(data, data.result);
  for (const context of [{ ...data.context, runtimeId: 'other' }, { ...data.context, moduleId: 'other' },
    { ...data.context, scope: 'game', gamePath: '/fixture/one' }, { ...data.context, scope: 'game', gamePath: '/fixture/two' }])
    assert.deepEqual(choices.readSettingChoices(context, data.inputs, data.fields), {});
  assert.equal(values.size, 1);
  choices.storeSettingChoices(data.context, { runtimeSettings: { different: true } }, 'otherProvider', { otherOptions: [{ value: '', label: 'Other provider' }] });
  assert.deepEqual(choices.readSettingChoices(data.context, data.inputs, data.fields).localChoices, data.result,
    'an independent provider with different inputs does not erase the last successful choice action');
  const key = [...values.keys()][0]; values.set(key, '{unfinished cache');
  assert.doesNotThrow(() => render(data));
  await receive(data, data.result);
  assert.deepEqual(choices.readSettingChoices(data.context, data.inputs, data.fields).localChoices, data.result, 'a successful provider replaces an incomplete disposable cache');
  localStorage.getItem = () => { throw new Error('storage unavailable'); };
  localStorage.setItem = () => { throw new Error('storage unavailable'); };
  assert.doesNotThrow(() => choices.storeSettingChoices(data.context, data.inputs, 'localChoices', data.result));
  assert.doesNotMatch(select(render(data).markup, 'left choice'), /\bdisabled=/);
});
