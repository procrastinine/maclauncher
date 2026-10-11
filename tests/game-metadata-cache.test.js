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
  const first = await f.service.refreshEntry(f.entry, f.settings);
  assert.deepEqual(f.counts, { detection: 1, save: 1, icon: 1 });
  const second = await f.service.refreshEntry(first, f.settings);
  const restarted = createGameMetadataService({ userDataDir: f.userDataDir, registry: f.registry });
  const third = await restarted.refreshEntry(second, f.settings);
  assert.equal(third.defaultSaveDir, path.join(f.userDataDir, "chapter-one"));
  assert.equal(third.moduleData.version, "1.0");
  assert.deepEqual(f.counts, { detection: 1, save: 1, icon: 1 });
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
