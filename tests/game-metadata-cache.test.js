const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGameMetadataService } = require("../src/core/game-metadata");
const GameStore = require("../src/core/game-store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "game"), userDataDir = path.join(root, "data");
  fs.mkdirSync(gamePath); fs.mkdirSync(path.join(gamePath, "scripts"));
  fs.writeFileSync(path.join(gamePath, "version.txt"), "1.0");
  fs.writeFileSync(path.join(gamePath, "scripts", "save.txt"), "chapter-one");
  const counts = { detection: 0, save: 0, icon: 0 };
  const info = { id: "fixture", label: "Fixture", runtime: { manager: { runner: "fixture-runtime" } } };
  const mod = { id: info.id, manifest: info,
    resolveGameIcon() { counts.icon++; return null; },
    resolveSaveLocations(entry) {
      counts.save++;
      const name = fs.readFileSync(path.join(gamePath, "scripts", "save.txt"), "utf8");
      entry.moduleData.saveName = name;
      return { primaryDirectory: path.join(userDataDir, name), directories: [] };
    }
  };
  const registry = {
    listModuleIds: () => [info.id], listModules: () => [info], getModuleInfo: () => info,
    getModule: () => mod, getModuleDir: () => path.join(root, "module"),
    async detectGameAsync() {
      counts.detection++;
      const version = fs.readFileSync(path.join(gamePath, "version.txt"), "utf8");
      const optional = fs.existsSync(path.join(gamePath, "optional.txt"));
      return { gamePath, contentRootDir: gamePath, moduleId: info.id, name: "Fixture",
        moduleData: { version, optional } };
    }
  };
  const entry = { gameId: "fixture", gamePath, importPath: gamePath, contentRootDir: gamePath,
    moduleId: info.id, runtimeId: "runner", moduleData: {}, runtimeData: {}, notes: "Keep me" };
  const settings = { modules: { fixture: {} }, runtimes: { "fixture-runtime": { defaultVersion: "1" } } };
  const service = createGameMetadataService({ userDataDir, registry });
  return { root, gamePath, userDataDir, counts, entry, settings, service, registry };
}

test("unchanged games reuse detection, icon and save facts across service restarts", async t => {
  const f = fixture(t);
  f.registry.getModule().resolveGameIcon = (_entry, context) => {
    assert.equal(context.settings, f.settings, "Icon readers receive the same runtime selection as metadata");
    f.counts.icon++; return null;
  };
  const first = await f.service.refreshEntry(f.entry, f.settings);
  assert.deepEqual(f.counts, { detection: 1, save: 1, icon: 1 });
  const second = await f.service.refreshEntry(first, f.settings);
  const restarted = createGameMetadataService({ userDataDir: f.userDataDir, registry: f.registry });
  const third = await restarted.refreshEntry(second, f.settings);
  assert.equal(third.defaultSaveDir, path.join(f.userDataDir, "chapter-one"));
  assert.equal(third.moduleData.version, "1.0");
  assert.deepEqual(f.counts, { detection: 1, save: 1, icon: 1 });
});

test("module package metadata is asynchronous, cached and preserves later title edits", async t => {
  const f = fixture(t), mod = f.registry.getModule(); let reads = 0;
  mod.resolveGameMetadata = async entry => { reads++; return { name: "Localized Game", moduleData: { ...entry.moduleData, resolvedLabel: "Localized Game" } }; };
  mod.mergeEntry = (existing, incoming) => existing?.name && !["Fixture", existing.moduleData?.resolvedLabel].includes(existing.name) ? { ...incoming, name: existing.name } : incoming;
  const first = await f.service.refreshEntry(f.entry, f.settings);
  assert.equal(first.name, "Localized Game");
  const second = await f.service.refreshEntry({ ...first, name: "Custom title" }, f.settings);
  assert.equal(second.name, "Custom title"); assert.equal(reads, 1);
  const refreshed = await f.service.refreshEntry(second, f.settings, { force: true });
  assert.equal(refreshed.name, "Custom title"); assert.equal(reads, 2);
});

test("optional metadata and icon failures survive failing debug observers", async t => {
  for (const asynchronous of [false, true]) await t.test(asynchronous ? "rejected observer" : "throwing observer", async t => {
    const f = fixture(t), mod = f.registry.getModule(); let notifications = 0;
    mod.resolveGameMetadata = async () => { throw new Error("Unavailable package metadata"); };
    mod.resolveGameIcon = async () => { throw new Error("Unavailable package artwork"); };
    const service = createGameMetadataService({ userDataDir: f.userDataDir, registry: f.registry, logger: {
      debug() { notifications++; const error = new Error("Unavailable debug observer"); if (asynchronous) return Promise.reject(error); throw error; }
    } });
    const resolved = await service.refreshEntry(f.entry, f.settings);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resolved.name, "Fixture"); assert.equal(resolved.iconPath, null);
    assert.equal(resolved.defaultSaveDir, path.join(f.userDataDir, "chapter-one"));
    assert.equal(notifications, 2);
  });
});

test("optional metadata cache write failures preserve facts while game record failures remain visible", async t => {
  const f = fixture(t), rename = fs.renameSync; let failureCode = "EACCES", failedCacheWrites = 0, recordFailure = false;
  const recordPath = GameStore.writeGameRecord(f.userDataDir, f.entry);
  t.mock.method(fs, "renameSync", function (source, target) {
    if (recordFailure && target === recordPath) throw Object.assign(new Error("Game record unavailable"), { code: "EACCES" });
    if (!recordFailure && path.basename(target) === "metadata.json") { failedCacheWrites++; throw Object.assign(new Error("Cache unavailable"), { code: failureCode }); }
    return Reflect.apply(rename, this, [source, target]);
  });
  const service = createGameMetadataService({ userDataDir: f.userDataDir, registry: f.registry, logger: { debug() { throw new Error("Observer unavailable"); } } });
  for (const code of ["EACCES", "ENOSPC"]) {
    failureCode = code;
    const resolved = await service.refreshEntry(f.entry, f.settings);
    assert.equal(resolved.name, "Fixture"); assert.equal(resolved.moduleData.version, "1.0");
    assert.equal(GameStore.readGameRecord(f.userDataDir, f.entry.gameId).name, "Fixture");
  }
  assert.equal(failedCacheWrites, 2);
  recordFailure = true;
  fs.writeFileSync(path.join(f.gamePath, "version.txt"), "2.0");
  await assert.rejects(service.refreshEntry(f.entry, f.settings), { code: "EACCES", message: "Game record unavailable" });
});

test("metadata cancellation propagates before optional error observers or cache publication", async t => {
  for (const hook of ["resolveGameMetadata", "resolveGameIcon"]) await t.test(hook, async t => {
    const f = fixture(t), controller = new AbortController(); let notifications = 0;
    f.registry.getModule()[hook] = async () => { controller.abort(); throw new Error("Interrupted optional lookup"); };
    const service = createGameMetadataService({ userDataDir: f.userDataDir, registry: f.registry, logger: { debug() { notifications++; } } });
    await assert.rejects(service.refreshEntry(f.entry, f.settings, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(notifications, 0);
    assert.equal(fs.existsSync(path.join(f.userDataDir, "games", f.entry.gameId, "metadata.json")), false);
  });
});

test("shared metadata preserves edited titles and artwork for modules without merge hooks", async t => {
  const f = fixture(t), mod = f.registry.getModule(), Images = require("../src/core/icon-utils");
  const moduleIcon = path.join(f.gamePath, "module.png"), customIcon = path.join(f.root, "custom.png");
  fs.writeFileSync(moduleIcon, Images.encodePngBitmap({ width: 1, height: 1, buffer: Buffer.from([1, 2, 3, 255]) }));
  fs.copyFileSync(moduleIcon, customIcon); mod.resolveGameIcon = () => moduleIcon;
  const first = await f.service.refreshEntry(f.entry, f.settings);
  const edited = { ...first, name: "Edited title", iconPath: customIcon, iconSource: "custom" };
  const changed = await f.service.refreshEntry(edited, f.settings);
  assert.equal(changed.name, "Edited title"); assert.equal(changed.iconPath, customIcon); assert.equal(changed.iconSource, "custom");
  const warm = await f.service.refreshEntry(changed, f.settings);
  assert.equal(warm.name, "Edited title"); assert.equal(warm.iconPath, customIcon);
  const forced = await f.service.refreshEntry(warm, f.settings, { force: true });
  assert.equal(forced.name, "Edited title"); assert.equal(forced.iconPath, customIcon);
});

test("an app upgrade refreshes cached facts once while unchanged versions stay warm", async t => {
  const f = fixture(t);
  const firstService = createGameMetadataService({ userDataDir: f.userDataDir, registry: f.registry, app: { getVersion: () => "1.0.0" } });
  const first = await firstService.refreshEntry(f.entry, f.settings);
  await firstService.refreshEntry(first, f.settings);
  assert.deepEqual(f.counts, { detection: 1, save: 1, icon: 1 });
  const upgraded = createGameMetadataService({ userDataDir: f.userDataDir, registry: f.registry, app: { getVersion: () => "1.1.0" } });
  const next = await upgraded.refreshEntry(first, f.settings);
  await upgraded.refreshEntry(next, f.settings);
  assert.deepEqual(f.counts, { detection: 2, save: 2, icon: 2 });
});

test("declared helper source changes invalidate facts while unchanged restarts reopen no game assets", async t => {
  const f = fixture(t), moduleDir = f.registry.getModuleDir(), helper = path.join(moduleDir, "metadata.js");
  fs.mkdirSync(moduleDir); fs.writeFileSync(helper, "one");
  const timestamp = new Date("2020-01-01T00:00:00.000Z"); fs.utimesSync(helper, timestamp, timestamp);
  const mod = f.registry.getModule(); mod.metadataSources = ["metadata.js"];
  mod.resolveGameMetadata = () => ({ name: fs.readFileSync(helper, "utf8") });
  const create = () => createGameMetadataService({ userDataDir: f.userDataDir, registry: f.registry, app: { getVersion: () => "1.0.0" } });
  const first = await create().refreshEntry(f.entry, f.settings);
  assert.equal(first.name, "one");
  const readFile = fs.readFileSync; let assetReads = 0;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (typeof file === "string" && file.startsWith(f.gamePath + path.sep)) assetReads++;
    return Reflect.apply(readFile, this, [file, ...args]);
  });
  const warm = await create().refreshEntry(first, f.settings);
  assert.equal(warm.name, "one"); assert.equal(assetReads, 0);
  assert.deepEqual(f.counts, { detection: 1, save: 1, icon: 1 });
  const before = fs.statSync(helper), replacement = helper + ".replacement";
  fs.writeFileSync(replacement, "two"); fs.utimesSync(replacement, before.atime, before.mtime); fs.renameSync(replacement, helper);
  assert.equal(fs.statSync(helper).size, before.size);
  assert.equal(fs.statSync(helper).mtimeMs, before.mtimeMs);
  assert.notEqual(fs.statSync(helper).ino, before.ino);
  const changed = await create().refreshEntry(warm, f.settings);
  assert.equal(changed.name, "two"); assert.ok(assetReads > 0);
  assert.deepEqual(f.counts, { detection: 2, save: 2, icon: 2 });
  assetReads = 0;
  assert.equal((await create().refreshEntry(changed, f.settings)).name, "two");
  assert.equal(assetReads, 0); assert.deepEqual(f.counts, { detection: 2, save: 2, icon: 2 });
});

test("in-place source changes invalidate cached facts even when mtime is restored", async t => {
  const f = fixture(t), first = await f.service.refreshEntry(f.entry, f.settings);
  const source = path.join(f.gamePath, "version.txt"), before = fs.statSync(source);
  fs.writeFileSync(source, "2.0"); fs.utimesSync(source, before.atime, before.mtime);
  const refreshed = await f.service.refreshEntry(first, f.settings);
  assert.equal(refreshed.moduleData.version, "2.0"); assert.equal(f.counts.detection, 2);
});

test("negative and nested module-owned reads participate in invalidation", async t => {
  const f = fixture(t), first = await f.service.refreshEntry(f.entry, f.settings);
  fs.writeFileSync(path.join(f.gamePath, "optional.txt"), "present");
  fs.writeFileSync(path.join(f.gamePath, "scripts", "save.txt"), "chapter-two");
  const refreshed = await f.service.refreshEntry(first, f.settings);
  assert.equal(refreshed.moduleData.optional, true);
  assert.equal(refreshed.defaultSaveDir, path.join(f.userDataDir, "chapter-two"));
  assert.equal(f.counts.detection, 2);
});

test("notes and unrelated runtime preferences do not invalidate game analysis", async t => {
  const f = fixture(t), first = await f.service.refreshEntry(f.entry, f.settings);
  const next = await f.service.refreshEntry({ ...first, notes: "Edited" }, {
    ...f.settings, runtimes: { ...f.settings.runtimes, unrelated: { defaultVersion: "99" } }
  });
  assert.equal(next.notes, "Edited"); assert.equal(f.counts.detection, 1);
  await f.service.refreshEntry({ ...next, moduleData: { ...next.moduleData, lastRuntimeVersion: "1.0", lastLaunchAt: Date.now() } }, f.settings);
  assert.equal(f.counts.detection, 1, "launch bookkeeping must not trigger a new source scan");
  await f.service.refreshEntry(next, f.settings, { force: true });
  assert.equal(f.counts.detection, 2);
});

test("first import detects once and retains a canonical existing library record", async t => {
  const f = fixture(t);
  GameStore.writeGameRecord(f.userDataDir, f.entry);
  const executable = path.join(f.gamePath, "game.exe"); fs.writeFileSync(executable, "fixture");
  const imported = await f.service.importEntry(executable, f.settings);
  assert.equal(imported.gameId, f.entry.gameId); assert.equal(imported.notes, "Keep me");
  assert.equal(f.counts.detection, 1);
  assert.equal(GameStore.loadGames(f.userDataDir).length, 1);
});

test("metadata analysis preserves notes edited while a probe is pending", async t => {
  const f = fixture(t);
  GameStore.writeGameRecord(f.userDataDir, f.entry);
  const original = f.registry.detectGameAsync;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.registry.detectGameAsync = async () => { entered(); await gate; return original(); };
  const pending = f.service.refreshEntry(f.entry, f.settings);
  await started;
  GameStore.setGameNotes(f.userDataDir, f.entry.gameId, "Edited while checking"); release();
  await pending;
  assert.equal(GameStore.readGameRecord(f.userDataDir, f.entry.gameId).notes, "Edited while checking");
});

test("metadata uses asynchronous icon extraction and cancellation does not cache a missing icon", async t => {
  const f = fixture(t), controller = new AbortController();
  const executable = path.join(f.gamePath, "Game.exe"); fs.writeFileSync(executable, "original");
  const png = require("../src/core/icon-utils").encodePngBitmap({ width: 1, height: 1, buffer: Buffer.from([1, 2, 3, 255]) });
  let calls = 0, started;
  const entered = new Promise(resolve => { started = resolve; });
  const service = createGameMetadataService({ userDataDir: f.userDataDir, registry: f.registry,
    extractIcon: async (file, source, { signal }) => {
      assert.equal(file, executable); assert.equal(source, "exe"); calls++;
      if (calls === 1) {
        assert.equal(signal, controller.signal); started();
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      }
      return { png };
    } });
  const pending = service.refreshEntry(f.entry, f.settings, { signal: controller.signal });
  await entered;
  let responsive = false;
  await new Promise(resolve => setImmediate(() => { responsive = true; controller.abort(); resolve(); }));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(responsive, true);
  const first = await service.refreshEntry(f.entry, f.settings);
  assert.equal(first.iconSource, "exe"); assert.deepEqual(fs.readFileSync(first.iconPath), png);
  await service.refreshEntry(first, f.settings);
  assert.equal(calls, 2, "Retry extracts the cancelled icon once and then reuses it");
  assert.equal(fs.readFileSync(executable, "utf8"), "original");
});

test("metadata waits for asynchronous module icon discovery", async t => {
  const f = fixture(t), icon = path.join(f.gamePath, "artwork.png");
  const png = require("../src/core/icon-utils").encodePngBitmap({ width: 1, height: 1, buffer: Buffer.from([1, 2, 3, 255]) });
  fs.writeFileSync(icon, png);
  f.registry.getModule().resolveGameIcon = async () => { await new Promise(resolve => setImmediate(resolve)); return icon; };
  const result = await f.service.refreshEntry(f.entry, f.settings);
  assert.equal(result.iconPath, icon); assert.equal(result.iconSource, "module");
});

test("APK imports resolve uncached resources without Android or Java and reuse them after restart", { skip: process.platform !== "darwin" }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-apk-import-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "input"), userDataDir = path.join(root, "data");
  fs.mkdirSync(input); fs.mkdirSync(userDataDir);
  const apk = path.join(input, "metadata.apk");
  fs.copyFileSync(path.join(__dirname, "fixtures/android-package-metadata/metadata.apk"), apk);
  const Runtime = require("../src/modules/android/runtime");
  const Java = require("../src/modules/java/runtime/java-runtime");
  const Reader = require("../src/modules/android/tools/apk-metadata");
  const registry = require("../src/modules/registry");
  const forbidden = () => assert.fail("APK import cannot discover, install or select a game runtime");
  for (const name of ["resolveSelected", "resolveForLaunch", "resolveSelectedForLaunch"])
    t.mock.method(Runtime, name, forbidden);
  for (const name of ["listInstalled", "resolveBestInstalled", "installVersion", "fetchAvailableVersionsForLine"])
    t.mock.method(Java, name, forbidden);
  t.mock.method(global, "fetch", () => assert.fail("APK import cannot access the network"));
  for (const module of [require("node:http"), require("node:https")])
    for (const name of ["request", "get"]) t.mock.method(module, name, () => assert.fail("APK import cannot access the network"));
  const original = Reader.inspect;
  let reads = 0;
  t.mock.method(Reader, "inspect", options => { reads++; return original(options); });
  const settings = { modules: { android: {} }, runtimes: {} };
  const options = { userDataDir, registry, app: { getLocale: () => "en-US" } };
  const imported = await createGameMetadataService(options).importEntry(apk, settings);
  assert.equal(imported.moduleId, "android");
  assert.equal(imported.name, "Metadata Game");
  assert.equal(imported.moduleData.packageName, "org.maclauncher.metadata.fixture");
  assert.equal(imported.iconSource, "module");
  const image = fs.readFileSync(imported.iconPath);
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(image.readUInt32BE(16), 256); assert.equal(image.readUInt32BE(20), 256);
  const facts = JSON.parse(fs.readFileSync(path.join(path.dirname(imported.iconPath), "android.json")));
  assert.deepEqual(facts.activityWindows, { "org.maclauncher.metadata.fixture.Main": { landscape: null } });
  assert.equal(reads, 1, "Metadata and icon selection share the real included helper result");
  GameStore.writeGameRecord(userDataDir, imported);
  const before = fs.statSync(imported.iconPath);
  const warm = await createGameMetadataService(options).importEntry(apk, settings);
  assert.equal(warm.gameId, imported.gameId);
  assert.equal(warm.name, imported.name);
  assert.equal(warm.iconPath, imported.iconPath);
  assert.equal(fs.statSync(warm.iconPath).ino, before.ino);
  assert.equal(reads, 1, "A fresh service reuses the persisted package facts and artwork");
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
});

test("cleaned automatic window titles remain editable across warm and forced metadata refresh", async t => {
  const f = fixture(t), mod = f.registry.getModule();
  mod.resolveGameMetadata = () => ({ name: "Garden Story (F1: Settings, F12: Reset)" });
  const first = await f.service.refreshEntry(f.entry, f.settings);
  assert.equal(first.name, "Garden Story");
  const edited = { ...first, name: "My garden" };
  assert.equal((await f.service.refreshEntry(edited, f.settings)).name, "My garden");
  assert.equal((await f.service.refreshEntry(edited, f.settings, { force: true })).name, "My garden");
});
