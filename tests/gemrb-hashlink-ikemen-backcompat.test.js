const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const GemRB = require("../src/modules/gemrb/backcompat");
const HashLink = require("../src/modules/hashlink/backcompat");
const Ikemen = require("../src/modules/ikemen/backcompat");

function fixture(t, moduleId) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-engine-descriptors-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const userDataDir = path.join(directory, "profile"), sourceRoot = path.join(directory, "original");
  const moduleRoot = path.join(userDataDir, "games", "example", "modules", moduleId);
  fs.mkdirSync(moduleRoot, { recursive: true });
  return { userDataDir, sourceRoot, moduleRoot, entry: { gameId: "example", moduleId, gamePath: sourceRoot, contentRootDir: sourceRoot } };
}

test("GemRB declares only old game, SavePath parent and known GUI script mirrors", t => {
  const { userDataDir, sourceRoot, moduleRoot, entry } = fixture(t, "gemrb");
  const scripts = path.join(path.dirname(sourceRoot), "custom-scripts", "GUIScripts");
  const marker = path.join(moduleRoot, "scripts-source.json");
  fs.writeFileSync(marker, JSON.stringify({ source: scripts }));
  fs.writeFileSync(path.join(moduleRoot, "GemRB.cfg"), "current config");
  fs.mkdirSync(path.join(moduleRoot, "cache"));
  const names = fs.readdirSync(moduleRoot), markerBytes = fs.readFileSync(marker);
  assert.deepEqual(GemRB.legacyGameMirrors(entry, { userDataDir }), [
    { mirrorRoot: path.join(moduleRoot, "game"), sourceRoot },
    { mirrorRoot: path.join(moduleRoot, "saves"), sourceRoot },
    { mirrorRoot: path.join(moduleRoot, "scripts", "GUIScripts"), sourceRoot: scripts }
  ]);
  assert.deepEqual(fs.readdirSync(moduleRoot), names);
  assert.deepEqual(fs.readFileSync(marker), markerBytes);
  for (const saveDirOverride of [path.join(moduleRoot, "saves"), path.join(moduleRoot, "saves", "slot1")]) {
    assert.equal(GemRB.legacyGameMirrors({ ...entry, saveDirOverride }, { userDataDir }).some(row => row.mirrorRoot === path.join(moduleRoot, "saves")), false);
  }
  assert.deepEqual(GemRB.legacyGameMirrors({ ...entry, saveDirOverride: moduleRoot }, { userDataDir }), [], "a requested ancestor keeps every overlapping mirror live");
  fs.writeFileSync(marker, JSON.stringify({ source: path.join(userDataDir, "private-scripts") }));
  assert.equal(GemRB.legacyGameMirrors(entry, { userDataDir }).length, 2, "private/unknown original scripts must not be declared");
  fs.unlinkSync(marker);
  entry.moduleData = { bundledScriptsRoot: path.dirname(scripts) };
  assert.equal(GemRB.legacyGameMirrors(entry, { userDataDir })[2].sourceRoot, scripts);
});

test("HashLink declares its game mirror but preserves sibling receipts and bytecode identity", t => {
  const { userDataDir, sourceRoot, moduleRoot, entry } = fixture(t, "hashlink");
  entry.moduleData = { bytecodePath: path.join(sourceRoot, "game.hl") };
  const marker = path.join(moduleRoot, "game-source.json");
  fs.writeFileSync(marker, "old receipt remains");
  assert.deepEqual(HashLink.legacyGameMirrors(entry, { userDataDir }), [{ mirrorRoot: path.join(moduleRoot, "game"), sourceRoot }]);
  assert.equal(fs.readFileSync(marker, "utf8"), "old receipt remains");
  assert.deepEqual(fs.readdirSync(moduleRoot), ["game-source.json"]);
});

test("all three hooks recover descriptor roots from a recorded writable input without mutating entries", t => {
  for (const [moduleId, mod] of [["gemrb", GemRB], ["hashlink", HashLink], ["ikemen", Ikemen]]) {
    const { userDataDir, sourceRoot, moduleRoot, entry } = fixture(t, moduleId);
    const root = path.join(moduleRoot, "writable-input", "files");
    entry.contentRootDir = root;
    entry.moduleData = { writableInput: { schemaVersion: 1, root, sourceRoot }, bytecodePath: path.join(root, "nested", "game.hl") };
    const before = JSON.stringify(entry), descriptors = mod.legacyGameMirrors(entry, { userDataDir });
    assert.ok(descriptors.some(row => row.mirrorRoot === root && row.sourceRoot === sourceRoot), moduleId);
    if (moduleId === "hashlink") {
      assert.equal(descriptors.find(row => row.mirrorRoot === path.join(moduleRoot, "game")).sourceRoot, path.join(sourceRoot, "nested"));
      assert.deepEqual(descriptors.find(row => row.mirrorRoot === root).entryPatch,
        { moduleData: { bytecodePath: path.join(sourceRoot, "nested", "game.hl") } });
      assert.equal(descriptors.filter(row => Object.hasOwn(row, "entryPatch")).length, 1, "opaque patch is attached only to its own restored view");
    }
    if (moduleId === "gemrb") assert.equal(descriptors[0].sourceRoot, sourceRoot);
    if (moduleId === "ikemen") assert.equal(descriptors.length, 1, "automatic Ikemen keeps the potentially live separate-runtime view");
    assert.equal(mod.legacyGameMirrors({ ...entry, saveDirOverride: path.join(root, "save") }, { userDataDir }).some(row => row.mirrorRoot === root), false, "explicit save override protects even an old writable-input tree");
    assert.equal(JSON.stringify(entry), before);
    assert.deepEqual(fs.readdirSync(moduleRoot), []);
  }
});

test("Ikemen declares old views only for an explicit ready original-distribution choice", t => {
  const { userDataDir, sourceRoot, moduleRoot, entry } = fixture(t, "ikemen");
  entry.runtimeData = { ikemen: { version: "1.0.0" } };
  let selection = { ready: true, install: { executablePath: path.join(sourceRoot, "Engine.app", "Contents", "MacOS", "runner") } };
  const calls = [];
  t.mock.method(require("../src/modules/ikemen/runtime/manager"), "resolveSelection", (...args) => { calls.push(args); return selection; });
  const expected = [{ mirrorRoot: path.join(moduleRoot, "game"), sourceRoot },
    { mirrorRoot: path.join(moduleRoot, "saves"), sourceRoot: path.join(sourceRoot, "save"), createSourceWithin: sourceRoot }];
  assert.deepEqual(Ikemen.legacyGameMirrors(entry, { userDataDir }), expected);
  assert.equal(calls[0][3].verification, "status");
  assert.deepEqual(Ikemen.legacyGameMirrors({ ...entry, saveDirOverride: path.join(sourceRoot, "save") }, { userDataDir }), expected);
  assert.deepEqual(Ikemen.legacyGameMirrors({ ...entry, saveDirOverride: path.join(sourceRoot, "different-save") }, { userDataDir }), []);
  assert.deepEqual(Ikemen.legacyGameMirrors({ ...entry, saveDirOverride: path.join(moduleRoot, "saves", "slot1") }, { userDataDir }), [], "a current private save override keeps required fallback state");
  selection = { ready: true, install: { executablePath: path.join(path.dirname(sourceRoot), "separate-runtime", "runner") } };
  assert.deepEqual(Ikemen.legacyGameMirrors(entry, { userDataDir }), []);
  selection = { ready: false };
  assert.deepEqual(Ikemen.legacyGameMirrors(entry, { userDataDir }), []);
  const callCount = calls.length;
  assert.deepEqual(Ikemen.legacyGameMirrors({ ...entry, runtimeData: {} }, { userDataDir }), []);
  assert.deepEqual(Ikemen.legacyGameMirrors({ ...entry, runtimeData: { ikemen: { version: "auto" } } }, { userDataDir }), []);
  assert.equal(calls.length, callCount, "ambiguous defaults must not probe runtime selection");
  assert.deepEqual(fs.readdirSync(moduleRoot), [], "descriptor discovery never prepares, migrates or removes bytes");
});
