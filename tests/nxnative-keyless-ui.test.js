const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const test = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { build } = require('vite');
const Modules = require('../src/modules/registry');
const { userImportError } = require('../src/core/import-error');
const { entryModuleLabels } = require('../src/core/entry-labels');
const { normalizeRuntimeSettings, resolveRuntimeSettingsSchema, resolveModuleRuntimeSettings, resolveRuntimeSettingsForEntry } = require('../src/core/runtime-settings');
const { createLibraryFixture } = require('./library-layout-fixture');
const Nxnative = require('../src/modules/nxnative/main');
const Settings = require('../src/modules/nxnative/settings');
const Prepare = require('../src/modules/nxnative/prepare');

// Synthetic metadata only: an NPDM header with a fixture title ID, empty RomFS
// folders and a NUP whose one file is that header. No game data, keys or firmware.
const TITLE = 0x0100000000010000n;
function npdm(id) {
  const b = Buffer.alloc(0x98);
  b.write('META'); b.writeUInt32LE(0x80, 0x70); b.writeUInt32LE(24, 0x74); b.write('ACI0', 0x80); b.writeBigUInt64LE(id, 0x90);
  return b;
}
function nup(file, id) {
  const names = Buffer.from('exefsromfsmain.npdm'), slots = 48 + 64 + 3 * 24 + 80, pool = slots + 3 * 4, t = Buffer.alloc(pool + names.length);
  t.write('TOC'); t[3] = 1; t.writeUInt32LE(1, 4); t.writeBigUInt64LE(3n, 8); t.writeBigUInt64LE(1n, 16); t.writeBigUInt64LE(BigInt(pool), 24); t.writeBigUInt64LE(BigInt(names.length), 32);
  const blob = Math.ceil((128 + t.length) / 16) * 16, main = npdm(id), dir = 112, entry = dir + 72;
  t.writeBigUInt64LE(id, 48); t.writeUInt32LE(0, 56); t.writeUInt32LE(1, 60); t.writeUInt32LE(2, 64);
  t.writeUInt32LE(0, dir + 8); t.writeUInt32LE(2, dir + 12);
  t.writeUInt32LE(0, dir + 24); t.writeUInt32LE(5, dir + 28); t.writeUInt32LE(2, dir + 32); t.writeUInt32LE(1, dir + 36);
  t.writeUInt32LE(5, dir + 48); t.writeUInt32LE(5, dir + 52); t.writeUInt32LE(3, dir + 56);
  t.writeUInt32LE(10, entry); t.writeUInt32LE(9, entry + 4); t.writeBigUInt64LE(BigInt(main.length), entry + 8);
  t.writeBigUInt64LE(BigInt(blob), entry + 16); t.writeBigUInt64LE(BigInt(main.length), entry + 24);
  crypto.createHash('sha256').update(main).digest().copy(t, entry + 32);
  [1, 2, 3].forEach((n, i) => t.writeUInt32LE(n, slots + i * 4)); names.copy(t, pool);
  const h = Buffer.alloc(128);
  h.write('NUP'); h[3] = 1; h.writeUInt16LE(128, 4); h.writeBigUInt64LE(128n, 8); h.writeBigUInt64LE(BigInt(t.length), 16);
  h.writeBigUInt64LE(BigInt(blob), 56); h.writeBigUInt64LE(BigInt(blob + main.length), 64); h.writeUInt32LE(1, 72);
  crypto.createHash('sha256').update(t).digest().copy(h, 24);
  const all = Buffer.alloc(blob + main.length); h.copy(all); t.copy(all, 128); main.copy(all, blob);
  fs.writeFileSync(file, all);
  return file;
}
function dump(root, id, { romfs = true, updates = [] } = {}) {
  fs.mkdirSync(path.join(root, 'base/exefs'), { recursive: true });
  if (romfs) fs.mkdirSync(path.join(root, 'base/romfs'));
  fs.writeFileSync(path.join(root, 'base/exefs/main.npdm'), npdm(id));
  for (const version of updates) {
    fs.mkdirSync(path.join(root, 'updates', String(version), 'exefs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'updates', String(version), 'romfs'));
    fs.writeFileSync(path.join(root, 'updates', String(version), 'exefs/main.npdm'), npdm(id));
  }
  return root;
}
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nxnative-keyless-ui-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function component(name) {
  const bundle = await build({ configFile: false, logLevel: 'silent', build: {
    ssr: path.join(__dirname, `../src/renderer/src/ui/components/${name}.tsx`), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: 'cjs', codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, `nxnative-keyless-${name}.cjs`), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === 'chunk').code, compiled.id);
  return compiled.exports[name];
}
const info = () => Modules.getModuleInfo('nxnative');
const keylessData = (inputPath, extra = {}) => ({ format: 'nup', sourceKind: 'Switch NUP', inputPath, titleId: '0100000000010000',
  versions: ['v0', 'v65536'], selectedUpdate: 'v65536', generation: null, keyRequirement: 'none', keysRequired: false, inspectionOnly: false, ...extra });
// A library row as the main process presents it.
function libraryEntry(moduleData, extra = {}) {
  const entry = { gameId: 'keyless-example', gamePath: moduleData.inputPath, name: 'Keyless Example', moduleId: 'nxnative', runtimeId: 'nxnative',
    gameType: 'switch', runtimeSettings: {}, runtimeData: {}, moduleData, ...extra };
  const labels = entryModuleLabels(info(), entry);
  return { ...entry, moduleLabel: labels.label, moduleShortLabel: labels.shortLabel, moduleFamily: info().family,
    moduleRuntimeSupport: ['nxnative'], moduleSupports: { launch: true, saveLocation: true } };
}
// A fake nxnative command line that records its arguments and writes the
// events and launch file a preparation produces, or the error it reports.
function fakeRuntime(root, outcome) {
  const host = path.join(root, 'host'); fs.writeFileSync(host, 'fixture');
  const calls = [];
  const runCommand = async (_command, args, options) => {
    calls.push(args);
    if (outcome.error) {
      fs.writeFileSync(options.logPath, JSON.stringify({ ev: 'error', ...outcome.error }) + '\n');
      throw Object.assign(new Error('nxnative exited'), { exitCode: outcome.exitCode });
    }
    const out = args[args.indexOf('--output') + 1];
    fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'fixture.elf'), 'fixture');
    fs.writeFileSync(path.join(out, 'launch.json'), JSON.stringify({ schemaVersion: 1, command: host, args: [path.join(out, 'fixture.elf')], cwd: out, env: {},
      inputFacts: outcome.inputFacts }));
    fs.writeFileSync(options.logPath, JSON.stringify({ ev: 'prepared', launchFile: path.join(out, 'launch.json') }) + '\n');
  };
  return { calls, runCommand, selection: { runtime: { root, host, cli: host, config: { runtimeFiles: {}, capabilities: { keylessInputs: ['nup', 'dump'], packageSelection: true } } },
    version: 'fixture', install: { manifestSha256: 'fixture' } } };
}

test('Add, Open and drop accept NUP files and keyless dump folders', async t => {
  const root = temp(t);
  assert.ok(Modules.listSupportedInputExtensions().includes('nup'), 'the open panel offers NUP files');
  const file = nup(path.join(root, 'Example.nup'), TITLE);
  const folder = dump(path.join(root, 'Example dump'), TITLE + 0x10000n, { updates: [65536] });
  fs.mkdirSync(path.join(root, 'Folder with NUP')); nup(path.join(root, 'Folder with NUP', 'Game.nup'), TITLE);
  // Unreadable package metadata still imports as a NUP; nxnative checks the file during Play.
  const header = Buffer.alloc(128); header.set([78, 85, 80, 1]); fs.writeFileSync(path.join(root, 'Unreadable.nup'), header);
  for (const [input, format, titleId, versions] of [[file, 'nup', '0100000000010000', ['v0']], [folder, 'dump', '0100000000020000', ['v0', 'v65536']],
    [path.join(root, 'Folder with NUP'), 'nup', '0100000000010000', ['v0']], [path.join(root, 'Unreadable.nup'), 'nup', null, []]]) {
    const detected = await Modules.detectGameAsync(input, { workerMode: 'inline' });
    assert.deepEqual([detected.moduleId, detected.runtimeId, detected.moduleData.format, detected.moduleData.titleId, detected.moduleData.versions,
      detected.moduleData.keyRequirement, detected.moduleData.keysRequired, detected.moduleData.generation],
    ['nxnative', 'nxnative', format, titleId, versions, 'none', false, null], input);
  }
});

test('an incomplete dump names its problem on import, and mixed inputs report more than one game', async t => {
  const root = temp(t);
  const noRomfs = dump(path.join(root, 'Dump without RomFS'), TITLE, { romfs: false });
  const update = dump(path.join(root, 'Dump with partial update'), TITLE, { updates: [65536] });
  fs.rmSync(path.join(update, 'updates/65536/romfs'), { recursive: true });
  for (const [input, message] of [[noRomfs, '“Dump without RomFS” could not be added. Switch dump is missing RomFS.'],
    [update, '“Dump with partial update” could not be added. Update needs matching ExeFS and full RomFS.']]) {
    await assert.rejects(Modules.detectGameAsync(input, { workerMode: 'inline' }), error => {
      assert.equal(error.code, 'DETECTION_INVALID_INPUT');
      assert.equal(userImportError(error, input).message, message);
      return true;
    });
    assert.equal(Modules.explainDetection(input).error.code, 'DETECTION_INVALID_INPUT', 'synchronous detection reports the same problem');
  }
  const mixed = dump(path.join(root, 'Dump with NUP'), TITLE); nup(path.join(mixed, 'Other.nup'), TITLE);
  const pair = path.join(root, 'Two NUPs'); fs.mkdirSync(pair); nup(path.join(pair, 'A.nup'), TITLE); nup(path.join(pair, 'B.nup'), TITLE + 0x10000n);
  for (const input of [mixed, pair]) await assert.rejects(Modules.detectGameAsync(input, { workerMode: 'inline' }), error => {
    assert.equal(error.code, 'DETECTION_CONFLICT');
    assert.match(userImportError(error, input).message, /contains more than one possible game\./);
    return true;
  });
  // A folder without Switch files stays unrecognized.
  fs.mkdirSync(path.join(root, 'Notes')); fs.writeFileSync(path.join(root, 'Notes', 'readme.txt'), 'notes');
  await assert.rejects(Modules.detectGameAsync(path.join(root, 'Notes'), { workerMode: 'inline' }), { code: 'DETECTION_UNSUPPORTED' });
});

test('Play shows the problem nxnative reports for a keyless input and never asks for keys', async t => {
  const root = temp(t), games = path.join(root, 'games'); fs.mkdirSync(games);
  const file = nup(path.join(games, 'Example.nup'), TITLE);
  fs.writeFileSync(path.join(games, 'prod.keys'), 'fixture');
  for (const [exitCode, error, message] of [[1, { message: 'Invalid NUP table.' }, /^Invalid NUP table\. See .+nxnative\.log\.$/],
    [78, { code: 'keys-required', message: 'This package requires a prod.keys file.' }, /^This package requires a prod\.keys file\.$/]]) {
    const runtime = fakeRuntime(root, { exitCode, error });
    let picker = false;
    const entry = { gameId: 'keyless', gamePath: file, contentRootDir: games, moduleData: keylessData(file, { versions: ['v0'], selectedUpdate: 'v0' }),
      runtimeSettings: { nxnative: { keysPath: path.join(games, 'prod.keys') } } };
    const context = { userDataDir: path.join(root, 'data'), runtimeSettings: {}, onEntryChange() {},
      ui: { dialog: { showOpenDialog: async () => { picker = true; return { canceled: true, filePaths: [] }; } } } };
    await assert.rejects(Prepare.prepareGame(entry, context, runtime.selection, { runCommand: runtime.runCommand }), { message });
    assert.equal(runtime.calls.length, 1, 'one preparation, no retry with keys');
    assert.equal(runtime.calls[0].includes('--keys'), false);
    assert.equal(picker, false);
    assert.deepEqual([entry.moduleData.keyRequirement, entry.moduleData.keysRequired], ['none', false]);
  }
});

test('Nintendo Switch 2 is named only from the recorded generation', () => {
  const labels = moduleData => {
    const entry = libraryEntry({ ...keylessData('/Games/Switch 2 [0400000000000000].nup'), ...moduleData }, { name: 'Switch 2 Edition' });
    return [entry.moduleLabel, entry.moduleShortLabel];
  };
  assert.deepEqual(labels({ generation: 2 }), ['Nintendo Switch 2', 'Nintendo Switch 2']);
  // The title ID, file name, game name and format never decide the generation.
  for (const generation of [null, undefined, 1, '2']) assert.deepEqual(labels({ generation, titleId: '0400000000000000' }), ['Nintendo Switch', 'Nintendo Switch'], String(generation));
  assert.deepEqual(entryModuleLabels(info(), { moduleData: { format: 'nsp', generation: 2 } }), { label: 'Nintendo Switch 2', shortLabel: 'Nintendo Switch 2' });
  // Game types without entry labels keep their manifest labels.
  const mv = Modules.getModuleInfo('mv');
  assert.deepEqual(entryModuleLabels(mv, { moduleData: { generation: 2 } }), { label: mv.label, shortLabel: mv.shortLabel });
});

test('library refreshes keep facts that preparation reported for the same title', () => {
  const stored = { moduleData: keylessData('/Games/Example.nup', { generation: 2, selectedUpdate: 'v0' }), runtimeSettings: { nxnative: { packageVersion: 'v0' } } };
  // Detection reports an unknown generation and the newest package.
  const detected = { ...stored, moduleData: { ...stored.moduleData, generation: null, selectedUpdate: 'v65536' } };
  const merged = Nxnative.mergeEntry(stored, detected);
  assert.equal(merged.moduleData.generation, 2);
  assert.equal(merged.moduleData.selectedUpdate, 'v0', 'the update choice stays selected');
  // Another title in the same record starts as the Switch family again.
  assert.equal(Nxnative.mergeEntry(stored, { ...detected, moduleData: { ...detected.moduleData, titleId: '0100000000090000' } }).moduleData.generation, null);
  // A choice whose package is gone shows the newest local package, which Play prepares.
  assert.equal(Nxnative.mergeEntry(stored, { ...detected, runtimeSettings: { nxnative: { packageVersion: 'v9' } } }).moduleData.selectedUpdate, 'v65536');
  // Unreadable NUP metadata keeps the title and update that preparation reported.
  const unreadable = { ...detected, moduleData: { ...detected.moduleData, titleId: null, versions: [], selectedUpdate: null } };
  assert.deepEqual(['titleId', 'generation', 'selectedUpdate'].map(key => Nxnative.mergeEntry(stored, unreadable).moduleData[key]), ['0100000000010000', 2, 'v0']);
  const imported = Nxnative.mergeEntry(null, detected).moduleData;
  assert.deepEqual([imported.generation, imported.selectedUpdate], [null, 'v0']);
});

test('per-game settings hide prod.keys for keyless games and keep it for other Switch inputs', async () => {
  const RuntimeSettingsWindow = await component('RuntimeSettingsWindow');
  const render = (moduleData, scope = 'game') => {
    const g = libraryEntry(moduleData);
    const state = { modules: [info()], recents: [g], settings: {}, runtimeDefaults: {}, moduleSettings: {} };
    const calls = [];
    const api = { setModuleRuntimeSettings() {}, setGameRuntimeSettings() {},
      moduleAction: async (...args) => { calls.push(args[1]); return {}; }, moduleSettingsAction: async (...args) => { calls.push(args[1]); return {}; } };
    const html = renderToStaticMarkup(React.createElement(RuntimeSettingsWindow, { api, state, error: null,
      context: { scope, moduleId: 'nxnative', runtimeId: 'nxnative', ...(scope === 'game' ? { gamePath: g.gamePath } : {}) } }));
    return { html, calls };
  };
  const keyless = render(keylessData('/Games/Example.nup', { generation: 2 }));
  assert.doesNotMatch(keyless.html, /prod\.keys|Choose file…/);
  assert.match(keyless.html, /Build the upstream host when needed/);
  assert.doesNotMatch(keyless.html, /Game update/, 'the update choice is a game setting from nxnative, not a static control');
  assert.match(keyless.html, /Keyless Example · Nintendo Switch 2/);
  assert.deepEqual(keyless.calls, []);
  for (const keyRequirement of ['unknown', 'encrypted', undefined]) {
    const html = render({ format: 'nsp', sourceKind: 'Switch NSP', inputPath: '/Games/Example.nsp', keyRequirement, keysRequired: keyRequirement === 'encrypted' }).html;
    assert.match(html, /prod\.keys/, String(keyRequirement));
    assert.match(html, /Keyless Example · Nintendo Switch</);
  }
  assert.match(render(keylessData('/Games/Example.nup'), 'module').html, /prod\.keys/, 'the game type setting stays available');
});

test('Game update is offered for keyless input, follows the selection and survives static setting saves', async t => {
  const root = temp(t), context = { userDataDir: root };
  const entry = { gameId: 'keyless', moduleData: keylessData('/Games/Example dump', { format: 'dump', sourceKind: 'Switch decrypted dump' }), runtimeSettings: {} };
  const read = await Settings.read(entry, {}, context);
  assert.deepEqual(read.schema.fields.map(field => [field.key, field.label]), [['packageVersion', 'Game update']]);
  assert.deepEqual(read.schema.fields[0].options.map(option => option.label), ['Latest available', 'Base game (v0)', 'v65536']);
  assert.equal(read.values.packageVersion, 'latest');
  let change;
  await Settings.write(entry, { values: { packageVersion: 'v0' } }, { ...context, onEntryChange: value => { change = value; } });
  assert.equal(entry.runtimeSettings.nxnative.packageVersion, 'v0');
  assert.equal(entry.moduleData.selectedUpdate, 'v0', 'the Selected update row follows the choice');
  assert.equal(change.moduleData.selectedUpdate, 'v0');
  await Settings.write(entry, { values: { packageVersion: 'latest' } }, context);
  assert.equal(entry.moduleData.selectedUpdate, 'v65536');
  entry.runtimeSettings.nxnative.packageVersion = 'v9';
  assert.equal((await Settings.read(entry, {}, context)).values.packageVersion, 'latest', 'a missing package shows Latest available');
  // Saving or resolving the other per-game nxnative settings keeps the update choice.
  const schema = resolveRuntimeSettingsSchema(info(), 'nxnative');
  assert.equal(normalizeRuntimeSettings(schema, { packageVersion: 'v0', buildUpstreamHost: true }).packageVersion, 'v0');
  assert.equal(resolveModuleRuntimeSettings({ modules: { nxnative: { runtimeSettings: { nxnative: { packageVersion: 'v0' } } } } }, 'nxnative', info(), 'nxnative').packageVersion,
    'latest', 'the choice belongs to one game');
  // Encrypted and unresolved inputs, and NUPs without readable packages, have no update choice.
  for (const moduleData of [{ format: 'nsp', keyRequirement: 'unknown' }, { format: 'nsp', keyRequirement: 'encrypted' }, { format: 'nup', keyRequirement: 'none', versions: [] }])
    assert.equal((await Settings.read({ gameId: 'other', moduleData }, {}, context)).schema.fields.length, 0, JSON.stringify(moduleData));
});

test('the inspector shows the format, title ID and selected update and keeps the nxnative runtime name', async () => {
  const GameDetails = (await component('GameDetails')).type;
  const state = createLibraryFixture(), actions = new Proxy({}, { get: () => async () => {} });
  const g = libraryEntry(keylessData('/Games/Example.nup', { generation: 2 }));
  state.modules = [info()]; state.recents = [g]; state.moduleSettings = {};
  const html = renderToStaticMarkup(React.createElement(GameDetails, { g, state, moduleInfo: info(), actions,
    moduleActionResults: {}, moduleActionBusy: {}, moduleActionError: null }));
  assert.match(html, /class="cardSubtitle">Nintendo Switch 2</);
  for (const [label, value] of [['Format', 'Switch NUP'], ['Title ID', '0100000000010000'], ['Selected update', 'v65536']])
    assert.match(html, new RegExp(`>${label}<[\\s\\S]{0,300}?>${value}<`), label);
  assert.doesNotMatch(html, />Format<[^]{0,120}?>2</, 'the platform generation is not shown as a format');
  assert.doesNotMatch(html, /Choose prod\.keys/);
  assert.match(html, /<option value="nxnative" selected="">Switch \/ Switch 2 \(nxnative\)<\/option>/);
});

test('Play prepares the chosen update and falls back to the newest local package when it is gone', async t => {
  const root = temp(t), game = dump(path.join(root, 'game'), TITLE, { updates: [65536] });
  const runtime = fakeRuntime(root, { inputFacts: { titleId: '0100000000010000', generation: 2 } });
  const run = async packageVersion => {
    const entry = { gameId: 'keyless', contentRootDir: game, moduleData: keylessData(game, { format: 'dump' }), runtimeSettings: { nxnative: { packageVersion } } };
    runtime.calls.length = 0;
    await Prepare.prepareGame(entry, { userDataDir: path.join(root, 'data'), runtimeSettings: {}, onEntryChange() {} }, runtime.selection, { runCommand: runtime.runCommand });
    return { args: runtime.calls[0], data: entry.moduleData };
  };
  const chosen = await run('v0');
  assert.deepEqual(chosen.args.slice(chosen.args.indexOf('--package'), chosen.args.indexOf('--package') + 2), ['--package', 'v0']);
  assert.deepEqual([chosen.data.selectedUpdate, chosen.data.generation, chosen.data.keysRequired], ['v0', 2, false]);
  const missing = await run('v9');
  assert.equal(missing.args.includes('--package'), false);
  assert.deepEqual([missing.data.selectedUpdate, missing.data.generation], ['v65536', 2]);
});

test('existing Switch games keep their module, runtime and saved settings IDs', () => {
  // A record saved before keyless input support: an encrypted container with a registered key file.
  const record = { gameId: 'existing', gamePath: '/Games/Example.nsp', moduleId: 'nxnative', runtimeId: 'nxnative',
    moduleData: { format: 'nsp', sourceKind: 'Switch NSP', inputPath: '/Games/Example.nsp', titleId: null, inspectionOnly: false, keysRequired: true },
    runtimeSettings: { nxnative: { keysPath: '/Keys/prod.keys', buildUpstreamHost: true } } };
  assert.deepEqual(Object.keys(Nxnative.manifest.runtime.entries), ['nxnative', 'inspection']);
  assert.equal(Nxnative.normalizeRuntimeId(record.runtimeId), 'nxnative');
  assert.deepEqual(Nxnative.filterRuntimeSupport(record), ['nxnative']);
  assert.equal(Nxnative.canLaunchRuntime('nxnative', record), true);
  assert.equal(info().runtime.manager.nxnative, 'nxnative');
  const settings = resolveRuntimeSettingsForEntry(record, {}, info(), 'nxnative');
  assert.deepEqual([settings.keysPath, settings.buildUpstreamHost, settings.packageVersion], ['/Keys/prod.keys', true, 'latest']);
  assert.deepEqual(entryModuleLabels(info(), record), { label: 'Nintendo Switch', shortLabel: 'Nintendo Switch' });
});
