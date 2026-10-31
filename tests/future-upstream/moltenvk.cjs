const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");
const fs = require("node:fs"), path = require("node:path");

const repository = "KhronosGroup/MoltenVK";
const releases = ["1.4.1", "1.4.0"].map(version => githubRelease(repository, `v${version}`,
  ["MoltenVK-all.tar", "MoltenVK-ios.tar", "MoltenVK-macos.tar", "MoltenVK-tvos.tar"]));
// Every platform package gains a CPU word and a compressed archive format.
const scenarios = githubScenarios(repository, releases, { rename: name => name.replace(/\.tar$/, "-universal.tar.xz") });
scenarios.renamedAsset.usable = true;
const known = "MoltenVK/MoltenVK/dynamic/dylib/macOS/libMoltenVK.dylib";

module.exports = {
  managers: ["vulkan-moltenvk"],
  current: githubRoutes(repository, releases),
  scenarios,
  layout: {
    write(root) {
      for (const platform of ["iOS", "macOS"]) {
        const file = path.join(root, "MoltenVK/MoltenVK/dynamic/dylib", platform, "libMoltenVK.dylib");
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, platform);
      }
      fs.writeFileSync(path.join(root, "MoltenVK/LICENSE"), "Apache-2.0");
      return known;
    },
    resolve: root => require("../../src/modules/shared/vulkan/libraries").findFile(root, known, /^libMoltenVK\.dylib$/)
  }
};
