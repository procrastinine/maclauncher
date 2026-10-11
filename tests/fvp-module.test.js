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

test("FVP warm preparation observes new translations while preserving an explicitly selected original script", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  const context = { userDataDir: path.join(root, "library") }, folder = { gameId: "folder", gamePath: original };
  Prepare.prepareLaunch(folder, context);
  const chosen = { ...detectGame({ rootDir: original, inputPath: path.join(original, "game.hcb") }), gameId: "chosen" };
  Prepare.prepareLaunch(chosen, context);
  fs.writeFileSync(path.join(original, "game.bch"), script("Translation"));
  const translated = Prepare.prepareLaunch(folder, context), retained = Prepare.prepareLaunch(chosen, context);
  assert.equal(folder.moduleData.scriptName, "game.bch"); assert.ok(fs.existsSync(path.join(translated.playRoot, "game.bch")));
  assert.equal(chosen.moduleData.scriptName, "game.hcb"); assert.ok(fs.existsSync(path.join(retained.playRoot, "game.hcb")));
});

test("FVP failed source-view replacement retains the previous launch view and private saves", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  const entry = { gameId: "retain", gamePath: original }, context = { userDataDir: path.join(root, "library") }, first = Prepare.prepareLaunch(entry, context);
  const inode = fs.statSync(first.playRoot).ino; fs.writeFileSync(path.join(first.saveRoot, "rfvp_s000.bin"), "retained");
  fs.symlinkSync(path.join(original, "graph.bin"), path.join(original, "unsupported-alias.bin"));
  assert.throws(() => Prepare.prepareLaunch(entry, context), /aliases/);
  assert.equal(fs.statSync(first.playRoot).ino, inode); assert.equal(fs.readFileSync(path.join(first.saveRoot, "rfvp_s000.bin"), "utf8"), "retained");
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

test("FVP preparation keeps original scripts, assets and Windows saves unchanged and exposes private save output", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  fs.mkdirSync(path.join(original, "save")); fs.writeFileSync(path.join(original, "save", "s001.bin"), "original Windows save");
  fs.mkdirSync(path.join(original, "voice")); fs.writeFileSync(path.join(original, "voice", "sample.ogg"), "audio");
  const before = snapshots(original), context = { userDataDir: path.join(root, "library"), runtimeSettings: { textEncoding: "sjis", textHiDpi: false } };
  const entry = { gameId: "one", gamePath: original }, launch = Prepare.prepareLaunch(entry, context);
  assert.equal(fs.realpathSync(path.join(launch.playRoot, "game.hcb")), fs.realpathSync(path.join(original, "game.hcb")));
  assert.equal(fs.realpathSync(path.join(launch.playRoot, "graph.bin")), fs.realpathSync(path.join(original, "graph.bin")));
  assert.equal(fs.realpathSync(path.join(launch.playRoot, "save")), fs.realpathSync(launch.saveRoot)); assert.equal(launch.textHiDpi, false);
  fs.writeFileSync(path.join(launch.playRoot, "save", "rfvp_global.bin"), "private RFVP save");
  const stat = fs.statSync(launch.playRoot), second = Prepare.prepareLaunch(entry, context);
  assert.equal(fs.statSync(second.playRoot).ino, stat.ino); assert.equal(fs.readFileSync(path.join(second.saveRoot, "rfvp_global.bin"), "utf8"), "private RFVP save");
  assert.deepEqual(snapshots(original), before); assert.equal(entry.defaultSaveDir, launch.saveRoot);
});

test("FVP replaces changed source views without losing private saves and supports uppercase scenario names", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  fs.renameSync(path.join(original, "game.hcb"), path.join(original, "GAME.HCB"));
  const entry = { gameId: "one", gamePath: original }, context = { userDataDir: path.join(root, "library") }, first = Prepare.prepareLaunch(entry, context);
  assert.ok(fs.existsSync(path.join(first.playRoot, "game.hcb")));
  fs.writeFileSync(path.join(first.saveRoot, "rfvp_s000.bin"), "progress"); fs.writeFileSync(path.join(original, "cursor0.ani"), "new asset");
  const second = Prepare.prepareLaunch(entry, context);
  assert.equal(fs.readFileSync(path.join(second.playRoot, "cursor0.ani"), "utf8"), "new asset");
  assert.equal(fs.readFileSync(path.join(second.saveRoot, "rfvp_s000.bin"), "utf8"), "progress");
  fs.writeFileSync(path.join(original, "GAME.HCB"), script("Changed title")); Prepare.gameData(entry, context); assert.equal(entry.moduleData.title, "Changed title");
});

test("FVP preparation rejects aliases and writable output within originals, including custom-save aliases", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  const entry = { gameId: "one", gamePath: original }, context = { userDataDir: path.join(root, "library") };
  assert.throws(() => Prepare.prepareLaunch({ ...entry, saveDirOverride: path.join(original, "save") }, context), /outside/);
  fs.symlinkSync(original, path.join(root, "alias")); assert.throws(() => Prepare.prepareLaunch({ ...entry, saveDirOverride: path.join(root, "alias") }, context), /outside/);
  fs.symlinkSync(path.join(original, "graph.bin"), path.join(original, "alias.bin")); assert.throws(() => Prepare.prepareLaunch(entry, context), /aliases/);
  assert.throws(() => Prepare.directoryFor({ gameId: "../escape" }, context), /saved game/);
});

test("FVP included host uses exact embedded Python and managed dylib with isolated arguments", t => {
  const root = directory(t), original = path.join(root, "original"); fs.mkdirSync(original); fixture(original);
  const launch = Prepare.prepareLaunch({ gameId: "host", gamePath: original }, { userDataDir: path.join(root, "library"), runtimeSettings: { textEncoding: "gbk", textHiDpi: false } });
  const executable = macho(path.join(root, "python3")), dylibPath = macho(path.join(root, "librfvp.dylib"), true);
  const options = { resolveRoot: () => root, resolveBinary: value => { assert.equal(value, root); return executable; } };
  const command = Host.hostCommand(launch, { dylibPath }, options);
  assert.equal(command.executablePath, executable); assert.deepEqual(command.args.slice(-4), [dylibPath, launch.playRoot, "gbk", "0"]);
  assert.deepEqual(command.args.slice(0, 2), ["-I", "-u"]); assert.ok(fs.readFileSync(command.args[2], "utf8").includes("rfvp_run_entry"));
  assert.equal(command.args[2], path.resolve("src/modules/fvp/host.py")); assert.equal(fs.existsSync(path.join(launch.directory, "rfvp-host.py")), false);
  assert.throws(() => Host.hostCommand(launch, { dylibPath }, { resolveRoot: () => null, resolveBinary: () => null }), /included Python/);
  assert.throws(() => Host.hostCommand(launch, {}, options), /native library/);
});

test("FVP resolves its one immutable host from unpacked ASAR paths", t => {
  const root = directory(t), packed = path.join(root, "app.asar", "src/modules/fvp"), unpacked = path.join(root, "app.asar.unpacked", "src/modules/fvp");
  fs.mkdirSync(unpacked, { recursive: true }); fs.copyFileSync(path.resolve("src/modules/fvp/host.py"), path.join(unpacked, "host.py"));
  assert.equal(Host.resolveHostScript(packed), path.join(unpacked, "host.py"));
});

test("FVP schemas expose managed runtime settings and optional raw-asset actions without setup steps", () => {
  const manifest = require("../src/modules/fvp/manifest.json");
  assert.equal(manifest.runtime.default, "rfvp"); assert.equal(manifest.runtime.manager.rfvp, "rfvp"); assert.equal(manifest.runtime.managerUi.rfvp.management, "managed");
  assert.deepEqual(manifest.runtime.entries.rfvp.settings.defaults, { textEncoding: "sjis", textHiDpi: true });
  assert.equal(manifest.supports.saveEditing, false); assert.equal(manifest.supports.cheats, false);
  assert.deepEqual(manifest.ui.actionGroups[0].actions, ["fvp-list-assets", "fvp-extract-assets", "fvp-reveal-assets", "fvp-remove-assets"]);
});
