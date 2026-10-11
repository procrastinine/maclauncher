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
  assert.deepEqual(Module.ensureRuntime(entry, context), { managerId: "easyrpg", version: "0.8.1.1", installOptions: {} });
  const selected = { ...entry, runtimeData: { easyrpg: { version: "0.8.1" } } };
  assert.equal(Module.ensureRuntime(selected, context).version, "0.8.1");
  fs.rmSync(path.join(game, "RPG_RT.ldb"));
  assert.throws(() => Module.ensureRuntime(entry, context), /database or map tree/);
});

test("EasyRPG reads original assets and isolates saves, configuration and log paths", t => {
  const root = temporary(t), game = path.join(root, "original"), entry = { ...project(game), gameId: "sample" };
  const context = { userDataDir: path.join(root, "data"), runtimeSettings: { fullscreen: true, scaling: "bilinear", engine: "rpg2k3e",
    encoding: "932", language: "en", rtpPaths: [path.join(root, "RTP")], showFps: true, appArgs: ["--no-vsync"] } };
  fs.writeFileSync(path.join(game, "Save01.lsd"), "original save");
  Module.onImport(entry, context);
  const launch = Module.__test.launchArguments(entry, context);
  assert.ok(launch.args.includes("--fullscreen"));
  assert.ok(launch.args.includes("--engine"));
  assert.equal(launch.args[launch.args.indexOf("--project-path") + 1], game);
  assert.equal(launch.args[launch.args.indexOf("--save-path") + 1], entry.defaultSaveDir);
  assert.ok(entry.defaultSaveDir.startsWith(path.join(context.userDataDir, "games", "sample")));
  assert.equal(fs.readFileSync(path.join(launch.saves, "Save01.lsd"), "utf8"), "original save");
  fs.writeFileSync(path.join(launch.saves, "Save01.lsd"), "launcher save");
  fs.writeFileSync(path.join(game, "Save01.lsd"), "changed source save");
  Module.__test.launchArguments(entry, context);
  assert.equal(fs.readFileSync(path.join(launch.saves, "Save01.lsd"), "utf8"), "launcher save");
  assert.equal(fs.existsSync(path.join(game, "easyrpg.log")), false);
  const legacy = Module.__test.launchArguments(entry, context, { version: "0.8" });
  assert.equal(legacy.args.includes("--log-file"), false);
  Module.cleanupGameData(entry, context);
  assert.equal(fs.existsSync(launch.directory), false);
  assert.equal(fs.existsSync(path.join(game, "Save01.lsd")), true);
});

test("EasyRPG validates options before writing launch state", t => {
  const root = temporary(t), game = path.join(root, "original"), entry = { ...project(game), gameId: "sample" };
  const context = { userDataDir: path.join(root, "data") };
  for (const runtimeSettings of [{ scaling: "invalid" }, { engine: "invalid" }, { rtpPaths: ["relative"] }, { appArgs: ["--save-path=/tmp/outside"] }, { encoding: "932\0extra" }]) {
    assert.throws(() => Module.__test.launchArguments(entry, { ...context, runtimeSettings }), /Invalid|absolute|cannot change/);
  }
  assert.equal(fs.existsSync(context.userDataDir), false);
});
