const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createBackendOperations } = require("../src/core/backend-operations");
const Installers = require("../src/modules/shared/installers");
const GameStore = require("../src/core/game-store");

test("patcher status keeps metadata input preparation read-only while explicit changes remain writable", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backend-patcher-readonly-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "game"), userDataDir = path.join(root, "data"), source = path.join(gamePath, "version.txt");
  fs.mkdirSync(gamePath);fs.writeFileSync(source, "0");
  const preparations = [];let acquisitions = 0, patches = 0, removals = 0;
  t.mock.method(Installers, "prepareInput", async (inputPath, options) => {
    preparations.push(options.readOnly);
    if (options.readOnly !== true) acquisitions++;
    return { inputPath };
  });
  const info = { id: "fixture", label: "Fixture", supports: { cheatsPatcher: true }, runtime: {} };
  const patcher = { getPatchStatus: () => ({ patched: true }), patchGame: () => { patches++;return true; }, unpatchGame: () => { removals++;return true; } };
  const mod = { id: info.id, manifest: info, cheats: { patcher }, libs: { patcher } };
  const registry = { listModuleIds: () => [info.id], listModules: () => [info], getModuleInfo: () => info,
    getModule: () => mod, getModuleDir: () => root, listSharedRuntimeManagers: () => [],
    detectGameAsync: async () => ({ moduleId: info.id, gamePath, contentRootDir: gamePath, name: "Fixture",
      moduleData: { version: fs.readFileSync(source, "utf8") } }) };
  const entry = { gameId: "fixture", moduleId: info.id, gamePath, importPath: gamePath, moduleData: {} };
  GameStore.writeGameRecord(userDataDir, entry);
  const operations = createBackendOperations({ userDataDir, registry });
  t.after(() => operations.beginShutdown());
  let revision = 0;
  for (const family of ["cheats", "libs"]) {
    fs.writeFileSync(source, String(++revision));
    const before = acquisitions;
    assert.deepEqual(await operations.patcher(entry, family, "status"), { patched: true });
    assert.equal(preparations.at(-1), true);
    assert.equal(acquisitions, before, "automatic status cannot acquire installer tools");
    for (const action of ["patch", "unpatch", "updateVisibility"]) {
      fs.writeFileSync(source, String(++revision));
      const previous = acquisitions;
      assert.equal(await operations.patcher(entry, family, action, { toolsButtonVisible: true }), true);
      assert.equal(preparations.at(-1), false);
      assert.equal(acquisitions, previous + 1, action + " retains writable input preparation");
    }
  }
  assert.equal(patches, 4);assert.equal(removals, 4);
});
