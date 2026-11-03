const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("../src/modules/minori/main");
function directory(t) { const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "minori-backcompat-")); t.mock.method(os, "homedir", () => path.join(root, "home")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const Backcompat = require("../src/modules/minori/backcompat");

for (const location of ["original", "per-game fallback"]) test(`released v0.5.1 Minori saves restore ${location} normal destination and preserve conflicts`, async t => {
  const root = fs.realpathSync(directory(t)), game = path.join(root, "Original"), userDataDir = path.join(root, "profile"); fs.mkdirSync(game);
  t.mock.method(os, "homedir", () => path.join(root, "home"));
  const gameId = location === "original" ? "released-original" : "released-fallback";
  const sourceRoot = location === "original" ? path.join(game, "userdata") : path.join(root, "home", "Documents", "eden", "games", gameId, "userdata");
  if (location !== "original") {
    const access = fs.accessSync;
    t.mock.method(fs, "accessSync", (target, mode) => { if (target === game) { const error = new Error("fixture read-only"); error.code = "EROFS"; throw error; } return access(target, mode); });
  }
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "eden0001.sav"), "original progress");
  const entry = { gameId, gamePath: game }, context = { userDataDir };
  if (location !== "original") context.games = [{ moduleId: "minori", gameId: "existing-normal", gamePath: game, saveDirOverride: path.join(os.homedir(), "Documents/eden/userdata") }];
  const mirrorRoot = path.join(userDataDir, "games", entry.gameId, "modules", "minori", "saves");
  fs.mkdirSync(mirrorRoot, { recursive: true });
  fs.writeFileSync(path.join(mirrorRoot, "eden0001.sav"), "released conflict");
  fs.writeFileSync(path.join(mirrorRoot, "eden0002.sav"), "released progress");
  fs.writeFileSync(path.join(path.dirname(mirrorRoot), "cwd-user-note.txt"), "unknown cwd bytes");
  entry.defaultSaveDir = mirrorRoot;
  const before = JSON.stringify(entry);
  const descriptor = Backcompat.legacyGameMirrors(entry, context).find(row => row.mirrorRoot === mirrorRoot);
  assert.equal(JSON.stringify(entry), before, "descriptor collection never switches unrecovered saves");
  assert.deepEqual(descriptor, { mirrorRoot, sourceRoot, createSourceWithin: location === "original" ? game : path.join(os.homedir(), "Documents"),
    entryPatch: { defaultSaveDir: sourceRoot, saveLocations: [{ directory: sourceRoot, source: "ReMinori user data", confidence: "exact", label: "Saves" }], saveDirOverride: sourceRoot },
    releasedSaveRoute: { directory: mirrorRoot, entryPatch: { saveDirOverride: mirrorRoot }, proven: true, explicit: false } });
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, { userDataDir });
  assert.equal(result.complete, true, result.reason);
  Object.assign(entry, descriptor.entryPatch); // Standalone proof; shared runner consumption remains a root dependency.
  assert.equal(JSON.parse(JSON.stringify(entry)).saveLocations[0].directory, sourceRoot);
  assert.equal(fs.realpathSync(Module.resolveSaveLocations(entry).primaryDirectory), sourceRoot);
  assert.equal(fs.readFileSync(path.join(sourceRoot, "eden0002.sav"), "utf8"), "released progress");
  assert.equal(fs.readFileSync(path.join(sourceRoot, "eden0001.sav"), "utf8"), "original progress");
  const conflict = result.recoveredFiles.find(file => file.startsWith(path.join(sourceRoot, "eden0001.sav.MacLauncher-conflict-")));
  assert.ok(conflict); assert.equal(fs.readFileSync(conflict, "utf8"), "released conflict");
  assert.equal(fs.readFileSync(path.join(path.dirname(mirrorRoot), "cwd-user-note.txt"), "utf8"), "unknown cwd bytes");
  fs.rmSync(userDataDir, { recursive: true });
  assert.equal(fs.readFileSync(path.join(sourceRoot, "eden0002.sav"), "utf8"), "released progress");
});
test("released v0.5.1 Minori creates missing normal destination inside the existing game anchor", async t => {
  const root = fs.realpathSync(directory(t)), game = path.join(root, "Original"), userDataDir = path.join(root, "profile"); fs.mkdirSync(game);
  const entry = { gameId: "released-missing", gamePath: game }, context = { userDataDir };
  const mirrorRoot = path.join(userDataDir, "games", entry.gameId, "modules", "minori", "saves");
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "eden0001.sav"), "only surviving progress");
  const descriptor = Backcompat.legacyGameMirrors(entry, context).find(row => row.mirrorRoot === mirrorRoot);
  const before = JSON.stringify(entry);
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, { userDataDir });
  assert.equal(JSON.stringify(entry), before, "failed recovery does not apply any entry patch");
  assert.equal(descriptor.createSourceWithin, game);
  assert.equal(result.complete, true, result.reason);
  Object.assign(entry, descriptor.entryPatch); // Runner success-only entryPatch integration is root-owned.
  assert.equal(fs.readFileSync(path.join(Module.resolveSaveLocations(entry).primaryDirectory, "eden0001.sav"), "utf8"), "only surviving progress");
  assert.equal(fs.existsSync(mirrorRoot), false);
});

test("released v0.5.1 Minori creates a unique fallback only for an actual loaded-library collision", async t => {
  const root = directory(t), game = path.join(root, "Original"), userDataDir = path.join(root, "profile"); fs.mkdirSync(game);
  const entry = { gameId: "unique-fallback", gamePath: game }, context = { userDataDir, games: [{ moduleId: "minori", gameId: "existing-normal", gamePath: game, saveDirOverride: path.join(os.homedir(), "Documents/eden/userdata") }] };
  const mirrorRoot = path.join(userDataDir, "games", entry.gameId, "modules", "minori", "saves");
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "eden0001.sav"), "attributable released progress");
  entry.defaultSaveDir = mirrorRoot;
  const shared = path.join(os.homedir(), "Documents/eden/userdata");
  fs.mkdirSync(shared, { recursive: true }); fs.writeFileSync(path.join(shared, "eden0001.sav"), "unattributable shared progress");
  const access = fs.accessSync;
  t.mock.method(fs, "accessSync", (target, mode) => { if (target === game) { const error = new Error("fixture read-only"); error.code = "EROFS"; throw error; } return access(target, mode); });
  const before = JSON.stringify(entry), descriptor = Backcompat.legacyGameMirrors(entry, context).find(row => row.mirrorRoot === mirrorRoot);
  const destination = path.join(os.homedir(), "Documents/eden/games/unique-fallback/userdata");
  assert.equal(descriptor.sourceRoot, destination);
  assert.deepEqual(descriptor.entryPatch, { defaultSaveDir: destination, saveLocations: [{ directory: destination, source: "ReMinori user data", confidence: "exact", label: "Saves" }], saveDirOverride: destination });
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, { userDataDir });
  assert.equal(descriptor.createSourceWithin, path.join(os.homedir(), "Documents"));
  assert.equal(result.complete, true, result.reason);
  assert.equal(JSON.stringify(entry), before);
  Object.assign(entry, descriptor.entryPatch); // Runner consumption remains a separate root integration check.
  assert.equal(JSON.parse(JSON.stringify(entry)).saveLocations[0].directory, destination);
  assert.equal(fs.readFileSync(path.join(Module.resolveSaveLocations(entry).primaryDirectory, "eden0001.sav"), "utf8"), "attributable released progress");
  assert.equal(fs.readFileSync(path.join(shared, "eden0001.sav"), "utf8"), "unattributable shared progress");
  assert.equal(fs.existsSync(mirrorRoot), false);
});
test("released v0.5.1 Minori retains private progress when the standard Documents anchor is absent", async t => {
  const root = directory(t), game = path.join(root, "Original"), userDataDir = path.join(root, "profile"); fs.mkdirSync(game);
  const entry = { gameId: "missing-documents", gamePath: game }, context = { userDataDir };
  const mirrorRoot = path.join(userDataDir, "games", entry.gameId, "modules", "minori", "saves");
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "eden0001.sav"), "only surviving progress");
  const access = fs.accessSync;
  t.mock.method(fs, "accessSync", (target, mode) => { if (target === game) { const error = new Error("fixture read-only"); error.code = "EROFS"; throw error; } return access(target, mode); });
  const before = JSON.stringify(entry), descriptor = Backcompat.legacyGameMirrors(entry, context).find(row => row.mirrorRoot === mirrorRoot);
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, { userDataDir });
  assert.equal(result.complete, false); assert.match(result.reason, /ENOENT/);
  assert.equal(JSON.stringify(entry), before); assert.equal(fs.existsSync(path.join(os.homedir(), "Documents")), false);
  assert.equal(fs.readFileSync(path.join(mirrorRoot, "eden0001.sav"), "utf8"), "only surviving progress");
});
test("released v0.5.1 Minori runner persists upstream fallback and all current save fields only after recovery", async t => {
  const root = directory(t), game = path.join(root, "Original"), userDataDir = path.join(root, "profile"); fs.mkdirSync(game);
  const entry = { moduleId: "minori", gameId: "runner-identity", gamePath: game };
  const mirrorRoot = path.join(userDataDir, "games", entry.gameId, "modules", "minori", "saves");
  fs.mkdirSync(mirrorRoot, { recursive: true }); fs.writeFileSync(path.join(mirrorRoot, "eden0002.sav"), "released runner progress");
  entry.defaultSaveDir = mirrorRoot; entry.saveLocations = [{ directory: mirrorRoot, source: "Released private saves" }];
  const shared = path.join(os.homedir(), "Documents/eden/userdata");
  fs.mkdirSync(shared, { recursive: true }); fs.writeFileSync(path.join(shared, "eden0001.sav"), "unattributable shared progress");
  const access = fs.accessSync;
  t.mock.method(fs, "accessSync", (target, mode) => { if (target === game) { const error = new Error("fixture read-only"); error.code = "EROFS"; throw error; } return access(target, mode); });
  let persisted, settings;
  const result = await require("../src/core/backcompat/data-migrations").runDataMigrations({
    settings: {}, games: [entry], userDataDir, registry: { getModule: () => ({ ...Module, ...Backcompat }) },
    saveSettings: next => { settings = next; }, saveEntry: next => { persisted = JSON.parse(JSON.stringify(next)); }
  });
  assert.equal(result.complete, true); assert.deepEqual(result.pendingIds, []);
  const destination = path.join(os.homedir(), "Documents/eden/userdata");
  assert.equal(persisted.saveDirOverride, destination); assert.equal(persisted.defaultSaveDir, destination);
  assert.equal(persisted.saveLocations[0].directory, destination);
  assert.equal(fs.readFileSync(path.join(Module.resolveSaveLocations(persisted).primaryDirectory, "eden0002.sav"), "utf8"), "released runner progress");
  assert.equal(fs.readFileSync(path.join(shared, "eden0001.sav"), "utf8"), "unattributable shared progress");
  const completed = await require("../src/core/backcompat/data-migrations").runDataMigrations({
    settings, games: [persisted], userDataDir, registry: { getModule: () => { throw Error("completed migration cannot revisit this game"); } },
    saveSettings: () => { throw Error("completed migration cannot persist again"); }
  });
  assert.equal(completed.complete, true);
  fs.rmSync(userDataDir, { recursive: true });
  assert.equal(fs.readFileSync(path.join(destination, "eden0002.sav"), "utf8"), "released runner progress");
});

test("Minori released-save facts precede generated choices and retain ambiguous recovery as pending data", t => {
  const root = directory(t), gamePath = path.join(root, "Original"), userDataDir = path.join(root, "profile"); fs.mkdirSync(gamePath);
  const entry = { moduleId: "minori", gameId: "released-facts", gamePath };
  const mirrorRoot = path.join(userDataDir, "games", entry.gameId, "modules", "minori", "saves");
  fs.mkdirSync(mirrorRoot, { recursive: true });
  const descriptor = Backcompat.legacyGameMirrors(entry, { userDataDir }).find(row => row.mirrorRoot === mirrorRoot);
  assert.deepEqual(descriptor.releasedSaveRoute, { directory: mirrorRoot, entryPatch: { saveDirOverride: mirrorRoot }, proven: true, explicit: false });
  assert.equal(descriptor.entryPatch.saveDirOverride, path.join(gamePath, "userdata"), "Generated substitution choice is not authored explicit data");
  const generated = { ...entry, saveDirOverride: path.join(root, "generated-current-choice") };
  assert.equal(Backcompat.legacyGameMirrors(generated, { userDataDir, games: [entry] })[0].releasedSaveRoute.explicit, false);
  const ambiguous = { ...entry, gamePath: null, defaultSaveDir: mirrorRoot };
  const [pending] = Backcompat.legacyGameMirrors(ambiguous, { userDataDir });
  assert.equal(pending.sourceRoot, null);
  assert.deepEqual(pending.releasedSaveRoute, { directory: mirrorRoot, entryPatch: { saveDirOverride: mirrorRoot }, proven: true, explicit: false });
  const fresh = { ...entry, gameId: "fresh-no-release" };
  assert.equal(Backcompat.legacyGameMirrors(fresh, { userDataDir })[0].releasedSaveRoute.proven, false);
});

test("Minori released-save facts mark only consumed save settings and environment explicit", t => {
  const root = directory(t), gamePath = path.join(root, "Original"), userDataDir = path.join(root, "profile"); fs.mkdirSync(gamePath);
  const entry = { moduleId: "minori", gameId: "authored-facts", gamePath };
  const directoryPath = path.join(userDataDir, "games", entry.gameId, "modules", "minori", "saves");
  const cases = [[{ ...entry, saveDirOverride: path.join(root, "Chosen Saves") }, true], [{ ...entry, launchArguments: "--game-root /author-choice" }, false]];
  for (const [authored, explicit] of cases) {
    const row = Backcompat.legacyGameMirrors(authored, { userDataDir, gameArguments: ["--fullscreen"] })[0];
    assert.equal(row.releasedSaveRoute.directory, row.mirrorRoot);
    assert.equal(row.releasedSaveRoute.explicit, explicit);
    assert.deepEqual(row.releasedSaveRoute.entryPatch, { saveDirOverride: directoryPath });
  }
  const previous = process.env.MACLAUNCHER_MINORI_SAVE_DIR;
  t.after(() => { if (previous === undefined) delete process.env.MACLAUNCHER_MINORI_SAVE_DIR; else process.env.MACLAUNCHER_MINORI_SAVE_DIR = previous; });
  process.env.MACLAUNCHER_MINORI_SAVE_DIR = path.join(root, "Environment Saves");
  const row = Backcompat.legacyGameMirrors(entry, { userDataDir })[0];
  assert.equal(row.sourceRoot, process.env.MACLAUNCHER_MINORI_SAVE_DIR);
  assert.equal(row.releasedSaveRoute.explicit, true);
});
