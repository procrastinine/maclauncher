const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const Catalog = require("../src/modules/mv/libs/catalog");

test("mv catalog resolves pixi5 bundle from external paths", () => {
  const version = Catalog.getVersion("mv-pixi", "pixi5-cicpoffs");
  assert.ok(version);

  const primary = path.resolve(
    __dirname,
    "..",
    "src",
    "external",
    "rpgmakermlinux-cicpoffs",
    "nwjs",
    "packagefiles",
    "rpgmaker-mv-pixi5"
  );
  const secondary = path.resolve(
    __dirname,
    "..",
    "src",
    "external",
    "rpgmakermlinux-cicpoffs",
    "nwjs",
    "nwjs",
    "packagefiles",
    "rpgmaker-mv-pixi5"
  );

  const primaryExists = fs.existsSync(primary);
  const secondaryExists = fs.existsSync(secondary);
  assert.ok(primaryExists || secondaryExists, "Missing pixi5 bundle in external paths.");

  const expected = primaryExists ? primary : secondary;
  assert.equal(version.bundleRoot, expected);
});
