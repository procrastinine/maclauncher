const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Preparation = require("../src/modules/shared/web/runtime/greenworks-preparation");
const Runtime = require("../src/modules/shared/web/runtime/greenworks-runtime");
const Nwjs = require("../src/modules/shared/web/runtime/nwjs-manager");
const Sdk = require("../src/modules/shared/web/runtime/greenworks-sdk");
const Contract = require("../src/modules/shared/web/runtime/greenworks-contracts.json")[0];
const Steam = require("../src/modules/shared/runtime/steamworks");
const SteamProfiles = require("../src/modules/shared/runtime/steamworks/profiles");
const SteamCatalog = require("../src/modules/shared/runtime/steamworks/versions.json");
const ProfileCatalog = require("../src/modules/shared/runtime/steamworks/profiles.json");
const Ticket = require("../src/modules/shared/runtime/steamworks/ticket");
const Web = require("../src/modules/web/main");
const { prepareForLaunch } = require("../src/core/runtime-preparation");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-greenworks-flow-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }
function digest(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function nativeBridge() {
  // Native import parsing is covered by its own fixtures. This image establishes
  // only the required Mac CPU format for package/preparation tests.
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x01000007, 4); bytes.writeUInt32LE(8, 12); return bytes;
}
function bridge(directory) {
  write(path.join(directory, "greenworks.js"), 'module.exports = require("./lib/greenworks-osx.node");\n');
  write(path.join(directory, "lib", "greenworks-osx.node"), nativeBridge());
  return directory;
}
function originalGame(root) {
  const gamePath = path.join(root, "original");
  write(path.join(gamePath, "index.html"), "<!doctype html><title>Original</title>");
  write(path.join(gamePath, "package.json"), '{"name":"original","main":"index.html"}');
  write(path.join(gamePath, "steam_appid.txt"), "480\n");
  const target = path.join(gamePath, "node_modules", "greenworks");
  write(path.join(target, "greenworks.js"), 'module.exports = require("./lib/greenworks-win64.node");\n');
  write(path.join(target, "lib", "greenworks-win64.node"), "original Windows binary");
  return { gamePath, target, moduleId: "web", gameType: "web", gameId: "test-greenworks", runtimeId: "nwjs-patched",
    contentRootDir: gamePath, indexHtml: path.join(gamePath, "index.html"), runtimeData: { "nwjs-patched": { version: "0.103.1" } } };
}
function context(root, runtimeId = "nwjs-patched") {
  return { userDataDir: path.join(root, "userData"), runtimeId,
    settings: { runtimes: { nwjs: { defaultVersion: "0.107.0", greenworksDefaultVersion: "0.80.0" } } } };
}
function availableNativeSdk(t, root) {
  const sdk = { version: Sdk.PIN.version, sdkVersion: Sdk.PIN.sdkVersion,
    libraryPath: path.join(root, Sdk.PIN.filename), apiLibraryPath: path.join(root, Sdk.PIN.api.filename),
    sha256: Sdk.PIN.sha256, apiSha256: Sdk.PIN.api.sha256, source: "native-game-library" };
  const ticket = { ready: true, version: Contract.ticketVersion, libraryPath: path.join(root, "included", Sdk.PIN.filename),
    sourceKind: "owned", sourceSha256: "a".repeat(64), sha256: "b".repeat(64), policy: "unavailable" };
  t.mock.method(Sdk, "resolveQualifiedTicket", () => sdk);
  t.mock.method(Ticket, "resolveBundledTicket", () => ticket);
  const savedSteamCatalog = [...SteamCatalog], savedProfiles = [...ProfileCatalog];
  t.after(() => { SteamCatalog.splice(0, SteamCatalog.length, ...savedSteamCatalog); ProfileCatalog.splice(0, ProfileCatalog.length, ...savedProfiles); });
  SteamCatalog.unshift({ version: Contract.helperVersion, qualifiedInterfaces: Contract.interfaces });
  ProfileCatalog.unshift({ id: Contract.helperAbiProfile, architectures: ["arm64"] });
  t.mock.method(SteamProfiles, "resolveProfile", () => ({ id: Contract.helperAbiProfile, helperVersion: Contract.helperVersion,
    bridgeLibrarySha256: Contract.nativeSha256, bridgeJavascriptSha256: Contract.javascriptSha256,
    hostVersion: Contract.nwVersion, sdkVersion: Sdk.PIN.sdkVersion,
    encryptedTicketSourceKind: "owned", encryptedTicketVersion: ticket.version,
    encryptedTicketSourceSha256: ticket.sourceSha256, encryptedTicketLibrarySha256: ticket.sha256, encryptedTicketPolicy: ticket.policy }));
  t.mock.method(Steam, "resolveBundledLibrary", () => ({ ready: true, version: Contract.helperVersion, mode: "offline" }));
  return { ...sdk, ticket };
}

test("web module preparation plans the exact missing NW.js/Greenworks pair before any installation", async t => {
  const root = temporary(t), entry = originalGame(root), ctx = context(root), events = [], installed = [];
  availableNativeSdk(t, root);
  bridge(path.join(ctx.userDataDir, "runtimes", "greenworks", "0.80.0"));
  const sourceHash = digest(path.join(entry.target, "greenworks.js"));
  t.mock.method(Nwjs, "getState", () => ({ sections: [
    { id: "default", defaultVersion: "0.107.0", defaultVariant: "sdk", installed: [] },
    { id: "greenworks", defaultVersion: "0.80.0", installed: [] }
  ] }));
  t.mock.method(Nwjs, "refreshCatalog", () => assert.fail("Exact selections do not need a catalog lookup"));
  ctx.confirmRuntimeInstall = async plan => { events.push(["consent", plan.version, plan.installOptions.sectionId]); return plan.installOptions.sectionId !== "greenworks"; };
  const prepare = () => prepareForLaunch({ entry, mod: Web, info: Web.manifest, context: ctx,
    registry: { listModuleIds: () => [Web.id], getModule: () => Web },
    install: async (_manager, payload) => { events.push(["install", payload.version, payload.sectionId]); installed.push(payload); }
  });
  assert.equal(await prepare(), false);
  assert.deepEqual(events, [["consent", "0.103.1", "default"], ["consent", "0.103.1", "greenworks"]]);
  assert.deepEqual(installed, []); assert.equal(digest(path.join(entry.target, "greenworks.js")), sourceHash);
  events.length = 0; ctx.confirmRuntimeInstall = async plan => { events.push(["consent", plan.version, plan.installOptions.sectionId]); return true; };
  assert.equal(await prepare(), true);
  assert.deepEqual(events, [["consent", "0.103.1", "default"], ["consent", "0.103.1", "greenworks"],
    ["install", "0.103.1", "default"], ["install", "0.103.1", "greenworks"]]);
  assert.equal(entry.runtimeData["nwjs-patched"].version, "0.103.1");
  assert.equal(ctx.settings.runtimes.nwjs.defaultVersion, "0.107.0");
});

test("ready exact bridges retain a source lease; newer unrelated installations never change the host selection", async t => {
  const root = temporary(t), entry = originalGame(root), ctx = context(root), uses = [];
  availableNativeSdk(t, root);
  for (const version of ["0.80.0", "0.103.1", "0.117.0"]) bridge(path.join(ctx.userDataDir, "runtimes", "greenworks", version));
  t.mock.method(Runtime, "listInstalled", userDataDir => ["0.80.0", "0.103.1", "0.117.0"].filter(version =>
    fs.existsSync(path.join(userDataDir, "runtimes", "greenworks", version))).map(version => ({ version, ready: true,
    installDir: path.join(userDataDir, "runtimes", "greenworks", version), files: [
      { path: "greenworks.js", sha256: Contract.javascriptSha256 }, { path: "lib/greenworks-osx.node", sha256: Contract.nativeSha256 }
    ] })));
  ctx.recordRuntimeUse = identity => uses.push(identity);
  assert.deepEqual(await Preparation.getRuntimeRequirements(entry, ctx), []);
  assert.deepEqual(uses, [{ managerId: "nwjs", version: "0.103.1", sectionId: "greenworks",
    sourcePath: path.join(ctx.userDataDir, "runtimes", "greenworks", "0.103.1") }]);
  fs.rmSync(uses[0].sourcePath, { recursive: true });
  assert.deepEqual(await Preparation.getRuntimeRequirements(entry, ctx), [{ managerId: "nwjs", version: "0.103.1", installOptions: { sectionId: "greenworks" } }]);
});

test("ordinary and patched NW.js share the bridge contract; other hosts and games skip it", async t => {
  const root = temporary(t), entry = originalGame(root), ctx = context(root, "nwjs");
  entry.runtimeData.nwjs = { version: "0.80.0" };
  await assert.rejects(Preparation.getRuntimeRequirements(entry, ctx), error => error.code === "GREENWORKS_ABI_UNVERIFIED");
  assert.equal(entry.runtimeData.nwjs.version, "0.80.0");
  entry.runtimeData.nwjs.version = "0.103.1"; availableNativeSdk(t, root);
  assert.equal((await Preparation.getRuntimeRequirements(entry, ctx))[0].version, "0.103.1");
  ctx.runtimeId = "electron";
  assert.deepEqual(await Preparation.getRuntimeRequirements(entry, ctx), []);
  const ordinary = path.join(root, "no-steam"); fs.mkdirSync(ordinary);
  assert.deepEqual(await Preparation.getRuntimeRequirements({ gamePath: ordinary }, context(root)), []);
  for (const module of [Web, require("../src/modules/mv/main"), require("../src/modules/mz/main"),
    require("../src/modules/construct/main"), require("../src/modules/tyrano/main"),
    require("../src/modules/gamemaker-html5/main")]) assert.equal(typeof module.getRuntimeRequirements, "function");
});

test("missing encrypted-ticket and explicit native SDK roles fail before host or bridge consent and writes", async t => {
  const root = temporary(t), entry = originalGame(root), ctx = context(root), events = [];
  t.mock.method(Nwjs, "getState", () => ({ sections: [{ id: "default", defaultVersion: "0.107.0", installed: [] }, { id: "greenworks", installed: [] }] }));
  ctx.confirmRuntimeInstall = () => events.push("consent");
  const prepare = () => prepareForLaunch({ entry, mod: Web, info: Web.manifest, context: ctx,
    registry: { listModuleIds: () => [Web.id], getModule: () => Web }, install: () => events.push("install") });
  availableNativeSdk(t, root);
  t.mock.method(Ticket, "resolveBundledTicket", () => ({ ready: false, reason: "Included ticket loader is missing." }));
  await assert.rejects(prepare(), error => error.code === "GREENWORKS_TICKET_UNAVAILABLE" && !error.message.includes("Import Steamworks SDK"));
  assert.deepEqual(events, []); assert.equal(fs.existsSync(ctx.userDataDir), false);
  ctx.runtimeSettings = { steamApiMode: "native" };
  t.mock.method(Sdk, "resolveQualifiedTicket", () => null);
  await assert.rejects(prepare(), error => error.code === "GREENWORKS_TICKET_UNAVAILABLE" && error.message.includes("Import Steamworks SDK 1.63"));
  t.mock.method(Sdk, "resolveQualifiedTicket", () => ({ libraryPath: "/native/ticket.dylib" }));
  await assert.rejects(prepare(), error => error.code === "GREENWORKS_NATIVE_API_UNAVAILABLE");
  assert.deepEqual(events, []); assert.equal(fs.existsSync(ctx.userDataDir), false);
});

test("automatic Greenworks uses its exact included API profile and optional native Steam remains explicit", async t => {
  const root = temporary(t), entry = originalGame(root), ctx = context(root), sdk = availableNativeSdk(t, root), calls = [];
  const installed = { version: "0.103.1", ready: true, files: [
    { path: "greenworks.js", sha256: Contract.javascriptSha256 }, { path: "lib/greenworks-osx.node", sha256: Contract.nativeSha256 }
  ] };
  write(path.join(entry.gamePath, "steam_appid.txt"), "480\n");
  const baseEnvironment = { CUSTOM: "retained", DYLD_INSERT_LIBRARIES: "/graphics/helper.dylib" };
  ctx.prepareSteamApi = async (request, options) => {
    calls.push([request, options]);
    return { mode: "offline", abiProfile: Contract.helperAbiProfile, libraryPath: "/qualified/helper.dylib", environment: { ...options.baseEnvironment, SteamAppId: String(request.appId) } };
  };
  const steam = await Preparation.prepareLaunchEnvironment({ entry, context: ctx, install: installed,
    sourceRoot: entry.gamePath, runtimeVersion: "0.103.1", architecture: "arm64", baseEnvironment });
  assert.equal(steam.sdk.libraryPath, sdk.ticket.libraryPath);
  assert.equal(Sdk.resolveQualifiedTicket.mock.callCount(), 0);
  assert.equal(calls[0][0].version, Contract.helperVersion);
  assert.deepEqual(calls[0][0].nativeLibraryPaths, []);
  assert.equal(calls[0][0].abiProfile, Contract.helperAbiProfile); assert.equal(calls[0][0].preferOffline, true);
  assert.notEqual(calls[0][0].abiProfile, "luasteam-4.0.2-sdk1.63-ml1"); assert.deepEqual(calls[0][0].interfaces, Contract.interfaces);
  assert.equal(steam.environment.DYLD_INSERT_LIBRARIES, baseEnvironment.DYLD_INSERT_LIBRARIES);
  ctx.prepareSteamApi = async () => ({ mode: "offline", libraryPath: "/unqualified/helper.dylib", environment: {} });
  await assert.rejects(Preparation.prepareLaunchEnvironment({ entry, context: ctx, install: installed,
    sourceRoot: entry.gamePath, runtimeVersion: "0.103.1", architecture: "arm64" }), error => error.code === "GREENWORKS_ABI_UNVERIFIED");
  ctx.runtimeSettings = { steamApiMode: "native" };
  ctx.prepareSteamApi = async (request, options) => { calls.push([request, options]); return { mode: "native", libraryPath: sdk.apiLibraryPath, environment: options.baseEnvironment }; };
  await Preparation.prepareLaunchEnvironment({ entry, context: ctx, install: installed,
    sourceRoot: entry.gamePath, runtimeVersion: "0.103.1", architecture: "arm64", baseEnvironment });
  assert.deepEqual(calls[1][0].nativeLibraryPaths, [sdk.apiLibraryPath]);
  assert.equal(Sdk.resolveQualifiedTicket.mock.callCount(), 1);
  assert.equal(calls[1][0].abiProfile, undefined); assert.equal(calls[1][0].preferOffline, undefined);
  assert.throws(() => Preparation.selectedContract("0.103.1", { ready: true, files: [] }), error => error.code === "GREENWORKS_ABI_UNVERIFIED");
});

test("automatic Greenworks refuses a ticket loader outside its exact version, source, checksum or policy", t => {
  const root = temporary(t), sdk = availableNativeSdk(t, root), ctx = context(root);
  for (const patch of [{ version: "other" }, { sourceSha256: "c".repeat(64) }, { sha256: Sdk.PIN.sha256 }, { policy: "decrypt" }]) {
    t.mock.method(Ticket, "resolveBundledTicket", () => ({ ...sdk.ticket, ...patch }));
    assert.throws(() => Preparation.resolveApiRoute({ contract: Contract, context: ctx, architecture: "arm64" }),
      error => error.code === "GREENWORKS_ABI_UNVERIFIED");
  }
  assert.equal(Sdk.resolveQualifiedTicket.mock.callCount(), 0);
});

test("ticket-only automatic preparation requires its helper and real game application ID before consent", async t => {
  const root = temporary(t), entry = originalGame(root), ctx = context(root), sdk = availableNativeSdk(t, root), events = [];
  delete sdk.apiLibraryPath; delete sdk.apiSha256;
  t.mock.method(Nwjs, "getState", () => ({ sections: [{ id: "default", defaultVersion: "0.107.0", installed: [] }, { id: "greenworks", installed: [] }] }));
  ctx.confirmRuntimeInstall = plan => { events.push(plan.version); return false; };
  const prepare = () => prepareForLaunch({ entry, mod: Web, info: Web.manifest, context: ctx,
    registry: { listModuleIds: () => [Web.id], getModule: () => Web }, install: () => assert.fail("Declined runtime plans cannot install") });
  assert.equal(await prepare(), false); assert.deepEqual(events, ["0.103.1"]);
  assert.equal(fs.existsSync(ctx.userDataDir), false); assert.equal(ctx.settings.runtimes.nwjs.defaultVersion, "0.107.0");
  events.length = 0;
  t.mock.method(Steam, "resolveBundledLibrary", () => ({ ready: false, reason: "Qualified helper is missing" }));
  await assert.rejects(prepare(), error => error.code === "GREENWORKS_API_UNAVAILABLE");
  assert.deepEqual(events, []); assert.equal(fs.existsSync(ctx.userDataDir), false);
  t.mock.method(Steam, "resolveBundledLibrary", () => ({ ready: true, mode: "offline" }));
  fs.unlinkSync(path.join(entry.gamePath, "steam_appid.txt"));
  await assert.rejects(prepare(), error => error.code === "GREENWORKS_APP_ID_REQUIRED");
  assert.deepEqual(events, []); assert.equal(fs.existsSync(ctx.userDataDir), false);
});

test("the qualified offline route rejects a changed host and remains ARM-only", async t => {
  const root = temporary(t), entry = originalGame(root), ctx = context(root), sdk = availableNativeSdk(t, root);
  assert.equal(Preparation.resolveApiRoute({ contract: Contract, sdk, context: ctx, architecture: "x86_64" }).mode, "native");
  assert.throws(() => Preparation.resolveApiRoute({ contract: Contract, sdk: { ...sdk, apiLibraryPath: undefined }, context: ctx, architecture: "x86_64" }),
    error => error.code === "GREENWORKS_NATIVE_API_UNAVAILABLE");
  const executablePath = write(path.join(root, "unqualified-host"), "changed host bytes");
  t.mock.method(Nwjs.core, "resolveBestInstalled", () => ({ executablePath, platformKey: "osx-arm64" }));
  ctx.confirmRuntimeInstall = () => assert.fail("Unqualified hosts cannot ask for downloads");
  await assert.rejects(Preparation.getRuntimeRequirements(entry, ctx), error => error.code === "GREENWORKS_HOST_CHANGED");
  assert.equal(fs.existsSync(ctx.userDataDir), false);
});

test("the native bridge's actual macOS floor is enforced before preparation", async () => {
  await Preparation.assertHostFloor(Contract, { platform: "darwin", systemVersion: "13.5" });
  await Preparation.assertHostFloor(Contract, { platform: "darwin", systemVersion: "27.0.1" });
  await assert.rejects(Preparation.assertHostFloor(Contract, { platform: "darwin", systemVersion: "13.4.1" }), error => error.code === "GREENWORKS_OS_UNSUPPORTED");
  await assert.rejects(Preparation.assertHostFloor(Contract, { platform: "darwin", systemVersion: "unknown" }), error => error.code === "GREENWORKS_OS_UNKNOWN");
});

test("bounded target inspection skips assets, caches misses and invalidates nested directory changes", t => {
  const root = temporary(t), gamePath = path.join(root, "game"), directory = path.join(gamePath, "node_modules");
  fs.mkdirSync(directory, { recursive: true });
  write(path.join(gamePath, "img", "fake", "greenworks.js"), "inert asset");
  const foreign = path.join(root, "foreign"); write(path.join(foreign, "greenworks.js"), "outside");
  fs.symlinkSync(foreign, path.join(gamePath, "foreign"));
  fs.symlinkSync(gamePath, path.join(directory, "cycle"));
  assert.deepEqual(Preparation.findGreenworksTargets(gamePath), []);
  const readdir = fs.readdirSync, reads = [];
  t.mock.method(fs, "readdirSync", (...args) => { reads.push(args[0]); return readdir(...args); });
  assert.deepEqual(Preparation.findGreenworksTargets(gamePath), []);
  assert.deepEqual(reads, []);
  const target = path.join(directory, "greenworks"); write(path.join(target, "greenworks.js"), "source");
  assert.deepEqual(Preparation.findGreenworksTargets(gamePath), [target]);
  assert.ok(reads.every(file => !file.includes(path.sep + "img") && file !== foreign));
  fs.rmSync(target, { recursive: true });
  assert.deepEqual(Preparation.findGreenworksTargets(gamePath), []);
});

test("Greenworks replacement detaches original links and retains unrelated original assets", t => {
  const root = temporary(t), entry = originalGame(root), originalScript = path.join(entry.target, "greenworks.js"), originalNative = path.join(entry.target, "lib", "greenworks-win64.node");
  const before = [digest(originalScript), digest(originalNative)], wrapper = path.join(root, "wrapper"), installed = bridge(path.join(root, "installed"));
  fs.mkdirSync(wrapper); fs.symlinkSync(path.join(entry.gamePath, "node_modules"), path.join(wrapper, "node_modules"));
  const unrelated = write(path.join(entry.gamePath, "node_modules", "other", "data.bin"), "original data");
  Preparation.overlayGreenworks({ wrapperDir: wrapper, sourceRoot: entry.gamePath, greenworksDir: installed, targets: [entry.target] });
  const replaced = path.join(wrapper, "node_modules", "greenworks");
  assert.equal(fs.lstatSync(replaced).isDirectory(), true);
  assert.equal(fs.lstatSync(path.join(replaced, "greenworks.js")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(replaced, "greenworks.js"), "utf8"), fs.readFileSync(path.join(installed, "greenworks.js"), "utf8"));
  assert.deepEqual([digest(originalScript), digest(originalNative)], before);
  assert.equal(fs.realpathSync(path.join(wrapper, "node_modules", "other", "data.bin")), fs.realpathSync(unrelated));
  assert.throws(() => Preparation.overlayGreenworks({ wrapperDir: wrapper, sourceRoot: entry.gamePath, greenworksDir: installed, targets: [installed] }), error => error.code === "GREENWORKS_OVERLAY_INVALID");
});

test("native API and encrypted-ticket bindings remain separate shared symlinks in the private wrapper", t => {
  const root = temporary(t), entry = originalGame(root), wrapper = path.join(root, "wrapper"), installed = bridge(path.join(root, "installed"));
  const ticket = write(path.join(root, "shared-native", Sdk.PIN.filename), "ticket role"), api = write(path.join(root, "shared-native", Sdk.PIN.api.filename), "native API role");
  const originalHashes = [digest(path.join(entry.target, "greenworks.js")), digest(path.join(entry.target, "lib", "greenworks-win64.node"))];
  fs.mkdirSync(wrapper); fs.symlinkSync(path.join(entry.gamePath, "node_modules"), path.join(wrapper, "node_modules"));
  Preparation.overlayGreenworks({ wrapperDir: wrapper, sourceRoot: entry.gamePath, greenworksDir: installed, targets: [entry.target],
    steam: { libraryPath: api, sdk: { libraryPath: ticket } } });
  const libraries = path.join(wrapper, "node_modules", "greenworks", "lib");
  assert.equal(fs.readlinkSync(path.join(libraries, Sdk.PIN.filename)), ticket);
  assert.equal(fs.readlinkSync(path.join(libraries, Sdk.PIN.api.filename)), api);
  assert.notEqual(fs.realpathSync(path.join(libraries, Sdk.PIN.filename)), fs.realpathSync(path.join(libraries, Sdk.PIN.api.filename)));
  assert.deepEqual([digest(path.join(entry.target, "greenworks.js")), digest(path.join(entry.target, "lib", "greenworks-win64.node"))], originalHashes);
});

test("incomplete, mismatched or changed bridge payloads remain visible and cannot satisfy preparation", t => {
  const root = temporary(t), userDataDir = path.join(root, "data"), directory = Runtime.getInstallDir({ userDataDir, nwVersion: "0.103.1" });
  write(path.join(directory, "greenworks.js"), "");
  assert.equal(Runtime.listInstalled(userDataDir)[0].ready, false);
  bridge(directory);
  const status = Runtime.bridgeStatus(directory, { nwVersion: "0.103.1" }); assert.equal(status.ready, true);
  const metadata = path.join(directory, ".maclauncher-greenworks.json");
  write(metadata, JSON.stringify({ nwVersion: "0.80.0", files: status.files }));
  assert.equal(Runtime.listInstalled(userDataDir)[0].ready, false);
  write(metadata, JSON.stringify({ nwVersion: "0.103.1", files: status.files }));
  fs.appendFileSync(path.join(directory, "lib", "greenworks-osx.node"), "changed");
  assert.equal(Runtime.listInstalled(userDataDir)[0].ready, false);
  assert.throws(() => Preparation.ensureGreenworksInstalled({ userDataDir, version: "0.103.1" }), error => error.code === "GREENWORKS_UNAVAILABLE");
});

test("a fresh exact bridge install fetches an empty release cache and publishes qualified files on the data volume", async t => {
  const root = temporary(t), userDataDir = path.join(root, "data"), events = [], archive = Buffer.from("fixture archive");
  const archiveHash = crypto.createHash("sha256").update(archive).digest("hex");
  const dependencies = {
    fetchReleases: async options => { events.push("lookup"); assert.equal(options.repo, "greenworks"); return [{ tag_name: "v0.22.0", assets: [
      { name: "greenworks-v0.22.0-nw-v0.103.1-osx.zip", browser_download_url: "https://github.com/greenheartgames/greenworks/releases/download/v0.22.0/fixture.zip", digest: "sha256:" + archiveHash }
    ] }]; },
    download: async (_url, destination) => { events.push("download"); assert.equal(destination.startsWith(Runtime.installRootDir(userDataDir) + path.sep), true); write(destination, archive); },
    extract: async (_file, destination) => { events.push("extract"); bridge(destination); }
  };
  const install = await Runtime.installVersion({ userDataDir, nwVersion: "0.103.1", releases: [], dependencies });
  assert.deepEqual(events, ["lookup", "download", "extract"]); assert.equal(install.ready, true); assert.equal(install.greenworksVersion, "0.22.0");
  assert.equal(install.archiveSha256, archiveHash); assert.equal(install.version, "0.103.1");
  events.length = 0;
  assert.equal((await Runtime.installVersion({ userDataDir, nwVersion: "0.103.1", dependencies })).ready, true);
  assert.deepEqual(events, []); assert.deepEqual(fs.readdirSync(Runtime.installRootDir(userDataDir)), ["0.103.1"]);
});

test("failed bridge downloads and invalid candidate payloads preserve the existing selected installation", async t => {
  const root = temporary(t), userDataDir = path.join(root, "data"), directory = Runtime.getInstallDir({ userDataDir, nwVersion: "0.103.1" });
  const original = write(path.join(directory, "greenworks.js"), "existing incomplete installation"), before = digest(original);
  const releases = [{ tag_name: "v0.22.0", assets: [{ name: "greenworks-v0.22.0-nw-v0.103.1-osx.zip", browser_download_url: "https://example.com/file.zip" }] }];
  await assert.rejects(Runtime.installVersion({ userDataDir, nwVersion: "0.103.1", releases, dependencies: {
    download: async () => { throw Error("Download failed"); }
  } }), /Download failed/);
  await assert.rejects(Runtime.installVersion({ userDataDir, nwVersion: "0.103.1", releases, dependencies: {
    download: async (_url, destination) => write(destination, "fixture"),
    extract: async (_file, destination) => write(path.join(destination, "greenworks.js"), "no native payload")
  } }), /native macOS bridge is missing/);
  assert.equal(digest(original), before); assert.deepEqual(fs.readdirSync(Runtime.installRootDir(userDataDir)), ["0.103.1"]);
});
