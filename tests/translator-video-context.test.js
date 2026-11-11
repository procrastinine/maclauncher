const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Binary = require('../src/modules/shared/runtime/binary-compatibility');
const Description = require('../src/modules/shared/runtime/translator-description');
const { resolvePluginLibraries } = require('../src/modules/shared/runtime/native-plugin-libraries');
const Closure = require('../src/modules/crossover/sikarugir/runtime/template-closure');
const { readMachOLoadCommands } = require('../src/modules/shared/runtime/macho-load-commands');
const { image, X64, ARM64 } = require('./fixtures/macho-image');

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
    bytes.writeUInt16LE((item.ordinal << 8) | (item.weak ? 0x40 : 0), offset + 6);
  });
  return bytes;
}
function fixture(t, label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `translator-video-context-${label}-`)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  return { root, put };
}

test('native lookup uses declared paths or actual Sikarugir environment roots, never nearby same-name directories', t => {
  const { root, put } = fixture(t, 'roots'), name = 'libfixture-runtime.dylib';
  const actual = put('package/actual/' + name, native({ exports: ['actual_entry'] }));
  const nearby = put('package/plugins/' + name, native({ exports: ['nearby_entry'] }));
  put('package/' + name, native({ exports: ['parent_entry'] }));
  const support = path.join(root, 'Template.app/Contents'), gstreamer = Closure.gstreamerPaths(support);
  const environmentCore = put(path.relative(root, path.join(gstreamer.lib, name)), native({ exports: ['environment_entry'] }));
  const plugin = put('package/plugins/libselected.dylib', native({ dependencies: ['@rpath/' + name, actual, '@loader_path/' + name] }));
  const nativeImage = readMachOLoadCommands(plugin, { architecture: 'x64' }).slices[0];
  assert.equal(Binary.resolveNativeDependency(plugin, nativeImage, '@rpath/' + name), null);
  assert.equal(Binary.resolveNativeDependency(plugin, nativeImage, '@rpath/' + name, { runPaths: [], libraryPaths: [] }), null);
  assert.equal(Binary.resolveNativeDependency(plugin, nativeImage, actual), actual);
  assert.equal(Binary.resolveNativeDependency(plugin, nativeImage, actual, { runPaths: [], libraryPaths: [] }), actual);
  assert.equal(Binary.resolveNativeDependency(plugin, nativeImage, '@loader_path/' + name), nearby);
  const context = { libraryPaths: [gstreamer.lib] };
  assert.equal(Binary.resolveNativeDependency(plugin, nativeImage, '@rpath/' + name, context), environmentCore);
  assert.equal(Binary.resolveNativeDependency(plugin, nativeImage, actual, context), environmentCore);
  assert.equal(Binary.resolveNativeDependency(plugin, nativeImage, '@loader_path/' + name, context), environmentCore);
  const withRpath = put('package/plugins/libdeclared-rpath.dylib', native({ dependencies: ['@rpath/' + name], runPaths: ['@loader_path/../actual'] }));
  const declaredImage = readMachOLoadCommands(withRpath, { architecture: 'x64' }).slices[0];
  assert.equal(Binary.resolveNativeDependency(withRpath, declaredImage, '@rpath/' + name), actual);
});

for (const transitive of [false, true]) test(`unusable ${transitive ? 'strong transitive dependency of a weak private helper' : 'weak private helper CPU slice'} leaves its usable plugin available`, async t => {
  const { root, put } = fixture(t, transitive ? 'weak-transitive' : 'weak-cpu');
  const executablePath = put('wine/bin/wine', native({ fileType: 2 }));
  put('wine/lib/wine/x86_64-unix/ntdll.so', native({ exports: ['wine_unix_call'] }));
  const plugin = put('component/plugins/libgstoptional.dylib', native({
    dependencies: [{ kind: 0x80000018, path: '@loader_path/../lib/liboptional.dylib' }],
    imports: [{ symbol: 'optional_entry', ordinal: 1, weak: true }] }));
  if (transitive) {
    put('component/lib/liboptional.dylib', native({ exports: ['optional_entry'], dependencies: ['@loader_path/librequired.dylib'],
      imports: [{ symbol: 'required_entry', ordinal: 1 }] }));
    put('component/lib/librequired.dylib', native({ cpu: ARM64, exports: ['required_entry'] }));
  } else put('component/lib/liboptional.dylib', native({ cpu: ARM64, exports: ['optional_entry'] }));
  const description = Description.describeTranslator(path.join(root, 'component'), {
    engine: 'gstreamer', pluginDirectories: ['plugins'], logger: { warn() {} }
  });
  const record = await Binary.wineCompatibilityRecord({ engineRoot: path.join(root, 'wine'), executablePath, architecture: 'x64' }, { nativeRoots: [] });
  const result = await resolvePluginLibraries(description, record, { executableArchitecture: 'x86_64', macOSVersion: '26.0' });
  assert.ok(result.description.files.some(file => file.path === plugin), 'the selected plugin itself has a usable x64 image');
  assert.equal(result.description.videoPreparation.excludedFiles.includes(plugin), false);
  assert.equal(result.description.files.some(file => file.cpuSlices?.length && !file.cpuSlices.includes('x86_64')), false);
});
