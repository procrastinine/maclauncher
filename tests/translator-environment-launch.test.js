const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Registry = require("../src/modules/registry");
const Launch = require("../src/modules/shared/runtime/translator-environment-launch");

function directory(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("the registry lists every module's translator environments once", () => {
  const ids = Registry.listTranslatorEnvironments().map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["crossover", "sikarugir", "dxvk", "vkd3d-proton", "dxmt", "d3dmetal", "gstreamer", "moltenvk", "kosmickrisp",
    "android", "android-jvm", "android-art", "macapk", "angle", "anyps5", "prosper"]) assert.ok(ids.includes(id), id);
  for (const declaration of Registry.listTranslatorEnvironments()) assert.ok(Object.isFrozen(declaration), declaration.id);
});

test("launch values read the global store from launcher settings and the game's own values from its record", () => {
  const entry = { translatorEnvironment: { anyps5: { GAME: "game", SHARED: "game" }, kosmickrisp: { MESA_KK_DEBUG: null } } };
  const context = { settings: { launcher: { translatorEnvironment: {
    anyps5: { SHARED: "global", GLOBAL: "1", ANYPS5_VULKAN_LIBRARY: "/stored/before/lock" },
    kosmickrisp: { MESA_KK_DEBUG: "msl", MESA_SHADER_CACHE_MAX_SIZE: "1G" }, moltenvk: { MVK_CONFIG_LOG_LEVEL: "4" } } } } };
  assert.deepEqual(Launch.forLaunch(entry, context, ["anyps5", "kosmickrisp"]).values,
    { SHARED: "game", GLOBAL: "1", MESA_SHADER_CACHE_MAX_SIZE: "1G", GAME: "game" });
  assert.deepEqual(Launch.apply({ PATH: "/usr/bin" }, {}, {}, ["anyps5"]), { PATH: "/usr/bin" });
});

test("AnyPS5 and Prosper launch with the merged values of their runtime and Vulkan driver", async t => {
  const root = directory(t, "translator-environment-ps5-");
  const executable = path.join(root, "game");
  fs.writeFileSync(executable, require("./fixtures/macho-image").image({ cpu: 0x01000007, fileType: 2, installName: null }));
  const Vulkan = require("../src/modules/shared/vulkan"), Bundled = require("../src/modules/shared/runtime/bundled-native");
  const Input = require("../src/modules/anyps5/input"), Focus = require("../src/modules/shared/runtime/native-focus");
  const Prepare = require("../src/modules/anyps5/prepare"), ProsperPrepare = require("../src/modules/prosper/prepare");
  const Architecture = require("../src/modules/shared/runtime/architecture");
  const launched = [], selected = { ready: true, version: "fixture", install: { executablePath: executable, installDir: root, root, declaration: { files: [] } } };
  t.mock.method(Architecture, "requiresRosetta", () => false);
  t.mock.method(Prepare, "prepareGame", async () => ({ directory: root, executable }));
  t.mock.method(ProsperPrepare, "prepareGame", async () => ({ root, dump: root, executable: "/app0/eboot.elf",
    environment: { PROSPER_GUEST_FS: "1", PROSPER_SAVE0: path.join(root, "saves") } }));
  t.mock.method(Bundled, "verifyPayload", () => true);
  t.mock.method(Input, "prepare", () => ({ ANYPS5_INPUT_CONFIG: path.join(root, "input.ini") }));
  t.mock.method(Input, "routingEnvironment", () => ({}));
  t.mock.method(Vulkan, "resolve", () => ({ library: executable, backend: "kosmickrisp" }));
  t.mock.method(Vulkan, "environment", () => ({ VK_DRIVER_FILES: path.join(root, "icd.json") }));
  t.mock.method(Focus, "spawnForegroundNativeGame", async payload => { launched.push(payload); return payload; });
  const modulePath = require.resolve("../src/modules/anyps5/main"); delete require.cache[modulePath];
  const anyps5 = require(modulePath); t.after(() => delete require.cache[modulePath]);
  t.mock.method(anyps5.runtimeManagers[0], "resolveSelection", () => selected);
  const providerPath = require.resolve("../src/modules/prosper/provider"); delete require.cache[providerPath];
  const prosper = require(providerPath).createProvider({ manager: { resolveSelection: () => selected },
    spawn: async payload => { launched.push(payload); return payload; } });
  t.after(() => delete require.cache[providerPath]);
  const settings = { launcher: { translatorEnvironment: {
    anyps5: { APS5_PLAYGO_UNLISTED_CHUNKS: "absent", SHARED: "anyps5", ANYPS5_INPUT_CONFIG: "/stored/before/lock" },
    prosper: { SHARED: "prosper", PROSPER_SAVE0: "/stored/before/lock", HOME: "/elsewhere" },
    kosmickrisp: { MESA_KK_DEBUG: "msl", VK_DRIVER_FILES: "/stored/before/lock" }, moltenvk: { MVK_CONFIG_LOG_LEVEL: "4" } } } };
  const entry = { moduleId: "anyps5", runtimeId: "anyps5", gameType: "ps5", moduleData: { format: "elf" },
    translatorEnvironment: { kosmickrisp: { MESA_KK_DEBUG: null, MESA_VK_WSI_PRESENT_MODE: "immediate" }, prosper: { GAME: "$HOME literal" } } };
  const context = { userDataDir: root, settings, runtimeSettings: {}, ensureRosetta: async () => {} };

  const ps5 = (await anyps5.launchRuntime("anyps5", entry, context)).options.env;
  assert.equal(ps5.APS5_PLAYGO_UNLISTED_CHUNKS, "absent", "a translator value replaces the launcher's PlayGo policy");
  assert.equal(ps5.SHARED, "anyps5"); assert.equal(ps5.MESA_VK_WSI_PRESENT_MODE, "immediate");
  assert.equal(ps5.MESA_KK_DEBUG, undefined, "the game removes the global KosmicKrisp value");
  assert.equal(ps5.MVK_CONFIG_LOG_LEVEL, undefined, "MoltenVK values apply only when MoltenVK is the driver");
  assert.equal(ps5.ANYPS5_INPUT_CONFIG, path.join(root, "input.ini")); assert.equal(ps5.VK_DRIVER_FILES, path.join(root, "icd.json"));
  assert.equal(ps5.GAME, undefined, "Prosper values do not reach AnyPS5");

  const native = (await prosper.launchRuntime("prosper", { ...entry, runtimeId: "prosper" }, { ...context, runtimeId: "prosper" })).options.env;
  assert.equal(native.SHARED, "prosper"); assert.equal(native.GAME, "$HOME literal"); assert.equal(native.MESA_VK_WSI_PRESENT_MODE, "immediate");
  assert.equal(native.PROSPER_SAVE0, path.join(root, "saves")); assert.equal(native.HOME, process.env.HOME);
  assert.equal(native.VK_DRIVER_FILES, path.join(root, "icd.json"));
  assert.equal(native.APS5_PLAYGO_UNLISTED_CHUNKS, process.env.APS5_PLAYGO_UNLISTED_CHUNKS);

  const action = payload => anyps5.actions.listTranslatorEnvironments(entry, payload, context);
  assert.deepEqual(action({}).translatorEnvironments, ["anyps5", "kosmickrisp"]);
  Vulkan.resolve.mock.mockImplementation(() => { throw new Error("The selected Vulkan library is unavailable for this Mac."); });
  assert.deepEqual(action({ runtimeSettings: { vulkanRuntime: "missing" } }).translatorEnvironments, ["anyps5"]);
  assert.deepEqual(prosper.actions.listTranslatorEnvironments(entry, {}, context).translatorEnvironments, ["prosper"]);
});

test("ART games receive the translator values beneath the runtime's own paths and options", async t => {
  let launch;
  try { launch = await import("../src/modules/android/art/launch.mjs"); }
  catch (error) { return t.skip("Requires the Android runtime source: " + error.message); }
  const supplier = { bootClasspath: [], manifest: { frameworkResourcePreinitVersion: 1 } };
  const entry = { translatorEnvironment: { angle: { ANGLE_FEATURE_OVERRIDES_ENABLED: "game" }, "android-art": { CLASSPATH: "/stored/before/lock" } } };
  const context = { settings: { launcher: { translatorEnvironment: {
    "android-art": { SHARED: "art", ART_VM_OPTIONS: "-Xint" }, angle: { ANGLE_FEATURE_OVERRIDES_ENABLED: "global", MTL_HUD_ENABLED: "1" },
    kosmickrisp: { MESA_KK_DEBUG: "msl" }, "android-jvm": { JDK_JAVA_OPTIONS: "-Xmx4g" } } } } };
  let environment;
  try {
    environment = launch.gameEnvironment(supplier, { HOME: "/private/home", LANG: "en_US.UTF-8" },
      { entry, context, renderer: "vulkan", vulkan: { backend: "kosmickrisp" }, cacheRoot: "/private/cache" });
  } catch (error) { return t.skip("Requires the Android runtime source: " + error.message); }
  assert.equal(environment.SHARED, "art"); assert.equal(environment.ANGLE_FEATURE_OVERRIDES_ENABLED, "game");
  assert.equal(environment.MTL_HUD_ENABLED, "1"); assert.equal(environment.MESA_KK_DEBUG, "msl");
  assert.equal(environment.JDK_JAVA_OPTIONS, undefined); assert.equal(environment.ART_VM_OPTIONS, undefined);
  assert.equal(environment.MACLAUNCHER_ANDROID_EGL_CACHE, "/private/cache");
  assert.notEqual(environment.CLASSPATH, "/stored/before/lock"); assert.equal(environment.HOME, "/");
});

test("a name that no Android translator suggests belongs to MacLauncher Android and reaches ART and JVM launches", async t => {
  const Contract = require("../src/modules/shared/runtime/translator-environment.mjs");
  const Host = require("../src/modules/android/host");
  const tab = Contract.managerDeclarations(Registry.listTranslatorEnvironments(), "android");
  assert.deepEqual(tab.map(item => item.id), ["android", "android-jvm", "android-art", "angle"], "the runtime's own translator comes first");
  assert.equal(Contract.variableOwner(tab, "CUSTOM_FLAG").id, "android");
  assert.equal(Contract.variableOwner(tab, "JDK_JAVA_OPTIONS").id, "android-jvm");
  assert.equal(Contract.lockedRule(Contract.lockingDeclarations(tab, tab[1]), "JAVA_TOOL_OPTIONS"), null, "ART's lock does not refuse a JVM value");
  assert.ok(Contract.lockedRule(Contract.lockingDeclarations(tab, tab[0]), "LD_PRELOAD"), "runtime-wide values follow the locks of both engines");
  const context = { settings: { launcher: { translatorEnvironment: { ...Contract.withValues({}, "android", { CUSTOM_FLAG: "on" }),
    "android-jvm": { JDK_JAVA_OPTIONS: "-Xmx4g" } } } } };
  for (const execution of ["jvm", "art"])
    assert.equal(Launch.forLaunch({}, context, Host.translatorEnvironmentIds(execution, "metal")).values.CUSTOM_FLAG, "on", execution);
  let launch;
  try { launch = await import("../src/modules/android/art/launch.mjs"); }
  catch (error) { return t.skip("Requires the Android runtime source: " + error.message); }
  const supplier = { bootClasspath: [], manifest: { frameworkResourcePreinitVersion: 1 } };
  const environment = launch.gameEnvironment(supplier, { HOME: "/private/home", LANG: "en_US.UTF-8" },
    { entry: { translatorEnvironment: { android: { GAME_FLAG: "game" } } }, context, renderer: "metal", vulkan: null, cacheRoot: "/private/cache" });
  assert.equal(environment.CUSTOM_FLAG, "on"); assert.equal(environment.GAME_FLAG, "game");
  assert.equal(environment.JDK_JAVA_OPTIONS, undefined, "JVM values stay with the JVM engine");
});

test("a game's values are stored literally in its record, survive detection and reach its launch context", async t => {
  const root = directory(t, "translator-environment-record-");
  const GameStore = require("../src/core/game-store");
  const { createLauncher } = require("../src/core/launcher");
  const manifest = { id: "test", runtime: { supported: ["first"], default: "first" } };
  const registry = { listModules: () => [manifest], getModule: () => ({ manifest }), getModuleInfo: () => manifest,
    detectGame: input => ({ moduleId: "test", gamePath: input, name: "Game" }),
    listTranslatorEnvironments: () => Registry.listTranslatorEnvironments() };
  const launcher = createLauncher({ userDataDir: root, registry });
  const entry = await launcher.resolveEntry(root);
  launcher.persistEntry(entry);
  GameStore.setGameNotes(root, entry.gameId, "Keep this note");

  const literal = "$HOME/`id` \"quoted\" ' spaced ' ;|*";
  const result = await launcher.runAction(entry, "setGameTranslatorEnvironment",
    { translatorId: "dxvk", values: { DXVK_HUD: literal, DXVK_LOG_LEVEL: null, EMPTY: "" } });
  assert.deepEqual(result.translatorEnvironment, { dxvk: { DXVK_HUD: literal, DXVK_LOG_LEVEL: null, EMPTY: "" } });
  await launcher.runAction(entry, "setGameTranslatorEnvironment", { translatorId: "kosmickrisp", values: { MESA_KK_DEBUG: "msl" } });
  let stored = GameStore.readGameRecord(root, entry.gameId);
  assert.equal(stored.notes, "Keep this note");
  assert.deepEqual(stored.translatorEnvironment, { dxvk: { DXVK_HUD: literal, DXVK_LOG_LEVEL: null, EMPTY: "" }, kosmickrisp: { MESA_KK_DEBUG: "msl" } });
  assert.deepEqual(entry.translatorEnvironment, stored.translatorEnvironment, "the library entry follows the record");

  for (const [values, message] of [[{ VK_DRIVER_FILES: "/elsewhere" }, /VK_DRIVER_FILES is set by MacLauncher/], [{ "1BAD": "x" }, /not a valid variable name/],
    [{ GOOD: "two\nlines" }, /one line of text/], [["DXVK_HUD=fps"], /pairs of a name and a value/]])
    await assert.rejects(launcher.runAction(entry, "setGameTranslatorEnvironment", { translatorId: "kosmickrisp", values }), message);
  await assert.rejects(launcher.runAction(entry, "setGameTranslatorEnvironment", { translatorId: "missing", values: {} }), /Unknown translator/);
  assert.deepEqual(GameStore.readGameRecord(root, entry.gameId).translatorEnvironment, stored.translatorEnvironment, "refused values change nothing");

  const rediscovered = await launcher.resolveEntry(root);
  assert.deepEqual(rediscovered.translatorEnvironment, stored.translatorEnvironment, "detection keeps the game's values");
  const context = launcher.getLaunchContext(rediscovered, { launcher: { translatorEnvironment: { dxvk: { DXVK_LOG_LEVEL: "warn", GLOBAL: "1" } } } });
  assert.deepEqual(Launch.forLaunch(rediscovered, context, ["dxvk"]).values, { GLOBAL: "1", DXVK_HUD: literal, EMPTY: "" });

  await launcher.runAction(entry, "setGameTranslatorEnvironment", { translatorId: "dxvk", values: null });
  await launcher.runAction(entry, "setGameTranslatorEnvironment", { translatorId: "kosmickrisp", values: {} });
  stored = GameStore.readGameRecord(root, entry.gameId);
  assert.equal("translatorEnvironment" in stored, false, "clearing the last translator removes the field");
  assert.equal("translatorEnvironment" in entry, false);
});

test("Wine environment variable lists move once into the translator environment, show in the editor and yield to an edited global value", t => {
  const root = directory(t, "translator-environment-migration-");
  const Migration = require("../src/core/backcompat/translator-environment");
  const Contract = require("../src/modules/shared/runtime/translator-environment.mjs");
  const declarations = Registry.listTranslatorEnvironments(), logger = { warn() {} };
  fs.mkdirSync(path.join(root, "runtimes", "sikarugir"), { recursive: true });
  fs.writeFileSync(path.join(root, "runtimes", "sikarugir", "settings.json"), JSON.stringify({ environment: ["RUNTIME=1", "SHARED=runtime"] }));
  const raw = { launcher: { appearance: "dark", translatorEnvironment: { crossover: { KEPT: "current" } } }, modules: {
    unity: { runtimeSettings: { crossover: { environment: ["WINEDEBUG=-all", " LITERAL=$HOME `x` ", "WINEPREFIX=/locked", "BROKEN"], locale: "ja_JP.UTF-8" } } },
    windows: { runtimeSettings: { crossover: { environment: ["WINEDEBUG=+seh", "OTHER=1", "KEPT=old"] }, sikarugir: { environment: ["SHARED=module"] } } } } };
  const before = structuredClone(raw), commits = [];
  const migrated = Migration.migrateSettings(raw, { userDataDir: root, registry: Registry, logger,
    commitSettings: (previous, next) => { commits.push(previous); return next; } });
  assert.deepEqual(raw, before, "the read document is not changed in place");
  assert.equal(commits.length, 1);
  assert.deepEqual(migrated.launcher.translatorEnvironment, {
    crossover: { KEPT: "current", WINEDEBUG: "-all", LITERAL: "$HOME `x`", OTHER: "1" }, sikarugir: { RUNTIME: "1", SHARED: "runtime" } });
  assert.equal(migrated.launcher.appearance, "dark");
  assert.deepEqual(migrated.modules.unity.runtimeSettings.crossover, { locale: "ja_JP.UTF-8" }, "the retired list leaves the game type settings");
  assert.deepEqual(migrated.modules.windows.runtimeSettings, { crossover: {}, sikarugir: {} });
  assert.deepEqual(migrated.dataMigrations[Migration.MIGRATION], { settings: true, retained: [
    { runtimeId: "crossover", moduleId: "windows", name: "WINEDEBUG", value: "+seh" },
    { runtimeId: "sikarugir", moduleId: "windows", name: "SHARED", value: "module" }] });
  assert.equal(Migration.migrateSettings(migrated, { userDataDir: root, commitSettings: () => assert.fail("migrated once") }), migrated);
  const plain = { launcher: {}, modules: { unity: { runtimeSettings: { crossover: { locale: "" } } } } };
  assert.equal(Migration.migrateSettings(plain, { userDataDir: directory(t, "translator-environment-plain-"),
    commitSettings: () => assert.fail("a document without lists is not rewritten") }), plain);

  const entry = { gameId: "game", runtimeSettings: { crossover: { environment: ["DXVK_HUD=full", "GAME=old", "CX_ROOT=/locked"], locale: "" },
    sikarugir: { environment: [] }, mkxpz: { environment: ["UNRELATED=1"] } }, translatorEnvironment: { crossover: { GAME: "current" } } };
  const game = Migration.migrateGameEntry(entry, declarations);
  assert.deepEqual(game.runtimeSettings, { crossover: { locale: "" }, sikarugir: {}, mkxpz: { environment: ["UNRELATED=1"] } });
  assert.deepEqual(game.translatorEnvironment, { crossover: { DXVK_HUD: "full", GAME: "current" } });
  assert.equal(Migration.migrateGameEntry(game, declarations), null, "a migrated record has nothing left to move");
  assert.equal(Migration.migrateGameEntry({ gameId: "empty", runtimeSettings: { crossover: { environment: [] } } }, declarations).translatorEnvironment, undefined);

  // The moved line is an ordinary global row of the CrossOver editor, and the
  // value saved from that editor is the one the next launch receives.
  const crossover = declarations.find(item => item.id === "crossover");
  const row = Contract.editorRows(crossover, { scope: "global", global: migrated.launcher.translatorEnvironment.crossover }).find(item => item.name === "WINEDEBUG");
  assert.deepEqual([row.state, row.value, row.known.launcher], ["added", "-all", "Set by Wine debug channels in Runtime Settings."]);
  const gameRow = Contract.editorRows(crossover, { scope: "game", global: migrated.launcher.translatorEnvironment.crossover,
    game: game.translatorEnvironment.crossover }).find(item => item.name === "WINEDEBUG");
  assert.deepEqual([gameRow.state, gameRow.inheritedSource], ["inherited", "global"], "the game shows the moved value as coming from Runtimes");
  const edited = Contract.withValues(migrated.launcher.translatorEnvironment, "crossover",
    Contract.normalizeValues({ ...migrated.launcher.translatorEnvironment.crossover, WINEDEBUG: "+loaddll" }, { declarations: [crossover] }));
  const launch = Launch.forLaunch(game, { settings: { launcher: { translatorEnvironment: edited } } }, ["crossover", "dxvk"]).values;
  assert.equal(launch.WINEDEBUG, "+loaddll"); assert.equal(launch.DXVK_HUD, "full"); assert.equal(launch.GAME, "current"); assert.equal(launch.LITERAL, "$HOME `x`");
});
