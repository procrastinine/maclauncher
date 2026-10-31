const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const assert = require("node:assert/strict");

// Sikarugir's support Template releases also supply the DXMT support packages.
const repository = "Sikarugir-App/Template";
const releases = ["1.0.24", "1.0.21"].map(version => githubRelease(repository, `v${version}`, [`Template-${version}.tar.xz`]));
const scenarios = githubScenarios(repository, releases);
scenarios.renamedAsset.usable = true;

// The support archive's current layout: a Template app whose renderer folder
// holds the DXMT libraries.
function writeTemplate(root, version = "1.0.24") {
  const contents = path.join(root, `Template-${version}.app`, "Contents"), dxmt = path.join(contents, "SharedSupport", "renderer", "dxmt");
  for (const relative of require("../../src/modules/crossover/temporal/support-manager").FILES) {
    fs.mkdirSync(path.dirname(path.join(dxmt, relative)), { recursive: true }); fs.writeFileSync(path.join(dxmt, relative), relative);
  }
  fs.mkdirSync(path.join(contents, "Frameworks"), { recursive: true });
  return path.relative(root, contents);
}

module.exports = {
  managers: ["sikarugir-graphics-bridge"],
  current: githubRoutes(repository, releases),
  scenarios,
  layout: { write: root => writeTemplate(root), resolve: root => require("../../src/modules/crossover/sikarugir/graphics/closure").templateContents(root, "1.0.24") },
  checks: {
    "DXMT support installs from a renamed Template moved one folder deeper without its optional notices": async t => {
      const Support = require("../../src/modules/crossover/temporal/support-manager");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "future-dxmt-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const wrapper = path.join(root, "Template 2.0.0 (macOS universal)");
      writeTemplate(wrapper, "2.0.0-universal");
      fs.rmSync(path.join(wrapper, "Template-2.0.0-universal.app/Contents/SharedSupport/renderer/dxmt/LICENSE"));
      fs.writeFileSync(path.join(root, "README.txt"), "notes");
      const metadata = await Support.prepareInstall({ unpacked: root, pin: { version: "2.0.0" } });
      assert.deepEqual(fs.readdirSync(root), ["dxmt"], "only the selected DXMT files remain");
      assert.equal(metadata.files.LICENSE, undefined);
      const install = Support.verified({ installDir: root, installationMetadata: metadata });
      assert.equal(install?.baseRoot, path.join(root, "dxmt", "wine"));
    }
  }
};
