const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const Environments = require('../src/modules/shared/runtime/wine-environment');
const Files = require('../src/modules/shared/runtime/translator-files');
const { readWindowsExecutable } = require('../src/modules/crossover/detect');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

function pe({ is64 = false, builtin = false, game = false } = {}) {
  const fixture = peFixture({ is64 });
  fixture.bytes.writeUInt16LE(game ? 2 : 0x2002, fixture.peOffset + 22);
  if (game) fixture.bytes.writeUInt16LE(2, fixture.optional + 68);
  if (builtin) fixture.bytes.write('Wine builtin DLL\0', 64);
  return fixture.bytes;
}

test('real per-API wrapper preparation writes only explicit native API8 and preserves inherited D9VK and CNC prefix bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-api-inherited-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  const contents = 'Synthetic.app/Contents', wrapper = path.join(root, 'Synthetic.app');
  put(contents + '/Info.plist', '<?xml version="1.0"?><plist version="1.0"><dict><key>Program Name and Path</key><string>Game.exe</string><key>CFBundleVersion</key><string>1.0.26</string><key>D9VK</key><integer>1</integer><key>CNC_DDRAW</key><integer>1</integer></dict></plist>');
  for (const name of ['wine', 'wineserver']) put(`${contents}/SharedSupport/wine/bin/${name}`, image({ cpu: X64, fileType: 2 }));
  put(contents + '/SharedSupport/wine/lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64, symbols: ['wine_unix_call'] }));
  for (const is64 of [false, true]) for (const name of ['ntdll', 'apisetschema'])
    put(`${contents}/SharedSupport/wine/lib/wine/${is64 ? 'x86_64' : 'i386'}-windows/${name}.dll`, pe({ is64, builtin: true }));
  put(contents + '/SharedSupport/prefix/system.reg', 'WINE REGISTRY Version 2');
  put(contents + '/SharedSupport/prefix/user.reg', 'WINE REGISTRY Version 2');
  put(contents + '/SharedSupport/renderer/dxmt/wine/i386-windows/d3d11.dll', pe({ builtin: true }));
  put(contents + '/SharedSupport/renderer/dxmt/wine/x86_64-unix/winemetal.so', image({ cpu: X64 }));
  const d9Source = put(contents + '/SharedSupport/renderer/d9vk/wine/i386-windows/d3d9.dll', pe());
  const cncSource = put(contents + '/SharedSupport/renderer/cnc_ddraw/wine/i386-windows/ddraw.dll', pe());
  put(contents + '/Frameworks/libvulkan_kosmickrisp.dylib', image({ cpu: X64 }));
  put(contents + '/Frameworks/libvulkan.1.dylib', image({ cpu: X64 }));
  put(contents + '/Resources/vulkan/icd.d/kosmickrisp_mesa_icd.json', JSON.stringify({ file_format_version: '1.0.0',
    ICD: { library_path: '../../../Frameworks/libvulkan_kosmickrisp.dylib', api_version: '1.4.0' } }));
  const d8Source = put('historical-d8vk/d3d8.dll', pe()), game = put('game/Game.exe', pe({ game: true }));
  const d8 = Description.describeTranslator(path.dirname(d8Source), { id: 'historical-d8vk', engine: 'd8vk', source: 'custom', version: '1.0' });
  const record = Environments.readEnvironment({ kind: 'sikarugir-wrapper', path: wrapper });
  // The shared reader supplies the wrapper; these normalized controls model
  // its inherited automatic composition with its actual staged Kosmic driver.
  record.settings = { ...record.settings, graphicsBackend: 'auto', vulkanBackend: 'kosmickrisp', d9vk: true, cncDdraw: true };
  const d9 = put(contents + '/SharedSupport/prefix/drive_c/windows/syswow64/d3d9.dll', 'existing D9 DLL sentinel');
  const cnc = put(contents + '/SharedSupport/prefix/drive_c/windows/syswow64/ddraw.dll', 'existing CNC DLL sentinel');
  const context = { userDataDir: path.join(root, 'profile'), settings: {}, wineEnvironment: record, logger: { warn() {} },
    runtimeSettings: { translatorRenderer: 'inherit', translatorVulkan: 'inherit', translatorD3D8: d8.id, cncDdraw: 'inherit' } };
  const options = { managers: [], choices: [d8], executableArchitecture: readWindowsExecutable(game).executableArchitecture,
    host: { macOSVersion: '26.0', physicalAppleGPU: false } };
  assert.equal(options.executableArchitecture, 'x86');
  const plan = await Translators.resolve(record.install, 'sikarugir', context, options);
  assert.equal(plan.apiMode, true); assert.equal(plan.components.d3d8.used.id, d8.id);
  assert.equal(plan.components.d3d9.used.templateComponent, 'd9vk'); assert.equal(plan.components.d3d9.inherited, true);
  assert.ok(plan.additional.find(item => item.templateComponent === 'cnc_ddraw').inherited);
  const view = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout, logger: context.logger });
  assert.deepEqual(view.native.map(file => file.name), ['d3d8.dll']);
  await Files.applyNativeLibraries(view, record.prefixPath);
  assert.equal(fs.readFileSync(d9, 'utf8'), 'existing D9 DLL sentinel'); assert.equal(fs.readFileSync(cnc, 'utf8'), 'existing CNC DLL sentinel');
  assert.equal(fs.lstatSync(d9).isSymbolicLink(), false); assert.equal(fs.lstatSync(cnc).isSymbolicLink(), false);
  const ledgerPath = path.join(record.prefixPath, '.maclauncher-translators.json');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))), ['syswow64/d3d8.dll']);
  const placedD8 = path.join(record.prefixPath, 'drive_c/windows/syswow64/d3d8.dll');
  assert.equal(fs.realpathSync(placedD8), d8Source);

  const explicit = { ...context, runtimeSettings: { ...context.runtimeSettings, translatorD3D9: plan.components.d3d9.used.id, cncDdraw: true } };
  const changed = await Translators.resolve(record.install, 'sikarugir', explicit, options);
  assert.equal(changed.apiMode, true); assert.equal(changed.components.d3d9.inherited, false);
  const override = await Files.prepareTranslatorFiles(changed, { userDataDir: context.userDataDir, layout: changed.layout, logger: context.logger });
  assert.deepEqual(override.native.map(file => file.name).sort(), ['d3d8.dll', 'd3d9.dll', 'ddraw.dll']);
  await Files.applyNativeLibraries(override, record.prefixPath);
  assert.equal(fs.realpathSync(d9), d9Source); assert.equal(fs.realpathSync(cnc), cncSource);
  await Files.applyNativeLibraries({ native: [] }, record.prefixPath);
  assert.equal(fs.readFileSync(d9, 'utf8'), 'existing D9 DLL sentinel'); assert.equal(fs.readFileSync(cnc, 'utf8'), 'existing CNC DLL sentinel');
  assert.equal(fs.existsSync(placedD8), false);
});
