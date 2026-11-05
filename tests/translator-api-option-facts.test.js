const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const Translators = require('../src/modules/shared/runtime/wine-translators');
const { peFixture } = require('./helpers/pe-fixture');
const { image, X64, ARM64 } = require('./fixtures/macho-image');

function dll(imported) {
  const f = peFixture({ is64: true }); f.bytes.writeUInt16LE(0x2002, f.peOffset + 22); f.bytes.write('Wine builtin DLL\0', 64);
  if (imported) {
    const start = 0x800, rva = offset => 0x2000 + offset;
    f.bytes.writeUInt32LE(rva(start), f.directories + 8); f.bytes.writeUInt32LE(40, f.directories + 12);
    f.bytes.writeUInt32LE(rva(start + 40), f.raw + start); f.bytes.writeUInt32LE(rva(start + 72), f.raw + start + 12);
    f.bytes.writeUInt32LE(rva(start + 56), f.raw + start + 16); f.bytes.write(imported + '\0', f.raw + start + 72);
    for (const offset of [start + 40, start + 56]) f.bytes.writeBigUInt64LE(0x8000000000000001n, f.raw + offset);
  }
  return f.bytes;
}

test('real API options reuse inspected source facts when an unused API makes the package globally incompatible', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-option-facts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, bytes) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
  };
  const wine = path.join(root, 'wine'), packageRoot = path.join(root, 'package'), supplied = path.join(packageRoot, 'included-dxmt');
  for (const name of ['wine', 'wineserver', 'wineloader']) put(`wine/bin/${name}`, image({ cpu: X64, fileType: 2 }));
  put('wine/lib/wine/x86_64-unix/ntdll.so', image({ cpu: X64, symbols: ['wine_unix_call'] }));
  put('package/included-dxmt/d3d11.dll', dll()); const shared = put('package/included-dxmt/common.dll', dll());
  fs.symlinkSync(supplied, path.join(wine, 'lib/dxmt'));
  put('package/selected/d3d9.dll', dll()); put('package/selected/d3d11.dll', dll('winemetal.dll'));
  put('package/selected/winemetal.dll', dll()); put('package/selected/winemetal.so', image({ cpu: ARM64 }));
  fs.symlinkSync('../included-dxmt/common.dll', path.join(packageRoot, 'selected/common.dll'));
  const metadata = Description.describeTranslator(packageRoot, { engine: 'dxvk', source: 'fixture', version: 'mixed' });
  metadata.files = metadata.files.map(file => ({ ...file, path: file.relative,
    realPath: path.join(root, 'discarded-unpack', path.relative(packageRoot, file.realPath)) }));
  delete metadata.id; delete metadata.root;
  const installed = { version: 'mixed', architecture: 'x64', translatorRoot: packageRoot, installDir: packageRoot, translator: metadata };
  const manager = { id: 'fixture-mixed', translatorEngine: 'dxvk', getState: () => ({ installed: [installed] }),
    resolveSelection: () => ({ ready: true, install: installed, architecture: 'x64' }) };
  const install = { version: 'fixture-wine', upstreamVersion: '26.3', crossoverRoot: wine, installDir: wine,
    executablePath: path.join(wine, 'bin/wine'), serverPath: path.join(wine, 'bin/wineserver'), loaderPath: path.join(wine, 'bin/wineloader') };
  const game = peFixture({ is64: true }); game.bytes.writeUInt16LE(2, game.peOffset + 22); game.bytes.writeUInt16LE(3, game.optional + 68);
  const executable = put('game/Game.exe', game.bytes), sourceRoot = path.dirname(executable);
  const entry = { gameId: 'option-facts', gamePath: sourceRoot, runtimeId: 'crossover', runtimeData: {
    crossover: { sourceRoot, windowsExecutablePath: executable, executableArchitecture: 'x86_64', detectionComplete: true } } };
  const registry = require('../src/modules/registry'), runtimeManager = require('../src/modules/crossover/runtime/manager');
  t.mock.method(registry, 'listSharedRuntimeManagers', () => [manager]); t.mock.method(registry, 'listModuleIds', () => []);
  t.mock.method(runtimeManager, 'resolveSelection', () => ({ ready: true, install }));
  const originalResolve = Translators.resolve; let plan;
  t.mock.method(Translators, 'resolve', async (...args) => { plan = await originalResolve(...args); return plan; });
  const context = { runtimeId: 'crossover', userDataDir: path.join(root, 'profile'), settings: {}, logger: { warn() {} },
    runtimeSettings: { translatorRenderer: 'included:d3d-renderer:dxmt', translatorD3D9: 'fixture-mixed:mixed' } };
  const result = await require('../src/modules/crossover/main').actions.listTranslatorOptions(entry, {}, context);
  assert.equal(plan.compatibility['fixture-mixed:mixed'].compatible, false);
  assert.equal(plan.compatibility['fixture-mixed:mixed'].files, undefined);
  assert.equal(plan.components.d3d9.used.id, 'fixture-mixed:mixed'); assert.equal(plan.components.d3d9.fallback, false);
  assert.equal(plan.components.d3d11.used.id, 'included:d3d-renderer:dxmt');
  assert.equal(plan.components.d3d9.used.files.find(file => path.basename(file.path) === 'common.dll').realPath, shared);
  const current = result.translatorD3D9Options.find(option => option.value === 'fixture-mixed:mixed');
  assert.deepEqual(current.affectedRoles, ['d3d9']);
  assert.deepEqual(current.runtimeSettingsPatch, { translatorD3D9: 'fixture-mixed:mixed' });
  assert.ok(metadata.files.find(file => file.relative === 'selected/common.dll').realPath.includes('/discarded-unpack/'), 'inspection does not rewrite installed metadata');
});
