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
  assert.equal(request.managerId, "rlvm"); assert.equal(request.version, Catalog.VERSION); assert.equal(request.requiresDownload, true);
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
  assert.notEqual(siglus.defaultSaveDir, rlvm.defaultSaveDir);
  assert.equal(Store.readGameRecord(context.userDataDir, entry.gameId).defaultSaveDir, siglus.defaultSaveDir);
  assert(events.some(event => event.type === "entryChanged" && event.value.gameId === entry.gameId));
});
test("RLVM discovery retains older history without offering incompatible Mac downloads", async () => {
  const releases = ["0.14", "0.13.1"].map(version => ({ tag_name: `release-${version}`, assets: [{ name: `rlvm_${version}.dmg`, id: 258884,
    browser_download_url: `${Catalog.RELEASES}/download/release-${version}/rlvm_${version}.dmg`, digest: "sha256:" + "b".repeat(64) }] }));
  const dependencies = { fetchGithubReleases: async () => releases,
    fetchGithubTags: async () => releases.map(release => ({ name: release.tag_name, commit: { sha: "a".repeat(40) } })) };
  const entries = await Catalog.createDiscovery({ dependencies })({});
  assert.deepEqual(entries.map(entry => entry.version), ["0.14", "0.13.1"]);
  assert.equal(entries[0].asset.sha256, Catalog.ASSET.sha256);
  assert.equal(entries[0].asset.integritySource, "pinned-release-sha256");
  assert.equal(entries[1].asset, undefined);
  assert.match(entries[1].installReason, /0\.14 or later/);
  releases[0].assets[0].browser_download_url = "https://example.com/unrelated.dmg";
  await assert.rejects(Catalog.createDiscovery({ dependencies })({}), /unexpected source/);
});
test("RLVM manager stays offline and preserves explicit per-game version selection", () => {
  const manager = Manager.createManager({ dependencies: { github: { fetchGithubReleases: () => { throw Error("unexpected network"); } } } });
  assert.deepEqual(manager.getState({}).catalog.versions, []);
  assert.equal(manager.resolveSelection({}, {}, undefined).version, Catalog.VERSION);
  assert.equal(manager.resolveSelection({ runtimeData: { rlvm: { version: "0.15" } } }, {}, undefined).version, "0.15");
});
test("RLVM disk image extraction always detaches before removing the mount directory", async t => {
  const { root } = fixture(t), destination = path.join(root, "unpacked"), calls = [];
  fs.mkdirSync(destination);
  const archive=path.join(root,"runtime.dmg");fs.writeFileSync(archive,"sealed disk image");
  await Manager.extractDiskImage(archive, destination, undefined, async (_cmd, args) => {
    calls.push(args[0]);
    const mount = args[0] === "attach" ? args[4] : args[1];
    if (args[0] === "attach") { fs.mkdirSync(path.join(mount, "rlvm.app")); fs.writeFileSync(path.join(mount, "rlvm.app", "payload"), "original"); }
    else fs.rmSync(path.join(mount, "rlvm.app"), { recursive: true });
  });
  assert.deepEqual(calls, ["attach", "detach"]);
  assert.equal(fs.readFileSync(path.join(destination, "rlvm.app", "payload"), "utf8"), "original");
  assert(!fs.readdirSync(root).some(name => name.startsWith(".mount-")));
});

test("RLVM obtains the adapter from a selected managed package",()=>{assert.equal(Manager.adapterResource,undefined);});
