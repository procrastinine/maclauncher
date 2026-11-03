const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Module = require("../src/modules/xash3d/main");
const { legacyGameMirrors } = require("../src/modules/xash3d/backcompat");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xash3d-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, text = "") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
// A Half-Life folder as Steam installs it, without real game data.
function halfLife(root) {
  write(path.join(root, "hl.exe"), "MZ");
  write(path.join(root, "valve", "liblist.gam"), 'game "Half-Life"\ngamedll "dlls\\hl.dll"\ngamedll_osx "dlls/hl.dylib"\n');
  write(path.join(root, "valve", "halflife.wad"), "WAD3");
  write(path.join(root, "valve", "dlls", "hl.dll"), "MZ half-life");
  return root;
}
function detect(folder) { return Module.detectGame({ inputPath: folder, rootDir: folder, stat: fs.statSync(folder) }); }
test('pre-release Xash3D private saves recover at the actual game save path while unknown runtime links retain config pending', async t => {
  const base = fs.realpathSync(temporary(t)), root = halfLife(path.join(base, 'Half-Life'));
  const entry = {gameId: 'old-xash', ...detect(root)}, context = {userDataDir: path.join(base, 'profile')};
  const descriptors = legacyGameMirrors(entry, context), save = descriptors[0], data = descriptors[1];
  const {retireLegacyGameMirror} = require('../src/core/backcompat/legacy-game-mirrors');
  write(path.join(save.mirrorRoot, 'released.sav'), 'private save');
  fs.mkdirSync(save.sourceRoot, {recursive: true});
  const result = await retireLegacyGameMirror(save, context);
  assert.equal(result.complete, true, result.reason);
  assert.equal(fs.readFileSync(path.join(root, 'valve', 'save', 'released.sav'), 'utf8'), 'private save');
  write(path.join(save.mirrorRoot, 'released.sav'), 'private conflict');
  const conflict = await retireLegacyGameMirror(save, context);
  assert.equal(conflict.complete, true, conflict.reason);
  assert.equal(fs.readFileSync(path.join(save.sourceRoot, 'released.sav'), 'utf8'), 'private save');
  assert.ok(conflict.recoveredFiles.some(file => fs.readFileSync(file, 'utf8') === 'private conflict'));
  write(path.join(data.mirrorRoot, 'valve', 'config.cfg'), 'private config');
  fs.symlinkSync(path.join(base, 'runtime', 'valve', 'dlls'), path.join(data.mirrorRoot, 'valve', 'dlls'), 'dir');
  const retained = await retireLegacyGameMirror(data, context);
  assert.equal(retained.complete, false, 'Runtime-link retirement requires the shared bounded link contract');
  assert.equal(fs.existsSync(path.join(root, 'valve', 'config.cfg')), false, 'Pending config is not falsely counted as restored');
  assert.equal(fs.readFileSync(path.join(data.mirrorRoot, 'valve', 'config.cfg'), 'utf8'), 'private config');
});
