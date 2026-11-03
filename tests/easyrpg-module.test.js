const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("../src/modules/easyrpg/main");
const Detect = require("../src/modules/easyrpg/detect");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyrpg-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function project(root, { lowerCase = false, title = "Sample project" } = {}) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, signature] of [["RPG_RT.ldb", Detect.HEADERS.database], ["RPG_RT.lmt", Detect.HEADERS.mapTree]]) {
    fs.writeFileSync(path.join(root, lowerCase ? name.toLowerCase() : name), Buffer.concat([Buffer.from([signature.length]), Buffer.from(signature), Buffer.from([0])]));
  }
  fs.writeFileSync(path.join(root, "RPG_RT.ini"), `[RPG_RT]\nGameTitle=${title}\n[EasyRPG]\nEncoding=932\n`);
  fs.writeFileSync(path.join(root, "Map0001.lmu"), "map fixture");
  return Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) });
}

test("EasyRPG recognizes verified LCF projects from folders and project files", t => {
  const root = temporary(t), game = path.join(root, "ゲーム folder"), detected = project(game, { lowerCase: true });
  assert.equal(detected.engine, "easyrpg");
  assert.equal(detected.name, "Sample project");
  assert.equal(detected.moduleData.mapCount, 1);
  assert.equal(detected.moduleData.encoding, "932");
  for (const name of ["rpg_rt.ldb", "rpg_rt.lmt", "RPG_RT.ini"]) {
    const input = path.join(game, name);
    assert.equal(Module.detectGame({ inputPath: input, rootDir: game, stat: fs.statSync(input) }).contentRootDir, game);
  }
  fs.writeFileSync(path.join(game, "DynRPG.dll"), "dll fixture");
  assert.equal(Detect.inspectProject(game).hasDynRpg, true);
});

test("EasyRPG rejects corrupt signatures, incomplete projects and external database links", t => {
  const root = temporary(t), detected = project(root);
  assert.ok(detected);
  const database = path.join(root, "RPG_RT.ldb");
  fs.writeFileSync(database, "not an LCF database");
  assert.equal(Module.detectGame({ rootDir: root }), null);
  fs.rmSync(database);
  assert.equal(Module.detectGame({ rootDir: root }), null);
  const outside = path.join(root, "outside.ldb");
  fs.writeFileSync(outside, Buffer.concat([Buffer.from([11]), Buffer.from("LcfDataBase")]));
  fs.symlinkSync(outside, database);
  assert.equal(Module.detectGame({ rootDir: root }), null);
});

test("EasyRPG detects game data in an app bundle without recognizing empty players", t => {
  const root = temporary(t), app = path.join(root, "Sample.app"), resources = path.join(app, "Contents", "Resources", "game");
  project(resources);
  const entry = Module.detectGame({ rootDir: app, inputPath: app, isAppBundle: true });
  assert.equal(entry.contentRootDir, resources);
  fs.rmSync(resources, { recursive: true });
  assert.equal(Module.detectGame({ rootDir: app, inputPath: app, isAppBundle: true }), null);
});

test("EasyRPG Play plans a managed runtime without requiring advanced setup", t => {
  const root = temporary(t), game = path.join(root, "project"), entry = project(game);
  const context = { userDataDir: path.join(root, "data"), settings: {} };
  const requirement = Module.ensureRuntime(entry, context);
  assert.equal(requirement.managerId, "easyrpg");assert.equal(requirement.version, null);
  assert.equal(requirement.discoveryRequired, true);assert.equal(requirement.selectionRequired, undefined);
  const selected = { ...entry, runtimeData: { easyrpg: { version: "0.8.1" } } };
  assert.equal(Module.ensureRuntime(selected, context).version, "0.8.1");
  fs.rmSync(path.join(game, "RPG_RT.ldb"));
  assert.throws(() => Module.ensureRuntime(entry, context), /database or map tree/);
});

test("EasyRPG uses the original project and upstream save/config defaults without preparing a private view", t => {
  const root = temporary(t), game = path.join(root, "original"), entry = { ...project(game), gameId: "sample" };
  const context = { userDataDir: path.join(root, "data"), gameArguments: ["--fps-limit", "30", ""], runtimeSettings: { fullscreen: true, scaling: "bilinear", engine: "rpg2k3e",
    encoding: "932", language: "en", rtpPaths: [path.join(root, "RTP")], showFps: true, appArgs: ["--no-vsync"] } };
  fs.writeFileSync(path.join(game, "Save01.lsd"), "original save");
  Module.onImport(entry, context);
  const launch = Module.__test.launchArguments(entry, context);
  assert.ok(launch.args.includes("--fullscreen"));
  assert.ok(launch.args.includes("--engine"));
  assert.deepEqual(launch.args.slice(-3), ["--fps-limit", "30", ""]);
  assert.equal(launch.args[launch.args.indexOf("--project-path") + 1], game);
  assert.equal(launch.directory, game);
  assert.equal(launch.saves, game);
  assert.equal(entry.defaultSaveDir, game);
  for (const flag of ["--save-path", "--config-path", "--log-file"]) assert.equal(launch.args.includes(flag), false);
  assert.equal(fs.readFileSync(path.join(launch.saves, "Save01.lsd"), "utf8"), "original save");
  const before = fs.statSync(path.join(game, "Save01.lsd"));
  Module.__test.launchArguments(entry, context);
  const after = fs.statSync(path.join(game, "Save01.lsd"));
  assert.equal(after.ino, before.ino);assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(path.join(game, "Save01.lsd"), "utf8"), "original save");
  assert.equal(fs.existsSync(context.userDataDir), false, "import and repeated launch preparation create no private routing or saves");
  assert.equal(fs.existsSync(path.join(game, "easyrpg.log")), false);
});

test("EasyRPG preserves old private saves/config and resolves a stale recorded default to the original project", t => {
  const root = temporary(t), game = path.join(root, "original"), entry = { ...project(game), gameId: "sample" };
  const context = { userDataDir: path.join(root, "data") }, privateRoot = Module.__test.gameDirectory(entry, context);
  const oldSaves = path.join(privateRoot, "saves"), oldConfig = path.join(privateRoot, "config");
  fs.mkdirSync(oldSaves, { recursive: true });fs.mkdirSync(oldConfig);
  fs.writeFileSync(path.join(oldSaves, "Save01.lsd"), "private progress");
  fs.writeFileSync(path.join(oldConfig, "settings.ini"), "private config");
  fs.writeFileSync(path.join(privateRoot, "saves-imported.json"), JSON.stringify({sourceRoot: game}));
  fs.writeFileSync(path.join(game, "Save01.lsd"), "original progress");
  entry.defaultSaveDir = oldSaves;
  assert.deepEqual(Module.resolveSaveLocations(entry, context), {primaryDirectory: game});
  const launch = Module.__test.launchArguments(entry, context);
  assert.equal(launch.directory, game);assert.equal(entry.defaultSaveDir, game);
  assert.equal(fs.readFileSync(path.join(oldSaves, "Save01.lsd"), "utf8"), "private progress");
  assert.equal(fs.readFileSync(path.join(oldConfig, "settings.ini"), "utf8"), "private config");
  assert.equal(fs.readFileSync(path.join(game, "Save01.lsd"), "utf8"), "original progress");
  assert.deepEqual(fs.readdirSync(privateRoot).sort(), ["config", "saves", "saves-imported.json"]);
});

test("EasyRPG redirects saves only through an explicit override and permits explicit native config/log options", t => {
  const root = temporary(t), game = path.join(root, "original"), saves = path.join(root, "chosen saves");
  const entry = { ...project(game), gameId: "sample", saveDirOverride: saves }, config = path.join(root, "chosen config"), log = path.join(root, "chosen.log");
  fs.writeFileSync(path.join(game, "Save01.lsd"), "original save");
  const context = {userDataDir: path.join(root, "data"), runtimeSettings: {appArgs: ["--config-path", config, "--log-file", log]}};
  Module.onImport(entry, context);
  const launch = Module.__test.launchArguments(entry, context);
  assert.equal(launch.directory, game);assert.equal(launch.saves, saves);assert.equal(entry.defaultSaveDir, game);
  assert.equal(launch.args[launch.args.indexOf("--save-path") + 1], saves);
  assert.equal(launch.args[launch.args.indexOf("--config-path") + 1], config);
  assert.equal(launch.args[launch.args.indexOf("--log-file") + 1], log);
  assert.deepEqual(fs.readdirSync(saves), [], "an explicit destination does not silently import or replace saves");
  assert.equal(fs.existsSync(context.userDataDir), false);
});

test("EasyRPG spawn receives the original project cwd and leaves the old private default non-authoritative", async t => {
  const root = temporary(t), game = path.join(root, "original"), entry = { ...project(game), gameId: "sample", defaultSaveDir: path.join(root, "data", "old-saves") };
  const manager = require("../src/modules/easyrpg/runtime/manager"), install = {executablePath: "/runtime/EasyRPG Player", needsRosetta: true};
  t.mock.method(manager, "resolveSelection", () => ({ready: true, install, version: "0.8.1.1"}));
  const calls = [], context = {userDataDir: path.join(root, "data"), onEntryChange: value => calls.push({changed: value.defaultSaveDir}),
    spawnDetachedChecked: async (...args) => {calls.push(args);return "child";}};
  assert.equal(await Module.launchRuntime("easyrpg", entry, context), "child");
  assert.deepEqual(calls[0], {changed: game});assert.equal(calls[1][0], install.executablePath);
  assert.equal(calls[1][1][calls[1][1].indexOf("--project-path") + 1], game);
  assert.deepEqual(calls[1][2], {cwd: game});assert.equal(calls[1][3], true);
  assert.equal(calls[1][1].includes("--save-path"), false);assert.equal(fs.existsSync(context.userDataDir), false);
});

test("EasyRPG validates options before writing launch state", t => {
  const root = temporary(t), game = path.join(root, "original"), entry = { ...project(game), gameId: "sample" };
  const context = { userDataDir: path.join(root, "data") };
  for (const runtimeSettings of [{ scaling: "invalid" }, { engine: "invalid" }, { rtpPaths: ["relative"] }, { appArgs: ["--save-path=/tmp/outside"] }, { encoding: "932\0extra" }]) {
    assert.throws(() => Module.__test.launchArguments(entry, { ...context, runtimeSettings }), /Invalid|absolute|cannot change/);
  }
  assert.throws(() => Module.__test.launchArguments(entry, { ...context, gameArguments: ["--save-path=/tmp/outside"] }), /cannot change/);
  assert.equal(fs.existsSync(context.userDataDir), false);
});
