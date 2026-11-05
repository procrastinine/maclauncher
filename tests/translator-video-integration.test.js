const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const Files = require('../src/modules/shared/runtime/translator-files');
const WineSettings = require('../src/modules/shared/runtime/wine-settings');
const CrossLaunch = require('../src/modules/crossover/runtime/launch');
const CrossLoader = require('../src/modules/crossover/runtime/graphics-loader');
const SikaLaunch = require('../src/modules/crossover/sikarugir/launch');
const SikaGraphics = require('../src/modules/crossover/sikarugir/graphics');
const MachO = require('../src/modules/shared/runtime/macho-load-commands');
const { image, X64, ARM64 } = require('./fixtures/macho-image');
const { peFixture } = require('./helpers/pe-fixture');

function native({ exports = ['fixture_entry'], imports = [], signature = false, incompleteExports = false, ...options } = {}) {
  const extraCommands = [];
  if (signature || incompleteExports) {
    const command = Buffer.alloc(16); command.writeUInt32LE(signature ? 0x1d : 0x80000033, 0); command.writeUInt32LE(16, 4);
    if (incompleteExports) { command.writeUInt32LE(0x100000, 8); command.writeUInt32LE(1, 12); }
    extraCommands.push(command);
  }
  let bytes = image({ cpu: X64, ...options, symbols: [...exports, ...imports.map(item => item.symbol)], extraCommands });
  bytes.writeUInt32LE(0x80, 24);
  let command = 32, symbols, signatureCommand;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) {
    if (bytes.readUInt32LE(command) === 2) symbols = bytes.readUInt32LE(command + 8);
    if (bytes.readUInt32LE(command) === 0x1d) signatureCommand = command;
    command += bytes.readUInt32LE(command + 4);
  }
  imports.forEach((item, index) => {
    const offset = symbols + (exports.length + index) * 16;
    bytes[offset + 4] = 1; bytes[offset + 5] = 0;
    bytes.writeUInt16LE((item.ordinal << 8) | (item.weak ? 0x40 : 0), offset + 6);
  });
  if (signature) {
    const blob = Buffer.alloc(12); blob.writeUInt32BE(0xfade0cc0, 0); blob.writeUInt32BE(blob.length, 4);
    bytes.writeUInt32LE(bytes.length, signatureCommand + 8); bytes.writeUInt32LE(blob.length, signatureCommand + 12);
    bytes = Buffer.concat([bytes, blob]);
  }
  return bytes;
}
function fixture(t, runtime) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `translator-video-integration-${runtime}-`)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceFiles = new Set(), put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); sourceFiles.add(file); return file;
  };
  const wine = path.join(root, 'wine'), templateRoot = path.join(root, 'Template.app/Contents');
  const executablePath = put('wine/bin/wine', native({ fileType: 2, signature: true }));
  const serverPath = put('wine/bin/wineserver', native({ fileType: 2 }));
  const loaderPath = put('wine/bin/wineloader', native({ fileType: 2 }));
  put('wine/lib/wine/x86_64-unix/wine', native({ fileType: 2 }));
  put('wine/lib/wine/x86_64-unix/ntdll.so', native({ exports: ['wine_unix_call'] }));
  for (const name of ['ntdll', 'apisetschema']) {
    const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22); pe.bytes.write('Wine builtin DLL\0', 64);
    put(`wine/lib/wine/x86_64-windows/${name}.dll`, pe.bytes);
  }
  const hostLib = runtime === 'crossover' ? 'wine/lib64' : 'Template.app/Contents/Frameworks/GStreamer.framework/Versions/1.0/lib';
  const core = put(hostLib + '/libgstreamer-1.0.0.dylib', native({ signature: true, exports: ['gst_init'], installName: '@rpath/libgstreamer-1.0.0.dylib',
    dependencies: ['@loader_path/libgobject-2.0.0.dylib', '@loader_path/libincomplete.dylib'] }));
  const object = put(hostLib + '/libgobject-2.0.0.dylib', native({ signature: true, exports: ['g_object_ref'], installName: '@rpath/libgobject-2.0.0.dylib' }));
  const incomplete = put(hostLib + '/libincomplete.dylib', native({ incompleteExports: true, installName: '@rpath/libincomplete.dylib' }));
  put('wine/lib/wine/x86_64-unix/winegstreamer.so', native({ dependencies: ['@rpath/libgstreamer-1.0.0.dylib'],
    ...(runtime === 'crossover' ? { runPaths: ['@loader_path/../../../lib64'] } : {}), imports: [{ symbol: 'gst_init', ordinal: 1 }] }));
  const systemPlugin = put(hostLib + '/gstreamer-1.0/libgststock.dylib', native({ installName: '@rpath/libgststock.dylib', dependencies: ['@rpath/libgstreamer-1.0.0.dylib'], runPaths: ['@loader_path/..'], imports: [{ symbol: 'gst_init', ordinal: 1 }] }));
  const scanner = put(runtime === 'crossover' ? 'wine/libexec/gstreamer-1.0/gst-plugin-scanner' : 'Template.app/Contents/Frameworks/GStreamer.framework/Versions/1.0/libexec/gstreamer-1.0/gst-plugin-scanner', native({ fileType: 2 }));
  if (runtime === 'sikarugir') fs.mkdirSync(path.join(templateRoot, 'Frameworks/renderer'), { recursive: true });
  const sdkRoot = path.join(root, 'SDK'), relativeLib = 'Frameworks/GStreamer.framework/Versions/1.0/lib', plugins = relativeLib + '/gstreamer-1.0';
  const sdkCore = put('SDK/' + relativeLib + '/libgstreamer-1.0.0.dylib', native({ exports: ['sdk_core_only'], installName: '@rpath/libgstreamer-1.0.0.dylib' }));
  const sdkObject = put('SDK/' + relativeLib + '/libgobject-2.0.0.dylib', native({ exports: ['sdk_object_only'], installName: '@rpath/libgobject-2.0.0.dylib' }));
  put('SDK/' + relativeLib + '/libincomplete.dylib', native({ exports: ['sdk_incomplete_only'], installName: '@rpath/libincomplete.dylib' }));
  const privateLibrary = put('SDK/' + relativeLib + '/libcodec-private.dylib', native({ dependencies: ['@loader_path/libgobject-2.0.0.dylib'],
    imports: [{ symbol: 'g_object_ref', ordinal: 1 }], installName: '@rpath/libcodec-private.dylib' }));
  const plugin = put('SDK/' + plugins + '/libgstusable.dylib', native({ installName: '@rpath/libgstusable.dylib', dependencies: ['@rpath/libgstreamer-1.0.0.dylib', '@rpath/libcodec-private.dylib'],
    runPaths: ['@loader_path/..'], imports: [{ symbol: 'gst_init', ordinal: 1 }] }));
  const install = { engineRoot: wine, installDir: wine, executablePath, serverPath, loaderPath, architecture: 'x64', version: 'fixture',
    upstreamVersion: '26.3', ...(runtime === 'crossover' ? { crossoverRoot: wine } : { templateRoot }) };
  const warnings = [], context = settings => ({ runtimeId: runtime, runtimeSettings: settings, settings: {}, userDataDir: path.join(root, 'profile'), logger: { warn: message => warnings.push(message) } });
  const description = () => Description.describeTranslator(sdkRoot, { engine: 'gstreamer', source: 'fixture-sdk', pluginDirectories: [plugins] });
  const manager = { id: 'fixture-gstreamer', translatorEngine: 'gstreamer', getState: () => ({ installed: [{ version: 'prepared', architecture: 'x64' }] }),
    resolveSelection: () => ({ ready: true, install: { version: 'prepared', architecture: 'x64', translatorRoot: sdkRoot, installDir: sdkRoot, translator: description() } }) };
  const host = { platform: 'darwin', hardwareArch: 'arm64', physicalAppleGPU: false, macOSVersion: '26.0' };
  const resolve = (settings, environment) => { const value = context(settings); if (environment) value.wineEnvironment = environment;
    return Translators.resolve(install, runtime, value, { managers: [manager], executableArchitecture: 'x86_64', host }).then(plan => ({ plan, context: value })); };
  return { root, put, sourceFiles, runtime, install, templateRoot, sdkRoot, relativeLib, plugins, plugin, privateLibrary, sdkCore, sdkObject,
    core, object, incomplete, scanner, systemPlugin, host, context, warnings, resolve };
}
function treeBytes(root) {
  let bytes = 0;
  for (const name of fs.readdirSync(root)) { const target = path.join(root, name), stat = fs.lstatSync(target); if (stat.isDirectory()) bytes += treeBytes(target); else if (stat.isFile()) bytes += stat.size; }
  return bytes;
}
async function environmentFor(f, plan, view, context) {
  const settings = Translators.settingsForPlan({ dlss: false }, plan), prefix = path.join(f.root, 'unused-prefix');
  if (f.runtime === 'sikarugir') {
    const graphics = await SikaGraphics.prepareGraphicsView({ install: f.install, settings, translatorPlan: plan, translatorView: view,
      context, userDataDir: context.userDataDir, viewRoot: path.join(context.userDataDir, 'graphics/sikarugir-video'), prefixPath: prefix, host: f.host, executableArchitecture: 'x86_64' });
    return SikaLaunch.buildEnvironment(settings, f.install, path.join(f.root, 'game-state'), prefix, graphics, { translatorPlan: plan, baseEnvironment: {} }).environment;
  }
  const stock = { GST_PLUGIN_SYSTEM_PATH_1_0: path.dirname(f.systemPlugin), GST_PLUGIN_SCANNER_1_0: f.scanner, GST_REGISTRY_1_0: path.join(f.root, 'stock-registry') };
  const built = CrossLaunch.buildEnvironment(settings, f.install, path.join(f.root, 'game-state'), prefix, { translatorPlan: plan, baseEnvironment: stock, executableArchitecture: 'x86_64', host: f.host });
  // The launch seam merges this same prepared environment into both outputs.
  for (const output of [built.environment, built.overrides]) Object.assign(output, view.env);
  assert.equal(built.environment.GST_PLUGIN_PATH_1_0, built.overrides.GST_PLUGIN_PATH_1_0);
  const loaderValues = CrossLoader.environment(f.install.loaderPath, built.environment, { installation: f.install, translatorView: view });
  return { ...built.environment, ...loaderValues };
}

test('selected framework codecs use host-core aliases through both real Wine environment builders and reuse one prepared payload', async t => {
  const composer = WineSettings.environment; let composerCalls = 0;
  t.mock.method(WineSettings, 'environment', (...args) => { composerCalls++; return composer(...args); });
  for (const runtime of ['crossover', 'sikarugir']) {
    const f = fixture(t, runtime), before = new Map([...f.sourceFiles].map(file => [file, fs.readFileSync(file)]));
    const { plan, context } = await f.resolve({ translatorVideo: 'fixture-gstreamer:prepared' });
    assert.equal(context.translatorPlan, plan); assert.equal(plan.components.video.used.id, 'fixture-gstreamer:prepared'); assert.equal(plan.components.video.fallback, false);
    const preparation = plan.components.video.used.videoPreparation;
    assert.ok(preparation.bindings.some(binding => binding.source === f.sdkCore && binding.target === f.core));
    assert.ok(preparation.bindings.some(binding => binding.source === f.sdkObject && binding.target === f.object));
    const view = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout, logger: context.logger });
    const pluginDirectory = path.join(view.root, 'video', f.plugins), preparedPlugin = path.join(pluginDirectory, path.basename(f.plugin));
    assert.equal(view.env.GST_PLUGIN_PATH, pluginDirectory); assert.equal(view.env.GST_PLUGIN_PATH_1_0, pluginDirectory);
    assert.equal(fs.lstatSync(preparedPlugin).isSymbolicLink(), false); assert.deepEqual(fs.readFileSync(preparedPlugin), before.get(f.plugin));
    const preparedLib = path.join(view.root, 'video', f.relativeLib);
    assert.equal(fs.realpathSync(path.join(preparedLib, path.basename(f.sdkCore))), f.core);
    assert.equal(fs.realpathSync(path.join(preparedLib, path.basename(f.sdkObject))), f.object);
    assert.deepEqual(fs.readFileSync(path.join(preparedLib, path.basename(f.privateLibrary))), before.get(f.privateLibrary));
    assert.ok(MachO.readMachOLoadCommands(preparedPlugin).slices[0].runPaths.includes('@loader_path/..'));
    assert.deepEqual(view.libraryPaths, []); assert.deepEqual(view.frameworkPaths, []);
    const callsBefore = composerCalls, environment = await environmentFor(f, plan, view, context);
    assert.equal(composerCalls - callsBefore, 1); assert.equal(environment.GST_PLUGIN_PATH_1_0, pluginDirectory);
    assert.equal(environment.GST_PLUGIN_SYSTEM_PATH_1_0, path.dirname(f.systemPlugin)); assert.equal(environment.GST_PLUGIN_SCANNER_1_0, f.scanner);
    assert.ok(environment.GST_REGISTRY_1_0); assert.equal([environment.DYLD_LIBRARY_PATH, environment.DYLD_FRAMEWORK_PATH].filter(Boolean).some(value => value.includes(f.sdkRoot)), false);
    const bytes = treeBytes(path.dirname(view.root)), inode = fs.statSync(preparedPlugin).ino;
    const second = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout, logger: context.logger });
    assert.equal(second.root, view.root); assert.equal(fs.statSync(preparedPlugin).ino, inode); assert.equal(treeBytes(path.dirname(view.root)) - bytes, 0);
    fs.writeFileSync(preparedPlugin, 'changed disposable plugin');
    const repaired = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout, logger: context.logger });
    assert.notEqual(repaired.root, view.root); assert.equal(fs.readFileSync(preparedPlugin, 'utf8'), 'changed disposable plugin');
    assert.deepEqual(fs.readFileSync(path.join(repaired.root, 'video', f.plugins, path.basename(f.plugin))), before.get(f.plugin));
    assert.ok(f.warnings.some(message => /another shared generation/.test(message)));
    for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, `source and embedded signature bytes stay unchanged: ${file}`);
    assert.equal(fs.existsSync(path.join(f.root, 'unused-prefix')), false);
  }
});

test('optional codec failures exclude only proven unusable plugins while weak and incomplete host imports stay accessible', async t => {
  const f = fixture(t, 'crossover'), relative = 'SDK/' + f.plugins + '/';
  const strong = f.put(relative + 'libgstmissing.dylib', native({ installName: '@rpath/libgstmissing.dylib', dependencies: ['@rpath/libgstreamer-1.0.0.dylib'], runPaths: ['@loader_path/..'], imports: [{ symbol: 'gst_missing_required', ordinal: 1 }] }));
  const weak = f.put(relative + 'libgstweak.dylib', native({ installName: '@rpath/libgstweak.dylib', dependencies: ['@rpath/libgstreamer-1.0.0.dylib'], runPaths: ['@loader_path/..'], imports: [{ symbol: 'gst_optional', ordinal: 1, weak: true }] }));
  const unknown = f.put(relative + 'libgstunknown.dylib', native({ installName: '@rpath/libgstunknown.dylib', dependencies: ['@rpath/libincomplete.dylib'], runPaths: ['@loader_path/..'], imports: [{ symbol: 'not_established', ordinal: 1 }] }));
  const cpu = f.put(relative + 'libgstarmonly.dylib', image({ cpu: ARM64, installName: '@rpath/libgstarmonly.dylib' }));
  const floor = f.put(relative + 'libgstfuture.dylib', native({ installName: '@rpath/libgstfuture.dylib', minimumOS: 0x00630000 }));
  const { plan, context } = await f.resolve({ translatorVideo: 'fixture-gstreamer:prepared' }), used = plan.components.video.used;
  assert.equal(used.id, 'fixture-gstreamer:prepared'); assert.equal(plan.components.video.fallback, false);
  assert.deepEqual(new Set(used.videoPreparation.excludedFiles), new Set([strong, cpu, floor]));
  assert.ok(used.files.some(file => file.path === weak)); assert.ok(used.files.some(file => file.path === unknown)); assert.ok(used.files.some(file => file.path === f.plugin));
  assert.ok(plan.warnings.some(message => /does not export required symbol gst_missing_required/.test(message)));
  assert.ok(plan.warnings.some(message => /could not establish not_established/.test(message)));
  assert.ok(plan.warnings.some(message => /libgstarmonly.*not added/.test(message))); assert.ok(plan.warnings.some(message => /libgstfuture.*macOS 99/.test(message)));
  const view = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout, logger: context.logger });
  const plugins = view.env.GST_PLUGIN_PATH_1_0;
  for (const file of [strong, cpu, floor]) assert.equal(fs.existsSync(path.join(plugins, path.basename(file))), false);
  for (const file of [f.plugin, weak, unknown]) assert.equal(fs.existsSync(path.join(plugins, path.basename(file))), true);
});

test('default and inherited video selections preserve runtime plugin and scanner defaults without new video environment', async t => {
  for (const runtime of ['crossover', 'sikarugir']) for (const translatorVideo of [undefined, 'automatic', 'inherit']) {
    const f = fixture(t, runtime), settings = translatorVideo ? { translatorVideo } : {};
    const existing = translatorVideo === 'inherit' ? { kind: runtime === 'sikarugir' ? 'sikarugir-wrapper' : 'crossover-bottle', name: 'Scratch existing environment', settings: {}, environment: {} } : null;
    const { plan, context } = await f.resolve(settings, existing);
    assert.equal(plan.components.video.used, null);
    if (existing) assert.equal(plan.components.video.inherited, true);
    const view = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout, logger: context.logger });
    assert.equal(Object.keys(view.env).some(name => name.startsWith('GST_')), false);
    const environment = await environmentFor(f, plan, view, context);
    assert.equal(environment.GST_PLUGIN_SYSTEM_PATH_1_0, path.dirname(f.systemPlugin)); assert.equal(environment.GST_PLUGIN_SCANNER_1_0, f.scanner);
    assert.equal(environment.GST_PLUGIN_PATH_1_0 || '', ''); assert.equal(environment.GST_PLUGIN_PATH || '', '');
  }
});
