const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { observeGameProcess } = require("../src/core/game-process-events");
const Provider = require("../src/modules/mac32/provider");
const Catalog = require("../src/modules/mac32/runtime/catalog");
const Payload = require("../src/modules/mac32/runtime/payload");
const { createManager } = require("../src/modules/mac32/runtime/manager");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac32-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function binary(architecture, fileType = 2, minimum = 26 << 16) {
  const wide = architecture !== "i386", size = wide ? 32 : 28;
  const bytes = Buffer.alloc(size + 24);
  bytes.writeUInt32LE(wide ? 0xfeedfacf : 0xfeedface);
  bytes.writeUInt32LE({ i386: 7, x86_64: 0x01000007, arm64: 0x0100000c }[architecture], 4);
  bytes.writeUInt32LE(fileType, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x32, size); bytes.writeUInt32LE(24, size + 4); bytes.writeUInt32LE(1, size + 8);
  bytes.writeUInt32LE(minimum, size + 12); bytes.writeUInt32LE(minimum, size + 16);
  return bytes;
}
function appEntry(root, architecture = "i386") {
  const appPath = path.join(root, "Example app.app"), executablePath = path.join(appPath, "Contents", "MacOS", "Example");
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, binary(architecture), { mode: 0o755 });
  fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>Example</string></dict></plist>');
  return { gameId: "fixture-app", nativeAppPath: appPath, runtimeData: { mac32: {
    detectionComplete: true, appPath, executablePath, executableArchitectures: [architecture]
  } } };
}
function writePayload(root, version = "0.1") {
  const executable = path.join(root, Payload.executableRelative(version));
  fs.mkdirSync(path.join(path.dirname(executable), "guest"), { recursive: true });
  fs.writeFileSync(executable, binary("x86_64"), { mode: 0o755 });
  for (const name of Payload.GUEST_LIBRARIES) fs.writeFileSync(path.join(path.dirname(executable), "guest", name), binary("i386", 6));
  for (const name of ["COPYING", "NOTICE", "README.md"]) fs.writeFileSync(path.join(root, `mac32-${version}`, name), name + " original text");
  return executable;
}
function published(version, { sha256 = "a".repeat(64), bytes = 1234 } = {}) {
  const filename = `mac32-${version}-macos.zip`;
  return { version, upstreamRevision: "b".repeat(40), upstreamTag: "v" + version, sourceUrl: `https://github.com/Shagulka/mac32/tree/${"b".repeat(40)}`,
    architecture: "x86_64", hostArchitectures: ["arm64", "x64"], requiresRosettaOnArm: true, minimumMacOS: "26.0", localBuild: false,
    asset: { filename, url: `https://github.com/Shagulka/mac32/releases/download/v${version}/${filename}`, sha256, bytes } };
}
const host = { systemVersionSync: () => "26.0" };

test("mac32 support consumes positive 32-bit bundle evidence and rejects native 64-bit apps", t => {
  const root = temporary(t), entry = appEntry(root);
  assert.equal(Provider.supportsEntry(entry), true);
  assert.equal(Provider.inspectEntry(entry).appPath, entry.nativeAppPath);
  for (const architectures of [[], ["ppc"], ["i386", "arm64"], ["i386", "x86_64"]]) {
    assert.equal(Provider.supportsEntry({ ...entry, runtimeData: { mac32: { ...entry.runtimeData.mac32, executableArchitectures: architectures } } }), false);
  }
  assert.equal(Provider.supportsEntry({ ...entry, runtimeData: {} }), false);
  assert.equal(Provider.supportsEntry({ ...entry, runtimeData: { mac32: { ...entry.runtimeData.mac32, executablePath: path.join(root, "other") } } }), false);
  fs.writeFileSync(entry.runtimeData.mac32.executablePath, binary("x86_64"));
  assert.throws(() => Provider.inspectEntry(entry), /32-bit Intel/);
});

test("mac32 plans an explicit consented download offline and rejects an unsupported host", async t => {
  const root = temporary(t), entry = appEntry(root);
  entry.runtimeData.mac32.version = "0.1";
  let network = 0;
  const manager = createManager({ dependencies: host, discoverCatalog: async () => { network++; return []; } });
  const provider = Provider.createProvider({ manager, platform: "darwin" });
  assert.equal(manager.getState({ userDataDir: root }).catalog.status, "idle");
  assert.deepEqual(await provider.ensureRuntime(entry, { settings: {}, userDataDir: root }), {
    managerId: "mac32", version: "0.1", discoveryRequired: true, requiresDownload: true, installOptions: {}
  });
  assert.equal(network, 0);
  const old = createManager({ dependencies: { systemVersionSync: () => "15.0" }, discoverCatalog: async () => assert.fail("No startup query") });
  await assert.rejects(Provider.createProvider({ manager: old }).ensureRuntime(entry, { settings: {}, userDataDir: root }), /requires macOS 26\.0/);
  assert.equal(manager.resolveSelection({ runtimeData: { mac32: { version: "unknown" } } }, {}, root).ready, false);
});

test("mac32 Runtimes stays empty before an explicit refreshed catalog", async t => {
  const root = temporary(t), next = published("0.2");
  let queries = 0;
  const manager = createManager({ dependencies: host, discoverCatalog: async () => { queries++; return [next]; } });
  const state = manager.getState({ userDataDir: root });
  assert.equal(queries, 0); assert.equal(state.catalog.status, "idle"); assert.equal(state.catalog.fetchedAt, null);
  assert.deepEqual(state.catalog.versions, []); assert.deepEqual(state.catalog.installableVersions, []);
  assert.equal(state.catalog.installable, false); assert.equal(state.catalog.recommendedVersion, null);
  assert.equal(state.versionLabels["0.1"], undefined);
  assert.equal(state.sections[0].catalog.installable, false); assert.deepEqual(state.sections[0].catalog.versions, []);
  const refreshed = await manager.refreshCatalog({ userDataDir: root, force: true });
  assert.equal(queries, 1); assert.equal(refreshed.status, "success"); assert.ok(refreshed.fetchedAt);
  assert.deepEqual(refreshed.versions, ["0.2"]); assert.deepEqual(refreshed.installableVersions, ["0.2"]);
  assert.equal(refreshed.recommendedVersion, null);
  const old = createManager({ dependencies: { systemVersionSync: () => "15.0" }, discoverCatalog: async () => assert.fail("Offline") });
  const unavailable = old.getState({ userDataDir: temporary(t) });
  assert.deepEqual(unavailable.catalog.versions, []); assert.equal(unavailable.catalog.installable, false);
  assert.deepEqual(unavailable.catalog.installableVersions, []); assert.match(unavailable.catalog.installReason, /requires macOS 26\.0/);
});

test("mac32 discovers bounded exact release archives and requires publisher SHA-256", async () => {
  const release = version => ({ tag_name: "v" + version, html_url: "https://github.com/Shagulka/mac32/releases/tag/v" + version,
    assets: [{ name: `mac32-${version}-macos.zip`, browser_download_url: `https://github.com/Shagulka/mac32/releases/download/v${version}/mac32-${version}-macos.zip`,
      digest: "sha256:" + "a".repeat(64), size: 1234, id: 12 }] });
  const absentDigest = release("0.3"); delete absentDigest.assets[0].digest;
  const wrongUrl = release("0.4"); wrongUrl.assets[0].browser_download_url = "https://example.com/mac32.zip";
  const dependencies = { fetchGithubReleases: async options => { assert.equal(options.maxPages, 5); return [release("0.2"), absentDigest, wrongUrl]; },
    fetchGithubTags: async () => [{ name: "v0.2", commit: { sha: "b".repeat(40) } }] };
  const entries = await Catalog.createDiscovery(dependencies)();
  assert.equal(entries.length, 1); assert.equal(entries[0].version, "0.2");
  assert.equal(entries[0].minimumMacOS, "26.0");
  assert.equal(entries[0].upstreamRevision, "b".repeat(40)); assert.equal(entries[0].asset.sha256, "a".repeat(64));
});

test("mac32 payload validates the native host, four guest libraries and retained licenses", t => {
  const root = temporary(t), executable = writePayload(root), pin = published("0.1");
  const metadata = Payload.preparePayload({ unpacked: root, pin }, host);
  assert.equal(metadata.minimumMacOS, "26.0.0"); assert.equal(metadata.files.length, 7);
  assert.equal(fs.readFileSync(path.join(root, "mac32-0.1", "README.md"), "utf8"), "README.md original text");
  const install = { version: "0.1", installDir: root, executablePath: executable, installationMetadata: metadata };
  const resolve = Payload.createPayloadResolver(host);
  assert.ok(resolve(install).install); assert.ok(resolve(install, { verification: "status" }).install);
  const library = path.join(path.dirname(executable), "guest", Payload.GUEST_LIBRARIES[0]);
  const old = fs.statSync(library), bytes = fs.readFileSync(library); bytes[27] ^= 1;
  fs.writeFileSync(library, bytes); fs.utimesSync(library, old.atime, old.mtime);
  assert.equal(resolve(install, { verification: "status" }).install, null);
  assert.equal(resolve(install).install, null);
  fs.writeFileSync(library, binary("i386", 6)); fs.rmSync(path.join(root, "mac32-0.1", "NOTICE"));
  assert.throws(() => Payload.preparePayload({ unpacked: root, pin }, host), /ENOENT/);
});

test("mac32 rejects guest-library aliases and non-Intel native hosts", t => {
  const root = temporary(t), executable = writePayload(root), guest = path.join(path.dirname(executable), "guest", Payload.GUEST_LIBRARIES[0]);
  const original = path.join(root, "other-library"); fs.renameSync(guest, original); fs.symlinkSync(original, guest);
  assert.throws(() => Payload.preparePayload({ unpacked: root, pin: published("0.1") }, host), /symbolic links/);
  fs.rmSync(guest); fs.renameSync(original, guest); fs.writeFileSync(executable, binary("arm64"));
  assert.throws(() => Payload.preparePayload({ unpacked: root, pin: published("0.1") }, host), /64-bit Intel/);
});

test("mac32 launches the original app with private data, explicit patch consent and normal runtime leases", async t => {
  const root = temporary(t), entry = appEntry(root), selected = { ready: true, version: "0.1", install: { installDir: path.join(root, "runtime"), executablePath: "/runtime/mac32", needsRosetta: true } };
  const uses = [], spawns = [], manager = { resolveSelection: () => selected };
  const child = new EventEmitter(); child.pid = 123;
  t.after(() => child.emit("close", 0, null));
  const provider = Provider.createProvider({ manager, platform: "darwin", spawn: async options => { spawns.push(options); return child; } });
  const before = fs.readFileSync(entry.runtimeData.mac32.executablePath);
  const context = { userDataDir: root, settings: {}, gameArguments: ["--title", "A quoted game", "", "$(literal)"], runtimeSettings: { appArgs: ["-x", "file with spaces"] }, useRuntime: async identity => uses.push(identity) };
  assert.equal((await provider.launchRuntime("mac32", entry, context)).pid, 123);
  assert.deepEqual(spawns[0].args, [entry.nativeAppPath, "-x", "file with spaces", ...context.gameArguments]);
  assert.equal(spawns[0].needsRosetta, true); assert.equal(uses[0].managerId, "mac32");
  assert.deepEqual(spawns[0].options.stdio, ["ignore", "pipe", "pipe"]);
  const directory = Provider.runtimeDirectory(entry, context);
  assert.equal(spawns[0].options.cwd, path.join(directory, "work"));
  assert.equal(spawns[0].options.env.HOME, path.join(directory, "home"));
  assert.equal(spawns[0].options.env.MAC32_NOPATCH, "1");
  assert.deepEqual(fs.readFileSync(entry.runtimeData.mac32.executablePath), before);
  const explicit = Provider.launchOptions({ enableGamePatches: true }, { home: "/private-home", temporary: "/private-tmp" },
    { MAC32_NOPATCH: "1", OPENAI_API_KEY: "launcher-secret", LANG: "en_US.UTF-8", DYLD_INSERT_LIBRARIES: "/unrelated/library" });
  assert.equal(Object.hasOwn(explicit.env, "MAC32_NOPATCH"), false);
  assert.equal(Object.hasOwn(explicit.env, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(explicit.env, "DYLD_INSERT_LIBRARIES"), false);
  assert.equal(explicit.env.LANG, "en_US.UTF-8");
  assert.equal(Provider.resolveSaveLocations(entry, context).primaryDirectory, path.join(directory, "home"));
  assert.throws(() => Provider.launchOptions({ appArgs: ["bad\0arg"] }, {}), /NUL/);
});

test("generic Mac apps expose mac32 window graphics and shared effects reach the direct Intel host", async t => {
  const { createLauncher } = require("../src/core/launcher");
  const { composeRuntimeProviders } = require("../src/modules/shared/runtime/providers");
  const NativeFocus = require("../src/modules/shared/runtime/native-focus");
  const ReShade = require("../src/modules/shared/reshade");
  // This branch tests selected effects without the optional live-off bootstrap;
  // its availability must not depend on real fetched application resources.
  t.mock.method(require("../src/modules/shared/reshade/live-resources"), "supported", () => false);
  const registered = require("../src/modules/registry").getModuleInfo("generic-app");
  assert.equal(registered.runtime.entries.mac32.graphicsHost, "window");
  assert.equal(registered.runtime.entries.mac32.graphicsArchitecture, "x86_64");
  const root = temporary(t), fixture = appEntry(root), executablePath = path.join(root, "mac32-host");
  fs.writeFileSync(executablePath, binary("x86_64"), { mode: 0o755 });
  const manager = { resolveSelection: () => ({ ready: true, version: "0.1", install: {
    version: "0.1", installDir: root, executablePath, needsRosetta: true
  } }) };
  const provider = Provider.createProvider({ manager, platform: "darwin",
    spawn: options => NativeFocus.spawnForegroundNativeGame(options, { platform: "darwin", focus: async () => {} }) });
  const mod = composeRuntimeProviders(require("../src/modules/generic-app/main"), [provider]);
  assert.equal(mod.manifest.runtime.entries.mac32.graphicsHost, "window");
  assert.equal(mod.manifest.runtime.entries.mac32.graphicsArchitecture, "x86_64");
  const registry = { listModules: () => [mod.manifest], getModule: () => mod, getModuleInfo: () => mod.manifest };
  const invocations = [], effects = { DYLD_INSERT_LIBRARIES: "/included/graphics/libreshade-macos.dylib",
    RESHADE_SPATIAL_METHOD: "metalfx", RESHADE_LIVE_EFFECTS: "/private/live-effects" };
  let enabled = false, preparations = 0;
  t.mock.method(ReShade, "prepare", async (_entry, options) => {
    preparations++; assert.equal(options.graphicsHost, "window"); assert.equal(options.explicitHost, false);
    assert.equal(options.graphicsArchitecture, "x86_64");
    assert.deepEqual(options.graphicsInputs, {architecture: "x86_64"});
    return enabled ? effects : {};
  });
  const launcher = createLauncher({ userDataDir: root, registry, writeCheatsFile: () => null,
    rosetta: { requiresForExecutable: () => true, isAvailable: () => true },
    spawn: (command, args, options) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
      child.unref = () => {}; child.exitCode = null; child.signalCode = null;
      invocations.push({ command, args, options, child }); queueMicrotask(() => { child.emit("spawn"); child.stdio[3].write("isolated\n"); });
      return child;
    } });
  const entry = { ...fixture, moduleId: "generic-app", gameType: "native", runtimeId: "mac32", gamePath: fixture.nativeAppPath };
  for (enabled of [false, true]) {
    entry.effects = enabled ? {schema: 2, mode: "advanced", enabled: true, video: [{id: "spatial", kind: "spatial", enabled: true, method: "metalfx", settings: {}}]} : null;
    const context = launcher.getLaunchContext(entry, {}, { runtimeId: "mac32", gameEffects: true });
    const child = await mod.launchRuntime("mac32", entry, context);
    const invocation = invocations.at(-1);
    assert.equal(invocation.command, "/usr/bin/sandbox-exec");
    assert.deepEqual(invocation.args.slice(-2), [executablePath, entry.nativeAppPath], "The isolated bootstrap executes the selected Intel host and game");
    if (enabled) assert(invocation.args.includes(`DYLD_INSERT_LIBRARIES=${effects.DYLD_INSERT_LIBRARIES}`), "The bootstrap restores graphics injection after applying network policy");
    assert.equal(invocation.options.env.SDL_MAC_BACKGROUND_APP, "0");
    assert.equal(invocation.options.env.HOME, path.join(Provider.runtimeDirectory(entry, context), "home"));
    if (enabled) {
      for (const [key, value] of Object.entries(effects)) assert.equal(invocation.options.env[key], value);
    } else {
      assert.equal(invocation.options.env.DYLD_INSERT_LIBRARIES, undefined);
      assert.equal(invocation.options.env.RESHADE_SPATIAL_METHOD, undefined);
    }
    child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit("exit", 0, null); child.emit("close", 0, null);
  }
  assert.equal(preparations, 1, "Only the enabled graphics launch prepares effects");
});

test("mac32 retains startup stdout/stderr and supplies fatal details through ordinary process completion", async t => {
  const root = temporary(t), entry = appEntry(root), child = new EventEmitter();
  child.pid = 456; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const failures = [], events = [], context = { userDataDir: root, settings: {}, runtimeSettings: {}, onProcessSpawn: async process => {
    assert.equal(process.completionDiagnostics.pending, true); events.push("owned");
  } };
  const previous = context.onProcessSpawn;
  const provider = Provider.createProvider({ platform: "darwin", manager: { resolveSelection: () => ({ ready: true, version: "0.1",
    install: { installDir: "/runtime", executablePath: "/runtime/mac32", needsRosetta: false } }) }, spawn: async options => {
    await options.context.onProcessSpawn(child);
    child.stdout.write("Original startup output\n"); child.stderr.write("[mac32] cannot load required library\n");
    return child;
  } });
  await provider.launchRuntime("mac32", entry, context);
  assert.equal(context.onProcessSpawn, previous); assert.deepEqual(events, ["owned"]);
  observeGameProcess(child, { onFailure: result => failures.push(result) });
  child.exitCode = 1; child.emit("exit", 1, null);
  assert.equal(failures.length, 0);
  child.stderr.end("Original fatal detail\n"); child.stdout.end(); child.emit("close", 1, null);
  assert.equal(failures.length, 1); assert.match(failures[0].diagnostics.message, /cannot load required library/);
  assert.match(failures[0].diagnostics.message, /Original fatal detail/);
  const file = child.completionDiagnostics.logFile;
  assert.match(fs.readFileSync(file, "utf8"), /Original startup output/);
  assert.match(fs.readFileSync(file + ".head", "utf8"), /Original fatal detail/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(child.stdout.listenerCount("data"), 0); assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.listenerCount("exit"), 0);
});

test("mac32 output remains bounded and drains a descendant-held pipe after exit", async t => {
  const root = temporary(t), child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  Provider.captureRuntimeOutput(root).attach(child);
  child.stdout.write(Buffer.alloc(1400 * 1024, 65)); child.stderr.write("Final failure detail");
  child.emit("exit", 1, null); assert.equal(child.completionDiagnostics.pending, true);
  t.mock.timers.tick(1000);
  assert.equal(child.completionDiagnostics.pending, false); assert.match(child.completionDiagnostics.message, /Final failure detail/);
  assert.ok(fs.statSync(path.join(root, "runtime.log")).size <= 512 * 1024);
  assert.equal(fs.statSync(path.join(root, "runtime.log.previous")).size, 512 * 1024);
  assert.equal(fs.statSync(path.join(root, "runtime.log.head")).size, 64 * 1024);
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
});

test("mac32 refuses private app data paths redirected inside the original bundle", t => {
  const root = temporary(t), entry = appEntry(root), data = path.join(root, "data-alias");
  fs.symlinkSync(entry.nativeAppPath, data, "dir");
  assert.throws(() => Provider.prepareDirectories(entry, { userDataDir: data }), /separate/);
  assert.equal(fs.existsSync(path.join(entry.nativeAppPath, "games")), false);
});

test("mac32 managed install verifies archives, preserves versions and removes only owned runtime files", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), archive = Buffer.from("mac32 managed test archive"), sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  const pin = published("0.1", { sha256, bytes: archive.length });
  let downloads = 0;
  const manager = createManager({ catalog: [pin], discoverCatalog: async () => [pin], dependencies: { ...host,
    downloadToFile: async (_url, destination) => { downloads++; fs.writeFileSync(destination, archive); },
    extractArchive: async (_archive, destination) => writePayload(destination) } });
  const installed = await manager.installRuntime({ userDataDir: root, version: "0.1" });
  assert.equal(installed.needsRosetta, process.arch === "arm64");
  assert.equal(manager.resolveSelection({}, {}, root).ready, true);
  assert.equal(downloads, 1);
  await manager.installRuntime({ userDataDir: root, version: "0.1" }); assert.equal(downloads, 1);
  const settings = manager.applySettingsUpdate("setDefault", { version: "0.1" }, {});
  assert.equal(settings.defaultVersion, "0.1");
  assert.equal(manager.getState({ userDataDir: root }).installed[0].ready, true);
  fs.appendFileSync(path.join(path.dirname(installed.executablePath), "guest", Payload.GUEST_LIBRARIES[0]), "changed");
  assert.equal(manager.resolveSelection({}, {}, root).ready, false);
  assert.equal(manager.getState({ userDataDir: root }).installed[0].ready, false);
  const original = appEntry(root).nativeAppPath;
  manager.uninstallRuntime({ userDataDir: root, version: "0.1" });
  assert.equal(fs.existsSync(installed.installDir), false); assert.equal(fs.existsSync(original), true);
  assert.deepEqual(manager.updateSettingsAfterUninstall(settings, {}, { userDataDir: root }), { defaultVersion: null });
});
