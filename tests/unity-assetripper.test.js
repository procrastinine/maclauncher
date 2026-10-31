// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { image, universal, ARM64, X64 } = require("./fixtures/macho-image");
const Manager = require("../src/modules/unity/tools/assetripper-manager");
const { stoppedDownloads, assertConsentedDiscovery, assertReceiptOffline } = require("./helpers/catalog-only-runtime.cjs");
const Session = require("../src/modules/unity/tools/assetripper-session");
const Assets = require("../src/modules/unity/tools/assets");
const { createRuntimeCoordinator } = require("../src/core/runtime-coordinator");
const { withRuntimeUse } = require("../src/core/coordinated-runtime-managers");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-assetripper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installDir = path.join(root, "tool"), dataRoot = path.join(root, "data");
  fs.mkdirSync(installDir); fs.mkdirSync(dataRoot);
  fs.writeFileSync(path.join(installDir, "AssetRipper.GUI.Free"), image({ cpu: ARM64, fileType: 2, minimumOS: 0x000c0000 }));
  fs.writeFileSync(path.join(installDir, "libcapstone.dylib"), image({ cpu: ARM64, fileType: 6, minimumOS: 0x000c0000 }));
  const installationMetadata = Manager.__test.prepareInstall({ unpacked: installDir }, { systemVersionSync: () => "15.0" });
  const install = { version: "2.0.0", installDir, installationMetadata, upstreamRevision: "a".repeat(40), archiveSha256: "b".repeat(64) };
  const entry = { gameId: "unity-game", moduleData: { dataRoot } }, context = { userDataDir: path.join(root, "userData"), settings: {} };
  const manager = { id: "assetripper", label: "AssetRipper", resolveSelection: () => ({ ready: true, install, version: install.version }) };
  return { root, installDir, dataRoot, install, entry, context, manager };
}
function fakeSession(root) {
  const child = new EventEmitter(); child.pid = 10101;
  let open = true;
  const session = { child, url: "http://127.0.0.1:54321", logPath: path.join(root, "AssetRipper.log"),
    isOpen: () => open, close: () => { if (open) { open = false; child.emit("close", 0); } }, waitClosed: async () => {} };
  return session;
}
const repository = "AssetRipper/AssetRipper";
// Release routes whose list request is counted.
function releaseRoutes(releases, counter) {
  const routes = Harness.githubRoutes(repository, releases), list = `https://api.github.com/repos/${repository}/releases`, listing = routes[list];
  routes[list] = () => { counter.requests++; return listing; };
  return routes;
}
const fakeUse = async (_identities, work) => work({ bind: async () => {}, retainUntilClosed: () => {} });

test("AssetRipper discovers inside a consented install and keeps earlier installations offline", { skip: process.platform !== "darwin" }, async t => {
  const { root } = setup(t), downloads = stoppedDownloads(), counter = { requests: 0 };
  const url = (tag, cpu) => `https://github.com/${repository}/releases/download/${tag}/AssetRipper_mac_${cpu}.tar.xz`;
  const release = tag => Harness.githubRelease(repository, tag, ["arm64", "x64"].map(cpu => `AssetRipper_mac_${cpu}.tar.xz`));
  const manager = Manager.__test.createManager({ dependencies: { systemVersionSync: () => "15.0", downloadToFile: downloads.downloadToFile } });
  Harness.network.routes = releaseRoutes([release("2.1.0"), release("2.0.0")], counter);
  t.after(() => { Harness.network.routes = null; });
  await assertConsentedDiscovery({ manager, userDataDir: path.join(root, "consent"), discoveries: () => counter.requests, downloads,
    newestUrl: url("2.1.0", process.arch === "x64" ? "x64" : "arm64") });
  Harness.network.routes = null;
  const offline = Manager.__test.createManager({ dependencies: { systemVersionSync: () => "15.0" } });
  assertReceiptOffline({ manager: offline, userDataDir: path.join(root, "offline"), pin: { version: "2.0.0", upstreamRevision: "1ac666f47d8e9dedf96afb0b914c70d7656151ea",
    minimumMacOS: "12.0", architecture: process.arch === "x64" ? "x64" : "arm64", localBuild: false,
    asset: { filename: "AssetRipper_mac_arm64.tar.xz", url: url("2.0.0", "arm64"), bytes: 27205056, sha256: "237a6da404bf089c5e5c71a5a9a698c2ea580872292dfa5ce21e25fd1dbe9045" } } });
});
test("AssetRipper catalog remains offline until refresh and retains multiple stable native releases", async t => {
  const { context } = setup(t), counter = { requests: 0 };
  const release = (tag, name = "AssetRipper_mac_arm64.tar.xz", extra) => Harness.githubRelease(repository, tag, [name], extra);
  const manager = Manager.__test.createManager({ dependencies: { systemVersionSync: () => "15.0" } });
  assert.deepEqual(manager.getState(context).catalog.versions, []);
  assert.deepEqual(manager.core.listCatalog().map(pin => pin.version), []);
  const automatic = manager.resolveSelection({}, {}, context.userDataDir);
  assert.equal(automatic.version, null); assert.equal(automatic.discoveryRequired, true);
  assert.equal(counter.requests, 0);
  Harness.network.routes = releaseRoutes([release("5.0.0", "AssetRipper_win_x64.zip"), release("4.0.0", undefined, { prerelease: true }),
    release("3.0.0-rc1"), release("2.1.0"), release("2.0.0"), release("1.3.14", "AssetRipper_mac_arm64.zip"),
    release("1.3.10", "AssetRipper_mac_arm64.zip"), release("1.3.0")], counter);
  try { await manager.refreshCatalog({ ...context, force: true }); } finally { Harness.network.routes = null; }
  assert.equal(counter.requests, 1);
  assert.deepEqual(manager.getState(context).catalog.versions, ["5.0.0", "2.1.0", "2.0.0", "1.3.14", "1.3.10"]);
  assert.match(manager.getState(context).catalog.versionRequirements["5.0.0"].installReason, /no macOS download/, "A release without a Mac download stays listed with its reason");
  assert.equal(manager.resolveSelection({}, {}, context.userDataDir).version, "2.1.0", "The newest listed release is the manager default");
  const settings = { runtimes: { assetripper: { defaultVersion: "2.1.0" } } };
  assert.equal(manager.resolveSelection({}, settings, context.userDataDir).version, "2.1.0");
  assert.equal(manager.resolveSelection({ runtimeData: { assetripper: { version: "1.3.14" } } }, settings, context.userDataDir).version, "1.3.14");
  assert.equal(manager.resolveSelection({}, { runtimes: { assetripper: { defaultVersion: null } } }, context.userDataDir).version, "2.1.0", "A cleared saved default uses the manager default");
  assert.deepEqual(settings, { runtimes: { assetripper: { defaultVersion: "2.1.0" } } });
  assert.equal(manager.ui.tabLabel, "Tools");
  assert.equal(manager.getState(context).sections[0].label, "AssetRipper");
  manager.getState(context); assert.equal(counter.requests, 1);
});

test("native inventory checks CPU, host floor and changed siblings", t => {
  const { installDir, install } = setup(t);
  const manager = Manager.__test.createManager({ dependencies: { systemVersionSync: () => "15.0" } });
  assert.equal(manager.__test.verifyInstall(install).minimumMacOS, "12.0.0");
  assert.equal(fs.statSync(path.join(installDir, "AssetRipper.GUI.Free")).mode & 0o222, 0);
  assert.equal(fs.statSync(path.join(installDir, "libcapstone.dylib")).mode & 0o222, 0);
  assert.throws(() => Manager.__test.prepareInstall({ unpacked: installDir }, { systemVersionSync: () => "11.0" }), /macOS 12/);
  fs.chmodSync(path.join(installDir, "libcapstone.dylib"), 0o644);
  assert.equal(manager.__test.verifyInstall(install), null);
  fs.writeFileSync(path.join(installDir, "libcapstone.dylib"), image({ cpu: X64, fileType: 6 }));
  assert.throws(() => Manager.__test.prepareInstall({ unpacked: installDir }, { systemVersionSync: () => "15.0" }), { code: "MACHO_ARCH" });
});

test("universal siblings verify the selected Apple Silicon dependency closure and macOS floor", t => {
  const { installDir } = setup(t), library = path.join(installDir, "libcapstone.dylib"); fs.chmodSync(library, 0o644);
  fs.writeFileSync(library, universal([{ cpu: ARM64, bytes: image({ cpu: ARM64, fileType: 6, minimumOS: 0x000c0000 }) },
    { cpu: X64, bytes: image({ cpu: X64, fileType: 6, minimumOS: 0x000f0000 }) }]));
  assert.equal(Manager.__test.prepareInstall({ unpacked: installDir }, { systemVersionSync: () => "13.0" }).minimumMacOS, "12.0.0");
});

test("workspaces share native files read-only and retain separate preferences after closing", t => {
  const { root, installDir, install } = setup(t), directory = path.join(root, "workspace");
  const workspace = Session.prepareWorkspace(install, directory);
  for (const relative of ["AssetRipper.GUI.Free", "libcapstone.dylib"]) {
    const source = fs.statSync(path.join(installDir, relative)), linked = fs.statSync(path.join(directory, relative));
    assert.equal(source.ino, linked.ino); assert.equal(source.dev, linked.dev); assert.equal(linked.mode & 0o222, 0);
  }
  fs.writeFileSync(path.join(directory, "AssetRipper.Settings.json"), "{\"SaveSettingsToDisk\":true}");
  fs.mkdirSync(path.join(directory, "temp")); fs.writeFileSync(path.join(directory, "temp", "temporary"), "data");
  workspace.cleanup();
  workspace.cleanup();
  assert.equal(fs.existsSync(path.join(directory, "AssetRipper.GUI.Free")), false);
  assert.equal(fs.existsSync(path.join(directory, "temp")), false);
  assert.ok(fs.existsSync(path.join(directory, "AssetRipper.Settings.json")));
  assert.equal(fs.existsSync(path.join(installDir, "AssetRipper.Settings.json")), false);
  assert.ok(fs.existsSync(path.join(installDir, "libcapstone.dylib")));
});

test("session startup uses headless loopback ephemeral ports and cleans links after close", async t => {
  const { root, install } = setup(t), directory = path.join(root, "session");
  const child = new EventEmitter(); child.pid = 20202; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => queueMicrotask(() => child.emit("close", 0));
  const session = await Session.startSession(install, directory, { spawnChild: (_file, args, options) => {
    assert.deepEqual(args.slice(0, 4), ["--headless", "--port", "0", "--log-path"]);
    assert.equal(options.cwd, directory); assert.equal(options.env.TMPDIR, directory);
    queueMicrotask(() => child.stdout.emit("data", "Now listening on: http://127.0.0.1:49152\n")); return child;
  }, onSpawn: owned => assert.equal(owned.pid, 20202) });
  assert.equal(session.url, "http://127.0.0.1:49152");
  session.close(); await session.waitClosed();
  assert.equal(session.isOpen(), false); assert.equal(fs.existsSync(path.join(directory, "AssetRipper.GUI.Free")), false);
});

test("separate game inspectors request independent ephemeral ports and ownership failure stops the server", async t => {
  const { root, install } = setup(t); const owned = [];
  const start = async port => Session.startSession(install, path.join(root, "game-" + port), { spawnChild: (_file, args) => {
    assert.equal(args[2], "0");
    const child = new EventEmitter(); child.pid = port; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => child.emit("close", 0));
    queueMicrotask(() => child.stdout.emit("data", "Now listening on: http://127.0.0.1:" + port + "\n")); return child;
  }, onSpawn: child => { owned.push(child.pid); if (port === 49155) throw new Error("Ownership failed"); } });
  const [first, second] = await Promise.all([start(49153), start(49154)]);
  assert.notEqual(first.url, second.url); assert.deepEqual(owned, [49153, 49154]);
  first.close(); second.close(); await Promise.all([first.waitClosed(), second.waitClosed()]);
  await assert.rejects(start(49155), /Ownership failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(path.join(root, "game-49155", "AssetRipper.GUI.Free")), false);
});

test("API requests use only the owned local origin without following redirects", async () => {
  const session = { url: "http://127.0.0.1:49152", logPath: "tool.log" }; let requests = 0;
  const request = async (url, options) => { requests++; assert.equal(url, session.url + "/LoadFolder");
    assert.equal(options.redirect, "manual"); assert.equal(options.body.get("Path"), "/game/data"); return { status: 302, ok: false }; };
  await Session.localRequest(session, "/LoadFolder", { Path: "/game/data" }, { fetch: request });
  await assert.rejects(Session.localRequest({ ...session, url: "https://example.com" }, "/LoadFolder", {}, { fetch: request }), /local inspector/);
  await assert.rejects(Session.localRequest(session, "/LoadFolder?remote=true", {}, { fetch: request }), /local inspector/);
  assert.equal(requests, 1);
});

test("canceling first asset-action download prevents installation and process startup", async t => {
  const { entry, context, manager } = setup(t); let installs = 0, spawned = 0;
  manager.resolveSelection = () => ({ ready: false, version: "2.0.0" });
  manager.installRuntime = async () => { installs++; };
  const denied = { ...context, confirmRuntimeInstall: async plan => { assert.equal(plan.managerId, "assetripper");
    assert.equal(plan.confirmLabel, "Download and Continue"); return false; } };
  await assert.rejects(Assets.exportAssets(entry, {}, denied, { manager, startSession: () => { spawned++; } }), { code: "ABORT_ERR" });
  assert.equal(installs, 0); assert.equal(spawned, 0);
});

test("asset exports resume after installation and preserve an earlier export on failure", async t => {
  const { root, entry, context, manager, install } = setup(t); let ready = false, prompts = 0, installs = 0;
  manager.resolveSelection = () => ({ ready, install: ready ? install : null, version: "2.0.0" });
  manager.installRuntime = async () => { ready = true; installs++; return install; };
  const dependencies = { manager, withRuntimeUse: fakeUse, startSession: async () => fakeSession(root),
    localRequest: async (_session, endpoint, fields) => { if (endpoint === "/Export/PrimaryContent") fs.writeFileSync(path.join(fields.Path, "texture.png"), "asset"); } };
  context.confirmRuntimeInstall = async () => { prompts++; return true; };
  const result = await Assets.exportAssets(entry, {}, context, dependencies);
  assert.equal(prompts, 1); assert.equal(installs, 1); assert.equal(entry.moduleData.exportedAssetsRoot, result.outputRoot);
  assert.equal(fs.readFileSync(path.join(result.outputRoot, "texture.png"), "utf8"), "asset");
  await assert.rejects(Assets.exportAssets(entry, {}, context, { ...dependencies,
    localRequest: async (_session, endpoint) => { if (endpoint === "/Export/PrimaryContent") throw new Error("Export failed"); } }), /Export failed/);
  assert.equal(fs.readFileSync(path.join(result.outputRoot, "texture.png"), "utf8"), "asset");
  assert.deepEqual(fs.readdirSync(path.dirname(result.outputRoot)), ["assets"]);
  assert.equal(prompts, 1); assert.equal(installs, 1);
});

test("one inspector per game reopens the same local session and closes without deleting exports", async t => {
  const { root, entry, context, manager } = setup(t), session = fakeSession(root), urls = []; let spawns = 0;
  context.ui = { shell: { openExternal: async url => urls.push(url) } };
  const ownership = [];
  context.onToolProcessSpawn = async (child, options) => ownership.push({ pid: child.pid, ...options });
  const dependencies = { manager, withRuntimeUse: fakeUse, startSession: async (_install, _workspace, options) => {
    spawns++; await options.onSpawn(session.child); return session;
  }, localRequest: async () => {} };
  await Promise.all([Assets.openInspector(entry, {}, context, dependencies), Assets.openInspector(entry, {}, context, dependencies)]);
  assert.equal(spawns, 1); assert.deepEqual(urls, [session.url, session.url]); assert.equal(entry.moduleData.assetInspectorRunning, true);
  assert.deepEqual(ownership, [{ pid: session.child.pid, stopOnLauncherExit: true }]);
  const output = path.join(Assets.__test.rootFor(entry, context), "exports", "assets"); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "asset.txt"), "preserved");
  await Assets.closeInspector(entry, {}, context);
  assert.equal(entry.moduleData.assetInspectorRunning, false); assert.equal(session.isOpen(), false);
  assert.equal(fs.readFileSync(path.join(output, "asset.txt"), "utf8"), "preserved");
});

test("a running inspector keeps its managed version protected until the child closes", async t => {
  const { root, entry, context, manager, install } = setup(t), session = fakeSession(root);
  const coordinator = createRuntimeCoordinator({ isProcessAlive: () => true }), client = coordinator.client();
  t.after(() => client.close());
  let removed = false;
  manager.getState = () => ({ installed: [{ ...install, ready: !removed }], sections: [{ id: "default", installed: [{ ...install, ready: !removed }] }] });
  manager.uninstallRuntime = async () => { removed = true; };
  const dependencies = { manager, startSession: async (_install, _workspace, options) => {
    await options.onSpawn(session.child); return session;
  }, localRequest: async () => {}, withRuntimeUse: (identities, work, options) => withRuntimeUse(identities, work, { ...options, coordinator: client }) };
  await Assets.openInspector(entry, {}, context, dependencies);
  const uninstall = () => runRuntimeManagerAction({ manager, userDataDir: context.userDataDir, runtimeCoordinator: client,
    action: "uninstall", payload: { version: install.version, sectionId: "default" } });
  await assert.rejects(uninstall(), { code: "RUNTIME_IN_USE" });
  assert.equal(removed, false);
  await Assets.closeInspector(entry, {}, context);
  await new Promise(resolve => setImmediate(resolve));
  await uninstall(); assert.equal(removed, true);
});
