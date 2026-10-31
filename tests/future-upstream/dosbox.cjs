const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");
const repository = "dosbox-staging/dosbox-staging";
const releases = ["0.83.0", "0.82.2"].map(version => githubRelease(repository, `v${version}`, [`dosbox-staging-macOS-v${version}.dmg`]));
const scenarios = githubScenarios(repository, releases);
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["dosbox-staging"], current: githubRoutes(repository, releases), scenarios,
  layout: {
    write(root) {
      const executable = path.join(root, "DOSBox Staging.app", "Contents", "MacOS", "dosbox");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "");
      return path.join("DOSBox Staging.app", "Contents", "MacOS", "dosbox");
    },
    resolve: root => require("../../src/modules/dosbox/runtime/manager").executablePath(root)
  } };
