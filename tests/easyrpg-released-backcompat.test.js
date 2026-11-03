const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("../src/modules/easyrpg/main");
const Backcompat = require("../src/modules/easyrpg/backcompat");
const { retireLegacyGameMirror } = require("../src/core/backcompat/legacy-game-mirrors");
const { runDataMigrations } = require("../src/core/backcompat/data-migrations");
const Settings = require("../src/core/runtime-settings");
const Detect = require("../src/modules/easyrpg/detect");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "easyrpg-released-backcompat-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), project = path.join(root, "original", "Game");
  fs.mkdirSync(project, { recursive: true });
  for (const [name, signature] of [["RPG_RT.ldb", Detect.HEADERS.database], ["RPG_RT.lmt", Detect.HEADERS.mapTree]])
    fs.writeFileSync(path.join(project, name), Buffer.concat([Buffer.from([signature.length]), Buffer.from(signature), Buffer.from([0])]));
  const entry = { ...Module.detectGame({ inputPath: project, rootDir: project }), gameId: "released", moduleId: "easyrpg", runtimeId: "easyrpg" };
  // Released v0.5.1 main.js:13,17,43 use these exact per-game directories.
  const moduleRoot = path.join(userDataDir, "games", "released", "modules", "easyrpg");
  const saves = path.join(moduleRoot, "saves"), config = path.join(moduleRoot, "config");
  fs.mkdirSync(saves, { recursive: true });fs.mkdirSync(config);
  entry.defaultSaveDir = saves;
  entry.saveLocations = [{ directory: saves, role: "primary" }];
  return { root, userDataDir, project, entry, moduleRoot, saves, config };
}

async function copyReleased(f) {
  const record = path.join(f.userDataDir, "games", "released", "game.json");
  const result = await runDataMigrations({ settings: {}, games: [f.entry], userDataDir: f.userDataDir,
    registry: { getModule: () => Backcompat },
    saveSettings: settings => { f.migrationSettings = JSON.parse(JSON.stringify(settings)); },
    saveEntry: entry => fs.writeFileSync(record, JSON.stringify(entry)) });
  return [{ complete: result.complete && result.pendingIds.length === 0 }];
}

function persistedLaunch(f) {
  const record = path.join(f.userDataDir, "games", "released", "game.json");
  const entry = JSON.parse(fs.readFileSync(record, "utf8"));
  const runtimeSettings = Settings.resolveRuntimeSettingsForEntry(entry, {}, Module.manifest, "easyrpg");
  const launch = Module.__test.launchArguments(entry, { ...f, runtimeSettings });
  return { entry, launch, configRoot: launch.args[launch.args.indexOf("--config-path") + 1] };
}

test("released EasyRPG saves and configuration reach the actual current per-game load paths", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.saves, "Save01.lsd"), "released progress");
  fs.writeFileSync(path.join(f.config, "config.ini"), "[Video]\nFullscreen=1\n");
  fs.mkdirSync(path.join(f.config, "Font"));
  fs.writeFileSync(path.join(f.config, "Font", "custom.ttf"), "released font");
  assert.ok((await copyReleased(f)).every(result => result.complete));
  const { entry, launch, configRoot } = persistedLaunch(f);
  assert.equal(launch.directory, f.project);assert.equal(launch.saves, f.project);
  assert.equal(fs.readFileSync(path.join(launch.saves, "Save01.lsd"), "utf8"), "released progress");
  assert.equal(configRoot, f.project, "the visible persisted config argument selects the recovered tree");
  assert.equal(fs.readFileSync(path.join(configRoot, "config.ini"), "utf8"), "[Video]\nFullscreen=1\n");
  assert.equal(fs.readFileSync(path.join(configRoot, "Font", "custom.ttf"), "utf8"), "released font");
  assert.equal(entry.defaultSaveDir, f.project);assert.equal(entry.saveLocations[0].directory, f.project);
  assert.deepEqual(entry.runtimeSettings.easyrpg.appArgs, ["--config-path", f.project]);
  assert.equal(fs.existsSync(f.saves), false);assert.equal(fs.existsSync(f.config), false);
});

test("released EasyRPG save and config conflicts preserve both versions at the actual original paths", async t => {
  const f = fixture(t);
  for (const [oldRoot, name, oldBytes, originalBytes] of [[f.saves, "Save02.lsd", "released save", "original save"],
    [f.config, "config.ini", "released config", "original config"]]) {
    fs.writeFileSync(path.join(oldRoot, name), oldBytes);fs.writeFileSync(path.join(f.project, name), originalBytes);
  }
  assert.ok((await copyReleased(f)).every(result => result.complete));
  const { launch, configRoot } = persistedLaunch(f);
  for (const [root, name, oldBytes, originalBytes] of [[launch.saves, "Save02.lsd", "released save", "original save"],
    [configRoot, "config.ini", "released config", "original config"]]) {
    assert.equal(fs.readFileSync(path.join(root, name), "utf8"), originalBytes);
    const conflict = fs.readdirSync(root).find(file => file.startsWith(name + ".MacLauncher-conflict-"));
    assert.ok(conflict);assert.equal(fs.readFileSync(path.join(root, conflict), "utf8"), oldBytes);
  }
});

test("EasyRPG new imports keep upstream preferences and preserve authored overrides", t => {
  const f = fixture(t), other = { ...f.entry, gameId: "other", gamePath: path.join(f.root, "second", "Game"), contentRootDir: path.join(f.root, "second", "Game") };
  Module.onImport(f.entry, { runtimeSettings: { appArgs: ["--no-vsync"] } });
  Module.onImport(other, { runtimeSettings: { appArgs: [] } });
  assert.equal(f.entry.runtimeSettings, undefined);
  assert.equal(other.runtimeSettings, undefined);
  const first = structuredClone(f.entry.runtimeSettings);
  Module.onImport(f.entry, { runtimeSettings: { appArgs: [] } });
  assert.deepEqual(f.entry.runtimeSettings, first, "ordinary import never injects a configuration override");
  const chosen = { ...other, runtimeSettings: { easyrpg: { appArgs: ["--config-path", "/chosen/config"] } } };
  Module.onImport(chosen, {});
  assert.deepEqual(chosen.runtimeSettings.easyrpg.appArgs, ["--config-path", "/chosen/config"]);
  const textOverride = { ...other, launchArguments: "--config-path '/authored/config'", runtimeSettings: {} };
  Module.onImport(textOverride, { runtimeSettings: { appArgs: [] } });
  assert.deepEqual(textOverride.runtimeSettings, {});
});

test("released EasyRPG without private config.ini gains no configuration override", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.saves, "Save01.lsd"), "released progress");
  assert.ok((await copyReleased(f)).every(result => result.complete));
  const { entry, launch } = persistedLaunch(f);
  assert.equal(entry.runtimeSettings, undefined);
  assert.equal(launch.args.includes("--config-path"), false);
  assert.equal(fs.readFileSync(path.join(launch.saves, "Save01.lsd"), "utf8"), "released progress");
});

test("unattributed private EasyRPG configuration assets stay blocked without guessing an override", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.config, "Font"));
  fs.writeFileSync(path.join(f.config, "Font", "custom.ttf"), "released font without configuration identity");
  const descriptor = Backcompat.legacyGameMirrors(f.entry, f).find(row => row.mirrorRoot === f.config);
  assert.equal(descriptor.sourceRoot, null);
  assert.equal((await retireLegacyGameMirror(descriptor, f)).complete, false);
  assert.equal(f.entry.runtimeSettings, undefined);
  assert.equal(fs.readFileSync(path.join(f.config, "Font", "custom.ttf"), "utf8"), "released font without configuration identity");
});

test("released config referencing retired private bytes is blocked rather than counted as recovered", async t => {
  const f = fixture(t), before = structuredClone(f.entry);
  fs.writeFileSync(path.join(f.config, "config.ini"), `[Audio]\nSoundfont=${path.join(f.config, "Soundfont", "custom.sf2")}\n`);
  const descriptor = Backcompat.legacyGameMirrors(f.entry, f).find(row => row.mirrorRoot === f.config);
  assert.equal(descriptor.sourceRoot, null);
  const result = await retireLegacyGameMirror(descriptor, f);
  assert.equal(result.complete, false);assert.match(result.reason, /original game folder for these files is unknown/);
  assert.ok(fs.existsSync(path.join(f.config, "config.ini")));assert.equal(fs.existsSync(path.join(f.project, "config.ini")), false);
  assert.deepEqual(f.entry, before, "a failed copy must not invoke the post-copy identity callback");
});
