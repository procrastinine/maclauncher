const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { untilTestEnds } = require("./helpers/fixture-process");
const { peFixture, versionResource } = require("./helpers/pe-fixture");
const { image, X64 } = require("./fixtures/macho-image");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-sikarugir-integration-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, userDataDir: path.join(root, "data") };
}

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function pe(file, machine = 0x14c) {
  const { bytes, peOffset, optional } = peFixture({ is64: machine !== 0x14c, version: versionResource({ strings: {} }) });
  bytes.writeUInt16LE(2, peOffset + 22);
  bytes.writeUInt16LE(2, optional + 68); // Windows GUI executable, as in the original fixture.
  return write(file, bytes);
}

function builtinDll(file, architecture) {
  const { bytes, peOffset } = peFixture({ is64: architecture !== "i386-windows", version: versionResource({ strings: {} }) });
  bytes.write("Wine builtin DLL\0", 64);
  bytes.writeUInt16LE(0x2002, peOffset + 22);
  return write(file, bytes);
}

function unityData(root) {
  const asset = Buffer.alloc(96);
  asset.writeUInt32BE(40); asset.writeUInt32BE(asset.length, 4);
  asset.writeUInt32BE(17, 8); asset.writeUInt32BE(80, 12);
  asset.write("2020.3.48f1\0", 20, "ascii");
  write(path.join(root, "globalgamemanagers"), asset);
  write(path.join(root, "Managed", "UnityEngine.CoreModule.dll"), "");
}

function registry() { return require("../src/modules/registry"); }
function launcher(options) { return require("../src/core/launcher").createLauncher(options); }

function fakeChild() {
  const child = Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null, signalCode: null,
    stdout: new EventEmitter(), stderr: new EventEmitter(), unref() {} });
  const close = () => { if (child.exitCode == null) { child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); } };
  process.nextTick(() => child.emit("spawn"));
  return { child, close };
}

function managedFixture(t, { installed = [], approval = true, native = false } = {}) {
  const { root, userDataDir } = fixture(t), calls = [], children = [], installs = new Map();
  const Modules = registry(), manifest = Modules.getModuleInfo("crossover");
  const Launch = require("./helpers/wine-source.cjs").launch("sikarugir");
  const Graphics = require("../src/modules/crossover/sources/wine-graphics");
  const Provider = require("./helpers/wine-source.cjs").provider("sikarugir");
  const { composeRuntimeProviders } = require("../src/modules/shared/runtime/providers");
  const runtimeRoot = path.join(root, "runtime-payloads");
  function payload(version) {
    const installDir = path.join(runtimeRoot, version), executablePath = path.join(installDir, "bin", "wine"), serverPath = path.join(installDir, "bin", "wineserver");
    write(executablePath, "#!/bin/sh\nexit 0\n"); write(serverPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(executablePath, 0o755); fs.chmodSync(serverPath, 0o755);
    write(path.join(installDir, "lib", "wine", "x86_64-unix", "ntdll.so"), image({ cpu: X64,
      installName: "@rpath/ntdll.so", symbols: ["wine_unix_call"] }));
    write(path.join(installDir, "share", "wine", "nls", "c_932.nls"), "engine locale data");
    for (const architecture of ["i386-windows", "x86_64-windows"]) {
      for (const name of ["ntdll", "apisetschema"]) {
        builtinDll(path.join(installDir, "lib", "wine", architecture, name + ".dll"), architecture);
      }
    }
    const templateRoot = path.join(installDir, "support"), frameworks = path.join(templateRoot, "Frameworks");
    for (const architecture of ["i386-windows", "x86_64-windows"]) {
      for (const name of ["d3d10core", "d3d11", "dxgi", "winemetal"]) {
        builtinDll(path.join(frameworks, "renderer", "dxmt", "wine", architecture, name + ".dll"), architecture);
      }
    }
    const bridge = image({ cpu: X64, installName: "@rpath/winemetal.so", minimumOS: 0x000e0000,
      dependencies: ["@rpath/ntdll.so"], symbols: ["wine_unix_call"] });
    const symbol = 32 + bridge.readUInt32LE(20);
    bridge.writeUInt32LE(0x80, 24); // MH_TWOLEVEL: the undefined symbol names its real dependency.
    bridge[symbol + 4] = 1; bridge[symbol + 5] = 0; bridge.writeUInt16LE(0x100, symbol + 6);
    write(path.join(frameworks, "renderer", "dxmt", "wine", "x86_64-unix", "winemetal.so"), bridge);
    write(path.join(frameworks, "libMoltenVK.dylib"), image({ cpu: X64,
      installName: "@rpath/libMoltenVK.dylib", minimumOS: 0x000b0000, symbols: ["vkGetInstanceProcAddr"] }));
    write(path.join(templateRoot, "Resources", "vulkan", "icd.d", "MoltenVK_icd.json"), JSON.stringify({
      ICD: { library_path: "../../../Frameworks/libMoltenVK.dylib", api_version: "1.3.0" }
    }));
    const graphicsMetadata = { minimumBaseMacOS: "14.0.0", graphicsCapabilities: { dxmt: true, moltenvk: true,
      minimumMacOS: { dxmt: "14.0.0", moltenvk: "11.0.0" } }, componentVersions: { dxmt: "fixture-1" } };
    const result = { version, installDir, engineRoot: installDir, templateRoot, graphicsMetadata,
      executablePath, serverPath, ready: true,
      needsRosetta: false, sha256: version === "engine-11" ? "1".repeat(64) : "2".repeat(64),
      capabilities: { msync: true } };
    installs.set(version, result);
    return result;
  }
  for (const version of installed) payload(version);
  const manager = { id: "sikarugir", label: "Sikarugir",
    getState: () => ({ installed: [...installs.values()], catalog: { versions: ["engine-12", "engine-11"] } }),
    resolveSelection(entry, settings) {
      const version = entry.runtimeData?.sikarugir?.version || settings.runtimes?.sikarugir?.defaultVersion || "engine-12";
      return { version, ready: installs.has(version), install: installs.get(version), reason: "Runtime is not installed." };
    },
    resolveForPlay(entry, context) { calls.push({ stage: "check" }); return this.resolveSelection(entry, context.settings); },
    installRuntime: async options => { calls.push({ stage: "install", version: options.version }); return payload(options.version); },
    updateSettingsAfterInstall: () => assert.fail("automatic Play must preserve global runtime defaults") };
  const graphics = async options => {
    const { install, settings, executableArchitecture } = options;
    calls.push({ stage: "graphics", version: install.version, backend: settings.graphicsBackend, executableArchitecture,
      translatorPlan: options.translatorPlan });
    return Graphics.prepareGraphicsView(options);
  };
  const run = async (_wine, _server, args, options) => {
    const stage = args[0] === "wineboot.exe" ? "boot" : args[0] === "winecfg.exe" ? "prefix-windows-version"
      : args[0] === "reg.exe" && args[2]?.startsWith("HKCU\\Software\\Wine\\AppDefaults\\") ? "app-windows-version" : args[0];
    calls.push({ stage, args });
    write(path.join(options.env.WINEPREFIX, "system.reg"), "registry");
    write(path.join(options.env.WINEPREFIX, "user.reg"), "registry");
    return { stdout: "", stderr: "" };
  };
  const provider = Provider.createProvider({ manager, platform: "darwin", launch: Launch,
    launchDependencies: { prepareGraphicsView: graphics, run,
      rosetta: { isAvailable: () => true }, host: { platform: "darwin", hardwareArch: "arm64", macOSVersion: "15.0" } } });
  provider.runtime = manifest.runtime.entries.sikarugir;
  const mod = composeRuntimeProviders({ id: manifest.id, manifest, runtimeManagers: [manager],
    normalizeRuntimeId: () => "sikarugir", filterRuntimeSupport: () => [], canLaunchRuntime: () => false }, [provider]);
  const injectedRegistry = { ...Modules, listModuleIds: () => ["crossover"], listSharedRuntimeManagers: () => [],
    getModule: id => id === "crossover" ? mod : Modules.getModule(id),
    getModuleInfo: id => id === "crossover" ? mod.manifest : Modules.getModuleInfo(id),
    listModules: () => Modules.listModules().map(info => info.id === "crossover" ? mod.manifest : info) };
  const core = launcher({ userDataDir, registry: injectedRegistry,
    confirmRuntimeInstall: plan => { calls.push({ stage: "consent", plan }); return approval; },
    rosetta: { requiresForExecutable: () => false },
    ...(native ? {} : { spawn: (command, args, options) => {
      calls.push({ stage: "spawn", command, args, options });
      const launched = fakeChild(); children.push(launched); return launched.child;
    } }) });
  t.after(() => children.forEach(child => child.close()));
  return { root, userDataDir, core, calls, installs, manager, payload, Launch };
}

test("startup, import inspection and managed Windows runtime state stay offline", t => {
  const { root, userDataDir } = fixture(t), game = pe(path.join(root, "Unknown", "Game.exe"));
  // Start before any module is loaded, so initialization is covered as well as
  // ordinary entry resolution and the first Runtimes state read.
  const program = `
    globalThis.fetch = () => { throw new Error("Unexpected startup network"); };
    for (const transport of [require("node:http"), require("node:https")]) {
      transport.request = transport.get = () => { throw new Error("Unexpected startup network"); };
    }
    (async () => {
      const fs = require("node:fs");
      const Modules = require(${JSON.stringify(path.resolve(__dirname, "../src/modules/registry.js"))});
      const { createLauncher } = require(${JSON.stringify(path.resolve(__dirname, "../src/core/launcher.js"))});
      const userDataDir = process.argv[1], game = process.argv[2];
      const entry = await createLauncher({ userDataDir }).resolveEntry(game, { persist: false });
      const manager = Modules.getModule("crossover").runtimeManagers.find(manager => manager.id === "sikarugir");
      if (!manager) throw new Error("Sikarugir manager is missing");
      const state = manager.getState({ userDataDir, settings: {} });
      console.log(JSON.stringify({ moduleId: entry.moduleId, runtimeId: entry.runtimeId,
        installed: state.installed?.length ?? state.sections?.flatMap(section => section.installed || []).length,
        createdData: fs.existsSync(userDataDir) }));
    })().catch(error => { console.error(error.stack); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ["-e", program, userDataDir, game], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.deepEqual(output, { moduleId: "crossover", runtimeId: "sikarugir", installed: 0, createdData: false });
});

test("unknown Windows imports select Sikarugir and preserve the generic folder ambiguity rule", async t => {
  const { root, userDataDir } = fixture(t), Modules = registry(), core = launcher({ userDataDir });
  const windows = path.join(root, "Unknown"), executable = pe(path.join(windows, "Game.exe"));
  const entry = await core.resolveEntry(windows);
  assert.equal(entry.moduleId, "crossover"); assert.equal(entry.runtimeId, "sikarugir");
  assert.equal(entry.moduleData.executablePath, executable);
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false, "import does not install a runtime");
  const settings = pe(path.join(windows, "Settings.exe"));
  assert.equal(Modules.detectGame(windows).moduleData.executablePath, executable, "a settings tool does not compete with the game");
  pe(path.join(windows, "Sequel.exe"));
  assert.throws(() => Modules.detectGame(windows), error => error.code === "DETECTION_CONFLICT" && /Select one \.exe/.test(error.message));
  assert.equal(Modules.detectGame(settings).moduleData.executablePath, settings);
  assert.equal(Modules.detectGame(executable).moduleId, "crossover");
  // A single wrapper folder is detected as the game; deeper executables are not.
  const nested = path.join(root, "NestedOnly"); pe(path.join(nested, "bin", "Game.exe")); fs.mkdirSync(path.join(nested, "data"));
  assert.notEqual(Modules.explainDetection(nested).selectedModuleId, "crossover");
  const x64 = await core.resolveEntry(pe(path.join(root, "Unknown64", "Game.exe"), 0x8664));
  assert.equal(x64.runtimeId, "sikarugir"); assert.equal(x64.moduleData.executableArchitecture, "x86_64");
});

test("Windows provider availability preserves known engine defaults and excludes native and Linux imports", async t => {
  const { root, userDataDir } = fixture(t), Modules = registry(), core = launcher({ userDataDir });
  const { resolveRuntimeSupportForEntry } = require("../src/core/launch-capability");
  const support = entry => {
    const mod = Modules.getModule(entry.moduleId);
    return resolveRuntimeSupportForEntry(mod, mod.manifest, entry, {}, { userDataDir, settings: {} });
  };
  const rgss = path.join(root, "RPG"); pe(path.join(rgss, "Game.exe"));
  write(path.join(rgss, "Game.ini"), "[Game]\nLibrary=RGSS301.dll\nScripts=Data/Scripts.rvdata2\nTitle=Quest\n");
  write(path.join(rgss, "Data", "Scripts.rvdata2"), "scripts");
  const rpg = await core.resolveEntry(rgss, { persist: false });
  assert.equal(rpg.moduleId, "rgss"); assert.equal(rpg.runtimeId, "mkxpz");
  assert.ok(support(rpg).includes("sikarugir"));
  assert.equal((await core.resolveEntry(rgss, { persist: false, runtimeId: "sikarugir" })).runtimeId, "sikarugir");

  const unity = path.join(root, "Unity"); const unityExe = pe(path.join(unity, "Quest.exe"), 0x8664);
  unityData(path.join(unity, "Quest_Data"));
  const windowsUnity = await core.resolveEntry(unityExe, { persist: false });
  assert.equal(windowsUnity.moduleId, "unity"); assert.equal(windowsUnity.runtimeId, "unity");
  assert.ok(support(windowsUnity).includes("sikarugir"));

  for (const name of ["Quest.x86_64", "Quest"]) {
    const linux = path.join(root, "Linux-" + name);
    const linuxExe = write(path.join(linux, name), Buffer.from([127, 69, 76, 70, 2, 1, 1, ...Array(57).fill(0)]));
    unityData(path.join(linux, "Quest_Data")); pe(path.join(linux, "Unrelated.exe"));
    const linuxUnity = await core.resolveEntry(linuxExe, { persist: false });
    assert.equal(linuxUnity.moduleId, "unity");
    assert.equal(support(linuxUnity).includes("sikarugir"), false, `an explicit ELF ${name} must not inherit a sibling PE`);
  }

  const native = path.join(root, "Quest.app");
  unityData(path.join(native, "Contents", "Resources", "Data"));
  write(path.join(native, "Contents", "Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>Quest</string></dict></plist>');
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(0x0100000c, 4); macho.writeUInt32LE(2, 12);
  write(path.join(native, "Contents", "MacOS", "Quest"), macho); pe(path.join(root, "Unrelated.exe"));
  pe(path.join(native, "Contents", "Resources", "Helper.exe"));
  const nativeUnity = await core.resolveEntry(native, { persist: false });
  assert.equal(nativeUnity.moduleId, "unity"); assert.equal(nativeUnity.nativeAppPath, native);
  assert.equal(support(nativeUnity).includes("sikarugir"), false);
});

test("adding managed Wine retains existing CrossOver choices, local versions and runtime settings", async t => {
  const { root, userDataDir } = fixture(t), app = path.join(root, "CrossOver.app");
  const crossRoot = path.join(app, "Contents", "SharedSupport", "CrossOver");
  write(path.join(app, "Contents", "Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>26.3</string></dict></plist>');
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(0x0100000c, 4); macho.writeUInt32LE(2, 12);
  for (const command of ["wineloader", "wineserver"]) {
    const file = write(path.join(crossRoot, "bin", command), macho); fs.chmodSync(file, 0o755);
  }
  for (const command of ["wine", "cxbottle"]) {
    const file = write(path.join(crossRoot, "bin", command), "#!/usr/bin/perl\n"); fs.chmodSync(file, 0o755);
  }
  fs.mkdirSync(path.join(crossRoot, "share", "crossover", "bottle_templates", "win10_64"), { recursive: true });
  const manager = require("../src/modules/crossover/runtime/manager");
  const imported = manager.importRuntime({ userDataDir, runtimePath: app });
  const core = launcher({ userDataDir }), game = pe(path.join(root, "Existing", "Game.exe"));
  const entry = await core.resolveEntry(game);
  entry.runtimeId = "crossover";
  entry.runtimeData.crossover.version = imported.version;
  entry.runtimeSettings = { crossover: { locale: "ja_JP.UTF-8", graphicsBackend: "dxmt", bepInExWinhttp: true } };
  core.persistEntry(entry);
  const refreshed = await core.resolveEntry(game);
  assert.equal(refreshed.runtimeId, "crossover");
  assert.equal(refreshed.runtimeData.crossover.version, imported.version);
  assert.deepEqual(refreshed.runtimeSettings, entry.runtimeSettings);
  const settingsFile = write(path.join(userDataDir, "settings.json"), JSON.stringify({
    modules: { crossover: { defaultRuntime: "crossover" } }, runtimes: { crossover: { defaultVersion: imported.version } }
  }));
  const stored = fs.readFileSync(settingsFile);
  const next = await core.resolveEntry(pe(path.join(root, "New", "Game.exe")));
  assert.equal(next.runtimeId, "crossover");
  assert.deepEqual(fs.readFileSync(settingsFile), stored);
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes", "sikarugir")), false);
});

test("ordinary Play obtains one consent, prepares the Windows environment and runs original game files", async t => {
  const { root, userDataDir, core, calls } = managedFixture(t);
  const source = path.join(root, "Unknown64"), original = pe(path.join(source, "Game.exe"), 0x8664);
  write(path.join(source, "settings.ini"), "original settings");
  const before = fs.readFileSync(original), entry = await core.resolveEntry(original);
  entry.runtimeSettings = { sikarugir: { graphicsBackend: "dxmt", locale: "ja_JP.UTF-8", bepInExWinhttp: true, arguments: ["--windowed"] } };
  entry.networkAccess = true; // launch routing, not network policy, is under test
  core.persistEntry(entry);
  assert.equal(calls.length, 0, "import does not prepare or download Wine");
  const result = await core.launchEntry(entry);
  assert.equal(result.kind, "process"); assert.equal(result.runtimeId, "sikarugir");
  assert.deepEqual(calls.map(call => call.stage), ["check", "consent", "install", "graphics", "boot", "prefix-windows-version", "app-windows-version", "spawn"]);
  assert.deepEqual(calls.find(call => call.stage === "prefix-windows-version").args, ["winecfg.exe", "-v", "win10"]);
  assert.deepEqual(calls.find(call => call.stage === "app-windows-version").args,
    ["reg.exe", "add", "HKCU\\Software\\Wine\\AppDefaults\\Game.exe", "/v", "Version", "/t", "REG_SZ", "/d", "win10", "/f"]);
  const prompt = calls.find(call => call.stage === "consent").plan;
  assert.equal(prompt.managerId, "sikarugir"); assert.equal(prompt.version, "engine-12");
  assert.equal(prompt.requiresDownload, true);
  const spawned = calls.find(call => call.stage === "spawn");
  const state = entry.runtimeData.sikarugir;
  const plan = calls.find(call => call.stage === "graphics").translatorPlan;
  const { RELATIVE_PATHS } = require("../src/modules/crossover/sikarugir/runtime/template-closure");
  assert.equal(plan.components["vulkan-driver"].used.icd,
    path.join(root, "runtime-payloads", "engine-12", "support", RELATIVE_PATHS.vulkan, "MoltenVK_icd.json"));
  assert.equal(plan.components["d3d-renderer"].fallback, false);
  assert.deepEqual(plan.components["d3d-renderer"].used.files.flatMap(file => (file.slices || []).flatMap(slice => slice.imports || [])).map(({ symbol, library }) => ({ symbol, library })),
    [{ symbol: "wine_unix_call", library: "@rpath/ntdll.so" }]);
  assert.ok(plan.record.modules["ntdll.so"].exports.includes("wine_unix_call"));
  assert.equal(spawned.command, "/bin/sh"); assert.equal(spawned.args[2], "maclauncher-wine");
  assert.equal(spawned.options.cwd, state.gameRoot);
  assert.equal(spawned.options.env.WINEPREFIX, state.prefixPath);
  assert.equal(spawned.options.env.LC_ALL, "ja_JP.UTF-8");
  assert.equal(spawned.options.env.WINEMSYNC, "1");
  assert.match(spawned.options.env.WINEDLLOVERRIDES, /winhttp=n,b/);
  assert.match(spawned.options.env.WINEDLLOVERRIDES, /d3d10core=b;d3d11=b;dxgi=b;winemetal=b/);
  assert.deepEqual(spawned.args.slice(-6), ["start.exe", "/d", "G:\\", "/exec", "G:\\Game.exe", "--windowed"]);
  const gameDrive = path.join(state.prefixPath, "dosdevices", "g:");
  assert.equal(fs.realpathSync(path.join(gameDrive, "Game.exe")), fs.realpathSync(original), "the prefix's own game drive maps the original folder");
  assert.equal(fs.realpathSync(state.gameRoot), fs.realpathSync(source));
  assert.deepEqual(fs.readFileSync(path.join(state.gameRoot, "Game.exe")), before);
  const privateWine = path.join(state.viewRoot, "wine"), installedWine = path.join(root, "runtime-payloads", "engine-12");
  // A single-file loader runs the game from the Game Mode bundle.
  const bundle = path.join(privateWine, "MacLauncher Game.app", "Contents");
  assert.equal(spawned.args[3], path.join(bundle, "MacOS", "wine"));
  assert.match(fs.readFileSync(path.join(bundle, "Info.plist"), "utf8"), /<key>LSApplicationCategoryType<\/key>\s*<string>public\.app-category\.games<\/string>/);
  assert.equal(spawned.args[4], path.join(privateWine, "bin", "wineserver"));
  assert.equal(fs.lstatSync(spawned.args[3]).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(spawned.args[3]), fs.readFileSync(path.join(installedWine, "bin", "wine")));
  assert.ok(fs.lstatSync(spawned.args[4]).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(privateWine, "lib", "wine", "x86_64-windows", "d3d11.dll")).isSymbolicLink());
  assert.deepEqual(spawned.options.env.WINEDLLPATH.split(path.delimiter), [
    path.join(privateWine, "lib", "wine", "i386-windows"), path.join(privateWine, "lib", "wine", "x86_64-windows"),
    path.join(privateWine, "lib", "wine"), fs.realpathSync(path.join(installedWine, "lib", "wine"))]);
  assert.equal(JSON.parse(fs.readFileSync(spawned.options.env.VK_DRIVER_FILES)).ICD.library_path,
    fs.realpathSync(path.join(root, "runtime-payloads", "engine-12", "support", "Frameworks", "libMoltenVK.dylib")));
  assert.equal(fs.realpathSync(state.gameRoot), fs.realpathSync(source));
  fs.writeFileSync(path.join(state.gameRoot, "settings.ini"), "private settings");
  assert.equal(fs.readFileSync(path.join(source, "settings.ini"), "utf8"), "private settings");
  assert.deepEqual(fs.readFileSync(original), before);
  assert.equal(entry.gamePath, source); assert.equal(entry.contentRootDir, source);
  assert.equal(core.getLaunchContext(entry).isGameRunning(), true);
  assert.equal(fs.existsSync(path.join(userDataDir, "settings.json")), false);
  const persisted = require("../src/core/game-store").readGameRecord(userDataDir, entry.gameId);
  assert.equal(persisted.runtimeData.sikarugir.installedVersion, "engine-12");
  assert.equal(persisted.runtimeSettings.sikarugir.graphicsBackend, "dxmt");
});

test("declining Sikarugir Play leaves engine, graphics and private game preparation untouched", async t => {
  const { root, userDataDir, core, calls, installs } = managedFixture(t, { approval: false });
  const source = path.join(root, "Unknown"), original = pe(path.join(source, "Game.exe"));
  const entry = await core.resolveEntry(original), before = fs.readFileSync(original);
  assert.equal((await core.launchEntry(entry)).kind, "cancelled");
  assert.deepEqual(calls.map(call => call.stage), ["check", "consent"]);
  assert.equal(installs.size, 0);
  assert.equal(fs.existsSync(path.join(userDataDir, "games", entry.gameId, "runtimes", "sikarugir")), false);
  assert.deepEqual(fs.readFileSync(original), before);
  assert.equal(core.getLaunchContext(entry).isGameRunning(), false);
});

test("offline replay retains selected versions, global and game settings, private saves and the completed prefix", async t => {
  const { root, userDataDir, core, calls } = managedFixture(t, { installed: ["engine-11", "engine-12"] });
  const settingsPath = write(path.join(userDataDir, "settings.json"), JSON.stringify({
    runtimes: { sikarugir: { defaultVersion: "engine-12" } },
    modules: { crossover: { runtimeSettings: { sikarugir: { locale: "fr_FR.UTF-8", graphicsBackend: "wined3d" } } } }
  }));
  const settingsBytes = fs.readFileSync(settingsPath);
  core.runtimeSettingsStore.writeDefaults("sikarugir", registry().getModuleInfo("crossover"), { wineDebug: "-all", synchronization: "off" });
  const defaultsPath = path.join(userDataDir, "runtimes", "sikarugir", "settings.json"), defaultsBytes = fs.readFileSync(defaultsPath);
  const original = pe(path.join(root, "Unknown", "Game.exe"));
  const executableBytes = fs.readFileSync(original);
  const entry = await core.resolveEntry(original);
  entry.runtimeData.sikarugir = { ...entry.runtimeData.sikarugir, version: "engine-11" };
  entry.runtimeSettings = { sikarugir: { locale: "ja_JP.UTF-8", arguments: ["--windowed"] } };
  entry.networkAccess = true; // launch routing, not network policy, is under test
  core.persistEntry(entry);
  const first = await core.launchEntry(entry), initial = { ...entry.runtimeData.sikarugir };
  const prefixMarker = fs.readFileSync(path.join(initial.prefixPath, "maclauncher-prefix.json"));
  assert.equal(initial.installedVersion, "engine-11");
  assert.equal(calls.some(call => ["consent", "install"].includes(call.stage)), false);
  const firstSpawn = calls.find(call => call.stage === "spawn");
  assert.equal(firstSpawn.options.env.LC_ALL, "ja_JP.UTF-8");
  assert.equal(firstSpawn.options.env.WINEMSYNC, "0");
  write(path.join(initial.gameRoot, "Save01.dat"), "private game save");
  write(path.join(initial.prefixPath, "drive_c", "users", "wine", "Documents", "save.dat"), "private Windows save");
  first.child.exitCode = 0; first.child.emit("exit", 0); first.child.emit("close", 0);
  calls.length = 0;
  const rediscovered = await core.resolveEntry(original);
  assert.equal(rediscovered.runtimeData.sikarugir.version, "engine-11");
  assert.deepEqual(rediscovered.runtimeSettings.sikarugir, entry.runtimeSettings.sikarugir);
  await core.launchEntry(rediscovered);
  assert.deepEqual(calls.map(call => call.stage), ["check", "graphics", "app-windows-version", "spawn"]);
  assert.deepEqual(calls.find(call => call.stage === "app-windows-version").args,
    ["reg.exe", "add", "HKCU\\Software\\Wine\\AppDefaults\\Game.exe", "/v", "Version", "/t", "REG_SZ", "/d", "win10", "/f"]);
  assert.deepEqual(fs.readFileSync(original), executableBytes);
  assert.deepEqual(fs.readFileSync(path.join(initial.prefixPath, "maclauncher-prefix.json")), prefixMarker);
  assert.equal(rediscovered.runtimeData.sikarugir.prefixPath, initial.prefixPath);
  assert.equal(fs.readFileSync(path.join(initial.gameRoot, "Save01.dat"), "utf8"), "private game save");
  assert.equal(fs.readFileSync(path.join(initial.prefixPath, "drive_c", "users", "wine", "Documents", "save.dat"), "utf8"), "private Windows save");
  assert.equal(fs.readFileSync(path.join(path.dirname(original), "Save01.dat"), "utf8"), "private game save");
  assert.deepEqual(fs.readFileSync(settingsPath), settingsBytes);
  assert.deepEqual(fs.readFileSync(defaultsPath), defaultsBytes);
});

test("Stop ends only the selected private prefix and keeps independently spawned Windows children tracked", async t => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const { root, core, installs } = managedFixture(t, { installed: ["engine-12"], native: true });
  const { stopProcessTree } = require("../src/core/process-stop");
  const install = installs.get("engine-12"), runs = [], windowsPids = [];
  const childProgram = `const fs=require('node:fs'),path=require('node:path');
    const root=process.env.WINEPREFIX;
    process.on('SIGTERM',()=>{fs.writeFileSync(path.join(root,'windows-closed'),'yes');process.exit(0)});
    fs.writeFileSync(path.join(root,'windows-environment.json'),JSON.stringify({dlls:process.env.WINEDLLPATH,
      libraries:process.env.DYLD_LIBRARY_PATH,frameworks:process.env.DYLD_FRAMEWORK_PATH,
      fallbackLibraries:process.env.DYLD_FALLBACK_LIBRARY_PATH,fallbackFrameworks:process.env.DYLD_FALLBACK_FRAMEWORK_PATH}));
    fs.writeFileSync(path.join(root,'windows-ready'),'yes');${untilTestEnds}`;
  write(install.executablePath, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
    fs.writeFileSync(path.join(process.env.WINEPREFIX,'wine-arguments.json'),JSON.stringify(process.argv.slice(2)));
    const child=spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{detached:true,stdio:'ignore'});
    fs.writeFileSync(path.join(process.env.WINEPREFIX,'windows.pid'),String(child.pid));child.unref();\n`);
  write(install.serverPath, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');
    const root=process.env.WINEPREFIX;
    if(process.argv[2]==='-k'){
      fs.writeFileSync(path.join(root,'stop-requested'),'yes');
      try{process.kill(Number(fs.readFileSync(path.join(root,'windows.pid'),'utf8')),'SIGTERM')}catch{}
    }else if(process.argv[2]==='-w'){
      const deadline=Date.now()+8000;const timer=setInterval(()=>{
        if(fs.existsSync(path.join(root,'windows-closed'))){clearInterval(timer);process.exit(0)}
        if(Date.now()>deadline){clearInterval(timer);process.exit(1)}
      },20);
    }\n`);
  fs.chmodSync(install.executablePath, 0o755); fs.chmodSync(install.serverPath, 0o755);
  const waitUntil = async condition => {
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(condition(), "owned native fixture did not reach the expected state");
  };
  const close = child => new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) return resolve();
    const timeout = setTimeout(() => reject(new Error("Owned Wine supervisor did not close")), 5000);
    child.once("close", () => { clearTimeout(timeout); resolve(); });
  });
  try {
    for (const name of ["First", "Second"]) {
      const entry = await core.resolveEntry(pe(path.join(root, name, "Game.exe")));
      entry.networkAccess = true; // launch routing, not network policy, is under test
      const { child } = await core.launchEntry(entry);
      runs.push({ entry, child });
      const prefix = entry.runtimeData.sikarugir.prefixPath;
      await waitUntil(() => fs.existsSync(path.join(prefix, "windows-ready")));
      windowsPids.push(Number(fs.readFileSync(path.join(prefix, "windows.pid"), "utf8")));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(prefix, "wine-arguments.json"))), ["start.exe", "/d", "G:\\", "/exec", "G:\\Game.exe"]);
      assert.equal(fs.realpathSync(path.join(prefix, "dosdevices", "g:")), fs.realpathSync(entry.runtimeData.sikarugir.gameRoot));
      const environment = JSON.parse(fs.readFileSync(path.join(prefix, "windows-environment.json")));
      const privateDllRoot = path.join(entry.runtimeData.sikarugir.viewRoot, "wine", "lib", "wine");
      assert.deepEqual(environment.dlls.split(path.delimiter), [path.join(privateDllRoot, "i386-windows"),
        path.join(privateDllRoot, "x86_64-windows"), privateDllRoot, fs.realpathSync(path.join(install.engineRoot, "lib", "wine"))]);
      // Only the private ntdll override is a library override; Wine's own and vendor libraries are fallbacks.
      assert.deepEqual(environment.libraries?.split(path.delimiter), [path.join(entry.runtimeData.sikarugir.viewRoot, "wine", "loader-libraries")],
        "the private ntdll override must survive the protected supervisor shell");
      assert.ok(environment.fallbackLibraries?.split(path.delimiter).includes(path.join(privateDllRoot, "x86_64-unix")),
        "private graphics library paths must survive the protected supervisor shell");
      assert.ok(!environment.frameworks, "vendor frameworks never override system frameworks");
      assert.ok(environment.fallbackFrameworks?.split(path.delimiter).includes(fs.realpathSync(path.join(install.templateRoot, "Frameworks"))));
      assert.equal(child.exitCode, null, "the wrapper remains alive after Wine's initial process exits");
      assert.equal(core.getLaunchContext(entry).isGameRunning(), true);
    }
    const [first, second] = runs, firstPrefix = first.entry.runtimeData.sikarugir.prefixPath, secondPrefix = second.entry.runtimeData.sikarugir.prefixPath;
    assert.notEqual(firstPrefix, secondPrefix);
    const firstClosed = close(first.child);
    assert.equal(stopProcessTree(first.child.pid, { graceMs: 1000 }), true);
    await firstClosed;
    await new Promise(resolve => setImmediate(resolve)); // ownership retires after process-stop settlement
    assert.equal(fs.readFileSync(path.join(firstPrefix, "windows-closed"), "utf8"), "yes");
    assert.equal(core.getLaunchContext(first.entry).isGameRunning(), false);
    assert.equal(core.getLaunchContext(second.entry).isGameRunning(), true);
    assert.equal(fs.existsSync(path.join(secondPrefix, "stop-requested")), false);
    assert.doesNotThrow(() => process.kill(windowsPids[1], 0));
    const secondClosed = close(second.child);
    assert.equal(stopProcessTree(second.child.pid, { graceMs: 1000 }), true);
    await secondClosed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fs.readFileSync(path.join(secondPrefix, "windows-closed"), "utf8"), "yes");
    assert.equal(core.getLaunchContext(second.entry).isGameRunning(), false);
  } finally {
    for (const { child } of runs) {
      if (child.exitCode == null && child.signalCode == null) { stopProcessTree(child.pid, { graceMs: 100 }); await close(child).catch(() => {}); }
    }
    for (const pid of windowsPids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
});
