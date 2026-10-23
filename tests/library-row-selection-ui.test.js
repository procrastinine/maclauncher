const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { build } = require('vite');
const Module = require('node:module');
const { createLibraryFixture } = require('./library-layout-fixture');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
let GameRow;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, 'library-layout-components.tsx'), write: false,
    rollupOptions: { output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, 'row-selection-components.cjs'), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  GameRow = compiled.exports.GameRow;
});
function row(options = {}) {
  const fixture = createLibraryFixture();
  const calls = [];
  const props = { g: fixture.recents[0], moduleInfo: fixture.modules[0], moduleSettings: fixture.moduleSettings,
    runtimeDefaults: fixture.runtimeDefaults, isRunning: false, showIcons: true, showNonDefaultTags: true,
    selected: true, dragging: false, dragDisabled: false, favorite: false,
    actions: { onToggleSelection: (...args) => calls.push(['toggle', ...args]) },
    onSelect: (...args) => calls.push(['inspect', ...args]), onDragStart() {}, onDragEnd() {}, ...options };
  return { element: GameRow.type(props), calls, props };
}
function event(interactive = false, modifiers = {}) {
  return { target: { closest: () => interactive ? {} : null }, metaKey: false, shiftKey: false, ...modifiers };
}

test('full row background selects details while embedded controls do not trigger row selection', () => {
  const { element, calls, props } = row();
  element.props.onClick(event(false));
  assert.deepEqual(calls, [['inspect', props.g.gamePath]]);
  calls.length = 0;
  element.props.onClick(event(true));
  assert.deepEqual(calls, []);
  const identity = element.props.children.props.children.find(child => child?.props?.className === 'gameSelect');
  identity.props.onClick(event(true));
  element.props.onClick(event(true));
  assert.deepEqual(calls, [['inspect', props.g.gamePath]], 'identity button must activate only once');
});

test('row padding and identity preserve Cmd and Shift selection without changing the inspector', () => {
  const { element, calls, props } = row({ selectionMode: true });
  element.props.onClick(event(false, { shiftKey: true }));
  assert.deepEqual(calls, [['toggle', props.g.gamePath, true]]);
  const cmd = row();
  cmd.element.props.onClick(event(false, { metaKey: true, shiftKey: true }));
  assert.deepEqual(cmd.calls, [['inspect', cmd.props.g.gamePath, { toggleSelection: true, range: true }]]);
  const busy = row({ selectionMode: true, selectionDisabled: true });
  busy.element.props.onClick(event(false));
  assert.deepEqual(busy.calls, []);
  const identity = busy.element.props.children.props.children.find(child => child?.props?.className === 'gameSelect');
  assert.equal(identity.props.disabled, true);
});

test('clicking the same game closes and reopens the inspector while another game opens it', () => {
  const model = pathToFileURL(path.resolve(__dirname, '../src/renderer/src/ui/components/game-row-selection-model.ts')).href;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { nextInspectorSelection } = await import(${JSON.stringify(model)});
    let selection = nextInspectorSelection(null, false, '/a');
    assert.deepEqual(selection, { selectedGamePath: '/a', inspectorOpen: true });
    selection = nextInspectorSelection(selection.selectedGamePath, selection.inspectorOpen, '/a');
    assert.deepEqual(selection, { selectedGamePath: '/a', inspectorOpen: false });
    selection = nextInspectorSelection(selection.selectedGamePath, selection.inspectorOpen, '/a');
    assert.equal(selection.inspectorOpen, true);
    assert.deepEqual(nextInspectorSelection('/a', false, '/b'), { selectedGamePath: '/b', inspectorOpen: true });
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
