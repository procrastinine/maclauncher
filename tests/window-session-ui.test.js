const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const Module = require('node:module'), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite'), { react, componentHarness } = require('./helpers/renderer-component');
const { createLibraryFixture } = require('./library-layout-fixture');
let GameRow, GameDetails, GraphicsShortcutSettings;
const elements = tree => React.isValidElement(tree) ? [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)] : [];
test.before(async () => {
  async function load(file) {
    const result = await build({ configFile: false, logLevel: 'silent', build: { ssr: path.join(__dirname, '../src/renderer/src/ui/components/' + file), write: false,
      rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs' } } } });
    const compiled = new Module(path.join(__dirname, file + '.cjs'), module);compiled.paths = module.paths;
    compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
    compiled._compile(result.output.find(chunk => chunk.type === 'chunk').code, compiled.id);return compiled.exports;
  }
  ({ GameRow } = await load('GameRow.tsx'));({ GameDetails } = await load('GameDetails.tsx'));({ GraphicsShortcutSettings } = await load('GraphicsShortcutSettings.tsx'));
});
const targets = [{ id: 'w1', label: 'Notes.txt', detail: 'TextEdit' }, { id: 'd1', label: 'Built-in Retina Display', detail: 'Display' }];
test('session library rows show targets instead of the temporary folder; ordinary paths remain', () => {
  const base = createLibraryFixture().recents[0];
  const render = game => renderToStaticMarkup(React.createElement(GameRow, { g: game, moduleInfo: null, moduleSettings: {}, runtimeDefaults: {},
    isRunning: true, showIcons: false, showNonDefaultTags: false, selected: false, dragging: false, dragDisabled: true, favorite: false, actions: {} }));
  const session = render({ ...base, gamePath: '/private/session-folder', ephemeral: true, sessionTargets: targets });
  assert.match(session, /class="gameRowPath" title="Notes.txt \(TextEdit\) · Built-in Retina Display \(Display\)"/);
  assert.doesNotMatch(session, /class="mono gameRowPath"/);
  const ordinary = render({ ...base, gamePath: '/games/ordinary-game' });assert.match(ordinary, /class="mono gameRowPath"/);assert.match(ordinary, /ordinary-game/);
  const pending = render({ ...base, ephemeral: true, gamePath: '/private/session-folder', sessionTargets: [] });
  assert.ok(pending.includes('title="' + base.name + '"'));assert.doesNotMatch(pending, /class="mono gameRowPath"/);
});
test('inspector keyboard shortcuts sit outside Applied to, with pointer action, shared names and help', t => {
  const state = createLibraryFixture(), moduleInfo = require('../src/modules/window/manifest.json');
  const props = { g: { ...state.recents[0], ephemeral: true, sessionTargets: targets }, state, moduleInfo,
    actions: new Proxy({}, { get: () => async () => {} }), moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null };
  const harness = componentHarness(GameDetails.type, props);t.after(() => harness.close());
  let nodes = elements(harness.render()), shortcut = nodes.find(node => node.type?.name === 'SessionShortcut');
  const applied = nodes.find(node => node.type?.name === 'SessionTargets');
  assert.ok(shortcut);assert.ok(nodes.indexOf(shortcut) < nodes.indexOf(applied));
  let markup = renderToStaticMarkup(shortcut);
  assert.equal((markup.match(/title="Assign in Settings…"/g) || []).length, 2);
  assert.match(markup, /Keyboard shortcut/);assert.match(markup, /Toggle graphics for front app/);assert.match(markup, /Toggle pointer in window graphics/);
  assert.match(markup, /aria-label="About Toggle graphics for front app"/);assert.match(markup, /does not change the saved Show pointer/);
  assert.doesNotMatch(renderToStaticMarkup(applied), /Keyboard shortcut|Assign in Settings/);
  state.launcherSettings.graphicsShortcuts = { windowGraphics: 'Control+Option+Command+G', windowPointer: 'Control+Option+Command+P' };
  nodes = elements(harness.render());shortcut = nodes.find(node => node.type?.name === 'SessionShortcut');markup = renderToStaticMarkup(shortcut);
  assert.match(markup, /<kbd>⌃⌥⌘G<\/kbd>/);assert.match(markup, /<kbd>⌃⌥⌘P<\/kbd>/);assert.doesNotMatch(markup, /title="Assign in Settings…"/);
});
test('window shortcut Settings rows expose help for both declared actions', async t => {
  const actions = [{ action: 'windowGraphics', label: 'Toggle graphics for front app', accelerator: null },
    { action: 'windowPointer', label: 'Toggle pointer in window graphics', accelerator: null }];
  const harness = componentHarness(GraphicsShortcutSettings, { settings: {}, api: { getGraphicsShortcuts: async () => actions }, onSetLauncherSettings() {} });
  t.after(() => harness.close());harness.render();await harness.settle();
  const markup = renderToStaticMarkup(harness.render());
  assert.match(markup, /aria-label="About Toggle graphics for front app"/);assert.match(markup, /aria-label="About Toggle pointer in window graphics"/);
  assert.match(markup, /drawn pointer/);assert.match(markup, /frontmost app/);
});
