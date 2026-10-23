const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const GameMaker = require("../src/modules/gamemaker/runtime/steam-api");
const Compatibility = require("../src/modules/gamemaker/runtime/official-compatibility");
const Steam = require("../src/modules/shared/runtime/steamworks");
const Native = require("../src/modules/shared/runtime/local-native");
const Probe = require("../src/modules/shared/runtime/steamworks/native-consumer-probe");
const Catalog = require("../src/modules/shared/runtime/steamworks/versions.json");
const Profiles = require("../src/modules/shared/runtime/steamworks/profiles.json");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gamemaker-steam-producer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "original", "data.win"), runnerAppPath = path.join(root, "native", "Runner.app");
  fs.mkdirSync(path.dirname(data), { recursive: true }); fs.writeFileSync(data, "original game data");
  const consumerPath = path.join(runnerAppPath, "Contents/MacOS/Mac_Runner");
  fs.mkdirSync(path.dirname(consumerPath), { recursive: true }); fs.writeFileSync(consumerPath, "changed native fixture");
  const pin = Catalog.find(item => item.version === GameMaker.LEGACY_HELPER_VERSION);
  const profile = Profiles.find(item => item.id === GameMaker.LEGACY_HELPER_PROFILE);
  const install = { version: GameMaker.LEGACY_RUNNER, runnerAppPath, binarySha256: GameMaker.LEGACY_SHA256, architectures: ["x86_64"] };
  t.mock.method(Steam, "resolveBundledLibrary", options => {
    assert.deepEqual(options.catalog, [pin]); assert.deepEqual(options.interfaces, pin.qualifiedInterfaces);
    return { ready: true, version: pin.version, mode: "offline", libraryPath: path.join(root, "shared", "libsteam_api.dylib"), sha256: pin.librarySha256 };
  });
  return { root, data, consumerPath, install, pin, profile };
}

test("legacy GameMaker selects an explicit successor helper without changing its runner or graphics policy", t => {
  const f = fixture(t), dependency = GameMaker.resolveDependency({ steamRequired: true, steamAppId: -480 }, f.data, f.install);
  assert.equal(dependency.version, GameMaker.LEGACY_HELPER_VERSION); assert.equal(dependency.abiProfile, GameMaker.LEGACY_HELPER_PROFILE);
  assert.equal(dependency.consumerPath, f.consumerPath); assert.equal(dependency.appId, 480);
  assert.deepEqual(dependency.interfaces, f.profile.interfaces); assert.deepEqual(dependency.symbols, f.profile.symbols);
  assert.equal(Compatibility.OBSERVATIONS[GameMaker.LEGACY_RUNNER].steamApiVersion, dependency.version);
  assert.equal(Compatibility.OBSERVATIONS[GameMaker.LEGACY_RUNNER].renderingStable, false);
  assert.equal(Compatibility.OBSERVATIONS[GameMaker.LEGACY_RUNNER].workaround, "software-gl-v3-universal");
  assert.equal(fs.readFileSync(f.data, "utf8"), "original game data");
});

test("legacy GameMaker passes dynamically loaded APIs and the exact runner profile to the shared service", async t => {
  const f = fixture(t), dependency = GameMaker.resolveDependency({ steamRequired: true, steamAppId: 480 }, f.data, f.install);
  t.mock.method(Native, "hashFile", () => GameMaker.LEGACY_SHA256);
  t.mock.method(Probe, "inspectNativeSteamConsumer", () => ({ symbols: [] }));
  let request;
  const userDataDir = path.join(f.root, "data"), baseEnvironment = { PATH: "/usr/bin", DYLD_INSERT_LIBRARIES: "/graphics/helper.dylib" };
  const context = { userDataDir, prepareSteamApi: async (value, options) => {
    request = value; assert.equal(options.baseEnvironment, baseEnvironment);
    return { version: value.version, mode: "offline", environment: { ...options.baseEnvironment } };
  } };
  await GameMaker.prepareDependency(dependency, { gameId: "original", contentRootDir: path.dirname(f.data) }, context, baseEnvironment);
  assert.equal(request.abiProfile, GameMaker.LEGACY_HELPER_PROFILE); assert.equal(request.version, GameMaker.LEGACY_HELPER_VERSION);
  assert.deepEqual(request.symbols, f.profile.symbols); assert.deepEqual(request.interfaces, f.profile.interfaces);
  assert.deepEqual(request.nativeLibraryPaths, []); assert.equal(request.preferOffline, true);
  assert.equal(fs.existsSync(request.ownedDirectory), false);
  assert.deepEqual(baseEnvironment, { PATH: "/usr/bin", DYLD_INSERT_LIBRARIES: "/graphics/helper.dylib" });
});

test("a changed or unidentified legacy consumer fails before Steam setup", async t => {
  const f = fixture(t), dependency = GameMaker.resolveDependency({ steamRequired: true, steamAppId: 480 }, f.data, f.install);
  const context = { userDataDir: path.join(f.root, "data"), prepareSteamApi: () => assert.fail("A changed runner cannot prepare Steam state") };
  for (const patch of [{}, { consumerPath: null }]) {
    await assert.rejects(GameMaker.prepareDependency({ ...dependency, ...patch }, { gameId: "original" }, context), { code: "STEAM_API_CONSUMER_CHANGED" });
  }
  assert.throws(() => GameMaker.resolveDependency({ steamRequired: true, steamAppId: 480 }, f.data,
    { ...f.install, binarySha256: "a".repeat(64) }), error => error.code === "GAMEMAKER_STEAM_DEPENDENCY_REQUIRED");
  assert.throws(() => GameMaker.resolveDependency({ steamRequired: true }, f.data, f.install),
    error => error.code === "GAMEMAKER_STEAM_APP_ID_REQUIRED" && error.fallbackRuntimeId === "butterscotch");
  assert.equal(fs.existsSync(context.userDataDir), false);
});
