const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Assets = require("../src/modules/rgss/assets");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function buildResourceRoot(root, kawarikiRoot) {
  const packs = ["Standard", "RPGVX", "RPGVXAce"];
  for (const pack of packs) {
    writeFile(path.join(root, "rtp", pack, "dummy.txt"), pack);
  }
  writeFile(path.join(root, "soundfont", "GMGSx.SF2"), "sound");
  writeFile(path.join(kawarikiRoot, "preload.rb"), "# preload");
}

test("ensureAssetsStaged is idempotent and writes a marker", () => {
  const resourceRoot = makeTempDir("maclauncher-rgss-res-");
  const kawarikiRoot = makeTempDir("maclauncher-rgss-kawariki-");
  const userDataDir = makeTempDir("maclauncher-rgss-user-");
  try {
    buildResourceRoot(resourceRoot, kawarikiRoot);

    const first = Assets.ensureAssetsStaged({ userDataDir, resourceRoot, kawarikiRoot });
    assert.equal(first.assetsStaged, true);
    assert.equal(first.stagedNow, true);

    const second = Assets.ensureAssetsStaged({ userDataDir, resourceRoot, kawarikiRoot });
    assert.equal(second.assetsStaged, true);
    assert.equal(second.stagedNow, false);

    const marker = path.join(userDataDir, "modules", "rgss", "assets", ".maclauncher-assets.json");
    assert.ok(fs.existsSync(marker));
  } finally {
    fs.rmSync(resourceRoot, { recursive: true, force: true });
    fs.rmSync(kawarikiRoot, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("removeStagedAssets clears staged status", () => {
  const resourceRoot = makeTempDir("maclauncher-rgss-res-");
  const kawarikiRoot = makeTempDir("maclauncher-rgss-kawariki-");
  const userDataDir = makeTempDir("maclauncher-rgss-user-");
  try {
    buildResourceRoot(resourceRoot, kawarikiRoot);
    Assets.ensureAssetsStaged({ userDataDir, resourceRoot, kawarikiRoot });
    Assets.removeStagedAssets({ userDataDir });

    const status = Assets.getAssetsStatus({ userDataDir, resourceRoot, kawarikiRoot });
    assert.equal(status.assetsStaged, false);
  } finally {
    fs.rmSync(resourceRoot, { recursive: true, force: true });
    fs.rmSync(kawarikiRoot, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
