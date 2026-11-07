const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { stopProcessTree } = require("../src/core/process-stop");
const { untilTestEnds } = require("./helpers/fixture-process");
const Detection = require("../src/modules/crossover/detect");
const WindowsFiles = require("../src/modules/crossover/runtime/launch");
const Launch = require("../src/modules/crossover/sikarugir/launch");
const GamePaths = require("../src/modules/shared/runtime/wine-game-paths");
const Provider = require("../src/modules/crossover/sikarugir/provider");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-sikarugir-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function pe(file, machine = 0x14c) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150);
  bytes.writeUInt16LE(machine === 0x14c ? 0x10b : 0x20b, 152); bytes.writeUInt16LE(2, 220);
  fs.writeFileSync(file, bytes); return file;
}
function game(directory) {
  const gamePath = path.join(directory, "source"), executable = pe(path.join(gamePath, "Game.exe"));
  return Detection.decorateEntry({ gameId: "windows-game", moduleId: "crossover", gamePath, importPath: executable });
}
function installation(directory) {
  const installDir = path.join(directory, "installed"), wineRoot = path.join(installDir, "wswine.bundle");
  fs.mkdirSync(path.join(wineRoot, "bin"), { recursive: true });
  const executablePath = path.join(wineRoot, "bin", "wine"), serverPath = path.join(wineRoot, "bin", "wineserver");
  fs.writeFileSync(executablePath, "immutable wine"); fs.writeFileSync(serverPath, "immutable server");
  return { installDir, wineRoot, executablePath, serverPath, needsRosetta: false, capabilities: { msync: true, esync: false } };
}
function adapters(install) {
  let version = "WS12WineSikarugir11.0_1";
  const calls = [], graphicsCalls = [];
  return { calls, graphicsCalls, setVersion: value => { version = value; },
    resolveTranslators: async (_install, runtime, context) => {
      const selected = { id: "fixture-dxmt", engine: "dxmt", component: "d3d-renderer", form: "builtin", root: install.wineRoot, files: [], source: "synthetic Template" };
      const plan = require("../src/modules/shared/runtime/translator-plan").resolvePlan({ runtime, choices: [selected], selections: { "d3d-renderer": selected.id } });
      plan.layout = require("../src/modules/shared/runtime/wine-layout").wineLayout(install);
      context.translatorPlan = plan; return plan;
    },
    manager: { resolveSelection: () => ({ ready: true, version, install }) },
    host: { platform: "darwin", hardwareArch: "arm64", macOSVersion: "26.0" },
    rosetta: { isAvailable: () => true, ensure: () => assert.fail("Rosetta should already be available") },
    prepareGraphicsView: async options => {
      graphicsCalls.push(options);
      return { executablePath: install.executablePath, serverPath: install.serverPath,
        graphicsBackend: "dxmt", vulkanBackend: "moltenvk", dllOverrides: ["d3d11,dxgi=b"],
        env: { WINEDLLPATH: path.join(options.viewRoot, "lib", "wine"), VK_DRIVER_FILES: "managed-icd.json" },
        capabilities: { msync: true, esync: false }, componentVersions: { dxmt: "0.80" } };
    },
    run: async (command, server, args, options) => {
      calls.push({ command, server, args, options });
      if (args[0] === "wineboot.exe" && args[1] === "--init") {
        const prefix = options.env.WINEPREFIX;
        fs.mkdirSync(path.join(prefix, "drive_c", "users", "player"), { recursive: true });
        fs.writeFileSync(path.join(prefix, "system.reg"), "registry");
        fs.writeFileSync(path.join(prefix, "user.reg"), "registry");
        fs.symlinkSync(options.env.HOME, path.join(prefix, "drive_c", "users", "player", "Documents"));
      }
      return { stdout: "", stderr: "" };
    }
  };
}

test("Sikarugir is offered for cached Windows evidence before installation and rejects other platforms", t => {
  const directory = fixture(t), entry = game(directory);
  const provider = Provider.createProvider({ platform: "darwin", manager: { resolveForPlay: () => assert.fail("support checks must stay offline") } });
  assert.equal(provider.canLaunchRuntime("sikarugir", entry), true);
  assert.equal(provider.canLaunchRuntime("crossover", entry), false);
  assert.equal(Provider.decorateEntry, Detection.decorateEntry, "both Windows runtimes share one evidence decorator");
  for (const invalid of [
    { ...entry, gamePath: path.join(directory, "Native.app") },
    { ...entry, contentRootDir: path.join(directory, "Native.app", "Contents", "Resources") },
    { ...entry, runtimeData: { crossover: { ...entry.runtimeData.crossover, executableArchitecture: "arm64" } } },
    { ...entry, runtimeData: { crossover: { detectionComplete: true, windowsExecutablePath: null } } },
    { ...entry, runtimeData: {} }
  ]) assert.equal(provider.canLaunchRuntime("sikarugir", invalid), false);
  assert.equal(provider.canLaunchRuntime("sikarugir", { ...entry, importPath: path.join(entry.gamePath, "Game.sh") }), true,
    "a launcher script selected inside a folder game leaves the identity to the folder");
  // Native builds that are the game itself are decided when detection records the evidence.
  for (const name of ["Linux.x86_64", "Linux.AppImage"]) {
    const file = path.join(entry.gamePath, name); fs.writeFileSync(file, "native");
    const native = Detection.decorateEntry({ ...entry, gamePath: file, importPath: file, runtimeData: {} });
    assert.equal(provider.canLaunchRuntime("sikarugir", native), false, name);
  }
  // An entry saved before Windows evidence existed is not searched; its next refresh records the evidence.
  const noWindows = path.join(directory, "no-windows"); fs.mkdirSync(noWindows);
  const legacy = { ...entry, gamePath: noWindows, importPath: noWindows, runtimeData: {} };
  const reads = [], readdir = fs.readdirSync;
  fs.readdirSync = (...args) => { reads.push(args[0]); return readdir(...args); };
  try { assert.equal(provider.canLaunchRuntime("sikarugir", legacy), false); }
  finally { fs.readdirSync = readdir; }
  assert.deepEqual(reads, [], "runtime support never searches the game's folder");
  pe(path.join(noWindows, "Later.exe"));
  assert.equal(provider.canLaunchRuntime("sikarugir", Detection.decorateEntry(legacy)), true);
  assert.equal(Provider.createProvider({ platform: "linux" }).canLaunchRuntime("sikarugir", entry), false);
});

test("Sikarugir returns a managed install plan without installing or changing its selected version", async t => {
  const entry = game(fixture(t)), context = { settings: {}, runtimeSettings: { graphicsBackend: "dxmt" } };
  let ready = false, calls = 0;
  const provider = Provider.createProvider({ manager: { resolveForPlay: (received, passed) => {
    assert.equal(received, entry); assert.equal(passed, context); calls++;
    return { ready, version: "WS12WineSikarugir11.0_1", installOptions: { sectionId: "wine" } };
  } } });
  assert.deepEqual(await provider.ensureRuntime(entry, context), { managerId: "sikarugir", version: "WS12WineSikarugir11.0_1", installOptions: { sectionId: "wine" } });
  ready = true; assert.equal(await provider.ensureRuntime(entry, context), null); assert.equal(calls, 2);
  assert.equal(entry.runtimeData.sikarugir, undefined);
});

test("Sikarugir provider starts the supervised plain Wine command and records bounded output", async t => {
  const directory = fixture(t), entry = game(directory), calls = [];
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1234, exitCode: null, signalCode: null });
  const plan = { directory, executablePath: path.join(directory, "private", "Game.exe"), workingDirectory: entry.gamePath, winePath: "/managed/bin/wine",
    serverPath: "/managed/bin/wineserver", args: ["/private/Game.exe", "literal;$()"], environment: { WINEPREFIX: "/private/prefix",
      DYLD_LIBRARY_PATH: "/managed/support libraries", DYLD_FRAMEWORK_PATH: "/managed/frameworks" } };
  const provider = Provider.createProvider({ platform: "darwin", manager: {}, launch: { ...Launch, prepareLaunch: async () => plan } });
  const context = { spawnDetachedChecked: async (...args) => { calls.push(args); return child; } };
  assert.equal(await provider.launchRuntime("sikarugir", entry, context), child);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "/bin/sh");
  assert.deepEqual(calls[0][1].slice(3), [plan.winePath, plan.serverPath, "play", "/managed/support libraries", "", "/managed/frameworks", "", "", ...plan.args]);
  assert.equal(calls[0][2].cwd, entry.gamePath); assert.equal(calls[0][2].env, plan.environment);
  assert.equal(calls[0][3], false, "Rosetta is checked for Wine before starting the native shell supervisor");
  assert.equal(calls[0][1].some(arg => ["--bottle", "--wait-children", "--workdir", "--env"].includes(arg)), false);
  child.stderr.write(Buffer.alloc(600 * 1024, 97)); child.stdout.write("ignored after cap");
  child.emit("close", 0, null); child.emit("error", new Error("late event"));
  assert.equal(fs.statSync(path.join(directory, "wine.log")).size, 512 * 1024);
});

test("a rejected private log path prevents Wine from spawning and never truncates its alias target", async t => {
  const directory = fixture(t), entry = game(directory), outside = path.join(directory, "other-file");
  fs.writeFileSync(outside, "keep original"); fs.symlinkSync(outside, path.join(directory, "wine.log"));
  let spawned = false;
  const provider = Provider.createProvider({ platform: "darwin", manager: {}, launch: { ...Launch,
    prepareLaunch: async () => ({ directory, executablePath: "/private/Game.exe", args: [], environment: {} }) } });
  await assert.rejects(provider.launchRuntime("sikarugir", entry, { spawnDetachedChecked: async () => { spawned = true; } }), { code: "ELOOP" });
  assert.equal(spawned, false); assert.equal(fs.readFileSync(outside, "utf8"), "keep original");
});

test("Wine settings keep managed paths owned, preserve comma values and validate actual synchronization support", () => {
  const install = { executablePath: "/runtime/bin/wine", serverPath: "/runtime/bin/wineserver", capabilities: { msync: true, esync: false } };
  const settings = { synchronization: "msync", locale: "ja_JP.UTF-8", bepInExWinhttp: true };
  const { environment, dll } = Launch.buildEnvironment(settings, install, "/private/game", "/private/game/prefix", {
    env: { WINEDLLPATH: "/private/view", VK_DRIVER_FILES: "/private/driver.json" }, dllOverrides: ["d3d11,dxgi=b"]
  }, { baseEnvironment: { HOME: "/personal", PATH: "/unrelated", WINEPREFIX: "/other-game", CX_BOTTLE: "other", WINED3DMETAL: "1",
    DYLD_INSERT_LIBRARIES: "/other.dylib", VK_DRIVER_FILES: "/other.json", GST_PLUGIN_PATH: "/other/plugins", NODE_OPTIONS: "--inspect" },
  translatorEnvironment: { DXMT_CONFIG: "d3d11.option=a,b", CUSTOM_TITLE: "it's literal; $(echo nope)", WINEDEBUG: "+seh" } });
  assert.equal(environment.WINEPREFIX, "/private/game/prefix"); assert.equal(environment.HOME, "/private/game/home");
  assert.equal(environment.WINELOADER, install.executablePath); assert.equal(environment.WINESERVER, install.serverPath);
  assert.equal(environment.WINEMSYNC, "1"); assert.equal(environment.WINEESYNC, "0"); assert.equal(environment.LC_ALL, "ja_JP.UTF-8");
  assert.equal(environment.DXMT_CONFIG, "d3d11.option=a,b"); assert.equal(environment.CUSTOM_TITLE, "it's literal; $(echo nope)");
  assert.equal(environment.WINEDEBUG, "+seh", "a translator environment value replaces the launcher's debug channels");
  assert.equal(environment.VK_DRIVER_FILES, "/private/driver.json"); assert.equal(environment.GST_PLUGIN_PATH, undefined);
  assert.equal(environment.CX_BOTTLE, undefined); assert.equal(environment.WINED3DMETAL, undefined);
  assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined); assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(dll, "d3d11,dxgi=b;winhttp=n,b");
  assert.throws(() => Launch.buildEnvironment({ synchronization: "esync" }, install, "/private", "/private/prefix"), /does not support ESync/);
  const Contract = require("../src/modules/shared/runtime/translator-environment.mjs");
  const sikarugir = require("../src/modules/registry").listTranslatorEnvironments().find(item => item.id === "sikarugir");
  for (const key of ["HOME", "WINEPREFIX", "WINEMSYNC", "WINEDLLOVERRIDES", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "VK_DRIVER_FILES",
    "GST_PLUGIN_PATH", "CX_BOTTLE", "NODE_OPTIONS", "SikarugirAppWine11", "MACLAUNCHER_DXMT_BASE_LIBRARY"]) {
    assert.throws(() => Contract.normalizeValues({ [key]: "/elsewhere" }, { declarations: [sikarugir] }), /set by MacLauncher/, key);
    assert.deepEqual(Contract.launchValues([sikarugir], ["sikarugir"], { global: { sikarugir: { [key]: "/elsewhere" } } }).values, {}, key);
  }
  assert.throws(() => Launch.dllOverrides({ dllOverrides: ["winhttp=n;anything"] }), /library=order/);
  assert.equal(Launch.dllOverrides({ dllOverrides: ["winhttp=b"], bepInExWinhttp: true }), "winhttp=b");
});

test("Wine 11 receives the producer's initialization marker for both fresh setup and playback", () => {
  const install = { engineVersion: "11.0_1", executablePath: "/runtime/bin/wine", serverPath: "/runtime/bin/wineserver" };
  const inherited = { baseEnvironment: { SikarugirAppWine11: "old", SikarugirAppWine99: "unrelated" } };
  const setup = Launch.buildEnvironment({}, install, "/private/game", "/private/game/prefix", {}, inherited);
  assert.equal(setup.environment.SikarugirAppWine11, "1");
  assert.equal(setup.environment.SikarugirAppWine99, undefined);
  const playback = Launch.buildEnvironment({}, install, "/private/game", "/private/game/prefix", { executablePath: "/private/graphics/bin/wine" }, inherited);
  assert.equal(playback.environment.SikarugirAppWine11, "1");
  const wine10 = Launch.buildEnvironment({}, { ...install, engineVersion: "10.0_8" }, "/private/game", "/private/game/prefix", {}, inherited);
  assert.equal(wine10.environment.SikarugirAppWine11, undefined);
});

test("ordinary Wine uses original files without staging or reconciling earlier views", async t => {
  const directory = fs.realpathSync(fixture(t)), entry = game(directory), install = installation(directory), dependencies = adapters(install);
  const GameView = require("../src/modules/crossover/temporal/game-view");
  assert.equal(WindowsFiles.stageGameFiles, undefined, "released game staging is absent from ordinary launch exports");
  for (const method of ["reconcile", "remember", "watch"]) t.mock.method(GameView, method, () => assert.fail("No ordinary " + method));
  const context = {userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: {graphicsBackend: "dxmt"}};
  const managed = Launch.runtimeDirectory(entry, context), old = path.join(managed, "game");
  fs.mkdirSync(old, {recursive: true});fs.writeFileSync(path.join(old, "Save01.dat"), "earlier private save");
  entry.runtimeData.sikarugir = {cameraGameView: {kind: "camera", id: "old binding must not be read"}};
  fs.writeFileSync(path.join(entry.gamePath, "asset.dat"), "one");
  const launch = await Launch.prepareLaunch(entry, context, dependencies);
  assert.equal(launch.gameRoot, fs.realpathSync(entry.gamePath));
  assert.equal(launch.windowsExecutablePath, "G:\\Game.exe");
  assert.equal(launch.windowsWorkingDirectory, "G:\\");
  assert.equal(fs.existsSync(path.join(managed, "game-files.json")), false);
  const mapping = path.join(launch.prefixPath, "dosdevices", "y:");fs.symlinkSync(old, mapping);
  fs.writeFileSync(path.join(entry.gamePath, "asset.dat"), "two");
  fs.writeFileSync(path.join(launch.gameRoot, "Save02.dat"), "original portable save");
  const again = await Launch.prepareLaunch(entry, context, dependencies);
  assert.equal(again.gameRoot, launch.gameRoot);assert.equal(fs.readFileSync(path.join(again.gameRoot, "asset.dat"), "utf8"), "two");
  assert.equal(fs.readFileSync(path.join(entry.gamePath, "Save02.dat"), "utf8"), "original portable save");
  assert.equal(fs.readFileSync(path.join(old, "Save01.dat"), "utf8"), "earlier private save");
  assert.equal(fs.readlinkSync(mapping), old, "the earlier Y: mapping is untouched");
  assert.equal(dependencies.calls.length, 2, "warm Play does not initialize its prefix again");
});

test("ordinary Wine preparation configures its private prefix silently and preserves source files and saves", async t => {
  const directory = fixture(t), entry = game(directory), install = installation(directory), dependencies = adapters(install);
  fs.writeFileSync(path.join(entry.gamePath, "settings.ini"), "original");
  fs.writeFileSync(path.join(entry.gamePath, "asset.dat"), "one");
  const ownership = [], context = { userDataDir: path.join(directory, "data"), settings: {},
    gameArguments: ["--title", "  A quoted game  ", "", "$(touch literal)", "first\nsecond"],
    flushRuntimeUses: async () => { ownership.push("leased"); },
    onToolProcessSpawn: async (_child, options) => { assert.equal(options.stopOnLauncherExit, true); ownership.push("temporary"); },
    onProcessSpawn: async () => { ownership.push("bound"); }, runtimeSettings: {
    graphicsBackend: "dxmt", synchronization: "msync", windowsVersion: "win10", bepInExWinhttp: true, arguments: ["-windowed", "literal;$()"] } };
  const launch = await Launch.prepareLaunch(entry, context, dependencies);
  assert.deepEqual(ownership, ["leased"]);
  await dependencies.calls[0].options.onProcessSpawn(new EventEmitter(), { stopOnLauncherExit: true });
  assert.deepEqual(ownership, ["leased", "temporary", "bound"], "preparation helpers are registered for shutdown and retain the runtime lease");
  assert.equal(launch.directory, path.join(context.userDataDir, "games", entry.gameId, "runtimes", "sikarugir"));
  assert.equal(dependencies.calls.length, 3);
  assert.deepEqual(dependencies.calls.slice(0, 2).map(call => call.args), [["wineboot.exe", "--init"], ["winecfg.exe", "-v", "win10"]]);
  assert.deepEqual(dependencies.calls[2].args, ["reg.exe", "add", "HKCU\\Software\\Wine\\AppDefaults\\Game.exe", "/v", "Version", "/t", "REG_SZ", "/d", "win10", "/f"]);
  assert.equal(dependencies.calls[0].command, install.executablePath); assert.equal(dependencies.calls[0].server, install.serverPath);
  assert.equal(dependencies.calls[0].options.env.WINEPREFIX, launch.prefixPath);
  assert.equal(dependencies.calls[0].options.env.WINEDLLOVERRIDES, undefined, "game renderer and mod overrides wait until preparation finishes");
  assert.deepEqual(launch.args, ["start.exe", "/d", launch.windowsWorkingDirectory, "/exec", launch.windowsExecutablePath, "-windowed", "literal;$()", ...context.gameArguments]);
  assert.equal(launch.windowsExecutablePath, "G:\\Game.exe");
  assert.equal(fs.realpathSync(launch.gameRoot), fs.realpathSync(entry.gamePath));
  assert.equal(fs.realpathSync(path.join(launch.prefixPath, "dosdevices", "g:")), fs.realpathSync(entry.gamePath));
  assert.equal(launch.environment.WINEDLLOVERRIDES, "d3d11,dxgi=b;winhttp=n,b");
  assert.equal(fs.lstatSync(path.join(launch.prefixPath, "drive_c", "users", "player", "Documents")).isDirectory(), true);
  fs.writeFileSync(path.join(launch.gameRoot, "settings.ini"), "private");
  fs.writeFileSync(path.join(launch.gameRoot, "Save01.dat"), "game save");
  fs.writeFileSync(path.join(launch.prefixPath, "saved.dat"), "prefix save");
  fs.writeFileSync(path.join(entry.gamePath, "asset.dat"), "two");
  await Launch.prepareLaunch(entry, context, dependencies);
  assert.equal(dependencies.calls.filter(call => call.args[0] !== "reg.exe").length, 2, "completed prefix initialization is reused");
  const extra = await Launch.prepareLaunch(entry, {...context, runtimeSettings: {...context.runtimeSettings, windowsVersion: 'win81'}}, dependencies);
  assert.equal(extra.prefixPath, launch.prefixPath, 'additional reported versions share the original Windows 10 prefix');
  assert.equal(dependencies.calls.at(-1).args.at(-2), 'win81');
  assert.equal(fs.readFileSync(path.join(entry.gamePath, "settings.ini"), "utf8"), "private");
  assert.equal(fs.readFileSync(path.join(launch.gameRoot, "settings.ini"), "utf8"), "private");
  assert.equal(fs.readFileSync(path.join(launch.gameRoot, "asset.dat"), "utf8"), "two");
  assert.equal(fs.readFileSync(path.join(launch.gameRoot, "Save01.dat"), "utf8"), "game save");
  assert.equal(fs.readFileSync(path.join(launch.prefixPath, "saved.dat"), "utf8"), "prefix save");
  assert.equal(fs.readFileSync(install.executablePath, "utf8"), "immutable wine");
  assert.equal(entry.runtimeData.sikarugir.version, undefined, "automatic selection is not persisted as a version override");
  assert.equal(entry.runtimeData.sikarugir.installedVersion, "WS12WineSikarugir11.0_1");
  const saves = Provider.resolveSaveLocations(entry, context);
  assert.equal(fs.realpathSync(saves.primaryDirectory), fs.realpathSync(launch.gameRoot)); assert.equal(saves.directories[1].directory, path.join(launch.prefixPath, "drive_c", "users"));
  dependencies.setVersion("WS12WineSikarugir10.0_8");
  const older = await Launch.prepareLaunch(entry, context, dependencies);
  assert.equal(older.prefixPath, launch.prefixPath, "engine updates keep the per-game Windows profile");
  assert.equal(older.viewRoot, launch.viewRoot, "identical Wine files reuse the shared graphics view across labels");
  fs.writeFileSync(install.executablePath, "updated synthetic Wine");
  const updated = await Launch.prepareLaunch(entry, context, dependencies);
  assert.notEqual(updated.viewRoot, older.viewRoot, "changed Wine files select a new shared graphics view");
  assert.equal(updated.prefixPath, launch.prefixPath, "new graphics views retain the prefix and saves");
  assert.equal(fs.readFileSync(path.join(launch.prefixPath, "saved.dat"), "utf8"), "prefix save");
  assert.equal(fs.readFileSync(path.join(older.gameRoot, "Save01.dat"), "utf8"), "game save");
});

test("a shared Wine environment maps drives and applies changed settings in the selected bottle on both launches", async t => {
  const directory = fs.realpathSync(fixture(t)), entry = game(directory), install = installation(directory);
  const userDataDir = path.join(directory, "data"), original = path.join(directory, "shared-wrapper", "prefix");
  fs.mkdirSync(path.join(original, "dosdevices"), { recursive: true });
  fs.mkdirSync(path.join(original, "drive_c"));
  fs.writeFileSync(path.join(original, "saved.dat"), "shared save");
  const external = { kind: "sikarugir-wrapper", path: path.dirname(original), prefixPath: original,
    install, running: false, settings: {}, environment: {} };
  t.mock.method(require("../src/modules/shared/runtime/wine-environment"), "readEnvironment", () => external);
  t.mock.method(require("../src/modules/shared/runtime/wine-processes"), "prepareEnvironment", async value => value);
  const dependencies = adapters(install), context = { userDataDir, settings: {}, runtimeSettings: { windowsVersion: "win10" } };
  let selections = 0; const target = original;
  const versions = [];
  t.mock.method(require("../src/modules/shared/runtime/wine-environment"), "assertWritableRegistry", value => assert.equal(value.prefixPath, original));
  dependencies.run = async (_wine, _server, args, options) => {
    assert.equal(args[0], "reg.exe");
    assert.equal(options.env.WINEPREFIX, target, "settings reach the selected bottle");
    const version = args[args.indexOf("/d") + 1];
    versions.push(version);
    fs.writeFileSync(path.join(options.env.WINEPREFIX, "program-version.txt"), version);
    return { stdout: "", stderr: "" };
  };
  // Preparation is synthetic; no game or Steam process is started.
  t.mock.method(require("../src/modules/crossover/runtime/steam-bridge"), "prepare", async (_entry, _context, options) => {
    selections++;
    assert.equal(options.prefixPath, original);
    return { prefixPath: original, environment: options.environment, helper: "managed-helper.exe" };
  });
  for (let launch = 1; launch <= 2; launch++) {
    context.runtimeSettings.windowsVersion = launch === 1 ? "win10" : "win81";
    const prepared = await Launch.prepareLaunch(entry, context, dependencies);
    assert.equal(prepared.prefixPath, target);
    assert.equal(prepared.environment.WINEPREFIX, target);
    assert.equal(prepared.existingEnvironment, external);
    const mapping = path.join(target, "dosdevices", "g:");
    assert.equal(path.isAbsolute(fs.readlinkSync(mapping)), false, "exercise a relative Wine drive link");
    assert.equal(fs.realpathSync(mapping), fs.realpathSync(entry.gamePath), `launch ${launch} resolves the selected bottle drive`);
    assert.equal(fs.realpathSync(path.join(mapping, "Game.exe")), fs.realpathSync(entry.importPath));
    assert.equal(prepared.windowsExecutablePath, "G:\\Game.exe");
    assert.equal(prepared.windowsWorkingDirectory, "G:\\");
    assert.equal(fs.readFileSync(path.join(original, "saved.dat"), "utf8"), "shared save");
    assert.equal(fs.readFileSync(path.join(target, "program-version.txt"), "utf8"), context.runtimeSettings.windowsVersion);
  }
  assert.equal(selections, 2);
  assert.deepEqual(versions, ["win10", "win81"]);
  assert.equal(fs.existsSync(path.join(userDataDir, "games", entry.gameId, "runtimes", "sikarugir", "steam-environments")), false);
});

test("trusted optional game effects follow prefix setup and preserve disabled launch environments", async t => {
  const directory = fixture(t), entry = game(directory), install = installation(directory), dependencies = adapters(install);
  const context = { userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: {} };
  const disabled = await Launch.prepareLaunch(entry, { ...context, applyGameEnvironment: async environment => environment }, dependencies);
  assert.equal(dependencies.graphicsCalls[0].settings.dlss, false);
  assert.equal(disabled.environment.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(disabled.environment.RESHADE_CONFIG, undefined);
  let applications = 0;
  entry.effects = { schema: 2, mode: "advanced", video: [{ id: "scene", kind: "temporal", enabled: true, method: "metalfx", settings: {} }] };
  const enabled = await Launch.prepareLaunch(entry, { ...context, applyGameEnvironment: async environment => {
    applications++;
    assert.equal(dependencies.calls.length, 2, "stock prefix setup is complete before effects are selected");
    return { ...environment, DYLD_INSERT_LIBRARIES: "/owned/effects/libReShade.dylib", RESHADE_CONFIG: "/owned/game/ReShade.ini" };
  } }, dependencies);
  assert.equal(applications, 1);
  assert.equal(dependencies.graphicsCalls[1].settings.dlss, true, "shared temporal selection enables the renderer's game integration");
  assert.equal(context.runtimeSettings.dlss, undefined, "saved runtime preferences remain unchanged");
  assert.equal(enabled.environment.DYLD_INSERT_LIBRARIES, "/owned/effects/libReShade.dylib");
  assert.equal(enabled.environment.RESHADE_CONFIG, "/owned/game/ReShade.ini");
  assert.equal(enabled.prefixPath, disabled.prefixPath, "effects do not select a different save environment");
  for (const call of dependencies.calls) {
    assert.equal(call.options.env.DYLD_INSERT_LIBRARIES, undefined);
    assert.equal(call.options.env.RESHADE_CONFIG, undefined);
  }
});

test("a successful explicit Wine camera adapter keeps the original working directory", async t => {
  const directory = fixture(t), entry = game(directory), dependencies = adapters(installation(directory));
  const Temporal = require("../src/modules/crossover/temporal");
  const plan = {libraries: [], inputs: {cameraProjection: true, source: "streamline", methods: ["fsr2"]}, dxmt: {identity: "camera-fixture"}, baseRoot: directory};
  t.mock.method(Temporal, "resolvePlan", () => plan);t.mock.method(Temporal, "prepareGame", () => true);
  const prepared = await Launch.prepareLaunch(entry, {userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: {}}, dependencies);
  assert.notEqual(prepared.gameRoot, entry.gamePath, "the required DLL loader projection is explicit");
  assert.equal(prepared.workingDirectory, path.dirname(fs.realpathSync(path.join(entry.gamePath, "Game.exe"))));
  assert.equal(fs.existsSync(path.join(prepared.directory, "game")), false, "there is no preceding whole-game baseline");
  const saves = Provider.resolveSaveLocations(entry, {userDataDir: path.join(directory, "data")});
  assert.equal(fs.realpathSync(saves.primaryDirectory), fs.realpathSync(entry.gamePath));
});

test("Advanced-only temporal selection reaches the Wine launch camera bridge", async t => {
  const directory = fixture(t), entry = game(directory), install = installation(directory), dependencies = adapters(install);
  entry.graphics = {temporalMethod: "off"};entry.effects = {schema: 1, mode: "advanced", video: [
    {id: "scene", kind: "temporal", enabled: true, method: "fsr3", settings: {}}
  ]};
  const calls = [], Temporal = require("../src/modules/crossover/temporal");
  t.mock.method(Temporal, "resolvePlan", (_entry, _context, options) => {calls.push(options);return null;});
  await Launch.prepareLaunch(entry, {userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: {}}, dependencies);
  assert.equal(calls.length, 1);assert.equal(calls[0].settings.dlss, true);
  assert.equal(dependencies.graphicsCalls[0].settings.dlss, true);
});

test("inactive shared graphics still inspect automatic XeSS compatibility without enabling Streamline", async t => {
  const directory = fixture(t), entry = game(directory), dependencies = adapters(installation(directory));
  entry.graphics = {temporalMethod: "off"};
  const settings = {dlss: false}, before = structuredClone(settings), calls = [];
  const Temporal = require("../src/modules/crossover/temporal");
  t.mock.method(Temporal, "resolvePlan", (_entry, _context, options) => {calls.push(options);return null;});
  await Launch.prepareLaunch(entry, {userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: settings}, dependencies);
  assert.equal(calls.length, 1);assert.equal(calls[0].automatic, true);
  assert.deepEqual(settings, before);assert.equal(dependencies.graphicsCalls[0].settings.dlss, false);
});

test("camera preparation rolls back before ordinary Play, while cancellation and spawn failures remain original", async t => {
  const directory = fixture(t), entry = game(directory), install = installation(directory), dependencies = adapters(install);
  const Temporal = require("../src/modules/crossover/temporal"), Streamline = require("../src/modules/crossover/temporal/streamline"), crypto = require("node:crypto");
  const originals = ["sl.interposer.dll", "plugins/sl.interposer.dll"];
  for (const relative of originals) { const file = path.join(entry.gamePath, relative);fs.mkdirSync(path.dirname(file), {recursive: true});fs.writeFileSync(file, "original " + relative); }
  entry.graphics = {temporalMethod: "fsr2"};const saved = structuredClone(entry.graphics), settings = {graphicsBackend: "dxmt", synchronization: "msync", windowsVersion: "win7", dllOverrides: ["winhttp=b"]};
  entry.translatorEnvironment = {sikarugir: {CUSTOM: "retained"}};
  const plan = {inputs: {cameraProjection: true, source: "streamline", methods: ["fsr2"]}, libraries: originals.map(relativePath => ({relativePath, sourcePath: path.join(entry.gamePath, relativePath)}))};
  t.mock.method(Temporal, "resolvePlan", () => plan);
  let failure = new Error("Private camera DLL copy failed"), cancel;
  t.mock.method(Streamline, "prepare", options => {
    if (options.relativePath === originals[1]) { if (cancel) {cancel.abort();options.signal.throwIfAborted();}throw failure; }
    const target = path.join(options.gameRoot, options.relativePath), parent = path.dirname(target), original = fs.readFileSync(options.sourcePath), proxy = Buffer.from("owned camera proxy");
    const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(path.join(parent, Streamline.ORIGINAL), original);fs.writeFileSync(path.join(parent, Streamline.RECORD), JSON.stringify({schema: 1, sourceSha256: sha(original), proxySha256: sha(proxy)}));fs.unlinkSync(target);fs.writeFileSync(target, proxy);
    return {available: true};
  });
  const provider = Provider.createProvider({platform: "darwin", manager: dependencies.manager, launchDependencies: dependencies});
  const warnings = [], sinks = [(...args) => warnings.push(args), () => {throw Error("logger failed");}, () => Promise.reject(Error("logger rejected"))];
  let spawns = 0, spawnFailure;
  const context = logger => ({userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: settings, logger: {warn: logger}, signal: cancel?.signal,
    applyGameEnvironment: async env => ({...env, DYLD_INSERT_LIBRARIES: "/effects/independent.dylib"}),
    spawnDetachedChecked: async (_command, _args, options) => {
      spawns++;if (spawnFailure) throw spawnFailure;
      assert.equal(options.env.CUSTOM, "retained");assert.equal(options.env.WINEMSYNC, "1");assert.equal(options.env.WINEDLLOVERRIDES, "d3d11,dxgi=b;winhttp=b");assert.equal(options.env.DYLD_INSERT_LIBRARIES, "/effects/independent.dylib");
      return Object.assign(new EventEmitter(), {pid: 1234, exitCode: null, signalCode: null});
    }});
  for (const sink of sinks) {
    const child = await provider.launchRuntime("sikarugir", entry, context(sink));child.emit("close", 0, null);
    const options = dependencies.graphicsCalls.at(-1);assert.equal(options.cameraBridge, null);assert.equal(options.settings.graphicsBackend, "dxmt");assert.equal(options.settings.windowsVersion, "win7");
    assert.deepEqual(entry.runtimeData.sikarugir.graphicsInputs, {architecture: "x86_64"});assert.deepEqual(entry.graphics, saved);assert.equal(settings.dlss, undefined);
    for (const relative of originals) assert.equal(fs.readFileSync(path.join(entry.runtimeData.sikarugir.gameRoot, relative), "utf8"), "original " + relative);
    assert.equal(fs.existsSync(path.join(entry.runtimeData.sikarugir.gameRoot, Streamline.ORIGINAL)), false);
  }
  assert.equal(spawns, sinks.length);assert.match(warnings[0][1], /Private camera DLL copy failed/);
  const originalRestore = Streamline.restore;
  Streamline.restore = () => {throw Error("controlled optional rollback denied");};
  try {
    const child = await provider.launchRuntime("sikarugir", entry, context(sinks[0]));child.emit("close", 0, null);
    for (const relative of originals) assert.equal(fs.readFileSync(path.join(entry.runtimeData.sikarugir.gameRoot, relative), "utf8"), "original " + relative);
    assert.match(warnings.at(-1)[1], /original temporal libraries could not be restored/);
  } finally {Streamline.restore = originalRestore;}
  spawnFailure = new Error("original Wine spawn failure");await assert.rejects(provider.launchRuntime("sikarugir", entry, context(sinks[1])), error => error === spawnFailure);spawnFailure = null;
  const beforeCancellation = spawns;
  for (const marker of [{name: "AbortError"}, {code: "ABORT_ERR"}]) {
    failure = Object.assign(new Error("cancelled camera preparation"), marker);
    await assert.rejects(provider.launchRuntime("sikarugir", entry, context(sinks[1])), error => error === failure);
  }
  cancel = new AbortController();await assert.rejects(provider.launchRuntime("sikarugir", entry, context(sinks[1])), error => error === cancel.signal.reason);
  assert.equal(spawns, beforeCancellation, "cancellation never reaches Wine spawn");
  assert.equal(fs.existsSync(path.join(entry.runtimeData.sikarugir.gameRoot, Streamline.ORIGINAL)), false, "cancellation also retires the completed private swap");
  await new Promise(setImmediate); // A rejected warning promise is handled independently.
});

test("fresh prefix setup uses the stock engine and common support before applying the game renderer", async t => {
  const directory = fixture(t), entry = game(directory), install = installation(directory), dependencies = adapters(install);
  install.templateRoot = path.join(install.installDir, "support");
  const frameworks = path.join(install.templateRoot, "Frameworks");
  const gstLib = path.join(frameworks, "GStreamer.framework", "Versions", "1.0", "lib");
  fs.mkdirSync(gstLib, { recursive: true });
  const rendererWine = path.join(directory, "renderer", "bin", "wine"), rendererServer = path.join(directory, "renderer", "bin", "wineserver");
  const order = [], originalRun = dependencies.run;
  dependencies.run = async (...args) => {
    order.push(args[2][0]);
    assert.equal(args[0], install.executablePath);
    assert.equal(args[1], install.serverPath);
    const environment = args[3].env;
    assert.equal(environment.WINELOADER, install.executablePath);
    assert.equal(environment.WINESERVER, install.serverPath);
    assert.equal(environment.DYLD_LIBRARY_PATH, undefined);
    assert.equal(environment.DYLD_FALLBACK_LIBRARY_PATH, [path.join(install.wineRoot, "lib", "wine", "x86_64-unix"), frameworks, gstLib].join(path.delimiter));
    assert.equal(environment.DYLD_FRAMEWORK_PATH, undefined);
    assert.equal(environment.DYLD_FALLBACK_FRAMEWORK_PATH, frameworks);
    for (const name of ["WINEDLLPATH", "WINEDLLOVERRIDES", "VK_DRIVER_FILES", "VK_ICD_FILENAMES", "DXMT_CONFIG"]) {
      assert.equal(environment[name], undefined, `${name} is used only during gameplay`);
    }
    assert.equal(environment.WINEMSYNC, "1", "prefix setup preserves the selected supported synchronization mode");
    assert.equal(environment.LC_ALL, "ja_JP.UTF-8");
    assert.equal(environment.WINEDEBUG, "-all", "verbose game tracing cannot overflow prefix preparation");
    return originalRun(...args);
  };
  dependencies.prepareGraphicsView = async options => ({
    executablePath: rendererWine, serverPath: rendererServer, dllOverrides: ["d3d11,dxgi=b"],
    env: { WINEDLLPATH: "/selected/renderer", DYLD_LIBRARY_PATH: "/selected/renderer/unix", VK_DRIVER_FILES: "/selected/renderer/icd.json" },
    applyPrefix: async () => {
      assert.ok(fs.existsSync(path.join(options.prefixPath, "maclauncher-prefix.json")));
      order.push("renderer");
    }
  });
  entry.translatorEnvironment = { dxmt: { DXMT_CONFIG: "game-only" } };
  const result = await Launch.prepareLaunch(entry, { userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: {
    graphicsBackend: "dxmt", synchronization: "msync", locale: "ja_JP.UTF-8", wineDebug: "err+all",
    dllOverrides: ["custom=n,b"], bepInExWinhttp: true
  } }, dependencies);
  assert.deepEqual(order, ["wineboot.exe", "winecfg.exe", "renderer"]);
  assert.equal(result.winePath, rendererWine);
  assert.equal(result.environment.WINEDEBUG, "err+all", "the selected tracing remains active for the game");
  assert.equal(result.serverPath, rendererServer);
  assert.equal(result.environment.WINELOADER, rendererWine);
  assert.equal(result.environment.DXMT_CONFIG, "game-only");
  assert.equal(result.environment.VK_DRIVER_FILES, "/selected/renderer/icd.json");
  assert.equal(result.environment.WINEDLLOVERRIDES, "d3d11,dxgi=b;custom=n,b;winhttp=n,b");
});

test("Sikarugir launches with the global and game values of its chosen translator environments", async t => {
  const directory = fixture(t), dependencies = adapters(installation(directory));
  const entry = { ...game(directory), translatorEnvironment: { dxmt: { DXMT_CONFIG: null, DXMT_LOG_LEVEL: "debug" }, sikarugir: { GAME_ONLY: "$PATH literal", SHARED: "game" } } };
  const result = await Launch.prepareLaunch(entry, { userDataDir: path.join(directory, "data"),
    runtimeSettings: { graphicsBackend: "dxmt", locale: "ja_JP.UTF-8" },
    settings: { launcher: { translatorEnvironment: { sikarugir: { SHARED: "global", LANG: "fr_FR.UTF-8", WINEDEBUG: "+loaddll", PATH: "/stored/before/lock" },
      dxmt: { DXMT_CONFIG: "global" }, moltenvk: { MVK_CONFIG_LOG_LEVEL: "4" } } } } }, dependencies);
  const environment = result.environment;
  assert.equal(environment.SHARED, "game"); assert.equal(environment.GAME_ONLY, "$PATH literal");
  assert.equal(environment.DXMT_LOG_LEVEL, "debug"); assert.equal(environment.DXMT_CONFIG, undefined, "the game removes the global value");
  assert.equal(environment.LANG, "fr_FR.UTF-8", "a global value replaces the launcher's locale"); assert.equal(environment.LC_ALL, "ja_JP.UTF-8");
  assert.equal(environment.WINEDEBUG, "+loaddll", "a global value replaces the launcher's debug channels");
  assert.equal(environment.MVK_CONFIG_LOG_LEVEL, undefined, "MoltenVK values apply only to games that use MoltenVK");
  assert.notEqual(environment.PATH, "/stored/before/lock");
  for (const call of dependencies.calls) for (const name of ["SHARED", "GAME_ONLY", "DXMT_LOG_LEVEL"])
    assert.equal(call.options.env[name], undefined, `${name} is used only during gameplay`);
});

test("selected Windows executables cannot escape the source root or select ARM Windows", async t => {
  const directory = fixture(t), entry = game(directory), dependencies = adapters(installation(directory));
  pe(path.join(directory, "outside.exe")); pe(path.join(entry.gamePath, "Arm.exe"), 0xaa64);
  const context = { userDataDir: path.join(directory, "data"), settings: {} };
  await assert.rejects(Launch.prepareLaunch(entry, { ...context, runtimeSettings: { executable: "../outside.exe" } }, dependencies), /inside the game folder/);
  await assert.rejects(Launch.prepareLaunch(entry, { ...context, runtimeSettings: { executable: "Arm.exe" } }, dependencies), /x86 and x64/);
  assert.equal(dependencies.calls.length, 0); assert.equal(dependencies.graphicsCalls.length, 0);
});

test("long original game paths keep a short Wine path without a private game mirror", async t => {
  const directory = fixture(t), source = path.join(directory, ...Array(4).fill("long-original-folder-" + "a".repeat(48))), relative = path.join("Game files", "遊戯.exe");
  const original = pe(path.join(source, relative), 0x8664), bytes = fs.readFileSync(original);
  fs.writeFileSync(path.join(source, "settings.ini"), "source settings");
  const entry = Detection.decorateEntry({ gameId: "long-path-game", moduleId: "crossover", gamePath: source, importPath: original });
  const context = { userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: {} };
  const launch = await Launch.prepareLaunch(entry, context, adapters(installation(directory)));
  assert.ok(launch.executablePath.length > 260);
  assert.equal(launch.windowsExecutablePath, "G:\\Game files\\遊戯.exe");
  assert.ok(launch.windowsExecutablePath.length < 40, "the actual Windows executable path stays below MAX_PATH");
  assert.equal(fs.realpathSync(launch.executablePath), fs.realpathSync(original));
  assert.equal(fs.realpathSync(launch.gameRoot), fs.realpathSync(source));
  const mapping = path.join(launch.prefixPath, "dosdevices", "g:");
  assert.equal(fs.realpathSync(mapping), fs.realpathSync(source), "the short drive refers to original bytes");
  assert.equal(fs.existsSync(path.join(launch.directory, "game")), false);
  fs.writeFileSync(path.join(launch.gameRoot, "settings.ini"), "original settings changed by game");
  assert.equal(fs.readFileSync(path.join(source, "settings.ini"), "utf8"), "original settings changed by game");
  assert.deepEqual(fs.readFileSync(original), bytes);
});

test("the game drive maps the imported install folder so Unreal parent paths resolve", async t => {
  const directory = fixture(t), install = path.join(directory, "Paradise Killer"), binaries = path.join(install, "ParadiseKiller", "Binaries", "Win64");
  const executable = pe(path.join(binaries, "ParadiseKiller-Win64-Shipping.exe"), 0x8664);
  fs.mkdirSync(path.join(install, "Engine")); fs.mkdirSync(path.join(install, "ParadiseKiller", "Content", "Paks"), { recursive: true });
  const play = async (id, importPath) => {
    const entry = Detection.decorateEntry({ gameId: id, moduleId: "crossover", gamePath: binaries, importPath });
    assert.equal(entry.runtimeData.crossover.sourceRoot, binaries, "detection keeps the executable's folder as the game folder");
    return Launch.prepareLaunch(entry, { userDataDir: path.join(directory, id), settings: {}, runtimeSettings: {} }, adapters(installation(path.join(directory, id))));
  };
  for (const [id, importPath] of [["imported-folder", install], ["imported-executable", executable]]) {
    const launch = await play(id, importPath);
    assert.equal(launch.windowsExecutablePath, "G:\\ParadiseKiller\\Binaries\\Win64\\ParadiseKiller-Win64-Shipping.exe", id);
    assert.equal(launch.windowsWorkingDirectory, "G:\\ParadiseKiller\\Binaries\\Win64", id);
    assert.equal(fs.realpathSync(path.join(launch.prefixPath, "dosdevices", "g:")), fs.realpathSync(install), id);
    assert.equal(path.win32.resolve(path.win32.dirname(launch.windowsExecutablePath), "../../..", "ParadiseKiller/Content/Paks"), "G:\\ParadiseKiller\\Content\\Paks");
  }
  fs.rmdirSync(path.join(install, "Engine"));
  const folder = await play("folder-without-engine", install);
  assert.equal(folder.windowsExecutablePath, "G:\\ParadiseKiller\\Binaries\\Win64\\ParadiseKiller-Win64-Shipping.exe", "an imported folder is the drive for any engine");
  assert.equal(fs.realpathSync(path.join(folder.prefixPath, "dosdevices", "g:")), fs.realpathSync(install));
  const ordinary = await play("without-engine", executable);
  assert.equal(ordinary.windowsExecutablePath, "G:\\ParadiseKiller-Win64-Shipping.exe", "without the Unreal layout the executable's folder stays the drive");
  assert.equal(fs.realpathSync(path.join(ordinary.prefixPath, "dosdevices", "g:")), fs.realpathSync(binaries));
});

test("short original drive mappings preserve conflicting old entries and reject aliased parents", t => {
  const directory = fixture(t), prefix = path.join(directory, "prefixes", "selected"), gameRoot = path.join(directory, "game");
  const executable = pe(path.join(gameRoot, "Game.exe")), dosdevices = path.join(prefix, "dosdevices"), mapping = path.join(dosdevices, "g:");
  fs.mkdirSync(dosdevices, { recursive: true });
  fs.writeFileSync(mapping, "existing mapping file");
  assert.equal(GamePaths.prepareGamePaths(prefix, { gameRoot, executablePath: executable }).windowsExecutablePath, "H:\\Game.exe");
  assert.equal(fs.readFileSync(mapping, "utf8"), "existing mapping file");
  fs.unlinkSync(mapping);
  const outside = path.join(directory, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "save.dat"), "outside save");
  fs.symlinkSync(outside, mapping, "dir");
  assert.equal(GamePaths.prepareGamePaths(prefix, { gameRoot, executablePath: executable }).windowsExecutablePath, "H:\\Game.exe");
  assert.equal(fs.readlinkSync(mapping), outside);
  fs.unlinkSync(mapping);fs.unlinkSync(path.join(dosdevices, "h:")); fs.rmdirSync(dosdevices); fs.symlinkSync(outside, dosdevices, "dir");
  assert.throws(() => GamePaths.prepareGamePaths(prefix, { gameRoot, executablePath: executable }).windowsExecutablePath, /must not be aliases/);
  assert.equal(fs.existsSync(path.join(outside, "g:")), false);
  assert.equal(fs.readFileSync(path.join(outside, "save.dat"), "utf8"), "outside save");
});

test("incomplete Wine preparation is removed while a completed prefix and its saves survive a retry failure", async t => {
  const userDataDir = fixture(t), directory = path.join(userDataDir, "games", "guard-test", "runtimes", "sikarugir"), install = installation(userDataDir), prefix = path.join(directory, "prefix"), graphics = {};
  fs.mkdirSync(directory, { recursive: true });
  const owned = require("../src/modules/shared/runtime/wine-environment").privateEnvironment(userDataDir, directory, "prefix");
  const messages = [], context = { logger: { warn: message => { messages.push(message); } } };
  const run = async (_wine, _server, args) => {
    fs.mkdirSync(prefix, { recursive: true });
    fs.writeFileSync(path.join(prefix, "system.reg"), "registry"); fs.writeFileSync(path.join(prefix, "user.reg"), "registry");
    if (args[0] === "winecfg.exe") throw Object.assign(new Error("configuration failed"), { exitCode: 3,
      stderr: "x".repeat(20000) + "missing runtime library", stdout: "y".repeat(5000) });
  };
  await assert.rejects(Launch.ensurePrefix(install, owned, directory, {}, graphics, context, { run }), /could not create/);
  assert.equal(fs.existsSync(prefix), false);
  const details = JSON.parse(messages[0].slice(messages[0].indexOf("{")));
  assert.equal(details.stage, "winecfg"); assert.equal(details.message, "configuration failed"); assert.equal(details.exitCode, 3);
  assert.equal(details.stderr.length, 8192); assert.match(details.stderr, /missing runtime library$/); assert.equal(details.stdout.length, 2048);
  fs.mkdirSync(prefix); fs.writeFileSync(path.join(prefix, "system.reg"), "registry"); fs.writeFileSync(path.join(prefix, "user.reg"), "registry");
  fs.writeFileSync(path.join(prefix, "saved.dat"), "save");
  await assert.rejects(Launch.ensurePrefix(install, owned, directory, {}, graphics, context, { run }), /could not create/);
  assert.equal(fs.readFileSync(path.join(prefix, "saved.dat"), "utf8"), "save");
});

test("profile cleanup rejects an aliased users root before modifying outside directories", t => {
  const directory = fixture(t), prefix = path.join(directory, "prefix"), outside = path.join(directory, "outside");
  fs.mkdirSync(path.join(prefix, "drive_c"), { recursive: true }); fs.mkdirSync(path.join(outside, "player"), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(outside, "player", "Documents"));
  fs.symlinkSync(outside, path.join(prefix, "drive_c", "users"));
  assert.throws(() => WindowsFiles.detachProfileAliases(prefix), /must not be aliases/);
  assert.equal(fs.lstatSync(path.join(outside, "player", "Documents")).isSymbolicLink(), true);
});

// A marker counts once its writer's single write has landed, not when the file is created empty.
const written = file => { try { return fs.statSync(file).size > 0; } catch { return false; } };
async function waitForFile(file, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!written(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(written(file), `missing process marker ${path.basename(file)}`);
}
function fakeProcesses(directory, { returns = false } = {}) {
  const wine = path.join(directory, "wine"), server = path.join(directory, "wineserver");
  fs.writeFileSync(wine, `#!${process.execPath}\nconst fs=require('fs'),{spawn}=require('child_process');if(process.env.ENVIRONMENT_FILE)fs.writeFileSync(process.env.ENVIRONMENT_FILE,JSON.stringify({args:process.argv.slice(2),libraries:process.env.DYLD_LIBRARY_PATH,fallbackLibraries:process.env.DYLD_FALLBACK_LIBRARY_PATH,frameworks:process.env.DYLD_FRAMEWORK_PATH,fallbackFrameworks:process.env.DYLD_FALLBACK_FRAMEWORK_PATH,insertLibraries:process.env.DYLD_INSERT_LIBRARIES}));const game=spawn(process.execPath,['-e',${JSON.stringify(untilTestEnds)}],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.GAME_PID,String(game.pid));${returns ? "game.unref();fs.writeFileSync(process.env.RETURNED,'yes');" : untilTestEnds}`, { mode: 0o755 });
  fs.writeFileSync(server, `#!${process.execPath}\nconst fs=require('fs');if(process.env.SERVER_ENVIRONMENT_FILE)fs.writeFileSync(process.env.SERVER_ENVIRONMENT_FILE,JSON.stringify({insertLibraries:process.env.DYLD_INSERT_LIBRARIES}));if(process.env.WINEPREFIX!==process.env.EXPECTED_PREFIX)process.exit(2);const pid=Number(fs.readFileSync(process.env.GAME_PID,'utf8'));if(process.argv[2]==='-k'){try{process.kill(pid,'SIGTERM')}catch{}fs.writeFileSync(process.env.STOPPED,'yes')}else{const poll=setInterval(()=>{try{process.kill(pid,0)}catch{clearInterval(poll)}},20);}`, { mode: 0o755 });
  return { wine, server };
}

test("Wine supervisor keeps tracking independently grouped Windows children and Stop touches only its prefix", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const directory = fixture(t), { wine, server } = fakeProcesses(directory, { returns: true });
  const pidFile = path.join(directory, "pid"), returned = path.join(directory, "returned"), stopped = path.join(directory, "stopped");
  const unrelated = spawn(process.execPath, ["-e", untilTestEnds], { detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-unrelated.pid, "SIGKILL"); } catch {} });
  const environment = { ...process.env, GAME_PID: pidFile, RETURNED: returned, STOPPED: stopped,
    ENVIRONMENT_FILE: path.join(directory, "environment.json"), SERVER_ENVIRONMENT_FILE: path.join(directory, "server-environment.json"), WINEPREFIX: path.join(directory, "prefix"), EXPECTED_PREFIX: path.join(directory, "prefix"),
    DYLD_LIBRARY_PATH: path.join(directory, "library; $(literal)"), DYLD_FALLBACK_LIBRARY_PATH: path.join(directory, "fallback libraries"),
    DYLD_FRAMEWORK_PATH: path.join(directory, "frameworks"), DYLD_FALLBACK_FRAMEWORK_PATH: path.join(directory, "fallback frameworks"),
    DYLD_INSERT_LIBRARIES: process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "/owned/effects; literal.dylib" };
  const gameArguments = ["--title", "A quoted game", "", "literal;$()", "first\nsecond"];
  const child = spawn("/bin/sh", Launch.supervisorArguments(wine, server, "play", gameArguments, environment), {
    detached: true, stdio: "ignore", env: environment
  });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  const finished = once(child, "exit");
  await waitForFile(returned); await waitForFile(pidFile);
  const gamePid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(-gamePid, "SIGKILL"); } catch {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(environment.ENVIRONMENT_FILE, "utf8")), { args: gameArguments,
    libraries: environment.DYLD_LIBRARY_PATH, fallbackLibraries: environment.DYLD_FALLBACK_LIBRARY_PATH,
    frameworks: environment.DYLD_FRAMEWORK_PATH, fallbackFrameworks: environment.DYLD_FALLBACK_FRAMEWORK_PATH,
    insertLibraries: environment.DYLD_INSERT_LIBRARIES },
    "the protected shell preserves private library paths and literal arguments for Wine");
  await waitForFile(environment.SERVER_ENVIRONMENT_FILE);
  assert.deepEqual(JSON.parse(fs.readFileSync(environment.SERVER_ENVIRONMENT_FILE, "utf8")), {},
    "supervisor server commands do not inherit game-only library injection");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, "supervisor outlives the initial Wine command");
  assert.equal(fs.existsSync(stopped), false, "ordinary root exit does not kill Windows children");
  assert.equal(stopProcessTree(child.pid), true);
  const [code] = await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error("Wine supervisor did not stop")), 5000).unref())]);
  assert.equal(code, 143); assert.equal(fs.readFileSync(stopped, "utf8"), "yes");
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0), "another Wine/game process remains untouched");
  assert.throws(() => process.kill(gamePid, 0), { code: "ESRCH" });
});

test("cancelled Wine initialization waits for its independently grouped child to stop before rejecting", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const directory = fixture(t), { wine, server } = fakeProcesses(directory), pidFile = path.join(directory, "pid"), stopped = path.join(directory, "stopped");
  const controller = new AbortController(), prefix = path.join(directory, "prefix");
  let registered;
  const preparing = Launch.runSupervised(wine, server, [], { cwd: directory, signal: controller.signal, timeout: 5000,
    onProcessSpawn: (child, options) => { registered = { child, options }; },
    env: { ...process.env, GAME_PID: pidFile, STOPPED: stopped, WINEPREFIX: prefix, EXPECTED_PREFIX: prefix } });
  const rejected = assert.rejects(preparing, { name: "AbortError" });
  await waitForFile(pidFile); const gamePid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(-gamePid, "SIGKILL"); } catch {} });
  controller.abort(); await rejected;
  assert.equal(registered.options.stopOnLauncherExit, true);
  assert.ok(registered.child.pid > 0); assert.equal(registered.child.exitCode, 143);
  assert.equal(fs.readFileSync(stopped, "utf8"), "yes");
  assert.throws(() => process.kill(gamePid, 0), { code: "ESRCH" });
});

test("failed preparation process registration terminates the private Windows child before rejecting", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const directory = fixture(t), { wine, server } = fakeProcesses(directory), pidFile = path.join(directory, "pid"), stopped = path.join(directory, "stopped");
  const prefix = path.join(directory, "prefix");
  const preparing = Launch.runSupervised(wine, server, [], { cwd: directory, timeout: 5000,
    onProcessSpawn: async () => { await waitForFile(pidFile); throw new Error("preparation ownership failed"); },
    env: { ...process.env, GAME_PID: pidFile, STOPPED: stopped, WINEPREFIX: prefix, EXPECTED_PREFIX: prefix } });
  await assert.rejects(preparing, /preparation ownership failed/);
  const gamePid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(-gamePid, "SIGKILL"); } catch {} });
  assert.equal(fs.readFileSync(stopped, "utf8"), "yes");
  assert.throws(() => process.kill(gamePid, 0), { code: "ESRCH" });
});

test("Sikarugir records which Steam client bridge a Play used", async t => {
  const directory = fixture(t), entry = game(directory), install = installation(directory), dependencies = adapters(install);
  const context = { userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: {} };
  let used = true;
  t.mock.method(require("../src/modules/crossover/runtime/steam-bridge"), "prepare", async (_entry, _context, options) => used ? { prefixPath: options.prefixPath,
    environment: options.environment, privateClone: false, helper: "C:\\Program Files (x86)\\Steam\\steam.exe", appId: "480", packageVersion: "1.0.0" } : null);
  const launch = await Launch.prepareLaunch(entry, context, dependencies);
  assert.ok(launch.args.includes("C:\\Program Files (x86)\\Steam\\steam.exe"));
  assert.deepEqual(entry.runtimeData.sikarugir.steamBridge, { version: "1.0.0" });
  used = false;
  await Launch.prepareLaunch(entry, context, dependencies);
  assert.equal(entry.runtimeData.sikarugir.steamBridge, null);
});

test("changing Wine finishes the existing prefix update before short registry commands", async t => {
  const directory = fixture(t), entry = game(directory), install = installation(directory), dependencies = adapters(install);
  const context = {userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: {windowsVersion: "win10"}};
  dependencies.setVersion("10.0_8-template-1.0.24");
  const first = await Launch.prepareLaunch(entry, context, dependencies);
  const save = path.join(first.prefixPath, "save.dat");fs.writeFileSync(save, "existing save");
  const marker = path.join(first.prefixPath, "maclauncher-prefix.json");
  const before = fs.readFileSync(marker, "utf8");
  let needsUpdate = true;
  const commands = [], priorRun = dependencies.run;
  dependencies.run = async (command, server, args, options) => {
    commands.push(args);
    if (args[0] === "wineboot.exe" && args[1] === "--update") {
      assert.ok(options.timeout >= 45000, "the engine update uses the prefix-preparation budget");
      assert.equal(options.env.WINEDLLOVERRIDES, undefined, "stock Wine updates before game overrides");
      assert.equal(options.env.WINEDLLPATH, undefined, "the game loader view cannot update the prefix");
      needsUpdate = false;return {stdout: "", stderr: ""};
    }
    if (args[0] === "reg.exe" && needsUpdate) throw Object.assign(new Error("Wine preparation timed out."), {code: "ETIMEDOUT"});
    return priorRun(command, server, args, options);
  };
  dependencies.setVersion("11.0_1-template-1.0.24");
  const updated = await Launch.prepareLaunch(entry, context, dependencies);
  assert.equal(updated.prefixPath, first.prefixPath);
  assert.deepEqual(commands[0], ["wineboot.exe", "--update"]);
  assert.equal(commands.filter(args => args[0] === "wineboot.exe").length, 1);
  assert.ok(commands.findIndex(args => args[0] === "reg.exe") > 0);
  assert.notEqual(fs.readFileSync(marker, "utf8"), before);
  assert.equal(fs.readFileSync(save, "utf8"), "existing save");
  commands.length = 0;
  await Launch.prepareLaunch(entry, context, dependencies);
  assert.equal(commands.some(args => args[0] === "wineboot.exe"), false, "unchanged warm Play does not update again");
  const completed = fs.readFileSync(marker, "utf8");
  dependencies.setVersion("11.0_2-template-1.0.24");
  dependencies.run = async (_command, _server, args) => {assert.deepEqual(args, ["wineboot.exe", "--update"]);throw Object.assign(new Error("cancelled update"), {name: "AbortError"});};
  await assert.rejects(Launch.prepareLaunch(entry, context, dependencies), {name: "AbortError"});
  assert.equal(fs.readFileSync(marker, "utf8"), completed, "an interrupted update cannot mark this engine prepared");
  assert.equal(fs.readFileSync(save, "utf8"), "existing save");
});

test("MV selects legacy ANGLE D3D9 with WineD3D for missing Win32 sharing, preserving explicit choices", async t => {
  const { peFixture } = require("./helpers/pe-fixture");
  const { image, X64 } = require("./fixtures/macho-image");
  const { composeRuntimeProviders } = require("../src/modules/shared/runtime/providers");
  const { createLauncher } = require("../src/core/launcher");
  const directory = fixture(t), entry = game(directory), install = installation(directory), dependencies = adapters(install);
  function library(file, exports, { builtin = false, markers = [], isDll = true, is64 = false, imports = [] } = {}) {
    const f = peFixture({ is64 });
    f.bytes.writeUInt16LE(isDll ? 0x2002 : 2, f.peOffset + 22);
    f.bytes.writeUInt16LE(2, f.optional + 68);
    f.bytes.writeUInt32LE(0x60000020, f.section + 36);
    if (builtin) f.bytes.write("Wine builtin DLL\0", 64);
    const base = f.raw + 0x600, rva = offset => 0x2000 + offset;
    f.bytes.writeUInt32LE(rva(0x600), f.directories); f.bytes.writeUInt32LE(0x400, f.directories + 4);
    f.bytes.writeUInt32LE(exports.length, base + 20); f.bytes.writeUInt32LE(exports.length, base + 24);
    f.bytes.writeUInt32LE(rva(0x640), base + 28); f.bytes.writeUInt32LE(rva(0x680), base + 32); f.bytes.writeUInt32LE(rva(0x6c0), base + 36);
    let nameOffset = 0x700;
    exports.forEach((name, index) => {
      f.bytes.writeUInt32LE(rva(0xb00), f.raw + 0x640 + index * 4);
      f.bytes.writeUInt32LE(rva(nameOffset), f.raw + 0x680 + index * 4);
      f.bytes.writeUInt16LE(index, f.raw + 0x6c0 + index * 2);
      f.bytes.write(name + "\0", f.raw + nameOffset); nameOffset += name.length + 1;
    });
    f.bytes.write(markers.join("\0") + "\0", f.raw + 0xc00);
    if (imports.length) {
      const start = 0x900, rva = offset => 0x2000 + offset;
      f.bytes.writeUInt32LE(rva(start), f.directories + 8); f.bytes.writeUInt32LE((imports.length + 1) * 20, f.directories + 12);
      let cursor = start + (imports.length + 1) * 20;
      imports.forEach((name, index) => {
        const at = f.raw + start + index * 20, lookup = cursor, iat = cursor + 16; cursor += 32;
        f.bytes.writeUInt32LE(rva(lookup), at); f.bytes.writeUInt32LE(rva(iat), at + 16);
        f.bytes.writeUInt32LE(rva(cursor), at + 12); f.bytes.write(name + "\0", f.raw + cursor); cursor += name.length + 1;
        for (const offset of [lookup, iat]) {
          if (is64) f.bytes.writeBigUInt64LE(0x8000000000000001n, f.raw + offset);
          else f.bytes.writeUInt32LE(0x80000001, f.raw + offset);
        }
      });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, f.bytes);
  }
  const unix = path.join(install.wineRoot, "lib/wine/x86_64-unix");
  fs.mkdirSync(unix, { recursive: true }); install.architecture = "x86_64";
  const native = image({ cpu: X64 });
  fs.writeFileSync(path.join(unix, "ntdll.so"), native);
  for (const name of ["winevulkan.so", "win32u.so"]) fs.writeFileSync(path.join(unix, name), Buffer.concat([native, Buffer.from("vkCreateInstance\0")]));
  library(path.join(install.wineRoot, "lib/wine/i386-windows/winevulkan.dll"), ["vkGetDeviceProcAddr", "vkGetInstanceProcAddr"], { builtin: true });
  for (const is64 of [false, true]) for (const api of [8, 9]) library(path.join(install.wineRoot, "lib/wine", is64 ? "x86_64-windows" : "i386-windows", `d3d${api}.dll`), [`Direct3DCreate${api}`], { builtin: true, is64, imports: ['wined3d.dll'] });
  const browserPath = path.join(entry.gamePath, "Game.exe");
  library(browserPath, [], { isDll: false, markers: ["disable-d3d11"] });
  library(path.join(entry.gamePath, "libEGL.dll"), ["eglInitialize"]);
  library(path.join(entry.gamePath, "libGLESv2.dll"), ["glDrawArrays", "glGetString"], { markers: ["Direct3DCreate9"] });
  const manifestPath = path.join(entry.gamePath, "package.json"), manifest = JSON.stringify({ main: "index.html" });
  fs.writeFileSync(manifestPath, manifest); entry.indexHtml = path.join(entry.gamePath, "index.html"); fs.writeFileSync(entry.indexHtml, "original html");
  Object.assign(entry, { moduleId: "mv", runtimeId: "sikarugir", launchArguments: "--seed 4" });
  const mod = composeRuntimeProviders(require("../src/modules/mv/main"), [Provider]);
  const registry = { listModules: () => [mod.manifest], getModule: () => mod, getModuleInfo: () => mod.manifest, listSharedRuntimeManagers: () => [] };
  const launcher = createLauncher({ userDataDir: path.join(directory, "data"), registry });
  const runtimeSettings = { environmentReference: "private", arguments: ["--locale=en"], translatorRenderer: "fixture-dxvk" };
  const context = launcher.getGameLaunchContext(entry, {}, { runtimeId: "sikarugir", runtimeSettings });
  const dxvkRoot = path.join(directory, "dxvk");
  for (const [name, imports] of Object.entries({ 'd3d8.dll': ['d3d9.dll'], 'd3d9.dll': [], 'd3d10core.dll': ['d3d11.dll'], 'd3d11.dll': ['dxgi.dll'], 'dxgi.dll': [] })) library(path.join(dxvkRoot, name), ["Direct3DCreate9"], { imports });
  const dxvk = require("../src/modules/shared/runtime/translator-description").describeTranslator(dxvkRoot, { id: "fixture-dxvk", engine: "dxvk", version: '3.1.1', component: "d3d-renderer" });
  dependencies.resolveTranslators = (install, runtime, context, options) => require("../src/modules/shared/runtime/wine-translators").resolve(install, runtime, context, { ...options, choices: [dxvk], managers: [] });
  const previousGraphics = dependencies.prepareGraphicsView;
  dependencies.prepareGraphicsView = async options => ({ ...await previousGraphics(options), graphicsBackend: "wined3d", dllOverrides: options.translatorView.dllOverrides });
  const prepared = await Launch.prepareLaunch(entry, context, dependencies);
  assert.deepEqual(prepared.args.slice(-5), [prepared.windowsExecutablePath, "--disable-d3d11", "--locale=en", "--seed", "4"]);
  assert.equal(context.translatorPlan.components.d3d9.used.engine, "wined3d");
  assert.equal(context.translatorPlan.components.d3d9.fallback, false);
  assert.equal(context.translatorPlan.components.d3d9.used.files.find(file => file.format === "pe").machine, 0x14c);
  assert.equal(context.translatorPlan.components.d3d8.used.engine, "wined3d", "the D3D8 dependency group stays coherent with WineD3D9");
  for (const api of ['d3d10', 'd3d11']) assert.equal(context.translatorPlan.components[api].used.engine, "dxvk");
  assert.match(prepared.environment.WINEDLLOVERRIDES, /(?:^|;)d3d9=b(?:;|$)/);
  assert.match(prepared.environment.WINEDLLOVERRIDES, /(?:^|;)d3d11=n,b(?:;|$)/);
  assert.match(prepared.environment.WINEDLLOVERRIDES, /(?:^|;)dxgi=n,b(?:;|$)/);
  assert.equal(dependencies.calls.some(call => call.args.includes("--disable-d3d11")), false, "prefix and registry helpers never receive browser switches");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), manifest);
  assert.equal(fs.readFileSync(entry.indexHtml, "utf8"), "original html");
  assert.equal(entry.launchArguments, "--seed 4");
  assert.deepEqual(context.runtimeSettings.arguments, ["--locale=en"]);
  assert.equal(runtimeSettings.translatorD3D9, undefined, "module defaults never modify saved runtime settings");
  assert.equal(runtimeSettings.translatorD3D8, undefined);
  assert.equal(entry.runtimeData.sikarugir.translatorPlanInputs.settings.translatorD3D9, "", "applied rows remain keyed to the original requested settings");
  const launch = { install, executablePath: path.join(entry.gamePath, "Game.exe"), executableArchitecture: "x86", graphicsBackend: "dxvk", arguments: ["--seed", "4"] };
  for (const arguments_ of [["--use-angle=vulkan"], ["--use-angle", "d3d11"], ["--use-gl=desktop"], ["--disable-d3d11"], ["--disable-gpu"], ["--disable-webgl"]]) {
    assert.deepEqual(await context.resolveRuntimeArguments({ ...launch, arguments: arguments_ }), arguments_);
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ main: "index.html", "chromium-args": "--use-angle=d3d11" }));
  assert.deepEqual(await context.resolveRuntimeArguments(launch), launch.arguments, "manifest browser settings take precedence too");
  fs.writeFileSync(manifestPath, manifest);
  const crossOver = launcher.getGameLaunchContext(entry, {}, { runtimeId: "crossover", runtimeSettings: {} });
  assert.deepEqual(await crossOver.resolveRuntimeArguments(launch), launch.arguments);
  const tool = launcher.getLaunchContext(entry, {}, { runtimeId: "sikarugir", runtimeSettings: {} });
  assert.deepEqual(await tool.resolveRuntimeArguments(launch), launch.arguments);
  const plan = context.translatorPlan;
  context.translatorPlan = { components: { d3d9: { used: { engine: "dxvk" } } } };
  assert.deepEqual(await context.resolveRuntimeArguments(launch), launch.arguments, "a failed or explicit different renderer selection cannot receive the D3D9 policy flag");
  context.translatorPlan = plan;
  const selection = { settings: runtimeSettings, install, executablePath: browserPath, executableArchitecture: "x86" };
  for (const reference of [undefined, null, "", "private"]) {
    const settings = { ...runtimeSettings, environmentReference: reference };
    const selected = await context.resolveRuntimeSettings({ ...selection, settings });
    for (const key of ['translatorD3D8', 'translatorD3D9']) assert.equal(selected[key], "included:d3d-renderer:wined3d");
    assert.equal(settings.translatorD3D9, undefined);
  }
  const pinned = { ...runtimeSettings, translatorD3D9: 'included:d3d-renderer:wined3d', translatorD3D11: 'chosen-eleven' };
  const selected = await context.resolveRuntimeSettings({ ...selection, settings: pinned });
  assert.equal(selected.translatorD3D9, pinned.translatorD3D9, "an explicit compatible D3D9 choice is retained");
  assert.equal(selected.translatorD3D11, pinned.translatorD3D11, "explicit other API choices beat the aggregate/default");
  assert.equal(selected.translatorD3D8, 'included:d3d-renderer:wined3d');
  const external = { kind: "sikarugir-wrapper", path: directory };
  for (const settings of [{ ...runtimeSettings, translatorD3D9: "chosen-dxvk" }, { ...runtimeSettings, translatorD3D8: "chosen-eight" }, { ...runtimeSettings, arguments: ["--disable-webgl"] },
    { ...runtimeSettings, environmentReference: external }, { ...runtimeSettings, environmentReference: JSON.stringify(external) }]) {
    assert.deepEqual(await context.resolveRuntimeSettings({ ...selection, settings }), settings);
  }
  assert.deepEqual(await crossOver.resolveRuntimeSettings(selection), runtimeSettings);
  assert.deepEqual(await tool.resolveRuntimeSettings(selection), runtimeSettings);
  fs.writeFileSync(path.join(unix, "win32u.so"), Buffer.concat([native, Buffer.from("vkCreateInstance\0vkGetMemoryWin32HandleKHR\0")]));
  assert.deepEqual(await context.resolveRuntimeArguments(launch), launch.arguments, "declared APIs do not prove missing sharing and cannot trigger a fallback");
  fs.unlinkSync(path.join(unix, "win32u.so"));
  assert.deepEqual(await context.resolveRuntimeArguments(launch), launch.arguments, "missing native metadata remains unknown");
  fs.writeFileSync(path.join(unix, "win32u.so"), Buffer.concat([native, Buffer.from("vkCreateInstance\0")]));
  library(browserPath, [], { isDll: false });
  assert.deepEqual(await context.resolveRuntimeArguments(launch), launch.arguments, "a browser without the legacy D3D9 selector cannot be selected");
});
