const assert = require("node:assert/strict");
const test = require("node:test");

const { createCheatsHelpers } = require("../src/modules/shared/cheats/cheats");
const cheatsSchema = require("../src/modules/rgss/cheats/schema.json");

const Cheats = createCheatsHelpers(cheatsSchema);

test("rgss cheats normalize clamps numbers and drops unknown keys", () => {
  const input = {
    fieldSpeed: 99,
    battleSpeed: 0,
    moveSpeed: -3,
    eventBattleOutcome: 99,
    expMult: "2.5",
    debugEnabled: true,
    audioEnabled: true,
    bgmVolume: 200,
    bogus: true
  };

  const normalized = Cheats.normalizeCheats(input);

  assert.equal(normalized.fieldSpeed, 10);
  assert.equal(normalized.battleSpeed, 1);
  assert.equal(normalized.moveSpeed, 0);
  assert.equal(normalized.eventBattleOutcome, 4);
  assert.equal(normalized.expMult, 2.5);
  assert.equal(normalized.debugEnabled, true);
  assert.equal(normalized.audioEnabled, true);
  assert.equal(normalized.bgmVolume, 100);
  assert.equal("bogus" in normalized, false);
});

test("rgss cheats equality uses normalized defaults", () => {
  assert.ok(Cheats.cheatsEqual({}, Cheats.defaults));
  assert.ok(Cheats.cheatsEqual({ fieldSpeed: "2" }, { fieldSpeed: 2 }));
  assert.ok(!Cheats.cheatsEqual({ expMult: 2 }, { expMult: 3 }));
});
