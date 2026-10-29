const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const GameData = require("../src/modules/shared/game-data");
const GameStore = require("../src/main/game-store");

test("notes retain Unicode and spacing while preserving the current game record", t => {
  const root = makeTempDir("maclauncher-notes-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  GameStore.writeGameRecord(root, { gameId: "notes", gamePath: "/Games/Test", notes: "old", moduleData: { opaque: [1, 2] }, runtimeData: { sdk: { version: "8.3.4" } } });
  const text = "  Map reminder 🗺️\nSave before the boss.\n";
  GameStore.setGameNotes(root, "notes", text);
  const loaded = GameStore.loadGames(root)[0];
  assert.equal(loaded.notes, text);
  assert.deepEqual(loaded.moduleData, { opaque: [1, 2] });
  assert.deepEqual(loaded.runtimeData, { sdk: { version: "8.3.4" } });
  GameStore.setGameNotes(root, "notes", "");
  assert.equal(GameStore.readGameRecord(root, "notes").notes, "");
});

test("invalid notes never alter an existing record or create a missing game", t => {
  const root = makeTempDir("maclauncher-notes-invalid-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = GameStore.writeGameRecord(root, { gameId: "notes", notes: "keep" });
  const original = fs.readFileSync(file);
  for (const invalid of [null, {}, 123, "a".repeat(65537)]) {
    assert.throws(() => GameStore.setGameNotes(root, "notes", invalid), /notes must be text/);
    assert.deepEqual(fs.readFileSync(file), original);
  }
  assert.throws(() => GameStore.setGameNotes(root, "missing", "text"), /not found/);
  assert.equal(fs.existsSync(GameData.resolveGameDir(root, "missing")), false);
});

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("game store writes and reads per-game records", () => {
  const userDataDir = makeTempDir("maclauncher-game-store-");
  try {
    const record = {
      gameId: "game-1",
      name: "Test Game",
      gamePath: "/Games/Test"
    };
    const dataPath = GameStore.writeGameRecord(userDataDir, record);
    assert.equal(dataPath, GameData.resolveGameDataPath(userDataDir, record.gameId));

    const loaded = GameStore.readGameRecord(userDataDir, record.gameId);
    assert.equal(loaded.gameId, record.gameId);
    assert.equal(loaded.name, record.name);
    assert.equal(loaded.gamePath, record.gamePath);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("game store lists and loads valid records", () => {
  const userDataDir = makeTempDir("maclauncher-game-store-list-");
  try {
    GameStore.writeGameRecord(userDataDir, {
      gameId: "game-a",
      name: "Game A",
      gamePath: "/Games/A"
    });
    GameStore.writeGameRecord(userDataDir, {
      gameId: "game-b",
      name: "Game B",
      gamePath: "/Games/B"
    });

    const gamesRoot = GameData.resolveGamesRoot(userDataDir);
    fs.writeFileSync(path.join(gamesRoot, "not-a-dir.txt"), "noop");
    const badDir = path.join(gamesRoot, "badgame");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "game.json"), "{bad json");

    const ids = GameStore.listGameIds(userDataDir).sort();
    assert.deepEqual(ids, ["badgame", "game-a", "game-b"]);

    const loaded = GameStore.loadGames(userDataDir);
    const loadedIds = loaded.map(entry => entry.gameId).sort();
    assert.deepEqual(loadedIds, ["game-a", "game-b"]);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("a record write keeps a damaged record beside it and refuses after a read error", t => {
  const root = makeTempDir("maclauncher-game-store-unreadable-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = GameData.resolveGameDataPath(root, "cached");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const damaged = '{"gameId": "cached", "notes": "keep", "gamePath": ';
  fs.writeFileSync(file, damaged);
  assert.deepEqual(GameStore.loadGames(root), [], "a damaged record stays out of the library");
  GameStore.writeGameRecord(root, { gameId: "cached", gamePath: "/Games/Reimported" });
  const copies = fs.readdirSync(path.dirname(file)).filter(name => /^game\.unreadable-.+\.json$/.test(name));
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), copies[0]), "utf8"), damaged);
  assert.equal(GameStore.readGameRecord(root, "cached").gamePath, "/Games/Reimported");
  const written = fs.readFileSync(file), read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    if (target === file) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    return read(target, ...args);
  });
  assert.throws(() => GameStore.writeGameRecord(root, { gameId: "cached", gamePath: "/Games/Other" }), { code: "EIO" });
  t.mock.restoreAll();
  assert.deepEqual(fs.readFileSync(file), written, "a record that cannot be read is not replaced");
});

test("game store deletes per-game directories", () => {
  const userDataDir = makeTempDir("maclauncher-game-store-delete-");
  try {
    const gameId = "game-delete";
    GameStore.writeGameRecord(userDataDir, {
      gameId,
      name: "Delete Me",
      gamePath: "/Games/DeleteMe"
    });
    const gameDir = GameData.resolveGameDir(userDataDir, gameId);
    assert.ok(fs.existsSync(gameDir));

    const removed = GameStore.deleteGameData(userDataDir, gameId);
    assert.equal(removed, true);
    assert.ok(!fs.existsSync(gameDir));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
