const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const Files = require('../src/modules/shared/runtime/translator-files');
const WineSettings = require('../src/modules/shared/runtime/wine-settings');
const CrossLaunch = require('../src/modules/crossover/runtime/launch');
const SikaLaunch = require('../src/modules/crossover/sikarugir/launch');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

function dll({ builtin = true, metalImport = false, metalExport = false, is64 = true } = {}) {
  const fixture = peFixture({ is64 }); fixture.bytes.writeUInt16LE(0x2002, fixture.peOffset + 22);
  if (builtin) fixture.bytes.write('Wine builtin DLL\0', 64);
  if (metalImport) {
    const raw = fixture.raw, rva = 0x2000;
    fixture.bytes.writeUInt32LE(rva + 0x700, fixture.directories + 8); fixture.bytes.writeUInt32LE(40, fixture.directories + 12);
    fixture.bytes.writeUInt32LE(rva + 0x740, raw + 0x700); fixture.bytes.writeUInt32LE(rva + 0x780, raw + 0x70c);
    fixture.bytes.writeUInt32LE(rva + 0x760, raw + 0x710);
    for (const offset of [0x740, 0x760]) fixture.bytes.writeBigUInt64LE(BigInt(rva + 0x7a0), raw + offset);
    fixture.bytes.write('winemetal.dll\0', raw + 0x780); fixture.bytes.write('wine_metal_entry\0', raw + 0x7a2);
  }
  if (metalExport) {
    const raw = fixture.raw;
    fixture.bytes.writeUInt32LE(0x2600, fixture.directories); fixture.bytes.writeUInt32LE(0x80, fixture.directories + 4);
    for (const [offset, value] of [[16, 1], [20, 1], [24, 1], [28, 0x2640], [32, 0x2644], [36, 0x2648]]) fixture.bytes.writeUInt32LE(value, raw + 0x600 + offset);
    fixture.bytes.writeUInt32LE(0x2900, raw + 0x640); fixture.bytes.writeUInt32LE(0x2650, raw + 0x644);
    fixture.bytes.write('wine_metal_entry\0', raw + 0x650); fixture.bytes[raw + 0x900] = 0xc3;
    fixture.bytes.writeUInt32LE(0x60000020, fixture.section + 36);
  }
  return fixture.bytes;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-api-action-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const vendor = path.join(root, 'wine');
  for (const name of ['wine', 'wineserver', 'wineloader']) put('wine/bin/' + name, image({ cpu: X64, fileType: 2 }));
  put('wine/lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64, symbols: ['wine_unix_call'] }));
  put('wine/lib/wine/x86_64-unix/wine', image({ cpu: X64, fileType: 2 }));
  for (const name of ['ntdll', 'apisetschema']) put(`wine/lib/wine/x86_64-windows/${name}.dll`, dll());
  for (const name of ['d3d10core', 'd3d11', 'dxgi']) put(`wine/lib/dxmt/x86_64-windows/${name}.dll`, dll({ metalImport: name === 'd3d11' }));
  put('wine/lib/dxmt/x86_64-windows/winemetal.dll', dll({ metalExport: true }));
  put('wine/lib/dxmt/x86_64-unix/winemetal.so', image({ cpu: X64, symbols: ['wine_metal_entry'] }));
  put('native/d3d9.dll', dll({ builtin: false }));
  for (const name of ['d3d9', 'd3d11', 'dxgi']) put(`all/${name}.dll`, dll({ builtin: false }));
  const installs = ['native', 'all'].map(version => ({ version, architecture: 'x64', translatorRoot: path.join(root, version),
    installDir: path.join(root, version), translator: Description.describeTranslator(path.join(root, version), { engine: 'dxvk', source: 'fixture', version }) }));
  const manager = { id: 'fixture-dxvk', translatorEngine: 'dxvk', getState: () => ({ installed: installs }),
    resolveSelection: (_entry, _settings, _userData, options) => ({ ready: true, install: installs.find(item => item.version === options.version), architecture: options.architecture }) };
  const install = { crossoverRoot: vendor, engineRoot: vendor, installDir: vendor, version: 'fixture-wine', upstreamVersion: '26.3',
    executablePath: path.join(vendor, 'bin/wine'), loaderPath: path.join(vendor, 'bin/wineloader'), serverPath: path.join(vendor, 'bin/wineserver'), needsRosetta: false };
  const game = peFixture({ is64: true }); game.bytes.writeUInt16LE(2, game.peOffset + 22); game.bytes.writeUInt16LE(3, game.optional + 68);
  const executable = put('game/Game.exe', game.bytes), entry = { gameId: 'api-fixture', gamePath: path.dirname(executable), runtimeId: 'crossover', runtimeData: {
    crossover: { sourceRoot: path.dirname(executable), windowsExecutablePath: executable, executableArchitecture: 'x86_64', detectionComplete: true } } };
  const context = settings => ({ runtimeId: 'crossover', settings: {}, runtimeSettings: settings, userDataDir: path.join(root, 'profile'), logger: { warn() {} } });
  const host = { platform: 'darwin', hardwareArch: 'arm64', macOSVersion: '26.0', physicalAppleGPU: false };
  return { root, put, install, manager, installs, entry, context, host };
}

test('real translator options action resolves draft API roles and advertises atomic affected-key patches', async t => {
  const f = fixture(t), registry = require('../src/modules/registry'), runtimeManager = require('../src/modules/crossover/runtime/manager');
  t.mock.method(registry, 'listSharedRuntimeManagers', () => [f.manager]); t.mock.method(registry, 'listModuleIds', () => []);
  t.mock.method(runtimeManager, 'resolveSelection', () => ({ ready: true, install: f.install }));
  const Main = require('../src/modules/crossover/main'), saved = { translatorRenderer: 'included:d3d-renderer:dxmt', translatorD3D9: 'missing-saved-choice' }, context = f.context(saved);
  const result = await Main.actions.listTranslatorOptions(f.entry, { runtimeSettings: { translatorD3D9: 'fixture-dxvk:native' } }, context);
  const role = result.translatorRoles.find(item => item.id === 'd3d9');
  assert.equal(role.value, 'fixture-dxvk:native'); assert.equal(role.used.id, 'fixture-dxvk:native');
  assert.equal(role.optionsKey, 'translatorD3D9Options'); assert.ok(Array.isArray(result[role.optionsKey]));
  assert.equal(context.runtimeSettings.translatorD3D9, 'missing-saved-choice', 'a draft options read never writes saved settings');
  const linked = result.translatorD3D11Options.find(item => item.value === 'fixture-dxvk:all');
  assert.ok(linked.affectedRoles.includes('d3d10') && linked.affectedRoles.includes('d3d11'));
  assert.deepEqual(linked.runtimeSettingsPatch, { translatorD3D10: 'automatic', translatorD3D11: 'fixture-dxvk:all' });
  assert.ok(result.translatorGroups.some(group => group.roles.includes('d3d10') && group.roles.includes('d3d11')));
  const resolvedContext = f.context({ ...saved, translatorD3D9: 'fixture-dxvk:native' });
  const plan = await Translators.resolve(f.install, 'crossover', resolvedContext, { host: f.host, executableArchitecture: 'x86_64', managers: [f.manager] });
  assert.equal(resolvedContext.translatorPlan, plan); assert.equal(plan.apiMode, true);
  assert.equal(plan.components.d3d11.used.engine, 'dxmt'); assert.equal(plan.components.d3d11.projected, true);
  assert.equal(plan.compatibility['fixture-dxvk:native'].compatible, true);
});

test('real API resolver and both Wine environment builders compose all actual used settings once', async t => {
  const f = fixture(t), settings = { translatorRenderer: 'included:d3d-renderer:dxmt', translatorD3D9: 'fixture-dxvk:native',
    dxvkHud: 'fps', dxmtConfig: 'fixture_config=1', dlss: false }, context = f.context(settings);
  const plan = await Translators.resolve(f.install, 'crossover', context, { host: f.host, executableArchitecture: 'x86_64', managers: [f.manager] });
  assert.equal(plan.apiMode, true);
  const view = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout });
  assert.equal(view.env.CX_GRAPHICS_BACKEND, 'wined3d');
  assert.deepEqual(view.native.map(file => file.source), [path.join(f.root, 'native/d3d9.dll')]);
  assert.equal(fs.realpathSync(view.links['lib/wine/x86_64-windows/d3d11.dll']), path.join(f.root, 'wine/lib/dxmt/x86_64-windows/d3d11.dll'));
  assert.equal(fs.realpathSync(view.links['lib/wine/x86_64-unix/winemetal.so']), path.join(f.root, 'wine/lib/dxmt/x86_64-unix/winemetal.so'));
  const original = WineSettings.environment, calls = [];
  t.mock.method(WineSettings, 'environment', (settings, options) => { calls.push(options.engines); return original(settings, options); });
  const cross = CrossLaunch.buildEnvironment(Translators.settingsForPlan(settings, plan), f.install, path.join(f.root, 'game-state'), path.join(f.root, 'bottle'),
    { translatorPlan: plan, executableArchitecture: 'x86_64', host: f.host, baseEnvironment: {} });
  assert.equal(calls.length, 1);
  for (const environment of [cross.environment, cross.overrides]) {
    assert.equal(environment.DXVK_HUD, 'fps'); assert.equal(environment.DXMT_CONFIG, 'fixture_config=1'); assert.equal(environment.CX_GRAPHICS_BACKEND, 'wined3d');
  }
  fs.mkdirSync(path.join(f.root, 'sika/Frameworks/renderer'), { recursive: true });
  fs.symlinkSync(path.join(f.root, 'wine/lib/dxmt'), path.join(f.root, 'sika/Frameworks/renderer/dxmt'));
  const sikaInstall = { ...f.install, templateRoot: path.join(f.root, 'sika') }, sikaContext = f.context(settings);
  const sikaPlan = await Translators.resolve(sikaInstall, 'sikarugir', sikaContext, { host: f.host, executableArchitecture: 'x86_64', managers: [f.manager] });
  const sika = SikaLaunch.buildEnvironment(Translators.settingsForPlan(settings, sikaPlan), sikaInstall, path.join(f.root, 'sika-state'), path.join(f.root, 'prefix'), {},
    { translatorPlan: sikaPlan, baseEnvironment: {} });
  assert.equal(calls.length, 2, 'each runtime invokes the shared settings composer once');
  assert.equal(sika.environment.DXVK_HUD, 'fps'); assert.equal(sika.environment.DXMT_CONFIG, 'fixture_config=1');
  for (const engines of calls) assert.deepEqual(new Set(engines['d3d-renderer']), new Set(['dxvk', 'dxmt']));
});

test('real per-API resolver keeps unresolved CrossOver Automatic honest without selecting every API', async t => {
  const f = fixture(t), context = f.context({ translatorD3D9: 'fixture-dxvk:native' });
  const plan = await Translators.resolve(f.install, 'crossover', context, { host: f.host, executableArchitecture: 'x86_64', managers: [f.manager] });
  assert.equal(context.translatorPlan, plan); assert.equal(plan.apiMode, false);
  assert.equal(plan.components.d3d9.selected.id, 'fixture-dxvk:native'); assert.equal(plan.components.d3d9.used, null);
  assert.equal(plan.components.d3d9.fallback, true); assert.match(plan.components.d3d9.reason, /global backend/);
  assert.equal(Translators.settingsForPlan(context.runtimeSettings, plan).graphicsBackend || 'auto', 'auto');
  assert.equal(Object.hasOwn(context.runtimeSettings, 'translatorD3D11'), false);
});

test('API-mode preparation retains exact independent Vulkan and video source files', async t => {
  const f = fixture(t), driver = f.put('vulkan/driver.dylib', image({ cpu: X64 }));
  f.put('vulkan/libvulkan.1.dylib', image({ cpu: X64 }));
  f.put('vulkan/driver.json', JSON.stringify({ ICD: { library_path: './driver.dylib', api_version: '1.4.0' } }));
  f.put('video/plugins/a.dylib', image({ cpu: X64 })); f.put('video/plugins/more/b.dylib', image({ cpu: X64 }));
  const manager = (id, engine, relative) => {
    const translatorRoot = path.join(f.root, relative), installed = { version: '1', architecture: 'x64', translatorRoot, installDir: translatorRoot,
      translator: Description.describeTranslator(translatorRoot, { engine, source: 'fixture' }) };
    return { id, translatorEngine: engine, getState: () => ({ installed: [installed] }),
      resolveSelection: () => ({ ready: true, install: installed, architecture: 'x64' }) };
  };
  const driverManager = manager('fixture-driver', 'kosmickrisp', 'vulkan'), videoManager = manager('fixture-video', 'gstreamer', 'video');
  const context = f.context({ translatorRenderer: 'included:d3d-renderer:dxmt', translatorD3D9: 'fixture-dxvk:native',
    translatorVulkan: 'fixture-driver:1', translatorVideo: 'fixture-video:1' });
  const plan = await Translators.resolve(f.install, 'crossover', context, { host: f.host, executableArchitecture: 'x86_64',
    managers: [f.manager, driverManager, videoManager] });
  assert.equal(plan.apiMode, true);
  const selected = Files.selectedDescriptions(plan);
  for (const key of ['vulkan-driver', 'video']) {
    const used = plan.components[key].used;
    assert.deepEqual(selected.find(item => item.id === used.id).files.map(file => file.path), used.files.map(file => file.path));
  }
  const view = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout });
  assert.equal(JSON.parse(fs.readFileSync(view.env.VK_DRIVER_FILES, 'utf8')).ICD.library_path, driver);
  assert.deepEqual(new Set(view.env.GST_PLUGIN_PATH.split(path.delimiter)),
    new Set([path.join(f.root, 'video/plugins'), path.join(f.root, 'video/plugins/more')]));
  assert.equal(view.links['lib/wine/x86_64-unix/libMoltenVK.dylib'], path.join(f.root, 'vulkan/libvulkan.1.dylib'));
});

test('real API9 compatibility and materialization ignore an unused high-floor API11 companion', async t => {
  const f = fixture(t), translatorRoot = path.join(f.root, 'mixed');
  const d3d9 = f.put('mixed/d3d9.dll', dll({ builtin: false }));
  f.put('mixed/d3d11.dll', dll({ builtin: false }));
  f.put('mixed/d3d11.so', image({ cpu: X64, minimumOS: 0x00630000 }));
  f.installs.push({ version: 'mixed', architecture: 'x64', translatorRoot, installDir: translatorRoot,
    translator: Description.describeTranslator(translatorRoot, { engine: 'dxvk', source: 'fixture', version: 'mixed' }) });
  const context = f.context({ translatorRenderer: 'included:d3d-renderer:dxmt', translatorD3D9: 'fixture-dxvk:mixed' });
  const plan = await Translators.resolve(f.install, 'crossover', context, { host: f.host, executableArchitecture: 'x86_64', managers: [f.manager] });
  assert.equal(plan.compatibility['fixture-dxvk:mixed'].compatible, false, 'the retained package really contains a macOS 99 module');
  assert.equal(plan.components.d3d9.used.id, 'fixture-dxvk:mixed'); assert.equal(plan.components.d3d9.fallback, false);
  assert.deepEqual(plan.components.d3d9.used.files.map(file => file.path), [d3d9]);
  assert.equal(plan.apiMode, true);
  const view = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout });
  assert.deepEqual(view.native.map(file => file.source), [d3d9]);
  assert.equal(plan.placements.some(item => item.file.path.startsWith(translatorRoot) && item.file.path !== d3d9), false);
});

test('real API11 imported PE machine failure retains the coherent CrossOver shared default', async t => {
  const f = fixture(t), translatorRoot = path.join(f.root, 'wrong-machine');
  f.put('wrong-machine/x86_64-windows/d3d11.dll', dll({ builtin: false, metalImport: true }));
  f.put('wrong-machine/x86_64-windows/dxgi.dll', dll({ builtin: false }));
  const helper = f.put('wrong-machine/i386-windows/winemetal.dll', dll({ builtin: false, is64: false }));
  f.put('wrong-machine/x86_64-unix/winemetal.so', image({ cpu: X64, symbols: ['wine_metal_entry'] }));
  const translator = Description.describeTranslator(translatorRoot, { engine: 'dxvk', source: 'fixture', version: 'wrong-machine' });
  assert.equal(translator.files.find(file => file.path === helper).machine, 0x14c);
  f.installs.push({ version: 'wrong-machine', architecture: 'x64', translatorRoot, installDir: translatorRoot, translator });
  const context = f.context({ translatorRenderer: 'included:d3d-renderer:dxmt', translatorD3D11: 'fixture-dxvk:wrong-machine' });
  const plan = await Translators.resolve(f.install, 'crossover', context, { host: f.host, executableArchitecture: 'x86_64', managers: [f.manager] });
  assert.equal(plan.compatibility['fixture-dxvk:wrong-machine'].compatible, true, 'inventory-only missing-slice suppression would miss the required PE import');
  assert.equal(plan.components.d3d11.selected.id, 'fixture-dxvk:wrong-machine'); assert.equal(plan.components.d3d11.fallback, true);
  assert.match(plan.components.d3d11.reason, /No PE machine.*winemetal\.dll/);
  assert.equal(plan.components.d3d11.used.id, 'included:d3d-renderer:dxmt');
  assert.equal(plan.components.d3d10.used.id, 'included:d3d-renderer:dxmt');
  assert.equal(plan.apiMode, false, 'an invalid imported slice must not activate a partial private override');
  assert.equal(Translators.settingsForPlan(context.runtimeSettings, plan).graphicsBackend, 'dxmt');
  const view = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout });
  assert.equal(view.native.length, 0); assert.equal(view.env.CX_GRAPHICS_BACKEND, 'dxmt');
});
