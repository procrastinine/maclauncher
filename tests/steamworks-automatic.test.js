const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Native = require("../src/modules/shared/runtime/local-native");
const { prepareAutomaticLaunch } = require("../src/modules/shared/runtime/steamworks/automatic");

function environment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-auto-steam-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesRoot = path.join(root, "resources"), libraryPath = path.join(resourcesRoot, "libsteam_api.dylib");
  fs.mkdirSync(resourcesRoot);
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(6, 12);
  fs.writeFileSync(libraryPath, bytes);
  const sha256 = Native.hashFile(libraryPath), userDataDir = path.join(root, "data");
  const interfaces = ["SteamClient017", "SteamUser018"];
  const dependencies = {
    catalog: [{ version: "qualified-1", qualifiedInterfaces: interfaces }],
    inspectMachOExports: async () => ["SteamAPI_Init", "SteamAPI_Shutdown", "SteamAPI_RunCallbacks"],
    resolveBundledLibrary: options => ({ ready: true, mode: "offline", libraryPath, sha256,
      version: "qualified-1", sourceRevision: "a".repeat(40), architectures: ["arm64"], interfaces: options.interfaces })
  };
  const request = (id = "one") => ({ required: true, appId: 480, arch: "arm64", symbols: ["SteamAPI_Init", "SteamAPI_Shutdown"],
    aliases: ["steam_api64.dll"], ownedDirectory: path.join(userDataDir, "games", id, "modules", "fixture", "steam") });
  return { root, userDataDir, resourcesRoot, libraryPath, sha256, interfaces, dependencies, request };
}

test("ordinary games never inspect, install or prepare Steam state", async () => {
  const untouched = () => { throw new Error("unnecessary Steam work"); };
  assert.equal(await prepareAutomaticLaunch(null, {}, { inspectMachOExports: untouched, resolveBundledLibrary: untouched }), null);
  assert.equal(await prepareAutomaticLaunch({ required: false }, {}, { inspectMachOExports: untouched }), null);
});

test("encrypted-ticket libraries cannot be aliases for the Steam API helper", async t => {
  const f = environment(t);
  await assert.rejects(prepareAutomaticLaunch({ ...f.request(), aliases: ["libsdkencryptedappticket.dylib"] },
    { userDataDir: f.userDataDir }, f.dependencies), { code: "STEAM_API_REQUIREMENT_INVALID" });
  assert.equal(fs.existsSync(f.request().ownedDirectory), false);
});

function profileFixture(t) {
  const f = environment(t), pin = f.dependencies.catalog[0];
  pin.sourceRevision = "a".repeat(40); pin.librarySha256 = f.sha256;
  const profile = { schemaVersion: 1, id: "fixture-sdk1.63-v1", helperVersion: pin.version,
    helperSourceRevision: pin.sourceRevision, helperLibrarySha256: pin.librarySha256,
    architectures: ["arm64"], interfaces: ["SteamClient023", "SteamUser023", "SteamNetworkingUtils004", "SteamInput006"] };
  f.dependencies.profiles = [profile];
  return { ...f, pin, profile };
}

test("a reviewed modern ABI profile reuses the unchanged sealed helper", async t => {
  const f = profileFixture(t), calls = [];
  const resolve = f.dependencies.resolveBundledLibrary;
  f.dependencies.resolveBundledLibrary = options => { calls.push(options); return resolve(options); };
  const before = fs.readFileSync(f.libraryPath);
  const result = await prepareAutomaticLaunch({ ...f.request(), abiProfile: f.profile.id, interfaces: ["SteamUser023"] },
    { userDataDir: f.userDataDir }, f.dependencies);
  assert.deepEqual(calls[0].interfaces, f.pin.qualifiedInterfaces, "Payload validation must retain the original sealed inventory");
  assert.deepEqual(result.interfaces, f.profile.interfaces);
  assert.equal(result.abiProfile, f.profile.id);
  assert.equal(result.identity.abiProfile, f.profile.id);
  const configuration = fs.readFileSync(path.join(result.settingsPath, "steam_interfaces.txt"), "utf8");
  assert.match(configuration, /^SteamClient023$/m);
  assert.doesNotMatch(configuration, /^SteamClient017$/m);
  assert.equal(result.libraryPath, f.libraryPath);
  assert.deepEqual(fs.readFileSync(f.libraryPath), before);
});

test("unknown profiles and unqualified interface versions fail before native setup", async t => {
  const f = profileFixture(t);
  f.dependencies.inspectMachOExports = () => assert.fail("An invalid profile must fail before native inspection");
  await assert.rejects(prepareAutomaticLaunch({ ...f.request(), abiProfile: "unknown" },
    { userDataDir: f.userDataDir }, f.dependencies), { code: "STEAM_API_PROFILE_UNKNOWN" });
  await assert.rejects(prepareAutomaticLaunch({ ...f.request(), abiProfile: f.profile.id, interfaces: ["SteamUser024"] },
    { userDataDir: f.userDataDir }, f.dependencies), { code: "STEAM_API_INTERFACES_UNAVAILABLE" });
  assert.equal(fs.existsSync(f.request().ownedDirectory), false);
});

test("ABI qualification cannot relabel another helper source, binary, version or CPU", async t => {
  const changes = [{ helperSourceRevision: "b".repeat(40) }, { helperLibrarySha256: "f".repeat(64) },
    { helperVersion: "another-build" }, { architectures: ["x86_64"] }];
  for (const change of changes) {
    const f = profileFixture(t);
    Object.assign(f.profile, change);
    f.dependencies.inspectMachOExports = () => assert.fail("A changed profile must fail before inspecting native code");
    await assert.rejects(prepareAutomaticLaunch({ ...f.request(), abiProfile: f.profile.id },
      { userDataDir: f.userDataDir }, f.dependencies), { code: "STEAM_API_PROFILE_CHANGED" });
    assert.equal(fs.existsSync(f.request().ownedDirectory), false);
  }
});

test("ambiguous or malformed ABI profiles cannot prepare game state", async t => {
  const fixtures = [{ interfaces: ["SteamClient017", "SteamClient023"] },
    { interfaces: ["SteamClient023", "SteamUser023", "SteamUser023"] }, { interfaces: ["UnreviewedInterface001"] }];
  for (const change of fixtures) {
    const f = profileFixture(t); Object.assign(f.profile, change);
    await assert.rejects(prepareAutomaticLaunch({ ...f.request(), abiProfile: f.profile.id },
      { userDataDir: f.userDataDir }, f.dependencies), { code: "STEAM_API_PROFILE_CHANGED" });
    assert.equal(fs.existsSync(f.request().ownedDirectory), false);
  }
  const f = profileFixture(t); f.dependencies.profiles.push({ ...f.profile });
  await assert.rejects(prepareAutomaticLaunch({ ...f.request(), abiProfile: f.profile.id },
    { userDataDir: f.userDataDir }, f.dependencies), { code: "STEAM_API_PROFILE_UNKNOWN" });
});

test("automatic setup shares one library and isolates two games' offline state", async t => {
  const f = environment(t), base = { PATH: "/usr/bin", DYLD_INSERT_LIBRARIES: "/graphics.dylib", DYLD_LIBRARY_PATH: "/existing", SteamAppId: "999" };
  const context = { userDataDir: f.userDataDir, baseEnvironment: base };
  const before = fs.readFileSync(f.libraryPath);
  const [one, two] = await Promise.all([
    prepareAutomaticLaunch(f.request("one"), context, f.dependencies),
    prepareAutomaticLaunch({ ...f.request("two"), appId: 481 }, context, f.dependencies)
  ]);
  assert.equal(one.libraryPath, two.libraryPath);
  assert.notEqual(one.savePath, two.savePath);
  assert.notEqual(one.aliasDirectory, two.aliasDirectory);
  assert.equal(one.environment.SteamAppId, "480"); assert.equal(two.environment.SteamAppId, "481");
  assert.equal(one.environment.DYLD_INSERT_LIBRARIES, "/graphics.dylib");
  assert.ok(one.environment.DYLD_LIBRARY_PATH.endsWith(":/existing"));
  assert.equal(base.SteamAppId, "999");
  for (const result of [one, two]) {
    for (const name of result.aliases) {
      assert.equal(fs.lstatSync(path.join(result.aliasDirectory, name)).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(path.join(result.aliasDirectory, name)), f.libraryPath);
    }
  }
  assert.deepEqual(fs.readFileSync(f.libraryPath), before);
  fs.writeFileSync(path.join(one.savePath, "progress.json"), "one");
  assert.equal(fs.existsSync(path.join(two.savePath, "progress.json")), false);
});

test("warm setup reuses immutable aliases and preserves game state", async t => {
  const f = environment(t), context = { userDataDir: f.userDataDir };
  const first = await prepareAutomaticLaunch(f.request(), context, f.dependencies);
  fs.writeFileSync(path.join(first.savePath, "progress.json"), "saved");
  const second = await prepareAutomaticLaunch(f.request(), context, f.dependencies);
  assert.equal(second.aliasDirectory, first.aliasDirectory);
  assert.equal(fs.readFileSync(path.join(second.savePath, "progress.json"), "utf8"), "saved");
  assert.equal(fs.readdirSync(path.dirname(first.aliasDirectory)).length, 1);
});

test("matching original native libraries take precedence without writing offline state", async t => {
  const f = environment(t), original = path.join(f.root, "original.dylib");
  fs.copyFileSync(f.libraryPath, original);
  const result = await prepareAutomaticLaunch({ ...f.request(), appId: null, nativeLibraryPaths: [original] },
    { userDataDir: f.userDataDir }, { ...f.dependencies, resolveBundledLibrary: () => { throw new Error("unnecessary offline API"); } });
  assert.equal(result.mode, "native"); assert.equal(result.libraryPath, fs.realpathSync(original));
  assert.equal(result.savePath, null);
  assert.equal(fs.existsSync(path.join(f.request().ownedDirectory, "settings")), false);
});

test("unknown API, missing exact exports and invalid versions fail before preparing state", async t => {
  const f = environment(t), context = { userDataDir: f.userDataDir };
  await assert.rejects(prepareAutomaticLaunch({ ...f.request(), symbols: [] }, context, f.dependencies), { code: "STEAM_API_ABI_UNKNOWN" });
  await assert.rejects(prepareAutomaticLaunch({ ...f.request(), symbols: ["SteamAPI_NewUnimplementedCall"] }, context, f.dependencies),
    error => error.code === "STEAM_API_SYMBOLS_UNAVAILABLE" && error.missingSymbols[0] === "SteamAPI_NewUnimplementedCall");
  await assert.rejects(prepareAutomaticLaunch({ ...f.request(), version: "unlisted" }, context, f.dependencies), { code: "STEAM_API_VERSION_UNKNOWN" });
  await assert.rejects(prepareAutomaticLaunch({ ...f.request(), appId: null }, context, f.dependencies), { code: "STEAM_API_APP_ID_REQUIRED" });
  assert.equal(fs.existsSync(f.userDataDir), false);
});

test("state and aliases cannot escape game data or replace unrelated files", async t => {
  const f = environment(t), context = { userDataDir: f.userDataDir };
  await assert.rejects(prepareAutomaticLaunch({ ...f.request(), ownedDirectory: f.resourcesRoot }, context, f.dependencies), { code: "STEAM_API_STATE_INVALID" });
  await assert.rejects(prepareAutomaticLaunch({ ...f.request(), aliases: ["../original.dylib"] }, context, f.dependencies), { code: "STEAM_API_REQUIREMENT_INVALID" });
  const result = await prepareAutomaticLaunch(f.request(), context, f.dependencies);
  const alias = path.join(result.aliasDirectory, "steam_api64.dll");
  fs.unlinkSync(alias); fs.writeFileSync(alias, "user file");
  await assert.rejects(prepareAutomaticLaunch(f.request(), context, f.dependencies), { code: "STEAM_API_ALIASES_CHANGED" });
  assert.equal(fs.readFileSync(alias, "utf8"), "user file");
});

test("a game-data symlink cannot redirect Steam writes to the original game", async t => {
  const f = environment(t), original = path.join(f.root, "original");
  fs.mkdirSync(original); fs.mkdirSync(path.join(f.userDataDir, "games"), { recursive: true });
  fs.symlinkSync(original, path.join(f.userDataDir, "games", "one"));
  await assert.rejects(prepareAutomaticLaunch(f.request(), { userDataDir: f.userDataDir }, f.dependencies), { code: "STEAM_API_STATE_INVALID" });
  assert.deepEqual(fs.readdirSync(original), []);
});
