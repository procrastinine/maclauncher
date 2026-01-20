const assert = require("node:assert/strict");
const test = require("node:test");

const RenpyModule = require("../src/modules/renpy/main");

test("migrateSettings normalizes legacy module default runtime", () => {
  const settings = {
    modules: {
      renpy: {
        defaultRuntime: "renpy-sdk"
      }
    }
  };

  RenpyModule.migrateSettings(settings);

  assert.equal(settings.modules.renpy.defaultRuntime, "sdk");
});

test("migrateSettings maps renpy default to patched", () => {
  const settings = {
    modules: {
      renpy: {
        defaultRuntime: "renpy"
      }
    }
  };

  RenpyModule.migrateSettings(settings);

  assert.equal(settings.modules.renpy.defaultRuntime, "patched");
});
