const { githubRoutes, githubRelease, githubAsset, extraAssets } = require("../helpers/future-upstream.cjs");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

// Wine engines are assets of one Engines release; each is paired with the
// newest support archive from the Template releases. A catalog version names
// the engine, the support version and both archive digests.
const ENGINES = "Sikarugir-App/Engines", TEMPLATE = "Sikarugir-App/Template";
const Catalog = () => require("../../src/modules/crossover/sikarugir/runtime/catalog");
const templates = versions => versions.map(version => githubRelease(TEMPLATE, `v${version}`, [`Template-${version}.tar.xz`]));
const engines = (names, tag = "v1.0") => [githubRelease(ENGINES, tag, names)];
const routes = (engineReleases, templateReleases = templates(["1.0.24", "1.0.21"])) =>
  ({ ...githubRoutes(ENGINES, engineReleases), ...githubRoutes(TEMPLATE, templateReleases) });
const current = engines(["WS12WineSikarugir10.0_8.tar.xz", "WS12WineSikarugir11.0_1.tar.xz"]);
const digest = asset => asset.digest.slice(7);
function identity(asset, template = templates(["1.0.24"])[0].assets[0], templateVersion = "1.0.24") {
  return Catalog().snapshotVersion(/Sikarugir(\d+\.\d+(?:_\d+)?)/.exec(asset.name)[1], digest(asset),
    { version: templateVersion, asset: { sha256: digest(template) } });
}
// A later engine, published under the current name or a renamed one.
function later(name, extra = []) {
  const release = engines([...current[0].assets.map(asset => asset.name), name, ...extra]);
  return { routes: routes(release), version: identity(release[0].assets.find(asset => asset.name === name)), usable: true };
}
const replaced = { ...current[0], assets: current[0].assets.map(asset => asset.name.includes("11.0_1")
  ? { ...asset, size: asset.size + 1, digest: "sha256:" + "d".repeat(64) } : asset) };

module.exports = {
  managers: ["sikarugir"],
  current: routes(current),
  scenarios: {
    newVersion: later("WS12WineSikarugir11.0_2.tar.xz"),
    // A new wrapper generation, platform word and archive format.
    renamedAsset: later("WS13WineSikarugir11.0_2-macos-universal.zip"),
    addedAsset: later("WS12WineSikarugir11.0_2.tar.xz", extraAssets([githubAsset(ENGINES, "v1.0", "WS12WineSikarugir11.0_2.tar.xz")])),
    // A replaced engine archive is a new identity verified by its new digest;
    // the installed earlier identity stays usable offline.
    replacedFile: { routes: routes([replaced]), version: identity(replaced.assets[1]), usable: true, digests: ["d".repeat(64)],
      deleted: identity(current[0].assets[1]) },
    deletedRelease: { routes: routes(engines(["WS12WineSikarugir11.0_1.tar.xz"])), version: identity(current[0].assets[1]), usable: true,
      deleted: identity(current[0].assets[0]) }
  },
  layout: {
    write(root) {
      for (const name of ["wine", "wineserver"]) { fs.mkdirSync(path.join(root, "wswine.bundle", "bin"), { recursive: true }); fs.writeFileSync(path.join(root, "wswine.bundle", "bin", name), name); }
      return "wswine.bundle/bin/wine";
    },
    resolve: root => path.join(require("../../src/modules/crossover/sikarugir/runtime/payload").findWineRoot(root), "bin", "wine")
  },
  checks: {
    "Sikarugir pairs every engine with a newer support archive and a saved pairing that left the list gives way": async (t, Harness) => {
      const manager = require("../../src/modules/crossover/sikarugir/runtime/manager");
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "future-sikarugir-")); t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
      Harness.network.routes = routes(current);
      await manager.refreshCatalog({ userDataDir, force: true });
      const listed = () => manager.getState({ userDataDir }).catalog.versions.map(version => manager.core.catalog.find(row => row.version === version));
      const before = listed().map(row => row.version);
      Harness.network.routes = routes(current, [githubRelease(TEMPLATE, "v2.0.0", ["Template-2.0.0-macos-universal.zip"]), ...templates(["1.0.24", "1.0.21"])]);
      await manager.refreshCatalog({ userDataDir, force: true });
      const rows = listed();
      assert.deepEqual(rows.map(row => row.template.version), ["2.0.0", "2.0.0"], "a later support major version and archive name are followed");
      assert.ok(rows.every(row => !before.includes(row.version)));
      const saved = { runtimes: { sikarugir: { defaultVersion: before[0] } } };
      assert.equal(manager.resolveSelection({}, saved, userDataDir).version, rows[0].version, "a saved pairing that left the list gives way when it is not installed");
    },
    "Sikarugir extracts renamed zip and gzip engine archives and finds a bundle moved one folder deeper": async t => {
      const { extractArchive } = require("../../src/modules/crossover/sikarugir/runtime/archive");
      const Payload = require("../../src/modules/crossover/sikarugir/runtime/payload");
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "future-sikarugir-archive-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const source = path.join(root, "source"), bin = path.join(source, "WS13WineSikarugir11.0_2", "wswine.bundle", "bin");
      fs.mkdirSync(bin, { recursive: true });
      for (const name of ["wine", "wineserver"]) fs.writeFileSync(path.join(bin, name), name, { mode: 0o755 });
      fs.symlinkSync("wine", path.join(bin, "wine64"));
      const archives = { zip: path.join(root, "WS13WineSikarugir11.0_2-macos-universal.zip"), gzip: path.join(root, "WS13WineSikarugir11.0_2.tar.gz") };
      execFileSync("/usr/bin/zip", ["-qry", archives.zip, "WS13WineSikarugir11.0_2"], { cwd: source });
      execFileSync("/usr/bin/tar", ["-czf", archives.gzip, "WS13WineSikarugir11.0_2"], { cwd: source });
      for (const [format, archive] of Object.entries(archives)) {
        const destination = path.join(root, format); fs.mkdirSync(destination);
        await extractArchive(archive, destination);
        const wineRoot = Payload.findWineRoot(destination);
        assert.equal(wineRoot, path.join(destination, "WS13WineSikarugir11.0_2", "wswine.bundle"), format);
        assert.equal(fs.readlinkSync(path.join(wineRoot, "bin", "wine64")), "wine", `${format} keeps internal links`);
        assert.equal(fs.statSync(path.join(wineRoot, "bin", "wine")).mode & 0o111, 0o111, `${format} keeps executable modes`);
      }
    }
  }
};
