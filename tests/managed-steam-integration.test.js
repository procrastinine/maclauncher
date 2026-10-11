const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Fna = require("../src/modules/fna/main");
const FnaDetect = require("../src/modules/fna/detect");
const FnaManager = require("../src/modules/fna/runtime/manager");
const FnaBuild = require("../src/modules/fna/runtime/build");
const FnaSteam = require("../src/modules/fna/steam");
const UnityDetect = require("../src/modules/unity/detect");
const UnityLaunch = require("../src/modules/unity/launch");
const Unity = require("../src/modules/unity/main");
const UnityManager = require("../src/modules/unity/runtime/manager");
const UnitySteam = require("../src/modules/unity/steam");
const Native = require("../src/modules/shared/runtime/local-native");
const ManagedSteam = require("../src/modules/shared/runtime/steamworks/managed-profile");
const { managedAssembly, writeAssembly } = require("./helpers/fna-assembly");
const { game: unityGame } = require("./helpers/unity-assets");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "managed-steam-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function selectedFna(root) {
  const runtime = path.join(root, "runtime"); fs.mkdirSync(runtime);
  for (const name of ["FNA.dll", "MacLauncherFnaHost.dll", "MacLauncherFnaHost.runtimeconfig.json"]) fs.writeFileSync(path.join(runtime, name), "reviewed " + name);
  return { ready: true, version: FnaBuild.PROFILE, install: { executablePath: path.join(runtime, "dotnet") }, profile: {
    root: runtime, architecture: "arm64", frameworkVersion: "26.10.0.0", dotnetVersion: FnaBuild.DOTNET_VERSION,
    files: { "FNA.dll": Native.hashFile(path.join(runtime, "FNA.dll")) }
  } };
}
function fnaGame(t, imports = [], options = {}) {
  const root = temporary(t), source = path.join(root, "original"); fs.mkdirSync(source);
  const assembly = writeAssembly(path.join(source, "Game.exe"), { ...options, nativeImports: imports });
  writeAssembly(path.join(source, "FNA.dll"), { name: "FNA", entryPoint: false, references: [] });
  fs.writeFileSync(path.join(source, "steam_appid.txt"), "480\n");
  return { root, source, assembly, entry: { gameId: "fna-game", gamePath: assembly, moduleData: FnaDetect.inspectGameAssembly(assembly) } };
}
function trustedContext(root, calls) {
  const libraryPath = path.join(root, "shared-helper.dylib"); fs.writeFileSync(libraryPath, "verified native test dependency");
  return { userDataDir: path.join(root, "launcher"), settings: {}, runtimeSettings: {},
    prepareSteamApi: async (request, { baseEnvironment }) => {
      calls.push(request);
      return { libraryPath, mode: "offline", version: "fixture-v1", sha256: "a".repeat(64), sourceRevision: "b".repeat(40),
        aliases: [...new Set(["libsteam_api.dylib", ...request.aliases])].sort(),
        identity: { version: "fixture-v1", sha256: "a".repeat(64), architecture: request.arch },
        environment: { ...baseEnvironment, SteamAppId: String(request.appId.value), MACLAUNCHER_STEAM_SETTINGS: request.ownedDirectory } };
    } };
}

test("FNA preserves exact transitive P/Invoke symbols and bounded source evidence", t => {
  const { assembly, source } = fnaGame(t, [], { references: [{ name: "Wrapper", version: [1, 0, 0, 0] }] });
  writeAssembly(path.join(source, "Wrapper.dll"), { name: "Wrapper", entryPoint: false,
    nativeImports: [{ library: "steam_api64.dll", name: "SteamAPI_Init" }, { library: "steam_api64.dll", name: "GetHSteamUser" }] });
  const info = FnaDetect.inspectGameAssembly(assembly);
  assert.deepEqual(info.nativeLibraries, ["steam_api64.dll"]);
  assert.deepEqual(info.nativeImportEvidence.map(item => [path.basename(item.assemblyPath), item.assemblyName, item.library, item.name]),
    [["Wrapper.dll", "Wrapper", "steam_api64.dll", "SteamAPI_Init"], ["Wrapper.dll", "Wrapper", "steam_api64.dll", "GetHSteamUser"]]);
  const limited = FnaDetect.inspectGameAssembly(assembly, { limits: { maxNativeImportEvidence: 1 } });
  assert.equal(limited.nativeImportEvidence.length, 1); assert.equal(limited.dependencyInspection.complete, false);
  assert.match(limited.dependencyInspection.issues[0].reason, /Native import evidence limit/);
});

test("embedded FNA consumer evidence retains the real parent and exact resource identity", t => {
  const bytes = managedAssembly({ name: "Wrapper", entryPoint: false,
    nativeImports: [{ library: "steam_api", name: "SteamAPI_Init" }] });
  const { source, assembly } = fnaGame(t, [], {
    references: [{ name: "Wrapper", version: [1, 0, 0, 0] }],
    resources: [{ name: "Game.Libraries.Wrapper.dll", bytes }]
  });
  const info = FnaDetect.inspectGameAssembly(assembly), [imported] = FnaSteam.consumerImports(info);
  assert.equal(imported.assemblyPath, assembly); assert.equal(imported.resourceName, "Game.Libraries.Wrapper.dll");
  assert.equal(imported.assemblyName, "Wrapper"); assert.equal(imported.name, "SteamAPI_Init");
  assert.equal(fs.existsSync(path.join(source, "Wrapper.dll")), false);
});

test("FNA automatically supplies the shared dependency and preserves original Windows SDK bytes", async t => {
  const { root, source, entry } = fnaGame(t, [{ library: "steam_api64.dll", name: "SteamAPI_Init" }, { library: "steam_api64.dll", name: "GetHSteamUser" }]);
  const windowsSdk = path.join(source, "steam_api64.dll"); fs.writeFileSync(windowsSdk, "MZ original SDK bytes");
  const original = Native.hashFile(windowsSdk), calls = [], context = trustedContext(root, calls), selected = selectedFna(root);
  t.mock.method(FnaManager, "resolveSelection", () => selected);
  let launched; context.spawnDetachedChecked = (...args) => { launched = args; return { pid: 1 }; };
  await Fna.launchRuntime("fna", entry, context);
  assert.equal(calls.length, 1); assert.equal(calls[0].appId.value, 480); assert.equal(calls[0].arch, "arm64");
  assert.deepEqual(calls[0].symbols, ["SteamAPI_Init", "GetHSteamUser"]);
  assert.ok(calls[0].aliases.includes("steam_api64.dll.dylib"));
  assert.equal(calls[0].nativeLibraryPaths.includes(windowsSdk), true);
  assert.ok(calls[0].ownedDirectory.startsWith(path.join(context.userDataDir, "games", entry.gameId)));
  assert.equal(launched[2].env.SteamAppId, "480"); assert.equal(launched[2].env.DOTNET_ROOT, selected.profile.root);
  assert.equal(Native.hashFile(windowsSdk), original);
  assert.equal(fs.readFileSync(path.join(launched[2].cwd, "steam_api64.dll"), "utf8"), "MZ original SDK bytes");
});

test("Steam-looking DLL names without actual Steam consumer symbols do no dependency work", async t => {
  const { root, entry } = fnaGame(t, [{ library: "steam_api.dll", name: "UnrelatedFunction" }]);
  const selected = selectedFna(root); t.mock.method(FnaManager, "resolveSelection", () => selected);
  const context = { userDataDir: path.join(root, "launcher"), settings: {}, runtimeSettings: {},
    prepareSteamApi: () => { throw new Error("No Steam consumer"); }, spawnDetachedChecked: () => ({ pid: 1 }) };
  await Fna.launchRuntime("fna", entry, context);
  assert.equal(fs.existsSync(path.join(context.userDataDir, "games", entry.gameId, "modules", "fna", "steam-api")), false);
  assert.deepEqual(UnitySteam.consumerImports({ nativeImportEvidence: [{ library: "steam_api", name: "UnrelatedFunction" }] }), []);
});

test("FNA retains Windows/32-bit blockers and rejects unsupported Steam API before spawn", async t => {
  const narrow = fnaGame(t, [{ library: "steam_api", name: "SteamAPI_Init" }], { flags: 3 });
  let prepared = 0;
  await assert.rejects(Fna.launchRuntime("fna", narrow.entry, { userDataDir: path.join(narrow.root, "data"),
    prepareSteamApi: () => { prepared++; }, settings: {}, runtimeSettings: {} }), /32-bit CLR/);
  assert.equal(prepared, 0);
  const desktop = fnaGame(t, [{ library: "steam_api", name: "SteamAPI_Init" }], { types: [{ namespace: "System.Windows.Threading", name: "Dispatcher" }] });
  await assert.rejects(Fna.launchRuntime("fna", desktop.entry, { userDataDir: path.join(desktop.root, "data"),
    prepareSteamApi: () => { prepared++; }, settings: {}, runtimeSettings: {} }), /WPF/);
  assert.equal(prepared, 0);
  const portable = fnaGame(t, [{ library: "steam_api", name: "SteamAPI_FutureUnsupported" }]);
  const selected = selectedFna(portable.root); t.mock.method(FnaManager, "resolveSelection", () => selected);
  let spawned = false;
  await assert.rejects(Fna.launchRuntime("fna", portable.entry, { userDataDir: path.join(portable.root, "data"), settings: {}, runtimeSettings: {},
    prepareSteamApi: () => { throw Object.assign(new Error("Missing native API version"), { code: "STEAM_API_SYMBOLS_UNAVAILABLE" }); },
    spawnDetachedChecked: () => { spawned = true; } }), error => error.code === "STEAM_API_SYMBOLS_UNAVAILABLE");
  assert.equal(spawned, false);
});

test("managed adapters keep encrypted-ticket and unrelated DLL requirements separate", () => {
  const nativeImportEvidence = [
    { library: "sdkencryptedappticket64.dll", name: "SteamEncryptedAppTicket_BDecryptTicket" },
    { library: "Unrelated.dll", name: "SteamAPI_Init" },
    { library: "steam_api.dll", name: "UnrelatedFunction" }
  ];
  assert.deepEqual(FnaSteam.consumerImports({ nativeImportEvidence }), []);
  assert.deepEqual(UnitySteam.consumerImports({ nativeImportEvidence }), []);
  nativeImportEvidence.push({ library: "steam_api.dll", name: "SteamAPI_Init" });
  for (const adapter of [FnaSteam, UnitySteam]) {
    const imports = adapter.consumerImports({ nativeImportEvidence });
    assert.deepEqual(imports.map(item => item.name), ["UnrelatedFunction", "SteamAPI_Init"]);
    assert.ok(imports.every(item => item.library === "steam_api.dll"));
  }
});

test("FNA maps native names without malformed repeated prefixes or invalid suffixes", () => {
  for (const library of ["steam_api", "steam_api64.dll", "libsteam_api.so", "libsteam_api.dylib"]) {
    const names = FnaSteam.clrAliases([{ library, name: "SteamAPI_Init" }]);
    assert.ok(names.includes(library)); assert.ok(names.includes(library.startsWith("lib") ? "libsteam_api.dylib" : library.includes("64") ? "libsteam_api64.dylib" : "libsteam_api.dylib"));
    assert.ok(names.every(name => !name.startsWith("liblib") && !name.endsWith(".dylib.dylib")));
  }
});

test("FNA and Unity forward a measured consumer identity without changing original assemblies", async t => {
  const fna = fnaGame(t, [{ library: "steam_api", name: "SteamAPI_Init" }]);
  const root = fna.root, calls = [], ctx = trustedContext(root, calls);
  const managed = { abiProfile: "portable-consumer-1", version: "independent-helper-1", managedConsumers: [{ assemblyPath: fna.assembly }] };
  const selected = [];
  t.mock.method(ManagedSteam, "selectManagedProfile", async request => { selected.push(request); return managed; });
  const original = Native.hashFile(fna.assembly);
  await FnaSteam.prepareLaunch({ info: fna.entry.moduleData, context: ctx,
    gameRoot: path.join(ctx.userDataDir, "games", "fna-game", "modules", "fna", "overlays", "runtime"), baseEnvironment: {} });
  assert.equal(calls[0].abiProfile, managed.abiProfile); assert.equal(calls[0].version, managed.version);
  assert.deepEqual(calls[0].managedConsumers, managed.managedConsumers); assert.equal(selected[0].architecture, "arm64");
  const dataRoot = path.join(root, "unity-original", "Game_Data"); fs.mkdirSync(dataRoot, { recursive: true });
  const info = { dataRoot, nativeImportEvidence: fna.entry.moduleData.nativeImportEvidence };
  await UnitySteam.prepareLaunch({ info, entry: { gameId: "unity-game" }, context: ctx,
    selection: { install: { needsRosetta: false } }, baseEnvironment: {} });
  assert.equal(calls[1].abiProfile, managed.abiProfile); assert.equal(calls[1].version, managed.version);
  assert.deepEqual(calls[1].managedConsumers, managed.managedConsumers);
  assert.equal(Native.hashFile(fna.assembly), original);
});

test("Unity records exact wrapper imports and requests only Steam native plugins for its selected CPU", async t => {
  const root = temporary(t), original = path.join(root, "original"); fs.mkdirSync(original);
  const game = unityGame(original, { nativeImports: [{ library: "steam_api64", name: "SteamAPI_Init" }] });
  writeAssembly(path.join(game.data, "Managed", "Assembly-CSharp.dll"), { name: "Assembly-CSharp", entryPoint: false,
    references: [{ name: "UnityEngine.CoreModule", version: [0, 0, 0, 0] }, { name: "SteamWrapper", version: [1, 0, 0, 0] }] });
  writeAssembly(path.join(game.data, "Managed", "SteamWrapper.dll"), { name: "SteamWrapper", entryPoint: false, references: [],
    nativeImports: [{ library: "steam_api64.dll", name: "SteamAPI_Init" }, { library: "steam_api64.dll", name: "GetHSteamPipe" }] });
  const plugins = path.join(game.data, "Plugins", "x86_64"); fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(path.join(plugins, "steam_api64.dll"), "MZ Windows SDK"); fs.writeFileSync(path.join(plugins, "Unrelated.dll"), "MZ foreign plugin");
  fs.writeFileSync(path.join(original, "steam_appid.txt"), "480\n");
  const info = UnityDetect.inspectData(game.data), calls = [], context = trustedContext(root, calls), entry = { gameId: "unity-game" };
  assert.deepEqual(info.nativeImports, ["steam_api64.dll"]);
  assert.deepEqual(info.nativeImportEvidence.map(item => [path.basename(item.assemblyPath), item.name]), [["SteamWrapper.dll", "SteamAPI_Init"], ["SteamWrapper.dll", "GetHSteamPipe"]]);
  const prepared = await UnitySteam.prepareLaunch({ info, entry, context, selection: { install: { needsRosetta: true } }, baseEnvironment: { KEEP: "value" } });
  assert.equal(calls[0].arch, "x64"); assert.equal(calls[0].appId.value, 480); assert.deepEqual(calls[0].symbols, ["SteamAPI_Init", "GetHSteamPipe"]);
  assert.equal(calls[0].nativeLibraryPaths.includes(path.join(plugins, "steam_api64.dll")), true);
  assert.equal(calls[0].nativeLibraryPaths.includes(path.join(plugins, "Unrelated.dll")), false);
  assert.equal(prepared.environment.KEEP, "value");
});

test("Unity Steam preparation preserves shaders/backend limits and incomplete API evidence", async t => {
  const root = temporary(t), source = path.join(root, "original"); fs.mkdirSync(source);
  const game = unityGame(source, { nativeImports: [{ library: "steam_api", name: "SteamAPI_Init" }], apis: [2, 18] });
  const entry = { moduleData: { dataRoot: game.data } };
  assert.throws(() => UnityLaunch.preflight(entry), /Direct3D shaders/);
  const info = UnityDetect.inspectData(game.data); info.managedDependencyInspection = { complete: false, issues: [{ reason: "unknown metadata" }] };
  await assert.rejects(UnitySteam.prepareLaunch({ info, entry, context: {}, selection: {}, baseEnvironment: {} }), /inspected completely/);
});

test("Unity's backend automatically prepares one shared dependency before its native spawn", async t => {
  const root = temporary(t), source = path.join(root, "original"); fs.mkdirSync(source);
  const game = unityGame(source, { nativeImports: [{ library: "steam_api64", name: "SteamAPI_Init" }] });
  fs.writeFileSync(path.join(source, "steam_appid.txt"), "480\n");
  const calls = [], context = trustedContext(root, calls), entry = { gameId: "unity-game", moduleData: { dataRoot: game.data } };
  const selection = { ready: true, version: UnityDetect.inspectData(game.data).detectedVersion,
    profile: { templatePath: path.join(root, "player") }, install: { needsRosetta: true } };
  t.mock.method(UnityManager, "resolveSelection", () => selection);
  let prepared, spawned;
  t.mock.method(UnityLaunch, "prepareLaunch", async (_entry, _context, _selection, options) => {
    prepared = options.steam;
    return { executablePath: path.join(root, "native-player"), info: UnityDetect.inspectData(game.data) };
  });
  context.spawnDetachedChecked = (...args) => { spawned = args; return { pid: 1 }; };
  await Unity.launchRuntime("unity", entry, context);
  assert.equal(calls.length, 1); assert.equal(calls[0].arch, "x64");
  assert.equal(prepared.libraryPath, path.join(root, "shared-helper.dylib"));
  assert.equal(spawned[2].env.SteamAppId, "480"); assert.equal(spawned[3], true);
  context.prepareSteamApi = async () => { throw Object.assign(new Error("Missing native API"), { code: "STEAM_API_SYMBOLS_UNAVAILABLE" }); };
  spawned = null;
  await assert.rejects(Unity.launchRuntime("unity", entry, context), error => error.code === "STEAM_API_SYMBOLS_UNAVAILABLE");
  assert.equal(spawned, null);
});

test("Unity validates exact runtime and persisted storage before Steam setup", async t => {
  const root = temporary(t), source = path.join(root, "original"); fs.mkdirSync(source);
  const game = unityGame(source, { nativeImports: [{ library: "steam_api", name: "SteamAPI_Init" }] });
  const entry = { gameId: "unity-game", moduleData: { dataRoot: game.data } }, version = UnityDetect.inspectData(game.data).detectedVersion;
  let selection = { ready: false, reason: "Install the exact native player." }, called = false;
  t.mock.method(UnityManager, "resolveSelection", () => selection);
  const context = { userDataDir: path.join(root, "launcher"), settings: {}, prepareSteamApi: () => { called = true; } };
  await assert.rejects(Unity.launchRuntime("unity", entry, context), /Install the exact/);
  selection = { ready: true, version: "2020.1.18f1", profile: { templatePath: path.join(root, "player") }, install: {} };
  await assert.rejects(Unity.launchRuntime("unity", entry, context), /different version/);
  selection.version = version;
  await assert.rejects(Unity.launchRuntime("unity", { ...entry, gameId: "../../other" }, context), /persisted library game/);
  assert.equal(called, false); assert.equal(fs.existsSync(context.userDataDir), false);
});

test("Unity's private plugin links survive publication, preserve originals and bind warm reuse", async t => {
  const root = temporary(t), original = path.join(root, "original"), template = path.join(root, "player", "UnityPlayer.app"); fs.mkdirSync(original);
  const game = unityGame(original, { nativeImports: [{ library: "steam_api64", name: "SteamAPI_Init" }] });
  const contents = path.join(template, "Contents");
  for (const name of ["MacOS", "Resources", "Frameworks", "Plugins"]) fs.mkdirSync(path.join(contents, name), { recursive: true });
  fs.writeFileSync(path.join(contents, "MacOS", "UnityPlayer"), "native-player"); fs.writeFileSync(path.join(contents, "Plugins", "stock.dylib"), "native-stock-plugin");
  fs.mkdirSync(path.join(game.data, "Plugins")); fs.writeFileSync(path.join(game.data, "Plugins", "steam_api64.dll"), "MZ original SDK");
  const libraryPath = path.join(root, "included-helper.dylib"); fs.writeFileSync(libraryPath, "one shared helper");
  const steam = { mode: "offline", libraryPath, aliases: ["libsteam_api.dylib", "steam_api64.dylib"],
    identity: { version: "fixture-v1", sha256: "c".repeat(64), architecture: "x64" } };
  const entry = { gameId: "unity-game", name: "Fixture", moduleData: { dataRoot: game.data } };
  const selection = { ready: true, version: "2020.1.17f1", install: { upstreamRevision: "9957aee8edc2", archiveSha256: "a".repeat(64) },
    profile: { templatePath: template, dataDirectory: "Resources/Data", playerLayout: "framework-mono" } };
  const context = { userDataDir: path.join(root, "data") }, options = { steam, run: async () => {} };
  const originalHash = Native.hashFile(path.join(game.data, "Plugins", "steam_api64.dll")), runtimeHash = Native.hashFile(path.join(contents, "Plugins", "stock.dylib"));
  const launch = await UnityLaunch.prepareLaunch(entry, context, selection, options), privateContents = path.join(launch.appPath, "Contents");
  assert.equal(fs.readlinkSync(path.join(privateContents, "Resources/Data/Plugins")), "../../Plugins");
  assert.equal(fs.realpathSync(path.join(privateContents, "Resources/Data/Plugins/steam_api64.dylib")), libraryPath);
  assert.equal(fs.lstatSync(path.join(privateContents, "Plugins/steam_api64.dylib")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(privateContents, "Plugins/steam_api64.dll")), false);
  assert.equal(Native.hashFile(path.join(game.data, "Plugins", "steam_api64.dll")), originalHash); assert.equal(Native.hashFile(path.join(contents, "Plugins", "stock.dylib")), runtimeHash);
  await UnityLaunch.prepareLaunch(entry, context, selection, options);
  const alias = path.join(privateContents, "Plugins/steam_api64.dylib"); fs.unlinkSync(alias); fs.symlinkSync(path.join(contents, "Plugins/stock.dylib"), alias);
  await assert.rejects(UnityLaunch.prepareLaunch(entry, context, selection, options), /Steam plugin alias changed/);
});
