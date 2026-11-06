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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-api-action-')));
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

test('saved KosmicKrisp manager IDs retain their installed choice through both Wine actions and resolvers', async t => {
  const f = fixture(t), Managed = require('../src/modules/shared/vulkan/managed'), Plan = require('../src/modules/shared/runtime/translator-plan');
  const version = '27.0.0-devel-MCLv8', saved = `${Managed.manager.formerIds[0]}:${version}`, canonical = `${Managed.projectId}:${version}`;
  const relative = `profile/runtimes/${Managed.manager.formerIds[0]}/x64/${version}/payload/files`;
  const driver = f.put(`${relative}/libvulkan_kosmickrisp.dylib`, image({ cpu: X64 }));
  f.put(`${relative}/libvulkan.1.dylib`, image({ cpu: X64 }));
  const root = path.dirname(driver), installed = { version, architecture: 'x64', translatorRoot: root, installDir: root,
    executablePath: driver, translator: Description.describeTranslator(root, { engine: 'kosmickrisp', source: Managed.manager.formerIds[0], version }) };
  const manager = Managed.createManager();
  t.mock.method(manager, 'getState', () => ({ installed: [installed] }));
  t.mock.method(manager, 'resolveSelection', (_entry, _settings, _data, options) => {
    assert.equal(options.version, version); assert.equal(options.architecture, 'x64');
    return { ready: true, install: installed, architecture: 'x64' };
  });
  const registry = require('../src/modules/registry');
  t.mock.method(registry, 'listSharedRuntimeManagers', () => [manager]); t.mock.method(registry, 'listModuleIds', () => []);
  const Main = require('../src/modules/crossover/main');
  fs.mkdirSync(path.join(f.root, 'template'));
  for (const runtime of ['crossover', 'sikarugir']) {
    const runtimeManager = require(runtime === 'crossover' ? '../src/modules/crossover/runtime/manager' : '../src/modules/crossover/sikarugir/runtime/manager');
    const install = runtime === 'crossover' ? f.install : { ...f.install, templateRoot: path.join(f.root, 'template') };
    t.mock.method(runtimeManager, 'resolveSelection', () => ({ ready: true, install }));
    const context = { ...f.context({ translatorVulkan: saved }), runtimeId: runtime }, entry = { ...f.entry, runtimeId: runtime };
    const before = JSON.stringify({ entry, settings: context.settings, runtimeSettings: context.runtimeSettings });
    const result = await Main.actions.listTranslatorOptions(entry, {}, context);
    assert.ok(result.translatorVulkanOptions.some(row => row.value === saved));
    assert.equal(result.translatorVulkanOptions.some(row => row.value === canonical), false, 'the selected alias keeps one option for the installed copy');
    assert.equal(result.effectiveSettings.find(row => row.value === 'vulkanBackend').label, 'kosmickrisp');
    assert.equal(result.translatorEnvironments[0], runtime); assert.ok(result.translatorEnvironments.includes('kosmickrisp'));
    const plan = await Translators.resolve(install, runtime, context, { host: f.host, executableArchitecture: 'x86_64', managers: [manager] });
    const selected = plan.components['vulkan-driver'];
    assert.equal(selected.value, saved); assert.equal(selected.selected.id, canonical); assert.equal(selected.used.id, canonical);
    assert.equal(selected.used.root, root); assert.equal(selected.fallback, false); assert.equal(selected.reason, null);
    assert.ok(selected.used.files.some(file => file.path === driver));
    assert.equal(Translators.settingsForPlan(context.runtimeSettings, plan).translatorVulkan, saved);
    assert.equal(JSON.stringify({ entry, settings: context.settings, runtimeSettings: context.runtimeSettings }), before, 'actions and resolution retain the original saved state');
  }
  const choice = { id: canonical, aliases: [saved], component: 'vulkan-driver', engine: 'kosmickrisp', root, files: [] };
  assert.equal(Plan.resolvePlan({ choices: [choice], selections: { 'vulkan-driver': saved } }).components['vulkan-driver'].used, choice);
  const opaque = { ...choice, id: saved, aliases: [] };
  assert.equal(Plan.resolvePlan({ choices: [choice, opaque], selections: { 'vulkan-driver': saved } }).components['vulkan-driver'].used, opaque, 'an exact opaque ID takes precedence over alias metadata');
  assert.deepEqual(Plan.options({ component: 'vulkan-driver', choices: [choice, opaque], selections: { 'vulkan-driver': saved } }).map(row => row.value), ['automatic', canonical, saved]);
  const unavailable = Plan.resolvePlan({ choices: [choice], selections: { 'vulkan-driver': saved + ':unknown' } }).components['vulkan-driver'];
  assert.equal(unavailable.used, null); assert.equal(unavailable.fallback, true); assert.equal(unavailable.value, saved + ':unknown');
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
  const pluginRoots = view.env.GST_PLUGIN_PATH.split(path.delimiter);
  assert.deepEqual(new Set(pluginRoots.map(directory => path.relative(path.join(view.root, 'video'), directory))),
    new Set(['plugins', 'plugins/more']));
  assert.equal(fs.realpathSync(path.join(pluginRoots[0], 'a.dylib')), path.join(f.root, 'video/plugins/a.dylib'));
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

test('real Sikarugir API graphics view applies exact planned builtin and Unix sources without graphics metadata', async t => {
  const f = fixture(t), Graphics = require('../src/modules/crossover/sikarugir/graphics');
  const templateRoot = path.join(f.root, 'template'), component = path.join(templateRoot, 'Frameworks/renderer/dxmt');
  fs.mkdirSync(path.dirname(component), { recursive: true }); fs.cpSync(path.join(f.root, 'wine/lib/dxmt'), component, { recursive: true });
  f.put('wine/share/wine/nls/c_932.nls', 'fixture locale data');
  const install = { ...f.install, templateRoot }, settings = { translatorRenderer: 'included:d3d-renderer:dxmt',
    translatorD3D9: 'fixture-dxvk:native', dxvkHud: 'fps', dxmtConfig: 'fixture_config=1', dlss: false }, context = f.context(settings);
  const plan = await Translators.resolve(install, 'sikarugir', context, { host: f.host, executableArchitecture: 'x86_64', managers: [f.manager] });
  assert.equal(plan.apiMode, true); assert.equal(plan.components.d3d11.used.root, component);
  assert.equal(fs.existsSync(path.join(templateRoot, 'graphics.json')), false);
  const sourcePaths = new Set([...plan.placements.map(item => item.file.path), install.executablePath, install.serverPath,
    path.join(plan.layout.unixRoot, 'ntdll.so'), path.join(plan.layout.unixRoot, 'wine')]);
  const sourceBytes = new Map([...sourcePaths].map(file => [file, fs.readFileSync(file)]));
  const translatorView = await Files.prepareTranslatorFiles(plan, { userDataDir: context.userDataDir, layout: plan.layout });
  const viewRoot = path.join(context.userDataDir, 'graphics/sikarugir-views/fixture'), prefixPath = path.join(f.root, 'private-prefix');
  const graphics = await Graphics.prepareGraphicsView({ install, settings: Translators.settingsForPlan(settings, plan),
    translatorPlan: plan, translatorView, context, userDataDir: context.userDataDir, viewRoot, prefixPath,
    host: f.host, executableArchitecture: 'x86_64' });
  assert.equal(graphics.translatorPlan, plan);
  assert.notEqual(graphics.executablePath, install.executablePath); assert.equal(fs.lstatSync(graphics.executablePath).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(graphics.executablePath), fs.readFileSync(install.executablePath));
  assert.equal(fs.realpathSync(graphics.serverPath), install.serverPath);
  const privateUnix = path.join(graphics.dllRoot, plan.layout.unixName);
  assert.equal(fs.lstatSync(path.join(privateUnix, 'ntdll.so')).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(path.join(privateUnix, 'ntdll.so')), sourceBytes.get(path.join(plan.layout.unixRoot, 'ntdll.so')));
  for (const { file } of plan.placements) {
    if (file.format === 'pe' && file.form === 'builtin' || file.format === 'macho' && file.path.endsWith('.so')) {
      const cpu = file.format === 'pe' ? Files.cpuFolder(file.machine) : plan.layout.unixName;
      const target = path.join(graphics.dllRoot, cpu, path.basename(file.path));
      assert.equal(fs.lstatSync(target).isSymbolicLink(), true); assert.equal(fs.realpathSync(target), fs.realpathSync(file.path));
    }
  }
  assert.ok(graphics.dllOverrides.includes('d3d9=n,b')); assert.ok(graphics.env.DYLD_LIBRARY_PATH.split(path.delimiter).includes(privateUnix));
  const original = WineSettings.environment; let calls = 0;
  t.mock.method(WineSettings, 'environment', (settings, options) => { calls++; return original(settings, options); });
  const built = SikaLaunch.buildEnvironment(Translators.settingsForPlan(settings, plan), install, path.join(f.root, 'state'), prefixPath, graphics,
    { translatorPlan: plan, baseEnvironment: {} });
  assert.equal(calls, 1); assert.equal(built.environment.DXVK_HUD, 'fps'); assert.equal(built.environment.DXMT_CONFIG, 'fixture_config=1');
  assert.ok(built.environment.WINEDLLOVERRIDES.split(';').includes('d3d9=n,b'));
  assert.equal(built.environment.DYLD_LIBRARY_PATH, graphics.env.DYLD_LIBRARY_PATH); assert.equal(built.environment.WINEDLLPATH, graphics.env.WINEDLLPATH);
  for (const [file, bytes] of sourceBytes) assert.deepEqual(fs.readFileSync(file), bytes, 'installed source bytes stay unchanged');
  assert.equal(fs.existsSync(path.join(templateRoot, 'graphics.json')), false); assert.equal(fs.existsSync(prefixPath), false);
});

test('translator schema follows canonical role order and explains CrossOver global Automatic before editing', async t => {
  const Roles = require('../src/modules/shared/runtime/translator-roles'), original = require('../src/modules/crossover/manifest.json');
  const before = JSON.stringify(original), manifest = Translators.withSettings(original);
  const expected = ['translatorRenderer', ...Roles.ROLES.map(role => role.settingsKey)];
  for (const runtime of ['crossover', 'sikarugir']) {
    const schema = manifest.runtime.entries[runtime].settings, controls = schema.fields.filter(field => field.optionsAction === 'listTranslatorOptions');
    assert.deepEqual(controls.map(field => field.key), expected);
    assert.ok(expected.indexOf('translatorD3D12') < expected.indexOf('translatorVulkan'));
    assert.equal(schema.visibilityAction, 'listTranslatorOptions');
    assert.equal(schema.environmentAction, 'listTranslatorOptions');
    assert.equal(schema.fields.some(field => field.key === 'environment'), false, 'translator environments replace the variable list');
    for (const role of Roles.ROLES) {
      const field = controls.find(field => field.key === role.settingsKey);
      assert.equal(field.optionsKey, role.optionsKey); assert.equal(schema.defaults[role.settingsKey], '');
      assert.equal(field.inheritanceInOptions, true); assert.equal(field.inheritFrom, 'environmentReference');
    }
    for (const key of ['graphicsBackend', 'vulkanBackend', 'graphicsBridgeVersion']) if (original.runtime.entries[runtime].settings.fields.some(field => field.key === key))
      assert.equal(schema.fields.find(field => field.key === key).hidden, true);
  }
  assert.equal(JSON.stringify(original), before, 'schema composition preserves the original manifest');
  const f = fixture(t), registry = require('../src/modules/registry'), runtimeManager = require('../src/modules/crossover/runtime/manager');
  t.mock.method(registry, 'listSharedRuntimeManagers', () => [f.manager]); t.mock.method(registry, 'listModuleIds', () => []);
  t.mock.method(runtimeManager, 'resolveSelection', () => ({ ready: true, install: f.install }));
  const context = f.context({}), result = await require('../src/modules/crossover/main').actions.listTranslatorOptions(f.entry, {}, context);
  const global = result.translatorGroups.find(group => group.roles.length === Roles.DIRECT3D_ROLES.length);
  assert.ok(global); assert.equal(global.reason, 'runtime-global-automatic');
  for (const role of Roles.DIRECT3D_ROLES) assert.equal(result.translatorRoles.find(item => item.id === role.id).used, null);
  assert.deepEqual(context.runtimeSettings, {});
});

test('source-owned stock WineD3D API11 includes its DXGI binding while Wine vkd3d stays distinct', t => {
  const f = fixture(t), windows = 'wine/lib/wine/x86_64-windows';
  const d3d11 = f.put(windows + '/d3d11.dll', dll()), dxgi = f.put(windows + '/dxgi.dll', dll());
  const d3d12 = f.put(windows + '/d3d12.dll', dll()); f.put(windows + '/opengl32.dll', dll());
  const { included } = Translators.includedTranslators(f.install, 'crossover');
  const wine = included.find(item => item.engine === 'wined3d'), vkd3d = included.find(item => item.engine === 'vkd3d');
  assert.equal(wine.id, 'included:d3d-renderer:wined3d'); assert.equal(wine.root, f.install.crossoverRoot);
  assert.equal(wine.source.runtime, 'crossover'); assert.equal(wine.source.id, f.install.version);
  assert.deepEqual(new Set(wine.files.map(file => file.path)), new Set([d3d11, dxgi]));
  assert.deepEqual(wine.apis, ['Direct3D 11']);
  const helper = wine.files.find(file => file.path === dxgi);
  assert.equal(helper.format, 'pe'); assert.equal(helper.machine, 0x8664); assert.equal(helper.form, 'builtin'); assert.deepEqual(helper.apis, []);
  assert.equal(vkd3d.id, 'included:d3d12:vkd3d'); assert.equal(vkd3d.component, 'd3d12');
  assert.deepEqual(vkd3d.apis, ['Direct3D 12']); assert.deepEqual(vkd3d.files.map(file => file.path), [d3d12]);
  assert.equal(vkd3d.source.runtime, 'crossover');
});

test('engine settings use declared configuration namespaces without rewriting historical or legacy renderer identity', async t => {
  const f = fixture(t), historicalRoot = path.join(f.root, 'historical');
  f.put('historical/d3d9.dll', dll({ builtin: false }));
  f.installs.push({ version: 'historical', architecture: 'x64', translatorRoot: historicalRoot, installDir: historicalRoot,
    translator: Description.describeTranslator(historicalRoot, { engine: 'd9vk', source: 'fixture-history', version: 'historical' }) });
  const context = f.context({ translatorRenderer: 'included:d3d-renderer:dxmt', translatorD3D9: 'fixture-dxvk:historical' });
  const historical = await Translators.resolve(f.install, 'crossover', context, { host: f.host, executableArchitecture: 'x86_64', managers: [f.manager] });
  assert.equal(historical.components.d3d9.used.engine, 'd9vk');
  assert.equal(historical.components.d3d9.used.settingsEngine, 'dxvk');
  const declared = Translators.engines(historical);
  assert.deepEqual(new Set(declared['d3d-renderer']), new Set(['dxmt', 'dxvk']));
  assert.equal(WineSettings.environment({ dxvkHud: 'fps' }, { engines: declared }).DXVK_HUD, 'fps');

  const { RELATIVE_PATHS } = require('../src/modules/crossover/sikarugir/graphics/closure'), templateRoot = path.join(f.root, 'namespace-template');
  const dxmtRoot = path.join(templateRoot, RELATIVE_PATHS.renderers, 'dxmt');
  fs.mkdirSync(path.dirname(dxmtRoot), { recursive: true }); fs.cpSync(path.join(f.root, 'wine/lib/dxmt'), dxmtRoot, { recursive: true });
  f.put(path.join('namespace-template', RELATIVE_PATHS.renderers, 'd9vk/wine/x86_64-windows/d3d9.dll'), dll());
  const driver = f.put(path.join('namespace-template', RELATIVE_PATHS.frameworks, 'libvulkan_kosmickrisp.dylib'), image({ cpu: X64 }));
  f.put(path.join('namespace-template', RELATIVE_PATHS.frameworks, 'libvulkan.1.dylib'), image({ cpu: X64 }));
  const icd = path.join('namespace-template', RELATIVE_PATHS.vulkan, 'kosmickrisp_mesa_icd.json');
  f.put(icd, JSON.stringify({ ICD: { library_path: path.relative(path.dirname(path.join(f.root, icd)), driver), api_version: '1.4.0' } }));
  const install = { ...f.install, templateRoot }, legacyContext = f.context({ translatorVulkan: 'included:vulkan-driver:kosmickrisp' });
  const legacy = await Translators.resolve(install, 'sikarugir', legacyContext, { host: f.host, executableArchitecture: 'x86_64', managers: [f.manager] });
  assert.equal(Boolean(legacy.apiMode), false); assert.equal(legacy.components['d3d-renderer'].used.engine, 'dxmt');
  assert.ok(legacy.additional.some(item => item.templateComponent === 'd9vk'));
  const used = Translators.engines(legacy), environment = WineSettings.environment({ dxvkHud: 'fps', dxmtConfig: 'legacy=1' }, { engines: used });
  assert.deepEqual(new Set(used['d3d-renderer']), new Set(['dxmt', 'dxvk']));
  assert.equal(used['vulkan-driver'], 'kosmickrisp'); assert.equal(environment.DXVK_HUD, 'fps'); assert.equal(environment.DXMT_CONFIG, 'legacy=1');
  const single = await Translators.resolve(install, 'sikarugir', f.context({}), { host: f.host, executableArchitecture: 'x86_64', managers: [f.manager] });
  assert.equal(Translators.engines(single)['d3d-renderer'], 'dxmt', 'unchanged single-engine settings stay scalar');
  assert.equal(historical.components.d3d9.used.engine, 'd9vk', 'configuration namespace never rewrites loaded engine identity');
});
