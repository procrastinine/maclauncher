const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const RenpyModule = require("../src/modules/renpy/main");

function createTempGameRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-renpy-cheats-"));
  const gameDir = path.join(root, "game");
  fs.mkdirSync(gameDir, { recursive: true });
  return { root, gameDir };
}

test("renpy cheat patch actions install and remove files", () => {
  const { root, gameDir } = createTempGameRoot();
  try {
    const entry = { gamePath: root, contentRootDir: root, renpyGameOnly: false };

    let status = RenpyModule.actions.renpyCheatsStatus(entry, {}, {});
    assert.equal(status.urwPresent, false);
    assert.equal(status.urmPresent, false);

    fs.mkdirSync(path.join(gameDir, "__urw"));
    fs.writeFileSync(path.join(gameDir, "__urw", "_urw.rpyc"), "legacy");
    status = RenpyModule.actions.renpyCheatsStatus(entry, {}, {});
    assert.equal(status.urwPresent, true);
    assert.equal(status.urwInstalled, false);

    status = RenpyModule.actions.patchRenpyWalkthrough(entry, {}, {});
    assert.equal(status.urwInstalled, true);
    assert.equal(fs.existsSync(path.join(gameDir, "__urw", "_urw.rpyc")), false);
    const updater = fs.readFileSync(path.join(gameDir, "__urw", "urw_updater.rpy"), "utf8");
    assert.ok(updater.includes("managed by MacLauncher"));
    assert.ok(!updater.includes("ssl.CERT_NONE"));
    assert.ok(!updater.includes("check_hostname = False"));
    assert.ok(!updater.includes("urllib"));
    for (const name of ["urw_core", "urw_processor", "urw_screens", "urw_updater", "urw_utils"]) {
      assert.ok(fs.existsSync(path.join(gameDir, "__urw", `${name}.rpy`)));
    }
    assert.equal(
      fs.existsSync(path.join(gameDir, "__urw", "urw_core.rpy")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(gameDir, "__urw", "urw_screens.rpy")),
      true
    );

    status = RenpyModule.actions.addRenpyMod(entry, {}, {});
    assert.equal(status.urmInstalled, true);
    assert.equal(
      fs.existsSync(path.join(gameDir, "0x52_URM.rpa")),
      true
    );

    status = RenpyModule.actions.removeRenpyWalkthrough(entry, {}, {});
    assert.equal(status.urwPresent, false);
    assert.equal(
      fs.existsSync(path.join(gameDir, "__urw", "urw_core.rpy")),
      false
    );
    assert.equal(
      fs.existsSync(path.join(gameDir, "__urw")),
      false
    );

    status = RenpyModule.actions.removeRenpyMod(entry, {}, {});
    assert.equal(status.urmPresent, false);
    assert.equal(
      fs.existsSync(path.join(gameDir, "0x52_URM.rpa")),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
