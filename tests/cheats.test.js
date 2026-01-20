const assert = require("node:assert/strict");
const test = require("node:test");

const { createCheatsHelpers } = require("../src/modules/shared/cheats/cheats");
const cheatsSchema = require("../src/modules/shared/mvmz/cheats/schema.json");

const Cheats = createCheatsHelpers(cheatsSchema);

test("normalizeCheats clamps numbers and respects defaults", () => {
  const input = {
    enabled: false,
    speed: 99,
    moveSpeed: 0,
    noClip: true,
    bogus: true
  };

  const normalized = Cheats.normalizeCheats(input);

  assert.equal(normalized.enabled, false);
  assert.equal(normalized.speed, 10);
  assert.equal(normalized.moveSpeed, 1);
  assert.equal(normalized.noClip, true);
  assert.equal("bogus" in normalized, false);
  assert.equal(normalized.instantText, Cheats.defaults.instantText);
});

test("cheatsEqual compares normalized values", () => {
  assert.ok(Cheats.cheatsEqual({}, Cheats.defaults));
  assert.ok(Cheats.cheatsEqual({ speed: "2" }, { speed: 2 }));
  assert.ok(!Cheats.cheatsEqual({ speed: 2 }, { speed: 3 }));
});
