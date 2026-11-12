const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Launch = require('../src/modules/crossover/runtime/steam-bridge-launch');
const { bootstrap } = require('./helpers/steam-bridge-bootstrap.cjs');
test('bridge launches the PE declared by an Unreal bootstrap with its arguments and no file changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outer = path.join(root, 'Game.exe'), target = path.join(root, 'Project/Binaries/Win64/Game.exe');
  bootstrap(outer, undefined, 'Project -label="two words" C:\\Content'); bootstrap(target, undefined, '', 'Game');
  const before = fs.readFileSync(outer);
  assert.deepEqual(Launch.resolve(outer, 'x86_64'), { executablePath: target, arguments: ['Project', '-label=two words', 'C:\\Content'] });
  assert.deepEqual(fs.readFileSync(outer), before);
  assert.deepEqual(Launch.resolve(target, 'x86_64'), { executablePath: target, arguments: [] });
  assert.throws(() => Launch.resolve(outer, 'x86'), /compatible PE/);
  for (const value of ['..\\outside.exe', 'C:\\outside.exe', '\\\\server\\game.exe', 'Project\0bad']) {
    bootstrap(outer, value); assert.throws(() => Launch.resolve(outer, 'x86_64'));
  }
  bootstrap(outer); fs.unlinkSync(target); fs.symlinkSync(process.execPath, target);
  assert.throws(() => Launch.resolve(outer, 'x86_64'), /compatible PE/);
});
test('a camera view copies the bootstrap program so the bridge can start it inside the view', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-view-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const GameView = require('../src/modules/crossover/temporal/game-view');
  const base = path.join(root, 'game'), directory = path.join(root, 'runtime');
  const outer = path.join(base, 'Game.exe'), target = path.join(base, 'Project/Binaries/Win64/Game-Shipping.exe');
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(path.join(base, 'Project/Content'), { recursive: true });
  bootstrap(outer, 'Project\\Binaries\\Win64\\Game-Shipping.exe', 'Project -dx12'); bootstrap(target, undefined, '', 'Game');
  fs.writeFileSync(path.join(base, 'Project/Content/large.pak'), 'asset');
  assert.equal(Launch.declaredProgram(outer, base, 'x86_64'), 'Project/Binaries/Win64/Game-Shipping.exe');
  assert.equal(Launch.declaredProgram(target, base, 'x86_64'), null);
  assert.equal(Launch.declaredProgram(outer, base, 'x86'), null, 'an incompatible bootstrap adds no copy');
  const recovery = { overrides: {}, omitted: new Set(), libraries: [] };
  const linked = await GameView.camera(directory, base, outer, { libraries: [] }, recovery);
  assert.throws(() => Launch.resolve(linked.executablePath, 'x86_64'), /compatible PE/, 'a linked program cannot be checked inside the view');
  GameView.retire(directory);
  const view = await GameView.camera(directory, base, outer, { libraries: [], programs: [Launch.declaredProgram(outer, base, 'x86_64')] }, recovery);
  const copied = Object.entries(view.record.entries).filter(([, row]) => row.kind === 'file').map(([name]) => name).sort();
  assert.deepEqual(copied, ['Game.exe', 'Project/Binaries/Win64/Game-Shipping.exe']);
  assert.ok(fs.lstatSync(path.join(view.gameRoot, 'Project/Content')).isSymbolicLink());
  assert.deepEqual(Launch.resolve(view.executablePath, 'x86_64'),
    { executablePath: path.join(view.gameRoot, 'Project/Binaries/Win64/Game-Shipping.exe'), arguments: ['Project', '-dx12'] });
});
test('embedded Windows arguments preserve literal slashes, empty values, apostrophes and escaped quotes', () => {
  assert.deepEqual(Launch.windowsArguments('Project "" "two words" don\'t C:\\dir\\file \\"quote'),
    ['Project', '', 'two words', "don't", 'C:\\dir\\file', '"quote']);
  assert.deepEqual(Launch.windowsArguments('"a""b"'), ['a"b']);
  assert.throws(() => Launch.windowsArguments('"unterminated'), /unclosed/);
});
