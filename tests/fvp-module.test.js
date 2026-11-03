const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Inspect = require("../src/modules/fvp/inspect");
const { detectGame } = require("../src/modules/fvp/detect");
const Prepare = require("../src/modules/fvp/prepare");
const Host = require("../src/modules/fvp/host");
function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-fvp-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function script(title = "Example FVP", names = ["GraphLoad", "TextPrint", "ThreadWait"]) {
  const titleBytes = Buffer.from(title + "\0"), table = Buffer.concat(names.map(name => Buffer.concat([Buffer.from([2, name.length + 1]), Buffer.from(name + "\0")])));
  const data = Buffer.alloc(40 + 11 + titleBytes.length + 2 + table.length + 2);
  data.writeUInt32LE(40, 0); data[4] = 1; data.writeUInt32LE(4, 40); data[48] = 7; data[50] = titleBytes.length; titleBytes.copy(data, 51);
  data.writeUInt16LE(names.length, 51 + titleBytes.length); table.copy(data, 53 + titleBytes.length); return data;
}
function archive(payload = Buffer.from("asset")) {
  const name = Buffer.from("title_bg\0"), head = Buffer.alloc(20); head.writeUInt32LE(1); head.writeUInt32LE(name.length, 4);
  head.writeUInt32LE(head.length + name.length, 12); head.writeUInt32LE(payload.length, 16); return Buffer.concat([head, name, payload]);
}
function fixture(root) { fs.writeFileSync(path.join(root, "game.hcb"), script()); fs.writeFileSync(path.join(root, "graph.bin"), archive()); return path.join(root, "game.hcb"); }
function snapshots(root) { return fs.readdirSync(root).sort().map(name => { const file = path.join(root, name); return fs.statSync(file).isDirectory() ? [name, snapshots(file)] : [name, fs.readFileSync(file).toString("hex")]; }); }
function macho(file, library = false) { const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4); bytes.writeUInt32LE(library ? 6 : 2, 12); fs.writeFileSync(file, bytes, { mode: 0o755 }); return file; }

test("FVP detection uses a bounded HCB descriptor and BIN index without reading game payloads", t => {
  const root = directory(t), input = fixture(root); let readBytes = 0;
  const detection = { readdir: file => fs.readdirSync(file, { withFileTypes: true }), stat: file => fs.lstatSync(file),
    readBytes: (file, offset, count) => { readBytes += count; return Inspect.readAt(file, offset, count); } };
  const entry = detectGame({ rootDir: root, inputPath: input, detection });
  assert.equal(entry.moduleId, "fvp"); assert.equal(entry.runtimeId, "rfvp"); assert.equal(entry.name, "Example FVP");
  assert.equal(entry.moduleData.syscallCount, 3); assert.equal(entry.moduleData.resolution, "1024 × 640"); assert.equal(entry.moduleData.archiveCount, 1);
  assert.equal(entry.gamePath, root); assert.ok(readBytes < 256);
  assert.equal(detectGame({ rootDir: root, isAppBundle: true }), null);
});

test("FVP rejects unrelated HCB suffixes, invalid offsets, unknown syscalls and malformed BIN indexes", t => {
  const root = directory(t), input = fixture(root);
  for (const bytes of [Buffer.alloc(100), script("Other", ["Alpha", "Beta"]), (() => { const b = script(); b.writeUInt32LE(0xffffffff); return b; })(), (() => { const b = script(); b.writeUInt32LE(40, 40); return b; })()]) {
    fs.writeFileSync(input, bytes); assert.equal(Inspect.inspectScript(input), null);
  }
  fs.writeFileSync(input, script()); const bin = path.join(root, "graph.bin"), bad = archive(); bad.writeUInt32LE(0xffffffff, 12); fs.writeFileSync(bin, bad);
  assert.equal(Inspect.inspectArchive(bin), null);
  assert.equal(Inspect.inspectGame(root).archiveCount, 0); // Valid loose HCB still identifies the engine.
});

test("FVP warm metadata preserves explicit translations through the required script adapter", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  const context = { userDataDir: path.join(root, "library") }, folder = { gameId: "folder", gamePath: original };
  Prepare.prepareLaunch(folder, context);
  const chosen = { ...detectGame({ rootDir: original, inputPath: path.join(original, "game.hcb") }), gameId: "chosen" };
  Prepare.prepareLaunch(chosen, context);
  fs.writeFileSync(path.join(original, "game.bch"), script("Translation"));
  const translated = Prepare.prepareLaunch(folder, context), retained = Prepare.prepareLaunch(chosen, context);
  assert.equal(folder.moduleData.scriptName, "game.bch"); assert.equal(translated.scriptPath, path.join(original, "game.bch"));
  assert.equal(chosen.moduleData.scriptName, "game.hcb"); assert.equal(retained.scriptPath, path.join(original, "game.hcb"));
  for (const launch of [translated, retained]) { assert.equal(launch.gameRoot, path.join(launch.directory, "play")); }
  assert.equal(fs.readlinkSync(path.join(retained.gameRoot, "game.hcb")), path.join(original, "game.hcb"));
  assert.equal(fs.readlinkSync(path.join(translated.gameRoot, "game.bch")), path.join(original, "game.bch"));
});

test("FVP direct preparation leaves unrelated old views and saves untouched", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  const entry = { gameId: "retain", gamePath: original }, context = { userDataDir: path.join(root, "library") };
  const moduleRoot = Prepare.directoryFor(entry, context), play = path.join(moduleRoot, "play"), saves = path.join(moduleRoot, "saves"), receipt = path.join(moduleRoot, "preparation.json");
  fs.mkdirSync(play, {recursive: true}); fs.mkdirSync(saves); fs.writeFileSync(path.join(play, "private-user-file"), "sole copy"); fs.writeFileSync(path.join(saves, "rfvp_s000.bin"), "retained"); fs.writeFileSync(receipt, "not read during Play");
  const first = Prepare.prepareLaunch(entry, context);
  const blocked = file => [play, saves, receipt].some(name => String(file) === name || String(file).startsWith(name + path.sep));
  for (const name of ["lstatSync", "statSync", "readFileSync", "readdirSync"]) {
    const originalMethod = fs[name]; t.mock.method(fs, name, (file, ...args) => { assert.equal(blocked(file), false, "current Play must not inspect obsolete mirrors"); return originalMethod(file, ...args); });
  }
  t.mock.method(fs, "symlinkSync", () => assert.fail("Play must not create game aliases"));
  t.mock.method(fs, "copyFileSync", () => assert.fail("Play must not copy game files"));
  const second = Prepare.prepareLaunch(entry, context);
  assert.equal(first.gameRoot, original); assert.equal(second.gameRoot, original); assert.equal(second.saveRoot, path.join(original, "save"));
});

test("FVP shared import, save resolver and runtime consent hooks require no manual preparation", async t => {
  const Module = require("../src/modules/fvp/main"), root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  const entry = { ...detectGame({ rootDir: original }), gameId: "imported" }, context = { userDataDir: path.join(root, "library"), settings: {}, runtimeSettings: {} };
  Module.onImport(entry, context); assert.equal(fs.existsSync(context.userDataDir), false);
  const locations = Module.resolveSaveLocations(entry, context); assert.equal(locations.primaryDirectory, entry.defaultSaveDir); assert.equal(locations.directories.length, 1);
  const manager = Module.runtimeManagers[0], resolveForPlay = manager.resolveForPlay;
  t.after(() => { manager.resolveForPlay = resolveForPlay; });
  manager.resolveForPlay = async (game, ctx) => { assert.equal(game, entry); assert.equal(ctx, context); return { ready: false, version: "0.6.0-example" }; };
  assert.deepEqual(await Module.ensureRuntime(entry, context), { managerId: "rfvp", version: "0.6.0-example", installOptions: {} });
  assert.equal(fs.existsSync(context.userDataDir), false);
  for (const action of Module.manifest.ui.actions) assert.equal(typeof Module.actions[action.id], "function");
});

test("FVP propagates cancellation and shared detection budgets instead of falling back", t => {
  const root = directory(t); fixture(root);
  for (const error of [Object.assign(new Error("limit"), { code: "DETECTION_LIMIT" }), Object.assign(new Error("cancelled"), { name: "AbortError" })]) {
    assert.throws(() => detectGame({ rootDir: root, detection: { readdir() { throw error; } } }), value => value === error);
    assert.throws(() => Inspect.inspectScript(path.join(root, "game.hcb"), { detection: { stat() { throw error; } } }), value => value === error);
  }
});

test("FVP preserves an explicit working save folder and original content", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  fs.mkdirSync(path.join(original, "save")); fs.writeFileSync(path.join(original, "save", "s001.bin"), "original Windows save");
  fs.mkdirSync(path.join(original, "voice")); fs.writeFileSync(path.join(original, "voice", "sample.ogg"), "audio");
  const before = snapshots(original), context = { userDataDir: path.join(root, "library"), runtimeSettings: { textEncoding: "sjis", textHiDpi: false } };
  const entry = { gameId: "one", gamePath: original, saveDirOverride: path.join(root, "saved-external-choice") }, launch = Prepare.prepareLaunch(entry, context);
  assert.equal(launch.gameRoot, path.join(launch.directory, "play")); assert.equal(launch.root, original); assert.equal(launch.saveRoot, entry.saveDirOverride); assert.equal(launch.textHiDpi, false);
  assert.equal(launch.env.FVP_BASE_PATH, launch.gameRoot); assert.equal(launch.env.FVP_HCB_ROOT, launch.gameRoot); assert.equal(fs.readlinkSync(path.join(launch.gameRoot, "save")), entry.saveDirOverride);
  assert.deepEqual(snapshots(original), before); assert.equal(entry.saveDirOverride, path.join(root, "saved-external-choice"));
  fs.writeFileSync(path.join(launch.saveRoot, "rfvp_global.bin"), "RFVP progress");
  fs.rmSync(context.userDataDir, {recursive: true});
  assert.equal(fs.readFileSync(path.join(entry.saveDirOverride, "rfvp_global.bin"), "utf8"), "RFVP progress");
  assert.equal(fs.readFileSync(path.join(original, "save", "s001.bin"), "utf8"), "original Windows save");
  assert.equal(entry.defaultSaveDir, launch.saveRoot);
});

test("FVP adapts nonstandard script and archive names without changing originals", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  fs.renameSync(path.join(original, "game.hcb"), path.join(original, "SNOW.HCB")); fs.renameSync(path.join(original, "graph.bin"), path.join(original, "GRAPH.BIN"));
  fs.mkdirSync(path.join(original, "save"));
  const entry = { gameId: "one", gamePath: original }, context = { userDataDir: path.join(root, "library") }, before = snapshots(original), launch = Prepare.prepareLaunch(entry, context);
  assert.equal(launch.gameRoot, path.join(launch.directory, "play")); assert.equal(launch.scriptPath, path.join(original, "SNOW.HCB"));
  assert.equal(fs.readlinkSync(path.join(launch.gameRoot, "game.hcb")), path.join(original, "SNOW.HCB"));
  assert.equal(fs.readlinkSync(path.join(launch.gameRoot, "graph.bin")), path.join(original, "GRAPH.BIN"));
  assert.deepEqual(snapshots(original), before);
});

test("FVP direct route accepts ordinary source aliases and keeps released private saves active", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  const entry = { gameId: "one", gamePath: original }, context = { userDataDir: path.join(root, "library") };
  fs.symlinkSync(path.join(original, "graph.bin"), path.join(original, "ordinary-asset.alias"));
  const launch = Prepare.prepareLaunch(entry, context);
  assert.equal(launch.gameRoot, original); assert.equal(launch.saveRoot, path.join(original, "save"));
  fs.unlinkSync(path.join(original, "ordinary-asset.alias"));
  const released = {...entry, gameId: "released", defaultSaveDir: path.join(Prepare.directoryFor({...entry, gameId: "released"}, context), "saves")};
  fs.mkdirSync(released.defaultSaveDir, {recursive: true});fs.writeFileSync(path.join(released.defaultSaveDir, "slot"), "released data");
  const adapted = Prepare.prepareLaunch(released, context);
  assert.equal(adapted.saveRoot, released.defaultSaveDir);assert.equal(fs.readFileSync(path.join(adapted.gameRoot, "save", "slot"), "utf8"), "released data");
  assert.throws(() => Prepare.directoryFor({ gameId: "../escape" }, context), /saved game/);
});

test("FVP included host uses exact embedded Python and managed dylib with isolated arguments", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  const launch = Prepare.prepareLaunch({ gameId: "host", gamePath: original }, { userDataDir: path.join(root, "library"), runtimeSettings: { textEncoding: "gbk", textHiDpi: false } });
  const executable = macho(path.join(root, "python3")), dylibPath = macho(path.join(root, "librfvp.dylib"), true);
  const options = { resolveRoot: () => root, resolveBinary: value => { assert.equal(value, root); return executable; } };
  const command = Host.hostCommand(launch, { dylibPath }, options);
  assert.equal(command.executablePath, executable); assert.deepEqual(command.args.slice(-4), [dylibPath, original, "gbk", "0"]);
  assert.deepEqual(command.args.slice(0, 3), ["-I", "-B", "-u"]); assert.ok(fs.readFileSync(command.args[3], "utf8").includes("rfvp_run_entry"));
  assert.equal(command.args[3], path.resolve("src/modules/fvp/host.py")); assert.equal(fs.existsSync(path.join(launch.directory, "rfvp-host.py")), false);
  assert.throws(() => Host.hostCommand(launch, { dylibPath }, { resolveRoot: () => null, resolveBinary: () => null }), /included Python/);
  assert.throws(() => Host.hostCommand(launch, {}, options), /native library/);
});

test("FVP resolves its one immutable host from unpacked ASAR paths", t => {
  const root = directory(t), packed = path.join(root, "app.asar", "src/modules/fvp"), unpacked = path.join(root, "app.asar.unpacked", "src/modules/fvp");
  fs.mkdirSync(unpacked, { recursive: true }); fs.copyFileSync(path.resolve("src/modules/fvp/host.py"), path.join(unpacked, "host.py"));
  assert.equal(Host.resolveHostScript(packed), path.join(unpacked, "host.py"));
});

test("FVP launch sends the original directory to the host and foreground child cwd", async t => {
  const {EventEmitter} = require("node:events"), {PassThrough} = require("node:stream");
  const root = directory(t), original = path.join(root, "original");fs.mkdirSync(original);fixture(original);
  const focusPath = require.resolve("../src/modules/shared/runtime/native-focus"), focus = require(focusPath), previousFocus = focus.spawnForegroundNativeGame;
  const mainPath = require.resolve("../src/modules/fvp/main"), previousMain = require.cache[mainPath], previousHost = Host.hostCommand;
  let spawned;
  const child = new EventEmitter();child.stdout = new PassThrough();child.stderr = new PassThrough();
  focus.spawnForegroundNativeGame = async options => { spawned = options;return child; };
  delete require.cache[mainPath];const Module = require(mainPath), manager = Module.runtimeManagers[0], previousSelection = manager.resolveSelection;
  t.after(() => { focus.spawnForegroundNativeGame = previousFocus;Host.hostCommand = previousHost;manager.resolveSelection = previousSelection;if(previousMain)require.cache[mainPath] = previousMain;else delete require.cache[mainPath]; });
  manager.resolveSelection = () => ({ready: true, install: {dylibPath: "/fixture/runtime/librfvp.dylib"}});
  Host.hostCommand = launch => { assert.equal(launch.gameRoot, original);return {executablePath: "/fixture/python", args: [launch.gameRoot]}; };
  const entry = {gameId: "launch", gamePath: original}, context = {userDataDir: path.join(root, "library"), settings: {}, runtimeSettings: {}};
  assert.equal(await Module.launchRuntime("rfvp", entry, context), child);
  assert.equal(spawned.options.cwd, original);assert.equal(spawned.options.env.FVP_BASE_PATH, original);assert.equal(spawned.options.env.FVP_HCB_ROOT, original);
  assert.equal(fs.existsSync(path.join(Prepare.directoryFor(entry, context), "play")), false);
  child.emit("close", 0, null);
});

test("FVP schemas expose managed runtime settings and optional raw-asset actions without setup steps", () => {
  const manifest = require("../src/modules/fvp/manifest.json");
  assert.equal(manifest.runtime.default, "rfvp"); assert.equal(manifest.runtime.manager.rfvp, "rfvp"); assert.equal(manifest.runtime.managerUi.rfvp.management, "managed");
  assert.deepEqual(manifest.runtime.entries.rfvp.settings.defaults, { textEncoding: "sjis", textHiDpi: true });
  assert.equal(manifest.supports.saveEditing, false); assert.equal(manifest.supports.cheats, false);
  assert.deepEqual(manifest.ui.actionGroups.find(group => group.id === "assets").actions, ["fvp-list-assets", "fvp-extract-assets", "fvp-reveal-assets", "fvp-remove-assets"]);
});
