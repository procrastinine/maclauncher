const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {upgradeRecord} = require("../src/core/graphics-record-upgrade");
const StoredPlan = require("../src/modules/shared/effects/stored-plan");
const Graphics = require("../src/modules/shared/reshade/graphics-settings");

const V040 = require("./fixtures/graphics-legacy-upgrade/v0.4.0-records.json");
function directory(t) {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "record-upgrade-")));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  return userDataDir;
}
const record = () => structuredClone(V040.records["CRT pack shader + FSR2/FSR1/LSFG after"]);

test("a v0.4.0 record is upgraded on read and written once without its legacy fields", t => {
  const userDataDir = directory(t), writes = [], legacy = record();
  const upgraded = upgradeRecord(userDataDir, legacy, value => writes.push(value));
  assert.equal(writes.length, 1);assert.equal(Object.hasOwn(writes[0], "reshade") || Object.hasOwn(writes[0], "graphics"), false);
  assert.deepEqual(writes[0].effects, JSON.parse(JSON.stringify(upgraded.effects)));
  assert.equal(StoredPlan.read(upgraded).source, "effects");
  assert.equal(upgradeRecord(userDataDir, upgraded, value => writes.push(value)), upgraded, "an upgraded record is not written again");
  assert.equal(writes.length, 1);
  // Concurrent readers (app and command-line launch) write identical bytes.
  const again = [];upgradeRecord(userDataDir, record(), value => again.push(value));
  assert.equal(JSON.stringify(again[0]), JSON.stringify(writes[0]));
});

test("a failed write keeps the upgraded record for this read and retries on the next", t => {
  const userDataDir = directory(t), warnings = [];
  let attempts = 0;
  const failing = () => {attempts++;throw new Error("disk full");};
  const upgraded = upgradeRecord(userDataDir, record(), failing, {warn: (...args) => warnings.push(args.join(" "))});
  assert.equal(Object.hasOwn(upgraded, "reshade"), false);assert.equal(upgraded.effects.schema, 2);
  assert.match(warnings[0], /next read upgrades them again.*disk full/);
  upgradeRecord(userDataDir, record(), failing, {warn() {}});
  assert.equal(attempts, 2);
});

test("the record's runtime selects the graphics host used for the upgrade", t => {
  const userDataDir = directory(t), discover = t.mock.method(Graphics, "capabilities", () => V040.capabilities);
  upgradeRecord(userDataDir, {...record(), runtimeId: "native", reshade: {enabled: false}, graphics: Graphics.normalizeSettings({neuralMethod: "mlx-dlss"})}, () => {});
  assert.equal(discover.mock.calls[0].arguments[1], "window");
  upgradeRecord(userDataDir, {...record(), runtimeId: null, reshade: {enabled: false}, graphics: Graphics.normalizeSettings({neuralMethod: "mlx-dlss"})}, () => {});
  assert.equal(discover.mock.calls[1].arguments[1], "remote", "a record without a runtime uses the module default");
});
test("reading a game record upgrades it in one atomic write and never fails the read", t => {
  const GameStore = require("../src/core/game-store"), userDataDir = directory(t), legacy = {...record(), gameId: "upgrade-hook"};
  GameStore.writeGameRecord(userDataDir, legacy);
  const file = path.join(userDataDir, "games", legacy.gameId, "game.json"), inode = fs.statSync(file).ino;
  const loaded = GameStore.readGameRecord(userDataDir, legacy.gameId), persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.notEqual(fs.statSync(file).ino, inode, "the record is replaced, not edited in place");
  assert.equal(Object.hasOwn(persisted, "reshade") || Object.hasOwn(persisted, "graphics"), false);
  assert.deepEqual(persisted.effects, JSON.parse(JSON.stringify(loaded.effects)));
  const written = fs.statSync(file).ino;
  assert.deepEqual(GameStore.readGameRecord(userDataDir, legacy.gameId), JSON.parse(JSON.stringify(loaded)));
  assert.equal(fs.statSync(file).ino, written, "an upgraded record is not written again");
  // An upgrade that cannot run leaves the record readable as stored.
  GameStore.writeGameRecord(userDataDir, legacy);
  t.mock.method(StoredPlan, "isLegacy", () => {throw new Error("upgrade unavailable");});
  assert.deepEqual(GameStore.readGameRecord(userDataDir, legacy.gameId), JSON.parse(JSON.stringify(legacy)));
});
