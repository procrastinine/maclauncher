const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {legacyGameMirrors} = require("../src/modules/ios/backcompat");
const {retireLegacyGameMirror} = require("../src/core/backcompat/legacy-game-mirrors");

test("released IPA generations restore to their existing required layouts once and preserve conflicts", async t => {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ios-backcompat-")));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const entry = {gameId: "owned", moduleId: "ios"};
  const descriptors = legacyGameMirrors(entry, {userDataDir});
  assert.equal(descriptors.length, 2);
  for (const descriptor of descriptors) {
    fs.mkdirSync(descriptor.mirrorRoot, {recursive: true});
    fs.writeFileSync(path.join(descriptor.mirrorRoot, "missing.dat"), "released bytes");
    fs.writeFileSync(path.join(descriptor.mirrorRoot, "conflict.dat"), "released conflict");
  }
  // The prepared route was interrupted before its directory was installed.
  // Extraction already has current data, which must remain authoritative.
  fs.mkdirSync(descriptors[1].sourceRoot);
  fs.writeFileSync(path.join(descriptors[1].sourceRoot, "conflict.dat"), "current bytes");
  for (const descriptor of descriptors) {
    const result = await retireLegacyGameMirror(descriptor, {userDataDir});
    assert.equal(result.complete, true, result.reason);
    assert.equal(fs.readFileSync(path.join(descriptor.sourceRoot, "missing.dat"), "utf8"), "released bytes");
    assert.equal(fs.existsSync(descriptor.mirrorRoot), false);
  }
  assert.equal(fs.readFileSync(path.join(descriptors[0].sourceRoot, "conflict.dat"), "utf8"), "released conflict");
  const extracted = descriptors[1].sourceRoot;
  assert.equal(fs.readFileSync(path.join(extracted, "conflict.dat"), "utf8"), "current bytes");
  const conflicts = fs.readdirSync(extracted).filter(name => name.startsWith("conflict.dat.MacLauncher-conflict-"));
  assert.equal(conflicts.length, 1);
  assert.equal(fs.readFileSync(path.join(extracted, conflicts[0]), "utf8"), "released conflict");
});

test("ordinary IPA preparation has no obsolete generation probes or backcompat calls", () => {
  const source = fs.readFileSync(require.resolve("../src/modules/ios/prepare"), "utf8");
  assert.doesNotMatch(source, /["']\.previous["']|backcompat|function recover\(/);
  assert.deepEqual(legacyGameMirrors({gameId: "owned"}, {userDataDir: "/unused/profile"})
    .map(({mirrorRoot, sourceRoot}) => [mirrorRoot, sourceRoot]), [
      ["/unused/profile/games/owned/modules/ios/.previous", "/unused/profile/games/owned/modules/ios/prepared"],
      ["/unused/profile/games/owned/modules/ios/extracted/.previous", "/unused/profile/games/owned/modules/ios/extracted/contents"]
    ]);
});
