const fs = require("node:fs"), path = require("node:path");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

const repository = "PlayCover/PlayCover";
const releases = ["3.1.0", "3.0.0"].map(version => githubRelease(repository, `v${version}`, [`PlayCover_${version}.dmg`]));
const scenarios = githubScenarios(repository, releases);
scenarios.renamedAsset.usable = true;
module.exports = { managers: ["playcover"], current: githubRoutes(repository, releases), scenarios,
  layout: {
    write(root) {
      const framework = path.join(root, "PlayCover.app", "Contents", "Frameworks", "PlayTools.framework");
      fs.mkdirSync(framework, { recursive: true });
      fs.writeFileSync(path.join(framework, "PlayTools"), "library");
      return "PlayCover.app/Contents/Frameworks/PlayTools.framework";
    },
    resolve: root => path.join(require("../../src/modules/ios/runtime/manager").frameworksDirectory(root), "PlayTools.framework")
  } };
