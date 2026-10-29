const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
const { react, componentHarness } = require('./helpers/renderer-component');
const Keys = require('../src/modules/nxnative/prepare');
const { DownloadManager, runDownloadTask } = require('../src/modules/shared/runtime/download-manager');
let RuntimeFileSetting, GameActions, DownloadProgress, RuntimeComponentGroup, RuntimesView;
test.before(async () => {
  async function load(name) {
    const result = await build({ configFile: false, logLevel: 'silent', build: {
      ssr: path.resolve(__dirname, '../src/renderer/src/ui/components/' + name + '.tsx'), write: false,
      rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
    } });
    const compiled = new Module(path.join(__dirname, name + '-compiled.cjs'), module);
    compiled.paths = module.paths;
    compiled.require = id => id === 'react' ? react : Module.prototype.require.call(compiled, id);
    compiled._compile(result.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
    return compiled.exports[name];
  }
  [RuntimeFileSetting, GameActions, DownloadProgress, RuntimeComponentGroup, RuntimesView] = await Promise.all(['RuntimeFileSetting', 'GameActions', 'DownloadProgress', 'RuntimeComponentGroup', 'RuntimesView'].map(load));
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nxnative-onboarding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'prod.keys');
  // Synthetic parser input, not console keys.
  fs.writeFileSync(file, 'example_key = ' + '00'.repeat(16) + '\n');
  return { root, file };
}
function find(node, predicate) {
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props.children)) { const found = find(child, predicate); if (found) return found; }
  return null;
}
test('key registration reports local status, validates picker/drop and leaves the original file in place', async t => {
  const { root, file } = fixture(t), original = fs.readFileSync(file);
  assert.equal(Keys.keysFileStatus().status, 'missing');
  assert.equal(Keys.keysFileStatus({ filePath: root }).status, 'invalid');
  assert.equal(Keys.keysFileStatus({ filePath: file }).status, 'registered');
  assert.doesNotMatch(JSON.stringify(Keys.keysFileStatus({ filePath: file })), /0000000000000000/);
  assert.deepEqual(await Keys.pickKeysFile({ filePaths: [file] }, {}), { filePath: file });
  assert.deepEqual(await Keys.pickKeysFile({ filePaths: [] }, {}), { filePath: null });
  fs.writeFileSync(file, 'not a keys file');
  assert.equal(Keys.keysFileStatus({ filePath: file }).status, 'invalid');
  await assert.rejects(Keys.pickKeysFile({ filePaths: [file] }, {}), /No key = hexadecimal/);
  fs.writeFileSync(file, original);
  let dialog;
  assert.deepEqual(await Keys.pickKeysFile({}, { ui: { dialog: { showOpenDialog: async options => {
    dialog = options; return { canceled: false, filePaths: [file] };
  } } } }), { filePath: file });
  assert.match(dialog.message, /file stays in its current location/);
  assert.deepEqual(fs.readFileSync(file), original);
  fs.unlinkSync(file);
  assert.match(Keys.keysFileStatus({ filePath: file }).reason, /missing/);
});
test('Play key selection explains the requirement, records the existing setting and supports cancellation', async t => {
  const { file } = fixture(t), events = [], patches = [];
  const entry = { moduleData: { keysRequired: true }, runtimeSettings: {} };
  await Keys.chooseKeys(entry, { filePaths: [file] }, { onProgress: value => events.push(value), onEntryChange: value => patches.push(value) });
  assert.equal(entry.runtimeSettings.nxnative.keysPath, file);
  assert.equal(patches[0].runtimeSettings.nxnative.keysPath, file);
  assert.match(events[0].message, /Choose prod.keys to continue/);
  let prompt;
  await Keys.chooseKeys(entry, {}, { ui: { dialog: { showOpenDialog: async options => {
    prompt = options; return { canceled: false, filePaths: [file] };
  } } } });
  assert.match(prompt.message, /Preparation continues after selection/);
  await assert.rejects(Keys.chooseKeys(entry, { filePaths: [] }, {}), { name: 'AbortError' });
});
test('shared file control routes picker/drop through module validation and removes only the registration', async t => {
  const { file } = fixture(t), calls = [], changes = [];
  const props = { field: { key: 'keysPath', type: 'string', label: 'prod.keys', pickerAction: 'pickKeysFile', fileStatusAction: 'keysFileStatus' },
    value: '', disabled: false, request: async (action, payload) => {
      calls.push([action, payload]);
      return action === 'keysFileStatus' ? Keys.keysFileStatus(payload) : Keys.pickKeysFile(payload || { filePaths: [file] }, {});
    }, onChange: async value => { changes.push(value); props.value = value; return true; } };
  const harness = componentHarness(RuntimeFileSetting, props); t.after(() => harness.close());
  harness.render(); let tree = await harness.settle();
  assert.match(renderToStaticMarkup(tree), /Missing/);
  await find(tree, row => row.type === 'button' && row.props.children === 'Choose file…').props.onClick();
  tree = await harness.settle(); tree = await harness.settle();
  assert.deepEqual(changes, [file]); assert.match(renderToStaticMarkup(tree), /Registered/);
  assert.doesNotMatch(renderToStaticMarkup(tree), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  find(tree, row => row.type === 'button' && row.props.children === 'Remove').props.onClick();
  tree = await harness.settle(); tree = await harness.settle();
  assert.equal(changes[1], ''); assert.ok(fs.existsSync(file));
  global.window = { MacLauncher: { launcher: { getPathForFile: () => file } } }; t.after(() => { delete global.window; });
  let stopped = false;
  find(tree, row => row.props.onDrop).props.onDrop({ preventDefault() {}, stopPropagation() { stopped = true; }, dataTransfer: { files: [{}] } });
  await harness.settle(); await harness.settle();
  assert.ok(stopped); assert.deepEqual(calls.findLast(row => row[0] === 'pickKeysFile')[1], { filePaths: [file] });
  assert.equal(changes[2], file);
});
test('shared downloads forward byte percent, component and step while retaining Downloads cancellation', async () => {
  const downloads = new DownloadManager(), seen = [];
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = runDownloadTask(downloads, { label: 'Metal compiler', managerId: 'apple-metal-toolchain' }, async ({ signal, onProgress }) => {
    onProgress({ downloaded: 128, total: 512, detail: 'Downloading compiler…' }); started();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { onProgress: value => seen.push(value) });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); await ready;
  assert.equal(seen[0].percent, 25); assert.equal(seen[0].phase, 'install');
  assert.match(seen[0].label, /Metal compiler/); assert.equal(seen[0].message, 'Downloading compiler…');
  assert.equal(downloads.list()[0].downloaded, 128);
  downloads.cancel(downloads.list()[0].id); await rejected;
});
test('native installer publishes verification and extraction steps through the existing download task', async t => {
  const { root } = fixture(t), archive = Buffer.from('synthetic archive');
  const { createPinnedNativeManager } = require('../src/modules/shared/runtime/pinned-native-manager');
  const downloads = new DownloadManager(), stages = [];
  const runtime = createPinnedNativeManager({ id: 'onboarding-fixture', label: 'Example compiler', supportsDefault: true,
    catalog: [{ version: 'example', upstreamRevision: 'example', asset: { filename: 'example.zip', url: 'https://example.test/example.zip',
      bytes: archive.length, sha256: crypto.createHash('sha256').update(archive).digest('hex') } }],
    resolveExecutable: directory => path.join(directory, 'host'),
    dependencies: { systemVersionSync: () => '26.0', downloadToFile: async (_url, destination, { onProgress }) => {
      fs.writeFileSync(destination, archive); onProgress({ downloaded: archive.length, total: archive.length });
    }, extractArchive: async (_file, destination) => {
      assert.equal(downloads.list()[0].detail, 'Extracting files…');
      const binary = Buffer.alloc(32); binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4); binary.writeUInt32LE(2, 12);
      fs.writeFileSync(path.join(destination, 'host'), binary, { mode: 0o755 });
    } } });
  const installed = await runtime.installRuntime({ userDataDir: root, version: 'example', downloads, onProgress: value => stages.push(value) });
  assert.equal(installed.version, 'example');
  assert.ok(stages.some(row => row.message === 'Checking download…'));
  assert.ok(stages.some(row => row.message === 'Extracting files…' && row.percent === 100));
  assert.ok(stages.every(row => row.phase === 'install'));
  assert.deepEqual(downloads.list(), []);
});
test('Play and Runtimes visibly name the component, byte progress and current step with cancellation', () => {
  const preparation = { phase: 'install', label: 'Installing Metal compiler…', downloaded: 1024, total: 4096, percent: 25, message: 'Downloading compiler…' };
  const play = renderToStaticMarkup(React.createElement(GameActions, { g: { gamePath: '/synthetic', name: 'Example' }, isRunning: false,
    inspector: true, preparation, actions: {} }));
  assert.match(play, /Metal compiler/); assert.match(play, /1.0 KB/); assert.match(play, /25%/); assert.match(play, /Downloading compiler/); assert.match(play, /Cancel Example/);
  const runtime = renderToStaticMarkup(React.createElement(DownloadProgress, { task: { id: 'example', label: 'Metal compiler', detail: 'Extracting compiler…', downloaded: 4096, total: 4096 }, onCancel() {} }));
  assert.match(runtime, /Extracting compiler/); assert.match(runtime, /100%/); assert.match(runtime, /Cancel Metal compiler/);
});
test('component overview keeps advanced controls collapsed and preserves each manager/section action target', t => {
  const choices = ['engine', 'tools', 'compiler'].map((name, index) => ({ id: JSON.stringify([name, 'default']),
    label: name, managerId: name, sectionId: 'default', manager: { id: name }, section: { installed: index ? [] : [{ version: 'example', ready: true }] } }));
  const selections = [], canceled = [];
  const task = { id: 'download', managerId: 'compiler', sectionId: 'default', label: 'Compiler', downloaded: 64, total: 128, detail: 'Downloading…' };
  const props = { enabled: true, label: 'Example runtime', choices, selectedId: choices[0].id, downloads: [task], onSelect: row => selections.push(row), onCancel: id => canceled.push(id), children: React.createElement('div', { key: 'controls' }, 'Existing exact-version controls') };
  const harness = componentHarness(RuntimeComponentGroup, props); t.after(() => harness.close());
  let tree = harness.render(), markup = renderToStaticMarkup(tree);
  assert.match(markup, /<details>/); assert.doesNotMatch(markup, /<details open/);
  assert.match(markup, /downloads ask for approval/); assert.match(markup, /Existing exact-version controls/);
  const manage = find(tree, row => row.type === 'button' && row.props['aria-label'] === 'Manage compiler');
  manage.props.onClick(); tree = harness.render();
  assert.equal(selections[0], choices[2]); assert.match(renderToStaticMarkup(tree), /<details open="">/);
  const progress = find(tree, row => row.type?.name === 'DownloadProgress');
  find(progress.type(progress.props), row => row.type === 'button').props.onClick();
  assert.deepEqual(canceled, ['download']);
  props.enabled = false;
  assert.equal(renderToStaticMarkup(harness.render()), '<div>Existing exact-version controls</div>');
});
test('Runtimes uses the declared shared component layout without changing version or action choices', () => {
  const managers = ['engine', 'tools', 'compiler'].map((id, index) => ({ id, label: id,
    ui: { groupId: 'example-group', tabLabel: 'Example runtime', sectionLabel: id, memberOrder: index, ...(index ? {} : { componentGroup: true }) },
    installed: [], catalog: { versions: ['exact-version'], status: 'success', installable: true } }));
  const offline = () => assert.fail('Viewing components never acquires or refreshes runtimes');
  const markup = renderToStaticMarkup(React.createElement(RuntimesView, { runtimeManagers: managers, runtimeUi: {}, runtimeManagerId: 'engine', runtimeSectionId: 'default',
    downloadTasks: [{ id: 'example', managerId: 'compiler', sectionId: 'default', label: 'Compiler', detail: 'Extracting files…', downloaded: 256, total: 256 }],
    setRuntimeManagerId() {}, setRuntimeSectionId() {}, updateRuntimeUiSection() {}, onRuntimeRefresh: offline, onRuntimeInstall: offline,
    onRuntimeSetDefault: offline, onRuntimeUninstall: offline, onCancelDownload() {} }));
  assert.match(markup, /Example runtime components/); assert.match(markup, /<details>/); assert.doesNotMatch(markup, /<details open/);
  assert.doesNotMatch(markup, /role="tab"/);
  assert.match(markup, /Extracting files…/); assert.match(markup, /Cancel Compiler/);
  assert.match(markup, /value="exact-version"/);
  for (const name of ['engine', 'tools', 'compiler']) assert.match(markup, new RegExp('Manage ' + name));
});
