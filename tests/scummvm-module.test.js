const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("../src/modules/scummvm/main");
const Detection = require("../src/modules/scummvm/detect");
const Manager = require("../src/modules/scummvm/runtime/manager");

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scummvm-module-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fixture(root, names) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, data] of Object.entries(names)) fs.writeFileSync(path.join(root, name), data);
  return root;
}
function detect(root, input = root, app = false) { return Module.detectGame({ rootDir: root, inputPath: input, isAppBundle: app, stat: fs.statSync(input) }); }
function binary() {
  const data = Buffer.alloc(32); data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4); data.writeUInt32LE(2, 12);
  return data;
}

test("ScummVM detects case-insensitive paired data from folders and dropped executables", t => {
  const root = fixture(temporary(t), { "PLAY.000": "RNAM", "PLAY.001": "LECF", "PLAY.EXE": "windows runner" });
  assert.equal(detect(root).moduleData.sourceKind, "SCUMM");
  assert.equal(detect(root, path.join(root, "PLAY.EXE")).contentRootDir, root);
  fs.rmSync(path.join(root, "PLAY.001"));
  assert.equal(detect(root), null);
});
test("ScummVM identifies SCI and AGI layouts with supporting files, excluding incomplete folders", t => {
  const root = temporary(t);
  const sci = fixture(path.join(root, "sci"), { "RESOURCE.MAP": "map", "RESOURCE.001": "archive" });
  assert.equal(detect(sci).moduleData.sourceKind, "SCI");
  const agi = fixture(path.join(root, "agi"), Object.fromEntries(["LOGDIR", "PICDIR", "VIEWDIR", "SNDDIR", "WORDS.TOK", "OBJECT", "VOL.0"].map(name => [name, "fixture"])));
  assert.equal(detect(agi).moduleData.sourceKind, "AGI");
  fs.rmSync(path.join(agi, "OBJECT")); assert.equal(detect(agi), null);
});
test("ScummVM checks archive signatures rather than treating any game DAT or EXE as supported", t => {
  const root = fixture(temporary(t), { "game.dat": "arbitrary", "game.exe": "arbitrary", "data.mhk": "arbitrary", "data.dcp": "arbitrary" });
  assert.equal(detect(root), null);
  fs.writeFileSync(path.join(root, "data.dcp"), Buffer.from("addec0de4a554e4b", "hex"));
  assert.equal(detect(root).moduleData.sourceKind, "Wintermute");
  fs.rmSync(path.join(root, "data.dcp"));
  fs.writeFileSync(path.join(root, "game.dat"), "Adventure Creator Game File v2");
  assert.equal(detect(root).moduleData.sourceKind, "Adventure Game Studio");
});
test("ScummVM supports game markers without executing game code and rejects malformed IDs", t => {
  const root = fixture(temporary(t), { "game.scummvm": "scumm:fixture\n" });
  assert.equal(detect(root).moduleData.gameId, "scumm:fixture");
  fs.writeFileSync(path.join(root, "game.scummvm"), "");
  assert.equal(detect(root).moduleData.gameId, undefined);
  for (const value of ["--help", "../outside", "scumm:fixture\n--fullscreen", "x".repeat(1025)]) {
    fs.writeFileSync(path.join(root, "game.scummvm"), value); assert.equal(detect(root), null);
  }
});
test("ScummVM reads app-contained game data and avoids arbitrary games in collections", t => {
  const root = temporary(t), app = path.join(root, "Adventure.app");
  fixture(path.join(app, "Contents", "Resources", "game"), { "DATA.000": "RNAM", "DATA.001": "LECF" });
  assert.equal(detect(app, app, true).contentRootDir, path.join(app, "Contents", "Resources", "game"));
  const collection = fixture(path.join(root, "collection"), { "DATA.000": "RNAM", "DATA.001": "LECF" });
  fixture(path.join(collection, "game"), { "DATA.000": "RNAM", "DATA.001": "LECF" });
  assert.equal(detect(collection), null);
});
test("ScummVM rejects unrelated numbered files and auxiliary executables beside valid data", t => {
  const root = fixture(temporary(t), { "cache.000": "database", "cache.001": "database", "helper.exe": "auxiliary" });
  assert.equal(detect(root), null);
  fs.writeFileSync(path.join(root, "cache.000"), Buffer.from("RNAM").map(byte => byte ^ 0x69));
  fs.writeFileSync(path.join(root, "cache.001"), Buffer.from("LECF").map(byte => byte ^ 0x69));
  assert.equal(detect(root).moduleData.sourceKind, "SCUMM");
  assert.equal(detect(root, path.join(root, "helper.exe")), null);
});
test("ScummVM config and saves remain per-game, preserving preferences and disabling automatic updates", t => {
  const root = temporary(t), source = fixture(path.join(root, "source"), { "game.scummvm": "" });
  const context = { userDataDir: path.join(root, "profile") }, entry = { ...detect(source), gameId: "fixture" };
  Module.onImport(entry, context);
  const launch = Module.__test.prepareLaunch(entry, context);
  fs.writeFileSync(launch.configPath, "[scummvm]\nupdates_check=86400\nsubtitles=true\n[game]\nupdates_check=600\n");
  const next = Module.__test.prepareLaunch(entry, context), config = fs.readFileSync(next.configPath, "utf8");
  assert.match(config, /updates_check=0/); assert.match(config, /subtitles=true/);
  assert.equal((config.match(/updates_check=/g) || []).length, 1);
  assert.notEqual(Module.__test.prepareLaunch({ ...entry, gameId: "second" }, context).saveRoot, launch.saveRoot);
  assert.deepEqual(fs.readdirSync(source), ["game.scummvm"]);
  const custom = path.join(root, "custom-saves"); entry.saveDirOverride = custom;
  Module.__test.prepareLaunch(entry, context); fs.writeFileSync(path.join(custom, "save.001"), "keep");
  Module.cleanupGameData(entry, context); assert.equal(fs.existsSync(path.join(custom, "save.001")), true);
});
test("ScummVM launch options validate identifiers, graphics, and audio volumes", () => {
  const settings = Module.manifest.runtime.entries.scummvm.settings.defaults;
  const args = Module.__test.runtimeArgs({ ...settings, language: "fr", renderer: "software", gameId: "scumm:fixture" });
  assert.ok(args.args.includes("--language=fr")); assert.ok(args.args.includes("--music-volume=192")); assert.equal(args.gameId, "scumm:fixture");
  for (const bad of [{ musicVolume: 256 }, { speechVolume: 2.5 }, { language: "en\n--help" }, { gameId: "--help" }]) assert.throws(() => Module.__test.runtimeArgs(bad), /ScummVM/);
});
test("ScummVM parses supported edition output while requiring the selected game directory", () => {
  const root = path.resolve("fixture-game");
  const output = `GameID                         Description                                                Full Path\nscumm:fixture                  Fixture Game (Demo/DOS)                                    ${root}\nscumm:fixture                  Fixture Game (Demo/DOS)                                    ${root}\nscumm:other                    Other Game                                                  ${path.resolve("other-game")}\n`;
  assert.deepEqual(Module.__test.parseDetection(output, root), [{ gameId: "scumm:fixture", description: "Fixture Game (Demo/DOS)" }]);
});
test("ScummVM installed launch uses automatic detection, private paths and requested settings", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), source = fixture(path.join(root, "source"), { "game.scummvm": "" }), profile = path.join(root, "profile"), executable = path.join(root, "scummvm");
  fs.writeFileSync(executable, binary(), { mode: 0o755 });
  Manager.core.registerLocal({ userDataDir: profile, runtimePath: executable, version: "2026.3.0" });
  const entry = { ...detect(source), gameId: "fixture" }, calls = [];
  const context = { userDataDir: profile, settings: {}, runtimeSettings: { fullscreen: true, language: "de" },
    spawnDetachedChecked: async (...args) => { calls.push(args); return { pid: null }; } };
  assert.equal(Module.ensureRuntime(entry, context), null);
  await Module.launchRuntime("scummvm", entry, context);
  assert.equal(calls[0][0], executable); assert.ok(calls[0][1].includes("--auto-detect")); assert.ok(calls[0][1].includes("--fullscreen"));
  assert.ok(calls[0][1].includes(`--path=${source}`)); assert.equal(calls[0][2].env.SDL_MAC_BACKGROUND_APP, "0");
});
test("ScummVM game identification obtains consent before downloading a missing player", async t => {
  const root = temporary(t), source = fixture(path.join(root, "source"), { "game.scummvm": "" }), profile = path.join(root, "profile");
  let consent = 0;
  await assert.rejects(Module.__test.inspectWithRuntime({ ...detect(source), gameId: "fixture" }, {
    userDataDir: profile, settings: {}, confirmRuntimeInstall: async plan => {
      consent++; assert.equal(plan.managerId, "scummvm"); assert.equal(plan.version, "2026.3.0"); return false;
    }
  }, { run: async () => assert.fail("Identification must not run before consent") }), { name: "AbortError" });
  assert.equal(consent, 1); assert.equal(fs.existsSync(path.join(profile, "runtimes")), false);
});
test("ScummVM game identification uses the selected installed player and updates the recognized edition", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), source = fixture(path.join(root, "source"), { "game.scummvm": "" }), profile = path.join(root, "profile"), executable = path.join(root, "scummvm");
  fs.writeFileSync(executable, binary(), { mode: 0o755 });
  Manager.core.registerLocal({ userDataDir: profile, runtimePath: executable, version: "2026.3.0" });
  const entry = { ...detect(source), gameId: "fixture" }; let changed = 0;
  const result = await Module.__test.inspectWithRuntime(entry, {
    userDataDir: profile, settings: {}, confirmRuntimeInstall: async () => assert.fail("An installed player needs no download consent"),
    onEntryChange: () => changed++
  }, { run: async (command, args, options) => {
    assert.equal(command, executable); assert.ok(args.includes("--detect")); assert.ok(args.includes(`--path=${source}`));
    assert.equal(options.timeout, 20000); assert.equal(options.cwd, path.dirname(entry.defaultSaveDir));
    return { stdout: `scumm:fixture                  Fixture Game (Demo/DOS)                                    ${source}\n` };
  } });
  assert.equal(result.gameId, "scumm:fixture"); assert.equal(entry.moduleData.gameDescription, "Fixture Game (Demo/DOS)");
  assert.equal(entry.moduleData.detectionRuntimeVersion, "2026.3.0"); assert.equal(changed, 1);
});
test("ScummVM source reads stay bounded for sparse executables", t => {
  const root = temporary(t), file = path.join(root, "game.exe"), fd = fs.openSync(file, "w");
  fs.ftruncateSync(fd, 1024 * 1024 * 1024); fs.closeSync(fd);
  assert.equal(Detection.readPart(file, 32, true).length, 32);
  assert.equal(Detection.readPart(root, 32).length, 0);
});
