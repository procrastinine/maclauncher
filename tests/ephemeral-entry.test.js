const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const EphemeralEntries = require("../src/core/ephemeral-entries");
const GameStore = require("../src/core/game-store");
const GameData = require("../src/modules/shared/game-data");
const WindowActions = require("../src/modules/window/app-actions");

function library() { return fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-ephemeral-")); }

test("an ephemeral entry is an ordinary record in its marked folder until its session ends", t => {
  const userDataDir = library();t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const entry = WindowActions.applyGraphics.createEntry({ kind: "application", pid: 4242, name: "Example", bundleIdentifier: "com.example.app",
    path: "/Applications/Example.app" }, { userDataDir, gameId: "session1" });
  assert.equal(entry.gamePath, GameData.resolveGameDir(userDataDir, "session1"));
  EphemeralEntries.mark(userDataDir, entry.gameId);
  GameStore.writeGameRecord(userDataDir, entry);
  // The live graphics files of a running session live in the same folder.
  fs.writeFileSync(path.join(entry.gamePath, "controls.bin"), Buffer.alloc(16));
  assert.ok(EphemeralEntries.isEphemeral(userDataDir, entry));
  assert.deepEqual(GameStore.loadGames(userDataDir).map(game => game.gameId), ["session1"]);
  assert.ok(EphemeralEntries.remove(userDataDir, entry.gameId));
  assert.equal(fs.existsSync(entry.gamePath), false, "the whole session folder is removed");
  assert.deepEqual(GameStore.loadGames(userDataDir), []);
  assert.equal(EphemeralEntries.remove(userDataDir, entry.gameId), false);
});

test("the startup sweep removes only marked folders and never creates logs", t => {
  const userDataDir = library();t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const kept = { gameId: "game1", gamePath: "/Games/Example", name: "Example" };
  GameStore.writeGameRecord(userDataDir, kept);
  for (const gameId of ["crashed1", "crashed2"]) {
    EphemeralEntries.mark(userDataDir, gameId);
    GameStore.writeGameRecord(userDataDir, { gameId, gamePath: GameData.resolveGameDir(userDataDir, gameId), name: gameId, ephemeral: true });
  }
  EphemeralEntries.mark(userDataDir, "running1");
  assert.deepEqual(EphemeralEntries.sweep(userDataDir, { keep: gameId => gameId === "running1" }).sort(), ["crashed1", "crashed2"]);
  assert.deepEqual(fs.readdirSync(GameData.resolveGamesRoot(userDataDir)).sort(), ["game1", "running1"]);
  assert.equal(EphemeralEntries.remove(userDataDir, "game1"), false, "an unmarked folder is never removed");
  assert.equal(fs.existsSync(GameData.resolveGameLogsDir(userDataDir, "running1")), false);
  assert.deepEqual(EphemeralEntries.sweep(path.join(userDataDir, "missing")), []);
});

test("a marker must be a regular file", t => {
  const userDataDir = library();t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(GameData.resolveGameDir(userDataDir, "game1"), EphemeralEntries.MARKER), { recursive: true });
  assert.equal(EphemeralEntries.isEphemeral(userDataDir, { gameId: "game1" }), false);
  assert.equal(EphemeralEntries.isEphemeral(userDataDir, { gameId: "../game1" }), false);
  assert.deepEqual(EphemeralEntries.sweep(userDataDir), []);
});

test("removing a session entry also removes its prepared graphics rows", t => {
  const userDataDir = library();
  const PreparedRows = require("../src/modules/shared/effects/prepared-rows");
  t.after(() => { PreparedRows.configure({});fs.rmSync(userDataDir, { recursive: true, force: true }); });
  const preparer = require("../src/modules/shared/source-identity").identity(path.join(__dirname, "../src/modules/shared/effects/runtime.js"));
  const target = gameId => path.join(GameData.resolveGameDir(userDataDir, gameId), "effects", "reshade", "effect-plan.json");
  const store = path.join(userDataDir, "graphics", "live-prepared-rows.json");
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, JSON.stringify({ schema: 1, preparer, targets: { [target("session1")]: { identity: "a:1", rows: {} }, [target("game1")]: { identity: "b:2", rows: {} } } }));
  PreparedRows.configure({ userDataDir });
  EphemeralEntries.mark(userDataDir, "session1");
  assert.ok(EphemeralEntries.remove(userDataDir, "session1"));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(store, "utf8")).targets), [target("game1")]);
  assert.equal(PreparedRows.forget(GameData.resolveGameDir(userDataDir, "session1")), 0);
});
