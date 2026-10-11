const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Runtime = require("../src/modules/godot/runtime/gdsdecomp-runtime");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("gdsdecomp normalizes semver versions", () => {
  assert.equal(Runtime.normalizeVersion("v2.4.0"), "2.4.0");
});

test("gdsdecomp collects versions from mac assets", () => {
  const releases = [
    {
      tag_name: "v2.4.0",
      assets: [
        { name: "GDRE_tools-v2.4.0-macos.zip" },
        { name: "GDRE_tools-v2.4.0-win.zip" }
      ]
    },
    {
      tag_name: "v2.3.1",
      assets: [{ name: "GDRE_tools-v2.3.1-macos.zip" }]
    }
  ];
  const versions = Runtime.__test.collectVersions(releases);
  assert.deepEqual(versions, ["2.4.0", "2.3.1"]);
});

test("gdsdecomp selects mac asset by version", () => {
  const releases = [
    {
      tag_name: "v2.4.0",
      assets: [
        { name: "GDRE_tools-v2.4.0-win.zip" },
        { name: "GDRE_tools-v2.4.0-macos.zip", browser_download_url: "https://ex" }
      ]
    }
  ];
  const selected = Runtime.__test.selectReleaseAsset(releases, "2.4.0");
  assert.ok(selected);
  assert.equal(selected.asset.name, "GDRE_tools-v2.4.0-macos.zip");
});

test("gdsdecomp finds CLI binary in app bundle", () => {
  const root = makeTempDir("maclauncher-gdre-");
  try {
    const appPath = path.join(root, "Godot RE Tools.app");
    const macosDir = path.join(appPath, "Contents", "MacOS");
    fs.mkdirSync(macosDir, { recursive: true });
    const binaryPath = path.join(macosDir, "Godot RE Tools");
    fs.writeFileSync(binaryPath, "");
    const found = Runtime.__test.findCliBinary(appPath);
    assert.equal(found, binaryPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
