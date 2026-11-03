const test = require("node:test"), assert = require("node:assert/strict");
const { applySaveIdentity } = require("../src/core/save-identity");

function moduleFacts(entry) {
  return {
    namespace: entry.namespace || "filesystem", identity: entry.saveDirOverride || entry.upstream,
    scope: entry.scope, explicit: entry.explicit, hostSubstitution: entry.hostSubstitution,
    createPatch: ({ entry, gameId }) => ({ saveDirOverride: "/saves/" + gameId,
      defaultSaveDir: "/saves/" + gameId, saveLocations: [{ directory: "/saves/" + gameId, role: "primary" }] })
  };
}

test("two library games sharing the actual save namespace get a stable visible import setting", () => {
  const older = { gameId: "older", name: "Same title", upstream: "/saves/shared" };
  const fresh = { gameId: "fresh", name: "Same title", upstream: "/saves/shared" };
  const next = applySaveIdentity(fresh, { games: [older], describe: moduleFacts });
  assert.equal(next.saveDirOverride, "/saves/fresh");
  assert.equal(next.defaultSaveDir, next.saveDirOverride);
  assert.deepEqual(next.saveLocations, [{ directory: "/saves/fresh", role: "primary" }]);
  assert.equal(Object.hasOwn(fresh, "saveDirOverride"), false);
  assert.equal(Object.hasOwn(older, "saveDirOverride"), false);
  assert.equal(applySaveIdentity({ ...fresh, upstream: "/saves/shared/" }, { games: [older], describe: moduleFacts }).saveDirOverride,
    "/saves/fresh", "A trailing separator does not establish a distinct physical save location");
  assert.equal(applySaveIdentity(next, { games: [older, next], describe: moduleFacts }), next,
    "Current ordinary settings already describe the isolated identity");
});

test("same game and different actual locations stay direct regardless of matching titles", () => {
  const entry = { gameId: "same", name: "Matching title", upstream: "/games/one/save" };
  for (const games of [[{ ...entry }], [{ gameId: "other", name: entry.name, upstream: "/games/two/save" }]])
    assert.equal(applySaveIdentity(entry, { games, describe: moduleFacts }), entry);
  assert.equal(applySaveIdentity(entry, { games: [{ gameId: "other", upstream: entry.upstream, namespace: "other-store" }], describe: moduleFacts }), entry);
});

test("explicit overrides and authored upstream IDs survive unless their actual current identity collides", () => {
  const entry = { gameId: "new", upstream: "/shared", saveDirOverride: "/user/chosen", hostSubstitution: true };
  assert.equal(applySaveIdentity(entry, { games: [{ gameId: "old", upstream: "/shared" }], describe: moduleFacts }), entry);
  const authored = { gameId: "authored", namespace: "publisher-save-id", upstream: "actual-game-id", explicit: true };
  assert.equal(applySaveIdentity(authored, { games: [], describe: moduleFacts }), authored);
  const next = applySaveIdentity(entry, { games: [{ gameId: "old", upstream: entry.saveDirOverride }], describe: moduleFacts });
  assert.equal(next.saveDirOverride, "/saves/new", "Only a real collision warrants changing an existing selection");
});

test("intentional global preferences and unavailable upstream facts never trigger a save override", () => {
  const entry = { gameId: "one", upstream: "/global/player", scope: "global", hostSubstitution: true };
  assert.equal(applySaveIdentity(entry, { games: [{ ...entry, gameId: "two" }], describe: moduleFacts }), entry);
  assert.equal(applySaveIdentity({ gameId: "unknown" }, { describe: () => null }).saveDirOverride, undefined);
  const relative = { gameId: "one", upstream: "relative/save", hostSubstitution: true };
  assert.equal(applySaveIdentity(relative, { games: [{ ...relative, gameId: "two" }], describe: moduleFacts }), relative,
    "Equal relative spellings do not prove the same actual filesystem location");
});

test("proven host substitution applies only the supported minimal option and preserves existing arguments", () => {
  const entry = { gameId: "stable", launchArguments: "--language ja", runtimeData: { renderer: "native" } };
  const describe = () => ({ namespace: "upstream-save", identity: "host-replaced-identity", hostSubstitution: true,
    createPatch: ({ entry, gameId, reason }) => {
      assert.equal(reason, "host-substitution");
      return { launchArguments: entry.launchArguments + " --gameid " + gameId };
    } });
  const next = applySaveIdentity(entry, { describe });
  assert.equal(next.launchArguments, "--language ja --gameid stable");
  assert.deepEqual(next.runtimeData, entry.runtimeData);
  assert.equal(Object.hasOwn(next, "saveDirOverride"), false);
  assert.deepEqual(Object.keys(next).sort(), Object.keys(entry).sort());
});

test("module facts beat stale library display metadata and cached exact locations remain usable", () => {
  const entry = { gameId: "new", upstream: "/actual/new", defaultSaveDir: "/stale/shared" };
  const games = [{ gameId: "old", upstream: "/actual/old", defaultSaveDir: "/stale/shared" }];
  assert.equal(applySaveIdentity(entry, { games, describe: moduleFacts }), entry);
  const fresh = { ...entry, upstream: "/actual/old" };
  const next = applySaveIdentity(fresh, { games: [{ gameId: "old", defaultSaveDir: "/actual/old" }],
    describe: value => value.upstream ? moduleFacts(value) : null });
  assert.equal(next.saveDirOverride, "/saves/new");
});

test("current settings and concurrent unrelated library metadata survive the visible settings delta", () => {
  const entry = { gameId: "new", upstream: "/old/snapshot", name: "Before", runtimeData: { video: { scale: 1 } } };
  const current = { ...entry, upstream: "/actual/current", name: "Updated title", runtimeData: { video: { scale: 3 }, audio: { volume: 50 } } };
  const games = [{ gameId: "old", upstream: "/actual/current", defaultSaveDir: "/stale" }];
  const describe = value => ({ ...moduleFacts(value), createPatch: () => {
    current.name = "Concurrent metadata";
    games[0].name = "Other game's metadata";
    return { runtimeData: { saves: { identity: "new" } } };
  } });
  const next = applySaveIdentity(entry, { games, current, describe });
  assert.equal(next.name, "Concurrent metadata");
  assert.deepEqual(next.runtimeData, { video: { scale: 3 }, audio: { volume: 50 }, saves: { identity: "new" } });
  assert.equal(entry.name, "Before");assert.equal(games[0].name, "Other game's metadata");
});

test("unsupported identity mechanisms cannot create hidden markers or change saved game IDs", () => {
  const entry = { gameId: "one" };
  for (const patch of [{ legacyIdentity: "hidden" }, { gameId: "replacement" }, { launchArguments: [] },
    { runtimeData: "invalid" }, { saveLocations: [{}] }, ["invalid"], "invalid"]){
    const describe = () => ({ namespace: "save", identity: "host", hostSubstitution: true, createPatch: () => patch });
    assert.equal(applySaveIdentity(entry, { describe }), entry);
  }
});

test("offline other games and invalid optional hooks preserve a usable direct import without guessing", async () => {
  const entry = { gameId: "fresh", upstream: "/saves/shared", defaultSaveDir: "/cached/shared" };
  const offline = { gameId: "offline", defaultSaveDir: entry.upstream }, diagnostics = [];
  const context = { logger: { debug: message => diagnostics.push(message) } };
  const describe = game => {
    if (game.gameId === offline.gameId) throw Object.assign(new Error("Other game is offline"), { code: "ENOENT" });
    return moduleFacts(game);
  };
  assert.equal(applySaveIdentity(entry, { games: [offline], describe, context }), entry,
    "An unavailable other game must not become a guessed cached-path collision");
  assert.equal(applySaveIdentity(entry, { games: [offline, { gameId: "known", upstream: entry.upstream }], describe, context }).saveDirOverride,
    "/saves/fresh", "A separate known collision can still use its supported adjustment");
  for (const invalid of [() => { throw Error("Current upstream facts unavailable"); },
    () => Promise.reject(Error("Async facts unavailable")), () => ({}),
    () => ({ ...moduleFacts(entry), hostSubstitution: true, createPatch: () => { throw Error("Unsupported adjustment"); } }),
    () => ({ ...moduleFacts(entry), hostSubstitution: true, createPatch: () => Promise.reject(Error("Async patch unavailable")) })])
    assert.equal(applySaveIdentity(entry, { games: [offline], describe: invalid, context }), entry);
  const throwingLogger = { logger: { debug: () => { throw Error("Logger unavailable"); } } };
  assert.equal(applySaveIdentity(entry, { describe: () => { throw Error("Facts unavailable"); }, context: throwingLogger }), entry);
  await new Promise(resolve => setImmediate(resolve)); // Rejected async hooks must be handled too.
  assert.ok(diagnostics.length > 0);assert.equal(Object.hasOwn(entry, "saveDirOverride"), false);
});
