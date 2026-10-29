const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { stopProcessTree } = require("../src/core/process-stop");
const Detection = require("../src/modules/crossover/detect");
const Module = require("../src/modules/crossover/main");
const Manager = require("../src/modules/crossover/runtime/manager");
const Launch = require("../src/modules/crossover/runtime/launch");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-crossover-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function pe(file, { machine = 0x14c, subsystem = 2, dll = false, signature = 0x4550 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(signature, 128); bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2 | (dll ? 0x2000 : 0), 150);
  bytes.writeUInt16LE(machine === 0x14c ? 0x10b : 0x20b, 152); bytes.writeUInt16LE(subsystem, 220);
  fs.writeFileSync(file, bytes);
  return file;
}
function app(directory, version = "26.3", architecture = "arm64") {
  const root = path.join(directory, "Contents", "SharedSupport", "CrossOver");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "share", "crossover", "bottle_templates", "win10_64"), { recursive: true });
  fs.writeFileSync(path.join(directory, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4); macho.writeUInt32LE(2, 12);
  for (const command of ["wineloader", "wineserver"]) fs.writeFileSync(path.join(root, "bin", command), macho, { mode: 0o755 });
  for (const command of ["wine", "cxbottle"]) fs.writeFileSync(path.join(root, "bin", command), "#!/usr/bin/perl\n", { mode: 0o755 });
  return directory;
}

test("CrossOver graphics architecture follows the re-executed Wine loader and refreshes when it changes", t => {
  const directory = fixture(t), application = app(path.join(directory, "CrossOver.app"));
  const root = path.join(application, "Contents/SharedSupport/CrossOver");
  const child = path.join(root, "lib/wine/x86_64-unix/wine");
  fs.mkdirSync(path.dirname(child), { recursive: true });
  const macho = Buffer.alloc(32);macho.writeUInt32LE(0xfeedfacf, 0);macho.writeUInt32LE(0x01000007, 4);macho.writeUInt32LE(2, 12);
  fs.writeFileSync(child, macho, { mode: 0o755 });
  const first = Manager.core.inspectApplication(application);
  assert.deepEqual(first.loaderArchitectures, ["arm64"]);
  assert.deepEqual(first.architectures, ["x86_64"]);
  assert.equal(first.graphicsExecutablePath, fs.realpathSync(child));
  assert.equal(first.needsRosetta, process.arch === "arm64");
  assert.deepEqual(require("../src/modules/crossover/graphics-inputs").inputs(first, null), { architecture: "x86_64" });
  macho.writeUInt32LE(0x0100000c, 4);fs.writeFileSync(child + ".next", macho, { mode: 0o755 });fs.renameSync(child + ".next", child);
  assert.deepEqual(Manager.core.inspectApplication(application).architectures, ["arm64"]);
  fs.rmSync(child);
  assert.equal(Manager.core.inspectApplication(application).graphicsExecutablePath, first.loaderPath);
  fs.symlinkSync(process.execPath, child);
  assert.throws(() => Manager.core.inspectApplication(application), /remain inside/);
});

test("CrossOver validates actual Windows PE executables and ignores DLLs, DOS stubs and other platforms", t => {
  const directory = fixture(t);
  assert.equal(Detection.readWindowsExecutable(pe(path.join(directory, "Game.exe"))).executableArchitecture, "x86");
  assert.equal(Detection.readWindowsExecutable(pe(path.join(directory, "Game64.exe"), { machine: 0x8664 })).executableArchitecture, "x86_64");
  const arm64 = pe(path.join(directory, "GameArm.exe"), { machine: 0xaa64 });
  assert.equal(Detection.readWindowsExecutable(arm64).executableArchitecture, "arm64");
  assert.equal(Module.__test.supportsEntry(Detection.decorateEntry({ gamePath: directory, importPath: arm64 }), {}, {}), false);
  for (const [name, options] of [["Library.exe", { dll: true }], ["Driver.exe", { subsystem: 1 }], ["DOS.exe", { signature: 0 }]]) {
    assert.equal(Detection.readWindowsExecutable(pe(path.join(directory, name), options)), null);
  }
  fs.writeFileSync(path.join(directory, "Linux.exe"), Buffer.from([0x7f, 69, 76, 70]));
  assert.equal(Detection.readWindowsExecutable(path.join(directory, "Linux.exe")), null);
});

test("CrossOver finds nested game executables, respects deliberate selections and skips native app content", t => {
  const directory = fixture(t), game = path.join(directory, "Quest");
  const nested = pe(path.join(game, "bin", "Quest.exe"));
  const helper = pe(path.join(game, "uninstall.exe"));
  assert.equal(Detection.findWindowsExecutable({ gamePath: game }).windowsExecutablePath, nested);
  assert.equal(Detection.findWindowsExecutable({ gamePath: game, importPath: helper }).windowsExecutablePath, helper);
  const bundle = path.join(directory, "Native.app");
  pe(path.join(bundle, "Contents", "Resources", "helper.exe"));
  assert.equal(Detection.findWindowsExecutable({ gamePath: bundle }), null);
  assert.equal(Detection.findWindowsExecutable({ gamePath: directory }).windowsExecutablePath, nested);
  assert.equal(Detection.detectGame({ rootDir: game, inputPath: game, stat: fs.statSync(game) }).moduleData.executablePath, helper);
  const selected = pe(path.join(game, "Quest.exe"));
  assert.equal(Detection.detectGame({ rootDir: game, inputPath: game, stat: fs.statSync(game) }).moduleData.executablePath, selected);
  assert.equal(Detection.detectGame({ rootDir: game, inputPath: nested, stat: fs.statSync(nested) }).moduleData.executablePath, nested);
});

test("CrossOver generic Windows fallback checks only top-level valid executables and never guesses among them", t => {
  const directory = fixture(t), game = path.join(directory, "Unknown");
  const nested = pe(path.join(game, "bin", "Game.exe"));
  const context = { rootDir: game, inputPath: game, stat: fs.statSync(game) };
  assert.equal(Detection.detectGame(context), null, "nested executables do not classify an unknown folder");
  fs.writeFileSync(path.join(game, "Invalid.exe"), "not a PE executable");
  pe(path.join(game, "Library.exe"), { dll: true });
  const selected = pe(path.join(game, "Game.exe"));
  assert.equal(Detection.detectGame(context).moduleData.executablePath, selected);
  const configuration = pe(path.join(game, "Config.exe"));
  assert.equal(Detection.detectGame(context).moduleData.executablePath, selected);
  assert.equal(Detection.detectGame({ ...context, inputPath: configuration, stat: fs.statSync(configuration) }).moduleData.executablePath, configuration);
  pe(path.join(game, "AnotherGame.exe"));
  assert.throws(() => Detection.detectGame(context), error => error.code === "DETECTION_CONFLICT" && /Select one \.exe/.test(error.message));
  assert.equal(Detection.detectGame({ ...context, inputPath: selected, stat: fs.statSync(selected) }).moduleData.executablePath, selected);
  assert.equal(Detection.detectGame({ ...context, inputPath: path.join(game, "Invalid.exe"), stat: fs.statSync(path.join(game, "Invalid.exe")) }), null);
  assert.equal(Detection.detectGame({ ...context, inputPath: nested, stat: fs.statSync(nested) }).moduleData.executablePath, nested);
});

test("CrossOver excludes native app imports even beside unrelated Windows executables", t => {
  const directory = fixture(t), gamePath = path.join(directory, "Native.app");
  fs.mkdirSync(gamePath);
  const unrelated = pe(path.join(directory, "Unrelated.exe"));
  const entry = { gamePath, importPath: gamePath, contentRootDir: directory, moduleId: "generic-app" };
  assert.equal(Detection.findWindowsExecutable(entry), null);
  assert.equal(Detection.decorateEntry(entry).runtimeData.crossover.windowsExecutablePath, null);
  assert.equal(Module.__test.hasWindowsExecutable({ ...entry,
    runtimeData: { crossover: { windowsExecutablePath: unrelated, detectionComplete: true } } }), false);
});

test("CrossOver records negative Windows evidence and does not inspect Linux trees when resolving support", t => {
  const directory = fixture(t);
  const entry = Detection.decorateEntry({ gamePath: directory, moduleId: "love" });
  assert.equal(entry.runtimeData.crossover.detectionComplete, true);
  assert.equal(entry.runtimeData.crossover.windowsExecutablePath, null);
  fs.renameSync(directory, directory + "-moved");
  t.after(() => fs.rmSync(directory + "-moved", { recursive: true, force: true }));
  assert.equal(Module.__test.hasWindowsExecutable(entry), false);
});

test("CrossOver registers multiple local application paths and removal leaves each application installed", t => {
  const directory = fixture(t), userDataDir = path.join(directory, "data");
  Manager.__test.writeRegistry(userDataDir, { applications: [], ignoredPaths: Manager.__test.AUTOMATIC_PATHS });
  const first = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "stable", "CrossOver.app")) });
  const second = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "patched", "CrossOver.app")) });
  assert.notEqual(first.version, second.version);
  const state = Manager.getState({ userDataDir, settings: { defaultVersion: second.version } });
  assert.equal(state.installed.length, 2);
  assert.equal(state.catalog.delivery, "local");
  assert.equal(state.catalog.installable, false);
  assert.notEqual(state.versionLabels[first.version], state.versionLabels[second.version]);
  assert.equal(state.defaultVersion, second.version);
  const entry = { moduleId: "rgss", runtimeData: { crossover: { version: first.version } } };
  assert.equal(Manager.resolveSelection(entry, { runtimes: { crossover: { defaultVersion: second.version } } }, userDataDir).version, first.version);
  assert.equal(Manager.resolveSelection(entry, { runtimes: { crossover: { defaultVersion: second.version } } }, userDataDir,
    { version: "auto" }).version, first.version, "Automatic retains the game's manual application");
  assert.equal(Manager.resolveSelection({}, {}, userDataDir).version,
    Manager.core.listInstalled(userDataDir).find(item => item.ready).version, "an unset default retains installed discovery");
  const cleared = Manager.resolveSelection({}, { runtimes: { crossover: { defaultVersion: null } } }, userDataDir);
  assert.equal(cleared.version, Manager.getState({ userDataDir }).defaultVersion);
  assert.notEqual(cleared.selectionRequired, true, "clearing returns to the manager default");
  assert.equal(Manager.getState({ userDataDir, settings: { defaultVersion: null } }).defaultSource, "manager");
  assert.equal(state.defaultSource, "saved");
  assert.deepEqual(Manager.updateSettingsAfterInstall({}, first), { defaultVersion: first.version });
  assert.deepEqual(Manager.updateSettingsAfterInstall({ defaultVersion: second.version }, first), { defaultVersion: second.version });
  assert.deepEqual(Manager.updateSettingsAfterInstall({ defaultVersion: null }, first), { defaultVersion: first.version });
  Manager.uninstallRuntime({ userDataDir, version: first.version });
  assert.equal(fs.existsSync(first.appPath), true);
  assert.equal(Manager.getState({ userDataDir }).installed.length, 1);
  assert.equal(Manager.resolveSelection(entry, {}, userDataDir).ready, false);
});

test("CrossOver automatic discovery is read-only and application updates retain their registered identity", t => {
  const directory = fixture(t), userDataDir = path.join(directory, "data"), runtimePath = app(path.join(directory, "CrossOver.app"), "25.0");
  const first = Manager.core.listInstalled(userDataDir, { automaticPaths: [runtimePath] })[0];
  assert.equal(first.automatic, true);
  assert.equal(fs.existsSync(userDataDir), false);
  app(runtimePath, "26.3");
  const next = Manager.core.listInstalled(userDataDir, { automaticPaths: [runtimePath] })[0];
  assert.equal(next.version, first.version);
  assert.equal(next.upstreamVersion, "26.3");
  const wine = path.join(runtimePath, "Contents", "SharedSupport", "CrossOver", "bin", "wine");
  fs.rmSync(wine); fs.symlinkSync("/usr/bin/perl", wine);
  assert.throws(() => Manager.core.inspectApplication(runtimePath), /inside the selected application/);
});

test("CrossOver environment settings are launch-scoped, quoted as data and keep bottle paths owned", () => {
  const installation = { crossoverRoot: "/Applications/CrossOver.app/Contents/SharedSupport/CrossOver" };
  const settings = { graphicsBackend: "dxmt", synchronization: "msync", locale: "ja_JP.UTF-8", bepInExWinhttp: true,
    environment: ["DXMT_CONFIG=d3d11.preferredMaxFrameRate=60", "CUSTOM_TITLE=it's a game; $(echo nope)"] };
  const launch = Launch.buildEnvironment(settings, installation, "/data/game", "/data/game/bottle", { baseEnvironment: { WINEPREFIX: "/original", WINEDLLOVERRIDES: "bad=n", PATH: "/usr/bin" } });
  assert.equal(launch.environment.WINEPREFIX, "/data/game/bottle");
  assert.equal(launch.overrides.CX_GRAPHICS_BACKEND, "dxmt");
  assert.equal(launch.overrides.WINEMSYNC, "1");
  assert.equal(launch.overrides.LC_ALL, "ja_JP.UTF-8");
  assert.equal(launch.dll, "winhttp=n,b");
  assert.match(Launch.wineEnvironmentString(launch.overrides), /'CUSTOM_TITLE=it'"'"'s a game; \$\(echo nope\)'/);
  assert.throws(() => Launch.parseEnvironment(["WINEPREFIX=/elsewhere"]), /cannot replace/);
  assert.throws(() => Launch.parseEnvironment(["MISSING_EQUALS"]), /NAME=value/);
  assert.equal(Launch.dllOverrides({}), "");
  assert.equal(Launch.dllOverrides({ dllOverrides: ["winhttp=b"], bepInExWinhttp: true }), "winhttp=b");
  assert.equal(Launch.dllOverrides({ dllOverrides: ["winhttp,wininet=b"], bepInExWinhttp: true }), "winhttp,wininet=b");
  assert.equal(Launch.dllOverrides({ dllOverrides: ["WINHTTP.dll=b"], bepInExWinhttp: true }), "WINHTTP.dll=b");
  assert.equal(Launch.dllOverrides({ dllOverrides: ["*=b"], bepInExWinhttp: true }), "*=b");
  assert.throws(() => Launch.dllOverrides({ dllOverrides: ["winhttp=n;anything"] }), /library=order/);
});

test("CrossOver preserves a missing explicit application selection until it is restored or changed", t => {
  const directory = fixture(t), userDataDir = path.join(directory, "data");
  Manager.__test.writeRegistry(userDataDir, { applications: [], ignoredPaths: Manager.__test.AUTOMATIC_PATHS });
  const first = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "First.app"), "25.0") });
  const second = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "Second.app")) });
  const settings = { runtimes: { crossover: { defaultVersion: second.version } } };
  const entry = { runtimeData: { crossover: { version: first.version } } };
  fs.renameSync(first.appPath, first.appPath + ".moved");
  const missing = Manager.resolveSelection(entry, settings, userDataDir);
  assert.equal(missing.version, first.version);
  assert.equal(missing.ready, false, "a missing saved app must not silently switch to another bottle");
  assert.match(missing.reason, /current location/);
  assert.equal(Manager.getState({ userDataDir }).installed.find(item => item.version === first.version).ready, false);
  fs.renameSync(first.appPath + ".moved", first.appPath);
  app(first.appPath, "26.3");
  const restored = Manager.resolveSelection(entry, settings, userDataDir);
  assert.equal(restored.version, first.version);
  assert.equal(restored.install.upstreamVersion, "26.3");
  assert.equal(restored.ready, true);
});

test("CrossOver rejects invalid launch options before creating game data or a bottle", async t => {
  const directory = fixture(t), userDataDir = path.join(directory, "data"), game = path.join(directory, "game");
  pe(path.join(game, "Game.exe"));
  const installed = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "CrossOver.app")) });
  const entry = Detection.decorateEntry({ gameId: "invalidoptions", gamePath: game, moduleId: "rgss" });
  let calls = 0;
  for (const runtimeSettings of [
    { bottleTemplate: "../win10_64" }, { graphicsBackend: "unknown" }, { synchronization: "unknown" },
    { environment: ["WINEPREFIX=/outside"] }, { dllOverrides: ["winhttp=n;unexpected"] },
    { arguments: ["bad\nargument"] }, { locale: "bad locale" }, { wineDebug: "bad\0debug" }
  ]) {
    await assert.rejects(Launch.prepareLaunch(entry, { userDataDir,
      settings: { runtimes: { crossover: { defaultVersion: installed.version } } }, runtimeSettings }, { run: async () => { calls++; } }));
    assert.equal(fs.existsSync(path.join(userDataDir, "games")), false);
  }
  assert.equal(calls, 0);
});

test("CrossOver app and Windows environment selections reuse separate bottles and shared private game files", async t => {
  const directory = fixture(t), userDataDir = path.join(directory, "data"), game = path.join(directory, "game");
  pe(path.join(game, "Game.exe"));
  const first = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "First.app")) });
  const second = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "Second.app")) });
  fs.mkdirSync(path.join(second.crossoverRoot, "share", "crossover", "bottle_templates", "win11_64"));
  const entry = Detection.decorateEntry({ gameId: "selections", gamePath: game, moduleId: "rgss" });
  let calls = 0;
  const run = async (_command, args) => {
    calls++;const bottle = args[args.indexOf("--bottle") + 1];
    fs.mkdirSync(bottle, { recursive: true });fs.writeFileSync(path.join(bottle, "cxbottle.conf"), "[Bottle]\n");
    fs.writeFileSync(path.join(bottle, "system.reg"), "registry");
    return { stdout: "", stderr: "" };
  };
  const launch = runtimeSettings => Launch.prepareLaunch(entry, { userDataDir, settings: {}, runtimeSettings }, { run });
  const a = await launch({ version: first.version });
  fs.writeFileSync(path.join(a.bottlePath, "saved-profile.dat"), "first app save");
  fs.writeFileSync(path.join(a.gameRoot, "Save.dat"), "shared game save");
  const b = await launch({ version: second.version });
  const c = await launch({ version: second.version, bottleTemplate: "win11_64" });
  assert.notEqual(a.bottlePath, b.bottlePath);assert.notEqual(b.bottlePath, c.bottlePath);
  assert.equal(a.gameRoot, b.gameRoot);assert.equal(b.gameRoot, c.gameRoot);
  assert.equal(fs.readFileSync(path.join(c.gameRoot, "Save.dat"), "utf8"), "shared game save");
  assert.equal((await launch({ version: first.version })).bottlePath, a.bottlePath);
  assert.equal(fs.readFileSync(path.join(a.bottlePath, "saved-profile.dat"), "utf8"), "first app save");
  assert.equal(calls, 3, "returning to a previous selection reuses its completed bottle");
  await assert.rejects(Launch.ensureBottle(first, a.bottlePath, a.directory,
    { bottleTemplate: "unsupported" }, {}, { run }), /Unsupported CrossOver Windows bottle type/);
});

test("CrossOver private files preserve original files, relaunch changes and saves across changed input roots", async t => {
  const directory = fixture(t), source = path.join(directory, "source"), managed = path.join(directory, "managed");
  pe(path.join(source, "Game.exe")); fs.writeFileSync(path.join(source, "settings.ini"), "original");
  const gameRoot = await Launch.stageGameFiles(source, managed);
  fs.writeFileSync(path.join(gameRoot, "settings.ini"), "private settings");
  fs.writeFileSync(path.join(gameRoot, "Save01.dat"), "save");
  assert.equal(await Launch.stageGameFiles(source, managed), gameRoot);
  assert.equal(fs.readFileSync(path.join(source, "settings.ini"), "utf8"), "original");
  const updated = path.join(directory, "updated"); fs.cpSync(source, updated, { recursive: true });
  fs.writeFileSync(path.join(updated, "new-file.dat"), "new");
  await Launch.stageGameFiles(updated, managed);
  assert.equal(fs.readFileSync(path.join(gameRoot, "settings.ini"), "utf8"), "private settings");
  assert.equal(fs.readFileSync(path.join(gameRoot, "Save01.dat"), "utf8"), "save");
  assert.equal(fs.readFileSync(path.join(gameRoot, "new-file.dat"), "utf8"), "new");
  fs.rmSync(gameRoot, { recursive: true }); fs.symlinkSync(source, gameRoot);
  await assert.rejects(Launch.stageGameFiles(updated, managed), /must not be aliases/);
});

test("CrossOver rejects escaping source aliases before staging game files", async t => {
  const directory = fixture(t), source = path.join(directory, "source"), managed = path.join(directory, "managed");
  pe(path.join(source, "Game.exe"));
  fs.symlinkSync("/etc/hosts", path.join(source, "escape.dat"));
  await assert.rejects(Launch.stageGameFiles(source, managed), /alias outside/);
  await assert.rejects(Launch.stageGameFiles(source, path.join(source, "private")), /outside the original/);
});

test("CrossOver updates unchanged private assets in the same source folder while preserving saves and same-size mod edits", async t => {
  const directory = fixture(t), source = path.join(directory, "source"), managed = path.join(directory, "managed");
  pe(path.join(source, "Game.exe"));
  fs.writeFileSync(path.join(source, "asset.dat"), "version one");
  fs.writeFileSync(path.join(source, "settings.ini"), "source");
  fs.writeFileSync(path.join(source, "removed.dat"), "keep this file");
  const gameRoot = await Launch.stageGameFiles(source, managed);
  const originalTimes = fs.statSync(path.join(source, "settings.ini"));
  fs.writeFileSync(path.join(gameRoot, "settings.ini"), "edited");
  fs.utimesSync(path.join(gameRoot, "settings.ini"), originalTimes.atime, originalTimes.mtime);
  fs.writeFileSync(path.join(gameRoot, "Save01.dat"), "private save");
  fs.writeFileSync(path.join(source, "asset.dat"), "version two");
  fs.writeFileSync(path.join(source, "settings.ini"), "update");
  fs.utimesSync(path.join(source, "settings.ini"), originalTimes.atime, originalTimes.mtime);
  fs.unlinkSync(path.join(source, "removed.dat"));
  fs.writeFileSync(path.join(source, "new.dat"), "new asset");
  await Launch.stageGameFiles(source, managed);
  assert.equal(fs.readFileSync(path.join(gameRoot, "asset.dat"), "utf8"), "version two");
  assert.equal(fs.readFileSync(path.join(gameRoot, "settings.ini"), "utf8"), "edited");
  assert.equal(fs.readFileSync(path.join(gameRoot, "Save01.dat"), "utf8"), "private save");
  assert.equal(fs.readFileSync(path.join(gameRoot, "removed.dat"), "utf8"), "keep this file");
  assert.equal(fs.readFileSync(path.join(gameRoot, "new.dat"), "utf8"), "new asset");
  let reads = 0;
  await Launch.stageGameFiles(source, managed, { onProgress: value => { if (value.bytesRead != null) reads++; } });
  assert.equal(reads, 0, "unchanged assets are checked without reading or hashing their contents");
});

test("CrossOver preserves differing private files when upgrading an older no-hash record", async t => {
  const directory = fixture(t), source = path.join(directory, "source"), managed = path.join(directory, "managed");
  pe(path.join(source, "Game.exe")); fs.writeFileSync(path.join(source, "settings.ini"), "original");
  const gameRoot = await Launch.stageGameFiles(source, managed);
  fs.writeFileSync(path.join(gameRoot, "settings.ini"), "private settings");
  fs.writeFileSync(path.join(managed, "game-files.json"), JSON.stringify({ sourceRoot: fs.realpathSync(source), files: 2, layoutVersion: 1 }));
  await Launch.stageGameFiles(source, managed);
  fs.writeFileSync(path.join(source, "settings.ini"), "new settings");
  await Launch.stageGameFiles(source, managed);
  assert.equal(fs.readFileSync(path.join(gameRoot, "settings.ini"), "utf8"), "private settings");
  const receipt = JSON.parse(fs.readFileSync(path.join(managed, "game-files.json")));
  assert.equal(receipt.layoutVersion, 2);
  assert.equal(receipt.files["settings.ini"].baseline, null);
});

test("CrossOver cancellation and source races leave a pending asset update retryable", async t => {
  const directory = fixture(t), source = path.join(directory, "source"), managed = path.join(directory, "managed");
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, "asset.dat"), "old asset");
  const gameRoot = await Launch.stageGameFiles(source, managed);
  fs.writeFileSync(path.join(source, "asset.dat"), "new asset");
  const controller = new AbortController();
  await assert.rejects(Launch.stageGameFiles(source, managed, { signal: controller.signal, onProgress: () => controller.abort() }), { name: "AbortError" });
  assert.equal(fs.readFileSync(path.join(gameRoot, "asset.dat"), "utf8"), "old asset");
  let changed = false;
  await assert.rejects(Launch.stageGameFiles(source, managed, { onProgress: () => {
    if (!changed) { changed = true; fs.writeFileSync(path.join(source, "asset.dat"), "raced update"); }
  } }), /original Windows game changed/);
  assert.equal(fs.readFileSync(path.join(gameRoot, "asset.dat"), "utf8"), "old asset");
  await Launch.stageGameFiles(source, managed);
  assert.equal(fs.readFileSync(path.join(gameRoot, "asset.dat"), "utf8"), "raced update");
  assert.deepEqual(fs.readdirSync(gameRoot), ["asset.dat"]);
});

test("CrossOver Play automatically creates a private bottle and launches the selected PE with explicit BepInEx overrides", async t => {
  const directory = fixture(t), userDataDir = path.join(directory, "data"), game = path.join(directory, "game");
  const original = pe(path.join(game, "Game.exe"));
  const installed = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "CrossOver.app")) });
  const entry = { ...Detection.decorateEntry({ gameId: "testgame", gamePath: game, moduleId: "rgss" }), runtimeId: "crossover" };
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const bottle = args[args.indexOf("--bottle") + 1];
    fs.mkdirSync(bottle, { recursive: true });
    fs.writeFileSync(path.join(bottle, "cxbottle.conf"), "[Bottle]\n");
    fs.writeFileSync(path.join(bottle, "system.reg"), "registry");
    return { stdout: "", stderr: "" };
  };
  const context = { userDataDir, settings: { runtimes: { crossover: { defaultVersion: installed.version } } },
    gameArguments: ["--title", "  A quoted game  ", "", "$(touch literal)", "first\nsecond"],
    runtimeSettings: { graphicsBackend: "dxvk", locale: "en_US.UTF-8", bepInExWinhttp: true, arguments: ["-windowed"] } };
  const launch = await Launch.prepareLaunch(entry, context, { run });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, installed.bottleToolPath);
  assert.equal(calls[0].options.env.WINEPREFIX, launch.bottlePath);
  assert.equal(launch.args[launch.args.indexOf("--dll") + 1], "winhttp=n,b");
  assert.ok(launch.args.includes("--wait-children"));
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--")), ["--", launch.executablePath, "-windowed", ...context.gameArguments]);
  assert.equal(calls[0].args.some(arg => context.gameArguments.includes(arg)), false, "bottle setup does not receive game arguments");
  assert.notEqual(launch.executablePath, original);
  assert.equal(entry.runtimeData.crossover.gameRoot, launch.gameRoot);
  assert.equal(Launch.runtimeDirectory(entry, context), path.join(userDataDir, "games", "testgame", "runtimes", "crossover"));
  await Launch.prepareLaunch(entry, context, { run });
  assert.equal(calls.length, 1);
  assert.deepEqual(Module.resolveSaveLocations(entry, context), { primaryDirectory: null, directories: [] });
  pe(path.join(game, "ArmGame.exe"), { machine: 0xaa64 });
  await assert.rejects(Launch.prepareLaunch(entry, { ...context, runtimeSettings: { executable: "ArmGame.exe" } }, { run }), /Windows ARM64/);
  assert.equal(calls.length, 1);
});

test("CrossOver transports trusted game effects through its vendor environment arguments after bottle setup", async t => {
  const directory = fixture(t), userDataDir = path.join(directory, "data"), game = path.join(directory, "game");
  pe(path.join(game, "Game.exe"), { machine: 0x8664 });
  const application = app(path.join(directory, "CrossOver.app"));
  const libraryRoot = path.join(application, "Contents/SharedSupport/CrossOver/lib/dxmt/x86_64-windows");
  fs.mkdirSync(libraryRoot, { recursive: true });
  for (const name of ["nvapi64", "nvngx"]) fs.writeFileSync(path.join(libraryRoot, name + ".dll"), Buffer.alloc(256));
  const installed = Manager.importRuntime({ userDataDir, runtimePath: application });
  const DLSS = require("../src/modules/crossover/dlss"), checkSelection = DLSS.checkSelection;
  t.mock.method(DLSS, "checkSelection", (settings, options) => checkSelection(settings, { ...options, arch: "arm64", macOSVersion: "26.0" }));
  const entry = Detection.decorateEntry({ gameId: "effects", gamePath: game, moduleId: "rgss" });
  const preparation = [];
  const run = async (_command, args, options) => {
    preparation.push(options.env);
    const bottle = args[args.indexOf("--bottle") + 1];
    fs.mkdirSync(bottle, { recursive: true });
    fs.writeFileSync(path.join(bottle, "cxbottle.conf"), "[Bottle]\n");
    fs.writeFileSync(path.join(bottle, "system.reg"), "registry");
    return { stdout: "", stderr: "" };
  };
  const context = { userDataDir, settings: {}, runtimeSettings: { version: installed.version } };
  const disabled = await Launch.prepareLaunch(entry, { ...context, applyGameEnvironment: async env => env }, { run });
  assert.equal(disabled.environment.RESHADE_CONFIG, undefined);
  const graphicsFlags = { DXMT_ENABLE_NVEXT: "0", D3DM_ENABLE_METALFX: "0" };
  assert.equal(disabled.args[disabled.args.indexOf("--env") + 1], Launch.wineEnvironmentString(graphicsFlags));
  const effect = { DYLD_INSERT_LIBRARIES: "/owned/effects/quoted ' library.dylib", RESHADE_CONFIG: "/owned/game/ReShade.ini" };
  const loader = path.join(directory, "private graphics loader");let loaderPreparations = 0;
  t.mock.method(require("../src/modules/crossover/runtime/graphics-loader"), "prepare", async (installation, owned) => {
    loaderPreparations++;assert.equal(installation.loaderPath, installed.loaderPath);
    assert.equal(owned, disabled.directory);assert.equal(preparation.length, 1);return loader;
  });
  const loaderEnvironment = { WINELOADER: loader, CX_WINELOADER: loader };
  const enabled = await Launch.prepareLaunch(entry, { ...context, applyGameEnvironment: async env => {
    assert.equal(preparation.length, 1, "bottle preparation completes without effect injection");
    return { ...env, ...effect };
  } }, { run });
  assert.equal(preparation[0].RESHADE_CONFIG, undefined);
  assert.equal(enabled.environment.RESHADE_CONFIG, effect.RESHADE_CONFIG);
  assert.equal(enabled.environment.DYLD_INSERT_LIBRARIES, effect.DYLD_INSERT_LIBRARIES);
  assert.equal(enabled.args[enabled.args.indexOf("--env") + 1], Launch.wineEnvironmentString({ ...graphicsFlags, ...effect, ...loaderEnvironment }));
  assert.equal(enabled.environment.WINELOADER, loader);assert.equal(enabled.environment.CX_WINELOADER, loader);
  assert.equal(enabled.bottlePath, disabled.bottlePath, "enabling effects retains the Windows environment and saves");
  const temporalEffect = { ...effect, RESHADE_TEMPORAL_CONTROL_FILE: "/owned/game/temporal-controls.bin", RESHADE_TEMPORAL_METHOD: "metalfx" };
  const temporalPlan = method => ({schema: 2, mode: "advanced", enabled: true, video: [{id: "scene", kind: "temporal", enabled: true, method, settings: {}}]});
  entry.effects = temporalPlan("metalfx");
  const temporal = await Launch.prepareLaunch(entry, { ...context,
    applyGameEnvironment: async env => ({ ...env, ...temporalEffect }) }, { run });
  assert.equal(temporal.environment.DXMT_ENABLE_NVEXT, "1");
  assert.equal(temporal.environment.RESHADE_TEMPORAL_CONTROL_FILE, temporalEffect.RESHADE_TEMPORAL_CONTROL_FILE);
  assert.equal(temporal.args[temporal.args.indexOf("--env") + 1], Launch.wineEnvironmentString({ ...graphicsFlags, DXMT_ENABLE_NVEXT: "1", ...temporalEffect, ...loaderEnvironment }));
  assert.equal(temporal.bottlePath, disabled.bottlePath);
  assert.equal(preparation.length, 1, "temporal selection reuses the existing private bottle");
  assert.equal(loaderPreparations, 2);
  const Temporal = require("../src/modules/crossover/temporal"), inputs = { cameraProjection: true, source: "streamline", methods: ["fsr2", "fsr3"] };
  t.mock.method(Temporal, "resolvePlan", () => ({ libraries: [], inputs }));t.mock.method(Temporal, "prepareGame", () => true);
  const cameraContext = { ...context, runtimeSettings: { ...context.runtimeSettings, graphicsBackend: "dxmt", dllOverrides: ["winhttp=n,b"] },
    applyGameEnvironment: async env => { assert.deepEqual(cameraContext.graphicsInputs, { ...inputs, architecture: installed.architectures[0] });return { ...env, ...effect }; } };
  entry.effects = temporalPlan("fsr2");
  const camera = await Launch.prepareLaunch(entry, cameraContext, { run });
  assert.equal(camera.environment.CX_GRAPHICS_BACKEND, "wined3d", "private DXMT bypasses vendor renderer redirection");
  assert.equal(camera.environment.DXMT_ENABLE_NVEXT, "1");
  assert.equal(camera.environment.WINEDLLPATH.split(path.delimiter)[0], path.resolve(path.dirname(loader), "../lib/wine/x86_64-windows"));
  assert.equal(camera.environment.WINEDLLOVERRIDES, "winhttp=n,b;d3d10core,d3d11,dxgi,winemetal,nvapi64,nvngx=b");
  assert.equal(camera.args[camera.args.indexOf("--dll") + 1], camera.environment.WINEDLLOVERRIDES);
  assert.match(camera.args[camera.args.indexOf("--env") + 1], /MACLAUNCHER_DXMT_BASE_LIBRARY=/);
  assert.equal(camera.bottlePath, disabled.bottlePath);assert.equal(preparation.length, 1);
});

test("CrossOver loader failure preserves ordinary vendor launch, Steam and final game environment", async t => {
  const directory = fixture(t), userDataDir = path.join(directory, 'data'), game = path.join(directory, 'game');
  const original = pe(path.join(game, 'Game.exe'), {machine: 0x8664});
  const installed = Manager.importRuntime({userDataDir, runtimePath: app(path.join(directory, 'CrossOver.app'))});
  const entry = {...Detection.decorateEntry({gameId: 'loader-fallback', gamePath: game, moduleId: 'rgss'}), runtimeId: 'crossover'};
  const settings = {version: installed.version, graphicsBackend: 'dxmt', dllOverrides: ['winhttp=n,b'], arguments: ['-windowed']};
  const context = {userDataDir, settings: {}, runtimeSettings: settings, gameArguments: ['--title', 'quoted argument']};
  let bottles = 0;
  const ready = await Launch.prepareLaunch(entry, context, {run: async (_command, args) => {
    bottles++;const bottle = args[args.indexOf('--bottle') + 1];fs.mkdirSync(bottle, {recursive: true});
    fs.writeFileSync(path.join(bottle, 'cxbottle.conf'), '[Bottle]\n');fs.writeFileSync(path.join(bottle, 'system.reg'), 'registry');
    return {stdout: '', stderr: ''};
  }});
  settings.environment = ['DYLD_INSERT_LIBRARIES=/Steam/shim.dylib:/Required/camera.dylib', 'STEAM_DYLD_INSERT_LIBRARIES=/Steam/shim.dylib', 'CUSTOM=kept'];
  const requested = structuredClone(settings), graphics = {DYLD_INSERT_LIBRARIES: '/Shared/libreshade-macos.dylib',
    RESHADE_EFFECT_PLAN: '/Shared/plan.json', RESHADE_LIVE_EFFECTS: '/Shared/effects'};
  const warnings = [], calls = [];
  context.logger = {warn: (...args) => warnings.push(args)};
  context.getGameEffectsEnvironment = async () => graphics;
  context.applyGameEnvironment = async base => require('../src/modules/shared/reshade').mergeEnvironment(base, graphics);
  context.spawnDetachedChecked = async (command, args, options) => {
    calls.push({command, args, options: {...options, env: await context.applyGameEnvironment(options.env)}});return {pid: 123};
  };
  let preparations = 0;
  t.mock.method(require('../src/modules/crossover/runtime/graphics-loader'), 'prepare', async () => {
    preparations++;throw new Error('Private loader checksum changed');
  });
  assert.equal((await Module.launchRuntime('crossover', entry, context)).pid, 123);
  assert.equal(preparations, 1);assert.equal(bottles, 1);assert.equal(calls.length, 1);
  const {command, args, options} = calls[0];
  assert.equal(command, '/bin/sh');assert.equal(args[2], 'maclauncher-crossover');assert.equal(args[3], installed.executablePath);assert.equal(args[4], installed.serverPath);
  assert.equal(options.cwd, ready.gameRoot);assert.equal(options.env.CX_GRAPHICS_BACKEND, 'dxmt');
  assert.equal(options.env.DYLD_INSERT_LIBRARIES, '/Steam/shim.dylib:/Required/camera.dylib');
  assert.ok(options.env.STEAM_DYLD_INSERT_LIBRARIES.includes('/Steam/shim.dylib'));
  assert.doesNotMatch(options.env.STEAM_DYLD_INSERT_LIBRARIES, /libreshade/);
  for (const key of ['RESHADE_EFFECT_PLAN', 'RESHADE_LIVE_EFFECTS', 'WINELOADER', 'CX_WINELOADER']) assert.equal(options.env[key], undefined);
  assert.equal(options.env.CUSTOM, 'kept');assert.equal(options.env.WINEDLLOVERRIDES, 'winhttp=n,b');
  assert.equal(options.env.WINEPREFIX, ready.bottlePath);
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', ready.executablePath, '-windowed', ...context.gameArguments]);
  assert.doesNotMatch(args[args.indexOf('--env') + 1], /libreshade|RESHADE_EFFECT_PLAN/);
  assert.match(warnings[0][0], /vendor renderer without shared graphics/);
  assert.deepEqual(settings, requested);assert.deepEqual(fs.readFileSync(original), fs.readFileSync(ready.executablePath));
});

test("CrossOver loader failure disables only optional camera adaptation before any new DLL swap", async t => {
  const directory = fixture(t), userDataDir = path.join(directory, 'data'), game = path.join(directory, 'game');
  pe(path.join(game, 'Game.exe'), {machine: 0x8664});const source = path.join(game, 'sl.interposer.dll');fs.writeFileSync(source, 'original Streamline');
  const installed = Manager.importRuntime({userDataDir, runtimePath: app(path.join(directory, 'CrossOver.app'))});
  const entry = {...Detection.decorateEntry({gameId: 'camera-loader-fallback', gamePath: game}), runtimeId: 'crossover'};
  const context = {userDataDir, settings: {}, runtimeSettings: {version: installed.version, graphicsBackend: 'dxmt'}};
  let bottles = 0;
  const run = async (_command, args) => {bottles++;const bottle = args[args.indexOf('--bottle') + 1];fs.mkdirSync(bottle, {recursive: true});
    fs.writeFileSync(path.join(bottle, 'cxbottle.conf'), '[Bottle]\n');fs.writeFileSync(path.join(bottle, 'system.reg'), 'registry');return {stdout: '', stderr: ''};};
  const original = await Launch.prepareLaunch(entry, context, {run}), Temporal = require('../src/modules/crossover/temporal');
  const Streamline = require('../src/modules/crossover/temporal/streamline'), crypto = require('node:crypto');
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(original.gameRoot, Streamline.ORIGINAL), 'original Streamline');
  fs.writeFileSync(path.join(original.gameRoot, 'sl.interposer.dll'), 'old owned proxy');
  fs.writeFileSync(path.join(original.gameRoot, Streamline.RECORD), JSON.stringify({schema: 1, sourceSha256: sha('original Streamline'), proxySha256: sha('old owned proxy')}));
  entry.effects = {schema: 2, mode: 'advanced', enabled: true, video: [{id: 'scene', kind: 'temporal', enabled: true, method: 'fsr2', settings: {}}]};const saved = structuredClone(entry.effects);
  t.mock.method(Temporal, 'resolvePlan', () => ({libraries: [{relativePath: 'sl.interposer.dll', sourcePath: source}], inputs: {cameraProjection: true, source: 'streamline', methods: ['fsr2']}}));
  t.mock.method(Temporal, 'prepareGame', () => assert.fail('a failed loader cannot install another camera DLL'));
  const Loader = require('../src/modules/crossover/runtime/graphics-loader');let attempts = 0;
  t.mock.method(Loader, 'prepare', async () => {attempts++;throw new Error('Signing failed');});
  const graphics = {DYLD_INSERT_LIBRARIES: '/Shared/libreshade-macos.dylib', RESHADE_TEMPORAL_METHOD: 'fsr2'};
  context.getGameEffectsEnvironment = async () => graphics;
  context.applyGameEnvironment = async base => {
    assert.deepEqual(context.graphicsInputs, {architecture: installed.architectures[0]});
    return require('../src/modules/shared/reshade').mergeEnvironment(base, graphics);
  };
  const launch = await Launch.prepareLaunch(entry, context, {run});
  assert.equal(attempts, 1);assert.equal(launch.bottlePath, original.bottlePath);
  assert.equal(launch.environment.CX_GRAPHICS_BACKEND, 'dxmt');assert.equal(launch.environment.DXMT_ENABLE_NVEXT, '0');
  for (const key of ['DYLD_INSERT_LIBRARIES', 'RESHADE_TEMPORAL_METHOD', 'MACLAUNCHER_DXMT_BASE_LIBRARY', 'WINELOADER']) assert.equal(launch.environment[key], undefined);
  assert.equal(fs.readFileSync(path.join(launch.gameRoot, 'sl.interposer.dll'), 'utf8'), 'original Streamline');
  assert.equal(fs.existsSync(path.join(launch.gameRoot, Streamline.ORIGINAL)), false);assert.equal(fs.readFileSync(source, 'utf8'), 'original Streamline');
  assert.equal(fs.readFileSync(path.join(original.gameRoot, 'sl.interposer.dll'), 'utf8'), 'old owned proxy', 'legacy leaves are not rewritten to make optional fallback safe');
  assert.equal(fs.readFileSync(path.join(original.gameRoot, Streamline.ORIGINAL), 'utf8'), 'original Streamline');
  assert.deepEqual(entry.effects, saved);
  for (const marker of [{name: 'AbortError'}, {code: 'ABORT_ERR'}]) {
    const abort = Object.assign(new Error('Cancelled'), marker);
    Loader.prepare.mock.mockImplementation(async () => {throw abort;});
    await assert.rejects(Launch.prepareLaunch(entry, context, {run}), error => error === abort);
  }
  await assert.rejects(Launch.prepareLaunch(entry, {...context, runtimeSettings: {...context.runtimeSettings, executable: '../other.exe'}}, {run}), /PE executable inside/);
  // A camera DLL error does not discard an otherwise usable shared loader.
  Temporal.prepareGame.mock.mockImplementation(() => {throw new Error('Private camera DLL copy failed');});
  Loader.prepare.mock.mockImplementation(async (_install, _directory, options) => path.join(directory, options.cameraBridge ? 'camera' : 'shared', 'bin/wineloader'));
  const crt = {DYLD_INSERT_LIBRARIES: graphics.DYLD_INSERT_LIBRARIES, RESHADE_EFFECT: '/Shared/crt.fx'}, warnings = [];
  const recovered = await Launch.prepareLaunch(entry, {...context,
    logger: {warn: (...args) => warnings.push(args)}, getGameEffectsEnvironment: async () => crt,
    applyGameEnvironment: async base => require('../src/modules/shared/reshade').mergeEnvironment(base, crt)}, {run});
  assert.equal(recovered.environment.DYLD_INSERT_LIBRARIES, crt.DYLD_INSERT_LIBRARIES);
  assert.equal(recovered.environment.RESHADE_EFFECT, crt.RESHADE_EFFECT);
  assert.equal(recovered.environment.WINELOADER, path.join(directory, 'shared/bin/wineloader'));
  assert.equal(recovered.environment.CX_GRAPHICS_BACKEND, 'dxmt');assert.equal(recovered.environment.MACLAUNCHER_DXMT_BASE_LIBRARY, undefined);
  assert.match(warnings[0][1], /Private camera DLL copy failed/);assert.deepEqual(entry.effects, saved);
  for (const warn of [() => {throw Error('logger failed');}, () => Promise.reject(Error('logger rejected'))]) {
    const fallback = await Launch.prepareLaunch(entry, {...context, logger: {warn}}, {run});
    assert.equal(fallback.environment.CX_GRAPHICS_BACKEND, 'dxmt');assert.equal(fallback.environment.MACLAUNCHER_DXMT_BASE_LIBRARY, undefined);assert.deepEqual(entry.effects, saved);
  }
  const restoration = Object.assign(new Error('Original DLL could not be restored'), {code: 'STREAMLINE_RESTORE_FAILED'});
  Temporal.prepareGame.mock.mockImplementation(() => {throw restoration;});
  const preserved = [source, original.executablePath, ...['sl.interposer.dll', Streamline.ORIGINAL, Streamline.RECORD].map(name => path.join(original.gameRoot, name))]
    .map(file => [file, fs.readFileSync(file)]);
  await assert.rejects(Launch.prepareLaunch(entry, {...context,
    applyGameEnvironment: async base => require('../src/modules/shared/reshade').mergeEnvironment(base, crt), getGameEffectsEnvironment: async () => crt}, {run}),
  error => error === restoration && error.code === 'STREAMLINE_RESTORE_FAILED');
  for (const [file, bytes] of preserved) assert.deepEqual(fs.readFileSync(file), bytes, 'failed rollback preserves ' + file);
  assert.deepEqual(entry.effects, saved, 'failed rollback leaves the saved effects selected');
  assert.equal(bottles, 1, 'failed rollback does not replace the existing Windows bottle');
  await new Promise(setImmediate);
});

test("CrossOver launch retries unavailable optional temporal inputs but retains vendor validation", async t => {
  const directory = fixture(t), userDataDir = path.join(directory, 'data'), game = path.join(directory, 'game');
  pe(path.join(game, 'Game.exe'), {machine: 0x8664});
  const installed = Manager.importRuntime({userDataDir, runtimePath: app(path.join(directory, 'CrossOver.app'))});
  const entry = {...Detection.decorateEntry({gameId: 'optional-temporal', gamePath: game}), runtimeId: 'crossover',
    effects: {schema: 2, mode: 'advanced', enabled: true, video: [{id: 'scene', kind: 'temporal', enabled: true, method: 'fsr2', settings: {}}]}};
  const warnings = [], context = {userDataDir, settings: {}, runtimeSettings: {version: installed.version, graphicsBackend: 'dxvk'},
    logger: {warn: (...args) => warnings.push(args)}};
  t.mock.method(require('../src/modules/crossover/runtime/graphics-loader'), 'prepare', () => assert.fail('no graphics injection is requested'));
  const run = async (_command, args) => {const bottle = args[args.indexOf('--bottle') + 1];fs.mkdirSync(bottle, {recursive: true});
    fs.writeFileSync(path.join(bottle, 'cxbottle.conf'), '[Bottle]\n');fs.writeFileSync(path.join(bottle, 'system.reg'), 'registry');return {stdout: '', stderr: ''};};
  const launch = await Launch.prepareLaunch(entry, context, {run});
  assert.equal(launch.environment.CX_GRAPHICS_BACKEND, 'dxvk');assert.equal(launch.environment.WINEDXVK, '1');
  assert.equal(launch.environment.DXMT_ENABLE_NVEXT, '0');assert.equal(launch.environment.D3DM_ENABLE_METALFX, '0');
  assert.equal(entry.effects.video[0].method, 'fsr2');assert.match(warnings[0][0], /temporal integration is unavailable/);
  assert.deepEqual(context.graphicsInputs, {architecture: installed.architectures[0]});
  for (const warn of [() => {throw Error('warning sink failed');}, () => Promise.reject(Error('warning sink rejected'))]) {
    const recovered = await Launch.prepareLaunch(entry, {...context, logger: {warn}}, {run});
    assert.equal(recovered.bottlePath, launch.bottlePath);assert.equal(recovered.environment.WINEDXVK, '1');assert.equal(entry.effects.video[0].method, 'fsr2');
  }
  await new Promise(setImmediate);
  await assert.rejects(Launch.prepareLaunch(entry, {...context, runtimeSettings: {...context.runtimeSettings, dllOverrides: ['invalid override']}}, {run}), /DLL overrides must use/);
  assert.throws(() => Launch.buildEnvironment({graphicsBackend: 'dxvk', dlss: true}, installed, launch.directory, launch.bottlePath,
    {executableArchitecture: 'x86_64'}), /MetalFX Temporal requires DXMT or D3DMetal/);
});

test("CrossOver Stop terminates an independently grouped Windows process before its tracked supervisor exits", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const directory = fixture(t), pidFile = path.join(directory, "game-pid"), stoppedFile = path.join(directory, "bottle-stopped");
  const argumentsFile = path.join(directory, "game-arguments.json");
  const gameArguments = ["--bottle", "private bottle", "--", "C:\\Game.exe", "--title", "  A quoted game  ", "", "$(touch unexpected)", "first\nsecond"];
  const fakeWine = path.join(directory, "wine"), fakeServer = path.join(directory, "wineserver");
  fs.writeFileSync(fakeWine, `#!${process.execPath}\nconst fs=require('fs'),{spawn}=require('child_process');fs.writeFileSync(process.env.GAME_ARGUMENTS,JSON.stringify(process.argv.slice(2)));const game=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.GAME_PID,String(game.pid));setInterval(()=>{},1000);`, { mode: 0o755 });
  fs.writeFileSync(fakeServer, `#!${process.execPath}\nconst fs=require('fs');if(process.argv[2]==='-k'){const pid=Number(fs.readFileSync(process.env.GAME_PID,'utf8'));try{process.kill(pid,'SIGTERM')}catch{}fs.writeFileSync(process.env.STOPPED,'stopped');}`, { mode: 0o755 });
  const child = spawn("/bin/sh", ["-c", Launch.SUPERVISOR, "test-crossover", fakeWine, fakeServer, ...gameArguments],
    { detached: true, stdio: "ignore", env: { ...process.env, GAME_PID: pidFile, STOPPED: stoppedFile, GAME_ARGUMENTS: argumentsFile } });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  const finished = once(child, "exit");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(pidFile));
  assert.deepEqual(JSON.parse(fs.readFileSync(argumentsFile, "utf8")), gameArguments);
  const gamePid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(gamePid, "SIGKILL"); } catch {} });
  assert.equal(stopProcessTree(child.pid), true);
  const outcome = await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error("CrossOver supervisor did not stop")), 5000).unref())]);
  assert.equal(outcome[0], 143);
  assert.equal(fs.readFileSync(stoppedFile, "utf8"), "stopped");
  const exitDeadline = Date.now() + 3000;
  while (Date.now() < exitDeadline) {
    try { process.kill(gamePid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Windows process survived CrossOver Stop");
});

test("CrossOver removes failed initial environments and retries without deleting completed bottles", async t => {
  const directory = fixture(t), runtimePath = app(path.join(directory, "CrossOver.app"));
  const install = Manager.core.inspectApplication(runtimePath), bottle = path.join(directory, "bottles", "game");
  let calls = 0;
  const run = async () => {
    calls++;
    fs.mkdirSync(bottle, { recursive: true });
    fs.writeFileSync(path.join(bottle, "cxbottle.conf"), "config");
    fs.writeFileSync(path.join(bottle, "system.reg"), "registry");
    if (calls === 1) throw new Error("interrupted creation");
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(Launch.ensureBottle(install, bottle, directory, {}, {}, { run }), /could not create/);
  assert.equal(fs.existsSync(bottle), false);
  await Launch.ensureBottle(install, bottle, directory, {}, {}, { run });
  fs.writeFileSync(path.join(bottle, "saved-game.dat"), "save");
  await Launch.ensureBottle(install, bottle, directory, {}, {}, { run });
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(path.join(bottle, "saved-game.dat"), "utf8"), "save");
});

test("CrossOver cancelled preparation waits until independently grouped Wine children have stopped", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const directory = fixture(t), pidFile = path.join(directory, "child-pid"), stopped = path.join(directory, "stopped");
  const command = path.join(directory, "cxbottle"), server = path.join(directory, "wineserver");
  fs.writeFileSync(command, `#!${process.execPath}\nconst fs=require('fs'),{spawn}=require('child_process');let c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.CHILD_PID,String(c.pid));setInterval(()=>{},1000);`, { mode: 0o755 });
  fs.writeFileSync(server, `#!${process.execPath}\nconst fs=require('fs');if(process.argv[2]==='-k'){try{process.kill(Number(fs.readFileSync(process.env.CHILD_PID,'utf8')),'SIGTERM')}catch{}fs.writeFileSync(process.env.STOPPED,'yes');}`, { mode: 0o755 });
  const controller = new AbortController();
  const preparing = Launch.runSupervised(command, server, [], { cwd: directory, env: { ...process.env, CHILD_PID: pidFile, STOPPED: stopped }, signal: controller.signal, timeout: 5000 });
  const rejected = assert.rejects(preparing, { name: "AbortError" });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  controller.abort(); await rejected;
  assert.equal(fs.readFileSync(stopped, "utf8"), "yes");
  const exited = Date.now() + 3000;
  while (Date.now() < exited) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Wine child survived cancelled preparation");
});
