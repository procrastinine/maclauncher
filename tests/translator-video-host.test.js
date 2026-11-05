const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { image, X64 } = require('./fixtures/macho-image');
const { readMachOLoadCommands } = require('../src/modules/shared/runtime/macho-load-commands');
const { wineCompatibilityRecord, resolveNativeDependency, libraryExport } = require('../src/modules/shared/runtime/binary-compatibility');

function native({ exports = ['entry'], imports = [], reexport, ...options } = {}) {
  const trieCommand = reexport ? Buffer.alloc(16) : null;
  if (trieCommand) { trieCommand.writeUInt32LE(0x80000033, 0); trieCommand.writeUInt32LE(16, 4); }
  let bytes = image({ cpu: X64, ...options, symbols: [...exports, ...imports.map(item => item.symbol)],
    extraCommands: [...(options.extraCommands || []), ...(trieCommand ? [trieCommand] : [])] });
  bytes.writeUInt32LE(0x80, 24); // MH_TWOLEVEL: import ordinals identify real dependency commands.
  let command = 32, symbols, trieOffset;
  for (let i = 0; i < bytes.readUInt32LE(16); i++) {
    if (bytes.readUInt32LE(command) === 2) symbols = bytes.readUInt32LE(command + 8);
    if (trieCommand && bytes.readUInt32LE(command) === 0x80000033) trieOffset = command;
    command += bytes.readUInt32LE(command + 4);
  }
  imports.forEach((item, i) => {
    const offset = symbols + (exports.length + i) * 16;
    bytes[offset + 4] = 1; bytes[offset + 5] = 0; // N_UNDF | N_EXT
    bytes.writeUInt16LE((item.ordinal << 8) | (item.weak ? 0x40 : 0), offset + 6);
  });
  if (trieCommand) {
    const edge = Buffer.from('_' + reexport.symbol + '\0'), imported = Buffer.from('_' + reexport.imported + '\0');
    const terminal = Buffer.concat([Buffer.from([8, reexport.ordinal]), imported]);
    const trie = Buffer.concat([Buffer.from([0, 1]), edge, Buffer.from([3 + edge.length, terminal.length]), terminal, Buffer.from([0])]);
    bytes.writeUInt32LE(bytes.length, trieOffset + 8); bytes.writeUInt32LE(trie.length, trieOffset + 12);
    bytes = Buffer.concat([bytes, trie]);
  }
  return bytes;
}
function fixture(t, name) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `translator-video-${name}-`)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  return { root, put };
}
function installAt(put, relative) {
  const executablePath = put(`${relative}/bin/wine`, native({ fileType: 2 }));
  const ntdll = put(`${relative}/lib/wine/x86_64-unix/ntdll.so`, native({ exports: ['wine_unix_call'] }));
  return { install: { engineRoot: path.dirname(path.dirname(executablePath)), executablePath, architecture: 'x64' }, ntdll };
}

test('opt-in CrossOver closure follows actual rpaths, canonical aliases and reexports without scanning lib64', async t => {
  const { root, put } = fixture(t, 'crossover'), { install, ntdll } = installAt(put, 'CrossOver');
  const host = put('CrossOver/lib/wine/x86_64-unix/winegstreamer.so', native({
    dependencies: ['@rpath/libgstvideo-1.0.0.dylib', '@loader_path/ntdll.so', '/usr/lib/libSystem.B.dylib'],
    runPaths: ['@loader_path/', '@loader_path/../../../lib64'],
    imports: [{ symbol: 'gst_init', ordinal: 1 }, { symbol: 'wine_unix_call', ordinal: 2 }] }));
  const video = put('CrossOver/lib64/libgstvideo-1.0.0.dylib', native({ installName: '@rpath/libgstvideo-1.0.0.dylib',
    dependencies: [{ kind: 0x8000001f, path: '@rpath/libgstreamer-1.0.0.dylib' }],
    reexport: { symbol: 'aliased_init', ordinal: 1, imported: 'gst_init' } }));
  const core = put('CrossOver/lib64/libgstreamer-1.0.0.dylib', native({ exports: ['gst_init'],
    installName: '@rpath/libgstreamer-1.0.0.dylib', dependencies: ['@loader_path/libgobject-2.0.0.dylib'] }));
  const object = put('CrossOver/lib64/libgobject-2.0.0.dylib', native({ exports: ['g_object_ref'],
    installName: '@rpath/libgobject-2.0.0.dylib', dependencies: ['@loader_path/libvideo-alias.dylib'] }));
  fs.symlinkSync(path.basename(video), path.join(path.dirname(video), 'libvideo-alias.dylib'));
  const unrelated = put('CrossOver/lib64/unconsumed.dylib', 'not a native image');
  const ordinary = await wineCompatibilityRecord(install);
  assert.equal(ordinary.libraries, undefined); assert.equal(ordinary.modules['winegstreamer.so'].image.imports, undefined);
  const record = await wineCompatibilityRecord(install, { nativeRoots: [] });
  assert.equal(record.executablePath, install.executablePath);
  assert.deepEqual(Object.keys(record.libraries).sort(), [host, ntdll, video, core, object].map(file => fs.realpathSync(file)).sort());
  assert.equal(record.libraries[host].dependencies['@rpath/libgstvideo-1.0.0.dylib'], video);
  assert.equal(record.libraries[object].dependencies['@loader_path/libvideo-alias.dylib'], video);
  assert.equal(libraryExport(record, video, 'gst_init'), true);
  assert.equal(libraryExport(record, video, 'aliased_init'), true);
  assert.equal(libraryExport(record, video, 'g_object_ref'), false); // A different loaded library is not a reexport.
  assert.equal(libraryExport(record, video, 'absent_required_symbol'), false);
  assert.equal(libraryExport(record, ntdll, 'wine_unix_call'), true);
  assert.equal(resolveNativeDependency(host, record.libraries[host].image, '@executable_path/../lib64/libgstreamer-1.0.0.dylib',
    { executablePath: install.executablePath }), core);
  assert.ok(record.libraries[host].runPaths.includes(path.join(root, 'CrossOver/lib64')));
  assert.equal(record.warnings.some(warning => warning.includes(unrelated)), false);
  assert.deepEqual(record.warnings, []);
});

test('source-owned Sikarugir roots resolve its host core and take precedence over a plugin SDK copy', async t => {
  const { put } = fixture(t, 'sikarugir'), { install } = installAt(put, 'Template.app/Contents/SharedSupport/wine');
  const host = put('Template.app/Contents/SharedSupport/wine/lib/wine/x86_64-unix/winegstreamer.so', native({
    dependencies: ['@rpath/libgstreamer-1.0.0.dylib'], imports: [{ symbol: 'gst_init', ordinal: 1 }] }));
  const core = put('Template.app/Contents/Frameworks/GStreamer.framework/Versions/1.0/lib/libgstreamer-1.0.0.dylib', native({
    installName: '@rpath/libgstreamer-1.0.0.dylib', exports: ['gst_init'], dependencies: ['@loader_path/libgobject-2.0.0.dylib'] }));
  const object = put('Template.app/Contents/Frameworks/GStreamer.framework/Versions/1.0/lib/libgobject-2.0.0.dylib', native({
    installName: '@rpath/libgobject-2.0.0.dylib', exports: ['g_object_ref'] }));
  const sdk = put('package/lib/libgstreamer-1.0.0.dylib', native({ exports: ['different_core'] }));
  const plugin = put('package/lib/gstreamer-1.0/libplugin.dylib', native({
    dependencies: ['@rpath/libgstreamer-1.0.0.dylib'], runPaths: ['@loader_path/..'], imports: [{ symbol: 'gst_init', ordinal: 1 }] }));
  const record = await wineCompatibilityRecord(install, { nativeRoots: [path.dirname(core)] });
  assert.equal(record.libraries[host].dependencies['@rpath/libgstreamer-1.0.0.dylib'], core);
  assert.equal(record.libraries[core].dependencies['@loader_path/libgobject-2.0.0.dylib'], object);
  const pluginImage = readMachOLoadCommands(plugin, { architecture: 'x64', imports: true }).slices[0];
  assert.equal(resolveNativeDependency(plugin, pluginImage, pluginImage.dependencies[0].path), sdk);
  assert.equal(resolveNativeDependency(plugin, pluginImage, pluginImage.dependencies[0].path,
    { executablePath: record.executablePath, libraryPaths: [path.dirname(core)] }), core);
  assert.equal(libraryExport(record, core, 'gst_init'), true);
  assert.equal(libraryExport(record, object, 'g_object_ref'), true);
  assert.equal(record.libraries[sdk], undefined);
});

test('weak or unresolved dependencies and incomplete export inspection remain unknown', async t => {
  const { put } = fixture(t, 'unknown'), { install } = installAt(put, 'Wine');
  const host = put('Wine/lib/wine/x86_64-unix/winegstreamer.so', native({
    dependencies: ['@rpath/incomplete.dylib', '@rpath/known.dylib', { kind: 0x80000018, path: '@rpath/optional.dylib' },
      { kind: 0x8000001f, path: '@rpath/unavailable-reexport.dylib' }, '/usr/lib/libSystem.B.dylib'],
    runPaths: ['@loader_path/../../../lib64'], imports: [{ symbol: 'required', ordinal: 2 },
      { symbol: 'optional_symbol', ordinal: 3, weak: true }, { symbol: 'system_symbol', ordinal: 5 }] }));
  const malformedExports = Buffer.alloc(16); malformedExports.writeUInt32LE(0x80000033, 0); malformedExports.writeUInt32LE(16, 4);
  malformedExports.writeUInt32LE(0x100000, 8); malformedExports.writeUInt32LE(1, 12);
  const incomplete = put('Wine/lib64/incomplete.dylib', native({ extraCommands: [malformedExports] }));
  const known = put('Wine/lib64/known.dylib', native({ exports: ['required'] }));
  const record = await wineCompatibilityRecord(install, { nativeRoots: [] });
  assert.equal(record.libraries[host].image.imports.find(item => item.symbol === 'optional_symbol').weak, true);
  assert.equal(record.libraries[host].dependencies['@rpath/optional.dylib'], null);
  assert.equal(record.libraries[host].dependencies['/usr/lib/libSystem.B.dylib'], null);
  assert.equal(record.libraries[incomplete].complete, false);
  assert.equal(record.libraries[incomplete].image.importsComplete, true);
  assert.equal(libraryExport(record, incomplete, 'unestablished'), null);
  assert.equal(libraryExport(record, known, 'required'), true);
  assert.equal(libraryExport(record, known, 'missing_required'), false);
  assert.equal(libraryExport(record, host, 'missing_with_unknown_reexport'), null);
  assert.equal(libraryExport(record, path.join(path.dirname(known), 'optional.dylib'), 'optional_symbol'), null);
  assert.ok(record.warnings.some(warning => warning.includes('incomplete.dylib')));
  assert.ok(record.warnings.some(warning => warning.includes('optional.dylib')));
  assert.equal(record.warnings.some(warning => warning.includes('/usr/lib/libSystem.B.dylib')), false);
});
