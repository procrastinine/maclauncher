const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Overlay = require("../src/modules/shared/runtime/steamworks/source-overlay");
const Build = require("../src/modules/shared/runtime/steamworks/build");
const Environment = require("../src/modules/shared/runtime/steamworks/environment");
const Steam = require("../src/modules/shared/runtime/steamworks");
const GameMakerSteam = require("../src/modules/gamemaker/runtime/steam-api");
const source = path.resolve(__dirname, "../src/external/goldberg-mac");
const available = Object.keys(Overlay.ORIGINAL_SHA256).every(file => fs.existsSync(path.join(source, file)));

function ownedExport(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steamworks-source-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of Object.keys(Overlay.ORIGINAL_SHA256)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(root, file));
  }
  return root;
}

test("Steam API overlay refuses a changed source before modifying any output", { skip: !available }, context => {
  const root = ownedExport(context), files = Object.keys(Overlay.ORIGINAL_SHA256);
  fs.appendFileSync(path.join(root, files.at(-1)), "\nchanged upstream\n");
  const before = files.map(file => fs.readFileSync(path.join(root, file)));
  assert.throws(() => Overlay.applySourceOverlay(root), /input changed/);
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(path.join(root, file)), before[index]));
});

test("Steam API overlay changes only an owned export and records exact input/output identities", { skip: !available }, context => {
  const root = ownedExport(context);
  const before = Object.keys(Overlay.ORIGINAL_SHA256).map(file => fs.readFileSync(path.join(source, file)));
  const result = Overlay.applySourceOverlay(root);
  assert.equal(result.version, "goldberg-mac-1.0.0-ml1-universal");
  for (const [index, file] of result.files.entries()) {
    assert.deepEqual(fs.readFileSync(path.join(source, file.path)), before[index], "upstream must remain unchanged");
    assert.equal(file.beforeSha256, crypto.createHash("sha256").update(before[index]).digest("hex"));
    assert.equal(file.afterSha256, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file.path))).digest("hex"));
    assert.notEqual(file.beforeSha256, file.afterSha256);
  }
  assert.throws(() => Overlay.applySourceOverlay(root), /input changed/, "an applied export cannot be silently patched twice");
  assert.throws(() => Overlay.applySourceOverlay(source), /separate owned source export/);
});

test("Steam API dependency validation rejects changed archives without a build or network request", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steamworks-dependencies-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "curl.tar.gz"), "changed source archive");
  assert.throws(() => Build.validateDependencyArchives(root), /dependency source changed: curl/);
  assert.throws(() => Build.validateDependencyArchives("relative"), /absolute directory/);
});

test("Steam API environment contains owned offline configuration and preserves the parent", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steamworks-environment-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = { PATH: "/usr/bin", SteamAppId: "999", SteamGameId: "999", SteamOverlayGameId: "999", GseSavePath: "/foreign" };
  const options = { libraryPath: path.join(root, "resources/libsteam_api.dylib"), ownedDirectory: path.join(root, "owned"),
    appId: 480, interfaces: ["SteamClient017", "SteamUser018", "STEAMREMOTESTORAGE_INTERFACE_VERSION013"], baseEnvironment: base };
  const prepared = Environment.prepareEnvironment(options);
  assert.deepEqual(base, { PATH: "/usr/bin", SteamAppId: "999", SteamGameId: "999", SteamOverlayGameId: "999", GseSavePath: "/foreign" });
  assert.equal(prepared.environment.SteamAppId, "480");
  assert.equal(prepared.environment.SteamGameId, "480");
  assert.equal(prepared.environment.SteamOverlayGameId, undefined);
  assert.equal(prepared.environment.GseSavePath, prepared.savePath);
  assert.equal(prepared.environment.DYLD_LIBRARY_PATH, path.dirname(options.libraryPath));
  const saveConfig = path.join(prepared.savePath, "settings/configs.main.ini");
  fs.writeFileSync(saveConfig, "[main::connectivity]\ndisable_networking=0\ndownload_steamhttp_requests=1\n");
  Environment.prepareEnvironment(options);
  for (const config of [path.join(prepared.settingsPath, "configs.main.ini"), saveConfig]) {
    const text = fs.readFileSync(config, "utf8");
    assert.match(text, /^disable_networking=1$/m);
    assert.match(text, /^offline=1$/m);
    assert.match(text, /^download_steamhttp_requests=0$/m);
    assert.match(text, /^enable_voice_chat=0$/m);
  }
  assert.match(fs.readFileSync(path.join(prepared.settingsPath, "configs.overlay.ini"), "utf8"), /^enable_experimental_overlay=0$/m);
});

test("Steam API preparation rejects ambiguous ABIs and preserves unrelated files", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steamworks-environment-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => Environment.configurationFiles({ appId: 480, interfaces: ["SteamClient017", "SteamClient023"] }), /exactly one Steam client/);
  assert.throws(() => Environment.configurationFiles({ appId: -480, interfaces: ["SteamClient017"] }), /positive Steam application/);
  fs.writeFileSync(path.join(root, "original.dat"), "original bytes");
  assert.throws(() => Environment.writeOwnedConfiguration(root, Environment.configurationFiles({ appId: 480, interfaces: ["SteamClient017"] })), /unrelated files/);
  assert.deepEqual(fs.readdirSync(root), ["original.dat"]);
  assert.equal(fs.readFileSync(path.join(root, "original.dat"), "utf8"), "original bytes");
});

function libraryFixture(root, architecture) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(architecture === "x86_64" ? 0x01000007 : 0x0100000c, 4);
  bytes.writeUInt32LE(6, 12);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "libsteam_api.dylib");
  fs.writeFileSync(file, bytes, { mode: 0o644 });
  return { file, bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

test("Steam API lookup enforces interface, architecture, manifest and full payload identity", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steamworks-payload-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "native-runtimes/steam-api-helper", Overlay.VERSION, "universal");
  const library = libraryFixture(directory, "x86_64"), interfaces = ["SteamClient017", "SteamUser018"];
  const manifest = { schemaVersion: 1, id: "steam-api-helper", version: Overlay.VERSION, sourceRevision: Overlay.SOURCE_REVISION,
    librarySha256: library.sha256, qualifiedInterfaces: interfaces,
    files: [{ path: "libsteam_api.dylib", size: library.bytes.length, sha256: library.sha256, mode: 0o644, architectures: ["x86_64"] }] };
  const content = JSON.stringify(manifest);
  fs.writeFileSync(path.join(directory, "helper.json"), content, { mode: 0o644 });
  const catalog = [{ version: Overlay.VERSION, sourceRevision: Overlay.SOURCE_REVISION, architectures: ["x86_64"], qualifiedInterfaces: interfaces,
    librarySha256: library.sha256, manifestSha256: crypto.createHash("sha256").update(content).digest("hex") }];
  const options = { resourcesRoot: root, architecture: "x86_64", interfaces, catalog };
  assert.equal(Steam.resolveBundledLibrary(options).ready, true);
  assert.equal(Steam.resolveBundledLibrary({ ...options, architecture: "arm64" }).ready, false);
  assert.equal(Steam.resolveBundledLibrary({ ...options, interfaces: ["SteamClient023"] }).ready, false);
  fs.writeFileSync(path.join(directory, "extra.dylib"), "unexpected native file");
  assert.match(Steam.resolveBundledLibrary(options).reason, /file inventory differs/);
  fs.unlinkSync(path.join(directory, "extra.dylib"));
  fs.writeFileSync(library.file, Buffer.alloc(32));
  assert.match(Steam.resolveBundledLibrary(options).reason, /checksum or permissions changed/);
  fs.writeFileSync(library.file, library.bytes);
  fs.appendFileSync(path.join(directory, "helper.json"), " ");
  assert.match(Steam.resolveBundledLibrary(options).reason, /manifest changed/);
});

test("source-package revisions preserve native ABI identity and never fall back to an older package", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steamworks-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageVersion = Overlay.VERSION + "-package2";
  const directory = path.join(root, "native-runtimes/steam-api-helper", packageVersion, "universal");
  const library = libraryFixture(directory, "x86_64"), interfaces = ["SteamClient017", "SteamUser018"];
  const manifest = { schemaVersion: 1, id: "steam-api-helper", version: Overlay.VERSION, packageVersion, sourcePackageVersion: 2,
    sourceRevision: Overlay.SOURCE_REVISION, librarySha256: library.sha256, qualifiedInterfaces: interfaces,
    files: [{ path: "libsteam_api.dylib", size: library.bytes.length, sha256: library.sha256, mode: 0o644, architectures: ["x86_64"] }] };
  const pin = { version: Overlay.VERSION, packageVersion, sourcePackageVersion: 2, sourceRevision: Overlay.SOURCE_REVISION,
    architectures: ["x86_64"], qualifiedInterfaces: interfaces, librarySha256: library.sha256 };
  const publishManifest = () => {
    const content = JSON.stringify(manifest);
    fs.writeFileSync(path.join(directory, "helper.json"), content, { mode: 0o644 });
    pin.manifestSha256 = crypto.createHash("sha256").update(content).digest("hex");
  };
  publishManifest();
  const options = { resourcesRoot: root, architecture: "x86_64", interfaces, catalog: [pin] };
  const result = Steam.resolveBundledLibrary(options);
  assert.equal(result.ready, true);
  assert.equal(result.version, Overlay.VERSION);
  assert.equal(result.packageVersion, packageVersion);
  assert.equal(result.sha256, library.sha256);
  assert.equal(result.libraryPath, library.file);
  manifest.sourcePackageVersion = 1; publishManifest();
  assert.match(Steam.resolveBundledLibrary(options).reason, /source\/version identity changed/);
  manifest.sourcePackageVersion = 2; manifest.packageVersion = Overlay.VERSION; publishManifest();
  assert.match(Steam.resolveBundledLibrary(options).reason, /source\/version identity changed/);
  assert.match(Steam.resolveBundledLibrary({ ...options, catalog: [{ ...pin, packageVersion: "../other" }] }).reason, /package version is invalid/);
  fs.renameSync(path.dirname(directory), path.join(root, "native-runtimes/steam-api-helper", Overlay.VERSION));
  assert.equal(Steam.resolveBundledLibrary(options).present, false);
});

test("GameMaker Steam preflight prefers matching native libraries and blocks unknown offline ABIs", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gamemaker-steam-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "original"), dataPath = path.join(game, "data.win"), app = path.join(root, "owned/Runner.app");
  const originalLibrary = libraryFixture(game, "arm64");
  fs.writeFileSync(dataPath, "original game bytes");
  const nativeLibrary = libraryFixture(path.join(app, "Contents/MacOS"), "x86_64");
  const inspection = { steamFunctions: true, steamAppId: -480 };
  const install = { version: "1.4.9999", binarySha256: GameMakerSteam.LEGACY_SHA256, runnerAppPath: app, architectures: ["x86_64"] };
  const result = GameMakerSteam.resolveDependency(inspection, dataPath, install, { offline: false });
  assert.equal(result.mode, "native");
  assert.equal(result.libraryPath, nativeLibrary.file, "an ARM game library cannot satisfy an Intel legacy runner");
  fs.unlinkSync(nativeLibrary.file);
  assert.throws(() => GameMakerSteam.resolveDependency(inspection, dataPath, { ...install, version: "2024.13.1.242", architectures: ["x86_64"] },
    { resourcesRoot: root }), error => error.code === "GAMEMAKER_STEAM_DEPENDENCY_REQUIRED");
  assert.equal(GameMakerSteam.resolveDependency({}, dataPath, install), null);
  assert.deepEqual(fs.readFileSync(originalLibrary.file), originalLibrary.bytes);
  assert.equal(fs.readFileSync(dataPath, "utf8"), "original game bytes");
});

test("GameMaker delegates its exact legacy Steam ABI to the shared automatic service", async t => {
  const calls = [], environment = { DYLD_INSERT_LIBRARIES: "/graphics.dylib" };
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gamemaker-shared-steam-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const entry = { gameId: "fixture", contentRootDir: "/original" };
  const context = { userDataDir, prepareSteamApi: async (request, options) => {
    calls.push({ request, options }); return { mode: "offline", version: request.version, environment };
  } };
  assert.equal(await GameMakerSteam.prepareDependency(null, entry, context, environment), null);
  assert.deepEqual(calls, []);
  const dependency = { ready: true, mode: "offline", version: Overlay.VERSION,
    appId: 480, architecture: "x86_64", interfaces: [...GameMakerSteam.LEGACY_INTERFACES] };
  const result = await GameMakerSteam.prepareDependency(dependency, entry, context, environment);
  assert.equal(result.environment, environment);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.required, true);
  assert.equal(calls[0].request.version, Overlay.VERSION);
  assert.equal(calls[0].request.arch, "x86_64");
  assert.equal(calls[0].request.appId, 480);
  assert.deepEqual(calls[0].request.interfaces, GameMakerSteam.LEGACY_INTERFACES);
  assert.equal(calls[0].request.preferOffline, true);
  assert.deepEqual(calls[0].request.nativeLibraryPaths, []);
  assert.equal(calls[0].request.ownedDirectory, path.join(userDataDir, "games/fixture/modules/gamemaker/official-steam"));
  assert.equal(calls[0].options.baseEnvironment, environment);
});
