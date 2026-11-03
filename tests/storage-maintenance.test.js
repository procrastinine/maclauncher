const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { maintainStorage } = require("../src/core/storage-maintenance");
const graphicsStores = require("../src/modules/shared/reshade/derived-stores");
const mkxpzStores = require("../src/modules/rgss/derived-stores");
const coreStores = require("../src/core/derived-stores");

const DAY = 24 * 60 * 60 * 1000, NOW = Date.now(), OLD = (NOW - 2 * DAY) / 1000;
function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, contents = "", age = OLD) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  if (age !== null) fs.utimesSync(file, age, age);
  return file;
}
function folder(directory, age = OLD) { fs.mkdirSync(directory, { recursive: true }); fs.utimesSync(directory, age, age); return directory; }
const exists = file => { try { fs.lstatSync(file); return true; } catch { return false; } };
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const pass = options => maintainStorage({ now: NOW, ...options });

test("upkeep applies declared retention and leaves undeclared entries, links and recent work", async t => {
  const root = profile(t), store = path.join(root, "store"), outside = profile(t);
  for (let index = 1; index <= 5; index++) write(path.join(store, `item-${index}.log`), "x", OLD + index);
  write(path.join(store, "item-keep.log"));
  write(path.join(store, "item-recent.log"), "x", null);
  write(path.join(store, "settings.json"), "{}");
  write(path.join(outside, "original.log"), "keep");
  fs.symlinkSync(path.join(outside, "original.log"), path.join(store, "item-link.log"));
  const declared = { id: "logs", directories: () => [store], match: /^item-[\w-]+\.log$/, newest: 2,
    keep: () => name => name === "item-keep.log" };
  const result = await maintainStorage({ userDataDir: root, stores: [declared], now: NOW });
  assert.equal(result.removed, 3);
  assert.deepEqual(fs.readdirSync(store).sort(),
    ["item-4.log", "item-5.log", "item-keep.log", "item-link.log", "item-recent.log", "settings.json"]);
  assert.equal(fs.readFileSync(path.join(outside, "original.log"), "utf8"), "keep");
});

test("upkeep never runs while a game runs and confines failures to their store", async t => {
  const root = profile(t), outside = profile(t), store = path.join(root, "store");
  write(path.join(store, "item-1.log"));
  write(path.join(outside, "item-1.log"));
  const declared = { id: "logs", directories: () => [store], match: /^item-\d+\.log$/ };
  assert.equal((await pass({ userDataDir: root, stores: [declared], running: { game: [] }, now: NOW })).skipped, "running");
  assert.ok(exists(path.join(store, "item-1.log")));
  const warnings = [];
  const result = await pass({ userDataDir: root, now: NOW, logger: { warn: message => warnings.push(message) }, stores: [
    { id: "escape", directories: () => [outside], match: /^item-\d+\.log$/ },
    { id: "broken", directories: () => { throw new Error("unreadable"); }, match: /^item-\d+\.log$/ },
    declared
  ] });
  assert.deepEqual(result.errors.map(error => error.id).sort(), ["broken", "escape"]);
  assert.equal(warnings.length, 2, "each failing store is logged once");
  assert.ok(exists(path.join(outside, "item-1.log")), "folders outside the launcher data are never pruned");
  assert.ok(!exists(path.join(store, "item-1.log")));
});

test("graphics upkeep keeps the current launch and user data and removes earlier launches' files", async t => {
  const root = profile(t), gameId = "a02609b6599bef9e50365975644d40d2";
  const game = path.join(root, "games", gameId), effects = path.join(game, "effects", "reshade");
  const current = "ad603807-ba7a-4eb9-9422-06e32723e5d1", earlier = "5fc3a709-9945-4539-aef6-680dc72bdf80";
  const recent = "11111111-2222-4333-8444-555555555555", live = "99999999-2222-4333-8444-555555555555";
  write(path.join(game, "game.json"), "{}");
  write(path.join(game, "save-snapshots", "snapshot.json"), "{}");
  write(path.join(effects, "launch.json"), JSON.stringify({ schema: 1, launchId: current, phase: "spawned", pid: 1 }));
  for (const name of ["effect-plan.json", "controls.bin", "window-state", "reshade.log", `diagnostics-${earlier}.7.jsonl`])
    write(path.join(effects, name));
  for (const id of [current, earlier]) {
    write(path.join(effects, `runtime-status-${id}.bin`));
    write(path.join(effects, `source-control-${id}.json`));
    write(path.join(effects, `source-status-${id}-virtual.json`));
    write(path.join(effects, `presentation-control-${id}.json`));
    write(path.join(effects, `browser-source-${id}.state`));
  }
  write(path.join(effects, `runtime-status-${recent}.bin`), "", null);
  const bindings = path.join(root, "graphics", "payload-bindings"), snapshots = path.join(bindings, "snapshots");
  const record = (id, pid, snapshot) => write(path.join(bindings, sha(id) + ".json"), JSON.stringify({ schema: 1, launchId: id, phase: "spawned", pid, snapshot: sha(snapshot) }));
  record(current, 999999, "a"); record(earlier, 999998, "b"); record(live, process.pid, "c");
  for (const snapshot of ["a", "b", "c"]) write(path.join(snapshots, sha(snapshot) + ".json"), "{}");
  const sessions = path.join(root, "graphics", "compute-sessions");
  for (const id of [current, earlier]) { write(path.join(sessions, sha(id), "requests", "r.json")); folder(path.join(sessions, sha(id))); }
  const models = path.join(root, "runtimes", "graphics-neural-models");
  write(path.join(models, ".source-archives", sha("archive") + ".zip"));
  write(path.join(models, "sha256-" + sha("model"), "model.restorationmodel"));
  write(path.join(root, "settings.json"), "{}");

  const result = await pass({ userDataDir: root, stores: graphicsStores, now: NOW });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(fs.readdirSync(effects).sort(), [
    `browser-source-${current}.state`, "controls.bin", `diagnostics-${earlier}.7.jsonl`, "effect-plan.json", "launch.json",
    `presentation-control-${current}.json`, "reshade.log", `runtime-status-${current}.bin`, `runtime-status-${recent}.bin`,
    `source-control-${current}.json`, `source-status-${current}-virtual.json`, "window-state"
  ].sort());
  assert.deepEqual(fs.readdirSync(bindings).filter(name => name.endsWith(".json")).sort(), [sha(current) + ".json", sha(live) + ".json"].sort());
  assert.deepEqual(fs.readdirSync(snapshots).sort(), [sha("a") + ".json", sha("c") + ".json"].sort());
  assert.deepEqual(fs.readdirSync(sessions), [sha(current)]);
  assert.deepEqual(fs.readdirSync(path.join(models, ".source-archives")), []);
  assert.ok(exists(path.join(models, "sha256-" + sha("model"), "model.restorationmodel")), "installed models stay");
  for (const file of [path.join(game, "game.json"), path.join(game, "save-snapshots", "snapshot.json"), path.join(root, "settings.json")])
    assert.ok(exists(file), file);
});

test("MKXP-Z upkeep keeps the newest sessions of each version and every other per-game file", async t => {
  const root = profile(t), runtime = path.join(root, "games", "game1", "runtimes", "mkxpz");
  const sessions = path.join(runtime, "MCLv1-1003", "sessions");
  const ids = Array.from({ length: 5 }, (_, index) => `0000000${index}-0000-4000-8000-000000000000`);
  ids.forEach((id, index) => { write(path.join(sessions, id, "rgss-mkxpz.log")); folder(path.join(sessions, id), OLD + index); });
  write(path.join(runtime, "MCLv1-1003", "applications", "identity", "app.json"));
  write(path.join(root, "games", "game1", "modules", "rgss", "saves", "Save01.rvdata2"), "save");
  await pass({ userDataDir: root, stores: mkxpzStores, now: NOW });
  assert.deepEqual(fs.readdirSync(sessions).sort(), ids.slice(3).sort());
  assert.ok(exists(path.join(runtime, "MCLv1-1003", "applications", "identity", "app.json")));
  assert.equal(fs.readFileSync(path.join(root, "games", "game1", "modules", "rgss", "saves", "Save01.rvdata2"), "utf8"), "save");
});

test("download helper upkeep keeps the helpers downloads use and unrecognized folders", async t => {
  const root = profile(t), tools = path.join(root, "external", "tools");
  const legendary = (version, confirmsBuilds) => {
    const directory = path.join(tools, `legendary-${version}-${sha(version).slice(0, 12)}`);
    write(path.join(directory, "legendary", "cli.py"));
    write(path.join(directory, ".maclauncher-tools.json"), JSON.stringify({ legendaryVersion: version, confirmsBuilds }));
    return folder(directory);
  };
  const gogdl = version => {
    const bytes = Buffer.from("gogdl " + version), sum = crypto.createHash("sha256").update(bytes).digest("hex");
    const directory = path.join(tools, `gogdl-${version}-arm64-${sum.slice(0, 12)}`);
    write(path.join(directory, "gogdl"), bytes); fs.chmodSync(path.join(directory, "gogdl"), 0o755);
    write(path.join(directory, "source.json"), JSON.stringify({ version, sha256: sum, size: bytes.length }));
    return folder(directory);
  };
  const kept = [legendary("0.21.1", false), legendary("0.20.0", true), gogdl("1.4.0")];
  const removed = [legendary("0.19.0", true), gogdl("1.3.0")];
  const partial = folder(path.join(tools, "legendary-0.18.0-incomplete"));
  await pass({ userDataDir: root, stores: coreStores, now: NOW });
  for (const directory of [...kept, partial]) assert.ok(exists(directory), directory);
  for (const directory of removed) assert.ok(!exists(directory), directory);
});

test("the registry lists every declared derived store with its owner", () => {
  const stores = require("../src/modules/registry").listDerivedStores();
  const owners = Object.fromEntries(stores.map(store => [store.id, store.owner]));
  assert.equal(owners["graphics-launch-files"], "shared/reshade");
  assert.equal(owners["mkxpz-sessions"], "rgss");
  assert.ok(require("../src/core/storage-maintenance").listStores().some(store => store.id === "external-download-helpers"));
});

test("a pass writes nothing of its own and a repeated pass finds nothing left", async t => {
  const root = profile(t), store = path.join(root, "store");
  const declared = { id: "logs", directories: () => [store], match: /^item-\d+\.log$/ };
  write(path.join(store, "item-1.log"));
  assert.equal((await pass({ userDataDir: root, stores: [declared], now: NOW })).removed, 1);
  assert.equal((await pass({ userDataDir: root, stores: [declared], now: NOW + 60 * 1000 })).removed, 0);
  assert.deepEqual(fs.readdirSync(root), ["store"]);
});

test("a game whose files are missing keeps all of its derived data", async t => {
  const root = profile(t), gameId = "c021f26fa691f5dd9586b779dfeb1322", game = path.join(root, "games", gameId);
  const missing = path.join(root, "ejected-drive", "Game");
  write(path.join(game, "game.json"), JSON.stringify({ gameId, gamePath: missing, importPath: missing }));
  const launch = "ad603807-ba7a-4eb9-9422-06e32723e5d1";
  const kept = [
    write(path.join(game, "effects", "reshade", "launch.json"), JSON.stringify({ schema: 1, launchId: launch })),
    write(path.join(game, "effects", "reshade", `runtime-status-${launch}.bin`)),
    write(path.join(game, "modules", "renpy", "extracted", "script.rpy")),
    write(path.join(game, "modules", "fna", "overlays", "26.10.converted.arm64-il", "Game.exe")),
    write(path.join(game, "modules", "fna", "previous-overlays", `26.10-${NOW - 60 * 1000}`, "Game.exe")),
    write(path.join(game, "runtimes", "crossover", "graphics-loader", "0123456789abcdef01234567", "loader.json")),
    write(path.join(game, "runtimes", "mkxpz", "MCLv1-1003", "sessions", "00000000-0000-4000-8000-000000000000", "rgss-mkxpz.log")),
    write(path.join(game, "save-snapshots", "snapshot.json"))
  ];
  const stores = require("../src/core/storage-maintenance").listStores();
  const result = await pass({ userDataDir: root, stores, now: NOW });
  assert.deepEqual(result.errors, []);
  assert.equal(result.removed, 0);
  for (const file of kept) assert.ok(exists(file), file);
});

test("legacy FNA game views stay while superseded CrossOver graphics loaders retire", async t => {
  const root = profile(t), game = path.join(root, "games", "game1");
  const retired = path.join(game, "modules", "fna", "previous-overlays");
  const CARRIED_FORWARD = ".maclauncher-fna-carried-forward.json";
  const carried = directory => (write(path.join(directory, CARRIED_FORWARD),
    JSON.stringify({schemaVersion: 2, carriedForward: true, outputFingerprint: sha("")})), folder(directory));
  const old = carried(folder(path.join(retired, `26.10-${NOW - 2 * DAY}`)));
  const unmarked = folder(path.join(retired, `26.09-${NOW - 3 * DAY}`));
  const legacy = folder(path.join(retired, `26.08-${NOW - 4 * DAY}`));
  write(path.join(legacy, CARRIED_FORWARD), JSON.stringify({schemaVersion: 1, carriedForward: true}));folder(legacy);
  const recent = carried(folder(path.join(retired, `26.11-${NOW - 60 * 1000}`)));
  const current = write(path.join(game, "modules", "fna", "overlays", "26.11.converted.arm64-il", "Game.exe"));
  const loaders = path.join(root, "graphics", "compute-hosts", "host1", "graphics-loader");
  const names = ["a", "b", "c", "d"].map(letter => letter.repeat(24));
  names.forEach((name, index) => { write(path.join(loaders, name, "loader.json")); folder(path.join(loaders, name), OLD - (4 - index) * 3600); });
  const stores = [...require("../src/modules/fna/derived-stores"), ...require("../src/modules/crossover/derived-stores")];
  await pass({ userDataDir: root, stores, now: NOW });
  assert.ok(exists(old), "restoring original Play paths does not authorize deleting earlier private game data");
  assert.ok(exists(unmarked), "an overlay without a completed carry-forward stays");
  assert.ok(exists(legacy), "a legacy marker without output change evidence stays");
  assert.ok(exists(recent)); assert.ok(exists(current));
  assert.deepEqual(fs.readdirSync(loaders).sort(), names.slice(2));
});

test("a new launch removes its game's earlier channels and keeps a still-running launch's", t => {
  const { pruneEarlierLaunches } = require("../src/modules/shared/reshade/launch-files");
  const directory = path.join(profile(t), "games", "game1", "effects", "reshade");
  const running = "11111111-2222-4333-8444-555555555555", ended = "99999999-2222-4333-8444-555555555555";
  const kept = [write(path.join(directory, "reshade.log"), "", null), write(path.join(directory, "settings.json"), "{}", null)];
  const runningFiles = [`runtime-status-${running}.bin`, `source-control-${running}-virtual.json`].map(name => write(path.join(directory, name), "", null));
  const endedFiles = [`runtime-status-${ended}.bin`, `presentation-status-${ended}.json`].map(name => write(path.join(directory, name), "", null));
  write(path.join(directory, "launch.json"), JSON.stringify({ schema: 1, launchId: running, pid: 4242, phase: "spawned" }), null);
  pruneEarlierLaunches(directory, { isProcessAlive: pid => pid === 4242 });
  for (const file of [...kept, ...runningFiles]) assert.ok(exists(file), file);
  for (const file of endedFiles) assert.ok(!exists(file), file);
  pruneEarlierLaunches(directory, { isProcessAlive: () => false });
  for (const file of runningFiles) assert.ok(!exists(file), file);
  for (const file of kept) assert.ok(exists(file), file);
});

test("GPU compute hosts stay while Runtimes knows their CrossOver location or Sikarugir version", async t => {
  const CrossOver = require("../src/modules/crossover/runtime/manager"), Sikarugir = require("../src/modules/crossover/sikarugir/runtime/manager");
  const root = profile(t), hosts = path.join(root, "graphics", "compute-hosts");
  const name = (version, backend) => sha(JSON.stringify([1, version, backend])).slice(0, 24);
  const host = (version, backend) => {
    const directory = path.join(hosts, name(version, backend));
    write(path.join(directory, "bottle", "system.reg"));
    return folder(directory);
  };
  // An added application on a disconnected drive and an absent standard location keep their hosts;
  // a standard location removed from Runtimes does not.
  const missingApp = path.join(root, "Volumes", "Drive", "CrossOver.app"), [standard, removedStandard] = [CrossOver.__test.AUTOMATIC_PATHS[1], CrossOver.__test.AUTOMATIC_PATHS[0]];
  CrossOver.__test.writeRegistry(root, { applications: [{ appPath: missingApp }], ignoredPaths: [removedStandard] });
  const crossover = [missingApp, standard].map(appPath => host(CrossOver.core.identity(appPath), "d3d12"));
  const removedCrossover = host(CrossOver.core.identity(removedStandard), "d3d12");
  const vulkan = host("10.0_8", "vulkan"), removed = host("9.0_1", "d3d12");
  const recent = path.join(hosts, name("9.0_2", "d3d12")), other = folder(path.join(hosts, "notes"));
  fs.mkdirSync(recent);
  let listed = true;
  const installed = folder(path.join(root, "runtimes", "sikarugir", "10.0_8"));
  t.mock.method(Sikarugir.core, "listCatalog", () => { if (!listed) throw new Error("unreadable"); return []; });
  t.mock.getter(Sikarugir.core, "catalog", () => [{ version: "10.0_8" }, { version: "9.0_1" }]);
  t.mock.method(Sikarugir.core, "getInstallDir", ({ version }) => path.join(root, "runtimes", "sikarugir", version));
  const stores = require("../src/modules/crossover/derived-stores");
  listed = false;
  assert.equal((await pass({ userDataDir: root, stores, now: NOW })).removed, 0, "an unreadable listing keeps every host");
  listed = true;
  const result = await pass({ userDataDir: root, stores, now: NOW });
  assert.deepEqual(result.stores.map(store => [store.id, store.removed]), [["graphics-compute-hosts", 2]]);
  assert.ok(!exists(removed) && !exists(removedCrossover));
  for (const directory of [...crossover, vulkan, recent, other, installed]) assert.ok(exists(directory), directory);
});

// Robustness of the shared removal path.
const store = (directory, extra = {}) => ({ id: "items", directories: () => [directory], match: /^item-\d+$/, ...extra });
const trashIn = directory => fs.readdirSync(directory).filter(name => name.startsWith(".maclauncher-trash-"));
function sealedTree(directory) {
  write(path.join(directory, "translated", "a".repeat(64) + "-v1", "elf"), "x");
  write(path.join(directory, "translated", "a".repeat(64) + "-v1", "meta"), "y");
  for (const folder of [path.join(directory, "translated", "a".repeat(64) + "-v1"), path.join(directory, "translated"), directory]) fs.chmodSync(folder, 0o555);
  fs.utimesSync(directory, OLD, OLD);
  return directory;
}
const unsealAll = directory => { try { for (const file of [directory, ...fs.readdirSync(directory, { recursive: true }).map(name => path.join(directory, name))]) if (fs.lstatSync(file).isDirectory()) fs.chmodSync(file, 0o755); } catch {} };

test("a read-only tree is renamed to trash and removed completely, and declarations need an exact pattern", async t => {
  const root = profile(t), directory = path.join(root, "store");
  t.after(() => unsealAll(directory));
  sealedTree(path.join(directory, "item-1"));
  const other = write(path.join(directory, "item-1-notes"));
  const result = await pass({ userDataDir: root, stores: [store(directory), { id: "loose", directories: () => [directory], match: /^item-/ }] });
  assert.equal(result.removed, 1);
  assert.ok(result.bytes > 0);
  assert.deepEqual(fs.readdirSync(directory), ["item-1-notes"], "nothing partial or hidden remains");
  assert.ok(exists(other), "an unanchored pattern removes nothing");
  assert.deepEqual(result.errors.map(error => error.id), ["loose"]);
});

test("a pass that stopped partway is finished first by the next pass", async t => {
  const root = profile(t), directory = path.join(root, "store");
  t.after(() => unsealAll(directory));
  // A rename completed and deletion stopped halfway: a sealed tree under a trash name.
  const trash = sealedTree(path.join(directory, ".maclauncher-trash-" + crypto.randomUUID()));
  for (let index = 1; index <= 3; index++) write(path.join(directory, `item-${index}`));
  // The launcher becomes busy as soon as the trash is gone.
  const first = await pass({ userDataDir: root, stores: [store(directory)], busy: async () => !exists(trash) });
  assert.ok(!exists(trash), "leftover trash goes first");
  assert.equal(first.interrupted, true);
  assert.equal(fs.readdirSync(directory).filter(name => name.startsWith("item-")).length, 3, "new removals wait for the next pass");
  const second = await pass({ userDataDir: root, stores: [store(directory)] });
  assert.equal(second.removed, 3);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("permission errors and missing folders keep entries without failing", async t => {
  const root = profile(t), locked = path.join(root, "locked"), open = path.join(root, "open"), warnings = [];
  for (const name of ["item-1", "item-2"]) write(path.join(locked, name));
  fs.chmodSync(locked, 0o555);
  const idle = write(path.join(open, "item-2"));
  const result = await pass({ userDataDir: root, logger: { warn: message => warnings.push(message) }, stores: [
    store(locked, { id: "locked" }), store(open, { id: "open" }), store(path.join(root, "missing"), { id: "missing" })] });
  fs.chmodSync(locked, 0o755);
  assert.deepEqual(fs.readdirSync(locked).sort(), ["item-1", "item-2"]);
  assert.deepEqual(result.errors.map(error => [error.id, error.count]), [["locked", 2]]);
  assert.equal(warnings.length, 1, "a store's errors are logged once");
  assert.ok(!exists(idle), "other stores continue");
});

test("entries on another volume stay, and deletion never enters another volume", async t => {
  const root = profile(t), directory = path.join(root, "store");
  const foreignEntry = write(path.join(directory, "item-1", "file"));
  const nested = write(path.join(directory, "item-3", "volume", "file"));
  for (const name of ["item-1", "item-3"]) fs.utimesSync(path.join(directory, name), OLD, OLD);
  // item-1 reports another device; item-3/volume is a mounted volume inside a tree already in trash.
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    const stat = lstat(file, ...args);
    if (file !== path.join(directory, "item-1") && !(path.basename(file) === "volume" && path.basename(path.dirname(file)).startsWith(".maclauncher-trash-"))) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1 });
  });
  const warnings = [];
  const result = await pass({ userDataDir: root, stores: [store(directory)], logger: { warn: message => warnings.push(message) } });
  assert.ok(exists(foreignEntry), "an entry on another volume stays");
  const [trash] = trashIn(directory);
  assert.ok(trash && exists(path.join(directory, trash, "volume", "file")), "deletion stops at another volume and leaves the trash");
  assert.equal(result.errors[0].id, "items");
  assert.match(warnings.join("\n"), /another volume/);
  t.mock.restoreAll();
  await pass({ userDataDir: root, stores: [store(directory)] });
  assert.deepEqual(trashIn(directory), [], "the next pass finishes the trash once the volume is gone");
  assert.ok(!exists(nested));
});

test("the launcher is asked before every removal, and a preparation that starts mid-pass stops it", async t => {
  const root = profile(t), directory = path.join(root, "store"), info = [];
  for (let index = 1; index <= 6; index++) write(path.join(directory, `item-${index}`));
  // A preparation starts once two entries are gone.
  let preparing = false;
  const left = () => fs.readdirSync(directory).filter(name => name.startsWith("item-")).length;
  const result = await pass({ userDataDir: root, stores: [store(directory)], logger: { info: message => info.push(message) },
    busy: async () => (preparing ||= left() <= 4) });
  assert.equal(result.removed, 2, "removals stop as soon as a preparation is reported");
  assert.equal(result.interrupted, true);
  assert.match(info.join("\n"), /launcher became busy/);
  const unanswered = await pass({ userDataDir: root, stores: [store(directory)], busy: async () => { throw new Error("no reply"); } });
  assert.equal(unanswered.removed, 0, "a launcher that cannot answer counts as busy");
});

test("staging folders left by an interrupted launch or download are removed after a day", async t => {
  const root = profile(t), game = path.join(root, "games", "game1");
  const staged = [
    path.join(root, "modules", "rgss", "assets", "generations", ".prepare-Ab12Cd"),
    path.join(game, "modules", "hashlink", ".stage-Q1w2E3"),
    path.join(game, "modules", "gemrb", ".game-Z9y8X7"),
    path.join(game, "runtimes", "crossover", "graphics-loader", "prepare-a1B2c3"),
    path.join(root, "runtimes", "graphics-neural-models", ".download-k4L5m6")
  ];
  const kept = [
    path.join(game, "modules", "hashlink", "game"),
    path.join(game, "modules", "gemrb", ".game-saved-notes"),
    path.join(root, "runtimes", "graphics-neural-models", "x4"),
    path.join(root, "modules", "rgss", "assets", "generations", ".prepare-Fresh1")
  ];
  for (const directory of [...staged, ...kept]) { write(path.join(directory, "file")); folder(directory); }
  folder(kept.at(-1), NOW / 1000);
  const stores = ["rgss", "hashlink", "gemrb", "crossover", "shared/reshade"].flatMap(owner => require(`../src/modules/${owner}/derived-stores`));
  const result = await pass({ userDataDir: root, stores });
  assert.deepEqual(result.errors, []);
  for (const directory of staged) assert.ok(!exists(directory), directory);
  for (const directory of kept) assert.ok(exists(directory), directory);
});
