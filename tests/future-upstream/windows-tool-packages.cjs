const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { githubRoutes, githubRelease } = require("../helpers/future-upstream.cjs");
const { writeZipArchive } = require("../helpers/zip-fixture");

// Install paths of the managed Windows tools when a publisher moves files into
// folders, ships another archive format or renames its license file.
function pe() {
  const bytes = Buffer.alloc(1024); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150); bytes.writeUInt16LE(0x20b, 152); bytes.writeUInt16LE(3, 220); return bytes;
}
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function published(repository, tag, name, bytes) {
  const release = githubRelease(repository, tag, [name]);
  Object.assign(release.assets[0], { size: bytes.length, digest: "sha256:" + sha256(bytes) });
  return { release, routes: { ...githubRoutes(repository, [release]), [release.assets[0].browser_download_url]: bytes } };
}
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "future-windows-tool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

module.exports = { checks: {
  async "a Windows tool installs from an archive that moved its executable into a folder"(t, Harness) {
    const { manager } = require("../../src/modules/alicesoft/system4-tools");
    const root = directory(t), archive = path.join(root, "upload.zip");
    writeZipArchive(archive, [{ name: "README.txt", data: "notes" }, { name: "alice-tools 1.0 (win64)/bin/alice.exe", data: pe() },
      { name: "alice-tools 1.0 (win64)/bin/ALICE.DLL", data: "library" }]);
    const { routes, release } = published("nunuhara/alice-tools", "1.0.0", "alice-tools-1.0.0-win64.zip", fs.readFileSync(archive));
    Harness.network.routes = routes;
    const userDataDir = path.join(root, "profile");
    await manager.refreshCatalog({ userDataDir, force: true });
    const installed = await manager.installRuntime({ userDataDir, version: "1.0.0" });
    assert.equal(path.basename(installed.executablePath), "alice.exe");
    assert.equal(release.assets[0].name, "alice-tools-1.0.0-win64.zip");
  },
  async "RLdev installs from another archive format with its files one folder deeper"(t, Harness) {
    const { manager } = require("../../src/modules/siglus/rldev-tools");
    const root = directory(t), input = path.join(root, "input"), archive = path.join(root, "V1.41-Windows.7z");
    for (const [name, data] of [["RLdev 1.41/x64/bin/kprl16.exe", pe()], ["RLdev 1.41/KFN/reallive.kfn", "kfn"], ["RLdev 1.41/README.md", "readme"]]) {
      fs.mkdirSync(path.dirname(path.join(input, name)), { recursive: true }); fs.writeFileSync(path.join(input, name), data);
    }
    execFileSync(require("../../src/modules/shared/runtime/sevenzip").resolveSevenZipBinary(), ["a", "-bd", archive, "RLdev 1.41"], { cwd: input, stdio: "ignore" });
    const tool = published("yoremi-trad-fr/rldev2026-go-edition", "rldev2026-go-1.41", "V1.41-Windows.7z", fs.readFileSync(archive));
    Harness.network.routes = tool.routes;
    const userDataDir = path.join(root, "profile");
    await manager.refreshCatalog({ userDataDir, force: true });
    const installed = await manager.installRuntime({ userDataDir, version: "1.41" });
    assert.equal(fs.readFileSync(path.join(installed.installDir, "reallive.kfn"), "utf8"), "kfn");
  }
} };
