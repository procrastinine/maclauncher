const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");

// PyPI's project JSON: every release's files with their digests, and the
// current release's files under `urls`.
const URL = "https://pypi.org/pypi/siglus-ssu/json";
const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");
function file(filename, { size = 40960, digest = filename } = {}) {
  return { filename, url: `https://files.pythonhosted.org/packages/${sha256(filename).slice(0, 2)}/${sha256(filename).slice(2, 4)}/${sha256(filename).slice(4)}/${filename}`,
    size, packagetype: filename.endsWith(".whl") ? "bdist_wheel" : "sdist", python_version: filename.endsWith(".whl") ? "py3" : "source",
    requires_python: ">=3.10", upload_time_iso_8601: "2026-01-01T00:00:00.000000Z", yanked: false, yanked_reason: null,
    digests: { md5: sha256(digest).slice(0, 32), sha256: sha256(digest), blake2b_256: sha256("b" + digest) } };
}
const release = (version, names) => [version, (names || [`siglus_ssu-${version}-py3-none-any.whl`, `siglus_ssu-${version}.tar.gz`]).map(name => file(name))];
function project(releases) {
  const map = Object.fromEntries(releases);
  const latest = Object.keys(map).sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0];
  return { info: { name: "siglus-ssu", version: latest, summary: "Siglus SceneScript Utility", requires_python: ">=3.10", yanked: false },
    last_serial: 27000000, releases: map, urls: map[latest], vulnerabilities: [] };
}
const current = [release("0.6.1"), release("0.5.0")];
const scenarios = {
  newVersion: { routes: { [URL]: project([release("1.0.0"), ...current]) }, version: "1.0.0", usable: true },
  renamedAsset: { routes: { [URL]: project([release("1.0.0", ["siglus_ssu-1.0.0-py2.py3-none-any.whl"]), ...current]) }, version: "1.0.0", usable: true },
  addedAsset: { routes: { [URL]: project([release("1.0.0", ["siglus_ssu-1.0.0.tar.gz", "siglus_ssu-1.0.0-cp313-cp313-macosx_11_0_arm64.whl",
    "siglus_ssu-1.0.0-py3-none-any.whl", "siglus_ssu-1.0.0-py3-none-any.whl.metadata"]), ...current]) }, version: "1.0.0", usable: true },
  replacedFile: { routes: { [URL]: project([["0.6.1", [file("siglus_ssu-0.6.1-py3-none-any.whl", { size: 40961, digest: "replaced" })]], current[1]]) }, version: "0.6.1", usable: true },
  deletedRelease: { routes: { [URL]: project([current[0]]) }, version: "0.6.1", usable: true, deleted: "0.5.0" }
};
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "future-siglus-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

module.exports = { managers: ["siglus-ssu"], current: { [URL]: project(current) }, scenarios, checks: {
  async "a PyPI answer without the per-release list still lists the current release"(t, Harness) {
    const { manager } = require("../../src/modules/siglus/tools"), userDataDir = directory(t);
    const { releases, ...answer } = project([release("1.0.0"), ...current]);
    Harness.network.routes = { [URL]: answer };
    await manager.refreshCatalog({ userDataDir, force: true });
    assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["1.0.0"]);
  },
  async "a saved siglus-ssu version that PyPI removed gives way to the newest listed version"(t, Harness) {
    const { manager } = require("../../src/modules/siglus/tools"), userDataDir = directory(t);
    Harness.network.routes = { [URL]: project(current) };
    await manager.refreshCatalog({ userDataDir, force: true });
    const state = manager.getState({ userDataDir, settings: { defaultVersion: "0.4.9" } });
    assert.equal(state.defaultVersion, "0.6.1"); assert.equal(state.defaultSource, "manager");
    assert.equal(manager.getState({ userDataDir, settings: { defaultVersion: "0.5.0" } }).defaultVersion, "0.5.0");
  }
} };
