const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { stopProcessTree } = require("../src/core/process-stop");
const { untilTestEnds } = require("./helpers/fixture-process");
const Detection = require("../src/modules/crossover/detect");
const Module = require("../src/modules/crossover/main");
const Manager = require("../src/modules/crossover/runtime/manager");
const Launch = require("../src/modules/crossover/runtime/launch");
const Sikarugir = require("../src/modules/crossover/sikarugir/provider");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-crossover-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function heldFileTimes(t, roots) {
  for (const method of ["stat", "lstat"]) {
    const original = fs.promises[method];
    t.mock.method(fs.promises, method, async (file, ...args) => {
      const info = await original(file, ...args), root = [...roots.keys()].sort((a, b) => b.length - a.length).find(root => String(file).startsWith(root + path.sep));
      if (root && info && typeof info.ctimeMs === "number") {info.ctimeMs = roots.get(root);info.mtimeMs = 1700000000000;}
      return info;
    });
  }
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
  assert.equal(Detection.detectGame({ rootDir: game, inputPath: game, stat: fs.statSync(game) }), null, "an uninstaller never identifies a Windows game");
  assert.equal(Detection.detectGame({ rootDir: game, inputPath: helper, stat: fs.statSync(helper) }).moduleData.executablePath, helper);
  const selected = pe(path.join(game, "Quest.exe"));
  assert.equal(Detection.detectGame({ rootDir: game, inputPath: game, stat: fs.statSync(game) }).moduleData.executablePath, selected);
  assert.equal(Detection.detectGame({ rootDir: game, inputPath: nested, stat: fs.statSync(nested) }).moduleData.executablePath, nested);
});

test("Windows publisher launch entries follow deliberate files and precede fresh module and cached evidence", t => {
  const directory = fs.realpathSync(fixture(t)), root = path.join(directory, "Release");
  const game = pe(path.join(root, "Game.exe")), moduleLauncher = pe(path.join(root, "ModuleLauncher.exe"));
  const publisher = pe(path.join(root, "bin/Publisher.exe"), { machine: 0x8664 }), user = pe(path.join(root, "User.exe"));
  const outside = pe(path.join(directory, "Outside.exe"), { machine: 0x8664 });
  fs.symlinkSync(path.relative(root, outside), path.join(root, "Escape.exe"));
  fs.writeFileSync(path.join(root, "Invalid.exe"), "not an executable");
  const receiptPath = path.join(root, ".maclauncher-steam.json"), metadata = {
    schema: 1, appId: 123, name: "Publisher game", platform: "windows", complete: true, path: root, importPath: root,
    branch: "public", architecture: "all", depots: []
  };
  const receipt = value => fs.writeFileSync(receiptPath, typeof value === "string" ? value : JSON.stringify({ ...metadata, ...value }));
  const entry = { name: "Publisher game", moduleId: "mages", gamePath: game, contentRootDir: root, importPath: root,
    moduleData: { executablePath: moduleLauncher }, runtimeData: { crossover: {
      detectionComplete: true, windowsExecutablePath: game, executableArchitecture: "x86", sourceRoot: root } } };
  const original = structuredClone(entry), bytes = new Map([game, moduleLauncher, publisher, user, outside].map(file => [file, fs.readFileSync(file)]));
  assert.equal(Detection.findWindowsExecutable(entry).windowsExecutablePath, moduleLauncher, "fresh module evidence replaces a former generic Game.exe choice");
  receipt({ defaultWindowsLaunch: { executable: "bin/Publisher.exe" } });
  const selected = Detection.findWindowsExecutable(entry);
  assert.equal(selected.windowsExecutablePath, publisher); assert.equal(selected.executableArchitecture, "x86_64");
  assert.equal(Detection.decorateEntry(entry).runtimeData.crossover.windowsExecutablePath, publisher);
  assert.equal(Detection.findWindowsExecutable(entry, { selectedPath: user }).windowsExecutablePath, user);
  assert.equal(Detection.findWindowsExecutable({ ...entry, importPath: user }).windowsExecutablePath, user);
  assert.equal(Detection.findWindowsExecutable({ ...entry, importPath: game }).windowsExecutablePath, game, "an explicitly imported former executable remains deliberate");
  for (const [name, value] of [
    ["old receipt without launch data", {}], ["malformed receipt", "{"],
    ["missing executable", { defaultWindowsLaunch: { executable: "bin/Missing.exe" } }],
    ["invalid executable", { defaultWindowsLaunch: { executable: "Invalid.exe" } }],
    ["invalid field", { defaultWindowsLaunch: { executable: 42 } }],
    ["parent traversal", { defaultWindowsLaunch: { executable: "../Outside.exe" } }],
    ["absolute external path", { defaultWindowsLaunch: { executable: outside } }],
    ["escaping executable alias", { defaultWindowsLaunch: { executable: "Escape.exe" } }]
  ]) {
    receipt(value);
    assert.equal(Detection.findWindowsExecutable(entry).windowsExecutablePath, moduleLauncher, `${name} leaves current module evidence available`);
  }
  fs.rmSync(receiptPath);
  assert.equal(Detection.findWindowsExecutable(entry).windowsExecutablePath, moduleLauncher, "a missing optional receipt leaves ordinary selection available");
  assert.deepEqual(entry, original, "reading launch evidence does not rewrite saved entry data");
  for (const [file, contents] of bytes) assert.deepEqual(fs.readFileSync(file), contents);
});

test("Windows publisher launch entries resolve generic folders and remain reachable from nested module roots", t => {
  const directory = fs.realpathSync(fixture(t)), root = path.join(directory, "Downloaded");
  const game = pe(path.join(root, "Game.exe")), user = pe(path.join(root, "User.exe"));
  const moduleLauncher = pe(path.join(root, "content/ModuleLauncher.exe")), publisher = pe(path.join(root, "bin/Publisher.exe"), { machine: 0x8664 });
  const nestedPublisher = pe(path.join(root, "content/bin/Publisher.exe"), { machine: 0x8664 });
  const receiptPath = path.join(root, ".maclauncher-steam.json"), metadata = {
    schema: 1, appId: 123, name: "Publisher game", platform: "windows", complete: true, path: root, importPath: root,
    branch: "public", architecture: "all", depots: [], defaultWindowsLaunch: { executable: "bin/Publisher.exe" }
  };
  fs.writeFileSync(receiptPath, JSON.stringify(metadata));
  const context = { rootDir: root, inputPath: root, stat: fs.statSync(root) };
  assert.equal(Detection.detectGame(context).moduleData.executablePath, publisher, "the recorded publisher default resolves an otherwise ambiguous folder");
  assert.equal(Detection.detectGame({ ...context, inputPath: user, stat: fs.statSync(user) }).moduleData.executablePath, user);
  const content = path.join(root, "content"), entry = { name: "Publisher game", moduleId: "mages", gamePath: content, contentRootDir: content,
    importPath: root, moduleData: { executablePath: moduleLauncher }, runtimeData: { crossover: {
      detectionComplete: true, windowsExecutablePath: game, executableArchitecture: "x86", sourceRoot: root } } };
  const outsideContent = Detection.findWindowsExecutable(entry);
  assert.equal(outsideContent.windowsExecutablePath, moduleLauncher, "a root receipt cannot select a publisher executable outside the existing content root");
  assert.equal(outsideContent.sourceRoot, content);
  fs.writeFileSync(receiptPath, JSON.stringify({ ...metadata, defaultWindowsLaunch: { executable: "content/bin/Publisher.exe" } }));
  const match = Detection.findWindowsExecutable(entry);
  assert.equal(match.windowsExecutablePath, nestedPublisher); assert.equal(match.sourceRoot, content);
  const { importPath: _importPath, ...fromModule } = entry;
  const decorated = Detection.decorateEntry(fromModule, { inputPath: root });
  assert.equal(decorated.runtimeData.crossover.windowsExecutablePath, nestedPublisher,
    "Registry's existing provider inputPath makes the original receipt available without widening the game root");
  assert.equal(decorated.runtimeData.crossover.sourceRoot, content);
  const unrelated = path.join(directory, "Unrelated"); fs.mkdirSync(unrelated);
  assert.equal(Detection.findWindowsExecutable({ ...fromModule, runtimeData: {}, importPath: unrelated }).windowsExecutablePath, moduleLauncher,
    "an unrelated imported directory does not become a release root");
  fs.writeFileSync(receiptPath, JSON.stringify({ ...metadata, defaultWindowsLaunch: undefined }));
  assert.throws(() => Detection.detectGame(context), error => error.code === "DETECTION_CONFLICT", "old receipts do not guess between unrelated programs");
});

test("Windows publisher launch entries preserve saved relative executable roots in both Wine consumers", async t => {
  const directory = fs.realpathSync(fixture(t)), root = path.join(directory, "Downloaded"), content = path.join(root, "content");
  const moduleLauncher = pe(path.join(content, "ModuleLauncher.exe"));
  const publisher = pe(path.join(content, "Publisher.exe"));
  const chosen = pe(path.join(content, "bin/Chosen.exe"), { machine: 0x8664 });
  const outer = pe(path.join(root, "bin/Chosen.exe"));
  fs.writeFileSync(path.join(root, ".maclauncher-steam.json"), JSON.stringify({ schema: 1, appId: 123, name: "Publisher game",
    platform: "windows", complete: true, path: root, importPath: root, defaultWindowsLaunch: { executable: "content/Publisher.exe" } }));
  const userDataDir = path.join(directory, "profile");
  Manager.__test.writeRegistry(userDataDir, { applications: [], ignoredPaths: Manager.__test.AUTOMATIC_PATHS });
  const installed = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "CrossOver.app")) });
  const settings = { executable: "bin/Chosen.exe" }, original = structuredClone(settings);
  const entry = { gameId: "relative-executable", moduleId: "mages", gamePath: content, contentRootDir: content, importPath: root,
    moduleData: { executablePath: moduleLauncher }, runtimeId: "crossover", runtimeSettings: { crossover: settings } };
  const match = Detection.findWindowsExecutable(entry);
  assert.equal(match.windowsExecutablePath, publisher); assert.equal(match.sourceRoot, content);
  const sourceBytes = new Map([chosen, outer].map(file => [file, fs.readFileSync(file)]));
  const commands = [], run = async (command, args) => {
    commands.push(command);
    const bottle = args[args.indexOf("--bottle") + 1];
    fs.mkdirSync(bottle, { recursive: true }); fs.writeFileSync(path.join(bottle, "cxbottle.conf"), "[Bottle]\n");
    fs.writeFileSync(path.join(bottle, "system.reg"), "registry");
    return { stdout: "", stderr: "" };
  };
  const launch = await Launch.prepareLaunch(entry, { userDataDir,
    settings: { runtimes: { crossover: { defaultVersion: installed.version } } }, runtimeSettings: settings }, { run });
  assert.equal(launch.executablePath, chosen); assert.equal(launch.workingDirectory, path.dirname(chosen));
  assert.equal(launch.args[launch.args.indexOf("--") + 1], "G:\\content\\bin\\Chosen.exe", "the drive is the imported download folder");
  assert.equal(launch.windowsWorkingDirectory, "G:\\content\\bin");
  assert.equal(fs.realpathSync(path.join(launch.bottlePath, "dosdevices", "g:")), root);
  assert.equal(entry.runtimeData.crossover.sourceRoot, content);
  assert.deepEqual(commands, [installed.bottleToolPath], "preparation uses only the injected synthetic bottle command");
  const sikarugir = require("../src/modules/crossover/sikarugir/launch").executableEvidence(entry, settings);
  assert.equal(sikarugir.windowsExecutablePath, chosen); assert.equal(sikarugir.sourceRoot, content);
  assert.equal(sikarugir.executableArchitecture, "x86_64", "the same-named outer executable has the different x86 machine");
  assert.deepEqual(settings, original); assert.deepEqual(entry.runtimeSettings.crossover, original);
  for (const [file, bytes] of sourceBytes) assert.deepEqual(fs.readFileSync(file), bytes);
});

test("CrossOver maps the Unreal install folder of an executable imported alone and rejects linked layout folders", async t => {
  const directory = fs.realpathSync(fixture(t)), install = path.join(directory, "Paradise Killer"), binaries = path.join(install, "ParadiseKiller", "Binaries", "Win64");
  const executable = pe(path.join(binaries, "ParadiseKiller-Win64-Shipping.exe"), { machine: 0x8664 });
  fs.mkdirSync(path.join(install, "Engine")); fs.mkdirSync(path.join(install, "ParadiseKiller", "Content", "Paks"), { recursive: true });
  const userDataDir = path.join(directory, "profile");
  Manager.__test.writeRegistry(userDataDir, { applications: [], ignoredPaths: Manager.__test.AUTOMATIC_PATHS });
  const installed = Manager.importRuntime({ userDataDir, runtimePath: app(path.join(directory, "CrossOver.app")) });
  const run = async (_command, args) => {
    const bottle = args[args.indexOf("--bottle") + 1];
    fs.mkdirSync(bottle, { recursive: true }); fs.writeFileSync(path.join(bottle, "cxbottle.conf"), "[Bottle]\n"); fs.writeFileSync(path.join(bottle, "system.reg"), "registry");
    return { stdout: "", stderr: "" };
  };
  const entry = Detection.decorateEntry({ gameId: "unreal-executable", moduleId: "crossover", gamePath: binaries, importPath: executable });
  assert.equal(entry.runtimeData.crossover.sourceRoot, binaries);
  const launch = await Launch.prepareLaunch(entry, { userDataDir, settings: { runtimes: { crossover: { defaultVersion: installed.version } } }, runtimeSettings: {} }, { run });
  assert.equal(launch.args[launch.args.indexOf("--") + 1], "G:\\ParadiseKiller\\Binaries\\Win64\\ParadiseKiller-Win64-Shipping.exe");
  assert.equal(launch.windowsWorkingDirectory, "G:\\ParadiseKiller\\Binaries\\Win64");
  assert.equal(fs.realpathSync(path.join(launch.bottlePath, "dosdevices", "g:")), install);
  const GameDrive = require("../src/modules/crossover/game-drive");
  const outside = path.join(directory, "Outside"); fs.mkdirSync(outside);
  fs.rmdirSync(path.join(install, "Engine")); fs.symlinkSync(outside, path.join(install, "Engine"), "dir");
  assert.equal(GameDrive.gameDriveRoot({ importPath: executable }, binaries, executable), binaries, "a linked Engine folder outside the install is not layout evidence");
  const root = path.join(directory, "Ordinary"), game = pe(path.join(root, "Game.exe"));
  assert.equal(GameDrive.gameDriveRoot({ importPath: game }, root, game), root);
  assert.equal(GameDrive.gameDriveRoot({ importPath: path.join(directory, "Missing") }, root, game), root);
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
  assert.equal(Detection.supportsWindowsRuntimes({ ...entry,
    runtimeData: { crossover: { windowsExecutablePath: unrelated, executableArchitecture: "x86", sourceRoot: directory, detectionComplete: true } } }), false);
});

test("Windows runtimes follow the recorded game location, not app bundles beside a Windows build", t => {
  const directory = fixture(t);
  // A Mac-only release keeps its content inside the app bundle, so it runs as that app.
  const autorun = path.join(directory, "Novel-mac", "Novel.app", "Contents", "Resources", "autorun");
  const bundled = pe(path.join(autorun, "Novel.exe"));
  const macOnly = { name: "Novel", gamePath: path.dirname(path.dirname(path.dirname(autorun))), contentRootDir: autorun };
  assert.equal(Detection.decorateEntry(macOnly, { inputPath: macOnly.gamePath }).runtimeData.crossover.windowsExecutablePath, null);
  const forged = { ...macOnly, runtimeData: { crossover: { detectionComplete: true, windowsExecutablePath: bundled, executableArchitecture: "x86", sourceRoot: autorun } } };
  assert.equal(Detection.cachedWindowsExecutable(forged), null, "a recorded location inside an app bundle never offers Windows runtimes");
  assert.equal(Sikarugir.supportsEntry(forged), false);
  // A PC release ships a Windows executable, a Linux script and a Mac app side by side.
  const release = path.join(directory, "Novel-1.0-pc"), launcher = pe(path.join(release, "Novel.exe"));
  fs.writeFileSync(path.join(release, "Novel.sh"), "#!/bin/sh\n");
  pe(path.join(release, "Novel.app", "Contents", "Resources", "Novel.exe"));
  for (const importPath of [release, path.join(release, "Novel.sh"), launcher]) {
    const entry = Detection.decorateEntry({ name: "Novel", gamePath: release, contentRootDir: release }, { inputPath: importPath });
    assert.equal(entry.runtimeData.crossover.windowsExecutablePath, launcher, importPath);
    assert.equal(Sikarugir.supportsEntry(entry), true, importPath);
  }
  // An executable inside the app bundle does not count, even when selected.
  const inBundle = path.join(release, "Novel.app", "Contents", "Resources", "Novel.exe");
  assert.equal(Detection.findWindowsExecutable({ gamePath: release }, { selectedPath: inBundle })?.windowsExecutablePath, launcher);
});

test("Windows evidence searches the game's own folder and skips support programs", t => {
  const directory = fixture(t), find = entry => Detection.findWindowsExecutable(entry)?.windowsExecutablePath || null;
  // A data folder chosen as content root does not hide the launcher beside it.
  const quest = path.join(directory, "Quest"), launcher = pe(path.join(quest, "Quest.exe"));
  pe(path.join(quest, "data", "engine.exe")); pe(path.join(quest, "data", "UNINST.exe")); pe(path.join(quest, "Quest_v11_update.exe"));
  const evidence = Detection.findWindowsExecutable({ name: "Quest", gamePath: quest, contentRootDir: path.join(quest, "data") });
  assert.equal(evidence.windowsExecutablePath, launcher);
  assert.equal(evidence.sourceRoot, quest);
  // Uninstallers, crash handlers, redistributables and bundled interpreters are never the game.
  const helpers = path.join(directory, "Helpers");
  for (const name of ["unins000.exe", "UnityCrashHandler64.exe", "vcredist_x64.exe", "dotNetFx40_Full_setup.exe",
    "lib/py3-windows-x86_64/pythonw.exe", "lib/py3-windows-x86_64/zsync.exe", "_CommonRedist/Game.exe", "jre/bin/javaw.exe"]) pe(path.join(helpers, name));
  assert.equal(find({ gamePath: helpers }), null);
  // A setup package that detection unpacks as the game is not the game's executable.
  const packaged = path.join(directory, "Packaged"), setup = pe(path.join(packaged, "NovelSetup.exe"));
  assert.equal(find({ gamePath: setup, contentRootDir: packaged, importPath: packaged }), null);
  assert.equal(find({ gamePath: setup, contentRootDir: packaged, importPath: setup }), setup, "an imported file is a deliberate choice");
  // Configuration tools and console wrappers stay eligible but rank below the game.
  const configuration = pe(path.join(helpers, "Config.exe"));
  assert.equal(find({ gamePath: helpers }), configuration);
  pe(path.join(helpers, "Quest.console.exe"), { subsystem: 3 });
  const game = pe(path.join(helpers, "Quest.exe"));
  assert.equal(find({ name: "Quest", gamePath: helpers }), game);
  assert.equal(Detection.findWindowsExecutable({ gamePath: helpers, importPath: configuration }).windowsExecutablePath, configuration,
    "a deliberate selection still uses a helper");
});

test("Windows evidence for single-file games stays beside the file", t => {
  const directory = fixture(t), find = entry => Detection.findWindowsExecutable(entry)?.windowsExecutablePath || null;
  // A package file in a shared folder does not adopt unrelated programs.
  const shared = path.join(directory, "Downloads"), packageFile = path.join(shared, "com.example.crossy.ipa");
  fs.mkdirSync(shared); fs.writeFileSync(packageFile, "package");
  pe(path.join(shared, "Other Game", "Game.exe")); pe(path.join(shared, "Unrelated.exe"));
  const entry = { name: "Crossy Road", gamePath: packageFile, importPath: packageFile, contentRootDir: shared };
  assert.equal(find(entry), null);
  assert.equal(Detection.decorateEntry(entry, { inputPath: packageFile }).runtimeData.crossover.windowsExecutablePath, null);
  // A Windows build of the same game beside it counts.
  const build = pe(path.join(shared, "Crossy Road.exe"));
  assert.equal(find(entry), build);
  // A data file imported through its folder belongs to that folder, subfolders included.
  const folder = path.join(directory, "Runner"), data = path.join(folder, "data.win");
  const runner = pe(path.join(folder, "bin", "Runner.exe")); fs.writeFileSync(data, "FORM");
  assert.equal(find({ name: "Something Else", gamePath: data, importPath: folder, contentRootDir: folder }), runner);
  assert.equal(Detection.decorateEntry({ name: "Something Else", gamePath: data, contentRootDir: folder }, { inputPath: folder })
    .runtimeData.crossover.windowsExecutablePath, runner, "detection passes the imported folder");
  assert.equal(find({ name: "Something Else", gamePath: data, importPath: data, contentRootDir: folder }), null);
});

test("Windows runtimes follow the game's identity rather than the launcher file chosen for import", t => {
  const directory = fixture(t), root = path.join(directory, "Visual Novel");
  const executable = pe(path.join(root, "VisualNovel.exe"));
  fs.writeFileSync(path.join(root, "VisualNovel.sh"), "#!/bin/sh\n");
  const linux = path.join(root, "VisualNovel.x86_64"); fs.writeFileSync(linux, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
  const script = Detection.decorateEntry({ gamePath: root, contentRootDir: root, importPath: path.join(root, "VisualNovel.sh") });
  assert.equal(script.runtimeData.crossover.windowsExecutablePath, executable);
  assert.equal(Detection.supportsWindowsRuntimes(script), true);
  assert.equal(Sikarugir.supportsEntry(script), true);
  // A native build that is itself the game keeps its native identity.
  const native = { gamePath: linux, contentRootDir: root, importPath: linux };
  assert.equal(Detection.isNativeImport(native), true);
  assert.equal(Detection.decorateEntry(native).runtimeData.crossover.windowsExecutablePath, null);
  // Imported as a folder, the same build shares that folder with its Windows build.
  const folder = Detection.decorateEntry({ ...native, importPath: root });
  assert.equal(folder.runtimeData.crossover.windowsExecutablePath, executable);
  assert.equal(Sikarugir.supportsEntry(folder), true);
});

test("Windows runtime support reads only the recorded evidence, and Play finds renamed executables", t => {
  const directory = fixture(t), root = path.join(directory, "Game"), executable = pe(path.join(root, "Game.exe"));
  const entry = Detection.decorateEntry({ gamePath: root, contentRootDir: root, importPath: root });
  const touched = [];
  for (const name of ["statSync", "lstatSync", "readdirSync", "realpathSync", "openSync", "existsSync", "accessSync", "readFileSync"]) {
    const original = fs[name];
    t.mock.method(fs, name, function (file, ...rest) { if (String(file).startsWith(directory)) touched.push(name + " " + file); return original.call(this, file, ...rest); });
  }
  fs.renameSync(root, root + "-offline");
  assert.equal(Detection.cachedWindowsExecutable(entry)?.windowsExecutablePath, executable, "a disconnected drive keeps the recorded executable");
  assert.equal(Sikarugir.supportsEntry(entry), true);
  // An entry saved before Windows evidence existed waits for its next refresh instead of searching.
  const legacy = { gamePath: root, contentRootDir: root, importPath: root, runtimeData: {} };
  assert.equal(Detection.cachedWindowsExecutable(legacy), null);
  assert.equal(Sikarugir.supportsEntry({ ...entry, gamePath: undefined, contentRootDir: undefined,
    runtimeData: { crossover: { ...entry.runtimeData.crossover, sourceRoot: undefined } } }), false, "evidence outside any recorded folder never counts");
  assert.deepEqual(touched, [], "runtime support never reads the game's files");
  t.mock.restoreAll();
  fs.renameSync(root + "-offline", root);
  const renamed = path.join(root, "Game 1.1.exe"); fs.renameSync(executable, renamed);
  assert.equal(Detection.findWindowsExecutable(entry)?.windowsExecutablePath, renamed, "Play searches again when the recorded executable is gone");
  assert.equal(Detection.decorateEntry(legacy).runtimeData.crossover.windowsExecutablePath, renamed, "refreshing records the current executable");
});

test("CrossOver records negative Windows evidence and does not inspect Linux trees when resolving support", t => {
  const directory = fixture(t);
  const entry = Detection.decorateEntry({ gamePath: directory, moduleId: "love" });
  assert.equal(entry.runtimeData.crossover.detectionComplete, true);
  assert.equal(entry.runtimeData.crossover.windowsExecutablePath, null);
  fs.renameSync(directory, directory + "-moved");
  t.after(() => fs.rmSync(directory + "-moved", { recursive: true, force: true }));
  assert.equal(Detection.supportsWindowsRuntimes(entry), false);
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

test("CrossOver coarse application timestamps refresh plist and loader facts without changing registration", t => {
  const directory = fs.realpathSync(fixture(t)), application = app(path.join(directory, "CrossOver.app"), "25.0"), stat = fs.statSync;
  t.mock.method(fs, "statSync", (file, ...args) => {
    const info = stat(file, ...args);if (String(file).startsWith(application + path.sep)) {info.mtimeMs = 1700000000000;info.ctimeMs = 1700000000000;}return info;
  });
  const first = Manager.core.inspectApplication(application), plist = path.join(application, "Contents/Info.plist"), loader = first.loaderPath;
  const before = fs.statSync(plist);fs.writeFileSync(plist, fs.readFileSync(plist, "utf8").replace("25.0", "26.3"));
  const bytes = fs.readFileSync(loader);bytes.writeUInt32LE(0x01000007, 4);fs.writeFileSync(loader, bytes);
  const after = fs.statSync(plist);assert.deepEqual([after.ino, after.size, after.mtimeMs, after.ctimeMs], [before.ino, before.size, before.mtimeMs, before.ctimeMs]);
  const next = Manager.core.inspectApplication(application);
  assert.equal(next.version, first.version);assert.equal(next.upstreamVersion, "26.3");assert.deepEqual(next.loaderArchitectures, ["x86_64"]);
});

test("CrossOver renderer floors follow installed libraries without rejecting ordinary Wine", t => {
  const root = fixture(t), installation = { crossoverRoot: root };
  const backend = require("../src/modules/crossover/runtime/backend-support");
  const file = path.join(root, "lib64/apple_gptk/external/D3DMetal.framework/Versions/B/Resources/libdxccontainer.dylib");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x01000007, 4); bytes.writeUInt32LE(6, 12);
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x32, 32); bytes.writeUInt32LE(24, 36); bytes.writeUInt32LE(1, 40);
  bytes.writeUInt32LE((15 << 16) | (4 << 8), 44);
  fs.writeFileSync(file, bytes);
  assert.equal(backend.minimumMacOS(installation, "d3dmetal"), "15.4.0");
  const host = { hardwareArch: "arm64", macOSVersion: "15.3" };
  assert.throws(() => Launch.buildEnvironment({ graphicsBackend: "d3dmetal" }, installation, root, root, { host }), /macOS 15\.4/);
  assert.doesNotThrow(() => Launch.buildEnvironment({ graphicsBackend: "wined3d" }, installation, root, root, { host }));
  assert.doesNotThrow(() => Launch.buildEnvironment({ graphicsBackend: "auto" }, installation, root, root, { host }));
  assert.match(backend.reason(installation, "d3dmetal", { hardwareArch: "x64", macOSVersion: "27.0" }), /Apple Silicon/);
  assert.equal(backend.reason(installation, "dxmt", { hardwareArch: "x64", macOSVersion: "14.0" }), null);
  bytes.writeUInt32LE((15 << 16) | (4 << 8) | 2, 44);fs.writeFileSync(file, bytes);
  assert.match(backend.reason(installation, "d3dmetal", { hardwareArch: "arm64", macOSVersion: "15.4.1" }), /macOS 15\.4\.2/);
  assert.equal(backend.reason(installation, "d3dmetal", { hardwareArch: "arm64", macOSVersion: "15.4.2" }), null);
  assert.equal(backend.reason(installation, "d3dmetal", { hardwareArch: null, macOSVersion: null }), null,
    "unmeasured host facts do not become a negative compatibility result");
});

test("CrossOver graphics choices use the selected application's renderer requirements in game and global settings", t => {
  const root = fixture(t), userDataDir = path.join(root, "profile"), appPath = app(path.join(root, "CrossOver.app"));
  Manager.__test.writeRegistry(userDataDir, { applications: [], ignoredPaths: Manager.__test.AUTOMATIC_PATHS });
  const install = Manager.importRuntime({ userDataDir, runtimePath: appPath });
  const file = path.join(install.crossoverRoot, "lib64/apple_gptk/external/D3DMetal.framework/Versions/A/Resources/libdxccontainer.dylib");
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x01000007, 4); bytes.writeUInt32LE(6, 12);
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x32, 32); bytes.writeUInt32LE(24, 36); bytes.writeUInt32LE(1, 40);
  bytes.writeUInt32LE((15 << 16) | (4 << 8), 44);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  const entry = { runtimeId: "crossover", runtimeData: { crossover: { version: install.version } } };
  const context = { userDataDir, settings: { runtimes: { crossover: { defaultVersion: install.version } } } };
  const values = host => Module.__test.graphicsBackendOptions(entry, context, { host }).graphicsBackends.map(row => row.value);
  assert.deepEqual(values({ hardwareArch: "arm64", macOSVersion: "13.6" }), ["auto", "dxvk", "wined3d"]);
  assert.deepEqual(values({ hardwareArch: "arm64", macOSVersion: "15.3" }), ["auto", "dxmt", "dxvk", "wined3d"]);
  assert.deepEqual(values({ hardwareArch: "arm64", macOSVersion: "15.4" }), ["auto", "d3dmetal", "dxmt", "dxvk", "wined3d"]);
  assert.deepEqual(values({ hardwareArch: "x64", macOSVersion: "27.0" }), ["auto", "dxmt", "dxvk", "wined3d"]);
  // Make the requirement greater than this host to exercise the actual action
  // dispatch without replacing the machine's capability query.
  bytes.writeUInt32LE(99 << 16, 44); fs.writeFileSync(file, bytes);
  const field = Module.manifest.runtime.entries.crossover.settings.fields.find(row => row.key === "graphicsBackend");
  assert.equal(field.optionsAction, "listGraphicsBackends");
  const provider = Module.runtimeProviders.find(row => row.runtimeId === "crossover");
  for (const groups of [Module.actions[field.optionsAction](entry, {}, context),
    provider.actions[field.optionsAction](entry, {}, context), Module.settingsActions[field.optionsAction]({}, context),
    provider.settingsActions[field.optionsAction]({}, context)]) {
    assert.equal(groups[field.optionsKey].some(row => row.value === "d3dmetal"), false);
    assert.ok(groups[field.optionsKey].some(row => row.value === "auto"));
    assert.ok(groups[field.optionsKey].some(row => row.value === "wined3d"));
  }
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

test("CrossOver app changes reuse one per-game bottle while Windows templates remain separate", async t => {
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
  assert.equal(a.bottlePath, b.bottlePath);assert.notEqual(b.bottlePath, c.bottlePath);
  assert.equal(a.gameRoot, b.gameRoot);assert.equal(b.gameRoot, c.gameRoot);
  assert.equal(fs.readFileSync(path.join(c.gameRoot, "Save.dat"), "utf8"), "shared game save");
  assert.equal((await launch({ version: first.version })).bottlePath, a.bottlePath);
  assert.equal(fs.readFileSync(path.join(a.bottlePath, "saved-profile.dat"), "utf8"), "first app save");
  assert.equal(calls, 2, "CrossOver app changes reuse the existing bottle; a new Windows template has its own bottle");
  await assert.rejects(Launch.ensureBottle(first, require("../src/modules/shared/runtime/wine-environment").privateEnvironment(userDataDir, a.directory, path.relative(a.directory, a.bottlePath)), a.directory,
    { bottleTemplate: "unsupported" }, {}, { run }), /Unsupported CrossOver Windows bottle type/);
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
  const GameView = require("../src/modules/crossover/temporal/game-view");
  assert.equal(GameView.baseline, undefined);
  for (const method of ["reconcile", "remember", "watch"]) t.mock.method(GameView, method, () => assert.fail("Ordinary Play must not " + method + " a private game view"));
  const old = path.join(Launch.runtimeDirectory(entry, context), "temporal-camera", "Save01.dat");
  fs.mkdirSync(path.dirname(old), {recursive: true});fs.writeFileSync(old, "earlier private save");
  entry.runtimeData.crossover.cameraGameView = {kind: "camera", id: "old binding must not be read"};
  const launch = await Launch.prepareLaunch(entry, context, { run });
  assert.equal(fs.readFileSync(old, "utf8"), "earlier private save");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, installed.bottleToolPath);
  assert.equal(calls[0].options.env.WINEPREFIX, launch.bottlePath);
  assert.equal(launch.args[launch.args.indexOf("--dll") + 1], "winhttp=n,b");
  assert.ok(launch.args.includes("--wait-children"));
  assert.deepEqual(launch.args.slice(launch.args.indexOf("--")), ["--", launch.windowsExecutablePath, "-windowed", ...context.gameArguments]);
  assert.equal(calls[0].args.some(arg => context.gameArguments.includes(arg)), false, "bottle setup does not receive game arguments");
  assert.equal(fs.realpathSync(launch.executablePath), fs.realpathSync(original));
  assert.equal(fs.realpathSync(launch.gameRoot), fs.realpathSync(game));
  assert.equal(launch.args[launch.args.indexOf("--workdir") + 1], launch.windowsWorkingDirectory);
  assert.equal(fs.existsSync(path.join(launch.directory, "game")), false);
  assert.equal(fs.existsSync(path.join(launch.directory, "game-files.json")), false);
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
  t.mock.method(DLSS, "checkSelection", (settings, options) => checkSelection(settings, { ...options, hardwareArch: "arm64", macOSVersion: "26.0" }));
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
  const expectedEnvironment = values => {
    const {DXVK_SHADER_CACHE_PATH, ...rest} = values;
    return Launch.wineEnvironmentString({...rest, DXVK_SHADER_CACHE_PATH});
  };
  const graphicsFlags = { DXMT_ENABLE_NVEXT: "0", D3DM_ENABLE_METALFX: "0",
    MESA_SHADER_CACHE_DIR: path.join(disabled.directory, "cache", "mesa"),
    DXVK_SHADER_CACHE_PATH: disabled.environment.DXVK_SHADER_CACHE_PATH };
  assert.equal(disabled.args[disabled.args.indexOf("--env") + 1], expectedEnvironment(graphicsFlags));
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
  assert.equal(enabled.args[enabled.args.indexOf("--env") + 1], expectedEnvironment({ ...graphicsFlags, ...effect, ...loaderEnvironment }));
  assert.equal(enabled.environment.WINELOADER, loader);assert.equal(enabled.environment.CX_WINELOADER, loader);
  assert.equal(enabled.bottlePath, disabled.bottlePath, "enabling effects retains the Windows environment and saves");
  const temporalEffect = { ...effect, RESHADE_TEMPORAL_CONTROL_FILE: "/owned/game/temporal-controls.bin", RESHADE_TEMPORAL_METHOD: "metalfx" };
  const temporalPlan = method => ({schema: 2, mode: "advanced", enabled: true, video: [{id: "scene", kind: "temporal", enabled: true, method, settings: {}}]});
  entry.effects = temporalPlan("metalfx");
  const temporal = await Launch.prepareLaunch(entry, { ...context,
    applyGameEnvironment: async env => ({ ...env, ...temporalEffect }) }, { run });
  assert.equal(temporal.environment.DXMT_ENABLE_NVEXT, "1");
  assert.equal(temporal.environment.RESHADE_TEMPORAL_CONTROL_FILE, temporalEffect.RESHADE_TEMPORAL_CONTROL_FILE);
  assert.equal(temporal.args[temporal.args.indexOf("--env") + 1], expectedEnvironment({ ...graphicsFlags, DXMT_ENABLE_NVEXT: "1", ...temporalEffect, ...loaderEnvironment }));
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
  assert.equal(camera.workingDirectory, path.dirname(path.join(game, "Game.exe")));
  assert.equal(camera.args[camera.args.indexOf("--workdir") + 1], camera.windowsWorkingDirectory, "camera adaptation keeps the mapped original cwd");
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
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', ready.windowsExecutablePath, '-windowed', ...context.gameArguments]);
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
  const oldGameRoot = await require("./helpers/crossover-0.5.1-fixtures").stageGameFiles(game, original.directory);
  const Streamline = require('../src/modules/crossover/temporal/streamline'), crypto = require('node:crypto');
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(oldGameRoot, Streamline.ORIGINAL), 'original Streamline');
  fs.writeFileSync(path.join(oldGameRoot, 'sl.interposer.dll'), 'old owned proxy');
  fs.writeFileSync(path.join(oldGameRoot, Streamline.RECORD), JSON.stringify({schema: 1, sourceSha256: sha('original Streamline'), proxySha256: sha('old owned proxy')}));
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
  assert.equal(fs.readFileSync(path.join(oldGameRoot, 'sl.interposer.dll'), 'utf8'), 'old owned proxy', 'legacy leaves are not rewritten to make optional fallback safe');
  assert.equal(fs.readFileSync(path.join(oldGameRoot, Streamline.ORIGINAL), 'utf8'), 'original Streamline');
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
  const preserved = [source, original.executablePath, ...['sl.interposer.dll', Streamline.ORIGINAL, Streamline.RECORD].map(name => path.join(oldGameRoot, name))]
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
  assert.equal(launch.environment.CX_GRAPHICS_BACKEND, 'dxvk');assert.equal(launch.environment.WINEDXVK, undefined);
  assert.equal(launch.environment.DXMT_ENABLE_NVEXT, '0');assert.equal(launch.environment.D3DM_ENABLE_METALFX, '0');
  assert.equal(entry.effects.video[0].method, 'fsr2');assert.match(warnings[0][0], /temporal integration is unavailable/);
  assert.deepEqual(context.graphicsInputs, {architecture: installed.architectures[0]});
  for (const warn of [() => {throw Error('warning sink failed');}, () => Promise.reject(Error('warning sink rejected'))]) {
    const recovered = await Launch.prepareLaunch(entry, {...context, logger: {warn}}, {run});
    assert.equal(recovered.bottlePath, launch.bottlePath);assert.equal(recovered.environment.WINEDXVK, undefined);assert.equal(entry.effects.video[0].method, 'fsr2');
  }
  await new Promise(setImmediate);
  await assert.rejects(Launch.prepareLaunch(entry, {...context, runtimeSettings: {...context.runtimeSettings, dllOverrides: ['invalid override']}}, {run}), /DLL overrides must use/);
  assert.throws(() => Launch.buildEnvironment({graphicsBackend: 'dxvk', dlss: true}, installed, launch.directory, launch.bottlePath,
    {executableArchitecture: 'x86_64'}), /MetalFX Temporal requires DXMT or D3DMetal/);
});

test("CrossOver Stop terminates an independently grouped Windows process before its tracked supervisor exits", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const directory = fixture(t), pidFile = path.join(directory, "game-pid"), stoppedFile = path.join(directory, "bottle-stopped");
  const argumentsFile = path.join(directory, "game-arguments.json"), terminatedFile = path.join(directory, "game-terminated"), serverCalls = path.join(directory, "server-calls");
  const gameArguments = ["--bottle", "private bottle", "--", "C:\\Game.exe", "--title", "  A quoted game  ", "", "$(touch unexpected)", "first\nsecond"];
  const fakeWine = path.join(directory, "wine"), fakeServer = path.join(directory, "wineserver");
  const gameCode = `const fs=require('fs');process.on('SIGTERM',()=>{fs.writeFileSync(process.env.GAME_TERMINATED,'terminated');process.exit(0)});const ready=process.env.GAME_PID+'.ready';fs.writeFileSync(ready,String(process.pid));fs.renameSync(ready,process.env.GAME_PID);${untilTestEnds}`;
  fs.writeFileSync(fakeWine, `#!${process.execPath}\nconst fs=require('fs'),{spawn}=require('child_process');fs.writeFileSync(process.env.GAME_ARGUMENTS,JSON.stringify(process.argv.slice(2)));spawn(process.execPath,['-e',${JSON.stringify(gameCode)}],{detached:true,stdio:'ignore'});${untilTestEnds}`, { mode: 0o755 });
  // The real server is a lightweight native CLI. Cold Node startups here can
  // consume the ordinary Stop grace before the fixture has requested shutdown.
  fs.writeFileSync(fakeServer, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$SERVER_CALLS"\nif [ "$1" = "-k" ]; then\n  read -r game_pid < "$GAME_PID"\n  kill -TERM "$game_pid" 2>/dev/null || :\n  printf stopped > "$STOPPED"\nfi\n', { mode: 0o755 });
  const child = spawn("/bin/sh", ["-c", Launch.SUPERVISOR, "test-crossover", fakeWine, fakeServer, ...gameArguments],
    { detached: true, stdio: "ignore", env: { ...process.env, GAME_PID: pidFile, GAME_TERMINATED: terminatedFile, STOPPED: stoppedFile, GAME_ARGUMENTS: argumentsFile, SERVER_CALLS: serverCalls } });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  const finished = once(child, "exit");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(pidFile));
  assert.deepEqual(JSON.parse(fs.readFileSync(argumentsFile, "utf8")), gameArguments);
  const gamePid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(-gamePid, "SIGKILL"); } catch {} });
  assert.equal(stopProcessTree(child.pid), true);
  const outcome = await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error("CrossOver supervisor did not stop")), 5000).unref())]);
  assert.equal(outcome[0], 143);
  assert.equal(outcome[1], null);
  assert.equal(fs.readFileSync(stoppedFile, "utf8"), "stopped");
  assert.deepEqual(fs.readFileSync(serverCalls, "utf8").trim().split("\n"), ["-k", "-w"]);
  assert.equal(fs.readFileSync(terminatedFile, "utf8"), "terminated");
  const exitDeadline = Date.now() + 3000;
  while (Date.now() < exitDeadline) {
    try { process.kill(gamePid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Windows process survived CrossOver Stop");
});

test("CrossOver removes failed initial environments and retries without deleting completed bottles", async t => {
  const userDataDir = fixture(t), directory = path.join(userDataDir, "games", "guard-test", "runtimes", "crossover"), runtimePath = app(path.join(userDataDir, "CrossOver.app"));
  const install = Manager.core.inspectApplication(runtimePath), bottle = path.join(directory, "bottles", "game");
  fs.mkdirSync(directory, { recursive: true });
  const owned = require("../src/modules/shared/runtime/wine-environment").privateEnvironment(userDataDir, directory, "bottles/game");
  let calls = 0;
  const run = async () => {
    calls++;
    fs.mkdirSync(bottle, { recursive: true });
    fs.writeFileSync(path.join(bottle, "cxbottle.conf"), "config");
    fs.writeFileSync(path.join(bottle, "system.reg"), "registry");
    if (calls === 1) throw new Error("interrupted creation");
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(Launch.ensureBottle(install, owned, directory, {}, {}, { run }), /could not create/);
  assert.equal(fs.existsSync(bottle), false);
  await Launch.ensureBottle(install, owned, directory, {}, {}, { run });
  fs.writeFileSync(path.join(bottle, "saved-game.dat"), "save");
  await Launch.ensureBottle(install, owned, directory, {}, {}, { run });
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(path.join(bottle, "saved-game.dat"), "utf8"), "save");
});

test("CrossOver cancelled preparation waits until independently grouped Wine children have stopped", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const directory = fixture(t), pidFile = path.join(directory, "child-pid"), stopped = path.join(directory, "stopped");
  const command = path.join(directory, "cxbottle"), server = path.join(directory, "wineserver");
  fs.writeFileSync(command, `#!${process.execPath}\nconst fs=require('fs'),{spawn}=require('child_process');let c=spawn(process.execPath,['-e',${JSON.stringify(untilTestEnds)}],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.CHILD_PID,String(c.pid));${untilTestEnds}`, { mode: 0o755 });
  fs.writeFileSync(server, `#!${process.execPath}\nconst fs=require('fs');if(process.argv[2]==='-k'){try{process.kill(Number(fs.readFileSync(process.env.CHILD_PID,'utf8')),'SIGTERM')}catch{}fs.writeFileSync(process.env.STOPPED,'yes');}`, { mode: 0o755 });
  const controller = new AbortController();
  const preparing = Launch.runSupervised(command, server, [], { cwd: directory, env: { ...process.env, CHILD_PID: pidFile, STOPPED: stopped }, signal: controller.signal, timeout: 5000 });
  const rejected = assert.rejects(preparing, { name: "AbortError" });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch {} });
  controller.abort(); await rejected;
  assert.equal(fs.readFileSync(stopped, "utf8"), "yes");
  const exited = Date.now() + 3000;
  while (Date.now() < exited) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Wine child survived cancelled preparation");
});
