const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

const repository = "eglaysher/rlvm";
const releases = ["0.15", "0.14"].map(version => githubRelease(repository, `release-${version}`, [`rlvm_${version}.dmg`]));
const scenarios = githubScenarios(repository, releases);
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["rlvm"], current: githubRoutes(repository, releases), scenarios,
  layout: {
    write(root) {
      const executable = path.join(root, "rlvm.app", "Contents", "MacOS", "rlvm");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "engine");
      return "rlvm.app/Contents/MacOS/rlvm";
    },
    resolve: root => require("../../src/modules/siglus/runtime/rlvm-manager").executable(root)
  } };
