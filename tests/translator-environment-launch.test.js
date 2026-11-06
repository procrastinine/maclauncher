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
    "android-jvm", "android-art", "macapk", "angle", "anyps5", "prosper"]) assert.ok(ids.includes(id), id);
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
