const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const Binary = require('../src/modules/shared/runtime/binary-compatibility');
const { resolvePluginLibraries } = require('../src/modules/shared/runtime/native-plugin-libraries');
const Files = require('../src/modules/shared/runtime/translator-files');
const { image, X64 } = require('./fixtures/macho-image');

function native({ exports = ['entry'], imports = [], ...options } = {}) {
  const bytes = image({ cpu: X64, ...options, symbols: [...exports, ...imports.map(item => item.symbol)] });
  bytes.writeUInt32LE(0x80, 24);
  let command = 32, symbols;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) {
    if (bytes.readUInt32LE(command) === 2) symbols = bytes.readUInt32LE(command + 8);
    command += bytes.readUInt32LE(command + 4);
  }
  imports.forEach((item, i) => {
    const offset = symbols + (exports.length + i) * 16;
    bytes[offset + 4] = 1; bytes[offset + 5] = 0;
    bytes.writeUInt16LE(item.ordinal << 8, offset + 6);
  });
  return bytes;
}

test('in-root SDK directory aliases select and prepare the same actual plugins using their logical file neighborhood', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-video-alias-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  const executablePath = put('wine/bin/wine', native({ fileType: 2 }));
  put('wine/lib/wine/x86_64-unix/ntdll.so', native({ exports: ['wine_unix_call'] }));
  put('wine/lib/wine/x86_64-unix/winegstreamer.so', native({
    dependencies: ['@rpath/libgstreamer-1.0.0.dylib'], runPaths: ['@loader_path/../../../lib64'],
    imports: [{ symbol: 'gst_init', ordinal: 1 }] }));
  const hostCore = put('wine/lib64/libgstreamer-1.0.0.dylib', native({
    installName: '@rpath/libgstreamer-1.0.0.dylib', exports: ['gst_init'] }));
  const sdkCore = put('SDK/Versions/1.0/lib/libgstreamer-1.0.0.dylib', native({
    installName: '@rpath/libgstreamer-1.0.0.dylib', exports: ['sdk_core_only'] }));
  const pluginBytes = native({ installName: '@rpath/libgstselected.dylib',
    dependencies: ['@loader_path/../libgstreamer-1.0.0.dylib'], imports: [{ symbol: 'gst_init', ordinal: 1 }] });
  const plugin = put('SDK/Versions/1.0/lib/gstreamer-1.0/libgstselected.dylib', pluginBytes);
  const sdkRoot = path.join(root, 'SDK');
  fs.symlinkSync('Versions/1.0/lib', path.join(sdkRoot, 'Libraries'));
  const logicalPlugin = path.join(sdkRoot, 'Libraries/gstreamer-1.0/libgstselected.dylib');
  const description = Description.describeTranslator(sdkRoot, { engine: 'gstreamer', pluginDirectories: ['Libraries/gstreamer-1.0'] });
  assert.deepEqual(description.pluginDirectories, ['Versions/1.0/lib/gstreamer-1.0']);
  assert.ok(description.files.some(file => file.path === logicalPlugin && file.realPath === plugin));
  // Installed records retain relative logical paths without transient realPath.
  description.files = description.files.map(({ realPath, ...file }) => file);
  description.pluginDirectories.push('removed-optional-directory');
  const record = await Binary.wineCompatibilityRecord({ engineRoot: path.join(root, 'wine'), executablePath, architecture: 'x64' }, { nativeRoots: [] });
  const resolved = await resolvePluginLibraries(description, record, { executableArchitecture: 'x86_64', macOSVersion: '26.0' });
  assert.ok(resolved.description.files.some(file => file.path === logicalPlugin), 'canonical directory equivalence retains the actual plugin');
  assert.deepEqual(resolved.description.videoPreparation.pluginDirectories, ['Libraries/gstreamer-1.0']);
  assert.deepEqual(resolved.description.videoPreparation.excludedFiles, []);
  assert.equal(resolved.warnings.some(warning => /No native plugin file/.test(warning)), false);
  assert.ok(resolved.warnings.some(warning => /removed-optional-directory.*unavailable/.test(warning)));
  const view = await Files.prepareTranslatorFiles({ runtime: 'crossover', components: { video: { used: resolved.description } } },
    { userDataDir: path.join(root, 'profile'), layout: record.layout, logger: { warn() {} } });
  const stagedDirectory = path.join(view.root, 'video/Libraries/gstreamer-1.0');
  assert.equal(view.env.GST_PLUGIN_PATH_1_0, stagedDirectory);
  const stagedPlugin = path.join(stagedDirectory, path.basename(plugin));
  assert.equal(fs.lstatSync(stagedPlugin).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(stagedPlugin), pluginBytes);
  assert.equal(fs.realpathSync(path.join(stagedDirectory, '../libgstreamer-1.0.0.dylib')), hostCore);
  assert.deepEqual(fs.readFileSync(plugin), pluginBytes);
  assert.notEqual(fs.realpathSync(sdkCore), hostCore);
});
