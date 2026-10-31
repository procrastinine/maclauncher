const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const GameAvailability = require("../src/core/game-availability");
const GameData = require("../src/modules/shared/game-data");
const GameStore = require("../src/core/game-store");
const Relocation = require("../src/core/game-relocation");
const { createGameMetadataService } = require("../src/core/game-metadata");
const GameCommands = require("../src/main/game-command");

// A game imported from a drive, then moved to another folder. The chooser and
// detection are injected, so no dialog opens and no engine probe runs.
async function movedGame(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maclauncher-relocation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "data"), gameId = "relocated-game";
  const oldRoot = path.join(root, "Volumes", "Games Drive", "Library", "Fixture Game");
  const newRoot = path.join(root, "Moved", "Fixture Game");
  fs.mkdirSync(path.join(oldRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(oldRoot, "bin", "run"), "run");
  fs.writeFileSync(path.join(oldRoot, "version.txt"), "1.0");
  const detections = [], labels = { fixture: "Fixture Engine", other: "Other Engine" };
  const modules = {};
  const registry = {
    listModuleIds: () => Object.keys(labels), listModules: () => Object.entries(labels).map(([id, label]) => ({ id, label })),
    getModuleInfo: id => ({ id, label: labels[id] || id }), getModule: id => modules[id] || null,
    getModuleDir: () => path.join(root, "module"), listSupportedInputExtensions: () => ["exe", "swf"],
    async detectGameAsync(input) {
      detections.push(input);
      const gamePath = path.basename(input) === "run" ? path.dirname(path.dirname(input)) : input;
      if (fs.existsSync(path.join(gamePath, "unsupported.txt"))) throw Object.assign(new Error("No supported game was found."), { code: "DETECTION_UNSUPPORTED" });
      const moduleId = fs.existsSync(path.join(gamePath, "other.txt")) ? "other" : "fixture";
      return { gamePath, contentRootDir: gamePath, moduleId, name: "Fixture",
        moduleData: { version: fs.readFileSync(path.join(gamePath, "version.txt"), "utf8"), detectedRoot: gamePath } };
    }
  };
  const desktopDir = path.join(root, "Desktop");
  fs.mkdirSync(desktopDir);
  const service = createGameMetadataService({ userDataDir, registry, app: { getPath: () => desktopDir }, inputPreparation: async input => ({ inputPath: input, containerData: null }) });
  const settings = { modules: {}, runtimes: {} };
  GameStore.writeGameRecord(userDataDir, { gameId, gamePath: oldRoot, importPath: path.join(oldRoot, "bin", "run"),
    moduleId: "fixture", runtimeId: "runner", moduleData: {}, runtimeData: {} });
  await service.refreshEntry(GameStore.readGameRecord(userDataDir, gameId), settings);
  // The user's own settings and choices for this game.
  GameStore.writeGameRecord(userDataDir, { ...GameStore.readGameRecord(userDataDir, gameId), name: "Custom title",
    notes: "Chapter 3", launchArguments: "--windowed", networkAccess: false, startSteamClient: "never", cheats: { speed: 2 },
    runtimeSettings: { runner: { scale: 2 } }, runtimeData: { runner: { executable: path.join(oldRoot, "bin", "run") } },
    saveDirOverride: path.join(oldRoot, "saves"),
    moduleData: { ...GameStore.readGameRecord(userDataDir, gameId).moduleData, script: path.join(oldRoot, "scripts", "main.txt"), shared: "/Shared/tools" } });
  fs.mkdirSync(path.join(GameData.resolveGameDir(userDataDir, gameId), "save-snapshots"), { recursive: true });
  fs.writeFileSync(path.join(GameData.resolveGameDir(userDataDir, gameId), "save-snapshots", "kept.txt"), "snapshot");
  fs.mkdirSync(path.dirname(newRoot), { recursive: true });
  fs.renameSync(oldRoot, newRoot);
  fs.writeFileSync(path.join(newRoot, "version.txt"), "2.0");
  const choices = [];
  const relocation = choice => Relocation.createGameRelocation({ userDataDir, registry, metadata: service,
    choose: async descriptor => { choices.push(descriptor); return typeof choice === "function" ? choice() : choice; } });
  return { root, userDataDir, gameId, oldRoot, newRoot, registry, service, settings, detections, choices, relocation, modules, desktopDir };
}

test("Locate keeps the game ID and its settings and moves the record to the detected location", async t => {
  const f = await movedGame(t);
  assert.equal((await GameAvailability.checkGameAvailability(GameStore.readGameRecord(f.userDataDir, f.gameId), { userDataDir: f.userDataDir })).reason, "missing");
  f.detections.length = 0;
  const result = await f.relocation(f.newRoot).relocate({ gameId: f.gameId, gamePath: f.oldRoot }, f.settings);
  assert.equal(f.choices.length, 1);
  assert.deepEqual(f.choices[0].kinds, ["directory"], "a folder game is located with a folder chooser");
  assert.equal(f.choices[0].defaultPath, path.dirname(f.oldRoot), "the chooser starts in the nearest existing parent");
  assert.equal(f.choices[0].buttonLabel, "Locate");
  assert.deepEqual(f.detections, [path.join(f.newRoot, "bin", "run")], "detection runs again at the new location from the imported file");
  assert.equal(result.relocated, true);
  const record = GameStore.readGameRecord(f.userDataDir, f.gameId);
  assert.equal(record.gameId, f.gameId);
  assert.equal(record.gamePath, f.newRoot);
  assert.equal(record.importPath, path.join(f.newRoot, "bin", "run"));
  assert.equal(record.contentRootDir, f.newRoot);
  assert.equal(record.name, "Custom title");
  assert.equal(record.notes, "Chapter 3");
  assert.equal(record.launchArguments, "--windowed");
  assert.equal(record.networkAccess, false);
  assert.equal(record.startSteamClient, "never");
  assert.deepEqual(record.cheats, { speed: 2 });
  assert.deepEqual(record.runtimeSettings, { runner: { scale: 2 } });
  assert.equal(record.moduleData.version, "2.0", "detected data comes from the new location");
  assert.equal(record.moduleData.detectedRoot, f.newRoot);
  assert.equal(fs.readFileSync(path.join(GameData.resolveGameDir(f.userDataDir, f.gameId), "save-snapshots", "kept.txt"), "utf8"), "snapshot");
  const cache = JSON.parse(fs.readFileSync(path.join(GameData.resolveGameDir(f.userDataDir, f.gameId), "metadata.json"), "utf8"));
  assert.equal(cache.detected.gamePath, f.newRoot, "the detection cache describes the new location");
  assert.deepEqual(await GameAvailability.checkGameAvailability(record, { userDataDir: f.userDataDir }), { available: true });
  assert.equal(GameStore.listGameIds(f.userDataDir).length, 1, "no second library entry is created");
});

test("paths stored inside the old location move with the game, and other values stay", async t => {
  const f = await movedGame(t);
  await f.relocation(f.newRoot).relocate({ gameId: f.gameId }, f.settings);
  const record = GameStore.readGameRecord(f.userDataDir, f.gameId);
  assert.equal(record.saveDirOverride, path.join(f.newRoot, "saves"));
  assert.equal(record.runtimeData.runner.executable, path.join(f.newRoot, "bin", "run"));
  assert.equal(record.moduleData.script, path.join(f.newRoot, "scripts", "main.txt"));
  assert.equal(record.moduleData.shared, "/Shared/tools");
  assert.equal(JSON.stringify(record).includes(f.oldRoot), false, "nothing in the record points at the old location");

  const from = "/Volumes/Games/Fixture", to = "/Users/me/Games/Fixture";
  assert.deepEqual(Relocation.rebaseRecord({ gamePath: from, name: from, notes: `${from}/notes`, list: [`${from}/a`, "/Volumes/Games/Fixture 2/b", "relative/c"],
    nested: { file: `${from}/x/y.dat` } }, from, to),
  { gamePath: to, name: from, notes: `${from}/notes`, list: [`${to}/a`, "/Volumes/Games/Fixture 2/b", "relative/c"], nested: { file: `${to}/x/y.dat` } });

  // Launcher state kept under the game path, such as the latest Play's notices.
  const warnings = new Map([[from, ["Shader skipped"]], ["/other", ["Kept"]]]), notices = new Map([[from, ["Steam start timed out"]]]);
  Relocation.moveKeys([warnings, notices], from, to);
  assert.deepEqual([...warnings], [["/other", ["Kept"]], [to, ["Shader skipped"]]]);
  assert.deepEqual([...notices], [[to, ["Steam start timed out"]]]);
});

test("a location detected as another game type is refused with a reason and changes nothing", async t => {
  const f = await movedGame(t);
  fs.writeFileSync(path.join(f.newRoot, "other.txt"), "other");
  const before = GameStore.readGameRecord(f.userDataDir, f.gameId);
  await assert.rejects(f.relocation(f.newRoot).relocate({ gameId: f.gameId }, f.settings), error =>
    error.code === "GAME_TYPE_MISMATCH" && error.message === "The selected location is detected as Other Engine, not Fixture Engine.");
  assert.deepEqual(GameStore.readGameRecord(f.userDataDir, f.gameId), before);

  fs.rmSync(path.join(f.newRoot, "other.txt"));
  fs.writeFileSync(path.join(f.newRoot, "unsupported.txt"), "");
  await assert.rejects(f.relocation(f.newRoot).relocate({ gameId: f.gameId }, f.settings), error =>
    error.code === "DETECTION_UNSUPPORTED" && error.message === "MacLauncher does not recognize a game at the selected location.");
  assert.deepEqual(GameStore.readGameRecord(f.userDataDir, f.gameId), before);

  assert.deepEqual(await f.relocation(null).relocate({ gameId: f.gameId }, f.settings), { relocated: false }, "a canceled chooser changes nothing");
  assert.deepEqual(GameStore.readGameRecord(f.userDataDir, f.gameId), before);
});

test("a location already used by another library game is refused", async t => {
  const f = await movedGame(t);
  GameStore.writeGameRecord(f.userDataDir, { gameId: "other-entry", gamePath: f.newRoot, importPath: f.newRoot, moduleId: "fixture" });
  const before = GameStore.readGameRecord(f.userDataDir, f.gameId);
  await assert.rejects(f.relocation(f.newRoot).relocate({ gameId: f.gameId }, f.settings), error =>
    error.code === "GAME_LOCATION_IN_USE" && error.message === "Another game in the library already uses the selected location.");
  assert.deepEqual(GameStore.readGameRecord(f.userDataDir, f.gameId), before);
});

test("the chooser matches a file or folder root, and an unpacked installer is located by its installer", async () => {
  const userDataDir = "/Users/me/Library/Application Support/maclauncher";
  const existing = new Set(["/Volumes", "/"]);
  const check = async folder => ({ available: existing.has(folder) });
  const file = await Relocation.chooser({ gameId: "a", name: "Arcade", gamePath: "/Volumes/Old/Games/arcade.swf" }, { userDataDir, extensions: ["swf"], check });
  assert.deepEqual(file, { label: "Locate Arcade", kinds: ["file"], extensions: [], buttonLabel: "Locate",
    message: "Choose the game's file at its new location.", defaultPath: "/Volumes" });
  const folder = await Relocation.chooser({ gameId: "b", gamePath: "/Volumes/Old/Games/Version 1.2" }, { userDataDir, extensions: ["swf"], check });
  assert.deepEqual(folder.kinds, ["directory"], "a dotted folder name is still a folder");
  assert.deepEqual((await Relocation.chooser({ gameId: "c", gamePath: "/Volumes/Old/Game.app" }, { userDataDir, check })).kinds, ["file"]);

  const installer = { gameId: "d", gamePath: `${userDataDir}/games/d/containers/inno/key/files`, importPath: "/Volumes/Old/setup.exe" };
  assert.deepEqual(Relocation.target(installer, "/Users/me/Downloads/setup.exe", { userDataDir }),
    { from: "/Volumes/Old/setup.exe", field: "importPath", input: "/Users/me/Downloads/setup.exe", paths: { importPath: "/Users/me/Downloads/setup.exe" } });
  const nested = { gameId: "e", gamePath: "/Volumes/Old/Game", importPath: "/Volumes/Old/Game/Game.exe" };
  assert.deepEqual(Relocation.target(nested, "/Users/me/Game", { userDataDir, exists: () => false }).paths,
    { gamePath: "/Users/me/Game", importPath: "/Users/me/Game" }, "an imported file missing from the new location falls back to the chosen folder");
});

test("Locate updates extraction receipts before reading readiness, including nested records and path keys", async t => {
  const f = await movedGame(t), Extract = require("../src/modules/godot/extract");
  const entry = GameStore.readGameRecord(f.userDataDir, f.gameId);
  const extractedRoot = Extract.resolveExtractionRoot({ entry, userDataDir: f.userDataDir });
  fs.mkdirSync(extractedRoot, { recursive: true });
  Extract.writeExtractionMeta(extractedRoot, { sourcePath: f.oldRoot, extractedAt: 123 });
  fs.writeFileSync(path.join(extractedRoot, "kept.txt"), "extracted user edits");
  const receipt = path.join(extractedRoot, Extract.EXTRACT_META), original = fs.readFileSync(receipt);
  const other = path.join(GameData.resolveGameModuleDir(f.userDataDir, f.gameId, "godot"), "nested", "another-record.json");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, JSON.stringify({ nested: [{ [path.join(f.oldRoot, "file")]: { source: path.join(f.oldRoot, "a\nb") } }],
    unrelated: f.oldRoot + "-other/file" }));
  f.modules.fixture = { mergeEntry(_previous, merged) { return { ...merged, moduleData: { ...merged.moduleData,
    ...Extract.resolveExtractionStatus({ entry: { ...merged, moduleData: { extractedRoot } }, userDataDir: f.userDataDir, sourcePath: merged.gamePath }) } }; } };
  assert.equal(Extract.resolveExtractionStatus({ entry: { ...entry, moduleData: { extractedRoot } }, userDataDir: f.userDataDir, sourcePath: f.newRoot }).extractedReady, false);
  const result = await f.relocation(f.newRoot).relocate(entry, f.settings);
  assert.equal(result.entry.moduleData.extractedReady, true);
  assert.equal(result.entry.moduleData.sourcePath, f.newRoot);
  assert.deepEqual(JSON.parse(fs.readFileSync(other)), { nested: [{ [path.join(f.newRoot, "file")]: { source: path.join(f.newRoot, "a\nb") } }], unrelated: f.oldRoot + "-other/file" });
  assert.equal(fs.readFileSync(path.join(extractedRoot, "kept.txt"), "utf8"), "extracted user edits");
  const gameDir = GameData.resolveGameDir(f.userDataDir, f.gameId);
  const backups = fs.readdirSync(path.join(gameDir, ".relocation-backups"));
  assert.equal(backups.length, 1, "a completed relocation keeps one backup folder and no marker");
  assert.ok(fs.readFileSync(path.join(gameDir, ".relocation-backups", backups[0], path.relative(gameDir, receipt))).equals(original),
    "original receipt bytes remain recoverable");
  // A later relocation keeps only its own backups.
  const nextRoot = path.join(f.root, "Moved again");
  fs.renameSync(f.newRoot, nextRoot);
  await f.relocation(nextRoot).relocate({ gameId: f.gameId }, f.settings);
  const later = fs.readdirSync(path.join(gameDir, ".relocation-backups"));
  assert.equal(later.length, 1);
  assert.notEqual(later[0], backups[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(gameDir, ".relocation-backups", later[0], path.relative(gameDir, receipt)))).sourcePath, f.newRoot);
});

test("files the game or its runtime owns stay byte-identical, and only marked records at the top of such folders move", async t => {
  const f = await movedGame(t), gameDir = GameData.resolveGameDir(f.userDataDir, f.gameId);
  const owned = { // a private copy, a Windows prefix, a runtime profile, an extracted copy and a save folder
    copy: path.join(gameDir, "modules", "mv", "writable-input", "files", "www", "data", "System.json"),
    prefix: path.join(gameDir, "runtimes", "crossover", "bottles", "game", "drive_c", "users", "maclauncher", "settings.json"),
    profile: path.join(gameDir, "runtimes", "nwjs", "profiles", "0.1", "Default", "state.json"),
    extracted: path.join(gameDir, "modules", "construct", "extracted", "data.json"),
    save: path.join(gameDir, "modules", "dosbox", "saves", "slot.json")
  };
  const bytes = JSON.stringify({ path: path.join(f.oldRoot, "bin", "run") });
  for (const file of Object.values(owned)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  const marked = path.join(gameDir, "modules", "construct", "extracted", ".maclauncher-construct-extract.json");
  const record = path.join(gameDir, "modules", "mv", "writable-input", "input.json");
  for (const file of [marked, record]) fs.writeFileSync(file, JSON.stringify({ sourcePath: f.oldRoot }));
  await f.relocation(f.newRoot).relocate({ gameId: f.gameId }, f.settings);
  for (const file of Object.values(owned)) assert.equal(fs.readFileSync(file, "utf8"), bytes, path.relative(gameDir, file));
  for (const file of [marked, record]) assert.equal(JSON.parse(fs.readFileSync(file)).sourcePath, f.newRoot, path.relative(gameDir, file));
});

test("a relocation interrupted before its record is saved is undone at the next start, and one saved later is kept", async t => {
  const f = await movedGame(t), gameDir = GameData.resolveGameDir(f.userDataDir, f.gameId);
  const receipt = path.join(gameDir, "modules", "fixture", "preparation.json"), link = path.join(gameDir, "modules", "fixture", "run");
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, JSON.stringify({ sourcePath: f.oldRoot }));
  fs.symlinkSync(path.join(f.oldRoot, "bin", "run"), link);
  const original = fs.readFileSync(receipt);
  // The process stops after the records are rewritten and before game.json is.
  Relocation.rebaseStoredRecords({ userDataDir: f.userDataDir, gameId: f.gameId, from: f.oldRoot, to: f.newRoot });
  assert.equal(JSON.parse(fs.readFileSync(receipt)).sourcePath, f.newRoot);
  assert.deepEqual(Relocation.recoverInterruptedRelocations(f.userDataDir), []);
  assert.deepEqual(fs.readFileSync(receipt), original);
  assert.equal(fs.readlinkSync(link), path.join(f.oldRoot, "bin", "run"));
  const markers = () => fs.readdirSync(path.join(gameDir, ".relocation-backups")).filter(name => name.endsWith(".json"));
  assert.deepEqual(markers(), []);
  // After game.json names the new root, the relocation has finished.
  Relocation.rebaseStoredRecords({ userDataDir: f.userDataDir, gameId: f.gameId, from: f.oldRoot, to: f.newRoot });
  GameStore.writeGameRecord(f.userDataDir, { ...GameStore.readGameRecord(f.userDataDir, f.gameId), gamePath: f.newRoot });
  assert.deepEqual(Relocation.recoverInterruptedRelocations(f.userDataDir), []);
  assert.equal(JSON.parse(fs.readFileSync(receipt)).sourcePath, f.newRoot);
  assert.equal(fs.readlinkSync(link), path.join(f.newRoot, "bin", "run"));
  assert.deepEqual(markers(), []);
});

test("links into the old location move with it, while other links, saves and records that cannot be rewritten stay unchanged", async t => {
  const f = await movedGame(t), gameDir = GameData.resolveGameDir(f.userDataDir, f.gameId);
  const dir = path.join(gameDir, "modules", "future-module");
  fs.mkdirSync(dir, { recursive: true });
  // Text that is not valid JSON, even when it names a folder that only shares
  // the old root's prefix, and keys that would overlap stay as they are.
  const malformed = path.join(dir, "preparation.json"), broken = `﻿{"sourcePath":${JSON.stringify(f.oldRoot + "bar")}}`;
  fs.writeFileSync(malformed, broken);
  const collision = path.join(dir, "other.json"), ambiguous = JSON.stringify({ [f.oldRoot]: "old", [f.newRoot]: "new" });
  fs.writeFileSync(collision, ambiguous);
  for (const name of ["saves", "save-snapshots", "partition", "logs"]) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "data.json"), JSON.stringify({ path: f.oldRoot }));
  }
  // A prepared view links launcher-owned files and files in the game folder.
  const outside = path.join(f.root, "external.json"), alias = path.join(dir, "alias.json"), link = path.join(dir, "version.txt");
  fs.writeFileSync(outside, JSON.stringify({ path: f.oldRoot }));
  fs.symlinkSync(outside, alias);
  fs.symlinkSync(path.join(f.oldRoot, "version.txt"), link);
  const before = GameStore.readGameRecord(f.userDataDir, f.gameId);
  await f.relocation(f.newRoot).relocate(before, f.settings);
  assert.equal(fs.readFileSync(malformed, "utf8"), broken);
  assert.equal(fs.readFileSync(collision, "utf8"), ambiguous);
  for (const name of ["saves", "save-snapshots", "partition", "logs"]) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, name, "data.json"))).path, f.oldRoot);
  assert.equal(fs.readlinkSync(alias), outside, "a link outside the old location is kept");
  assert.equal(JSON.parse(fs.readFileSync(outside)).path, f.oldRoot, "no link is followed");
  assert.equal(fs.readlinkSync(link), path.join(f.newRoot, "version.txt"));
  assert.equal(fs.readFileSync(link, "utf8"), "2.0");
  const backups = fs.readdirSync(path.join(gameDir, ".relocation-backups"));
  assert.ok(backups.some(id => {
    const saved = path.join(gameDir, ".relocation-backups", id, path.relative(gameDir, link));
    return fs.lstatSync(saved, { throwIfNoEntry: false })?.isSymbolicLink() && fs.readlinkSync(saved) === path.join(f.oldRoot, "version.txt");
  }), "the original link is preserved");
  // A refused location restores the original links without reading them.
  const changes = Relocation.rebaseStoredRecords({ userDataDir: f.userDataDir, gameId: f.gameId, from: f.newRoot, to: f.oldRoot });
  assert.equal(fs.readlinkSync(link), path.join(f.oldRoot, "version.txt"));
  changes.restore();
  assert.equal(fs.readlinkSync(link), path.join(f.newRoot, "version.txt"));
  assert.equal(fs.readlinkSync(alias), outside);
});

test("Locate refreshes indexed and older Desktop commands while preserving edited and unindexed commands", async t => {
  const f = await movedGame(t), customDir = path.join(f.root, "Custom ' $() ✨");
  fs.mkdirSync(customDir);
  const options = { gamePath: f.oldRoot, userDataDir: f.userDataDir, repoRoot: customDir, executablePath: process.execPath, packaged: false };
  const indexed = GameCommands.writeGameCommand(path.join(customDir, "Play"), { ...options, gameId: f.gameId });
  const legacy = GameCommands.writeGameCommand(path.join(f.desktopDir, "Earlier"), { ...options, packaged: true,
    appBundlePath: path.join(f.root, "MacLauncher ' ✨.app"), executablePath: "/Applications/MacLauncher.app/Contents/MacOS/MacLauncher" });
  const unindexed = GameCommands.writeGameCommand(path.join(customDir, "Unindexed"), options);
  const edited = GameCommands.writeGameCommand(path.join(customDir, "Edited"), { ...options, gameId: f.gameId });
  // A command for another game kept inside this game's folder is not this game's.
  const nested = GameCommands.writeGameCommand(path.join(f.desktopDir, "Nested"), { ...options, gamePath: path.join(f.oldRoot, "Extra") });
  fs.appendFileSync(edited, "# user customization\n");
  const editedBytes = fs.readFileSync(edited), unindexedBytes = fs.readFileSync(unindexed), nestedBytes = fs.readFileSync(nested);
  await f.relocation(f.newRoot).relocate({ gameId: f.gameId }, f.settings);
  for (const file of [indexed, legacy]) {
    const script = fs.readFileSync(file, "utf8");
    assert.ok(script.includes(`GAME_PATH='${f.newRoot}'`));
    assert.ok(!script.includes(f.oldRoot));
    assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  }
  assert.deepEqual(fs.readFileSync(edited), editedBytes);
  assert.deepEqual(fs.readFileSync(unindexed), unindexedBytes);
  assert.deepEqual(fs.readFileSync(nested), nestedBytes);
  assert.equal(GameCommands.resolveGameCommandPath(f.userDataDir, f.oldRoot), f.newRoot, "unindexed commands resolve their saved game after Locate");
  const index = JSON.parse(fs.readFileSync(path.join(GameData.resolveGameDir(f.userDataDir, f.gameId), "shortcuts.json")));
  assert.equal(index.files.find(item => item.path === edited).stale, true);
  // The original shortcut still resolves after another move, and an actual
  // new game at an old location is not mistaken for the moved one.
  const nextRoot = path.join(f.root, "Moved again");
  fs.renameSync(f.newRoot, nextRoot);
  await f.relocation(nextRoot).relocate({ gameId: f.gameId }, f.settings);
  assert.equal(GameCommands.resolveGameCommandPath(f.userDataDir, f.oldRoot), nextRoot);
  fs.mkdirSync(f.oldRoot, { recursive: true });
  assert.equal(GameCommands.resolveGameCommandPath(f.userDataDir, f.oldRoot), f.oldRoot);
});
