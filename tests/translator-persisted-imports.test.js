const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { image, X64 } = require('./fixtures/macho-image');
const { peFixture } = require('./helpers/pe-fixture');
const Description = require('../src/modules/shared/runtime/translator-description');
const Component = require('../src/modules/shared/runtime/component-runtime');
const Managers = require('../src/modules/shared/runtime/translator-managers');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const Files = require('../src/modules/shared/runtime/translator-files');
const Binary = require('../src/modules/shared/runtime/binary-compatibility');
const MachO = require('../src/modules/shared/runtime/macho-load-commands');
const { resolvePluginLibraries } = require('../src/modules/shared/runtime/native-plugin-libraries');

function native({ exports = ['fixture_entry'], imports = [], incompleteExports = false, ...options } = {}) {
  const extraCommands = [];
  if (incompleteExports) {
    const command = Buffer.alloc(16); command.writeUInt32LE(0x80000033); command.writeUInt32LE(16, 4);
    command.writeUInt32LE(0x100000, 8); command.writeUInt32LE(1, 12); extraCommands.push(command);
  }
  const bytes = image({ cpu: X64, ...options, symbols: [...exports, ...imports.map(item => item.symbol)], extraCommands });
  bytes.writeUInt32LE(0x80, 24);
  let command = 32, symbols;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) { if (bytes.readUInt32LE(command) === 2) symbols = bytes.readUInt32LE(command + 8); command += bytes.readUInt32LE(command + 4); }
  imports.forEach((item, index) => {
    const offset = symbols + (exports.length + index) * 16; bytes[offset + 4] = 1; bytes[offset + 5] = 0;
    bytes.writeUInt16LE((item.ordinal << 8) | (item.weak ? 0x40 : 0), offset + 6);
  });
  return bytes;
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-persisted-imports-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const strong = Array.from({ length: 1024 }, (_, index) => 'gst_actual_import_' + index);
  const library = 'Versions/1.0/lib', plugins = library + '/gstreamer-1.0', framework = path.join(root, 'source/GStreamer.framework');
  const id = '@rpath/libgstreamer-1.0.0.dylib', objectId = '@rpath/libgobject-2.0.0.dylib';
  put('source/GStreamer.framework/' + library + '/libgstreamer-1.0.0.dylib', native({ installName: id, exports: ['sdk_only'] }));
  put('source/GStreamer.framework/' + library + '/libgobject-2.0.0.dylib', native({ installName: objectId, exports: ['sdk_only'] }));
  put('source/GStreamer.framework/' + library + '/libincomplete.dylib', native({ installName: '@rpath/libincomplete.dylib' }));
  const privateRelative = library + '/libcodec-private.dylib';
  put('source/GStreamer.framework/' + privateRelative, native({ installName: '@rpath/libcodec-private.dylib', dependencies: ['@loader_path/libgobject-2.0.0.dylib'], imports: [{ symbol: 'g_object_ref', ordinal: 1 }] }));
  const strongRelative = plugins + '/libgststrong.dylib';
  put('source/GStreamer.framework/' + strongRelative, native({ installName: '@rpath/libgststrong.dylib', minimumOS: 0x000e0000,
    dependencies: [id, '@rpath/libcodec-private.dylib'], runPaths: ['@loader_path/..'], imports: strong.map(symbol => ({ symbol, ordinal: 1 })) }));
  const usableRelative = plugins + '/libgstusable.dylib';
  put('source/GStreamer.framework/' + usableRelative, native({ installName: '@rpath/libgstusable.dylib', dependencies: [id], runPaths: ['@loader_path/..'], imports: [{ symbol: strong[0], ordinal: 1 }] }));
  const weakRelative = plugins + '/libgstweak.dylib';
  put('source/GStreamer.framework/' + weakRelative, native({ installName: '@rpath/libgstweak.dylib', dependencies: [id], runPaths: ['@loader_path/..'], imports: [{ symbol: 'gst_optional_missing', ordinal: 1, weak: true }] }));
  const unknownRelative = plugins + '/libgstunknown.dylib';
  put('source/GStreamer.framework/' + unknownRelative, native({ installName: '@rpath/libgstunknown.dylib', dependencies: ['@rpath/libincomplete.dylib'], runPaths: ['@loader_path/..'], imports: [{ symbol: 'gst_unknown_export', ordinal: 1 }] }));
  put('source/GStreamer.framework/Versions/1.0/libexec/gstreamer-1.0/gst-plugin-scanner', native({ fileType: 2 }));
  put('source/GStreamer.framework/Resources/plugin-profiles/fixture.json', JSON.stringify({ profile: 'retained private package resource' }));
  put('source/GStreamer.framework/version', 'fixture-component-version');
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22);
  put('source/GStreamer.framework/tools/probe.dll', pe.bytes);
  const wine = path.join(root, 'wine'), executablePath = put('wine/bin/wine', native({ fileType: 2 }));
  put('wine/lib/wine/x86_64-unix/ntdll.so', native({ installName: '@rpath/ntdll.so', exports: ['wine_unix_call'] }));
  put('wine/lib/wine/x86_64-unix/winegstreamer.so', native({ installName: '@rpath/winegstreamer.so', dependencies: [id], runPaths: ['@loader_path/../../../lib64'], imports: [{ symbol: strong[0], ordinal: 1 }] }));
  const hostBytes = symbols => native({ installName: id, exports: symbols, dependencies: ['@loader_path/libgobject-2.0.0.dylib', '@loader_path/libincomplete.dylib'] });
  const hostCore = put('wine/lib64/libgstreamer-1.0.0.dylib', hostBytes(strong));
  const hostObject = put('wine/lib64/libgobject-2.0.0.dylib', native({ installName: objectId, exports: ['g_object_ref'] }));
  put('wine/lib64/libincomplete.dylib', native({ installName: '@rpath/libincomplete.dylib', incompleteExports: true }));
  put('wine/lib64/gstreamer-1.0/libgststock.dylib', native({ installName: '@rpath/libgststock.dylib', dependencies: [id], runPaths: ['@loader_path/..'], imports: [{ symbol: strong[0], ordinal: 1 }] }));
  return { root, put, framework, plugins, library, strong, strongRelative, usableRelative, weakRelative, unknownRelative, privateRelative,
    hostCore, hostObject, hostBytes, install: { crossoverRoot: wine, engineRoot: wine, executablePath, architecture: 'x64', version: 'fixture-wine', upstreamVersion: '26.3' } };
}
async function installFixture(t, f) {
  const userDataDir = path.join(f.root, 'data'), archive = Buffer.from('scratch codec package fixture'), digest = crypto.createHash('sha256').update(archive).digest('hex');
  const pin = { version: 'fixture-prepared', upstreamRevision: 'fixture-source', architecture: 'x64', catalogSourceId: 'upstream',
    asset: { url: 'https://example.invalid/scratch-fixture.pkg', filename: 'scratch-fixture.pkg', sha256: digest } };
  t.mock.method(Managers.definitions.gstreamer.sources[0], 'discover', async () => [pin]);
  let downloadCalls = 0, extractionCalls = 0;
  const manager = Managers.createManager('gstreamer', { dependencies: { hostArch: 'arm64', systemVersionSync: () => '26.0',
    hostCapabilities: { platform: 'darwin', hardwareArch: 'arm64', macOSVersion: '26.0', rosettaAvailable: true },
    downloadToFile: async (_url, destination) => { downloadCalls++; fs.writeFileSync(destination, archive); },
    extractArchive: async (_archive, destination) => { extractionCalls++; fs.cpSync(f.framework, path.join(destination, 'GStreamer.framework'), { recursive: true }); } } });
  manager.core.rememberResolvedVersion({ userDataDir, architecture: 'x64', entry: pin });
  const installed = await manager.installRuntime({ userDataDir, version: pin.version, architecture: 'x64' });
  assert.equal(downloadCalls, 1); assert.equal(extractionCalls, 1);
  const recordPath = path.join(installed.installDir, 'runtime.json'), text = fs.readFileSync(recordPath, 'utf8'), record = JSON.parse(text);
  const translatorRoot = path.join(installed.installDir, record.installationMetadata.translatorRelative);
  return { manager, userDataDir, installed, record, text, translatorRoot };
}
function persistedManager(installed) {
  const item = { ...installed.installed, translatorRoot: installed.translatorRoot, translator: installed.record.installationMetadata.translator };
  return { id: installed.manager.id, translatorEngine: installed.manager.translatorEngine,
    getState: () => ({ installed: [item] }), resolveSelection: () => ({ ready: true, install: item }) };
}
async function resolvePersisted(f, stored) {
  const warnings = [], context = { userDataDir: stored.userDataDir, settings: {}, runtimeSettings: { translatorVideo: stored.manager.id + ':' + stored.installed.version }, logger: { warn: message => warnings.push(message) } };
  const plan = await Translators.resolve(f.install, 'crossover', context, { managers: [persistedManager(stored)], executableArchitecture: 'x86_64', host: { macOSVersion: '26.0', hardwareArch: 'arm64', physicalAppleGPU: false } });
  return { context, plan, warnings };
}

test('ordinary managed codec installation persists compact placement facts and retains its complete package and live binary imports', async t => {
  const f = fixture(t), full = Component.description(f.framework, { ...Managers.definitions.gstreamer, engine: 'gstreamer' }), before = structuredClone(full);
  const sourceStrong = full.files.find(file => file.relative === f.strongRelative);
  assert.equal(sourceStrong.slices[0].imports.length, 1024); assert.equal(sourceStrong.slices[0].importsComplete, true);
  const projected = Description.installationDescription(full);
  assert.deepEqual(full, before, 'the persistence projection leaves complete in-memory facts untouched');
  const stored = await installFixture(t, f), persisted = stored.record.installationMetadata.translator;
  assert.equal(stored.text.trimEnd(), JSON.stringify(stored.record), 'ordinary runtime.json publication is compact JSON');
  assert.deepEqual(new Set(persisted.files.map(file => file.relative)), new Set(full.files.map(file => file.relative)));
  assert.deepEqual(persisted.pluginDirectories, full.pluginDirectories);
  for (const file of persisted.files) {
    assert.equal(file.path, file.relative); assert.equal(Object.hasOwn(file, 'realPath'), false); assert.equal(Object.hasOwn(file, 'unixImports'), false);
    const original = full.files.find(original => original.relative === file.relative);
    assert.equal(file.format, original.format); assert.equal(file.form, original.form); assert.equal(file.macosFloor, original.macosFloor);
    if (file.format === 'pe') { assert.equal(file.machine, original.machine); assert.equal(file.architecture, original.architecture); }
    if (file.format === 'macho') {
      assert.deepEqual(file.cpuSlices, original.cpuSlices);
      for (const [index, slice] of file.slices.entries()) {
        assert.equal(Object.hasOwn(slice, 'imports'), false); assert.equal(slice.importsComplete, false);
        for (const key of ['architecture', 'minimumMacOS', 'dependencies', 'runPaths', 'installName']) assert.deepEqual(slice[key], original.slices[index][key]);
      }
    }
    assert.deepEqual(fs.readFileSync(path.join(stored.translatorRoot, file.relative)), fs.readFileSync(path.join(f.framework, file.relative)));
  }
  assert.equal(Object.hasOwn(persisted, 'unixImports'), false); assert.equal(Object.hasOwn(projected, 'unixImports'), false);
  assert.equal(stored.installed.translator.files.find(file => file.relative === f.strongRelative).slices[0].imports.length, 1024, 'ordinary resolved install retains freshly inspected facts in memory');
  assert.equal(fs.readFileSync(path.join(stored.translatorRoot, 'Resources/plugin-profiles/fixture.json'), 'utf8'), fs.readFileSync(path.join(f.framework, 'Resources/plugin-profiles/fixture.json'), 'utf8'));
  const { plan, context } = await resolvePersisted(f, stored), used = plan.components.video.used;
  const plugin = path.join(stored.translatorRoot, f.strongRelative), imported = used.files.find(file => file.path === plugin);
  assert.equal(imported.slices[0].imports.length, 1024, 'actual resolver rereads all strong imports from the disk image');
  assert.equal(imported.slices[0].importsComplete, true);
  const view = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout, logger: context.logger });
  const preparedPlugin = path.join(view.root, 'video', f.strongRelative);
  assert.equal(fs.lstatSync(preparedPlugin).isSymbolicLink(), false);
  const preparedImage = MachO.readMachOLoadCommands(preparedPlugin, { architecture: 'x64', imports: true }).slices[0];
  assert.equal(preparedImage.imports.length, 1024);
  assert.equal(Binary.resolveNativeDependency(preparedPlugin, preparedImage, '@rpath/libgstreamer-1.0.0.dylib'), f.hostCore);
  assert.equal(fs.realpathSync(path.join(view.root, 'video', f.library, 'libgobject-2.0.0.dylib')), f.hostObject);
  assert.deepEqual(fs.readFileSync(path.join(view.root, 'video', f.privateRelative)), fs.readFileSync(path.join(stored.translatorRoot, f.privateRelative)));
  assert.equal(view.env.GST_PLUGIN_PATH_1_0, path.join(view.root, 'video', f.plugins)); assert.deepEqual(view.libraryPaths, []); assert.deepEqual(view.frameworkPaths, []);
});

test('persisted descriptors cannot conceal the final strong import while weak and unknown host symbols remain usable', async t => {
  const f = fixture(t), stored = await installFixture(t, f);
  fs.writeFileSync(f.hostCore, f.hostBytes(f.strong.slice(0, -1)));
  const compact = Translators.managedTranslators({ userDataDir: stored.userDataDir, settings: {} }, 'crossover', [persistedManager(stored)], 'x64')[0];
  assert.equal(Object.hasOwn(compact.files.find(file => file.relative === f.strongRelative).slices[0], 'imports'), false);
  const record = await Binary.wineCompatibilityRecord(f.install, { nativeRoots: [] });
  const direct = await resolvePluginLibraries(compact, record, { macOSVersion: '26.0', executableArchitecture: 'x86_64' });
  assert.ok(direct.description.videoPreparation.excludedFiles.includes(path.join(stored.translatorRoot, f.strongRelative)), 'the plugin helper itself refreshes a compact persisted image');
  assert.ok(direct.warnings.some(warning => warning.includes('does not export required symbol ' + f.strong.at(-1))));
  assert.ok(direct.description.files.some(file => file.relative === f.weakRelative)); assert.ok(direct.description.files.some(file => file.relative === f.unknownRelative));
  const { plan, context } = await resolvePersisted(f, stored), used = plan.components.video.used;
  const strong = path.join(stored.translatorRoot, f.strongRelative), weak = path.join(stored.translatorRoot, f.weakRelative), unknown = path.join(stored.translatorRoot, f.unknownRelative);
  assert.equal(plan.components.video.fallback, false); assert.equal(plan.compatibility[used.id].compatible, true);
  assert.ok(used.videoPreparation.excludedFiles.includes(strong)); assert.equal(used.files.some(file => file.path === strong), false);
  assert.ok(plan.warnings.some(warning => warning.includes('does not export required symbol ' + f.strong.at(-1))), 'the 1,024th real strong import is checked');
  assert.ok(used.files.some(file => file.path === weak)); assert.ok(used.files.some(file => file.path === unknown));
  assert.ok(plan.warnings.some(warning => warning.includes('could not establish gst_unknown_export')));
  const view = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout, logger: context.logger });
  for (const relative of [f.usableRelative, f.weakRelative, f.unknownRelative]) assert.equal(fs.existsSync(path.join(view.root, 'video', relative)), true);
  assert.equal(fs.existsSync(path.join(view.root, 'video', f.strongRelative)), false);
  assert.equal(fs.realpathSync(path.join(view.root, 'video', f.library, 'libgstreamer-1.0.0.dylib')), f.hostCore);
  const persisted = JSON.parse(fs.readFileSync(path.join(stored.installed.installDir, 'runtime.json'), 'utf8'));
  assert.equal(Object.hasOwn(persisted.installationMetadata.translator.files.find(file => file.relative === f.strongRelative).slices[0], 'imports'), false);
});
