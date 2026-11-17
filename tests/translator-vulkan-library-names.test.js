const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Files = require('../src/modules/shared/runtime/translator-files');
const { readMachOLoadCommands } = require('../src/modules/shared/runtime/macho-load-commands');
const { inspectMachOExportInfo } = require('../src/modules/shared/runtime/macho-exports');
const { resolveNativeDependency } = require('../src/modules/shared/runtime/binary-compatibility');
const { image, X64 } = require('./fixtures/macho-image');

const layout = { architecture: 'x86_64', unixName: 'x86_64-unix' };
const mediaExports = ['mvkMTLPixelFormatFromVkFormat', 'mvkMTLTextureTypeFromVkImageType',
  'mvkSampleCountFromVkSampleCountFlagBits', 'vkGetMTLDeviceMVK', 'vkSetMTLTextureMVK'];
const binding = (view, name) => view.links[`lib/wine/${layout.unixName}/${name}`];
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vulkan-library-names-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  const driver = put('driver/libvulkan_kosmickrisp.dylib', image({ cpu: X64, symbols: ['vk_icdGetInstanceProcAddr'] }));
  const loader = put('driver/libvulkan.1.dylib', image({ cpu: X64, installName: '@rpath/libvulkan.1.dylib', symbols: ['vkGetInstanceProcAddr'] }));
  const media = put('framework/lib/libMoltenVK.dylib', image({ cpu: X64, installName: '@rpath/libMoltenVK.dylib', symbols: mediaExports }));
  const plugin = put('framework/lib/plugins/libgstmedia.dylib', image({ cpu: X64,
    dependencies: ['@rpath/libMoltenVK.dylib'], runPaths: ['@loader_path/..'] }));
  const description = { id: 'selected-driver', component: 'vulkan-driver', engine: 'kosmickrisp', root: path.dirname(driver), entryPoint: driver,
    files: [driver, loader].map(file => ({ path: file, format: 'macho', cpuSlices: ['x86_64'] })) };
  const options = { userDataDir: path.join(root, 'profile'), layout };
  const plan = extra => ({ runtime: 'fixture-source', apiMode: true, graphicsSelector: false, vulkanLibrarySelector: false,
    components: { 'vulkan-driver': { used: description, inherited: false, fallback: false } }, ...extra });
  return { root, driver, loader, media, plugin, options, plan };
}

test('authoritative loader names preserve the publisher media MoltenVK ABI', async t => {
  const f = fixture(t), mediaBefore = fs.readFileSync(f.media), pluginBefore = fs.readFileSync(f.plugin);
  const view = await Files.prepareTranslatorFiles(f.plan({ vulkanLibraryNames: ['libvulkan.1.dylib'] }), f.options);
  assert.equal(binding(view, 'libvulkan.1.dylib'), f.loader);
  assert.equal(binding(view, 'libMoltenVK.dylib'), undefined);
  assert.equal(path.resolve(JSON.parse(fs.readFileSync(view.env.VK_DRIVER_FILES)).ICD.library_path), f.driver);
  const pluginImage = readMachOLoadCommands(f.plugin, { architecture: layout.architecture }).slices[0];
  assert.equal(resolveNativeDependency(f.plugin, pluginImage, '@rpath/libMoltenVK.dylib'), f.media);
  const media = await inspectMachOExportInfo(f.media, { arch: layout.architecture });
  const loader = await inspectMachOExportInfo(f.loader, { arch: layout.architecture });
  assert.equal(media.complete, true); assert.equal(loader.complete, true);
  for (const name of mediaExports) { assert.ok(media.exports.includes(name)); assert.ok(!loader.exports.includes(name)); }
  assert.deepEqual(fs.readFileSync(f.media), mediaBefore); assert.deepEqual(fs.readFileSync(f.plugin), pluginBefore);
});

test('a consumer requesting MoltenVK keeps its selected provider independently of selector flags', async t => {
  const f = fixture(t);
  for (const graphicsSelector of [false, true]) {
    const view = await Files.prepareTranslatorFiles(f.plan({ graphicsSelector, vulkanLibrarySelector: true,
      vulkanLibraryNames: ['libMoltenVK.dylib'] }), f.options);
    assert.equal(binding(view, 'libMoltenVK.dylib'), f.loader);
    assert.equal(binding(view, 'libvulkan.1.dylib'), undefined);
    assert.equal(view.env.CX_LIBVULKAN, f.loader);
  }
});

test('requested names form a normalized content identity without replacing an older view', async t => {
  const f = fixture(t), one = await Files.prepareTranslatorFiles(f.plan({ vulkanLibraryNames: ['libvulkan.1.dylib'] }), f.options);
  const other = await Files.prepareTranslatorFiles(f.plan({ vulkanLibraryNames: ['libMoltenVK.dylib'] }), f.options);
  assert.notEqual(one.root, other.root); assert.equal(fs.existsSync(one.root), true);
  const both = await Files.prepareTranslatorFiles(f.plan({ vulkanLibraryNames: ['libvulkan.1.dylib', 'libMoltenVK.dylib'] }), f.options);
  const normalized = await Files.prepareTranslatorFiles(f.plan({ vulkanLibraryNames: ['libMoltenVK.dylib', 'libvulkan.1.dylib', 'libMoltenVK.dylib'] }), f.options);
  assert.equal(normalized.root, both.root); assert.deepEqual(normalized.links, both.links);
  const legacy = await Files.prepareTranslatorFiles(f.plan(), f.options);
  assert.notEqual(legacy.root, both.root); assert.notEqual(legacy.root, one.root);
});

test('missing facts retain legacy bindings while invalid facts fail before creating a view', async t => {
  const f = fixture(t);
  for (const names of [null, [], ['../libvulkan.1.dylib'], ['libunknown.dylib'], ['libvulkan.1.dylib', null]]) {
    await assert.rejects(Files.prepareTranslatorFiles(f.plan({ vulkanLibraryNames: names }), f.options), /Wine Vulkan library names are invalid/);
    assert.equal(fs.existsSync(f.options.userDataDir), false);
  }
  const ordinary = await Files.prepareTranslatorFiles(f.plan(), f.options);
  assert.equal(binding(ordinary, 'libMoltenVK.dylib'), f.loader); assert.equal(binding(ordinary, 'libvulkan.1.dylib'), f.loader);
  const selector = await Files.prepareTranslatorFiles(f.plan({ graphicsSelector: true }), f.options);
  assert.equal(binding(selector, 'libMoltenVK.dylib'), f.loader); assert.equal(binding(selector, 'libvulkan.1.dylib'), undefined);
});
