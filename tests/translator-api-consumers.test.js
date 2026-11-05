const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const DLSS = require('../src/modules/crossover/dlss');
const Binding = require('../src/modules/shared/reshade/launch-binding');
const Description = require('../src/modules/shared/runtime/translator-description');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64 } = require('./fixtures/macho-image');

function renderer(t, root, engine) {
  const directory = path.join(root, engine); fs.mkdirSync(directory);
  for (const name of ['d3d11', ...DLSS.DLLS]) {
    const fixture = peFixture({ is64: true }); fixture.bytes.writeUInt16LE(0x2002, fixture.peOffset + 22);
    fs.writeFileSync(path.join(directory, name + '.dll'), fixture.bytes);
  }
  return Description.describeTranslator(directory, { engine, id: engine, source: 'fixture' });
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-api-consumers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dxmt = renderer(t, root, 'dxmt'), d3dmetal = renderer(t, root, 'd3dmetal');
  const plan = { runtime: 'crossover', apiMode: true, components: {
    'd3d-renderer': { used: { engine: 'dxvk' } }, d3d11: { used: dxmt }, d3d12: { used: d3dmetal }
  }, groups: [{ id: 'd3d11+d3d12', roles: ['d3d11', 'd3d12'], label: 'shared scope', reason: 'UI description' }],
  placements: [dxmt, d3dmetal].flatMap(description => description.files.map(file => ({ file, description,
    roles: [description.engine === 'dxmt' ? 'd3d11' : 'd3d12'] }))) };
  return { plan, dxmt, d3dmetal };
}

test('per-API DLSS uses final D3D11/12 bindings while global Wine transport stays independent', t => {
  const { plan, dxmt } = fixture(t);
  assert.equal(DLSS.hasPlanLibraries(plan, 'dxmt'), true);
  assert.equal(DLSS.hasPlanLibraries(plan, 'd3dmetal'), true);
  const options = { backend: 'wined3d', hardwareArch: 'arm64', macOSVersion: '26.0', executableArchitecture: 'x86_64',
    dxmt: true, d3dmetal: true, translatorPlan: plan };
  assert.deepEqual(DLSS.checkSelection({ dlss: true }, options), { enabled: true, dxmt: true, d3dmetal: true });
  const missing = { ...plan, placements: plan.placements.filter(item => item.description.id !== dxmt.id || !item.file.path.endsWith('/nvngx.dll')) };
  assert.equal(DLSS.hasPlanLibraries(missing, 'dxmt'), false, 'unused package files cannot supply the final native pair');
  const unresolved = { ...plan, components: { ...plan.components, 'd3d-renderer': { used: dxmt }, d3d11: { used: null } } };
  assert.equal(DLSS.hasPlanLibraries(unresolved, 'dxmt'), false, 'canonical automatic/null cannot fall through to the aggregate');
  assert.deepEqual(DLSS.checkSelection({ dlss: true }, { ...options, translatorPlan: unresolved }), { enabled: true, dxmt: false, d3dmetal: true });
  assert.throws(() => DLSS.checkSelection({ dlss: true }, { ...options, translatorPlan: undefined }), /requires DXMT or D3DMetal/,
    'old global-backend calls retain their working behavior');
  const legacy = { components: { 'd3d-renderer': { used: dxmt } } };
  assert.equal(DLSS.hasPlanLibraries(legacy, 'dxmt'), true);
});

test('graphics API binding retains actual placements and canonical null without requested selection or UI metadata', t => {
  const { plan } = fixture(t);
  plan.components.d3d10 = { used: null, value: 'unused request' };
  for (const row of Object.values(plan.components)) Object.defineProperty(row, 'selected', { get() { assert.fail('graphics must not inspect requested selections'); } });
  Object.defineProperty(plan.groups[0], 'selected', { get() { assert.fail('graphics must not inspect UI choice intent'); } });
  const snapshot = Binding.usedTranslatorPlan(plan);
  assert.equal(Object.hasOwn(snapshot.components, 'd3d-renderer'), false, 'an unused aggregate cannot describe the API-mode graphics source');
  assert.deepEqual(snapshot.components.d3d10, { used: null });
  assert.equal(snapshot.components.d3d11.used, plan.components.d3d11.used);
  assert.deepEqual(snapshot.placements, plan.placements);
  assert.deepEqual(snapshot.groups, [{ id: 'd3d11+d3d12', roles: ['d3d11', 'd3d12'] }]);
  plan.groups[0].reason = 'another UI-only explanation'; plan.components.d3d10.value = 'another request';
  assert.deepEqual(Binding.usedTranslatorPlan(plan), snapshot);
});

test('per-API camera consumes used D3D11 DXMT and keeps its existing pair requirement independent', t => {
  const Temporal = require('../src/modules/crossover/temporal'), StreamlinePE = require('../src/modules/crossover/temporal/streamline/pe-exports');
  const crypto = require('node:crypto'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-camera-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const pe = peFixture({ is64: true }); pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22);
  const exported = Buffer.from(pe.bytes), names = ['slEvaluateFeature', 'slSetConstants', 'slShutdown'];
  exported.fill(0, pe.raw); exported.write('.text\0\0\0', pe.section); exported.writeUInt32LE(0x60000020, pe.section + 36);
  exported.writeUInt32LE(0, pe.directories + 16); exported.writeUInt32LE(0, pe.directories + 20);
  exported.writeUInt32LE(0x2000, pe.directories); exported.writeUInt32LE(0x200, pe.directories + 4);
  for (const [offset, value] of [[16, 1], [20, 3], [24, 3], [28, 0x2040], [32, 0x2050], [36, 0x2060]]) exported.writeUInt32LE(value, pe.raw + offset);
  let cursor = 0x80;
  names.forEach((name, index) => { exported.writeUInt32LE(0x2800 + index, pe.raw + 0x40 + index * 4);
    exported.writeUInt32LE(0x2000 + cursor, pe.raw + 0x50 + index * 4); exported.writeUInt16LE(index, pe.raw + 0x60 + index * 2);
    exported.write(name + '\0', pe.raw + cursor); cursor += name.length + 1; exported[pe.raw + 0x800 + index] = 0xc3; });
  const supplied = put('game/sl.interposer.dll', exported), provider = put('graphics/temporal/streamline/sl.interposer.dll', exported);
  put('graphics/temporal/streamline/provider.json', JSON.stringify({ schema: 1, library: 'sl.interposer.dll', sha256: hash(exported), exports: StreamlinePE.inspect(provider) }));
  const native = image({ cpu: X64 }), thunk = pe.bytes, files = {};
  for (const file of Temporal.FILES) { const bytes = file.endsWith('.so') ? native : thunk; put('graphics/temporal/dxmt/' + file, bytes); files[file] = hash(bytes); }
  put('graphics/temporal/dxmt/camera-bridge.json', JSON.stringify({ schema: 1, id: 'dxmt-camera1', architecture: 'x86_64', tableCount: 146,
    minimumMacOS: '14.0.0', files, base: { nativeSha256: hash(native), thunkSha256: hash(thunk) } }));
  const binary = put('component/wine/x86_64-unix/winemetal.so', native); put('component/wine/x86_64-windows/winemetal.dll', thunk);
  put('engine/lib/wine/x86_64-unix/ntdll.so', native); put('engine/lib/wine/x86_64-unix/wine', image({ cpu: X64, fileType: 2 }));
  const game = peFixture({ is64: true }); game.bytes.writeUInt16LE(2, game.peOffset + 22); game.bytes.writeUInt16LE(3, game.optional + 68);
  const executable = put('game/Game.exe', game.bytes), entry = { gamePath: path.dirname(executable), runtimeData: { crossover: {
    sourceRoot: path.dirname(executable), windowsExecutablePath: executable, executableArchitecture: 'x86_64', detectionComplete: true } } };
  const used = Description.describeTranslator(path.join(root, 'component'), { engine: 'dxmt', id: 'used-dxmt' });
  const translatorPlan = { apiMode: true, components: { 'd3d-renderer': { used: { engine: 'dxvk' } }, d3d11: { used }, d3d12: { used: null } } };
  const options = { install: { engineRoot: path.join(root, 'engine'), templateRoot: path.join(root, 'component') }, runtimeId: 'sikarugir',
    root: path.join(root, 'graphics'), translatorPlan, settings: { graphicsBackend: 'wined3d' }, host: { platform: 'darwin', hardwareArch: 'arm64', macOSVersion: '26.0' } };
  assert.equal(Temporal.resolvePlan(entry, {}, options).baseRoot, path.join(root, 'component/wine'));
  assert.equal(Temporal.resolvePlan(entry, {}, { ...options, translatorPlan: { ...translatorPlan, components: { ...translatorPlan.components, d3d11: { used: null } } } }), null);
  const context = {}; fs.appendFileSync(binary, 'changed pairing');
  assert.equal(Temporal.resolvePlan(entry, context, options), null); assert.match(context.cameraAdapterNotice, /does not match/);
  assert.equal(translatorPlan.components.d3d11.used, used, 'camera failure never changes the actual used translator');
  assert.deepEqual(fs.readFileSync(supplied), exported);
});
