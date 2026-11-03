const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const GameStore = require("../src/core/game-store");
const { runDataMigrations, ORIGINAL_GAME_MIRRORS_MIGRATION: KEY } = require("../src/core/backcompat/data-migrations");

test("failed released save routes persist once as safe ordinary settings without replacing authored or successful choices", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "retained-save-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let serial = 0;
  async function run(options = {}) {
    const folder = path.join(root, String(++serial)), userDataDir = path.join(folder, "profile"), original = path.join(folder, "game");
    const gameId = "owned", gameRoot = path.join(userDataDir, "games", gameId), saves = path.join(gameRoot, "modules/fixture/saves");
    fs.mkdirSync(saves, { recursive: true }); fs.mkdirSync(original);
    fs.writeFileSync(path.join(saves, "slot"), "released progress");
    const baseline = { schemaVersion: GameStore.CURRENT_RECORD_SCHEMA_VERSION, gameId, moduleId: "fixture", gamePath: original,
      contentRootDir: original, defaultSaveDir: saves, launchArguments: "--fullscreen", notes: "Keep notes", saveDirOverride: null,
      runtimeData: { runner: { version: "chosen", keep: true } }, ...options.baseline };
    GameStore.writeGameRecord(userDataDir, baseline);
    let directory = saves;
    if (options.unsafe === "game") directory = gameRoot;
    if (options.unsafe === "outside") directory = original;
    if (options.unsafe === "profile") directory = userDataDir;
    if (options.unsafe === "alias") {
      directory = path.join(saves, "alias"); fs.symlinkSync(original, directory);
    }
    const patch = options.patch ? options.patch(directory) : { saveDirOverride: directory };
    const fact = { directory, entryPatch: patch, proven: options.proven !== false, explicit: options.explicit === true };
    let reads = 0, writes = 0, checkpoints = 0;
    const module = { legacyGameMirrors(working) {
      reads++;
      if (options.generated) working.saveDirOverride = path.join(folder, "generated-collision");
      const descriptor = { mirrorRoot: saves, sourceRoot: options.success ? original : null, releasedSaveRoute: fact };
      const descriptors = [descriptor];
      if (options.duplicate) descriptors.push({ ...descriptor, releasedSaveRoute: structuredClone(fact) });
      if (options.conflict) descriptors.push({ ...descriptor, releasedSaveRoute: { ...fact, explicit: true } });
      if (options.successfulPatch) {
        const other = path.join(gameRoot, "modules/fixture/other"); fs.mkdirSync(other);
        descriptors.push({ mirrorRoot: other, sourceRoot: original, entryPatch: { saveDirOverride: options.successfulPatch } });
      }
      return descriptors;
    } };
    if (options.postHookPatch) module.migrateLegacyGameData = () => ({ complete: true, entryPatch: options.postHookPatch });
    const entry = structuredClone(baseline);
    const result = await runDataMigrations({ settings: {}, games: [entry], userDataDir, registry: { getModule: () => module },
      saveSettings: () => { checkpoints++; }, saveEntry: value => { writes++; GameStore.writeGameRecord(userDataDir, value); } });
    const persisted = GameStore.readGameRecord(userDataDir, gameId);
    assert.equal(writes, 1); assert.equal(checkpoints, 3, "the existing per-game checkpoint schedule stays unchanged");
    assert.equal(persisted.gameId, baseline.gameId); assert.equal(persisted.gamePath, baseline.gamePath);
    assert.equal(persisted.notes, baseline.notes); assert.equal(persisted.runtimeData.runner.version, "chosen");
    assert.equal(persisted.runtimeData.runner.keep, true);
    assert.equal(result.settings.dataMigrations[KEY].complete, true);
    if (!options.success) {
      assert.deepEqual(result.pendingIds, [gameId]); assert.ok(result.retained.length);
      assert.equal(fs.readFileSync(path.join(saves, "slot"), "utf8"), "released progress");
    }
    const probe = t.mock.method(fs, "lstatSync", () => assert.fail("completed migration must perform no obsolete path probes"));
    try {
      await runDataMigrations({ settings: result.settings, games: [entry], userDataDir,
        registry: { getModule: () => assert.fail("completed migration must not call module hooks") },
        saveSettings: () => assert.fail("completed migration must not checkpoint"), saveEntry: () => assert.fail("completed migration must not rewrite entries") });
    } finally { probe.mock.restore(); }
    assert.equal(reads, 1);
    return { persisted, saves, result };
  }

  const pending = await run(); assert.equal(pending.persisted.saveDirOverride, pending.saves);
  const generated = await run({ generated: true }); assert.equal(generated.persisted.saveDirOverride, generated.saves, "failed-recovery generated choices cannot hide the proven released route");
  const duplicate = await run({ duplicate: true }); assert.equal(duplicate.persisted.saveDirOverride, duplicate.saves);
  const authored = path.join(root, "authored");
  assert.equal((await run({ baseline: { saveDirOverride: authored } })).persisted.saveDirOverride, authored);
  assert.equal((await run({ explicit: true })).persisted.saveDirOverride, null);
  assert.equal((await run({ proven: false })).persisted.saveDirOverride, null);
  for (const unsafe of ["game", "profile", "outside", "alias"])
    assert.equal((await run({ unsafe })).persisted.saveDirOverride, null, unsafe);
  assert.equal((await run({ conflict: true })).persisted.saveDirOverride, null);
  assert.equal((await run({ successfulPatch: authored })).persisted.saveDirOverride, authored, "successful recovery setting patches take precedence");
  assert.equal((await run({ postHookPatch: { saveDirOverride: authored } })).persisted.saveDirOverride, authored, "successful post-recovery setting patches take precedence");
  const success = await run({ success: true }); assert.deepEqual(success.result.pendingIds, []);
  assert.equal(success.persisted.saveDirOverride, null, "a retired save root gets no fallback");
  const nested = await run({ patch: directory => ({ runtimeData: { runner: { saveDirOverride: directory } } }) });
  assert.equal(nested.persisted.runtimeData.runner.saveDirOverride, nested.saves);
  const nestedPostHook = await run({ patch: directory => ({ runtimeData: { runner: { saveDirOverride: directory } } }),
    postHookPatch: { runtimeData: { runner: { saveDirOverride: authored } } } });
  assert.equal(nestedPostHook.persisted.runtimeData.runner.saveDirOverride, authored, "successful nested post-recovery settings take precedence");
  const nestedAuthored = await run({ baseline: { runtimeData: { runner: { version: "chosen", keep: true, saveDirOverride: authored } } },
    patch: directory => ({ runtimeData: { runner: { saveDirOverride: directory } } }) });
  assert.equal(nestedAuthored.persisted.runtimeData.runner.saveDirOverride, authored);
  const invalid = await run({ patch: directory => ({ gameId: "different", saveDirOverride: directory }) });
  assert.equal(invalid.persisted.saveDirOverride, null);
});
