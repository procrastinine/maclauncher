const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Binary = require('../src/modules/shared/runtime/binary-compatibility');
const Description = require('../src/modules/shared/runtime/translator-description');
const { resolvePluginLibraries } = require('../src/modules/shared/runtime/native-plugin-libraries');
const { prepareNativeLibraryView } = require('../src/modules/shared/runtime/native-library-view');
const { readMachOLoadCommands } = require('../src/modules/shared/runtime/macho-load-commands');
const { image, X64 } = require('./fixtures/macho-image');

for (const absoluteImport of [true, false]) test(`video preparation omits a plugin whose ${absoluteImport ? 'absolute SDK import' : 'first absolute SDK rpath'} cannot use the host alias`, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-video-binding-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = new Map();
  function put(relative, options = {}) {
    const file = path.join(root, relative), bytes = image({ cpu: X64, installName: '@rpath/' + path.basename(relative), symbols: ['entry'], ...options });
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); sources.set(file, bytes); return file;
  }
  const executablePath = put('wine/bin/wine', { fileType: 2 });
  put('wine/lib/wine/x86_64-unix/ntdll.so');
  const name = 'libfixture-core.dylib', id = '@rpath/' + name;
  const host = put('wine/lib64/' + name, { installName: id, symbols: ['host_entry'] });
  put('wine/lib/wine/x86_64-unix/winegstreamer.so', { dependencies: [id], runPaths: ['@loader_path/../../../lib64'] });
  const sdk = put('SDK/lib/' + name, { installName: id, symbols: ['sdk_entry'] });
  const bad = put('SDK/plugins/libunrebindable.dylib', {
    dependencies: [absoluteImport ? sdk : id], runPaths: absoluteImport ? [] : [path.dirname(sdk), '@loader_path/../lib']
  });
  const good = put('SDK/plugins/libusable.dylib', { dependencies: [id], runPaths: ['@loader_path/../lib'] });
  const sourceImage = readMachOLoadCommands(bad, { architecture: 'x64' }).slices[0];
  assert.equal(Binary.resolveNativeDependency(bad, sourceImage, sourceImage.dependencies[0].path), sdk,
    'the existing import/search order actually selects the SDK core');
  const description = Description.describeTranslator(path.join(root, 'SDK'), { engine: 'gstreamer', pluginDirectories: ['plugins'] });
  const record = await Binary.wineCompatibilityRecord({ engineRoot: path.join(root, 'wine'), executablePath, architecture: 'x64' }, { nativeRoots: [] });
  const result = await resolvePluginLibraries(description, record, { executableArchitecture: 'x86_64', macOSVersion: '26.0' });
  assert.ok(result.description.videoPreparation.excludedFiles.includes(bad), 'an unchanged neighborhood cannot rebind this plugin');
  assert.equal(result.description.files.some(file => file.path === bad), false);
  assert.ok(result.description.files.some(file => file.path === good), 'the usable sibling remains selected');
  assert.ok(result.warnings.some(warning => warning.includes(path.basename(bad))), 'the optional plugin omission is visible');
  const view = await prepareNativeLibraryView(result.description, { root: path.join(root, 'prepared'), ...result.description.videoPreparation });
  const plugin = path.join(view.pluginDirectories[0], path.basename(good));
  assert.equal(fs.existsSync(path.join(view.pluginDirectories[0], path.basename(bad))), false);
  const preparedImage = readMachOLoadCommands(plugin, { architecture: 'x64' }).slices[0];
  assert.equal(Binary.resolveNativeDependency(plugin, preparedImage, id), host, 'the usable sibling resolves the actual host core');
  for (const [file, bytes] of sources) assert.deepEqual(fs.readFileSync(file), bytes, 'original source bytes remain unchanged');
});
