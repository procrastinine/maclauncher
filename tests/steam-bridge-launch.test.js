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
test('embedded Windows arguments preserve literal slashes, empty values, apostrophes and escaped quotes', () => {
  assert.deepEqual(Launch.windowsArguments('Project "" "two words" don\'t C:\\dir\\file \\"quote'),
    ['Project', '', 'two words', "don't", 'C:\\dir\\file', '"quote']);
  assert.deepEqual(Launch.windowsArguments('"a""b"'), ['a"b']);
  assert.throws(() => Launch.windowsArguments('"unterminated'), /unclosed/);
});
