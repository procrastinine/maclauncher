// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("../src/modules/siglus/main");
const Detect = require("../src/modules/siglus/detect");
const RLVM = require("../src/modules/siglus/rlvm-launch");
const Catalog = require("../src/modules/siglus/runtime/rlvm-catalog");
const Manager = require("../src/modules/siglus/runtime/rlvm-manager");
const { stoppedDownloads, assertConsentedDiscovery, assertReceiptOffline } = require("./helpers/catalog-only-runtime.cjs");

function fixture(t, { folder = "", registry = "Publisher\\Story", compiler = 10002 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-rlvm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "game"), data = path.join(game, folder);
  fs.mkdirSync(data, { recursive: true });
  const scene = Buffer.alloc(480); scene.writeUInt32LE(464); scene.writeUInt32LE(compiler, 4);
  scene.writeUInt32LE(464, 8); scene.writeUInt32LE(464, 0x20); scene.writeUInt32LE(16, 0x24); scene.writeUInt32LE(16, 0x28);
  const archive = Buffer.alloc(80000 + scene.length); archive.writeUInt32LE(80000); archive.writeUInt32LE(scene.length, 4); scene.copy(archive, 80000);
  fs.writeFileSync(path.join(data, "SeEn.TxT"), archive);
  fs.writeFileSync(path.join(game, "Gameexe.ini"), `#REGNAME="${registry}"\n#FOLDNAME.TXT="${folder}"=0:"SEEN.TXT"\n`);
  fs.writeFileSync(path.join(game, "siglusengine.exe"), "original Windows runner");
  fs.writeFileSync(path.join(game, "msgothic.ttc"), "game font");
  const entry = { gameId: "story", gamePath: game, runtimeId: "rlvm", moduleData: Detect.inspectGame(game) };
  return { root, game, entry, context: { userDataDir: path.join(root, "data"), settings: {}, runtimeId: "rlvm" } };
}
test("RLVM is a RealLive archive alternative and preserves the existing default", t => {
  const { entry, context } = fixture(t), supported = Module.manifest.runtime.supported;
  assert.equal(Module.manifest.runtime.default, "siglus");
  assert.equal(Module.normalizeRuntimeId("RLVM"), "rlvm");
  assert.deepEqual(Module.filterRuntimeSupport(entry, supported), ["siglus", "rlvm"]);
  for (const data of [{ engineKind: "siglus" }, { engineKind: "avg32" }, { engineKind: "reallive", format: "RealLive loose scenario" }])
    assert.deepEqual(Module.filterRuntimeSupport({ moduleData: data }, supported), ["siglus"]);
  const request = Module.ensureRuntime(entry, context);
  assert.equal(request.managerId, "rlvm"); assert.equal(request.version, null); assert.equal(request.discoveryRequired, true);
  assert.equal(request.requiresDownload, true);
  assert.equal(Module.ensureRuntime(entry, { ...context, runtimeId: "siglus" }).managerId, "siglus");
});
test("RLVM preserves original assets and routes per-game saves separately from siglus_rs", t => {
  const { game, entry, context } = fixture(t, { folder: "ScN" });
  const originalIni = fs.readFileSync(path.join(game, "Gameexe.ini"));
  const prepared = RLVM.prepareLaunch(entry, context, { adapterPath: "/runtime/rlvm-adapter.dylib" });
  assert.deepEqual(prepared.args, []);
  assert.equal(prepared.env.MACLAUNCHER_RLVM_GAME, prepared.root);
  assert.equal(prepared.env.DYLD_INSERT_LIBRARIES, "/runtime/rlvm-adapter.dylib");
  assert.equal(fs.existsSync(path.join(prepared.root, "siglusengine.exe")), false);
  assert.equal(fs.readlinkSync(path.join(prepared.root, "Seen.txt")), fs.realpathSync(path.join(game, "ScN", "SeEn.TxT")));
  assert.equal(fs.readlinkSync(path.join(prepared.root, "Gameexe.ini")), fs.realpathSync(path.join(game, "Gameexe.ini")));
  assert.equal(fs.realpathSync(path.join(prepared.env.HOME, ".rlvm")), fs.realpathSync(prepared.saves));
  fs.mkdirSync(path.join(prepared.saves, "Publisher_Story"));
  fs.writeFileSync(path.join(prepared.saves, "Publisher_Story", "save000.sav"), "slot");
  assert.deepEqual(fs.readFileSync(path.join(game, "Gameexe.ini")), originalIni);
  assert.equal(fs.existsSync(path.join(game, ".rlvm")), false);
  assert.equal(Module.resolveSaveLocations(entry, context).primaryDirectory, prepared.saves);
  assert.notEqual(Module.resolveSaveLocations(entry, { ...context, runtimeId: "siglus" }).primaryDirectory, prepared.saves);
  const again = RLVM.prepareLaunch(entry, context, { adapterPath: "/runtime/rlvm-adapter.dylib" });
  assert.equal(fs.readFileSync(path.join(again.saves, "Publisher_Story", "save000.sav"), "utf8"), "slot");
});
test("RLVM honors save overrides without replacing files or accepting registry traversal", t => {
  const { root, entry, context } = fixture(t);
  entry.saveDirOverride = path.join(root, "custom-saves");
  const prepared = RLVM.prepareLaunch(entry, context, { adapterPath: "/adapter" });
  assert.equal(prepared.saves, entry.saveDirOverride);
  fs.unlinkSync(path.join(prepared.env.HOME, ".rlvm")); fs.writeFileSync(path.join(prepared.env.HOME, ".rlvm"), "keep");
  assert.throws(() => RLVM.prepareLaunch(entry, context, { adapterPath: "/adapter" }), /conflicts/);
  assert.equal(fs.readFileSync(path.join(prepared.env.HOME, ".rlvm"), "utf8"), "keep");
  for (const registry of ["../escape", "/outside", "..", "", 'ok"\n#REGNAME="../bad']) {
    const input = fixture(t, { registry });
    assert.throws(() => RLVM.inspectEntry(input.entry), /REGNAME/);
  }
  assert.throws(() => RLVM.inspectEntry(fixture(t, { compiler: 120002 }).entry), /120002.*compatible/);
});
test("runtime switching refreshes the persisted save folder before another launch", async t => {
  const { entry, context } = fixture(t);
  const Store = require("../src/core/game-store");
  const events = [];
  const operations = require("../src/core/backend-operations").createBackendOperations({
    userDataDir: context.userDataDir, emit: (type, value) => events.push({ type, value })
  });
  entry.moduleId = "siglus";
  Store.writeGameRecord(context.userDataDir, entry);
  const rlvm = await operations.refreshSaveLocations(entry, {});
  assert.match(rlvm.defaultSaveDir, /rlvm[\\/]saves$/);
  Store.writeGameRecord(context.userDataDir, { ...rlvm, runtimeId: "siglus" });
  const siglus = await operations.refreshSaveLocations(rlvm, {});
  assert.equal(siglus.runtimeId, "siglus", "selection comes from the current stored record");
  assert.equal(siglus.defaultSaveDir, path.join(entry.gamePath, "savedata_rs"));
  assert.notEqual(siglus.defaultSaveDir, rlvm.defaultSaveDir);
  assert.equal(Store.readGameRecord(context.userDataDir, entry.gameId).defaultSaveDir, siglus.defaultSaveDir);
  assert(events.some(event => event.type === "entryChanged" && event.value.gameId === entry.gameId));
});
const repository = "eglaysher/rlvm", releasesUrl = `https://api.github.com/repos/${repository}/releases`;
const rlvmRelease = (version, names = [`rlvm_${version}.dmg`]) => Harness.githubRelease(repository, `release-${version}`, names);
async function discoverRlvm(releases) {
  Harness.network.routes = Harness.githubRoutes(repository, releases);
  try { return await Catalog.source.discover({}); } finally { Harness.network.routes = null; }
}
test("RLVM discovery retains older history without offering incompatible Mac downloads", async () => {
  const releases = ["0.15", "0.14", "0.13.1"].map(version => rlvmRelease(version));
  delete releases[1].assets[0].digest;
  const entries = await discoverRlvm(releases);
  assert.deepEqual(entries.map(entry => entry.version), ["0.15", "0.14", "0.13.1"]);
  assert.equal(entries[0].files[0].digest.value, releases[0].assets[0].digest.slice(7), "A publisher digest verifies a newer release");
  assert.equal(entries[1].files[0].digest, undefined, "A release without a published digest records its own at installation");
  assert.deepEqual(entries[2].files, []);
  assert.match(entries[2].installReason, /0\.14 or later/);
  releases[0] = rlvmRelease("0.15", ["rlvm-0.15-macos-universal.zip", "rlvm-0.15-linux-x86_64.tar.gz"]);
  const renamed = (await discoverRlvm(releases))[0];
  assert.deepEqual(renamed.files.map(file => file.name), ["rlvm-0.15-macos-universal.zip"], "A renamed Mac archive is followed");
});
test("RLVM manager stays offline and preserves explicit per-game version selection", () => {
  const manager = Manager.createManager(), before = Harness.network.requests.length;
  assert.deepEqual(manager.getState({}).catalog.versions, []);
  const automatic = manager.resolveSelection({}, {}, undefined);
  assert.equal(automatic.version, null); assert.equal(automatic.discoveryRequired, true);
  assert.equal(manager.resolveSelection({ runtimeData: { rlvm: { version: "0.15" } } }, {}, undefined).version, "0.15");
  assert.equal(Harness.network.requests.length, before);
});
test("RLVM discovers inside a consented install and keeps earlier installations offline", { skip: process.platform !== "darwin" }, async t => {
  const { root } = fixture(t), downloads = stoppedDownloads(), releases = ["0.15", "0.14"].map(version => rlvmRelease(version));
  const requests = () => Harness.network.requests.filter(url => url.startsWith(releasesUrl)).length, start = requests();
  const manager = Manager.createManager({ dependencies: { downloadToFile: downloads.downloadToFile } });
  Harness.network.routes = Harness.githubRoutes(repository, releases);
  t.after(() => { Harness.network.routes = null; });
  await assertConsentedDiscovery({ manager, userDataDir: path.join(root, "consent"), discoveries: () => requests() - start, downloads,
    newestUrl: releases[0].assets[0].browser_download_url });
  Harness.network.routes = null;
  assertReceiptOffline({ manager: Manager.createManager(),
    userDataDir: path.join(root, "offline"), pin: { version: "0.14", upstreamRevision: "a85b19c2bce61f9b1328220148aeb13b62929eea", upstreamTag: "release-0.14",
      minimumMacOS: "13.0", asset: { filename: "rlvm_0.14.dmg", assetId: 258884, size: 2024263, url: `${Catalog.RELEASES}/download/release-0.14/rlvm_0.14.dmg`,
        sha256: "b6e206bb35a0824a60588e461d6c9334556f11ebff00eda89ed36228c925e8b4" } } });
});
test("RLVM disk images install the volume's files, wherever the app sits, and always detach", async t => {
  const { root } = fixture(t), destination = path.join(root, "unpacked"), calls = [];
  fs.mkdirSync(destination);
  const archive=path.join(root,"runtime.dmg");fs.writeFileSync(archive,"sealed disk image");
  let mount;
  await require("../src/modules/shared/runtime/dmg").extractDmg(archive, destination, undefined, { run: async (command, args) => {
    calls.push(path.basename(command) === "ditto" ? "copy" : `${path.basename(command)} ${args.includes("attach") ? "attach" : args[0]}`);
    if (args.includes("attach")) {
      mount = args[args.indexOf("--mountPoint") + 1];
      fs.mkdirSync(path.join(mount, "RLVM 0.15", "rlvm.app", "Contents", "MacOS"), { recursive: true });
      fs.writeFileSync(path.join(mount, "RLVM 0.15", "rlvm.app", "Contents", "MacOS", "rlvm"), "original");
      fs.symlinkSync("/Applications", path.join(mount, "Applications")); fs.writeFileSync(path.join(mount, ".DS_Store"), "layout");
    } else if (args[0] === "eject") fs.rmSync(path.join(mount, "RLVM 0.15"), { recursive: true });
    else fs.cpSync(args[0], args[1], { recursive: true });
  } });
  assert.deepEqual(calls, ["diskutil attach", "copy", "diskutil eject"]);
  assert.deepEqual(fs.readdirSync(destination), ["RLVM 0.15"]);
  assert.equal(fs.readFileSync(Manager.executable(destination), "utf8"), "original");
  assert.equal(fs.existsSync(mount), false);
});

test("RLVM obtains the adapter from a selected managed package",()=>{assert.equal(Manager.adapterResource,undefined);});
