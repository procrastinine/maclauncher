const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Main = require('../src/modules/crossover/main');
const D = require('../src/modules/shared/runtime/translator-description');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const { peFixture } = require('./helpers/pe-fixture');

test('actual translator action lists managed choices with one notice before its selected Wine runtime is installed', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-missing-runtime-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const component = path.join(root, 'managed'); fs.mkdirSync(component);
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22);
  fs.writeFileSync(path.join(component, 'd3d11.dll'), pe.bytes);
  const description = D.describeTranslator(component, { engine: 'dxvk', source: 'Authored installed source', version: 'release' });
  const install = { version: 'release', architecture: 'x64', translatorRoot: component, installDir: component, translator: description };
  const manager = { id: 'fixture-translator', translatorEngine: 'dxvk', getState: () => ({ installed: [install] }),
    resolveSelection: () => ({ ready: true, version: install.version, install }) };
  t.mock.method(Translators, 'resolve', () => { throw Error('No Wine/native compatibility traversal is needed to list installed choices.'); });
  for (const runtimeId of ['crossover', 'sikarugir']) {
    let preparations = 0;
    const runtimeManager = { resolveSelection: () => ({ ready: false, version: 'uninstalled-choice', reason: 'Selected runtime is not installed' }),
      ...(runtimeId === 'sikarugir' ? { installRuntime: () => { preparations++; throw Error('Reading choices must not install Wine.'); } } : {}) };
    const context = { runtimeId, userDataDir: path.join(root, 'profile'), settings: {}, runtimeSettings: { dxvkHud: 'fps' } };
    const before = JSON.stringify(context), result = await Main.__test.translatorOptions({ runtimeId }, {}, context,
      { runtimeManager, managers: [manager] });
    assert.ok(result.translatorRendererOptions.some(option => option.value === 'fixture-translator:release'));
    assert.ok(result.translatorD3D11Options.some(option => option.value === 'fixture-translator:release'));
    assert.ok(result.translatorRoles.some(role => role.id === 'd3d11'));
    assert.match(result.notice, /Included choices.*runtime.*installed/);
    assert.equal(result.notice.includes('Play installs'), runtimeId === 'sikarugir');
    assert.equal(preparations, 0); assert.equal(JSON.stringify(context), before);
  }
});

test('missing-Wine choices honor a known consumer CPU and otherwise use the real manager installed-build selection', async t => {
  const Architecture = require('../src/modules/shared/runtime/architecture');
  const { createArchitectureManager } = require('../src/modules/shared/runtime/architecture-manager');
  const { image, X64, ARM64 } = require('./fixtures/macho-image');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-missing-cpu-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = [];
  for (const [version, architecture] of [['both', 'arm64'], ['both', 'x64'], ['intel-only', 'x64']]) {
    const component = path.join(root, version, architecture); fs.mkdirSync(component, { recursive: true });
    const file = path.join(component, 'libvulkan_kosmickrisp.dylib');
    fs.writeFileSync(file, image({ cpu: architecture === 'x64' ? X64 : ARM64, symbols: [`driver_${version}_${architecture}`] }));
    rows.push({ version, architecture, ready: true, installDir: component, translatorRoot: component, executablePath: file,
      translator: D.describeTranslator(component, { engine: 'kosmickrisp', version, source: 'Authored installed source' }) });
  }
  const host = { platform: 'darwin', hardwareArch: 'arm64', rosettaAvailable: true };
  const facade = Architecture.withArchitecture('arm64', () => createArchitectureManager({ id: 'fixture-cpu-driver',
    dependencies: { hostCapabilities: host } }, ({ installationArchitecture: architecture }) => {
    const installed = rows.filter(row => row.architecture === architecture);
    return { id: 'fixture-cpu-driver', core: {}, getState: () => ({ installed }), offersBuild: () => installed.length > 0,
      normalizeSettings: settings => settings || {}, resolveSelection: (_entry, _settings, _data, options = {}) => {
        const install = installed.find(row => !options.version || row.version === options.version);
        return { version: options.version || install?.version, ready: Boolean(install), install };
      } };
  }));
  facade.translatorEngine = 'kosmickrisp'; assert.equal(facade.launcherArchitecture, 'arm64');
  const requests = [], select = facade.resolveSelection;
  t.mock.method(facade, 'resolveSelection', (...args) => { requests.push(args[3]); return select(...args); });
  t.mock.method(Translators, 'resolve', () => { throw Error('Options for absent Wine must not run native compatibility.'); });
  t.mock.method(require('../src/modules/shared/runtime/binary-compatibility'), 'compatibility', () => { throw Error('No Wine compatibility input exists.'); });
  let installations = 0;
  for (const consumerArchitecture of ['x64', undefined]) {
    requests.length = 0;
    const runtimeManager = { resolveSelection: () => ({ ready: false, version: 'missing-Wine', ...(consumerArchitecture ? { architecture: consumerArchitecture } : {}) }),
      installRuntime: () => { installations++; throw Error('Reading options cannot install Wine.'); } };
    const context = { runtimeId: 'sikarugir', userDataDir: path.join(root, 'profile'), settings: {}, runtimeSettings: { dxvkHud: 'fps' } };
    const before = JSON.stringify(context);
    const result = await Architecture.withArchitecture('arm64', () => Main.__test.translatorOptions({ runtimeId: 'sikarugir' }, {}, context,
      { runtimeManager, managers: [facade] }));
    const options = result.translatorVulkanOptions;
    assert.ok(options.some(option => option.value === 'fixture-cpu-driver:intel-only'), 'an x64-only installed driver stays available to ordinary selection');
    assert.equal(options.filter(option => option.value === 'fixture-cpu-driver:both').length, 1);
    assert.ok(requests.length > 0);
    assert.ok(requests.every(request => consumerArchitecture ? request.architecture === 'x64' : !Object.hasOwn(request, 'architecture')));
    const inventory = Architecture.withArchitecture('arm64', () => Translators.inventory(null, 'sikarugir', context,
      { managers: [facade], consumerArchitecture }));
    const both = inventory.choices.find(choice => choice.runtimeVersion === 'both');
    const intel = inventory.choices.find(choice => choice.runtimeVersion === 'intel-only');
    assert.equal(both.architecture, consumerArchitecture || 'arm64');
    assert.equal(both.root, rows.find(row => row.version === 'both' && row.architecture === (consumerArchitecture || 'arm64')).installDir);
    assert.equal(intel.architecture, 'x64'); assert.equal(intel.files[0].cpuSlices[0], 'x86_64');
    assert.equal(JSON.stringify(context), before);
  }
  const first = rows.find(row => row.version === 'both' && row.architecture === 'x64');
  const withoutResolver = { id: 'fixture-no-resolver', translatorEngine: 'kosmickrisp', getState: () => ({ installed: [first, rows[0]] }) };
  const fallback = Architecture.withArchitecture('arm64', () => Translators.inventory(null, 'sikarugir', { settings: {} }, { managers: [withoutResolver] }));
  assert.equal(fallback.choices[0].root, first.installDir, 'without a manager resolver, unknown CPU preserves existing row order');
  assert.equal(installations, 0);
});
