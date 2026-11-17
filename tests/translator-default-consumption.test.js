const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Managers = require('../src/modules/shared/runtime/translator-managers');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const Plan = require('../src/core/runtime-resolution/translator-plan');
const Description = require('../src/modules/shared/runtime/translator-description');
const Architecture = require('../src/modules/shared/runtime/architecture');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-default-consumer-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function put(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }
function installed(manager, userDataDir, version, catalogSourceId = 'upstream') {
  const directory = Architecture.withArchitecture('x64', () => manager.core.getInstallDir({ userDataDir, version }));
  const component = path.join(directory, manager.translatorEngine), fixture = peFixture({ is64: true });
  fixture.bytes.writeUInt16LE(0x2002, fixture.peOffset + 22);
  put(path.join(component, 'd3d11.dll'), fixture.bytes);
  const translator = Description.installationDescription(Description.describeTranslator(component, {
    engine: manager.translatorEngine, version, source: { kind: 'upstream', id: catalogSourceId, label: manager.label }
  }));
  const asset = { url: 'https://example.test/translator.tar.gz', filename: 'translator.tar.gz', sha256: 'a'.repeat(64) };
  put(path.join(directory, 'runtime.json'), JSON.stringify({ version, architecture: 'x64', upstreamRevision: 'declared-source',
    source: 'download', archiveSha256: asset.sha256, executableRelative: manager.translatorEngine + '/d3d11.dll',
    catalogEntry: { version, releaseVersion: version, architecture: 'x64', upstreamRevision: 'declared-source', catalogSourceId, asset },
    installationMetadata: { translator, translatorRelative: manager.translatorEngine }
  }));
}
function context(root, manager, version, runtimeSettings = {}) {
  return { runtimeId: 'sikarugir', userDataDir: path.join(root, 'profile'), settings: { runtimes: { [manager.id]: { defaultVersion: version } } },
    runtimeSettings, logger: { warn() {} } };
}

test('ordinary source choices consume real installed defaults and preserve explicit game identities', t => {
  const root = scratch(t), manager = Managers.createManager('dxvk'), ctx = context(root, manager, '1.10.3', { translatorRenderer: 'source:dxvk-upstream' });
  installed(manager, ctx.userDataDir, '1.10.3'); installed(manager, ctx.userDataDir, '1.10.4');
  ctx.settings.runtimes.unrelated = { defaultVersion: '1.0' };
  const unrelated = { id: 'unrelated', resolveSelection: () => assert.fail('Unused runtime defaults are never inspected') };
  const read = entry => Architecture.withArchitecture('arm64', () => Translators.inventory(null, 'sikarugir', ctx, { managers: [manager, unrelated], consumerArchitecture: 'x64', entry }));
  const input = read(), before = structuredClone(ctx.settings), selected = Plan.resolvePlan(input);
  assert.equal(selected.components['d3d-renderer'].used.runtimeVersion, '1.10.3');
  assert.equal(selected.components['d3d-renderer'].used.architecture, 'x64', 'the Wine CPU takes precedence over the launcher CPU');
  const explicit = Plan.resolvePlan({ ...input, selections: { 'd3d-renderer': manager.id + ':1.10.4' } });
  assert.equal(explicit.components['d3d-renderer'].used.runtimeVersion, '1.10.4');
  const game = read({ runtimeId: 'sikarugir', runtimeData: { sikarugir: { version: 'wine-version' }, [manager.id]: { version: '1.10.4' } } });
  assert.equal(Plan.resolvePlan(game).components['d3d-renderer'].used.runtimeVersion, '1.10.4');
  const invalid = Plan.resolvePlan({ ...input, compatibility: { [manager.id + ':1.10.3']: { compatible: false, reason: 'Wrong native profile' } } });
  assert.equal(invalid.components['d3d-renderer'].used.runtimeVersion, '1.10.4');
  const api = Plan.resolveApiRoles(Plan.resolvePlan({ ...input, selections: {} }), { ...input,
    selections: { d3d11: 'source:dxvk-upstream' }, apiCompatibility: { d3d11: {
      [manager.id + ':1.10.3']: { compatible: false, reason: 'Missing API dependency' }, [manager.id + ':1.10.4']: { compatible: true }
    } } });
  assert.equal(api.components.d3d11.used.runtimeVersion, '1.10.4');
  assert.deepEqual(ctx.settings, before);
});

test('saved preferences stay within the selected source and retain compatible source order', t => {
  const root = scratch(t), manager = Managers.createManager('dxvk'), ctx = context(root, manager, '1.10.3', { translatorRenderer: 'source:dxvk-upstream' });
  installed(manager, ctx.userDataDir, '1.10.3', 'macos'); installed(manager, ctx.userDataDir, '1.10.4');
  const input = Translators.inventory(null, 'sikarugir', ctx, { managers: [manager], consumerArchitecture: 'x64' });
  assert.equal(Plan.resolvePlan(input).components['d3d-renderer'].used.runtimeVersion, '1.10.4');
  const source = Plan.resolvePlan({ ...input, selections: { 'd3d-renderer': 'source:dxvk-macos' } });
  assert.equal(source.components['d3d-renderer'].used.runtimeVersion, '1.10.3');
  const broad = Plan.resolvePlan({ ...input, selections: { 'd3d-renderer': 'source:dxvk' }, choices: input.choices.map(item => ({ ...item,
    sourceOrder: item.sourceId === 'dxvk-upstream' ? 1 : 2 })) });
  assert.equal(broad.components['d3d-renderer'].used.runtimeVersion, '1.10.4', 'the manager preference does not reorder different sources');
});

test('automatic Wine composition uses a compatible default of its existing engine without switching engines', async t => {
  const root = scratch(t), manager = Managers.createManager('dxmt'), ctx = context(root, manager, '1.0');
  installed(manager, ctx.userDataDir, '1.0'); installed(manager, ctx.userDataDir, '2.0');
  const wine = path.join(root, 'wine'), executablePath = put(path.join(wine, 'bin/wine'), image({ cpu: X64, fileType: 2 }));
  put(path.join(wine, 'lib/wine/x86_64-unix/ntdll.so'), image({ cpu: X64 }));
  const included = path.join(root, 'support/Frameworks/renderer/dxmt'), fixture = peFixture({ is64: true });
  fixture.bytes.writeUInt16LE(0x2002, fixture.peOffset + 22); put(path.join(included, 'd3d11.dll'), fixture.bytes);
  const install = { engineRoot: wine, crossoverRoot: wine, templateRoot: path.join(root, 'support'), executablePath, architecture: 'x64', version: 'authored-wine' };
  const resolve = () => Translators.resolve(install, 'sikarugir', ctx, { managers: [manager], executableArchitecture: 'x86_64', host: { macOSVersion: '26.0', physicalAppleGPU: false } });
  const selected = await resolve(); assert.equal(selected.components['d3d-renderer'].used.runtimeVersion, '1.0');
  const other = Managers.createManager('dxvk'); installed(other, ctx.userDataDir, '1.10.3');
  ctx.settings.runtimes[other.id] = { defaultVersion: '1.10.3' };
  const still = await Translators.resolve(install, 'sikarugir', ctx, { managers: [other], executableArchitecture: 'x86_64', host: { macOSVersion: '26.0', physicalAppleGPU: false } });
  assert.equal(still.components['d3d-renderer'].used.engine, 'dxmt'); assert.equal(still.components['d3d-renderer'].used.included, true);
});
