const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("mv catalog prefers packaged external path when present", () => {
  const originalResourcesPath = process.resourcesPath;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-mv-catalog-"));
  const packagedPath = path.join(
    tempRoot,
    "external",
    "rpgmakermlinux-cicpoffs",
    "nwjs",
    "packagefiles",
    "rpgmaker-mv-pixi5"
  );

  fs.mkdirSync(packagedPath, { recursive: true });
  process.resourcesPath = tempRoot;

  try {
    delete require.cache[require.resolve("../src/modules/mv/libs/catalog")];
    const Catalog = require("../src/modules/mv/libs/catalog");
    const version = Catalog.getVersion("mv-pixi", "pixi5-cicpoffs");
    assert.ok(version);
    assert.equal(version.bundleRoot, packagedPath);
  } finally {
    if (originalResourcesPath === undefined) {
      delete process.resourcesPath;
    } else {
      process.resourcesPath = originalResourcesPath;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
