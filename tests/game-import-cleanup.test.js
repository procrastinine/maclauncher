const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGameMetadataService } = require("../src/core/game-metadata");
const GameData = require("../src/modules/shared/game-data");

test("a failed new import leaves no launcher folder, while a container unpack stays for reuse", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-import-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "data"), gamePath = path.join(root, "game");
  fs.mkdirSync(gamePath); fs.mkdirSync(path.join(userDataDir, "games"), { recursive: true });
  const info = { id: "fixture", label: "Fixture" };
  const owned = [];
  // The module writes into the new game's folder before the import fails.
  const mod = { id: info.id, manifest: info, onImport(entry) {
    const directory = GameData.resolveGameModuleDir(userDataDir, entry.gameId, "fixture");
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "extracted.txt"), "partial");
    owned.push(entry.gameId);
    throw new Error("unsupported game");
  } };
  const registry = { listModuleIds: () => [info.id], listModules: () => [info], getModuleInfo: () => info,
    getModule: () => mod, getModuleDir: () => path.join(root, "module"),
    detectGameAsync: async () => ({ gamePath, contentRootDir: gamePath, moduleId: info.id, name: "Fixture", moduleData: {} }) };
  const service = createGameMetadataService({ userDataDir, registry });
  await assert.rejects(service.importEntry(gamePath, {}), /unsupported game/);
  assert.equal(owned.length, 1);
  assert.equal(fs.existsSync(GameData.resolveGameDir(userDataDir, owned[0])), false);

  // An unpacked container is the reusable input cache for the next import.
  const container = createGameMetadataService({ userDataDir, registry, inputPreparation: async (input, { gameId }) => {
    const unpacked = path.join(GameData.resolveGameDir(userDataDir, gameId), "containers", "inno", "generation");
    fs.mkdirSync(unpacked, { recursive: true });
    return { inputPath: input };
  } });
  await assert.rejects(container.importEntry(gamePath, {}), /unsupported game/);
  assert.equal(owned.length, 2);
  assert.equal(fs.existsSync(path.join(GameData.resolveGameDir(userDataDir, owned[1]), "containers", "inno", "generation")), true);
  assert.deepEqual(fs.readdirSync(path.join(userDataDir, "games")), [owned[1]]);
});
