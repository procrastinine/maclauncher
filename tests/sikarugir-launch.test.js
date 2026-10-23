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
const Detection = require("../src/modules/crossover/detect");
const WindowsFiles = require("../src/modules/crossover/runtime/launch");
const Launch = require("../src/modules/crossover/sikarugir/launch");
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
    manager: { resolveSelection: () => ({ ready: true, version, install }) },
    host: { platform: "darwin", arch: "arm64", macOSVersion: "26.0" },
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
      if (args[0] === "wineboot.exe") {
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
  assert.equal(Provider.decorateEntry(entry), entry, "cached detector facts are reused without a second scan");
  const legacy = { ...entry, runtimeData: {} };
  assert.equal(provider.canLaunchRuntime("sikarugir", legacy), true, "existing Windows library entries reuse bounded legacy evidence");
  const noWindows = path.join(directory, "no-windows"); fs.mkdirSync(noWindows);
  for (const invalid of [
    { ...entry, importPath: path.join(directory, "Native.app") },
    { ...entry, importPath: path.join(directory, "Linux.x86_64") },
    { ...entry, importPath: path.join(directory, "Linux.AppImage") },
    { ...entry, runtimeData: { crossover: { ...entry.runtimeData.crossover, executableArchitecture: "arm64" } } },
    { ...entry, runtimeData: { crossover: { detectionComplete: true, windowsExecutablePath: null } } },
    { ...entry, gamePath: noWindows, importPath: noWindows, runtimeData: {} }
  ]) assert.equal(provider.canLaunchRuntime("sikarugir", invalid), false);
  const previouslyEmpty = { ...entry, gamePath: noWindows, importPath: noWindows, runtimeData: {} };
  assert.equal(provider.canLaunchRuntime("sikarugir", previouslyEmpty), false);
  pe(path.join(noWindows, "Later.exe"));
  assert.equal(provider.canLaunchRuntime("sikarugir", previouslyEmpty), false, "negative legacy evidence stays cached until an explicit refresh");
  assert.equal(provider.canLaunchRuntime("sikarugir", Detection.decorateEntry(previouslyEmpty)), true);
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
  const plan = { directory, executablePath: path.join(directory, "private", "Game.exe"), winePath: "/managed/bin/wine",
    serverPath: "/managed/bin/wineserver", args: ["/private/Game.exe", "literal;$()"], environment: { WINEPREFIX: "/private/prefix",
      DYLD_LIBRARY_PATH: "/managed/support libraries", DYLD_FRAMEWORK_PATH: "/managed/frameworks" } };
  const provider = Provider.createProvider({ platform: "darwin", manager: {}, launch: { ...Launch, prepareLaunch: async () => plan } });
  const context = { spawnDetachedChecked: async (...args) => { calls.push(args); return child; } };
  assert.equal(await provider.launchRuntime("sikarugir", entry, context), child);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "/bin/sh");
  assert.deepEqual(calls[0][1].slice(3), [plan.winePath, plan.serverPath, "play", "/managed/support libraries", "", "/managed/frameworks", "", "", ...plan.args]);
  assert.equal(calls[0][2].cwd, path.dirname(plan.executablePath)); assert.equal(calls[0][2].env, plan.environment);
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
  const settings = { synchronization: "msync", locale: "ja_JP.UTF-8", bepInExWinhttp: true,
    environment: ["DXMT_CONFIG=d3d11.option=a,b", "CUSTOM_TITLE=it's literal; $(echo nope)"] };
  const { environment, dll } = Launch.buildEnvironment(settings, install, "/private/game", "/private/game/prefix", {
    env: { WINEDLLPATH: "/private/view", VK_DRIVER_FILES: "/private/driver.json" }, dllOverrides: ["d3d11,dxgi=b"]
  }, { baseEnvironment: { HOME: "/personal", PATH: "/unrelated", WINEPREFIX: "/other-game", CX_BOTTLE: "other", WINED3DMETAL: "1",
    DYLD_INSERT_LIBRARIES: "/other.dylib", VK_DRIVER_FILES: "/other.json", GST_PLUGIN_PATH: "/other/plugins", NODE_OPTIONS: "--inspect" } });
  assert.equal(environment.WINEPREFIX, "/private/game/prefix"); assert.equal(environment.HOME, "/private/game/home");
  assert.equal(environment.WINELOADER, install.executablePath); assert.equal(environment.WINESERVER, install.serverPath);
  assert.equal(environment.WINEMSYNC, "1"); assert.equal(environment.WINEESYNC, "0"); assert.equal(environment.LC_ALL, "ja_JP.UTF-8");
  assert.equal(environment.DXMT_CONFIG, "d3d11.option=a,b"); assert.equal(environment.CUSTOM_TITLE, "it's literal; $(echo nope)");
  assert.equal(environment.VK_DRIVER_FILES, "/private/driver.json"); assert.equal(environment.GST_PLUGIN_PATH, undefined);
  assert.equal(environment.CX_BOTTLE, undefined); assert.equal(environment.WINED3DMETAL, undefined);
  assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined); assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(dll, "d3d11,dxgi=b;winhttp=n,b");
  assert.throws(() => Launch.buildEnvironment({ synchronization: "esync" }, install, "/private", "/private/prefix"), /does not support ESync/);
  for (const key of ["HOME", "WINEPREFIX", "WINEMSYNC", "DYLD_LIBRARY_PATH", "VK_DRIVER_FILES", "GST_PLUGIN_PATH", "CX_BOTTLE"]) {
    assert.throws(() => Launch.parseEnvironment([`${key}=/elsewhere`]), /managed automatically/);
  }
  assert.throws(() => Launch.parseEnvironment(["MISSING_EQUALS"]), /NAME=value/);
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
  assert.throws(() => Launch.parseEnvironment(["SikarugirAppWine11=0"]), /managed automatically/);
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
  assert.equal(dependencies.calls.length, 2);
  assert.deepEqual(dependencies.calls.map(call => call.args), [["wineboot.exe", "--init"], ["winecfg.exe", "-v", "win10"]]);
  assert.equal(dependencies.calls[0].command, install.executablePath); assert.equal(dependencies.calls[0].server, install.serverPath);
  assert.equal(dependencies.calls[0].options.env.WINEPREFIX, launch.prefixPath);
  assert.equal(dependencies.calls[0].options.env.WINEDLLOVERRIDES, undefined, "game renderer and mod overrides wait until preparation finishes");
  assert.deepEqual(launch.args, ["G:\\Game.exe", "-windowed", "literal;$()", ...context.gameArguments]);
  assert.equal(launch.windowsExecutablePath, "G:\\Game.exe");
  const drive = path.join(launch.prefixPath, "dosdevices", "g:");
  assert.equal(fs.realpathSync(drive), fs.realpathSync(launch.gameRoot));
  assert.equal(path.isAbsolute(fs.readlinkSync(drive)), false, "the private mapping survives a library move");
  assert.equal(launch.environment.WINEDLLOVERRIDES, "d3d11,dxgi=b;winhttp=n,b");
  assert.equal(fs.lstatSync(path.join(launch.prefixPath, "drive_c", "users", "player", "Documents")).isDirectory(), true);
  fs.writeFileSync(path.join(launch.gameRoot, "settings.ini"), "private");
  fs.writeFileSync(path.join(launch.gameRoot, "Save01.dat"), "game save");
  fs.writeFileSync(path.join(launch.prefixPath, "saved.dat"), "prefix save");
  fs.writeFileSync(path.join(entry.gamePath, "asset.dat"), "two");
  await Launch.prepareLaunch(entry, context, dependencies);
  assert.equal(dependencies.calls.length, 2, "completed prefix initialization is reused");
  assert.equal(fs.readFileSync(path.join(entry.gamePath, "settings.ini"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(launch.gameRoot, "settings.ini"), "utf8"), "private");
  assert.equal(fs.readFileSync(path.join(launch.gameRoot, "asset.dat"), "utf8"), "two");
  assert.equal(fs.readFileSync(path.join(launch.gameRoot, "Save01.dat"), "utf8"), "game save");
  assert.equal(fs.readFileSync(path.join(launch.prefixPath, "saved.dat"), "utf8"), "prefix save");
  assert.equal(fs.readFileSync(install.executablePath, "utf8"), "immutable wine");
  assert.equal(entry.runtimeData.sikarugir.version, undefined, "automatic selection is not persisted as a version override");
  assert.equal(entry.runtimeData.sikarugir.installedVersion, "WS12WineSikarugir11.0_1");
  const saves = Provider.resolveSaveLocations(entry, context);
  assert.equal(saves.primaryDirectory, launch.gameRoot); assert.equal(saves.directories[1].directory, path.join(launch.prefixPath, "drive_c", "users"));
  dependencies.setVersion("WS12WineSikarugir10.0_8");
  const older = await Launch.prepareLaunch(entry, context, dependencies);
  assert.notEqual(older.prefixPath, launch.prefixPath);
  assert.equal(fs.readFileSync(path.join(launch.prefixPath, "saved.dat"), "utf8"), "prefix save");
  assert.equal(fs.readFileSync(path.join(older.gameRoot, "Save01.dat"), "utf8"), "game save");
});

test("trusted optional game effects follow prefix setup and preserve disabled launch environments", async t => {
  const directory = fixture(t), entry = game(directory), install = installation(directory), dependencies = adapters(install);
  const context = { userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: {} };
  const disabled = await Launch.prepareLaunch(entry, { ...context, applyGameEnvironment: async environment => environment }, dependencies);
  assert.equal(dependencies.graphicsCalls[0].settings.dlss, false);
  assert.equal(disabled.environment.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(disabled.environment.RESHADE_CONFIG, undefined);
  let applications = 0;
  entry.graphics = { temporalMethod: "metalfx" };
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
  assert.throws(() => Launch.parseEnvironment(["DYLD_INSERT_LIBRARIES=/untrusted.dylib"]), /managed automatically/);
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

test("camera preparation rolls back before ordinary Play, while cancellation and spawn failures remain original", async t => {
  const directory = fixture(t), entry = game(directory), install = installation(directory), dependencies = adapters(install);
  const Temporal = require("../src/modules/crossover/temporal"), Streamline = require("../src/modules/crossover/temporal/streamline"), crypto = require("node:crypto");
  const originals = ["sl.interposer.dll", "plugins/sl.interposer.dll"];
  for (const relative of originals) { const file = path.join(entry.gamePath, relative);fs.mkdirSync(path.dirname(file), {recursive: true});fs.writeFileSync(file, "original " + relative); }
  entry.graphics = {temporalMethod: "fsr2"};const saved = structuredClone(entry.graphics), settings = {graphicsBackend: "dxmt", synchronization: "msync", windowsVersion: "win7", environment: ["CUSTOM=retained"], dllOverrides: ["winhttp=b"]};
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
    assert.match(warnings.at(-1)[1], /original Streamline libraries could not be restored/);
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
    assert.equal(environment.DYLD_LIBRARY_PATH, [path.join(install.wineRoot, "lib", "wine", "x86_64-unix"), frameworks, gstLib].join(path.delimiter));
    assert.equal(environment.DYLD_FALLBACK_LIBRARY_PATH, environment.DYLD_LIBRARY_PATH);
    assert.equal(environment.DYLD_FRAMEWORK_PATH, frameworks);
    for (const name of ["WINEDLLPATH", "WINEDLLOVERRIDES", "VK_DRIVER_FILES", "VK_ICD_FILENAMES", "DXMT_CONFIG"]) {
      assert.equal(environment[name], undefined, `${name} is used only during gameplay`);
    }
    assert.equal(environment.WINEMSYNC, "1", "prefix setup preserves the selected supported synchronization mode");
    assert.equal(environment.LC_ALL, "ja_JP.UTF-8");
    assert.equal(environment.WINEDEBUG, "err+all");
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
  const result = await Launch.prepareLaunch(entry, { userDataDir: path.join(directory, "data"), settings: {}, runtimeSettings: {
    graphicsBackend: "dxmt", synchronization: "msync", locale: "ja_JP.UTF-8", wineDebug: "err+all", environment: ["DXMT_CONFIG=game-only"],
    dllOverrides: ["custom=n,b"], bepInExWinhttp: true
  } }, dependencies);
  assert.deepEqual(order, ["wineboot.exe", "winecfg.exe", "renderer"]);
  assert.equal(result.winePath, rendererWine);
  assert.equal(result.serverPath, rendererServer);
  assert.equal(result.environment.WINELOADER, rendererWine);
  assert.equal(result.environment.DXMT_CONFIG, "game-only");
  assert.equal(result.environment.VK_DRIVER_FILES, "/selected/renderer/icd.json");
  assert.equal(result.environment.WINEDLLOVERRIDES, "d3d11,dxgi=b;custom=n,b;winhttp=n,b");
});

test("selected Windows executables cannot escape the source root or select ARM Windows", async t => {
  const directory = fixture(t), entry = game(directory), dependencies = adapters(installation(directory));
  pe(path.join(directory, "outside.exe")); pe(path.join(entry.gamePath, "Arm.exe"), 0xaa64);
  const context = { userDataDir: path.join(directory, "data"), settings: {} };
  await assert.rejects(Launch.prepareLaunch(entry, { ...context, runtimeSettings: { executable: "../outside.exe" } }, dependencies), /inside the game folder/);
  await assert.rejects(Launch.prepareLaunch(entry, { ...context, runtimeSettings: { executable: "Arm.exe" } }, dependencies), /x86 and x64/);
  assert.equal(dependencies.calls.length, 0); assert.equal(dependencies.graphicsCalls.length, 0);
});

test("long private game paths launch through a short per-prefix drive and preserve the imported source", async t => {
  const directory = fixture(t), source = path.join(directory, "original"), relative = path.join("Game files", "遊戯.exe");
  const original = pe(path.join(source, relative), 0x8664), bytes = fs.readFileSync(original);
  fs.writeFileSync(path.join(source, "settings.ini"), "source settings");
  const entry = Detection.decorateEntry({ gameId: "long-path-game", moduleId: "crossover", gamePath: source, importPath: original });
  const context = { userDataDir: path.join(directory, ...Array(4).fill("long-library-folder-" + "a".repeat(48))), settings: {}, runtimeSettings: {} };
  const launch = await Launch.prepareLaunch(entry, context, adapters(installation(directory)));
  assert.ok(launch.executablePath.length > 260);
  assert.equal(launch.args[0], "G:\\Game files\\遊戯.exe");
  assert.ok(launch.args[0].length < 40);
  assert.deepEqual(fs.readFileSync(launch.executablePath), bytes);
  const mapping = path.join(launch.prefixPath, "dosdevices", "g:");
  fs.writeFileSync(path.join(mapping, "settings.ini"), "private settings");
  assert.equal(fs.readFileSync(path.join(source, "settings.ini"), "utf8"), "source settings");
  assert.equal(fs.readFileSync(path.join(launch.gameRoot, "settings.ini"), "utf8"), "private settings");
  assert.deepEqual(fs.readFileSync(original), bytes);
  const link = fs.readlinkSync(mapping);
  assert.equal(Launch.mapGameDrive(launch.directory, launch.prefixPath, launch.gameRoot, launch.executablePath), launch.args[0]);
  assert.equal(fs.readlinkSync(mapping), link, "an existing owned mapping is reused");
});

test("private game drive mappings reject conflicts and aliased parent directories without modifying them", t => {
  const directory = fixture(t), prefix = path.join(directory, "prefixes", "selected"), gameRoot = path.join(directory, "game");
  const executable = pe(path.join(gameRoot, "Game.exe")), dosdevices = path.join(prefix, "dosdevices"), mapping = path.join(dosdevices, "g:");
  fs.mkdirSync(dosdevices, { recursive: true });
  fs.writeFileSync(mapping, "existing mapping file");
  assert.throws(() => Launch.mapGameDrive(directory, prefix, gameRoot, executable), /mapping conflicts/);
  assert.equal(fs.readFileSync(mapping, "utf8"), "existing mapping file");
  fs.unlinkSync(mapping);
  const outside = path.join(directory, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "save.dat"), "outside save");
  fs.symlinkSync(outside, mapping, "dir");
  assert.throws(() => Launch.mapGameDrive(directory, prefix, gameRoot, executable), /mapping conflicts/);
  assert.equal(fs.readlinkSync(mapping), outside);
  fs.unlinkSync(mapping); fs.rmdirSync(dosdevices); fs.symlinkSync(outside, dosdevices, "dir");
  assert.throws(() => Launch.mapGameDrive(directory, prefix, gameRoot, executable), /must not be aliases/);
  assert.equal(fs.existsSync(path.join(outside, "g:")), false);
  assert.equal(fs.readFileSync(path.join(outside, "save.dat"), "utf8"), "outside save");
});

test("incomplete Wine preparation is removed while a completed prefix and its saves survive a retry failure", async t => {
  const directory = fixture(t), install = installation(directory), prefix = path.join(directory, "prefix"), graphics = {};
  const messages = [], context = { logger: { warn: message => { messages.push(message); } } };
  const run = async (_wine, _server, args) => {
    fs.mkdirSync(prefix, { recursive: true });
    fs.writeFileSync(path.join(prefix, "system.reg"), "registry"); fs.writeFileSync(path.join(prefix, "user.reg"), "registry");
    if (args[0] === "winecfg.exe") throw Object.assign(new Error("configuration failed"), { exitCode: 3,
      stderr: "x".repeat(20000) + "missing runtime library", stdout: "y".repeat(5000) });
  };
  await assert.rejects(Launch.ensurePrefix(install, prefix, directory, {}, graphics, context, { run }), /could not create/);
  assert.equal(fs.existsSync(prefix), false);
  const details = JSON.parse(messages[0].slice(messages[0].indexOf("{")));
  assert.equal(details.stage, "winecfg"); assert.equal(details.message, "configuration failed"); assert.equal(details.exitCode, 3);
  assert.equal(details.stderr.length, 8192); assert.match(details.stderr, /missing runtime library$/); assert.equal(details.stdout.length, 2048);
  fs.mkdirSync(prefix); fs.writeFileSync(path.join(prefix, "system.reg"), "registry"); fs.writeFileSync(path.join(prefix, "user.reg"), "registry");
  fs.writeFileSync(path.join(prefix, "saved.dat"), "save");
  await assert.rejects(Launch.ensurePrefix(install, prefix, directory, {}, graphics, context, { run }), /could not create/);
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

async function waitForFile(file, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(file), `missing process marker ${path.basename(file)}`);
}
function fakeProcesses(directory, { returns = false } = {}) {
  const wine = path.join(directory, "wine"), server = path.join(directory, "wineserver");
  fs.writeFileSync(wine, `#!${process.execPath}\nconst fs=require('fs'),{spawn}=require('child_process');if(process.env.ENVIRONMENT_FILE)fs.writeFileSync(process.env.ENVIRONMENT_FILE,JSON.stringify({args:process.argv.slice(2),libraries:process.env.DYLD_LIBRARY_PATH,fallbackLibraries:process.env.DYLD_FALLBACK_LIBRARY_PATH,frameworks:process.env.DYLD_FRAMEWORK_PATH,fallbackFrameworks:process.env.DYLD_FALLBACK_FRAMEWORK_PATH,insertLibraries:process.env.DYLD_INSERT_LIBRARIES}));const game=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.env.GAME_PID,String(game.pid));${returns ? "game.unref();fs.writeFileSync(process.env.RETURNED,'yes');" : "setInterval(()=>{},1000);"}`, { mode: 0o755 });
  fs.writeFileSync(server, `#!${process.execPath}\nconst fs=require('fs');if(process.env.SERVER_ENVIRONMENT_FILE)fs.writeFileSync(process.env.SERVER_ENVIRONMENT_FILE,JSON.stringify({insertLibraries:process.env.DYLD_INSERT_LIBRARIES}));if(process.env.WINEPREFIX!==process.env.EXPECTED_PREFIX)process.exit(2);const pid=Number(fs.readFileSync(process.env.GAME_PID,'utf8'));if(process.argv[2]==='-k'){try{process.kill(pid,'SIGTERM')}catch{}fs.writeFileSync(process.env.STOPPED,'yes')}else{const poll=setInterval(()=>{try{process.kill(pid,0)}catch{clearInterval(poll)}},20);}`, { mode: 0o755 });
  return { wine, server };
}

test("Wine supervisor keeps tracking independently grouped Windows children and Stop touches only its prefix", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const directory = fixture(t), { wine, server } = fakeProcesses(directory, { returns: true });
  const pidFile = path.join(directory, "pid"), returned = path.join(directory, "returned"), stopped = path.join(directory, "stopped");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
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
  assert.deepEqual(JSON.parse(fs.readFileSync(environment.ENVIRONMENT_FILE, "utf8")), { args: gameArguments,
    libraries: environment.DYLD_LIBRARY_PATH, fallbackLibraries: environment.DYLD_FALLBACK_LIBRARY_PATH,
    frameworks: environment.DYLD_FRAMEWORK_PATH, fallbackFrameworks: environment.DYLD_FALLBACK_FRAMEWORK_PATH,
    insertLibraries: environment.DYLD_INSERT_LIBRARIES },
    "the protected shell preserves private library paths and literal arguments for Wine");
  await waitForFile(environment.SERVER_ENVIRONMENT_FILE);
  assert.deepEqual(JSON.parse(fs.readFileSync(environment.SERVER_ENVIRONMENT_FILE, "utf8")), {},
    "supervisor server commands do not inherit game-only library injection");
  const gamePid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(gamePid, "SIGKILL"); } catch {} });
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
  t.after(() => { try { process.kill(gamePid, "SIGKILL"); } catch {} });
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
  t.after(() => { try { process.kill(gamePid, "SIGKILL"); } catch {} });
  assert.equal(fs.readFileSync(stopped, "utf8"), "yes");
  assert.throws(() => process.kill(gamePid, 0), { code: "ESRCH" });
});
