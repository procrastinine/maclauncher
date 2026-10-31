// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
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

test("gdsdecomp lists one version per Mac release with GitHub's digest", async t => {
  const repository = "GDRETools/gdsdecomp";
  const releases = [Harness.githubRelease(repository, "v2.4.0", ["GDRE_tools-v2.4.0-win.zip", "GDRE_tools-v2.4.0-macos.zip"]),
    Harness.githubRelease(repository, "v2.3.1", ["GDRE_tools-v2.3.1-macos.tar.xz"]), Harness.githubRelease(repository, "v2.3.0", ["GDRE_tools-v2.3.0-linux.zip"])];
  t.after(() => { Harness.network.routes = null; });
  Harness.network.routes = Harness.githubRoutes(repository, releases);
  const { versions, rows } = await Runtime.fetchAvailableVersions();
  assert.deepEqual(versions, ["2.4.0", "2.3.1"]);
  assert.equal(rows[0].files[0].name, "GDRE_tools-v2.4.0-macos.zip");
  assert.equal(rows[0].files[0].digest.value, releases[0].assets[1].digest.slice(7));
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
