const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const GameAvailability = require("../src/core/game-availability");
const { createGameMetadataService } = require("../src/core/game-metadata");
const { createSaveService } = require("../src/core/save-service");
const { createAvailabilityMonitor } = require("../src/main/game-availability-monitor");
const GameStore = require("../src/core/game-store");
const Snapshots = require("../src/modules/shared/save-snapshots");

test("runtime setting option providers remain read-only and usable without game files", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maclauncher-runtime-options-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = { gameId: "missing-game", gamePath: path.join(root, "missing"), moduleId: "fixture", runtimeId: "wine" };
  const info = { id: "fixture", supports: {}, runtime: { supported: ["wine"], entries: { wine: { settings: {
    fields: [{ key: "graphics", type: "select", optionsAction: "localGraphics", options: [{ value: "auto", label: "Automatic" }] }]
  } } } } };
  let calls = 0, probes = 0;
  const mod = { manifest: info, prepareInput: () => assert.fail("option listing never prepares game files"), actions: {
    localGraphics(input, _payload, context) { calls++; assert.equal(context.runtimeId, "wine"); input.name = "transient"; return { options: ["auto"] }; },
    inspectFiles() { assert.fail("ordinary tools remain gated by availability"); }
  } };
  const registry = { getModule: () => mod, getModuleInfo: () => info, listModuleIds: () => [info.id], listModules: () => [info],
    listSharedRuntimeManagers: () => [] };
  const userDataDir = path.join(root, "data");
  const launcher = require("../src/core/launcher").createLauncher({ userDataDir, registry });
  const PathStat = require("../src/core/path-stat-probe"), stat = PathStat.statPath;
  t.mock.method(PathStat, "statPath", (...args) => { if (args[0] === entry.gamePath) probes++; return stat(...args); });
  assert.deepEqual(await launcher.runAction(entry, "localGraphics"), { options: ["auto"] });
  assert.equal(calls, 1); assert.equal(probes, 0); assert.equal(entry.name, undefined);
  assert.equal(GameStore.readGameRecord(userDataDir, entry.gameId), null, "opening runtime settings never creates or rewrites a record");
  await assert.rejects(launcher.runAction(entry, "inspectFiles"), { code: "GAME_FILES_UNAVAILABLE" });
  assert.equal(probes, 1);
});

// A fake /Volumes directory stands in for a removable drive: renaming the
// drive's mount point away and back is what an unmount and remount look like.
function drive(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maclauncher-availability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mount = path.join(root, "Volumes", "Games Drive");
  const gamePath = path.join(mount, "Library", "Fixture Game");
  fs.mkdirSync(gamePath, { recursive: true });
  fs.writeFileSync(path.join(gamePath, "game.bin"), "game");
  const parked = path.join(root, "parked");
  return { root, mount, gamePath, userDataDir: path.join(root, "data"),
    disconnect: () => fs.renameSync(mount, parked), reconnect: () => fs.renameSync(parked, mount) };
}

test("the checked root is the original game, or its import when the game path is a launcher-owned copy", () => {
  const userDataDir = "/Users/me/Library/Application Support/maclauncher";
  assert.equal(GameAvailability.rootPath({ gamePath: "/Volumes/G/Game", importPath: "/Volumes/G/Game/Game.exe" }, { userDataDir }), "/Volumes/G/Game");
  assert.equal(GameAvailability.rootPath({ gamePath: `${userDataDir}/games/x/containers/inno/files`, importPath: "/Volumes/G/setup.exe" }, { userDataDir }),
    "/Volumes/G/setup.exe");
  assert.equal(GameAvailability.rootPath({ gamePath: `${userDataDir}/games/x/files` }, { userDataDir }), null);
  assert.equal(GameAvailability.rootPath({ gamePath: "relative", importPath: null }), null);
  assert.equal(GameAvailability.insideRoot({ gamePath: "/Volumes/G/Game" }, "/Volumes/G/Game/www/icon/icon.png"), true);
  assert.equal(GameAvailability.insideRoot({ gamePath: "/Volumes/G/Game" }, `${userDataDir}/games/x/icon.png`, { userDataDir }), false);
});

test("a disconnected drive makes the game unavailable with one stat of its root, and reconnecting it returns the game", async t => {
  const d = drive(t), entry = { gameId: "g", gamePath: d.gamePath, importPath: path.join(d.gamePath, "game.bin") };
  const seen = [], stat = file => { seen.push(file); return fs.promises.stat(file); };
  assert.deepEqual(await GameAvailability.checkGameAvailability(entry, { stat }), { available: true });
  d.disconnect();
  const missing = await GameAvailability.checkGameAvailability(entry, { stat });
  assert.deepEqual(missing, { available: false, reason: "missing", path: d.gamePath,
    message: "The game's files were not found at their saved location." });
  assert.deepEqual(seen, [d.gamePath, d.gamePath], "each check stats the root once and never reads the folder");
  assert.deepEqual(GameAvailability.checkGameAvailabilitySync(entry), missing);
  assert.equal(GameAvailability.affectsPath(missing, path.join(d.gamePath, "save")), true);
  assert.equal(GameAvailability.affectsPath(missing, path.join(d.userDataDir, "save")), false);
  await assert.rejects(GameAvailability.assertGameAvailable(entry),
    error => error.code === GameAvailability.CODE && error.message === "The game's files are unavailable. The game's files were not found at their saved location.");
  d.reconnect();
  assert.deepEqual(await GameAvailability.checkGameAvailability(entry), { available: true });
});

test("files that cannot be read are unavailable but not missing", async () => {
  const failing = code => async () => { throw Object.assign(new Error(code), { code }); };
  const denied = await GameAvailability.checkGameAvailability({ gamePath: "/Games/Locked" }, { stat: failing("EPERM") });
  assert.equal(denied.reason, "unreadable");
  assert.match(denied.message, /permission/);
  const failed = await GameAvailability.checkGameAvailability({ gamePath: "/Games/Damaged" }, { stat: failing("EIO") });
  assert.equal(failed.reason, "unreadable");
  assert.equal(failed.message, "The game's files cannot be read (EIO).");
});

test("an unresponsive location reports after the time limit and is probed once at a time", async () => {
  let calls = 0, finish, responding = false;
  const stat = () => { calls++; return responding ? Promise.resolve() : new Promise(resolve => { finish = resolve; }); };
  const entry = { gamePath: "/Volumes/Network/Game" }, options = { stat, timeoutMs: 100 };
  const results = await Promise.all([GameAvailability.checkGameAvailability(entry, options), GameAvailability.checkGameAvailability(entry, options)]);
  for (const result of results) {
    assert.equal(result.reason, "unresponsive");
    assert.equal(result.message, "The game's location is not responding.");
  }
  assert.equal(calls, 1, "a hung location holds one probe, however often it is asked");
  const started = Date.now(), third = await GameAvailability.checkGameAvailability(entry, options);
  assert.equal(third.reason, "unresponsive");
  assert.ok(Date.now() - started < 50, "a location known not to respond is reported without waiting again");
  assert.equal(calls, 1);
  responding = true; finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await GameAvailability.checkGameAvailability(entry, options), { available: true });
});

function metadataFixture(t) {
  const d = drive(t), counts = { detection: 0 };
  const info = { id: "fixture", label: "Fixture", runtime: {} };
  const mod = { id: info.id, manifest: info, resolveGameIcon: () => null,
    resolveSaveLocations: entry => ({ primaryDirectory: path.join(entry.gamePath, "save"), directories: [] }) };
  const registry = {
    listModuleIds: () => [info.id], listModules: () => [info], getModuleInfo: () => info,
    getModule: () => mod, getModuleDir: () => path.join(d.root, "module"),
    async detectGameAsync(input) {
      counts.detection++;
      // Detection of an absent folder would choose a different, generic type.
      return fs.existsSync(path.join(input, "game.bin"))
        ? { gamePath: input, contentRootDir: input, moduleId: info.id, name: "Fixture" }
        : { gamePath: input, contentRootDir: input, moduleId: "generic", name: "Unknown" };
    }
  };
  return { ...d, counts, registry, service: createGameMetadataService({ userDataDir: d.userDataDir, registry }) };
}

test("library refresh never re-detects or rewrites a game whose folder is missing", async t => {
  const f = metadataFixture(t), parked = f.gamePath + " (away)";
  const entry = { gameId: "fixture-game", gamePath: f.gamePath, importPath: f.gamePath, moduleId: "fixture",
    runtimeId: "runner", moduleData: {}, runtimeData: {}, notes: "Keep" };
  GameStore.writeGameRecord(f.userDataDir, entry);
  const first = await f.service.refreshEntry(entry, {});
  assert.equal(first.moduleId, "fixture");
  const record = JSON.stringify(GameStore.readGameRecord(f.userDataDir, entry.gameId));
  const cache = fs.readFileSync(path.join(f.userDataDir, "games", entry.gameId, "metadata.json"), "utf8");
  const detections = f.counts.detection;
  fs.renameSync(f.gamePath, parked);
  await assert.rejects(f.service.refreshEntry(first, {}), error => error.code === GameAvailability.CODE);
  await assert.rejects(f.service.refreshEntry(first, {}, { force: true }), error => error.code === GameAvailability.CODE);
  assert.equal(f.counts.detection, detections, "detection never runs on the absent path");
  assert.equal(fs.readFileSync(path.join(f.userDataDir, "games", entry.gameId, "metadata.json"), "utf8"), cache);
  assert.equal(JSON.stringify(GameStore.readGameRecord(f.userDataDir, entry.gameId)), record);
  fs.renameSync(parked, f.gamePath);
  const returned = await f.service.refreshEntry(first, {});
  assert.equal(returned.moduleId, "fixture");
  assert.equal(returned.notes, "Keep");
});

test("save tools keep saves stored elsewhere usable and refuse saves inside the missing game", async t => {
  const d = drive(t);
  const managedDir = path.join(d.userDataDir, "games", "g", "saves"), gameSaveDir = path.join(d.gamePath, "save");
  fs.mkdirSync(managedDir, { recursive: true }); fs.writeFileSync(path.join(managedDir, "slot.sav"), "managed");
  fs.mkdirSync(gameSaveDir); fs.writeFileSync(path.join(gameSaveDir, "slot.sav"), "with game");
  let resolved = 0;
  const mod = { manifest: { supports: {} }, save: { extensions: ["sav"] },
    resolveSaveLocations: () => { resolved++; return { primaryDirectory: path.join(d.root, "elsewhere"), directories: [] }; } };
  const registry = { getModule: () => mod, getModuleInfo: () => mod.manifest };
  const service = createSaveService({ userDataDir: d.userDataDir, registry });
  const managed = { gameId: "g", moduleId: "fixture", gamePath: d.gamePath, defaultSaveDir: managedDir };
  const withGame = { ...managed, defaultSaveDir: gameSaveDir };
  Snapshots.createSnapshot({ userDataDir: d.userDataDir, entry: managed, saveDir: managedDir, extensions: ["sav"] });
  d.disconnect();
  // The stored save location applies; nothing is resolved from absent files.
  assert.deepEqual(service.listFiles(managed).map(file => file.name), ["slot.sav"]);
  assert.equal(resolved, 0, "save locations are not resolved from absent game files");
  assert.equal((await service.runAction(managed, "listSaveSnapshots")).length, 1);
  assert.throws(() => service.listFiles(withGame), error => error.code === GameAvailability.CODE && /saves are unavailable/.test(error.message));
  await assert.rejects(service.runAction(withGame, "importSaveFiles", { filePaths: [path.join(managedDir, "slot.sav")] }),
    error => error.code === GameAvailability.CODE);
  assert.equal((await service.runAction(withGame, "listSaveSnapshots")).length, 1);
  assert.equal(fs.existsSync(d.mount), false, "nothing recreates the missing drive's folders");
});

test("the monitor reports changes in request order and refreshes games whose files return", async () => {
  const states = new Map([["a", { available: true }], ["b", { available: true }]]);
  const pending = [];
  let changes = 0, restored = [];
  const monitor = createAvailabilityMonitor({ listGames: () => [{ gameId: "a", gamePath: "/A" }, { gameId: "b", gamePath: "/B" }],
    check: entry => new Promise(resolve => pending.push(() => resolve(states.get(entry.gameId)))),
    onChange: () => changes++, onRestored: games => { restored = games.map(game => game.gameId); },
    focusIntervalMs: 0, logger: {} });
  const drain = async () => { while (pending.length) pending.shift()(); await new Promise(resolve => setTimeout(resolve, 5)); };
  assert.equal(monitor.known({ gameId: "a", gamePath: "/A" }), false, "reading availability never starts work");
  assert.equal(pending.length, 0);
  monitor.start();
  await new Promise(resolve => setTimeout(resolve, 5)); await drain();
  assert.equal(changes, 1, "the first results are reported once");
  assert.equal(monitor.known({ gameId: "a", gamePath: "/A" }), true);
  monitor.focus();
  await new Promise(resolve => setTimeout(resolve, 5)); await drain();
  assert.equal(changes, 1, "unchanged games need no state change");
  const lost = { available: false, reason: "missing", path: "/A", message: "The game's files were not found at their saved location." };
  states.set("a", lost);
  // The drive was removed while the launcher was in the background.
  monitor.focus();
  await new Promise(resolve => setTimeout(resolve, 5)); await drain();
  assert.equal(changes, 2);
  assert.equal(monitor.get({ gameId: "a" }), lost);
  assert.equal(monitor.get({ gameId: "b" }), null);
  // The drive returns: a newer check finishes first and a slow, older one later.
  const stale = monitor.refresh({ gameId: "a", gamePath: "/A" }), fresh = monitor.refresh({ gameId: "a", gamePath: "/A" });
  await new Promise(resolve => setImmediate(resolve));
  states.set("a", { available: true });
  pending.splice(1, 1)[0]();
  await fresh;
  assert.equal(monitor.get({ gameId: "a" }), null);
  assert.deepEqual(restored, ["a"], "returning files trigger a metadata refresh for that game");
  states.set("a", lost);
  pending.shift()();
  await stale;
  assert.equal(monitor.get({ gameId: "a" }), null, "an older check never overwrites a newer one");
  const moved = { gameId: "a", gamePath: "/Moved" }, beforeMove = changes;
  assert.equal(monitor.known(moved), false, "a different root needs its own first result");
  const movedCheck = monitor.ensure(moved);
  assert.equal(monitor.ensure(moved), movedCheck, "the first check is shared");
  await new Promise(resolve => setImmediate(resolve));
  states.set("a", { available: true });
  await drain(); await movedCheck;
  assert.equal(changes, beforeMove + 1, "the first result for a changed root releases waiting icons");
  assert.equal(monitor.known(moved), true);
  monitor.close();
});

test("library state hands an unavailable game's result to module hooks and reads nothing inside its root", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const normalizeSource = source.slice(source.indexOf("function normalizeGameEntry("), source.indexOf("\nfunction buildModuleLaunchContext("));
  const lost = { available: false, reason: "missing", path: "/Volumes/G/Game", message: "The game's files were not found at their saved location." };
  const info = { id: "engine", supports: {}, runtime: { default: "runner", supported: ["runner"], entries: { runner: {} } } }, hooks = [], iconReads = [];
  const mod = { filterRuntimeSupport: (entry, supported) => { hooks.push(entry.availability); return supported; },
    canLaunchRuntime: (_runtimeId, entry) => { hooks.push(entry.availability); return true; } };
  const vm = require("node:vm");
  const context = { path, GameAvailability, StoredPlan: require("../src/modules/shared/effects/stored-plan"),
    NetworkAccess: require("../src/core/network-access"), SteamClientStart: { clientEligible: () => false, startPreference: value => value },
    entryModuleLabels: require("../src/core/entry-labels").entryModuleLabels,
    isManagedSaveDirectory: require("../src/core/save-locations").isManagedSaveDirectory,
    isChildGame: false, gameRecordsCache: null, logger: { warn() {} }, GameStore: {}, GAME_SCHEMA_VERSION: 1, app: {},
    userDataDir: "/state", runtimeStateSnapshots: {}, resolveModuleId: () => info.id,
    Modules: { getModule: () => mod, getModuleInfo: () => info }, mergeRuntimeSettingsMap: (_, value) => value,
    gameAvailability: { get: entry => entry.gamePath === lost.path ? lost : null, known: () => true },
    // The launcher's shared checks run the module's hooks.
    launcherService: require("../src/core/launcher").createLauncher({ userDataDir: "/state", logger: { debug() {}, info() {}, warn() {}, error() {} },
      registry: { getModule: () => mod, getModuleInfo: () => info, listModuleIds: () => [info.id], listModules: () => [info] } }),
    getModuleCheats: () => null, resolveImportPath: entry => entry.gamePath, resolveModuleDefaultIconPath: () => null,
    canRenderIconPath: () => true,
    normalizeIconPath: file => { iconReads.push(file); return file; }, ICON_SOURCES: { MODULE_DEFAULT: "module-default" } };
  vm.createContext(context); vm.runInContext(normalizeSource, context);
  const away = context.normalizeGameEntry({ gamePath: lost.path, iconPath: `${lost.path}/icon.png`, networkAccess: false }, {});
  assert.ok(hooks.length >= 2);
  assert.ok(hooks.every(value => value === lost), "every module hook sees the cached result");
  assert.deepEqual(iconReads, [], "an icon inside the missing root is not read");
  assert.equal(away.availability, undefined, "the result is not stored with the game");
  hooks.length = 0;
  context.normalizeGameEntry({ gamePath: "/Games/Local", iconPath: "/Games/Local/icon.png", networkAccess: false }, {});
  assert.ok(hooks.length >= 2 && hooks.every(value => value === undefined));
  assert.deepEqual(iconReads, ["/Games/Local/icon.png"]);
  iconReads.length = 0;
  context.gameAvailability.known = () => false;
  const waiting = context.normalizeGameEntry({ gamePath: "/Games/Local", iconPath: "/Games/Local/icon.png", networkAccess: false }, {});
  assert.equal(waiting.iconPath, null);
  assert.deepEqual(iconReads, [], "unchecked game icons are not read even outside library decoration");
  context.normalizeGameEntry({ gamePath: "/Games/Local", iconPath: "/state/games/g/icon.png", networkAccess: false }, {});
  assert.deepEqual(iconReads, ["/state/games/g/icon.png"], "launcher-owned icons need no game check");
});

test("Play, tools and saves explain missing files while settings work, and Play resumes when the files return", async t => {
  const { EventEmitter } = require("node:events");
  const { createBackendOperations } = require("../src/core/backend-operations");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maclauncher-unavailable-backend-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "Games", "Fixture"), parked = path.join(root, "parked"), userDataDir = path.join(root, "data");
  fs.mkdirSync(gamePath, { recursive: true });
  const info = { id: "fixture", label: "Fixture", gameType: "native",
    runtime: { default: "runner", supported: ["runner"], entries: { runner: {} } }, supports: {} };
  const calls = { launch: 0, inspect: 0, saveLocations: 0, detect: 0 };
  const mod = { id: info.id, manifest: info,
    actions: { inspect: () => { calls.inspect++; return { ok: true }; } },
    resolveSaveLocations: entry => { calls.saveLocations++; return { primaryDirectory: path.join(entry.gamePath, "save"), directories: [] }; },
    launchRuntime: async () => { calls.launch++; return Object.assign(new EventEmitter(), { pid: 4242, exitCode: 0, signalCode: null }); } };
  const registry = { listModuleIds: () => [info.id], listModules: () => [info],
    getModule: () => mod, getModuleInfo: () => info, getModuleDir: () => root,
    listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null,
    detectGameAsync: async () => { calls.detect++; return { moduleId: info.id, gamePath, contentRootDir: gamePath, name: "Fixture" }; } };
  const operations = createBackendOperations({ userDataDir, registry });
  t.after(() => operations.beginShutdown());
  const entry = await operations.importEntry(gamePath, {});
  assert.equal(entry.defaultSaveDir, path.join(gamePath, "save"));
  GameStore.writeGameRecord(userDataDir, { ...entry, notes: "" });
  const stored = () => GameStore.readGameRecord(userDataDir, entry.gameId);
  const before = JSON.stringify(stored()), detections = calls.detect;
  fs.renameSync(gamePath, parked);
  const unavailable = error => error.code === GameAvailability.CODE &&
    error.message === "The game's files are unavailable. The game's files were not found at their saved location.";
  await assert.rejects(operations.launchEntry(entry, { settings: {} }), unavailable);
  await assert.rejects(operations.moduleAction(entry, "inspect", {}, {}), unavailable);
  await assert.rejects(operations.moduleAction(entry, "explainDetection", {}, {}), unavailable);
  const graphics = await operations.moduleAction(entry, "graphicsInputs", {}, {});
  assert.deepEqual(graphics, { runtimeId: "runner", graphicsInputs: null, filesUnavailable: true }, "effect settings stay editable");
  assert.equal(JSON.stringify(await operations.refreshSaveLocations(entry, {})), before);
  await assert.rejects(operations.saveInfo(entry, {}), error => error.code === GameAvailability.CODE && /saves are unavailable/.test(error.message));
  await assert.rejects(operations.selectSaveLocation(entry, path.join(gamePath, "save"), {}), unavailable);
  assert.deepEqual(await operations.moduleAction(entry, "listSaveSnapshots", {}, {}), []);
  assert.deepEqual([calls.launch, calls.inspect, calls.detect - detections], [0, 0, 0]);
  assert.equal(fs.existsSync(gamePath), false, "no save folder recreates the missing game folder");
  assert.equal(JSON.stringify(stored()), before, "the library record is unchanged");
  await operations.moduleAction(entry, "setGameNotes", { notes: "Kept on the drive" }, {});
  assert.equal(stored().notes, "Kept on the drive");
  fs.renameSync(parked, gamePath);
  const result = await operations.launchEntry(entry, { settings: {} });
  assert.equal(result.kind, "process");
  assert.equal(calls.launch, 1);
  assert.equal(stored().moduleId, "fixture");
  assert.equal(stored().notes, "Kept on the drive");
});
